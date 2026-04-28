# Agent-Building Interaction Refinement Plan
Generated: 2026-04-28

## Goal

Make ClaudeVille's World mode feel like a living village where agent movement, building visits, and building feedback are legible consequences of real agent activity.

Today the village already has useful ingredients:

- Agents map tools to building types in `Agent.targetBuildingType`.
- `AgentSprite` routes agents to configured `visitTiles`.
- `AgentEventStream`, `RelationshipState`, `LandmarkActivity`, `RitualConductor`, and `HarborTraffic` already derive higher-level activity.
- Buildings already expose visit geometry and visitor detection.

The missing layer is intent. Agents currently behave like pathing sprites with a fresh-tool target and a last-known fallback. They do not have durable reasons to visit, a crowd-aware target allocator, or a shared behavior model that separates "going to a building", "performing at a building", "roaming", "chatting", and "leaving". This plan adds that layer while preserving the zero-build static ES module architecture.

## Non-goals

- No provider adapter contract change in the first implementation pass.
- No persistent server-side state.
- No new build system, bundler, runtime dependency, or CI setup.
- No removal of buildings in the first pass.
- No rewrite of `AgentSprite` rendering or sprite compositing.
- No broad visual refresh. Visual work is limited to behavior clarity and building purpose.

## Current System Summary

### Building Setup

Buildings come from `BUILDING_DEFS` in `claudeville/src/config/buildings.js`. Each building has a footprint, entrance, `visitTiles`, walk exclusions, scenery sightlines, label metadata, and a descriptive role.

`App.js` creates domain `Building` instances from those definitions and adds them to `World.buildings`. `Building` already supports:

- `containsPoint(tileX, tileY)`
- `containsVisitPoint(tileX, tileY)`
- `primaryVisitTile()`
- `isAgentVisiting(agent)`

This is enough geometry for better visit behavior without changing the config shape.

### Tool Mapping

`Agent.js` maps current and last tools to building types:

- Archive: read, grep, glob, list, docs/search-like shell commands.
- Observatory: web/search/fetch/curl/wget. The plan resolves the current copy mismatch by treating this as the external research observatory and renaming the short label away from `CLOCK`.
- Portal: browser, Playwright, dev-server/local browser flows, some agent-control function tools.
- Forge: file mutations and creation/update/delete-like shell commands.
- Task Board: tasks, todos, plans, tests/checks/builds.
- Command: teams, messages, parallel/team coordination.
- Harbor: git, GitHub, deploy patterns.
- Mine: no direct normal tool target; token and quota systems drive it indirectly.
- Lighthouse: no direct tool target; global activity and failed-push state drive it. Internal building type is `watchtower`; "Lighthouse" is UI copy only.

### Movement

`AgentSprite._pickTarget()` chooses a building from the agent state, picks a visit tile by deterministic hash, and routes through `Pathfinder`.

`AgentSprite._ambientBuildingTypeForState()` supplies fallback movement:

- Working: current/last known building, otherwise Command.
- Waiting: current/last known building, otherwise Task Board.
- Idle: sometimes last-known building, sometimes Command/Mine/provider home, otherwise one of the ambient sequence.

There is no durable destination reason, no reservation of visit tiles, and no distinction between active work arrival and idle roaming.

### Activity Events

Already available:

- `AgentEventStream` emits `tool:invoked`, `subagent:dispatched`, `subagent:completed`, `team:joined`, `chat:started`, `chat:ended`.
- `RelationshipState` tracks parent/child, teams, arrivals/departures, and chat pairs.
- `LandmarkActivity` detects forge/task/command/token activity and draws activity items.
- `RitualConductor` queues building rituals, but only once the agent is already accepted as visiting the relevant building.
- `HarborTraffic` consumes parsed `gitEvents` and renders ships, push states, pending repo activity, and failed-push state.

The key gap: these events do not consistently produce movement intent.

## Problems To Solve

### P0. Archive Concentration

Agents cluster around Archive because:

- Common discovery tools map to Archive.
- Idle/waiting agents keep revisiting `lastKnownBuildingType`.
- Archive has only five tight visit tiles.
- Approach routes funnel to the same front-door area.
- Separation only pushes moving agents, not stopped agents.

This is not a rendering bug. It is a behavior and allocation problem.

### P1. Building Purpose Is Uneven

Some buildings carry rich state:

- Harbor has git events, ships, failed push state.
- Task Board has persistent papers and completion state.
- Command has chat/subagent/team relationship signals.

Others are mostly transient:

- Forge mostly means "a file mutation happened".
- Archive absorbs too many discovery actions.
- Portal mixes browser/dev-server activity with agent orchestration tools.
- Observatory's current copy says "Clock", but its real function is external research/network fetch. This plan chooses to rename/clarify it as the research observatory rather than adding a separate clock workflow.
- Lighthouse is useful as a beacon but not as an agent-visited tool destination. Implementation must target building type `watchtower`.

### P2. Agent Behavior Is A Single Loop

Agents effectively cycle:

1. Pick target building.
2. Walk there.
3. Wait.
4. Pick another target.

Chat and gate arrival/departure are special cases, but there is no general behavior controller.

Missing states:

- Traveling to a work intent.
- Performing at a building.
- Cooling down after a task.
- Roaming near a district.
- Avoiding crowding.
- Joining a team/subagent parent.
- Visiting Mine on real token deltas.
- Visiting Harbor on actual commit/push events.
- Looking out from the Lighthouse (`watchtower`) during global alerts.

### P3. Destination Choice Is Not Crowd-Aware

Every agent independently hashes into a visit tile. The system does not know that a visit tile is already occupied, reserved, or over capacity. This causes visible stacks even when buildings have several visit tiles.

### P4. Movement Does Not Communicate "Why"

An agent walking to Archive, Forge, or Portal does not expose a reason in the movement system. Labels and rituals may reveal current tool after arrival, but the path itself is semantically opaque.

### P5. Testing And Debugging Are Weak For Behavior

There is no built-in way to inspect:

- Current destination.
- Current visit intent.
- Target tile and reservation slot.
- Time until intent expiry.
- Last reroute reason.
- Crowd pressure around a building.

That makes tuning behavior hard.

## Target Design

### Principle 1: Buildings Are Workflow Stations

Each building should have a clear agent-facing purpose:

| Building | Primary role | Visit triggers | Persistent state | Keep? |
| --- | --- | --- | --- | --- |
| Command Center | Coordination | team, subagent, SendMessage, orchestration | team/subagent/chat relationship overlays | Keep |
| Task Board | Planning and verification | TodoWrite, update_plan, tests, lint, build, check | pinned/completed papers | Keep |
| Code Forge | Code and asset mutation | Edit, MultiEdit, Write, apply_patch, generated files, code-mod shell commands | short workbench queue, handoff to Task Board | Keep, refine |
| Token Mine | Usage and context pressure | token deltas, high context ratio, quota warnings | quota seam tint, token carts/items | Keep |
| Archive | Local knowledge and repo reading | docs, read-only local file inspection, explicit search | page flips, shelf/reading markers | Keep, de-overload |
| Observatory | External research and sky awareness | WebSearch, WebFetch, curl/wget, official-doc browsing | telescope sweeps, source/host labels, optional sky/time ambient state | Keep, rename short label from `CLOCK` to `OBSERVATORY` |
| Portal Gate | Browser/dev-server/remote surface | Playwright/browser, localhost/dev server, real Chrome bridge | portal panels, browser session activity | Keep, narrow semantics |
| Harbor Master | Git and release flow | git status/diff/log/commit/push, gh PR/release/deploy | ships, crates, failed push state | Keep |
| Lighthouse (`watchtower`) | Global alert and watch duty | failed push, high active count, long-running work, external alerts | beam intensity/tint, lookout visits | Keep, make purpose explicit |

No building should be removed now. Forge and Lighthouse are weaker than Harbor/Task Board, but both become useful if connected to workflow loops rather than decorative ambient effects.

Implementation ids must stay explicit:

| UI name | Internal building type |
| --- | --- |
| Command Center | `command` |
| Task Board | `taskboard` |
| Code Forge | `forge` |
| Token Mine | `mine` |
| Grand Lore Archive | `archive` |
| Observatory | `observatory` |
| Portal Gate | `portal` |
| Harbor Master | `harbor` |
| Lighthouse | `watchtower` |

### Principle 2: Agents Move From Intent, Not Only Current Tool

Introduce a presentation-side `VisitIntent` model:

```js
{
  id: `${agentId}:${source}:${sourceKey}`,
  agentId,
  building,
  source,        // tool | git | chat | team | subagent | token | quota | ambient | alert
  reason,        // edit-file | read-docs | search-code | run-checks | commit | push | message | join-team | token-delta | alert-watch
  priority,      // higher wins
  confidence,    // 0..1
  createdAt,
  expiresAt,
  stickyUntil,
  targetTile,    // optional, assigned by allocator
  payload
}
```

Keep this in World mode presentation code first. Do not persist or expose through adapters until behavior proves itself.

### Principle 3: Visit Tiles Are Allocated

Add a `VisitTileAllocator` that ranks building visit tiles by:

- Existing reservations.
- Current sprite positions.
- Whether the agent already owns a nearby slot.
- Building capacity.
- Tile walkability.
- Distance from current sprite position.
- Optional district preference.

The allocator returns a target tile and a soft reservation with an expiry. Reservations should be best-effort only: no agent should get stuck because a reservation cannot be made.

### Principle 4: Movement Has Explicit States

Add a small behavior layer above `AgentSprite._pickTarget()`:

```text
arriving -> entering
working intent -> traveling -> performing -> cooldown
chat intent -> approach partner -> chatting -> cooldown
ambient intent -> roaming -> lingering
alert intent -> lookout/patrol
departing -> gate departure
```

This can start as fields on `AgentSprite` or a helper class. The goal is not a full AI planner; it is a clear finite state model that can be debugged.

### Principle 5: Idle Motion Should Spread Life Across Districts

Idle agents should not simply revisit last-known buildings. They should:

- Prefer nearby district paths.
- Occasionally visit a provider home.
- Occasionally visit last-known work building, with decay.
- Pause at plazas, bridges, harbor edges, or scenic walkable tiles.
- Avoid buildings over crowd capacity.
- Avoid repeating the same building more than twice in a short window.

### Principle 6: Reduced Motion Remains Semantic

Follow `docs/motion-budget.md`:

- Check `motionScale` before allocating repeated motion resources.
- Keep logical state machines advancing under reduced motion.
- Ship static fallbacks for movement-related feedback.
- Avoid introducing competing medium/fast pulses.

## Proposed Modules

### `VisitIntentManager.js`

Owns derived intents for visible agents.

Responsibilities:

- Subscribe to `agent:added`, `agent:updated`, `agent:removed`.
- Optionally subscribe to `tool:invoked`, `chat:*`, `team:joined`, `subagent:*`.
- Derive and expire intents.
- Return highest-priority active intent for an agent.
- Preserve short sticky windows so agents do not reroute every poll.
- Provide a debug snapshot.

Layering requirement:

- `VisitIntentManager` must own token snapshots directly rather than depending on `LandmarkActivity` token deltas. `LandmarkActivity` currently observes tokens after sprite movement in the frame, which is too late to be the primary movement source.
- `VisitIntentManager` must derive Harbor intents directly from each `agent.gitEvents` item while the event is still associated with that agent/session. `HarborTraffic` normalized state is useful for ships, but it is not the right source for "which agent should walk to Harbor" unless it is extended to preserve agent/session identity.
- The first implementation should compute intents without changing movement. Routing should be enabled only after Phase 0 baseline data confirms snapshots are sane.

Initial source priorities:

| Source | Priority | TTL | Sticky | Notes |
| --- | ---: | ---: | ---: | --- |
| chat | 100 | while active | while active | Existing SendMessage movement remains highest. |
| alert | 90 | 45s | 10s | Failed push/high active count can send one or two agents to Lighthouse display, implemented as building `watchtower`. |
| git push/commit | 85 | 90s | 20s | Harbor should respond to real git events, not only shell strings. |
| tool fresh | 80 | 30s | 8s | Existing tool mapping, with refined building resolution. |
| token delta | 65 | 25s | 8s | Mine visits on real usage deltas. |
| subagent/team | 60 | 45s | 12s | Command gathering and parent/child proximity. |
| quota pressure | 50 | 60s | 10s | Mine visits when context/quota pressure is high. |
| ambient | 10 | 20s | 0s | Idle roaming only. |

### `VisitTileAllocator.js`

Owns crowd-aware target selection.

Inputs:

- Building object.
- Agent sprite.
- Candidate `visitTiles`.
- Current sprite positions.
- Existing reservations.
- Pathfinder walkability.

Outputs:

- `{ tileX, tileY, slotId, reservationId }`

Scoring sketch:

```text
score =
  reservationPenalty * 100
  + occupantDistancePenalty
  + repeatedSlotPenalty
  + overCapacityPenalty
  + pathDistance * 0.15
  - sameAgentSlotBonus
  - reasonPreferredSlotBonus
```

The allocator should also support non-building scenic tiles for ambient roaming.

Sprite plumbing requirement:

- `IsometricRenderer` constructs the allocator and passes it into each `AgentSprite` at construction time.
- `AgentSprite` receives optional callbacks such as `getIntentForAgent(agentId)`, `allocateVisitTile({ agent, building, intent })`, and `releaseVisitReservation(agentId)`.
- `AgentSprite._pickTarget()` asks the intent callback for the current intent before falling back to `agent.targetBuildingType` / `lastKnownBuildingType`.
- `AgentSprite._visitTileForBuilding()` delegates to the allocator when available and keeps the deterministic hash path as fallback.
- Reservations are released when an agent reroutes, begins chat, starts gate departure, is removed, or reaches an expired intent.
- If the allocator needs domain `Building` objects, pass `world.buildings` or a `getBuilding(type)` callback from `IsometricRenderer`; do not keep using only static `BUILDING_DEFS` once allocation is enabled.

### `AgentBehaviorState.js`

Small helper, not a new domain entity.

Tracks:

- `state`
- `intentId`
- `building`
- `reason`
- `targetTile`
- `arrivedAt`
- `cooldownUntil`
- `lastRerouteAt`
- `recentBuildings`

This can live inside `AgentSprite` at first, then split out if it grows.

### `ToolBuildingClassifier.js`

Optional extraction from `Agent.js`.

Reason to extract:

- Current tool classification does double duty for backend-ish domain and presentation behavior.
- We need richer reason labels than just building type.
- We need to split Archive vs Forge vs Task Board for shell discovery commands.

This can initially be static helpers on `Agent` to reduce churn, but the final shape should produce:

```js
{
  building: 'archive',
  reason: 'read-docs',
  confidence: 0.85,
  label: 'README.md'
}
```

## Tool Mapping Refinements

### Archive

Keep:

- `Read`, `Grep`, `Glob`, `LS` when input paths are docs, markdown, config discovery, package metadata, or explicit research reading.
- `rg`, `grep`, `find`, `sed`, `cat`, `nl`, `head`, `tail` when reading docs or planning material.
- Documentation edits should remain Archive only when they are docs-only work.

Reduce:

- Generic `rg/find/ls/cat/sed/nl/wc/jq` should not always route to Archive.

Split:

- Code search in `src/`, `server.js`, `adapters/`, `services/`, `widget/` should often route to Forge with `reason: inspect-code`.
- Test/build command output should route to Task Board with `reason: verify`.
- Git command output should route to Harbor.

### Forge

Keep:

- `Edit`, `MultiEdit`, `Write`, `apply_patch`, `functions.apply_patch`.
- Shell commands with patch/edit/write/create/update/delete/mv/cp/perl -pi.
- Image/code asset generation when it writes repo assets.

Add:

- Code inspection immediately preceding mutations can go to Forge if path-sensitive.
- Bulk mechanical rewrites can go to Forge with `reason: refactor`.
- Sprite/manifest changes can go to Forge or a future workshop subtype, but not Archive.

### Task Board

Keep:

- Task/Todo/update_plan/request_user_input.
- Tests, checks, lint, build, node --check, sprites validation.

Add:

- CI/debugging commands such as `gh run`, `gh workflow`, test logs can route to Task Board unless the command is explicitly release/deploy.
- Verification after Forge should create a Forge -> Task Board handoff intent.

### Command

Keep:

- SendMessage, TeamCreate, Task delegation, team/subagent joins.

Move from Portal:

- `functions.spawn_agent`, `functions.send_input`, `functions.wait_agent`, `functions.close_agent`, `functions.resume_agent` should probably route to Command, not Portal. They are orchestration, not browser/remote tooling.

Cross-plan alignment:

- `agents/plans/tool-rituals.md` currently treats some `functions.*agent` tools as Portal rituals. Before implementation, update that ritual plan or treat it as superseded for those tools so routing and building visuals agree. Portal should not continue to animate orchestration after the classifier moves those tools to Command.

### Portal

Keep:

- Playwright/browser/chrome/chromium/firefox.
- localhost/dev-server preview.
- claude-in-chrome or authenticated browser bridges if surfaced.

Remove:

- General subagent management unless a specific tool actually opens a remote/browser surface.

### Observatory

Keep:

- WebSearch, WebFetch, `web.run`, curl/wget/open https.

Decision:

- Rename/clarify the short label from `CLOCK` to `OBSERVATORY` and update description copy toward external research/skywatch. Do not add a separate clock/time workflow in this refinement unless a later atmosphere feature needs it.

### Harbor

Keep:

- git/GitHub/deploy commands.
- Parsed commit/push events.

Add:

- Real git events should create Harbor intents even if `lastTool` is not fresh.
- `git status/diff/log/show` can create short dock-side crate/ledger intents.
- `gh pr create`, releases, deploys should use Harbor with release-specific labels.

### Mine

Add:

- Token deltas should create Mine intents for the agent that produced the delta.
- High context ratio should create low-priority Mine visits.
- Quota pressure should attract one idle/waiting agent as a visible "resource check" rather than all agents.

### Lighthouse

Add:

- Failed push state creates one or two high-priority lookout intents, preferably for the agent involved in the push or nearest idle agent.
- High active working count creates low-priority watch duty.
- Long-running waiting sessions can trigger a watch patrol.

Implementation:

- Use `building: 'watchtower'` in all intent, allocator, ritual, and debug data. Use "Lighthouse" only in UI copy, docs prose, and labels.

## Building-Specific Refinements

### Command Center

Current value: high.

Changes:

- Move subagent-management tool routing from Portal to Command.
- Add team rendezvous behavior: a parent and new subagent briefly share nearby Command or parent-adjacent tiles before the subagent travels to its own work intent.
- Add Command capacity rules so team members form a loose arc instead of stacking.
- Keep chat partner movement highest priority.

Success criteria:

- Spawn/send/wait/close activity visibly belongs to Command.
- Team/subagent clusters are readable but not a pile.

### Task Board

Current value: high.

Changes:

- Treat verification commands as Task Board intents.
- Handoff from Forge to Task Board after edit/write/apply_patch if a validation command follows within 60 seconds.
- Keep persistent board papers bounded and readable.
- Add a "review lane" for PR/CI checks if GitHub commands are detected.

Success criteria:

- Edit -> test produces visible Forge -> Task Board flow.
- Waiting agents do not all default to Task Board; only those with plan/verification intent should.

### Code Forge

Current value: medium-low but worth keeping.

Changes:

- Make Forge the workbench for code and asset mutation, not a generic "file changed" glow.
- Route code-path inspection and edit-prep search to Forge.
- Add short "work package" state: active mutation, cooling, ready-for-validation.
- Handoff to Task Board on validation.
- Leave docs-only writing at Archive.

Success criteria:

- Forge is visited during code edits, not just by Codex idle home.
- Forge emits a clear "ready" handoff when validation starts.

### Token Mine

Current value: high as a data surface, weak as a visit target.

Changes:

- Token deltas create low/medium-priority Mine intents.
- Quota pressure changes Mine visual state.
- Avoid attracting every agent to Mine. Use a quota sentinel: at most one idle/waiting agent does resource-check behavior per window.

Success criteria:

- Token-heavy work sends at least the responsible agent or one sentinel to Mine.
- Mine does not become the next Archive.

### Archive

Current value: medium and overloaded.

Changes:

- Expand visit tiles along the path and nearby reading alcoves.
- Split general code discovery commands away from Archive when paths imply code-work.
- Lower idle revisit probability.
- Add "reading alcove" ambient points beyond building front.
- Add capacity threshold: above 3 visitors, new Archive ambient intents should choose nearby scenic/reading tiles rather than front-door tiles.

Success criteria:

- Active doc/research reading still goes to Archive.
- Generic code search no longer causes a persistent Archive crowd.
- Idle agents around Archive are visually distributed.

### Observatory

Current value: medium, copy mismatch.

Changes:

- Rename/clarify short label from `CLOCK` to `OBSERVATORY` and update the description toward external research/skywatch.
- External web research stays here.
- If time/weather/sky systems are active, Observatory can be the source of time-of-day/forecast cues.
- Gemini provider home can remain Observatory, but use a lower probability to avoid provider clustering.

Success criteria:

- The building's label matches its actual semantics.
- WebFetch/WebSearch feels distinct from local Archive reading.

### Portal

Current value: medium, mixed semantics.

Changes:

- Narrow to browser/dev-server/remote surface.
- Move subagent orchestration to Command.
- Dev server start + browser navigation should create a two-step Portal flow.
- Portal can show "preview open" or "browser active" state, but not generic tool delegation.

Success criteria:

- Portal visits mean "external interactive surface" to the user.
- Command owns human/agent coordination.

### Harbor

Current value: very high.

Changes:

- Use git events to create Harbor visit intents directly.
- Connect commit/push ship lifecycle to agent positioning when possible.
- Add short dock-side behavior for `git status/diff/log/show`.
- Failed push should also trigger Lighthouse alert using internal building type `watchtower`.

Success criteria:

- Harbor remains the richest landmark.
- Agents involved in commits/pushes physically visit or leave from Harbor more often.

### Lighthouse (`watchtower`)

Current value: medium-low as a passive beacon.

Changes:

- Add watch-duty intents for failed pushes, high active count, long waits.
- Beam state should reflect failed push/high activity.
- Use at most one or two agents; Lighthouse should not become a crowd magnet.
- Keep ambient visits rare but meaningful.
- Use `watchtower` in code and debug data; render/display "Lighthouse" in UI copy.

Success criteria:

- Lighthouse has visible purpose during global alerts.
- Agents do not routinely visit it without a reason.

## Movement And Crowd Refinements

### M1. Expand Visit Geometry

Update `BUILDING_DEFS.visitTiles` and possibly nearby scenic tiles:

- Archive: add tiles along archive walk and side alcoves.
- Command: add wider plaza arc.
- Task Board: add board-facing queue and side review tiles.
- Forge: add workbench tiles and a handoff path toward Task Board.
- Mine: add mine-mouth and cart path tiles.
- Portal: add entry, side-observer, and "return" tiles.
- Observatory: add telescope viewing tiles.
- Harbor: add dock queue, ship loading, and ledger tiles.
- Lighthouse (`watchtower`): add lookout and shoreline watch tiles.

Do not just add more tiles blindly. Add them where road/scenery and line-of-sight support the building's role.

Capacity and overflow acceptance criteria:

| Building type | Work capacity | Ambient capacity | Overflow expectation |
| --- | ---: | ---: | --- |
| `archive` | 3 | 2 | 6+ reading alcove/path tiles so six Archive-bound agents do not stack at the front door. |
| `command` | 4 | 3 | Plaza arc for team/subagent rendezvous; parent/child groups should form a loose semicircle. |
| `taskboard` | 3 | 2 | Queue/review tiles facing the board plus side tiles for waiting agents. |
| `forge` | 3 | 2 | Workbench tiles and a handoff-facing tile toward Task Board. |
| `mine` | 2 | 2 | Mine-mouth and cart-path tiles; quota sentinel should not crowd active token producer. |
| `observatory` | 2 | 2 | Telescope/viewing spots with sightline to dome; Gemini home does not exceed ambient capacity. |
| `portal` | 3 | 2 | Entry/return/observer tiles around gate, not inside the portal art. |
| `harbor` | 4 | 3 | Dock ledger, crate-loading, and ship-edge tiles so git status/diff/push can coexist. |
| `watchtower` | 1 | 1 | Lookout and shoreline fallback only; do not make Lighthouse a crowd destination. |

### M2. Soft Reservations

When an agent receives an intent, reserve a visit tile for 10-20 seconds or until arrival/cancellation.

Rules:

- Reservations are soft.
- Expire stale reservations.
- Reuse the same reservation for the same agent if target remains valid.
- If all slots are busy, choose an overflow/scenic tile.
- If pathfinder cannot reach the reserved tile, release it and fallback to nearest reachable tile.

### M3. Stationary Separation

Current separation only handles moving sprites. Add a low-frequency stationary de-overlap pass:

- Run every 250-500 ms, not every frame.
- Only apply to sprites at or near the same building visit area.
- Prefer assigning a new nearby visit/overflow tile over physically pushing a stopped sprite.
- Do not move selected/followed agents abruptly.
- Do not move agents currently chatting.

### M4. Idle Roaming Decay

Replace "30% revisit last-known building forever" with decayed memory:

```text
last-known weight:
  0-30s after activity: 35%
  30-90s: 15%
  90s+: 5%
```

Also prevent same-building loops:

- Track last 3 ambient buildings.
- Penalize a building visited twice recently.
- Prefer district-nearby destinations to long cross-map idle walks.

### M5. Scenic Ambient Points

Add non-building ambient destinations:

- bridges
- harbor railings
- plaza corners
- forest edge
- mine cart path
- portal ruins edge
- lighthouse shore
- observatory viewing spots

These should be managed by `VisitTileAllocator` or a sibling `AmbientPointAllocator`.

### M6. Path Variety

Pathfinder currently returns a shortest/straight path. Add optional path variety:

- Slightly prefer roads/bridges for long paths.
- Add deterministic waypoint jitter at intersections.
- Avoid sending all agents through the same choke when equivalent routes exist.

Keep this after occupancy; occupancy fixes are higher impact.

### M7. Arrival Performance Window

When an agent arrives at a work-intent building:

- Set behavior state to `performing`.
- Hold for intent-specific duration.
- Let rituals/labels happen during performance.
- Then enter cooldown or next intent.

This makes the visit flow readable: arrive, do thing, leave.

## Debug And Instrumentation

Add a behavior debug overlay toggle, likely in existing `DebugOverlay.js`:

- agent id/name
- status
- current behavior state
- active intent id/source/reason
- target building
- target tile
- reservation id
- remaining TTL
- recent buildings
- crowd score
- reroute reason

Add optional console helpers:

```js
window.__visitIntents()
window.__visitReservations()
window.__agentBehavior(agentId)
window.__buildingCrowds()
```

This is essential for tuning without guessing from screenshots.

Placement:

- World-space debug labels may be used for target tiles, reservations, and per-agent destination arrows.
- Dense textual summaries such as intent TTL, crowd tables, and source counts should render in a screen-space panel after the canvas transform is reset. Do not put multi-line diagnostic text into the isometric world where it will overlap buildings and agents.
- Production hover/click behavior should remain lightweight. Detailed building visitor reasons should be debug-only unless a separate accessible DOM panel is designed.

## Implementation Phases

### Phase 0: Baseline Audit And Debug Hooks

Goal: make current behavior measurable before changing it.

Work:

1. Add debug snapshot methods without changing behavior.
2. Count visitors per building and expose current target building per sprite.
3. Add a temporary crowd summary to debug overlay.
4. Capture baseline screenshots with the user's typical agent load.

Validation:

- `node --check` on changed JS files.
- `npm run dev`, open World mode, verify no console errors.
- Confirm debug helpers return sane data.
- Reduced motion: debug helpers may report logical route/intent state, but Phase 0 must not add path walkers, particles, or repeated animation resources.

### Phase 1: Visit Intent Manager

Goal: derive explicit intent from existing data while preserving current behavior as fallback.

Work:

1. Add `VisitIntentManager.js`.
2. Add or extract a classifier that returns `{ building, reason, confidence, label }` while preserving current `agent.targetBuildingType` behavior as fallback.
3. Move the first Archive de-clustering classifier split into this phase: code-path inspection can classify as Forge, docs reading remains Archive, validation commands remain Task Board.
4. Move subagent function tools from Portal to Command in the classifier, but keep the current movement fallback until routing is explicitly enabled.
5. Derive tool intents from the classifier.
6. Derive token intents from a token snapshot/delta observer inside `VisitIntentManager`, not from `LandmarkActivity`.
7. Derive git intents directly from each `agent.gitEvents` item while agent/session identity is still available.
8. Derive team/subagent intents from relationship events.
9. Add priority/TTL/sticky handling.
10. Add an inert `getIntentForAgent(agentId)` callback on `IsometricRenderer` and pass it into `AgentSprite`, but keep movement disabled behind a feature flag or no-op gate in this phase.
11. Keep `AgentSprite._targetBuildingTypeForState()` fallback intact.

Validation:

- Debug overlay shows the same building targets as before for fresh tools.
- Classifier examples from Phase 4 validation already pass in inert mode.
- No visible movement regression.
- Intent expiry works when agent becomes idle.
- Reduced motion: intent timers and snapshots may advance, but no new movement resources are allocated.

### Phase 2: Crowd-Aware Target Allocation

Goal: stop obvious stacking.

Work:

1. Add `VisitTileAllocator.js`.
2. Wire `AgentSprite._visitTileForBuilding()` through allocator when available, using the explicit callbacks listed under `VisitTileAllocator.js`.
3. Add reservation TTLs.
4. Add overflow tiles per building.
5. Keep deterministic fallback when allocator unavailable.
6. Expand Archive visit tiles.
7. Enable intent-driven movement only after allocator reservations are visible in debug snapshots.

Validation:

- With 6+ Archive-bound agents, agents distribute across available/overflow tiles.
- Demand is reduced as well as spread: code-path `rg/find/read` examples classify away from Archive when appropriate.
- Selected agent does not snap unexpectedly.
- No pathfinder deadlocks.
- Reduced motion: existing static destinations may update, but do not allocate additional path walkers or repeated de-overlap timers beyond the existing logical movement model.

### Phase 3: Idle Roaming And Ambient Life

Goal: make idle agents feel alive without fabricating work.

Work:

1. Add idle memory decay.
2. Track recent ambient destinations.
3. Add scenic ambient points.
4. Bias idle walking to nearby districts.
5. Lower provider-home clustering.
6. Add rare lookout/resource-check ambient intents.

Validation:

- Idle agents spread across map within 2-3 minutes.
- Archive and Command no longer accumulate idle stacks.
- Reduced motion still shows static states without continuous motion allocation.

### Phase 4: Tool Mapping Refinement

Goal: complete classifier parity after the first high-impact splits from Phase 1.

Work:

1. Expand classifier coverage for less-common tools and providers.
2. Narrow Portal to browser/dev-server/remote surface.
3. Add release/CI/GitHub nuance: `gh pr create` / releases / deploys go Harbor, CI check triage can go Task Board.
4. Align `agents/plans/tool-rituals.md` with final classifier decisions before implementing visuals.
5. Update Observatory label/copy to research observatory semantics.

Validation:

- Common command examples classify as expected:
  - `rg foo claudeville/src` -> Forge / inspect-code.
  - `rg foo docs README.md` -> Archive / read-docs.
  - `node --check claudeville/server.js` -> Task Board / verify.
  - `npm run dev` -> Portal / preview.
  - `functions.spawn_agent` -> Command / delegate.
  - `git push` -> Harbor / push.
  - token delta -> Mine / token-delta.
- Dashboard/activity copy still looks right.
- Reduced motion: classifier-only changes have no motion allocation.

### Phase 5: Building Workflow Loops

Goal: make visits tell a story.

Work:

1. Forge active mutation -> ready-for-validation -> Task Board handoff.
2. Harbor status/diff -> crate/ledger -> commit/push ship.
3. Command subagent dispatch -> child travels to assigned work building.
4. Token delta/quota pressure -> Mine resource check.
5. Failed push -> Lighthouse alert watch using internal building type `watchtower`.
6. WebFetch/WebSearch -> Observatory research performance.
7. Browser/dev-server -> Portal preview performance.

Validation:

- Trigger each flow manually and confirm agent movement matches the building feedback.
- Check that multiple simultaneous flows do not overload the same building.
- Reduced motion: workflow state should remain inspectable and static endpoint changes may occur, but new ritual/path motion follows `docs/motion-budget.md`.
- Pulse-band requirement: any building-side visual cue added here must declare `slow`, `medium`, `fast`, or `static` and use the shared pulse priority policy. Coordinate with `agents/plans/tool-rituals.md`.

### Phase 6: Stationary De-Overlap

Goal: fix residual piles after arrival.

Work:

1. Add low-frequency stationary crowd resolver.
2. Reassign overflow tiles instead of pushing sprites where possible.
3. Protect selected, chatting, arriving, and departing agents.
4. Add crowd pressure to debug overlay.

Validation:

- Agents that arrive on same tile spread within a short interval.
- No jitter loops.
- No selected-agent surprise movement.
- Reduced motion: stationary de-overlap should prefer immediate logical reassignment to a static reachable tile and must not create continuous nudging animation.

### Phase 7: Visual Alignment And Copy Cleanup

Goal: align labels, descriptions, and visual effects with behavior.

Work:

1. Rename Observatory short label to `OBSERVATORY` or another research-focused short label.
2. Update building descriptions in `BUILDING_DEFS`.
3. Ensure labels remain English.
4. Coordinate with `tool-rituals.md` for building-side visual responses.
5. Avoid adding decorative-only motion that competes with behavior cues.

Validation:

- Labels/descriptions match route behavior.
- No text overlap in World mode labels.
- Browser resize still keeps labels readable.
- Accessibility: debug/hover copy must not rely on color alone, must remain readable after resize, and must not add keyboard traps or inaccessible focus-only behavior.

## Additional Impactful Changes

### A1. Per-Building Capacity

Add optional config:

```js
capacity: {
  work: 3,
  ambient: 2,
  overflow: 4
}
```

This lets Archive and Command behave differently from Harbor or Lighthouse (`watchtower`).

### A2. District Affinity

Use existing `district` fields to avoid random cross-map walking:

- civic: Command, Task Board
- workshop: Forge
- resource: Mine
- knowledge: Archive, Observatory
- arcane: Portal
- harbor: Harbor, Lighthouse (`watchtower`)

Agents can have a short-term district affinity based on current project/provider/work type.

### A3. Agent Personal Habits

Use stable hash by agent id to add small personality:

- Some idle agents prefer water edges.
- Some prefer civic plazas.
- Some prefer knowledge district.
- Some patrol between Forge and Task Board.

This creates variety without random chaos.

### A4. Long-Running Session Behavior

If an agent has been waiting or working for a long time:

- Waiting > 2 minutes: wander from work building to nearby rest/scenic tile.
- Working > 5 minutes: remain near current building but periodically shift to another slot.
- Idle > 5 minutes: enter broader roam mode.

### A5. Parent-Child Spatial Coherence

Subagents should:

- Emerge near parent or Command.
- Briefly follow/cluster with parent.
- Then route to their own work building.
- On completion, optionally return/merge near parent if parent is visible.

Some of this exists in arrival/departure visuals, but movement intent can make it more coherent.

### A6. Failure And Error States

Use building visits for negative states:

- Failed push: Harbor + Lighthouse (`watchtower`).
- Failed build/test: Task Board.
- Tool error in browser: Portal.
- Context/quota pressure: Mine.
- Missing file/search miss: Archive or Forge depending on path.

This gives the village a visible "something needs attention" language.

### A7. Click/Hover Inspection

Building hover could show lightweight current visitor counts and active reasons in the canvas title or a debug-only tooltip:

- `Archive: 3 reading, 1 searching`
- `Forge: 2 editing, 1 ready for check`
- `Harbor: 1 push pending`

Keep production UI subtle; make detailed diagnostics debug-only.

### A8. Behavior Metrics For Tuning

Track in memory:

- visits per building
- average dwell time
- rejected reservations
- reroutes
- crowd pressure
- intent source counts

Expose through `window.__agentBehaviorStats()`.

### A9. Simulation Fixture

Add a small browser-only dev fixture that can inject fake agents/intents without touching provider adapters. This would make movement tuning much faster.

Constraints:

- Only behind debug query param.
- No server writes.
- Does not affect normal `/api/sessions`.

## Suggested File Ownership

Likely implementation files:

- `claudeville/src/presentation/character-mode/VisitIntentManager.js`
- `claudeville/src/presentation/character-mode/VisitTileAllocator.js`
- `claudeville/src/presentation/character-mode/AgentBehaviorState.js`
- `claudeville/src/presentation/character-mode/AgentSprite.js`
- `claudeville/src/presentation/character-mode/IsometricRenderer.js`
- `claudeville/src/presentation/character-mode/BuildingSprite.js`
- `claudeville/src/presentation/character-mode/DebugOverlay.js`
- `claudeville/src/config/buildings.js`
- `claudeville/src/config/townPlan.js`
- `claudeville/src/domain/entities/Agent.js` or a new classifier helper if extracted

Avoid touching adapters unless a later phase needs higher-fidelity tool-call IDs.

## Validation Matrix

### Static Checks

Run `node --check` on every changed `.js` file, not only the new modules. The list below is illustrative for this plan's likely files:

```bash
node --check claudeville/src/presentation/character-mode/VisitIntentManager.js
node --check claudeville/src/presentation/character-mode/VisitTileAllocator.js
node --check claudeville/src/presentation/character-mode/AgentBehaviorState.js
node --check claudeville/src/presentation/character-mode/AgentSprite.js
node --check claudeville/src/presentation/character-mode/IsometricRenderer.js
node --check claudeville/src/presentation/character-mode/BuildingSprite.js
node --check claudeville/src/presentation/character-mode/DebugOverlay.js
node --check claudeville/src/domain/entities/Agent.js
node --check claudeville/src/config/buildings.js
node --check claudeville/src/config/townPlan.js
```

If multiple files under `claudeville/src/presentation/character-mode/` changed, use an equivalent `find ... -name '*.js' -print0 | xargs -0 -n1 node --check` command scoped to changed files.

### Runtime Smoke

```bash
npm run dev
curl http://localhost:4000/api/providers
curl http://localhost:4000/api/sessions
```

Port hygiene:

- Use an already-running `http://localhost:4000` server when present.
- If `npm run dev` cannot bind because the port is occupied, do not kill the listener. Ask the operator or reuse the existing server.
- Do not run port-killing pipelines, `kill`, `pkill`, or `killall` without explicit approval.

Then open `http://localhost:4000` and verify:

- World mode loads.
- Dashboard mode still works.
- Agent select/deselect still works.
- Camera follow still works.
- Agents continue moving after WebSocket updates.
- Browser resize still leaves World mode canvas, labels, minimap, and activity panel coherent.
- Switch World -> Dashboard -> World and confirm subscriptions do not duplicate or leak visibly.
- Console has no errors.

### Manual Behavior Scenarios

Use active sessions or debug fixture:

1. Six Archive-bound agents distribute across Archive and reading alcoves.
2. Code edit routes to Forge.
3. Validation command routes to Task Board.
4. Edit followed by validation produces Forge -> Task Board handoff.
5. `functions.spawn_agent` routes to Command, not Portal.
6. Playwright/browser activity routes to Portal.
7. WebFetch routes to Observatory.
8. Git push routes to Harbor and can trigger Lighthouse (`watchtower`) on failure.
9. Token delta creates Mine intent.
10. Idle agents spread across scenic/ambient points after 2-3 minutes.
11. Selected agent is not unexpectedly reassigned by stationary de-overlap.
12. Reduced motion keeps semantic states without repeated motion.
13. `watchtower` debug/intents display as Lighthouse in UI copy but use `watchtower` internally.
14. Observatory shows research/observatory semantics, not stale `CLOCK` semantics.

### Visual Checks

When visual behavior changes:

```bash
npm run sprites:validate
npm run sprites:capture-fresh
npm run sprites:visual-diff
```

Use Playwright screenshots at:

- desktop default viewport
- dense-agent scenario
- reduced-motion scenario

### Performance Checks

Watch for:

- No unbounded reservations map growth.
- No per-frame allocation from intent/routing logic.
- Stationary de-overlap runs on an interval, not every frame.
- Path recomputation is debounced and reused where possible.
- Debug helpers do not run expensive scans unless called.

Dense-agent scenario:

- Run or simulate 10-15 agents for at least 10 minutes.
- Snapshot `window.__visitIntents()`, `window.__visitReservations()`, `window.__buildingCrowds()`, and `window.__agentBehaviorStats()` at start, 5 minutes, and 10 minutes.
- Reservation and intent counts should remain bounded by active agents plus short-lived recent events.
- A building over capacity should show overflow use rather than indefinite stacking.

### Accessibility And Motion Checks

- Test with `prefers-reduced-motion: reduce`.
- Confirm no new particles, path walkers, repeated pulses, or continuous de-overlap loops are allocated solely for decorative motion.
- Confirm logical intent/reservation state still advances under reduced motion.
- Any visual cue added by a phase must declare a pulse band (`slow`, `medium`, `fast`, `static`) and respect `getPulsePriority()` where applicable.
- Debug/hover text must not rely on color alone.
- Screen-space debug panels must remain readable after resize and must not block core canvas interaction unless explicitly toggled.

## Rollout Strategy

Recommended order:

1. Debug hooks and baseline measurements.
2. Visit intents and first classifier split with no movement change.
3. Visit tile allocator with Archive expansion and classifier-enabled demand reduction.
4. Idle roaming decay and scenic points.
5. Complete tool mapping refinements and cross-plan ritual alignment.
6. Building workflow loops.
7. Stationary de-overlap.
8. Copy/label cleanup and ritual coordination.

This order reduces risk because each step is observable before the next one adds complexity.

## Success Metrics

Qualitative:

- A user can infer what an agent is doing from where it goes.
- Archive is busy during real reading/search, not permanently crowded.
- Forge feels like code work, not idle decoration.
- Portal means browser/preview, Command means coordination.
- Lighthouse has a visible alert/watch purpose implemented through `watchtower`.
- Idle agents make the village feel active without implying false work.

Quantitative/debug:

- No building has more than its configured work capacity unless overflow is active.
- In a 10-agent dense scenario, no more than 3 agents occupy the same visit cluster for more than 10 seconds.
- Idle agents visit at least 5 distinct destination classes over 3 minutes.
- Tool-intent classification explains at least 90% of fresh tool updates with a non-null building and reason.
- No memory growth in reservations/intents after 10 minutes of polling.

## Open Questions

1. Which exact Observatory short label should ship: `OBSERVATORY`, `RESEARCH`, or another concise English label?
2. Should docs edits remain Archive, or should all file mutations go through Forge with a docs-specific subtype?
3. Should `functions.spawn_agent` move to Command immediately in code, or first land as classifier-only debug output for one iteration?
4. Should token deltas move the responsible agent to Mine, or only create a Mine sentinel visit to avoid disrupting active work?
5. Should failed validation create a Task Board alert equivalent to failed push -> Lighthouse (`watchtower`)?
6. Should behavior debug helpers be always available or gated behind a query parameter?

## Recommended First Implementation Slice

The highest-impact low-risk first slice is measurement plus inert semantics only:

1. Add debug helpers and a screen-space debug panel/snapshot for current targets, crowds, and visitor counts.
2. Add `VisitIntentManager` in presentation code in inert mode.
3. Add the first classifier split in inert mode: code-path search -> Forge, docs reading -> Archive, validation -> Task Board, agent orchestration -> Command.
4. Pass `getIntentForAgent` into `AgentSprite` but leave movement using current fallback behavior.
5. Validate snapshots against a dense real-world session before enabling routing.

The second slice should enable behavior:

1. Add `VisitTileAllocator`.
2. Expand Archive visit/overflow tiles.
3. Enable allocated targets for Archive/Forge/Task Board only.
4. Verify the screenshot-class Archive pile is both reduced in demand and distributed in geometry.

This addresses the screenshot's Archive concentration without skipping the measurement gate.
