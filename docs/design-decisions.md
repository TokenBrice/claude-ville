# Design Decisions

Short decision records for load-bearing constraints in ClaudeVille. Each entry states what was decided, why, the code reference, and what to update if the decision changes.

## Port 4000 is hardcoded

`claudeville/server.js` defines `const PORT = 4000;`. The README, both `CLAUDE.md` files, and `AGENTS.md` reference it as fixed.

The local-first design assumes one user, one machine, one server. Making the port configurable would force the docs and every local workflow to learn how to discover it. A constant is simpler and matches user muscle memory.

The server binds `127.0.0.1` rather than every interface. HTTP requests require a local `Host`; browser origins must match that host, and WebSocket upgrades use the explicit same-origin `/ws` path. ClaudeVille intentionally has no LAN mode, CORS surface, or authentication layer.

If you change this, update: `claudeville/server.js`, README, both `CLAUDE.md` files, `AGENTS.md`, and `docs/troubleshooting.md`.

## Push ingestion is optional, loopback-only and overlay-only

`POST /api/ingest/hook` accepts normalized lifecycle events from local CLI hooks. The server applies the same local Host/Origin validation as its other routes with `requireOrigin: false`, because a shell hook has no browser `Origin`; the `127.0.0.1` bind remains the network boundary. Set `CLAUDEVILLE_INGEST_TOKEN` to require the same value in `X-ClaudeVille-Ingest-Token`. Requests are capped at 256 KiB and their bodies are never logged.

The hook registry is not a provider and performs no discovery. It holds at most 256 sessions in process memory. Ordinary signals merge for 10 seconds and expire after 30 seconds; exact unanswered approvals become last-observed waits after the fresh window and remain until a resolving hook/newer recorded turn or a 30-minute bound. A fresh hook can escalate or refresh transcript state, but cannot suppress transcript-derived `awaiting_input`. Prompt detail is secret-stripped and capped at 200 characters before it reaches the session payload; nothing from the hook overlay is persisted.

Hook reception, merge-window changes and expiry refold cached normalized observations rather than invalidating adapters or reading transcripts. Provider freshness and cache timestamps stay unchanged; the zero-delay overlay path is independent of pending transcript backoff, while filesystem dirtiness and reconciliation still trigger ordinary provider observations (see `claudeville/CLAUDE.md`, *Server*).

ClaudeVille never creates or edits Claude Code, Codex, or other provider configuration. Operators may opt in by copying the examples in `docs/troubleshooting.md`; stopping or restarting ClaudeVille immediately falls back to transcript inference. Approval stays in the terminal: the dashboard deliberately has no approve action. OTLP ingestion is outside this route's scope.

If you change this, update: `claudeville/server.js`, `claudeville/adapters/hooks.js`, `claudeville/adapters/index.js`, `claudeville/CLAUDE.md`, `docs/troubleshooting.md`, and the hook overlay/security tests.

## Dependency-free runtime, no build step

`package.json` declares no runtime `dependencies`. The server uses only Node built-ins (`http`, `fs`, `path`, `crypto`, `https`, `child_process`, `os`). The frontend is plain HTML, CSS, and ES modules served as-is.

This makes the dashboard clone-and-run on any machine with Node 18+. There is no install step for `npm run dev`, no bundler config to maintain, no JSX, no TypeScript, no module aliasing, and a typo in any browser module breaks page boot at runtime.

The repo does have `devDependencies` for sprite validation, screenshot capture, and visual diffs (`js-yaml`, `pngjs`, `pixelmatch`, `playwright`). Those are development tools, not runtime requirements.

If you change this, update: `claudeville/CLAUDE.md` (runtime/development dependency split), `docs/troubleshooting.md` (syntax-check and sprite-tool guidance), and add the relevant install/build steps to README.

## Vanilla ES modules in the browser

The frontend uses `<script type="module">` and relative-path `import`s. There is no bundler.

Same rationale as the previous entry. The constraint this places on the frontend: no JSX, no path aliases, no automatic vendoring of third-party libraries. If a third-party module is needed, vendor a single ES-module file under `claudeville/src/` and import it relatively.

If you change this, update: `claudeville/CLAUDE.md` and the boot path described in `src/presentation/App.js`.

## Static text compression preserves byte validators

`claudeville/server.js` gzip-compresses CSS, JavaScript, MJS, JSON, HTML, YAML/YML, SVG, and webmanifest text when accepted; PNGs remain uncompressed. YAML/YML use `text/yaml; charset=utf-8`, and webmanifest uses `application/manifest+json; charset=utf-8`.

Strong identity/gzip ETags are distinct, byte equality validates cached content, and compressible responses carry `Vary: Accept-Encoding`. Versioned sprite/font URLs keep immutable caching; expanding text compression does not change their cache policy.

If this changes, update: `server.js` MIME/compression handling, static serving tests, and browser asset-cache troubleshooting.

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

The runtime pricing estimate is static. `claudeville/src/config/models.json` is the canonical model registry for pricing, context windows, mood tiers, and visual identity. `scripts/models/generate.mjs` commits matching ESM and CommonJS resolver modules so browser and server consumers keep synchronous helpers with no runtime build step; `npm run models:check` detects drift between the source registry and those committed outputs. The Claude table (revision 2026-09-01) was verified against the first-party pricing page (https://platform.claude.com/docs/en/about-claude/pricing, checked 2026-09-02): Fable 5.1 and Mythos 5.1 cache reads are $0.25/MTok (0.025x base input), unlike the 0.1x rule every other model uses, and Sonnet 5 is $2/$10 as the standard price (the page states the previously scheduled September 1, 2026 increase to $3/$15 "will not occur"). GLM 5.3 and GLM 5.3 Flash rates ($1.40/$4.40 and $0.15/$0.50 per MTok input/output, $0.26 and $0.03 cache reads) come from omp's bundled catalog cost table cross-checked against per-message `usage.cost` in real transcripts (verified 2026-09-02); both carry a 1M-token context window.

GPT-6 Astra uses the exact `gpt-6-astra` ID (including the registry's normalized and provider-qualified forms), a 1,050,000-token context window, and standard rates of $10 input, $50 output, $1 cache read, and $12.50 cache write per MTok, verified against [OpenAI's Astra model page](https://developers.openai.com/api/docs/models/gpt-6-astra) on 2026-09-05. The static estimate does not apply long-context or service-tier multipliers. Bare `gpt-6` and `astra` remain unknown models. Its silver/violet star-knight sprite keeps `max` and `ultra` distinct: low uses a crescent saber, medium a runeblade, high a dawnblade, and xhigh/max/ultra a polearm with their respective crests. Missing effort uses the crescent saber without an effort marker.

GPT-6 Sol, GPT-6 Luna, and GPT-6.1 Sol (registry rows `codex.gpt-6-sol`, `codex.gpt-6-luna`, `codex.gpt-6-1-sol`, revision 2026-09-30) match the normalized aliases `gpt-6-sol`, `gpt-6-luna`, and `gpt-6-1-sol`, so bare (`gpt-6.1-sol`), `openai/`-qualified, and OMP's `openai-codex/`-qualified IDs all resolve. Registry aliases are compared against the normalized model (dots and underscores become hyphens); only `gpt-5-N` is re-dotted, so any other dotted alias never matches. All three use a 1,050,000-token context window and standard per-MTok rates verified on 2026-09-30 against OpenAI's model pages: [GPT-6 Sol](https://developers.openai.com/api/docs/models/gpt-6-sol) $2 input, $10 output, $0.20 cache read, $2.50 cache write; [GPT-6 Luna](https://developers.openai.com/api/docs/models/gpt-6-luna) $0.10, $0.50, $0.01, $0.125; [GPT-6.1 Sol](https://developers.openai.com/api/docs/models/gpt-6.1-sol) $2, $10, $0.10, $2.50. The static estimate does not apply the >272K-input long-context multipliers. They reuse the GPT-5.6 identities: both Sols take the `gpt56sol` class and sun-warlord sprite with the dawnblade, Luna the `gpt56luna` class and sprite with the crescent saber, each with the celestial effort ladder. Codex's child-name variant inference (`inferCodexModel`) stays GPT-5.6-only: no observed Codex rollout under a GPT-6 parent carries a `sol_`/`terra_`/`luna_` agent path, and GPT-6 has no Terra, so a generalized rewrite would invent IDs rather than recover them.

DeepSeek V4.1 Flash (API id `deepseek-flash`, registry row `deepseek.flash`, revision 2026-09-10) uses the peak-hour rates from [DeepSeek's pricing page](https://api-docs.deepseek.com/quick_start/pricing): $0.30 input, $1.20 output, $0.006 cache read per MTok, 1M context. Off-peak (all hours outside Mon–Fri 01:00–04:00 and 06:00–10:00 UTC) is exactly half; the static estimate takes the upper bound rather than modelling the clock. The legacy `deepseek-v4-pro`, `deepseek-v4-flash`, and `deepseek-reasoner` rows are kept so old session cost history and fixtures still resolve, but they carry the same Flash rates because DeepSeek routes those ids to V4.1 Flash and bills at its price (V4 Pro from 2026-09-14). Their historical context windows are unchanged; the `deepseek` provider default now points at the Flash sprite and 1M context.

The dashboard does not have a billing API key or an authoritative price feed. Hardcoded estimates are good enough for the "is this run getting expensive?" question this UI answers. Prices change rarely.

If model data changes, update `claudeville/src/config/models.json`, regenerate both committed modules, and validate `agent.cost`, Activity Panel rendering, and `/api/sessions`.

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

The application delta protocol is versioned independently of framing. Only `{ type: 'hello', deltas: true, deltaVersion: 2 }` enables `update-delta`. RFC 6902 add/replace/remove patches target `sessionsById` and activity-ordered `sessionOrder`, plus `gitEventFields`, `gitEventStringTables`, `gitEventsById`, `collisions`, `teams`, and `usage`; full snapshots keep the `sessions` array. Missing, empty or duplicate session IDs, patches above 500 operations, a patch not smaller than the full state (or unavailable full-state size), and the 20-second full-snapshot floor select full updates.

Sequence gaps still request fresh init. A successful fresh resync establishes one canonical sequence: the requester receives `init`, existing peers receive the same state as a full `update`, and subsequent v2 deltas resume from it. An empty or unavailable forced init/resync collection cannot replace a known non-empty roster: the retained snapshot is marked scanning/stale, without erasing peer baselines. Client ingestion and incompatible-server downgrade behavior live in `claudeville/CLAUDE.md`, *Frontend Ownership*.

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

## The Town band carries no ambience; it plays along with the village (D4)

`BgmDirector` plays the music `Sequencer` continuously as the Town band. It has no sea, wind, rain, bird, cricket, murmur or workshop layers and no held note: a wait is carried by the waiting cadence (each phrase end turns deceptive while an agent waits and lands home after the answer). It keeps the event cues of the one engine-wide `CueKit` it shares with the `SignalDirector` — arrival, departure, the signal families, recovery, council, aurora, outcomes — and the waking-hours hour bell.

Decision D4 of the audio plan (Wave 6, item 6.9) amends what "no ambience" means: the band **plays along** with the village as *music*. Its percussion is the village at work — per building one Isle Band percussion voice (`PERCUSSION_VOICE`: brush, shaker, low tom, rim) on each piece's authored weight rows (one weight per sixteenth of a beat), admitted on the song grid when a seeded draw falls under the building's `WorkshopModel` density times the row's weight, only in the working bands that admit percussion, silent in a `rest` section and when nobody works. Weather and season re-dress the same tunes (softer attacks, a let-ring or glittering comp, the rain or snow percussion kit, a storm drone, more air; the season's cadence colour) as compile-time voicing variants (`music/Voicings.js`), switched at the next chunk boundary from the atmosphere snapshot and the `DayArc` keyframe. The band may follow the village, never imitate it.

Continuous town music is the background, while discrete village and attention signals still ring over it. The band's voice is the Isle Band by default; Chip restored is a one-click voicing (D2, `claudeville.sound.townBandVoice`, SET *Town band voice*), applied at the next chunk.

If you change this, update: `claudeville/src/presentation/shared/audio/BgmDirector.js`, `audio/music/Sequencer.js`, `audio/music/Voicings.js`, `audio/DayArc.js` (`arrangementKeyframeAt`), `audio/WorkshopModel.js`, `audio/bgm/ScoreKit.js` (`PERCUSSION_VOICE`), `SignalDirector.js`, `SoundSettings.js` and `SettingsPanel.js` (the voice), the mode description in `claudeville/src/presentation/shared/README.md`, and this entry.

## One music preset, a book of distinct pieces (v0.47.1)

The Village preset (mode id `ambient`: sea, wind, rain, wildlife, workshop voices, a held note under a wait, and music only at occasions) was retired in v0.47.1. The Town band was the preferred preset, and it already carries what the Village layers said: weather and time of day re-dress its arrangement, the workshops play as its percussion, and a wait turns its phrase ends deceptive. Presets are *Off · Signals · Town band* over the stored mode ids `signals | bgm`; Town band is the default when sound is on, and a stored `ambient` reads as `bgm` through `storedChoice`'s fallback, with no migration code. `AudioDirector` became `SignalDirector`, the signal route alone. Each preset has exactly one Volume: there are no MIX sliders (the Town band's one *Band* row duplicated Volume), and the music group fader sits at unity except in the D3 quiet mix.

Before v0.47.1 the book sounded like two tunes: every day piece had the same players over the same eighth-note arpeggio in A major and every night piece the same in A minor, because the arrangement followed the time-of-day keyframe, never the piece. Each piece is now one file (`audio/bgm/pieces/<name>.js`, `export default piece({...})`, importing only `audio/bgm/ScoreKit.js`; `audio/bgm/BgmSongbook.js` is the index and derives `PLAYLISTS` from each piece's `phases`) with its own `title`, `key`, `phases`, `arrangement`, `feel` (`straight`, `lilt`, `dotted`), `engine` (`arp8`, `arpQ`, `waltz`, `block2`, `jig`) and meter (4/4, 3/4 or 6/8), and the book grew from 11 to 19 pieces (11 day, 8 night). Arrangement precedence (`Voicings.voicingFor`): the keyframe row → the piece's `arrangement` (Isle Band only: its lead, counter, engine and descant replace the row's; the row's `bright` and `tempoScale` still apply) → the season (the cadence colour only) → the weather's re-dress on top. The weather never swaps a piece's players: rain, storm and snow change only softness, the comp's figure (`sustain`, `glitter`), the kit, the storm's drone and the air; its instrument swaps (rain's whistle, snow's music box, a harp comp) remain only where no piece arrangement applies (Chip, or no piece). At a night keyframe the whole piece darkens: every pitched seat of its arrangement plays at `NIGHT_BRIGHT` (0.5) times its brightness, and a harp or dulcimer is capped at `NIGHT_DARK_BRIGHT` (0.25). The night lead ceiling (A5) holds, and Chip stays keyframe-based. Block-chord engines (`block2`, `waltz`) on a held player (chip, bowed, reed, wind: `Sequencer` `HELD_KINDS`) strike each of n tones at vel/√(n·beats), so a sustained chord carries the energy of one one-beat tone; plucked and struck players keep the written velocity.

Keys: a piece may be written only in a key whose scale holds every fixed signal-cue pitch class, A and E (`SIGNAL_PITCH_CLASSES`; signal voices are never moved to the chord), so `ALLOWED_KEYS` is A, D or E major by day and A, D or E minor at night. The sequencer publishes each piece's key and sounding chord to the MusicClock, so routine cues sing its chord tones, and each piece's tag and waiting cadence are the A tables transposed (`cadenceKit(key, meter)`). The motif source (Willowbrook) and the stingers stay in A.

Rotation is a shuffle bag (`Sequencer`, C7): each round plays a phase's whole playlist once in a seeded order; a new round never opens on the piece that just played, a phase change opens a fresh round, and the six-minute no-return gap (four minutes below four pieces) and the hourly loop cap still apply. The popover's now line names the piece and its players (`Now · <title> · <lead> & <counter>`, named by `INSTRUMENT_LABELS`), not a loop count.

If you change this, update: `claudeville/src/presentation/shared/SoundSettings.js` (`SOUND_MODES`, `SOUND_PRESETS`), `AmbientAudioController.js` (`DIRECTOR_IDS`, `nowPlayingLine`), `TopBar.js` and `SettingsPanel.js`, `audio/bgm/ScoreKit.js` (`SIGNAL_PITCH_CLASSES`, `ALLOWED_KEYS`, `cadenceKit`, `piece`), `audio/bgm/BgmSongbook.js` and `audio/bgm/pieces/`, `audio/music/Voicings.js` (`NIGHT_BRIGHT`, `NIGHT_DARK_BRIGHT`), `audio/music/Sequencer.js` (the round, `nowPlaying`, `HELD_KINDS`), `audio/music/Instruments.js` (`INSTRUMENT_LABELS`), `scripts/audio/score-analyzer.mjs`, the `audio-score-analyzer`, `audio-sequencer`, `audio-voicings` and `sound-settings` tests, the audio rows in `claudeville/src/presentation/shared/README.md`, and this entry.

## Domain layer must not import from presentation

`Agent.js` lives at `claudeville/src/domain/entities/`. It imports from `value-objects/` and `config/i18n.js` only. Shared logic used by both domain and presentation belongs under `src/domain/` or another lower layer, not under `src/presentation/`.

`TokenUsage.js` is the current example: the domain entity and Activity Panel can both import it without inverting the layering.

## Finished villagers linger after the active roster drops them

`claudeville/src/application/AgentManager.js` defines `DEPARTED_AGENT_GRACE_MS` as `90 * 1000` (90 seconds) and `MAX_DEPARTED_AGENTS` as `100`. When a session disappears from a WebSocket update, the manager projects it to `AgentStatus.COMPLETED`, stamps `departedAt`, clears live-work and attention fields, and keeps it in the World until the grace expires (`AgentManager._sweepDepartedAgents`). Overflow is sorted by `departedAt` and evicted oldest-first (`AgentManager._evictDepartedOverflow`). `Agent.isDeparted` is a separate presence marker, not a new execution status; its working, idle, waiting, and fresh-tool getters return false for departed villagers (`domain/entities/Agent.js:151-163`).

The grace runs on a wall clock, so `AgentManager.startDepartureSweep()` re-checks it every `DEPARTED_SWEEP_INTERVAL_MS` (15 seconds) instead of only when a WebSocket update arrives. This is load-bearing rather than defensive: `broadcastUpdate()` returns early when the payload signature is unchanged (`claudeville/server.js`), so broadcasts stop the moment the last session goes quiet — which is exactly when the last villagers depart. Driving eviction off updates alone left them standing frozen in the village until the page was reloaded. A timer sweep only expires villagers that are already departed; only a roster update can mark a live one as departed.

This exists alongside `ACTIVE_THRESHOLD_MS`, not instead of it. The server's `ACTIVE_THRESHOLD_MS` remains `2 * 60 * 1000` (2 minutes) and controls which sessions are fresh enough to enter the server's live collection (`claudeville/server.js`). The 90-second grace begins when a completed session leaves the client-facing roster and controls visual residency in the World; the two stack, so a finished agent walks out roughly three and a half minutes after its last activity. Completed turns are deliberately not admitted to the server's 45-minute `SessionResidency`: stacking both lifecycles kept finished sessions visible for nearly an hour. Unresolved `tool_pending` sessions still receive backend residency so slow tools and permission prompts do not disappear while silent. The motivating case for the frontend grace was a 20-agent parallel fan-out whose short-lived agents aged out before the operator could see the fleet; the manager explicitly sizes the 100-agent cap to keep that burst visible (`AgentManager.js:9-14`).

The `COMPLETED` projection keeps compatibility with presentation and status counters. `World.getStats()` therefore does not count a departed villager in working, idle, waiting, errored, or attention buckets, and `AttentionService` only considers `WAITING_ON_USER`, `RATE_LIMITED`, and `ERRORED` attention statuses (`domain/entities/World.js:63-83`; `domain/services/StatusResolver.js:108-115`). The retained villagers do still contribute to `World.getStats().total` and its token/cost totals until eviction; “excluded from counters” means the live status/attention buckets, not every aggregate.

The grace is a data lifecycle, not a visual one. The moment an `agent:updated` flips a villager to departed, `IsometricRenderer._beginAgentDeparture()` starts its exit: top-level sessions walk to `VILLAGE_GATE.outside` and are disposed on arrival (`_beginAgentGateDeparture`, which marks the sprite `leaving`), subagents merge back into their parent, and orphans return to the Portal Gate (`_beginRelationshipDeparture`). The grey, frozen `isDeparted` tableau in `AgentSprite` (`departedTableau()` in `AgentGpuOverlayRenderer.js`) is therefore only a fallback for a departed sprite with no exit in flight; a departed villager never lingers as a ghost. `agent:removed` at grace expiry only catches a sprite that never left, and `_reconcileSpritesWithWorld` never spawns a sprite for an already-departed agent. A session that returns inside the grace re-arrives (sprite gone) or turns around mid-walk (`_returnFromGateDeparture`).

If this changes, update: `claudeville/src/application/AgentManager.js`, `claudeville/src/presentation/App.js` (sweep start/stop), `claudeville/src/domain/entities/Agent.js`, `claudeville/src/domain/entities/World.js`, `claudeville/src/domain/services/StatusResolver.js`, `claudeville/server.js`, the `ACTIVE_THRESHOLD_MS` and empty-sessions guidance above and in `docs/troubleshooting.md`, and residency tests.

## Git enrichment uses a bounded asynchronous stale-while-revalidate worker

The normal server path enables the Git worker through `configureGitEnrichmentWorker({ enabled: true })` (`claudeville/server.js:2307-2319`). Session enrichment returns the cached per-project snapshot immediately, then requests a refresh when the snapshot is absent, stale, or invalidated (`claudeville/adapters/gitEvents.js:2186-2222`). A successful refresh publishes only a changed, generation-current snapshot; a Git-head change during the job marks the completion stale and requests a rerun (`gitEvents.js:772-848`).

The bounds are deliberate: at most 2 active jobs, a 32-deep queue, and shedding when that queue is full (`gitEvents.js:63-92`, `854-921`). Requests for a project already queued, running, or inside its retry delay coalesce; a change observed during a running job sets a rerun flag instead of adding an unbounded duplicate (`gitEvents.js:889-907`). Each `git` child process uses a 750 ms timeout and a 256 KiB stdout buffer cap (`gitEvents.js:470-518`). Failures retry with exponential backoff from 1 second up to 30 seconds by default (`gitEvents.js:418-438`); the environment variables in the constants block can change those defaults, so the effective values are exposed in worker diagnostics.

Git-state invalidation and enrichment share bounded per-project ref-directory metadata snapshots in `gitEvents.js`: at most 128 projects with least-recently-used project eviction and a 6,400-entry per-project cap. Every probe validates directory identity and timestamps and reads fresh leaf metadata, so nested ref rewrites remain detectable without extra watchers. The five-second backstop, worker queue limits, signature values and ref traversal bounds are unchanged; oversized roots retain each consumer's original ordering and truncation behavior.

These limits respond to measured pressure, not theoretical neatness: the post-OOM performance audit recorded about 92,600 cumulative Git subprocess calls and 443 seconds of command time, including one nine-project refresh that launched 43 synchronous commands and blocked for about 151 ms. The worker keeps the hot server path asynchronous while retaining synchronous fallback helpers for worker-disabled or direct legacy paths (`claudeville/adapters/index.js:146-151`; `gitEvents.js:1651-1660`). Do not remove the bounds or mistake the fallback for the normal configured path.

Worker state and Git command rates are part of the manual performance surface at `/api/perf` (`claudeville/server.js:379-405`). The payload includes concurrency, queue depth, active subprocesses, refreshes, failures, retries, shed requests, coalesced requests, stale completions, and the last refresh/error fields (`gitEvents.js:952-991`).

If this changes, update: `claudeville/adapters/gitEvents.js`, `claudeville/adapters/index.js`, `claudeville/server.js`, `/api/perf` diagnostics, and the related performance troubleshooting notes.

## Cross-task event contracts are load-bearing

The application, audio, and shared presentation layers communicate through string-keyed `eventBus` events. These payloads are contracts, not incidental object shapes:

- `attention:raised` is emitted by `AttentionService` as `{ agentId, agent, reason, waitingCount, oldestWaitMs }` (`claudeville/src/application/AttentionService.js` `_raise`). The current payload also carries `status` and `label`. `SignalDirector` consumes the agent id and waiting summary to produce the listener-focused summons, while the Town band's `BgmDirector` listens to the same event; both route the voice from the agent's bucket through `shared/audio/ActionableRouting.js`, and `AmbientAudioController` opens the urgency ladder's wait on it.
- `audio:cue-played` is emitted by `CueKit` as `{ kind, agentId: null|value, label, at }` after the cue governor accepts a cue, plus the caption fields a cue carries (`CAPTION_FIELDS`: `count`, `level`, `family`, `oldestMs`, `hour`, `teamName`, `teamSize`, `repo`, `version`, `status`, `soundOnly`, `flock`, `clusterIndex`, `familyLine`) and `replaces` when a ceremony absorbs an announced aggregate (`claudeville/src/presentation/shared/audio/cues/CueKit.js` `_emitCue`). `Toast` consumes it for captions (`shared/Toast.js`, policy in *Captions exist from boot and follow one setting* below). The signal route that emits it is built at boot idle: `TopBar` constructs `AmbientAudioController` in the first idle slot (at most 4 s after boot) without creating an AudioContext, so captions and the shared cue score work from boot on a fresh profile with sound off, and the audio modules stay off the critical path. With an active AudioContext this is the cue that is synthesized; without one, the event still fires so accessibility captions do not depend on sound being enabled.
- `attention:digest` is emitted after an unattended return when Chronicle has a non-empty summary. Its top-level payload is `{ kind: 'unattended-digest', message, type, since, until, awayMs, summary }` (`claudeville/src/application/AttentionService.js`, `UNATTENDED_DIGEST_EVENT`). `Toast` consumes it as a longer-lived summary so return-time cue traffic does not erase the account of what happened while the operator was away; it is also the one caption of the sound-only return digest.
- `audio:recalibrated` is emitted once by `AmbientAudioController` as `{ message }` when the one-time D5 reset replaced a profile's stored sound levels with the standard step (`shared/SoundSettings.js` `recalibrateStoredSound`, which owns the copy and writes `claudeville.sound.calibration` last). `Toast` shows `message` as a plain notice (`shared/Toast.js` `showNotice`). A fresh profile is only marked calibrated and emits nothing.

The contracts keep the subsystems independently replaceable: attention detection does not know how sound or captions are rendered, CueKit does not know which UI presents a caption, and the digest producer does not depend on one Toast implementation. If a field is renamed, omitted, or changes meaning, update every emitter and consumer together, the event-focused unit tests, and this entry.

## The Mine states counts, never percentages

The token mine's cargo and assay bench report exact quantities — `8,192 input · 32,768 cache read · observed last 60s` — and never a share. The transient `NN% CACHE` label is gone (`LandmarkActivity.formatExactCount`, the assay-bench label builders, and `tokenItemTooltip` in `claudeville/src/presentation/character-mode/LandmarkActivity.js`; regression `scripts/tests/w11-cache-ore-ratio.test.mjs`). Spend on the bench is only ever a difference between two consecutive fresh, same-provenance observations of the same session; a counter reset or a provenance flip restarts coverage and the bench says so instead of computing across the gap.

A percentage hides both denominators this surface needs: a 90% cache share of 400 tokens and of 4,000,000 tokens are different facts, and provider-reported versus estimated cost are different provenance. The plan's guardrail ("counts, never percentages, in attention surfaces") became load-bearing here first; any new attention surface inherits it.

If you change this, update: `LandmarkActivity.js`, the mine cargo/assay drawing in `BuildingSprite.js`, `scripts/tests/w11-cache-ore-ratio.test.mjs`, and `docs/world-visual-qa-checklist.md`.

## A dashboard update is not a village release

The Harbor release parade answers only real release events. `VillageDirector.triggerReleaseParade` runs from `harbor:release-burst` and `chronicle:milestone` of kind `release` (`claudeville/src/presentation/character-mode/VillageDirector.js`); the former synthesized once-per-stored-version parade (`triggerReleaseParadeOnceForVersion`, which read the dashboard's own version string) was removed. Version discovery stays in the in-app changelog affordance; simulator release metadata and genuine tag-push milestones still parade.

The removed parade fired on every fresh headless context (`PARADE v0.44` on an empty island): a ClaudeVille update is shipped by the maintainer, not released by the operator's agents, and celebrating the former as the latter told a false story at the village's most visible landmark.

If you change this, update: `VillageDirector.js`, `docs/design-decisions.md` (this entry), and the `release-parade` QA scenario in `docs/world-visual-qa-checklist.md`.

## One instrument per fact

A signal gets exactly one visual encoding per surface: one on the body, one on the building, one in the DOM. When the frontier visual work replaced an existing cue it removed the old one in the same change — the authored `read` strip replaces the procedural book and wait question mark for characters that carry a strip (`AgentSprite._actionStripPose`), the C4 aperture is the only interior presentation (its identities and counts equal `BuildingInstrumentModel`'s, which renders each building fact once in the panel), and the exact-count mine trays replaced the percentage cargo label. `shared/BuildingInstrumentModel.js` is the canonical split: presence (visit test), signal (assigned WORKING sessions), queue, purpose — an unknown key on the payload is ignored rather than borrowed as a count or denominator.

Two encodings of one fact on one surface always drift apart, and the operator cannot tell which one is the truth when they disagree. The pure model files (`BuildingInstrumentModel.js`, `BuildingApertureModel.js`, `WorkWaterfallModel.js`, `ObservationCertainty.js`) exist so each fact has one derivable presentation instead of several re-derivations.

If you change this, update: the pure model, its consumers in `ActivityPanel.js`/`BuildingSprite.js`/`AgentSprite.js`, and the contract summaries in `claudeville/src/presentation/character-mode/README.md`.

## Ambient camera never re-arms on a timer

Ambient camera ownership is entered only through the explicit AMBIENT segment of the World dock's `FREE | AUTO | AMBIENT` control and, once revoked, is never re-acquired on a timer (`CameraDirector.setAmbient` and the `_ambient` scheduler state in `claudeville/src/presentation/character-mode/CameraDirector.js`; the control and its resume state in `App._initCameraModeControl`). Choosing AMBIENT is a standing choice (M8, `cv-ambient-standing`): it is reclaimed after the boot opening settles and on each return from Dashboard, and only picking FREE or AUTO clears it. Any genuine input — pointer-down, wheel, navigation key, selection — releases the claim at once; AMBIENT then wears a resume pip and waits to be asked again. The pre-existing automatic (`auto`) timers are unchanged and never run while an Ambient claim stands.

Timed re-takeover after manual input is the one behaviour that makes a broadcast feel like camera theft: the operator pans away, the village pulls the frame back. Ambient is a mode the operator knowingly lends the frame to, and lending ends when they touch it.

If you change this, update: `CameraDirector.js`, `App.js` (`#worldAmbient` wiring), the C6 summary in `claudeville/src/presentation/character-mode/README.md`, and the Ambient checks in `docs/world-visual-qa-checklist.md`.

## One dusk exposure contract, halos capped

Every consumer of motivated light reads one reviewed source-energy envelope — `SOURCE_ENERGY_BUCKETS` in `claudeville/src/presentation/character-mode/AtmosphereState.js` with buckets `daylight → settling → lamplight → deep-night`, each allocating `core >= spill >= bloom` and a `halo` area cap enforced with the absolute cap in `BuildingSprite`. `sourceEnergyEnvelope(minuteOfDay, weather, seasonShift)` picks the bucket from `GradeEvaluator.lampCourseAt`, the same minutes as the C2 grade keys, so at dusk the ambient falls first and the lamps take over second (21:00 is already deep night); heavy weather promotes the bucket by exactly one step, never past `lamplight`. Before the contract, `lightBoost`, `emissivePhase`, `beaconIntensity`, and `buildingGlowScale` each applied their own continuous boost and the products stacked, so dusk brightened four times over and the Lighthouse/Harbor halos outgrew the work they were lighting. Feeds authored without an envelope keep the neutral response (`NEUTRAL_SOURCE_ENERGY`), and action-needed overlays are outside this budget. The maintainer decision to accept a reduced Lighthouse/Harbor halo radius (the frontier plan's D4) is recorded in that plan's execution record.

Bloom energy that outranks the work it decorates inverts the scene's meaning: the busiest night looks like the emptiest one. One reviewed table with cores first is cheaper to reason about than four multiplied boosts, and it gives every Wave 3 effect a shared energy budget to substitute within rather than add to.

If you change this, update: `AtmosphereState.js` (`SOURCE_ENERGY_BUCKETS`, `sourceEnergyEnvelope`, `sourceEnergyFor`), `GradeEvaluator.js` (`lampCourseAt`), the halo caps in `BuildingSprite.js`, `gpu/GpuWorldPolicy.js` (the `exposure-envelope` receipt prices saved time), `scripts/tests/dusk-exposure-contract.test.mjs`, and `docs/world-visual-qa-checklist.md`.

## One grade evaluator for the whole world (aesthetic plan C2)

The island's time of day and weather come from one pure function, `evaluateGrade` in `claudeville/src/presentation/character-mode/GradeEvaluator.js`: eight daily keyframes (deep night, pre-dawn, sunrise, morning, noon, golden hour, blue hour, night) interpolated by minute, a weather row (rain, storm, overcast, fog: saturation multiplier, cool tint, flattened sun band), the moon at night, and a seasonal sunrise/sunset shift. It is memoized per atmosphere snapshot as `atmosphere.lightGrade` and read by the resident scene shader (`GRADE_GLSL`), the hybrid PostFx pass, the Canvas fallback (`CanvasGrade.js`), the sky and backdrop, water mood, fauna tint, casts, and chimney smoke. It never reads agent state. Exposure never falls below `GRADE_EXPOSURE_FLOOR`, so no night is pitch black.

Before this, the resident renderer skipped the atmosphere pass and multiplied the island by one of six constant per-phase rows, so noon and 22:00 had the same saturation and weather changed nothing. The grade runs on each albedo fragment before the light loop, and stepped multiplicative pools plus authored emission are added after it, so lit pixels keep their colour at night without a separate lit mask. Night is moonlit, not grey. The first shipped night (albedo saturation near 0.08, then 0.22) read as a dark monochrome wash; after maintainer feedback it was rebalanced twice. Night now keeps about 40 % of albedo colour (saturation 0.42, deep night 0.38; exposure 0.74 and 0.66) and carries the moonlight in the split tone — indigo shadows `[0.84, 0.94, 1.10]`, faint blue-green highlights `[0.94, 1.03, 1.03]`, gain `[0.86, 0.94, 1.00]` — so grass stays green-teal, stone reads slate-blue, and water blue, while lamp pools stay small warm accents. The rule `scripts/tests/gpu-world-policy.test.mjs` checks on representative albedo colours is: night exposure below 0.8× noon, night saturation 0.5–0.85× noon, and night bluer than noon (mean R−B below noon's). `GRADE_AMBIENT_FLOOR` keeps the effective ambient of a storm night one course above black, and each key carries its own `rake` (cast length), so a rosier sunrise did not cost the long dawn casts. The rain and storm saturation multipliers are 0.74 and 0.62.

If you change this, update: `GradeEvaluator.js`, `GRADE_GLSL` in `gpu/GpuWorldPolicy.js`, `CanvasGrade.js`, `scripts/tests/gpu-world-policy.test.mjs`, `scripts/tests/dusk-exposure-contract.test.mjs`, and the grade notes in `character-mode/README.md`.

## One pixel grid; villagers at integer 1:1 (aesthetic plan C3, D1)

Every world sprite draws at an integer multiple of the world texel at every crisp zoom tier, with no open exceptions since Waking Isle 3.8 (Harbor hulls are roll strips baked at scale 1, `prop.flowerCart` draws at 1×, held weapons are baked frames; `scripts/sprites/texel-transform-check.mjs` fails any `ctx.rotate` or non-1 `ctx.scale` in ship or weapon drawing): villagers and trees at 1×, effects, glyphs, and ground cues on the art-pixel grid, and the retained ground-cue texture at scale 1 or exactly 0.5 (`semanticGroundScale`). The maintainer approved shrinking villagers from 82–120 to 48–75 world px (D1). Crowd pressure uses a baked 0.5× majority-vote LOD sheet (`Compositor.halfScaleSheet`) instead of minifying bodies to 28 world px. Resting frames are integer-k nearest; flight frames are fat-pixel (Waking Isle 4.6, M4): a camera glide is one continuous log-zoom dolly (`CameraCurves.js`) that lands on a resting tier, and while the camera moves (or k is fractional) the resident scene pass area-samples every texel, so a pixel a texel seam crosses blends the two adjacent authored colours and no texel renders 2 px wide beside a 3 px one. The earlier rule (pan at a resting tier, 450 ms zoom steps, at least 75 % of every glide pixel-exact) is retired with it: nearest sampling at fractional k had made texels crawl through every zoom move, and fat pixels at rest would blur, so they never run on a resting frame. The resting frame tier is 3 because 2.5 alternates 2- and 3-pixel texels.

Three pixel densities had coexisted (villagers at 1.32–1.65×, large trees at 2×, clean 1-px buildings), so nothing on screen agreed on what a pixel was. A new per-frame cost must be baked, substitute for an existing cost, or carry an `EFFECT_BUDGET` receipt with a ladder tier.

If you change this, update: `AgentSprite.js`, `Compositor.js`, `FoliageRenderer.js`, `Camera.js`/`CameraCurves.js`, `WorldFrameRenderer.semanticGroundScale`, and the C3 notes in `character-mode/README.md`.

## Master palette and the brightest-thing rule (aesthetic plan C1, D5)

`claudeville/src/config/artPalette.js` holds the named ramps (void, deep and shallow water, grass, dirt, road, plaza, sand, foliage, stone, timber, slate, cloth, reserved emissive), the status-free `PENNANT_PALETTE`, and `EFFECT_COLORS`; status hues stay canonical in `theme.js`, and `artPalette.js` may import `theme.js` but never the reverse. Only unresolved status marks, the selected-agent ring, and authored emission at dusk and night may reach Tier A (L > 0.70 or S > 0.65). Water and void stay at S ≤ 0.40, and the ground sits at a moderate mute (D5: pooled median saturation 0.45–0.50) so grass stays green. `npm run art:analyze` reports colour counts, semi-alpha edges, Tier-A misuse, off-ramp terrain, the ground band, and non-integer display scales; it is advisory and always exits 0. Building, provider, and team accents in `theme.js` were repainted onto painted hues at least dE_OK 0.072 from every status hue, so no identity colour reads as a status. Rate-limited moved from slate `#8fa6bd` (hue 210°, nearly the idle blue) to the orchid `#f06ae0` (hue 307°, Tier A), and the World's quota and rate-limit incident colours follow it. `PENNANT_PALETTE` was re-spaced to eight hues at least 35° apart (HSL 340/18/62/100/155/192/227/265, OKLab ΔE ≥ 0.10 from every status hue, ≥ 0.085 between siblings), and `RepoColor.js` resolves hash collisions among the repos on screen through one shared registry, so sibling repos never share a pennant. After a noon review read as dusk, the water and grass ramps were lifted: deep water `#222d33 #31424a #3f585e`, shallow `#4a6c70 #669190`, grass `#26572d … #7f9e51` (albedo S 0.49–0.56, so the graded noon frame lands near S 0.46); at WebGL zoom 1 noon, water measures V 0.31 / S 0.375 and grass V 0.365 / S 0.46.

Measured before the change, the ground (median S 0.61) was the loudest thing on screen and several accents sat within a hair of status hues. The strict S ≤ 0.40 ground mock read grey and was rejected in favour of the moderate mute.

If you change this, update: `artPalette.js`, `theme.js` (accent/provider/team/incident tables and the de-collision comment), `scripts/sprites/art-analyze.mjs`, `GroundBake.js`, `CoastBake.js`, `shared/RepoColor.js`, and `scripts/smoke/theme-tokens.mjs`.

## The ground and sea are one bake (aesthetic plan 3.2–3.5, D5)

Land is baked by `GroundBake.js` (terrain pass `ground-splat`) from a class field with organic edges, re-toned onto the C1 ground ramps, with macro drift, contact AO, worn thresholds, yard materials, and sparse decals; the Wang sheets remain only as luminance textures sampled in true 2:1 orientation (`TerrainTileset.readTerrainCellLuma`). Water and coast come from one sub-tile signed-distance field (`CoastBake.getCoastField`) baked into wet sand, foam lace, and five depth stops, with a land-only stratified cliff and an outer ocean. The sea horizon sits four tiles above the island's north vertex, so the island is surrounded by sea on all four sides at every zoom and pan: the ocean is one cached horizon band, a sun/moon glitter column, and a flat deep fill, and the shelf and beach continue past every map edge. Water mood is identity below a grade night weight of 0.15, so the dawn sea is day water. Inland water is flat depth stops with sparse 2:1 ripple dashes; an earlier 4-texel lattice read as a tablecloth checker. The terrain cache key holds only what changes its pixels (bounds, assets, season, scenery revision, pass revisions); time of day reaches the ground through the grade and water through `waterMoodFor`. Walkability is untouched: both fields are visual.

Square top-down Wang cells had been stretched unrotated into the 64×32 diamond, putting the transition art on the vertices, which produced the checkerboard patchwork, stair-stepped coasts, and the "infinity pool" sea. Regenerating tilesets or rotating them 45° was rejected: the mapping was the defect, not the art. The three waterfalls had no source to hang from and were cut.

If you change this, update: `GroundBake.js`, `CoastBake.js`, `TerrainTileset.js`, `SceneryEngine._computeWaterShoreDistances`, `IsometricRenderer._terrainBakeKey`, `scripts/world/validate-terrain.mjs`, and `character-mode/README.md`.

## Effect language: shape is the family, colour the outcome, timing the weight (aesthetic plan C4)

Transient moments draw with `character-mode/EffectStamps.js`: `fillRect`-only world-space stamps on the art-pixel grid and one timing envelope (anticipation → one cream frame → four-step follow-through → optional static residue; Minor, Medium, and Major tiers, one Major at a time). Arrivals are a violet column at the gate, dispatch and merge a comet (returns in stone), verified success an 8-spoke gold crown, failure a red broken bracket. Success gold is for verified success only; a sub-agent return is never gold, and a standing failure holds the success crown back. Reduced motion shows only the residue frame. This is the rendering half of the frontier plan's shape grammar (`shared/EventShapes.js`). After QA the rest of the overlay moved to the same pixel grammar (`fillPixelEllipse`, `ellipseArcDots`, `dottedCurve`, `pixelLine`, `fillConvex`, graded through `gradeTone`): building marks, landmark chits, Harbor glows and wakes, crowd auras, stance marks, connections and talk arcs, the aurora, and monuments. A probe of `ctx.ellipse`/`arc`/gradient calls reads zero on both canvases in the dense-24, git-harbor, and release-parade scenarios; the Harbor flag and pennant decals still use small anti-aliased path fills.

Moments had been drawn with anti-aliased arcs, rounded rects, and `1/zoom` strokes in unrelated colours, so a release, an arrival, and a failure could not be told apart at a glance, and the old violet carriage glyph overrode the real gate walk-in.

If you change this, update: `EffectStamps.js`, `ArrivalDeparture.js`, `ChronicleMonuments.js`, `HarborTraffic.js`, `RitualConductor.js`/`WorkDownbeats.js`, `artPalette.js` `EFFECT_COLORS`, and the moments table in `docs/motion-budget.md`.

## Type grid and label tiers; routine names are no longer permanent (aesthetic plan C5, D2)

Both shipped faces are bitmap fonts on fixed grids — Press Start 2P 8 px/em, Departure Mono 11 px/em — so every DOM and canvas text size is an integer multiple (PS2P 8/16/24, DM 11/22/33), with no bold and no world-scaled text. World labels follow five tiers: T1 attention plates and beacons (`AttentionPlates.js`: live status, full strength, stacked without overlap, same-kind groups collapse into one counted plate while every body keeps its beacon, never culled by focus, Ambient, pressure, or the frame edge), T2 selected/hovered plates, T3 carved plaques with the exact count folded in (each live body counted once, as routed to, queued at, or inside the district), T4 text-only routine names, and T5 `+N` crowd tabs. Attention plates group only same-kind agents whose plates collide or whose beacons are within 96 px, so a group's word is true of every member; the top bar's single lit slot and the sidebar shelf use the same words (`NEEDS YOU`, `ERROR`, `LIMIT`). The maintainer approved (D2) replacing the old rule that identity never disappears at overview LOD: routine names now show only at zoom ≥ 1.6 for the top three (six at zoom 3) most recent actors per 200 px region and are dropped, not offset, on overlap. The T1 and T2 guarantees mean an agent that needs the operator is always named, and any individual is one hover or Sidebar click away.

Off-grid sizes (10, 12, 13, 14 px) dropped glyph rows and columns (`HARBOR` read as `HARBUR`), and permanent names on every body hid the village they labelled while nine overlapping `BELL WAITING` pills buried the one fact that mattered.

If you change this, update: `reset.css` type tokens, `theme.js` `WORLD_*_FONT_*`, `WorldLabelKit.js`, `AttentionPlates.js`, `IsometricRenderer._assignAgentOverlaySlots`, `AgentSprite._drawNameTag`, `DESIGN.md` (Whole-Pixel and No-Bold rules), and `character-mode/README.md`.

## Four painterly buildings re-authored (aesthetic plan D3)

Archive, Task board, Mine, and Forge — resampled painterly images with 10k–27k colours beside clean 1-px iso art — were re-authored with PixelLab on the Observatory grid with doors sized for the 1:1 body (the maintainer approved uncapped spend for this item), and Command was re-authored as the hero on the same grid. Command and Observatory gained lit-window emission sidecars gated by `NightOccupancyGate`, and Command's separate watchfire layer was retired because its braziers are in the base art. After QA, the Harbor's baked lit panes were moved into a new emission sidecar (dark slate glass by day), the Lighthouse (`building.watchtower`) gained a window sidecar and a hand-authored limestone footing in place of its baked blue plinth, the sea watchtower lost its baked water tile, the Archive's south-east portal was re-authored as one tall lancet (leaf ≈ 1.4× a villager), the Task board slate gained faint erased-chalk ghost strokes (not invented notices), and the plum plank bridges were re-toned onto the C1 timber ramp. Command's door leaf still measures about 1.0× a villager (door plus steps ≈ 1.2×). The unreferenced small pine, bush, grass-tuft and reed sprites were retired to the attic, and `style.assetVersion` was bumped to `2026-09-25-opus55-painted-isle` so browsers drop the cached old art. Each installed sprite records its item, endpoint, and job in manifest `provenance`. The quantized-painterly fallback (plan item 4.4) was not needed; only its hard-alpha-plus-outline fix shipped, on the Harbor ship sprites.

If you change this, update: `assets/sprites/manifest.yaml` (entries, provenance, `style.assetVersion`), `BuildingVisualRegistry.js` anchors and window rects, `BuildingSprite.js`, the `world-pilot` atlas (`npm run sprites:atlas-bake`), and `scripts/tests/w4-b.building-windows.test.mjs`.

## Shot scales by visible world area (aesthetic plan D4, Waking Isle 4.1/4.5/4.8, M8, M21)

Automatic shots are sized by the world area the canvas shows, never by tier index: `Camera.shotScaleTiers` resolves a survey (the largest logical tier showing ≥ 95 % of the island diamond, or none) and the logical tier ≥ 1 log-nearest 1.4e6 (wide), 0.55e6 (medium) and 0.2e6 (close) world px², recomputed on every viewport size change. The survey is `Camera.SURVEY_TIER`: z1 on the 5120 × 1440 DPR-1 ultrawide, `1 / backingDpr` (one backing pixel per world texel) on a DPR-2 laptop, none at 1920 × 1080 DPR 1. The boot opening and the empty-village tour's first stop use it, with the sea horizon at 11 % of the world viewport where the island leaves vertical slack (the only shots that show the horizon, M8), and `F` widens to it for boxes spanning at least 60 % of the island. Ordinary Auto rests no closer than the wide scale and explicit Ambient rests its wide at the wide scale and its cohorts at the medium scale (M8, bending "automatic moves never rest above tier 1"); automatic shots are land-weighted to at most 30 % sea (4.2). At backing DPR 2 the ladder exposes every whole backing-pixel scale k = 1..6 as zoom k/2; the half rungs 1.5 and 2.5 are wheel, keyboard and `F` rests, never shot scales or glide landings. The resting frame and follow tier stays 3 (M21). Resting at z2/z3 on the ultrawide roughly doubles steady GPU cost; its V2 receipts belong to 0.1's budget.

If you change this, update: `Camera.js` (`zoomTierLadder`, `shotScaleTiers`, `establishingShot`, `frameTierFloorForBox`), `CameraDirector.js`, `AttentionFraming.js`, `App.js` boot, `scripts/tests/camera-shot-scales.test.mjs`, `docs/motion-budget.md`, and `character-mode/README.md`.

## Work is density, not per call

The workshop model (audio plan Wave 5, decision D8) says which buildings are working and how hard, never what each tool call was. `WorkshopModel.js` reads the World model's non-stale `working` agents and classifies each one's `currentTool` (`classifyTool`), so it works in Dashboard, where `tool:invoked` never fires; tool starts over the last minute raise a building's **accent rate** through a saturating law (`ACCENT_CAP_PER_MIN`: at most 18 per minute, always under the start rate), and the Mine works from token burn. The Town band turns those rates into per-building percussion densities (`BgmDirector.percussionDensities`: a working building plays a sparse floor and its accent rate fills the groove). Stale agents, a lost link and `working === 0` contribute nothing (S6). The Village's own workshop stratum (baked material strikes per building) was retired with that preset in v0.47.1.

One sound per tool call was rejected twice (the council's kill, upheld by D8): agents call tools in bursts of dozens per second, so a per-call voice is either a metronome of the poll cadence or a machine gun, and it turns the village's most frequent non-fact into its loudest sound. Density says the fact the operator can use at a glance of the ear — the Forge is busy, the Archive has gone quiet — and a stall is heard as a missing stroke.

If you change this, update: `claudeville/src/presentation/shared/audio/WorkshopModel.js` and `scripts/tests/audio-workshop-model.test.mjs`, `BgmDirector.js` (`percussionDensities`), `audio/bgm/ScoreKit.js` (`PERCUSSION_VOICE`) and each piece's `percussion` rows, `audio/music/Sequencer.js` (the percussion draw), the audio rows in `claudeville/src/presentation/shared/README.md`, and this entry.

## Captions exist from boot and follow one setting

Sound is opt-in and off by default, so what the village signals must reach an operator who never turns it on. The signal route — `AmbientAudioController` with its cue governor, `CueKit`, the actionable routing and the urgency ladder's 1 Hz timer — is built by `TopBar._scheduleAudioRoute` in the first idle slot after boot (at most 4 s) and creates no AudioContext; every admitted cue emits `audio:cue-played` whether or not it can sound, and `Toast` captions it. Reminders therefore caption with sound off, and a hidden tab with sound on still wakes for them.

What captions is one pure policy, `Toast.cueCaptionShown`, over the cue's stratum (`CUE_STRATUM`) and one setting, SET *Captions* (`claudeville.captions`, `SoundSettings.CAPTION_SETTINGS`): *Automatic* (default) captions signals while sound is off and signals and events while it is on; *Signals only*; *Signals and events*; *Everything I can hear* adds scenery, but only while sound is on. Signals (needs-you, error, limit, reminders, `answered`) always caption; the return digest never does — it is sound-only and its caption is the `attention:digest` notice. The setting and the sound switch are read per cue, so a change applies to the next caption. In the *Signals* preset the non-signal kinds are captioned and not sounded (`announceOnly`). Desktop alerts go out `silent` while the village can ring its own bell (`audio:bell-state` → `AttentionService`), so a wait is never announced twice at once. Captions name the fact (`<name> hit an error`, counts, repos, the hour); sound is redundant with the chrome and never the only carrier.

If you change this, update: `claudeville/src/presentation/shared/Toast.js` (`CUE_STRATUM`, `cueCaptionShown`, `formatCueCaption`), `SoundSettings.js` (`CAPTIONS_KEY`), `SettingsPanel.js` (*Captions*), `TopBar.js` (`_scheduleAudioRoute`), `AmbientAudioController.js` (the signal timer), `audio/cues/CueKit.js` (`CAPTION_FIELDS`), `application/AttentionService.js` (silent alerts), `scripts/tests/audio-caption-policy.test.mjs` and `r1-19.cue-captions.test.mjs`, the probe's `captions` and `captionprobe` checks (`scripts/audio/README.md`), the `audio:cue-played` contract above, and this entry.

## A wait is a state: the ladder and the waiting cadence

A person waiting on the operator stays audible for as long as it is true (audio plan 3.3, S6), and it grows more frequent, never louder. In the Town band the music carries the wait: while an audible agent needs a person to act, each phrase end of the sequencer turns deceptive (V→vi, only the bass and chord changing) and the first cadence after the answer lands home (`Sequencer.setWaiting`, fed by `BgmDirector`); the band also leans back 2 dB meanwhile (`BgmDirector` `ATTENTION_DB`). The *Signals* preset has no bed: the last answer rings one `answered` strike, as the hidden-tab signal route does. The Village's held note under a wait went with that preset in v0.47.1.

Reminders come from the village-aggregated urgency ladder (`UrgencyLadder.js`, D6, on the controller's 1 Hz signal route): on the oldest unacknowledged wait, L2 at 2 min, L3 at 6, L4 (the watchtower horn under the call) at 15 and 30 min, then one L2 every 30 min until acknowledged; errors stop at L3 and quota after one L2. SET *Reminders* chooses *Standard*, *Gentle* (every step as L2) or *Off*. Selecting the agent acknowledges its wait.

If you change this, update: `claudeville/src/presentation/shared/audio/BgmDirector.js`, `audio/music/Sequencer.js` (the waiting cadence), `SignalDirector.js` (`_applyWaiting`, the `answered` strike), `audio/UrgencyLadder.js` and `AmbientAudioController.js` (`_ladderTick`), `SoundSettings.js` and `SettingsPanel.js` (*Reminders*), the probe's `honesty`, `ladder` and `townband` checks, and this entry.

## A blurred window keeps playing; the Town band leans back 3 dB (D3)

ClaudeVille is usually visible on a second monitor while the operator types elsewhere, so losing focus is not leaving (audio plan decision D3, item 5.6). SET *In the background* (`claudeville.sound.background`) decides: *Keep playing* (default) keeps sound running with the window blurred, the Town band's music group fader at −3 dB (`AmbientAudioController` `BLUR_MUSIC_DB`); *Signals* has no bed to lower. The cue bus has no fader there, and `AudioEngine.setBedCompensation` adds the removed 3 dB back to the engine's bed reading, so the bed-aware cue levels stay levelled against the full band: signals do not move. Focus restores the fader. *Signals only* treats a blurred window like a hidden tab.

A hidden tab always pauses in place: the Transport stops, the groups close over 80 ms and the context suspends, so nothing plays into a tab nobody can see; an urgent cue meanwhile wakes only the cue path at full level and suspends again after it has rung out. Returning resumes the same piece where it stopped, unless the absence exceeded 10 min or crossed day and night, which rebuilds the band.

If you change this, update: `claudeville/src/presentation/shared/AmbientAudioController.js` (`BLUR_MUSIC_DB`, `_syncQuietMix`, `_pageInactive`, `_pause`, `RESUME_RESTART_MS`), `audio/AudioEngine.js` (`setBedCompensation`), `SoundSettings.js` and `SettingsPanel.js` (*In the background*), the probe's `pause`, `away` and `continuity` checks, and this entry.

## Discrete sounds are placed once; nothing follows the camera (D8)

Every located sound — a cue, an outcome — is placed once, at schedule time, through `SpatialField.place` (`resolveCueSpot` finds its agent or building): a pan, a direct-path gain and low-pass by distance from the camera centre, and an Island Air send. Dashboard has no camera and uses the fixed island map (`ISLAND_MAP`). Signal cues are about the listener, not the world (no distance gain or low-pass, |pan| ≤ 0.3, air ≤ 0.12). Nothing runs per frame: the World render loop is only read. Decision D8 of the audio plan (item 5.8) had let the continuous emitters — the Village's workshop chains and the sea's harbor and coast lanes — glide after the camera; they were retired with that preset in v0.47.1, and the Town band's seats keep fixed chairs.

The same decision keeps the council's other kill: there is no sound per tool call (*Work is density, not per call*).

If you change this, update: `claudeville/src/presentation/shared/audio/SpatialField.js` (`place`, `resolveCueSpot`, `ISLAND_MAP`), `SignalDirector.js` and `BgmDirector.js` (the cue spots), `scripts/tests/audio-spatial-field.test.mjs` and `r2-03.spatial-audio.test.mjs`, and this entry.
