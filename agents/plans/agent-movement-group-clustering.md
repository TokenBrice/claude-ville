# Plan — group clustering at slots (teammates / parent-child)

## Goal

When several agents reserve slots at the same building, agents that are related (parent ↔ subagent, or share `teamName`) should pick adjacent slots so they read as a delegation huddle, while unrelated agents continue to spread via the existing flank-spread layout.

## Constraints (verified)

- `VisitTileAllocator._scoreSlot` (`VisitTileAllocator.js:259-306`) is currently relationship-blind — it looks at `agentId` only via `existingReservation` and `_tileOccupancy`, never at team/parent metadata.
- Existing penalty/bonus magnitudes (lines 5-10 + 297-298): `WALKABILITY_PENALTY=240`, `RESERVED_PENALTY=180`, `OVER_CAPACITY_PENALTY=130`, `SAME_AGENT_SLOT_BONUS=90`, `TILE_CROWD_PENALTY=70`, `BUILDING_CROWD_PENALTY=18`, `DISTANCE_WEIGHT=0.15`, scenic ±14 / overflow +35. Any clustering bonus must (a) be smaller than RESERVED so it never overrides a hard collision, (b) be smaller than OVER_CAPACITY so a related cluster can't stuff a building past capacity, and (c) be larger than crowd/distance so it actually pulls related agents adjacent.
- Allocator gets agent metadata only via `agentSprites` (`updateContext`, `VisitTileAllocator.js:48-59`); `sprite.agent.teamName` and `sprite.agent.parentSessionId` are already present (`Agent.js:46, 53`). Subagent ⇄ parent is bi-directional via `parentSessionId` only — no `childIds` on the parent.
- `RelationshipState` (`RelationshipState.js`) already builds `parentToChildren` / `childToParent` / `teamToMembers` and exposes them via debounced `getSnapshot()`. It does NOT currently flow into the allocator. It is the cleanest source for relationship lookups but it lives on the renderer side.
- `CouncilRing.applyTeamPlazaPreferences` (`CouncilRing.js:40-56`) only sets `teamPlazaPreference` (boolean) on sprites and only when ≥2 same-team agents are idle; it influences ambient *building* choice via `AgentSprite._ambientBuildingTypeForState` (`AgentSprite.js:276`). Slot-level adjacency is unaddressed.
- `VisitIntentManager._deriveRelationshipIntents` (`VisitIntentManager.js:275-301`) emits `subagent` and `team` intents with the parent's current building (or `command` fallback). It steers building choice but not slot choice. The intent payload already contains `parentId` / `teamName`, which is convenient.
- Recently-expanded visit-tile slots (per the prompt) wrap multiple sides of buildings; clustering should pull related agents together *within* that pool, not collapse the spread.

## Approaches considered

### (a) Score-term in `_scoreSlot` based on tile distance to nearest related reservation

- Pros: lives entirely in the allocator; zero coupling to RelationshipState; uses data already pulled (`agentSprites`). Composes with existing penalties.
- Cons: O(slots × relatedReservations) per allocate call. With ≤8 agents and ≤6 slots per building this is trivial. Needs an `agentMeta` lookup table (built once per `updateContext`).

### (b) Pre-compute per-building "huddle anchor" tiles

- For each building with ≥2 related agents currently reserved, pick the centroid of their reservations as the anchor; bias new related agents toward slots near that anchor; non-related agents are pushed away from it.
- Pros: produces tighter visual clusters than nearest-neighbor scoring.
- Cons: more state, more failure modes. Anchor placement depends on arrival order. The first agent has no anchor; the second pulls toward the first; the third pulls toward centroid; this can converge messily. Overkill for 2–4 agents per cluster. Counter-spread for unrelated agents fights the new flank-spread on purpose.

### (c) Push relationship awareness up into the intent layer (preferredSlotId)

- `VisitIntentManager` would set `intent.preferredSlotId` on subagent/team intents, pointing at the parent's currently-reserved slot's neighbor.
- Pros: reuses the existing `_intentSlotBonus` mechanism (`VisitTileAllocator.js:504-511`) which already adds 55 for a `preferredSlotId` match.
- Cons: requires the intent manager to know live reservation state, which inverts the current dependency direction (allocator depends on intents, not vice versa). Stale on fast tool churn. Cross-layer coupling.

## Recommendation

**Approach (a), scoring term in `_scoreSlot`, with `agentMeta` derived in `updateContext`.**

Rationale: the data is already in reach (`sprite.agent.teamName`, `sprite.agent.parentSessionId`), the math is small, and it composes with every existing penalty cleanly. Approach (b) would chase a stronger visual at the cost of fragility; approach (c) puts the wrong layer in charge of slot details. We can revisit (b) if (a) doesn't deliver the huddle feel after a couple of integration sessions.

## Implementation steps

1. **`VisitTileAllocator.js` — add agent metadata cache.** In `updateContext` (~line 48-59), build `this.agentMeta = new Map<agentId, {teamName, parentSessionId}>` from each sprite's `agent`. Recomputed every context update; cheap (O(N)).
2. **`VisitTileAllocator.js` — helper `_relatedAgentIds(agentId)`.** Returns a `Set` of agent IDs that share team or are parent/child of `agentId`. Memoize per `updateContext` cycle (e.g. `this._relatedCache = new Map()` cleared in step 1) so concurrent allocations during the same tick share the lookup.
3. **`VisitTileAllocator.js` — extend `_scoreSlot`** (`VisitTileAllocator.js:259-306`) with a clustering term. After computing `distance`, before returning, compute:
   - `related = _relatedAgentIds(agentId)`
   - `nearest = Infinity`; iterate live reservations (already iterated in `_reservationsForSlot` — could reuse, but for clarity scan `this.reservations.values()` once and skip expired/self/different-building). For each reservation whose `agentId ∈ related` and same `buildingType`, take `dist = _distance({tileX, tileY}, slot)`; track min.
   - If `nearest <= 2.5` tiles, subtract a bonus `CLUSTER_BONUS` `[speculative: 25-35; start at 30]`. Linear falloff is unnecessary at these scales; a single threshold + flat bonus is enough and easy to tune.
4. **Bonus magnitudes (recommended starting values).** `[speculative]` `RELATED_CLUSTER_BONUS = 30`. Sanity:
   - smaller than `RESERVED_PENALTY` (180) → cannot override a collision,
   - smaller than `OVER_CAPACITY_PENALTY` (130) → cannot stuff capacity,
   - larger than typical `BUILDING_CROWD_PENALTY` (18) and `DISTANCE_WEIGHT × tile_dist` (≤ ~5) → can pull a related agent into an otherwise less-attractive adjacent slot,
   - smaller than `SAME_AGENT_SLOT_BONUS` (90) → a sticky reservation is still preferred over re-clustering during renew.
5. **No changes to `VisitIntentManager` or `RelationshipState`.** RelationshipState's debounce is for cosmetics (rings, arcs); the allocator already iterates live `agentSprites` every `updateContext`, which is the freshest source.
6. **No change to `CouncilRing.applyTeamPlazaPreferences`.** It still steers idle teammates toward the civic plaza at the *building* level; clustering happens at the slot level after that bias takes effect. The two compose.

## Edge cases

- **Solo agent (no related peers reserved at this building).** `nearest === Infinity`, bonus = 0, behavior identical to today.
- **Related agent reserved at a *different* building.** Excluded by the `same buildingType` filter — clustering should not pull agents to the wrong building. Building selection is the intent layer's job.
- **Stale reservation for a related agent that's actually walking away.** Expired reservations are pruned by `cleanup` at the start of every `allocate` (`VisitTileAllocator.js:69`); only live reservations contribute.
- **All slots adjacent to a related agent are also reserved by others.** The bonus is dwarfed by `RESERVED_PENALTY=180`; agent picks an unreserved farther slot. Correct: collision avoidance wins.
- **Subagent vs parent bi-directionality.** `parentSessionId` is set only on the child. `_relatedAgentIds(childId)` returns `{parentId}` directly; `_relatedAgentIds(parentId)` must scan `agentMeta` for any entry whose `parentSessionId === parentId`. Fine — done once per `updateContext` and cached.
- **Two large teams converging on `command` simultaneously.** Each team clusters internally; their two clusters end up at opposite ends of the slot pool because the `RESERVED_PENALTY` from the other team's slots pushes them apart. Reads correctly as two huddles, not one mob.
- **Chat partners.** Out of scope here; chat already uses an ad-hoc 2-shot pose (`AgentSprite._pickTarget`:209-222). Adding chat-pair clustering would conflict with the chat-pose offset and is unnecessary.

## Verification

- `npm run dev` and stage two scenarios via live data (or by manipulating an existing session JSONL):
  - Parent + ≥2 subagents working at `command`. Expected: subagents take slots within 2 tiles of the parent's slot.
  - ≥2 idle teammates with `command` plaza preference active. Expected: they pick adjacent flank slots, not opposite sides.
- Add a counter to `metrics`: `clusteredAllocations` (incremented when the chosen slot's `nearest` was finite). Surface in `snapshot.metrics`. Acceptance: for a session with ≥1 parent-with-children, `clusteredAllocations > 0` and the parent's children's reservations are within 2.5 tiles of the parent's reservation `[speculative]` 80%+ of the time.
- Snapshot inspection: `GET` the in-memory allocator snapshot via the existing debug pathway (`debug` returns `snapshot`); confirm the `reservations` for related agents share `buildingType` and have low pairwise tile distance.
- Visual smoke: at zoom 3, a parent+subagents cluster reads as a small group, not a building-wide spread. If the spread still looks too even, raise `RELATED_CLUSTER_BONUS` toward 40.

## Risks

- **Bonus tuning.** 30 is a guess. Too low → no visible change; too high → fights flank-spread for unrelated agents (it shouldn't, since unrelated agents see no bonus, but interactions with `BUILDING_CROWD_PENALTY` are subtle). Keep the constant named and obvious.
- **O(N×R) scan for related-reservation distance.** With current scale (≤8 agents) it's noise. If agent count grows past 30, consider indexing reservations by `buildingType` upfront in `updateContext`.
- **Subagent fan-out at parents on the move.** If the parent's reservation is still expiring while children allocate, the cluster pulls toward a soon-to-vanish anchor. Mitigated by the `cleanup` sweep at the start of each allocate call. If this proves visible, gate the bonus on `existingReservation.expiresAt > now + 2000ms` for the related peer.

## Out of scope

- Spatial team rings / parade-formation choreography.
- Cross-building "follow my parent" routing (already handled by the subagent intent in `VisitIntentManager`).
- Chat-pair adjacency (already handled by chat-pose offset).
- Reactive recluster when a parent moves mid-dwell — agents stay where they reserved; the next retarget will recluster.
- Promoting `RelationshipState` into the allocator — unnecessary today; revisit only if (a) underdelivers.

**Recommendation: approach (a) — relationship-aware bonus inside `_scoreSlot`, fed by an `agentMeta` map built in `updateContext`.**
