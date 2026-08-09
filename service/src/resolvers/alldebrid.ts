import type { DebridResolver, ResolveOutcome } from "./types.js";
import { errorOutcome } from "./types.js";

const BASE = "https://api.alldebrid.com/v4";
const AGENT = "stremio-offline";

interface ApiEnvelope<T> {
  status: "success" | "error";
  data?: T;
  error?: { code: string; message: string };
}

interface UploadData {
  magnets: { id: number; hash: string; ready?: boolean }[];
}

interface StatusData {
  magnets: { status: string; statusCode: number; links: { link: string }[] };
}

interface UnlockData {
  link: string;
}

async function call<T>(url: string, doFetch: typeof fetch): Promise<ApiEnvelope<T> | { httpError: string }> {
  const res = await doFetch(url);
  if (!res.ok) return { httpError: `HTTP ${res.status}` };
  return (await res.json()) as ApiEnvelope<T>;
}

// AllDebrid's error codes are documented as auth/permission (terminal) or
// transient service issues (retryable) — MAGNET_MUST_BE_PREMIUM and similar
// account-state errors are terminal; anything else defaults non-retryable
// per the shared "unrecognized = terminal" rule (see resolvers/types.ts).
function isRetryableAllDebridCode(code: string): boolean {
  return code === "SERVICE_UNAVAILABLE" || code === "RATE_LIMITED";
}

/**
 * AllDebrid (api.alldebrid.com/v4) — CLAUDE.md §3 Rule 7. Contract
 * reconstructed from AllDebrid's public API docs; **not verified against a
 * live account** — see PROGRESS.md's P6 notes. Flow: magnet/upload →
 * magnet/status (for the cached torrent's AllDebrid-hosted links) →
 * link/unlock for the direct HTTPS URL. Auth is a query-string `apikey`,
 * matching AllDebrid's documented v4 scheme (not a Bearer header).
 */
export const allDebridResolver: DebridResolver = {
  service: "alldebrid",

  async resolveMagnet(apiKey, magnetUri, fetchImpl = fetch): Promise<ResolveOutcome> {
    const uploadUrl = `${BASE}/magnet/upload?agent=${AGENT}&apikey=${encodeURIComponent(apiKey)}&magnets[]=${encodeURIComponent(magnetUri)}`;
    const uploaded = await call<UploadData>(uploadUrl, fetchImpl);
    if ("httpError" in uploaded) return { status: "error", message: uploaded.httpError, retryable: true };
    if (uploaded.status === "error") {
      return errorOutcome(uploaded.error?.message ?? "AllDebrid upload failed", isRetryableAllDebridCode(uploaded.error?.code ?? ""));
    }
    const magnetId = uploaded.data?.magnets[0]?.id;
    if (magnetId === undefined) return errorOutcome("AllDebrid did not return a magnet id");

    const statusUrl = `${BASE}/magnet/status?agent=${AGENT}&apikey=${encodeURIComponent(apiKey)}&id=${magnetId}`;
    const statusRes = await call<StatusData>(statusUrl, fetchImpl);
    if ("httpError" in statusRes) return { status: "error", message: statusRes.httpError, retryable: true };
    if (statusRes.status === "error") {
      return errorOutcome(statusRes.error?.message ?? "AllDebrid status check failed", isRetryableAllDebridCode(statusRes.error?.code ?? ""));
    }
    const magnet = statusRes.data?.magnets;
    if (!magnet || magnet.links.length === 0) {
      return { status: "pending", message: `AllDebrid is still caching this magnet (status: ${magnet?.status ?? "unknown"})` };
    }

    const unlockUrl = `${BASE}/link/unlock?agent=${AGENT}&apikey=${encodeURIComponent(apiKey)}&link=${encodeURIComponent(magnet.links[0]!.link)}`;
    const unlocked = await call<UnlockData>(unlockUrl, fetchImpl);
    if ("httpError" in unlocked) return { status: "error", message: unlocked.httpError, retryable: true };
    if (unlocked.status === "error" || !unlocked.data) {
      return errorOutcome(unlocked.error?.message ?? "AllDebrid link unlock failed", isRetryableAllDebridCode(unlocked.error?.code ?? ""));
    }
    return { status: "ready", directUrl: unlocked.data.link };
  },
};
