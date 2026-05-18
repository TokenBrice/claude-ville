# ClaudeVille World Enhancement Swarm Plan

Date: 2026-05-18
Status: ready
Baseline HEAD: `61f10ef0c447e43a1199439fd7d78cdda7fa5b31`
Initial `git status --short`: clean
Final expected `git status --short`: this plan plus `agents/README.md`

## Scope

Owned paths for this planning artifact:

- `agents/plans/claudeville-world-enhancement-swarm-2026-05-18.md`
- `agents/README.md`

Read-only source paths inspected by the swarm:

- `claudeville/src/presentation/character-mode/`
- `claudeville/src/presentation/shared/`
- `claudeville/src/domain/`
- `claudeville/src/application/`
- `claudeville/src/config/`
- `claudeville/assets/sprites/manifest.yaml`
- `docs/motion-budget.md`
- `docs/visual-experience-crafting.md`
- `docs/design-decisions.md`
- `docs/swarm-orchestration-procedure.md`

## Goal

Evaluate broad enhancements for ClaudeVille World mode, then produce a prioritized implementation plan covering agent behavior and movement, visual enhancement, harbor and ship logic, building visual and logic improvements, and world map rendering.

## Non-Goals

- Do not implement code changes in this planning pass.
- Do not add mobile or narrow-viewport work. ClaudeVille is desktop-only.
- Do not add build tooling, bundlers, transpilers, app test runners, or runtime dependencies.
- Do not propose always-on decorative motion unless it communicates semantic state and has a reduced-motion fallback.
- Do not replace the Canvas 2D world with 3D, a framework rewrite, or a new state-management stack.

## Swarm Process

The request explicitly called for a swarm of 6 high/xhigh subagents. The local SOP allows up to 5 active agents at once, so the work ran in two waves: five specialist read-only agents first, then one cross-domain xhigh council agent. Each agent returned findings, at least 25 to 30 ideas, and vote allocations.

Council ballots:

| Council role | Vote points |
| --- | ---: |
| Agent behavior and movement | 30 |
| Visual quality, atmosphere, assets, readability | 30 |
| Harbor and ship logic | 30 |
| Buildings visual and logic | 30 |
| World map rendering, terrain, camera, performance | 30 |
| Cross-domain prioritization | 60 |
| Total | 210 |

The final prioritization combines direct votes, duplicate/overlapping idea clusters, dependency order, user-visible impact, implementation effort, and regression risk.

## Core Findings

High-confidence findings:

- ClaudeVille already has rich visual systems. The main next improvement is stronger coordination between `ToolIdentity`, `VisitIntentManager`, `VisitTileAllocator`, `AgentSprite`, `HarborTraffic`, `BuildingSprite`, and `WorldFrameRenderer`.
- Harbor has a concrete semantic gap: backend git extraction recognizes `commit`, `push`, `pull`, and `fetch`, but shared frontend normalization currently admits only `push` and `commit`, which likely prevents existing inbound ship logic from receiving pull/fetch events.
- Building config is data-rich, but `BuildingSprite` still owns many type-specific visual constants and branches. This makes consistency and future building changes more expensive than they need to be.
- Agent movement is believable enough for small populations, but roads are mostly visual or waypoint hints. Pathfinding does not yet prefer authored roads, and blocked recovery is still reactive.
- Rendering has a good depth drawable contract, but `WorldFrameRenderer` still mixes named systems with several manual pre/post passes. Draw-order changes need instrumentation before broad refactors.
- Motion is already constrained by `docs/motion-budget.md`, but pulse math is fragmented. New effects should first share pulse bands and reduced-motion behavior.

## Prioritization Rubric

Each idea was scored using this rubric:

| Factor | Weight | Meaning |
| --- | ---: | --- |
| User-visible clarity | 35% | Helps the user understand what agents, ships, buildings, or the map are doing. |
| Cross-domain coherence | 25% | Strengthens shared contracts rather than adding one-off special cases. |
| Effort | 15% | Lower effort ranks higher when impact is comparable. |
| Risk | 15% | Lower risk ranks higher, especially around motion, draw order, and stateful harbor logic. |
| Dependency leverage | 10% | Unlocks or validates multiple later improvements. |

## Deliberation Outcome

The council repeatedly converged on this implementation strategy:

1. Add validation, debug, and semantic contracts before broad polish.
2. Fix the known harbor semantic gap early because it is concrete, low-effort, and user-visible.
3. Improve movement through intent explanations, blocked recovery, facing, dwell, and weighted pathing before ambitious crowd steering.
4. Make buildings and visual cues data-driven enough that later effects do not add more hard-coded branches.
5. Improve render correctness and performance instrumentation before moving large layers around.
6. Treat asset generation and large visual refreshes as later work, after the usage contracts and QA scenes exist.

## Consolidated Vote Themes

| Theme | Approx. council support | Why it ranked high |
| --- | ---: | --- |
| Semantic contracts and visual grammar | 25+ | Reduces cue overload and makes future effects consistent. |
| Fixtures, validators, and debug instrumentation | 25+ | De-risks movement, harbor, buildings, and render changes. |
| Harbor pull/fetch and push semantics | 20+ | Concrete correctness gap with strong user-visible payoff. |
| Building capacity and visual registry | 20+ | Turns static landmarks into readable workflow places. |
| Movement modelling and road-preferred routing | 20+ | Makes agent motion explain work instead of wandering. |
| Label density and collision management | 10+ | Current visuals are rich but can crowd under load. |
| Shared pulse and reduced-motion policy | 10+ | Necessary before more semantic animations. |
| Render depth, culling, and timing tools | 15+ | Protects map quality and performance as richness grows. |

## Prioritized Backlog

| Rank | Initiative | Impact | Effort | Risk | Vote support | Primary modules |
| ---: | --- | --- | --- | --- | ---: | --- |
| 1 | Build validation and scenario foundation | H | M | L | 25+ | `__simfixture__/`, `DebugOverlay`, dev scripts |
| 2 | Fix harbor pull/fetch normalization and inbound ships | H | S | L | 11 | `GitEventIdentity`, `HarborTraffic`, `VisitIntentManager` |
| 3 | Define semantic event/building/visual grammar contracts | H | M | M | 25+ | `ToolIdentity`, `VisitIntentManager`, `BuildingSprite`, `AgentSprite` |
| 4 | Add building schema and asset manifest QA | H | M | L | 8+ | `buildings.js`, `manifest.yaml`, sprite scripts |
| 5 | Unify capacity source of truth and show occupancy states | H | M | M | 11+ | `VisitTileAllocator`, `BuildingSprite`, `buildings.js` |
| 6 | Add selected-agent reason and route explanation | H | S | L | 5+ | `AgentSprite`, `VisitIntentManager`, shared UI |
| 7 | Add blocked recovery and alternate slot escalation | H | M | L | 4 | `AgentSprite`, `VisitTileAllocator`, `Pathfinder` |
| 8 | Add working phase substates from tool classification | H | M | M | 4 | `ToolIdentity`, `VisitIntentManager`, `AgentSprite` |
| 9 | Add weighted road-preferred pathfinding | H | H | M | 9 | `Pathfinder`, `SceneryEngine`, `AgentSprite` |
| 10 | Add shared pulse clock and reduced-motion QA matrix | H | M | L | 8+ | `PulsePolicy`, `AgentSprite`, `BuildingSprite`, docs |
| 11 | Add label density, collision, and fade improvements | H | M | M | 10+ | `AgentSprite`, `BuildingSprite`, `WorldFrameRenderer` |
| 12 | Add harbor observed/inferred/refspec semantics | H | H | M | 10 | `gitEvents`, `GitEventIdentity`, `HarborTraffic` |
| 13 | Add harbor reducer fixtures and debug snapshots | H | M | L | 5 | `HarborTraffic`, dev fixtures, `DebugOverlay` |
| 14 | Add render layer inspector and frame timing overlay | H | M | L | 7 | `WorldFrameRenderer`, `DrawablePass`, `DebugOverlay` |
| 15 | Add depth tie-breakers and conservative drawable culling | H | M | M | 9 | `DrawablePass`, drawable producers |
| 16 | Add building visual registry and manifest-backed hooks | H | H | M | 11+ | `BuildingSprite`, `manifest.yaml`, `buildings.js` |
| 17 | Add visit tile metadata, queue groups, facing normalization | H | M | M | 7 | `buildings.js`, `VisitTileAllocator`, `AgentSprite` |
| 18 | Add multi-tool secondary ghost intents | H | M | M | 4 | `ToolIdentity`, `VisitIntentManager`, `AgentSprite` |
| 19 | Add minimap semantic indicators for active buildings/harbor | M | M | L | 4+ | `Minimap`, building/harbor state |
| 20 | Add flow-vector water and harbor/sea visual hierarchy | M | M | M | 6 | `SceneryEngine`, `IsometricRenderer`, `WeatherRenderer` |
| 21 | Add agent persona/social gravity and sibling clustering | M | M | M | 6 | `Agent`, `RelationshipState`, `VisitIntentManager` |
| 22 | Add harbor dock capacity, repo lanes, and wake prioritization | H | M | M | 10 | `HarborTraffic`, `scenery.js`, `BuildingSprite` |
| 23 | Add particle spawn options and semantic effect registry | H | M/H | M | 8+ | `ParticleSystem`, `RitualConductor`, `LandmarkActivity` |
| 24 | Add terrain metadata and invariant validation | H | M | M | 5 | `SceneryEngine`, `IsometricRenderer`, dev scripts |
| 25 | Add smart camera follow and semantic bookmarks | M | M | L | 4 | `Camera`, minimap/canvas controls |
| 26 | Add district activity washes and landmark occupancy visuals | H | M | M | 8+ | `BuildingSprite`, `SceneryEngine`, `theme` |
| 27 | Add agent clustering under load | H | H | H | 2 | `WorldFrameRenderer`, `AgentSprite`, `Minimap` |
| 28 | Add route graph, lane discipline, and local avoidance | H | H | M/H | 6 | `Pathfinder`, `HarborTraffic`, `AgentSprite` |
| 29 | Add contact-sheet review artifacts and model silhouette audit | H | M | L | 5 | sprite scripts, `ModelVisualIdentity`, `agents/research` |
| 30 | Defer large asset refresh and release convoy mode until foundations land | H | H | M | 3 | assets, `HarborTraffic`, visual registries |

## Implementation Plan

### Phase 0 - Baseline And Guardrails

Outcome: make later behavior, rendering, and visual work testable before changing semantics.

Tasks:

- Add scenario fixtures for selected World states: no agents, one working agent, 20+ agents, parent/subagents, team gather, mixed tools, git commit/push/fetch/pull, failed push, selected agent behind building, storm/night/reduced-motion.
- Extend `__simfixture__/AgentSimulator.js` or a neighboring fixture helper so future agents can replay deterministic tool/status/git sequences without provider CLIs.
- Add a docs checklist for visual QA scenes: clear day, night, fog, storm, reduced motion, selected route, harbor pending, dense labels, dashboard toggle.
- Add debug overlay counters for visit intents, reservations, path blocked reason, harbor reducer state, drawable counts, culled counts, light cache pressure, and frame timings.
- Add `node --check` validation for touched browser modules and docs-only diff review for artifacts.

Acceptance:

- A future implementation worker can load deterministic states and verify changes without depending on live provider sessions.
- Debug overlay can answer: what is drawn, why an agent moved, why a ship exists, what building is active, and whether frame/canvas budgets are under pressure.

Validation:

- `node --check` on changed JS files.
- Browser smoke at `http://localhost:4000`: World, Dashboard, select/deselect agent, reduced-motion toggle if forced through browser/devtools.
- Docs diff review.

### Phase 1 - Fast Semantic Repairs

Outcome: fix concrete correctness and readability issues with limited code churn.

Tasks:

- Extend `gitEventKind()` and `normalizeGitEvent()` to preserve `pull` and `fetch` events, including remote, branch, target ref, confidence/source, inferred flag, and timestamp.
- Verify `HarborTraffic` inbound ship paths activate for pull/fetch events and do not regress commit/push handling.
- Add a small harbor reducer scenario fixture for commit, push success, push failed, rejected, cancelled, force push, fetch, and pull.
- Add consistent failed/rejected/cancelled status language across harbor summaries, watchtower alert state, and agent/tool labels.
- Add selected-agent "why here" text from active intent source/reason/building and current reservation, surfaced in existing labels or detail panel without cluttering the canvas.
- Add journey breadcrumbs in debug first, then in UI only where they improve readability.

Acceptance:

- Pull/fetch events render as inbound harbor activity when present.
- Push statuses are distinguishable and consistent.
- Selecting an agent explains its current destination or behavior state.

Validation:

- `node --check claudeville/src/presentation/shared/GitEventIdentity.js claudeville/src/presentation/character-mode/HarborTraffic.js claudeville/src/presentation/character-mode/VisitIntentManager.js`
- Browser smoke with simulated git events.

### Phase 2 - Behavior And Movement Model

Outcome: agents move in ways that explain work, relationships, and constraints.

Tasks:

- Add intent history to `AgentBehaviorState`: last accepted intents, completed visits, blocked reasons, and interruptibility state.
- Add working phase substates derived from `ToolIdentity`: reading, editing, testing, researching, coordinating, git, quota/resource, waiting.
- Use intent source/priority/TTL to drive dwell time and movement speed instead of only coarse agent status.
- Improve blocked recovery: alternate reserved slot, nearest road tile, fallback queue/scenic slot, then fallback building. Record the reason in debug.
- Use existing visit tile `facingPoint` consistently so agents face the relevant building, partner, harbor lane, or exit.
- Add queue groups and overflow behavior for busy buildings before introducing broad local avoidance.
- Add social gravity for teams, parent/child, and sibling subagents, capped by capacity and slot availability.
- Add chat-pair reservations away from road centers so conversations stop blocking paths.
- Implement weighted road-preferred pathfinding after the above is validated. Prefer roads, plazas, docks, and bridges; avoid water edges and dense congestion.

Acceptance:

- Working agents visit buildings that match their tool phase and do not thrash during rapid tool changes.
- Blocked agents recover visibly and deterministically.
- Busy buildings form readable queues rather than random retarget churn.
- Agents use roads more often without getting stuck.

Validation:

- Fixture runs for 1, 10, 20+ agents.
- Browser smoke: select/deselect, follow agent, team gather, parent/subagent, chat, world/dashboard toggle.

### Phase 3 - Harbor And Ship Logic

Outcome: harbor becomes a trustworthy map of repo state, not just a decorative traffic layer.

Tasks:

- Add observed vs inferred push cues to event normalization and ship labels.
- Preserve and render event confidence/source: command parsed, inferred unpushed, inferred pushed, completion metadata present.
- Add refspec-accurate push matching for `HEAD:main`, tags, detached HEAD, and branchless pushes.
- Add ship hit metadata or a near-term hover/tooltip path: repo, branch, short SHA, age, status, inferred/observed, source session.
- Add dock capacity model: berths, quays, roadstead, commit lagoon storage, overflow policy, and congestion score.
- Add harbor ledger rows for pending count, oldest unpushed age, failed/rejected count, inferred event count, and storage pressure.
- Add remote/fork routing: origin, upstream, and custom remotes through distinct buoys or route colors.
- Add wake prioritization: moving ships, failed/rejected ships, and large ship classes win limited wake slots.
- Add repo lane continuity: repo color appears on ships, harbor ledger, optional buoy markers, and minimap.
- Defer release convoy mode until route graph, capacity model, and reducer fixtures are stable.

Acceptance:

- Harbor labels and ships answer: which repo, which branch, what happened, how trustworthy is it, and what is pending.
- High commit counts remain legible.
- Failed/rejected/cancelled pushes produce different, stable visual outcomes.

Validation:

- Harbor reducer fixtures.
- World smoke at harbor zoom levels 1 to 3.
- Visual checks with dense pending commits and multiple repos.

### Phase 4 - Buildings As Semantic Landmarks

Outcome: buildings show workflow state consistently and are easier to extend.

Tasks:

- Add a building schema validator for duplicate visit tiles, missing sprites, invalid walk exclusions, capacity mismatch, out-of-map coordinates, bad anchors/horizons, and missing light/emitter references.
- Remove or reduce `BUILDING_CAPACITY_OVERRIDES`; use `building.capacity` as the source of truth with typed fallback rules.
- Add building state snapshots or a building state bus: occupants, reservations, intents, rituals, alerts, recency, and capacity.
- Add capacity pips/meters and occupancy lighting states to landmark labels.
- Add data-driven visit tile metadata: role, stance, queue group, priority, animation/facing, capacity weight, overflow/scenic.
- Move building visual constants into a registry: label accent, emblem, light fallbacks, emitter fallbacks, overlay anchors, pulse band, reduced-motion fallback.
- Move sprite calibration points into manifest or a nearby registry: observatory clock face, portal ring, forge hearth, mine seam, archive shelves, harbor ledger anchors.
- Add ritual registry entries for common building effects, but stage one building at a time.
- Add building inspector or hover detail only if canvas label density stays clean.

Acceptance:

- Adding or changing a building should mostly touch config/manifest/registry data.
- Labels and lighting tell whether a building is idle, occupied, busy, blocked, or alerting.
- Visit capacity and visual occupancy agree.

Validation:

- Building validator.
- World smoke around every landmark.
- Dense building occupancy fixture.

### Phase 5 - Rendering, Terrain, Camera, And Map Quality

Outcome: improve map correctness and performance without destabilizing the hand-crafted look.

Tasks:

- Add stable depth tie-breakers and optional depth bands to the drawable contract.
- Add conservative viewport culling for buildings, props, harbor drawables, monuments, motes, and effects before sorting/drawing.
- Add a layer inspector overlay listing render order, drawable counts, culled counts, and selected item sort keys.
- Add frame timing overlay with rolling p50/p95 for update, terrain, water, sorting, drawables, weather, labels, minimap.
- Add terrain metadata map: biome/material/wetness/shore/flow/road/district per tile.
- Add terrain invariant validator: no building on water, roads connected enough, bridge walkability, harbor docks on water, scenery sightlines clear.
- Use `waterMeta.flowX/flowY` for flow-vector water: oriented currents, ripples, wakes, rain rings by water region.
- Improve water hierarchy so open sea, harbor, lagoon, and river read differently at full-map zoom.
- Add minimap modes or semantic dots for active landmarks, harbor alerts, selected route, teams, and failed pushes.
- Add smart camera follow: lead moving agents, keep destination in frame, and avoid abrupt jumps after retargets.
- Defer chunked terrain cache and map >40x40 until culling, timing, and validators exist.

Acceptance:

- Draw order is more stable under dense scenes.
- The debug overlay can explain render cost and layer order.
- Harbor/open sea/lagoon/river have distinct visual roles.

Validation:

- Browser smoke across zoom levels 1, 1.5, 2, 3.
- Selected agent behind building and behind large props.
- Dense forest and dense harbor scenes.

### Phase 6 - Visual Enhancement And Polish

Outcome: add richer visuals only after semantics and motion contracts can keep them legible.

Tasks:

- Define a visual grammar registry: what color, shape, glow, pulse, line, label, and motion each state owns.
- Add shared pulse clock helper with named bands from `docs/motion-budget.md`, then migrate local sine cadences gradually.
- Add particle spawn options for color, size, alpha, seed, and layer while keeping caps and no allocation under reduced motion.
- Add weather legibility gate: storms, fog, rain, and night must not bury agents, labels, selection, or alerts.
- Add reduced-motion QA matrix documenting static equivalents for selection, trails, particles, weather, arrivals, departures, rituals, and harbor ships.
- Add status shape language: working, waiting, idle, alert, retry, plan mode, quota pressure, and failed push should not rely only on color.
- Add district activity washes and ground decals: civic, workshop, resource, knowledge, arcane, harbor.
- Add landmark micro-animations only where semantic: forge burst, archive read glint, observatory sweep, portal summon, mine resource pressure, harbor crane/load.
- Add model silhouette audit and contact-sheet artifacts before broad sprite generation.
- Defer provider-wide or building-wide sprite regeneration until manifest QA and contact sheets exist.

Acceptance:

- Visual richness increases without adding cue overload.
- Reduced motion remains informative.
- Agents and buildings remain readable during storm/night/dense scenes.

Validation:

- Manual screenshot set: clear, night, fog, storm, reduced motion, dense agents, selected agent, harbor event, all landmark labels.
- `npm run sprites:validate` only if sprite/manifest files change and dev dependencies are available.

### Phase 7 - Ambitious Follow-Ups

Do after foundations are validated:

- Agent goals layer: complete task, assist parent, monitor quota, recover error.
- Multi-step itineraries: archive -> forge -> taskboard -> harbor.
- Lane discipline and local avoidance steering.
- Agent clustering under 50+ or 100+ synthetic agent loads.
- Harbor route graph and release convoy mode.
- Chunked terrain caches and map scalability beyond 40x40.
- Large sprite refresh for providers, buildings, and ships.

## 125-Idea Bank

The swarm established 125 concrete ideas. Many overlap with the prioritized backlog above; the full bank is retained here so later implementation agents can reopen lower-priority candidates deliberately.

### Agent Behavior And Movement

| ID | Idea | Impact | Effort |
| --- | --- | --- | --- |
| A1 | Behavior scenario fixtures for repeatable tool/status/git/team states | H | M |
| A2 | Intent history memory in `AgentBehaviorState` | H | M |
| A3 | Working phase substates from tool categories | H | M |
| A4 | Weighted road-preferred pathfinding | H | H |
| A5 | Blocked recovery with alternate slot and fallback escalation | H | M |
| A6 | Queueing at busy buildings | H | M |
| A7 | Per-agent persona profiles by provider/model/team | H | M |
| A8 | Interruptibility rules for dwell, chat, and active work | H | M |
| A9 | Dwell duration based on intent source and activity age | M | L |
| A10 | Status-specific facing using visit tile `facingPoint` | M | L |
| A11 | Social gravity for team and parent/child agents | H | M |
| A12 | Task handoff walks between related agents | H | H |
| A13 | Destination confidence pauses for low-confidence classifications | M | M |
| A14 | Lane discipline on roads and bridges | H | H |
| A15 | Local avoidance steering | H | H |
| A16 | Multi-step itineraries for work sequences | H | H |
| A17 | Idle purpose loops: patrol, rest, observe, review, home visit | M | M |
| A18 | Stable team meeting formation | M | M |
| A19 | Parent supervision radius for subagents | M | M |
| A20 | Chat conversation zones away from paths | M | M |
| A21 | Agent fatigue/focus body language | M | M |
| A22 | Semantic tool micro-actions and stances | M | M |
| A23 | Deterministic spawn anchors by provider/team/project | M | M |
| A24 | Route preview debug overlay | M | M |
| A25 | Crowd heat map that biases future allocations | M | H |

### Visual Enhancement

| ID | Idea | Impact | Effort |
| --- | --- | --- | --- |
| V1 | Visual grammar registry for color, shape, glow, motion, labels | H | M |
| V2 | Shared pulse clock with named motion-budget bands | H | M |
| V3 | Particle spawn options for color, size, alpha, seed, layer | H | M |
| V4 | Reduced-motion QA matrix | H | M |
| V5 | Landmark occupancy visual states | H | M |
| V6 | Model silhouette audit with contact sheets | H | M |
| V7 | Weather legibility gate | H | M |
| V8 | Label declutter lanes and density fade | H | M |
| V9 | Asset manifest QA | H | M |
| V10 | Agent clustering under load | H | H |
| V11 | Provider asset expansion for DeepSeek/OpenCode | M | H |
| V12 | Runtime equipment harness | M | M |
| V13 | Accessory anchor profiles | M | M |
| V14 | Team identity beyond color | M | M |
| V15 | Repo color guardrails | M | S |
| V16 | Status shape language | H | M |
| V17 | Selected-agent x-ray polish | M | S |
| V18 | Localized ground weather: puddles, roof glints, shore foam | M | M |
| V19 | Sky event vocabulary for push/subagent/error events | M | M |
| V20 | Trail readability modes | M | M |
| V21 | Selected route highlight | H | M |
| V22 | Minimap semantic layer | M | M |
| V23 | Light source unification | M | M |
| V24 | Static prop reuse kits by district | M | M |
| V25 | Contact-sheet review artifacts in `agents/research` | M | M |

### Harbor And Ship Logic

| ID | Idea | Impact | Effort |
| --- | --- | --- | --- |
| H1 | Restore pull/fetch inbound ships | H | S |
| H2 | Harbor reducer scenario fixtures | H | M |
| H3 | Observed vs inferred push cue | H | M |
| H4 | Refspec-accurate push selection | H | H |
| H5 | Ship hit areas and selection/tooltip | H | M |
| H6 | Harbor traffic summary panel or ledger | H | M |
| H7 | Dock capacity model | H | M |
| H8 | Backend event confidence/source score | H | M |
| H9 | Remote/fork routing through distinct lanes | H | M |
| H10 | Oldest commit weathering | M | L |
| H11 | Route graph instead of fixed route arrays | H | H |
| H12 | Branch lane markers | M | M |
| H13 | No-upstream quarantine mooring | M | M |
| H14 | Exact commit pack composition | M | M |
| H15 | Push outcome timeline | H | M |
| H16 | Lighthouse alert targeting | M | M |
| H17 | Force-push risk differentiation | M | M |
| H18 | Merge/rebase/cherry-pick semantics | H | H |
| H19 | Stash/checkout/reset shore cues | M | H |
| H20 | Crane loading state | M | L |
| H21 | Storage transfer semantics and lagoon explanation | M | L |
| H22 | Harbor congestion meter | M | M |
| H23 | Route occupancy avoidance | M | M |
| H24 | Wake priority budget | M | L |
| H25 | Release convoy mode | H | H |

### Building Visual And Logic Enhancements

| ID | Idea | Impact | Effort |
| --- | --- | --- | --- |
| B1 | Unified building visual registry | H | M |
| B2 | Building schema validator | H | M |
| B3 | Capacity source of truth | H | S |
| B4 | Capacity pips on labels | M | S |
| B5 | Overflow queue visuals | M | M |
| B6 | Visit tile metadata expansion | H | M |
| B7 | Data-driven ambient points | M | S |
| B8 | Tool classifier registry | H | M |
| B9 | Intent reason mix in building presence | M | S |
| B10 | Ritual registry | H | H |
| B11 | Building state bus | H | M |
| B12 | Taskboard state board | M | M |
| B13 | Forge-to-taskboard pipeline | M | M |
| B14 | Mine resource gauges | H | M |
| B15 | Observatory host constellation | M | M |
| B16 | Portal lifecycle scenes | H | M |
| B17 | Watchtower alert ladder | M | M |
| B18 | Harbor operations ledger | H | M |
| B19 | Hit-area registry | M | M |
| B20 | Building inspector panel | H | M |
| B21 | Reservation fairness policy | H | M |
| B22 | Slot-group clustering | M | M |
| B23 | Building mood palette | M | S |
| B24 | Minimap activity markers | M | S |
| B25 | Sprite calibration manifest | H | M |

### World Map Rendering Improvements

| ID | Idea | Impact | Effort |
| --- | --- | --- | --- |
| R1 | Depth bands and stable tie-breakers | H | L |
| R2 | Viewport drawable culling | H | M |
| R3 | Layer inspector overlay | H | M |
| R4 | Frame timing overlay | H | M |
| R5 | Terrain metadata map | H | M |
| R6 | Flow-vector water | H | M |
| R7 | Smart camera follow | H | M |
| R8 | Layer registry for render order | H | M |
| R9 | Terrain invariant validator | H | M |
| R10 | Golden world visual states | H | M |
| R11 | Chunked terrain cache | H | H |
| R12 | Road/shore transition atlas | H | M |
| R13 | Weather ground plate cache | M | M |
| R14 | Depth-aware fog | H | M |
| R15 | Camera bookmarks | M | M |
| R16 | Minimap modes | M | M |
| R17 | Minimap viewport accuracy | M | L |
| R18 | Canvas budget warnings | M | L |
| R19 | Static prop spatial index | M | M |
| R20 | Label collision unifier | H | H |
| R21 | Occlusion x-ray through large props | M | M |
| R22 | Hit-area drawables | M | M |
| R23 | Deterministic atmosphere controls | H | M |
| R24 | Road authoring upgrade | M | M |
| R25 | Sea/harbor level of detail | M | M |

## Deferred Or Rejected

Rejected:

- Mobile and responsive redesign work.
- New bundler, TypeScript migration, framework rewrite, or runtime package dependencies.
- Full 3D/Three.js map rewrite.
- Replacing the current event bus with a state library as part of this effort.

Deferred:

- Large provider/building/ship sprite regeneration campaign.
- Release convoy mode and large harbor route graph.
- Map expansion beyond 40x40.
- Agent clustering at 50+ or 100+ agents.
- Always-on storms, particles, glows, and flourishes not tied to semantic state.

## Execution Readiness

Safe to execute: partial.

The plan is ready as a roadmap, but each phase still needs fresh ownership and baseline checks before implementation. The safest first implementation slices are:

1. Harbor pull/fetch normalization and small reducer fixture.
2. Building schema/manifest validator.
3. Debug overlay instrumentation for path/intent/harbor/draw counts.
4. Selected-agent destination reason copy.
5. Shared pulse clock helper with one narrow migration.

Required preflight for any implementation:

- Re-run `git status --short`.
- Re-check touched paths for unrelated edits.
- Reconfirm source code line references against current `HEAD`.
- Preserve desktop-only and zero-build constraints.

## Validation

Validation required for this planning artifact:

- Docs diff review.
- `git status --short`.

Validation run:

- `git diff --check` passed for tracked edits.
- Trailing-whitespace scan passed for this plan and `agents/README.md`.
- Idea-bank count verified at 125 entries.
- Diff review completed for the `agents/README.md` index row and spot-checked plan sections.

## Residual Risks

- The swarm did not run browser verification; conclusions are source-grounded planning recommendations.
- Several high-impact improvements affect stateful, time-sensitive systems. Fixtures should land before broad harbor or movement changes.
- Visual richness is already high. New visual work should replace ambiguity, not add noise.
- Building and rendering refactors should be incremental. `BuildingSprite` and `WorldFrameRenderer` are load-bearing modules.

## Supersession Policy

If this plan becomes stale, update `agents/README.md` with the replacement source of truth and mark this artifact `historical` or `superseded`.
