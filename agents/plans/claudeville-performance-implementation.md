# ClaudeVille Performance and Stability Implementation Plan

Status: `historical` - implemented from the live v0.24.2.1 source and released as v0.25.0 on 2026-07-14.

Execution status: all planned code phases are implemented. The Linux/browser gates pass; native macOS widget and live Plasma memory checks remain platform-only validation because those runtimes are unavailable on this Linux host.

Baseline commit: `bb4b311` (`release: v0.24.2.1 Codex model detection hotfix`)

### Implementation record

| Phase | Delivered result | Verification evidence |
| --- | --- | --- |
| 0 - diagnostics | Bounded `/api/perf` telemetry now covers process/event-loop memory, physical and logical watcher topology, dirty scopes, broadcast stages, git rate, provider/cache bytes, JSONL parsing, and World state. `performance-soak.mjs` is the non-mutating 10-minute browser / 30-minute server release gate. | Telemetry rings and cache snapshots have fixed bounds. The final short gate held 52 DOM listeners, 103 event-bus listeners, and a 1,024-entry fade cache; full-duration evidence is recorded below. |
| 1 - watchers | Replaced recursive history watches with canonical shallow discovery descriptors, exact active files, capped dynamic watches, bounded stat probes, slow reconciliation, client-aware retirement, and deterministic shutdown. | Current corpus: 44,669 baseline kernel watches -> 59 final peak. Topology and runtime fixtures cover append, discovery, rotation/truncation, watcher-cap probing, reconnect, and zero-client retirement. Runtime smoke: detail 79.4 ms, health 1.8 ms, append git commands 0, session-stage max 1 ms. |
| 2 - adapters/transcripts | Added dirty descriptors and project/provider-scoped invalidation; split git status and unpushed-event caches; made Claude aggregation compact, incremental, asynchronously chunked, byte-bounded, and cancellable; bounded shared tails, usage history, provider indexes, and Codex warm discovery. | Claude fixture read 14,513,028 bytes with 147 forced byte-budget evictions, retained 129 warm sessions with no second-pass full scans, and canceled active/queued scans without late mutation. A 25 MiB usage fixture read 5,308,416 bytes in at most 64 KiB operations. Codex: 3,002 cached files, one warm stat, stable 3,200 cap. Live ordinary discovery stats only 3-4 warm files. |
| 3 - World bounds | Bounded fade/cooldown/event/Harbor/replay identity state, added replay floors/tombstones, and made visit replay sharing versioned. | 4,800-event Harbor ingest 72.5 ms; cached reconciliation 0.2 ms; 100-agent shared ingest/steady 18.8/14.0 ms. Twenty shared-repository visit reconciliations completed in 3.8 ms. Bounds smokes pass. |
| 4 - browser lifecycle | Made App boot/destroy single-flight and staged, drained chronicle writes before close, added owner teardown across UI/services, guarded late requests/clipboard work, fixed socket reconnect races, bounded workflow state, and suspend/resume audio by visibility. | 250 World/Dashboard switches preserve listener counts. Destroy/reboot, destroy-during-boot, injected boot failure, slow SessionDetails, real AudioContext visibility, clipboard-after-destroy, frame breaker, and context loss/restoration all pass with no browser errors. |
| 5 - assets | Derived masks/outlines only for interactive buildings, exposed pixel/byte diagnostics, disposed canvases/bitmaps on teardown, and normalized finite sprite variant keys. | Live retained derived assets are 1,168,499 pixels instead of the former character-sheet-wide buffers; teardown reports zero bitmaps, masks, outlines, missing assets, and retained pixels. Building validation and desktop captures preserve hit/outline appearance. |
| 6 - measured hot paths | Precomputed invariant water descriptors without changing time formulas/draw order; versioned unchanged Harbor/visit work; removed repeated Dashboard geometry scans; added bounded frame-failure recovery. | Exact water trace stayed unchanged and the isolated descriptor benchmark improved 30.8%. Real update/render failure injection pauses on the third failure, reports the trip, and recovers; context restoration rebuilds volatile buffers. No scene-density, DPR, cadence, or visual-quality reduction was made. |
| 7 - widgets | macOS now keeps a stable popover shell, updates through `evaluateJavaScript`, single-flights refresh, and reuses its dashboard WebView. KDE guards terminal XHR states and aborts superseded batches. | Static widget, pricing, bundle, and KDE checks pass on Linux. Native memory/process-cycle acceptance remains for macOS and a live Plasma session. |
| 8 - delivery | Self-hosted the exact Press Start 2P WOFF2 plus OFL license in browser and widget bundles; versioned font/sprite requests receive immutable caching while source/unversioned resources stay `no-cache`. | Browser and widget font checks pass; desktop World/Dashboard captures at 1280x720, 1600x1000, and 2560x1440 retain the existing town and UI. |

## 1. Objective

Remove proven memory/resource growth, prevent stale or overlapping work, and improve the measured hot paths without changing ClaudeVille's town composition, animation layers, sprite appearance, interaction model, API payloads, or two-second freshness contract.

This is a performance and stability plan, not a rewrite. It preserves:

- the zero-build, dependency-free browser and server runtime;
- the hand-written WebSocket protocol and current HTTP/API shapes;
- World and Dashboard behavior, agent selection, audio mix, weather, water, harbor, scenery, and animation density;
- the existing `CanvasBudget` quality behavior and all sprite assets;
- desktop-only support at viewports at least 1280 px wide;
- current polling cadences unless a phase explicitly replaces work with an equivalent bounded probe.

The requested `/asgents/` path is treated as a typo. This retained plan follows repository policy and lives under `agents/plans/`.

## 2. Audit Scope And Method

The audit covered the complete runtime surface:

| Area | Reviewed and measured |
| --- | --- |
| Server | HTTP, WebSocket clients, dirty/broadcast flow, file watching, recursive fallback, timers, shutdown, `/api/perf` |
| Providers | Claude, Codex, Gemini, Grok, Kimi, OpenCode discovery, transcript parsing, tail caches, invalidation, git enrichment |
| Browser application | boot/destroy, mode switching, polling, event subscriptions, panels, Dashboard cards, IndexedDB-backed chronicle services |
| World renderer | render loop, canvas budgets, water/harbor passes, particles, gradients, color caches, event streams, debug globals |
| Assets | manifest loading, bitmap decode, alpha masks, outline canvases, font delivery |
| Audio | activation, visibility handling, timers, Web Audio suspension |
| Widgets | macOS Swift/WKWebView and KDE QML/XHR lifecycles; these were statically audited on Linux and require platform validation |

Runtime work used the maintained server at `http://localhost:4000`, Linux `/proc` watcher/RSS inspection, Playwright/CDP forced-GC sampling, browser resource counts, mode churn, request timing, and an 8.1-second CPU profile. Headless FPS values are directional baselines, not product targets.

## 3. Executive Diagnosis

There is no single conventional leak. The largest server problem is history-scaled resource retention: 61 logical recursive watch roots expand to tens of thousands of kernel subscriptions. Separately, provider invalidation repeatedly destroys useful incremental state and drives synchronous git and transcript work. In the browser, several maps/sets genuinely grow for as long as World mode remains open.

### 3.1 Confirmed high-priority findings

| Priority | Finding | Evidence | Consequence |
| --- | --- | --- | --- |
| P0 | Recursive provider watchers scale with all historical files | `/api/perf` reported 61 logical paths while Linux reported 44,669 inotify watch entries; 44,667 unique entries existed below the roots | OS watch pressure, startup cost, and resource growth as history accumulates; the observed process was 281-309 MiB RSS, with the watcher-attributable share to be isolated in Phase 1 |
| P0 | Claude token/launch parsing can retain or transiently parse a whole transcript | `_tokenUsageCache` stores parsed entry arrays; one local inactive transcript is 4.3 GiB | Resuming or inspecting a very large session can block the event loop or OOM |
| P0 | Provider writes globally invalidate adapter and git caches | A 376-second sample executed 9,032 synchronous git commands, spending 39.8 seconds in git with 27 cache hits; later `/api/perf` reached 13,070 commands / 53.1 seconds | Sustained CPU, event-loop stalls, repeated transcript parsing, and slow broadcasts |
| P0 | `IsometricRenderer.lightFadeColorCache` is unbounded | Forced-GC soak: 240 to 5,103 entries in 30 seconds, about 160 new entries/second; heap rose from 9.7 to 15.6 MiB | Monotonic heap growth during uninterrupted World sessions |
| P1 | Harbor/event dedupe state is statically unbounded and cloned during frame updates | `HarborTraffic.seenEventIds` and `pushEvents` never prune; `cloneState` copies them; `AgentEventStream.emittedToolKeys` never retires keys | Event-churn fixtures and Phase 0 counters must establish the retained replay bound and runtime slope before changing behavior |
| P0/P1 | Partial boot and explicit destroy do not release every owned resource | Listener probe after `App.destroy()` still found mode, cinema, modal, and event-bus handlers; an open hero avatar remained registered | Reboot/failure paths can leave polling, listeners, DOM, canvases, and services alive |
| P0/P1 | macOS widget recreates page state and dashboard WebViews | Popover calls `loadHTMLString()` on changing data; a closed non-released dashboard window is not reused | Repeated navigation/page-cache pressure and multiple WKWebViews across reopen cycles |

The RSS number above is the whole observed Node process, not an estimate of memory owned by inotify. Phase 1 must compare the same corpus before/after and report RSS/native-memory deltas separately from the proven watch-count reduction.

### 3.2 Important correctness and bounded-growth findings

- The two-second server interval is not a real watch backstop. `broadcastUpdate()` returns when provider data was not already marked dirty, so a missed watch notification can remain stale indefinitely.
- Recursive fallback compares project working directories with provider-storage directories and can incorrectly treat an active provider directory as idle. Its shared 2,000-entry budget subtracts files found rather than entries traversed.
- Codex rollout indexes, git project/branch maps, server fallback caches, Claude orphan/collision maps, Gemini hash maps, sidebar workflow sets, and several World cooldown/dedupe maps lack eviction tied to live data.
- `SessionWatcher` permits overlapping two-request polls and does not reject a late result after `stop()`.
- Biography, affinity, and trail flushes can race `ChronicleStore.close()`. A destroy probe produced `BroadcastChannel`-closed warnings and risks dropping final writes.
- Removed agents retain Dashboard card/canvas state while World remains active.
- Relationship affinity preload can retain expired records because it occurs before storage pruning.
- `ChronicleMonuments` has no dispose path for its `harbor:repo-christened` subscription; repeated renderer construction can keep prior monument graphs alive.
- `LandmarkActivity.previousTokenTotals` / `lastForgeByAgent` and `CouncilRing._lastTeamGatherEmittedAt` are not reconciled with current agents/teams.
- Sound-enabled hidden tabs stop directors but can leave their `AudioContext` running, and an activation race can restart while hidden.
- KDE XHR can complete twice through `readystatechange` plus `onerror`/`ontimeout`, allowing overlapping refresh state.
- `Pathfinder` returns a cached path array directly while a later stitching path mutates segments with `shift()`, which can corrupt future cached routes.

### 3.3 High baseline costs that are not leaks

| Cost | Baseline | Treatment |
| --- | --- | --- |
| Eager asset-derived buffers | 160 masks and 160 outline canvases; masks total about 15.7 MiB and outline backing can approach 63 MiB RGBA, mostly from character sheets | Remove unused derived buffers first; do not broadly lazy-load sprites until remeasured |
| Composed/processed sprite sheets | Module-global canvases are about 2.58 MiB RGBA each; key space is finite but can retain many model/accessory/color variants across App lifetimes | Normalize duplicate variant keys now; add an instance/pixel budget only after measuring live key growth |
| Startup requests | 250 resources / 6.36 MiB in a fresh run; PNGs were about 5.15 MiB | Keep zero-build loading; consider exact-font self-hosting and versioned sprite caching after memory work |
| World frame time | Directional headless samples: about 55 FPS at 1280x720, 39 FPS at 1600x1000, 31 FPS at 2560x1440 with CanvasBudget reducing DPR | Preserve scene quality; optimize only CPU-profiled repeated calculations |
| Dashboard DOM | Six cards and avatar canvases remain materialized when hidden | Intentional and small; clean removed agents, but do not virtualize the current six-card view |

### 3.4 Areas already behaving correctly

Do not rewrite these without new evidence:

- WebSocket clients are removed on close/error, slow-client output is latest-only, receive/body sizes are capped, and no orphan child processes were observed.
- Session-detail and parser caches, recent broadcast telemetry, particle counts, ritual counts, and gradient pixel/count caches already have bounds.
- Tail readers and SQLite handles close in `finally` paths.
- Ordinary World/Dashboard switching is not leaking: 250 additional switches kept event-bus listeners at 103, DOM event listeners at 421, six cards, and seven avatar canvases; forced-GC heap fluctuated rather than rising monotonically.
- World mode stops its rAF and releases volatile caches when hidden; `lightGradientCache` is already LRU/pixel bounded.
- `lastBroadcastState` retaining one canonical snapshot is intentional.

## 4. Guardrails And Success Rules

Every implementation phase must obey these rules:

1. **Visual identity is immutable.** Do not remove water passes, harbor traffic, particles, weather, scenery, animations, buildings, sprites, labels, or audio layers. Do not reduce animation rates or quality budgets as a performance shortcut.
2. **Pixel-preserving first.** Cache eviction may change reuse, never computed values. Render optimizations may precompute invariant inputs, never reorder draw calls or change formulas. Deterministic World screenshots must remain pixel-identical unless a browser rasterization tolerance is documented before the change.
3. **Bound by bytes or lifecycle, not only item count.** Large transcript/tail/bitmap-related caches need byte budgets or constant-memory representations. Identity/dedupe collections need a replay-window-derived TTL/LRU and removal hooks.
4. **Keep freshness.** Active session updates must still arrive within the existing two-second backstop; new-session discovery and file rotation/truncation must be covered.
5. **Measure before and after each wave.** Keep a change only if it removes proven growth, fixes correctness, or materially improves its measured hotspot. Revert speculative complexity that does not move the recorded metric.
6. **No new runtime dependency or build step.** Test scripts may use the already available development tooling.
7. **Desktop only.** Validate at 1280x720, 1600x1000, and 2560x1440. Do not add media queries or mobile work.

## 5. Delivery Plan

The server work deliberately serializes changes to `server.js` and adapter invalidation. File-disjoint browser, World, and widget work can proceed in parallel after the baseline harness lands.

### Phase 0 - Minimal diagnostics and reproducible baselines

**Purpose:** make regressions and improvements observable without turning diagnostics into another workload.

Owned paths:

- `claudeville/server.js`
- adapter diagnostic snapshots in `claudeville/adapters/`
- a focused script under `scripts/smoke/` if the existing scripts cannot express the soak
- World debug budget output in `IsometricRenderer.js` / `HarborTraffic.js`

Work:

- Extend `/api/perf` with sampled `process.memoryUsage()`, event-loop delay, physical watcher count when cheaply available, watcher topology/cap counts, cache entry and estimated-byte counts, bytes parsed, full versus incremental transcript scans, dirty/invalidation reason, and git command rate/time.
- Preserve the existing 25-entry telemetry rings. Do not sample heap or walk `/proc` per render/broadcast.
- Add a desktop Playwright soak that records forced-GC heap, `lightFadeColorCache`, Harbor dedupe/event counts, agent-event key counts, DOM/listener/avatar counts, and frame timing at fixed checkpoints.
- Add a Linux watcher-footprint smoke helper that gracefully skips non-Linux platforms.
- Capture deterministic World and Dashboard screenshots before implementation. Freeze scenario input, clock, RNG seed, weather, camera, simulation step, and animation frame for day/night, harbor activity, agent selection, and building hover/outline.

Exit gate:

- Baseline command completes without mutating provider data.
- Diagnostics have fixed bounds and add no measurable render-loop work.
- The evidence table in this plan can be reproduced or updated with the new baseline.

### Phase 1 - Replace history-scaled watcher topology

**Priority:** P0. Implement before adapter micro-optimizations.

Owned paths:

- `claudeville/server.js`
- each adapter's `getWatchPaths()` or replacement watch-descriptor API
- focused watcher smoke fixtures/scripts

Work:

1. Replace broad recursive roots with adapter-specific bounded descriptors:
   - non-recursive discovery watches at stable provider roots;
   - shallow watches for current/recent project or date directories needed to discover new sessions;
   - exact active session files or their immediate parent directories for append updates;
   - separate infrequent reconciliation for historical discovery.
2. Canonicalize paths and install one OS watcher per path. Union relevant filename/kind filters instead of registering duplicate Grok/Kimi roots.
3. Add a hard cap and retirement policy for dynamic watches. Keep active sessions, then recent sessions, and fall back to stat probes when the cap is reached.
4. Install deep/active watches on the first WebSocket client and retire them after a short zero-client grace period. HTTP requests still perform bounded on-demand discovery.
5. Turn the two-second interval into a genuine cheap backstop for known active sources. Add a slower maximum-age reconciliation so missed watch events cannot leave stale state forever.
6. Fix recursive fallback accounting to return `entriesScanned`, enforce one shared budget, compare provider-storage paths correctly, and force a maximum-age rescan.
7. Explicitly close failed watchers before removing/retrying them. Centralize watcher/timer shutdown for `SIGINT` and `SIGTERM`.

Acceptance:

- On the current 44,669-entry corpus, kernel watches are below 1,000 and scale with active/recent sessions plus a fixed shallow-root cost, not total history.
- Adding 10,000 inactive historical files does not materially increase installed watches after reconciliation.
- Append, new session, rename, rotation, truncation, provider-directory creation, and deliberately suppressed watch-event fixtures are visible within the two-second active backstop or the documented discovery reconciliation bound.
- Reconnect churn does not duplicate watchers; zero WebSocket clients releases dynamic watches after the grace period.
- API and WebSocket payloads are byte-for-byte compatible for the same canonical state.

### Phase 2 - Make transcript and invalidation work incremental

**Priority:** P0. Start after Phase 1 because it overlaps `server.js` and adapter cache ownership.

Owned paths:

- `claudeville/server.js`
- `claudeville/adapters/index.js`
- `claudeville/adapters/claude.js`
- `claudeville/adapters/shared.js`
- `claudeville/adapters/gitEvents.js`
- provider adapters with measured discovery/index retention

Work:

1. Introduce a dirty descriptor such as `{provider, path, kind, reason}`. Split invalidation into session list, affected session detail, team/config/account, adapter discovery, and git-project scopes.
2. Preserve stat/signature-valid adapter caches across unrelated transcript appends. Invalidate git status only for actual `.git` state changes, scoped to the affected project.
3. Reuse the last canonical session/active-project snapshot for the two-second git-state probe. Do not call full `getAllSessions()` merely to decide whether a no-op broadcast is needed.
4. Replace Claude's parsed-entry cache with constant-memory incremental state: offset, inode/identity, guard bytes, trailing partial, aggregate usage, and launch metadata. Handle first load, append, rewrite, truncation, rotation, malformed lines, and UTF-8 chunk boundaries.
5. Keep oversized first aggregation off the server event loop. Use a cooperative asynchronous chunk scanner or a built-in worker, publish the compact aggregate when ready, and return the last known/pending-compatible summary without blocking the current API/broadcast. Define the unchanged-schema pending behavior before implementation.
6. Make full-file agent-launch discovery use the same constant-memory, off-event-loop initial index rather than its current `readFileSync()` path. No code path may allocate or synchronously block proportional to a multi-gigabyte transcript.
7. Consolidate shared tails to one per-file largest window and derive smaller views, with an aggregate byte budget in addition to entry count.
8. Prune historical indexes against current discovery/live-project sets and add conservative TTL/LRU caps to Codex rollout maps, git project/branch maps, server fallback caches, Claude orphan/collision maps, and Gemini hash mappings.
9. Retain a real periodic reconciliation. Correctness cannot depend exclusively on lossy filesystem notifications.
10. Make fatal server shutdown deterministic: cleanly close intervals/watchers/sockets for signals; after an `uncaughtException`, perform bounded cleanup and exit nonzero rather than continuing in an unknown state.

Measurement gate before broader rewrites:

- First land scoped invalidation and incremental Claude parsing, then reprofile.
- Convert synchronous git execution to queued/asynchronous work only if p95 broadcast/event-loop delay remains above the baseline target. Do not introduce concurrency before removing the invalidation storm.
- Optimize OpenCode's full `part`-table aggregation or other provider history scans only when their per-provider counters show meaningful wall time on an active workload.

Acceptance:

- A transcript append invalidates only the affected provider/session state and performs an incremental byte scan.
- A sparse multi-gigabyte Claude fixture can be summarized under a fixed memory ceiling without blocking unrelated API/health requests; heap is independent of file length, event-loop delay stays within the recorded budget, and scan time is proportional to bytes only on the initial index.
- On the same five-minute active workload, git command count/time falls at least 90 percent, git cache hit rate rises materially, and no provider append globally clears git caches.
- Warm no-change intervals perform only bounded probes. Broadcast session-stage p95 is below 250 ms on the audit machine, with no multi-second outliers caused by full transcript/git rescans.
- Deleted/renamed files and inactive projects leave all historical cache maps after their TTL/reconciliation window.

### Phase 3 - Bound World-mode runtime state without changing pixels

**Priority:** P0 for the measured fade-color leak. Harbor/tool/landmark bounds are P1 and evidence-gated by Phase 0 counters plus a synthetic event-churn fixture.

Owned paths:

- `claudeville/src/presentation/character-mode/IsometricRenderer.js`
- `claudeville/src/presentation/character-mode/HarborTraffic.js`
- `claudeville/src/presentation/character-mode/AgentEventStream.js`
- the owning World lifecycle modules for renderer hide/destroy

Work:

1. Bound `lightFadeColorCache` with a small LRU/FIFO while returning exactly the same color string for every input. Do not quantize alpha unless deterministic pixel comparison proves no difference; eviction alone is sufficient.
2. Record Harbor/tool/landmark retained counts during normal soak and a deterministic thousands-event churn fixture. Continue the following pruning work only when counts exceed a documented replay/live-identity bound; the fixture itself may supply that proof.
3. Give Harbor push events an explicit visible/replay horizon. Prune `pushEvents` once they cannot affect the scene and retain event IDs only for the upstream replay window plus a conservative grace period.
4. Stop cloning Harbor event/dedupe collections on every frame. Reconcile new push input when its state/version changes, while preserving draw order and event timing.
5. Retire `AgentEventStream.emittedToolKeys` when an agent is removed and when keys fall outside the bounded upstream/chat replay window. Use a per-agent capped LRU only if replay tests require longer dedupe.
6. Delete expired `_crowdBumpCooldowns` during its existing update path and enforce a small safety cap.
7. Add `HarborTraffic.dispose()` and clear `window.__harbor` only when it points at the disposed instance. Release retained renderer/assets/event subscriptions on World hide/destroy as appropriate.
8. Prune `LandmarkActivity.previousTokenTotals` / `lastForgeByAgent` against live agents, add a dispose hook, and reset/bound CouncilRing's team-emission map across renderer/team lifetimes.
9. Audit any remaining team/agent cooldown maps against current World membership and apply the same lifecycle rule only where keys can be user/session-generated. Do not create a standalone task for the tiny `CrowdClusterOverlay` count-string cache; remove it only opportunistically if that module is already touched.

Acceptance:

- A 10-minute continuously active World soak reaches fixed cache/dedupe plateaus; after forced GC, heap has no sustained positive slope beyond normal bounded state variation.
- `lightFadeColorCache` never exceeds its documented cap; its 30-second baseline no longer grows from 240 to thousands.
- Harbor state update allocation/time does not increase with total historical pushes.
- Agent removal retires event/cooldown state without replaying visible tool events.
- Fixed-state screenshots and pixel diffs are identical at all three desktop viewports.

### Phase 4 - Complete browser lifecycle and polling ownership

**Priority:** P1, except boot/destroy leaks are P0 for embedders/retry paths.

Owned paths:

- `claudeville/src/presentation/App.js`
- `claudeville/src/application/ModeManager.js`
- `claudeville/src/application/SessionWatcher.js`
- `claudeville/src/presentation/shared/{TopBar,Modal,ActivityPanel,Sidebar,AmbientAudioController}.js`
- `claudeville/src/presentation/dashboard-mode/DashboardRenderer.js`
- chronicle biography/affinity/trail/store services and `ChronicleMonuments.js`

Work:

1. Give `App.boot()` one in-flight promise/state guard and one idempotent asynchronous cleanup path. A failure at any awaited stage must release everything already created before rendering the boot error.
2. Mount a newly loaded World renderer through a local owner and hide/dispose it if `_loadRenderer()` fails partway. Do not leave a partially shown renderer after the current swallowed error path.
3. Store named callbacks and add missing destroy hooks for ModeManager buttons, TopBar cinema/event-bus state, Modal overlay, `ChronicleMonuments`, and the simulator. Null owned object references after teardown.
4. Make `ActivityPanel.destroy()` invalidate async generations, tear down its hero portrait/AvatarCanvas, clear selection/mode, remove panel-open state, and release owned DOM without emitting user actions.
5. Stop chronicle event intake, await biography/affinity/trail mutation tails and flushes, then close `ChronicleStore`/BroadcastChannel. Make repeat destroy safe. Add a best-effort page-exit path without relying on async completion during unload.
6. Prune storage before affinity preload or query only records inside the 30-day retention window. Keep lifetime biographies as a product feature; only delete settled mutation-tail promises and evict rehydratable in-memory values when measured.
7. Add a single-flight/generation guard, timeout, and AbortController to `SessionWatcher`. `stop()` aborts both provider/session requests and late results become no-ops while preserving the two-second schedule.
8. Remove Dashboard card, observer, avatar, and map state immediately on `agent:removed`, even while World is active.
9. Reconcile Sidebar `_seenWorkflows` and `_collapsedWorkflows` with live workflows plus a small documented grace window before building the render signature.
10. Suspend Web Audio after the hidden-tab fade regardless of saved enabled preference. Guard delayed activation/resume by visibility generation so hidden tabs cannot restart audio.
11. Prime Dashboard visibility geometry once on mode entry, then trust IntersectionObserver. Keep the existing fallback only for unsupported/invalidated layout states.
12. Return a copy/frozen view from `Pathfinder` cache reads, or stop mutating stitched segments. Add a repeated-route regression fixture before changing ownership semantics.

Acceptance:

- Failure injection after each boot stage leaves no socket, interval, listener, canvas, audio node, or open store owned by the failed App.
- After boot/select/open-panel/destroy, listener, DOM, avatar, timer, observer, and channel counts return to the pre-boot baseline; no `BroadcastChannel is closed` warnings occur.
- A 250-cycle World/Dashboard test remains stable and boot/destroy/boot does not duplicate listeners or polling.
- Slow API responses never produce concurrent poll pairs and cannot mutate a stopped watcher.
- Agent/workflow churn reaches a stable retained-card/set count.
- A sound-enabled hidden tab reaches `AudioContext.state === 'suspended'` after the fade and resumes once when visible.

### Phase 5 - Remove unused asset-derived memory

**Priority:** P1. This is baseline reduction, not leak repair.

Owned paths:

- `claudeville/src/presentation/character-mode/AssetManager.js`
- `claudeville/src/presentation/character-mode/{SpriteRenderer,BuildingSprite,Compositor,AgentSprite}.js`
- asset manifest metadata only if needed to express interactivity

Work:

1. Create alpha masks and outline canvases only for assets that support hit testing/outline rendering (currently building bases), either eagerly from explicit metadata or lazily through `getMask()` / `getOutline()`.
2. Prewarm the small building set if lazy construction would cause a first-hover hitch.
3. Release scratch-canvas backing after preprocessing and verify no derived canvases are created for character sheets.
4. Add `AssetManager.dispose()` for App/renderer replacement and confirm it releases only resources no longer referenced by live sprites.
5. Normalize the composed-sprite variant key so the current fourth hash variant cannot duplicate variant zero for a three-entry palette.
6. Instrument composed/processed sheet count and pixels. If real model/accessory/color churn exceeds a documented budget, move module-global caches to an instance-owned pixel-budget LRU; never zero a canvas still referenced by a live sprite.
7. Re-measure decoded image memory and startup after this change. Do not lazy-load all character models in the same patch.

Acceptance:

- Initial mask bytes fall from about 15.7 MiB to the interactive-asset footprint (currently under 1 MiB), and outline canvas pixels show the same reduction.
- Every building retains identical hit testing, hover outline, click behavior, and pixels.
- Agent sprites never flash or pop in, and startup does not regress.

Deferred gate:

- Loading only active character sheets is optional after Phase 5. Pursue it only if decoded image memory remains a material problem. It must preload active models plus fallback and load new-agent models without placeholder frames.

### Phase 6 - Optimize only CPU-profiled render and Dashboard hot paths

**Priority:** P2, after memory/resource plateaus are proven.

CPU profile leaders included `_drawSeaGlitter`, `_drawRiverFlowStreaks`, `_drawAnimatedCurrentBands`, `_drawDynamicWaterHighlights`, `_drawSurfWashBands`, Harbor drawable enumeration, and repeated repository/commit label normalization.

Owned paths:

- `IsometricRenderer.js` water/current preparation and drawing
- `HarborTraffic.js` state-derived descriptors
- repository/git label helpers used inside frame paths
- `DashboardRenderer.js` visibility/layout polling

Work:

1. Precompute only time-invariant water descriptor fields such as tile eligibility, stable hashes, screen flow vectors, and pass membership when viewport/visible-water inputs change.
2. Keep time-dependent sine/alpha/position formulas and exact draw order in the frame loop.
3. Derive repository color/profile, branch profile, and cleaned commit labels at session/Harbor state update boundaries, or use a small bounded cache keyed by canonical input.
4. Avoid cloning unchanged Harbor state and repeated sorting/enumeration when the relevant version is unchanged.
5. Split visit, relationship, landmark, and harbor data reconciliation from per-frame movement/animation. Drive reconciliation from state versions/events or a measured 100-250 ms cadence; keep interpolation and drawing at rAF cadence.
6. Avoid constructing unused cloned/sorted snapshots from `VisitIntentManager`, `VisitTileAllocator`, and `RelationshipState` when the caller ignores them.
7. Cull drawables before sorting where the comparator/order of the visible set remains identical. Treat wrapper reuse as a second, profile-gated step.
8. Consider throttling deep `AtmosphereState` snapshots only if segment timing remains material; visual drift/animation time stays per frame.
9. Remove the every-three-second full card `getBoundingClientRect()` pass once the observer-backed candidate set has been primed.
10. Put a guarded boundary around a World frame so one subsystem exception is reported at a bounded rate and cannot silently freeze the loop. Define whether recovery reschedules or safely pauses before implementation, and test both update and draw failures.

Keep/revert rule:

- Keep an optimization only if it reduces the targeted self-time or desktop p95 frame time by at least 10 percent in the same scenario, or removes a measured allocation slope.
- Revert any optimization that changes a deterministic pixel, visible event timing, layering, current motion, harbor density, sprite, label, or selection behavior.
- Do not lower DPR/pixel budgets, animation cadence, or scene population to satisfy the target.

### Phase 7 - Stabilize optional widgets

**Priority:** P1. File-disjoint from browser/server work, but platform-gated.

Owned paths:

- `widget/Sources/main.swift`
- `widget/kde/claudeville/contents/ui/main.qml`

macOS work:

- Load one stable popover HTML shell and update serialized state through `evaluateJavaScript` instead of `loadHTMLString()` every five seconds.
- Reuse an existing dashboard window whether visible or closed, or explicitly release/nil it through one `NSWindowDelegate` policy. Do not mix non-release with reconstruction.
- Tear down WebView delegates/timers if the release policy is chosen.

KDE work:

- Wrap each XHR completion in a once guard, clear callbacks after completion, abort superseded requests, and keep only one refresh batch in flight.

Acceptance:

- macOS: 20 popover refreshes and 20 dashboard close/open cycles retain one intended shell/WebView, stable WebContent process count, and stable memory after warmup.
- KDE: injected success/error/timeout races call completion exactly once and never make `pending` negative or overlap refresh batches.
- Widget appearance and data cadence remain unchanged.

### Phase 8 - Optional delivery and offline stability

**Priority:** P2 and independently shippable.

- Self-host the exact Press Start 2P WOFF2 and its license, update browser/macOS/KDE references, and compare glyph metrics/screenshots. Do not substitute another face.
- Add immutable caching only for versioned sprite/font URLs. Keep `index.html`, JavaScript, CSS, manifests, and unversioned local-development resources revalidated so zero-build edits remain immediate.
- Do not add a bundler, minifier, service worker, CDN, or generic lazy-module system for the current local app.

## 6. Workstream Ownership And Merge Order

| Workstream | Primary paths | May run with | Must serialize with |
| --- | --- | --- | --- |
| A: diagnostics | `server.js`, perf smoke, renderer counters | Initial fixture/capture work | Final edits to A/B server hot spots |
| B: watcher topology | `server.js`, adapter watch descriptors | World, lifecycle, widget work | C: invalidation/transcript work |
| C: invalidation/transcripts | `server.js`, `adapters/index.js`, `claude.js`, `shared.js`, `gitEvents.js` | World, assets, widgets | B and any other adapter cache edits |
| D: World bounds/render | `IsometricRenderer.js`, `HarborTraffic.js`, `AgentEventStream.js` | Server, assets, widgets | Other World visual work |
| E: browser lifecycle | `App.js`, shared UI, Dashboard, chronicle services | Server, widgets; parts can split by owned file | App/Activity/chronicle teardown order changes |
| F: assets | `AssetManager.js`, Sprite/Building renderers | Server, widgets | Other asset-manifest work |
| G: widgets | Swift and QML | All browser/server work | Platform-specific edits to same widget file |

Recommended merge order: diagnostics -> watcher topology -> scoped invalidation/Claude streaming -> World bounds -> lifecycle/polling -> asset buffers -> measured frame work -> widgets/delivery. Re-baseline after each arrow; do not stack speculative optimizations before attribution is clear.

## 7. Validation Matrix

### Server and adapters

- `node --check` on every touched server/adapter/service file.
- `find claudeville/adapters claudeville/services -name '*.js' -print0 | xargs -0 -n1 node --check`
- `npm run validate:quick`
- `node scripts/smoke/adapters.mjs`
- `NODE_NO_WARNINGS=1 node scripts/smoke/relationship.mjs`
- `curl http://localhost:4000/api/providers`, `/api/sessions`, and `/api/perf`.
- 30-60 minute append/reconnect soak with RSS, heap, event-loop delay, watcher count, cache bytes, git command rate, and broadcast p50/p95/max checkpoints.
- Fixtures: large sparse Claude JSONL, partial UTF-8/JSON line, append, rewrite, truncation, rotation, deleted project, missed watch event, watcher-cap fallback, and Codex historical pruning.

### Browser and World

- Open World and Dashboard at 1280x720, 1600x1000, and 2560x1440; select/deselect agents, switch modes, hover/click every building, open/close Activity Panel.
- Ten-minute World soak plus 250 mode switches, repeated renderer mounts, agent/workflow/team churn, hidden/visible audio, destroy/reboot, and injected slow/failed API calls.
- Forced-GC samples at fixed checkpoints. Assert plateaus for fade colors, Harbor events/IDs, tool keys, cooldowns, cards, avatars, DOM listeners, and heap.
- Deterministic screenshot/pixel comparison with scenario, clock, RNG, weather, camera, simulation step, and animation frame frozen for day, night, harbor, agents, building outlines, Dashboard, and panel states.
- Repeated cached-path lookup/stitch tests, context-loss/restoration, and injected World update/draw exceptions.
- `npm run world:validate-buildings`; run `npm run world:validate-terrain` if any terrain/water descriptor ownership changes.
- Confirm browser console has no errors or teardown warnings.

### Widgets

- macOS: `npm run widget:build`, then `npm run widget:check` or `npm run widget:verify-bundle`, followed by the reopen/refresh memory test on macOS.
- KDE: `npm run widget:kde:check`, then install/run where Plasma is available and inject XHR terminal-state races.
- Linux static review does not count as macOS/KDE runtime validation.

## 8. Release Gates

A phase is complete only when:

1. Its growth source is demonstrably bounded or its correctness failure has a regression fixture.
2. API/session semantics and the two-second active freshness contract pass.
3. World and Dashboard screenshots preserve the current town appearance.
4. No unrelated files are changed and no new runtime dependency/build step is introduced.
5. The before/after evidence is recorded in the commit or retained handover, including any target that was not met.

Do not combine these changes into one release-sized patch. The watcher, transcript/invalidation, World bounds, lifecycle, and widget phases need separate commits and rollback points. Only update `CHANGELOG.md`, version locations, tags, or releases when a push/version is explicitly requested.

## 9. Explicit Non-Goals

- No framework, bundler, TypeScript conversion, worker-pool rewrite, database migration, or WebSocket library replacement.
- No mobile/responsive work or narrow-viewport testing.
- No scene simplification, fewer agents, reduced harbor/water/weather detail, lower default DPR, or slower animation.
- No broad dashboard virtualization for the current small card count.
- No cache added without a byte/count/lifecycle bound and an owner that clears it.
- No asynchronous git/provider rewrite until scoped invalidation and incremental parsing are measured.
- No generic memoization of frame functions; cache only proven invariant inputs with finite keys.

## 10. Expected Outcome

The first three implementation phases should remove the suspected long-session memory behavior: kernel watchers no longer track all historical provider entries, Claude transcripts no longer materialize whole files, provider appends no longer trigger global git/parse work, and World caches/dedupe state reach fixed plateaus. Later phases reduce baseline asset memory and measured CPU without changing a single visible feature of the town.
