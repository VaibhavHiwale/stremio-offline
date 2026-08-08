import { join } from "node:path";
import { isCertificateUsable, loadCachedCertificate, saveCachedCertificate } from "./certCache.js";
import { fetchStremioRocksCertificate } from "./certificate.js";
import { detectLanIPv4 } from "./lanIp.js";
import { tryCloudflareTunnel, tryTailscaleFunnel } from "./tunnel.js";

export interface HttpsTransport {
  method: "stremio-rocks";
  domain: string;
  cert: string;
  key: string;
  notAfter: string;
}

export interface TunnelTransport {
  method: "tailscale-funnel" | "cloudflare-tunnel";
  publicUrl: string;
}

export type Transport = HttpsTransport | TunnelTransport;

export interface TransportAttempt {
  method: string;
  error: string;
}

export interface AcquireTransportResult {
  transport: Transport | null;
  /** Non-empty when transport is null — pass to an actionable log/health message, per Rule 2. */
  attempts: TransportAttempt[];
}

/**
 * Runs the HTTPS transport cascade from CLAUDE.md §3 Rule 2. When every
 * option fails, callers must fail loudly (log + reflect in /health and
 * /diagnostics) using `attempts` — never silently fall back to plain HTTP
 * for anything served to a client.
 */
export async function acquireHttpsTransport(storageRoot: string): Promise<AcquireTransportResult> {
  const attempts: TransportAttempt[] = [];

  const stremioRocks = await tryStremioRocksCertificate(storageRoot, attempts);
  if (stremioRocks) return { transport: stremioRocks, attempts };

  const tailscale = await tryTailscaleFunnel();
  if (tailscale) return { transport: tailscale, attempts };
  attempts.push({ method: "tailscale-funnel", error: "not configured" });

  const cloudflare = await tryCloudflareTunnel();
  if (cloudflare) return { transport: cloudflare, attempts };
  attempts.push({ method: "cloudflare-tunnel", error: "not configured" });

  return { transport: null, attempts };
}

async function tryStremioRocksCertificate(
  storageRoot: string,
  attempts: TransportAttempt[],
): Promise<HttpsTransport | null> {
  const ipAddress = detectLanIPv4();
  if (!ipAddress) {
    attempts.push({ method: "stremio-rocks", error: "could not detect a LAN IPv4 address (set LAN_IP)" });
    return null;
  }

  const cachePath = join(storageRoot, ".offline", "certificate.json");
  const cached = loadCachedCertificate(cachePath);
  if (cached && isCertificateUsable(cached, ipAddress)) {
    return { method: "stremio-rocks", domain: cached.domain, cert: cached.cert, key: cached.key, notAfter: cached.notAfter };
  }

  try {
    const fresh = await fetchStremioRocksCertificate(ipAddress);
    saveCachedCertificate(cachePath, { ...fresh, ipAddress });
    return { method: "stremio-rocks", domain: fresh.domain, cert: fresh.cert, key: fresh.key, notAfter: fresh.notAfter };
  } catch (err) {
    attempts.push({ method: "stremio-rocks", error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}
