# Visual & Atmosphere — Council Research

Date: 2026-05-17
Status: reference
Baseline HEAD: e919f845c5074487c694d6aa163968df48728de1
Initial git status: ` M AGENTS.md\n M CLAUDE.md`

## Method

Read in full: `SkyRenderer.js`, `WeatherRenderer.js`, `AtmosphereState.js`, `ParticleSystem.js`, `Compositor.js`, `LightSourceRegistry.js`, `CanvasBudget.js`, `PulsePolicy.js`, `TerrainTileset.js`, `SceneryEngine.js`. Skimmed `IsometricRenderer.js` (~6720 lines) for atmosphere/water/vignette/light-glow. Read `config/{scenery,theme,constants}.js`, `docs/motion-budget.md`, prior plan headers, manifest atmosphere entries.

Key searches: `triggerAurora` (1 def, 0 callers), `particleType: 'leaf'` (0 hits — preset declared, never spawned), `shootingStar|meteor` (0 hits). Manifest surveyed: `atmosphere.cloud.{cumulus,wisp,overcast-bank,storm-shelf}{,.day}`, `atmosphere.moon.{crescent,half,gibbous}.cool`, `atmosphere.fog.wisp.low`, `atmosphere.rain.splash`, `atmosphere.water.{ripple.rain,foam.corner,harbor.wake}`, `atmosphere.light.{fire-glow,lantern-glow,lighthouse-beam}`. Commented `atmosphere.aurora` at `manifest.yaml:991`.

## Current State Verdict

The atmosphere stack is sophisticated: time-blended palettes, per-phase sun/moon, a 6-knot weather timeline, parallax clouds, foreground rain/fog/storm/flash, weather-reactive water shimmer, per-phase vignette cache, light-glow stamps, canopy mirror pass — all motion-budget-guarded. Conspicuously weak: (1) **sky never reacts to agents** — aurora trigger has no caller; (2) **no godrays at dawn/dusk** despite `lighting.sunWarmth` being computed; (3) **water animation is sine-only** — authored rain-splash and rain-ripple sprites are loaded but unused; (4) **ambient particles are static-tile-bound** — never react to weather/wind/season (the `leaf` preset has zero callers); (5) **water stays teal under an orange dusk sky**, breaking scene coherence.

## Recommendations

### R1. Crepuscular rays (godrays) at dawn/dusk
- Impact: H · Effort: M · Confidence: H
- Problem: `lighting.sunWarmth` and `sunBloomScale` are already computed (`AtmosphereState.js:677`), and `SkyRenderer._resolveSunPosition` already gives a clamped screen point, but no shafts are drawn. The most cinematic golden-hour cue is missing.
- Proposal: Add `SkyRenderer._drawGodrays(ctx, canvas, sun, lighting)`. When `lighting.sunWarmth > 0.18` and `sun.alpha > 0.04`, draw 6–10 thin radial gradients from the sun position with `globalCompositeOperation='screen'` and alpha `≤ 0.10 * sunWarmth`. Call from `draw` before `_drawClouds`, and from `drawCanopy` at ×0.4 alpha.
- Touchpoints: `SkyRenderer.js:64-81` (insert call), `SkyRenderer.js:300-377` (reuse `_resolveSunPosition`); reads `lighting.sunWarmth` from `AtmosphereState.js:677`.
- New assets needed: none.
- Dependencies: none.
- Motion-budget band: `static` (per snapshot; bake into the per-`cacheKey` sky cache).
- Validation hook: `window.__claudeVilleAtmosphere.setHour(18)` (`AtmosphereState.js:937`) → shafts over Token Mine/Code Forge silhouettes; `setHour(12)` → no shafts.

### R2. Wire aurora trigger to push/celebration events
- Impact: M · Effort: S · Confidence: H
- Problem: `SkyRenderer.triggerAurora` (`SkyRenderer.js:83`) is a complete 12-second effect with motion-scale fallback at `_auroraAlpha`, but **no caller**. Verified `triggerAurora` has only the definition — not yet implemented at any consumer.
- Proposal: From the renderer's git-event subscription, call `triggerAurora()` when a push completes AND `phase === 'night'`. Add a 5-minute cooldown.
- Touchpoints: `SkyRenderer.js:83`, IsometricRenderer git-event handler site.
- New assets needed: optionally uncomment `atmosphere.aurora` at `manifest.yaml:991`.
- Dependencies: **Git/Harbor** for the push event.
- Motion-budget band: `slow` (single-shot 12 s; static fallback at `motionScale=0`).
- Validation hook: `setHour(2)` then trigger manually → bands fade in then out.

### R3. Animated rain impacts using authored sprites
- Impact: H · Effort: M · Confidence: H
- Problem: Manifest ships `atmosphere.rain.splash` (`manifest.yaml:966`) and `atmosphere.water.ripple.rain` (`manifest.yaml:972`), but `WeatherRenderer._drawRain` renders only procedural streaks (`WeatherRenderer.js:117-180`). Rain passes through everything without contact.
- Proposal: After streaks, stamp 6–18 `atmosphere.rain.splash` sprites at random screen positions every ~120 ms when `precipitation > 0.15`. For water tiles (`IsometricRenderer.js:3655-3705`), stamp `atmosphere.water.ripple.rain` on a small fraction per frame, chance ∝ `weather.precipitation`.
- Touchpoints: `WeatherRenderer.js:117-180` (new sprite pass), `IsometricRenderer.js:3655-3705` (existing sine ripple block — supplement with sprite stamps).
- New assets needed: already in manifest — not yet implemented in renderer.
- Dependencies: none.
- Motion-budget band: `fast` for splashes, `medium` for puddle settle. Static fallback: a fixed deterministic grid of 12 splashes.
- Validation hook: `setWeather('rain', 0.8)` → splash dots scattered; water shows ripple sprites.

### R4. Seasonal ambient particles tied to local date
- Impact: M · Effort: M · Confidence: M
- Problem: `ParticleSystem` declares a `leaf` preset (`ParticleSystem.js:89-96`) with **no callers**. Seasonal mood is absent.
- Proposal: New `SeasonalAmbience` module reading `atmosphere.clock.localDate`, mapping month→season (Dec–Feb snow, Mar–May cherry, Jun–Aug fireflies, Sep–Nov leaves), spawning ≤4 camera-space drift particles/sec. Reuse `firefly` and `leaf`; add `cherryPetal` and `snow`.
- Touchpoints: new `character-mode/SeasonalAmbience.js`, hook near `IsometricRenderer.js:453` (`ParticleSystem` instantiation).
- New assets needed: none (procedural).
- Dependencies: **Character council** for any winter cloak palette coordination.
- Motion-budget band: `medium`. Static fallback: 14 deterministic petals/leaves at fixed positions.
- Validation hook: System date Dec → snow; April → cherry. Independent of `setHour`/`setSeed`.

### R5. Phase-coupled water base palette
- Impact: H · Effort: M · Confidence: H
- Problem: Water shimmer reacts to weather (`IsometricRenderer.js:3524-3550`) but the **base teal palette is identical across phases**. Orange dusk sky over teal water is the most jarring atmospheric break in the current screenshot. `reactions.warmGlint` (`AtmosphereState.js:753`) and `nightReflection` (`AtmosphereState.js:755`) are computed but ignored by the underlying tile fills.
- Proposal: In water rendering, tint base water toward `palette.horizon` weighted by `reactions.warmGlint` at dusk/dawn, and toward `palette.zenith × 0.5` at night. Keep teal as the day constant.
- Touchpoints: `IsometricRenderer.js:4109-4112` (shimmer base), `IsometricRenderer.js:761-770` (water-token), `theme.js:15-16` (extend `water` to per-phase tint).
- New assets needed: none.
- Dependencies: **Buildings** if roof glint should follow same warmth.
- Motion-budget band: `static`.
- Validation hook: `setHour(19)` → warm-tinted water near horizon; `setHour(23)` → deep navy.

### R6. Window-warmth coupled to agent activity
- Impact: M · Effort: M · Confidence: M
- Problem: `reactions.windowWarmth` (`AtmosphereState.js:750`) is computed but unused. Working agents don't visibly heat their buildings.
- Proposal: For each building hosting a `'working'` agent, multiply light-glow `intensity` by `1 + 0.4 * pulse(medium)` and warm-tint by `lighting.lightWarmth`. Medium band already owns working-status glow per `docs/motion-budget.md`.
- Touchpoints: `IsometricRenderer.js:6113-6117` (`_ambientLightSources`), `LightSourceRegistry.js:24` (`intensity` field exists), `BuildingSprite.js` light source builders.
- New assets needed: none.
- Dependencies: **Behavior** for stable working flag; **Buildings** for light-source list.
- Motion-budget band: `medium`. Static fallback: hold `intensity = 1.0` with warm tint.
- Validation hook: Working agent → its building subtly brighter than neighbors.

### R7. Shooting-star on task completion (night only)
- Impact: M · Effort: S · Confidence: H
- Problem: Night sky has stars/constellations (`SkyRenderer.js:29-46`) but no transient celestial event. Task completion has no atmospheric reaction.
- Proposal: New `SkyRenderer.triggerShootingStar({ angle, length })`. Draw a 1.2 s arc above `STAR_CEILING_FRAC` with screen-blend white head + warm trail. Pool max 3 concurrent.
- Touchpoints: `SkyRenderer.js:83` (new method nearby); task-completion subscription.
- New assets needed: none (procedural).
- Dependencies: **Portal/CodeHealth** or **Behavior** for the completion event.
- Motion-budget band: `fast` one-shot. Static fallback: skip — don't allocate.
- Validation hook: Manual trigger at night → visible arc.

### R8. Lighthouse beam visible in fog/storm
- Impact: M · Effort: S · Confidence: H
- Problem: `_drawLighthouseBeam` (`IsometricRenderer.js:6210-6226`) uses additive screen blend, which dies under the foreground weather wash. The beacon vanishes in storms.
- Proposal: When `weather.type ∈ {'fog','rain','storm'}`, multiply beam alpha by `1 + intensity * 0.6` and widen bloom. Add a faint volumetric cone pass at 0.4 alpha so the beam cuts through fog.
- Touchpoints: `IsometricRenderer.js:6210-6257` (`_drawLighthouseBeam`, `_drawBeamWedge`).
- New assets needed: none.
- Dependencies: **Buildings** if Observatory sweep wants the same treatment.
- Motion-budget band: `slow`.
- Validation hook: `setWeather('storm', 0.9)` after dark → beam punches through.

### R9. Wind-driven foliage sway
- Impact: M · Effort: M · Confidence: M
- Problem: `motion.windX` (`AtmosphereState.js:838`) drives cloud drift and rain slant, but trees and grass are statically drawn. The forest is dead.
- Proposal: When drawing tree sprite, apply 1-pixel horizontal offset `dx = sin(t * 0.001 + seed) * windX * 1.5`. Skip boulders and small bushes. Cap ±2 px to avoid pixel-art shimmer.
- Touchpoints: `IsometricRenderer.js:616` (tree drawing path near `treePropSprites`).
- New assets needed: none.
- Dependencies: none.
- Motion-budget band: `medium`. Static fallback: zero offset.
- Validation hook: `setWeather('storm', 1)` → visible palm sway near harbor.

### R10. Smoke plumes from active Forge / Mine
- Impact: M · Effort: S · Confidence: H
- Problem: `smoke` preset (`ParticleSystem.js:73-80`) is never spawned. Forge and Mine look idle when agents work there.
- Proposal: When Code Forge or Token Mine hosts a working agent, emit 1 `smoke` particle every 600 ms from a roof anchor. Extend the emitter list with `gatedBy: 'building.activeAgents'`.
- Touchpoints: `IsometricRenderer.js:1055-1064` (emitter list), `IsometricRenderer.js:2200-2210` (spawn loop).
- New assets needed: none.
- Dependencies: **Behavior** for agent→building activity map.
- Motion-budget band: `medium`. Static fallback: a single static smoke puff.
- Validation hook: Agent works at Code Forge → smoke wafts from chimney.

## Quick Wins (≤1 day each)

- **R2** — Wire aurora to push events (≈ 1 hour of glue + 1 hour test)
- **R7** — Shooting-star trigger (≈ 2 hours; entirely additive in `SkyRenderer`)
- **R4** — Seasonal ambient (≈ 4 hours; touches 1 new file + 1 import)
- **R8** — Beacon-through-weather alpha boost (≈ 1 hour; one method edit)
- **R10** — Smoke plumes from working forge/mine (≈ 3 hours; extends existing emitter list)

## Bugs / Defects Observed

- `SkyRenderer.js:529-580` — `_drawClouds` fallback (no descriptors) is per-frame uncached looping. `AtmosphereState.buildCloudLayers` always produces descriptors, so this is dead code in practice. Severity: **low-med** (remove or guard).
- `WeatherRenderer.js:117-178` — `_drawRain` rebuilds a path over up to 420 streaks every frame; consider pre-rasterizing a static streak plate per `(canvas.size, seed)` for reduced-motion. Severity: **low** (storm-only).
- `IsometricRenderer.js:6259-6340` — `_getAtmosphereVignette` cache invalidates on every snapshot tick because `atmosphere.cacheKey` rebuckets on phase progress; consider quantizing phase into 8 bins. Severity: **low**.
- `ParticleSystem.js:185-223` — `spawn` has no rate cap; a bursty caller with `count=100` consumes the pool in one frame. Severity: **low** (preventative).
- `SkyRenderer.js:438-460` — `_drawCodeMoon` fallback ignores authored-asset gibbous/half when `cool` variant is missing; flat dark disc on `phase==='new'`. Severity: **low**.
- `AtmosphereState.js:430-453` — `blendPalette` runs hex→rgb→hex per snapshot for 7 channels; trivial memoize opportunity. Severity: **trivial**.

## Cross-Domain Coordination

- **Buildings & Spatial** (3): R6 + R10 need a per-building active-agent map; R5 water warmth should agree with roof glint.
- **Agent Behavior** (2): R6 (working-status flag), R10 (worker→building binding).
- **Character Design** (4): R4 winter palette coordination; agent shading should agree with `reactions.warmGlint`.
- **Git/Harbor Flow** (5): R2 needs the push-success event.
- **Portal/CodeHealth** (6): R7 needs the task-completion event.

No blockers — all cross-domain deps are light event-bus subscriptions that fit `AgentEventStream` and `RelationshipState`.

## Council Debate Stance

If the council can fund only 3 items, I defend **R1 (godrays)**, **R5 (phase-coupled water palette)**, and **R3 (sprite rain impacts)** — in that order.

ClaudeVille's most-photographed moment is dusk; the screenshot the user shared *is* dusk. The two breaks that hit hardest there are (a) no light spilling from the warm sun across silhouettes, and (b) teal water under an orange sky. R1 and R5 together rewrite golden hour in roughly a day each, and both reuse atmosphere-state values that are already computed and discarded (`sunWarmth`, `warmGlint`, `nightReflection`) — the highest impact-per-effort ratio in this report.

R3 is third because the manifest already ships rain-splash and rain-ripple sprites; buying them and not using them is debt. R2 and R7 are sexier but fire rarely — the everyday view doesn't change. R9 (foliage sway) is the honorable mention; swap for R3 if the council prefers ambient liveliness over storm drama. R4, R6, R8, R10 ride on other councils' event hooks and may not arrive this round. The three I defend sit entirely within Visual files, ship motion-budget-clean static fallbacks, and make ClaudeVille feel like *a place at this hour* rather than a snapshot.
