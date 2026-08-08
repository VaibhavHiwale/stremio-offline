# Progress — read this first when resuming

This file tracks build-order status against `CLAUDE.md` §10. Update it whenever you
finish a phase, pause mid-phase, or learn something non-obvious that the next
session (or the next you) would otherwise have to rediscover. Keep it accurate over
keeping it tidy — a stale status here is worse than no file at all.

## Phase status

| Phase | Status | Notes |
|---|---|---|
| P0 Skeleton | ✅ done, pushed | commit `89fc5a0` |
| P1 Transport | ✅ done, pushed | commit `2969465` — cert-API path implemented; Tailscale/Cloudflare stubbed (not chosen) |
| P2 Addon surface | ✅ done, pushed | commit `c719db4` |
| P3 Download core | ✅ done, pushed | commit `1be957a` |
| P4 Remux pipeline | 🚧 **in progress, uncommitted** | see below |
| P5 Queue | not started | |
| P6 Resolvers | not started | |
| P7 Subtitles | not started | |
| P8 Storage | not started | |
| P9 Progress + dashboard | not started | |
| P10 Episode auto-download | not started | |
| P11 Resume playback | not started | |

Repo: https://github.com/VaibhavHiwale/stremio-offline (remote `origin`, branch `master`).
All P0–P3 work is pushed. **Nothing from P4 is committed yet** — it's all in the
working tree only.

## P4 — Remux pipeline: current state

### Done
- `service/src/media/probe.ts` — ffprobe wrapper (codecs, duration, pixel format)
- `service/src/media/decision.ts` — copy-remux vs full-transcode decision (binary,
  per spec: H.264/AAC → copy; anything else → transcode both streams)
- `service/src/media/remux.ts` — ffmpeg execution (copy or transcode args) — **has
  typecheck errors, see below**
- `service/src/media/verify.ts` — extended with `verifyRemuxOutput` (post-remux
  duration-within-1%, video+audio stream presence, non-zero size)
- `service/src/storage/libraryPath.ts` — Movies/Series library layout + filename
  sanitization
- `service/src/storage/paths.ts` — added `remuxTempPath`
- `service/src/queue/semaphore.ts` — generic counting semaphore
- `service/src/queue/remuxRunner.ts` — `processRemuxRow` (single-row, testable) +
  `startRemuxRunner` (background worker pool bounded by the semaphore,
  `min(2, cpus-1)` default concurrency)
- `service/src/db/downloadItems.ts` — added `markReady`; extended `QueueRow` /
  `ROW_COLUMNS` with `type, title, year, season, episode` (needed for library path
  computation)
- Dependencies installed and verified working: `ffmpeg-static` (83MB binary,
  downloads fine), `@ffprobe-installer/ffprobe` (platform-specific binary — see
  gotcha below). Both resolve and run correctly on this machine; ffmpeg has
  `libx264`, `aac`, `libx265`/`hevc` encoders available (confirmed via `-encoders`,
  useful for generating synthetic HEVC test fixtures without needing real media).

### Broken right now — fix this first
`service/src/media/remux.ts` fails typecheck (`npm run typecheck --workspace
service`) with two distinct root causes at lines 58/61/66/67:

1. **`ffmpeg-static` import type**: `import ffmpegBinaryPath from "ffmpeg-static"`
   resolves to `string | typeof import(".../ffmpeg-static/types/index")` instead of
   the declared `string | null` (the package's own `.d.ts` says `declare const
   ffmpegPath: string | null`). This looks like a NodeNext/CJS-interop quirk, not a
   real type. **Fix**: cast at the import site, e.g.
   `const ffmpegBinaryPath = ffmpegBinaryPathRaw as string | null;` right after the
   import.
2. **`spawn()` overload collapse**: `const spawnOpts: Parameters<typeof spawn>[2]
   = {}` makes TS lose the correct overload and infers the return type of
   `spawn(bin, args, spawnOpts)` as `never`, cascading into "Property 'stderr' does
   not exist on type 'never'" etc. **Fix**: type `spawnOpts` explicitly as
   `SpawnOptions` imported from `node:child_process` instead of the `Parameters<...>`
   trick.

Neither is a logic bug — just needs the typing fixed, then re-run `npm run
typecheck --workspace service` to confirm clean, then `npm run build`.

### Not started yet
1. Wire `startRemuxRunner` into `service/src/index.ts` (alongside the existing
   download `startQueueRunner`), with matching graceful-shutdown handling
   (`stop()` on SIGTERM/SIGINT, same pattern as the download runner).
2. Fix `service/src/api/health.ts`'s `checkFfmpeg` — it currently does
   `spawnSync("ffmpeg", ["-version"])`, assuming a system PATH binary. Now that
   `ffmpeg-static`/`@ffprobe-installer/ffprobe` are bundled, point it at the
   resolved binary paths instead (matches CLAUDE.md §5: "never assume a system
   ffmpeg exists").
3. Extend the addon per Rule 1's second half: "Return the MP4 stream first;
   optionally offer the original as a second entry labelled 'Original quality
   (needs streaming server)' for desktop/Android users."
   - `addon/src/handlers/stream.ts`: for `status === "ready"` rows, add a second
     stream entry pointing at the original file, with `behaviorHints.notWebReady:
     true` (the original isn't guaranteed to be MP4/H.264).
   - `service/src/api/files.ts`: currently only serves `file_path_web_ready`.
     Needs a way to also serve `file_path_original` — e.g. a route/query
     variant — plus a second signed-URL builder in `app.ts`'s `buildFileUrl`
     wiring for the addon.
4. Tests: no P4 tests exist yet. Plan (validated as feasible — ffmpeg can generate
   synthetic test video+audio with `-f lavfi` sources, no real media files needed):
   - `media/decision.test.ts` — pure logic, no ffmpeg needed (feed it fake
     `ProbeResult` objects).
   - `media/probe.test.ts` / `media/remux.test.ts` / integration test in
     `queue/remuxRunner.test.ts` — generate a small H.264/AAC MP4 (copy-remux path)
     and a small HEVC/AC3 MKV (transcode path) via `ffmpeg -f lavfi -i testsrc -f
     lavfi -i sine ...`, run them through `processRemuxRow`, assert: correct plan
     chosen, output lands in the library path (not `.offline/remux/`), ffprobe on
     the output confirms `h264`/`aac`, row status becomes `ready` with
     `file_path_web_ready` set, `.offline/remux/<id>.remux.mp4` staging file is
     gone (renamed, not copied).
   - Verify a corrupted/truncated input causes `verifyRemuxOutput` to fail cleanly
     (row → `failed`, no partial file left in the library path).
5. End-to-end local verification (same pattern as P1–P3): boot the real service,
   feed a real download through P3 into `remuxing`, confirm P4 picks it up and the
   final file plays back (byte-level ffprobe check, not just "no error").
6. Commit + push P4, following the same commit-message style as P1–P3 (what was
   built, what was verified, what's still unverified/deferred and why).

## Environment / gotchas learned so far (don't rediscover these)

- **Git identity for this repo**: `VaibhavHiwale <vaibhavhiwale@outlook.com>`,
  configured locally (not global). **Never add a Claude co-author line** —
  user explicitly asked for sole authorship; already had to amend+force-push P0 once
  to strip one.
- **Deployment target**: separate always-on machine (NAS/Pi/server), confirmed by
  user before P0. Not co-located with Stremio. Affects Wi-Fi-only detection and
  storage-target discovery (server's own interfaces/volumes, not a phone's).
- **Cert strategy chosen**: Stremio's own `certificateGet` API first (user's
  explicit choice during P1 planning). Tailscale Funnel / Cloudflare Tunnel are
  stubbed (`service/src/transport/tunnel.ts`) but not implemented.
- **This dev machine is Windows; the deployment target is Docker/Linux.**
  Concretely bit us twice:
  - `fs.statfs` (disk free space) doesn't work on Windows — code already handles
    this gracefully (`degraded`/`null`, non-fatal), just don't be surprised locally.
  - Windows doesn't deliver real POSIX `SIGTERM` — `Stop-Process` in PowerShell is
    closer to `kill -9`. Graceful-shutdown timing is **unverified** as of P3 and
    will stay that way until tested on the real Linux target.
- **npm install flakiness on this machine**: large package downloads sometimes fail
  with `ERR_SSL_CIPHER_OPERATION_FAILED` — this turned out to be real (not just
  flakiness) for `ffprobe-static`, whose tarball bundles *every* platform's binary
  in one 351MB download. Switched to `@ffprobe-installer/ffprobe`, which only
  fetches the current platform's binary via `optionalDependencies` (~81MB on
  win32-x64). **Don't add a platform-specific installer package (e.g.
  `@ffprobe-installer/win32-x64`) as a direct dependency** — `npm install
  <pkg>@version` will do this automatically if you install a platform package
  directly; it must stay an optional dep of `@ffprobe-installer/ffprobe` or the
  Linux Docker build breaks. (Already happened once and was reverted.)
- **Fastify async-handler gotcha**: `reply.send(stream)` inside an `async` handler
  MUST be `return`ed, or the handler's own resolved promise races the in-flight
  stream and truncates the response to `Content-Length: 0`. Bit us in
  `service/src/api/files.ts` during P1.
- **Node stream gotcha**: use `pipeline()` from `node:stream/promises`, not
  `.pipe()` + `finished()` — `.pipe()` doesn't cascade a source-side `destroy()` to
  the destination, so an intentional abort (e.g. the disk-space guard) becomes an
  unhandled `'error'` event instead of a clean rejection. Bit us in
  `service/src/downloaders/http.ts` during P3; also caused a mysterious hang-after-
  tests-complete via leaked handles.
- **Test-server gotcha (Node `http` + `fetch`/undici)**: `fetch()` keeps HTTP/1.1
  connections alive for reuse, so `server.close(cb)` alone hangs forever waiting for
  a socket neither side closes first. Always call `server.closeAllConnections()`
  before `server.close()`. Also: **always wrap test bodies in `try/finally` around
  `close()`** — an assertion throwing before `close()` leaks a listening server,
  which is what caused a full test-suite hang during P3 (looked like a product bug,
  wasn't).
- **`tsc` composite-project gotcha**: deleting `dist/` without also deleting
  `tsconfig.tsbuildinfo` makes `tsc -p` silently skip re-emitting (it trusts the
  stale incremental cache over the actual filesystem). `*.tsbuildinfo` is
  gitignored; if a rebuild produces an empty `dist/`, delete `**/*.tsbuildinfo`
  first.
- **Build order matters for workspaces**: root `npm run build` explicitly runs
  `shared` → `addon` → `service` in sequence (not `--workspaces`, which doesn't
  guarantee dependency order). If you add a new workspace package, update both the
  root `package.json` build script and the consuming package's `tsconfig.json`
  `references`.

## Useful commands

```bash
# from repo root
npm run build                                    # shared -> addon -> service, in order
npm run typecheck                                 # all workspaces
npm run typecheck --workspace service             # just service

# from service/ (or addon/) — run that package's tests
npx tsx --test --test-reporter=spec --test-timeout=15000 src/**/*.test.ts

# local boot (skip real cert acquisition; fake PUBLIC_BASE_URL for testing signed URLs)
STORAGE_ROOT=<dir> DB_PATH=<dir>/.offline/db.sqlite SKIP_CERT_ACQUISITION=1 \
  HTTP_PORT=11470 PUBLIC_BASE_URL=https://fake.example:12470 node service/dist/index.js
```
