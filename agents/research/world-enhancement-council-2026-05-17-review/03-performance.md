# Per-Frame Allocations, Cache Effectiveness, GC Pressure — Reviewer Output

Verdict: **approve-with-fixes**
Baseline HEAD: `7b5a452`
Reviewer: R3 (per-frame allocations, cache effectiveness, GC pressure)
Scope: paths listed in the brief (WorldFrameRenderer, IsometricRenderer hot loops, AgentSprite.draw, BuildingSprite, CouncilRing, SkyRenderer, HarborTraffic, ChronicleMonuments, SeasonalAmbience) plus the Phase 0 + Phase 5 cache claims (RelationshipState membership cache, LandmarkActivity `_capKind`, HarborTraffic dock-layout memo, Compositor team trim, `building:active-agents` 500 ms throttle, /api/perf surface, WS reconnect jitter).

All findings are READ-ONLY. No code was modified.

## Per-Frame Allocation Hotspots

Severity column: H = > ~10 alloc/agent/frame or unbounded growth, M = bounded but avoidable, L = micro / out-of-budget cost.

| Severity | Path / line | Allocation per frame | Notes |
| --- | --- | --- | --- |
| **H** | `character-mode/AgentSprite.js:2931-2991` — `_activityThread()` called from `_drawStatus` for every visible agent | new `[current, ...this._activityTrail]` array, new `Set` (`seen`), new `deduped` array, plus `{ ...entry, count: 1 }` spread per surviving entry | Runs once per agent per frame. Output is consumed and immediately discarded by `_drawHistoryBubbles`. Could be cached against `(snapshot key, trail revision)`. At 8 agents × 60 fps × ~5 entries = ~2.4 k object spreads/sec just for status thread re-derivation. |
| **H** | `character-mode/IsometricRenderer.js:6044-6095` — `_openSeaGullPositions()` | `openSeaFlockBirds.map(...)` returns new array; each entry is `{ ...gull, tileX, tileY, x, y, waterY, wing, frameId, fallbackFrameId, facing, screenSpeed }`; trailing `.filter(Boolean)` allocates a 2nd array | With `GULL_MAX_POPULATION` flock + `_drawOpenSeaGulls` calling a 3rd `.filter(...)` (line 6161), every frame builds 3 arrays of N spread-cloned gull objects. Reusable scratch buffer + in-place mutation would erase this entirely. |
| **H** | `character-mode/IsometricRenderer.js:2507-2542` — `_enumerateFamiliarMoteDrawables` | per parent: `Array.from(childIds).map(...).filter(...)`, plus a `.filter(...).map(...)` over `recentDepartures`, plus a fresh **closure** `(ctx, zoom) => drawFamiliarMotes(...)` capturing parentSprite / childSprites / departures / atmosphere. | Closure allocation is the dominant cost here because the depth-sort pass keeps the wrapper alive for the rest of the frame. The pre-allocated `_familiarMoteDrawables` array is reused (good), but its contents are fresh every frame. |
| **H** | `character-mode/DrawablePass.js:15-25` — `createDepthDrawable` | one `{ kind, sortY, hitArea, payload, draw }` wrapper **plus** a fresh `draw(ctx, zoom, context)` closure per drawable per frame | Called for every building, agent, harbor item, landmark item, monument, chronicler item, and familiar mote in `appendDepthSortedDrawables` (`WorldFrameRenderer.js:90`). With ~50 drawables at 60 fps that is ~3 k closure allocations/sec. Easy win: dispatch on `kind` in `drawDepthSortedDrawables` and let the inner array store the bare drawable. |
| **H** | `character-mode/HarborTraffic.js:2179-2290` — `enumerateDrawables` | new `markerByRepo Map`, `dockedByRepo Map`, `byId Map` per squad, `squadAnchors` array (`squad.ships.map(...).filter(...)`), `crateDrawnForKeys Set`, `untetheredProjects` set, `departing` array + `.sort(...)`, `visible.sort(...)` | Called twice per frame because `_drawHarborWakeWaterDescriptors` invokes `enumerateWakeDescriptors` (`IsometricRenderer.js:4189`) which itself calls `enumerateDrawables` (`HarborTraffic.js:2329`). The dock-layout memo (5.5) covers `buildDockSquadLayout` only — everything else above is unconditionally re-allocated. |
| **H** | `character-mode/ChronicleMonuments.js:134-184` — `enumerateDrawables` | new `byDistrict Map`, `visible` array, `drawables = visible.filter(...).filter(...).map(...)` chain, `{ ...record, worldX, worldY }` spread per output, plus `.push({ ...firework, ... })` / `.push({ ...banner, ... })` | Called per frame from `WorldFrameRenderer.js:82` **and** indirectly through `minimapMarkers()` (`WorldFrameRenderer.js:149` → `ChronicleMonuments.js:226` → `this.enumerateDrawables()`). The minimap call also spreads `.map(drawable => drawable.payload).map(...)` — two additional arrays. |
| **M** | `character-mode/IsometricRenderer.js:2544-2594` — `_assignAgentOverlaySlots` | `.filter().sort()` builds a new array; inside the slot-search loop `_agentCompactSlotRect(sprite, slot)` and `_agentNameSlotRect(sprite, slot)` are invoked inside `.some(item => ...)` callbacks → up to 11 rect-object allocations per sprite per frame | At zoom < 3 only the compact branch runs (≤ 4 calls/sprite), at zoom ≥ 3 the name branch adds ≤ 7. ~88 rect objects/frame for 8 agents at high zoom. The rect shape is constant — could mutate a single scratch object per sprite. |
| **M** | `character-mode/IsometricRenderer.js:2612-2627` — `_collectAgentLabelHitRects` | new `out` array + one rect object per sprite per frame | Output is consumed and discarded immediately by `buildingRenderer.drawLabels`. Could be a reused scratch array (the same pattern used for `_drawables`). |
| **M** | `character-mode/IsometricRenderer.js:2463-2476` — `_harborPendingReposSignature` | per-repo `[a,b,c,d,e,f].join(':')` followed by `.sort()` + `.join('|')` | Designed to gate `harbor:updated` emission so the alloc cost is intentional, but at 60 fps with N pending repos this is `O(N · 6 + N log N)` strings every frame. A per-repo revision counter would let us skip the string altogether. |
| **M** | `character-mode/RelationshipState.js:78-87` — `update()` snapshot rebuild | `recentArrivals.map(item => ({ ...item, sinceMs }))` + `recentDepartures.map(...)` + `chatPairs.map(pair => ({ ...pair }))` — three fresh arrays of spread copies on every call | Membership cache (Phase 0) protects `parentToChildren`/`childToParent`/`teamToMembers` from being rebuilt every frame, which is the big-O win — but the snapshot still spreads each arrival/departure/chat pair on every frame. Bounded by N (`MAX_RECENT_DEPARTURES = 6`, `chatPairs ≤ 8`) so not catastrophic; just unnecessary if consumers don't mutate. |
| **M** | `character-mode/IsometricRenderer.js:1260` — `building:active-agents` handler | `new Map(Object.entries(payload))` per event | Event itself is throttled to 500 ms (good — see Cache Correctness below), so this is at most 2 Maps/sec. Could `.clear()` + repopulate instead. |
| **L** | `character-mode/SkyRenderer.js:512-537` — `_mapTopYAtScreenX` | `mapWorldCorners().map(point => camera.worldToScreen(...))` allocates a 4-element array + four edges as 2-element sub-arrays + `candidates` array; spread inside `Math.min(...corners.map(...))` | Called twice per frame (`_drawSun` + `_drawGodrays`). Corners depend only on the camera transform; cache against `camera.cacheKey` (camera already exposes one). |
| **L** | `character-mode/AgentSprite.js:1163` | rebuilds the `profileKey` 7-tuple string per agent per frame even when no field changed | Cheap, but if `_spriteProfileKey` already matches we are paying for a string concat that produces an identical result. A dirty bit on identity / accessory / team / equipment changes would skip the concat. |
| **L** | `character-mode/CouncilRing.js:174-178, 257-271` — `drawCouncilRings` / `prioritizedChatPairs` | `points.reduce(...)` creates new accumulator objects; `prioritizedChatPairs` allocates `[...(pairs \|\| [])]` + `.sort()` + `.slice(MAX_TALK_ARCS)` | Capped by team count and `MAX_TALK_ARCS=8`. Small, but each call from `WorldFrameRenderer.renderWorldFrame` (lines 54, 62, 109) is independent — we resort `chatPairs` twice (in `drawTalkArcs` + `relationshipLightSources`). |
| **L** | `character-mode/IsometricRenderer.js:3987-4046` — water ripple inner double loop | `const key = \`${x},${y}\`` allocated per tile per frame inside the inner `for` | Tile keys are also computed in shore wash, fog wash, water tint, phase tint, etc. With a 40×40 visible area that's ~1600 string allocations/frame just for ripple. A composed integer index (`y * MAP_SIZE + x`) is enough where Set lookup is the only consumer; existing `Set<string>` requires the string. This is a pre-existing pattern, not a Phase 0–5 regression — flagging for context only. |

No `await` / `await microtask` was found on any per-frame path. The only `Promise.allSettled` (`IsometricRenderer.js:2325`) is inside the 1 Hz chronicle gate, not per frame. Good.

## Cache Correctness Audit

1. **`RelationshipState._membershipDirty`** (`character-mode/RelationshipState.js:22-58, 73-76`) — flipped to `true` on `agent:added`, on `agent:removed`, and on `agent:updated` only when `parentSessionId` or `teamName` differs from `_lastMembership.get(agent.id)`. Confirmed by `node scripts/smoke/relationship.mjs` (cited in 05-adapter-server.md: "membership cache: teamToMembers Map instance is preserved when not dirty" — PASS). **CORRECT.**

2. **`LandmarkActivity._capKind`** (`character-mode/LandmarkActivity.js:403-419`) — per-kind id ring buffer; appends the new id once, then `shift()`-trims the head while the front id is no longer in `items` or the list exceeds `MAX_ITEMS_PER_KIND`. Each prune is `O(k)` where `k` is the over-cap count, normally 0 or 1. **CORRECT, O(1) amortized**. Caveat: the `seenSnapshots` Set is still rebuilt only when it exceeds 400 entries (line 398-400) — that path is `O(N)` once per overflow, which is bounded.

3. **HarborTraffic dock-layout cache key** (`character-mode/HarborTraffic.js:729-746`) — `dockSquadLayoutCacheKey` iterates `state.ships`, **skips non-docked ships** (line 738), and emits `${id}:${pushStatus}:${eventTime}` per ship. So a `docked → departing` transition removes the ship from the key, and a `pushStatus` flip changes the per-ship meta. **CORRECT — key includes ship status as required by the brief.** Capped at 32 entries with LRU eviction.

4. **Compositor cache key includes `teamHash`** (`character-mode/Compositor.js:23-24`) — `const teamHash = teamTrim ? String(teamTrim).toLowerCase() : '_';` is concatenated into the cache key. **CORRECT.** Solo agents share the `_` slot, so the cache footprint did not balloon (matches the comment at line 22-23). Verified the call site in `AgentSprite.js:1162-1163` mirrors the same hash.

5. **`building:active-agents` throttled to 500 ms** (`character-mode/LandmarkActivity.js:13, 471-472`) — `PRESENCE_EMIT_INTERVAL_MS = 500`; `_maybeEmitPresence` returns early if `now - this._lastPresenceEmit < 500`. **CORRECT.** Both `building:active-agents` (line 480) and `building:read-intensity` (line 483) ride the same gate, so we emit at most 2 Hz combined.

## Subscription Leaks

Audited every `eventBus.on(...)` added or retained across Phase 0-5 against its `dispose` / `hide` / `destroy` path.

| File | Subscription | Cleanup path | Status |
| --- | --- | --- | --- |
| `RelationshipState.js:27, 31, 40` (agent:added/updated/removed) | `dispose()` lines 62-68 iterates `this.unsubscribers` | OK |
| `SkyRenderer.js:80-90` (git:pushed, harbor:push-success, subagent:completed) | `dispose()` lines 908-921 iterates `this._unsubscribers` | OK, **but see WARNING below** |
| `BuildingSprite.js:266` (`BUILDING_EVENTS.ACTIVE_AGENTS`) and `:273` (`building:read-intensity`) | `dispose()` lines 282-286 calls `eventBus.off(...)` for both | OK |
| `IsometricRenderer.js:1219-1262` (agent:added, agent:removed, agent:updated, subagent:dispatched, BUILDING_EVENTS.ACTIVE_AGENTS) | `hide()` lines 1316-1319 iterates `_unsubscribers`; `show()` always disposes prior `agentEventStream` / `relationshipState` before recreating them (lines 1200-1206) | OK |
| `IsometricRenderer.js:1302` (mode:changed) | `hide()` lines 1328-1330 calls `eventBus.off('mode:changed', this._onModeChanged)` | OK |
| `HarborTraffic.js` | no `eventBus.on` | N/A |
| `ChronicleMonuments.js` | no `eventBus.on` (only `emit`) | N/A |
| `LandmarkActivity.js` | no `eventBus.on` (only `emit`) | N/A |
| `SeasonalAmbience.js` | no `eventBus.on` | N/A |
| `CouncilRing.js` | no `eventBus.on` (only module-level `emit` in `applyTeamGatherChoreography`) | N/A |

**WARNING (not a leak but a functional regression risk):** `SkyRenderer` subscribes to `git:pushed`, `harbor:push-success`, and `subagent:completed` from the constructor only (`SkyRenderer.js:74, 77-91`). `IsometricRenderer.releaseVolatileCaches()` and `hide()` both call `skyRenderer.dispose()` (lines 1361, 1432), and `dispose()` permanently sets `this._unsubscribers.length = 0`. There is no `show()`-time re-subscribe and no fresh `new SkyRenderer(...)` between mode toggles — `this.skyRenderer` is created once in the IsometricRenderer constructor (`IsometricRenderer.js:492`). After the first `hide()` (mode switch to dashboard or context loss), aurora and shooting stars stop firing forever. This is **not** a GC / allocation issue, but it crosses into reviewer scope because subscription lifecycle is broken. **Required fix** (R3-1 below).

## N² / Crowding Regressions

| Path | Complexity | Bounds | Verdict |
| --- | --- | --- | --- |
| `IsometricRenderer.js:2249-2278` separation steering | O(M²) over moving sprites only | M ≤ N agents | Same as pre-Phase-0; safe at expected N ≤ 16. |
| `IsometricRenderer.js:2369-2387` `_resolveStationaryOverlaps` | O(N²) | Throttled to 420 ms (`_stationaryOverlapAccumulator`) and capped at 2 retargets/tick | Safe. |
| `CouncilRing.js:106-115` `applyTeamGatherChoreography` distance check | O(team²) | Capped per team; gated by `TEAM_GATHER_COOLDOWN_MS=5min` | Safe. |
| `HarborTraffic.js:2197-2274` enumerateDrawables | O(ships + squads · ships-in-squad) | ships ≤ ~200; allocates Map per squad → see allocation table | Linear, but Map-per-squad allocation is the avoidable cost. |
| `IsometricRenderer.js:2507-2542` `_enumerateFamiliarMoteDrawables` | O(families · children) | bounded by parent count | OK in time complexity; allocation is the issue (see table). |
| `LandmarkActivity.js:421-440` `_refreshBuildingCounts` | O(sprites · buildings) | sprites ≤ N, buildings = 9 | OK. Note `worldToTile(sprite.x, sprite.y)` + `{ ...sprite.agent, position: tile }` spread inside the inner loop allocates 2 objects per sprite per frame. Bounded; flag as L if you want a follow-up. |
| `Compositor.js:71-82` palette swap inner loop | O(pixels · 3) | one-time per `(spriteId, palette, variant, accessory, teamTrim)` tuple, cached in module-level `cache` Map | OK. The team-trim accent path (Phase 4.14) does not change the iteration count or the cache shape; cache key includes `teamHash` so solo and team variants are kept separate. |

No new quadratic loop was introduced in Phase 0-5.

## /api/perf Surface

Verified via `claudeville/server.js` (lines 327-355):

- `cacheStampCounter` — exposed at L353. Bumped at L750 (`markProviderDataDirty`) and L767 (`getTeamsCached` first refresh). **PRESENT.**
- `lastBroadcastStamp` — exposed at L354. Updated at L829, L837, L843 inside `broadcastUpdate`. **PRESENT.**
- Additional fields exposed: `activeWatchPaths`, `recursiveWatchFallbacks`, `recursiveWatchFallbackDetails`, plus the gitEnrichment block. Matches the 05-adapter-server.md baseline (R5).

WS reconnect spec (also in scope of R5; cross-checked here for the jitter claim):

- `WebSocketClient.js:92-107` — `backoff = min(WS_RECONNECT_INTERVAL * 2^(attempts-1), 15000)`, `delay = backoff + Math.random() * 500`. Cap = 15 s, jitter = 0-500 ms. **MATCHES SPEC.**

## Blockers

None. All Phase 0-5 cache claims hold, no subscription leak detected, no async/await on the per-frame path.

## Required Fixes (R3)

1. **R3-1 (correctness, NOT perf) — SkyRenderer subscriptions die on first `hide()`.**
   `claudeville/src/presentation/character-mode/SkyRenderer.js:74-91, 908-921`. After `releaseVolatileCaches()` (`IsometricRenderer.js:1432`) or `hide()` (`:1361`) the unsubscribers array is permanently cleared, but the SkyRenderer instance is reused. Fix: either (a) move subscription installation into a dedicated `start()` / `attach()` method called from `IsometricRenderer.show()` and have `dispose()` only clear caches, or (b) call `this._subscribeToEvents()` at the end of `dispose()` to immediately re-arm. Option (a) is the cleaner contract.

2. **R3-2 (allocation, H) — `_enumerateFamiliarMoteDrawables` closure-per-family.**
   `claudeville/src/presentation/character-mode/IsometricRenderer.js:2507-2542`. Replace the per-family arrow closure with a `drawFn = drawFamiliarMotesDrawable` reference and stash the resolved arguments (parentSprite, childSprites, childAgents, motionScale, atmosphere) on the drawable payload. The depth pass already passes `(ctx, zoom, context)` into `drawable.draw` — wire a top-level dispatcher in `DrawablePass.js` so the inner closure goes away.

3. **R3-3 (allocation, H) — `createDepthDrawable` per-drawable closure.**
   `claudeville/src/presentation/character-mode/DrawablePass.js:15-25`. The `draw` closure on each wrapper is the same shape for every drawable of the same `kind`. Dispatch on `kind` in `drawDepthSortedDrawables` (line 106-111) and stop allocating the closure per item. Net effect: ~3 k closure allocations/sec eliminated.

## Optional Improvements (R3)

1. **Cache `_activityThread()` result** (`AgentSprite.js:2931-2991`) on each sprite, invalidated when `agent.currentTool / lastTool / lastMessage / status / activityAgeMs` change. The thread is consumed exactly once per frame (in `_drawStatus`); caching erases the per-agent allocations entirely on idle frames.

2. **Reuse harbor-enumerate-drawables scratch arrays.** `HarborTraffic.enumerateDrawables` could mutate stable instance arrays (`this._enumerateScratchVisible`, `this._enumerateScratchDockedByRepo` reused across calls) and clear them at the top of the function, matching the pattern already used by `_familiarMoteDrawables` / `_drawables`. Most of the per-frame Map allocations would disappear.

3. **`_openSeaGullPositions` rewrite to scratch buffer.** Pre-allocate `this._gullPositionsScratch = []` and fill in place; the surrounding `_drawOpenSeaGulls` already does its own visibility filter (line 6161), so the spread-into-fresh-object pattern in `.map(...)` is pure overhead. ~12-18 gull objects/frame removed.

4. **`ChronicleMonuments.minimapMarkers()` re-runs `enumerateDrawables`.** Both `WorldFrameRenderer.renderWorldFrame` (line 82 and line 149) trigger separate `enumerateDrawables` builds in the same frame. Either cache the last drawables array (invalidated when records change) or split out a cheap `_visibleMonumentTiles()` that only needs `byDistrict` results.

5. **`new Map(Object.entries(payload))` for presence map.** `IsometricRenderer.js:1260`. Replace with `this._buildingPresenceMap.clear(); for (const [k, v] of Object.entries(payload)) this._buildingPresenceMap.set(k, v);`. The Map allocation cost is small (≤ 2/sec) but the pattern propagates.

6. **`mapWorldCorners().map(...)` in `SkyRenderer._mapTopYAtScreenX`** could be cached against the camera transform. The camera already invalidates a cache key when it pans/zooms (`this.terrainCacheKey` uses one).

7. **`RelationshipState` snapshot spread** — emit a frozen snapshot with shared references when nothing changed in `recentArrivals` / `recentDepartures` / `chatPairs` (a dirty bit per list, similar to `_membershipDirty`). Bounded but easy win.

8. **Water tile string keys** — pre-existing pattern, but a `BitSet` indexed by `y * MAP_SIZE + x` would erase ~1.5-2 k string allocations per frame across ripple + wash + tint passes. Defer until a follow-up phase; out of Phase 0-5 scope.

## File / Line References

- `claudeville/src/presentation/character-mode/AgentSprite.js:2931-2991, 1163, 2545-2594` — `_activityThread`, `profileKey`, slot rects.
- `claudeville/src/presentation/character-mode/IsometricRenderer.js:1260, 2249-2278, 2369-2387, 2412-2449, 2463-2476, 2507-2542, 2544-2594, 2612-2627, 6044-6095, 6157-6213, 3987-4046` — presence-map handler, separation, stationary overlaps, ambient emitters (smoke), harbor signature, familiar motes, overlay slots, label hit-rects, gulls, water ripple.
- `claudeville/src/presentation/character-mode/DrawablePass.js:15-25, 69-104` — `createDepthDrawable` closure + append loop.
- `claudeville/src/presentation/character-mode/HarborTraffic.js:722-768, 1855-1870, 2179-2290, 2327-2383` — dock-layout memo, update, enumerateDrawables, enumerateWakeDescriptors.
- `claudeville/src/presentation/character-mode/ChronicleMonuments.js:134-184, 225-235` — enumerateDrawables, minimapMarkers.
- `claudeville/src/presentation/character-mode/CouncilRing.js:174-178, 257-271, 86-145` — drawCouncilRings reduce, prioritizedChatPairs, applyTeamGatherChoreography.
- `claudeville/src/presentation/character-mode/SkyRenderer.js:74-91, 369, 444-495, 497-537, 908-921` — subscribe/dispose, sun + godrays + `_resolveSunPosition`.
- `claudeville/src/presentation/character-mode/RelationshipState.js:22-87, 93-126` — `_membershipDirty`, snapshot, `_rebuildMembership`.
- `claudeville/src/presentation/character-mode/LandmarkActivity.js:13, 100-119, 134-143, 403-419, 470-484` — presence interval, frame update, `_capKind`, `_maybeEmitPresence`.
- `claudeville/src/presentation/character-mode/BuildingSprite.js:244-286, 1105-1129` — drawables cache + invalidation, dispose.
- `claudeville/src/presentation/character-mode/Compositor.js:23-24, 44-83` — cache key including `teamHash`, palette swap.
- `claudeville/server.js:718-768, 327-355, 798-843` — cacheStampCounter source + /api/perf surface + broadcastUpdate stamp gate.
- `claudeville/src/infrastructure/WebSocketClient.js:92-107` — reconnect backoff + jitter.

## Risk Severity

**Low / Medium.** Cache claims are all met (Phase 0 membership, Phase 5 dock-layout memo, Phase 5 cache-stamp gate, /api/perf surface, WS jitter). The SkyRenderer subscription-after-dispose defect (R3-1) is a correctness regression that surfaces only on mode toggles, not on first paint. The remaining items are GC-pressure cleanups: the depth-drawable closure and the familiar-motes closure together account for the bulk of the avoidable per-frame allocation surface uncovered by Phase 0-5; ~5-6 k object/closure allocations per second at 60 fps with N=8 agents, eliminable without behavior change.
