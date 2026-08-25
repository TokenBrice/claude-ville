# Design Decisions

Short decision records for load-bearing constraints in ClaudeVille. Each entry states what was decided, why, the code reference, and what to update if the decision changes.

## Port 4000 is hardcoded

`claudeville/server.js` defines `const PORT = 4000;`. The README, both `CLAUDE.md` files, and `AGENTS.md` reference it as fixed.

The local-first design assumes one user, one machine, one server. Making the port configurable would force the docs and every local workflow to learn how to discover it. A constant is simpler and matches user muscle memory.

The server binds `127.0.0.1` rather than every interface. HTTP requests require a local `Host`; browser origins must match that host, and WebSocket upgrades use the explicit same-origin `/ws` path. ClaudeVille intentionally has no LAN mode, CORS surface, or authentication layer.

If you change this, update: `claudeville/server.js`, README, both `CLAUDE.md` files, `AGENTS.md`, and `docs/troubleshooting.md`.

## Dependency-free runtime, no build step

`package.json` declares no runtime `dependencies`. The server uses only Node built-ins (`http`, `fs`, `path`, `crypto`, `https`, `child_process`, `os`). The frontend is plain HTML, CSS, and ES modules served as-is.

This makes the dashboard clone-and-run on any machine with Node 18+. There is no install step for `npm run dev`, no bundler config to maintain, no JSX, no TypeScript, no module aliasing, and a typo in any browser module breaks page boot at runtime.

The repo does have `devDependencies` for sprite validation, screenshot capture, and visual diffs (`js-yaml`, `pngjs`, `pixelmatch`, `playwright`). Those are development tools, not runtime requirements.

If you change this, update: `claudeville/CLAUDE.md` (runtime/development dependency split), `docs/troubleshooting.md` (syntax-check and sprite-tool guidance), and add the relevant install/build steps to README.

## Vanilla ES modules in the browser

The frontend uses `<script type="module">` and relative-path `import`s. There is no bundler.

Same rationale as the previous entry. The constraint this places on the frontend: no JSX, no path aliases, no automatic vendoring of third-party libraries. If a third-party module is needed, vendor a single ES-module file under `claudeville/src/` and import it relatively.

If you change this, update: `claudeville/CLAUDE.md` and the boot path described in `src/presentation/App.js`.

## Read-only adapter contract

The provider session files in `~/.claude/`, `~/.codex/sessions/`, `~/.gemini/tmp/`, `~/.grok/sessions/`, `~/.kimi/`, and `~/.local/share/opencode/opencode.db` are owned by the upstream CLIs. ClaudeVille adapters open them for reading only. OpenCode support uses read-only SQLite access through `node:sqlite` when available and falls back to `sqlite3 -readonly`; it does not write migrations, checkpoints, vacuums, or config changes. `claudeville/CLAUDE.md` states: "Treat all provider session files as read-only inputs" and "Do not mutate local CLI session files."

The CLIs append to these files concurrently and may change their format in any release. Writing back would create races and version drift. The dashboard's correctness depends on never being a second writer.

If you change this, update: every adapter under `claudeville/adapters/`, `claudeville/CLAUDE.md`, and add a clear ownership story in README.

## The quota API is the only outbound network exception

`claudeville/services/usageQuota.js` makes one deliberate outbound request: Node's `https.request` sends an authenticated `GET` to `api.anthropic.com/api/oauth/usage` when Claude OAuth credentials include both a subscription type and access token (`claudeville/services/usageQuota.js:282-304`). This is an exception to ClaudeVille's otherwise loopback-only serving and local-data model; it is not a hosted proxy or a general network surface.

The request is attempted at most once per `QUOTA_API_TTL` interval, which is `5 * 60_000` (5 minutes). Only an HTTP 200 response is parsed, and the production response accumulator destroys a body once it exceeds `QUOTA_RESPONSE_MAX_BYTES` (`256 * 1024`, or 256 KiB). The request timeout is 5 seconds (`claudeville/services/usageQuota.js:24-26`, `253-279`, `282-302`). A valid response with at least one usable quota window updates the snapshot; malformed, non-200, oversized, and network-failed requests do not. Network errors are intentionally ignored: a failed attempt does not clear an older successful snapshot, and the timestamp gate delays another attempt until the next 5-minute interval. An existing successful snapshot remains available while `Date.now() - lastSuccessTs <= QUOTA_MAX_STALE_MS`, which is `30 * 60_000` (30 minutes); after that, `fetchUsage()` reports `quotaAvailable: false` and null `fiveHour`/`sevenDay` values. Offline operation with no successful snapshot reports those quota values as unavailable immediately (`claudeville/services/usageQuota.js:304-320`, `332-356`).

This keeps quota telemetry useful without making the local dashboard depend on the remote service for its core operation. The retry interval limits background traffic, the response cap bounds remote input, and the stale cutoff prevents a frozen quota snapshot from looking current when the machine has been offline or the service is failing.

If you change this, update: `claudeville/services/usageQuota.js`, the local-only/proxy descriptions in `README.md` and `claudeville/CLAUDE.md`, the quota troubleshooting note in `docs/troubleshooting.md`, and this entry plus the loopback claim in the `Port 4000 is hardcoded` entry.

## 2-second polling on top of `fs.watch`

`claudeville/server.js` runs a dirty-driven 2-second scheduler. The scheduler attempts a broadcast when WebSocket clients are connected, but `broadcastUpdate` can no-op when no provider data is dirty and no heartbeat is due.

`fs.watch` events are unreliable across platforms (missing events, coalesced events, or no events at all on some filesystems). Polling is the backstop. Two seconds is short enough to feel live and long enough to avoid unnecessary work when the page is open but idle.

If you change this, update: `claudeville/CLAUDE.md` and `docs/troubleshooting.md`.

## `ACTIVE_THRESHOLD_MS` is 2 minutes

`claudeville/server.js` defines `const ACTIVE_THRESHOLD_MS = 2 * 60 * 1000;`. Sessions older than this are excluded from `/api/sessions`.

Two minutes makes the dashboard feel like "what is happening right now" rather than a session log. Longer windows fill the world with stale agents that no longer reflect anything the user is doing; shorter windows make the world flicker as the upstream CLI pauses between steps.

If you change this, update: `docs/troubleshooting.md` (the empty-sessions diagnosis).

## Static pricing estimates

The runtime pricing estimate is static. The browser app keeps synchronous pricing helpers in `claudeville/src/domain/value-objects/TokenUsage.js` because `Agent.cost` and Activity Panel rendering are synchronous ES-module code with no build step. Server-side session presentation uses `claudeville/src/config/model-pricing.json` to decorate `/api/sessions` with `estimatedCost`, `displayModel`, `modelColor`, and `spriteId`.

The dashboard does not have a billing API key or an authoritative price feed. Hardcoded estimates are good enough for the "is this run getting expensive?" question this UI answers. Prices change rarely.

If a price changes, update `claudeville/src/config/model-pricing.json` and `TokenUsage.js`; then validate `agent.cost`, Activity Panel rendering, and `/api/sessions`.

## Cache token normalization

Different providers report cache hits differently. The adapters normalize them into `cacheRead` and `cacheCreate` fields:

- Claude adapter (`claudeville/adapters/claude.js:253-254`) reads `cache_read_input_tokens` and `cache_creation_input_tokens` from each turn's `usage` and sums them.
- Codex adapter (`claudeville/adapters/codex.js:317-349`) reads `cache_read_input_tokens` / `cacheReadInputTokens` and `cache_creation_input_tokens`. Codex has no separate cache-create concept in some payloads, so `cacheCreate` is set to 0 in those branches.
- Gemini does not currently report cache tokens; the field is left at 0.
- Kimi reads cache token fields from legacy status updates and Kimi Code `usage.record` entries, then normalizes cache reads/creation into the same shape.
- OpenCode reads SQLite token totals for cache read/write; frontend token normalization treats cache write aliases as `cacheCreate`.

If a provider format changes, update only the relevant adapter. The frontend keeps using the normalized shape.

## English-only documentation and UI

The user-facing app exposes English UI strings only, and project policy keeps documentation and UI strings English. `claudeville/CLAUDE.md` defines the validation:

```bash
rg -n -P "[\\x{1100}-\\x{11FF}\\x{3130}-\\x{318F}\\x{AC00}-\\x{D7AF}]" $(rg --files -g '*.md' --glob '!node_modules')
```

The source-script scan exists because earlier revisions of the codebase mixed non-English copy with English. The rule is now uniform English. Run the scan after edits that touch user-visible copy.

If you change this, update: `claudeville/CLAUDE.md`, root `AGENTS.md`/`CLAUDE.md`, and `docs/README.md`.

## Hand-written WebSocket framing

`claudeville/server.js` implements RFC 6455 directly: the `/ws` handshake (`handleWebSocketUpgrade`), frame parser (`handleWebSocketFrame`), and frame builder (`createWebSocketFrame`). The handshake validates the local Host/Origin, version, and key; client frames must be masked, unfragmented, and free of RSV extensions.

The runtime no-dependencies rule rules out `ws` and similar packages. Browser clients only need text frames, ping/pong, and clean close, so a couple of hundred lines of framing code is cheaper than a runtime dependency.

If you change this, audit close handling, masking, and the 64-bit length path before swapping in a library.

## Multi-agent shared checkout

The repo is meant to be edited by several agents in parallel. Root `AGENTS.md`/`CLAUDE.md` define the workflow. The discipline:

- Run `git status --short` before and after edits.
- Do not revert or absorb unrelated changes.
- Do not run destructive git or shell commands without explicit approval.

This avoids accidental rollback when one agent integrates work and another is mid-edit.

If you change this, update: root `AGENTS.md`/`CLAUDE.md`, `claudeville/CLAUDE.md`, and `docs/README.md`.

## Polling cadence: 2s server scheduler, 2s panel

- Server scheduler: every 2 seconds; actual broadcasts are dirty-driven and no-op when there are no WebSocket clients.
- Activity panel detail fetch: every 2 seconds for the selected agent (`claudeville/src/presentation/shared/ActivityPanel.js:150`).

Server and panel stay near-live because both serve the active dashboard.

If you change any of these, also revisit `ACTIVE_THRESHOLD_MS` (the active-session window must stay strictly larger than the slowest poll, or sessions will visibly flicker in and out).

## BGM mode keeps event cues but drops reactive ambience

`BgmDirector` intentionally starts a `BgmPlayer` and `CueKit` instead of the `AudioDirector` layer set (`claudeville/src/presentation/shared/audio/BgmDirector.js:33-44`; `claudeville/src/presentation/shared/audio/AudioDirector.js:62-76`). BGM has no wind, rain, birds, crickets, village-hum, tonal-bed, or reactive music layers, and it does not subscribe to storm-flash thunder (`BgmDirector.js:1-6`; `AudioDirector.js:125-133`, `157-218`). It does retain event cues, including arrival, departure, distress, recovery, council, aurora, and the listener-focused summons (`BgmDirector.js:69-81`), along with the waking-hours hour bell (`BgmDirector.js:97-107`).

This is a deliberate mode distinction: continuous town music is the background in BGM mode, while discrete village and attention signals still need to ring over it. Weather and wildlife are reactive ambience layers, so restoring them in BGM mode would change the intended music-first soundscape rather than fix a missing event subscription.

If you change this, update: `claudeville/src/presentation/shared/audio/BgmDirector.js`, `claudeville/src/presentation/shared/audio/AudioDirector.js`, the mode description in `claudeville/src/presentation/shared/README.md`, and this entry.

## Domain layer must not import from presentation

`Agent.js` lives at `claudeville/src/domain/entities/`. It imports from `value-objects/` and `config/i18n.js` only. Shared logic used by both domain and presentation belongs under `src/domain/` or another lower layer, not under `src/presentation/`.

`TokenUsage.js` is the current example: the domain entity and Activity Panel can both import it without inverting the layering.
