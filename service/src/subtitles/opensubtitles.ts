const DEFAULT_BASE_URL = "https://api.opensubtitles.com/api/v1";
const USER_AGENT = "stremio-offline v0.1.0";

export type SubtitleSearchOutcome =
  | { status: "found"; fileId: number; releaseName: string }
  | { status: "not-found" }
  | { status: "error"; message: string; retryable: boolean };

export type SubtitleDownloadOutcome =
  | { status: "ok"; content: string }
  | { status: "error"; message: string; retryable: boolean };

interface SearchResponseFile {
  file_id: number;
  file_name?: string;
}

interface SearchResponseItem {
  attributes: {
    release?: string;
    download_count?: number;
    files: SearchResponseFile[];
  };
}

interface SearchResponse {
  data: SearchResponseItem[];
}

interface DownloadResponse {
  link: string;
  remaining?: number;
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status < 600);
}

/**
 * OpenSubtitles REST API (api.opensubtitles.com/api/v1) — CLAUDE.md §5:
 * "OpenSubtitles API (user-supplied key)". Contract reconstructed from
 * OpenSubtitles' public API docs; **not verified against a live account**
 * — see PROGRESS.md's P7 notes. `imdbId` is the numeric id without the
 * leading "tt" (OpenSubtitles' documented convention), `baseUrl` is
 * injectable so tests (and, at boot, an env var) can point this at a local
 * fake server instead of the real API.
 */
export async function searchSubtitle(
  apiKey: string,
  imdbId: string,
  lang: string,
  baseUrl: string = DEFAULT_BASE_URL,
  fetchImpl: typeof fetch = fetch,
): Promise<SubtitleSearchOutcome> {
  const url = `${baseUrl}/subtitles?imdb_id=${encodeURIComponent(imdbId)}&languages=${encodeURIComponent(lang)}`;
  const res = await fetchImpl(url, { headers: { "Api-Key": apiKey, "User-Agent": USER_AGENT } });
  if (!res.ok) return { status: "error", message: `HTTP ${res.status}`, retryable: isRetryableStatus(res.status) };

  const body = (await res.json()) as SearchResponse;
  const best = [...body.data]
    .filter((item) => item.attributes.files.length > 0)
    .sort((a, b) => (b.attributes.download_count ?? 0) - (a.attributes.download_count ?? 0))[0];
  if (!best) return { status: "not-found" };

  const file = best.attributes.files[0]!;
  return { status: "found", fileId: file.file_id, releaseName: best.attributes.release ?? file.file_name ?? "unknown" };
}

export async function downloadSubtitle(
  apiKey: string,
  fileId: number,
  baseUrl: string = DEFAULT_BASE_URL,
  fetchImpl: typeof fetch = fetch,
): Promise<SubtitleDownloadOutcome> {
  const requestRes = await fetchImpl(`${baseUrl}/download`, {
    method: "POST",
    headers: { "Api-Key": apiKey, "User-Agent": USER_AGENT, "Content-Type": "application/json" },
    body: JSON.stringify({ file_id: fileId }),
  });
  if (!requestRes.ok) {
    return { status: "error", message: `HTTP ${requestRes.status}`, retryable: isRetryableStatus(requestRes.status) };
  }
  const { link } = (await requestRes.json()) as DownloadResponse;

  const contentRes = await fetchImpl(link);
  if (!contentRes.ok) {
    return { status: "error", message: `HTTP ${contentRes.status} fetching subtitle content`, retryable: isRetryableStatus(contentRes.status) };
  }
  return { status: "ok", content: await contentRes.text() };
}
