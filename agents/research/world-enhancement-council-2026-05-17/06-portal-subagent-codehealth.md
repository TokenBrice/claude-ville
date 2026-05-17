# Portal/Subagent + Code Health — Council Research

Date: 2026-05-17
Status: reference
Baseline HEAD: e919f845c5074487c694d6aa163968df48728de1
Initial git status: ` M AGENTS.md\n M CLAUDE.md`

## Method

Read every file in the council brief plus follow-on hops: `BuildingSprite.js` portal block, `AgentSprite.js` familiar mote helpers, and the `agents/plans/familiars-and-council.md` / `agents/plans/post-p0-p2-follow-up-plan.md` baselines. Cross-referenced `agents/plans/feature-foundation.md` schema notes, the buildings layout in `src/config/buildings.js`, and verified `node --check claudeville/server.js` so no recommendation depends on a syntax illusion. All file:line references were re-anchored against the current HEAD `e919f84`.

Confirmed primary sources: `claudeville/adapters/claude.js` (945 LoC), `claudeville/server.js` (1230 LoC), `claudeville/src/presentation/character-mode/IsometricRenderer.js` (6720 LoC), `claudeville/src/presentation/character-mode/ArrivalDeparture.js` (482 LoC), `claudeville/src/presentation/character-mode/RelationshipState.js` (138 LoC), `claudeville/src/presentation/character-mode/CouncilRing.js` (216 LoC), `claudeville/src/presentation/character-mode/AgentEventStream.js` (377 LoC), `claudeville/src/presentation/character-mode/RitualConductor.js` (387 LoC), `claudeville/src/presentation/character-mode/BuildingSprite.js` (3058 LoC; portal block at 2303–2400), `claudeville/src/presentation/character-mode/LandmarkActivity.js` (567 LoC), `claudeville/src/presentation/character-mode/WorldFrameRenderer.js` (225 LoC), `claudeville/src/presentation/character-mode/DrawablePass.js` (111 LoC), `claudeville/src/presentation/character-mode/CanvasBudget.js` (63 LoC), `claudeville/src/presentation/character-mode/AssetManager.js` (262 LoC), `claudeville/src/application/AgentManager.js` (154 LoC), `claudeville/src/application/SessionWatcher.js` (89 LoC), `claudeville/src/infrastructure/WebSocketClient.js` (111 LoC), `claudeville/src/infrastructure/ClaudeDataSource.js` (39 LoC), `claudeville/src/presentation/shared/SessionDetailsService.js` (296 LoC), `claudeville/src/presentation/shared/ActivityPanel.js` (295 LoC), `claudeville/src/presentation/dashboard-mode/DashboardRenderer.js` (515 LoC), `claudeville/services/usageQuota.js` (307 LoC), `claudeville/src/presentation/App.js` (579 LoC), `claudeville/src/config/buildings.js` (284 LoC), and `claudeville/src/config/constants.js` (9 LoC).

## Part A — Portal & Subagent Choreography

### Subagent Pipeline Audit

Trace, edge to edge.

1. **Detection** — `adapters/claude.js:673` `_getActiveSubAgents` walks `~/.claude/projects/<encodedProject>/<sessionId>/subagents/agent-*.jsonl`, mints `sessionId = subagent-<agentId>` (`claude.js:715`), copies `parentSessionId = sessionId` of the host directory (`claude.js:734`), and matches the launch prompt back to the parent's `Agent`/`Task` tool call (`claude.js:709-721`).
2. **Orphan/team-member detection** — `_getOrphanSessions` (`claude.js:744`) reuses the same project scan to surface live JSONLs that the recent `history.jsonl` window missed, now also checking subagent dirs for fresh activity (`claude.js:773-787`). Returns `agentType: 'team-member'` with `teamName` derived from `~/.claude/teams/<name>/inboxes/<agentName>.json` (see `readClaudeTeamMembership` at `claude.js:131-177`).
3. **Normalization** — `adapters/index.js:63` `normalizeSession` flattens to `parentSessionId`, `agentType`, `agentName`, `tokenUsage`, `gitEvents`.
4. **Frontend ingestion** — `application/AgentManager.js:81` `_upsertAgent` copies `parentSessionId` straight onto `Agent` and creates an `Agent` entity. `Agent.isSubagent` (referenced at `IsometricRenderer.js:1527`) returns `true` when `parentSessionId` is set or `agentType !== 'main'`.
5. **Relationship snapshot** — `RelationshipState._rebuildMembership` (`RelationshipState.js:81-99`) groups by `parentSessionId` and `teamName`. Pruned every update via `_prune` (`:130-133`).
6. **Tool/spawn events** — `AgentEventStream._onAdded` (`:254-274`) emits `subagent:dispatched` when a child is added and its `parentSessionId` is a known agent. `_onRemoved` (`:291-304`) emits `subagent:completed`. Tool events for the parent's `Agent`/`Task` tool fire through `tool:invoked` and are classified by `RitualConductor.enqueue` (`:312-363`).
7. **Visual reaction** — `IsometricRenderer._beginRelationshipArrival` (`:1699-1712`) picks between `arrivalDeparture.beginSubagentDispatch` (parent sprite present) and `arrivalDeparture.beginAgentArrival` (no parent). `beginSubagentDispatch` draws a wisp from `parent.x, parent.y-34` to `child.x, child.y-20` over 600 ms (`ArrivalDeparture.js:129-150`). The newly spawned child sprite is placed by `_addAgentSprite` (`IsometricRenderer.js:1687`) at the Village Gate via `_beginAgentGateArrival` (`:1761-1779`), then immediately overridden by `beginSubagentDispatch` which just sets arrival state to `'pending'` without moving the sprite.

**Gap inventory.**

- **G1.** Subagents never spawn at Portal Gate. They appear next to the parent (or wherever the gate placed them) and play a 600 ms wisp. The Portal Gate's ritual block (`BuildingSprite.js:2303-2400`) already understands a `summon` action and draws rings + a target arrow when `commandLifecycle.kind === 'spawn'`, but `_drawPortalRitual` only fires from `RitualConductor` entries whose `meta.commandLifecycle` is a `command` lifecycle event (`RitualConductor.js:182-198`). The parent's `Task`/`Agent` tool call has `commandLifecycle` populated by `AgentEventStream._toolEvent` (`:317-333`), but the renderer never feeds `subagent:dispatched` into the conductor — it goes only into `ArrivalDepartureController`. The visual "summon" thus disconnects from the data event that should anchor it to the obelisks.
- **G2.** `Agent`/`Task` tool calls only classify into `building: 'command'` (see `commandActivityLabel` in `LandmarkActivity.js:85-89` and `ritualMetaFor` at `RitualConductor.js:182-199` where `tool === 'Task'` falls under "command" not "portal"). Result: the Portal ritual block runs for MCP and `spawn_agent`-style explicit lifecycle tools only, not for vanilla `Task`/`Agent` invocations. That contradicts the user's mental model of Portal-as-summoning-altar.
- **G3.** Parent ↔ child tether after the 600 ms dispatch wisp is a "familiar mote" orbiting the parent (`AgentSprite.js:2862` `familiarMoteEntries`). There is no persistent line / leash between the parent sprite and the child sprite during the child's lifetime. The user said the Portal should be the visual home of subagent spawn events; right now once dispatch completes the relationship dissolves into shoulder motes and is invisible unless you stare at the parent.
- **G4.** Subagent `agentName` is rarely set (Claude only when the parent's `Agent` tool input includes `description` — see `claude.js:709-720`). So the council snapshot has many anonymous wisps. `applyTeamPlazaPreferences` (`CouncilRing.js:40-56`) only biases idle members of teams with two or more idle agents; subagents are never in a "team" because `team-member` and `sub-agent` are distinct `agentType`s.
- **G5.** Departure: when a subagent ends, `_beginRelationshipDeparture` (`IsometricRenderer.js:1714-1751`) calls `beginSubagentMerge` (a 400 ms wisp from child to parent) or, if no live sprite, `recordSubagentCompletion` (a 2.2 s diamond at the parent). Neither pulls the wisp back through the Portal — they go to the parent's exact tile. This is symmetric with G1; the Portal is a one-way visual that today only fires for command-lifecycle MCP tools.
- **G6.** Team ring (`drawCouncilRings` at `CouncilRing.js:58-112`) anchors at the Command Center plaza (`{ tileX: 16, tileY: 21 }`). The Portal sits at the bottom-left at tile `(5,29)` with visit tiles around `(9, 34)`. Right now subagent groupings have no spatial home; an idle subagent has nowhere "natural" to congregate.

### Current State Verdict (Portal)

The relationship plumbing landed (snapshots, dispatch wisp, completion cue, familiar motes, council ring), but the Portal Gate is decoratively decoupled from the subagent lifecycle. The summoning visual exists, fires for the wrong events, and never tethers parent to child after the first second. There is a clear opportunity to make the Portal the *visible* anchor of the subagent flow rather than a static rune circle that pulses for MCP HTTP calls.

### Recommendations (Portal)

#### R1 — Re-route Task/Agent tool dispatch into the portal ritual queue
- Impact: High · Effort: S · Confidence: High
- **Problem.** `RitualConductor.enqueue` only sees `tool:invoked` events. `Agent`/`Task` tool invocations get classified into `building: 'command'` (via `LandmarkActivity._observeToolActivity` and the default `ritualMetaFor` branch) and never reach the Portal block in `BuildingSprite._drawPortalRitual`. Subagent dispatches (`AgentEventStream._onAdded:258-263` emitting `subagent:dispatched`) are completely outside the conductor pipeline.
- **Proposal.** In `RitualConductor.js:163-211` extend `ritualMetaFor` to route `tool === 'Task' || tool === 'Agent'` to `RITUAL_META.portal` with `action: 'summon'` and `commandLifecycle: { kind: 'spawn', targetAgentId: <future childId or null>, targetName: classified.label }`. Then in `IsometricRenderer.js` subscribe to `subagent:dispatched` (already emitted by `AgentEventStream`) and forward a synthetic `tool:invoked` with `building: 'portal'` and an additional `summonTargetId` field so `_drawPortalRitual` can pull the actual child sprite via `_targetSpriteForRitual` (already implemented for command lifecycle at `BuildingSprite.js:2331-2355`).
- **Touchpoints.** `RitualConductor.js:182-198`, `IsometricRenderer.js:1142-1175` (wire the bus), `BuildingSprite.js:2303-2400` (no edit needed if commandLifecycle.kind === 'spawn' flows through), `LandmarkActivity.js:85-89` to drop the duplicate "SUMMON" command stub at Command Center when the same agent has an active Portal summon ritual.
- **Assets.** None new — `_drawPortalRitual` already paints rings + arrow + dome label.
- **Dependencies.** R3 reads the child sprite by id, so this should ship before R3.
- **Validation hook.** With a Claude session that has a known parent agent running `Task`: assert one new entry under `relationshipState.parentToChildren` and within 100 ms a `RitualConductor` ritual with `building === 'portal'` and `action === 'summon'`. Manual: spawn a subagent and watch the obelisks pulse rather than the Command Center.

#### R2 — Spawn subagents physically at the Portal Gate
- Impact: High · Effort: S · Confidence: High
- **Problem.** New subagent sprites pop in at the Village Gate (`IsometricRenderer.js:1771-1778`) regardless of parent location or whether the spawn was a Task call. The 600 ms dispatch wisp arcs from parent → child but the child is wherever `_beginAgentGateArrival` parked it. Visually the Portal is empty during what should be its signature moment.
- **Proposal.** Add a `PORTAL_SPAWN_TILE = { tileX: 7, tileY: 32 }` (north entrance of the portal gate footprint, currently a walkable plaza tile per `buildings.js:209-217`). In `_beginAgentGateArrival` (`IsometricRenderer.js:1761-1780`) branch on `agent.parentSessionId`: if set, call `sprite.setTilePosition(PORTAL_SPAWN_TILE...)` with the existing `_gateJitter` (`:1753-1759`) and then `walkToTile` toward the parent's tile or the parent's current intent tile. If no parent, fall back to today's Village Gate behavior. This makes the child appear *out of* the portal, then walk to its workstation.
- **Touchpoints.** `IsometricRenderer.js:1761-1780`, new constant in the same file's hoisted region, `ArrivalDeparture.js:103-127` (optional: add a `'portal'` arrival mode using the spawn tile so departures/arrivals stay in one controller; the current carriage/boat modes do not cover portal spawn).
- **Assets.** None — the portal sprite stays as-is. Optional: a 1–2 frame "step out of portal" mask sliding from beneath the obelisks would polish but is out of scope.
- **Dependencies.** None hard; ships better after R1 so the obelisks pulse during the spawn step.
- **Validation hook.** Spawn a subagent in a fresh session. Confirm `agentSprites.get(<childId>).tileX ∈ [6.7, 7.3]` immediately after `agent:added`. Manual: child sprite appears *at* the obelisks.

#### R3 — Persistent parent → child tether for the subagent lifetime
- Impact: Medium · Effort: M · Confidence: Medium
- **Problem.** Once dispatch completes (600 ms) and merge ends (400 ms on completion), there is no in-world line connecting a live parent to its live children. Familiar motes orbit the parent's shoulder but don't move with the child. New users cannot answer "which agent is whose child" without selecting and reading the panel.
- **Proposal.** Extend `CouncilRing.js` with a `drawFamilyTethers(ctx, { relationship, agentSprites, ... })` that, for each `[parentId, childIds]` in the snapshot, draws a thin animated dashed curve from parent → each live child. Style: provider-colored, alpha 0.18–0.28, dashed `[3, 6]` with `lineDashOffset` scrolling toward the child to imply "command flowing". Hook the call into `WorldFrameRenderer.js:53-61` next to `drawCouncilRings`. Use the existing `RelationshipState.parentToChildren` map.
- **Touchpoints.** `CouncilRing.js` (new export), `WorldFrameRenderer.js:53-108` (call after council rings, before depth-sorted draw so tethers sit under sprites).
- **Assets.** None.
- **Dependencies.** None.
- **Validation hook.** Two-parent + 4-child scenario: confirm exactly four tethers in `_drawables`-adjacent state with each tether's endpoints matching the live sprite tiles. Reduced motion (`motionScale=0`): dashes stay static, alpha unchanged.

#### R4 — Council ring becomes the natural home for the same parent's subagents
- Impact: Medium · Effort: S · Confidence: High
- **Problem.** `applyTeamPlazaPreferences` only handles `teamName` clusters. A parent with 3+ idle subagents has no gravitational anchor; the children scatter.
- **Proposal.** In `applyTeamPlazaPreferences` (`CouncilRing.js:40-56`) add a second pass: for each entry in `snapshot.parentToChildren` with `childIds.size >= 2` and the parent sprite idle, set `setTeamPlazaPreference(true)` on all idle children using the parent's tile as the centroid instead of the Command Plaza. Either piggyback on the existing setter or add `setFamilyPlazaPreference(parentSprite.tileX, parentSprite.tileY)` to `AgentBehaviorState`.
- **Touchpoints.** `CouncilRing.js:40-56`, `AgentSprite.js` (find `setTeamPlazaPreference` for the API parity).
- **Assets.** None.
- **Dependencies.** R3 makes the result more legible.
- **Validation hook.** Parent idle near Forge with 3 idle children: all 3 children drift to within 2 tiles of the parent within 6 s. Stats: `behaviorMetrics.scenicVisits` should not regress.

#### R5 — Departure sigils for orphan subagents go through the Portal, not the parent
- Impact: Low · Effort: S · Confidence: Medium
- **Problem.** If a parent session has already departed (long-running orchestrator finished first) and a child finishes after, `_beginRelationshipDeparture` falls through `requireWorldAgent: true`, treats it as a regular agent, and drops a sigil on the child's last tile (`IsometricRenderer.js:1743-1750`, `ArrivalDeparture.js:192-211`). The child has no visible "return path" and the Portal is silent.
- **Proposal.** When a removed agent has `parentSessionId` set but the parent is no longer in `world.agents`, route through a new `ArrivalDepartureController.recordOrphanReturn(child, lastTile)` that animates the wisp from the child's last tile to the Portal Gate spawn tile rather than fading in place. Reuse `_drawWisp` (`ArrivalDeparture.js:309-328`).
- **Touchpoints.** `IsometricRenderer.js:1714-1751`, `ArrivalDeparture.js:88-211`.
- **Assets.** None.
- **Dependencies.** R2 (so the Portal spawn tile constant is canonical).
- **Validation hook.** Kill the parent first, then end the child; confirm a wisp ends at the Portal Gate, not at the child's last work tile.

#### R6 — Surface subagent identity in their portal-pulse moment
- Impact: Low · Effort: S · Confidence: High
- **Problem.** `_portalRitualLabel` (`BuildingSprite.js:2375-2400`) prefers `lifecycle.targetName || lifecycle.targetRef`. For a Claude `Task` invocation that lacks a description, the label is `SUMMON`. Users have to look up the child's role in a different panel.
- **Proposal.** When emitting the synthetic `tool:invoked` in R1, prefer `child.agentName || classifyTool(...).label || child.role || child.model.split('-')[0]`. Track `subagent_type` (already captured by `claude.js:328`) so labels read e.g. `SUMMON: code-reviewer` rather than blank `SUMMON`.
- **Touchpoints.** `RitualConductor.js:182-198`, `AgentEventStream._toolEvent:317-333`.
- **Assets.** None.
- **Dependencies.** R1.
- **Validation hook.** Spawn a subagent with `description: "code-reviewer"`. Portal label reads `SUMMON: code-reviewer` within 200 ms.

#### R7 — Dispatch wisp uses parent → portal → child instead of straight line
- Impact: Low · Effort: S · Confidence: Medium
- **Problem.** `beginSubagentDispatch` (`ArrivalDeparture.js:129-150`) computes `start = parent`, `end = child` and the wisp arcs straight between them. Visually it ignores the Portal entirely.
- **Proposal.** When R2 lands and children spawn at the Portal, change `beginSubagentDispatch` start to `tileToScreen(PORTAL_SPAWN_TILE)` and rely on the existing 24 px lift so the wisp arcs from the obelisks down to the child. The "command flowing through portal" reads in one frame.
- **Touchpoints.** `ArrivalDeparture.js:129-150`.
- **Assets.** None.
- **Dependencies.** R2.
- **Validation hook.** Visual: wisp originates over the obelisks regardless of where the parent stands.

## Part B — Code Health, Perf, Bugs

### Hotspot Audit

| Subsystem | Concern | Severity | Location |
|---|---|---|---|
| `RelationshipState.update` | Clones the entire `parentToChildren`/`teamToMembers` map every frame, even when `_dirty === false` (only chat pairs change). For a 50-agent session that's 50+ Set allocations per RAF. | Medium | `RelationshipState.js:64-75` |
| `WorldFrameRenderer.renderWorldFrame` | Enumerates ALL drawables (buildings, props, agents, harbor, landmark, chronicle monuments, chronicler, familiars) every frame, then `Array.sort` in place. `drawables.length = 0; drawables.push(...)` then `target.sort` — typical N is hundreds even when the camera shows none of them. | Medium | `WorldFrameRenderer.js:80-100`, `DrawablePass.js:69-104` |
| `RitualConductor.update` | Mutates ritual array, then `filter` rebuilds it every tick even when `rituals.length === 0`. Allocates a new array each frame. | Low | `RitualConductor.js:365-376` |
| `LandmarkActivity._capKind` | For every new item, builds a fresh array via `[...this.items.values()].filter(...)` then sorts, then shifts. O(N²) on the items map; runs per token-delta and per tool emission. | Medium | `LandmarkActivity.js:336-344` |
| `LandmarkActivity._observeCommandRelationships` | `seenSnapshots` is a plain `Set` capped at 400/240 via `_expireItems`. Slice + new Set every cap event. | Low | `LandmarkActivity.js:200-252, 327-334` |
| `IsometricRenderer._buildStaticPropDrawables` | Allocates once at construct, but `_enumeratePropDrawables` (referenced in `WorldFrameRenderer.js:65`) returns a fresh array each frame. | Medium | `IsometricRenderer.js:660-661` and downstream |
| `RelationshipState._lastSpriteTiles` | Map only grows; no eviction when sprite is removed. Cleared on `agent:removed` so OK in practice, but on multi-tab churn during reconnect storms can spike. | Low | `RelationshipState.js:30-50, 117-124` |
| `claude.js` per-file caches | `_sessionEntryCache` (256), `_agentLaunchCache` (128), `_tokenUsageCache` (128). LRU is fine but no max-age — a stale entry can live forever if its mtime cache key happens to match. | Low | `claude.js:23-30, 207-254` |
| `server.js` broadcast signature | Each broadcast SHA-1s a `JSON.stringify(payload)` to detect no-op. For 50 sessions with tool history this is multi-KB JSON every 2 s. | Low | `server.js:792-808` |
| `server.js` watch fallback | `getWatchFallbackSignature` walks up to 2000 entries with `fs.statSync` per scan; runs every 2 s if fallback active. Fine but unbounded if user has huge nested `projects/`. | Medium | `server.js:904-955` |
| `server.js` `wsClients.size === 0` skip | Skips broadcast but still computes `heartbeatDue` math. Trivial. | None | `server.js:783-786` |
| `WebSocketClient` reconnect | Exponential up to 30 s, no jitter. Two tabs reconnecting after a server restart will hammer in lockstep. | Low | `WebSocketClient.js:90-103` |
| `SessionWatcher` poll fallback | Polls both sessions+usage every 2 s while WS is down. No backoff when API returns 5xx. | Low | `SessionWatcher.js:64-88` |
| `ActivityPanel` polling | 2 s polling timer always runs while panel visible regardless of agent activity. Fine for one selected agent. | None | `ActivityPanel.js:160-181` |
| `DashboardRenderer._fetchAllDetails` | Polls every 3 s; can request up to 48 details/cycle. Each `sessionDetailsService` call may issue one batched POST — fine, just verify when `DETAIL_FETCH_LIMIT = 48` is reached, the visible-id selector still prefers `selected` and `working` agents. | Low | `DashboardRenderer.js:411-469` |
| `claude.js` warn cache | `_teamMembershipWarned` Set only grows. Bounded by team config space (small) but never trimmed. | None | `claude.js:28, 166-172` |
| `usageQuota.readHistoryLive` | Reads up to 4 MB tail every 30 s; can re-read the whole file when truncated tail doesn't cross week boundary. Acceptable, but week-boundary aggregation parses entire history.jsonl on cold start. | Low | `usageQuota.js:171-207` |
| `IsometricRenderer` event listeners | `_unsubscribers` populated in `show()` and cleared in `hide()`. Mode toggle invokes `setWorldModeActive` not `hide/show` so listeners survive. Good. But `window.__relationshipState`/`window.__visitIntents`/etc. (`:1132-1138`) are set in `show` but only `__relationshipState` is deleted in `dispose` (`:1260-1262`); the others linger on `window` if dispose runs after `show` re-runs. | Low | `IsometricRenderer.js:1132-1138, 1260-1268` |
| `App.js` global state | `window.__claudeVilleApp` set in `boot`, deleted in `destroy`. But `App.destroy` never called in production. Acceptable. | None | `App.js:548-555` |
| `App._chroniclePruneInterval` | 5-minute interval, cleared in destroy. Good. | None | `App.js:93-97` |
| `usageQuota.tryFetchQuota` | Fires-and-forgets an HTTPS request every 5 min from `fetchUsage()`. The 401/404 returns are silent (correct), but request errors never log. Likely a Cloudflare/Anthropic API auth 404 every 5 min. | Low | `usageQuota.js:211-262` |
| Hard-coded constants `0x1f` "us" delimiter | `AgentEventStream` uses `` for emitted-tool-key dedupe (`:336`); `RelationshipState` uses `|` (`:8-10`). Both work but mismatched conventions add cognitive load. | None | — |
| Memory growth — `_drawables` reuse | `_drawables` is reused with `length = 0; push(...)`. Good. | None | `IsometricRenderer.js:483, WorldFrameRenderer.js:80-91` |
| Memory growth — `_familiarMoteDrawables` | Same reuse pattern. Good. | None | `IsometricRenderer.js:484, 2270` |

### Current State Verdict (Code Health)

The system is in a much better place than the older plans imply: signature gates broadcasts, asset cache + alpha + outline are pre-baked, drawable enumeration is deduped per frame, and the WS layer handles backpressure. The remaining drag is in (a) per-frame allocations in three derivation passes and (b) the still-monolithic `IsometricRenderer.js` (6720 lines) which is the dominant maintainability risk, not a performance one.

### Recommendations (Code Health)

#### R8 — Stop cloning `RelationshipState` maps when membership hasn't changed
- Impact: Medium · Effort: S · Confidence: High
- **Problem.** `update` (`RelationshipState.js:64-75`) builds new Maps + Sets every frame regardless of `_dirty`. Snapshots are read by `CouncilRing.drawCouncilRings`, `LandmarkActivity._observeCommandRelationships`, and `_drawFamiliarMotesForFamilies` at frame rate. The snapshot's consumers do not mutate it.
- **Proposal.** Cache the most recent membership snapshot fragment (`parentToChildren`, `childToParent`, `teamToMembers`). Only rebuild it when `_dirty` was true. Chat pairs and recentArrivals/Departures still rebuild each frame (cheap and time-dependent).
- **Touchpoints.** `RelationshipState.js:58-75`.
- **Validation.** With 50 idle agents, observe `_dirty === false` path: should produce 0 map clones. `performance.measure` shows reduced GC frequency.

#### R9 — Replace `LandmarkActivity._capKind` O(N²) trim with a per-type counter
- Impact: Medium · Effort: S · Confidence: High
- **Problem.** `_capKind` builds a sorted array of all matching items every call (`LandmarkActivity.js:336-344`). Called from `_addForgeItem`, `_addTaskItem`, `_addCommandItem`, `_observeTokens`.
- **Proposal.** Keep a small `Map<type, Array<id>>` insertion-ordered list. Shift the oldest id and delete from `this.items` in O(1).
- **Touchpoints.** `LandmarkActivity.js:91-345`.
- **Validation.** Microbench: spam 200 tool invocations across 4 types; trim time should drop from O(N) per insert to O(1).

#### R10 — Add jitter to `WebSocketClient` reconnect and cap at 15 s
- Impact: Low · Effort: S · Confidence: High
- **Problem.** `WebSocketClient._scheduleReconnect` (`WebSocketClient.js:90-103`) uses `pow(2, attempts-1) * 3000` up to 30 s. Two clients in lockstep will reconnect together and double-broadcast on every server restart.
- **Proposal.** Cap at 15 s, add 0–500 ms random jitter, and reset `reconnectAttempts` on first successful `init` message, not on `onopen` (the latter is already done — but a half-open TCP that never sees init should not reset).
- **Touchpoints.** `WebSocketClient.js:23-103`.
- **Validation.** Restart server with 3 tabs open; reconnect times should be staggered by inspection.

#### R11 — Skip broadcast signature hash when no clients changed since last broadcast
- Impact: Low · Effort: S · Confidence: Medium
- **Problem.** `broadcastUpdate` (`server.js:782-822`) early-returns when `wsClients.size === 0`, but the `heartbeatDue` branch and the `force` branch still hash a multi-KB payload to detect no-op even if the underlying caches haven't changed.
- **Proposal.** Use a coarse cache-stamp counter (bumped by `markProviderDataDirty` and `getTeamsCached`) and skip signature computation when the stamp matches the previous broadcast. Re-introduce hash only when stamp changed and `wsClients.size > 0`.
- **Touchpoints.** `server.js:741-822`.
- **Validation.** `/api/perf` `lastBroadcast.stages` should report `~0 ms` for `signature` when no change occurred.

#### R12 — Constrain `getWatchFallbackSignature` to known provider scopes
- Impact: Medium · Effort: M · Confidence: Medium
- **Problem.** When `fs.watch` recursive support fails (e.g., Linux without `recursive: true` reliability), `getWatchFallbackSignature` (`server.js:904-955`) walks up to 2000 entries per scan in the watched dir. For a user with hundreds of historic Claude project directories this scans all of them every 2 s.
- **Proposal.** Cap fallback scope to the recently active sessions (compute from `sessionListCache`); cache the most recent per-dir signature for 10 s and skip directories that haven't seen new mtimes in the past 5 min.
- **Touchpoints.** `server.js:872-989`.
- **Validation.** `/api/perf.fallbackScans` divided by uptime stays bounded.

#### R13 — Split `IsometricRenderer.js` only along stable seams
- Impact: Medium · Effort: L · Confidence: Medium
- **Problem.** `IsometricRenderer.js` is 6720 lines. The handover (`post-p0-p2-follow-up-plan.md:27`) flagged this. Touching it for any feature work means re-reading sections that aren't connected.
- **Proposal.** Extract three modules behind already-existing call sites: (a) `IsoTerrain.js` for `_drawTerrain`, `_generatePaths`, `_generateTerrainFeatures`, `_classifyRoadMaterials` — all read renderer state but emit no side effects outside it. (b) `IsoGulls.js` for the entire 200-line gull flock block (`:147-282`, draw functions in :5940+). (c) `IsoLightSources.js` for the light cache management and `_computeFrameLightSources`. Pass `renderer` to each as a context object the way `renderWorldFrame` does. Stop short of touching the agent sprite loop or building draw.
- **Touchpoints.** `IsometricRenderer.js` (large but mechanical).
- **Validation.** `node --check` on each new file; bundle behavior identical (no build step, so confirm `import` works in browser); visual diff via `npm run sprites:visual-diff` after a deliberate baseline refresh.

#### R14 — Replace `console.warn` for asset misses with one summary at boot
- Impact: Low · Effort: S · Confidence: High
- **Problem.** `AssetManager._loadImage` warns once per missing PNG (`AssetManager.js:179-188`). On a stale checkout missing 30 assets that's 30 warnings before boot finishes.
- **Proposal.** Accumulate misses, log a single `[AssetManager] missing N assets: …` after `load()` resolves.
- **Touchpoints.** `AssetManager.js:25-188`.
- **Validation.** Console shows at most one missing-asset summary even with 20 missing files.

#### R15 — Drop the unused `ws:message` fallback path or document it
- Impact: None (cleanup) · Effort: S · Confidence: High
- **Problem.** `WebSocketClient._handleMessage` (`:73-87`) emits `ws:message` for unknown types. The bus matrix in `claudeville/CLAUDE.md` already says "none currently; kept for future hooks". The CLAUDE.md is current, so this is documentation parity, not code rot. Leave the code, but verify no listener subscribes silently elsewhere.
- **Touchpoints.** `WebSocketClient.js:73-87`.
- **Validation.** `rg "on\('ws:message'"` returns nothing.

#### R16 — Add a deterministic smoke test under `scripts/` rather than building a test runner
- Impact: Medium · Effort: M · Confidence: Medium
- **Problem.** Project has no test runner by design (`claudeville/CLAUDE.md` Project Shape). The validation table in CLAUDE.md leans on manual curl and visual diff. There is a real gap: small adapter regressions (e.g., the recent subagent-detection commits) need a way to assert behavior beyond running the server.
- **Proposal.** Add `scripts/smoke/adapters.mjs` that imports the Claude adapter, points it at a fixture `~/.claude` tree under `tmp/fixtures/claude/`, and asserts a known set of sessions, parents, and team memberships using `node:assert`. No new dependency. Run via `node scripts/smoke/adapters.mjs`. Same pattern for `scripts/smoke/relationship.mjs` running `RelationshipState` against a stub world.
- **Touchpoints.** new `scripts/smoke/` (out of scope for source edits but listed for downstream council synthesis).
- **Validation.** `node scripts/smoke/adapters.mjs` exits 0 against the fixture.

#### R17 — Document the timing budget triad in one place
- Impact: Low · Effort: S · Confidence: High
- **Problem.** Polling cadence is spread across `constants.js` (`REFRESH_INTERVAL=2000`, `SESSION_DETAIL_PANEL_REFRESH_INTERVAL=2000`, `SESSION_DETAIL_REFRESH_INTERVAL=3000`, `WS_RECONNECT_INTERVAL=3000`), `server.js` (`BROADCAST_POLL_INTERVAL=2000`, `BROADCAST_FULL_DISCOVERY_INTERVAL=20000`, `TEAMS_CACHE_TTL_MS=5000`, `WS_HEARTBEAT_INTERVAL_MS=30000`), `adapters/index.js` (`SESSION_LIST_CACHE_TTL_MS=5000`), and the widget (5 s). The interaction between client poll, WS update, and server cache TTL is non-obvious.
- **Proposal.** Add a section to `claudeville/CLAUDE.md` § "Polling and Cache Cadence" listing each constant and its role, plus a one-line invariant: "Client poll fallback runs at 2 s; server cache TTL is 5 s; WS heartbeat is 30 s; widget poll is 5 s — never lower client poll under server cache TTL/2 or the cache becomes useless."
- **Touchpoints.** `claudeville/CLAUDE.md` (in scope for documentation only).
- **Validation.** Diff readable; no code change.

## Quick Wins (≤1 day each)

- **QW1.** R8 (cache `RelationshipState` membership). 30 lines.
- **QW2.** R9 (LandmarkActivity O(1) trim). 40 lines.
- **QW3.** R10 (WebSocket reconnect jitter). 8 lines.
- **QW4.** R14 (single boot summary for missing assets). 12 lines.
- **QW5.** R6 (portal label using `subagent_type`). 5 lines once R1 lands.
- **QW6.** R17 (CLAUDE.md cadence section). Docs only.
- **QW7.** Delete the lingering `window.__visitIntents`/`__visitReservations`/etc. in renderer dispose (only `__relationshipState` is currently deleted — `IsometricRenderer.js:1260-1268` shows the asymmetry). 6 lines.

## Bugs / Defects Observed

- **B1.** **`window.*` debug helpers leak after renderer dispose.** `IsometricRenderer.js:1132-1138` sets six helpers on `window`; `dispose`/`hide` at `:1260-1268` only deletes `__relationshipState` plus `__visitIntents`, `__visitReservations`, `__agentBehavior`, `__buildingCrowds`, `__agentBehaviorStats`. So `window.__visitIntents` etc. actually *are* cleared — but `window.__relationshipState` is the only one re-installed each `show()` while the others are reassigned without prior `delete`. Today benign, but if mode toggles run faster than `_destroyed`, the helpers may close over stale renderer instances. Severity: Low.
- **B2.** **Subagent dispatched event lacks `subagent_type` enrichment.** `AgentEventStream._onAdded` (`AgentEventStream.js:254-265`) emits `subagent:dispatched` with `{ parentId, childId, ts }` only. The child's `agentType` is in `world.agents.get(childId).agentType` but the consumer (if any) would need to re-look-up. The newer `targetName`-via-launch wiring is only on the *tool* event side. Severity: Low. Fix: include `child.agentType`, `child.agentName` in the payload.
- **B3.** **`_drawPortalRitual` ellipse target uses non-existent `chronicleStore` field.** Visual inspection of `BuildingSprite.js:2331-2355`: `_targetSpriteForRitual(ritual)` (referenced) must come from a getter populated by the building renderer. If the lookup fails (e.g., child not yet spawned), the rings still draw but the line vanishes — that's correct; the bug is that there is no fallback "summon-pending" indicator. Severity: Low. Fix: when `targetSprite === null && action === 'summon'`, draw a downward arrow from the dome to the portal entrance tile.
- **B4.** **`AgentEventStream` does not re-emit `team:joined` when the team itself appears late.** A subagent that joins a team after the team file lands receives `team:joined` only if `previous?.teamName` was falsy (`AgentEventStream.js:281-289`). If `teamName` changes (rename or correction), no event fires. Severity: Low. Fix: also emit on `previous.teamName !== next.teamName`.
- **B5.** **Watch fallback can double-count broadcast.** `runRecursiveWatchFallbackChecks` (`server.js:957-989`) calls `markProviderDataDirty` then `debouncedBroadcast`, but the next `setInterval` tick (`server.js:1079-1087`) also calls `broadcastUpdate({ reason: 'interval' })` — both within 100 ms (BROADCAST_DEBOUNCE_MS). The debounce coalesces them, but the `serverPerf.fallbackChanges` counter increments before the broadcast actually happens, so the metric can over-report. Severity: None (cosmetic in /api/perf).
- **B6.** **`directorySignature` recursion depth limit is 4 dirs.** `claude.js:179-205`. If a user has `~/.claude/teams/<long>/inboxes/<...>/<...>/file.json` the signature can miss inbox file changes. Today claude only nests two levels under TEAMS_DIR, but the limit is silent. Severity: Low.
- **B7.** **Carriage arrival mode is used for subagents.** `arrivalModeForAgent` (`ArrivalDeparture.js:81-86`) returns `'carriage'` for Claude provider. A subagent dispatched via Task — without a live parent sprite — uses the carriage rolling down COMMAND_APPROACH (`:30-32`). That's not a "first-time visitor"; it's an in-band spawn. Severity: Low. Fix: branch on `agent.parentSessionId` and use a `portal` mode (depends on R2).
- **B8.** **`_teamMembershipWarned` Set never cleared.** `claude.js:28`. Persists across `invalidateCaches()` (`:932-942`) intentionally? Comment isn't there. If team configs churn (rename, then rename back), the warn-once behavior is correct, but cache invalidation typically expects a hard reset. Severity: Low. Fix: optional clear in `invalidateCaches`.
- **B9.** **`AssetManager._loadComposedBuilding` throws on any missing cell.** `AssetManager.js:104-128` throws when ANY composed cell is missing. The throw propagates to `load()` which propagates to `App.boot()` which renders the boot-error screen. A single missing `base-0-0.png` for `command` breaks all of ClaudeVille. Severity: Medium. Fix: log + fall back to placeholder canvas in `_loadComposedBuilding` rather than throw.

## Cross-Domain Coordination

- **Visual / Atmosphere (member #1)** — The Portal pulse for `Task` spawn (R1) will compete with night-time atmospheric vignettes and the existing portal rune particle emitter (`IsometricRenderer.js:1058` `portalRune`). Coordinate so the spawn pulse takes priority over the ambient emitter for ~2 s and the ambient emitter resumes after.
- **Agent Behavior (member #2)** — R2 (spawn at Portal) and R4 (family plaza preference) both touch `AgentBehaviorState.setTeamPlazaPreference`. Need behavior member to confirm setter signature stays stable or accept a `setFamilyPlazaPreference(tileX, tileY)` companion.
- **Buildings & Spatial (member #3)** — `PORTAL_SPAWN_TILE = { tileX: 7, tileY: 32 }` (R2) sits inside Portal's walk-exclusion / visit-tile set per `buildings.js:209-217`. Coordinate to make sure spawn tile is walkable and not blocked by a scenery rock. If the buildings member wants to extend the portal footprint, the spawn tile constant moves with it.
- **Character Design (member #4)** — Subagents need a visible "freshly summoned" cue. A 1-frame purple flash or status overlay on `AgentSprite` first 600 ms after `setArrivalState('visible')` would tie cleanly to R2. No new sprite sheet required — overlay tint.
- **Git/Harbor Flow (member #5)** — `arrivalModeForAgent` (B7) currently chooses `boat` vs `carriage` based on `hasGitActivity`. Portal spawn (R2) needs to take precedence over both when `parentSessionId` is set: portal beats harbor beats command-carriage. Coordinate ordering with member #5 since they own harbor activity classification.

## Council Debate Stance

The Portal Gate is the single biggest underused element in the world, and the user noticed. The plumbing already exists — `RelationshipState`, `AgentEventStream`, `RitualConductor`, `_drawPortalRitual`, `beginSubagentDispatch` — but each module currently fires for slightly different events, so the visible result is a Command Center plaza pulse for `Task` dispatches and an idle Portal that only lights up when someone calls a browser tool. Fixing this is a two-evening job: route `Task`/`Agent` invocations into the portal ritual (R1), spawn subagents at the obelisks (R2), and tether parent ↔ child for the child's lifetime (R3). Those three together convert the Portal from decoration into the signature animation of the world.

My top three picks, ranked: (1) **R2 — subagents spawn at the Portal Gate.** Smallest code change, biggest visible payoff, immediately legitimizes the building. (2) **R1 — Task/Agent → portal ritual.** Required to make R2's animation read as causal rather than coincidental. (3) **R8 — cache RelationshipState membership snapshots.** Best perf-to-effort ratio in the council scope; everything that reads relationship data benefits. If the council prefers a fourth slot for non-portal work, **R13 (split IsometricRenderer.js along three stable seams)** is the maintainability win that unlocks every future agent's ability to touch the renderer without two hours of orientation.
