# ClaudeVille Agent Notes

## Scope and Shape

Work from the repository root. This shared checkout may be edited by multiple agents: run `git status --short` before changes, preserve unrelated edits, and follow the root [`AGENTS.md`](../AGENTS.md).

ClaudeVille is static HTML/CSS with vanilla ES modules. `server.js` uses Node built-ins only; there is no build step, bundler, transpiler, framework, or runtime dependency. The desktop-only UI targets viewports at least 1280px wide. Start the maintained server with `npm run dev`; do not change its port casually.

## Server

`server.js` binds `127.0.0.1:4000`. Local Host and same-origin checks guard HTTP and WebSocket access. Static files come from `claudeville/`; watch paths come from active provider adapters. Filesystem updates debounce alongside a two-second poll, and broadcasts no-op when there are no WebSocket clients.

Main surfaces are `/api/sessions`, `/api/session-detail`, `POST /api/session-details`, `POST /api/ingest/hook`, `/api/teams`, `/api/tasks`, `/api/providers`, `/api/usage`, `/api/perf`, `/api/changelog`, and `/ws`. The app fetches `/api/providers` during boot. `/api/tasks` and `/api/perf` are diagnostic/external-integration surfaces; the product UI does not consume `/api/tasks`.

Client session collection runs through `collectSessionsForClients()`, which folds unresolved `tool_pending` residents from `services/sessionResidency.js` into the live list. Completed turns use the shorter departed-villager grace. Discovery, canonical active projects, and watch topology remain on the raw `ACTIVE_THRESHOLD_MS` window so residency never widens the watcher footprint.

Explicit `sessionEndedAt` evidence (OMP `session_exit`, or an opt-in Claude `SessionEnd` hook) bypasses roster-absence grace and removes village presence immediately via the existing gate departure. A completed turn is not a session end; a resumed session clears the marker and arrives normally.

Cadence constants live in `src/config/constants.js`, `server.js`, `adapters/index.js`, and `adapters/gitEvents.js`. The client fallback poll is two seconds, server session-list cache TTL is 2000 ms, and WebSocket heartbeat is 30 seconds. Never lower the client poll below half the server cache TTL.

WebSocket updates use the keyed v2 delta contract only after `{ type: 'hello', deltas: true, deltaVersion: 2 }`; cached tabs with an older hello receive full updates. Full snapshots and REST retain activity-ordered `sessions` arrays. Keyed baselines separate session identity from activity order; guards, full-update fallbacks, and canonical resync sequencing are documented in [`docs/design-decisions.md#hand-written-websocket-framing`](../docs/design-decisions.md#hand-written-websocket-framing).

Hook reception and expiry are overlay-only dirtiness. A zero-delay broadcast refolds cached normalized provider observations independently of transcript scan backoff, without adapter invalidation, transcript reads, TTL renewal, or provider-freshness changes. `/api/sessions` also applies hooks immediately while serving a stale snapshot during backoff; the pending scan generation, `scanning` state, and deadline remain unchanged. Filesystem changes and the 30-second reconciliation continue through the coordinated provider scheduler.

Hook ingestion payload schema and opt-in Claude Code dogfood instructions: see [`docs/troubleshooting.md#permission-prompts-are-inferred-or-arrive-late`](../docs/troubleshooting.md#permission-prompts-are-inferred-or-arrive-late).

## Provider Adapters

Adapters are read-only inputs registered by `adapters/index.js`. Availability is automatic, empty output is not necessarily an error, and adapter failures may use short stale caches. The normalized contract, provider source paths, watch behavior, token semantics, and per-provider fixtures live in [`adapters/README.md`](adapters/README.md).

## Model Registry

`src/config/models.json` is the source of truth for model identity, pricing, context window, and mood. `npm run models:generate` emits `models.generated.js` and `models.generated.cjs`; never edit either generated file. Rendering policy stays in `src/presentation/shared/ModelVisualIdentity.js`, keyed by `modelClass`. Use `npm run models:resolve -- <provider> <model>` to inspect a match and [`.claude/skills/add-model/SKILL.md`](../.claude/skills/add-model/SKILL.md) for the contributor workflow.

## Frontend Ownership

`src/presentation/App.js` owns startup. It builds the domain (`World` plus `BUILDING_DEFS`), infrastructure (data source, WebSocket client, Chronicle store and its services), UI chrome (Toast, TopBar, Sidebar), and application services (`AgentManager`, `ModeManager`, notifications, mood). It then reads `/api/providers` and the first session snapshot (WebSocket `init`, REST as the fallback) while sprite metadata, the terrain artifact candidate, the World renderer module, and the Dashboard module load concurrently; resident character sprites load once the snapshot names them, and the renderer mounts when assets and module are both ready. `index.html` modulepreloads the dynamic boot roots `IsometricRenderer.js`, `GpuWorldRendererWebGPU.js`, and `vendor/js-yaml.min.js`; this starts fetching earlier without changing execution or backend selection. Terrain artifacts are validated against settled first-frame inputs under the bounded initial-boot contract in the World README. The Activity Panel loads on the first selection, and `TopBar` builds the sound controller in the first idle slot without creating an `AudioContext`. UI and documentation copy are English-only. Mode-specific behavior belongs with its nearest owner:

- [World renderer and selection lifecycle](src/presentation/character-mode/README.md)
- [Dashboard cards, lifecycle, and detail polling](src/presentation/dashboard-mode/README.md)
- [Shared chrome, Activity Panel, selection, detail cache, and sound](src/presentation/shared/README.md) (`AmbientAudioController.js` and `shared/audio/`: presets Off · Signals · Town band; the local probe is documented in [`scripts/audio/README.md`](../scripts/audio/README.md))

`WebSocketClient` patches escaped session IDs and preserves untouched session-object identity. Session-only deltas normalize changed residents; every message still re-evaluates untouched residents' clock-derived status, activity-age buckets, and verified git outcomes (including activation, expiry eligibility, and fallback timestamps). Status or age-bucket transitions use full upserts to preserve status-derived tools and retained dialogue; unchanged residents only refresh `activityAgeMs` and `lastActive`. Shared git, team, collision, usage, or wholesale changes use full ingestion. Invalid v2 baselines, patches, or unresolved IDs request one outstanding resync until a full snapshot arrives. A delta without `deltaVersion: 2` instead sends one `{ type: 'hello', deltas: false }` without resync; reconnect negotiates capability again.

The World is a pixel-art isometric renderer: a resident GPU world by default (WebGPU in Chromium, WebGL2 elsewhere or when WebGPU cannot start), Canvas 2D as the fallback. `Camera.js` rests on zoom tiers `{1,2,3}`, plus a survey tier (one backing pixel per world texel) when the backing DPR is 2 or more and, at backing DPR 2, the half rungs 1.5 and 2.5 (every whole backing-pixel scale); world sprites draw at integer multiples of the world texel (a walking body rides the backing-pixel grid and camera flight frames render fat-pixel, the two C3 bends), and overlay marks use the pixel stamps in `EffectStamps.js` and `PixelShapes.js`, never anti-aliased arcs, ellipses, or gradients. `SpriteRenderer.js` is the only sprite-blit entry point and disables smoothing. World colours come from the master palette in `src/config/artPalette.js` (status hues stay in `src/config/theme.js`), and the time-of-day/weather grade from `GradeEvaluator.js`. Motion-bearing changes must follow [`docs/motion-budget.md`](../docs/motion-budget.md).

The World's explicit operator instruments — READ (hold `B`), the `A` attention frame, the World dock's `FREE | AUTO | AMBIENT` camera control, and the panel's SCORE control — plus the frontier contracts (observation certainty, action strips, effect receipts, the inspection aperture, the shape grammar, Ambient ownership), the aesthetic contracts (master palette, one grade evaluator, one pixel grid, effect language, type grid and label tiers) and the Waking Isle contracts V1–V9 are documented in [the World mode README](src/presentation/character-mode/README.md). Their pure models (`ObservationCertainty`, `BuildingApertureModel`, `BuildingInstrumentModel`, `WorkWaterfallModel`, `AttentionFraming`, `GradeEvaluator`) are the single derivation of each fact; do not re-derive those fields inside components.

## Sprite Generation

`assets/sprites/manifest.yaml` is the sprite source of truth: every runtime sprite must have a manifest entry, every PNG must live at its manifest-implied path, character `generationSize` is distinct from the 92px engine cell, palette mirrors must remain identical, and `style.assetVersion` changes only when PNG bytes change. Optional per-character action strips are separate PNGs beside the sheet with named groups (`read`), generated through `scripts/sprites/generate-action-strip.mjs`; the base sheet is never widened and characters without a strip keep the procedural overlay. Follow [`scripts/sprites/generate.md`](../scripts/sprites/generate.md), including its canonical “Add One Character” procedure and validation commands.

## Event Bus

The singleton `src/domain/events/DomainEvent.js` exports `eventBus`; subscriptions are global with no replay or persistence, and a throwing listener is logged without stopping the others. Its header lists the core contracts; major families include agent lifecycle/selection/pins, attention, mode, usage/FPS/atmosphere, WebSocket state/messages, building and camera, Chronicle/biography/affinity, audio/sound state, and village/director presentation signals. This list is intentionally partial: search emitters in `src/application/`, `src/presentation/`, and `src/infrastructure/WebSocketClient.js` before changing an event contract.

## Validation and Constraints

Use the canonical change-to-command table in [`AGENTS.md#validation`](../AGENTS.md#validation). For presentation work, automated screenshot and console evidence comes from `npm run verify:render`; visual judgment on the operator-maintained server remains manual.

Keep changes narrow. Do not mutate local CLI session files, introduce a frontend framework, or delete generated app artifacts unless explicitly asked. Re-run `git status --short` before handoff.
