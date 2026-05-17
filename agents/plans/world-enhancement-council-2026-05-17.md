# World Enhancement — Council Consolidated Plan

Date: 2026-05-17
Status: ready
Baseline HEAD: `e919f845c5074487c694d6aa163968df48728de1`
Initial `git status --short`: ` M AGENTS.md\n M CLAUDE.md`
Final expected `git status --short` (this plan only): ` M AGENTS.md\n M CLAUDE.md\n?? agents/plans/world-enhancement-council-2026-05-17.md\n?? agents/research/world-enhancement-council-2026-05-17/`

## Source

Six parallel Opus-4.7 council members audited their domain on the same baseline and wrote notes-only research in `agents/research/world-enhancement-council-2026-05-17/`:

- `01-visual-atmosphere.md` — `VisualCurator`
- `02-agent-behavior.md` — `BehaviorChoreographer`
- `03-buildings-spatial.md` — `BuildingsDesigner`
- `04-character-design.md` — `CharacterDesigner`
- `05-git-harbor-flow.md` — `HarborEngineer`
- `06-portal-subagent-codehealth.md` — `PortalCodeHealth`

Every task below cites its origin (e.g., `V-R1`, `B-R8`) for traceability. File:line refs were captured by each council member at this HEAD and re-verified during synthesis where shared across domains.

## Goal

Transform ClaudeVille from a beautiful static-looking village into a world that **narrates itself** — every agent's coding state legible at a glance, every building reacting to who's working there, every git operation telling a story, and the Portal becoming the visible anchor of subagent life rather than decoration. Targeted at a single 1280px+ desktop viewer.

## Non-Goals

- No mobile / narrow-viewport support, responsive shrinking, or `@media` rules.
- No dependency adds; ClaudeVille stays zero-build, zero-bundler.
- No new application test runner; smoke scripts under `scripts/` only.
- No widget changes unless explicitly noted in the task.
- No remote / external services beyond what the Anthropic quota API already calls.
- No PixelLab regen of the 12 character sheets in this plan (deferred: see Phase 5).

## Headline Insight

ClaudeVille has done most of the hard work already. The recurring pattern across all six audits is **baked-but-unwired**:

- Six head accessory PNGs sit on disk; `ModelVisualIdentity.js:25-28` only references the two effort overlays (`C-R1`).
- `SkyRenderer.triggerAurora` is a complete 12s effect with reduced-motion fallback and **zero callers** (`V-R2`).
- `atmosphere.rain.splash` + `atmosphere.water.ripple.rain` are loaded but never stamped (`V-R3`).
- `reactions.warmGlint`, `windowWarmth`, `nightReflection`, `sunWarmth` are all computed each tick and never read (`V-R1`, `V-R5`, `V-R6`).
- `_drawPortalRitual` already handles `commandLifecycle.kind === 'spawn'` — but `Task`/`Agent` tool calls route to `building: 'command'`, not portal, so the rings never fire for subagent dispatch (`P-R1`).
- `EnterPlanMode` and `ExitPlanMode` have icons in `TOOL_ICONS` but no destination in `DIRECT_TOOL_CLASSIFICATIONS` — plan mode is invisible in the world (`B-R5`).
- `pull` and `fetch` are not in `GIT_EVENT_TYPES`; inbound traffic is the harbor's biggest blind spot (`G-R2`).

**A "wire what's already there" sprint delivers ~70% of the visible jump at near-zero asset cost.** That informs the phase sequencing below.

## Findings By Priority

### Critical

- **C1.** `AssetManager._loadComposedBuilding` throws when any composed cell is missing (`AssetManager.js:104-128`). One missing PNG breaks ClaudeVille boot. (`P-B9`)
- **C2.** Chat / `SendMessage` pairing is broken (`IsometricRenderer._updateChatMatching:1940`): it looks up the **summarized tool input** as a recipient alias. Real `SendMessage` inputs from `claude.js:371` are serialised JSON-ish strings — chat almost never matches. The screenshot's chat bubble above Prism is *not* a matched pair; it's a single-agent status line. (`B-B1`)

### High

- **H1.** Two `WORKING` agents look identical to two `IDLE` ones — same idle bob, same last-step facing, same bubble. (`B-R2`, `C-R2`)
- **H2.** 1-agent buildings look identical to 5-agent buildings at zoom 2 except for a 7-pixel banner. (`D-R1`)
- **H3.** Bubble truncation breaks mid-word: `"exec_command pharos-watch...yiel..."` is the screenshot's literal failure mode. (`B-R8`)
- **H4.** Teal water under an orange dusk sky is the worst atmosphere break in the current screenshot. `reactions.warmGlint` is computed and ignored. (`V-R5`)
- **H5.** No godrays at dusk despite `lighting.sunWarmth` already computed. (`V-R1`)
- **H6.** `Task`/`Agent` subagent dispatch fires a Command Center plaza pulse, not a Portal one. Subagents spawn at the Village Gate, not the obelisks. (`P-R1`, `P-R2`)
- **H7.** Force-push and rejected pushes are silently collapsed into "normal push" and "generic failure." Pull/fetch are invisible. (`G-R1`, `G-R2`, `G-R4`)
- **H8.** Six head accessory PNGs are sunk PixelLab credit, unreferenced in code. (`C-R1`)
- **H9.** Workshop district has zero scenery entries in `DISTRICT_PROPS`; eight manifest props are available. (`D-R4`, `D-R8`, `D-R12`)

### Medium

- `RelationshipState.update` clones the entire snapshot every frame, regardless of dirtiness — measurable GC pressure with subagent tethering enabled (`P-R8`).
- `LandmarkActivity._capKind` is O(N²) per tool emission (`P-R9`).
- Lighthouse beam ignores git state — decorative, not informative (`G-R8`).
- Six git operations (force-push, pull, fetch, merge, PR-open, PR-merge) are unparseable; metaphor breaks (`G-R1`, `G-R2`, `G-R6`).
- Subagents have no in-world tether to their parent after the 600ms dispatch wisp (`P-R3`).
- Mine yard has no on-ground cart-track or oreCart placement (`D-R5`).
- Smoke / leaf / firefly / cherry particle presets are unused (`V-R4`, `V-R10`).

### Low

- Harbor walkExclusion direction inconsistency (`D-B1`).
- Command visit tiles overlap central-isle basin (`D-B3`).
- `_teamMembershipWarned` Set never cleared on `invalidateCaches` (`P-B8`).
- `directorySignature` recursion depth limit hard-coded at 4 (`P-B6`).
- `Appearance.fromHash` produces unused skin/hair/eye fields (`C` cleanup spike).

A full bug list lives in each research file's *Bugs / Defects Observed* section.

## Plan

### How to use this plan

- Phases run **sequentially**. Inside a phase, tasks can parallelize unless `Depends-on` says otherwise.
- The `Source` field is `<member>-<rec>` where member is `V|B|D|C|G|P` and rec is `R#` (recommendation) or `B#` (bug). Cross-reference the research file for full rationale.
- Every task lists an **owner area** for swarm dispatch: `Visual | Behavior | Buildings | Character | Harbor | Portal-CodeHealth | Shared`.
- File:line refs were valid at HEAD `e919f84`; verify against current code before each task — the artifact index in `agents/README.md` flags how to handle stale plans.
- Validation hooks are **per-task** as well as **per-phase**. Run the phase smoke before declaring the phase done.
- If only one phase fits the budget, do Phase 0 + Phase 1 — that's where the visible jump lives.

### Phase smoke (run between phases)

1. `find claudeville/adapters claudeville/services -name '*.js' -print0 | xargs -0 -n1 node --check` and `node --check claudeville/server.js`.
2. `npm run dev`, hit `http://localhost:4000/api/{providers,sessions,usage,perf}` for 200s.
3. Browser: World mode → select agent → activity panel opens → deselect → camera unfollows; switch to Dashboard; switch back; resize content area; preserve at >1280px.
4. `npm run sprites:validate` after any manifest edits.
5. `git status --short` matches the assignment baseline (no unrelated edits).

---

### Phase 0 — Critical bugs and shared infrastructure

Goal: every later phase can subscribe to richer events, classify richer states, and the world can boot if an asset is missing. Estimated 5–7 days at full focus.

#### 0.1 — Asset boot resilience
- **Source:** `P-B9` · **Owner:** Portal-CodeHealth
- **Impact: High · Effort: S · Confidence: H**
- **Problem.** A single missing composed-building PNG throws from `AssetManager._loadComposedBuilding`, propagates through `App.boot`, renders the error screen.
- **Proposal.** In `AssetManager.js:104-128`, catch per-cell load failures, log once via the new boot summary (task 0.13), and fall back to `_placeholder/checker-64.png` for that cell. Composed building still renders.
- **Touchpoints:** `claudeville/src/presentation/character-mode/AssetManager.js:104-128`.
- **Validation:** rename one cell PNG; reload; village renders with one checker patch instead of error screen.

#### 0.2 — Fix `SendMessage` recipient resolution
- **Source:** `B-B1`, `B-R3` (partial — only the resolver fix lands here) · **Owner:** Behavior
- **Impact: High · Effort: S · Confidence: H**
- **Problem.** `_updateChatMatching:1940` calls `spriteByRecipient.get(agent.currentToolInput)` with the raw summarized JSON-ish string; map keys are `name`/`agentName`/`agentId`/`id`. Match never lands.
- **Proposal.** Extract `extractTargetRef`-style parsing (`AgentEventStream.js:104`) into `claudeville/src/domain/services/RecipientResolver.js`. Replace the raw lookup at `IsometricRenderer.js:1940` with the resolver. Leave the rendezvous-arc visual changes (`B-R3.2-.4`) for Phase 2.
- **Touchpoints:** `IsometricRenderer.js:1935-1960`, new `claudeville/src/domain/services/RecipientResolver.js`, `AgentEventStream.js:100-118` (export shared helper).
- **Validation:** stub a `SendMessage` with input `recipient_name=Prism, message=hi`; sender pairs with Prism instead of dropping.

#### 0.3 — Adapter expansion: pull/fetch/force/stderr/subagent enrichment
- **Source:** `G-R1`, `G-R2`, `G-R4`, `P-B2`, `C-R3` (precondition) · **Owner:** Shared (adapters)
- **Impact: High · Effort: M · Confidence: H**
- **Sub-tasks:**
  - 0.3a — Add `pull`, `fetch` to `GIT_EVENT_TYPES` (`gitEvents.js:4`); parse positionals like push (no visual yet — that's Phase 3).
  - 0.3b — Detect `--force`, `--force-with-lease`, `--force-if-includes`, leading-`+` refspec inside `pushPositionals` (`gitEvents.js:335-378`). Set `event.force: true | 'lease' | 'safe'` on the push event. Strip the `+` for `targetRef` separately (preserve existing `normalizeRefName` behavior).
  - 0.3c — Thread tool result stderr/text into `parseGitEventsFromCommand` context across `claude.js:520-525`, `codex.js:597-605`, `gemini.js:286-303`. Surface in `GitEventIdentity.normalizePushStatus` to distinguish `'rejected'` (`/rejected|non-fast-forward|failed to push some refs/i`) from `'failed'`.
  - 0.3d — Include `child.agentType`, `child.agentName`, and `subagent_type` in the `subagent:dispatched` payload (`AgentEventStream.js:254-265`).
  - 0.3e — Verify `claude.js` populates `teamName` for orphan/team-member sessions (gap noted in `familiars-and-council.md:73`; required for `C-R3`).
- **Touchpoints:** `claudeville/adapters/gitEvents.js`, `claudeville/adapters/{claude,codex,gemini}.js`, `claudeville/src/presentation/shared/GitEventIdentity.js`, `claudeville/src/presentation/character-mode/AgentEventStream.js`.
- **Validation:** synthetic event injection via `window.__harbor.state` confirms `force`, `'rejected'`, and pull/fetch event types surface; subagent payload includes new fields.

#### 0.4 — Domain status expansion
- **Source:** `B-R2`, `B-R5`, `C-R2` · **Owner:** Shared (domain)
- **Impact: High · Effort: S · Confidence: H**
- **Problem.** `AgentStatus` is `working|idle|waiting|completed` only. No `RATE_LIMITED`, `ERRORED`, or `WAITING_ON_USER`.
- **Proposal.** Add `AgentStatus.RATE_LIMITED`, `AgentStatus.ERRORED`, `AgentStatus.WAITING_ON_USER` (`AgentStatus.js:1-7`). Wire `AgentManager._upsertAgent` to derive `WAITING_ON_USER` when current tool is `AskUserQuestion` / `request_user_input`, `ERRORED` from recent failed `gitEvents` or quota-gated heuristic, `RATE_LIMITED` from `usageQuota.fiveHour > 0.95`. Keep status detection conservative — false positives are loud.
- **Touchpoints:** `claudeville/src/domain/value-objects/AgentStatus.js`, `claudeville/src/application/AgentManager.js:81+`.
- **Validation:** force tool=`AskUserQuestion`; agent status reads `WAITING_ON_USER` in `/api/sessions`.

#### 0.5 — `ToolIdentity` classifier completion
- **Source:** `B-R5` (plan mode), `B`-quickwin-1 (action labels), `D-R7`, `D-R10` · **Owner:** Behavior
- **Impact: Medium · Effort: S · Confidence: H**
- **Proposal.** In `claudeville/src/domain/services/ToolIdentity.js`:
  - Classify `EnterPlanMode` → `taskboard` reason `'plan-mode-enter'`; `ExitPlanMode` → `taskboard` reason `'plan-mode-exit'` (`DIRECT_TOOL_CLASSIFICATIONS`).
  - Add `TOOL_ACTION_LABELS` entries: `TeamCreate: 'Forming team'`, `TaskList: 'Reviewing tasks'`, `NotebookEdit: 'Editing notebook'`, `MultiEdit: 'Editing'`, `apply_patch: 'Patching'`.
  - Extract `WebFetch`/`WebSearch` host into a `currentToolInputHost` field for Observatory bubble (`B-R8.4`).
  - Detect Playwright MCP tool names (`mcp__plugin_playwright_*`) → portal `reason: 'portal-active'`; detect `localhost:*` in `WebFetch` input → portal `reason: 'portal-preview'` (D-R10 substrate).
- **Touchpoints:** `claudeville/src/domain/services/ToolIdentity.js`.
- **Validation:** unit-test via the new smoke script (`scripts/smoke/adapters.mjs` in Phase 5, optional now): pass each new tool through `classifyTool` and assert the destination.

#### 0.6 — Route `Task`/`Agent` into Portal ritual queue
- **Source:** `P-R1` · **Owner:** Portal-CodeHealth
- **Impact: High · Effort: S · Confidence: H**
- **Proposal.** In `RitualConductor.ritualMetaFor` (`RitualConductor.js:182-198`), route `tool === 'Task' || tool === 'Agent'` to `RITUAL_META.portal` with `action: 'summon'` and `commandLifecycle: { kind: 'spawn', targetAgentId: <future childId or null>, targetName: classified.label || subagent_type }`. Subscribe `IsometricRenderer` to `subagent:dispatched` and forward a synthetic `tool:invoked` with `building: 'portal'` and `summonTargetId` for `_targetSpriteForRitual` to pick up. Drop the duplicate "SUMMON" stub at Command Center (`LandmarkActivity.js:85-89`) when the same agent has an active portal summon.
- **Touchpoints:** `RitualConductor.js:182-198`, `IsometricRenderer.js:1142-1175`, `LandmarkActivity.js:85-89`.
- **Depends-on:** 0.3d (payload), 0.5 (classifier route).
- **Validation:** spawn a subagent via `Task` tool — obelisks pulse with summon ritual instead of Command Center plaza.

#### 0.7 — Per-building active-agent map
- **Source:** `D-R1` (precondition), `V-R6`, `V-R10` · **Owner:** Buildings
- **Impact: Medium · Effort: S · Confidence: H**
- **Problem.** Visual and Behavior modules want a fast "who's working where right now" lookup. Today only `_visitorCountByType` (`BuildingSprite.js:780-832`) is computed for the banner; recency isn't tracked.
- **Proposal.** Extend `LandmarkActivity` (`L106-120`) with a 60s rolling `_recencyByType` map. Expose `getBuildingPresence(type) → { count, recencyScore, tier: 'dormant' | 'occupied' | 'busy' }` where `busy ≥ buildings.js capacity.work`, `occupied: 0 < count`, `dormant: 0` and recency decays. Mount on `eventBus.emit('building:active-agents', map)` once per 500ms.
- **Touchpoints:** `LandmarkActivity.js:106-120`, new event payload.
- **Validation:** dev console `eventBus.on('building:active-agents', console.log)` — payload fires at expected cadence and tracks agent moves.

#### 0.8 — `building:selected` event
- **Source:** `D-R2` (precondition; UI in Phase 4) · **Owner:** Buildings
- **Impact: Low · Effort: S · Confidence: H**
- **Proposal.** Add `building:selected` / `building:deselected` to `DomainEvent.js`. Wire `BuildingSprite.hitTest` (`L964-976`) through the canvas click handler to emit. No UI consumer in Phase 0 — UI lands as Phase 4 task.
- **Touchpoints:** `claudeville/src/domain/events/DomainEvent.js`, `IsometricRenderer.js` canvas click handler near agent selection.
- **Validation:** dev console subscriber logs the event on building clicks.

#### 0.9 — `RelationshipState` membership cache
- **Source:** `P-R8` · **Owner:** Portal-CodeHealth
- **Impact: Medium · Effort: S · Confidence: H**
- **Problem.** `update` (`RelationshipState.js:64-75`) clones the entire `parentToChildren`/`teamToMembers` snapshot every RAF, regardless of `_dirty`. Consumers (`CouncilRing`, `LandmarkActivity`, familiar motes) read but don't mutate.
- **Proposal.** Cache `parentToChildren`/`childToParent`/`teamToMembers`. Rebuild only when `_dirty === true`. Chat pairs and `recentArrivals`/`recentDepartures` still rebuild every frame.
- **Touchpoints:** `RelationshipState.js:58-75`.
- **Validation:** 50-idle-agent scene — `_dirty === false` path produces zero new Map allocations; verify via Chrome DevTools allocation profiler.

#### 0.10 — `LandmarkActivity._capKind` O(1) trim
- **Source:** `P-R9` · **Owner:** Portal-CodeHealth
- **Impact: Medium · Effort: S · Confidence: H**
- **Proposal.** Replace the array-sort trim at `LandmarkActivity.js:336-344` with a per-type insertion-ordered `Map<type, Array<id>>` shift-the-oldest pattern.
- **Touchpoints:** `LandmarkActivity.js:91-345`.
- **Validation:** microbench 200 tool invocations across 4 types; trim time should fall from O(N) to O(1) per insert.

#### 0.11 — Bubble path-aware truncate
- **Source:** `B-R8` (sub 1-3), `B`-quickwin-2 · **Owner:** Behavior
- **Impact: High · Effort: S · Confidence: H**
- **Proposal.** In `compactToolInput` (`ToolIdentity.js:162`), prefer truncate boundaries at `/`, `.`, ` `, `:` over mid-word. For `Bash`/`exec_command`, surface only the first argument (`pharos-watch yield-curve` → bubble shows `pharos-watch`). Promote `currentToolInputHost` to bubble label for Observatory tools.
- **Touchpoints:** `claudeville/src/domain/services/ToolIdentity.js:140-180`, `AgentSprite._captureActivitySnapshot:2556`.
- **Validation:** screenshot reproduces `"exec_command pharos-watch...yiel..."` failure mode → bubble now reads `Bash: pharos-watch`.

#### 0.12 — `HarborTraffic` Phase B debug gating
- **Source:** `G`-bugs · **Owner:** Harbor
- **Impact: Low · Effort: S · Confidence: H**
- **Proposal.**
  - Gate `window.__harbor = this;` (`HarborTraffic.js:1497`) behind `localStorage.getItem('claudeVilleDebug')`.
  - Gate `_observePeakDensity` `console.info` (`HarborTraffic.js:1731-1742`) behind the same flag.
  - Clear `ship.departStartedAt` once on first success transition (`HarborTraffic.js:1448`) to prevent stale-start replays.
  - Unify ship-cleanup TTL (`57.2s`) with batch-cleanup TTL (`73s`) at `HarborTraffic.js:1462-1476`, or seal `batch.origin` at delete time.
- **Touchpoints:** `HarborTraffic.js:1448, 1462-1497, 1731-1742`.

#### 0.13 — Boot-time asset-miss summary
- **Source:** `P-R14`, `P`-quickwin · **Owner:** Portal-CodeHealth
- **Impact: Low · Effort: S · Confidence: H**
- **Proposal.** Accumulate `AssetManager._loadImage` misses (`AssetManager.js:179-188`) into a single `[AssetManager] missing N: ...` line after `load()` resolves. Replace per-file warnings.
- **Touchpoints:** `AssetManager.js:25-188`.

**Phase 0 done when:** all the above are merged, `node --check` clean, agent UI looks identical to today *but* every internal signal Phase 1+ needs is available.

---

### Phase 1 — Self-evident world

Goal: a still screenshot should answer "what is each agent doing, and which buildings are busy?" Estimated 5–7 days.

#### 1.1 — Wire baked head accessories to role / current-tool
- **Source:** `C-R1` · **Owner:** Character
- **Impact: High · Effort: S · Confidence: H**
- **Proposal.** New `claudeville/src/presentation/shared/RoleAccessory.js` mapping `(agent.role, currentTool category)` → `mageHood | scholarCap | goggles | toolBand | starCrown | oracleVeil`. Picks: research → scholarCap, web/external → oracleVeil, file-edit/bash → toolBand, build/forge → goggles, team-lead → starCrown, mage default → mageHood. Effort accessory wins when present. Cache key already accepts accessory (`AgentSprite.js:963`).
- **Touchpoints:** `claudeville/src/presentation/shared/{ModelVisualIdentity.js,RoleAccessory.js}`, `claudeville/src/presentation/character-mode/AgentSprite.js:958`.

#### 1.2 — Compact name pill: provider + model-tier + repo glyphs
- **Source:** `C-R4` · **Owner:** Character
- **Impact: Medium · Effort: S · Confidence: H**
- **Proposal.** Stack three 6px glyphs left-of-text in `_drawCompactNameStatus` (`AgentSprite.js:2494-2530`): provider mark (color from `PROVIDER_BADGES[provider]`), model tier dot (apex=gold, balanced=silver, light=copper from `identity.modelTier`), repo glyph (existing). Width stays capped at 192px.
- **Touchpoints:** `AgentSprite.js:2466-2530, 2717-2736`.

#### 1.3 — Status emote glyph stack
- **Source:** `C-R2`, `B-R2` (emote half) · **Owner:** Character
- **Impact: High · Effort: M · Confidence: H**
- **Proposal.** `_drawStatusEmote(ctx, contentTopY)` floats a 12px overlay above silhouette. Five new manifest entries `accessory.statusEmote.{thinking,waitingUser,errored,rateLimited,done}` (16px PixelLab). Map: `WAITING_ON_USER` → `?`, `ERRORED` → `!`, `RATE_LIMITED` → hourglass, recent `COMPLETED` → check, otherwise tool fresh + !chatting → thinking dots.
- **Touchpoints:** `AgentSprite.js:1426-1464` (extend `STATUS_VISUALS`), new draw helper, `manifest.yaml` (5 entries).
- **Depends-on:** 0.4 (status values), 1.1 (head overlay infra).
- **Validation:** force agent into each new status; emote renders above head across zoom levels.

#### 1.4 — Posture stance modifiers
- **Source:** `B-R2` (stance half) · **Owner:** Behavior + Character
- **Impact: High · Effort: M · Confidence: M**
- **Proposal.** Add `AgentStanceOverlay.js` painting state-specific overlays atop existing idle/walk sheets. WORKING+at-building: head-tilt + hand-bob synced to `RitualConductor` building event. WAITING: arms-crossed + occasional head-pan. IDLE: bob amplitude `0.4`, fidget interval `8-12s`. CHATTING-ACTIVE: hand-gesture alt every 600ms. Use small overlay PNGs, not new sheets (PixelLab regen deferred to Phase 5).
- **Touchpoints:** new `character-mode/AgentStanceOverlay.js`, `AgentSprite.draw` (between sprite blit and bubble), `manifest.yaml` overlays.
- **Depends-on:** 1.3 (Compositor accessory slot infra).

#### 1.5 — Token-burn aura intensity
- **Source:** `C-R7` · **Owner:** Character
- **Impact: Low · Effort: S · Confidence: M**
- **Proposal.** Multiply WORKING aura alpha by `clamp(0.6 + log10(agent.tokens.total || 1) / 6, 0.6, 1.4)` at `_drawGrounding` (`AgentSprite.js:1270-1286`). IDLE/WAITING unchanged.

#### 1.6 — Building presence pulse + window warmth
- **Source:** `D-R1`, `D-R3`, `V-R6` · **Owner:** Buildings
- **Impact: High · Effort: M · Confidence: H**
- **Proposal.** Subscribe `BuildingSprite` to `building:active-agents` (task 0.7). Map tier to:
  - emitter chance multiplier in `BUILDING_EMITTER_FALLBACKS` (`BuildingSprite.js:259-265`).
  - light radius boost in `getLightSources` (`L855-890`) — already used for forge/watchtower.
  - per-building `windowWarmth` multiplier `0.45 + 0.55 * occupancyTier` at `BuildingSprite.js:1041-1100` — replaces global uniform warmth.
- **Depends-on:** 0.7.
- **Validation:** fill a building 0 → capacity; light + emitters change per state; empty Forge at night is dim, packed Command at noon is lit.

#### 1.7 — Smoke plumes for active Forge/Mine
- **Source:** `V-R10` · **Owner:** Visual
- **Impact: Medium · Effort: S · Confidence: H**
- **Proposal.** Extend `IsometricRenderer.js:1055-1064` emitter list with `gatedBy: 'building.activeAgents'` reading the presence pulse from 0.7. Spawn `smoke` particle (`ParticleSystem.js:73-80`) every 600ms from Forge / Mine roof anchor when tier ≥ `occupied`. Static fallback: single drawn puff.
- **Depends-on:** 0.7.

#### 1.8 — State-aware label accents
- **Source:** `D-R9` · **Owner:** Buildings
- **Impact: Medium · Effort: S · Confidence: H**
- **Proposal.** At `drawLabels` (`BuildingSprite.js:345`), brighten `LANDMARK_LABEL_ACCENTS` (`L32-42`) when `_visitorCountFor(b) > 0`; add tiny leading dot. For Watchtower with `failedPushActive`, swap accent to `#ff755d`.

#### 1.9 — Scenery prop placement PR (one file)
- **Source:** `D-R4`, `D-R8`, `D-R12`, `D-quickwin-1` · **Owner:** Buildings
- **Impact: High · Effort: S · Confidence: H**
- **Proposal.** Edit `claudeville/src/config/scenery.js:361-399` `DISTRICT_PROPS` only. Add (all manifest IDs verified):
  - **workshop**: `prop.scrollCrates`, `prop.runestone` at entrance, `prop.runeBrazier` on handoff path.
  - **civic north promenade**: `prop.well @ (17,17)`, `prop.flowerCart @ (19,18)`, `prop.signpost @ (16,20)` at bridge junction.
  - **gate-avenue spine**: `prop.marketStall`, `prop.noticePillar @ (20,28)`.
  - **resource→arcane corridor**: `prop.runestone`, `prop.lantern` along Portal (9,34) → Mine (13,35).
- **Validation:** browser smoke; no walkability regression on `production-row` / `north-bank-promenade` / `gate-avenue` / `west-production-road`; `sprites:visual-diff` baseline accepted.

#### 1.10 — Phase-coupled water palette
- **Source:** `V-R5` · **Owner:** Visual
- **Impact: High · Effort: M · Confidence: H**
- **Proposal.** Tint base water toward `palette.horizon` weighted by `reactions.warmGlint` at dusk/dawn, toward `palette.zenith × 0.5` at night. Day stays teal. Touch `IsometricRenderer.js:4109-4112` (shimmer base), `:761-770` (water token), `theme.js:15-16` (extend `water` to per-phase tint).

#### 1.11 — Crepuscular rays (godrays)
- **Source:** `V-R1` · **Owner:** Visual
- **Impact: High · Effort: M · Confidence: H**
- **Proposal.** New `SkyRenderer._drawGodrays(ctx, canvas, sun, lighting)` drawing 6–10 thin radial gradients from sun position with `globalCompositeOperation='screen'` and `alpha ≤ 0.10 * sunWarmth` when `lighting.sunWarmth > 0.18 && sun.alpha > 0.04`. Reuse `_resolveSunPosition` (`SkyRenderer.js:300-377`). Bake into per-`cacheKey` sky cache. Call also from `drawCanopy` at 0.4x alpha.
- **Touchpoints:** `SkyRenderer.js:64-81, 300-377`.
- **Motion-budget band:** `static`.

#### 1.12 — `B-R8` history dedup
- **Source:** `B-R8` (sub 1) · **Owner:** Behavior
- **Impact: Medium · Effort: S · Confidence: H**
- **Proposal.** Collapse consecutive same-category entries in `_drawStatus` history (`AgentSprite.js:2231`) using `TOOL_CATEGORIES`; add `×N` badge. Avoid `Read` × 6 bubbles.

#### 1.13 — Idle bob amplitude + long-wait clock
- **Source:** `B`-quickwins 3, 5 · **Owner:** Behavior
- **Impact: Low · Effort: S · Confidence: H**
- **Proposal.** IDLE bob `0.4 * sin(frame * 0.25)` vs WORKING/CHATTING unchanged at `AgentSprite.js:997`. When `activityAgeMs > 60_000` and status `WAITING`, render a small clock chevron in bubble area instead of repeating `WAIT` label.

**Phase 1 done when:** at default zoom 1, an unfamiliar viewer can tell at a glance (a) which agents are working vs idle vs waiting vs errored, (b) which buildings are busy, (c) what tool the agent is using without a mid-word truncation, and (d) dusk lighting feels coherent across sky + water.

---

### Phase 2 — Portal is real; behavior reflects coding

Goal: subagents are visibly summoned at the obelisks; agents face what they're working on; plan mode, retries, and rate-limit throttles read in the world. Estimated 5–7 days.

#### 2.1 — Subagents spawn at Portal Gate
- **Source:** `P-R2` · **Owner:** Portal-CodeHealth
- **Impact: High · Effort: S · Confidence: H**
- **Proposal.** Const `PORTAL_SPAWN_TILE = { tileX: 7, tileY: 32 }` in `IsometricRenderer.js`. In `_beginAgentGateArrival` (`:1761-1780`) branch on `agent.parentSessionId`: if set, place at `PORTAL_SPAWN_TILE + _gateJitter`, then `walkToTile` toward parent's tile or current intent. If no parent, fall back to Village Gate behavior.
- **Depends-on:** 0.6 (portal ritual route — for the visual lock).
- **Validation:** spawn a subagent in a fresh session; `agentSprites.get(<childId>).tileX ∈ [6.7, 7.3]` immediately after `agent:added`.

#### 2.2 — Dispatch wisp originates at Portal
- **Source:** `P-R7` · **Owner:** Portal-CodeHealth
- **Impact: Low · Effort: S · Confidence: M**
- **Proposal.** Change `ArrivalDeparture.beginSubagentDispatch` start point (`ArrivalDeparture.js:129-150`) from `parent.x, parent.y-34` to `tileToScreen(PORTAL_SPAWN_TILE)` with the existing 24px lift. Arc reads as "command flows through portal."
- **Depends-on:** 2.1.

#### 2.3 — Portal label honors subagent_type
- **Source:** `P-R6` · **Owner:** Portal-CodeHealth
- **Impact: Low · Effort: S · Confidence: H**
- **Proposal.** In the synthetic `tool:invoked` from 0.6, prefer `child.agentName || classifyTool(...).label || child.subagent_type || child.role`. Label reads e.g. `SUMMON: code-reviewer`.
- **Depends-on:** 0.3d, 0.6.

#### 2.4 — Persistent parent → child tether
- **Source:** `P-R3` · **Owner:** Portal-CodeHealth
- **Impact: Medium · Effort: M · Confidence: M**
- **Proposal.** New `CouncilRing.drawFamilyTethers(ctx, { relationship, agentSprites, ... })` drawing thin animated dashed curves (`[3,6]` with scrolling `lineDashOffset`) per `[parentId, childIds]`. Provider-colored, alpha 0.18-0.28. Hook into `WorldFrameRenderer.js:53-61` between council rings and depth-sorted draw.
- **Depends-on:** 0.9 (relationship cache so this doesn't blow per-frame allocations).
- **Motion-budget band:** `slow`. Reduced-motion: dashes static.

#### 2.5 — Family plaza preference
- **Source:** `P-R4` · **Owner:** Portal-CodeHealth
- **Impact: Medium · Effort: S · Confidence: H**
- **Proposal.** Extend `applyTeamPlazaPreferences` (`CouncilRing.js:40-56`): for `parentToChildren` entries with `childIds.size >= 2` and parent idle, set `setFamilyPlazaPreference(parent.tileX, parent.tileY)` on idle children. New companion API to `AgentBehaviorState.setTeamPlazaPreference`.

#### 2.6 — Orphan subagent returns through Portal
- **Source:** `P-R5` · **Owner:** Portal-CodeHealth
- **Impact: Low · Effort: S · Confidence: M**
- **Proposal.** When `_beginRelationshipDeparture` (`IsometricRenderer.js:1714-1751`) detects removed child whose parent is gone, call new `recordOrphanReturn(child, lastTile)` animating the wisp to `PORTAL_SPAWN_TILE` instead of fading in place.

#### 2.7 — `facingPoint` per visit tile
- **Source:** `B-R1` · **Owner:** Buildings + Behavior
- **Impact: High · Effort: S · Confidence: H**
- **Proposal.** Add optional `facingPoint: { x, y }` (world coords) to each `visitTile` in `BUILDING_DEFS` (`buildings.js`). Allocator threads it through reservation payload. `AgentSprite._faceBuilding` (`L860`) consumes when present; falls back to current tile-center math. Add per-building bias (Forge→anvil, Archive→shelf row, Harbor→water edge, Observatory→dome). Apply on `behavior.arrive` and every 4-9s re-anchor.
- **Depends-on:** verify `Building.containsVisitPoint` shape is set for every entry (Bug `B-B7`).

#### 2.8 — Plan mode visible behavior
- **Source:** `B-R5` (plan mode half) · **Owner:** Behavior
- **Impact: Medium · Effort: S · Confidence: H**
- **Proposal.** While `EnterPlanMode` → `ExitPlanMode` window: set `behavior.planMode = true` on the agent; render a compass/blueprint glyph above sprite. Clear on ExitPlanMode or any other tool.
- **Depends-on:** 0.5 (classifier).

#### 2.9 — Token cash-out walk to Mine
- **Source:** `B-R5` (token spend half) · **Owner:** Behavior
- **Impact: Medium · Effort: S · Confidence: H**
- **Proposal.** On token delta ≥1024, push a one-shot high-priority intent `reason: 'cash-out'` toward Mine (8s dwell). Below 1024, keep existing `__token_delta` ritual without agent travel.

#### 2.10 — Rate-limit throttle desaturation
- **Source:** `B-R5` (throttle half) · **Owner:** Behavior
- **Impact: Medium · Effort: S · Confidence: H**
- **Proposal.** When `usageQuota.fiveHour > 0.85`, emit `quota:throttled` from `App.js`. `VisitIntentManager` gives every WORKING agent a low-priority `quota` intent toward Mine; ground ring desaturates and walk speed × 0.7 while throttled. Coordinate with PulsePolicy so error/throttle override effort/working glows briefly.
- **Depends-on:** 0.4 (`RATE_LIMITED` status).

#### 2.11 — Tool retry detection
- **Source:** `B-R6` · **Owner:** Behavior
- **Impact: Medium · Effort: S · Confidence: M**
- **Proposal.** In `AgentEventStream._emitToolIfChanged` (`:306`), when same `(tool, normalized-input)` fires twice within 20s, emit `tool:retried` with retry count. `AgentSprite` shows yellow `↻` glyph for 6s. Gate the heuristic flag for `lastMessage`/error regex behind config; false positives are loud.

#### 2.12 — Idle stroll gait + road routing
- **Source:** `B-R7` · **Owner:** Behavior
- **Impact: Medium · Effort: M · Confidence: H**
- **Proposal.** IDLE-specific gait with pause every 12 frames in `_advanceWalkAnimation` (`AgentSprite.js:792`). Idle agents route via `getRoadTiles` for any visit > 6 tiles away (extend `_assignTarget:428` beyond scenic). Every 18-30s, idle agent pauses 1-2s, faces a nearby landmark, then resumes.

#### 2.13 — Council ring as gathering destination
- **Source:** `B-R9` · **Owner:** Behavior
- **Impact: Medium · Effort: M · Confidence: M**
- **Proposal.** When 2+ team members are simultaneously IDLE within 12 tiles, emit `team:gather` intent (priority 70, sticky 30s, 30s TTL). Sort by `atan2` of current pos; assign arc slots on Command Plaza visit tiles. Members face centroid; switch to chat-ellipsis idle. On any member starting WORKING, run a scatter wisp from centroid. Cap one gather per team per 5 minutes.

**Phase 2 done when:** every `Task` invocation lights the obelisks; subagents step out of the portal and walk to their parent; idle teammates congregate; plan mode is visible; rate-limit shows in the world.

---

### Phase 3 — Harbor tells the whole story

Goal: every git operation a developer cares about reads in the world. Estimated 5–7 days.

#### 3.1 — Force-push as sinking
- **Source:** `G-R1` · **Owner:** Harbor
- **Impact: High · Effort: M · Confidence: H**
- **Proposal.** In `HarborTraffic.reduceHarborTrafficState` push branch (`HarborTraffic.js:1300-1458`), when `event.force === true`: shorten `DEPARTURE_MS` to ~12s; render ship listing+sinking into a whirlpool over last 4s with red spray. `--force-with-lease` keeps normal departure + yellow flagship banner. Reuse `PUSH_STATUS_STYLE.failed` palette.
- **Depends-on:** 0.3b (force flag).
- **Validation:** inject `{type:'push', force:true, ...}` → whirlpool finale.

#### 3.2 — Pull/fetch as inbound ships
- **Source:** `G-R2` · **Owner:** Harbor
- **Impact: High · Effort: M · Confidence: H**
- **Proposal.** Pull/fetch event types (from 0.3a) animate an inbound ship entering from the same north edge that pushes exit through, sailing the `LOCAL_WATER_ROUTE_BANDS` in reverse, docking at empty berth. Pull → quay. Fetch (no merge) → outer roadstead anchorage. Carry crates emblazoned with incoming-commit count from `rev-list HEAD..@{u}` enrichment (mirror `readUnpushedCommitEvents`). Add `'arriving'` ship status.
- **Touchpoints:** `HarborTraffic.js:113-146, 1248-1300, 232`, new helper `composeInboundRouteTiles`.
- **Depends-on:** 0.3a.

#### 3.3 — Rejected vs failed push
- **Source:** `G-R4` · **Owner:** Harbor
- **Impact: Medium · Effort: S · Confidence: H**
- **Proposal.** New `PUSH_STATUS_STYLE.rejected` (`HarborTraffic.js:235-257`). Ship boomerangs to harbor mouth then re-docks at original berth; red collision flare at the mouth; yellow caution flag.
- **Depends-on:** 0.3c (stderr threading).

#### 3.4 — Functional lighthouse
- **Source:** `G-R8` · **Owner:** Harbor + Visual
- **Impact: Medium · Effort: M · Confidence: M**
- **Proposal.** Couple `_drawLighthouseBeam` (`IsometricRenderer.js:6210`) to push lifecycle:
  - Idle: slow rotation, warm hue.
  - Active push: beam locks on departing squad until it crosses `DEPARTURE_EDGE_Y`; hue → `success.accent`.
  - Failed/rejected: beam strobes red 8s.
  - No upstream: beam dims, fog drifts in from existing `WeatherRenderer` fog path.
  - Unpushed commits > 5min: slow pulse.
- **Depends-on:** 3.3 (rejected), `HarborTraffic.getActivePushSignal()` (new public method).
- **Validation:** push a non-FF → beam strobes red.

#### 3.5 — Push lifecycle phases (cast-off / weight / mist fade)
- **Source:** `G-R3` · **Owner:** Harbor
- **Impact: Medium · Effort: S · Confidence: M**
- **Proposal.** Stage first ~1500ms of departure as cast-off: hold at berth, animate mooring tick snap (`HarborTraffic.js:2658-2667`), stutter-step 8px east before `departStartedAt`. Scale `DEPARTURE_MS` with pack size: `48000 + min(20000, packSize * 1200)`. Flagship/dreadnought hoist a second pennon at cast-off moment. Fade-out final 800ms through a sea-mist sprite.

#### 3.6 — Edge cases: no remote, detached HEAD, amend
- **Source:** `G-R11` · **Owner:** Harbor
- **Impact: Medium · Effort: S · Confidence: H**
- **Proposal.** When `hasUpstream === false` for >2 docked commits, draw "broken-rope" pennant on squad flagship; tooltip "No remote — `git remote add origin <url>` to enable push." Detached HEAD ships get a black-and-white checkered band. Amended commits (`mergeCommitIntoShip` at `HarborTraffic.js:1032-1046`) flash hull in repo accent for 400ms; increment `amendCount` rendered as superscript on flag.

#### 3.7 — Commit Lagoon ↔ Harbor channel buoy
- **Source:** `G-R10` · **Owner:** Harbor
- **Impact: Medium · Effort: S · Confidence: M**
- **Proposal.** Place `prop.harborBeaconBuoy` at lagoon→harbor seam (~tile 26,6) pulsing in the repo accent of whichever ship is transiting (`_observeStorageTransfers`). Hover: "X commits from <repo> flowing to harbor — push to release."

**Phase 3 done when:** force-push, rejected, pull, fetch, no-remote, detached HEAD are all visually distinct from a normal push, and the lighthouse beam responds to push state.

---

### Phase 4 — Celebrations, depth, click affordances

Optional polish layer once Phases 0–3 land. Cherry-pick by user appetite. Estimated 3–7 days.

- **4.1 — Aurora on push at night.** `V-R2`. Subscribe to push-success events; call `SkyRenderer.triggerAurora()` when `phase === 'night'` with a 5-minute cooldown. Uncomment `atmosphere.aurora` in `manifest.yaml:991`.
- **4.2 — Tag/release fireworks.** `G-R7`. On `ChronicleMonuments.planter.processEvents` returning a release stone, emit `harbor:release-burst` triggering 6s fireworks ring over harbor.
- **4.3 — Milestone banners.** `G-R12`. `lifetimeCommitCountByProject` in `ChronicleStore`. 1st: "Maiden Voyage" banner in Inner Quay Basin. 10th: ribbon. 100th: flagship commemorative banner + lighthouse 4s lock. 1000th: force aurora via `AuroraGate`.
- **4.4 — Shooting star on task completion.** `V-R7`. `SkyRenderer.triggerShootingStar({ angle, length })` 1.2s arc, pool max 3. Subscribe to task/subagent completion at night.
- **4.5 — Sprite rain impacts.** `V-R3`. Stamp `atmosphere.rain.splash` every ~120ms when precipitation > 0.15; stamp `atmosphere.water.ripple.rain` on water tiles. Static fallback: deterministic grid.
- **4.6 — Seasonal ambient particles.** `V-R4`. New `SeasonalAmbience.js` reading `atmosphere.clock.localDate`. Dec-Feb snow, Mar-May cherry, Jun-Aug fireflies, Sep-Nov leaves.
- **4.7 — Lighthouse beam in fog/storm.** `V-R8`. Multiply beam alpha by `1 + intensity * 0.6` and widen bloom under `weather.type ∈ {fog,rain,storm}`; add volumetric cone at 0.4 alpha.
- **4.8 — Wind-driven foliage sway.** `V-R9`. Per-tree horizontal `dx = sin(t*0.001 + seed) * windX * 1.5` capped ±2px in `IsometricRenderer.js:616`. Skip boulders.
- **4.9 — Building-detail panel via `building:selected`.** `D-R2`. `ActivityPanel` consumes `building:selected` (from 0.8). Show occupants (click-through agent select), last 3 tools mapped here in 5min, quota state. Mirror Harbor ledger pattern (`BuildingSprite.js:488-531`).
- **4.10 — Archive shelf-fill keyed to Read counter.** `D-R6`. Rolling counter of Read/Grep/Glob per Archive in `LandmarkActivity` (sibling to forge handoff cache); map to front-window overlay 0-1 faint → 6+ bright + door paper-particle.
- **4.11 — Portal two-step (preview/active).** `D-R10`. Surface `portal-preview` (cool blue inner ring) vs `portal-active` (full stack + floating screen prop) from classifier (0.5).
- **4.12 — Observatory clock rotation when WebFetch.** `D-R7`. Rotate cached `_clockCanvas` by fraction of `frame` when active; reset to time mode when idle.
- **4.13 — Watchtower lookout sweep.** `D-R11`. Add slow gull orbit (`prop.gullFlight.*`) pegged ~(28,12), 30s loop. Two `prop.harborBeaconBuoy` on sea line.
- **4.14 — Team-colored sash trim.** `C-R3`. Second palette-swap pass in `Compositor._applyPaletteSwap` for trim accent when `agent.teamName` set, using `getTeamColor(teamName).accent`. Add `teamHash` to cache key.
- **4.15 — Archive fade on agent removal.** `C-R6`. Defer disposal 800ms; fade with sparkle puff; "FINAL" history bubble pinned 2s.
- **4.16 — Chronicle stone weight tiers.** `G-R9`. `monument.stone.{major,medium,minor}` sprite IDs. Hover popover replaces flat tooltip with repo flag + label + age + kind icon. Click opens side-panel with full commit message + GitHub SHA link.
- **4.17 — Repo heraldry shields.** `G-R5`. Replace pennant triangle on squad flagship with `prop.repoShield` hue-shifted at render via Compositor palette-swap path. Add bunting line between adjacent squad ships of same repo.

**Skip in Phase 4:** PR ceremony (`G-R6`) — depends on `gh` parser; treat as Phase 5 unless adapter scope expanded.

---

### Phase 5 — Maintainability and deferred

These are valuable but defer until Phases 0–3 are stable. Estimated 5–10 days, very cherry-pickable.

- **5.1 — Split `IsometricRenderer.js` along 3 stable seams.** `P-R13`. Extract `IsoTerrain.js`, `IsoGulls.js`, `IsoLightSources.js`. Pass `renderer` as context. Mechanical, large.
- **5.2 — Constrain `getWatchFallbackSignature` to active sessions.** `P-R12`. Cap scope to recently active per `sessionListCache`; cache per-dir signature 10s; skip directories with no mtime in 5min.
- **5.3 — WebSocket reconnect jitter.** `P-R10`. Cap at 15s, add 0-500ms jitter, reset `reconnectAttempts` on first `init` not on `onopen`.
- **5.4 — Coarse cache-stamp gate on broadcast signature.** `P-R11`. Skip signature SHA when cache stamps unchanged.
- **5.5 — Memoise `buildDockSquadLayout` for first-paint replay.** `G`-coord. Cache by `(ship ids hash, ship statuses)`. Lengthen unpushed-commit TTL cache (`gitEvents.js:46`) from 5s to 30s.
- **5.6 — Smoke test scripts under `scripts/smoke/`.** `P-R16`. `scripts/smoke/adapters.mjs` against fixture tree under `tmp/fixtures/claude/`; `scripts/smoke/relationship.mjs` against stub world. No new deps.
- **5.7 — Behavior simulation fixture.** `B-R10`. `__simfixture__/AgentSimulator.js` gated `?sim=1`. 6-12 fake agents with scriptable timelines. Bypasses adapter.
- **5.8 — Per-state idle pose rows (PixelLab regen).** `C-R5`. Extend `SpriteSheet` layout from 4 idle rows to `idle-default | idle-thinking | idle-bored`. Regenerate 12 character sheets at `92 × 18 = 1656px`. Credit-heavy. Defer unless explicit user buy-in.
- **5.9 — Document polling/cache cadence in `claudeville/CLAUDE.md`.** `P-R17`. New § "Polling and Cache Cadence" listing each constant and its role.
- **5.10 — PR open/merge/close.** `G-R6`. Sibling `findGhCommand` parser. PR open = signal flare to lighthouse; PR merge = Harbor Master door swap + green "MERGED" banner. Requires Harbor Master `open` door frame asset.
- **5.11 — Cancelled push status.** `G`-bugs. Distinguish "cancelled" from "failed" in `GitEventIdentity.normalizePushStatus`; greyed-out return-to-berth animation.
- **5.12 — Cleanup spike: dead `Appearance` fields.** `C` cleanup. After confirming `AvatarCanvas` legacy fallback is unreachable in current World mode, deprecate `Appearance.fromHash` consumers.
- **5.13 — Per-building presence smoothing.** `D-R5` optional new sprite (`prop.mineRailSegment`, `prop.portalPreviewScreen`) only if 4.10–4.11 ship and the art is justified.

---

## Cross-Domain Coordination Matrix

A condensed view of who unblocks whom:

| Phase 0 task | Unblocks |
| --- | --- |
| 0.3 adapter expansion | 3.1 (force), 3.2 (pull/fetch), 3.3 (rejected), 4.14 (team sash) |
| 0.4 status values | 1.3 (status emote), 2.10 (throttle), 4.15 (archive fade on COMPLETED) |
| 0.5 ToolIdentity | 2.8 (plan mode), 4.10 (Archive Read count), 4.11 (Portal preview/active), 4.12 (Observatory clock), 1.7 (Forge/Mine smoke gate) |
| 0.6 Portal ritual | 2.1, 2.2, 2.3, 2.4 (the entire Portal story) |
| 0.7 presence pulse | 1.6 (building windows/emitters), 1.7 (smoke), 1.8 (label accents), 4.10 |
| 0.8 `building:selected` | 4.9 (building-detail panel) |
| 0.9 RelationshipState cache | 2.4 (family tether at scale) |
| 0.10 LandmarkActivity O(1) | 4.10 (Archive Read counter) |
| 0.11 path-aware truncate | 1.12 (history dedup keeps clean labels) |

## Validation Mapping

Per `claudeville/CLAUDE.md` validation table:

- Adapter syntax: `find claudeville/adapters claudeville/services -name '*.js' -print0 | xargs -0 -n1 node --check`.
- API behavior: `npm run dev`; curl `/api/{providers,sessions,usage,perf}`; check browser console.
- Anything under `src/`: open `http://localhost:4000`, World ↔ Dashboard, agent select / deselect, content resize.
- Manifest edits: `npm run sprites:validate`; visual: `sprites:capture-fresh` → `sprites:visual-diff`.
- Widget: out of scope.
- Docs parity: `diff <(tail -n +3 CLAUDE.md) <(tail -n +3 AGENTS.md)` must be empty.

## Council Debate Notes

Each member's defended-three (from their research file) was:

- **VisualCurator:** R1 godrays · R5 phase-coupled water · R3 sprite rain.
- **BehaviorChoreographer:** R2 posture · R3 chat resolver (B1) · R8 path-aware truncate.
- **BuildingsDesigner:** R1+R3 presence pulse+windows · R8+R4+R12 scenery PR · R2 building click panel.
- **CharacterDesigner:** R1 baked accessories · R2 status emote · R4 compact name pill.
- **HarborEngineer:** R1+R4 force/rejected · R2 pull/fetch · R8 functional lighthouse.
- **PortalCodeHealth:** R2 portal spawn · R1 Task→portal · R8 RelationshipState cache.

**Convergent vote:** every member's top picks land in **Phase 0 or Phase 1**. The screenshot's three visible failure modes — bubble truncation, undifferentiated agents, teal-water-orange-sky — are all closed by Phase 1 tasks.

**Dissent / deferred:** CharacterDesigner-R5 (new idle pose rows via PixelLab) is deferred to Phase 5 because it costs credit and timeline; HarborEngineer-R6 (PR ceremony) is deferred to Phase 5 pending `gh` parser scope; PortalCodeHealth-R13 (split `IsometricRenderer.js`) is deferred because all current feature work fits in the current monolith and the user prioritized visible improvement.

## Risks

- **Phase 0 is load-bearing.** Skipping 0.3 strands force-push / rejected / inbound; skipping 0.6 leaves portal cosmetic; skipping 0.9 risks GC pressure with Phase 2.4 tether on. Treat Phase 0 as one delivery.
- **Status overdraw collision.** Phase 1 stacks status emote (1.3) + posture overlay (1.4) + ground ring desaturation (2.10) + selection halo + effort floor ring. Coordinate priority through PulsePolicy so error/throttle wins; specifies in 2.10.
- **Visit-tile collisions.** D-B3 (Command tiles overlap central isle basin at `scenery.js:170-178`) and D-B7 (`containsVisitPoint` missing on some entries) can silently break ritual + face-target work. Fold both into 2.7.
- **First-paint perf with history replay.** Many unpushed commits across many repos pump through `reduceHarborTrafficState` in tight loops. 5.5 memoises `buildDockSquadLayout`; if Phase 3 ships without 5.5, watch `/api/perf` `relaxIterations` counter.
- **Heuristic false positives.** B-R6 (error/retry detection via `lastMessage` regex) is loud when wrong. Phase 2.11 gates the heuristic behind a config flag; do not enable by default until Phase 5.6 smoke covers it.

## Plan ownership and next boundary

This plan is a roadmap, not an active assignment. Before any phase begins:

1. Re-run `git rev-parse HEAD` and compare to baseline (`e919f84`). If HEAD has moved, re-verify file:line refs in the affected phase against the new code.
2. Update `agents/README.md` artifact index with this plan and the six research files (status `reference` for research, `ready` for this plan).
3. Pick the phase to fund. Each phase is itself a candidate for a swarm — phase tasks list owners that map cleanly to the same six council members.
4. For multi-owner phases (every phase qualifies), dispatch one worker per `Owner` field; collect through a reviewer; integrate sequentially under `Shared` and `Behavior` tasks first.

## Recommended next task boundary

**Phase 0 in one swarm cycle.** Six members, one phase, ~5-7 days. After that cycle the world has every signal Phase 1+ needs; Phase 1 can run in a second swarm with full parallelism since each task owns a different file.
