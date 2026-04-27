# ClaudeVille Visual Rendering — World Enhancement Plan

Generated: 2026-04-27  
Source: parallel subagent audit across 5 rendering domains (terrain/water, buildings/props, agent animation, sky/atmosphere, camera/UI).

---

## How to read this document

Each item lists: domain, the code location, effort (S < 1 day / M 1–3 days / L > 3 days), and visual impact. Items are ranked by impact-to-effort ratio within each tier.

---

## Tier 1 — Quick Wins (S effort, Medium–High impact)

### 1. Cache vignette/atmosphere overlay
**Domain:** Camera · **File:** `IsometricRenderer.js:3661–3734` · **Effort:** S · **Impact:** High

The `_drawAtmosphere` pass calls `createLinearGradient` and `createRadialGradient` on every frame despite having a cacheKey check. Pre-render to an offscreen canvas keyed on (width, height, phase) and blit it. Directly frees GPU/CPU budget for everything else.

### 2. Shoreline reflection shimmer
**Domain:** Terrain · **File:** `IsometricRenderer.js:1730–1742` · **Effort:** S · **Impact:** Medium

Shore tiles adjacent to water could emit a secondary shimmer layer driven by `waterFrame` to suggest shallow light reflection at the waterline. No new sprites needed — additive alpha overlay on existing edge mask.

### 3. Name label distance fade
**Domain:** Agents · **File:** `AgentSprite.js:1365–1413` · **Effort:** S · **Impact:** Medium

Labels are fully opaque regardless of zoom or local agent density. Blend alpha down based on agent count in a screen zone, or lerp toward 0 beyond a configurable screen-space radius from camera focus. The compact badge fallback already exists (`AgentSprite.js:1447–1479`).

### 4. Hearth / forge glow driven by activity state
**Domain:** Buildings · **File:** `BuildingSprite.js:1211–1216` · **Effort:** S · **Impact:** Medium

Forge hearth pulsing glow is decoupled from whether any agent is actually active at the building. Wire glow intensity to `visitorCount` so an idle forge dims and an occupied forge blazes.

### 5. Lantern-glow overlay for all torch props
**Domain:** Buildings · **File:** `BuildingSprite.js:843–850`, `manifest.yaml:86–90` · **Effort:** S · **Impact:** Medium

The `atmosphere.light.lantern-glow` overlay is declared in the manifest but the activation check in `BuildingSprite` gating on `splitPass` may silently skip non-split prop types. Audit the condition and ensure all torch/brazier props receive the glow compositing pass.

### 6. Sky gradient perceptual stop redistribution
**Domain:** Sky · **File:** `SkyRenderer.js:130–134` · **Effort:** S · **Impact:** Medium

Current stops (0.00, 0.42, 0.76, 1.00) produce uneven perceptual spacing and a visible mid-sky band. Redistribute to (0.00, 0.30, 0.65, 1.00) or add a fifth stop for richer depth. Pure arithmetic change — no asset work.

### 7. Cloud parallax wind-drift decoupling
**Domain:** Sky · **File:** `SkyRenderer.js:294–296` · **Effort:** S · **Impact:** Medium

Camera parallax and wind drift share a single phase (`clockDrift * driftMul`). Separate into a wind vector (constant lateral push) and a camera-coupled parallax component so clouds feel atmospheric rather than glued to the viewport.

### 8. Zoom easing
**Domain:** Camera · **File:** `Camera.js:95–114` · **Effort:** S · **Impact:** Medium

Wheel zoom snaps instantly between integer steps. Interpolate over ~150 ms with an ease-out curve. Self-contained within `Camera._onWheel` — no renderer changes needed.

### 9. Camera bounds clamping
**Domain:** Camera · **File:** `Camera.js:29–88` · **Effort:** S · **Impact:** Medium

Drag panning has no world-edge limit. Add min/max clamp in `_applyPan` derived from world tile dimensions × tile size, accounting for current zoom. Prevents the black-void state that currently breaks minimap click navigation.

### 10. Activate breathing-idle sprite frames
**Domain:** Agents · **File:** `SpriteSheet.js:19–20`, `AgentSprite.js:390–402` · **Effort:** S · **Impact:** Low–Medium

All character sprites already have 4 breathing-idle frames generated (rows 6–9 of the sheet) but `SpriteSheet.js` collapses idle to a single cell. Change the idle cell lookup to cycle through frames 0–3 at the existing 500 ms cadence. Zero Pixellab generation required.

### 11. Harbor water distinguishing tint
**Domain:** Terrain · **File:** `IsometricRenderer.js:1638–1661` · **Effort:** S · **Impact:** Low

Harbor and open-ocean water share the same color palette. Apply a subtle green-hued tint to sheltered harbor tiles (the enclosed polygon defined in `scenery.js`) to visually separate near-shore from deep water.

### 12. Remove dead `_drawStatusRibbon` code
**Domain:** Agents · **File:** `AgentSprite.js:822–858` · **Effort:** S · **Impact:** Low (cleanup)

36-line method that draws a floating ribbon label above agents' heads. No call site exists — status is rendered via `_drawStatus()`/`_drawBubble()` instead. Either resurrect it as a configurable display mode or delete it.

---

## Tier 2 — High Impact Investments (M effort, High impact)

### 13. HiDPI / devicePixelRatio canvas scaling
**Domain:** Camera · **File:** `IsometricRenderer.js:799, 1174–1175` · **Effort:** M · **Impact:** High

Canvas is created at CSS pixel size (1:1), so on Retina and 4K displays every sprite and text label renders blurry. Thread `devicePixelRatio` through canvas sizing (`width = css * dpr`, `height = css * dpr`), add a top-level `ctx.scale(dpr, dpr)`, and adjust Camera coordinate math. Most visible quality improvement possible — affects every pixel on screen.

### 14. Water depth color gradation
**Domain:** Terrain · **File:** `IsometricRenderer.js:1655–1705` · **Effort:** M · **Impact:** High

Water currently uses a flat color with shimmer modulation but no depth progression. Add a shallow-to-deep gradient (turquoise → teal → navy) keyed on distance from the nearest shore tile (pre-computed once into a depth map). Dramatically improves the harbor bay's sense of volume.

### 15. Shore foam animation
**Domain:** Terrain · **File:** `IsometricRenderer.js:1675–1705` · **Effort:** M · **Impact:** High

Shore tiles use static deterministic noise for foam/spray. Drive foam opacity and offset by `waterFrame` so the coastline breathes with each water tick. Could layer 2–3 foam bands at different phases for realism.

### 16. Directional building shadows
**Domain:** Buildings · **File:** `BuildingSprite.js:150–151` · **Effort:** M · **Impact:** High

All buildings receive the same uniform ellipse shadow. Introduce a time-of-day sun angle (from `AtmosphereState` phase) to offset and elongate shadows at dawn/dusk and shorten them at noon. Landmark buildings could cast longer, more dramatic shadows than standard ones.

### 17. Light bloom / halo around torches and braziers
**Domain:** Buildings · **File:** `BuildingSprite.js:86–90`, `scenery.js:284–285` · **Effort:** M · **Impact:** High

Torch and brazier props have emission coordinates in the manifest but no radial bloom is composited into the scene. Add a post-process pass that draws a soft additive radial gradient at each light emission point. At night this becomes the primary atmosphere driver.

### 18. Horizon wash depth layering
**Domain:** Sky · **File:** `SkyRenderer.js:144–151` · **Effort:** M · **Impact:** High

The horizon glow is a single radial gradient at a fixed y-fraction (0.86). Replace with two or three concentric wash layers at different radii and alphas to create genuine atmospheric perspective depth. The far layer should shift color toward the ambient (orange at dusk, blue at midnight).

### 19. Sun glow day-to-dusk modulation
**Domain:** Sky · **File:** `SkyRenderer.js:205–222` · **Effort:** M · **Impact:** High

Sun glow uses hardcoded radius (4.5×) and RGBA stops regardless of `AtmosphereState` phase. Read current phase and lerp radius, warmth (R/B channel balance), and bloom intensity. Dawn: wide, rose-gold. Noon: tight, white. Dusk: very wide, amber-red. This alone makes the sky feel cinematic.

### 20. Minimap viewport overlay
**Domain:** Camera · **File:** `Minimap.js:19–60` · **Effort:** M · **Impact:** Medium

The parchment minimap renders buildings but gives no indication of current camera position or zoom. Draw a translucent isometric-diamond frustum rect representing the visible viewport. Update on every camera pan/zoom.

### 21. Fractional zoom sub-steps
**Domain:** Camera · **File:** `Camera.js:103–110` · **Effort:** M · **Impact:** Medium

Current steps {1, 2, 3} produce a coarse jump that disorients. Expand to {1.0, 1.5, 2.0, 2.5, 3.0} or a continuous 5-step wheel. Requires proportional label-size adjustments in `AgentSprite` zoom thresholds.

### 22. Star temporal variance
**Domain:** Sky · **File:** `SkyRenderer.js:179–196` · **Effort:** M · **Impact:** Medium

Stars use flat LCG seeding with a single drift formula. Group stars into magnitude classes (bright / mid / faint) and give each class a different twinkle rate, drift amplitude, and brightness oscillation. Bright stars could pulse slightly; faint stars drift more.

### 23. Moon corona articulation
**Domain:** Sky · **File:** `SkyRenderer.js:247–256` · **Effort:** M · **Impact:** Medium

The moon glow is a single blunt radial stop. Add a faint outer corona ring at ~1.4× the sprite radius and a chromatic haze (cool blue shifting to neutral) that strengthens during full-moon phases.

### 24. Lighthouse beam geometry
**Domain:** Buildings · **File:** `BuildingSprite.js:1574–1579` · **Effort:** M · **Impact:** Medium

The pharos lighthouse currently renders a basic radial gradient glow. Add a rotating beam geometry: two thin triangle wedges opposite each other, rotating slowly, with soft edge falloff and a subtle fog scatter where the beam meets atmosphere. Animate via `buildingAnim` phase.

### 25. Water crest harmonic layering
**Domain:** Terrain · **File:** `IsometricRenderer.js:1755–1771` · **Effort:** M · **Impact:** Medium

Only one sine-wave crest is applied to water tiles. Add a second harmonic at a different frequency and direction to produce interference patterns, making the water surface feel less mechanical.

### 26. Agent crowd bump visual feedback
**Domain:** Agents · **File:** `IsometricRenderer.js:1071–1095` · **Effort:** M · **Impact:** Medium

When the separation steering pushes agents apart, the motion is silent. Emit a brief particle puff (3–4 small circles expanding + fading) or flash the ground ring for one frame. Communicates intentionality rather than glitch.

### 27. Chat partner facing lock
**Domain:** Agents · **File:** `AgentSprite.js:266–298` · **Effort:** M · **Impact:** Medium

Chat partners derive facing from velocity during approach but lock in place once stationary. After arrival, continuously set each agent's facing direction to point toward their partner's current tile center. Small quaternion-style 8-direction snap per frame.

### 28. Status glow prominence in crowds
**Domain:** Agents · **File:** `AgentSprite.js:643–681` · **Effort:** M · **Impact:** Medium

Ground ring max opacity is 0.42 (0.26 + 0.16 pulse), which disappears in dense scenes. Increase base to 0.38 and pulse ceiling to 0.62 for WORKING agents. Non-selected IDLE agents could dim further to create contrast hierarchy.

---

## Tier 3 — Solid Improvements (M effort, Low–Medium impact)

### 29. Terrain edge wear at path–grass borders
**Domain:** Terrain · **File:** `IsometricRenderer.js` terrain cache · **Effort:** M · **Impact:** Medium

Paths meet grass/forest in hard tile edges. Add a 2–4 pixel procedural erosion band at transition tiles (deterministic noise keyed on tile coords) to soften the boundary.

### 30. Terrain wetness tint bordering water
**Domain:** Terrain · **File:** `IsometricRenderer.js` (FOREST_FLOOR_REGIONS rendering) · **Effort:** M · **Impact:** Medium

Forest floor and grass tiles immediately bordering water could receive a saturation/darkening overlay to simulate wet soil. Pre-classify "water-adjacent" tiles once at world init and apply a multiplicative tint during render.

### 31. Fish school animation trails
**Domain:** Buildings/Scenery · **File:** `scenery.js:295–298` · **Effort:** M · **Impact:** Low

Fish schools have phase and radius parameters but render as static icons. Add a short tail of fading copies offset along the school's heading to suggest motion without additional sprites.

---

## Tier 4 — Ambitious (L effort, High–Medium impact)

### 32. Animated concentric water ripples
**Domain:** Terrain · **File:** `IsometricRenderer.js:1588–1650` · **Effort:** L · **Impact:** High

Propagating concentric ring ripples from randomised drop origins scattered across the water surface. Each ring expands outward over ~60 frames, fades, and is replaced. Requires a ripple pool data structure ticked each frame and a clip-to-water-tile render pass.

### 33. Prop occlusion respect split-horizon
**Domain:** Buildings · **File:** `BuildingSprite.js:813–850` · **Effort:** L · **Impact:** Medium

Props (trees, lanterns, etc.) are drawn as a single drawImage call with no respect for a nearby building's `horizonY` split. Agents can appear in front of a building but behind a tree that should itself be behind the building. Correct by including large props in the split-drawables sort.

### 34. Canopy horizon soft-fade
**Domain:** Sky · **File:** `SkyRenderer.js:54–69` · **Effort:** L · **Impact:** Medium

Sky clipping uses a hard `rect(0, 0, w, 0.52h)` with no feathering. Replace with a gradient-masked soft clip (canvas `globalCompositeOperation: destination-in` with a vertical linear gradient) so stars and moon dissolve into the horizon haze rather than cutting sharply.

### 35. Run / sprint animation state
**Domain:** Agents · **File:** `AgentSprite.js` · **Effort:** L · **Impact:** Medium

WORKING-state agents move faster but use the same 6-frame walk cycle. A dedicated 8-frame run cycle (leaning forward, larger stride) would visually communicate urgency. Requires Pixellab generation for all 9 character × 8 directions × 8 frames = 576 new cells.

---

## Recommended starting sequence

Three items that compose well and can ship independently:

1. **#1 — Cache vignette overlay** — frees framerate headroom before adding any new effects.
2. **#17 — Torch/brazier light bloom** — highest visible night-time improvement, self-contained compositing pass.
3. **#19 — Sun glow dusk modulation** — transforms the existing sky system from static to cinematic with no new assets.

After those three land, the natural next cluster is **#13 (HiDPI)** + **#14/#15 (water depth + foam)** as a water quality sprint, and **#16/#18 (shadows + horizon wash)** as a lighting atmosphere sprint.
