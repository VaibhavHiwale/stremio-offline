import { X509Certificate } from "node:crypto";

const CERTIFICATE_GET_URL = "https://api.strem.io/api/certificateGet";

export interface StremioRocksCertificate {
  /** Hostname the issued cert is actually valid for — read off the cert itself, never assumed. */
  domain: string;
  /** PEM-encoded certificate chain. */
  cert: string;
  /** PEM-encoded private key. */
  key: string;
  notBefore: string;
  notAfter: string;
}

interface CertificateGetResponse {
  error?: { message?: string };
  result?: { certificate?: string };
}

interface CertificateContents {
  contents?: { Certificate?: string; PrivateKey?: string };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoffMs(attempt: number): number {
  const base = Math.min(1000 * 2 ** attempt, 5 * 60_000);
  return base + Math.random() * base * 0.2; // jitter
}

/**
 * Requests a LAN-IP-bound HTTPS certificate from Stremio's certificate API.
 * Reference: certificate.js in tsaridas/stremio-docker. That script hardcodes
 * a *.stremio.rocks domain suffix in its log message which looks specific to
 * the original author's own issued cert rather than a fixed convention — we
 * don't trust it. Instead we read the real domain (CN/SAN) off the certificate
 * X.509 has just handed us, which is correct regardless of what the API's
 * naming scheme happens to be.
 */
export async function fetchStremioRocksCertificate(
  ipAddress: string,
  opts: { maxAttempts?: number; fetchImpl?: typeof fetch } = {},
): Promise<StremioRocksCertificate> {
  const maxAttempts = opts.maxAttempts ?? 5;
  const doFetch = opts.fetchImpl ?? fetch;

  let lastError: Error | undefined;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) await sleep(backoffMs(attempt - 1));

    try {
      const response = await doFetch(CERTIFICATE_GET_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ authKey: null, ipAddress }),
      });

      const data = (await response.json()) as CertificateGetResponse;

      if (!response.ok || data.error) {
        const message = data.error?.message ?? `HTTP ${response.status}`;
        // 4xx from a well-formed request is a terminal API-level rejection (e.g. bad IP);
        // 5xx/network errors are retried by the loop.
        if (response.status >= 400 && response.status < 500) {
          throw new Error(`certificateGet rejected: ${message}`);
        }
        lastError = new Error(`certificateGet failed: ${message}`);
        continue;
      }

      if (!data.result?.certificate) {
        throw new Error("certificateGet response missing result.certificate");
      }

      const contents: CertificateContents = JSON.parse(data.result.certificate);
      const certB64 = contents.contents?.Certificate;
      const keyB64 = contents.contents?.PrivateKey;
      if (!certB64 || !keyB64) {
        throw new Error("certificateGet response missing Certificate/PrivateKey");
      }

      const cert = Buffer.from(certB64, "base64").toString("utf8");
      const key = Buffer.from(keyB64, "base64").toString("utf8");

      const x509 = new X509Certificate(cert);
      const domain = extractDomain(x509);

      return {
        domain,
        cert,
        key,
        notBefore: new Date(x509.validFrom).toISOString(),
        notAfter: new Date(x509.validTo).toISOString(),
      };
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
    }
  }

  throw new Error(
    `Failed to obtain a stremio.rocks certificate for ${ipAddress} after ${maxAttempts} attempts: ${lastError?.message}`,
  );
}

function extractDomain(cert: X509Certificate): string {
  // Prefer the first DNS name from the SAN extension; fall back to the CN.
  const san = cert.subjectAltName; // e.g. "DNS:foo.stremio.rocks, DNS:*.foo.stremio.rocks"
  if (san) {
    const dnsName = san
      .split(",")
      .map((s) => s.trim())
      .find((s) => s.startsWith("DNS:") && !s.includes("*"));
    if (dnsName) return dnsName.slice("DNS:".length);
  }

  const cn = cert.subject
    .split("\n")
    .map((s) => s.trim())
    .find((s) => s.startsWith("CN="));
  if (cn) return cn.slice("CN=".length);

  throw new Error("Could not determine domain from issued certificate (no SAN or CN)");
}
