# Agent Behavior — Council Research

Date: 2026-05-17
Status: reference
Baseline HEAD: e919f845c5074487c694d6aa163968df48728de1
Initial git status: ` M AGENTS.md\n M CLAUDE.md`

## Method

Read the full behavior stack — `AgentSprite`, `AgentBehaviorState`, `VisitIntentManager`, `VisitTileAllocator`, `AgentEventStream`, `RelationshipState`, `ArrivalDeparture`, `TrailRenderer`, `CouncilRing`, `LandmarkActivity`, `RitualConductor`, `IsometricRenderer._updateChatMatching/_resolveStationaryOverlaps`, plus the `ToolIdentity` classifier, the `Agent`/`AgentStatus` domain, and the Claude adapter's tool surface. Cross-referenced the active refinement plan (`agents/plans/agent-building-interactions-refinement.md`) and the broader review (`agents/research/agent-movement-broader-review.md`) to avoid re-proposing landed work. Validated every cited line by reading the source rather than relying on prior notes.

## Tool→Behavior Map Audit

`classifyTool` (`claudeville/src/domain/services/ToolIdentity.js:258`) is the single source of truth for destination. Today most tools map crisply, but several useful semantic slices never surface in motion, posture, or speech-bubble text.

| Tool family | Current destination | Posture / animation | Bubble label | Gap (why agent behavior is weak) |
| --- | --- | --- | --- | --- |
| `Read`, `Grep`, `Glob`, `LS` (docs) | archive | walk → idle bob | `Reading …` | OK. No "page-leaning" pose at slot — agent faces whatever direction it stepped from (`AgentSprite._updateFacingDirection` only acts on velocity). |
| `Read`/`Grep` over `src/` paths | forge (`reason: inspect-code`) | same as above | `Searching …` | Forge is hammer/anvil district but inspection is not edit-time. Same posture as Forge-write; no "examining workbench" affordance. |
| `Edit`, `MultiEdit`, `Write`, `apply_patch` | forge | idle bob | `Editing <file>` | Mutation has ritual (`RitualConductor` forge-strike, `RITUAL_META.forge`, 1500 ms, medium pulse) but agent itself never leans/swings. |
| `Bash` shell — git/gh/wrangler/vercel | harbor | walk → idle | `Running git…` | Bash-classifier (`classifyShellInput`, line 224) is good. But agent posture identical for `git status` (quick) vs `git push` (long, status-bearing). |
| `Bash` shell — npm test/lint/build | taskboard | walk → idle | `Running …` | OK route, but failed validations have no negative motion cue (no error state at all). |
| `Bash` shell — Playwright/browser/localhost | portal | walk → idle | `Running …` | OK. |
| `WebFetch`, `WebSearch`, `web.run`, curl | observatory | walk → idle | `Researching <host>` | Bubble shows tool, not the queried host (Observatory ritual does extract host but the agent's bubble does not). |
| `TaskCreate`, `TaskUpdate`, `TaskList`, `TodoWrite`, `update_plan` | taskboard | walk → idle | `Planning …` | TaskUpdate→completed is invisible at the agent level (only LandmarkActivity flips a paper). |
| `SendMessage` | command + special chat pair | walk to partner, chat ellipsis | `Messaging "<partner>"` | Chat-pair match only works when `currentToolInput` is itself a recipient string (see Bug B1). |
| `TeamCreate` | command | walk → idle | `Messaging` (override missing) | No `TeamCreate` entry in `TOOL_ACTION_LABELS` — falls through to readable-name. Posture indistinguishable from solo work. |
| `Task` (subagent delegate) | command | walk → idle | `Delegating` | OK label, but no visible "summoning" wind-up at agent before child appears at Command. |
| `functions.spawn_agent`/`send_input`/`wait_agent`/`resume_agent`/`close_agent` | command | walk → idle | `Spawning Directing Waiting On Resuming Closing` (overrides at `AgentSprite:84`) | OK labels. No relational sweep — children arrive elsewhere via `ArrivalDepartureController.beginAgentArrival` but the parent does not visibly "release" anything. |
| `NotebookEdit` | forge | walk → idle | falls through to readable | `NotebookEdit` not in `TOOL_ACTION_LABELS`; shows as `Notebook Edit`. Acceptable. |
| `EnterPlanMode`/`ExitPlanMode` | unclassified (returns `null`) | nothing — bubble shows current status only | none | **Not routed anywhere**. Plan-mode transitions are completely invisible (see R5). |
| `AskUserQuestion`/`request_user_input` | taskboard (`functions.request_user_input` only) | walk → idle | falls through | Bubble doesn't differentiate "agent is *waiting on the user*" from "agent is computing". |
| `multi_tool_use.parallel` | weighted majority (`MULTI_TOOL_PRIORITY`) | single destination | overridden to `Coordinating` | Parallel work shown as a single destination — the *parallelism* is invisible. |
| Token deltas ≥256 | mine (via `LandmarkActivity._observeTokens:165` emits synthetic `tool:invoked`) | no agent motion | none | Mine never gets a visit from the responsible agent — only a ritual at the building. Token Mine effectively empty. |
| Context ratio ≥0.82 | mine (`_deriveTokenIntents` quota-pressure intent) | quota sentinel may route there | none | Sentinel selection (`_deriveGlobalIntents` line 333) only fires when ≥4 agents working **and** another agent is idle. In the 2-agent screenshot this never triggers. |
| Long-wait >120 s, long-work >300 s | watchtower / current building | no agent-visible cue | none | Behavior intent exists; no posture, no expression, no trail tinting. |
| Rate-limit / quota throttle | no surface at all | n/a | n/a | Nothing parses `services/usageQuota.js` quota state into per-agent behavior (only Token Mine's seam tint, in `LandmarkActivity`). |

Verified current-implementation status of prior plans referenced below: `agent-building-interactions-refinement.md` Phases 1–3 are landed (VisitIntentManager, VisitTileAllocator, AgentBehaviorState all exist; verified `VisitIntentManager.js:59`, `VisitTileAllocator.js:26`, `AgentBehaviorState.js:3`). Phase 5 building workflow loops are partly landed: forge→taskboard handoff intent exists (`VisitIntentManager.js:167`), Mine ritual exists (`LandmarkActivity:165`), watchtower alert intents exist (`VisitIntentManager:259, 308, 318, 333`). Phase 6 stationary de-overlap landed (`IsometricRenderer._resolveStationaryOverlaps:2132`). What is **not** landed: per-agent fidget/micro-action, building-facing on arrival, parent-child slot clustering at allocator level, plan-mode visual, error/failure posture, multi-tool parallelism cue, idle/waiting differentiation beyond walk speed.

## Current State Verdict

The intent-and-allocator pipeline works; agents do reach the right buildings most of the time. The film "feels lifeless" because once agents stop walking they look identical (same idle bob, last-step facing, same bubble cadence) and the underlying state — working vs waiting vs error vs plan-mode vs rate-limited — is invisible from a glance. The bubble system over-shows tool detail (history bubble stack at `AgentSprite._drawStatus:2231` shows up to 3 entries) while under-showing posture/motion variation. Token Mine and Lighthouse exist but are almost never visited because the routing rules require strong global conditions; meanwhile Archive and Command absorb the vast majority of motion-bearing intents.

## Recommendations

### R1. Face-the-target on arrival, with per-state stance offsets

- Impact: High. Effort: S. Confidence: High.
- Problem: On arrival, `AgentSprite.update()` snaps to target (line 765) and calls `behavior.arrive()` but never resets facing. The condition at `AgentSprite.js:781` calls `_faceBuilding(...)` *only when there is no chat partner*, and `_faceBuilding` itself uses building **tile center**, which is often *behind* the agent for visit-tiles drawn in front of buildings (e.g. command center at `(13,16) 5×4`, visit tile `(16,21)` — `_faceBuilding` computes center `(15.5, 18)`, agent at `(16,21)`, dir vector is `(-0.5, -3)` → "north-ish", correct for command, but for Archive whose visit tiles are *east of the building* (`8-10, 16-19`) the dir vector points west across the front wall, often inverted). Confirmed against current code: `_faceBuilding` does target the tile center, but its outcome at side-mounted visit tiles is unstable. Broader review finding #1 also flags this.
- Proposal:
  1. Add an explicit `facingPoint` (world coords) to each `visitTile` entry in `BUILDING_DEFS`. Allocator threads it through the reservation payload.
  2. `AgentSprite._faceBuilding` accepts the facing point if present; otherwise falls back to current center math.
  3. Introduce stance offsets that bias the chosen 8-direction value to the building's logical "front":
     - Forge / Mine — face the anvil/seam (already inside building footprint).
     - Archive — face along the shelf row.
     - Harbor — face the water edge.
     - Observatory — face the dome/telescope.
  4. Apply on `behavior.arrive` AND every 4–9 s during dwell (re-anchor after fidget).
- Touchpoints: `AgentSprite._faceBuilding` (line 860), `AgentSprite._advanceFidget` (line 872), `BuildingSprite` (for facingPoint config), `VisitTileAllocator.allocate` payload (returns facingPoint).
- Dependencies: Buildings council (needs `facingPoint` in `visitTiles` config), Character Design (which directions read best per pose).
- Validation hook: visual diff per building with 6 agents arrived; confirm ≥80% face the building's content axis.

### R2. Posture differentiates state (working / waiting / idle / chatting / error / waiting-on-user)

- Impact: High. Effort: M. Confidence: High.
- Problem: Today only walk-speed differs across status (`_speedForState` at `AgentSprite.js:578` — 1.5 working, 1.1 waiting, 0.8 idle, 2.5 chat). Once stopped, all states look identical (same 4-frame idle strip). The screenshot's `2 WORKING, 0 IDLE, 0 WAITING` row reads the same to a viewer as `0 WORKING, 2 IDLE`. The only stationary cue is the status-color ground ring at `AgentSprite._drawGrounding:1247`, which is subtle.
- Proposal: Add stance modifiers atop the existing idle/walk sheets, applied per state via a small overlay layer (so no new sprite generation):
  - **Working at building** — head tilt + hand-up overlay (1 px hand bob in sync with `RitualConductor` event for that building). Pulse band `medium`, matching ritual.
  - **Waiting** — arms-crossed overlay + occasional head-pan; subtle clock-tick chevron above head every ~3 s. Pulse band `slow`.
  - **Idle** — current behavior but slower bob (~0.4 px) and rarer fidget (8–12 s vs 4–9 s).
  - **Waiting on user** (new state, distinct from `waiting`) — yellow `?` glyph above head every 4 s; sprite gently rocks toward viewer. Triggered by `currentTool === 'AskUserQuestion'` or `functions.request_user_input` or the heuristic `agent.lastMessage` ends with `?` and `status === 'waiting'`.
  - **Error / failed** — red `!` glyph + crouch overlay; ground ring desaturates. Triggered by `agent.gitEvents` having a `status === 'failed'` recent entry, or — Phase 2 — by `agent.lastMessage` matching `/error|failed|exception|timeout/i` (low confidence; gate behind a heuristic flag).
  - **Chatting** — already differentiated (ellipsis bubble); add a hand-gesture sub-pose alternation each 600 ms.
- Touchpoints: New `AgentStanceOverlay.js` (presentation/character-mode); `AgentSprite.draw` (after sprite, before bubble); `AgentStatus` value object (add `WAITING_ON_USER` constant); `Agent.bubbleText` for `?` detection.
- Dependencies: Character Design (overlay PNGs in manifest), Visual (overlay alpha/pulse coordination via PulsePolicy).
- Validation hook: 5-agent test scene with one per state; manual visual review and Playwright screenshot per status.

### R3. Chat / SendMessage — fix recipient resolution and stage rendezvous at Command Plaza

- Impact: High. Effort: M. Confidence: High.
- Problem: Bug B1 (see Bugs section): `IsometricRenderer._updateChatMatching:1940` does `spriteByRecipient.get(agent.currentToolInput)`, treating the entire raw input as a recipient alias. In practice, providers serialize `SendMessage` arguments — `claude.js` already invokes `summarizeToolInput(block.input, { maxLength: 60, basenameFile: true })` (`adapters/claude.js:371`) so `currentToolInput` is a *summarized* string like `recipient_name: alice, message: hello…`, not the alias `alice`. `AgentEventStream.extractTargetRef` (line 104) does the right parse but is not used for chat pair matching. Result: chat almost never matches in real sessions.
- Proposal:
  1. Replace the raw alias lookup with a parse pipeline reusing `extractTargetRef` from `AgentEventStream` (move into a shared `RecipientResolver.js` under `domain/services/` to avoid presentation-layer dependency).
  2. After resolution, perform a tile-aware rendezvous: if both agents have line-of-sight to **Command Plaza** (the same `COMMAND_ARRIVAL` tile used by `ArrivalDepartureController`), prefer routing the *sender* to a slot adjacent to the *recipient's* current slot. If recipient is far, sender walks to the midpoint plaza tile, not the recipient's exact +25/−25 offset.
  3. While chatting, increase ellipsis bubble cadence proportional to message length (longer summarized `currentToolInput` → longer ellipsis cycle).
  4. On `chat:ended`, emit a tiny "scroll departing" sigil (reuse `ArrivalDeparture.drawDepartureSigil` pattern) — visible handoff.
- Touchpoints: `IsometricRenderer._updateChatMatching:1935`, new `claudeville/src/domain/services/RecipientResolver.js`, `AgentSprite._pickTarget:236` chat-branch, optional `ArrivalDeparture` sigil hook.
- Dependencies: Portal/Subagent council (subagent dispatch lifecycle), Visual (sigil glyph).
- Validation hook: scripted scenario with `SendMessage` whose `currentToolInput` is `recipient_name=Prism, message=hi`; confirm sender now routes to Prism.

### R4. Subagent rendezvous arc & "carrier bird" visual handoff

- Impact: Medium. Effort: M. Confidence: Medium.
- Problem: `RelationshipState.parentToChildren` tracks parent/child, `ArrivalDepartureController.beginSubagentDispatch` draws a wisp from parent to child arrival point, and `VisitIntentManager._deriveRelationshipIntents:275` gives the child a `subagent` intent toward the parent's last-known building. But the visual is only a single short wisp and the child's *initial walk path* does not curve toward the parent. Spawn looks like a teleport-with-flare.
- Proposal:
  1. On `subagent:dispatched`, push a 3-waypoint arc (parent → Command Plaza → child arrival) into the dispatch wisp so it traces a meaningful path.
  2. For the first 8–10 s of the child's life, score-bonus slots within 2 tiles of the parent (Allocator already has `RELATED_CLUSTER_BONUS`, but `RELATED_CLUSTER_RADIUS` is 2.5 and the bonus is only −30; raise to −60 during the cling window).
  3. On `functions.wait_agent` issued by parent, show a paused-clock glyph above parent until the child completes or the wait tool ends.
  4. On `subagent:completed`, run the existing `recordSubagentCompletion` cue but also bias the parent's next ambient destination toward Command Plaza for ~30 s (continuity).
- Touchpoints: `ArrivalDepartureController.beginSubagentDispatch:129`, `VisitTileAllocator._scoreSlot:344` (cling window via metadata on agent), `AgentSprite._ambientBuildingTypeForState:317` (post-completion bias), `Agent.bubbleText` for wait clock glyph.
- Dependencies: Portal/Subagent council (timing model), Visual (clock glyph).
- Validation hook: spawn a fake parent+child via the proposed simulation fixture (see R10); confirm child clusters near parent for ≥8 s.

### R5. Plan mode & token-spend get first-class behavior

- Impact: Medium. Effort: S. Confidence: High.
- Problem: `EnterPlanMode`/`ExitPlanMode` have icons in `TOOL_ICONS` (line 53–54) but no `DIRECT_TOOL_CLASSIFICATIONS` entry, no `TOOL_ACTION_LABELS`, no building. They emit no behavior. Token Mine receives the synthetic `__token_delta` ritual (mine ritual fires at building) but the *responsible agent* never walks to Mine — Mine looks empty even during heavy work.
- Proposal:
  - **Plan mode**: classify `EnterPlanMode` → `taskboard` with `reason: 'plan-mode-enter'`, `ExitPlanMode` → `taskboard` `reason: 'plan-mode-exit'`. While in plan-mode, mark agent with `behavior.planMode = true` (set when last tool transitions and cleared on ExitPlanMode or any other tool). Visualize as a permanent compass/blueprint glyph above the agent until exit. Pulse band `static`.
  - **Token spend visualization**: on token delta ≥1024, route the producing agent on a one-way visit to Mine (high-priority intent, single-shot, 8 s dwell). Add `reason: 'cash-out'` for differentiation. Below 1024 tokens, the existing `__token_delta` ritual at Mine without agent travel remains the cheap path.
  - **Rate-limit / quota throttle**: when `usageQuota.fiveHour > 0.85`, emit a `quota:throttled` event from `App.js` (subscriber to `usage:updated`); `VisitIntentManager` consumes it and gives every WORKING agent a low-priority `quota` source intent toward Mine; while throttled, agent ground ring desaturates toward grey and walk speed drops 0.7×.
- Touchpoints: `domain/services/ToolIdentity.js` (`DIRECT_TOOL_CLASSIFICATIONS`, `TOOL_ACTION_LABELS`); `VisitIntentManager._deriveTokenIntents:198` (add big-delta walk); `AgentBehaviorState` (`planMode` field); `AgentSprite._drawStatus` (compass glyph); `services/usageQuota.js` ↔ `App.js` event wire.
- Dependencies: Visual (compass glyph asset), Buildings (potential Mine visit-tile addition for cash-out slot).
- Validation hook: run with `EnterPlanMode` in tool feed; confirm compass appears above agent; trigger 1500-token delta and confirm agent walks to Mine.

### R6. Failed tool / error / retry — visible posture across providers

- Impact: Medium. Effort: M. Confidence: Medium.
- Problem: Provider adapters don't expose tool *failure* (claude.js status is always `'active'`; only `gitEvents[].status === 'failed'` from `gitEvents.js` flags failures). Yet agents do retry — same tool, same input twice, often with longer `currentToolInput` truncation flagged the second time. Today no behavior reflects retry/error.
- Proposal:
  1. In `AgentEventStream._emitToolIfChanged:306`, when the same `(tool, normalized-input)` key fires twice within 20 s, emit a synthetic `tool:retried` event carrying retry count.
  2. `AgentSprite` listens via `AgentEventStream` (or a thin wrapper) and shows a yellow `↻` glyph during retry, pulse band `medium`, decays in 6 s.
  3. For known failed signals — git push failed (already routed to `watchtower` via alert intent), test failures detected by `agent.lastMessage` containing `/FAIL|error:|✗|✖/` — add `behavior.errorBurst = ts` and tint ground ring red briefly. **Important**: keep heuristic gated behind a config flag because false positives ("error:" can appear in benign reads of logs) would be loud.
  4. After a failed-push (`gitEvents` with `status === 'failed'`), the responsible agent walks to `watchtower` instead of Harbor for the next visit. This is partially in `VisitIntentManager._deriveGitIntents:259` (creates a watchtower alert intent) but isn't given highest priority — bump priority from default `alert` 90 to a one-shot 110.
- Touchpoints: `AgentEventStream` (retry detection), `VisitIntentManager._upsertIntent` (priority override path), `AgentSprite._drawStatus` (`↻` and `!` glyphs).
- Dependencies: Git/Harbor council (cross-team — failed-push priority lives at the intersection), Portal/CodeHealth (sentry pattern).
- Validation hook: inject 2 identical `Edit` calls within 5 s in a sim fixture; confirm `↻` glyph.

### R7. Idle walking gets a "stroll" gait and uses authored roads

- Impact: Medium-High. Effort: M. Confidence: High.
- Problem: `_speedForState` (line 578) returns 0.8 for IDLE, which is slow but not visually distinct from WORKING's 1.5 — both look like walking. There is no "casual stroll" rhythm. Broader review finding #6 covers road-following; that plan (`agent-movement-road-following.md`) exists but appears not implemented — confirmed against current `AgentSprite._roadWaypointsForScenic:289` which is wired only for scenic ambient destinations (`building.routeViaRoads` is true), not for all idle visits. Most idle routes still cut grass diagonals.
- Proposal:
  1. Introduce IDLE-specific gait: speed 0.8 with a deliberate stride pause every 12 frames (pause for 6 frames). Implement as an additional state in `_advanceWalkAnimation:792`.
  2. Idle agents always route via roads when the next visit is >6 tiles away (extend `getRoadTiles` use beyond scenic; modify `_assignTarget:428` to insert nearest-road waypoint for all idle traversals).
  3. Occasional "stop and look" — every 18–30 s, idle agent pauses 1–2 s, faces a nearby landmark, then resumes. Use `_advanceFidget` pattern (line 872) with a longer cooldown.
- Touchpoints: `AgentSprite._speedForState:578`, `AgentSprite._advanceWalkAnimation:792`, `AgentSprite._pickTarget:235` (always-via-roads for idle).
- Dependencies: Visual (no new sprites required), Buildings (no overlap).
- Validation hook: 5-min capture with 3 idle agents; trail renderer should show road-bound zigzag rather than diagonal grass cuts.

### R8. Bubble content and history — truncate on relevance, not on order

- Impact: Medium. Effort: S. Confidence: High.
- Problem: `_drawStatus` (line 2231) shows current activity + up to 2 history entries with linear fade. History is FIFO by tool key, capped at 30 s TTL (`ACTION_TRAIL_TTL_MS = 30000`). For a working agent issuing dozens of `Read` calls in quick succession, history is dominated by repeat-reads; the user loses signal. The screenshot's `"exec_command pharos-watch...yiel..."` bubble is precisely the failure mode: long shell input truncated at the wrong character.
- Proposal:
  1. Replace FIFO history with *category-deduped* history: collapse consecutive same-category entries (`TOOL_CATEGORIES` already classifies — `read`, `search`, `write`, `exec`, `task`) into a single entry with a small "×N" badge.
  2. Truncate at **path-aware boundaries**: prefer truncating at `/`, `.`, ` `, or `:` over mid-word. Already partly done by `compactToolLabel` (`ToolIdentity.js:154`) but not applied to `currentToolInput` previews; the truncated `"exec_command pharos-watch...yiel..."` is from `compactToolInput` at `TOOL_DETAIL_PREVIEW_CHARS = 36`. Add a smarter truncate that prefers ending at word-or-symbol boundary.
  3. For `Bash` / `exec_command`, show the *first argument* not the full command line. `pharos-watch yield-curve` → bubble shows `pharos-watch`.
  4. Promote `currentToolInput` host for Observatory tools to bubble (currently only in ritual label).
- Touchpoints: `AgentSprite._drawStatus:2231`, `AgentSprite._captureActivitySnapshot:2556`, `compactToolInput` (`ToolIdentity.js:162`).
- Dependencies: None (purely presentation).
- Validation hook: scripted scene with rapid `Read` bursts; confirm history collapses to `Reading ×6 …`.

### R9. Team rituals — Council Ring becomes a visit destination, not just an overlay

- Impact: Medium. Effort: M. Confidence: Medium.
- Problem: `CouncilRing.drawCouncilRings` (line 58) draws a beautiful glyph ring around teammates *only after they're already loosely spatial*. It doesn't *attract* members. `applyTeamPlazaPreferences:40` only sets `teamPlazaPreference` boolean which tilts ambient choice toward `command`. There's no choreographed gathering.
- Proposal:
  1. When 2+ team members are simultaneously IDLE and within 12 tiles of each other, emit a one-shot `team:gather` intent (priority 70, sticky 30 s, 30 s TTL) sending them to Command Plaza visit tiles in arc order (sort by atan2 of current position, assign consecutive `visitTiles[]` slots).
  2. While gathered, members face the centroid and switch to chat-ellipsis idle (lighter cadence than active chat).
  3. On any member starting work (status → WORKING), the ritual disperses with a small "scatter" wisp (reuse `ArrivalDeparture._drawWisp`) from centroid outward.
  4. Cap one gather per team per 5 minutes; never gather if any member is in `WAITING_ON_USER`.
- Touchpoints: `RelationshipState._rebuildMembership:81`, new module `TeamGatherChoreographer.js` (or merged into `CouncilRing.js`), `VisitTileAllocator._scoreSlot` (sort bonus by atan2 order).
- Dependencies: Buildings (Command Plaza arc tiles, see Buildings council), Visual (scatter wisp variant).
- Validation hook: spawn 3-member team all IDLE, all within 10 tiles; observe arc gather.

### R10. Behavior simulation fixture for development

- Impact: Medium (developer enablement). Effort: M. Confidence: High.
- Problem: Today there is no way to validate behavior changes without a real CLI session producing tool calls. Plans like `agent-building-interactions-refinement.md:A9` already call this out as deferred work. Without it, validating R3 (chat resolver), R4 (subagent rendezvous), R5 (plan-mode), R6 (retry) requires staging real provider traffic — slow and brittle.
- Proposal: Add `claudeville/src/presentation/character-mode/__simfixture__/AgentSimulator.js`, gated behind `?sim=1` query param:
  - Injects 6–12 fake agents with scriptable tool sequences.
  - Steps a YAML or JSON timeline (`{ ts: 1000, agentId: 'sim1', tool: 'SendMessage', input: 'recipient_name=sim2,message=hi' }`).
  - Bypasses adapter; calls `World.addAgent`/`World.updateAgent` directly.
  - No server writes; no real session file mutation.
- Touchpoints: New `__simfixture__/` directory, conditional bootstrap from `App.js`.
- Dependencies: None.
- Validation hook: load `?sim=1`; confirm no real-session agents disappear.

## Quick Wins (≤1 day each)

1. **Build the missing `TOOL_ACTION_LABELS` entries**: add `TeamCreate: 'Forming team'`, `TaskList: 'Reviewing tasks'`, `NotebookEdit: 'Editing notebook'`, `WebSearch: 'Researching'` (already there), `apply_patch: 'Patching'`, `MultiEdit: 'Editing'`. Avoid `EnterPlanMode/ExitPlanMode` here — those need building routing (R5). Touch: `domain/services/ToolIdentity.js:78`.
2. **Bubble path-aware truncation**: implement word/path-boundary truncate in `compactToolInput` (Recommendation R8.2 only); applies everywhere. Touch: `domain/services/ToolIdentity.js:162`.
3. **Lower idle bob amplitude and slow it**: change the `Math.sin(this.frame * 0.4) * 0.6` at `AgentSprite.js:997` to `* 0.4` and frame multiplier `0.25` for IDLE; keeps WORKING/CHATTING cadence. Touch: `AgentSprite._drawStatus` siblings.
4. **Fix the Multi-tool bubble label**: when tool is `multi_tool_use.parallel`, show `Coordinating ×N` where N is the inner call count from `extractToolCalls`. Touch: `AgentSprite._toolActivityLabel:2638`.
5. **Long-wait glyph (clock chevron)**: when `agent.activityAgeMs > 60_000` and status WAITING, draw a small `〰`/clock glyph in the bubble area instead of repeating `WAIT` label. Touch: `AgentSprite._drawStatus`.
6. **Bump `RELATED_CLUSTER_BONUS` to -45 and `RELATED_CLUSTER_RADIUS` to 3.0**: cheap nudge toward parent/team grouping. Touch: `VisitTileAllocator.js:11-12`.

## Bugs / Defects Observed

- **B1 (Severity: High)** — `IsometricRenderer._updateChatMatching:1940`: `spriteByRecipient.get(agent.currentToolInput)` treats raw summarized tool input as a recipient alias. Real `SendMessage` inputs from claude.js are summarized JSON like `recipient_name: Prism, message: hello` (via `summarizeToolInput` at `adapters/claude.js:371`). The map keys are `agent.name`, `agent.agentName`, `agent.agentId`, `agent.id` — none of these match the summarized string, so chats almost never pair up. The screenshot's chat bubble above Prism is rendered from the per-agent status pipeline, not from a matched pair — confirming the pairing path is rarely hit.
- **B2 (Severity: Medium)** — `AgentSprite._update`'s intent-change reroute check (line 717–727) only runs when `waitTimer === 0`. After arrival, the agent dwells for 60–260 frames (`_waitDurationForState:571`) ignoring fresh intents. Already documented in broader review finding #2.
- **B3 (Severity: Medium)** — `AgentSprite._renewVisitReservation:419` is called while moving (`update:756`), which keeps the *previous* slot reservation alive during the entire walk to the *next* slot. Broader review finding #5; not yet fixed.
- **B4 (Severity: Medium)** — Capacity exhaustion fallthrough: `VisitTileAllocator.allocate` returns `null` when all candidate slots produce no `best` (line 171) — this triggers `_pickTarget` to take the deterministic-hash fallback path (`_visitTileForBuilding:371`), but that fallback **does not respect occupancy** and can produce the same tile multiple agents already occupy. Triggered most reliably when watchtower receives 2+ simultaneous alert intents (capacity 2).
- **B5 (Severity: Low)** — `AgentBehaviorState.setRoute:21` increments `reroutes` and `lastRerouteAt` based on `intentId || building` change. When intent expires and no replacement intent exists, `intentId` becomes `null` while building may stay the same; this looks like "no reroute" but the agent will now ambient-wander away. Debug snapshots understate reroute count.
- **B6 (Severity: Low)** — `AgentSprite._releaseVisitReservation:412` short-circuits when `this._lastReservationId` is null but the agent has its `agent.id` registered upstream in `VisitTileAllocator.agentReservationIds`. If the allocator's record exists without a local `_lastReservationId` cached (possible after an `applyAgentUpdate` cycle), the stale reservation isn't released until the global cleanup pass. Manifests as ghost capacity used by removed agents for up to 20 s.
- **B7 (Severity: Low)** — `RitualConductor.canAccept:288` requires the sprite's tile to be inside the building footprint via `buildingContainsTile`. When an agent arrives at a *side* visit tile (e.g. Archive's `(8,16)` is north of the building, not inside), `containsVisitPoint` returns true but `containsPoint` returns false; if `building.containsVisitPoint` is missing or returns false, the ritual is silently dropped. Confirm against `Building.containsVisitPoint` shape — needs review by Buildings council.
- **B8 (Severity: Low, ergonomic)** — `Agent.bubbleText` (`Agent.js:150`) and `AgentSprite._activityEntryForAgent` (`AgentSprite.js:2568`) compute the bubble text in two different places with different caps (24 vs 60). The domain entity's text is never used by the world renderer (it uses `_activityEntryForAgent`). Dead code path; should be removed or aligned.

## Cross-Domain Coordination

- **Buildings**: R1 needs `facingPoint` per `visitTile`; R9 needs a Command Plaza arc with sortable slots; R5 ("cash-out" Mine visit) needs a fresh single-agent slot at Mine that isn't shared with the existing ambient `mine` capacity. B7 is a Buildings concern (verify `containsVisitPoint` is set for every building in `BUILDING_DEFS`).
- **Character Design** (Council #4): R2 stance overlays are the largest art ask — needs 6 new overlay sprites (working, waiting, idle, waiting-on-user, error, chatting-active) per provider class, OR a single set of provider-neutral overlays. Plan-mode compass glyph (R5), retry `↻` (R6), wait-clock (R5/R9), team-scatter wisp (R9) are simpler decorative glyphs but should match the existing palette and outline style.
- **Visual & Atmosphere** (Council #1): R2 ground-ring desaturation on error/throttle competes with selection halo and effort floor-ring pulses — needs PulsePolicy coordination so the new error state takes priority `100` and overrides effort/working glows briefly. R6 red tint and R5 quota grey tint must register through `LightSourceRegistry` to avoid double-tinting.
- **Portal-CodeHealth** (Council #6): R4 subagent rendezvous depends on accurate `subagent:dispatched`/`subagent:completed` emissions from `AgentEventStream`. Today completion uses sprite removal as a proxy (`AgentEventStream._onRemoved:291`), which is correct but ignores the case where subagent stays alive but its work completes (`functions.close_agent` without removing the session). Coordinate on a richer lifecycle.
- **Git/Harbor** (Council #5): R6's failed-push priority bump (110 over default 90) overlaps with the Harbor council's failure choreography. Decide jointly whether the responsible agent first visits Harbor (commit-flow) or Watchtower (alert-watch) when push fails.

## Council Debate Stance

The two visible problems in the screenshot — "agents look interchangeable" and "bubbles obscure rather than reveal" — both stem from a single design gap: agents are currently *only* destination-bearing; they are not *posture-bearing* or *state-expressive*. The intent/allocator stack is excellent and recently landed (Phases 1–3 of the refinement plan, plus stationary de-overlap, all verified against current code). The next phase has to put information on the agent itself, not at the building. That is why my top three picks all act on the agent surface rather than adding more world choreography.

R2 (stance differentiates state) is the highest-leverage single change because it produces visible signal for every agent in every frame, doesn't require new behavior intents, and unblocks both R5 (plan-mode glyph) and R6 (error/retry glyph). I will defend R2 over additional world choreography (e.g. another ritual, another arrival type) because the world already over-renders the building side relative to the agent side — see how rich `LandmarkActivity` is versus how plain `AgentSprite._drawStatus` is. R3 (chat resolver) ranks second because it fixes a real bug (B1) that silently degrades every demo with multi-agent SendMessage traffic; until it's fixed, R9 (team gather) and any chat-themed Visual proposals will land on broken data. R8 (bubble path-aware truncation) ranks third because the screenshot itself shows the failure: `"exec_command pharos-watch...yiel..."` is precisely a mid-word truncation, and the fix is cheap, isolated, and immediately visible to the user. I will trade R7 (idle stroll gait) for R9 (council ring as gathering destination) only if Visual council prefers fewer total simultaneous motion bands; both ride well together but R9 has higher per-frame cost.
