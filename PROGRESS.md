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
| P6 Resolvers | ✅ done, **not yet pushed** | commit `30ae4b4` — **unverified against real debrid APIs**, see below |
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

## P5 — Queue: done (condensed; full detail in commit `3f8cb8a`)

Real concurrent scheduler (`queue/scheduler.ts`) reusing P3's `processItem()`,
bounded live by `settings.max_concurrent_downloads`, priority-ordered,
per-row-cancellable (`AbortController` per row, not one pool-wide signal —
`remuxRunner.ts` got the same treatment). Full `POST/GET/PATCH/DELETE
/downloads(/:id)` REST surface, idempotent enqueue by `(stremioId,
quality)`. Key correctness fix: every completion-writing DB mutation now
guards `AND status NOT IN ('cancelled', 'deleted')` so a job already in
flight when cancelled can't resurrect the row by finishing late. 82 service
+ 5 addon tests, full 16-check E2E run against the real service (pause mid-
download, resume, complete through remux, delete both ready and in-flight
jobs). Deferred: `GET|PATCH /settings` REST endpoint (direct SQL only for
now — scheduler already reads settings live, so this is a pure addition
later); `GET /download/:stremioId` Rule 6 trigger (needed P6 first, now
done — still not built, see below); bulk pause/resume-all (not in CLAUDE.md
§8, achievable today by looping per-item PATCH).

## P6 — Resolvers: done, with an important caveat

**None of the five debrid API integrations have been exercised against a
real account.** This was a deliberate, user-approved scope decision (no
test credentials available) — see the "unverified" notes throughout this
section before trusting any of it in production. Contrast with P0–P5, where
"done" meant verified end-to-end against the real running service; here it
means "implemented against each service's public API docs and covered by
tests using a fake HTTP layer, but the actual wire contract is unconfirmed."

### Built
- `service/src/resolvers/types.ts` — the common `DebridResolver` interface
  (`resolveMagnet(apiKey, magnetUri, fetchImpl?) → ResolveOutcome`) all five
  modules implement. `ResolveOutcome` is three-shaped
  (`ready`/`pending`/`error`), not two — caching a torrent server-side takes
  real time, so "not ready yet" has to be distinguishable from "failed."
- `service/src/resolvers/{realdebrid,alldebrid,premiumize,debridlink,torbox}.ts`
  — one module per CLAUDE.md §3 Rule 7's list. Each reconstructed from
  public API documentation (no live testing). Confidence varies:
  Real-Debrid and AllDebrid are the most commonly integrated APIs and their
  contracts are the best understood; Premiumize's `directdl` fast-path
  (instant resolve for already-cached content, only falling back to the
  async `transfer/create` flow when needed) is a deliberate optimization to
  avoid creating server-side state on every call; **DebridLink and TorBox
  carry the least confidence** — DebridLink's public docs are thinner than
  the other four, and both modules' field names are a starting point to
  correct against a real account before relying on them. Every module's
  file header says this explicitly.
- `service/src/resolvers/autodetect.ts` — `getConfiguredResolver(db)` picks
  the first enabled account in Rule 7's priority order (Real-Debrid →
  AllDebrid → Premiumize → DebridLink → TorBox). Returns `null` when
  nothing's configured, which the runner treats as "use `magnet` sourceKind
  instead" (webtorrent fallback), not an error.
- `service/src/db/debridAccounts.ts` + `service/src/api/debridAccounts.ts`
  — `debrid_accounts` table (one row per service, upsert-by-service) and
  `GET/POST/DELETE /debrid-accounts`. **Not explicitly in CLAUDE.md §8's API
  table** — added because the resolvers need *some* way to learn a
  configured key, mirroring the existing `GET|POST /addons` pattern.
  Responses always mask the key (`****7890`) — never echo a full API key
  back, same spirit as "no tokens in logs."
- `service/src/downloaders/torrent.ts` — webtorrent fallback per Rule 7
  ("webtorrent stays as fallback for users without a debrid account").
  Downloads the largest file in the torrent, deselects everything else
  (samples/NFOs/subtitles bundled in the release don't waste bandwidth).
  Structurally typed against a minimal `WebTorrentClientLike` interface
  (not the real `@types/webtorrent` shapes) specifically so tests can
  inject a fake client instead of needing a real swarm.
- `service/src/queue/runner.ts` — `processItem()` now branches on
  `row.sourceKind`. `http` is unchanged (P3). `magnet` calls
  `downloadMagnetToPart` directly. `debrid` calls `getConfiguredResolver` +
  `resolveMagnet`, **fresh on every attempt** — deliberately never caches
  the resolved URL in the DB (`source_url` stays the magnet, always). This
  is what makes CLAUDE.md §4's "debrid links expire, re-resolve and resume"
  requirement basically free: there's never a stale link to detect,
  because nothing persists past one attempt. The tradeoff: a transient
  network blip on a 'debrid' row triggers a fresh API call on retry too,
  not just an expired-link scenario — simpler than distinguishing the two
  cases, at the cost of extra debrid API calls on retry. A `pending`
  resolve outcome is folded into the *existing* retryable-error/backoff
  path (reuses `MAX_ATTEMPTS`/`incrementAttempt` rather than a new state
  machine) — practically, a torrent that needs a long time to cache
  server-side will eventually hit the 10-attempt ceiling and require a
  manual retry, which was judged an acceptable, simple trade-off.
  `RunnerDeps` gained an injectable `torrentClient` for tests, mirroring
  the existing `fetchImpl` pattern.
- `service/src/api/downloads.ts` — `POST /downloads` now requires
  `sourceUrl` to start with `magnet:` when `sourceKind` is `magnet` or
  `debrid`.
- `service/src/api/health.ts` — `debrid` subsystem status is now real
  (`ok` if any enabled account is configured, `down` otherwise) instead of
  hardcoded `"down"`. Doesn't call out to the actual service — that would
  slow down every health check and needs live credentials to mean anything.
- `shared/types.ts` — added `DebridService`, `DebridAccount`.
  `schema.sql` — added `debrid_accounts` table.
- Dependency: `webtorrent` (+ `@types/webtorrent` dev dep). **Gotcha**: npm
  flagged 8 packages (native modules like `utp-native`, `bufferutil`,
  `node-datachannel`) whose install scripts weren't run under this
  environment's `allow-scripts` policy. Untested whether webtorrent's core
  functionality is affected — if real torrent downloads misbehave later,
  check this first (`npm approve-scripts` or rebuild those natives),
  especially on the Linux Docker deployment target.

### Tests
127 total (was 82): one test file per resolver against a hand-rolled fake
`fetch` (happy path, a `pending`/still-caching case, and at least one
terminal + one retryable error per service);
`resolvers/autodetect.test.ts` (priority ordering, disabled accounts,
upsert-replaces-not-duplicates); `downloaders/torrent.test.ts` against a
fake `WebTorrentClientLike` (largest-file selection, progress, disk-full,
abort, no-files error) — the fake client is shared
(`testutils/fakeTorrentClient.ts`) with `queue/runner.test.ts`'s new
`sourceKind` branch tests. **Gotcha**: the first draft of the fake client
deferred its callback via `queueMicrotask`, racing against the test's
`fsp.mkdir` (real async I/O) with no reliable ordering — two tests hung for
20s before failing. Fixed by making the fake callback fire synchronously
and exposing a `whenAdded` promise the test awaits instead of guessing with
`setImmediate`/`setTimeout`. The `debrid` branch test in `runner.test.ts`
is worth calling out: it fakes only the Real-Debrid API calls and lets the
*actual* file download hit a real local test HTTP server through the real
`fetch`, proving the resolved URL flows through the exact same
`downloadToPart()` path as `sourceKind: "http"`. `api/debridAccounts.test.ts`
covers the REST CRUD, including that the masked key never contains the
real secret.

### End-to-end verification performed (partial — see caveat above)
Booted the real service and, over real HTTP: configured a debrid account
via `POST /debrid-accounts`, watched `/health`'s `debrid` subsystem flip
`down → ok → down` as the account was added/removed (fully real, no
mocking possible or needed); enqueued a `debrid` job with no account
configured and confirmed it reaches `failed` with a clear `lastError`
end-to-end through the real API (not just a unit test). **Then attempted a
real webtorrent smoke test** against Sintel (a legal, Creative-Commons,
widely-used BitTorrent test torrent — not scraped/bundled content, just a
magnet URI in a throwaway test script) to see whether real P2P
connectivity works from this environment at all: the job reached
`downloading` status (torrent added, metadata presumably fetched) but
received zero bytes within a 25-second bound. Most likely this sandboxed
environment blocks outbound P2P/DHT/tracker traffic — expected, not a code
defect — but this remains **genuinely unverified**, not just
"unverified against a real account" like the debrid modules. The debrid
API calls themselves (Real-Debrid, AllDebrid, Premiumize, DebridLink,
TorBox) were **not** exercised at all in this E2E run — there was no way
to redirect their hardcoded `https://api.<service>.com` base URLs to a
local fake server without editing the modules for a one-off test, so that
gap is closed only by the mocked-fetch unit tests, not by anything hitting
the real running service.

### Deferred / not done in P6
- Real verification of all five debrid API contracts against live
  accounts. **This is the load-bearing gap in this phase** — flag it
  clearly to the user before shipping; field names, auth schemes, and
  status-value spellings may all need correction.
- Real webtorrent P2P verification (couldn't confirm outbound connectivity
  works in this environment at all).
- `GET /resolve?stremioId=&type=` (CLAUDE.md §8) and the source-addon
  client that would feed it real magnets from the user's own configured
  Stremio addons — that's `addonClient.ts`, which CLAUDE.md §10 explicitly
  assigns to **P10** ("P10 addonClient.ts queries registered source addons
  ... superset of P6; don't start it earlier"), not P6. Today, a `magnet`
  or `debrid` enqueue requires the caller to already have a magnet URI in
  hand (e.g. from a dashboard, or pasted manually) — there's no in-app way
  yet to go from a `stremioId` to a magnet automatically.
- `GET /download/:stremioId` (Rule 6's TV-remote trigger + pre-generated
  confirmation MP4 clip) — depends on the above (needs a real source to
  enqueue from just a `stremioId`).
- Link re-resolution is "resolve fresh every attempt," not a distinct
  "detect a 403/404 specifically and re-resolve" code path — see the
  runner.ts note above for the reasoning and the accepted trade-off.

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
