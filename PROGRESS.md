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
| P4 Remux pipeline | ✅ done, **not yet pushed** | commit `48d499f` — see below |
| P5 Queue | not started | |
| P6 Resolvers | not started | |
| P7 Subtitles | not started | |
| P8 Storage | not started | |
| P9 Progress + dashboard | not started | |
| P10 Episode auto-download | not started | |
| P11 Resume playback | not started | |

Repo: https://github.com/VaibhavHiwale/stremio-offline (remote `origin`, branch `master`).
P0–P4 work is committed locally (P4 landed via a squash-merge from
`wip/p4-remux-pipeline`, which was a temporary parking branch while it didn't
typecheck — that branch can be deleted now). **Confirm what's actually pushed
with `git log origin/master..master` before assuming parity with GitHub.**

## P4 — Remux pipeline: done

### Built
- `service/src/media/probe.ts` — ffprobe wrapper (codecs, duration, pixel format)
- `service/src/media/decision.ts` — copy-remux vs full-transcode decision (binary,
  per spec: H.264/AAC → copy; anything else → transcode both streams)
- `service/src/media/remux.ts` — ffmpeg execution (copy or transcode args)
- `service/src/media/verify.ts` — extended with `verifyRemuxOutput` (post-remux
  duration-within-1%, video+audio stream presence, non-zero size)
- `service/src/storage/libraryPath.ts` — Movies/Series library layout + filename
  sanitization
- `service/src/storage/paths.ts` — added `remuxTempPath`
- `service/src/queue/semaphore.ts` — generic counting semaphore
- `service/src/queue/remuxRunner.ts` — `processRemuxRow` (single-row, testable) +
  `startRemuxRunner` (background worker pool bounded by the semaphore,
  `min(2, cpus-1)` default concurrency), wired into `service/src/index.ts`
  alongside the download `startQueueRunner`, with the same `stop()` on
  SIGTERM/SIGINT graceful-shutdown pattern.
- `service/src/db/downloadItems.ts` — added `markReady`; extended `QueueRow` /
  `ROW_COLUMNS` with `type, title, year, season, episode`.
- `service/src/api/health.ts`'s `checkFfmpeg` now spawns the bundled
  `ffmpeg-static` / `@ffprobe-installer/ffprobe` binaries directly instead of
  assuming a system PATH `ffmpeg` (CLAUDE.md §5).
- Rule 1's "second entry" — ready rows now return **two** stream entries:
  the web-ready MP4 (`▶️ Play offline · <quality>`) and, when a
  `file_path_original` exists, `Original quality (needs streaming server)`
  with `behaviorHints.notWebReady: true`. Plumbing: `addon/src/repository.ts`
  exposes `filePathOriginal`; `addon/src/handlers/stream.ts` builds both
  entries; `service/src/api/files.ts` gained a `?variant=original` query
  param (same signed token covers either variant — both files belong to the
  one authorized download item) with the correct content-type
  (`application/octet-stream`, not `video/mp4`, since the original container
  isn't guaranteed to be MP4); `service/src/app.ts` wires a second
  `buildOriginalFileUrl`.
- Dependencies: `ffmpeg-static`, `@ffprobe-installer/ffprobe` — both resolve
  and run correctly on this (Windows) machine; ffmpeg has `libx264`, `aac`,
  `libx265`/`hevc` encoders available, used to generate synthetic test
  fixtures via `-f lavfi` (no real media files needed anywhere in the suite).

### Tests
- `service/src/testutils/mediaFixtures.ts` — shared helper generating a
  synthetic H.264/AAC MP4 and an HEVC/AC3 MKV via ffmpeg lavfi sources.
- `media/decision.test.ts` — pure logic against fake `ProbeResult` objects
  (copy vs. transcode for every branch: HEVC, 10-bit, non-AAC audio, missing
  streams).
- `media/probe.test.ts` — probes both synthetic fixtures, asserts real
  codec/duration detection (not extension-guessing).
- `media/remux.test.ts` — runs `runFfmpeg` for both plans end-to-end plus a
  nonexistent-input failure case.
- `queue/remuxRunner.test.ts` — integration test via `processRemuxRow`:
  copy-remux path lands in the library (not the `.offline/remux/` staging
  dir, which is gone after the atomic rename), transcode path converts
  HEVC/AC3 → H.264/AAC, a corrupted/truncated input fails cleanly (row →
  `failed`, nothing written to the library path), and a row missing
  `file_path_original` fails immediately without touching ffmpeg.
  **Gotcha**: the transcode fixture needs ≥5s duration — at 1s, normal
  encoder frame-boundary rounding alone can exceed the 1% duration-drift
  tolerance in `verifyRemuxOutput` and fail the test for a reason that has
  nothing to do with the code under test.
- All 53 service tests + 5 addon tests pass (`npm run typecheck` and
  `npm run build` clean across all three workspaces).

### End-to-end verification performed
Booted the real service (`SKIP_CERT_ACQUISITION=1`), served a real
synthetic HEVC/AC3 fixture over a local Range-capable HTTP server, inserted
a `queued` row directly (no REST enqueue endpoint exists yet — that's P5),
and confirmed: the row progressed `queued → downloading → remuxing →
ready`; the final file (ffprobe-verified `h264`/`aac`) landed at the
computed library path; `GET /stream/movie/:id.json` returned both stream
entries with the correct `behaviorHints`; `GET /files/:id` served the
web-ready variant as `video/mp4` and, with `&variant=original`, served the
raw pre-remux file byte-for-byte identical to what was downloaded. This is
the ffprobe-level proxy for "plays on device 3/4" from CLAUDE.md §9 — actual
device playback still needs the real acceptance matrix once this is
deployed off this dev machine.

### Deferred / not done in P4
- Real device playback testing (needs the acceptance matrix — separate
  always-on deployment target, not this Windows dev machine).
- Windows `SIGTERM` graceful-shutdown timing is still unverified (same
  caveat as P3 — `Stop-Process` in PowerShell isn't real POSIX `SIGTERM`).

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
