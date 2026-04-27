# Weather, Atmosphere, And Clock Tower Implementation Plan

## Goal

Replace the current fixed "living twilight" sky with a local-time atmosphere system:

- Day/night mode follows the computer's local clock.
- Day renders a blue sky with sun and clouds.
- Night renders a cool eerie blue-black sky with moon and stars.
- Sun, moon, stars, and clouds progress east to west as time advances.
- Weather is structured as an extensible system, not a one-off sky repaint.
- The Research Observatory is visually revamped into a clock tower that shows approximate local time.

This plan supersedes `agents/plans/living-twilight-sky.md`.

## Planning Baseline

This baseline was refreshed after plan validation because the shared checkout changed while reviewers were running. Treat it as informational only; implementation agents must refresh it before receiving write ownership.

- Current `HEAD`: `899f074c8e4c5e4177e8b31ff18414f4da7490bf`
- Current `git status --short` includes unrelated local changes that implementation agents must not revert:
  - `?? .codex`
  - `?? agents/plans/weather-atmosphere-clock-system.md`
  - `?? taskboard-hero-smoke.png`

Before any implementation assignment, refresh this baseline with `git rev-parse HEAD`, `git status --short`, and owned-path diffs/hashes. If any owned path changed since assignment, stop and ask the orchestrator to rebaseline.

## Current State

- `SkyRenderer.js` is already wired in the right place: it draws before `camera.applyTransform()` in `IsometricRenderer._render()`.
- The current sky is crimson because `SkyRenderer.js` hard-codes warm brown/orange gradient stops, warm stars, amber halos, warm cloud prompts, and a warm crescent moon.
- A second pass, `IsometricRenderer._drawAtmosphere()`, still applies warm/green/brown grading over the world after sprites and before labels. This must become state-driven or it will keep tinting every time of day toward twilight.
- `SkyRenderer` cache keys only include viewport size. A day/night/weather system needs phase/weather/time bucket keys to avoid stale backgrounds.
- The terrain cache includes some warm diorama rim/backdrop tones. Do not bake time-of-day into terrain cache; keep terrain stable and apply clock/weather lighting in screen-space overlays.
- The observatory is a composed hero building at `building.observatory` with a pulsing `astrolabe` layer. Keep the `type: 'observatory'` contract because tool routing maps web/research activity to that building.

## Design Decisions

1. Local time source:
   - Use browser local time via `Date`.
   - Do not call network weather or geolocation APIs for the first implementation.
   - Use fixed local clock phases: dawn `05:30-07:00`, day `07:00-17:30`, dusk `17:30-19:00`, night `19:00-05:30`.
   - Compute minutes since local midnight as `hours * 60 + minutes + seconds / 60`.
   - Use one wrap-safe interval helper for phase progress:
     - if `end >= start`, progress applies when `start <= minute < end`;
     - if `end < start`, add `1440` to `end`, and add `1440` to `minute` when `minute < start`;
     - clamp progress to `[0, 1]`.
   - `dayProgress` is always `minute / 1440`.
   - Later, sunrise/sunset can be made configurable if the app gets a location setting.
   - Do not derive sun position, moon position, cloud clock position, weather phase, or clock hands from `waterFrame`, accumulated `dt`, or `motionScale`.

2. Screen-space compass:
   - Define screen-left horizon as east and screen-right horizon as west for sky-only motion.
   - Sun and moon move left to right across a shallow arc.
   - Clouds drift left to right by clock-derived offset plus light camera parallax.

3. Weather source:
   - Start with deterministic local ambient weather seeded by local date, not real weather.
   - Weather presets: `clear`, `partly-cloudy`, `overcast`, `rain`, `fog`.
   - Keep the weather engine visual-only. Do not attach semantic meaning to rain/fog yet.

4. Motion preference:
   - `prefers-reduced-motion` freezes decorative drift and particles.
   - It must not freeze semantic time state. Noon should still look like noon and night should still look like night.

5. Asset policy:
   - Use code for gradients, stars, sun glow, cloud placement, rain streaks, fog sheets, and clock hands.
   - Use PixelLab for new or replacement pixel-art sprites where raster art matters: cool moon, neutral day clouds, overcast cloud bank, and clock-tower base/face.

## Architecture

### New `AtmosphereState.js`

Create `claudeville/src/presentation/character-mode/AtmosphereState.js`.

Responsibilities:

- Hold the date provider and optional debug overrides.
- Compute a pure snapshot once per render frame from `now`, `dt`, `viewport`, and `motionScale`.
- Quantize visual cache keys to avoid per-frame cache churn.
- Expose a developer/debug API without adding visible UI.

Suggested snapshot:

```js
{
  phase: 'dawn' | 'day' | 'dusk' | 'night',
  phaseProgress: 0.0,
  dayProgress: 0.0,
  cacheKey: 'day|partly-cloudy|b84',
  weather: {
    type: 'clear' | 'partly-cloudy' | 'overcast' | 'rain' | 'fog',
    intensity: 0.0,
    windX: 1,
  },
  sky: {
    palette,
    assetIds: {
      clouds: ['atmosphere.cloud.cumulus.day'],
      moon: 'atmosphere.moon.crescent.cool',
    },
    sun: { visible, alpha, xFrac, yFrac },
    moon: { visible, alpha, xFrac, yFrac },
    starsAlpha,
    cloudAlpha,
    cloudDensity,
  },
  grade: {
    overlayAlpha,
    vignetteAlpha,
    worldTint,
    horizonWash,
    buildingGlowScale,
  },
  motion: {
    driftEnabled,
    particleEnabled,
    clockDriftPx,
  },
}
```

Lifecycle:

- `AtmosphereState.dispose()` must remove or neutralize `window.__claudeVilleAtmosphere` if this renderer instance installed it.
- The global helper should be singleton-safe: keep an owner token and avoid deleting another active renderer's helper.
- `IsometricRenderer.hide()` must call `this.atmosphereState?.dispose?.()` next to `this.skyRenderer?.dispose?.()`.

### Refactor `SkyRenderer.js`

Change the public call from positional arguments to an options object:

```js
this.skyRenderer.draw(ctx, {
  canvas,
  camera: this.camera,
  dt,
  atmosphere,
});
```

`SkyRenderer` should own:

- Cached sky plate: gradient, deterministic stars, distant halos.
- Sun and moon drawing.
- Far-cloud sprites and cloud banks.
- Screen-space weather background elements that belong behind the world.

Cache key:

```js
`${canvas.width}x${canvas.height}|${atmosphere.cacheKey}`
```

Implementation notes:

- Cache only the expensive sky plate: gradient, base seeded star field, static overcast/cloud-bank masks.
- Draw sun, moon, moving star offsets, and cloud offsets dynamically from the atmosphere snapshot. Do not create a new cached canvas for every per-frame celestial position.
- Quantize `atmosphere.cacheKey` by phase/weather/time bucket, not raw clock milliseconds.
- Use cool night colors: near-black navy, deep indigo, muted moonlit blue. Avoid red/orange in the sky at night.
- Day palette should be clear but not flat: deeper blue zenith, softer cyan horizon.
- Dawn/dusk can use restrained peach/lavender at the horizon, but should not regress to the current crimson world.
- Deterministic stars should use a seeded field and horizontal offset from local time. Stars are alpha-faded out during day.
- Clouds should use time-derived offset, not accumulated `dt`, so page reloads at the same clock time show the same sky position.
- New additive atmosphere IDs must be selected by `AtmosphereState.sky.assetIds` and consumed by `SkyRenderer`; adding PNGs to the manifest without changing runtime references is not complete.

### Refactor `IsometricRenderer` Atmosphere Pass

Update `IsometricRenderer` to construct and use `AtmosphereState`:

- Import and instantiate `this.atmosphereState`.
- In `_render(dt)`, compute `const atmosphere = this.atmosphereState.update(...)`.
- Pass `atmosphere` to `SkyRenderer`.
- Replace `_drawAtmosphere(ctx)` with `_drawAtmosphere(ctx, atmosphere)`.
- Key `_getAtmosphereVignette()` by viewport and `atmosphere.cacheKey`.
- Keep the atmosphere pass after particles and before labels.
- Apply `atmosphere.grade.buildingGlowScale` to both light passes:
  - the pre-building additive light/reflection pass near the terrain draw;
  - the post-sprite glow pass inside `_drawAtmosphere()`.
- Add debug text either by extending `DebugOverlay.js` or by drawing a small screen-space debug readout from `IsometricRenderer` only when the existing `Shift+D` overlay is active. The chosen implementation must be explicit in the worker assignment.

Lighting behavior:

- Day: low vignette, low building glow scale, mild horizon wash.
- Night: cool global tint, stronger warm building glows, readable labels preserved.
- Rain/fog: overlay after sprites but before labels, with capped alpha so labels remain readable.

Guardrails:

- Do not rebuild terrain cache on every time/weather change.
- Quantize all dynamic alpha cache keys before using `_withAlpha()` to avoid unbounded `Map` growth.

### Weather Renderer Scope

Split weather by render order:

- Background weather belongs in `SkyRenderer`: distant clouds, overcast sky plate, moon/sun occlusion.
- Foreground weather belongs in `IsometricRenderer` after sprites and before labels: rain streaks, fog bands, storm flashes that affect the world.
- If the foreground logic grows large, create `WeatherRenderer.js` and call it from the current `_drawAtmosphere()` position.

Preset behavior:

- `clear`: normal sun/moon/stars, sparse clouds.
- `partly-cloudy`: 2 cloud layers, moderate cloud alpha, stars reduced at night.
- `overcast`: cloud bank layer, muted sun/moon, stars hidden.
- `rain`: overcast base plus diagonal pixel rain streaks in screen space. Cap streak count by viewport area.
- `fog`: pale low-contrast fog bands over terrain after sprites, before labels.

All weather motion must honor `atmosphere.motion.particleEnabled`.

### Debug And QA Hooks

Do not add visible production controls.

Attach a developer helper in `AtmosphereState`:

```js
window.__claudeVilleAtmosphere = {
  setHour(hourNumber),
  setWeather(type, intensity),
  freeze(),
  clear(),
  snapshot(),
}
```

Also add optional debug overlay text only when the existing `Shift+D` debug overlay is active:

- phase
- local time
- weather
- cache key

This lets Playwright force noon, midnight, rain, etc. without adding app UI.

Debug helper lifecycle:

- Helper state must be in memory by default.
- If localStorage persistence is added, use a clearly debug-prefixed key and document how to clear it.
- `clear()` must restore local clock and deterministic daily weather.

## Sprite And Manifest Work

Update `claudeville/assets/sprites/manifest.yaml`:

- Bump `style.assetVersion`.
- Replace warm atmosphere prompts.
- Prefer additive IDs over destructive ambiguity where useful:
  - `atmosphere.cloud.cumulus.day`
  - `atmosphere.cloud.wisp.day`
  - `atmosphere.cloud.overcast`
  - `atmosphere.moon.crescent.cool`
- Remove or stop referencing the old ember cloud/moon IDs once the new assets load.
- Update `SkyRenderer` in the same implementation slice so new additive IDs are actually referenced.
- If a manifest layer is removed, remove or intentionally retain its PNG. `npm run sprites:validate` may warn about orphan PNGs without failing, so inspect validator output.

PixelLab generation:

- Clouds and moon: use MCP `create_map_object` for transparent background sprites.
- Clock tower hero base: use REST `create-image-pixflux` because the composed hero building is larger than 64px.
- The existing `scripts/sprites/generate-pixellab-revamp.mjs` can generate composed hero base quadrants, but it currently has a hard-coded warm global style and old observatory prompt. For this task, either:
  - add a targeted style override for `building.observatory` that avoids the warm global style and old prompt, and corrects the REST `detail` value to the canonical `high detail`, or
  - use a one-off REST call and the same crop/write logic from the script.

After PNG changes:

- Confirm dimensions with `file`.
- Run `npm run sprites:validate`.
- Inspect validator output for orphan warnings, especially old `building.observatory/astrolabe.png`.
- Confirm no checkerboard placeholders in browser.

## Clock Tower Plan

Keep:

- `type: 'observatory'`
- `id: building.observatory`
- existing routing from web/research tools to `observatory`

Change:

- Visible label to `CLOCK TOWER` or `CLOCK OBSERVATORY`.
- Short label to `CLOCK`.
- Sprite concept from observatory dome/astrolabe to a readable tower with a blank front clock face.

Recommended implementation:

1. Regenerate or edit the static hero base as a clock tower with:
   - stone tower silhouette
   - blue/copper scholarly accents
   - large blank circular clock face on the front
   - no baked clock hands
   - no text
2. Remove or replace the `astrolabe` layer if it competes with the clock face.
3. Add a functional overlay branch for `building.type === 'observatory'` in `BuildingSprite._drawFunctionalOverlay()`.
4. Draw hour and minute hands from local time.
5. No second hand.
6. Use pixel-snapped geometry. Best option: draw the clock hands into a tiny offscreen canvas with smoothing disabled, then blit it at the face position.
7. Use the same debug time override as `AtmosphereState` so screenshots can force `03:00`, `06:00`, `12:00`, and `18:00`.
8. After sprite generation, calibrate and record local face constants for the composed `312x208` sprite:
   - `faceCenter: [lx, ly]`
   - `faceRadius`
   - `handScale`
   - confirm the face is on the front half relative to `horizonY`.

Risk controls:

- Keep the clock face inside the base sprite silhouette because hit testing only uses base alpha.
- Keep the face below the landmark label area.
- Verify the overlay draws on the correct half of the split hero building. For a front-facing face, drawing with the front half is correct.

## Implementation Phases

### Phase 1: State Model And Debug Hooks

Owned paths:

- `claudeville/src/presentation/character-mode/AtmosphereState.js`
- `claudeville/src/presentation/character-mode/IsometricRenderer.js`
- `claudeville/src/presentation/character-mode/DebugOverlay.js` if debug text is implemented there

Tasks:

- Create the pure state module.
- Add fixed local phase schedule.
- Add deterministic daily weather selection.
- Add debug overrides.
- Wire `AtmosphereState` into the render loop.
- Add dispose/global-helper cleanup.
- Add exact wraparound phase tests as inline helper cases or a temporary console/dev validation note.

Validation:

- `node --check claudeville/src/presentation/character-mode/AtmosphereState.js`
- `node --check claudeville/src/presentation/character-mode/IsometricRenderer.js`

### Phase 2: Sky Renderer Refactor

Owned paths:

- `claudeville/src/presentation/character-mode/SkyRenderer.js`
- `claudeville/src/presentation/character-mode/IsometricRenderer.js`

Tasks:

- Replace fixed twilight palette with atmosphere palette snapshots.
- Add sun path, moon path, star alpha/offset, and clock-derived cloud offset.
- Replace cache keys.
- Keep reduced-motion behavior correct.

Validation:

- Syntax checks.
- Browser screenshots for forced `00:00`, `06:00`, `12:00`, `18:00`, `21:00`.
- Pixel sample check: noon sky should be blue-dominant; midnight sky should be dark blue/indigo, not red/orange dominant.

### Phase 3: Dynamic World Grading And Weather

Owned paths:

- `claudeville/src/presentation/character-mode/IsometricRenderer.js`
- optionally `claudeville/src/presentation/character-mode/WeatherRenderer.js`

Tasks:

- Parameterize `_drawAtmosphere()`.
- Scale both building light/reflection passes by time of day.
- Add rain/fog/overcast effects with capped per-frame work.
- Quantize alpha/cache keys.

Validation:

- Screenshots for `clear`, `partly-cloudy`, `overcast`, `rain`, and `fog`.
- Confirm labels and badges remain readable in all weather.
- Confirm dashboard mode unaffected.

### Phase 4: Atmosphere Assets

Owned paths:

- `claudeville/assets/sprites/manifest.yaml`
- `claudeville/assets/sprites/atmosphere/*.png`

Tasks:

- Generate cool moon, neutral day cloud, wisp cloud, and overcast cloud bank.
- Update manifest IDs/prompts.
- Bump `style.assetVersion`.

Validation:

- `file claudeville/assets/sprites/atmosphere/*.png`
- `npm run sprites:validate`
- Browser visual smoke for missing checkerboards.
- Confirm old ember assets are either unreferenced and intentionally retained, or removed with validator output reviewed.

### Phase 5: Clock Tower

Owned paths:

- `claudeville/src/config/buildings.js`
- `claudeville/assets/sprites/manifest.yaml`
- `claudeville/assets/sprites/buildings/building.observatory/*`
- `claudeville/src/presentation/character-mode/BuildingSprite.js`

Tasks:

- Update label/shortLabel.
- Update observatory manifest prompt/layers.
- Generate clock-tower base quadrants.
- Remove or replace `astrolabe.png` if the manifest layer is removed.
- Calibrate and record clock face local constants after asset generation.
- Add pixel-snapped live hour/minute hands.
- Use the same debug time override for QA.

Validation:

- `node --check claudeville/src/config/buildings.js`
- `node --check claudeville/src/presentation/character-mode/BuildingSprite.js`
- `npm run sprites:validate`
- Forced-time screenshots at `03:00`, `06:00`, `12:00`, `18:00`.
- Zoom checks at `1`, `2`, and `3`.

### Phase 6: Docs And Final Smoke

Owned paths:

- `claudeville/CLAUDE.md` if architecture notes need updating
- `AGENTS.md` and root `CLAUDE.md` only if root agent notes need updating
- this plan file, if implementation status is recorded

Validation:

- `node --check claudeville/server.js`
- `find claudeville/adapters claudeville/services -name '*.js' -print0 | xargs -0 -n1 node --check`
- Touched frontend module syntax checks.
- Runtime smoke at `http://localhost:4000`.
- `GET http://127.0.0.1:4000/api/providers`
- `GET http://127.0.0.1:4000/api/sessions`
- World and Dashboard mode smoke.
- Activity panel select/deselect smoke.
- Canvas resize smoke.
- Browser console review for changed area.
- `npm run sprites:capture-fresh`
- `npm run sprites:visual-diff`
- If root agent docs are edited, confirm `diff <(tail -n +3 CLAUDE.md) <(tail -n +3 AGENTS.md)` is empty.

## Full Swarm Execution Plan

This is a full-swarm implementation. Use the SOP in `docs/swarm-orchestration-procedure.md`.

Required gates:

- The orchestrator records a fresh baseline before every assignment.
- Every worker receives owned paths, read-only paths, baseline `HEAD`, `git status --short`, owned-path diff/hash snapshot, direct-edit permission, validation expectations, and stop conditions.
- Workers do not own overlapping write paths at the same time.
- Shared files are serialized. Workers may return notes or patch suggestions for a shared file they do not own, but they may not edit it directly.
- A high-effort reviewer returns one of `approve`, `approve-with-fixes`, `request-changes`, or `defer-follow-up` before integration.
- Before integrating each worker's result, the orchestrator reruns `git status --short` and compares owned paths against the assignment baseline.
- The orchestrator alone stages, commits, or pushes, and only with explicit user approval.

Recommended serialized workers:

1. Atmosphere state and sky refactor.
2. Weather overlays and dynamic world grading.
3. PixelLab asset generation and manifest updates.
4. Clock tower sprite and functional overlay.
5. Reviewer for cache, performance, reduced motion, and visual QA.

Avoid overlapping writes:

- Worker 1 owns `AtmosphereState.js`, `SkyRenderer.js`, and the minimal `IsometricRenderer.js` sky-state wiring. No other worker edits `IsometricRenderer.js` while this runs.
- Worker 2 owns the foreground weather/light-scaling section of `IsometricRenderer.js` only after Worker 1 is integrated. If `WeatherRenderer.js` is created, Worker 2 owns that file.
- Worker 3 owns all atmosphere manifest entries and `claudeville/assets/sprites/atmosphere/*.png`. Worker 4 must not edit `manifest.yaml` concurrently.
- Worker 4 owns observatory config, observatory building PNGs, `BuildingSprite.js`, and the observatory portion of `manifest.yaml` only after Worker 3 is integrated or after the orchestrator assigns manifest ownership to Worker 4.

Integration rule:

- Merge state model first.
- Then sky renderer.
- Then dynamic grading/weather.
- Then assets.
- Then clock tower.

### Assignment Packet Requirements

Each worker packet must include:

- cwd: `/home/ahirice/Documents/git/claude-ville`
- current `HEAD`
- current `git status --short`
- owned paths
- read-only paths
- owned-path diff or hash snapshot
- direct edits allowed: `yes` or `no`
- expected output
- validation required
- stop conditions

Stop conditions must include:

- owned path changed after assignment baseline;
- unexpected changes appear in unrelated files;
- required PixelLab credentials or MCP tools are unavailable;
- sprite validator reports missing files or unexplained orphan warnings;
- browser smoke shows checkerboard placeholders, unreadable labels, or blank canvas.

## Acceptance Criteria

- At local noon, the world has a blue daytime sky with visible sun and clouds.
- At local night, the sky is cool eerie blue-black with moon and stars, not crimson.
- Sun, moon, stars, and clouds move east to west based on local clock time.
- Weather presets are selectable through debug hooks and are architecturally extensible.
- Reduced-motion freezes decorative animation without freezing time-of-day state.
- Building glows become more prominent at night and subdued during day.
- The clock tower shows approximate local hour/minute time without a noisy second hand.
- No checkerboard placeholders.
- No label/readability regressions.
- No framework, build step, or runtime dependency is introduced.
- No unbounded cache growth from raw alpha/time keys.
- No terrain cache rebuild caused only by time/weather changes.
- Rain/fog work is capped by viewport area and remains bounded.
- Reloading the page at the same forced clock/weather state gives deterministic sky positions.
