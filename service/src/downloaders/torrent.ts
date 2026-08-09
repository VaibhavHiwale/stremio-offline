import { promises as fsp } from "node:fs";
import { dirname, join } from "node:path";
import WebTorrentCtor from "webtorrent";
import { hasSufficientSpace } from "../storage/diskspace.js";
import type { DownloadOutcome } from "./http.js";

// Minimal structural subset of webtorrent's Instance/Torrent/TorrentFile —
// just enough to drive a download. Kept narrow (rather than importing the
// real @types/webtorrent shapes here) so tests can supply a fake client
// without pulling in real network/DHT/tracker machinery.
export interface TorrentFileLike {
  readonly name: string;
  readonly path: string;
  readonly length: number;
  readonly downloaded: number;
  select(): void;
  deselect(): void;
}

export interface TorrentLike {
  readonly files: TorrentFileLike[];
  readonly path: string;
  on(event: "download", cb: (bytes: number) => void): unknown;
  on(event: "done", cb: () => void): unknown;
  on(event: "error", cb: (err: Error | string) => void): unknown;
  destroy(opts?: { destroyStore?: boolean }, cb?: (err?: Error | string) => void): void;
}

export interface WebTorrentClientLike {
  add(magnetUri: string, opts: { path: string }, cb: (torrent: TorrentLike) => void): void;
  on(event: "error", cb: (err: Error | string) => void): unknown;
  destroy(cb?: (err?: Error) => void): void;
}

export interface TorrentDownloadDeps {
  /** Injectable for tests; defaults to a real webtorrent client. */
  client?: WebTorrentClientLike;
  onProgress?: (bytesDownloaded: number, bytesTotal: number | null) => void;
  checkDiskSpace?: (destPath: string, neededBytes: number) => Promise<boolean>;
  signal?: AbortSignal;
}

function defaultClient(): WebTorrentClientLike {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-call, new-cap
  return new (WebTorrentCtor as unknown as new () => WebTorrentClientLike)();
}

/**
 * webtorrent fallback downloader — CLAUDE.md §3 Rule 7: "webtorrent stays
 * as fallback for users without a debrid account — never the primary
 * path." Downloads the largest file in the torrent (the presumed main
 * video) and deselects everything else so bandwidth isn't wasted on
 * samples/NFOs/subtitles bundled in the same release. "Resumability" per
 * CLAUDE.md §4 is left to webtorrent itself ("handles pause/resume
 * natively") — this wrapper doesn't reimplement HTTP-style byte-range
 * resume logic on top of it.
 *
 * **Unverified**: no real magnet/peer/tracker exercise was possible in this
 * environment (no live swarm to test against) — see PROGRESS.md's P6
 * notes. The test suite drives a fake client satisfying
 * `WebTorrentClientLike` instead.
 */
export async function downloadMagnetToPart(
  magnetUri: string,
  destPath: string,
  deps: TorrentDownloadDeps = {},
): Promise<DownloadOutcome> {
  const ownsClient = !deps.client;
  const client = deps.client ?? defaultClient();
  const checkDiskSpace = deps.checkDiskSpace ?? hasSufficientSpace;
  const stagingDir = join(dirname(destPath), `.torrent-staging-${Date.now()}`);
  await fsp.mkdir(stagingDir, { recursive: true });

  return new Promise<DownloadOutcome>((resolve) => {
    let settled = false;
    let torrentRef: TorrentLike | undefined;

    const cleanupClient = (): void => {
      if (ownsClient) client.destroy();
    };

    const finish = (outcome: DownloadOutcome): void => {
      if (settled) return;
      settled = true;
      deps.signal?.removeEventListener("abort", onAbort);
      resolve(outcome);
    };

    const onAbort = (): void => {
      torrentRef?.destroy({ destroyStore: true });
      cleanupClient();
      finish({ kind: "paused-network", message: "shutdown requested" });
    };
    deps.signal?.addEventListener("abort", onAbort);

    client.on("error", (err) => {
      cleanupClient();
      finish({ kind: "terminal-error", message: err instanceof Error ? err.message : String(err) });
    });

    client.add(magnetUri, { path: stagingDir }, (torrent) => {
      torrentRef = torrent;

      if (torrent.files.length === 0) {
        torrent.destroy({ destroyStore: true });
        cleanupClient();
        finish({ kind: "terminal-error", message: "torrent has no files" });
        return;
      }

      const target = [...torrent.files].sort((a, b) => b.length - a.length)[0]!;
      for (const file of torrent.files) {
        if (file === target) file.select();
        else file.deselect();
      }

      void checkDiskSpace(destPath, target.length).then((ok) => {
        if (!ok) {
          torrent.destroy({ destroyStore: true });
          cleanupClient();
          finish({ kind: "paused-disk-full" });
        }
      });

      torrent.on("download", () => {
        deps.onProgress?.(target.downloaded, target.length);
      });

      torrent.on("error", (err) => {
        cleanupClient();
        finish({ kind: "terminal-error", message: err instanceof Error ? err.message : String(err) });
      });

      torrent.on("done", () => {
        (async () => {
          const sourcePath = join(torrent.path, target.path);
          await fsp.mkdir(dirname(destPath), { recursive: true });
          await fsp.rename(sourcePath, destPath); // atomic within a filesystem — CLAUDE.md §4
          await fsp.rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
          torrent.destroy();
          cleanupClient();
          finish({ kind: "complete", bytesTotal: target.length, etag: null });
        })().catch((err: unknown) => {
          finish({ kind: "terminal-error", message: err instanceof Error ? err.message : String(err) });
        });
      });
    });
  });
}
