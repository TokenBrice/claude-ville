# ClaudeVille aesthetic plan — *The Painted Isle*

**Status:** `shipped as v0.46.0 (maintainer visual sign-off 2026-09-26)`

**As of:** 2026-09-25, `main` at `86597cf` (`v0.45.5` *The Ranger's Bow*), clean tree.

**Author:** Opus 5.5 coordinator. Consolidates 13 parallel read-only Opus 5.5 explorations. At the maintainer's request that evidence is **local-only**: it lives in the gitignored [`../../output/claudeville-opus55-aesthetic/`](../../output/claudeville-opus55-aesthetic/) and is not committed. The note links, shot names and `tools/` scripts cited below resolve only on the machine that produced them; on other clones, read the item text as the specification. Every item names the note that carries its evidence, `file:line` anchors and captures.

## Method

- An isolated server (not the maintained `:4000` one) ran the deterministic simulator. Explorers took real-GPU 1920×1080 captures on `ANGLE Metal Renderer: Apple M5 Pro` with the frontier capture helper (`agents/research/claudeville-frontier-visual/tools/capture.mjs --url …`), looked at every frame, and built before/after mockups without touching source (in-page monkey-patches, PIL post-processing, static HTML mocks rendered with Playwright).
- 13 territories: terrain, water/coast/void, light/grade, weather/ambient life, characters/crowds, buildings/props/foliage, holistic art direction and palette, in-world overlays, DOM chrome/typography, Dashboard, camera/first impression, event moments, and render-pipeline budget.
- All explorers ran concurrently on one host. FPS, ladder levels and per-pass timings in the notes are **loaded-host evidence**, not benchmarks, and this plan cites none of them as a budget. Whole-frame numbers and A/B deltas are indicative only; every item that adds per-frame cost is re-priced on a quiet host before landing (see the verification matrix). The prior round hit the same trap (OF-010: seven parallel capture agents widened the per-pass noise floor to 0.35–1.5 ms).
- The coordinator's baseline captures reported `qualityLevel: 0` / `within-budget` (FULL); LightGrade forced FULL for its measured series. The "time of day is invisible" finding is therefore about the FULL frame, not a ladder artifact.
- The isolated server booted with a fresh temp HOME, so Chronicle, usage and spend stores were empty. Dashboard, Chronicle and ledger surfaces were judged as `?sim=1` populates them (first-run history). Re-check those items against the operator's populated server before implementation.
- The particle finding was confirmed independently: no file under `character-mode/gpu/` ingests particles, so the magenta-probe zero is not a recolouring artifact.

## Relation to prior work

- **Extends** [the frontier visual plan](claudeville-frontier-visual-plan.md) and its ten explorations. Explorers were told to read the matching prior note and the [open-followups ledger](open-followups.md) and to say when an idea had been landed or cut. Kept cut: OF-010 street spill (item 1.2 stays inside the existing pass), the generated distant-shore band (the rejection list keeps it), the two-typeface rule, PixelLab 9-slice UI, and the World→Dashboard morph. The ±2 px feet rule that left six characters without strips (OF-009) is unaffected: 2.1 changes draw scale, not rigs.
- **Relation to the 2026-08-21 critique** (`.impeccable/critique/2026-08-21T11-00-30Z__claudeville-src-presentation.md`, score 27/40). Its two P1s, routine-overlay overload and Dashboard triage order, are Wave 5 and items 7.7/7.9. Its strategic recommendation, a GPU-resident diorama, has since shipped. This plan found that the shipped resident path dropped the atmosphere grade (organizing finding 1), so Wave 1 finishes that migration rather than adding effects on top of it.

## The organizing finding

ClaudeVille does not lack effects. It lacks a **correct base image**. Four foundations are broken, and every layer above them inherits the damage:

1. **The grade never reaches the default renderer.** The resident WebGL2 path skips `_drawAtmosphere` (`WorldFrameRenderer.js:666-674`). Its only grade is a flat RGB multiply picked from six constant per-phase rows (`GpuWorldRenderer.js:273`, `GpuWorldPolicy.js:152-212`). Measured world-region luma at zoom 1: noon 78.8, 17:00 77.6, 12:00 storm 76.2, 22:00 52.5; saturation is 0.60 at noon **and** at 22:00. Weather has zero grade effect; storm fog lifts the blacks. Time of day and weather are effectively invisible. ([light-grade](../../output/claudeville-opus55-aesthetic/light-grade.md), [pipeline-budget](../../output/claudeville-opus55-aesthetic/pipeline-budget.md))
2. **Ground and water tiles are mis-mapped.** Square top-down Wang cells are stretched unrotated into the 64×32 diamond and clipped (`TerrainTileset.js:25-41,62`), so the transition art lands on diamond vertices and is cut away. Result: the checkerboard patchwork, the stair-stepped coastlines, and an "infinity pool on a slab" sea. ([terrain-ground](../../output/claudeville-opus55-aesthetic/terrain-ground.md), [water-coast-void](../../output/claudeville-opus55-aesthetic/water-coast-void.md))
3. **Three pixel densities coexist.** Villagers draw at a non-integer 1.32–1.65× (`AgentSprite.js:36-42,154-156`; 3.3 screen px per texel vs 2.0 for buildings at zoom 2), large trees at 2× (`FoliageRenderer.js:100`), and four buildings (Archive, Forge, Mine, Task board) are resampled painterly images with 10k–27k colours beside clean 1-px iso art with 36–297. Bodies stand 3.7–4.4× the Command door's height. ([characters-crowds](../../output/claudeville-opus55-aesthetic/characters-crowds.md), [buildings-props](../../output/claudeville-opus55-aesthetic/buildings-props.md), [art-direction](../../output/claudeville-opus55-aesthetic/art-direction.md))
4. **The effect layer is invisible while the UI layer shouts.** On resident WebGL, every world-layer `ParticleSystem` particle (smoke, embers, fireflies, motes, ritual sparks, rain splashes) is drawn into the 2D context that the opaque GPU canvas covers (`WorldFrameRenderer.js:621` vs `IsometricRenderer.js:3157-3162`; probe: 0 magenta pixels in WebGL vs 6,857 in Canvas). Meanwhile labels use three typefaces, four chip shapes and off-grid bitmap sizes, and the chrome renders both bitmap faces off their glyph grids (`HARBOR` reads as `HARBUR`). ([weather-life](../../output/claudeville-opus55-aesthetic/weather-life.md), [world-overlays](../../output/claudeville-opus55-aesthetic/world-overlays.md), [chrome-typography](../../output/claudeville-opus55-aesthetic/chrome-typography.md))

The plan therefore repairs the image **bottom-up**: bugs that hide existing work → one light model → one pixel grid → a baked, art-directed ground and sea → coherent architecture → a calm signal layer → crafted moments → the chrome and Dashboard as a quiet instrument → camera. Most items are baked or authoring changes with zero per-frame cost; the few per-frame items are paid for by Wave 0 savings.

## Guardrails (binding on every item)

- **Zero build, zero dependencies, desktop ≥1280 px.** No bundler, framework, TypeScript, runtime package, or responsive work.
- **Truth first.** No visual may imply work, status, success or weather that did not happen. Success gold is only for verified success; sub-agent returns are neutral stone, never gold. Weather never comes from agent state. Action-needed agents (waiting, errored, rate-limited) stay unmissable at every zoom, in focus, Ambient and under crowd pressure.
- **Motion budget.** Every motion-bearing item declares a pulse band and a static reduced-motion frame (`docs/motion-budget.md`). No constant animation in the chrome.
- **Frame budget.** At FULL with 24 agents there is no 120 Hz slack. A new per-frame cost must (a) be baked into the terrain/static caches, (b) replace an existing cost, or (c) carry a C3 `EFFECT_BUDGET` receipt and a ladder tier. Items below state which.
- **Pixel grammar.** Nearest-neighbour, integer multiples of the world texel, art-pixel-snapped `fillRect` stamps, stepped (quantized) gradients with ordered dither. No smooth radial gradients, blur glows, anti-aliased vector strokes, CRT/chromatic aberration, or bloom increases to fake mood.
- **Upper-left baked key light.** No normal maps, no rotating key light.
- **Asset spend is tracked.** The maintainer approved PixelLab spend for 4.5 with no cap ("quality first", D3). Every generation is recorded in the asset provenance ledger with its item id. Any spend outside 4.5 still needs approval first.
- **Do not re-open killed items** listed in [Killed and rejected](#killed-and-rejected) without new evidence.

## Cross-item contracts — specify before Wave 1 starts

### C1 — Master palette and value ladder

One `palettes.yaml` section (or `docs/art-direction.md` + `theme.js` export) holds named ramps with roles: void, deep/shallow water, grass, foliage (sage family), dirt, plaza stone, road stone, timber, slate, cloth, reserved emissive, reserved status, UI chrome, building accents v2. Hex values are proposed in [art-direction](../../output/claudeville-opus55-aesthetic/art-direction.md) (ramps) and [terrain-ground](../../output/claudeville-opus55-aesthetic/terrain-ground.md) (5-hue ground ramp: grass lowest value, paths +1.5 steps, plaza lightest).

**The brightest-thing rule:** Tier A (L > 0.70 or S > 0.65) is reserved for unresolved status marks, the selected-agent ring and authored emissive light at dusk/night. Water and void stay low-saturation (S ≤ 0.40). **Ground sits at a moderate mute (D5):** median saturation 0.45–0.50, so grass stays green and alive instead of grey. Ground local contrast is ≤ 0.6× that of buildings and characters. Measured today: terrain median saturation 0.61 (shallow-deep sheet 0.94) vs buildings 0.38 and characters 0.41, so the ground is the loudest thing on screen. The explorers' strict ≤ 0.40 ground mock (third panel of `terrain-ground-mock-04-compare.jpg`) read close to grey and is **not** the target.

Enforced by an offline analyzer (item 3.1): flags off-ramp ground pixels, > 400 colours per sprite, semi-alpha edges, non-integer draw scales, and Tier-A pixels outside the reserved roles.

### C2 — One grade evaluator

A single pure function `evaluateGrade(minuteOfDay, weather, moonPhase) → { lift, gamma, gain, saturation, shadowTint, highlightTint, exposure, emissiveExempt }` interpolates **8 authored daily keyframes** (pre-dawn, sunrise, morning, noon, golden hour, blue hour, night, deep night) plus a weather row (rain: saturation ×0.65, cool multiply `#b2c4d6`, flattened sun band; storm: ×0.5, `#8e9fb4`, one night course darker). It is evaluated once per frame on the CPU and consumed by: the resident composite (`COMPOSITE_FRAGMENT`, `GpuWorldRenderer.js:462-474,1493-1518`), the Canvas fallback, the sky/void, the water depth LUT, and the fauna sprite tints. Night desaturates (×0.45 with a Purkinje blue shift) while emissive pixels are exempt through the emission-alpha lit mask. Exposure never drops below 0.40. Labels and overlays are never graded. Starting values: [light-grade](../../output/claudeville-opus55-aesthetic/light-grade.md) mockups `light-grade-mock-night-ab.jpg` and `light-grade-mock-golden-ab.jpg`.

### C3 — One pixel grid

Every world sprite draws at an **integer multiple of the world texel** at every crisp zoom tier. Villagers at 1×, trees at 1×, effects and glyphs on the art-pixel grid. Sprite record positions are snapped (`pipeline-budget` found a half-art-pixel offset). The semantic ground texture draws at scale 1 or 0.5 only (today 0.61 stretched 1.64×, `WorldFrameRenderer.js:928`). Camera motion: resting frames integer-k nearest; flight frames fat-pixel (item 8.1; bent by the Waking Isle plan's 4.6, M4, which made glides one continuous dolly). Doors and thresholds of re-authored buildings are ≥ 1.2× the median 1:1 body (~65–70 world px).

### C4 — Effect language

Shape says the family, colour says the outcome, timing says the weight ([event-juice](../../output/claudeville-opus55-aesthetic/event-juice.md)):

| Family | Shape | Colour |
| --- | --- | --- |
| Arrive / depart | column | violet `#5b3fa0 / #a78bfa / #e6dcff` |
| Dispatch / merge | comet | violet; returns stone `#b9ad96` |
| Work | slashes / chips | ember `#7a2e12 / #e8762b / #ffd27a` |
| Verified success | 8-spoke crown | gold `#f2c14e` (verified only) |
| Failure | broken bracket | red `#d94a3a`, outline `#3a1410` |
| Waiting | bell | amber `#ffb347` |
| Peak frame | — | cream `#fff3bf`, one frame only |

Every moment runs anticipation 120–250 ms → one cream action frame 60–100 ms → stepped follow-through 300–700 ms in 4 alpha quanta → optional static residue 2–6 s. Tiers: Minor ≤ 400 ms; Medium ≤ 1.2 s + residue; Major ≤ 2.5 s, one active globally. Reduced motion shows only the residue frame. This is the rendering half of the existing C5 shape grammar (`shared/EventShapes.js`).

### C5 — Type grid and label hierarchy

Both shipped faces are bitmap fonts on fixed grids (measured with fontTools): **Press Start 2P = 8 px/em, Departure Mono = 11 px/em**. Every DOM and canvas text size is an integer multiple: PS2P 8/16/24, DM 11/22/33. No faux bold, no world-scaled text, no third typeface. Label tiers ([world-overlays](../../output/claudeville-opus55-aesthetic/world-overlays.md)):

| Tier | Element | When shown | Style |
| --- | --- | --- | --- |
| T1 | Attention plate + body beacon | While waiting / errored / rate-limited, full strength for the whole state | filled plate, screen-fixed, stacks without overlap; 3+ collapse to one plate with per-body beacons |
| T2 | Selected / hovered plate | Selection or hover | square plate, gold |
| T3 | District plaque with exact count | Always | carved walnut/stone, `FORGE │ 8` |
| T4 | Routine name | z ≥ 1.6, top-N per region, dropped (not offset) on overlap | text-only DM 11, 1 px outline |
| T5 | `+N` crowd tab | Dense groups | tab on plaque/cluster |
| — | Caption | Director moments | bottom-left lower third |

## Ballot — how the items were chosen

Each explorer ranked up to 8 ideas by impact (1–5), effort (S/M/L) and per-frame risk. Items that three or more explorers reached independently were promoted to contracts or Wave 0/1 (the grade: LightGrade, PipelineBudget, ArtDirection, WeatherLife; the particle bug: WeatherLife, EventJuice, PipelineBudget; one pixel grid: CharactersCrowds, ArtDirection, BuildingsProps, CameraMotion; the ground ramp: TerrainGround, ArtDirection). Ideas that add per-frame cost without a paying substitution were demoted to optional. Explorer rejections and prior kills are consolidated at the end.

## If only ten things ship

| # | Item | Why |
| --- | --- | --- |
| 1 | 1.1 Keyframed grade + weather in the resident composite | Time of day and weather become visible at all; ~0.1–0.2 ms |
| 2 | 0.1 World particles visible on the GPU path | Unhides smoke, embers, fireflies, rituals already being paid for |
| 3 | 2.1 Villagers at integer 1:1 | Village feels bigger; one pixel density; doors make sense |
| 4 | 3.2 Splat-map ground bake + ground ramp + AO | Kills the checkerboard; zero per-frame |
| 5 | 3.4 Continuous coast field + open sea | Kills the staircases and the infinity-pool slab; zero per-frame |
| 6 | 0.4 Type grid snap (8/11 rule) | Removes every broken glyph in the chrome; S |
| 7 | 2.2 Trees at 1×, biome species, sage willows | Removes the second density and the lime monoculture; S |
| 8 | 5.1 + 5.2 One attention plate, text-only names | Calm village that never hides action-needed agents |
| 9 | 1.2 Multiplicative stepped light pools | Night becomes blue with warm pools instead of flat discs |
| 10 | 8.3 Survey tier + real establishing shot | The whole island as a crisp diorama — the best view nobody sees |

---

## Wave 0 — Unhide and pay (bugs and budget; S/M; no taste debate)

### 0.1 World particles visible on the resident path

- **Problem:** `WorldFrameRenderer.js:621-622` draws `particleSystem.draw` and `harborTraffic.drawFinaleEffects` into the pre-composite 2D context, which the opaque GPU canvas covers. Everything particle-based is invisible in the default mode.
- **Change:** when the GPU world rendered, draw world-layer particles on `overlayCtx` next to `WorldFrameRenderer.js:720` (a minimal replay; GPU records are the long-term home). The overlay already has `camera.applyTransform` (`:686`). Round particle x/y/size to integer art pixels in `ParticleSystem.js:646-657`. **Caveat:** the overlay is neither depth-sorted nor graded, so overlay particles would draw over building fronts and bodies and ignore night. The interim replay therefore admits only presets that sit above roofs or in open air (chimney smoke, sparks above anvils, fireflies, gull-height motes) and tints them with the C2 exposure once 1.1 lands. Ground-level presets (footstep motes, rain splashes, ritual chips at hand height) wait for GPU sprite records in the sorted stream.
- **Cost:** 0 GPU; the Canvas draw is already paid (≤ 240 `fillRect`, ~0.1 ms). **Evidence:** `weather-life-09.png`, `weather-life-08.jpg`. **Effort:** S.
- **Acceptance:** with the magenta probe (`tools/weather-life-probe.mjs`) on resident WebGL, every admitted open-air preset draws a non-zero area, and no deferred ground-level preset appears. `?renderer=canvas` output does not change.

### 0.2 Semantic ground: integer scale and no per-frame re-upload

- **Problem:** the semantic ground texture re-uploads 2,564,096 B on 346 of 346 frames (115/s) and is drawn at 0.61 scale stretched 1.64× with NEAREST (`WorldFrameRenderer.js:911-972,928`), so every ring and trail is a mixel.
- **Change:** render at scale 1 or 0.5; drop sprite x/y from the cache key; move per-agent cues to GPU stamp records.
- **Cost:** negative — saves ~2.5 MB upload per frame; this is the budget that pays for 1.1–1.4. **Effort:** M. ([pipeline-budget](../../output/claudeville-opus55-aesthetic/pipeline-budget.md))

### 0.3 Terrain cache keyed on map and season only

- **Problem:** the 3280×2000 terrain cache (26.2 MB) rebuilds at every phase change and zoom step (12–16 ms CPU + 2.6 ms upload) because its key includes phase and zoom tier. Waves 3 bakes will make each rebuild more expensive.
- **Change:** split phase-dependent tint out of the bake (C2 grades it at composite); key the cache on map/season/scenery revision. Phase-keyed water LUT (3.4) becomes a separate small table.
- **Cost:** negative. **Effort:** S/M.

### 0.4 Type grid snap (the 8/11 rule) and no faux bold

- **Problem:** chrome text renders PS2P and Departure Mono at 10/12/13/14 px with smoothing off; glyphs drop rows and columns (`HARBUR`, `1NPU|-WA||`, `|UDAY`). `font-weight: 700` smears single-weight faces (`sidebar.css:466`, activity-panel token values).
- **Change:** tokens `--fs-label 8px` (PS2P), `--fs-display 16px` (PS2P), `--fs-body 11px` (DM), `--fs-numeral 22px` (DM) with integer line-heights in `reset.css:73-81`; fix ~30 raw sizes in `topbar.css`, `sidebar.css`, `activity-panel.css`, `layout.css:132`, `modal.css`, `dashboard.css`; delete every `font-weight: 700` on either face; restate DESIGN.md's Whole-Pixel Rule (`DESIGN.md:177-193`). Canvas `ctx.font` sites follow C5 in item 5.4.
- **Evidence:** `chrome-typography-06-sidebar.png`, `chrome-typography-mock-03-grid-zoom.png`. **Effort:** S–M. **Perf:** none.

### 0.5 Boot and mode return without lies or black

- **Problem:** static `index.html:147-149` says `NO ACTIVE AGENTS` while syncing; the canvas is black 0.3–0.8 s, then the village pops; World→Dashboard→World flashes black (`camera-motion-06.jpg`).
- **Change:** copy `OPENING THE VILLAGE`; top-bar counts show `–` until the first snapshot; world container gets a C2-sky CSS background; canvas at opacity 0 until a `world:first-frame` event, then a 360 ms CSS fade (220 ms on return); capture the camera pose on switch to Dashboard and restore it instead of `frameContent` from the switch-induced resize (`App.js:63-66,1635,1650-1657`, `ModeManager.js:26-48`, `Camera.js:624-647`).
- **Effort:** S. **Perf:** compositor-only. ([camera-motion](../../output/claudeville-opus55-aesthetic/camera-motion.md))

### 0.6 Chrome collisions and small truth-adjacent colour defects

- Toasts move off the first-run hint to the bottom-left of the world, 11 px DM `--ink-1` with a 3 px status rail (`layout.css:113-163`).
- Sidebar names stop taking the repo accent (`Sidebar.js:1065`); repo identity stays on the 3 px rail. Coloured names read as status.
- Zero counts dimmed to `--ink-4` in the top bar and Dashboard chips; `ALL QUIET` when there are no exceptions.
- **Effort:** S.

---

## Wave 1 — One light (GPU; every item carries a C3 receipt)

### 1.1 Keyframed time-of-day and weather grade in the resident composite

- Implement C2 in `COMPOSITE_FRAGMENT` (lift/gamma/gain, saturation, luminance-keyed split tone, highlight protection) replacing the six constant rows (`GpuWorldPolicy.js:149-212`, selection at `GpuWorldRenderer.js:526-541`). Optionally a 32³ LUT rebuilt once per minute. Delete the invisible hybrid three-band refinement (`PostFx.js:139-146`, ~1/255 contribution) or route it through the evaluator. Stop ground fog lifting storm blacks (`GpuWorldRenderer.js:392-394`). Blue-hour sequencing: ambient falls first, lamps take over second, keyed to the same minute (`AtmosphereState.js:1125-1136`). Overcast flattens the sun band and calms water shimmer when `cloudCover > 0.7`.
- **Cost:** ~20 ALU in an existing pass, 0 bytes, all ladder tiers. **Impact 5 · Effort M.**
- **Acceptance:** the light-grade series (hours 5, 7, 12, 17, 18.5, 20, 22, 2 × clear/rain/storm, fixed camera) shows monotone, art-directed luma/saturation/hue changes; 12:00 rain and storm are distinct from clear; night saturation ≤ 0.6× noon; p95 luma of lit emitters holds.

### 1.2 Multiplicative stepped light pools

- Local lights multiply albedo in 3 stepped courses instead of adding flat discs (`GpuWorldRenderer.js:327,340-398,353`), and write a lit mask in the emission alpha that exempts pools from the night desaturation. Light positions are the real emitters (`IsometricRenderer.js:10595-10621`, `LightSourceRegistry.js`).
- **Cost:** low. **Impact 5 · Effort M.** Mock: `light-grade-mock-night-ab.jpg` (median luma 57 → 39, p95 held at 116).
- **Note:** this is not the cut OF-010 street spill field; it reuses the existing light list in the existing pass.

### 1.3 Sky and void graded with the island

- The Canvas sky/void sits under the GPU canvas and ignores the GPU grade. Upload it as a background texture only when it changes (interim: CSS filter on `#worldCanvas` driven by C2). Void becomes a luma-graded `#0b1218 → #16222b` ramp tinted by phase; add a horizon haze band at the island base (`AtmosphereState.js:154-191`, `SkyRenderer.js:64-71`).
- **Cost:** low (upload on change). **Impact 4 · Effort M.**

### 1.4 World-locked cloud shadows

- A baked 256² dithered noise tile, 3 quantized levels, sampled in world space in the composite and scaled by `cloudCover`; off under overcast (rain is already flat). Replaces the three-ellipse loop (`WorldFrameRenderer.js:1453-1510`; insertion `GpuWorldRenderer.js:146,279-283,543`). Reduced motion: frozen offset.
- **Cost:** one texture fetch. **Impact 4 · Effort S–M.** Mock: `weather-life-mock-02.jpg`.

### 1.5 Golden-hour raking shadows (after 1.1)

- Longer, violet-tinted contact and tower shadows plus tree casts, rebuilt per sun-angle bucket into the static layer (`GpuSceneBuilder.js:377-450`, `BuildingSprite.js:940-960`, `AgentSprite.js:3676-3700`). No normals.
- **Cost:** low (bucketed rebuild). **Impact 4 · Effort S/M.**

### 1.6 Screen-Y aerial perspective (optional)

- `haze = pow(clamp((0.55 − yTop)/0.55, 0, 1), 1.4) × strength(zoom)` (0.18 survey, 0.14 z1, 0.08 z2, 0.04 z3) × (1 + fog), toward the C2 horizon colour with 0.8× desaturation. Replaces tilt-shift as the diorama depth cue. World layer only.
- **Impact 2 · Effort S.** Mock: `camera-motion-mock-08.jpg`.

---

## Wave 2 — One pixel grid (C3)

### 2.1 Villagers at integer 1:1

- Remove `AGENT_WORLD_SCALE` 1.32 / the 121 px content-height target; `_spriteDrawScale → 1` (`AgentSprite.js:36-42,154-156,4153-4157,2832-2833`); fix fixed offsets that assumed the old scale (`:3658, :3669, :4208, :6573-6575, :6799`). Bodies go from 82–120 to 48–75 world px; body : Observatory door 1.3–2.0×.
- **Cost:** low (less fill). **Impact 5 · Effort S–M.** Mocks: `characters-crowds-mock-01/02/03.jpg` (in-engine).
- **Knock-ons:** labels (Wave 5) and default zoom (8.3) retune; Command door is too small at ~22 px (4.2).
- **Approved (D1).**

### 2.2 Trees at 1×, species by biome, sage willows

- Draw large trees at 1× (`FoliageRenderer.js:100-111`). Delete `villagePalm` drawn as willow (`SceneryEngine.js:744-747`); willow only where `distanceToWater ≤ 1`; remap civic-ring `TROPICAL_PALMS` (`scenery.js:303,311-315`) to oak; clump trees into clusters. Offline HSV re-tone of willow PNGs (−25 % value, −25 % saturation, hue +0.05) onto the C1 sage family.
- **Cost:** fewer draws. **Impact 5 · Effort S–M.** Mock: `buildings-props-mock-02.jpg`.

### 2.3 Grounding: one contact shadow, fewer rings, no halo

- One cached pixel contact-shadow ellipse per body; status rings only for error/waiting/rate-limited; drop the repo ring, trim arc and WORKING ring from `_drawGrounding` (`AgentSprite.js:3661-3791,2869-2874`). Delete the 8-offset alpha-0.54 black halo (`AgentSprite.js:4066-4112,3036`).
- **Impact 4 · Effort S.**

### 2.4 Outline parity baked into the body atlas

- Canvas draws a 2 px outline (`AgentSprite.js:3036`), GPU none. Unify both on one baked 1-texel dark (warm) rim in the atlas; optional night rim light via the C2 emissive exemption.
- **Cost:** 0 ms per frame. **Impact 3 · Effort S–M.**

### 2.5 Crisp selection

- Pixel ring asset on the GPU path plus a chevron; no full-body amber pillar; labels never cross the body (`AgentSprite.js:3092-3094,3793-3812,4184-4220`; `AgentGpuOverlayRenderer.js:55-59,94-98`).
- **Impact 3 · Effort S.**

### 2.6 Provider colour in trim only

- Stop the whole-robe Claude swap to `#8f4f21` (brown on dirt); provider hue lives in trim (`Compositor.js:197-241`, `palettes.yaml`).
- **Impact 4 · Effort S.**

### 2.7 Baked 0.5× crowd LOD sheet

- Majority-downsample + palette-snap at compose time, replacing 0.37–0.58 nearest minification (`Compositor.js:59-101`, `AgentSprite.js:2827-2858`).
- **Impact 3 · Effort M.**

---

## Wave 3 — A baked, art-directed ground and sea (zero per-frame)

### 3.1 Master palette and the offline analyzer (C1)

- Land C1 ramps; add a `scripts/` sprite/terrain analyzer (colour count, off-ramp pixels, semi-alpha, Tier-A misuse, non-integer scale) as an advisory check alongside `sprites:audit-refresh`.
- **Effort S.** Prerequisite for 3.2, 3.4, 4.3, 4.5.

### 3.2 Splat-map ground bake

- Replace per-tile land stamping with a class buffer (grass/dirt/road/plaza/sand) → organic boundaries (dithered 2×1 edge noise) → C1 ground ramp → macro variation fields (6–7-tile value/warmth drift, district-anchored, replacing per-tile tint diamonds `IsometricRenderer.js:9888-9899`) → baked contact AO around building, tree and prop footprints (ramp-quantized) → authored worn-to-the-door thresholds → clustered decals at native 2×1 texel density.
- Fix the root defects even if the bake slips: grass never takes the dirt mask (`IsometricRenderer.js:10040-10058`); offline re-tone the grass-cobble sheet grass to match grass-dirt (lum 143 → 95); drop per-tile forest-floor alternation (`:9891-9892`). An interim affine orientation fix in `TerrainTileset.drawTile` (`terrain-ground-mock-04-compare.jpg`, middle panel) may ship first if its A/B shows no mixels; the splat bake supersedes it.
- **Cost:** zero per frame; one bake. **Impact 5 · Effort M.** Mocks: `terrain-ground-mock-01..04`.

### 3.3 Smaller yards, no road confetti

- 41 % of land is yard because building footprint + ring is marked path (`IsometricRenderer.js:938-946`); shrink rings to authored frontage. Delete the `(x+y)%5` stripe in `_classifyRoadMaterials` (`:1296`). Verify pathfinding use of `pathTiles`.
- **Impact 4 · Effort S/M.**

### 3.4 Continuous coast field and open sea

- At bake time classify water pixels from a smoothed 8-samples-per-tile field plus a chamfer distance-to-shore: dry sand → wet sand → dithered foam lace → 5 quantized depth stops (2×2 lattice, Bayer dither) keyed by phase via a small LUT (night shallow water below lit ground, L* ≤ 35; storm grey-green). Remove `_drawRiverContourLines` (`IsometricRenderer.js:6035,9496-9513`) and per-tile depth washes. Paint the GPU water material sidecar from the same mask (`GpuSceneBuilder.js:169-216`). Walkability untouched.
- Out-of-bounds counts as water for sea/openSea/harbor in the shore BFS (`SceneryEngine.js:359`), removing the teal rim; sand lip and cliff only under land edge tiles (`IsometricRenderer.js:9242-9253`).
- Cache the outer ocean at quarter resolution as dithered bands, deepest at the island, lighter only toward the horizon; rebake per phase/weather bucket; stop the swell animation (`IsometricRenderer.js:9329-9437`, `WorldFrameRenderer.js:509`).
- **Cost:** zero per frame (reduces it); bake 20–60 ms once [inference]. **Impact 5 · Effort M/L.** Mock: `water-coast-void-mock-01.jpg`.

### 3.5 Stratified land cliff with surf lace (after 3.4)

- 2:1 stepped top edge, 3 strata colours, dithered foam at the waterline; land segments only. **Impact 3 · Effort M.**

### 3.6 Waterfalls earn a source or go

- The three falls (`config/scenery.js:395-398`) hang mid-lagoon on a tan cone; anchor under ledge props or cut. **Impact 3 · Effort S.**

### 3.7 Baked landmark reflections (optional)

- Flipped unlit silhouettes of the Lighthouse, Harbor and Observatory clipped to nearby water, 3 alpha steps, static 2 px row jitter; lit windows stay with the existing occupancy-gated reflections. **Impact 3 · Effort M.**

---

## Wave 4 — Coherent architecture and dressing

### 4.1 Props: fewer, grouped, purposeful

- Cut ~24 lone steles/crates/pillars to ~8 grouped by purpose (7 runestones, 3 notice pillars, 3 scroll-crates, 1 duplicate standing stone in `scenery.js`, lines listed in the note); remove baked plinths; recolour the runestone glyph so cyan means Mine ore only. **Impact 4 · Effort S.** Mock: `buildings-props-mock-01.jpg`.

### 4.2 Command as the hero

- Strip Command's baked cobble plinth, enlarge the keep ~15 %, author a door ≥ 1.2× the 1:1 body, lay a warm limestone plaza in the ground bake with radiating 2-wide roads. Today Archive has 1.8× Command's opaque pixels. **Impact 4 · Effort M.**

### 4.3 House accent palette v2

- Repaint BUILDING/PROVIDER/TEAM accents in `theme.js:94-145,168-171` from Tailwind-like neons onto C1; split Archive/Portal (both `#c084fc`); only status stays Tier-A. **Impact 4 · Effort S.**

### 4.4 Fallback only: quantize the painterly buildings

- Superseded by D3: 4.5 re-authors all four now. Keep this as the fallback for a building whose re-authoring fails review. It is a ramp-snapped ≤ 96-colour quantization of `building.{archive,forge,mine,taskboard}/base.png`, with no generations. The ship fix (threshold alpha plus a 1-px outline, `manifest.yaml:1505-1545`) ships regardless. **Impact 3 · Effort S–M.**

### 4.5 Re-author Archive, Task board, Mine, Forge on the Observatory grid

- Style anchor: `building.observatory`, then Command. Order by weakness: Archive (frontal, 27k colours, oversized icon-book) → Task board (frontal billboard) → Mine (resampled, uniform cyan crystals) → Forge (resampled but well massed). Doors per C3. Keep existing aperture/instrument anchors in `BuildingVisualRegistry.js` valid.
- **Cost:** PixelLab generations with no cap (D3: quality first), each recorded in the provenance ledger. Pilot order still runs Archive first, so the style anchor is proven before the other three. **Impact 5 · Effort L. Approved (D3).**

### 4.6 Emissive window sidecars for Command and Observatory

- The hero is dark at night. Authored emission sidecars, gated by `NightOccupancyGate`. **Impact 3 · Effort S.**

### 4.7 District identity through yard materials

- Authored yard materials, fences and frontage spurs in the ground bake replace weak alpha washes. **Impact 4 · Effort M.** (After 3.2.)

---

## Wave 5 — A calm signal layer (C5)

### 5.1 One attention plate

- Alpha from live status (not `1 − progress`), screen-fixed size, stacked on collision, groups of 3+ collapse to one plate with per-body beacons; remove the night re-draw (`VillageDirectorOverlay.js:115-135,539-547,561-574`; `VillageDirector.js:91-95`; `MarkGovernor.js:326-333`; `WorldFrameRenderer.js:709-727`). Copy `Bell waiting` → `Needs you`; rate limit shows its age. Today nine `BELL WAITING` pills overlap in many-waiting and `RATE LIMITED` is dimmer than a name chip.
- **Impact 5 · Effort M.**

### 5.2 Text-only names, top-N

- Names become text-only DM 11 with a 1 px outline; routine names only for the top-N per region at z ≥ 1.6; drop instead of offset on overlap; selected/hovered get the T2 plate (`AgentSprite.js:5770-5932`; `IsometricRenderer.js:5287-5357,5410-5425,5686-5688`). Remove the three glyph specks from compact pills.
- **Perf:** net saving. **Impact 5 · Effort M. Approved (D2):** replaces the rule "identity never disappears at overview LOD" (`AgentSprite.js:5775`); update that comment and `character-mode/README.md` when it lands.

### 5.3 Carved plaques with the count folded in

- Square walnut plaques with an exact count cell (`FORGE │ 8`); delete `BuildingSprite.drawBubbles` and its sans-serif `N agents` bubble (`BuildingSprite.js:1179-1246,1428-1510,1587-1642`; `WorldFrameRenderer.js:748-750`). **Impact 4 · Effort S–M.**

### 5.4 Canvas type-scale contract

- Every canvas `ctx.font` site follows C5 (PS2P 8/16, DM 11/22, no bold; `config/theme.js:56` plus sites listed in the note). Remove 5/6/7 px PS2P and 6/9/10 px DM. **Impact 4 · Effort M.**

### 5.5 Captions as lower thirds

- Director captions move to a bottom-left lower third; parade and building-signal pills fold into the caption and plaque hover (`WorldFrameRenderer.js:1071-1107,755-768`). Retire `PARADE … FIRST SESSION COMPLETED` wording for sub-agent removal. **Impact 3 · Effort S.**

### 5.6 Glyphs from the authored motifs; chits on demand

- Tool/status glyphs drawn from the `EventShapes` 8×8 motifs, not AA vector strokes (`ToolGlyphBadge.js:54-130`). Building-face chits (`VISITIN…`, `MSG`) and 6 px ground ledgers only on selection/hover or z ≥ 3. **Impact 3 · Effort S–M.**

---

## Wave 6 — Moments (C4)

### 6.1 `EffectStamps.js` — the pixel effect kit

- Snapped `fillRect` stamps: column, ringDots, comet, crown, bracket, diamond. Port wisps, completion cue, departure sigil and fireworks off `arc`/`roundRect`/`1/zoom` vector drawing. **Impact 4 · Effort M.** Prerequisite for 6.2–6.5.

### 6.2 Arrival: gate walk-in and a materialize beat

- Remove the screen-space violet carriage/boat glyph (`ArrivalDeparture.js:157-182,584-634`) so the existing gate walk-in (`IsometricRenderer.js:3385-3432`) is no longer overridden (`:3313-3318`); violet column + rune ring, one cream silhouette frame, dust chips, 2 s rune residue; name hidden while the arrival is pending. **Impact 5 · Effort M.** Storyboard: `event-juice-mock-01-arrival-storyboard.jpg`.

### 6.3 Dispatch/merge comet

- 150 ms parent gather → 500 ms comet with the child miniature as its head → 80 ms cream impact → 400 ms splash; returns in stone. **Impact 4 · Effort S/M.**

### 6.4 Release crown at the Harbor

- Replace three AA rings at far tile 38.2,6.6 (`ChronicleMonuments.js:63-71,839-872`) with one stepped 8-spoke gold crown above the Harbor plaque: rocket anticipation, cream flash, 4-step falloff, 6 s static residue; max one; Harbor gulls suppressed. **Impact 4 · Effort S.**

### 6.5 Failed push: a red broken bracket at the slip

- Static bracket for a verified failed push, preceded by a one-frame flash and a stamp-only shake; success grammar deferred while active. Today a failed push shows nothing at the Harbor. **Impact 3 · Effort S/M.**

### 6.6 Work downbeats

- Rituals become Minor-tier beats emitting on the first beat and every third after (`RitualConductor.js:40-52`), roughly halving emission. **Impact 3 · Effort M.** (After 0.1.)

### 6.7 Ambient life budget

- Gull pool 129 → 43; active 4–10 (56 measured); zoom caps 8/5/3; storm: roost; night: lighthouse gull only; no off-map flights; re-author gulls at 16 px. Fauna tinted by C2 via cached sprites (`WildlifeRenderer.js:565-577`). Pixel-true rain on the art grid with ground-anchored splashes (`WeatherRenderer.js:519-776`). Chimney smoke from real chimney anchors (`IsometricRenderer.js:1455-1458`). Fireflies ≤ 12 at z ≥ 3 near water in warm months at dusk/night; pink spring petals; delete screen-locked reduced-motion dots (`SeasonalAmbience.js:198-235`, `WorldFrameRenderer.js:798`).
- **Perf:** net negative. **Impact 4 · Effort S/M.** ([weather-life](../../output/claudeville-opus55-aesthetic/weather-life.md) budget table.)

---

## Wave 7 — Chrome and Dashboard as a quiet instrument (DOM only; parallel with Waves 1–6)

### 7.1 Parchment ink ramp; gold is light again

- `--ink-1 #eee3cb`, `--ink-2 #bfae8f`, `--ink-3 #8c7c64`, `--ink-4 #5f5344`; gold `#f2c75c / #ffe08a` only for wordmark, selected row, active tab, focus (`reset.css:24-44`, `DESIGN.md:141-157`). **Impact 5 · Effort M.**

### 7.2 One surface and line system

- Collapse 96 hex + 318 `rgba()` literals to `--bg-0..3` (`#0b0908 #15100d #1d1612 #2a2019`), `--line-1 #3a2c20`, `--line-2 #5a4330`, brass `#b8893f`; 1 px bevel + 1 px black seam; drop radial highlights and 18 px texture stripes. Keep the warm frame around the cool world (DESIGN.md two-mood intent). **Impact 4 · Effort M.**

### 7.3 Top bar with one loud slot

- KPI stacks (22 px DM numeral over 8 px PS2P caption), zeros dimmed; `NEEDS YOU` is the only framed, lit slot, shown only when > 0; tokens-today as a separate KPI; ghost 28 px icon buttons; two segmented wells (`READ | AMBIENT`, `WORLD | DASHBOARD`); height 54 → 48; delete the rail shimmer. Must fit 1280 px. **Impact 4 · Effort M.** Mock: `chrome-typography-mock-01/04`.

### 7.4 Activity panel as a character sheet

- 64 px integer-scaled portrait with a double frame, 16 px PS2P name, status line, provenance line; delete the redundant status chip; hide empty meta rows; Cost & Tokens lead with 22 px numerals; `SCORE / LIVE / PLAY` as one well. Keep `estimate`/`inferred` labels verbatim. **Impact 4 · Effort M.** Mock: `chrome-typography-mock-05-frame.png`.

### 7.5 Sidebar rows on a 16 px rhythm

- `dot | name/sub | age` grid, 44 px rows; provider letter and `T` team chip leave the row (team → group swatch, still in `title`); selected row `--bg-3` + gold rail + gold name; group headers become 8 px eyebrows without the filled band. **Impact 4 · Effort S–M.**

### 7.6 Modal family on the same system

- Settings, Chronicle, changelog adopt 7.1–7.2 and C5; slider readouts `nowrap` + tabular; one-line Chronicle date. **Impact 3 · Effort S–M.**

### 7.7 Dashboard: collapse empty columns, one header row, a NOW column

- In dense-24, 72 of 96 value cells are `—`. One column-header row per project; hide WORKING SET / CHILDREN when all visible agents are empty; merge BLOCKER and lastMessage into `NOW` (`Waiting · last: <lastMessage>`). **Impact 5 · Effort S/M.** ([dashboard-mode](../../output/claudeville-opus55-aesthetic/dashboard-mode.md))

### 7.8 Every row gets a face

- Move the card `AvatarCanvas` portrait into a 44×40 row niche (static — no walking avatars); selected detail uses a 96 px hero portrait. **Impact 5 · Effort S.**

### 7.9 Bell lane

- Needs-you, error and quota agents become portrait call-cards with blocker, redacted prompt quote, large elapsed time, provenance and a quota context gauge; project header shows `+N in Needs You`; no duplicates in project lists. `failed-push` shows its `Push rejected` fact on the card without promoting status. **Impact 5 · Effort M.**

### 7.10 Re-ration hue

- FNV-1a + fmix32 repo hash (sibling repos `dense-1..4` currently hash to 91.7°–94.7°, all lime = working green; `RepoColor.js:34,69-76`); a status-free 8-colour pennant palette from C1; tool colours stop reusing status hues (`reset.css:49-64`); remove the district radial wash (`dashboard.css:430-440`). RepoColor is shared with Harbor ships and Sidebar — change once. **Impact 4 · Effort S/M.**

### 7.11 Flatten rows

- One section panel with hairlines, 5 px status spine, idle at 62 %; drop per-row `UNAVAILABLE`/`ESTIMATE` pills for `≈` + legend; static selected rim instead of the infinite halo. **Impact 4 · Effort S.**

### 7.12 Observed-call tape and child strip (optional)

- `LAST 10 MIN` browser-local ring of 40 × 15 s buckets per row, height encodes call class, hatched before page open; child strip under the parent row with `0/1 done INFERRED`. **Impact 3 · Effort M.**

---

## Wave 8 — Camera and first impression

### 8.1 One motion vocabulary

- `CameraCurves` helper: wheel 150 ms easeOutCubic; Director/return easeInOutCubic; tour/Ambient easeInOutSine; duration `clamp(600 + 0.55·screenPx + 350·|log2 z1/z0|, 700, 2400)` ms; log-space zoom; interpolate the world centre; pan at an integer tier, then a 450 ms zoom step (C3) (`Camera.js:353-464,666-694,946-949,1233-1282`). **Impact 3 · Effort S–M.**

### 8.2 Follow-cam composition window

- 28 % × 22 % box, 6 % above centre; critically damped spring ω = 3.5/s back to the box edge; idle relax ω = 1.2/s; snap when follow starts before first paint (removes the 7,483 px/s whip in release-parade). **Impact 3 · Effort S.**

### 8.3 Survey tier and a real establishing shot

- `surveyZoom = 1/backingDpr` only when DPR ≥ 2 (1 backing px per texel): the whole island as a crisp 1:1 diorama (`camera-motion-mock-07.png`). Opening: fade from the C2 sky at survey tier, hold 1600 ms, then a 1400 ms easeInOutCubic log-zoom dolly to the content box. Reuse for the Ambient wide, the empty-village tour and `F` on large boxes. At DPR 1 hold at tier 1 and pan only. Replace `maxZoom 1.5` with an explicit tier (`Camera.js:57-75,226-270,470-482,604`; `IsometricRenderer.js:2693-2725`; `App.js:1426-1437`). PostFx may drop to MINIMAL while zoomed out; price in dense-100.
- **Impact 5 · Effort M.** Retune default zoom after 2.1 (CharactersCrowds suggests 2.5 or integer 3).

---

## Killed and rejected

Consolidated explorer rejections plus prior kills that still hold:

- **More spectacle to fake mood:** bloom/grain/CRT/chromatic aberration increases, god rays or volumetric beams on the resident path, brighter lightning, more rain streaks, pitch-black nights.
- **Per-frame full-screen passes:** quantizer/dither/posterize to hide the style split, a second grade pass or render target, per-pixel animated wave shaders, per-frame GPU ground blending, per-frame outline/rim shaders.
- **Smooth gradients and blur** anywhere in the world (breaks pixel grammar).
- **Non-integer compromise scales** (1.25×, 1.5×) for villagers; chibi or larger bodies; upscaling clean buildings to match the painterly ones.
- **Regenerating Wang sheets or iso water tilesets** as the terrain fix (the mapping is the problem, not the art); rotating square Wang art 45° (aliasing).
- **Distant shore, skyline, bigger island** (maintainer cut in the Fable 5.1 plan); cloud sea / floating-island framing; simulated tides.
- **Weather, sky tint or birds driven by agent state**; umbrellas or rain outfits.
- **A third typeface**, PixelLab 9-slice parchment UI skins, fluid `clamp()` or DPR-dependent type, animated label entry/exit, drop shadows or glows on labels, world-scaled labels, a permanent name minimap.
- **Hiding action-needed marks** under pressure, focus or Ambient.
- **Dashboard:** animated walking avatars per row, KPI tile grids, World→Dashboard morph (killed in the frontier plan), promoting `Push rejected` to an error status.
- **Tinting the chrome cool** to match the world — harmonize value, not hue.
- **Passive roof fades/cutaways** (previously rejected; the selected-only aperture exists).
- **OF-010 street spill field** stays parked; item 1.2 improves pools inside the existing pass instead.

## Maintainer decisions (settled 2026-09-25)

| ID | Decision | Answer |
| --- | --- | --- |
| D1 | Villagers at integer 1:1 (bodies shrink from 82–120 to 48–75 world px) | **Approved.** 2.1 ships; labels, crowd layout, hit-testing and default zoom are retuned in the same wave |
| D2 | Routine names hidden below z 1.6 (top-N only); replaces "identity never disappears at overview LOD" | **Approved**, with the T1/T2 guarantees |
| D3 | Re-author Archive, Task board, Mine, Forge | **Re-author now with PixelLab, no spend cap.** 4.4 becomes the fallback only |
| D4 | Survey tier (zoom below 1 CSS px on DPR ≥ 2) as the establishing and Ambient wide shot | **Approved after a dense-100 cost check** on a quiet host |
| D5 | Splat bake replaces the tile Wang look; ground mute level | **Splat bake, moderate mute** (ground median saturation 0.45–0.50; see C1) |
| — | Particle route for 0.1 | **Interim overlay now**, GPU records later |
| — | Adversarial council review | **Waived by the maintainer**; the decisions above settle the open items |

## Sequencing, ownership and parallelism

```
Wave 0 ──► Wave 1 (C2) ──► Wave 3 (C1 bakes; water LUT uses C2) ──► Wave 4
   │            └──────────► Wave 6.7 fauna tint
   ├──► Wave 2 (C3) ──► Wave 5 (label retune after 1:1) ──► Wave 8.3 default zoom
   └──► Wave 7 (DOM; independent after 0.4/0.6)
Wave 6.1 ──► 6.2–6.6 (after 0.1)
```

- Disjoint owners that can run in parallel: **GPU composite** (1.1–1.4, 1.6: `gpu/`, `postfx/`, `AtmosphereState.js`), **terrain/water bake** (0.3, 3.2–3.7: `TerrainTileset.js`, `SceneryEngine.js`, terrain sections of `IsometricRenderer.js`), **bodies** (2.1–2.7: `AgentSprite.js`, `Compositor.js`, `AgentGpuOverlayRenderer.js`), **overlays** (5.x: `VillageDirectorOverlay.js`, `MarkGovernor.js`, `BuildingSprite.js` label sections, `ToolGlyphBadge.js`), **effects** (6.x: new `EffectStamps.js`, `ArrivalDeparture.js`, `ChronicleMonuments.js`, `RitualConductor.js`, `WildlifeRenderer.js`, `WeatherRenderer.js`), **DOM** (0.4, 0.6, 7.x: `css/`, `index.html`, `Sidebar.js`, `TopBar.js`, `ActivityPanel.js`, `dashboard-mode/`), **camera** (0.5, 8.x: `Camera.js`, `CameraDirector.js`, `App.js`, `ModeManager.js`).
- `IsometricRenderer.js` and `WorldFrameRenderer.js` are shared hotspots: one integration owner per wave.
- `RepoColor.js` (7.10) is shared by Sidebar, Dashboard and Harbor ships — one change, all consumers verified.

## Verification matrix

| Change | Evidence required |
| --- | --- |
| Any `src/` change | `npm run verify:render` exit 0 plus visual judgment on the maintained server |
| Grade (1.x) | Fixed-camera light series (tools/ in the research dir) with luma/saturation/hue table; reduced-motion frame |
| Particles (0.1) | Magenta probe parity webgl vs canvas |
| Budget items (0.2, 0.3, 1.x, 6.x) | Shift-D C3 receipt on a quiet host, `dense-24-agents` and `dense-100-agents`, FULL forced; `npm run world:benchmark-trails` where trails/camera invalidation change |
| Scale / grid (2.x, 8.3) | Pixel-block measurement at z 2/3 (one texel = integer screen px for bodies, trees, buildings) |
| Terrain / water bake (3.x) | `npm run world:validate-terrain`; bake time; before/after at z 1/2/3 day/night/storm |
| Buildings / assets (4.x) | `npm run world:validate-buildings`; `npm run sprites:audit-refresh`; `sprites:capture-fresh` + `sprites:visual-diff`; analyzer (3.1) clean |
| DOM (0.4, 0.6, 7.x) | Screenshots at 1280 and 2560, DPR 1 and 2; no off-grid font sizes (computed-style audit script) |
| Structure / docs | `npm run verify:architecture`; `npm run check:artifacts` |
| Release | `npm run gate:release` |

## Definition of done

- Every item is implemented or explicitly killed with evidence in the execution record.
- The ten-item headline is visible in a before/after contact sheet at the same cameras: wide day, wide night, wide storm, z 2 dense-24, z 3 detail, many-waiting, Dashboard, chrome close-up.
- No frame-budget regression beyond receipts: `dense-24-agents` FULL on a quiet host holds the pre-plan whole-frame p95 or better (Wave 0 savings pay for Wave 1).
- Reduced motion produces a static frame for every new motion.
- `validate:full` green; docs (`character-mode/README.md`, `DESIGN.md`, `docs/motion-budget.md`, `docs/material-channel-contract.md` where touched) and `CHANGELOG.md` updated.

## Execution record

Implemented 2026-09-25/26 by about 30 Opus 5.5 lanes in Waves 0–8, then three QA reviews (world, signal, chrome), nine fix lanes, and two rounds of maintainer feedback. Status is `implemented — pending maintainer visual sign-off`: every item below is implemented or explicitly not done with a reason, and the final visual judgment on the maintained server is the maintainer's.

Evidence is local-only: captures, probes, contact sheets, throwaway tools, and the PixelLab ledger live under the gitignored `output/` tree (`output/impl-shots/<Lane>/`, `output/qa/{QAWorld,QASignal,QAChrome,Docs}/`, `output/fix/<Lane>/`, `output/impl-shots/coord/`, `output/buildings-work/`, `output/attic/`) on the maintainer's machine and are not committed. Paths below are relative to the repository root.

### Council review — waived

The adversarial Opus 5.5 council could not run: all three spawns on 2026-09-25 failed harness preflight (`Config overlay not found: ~/.omp/agent/overlays/auto.yml`). The maintainer then waived it, since D1–D5 settle the open items. The checks it would have made become Wave 0 entry checks for the implementer:

- The 0.3 cache-key split must leave room for the separate phase-keyed water LUT in 3.4.
- The 3.2 interim affine fix must be A/B'd against the rejected 45° Wang rotation for mixels.
- The 0.1 overlay replay stays limited to open-air presets.
- D1 must not break crowd, hit-test or label layouts.
- Ground captures stay inside the D5 saturation band.

### Phase record

| Phase | Lane | Items | Key files | Notable deviations |
| --- | --- | --- | --- | --- |
| Wave 0 | Pipeline | 0.1, 0.2, 0.3 | `WorldFrameRenderer.js`, `ParticleSystem.js`, `GroundCueRecords.js` (new), `IsometricRenderer.js` (terrain bake passes), `gpu/GpuWorldPolicy.js`, `gpu/GpuWorldRenderer.js` | Admitted open-air presets are narrower than the plan's list (smoke, torch, buoy torch, forge ember, firefly; hand/foot-height presets stay Canvas-only until GPU particle records exist). Live ground cues became GPU records at a small CPU cost (+0.2–0.5 ms after the fix-up round, not the plan's "negative cost"); ground-cue uploads fell from 300/300 frames × 2.58 MB to 10/300 × 58 KB, terrain rebuilds across a day and three zoom steps from 7 to 0. Crowd auras and text-bearing washes stay in the retained texture at scale 0.5 or 1. |
| Wave 0 | ChromeFrame | 0.4, 0.6 (toasts, top-bar counts), 7.1, 7.2, 7.3, 7.6, 7.10 (tool colours) | `css/reset.css`, `css/topbar.css`, `css/layout.css`, `css/modal.css`, `shared/TopBar.js`, `index.html`, `config/theme.js`, `DESIGN.md` | `--ink-3` is `#97876e` (plan `#8c7c64`) for ≥ 4.5:1 on every surface. Toasts moved bottom-right in both modes (Labels2) instead of the plan's bottom-left, which the lower-third caption now owns. Pending counts read `–` from the existing `village:state` phase, no new flag. |
| Wave 0 / 8 | CameraBoot | 0.5, 8.1, 8.2, 8.3 | `CameraCurves.js` (new), `Camera.js`, `CameraDirector.js`, `App.js`, `ModeManager.js`, `css/character.css` | The old opacity-timer reveal was deleted, not kept as a fallback. `maxZoom 1.5` became an explicit cap (automatic moves never rest above tier 1). The follow is a composition window, not a leash. The dense-100 survey-tier cost check (D4 condition) was not run by the lane. Zoom-step timing was later reworked by FixDash (see below). |
| Wave 1 | Light | C2, 1.1, 1.2, 1.4, 1.6 (WebGL) | `GradeEvaluator.js` (new), `gpu/GpuWorldPolicy.js` (`GRADE_GLSL`), `gpu/GpuWorldRenderer.js`, `postfx/PostFx.js`, `postfx/PostFxFeed.js`, `AtmosphereState.js`, `CloudShadowCourses.js` (new), `CanvasGrade.js` (new) | The grade runs in the scene pass before the light loop, not in `COMPOSITE_FRAGMENT`, so lit and emissive pixels are exempt without a lit mask in emission alpha (WebGL2 has no per-attachment blend). The evaluator is a superset of C2 (overcast and fog rows, `poolGain`, `purkinje`, `rake`, …). Night values were retuned three more times (LightIII, FixLight, maintainer feedback). |
| Wave 1 | LightII | 1.3, 1.6 (Canvas), 1.5 (wired) | `SkyRenderer.js`, `BackdropGrade.js` (new), `RakingLight.js` (new), `CanvasGrade.js` (`ungradeRgb`), `AtmosphereState.js`, `AgentGroundMarks.js` | No GPU sky texture: the backdrop is painted on the 2D canvas in final colours (WebGL) or their preimage (Canvas), zero uploads by construction. Canvas aerial haze is the stepped screen-Y band without the resident path's 0.8× desaturation, and it tints the sky slightly; it follows the ladder's `aerial-perspective` row. Golden-hour casts were wired but invisible at handoff. |
| Wave 1 | LightIII | 1.5, 1.2 rework, night/storm retune | `RakingLight.js`, `GradeEvaluator.js`, `gpu/GpuWorldPolicy.js`, `gpu/GpuWorldRenderer.js`, `postfx/PostFx.js`, `CanvasGrade.js`, `IsometricRenderer.js` (pool layers) | Cast alpha raised to `shadowAlpha + 0.44 × rake` (cap 0.74), a `sun` flag in the bucket key, tree casts ≈ 1.7× tree height. Pools step each light on its own falloff (weights 0.30/0.54/0.76) with warm lights on the C1 emissive ramp; Canvas composites the pool layer once per frame. Canvas grass under a lamp stays slightly more khaki than WebGL. |
| Wave 2 | Bodies | 2.1, 2.3, 2.4, 2.5, 2.6, 2.7 | `AgentSprite.js`, `AgentGroundMarks.js` (new), `Compositor.js`, `AgentGpuOverlayRenderer.js`, `gpu/GpuSceneBuilder.js`, `assets/sprites/palettes.yaml` | As planned (D1): bodies 48–75 world px, one 1-texel `#1c1410` rim baked into the atlas, 2×2-majority 0.5× crowd LOD sheet, trim-only provider colour. |
| Wave 2–4 | FoliageProps | 2.2, 3.6, 4.1 | `FoliageRenderer.js`, `SceneryEngine.js`, `config/scenery.js`, `scripts/sprites/foliage-pass.mjs` (new), `scripts/sprites/prop-plinth-pass.mjs` (new), `scripts/world/validate-terrain.mjs` | Props regrouped 24 → 10 (plan: ~8); trees in 8 authored clumps plus 5 cluster regions; waterfalls cut end to end, including their validator checks. Offline passes are sha-guarded and reproducible. |
| Wave 3–4 | Palette | 3.1 (C1), 4.3 | `config/artPalette.js`, `config/theme.js`, `scripts/sprites/art-analyze.mjs` (new), `package.json` (`art:analyze`) | Accent v2 hues moved off the plan's proposals to keep ≥ dE_OK 0.072 from every status hue. `art:analyze` is advisory and always exits 0. The water and grass ramps were lifted again by FixSea. |
| Wave 3–4 | Ground | 3.2, 3.3, 4.7, 4.2 (plaza) | `GroundBake.js` (new), `IsometricRenderer.js`, `config/townPlan.js` (`YARD_MATERIALS`, 2-wide arms), `TerrainTileset.js`, `gpu/GpuSceneBuilder.js` (`paintGroundClass`), `config/scenery.js` | The offline re-tone of land sheets (grass-cobble 143 → 95) was skipped: the bake keeps only sheet luminance, so re-toning would add nothing. Paved share 41 % → 30.6 %; rendered noon median saturation 0.596 → 0.461 (D5 band). Bake ≈ 130 ms once, zero per frame. A duplicate well and two guardposts on the new Command gate steps were removed. |
| Wave 3 | Water | 3.4, 3.5, 3.7 | `CoastBake.js` (new), `IsometricRenderer.js` (water/edge), `SceneryEngine.js` (edge is sea), `WorldFrameRenderer.js`, `gpu/GpuSceneBuilder.js`, `gpu/GpuWorldRenderer.js` (`u_waterMood`) | Water mood is a shader uniform plus a Canvas recoloured copy instead of a phase-keyed LUT in the terrain cache. The lane kept the horizon at the island equator (a raised variant was reverted); QA called this a blocker and FixSea moved it above the north vertex. |
| Wave 4 | Buildings → Buildings2 → Buildings3 | 4.4 (ship fix), 4.5, 4.6, 4.2 (building) | `assets/sprites/buildings/building.{archive,forge,mine,taskboard,command,observatory}/*`, `assets/sprites/manifest.yaml`, `BuildingVisualRegistry.js`, `BuildingSprite.js`, `LandmarkActivity.js`, `atlases/world-pilot.*`, `scripts/tests/w4-b.building-windows.test.mjs` | A three-lane relay (request budgets). Archive and Forge (Buildings), Mine and Task board plus the Observatory sidecar (Buildings2), Command install with its three inspection layers and lit windows (Buildings3). The family palette came from Observatory + Command colours plus C1 (snap within 10 RGB), not a hard C1 snap; the Pro model's shallower-than-2:1 projection was kept for consistency with the Observatory. Command's watchfire layer was retired. The ship fix shipped (alpha 128 + 1-px `#1a120c` outline); ships were not regenerated. |
| Wave 5 | Labels → Labels2 | 5.1–5.6, 2.1/2.7 impostor retune | `AttentionPlates.js` (new), `WorldLabelKit.js` (new), `AgentSprite.js`, `IsometricRenderer.js` (label slots), `WorldFrameRenderer.js` (captions), `BuildingSprite.js` (plaques), `config/theme.js` (C5 fonts), `LandmarkActivity.js`, `css/layout.css` | Old compact badges, budget impostors and `drawBubbles` were deleted rather than resized. Offscreen attention agents get docked edge plates instead of clamped beacons. The gate inscription became a hand-drawn 5-row pixel alphabet because no C5 size fits the arch. Top-N is 3 per 200 px region (6 at zoom 3). |
| Wave 6 | Effects | 6.1–6.5 | `EffectStamps.js` (new), `ArrivalDeparture.js`, `ChronicleMonuments.js`, `HarborTraffic.js`, `IsometricRenderer.js` (gate walk-in) | The bracket also fires for a remote `rejected` push (treated as a verified failure). Dispatched children first landed beside the parent; QA found the comet invisible, and FixOverlayFX2 moved the landing 2–3 tiles away. |
| Wave 6 | AmbientLife → AmbientLife2 | 6.6, 6.7 | `RitualConductor.js`, `WorkDownbeats.js` (new), `WildlifeRenderer.js`, `WeatherRenderer.js`, `ChimneySmoke.js` (new), `AmbientGround.js` (new), `ParticleSystem.js`, `SeasonalAmbience.js`, gull PNGs | Gulls fly ten lanes with at most one gull each (measured 6–9 active), replacing probabilistic cycling. Downbeats run at the WORKING mark tier (at AMBIENT they were invisible). Chimney smoke comes only from the Forge (the only registry chimney); Harbor smoke stays in `BuildingSprite` and is not occupancy-gated. Songbird art (32 px) and the anti-aliased lightning bolt were left as they were. |
| Wave 7 | ChromePanels | 7.4, 7.5, 0.6 (sidebar names) | `css/sidebar.css`, `css/activity-panel.css`, `shared/Sidebar.js`, `shared/ActivityPanel.js`, `index.html`, `dashboard-mode/AvatarCanvas.js` (`sheet`) | A 26×32 full-body witness beside the portrait was added, then removed by FixChrome as redundant. |
| Wave 7 | Dashboard | 7.7–7.12, 7.10 (`RepoColor`) | `dashboard-mode/DashboardRenderer.js`, `dashboard-mode/ObservedCallTape.js` (new), `dashboard-mode/AvatarCanvas.js`, `css/dashboard.css`, `shared/RepoColor.js` | Shipped columns `AGENT / NOW / LAST 10 MIN / FOR / TOKENS / COST`. The district radial wash was cut from `AvatarCanvas`. The 1.8-era Dashboard ambience (phase tint, hearth radial) survived until FixDash removed it. |
| QA | QAWorld, QASignal, QAChrome | Review of Waves 0–8 | `output/qa/{QAWorld,QASignal,QAChrome}/findings.md` | 19 world findings (2 blockers), 19 signal findings (1 blocker), 22 chrome findings. Outcomes are in the next table. |
| Fix | FixLight, FixSea, FixOverlayFX, FixOverlayFX2, FixSignal, FixSignal2, FixChrome, FixDash, FixAssets | QA findings | see below | FixLight also carried the two maintainer night-feedback rounds. |
| Docs | Docs, DocsFinal | Doc sync | `character-mode/README.md`, `dashboard-mode/README.md`, `shared/README.md`, `claudeville/CLAUDE.md`, `DESIGN.md`, `docs/{motion-budget,rendering-baselines,design-decisions,material-channel-contract}.md`, this record, `agents/README.md` | No `CHANGELOG.md` entry (see Release notes draft). |

### QA findings and their fixes

| Finding | Fix lane | Outcome |
| --- | --- | --- |
| W-F1 horizon at the equator, void around the island (blocker) | FixSea | Fixed: horizon 4 tiles above the north vertex; one horizon band, a sun/moon glitter column, and a deep fill cover every visible pixel at any zoom or pan; the shelf and beach continue past all four edges. |
| W-F2 / S10 anti-aliased ellipses and gradients on the ungraded overlay (blocker) | FixOverlayFX, FixOverlayFX2 | Fixed: building, landmark, Harbor, crowd, stance, Chronicler, monument and aurora draws moved to the pixel grammar; the AA probe reads 0 calls on both canvases in dense-24 (noon, night), git-harbor and release-parade. |
| W-F3 night neutral charcoal | FixLight (+ two feedback rounds) | Fixed; see Maintainer decisions. |
| W-F4 noon wide view reads as dusk | FixSea | Fixed: water and grass ramps lifted; WebGL z1 noon water V 0.310 / S 0.375, grass V 0.365 / S 0.461, world luma 79.6. |
| W-F5 pools are screen circles | FixLight | Fixed: 2:1 ground ellipses on WebGL, Canvas stamps and PostFx. |
| W-F6 Harbor panes baked lit | FixAssets | Fixed: dark slate glass in `base.png`, lit panes in a new `base.emissive.png`. |
| W-F7 inland water checker | FixSea | Fixed: the `mod(x + 2y, 4)` lattice replaced by sparse 2:1 ripple dashes. |
| W-F8 Lighthouse and sea-tower baked plinths | FixAssets | Fixed: hand-authored limestone footing; water tile keyed out; Lighthouse window rects re-registered and a window sidecar added. |
| W-F9 Canvas fallback diverges | FixSea, FixLight, FixOverlayFX2 | Partial: Canvas water marks and PostFx displacement/grain are on the grid, Canvas pools are stepped 2:1, Canvas-only building draws are pixel grammar; the Command door stays brighter on Canvas (no Canvas occlusion or palette lookup). |
| W-F10 doors fail C3 | FixAssets | Partial: Archive re-authored as a tall lancet (leaf ≈ 87 world px vs villager ≈ 61, ≈ 1.4×). Command's leaf is ≈ 65–68 px (≈ 0.95–1.07×); door plus steps ≈ 83 px (≈ 1.2×) meets C3 only under its "doors and thresholds" reading. The taller-gate inpaint hung and was cancelled; nothing was installed. |
| W-F11 grey sunrise | FixLight, FixSea | Fixed: rosier, brighter sunrise key with its own `rake`; dawn sea is day water (night weight < 0.15). |
| W-F12 lilies on the bridge | FixSea | Fixed: pads and buoy moved into the pond. |
| W-F13 landmark/Harbor drawn twice | FixOverlayFX | Fixed: overlay-safe categories skipped in the resident depth pass. |
| W-F14 AA connection and talk lines | FixOverlayFX | Fixed: dotted curves, drawn only while an endpoint is selected. |
| W-F15 checker "raft" at the slip | FixOverlayFX | Fixed: it was `prop.harborCrane` (baked checker deck); the prop, its manifest entry and PNG were removed. |
| W-F16 body on the Command roof | FixSignal, FixSignal2 | Fixed: behind-footprint bodies sort before the back half; their names, marks and bubbles are skipped unless selected. |
| W-F17 Task board reads as a switched-off screen | FixAssets, FixSignal, FixSignal2 | Fixed with a deviation: faint erased-chalk ghost strokes instead of baked parchment notices (which would show tasks that do not exist); the chalk was refit to the slate. |
| W-F18 plum pier off-ramp | FixAssets | Fixed: `bridge.ew`/`bridge.ns` re-toned onto the C1 timber ramp. |
| W-F19 golden-hour cast seam | FixLight | Rejected: the arc also appears at 06:00 and 12:00 without casts, each building's cast is one merged mask, and the streak was gone in the current tree; no shadow code changed. |
| S1 attention lights bloom to white (blocker) | FixLight | Fixed: stepped courses on 2:1 ellipses, brightest-wins, radius 34–40, intensity ≤ 0.6; no wet-reflection slot (`u_wetMask`). |
| S2 plaque count wrong | FixSignal, FixSignal2 | Fixed: each live body counted once (folded, routed through another footprint, or assigned); many-waiting reads `COMMAND 9`, dense-24 plaques sum to 24. |
| S3 / C-F1 no top-bar slot for errored or rate-limited | FixChrome | Fixed: one lit slot with `NEEDS YOU` / `ERROR` / `LIMIT` parts. |
| S4 / C-F5 rate-limited slate reads as idle | FixChrome, FixSignal, Main | Fixed: rate-limited `#f06ae0` (orchid); `INCIDENT_COLORS_RGB` quota and rate-limit follow it. |
| S5 empty assay trays, overlapping ledger | FixSignal | Fixed. |
| S6 nine plates in a ladder | FixSignal | Fixed: same-kind grouping by collision or 96 px beacon distance, 24 px leader cap, edge-plate merging, kinds never mix. |
| S7 sub-agent return captioned as a milestone | FixSignal | Fixed: neutral `RETURNED` lower third; sub-agent removal is not a completed session. |
| S8 dispatch comet invisible | FixOverlayFX2 | Fixed: lands 2–3.25 tiles away on a free, reserved tile (measured 3.16 tiles, still there 7 s later). |
| S9 failed-push bracket in open water | FixOverlayFX, FixOverlayFX2 | Fixed: jetty slip posts when no ship is docked; confirmed at z2/z3, noon and night. |
| S11 task board chalk collides | FixSignal, FixSignal2 | Fixed: upright stepped glyphs, 18/30 px rows, slate clip, count-keeping headers, screen-fixed plan tabs off the slate edge. |
| S12 labels cross bodies | FixSignal, FixSignal2 | Fixed: labels below ground marks, T4 names dropped on body overlap, chits give way to names. |
| S13 plates and plaques leave the frame | FixSignal, FixSignal2 | Fixed: plaques kept inside or hidden; T2 plates shifted inside or dropped when the body is off-canvas. |
| S14 raw tool ids on chits | FixOverlayFX, FixOverlayFX2 | Fixed: `ToolIdentity.toolVerbLabel`, word-fit labels; taskboard papers carry no text. |
| S15 storm night near black | FixLight | Fixed: `GRADE_AMBIENT_FLOOR`. |
| S16 cream blob arrival peak | FixOverlayFX | Fixed: 1-texel cream rim. |
| S17 fireflies at zoom 2 | FixSignal | Fixed: zoom ≥ 3 only, cap 12 (probe-verified). |
| S18 plate ages disagree with the sidebar | FixSignal | Fixed: fixture forwards `awaitingSince`; plates use `SignalLedger.waitAnchor()`. |
| S19 extra AA rings on selection | FixSignal | Fixed: director rings only for the selected building and incidents, 1-texel pixel outlines. |
| C-F2 Dashboard turns cool at night | FixDash | Fixed: flat `--bg-0`, ambience code deleted. |
| C-F3 first-run hint above modals | FixChrome | Fixed with a deviation: z-index 90, folds while a modal, the controls popover or an agent panel is open, dismissed by opening the controls; selecting an agent only folds it (an automatic selection could otherwise eat the one-time hint). |
| C-F4 pennant collisions | FixChrome | Fixed: palette re-spaced ≥ 35°, live visible-repo registry; FixOverlayFX2 removed the private repo-profile caches in Harbor and `BuildingSprite`. |
| C-F6 `+N in Needs You` vs `NEED ACTION` | FixDash | Fixed: `+N in Need Action ↑`. |
| C-F7 `?` tool glyphs for other providers | FixDash | Fixed: `ToolIdentity` alias table (0 `?` rows in 16 captures); those calls now paint as act/look by their real class on the tape. |
| C-F8 toast noise | FixChrome | Fixed: joins silent until the first snapshot, no mode-switch toasts, departures on the info rail. |
| C-F9 compressed zoom steps | FixDash | Fixed: 450 ms per rung, glide lengthened to ≥ 4× zoom time, opening dolly ≥ 2400 ms; `F` from tier 3 takes 3.6 s (was 1.3 s), peak apparent motion 7.7k → 3.1k px/s. |
| C-F10 boot and degraded copy | FixChrome | Fixed: `SYNCING`/`DEGRADED` chip, `–` counts in DEGRADED with no agents, phase-keyed sidebar empty copy (code path checked, not re-captured). |
| C-F11 repeated bell-card detail | FixDash | Fixed: one provenance order, no repeated status/provenance, `Full request` only when truncated. |
| C-F12–C-F17, C-F19–C-F21 | FixChrome | Fixed: popover/hint/READ on the 7.2 system, on-grid type and no italic, contrast ≥ 4.5:1, non-zero-only shelf words, `state · Model`, no fabricated `~$0.00` and no witness, native-free Settings/Chronicle controls, `TOKENS SEEN TODAY`, dead `--cv-dash-*` tokens removed. |
| C-F18 boot banner repeats the empty card | FixChrome | Partial: one voice (card carries the detail and `TRY AGAIN`), banner centred, sky band moved; degraded and syncing states not re-captured. |
| C-F22 cross-lens world items | world fix lanes | Covered by W-F2, S1 and S12/S13. |

### Maintainer decisions as applied

- **D1 (1:1 villagers)** — applied in Wave 2; labels, crowd layout, hit-testing (`_bodyBox` + 3 px) and the resting tier (3) were retuned with it.
- **D2 (routine names top-N)** — applied in Wave 5: T4 names only at zoom ≥ 1.6 for the top 3 (6 at zoom 3) most recent actors per 200 px region; T1 plates and T2 plates keep every action-needed or selected agent named. The old "identity never disappears" comment and README text were replaced.
- **D3 (re-author with PixelLab, no cap)** — applied: Archive, Forge, Mine, Task board and Command re-authored; the 4.4 quantized fallback was not needed. Spend is below.
- **D4 (survey tier)** — implemented. Its condition, a dense-100 cost check on a quiet host, is recorded under Performance; the plan's optional "PostFx may drop to MINIMAL while zoomed out" was not implemented.
- **D5 (splat bake, moderate mute)** — applied: rendered noon ground median saturation 0.461 at the Ground lane, still inside 0.45–0.50 after FixSea lifted the grass ramp (graded frame S ≈ 0.46; the ramp's albedo is now S 0.49–0.56).
- **Particle route for 0.1** — interim overlay replay shipped; GPU particle records remain future work.
- **Feedback round 1 — "night went too hard on the dark".** FixLight's first night pass (albedo saturation 0.08, light blue-grey) read as monochrome. Night pass 2 raised exposure and moved the moonlight into a blue-teal cast.
- **Feedback round 2 — night still grey-green at 22:00 z2.** Night pass 3: albedo keeps about 40 % colour (saturation 0.42, deep night 0.38; exposure 0.74 / 0.66), moonlight rides the split tone (shadow `[0.84, 0.94, 1.10]`, highlight `[0.94, 1.03, 1.03]`, gain `[0.86, 0.94, 1.00]`), lantern and brazier pools back to radius 52 / 62 with warmer `#ffc95e` / `#ffa94a`, `poolGain` peak 1.20, stars 48 → 64. The test rule became: night exposure < 0.8× noon, night saturation 0.5–0.85× noon (0.57 on the palette measure), night bluer than noon. Measured at WebGL z2 22:00: luma 70.2, saturation 0.319 (0.84× noon), R−B −14.2.
- **Feedback round 3 — the Task board still showed the old flat art under the new chalk.** Cause: sprite URLs are versioned by `style.assetVersion` and served immutable for a year, and the version had not been bumped when PNGs changed. `style.assetVersion` is now `2026-09-25-opus55-painted-isle`; FixSignal2 refit the chalk to the current slate. A returning browser needs one reload.

### Not done, partial, or open

- **W-F19** rejected (see the QA table).
- **Moon glint path on the ocean** — partial. The outer ocean carries a sparse glitter column under the sun or moon inside the horizon band, and the resident water shader has a moon sheen on in-map water. A lit moon path running across the near sea was not built: `SkyRenderer` draws before the ocean, which paints over anything the sky places below the horizon, so it would need a stamp in `CoastBake.drawOuterOcean`.
- **Canvas aerial perspective (1.6)** — implemented (`BackdropGrade.drawCanvasAerialHaze`, stepped screen-Y haze in the preimage, off at MINIMAL), without the resident path's 0.8× desaturation and with a slight tint on the sky because Canvas cannot separate world from sky. Canvas grass under lamps stays slightly more khaki, and the Command door stays brighter on Canvas (W-F9).
- **`CrowdClusterOverlay` `+N` tab** still counts a cluster hidden behind a building and sits on the Command dome base.
- **Command door** ≈ 65–68 px leaf (≈ 1.0× the median body); door plus steps ≈ 83 px meets C3's ≥ 1.2× only as a threshold reading. A taller gate needs a re-run of the staged inpaint (`output/buildings-work/jobs-fx-command-gate.json`) or a hand edit to a leaf of ≥ 78 px.
- **C3 exceptions** — Harbor ships still draw at 0.64–0.90× (`HarborTraffic`), and `prop.flowerCart` has a 0.5× display size.
- **Dead-inventory sprites** — `veg.tree.pine.small`, `veg.bush.a/b/c`, `veg.grassTuft.a/b` and `veg.reed.a/b` were retired to `output/attic/vegetation/` (gitignored) and their manifest entries removed with a retirement comment; `prop.harborCrane` was deleted outright (W-F15).
- **OF-010 street spill** — unchanged: light pools stay inside the existing pass, as the plan kept it cut.
- **Offline land-sheet re-tone (3.2)** — skipped; the bake uses sheet luminance only.
- **GPU particle records** — not built; hand- and foot-height presets (forge sparks, sparkles, motes, portal runes) stay Canvas-only, and overlay particles are not depth-sorted.
- **Smoke** — only the Forge has a registry chimney; Harbor smoke is not occupancy-gated.
- **Harbor decals** — flag and pennant decals and the procedural ship-class overlay still use small anti-aliased path fills.
- **Tooling** — `scripts/sprites/atlas-bake.mjs` reads `windowRects[].at` as a top-left corner while the renderer and tests read it as the centre (harmless today because every lit building ships an authored emissive sidecar).
- **Leftovers outside this record's files** — the `artPalette.js` grass comment still says S 0.46–0.51 (ramp is 0.49–0.56); `docs/world-visual-qa-checklist.md` still mentions a quota "work-weather nudge" and lacks checks for the new moments, plates and opening; `docs/building-style-contract.md` still prescribes painterly shading; the Ambient incident chapter's red `worldTint` is agent-driven; the sidebar attention blink and top-bar stale/offline blinks are the only infinite chrome loops; an ignored `duration: 3200` argument and stale waterfall comments remain; `docs/rendering-baselines.md`'s terrain-cache figures predate the new bakes.
- **Captures not taken** — C-F10 and C-F18 degraded/syncing states, many-waiting z1 (captured, not viewed), the Mine pick downbeat, and the Archive after W-F2.

### PixelLab spend

Tier 1 subscription generations, $0 in credits throughout. Balance trail from `output/buildings-work/balance-log.txt`, the lane reports, the ledger, and a final balance read on 2026-09-26:

| Step | Balance | Spent | Where |
| --- | --- | --- | --- |
| Start (2026-09-25) | 1,819 | — | `balance-log.txt` |
| Buildings | 1,502 | 317 | Archive (6 candidates, 102), Forge / Task board / Mine candidates (120), Command candidates (95); the lane reported 1,522 before its last batch settled, and the ledger's batch costs sum to 317 |
| Buildings2 | 1,352 | 150 | Task board (60), Command gate candidates (50, rejected), Command gate inpaint (40) |
| before Buildings3 | 1,332 | 20 | not attributed (Buildings3 suspected a timed-out seed) |
| Buildings3 | 1,332 | 0 | installed staged art only |
| FixAssets | 1,272 | 60 | Archive lancet door inpaint (3 runs); the cancelled Command gate job cost nothing |
| **Total** | **1,272** | **547** | |

Every generation's id, prompt and cost is in `output/buildings-work/gen-ledger.jsonl`; installed sprites carry their job ids in manifest `provenance`.

### Gates

Final gates (2026-09-25, coordinator, after the last fix-up): `npm run validate:full` exit 0 (0 warnings; the eight dead-inventory `UNREFERENCED` sprite warnings from the P2 run are resolved); `npm run verify:render` passed; `npm run verify:server` exit 0; `npm run check:artifacts` consistent (20 retained artifacts).

### Performance

Measured by PerfAudit on a quiet host (one browser, load average 3.2–5.3 on 18 cores). Evidence is local-only: `output/perf/report.md`. The pre-plan baseline was captured on a loaded host, so compare trends only.

- **D4 survey tier: approved on cost.** dense-100 at survey zoom (DPR 2): appRender 4.3/5.1 ms p50/p95, GPU whole frame 2.2–2.6 ms fresh and 3.6–3.9 ms p50 in 180 s soaks at 12:00 and 22:00. The ladder held FULL with nothing shed. GPU cost is lower than tier 1 at the same DPR (2.23 vs 3.11 ms); CPU is about 0.6 ms higher because it draws 2.5× the records.
- **Wins:** the semantic-ground upload fell from 2.56 MB/frame at 115/s to about 50 KiB/frame at about 4/s. dense-100 texture bytes fell from 153 to 122 MB. Steady frames trigger no terrain, ocean, sky, ground-field or water-mood rebakes. `world:benchmark-trails` shows zero repaints under camera motion.
- **Regression found and fixed:** 1.5 tree ground casts were keyed by canvas size, which forced about 12.6 texture re-uploads per frame at dense-100. They are now keyed by tree size and upload only on a sun-bucket change; the probe measured 0 uploads over 360 frames at DPR 1 and 2.
- **Priced cost:** 0.2 ground-cue records make up 64–85 % of all records and cost 0.4–0.6 ms of render time at dense-100 z1 and 0.7–0.9 ms at the survey tier.
- **Pre-existing, out of scope:**
  - In a 150 s soak of dense-100 at tier 1 and DPR 1, the ladder sheds FULL → REDUCED → MINIMAL within about 50 s and stays there. The GPU timer drifts to about 4 ms whatever the workload, right at the 4 ms ladder budget (`GpuWorldRenderer.js` ladder budget). The frontier research already recorded dense-100 never reaching FULL, so this is budget calibration, not part of this plan.
  - At DPR 2, GPU-owned bytes are about 173 MB against the 128 MiB diagnostic ceiling. The source-texture cache is about 105 MB against its 47.7 MiB cap.

### Release notes

Shipped as `v0.46.0` — *The Painted Isle* (Sep 26, 2026); the text below is the draft that became the `CHANGELOG.md` entry, which is authoritative. Open measured residuals moved to the live ledger as [OF-011 and OF-012](open-followups.md).

```markdown
## v0.46.0 — *The Painted Isle* · Mon DD, YYYY

ClaudeVille had plenty of effects but no correct base image: the default renderer never showed the time of day or the weather, the ground was a checkerboard of mis-mapped tiles, three pixel densities stood side by side, and the effect layer was invisible while the labels shouted. This release repairs the picture from the ground up.

- **One light.** One grade (`GradeEvaluator.js`) turns the real clock, weather, moon and season into the whole world's colour on both the WebGL and Canvas renderers. Noon, golden hour, blue hour and night now look different, and rain and storm read at a glance. Night is moonlit rather than grey: grass stays green, stone turns slate-blue, the sea stays blue. Lamps pool as small, warm, stepped rings on the ground, clouds cast world-locked shadows, and low sun throws long violet casts.
- **One pixel grid.** Villagers stand at integer 1:1 (48–75 world px instead of 82–120), trees draw at 1×, and every effect, ring and mark sits on the art-pixel grid; the soft anti-aliased ellipses and glows are gone from the overlay. Bodies share one baked rim and one contact shadow; rings appear only for selection, hover and agents that need you.
- **A baked ground and sea.** The land is one splat bake on a master palette with district yards and worn doorsteps. The coast comes from one continuous field with foam, five depth stops and a stratified cliff, and the island now sits in open sea on every side, with the horizon above its far shore. Inland water is still, with sparse ripple dashes instead of a checker.
- **Coherent architecture.** Archive, Task board, Mine and Forge were re-authored on the Observatory's clean grid, and Command is the hero. Windows light only when someone works inside, including the Harbor and the Lighthouse. Props are fewer and grouped, trees grow in clumps by biome, and the unsourced waterfalls are gone.
- **A calm signal layer.** One attention plate per waiting, errored or rate-limited agent, grouped only with others of the same kind and docked at the frame edge when the agent is out of view. Rate-limited has its own orchid colour instead of the idle blue. District plaques state the exact count of agents routed there (`FORGE │ 8`); routine names appear at closer zoom for the most recent actors, and every label sits on the 8/11 px type grid.
- **Moments with a grammar.** Arrivals rise as a violet column at the gate. Sub-agents fly out as comets and land a few tiles from their parent; their return is captioned `RETURNED`, in stone, never gold. A verified release crowns the Harbor, a failed push leaves a red broken bracket on the jetty, and real tool work strikes small downbeats. Gulls, fireflies, rain, chimney smoke and seasonal drift follow a budget and a static reduced-motion frame.
- **A quieter frame.** The chrome moved to a parchment ink ramp on four flat surfaces, with gold reserved for light. The 48 px top bar has one lit slot for `NEEDS YOU`, `ERROR` and `LIMIT`; the Activity Panel is a character sheet, and the sidebar rows are 44 px. Boot no longer announces every existing session. The Dashboard sits on flat dark ground with one header row per project, a `NOW` column, a portrait on every row, a bell lane of call cards for agents that need you, and a `LAST 10 MIN` observed-call tape that understands every provider's tool names. Sibling repos always get different pennants.
- **Camera.** One motion vocabulary: log-space zoom, a pan at a resting tier, then unhurried 450 ms zoom steps. The follow window uses a critically damped spring, high-DPI screens get a survey tier for the opening and Ambient wide shots, and boot fades in from the sky instead of flashing black.

Validation: <fill in at release: test count, validate:full, render and server smokes, and the before/after contact sheet>.
```
