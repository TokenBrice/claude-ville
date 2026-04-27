# Familiars and Council — Implementation Plan
Generated: 2026-04-28

Source: relationship metadata is already on the wire (`Agent.parentSessionId`, `agentType`, `agentName`, `teamName`, plus `Agent.isSubagent` getter at `claudeville/src/domain/entities/Agent.js:153`), and `IsometricRenderer._updateChatMatching` (`IsometricRenderer.js:1091`) already pairs `SendMessage` senders with their recipients. The world ignores all of it. This plan adds four visible relationship cues — subagent **familiars**, team **council** circles, **talk arcs** between chat partners, and **arrivals & departures** — without rewriting the agent renderer.

This document follows the conventions of `agents/plans/world-enhancement-plan.md`. It cites that plan by tier/item ID (T0.x, #N) and does not re-document items it depends on.

---

## How to read this document

Each work item lists: domain · file:line · effort (S < 1 day / M 1–3 days / L > 3 days) · impact · depends on. Familiar / council prerequisites that aren't already covered by Tier 0 of `world-enhancement-plan.md` are tagged **FC0.x**.

Status tags: **NEW** introduced here · **ABSORBS** subsumes an item in `world-enhancement-plan.md`.

---

## Goal

Make multi-agent relationships visible in the world. A glance should answer:

- "Which agents are subagents of which parent?"
- "Which agents share a team?"
- "Who is talking to whom right now?"
- "When did this session join, when did it leave?"

The data already drives the dashboard sidebar and activity panel. The world should speak the same language.

## Non-goals

- No new domain events. The plan rides on existing `agent:added` / `agent:updated` / `agent:removed` and the `chatPartner` linkage in `AgentSprite`.
- No backend changes. Adapters already populate `parentSessionId`/`teamName` where they can; the plan documents the gaps and degrades visibly when the data is missing.
- No new build-step, no framework, no DOM panels. Canvas-only additions.
- No new sprite sheets for *agents*. Familiars are tiny sprites or vector glyphs; arrivals reuse the existing `prop.harborBoat` and a new carriage prop.
- No replacement of the existing `chatPartner` machinery in `AgentSprite.js:96–98, 320–360, 500–513` — we layer on top.

## User-visible outcomes

1. **Subagent familiars.** When a parent dispatches a subagent (Task / spawn_agent / etc.), a small wisp peels off the parent at Portal Gate and animates outward; the subagent then appears at that position. While the subagent runs it remains a full `AgentSprite` but its parent shows 1–3 colored motes orbiting at shoulder height. On subagent completion the motes re-merge with the parent in a brief glow.
2. **Council circle.** Agents sharing a `teamName` get a faint connecting ring/arc on the Command Center plaza in the team's color. At-rest team members cluster visually (their idle wander is biased toward the team plaza tile).
3. **Talk arcs.** A glowing arc between paired `chatPartner` sprites locks each frame to point at the partner's tile centre. Replaces / absorbs the existing `_drawChatEffect` ellipsis dots.
4. **Arrivals & departures.** New sessions ride in by carriage on the Command Center road or boat into the harbor (provider-specific). Removed sessions leave a slow-fading sigil on the tile they last stood on.

## Data dependencies

| Field | Source (file:line) | Today |
| --- | --- | --- |
| `Agent.parentSessionId` | `Agent.js:106, 116` | Set by Claude adapter (`adapters/claude.js:488`) and Codex adapter (`adapters/codex.js:702-705` via `parentThreadId`). Gemini does not surface it (`adapters/gemini.js:361`). |
| `Agent.agentType` | `Agent.js:105, 115` | `'main' \| 'sub-agent' \| 'team-member'` from Claude (`claude.js:474`); `'main'` plus role string from Codex (`codex.js:687`); always `'main'` from Gemini (`gemini.js:348`). |
| `Agent.agentName` | `Agent.js:104, 114` | Claude session metadata + agent launches (`claude.js:472–474`); Codex `agent_nickname` (`codex.js:127`); Gemini does not provide it. |
| `Agent.teamName` | `Agent.js:94, 123` | Claude orphan/team-member sessions populate it indirectly via `getTeams()` (`claude.js:615`), but the per-agent field is **not currently set in any adapter** — confirmed by reading `claude.js:395–410, 468–489, 532–552`. This is a real gap and is item FC0.1 below. |
| `Agent.isSubagent` getter | `Agent.js:153–155` | `parentSessionId` OR `agentType !== 'main'`. |
| Chat pair (`chatPartner`) | `AgentSprite.js:96`, `IsometricRenderer.js:1091–1137` | Already wired from `currentTool === 'SendMessage'` and `currentToolInput` recipient lookup. No change needed. |

**Per-provider degradation matrix:**

| Feature | Claude | Codex | Gemini |
| --- | --- | --- | --- |
| Subagent familiars | Full (parent+sub both present, same provider). | Full when `parent_thread_id` resolves to a tracked session; otherwise treat the subagent as `main` (no familiar). | Not supported. Subagent layer simply not drawn for Gemini agents (no `parentSessionId`). |
| Council circle | Requires FC0.1 (populate `teamName`); orphans/team-members from `claude.js:_getOrphanSessions` are the only source. | Falls back to `agent.provider` color and skips ring rendering when `teamName` is null. | Same fallback as Codex. |
| Talk arcs | Full (relies on `SendMessage` tool name). | Likely partial — Codex doesn't currently mint a `SendMessage`-equivalent tool; arcs render only when `currentTool` matches the existing literal `'SendMessage'`. Document, don't extend. | Not applicable. |
| Arrivals & departures | Full. | Full. | Full. |

The plan must not regress when any of these fields is null. Every visual element checks the data and renders the lower-fidelity fallback.

## Architectural prerequisites

These are *new* prerequisites scoped to this plan. They are tagged FC0.x to distinguish from the T0.x items in `world-enhancement-plan.md`. Where a T0 item is already a hard prereq, it is cited and not redescribed.

### FC0.1 Populate `teamName` on Claude session payloads
**Domain:** Adapters · **File:** `claudeville/adapters/claude.js:395–410, 468–489, 532–552` · **Effort:** S · **Impact:** High

`Agent.js:94, 123` reads `teamName` from the payload but no adapter sets it. `claude.js:_getOrphanSessions` already classifies agents as `agentType: 'team-member'` (line 538) and `getTeams()` (line 615) reads `~/.claude/teams/<name>/config.json`. Cross-reference team-member session IDs with team config so each session payload carries `teamName`. Without this, council circles (Sprint 2) have nothing to bind to.

Codex/Gemini are out of scope for this prereq — their sessions remain `teamName: null` and degrade as documented.

> **Schema note (resolved 2026-04-28):** there is no `config.json` or roster file in `~/.claude/teams/<name>/`; team identity is the directory name (UUID or `default`) and membership is encoded by inbox filenames (`inboxes/<agentName>.json`). The matching strategy and collision handling are documented in `agents/plans/feature-foundation.md` § B.3.

### FC0.2 Relationship registry per-frame snapshot
**Domain:** World renderer · **File:** new `RelationshipState.js` derived from `World.agents` · **Effort:** S · **Impact:** High

A small once-per-frame derivation (rebuilt only when membership changes) producing:

```text
RelationshipState {
  parentToChildren: Map<parentSessionId, Set<agentId>>,
  childToParent:    Map<agentId, parentSessionId>,
  teamToMembers:    Map<teamName, Array<agentId>>,
  recentArrivals:   Array<{ agentId, sinceMs }>,   // last 8 seconds
  recentDepartures: Array<{ lastTile, sinceMs }>,  // last 12 seconds
  chatPairs:        Array<{ aId, bId }>,           // mirrors AgentSprite.chatPartner, deduped
}
```

Built in `IsometricRenderer._update` after the existing chat-matching block (`IsometricRenderer.js:1156–1170`). Cap rebuild to once per `agent:added` / `agent:updated` / `agent:removed` debounce window so peak-frame work is O(1). Subagent familiars, council circles, talk arcs and arrivals/departures all read this struct rather than walking `world.agents` independently.

### FC0.3 Team color resolver
**Domain:** Theme · **File:** new helper `claudeville/src/presentation/shared/TeamColor.js`, mirrored in `palettes.yaml` only if the palette grows · **Effort:** S · **Impact:** Medium

Deterministic hash → palette. Reuse the existing project-color vocabulary at `Sidebar.js:9–12`:

```js
const PROJECT_COLORS = [
    '#e8d44d', '#4ade80', '#60a5fa', '#f97316', '#a78bfa',
    '#f472b6', '#34d399', '#fb923c', '#818cf8', '#22d3ee',
];
```

Accept `teamName` (string) and return `{ accent, glow, panel }` triplets matching the harbor `REPO_PALETTES` shape (`HarborTraffic.js:43–52`) so the same lookup feeds council rings (Sprint 2) and any future team badge in `Sidebar.js`/`TopBar.js`. No user-chosen colors yet — keep it deterministic; revisit after first usage.

No new entries in `claudeville/assets/sprites/palettes.yaml` are required for Sprint 1–4. Council ring is drawn vector-style in canvas using the resolver output.

### Cross-references to T0.x

- **T0.2 (LightingState) and T0.3 (LightSourceRegistry)** — required for any new emitter. Familiar motes, council ring, talk arcs and the departure sigil all glow; each is registered with the registry so day/night gating, `lightBoost` and `sunWarmth` modulate them like every other emitter. See item integrations below. **Hard prereq.**
- **T0.6 (motion-budget policy)** — every motion-bearing item below names a reduced-motion fallback at allocation time. **Hard prereq.**
- **T0.4 (HiDPI threading)** and **T0.5 (camera viewport bounds)** — not strictly required for these features, but anything that allocates an offscreen cache (we add none) would need T0.4 first. Familiar motes and arcs draw direct (no offscreen), so the work can land before T0.4.

---

## Phases

Each sprint ends demoable. Items list domain, file:line, effort, impact, dependencies.

### Sprint 1 — Familiars (the parent–subagent layer)

The work-horse of the plan. Once subagents have a visible tether to their parent, parallelism reads instantly.

#### F1. Subagent dispatch detection
**Domain:** Agents · **File:** `IsometricRenderer.js:1156` (in-`_update`); `RelationshipState.js` from FC0.2 · **Effort:** M · **Impact:** High · **Depends on:** FC0.2

Watch `RelationshipState.parentToChildren` deltas. When a child id is added under parent X, schedule a **dispatch animation** (a wisp emitted from the parent's tile, or from Portal Gate at tile `(7, 31)` — the centre of `BUILDING_DEFS[type='portal']`, see `claudeville/src/config/buildings.js:172`). The wisp animates over ~600 ms (motion budget: ~36 frames) along a smoothed path; on landing, the new `AgentSprite` (already created via `agent:added` at `IsometricRenderer.js:1029–1048`) becomes visible. Until landing, the new sprite is held at `globalAlpha = 0` and `_lastPathTileKey = null` so it doesn't pathfind during the wisp animation.

The animation reuses the `'sparkle'` and `'portalRune'` particle presets in `ParticleSystem.js:56–63, 96–103` for trail dust; the wisp itself is a tiny vector circle drawn directly so we don't pay for sprite decode.

Rule: dispatch animation only fires when **both** parent and child are present in `world.agents` at the moment the child appears. If the parent is absent (e.g. Codex parent thread not tracked), the child arrives via the standard arrivals path (Sprint 4).

Reduced motion: skip the wisp; the child sprite simply pops in with a 1-frame fade.

#### F2. Subagent completion re-merge
**Domain:** Agents · **File:** `IsometricRenderer.js` near `agent:removed` handler at `IsometricRenderer.js:1029–1048` (subscribed in `show()`) · **Effort:** S · **Impact:** Medium · **Depends on:** F1

When a child id is removed and its parent is still alive, emit a single `'sparkle'` puff at the child's last screen position and run a 400 ms tween of a glow trail back to the parent. After the trail ends, decrement the parent's mote count. If the parent is also gone (or never existed), fall through to the standard departure sigil (Sprint 4).

Reduced motion: no trail; emit one frame of `'sparkle'` particles at the child's last tile, then drop straight to the departure sigil.

#### F3. Orbiting motes for live subagents
**Domain:** Agents · **File:** `AgentSprite.js:515` (`draw` body) — additive call from `IsometricRenderer._render` after sprite draw, not inside `AgentSprite.draw` (keeps the sprite class single-purpose) · **Effort:** M · **Impact:** High · **Depends on:** FC0.2, T0.2, T0.6

For each parent sprite where `RelationshipState.parentToChildren.get(parentId).size > 0`, draw up to `MAX_VISIBLE_MOTES = 3` small motes orbiting at shoulder height (`y - 50` in sprite-local space, matching the existing chat ellipsis position in `AgentSprite._drawChatEffect`). Each mote:

- Position derived from `parentSprite.x/y + cos/sin(orbitPhase)`, where `orbitPhase = baseAngle + (performance.now() / 900) * motionScale * (clockwise ? 1 : -1)`. The phase shift is per-child-id hash so motes don't all line up.
- Colour resolved from the **child agent's** provider colour (`AgentSprite.js:39–44`) if the child is in `world.agents`, else neutral gold `#f6cf60`.
- Radius `4 + childIndex * 0.6` px; alpha modulated by `LightingState.lightBoost` (T0.2) so motes brighten at dusk.
- If `subagentCount > MAX_VISIBLE_MOTES`, render a `+N` glyph at the parent's overhead-slot offset (`overlaySlot` system at `IsometricRenderer.js:1467+`). Reuse the existing compact-slot rect to avoid label collision.

Renders in the agent-overlay layer (after the agent sprite draw, before label/status), so motes draw above buildings only when their parent does. They are **not** sorted into the global drawables list — the parent sprite carries them.

Reduced motion: motes static at four cardinal positions, no rotation.

Performance ceiling: the cap of 3 visible motes plus a `+N` badge keeps per-parent draw cost bounded. No new offscreen cache.

#### F4. State machine for subagent rendering modes
**Domain:** Agents · **File:** `IsometricRenderer._render`, `IsometricRenderer.js:1351–1384` (drawables loop) · **Effort:** S · **Impact:** Medium (correctness)

A subagent must render in **one of two modes** but never both:

| Mode | When | Renderer |
| --- | --- | --- |
| `full-sprite` | Default. The subagent has its own `AgentSprite`; pathfinds; can be selected. | Existing path. |
| `pre-arrival` | Between F1 dispatch start and wisp landing. | Wisp animation only; the sprite is hidden. |

`AgentSprite` gains a `_arrivalState ∈ {pending, visible}` flag. `_arrivalState === 'pending'` short-circuits `draw` (returns early) and `hitTest` (returns false) — clicking the wisp is intentionally not supported.

We do **not** introduce an "orbiting-only" mode. F3 motes are decorative tethers on the parent; the actual subagent always has a full sprite for the duration it lives in `world.agents`. This avoids double-rendering and keeps the selection model simple. The **price**: with N parallel subagents we have N motes *and* N full sprites visible, which crowds at peak (5+ subagents). Mitigated by F3's `MAX_VISIBLE_MOTES = 3` cap and by the fact that subagents already cluster at the same building (`Agent._buildingForToolName` routes most subagent tools to a small set of destinations).

#### F5. Selection rules for parent ↔ familiars
**Domain:** Agents · **File:** `IsometricRenderer.js:1051–1079` (`_handleClick`) · **Effort:** S · **Impact:** Medium · **Depends on:** F3

When the player selects a **parent** sprite: each of the parent's visible motes brightens (alpha *= 1.4, capped at 1.0) for the duration of the selection. The motes do **not** highlight as standalone selections; clicking them does not select the subagent.

To select a subagent, the player clicks the subagent's full sprite. Hit-test priority is unchanged (front-most by `sprite.y`), and motes are **not** added to `agentSprites`, so they aren't part of the hit test. Rationale: motes are 4–7 px wide; reliable click targeting at typical zooms is impractical without doubling the hit radius, which would conflict with the parent's hit box.

#### F6. Familiar manifest entries (no new sprites required)
**Domain:** Sprite assets · **File:** `claudeville/assets/sprites/manifest.yaml` (no edits in Sprint 1) · **Effort:** S · **Impact:** Low

Sprint 1 uses canvas-vector motes (small filled circles with a 1-px brighter inner pixel) so no new manifest entries land. The wisp is a single rounded rectangle with a sparkle trail driven by `'portalRune'`. Re-evaluate after demo: if motes need stronger silhouette, file as Sprint 5 work (`atmosphere.familiar.mote`, 8x8 pixel, 4-frame breathing-idle) — not in scope here.

### Sprint 2 — Council (team layer)

#### F7. Council ring at Command Center plaza
**Domain:** Buildings · **File:** new `CouncilRing.js` consumed by `IsometricRenderer._render` between layers 2 and 3 (after building shadows, before agent draw) · **Effort:** M · **Impact:** High · **Depends on:** FC0.1, FC0.3, T0.2

For each `teamName` with ≥ 2 active members, draw a faint ring centered on the Command Center plaza tile (`{ tileX: 16, tileY: 21 }`, the existing `entrance` of `BUILDING_DEFS[type='command']`). The ring connects the team's current member positions with a closed polyline, smoothed with quadratic bezier handles, in the team's accent color (FC0.3). Stroke alpha 0.32, width 1.4 px world-space, modulated by `LightingState.ambientTint`.

If members are spread across the world (not at the plaza), the ring still visits each member's actual `sprite.x/y` rather than fake plaza positions — the ring **shows the team's footprint**, not a synthetic huddle.

When all team members are idle (`agent.status === IDLE`), bias their idle wander targets via `AgentSprite._ambientBuildingTypeForState` (`AgentSprite.js:175–195`) toward the plaza so the ring tightens visually. Implementation: extend the existing `lastKnown` precedence to also accept a `teamPlazaPreference` flag. Single-line change in `_ambientBuildingTypeForState`; the rest of the data flow already exists.

Reduced motion: ring drawn at fixed alpha, no shimmer.

#### F8. At-rest team clustering (idle bias)
**Domain:** Agents · **File:** `AgentSprite.js:175–195` · **Effort:** S · **Impact:** Low–Medium · **Depends on:** F7

Detailed above; called out as a separate item because it crosses the AgentSprite boundary. Avoid forcing **all** idle agents to the plaza — keep the existing diversity (mine, archive, etc.) and only bias when the agent has a `teamName` and at least one other team member is also idle.

#### F9. Team color in Sidebar/TopBar
**Domain:** Shared UI · **File:** `claudeville/src/presentation/shared/Sidebar.js:75–87` · **Effort:** S · **Impact:** Low (reinforces world cue) · **Depends on:** FC0.3

Pre-existing project-color tag on the project-group header (`Sidebar.js:69–74`) stays. Add a small team-color dot next to the agent's name when `agent.teamName` is set. Use the same `TeamColor.resolve()` from FC0.3. **TopBar is unchanged** — there's currently no team affordance in `TopBar.js:1–126` and the topbar is already busy with quota bars; do not add one in this plan.

### Sprint 3 — Talk arcs (chat layer)

#### F10. Chat-partner facing lock — **ABSORBS #27 from world-enhancement-plan.md**
**Domain:** Agents · **File:** `AgentSprite.js:266–298` (per the existing plan; see `_faceChatPartner` at `AgentSprite.js:483–487`) · **Effort:** S (reduced from M, because this plan needs the same hook) · **Impact:** Medium

`_faceChatPartner` already snaps direction once when chat begins (`AgentSprite.js:483–487` and `:339–352`). Promote the snap to per-frame: call `_faceChatPartner` from `update()` whenever `chatting === true`. Single change at `AgentSprite.js:321–326`. This is a strict prerequisite for the arc to look correct — without it, sprites stand back-to-back while the arc curves between them.

This item replaces #27 in `world-enhancement-plan.md`. When implementing the world-enhancement plan separately, mark #27 as ABSORBED-BY-FC10.

#### F11. Talk arc rendering
**Domain:** Agents · **File:** `IsometricRenderer._render` at `IsometricRenderer.js:1417` (after particles, **before** atmosphere) · **Effort:** M · **Impact:** High · **Depends on:** F10, T0.2, T0.6

Draw an arc between each `chatPair` from `RelationshipState.chatPairs`. The arc is a quadratic curve from `partnerA.x, partnerA.y - 18` to `partnerB.x, partnerB.y - 18`, with the control point lifted by `min(60, distance * 0.35)` so short arcs stay flat and long arcs swing higher. Stroke colour: `THEME.chatting` (`#f2d36b`, already present at `AgentSprite.js:34`). Width 1.4 px world-space.

Two alpha modulations stacked:

- A slow shimmer (`0.55 + 0.2 * sin(time * 0.004)`).
- `LightingState.lightBoost` (T0.2) so the arc dims during day, brightens at dusk.

The arc registers with `LightSourceRegistry` (T0.3) as `kind: 'arc'` with two endpoints; the light pass treats it as a thin line emitter at low intensity (one-line addition to the registry consumer).

**Draw order vs. existing layers** (`character-mode/README.md` § "Data sources and draw order"):

> 4. Agents, selection/status overlays, chat motion, and current-tool effects.

Per that contract the arc lives in **layer 4**, after agent sprites are drawn. The arc therefore correctly **sits in front of** building bases (layer 3) but **behind** the screen-space atmosphere wash (layer 5). It is *not* sorted into the agent drawables list (`IsometricRenderer.js:1351–1384`) because the arc spans Y values; sorting it would clip it incorrectly. The trade-off is that an arc may visually pass in front of a building when geometry suggests it should pass behind — acceptable, because chat arcs are a directional cue, not a physical object.

The existing `_drawChatEffect` ellipsis (`AgentSprite.js:597`) is **kept** — three dots above each partner remain (re-purpose them as "speaking" indicators). The new arc is the connector; the dots stay as endpoints.

Concurrency cap: `MAX_TALK_ARCS = 8`. If `chatPairs.length` exceeds the cap, prefer pairs with the most-recent `currentTool === 'SendMessage'` activity (use `agent.lastActive`, already populated in `Agent.js:138`).

Reduced motion: static dotted polyline; `setLineDash([2, 4])`; no shimmer.

#### F12. Empty-state alignment
**Domain:** All · **File:** `IsometricRenderer._drawEmptyStateWorldCue` at `IsometricRenderer.js:3810–3834` · **Effort:** S · **Impact:** Medium · **Depends on:** F11, world-enhancement-plan.md item #37

With zero or one agent, council rings, motes and arcs are silent. The `_drawEmptyStateWorldCue` already handles this case for the general world. Augment it with a **single ghost-arc** between the Command Center plaza and Portal Gate at idle alpha — communicates the place where dispatches happen. Self-cancel when an agent appears.

Cross-reference: this is item #37 of `world-enhancement-plan.md` (empty-state world visual). The work overlaps; merge by extending `_drawEmptyStateWorldCue` rather than introducing a second empty-state path. Do not duplicate.

### Sprint 4 — Arrivals & departures

#### F13. Arrival routing
**Domain:** World renderer · **File:** new `ArrivalDeparture.js`, hooked from `agent:added` in `IsometricRenderer.js:1029` · **Effort:** M · **Impact:** Medium · **Depends on:** FC0.2

When `agent:added` fires for an agent **without** an active parent (so it isn't already covered by F1), choose an arrival mode:

- If `agent.provider === 'claude'` and `agent.gitEvents.length === 0` and the agent's `projectPath` does not match a tracked harbor repo: **carriage on the Command Center road** (a simple cart sprite — `prop.harborBoat` reused, palette-swapped, or a new `prop.carriage` lined up with `commandCenterRoadTiles` already computed at `IsometricRenderer.js:346`).
- Otherwise: **boat into the harbor**, reusing `HarborTraffic.enumerateDrawables` semantics (`HarborTraffic.js:758`) and a new `arrival` ship state (mirroring `'docked'`/`'departing'`). The harbor approach lanes (`SEA_LANES` at `HarborTraffic.js:54–87`) already model inbound paths; reverse a lane and offset.

The arrival animation runs ~3 s; on completion the new `AgentSprite` is positioned at the disembark tile and fades in. If `motionScale === 0`, skip the animation; the sprite simply appears.

Carriage uses the existing `AGENT_SPEED` cadence and the `commandCenterRoadTiles` set; no new pathfinding work required.

#### F14. Departure sigil
**Domain:** World renderer · **File:** `ArrivalDeparture.js` (same module) hooked from `agent:removed` in `IsometricRenderer.js:1029` · **Effort:** S · **Impact:** Medium · **Depends on:** F2 (re-merge consumes some departures), T0.2

When `agent:removed` fires for an agent **without** an alive parent (so F2's re-merge does not fire), record `{ tile, providerColour, removedAt }` in `RelationshipState.recentDepartures`. Render a slow-fading sigil at the departed tile — a pixel-art glyph (provider initial `C/X/G` from `Sidebar.js:6`) with a soft halo. Lifetime 12 s, alpha 0.45 → 0.0 linear. Registered with `LightSourceRegistry` as `kind: 'point'` so it modulates with day/night.

Caps: `MAX_RECENT_DEPARTURES = 6`. Older sigils are evicted FIFO.

Reduced motion: full alpha, hold for 6 s, then snap to invisible.

#### F15. Carriage / arrivals manifest entry (deferred)
**Domain:** Sprite assets · **File:** `manifest.yaml` (Sprint 4 deferred) · **Effort:** S · **Impact:** Low

If demo confirms the carriage silhouette needs more than a palette-swapped harbor boat, file `prop.carriage` (32 × 32, 4 directions) as a follow-up. Sprint 4 ships first with the swap to validate the routing.

### Sprint 5 — Polish (post-demo, optional)

#### F16. Provider-aware mote palette
**Domain:** Agents · **File:** F3's mote draw helper · **Effort:** S · **Impact:** Low

Today motes match the child's provider. If the child is the same provider as the parent, vary by hash so visually distinct. Cosmetic; only ship after the rest demos cleanly.

---

## Risks & tradeoffs

1. **`teamName` gap.** FC0.1 requires a Claude-adapter change to populate `teamName` from `~/.claude/teams/<name>/config.json`. Until that lands, council circles only render for sessions whose payload happens to include the field. Mitigation: ship FC0.1 as the very first commit and gate Sprint 2 on it.
2. **Codex `parentSessionId` resolution.** `codex.js:702–705` resolves `parent_thread_id` by lookup in `sessionIdByThreadId`; the parent session must be active in the same scan window. If Codex spawns a subagent against an idle/closed parent, the subagent appears parent-less. Familiars degrade silently for these. Acceptable.
3. **Talk-arc draw order.** Arcs sit above buildings (layer 4), so an arc between two agents on opposite sides of a building looks like it passes through the building. The alternative — sorting arcs into per-tile drawables — clips the arc visibly at every Y boundary it crosses. Chosen tradeoff: keep arcs above buildings; rely on the dotted endpoints + facing lock (F10) to anchor the relationship to specific agents.
4. **Subagent crowding.** With 5+ subagents under one parent, three motes plus the `+N` badge plus the actual subagent sprites cluster heavily. The motes are tiny (4–7 px) and unobtrusive; the actual sprites are already subject to the existing separation steering at `IsometricRenderer.js:1185–1218`. Watch this in the demo with > 5 subagents.
5. **Selection ambiguity.** Decision: motes do not select. If users complain the motes feel inert, revisit. The fallback path is to extend hit-testing with a generous click radius — but motes are tiny and would steal clicks intended for the parent sprite.
6. **Arrivals path conflict with HarborTraffic.** F13's "boat" mode reuses harbor lanes. The harbor module already runs commit/push ships. Concurrent arrival + harbor traffic could overload the visual channel. Mitigation: `MAX_VISIBLE_SHIPS = 12` (`HarborTraffic.js:5`) already caps the harbor. New arrival ships count against the same cap; harbor traffic always wins ties.
7. **Performance ceiling.** Per-frame cost vs. baseline:
   - 1 `RelationshipState` rebuild per membership change (debounced, O(N) on rebuild only).
   - Up to N parents × 3 motes draw calls per frame (vector, no offscreen).
   - Up to 8 talk arcs × 1 quadratic curve.
   - Up to N teams × 1 polyline.
   - Up to 6 departure sigils × 1 light registry entry.
   At a peak of ~30 agents, this stays under the cumulative budget of `world-enhancement-plan.md` § "Cumulative cost note". No new caches.

## Validation

Aligned with the validation matrix in `claudeville/CLAUDE.md`:

| Sprint | Smoke checks |
| --- | --- |
| Sprint 1 (Familiars) | `npm run dev`; mock-spawn a Claude subagent (touch a `subagents/agent-X.jsonl` under an active project; the live polling at `adapters/index.js:67` will pick it up). Verify wisp emits, motes orbit, parent selection brightens motes, child removal triggers re-merge particles. Test with `prefers-reduced-motion: reduce` toggled in DevTools. |
| Sprint 2 (Council) | Populate two team-member sessions via `~/.claude/teams/<test>/config.json` plus `~/.claude/projects/<encoded>/<sessionId>.jsonl` files; confirm both agents share a colored ring on the plaza. Confirm Sidebar shows the team-color dot. Resize to mobile width — ring still readable. |
| Sprint 3 (Talk arcs) | Two active sessions where one's `currentTool === 'SendMessage'` and `currentToolInput` matches the other's name (this is already exercised by `IsometricRenderer._updateChatMatching`). Confirm arc renders, lock-on tracks both partners, dotted fallback under reduced motion. |
| Sprint 4 (Arrivals & departures) | Add a session via the live polling path; observe carriage/boat. Then `rm` the session file or wait past `activeThresholdMs`; observe departure sigil. Run with all three providers if available. |
| Adapters touched (FC0.1) | `node --check claudeville/adapters/claude.js`; spot-check `curl http://localhost:4000/api/sessions` shows `teamName` populated for team-member sessions. |
| Architecture | Run skill `verify-architecture` after each sprint to confirm no layer violations (the plan adds files under `presentation/character-mode/` and `presentation/shared/` only). |

The plan adds **no new dependencies and no build step**; sprite-asset validation (`npm run sprites:validate`) only needs to run if Sprint 5 / F15 introduces a manifest entry.

## Open questions

1. **Should F7's council ring follow members across the whole world, or stay anchored to the plaza?** This plan picks "follow members" — the ring shows the team's footprint, which is more honest. Confirm with the user before building; if "anchored at plaza" is preferred, F7 simplifies to a single circle and F8 (idle bias) becomes mandatory rather than optional.
2. **Should arrivals respect provider home buildings?** `AgentSprite.js:56–60` already maps providers to "home" buildings (`PROVIDER_HOME_BUILDINGS`). Should a Codex agent's carriage stop near the Forge instead of Command Center? Plan default: arrive at Command Center plaza for visual consistency. Confirm.
3. **How aggressive should F8 (idle bias) be?** Pulling all idle team members to the plaza creates a cluster but also empties the rest of the world. Plan default: 50/50 weighted — half plaza, half existing diverse-ambient. Confirm the bias factor.
4. **Is `IsometricRenderer.js` the right home for `RelationshipState` (FC0.2)?** Alternative: emit a new `relationships:updated` event from `World` and let `IsometricRenderer` subscribe. Plan picks the renderer-local approach because `World` should remain pure domain. If a future widget or dashboard needs the same struct, promote.
5. **Should F11 absorb #36 (pulse-cue ownership) from the existing plan?** The talk arc shimmer is a slow medium-rate pulse, which collides with #36's "medium = working status glow" assignment. The pulse on arcs can be re-cast as a flow direction cue (animated dashes traveling from sender to receiver) instead, which avoids the conflict. Recommended; needs user sign-off because it expands F11.

## Cumulative cost note

If Sprints 1–4 ship as written, per-frame additions vs. today (post-T0.1/T0.2/T0.3):

- 1 `RelationshipState` rebuild per `agent:*` event burst (debounced) — trivial.
- Up to ~30 mote draw calls (cap 3 motes × ~10 active parents) — vector, no offscreen, < 1 ms.
- Up to 8 talk arcs — quadratic curve each, < 0.5 ms.
- Up to 4–6 council polyline strokes — < 0.5 ms.
- 1 carriage / boat sprite during ~3 s arrivals — already amortized by `HarborTraffic`'s existing budget.
- Up to 6 departure sigils registered with `LightSourceRegistry` — each adds one cached gradient (post-T0.1), expires after 12 s.

Net: comfortably within the 60 fps budget of the existing plan. No new offscreen caches; the only memory addition is the `RelationshipState` struct (O(N) where N = active agents), rebuilt on event, not on frame.

---

## Provenance

This plan was authored as a single subagent dispatch. It cites `world-enhancement-plan.md` (T0.x and items #27, #36, #37), the `Agent.js` / `World.js` data shape, the three adapter files, and the existing chat-pairing in `AgentSprite.js` / `IsometricRenderer.js`. It introduces three new prerequisites (FC0.1–FC0.3) and absorbs item #27 of the existing plan. It overlaps with item #37 and merges by extending `_drawEmptyStateWorldCue` rather than duplicating the empty-state path.
