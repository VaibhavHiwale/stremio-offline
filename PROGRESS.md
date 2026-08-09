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
| P7 Subtitles | ✅ done, pushed | commit `1e151d1` — see below, verified against a real local fake OpenSubtitles server, stronger confidence than P6 |
| P8 Storage | ✅ done, pushed | commit `98022a1` — see below, fully verified end-to-end, including the real background sweeper |
| P9 Progress + dashboard | ✅ done, pushed | commit `e6557b7` — real E2E caught and fixed a genuine WS registration bug that unit tests alone missed |
| P10 Episode auto-download | ✅ done, pushed | commit `96e337c` — real E2E against a fake local source addon, full download→remux→ready→auto-enqueue chain |
| P11 Resume playback | ✅ done, **not yet pushed** | see below — `videoHash`/`videoSize`/real `filename` in `behaviorHints`, plus `POST /downloads/:id/progress` |

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

## P8 — Storage: done, fully verified (no caveats this time)

Unlike P6/P7, nothing here depends on an external API or real account —
every piece was exercised for real end-to-end, including the real
background sweeper on its own schedule (not called directly).

### Built
- `db/storageTargets.ts` + `storage/targets.ts` — `storage_targets` had sat
  completely unused since P0 (the table existed, nothing ever wrote to it,
  every download silently used the string `"default"` with no backing row).
  `ensureDefaultTarget(db, storageRoot)` now registers it for real at boot;
  `refreshAllTargetUsage` updates `bytesFree`/`bytesTotal` for every
  registered target via the new `diskspace.ts:getDiskUsage`, best-effort
  (an unreachable path — e.g. an unplugged USB drive — just keeps its
  last-known figures rather than erroring). **Deliberately no automatic
  OS-wide volume enumeration** — CLAUDE.md §2's locked-in deployment
  decision (separate always-on NAS/Pi, not co-located with Stremio) means
  the operator already knows their own mount points; auto-discovering every
  mounted filesystem and exposing it as a target without being asked would
  be scope creep and a minor antipattern. `POST /storage/targets` (an
  admin manually registering an external SD/USB/NAS path) covers the
  "external SD/USB" part of this phase's brief instead.
- `api/storageTargets.ts` — `GET/POST /storage/targets`, `GET
  /storage/usage` (CLAUDE.md §8). `GET /storage/targets` returns
  cached/last-known figures (fast); `GET /storage/usage` calls
  `refreshAllTargetUsage` first (does the real `statfs` calls, so it's the
  one to hit for an up-to-the-moment reading). `POST` rejects a path that
  isn't a real, reachable, writable-checkable directory.
- `db/downloadItems.ts:getAutoDeleteCandidates` + `storage/autodelete.ts` —
  a `ready` row qualifies for cleanup when either (a) it's `watched` and
  either its own `auto_delete_after_watch` or the global
  `settings.auto_delete_after_watch` default is set, or (b)
  `settings.auto_delete_after_days` is set and `completed_at` is older than
  that many days — independent of watched status. `sweepAutoDelete` (one
  pass, exported directly for deterministic tests, same pattern as
  `processRemuxRow`) reuses P5's `cancelOrDeleteDownload` +
  `storage/cleanupFiles.ts:cleanupDownloadFiles` — the exact same DB
  transition and file-removal logic `DELETE /downloads/:id` uses, extracted
  out of `api/downloads.ts` into its own module specifically so both
  callers share one place that knows every location a download's bytes
  could be sitting. `startAutoDeleteSweeper` polls in the background
  (default 60s, overridable via `AUTO_DELETE_POLL_MS` for tests/E2E),
  recording any unexpected exception via the error-capture system rather
  than dying silently.
- **No progress-reporting endpoint exists yet** to set `watched` for real —
  `POST /downloads/:id/progress` is explicitly P11's job per CLAUDE.md §10
  and this file's own P5 deferred-notes. Both the unit tests and the E2E
  run set `watched`/`auto_delete_after_watch` directly via SQL, matching
  how the sweeper's own tests do it — the sweep logic itself doesn't care
  how those columns got set.

### Tests
20 new (181 total): `db/storageTargets.test.ts` (upsert-replaces, ordering,
delete); `storage/targets.test.ts` (idempotent boot registration, usage
refresh, unreachable-path graceful degradation); `storage/autodelete.test.ts`
(every qualifying/non-qualifying combination — per-item flag, global
default, age-based, and the "never touches a non-ready row" guard);
`api/storageTargets.test.ts` (REST CRUD, unreachable-path rejection, usage
refresh).

### End-to-end verification performed
Booted the real service and confirmed, over real HTTP: the default target
is auto-registered at boot pointing at `STORAGE_ROOT`; `POST
/storage/targets` registers a real external path; `GET /storage/usage`
reflects both. Then ran a real download through the full pipeline to
`ready`, set `watched`/`auto_delete_after_watch` directly (the only way
available pre-P11), and waited on the **real background sweeper** — not a
direct `sweepAutoDelete()` call — to pick it up on its own 1-second-overridden
poll schedule and actually remove the published file from disk. All 8
checks passed.

### Deferred / not done in P8
- Automatic OS-level volume/mount enumeration — a deliberate scope
  decision (see above), not a gap to fill later unless the deployment
  model changes.
- `DELETE /storage/targets/:id` — CLAUDE.md §8 doesn't list it, and nothing
  in this phase needed to remove a registered target once added; trivial
  to add later following the exact pattern `DELETE /debrid-accounts/:service`
  (P6) already established.
- Auto-delete's `watched` trigger is untestable through a real client flow
  until P11 adds the progress-reporting endpoint — the sweep mechanics
  themselves are fully verified, but nothing in this codebase can set
  `watched=true` through normal use yet.

## P9 — Progress + dashboard: done. Read the WS gotcha below before touching `/ws/progress` again

A real end-to-end run (not just unit tests) caught a genuine bug that would
otherwise have shipped: every real WebSocket connection to `/ws/progress`
was getting a `500` and `socket.send is not a function` internally. The
unit tests all passed anyway, because they set up the `@fastify/websocket`
plugin differently than production code did — see the dedicated gotcha
entry below. This is the reason P9 took longer than P8: chasing this down
and confirming the fix with a real `ws` client against the real running
service, not just Fastify's `.inject()`.

### Built

- `api/wsProgress.ts` — `WS /ws/progress` (CLAUDE.md §8). One shared
  `setInterval` (default 1s) polls `db/downloadItems.ts:getActiveItems`
  (new — every non-terminal status in one query) and broadcasts a full
  snapshot to every connected client; a new connection also gets an
  immediate snapshot on open rather than waiting out the poll interval.
  Deliberately *not* wired into every progress-writing call site across
  P3/P5/P6 — that would mean touching already-tested code in several
  packages for a latency improvement nobody would notice in a progress
  bar. See the gotcha below for how the plugin is registered.
- `api/diagnostics.ts` — added `GET /diagnostics` (the actual CLAUDE.md §4
  page: resolves the base URL, checks the HTTPS cert, probes ffmpeg,
  confirms the manifest is fetchable — distinct from the pre-existing
  `GET /diagnostics/errors` JSON endpoint from the error-capture system,
  which stays as-is).
- `db/settings.ts` + `api/settings.ts` — `GET|PATCH /settings` (CLAUDE.md
  §8) didn't exist through P0–P8 despite being in the spec's API table;
  built now because the dashboard genuinely needs it to expose any
  settings UI at all. Partial-update via a whitelisted field→column map
  (never builds SQL from a caller-supplied field name). Deliberately
  excludes `legalNoticeAcceptedAt` from what a PATCH can set (silently
  dropped, not an error) — that has its own dedicated accept flow in
  `legal.ts` and must not be settable by just PATCHing settings.
- **`dashboard/`** — new workspace (Vite + React 18 + TypeScript,
  registered in the root `package.json` workspaces array and build
  script). Two views: a live download list (REST fetch on load + 5s
  poll, live-merged with `/ws/progress` snapshots for in-flight items,
  pause/resume/retry/delete actions) and a settings view (general
  settings, debrid accounts, storage targets — all against the REST
  endpoints already built in P5/P6/P8/P9). Hand-rolled CSS (light/dark via
  `prefers-color-scheme`), no UI framework — matches this project's
  existing "hand-roll where reasonable" pattern from the addon package.
  PWA manifest + SVG icon for installability.
- `api/dashboardStatic.ts` — serves `dashboard/dist` at `/` via
  `@fastify/static`, registered **last** in `app.ts` so it can never shadow
  an API route (verified directly — see Tests below). Resolves the dist
  path relative to the compiled service location
  (`service/dist/api/dashboardStatic.js` → repo root → `dashboard/dist`);
  if the dashboard hasn't been built yet, logs a warning and skips
  registration instead of crashing boot — the REST API and Stremio addon
  surface work fine without it.
- Dependencies pinned to Fastify-4-compatible major versions, **not**
  latest: `@fastify/websocket@10.0.1` and `@fastify/static@7.0.4`. The
  latest majors of both require Fastify 5 (this project is still on
  Fastify 4) and fail loudly at boot with `FST_ERR_PLUGIN_VERSION_MISMATCH`
  if installed carelessly — check a candidate's `fastify-plugin` peer
  version against Fastify 4 (roughly `fastify-plugin: ^4.x`) before
  upgrading either package.

### Gotcha: `@fastify/websocket` plugin registration ordering (the real bug)

`app.register(websocketPlugin)` followed **immediately, in the same
synchronous tick**, by `app.get(path, { websocket: true }, handler)` looks
correct and typechecks fine, but silently registers a *plain* HTTP route:
the plugin's `onRoute` hook (the thing that rewrites the route to call your
handler as `(socket, request)` instead of Fastify's normal
`(request, reply)`) isn't attached yet, because `.register()` is
asynchronous and Fastify only applies the hooks present *at the moment*
`.get()` is called. The bug doesn't surface at boot or in a naive test —
only when a real client actually connects, at which point the handler
receives a `FastifyRequest` where it expects a `ws.WebSocket`, and
`socket.send(...)` throws `TypeError: socket.send is not a function`,
returned to the client as a `500` during the upgrade handshake. **This is
exactly what the original `wsProgress.test.ts` draft missed**: it called
`await app.register(websocket)` itself before calling
`registerWsProgressRoute`, which — because it was awaited — worked fine,
while `app.ts`'s real (unawaited) registration didn't. The tests were
quietly exercising a different code path than production.

Two ways to fix the ordering, only one of which is fully correct:

- ❌ Nest the plugin + route inside one `app.register(async (instance) => {
  await instance.register(websocketPlugin); instance.get(...); })`. This
  *does* fix the ordering (avvio properly sequences nested registrations),
  but silently creates a new encapsulation context — `injectWS` and
  `websocketServer` end up decorated onto the inner `instance`, not the
  outer `app`, breaking anything (tests, mainly) that expects them on the
  instance you actually called `registerWsProgressRoute` with.
- ✅ `app.register(websocketPlugin); app.after(() => { app.get(path, {
  websocket: true }, handler); });` — `.after()` queues its callback to run
  once everything registered before it has finished loading, **without**
  creating a new encapsulation context. Ordering is correct *and*
  `app.injectWS` stays on `app`. This is what `wsProgress.ts` does now.

### Tests
28 new (201 service + 10 addon total, dashboard has no test runner — see
Deferred below): `wsProgress.test.ts` (now correctly exercises the same
plugin-registration path `app.ts` uses — see the gotcha above);
`diagnostics.test.ts` extended for the new HTML page (resolved base URL
shown, fail badge when unresolvable, manifest-unreachable case);
`settings.test.ts` (db + REST, including that `legalNoticeAcceptedAt`
can't be set via PATCH); `dashboardStatic.test.ts` — the collision test is
worth calling out specifically: registers a real `GET /health` route
*and* a static file literally named `health` in the same dist directory,
confirms the API route wins.

### End-to-end verification performed
Booted the real service and, over real HTTP/WS: `GET /` served the built
dashboard's `index.html`; `GET /manifest.webmanifest` (PWA) and `GET
/manifest.json` (the Stremio addon's real manifest) both resolved
correctly at their distinct paths with no collision; `GET`/`PATCH
/settings` round-tripped a change; `GET /diagnostics` rendered with the
resolved base URL visible. Then, using the real `ws` npm package (not
`.inject()`) against the real listening server: connected to
`/ws/progress`, enqueued a job over REST, and confirmed the live
WebSocket client received a snapshot containing that job — this is the
check that failed before the plugin-registration fix and passed cleanly
after it. All checks passed.

### Deferred / not done in P9

- No dashboard component/browser test runner — TypeScript compiles clean
  and the Vite production build succeeds, plus the static-serving and API
  layers are verified for real, but nothing renders the React tree in a
  real or simulated DOM. Installing a browser-automation stack (Playwright/
  Puppeteer) purely for this felt like disproportionate scope for a v1
  personal-use dashboard; revisit if the UI grows complex enough that
  manual verification stops being trustworthy.
- No service worker / offline caching for the PWA — the manifest makes it
  installable, but there's no cache-first asset strategy yet. The
  dashboard needs the service reachable to do anything useful anyway
  (it's a control panel, not offline-first content), so this was judged
  low value for v1.
- The dashboard's dev-server proxy (`vite.config.ts`) targets
  `127.0.0.1:11470` (the plain-HTTP localhost listener) hardcoded — fine
  for local development against a service running with default ports,
  not configurable yet.

## P10 — Episode auto-download: done, verified against a real fake source addon over real HTTP

CLAUDE.md §10 names this exactly: "`addonClient.ts` queries registered
source addons server-side for the next N episodes. Superset of P6." P6's
own PROGRESS.md entry already flagged the gap this closes: *"today
`magnet`/`debrid` enqueues need a magnet URI supplied directly"* — nothing
in this codebase could go from "a series episode finished" to "here's a
real magnet for the next one" until now.

### Built

- `shared/types.ts` — added `SourceAddon` (id, manifestUrl, name, addedAt).
  `schema.sql`'s `source_addons` table has existed since P0 but was
  completely unused until now — same shape as P8's `storage_targets` before
  that phase wired it up.
- `db/sourceAddons.ts` — list/insert/get-by-url/delete. Idempotent by
  `manifest_url` (schema `UNIQUE`) — re-registering an addon already known
  is a no-op, first registration wins (doesn't silently rename it).
- `api/addons.ts` — `GET|POST /addons` (CLAUDE.md §8, exactly as spec'd, no
  extra scope). `POST` fetches the manifest for real before saving anything
  (`resolvers/addonClient.ts:fetchAddonManifestInfo`) and rejects with `422`
  if it's unreachable or doesn't declare the `stream` resource — better to
  fail at registration time than silently have a dead addon in the list
  that auto-download queries forever for nothing. No `DELETE /addons` —
  CLAUDE.md §8 doesn't list one; same precedent as P8's storage-targets
  deferral, trivial to add later matching `DELETE /debrid-accounts/:service`.
- `resolvers/addonClient.ts` — the module CLAUDE.md names directly.
  `fetchStreamsFromAddon`/`fetchSeriesVideos` query an arbitrary third-party
  addon's `/stream/:type/:id.json` and `/meta/series/:imdbId.json`; both
  **never throw** (return `[]`/`null` on any failure) — one broken or
  unreachable addon must not block others being queried for the same
  episode. `resolveStreamSource` converts one external stream entry (which
  may carry a direct `url`, a `magnet:` `url`, or a torrent `infoHash` +
  tracker `sources`) into a `{sourceKind: "http"|"magnet", sourceUrl,
  quality}` the DB layer can use — `guessQuality` regexes the stream's
  name/title for a quality tag, falling back to `"original"` (meaning
  *unknown*, not literally source-master quality) when none is found, which
  is common for addons that don't tag quality in their titles.
- `queue/autoDownload.ts` — `triggerAutoDownloadNextEpisodes`, the
  orchestration CLAUDE.md's "the four complaints" names directly: "auto-
  download the next episode while binge-watching." For a completed series
  episode, `findNextEpisodeTargets` tries each registered addon's `meta`
  resource first (correctly crosses season boundaries via the real
  `videos` list, sorted and indexed by the current episode) and only falls
  back to a naive same-season `episode + 1..N` increment if **no**
  registered addon implements `meta` for that series (many stream-only
  addons like Torrentio don't) — documented as a real limitation below, not
  silently papered over. For each target episode, queries registered
  addons in registration order for the first usable stream matching
  `settings.defaultQuality` (falling back to an unknown-quality stream
  rather than skipping the episode outright), and enqueues via the same
  `enqueueDownload` DB primitive `POST /downloads` uses — `sourceKind`
  upgrades from `"magnet"` to `"debrid"` when a debrid account is
  configured (CLAUDE.md §3 Rule 7), exactly mirroring `queue/runner.ts`'s
  existing handling of both. Wrapped end-to-end in one `try/catch` (see the
  gotcha below) and recorded via `recordError` on any failure — best-effort,
  the pattern P7's `fetchSubtitlesBestEffort` established: never affects
  the episode that just became `ready`.
- `db/downloadItems.ts` — `QueueRow` gained `seriesId` (needed by the
  trigger to group new episode rows under the same series; previously only
  the full-shape `DownloadItem` read carried it). New
  `existsByStremioId` — the idempotency check: an episode already
  queued/downloading/ready/**failed** is never re-triggered. A failed
  auto-enqueue is deliberately left for a manual retry rather than being
  re-attempted on every subsequent episode completion, which would otherwise
  hammer a broken/misconfigured addon indefinitely.
- `queue/remuxRunner.ts` — calls the new trigger right after `markReady`,
  alongside the existing P7 subtitle fetch — same best-effort wrapping
  pattern, same call site, both non-blocking of the `ready` status.

### Gotcha (small, but worth flagging): a best-effort function's `try` must wrap the *entire* body

Writing the "never throws" test for `triggerAutoDownloadNextEpisodes`
caught a real bug in the first draft: `getSettings(deps.db)` was called
**before** the `try` block (to early-return if auto-download is disabled
without doing any other work). That's a reasonable-looking optimization
that quietly breaks the exact guarantee this function exists to provide —
a DB failure on that one call would propagate uncaught, right past the
best-effort framing, into `remuxRunner.ts`'s caller. Fixed by moving the
settings read inside the `try`. **Lesson**: for a "never throws,
best-effort" function, put the entire body in the `try` — including the
part that looks like a cheap, can't-fail early exit — or write a test that
forces that exact call to fail and assert the function still resolves.

### Tests
39 new (276 service + 10 addon total): `db/sourceAddons.test.ts`,
`resolvers/addonClient.test.ts` (manifest validation, stream/meta
fetching's never-throws contract, magnet construction from `infoHash` +
trackers, quality guessing); `api/addons.test.ts`; `queue/autoDownload.test.ts`
— the most important cases: next-episode targets via a fake addon's real
`meta` videos list vs. the same-season-fallback path when no addon
implements `meta`; an episode with no matching stream on any addon is
skipped, not a failure; an already-existing row (any status, including
`failed`) short-circuits before even querying for streams; `sourceKind`
correctly upgrades to `debrid` when an account is configured; and the
never-throws case described in the gotcha above.

### End-to-end verification performed
Booted the real compiled service and a **real local HTTP server** playing
the role of a third-party source addon (serving a real `manifest.json`,
`meta/series/:id.json` with a two-episode `videos` list, and
`stream/series/:id.json` with a torrent `infoHash`) plus a real static
`video.mp4` file — nothing mocked or in-process. Registered the fake addon
via `POST /addons` (and confirmed an unreachable manifest URL correctly
`422`s), enabled auto-download via `PATCH /settings`, then `POST
/downloads`'d episode 1 and let it run the **entire real pipeline**:
download → remux → verify → publish. Once episode 1 reached `ready`,
polled `GET /downloads` and confirmed episode 2 appeared automatically —
correct season/episode, quality matching `settings.defaultQuality`,
`sourceKind: "magnet"` (no debrid account configured in this run), and a
real magnet URI built from the fake addon's `infoHash`. All 12 checks
passed.

### Deferred / not done in P10

- Season-boundary crossing only works when a registered addon implements
  the `meta` resource for the series — see the gotcha-adjacent note above
  in "Built". Many popular stream-only addons don't; Cinemeta does, so
  registering it alongside a stream addon is the practical workaround, not
  yet automated (no addon is auto-registered by default).
- No `wifiOnly` gating on auto-download — CLAUDE.md's locked-in deployment
  decision (§2) means "Wi-Fi-only" is evaluated against the *server's* own
  interface, which for an always-on wired NAS/Pi is essentially always
  "connected"; wiring the check through was judged not worth the code for
  a setting that can't meaningfully differ in this deployment model.
- Quality selection is single-shot per addon (first usable stream matching
  `settings.defaultQuality`, else first unknown-quality stream) — doesn't
  rank across *all* addons' candidates by quality/seeder-count/etc. the way
  a human manually picking a stream might; reasonable for an unattended
  background trigger, not a substitute for the (still-unbuilt) manual
  `GET /resolve?stremioId=&type=` browsing endpoint CLAUDE.md §8 also
  lists.
- `GET /resolve?stremioId=&type=` itself is still not built — P10's
  CLAUDE.md description scopes it specifically to auto-download, not to a
  manual "browse available sources" flow. `resolvers/addonClient.ts` is
  already the right module to build that on top of when it's needed.

## P11 — Resume playback: done. This closes out CLAUDE.md's P0–P11 build order

CLAUDE.md §10 names this exactly: *"`lastPositionSeconds`, correct
`videoHash`/`videoSize`/`filename` in `behaviorHints` so Stremio's own
resume recognizes the session."* `lastPositionSeconds`/`watched` have
existed as DB columns since P0 and been *read* by P8's auto-delete sweep,
but nothing could ever *write* them from a real playback session until
now — P8's own PROGRESS.md entry flagged this gap directly: *"Auto-
delete's `watched` trigger is untestable through a real client flow until
P11 adds the progress-reporting endpoint."*

### Built

- `media/videoHash.ts` — `computeVideoHash`, the classic OpenSubtitles/
  Stremio 64-bit file hash (file size + sum of the first and last 64KB as
  little-endian 64-bit words, wrapped mod 2⁶⁴). This is *not* the P7
  subtitle-lookup mechanism (that's IMDb-id search, unrelated) — its only
  purpose is letting Stremio's client recognize "this is the same file I
  was already playing" across requests/sessions. Returns `null` for files
  under 128KB — the reference algorithm has no defined behavior below
  that floor. A real movie/episode is always far larger; the floor only
  ever matters for this repo's own tiny synthetic test fixtures (which
  therefore get `video_hash: NULL`, handled as a normal, expected case
  everywhere downstream, not an error).
- `shared/types.ts` / `schema.sql` — `DownloadItem.videoHash` /
  `.videoSize`, `download_items.video_hash` / `.video_size`. Following this
  project's established convention (no migration runner exists —
  `schema.sql` is the single source of truth, same as every prior phase
  that added columns).
- `queue/remuxRunner.ts` — computes both, from the **published** file
  (after the atomic rename, not the pre-rename staging path) — so a hash
  ever recorded on a row always matches what `/files/:id` actually serves.
  Threaded through `markReady`'s patch, which now requires them (there's
  no partial-ready state where a file exists but wasn't hashed).
- `db/downloadItems.ts` — `recordProgress(db, id, {positionSeconds,
  durationSeconds})`: updates `last_position_seconds`/`last_watched_at`
  unconditionally, and flips `watched` to `1` once `positionSeconds`
  crosses 90% of the supplied `durationSeconds` — a common "close enough
  to done" threshold (end credits, etc.) — via a single `CASE WHEN`
  clause that only ever sets `watched`, never clears it (rewinding after
  finishing must not un-mark a title as watched, or P8's auto-delete-
  after-watch sweep would un-eligible a title the user already finished).
- `api/downloads.ts` — `POST /downloads/:id/progress` (CLAUDE.md §8:
  "player reports position"). Note on scope: Stremio's *built-in* player
  has no protocol hook to call this automatically — the addon/companion-
  service split (CLAUDE.md §1) means Stremio manages its own local resume
  state independently. This endpoint exists for whatever *does* have
  positionSeconds to report (a future in-dashboard player, an external
  script, a browser extension) — built to spec now so P8's watched-based
  auto-delete has a real, working trigger, rather than staying permanently
  untestable through any real client flow.
- `addon/src/protocol.ts` — `StreamBehaviorHints` gained `videoSize`/
  `videoHash`. `addon/src/repository.ts` — `DownloadItemRow` gained the
  same two columns. `addon/src/handlers/stream.ts` — fixed a real (if
  minor) pre-existing bug along the way: the `ready` stream entry's
  `behaviorHints.filename` was set to `row.title` (a display string like
  `"The Matrix"`, no extension) instead of the actual served file's
  basename (`"The Matrix (1999).mp4"`) — CLAUDE.md explicitly calls out
  "correct `filename`", and Stremio's file-identity matching needs the
  real one. `videoSize`/`videoHash` are only added to `behaviorHints` when
  present on the row (omitted, not sent as `null`), matching this
  codebase's general `exactOptionalPropertyTypes` convention of "if (x)
  obj.field = x" throughout.

### Tests

15 new (248 service + 13 addon total): `media/videoHash.test.ts` — the
most important cases are the ones that verify the algorithm against
values computable independently of the implementation (a zero-filled
131072-byte file hashes to its own size in hex, since both chunk sums are
zero — not a value derived by calling the function under test itself),
plus sensitivity checks (changing one byte in the head or tail chunk
changes the hash; changing a byte strictly in the middle of a 4-chunk-
sized file does not); `addon/src/handlers/stream.test.ts` (new file — the
addon package's stream handler had no dedicated test file before this)
covers the filename-basename fix, videoHash/videoSize present vs. omitted,
and the `filePathWebReady`-missing fallback; `api/downloads.test.ts`
extended with 6 `POST /downloads/:id/progress` cases including the
never-un-marks-watched behavior specifically.

### End-to-end verification performed

Booted the real compiled service, accepted the legal notice via `POST
/configure/accept` (required before the addon surface returns anything),
and downloaded a **real ffmpeg-generated fixture sized to exceed 128KB on
purpose** (the repo's other test fixtures are deliberately tiny and would
have exercised the `null`-hash path instead) through the full real
download → remux → verify → publish pipeline. Confirmed: a real 16-hex-
character `videoHash` was computed and `videoSize` matched the actual
published file's byte size on disk; `GET /stream/movie/:id.json` (the
real addon endpoint, not a direct DB read) surfaced both correctly in
`behaviorHints`, with `filename` ending in `.mp4` and matching neither the
display title nor a placeholder; `POST /downloads/:id/progress` correctly
left `watched: false` below the 90% threshold, flipped it to `true` on
crossing it, and — the case most worth checking for real — stayed `true`
after a subsequent rewind to the start. All 12 checks passed.

### Deferred / not done in P11

- No client actually calls `POST /downloads/:id/progress` yet — there's no
  in-dashboard video player (P9's dashboard is a management UI: download
  list + settings, not a playback surface) and Stremio's own built-in
  player has no hook to call an addon's custom endpoints during playback.
  The endpoint is real, tested, and E2E-verified against a client that
  simulates one, but nothing in this repo calls it during actual use yet.
- `lastPositionSeconds` isn't surfaced anywhere in the dashboard UI (no
  "resume from 12:34" affordance) — P9's `DownloadCard` was built before
  this field had any real writer; revisit once something reports progress.
- The OpenSubtitles-style hash is unverified against Stremio's actual
  client-side resume-matching behavior (no way to drive real Stremio
  client software from this environment) — the algorithm itself is
  verified correct against independently-computable values (see Tests
  above), but "Stremio's own resume recognizes the session" per CLAUDE.md's
  phrasing is an integration claim this repo cannot fully close the loop
  on without a real device, same category of gap as the acceptance matrix
  in CLAUDE.md §9 generally.

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
- **`@fastify/websocket` plugin registration ordering (P9, cost real debugging
  time)**: `app.register(websocketPlugin)` immediately followed, in the same
  synchronous tick, by `app.get(path, { websocket: true }, handler)` typechecks
  and boots fine but silently registers a *plain* HTTP route — the plugin's
  `onRoute` hook that rewrites the handler to `(socket, request)` isn't attached
  yet when `.get()` runs, so a real client connecting gets a `500` with
  `socket.send is not a function` internally. Only shows up when something
  actually connects — unit tests that `await app.register(websocket)` themselves
  before calling the route-registering function can accidentally use a different
  (working) sequencing than production and pass while the real app is broken.
  Fix: `app.register(websocketPlugin); app.after(() => { app.get(...) });` —
  `.after()` sequences correctly *without* creating a new encapsulation context
  (a nested `app.register(async (instance) => ...)` also fixes the ordering but
  moves `injectWS`/`websocketServer` onto the inner instance instead of `app`).
  See `service/src/api/wsProgress.ts` docstring and the P9 section above for the
  full story. **Lesson**: for any WS/streaming route, verify with a real client
  against the real running service — `.inject()`-only tests can lie if they set
  up plugin registration differently than `app.ts` does.
- **Only pin `@fastify/*` plugin majors after checking their `fastify-plugin`
  peer version** — `npm view <pkg> dependencies.fastify-plugin` should show
  roughly `^4.x` for this project (Fastify 4). Latest majors of
  `@fastify/websocket` and `@fastify/static` both target Fastify 5 and fail loudly
  at boot (`FST_ERR_PLUGIN_VERSION_MISMATCH`) if installed without checking first.

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
