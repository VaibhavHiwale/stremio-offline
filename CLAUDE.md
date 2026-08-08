# CLAUDE.md — Stremio Offline Download Manager
**This file supersedes all prior specs. Read it fully before writing any code.**
---
## 0. Non-negotiables
Five rules. Violating any one produces software that appears to work on the developer's
machine and fails silently for most users. Every one of these has already sunk a prior
attempt at this project.
1. **Every stream you serve is HTTPS + MP4 (H.264/AAC).** Not optional. See §3.
2. **Never emit `127.0.0.1` in any manifest, catalog, meta, or stream URL.** See §3.
3. **Every download must survive a hard kill -9 at any instant and resume correctly.** See §7.
4. **No phase is "done" until it passes on all four devices in the acceptance matrix.** See §9.
5. **Never write a partial file to the library path.** Download to `.part`, verify, rename. See §7.
---
## 1. What this is and why it doesn't exist yet
### The gap
Stremio's own site states that offline availability is an upcoming feature, and suggests
device caching as the current workaround. Their Help Center is blunter: downloading content
to watch offline isn't currently possible, though on desktop you can raise the cache size to
10GB and play what's cached without a connection.
Demand is long-standing and documented — `Stremio/stremio-features` issues #88 (2018), #188,
#630, and `stremio-shell` #452 are all open requests for exactly this. The requests are
specific: download from the Discover tab rather than mid-playback, download whole seasons
rather than one episode at a time, auto-download the next episode while binge-watching, and
keep playback inside Stremio instead of handing off to VLC.
**Build for those four complaints specifically.** They are the product requirements.
### Why the addon protocol alone can't do it
A conventional addon is a stateless resolver. Stremio asks "give me streams for
`tt1234567:1:2`", the addon returns URLs, Stremio plays one. There is no protocol verb for
"download this", no callback for progress, no way to inject UI, and no filesystem access.
A download manager needs persistent local storage, a lifecycle (queue → resolve → fetch →
remux → verify → serve → expire), and background execution. None of that is expressible in
`catalog`/`meta`/`stream`/`subtitles`.
So this is **an addon plus a companion service**, and the addon is the thin part. Stremio
already ships a precedent for this shape: the official local-files addon
(`Stremio/stremio-local-addon`) runs locally, scans the filesystem for video and torrent
files, associates them with IMDb IDs, and presents them to Stremio as a catalog. Read that
repo before designing yours — your naming and grouping conventions should match it.
### Prior art, and the specific bug to avoid
`broddo-baggins/offlinio` is the closest existing attempt. Its core architecture is right and
should be reused:
- download options rendered as *stream choices* (the only UI surface an addon has)
- live progress shown in the stream title (`Downloading… 45%`)
- completed downloads exposed as *catalogs*, giving an offline library on every platform
- debrid used as protocol translation: magnet → direct HTTPS URL
**Its fatal flaw:** it is built on `http://127.0.0.1:11471` and its README explicitly claims
users need no SSL certificates. By §3 Rules 1–3 that means it cannot work on iOS, iPadOS,
tvOS, Samsung Tizen or LG webOS, regardless of what its compatibility table claims. It is
also why it is absent from the community addon list — the list is populated by POSTing a
`transportUrl` to `api.strem.io/api/addonPublish`, and a loopback address is unpublishable.
This is not a missing feature. It is a transport-layer defect. Fixing it is the single
highest-value thing this project does.
Also read `sooti/sootio-stremio-addon`: a production addon that builds per-service catalogs
plus an "All Downloads" catalog so users browse their own downloads inside Stremio, and
computes `configurationRequired` dynamically from whether the user has configured a debrid
service. That is the config-in-URL + downloads-as-catalog pattern already working at scale.
### Scope and legality
This tool downloads only from sources the user's *own* configured addons and *own* debrid
account already resolve for them. It must never bundle scrapers, index or suggest content, or
touch DRM-protected material. It is infrastructure. Ship a mandatory first-run legal notice
that blocks all functionality until accepted, and a DRM detector that refuses encrypted
sources. Keep it source-agnostic.
---
## 2. Architecture
```
┌────────────────────────────────────────────────────────────────┐
│  ONE network-resident companion service (Docker / desktop / NAS)│
│                                                                 │
│  ┌──────────┐  ┌───────┐  ┌──────────┐  ┌─────────┐  ┌────────┐│
│  │ Addon    │  │ Queue │  │Downloader│  │ Remuxer │  │Storage ││
│  │ (thin)   │  │ engine│  │  (RD/HTTP│  │ (ffmpeg)│  │ mgr    ││
│  │          │  │       │  │  /torrent)│ │         │  │        ││
│  └────┬─────┘  └───┬───┘  └────┬─────┘  └────┬────┘  └───┬────┘│
│       │            └───────────┴─────────────┴───────────┘     │
│       │                          SQLite (WAL)                   │
│       │                     Filesystem (library)                │
└───────┼─────────────────────────────────────────────────────────┘
        │ HTTPS only
   ┌────┴─────┬──────────┬──────────┬──────────┬─────────┐
 Desktop   Android   Android TV   iPhone    Apple TV   Samsung/LG
 (server)  (server)  (server)   (NO server)(NO server) (NO server)
```
**The service runs once, on the network — never once per device.** Stremio's own local
streaming server (Stremio Service) does not exist on iOS, tvOS, Tizen or webOS. If Stremio's
team can't ship a local server there, neither can you. Any design where the downloader runs
on the playback device fails on over half the target platforms.
Android and desktop may co-host the service. That is an optimization, never the architecture.

**Deployment decision (locked in for this build): the companion service runs on a separate
always-on machine (NAS / Raspberry Pi / home server), not on the same device as Stremio.**
This means: no Wi-Fi-only detection tied to the playback device's radio state (the server is
presumed wired/always-connected — `wifiOnly` in `Settings` still exists as a user preference
but is evaluated against the *server's* network interface, not a phone's); storage-target
discovery only needs to enumerate the server's own mounted volumes (internal disk, external
USB/NAS shares), never Android's SAF/removable-storage APIs.
---
## 3. Hard protocol rules
### Rule 1 — Every stream must be web-ready
Per the SDK, `behaviorHints.notWebReady` must be `true` when the URL is not HTTPS or is not an
MP4. Non-web-ready streams *require a connected streaming server*, and clients sort web-ready
streams first, flagging the rest when no server is present.
The streaming server is absent on iOS/tvOS/Tizen/webOS. Stremio Lite shipped without it due to
App Store rules; Stremio Web on iPhone/iPad likewise runs without video conversion or torrent
streaming.
Therefore: **serve HTTPS, serve MP4 (H.264 + AAC, `-movflags +faststart`), and never set
`notWebReady: true` on your own local-playback streams.**
Implement a mandatory **remux stage** between download and library:
- H.264/AAC in MKV → `ffmpeg -i in.mkv -c copy -movflags +faststart out.mp4` (seconds, lossless)
- HEVC / 10-bit / AC3 / DTS / VC-1 → full transcode to H.264/AAC (slow; own queue state)
- Probe first with `ffprobe -v error -show_streams -of json` and decide per-stream, never guess
  from the file extension
Persist both `filePathOriginal` and `filePathWebReady`. Return the MP4 stream first; optionally
offer the original as a second entry labelled "Original quality (needs streaming server)" for
desktop/Android users.
### Rule 2 — HTTPS on the LAN is mandatory, and is the hardest part of this project
Only `localhost` may be served over plain HTTP — it is the sole origin browsers permit without
mixed-content errors. Anything on the LAN must be HTTPS. A feature request asking Stremio to
relax this for LAN addons exists and has not been granted.
Build `src/service/transport/certificate.ts` that tries, in order:
1. **Stremio's certificate API.** The server can request a real certificate from `api.strem.io`
   bound to a `*.stremio.rocks` subdomain for a given LAN IP. Reference implementation:
   `certificate.js` in `tsaridas/stremio-docker`. Convention: HTTP on 11470, HTTPS on 12470.
2. **Tailscale Funnel / Cloudflare Tunnel** — stable public HTTPS hostname, also works away
   from home. Covers iOS, Android, macOS, Windows, tvOS. Not Tizen/webOS (no client).
3. **Caddy + Let's Encrypt DNS-01** with the user's own domain. Document, don't require.
If all three fail, **fail loudly with an actionable error**. Never silently fall back to HTTP —
that is precisely how you ship something that only works on the developer's desktop.
### Rule 3 — Never emit a loopback address
Derive the externally-reachable base URL per request from the `Host` header or an explicit
`PUBLIC_BASE_URL`. Build every URL from that. Add a unit test that greps all generated JSON for
`127.0.0.1` and `localhost` and fails the build if found.
### Rule 4 — Don't rely on `proxyHeaders`
`behaviorHints.proxyHeaders` is not applied by the Stremio Web player, and it requires
`notWebReady: true`, which Rule 1 forbids. For authenticated file access use a **signed
query-string token** (`/files/:id?t=<hmac>&exp=<ts>`), which behaves identically everywhere.
### Rule 5 — The offline library is a `catalog`
Catalogs are pure JSON and render identically on a Samsung TV and an iPhone. Ship
`Downloaded Movies` and `Downloaded Series` catalogs plus a `meta` handler that groups
seasons/episodes. This is your entire library UI on every platform, for free. Support
`catalog` `extra`: `search`, `genre`, `skip`.
### Rule 6 — Stream entries are your entire UI
You cannot add buttons to Stremio. Return state-dependent stream entries instead:
| State | Stream name |
|---|---|
| not downloaded | `⬇️ Download for offline · 1080p` |
| queued | `🕐 Queued (position 3)` |
| downloading | `⏳ Downloading… 45% · 12 MB/s · ~4 min` |
| remuxing | `⚙️ Preparing for playback…` |
| ready | `▶️ Play offline · 1080p` |
| failed | `⚠️ Failed — select to retry` |
Return several simultaneously where relevant. Regenerate on every stream request.
The download trigger points at `/download/:id`. Hitting it enqueues the job and **returns a
short generated MP4 confirming the action** — never an HTTP error — so a user on a TV remote
with no dashboard gets visible feedback. Pre-generate these confirmation clips at build time.
### Rule 7 — Resolve via debrid first
Path: content ID → magnet (from the user's own source addon) → debrid → direct HTTPS URL →
download. Real-Debrid, AllDebrid, Premiumize, DebridLink, TorBox.
This matters for reliability, not just legality: debrid returns plain Range-capable HTTPS,
which is resumable, fast, and already satisfies Rule 1 far more often than torrent output.
Build `resolvers/` with one module per service plus auto-detection of what the user configured.
`webtorrent` stays as fallback for users without a debrid account — never the primary path.
### Rule 8 — CORS and Range everywhere
`Access-Control-Allow-Origin: *` on manifest, catalog, meta, stream, subtitles and files —
Stremio Web fetches these cross-origin from a browser. `Range` support on `/files/:id` is
mandatory or seeking breaks on every client. Return `206` with correct `Content-Range`, and
handle open-ended (`bytes=N-`), suffix (`bytes=-N`) and multi-range requests.
### Rule 9 — Subtitles via the `subtitles` resource
Sidecar `.srt` only works where the client can see the filesystem. Serve through the addon's
`subtitles` resource so it works uniformly, including on platforms with no streaming server.
Write sidecars *as well*, for Plex/Kodi/Jellyfin interop.
---
## 4. Reliability engineering
"Failproof" is not achievable; **crash-safe, restartable, and self-healing** is. Implement all
of the following. Most bugs users will hit live here, not in the happy path.
### Crash safety
- SQLite in **WAL mode**, `synchronous=NORMAL`, single writer connection. Every state transition
  is one transaction. Never hold app state only in memory.
- On boot, run a **reconciliation pass**: any row in `downloading`/`remuxing` was interrupted by
  a crash. Re-derive truth from the filesystem (does `.part` exist? what size?) and resume or
  requeue. The DB is a cache of filesystem reality, never the other way round.
- **Atomic publication**: download to `<target>.part`, verify, `ffmpeg` to `<target>.remux.mp4`,
  verify, then `fs.rename()` into the library path. `rename` is atomic within a filesystem. A
  file visible in the library is, by construction, complete and playable.
- Orphan sweep on boot: `.part`/`.remux` files with no DB row get deleted; DB rows with no file
  get marked `failed`.
### Resumability
- HTTP: persist `bytesDownloaded` after each flush; resume with `Range: bytes=N-`. **Validate
  the server honours it** — check for `206` and a matching `Content-Range`; if the server
  returns `200`, it ignored the range and you must restart from zero rather than append (a
  silent corruption bug).
- Store `ETag`/`Last-Modified` at start; if they change on resume, the remote file changed —
  discard and restart.
- Debrid links expire. On `403`/`404` mid-download, **re-resolve the link** and resume at the
  same byte offset rather than failing the job.
- Torrent: webtorrent handles pause/resume natively; map its states onto the same
  `DownloadStatus` enum.
### Verification
- Where the source supplies `Content-Length`, assert final size matches exactly.
- After remux, run `ffprobe` on the output and assert duration is within 1% of the source and at
  least one video and one audio stream exist. A zero-byte or truncated MP4 that Stremio fails to
  play is worse than a visible failure.
- Store `sha256` of the final file. Re-verify lazily on first playback after a restart.
### Failure handling
- **Exponential backoff with jitter** on all network operations: 1s, 2s, 4s… capped at 5 min,
  max 10 attempts, then `failed` with a human-readable `lastError`.
- Distinguish **retryable** (timeout, 5xx, 429, connection reset, DNS) from **terminal**
  (401 bad token, 402 debrid quota, 404 after re-resolve, DRM detected). Never burn retries on
  terminal errors; surface them to the user with a specific message.
- **Disk-full**: pre-flight check that free space ≥ expected size × 1.3 (headroom for remux)
  before starting. Re-check every 30s during download; pause the whole queue with a clear reason
  rather than filling the disk and corrupting SQLite.
- **Network loss**: pause, don't fail. Detect return of connectivity and auto-resume.
- Every job carries `attemptCount` and `lastError`; surface both in the dashboard and in the
  Rule 6 stream title.
### Idempotency and concurrency
- All queue mutations are idempotent by `DownloadItem.id`. Double-clicking "Download" on a TV
  remote must never create two jobs. Enforce with a `UNIQUE(stremioId, quality)` constraint.
- One global download semaphore honouring `maxConcurrentDownloads`. Remux is a *separate*
  semaphore sized to `min(2, cpus-1)` — ffmpeg transcodes will starve downloads otherwise.
- Graceful shutdown on `SIGTERM`/`SIGINT`: stop accepting work, flush byte counters, close
  SQLite cleanly. Docker gives you ~10s; use it.
### Observability
- Structured JSON logs (`pino`), levels, rotation, **no tokens or personal data in logs ever**.
- `GET /health` returns per-subsystem status: db, disk free, cert expiry, active jobs, ffmpeg
  present, debrid reachable. This is your primary support tool — make it genuinely diagnostic.
- `GET /diagnostics` renders a one-page self-test the user can screenshot into a bug report:
  resolves the public base URL, checks HTTPS cert validity, probes ffmpeg, and confirms the
  manifest is fetchable from outside localhost.
---
## 5. Tech stack
- **TypeScript** everywhere. `strict: true`. No `any` in `shared/`.
- **Service**: Node 20+, Fastify, `better-sqlite3` (synchronous, WAL, no async races).
- **Addon**: `stremio-addon-sdk`, or hand-rolled Fastify routes — the protocol is small and
  hand-rolling gives full control over caching headers and config-in-URL. Prefer hand-rolled.
- **Downloaders**: native `fetch` + streams for HTTP; `webtorrent` for magnets.
- **Media**: `ffmpeg` + `ffprobe` as child processes. Bundle static builds
  (`ffmpeg-static`, `ffprobe-static`) — never assume a system ffmpeg exists.
- **Subtitles**: OpenSubtitles API (user-supplied key), sidecar `.srt` + `subtitles` resource.
- **Dashboard**: React + Vite, served statically by the service, responsive, PWA manifest.
- **Packaging**: Docker (multi-arch: amd64 + arm64 for Pi/NAS) as the primary artifact.
---
## 6. Repo layout
```
/
  /shared/               # types.ts — single source of truth, no runtime deps
  /addon/
    manifest.ts          # config-in-URL, behaviorHints
    handlers/{catalog,meta,stream,subtitles}.ts
  /service/
    transport/           # certificate.ts, baseUrl.ts, tunnel.ts
    queue/                # scheduler.ts, reconcile.ts, semaphore.ts
    resolvers/           # realdebrid.ts, alldebrid.ts, premiumize.ts, torbox.ts, autodetect.ts
    downloaders/         # http.ts, torrent.ts
    media/               # probe.ts, remux.ts, verify.ts
    subtitles/
    storage/             # targets.ts, diskspace.ts, autodelete.ts, atomicWrite.ts
    db/                  # schema.sql, migrations/, client.ts
    api/                 # rest.ts, ws.ts, diagnostics.ts
    legal/               # notice.ts, drmDetect.ts
  /dashboard/            # React PWA
  /installer/            # static configure page → stremio:// deep link
  docker-compose.yml
  Dockerfile
  CLAUDE.md              # this file
```
---
## 7. Data model — write `shared/types.ts` first
```ts
type Quality = "480p" | "720p" | "1080p" | "1440p" | "4k" | "original";
type DownloadStatus =
  | "queued" | "resolving" | "downloading" | "paused"
  | "remuxing" | "verifying" | "ready" | "failed" | "cancelled" | "deleted";
interface DownloadItem {
  id: string;
  stremioId: string;              // "tt0903747:1:1"
  seriesId: string | null;        // for grouping
  type: "movie" | "series";
  title: string; year: number | null;
  season: number | null; episode: number | null;
  quality: Quality;
  sourceKind: "http" | "magnet" | "debrid";
  sourceUrl: string;
  sourceEtag: string | null;
  status: DownloadStatus;
  progressPct: number;
  bytesDownloaded: number; bytesTotal: number | null;
  speedBps: number | null; etaSeconds: number | null;
  storageTargetId: string;
  filePathOriginal: string | null;
  filePathWebReady: string | null;
  sha256: string | null;
  subtitleLangs: string[];
  attemptCount: number; lastError: string | null; retryableError: boolean;
  watched: boolean; lastPositionSeconds: number; lastWatchedAt: string | null;
  autoDeleteAfterWatch: boolean;
  priority: number;
  addedAt: string; completedAt: string | null;
}
interface StorageTarget {
  id: string; label: string; path: string;
  isRemovable: boolean; isDefault: boolean;
  bytesFree: number; bytesTotal: number; writable: boolean;
}
interface Settings {
  wifiOnly: boolean;
  defaultQuality: Quality;
  autoDownloadNextEpisode: boolean; autoDownloadLookahead: number;
  autoDeleteAfterWatch: boolean; autoDeleteAfterDays: number | null;
  maxConcurrentDownloads: number; maxConcurrentRemuxes: number;
  defaultStorageTargetId: string;
  subtitleLangs: string[];
  publicBaseUrl: string | null;
  legalNoticeAcceptedAt: string | null;
}
```
Library layout on disk (match the official local addon's conventions):
```
STORAGE_ROOT/
  Movies/The Matrix (1999)/The Matrix (1999).mp4 + .en.srt
  Series/Breaking Bad/Season 1/Breaking Bad S01E01.mp4 + .en.srt
  .offline/{db.sqlite, logs/, parts/, confirm-clips/}
```
---
## 8. API surface
```
GET    /:config/manifest.json
GET    /:config/catalog/:type/:id.json
GET    /:config/meta/:type/:id.json
GET    /:config/stream/:type/:id.json
GET    /:config/subtitles/:type/:id.json
GET    /configure                       # HTML config page
GET    /health          GET /diagnostics
GET|PATCH /settings
GET|POST  /addons                       # register source addon manifest URLs
GET    /resolve?stremioId=&type=        # available sources + qualities
POST   /downloads                       # idempotent enqueue
GET    /downloads  GET /downloads/:id
PATCH  /downloads/:id                   # pause | resume | priority | retry
DELETE /downloads/:id
POST   /downloads/:id/progress          # player reports position
GET    /storage/targets  POST /storage/targets  GET /storage/usage
GET    /download/:stremioId             # Rule 6 trigger → enqueue + confirm clip
GET    /files/:id                       # Range-enabled, signed token
WS     /ws/progress
```
---
## 9. Acceptance matrix — the definition of done
No phase ships until the **same manifest URL** installs and a downloaded file plays on:
| # | Device | Streaming server? | What it proves |
|---|---|---|---|
| 1 | Stremio Desktop | yes | baseline |
| 2 | Stremio Android | yes | LAN reachability |
| 3 | Stremio Web, Safari on iPhone | **no** | Rules 1–3 (HTTPS + MP4) |
| 4 | Samsung or LG TV | **no** | Rules 1–3 without tunnels |
If it works on 1–2 only, Rules 1–3 are violated. Devices 3 and 4 are the actual test; 1 and 2
prove nothing about cross-platform correctness.
**Chaos tests, required before v1:**
- `kill -9` mid-download → restart → job resumes at correct offset, file not corrupted
- Pull the network cable mid-download → job pauses → reconnect → auto-resumes
- Fill the disk mid-download → queue pauses with clear reason, SQLite uncorrupted
- Expire a debrid link mid-download → re-resolves and continues
- Enqueue the same title twice rapidly → exactly one job exists
- Reboot with 5 queued + 2 active → all 7 present and correct after boot
---
## 10. Build order
Work strictly in order. Run it, verify end-to-end (not just unit tests), commit, then proceed.
- **P0 Skeleton** — monorepo, `shared/types.ts`, Fastify, SQLite WAL, `/health`, Docker.
  *Gate:* container starts, health green.
- **P1 Transport (do this early, not last)** — `certificate.ts`, `baseUrl.ts`, the loopback
  grep test, CORS, Range-enabled `/files/:id` serving a hand-placed MP4.
  *Gate:* full acceptance matrix passes for that one hand-placed file. **Do not proceed until
  device 4 plays it.** Everything downstream is worthless if this is wrong.
- **P2 Addon surface** — manifest with config-in-URL, catalog + meta + stream handlers reading
  from SQLite, `/configure` page.
  *Gate:* hand-inserted DB row appears as a catalog item and plays on all 4 devices.
- **P3 Download core** — HTTP downloader, atomic `.part` → rename, resume, verification,
  reconciliation on boot. *Gate:* the six chaos tests above.
- **P4 Remux pipeline** — probe, copy-remux vs transcode decision, separate semaphore,
  post-remux ffprobe verification. *Gate:* an HEVC/MKV source plays on device 3.
- **P5 Queue** — scheduler, priority, concurrency, pause/resume-all, idempotency constraint.
- **P6 Resolvers** — debrid modules + autodetect + link re-resolution on expiry; webtorrent
  fallback.
- **P7 Subtitles** — OpenSubtitles search, sidecar write, `subtitles` resource.
- **P8 Storage** — targets, disk-space guards, external SD/USB, auto-delete rules.
- **P9 Progress + dashboard** — WS broadcast, React PWA, diagnostics page.
- **P10 Episode auto-download** — `addonClient.ts` queries registered source addons
  server-side for the next N episodes. Superset of P6; don't start it earlier.
- **P11 Resume playback** — `lastPositionSeconds`, correct `videoHash`/`videoSize`/`filename`
  in `behaviorHints` so Stremio's own resume recognizes the session.
**Defensible v1 = P0–P9.** P10–P11 are genuinely harder and depend on user setup; ship without
them rather than shipping them badly.
---
## 11. Distribution
Two tiers. Build both; they serve different users.
**Tier A — static installer page (build this first, zero infrastructure).**
A GitHub Pages form: user enters their service hostname → page renders a Stremio deep link.
Deep links work by taking a manifest URL and replacing `https://` with `stremio://`, so
`stremio://user-host:12470/manifest.json` installs in one tap on desktop, Android and iOS.
No listing, no servers, no cost.
**Tier B — public front-door addon (for catalog discoverability).**
A small public addon on a stable domain, listed via `api.strem.io/api/addonPublish`. Its
manifest sets `behaviorHints.configurationRequired: true`, which replaces Install with a
Configure button pointing at `/configure`. That page collects the user's own service hostname
plus optional debrid key and encodes them into the addon URL path
(`https://yourdomain/<config>/manifest.json`).
**The front door relays JSON only. Stream URLs it returns point directly at the user's own
service.** No media ever transits your infrastructure — no bandwidth cost, no liability.
Requires the user's service to be publicly reachable (Tailscale Funnel / Cloudflare Tunnel);
LAN-only users use Tier A.
Ship: multi-arch Docker image, `docker-compose.yml`, one-line install script, a README with the
acceptance matrix results, and a troubleshooting page built around `/diagnostics`.
---
## 12. How to work
1. Read this entire file before writing code.
2. **Deployment target: separate always-on machine (NAS/Pi/server) — confirmed.** Wi-Fi-only
   detection is evaluated against the server's own network interface, not a handset's radio.
   Storage-target discovery enumerates the server's mounted volumes only.
3. Update `shared/types.ts` first whenever a phase needs a new field, then propagate.
4. Write the chaos test *before* the feature it tests, for P3 onward.
5. Prefer boring, restart-safe, idempotent implementations over clever ones. This software must
   survive reboots, flaky Wi-Fi, expiring tokens, and full disks — that is the entire product.
6. Never mark a phase complete without running the acceptance matrix. "It works on my desktop"
   is the failure mode this document exists to prevent.
