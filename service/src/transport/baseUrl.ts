const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

function isLoopbackHost(host: string): boolean {
  const hostname = host.split(":")[0] ?? host;
  return LOOPBACK_HOSTS.has(hostname);
}

function stripTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

export interface BaseUrlRequestLike {
  headers: { host?: string | undefined; "x-forwarded-proto"?: string | undefined };
  protocol: string;
}

/**
 * Resolves the externally-reachable base URL for building manifest/catalog/
 * meta/stream/file URLs — see CLAUDE.md §3 Rule 3. An explicit configured
 * base URL always wins; otherwise it's derived from the request's Host
 * header. Throws rather than silently returning a loopback address — a
 * caller that can't get a real base URL must surface that, not paper over it.
 */
export function resolveBaseUrl(req: BaseUrlRequestLike, configuredBaseUrl: string | null): string {
  if (configuredBaseUrl) return stripTrailingSlash(configuredBaseUrl);

  const host = req.headers.host;
  if (!host || isLoopbackHost(host)) {
    throw new Error(
      "Cannot resolve a non-loopback public base URL from this request. Set PUBLIC_BASE_URL, " +
        "or complete certificate/tunnel setup — see CLAUDE.md §3 Rule 2.",
    );
  }

  const proto = req.headers["x-forwarded-proto"] ?? req.protocol;
  return `${proto}://${host}`;
}
