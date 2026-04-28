# ClaudeVille Fix And Performance Plan

Date: 2026-04-28
Baseline: `2284e20c708f82279fdd0de074c59abc49578273`
Initial worktree: clean

## Executive Summary

The April 28, 2026 desktop-wide failure was a real graphics-stack reset, not a normal ClaudeVille app crash. The current boot journal shows an `amdgpu` `gfxhub` page fault at 13:39:15, a `gfx_0.0.0` ring timeout at 13:39:17, KWin `GL_CONTEXT_LOST` and failed layer rendering at 13:39:18, plus Xwayland and Ghostty core dumps. No OOM-killer evidence was found, and the local Node server process was modest during inspection.

ClaudeVille is unlikely to be the direct driver bug, but it can plausibly contribute load: World mode continuously repaints a large canvas and creates large off-DOM canvas caches. A Playwright instrumentation pass at 1920x1080 DPR 2 found 500 canvas objects totaling about 71,058,577 backing pixels, roughly 271 MiB raw RGBA as a backing-store pressure proxy before browser/compositor overhead. The largest off-DOM cache was 6560x4000 pixels, roughly 105 MiB raw RGBA. Some 2D canvases may be CPU-backed, so this is not an exact GPU-memory measurement; it is still strong evidence of excessive graphics/compositor pressure. At DPR 2, the same headless browser pass showed World mode dropping to about 21 RAF callbacks/sec, while Dashboard mode still scheduled a continuous renderer RAF loop.

The highest-impact fix is to put hard pixel budgets around every canvas/cache, stop the world loop and release volatile canvas memory when World mode is hidden, then reduce server-side file parsing and UI polling fanout.

## Evidence Collected

- Host logs: `journalctl -b --no-pager -p warning..alert | rg -i 'amdgpu|drm|gpu|reset|GL_CONTEXT|kwin|Xwayland|chrome|chromium|oom|killed process'`.
- Runtime processes: `node claudeville/server.js` around 248 MiB RSS during inspection; no OOM signature in current boot.
- Browser measurement: existing `http://localhost:4000` server, local Playwright package, 1920x1080 DPR 1 and DPR 2. Treat the canvas pixel/RGBA counts as a pressure proxy, not literal GPU allocation.
- Static inspection: `App.js`, character renderer, server/adapters/services, dashboard/shared UI, widget, CSS.
- Subagent reports: canvas/GPU, server/lifecycle, dashboard/DOM, and host-log investigations.

Key code hot spots:

- Main canvas DPR sizing: `claudeville/src/presentation/App.js:270`, `App.js:278`.
- Large JS-added canvas shadow: `claudeville/src/presentation/App.js:250`.
- Dashboard-hidden RAF rescheduling: `claudeville/src/presentation/character-mode/IsometricRenderer.js:1704`.
- Terrain cache allocation: `claudeville/src/presentation/character-mode/IsometricRenderer.js:2471`.
- Sky cache allocation: `claudeville/src/presentation/character-mode/SkyRenderer.js:160`.
- Atmosphere vignette cache allocation: `claudeville/src/presentation/character-mode/IsometricRenderer.js:5950`.
- Trail cache allocation: `claudeville/src/presentation/character-mode/TrailRenderer.js:195`.
- Per-frame drawable rebuild/sort: `claudeville/src/presentation/character-mode/IsometricRenderer.js:2109`, `IsometricRenderer.js:2121`, `IsometricRenderer.js:2129`.
- Per-frame harbor event emission: `claudeville/src/presentation/character-mode/IsometricRenderer.js:2114`.
- Server 2s full broadcast scan: `claudeville/server.js:480`, `server.js:483`.
- Claude full-file `readLastLines`: `claudeville/adapters/claude.js:19`.
- Dashboard detail fanout: `claudeville/src/presentation/dashboard-mode/DashboardRenderer.js:371`, `DashboardRenderer.js:390`.
- Sidebar full DOM rebuild: `claudeville/src/presentation/shared/Sidebar.js:82`, `Sidebar.js:119`.
- ActivityPanel detail polling and full HTML replacement: `claudeville/src/presentation/shared/ActivityPanel.js:162`, `ActivityPanel.js:187`, `ActivityPanel.js:214`.

## Implementation Plan

### Phase 1: Canvas And GPU Guardrails

Goal: reduce browser/GPU backing-store pressure first, because this is the strongest ClaudeVille contribution path to a system graphics reset.

1. Add a canvas pixel-budget helper.

Scope:

- `claudeville/src/presentation/App.js`
- `claudeville/src/presentation/character-mode/IsometricRenderer.js`
- `claudeville/src/presentation/character-mode/SkyRenderer.js`
- `claudeville/src/presentation/character-mode/TrailRenderer.js`
- Optional new helper: `claudeville/src/presentation/character-mode/CanvasBudget.js`

Implementation details:

- Introduce constants such as `MAX_RENDERER_CANVAS_PIXELS`, `MAX_MAIN_CANVAS_PIXELS`, `MAX_SCREEN_CACHE_PIXELS`, and `MAX_WORLD_CACHE_PIXELS`.
- Enforce a combined renderer-owned canvas budget, not only per-canvas caps. At 1920x1080 DPR 2, one full-screen backing store is already about 8.3M pixels; main canvas plus sky, trail, and atmosphere caches can exceed 25M before terrain is counted.
- Compute effective DPR with `Math.sqrt(maxPixels / (cssWidth * cssHeight))`, clamped to `1 <= dpr <= Math.min(window.devicePixelRatio || 1, 2)`.
- Prefer DPR 1 for the full-world terrain cache. Pixel art does not benefit enough from DPR 2 to justify a 105 MiB terrain cache.
- Use the effective DPR stored on `canvas._claudeVilleDpr` as the only source for screen-space caches.
- Add a debug counter, e.g. `window.__claudeVillePerf.canvasBudget()`, reporting visible canvas pixels, volatile offscreen cache pixels, retained asset/cache pixels, DOM canvases, temporary scratch canvases where trackable, cache DPRs, and cache keys.

Validation:

- Open World mode at desktop viewport.
- Confirm main canvas and all screen caches remain under budget.
- Re-run the instrumented Playwright canvas-count pass; target total backing pixels below 25M at 1920x1080 DPR 2.
- `node --check` changed JS files.

2. Pause World mode instead of running an idle RAF loop in Dashboard mode.

Scope:

- `claudeville/src/presentation/character-mode/IsometricRenderer.js`
- `claudeville/src/presentation/App.js` if resize/mode handoff needs coordination.

Implementation details:

- Replace the current dashboard branch in `_loop()` with explicit loop control:
  - `_startLoop()` schedules exactly one RAF if none is pending.
  - `_stopLoop()` cancels `this.frameId`.
  - On `mode:changed` to `dashboard`, set `_worldModeActive = false`, cancel RAF, and call `releaseVolatileCaches()`.
  - On `mode:changed` back to `character`, restore `_lastFrameTime`, rebuild required caches lazily, then restart the loop.
- `releaseVolatileCaches()` should clear terrain cache, sky cache, atmosphere vignette, trail cache, light-gradient cache, and weather cache state where safe.
- `releaseVolatileCaches()` must actively release large owned canvas backing stores by setting `width`/`height` to `0` or `1` before dropping references where safe. Do not shrink shared asset canvases.
- Consider shrinking the hidden `worldCanvas` backing store to `1x1` while in Dashboard mode. If implemented, keep it in `App`, force a resize before restarting the renderer on return, and verify ModeManager display toggles have completed before recomputing size.

Validation:

- Instrument `requestAnimationFrame` again. Dashboard mode should no longer show a continuous renderer-driven RAF count.
- Switch World -> Dashboard -> World repeatedly; camera, minimap, selection, and world rendering must recover.

3. Handle graphics context loss and document visibility.

Scope:

- `claudeville/src/presentation/App.js`
- `claudeville/src/presentation/character-mode/IsometricRenderer.js`

Implementation details:

- Attach `contextlost` and `contextrestored` listeners to `worldCanvas`.
- On context loss, stop the renderer loop, prevent duplicate restart attempts, and release volatile caches.
- On context restore, reacquire the 2D context, force resize, invalidate/rebuild caches lazily, and restart only if World mode is active.
- Add a `document.visibilitychange` path: pause/release volatile caches when hidden; force resize and restart when visible and in World mode.

Validation:

- Simulate by dispatching events where possible and by manually toggling tab visibility.
- After context restore or visibility return, World mode must redraw without requiring a full page reload.

4. Remove large compositor-heavy CSS shadows around canvas surfaces.

Scope:

- `claudeville/src/presentation/App.js`
- `claudeville/css/layout.css`

Implementation details:

- Remove the JS-applied `inset 0 0 200px` shadow from the main canvas.
- Keep atmospheric edge darkening inside the canvas render pass, where it is already handled by the atmosphere/vignette layer.
- Simplify minimap shadow stacks in `layout.css:59` and `layout.css:89` to one outer shadow plus one border/inset at most.

Validation:

- Visual smoke: World mode still has acceptable edge treatment and minimap frame.
- Browser compositor surfaces should no longer include a large CSS shadow over the full world canvas.

5. Reduce per-frame allocation and sort churn.

Scope:

- `claudeville/src/presentation/character-mode/IsometricRenderer.js`
- Possibly `claudeville/src/presentation/character-mode/BuildingSprite.js`

Implementation details:

- Precompute static prop drawables produced by `_enumeratePropDrawables()`.
- Reuse a renderer-owned `this._drawables` array by clearing length, not allocating a fresh array each frame.
- Rebuild static drawable lists only when scenery/building definitions change.
- Keep dynamic lists for agents, harbor traffic, landmarks, chronicle monuments, and chronicler.
- Move `eventBus.emit('harbor:updated', harborPendingRepos)` behind a signature check so it is not emitted every render frame.

Validation:

- Confirm sort order and building occlusion remain correct.
- Measure allocations with Chrome Performance or heap timeline; per-frame object churn should fall.

6. Cache hot text layout.

Scope:

- `claudeville/src/presentation/character-mode/AgentSprite.js`

Implementation details:

- Cache `_drawBubble` truncation and width by `text|maxWidth|font|anchored`.
- Cache `_drawCompactNameStatus` fitted name and width by `agent.id|name|font|maxWidth`.
- Invalidate cached labels on agent name/status/tool/bubble text changes.

Validation:

- Long names and status bubbles still fit.
- Selected/unselected labels still render correctly at zoom buckets.

### Phase 2: Server IO, Polling, And Backpressure

Goal: stop ClaudeVille from repeatedly parsing large CLI logs and pushing work when nothing changed.

1. Make server broadcasts dirty-driven.

Scope:

- `claudeville/server.js`
- `claudeville/adapters/index.js`

Implementation details:

- Add a provider-data dirty flag set by file watchers.
- Put the dirty gate before expensive `getAllSessions()`, `getTeams()`, `usageQuota.fetchUsage()`, and payload signature work. The current signature check happens after expensive collection, so moving only the socket write gate is insufficient.
- Keep the 2s interval only as a cheap scheduler. If not dirty, skip full provider collection except for a slower correctness heartbeat such as 15-30s.
- Add a periodic full discovery scan that refreshes watch paths and watcher handles. This is required because current watch paths are registered once at startup and can miss new Claude project dirs, Gemini chat dirs, failed watches, or dropped `fs.watch` events.
- Replace simple TTL increases with mtime/signature-keyed caches plus dirty invalidation. `/api/sessions` and WebSocket `init` need either a force-refresh path or a deliberately short freshness TTL so manual refresh and new clients do not see stale data.
- Cache `getTeams()` by team directory/config mtime; broadcasts currently read teams every update.
- Log slow broadcast stages separately: sessions, teams, usage, signature, socket write.

Validation:

- `curl /api/sessions` still returns current data.
- Editing an active JSONL updates the UI promptly.
- Creating a new project/session is discovered without restarting the server, no later than the full discovery heartbeat.
- WebSocket `init` and REST `/api/sessions` stay fresh after cache changes.
- When idle, server CPU should fall below the current steady polling cost.

2. Replace full-file reads with bounded and mtime-keyed summaries.

Scope:

- `claudeville/adapters/claude.js`
- `claudeville/adapters/gemini.js`
- `claudeville/adapters/codex.js`
- `claudeville/services/usageQuota.js`

Implementation details:

- Port the Codex chunked tail-reader pattern into a shared local helper or duplicate conservatively in `claude.js`.
- Key parsed summaries by `{filePath, size, mtimeMs}`.
- Cover all Claude full-file call sites, not just `readLastLines()`: `readJsonLines()` is used for first prompt and agent launch detection.
- Add Gemini mtime-keyed summaries for active list parsing, tool history, messages, and git events; Gemini currently reads whole session JSON files in each of those paths.
- Maintain Codex and Gemini `sessionId -> filePath` indexes from session-list scans so detail lookups do not rescan directories.
- Compute detail, token usage, and git events from cached summaries while preserving their different scan windows. Git events currently need a much larger window than current tool/message fields, so either preserve the 5000-line event window or keep a separate git-event summary.
- Use bounded reverse reads for `usageQuota.readHistoryLive()` instead of `fs.readFileSync()` on the whole history file.

Validation:

- `node --check claudeville/adapters/claude.js claudeville/adapters/gemini.js claudeville/adapters/codex.js claudeville/services/usageQuota.js`.
- Compare `/api/sessions` before/after for active Claude, Codex, and Gemini sessions where available.
- Confirm token counts and current tool still populate.
- Confirm `gitEvents` still include commit/push/unpushed events across the preserved event window.

3. Batch and throttle session-detail fetching.

Scope:

- `claudeville/server.js`
- `claudeville/adapters/index.js`
- `claudeville/src/presentation/shared/SessionDetailsService.js`
- `claudeville/src/presentation/dashboard-mode/DashboardRenderer.js`
- `claudeville/src/presentation/shared/ActivityPanel.js`

Implementation details:

- Add a batch endpoint such as `/api/session-details` that accepts provider/session/project tuples and returns a map.
- Raise or mtime-key the server detail cache; current 1250ms is shorter than UI polling intervals and causes regular misses.
- In Dashboard mode, fetch details only for visible cards, selected agent, and active working/waiting agents. Use `IntersectionObserver` against the dashboard scroll container.
- Add a small concurrency cap, e.g. 3-5 detail fetches at a time.
- Cap Dashboard card history to 8-12 visible items; cap ActivityPanel histories to an explicit larger number.

Validation:

- Dashboard still fills tool histories.
- Selected ActivityPanel remains fresh.
- Network panel should show fewer request bursts.

4. Add WebSocket backpressure and dead-client cleanup.

Scope:

- `claudeville/server.js`

Implementation details:

- Before `socket.write(frame)`, skip or close sockets above a `writableLength` threshold.
- If `write()` returns false, mark socket as draining and avoid queuing additional update frames until `drain`.
- Add a concrete server-origin WebSocket ping frame or equivalent heartbeat timestamp for TCP activity, and close stale sockets. Do not rely on browser clients to send native ping frames; the current browser client only sends explicit app messages when asked.
- Keep this conservative; do not replace the handwritten WebSocket implementation unless separately approved.

Validation:

- Browser connects and receives `init`/`update`.
- Multiple browser tabs do not grow server memory under slow-client simulation.

### Phase 3: DOM/UI Resource Reduction

Goal: keep Dashboard and Sidebar smooth as session count grows.

1. Make Sidebar incremental.

Scope:

- `claudeville/src/presentation/shared/Sidebar.js`

Implementation details:

- Replace per-render row listener binding with one delegated `click` handler on `this.listEl`.
- Cache project sections and agent rows by id.
- On `agent:updated`, update only changed row text/classes unless project membership changed.
- Subscribe to `agent:selected` and `agent:deselected`; update only the previous and next selected rows so selection stays correct when selection originates from World or Dashboard.
- Stop calling `renderHarbor()` from ordinary agent renders; it already has a harbor signature path.

Validation:

- Agent select/deselect still works.
- Sidebar group counts update.
- Harbor rows update only on harbor changes.

2. Make Dashboard incremental.

Scope:

- `claudeville/src/presentation/dashboard-mode/DashboardRenderer.js`

Implementation details:

- Build on the existing `cards`, `_sectionEls`, and `_sectionRefs` maps instead of re-caching the same DOM. Store section/order signatures and per-card field signatures.
- On `agent:updated`, update the single card when project and sort bucket are unchanged.
- Full `render()` remains for add/remove, project change, or status-order change.
- Avoid unchanged text/style writes inside `_updateCard()`.
- Use cheap signatures for tool histories: length, newest timestamp, newest tool/detail prefix, not `JSON.stringify()` of mapped arrays.

Validation:

- Dashboard order stays correct.
- Card updates do not rewrite unrelated cards.
- Detail-fetch throttling from Phase 2.3 is validated together with incremental rendering; otherwise DOM savings can be hidden by request fanout.

3. Cache Dashboard avatars.

Scope:

- `claudeville/src/presentation/dashboard-mode/AvatarCanvas.js`

Implementation details:

- Add module-level caches:
  - image promise by `spriteId|assetVersion`
  - frame bounds by `spriteId|assetVersion|sourceRow`
  - optional pre-rendered avatar bitmap by `spriteId|effortTier|accent|assetVersion`
- Reuse loaded images instead of creating `new Image()` per card.
- Reuse bounds instead of per-card scratch `getImageData()`.

Validation:

- Dashboard avatars still match agent model identity.
- Adding many cards should not create one image decode per card.

4. Make ActivityPanel incremental and bounded.

Scope:

- `claudeville/src/presentation/shared/ActivityPanel.js`
- `claudeville/src/presentation/shared/SessionDetailsService.js`

Implementation details:

- Cap rendered tool and message lists explicitly.
- Replace `JSON.stringify()` array signatures with cheap signatures based on length, newest/oldest timestamp, and newest text/tool prefix after slicing.
- Avoid full `innerHTML` replacement when only one row changed; at minimum skip unchanged fragments after signature checks.
- Add `SessionDetailsService` deletion by agent/session key and call it on `agent:removed`; add age-based sweeping for stale entries.

Validation:

- ActivityPanel remains fresh for selected agents.
- Selecting a different agent resets signatures without retaining large stale payloads.

5. Add CSS containment and remove layout-width animations.

Scope:

- `claudeville/css/dashboard.css`
- `claudeville/css/sidebar.css`
- `claudeville/css/activity-panel.css`
- `claudeville/css/layout.css`

Implementation details:

- Add `contain: layout paint style` to repeated card/row/list surfaces only after checking hover, focus, and overflow effects.
- Limit `content-visibility: auto` to dashboard sections after measuring scroll stability; do not apply it broadly to active/selected surfaces.
- Test `.dash-card:hover` shadows/transforms for clipping before shipping containment changes.
- Replace layout-panel width animations with instant reserved layout or transform/opacity on already-sized panels. Target sidebar width transition and activity-panel slide keyframes; do not remove quota/progress bar width transitions.

Validation:

- Desktop-only layouts remain stable at 1280px+.
- No text overlap or clipped controls.
- No scroll jump with `content-visibility`.

### Phase 4: Widget Load Control

Goal: prevent the macOS widget from doubling server and polling load.

Scope:

- `widget/Sources/main.swift`
- `widget/Resources/widget.html` only if the implementation deliberately switches the Swift app to load bundled HTML.
- `widget/ClaudeVilleWidget.app/Contents/Resources/*` only through `npm run widget:build`; do not manually patch generated app-bundle resources unless the repo intentionally tracks build output for that change.

Implementation details:

- Choose one widget update path before editing:
  - Preferred conservative path: keep the current Swift-rendered HTML, implement health checks/readiness/poll throttling directly in Swift, and do not edit `widget/Resources/widget.html` for runtime behavior.
  - Larger follow-up path: switch the Swift app to load the bundled WebSocket `widget.html`, add any missing badge/status message handling, and treat `widget/Resources/widget.html` as the source.
- Before spawning Node in `startServerIfNeeded()`, call `/api/providers` with a short timeout and verify the response shape belongs to ClaudeVille.
- Track `ownsServer`; only terminate a server process the widget started.
- Replace the fixed startup sleep with readiness polling against `/api/providers`.
- If throttling REST polling based on browser clients is desired, first add a server-exposed client count. The widget cannot currently know whether a browser client is connected.

Validation:

- `npm run widget:build`.
- On macOS, `npm run widget` starts one server at most.
- If the Swift path is kept, confirm changes affect the live widget by inspecting `webView.loadHTMLString()` behavior rather than only bundled HTML files.

### Phase 5: Measurement And Regression Guardrails

Goal: make future performance regressions visible without adding a full test runner.

Scope:

- Existing runtime files plus optional docs under `docs/troubleshooting.md`.
- Optional dev script under `scripts/` if useful and dependency-free.

Implementation details:

- Add a debug-only browser helper exposed as `window.__claudeVillePerf`, including:
  - effective DPR
  - main canvas pixels
  - volatile offscreen cache pixel estimates
  - retained asset/cache pixel estimates where safely trackable
  - RAF active/paused state
  - renderer cache counts
  - visible agent/card counts
- Add server perf counters for:
  - broadcast duration
  - adapter cache hits/misses
  - session detail cache hits/misses
  - active websocket clients and skipped writes
- Document the host-level measurement commands for GPU resets:
  - `journalctl -f -p warning..alert | rg -i 'amdgpu|drm|gpu|reset|GL_CONTEXT|kwin|Xwayland|chrome|oom|killed process'`
  - `watch -n 1 'free -h; ps -eo pid,comm,%cpu,%mem,rss --sort=-rss | head -n 15'`

Validation:

- No production UI text changes unless explicitly intended.
- No install, bundler, linter, app test runner, or CI additions.
- Measurement wording must distinguish proxy backing-store estimates from exact GPU-memory allocation.

## Suggested Implementation Order

1. Phase 1.1-1.4: combined canvas budget, dashboard pause/release, context-loss/visibility handling, CSS shadow removal.
2. Phase 2.1-2.2: dirty-driven broadcasts and bounded Claude/history reads.
3. Phase 2.3-2.4: detail batch/throttle and WebSocket backpressure.
4. Phase 3.1-3.5: Sidebar/Dashboard/Avatar/ActivityPanel/CSS optimization.
5. Phase 4: widget load controls.
6. Phase 5: permanent measurement helpers and troubleshooting docs.

This order handles the most likely graphics-reset amplification first, then reduces CPU/IO churn, then improves DOM scalability.

## Acceptance Criteria

- World mode at 1920x1080 DPR 2 creates less than 25M total tracked renderer-owned volatile canvas backing pixels after initial load. Run at least one larger desktop check as well, such as 2560px-wide, 4K, or ultrawide, and document the resulting effective DPR.
- Dashboard mode does not keep a renderer-driven RAF loop alive. Other browser/UI RAF usage may still exist.
- Switching World <-> Dashboard ten times does not grow tracked retained/volatile canvas backing pixels after explicit cache release and reasonable garbage-collection opportunities.
- World mode recovers visually after volatile cache release, tab visibility return, and canvas context restore handling.
- Server idle polling no longer reparses all adapters every 2 seconds.
- New project/session discovery works without server restart within the discovery heartbeat.
- `gitEvents` remain correct across the preserved scan window.
- `/api/sessions`, `/api/providers`, `/api/usage`, and session detail paths still work.
- Browser World + Dashboard smoke test passes at desktop width >= 1280px.
- Synthetic high-count desktop smoke passes with 100-250 agents: Dashboard open, ActivityPanel open, Sidebar toggle, select/deselect from Sidebar and Dashboard, no unrelated card rewrites, no scroll jump, no detail-request burst beyond the concurrency cap, and no text overlap.
- `git status --short` contains only intentional plan/code changes at each handoff point.
