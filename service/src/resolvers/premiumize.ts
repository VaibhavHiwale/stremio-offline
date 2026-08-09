import type { DebridResolver, ResolveOutcome } from "./types.js";
import { errorOutcome } from "./types.js";

const BASE = "https://www.premiumize.me/api";

interface DirectDlResponse {
  status: "success" | "error";
  message?: string;
  content?: { path: string; link: string; size: number }[];
}

interface TransferCreateResponse {
  status: "success" | "error";
  message?: string;
  id?: string;
}

interface TransferListResponse {
  status: "success" | "error";
  transfers?: { id: string; status: string; src: string; message?: string }[];
}

/**
 * Premiumize (premiumize.me/api) — CLAUDE.md §3 Rule 7. Contract
 * reconstructed from Premiumize's public API docs; **not verified against a
 * live account** — see PROGRESS.md's P6 notes. Tries `transfer/directdl`
 * first: a pure, side-effect-free lookup that returns instantly if the
 * torrent's content is already cached (Premiumize's fast path for popular
 * content). Only falls back to `transfer/create` (which starts an
 * asynchronous caching job) when directdl reports the content isn't cached
 * yet — avoids creating a transfer on every call when the fast path would
 * have worked.
 */
export const premiumizeResolver: DebridResolver = {
  service: "premiumize",

  async resolveMagnet(apiKey, magnetUri, fetchImpl = fetch): Promise<ResolveOutcome> {
    const directDlRes = await fetchImpl(`${BASE}/transfer/directdl?apikey=${encodeURIComponent(apiKey)}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ src: magnetUri }),
    });
    if (!directDlRes.ok) return { status: "error", message: `HTTP ${directDlRes.status}`, retryable: directDlRes.status >= 500 };
    const directDl = (await directDlRes.json()) as DirectDlResponse;

    if (directDl.status === "success" && directDl.content && directDl.content.length > 0) {
      const largest = [...directDl.content].sort((a, b) => b.size - a.size)[0]!;
      return { status: "ready", directUrl: largest.link };
    }

    // Not instantly cached — fall back to the async transfer flow. A single
    // create + list check here; "pending" lets the caller's normal
    // retry/backoff handle checking again later rather than blocking this
    // call on a long poll loop.
    const createRes = await fetchImpl(`${BASE}/transfer/create?apikey=${encodeURIComponent(apiKey)}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ src: magnetUri }),
    });
    if (!createRes.ok) return { status: "error", message: `HTTP ${createRes.status}`, retryable: createRes.status >= 500 };
    const created = (await createRes.json()) as TransferCreateResponse;
    if (created.status === "error") return errorOutcome(created.message ?? "Premiumize transfer/create failed");

    const listRes = await fetchImpl(`${BASE}/transfer/list?apikey=${encodeURIComponent(apiKey)}`);
    if (!listRes.ok) return { status: "error", message: `HTTP ${listRes.status}`, retryable: listRes.status >= 500 };
    const list = (await listRes.json()) as TransferListResponse;
    const transfer = list.transfers?.find((t) => t.id === created.id);

    if (transfer?.status === "error") {
      return { status: "error", message: transfer.message ?? "Premiumize transfer failed", retryable: false };
    }
    return { status: "pending", message: `Premiumize is still caching this torrent (status: ${transfer?.status ?? "unknown"})` };
  },
};
