# Plan — road-following ambient strolls

## Goal

When idle agents take a "scenic" walk, prefer following the authored roads in `TOWN_ROAD_ROUTES` instead of cutting diagonally across grass. Do not change pathing for work intents (tool/git/relationship) or for chat approaches.

## Constraints (verified)

- Road tile set lives on `IsometricRenderer.pathTiles` (Set of `"x,y"` keys), populated from `TOWN_ROAD_ROUTES` via `_generatePlannedRoads` (`IsometricRenderer.js:772-805`) plus `_generateGateApproach`, fallback connectors, and bridge tiles. It is the most authoritative "road tile" lookup we have. It is NOT currently passed to `Pathfinder` or `AgentSprite`.
- `Pathfinder` is plain BFS over `walkabilityGrid` with corner-cut guard, line fast path, and bridge-aware simplify/lookahead (`Pathfinder.js:75-254`). It is on the hot path: `findPath` is called from `AgentSprite._assignTarget` (`AgentSprite.js:392-404`) every retarget and every chat re-pick.
- Path cache is keyed by `from,to` and capped at 256 entries (`Pathfinder.js:54-58`), so any new cost dimension must either keep that key valid or extend it.
- Ambient destinations are picked in `IsometricRenderer._getAmbientDestination` (`IsometricRenderer.js:1508-1547`) and only consulted when `this.agent.status === IDLE` and `(_targetCycle % 3) === 1` (`AgentSprite._ambientDestination` 307-316). All other targets (work, chat, fallback building) bypass scenic logic and must keep shortest-path semantics.
- Bridge tiles must remain explicit waypoints (corner cases in `_simplify`/`_lookahead`); any new logic must preserve bridge handling.
- AMBIENT_SCENIC_POINTS are in `IsometricRenderer.js:84-97`. Several already sit on or adjacent to road tiles (`bridge-west`/`bridge-east` cross the central river bridge polyline; `harbor-rail`/`harbor-ledger` sit on `harbor-berths`; `archive-alcove` is one tile off `archive-walk`); some are deliberately off-road (`forest-edge`, `portal-ruins`).

## Approaches considered

### (a) Weighted A* — roads cost 1, grass costs ~3

- Pros: globally optimal under the cost function; the fast line path can still short-circuit when start and end are both on roads.
- Cons: BFS becomes A* with a priority queue (no built-in heap in JS; either pull a tiny binary-heap helper or pay log-N inserts via sorted insert). The current `Uint8Array visited` + `Int32Array parent` + index queue is tuned for unweighted BFS — switching to weighted means tracking a `g`-score Float32Array, the path cache key would have to include "weighted vs not", and `_lookahead` straight-line collapsing becomes wrong (a long straight off-road shortcut is no longer equivalent to a road-hugging chain even if the line is walkable). High code surface, real perf risk on the hot path, applied to *all* callers unless we plumb a flag.
- Cost: high. Requires touching every call site that uses `findPath` to opt out of weighting, or duplicating the function.

### (b) Waypoint stitching — scenic-only, two BFS calls

- For ambient/scenic intents only: pick the nearest road tile to the agent (entry waypoint) and the nearest road tile to the scenic point (exit waypoint). Call `findPath(from → entry)`, then `findPath(entry → exit)`, then `findPath(exit → scenicPoint)`. Concatenate.
- Pros: pathfinder unchanged, zero risk to the work/chat hot path. Two extra BFS calls per scenic retarget (which already only happens every third idle cycle and is rate-limited by `_targetCycle`). Bridge handling stays correct because each leg goes through the existing `_simplify`/`_lookahead`. Easy to feature-flag and easy to disable.
- Cons: produces three concatenated paths; the joints can produce small backtrack zigzags if the nearest-road tile sits *behind* the agent. Mitigation: pick entry road tile via "first road tile encountered when stepping toward the destination, within K tiles" rather than pure nearest. Roads near the destination may be far from it (e.g. `forest-edge` at `(25,11)` has no road within 4 tiles) — then we skip the road leg gracefully.
- Cost: low–medium. One new helper on the renderer, one branch in `AgentSprite._assignTarget` (or, cleaner, the agent gets a multi-hop target list).

### (c) Hybrid — small extra cost only on near-road off-road steps

- Keep BFS, but apply A* with a tiny cost differential (e.g. on-road = 1, off-road = 1.05) so paths get gently steered toward roads without dramatic detours. Apply only inside ambient calls.
- Pros: visually subtle; never adds long detours.
- Cons: same code surface as (a); the differential has to be tuned (`[speculative]` 1.05 seems about right but we'd need to eyeball it); BFS-specific optimizations like the cached fast line and `_lookahead` straight-line collapse become semantically wrong because they assume cost equality between any two walkable line tiles. Net: most of the cost of (a) for less of the visual win.

## Recommendation

**Approach (b), waypoint stitching, scoped to ambient/scenic intents only.**

Rationale: the road network is already a sparse graph the renderer knows about; we don't need a global cost reform to use it. Scenic strolls are infrequent, low-stakes, and visually load-bearing. Weighting the global pathfinder is a much larger commitment with risks (perf, cache invalidation, regression in work paths) that the gain doesn't justify. If road usage feels too rigid after (b) lands, hybrid (c) remains a future option — but we should ship the cheap version and watch first.

## Implementation steps

1. **`IsometricRenderer.js` — expose road tiles to AgentSprite.** In the AgentSprite construction at `IsometricRenderer.js:1668-1680`, pass `pathTiles: this.pathTiles` (or a method `findRoadEntry(fromTile, toTile)` so the Set stays encapsulated). Bridge tiles are already in `pathTiles` so this Set is the right primitive.
2. **`IsometricRenderer.js` — annotate scenic destinations.** In `_getAmbientDestination` (~1531), set `routeViaRoads: true` on the returned destination object so AgentSprite knows this target wants the stitched path, without breaking the regular building destination contract.
3. **`AgentSprite.js` — add `_findNearestRoadTile(fromTile, towardTile, maxRadius=6)`.** Spiral search from `fromTile` for membership in `this.pathTiles`, biasing toward the half-plane that contains `towardTile` (use a simple dot-product on the offset; reject candidates behind the agent). Return null when nothing is in range.
4. **`AgentSprite.js` — modify `_assignTarget`** (`AgentSprite.js:375-420`) to take an optional `viaWaypoints` array (an array of intermediate `{tileX, tileY}` points). When the destination is ambient (passed through `_pickTarget`), compute `entry = _findNearestRoadTile(fromTile, scenicTile)` and `exit = _findNearestRoadTile(scenicTile, fromTile)`. If both exist and are different from `from`/`to`, set `viaWaypoints = [entry, exit]`. Then call `findPath` per leg and concatenate the resulting waypoint arrays. Only the *final* leg gets the screen-coord snap currently applied at line 415.
5. **`AgentSprite.js` — wire the flag through `_pickTarget`.** When `building.routeViaRoads` is truthy, pass the via-waypoints into `_assignTarget`. Leave all other call paths (chat, work, fallback) untouched.
6. **Path cache invariance.** No change to `Pathfinder._pathCache` semantics, since each leg is a normal `findPath(from, to)` call — the cache helps us, not hurts.

## Edge cases

- **No road within range of either endpoint.** Stitching gracefully degrades to the current single BFS — better silent fallback than a worse path.
- **Agent already on a road tile.** `_findNearestRoadTile(fromTile, ...)` returns the agent's own tile; the entry leg becomes empty and we proceed straight to the exit leg.
- **Scenic point sits on a road tile** (e.g. `bridge-west`). Entry-only stitch; exit leg is a no-op.
- **Scenic destination across the river.** Bridge tiles are members of `pathTiles`, so the entry/exit candidates near the river will naturally pull paths onto the bridge — no special-case needed.
- **Agent gets a tool intent mid-stroll.** Existing reroute logic (the broader-review #2 finding handled by concurrent work) re-runs `_pickTarget` without `routeViaRoads`, so the agent abandons the scenic stitch immediately. No change required here.
- **Reduced motion / `motionScale === 0`.** No animation impact. Path cost is negligible (two extra BFS calls per scenic retarget, gated to ~every third cycle of idle agents).
- **Agent stranded on a road tile after arrival.** The arrival behavior unchanged — they sit at the scenic point, which is *not* on a road for most points (only `bridge-*`, `harbor-*`). A long-idle agent on a road tile is acceptable: it reads as "leaning on the rail."

## Verification

- `npm run dev` → `http://localhost:4000`. Disable input load (no working agents) and watch idle agents over ~60 seconds. Roads should be visibly traced more often than not for ambient walks.
- Toggle the existing debug overlay (`DebugOverlay.js`) and observe `behaviorMetrics.scenicVisits` continues to increment at the same rate (sanity check that the routing change doesn't suppress scenic picks).
- Add a one-line counter to `behaviorMetrics`: `scenicRoadStitched++` when both entry and exit are found, `scenicRoadDirect++` when no road is in range. Surface in `_agentBehaviorStats` (`IsometricRenderer.js:1560-1591`). Acceptance: stitched / (stitched + direct) ≥ 0.6 across a 5-minute idle session `[speculative]`.
- Visual: pause and trace one stroll path manually. Confirm bridge crossings still go via authored bridge tiles (regression check on `_simplify` bridge handling).

## Risks

- **Zigzag joints** when the nearest-road entry tile is slightly behind the agent. Mitigated by the half-plane bias in step 3, but worth eyeballing.
- **Jam at narrow road tiles** if many idle agents stitch through the same chokepoint (e.g. the central river bridge). Existing crowd handling (`_resolveStationaryOverlaps`) is for stationary cases; transient walking overlap is allowed today and should still be fine, but worth watching `metrics.unwalkableSkipped`.
- **Path cache pollution** if entry/exit waypoints differ frame-to-frame. Mitigated: nearest-road search is deterministic from `(fromTile, towardTile)`, so stable inputs → stable cache keys.

## Out of scope

- Weighting the global pathfinder for work intents.
- Authoring more roads or repositioning scenic points.
- Animating "walking" differently on roads vs grass.
- Smoothing via `_lookahead` across the leg joints (would re-introduce diagonal cuts).

**Recommendation: approach (b) waypoint stitching, ambient-only.**
