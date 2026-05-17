# Buildings & Spatial — Council Research

Date: 2026-05-17
Status: reference
Baseline HEAD: e919f845c5074487c694d6aa163968df48728de1
Initial git status: ` M AGENTS.md\n M CLAUDE.md`

## Method

Read all nine building defs in `buildings.js` (full), roads/districts in `townPlan.js`, scenery placements in `scenery.js`, and building/prop entries in `manifest.yaml` (lines 290–722). Cross-referenced render in `BuildingSprite.js` (visitor counts at L2668–2687, label render at L324–588, atmosphere reactions at L1041–1100, light sources at L857–890), activity-driven intent in `VisitIntentManager.js`, landmark glyphs in `LandmarkActivity.js`, `Building` domain, plus existing plans (`agent-building-interactions-refinement.md`, `village-gate-redesign-design.md`, `center-island-implementation.md`, `forest-sprite-opportunities.md`, `world-enhancement-plan.md`, `feature-foundation.md`, `north-lagoon-sprint.md`). Verified each new prop ID against the manifest before citing.

## Building Audit

Visual signal = how well sprite + overlays announce function at zoom 2 with no agents. Info density = how much runtime state is visible.

| Building (pos / size / tier) | Current purpose | Serves today | Visual | Info | Notes |
| --- | --- | --- | --- | --- | --- |
| Command (13,16 5x4 hero) | Team / orchestration | Task summons, team, parent-intent fallback (`VisitIntentManager.js:281–301`); dispatch + chat lines (`LandmarkActivity.js:200–252`) | 5 | 3 | Plaza arc has 2 braziers + fountain (`scenery.js:362–364`); agents still stack at front. |
| Task Board (21,31 4x3 hero) | Quest / verify | Validation handoffs (L159–177); persistent papers (`BuildingSprite.js:1302–1407`) | 3 | 4 | Board small relative to footprint; blue roof reads "civic" not "task." |
| Code Forge (26,26 4x3 major) | Code mutation | Forge intents, handoff to Task Board, glow ritual (`BuildingSprite.js:1284–1300`) | 4 | 4 | Workshop yard has no smithing props — no anvil, log pile, wood-chip path. |
| Token Mine (11,31 4x3 major) | Token usage | Delta intents, quota sentinels (L198–230); oreCart only as token glyph (`LandmarkActivity.js:497–502`) | 4 | 3 | Yard bare; no rail tile on the ground, no spoil heap. |
| Grand Lore Archive (3,15 5x3 hero) | Read / search | Read/Grep/Glob default; capacity 4+6 overflow (`buildings.js:141`) | 5 | 2 | Biggest sightline + tallPropClearance. Still the most over-visited destination (`agent-building-interactions-refinement.md:81–93`). |
| Research Observatory (21,14 4x4 hero) | External research / sky | WebFetch/WebSearch + clock overlay; gemini home | 4 | 3 | Copper-blue palette easy to confuse with Command at distance. |
| Portal Gate (5,29 4x4 hero) | Browser & remote tools | Browser tools, dev-server preview; subagent emphasis partly migrated to Command | 5 | 3 | Strongest fantasy silhouette but functionally smallest job today. |
| Pharos Lighthouse (27,8 3x5 hero) | Sea watch / beacon | Failed-push, high-activity sentries, long-wait watch (L259–272, 303–331) | 5 | 4 | Smallest capacity (2/1/1); underused at noon. |
| Harbor Master (30,17 5x4 major) | Commits & pushes | Git → harbor intents; pendingRepos label ledger (`BuildingSprite.js:488–531`); ship traffic via `HarborTraffic.js` | 5 | 5 | Richest building; owns the ledger pattern. |

## Current State Verdict

The hero geometry is right and most functional plumbing exists (`VisitIntentManager`, `LandmarkActivity`, ritual conductor, atmosphere reactions, lighting registry). The weakness is **legibility per zoom**: at typical zoom 2 a 1-agent and a 5-agent building look identical except for a 7px banner. The Archive doubles as the search default, the Forge yard has no work-yard scenery, the Mine yard has no on-ground cart-track, and the Watchtower / Portal under-earn their hero silhouette during the 80% of time when no failed push or web preview is happening. Sub-zones between hero buildings are mostly bare path with occasional braziers; only the central island and the harbor have deliberate placemaking.

## Recommendations

### R1 — Building "presence pulse" tied to occupancy + recency

- Impact: high · Effort: medium · Confidence: high
- Problem: occupants are read only via the 7px banner in `drawBubbles` (`BuildingSprite.js:780–832`) and a global window-warmth (`BuildingSprite.js:1041–1100`). 1-agent vs 5-agent buildings look identical at zoom 2; no recency decay.
- Proposal: derive a three-tier state per building (`dormant`/`occupied`/`busy`) from `_visitorCountByType` plus a 60s recency score. Map to (a) emitter chance multipliers in `BUILDING_EMITTER_FALLBACKS`, (b) `lightSource.radius` boost (already used for forge/watchtower at L866–873), and (c) a doorway warm-light overlay reused for all buildings. Thresholds come from the existing capacity model: `count >= work` → busy, `count > 0` → occupied (`buildings.js:13, 46, 79, 110, 141, 174, 205, 236, 264`).
- Touchpoints: `BuildingSprite.js:259–265` (update), L2660–2666 (`_spawnBuildingParticle`), L855–890 (`getLightSources`).
- New manifest IDs: none.
- Dependencies: none.
- Validation: at `localhost:4000`, fill a building 0→3 agents and confirm light + emitters change per state; reduced-motion fallback uses radius only.

### R2 — Building info-overlay on click (panel-anchored detail)

- Impact: high · Effort: medium · Confidence: medium
- Problem: `BuildingSprite.hitTest` (L964–976) returns the building, but there is no UI surface that opens building-scoped detail (occupants, rituals, last activity, harbor pendingRepos, forge patches, mine deltas). Hover banner is the only feedback.
- Proposal: route a `building:selected` event through `eventBus` and surface a building-detail card in `ActivityPanel.js` (reuse the 320px panel). Per building show: occupants (click-through to agent select), last 3 tools mapped here in 5 min, quota state if any. Mirror `agent:selected/deselected` semantics.
- Touchpoints: `BuildingSprite.js:964–976` (no change), `IsometricRenderer.js` click handler, new `ActivityPanel.js` branch.
- New assets: none.
- Dependencies: preserve existing agent select; add `building:selected` mirror.
- Validation: click building, panel; click agent, panel switches; click empty, closes.

### R3 — Per-building night-window glow

- Impact: medium · Effort: low · Confidence: high
- Problem: `windowWarmth` is one global value applied to every building uniformly (`BuildingSprite.js:1041–1100`). Occupancy never drives windows.
- Proposal: multiply per-building warmth by `0.45 + 0.55 * occupancyTier` (R1) — empty Forge at night dim, packed Command at any hour lit. Reuse `_buildingReactionLightPoints` so no new geometry.
- Touchpoints: `BuildingSprite.js:1041–1100`.
- New assets: none.
- Dependencies: R1.
- Validation: scrub day/night with one occupied + one empty building; only occupied glows at noon.

### R4 — Workshop district scenery (Forge yard)

- Impact: medium · Effort: low · Confidence: high
- Problem: workshop district has zero entries in `DISTRICT_PROPS` (`scenery.js:361–399`).
- Proposal: add `prop.scrollCrates` (verified `manifest.yaml:525–529`), `prop.runestone` (L519–523) at entrance, `prop.runeBrazier` (L627–631) on the handoff path to Task Board. Mark `district: 'workshop'`.
- Touchpoints: `scenery.js:361–399`.
- New manifest IDs: none.
- Dependencies: none.
- Validation: `npm run dev`; no walkability regression on `production-row` / `west-production-road`.

### R5 — Mine yard cart presence

- Impact: medium · Effort: low (config); medium with new sprite · Confidence: high
- Problem: mine façade shows rails but nothing continues onto the ground. `prop.oreCart` (`manifest.yaml:531–535`) appears only as a token glyph in `LandmarkActivity._drawTokenItem` (L492–508), not as yard scenery.
- Proposal: keep config-only: add two `prop.oreCart` placements + one `prop.harborCrates` (`manifest.yaml:615–619`) standing in for raw ore along `production-row` (`townPlan.js:55–60`) near the entrance (13,35). New `prop.mineRailSegment` is optional.
- Touchpoints: `scenery.js:361–399`.
- New manifest IDs: optional `prop.mineRailSegment` (32px iso, parallel rails on dirt).
- Dependencies: R4 (same array).
- Validation: visual diff via `sprites:capture-fresh` + `sprites:visual-diff`; agents on `production-row` still route.

### R6 — Archive shelf-fill keyed to read-tool counter

- Impact: high · Effort: medium · Confidence: medium
- Problem: Archive emits 3 `archiveMote` sparkles regardless of activity (`BuildingSprite.js:90–95`); no feedback on how much reading happens.
- Proposal: per-Archive rolling counter of Read/Grep/Glob in `LandmarkActivity` (sibling to forge handoff cache, L99–101), decayed over 2 min. Map to overlay on the front window (`lightSource [168, 88]`): 0–1 faint, 6+ bright + door paper-particle.
- Touchpoints: `LandmarkActivity.js:108–120`; `BuildingSprite.js:1249–1250` (`_drawArchiveEnhancement` exists).
- New assets: optional `archivePaper` particle; reuse `archiveMote` for zero generation.
- Dependencies: R1 helps; not required.
- Validation: simulate Read traffic → fill rises + fades.

### R7 — Observatory clock rotation tied to WebFetch

- Impact: medium · Effort: low · Confidence: medium
- Problem: `OBSERVATORY_CLOCK_FACE` drives clock hands but the dome is static; WebFetch/WebSearch only emit sparkles.
- Proposal: when any agent's tool ∈ {WebFetch, WebSearch}, slowly rotate the cached `_clockCanvas` (`BuildingSprite.js:194–195`) by a fraction of `frame`; reset to time mode when idle.
- Touchpoints: clock draw path L120–134; `_latestRitual` (L1263).
- New assets: none.
- Dependencies: existing ritual conductor.
- Validation: trigger WebSearch → rotation; idle → reset.

### R8 — Plaza & alley sub-zones between hero buildings

- Impact: high · Effort: low · Confidence: high
- Problem: the north-bank promenade (`townPlan.js:50–53`) connects Command↔Observatory empty save for braziers. Same for Forge (26,26) ↔ Task Board (21,31) and the gate-avenue spine. Dead zones at zoom 2.
- Proposal: add a civic sub-plaza on the north promenade with `prop.well` (`manifest.yaml:537–541`) at ~(17,17), `prop.flowerCart` (L549–553) at ~(19,18), `prop.signpost` (L513–517) at the bridge junction (16,20); add `prop.marketStall` (L543–547) and `prop.noticePillar` (L555–559) along gate-avenue at ~(20,28). All IDs verified.
- Touchpoints: `scenery.js:361–399`.
- New manifest IDs: none.
- Dependencies: none.
- Validation: `npm run dev`; confirm props sit beside (not on) road tiles; agents still follow `north-bank-promenade` / `gate-avenue`.

### R9 — State-aware hero label banners

- Impact: medium · Effort: low · Confidence: high
- Problem: banners (`drawLabels`, L324–588) show icon + name + count but no state.
- Proposal: when `_visitorCountFor(b) > 0`, brighten the accent in `LANDMARK_LABEL_ACCENTS` (L32–42) and add a tiny dot before the emblem. For Watchtower with `failedPushActive`, swap accent to `#ff755d` (mirrors L872).
- Touchpoints: `BuildingSprite.js:345`.
- New assets: none.
- Dependencies: R1.
- Validation: failed push → watchtower banner red; clear → returns.

### R10 — Portal two-step "browser-active" state

- Impact: medium · Effort: medium · Confidence: medium
- Problem: portal already has ritual orbits + visitor halo (`BuildingSprite.js:1213–1239`), but no representation of the dev-server + browser-nav two-step the agent-building plan calls for (`agent-building-interactions-refinement.md:592–602`). Today portal visit = single ring-pulse.
- Proposal: surface two ritual sub-states — `portal-preview` (single inner ring, cool blue) and `portal-active` (full ring stack + small floating screen prop). Drive from tool detection: `mcp__plugin_playwright_playwright__*` or `WebFetch` against `localhost:*` → active. Hook into existing `_drawPortalRitual`.
- Touchpoints: `BuildingSprite.js:1213–1240`; extend `ToolIdentity.js`.
- New assets: optional `prop.portalPreviewScreen`; skip for zero-generation.
- Dependencies: ToolIdentity work shared with R7, R6.
- Validation: start dev server in a session → preview; navigate external → active.

### R11 — Watchtower idle behavior: lookout sweep + sea markers

- Impact: medium · Effort: low · Confidence: high
- Problem: watchtower lantern is steady; only failed-push / high-activity changes it (`_watchtowerIntensity:849–853`). 80% of time it feels static.
- Proposal: keep lantern constant, add a slow gull orbit (`prop.gullFlight.*` verified `manifest.yaml:639–667`) over the watchtower (~30s loop, pegged ~28,12). Add 2 `prop.harborBeaconBuoy` (L675–679) on the sea line for sightline reinforcement.
- Touchpoints: gull route system (see `north-lagoon-sprint.md` A4); buoys in `scenery.js:361–399`.
- New assets: none.
- Dependencies: north-lagoon-sprint A4 route extension.
- Validation: zoom 2, gull loops; no FPS regression.

### R12 — Mine ↔ Portal corridor stitch

- Impact: low · Effort: low · Confidence: medium
- Problem: Portal (5,29) and Mine (11,31) are 6 tiles apart with no transit scenery; `arcane` + `resource` districts read as two islands.
- Proposal: place `prop.runestone` + `prop.lantern` (`manifest.yaml:486–491`) along Portal entrance (9,34) → Mine entrance (13,35). Reinforces `west-production-road` (`townPlan.js:62–66`).
- Touchpoints: `scenery.js:361–399`.
- New assets: none.
- Dependencies: none.
- Validation: visual diff.

### R13 — Lighthouse label parity check

- Impact: low · Effort: trivial · Confidence: high
- Problem: source uses `watchtower` internally with `'PHAROS LIGHTHOUSE'` label and `'LIGHTHOUSE'` short label (`buildings.js:227–232`); the agent-building plan confirms it (L620–636). Surfaced here to prevent regression.
- Touchpoints: none if current state is honored.
- New assets: none.
- Dependencies: none.
- Validation: docs.

## Quick Wins (≤1 day each)

- **QW1** (R4 + R8): drop 8 props into `DISTRICT_PROPS` (`scenery.js:361–399`). Zero generation, one file.
- **QW2** (R3): per-building `windowWarmth` multiplier in `BuildingSprite.js:1041–1100`. Needs R1 stub.
- **QW3** (R9): state-aware label accent — 6-line helper at `BuildingSprite.js:345`.
- **QW4** (R11 minus gull): two buoys near watchtower, config-only.
- **QW5**: fix harbor walk-exclusion direction (B1).

## Bugs / Defects Observed

- **B1 — Harbor walkExclusion is one-sided.** `buildings.js:277` blocks a single west column; every other building blocks its south row (`buildings.js:28, 61, 92, 123, 156, 218, 246`). Harbor east is water; west block narrows the dock approach. Severity: medium.
- **B2 — Observatory walkExclusion blocks east column** (`buildings.js:187`). Inconsistent; entrance is south. Severity: low.
- **B3 — Command visit tiles overlap the central isle basin.** Basin at (17,22) r=1.6×1.2 (`scenery.js:170–178`) and the isle-promenade-bend clearing to (14,21) (`scenery.js:351`) collide with Command visit tiles (15,22), (17,22) (`buildings.js:18–27`). Severity: medium — Pathfinder reachability + re-stacking.
- **B4 — Command/Observatory sightlines overlap** (`buildings.js:31` vs L189–192). Double scenery suppression in a corridor. Severity: low.
- **B5 — `DISTRICT_PROPS` district strings drift from `TOWN_DISTRICTS` ids** (`scenery.js:362–399` vs `townPlan.js:5–12`). Currently labels only; silent if later joined by id. Severity: low.

## Cross-Domain Coordination

- **Visual (#1)**: R1 doorway glow vs Atmosphere `windowWarmth` ownership; R11 gull route belongs to whichever system Visual is extending.
- **Agent Behavior (#2)**: R1 recency decay should extend `LandmarkActivity` (L106–120), not a new state machine; "visitor count + recently visited" already half-exists there.
- **Character Design (#4)**: no overlap.
- **Git/Harbor (#5)**: harbor ledger rows (`BuildingSprite.js:488–531`) prefigure R2's building-detail panel for the Harbor — reuse the ledger model, don't duplicate.
- **Portal/Subagent + Code Health (#6)**: R7 + R10 need ToolIdentity classifier extensions (WebFetch/WebSearch, Playwright MCP). Shared with VisitIntentManager.
- **New sprite IDs Visual may generate** (only if council chooses): `prop.mineRailSegment` (R5, optional), `prop.portalPreviewScreen` (R10, optional). All other recs reuse existing manifest entries.
- **New visit tiles (Behavior owns)**: archive alcoves, command plaza arc, mine cart-path are in `agent-building-interactions-refinement.md:639–653`. Adopt those tile coordinates if Behavior confirms; do not invent new ones here.

## Council Debate Stance

Top three: **R1 + R3 bundled (presence pulse + per-building night windows)**, **R8 + R4 + R12 (one scenery PR — eight placements, zero generation, one file)**, and **R2 (building-detail panel)**. R1+R3 deliver the largest "village reacts to what agents are doing" payoff and unblock R6 (Archive fill) + R9 (label accents). The scenery bundle is the cheapest council win, visible at every load. R2 is the most contestable — it asks `ActivityPanel` to host building-scoped state next to agent-scoped state — but the Harbor ledger pattern proves it works. Debate: mirror via `building:selected`, or fold as a panel tab.

I will push back on elevating R10/R11 over R1/R8: Watchtower and Portal already over-perform per visitor; spending effort there before the eight common-case buildings have a visible activity heartbeat is misallocation. I will push back on any plan that calls for new *building* sprites — the manifest covers the nine well; the gap is overlays + scenery, not silhouettes. Watch on R5: if the council wants a new rail-segment sprite, the generation cost needs concrete user impact; otherwise keep R5 as crates + existing `oreCart`.
