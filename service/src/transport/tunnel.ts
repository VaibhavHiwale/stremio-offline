/**
 * Fallback transports from CLAUDE.md §3 Rule 2, tried after the Stremio
 * certificate API. Not implemented yet — this build targets the cert-API
 * path first (per user decision during P1 planning). Each function returns
 * null (never a fabricated result) so the cascade in certManager.ts falls
 * through cleanly, or throws loudly at the end if nothing worked.
 */

export interface TunnelResult {
  method: "tailscale-funnel" | "cloudflare-tunnel";
  publicUrl: string;
}

export async function tryTailscaleFunnel(): Promise<TunnelResult | null> {
  // TODO: shell out to `tailscale funnel status --json` (or the Tailscale
  // local API) to discover an active Funnel hostname. Requires the host to
  // already have `tailscaled` running and Funnel enabled for this node.
  return null;
}

export async function tryCloudflareTunnel(): Promise<TunnelResult | null> {
  // TODO: read a configured `cloudflared` tunnel hostname (e.g. from
  // CLOUDFLARE_TUNNEL_HOSTNAME) and verify the tunnel is up.
  return null;
}
