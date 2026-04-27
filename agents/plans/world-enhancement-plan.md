# ClaudeVille Visual Rendering — World Enhancement Plan

Generated: 2026-04-27 · Revised: 2026-04-27 (multi-model review pass: haiku/sonnet/opus).

Source: parallel subagent audit across 5 rendering domains (terrain/water, buildings/props, agent animation, sky/atmosphere, camera/UI), then a three-model review that surfaced misdiagnoses, mis-tiered correctness bugs, and missing architectural prerequisites. Tier 0 below was added in the revision; several Tier-1 items were re-categorized.

---

## How to read this document

Each item lists: domain · code location · effort (S < 1 day / M 1–3 days / L > 3 days) · visual impact. Items are ranked by impact-to-effort ratio within each tier.

**Tier 0** lists architectural prerequisites that should land before Tier-1 work — they collapse multiple downstream items into shared infrastructure and prevent rework.

Status tags: **NEW** added in revision · **DONE** already implemented in current code · **REVISED** description corrected after review · **MOVED** re-tiered.

---

## Tier 0 — Architectural prerequisites (NEW)

These collapse downstream items, fix scope, and eliminate per-item rework. Land them first; most Tier-1 and Tier-2 items get smaller as a result.

### T0.1 Cache the per-light radial-gradient loop in `_drawAtmosphere`
**Domain:** Atmosphere · **File:** `IsometricRenderer.js:3641–3654` · **Effort:** S · **Impact:** High

The atmosphere pass builds a fresh `createRadialGradient` per `getLightSources()` entry every frame. The vignette itself is already cached at lines 3660–3668 keyed on `(width, height, atmosphere.cacheKey)` (bucketed to ~96 time slices, ~100 light slices) — that part is fine. The actual hot spot is the inner per-light loop. Cache each emitter's gradient on `(x, y, radius, color, phaseBucket)`. Prerequisite for #17 (more emitters), #16 (shadows in same pass), and #4 (visitor-driven intensity).

### T0.2 Unified `LightingState` per-frame snapshot
**Domain:** Atmosphere · **File:** new module derived from `AtmosphereState.js` · **Effort:** M · **Impact:** High

`AtmosphereState` already produces `phase`, `phaseProgress`, `dayProgress`, sun `xFrac`/`yFrac`. Promote into one struct consumed by every lighting-aware subsystem:

```text
LightingState {
  sunDirIso,        // 2D vector in iso space
  sunWarmth,        // 0..1, used for tinting
  ambientTint,      // RGB applied to terrain/buildings
  shadowAngleRad,   // for #16
  shadowLength,
  shadowAlpha,
  lightWarmth,      // for emitters (#17)
  lightBoost,       // night dimming/strengthening
  beaconIntensity,  // for #24
}
```

Without this, items #16, #18, #19, #23 each invent their own time-of-day lerp duplicating logic across files. With it, those collapse into one place.

### T0.3 Formal `LightSourceRegistry`
**Domain:** Atmosphere/Buildings · **File:** promoted from `BuildingSprite.getLightSources()`, consumers in `IsometricRenderer.js:1217, 3641` and `BuildingSprite.js:86–90` · **Effort:** M · **Impact:** Medium–High

Promote `getLightSources()` (already iterated 2× per frame) into a typed registry every glow-emitting subsystem reads from: forge hearth, brazier, lantern, watchtower beacon, lighthouse beam, portal gate, mine mouth. Each entry carries origin, color, radius, kind, modulation hooks, visitor-driven intensity, day/night gating. Resolves the `splitPass === 'back'` early-return at `BuildingSprite.js:861` that silently skips manifest light layers on the back pass of split buildings (root cause behind #5). Land before #5, #17, #24.

### T0.4 HiDPI / `devicePixelRatio` threading
**Domain:** Camera · **File:** `App.js:213–219`, `Camera.js`, `IsometricRenderer.js:799, 1174–1175` · **Effort:** M · **Impact:** High

Canvas is sized at CSS pixels. On Retina/4K every sprite and label renders blurry. Thread `dpr` through canvas sizing (`width = css * dpr`, top-level `ctx.scale(dpr, dpr)`) and audit every coordinate path that maps event coordinates to world coords:

- `Camera._onMouseMove:84` (mouse drag)
- `Camera._onWheel:97` (scroll/zoom)
- `IsometricRenderer._onClick:846` (selection hit-test)

Also gates every offscreen cache that allocates at `canvas.width × canvas.height`: `_getAtmosphereVignette:3666`, `SkyRenderer._getCachedBackground:113`. Land *before* T0.1 and any new offscreen cache (#14, #15, #29, #34) — otherwise those caches re-allocate later. Single highest perceived-quality change available.

### T0.5 Camera bounds + viewport tile-rect contract
**Domain:** Camera · **File:** `Camera.js:82–88`, consumers in `IsometricRenderer.js:840–841` · **Effort:** S · **Impact:** Medium

Add min/max clamp to `Camera._onMouseMove` (the actual cause of the black-void state — minimap clicks emit valid coordinates; drag is unbounded). Publish `Camera.getViewportTileBounds()` consumed by minimap (#20), future culling, and any zoom-range work (#21). Gates #8, #20, #21.

### T0.6 Motion-budget policy + reduced-motion gate-list
**Domain:** All · **Effort:** S · **Impact:** Medium (accessibility + perf)

`prefers-reduced-motion` is already honored by `ParticleSystem`, `SkyRenderer.driftEnabled`, water shimmer, and `motionScale` is threaded through `IsometricRenderer.js:1581/1852/1915/3105`. Codify a rule before adding motion: every new motion-bearing item must check `this.motionScale` *before allocating* its motion resource (ripple pool, harmonic phases, run-cycle frame timer, foam offset), not just before drawing. Also: declare which motion bands carry meaning (selection pulse, status pulse, recent-event flash, status indicator drift) so new motion items don't compete for the same band.

---

## Tier 1 — Quick Wins (S effort, Medium–High impact)

### 1. ~~Cache vignette/atmosphere overlay~~ — **REVISED**
**Status:** Superseded by T0.1.

The original premise was incorrect. The vignette IS already cached at `IsometricRenderer.js:3660–3668` keyed on `(width, height, atmosphere.cacheKey)`. The actual per-frame cost is the per-light radial-gradient loop in `_drawAtmosphere:3641–3654`, which T0.1 addresses.

### 2. Shoreline reflection shimmer
**Domain:** Terrain · **File:** `IsometricRenderer.js:1730–1742` · **Effort:** S · **Impact:** Medium

Shore tiles adjacent to water emit a secondary shimmer layer driven by `waterFrame` to suggest shallow light reflection at the waterline. No new sprites — additive alpha overlay on existing edge mask. Note: the existing four water sub-passes (`_drawStaticOpenSeaStructure`, `_drawOpenWaterDepthWash`, `_drawAnimatedCurrentBands`, `_drawDynamicWaterHighlights`) already iterate every visible water tile; measure fill-rate cost before adding a fifth pass on integrated GPUs. Reduced-motion: emit static shimmer at fixed `waterFrame=0`.

### 3. Name label distance fade — **REVISED**
**Domain:** Agents · **File:** `AgentSprite.js:1365–1413`, slot pipeline at `IsometricRenderer.js:1245, 1317` · **Effort:** S · **Impact:** Medium

Labels are fully opaque regardless of zoom or local agent density. The compact badge fallback already exists (`AgentSprite.js:1447–1479`). Original fix (alpha by density/distance) stands; pair with #38 (semantic priority in `_assignAgentOverlaySlots`) for the deeper improvement.

### 4. Hearth / forge glow driven by activity state
**Domain:** Buildings · **File:** `BuildingSprite.js:1211–1216`, visitor count at `1648/1661` · **Effort:** S · **Impact:** Medium

Forge hearth pulsing glow is decoupled from whether any agent is at the building. Wire glow intensity to `_visitorCountByType` so an idle forge dims and an occupied forge blazes.

**Caveat:** `_visitorCountByType` is keyed by `building.type`, not building instance — two forges of the same type share one count. Acceptable for the current 9-building world; document the assumption when implementing.

### 5. Lantern-glow overlay for all torch props — **REVISED**
**Domain:** Buildings · **File:** `BuildingSprite.js:861` (split-pass return), `manifest.yaml:86–90` (declaration) · **Effort:** S · **Impact:** Medium · **Depends on:** T0.3

Manifest declares `atmosphere.light.lantern-glow` but the activation never fires consistently. Real cause: `BuildingSprite.js:861` early-returns on `splitPass === 'back'`, which skips manifest light layers on the back pass of split buildings. Resolve via T0.3 (LightSourceRegistry); standalone fix is to re-enter the manifest-layer loop after the split early-return.

### 6. Sky gradient perceptual stop redistribution
**Domain:** Sky · **File:** `SkyRenderer.js:130–134` · **Effort:** S · **Impact:** Medium

Current stops (0.00, 0.42, 0.76, 1.00) produce uneven perceptual spacing and a visible mid-sky band. Redistribute to (0.00, 0.30, 0.65, 1.00) or add a fifth stop. Pure arithmetic. Cache adopts new stops on next miss (phase transition or resize). **Ship in same sprint as #19** — gradient changes without sun-warmth changes produce incoherent dusk visuals.

### 7. Cloud parallax wind-drift decoupling
**Domain:** Sky · **File:** `SkyRenderer.js:294–296` · **Effort:** S · **Impact:** Medium

Camera parallax and wind drift share a single phase. Separate into a wind vector (constant lateral push) and a camera-coupled parallax component. Reduced-motion: drop wind to zero, retain parallax (camera input only).

### 8. Zoom easing
**Domain:** Camera · **File:** `Camera.js:95–114` · **Effort:** S · **Impact:** Medium · **Pair with #21**

Wheel zoom snaps instantly between integer steps. Interpolate over ~150 ms with an ease-out curve. **Conflict with pixel-perfect premise:** during the easing window sprites blit at fractional scale and may appear blurry even with smoothing off. Either commit to fractional-zoom rendering quality (pair with #21 and accept sub-pixel artifacts at all in-between zooms) or skip easing under reduced-motion. Recommended: ship paired with #21 as a single decision.

### 9. Camera bounds clamping
**Status:** Folded into T0.5.

### 10. ~~Activate breathing-idle sprite frames~~ — **DONE**
**Status:** Already implemented. `SpriteSheet.js:19–20` does `(this.frame % IDLE_FRAMES)` with `IDLE_FRAMES = 4` and rows 6–9 reserved for idle. `AgentSprite.js:390–402` advances at the existing 500 ms cadence. The plan's claim that idle "collapses to a single cell" was outdated. Remove from sequence.

### 11. Harbor water distinguishing tint
**Domain:** Terrain · **File:** `IsometricRenderer.js:1638–1661`, harbor polygon in `claudeville/src/config/scenery.js` · **Effort:** S · **Impact:** Low

Harbor and open-ocean water share the same color palette. Apply a subtle green-hued tint to sheltered harbor tiles (the enclosed polygon defined in `scenery.js`).

### 12. Remove dead `_drawStatusRibbon` code
**Domain:** Agents · **File:** `AgentSprite.js:822–858` · **Effort:** S · **Impact:** Low (cleanup)

37-line method with no callers (verified). Delete; if a configurable display mode is wanted later, restore from git history.

### 33. Prop occlusion respect split-horizon — **MOVED FROM TIER 4**
**Domain:** Buildings · **File:** `BuildingSprite.js:813–850` · **Effort:** M · **Impact:** High (correctness, not polish)

Re-tiered: this is a depth-sort correctness bug, not an ambitious feature. Currently agents can sort behind a tree that's behind a building (`visual-experience-crafting.md §11` "poor depth rules: sprites appear in front of objects they should be behind"). Include large props in the split-drawables sort. Promotes into the same correctness band as T0.5.

---

## Tier 2 — High Impact Investments (M effort, High impact)

### 13. HiDPI / devicePixelRatio canvas scaling
**Status:** Promoted to T0.4. Land before any item that allocates an offscreen canvas (#14, #15, #29, #34, plus existing vignette/sky caches).

### 14. Water depth color gradation
**Domain:** Terrain · **File:** `IsometricRenderer.js:1655–1705`, depth map needs new module · **Effort:** M · **Impact:** High · **Depends on:** T0.4

Water currently uses a flat color with shimmer modulation but no depth progression. Add a shallow-to-deep gradient (turquoise → teal → navy) keyed on distance from the nearest shore tile (pre-computed once into a depth map). Depth-map cache must allocate at DPR-scaled canvas size — ship after T0.4.

### 15. Shore foam animation
**Domain:** Terrain · **File:** `IsometricRenderer.js:1675–1705` · **Effort:** M · **Impact:** High · **Depends on:** T0.6

Shore tiles use static deterministic noise for foam/spray. Drive foam opacity and offset by `waterFrame`. Could layer 2–3 foam bands at different phases. Reduced-motion: hold foam at fixed `waterFrame=0`; do not allocate per-frame offset state.

### 16. Directional building shadows
**Domain:** Buildings · **File:** `BuildingSprite.js:150–151` · **Effort:** M · **Impact:** High · **Depends on:** T0.2

All buildings receive a uniform ellipse shadow. Read `shadowAngleRad`, `shadowLength`, `shadowAlpha` from `LightingState` to offset and elongate shadows at dawn/dusk and shorten them at noon. Without T0.2 this duplicates time-of-day lerp logic with #18, #19, #23.

### 17. Light bloom / halo around torches and braziers — **REVISED**
**Domain:** Buildings · **File:** `IsometricRenderer.js:3641–3654`, `BuildingSprite.js:86–90` · **Effort:** S after prerequisites (was M) · **Impact:** High · **Depends on:** T0.1, T0.3

A radial halo IS already drawn per emitter every frame at lines 3641–3654 with `globalCompositeOperation = 'source-over'`. The plan's original claim that "no radial bloom is composited" was incorrect. Two changes give the visible bloom effect:

1. Switch to `'screen'` (or `'lighter'`) for additive composition.
2. Modulate radius and alpha by `LightingState.lightBoost` so emitters dim during day, brighten at dusk.

After T0.1 caches the gradient and T0.3 supplies a unified emitter list, this item shrinks from M to S.

### 18. Horizon wash depth layering
**Domain:** Sky · **File:** `SkyRenderer.js:144–151` · **Effort:** M · **Impact:** High · **Depends on:** T0.2

Replace single radial gradient with two or three concentric wash layers at different radii and alphas. Far layer reads `LightingState.ambientTint` so it shifts color toward ambient at dusk/midnight.

### 19. Sun glow day-to-dusk modulation
**Domain:** Sky · **File:** `SkyRenderer.js:205–222` · **Effort:** S with T0.2 (M without) · **Impact:** High · **Depends on:** T0.2

Sun glow uses hardcoded radius (4.5×) and RGBA stops regardless of phase. Read `sunWarmth`, `lightBoost` from `LightingState` and lerp radius, R/B balance, bloom intensity. Dawn: wide rose-gold. Noon: tight white. Dusk: very wide amber-red. **Acts as the canary item for T0.2.** Ship with #6 — gradient changes without sun-warmth changes produce incoherent dusk.

### 20. Minimap viewport overlay
**Domain:** Camera · **File:** `Minimap.js:19–60` · **Effort:** S with T0.5 (M without) · **Impact:** Medium · **Depends on:** T0.5

Draw a translucent isometric-diamond frustum rect representing the visible viewport. Update on every camera pan/zoom. Use `Camera.getViewportTileBounds()` from T0.5; do not duplicate clamp logic.

### 21. Fractional zoom sub-steps
**Domain:** Camera · **File:** `Camera.js:103–110` · **Effort:** M · **Impact:** Medium · **Depends on:** T0.4, T0.5; **Pair with #8**

Expand integer steps {1, 2, 3} to {1.0, 1.5, 2.0, 2.5, 3.0}. At fractional scale, sprites blit at sub-pixel positions; without HiDPI threading the artifacts are visible even with smoothing off. Also revisit `AgentSprite._zoom < 1.5` threshold at line 1366. Ship with #8 — easing through fractional values requires committing to fractional-zoom quality.

### 22. Star temporal variance
**Domain:** Sky · **File:** `SkyRenderer.js:179–196` · **Effort:** M · **Impact:** Medium · **Depends on:** T0.6

Group stars into magnitude classes (bright/mid/faint), each with a different twinkle rate, drift amplitude, brightness oscillation. Reduced-motion: skip allocation of per-star phase offsets; render flat brightness.

### 23. Moon corona articulation
**Domain:** Sky · **File:** `SkyRenderer.js:247–256` · **Effort:** M · **Impact:** Medium · **Depends on:** T0.2

Add a faint outer corona ring at ~1.4× sprite radius and a chromatic haze (cool blue → neutral) that strengthens during full-moon phases. Read modulation from `LightingState.beaconIntensity` or a new `moonPhase` derived from atmosphere.

### 24. Lighthouse beam geometry
**Domain:** Buildings · **File:** `BuildingSprite.js:1574–1579` · **Effort:** M · **Impact:** Medium · **Depends on:** T0.3, T0.6

Two thin triangle wedges opposite each other, rotating slowly, with soft edge falloff and subtle fog scatter where the beam meets atmosphere. Animate via `buildingAnim` phase. Register the beam as a `LightSourceRegistry` entry with `kind: 'beam'`. Reduced-motion: hold beam at a fixed angle.

### 25. Water crest harmonic layering
**Domain:** Terrain · **File:** `IsometricRenderer.js:1755–1771` · **Effort:** M · **Impact:** Medium · **Depends on:** T0.6

Add a second harmonic at a different frequency and direction to produce interference patterns. Reduced-motion: drop both harmonics to amplitude 0.

### 26. Agent crowd bump visual feedback
**Domain:** Agents · **File:** `IsometricRenderer.js:1071–1095` · **Effort:** M · **Impact:** Medium

Emit a brief particle puff (3–4 small circles expanding + fading) or flash the ground ring when separation steering pushes agents apart. Communicates intentionality vs. glitch. Reduced-motion: flash the ground ring only; skip particles.

### 27. Chat partner facing lock
**Domain:** Agents · **File:** `AgentSprite.js:266–298` · **Effort:** M · **Impact:** Medium

After arrival, continuously snap each chat-partner sprite's facing direction to point toward partner's current tile center. 8-direction snap per frame.

### 28. Status glow prominence in crowds — **REVISED**
**Domain:** Agents · **File:** `AgentSprite.js:643–681` · **Effort:** M · **Impact:** Medium · **Depends on:** #36

Original tweak (0.42 → 0.62 ceiling for WORKING; idle dim) is fine in isolation. But pulse currently means six different things across the renderer (selection, status, hearth, building light, watchtower fire, brazier overlay). Land #36 (pulse-cue ownership) first so this item has a band to claim.

---

## Tier 3 — Solid Improvements (M effort, Low–Medium impact)

### 29. Terrain edge wear at path–grass borders
**Domain:** Terrain · **File:** `IsometricRenderer.js` terrain cache · **Effort:** M · **Impact:** Medium · **Depends on:** T0.4

Procedural erosion band (2–4 px) at transition tiles. Pre-bake into `terrainCache`; do not redraw per frame.

### 30. Terrain wetness tint bordering water
**Domain:** Terrain · **File:** `IsometricRenderer.js` (FOREST_FLOOR_REGIONS rendering) · **Effort:** M · **Impact:** Medium

Pre-classify "water-adjacent" tiles once at world init; multiplicative tint during render.

### 31. Fish school animation trails
**Domain:** Buildings/Scenery · **File:** `claudeville/src/config/scenery.js:295–298` · **Effort:** M · **Impact:** Low · **Depends on:** T0.6

Short tail of fading copies offset along heading. Reduced-motion: render single frame.

---

## Tier 4 — Ambitious (L effort)

(#33 moved to Tier 1 in this revision.)

### 32. Animated concentric water ripples
**Domain:** Terrain · **File:** `IsometricRenderer.js:1588–1650` · **Effort:** L · **Impact:** High · **Depends on:** T0.6

Ripple pool ticked each frame; clip-to-water-tile render pass. Reduced-motion: do not allocate the ripple pool at all.

### 34. Canopy horizon soft-fade
**Domain:** Sky · **File:** `SkyRenderer.js:54–69` · **Effort:** L · **Impact:** Medium · **Depends on:** T0.4

Replace hard clip with `globalCompositeOperation: destination-in` masked by a vertical linear gradient. Mask canvas allocates at DPR-scaled size.

### 35. Run / sprint animation state
**Domain:** Agents · **File:** `AgentSprite.js`, sprite sheets · **Effort:** L · **Impact:** Medium · **Depends on:** T0.6

Dedicated 8-frame run cycle, 9 chars × 8 directions × 8 frames = 576 new cells via Pixellab. Reduced-motion: WORKING-state agents continue using the existing 6-frame walk cycle; do not advance to run frames.

---

## Gap-analysis additions (NEW, from architectural review)

### 36. Pulse-cue ownership policy
**Domain:** All · **Effort:** S · **Impact:** Medium

`visual-experience-crafting.md §4`: "do not overload one cue. If pulsing means waiting, do not also use it for success." Pulse currently signals six unrelated things. Assign one canonical owner per pulse rate band:

- **Slow (>1 s):** selection ring (already there).
- **Medium (~600 ms):** working status glow.
- **Fast (<300 ms):** notification / recent-event flash.
- **Static (no pulse):** idle, building light, hearth — replace with steady alpha or smooth `LightingState`-driven modulation.

Without this, every Tier-1/2 item that adds another pulse muddies the visual grammar. Land before #28.

### 37. Empty-state world visual
**Domain:** All · **Effort:** S–M · **Impact:** High (first-load UX)

`visual-experience-crafting.md §11`: "no empty state: the world looks broken when there is simply no data." Zero-agent and one-agent are the dominant first-load states for new users; the original plan had no items for them. Options (any one or a combination):

- Ambient background activity always visible: fish school traffic, harbor ship loop, smoke plumes from "idle" buildings, lighthouse beam.
- A small caretaker NPC near the Command Center.
- A subtle "watching for sessions…" hint near the topbar.

Belongs in Tier 1 — high first-impression leverage.

### 38. Label clutter — semantic priority in `_assignAgentOverlaySlots`
**Domain:** Agents · **File:** `IsometricRenderer.js:1245, 1317` · **Effort:** M · **Impact:** Medium

Existing `occupiedBoxes` machinery resolves label collisions but treats all labels equally. Slot-assign priority order: selected → working-with-recent-event → recently-spawned → working → idle. Idle labels yield first; selected always wins. Pairs with #3.

### 39. Codex equipment coherence — revised class grammar
**Status:** Implemented 2026-04-28.

Codex equipment now follows model class rather than reasoning effort: Spark uses a multitool, GPT-5.4 uses an engineer wrench, and GPT-5.5 uses runeblade plus shield. Reasoning effort is carried by floor rings and crown accessories. Runtime scrubber tuning and regenerated Codex sheets remove the previous baked-plus-overlay weapon stacking.

---

## Revised recommended starting sequence

The original sequence (#1 → #17 → #19) was unsound: #1 was a no-op (already cached) and #17 piled onto the same un-batched gradient loop without addressing it.

### Sprint A — pipeline validation (zero risk, immediate visible)
1. **#6** — Sky gradient stops (pure arithmetic, no cache invalidation).
2. **#19** — Sun glow dusk modulation (canary for T0.2).
3. **#12** — Remove dead `_drawStatusRibbon` (cleanup; builds review confidence).

(#10 is DONE — removed from sequence.)

### Sprint B — architectural prerequisites
4. **T0.4** — HiDPI threading (single biggest perceived-quality change; gates every offscreen cache).
5. **T0.5** — Camera bounds + viewport rect (fixes void state; unblocks #20/#21).
6. **T0.6** — Motion-budget policy (codifies the rule before adding motion items).
7. **T0.1** — Cache `_drawAtmosphere` per-light loop.
8. **T0.2 + T0.3** — `LightingState` + `LightSourceRegistry` (collapses #4/#5/#16/#17/#18/#19/#23/#24).

### Sprint C — correctness + grammar
9. **#33** (now Tier-1) — Prop split-horizon (depth-sort correctness).
10. **#36** — Pulse-cue ownership (visual grammar before #28).
11. **#37** — Empty-state visuals (first-load UX).
12. **#38** — Label priority (pairs with #3).
13. **#39** — Codex equipment coherence (implemented class grammar).

### Sprint D — visual atmosphere (after prerequisites)
14. **#16, #18, #23** — Shadows, horizon wash, moon corona — all consume `LightingState`.
15. **#17** — Torch bloom (now S effort post-T0.1+T0.3).
16. **#14, #15, #25** — Water depth, foam, harmonics.

### Sprint E — camera quality
17. **#8 + #21 paired** — Zoom easing + fractional steps (ship together).
18. **#20** — Minimap viewport overlay (uses T0.5 contract).

Tier-4 items (#32, #34, #35) follow only after the cumulative cost of Sprints A–E has been measured.

---

## Cumulative cost note

If Sprints A–D ship as written, per-frame additions vs. today:

- ~6 cached radial gradients (T0.1) — **net negative** cost (was N × 60 fps uncached).
- 1 `LightingState` calc per frame (T0.2) — trivial.
- 1 horizon-wash + sun-glow re-draw per cache miss (#6/#18/#19) — bucketed, low.
- 1 shadow draw per visible building per frame (#16) — moderate.
- 1 foam offset + 1 depth lookup per visible water tile (#14/#15) — depends on visible tile count; profile at zoom 1.0 with full canvas before approving.
- N agents × ground-ring + label (already exists; #3/#28/#38 modulate, do not add new draws).

Pre-Sprint E this should fit comfortably at 60 fps on integrated GPU at 1080p. Tier-4 items #32 (concentric ripples) and #35 (run cycle, +576 cells × decode cost) require explicit measurement before commit.

---

## Review provenance

This plan was revised on 2026-04-27 after a multi-model review pass:

- **haiku** (surface-check): flagged #1 and #10 as already implemented; confirmed #5/#12/#33 as real findings.
- **sonnet** (technical depth): produced the per-item feasibility analysis, hidden-coupling pairs, and the alternate Sprint A ordering.
- **opus** (architectural): supplied Tier 0, the gap-analysis items (#36/#37/#38), and the cumulative-cost discipline.
