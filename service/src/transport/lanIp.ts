import { networkInterfaces } from "node:os";

const PRIVATE_RANGES: RegExp[] = [
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[0-1])\./,
];

function isPrivateIPv4(address: string): boolean {
  return PRIVATE_RANGES.some((re) => re.test(address));
}

/**
 * Best-effort detection of this machine's LAN-facing IPv4 address. The Stremio
 * certificate API binds a cert to a specific IP, so this must be the address
 * LAN clients actually use to reach the service — not a container-internal IP.
 * Override with LAN_IP when auto-detection picks the wrong interface (e.g.
 * multiple NICs, VPN adapters).
 */
export function detectLanIPv4(): string | null {
  const override = process.env.LAN_IP;
  if (override) return override;

  const interfaces = networkInterfaces();
  const candidates: string[] = [];

  for (const entries of Object.values(interfaces)) {
    if (!entries) continue;
    for (const entry of entries) {
      if (entry.family === "IPv4" && !entry.internal) {
        candidates.push(entry.address);
      }
    }
  }

  const privateFirst = candidates.find(isPrivateIPv4);
  return privateFirst ?? candidates[0] ?? null;
}
