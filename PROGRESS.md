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
| P4 Remux pipeline | ✅ done, pushed | commit `48d499f` |
| P5 Queue | ✅ done, pushed | commit `3f8cb8a` |
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

## P4 — Remux pipeline: done (condensed; full detail in commit `48d499f`)

ffprobe-driven copy-vs-transcode decision, ffmpeg execution, post-remux
verification (duration within 1%, stream presence), atomic publish into the
Movies/Series library layout, background worker pool bounded by
`min(2, cpus-1)`. Ready rows expose both a web-ready MP4 stream and an
"Original quality (needs streaming server)" second entry
(`?variant=original` on `/files/:id`). All synthetic-fixture tests (no real
media files anywhere in the suite) plus a real end-to-end run against the
live service. Deferred: real device playback (needs the acceptance matrix
on the actual deployment target, not this Windows dev machine); Windows
`SIGTERM` timing is still unverified (`Stop-Process` isn't real POSIX
`SIGTERM`) — carries forward from P3.

## P5 — Queue: done

### Built
- `service/src/queue/scheduler.ts` — `startScheduler()`, the real concurrent
  processor CLAUDE.md §10 calls for. Reuses `processItem()` (exported from
  `runner.ts`, P3) so crash-safety/resume logic isn't duplicated — this only
  adds running several rows at once. Concurrency is `settings.max_concurrent_downloads`,
  **read live every poll** (no restart needed once a `/settings` PATCH
  endpoint exists — not built yet, direct SQL only). Priority ordering
  reuses `getQueuedRows`' `ORDER BY priority DESC, added_at ASC`. Each
  in-flight row gets its own `AbortController` (not one pool-wide signal),
  enabling `abortRow(id)` — used by both PATCH `.../pause` and DELETE.
  `runner.ts`'s old single-lane `startQueueRunner`/`QueueRunnerHandle` were
  deleted (fully superseded); `step()`/`processItem()` stay, since P3's
  chaos tests still drive `step()` directly.
- `service/src/queue/remuxRunner.ts` — same per-row-`AbortController`
  treatment (was one pool-wide controller) so DELETE mid-remux can kill just
  that row's ffmpeg process without disturbing other concurrent remuxes.
  Both `SchedulerHandle` and `RemuxRunnerHandle` gained `abortRow()` and
  `activeCount()` (the latter now feeds `/health`'s real `activeJobs`,
  previously hardcoded `0`).
- `service/src/db/downloadItems.ts` — `getQueuedRows` (multi-row picker for
  the scheduler); `pauseDownload`/`resumeDownload`/`retryDownload` (each
  validates the current status server-side and returns
  `"ok"|"not-found"|"invalid-state"` — no separate read-then-write race,
  since better-sqlite3 is synchronous and there's no `await` between the
  status check and the guarded `UPDATE`); `setPriority`;
  `cancelOrDeleteDownload` (→ `cancelled` for anything in flight, →
  `deleted` for a `ready` row, idempotent on repeat calls); `getFullById` /
  `listAll` returning the complete `DownloadItem` shape for the REST API
  (JSON/boolean column coercion). **Important guard**: every
  completion-writing mutation (`markPaused`, `markFailed`, `markReady`,
  `markAwaitingRemux`, `markQueued`) now has `AND status NOT IN ('cancelled',
  'deleted')` — without it, a job that was already in flight when the user
  cancels/deletes it can finish late and resurrect the row. Verified by both
  a unit test and the E2E run below.
- `service/src/api/downloads.ts` — `POST/GET/PATCH/DELETE /downloads(/:id)`
  per CLAUDE.md §8, mounted without the `/:config` prefix (internal
  management API, not the Stremio addon protocol — same as `/health` and
  `/files/:id`). `POST` is idempotent by `(stremioId, quality)`: a duplicate
  enqueue looks the row up by that natural key and returns the *same* job
  (200) instead of the generated id from the redundant call; a genuinely new
  job returns 201. `DELETE` cleans up on-disk artifacts
  (`.part`/`.offline/remux/*.remux.mp4`/original/web-ready) best-effort.
- `service/src/queue/reconcile.ts` — orphan sweep extended to
  `.offline/remux/*.remux.mp4` (previously only `.part` files), closing the
  gap where a hard crash mid-remux (as opposed to a live DELETE, which now
  kills the ffmpeg process directly) would otherwise leave a staging file
  behind forever.
- `shared/types.ts` — **no changes needed**; `DownloadItem`/`Settings`
  already had every field P5 needed (`priority`, `maxConcurrentDownloads`,
  etc.) from the original spec.

### Tests
- `queue/scheduler.test.ts` — concurrency is actually bounded by
  `settings.max_concurrent_downloads` (a custom slow test server proves
  *both* that it reaches the limit and never exceeds it, since a
  same-server-instance approach couldn't observe real parallelism — see the
  file for why `fakeHttpServer.ts`'s one-shot `sliceDelayMs` doesn't fit
  this test); priority ordering under constrained concurrency; `abortRow`
  interrupts an in-flight download cleanly (→ `paused`, not corrupted); and
  a not-found case.
- `db/downloadItems.test.ts` — extended with unit tests for every new
  primitive, including the resurrection-guard test (cancel a row, then call
  every completion-writer against it, assert none of them can move it off
  `cancelled`).
- `api/downloads.test.ts` — full REST surface via Fastify's `.inject()`
  (no real network listener needed) against fake scheduler/remuxRunner
  handles, covering the enqueue-idempotency contract, all PATCH actions
  (including the 409 invalid-state and 404 cases), and DELETE for every
  status (idempotent re-delete, file cleanup on a `ready` row, `abortRow`
  called on the correct handle for `downloading` vs `remuxing`).
- 82 service tests + 5 addon tests pass; `npm run typecheck` / `npm run
  build` clean across all three workspaces.

### End-to-end verification performed
Booted the real service and ran a 16-check script against it over real
HTTP, using a slow custom file server (real HEVC/AC3 fixture, chunked with
artificial delay) so pause/resume had a real window to land in:
`POST /downloads` idempotency (duplicate call returns the same job id);
`GET /downloads` and `GET /downloads/:id`; pausing a genuinely in-flight
download via `PATCH .../pause` and confirming it does *not* silently
auto-resume; `PATCH .../resume` and watching the job complete through the
full download → remux → ready pipeline afterward; `PATCH` priority;
`DELETE` on a `ready` job (file actually removed from the library path);
`DELETE` on a still-`downloading` job (→ `cancelled`, live transfer
aborted) with a follow-up check that the in-flight job's late completion
did **not** resurrect it back to `paused`/`ready`. All 16 checks passed.

### Deferred / not done in P5
- `GET|PATCH /settings` REST endpoint — `max_concurrent_downloads` etc. are
  only reachable by direct SQL right now; the scheduler reads them live, so
  wiring the endpoint later needs no scheduler changes.
- `GET /download/:stremioId` (Rule 6's TV-remote trigger + pre-generated
  confirmation MP4 clip) — genuinely depends on P6 (resolvers): there's no
  source URL to enqueue from just a `stremioId` until a debrid/magnet
  resolver exists to produce one.
- `POST /downloads/:id/progress` (player reports position) — belongs with
  P11 (resume playback), not queue management.
- A literal bulk "pause all / resume all" endpoint — CLAUDE.md §8 only
  lists per-item `PATCH /downloads/:id`; bulk is achievable today by
  looping that per item, so a dedicated endpoint was skipped as
  unrequested scope.
- Live-cancel is per-*row*, not a global "pause the whole queue" flag for
  disk-full. The existing per-item disk-full pause (P3) already stops all
  writes once space runs out — every concurrent slot hitting the same
  `checkDiskSpace` guard pauses itself — so a separate global flag was
  judged not to add real protection, just another piece of state to keep
  in sync.

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
