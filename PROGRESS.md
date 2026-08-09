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
| P6 Resolvers | ✅ done, pushed | commit `30ae4b4` — **unverified against real debrid APIs**, see below |
| P7 Subtitles | ✅ done, **not yet pushed** | commit `1e151d1` — see below, verified against a real local fake OpenSubtitles server, stronger confidence than P6 |
| P8 Storage | not started | |
| P9 Progress + dashboard | not started | |
| P10 Episode auto-download | not started | |
| P11 Resume playback | not started | |

Repo: https://github.com/VaibhavHiwale/stremio-offline (remote `origin`, branch `master`).
P0–P4 work is committed locally (P4 landed via a squash-merge from
`wip/p4-remux-pipeline`, which was a temporary parking branch while it didn't
typecheck — that branch can be deleted now). **Confirm what's actually pushed
with `git log origin/master..master` before assuming parity with GitHub.**

## Error-capture system: done (not a CLAUDE.md phase — no P-number)

User-requested mid-session (2026-08-09), outside the P0–P11 build order:
unhandled failures (resolver exceptions, DB write failures, REST handler
errors) get appended as structured records to a local append-only NDJSON
log with a hashed per-install identifier, rolled up weekly into a markdown
summary grouped by component + error type. Two mismatches against a
literal reading of the original request were confirmed with the user
before building: "household token" → this project has no household/
multi-tenant concept, so it's a **per-install** hashed identifier instead;
"Cinemeta" → this service never calls Cinemeta anywhere, so that reference
was dropped in favor of this service's actual external calls.

`observability/{installId,errorLog,weeklyRollup}.ts` — `getInstallIdHash`
(reuses the existing generate-once-and-persist secret pattern, SHA-256
hashed, raw id never leaves that one file); `recordError`/`readRecentErrors`
(synchronous append — errors are rare, the write is small, and a
fire-and-forget async write risks losing the record a crash shortly after
would need; never throws itself); `generateWeeklyRollupMarkdown`/
`persistWeeklyRollup`/`isWeeklyRollupDue` (most-frequent-first markdown
table, regenerated at boot and once a day thereafter via `index.ts`'s
`setInterval`, unref'd so it never keeps the process alive on its own).

Wired into `app.ts`'s new Fastify `setErrorHandler` (REST errors — never
leaks the raw error message on a 500, always logs one internally) and,
more importantly, into two places that were previously **silently
swallowing unexpected exceptions** — `queue/scheduler.ts`'s and
`queue/remuxRunner.ts`'s per-job `.catch(() => undefined)`, a real,
separate bug this work surfaced rather than just new instrumentation.
`remuxRunner.ts`'s subtitle-fetch catch (P7) also now records instead of
silently doing nothing. New `GET /diagnostics/errors` computes the rollup
fresh from the log on every request (cheap), independent of the on-disk
weekly file anyone can also just read directly.

26 new tests (161 total) covering every module plus the Fastify error
handler (forces a real `better-sqlite3` throw by closing the DB connection
before the request, not a mock) and the diagnostics endpoint. Full E2E
against the real service: boot-time rollup file written, a real forced
REST error shows up in `/diagnostics/errors` attributed to the `rest`
component. All 7 checks passed.

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

## P6 — Resolvers: done (condensed; full detail in commit `30ae4b4`) — caveat below

Five debrid resolver modules (`resolvers/{realdebrid,alldebrid,premiumize,
debridlink,torbox}.ts`) behind a common `DebridResolver` interface, plus
`autodetect.ts` (Rule 7 priority order) and a webtorrent fallback
(`downloaders/torrent.ts`, structurally typed so tests inject a fake
client). `queue/runner.ts` branches on `sourceKind`; a `debrid` row
resolves fresh on every attempt rather than caching the resolved URL,
which makes "links expire, re-resolve" (CLAUDE.md §4) free by construction.
`GET/POST/DELETE /debrid-accounts` for configuration (keys always masked in
responses). **Caveat, still true, carries forward**: none of the five
debrid API integrations have been exercised against a real account —
implemented against public docs only, confidence lowest for DebridLink and
TorBox. Verified end-to-end: the debrid-accounts REST surface, health
reporting, and clean failure with no account configured — all against the
real running service. A bounded real-webtorrent smoke test reached
`downloading` but got no bytes in 25s (sandboxed network, not a code
defect — also unverified). Deferred: real debrid API verification (the
load-bearing gap — flag before production use); the source-addon client
that would supply real magnets automatically is P10's job per CLAUDE.md
§10, not P6's — today `magnet`/`debrid` enqueues need a magnet URI supplied
directly.

## P7 — Subtitles: done, and verified more thoroughly than P6

Unlike the five debrid services (hardcoded base URLs, no way to redirect
them in an E2E run), OpenSubtitles is a single service and its client was
built with an **injectable base URL** from the start — which meant the E2E
run below could exercise the *exact* real request/response flow this
service uses against a real local HTTP server, not just in-process mocks.
That's meaningfully stronger verification than P6 got, even though the
actual `api.opensubtitles.com` contract is still unconfirmed (see caveat
below) — same category of gap as P6, smaller in practice.

### Built
- `service/src/subtitles/opensubtitles.ts` — `searchSubtitle` (by numeric
  IMDb id + language, picks the result with the highest `download_count`)
  and `downloadSubtitle` (POST to get a temporary link, then GET that link
  for the actual `.srt` text) against `api.opensubtitles.com/api/v1`.
  Contract reconstructed from OpenSubtitles' public docs — **not verified
  against a live API key**, same caveat as P6's resolvers. Both functions
  take an optional `baseUrl` (default the real API) specifically so this
  could be pointed at a local fake server for real E2E testing.
- `service/src/subtitles/sidecar.ts` — `sidecarPath(videoPath, lang)`
  (`The Matrix (1999).mp4` → `The Matrix (1999).en.srt`, matching CLAUDE.md
  §7's library layout example) and `writeSidecar`. Validates the language
  code against a strict regex before ever building a path from it — a
  malicious/malformed lang string can't escape the library directory.
- `service/src/subtitles/fetchForItem.ts` — `fetchSubtitlesForItem`
  orchestrates search → download → write-sidecar per language, and
  `parseImdbId` extracts the numeric id from a `stremioId` like
  `tt0903747:1:2`. Deliberately never throws: one language's failure
  (not found, quota, network) doesn't affect the others or the download's
  own status — the video is already playable without it.
- `service/src/queue/remuxRunner.ts` — calls `fetchSubtitlesForItem`
  right after `markReady` (best-effort, wrapped in its own try/catch),
  using `settings.open_subtitles_api_key` / `settings.subtitle_langs`
  (skipped silently, not an error, when no key is configured). Successful
  languages get recorded onto the row via the new `addSubtitleLang` DB
  primitive — the addon's `subtitles` handler trusts that column instead
  of checking the filesystem itself, keeping the addon package DB-only
  like every other handler there.
- `service/src/api/files.ts` — `/files/:id` gained a `variant=subtitle`
  mode (`&lang=<code>`, same strict regex check) serving the sidecar as
  `application/x-subrip`, no Range support (subtitle files are tiny).
  `buildSignedFileUrl` extended with an optional `lang` param — the token
  itself still isn't variant-specific (same reasoning as P4's
  original/web-ready split: every variant of an id belongs to the same
  authorized download item).
- `addon/src/handlers/subtitles.ts` — replaced the P2 stub. Returns one
  `SubtitleEntry` per language recorded in `subtitle_langs` for each
  `ready` row matching the `stremioId`, with a signed URL from the new
  `buildSubtitleUrl` dependency (mirrors `buildFileUrl`/
  `buildOriginalFileUrl`'s wiring through `app.ts`).
  `addon/src/repository.ts` gained `subtitleLangsRaw` +
  `parseSubtitleLangs()`.
- `shared/types.ts` — added `Settings.openSubtitlesApiKey`. `schema.sql` —
  added `settings.open_subtitles_api_key`.
- `index.ts` — `OPENSUBTITLES_BASE_URL` env var overrides the resolver's
  default base URL, threaded through to `startRemuxRunner`. Exists purely
  for testability (see the E2E note below) — unset in normal operation, so
  production always hits the real API.

### Tests
38 new (144 service + 10 addon total): `subtitles/opensubtitles.test.ts`,
`subtitles/sidecar.test.ts` (including the path-traversal-rejection case),
`subtitles/fetchForItem.test.ts` (per-language independence — one API
error doesn't block another language's fetch); `queue/remuxRunner.test.ts`
extended with 3 P7 cases (subtitle fetched after publish, a subtitle
network error never fails the download, fetching is skipped entirely with
no key configured); `api/files.test.ts` extended with real
`registerFilesRoute` + Fastify `.inject()` tests for the subtitle variant
(serves content, rejects a path-traversal-shaped lang, 404s when never
fetched); `addon/src/handlers/subtitles.test.ts` (new — first
Fastify-`.inject()`-based handler test in the addon package, against a
minimal inline SQLite schema since the addon package doesn't depend on the
service package).

### End-to-end verification performed
Booted the real service with a **real local HTTP server implementing the
actual OpenSubtitles endpoints** (`/subtitles`, `/download`, and the
downloaded-content URL) pointed to via `OPENSUBTITLES_BASE_URL` — not
mocked fetch inside the same process, an actual second server the real
`fetch` calls hit. Ran a real download through the full pipeline
(download → remux → ready), confirmed the subtitle search fired exactly
once against the fake server, the sidecar got written with the exact
content that server returned, `subtitle_langs` recorded `["en"]` on the
row, `GET /subtitles/movie/:id.json` returned the real signed URL, and
`GET` on that URL served the real `.srt` content with the correct
`application/x-subrip` content-type. All 8 checks passed.

### Deferred / not done in P7
- Real verification against `api.opensubtitles.com` itself (need a real
  account/key) — the E2E above proves the *client's* HTTP mechanics are
  correct, not that OpenSubtitles' actual field names match what the code
  expects.
- Sidecar files are only ever written for the **web-ready** file
  (`file_path_web_ready`), never for the original — consistent with P4's
  "the web-ready MP4 is the primary served asset" stance, but means a user
  playing the "Original quality" stream entry (P4 Rule 1's second entry)
  won't get an automatically-served subtitle for it, only the sidecar
  living next to the web-ready copy.
- No re-fetch/refresh mechanism if a subtitle turns out to be
  out-of-sync — `subtitle_langs` only ever grows, there's no way to clear
  a bad entry short of editing the DB directly.

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
