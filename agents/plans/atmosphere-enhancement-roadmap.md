# ClaudeVille Atmosphere Enhancement Roadmap

Date: 2026-04-28
Status: research plan, implementation not started
Scope: World mode atmosphere, weather, day/night, sky visualization, lighting, water response, debug QA

## Purpose

ClaudeVille now has a working local-clock atmosphere loop, but it still reads as layered visual effects rather than a cohesive living world. This plan describes the next atmosphere ramp-up after the initial day/night/weather implementation.

The goal is to make the world feel alive while keeping the project constraints intact:

- no bundler, no app test runner, vanilla ES modules and Canvas 2D;
- local-only deterministic behavior by default;
- no geolocation or network weather dependency;
- labels and agent status must stay readable;
- motion must follow `docs/motion-budget.md`;
- sprite additions must go through `manifest.yaml` plus sprite validation.

This plan supersedes the forward-looking parts of:

- `agents/plans/weather-atmosphere-clock-system.md`
- `agents/plans/living-twilight-sky.md`

It complements, but does not replace, broader world-building plans such as:

- `agents/plans/claudeville-atmosphere-epic-rampup.md`
- `agents/plans/world-enhancement-plan.md`

## Current Baseline

Implementation baseline:

- `HEAD`: `48e7c33c54fad9f56c45810a74c27c7a98604f77`
- Current worktree has pre-existing local modifications. Implementation agents must refresh `git status --short` and owned-path diffs before editing.

Observed dirty paths at plan time:

```text
 M AGENTS.md
 M CLAUDE.md
 M claudeville/assets/sprites/manifest.yaml
 M claudeville/assets/sprites/props/prop.villageGate.png
 M claudeville/assets/sprites/props/prop.villageWall.png
 M claudeville/src/config/scenery.js
 M claudeville/src/presentation/character-mode/AtmosphereState.js
 M claudeville/src/presentation/character-mode/IsometricRenderer.js
 M claudeville/src/presentation/character-mode/SkyRenderer.js
```

Treat those as shared-checkout changes unless explicitly owned by a later implementation task.

## Current Architecture Findings

### Atmosphere State

`claudeville/src/presentation/character-mode/AtmosphereState.js` is the semantic kernel. It computes a pure snapshot from local time, weather override, hour override, and motion preference.

Current snapshot fields:

- `phase`, `phaseProgress`, `dayProgress`
- `clock`
- `weather`
- `sky`
- `grade`
- `lighting`
- `motion`

Current strengths:

- Pure and local; easy to sample from Node and Playwright.
- Debug helper exists as `window.__claudeVilleAtmosphere`.
- `prefers-reduced-motion` is represented in `motion`.
- Render consumers already read snapshot fields instead of recomputing most atmosphere decisions.

Current weaknesses:

- Weather is still a block-level roll, not a timeline with transitions.
- Phase palettes are selected discretely.
- Weather type support is inconsistent: `WeatherRenderer` supports `storm`, but `AtmosphereState` does not emit or accept it.
- Debug override cannot set wind, transition progress, storm, or fixed seed.
- Cache key buckets protect performance but make some transitions visibly stepped.

### Sky Rendering

`claudeville/src/presentation/character-mode/SkyRenderer.js` owns viewport-fixed sky, sun, moon, stars, clouds, aurora, and light background weather.

Current strengths:

- Correct draw order: sky first, before camera transform.
- Static sky plate is cached by viewport and atmosphere cache key.
- Sun/moon/clouds are driven by atmosphere fields.
- Aurora is already present as a special-event sky effect.

Current weaknesses:

- Cloud layout is evenly spaced and can look tiled.
- Stars are simple deterministic pixels with no constellations or depth.
- Sun and moon paths are simple fixed arcs.
- Background rain/fog and foreground rain/fog responsibilities overlap with `WeatherRenderer`.
- The sky canopy pass duplicates celestial/cloud drawing over the world, which is visually useful but should be explicitly documented and tuned.

### Weather Rendering

`claudeville/src/presentation/character-mode/WeatherRenderer.js` owns screen-space foreground weather after world sprites and particles, before labels.

Current strengths:

- Foreground weather is isolated in a small module.
- Rain/fog honor reduced motion by freezing animation state.
- Streak counts are capped by viewport area.
- Storm flashes exist in renderer code.

Current weaknesses:

- Storm cannot be reached through `AtmosphereState`.
- Rain and fog do not interact with terrain, water, buildings, roofs, or agent occlusion.
- Weather is mostly full-screen, so heavy weather can read as pasted on.
- Layer ownership between `SkyRenderer._drawBackgroundWeather()` and `WeatherRenderer.drawForeground()` is not fully clear.

### World Lighting

`IsometricRenderer._render()` computes atmosphere each frame, passes lighting into `BuildingSprite`, and uses atmosphere in these passes:

- pre-building additive terrain light/reflection pass;
- building shadows;
- council/talk/arrival/departure effects;
- screen-space vignette/weather/glow pass;
- lighthouse beam intensity.

`BuildingSprite` already consumes `lighting.shadowLength`, `shadowAlpha`, `shadowAngleRad`, and `lightBoost`.

Current weaknesses:

- World sprites do not get true directional relighting; current effect is shadows plus overlays.
- Clock Observatory clock hands still use `new Date()` rather than `atmosphere.clock`, so debug `setHour()` can disagree with the visible clock.
- Terrain cache should not rebuild for atmosphere, so phase-aware ground effects must be dynamic or carefully split.

### Water And Weather Response

Water data comes from `SceneryEngine` sets:

- `waterTiles`
- `deepWaterTiles`
- `lagoonWaterTiles`
- `shoreTiles`
- `bridgeTiles`

Water visual logic lives mainly in `IsometricRenderer`:

- static cache: water tones, depth wash, structure, contours, foam, surf;
- dynamic pass: current bands, shimmer, shoreline reflection;
- separate systems: fish, waterfalls, gulls, harbor traffic.

Current weaknesses:

- Water identity is inferred through sets and coordinate boxes such as `_isHarborWater()`.
- Shoreline masks are cardinal-only, so edges can look stair-stepped.
- Water colors are mostly hardcoded in renderer methods rather than tokens.
- There is duplicate shimmer logic in static terrain and dynamic water paths.
- Harbor ship wakes do not feed back into the main water layer.

## Design Principles

1. Atmosphere is semantic first, visual second.
   The atmosphere snapshot should describe conditions. Renderers should consume it.

2. Local deterministic behavior stays the default.
   The same date/time/seed should produce the same village state after reload.

3. Transitions should be continuous even when cache keys are quantized.
   Cache buckets are fine for plates; visible alpha, palette, and lighting should ease.

4. Weather should touch the world in small, readable ways.
   Prefer puddles, water ripples, window warmth, roof glints, fog near water, and harbor wakes over opaque full-screen overlays.

5. Motion must be sparse and intentional.
   Use `static`, `slow`, `medium`, and `fast` pulse bands. Weather drift is `slow`; lightning is one-shot `fast`; rainfall is continuous but must have a static reduced-motion fallback.

6. Debug controls are mandatory for visual work.
   No serious atmosphere pass should ship without deterministic QA hooks and Playwright screenshot recipes.

## Target Architecture

### Atmosphere Snapshot V2

Extend the snapshot gradually toward this shape:

```js
{
  phase: 'dawn' | 'day' | 'dusk' | 'night',
  phaseProgress: 0,
  dayProgress: 0,
  transition: {
    from: 'day',
    to: 'dusk',
    weight: 0.25,
    edge: 'pre-dusk',
  },
  clock: {
    hours, minutes, seconds, label, minuteOfDay,
  },
  weather: {
    type: 'clear' | 'partly-cloudy' | 'overcast' | 'rain' | 'fog' | 'storm',
    previousType: 'overcast',
    nextType: 'clear',
    intensity: 0.58,
    transitionProgress: 0.35,
    precipitation: 0.6,
    cloudCover: 0.9,
    fog: 0.15,
    windX: 1,
    seed: 123456,
  },
  sky: {
    palette,
    assetIds,
    sun,
    moon,
    starsAlpha,
    cloudAlpha,
    cloudDensity,
    cloudLayers,
  },
  lighting: {
    sunDirIso,
    sunWarmth,
    ambientLight,
    ambientTint,
    shadowAngleRad,
    shadowLength,
    shadowAlpha,
    lightWarmth,
    lightBoost,
    sunBloomScale,
    beaconIntensity,
    waterGlintScale,
  },
  grade: {
    overlayAlpha,
    vignetteAlpha,
    worldTint,
    horizonWash,
    buildingGlowScale,
  },
  reactions: {
    puddleAlpha,
    roofGlintAlpha,
    waterRippleScale,
    windowWarmth,
    fogNearWaterAlpha,
  },
  motion: {
    driftEnabled,
    particleEnabled,
    clockDriftPx,
    windX,
  },
  cacheKey,
}
```

Do not add all fields at once. Add fields only when a renderer consumes them.

## Implementation Roadmap

### Phase 0: Baseline, Ownership, And Visual Harness

Goal: make atmosphere work testable before further visual edits.

Files likely touched:

- `agents/plans/atmosphere-enhancement-roadmap.md`
- optional: `agents/research/atmosphere-enhancement/`

Tasks:

- Refresh `git status --short` and owned-path diffs.
- Capture current screenshots for canonical states:
  - clear day, noon
  - clear night, midnight
  - dawn
  - dusk
  - rain day
  - fog dawn
  - storm candidate if enabled later
- Store screenshots under `agents/research/atmosphere-enhancement/` or `output/playwright/`.
- Record the console helper commands used for each state.

Acceptance:

- A reviewer can reproduce visual baselines without waiting for the actual clock.
- Dirty paths are classified before code work.

Validation:

```bash
node --check claudeville/src/presentation/character-mode/AtmosphereState.js
node --check claudeville/src/presentation/character-mode/SkyRenderer.js
node --check claudeville/src/presentation/character-mode/WeatherRenderer.js
node --check claudeville/src/presentation/character-mode/IsometricRenderer.js
```

Browser QA:

```js
window.__claudeVilleAtmosphere.setHour(12)
window.__claudeVilleAtmosphere.setWeather('clear', 0.15)
window.__claudeVilleAtmosphere.snapshot()
```

### Phase 1: Atmosphere Contract Cleanup

Goal: make the semantic model coherent before adding new visuals.

Files:

- `claudeville/src/presentation/character-mode/AtmosphereState.js`
- `claudeville/src/presentation/character-mode/WeatherRenderer.js`
- `claudeville/src/presentation/character-mode/SkyRenderer.js`
- `claudeville/src/presentation/character-mode/IsometricRenderer.js`

Tasks:

- Define one weather type registry and use it in state and renderers.
- Decide whether `storm` is first-class. Recommended: add it now, but keep its probability very low.
- Export or centralize weather presets so state, debug helper, and renderers cannot drift.
- Extend debug helper:
  - `setWeather(typeOrObject, intensity, windX)`
  - `setSeed(seed)`
  - `setTimelineMode('auto' | 'fixed')`
  - `clear()`
- Include wind and seed in `snapshot()`.
- Add phase/weather debug text to the existing `Shift+D` overlay instead of visible production UI.
- Fix Clock Observatory time source so `_clockTime()` can consume `atmosphere.clock` during draw/update.

Acceptance:

- `storm` cannot be supported by one renderer and unreachable from state.
- Debug time and visible Clock building agree.
- Playwright can force all weather states deterministically.

Validation:

```bash
node --check claudeville/src/presentation/character-mode/AtmosphereState.js
node --check claudeville/src/presentation/character-mode/WeatherRenderer.js
node --check claudeville/src/presentation/character-mode/SkyRenderer.js
node --check claudeville/src/presentation/character-mode/IsometricRenderer.js
node --check claudeville/src/presentation/character-mode/BuildingSprite.js
```

### Phase 2: Continuous Phase Blending

Goal: remove stepped day/night transitions.

Files:

- `AtmosphereState.js`
- `SkyRenderer.js`
- `IsometricRenderer.js`

Tasks:

- Replace direct `PALETTES[phase]` selection with blended palette output near phase boundaries.
- Add color helpers:
  - hex to RGB
  - RGB interpolation
  - RGB string interpolation for tint fields
- Blend `grade` and `lighting` across dawn/day/dusk/night instead of hard branching at phase boundaries.
- Keep `phase` for semantic labels, but add `transition` for renderer nuance.
- Revisit `cacheKey`: keep static plate buckets, but avoid abrupt visible jumps for sun alpha, cloud alpha, vignette, and light boost.
- Make `sunWarmth`, `ambientTint`, `horizonWash`, and `worldTint` continuous.

Acceptance:

- Scrubbing 05:15 to 07:15 and 17:00 to 19:30 has no visible color snap.
- Labels remain readable at every transition.
- Night remains cool; dawn/dusk can be warm but not crimson-dominant.

Validation:

- Playwright screenshots at 05:15, 05:45, 06:15, 06:45, 07:15.
- Playwright screenshots at 17:00, 17:45, 18:15, 18:45, 19:30.

### Phase 3: Weather Timeline And Transitions

Goal: make weather feel like passing fronts rather than isolated random blocks.

Files:

- `AtmosphereState.js`
- optional new: `WeatherTimeline.js`

Recommended architecture:

- Generate deterministic daily weather knots from `localDateKey` and optional seed.
- Use 4 to 6 knots per day, not fixed 3-hour hard states.
- Each knot contains:
  - `minute`
  - `type`
  - `intensity`
  - `windX`
  - `cloudCover`
  - `precipitation`
  - `fog`
- Interpolate numeric fields between knots.
- Crossfade categorical fields by rendering previous/next effects proportionally when needed.

Recommended probability shape:

- clear: common
- partly-cloudy: common
- overcast: medium
- fog: dawn/night weighted
- rain: uncommon
- storm: rare, usually starts from overcast/rain

Tasks:

- Add `buildWeatherTimeline(date, seed)` and `resolveWeatherAt(minute, timeline)`.
- Bias fog toward early morning and late night.
- Bias storm toward afternoon/evening and only when cloud cover is high.
- Add `weather.transitionProgress`, `previousType`, and `nextType`.
- Keep debug override simple: fixed weather should bypass timeline.
- Include enough of the timeline in debug `snapshot()` for QA.

Acceptance:

- Rain rarely lasts all day unless explicitly forced.
- Weather transitions do not snap abruptly at block boundaries.
- Debug fixed weather still works.

Validation:

- Node sample command prints 24 hourly snapshots for a fixed date.
- Browser screenshots for a date with at least one weather transition.

### Phase 4: Sky Composition Upgrade

Goal: make sky layers feel authored and non-repeating.

Files:

- `SkyRenderer.js`
- `AtmosphereState.js`
- `manifest.yaml`
- `claudeville/assets/sprites/atmosphere/*`

Tasks:

- Replace even cloud tiling with seeded cloud layer descriptors:
  - `xFrac`
  - `yFrac`
  - `scale`
  - `alpha`
  - `parallax`
  - `assetId`
- Generate cloud descriptors in `AtmosphereState` or a helper so reloads are deterministic.
- Keep drift dynamic, but base positions deterministic from date/weather seed.
- Add star clusters and 2 to 4 tiny constellations for night.
- Add moon phase variation seeded by date:
  - crescent, half, gibbous can be code-drawn masks first;
  - asset variants can come later.
- Add horizon occlusion: sun/moon fade and flatten as they approach horizon.
- Keep sky canopy pass, but tune it to avoid making the sun appear on top of tall world elements too strongly.

Acceptance:

- Wide screens no longer reveal evenly spaced cloud rows.
- Night sky has structure without becoming busy.
- Day, dawn, dusk, and night have distinct identities.

Motion budget:

- Cloud drift: `slow`.
- Star twinkle, if added: `slow`, very low alpha, static fallback.
- Aurora: existing special event, keep one-shot behavior.

Validation:

```bash
node --check claudeville/src/presentation/character-mode/SkyRenderer.js
npm run sprites:validate
```

Browser screenshots:

- 1280x720
- 1690x1185
- mobile-ish narrow viewport if practical

### Phase 5: Foreground Weather Layer Ownership

Goal: clarify render responsibilities and improve precipitation/fog quality.

Files:

- `SkyRenderer.js`
- `WeatherRenderer.js`
- `IsometricRenderer.js`

Decision:

- `SkyRenderer` owns sky conditions:
  - cloud banks
  - sun/moon/star occlusion
  - horizon wash
  - far fog plate
- `WeatherRenderer` owns world-facing screen-space weather:
  - rain streaks
  - fog bands
  - storm flashes
  - drifting mist sheets

Tasks:

- Move or rename background precipitation so rain is not visually duplicated unless intentional.
- Let `WeatherRenderer` read `weather.precipitation`, `weather.fog`, and `weather.cloudCover` instead of only `type/intensity`.
- Add depth-aware fog bands:
  - denser in lower half of screen;
  - lighter over labels;
  - optional water-near fog from Phase 6.
- Add reduced-motion static variants:
  - rain becomes sparse fixed diagonal streaks;
  - fog becomes fixed translucent bands;
  - storm flash suppressed or shown as rare static brighten only when forced.
- Add one-shot lightning only for `storm`.

Acceptance:

- Rain, fog, and overcast have distinct silhouettes.
- Heavy weather never hides building labels or agent badges.
- Reduced motion has no continuous particle drift.

Validation:

```bash
node --check claudeville/src/presentation/character-mode/WeatherRenderer.js
```

Browser states:

- `clear`
- `overcast`
- `rain`
- `fog`
- `storm`
- reduced-motion emulation if available through Playwright/browser settings.

### Phase 6: World Reactions

Goal: make weather and time affect the village, not just the screen.

Files:

- `AtmosphereState.js`
- `IsometricRenderer.js`
- `BuildingSprite.js`
- `WeatherRenderer.js`
- possibly `ParticleSystem.js`

Recommended first reactions:

- Rain:
  - stronger water ripple scale;
  - small puddle/glint diamonds on path/plaza tiles;
  - occasional roof/window sparkle on buildings;
  - dimmer sun/moon and stronger warm interior glows.
- Fog:
  - low bands near water/shore;
  - reduced distant contrast;
  - lighthouse beam slightly more visible.
- Overcast:
  - muted shadows;
  - cooler world tint;
  - less water sparkle.
- Night:
  - stronger building lights;
  - lighthouse and portal read more strongly;
  - selected/working/status effects still retain priority.
- Dawn/dusk:
  - warm rim glints on building tops;
  - longer softer shadows;
  - water highlights skew gold/rose, not only cyan.

Tasks:

- Add `atmosphere.reactions` with small scalar fields.
- Use dynamic passes, not terrain cache rebuilds, for weather-specific ground effects.
- Add a bounded puddle overlay pass over visible path/plaza tiles.
- Add roof/window glints through `BuildingSprite` or `BuildingRenderer` using existing lighting hooks.
- Ensure reaction passes are skipped or static when `motionScale <= 0`.

Acceptance:

- A screenshot without the sky still communicates rain/fog/night through world reactions.
- Effects are subtle enough that ClaudeVille remains a dashboard, not a weather simulator.

Motion budget:

- Puddle glints: `slow` or `static`.
- Window/roof sparkles: one-shot `fast`, rare.
- Rain ripples: `slow`, static fallback.

### Phase 7: Water Region Model And Weather-Aware Water

Goal: support better atmosphere-water interaction without fragile coordinate checks.

Files:

- `SceneryEngine.js`
- `IsometricRenderer.js`
- `theme.js` or new local water palette module
- `scenery.js`

Tasks:

- Add explicit per-tile water metadata:
  - `kind: 'lagoon' | 'river' | 'sea' | 'harbor'`
  - `depth: 'shallow' | 'deep'`
  - `openness`
  - optional `flowX`, `flowY`
- Replace coordinate-box `_isHarborWater()` and parts of `_isOpenSeaTile()` with metadata.
- Centralize water tokens:
  - lagoon shallow/deep
  - sea shallow/deep
  - harbor
  - foam
  - shimmer
  - storm tint
  - night tint
- Remove duplicate/dead shimmer paths or document which pass owns static vs dynamic shimmer.
- Add weather-aware water response:
  - rain ripple density;
  - storm roughness;
  - fog edge wash;
  - night reflection scale;
  - dawn/dusk warm glints.
- Let `HarborTraffic` expose wake/ripple descriptors for the water pass to render before ships.

Acceptance:

- Water tuning can happen from one token table.
- Harbor, sea, river, lagoon visuals can diverge without coordinate hacks.
- Rain visibly affects water without adding full-screen noise.

Validation:

```bash
node --check claudeville/src/presentation/character-mode/SceneryEngine.js
node --check claudeville/src/presentation/character-mode/IsometricRenderer.js
node --check claudeville/src/config/scenery.js
node --check claudeville/src/config/theme.js
```

### Phase 8: Asset-Backed Polish

Goal: use sprites where raster art beats canvas strokes.

Files:

- `manifest.yaml`
- `claudeville/assets/sprites/atmosphere/*`
- possibly `SkyRenderer.js`
- possibly `IsometricRenderer.js`

Candidate assets:

- `atmosphere.cloud.cumulus.large.day`
- `atmosphere.cloud.cumulus.small.day`
- `atmosphere.cloud.wisp.high`
- `atmosphere.cloud.overcast.shelf`
- `atmosphere.cloud.storm.shelf`
- `atmosphere.moon.half.cool`
- `atmosphere.moon.gibbous.cool`
- `atmosphere.rain.splash`
- `atmosphere.fog.wisp.low`
- `atmosphere.water.ripple.rain`
- `atmosphere.water.foam.corner`
- `atmosphere.water.harbor.wake`

Rules:

- Use code for large gradients, stars, fog fields, and general rain.
- Use PNG assets for recognizable cloud silhouettes, moon variants, shoreline foam motifs, and small splash/wake stamps.
- Every referenced ID must be in the manifest.
- Every new PNG should match the manifest-implied path from `AssetManager._pathFor()`.
- Bump `style.assetVersion` when PNGs change.

Validation:

```bash
npm run sprites:validate
```

Manual gates:

- Inspect validator warnings for orphan PNGs.
- Browser screenshots in all phase/weather states.

## Suggested Work Slices

### Slice A: Semantic Foundation

Owner paths:

- `AtmosphereState.js`
- `WeatherRenderer.js`
- `SkyRenderer.js`

Deliverables:

- unified weather registry;
- storm decision;
- richer debug helper;
- timeline data shape, even if not fully visual yet.

### Slice B: Debug And Clock Consistency

Owner paths:

- `BuildingSprite.js`
- `IsometricRenderer.js`
- `DebugOverlay.js`

Deliverables:

- Clock building uses atmosphere clock;
- Shift+D includes atmosphere readout;
- Playwright recipes documented.

### Slice C: Phase Blending And Sky

Owner paths:

- `AtmosphereState.js`
- `SkyRenderer.js`

Deliverables:

- palette interpolation;
- seeded cloud descriptors;
- improved stars/moon path.

### Slice D: Weather Rendering

Owner paths:

- `WeatherRenderer.js`
- `SkyRenderer.js`
- `IsometricRenderer.js`

Deliverables:

- clarified background/foreground ownership;
- improved rain/fog/storm renderers;
- reduced-motion static fallbacks.

### Slice E: World And Water Reactions

Owner paths:

- `SceneryEngine.js`
- `IsometricRenderer.js`
- `theme.js`
- `HarborTraffic.js`

Deliverables:

- water metadata;
- weather-aware water tokens;
- rain ripple/puddle passes;
- harbor wake descriptors.

### Slice F: Asset Polish

Owner paths:

- `manifest.yaml`
- `claudeville/assets/sprites/atmosphere/*`
- renderers that reference new IDs

Deliverables:

- cloud/moon/weather/water stamp sprites;
- sprite validation;
- browser screenshot comparison.

## Risk Register

| Risk | Why It Matters | Mitigation |
| --- | --- | --- |
| Terrain cache churn | Rebuilding terrain on every atmosphere change will hurt frame rate. | Keep atmosphere in dynamic passes and cached sky plates keyed coarsely. |
| Label/readability loss | Weather overlays can make dashboard information unusable. | Keep weather before labels; cap alpha; test dense labels. |
| Motion overload | ClaudeVille already has agent, water, harbor, and ritual motion. | Claim pulse bands and add reduced-motion fallbacks. |
| Weather type drift | Current storm support already diverges by module. | Centralize registry before new visual states. |
| One-note palette | Night/day/weather can collapse into blue/cyan everywhere. | Explicitly tune warm light, neutral clouds, and water tokens. |
| Asset drift | Manifest and PNGs can desync. | Require `sprites:validate`, inspect orphan warnings, bump asset version. |
| Dirty shared checkout | Several files are already modified. | Rebaseline before every owned edit and avoid unrelated staging. |

## Acceptance Criteria For The Full Atmosphere Ramp

- Day, dawn, dusk, and night are visually distinct and transition smoothly.
- Rain, fog, overcast, clear, partly-cloudy, and storm are reachable through debug controls.
- Weather changes over time without all-day lock-in.
- The world itself reacts to weather and time through water, lights, shadows, and small terrain accents.
- Clock Observatory agrees with atmosphere debug time.
- Water region behavior no longer depends primarily on coordinate boxes.
- Reduced motion produces static readable atmosphere states without continuous drift.
- Browser screenshots show no overlapping UI/text regressions at common viewport sizes.
- Validation commands pass for all touched JS files and sprite manifest changes.

## Recommended First Implementation Order

1. Phase 1: contract cleanup plus Clock debug consistency.
2. Phase 2: phase blending.
3. Phase 3: weather timeline.
4. Phase 5: foreground weather ownership.
5. Phase 6: world reactions, starting with rain water ripples and night light balance.
6. Phase 7: water metadata and tokens.
7. Phase 8: asset-backed polish.

Do not start with assets. The renderer/state contracts should be stable first, or generated sprite work will be harder to evaluate.

