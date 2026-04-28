# ClaudeVille Code Health Remediation Plan

Date: 2026-04-28

Baseline:

- Repo: `/home/ahirice/Documents/git/claude-ville`
- HEAD: `d01f400976a268da7a28630e546d6fe64381755a`
- Initial `git status --short`: clean; current post-plan status is the expected new artifact `?? agents/plans/code-health-remediation-plan.md`
- Scope: application code, runtime, assets, widget, scripts, CSS, and project hygiene
- Out of scope: recently updated docs content, edits under `docs/`, mobile or narrow responsive behavior. Agent artifacts under `/agents/` are permitted.

Validation already run during audit:

- `node --check claudeville/server.js`: passed
- `find claudeville/adapters claudeville/services -name '*.js' -print0 | xargs -0 -n1 node --check`: passed
- `npm run sprites:validate`: passed with `expected: 146`, `missing: 0`, `orphan PNGs: 0`, `invalid manifest entries: 0`, `invalid character sheets: 0`, `invalid atmosphere PNGs: 0`

## Planning Principles

1. Fix behavior that can hide active sessions, misreport state, or load broken assets before deleting or reorganizing code.
2. Make validation meaningful before relying on it, especially for sprite visual diffs and widget behavior.
3. Remove dead code only after final `rg` checks and after deciding whether compatibility exports are public.
4. Keep each implementation slice small enough to validate with this repo's no-build workflow.
5. Avoid broad formatting. CSS consolidation should preserve accepted visuals and be checked in the browser.

## Priority Summary

P0: Correctness, safety, and broken validation

- Codex active-session discovery misses long-running sessions in older day folders.
- Committed macOS widget bundle contains machine-specific paths and can run stale code.
- DOM rendering has unsafe or inconsistent escaping in sidebar, activity panel, and boot error output.
- Minimap reads stale domain positions instead of live sprite positions.
- Composed building asset failures can silently register checkerboard hero buildings as valid.
- Sprite visual-diff scripts can pass while comparing no meaningful baseline.
- Claude token totals are tail-window totals but are labeled as totals.
- Static file path guard is prefix-based.
- Oversized JSON bodies reset the request instead of returning 413.

P1: Runtime resilience and data integrity

- `fs.watch({ recursive: true })` failures are swallowed, delaying updates to polling cadence.
- WebSocket parser assumes one complete frame per socket `data` event.
- Event bus listener exceptions can stop later listeners.
- Cache invalidation and static cache headers carry unused or unclear paths.
- Git enrichment drops observed commit events when synthesizing unpushed commits.
- Usage "today" uses a UTC date string for local-day boundaries.
- TopBar quota can leave stale bars visible after quota becomes unavailable.
- Avatar canvas can race manifest asset-version resolution.

P2: Maintainability, duplication, and dead code

- `IsometricRenderer.js` is too large and owns too many responsibilities.
- Projection math, drawable depth policy, git-event normalization, tool classification, tool icons, status normalization, row hashing, token/cost formatting, and project path shortening are duplicated.
- Legacy renderer and multiple small modules/helpers are unused or candidate compatibility leftovers.
- CSS has appended refinement layers, duplicate global keyframes, underused tokens, and unused selectors.
- Widget has two divergent UI implementations.
- Sprite generation scripts are stale relative to `manifest.yaml`.
- Runtime `js-yaml` vendor file differs from package lock.
- Root visual artifacts and generated bundles are committed outside current artifact conventions.

## Phase 0: Guardrails And Baselines

Goal: lock in evidence before changes.

Tasks:

1. Run `git status --short` and record unrelated local changes before each implementation slice.
2. For behavior fixes, capture a focused before-state:
   - API: `curl http://localhost:4000/api/providers`, `curl http://localhost:4000/api/sessions`, `curl http://localhost:4000/api/perf`.
   - Browser: World and Dashboard mode smoke on `http://localhost:4000`.
   - Widget: after artifact-policy work, `npm run widget:build`, then `npm run widget`, on macOS with the Swift toolchain only.
3. Keep a removal ledger for every dead-code candidate: path, `rg` proof, removal commit, validation command.

Validation:

- `git status --short`
- Scope-specific checks listed in later phases.

## Phase 1: Runtime Correctness And Data Integrity

### 1.1 Fix Codex Active Session Discovery

Evidence:

- `claudeville/adapters/codex.js:597` scans only recent year/month/day directory names.
- `claudeville/adapters/codex.js:643` filters active files by `mtime` only after those directories are selected.

Problem:

- A long-running session started more than three scanned day directories ago can still be actively appending but never scanned.

Plan:

1. Replace day-count directory slicing with a bounded mtime-driven scan.
2. Traverse recent year/month/day roots in newest-first order, but collect candidate rollout files by file `mtimeMs`.
3. Stop traversal only after enough files or after directory mtimes are older than a configurable window.
4. Preserve current active-threshold filtering and `_rolloutFileBySessionId` indexing.
5. Add cheap counters to `/api/perf` or debug output only if useful for manual verification.

Validation:

- `node --check claudeville/adapters/codex.js`
- Start server and confirm `/api/sessions` still returns Codex sessions.
- Manual fixture or temporary local file tree check if real old-day Codex data is available.

### 1.2 Decide And Fix Token Usage Semantics

Evidence:

- `claudeville/adapters/claude.js:410` reads only `tailEntries(sessionFilePath, 200)`.
- `claudeville/adapters/claude.js:420` returns `totalInput` and `totalOutput`.

Problem:

- Long Claude sessions silently undercount tokens and cost while using total-like field names.

Decision required:

- Preferred: keep UI totals as "session totals" and compute true totals from the full session file using cached stat keys.
- Fallback: rename fields/UI labels to "recent window" and expose `isPartial: true`.

Plan:

1. Implement true-total cache for Claude token usage keyed by file stat.
2. For very large files, use an incremental offset cache if full reads are too slow; do not retain incorrect total semantics.
3. Check Codex cumulative `token_count` behavior for consistency; document adapter output contract in code comments, not docs.
4. Update `World.getStats()`, `ActivityPanel`, `TopBar`, and widget cost display only if field semantics change.

Validation:

- `node --check claudeville/adapters/claude.js`
- `node --check claudeville/src/domain/value-objects/TokenUsage.js`
- Browser check: TopBar totals, ActivityPanel token cells, Dashboard cards.

### 1.3 Preserve Observed Git Events When Adding Synthetic Events

Evidence:

- `claudeville/adapters/gitEvents.js:637` filters out existing commit events before adding synthetic unpushed commits.

Problem:

- Observed command text, source IDs, success/failure metadata, and provider context can be dropped.

Plan:

1. Normalize observed and synthetic events to a shared identity using SHA where available, then command hash and timestamp fallback.
2. Merge synthetic fields into observed events instead of replacing them.
3. Preserve source metadata arrays if multiple observations map to the same commit.
4. Add a local helper in `gitEvents.js`; do not expand UI logic in this phase.

Validation:

- `node --check claudeville/adapters/gitEvents.js`
- Manual check with `git status`/unpushed commits visible in Harbor if available.

### 1.4 Fix Usage Local-Day Boundary

Evidence:

- `claudeville/services/usageQuota.js:180` derives date via `toISOString().slice(0, 10)`.

Problem:

- Around local midnight outside UTC, "today" can count the wrong local day.

Plan:

1. Replace UTC string construction with local midnight:
   - `const todayStartDate = new Date(); todayStartDate.setHours(0, 0, 0, 0);`
2. Keep Monday week calculation local.

Validation:

- `node --check claudeville/services/usageQuota.js`
- Optional small node snippet around mocked dates if helper is extracted.

### 1.5 Tighten Static File Path Guard

Evidence:

- `claudeville/server.js:307` resolves requested paths.
- `claudeville/server.js:311` checks `resolvedPath.startsWith(STATIC_DIR)`.

Problem:

- Prefix matching can allow sibling paths such as `claudeville-extra`.

Plan:

1. Resolve `STATIC_DIR` once.
2. Require `resolvedPath === staticRoot || resolvedPath.startsWith(staticRoot + path.sep)`.
3. Keep CORS and MIME behavior unchanged.

Validation:

- `node --check claudeville/server.js`
- `curl http://localhost:4000/`
- Path traversal manual check with encoded `..`.

### 1.6 Return 413 For Oversized JSON Bodies

Evidence:

- `claudeville/server.js:74` accumulates request body.
- `claudeville/server.js:78` calls `req.destroy()` when the limit is exceeded.

Problem:

- Clients can see a connection reset or hang rather than an API error.

Plan:

1. Track `tooLarge`.
2. Stop accumulating additional chunks once the limit is crossed.
3. Let handler return `413 Payload Too Large` through `sendError`.
4. Ensure callback runs only once.

Validation:

- `node --check claudeville/server.js`
- Manual oversized `curl` POST to `/api/session-details`.

### 1.7 Add Watch Fallback Visibility

Evidence:

- `claudeville/server.js:771` uses `fs.watch` with recursive options.
- `claudeville/server.js:784` swallows watcher setup errors.
- `claudeville/server.js:806` falls back to periodic discovery.

Problem:

- Unsupported recursive watches silently degrade update freshness.

Plan:

1. Add a `serverPerf.watchFailures` counter and optional `DEBUG_WATCH` logging.
2. Add a bounded stat-based dirty check for provider roots that failed recursive watch setup.
3. Preserve the 20-second full discovery cadence as a safety net.

Validation:

- `node --check claudeville/server.js`
- `/api/perf` shows watcher counters.

### 1.8 Buffer WebSocket Frames

Evidence:

- `claudeville/server.js:403` handles each socket `data` as a frame.
- `claudeville/server.js:420` parses one frame only.

Problem:

- Split or coalesced client frames can be dropped.

Plan:

1. Keep `socket._cvFrameBuffer`.
2. Append incoming data and parse frames in a loop.
3. Leave incomplete frames buffered.
4. Reject unreasonable payload lengths to avoid memory growth.

Validation:

- `node --check claudeville/server.js`
- Browser WebSocket reconnect/update smoke.

### 1.9 Isolate Event Bus Listener Failures

Evidence:

- `claudeville/src/domain/events/DomainEvent.js:25` invokes callbacks directly.

Problem:

- One listener exception prevents later listeners from observing the event.

Plan:

1. Wrap each callback in `try/catch`.
2. Log event name and error message.
3. Do not rethrow from `emit`.

Validation:

- `node --check claudeville/src/domain/events/DomainEvent.js`
- Browser smoke: selection, sidebar, activity panel, mode switching.

### 1.10 Tighten Cache Invalidation And Static Cache Headers

Evidence:

- `claudeville/server.js:93` returns `no-cache` from both branches of `cacheControlFor()`.
- `claudeville/server.js:623` invalidates all session caches on provider-data changes.
- `claudeville/adapters/index.js:136` fans invalidation to every adapter.
- `claudeville/server.js:636` computes `teamsCache.signature`, but no reader uses it.

Problem:

- Cache intent is unclear, and every watched change can discard all adapter caches even when only one provider root changed.

Plan:

1. Either collapse `cacheControlFor()` to a simple constant or implement the intended asset/API split explicitly.
2. Remove `teamsCache.signature` if no consumer is added.
3. Thread provider identity through watcher dirty events where available, then invalidate only the affected adapter cache.
4. Keep a full invalidation path for unknown changes and startup recovery.

Validation:

- `node --check claudeville/server.js`
- `find claudeville/adapters claudeville/services -name '*.js' -print0 | xargs -0 -n1 node --check`
- API smoke after file changes: `curl http://localhost:4000/api/providers`, `curl http://localhost:4000/api/sessions`, `curl http://localhost:4000/api/perf`.

## Phase 2: UI Safety And State Consistency

### 2.1 Replace Unsafe Dynamic HTML

Evidence:

- `claudeville/src/presentation/shared/Sidebar.js:157` interpolates `agent.id` into `data-agent-id`.
- `claudeville/src/presentation/shared/Sidebar.js:159` interpolates status into class names.
- `claudeville/src/presentation/shared/ActivityPanel.js:257` interpolates `m.role` as raw HTML.
- `claudeville/src/presentation/App.js:422` writes `err.message` through `innerHTML`.

Problem:

- Unexpected local session metadata can corrupt markup or become local script/attribute injection.

Plan:

1. Add tiny shared helpers in `claudeville/src/presentation/shared/DomSafe.js`:
   - `escapeHtml`
   - `escapeAttr`
   - `safeClassToken`
2. Prefer DOM construction for Sidebar agent rows and ActivityPanel messages.
3. If templates remain, escape attributes and validate class suffixes.
4. Render boot error with `textContent` nodes.

Validation:

- Browser smoke with agent names/roles containing `<`, `"`, `'`, and spaces.
- `node --check` on touched JS files.

### 2.2 Reset TopBar Quota When Unavailable

Evidence:

- `claudeville/src/presentation/shared/TopBar.js:66` only updates bars when quota is available.

Problem:

- Old quota percentages can remain visible after later unavailable payloads.

Plan:

1. Add `else` branch to hide quota section or reset both bars to zero.
2. Keep account tier and activity text updates independent.

Validation:

- Browser console eventBus manual emit for available then unavailable usage.

### 2.3 Fix Avatar Asset-Version Race

Evidence:

- `claudeville/src/presentation/dashboard-mode/AvatarCanvas.js:21` starts with a hard-coded version.
- `claudeville/src/presentation/dashboard-mode/AvatarCanvas.js:22` updates asynchronously.

Problem:

- Avatars created before manifest load can keep the wrong cache-buster.

Plan:

1. Store the resolved version per `AvatarCanvas`.
2. When `getSpriteAssetVersion()` resolves, invalidate and redraw avatars whose version changed.
3. Consider reusing `AssetManager` metadata or manifest load state instead of a second fetch.

Validation:

- Dashboard smoke after asset version change.

### 2.4 Feed Minimap Live Sprite Positions

Evidence:

- `claudeville/src/presentation/character-mode/Minimap.js:95` draws `agent.position`.
- `claudeville/src/presentation/character-mode/AgentSprite.js:463` and `IsometricRenderer.js:1720` move sprites independently.

Problem:

- Minimap dots can disagree with visible world-mode agents.

Plan:

1. Add optional `agentSprites` or `agentTileSnapshot` parameter to `Minimap.draw`.
2. Convert sprite world coordinates to tile coordinates through one shared projection helper.
3. Fall back to `agent.position` only when no sprite exists.

Validation:

- Browser World smoke: walking, arrival/departure, minimap dot movement.

### 2.5 Surface Composed Building Asset Failures

Evidence:

- `claudeville/src/presentation/character-mode/AssetManager.js:103` loads composed grid cells.
- `claudeville/src/presentation/character-mode/AssetManager.js:115` registers composed canvas.
- `claudeville/src/presentation/character-mode/AssetManager.js:244` `has()` only checks `missing`.

Problem:

- Missing quadrants can be drawn as checker tiles while the composed building is considered present.

Plan:

1. Track `ok` for each composed base cell.
2. If any required cell fails, mark the composed entry missing and record diagnostics.
3. Expose `getMissingDetails()` for debug output or `window.__claudeVillePerf`.
4. Keep optional overlay failure behavior separate from required base-cell failure.

Validation:

- Temporarily point a local manifest entry to a bad path in an uncommitted check, or unit-check `_loadComposedBuilding` via browser console.
- `npm run sprites:validate` remains passing.

### 2.6 Fix Dashboard First-Frame Detail Fetch

Evidence:

- `claudeville/src/presentation/dashboard-mode/DashboardRenderer.js:202` creates an `IntersectionObserver`.
- `claudeville/src/presentation/dashboard-mode/DashboardRenderer.js:481` fetches immediately on activation.
- `claudeville/src/presentation/dashboard-mode/DashboardRenderer.js:539` excludes idle cards not yet marked visible.

Problem:

- Visible idle cards may not fetch details until the next interval.

Plan:

1. On dashboard activation, render first.
2. Fetch selected and active agents immediately.
3. Wait one animation frame before adding visible idle agents, or include all rendered cards in the first fetch capped by `DETAIL_FETCH_LIMIT`.

Validation:

- Browser network panel or API logs on Dashboard open with idle agents.

## Phase 3: Widget And Tooling Integrity

### 3.1 Remove Or Rework Committed Widget Bundle

Evidence:

- `package.json:10` opens `widget/ClaudeVilleWidget.app`.
- `widget/ClaudeVilleWidget.app/Contents/Resources/project_path:1` contains `/Users/honorstudio/Desktop/dev/claude-ville`.
- `widget/ClaudeVilleWidget.app/Contents/Resources/node_path:1` contains a builder-specific fnm path.
- `widget/Sources/main.swift:561` uses these resources to start the server.

Problem:

- `npm run widget` can run a stale, non-portable binary.

Plan:

1. Remove tracked `widget/ClaudeVilleWidget.app/` from version control.
2. Add `widget/ClaudeVilleWidget.app/` and `widget/ClaudeVilleWidget` to `.gitignore`.
3. Change `npm run widget` to build first or fail with a clear message if the bundle is absent.
4. Keep generated `project_path` and `node_path` as build outputs only.

Validation:

- `npm run widget:build` on macOS with the Swift toolchain.
- `npm run widget` on macOS with the Swift toolchain.
- `git status --short` confirms no built bundle is tracked after build.

### 3.2 Choose One Widget UI Source

Evidence:

- `widget/Sources/main.swift:100` and `widget/Sources/main.swift:213` render inline HTML.
- `widget/Resources/widget.html` and `widget/Resources/widget.css` are copied by `widget/build.sh:21` and served by `claudeville/server.js:854`.
- Resource JS posts `badge`, but Swift registers `openDashboard`.

Problem:

- Future fixes may update only one of two active UI surfaces, leaving the browser-served widget or bundled widget stale.

Plan:

1. Choose Swift-generated HTML or resource HTML as the canonical implementation.
2. Do not remove `widget/Resources/widget.html` or `widget/Resources/widget.css` unless the `/widget.html` and `/widget.css` server routes are intentionally removed too; that route/docs work is out of scope for this pass.
3. Preferred short-term: keep both active surfaces working, eliminate only provably unmatched message handlers, and add comments at the two entry points explaining the temporary duplication.
4. Preferred long-term: load resource HTML from Swift and move inline HTML/CSS out of `main.swift`.

Validation:

- `npm run widget:build` on macOS with the Swift toolchain.
- Manual widget open.

### 3.3 Make Sprite Visual Diff Protective

Evidence:

- `scripts/sprites/capture-baseline.mjs:8` says all poses currently capture the same viewport.
- `scripts/sprites/capture-baseline.mjs:50` screenshots without applying `POSES`.
- `scripts/sprites/capture-baseline.mjs:25` and `visual-diff.mjs:12` currently point visual artifacts at `docs/superpowers/specs/...`, which is out of edit scope.
- `scripts/sprites/visual-diff.mjs:18` exits success when baselines are absent.
- `scripts/sprites/visual-diff.mjs:32` skips missing per-pose baselines.

Problem:

- `npm run sprites:visual-diff` can pass without validating meaningful visual regressions.

Plan:

1. Expose a deterministic browser hook such as `window.cameraSet({ x, y, zoom })`.
2. Make capture apply each pose before screenshot.
3. Store reviewed baseline files without `-fresh` suffix, or configure a baseline directory under a non-docs path such as `scripts/sprites/baselines/`; do not modify `docs/` as part of this remediation.
4. Make missing baselines fail unless `--allow-missing-baseline` is explicit.
5. Keep fresh and diff outputs ignored unless explicitly promoted.

Validation:

- `npm run sprites:capture-fresh`
- `npm run sprites:visual-diff`
- Confirm failure when a baseline is missing.

### 3.4 Align Sprite Generators With Manifest

Evidence:

- `generate-character-baseline.mjs` omits `agent.claude.haiku`.
- It writes `overlay.accessory.effortLow/Medium/High`, not manifest entries.
- `generate-pixellab-revamp.mjs:47` includes unmanifested buildings.

Problem:

- Running old scripts can create orphan assets or overwrite current assets with stale assumptions.

Plan:

1. Make generators read IDs, dimensions, modes, and overlay categories from `manifest.yaml`.
2. Remove or archive one-off hard-coded generation helpers that are not safe to run.
3. Add script preflight that refuses to write IDs not in manifest unless `--allow-unmanifested` is explicit.

Validation:

- `npm run sprites:validate`
- Dry-run generator mode lists only manifest IDs.

### 3.5 Fix Script Safety And Secret Handling

Evidence:

- `generate-pixellab-revamp.mjs:67` always reads token.
- `generate-pixellab-revamp.mjs:99` throws without `.dev.vars`.
- `generate-character-mcp.mjs:50` interpolates `unzip` args through shell.

Plan:

1. Read Pixellab token only when an API call will be made.
2. Replace shell string `execSync` with `execFileSync('unzip', ['-o', '-q', zipPath, '-d', extractDir])`.
3. Add a clear error if `unzip` is unavailable, or use a JS ZIP library if dependencies are acceptable.

Validation:

- `node scripts/sprites/generate-pixellab-revamp.mjs --skip-api --ids=<cached-id>` without `.dev.vars`, if cache exists.
- `node --check scripts/sprites/generate-character-mcp.mjs`

### 3.6 Align Runtime Vendor Dependencies

Evidence:

- `claudeville/vendor/js-yaml.min.js:1` is `4.1.0`.
- `package-lock.json` pins `js-yaml` `4.1.1`.
- `claudeville/index.html:19` loads the vendored file.

Plan:

1. Either update vendored runtime file to match lockfile or document a vendor-refresh script.
2. Prefer a small `scripts/vendor/refresh-js-yaml.mjs` only if future vendoring will recur.

Validation:

- Browser AssetManager manifest parse.
- `npm run sprites:validate`.

## Phase 4: Dead Code And Hygiene Cleanup

Only start this phase after P0/P1 behavior fixes land and after final `rg` checks.

### 4.1 Remove Confirmed Dead Runtime Code

Candidates:

- `claudeville/src/infrastructure/ClaudeDataSource.js:51` `getHistory()` calls missing `/api/history`.
- `claudeville/src/domain/entities/Task.js:1` has no imports.
- `claudeville/src/domain/value-objects/TokenMetrics.js:1` has no imports.
- `claudeville/src/presentation/character-mode/BuildingRenderer.legacy.js:118` has no import/constructor outside comments, but is referenced in the character-mode README as a historical reference/fallback.
- `claudeville/src/presentation/dashboard-mode/DashboardRenderer.js:552` `_fetchDetail()` appears unused.
- `claudeville/src/presentation/dashboard-mode/DashboardRenderer.js:68` `_sectionSignatures` is written/deleted but never read.
- `claudeville/src/presentation/character-mode/LightSourceRegistry.js:45` `supportedLightSourceKinds()` and `LightSourceRegistry` class appear unused.
- `claudeville/src/presentation/character-mode/PulsePolicy.js:22` `getPulseBandPolicy()` appears unused.
- `claudeville/src/presentation/character-mode/SpriteRenderer.js:37` `drawSheetCell()` appears unused.
- `claudeville/src/presentation/character-mode/SpriteRenderer.js:67` `drawSilhouette()` appears unused.

Plan:

1. Re-run `rg` per symbol immediately before removal.
2. Remove files or exports in small batches.
3. If an unused export is intentionally public, add a small comment at export site and leave it.
4. Treat `BuildingRenderer.legacy.js` as approval-gated: delete it only after the owner accepts removing historical fallback/reference code, or move it under the agreed agent/research artifact policy.

Validation:

- `find claudeville/src -name '*.js' -print0 | xargs -0 -n1 node --check`
- Browser World and Dashboard smoke.

### 4.2 Remove Or Consolidate Unused CSS

Candidates:

- `claudeville/css/modal.css:60` `agent-detail__*` legacy blocks.
- `claudeville/css/character.css:15` `#minimapCanvas` selector.
- Duplicate global `@keyframes pulse-dot` in `sidebar.css:162` and `dashboard.css:229`.
- Appended refinement layers in `topbar.css`, `dashboard.css`, `activity-panel.css`, `sidebar.css`, `layout.css`, and `character.css`.

Plan:

1. Namespace keyframes first.
2. Remove selectors with no DOM/class references.
3. Consolidate duplicate selector blocks per component.
4. Replace repeated stable colors with existing `--cv-*` variables where behavior is identical.

Validation:

- Browser visual smoke: World, Dashboard, Sidebar collapsed/expanded, ActivityPanel, Modal.

### 4.3 Clean Repository Artifacts

Evidence:

- Root PNGs such as `layering-before.png`, `layering-after.png`, `layering-debug-1.png`, `dashboard-quota-check.png`, `taskboard-hero-smoke.png`, `sonnet-loki.png`, and `valkyrie.png` are tracked outside the agent artifact convention.
- `.gitignore` ignores only `smoke-*.png`, `.playwright-cli/`, and `.playwright-mcp/` among capture outputs.

Plan:

1. Move intentional proof images under `agents/research/<slug>/`.
2. Remove obsolete transient captures from tracking.
3. Expand `.gitignore` for root capture patterns only after moving intentional files.

Validation:

- `git status --short`
- Manual review of moved/removed artifacts.

### 4.4 Document Or Reduce Duplicate Sprite Files

Evidence:

- `prop.gullFlight.png` and `prop.gullFlight.level.png` are identical.
- Some `building.watchtower/base-*` cells have identical hashes.

Plan:

1. Decide whether duplicates are intentional placeholders for grid geometry.
2. If intentional, add manifest comments or validator allowlist.
3. If not, support aliases or omit empty duplicate cells from loading.

Validation:

- `npm run sprites:validate`
- Browser World smoke around gulls and lighthouse.

## Phase 5: Shared Semantics And Small Abstractions

### 5.1 Centralize Tool Classification

Evidence:

- `Agent.js` owns target-building mapping.
- `VisitIntentManager.js` duplicates and expands the same classification.
- `LandmarkActivity.js` has separate command/task/token heuristics.
- Dashboard and ActivityPanel duplicate tool icon maps.

Plan:

1. Create `claudeville/src/presentation/shared/ToolIdentity.js` or domain-level equivalent.
2. Export:
   - `classifyTool(toolName, input)`
   - `toolIcon(toolName)`
   - `toolCategory(toolName)`
   - `normalizeToolInput(input)`
3. Replace callers incrementally:
   - `Agent.targetBuildingType`
   - `VisitIntentManager`
   - `LandmarkActivity`
   - `DashboardRenderer`
   - `ActivityPanel`
4. Keep behavior-compatible fixture examples from current regexes.

Validation:

- Browser World: agents route to the same buildings for file reads, edits, shell commands, web, browser, git, and subagent tools.
- Browser Dashboard and ActivityPanel icon smoke.

### 5.2 Centralize Formatting Helpers

Duplicated or drifting logic:

- `hashRows` in Dashboard and ActivityPanel.
- `status` normalization in multiple UI files and widget.
- `_formatTokens`, `_formatCost`, token/cost estimates in JS and Swift.
- `_shortProjectName` and `_truncatePath` with macOS-only `/Users/`.
- Provider badges/icons in Sidebar and Dashboard.

Plan:

1. Add focused JS helpers in `claudeville/src/presentation/shared/Formatters.js`:
   - `normalizeStatus`
   - `formatTokens`
   - `formatCost`
   - `hashRows`
   - `shortProjectName`
   - `truncateHomePath`
2. Support `/home/<user>` and `/Users/<user>` while keeping desktop-only layout.
3. For widget Swift, either accept duplication or expose server-side preformatted fields later. Do not block JS cleanup on Swift parity.

Validation:

- Browser smoke: Linux paths shorten correctly, macOS paths still shorten correctly.

### 5.3 Centralize Git Event Normalization

Evidence:

- `ChronicleEvents.js:7` normalizes commit labels.
- `HarborTraffic.js:644` has broader git-event normalization.
- `VisitIntentManager.js` has another normalization path for intent routing.

Plan:

1. Create one browser-side git event normalizer.
2. Make Harbor, Chronicle, and VisitIntentManager consume it.
3. Preserve current event IDs and labels unless a bug fix is intentional.

Validation:

- Browser World: Harbor ships, Chronicle monuments, and visit intents still react to commit/push events.

## Phase 6: Canvas Architecture And Performance

This phase should be split across multiple small implementation PRs or commits. It is high regression risk.

### 6.1 Extract Projection Helpers

Evidence:

- Canonical projection in `Camera.js:185`.
- Copies in `AgentSprite.js:389`, `BuildingSprite.js:2685`, `IsometricRenderer.js:4138`, `RelationshipState.js:125`, `ArrivalDeparture.js:37`, and `CouncilRing.js:8`.

Plan:

1. Create `claudeville/src/presentation/character-mode/Projection.js`.
2. Export tile-to-world, world-to-tile, tile-to-screen-with-camera, and screen-to-tile helpers.
3. Replace non-camera local copies first.
4. Keep `Camera` as the owner of viewport transform, but delegate math to shared helpers.

Validation:

- Browser World smoke: hit testing, clicking agents/buildings, minimap navigation, arrivals/departures, relationship arcs.

### 6.2 Introduce One Drawable Contract

Evidence:

- Sort anchors are split across `StaticPropSprite`, `IsometricRenderer`, `BuildingSprite`, and `HarborTraffic`.

Plan:

1. Define a drawable object shape:
   - `kind`
   - `sortY`
   - `draw(ctx, zoom, context)`
   - optional `bounds`, `layer`, `id`
2. Make building, props, harbor traffic, chronicle monuments, chronicler, landmark activity, and agents return this shape.
3. Centralize sort policy in one function.
4. Only after parity, optimize dirty sorting.

Validation:

- Browser World smoke with focus on building/agent occlusion, x-ray silhouettes, labels, Harbor, and monuments.

### 6.3 Split `IsometricRenderer.js`

Evidence:

- `IsometricRenderer.js` is 6,559 LOC and owns terrain, bridges, animals, weather hooks, lifecycle, labels, debug, and interaction.

Extraction order:

1. Projection and geometry helpers.
2. Static terrain and water cache renderer.
3. Bridge and scenery drawing.
4. Open-sea animal/fish/waterfall drawing.
5. Agent lifecycle and arrival/departure coordination.
6. Render pipeline orchestration.

Rules:

- Each extraction must preserve public renderer constructor and `show/hide` behavior.
- No visual redesign during extraction.
- Browser smoke after every extraction.

Validation:

- `node --check` on touched files.
- `npm run dev`; World and Dashboard smoke.

### 6.4 Reduce Per-Frame Allocation And Duplicate Work

Evidence:

- `IsometricRenderer.js:2227` enumerates drawables every frame.
- `IsometricRenderer.js:2252` sorts merged drawables every frame.
- `IsometricRenderer.js:2421` label assignment filters/sorts and builds rects repeatedly.
- `IsometricRenderer.js:2188` and `IsometricRenderer.js:5943` duplicate light-source collection.

Plan:

1. Cache static prop/building drawables and invalidate only on asset/building changes.
2. Track moved agents and dynamic drawables separately.
3. Compute light-source snapshot once per frame and pass it to reflections and atmosphere.
4. Reuse label-hit rectangles for the frame.

Validation:

- `/api/perf` where applicable.
- Browser performance panel manual comparison.

### 6.5 Make Motion Time-Based

Evidence:

- `BuildingSprite.js:251` and `BuildingSprite.js:2554` use fixed per-frame emitter probability.
- `ParticleSystem.js:225` update ignores `dt`.

Plan:

1. Pass `dt` through building emitter update and particle update.
2. Convert probabilities to rates per second.
3. Keep reduced-motion behavior intact.

Validation:

- Browser World smoke at normal and throttled FPS.
- Reduced-motion check if available.

### 6.6 Dispose Building Renderer Correctly

Evidence:

- `BuildingSprite.js:197` attaches a motion preference listener.
- `BuildingSprite.js:203` exposes `dispose()`.
- `IsometricRenderer.js:1205` does not call `buildingRenderer.dispose()`.

Plan:

1. Call `this.buildingRenderer?.dispose?.()` during `hide()`.
2. Recreate or rebind safely if renderer is shown again.

Validation:

- Toggle/reload renderer and inspect no duplicated media-query listeners.

## Phase 7: Validation Policy Improvements

1. Make `manifest-validator.mjs` fail on orphan PNGs unless allowlisted.
2. Add palette parity validation between `manifest.yaml` and `palettes.yaml`, or remove the duplicate palette source.
3. Add a no-generated-widget-bundle check if the bundle is removed from tracking.
4. Consider a lightweight static import graph script for unused ESM candidates. Keep it optional and read-only.

Validation:

- `npm run sprites:validate`
- `git status --short`

## Issue Inventory By File

Server and adapters:

- `claudeville/server.js`: static path prefix guard, oversized JSON body behavior, watch fallback visibility, WebSocket frame buffering, broad cache invalidation, always-`no-cache` branch, unused `teamsCache.signature`.
- `claudeville/adapters/codex.js`: active rollout discovery by date directory rather than mtime.
- `claudeville/adapters/claude.js`: tail-only token totals, whole-file parent session read for agent launches.
- `claudeville/adapters/gitEvents.js`: synthetic unpushed events replace observed commit events.
- `claudeville/adapters/gemini.js`: heuristic project path recovery remains uncertain and needs real examples.
- `claudeville/services/usageQuota.js`: UTC/local day boundary bug.

Application/domain:

- `DomainEvent.js`: listener exceptions break later listeners.
- `ClaudeDataSource.js`: `getHistory()` calls missing endpoint.
- `Task.js`: unused entity.
- `TokenMetrics.js`: unused barrel.
- `AgentStatus.js`: `COMPLETED` appears unused.
- `Settings.js`: redaction helper methods appear unused.
- `MonumentRules.js`: `foundingLayerReached()` appears unused.

DOM UI:

- `Sidebar.js`: unsafe attribute/class interpolation, macOS-only path shortening, duplicated project formatting.
- `ActivityPanel.js`: unsafe role interpolation, duplicated icons/hash/status/token formatting.
- `DashboardRenderer.js`: duplicated icons/hash/status/project formatting, `_sectionSignatures` unused, `_fetchDetail` unused, first-frame visibility candidate issue.
- `TopBar.js`: quota stale-state issue, duplicated cost formatter.
- `AvatarCanvas.js`: manifest version race.
- `Modal.css` and `character.css`: unused selectors.
- Component CSS: duplicate refinement layers, duplicate global keyframes, repeated hard-coded colors.

World/canvas:

- `Minimap.js`: stale domain positions.
- `AssetManager.js`: hidden composed building failures.
- `IsometricRenderer.js`: oversized class, duplicated projection/depth/light logic, per-frame allocations, missing `buildingRenderer.dispose()`.
- `BuildingRenderer.legacy.js`: approval-gated dead legacy renderer candidate because docs reference it as historical fallback/reference code.
- `BuildingSprite.js`: frame-rate-coupled emitters and lifecycle disposal dependency.
- `ParticleSystem.js`: `dt` ignored.
- `LightSourceRegistry.js`, `PulsePolicy.js`, `SpriteRenderer.js`: unused public surface candidates.
- `ChronicleEvents.js`, `HarborTraffic.js`, `VisitIntentManager.js`: duplicated git-event normalization.

Assets/scripts/widget:

- `widget/ClaudeVilleWidget.app`: tracked machine-specific bundle.
- `widget/Sources/main.swift`, `widget/Resources/widget.html`, `widget/Resources/widget.css`: divergent active UI surfaces.
- `scripts/sprites/capture-baseline.mjs` and `visual-diff.mjs`: non-protective visual diff.
- `scripts/sprites/generate-character-baseline.mjs`: stale manifest assumptions.
- `scripts/sprites/generate-pixellab-revamp.mjs`: stale hard-coded IDs and unnecessary secret requirement for skip-api.
- `scripts/sprites/generate-character-mcp.mjs`: shell interpolation for unzip.
- `claudeville/vendor/js-yaml.min.js`: stale relative to lockfile.
- Root PNGs: artifact hygiene cleanup needed.
- Duplicate sprite hashes: document or reduce.

## Suggested Implementation Order

1. P0 runtime and UI safety fixes: Codex discovery, token semantics, DOM escaping, minimap positions, composed asset failure handling, static path guard, JSON 413.
2. Validation and artifact policy: widget bundle removal, visual diff correctness, generator preflight.
3. P1 runtime resilience: watcher fallback, cache invalidation/cache-header cleanup, WebSocket buffering, event bus isolation, usage date boundary, git-event merge, TopBar quota reset, avatar race.
4. Dead-code cleanup: remove confirmed unused files/helpers and CSS selectors.
5. Shared helper extraction: tool identity, UI formatters, git event normalizer.
6. Canvas architecture: projection helpers, drawable contract, renderer extraction, frame-time motion, per-frame allocation reduction.
7. Repository hygiene: root artifact relocation, duplicate sprite policy, vendor refresh automation.

## Per-Slice Validation Matrix

- `server.js`: `node --check claudeville/server.js`; `npm run dev`; `curl http://localhost:4000/api/providers`; `curl http://localhost:4000/api/sessions`; relevant full-URL API edge-case curl.
- `adapters/*.js`, `services/*.js`: `find claudeville/adapters claudeville/services -name '*.js' -print0 | xargs -0 -n1 node --check`; API smoke.
- `src/**/*.js`: `find claudeville/src -name '*.js' -print0 | xargs -0 -n1 node --check`; browser World and Dashboard smoke.
- Sprite assets/scripts: `npm run sprites:validate`; after visual-diff repair, `npm run sprites:capture-fresh` and `npm run sprites:visual-diff`.
- Widget: `npm run widget:build`; `npm run widget`; both on macOS with the Swift toolchain only.
- CSS: browser visual smoke across World, Dashboard, Sidebar, ActivityPanel, Modal; no mobile tests.
- Repo hygiene: `git status --short`; confirm only intentional tracked files changed.

## Stop Conditions

- Stop and re-scope if a behavior fix requires broad visual redesign.
- Stop before deleting any tracked binary or root PNG if the team has not accepted artifact policy.
- Stop before changing token semantics in the UI if adapter totals cannot be made accurate cheaply.
- Stop before large renderer extraction if no browser smoke path is available.
