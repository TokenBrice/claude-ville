# Tool Rituals — Implementation Plan
Generated: 2026-04-28

## Goal

When an agent arrives at a building AND is actively using a tool that maps to that building, render a recognizable per-tool ritual at the building (hammer swing, lectern flip, telescope sweep, rune ring, crate loading, paper pin, carrier-bird, beam tinting). Today the tool→building mapping (`Agent.js:13-80`) is fully expressed in routing but invisible at the destination beyond ambient idle effects. Rituals are scoped to current Tier-0 architecture (`world-enhancement-plan.md`) and current motion budget.

## Non-goals

- New persistent agent state, new tool semantics, or any change to provider adapters' read-only contract.
- Ritual sound, music, or screen-shake.
- Per-instance variance vs. building type (visitor counts remain keyed by type per `BuildingSprite.js:1740-1758`; same-type buildings will share rituals — acceptable for the 9-building world).
- Re-implementing tool→building mapping (already complete in `Agent._buildingForToolName`).
- Cross-screen narrative (multi-step "story" arcs spanning many buildings). Each ritual is local to one building.
- Replacing `LandmarkActivity.js` overlays — those handle agent-side activity icons; rituals own the building-side response.

## User-visible outcomes

Each is a testable success criterion, observable by selecting an agent and watching the destination building.

1. **Code Forge — Edit/Write/MultiEdit/apply_patch plus code-path Read/Grep/Glob/LS:** anvil hammer swing accelerates and emits a one-shot spark ring with each mutation; code-path inspection can produce a quieter workbench cue. Idle forge glow drops to baseline within ~2 s of last edit. (Today the hammer arc at `BuildingSprite.js:1620-1658` runs continuously off `this.frame * 0.18` regardless of activity.)
2. **Lore Archive — docs/local-knowledge Read/Grep/Glob/LS:** a tome icon at the archive doorway flips one page per docs/read call; the page-flip lasts ~600 ms and the basename of `file_path` (or `pattern` for Grep) materializes briefly above the building. Code-path inspection belongs to Forge; docs-only writing remains Archive.
3. **Token Mine — token-delta from any tool:** a pickaxe icon swings inside the cave mouth on each ≥256-token delta, ejecting an ore chunk that arcs into the headframe; the seam tint lerps from amber → orange-red as `usageQuota.fiveHour` approaches 1.0. Reuses the existing token-delta detection in `LandmarkActivity._observeTokens:179-202` rather than re-walking adapter data.
4. **Research Observatory — WebSearch/WebFetch/`web.run`:** a small telescope barrel rotates from rest to point at a host-derived angle; a star-arc trails behind for ~900 ms; the URL host displays as a 6-char compact label below the dome. Time/skywatch remains ambient copy; external research is the primary workflow meaning.
5. **Portal Gate — `mcp__playwright__*`, browser/dev-server/localhost/remote preview activity:** rune-ring opacity boost and a ghost-mirror panel above the gate displays the tool's hostname or URL. Subagent orchestration does not belong here; Command Center owns `functions.spawn_agent`, `send_input`, `wait_agent`, `resume_agent`, and `close_agent`.
6. **Harbor Master — git/GitHub/deploy tool calls and parsed `gitEvents` (extends existing):** when an agent at the harbor visit-tile is mid-git/GitHub/release/deploy flow, a repo-themed crate appears on the quay; on `git push` the crate transitions onto the existing ship in `HarborTraffic.js`. Parsed commit/push events also create Harbor visit intent directly.
7. **Task Board — TodoWrite/TaskCreate/TaskUpdate/TaskList/`functions.update_plan`:** a paper item pins to the board on TaskCreate/TodoWrite (visible as a small parchment overlay above the existing board); on TaskUpdate with `status === 'completed'`, the matching paper crosses out and flutters down. Builds on `_addTaskItem` precedent at `LandmarkActivity.js:278-310`.
8. **Command Center — TeamCreate/SendMessage/Task:** TeamCreate raises a flag at the keep crown; SendMessage releases a small carrier-bird sprite that flies along the existing `chatPartner` link (already drawn as `chat-line` in `LandmarkActivity._drawConnection`) and arrives at the partner sprite tile.
9. **Pharos Lighthouse (`watchtower` internally) — passive activity proxy:** beam rotation rate scales linearly with concurrent active-WORKING agent count (1×–2.4×); beam tints from gold to orange-red when any agent has `pushStatus === 'failed'` in the harbor traffic state. Use `watchtower` in intent, allocator, ritual, and debug data; reserve "Lighthouse" for UI/prose.

## Data dependencies

### Already available

- `agent.currentTool`, `agent.currentToolInput`, `agent.lastTool`, `agent.lastToolInput` — populated by `AgentManager._upsertAgent:88-115` for every provider when the session is `WORKING` and `session.lastTool` is set.
- `agent.targetBuildingType` and `agent.lastKnownBuildingType` — derived from the same mapping the rituals must honor (`Agent.js:202-212`).
- `agent.gitEvents` — already collected and reduced into `HarborTraffic.state.batches`/`ships` via `collectGitEventsFromAgents`. Push-status crates can read directly from existing batches; no new harvest path.
- `building.isAgentVisiting(agent)` and `_visitorCountByType` (`BuildingSprite.js:1739-1758`) — already a per-frame visitor map.
- `LandmarkActivity` token-delta machinery (`LandmarkActivity.js:179-202`) — reuse the same delta threshold (≥128) but raise to ≥256 for the mine swing to keep visual cadence below ~1 Hz under heavy traffic.
- `usageQuota.fiveHour` / `usageQuota.sevenDay` — surfaced via `/api/usage` (`services/usageQuota.js:200-204`) and broadcast through `usage:updated` (`App.js:71`, `infrastructure/WebSocketClient.js:77,81`). Frontend already subscribes in `TopBar.js:30`; rituals would need the same payload exposed via `IsometricRenderer.setQuotaState({ fiveHour, sevenDay })` — a one-line wire from `App.js`.

### Gaps and per-adapter parity

| Field | claude.js | codex.js | gemini.js |
| --- | --- | --- | --- |
| `lastTool` (name) | yes — `block.name` | yes — `payload.name` or `payload.type` (`function_call`/`command_execution`) | yes — `tc.name` or `msg.toolName` |
| `lastToolInput` (raw) | yes — full input passed to `summarizeToolInput`, then truncated to 60 chars (basename for files) | yes — `payload.arguments` JSON-stringified to ≤80 chars, or `payload.command` substring | yes — args.command/args.file_path or JSON.stringify, ≤60 chars |
| Stable per-call ID | NO — Claude's `block.id` is read for git events (`claude.js:285`) but never threaded to `currentTool`/`lastTool` | NO — codex has no exposed call ID in the live session payload | NO — gemini emits messages without per-call IDs |
| URL host for observatory | partial — Claude `WebFetch` `url` field summarized to ≤60 chars; full URL is truncated | partial — codex serializes args, may include `url` | partial — gemini serializes args |
| File basename for forge/archive | yes (Claude basenames file paths; codex/gemini stringify) | partial | partial |

The **stable per-call ID gap** is the load-bearing one: rituals fire on tool-USE events, not on poll equality, and absent IDs we have to synthesize them from `(agent.id, lastTool, lastToolInput, lastSessionActivity)` — the same key shape `LandmarkActivity` uses (`activityKey`, `LandmarkActivity.js:72-80`). This is good enough for visual fidelity (false-negative rate is the cost; missed fires when input is identical across consecutive calls) and is the recommended path. See **TR0.1 Tool-event observer** below.

## Architectural prerequisites

### Cross-references (already-planned items in `world-enhancement-plan.md`)

- **T0.1 (gradient cache)** — required for ritual #5 (rune-ring boost) and ritual #1 (forge spark ring). Both compose radial gradients per emitter; without T0.1 each ritual call rebuilds gradients per frame.
- **T0.2 (`LightingState`)** — required for ritual #3 (mine seam day/night tint) and ritual #9 (lighthouse beam dawn/dusk drop). Without T0.2, every ritual that emits light reinvents day-night lerp.
- **T0.3 (`LightSourceRegistry`)** — required for rituals #1, #3, #5, #9. Forge spark ring, mine seam, rune ring, and beam tint must register and be modulatable from one place. Land before any ritual that emits new light.
- **T0.6 (motion budget)** — required for every ritual: each must check `motionScale` BEFORE allocating per-call animation state (hammer-strike phase array, page-flip frame counter, telescope angle target, carrier-bird path).
- **#36 (pulse-cue ownership)** — required before #28 in the world plan, AND before any ritual in this plan that adds pulsing motion. Ritual pulses must not overload bands already owned by selection (slow), working-status (medium), or recent-event (fast). See **Pulse band claims** below.
- **#37 (empty-state)** — adjacent: a ritual-only patch that fires only when agents-at-buildings is non-zero leaves the empty world even more silent than today. Sequence #37 first or in parallel.
- **#4 (forge glow visitor-driven)** — superseded by Sprint 1 of this plan. The forge ritual subsumes #4: hammer-driven glow modulation replaces visitor-count-driven glow modulation for the forge case. Mark #4 as folded into TR-1.

### New prerequisites (TR0.x)

- **TR0.1 — Tool-event stream.** Use the existing `AgentEventStream` in `src/presentation/character-mode/` to watch `agent:updated` events and emit `tool:invoked { agentId, tool, input, ts, building }` whenever it sees a transition where `(agent.id, lastTool, lastToolInput, lastSessionActivity)` differs from the prior snapshot. Do not add a separate `ToolEventObserver.js`; `AgentEventStream` is now the canonical presentation-side observer. Rationale: this is the single load-bearing design call. Two options:
  - **Option A (server-side, recommended NO):** extend adapters to emit a `tool:invoked` synthetic event when they parse a new tool call. Pros: every consumer sees identical events, no re-derivation. Cons: changes the read-only adapter contract (`docs/design-decisions.md` "Read-only adapter contract"), violates `Treat all provider session files as read-only inputs`, and requires per-adapter de-dup to prevent double-fire on poll cycles. Rejected.
  - **Option B (client-side, recommended YES):** subscribe to `agent:updated` on the renderer side. Snapshot `{ tool, input, sessionActivity }` per agent in a `Map`; on each event, diff against snapshot. If `tool` changed OR `input` changed OR `sessionActivity` advanced, emit `tool:invoked` and update snapshot. Pros: zero adapter changes, easy to dedupe (snapshot equality), aligns with `LandmarkActivity` precedent. Cons: ID gap means consecutive identical tool calls (e.g., two `Read` of the same file) coalesce into one event; cost is ritual under-counting, never over-counting. Accepted.
  - Keys for diff: `(currentTool, currentToolInput, lastSessionActivity)`. The third field guarantees fire on repeat-tool-same-input as long as the upstream session timestamp advances, which it does on every adapter poll cycle that picked up a new turn.

- **TR0.2 — Ritual scheduler with concurrency cap.** A small per-frame scheduler (`RitualConductor`) that holds a queue of in-flight rituals (each ritual is a state machine: pending → playing → fading → done), enforces a cap of `MAX_CONCURRENT_RITUALS = 6` across all buildings, and coalesces same-building same-tool rituals within a 250 ms window into one fire. Effort: S. Sits between `tool:invoked` and `BuildingSprite._drawFunctionalOverlay`. Rationale: at 10+ concurrent agents and 2 s polling, naive emission can stack ~20 simultaneous rituals on the same building; the scheduler keeps fill-rate predictable. See Performance ceiling.

### Pulse band claims (consumes #36)

Each ritual must take exactly one band; rituals that already own theirs in the world plan are noted.

| Ritual | Band | Cadence | Note |
| --- | --- | --- | --- |
| Forge hammer | medium (~600 ms) | per tool call, 3-strike burst @ ~6 Hz | replaces continuous `Math.sin(this.frame * 0.18)` swing at `BuildingSprite.js:1621`; ambient idle uses static (no pulse) |
| Forge spark ring | recent-event flash (<300 ms) | per tool call, single ring | matches #36 "fast" band for new-event |
| Archive page flip | medium | per tool call, 600 ms | book-flip is one motion, not a band-claim |
| Archive crest pulse | static | always | replace existing pulse in `_drawArchiveEnhancement:1162-1189` with steady alpha, per #36 |
| Mine pickaxe swing | medium | per token-delta, 1.6 Hz | one swing per ≥256 token delta |
| Mine seam glow | static day, slow at dusk | continuous | reads `LightingState.lightBoost` (T0.2) |
| Observatory telescope | slow (>1 s) | per WebFetch, 900 ms sweep | one band-claim per ritual |
| Portal rune ring | medium | per tool call, 1.2 Hz boost | augments existing band at `BuildingSprite.js:980` |
| Harbor crate | n/a (no motion; static prop) | per git event | no pulse |
| Task paper | recent-event flash | per TaskCreate, 250 ms appear | once per pin |
| Command flag | static | persistent until TeamCreate timeout | no pulse |
| Carrier-bird | medium | per SendMessage, ~2 s flight | path-bound motion, not pulse |
| Lighthouse beam | slow | continuous, scaled rate | already declared in T0.3 registry; #24 owns base motion |

## Phases / sprints

Five sprints. Each ends with a demoable result and a smoke check. Items list **Domain · File:line · Effort · Impact · Depends on**.

### Sprint 1 — Plumbing (no new visuals)

Land the event observer and the scheduler before any building-side work. Failure mode is silent: if TR0.1/TR0.2 misbehave, Sprint 2+ rituals fire incorrectly.

**1.1 Use TR0.1 tool-event stream**
**Domain:** Presentation · **File:** `src/presentation/character-mode/AgentEventStream.js` · **Effort:** S · **Impact:** Medium (gate for everything else) · **Depends on:** none.

Subscribe to `agent:updated` via `eventBus`. Maintain `Map<agentId, { tool, input, sessionActivity }>`. On change, emit `tool:invoked { agentId, tool, input, building, ts }` where `building` follows the shared classifier. Reset snapshot on `agent:removed`. No-op when `agent.status !== AgentStatus.WORKING`. Reduced-motion: still emit (rituals decide whether to render); no motion-budget check at the stream layer.

**1.2 Implement TR0.2 RitualConductor**
**Domain:** Presentation · **File:** new `src/presentation/character-mode/RitualConductor.js` · **Effort:** S · **Impact:** Medium · **Depends on:** 1.1.

Subscribe to `tool:invoked`. For each event resolve `building = world.buildings.get(payload.building)`, look up the matching agent sprite via `IsometricRenderer.agentSprites`, and verify visit-state via `building.isAgentVisiting(agent)`. If both pass, register a ritual with a state machine and TTL. Per-frame `update(dt)` advances state. Cap at `MAX_CONCURRENT_RITUALS = 6` (oldest-first eviction). Coalesce same-(building, tool) within 250 ms. Reduced-motion: state machine still ticks but skips motion-bearing phases (see per-ritual notes below). Expose `getActiveRitualsForBuilding(type)` for `BuildingSprite._drawFunctionalOverlay` to read.

**1.3 Wire renderer → conductor**
**Domain:** Presentation · **File:** `IsometricRenderer.js:300-310` (alongside `harborTraffic` / `landmarkActivity` construction), `update` flow at `IsometricRenderer.js:1220-1226` · **Effort:** S · **Impact:** Medium · **Depends on:** 1.2.

Construct `ritualConductor` next to `landmarkActivity`. Call `ritualConductor.update(dt)` each tick. Pass active-rituals query into `BuildingSprite` via a setter (`setRitualState(snapshot)`) called once per frame. No new drawables yet — Sprint 2 begins emitting visuals.

**1.4 Expose quota state to renderer**
**Domain:** Presentation · **File:** `App.js` (subscribe `usage:updated` once and call `renderer.setQuotaState`) · **Effort:** S · **Impact:** Low (mine ritual only) · **Depends on:** none.

`App.js:71` already fetches usage; piggyback on the existing subscription path to call a new `IsometricRenderer.setQuotaState({ fiveHour, sevenDay })` storing on the renderer. Mine ritual reads from there in Sprint 3. Reduced-motion: irrelevant.

**Sprint 1 demo:** open the dashboard, trigger any tool call from a Claude session at any building's visit tile; observe that `tool:invoked` fires (console-log gate temporarily during dev) and that `RitualConductor.getActiveRitualsForBuilding('forge')` returns one entry. No visual change yet.

**Classifier alignment examples:** `functions.spawn_agent` routes to Command, Playwright/browser routes to Portal, WebFetch/WebSearch routes to Observatory, code-path `Read/Grep/Glob/LS` routes to Forge with `inspect-code`, docs reads stay Archive, `git push` routes to Harbor and failed push state can additionally trigger Lighthouse/watchtower.

**Smoke check:** `npm run dev`; open `http://localhost:4000`; confirm console has no errors and `agent:updated` flow still dispatches via `eventBus`. (Validation matrix row: "Anything under `src/`".)

### Sprint 2 — Forge ritual + Archive page flip (highest-frequency rituals)

Forge and Archive cover Edit/Write/Read/Grep/Glob — the most common tools. Land them first.

**2.1 Forge hammer-strike + spark ring**
**Domain:** Buildings · **File:** `BuildingSprite.js:945-947` (forge branch in `_drawFunctionalOverlay`), new helper `_drawForgeRitual` near `_drawForgeAnvil:1620-1658`, light registration in `BuildingSprite.getLightSources` · **Effort:** M · **Impact:** High · **Depends on:** Sprint 1, T0.1, T0.3 (folds in #4).

Replace continuous hammer swing with a 3-strike burst (each strike ~100 ms, total ~600 ms) triggered per ritual. After the burst, hammer rests at the down-position. Spark ring: an additive radial expanding from anvil center over 250 ms, registered as a transient `LightSourceRegistry` entry with `kind: 'spark'`, `radius` lerping 14 → 36, `alpha` lerping 0.6 → 0; reads `LightingState.lightBoost` for day-suppression. Hearth glow stays steady (idle baseline, no pulse, per #36 static band) and is folded into ritual brightness (rituals raise it for ~900 ms of decay). Reduced-motion: spark ring becomes a single static circle for 200 ms; hammer holds the down-position; no spark animation.

Caveat: `BuildingSprite._visitorCountFor` is type-keyed; if both forges existed (today there is one), they would share visitor count. Document and accept.

**2.2 Archive page-flip + basename label**
**Domain:** Buildings · **File:** `BuildingSprite.js:1000-1002` (archive branch), new helper `_drawArchiveRitual`, label render in same module's existing label pipeline · **Effort:** M · **Impact:** High · **Depends on:** Sprint 1.

A book sprite at the archive doorway (existing local point `localPoint(168, 130)` from `_drawArchiveEnhancement`). On `tool:invoked`, run a 600 ms flip animation: 6 keyframes interpolating page-tilt 0° → 90° → 0°. Above it, render the basename of `currentToolInput` (Claude already provides `file_path.split('/').pop()` summary) for 1.4 s with fade-out. Static crest pulse from `_drawArchiveEnhancement` is replaced with steady alpha (claims #36). Reduced-motion: render the page in a fixed half-flipped pose for 600 ms; skip frame interpolation.

**2.3 New manifest entries**
**Domain:** Sprite assets · **File:** `claudeville/assets/sprites/manifest.yaml` (new entries beneath each building's section), `scripts/sprites/generate.md` reference for prompts · **Effort:** S · **Impact:** Medium · **Depends on:** none.

Add procedural-first/manifest-fallback strategy:
- `building.forge.spark` (32×32 sprite, single frame, transparent) — fallback for the spark icon if procedural render is too thin.
- `building.archive.tome` (40×40 sprite, 6-frame strip horizontally, page-flip animation) — required asset.
Pixellab tool: `mcp__pixellab__animate_character` for the tome flip; `mcp__pixellab__create_isometric_tile` for the spark static image. New entries follow the existing pattern at `manifest.yaml:341-368`. Bump `style.assetVersion`.

**Sprint 2 demo:** active Edit on a forge-eligible file produces a hammer burst + spark ring; active Read on a non-doc file produces a tome flip + basename label.

**Smoke check:** `npm run sprites:validate` (manifest ↔ PNG); open the dashboard, run a Claude Edit at a forge visit tile, verify single ritual; `npm run sprites:capture-fresh && npm run sprites:visual-diff` for regression on archive/forge baselines.

### Sprint 3 — Mine, Observatory, Portal

**3.1 Mine pickaxe swing + seam tint**
**Domain:** Buildings · **File:** `BuildingSprite.js:947-968` (mine branch in `_drawFunctionalOverlay`), new helper · **Effort:** M · **Impact:** High · **Depends on:** Sprint 1, T0.2, T0.3, 1.4.

On any token delta ≥256 from any visiting agent, swing a pickaxe icon inside the cave mouth (1.6 Hz, 1 s playthrough), eject one ore-chunk particle through the existing `mining` particle preset. Seam tint reads `quotaState.fiveHour ?? 0`: 0..0.5 → amber `#ffc15a` (current), 0.5..0.8 → orange `#ff8a33`, 0.8..1.0 → red `#ff4528`. Day-suppress via `LightingState.lightBoost`. Reduced-motion: skip pickaxe motion; still update seam tint; spawn 1 static ore-chunk per delta event.

Reuse `LandmarkActivity._observeTokens:179-202` rather than re-walking adapter data — wire it to emit a synthetic `tool:invoked { tool: '__token_delta', input: delta }` (or expose a separate `token:delta` event the conductor subscribes to). Recommended: single conductor with a synthetic tool name to keep the scheduler interface uniform.

**3.2 Observatory telescope sweep + URL host label**
**Domain:** Buildings · **File:** `BuildingSprite.js:938-944` (observatory branch), new helper `_drawObservatoryRitual` adjacent to `_drawObservatoryClock:1006-1022` · **Effort:** M · **Impact:** Medium · **Depends on:** Sprint 1.

A telescope barrel sprite anchored above the clock face. On WebFetch/WebSearch invocation, parse a host from `currentToolInput` via `new URL(...)` (defensive — tool input may be a search query, not a URL). Compute target angle via `(hash(host) % 360) - 90`. Tween barrel angle over 700 ms, then trace a star-arc (8 sparkle particles along the arc) for 200 ms. Display 6-char host label below dome for 1.4 s. Falls back to a generic 360° pan when no URL is parseable (e.g., WebSearch query). Reduced-motion: snap barrel to target instantly; skip arc; show label.

**3.3 Portal ghost-mirror panel + rune-ring boost**
**Domain:** Buildings · **File:** `BuildingSprite.js:969-992` (portal branch — augment existing rune-ring code) · **Effort:** S · **Impact:** Medium · **Depends on:** Sprint 1, T0.1 (rune ring already uses radial-style modulation).

Existing rune-ring boost at `BuildingSprite.js:976` already responds to `_visitorCountFor`. Augment to read active-ritual count for portal. New ghost-mirror: a small parchment panel above the gate with the URL host (or `mcp__playwright__browser_*` action verb if no URL). 1.6 s fade-in, hold 2 s, fade-out 600 ms. Reduced-motion: skip fade; show panel statically for 1 s.

**Sprint 3 demo:** WebFetch from any agent at the observatory visit tile produces a barrel sweep + host label; mcp__playwright__browser_navigate produces a ghost-mirror panel; token delta produces a pickaxe swing; quota approaching 80% turns the seam orange.

**Smoke check:** `npm run sprites:validate` (any new sprite IDs); manual: trigger one of each tool, confirm one ritual per call, no flicker, no double-fire.

### Sprint 4 — Task Board + Command Center + Harbor crate

**4.1 Task Board parchment pin + completion flutter**
**Domain:** Buildings · **File:** `BuildingSprite.js` (new `_drawTaskboardRitual`), wires through TR0.2; existing `_addTaskItem` (`LandmarkActivity.js:278-310`) is the precedent · **Effort:** M · **Impact:** High · **Depends on:** Sprint 1.

On TaskCreate/TodoWrite, pin a small parchment overlay on the task-board face at the existing emitter coord `[56, 58]` (manifest fallback in `BUILDING_EMITTER_FALLBACKS.taskboard`). On TaskUpdate where the input contains `status: 'completed'` (parsed from `currentToolInput`), find the matching pinned paper (by hash of original `currentToolInput.id` if available, else by FIFO oldest), draw a strikethrough, then over 800 ms translate it down + fade out. Maximum 4 pins on-board at once (oldest evicted with no flutter). Reduced-motion: instant strike + fade; skip translate.

Caveat: TaskUpdate→TaskCreate matching needs an in-memory Map keyed by task identifier; if the adapter input doesn't carry a stable id, fall back to FIFO oldest pin. Document expected coverage: Claude provides `id` in TodoWrite input → reliable matching; codex/gemini may not → fallback path.

**4.2 Command Center flag + carrier-bird**
**Domain:** Buildings · **File:** `BuildingSprite.js` (new `_drawCommandRitual`), connector visible already via `LandmarkActivity._observeCommandRelationships:204-256` and `chat-line` drawing · **Effort:** M · **Impact:** Medium · **Depends on:** Sprint 1, depends on `chatPartner` resolution for SendMessage path.

TeamCreate raises a small banner at the keep crown for 4 s (no pulse, static). SendMessage releases a carrier-bird sprite that follows a quadratic Bezier from the command keep to the chat-partner sprite (resolved via `AgentSprite.chatPartner`); arrives in 1.6 s; on arrival emits a single sparkle and despawns. If `chatPartner` is null (recipient not found in current world), bird flies in a short circle and despawns at the source. Reduced-motion: skip bird; show banner as a single-frame icon over the keep for 1.5 s.

**4.3 Harbor crate (extends `HarborTraffic`)**
**Domain:** Buildings/Scenery · **File:** `HarborTraffic.js:716-746` (extend `HarborTraffic.update`), `_drawShip:1082-1111` (overlay one or two crate sprites if the ship's batch has ≥2 commits), or new `_drawDockedCrates` adjacent · **Effort:** M · **Impact:** Medium · **Depends on:** Sprint 1.

Pre-push: when an agent at the harbor visit tile is mid-`git diff`/`git status` (regex match in `TOOL_PATTERNS` for harbor at `Agent.js:73`), spawn a transient crate prop on the docked ship of the same project (lookup via `state.ships` filtered by `project`). The crate persists until the next push (which transitions the ship to `departing`) or 30 s, whichever comes first. Use existing `prop.harborCrates` sprite (`manifest.yaml:477-481`). Reduced-motion: spawn the crate statically; no easing.

**Sprint 4 demo:** create a TodoWrite list at the taskboard tile, see papers pin; mark one completed, watch it flutter; trigger TeamCreate, see banner; SendMessage from one agent to another with both visible, watch carrier-bird; run `git diff` from a harbor-visiting agent, see crate appear on the docked ship.

**Smoke check:** `npm run sprites:validate`; manual ritual fires for each.

### Sprint 5 — Lighthouse beam scaling + tint

**5.1 Lighthouse beam rate-of-rotation scales with active count**
**Domain:** Buildings · **File:** `BuildingSprite.js` (existing `LIGHT_SOURCE_REGISTRY.watchtower` at lines 92-105 already declares the beam; consumer in `IsometricRenderer.js:1217, 3641` reads via `getLightSources`). New beam-rotation logic in `BuildingSprite._drawAnimatedOverlays` watchtower path or a new `_drawWatchtowerBeam` consumer at the same site as `_drawWatchtowerFire:1660-1713`. · **Effort:** S · **Impact:** Medium · **Depends on:** Sprint 1, T0.2, T0.3, world-plan #24 (lighthouse beam geometry).

Beam rotation rate `omega = base_omega * (1 + min(1.4, active_working_count / 5))`. Beam color hue: gold `#ffd36a` baseline; if any harbor batch has `status === 'failed'`, lerp to red-orange `#ff7a4f` over 1.5 s, hold while failed batches exist, fade back over 2 s after they clear. `LightingState.lightBoost` modulates beam alpha (day-dim). Reduced-motion: beam holds at fixed angle (already declared by world plan #24); tint changes still apply.

Note: this ritual is **passive** (continuous, no per-tool trigger). It's included in this plan because the user-visible outcome promised "beam rotation accelerates with active session count; tints red on error states" and the implementation site overlaps the ritual machinery. If world-plan #24 is shipped first, this becomes a one-property addition.

**Sprint 5 demo:** open with one agent → beam rotates slowly; spawn 5 sessions → beam clearly faster; trigger a failed push (or simulate via dev shim) → beam tint goes red until the failed batch clears.

**Smoke check:** `npm run dev`; visually compare 1-agent and 5-agent states; `sprites:visual-diff` on lighthouse baseline (expect motion-band differences only).

## Risks & tradeoffs

- **Per-call ID gap (highest risk).** Without per-tool-call stable IDs, two consecutive identical tool calls (`Read foo.js` followed by `Read foo.js`) coalesce into one ritual — a missed event, not a wrong event. We tolerate this. The fallback (synthesize from `lastSessionActivity` advancing) covers ~90% of real cases at 2 s polling. If the user later wants 1:1 ritual fidelity, adapters would need to expose tool-call IDs (Claude's `block.id` is already there in `claude.js:285` but unused for the live path).
- **Adapter parity.** Codex and Gemini's tool input is JSON-stringified rather than basenamed. Forge/archive labels will look noisier on those providers (full JSON snippet vs. clean basename). Acceptable for v1 — explicitly stated as a degradation in `## Data dependencies`. Future: per-adapter `summarizeToolInput` parity work.
- **Visual-grammar overload.** Adding 9 ritual classes in addition to existing ambient effects, harbor traffic, landmark activity, and atmosphere risks confetti-canvas (`docs/visual-experience-crafting.md` §11). Mitigations: (1) `MAX_CONCURRENT_RITUALS = 6` cap; (2) coalesce same-(building, tool) within 250 ms; (3) static-band rituals (banner, crate, mine seam tint) carry no motion; (4) reduced-motion fallback for every motion-bearing ritual; (5) sequence #36 (pulse-cue ownership) before any new pulsing ritual.
- **Performance hotspot.** Spark ring + rune-ring + telescope arc all compose radial gradients and additive composites. Without T0.1 these allocate per-frame. Land T0.1 before Sprint 2; Sprint 5 lighthouse beam tint reads existing `LightSourceRegistry` so no new gradient allocation if T0.3 lands.
- **Folded vs. duplicated motion.** Forge ritual (TR-2.1) replaces #4 (forge glow visitor-driven) and replaces continuous hammer swing at `BuildingSprite.js:1621`. Mine ritual partially overlaps with `LandmarkActivity._observeTokens:179-202`. The plan reuses LandmarkActivity's token-delta detection rather than duplicating, but moves the visual response from agent-side (existing `_drawTokenItem`) to building-side. If both fire (existing token icon at agent + new pickaxe swing at mine), it's double-cue. Decide in Sprint 3: either (a) suppress LandmarkActivity's `_addTokenItem` emission when the conductor will fire the mine ritual, or (b) keep both — agent-side icon as identity, building-side as work-evidence. Recommended: (a) suppress to avoid noise; (b) makes the world-plan #36 violation of "do not double-encode."
- **Empty world.** As today, an idle world shows no rituals (rituals fire only when agents-at-buildings is non-zero). Coupled with #37 (empty-state work) — the plans don't conflict but the user-facing release of rituals should ship after #37 to avoid making the empty case worse by contrast.

## Validation

Per-sprint checks aligned with `claudeville/CLAUDE.md` validation matrix.

| Sprint | Smoke | Visual diff | Adapter sanity |
| --- | --- | --- | --- |
| 1 | `npm run dev`; `tool:invoked` visible in console behind dev flag; no event leaks on `agent:removed` | n/a (no visuals) | n/a |
| 2 | `npm run sprites:validate`; open page; trigger Claude Edit at forge tile; trigger Read at archive tile; observe single ritual per call | `npm run sprites:capture-fresh && sprites:visual-diff` against forge/archive baselines (motion-band differences expected) | confirm Claude Edit `file_path` flows to label |
| 3 | manual: WebFetch with valid URL produces host label; WebSearch with query produces generic pan; mcp__playwright__browser_navigate fires portal ritual; token delta fires mine | sprites:visual-diff for observatory and portal baselines | confirm codex `function_call` with `playwright` name routes to portal (TOOL_PATTERNS in Agent.js) |
| 4 | manual: TodoWrite pins paper; TaskUpdate with completed status flutters; TeamCreate raises banner; SendMessage with active partner emits bird; git diff at harbor visit tile spawns crate | sprites:visual-diff for taskboard/command/harbor | adapter parity: gemini's TaskUpdate may lack stable id — verify FIFO fallback fires |
| 5 | `npm run dev`; vary session count; verify beam rotation rate scales; simulate failed push (drop a `success: false` event into harbor traffic state via dev shim) and verify tint | sprites:visual-diff lighthouse | n/a |

Pre-final: docs scan `rg -n -P "\p{Hangul}" $(rg --files -g '*.md' --glob '!node_modules')` empty (no Korean introduced).

## Open questions

1. **TR0.1 location:** keep in `src/presentation/character-mode/` (plan default) or promote to `src/application/` for dashboard-mode reuse? The dashboard already shows tool history per agent; rituals don't apply there. Recommend `presentation/character-mode/` until a second consumer emerges.
2. **Token-delta source-of-truth:** continue using `LandmarkActivity._observeTokens` and emit a synthetic `tool:invoked` from there into `RitualConductor`, OR move token-delta detection wholly into `RitualConductor` and remove from LandmarkActivity? Recommend the former (less churn) but flag the duplication if both fire visually (see Risks bullet 5).
3. **Per-instance vs per-type rituals:** the plan accepts type-keyed visitor counts (caveat from `world-enhancement-plan.md` #4). If the user expects two forges to fire independent rituals, that requires refactoring `_visitorCountByType` to be instance-keyed. Out of scope unless user confirms it matters.
4. **Pixellab budget:** the only required new asset is `building.archive.tome` (6-frame flip strip ~40×40). Forge spark, telescope barrel, parchment paper, banner, carrier-bird can be procedural canvas drawing (cheaper, motion-flexible). Confirm: prefer procedural-first or commission all 7 sprites?
5. **Failed-push tint trigger:** Sprint 5 reads from `harborTraffic.state.batches` for `status === 'failed'`. If git push status detection (`HarborTraffic.normalizePushStatus:440-458`) misses a failure (returns 'unknown'), beam stays gold. Acceptable, but worth confirming the user wants strict-failure-only or also unknown-treated-as-suspect.
6. **Adapter ID field:** Claude already stores `block.id` per tool_use in `claude.js:285` but only uses it for git events. Investing 1–2 hours to thread `block.id` through `summarizeToolInput`/`AgentManager` would close most of the per-call ID gap for Claude users at zero per-event cost. Should this be folded into Sprint 1, or deferred?

## Cumulative cost note

Per-frame additions vs. today, assuming all 5 sprints land and `MAX_CONCURRENT_RITUALS = 6`:

- 1 `tool:invoked` snapshot diff per `agent:updated` event — fires at most once per 2 s per agent; trivial.
- 1 RitualConductor scheduling tick per frame — O(active rituals); ≤6 entries; trivial.
- Up to 6 concurrent ritual draws per frame, each costing roughly:
  - Forge spark ring: 1 cached gradient (T0.1) + 1 additive arc draw — ~0.05 ms.
  - Archive tome: 1 sprite blit — already cheap (`SpriteRenderer` integer-snap).
  - Mine pickaxe + ore: 1 sprite + 1 particle — already in budget.
  - Observatory: 1 sprite rotation (canvas `transform`) + ~8 particles for arc — moderate.
  - Portal: 1 cached gradient + 1 panel rect + 1 text draw — cheap.
  - Lighthouse: same as world-plan #24, 0 net delta beyond #24's cost.
- Static rituals (banner, crate, mine tint): no per-frame cost beyond the static prop blit.
- Observer + scheduler memory: ~6 active rituals × small object = trivial; agent snapshot Map ~10 entries × small object = trivial.

Estimated per-frame addition at peak (10 agents, 6 rituals firing): **< 0.6 ms** beyond today's baseline, dominated by additive composites in spark ring + portal mirror. Profile target: hold 60 fps at 1080p on integrated GPU during a 10-agent stress run; verify before promoting Sprint 5 to main.
