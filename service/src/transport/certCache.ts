import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { StremioRocksCertificate } from "./certificate.js";

interface CachedCertificate extends StremioRocksCertificate {
  ipAddress: string;
}

export function loadCachedCertificate(cachePath: string): CachedCertificate | null {
  try {
    return JSON.parse(readFileSync(cachePath, "utf8")) as CachedCertificate;
  } catch {
    return null;
  }
}

export function saveCachedCertificate(cachePath: string, cert: CachedCertificate): void {
  mkdirSync(dirname(cachePath), { recursive: true });
  writeFileSync(cachePath, JSON.stringify(cert, null, 2), { mode: 0o600 });
}

const EXPIRY_SAFETY_MARGIN_MS = 24 * 60 * 60 * 1000; // renew a day early

export function isCertificateUsable(cert: CachedCertificate, forIpAddress: string): boolean {
  if (cert.ipAddress !== forIpAddress) return false;
  const expiresAt = Date.parse(cert.notAfter);
  if (Number.isNaN(expiresAt)) return false;
  return expiresAt - Date.now() > EXPIRY_SAFETY_MARGIN_MS;
}
