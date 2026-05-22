# ClaudeVille Code Health Enhancement Plan

Date: 2026-05-22
Status: implemented
Baseline HEAD: `92b5da14cef52a92ad06fe9c6d6b1a44199ee3eb`
Initial `git status --short`: clean
Final expected `git status --short`: clean after implementation commits

## Scope

Owned paths:

- `claudeville/server.js`
- `claudeville/adapters/`
- `claudeville/services/`
- `claudeville/src/application/`
- `claudeville/src/config/`
- `claudeville/src/domain/`
- `claudeville/src/infrastructure/`
- `claudeville/src/presentation/`
- `widget/`
- `scripts/`
- `demo-server.js`
- `README.md`
- `agents/README.md`

Source reviews:

- Six parallel xhigh explorer reviews on 2026-05-22: server/API/WebSocket, adapters, services/domain, frontend dashboard/shared, world canvas, and widget/scripts/cross-cutting.
- Current code verified at baseline HEAD with `git status --short`, `git rev-parse HEAD`, `wc -l`, `rg`, and targeted `nl -ba` inspections.

## Goal

Reduce duplication and maintenance cost while preserving ClaudeVille's zero-build local dashboard behavior. Prefer small helpers, data moves, dead-code removal, and canonical sources of truth over architectural rewrites.

## Non-Goals

- Do not add bundlers, transpilers, app test runners, lint/format steps, or CI.
- Do not add mobile or narrow-viewport behavior; the browser target remains desktop-only at 1280px and wider.
- Do not rewrite World mode wholesale; split it through behavior-preserving extraction batches.
- Do not change provider semantics, model pricing, widget payloads, or movement behavior without focused smoke checks.

## Findings By Priority

Critical:

- None.

High:

- `claudeville/src/presentation/character-mode/IsometricRenderer.js:2404` treats `walkabilityGrid` as a 2D array, while `SceneryEngine.js:665` returns a flat `Uint8Array` and `Pathfinder.js:22` indexes `y * MAP_SIZE + x`. Simplify `_monumentBlockedTiles()` to the flat grid shape first because it is both a correctness fix and a LOC reduction.
- `claudeville/src/presentation/character-mode/IsometricRenderer.js:88` embeds large data-only blocks that belong in existing config modules: overflow visit tiles, scenic points, command decorations, props, emitters, gull routes, and bridge palettes. Move these into `config/buildings.js`, `config/scenery.js`, and `config/townPlan.js` in pure-data batches to reduce the 7,848-line renderer.
- `claudeville/src/domain/services/ToolIdentity.js:1` spreads tool metadata across direct classifications, icon maps, category maps, action labels, sets, regex branches, and fallback predicates. Build a shared metadata table plus common regex constants so routing, labels, icons, and building decisions cannot drift.
- Widget and browser pricing/model identity are duplicated across `TokenUsage.js`, `model-pricing.json`, `widget/Sources/main.swift`, `widget/Resources/widget.html`, and KDE QML. Make `/api/sessions` the canonical source for session cost plus display identity fields, then remove widget-side pricing tables where consumers already prefer API-provided `estimatedCost`.

Medium:

- `claudeville/adapters/claude.js`, `codex.js`, and `kimi.js` repeat JSONL head/tail reads, parsing, file signatures, and cache trimming. Add `claudeville/adapters/shared.js` with adapter-specific byte/count options.
- Tool-input summarization repeats across Claude, Kimi, OpenCode, Codex, and Gemini adapters. Centralize field selection and truncation with provider options, preserving null, basename, and empty-string behavior.
- `claudeville/server.js` has repeated API `try/sendJson/catch/sendError` handlers, duplicate URL parsing, separate GET/POST route switches, and a special widget static-file branch. Introduce a tiny route table, parse URLs once, and share static file serving across app and widget roots.
- `claudeville/server.js` duplicates WebSocket close/delete behavior in close frames, backpressure, stale heartbeat, and shutdown. Route those through `closeWebSocket()` and collapse the two adjacent no-send branches in `broadcastUpdate()`.
- `VisitIntentManager.js` and `AgentBehaviorState.js` duplicate working phases, goal aliases, route-stop normalization, itinerary cloning, and work-cycle routing. Extract shared intent semantics before changing visit behavior.
- `AgentSprite.js`, `VisitTileAllocator.js`, and `IsometricRenderer.js` each own pieces of visit fallback, building alias normalization, and crowd-cluster summarization. Let `VisitTileAllocator` own fallback/reservation metadata, add a shared building-type normalizer, and extract a crowd summary helper.
- Projection math is centralized in `Projection.js` but reimplemented in `HarborTraffic.js`, `LandmarkActivity.js`, `ChronicleMonuments.js`, `Minimap.js`, and inline renderer formulas. Replace manual formulas with `tileToWorld`, `worldToTile`, and `tileVectorToWorld`.
- `BuildingVisualRegistry.js` only owns some labels/anchors while `BuildingSprite.js` still owns static light, emitter, and overlay metadata. Move static metadata into the registry and keep `BuildingSprite` focused on drawing.
- `SessionDetailsService.js` duplicates single-detail and batch-detail cache/timeout behavior. Extract cache state and timeout helpers so Activity Panel and Dashboard detail fetching stay aligned.
- `ActivityPanel.js` reaches through `window.__claudeVilleApp` for world, renderer, and harbor state. Pass those dependencies from `App.js` to make panel behavior easier to isolate.
- `ChronicleStore.js` repeats IndexedDB cursor Promise/error/continue mechanics across range query and delete paths. A cursor walker helper can trim code, but transaction timing makes this a medium-risk batch.
- Sprite manifest parsing and path inference repeat in `manifest-id-audit.mjs`, `manifest-validator.mjs`, and `plan.mjs`. Add `scripts/sprites/manifest-utils.mjs` and keep validator behavior unchanged.

Low:

- Remove `demo-server.js`; `README.md:284` already documents it as unused and the file contains a stale absolute path.
- Remove unused Kimi adapter pieces: `_sessionCache` and `normalizeCommand()`.
- Have `getActiveProviders()` delegate to `getAdapterMetadata({ includeUnavailable: false })` and filter synthetic entries instead of rebuilding the same provider shape.
- Consolidate Claude main/subagent summary parsing and avoid the private `getSessionDetail` name collision in `claude.js`.
- Add a detail-response helper for adapter `getSessionDetail()` fallbacks.
- Reuse `getTeamsCached()` for `GET /api/teams` to match WebSocket init/update behavior.
- Simplify `AgentManager._upsertAgent()` by extracting a session-to-agent payload helper while preserving `_lastMessage` handling.
- Add `_getJson(path, fallback, label, select)` to `ClaudeDataSource`.
- Cache parsed Claude OAuth credentials in `usageQuota.js` instead of reading/parsing twice.
- Decide whether `TokenUsage.js` or `model-pricing.json` is canonical; remove the unused duplicate and uncalled wrapper exports.
- Remove unused `Position` methods if no local consumers exist.
- Flatten `i18n.js` to an English-only `t()` helper if no future localization path is intended.
- Make `scripts/smoke/adapters.mjs` and `scripts/smoke/relationship.mjs` repo-relative instead of hardcoding this checkout path.
- Stop copying unused static widget resources into the macOS `.app` bundle if Swift continues to render inline HTML.
- Fix adapter README drift: synthetic git sessions emit `agentType: 'repository'`.

## Plan

1. **Low-risk deletions and portability fixes**
   - Remove `demo-server.js` and adjust README wording if needed.
   - Remove dead Kimi adapter state/helpers.
   - Make smoke scripts repo-relative.
   - Fix adapter README `agentType` docs.
   - Validation: `node --check` on changed JS files; docs diff review.

2. **Server helper consolidation**
   - Add an API response wrapper for simple GET handlers.
   - Parse request URLs once and pass `parsedUrl` into handlers that need query params.
   - Replace GET/POST switches with a small method/path route table.
   - Share app/widget static serving through one contained-file helper.
   - Route backpressure, stale heartbeat, close frames, and shutdown through `closeWebSocket()`.
   - Validation: `node --check claudeville/server.js`; run server and check `/api/providers`, `/api/sessions`, `/api/teams`, `/widget.html`, `/widget.css`, and `/`.

3. **Adapter shared utilities**
   - Add `claudeville/adapters/shared.js` for JSONL head/tail parsing, file signatures, and bounded cache trimming.
   - Centralize tool-input summarization behind provider options.
   - Add detail-response and Claude-summary helpers.
   - Consolidate provider metadata mapping.
   - Validation: `find claudeville/adapters -name '*.js' -print0 | xargs -0 -n1 node --check`; `node scripts/smoke/adapters.mjs`.

4. **Canonical model, pricing, and widget payloads**
   - Pick one pricing source; prefer runtime `TokenUsage.js` unless a static JSON consumer is proven.
   - Add API-owned display identity fields needed by macOS/KDE/static widgets.
   - Remove widget-side pricing/model-display duplication only after API fields are present.
   - Reassess whether `widget/Resources/widget.html` and `widget.css` are still live inputs or stale bundle artifacts.
   - Validation: `node --check claudeville/src/domain/value-objects/TokenUsage.js`; `npm run widget:build`; widget check command available for the host platform.

5. **Tool identity and domain helpers**
   - Replace scattered `ToolIdentity` maps/sets/regexes with one metadata table plus shared predicate constants.
   - Extract `AgentManager` session-to-agent payload mapping.
   - Add `ClaudeDataSource._getJson()` and `usageQuota` credential parsing cache.
   - Remove unused `Position` methods and flatten English-only i18n if confirmed by `rg`.
   - Validation: changed-file `node --check`; browser smoke for tool labels, activity destinations, Dashboard, and World selection.

6. **World correctness and pure-data extraction**
   - Fix `_monumentBlockedTiles()` to use flat grid indexing.
   - Move renderer-owned data-only constants into existing config modules in small batches.
   - Keep exports stable and import them back into the renderer before deeper behavior work.
   - Validation: `npm run world:validate-buildings`; `npm run world:validate-terrain`; browser World smoke.

7. **World behavior deduplication**
   - Extract shared visit intent semantics.
   - Move visit fallback/reservation ownership into `VisitTileAllocator`.
   - Add shared building-type normalization and crowd-cluster summary helpers.
   - Replace repeated projection math with `Projection.js` helpers.
   - Validation: World smoke with agent select/deselect, movement to buildings, Dashboard switch, and console check.

8. **Renderer and asset maintainability**
   - Move static building emitter/light/overlay metadata into `BuildingVisualRegistry`.
   - Add `AssetManager` `_entryById`, `_storeBitmap()`, and `_loadLayer()` helpers.
   - Keep drawing code behavior-preserving; defer any visual redesign.
   - Validation: World browser smoke plus sprite/asset visual spot check.

9. **Frontend shared-state cleanup**
   - Extract `SessionDetailsService` cache/timeout helpers.
   - Pass Activity Panel world/renderer/harbor dependencies from `App.js` instead of reading `window.__claudeVilleApp`.
   - Simplify Dashboard current-tool rendering, section ref caching, and destroy cleanup.
   - Centralize remaining English UI strings only where it reduces drift.
   - Validation: browser smoke for World + Dashboard, Activity Panel detail fetches, agent select/deselect, and no duplicated session-detail network churn.

10. **Script and sprite utility consolidation**
    - Add `scripts/sprites/manifest-utils.mjs` for manifest parsing and path inference.
    - Keep validator output and exit semantics unchanged.
    - Validation: `npm run sprites:audit-refresh`; targeted `node --check scripts/sprites/*.mjs`.

## Execution Readiness

Safe to execute: partial

Required preflight:

- Re-run `git status --short`.
- Re-check owned paths for unrelated edits.
- Reconfirm code and line references against current `HEAD`.
- Execute phases independently; avoid broad formatting or mixed ownership changes.

## Validation

Validation required:

- Match each phase to the repository validation table in `AGENTS.md`.
- For broad runtime changes: start `npm run dev` if not already running, then check `http://localhost:4000`, `/api/providers`, `/api/sessions`, World mode, Dashboard mode, resize within desktop widths, and agent select/deselect.
- For server/adapters/services: run `node --check` on touched files and the relevant smoke script.
- For World config/runtime: run `npm run world:validate-buildings` and `npm run world:validate-terrain`.
- For widgets: run the relevant macOS or KDE widget checks when available on the host.

Validation run:

- `node --check claudeville/server.js`
- `find claudeville/adapters claudeville/services -name '*.js' -print0 | xargs -0 -n1 node --check`
- `node --check claudeville/src/application/AgentManager.js claudeville/src/config/i18n.js claudeville/src/domain/services/ToolIdentity.js claudeville/src/domain/value-objects/Position.js claudeville/src/domain/value-objects/TokenUsage.js claudeville/src/infrastructure/ClaudeDataSource.js claudeville/src/presentation/App.js claudeville/src/presentation/shared/ActivityPanel.js claudeville/src/presentation/shared/ModelVisualIdentity.js claudeville/src/presentation/shared/SessionDetailsService.js`
- `node --check claudeville/src/presentation/character-mode/*.js claudeville/src/presentation/dashboard-mode/*.js`
- `node --check scripts/smoke/adapters.mjs scripts/smoke/relationship.mjs scripts/sprites/manifest-id-audit.mjs scripts/sprites/manifest-validator.mjs scripts/sprites/plan.mjs scripts/sprites/manifest-utils.mjs scripts/widget/check-pricing.cjs scripts/widget/check-kde.cjs scripts/widget/check.cjs scripts/widget/check-bundle.cjs`
- `node scripts/smoke/adapters.mjs`
- `NODE_NO_WARNINGS=1 node scripts/smoke/relationship.mjs`
- `node - <<'NODE'` direct API pricing helper check for `gpt-5-5`, `gpt-5-4`, and `gpt-5-3-codex-spark`
- `npm run world:validate-buildings`
- `npm run world:validate-terrain`
- `npm run sprites:audit-refresh`
- `npm run validate:quick`
- `node scripts/widget/check-pricing.cjs`
- `npm run widget:kde:check`
- `npm run widget:check`
- Runtime smoke: started `npm run dev`, checked `/api/providers`, `/api/sessions`, and `/`, then used Playwright CLI with system Chrome at desktop widths for World/Dashboard mode switching, agent select/deselect, resize to 1280x900, console inspection, browser `TokenUsage` pricing checks for hyphenated GPT IDs, and high-density visit allocation for archive/command/mine/watchtower via `window.__visitReservations()`.
- `npm run widget:build` was attempted and failed because `swiftc` is not available on this host; source and bundle-copy checks passed with `npm run widget:check`.

## Residual Risks

- Some line numbers will drift after the first implementation phase; treat paths and function names as the stable references.
- Widget resource removal depends on confirming no external consumer still opens `widget/Resources/widget.html` directly.
- Centralizing tool identity and model identity changes user-visible labels, colors, routing, or widget display if defaults are not preserved exactly.
- World movement deduplication is behavior-sensitive; keep it separate from pure data moves and correctness fixes.

## Supersession Policy

If this plan becomes stale, update `agents/README.md` with the replacement source of truth and mark this artifact `historical` or `superseded`.
