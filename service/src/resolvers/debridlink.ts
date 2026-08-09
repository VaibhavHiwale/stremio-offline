import type { DebridResolver, ResolveOutcome } from "./types.js";
import { errorOutcome } from "./types.js";

const BASE = "https://debrid-link.com/api/v2";

interface SeedboxFile {
  name: string;
  size: number;
  downloadUrl: string;
}

interface SeedboxAddResponse {
  success: boolean;
  error?: string;
  value?: {
    id: string;
    name: string;
    status: number; // DebridLink uses numeric status codes; downloaded/ready torrents expose `files`
    files?: SeedboxFile[];
  };
}

/**
 * DebridLink (debrid-link.com/api/v2) — CLAUDE.md §3 Rule 7. Contract
 * reconstructed from DebridLink's public API docs; **not verified against a
 * live account, and DebridLink's documentation is thinner than the other
 * four services** — treat the field names here as a starting point to
 * correct against a real account/response before production use (see
 * PROGRESS.md's P6 notes). Flow: seedbox/add with `async: true` — DebridLink
 * resolves near-instantly for already-cached content (returning `files`
 * directly) and otherwise leaves the torrent processing in the background.
 */
export const debridLinkResolver: DebridResolver = {
  service: "debridlink",

  async resolveMagnet(apiKey, magnetUri, fetchImpl = fetch): Promise<ResolveOutcome> {
    const res = await fetchImpl(`${BASE}/seedbox/add`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ url: magnetUri, async: true }),
    });
    if (!res.ok) return { status: "error", message: `HTTP ${res.status}`, retryable: res.status === 429 || res.status >= 500 };

    const body = (await res.json()) as SeedboxAddResponse;
    if (!body.success || !body.value) return errorOutcome(body.error ?? "DebridLink seedbox/add failed");

    const files = body.value.files;
    if (!files || files.length === 0) {
      return { status: "pending", message: "DebridLink is still caching this torrent" };
    }

    const largest = [...files].sort((a, b) => b.size - a.size)[0]!;
    return { status: "ready", directUrl: largest.downloadUrl };
  },
};
