# Feature Foundation — Implementation Plan
Generated: 2026-04-28
Source: synthesis of `agents/plans/{tool-rituals,familiars-and-council,chronicle}.md` plus `agents/plans/world-enhancement-plan.md` Tier-0 prereqs. References to existing items use `T0.x` / `#NN` (world-enhancement) and `TR-`/`FC-`/`CH-` (feature plans).

## Goal

Land the unified architectural foundation — already-planned Tier-0 items plus the new prereqs introduced by Tool Rituals (TR), Familiars & Council (FC), and Chronicle (CH) — so that every downstream feature plan can ship in parallel against a single, de-duplicated substrate. This plan is sequencing and synthesis; it does not author feature visuals.

## Non-goals

- Re-document Tier 0 of `world-enhancement-plan.md`. T0.1–T0.6, #36, #37 are cited by ID with consumer lists, not restated.
- Author any feature-plan visuals (rituals, familiars, council rings, manifests, monuments, trails, Chronicler, aurora). Those remain in their respective plans and read this foundation as a precondition.
- Add provider-side adapter functionality beyond what the three feature plans already require (the `teamName` gap from FC0.1 is the only adapter touch; everything else is read-only).
- Server-side persistence, new build-step, framework adoption, or new runtime dependencies. Per `docs/design-decisions.md` § "Dependency-free runtime, no build step" and § "Hand-written WebSocket framing".
- New domain events beyond a single optional `tool:invoked` (and FC's emitted `chronicle:milestone` / `chronicle:aurora`, which originate in the chronicle plan and are not foundation-owned). The optional `tool:invoked` debate is resolved here as a shared primitive — see § Shared-primitive proposals.
- Multi-instance per-building visitor accounting. Visitor count remains type-keyed (per `BuildingSprite._visitorCountByType`) and rituals/light-emitters inherit that constraint.

## Foundation inventory

Three groups. Group A items are already specified in `world-enhancement-plan.md`; here they get a consumer list and a sequencing constraint. Group B items are new and are described in full because no other plan owns them. Group C items are co-design artefacts where two or more feature plans touch the same surface and must be unified before either ships.

### A. World-enhancement prereqs (existing — cite by ID)

| Item | One-line restatement | Consumed by | Sequencing constraint |
| --- | --- | --- | --- |
| **T0.1** Cache `_drawAtmosphere` per-light radial gradient | Cache each emitter's gradient on `(x,y,radius,color,phaseBucket)`. | TR Sprint 2 (forge spark ring TR-2.1; #5 portal rune ring TR-3.3); FC Sprint 1 (F1 wisp dispatch); FC Sprint 4 (F14 departure sigil); CH Sprint E (E2 aurora stripe blends). Also gates world-plan #5/#17/#24. | Land before any consumer that draws a new emitter. Hard prereq for TR Sprint 2. |
| **T0.2** Unified `LightingState` per-frame snapshot | One struct (`sunDirIso`, `sunWarmth`, `ambientTint`, `shadowAngleRad`, `shadowLength`, `shadowAlpha`, `lightWarmth`, `lightBoost`, `beaconIntensity`) consumed everywhere. | TR Sprint 3 (TR-3.1 mine seam day/night tint), TR Sprint 5 (TR-5.1 lighthouse beam alpha); FC Sprint 1 (F3 mote alpha modulation), FC Sprint 2 (F7 council ring tint), FC Sprint 3 (F11 talk arc dimming), FC Sprint 4 (F14 departure sigil); CH Sprint D (D1 trail color band by `dayProgress`/`phase`), CH Sprint E (E2 aurora `beaconIntensity` modulation). | Hard prereq for TR Sprint 3, FC Sprint 1, all of CH except A/B/C. Already partially exists inside `AtmosphereState.js:312-348` as `lighting`; promotion is the shape work. |
| **T0.3** Formal `LightSourceRegistry` | Typed registry every glow-emitting subsystem reads from. | TR Sprint 2 (TR-2.1 spark ring transient entry), TR Sprint 3 (TR-3.3 portal boost), TR Sprint 5 (TR-5.1 beam tint via existing `LIGHT_SOURCE_REGISTRY.watchtower:92-105`); FC Sprint 1 (F3 motes registered as `kind: 'orbit'`), FC Sprint 2 (F7 council ring `kind: 'arc'`), FC Sprint 3 (F11 talk arcs `kind: 'arc'`), FC Sprint 4 (F14 departure sigil `kind: 'point'`); CH Sprint C (C3 monument soft glow), CH Sprint E (E2 aurora). | Hard prereq for TR Sprints 2/3/5, FC Sprints 1–4, CH Sprints C/E. See § Shared-primitive proposals — extension list. |
| **T0.4** HiDPI / `devicePixelRatio` threading | Canvas sized at `css*dpr`, top-level `ctx.scale(dpr,dpr)`, every offscreen cache allocated DPR-scaled. | CH Sprint D (D1 trail offscreen canvas); TR Sprint 1 procedural draws (small risk only — no offscreen); FC Sprint 1 (F3 motes are direct, no cache); FC Sprint 4 (F14 sigil — direct, no cache); CH Sprint E (E2 aurora paints into existing `SkyRenderer` which T0.4 will scale). | Hard prereq for CH Sprint D and any later cache. Land before D1 or D1 reallocates. Not needed by TR or FC Sprints 1–3. |
| **T0.5** Camera bounds + viewport tile-rect contract | Min/max clamp on drag; publish `Camera.getViewportTileBounds()`. | CH Sprint D (D1 trail polylines: skip agents whose entire trail is offscreen). FC Sprint 4 arrival ships do not need it (HarborTraffic owns its own viewport check). TR rituals are at known building tiles — no cull. | Hard prereq for CH Sprint D. Not blocking TR or FC. |
| **T0.6** Motion-budget policy + reduced-motion gate-list | Codify "every motion-bearing item checks `motionScale` BEFORE allocating motion resources" + declare which motion bands carry meaning. | Every motion-bearing item in TR (forge hammer-burst, archive flip, mine pickaxe swing, observatory sweep, portal mirror fade, taskboard flutter, carrier-bird, beam rotation), every motion-bearing item in FC (wisp dispatch F1, re-merge F2, motes F3, council ring shimmer F7, talk-arc shimmer F11, arrival animations F13, departure sigil F14), and every motion-bearing item in CH (Chronicler walk D2, aurora animation E2, plank "drop" B3). | Hard prereq for **all three feature plans** before any motion-bearing item ships. Already partially honored by `ParticleSystem`, `SkyRenderer.driftEnabled`, water shimmer; the policy work codifies the rule. |
| **#36** Pulse-cue ownership policy | Assign canonical owner per pulse rate band (slow/medium/fast/static). | TR Sprint 2+ (TR claims 7 pulse-bearing rituals — see § Cross-plan coordination § Pulse-cue band scheme), FC Sprint 3 (F11 talk-arc shimmer — flagged in FC plan as a potential collision), CH Sprint C (C3 monument freshness — explicitly forbidden from pulsing per the chronicle plan). | Hard prereq for TR Sprints 2–5 and FC Sprint 3. Land before any new pulse. See § Shared-primitive proposals — expanded band scheme. |
| **#37** Empty-state world visual | Ambient activity always visible at zero/one agent. | FC Sprint 3 (F12 ghost-arc plaza→portal explicitly extends `_drawEmptyStateWorldCue`); CH Sprint D (D2 Chronicler NPC explicitly replaces the placeholder ellipse in the same method). The FC and CH proposals are two halves of the same surface — see § Cross-plan coordination § Unified empty-state. | Hard prereq for FC Sprint 3 (F12) and CH Sprint D (D2). Co-designed, not picked twice. |

### B. New prereqs introduced by feature plans

These are new modules, fields, or rules introduced by exactly one feature plan but consumed (or potentially consumed) by another. Each is described in full so the foundation sprint can implement it without re-reading the source plan.

#### B.1 — TR0.1 Tool-event observer — **SUBSUMED by S.1 `AgentEventStream`**
**Domain:** Application/Presentation · **File:** *(no standalone file ships — see S.1)* · **Effort:** S (folded into S.1) · **Impact:** Medium · **Source:** `tool-rituals.md` § "Architectural prerequisites" → TR0.1.

Original proposal: a standalone observer subscribed to `agent:updated`, maintaining `Map<agentId, { tool, input, sessionActivity }>`, diffing `(currentTool, currentToolInput, lastSessionActivity)` per event, and emitting a synthetic `tool:invoked { agentId, tool, input, ts, building }`. Reset on `agent:removed`. Client-side because the read-only adapter contract (`docs/design-decisions.md` § "Read-only adapter contract") rules out adapter changes; cost is identical-input coalescing — a known, tolerated false-negative.

**Decision (user-confirmed):** this responsibility is folded into the unified `AgentEventStream` (S.1). The `tool:invoked` event shape, the snapshot-diff key tuple, and the reset-on-removal rule are preserved verbatim — they just live alongside `subagent:dispatched`/`subagent:completed`/`team:joined`/`chat:started`/`chat:ended` in one module rather than in a separate `ToolEventObserver.js` file.

**Consumed by:** TR `RitualConductor` (B.2) subscribes to `tool:invoked`. No separate file ships.

**Depends on:** none. Pure subscriber. (Implementation lives inside S.1.)

#### B.2 — TR0.2 RitualConductor (with concurrency cap)
**Domain:** Presentation · **File:** new `src/presentation/character-mode/RitualConductor.js` · **Effort:** S · **Impact:** Medium · **Source:** `tool-rituals.md` § TR0.2.

Per-frame scheduler holding in-flight rituals (state machine: pending → playing → fading → done). Caps `MAX_CONCURRENT_RITUALS = 6`, coalesces same-(building, tool) within 250 ms, exposes `getActiveRitualsForBuilding(type)` for `BuildingSprite._drawFunctionalOverlay`. Reduced-motion still ticks the state machine but skips motion-bearing phases.

**Consumed by:** TR Sprints 2–5 only.

**Depends on:** the unified `AgentEventStream` (S.1, decided). The standalone B.1 `ToolEventObserver` is subsumed; `RitualConductor` subscribes directly to `AgentEventStream`'s `tool:invoked` emissions.

**Cross-plan question:** the chronicle plan's animation surfaces (D2 Chronicler walk, E2 aurora 12s lifecycle, B3 plank "drop") are also stateful per-frame schedulers. See § Shared-primitive proposals — `WorldScheduler` recommendation (REJECTED, with rationale).

#### B.3 — FC0.1 Populate `teamName` on Claude session payloads
**Domain:** Adapters · **File:** `claudeville/adapters/claude.js:395-410, 468-489, 532-552` · **Effort:** S · **Impact:** High · **Source:** `familiars-and-council.md` § FC0.1.

`Agent.js:94, 123` reads `teamName` from the payload but no adapter sets it today. Confirmed by re-reading the three adapters:

- **`claude.js`**: `getTeams()` at line 615 reads `~/.claude/teams/<name>/config.json` and yields `{ teamName, ...config }`, but `_getOrphanSessions:498-552` (which classifies team-member sessions) does not cross-reference. Lines 532-552 emit `agentType: 'team-member'` without a `teamName` field.
- **`codex.js`**: rollout-jsonl carries `parent_thread_id` (used at lines 702-705) and `agent_nickname` (line 127), but has **no team or workspace concept**. Confirmed by `grep -n -E "team|workspace" codex.js` returning nothing relevant. **Fix:** none — codex sessions remain `teamName: null` and degrade per the FC documented degradation matrix.
- **`gemini.js`**: same — only "workspace" appearance is in `commonDirs` (line 55, an unrelated path heuristic). **Fix:** none — gemini sessions remain `teamName: null` and degrade.

**On-disk schema (resolved by direct inspection of `~/.claude/teams/`):** the team layout is NOT a roster file. Each team is a directory whose name IS the team identifier (a UUID such as `252e1add-0723-4556-a088-7e5d8f01c097`, or the literal string `default`). Inside each team directory there is ONLY an `inboxes/` subdirectory containing `<agentName>.json` files (e.g. `lead.json`, `orchestrator.json`, `claude.json`, `me.json`, `top25-researcher-agent.json`, `phase-3-subagent.json`). Each inbox file is an array of `{from, text, summary?, timestamp, read}` messages; `from` references another agent's name. There is no `team.json`, no `metadata.json`, no member roster file. **Membership is implicit in the inbox filenames.**

**Resolution strategy for `claude.js`:**
1. Build a `Map<agentName, teamId>` once per scan by walking `~/.claude/teams/<teamId>/inboxes/` and treating each `<x>.json` filename's basename `<x>` as a member identifier.
2. During session normalization (in `_getOrphanSessions:498-552` and the main-session path at lines 395-410, since `agentName` is now populated for both — see `claude.js:472-474, 537`), set `Agent.teamName = teamId` when the agent's `agentName` matches an inbox filename under that team's `inboxes/` directory.
3. **Display rule:** the team identifier is the directory name verbatim. UUID-shaped ids are rendered as a 6-char prefix in UI surfaces (e.g. `252e1a`); the literal `default` stays `default`. This is a UI concern, not an adapter concern — `Agent.teamName` carries the full id; UI consumers (FC F9 sidebar dot, F7 council ring tooltip) do the prefix collapse.
4. **Collision rule:** if a single `agentName` appears under multiple teams' `inboxes/`, last-write-wins. Surface the collision once per scan as a `console.warn('[claude adapter] agentName "<x>" appears in multiple teams: ...')` so the user notices but the runtime stays deterministic. Do NOT add a roster file or migrate the on-disk schema — work with what exists.
5. Codex/Gemini: unchanged. `teamName` stays `null`. FC council circle silently skips those agents (already the documented degradation).

**Unified shape:** `agent.teamName` is the single source of truth read by FC's `RelationshipState.teamToMembers` (B.4). Codex/Gemini agents fall through to the FC documented per-provider degradation matrix.

**Consumed by:** FC Sprint 2 (F7 council ring), FC Sprint 2 (F9 sidebar team-color dot). Indirectly by FC0.3 (TeamColor resolver requires `teamName` to be a string before it produces colors).

**Depends on:** none (schema resolved — see Open question 1 below, RESOLVED).

#### B.4 — FC0.2 RelationshipState per-frame snapshot
**Domain:** World renderer · **File:** new `src/presentation/character-mode/RelationshipState.js` · **Effort:** S · **Impact:** High · **Source:** `familiars-and-council.md` § FC0.2.

Once-per-frame derivation built in `IsometricRenderer._update` after the existing chat-matching block (line 1156–1170 in the FC plan; current `_updateChatMatching` invocation site is `IsometricRenderer.js:1091`). Output:

```text
RelationshipState {
  parentToChildren: Map<parentSessionId, Set<agentId>>,
  childToParent:    Map<agentId, parentSessionId>,
  teamToMembers:    Map<teamName, Array<agentId>>,
  recentArrivals:   Array<{ agentId, sinceMs }>,         // last 8 s
  recentDepartures: Array<{ lastTile, sinceMs }>,        // last 12 s
  chatPairs:        Array<{ aId, bId }>,                 // dedupes existing AgentSprite.chatPartner
}
```

Rebuilt only when membership changes (debounced on `agent:added`/`agent:updated`/`agent:removed`).

**Consumed by:** FC Sprint 1 (F1 dispatch detection — diffs `parentToChildren` deltas), F3 (motes), F5 (selection mote brightening); FC Sprint 2 (F7 council ring); FC Sprint 3 (F11 chat arcs); FC Sprint 4 (F13 arrivals routing, F14 departure sigil).

**Cross-plan note:** the FC plan describes `recentArrivals`/`recentDepartures` with explicit time windows. CH Sprint D's `TrailRenderer` has a separate per-second sample stream. They do **not** share state — FC tracks short-term presence; CH tracks long-term position history. Keep separate.

**Depends on:** B.3 (`teamName` field on Claude payloads) for `teamToMembers` to be populated; chat-pair extraction has no new dependency (already wired via `AgentSprite.chatPartner` at `AgentSprite.js:96`).

#### B.5 — FC0.3 TeamColor resolver
**Domain:** Theme · **File:** new `src/presentation/shared/TeamColor.js` · **Effort:** S · **Impact:** Medium · **Source:** `familiars-and-council.md` § FC0.3.

Deterministic hash → palette. Reuses `Sidebar.js:9-12`'s `PROJECT_COLORS` array (10 colors). Returns `{ accent, glow, panel }` triplets matching the harbor `REPO_PALETTES` shape (`HarborTraffic.js:43-52`) so council rings, sidebar dots, and any future team badge share lookups. No additions to `palettes.yaml` for this plan.

**Consumed by:** FC Sprint 2 (F7, F9). No CH or TR consumer.

**Depends on:** B.3 for the input string to be populated.

#### B.6 — CH0.1 IndexedDB persistence layer (`ChronicleStore`)
**Domain:** Infrastructure · **File:** new `src/infrastructure/ChronicleStore.js` · **Effort:** L · **Impact:** High · **Source:** `chronicle.md` § CH0.1.

Single ES-module wrapper around `window.indexedDB`. Database `claudeville-chronicle`, schema v1 with stores `manifests`, `monuments`, `trailSamples`, `auroraLog`, `meta`. API: `open`, `put`, `bulkPut`, `get`, `deleteKey`, `queryRange`, `deleteRange`, `count`, `prune(now)`, `acquireCaptureLease()` (BroadcastChannel-backed). Eviction window: 24h manifests / 30d monuments / 24h trail samples; pinned manifests survive 7d.

**Persistence boundary audit (per the brief):** I confirmed by re-reading TR and FC plans:
- TR plan (`tool-rituals.md`) — § Non-goals explicitly: "No new persistent agent state". All ritual entities are ephemeral state in `RitualConductor`. **No persistence sneaks in.**
- FC plan (`familiars-and-council.md`) — § Non-goals: "No backend changes". `RelationshipState` is rebuilt per frame. Departure sigil is in-memory FIFO (cap 6, 12 s lifetime). **No persistence sneaks in.**
- CH plan — owns all persistence and explicitly so.

**Therefore CH0.1 is the sole new persistence layer.** Foundation plan does not change that boundary.

**Consumed by:** CH Sprints A, B, C, D, E. Not consumed by TR or FC.

**Depends on:** none — only browser built-ins.

#### B.7 — CH0.2 Monument detection rules
**Domain:** Application · **File:** new `src/application/MonumentRules.js` · **Effort:** S · **Impact:** Medium · **Source:** `chronicle.md` § CH0.2.

Pure module classifying git events into `{ kind, district, weight, label, dedupKey } | null`. Rule set v1: release stones (tag pushes), feature stones (conventional-commit prefixes routed to district), verified stones (commit + verify within 90s, gated by feature flag). Per-district cap of 6, with 7th triggering "Founding Layer" upgrade.

**Explicit exclusion (TR/CH boundary):** token-cap rollovers (5h or 7d quota stepping down) are OUT of scope for monuments. The TR Mine ritual (TR-3.1 mine pickaxe swing + seam tint) owns the token-rollover visual. `MonumentRules.classify` MUST NOT emit a monument record for any `usage:updated` event or any synthetic token-delta signal. The classifier accepts git events only — commits, pushes, tags, PR merges, and (gated) test-run summaries. Document this in the module header so future contributors do not re-introduce a "quota stone" rule.

**Consumed by:** CH Sprint C only.

**Depends on:** B.6.

#### B.8 — CH0.3 Trail capture & overlay canvas (`TrailRenderer`)
**Domain:** World render · **File:** new `src/presentation/character-mode/TrailRenderer.js` · **Effort:** M · **Impact:** Medium · **Source:** `chronicle.md` § CH0.3.

Two-phase: capture at 1 Hz (lease-gated by B.6's `acquireCaptureLease()`), render at low cadence (every 2s) into an offscreen canvas sized at `viewport.width × viewport.height × dpr` (T0.4). Repaints on data change, camera move > 4 px or 0.05 zoom step, or selected-agent change. Reuses `Camera.getViewportTileBounds()` (T0.5) for offscreen culling.

**Consumed by:** CH Sprint D only.

**Depends on:** B.6, T0.4, T0.5, T0.6.

#### B.9 — CH0.4 Privacy redaction toggle
**Domain:** Application · **File:** new `src/application/Settings.js` extension; UI surface in `src/presentation/shared/TopBar.js` · **Effort:** S · **Impact:** Low · **Source:** `chronicle.md` § CH0.4.

Boolean stored in `localStorage`. When on, plank labels and monument tooltips render as `[redacted commit]`/`[redacted release]`. Underlying records unchanged.

**Consumed by:** CH Sprints B, C only.

**Depends on:** none.

### C. Cross-plan coordination items

These are surfaces where two or more feature plans propose subtly different shapes for the same underlying mechanism. The foundation plan resolves them so the feature plans can reference one canonical answer.

#### C.1 — Pulse-cue band scheme (extends #36) — **DECIDED (bands frozen; priority deferred to visual iteration)**
The original `world-enhancement-plan.md` #36 sketches four bands (slow/medium/fast/static). TR claims 7 motion-bearing rituals; FC claims 4 relationship visuals; CH claims 1 NPC walk + 1 aurora animation. The four-band scheme is preserved. **Conflict-resolution priority is deliberately NOT hardcoded in foundation** — user direction is "whichever looks best". See § Shared-primitive proposals — S.3 for the decided iteration policy (browser visual A/B with a `?pulsePriority=...` runtime toggle, plus a `getPulsePriority()` hook in foundation).

#### C.2 — Unified empty-state surface (extends #37)
FC Sprint 3 (F12) and CH Sprint D (D2) both extend `IsometricRenderer._drawEmptyStateWorldCue` (`IsometricRenderer.js:3810-3834`). FC adds a ghost-arc plaza→portal; CH replaces the placeholder ellipse with a Chronicler NPC. They are NOT alternatives — they are two halves of one scene. See § Shared-primitive proposals — Unified empty-state surface.

#### C.3 — `LightSourceRegistry` extension list
T0.3 currently sketches `getLightSources()` for static building emitters (forge hearth, brazier, lantern, watchtower beacon, lighthouse beam, portal gate, mine mouth — see `BuildingSprite.js:85-105`). The three feature plans collectively introduce 11 new emitter shapes. T0.3's interface needs widening to absorb them. See § Shared-primitive proposals — LightSourceRegistry extensions.

#### C.4 — Single tool/relationship event stream (consolidates TR0.1) — **DECIDED**
Both TR (TR0.1: `tool:invoked` from `agent:updated` diff) and FC (FC0.2: subagent-dispatch detection from `parentToChildren` delta) are client-side observers of `agent:updated`. **Decision (user-confirmed):** ship the `AgentEventStream` consolidation as the single primitive. TR `RitualConductor` subscribes for `tool:invoked`; FC F1/F2 subscribe for `subagent:dispatched`/`subagent:completed`; FC F11 chat-pair extraction subscribes for `chat:started`/`chat:ended`; FC F7/F9 subscribe for `team:joined`. This replaces TR0.1 (`ToolEventObserver`) as a standalone module — there is no longer a two-observer fallback. See § Shared-primitive proposals — `AgentEventStream` (now decided).

#### C.5 — DPR-scaled offscreen-cache list (extends T0.4)
T0.4 already lists existing caches (atmosphere vignette `IsometricRenderer.js:3666`, sky background `SkyRenderer.js:113`). The three feature plans add the following new offscreen caches:

- **CH:** `TrailRenderer` overlay canvas (B.8) — sized at `viewport × dpr`, repainted every 2s.
- **TR:** spark-ring gradient cache (folded into T0.1, not a new cache).
- **TR:** rune-ring gradient cache (folded into T0.1).
- **TR:** carrier-bird path: NO new cache (direct draw).
- **TR:** observatory star-arc: NO new cache (8 particles direct).
- **FC:** mote rendering: NO new cache (vector direct).
- **FC:** council polyline: NO new cache.
- **FC:** talk arc: NO new cache.
- **FC:** departure sigil: NO new cache (single light registry entry).
- **CH:** Chronicler walk: NO new cache (sprite blits direct).
- **CH:** aurora: paints into existing `SkyRenderer` after `_drawClouds` (CH plan E2). Re-uses the existing `SkyRenderer` cache surface, which T0.4 already gates.

**Audit conclusion:** the only NEW offscreen cache introduced by the three plans is **CH B.8 trail overlay**. T0.4 must land before B.8 is implemented. No other allocation needs new T0.4 work.

## Sprint plan

Five foundation sprints, ordered strictly by dependency. Each ends with a verifiable milestone. Items list **Domain · File:line · Effort · Impact · Depends on**.

### Foundation Sprint 1 — Validation prerequisites (zero risk, immediately useful)

**1.1 — T0.6 motion-budget policy + reduced-motion gate-list.**
**Domain:** All · **File:** `claudeville/CLAUDE.md` (or a new `docs/motion-budget.md`); cross-link from `character-mode/README.md`. · **Effort:** S · **Impact:** Medium (gate for every motion-bearing item across all three plans) · **Depends on:** none.

Document: every new motion-bearing item must (1) check `this.motionScale` BEFORE allocating animation state, (2) declare which pulse band it claims (slow/medium/fast/static), (3) ship a static fallback that does not allocate. Add the per-band ownership table (see § Shared-primitive proposals).

**Verify:** code-side check is non-trivial, but the policy doc lives in the repo and all three feature plans cite it. Smoke: `git status --short` clean; English-only doc.

**1.2 — #36 pulse-cue band scheme (expanded).**
**Domain:** All · **File:** same doc as 1.1 · **Effort:** S · **Impact:** Medium · **Depends on:** 1.1.

Codify the table in § Shared-primitive proposals — Expanded pulse-cue band scheme. Land before any item in TR Sprint 2+, FC Sprint 3, CH Sprint C.

**1.3 — T0.5 Camera bounds + viewport tile-rect contract.**
**Domain:** Camera · **File:** `Camera.js:82-88, 119+` · **Effort:** S · **Impact:** Medium · **Depends on:** none.

Per `world-enhancement-plan.md` T0.5: clamp drag in `_onMouseMove`; publish `Camera.getViewportTileBounds()`. Already named in the world plan; foundation plan only flags the consumer list (CH Sprint D Trail culling).

**Verify:** drag clamp prevents black-void state; `getViewportTileBounds()` returns sane min/max tile rect at zoom 1, 1.5, 2, 3.

**Sprint 1 milestone:** policy is checked into repo; viewport tile-rect contract is callable. No visual change. Smoke: `npm run dev`; pan to extremes; confirm no black void.

### Foundation Sprint 2 — Lighting plumbing (TR + FC + CH all unblocked at the lighting layer)

**2.1 — T0.2 LightingState promotion.**
**Domain:** Atmosphere · **File:** `AtmosphereState.js:312-348` (existing `lighting` block); promote into a struct consumed by every lighting-aware subsystem. Update `BuildingSprite.setLightingState` (`BuildingSprite.js:151`), `IsometricRenderer` per-frame setter, and any future emitter consumer. · **Effort:** M · **Impact:** High · **Depends on:** none.

Already partially constructed. The work is shape and consumer-list extension (see § Shared-primitive proposals — LightingState contract).

**2.2 — T0.3 LightSourceRegistry promotion + extension.**
**Domain:** Atmosphere/Buildings · **File:** promoted from `BuildingSprite.getLightSources()` (`BuildingSprite.js:748-762`) and `LIGHT_SOURCE_REGISTRY` (`BuildingSprite.js:92-105`); resolve the `splitPass === 'back'` early-return at line 861 that silently skips manifest light layers (root cause behind world-plan #5). · **Effort:** M · **Impact:** Medium-High · **Depends on:** 2.1.

Widen `kind` enum to include **`spark`** (transient, additive, used by TR-2.1 forge ring), **`orbit`** (FC F3 motes — small radial halo following parent), **`arc`** (FC F11 talk arc + F7 council polyline; TR-3.2 observatory star-arc), and the existing **`beam`**, **`point`**. Each entry now carries a TTL when `kind` is transient, and an optional `endpoint` array when `kind === 'arc'`. Day/night gating via `LightingState.lightBoost` is applied uniformly.

See § Shared-primitive proposals — LightSourceRegistry extensions for the full schema.

**2.3 — T0.1 Cache `_drawAtmosphere` per-light radial-gradient loop.**
**Domain:** Atmosphere · **File:** `IsometricRenderer.js` `_drawAtmosphere` (the per-light loop is the cited 3641–3654 range in the original world plan; current line numbers may have shifted post-weather/atmosphere plan landings — locate by pattern match against `getLightSources()` consumer in `_drawAtmosphere`) · **Effort:** S · **Impact:** High · **Depends on:** 2.2.

Cache each emitter's gradient on `(x, y, radius, color, phaseBucket)`. Gates every transient emitter introduced by TR/FC/CH (forge spark ring, talk arc, departure sigil, etc.).

**Sprint 2 milestone:** existing emitters render through the new registry and pull from cached gradients. No visible change beyond a per-frame profile improvement. Smoke: `npm run dev`; visually identical to today; profile shows reduction in radial-gradient allocations.

### Foundation Sprint 3 — DPR + offscreen-cache foundation (gates CH only)

**3.1 — T0.4 HiDPI/devicePixelRatio threading.**
**Domain:** Camera · **File:** `App.js:213-219`, `Camera.js`, `IsometricRenderer.js` (canvas resize path); audit `Camera._onMouseMove`, `Camera._onWheel`, `IsometricRenderer._onClick` event-coordinate paths; thread into existing offscreen caches (`_getAtmosphereVignette`, `SkyRenderer._getCachedBackground`). · **Effort:** M · **Impact:** High · **Depends on:** 2.1 (so the `LightingState` consumers don't re-allocate caches at the wrong size).

Per `world-enhancement-plan.md` T0.4. Land **before** any new offscreen cache (only CH B.8 introduces one in this scope).

**Verify:** Retina/4K browser test — sprites and labels render crisp; mouse-coordinate paths still resolve correctly to world tiles.

**Sprint 3 milestone:** CH Sprint D unblocked. TR and FC do not depend on this; can ship in parallel against Sprint 2 output. Smoke: open at 100% / 150% / 200% browser zoom; sprite anchor and click hit-test still aligned.

### Foundation Sprint 4 — Domain wiring (`teamName`, RelationshipState, AgentEventStream)

**4.1 — B.3 (FC0.1) Populate `teamName` on Claude payloads.**
**Domain:** Adapters · **File:** `claudeville/adapters/claude.js:498-552` (`_getOrphanSessions`) and the main-session normalization at `claude.js:395-410`; new helper that walks `~/.claude/teams/<teamId>/inboxes/` and builds a `Map<agentName, teamId>` per scan. · **Effort:** S · **Impact:** High · **Depends on:** none, but blocks FC Sprint 2.

Per the resolved schema in B.3 above: team identity is the directory name (UUID or `default`); membership is encoded by inbox filenames (`<agentName>.json`). Match against `Agent.agentName` (already populated by `claude.js:472-474, 537`); last-write-wins on collision with a single `console.warn` per scan. Codex/Gemini remain `teamName: null`.

**Verify:** `curl http://localhost:4000/api/sessions` shows `teamName` populated for any team-member session whose `agentName` appears as an inbox filename. Codex/Gemini sessions remain `teamName: null`. With two teams sharing one `agentName`, the warning fires once per scan.

**4.2 — Shared `AgentEventStream` (decided primitive, consolidates TR0.1 and FC0.2 dispatch detection).**
**Domain:** Application/Presentation · **File:** new `src/presentation/character-mode/AgentEventStream.js` · **Effort:** S · **Impact:** Medium · **Depends on:** none.

See § Shared-primitive proposals — `AgentEventStream` (now decided). Single client-side observer subscribed to `agent:added`/`agent:updated`/`agent:removed`. Maintains `Map<agentId, snapshot>`. Emits `tool:invoked`, `subagent:dispatched`, `subagent:completed`, `team:joined`, `chat:started`, `chat:ended`. Consumed by TR's `RitualConductor` (B.2), FC's F1 dispatch detection, FC's F2 re-merge, FC's F7/F9 team-join, and the FC chat-pair extraction in `RelationshipState` (B.4). B.1's standalone `ToolEventObserver` does not ship as a separate file.

**4.3 — B.4 (FC0.2) RelationshipState per-frame snapshot.**
**Domain:** World renderer · **File:** new `src/presentation/character-mode/RelationshipState.js` · **Effort:** S · **Impact:** High · **Depends on:** 4.1, 4.2.

Build the struct described in § B.4 above. Mount in `IsometricRenderer._update`. Consume `AgentEventStream` for dispatch/departure event timestamps; rebuild membership maps on `agent:*` event burst (debounced).

**4.4 — B.5 (FC0.3) TeamColor resolver.**
**Domain:** Theme · **File:** new `src/presentation/shared/TeamColor.js` · **Effort:** S · **Impact:** Medium · **Depends on:** 4.1.

Hash → palette per § B.5 above.

**Sprint 4 milestone:** all FC Sprint 1–4 prereqs and all TR Sprint 1 prereqs are satisfied. Smoke: open the dashboard with at least one team-member session; verify `teamName` is on the Agent; verify `RelationshipState.teamToMembers` returns the expected list (visible via a temporary console log gate). No visual change yet.

### Foundation Sprint 5 — Persistence + co-design surfaces

**5.1 — B.6 (CH0.1) IndexedDB persistence layer.**
**Domain:** Infrastructure · **File:** new `src/infrastructure/ChronicleStore.js`; boot wiring in `App.js:32-50`. · **Effort:** L · **Impact:** High · **Depends on:** none.

Implement schema v1 with `manifests`, `monuments`, `trailSamples`, `auroraLog`, `meta` stores. API surface as listed in B.6 above. BroadcastChannel-backed lease (CH plan A2). Periodic prune (CH plan A3). All from `chronicle.md` § CH0.1.

**5.2 — Unified empty-state surface (#37 + FC F12 + CH D2 co-design).**
**Domain:** World renderer · **File:** `IsometricRenderer.js:3810-3834` (`_drawEmptyStateWorldCue`) · **Effort:** S · **Impact:** Medium · **Depends on:** 1.1 (motion budget).

Replace the placeholder ellipse with a single coherent empty-state scene that absorbs both feature-plan extensions. See § Shared-primitive proposals — Unified empty-state surface for the agreed scene grammar. Land here so neither FC F12 nor CH D2 has to revisit when their sprint ships.

**5.3 — B.7 (CH0.2) Monument rules pure module.**
**Domain:** Application · **File:** new `src/application/MonumentRules.js` · **Effort:** S · **Impact:** Medium · **Depends on:** 5.1.

Per `chronicle.md` § CH0.2. Pure classification; no rendering.

**5.4 — B.9 (CH0.4) Privacy redaction toggle.**
**Domain:** Application · **File:** `src/application/Settings.js` extension; `TopBar.js` UI · **Effort:** S · **Impact:** Low · **Depends on:** none.

Per `chronicle.md` § CH0.4. Off by default.

**Sprint 5 milestone:** CH Sprints B–E all unblocked. The empty-state surface is co-designed and ready for FC Sprint 3 and CH Sprint D to plug into. Smoke: persistence round-trip via DevTools `await window.__chronicle.put(...)` / `.get(...)`; second-tab BroadcastChannel test (only one tab logs lease acquisition); empty-state scene renders Chronicler walking + ghost-arc plaza→portal at zero agents.

## Feature-unlock matrix

Rows are foundation items (existing-cited and new). Columns are downstream feature-plan sprints. Cell content: a foundation sprint number (FS#) means "this row is in that foundation sprint" — when FS# ships, that column becomes unblocked. Mark `—` for "not required by this column".

| Foundation item | TR-S1 | TR-S2 | TR-S3 | TR-S4 | TR-S5 | FC-S1 | FC-S2 | FC-S3 | FC-S4 | CH-A | CH-B | CH-C | CH-D | CH-E |
| --- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| T0.1 (gradient cache) — FS2 | — | FS2 | FS2 | — | — | FS2 | — | FS2 | FS2 | — | — | — | — | FS2 |
| T0.2 (LightingState) — FS2 | — | — | FS2 | — | FS2 | FS2 | FS2 | FS2 | FS2 | — | — | FS2 | FS2 | FS2 |
| T0.3 (LightSourceRegistry) — FS2 | — | FS2 | FS2 | FS2 | FS2 | FS2 | FS2 | FS2 | FS2 | — | — | FS2 | — | FS2 |
| T0.4 (HiDPI) — FS3 | — | — | — | — | — | — | — | — | — | — | — | — | FS3 | — |
| T0.5 (Camera bounds) — FS1 | — | — | — | — | — | — | — | — | — | — | — | — | FS1 | — |
| T0.6 (motion budget) — FS1 | FS1 | FS1 | FS1 | FS1 | FS1 | FS1 | FS1 | FS1 | FS1 | — | FS1 | FS1 | FS1 | FS1 |
| #36 (pulse-cue bands) — FS1 | — | FS1 | FS1 | FS1 | FS1 | — | — | FS1 | — | — | — | FS1 | — | — |
| #37 / unified empty-state — FS5 | — | — | — | — | — | — | — | FS5 | — | — | — | — | FS5 | — |
| AgentEventStream (B.1 subsumed) + B.2 RitualConductor — FS4 | FS4 | FS4 | FS4 | FS4 | FS4 | FS4 | FS4 | FS4 | FS4 | — | — | — | — | — |
| B.3 (`teamName`) — FS4 | — | — | — | — | — | — | FS4 | — | — | — | — | — | — | — |
| B.4 (RelationshipState) — FS4 | — | — | — | — | — | FS4 | FS4 | FS4 | FS4 | — | — | — | — | — |
| B.5 (TeamColor) — FS4 | — | — | — | — | — | — | FS4 | — | — | — | — | — | — | — |
| B.6 (ChronicleStore) — FS5 | — | — | — | — | — | — | — | — | — | FS5 | FS5 | FS5 | FS5 | FS5 |
| B.7 (MonumentRules) — FS5 | — | — | — | — | — | — | — | — | — | — | — | FS5 | — | — |
| B.8 (TrailRenderer prereqs in T0.4/T0.5/T0.6) — FS3 | — | — | — | — | — | — | — | — | — | — | — | — | FS3 | — |
| B.9 (privacy toggle) — FS5 | — | — | — | — | — | — | — | — | — | — | FS5 | FS5 | — | — |

Reading the matrix: ship Foundation Sprints 1+2 → unblocks **TR Sprints 2/3/4/5, FC Sprint 1, FC Sprint 3 (modulo unified empty-state in FS5)**. Add Sprint 4 → unblocks all FC sprints and TR Sprint 1. Add Sprint 5 → unblocks all CH sprints. Sprint 3 (HiDPI) is independent of TR/FC and can run in parallel; only CH Sprint D blocks on it.

## Shared-primitive proposals

### S.1 — `AgentEventStream` (consolidates TR0.1 and FC dispatch/departure observers) — **DECIDED**

**The duplication:** TR0.1 watches `agent:updated` to diff `(currentTool, currentToolInput, lastSessionActivity)` per agent. FC F1 watches `agent:added` for new children of an existing parent. FC F2 watches `agent:removed` for children of an existing parent. FC F11 reads `chatPartner` already wired in `AgentSprite`. CH does not subscribe to per-agent diffs — it reads `agent.position` directly and stores in `trailSamples`.

**Decision (user-confirmed):** one observer `AgentEventStream` (under `src/presentation/character-mode/`), subscribed once to the existing `agent:added`/`agent:updated`/`agent:removed` events. Maintains `Map<agentId, { tool, input, sessionActivity, parentId, teamName, chatPartnerId }>`. Emits derived semantic events:

| Event | Payload | Emitted when | Consumer |
| --- | --- | --- | --- |
| `tool:invoked` | `{ agentId, tool, input, ts, building }` | snapshot diff in `(currentTool, currentToolInput, lastSessionActivity)` | TR `RitualConductor` |
| `subagent:dispatched` | `{ parentId, childId, ts }` | `agent:added` where `parentId` is in `world.agents` | FC F1 wisp dispatch |
| `subagent:completed` | `{ parentId, childId, lastTile, ts }` | `agent:removed` where `parentId` is still in `world.agents` | FC F2 re-merge |
| `team:joined` | `{ agentId, teamName, ts }` | `agent:updated` where `teamName` first becomes non-null | FC F7/F9 (debounced) |
| `chat:started`/`chat:ended` | `{ aId, bId, ts }` | mirrors `AgentSprite.chatPartner` transitions | FC F11; potentially CH for future "conversation manifest" |

Same Map snapshot, multiple emitters. Replaces TR0.1 (`ToolEventObserver`) and the in-line FC parent-delta watcher in F1. **B.1 in the foundation inventory is now subsumed by this decision** — the standalone `ToolEventObserver` file does not ship; its responsibilities migrate into `AgentEventStream`.

**Why one stream:** every consumer is already iterating `agent:updated` or rebuilding `RelationshipState`. One module owns the diff state; consumers subscribe per emitted event. Avoids three modules each maintaining a parallel `Map<agentId, snapshot>`.

**Why not server-side / domain events:** would require adapter or `World.js` changes. Adapter changes break the read-only contract. `World.js` is pure domain (per `docs/design-decisions.md` § "Domain layer must not import from presentation") and these are presentation-layer derivations. Stays in `presentation/character-mode/`.

### S.2 — `WorldScheduler` (TR0.2 + CH animation loops) — **REJECTED**

**The duplication:** TR0.2 holds in-flight rituals with TTL (3-strike forge burst, 600ms archive flip, 900ms telescope sweep, 1.6s carrier-bird). CH D2 has a Chronicler walking a Hamiltonian loop. CH B3 animates a plank "drop". CH E2 has a 12s aurora lifecycle.

**Why not unified:** the schedules are too dissimilar.
- TR rituals are bursty, 250ms–2s, capped at 6 concurrent, queued and coalesced by (building, tool) — call-and-response shape.
- CH Chronicler is one infinite loop with random pauses — pathfinding shape.
- CH plank drop is a one-shot per event, like a TR ritual but persisted via `ChronicleStore`.
- CH aurora is a once-per-day single event with no concurrent siblings.

A unified `WorldScheduler` would need three different policies — coalescing, pathfinding, single-instance — turning the abstraction into a sum type that's harder to read than three small modules. Each module owns its own per-frame `update(dt)` and is called from `IsometricRenderer._update` next to the existing `harborTraffic` and `landmarkActivity`. Cost: three update calls per frame instead of one. Trivial.

**Recommendation:** keep `RitualConductor` (B.2), `Chronicler` (CH D2), `ChronicleManifests` (CH B1), `ChronicleMonuments` (CH C3), `TrailRenderer` (B.8), and `AuroraGate` (CH E1) as separate per-feature modules, each adopting the conventions in T0.6.

### S.3 — Expanded pulse-cue band scheme (extends #36) — **DECIDED (bands frozen; priority deferred to visual iteration)**

The original four bands (slow / medium / fast / static) survive; what changes is the per-band ownership table. **Conflict-resolution priority is NOT hardcoded in foundation** — see the working policy below the table.

| Band | Cadence | Canonical owner | Permitted ritual/relationship claimants | Forbidden |
| --- | --- | --- | --- | --- |
| **slow** (>1 s) | sweeping/single-axis | selection ring (already existing) | TR observatory telescope sweep (TR-3.2, 900ms+); TR lighthouse beam (TR-5.1, continuous, scaled rate); FC talk-arc shimmer (F11) **only if reframed as flow direction** per FC Open question 5 | competing pulse claimants when selection is active on the same agent |
| **medium** (~600 ms) | regular | working-status glow (already existing) | TR forge hammer-burst (TR-2.1, 600ms); TR archive page flip (TR-2.2, 600ms); TR mine pickaxe (TR-3.1, 1.6 Hz); TR portal rune-ring boost (TR-3.3, 1.2 Hz); FC mote orbit (F3, ~900ms full revolution); TR carrier-bird flight (TR-4.2, 1.6s) | adding a second medium pulse to an entity that already has working-status glow active |
| **fast** (<300 ms) | flash | recent-event flash | TR forge spark ring (TR-2.1, 250ms); TR taskboard pin (TR-4.1, 250ms appear); FC F2 re-merge sparkle puff (single frame); FC F1 wisp landing pulse | continuous use; fast band is one-shot only |
| **static** (no pulse) | n/a | idle agents, building lights, hearth glow | TR command flag (TR-4.2, persistent until timeout); TR harbor crate (TR-4.3, static prop); TR mine seam tint (continuous, modulated by `lightBoost` only); FC council ring at fixed alpha; FC departure sigil (alpha decay only); CH monument freshness (alpha decay only); CH manifest plank weathering (alpha decay only) | replacing static with motion in any of the above |

**Conflict-resolution policy (working — "whichever looks best"):** the foundation sprint that lands #36 freezes the **bands** (above) but does NOT ship a hardcoded priority order. Priority decisions are made per-feature via browser visual A/B (per `CLAUDE.md` § Browser Automation: prefer `playwright` MCP for design loops on `http://localhost:4000`) under high-density worlds (≥5 simultaneously WORKING agents, mixed selection states, mixed providers).

**Iteration mechanism:** ship a debug toggle that flips between candidate priority orders at runtime so iteration is cheap and reversible. Two implementation surfaces are equivalently acceptable:
- A `?pulsePriority=selection,working,recent,intrinsic` query-string parameter parsed once at boot and stored on `IsometricRenderer` (or wherever the pulse-claim arbitration lives).
- A small DevTools-only overlay listing each active claimant on hover, with up/down arrows to reorder live.

The foundation ships the toggle hook (a single `getPulsePriority()` function defaulting to a placeholder order such as `['selection', 'working', 'recent', 'intrinsic']`) and the band table. Each feature plan's implementation is responsible for proposing and visually validating the order it lands under. When a feature ships its motion-bearing items, the implementer re-runs the high-density A/B and updates the default if a clearer order emerges. Document the chosen order at the time of feature-sprint commit; do not codify it in foundation.

This is the working policy — not a TBD. Open question 3 is RESOLVED on this basis.

### S.4 — Unified empty-state surface (#37 + FC F12 + CH D2)

The brief asks for a single sketch that absorbs both FC and CH proposals. Here is the agreed scene, owned by `IsometricRenderer._drawEmptyStateWorldCue` (`IsometricRenderer.js:3810-3834`):

- **Always-on:** the **Chronicler NPC** (CH D2) walks a deterministic loop: Lore Archive entrance → Command Center plaza → Lore Archive entrance, with ~6 s pauses. Sprite at `character.chronicler` (manifest entry). Speed `0.018` tiles/frame (1/3 `AGENT_SPEED`). Visible at all agent counts — "durable presence" not a fallback.
- **Zero-agent only:** a single faint **ghost-arc** between the Command Center plaza tile and the Portal Gate tile (FC F12). Stroke alpha 0.10, non-pulsing (per S.3 the ghost-arc is in the static band when no real chat exists), drawn in the same canvas pass as `FC F11` talk arcs at one-tenth their alpha. Self-cancels the moment any agent appears.
- **Arrival interplay (zero → one):** when the first agent appears, the ghost-arc fades out over ~1.5 s while the FC F13 arrival animation (carriage on Command Center road OR boat into harbor, per provider) plays. The Chronicler does not interact with arriving agents — it walks past. It *does* react to a `chronicle:milestone` event by briefly pausing and turning toward the planted monument (single-frame head turn, no new motion band claimed).
- **Reduced motion:** Chronicler stops at the nearest waypoint; ghost-arc renders as a static dotted polyline at fixed alpha; arrivals snap (no animation).

This means FC Sprint 3 (F12) and CH Sprint D (D2) implement THIS unified surface, not separate ones. Foundation Sprint 5.2 lands the scaffold (Chronicler walk + ghost-arc skeleton), and the two feature sprints fill in their specific behavior.

### S.5 — `LightSourceRegistry` extensions (extends T0.3)

Existing T0.3 emitter shapes (per `BuildingSprite.js:92-105` `LIGHT_SOURCE_REGISTRY` and `getLightSources()` at line 748-762):

- `kind: 'point'` — radial halo (most building emitters).
- `kind: 'beam'` — directional cone (lighthouse).

New shapes the three feature plans introduce:

| Kind | Parameters | Lifetime | Producer | Consumer |
| --- | --- | --- | --- | --- |
| **`spark`** | origin, radius (lerps), color, alpha (lerps), TTL (~250ms) | transient | TR-2.1 forge hammer | T0.1 cached gradient + additive composite |
| **`orbit`** | parent (sprite ref), offset (per-mote phase), radius (4–6px), color, alpha modulated by `LightBoost` | per-frame derived; not really a registry entry, but reads `lightBoost` like one | FC F3 motes | direct vector draw, but registers a `point` for day/night gating |
| **`arc`** | endpoint A, endpoint B, controlPoint (computed from distance), color, alpha (shimmer), width | per-frame derived (chat arcs); persistent (council polyline) | FC F7 council; FC F11 talk arc; (TR-3.2 observatory star-arc renders particles, NOT a registry arc — keep separate) | line-emitter pass at low intensity |
| **`point` (transient)** | existing point shape with TTL | timed | TR-2.1 spark ring (alternative to `'spark'`); FC F14 departure sigil (TTL=12s); CH C3 monument soft halo at age<1d | existing point pipeline + age-based alpha |
| **`aurora`** | screen-space ribbon, NOT registered with `LightSourceRegistry` | painted in `SkyRenderer._drawAurora` between cloud and weather layers | CH E2 | one-off; treats `lightBoost` and `beaconIntensity` as inputs, but does not register |

**Proposed schema** (foundation sprint 2.2 implements):

```text
LightSource {
  id: string,                  // unique across registry; static for buildings, generated per-event for transients
  kind: 'point' | 'beam' | 'spark' | 'arc' | 'orbit',
  origin?: { x, y },           // for point/spark/orbit
  endpoints?: [{ x, y }, { x, y }],  // for arc
  controlPoint?: { x, y },     // for arc (quadratic curve)
  parent?: SpriteRef,          // for orbit (follows sprite each frame)
  color: string,
  radius: number,              // for point/spark/orbit; line width for arc; cone width for beam
  length?: number,             // for beam
  width?: number,              // for beam
  alpha: number,               // baseline; modulated by lightBoost
  ttl?: number,                // for transients; null = persistent
  createdAt?: number,          // for age-based alpha decay
  buildingType?: string,       // for visitor-driven intensity (existing pattern)
  intensity?: number,          // baseline; multiplied by lightingState modulators
}
```

T0.3's promotion in foundation sprint 2.2 lands the schema. Each feature plan's emitter then registers its shape and inherits day/night gating, gradient caching (T0.1), and alpha modulation via `LightingState` (T0.2) automatically.

## Risks & tradeoffs

- **Cross-plan misalignment risk.** If feature plans ship in parallel without finishing the foundation, each plan will land its own `RelationshipState`-shaped diff observer, its own band claim, its own emitter shape. The matrix above is the gate: **no feature sprint should start until the foundation sprints it depends on have landed**. Specifically: TR Sprint 2+ requires FS1+FS2; FC Sprint 1 requires FS1+FS2+FS4; CH Sprint A requires FS5; CH Sprint D requires FS3+FS5.
- **Scope creep.** Foundation sprints are shape-and-policy, not visuals. Resist adding decorative work (e.g., styling the empty-state ghost-arc beautifully) — that belongs in the consuming feature sprint. Sprint 5.2 should land the scaffold only.
- **Ship-without-foundation antipattern.** If someone tries to ship FC Sprint 2 without B.3 (`teamName`), the council ring renders for zero teams (Codex/Gemini are documented as null). That's the documented degradation, not an emergency. But if someone ships TR Sprint 2 without T0.1, every spark ring re-allocates a gradient per frame at ~6 Hz × N agents — a fill-rate trap. Surface in the foundation sprint exit checklist.
- **`teamName` collision risk.** B.3 infers membership from inbox filenames; an `agentName` that appears under multiple teams is non-deterministic. The adapter logs a console warning and last-write-wins. If a user actually maintains two teams with overlapping member names, they will see one agent's `teamName` flicker; the fix is to rename the inbox file. Documented, not blocking.
- **Empty-state co-design risk.** S.4's unified scene assumes the ghost-arc and Chronicler walk are co-visible without competing for attention. If user testing finds them noisy, the fix is reduce ghost-arc alpha further; the architecture survives.
- **Persistence corruption.** B.6 introduces a new failure mode (corrupt IndexedDB). Mitigation already in CH plan: idempotent writes, deterministic ids, treat the store as a cache. Foundation plan does not change this.
- **Pulse-band priority drift.** S.3 deliberately defers conflict-resolution priority to per-feature visual A/B. The risk is each feature ships a slightly different default order and the world feels inconsistent across sprints. Mitigation: every feature-sprint commit message records the chosen order; whenever a later sprint changes it, the earlier sprint is re-validated under the new order before merge.

## Validation

Per-sprint smoke checks aligned with `claudeville/CLAUDE.md` § Validation matrix.

| Sprint | What to test | Smoke commands |
| --- | --- | --- |
| FS1 | Policy doc readable, no syntax errors. Camera no longer drags into black void at any zoom. `Camera.getViewportTileBounds()` returns sane min/max. | `git status --short`; English-only check `rg -n -P "\p{Hangul}" $(rg --files -g '*.md' --glob '!node_modules')` empty; `npm run dev`; manual camera pan to extremes at zoom 1/2/3. |
| FS2 | Existing scene visually identical post-`LightingState` promotion. New `LightSourceRegistry` schema accepts existing emitters and at least one of each new `kind`. T0.1 cache reduces per-frame radial-gradient allocations. | `npm run dev`; visual diff `npm run sprites:capture-fresh && npm run sprites:visual-diff` against today's baseline; expect zero-pixel diff outside motion bands. DevTools performance trace shows reduced `createRadialGradient` calls. |
| FS3 | Retina/4K rendering crisp; sprite anchor and click hit-test still aligned at all `dpr` values. Existing offscreen caches (atmosphere vignette, sky background) re-allocate at DPR-scaled size. | Open at 100% / 150% / 200% browser zoom; Retina display test; click an agent at each zoom and confirm `agent:selected` fires for the visually clicked sprite. |
| FS4 | `curl http://localhost:4000/api/sessions` shows `teamName` populated for team-member sessions; null for codex/gemini. `AgentEventStream` emits `tool:invoked` on a Claude Edit; `subagent:dispatched` on a new sub-agent file appearing in `~/.claude/projects/.../subagents/`. `RelationshipState.teamToMembers` returns expected entries (visible via temporary `window.__rel = ...` console gate). | `node --check claudeville/adapters/claude.js`; `npm run dev`; `curl` the sessions endpoint; subagent file touch test. |
| FS5 | `await window.__chronicle.put('manifests', { id: 't', ... })` round-trips. Second tab does not acquire capture lease. Periodic prune fires on demand. Empty-state surface renders Chronicler walk + ghost-arc plaza→portal at zero agents. Privacy toggle replaces commit subjects with `[redacted commit]`. | `npm run dev`; DevTools → Application → IndexedDB; open second tab; verify lease behavior; toggle reduced-motion in DevTools and confirm Chronicler stops at waypoint. |

Cross-cutting (every sprint): `git status --short` clean of unrelated files; English-only Hangul scan empty; `verify-architecture` skill (`.claude/skills/`) clean.

## Open questions

Items 1–3 and 6 are RESOLVED inline. Items 4, 5, 7 remain open and need user input before the relevant sprint ships.

1. **Claude team config schema (blocks B.3).** What field in `~/.claude/teams/<name>/config.json` lists the team's session ids or agent names? — **RESOLVED.** Direct inspection of `~/.claude/teams/` showed there is no `config.json` and no roster file. Team identity = directory name (UUID or literal `default`). Membership is encoded in `inboxes/<agentName>.json` filenames. B.3 above documents the resolution strategy in full: build a `Map<agentName, teamId>` from inbox filenames, match against `Agent.agentName`, last-write-wins with console warning on collision. No schema migration; work with what exists.

2. **Single `AgentEventStream` (S.1) vs two separate observers.** — **RESOLVED.** User confirmed the consolidation. Ship `AgentEventStream` as the single primitive in foundation sprint 4.2. B.1's standalone `ToolEventObserver` is subsumed; TR `RitualConductor`, FC F1/F2, FC F11 chat-pair extraction, and FC F7/F9 team-join all subscribe through the one stream. No two-observer fallback is retained.

3. **Pulse-cue conflict resolution rule (S.3 priority order).** — **RESOLVED (working policy, not TBD).** User answer: "whichever looks best." Foundation freezes the four bands but does NOT hardcode a priority order. Each feature plan's implementation runs browser visual A/B (per `CLAUDE.md` § Browser Automation) under high-density worlds; a `?pulsePriority=...` query-string toggle (or DevTools-only overlay) flips between candidate orders at runtime. Foundation ships a `getPulsePriority()` hook with a placeholder default; feature sprints update it as evidence accumulates and record the chosen order in the commit message. See § S.3 above for the full policy.

4. **Empty-state co-design (S.4).** The Chronicler is "always visible, ignoring agent count" per CH D2. The ghost-arc is "zero-agent only" per FC F12. Confirm that's the intended split — alternative is "both fade out after first arrival" which would simplify the transition logic.

5. **`LightSourceRegistry` scope at FS2.** The schema in S.5 is wide. If we land it as-is, we're guessing at the orbit/spark/arc shapes before any consumer ships. Alternative: land only `point` + `beam` (existing) + a single `transient` (with TTL) shape; the feature plans then specialize. Recommended: ship S.5 as written — the alternative defers complexity and forces every consumer to invent its own gradient cache.

6. **Cross-plan contradiction surfaced by the read.** TR plan § Risks bullet 5 says the mine pickaxe ritual "moves the visual response from agent-side (existing `_drawTokenItem`) to building-side" and recommends suppressing `LandmarkActivity._addTokenItem`. CH plan does not mention `_drawTokenItem` and assumes the existing landmark machinery is intact. — **RESOLVED.** User decision: TR Mine ritual owns the token-rollover visual; CH `MonumentRules` (B.7) MUST suppress monument creation for the token-cap-rollover event class. B.7 above now carries the explicit exclusion. CH watches commits / pushes / tags / PR merges / test-run summaries only; no quota stones.

7. **Trail-sample retention vs. trail-render culling.** CH B.8 caps visible samples at 600 per agent at zoom < 1.5; older samples are stored but not rendered until zoomed in. This is a UX-policy decision, not a foundation decision. Surfaced because foundation Sprint 3 (T0.4) and the T0.5 viewport contract gate the implementation; the policy is owned by CH Sprint D.

## Cumulative cost note

Per-frame additions vs. today, after Foundation Sprints 1–5 ship:

- T0.1 cached gradients (FS2): **net negative** — was N × 60 fps uncached, becomes N cache-keyed lookups.
- T0.2 `LightingState` calc per frame (FS2): trivial; already exists in `AtmosphereState.js` as `lighting`, the work is shape promotion.
- T0.3 registry consumer iteration (FS2): O(N emitters), today's `getLightSources()` already iterates twice per frame; net neutral after consolidation.
- T0.4 DPR scaling (FS3): one-time canvas reallocation cost on dpr change; per-frame neutral.
- T0.5 viewport tile-rect (FS1): O(1) precompute per camera change; trivial.
- T0.6 motion-budget policy (FS1): no runtime cost; documentation-only.
- B.4 `RelationshipState` rebuild (FS4): debounced on `agent:*` events, O(N agents) per rebuild; not per-frame.
- B.6 `ChronicleStore` (FS5): writes are batched (30s for trails, immediate-but-rare for manifests/monuments). Reads transaction-batched and cached in module-local memory; cold reads only on boot and 5-min prune. **No measurable per-frame cost.**

**Storage cost (CH-owned, foundation enables):**
- `manifests` at ~80 bytes/row × ~30 commits/day × 24h = ~2 KB/day; pruned at 24h.
- `monuments` at ~120 bytes/row × ~5 stones/day × 30d = ~18 KB; pruned at 30d.
- `trailSamples` at ~40 bytes/row × 1 Hz × 10 agents × 1h = ~1.5 MB/h; pruned at 24h. **Largest by far.** Cap mitigates: FS5 ships with B.6's 24h prune already configured.
- `auroraLog`: 1 row per fired day, ~50 bytes; trivial.

Profile target: hold 60 fps at 1080p on integrated GPU in a 10-agent stress run with FS1–FS5 landed. If trail repaint exceeds budget, the CH plan's "older 50 minutes only when zoomed in" rule kicks in — that's the safety valve, not a foundation concern.
