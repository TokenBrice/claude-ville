# ClaudeVille state-of-the-art visual plan — *The Waking Isle*

**Status:** `implemented (P1–P5, 2026-09-29); 7.5 deferred, 9.7b and the free-ladder soak not run`

**As of:** 2026-09-27, `main` at `44eabb5` (`v0.47.1` *The Minstrels' Gallery*), clean tree. Maintainer decisions M1–M27 settled 2026-09-28 (see [Maintainer decisions](#maintainer-decisions-settled-2026-09-28)).

**Author:** Opus 5.5 coordinator at xhigh. Consolidates 16 parallel, read-only Opus 5.5 explorations (6 at xhigh, 7 at high, 3 at medium), then revised after a three-lens Opus 5.5 council review (truth and sequencing, technical feasibility, fidelity to the evidence; see [Council review](#council-review-applied)). Following the precedent the maintainer set for the aesthetic plan, the evidence is **local-only**: it lives in the gitignored [`../../output/claudeville-opus55-xhigh-visual/`](../../output/claudeville-opus55-xhigh-visual/) (about 1.1 GB: 16 notes, 454 captures and mocks, 14 prototype directories, and the explorers' tools). Links into it resolve only on the machine that produced them; elsewhere, read each item's text as the specification. Item headings name their source ids (for example `[WPG-1]`), which are the item ids inside the matching note. `file:line` anchors were read at `44eabb5`.

## Method

| Territory | Note | Effort |
| --- | --- | --- |
| Holistic art direction, colour script, edges | [`art-director.md`](../../output/claudeville-opus55-xhigh-visual/art-director.md) (AD) | xhigh |
| Outside eye: 2025–2026 games, browser showcases, agent-visualizer peers | [`outside-eye.md`](../../output/claudeville-opus55-xhigh-visual/outside-eye.md) (OE) | high |
| Browser graphics platform, WebGPU, WebGL2 on ANGLE Metal | [`web-platform-gpu.md`](../../output/claudeville-opus55-xhigh-visual/web-platform-gpu.md) (WPG) | xhigh |
| Local light and 2D/2.5D global illumination | [`lighting-gi.md`](../../output/claudeville-opus55-xhigh-visual/lighting-gi.md) (LGI) | xhigh |
| Pixel-art rendering technique: sampling, sub-pixel motion, colour cycling | [`pixel-technique.md`](../../output/claudeville-opus55-xhigh-visual/pixel-technique.md) (PT) | xhigh |
| Colour pipeline: value ladder, wide gamut, HDR | [`color-hdr.md`](../../output/claudeville-opus55-xhigh-visual/color-hdr.md) (CH) | xhigh |
| Frame and memory budget, pricing, protocol | [`perf-budget.md`](../../output/claudeville-opus55-xhigh-visual/perf-budget.md) (PB) | high |
| Water, coast, sea, reflections, ships | [`water-sea.md`](../../output/claudeville-opus55-xhigh-visual/water-sea.md) (WS) | high |
| Sky, clouds, weather, wind, seasons | [`sky-weather.md`](../../output/claudeville-opus55-xhigh-visual/sky-weather.md) (SW) | high |
| Villager animation, expressiveness, crowds | [`characters-motion.md`](../../output/claudeville-opus55-xhigh-visual/characters-motion.md) (CM) | high |
| Living architecture, props, landmarks | [`buildings-life.md`](../../output/claudeville-opus55-xhigh-visual/buildings-life.md) (BL) | high |
| Ground micro-detail, foliage, wear | [`terrain-foliage.md`](../../output/claudeville-opus55-xhigh-visual/terrain-foliage.md) (TF) | medium |
| Truthful agent-state storytelling and moments | [`signal-moments.md`](../../output/claudeville-opus55-xhigh-visual/signal-moments.md) (SM) | xhigh |
| Camera direction, first impression, transitions | [`camera-cinema.md`](../../output/claudeville-opus55-xhigh-visual/camera-cinema.md) (CC) | high |
| DOM chrome | [`chrome-ui.md`](../../output/claudeville-opus55-xhigh-visual/chrome-ui.md) (CU) | medium |
| Dashboard mode | [`dashboard.md`](../../output/claudeville-opus55-xhigh-visual/dashboard.md) (D) | medium |

- One shared isolated simulator server (temp HOME, OS-assigned port through `scripts/smoke/r1-18.server-bootstrap.cjs`, never `:4000`) ran `?sim=1&scenario=<id>`. Explorers captured on the real GPU (`ANGLE Metal Renderer: Apple M5 Pro`) with the frontier capture helper and their own Playwright scripts, and looked at every frame they cite. Prototypes never touched source: `page.route()` served patched module copies into the real app, standalone WebGL2/WebGPU pages ran on real captures and dumped frames, and PIL mocks were painted over real captures (each mock labels what is real).
- **Viewing conditions were measured, not assumed** (ColorHDR, `system_profiler` + `NSScreen`): the main display is a Samsung Odyssey G95C at **5120×1440, 60 Hz, DPR 1, SDR**, which Chrome reports as sRGB-class (`dynamic-range: high` false, `color-gamut: p3` false). The panel itself is DisplayHDR 1000, 92 % DCI-P3 and 240 Hz capable; macOS drives it at 60 Hz SDR. The secondary is the built-in Liquid Retina XDR (DPR 2, 120 Hz, P3, EDR potential 16×). Chrome 153 and Safari 26.4 are installed. This single fact reorders the round: the survey tier, HDR and P3 do not reach the default view, and water fills 30–85 % of wide frames there.
- All 16 explorers ran concurrently on one 18-core host (load average 8–10 at dispatch; explorers recorded peaks of 9–84). Timings are loaded-host evidence and are re-priced under contract V2 before any item lands. Two explorers independently showed that ANGLE-Metal `TIME_ELAPSED` measures whole command-buffer spans, so **per-pass GPU timer samples from any round, including today's `EFFECT_BUDGET` receipts and several prices quoted below, are not evidence** (V2 replaces them).
- Stores were empty (fresh temp HOME), so Chronicle and ledger surfaces were judged as `?sim=1` populates them.
- The PixelLab MCP returned 401 inside explorer sessions, so the balance was not re-read (last recorded 1,272 generations on 2026-09-26). No generation or paid job was started; spend figures below are estimates.

## Relation to prior work

- **Extends** [the aesthetic plan](claudeville-opus55-aesthetic-plan.md) (`v0.46.0`) and keeps its guardrails, contracts C1–C5 and killed list unless an item below asks for a bend (see [Guardrail bends](#guardrail-bends-proposed-this-round)). It does not reopen anything its maintainer decisions D1–D5 settled.
- **Closes or advances ledger items** in [open-followups](open-followups.md): OF-011 (0.1), OF-012 (B.2), OF-014 (9.1), OF-010 (superseded by 2.1–2.3 if M6 is approved), OF-009 (7.3: skeleton-v3 keypoints should pin the feet, the lever the rig lacked [INFERENCE until the pilot proves it]), OF-008 (10.1, staged and gated). OF-007 stays closed: the main thread is healthy (app render p50 3.1–3.4 ms at dense-24, 0 long tasks in 36 of 37 matrix rows).
- **Resolves open items from the aesthetic execution record:** the moon path (3.2), the Command door (6.2), the Harbor-ship and flower-cart C3 exceptions (3.8), smoke beyond the Forge (6.4), anti-aliased flag decals (6.5), the stale building-style contract (0.8), the agent-driven Ambient tint and the checklist's "work-weather nudge" (0.2), GPU particle records (0.6), and the `atlas-bake.mjs` window-rect convention (0.8).
- **Regressions of shipped promises found this round:** weather, fog, snow flurries, gulls and screen tint driven by agent state or the calendar instead of the village's weather (binding guardrail; 0.2), smooth radial dawn ground haze (0.10), two "never a black frame" breaks (0.3), the 3.5 cliff and 3.7 reflections under-delivering (3.5, 3.7), a hard-edged dark wedge under the Harbor at the shelf (3.3), misregistered Archive rooms (0.8), trees that never sway on the resident path (0.7), and villager-height particles that are simulated but never drawn (0.6).

## The organizing finding

The aesthetic round gave ClaudeVille a correct base image. This round found that **the operator still mostly does not see it, and what they see holds still, lies about the weather, and moves worse than its art**:

1. **The renderer throttles itself on the display it runs on.** The resident ladder sheds on a fixed 4 ms budget (`GpuWorldRenderer.js:765-770`) read from ANGLE-Metal's command-buffer clock, which tracks DVFS and other processes rather than work. On the 5120×1440 60 Hz main display, dense-24 spends 81–86 % of frames below FULL with **no missed frame** (rAF p95 16.7 ms), and REDUCED/MINIMAL silently cut light admission 32 → 10 → 4 (`:1550-1556`, outside `EFFECT_BUDGET`). The real FULL frame costs about 4.0 ms GPU. The night the v0.46 plan built is mostly never on screen. (WPG-1, PB-1 — independently.)
2. **The island is frozen.** Deep water changes 0.6 % of its pixels over 2 s at noon and 0 % at night, and the outer ocean below its 300 px band is one flat fill: 30–45 % texture-free area at DPR-1 z1, 67 % one colour at z1 noon. Trees change 0.02–0.11 % of pixels on the resident path (their sway is baked into per-tree textures once). Only the Forge hearth and the Observatory clock move with work. Forcing January or May changes no land or tree pixel. Idle villagers move more than working ones (72 % vs 46 % of samples), so a quiet village looks busier than a busy one. (WS, AD, SW, TF, BL, SM.)
3. **Light is flat and out of order.** Local lights are 2D screen discs, so the occlusion pass self-occludes walls and bodies (upright lit px −38…−70 %, bodies −33…−41 % at FULL), window light paints roofs and the sea behind the Lighthouse instead of the street, and pool cores (OKLab L 0.97–0.985) clip brighter than the flames and the NEEDS YOU plate (L 0.862). Golden hour is *less* saturated than noon (S 0.33 vs 0.38) with a grey-olive sea; blue hour is darker than night (Y 52 vs 64). (LGI, CH, AD.)
4. **It still lies, and its motion reads worse than its art.** `Number.isFinite(Number(null))` is true, so the weather seed is 0 on every date (`AtmosphereState.js:391-393, 483-485`): every day is the same 84 % clear timeline, and every rain, fog or storm an operator has ever seen came from agent state (`cause: 'fleet'`, `WorldFrameRenderer.js:472-475`); winter flurries fall on 95 % of dry winter minutes. Bodies re-centre each frame on their own alpha bounds (3× the authored head sway), idle gait skates (~50 %), facings snap up to 180° in one frame, walkers step in whole texels (step CV 0.38), and zoom glides crawl with mixed 2/3 px texels for about 0.9 s. (SW-1, SM-1, CM, PT.)

The plan therefore works in this order: **show what already exists and stop lying** (Wave 0) → one colour script and one value ladder → light that lands on the street → a living sea → a camera that knows the screen → a living land → working architecture → villagers who work and rest → moments on stage, with the chrome, the Dashboard and a budget lane running in parallel and the WebGPU/HDR frontier (approved, M19) following once the WebGL2 shaders settle. Almost every item is a constant, a bake, or a substitution inside an existing pass. Wave 0 keeps the lamp pools that the ladder sheds today; it also re-admits FULL's screen occlusion and blurred bloom, which Wave 2 (2.2) and Wave 10 (10.2) replace.

## Guardrails (binding on every item)

- **Zero build, zero runtime dependencies, desktop ≥ 1280 px; no mobile breakpoints or responsive shrinking** (`AGENTS.md`). Layouts may use extra width on ultrawide windows (0.9).
- **Truth first.** No visual implies work, status, success or weather that did not happen. **Nothing in the environment — weather, cloud, wind, sky, sea, grade or screen tint — reads agent, mood or director state** (restated as V3 because the shipped code violates it). Success gold only for verified success. Action-needed agents stay unmissable at every zoom, in focus, Ambient and crowds.
- **Motion budget.** Every motion declares a band and ships a static reduced-motion frame (`docs/motion-budget.md`). No constant animation in the chrome.
- **Frame budget.** New per-frame cost is baked, substitutes for an existing cost, or carries a V2 receipt and an `EFFECT_BUDGET` row.
- **Pixel grammar.** Integer texel multiples at rest, stepped gradients with ordered dither, palette-true colour, no smooth gradients, blur, CRT, grain or bloom to fake mood. Upper-left baked sun key. Still killed from the aesthetic plan: volumetric beams on the resident path, per-frame full-screen passes, per-pixel animated wave shaders, per-frame GPU ground blending, and a second grade pass or render target — except where a row below bends one by name.
- **Asset spend is approved per batch.** Nothing in this plan carries prior spend approval.
- **Killed items stay killed** unless a row below brings new evidence and a maintainer decision.

### Guardrail bends approved this round

| Rule | Item | Why the rule's intent holds | Decision |
| --- | --- | --- | --- |
| C3 "sprite record positions snapped" | 0.4 (PT-1) moving bodies ride the backing-pixel grid | Every texel still renders as an exact k×k block (measured), provided sprite records quantize world-grid shading from their own origin (V9 `originFrac`); resting bodies land on whole texels | M4 |
| C3 "glides ≥ 75 % at integer tiers", nearest-only sampling | 4.6 (PT-2, PT-5) fat-pixel sampling on fractional-zoom or moving frames | Resting frames byte-identical nearest; flight-frame seams blend only the two adjacent authored colours over ≤ 1 px | M4 |
| "No normal maps" | 2.1 wall facing from footprint corners; 2.3 (LGI-3) 2-bit face class for local night lights | Sun key untouched; output lands on 3 stepped C1 courses; no smooth shading | M5 |
| Killed "per-pixel animated wave shaders" and "per-frame GPU ground blending" | Every water motion: 2.7 beam sheen, 2.9 column wobble, 3.1 cycle, 3.2 glint tick, 3.3 (e) ocean phases, 3.4 cat's paws, 3.6 swash and wet band, 3.7 and 3.11 row ripple, 3.9 rain rings, 3.10 caustics | No displacement and no new pass; a lit texel takes an adjacent authored ramp entry on hard steps (Ferrari colour cycling); every one has a static reduced-motion frame | M7 |
| Killed "volumetric beams on the resident path" | 2.7 the Lighthouse fan in the composite | Three stepped courses on the world texel grid over sky/void only, night only, constant speed and colour | M22 |
| C1 "water S ≤ 0.40", Tier-A value ceiling | 3.2 sun/moon path stops (gold S 0.56) | The path is the sky body's specular reflection, graded, passes through 1.2's knee, stays at HSL L ≤ 0.70; its stops join C1 as a named `seaPath` ramp | M7 |
| "Automatic moves never rest above tier 1" | 4.1 (CC-1): ordinary Auto rests at `scales.wide` (z2 at 5120×1440); explicit Ambient rests cohorts at `scales.medium` | Operators who have not opted in still get a wide cap; every rest stays pixel-exact | M8 |
| C1/D5 ground saturation band, Tier-A value ceiling | 5.2 winter snow cover | Snow is achromatic and low-contrast; status marks are saturated and stay distinct | M9 |
| C4 residue ≤ 6 s | 8.2 verified-release pennant for the local day | A static fact from the Chronicle store (a verified release happened today), never motion | M16 |
| C5 T3 plaque count semantics | V8 plaques count non-resting bodies | A plaque number then means work; T1 plates still carry every action-needed agent | M12 |
| V2 "RGBA16F only for a dedicated emission buffer" | 2.10 RGBA16F cascades | Optional item; lands only with its own receipt | M6 |
| PixelLab 9-slice UI skins (killed) | 9.5 frame kit | Four hand-authored flat 9×9 frames on the existing palette, no generated art | M14 |
| "No bloom/glow to fake mood" | 10.2 (CH-3) HDR highlights | Zero spatial spread (replaces bloom), exact palette chromaticity, SDR byte-identical, action-needed marks always brighter; a user setting (off / subtle / full), default subtle | M1, M19 |

## Cross-item contracts — specify before the wave that first needs them

### V1 — Viewing conditions and the verification viewport

- Primary viewports: **5120×1440 and 2560×1440, DPR 1, 60 Hz** on the G95C (the window width varies; M1), and the laptop XDR at DPR 2 (1512×982 and 1800×1169, 120 Hz); the maintainer watches both about equally and usually rests at z2. The G95C is being switched to **HDR** (M1): re-run ColorHDR's probe (`tools/color-hdr-probe-*`) after the switch and record `dynamic-range`, `color-gamut` and EDR headroom before 10.2/10.3 land. Backing store at 5120×1440 is 4880×1392 ≈ 6.8 Mpx, three canvases.
- Every visual item attaches captures at 5120×1440 DPR 1, 2560×1440 DPR 1 **and** one DPR-2 viewport. Items that touch the grade, wide shots, the sea or edges add the fixed-camera series. Items that touch emission or marks also check the HDR G95C once 10.2 lands.
- Capture tools pin the camera (`noteUserInput` + `setAutoMode(false)` + re-assert the pose before each shot); otherwise the Camera Director takes over after about 30 s and silently changes the framing (ArtDirector).
- Camera composition keys on **shot scales by visible world area** (4.1), never on "tier 1 = wide".

### V2 — Pacing-true budget and receipts

- The ladder's authority is **display pacing** in both directions: it demotes only when frames are actually being missed and promotes through pacing-gated probes (0.1). The GPU timer is a veto (it confirms the GPU is involved), sampled 1 frame in 4, read as a contention-robust p25.
- `EFFECT_BUDGET` receipts are **K8 slopes** (per-frame interleaved K ∈ {0,1,8}, price = (T8−T0)/8, with an A/A slope alongside) at 1920×1080 and 5120×1440, plus a vsync-unlocked FULL-vs-MINIMAL frame delta. A receipt is resolved only above 2× its A/A spread. Isolated per-pass `TIME_ELAPSED` samples are not evidence on ANGLE-Metal. Receipts state the refresh rate they assume.
- Tier contract (PB-8): grade, light pools and authored emission ship at every level; **light admission is a declared row, never below 12 at MINIMAL** (new light-loop work at REDUCED/MINIMAL, priced per level with gpu-burst); extra composite work ≤ 3 passes at FULL/REDUCED and 1 at MINIMAL; lighting fields per frame at FULL, every 2nd frame at REDUCED, per-sun-bucket bake at MINIMAL; sprite reflections on / every 2nd frame / off; RGBA16F only for a dedicated emission buffer.
- **Price items on the cumulative shader**, with the prototype loop injected into the real scene pass, not on standalone full-screen passes without overdraw.
- Quiet-host protocol for every receipt: load < 4, 3 × 12 s fresh contexts, 1080p + 5120×1440 + DPR 2, `scripts/world/gpu-burst.mjs` (0.1) for real-frame throughput.

### V3 — Environment truth (weather, ground, wind, seasons)

- **C-W1 weather source.** `resolveWeather` is a pure function of (local date, minute, optional explicit seed). `null`/`undefined` never coerces to seed 0. No agent, mood, director, push or Chronicle input reaches shared cloud, precipitation, fog, wind, sky, sea, grade, tint, birds or ambient particles.
- **C-W2 ground state.** `groundStateAt(date, minute) → { wetness, puddles, snowCover, frost }`, integrated only from the timeline history (today and the two previous days). It replaces the frame-dt wetness integrator, so it survives reloads and reduced motion.
- **C-W3 wind.** `windAt(worldX, worldY, tMs) → { x, gust }` is the only wind; knot `windX` carries speed by weather type. Trees, smoke, rain lean, cloud drift, flags and sea cat's paws read it.
- **Season** is the calendar token from `IsometricRenderer._currentSeasonToken` (northern hemisphere unless M9 adds a setting); it drives foliage colour, litter and blossom. **Snow — falling, on the ground or on roofs — appears only when the village's own weather produced it** (`snowCover`, timeline precipitation).
- One world-locked cloud field feeds the island composite, the sea continuation (3.4) and the Canvas `CloudShadowCourses`.

### V4 — Stepped motion and palette cycles

- One clock (`MotionClock` / `u_time * u_motionScale`); reduced motion freezes every cycle on its authored frame 0.
- **A cycle is a hard-stepped change of palette index**: the lit state of a texel is the adjacent authored ramp entry (next shallower water stop, `FOAM_CREST`, the next flame colour), never a multiply and never a crossfade (no BlendShift).
- Ambient cycles run in the slow band (≤ 8 Hz steps; water 4–6 Hz, swash 5 Hz, crests period ≥ 1.6 s). Frame 0 / the rest frame is pixel-identical to the authored art.
- **Work-coupled cycles and parts run only while their gate reads real work** through V8's `isWorkingVisitor` (a cycling Forge hearth means the Forge is working). Ambient cycles (water, wind, the Lighthouse beam) never read agent state.
- Water additionally lands on the **1-world-texel grid** (C3 water addendum): depth dither, ripples, crests, ocean band and glitter.

### V5 — The 2.5D light record and the value ladder

- Light record (`LightSourceRegistry.normalizeLightSource`): `{ x, y }` emitter (world px), `ground { x, y }` foot, `height` (world px above the foot), `normal [nx, ng]` ground-plane face normal or `null` (omni), a new `role` field (`point | aperture | fixture | attention`), `ownerId`. The existing `kind` (`point | beam | spark | arc | orbit`, `LightSourceRegistry.js:1`) keeps its meaning and its readers (`WorldFrameRenderer.js:1644`, `PostFx.js:881`, `PostFxFeed.js:69`, `BuildingSprite.js:1455`). Every light derives from an occupancy-gated source (`NightOccupancyGate`, per room once 6.3's masks exist) or a real fixture.
- Receiver geometry per GPU record (V9): foot y (−1 = ground self), `frontCorner` and `landmarkId` for landmarks, overridden by the authored occluder-B surface code where present (2.3).
- `stepPool` (`GpuWorldPolicy.js:255-269`) stays the single landing function and becomes `stepPool(graded, ambient, attention, …)`. It owns the **receiver ceiling** `RECEIVER_LUMA_CEILING = 0.74` encoded Rec.709 luma (OKLab L 0.80), applied to ambient pools only; water and wet reflection adds accumulate separately and are kneed once against the pre-loop luma; attention courses are exempt and always the brightest pool. At night, Tier A belongs to authored emitters and unresolved action-needed marks.
- Authored emitter pixels skip the time grade (1.3). Attention lights light only their own ground (never water) and their own body, and use max-not-sum.
- Consumers: the resident loop, hybrid `PostFx.applyPools`, Canvas pool stamps (ground courses only; Canvas cannot show facing or rim), wet reflections, lamp casts (2.8) and water columns (2.9) — all from the foot, never the emitter's screen xy.

### V6 — The colour script (C2b, extends C2)

- The eight key names stay (audio couples to them: `shared/audio/music/Voicings.js:49`, `shared/audio/DayArc.js:15`).
- Targets at z1, FULL, `readme-showcase`, fixed camera, world region: **golden** S ≥ 1.15× noon, key R−B ≥ +55, fill R−B ≤ −8, spread ≥ 0.9× noon, T1 top-1 % salience ≥ 20 %; **sunrise** key R−B ≤ 0.6× golden's, fill ≤ −5, spread ≤ 0.9× noon; **blue hour** Y ≥ night Y and R−B ≤ −15; **arc** Y(noon) > Y(golden) > Y(blue) ≥ Y(night) ≥ Y(deep night); night and deep night unchanged (maintainer-approved).
- **The sea follows the sky:** every water consumer (GPU water material, `CoastBake.oceanPalette`, Canvas water mood) takes its colour from the same grade; outside the sun/moon path the sea stays cool (R−B < 0) and S ≤ 0.40; the path's x is the real sky body's and its stops are the C1 `seaPath` ramp.
- Enforced by a deterministic `applyGradeToRgb` test over the C1 ramps plus the pinned capture series.

### V7 — Body placement and motion

- **Foot anchor:** every body cell (base sheet, 0.5× LOD, action strips, walk strips, future run strips) is placed by the per-direction anchor of the base sheet (`cx2` from idle row 6, `maxY` = max over rows 0–9); per-frame alpha bounds drive only the body box, labels and hit tests. New strips keep feet within ±2 px of it.
- **Speed rungs:** final travel speed ∈ {1.5, 1.125, 0.9, 0.75, 0.5625} px per 16.67 ms (legs 20/15/12/10/7.5 frames/s with integer holds at 60 and 120 Hz); order WORKING > WAITING > IDLE preserved; crowd follow gaps and congestion move whole rungs.
- **One facing writer:** a goal plus a 55 ms-per-45° stepper; reduced motion snaps.
- **One placement value:** `snapBodyPx` feeds body (Canvas and GPU record), x-ray, crowd LOD, contact shadow and rings, body box, hit testing and name anchors, so marks never detach.
- **Work facing:** working and waiting villagers face E/W/SE/SW (NE/NW only when the bearing is north); authored work strips are generated for those facings only.

### V8 — Moment staging and screen real estate

- `resolveMomentAnchor(worldPoint, { building, actorId })` in `EffectStamps.js` is the only way a C4 moment picks its screen position: never under chrome, never behind a front-sorted building footprint; clamp along the building's own screen column, else fall back to an edge plate.
- Reserved screen rects published by their owners: top bar, sidebar, activity panel, the World dock (9.1, ≈ 340×36 CSS px at the world's top-right, via `ResizeObserver`), and the lower-third caption band. T1 plates, director framing and moments treat them as occluded.
- Caption priority: incident > verified release > returned > milestone; biography banners never block the first three.
- Status wording: the call card (9.2), the top-bar lit slot and world plates share `ATTENTION_PARTS` (`TopBar.js:41-43`) and one age anchor (`SignalLedger.waitAnchor()`).
- **One predicate, `isWorkingVisitor`** (status WORKING or `tool_pending`, and not an inferred work-cycle leg, `VisitIntentManager.js:185-196`), feeds 6.1 part gates, 6.2 doors, 6.3 rooms, 6.4 smoke and the static-light and emitter boosts (`BuildingSprite.js:1443-1444, 4344-4345`). Rest-seat (7.1) and queue (7.2) occupants are excluded from every building visitor count. Plaques count non-resting bodies at their own district: a queued petitioner counts at its assigned building, not at Command. A plaque number then means work.

### V9 — GPU record layout, samplers and uploads

- **One instance per record** (B.1a lands the instanced layout before any item grows it): loc0 rect `(x, y, w, h)`; loc1 uv rect; loc2 `(alpha, material, elevation, emissive)`; loc3 `(occluder, gate, ramp, flags)` with flag bits `writesDepth | reflect | fatOptOut | screenSpace`; loc4 `(depthSortY clamped, footY, frontCornerX, frontCornerY)`; loc5 `uvec2 (ownerSlot, landmarkId)` through `vertexAttribIPointer`, passed flat. The shader derives `originFrac = fract(rect.xy)` and the record-rect clamp from loc0/loc1. WebGL2 has no base instance, so instance attributes are re-pointed per batch. Every writer, including `prenormalized` cue records (`GroundCueRecords.js:526`), supplies defaults, so no field arrives undefined.
- **Sampler table:** each program has a fixed unit table of at most 16 (`MAX_TEXTURE_IMAGE_UNITS` 16 on this machine; units 0–5 are in use today, `GpuWorldRenderer.js:1397-1411, 1535-1546`). Consider splitting `SCENE_FRAGMENT` into a terrain/water program and a sprite program that share `GRADE_GLSL` and the light loop, so the Wave 3 water samplers never sit on sprite fragments.
- **Typed-texture uploads:** the new R8, RG8, R16UI and RGBA32F fields need an upload path (`UNPACK_ALIGNMENT` 1, `texelFetch`, `usampler2D` for R16UI) and correct byte accounting; `_createTexture`/`_textureFor` upload only RGBA8 canvases and count bytes ×4 today (`:927, :1175`).
- **One channel contract** for the occluder sidecar before 2.3 or B.2 lands: R drives fog elevation today (`:366, :494`), B is reserved (`docs/material-channel-contract.md:117-126`), and both items want B.

## Ballot — how the items were chosen

Each explorer ranked up to 10 items by impact (1–5), effort and frame cost. Findings reached independently by two or more explorers were promoted:

| Finding | Reached by | Landed as |
| --- | --- | --- |
| The ladder sheds FULL with no missed frame on the main display | WPG, PB (both traced ANGLE's `QueryMtl.mm` / `mtl_command_buffer.mm`) | 0.1, V2 |
| Weather and tint driven by agent state | SW, SM, CC, CH | 0.2, V3 |
| The sea is dead on the main display | WS, AD, SW, OE, CC | 3.1–3.4, V6 |
| Palette cycling is the missing motion language | OE, PT, WS | V4, 3.1, 6.1 |
| Lights need a ground foot | LGI, OE | V5, 2.1, 2.8, 2.9 |
| Night values out of order | CH, LGI, AD | 1.2, 1.3 |
| Motion reads worse than the art | CM, PT | 0.4, 4.6, 4.7, V7 |
| Seasons invisible | TF, SW | 5.1, 5.2 |
| Ships off the grid and off the grade | WS, BL, PT | 3.8 |
| Hidden hand- and foot-height particles | WPG, CM | 0.6 |
| No display awareness in camera and layouts | CC, D, AD | 4.1, 0.9, 9.1 |
| Dawn ground haze is a smooth radial smudge | OE, AD, SW | 0.10 |
| Lighthouse beam without a source, and by day | AD, LGI | 0.8, 2.7 |
| Ground wear from real traffic | TF, SM | rejected (M13) |

Conflicts resolved during consolidation and review: PT-2 supersedes OE-3 (same fat-pixel idea, more complete); PB-4's art-resolution target is rejected because it puts moving bodies back on whole-texel steps (its attachment saving, 66 → 17 MB, is real and is left to a later memory pass); PT-4's palette-true encoding replaces WS-1's multiply-based crest lightening; the snow gate follows SW-3 rather than the calendar; TF-6 and SM-6 merge (observed tool visits only, load-time bake only); CC-6's frame-colour bands ship before D2's document View Transition, which waits for a quiet-host check; coupling sea liveliness to T1 plates (a WS question) is rejected under V3; the ladder's budget constant follows PB-1 (0.5 × period, used only as a timer veto) because WPG-1's 0.30 × period would keep the 120 Hz laptop off FULL; the ballot credits only explorers who reached a finding themselves.

## If only ten things ship

| # | Item | Why |
| --- | --- | --- |
| 1 | 0.1 Pacing-true ladder | Lamp pools stay on screen at 5120×1440 (light admission ≥ 24/12, pacing-gated); zero new work at FULL |
| 2 | 0.2 + 0.10 The village keeps its own weather, drawn on the pixel grammar | Restores a binding truth guardrail; weather variety exists for the first time, with fog and haze that are not smudges |
| 3 | 0.4 Honest villager motion | The authored animation stops shaking, skating and snapping; zero cost |
| 4 | 1.1 + 1.2 + 1.3 Colour script, night value ladder, emitters keep their light | Golden hour turns golden, blue hour blue, flames outrank what they light; zero cost |
| 5 | 3.1 + 3.2 + 3.4 Living sea, sun/moon path, weather on the open sea | 30–85 % of the main display stops being a flat fill (3.4 is real-renderer evidence: flat share 67 % → < 25 %) |
| 6 | 2.1 + 2.2 + 2.3 2.5D light | Lamps light streets, steps, decks and bodies instead of roofs and sea, cost-neutral within noise |
| 7 | 4.1 Display-aware shot scales | Ambient and openings use the frames that look best on 32:9 (priced: z2/z3 rests cost more GPU than z1) |
| 8 | 0.7 + 5.1 Sway, wind and seasons | The island stops being one frozen summer afternoon |
| 9 | 0.3 Never a black, stale or pale frame | Real black-frame recordings; S effort |
| 10 | 0.9 Ultrawide Dashboard | Every agent on one screen at 5120 instead of a 4,846-px-wide list |

Next five: 6.1 + 6.3 working architecture (after 0.6 and 0.8), 7.1 rest seats, 3.3 dressed ocean, 3.8 ships in the water, 9.2 the call card.

---

## Wave 0 — Show what exists, and stop lying (S/M; no taste debate)

### 0.1 Pacing-true resident ladder and declared light admission `[WPG-1, PB-1, PB-7, PB-8]`

Split in two so receipts are not blocked on policy: **0.1a (measurement)** — steps (4), (6), (7) — lands before any receipt in this plan; **0.1b (policy)** — steps (1)–(3), (5) — runs in parallel. Zero-cost items (constants, bakes, DOM) wait for neither.

- **Problem:** `createPostFxLadder({ budgetMs: 4, healthyMs: 2 })` (`GpuWorldRenderer.js:765-770`) sheds against ANGLE-Metal `TIME_ELAPSED`, which flushes the command buffer at begin/end and sums `GPUEndTime − GPUStartTime` (ANGLE `QueryMtl.mm:56-68,90-95`, `mtl_command_buffer.mm:681-698`). Measured: gpuMs EMA 6.48 ms at 4880×1392 for a frame whose timer-free cost is 4.02 ms; one full-screen triangle reads 0.5–10 ms. With the ladder free, dense-24 at 5120×1440 60 Hz spends 81–86 % of frames at REDUCED/MINIMAL with 8–13 level changes per 40 s, and dense-24 22:00 z2 sat at MINIMAL for a whole 60 s trace at rAF p95 16.7 ms. Promotion is timer-gated too (score < 0.75 × budget for 1.5 s, `PostFxLadder.js:60, 315-320`; the `healthyMs: 2` is never read), and boot and every Dashboard return reset to MINIMAL (`GpuWorldRenderer.js:774, 1102`), so the lamps come back ≥ 3 s after each return. REDUCED/MINIMAL cut lights to 10/4 (`:1550-1556`), outside `EFFECT_BUDGET`, so night lamp pools blink off and Shift-D never says so. Safari and Firefox run the same fixed budget on submit-CPU `cpu-fallback`.
- **Change:** (1) **Latched display period:** during the MINIMAL warm-up the renderer already runs, take p5 of the frame gaps (`GpuWorldRenderer.js:1748`, `IsometricRenderer.js:3957`), snap it to {60, 75, 90, 100, 120, 144, 165, 240} Hz, and re-latch on a screen or DPR change; drop gaps above 4× the period and clear the ring on `visibilitychange`. Never derive the period from the median of achieved gaps: a steady 60 fps on a 120 Hz panel would redefine the period and never shed. Timer veto budget `budgetMs = 0.5 × period` (PB-1: 8.3 ms at 60 Hz, 4.2 ms at 120 Hz) through a new `ladder.setBudgetMs()` in `PostFxLadder.js:351-377`. (2) **Pacing in both directions** in `advancePostFxLadder` (`PostFxLadder.js:208-329`): demote only when ≥ 20 % of the last 60 intervals exceed 1.25–1.5× the latched period **and** the timer p25 is over budget (misses with a healthy timer are main-thread-bound and shedding GPU work would not help); promote through pacing-gated upward probes (one level up; keep it if the miss share stays < 5 % over the probe window, else revert with exponential backoff); resume at the last paced level after a Dashboard return instead of MINIMAL. Today's > 35 ms gap penalty (`:112-120`) stays. (3) **"Shedding didn't help" guard on miss rate:** if the miss share does not fall across a step, revert and hold for a 60 s cool-down with exponential backoff (ends the 3↔2↔1↔0 cycling). (4) Contention-robust sample: p25 of a 30-sample ring in `_pollGpuQueries` (`:1296-1326`), begun on 1 frame in 4 (`:1795`), which also removes two forced flushes on 3 of 4 frames; expose raw EMA and p25 on Shift-D. (5) Add an `EFFECT_BUDGET` row `light-admission` (FULL 32, REDUCED ≥ 24, MINIMAL ≥ 12) and read `lightLimit` from it so `shedEffectsForLevel` reports it; this is new light-loop work at REDUCED/MINIMAL, so take gpu-burst receipts per level after it lands. (6) Port `tools/web-platform-gpu-appburst.mjs` to `scripts/world/gpu-burst.mjs` (stop the loop, render the real frame 60× back to back, drain with a 1-px `readPixels`, median of 4 reps, levels 0/1/2). (7) Rewrite the `EFFECT_BUDGET` header (`GpuWorldPolicy.js:11-30`) to the V2 receipt rule and add the K-slope and unlocked-frame arms to `scripts/smoke/world-fps-benchmark.mjs`. Update `scripts/tests/postfx-ladder.test.mjs` to the gate contract.
- **Cost:** 0 new work at FULL; re-admits existing FULL only when frames are not missed (+2.5 ms GPU at 4880×1392 z2 night, inside a 16.7 ms period); (5) adds light-loop work at REDUCED/MINIMAL. **Impact 5 · Effort M.**
- **Evidence:** WPG `proto/web-platform-gpu/ladder-*.json`, `appburst-*.json`; PB `proto/perf-budget/matrix-uwfree-*.json`, `matrix-ul-*.json`, `shots/perf-budget-02-ladder-full-vs-minimal-uw.jpg`, `-03-ladder-zoom-full-reduced-minimal.png`.
- **Acceptance:** ladder free, 180 s at 60 Hz, 5120×1440 DPR 1 and 1920×1080, dense-24 and dense-100, 12:00, 22:00 and pinned rain and storm (0.2 must have landed): ≥ 98 % of frames at FULL, ≤ 1 level change per minute, rAF p95 ≤ 17.5 ms, every active cap on Shift-D's shed line. A **GPU-side** injected load (≈ 400 extra full-screen passes in `_present`) sheds within 2 s and recovers after removal; a steady GPU-bound 60 fps on the 120 Hz panel demotes within 2 s. Headed on the 120 Hz XDR: the latched period reads 8.3 ms and dense-24 z2 22:00 holds FULL ≥ 98 % with rAF p95 ≤ 8.8 ms. A Dashboard return reaches its previous level within 1 s. Refresh rates up to 165 Hz are in scope (at 240 Hz the unlocked p95 of 5.0 ms already exceeds the 4.17 ms period).
- **Risks:** genuinely GPU-bound machines must still shed — they do, because they miss vsync; require sustained misses, not one hitch. FULL re-admits today's screen occlusion (bodies −33…−41 % lit, LGI) and blurred bloom until 2.2 and 10.2 replace them; land 2.2 in the same release if possible.

### 0.2 The village keeps its own weather; nothing in the environment reads agents `[SW-1, SM-1, CC-8, SW-8 part 3]`

- **Problem:** the seed coercion bug (`AtmosphereState.js:391-393, 483-485`) makes every date the same six knots: 84.4 % clear, 15.6 % partly cloudy, no overcast, fog, rain or storm, `windX` always +1 (the default parameter makes `undefined` coerce the same way). The only other weather is agent-driven: `WorldFrameRenderer.js:472-475` feeds `moodService` and `villageDirector` influence into `applyWeatherEventInfluence` (`AtmosphereState.js:817-847`, `cause: 'fleet'`), and `IsometricRenderer.js:3876` reads `getWeatherInfluence` too. `many-waiting` at 14:00 turns to rain and greys the village (luma 79.7 → 66.2) exactly when the operator must scan it. Director glides wash the screen red, gold or teal with a smooth radial vignette (`WorldFrameRenderer.js:1178-1228`); the Ambient chapter tints red (`CameraDirector.js:42`); the empty-village tour turns noon purple (`Camera.js:29-34`); pushes and sub-agents fire an aurora, a sky flare and a full-screen push-grade gradient (`SkyRenderer.js:182-196, 1497-1519`). Beyond weather: `SeasonalAmbience` spawns snow flurries on every Dec–Feb day except at night or in rain (`SeasonalAmbience.js:10, 27, 126-138`), so after the seed fix flurries fall on ≈ 95 % of winter minutes the village never produced; a release crown clears the gulls (`ChronicleMonuments.js:746` → `WildlifeRenderer.js:707`); a push scatters the gulls and suppresses seasonal drift (`IsometricRenderer.js:1712-1724`, `SeasonalAmbience.js:104-111`); an `untethered` push nudges fog (`IsometricRenderer.js:9636-9637`). No emitter of `git:pushed` or `harbor:push-success` exists under `claudeville/` [INFERENCE: dead listeners].
- **Change:** (1) Seed: `const seed = seedOverride == null || !Number.isFinite(Number(seedOverride)) ? hashString(…) : Number(seedOverride) >>> 0;` at both sites. The fixed code yields 38.6 % clear, 29.8 % partly cloudy, 13.3 % overcast, 13.7 % fog, 3.4 % rain, 1.2 % storm, 76 wet days a year (21 in Dec–Feb, drawn as snow). Land 0.10's fog and haze courses in the same change rather than retuning the odds twice (M3). (2) Delete the fleet path end to end: the `eventInfluence` argument and `combineWeatherInfluence` (`WorldFrameRenderer.js:467-476, 1350-1360`); the `getWeatherInfluence` read at `IsometricRenderer.js:3876`; `VillageDirector._weatherInfluence`, its snapshot field and getter (`VillageDirector.js:1404-1424, 432, 463, 721, 694-696`); `MoodService.getWeatherInfluence`/`getDistrictWeatherInfluence` (`application/MoodService.js:120-203`) and `deriveWeatherInfluence` (`domain/value-objects/AgentMood.js:267+`) if unused elsewhere; `applyWeatherEventInfluence`, `buildDistrictAtmosphere` and its buffer, the `fleet` cache-key token (`AtmosphereState.js:817-920, 1409, 1436-1441`); the fleet violet flash and district haze (`WeatherRenderer.js:255-300, 922-928, 1058-1060`); the storminess reads in `SkyRenderer._publishCalmSceneHints` (`:251-268`). (3) Delete `drawDirectorGlideGrade` and the `worldTint` cue grades (`WorldFrameRenderer.js:866, 1178-1228`; `VillageDirector.js:647, 659, 671`; `CameraDirector.js:42`; `TOUR_WORLD_TINT`/`TOUR_VIGNETTE` in `Camera.js:29-34, 1481-1489`); keep letterbox bars in neutral brass `#b8893f`. (4) Per M2, remove the push and sub-agent sky rewards from `SkyRenderer.attach`, the release-crown gull suppression, the push gull scatter and drift suppression, and the `nudgeFogIntensity` hook, and delete the dead `git:pushed`/`harbor:push-success` listeners after confirming no emitter; verified pushes already celebrate through the C4 Harbor moments. (5) `SeasonalAmbience` spawns snow only while the timeline precipitates in winter. (6) Regression tests: two dates yield different timelines; `resolveWeather` ignores any agent input; no snow particle spawns on a dry winter minute. (7) Update `docs/world-visual-qa-checklist.md` (the quota "work-weather nudge") and the `quota-rate-limit` `weather-nudge` qaTag (`WorldScenarios.js:819`); delete tests that pin fleet storms. `Camera.js`/`CameraDirector.js` edits coordinate with the camera owner (Wave 4).
- **Cost:** negative (removes the per-frame influence blend, fleet-keyed rebakes, district haze and a full-screen glide fill). Rain/storm/fog now run in production, so re-price rain at 5120×1440 z2 under V2 (area scaling ≈ 356 rain / 533 storm streaks). **Impact 5 · Effort S.**
- **Evidence:** SW `tools/sky-weather-knots.mjs`, `-timeline-fixed.mjs`, live seed-0 probe; SM `shots/signal-moments-01-fleet-weather-ab.jpg`.
- **Acceptance:** `many-waiting`, `quota-rate-limit` and `failed-push` at any hour report `cause === 'timeline'` with the same type, cloud and precipitation as `no-agents` at that minute; no glide changes frame hue; the empty tour at 12:00 clear matches the static noon hue (±2 %); a push or a release changes no sky, gull or fog pixel; `grep` finds no `cause: 'fleet'`, `eventInfluence`, `getWeatherInfluence`, `districtAtmosphere`, `triggerGullScatter` or cue `worldTint` (the word `fleet` stays legitimate in `HarborTraffic`, `TopBar` and `_fleetDistressRatio`). Across 365 dates every weather type appears within ±2 pts of the table.
- **Risks:** removes the shipped "storm = fleet struggling" idea (aesthetic plan 5.5) and the release-crown gull clearing (aesthetic 6.4), both of which the binding guardrail already forbids.

### 0.3 Never a black, stale or pale frame `[CC-2, CC-4 (S), CC-6 (A)]`

- **Problem:** (a) `App._loadRenderer` defers `_openWorld` to a rAF registered after the renderer loop's (`App.js:1511-1515`), so the first presented frame is at the pre-opening pose, `world:first-frame` fires (`IsometricRenderer.js:2716-2722`), and the fade reveals a wrong-pose frame (1.70 s DPR 1, 2.46 s at 5120, 3.70 s DPR 2). (b) Opening the Activity Panel shrinks the canvas; `App.resize` (`:1688-1760`) clears the backing store and nothing draws before present: one black frame at 1920, two at 5120, plus a sideways jump of the centre. (c) Dashboard → World shows the pale live-sky palette (1.6× the world's mean luma) for the 1.07–1.12 s rebuild. (d) World → Dashboard hides the world at ~107 ms, shows a black frame, then plays a 180 ms fade from black (`ModeManager.js:38-50`, `layout.css:64-71`).
- **Change:** (a) Gate the boot signal: `_firstFrameReason = 'boot-pending'` until `playOpeningShot` / `frameContent` / the `opening:false` path apply the opening pose; extend the `world:first-frame` payload with `{ sea, horizonY }` and paint the pre-reveal container with 4 stepped bands of the scene's own sky and sea (2×2 ordered dither at seams); before a renderer exists, the lower 63 % of the local-clock CSS sky shows the day/night sea colour instead of sky stops. (b) In the resize closure (`App.js:1745-1758`) capture `cam.currentCenterWorld()` before the surface changes, restore it after `onViewportResize()` (or preserve the follow target's screen offset), and render one frame synchronously inside the `ResizeObserver` callback through a new `renderer.renderNow()`. (c) Before the World suspends on `mode:changed → dashboard` (`App.js:1085-1093`), downsample the last presented frame to 8 row means and paint them as `#characterMode`'s stepped bands until `world:first-frame(return)`. (d) World → Dashboard: hide the world only after the Dashboard has laid out, and cut straight to it instead of fading from black.
- **Cost:** 0 (one extra synchronous render on resize; one 8×1 downsample per switch). **Impact 4 · Effort S.**
- **Evidence:** CC `shots/camera-cinema-mock-01-opening-storyboard.jpg`, `-mock-04-panel-reflow.jpg` (luma 95, 95, 1, 93 at 1920; 91, 1, 1, 92 at 5120), `-mock-05-mode-return.jpg`.
- **Acceptance:** boot recordings show no frame at a non-opening pose between first-frame and the end of the fade; container-to-first-frame mean luma delta ≤ 10; select/deselect at 1920 and 5120 keeps canvas-centre luma > 20/255 every frame with no out-and-back of the centre; World → Dashboard → World keeps mean luma within 15 % of the pre-switch frame and shows no black frame in either direction.

### 0.4 Honest villager motion `[CM-1, CM-2, CM-5, PT-1]`

- **Problem:** (1) Every body cell is placed by its own alpha bounds (`AgentSprite.js:2721, 2764-2765`; LOD `:2624-2629`), so arm swing or a lifted foot shifts the whole body: rendered head sway median/p90/max 1.7/3.2/6.3 px against authored 0.6/1.2/2.7 (≈ 10 screen px of shake at z3 p90). (2) The idle duty pause (`:2181-2192`) freezes the walk frame 50 % of every 200 ms while the body keeps moving: strollers skate ~50 %; working legs stutter on 1–5-refresh holds at 60 Hz. (3) Facing changes snap in one frame, including 90°/135°/180° (`:2226-2258`, chat start `:2036-2048`); one probe saw 63 changes with 58 A→B→A flip-backs. (4) Bodies draw at `Math.round(this.x)` — a whole world texel — while the camera rounds to backing pixels, so a walker steps {3, 6} px at k = 3 (CV 0.38) and one frame in five does not move at 120 Hz.
- **Change:** (1) `_stableFootAnchor(direction)` per V7, cached under `anchor:${direction}` in `_cellBoundsCache` (cleared on profile change at `:2601`); per-frame bounds keep driving `contentTopY`/`_setBodyBox`. Action strips and GPU records inherit it. (2) Delete the duty pause and its constants (`MotionClock.js:134-135`) and snap `_speedForState` output to the V7 rungs (WORKING 1.5, WAITING 1.125, IDLE 0.75, stroll 0.5625; mood/model/intent shift at most one rung); cap the chat approach at 1.5 and re-target only when the partner's tile changes. (3) One facing stepper (`_facingGoal`, `TURN_STEP_MS = 55`, 180° turns through the camera-facing side), a planted pivot on turns ≥ 135°, an 80 ms stop beat on a contact frame and a 60 ms start beat. (4) `snapBodyPx(v, moving, zoom, dpr)`: while moving and k = zoom × dpr is integral, `Math.round(v*k)/k`, else `Math.round(v)`; use it at `AgentSprite.js:2626-2627, 2758-2759, 3161-3162`, pass the snapped point into `resolveGroundMarks` (`:3122-3124`) and drop the rounding at `AgentGroundMarks.js:199-200` and every re-rounded per-agent anchor (e.g. `AgentSprite.js:5653, 5700`).
- **Cost:** 0. **Impact 4 · Effort S.** Bends C3 for moving bodies (M4).
- **Evidence:** CM `tools/characters-motion-sheetstats.py` → `proto/characters-motion/sheetstats.json`, `shots/characters-motion-mock-01.gif` (current vs stable), `-06.png`, `-mock-02.png`; PT `shots/pixel-technique-02-walk-kymograph-realapp.png`, `-05-snap-ab-crops.png`, `proto/pixel-technique/seq/*/trace.json`.
- **Acceptance:** rendered head range equals authored for all 26 profiles (median ≤ 0.7 px, max ≤ 2.7/3.6); ≥ 95 % of walk-frame holds equal the segment's modal hold and every frame change covers 4.5 ± 0.6 px; no frame-to-frame facing delta > 45° with motion on (reduced motion still snaps); a k = 3 walker steps {4, 5} px with CV ≤ 0.22 and no 0 px steps at a simulated 120 Hz [INFERENCE: PT simulated the 120 Hz case]; body, contact shadow and ring share a screen x every frame; a stopped body is back on a whole texel. With 2.1's rim and today's pool courses (which quantize on `floor(v_world)`, `GpuWorldRenderer.js:413-416`), sprite records quantize from their own origin (`artCell = floor(v_world − originFrac)`, V9), so a lit walker at 22:00 still shows only k×k blocks.
- **Risks:** a 1–2 px pop on walk→idle for off-centre idle art (p90 2.3 px); a 120–165 ms turn delays the visual heading on tight zig-zags.

### 0.5 Work facing: stop parking half the village with its back to the operator `[CM-4]`

- **Problem:** `_faceBuilding` aims straight at the facing point (`AgentSprite.js:2251-2284`) and most visit tiles sit south of their buildings: 51 % of stationary villagers face NE/N/NW, 11 % face the camera. Backs hide hands, tools and faces, and would hide 7.3's work strips.
- **Change:** `_workFacing(trueDir, building)` in `_faceBuilding` and the fidget re-anchor (`:2303, :2317`): N → NE or NW by the villager's side of the door, NE → E, NW → W; fidget steps never enter N/NE/NW. Chat facing is untouched. Every change stays within 67.5° of the true bearing.
- **Cost:** 0. **Impact 4 · Effort S.** Maintainer decision M20.
- **Acceptance:** after 10 s in dense-24 and mixed-tools, stationary N-facing ≤ 5 % and E/W/SE/SW ≥ 60 %; nobody faces away from its building's half-plane.

### 0.6 Hidden effects drawn: painter's depth and one instanced particle draw `[WPG-2, CM-6]`

- **Problem:** on the resident path world particles draw only when `!gpuWorldActive` (`WorldFrameRenderer.js:657-664`); the overlay replays only the `air` layer, unsorted and CPU-shaded (`:732-740`, `drawAirParticles :1146-1168`). 18–21 effects-layer particles per frame (footfall scuffs, grass motes, shallow splashes, crowd bumps, forge sparks at hand height, context sweat, recovery sparks — `AgentSprite.js:2200-2208`, `IsometricRenderer.js:4996`, `ParticleSystem.js:463-478`) are simulated and never shown. This is the aesthetic plan's open "GPU particle records" item.
- **Change:** attach a `DEPTH_COMPONENT16` renderbuffer to `sceneTarget` (`_createTarget`/`_ensureTargets`, `GpuWorldRenderer.js:932-954, 1050`), owned by `_releaseTarget`, `_abandonGpuResources` and `_updateTextureBytes`. `render()` disables `DEPTH_TEST` today (`:1793`): enable it with `depthFunc(ALWAYS)`, and at the scene clear (`:1612`) set `depthMask(true)` before clearing depth, because the particle draw leaves it false. Depth comes from V9's clamped, biased `depthSortY` (not a raw `1 − sortY/4096`, which exceeds 1 for split back parts at negative sortY, `StaticPropDrawables.js:146-147`); `writesDepth` is a per-record-kind flag (soft-alpha records — departed bodies at 0.58, archive fades, anti-aliased flags, smoke — do not write) and joins the batch key (`GpuWorldPolicy.js:584-599`); terrain, haze, ground and cue records never write. After the record loop, one `drawArraysInstanced` over ≤ 240 particle instances `{x, y, sortY, size, rgba, lit}` with `depthFunc(LEQUAL)`, `depthMask(false)`, positions floored to whole texels, lit ones through `GRADE_GLSL`, emissive ones into `outEmission` with `outEmission.a = alpha` (not the scene's `alpha > 0 ? 1 : 0`, `:504`, which would punch holes in bloom); `invalidateFramebuffer` the depth before unbinding. `ParticleSystem.spawn(type, x, y, { sortY })` defaults to `y + preset.groundOffset`; hand-height callers pass the owner's `sortY` (audit `RitualConductor`, `WorkDownbeats`, `IsometricRenderer` spawn sites), and air-layer emitters that sit on buildings — chimney smoke (`ChimneySmoke.js:89-93`), building embers (`BuildingSprite.js:760, 4381`) — pass the owner building's sortY + 1 so they do not hide behind their own roof. Delete the resident overlay replay; on Canvas, particles join `DrawablePass` as small drawables. `EFFECT_BUDGET` row `particle-depth` at every level (a substitution). Optional offset [INFERENCE]: the context omits `depth: false` (`:838-843`), so the default drawing buffer carries an unused depth buffer of ≈ 27 MB at 4880×1392.
- **Cost:** ≤ 0.15 ms GPU at 4880×1392, ≈ 0 at 1680×1032 for 240 particles including depth; +3.5 MB (1680) / +13.6 MB (4880) depth16. **Impact 4 · Effort M.**
- **Evidence:** WPG `shots/web-platform-gpu-02-forge-depth-ab.png` (pixel-identical WebGL2/WebGPU prototype on a dumped dense-24 frame); CM `tools/characters-motion-particles.mjs` census.
- **Acceptance:** the magenta probe shows non-zero magenta on resident WebGL (today 0); particles behind a building front or a nearer body are hidden, in front visible (Forge A/B); a working walker shows the same footfall as `?renderer=canvas`; reduced motion unchanged.

### 0.7 Trees sway on the resident path; one wind model `[TF-2, SW-7]`

- **Problem:** `withTreeSway` translates inside the draw function (`FoliageRenderer.js:74-102`), but `recordForProp` rasterizes that function once into a per-tree `prop-cache:fantasy.tree:x,y` texture, so on WebGL trees never move (0.02–0.11 % of pixels change over 2 s vs 11–14 % on Canvas) — and 126–144 per-tree textures cost 305–343 batches. Knot `windX` is ±1 only (`AtmosphereState.js:384`), trees oscillate symmetrically at ±1.5 px, clouds drift at a constant 6 world px/s.
- **Change:** (1) Wind per C-W3: `windX = sign × speed[type]` (fog 0.1, clear 0.35, partly 0.55, overcast 0.7, rain 0.9, storm 1.3), `windAt()` with a gust field; smoke, rain lean (`WeatherRenderer.js:547-549`), cloud-course drift (`3 + 7·|windX|`) and flags read it. (2) Baked lean frames: per sprite key, 4 frames `{0, +A, 0, −A}` by row shear (A = 1 oak/pine, 2 willow; k = max(0, (f−p)/(1−p)), p = 0.3/0.4 pine, dx = round(A·k²(3−2k)), 2 px padding), a downwind rest lean, `swayFrame(tree, tMs)` quantized with 300–600 ms holds, amplitude ≤ 1 texel below |windX| 0.6, frame 0 when `motionScale ≤ 0` or |windX| < 0.15. `GpuSceneBuilder.recordForProp` (`:567-700`) uses shared `tree:${species.size}|${variant}|${season}|${frame}` textures instead of per-tree caches; split back/front parts pick one frame per tree. Canvas draws the same lean frames instead of today's whole-sprite translate (`FoliageRenderer.js:74-104`).
- **Cost:** substitutes 144 per-tree textures (≈ 2.4 MB) with ≤ 60 shared frames (≈ 0.8 MB); CPU < 0.05 ms. The ~300-batch saving arrives only with B.1b's texture-array page, because batches break on texture key and back/front parts are not adjacent. **Impact 4 · Effort M.**
- **Evidence:** TF `tools/terrain-foliage-sway.mjs`, `shots/terrain-foliage-20.png`; SW finding 9.
- **Acceptance:** on WebGL **and** Canvas with windX ≥ 0.6, a 6-frame diff over the elderwood changes only canopy rows (none at the roots) and neighbours hold different frames; in a pinned storm trees lean downwind, smoke flattens and cloud shadows move ≥ 2× faster than on a clear day; in fog trees are still and smoke rises; every wind consumer agrees in direction; reduced motion shows the static lean.

### 0.8 Craft, contract and copy defects `[AD-6, BL-6, BL-3 part 1, CU-7, SM-7]`

- **No beams by day (AD-6):** the Pharos searchlight wedge (`BuildingSprite.js:4151-4203`, called unconditionally at `:2296-2301`) and the Lighthouse beam (`IsometricRenderer.js:9580`) draw in full daylight as flat grey haze. Draw both only when `lampCourseAt(minute, seasonShift) ≥ settling` (`GradeEvaluator.js:422-435`); there is no daytime beam. Distress stays on T1 plates, the top-bar ERROR/LIMIT parts and the C4 failure bracket (a daytime distress wedge would add sky pixels on a failed push, which V3 forbids; see M22).
- **Building-style contract and geometry validator (BL-6):** rewrite `docs/building-style-contract.md:7-9` (no "painterly" or "rim-glow"; stepped C1 ramps, 1 px selective outline, doors ≥ 1.2× the median body, unlit glass albedo, a Parts section per 6.1 and a Rooms section per 6.3). Extend `npm run world:validate-buildings`: every window or room rect overlaps ≥ 60 % emissive-sidecar alpha; strip widths equal `frames × frameW`; a part marked `restIsBase` has frame 0 equal to the base crop.
- **Archive rooms and the `at` convention (BL-3 part 1):** registry `at` means glass centre everywhere; convert the Archive rooms and `windowRects` (`BuildingVisualRegistry.js:287-290` vs `BuildingSprite.js:4765-4777`) and make `scripts/sprites/atlas-bake.mjs` read centres. The validator fails on today's Archive and passes after.
- **"No usage data" beside an estimate (CU-7):** when session-detail usage is null but `agent.tokens` has counts, render from `TokenUsage.normalize(agent.tokens)` captioned `context · from snapshot`, or hide the context stat (`ActivityPanel.js:2266-2270, 2399-2420`).
- **Grammar hygiene (SM-7):** a `limit-gate` motif (closed portcullis, 8×8) for RATE_LIMITED in `AttentionPlates` and the top-bar LIMIT part so `turn-sand` means time only (`AttentionPlates.js:47`, `AgentSprite.js:5704`); delete the `+N MORE MOMENTS` chip (`VillageDirectorOverlay.js:440-470`; buckets `VillageDirector.js:134-137, 1025-1056` if unused); at most one chip per body; the plaque solver (`BuildingSprite.js:1095-1125`) avoids T4 name rects.
- **Cost:** 0 or negative. **Impact 3 · Effort S.**
- **Acceptance:** no beam pixels between the morning and golden-hour keys in any scenario, including quota and failed-push; the validator and contract as stated; no `No usage data` beside a cost numeral in `readme-showcase`; no overflow chip in mixed-tools or team-gather and no body with two chips.

### 0.9 The Dashboard on the ultrawide `[D1]`

- **Problem:** at 5120×1440 each row is 4,846 px wide: text ends ~1,000 px in, then ~3,700 px of nothing before the numbers, and `readme-showcase` still scrolls (grid 1,813 px tall in a 1,440 viewport). At 2560 rows are 2,286 px wide.
- **Change:** in `claudeville/css/dashboard.css`, `@media (min-width: 2400px) { #dashboardGrid.dashboard__grid { display: block; column-width: 1100px; column-gap: 16px } #dashboardGrid > .dashboard__bell { column-span: all; margin-bottom: 12px } #dashboardGrid > .dashboard__section { break-inside: avoid; margin-bottom: 12px } #dashboardGrid .dashboard__section-header { position: static } }`. Reading order keeps `_sortProjectGroups` (`DashboardRenderer.js:792`) urgency top-left. Not `display: grid-lanes` (Chrome 153 `CSS.supports` false). Update the dashboard-mode README rendering contract.
- **Cost:** 0. **Impact 5 · Effort S.**
- **Evidence:** D `shots/dashboard-19-5120-dense24.jpg`, `-18-5120-readme.jpg`; real-DOM prototype `shots/dashboard-mock-01-ultrawide-readme.jpg`, `-02-ultrawide-dense24.jpg`, `-04-2560-readme.jpg`.
- **Acceptance:** at 5120×1440 and 2560×1440 DPR 1, `readme-showcase` and dense-24 show every agent without vertical scroll and no row wider than ~1,100 px; the bell lane spans the width; within-section FLIP still animates; 1280 and 1920 are pixel-identical to today.

### 0.10 Fog, ground haze and lightning on the pixel grammar `[SW-5; OE, AD and SW regression]`

Lands together with 0.2, which turns fog (13.7 % of minutes), rain and storm on for the first time.

- **Problem:** the dawn ground haze is a smooth radial stamp — a `createRadialGradient` wisp (`WorldFrameRenderer.js:1417`), an unquantized field (`:1487-1515`) and the GPU `ground:haze` record (`GpuSceneBuilder.js:337-370`) — and `groundFogStrength` (`WorldFrameRenderer.js:1475-1485`) scales with fog ×0.7 and rain ×0.45, so real weather multiplies its screen time; it reads as dawn sea blobs at z1 (`shots/art-director-12-dawn-haze-probe.jpg`, OE `outside-eye-06`). Fog bands are `createLinearGradient` rectangles (`WeatherRenderer.js:892-902`), barely visible at z2 and a pale rhombus around the island at survey. The lightning bolt is an anti-aliased round-cap `stroke()` (widths 5/2.5/1.6, `WeatherRenderer.js:943-1002`), screen-space, and in `sky-weather-11` it strikes the plaza beside a NEEDS YOU plate; the flash is a smooth diagonal gradient (`:925-930`). The sun disc still shows through a storm (alpha 0.18) and is drawn as a glossy ball with an outline ring and a specular dot.
- **Change:** ground haze and fog become quantized, world-locked stepped courses with Bayer edges and no gradient (both backends; the GPU `ground:haze` record samples the same stepped field). Replace `_drawLightningBolt` with midpoint displacement rasterized on `round(zoom)`-px cells (cream `#f4f8ff` core, `#9fb8ff` checker halo, 0–2 branches), striking only sea or sky (quarter-res water mask), ending in a stepped 2:1 splash ring. The flash becomes a C4-stepped grade scalar (0.30 peak, then 0.18, 0.12, 0.07, 0.035, a 0.16 re-strike at 470 ms) on both paths, peak luma ≤ today's. The sun disc becomes a flat-to-core stepped disc with no outline (≈ `#fff0a0` core against the ≈ `#e2a98a` 18:00 horizon) and is hidden under storm cover. Reduced motion: no strike, no flash.
- **Cost:** net ≈ 0. **Impact 4 · Effort S.**
- **Acceptance:** the canvas-call probe over storm, fog and dawn shows no `stroke()`, `createLinearGradient` or `createRadialGradient` from `WeatherRenderer`, `WorldFrameRenderer` or `GpuSceneBuilder`; the dawn haze reads as stepped courses at z1; no bolt endpoint on an island tile across 50 forced strikes; no sun disc under storm.

## Wave 1 — One colour script, one value ladder (grade constants; zero cost)

### 1.1 The authored colour script `[AD-1]`

- **Problem:** at z1 (FULL, `readme-showcase`, fixed camera) golden hour is S 0.33 vs noon 0.38 (survey 0.29 vs 0.38) although its key asks 1.06; its fill is neutral (R−B 0); the warm gain `[1.09, 0.94, 0.79]` (`GradeEvaluator.js:169`) multiplies teal water into grey-olive; 17:30 equals 18:00 because the 12:30 → 18:00 smoothstep is already at t 0.97; 06:00 twins 18:00; blue hour 19:30 (Y 52) is darker than night (64) and deep night (58) from exposure 0.64 (`:179`).
- **Change:** in `GradeEvaluator.js`: **sunrise** (`:139-147`) exposure 0.84, saturation 0.82, gain `[1.03, 0.96, 0.97]`, lift `[0.030, 0.027, 0.040]`, gamma 0.97, shadowTint `[0.88, 0.92, 1.12]`, highlightTint `[1.16, 0.99, 0.98]`; **golden-hour** (`:166-174`) exposure 0.92, saturation 1.12–1.20 (M17), gain `[1.05, 0.97, 0.88]`, lift `[0.008, 0.004, 0.020]`, gamma 1.08, shadowTint `[0.80, 0.84, 1.16]`, highlightTint `[1.26, 1.00, 0.74]`; **blue-hour** (`:177-185`) exposure 0.82, saturation 0.62, gain `[0.80, 0.90, 1.10]`, lift `[0.018, 0.020, 0.034]`, gamma 1.02, shadowTint `[0.86, 0.90, 1.14]`, highlightTint `[1.04, 0.98, 1.02]`, purkinje 0.3. Add an optional `approach: 2.4` on golden hour and return `t = smoothstep(local) ** (to.approach ?? 1)` in `gradeKeysAt` (`:230-247`), so 15:00 is 13 % golden instead of 43 % and gold arrives 16:30–17:45. Keep exactly eight keys. If lamps must carry 19:45, derive `poolGain` (`:372`) from `max(night weight, lampCourseAt)`. Add `scripts/tests/grade-colour-script.test.mjs` asserting V6 over the C1 ramps; update policy tests to the contract, not the old numbers.
- **Cost:** 0 (constants plus one `pow()` per segment, memoized). **Impact 5 · Effort S.**
- **Evidence:** AD `shots/art-director-01-contact-sheet.jpg`, `-02-colour-script-z1.jpg`, `-03-golden-hour-compare-z2.jpg`; in-engine prototype through `page.route` (`proto/art-director/`).
- **Acceptance:** the pinned series at 1600×900 DPR 2 and 5120×1440 DPR 1 meets V6; the sea region has R−B < 0 at every hour; T1 top-1 % salience ≥ 20 % at golden hour; `?renderer=canvas` follows through `applyGradeToRgb`.

### 1.2 Night value ladder: receivers stay below their sources, and keep their colour `[CH-1, AD-5]`

- **Problem:** at 22:00, brazier pool cores reach `#fffdd1` (OKLab L 0.97–0.985), equal to the flame core and brighter than the NEEDS YOU plate (`#e8d44d`, L 0.862); 75–94 % of world pixels above L 0.90 are pools and lit props, not emitters; 17,848 world pixels outshine the 1,117-pixel attention plate at 5120×1440, and pool cores clip to flat cream with no cobble texture. Pools also keep only 10 % of the receiver's colour (`mix(luma, albedo, 0.1)`, `GpuWorldPolicy.js:264`), so they render khaki on every material.
- **Change:** implement V5's `stepPool(graded, ambient, attention, …)`: attention is added outside the knee; ambient pool light gets a luma knee `ceilY = max(POOL_LUMA_CEILING, luma(graded))`, above it `y2 = ceilY + (y − ceilY)·0.25`, scaling `lit` by `y2/y`, with `POOL_LUMA_CEILING = 0.74` (today attention is summed into the pool light before `stepPool`, `GpuWorldRenderer.js:475-478 → 491`, `PostFx.js:200`, so a knee inside it would cap attention too). Water and wet-reflection adds (`:452, :470`) accumulate separately and are kneed once against the pre-loop luma (they currently enter `color` before `stepPool`, raising `ceilY` and escaping the knee via the early return at `GpuWorldPolicy.js:257`). Apply the same knee after the pilot palette-ramp path (`:482-489`). Pool chroma (AD-5): keep 0.55 of the albedo's colour instead of 0.1 (`:264`) and scale `adapt` (`:266`) by 0.6. Clamp each course of `CanvasGrade.buildPoolDodgeStamp` (`:80+`) so graded plaza × (1 + m) stays ≤ 0.74 and mirror the chroma change (a per-stamp clamp approximates the per-pixel knee; state that in the parity note). Export `RECEIVER_LUMA_CEILING` from `src/config/artPalette.js` and amend the C1 comment (V5).
- **Cost:** 0 (≈ 6 ALU in an existing call). **Impact 4 · Effort S.** Lands after 1.3's flame sidecars, or the plaza flames are capped too.
- **Evidence:** CH `shots/color-hdr-13-hi-12.png` (measured), `-mock-04-value-ladder.png` and `-mock-05-value-ladder-ultrawide.png` (**painted** mocks: L > 0.90 pixels 14,819 → 5,789, all emitters or flames; the real shader knee also restores cobble texture inside pool cores, which a mock cannot show); AD pool-chroma measurement (lit-half S 0.26 → 0.29 in the grass pool).
- **Acceptance:** 22:00 FULL, `readme-showcase` z3 (1920×1080) and `midnight-oil` (5120×1440), measured before bloom (added at `:627`): no non-emitter world pixel above OKLab L 0.84; ≥ 90 % of pixels above L 0.90 are authored emitters or flames; every T1 plate fill is brighter than every non-emitter world pixel; pool-core chroma C ≥ 0.07; pools keep radius and warmth (before/after at z2 and z3 for the maintainer, who asked for warmer pools in round 2).

### 1.3 Emitters keep their own light `[CH-2]`

- **Problem:** the C2 grade runs on the emitter's own albedo before emission is added (`GpuWorldRenderer.js:384` then `:501-502`), so the night Purkinje target and highlight tint (`GradeEvaluator.js:192-200`) turn yellow glass lime and dull the Forge fire.
- **Change:** in `SCENE_FRAGMENT` after `:385`, `emitterWeight = u_hasEmissiveMap ? clamp(emissive, 0, 1) : 0; color = mix(color, poolAlbedo, emitterWeight);` and after `:502` the hue-preserving protection `color /= max(1, max(color.r, max(color.g, color.b)))`. Script-derived sidecars for `prop.runeBrazier`, `prop.lantern` and `prop.bridgeLanternPost` (flame and glass by colour, `emissiveSidecar: true`). A deterministic recolour puts warm emissive art — including the approved Forge emissive sidecar — on `ART_RAMPS.emissive ∪ EFFECT_COLORS.work` (M15); cool families declare `emissiveFamily: 'cool'`.
- **Cost:** 0 GPU; Canvas one cached drawImage per lit building. **Impact 3 · Effort M.** $0 spend.
- **Acceptance:** 22:00 `midnight-oil` z2 on WebGL and Canvas: no warm-sidecar pixel with HSV hue 65–160°; Forge fire median hue 20–35° with S ≥ 0.75; Command and Observatory windows stay amber.

## Wave 2 — Light that lands on the street (2.5D; substitutions inside the scene pass)

### 2.1 2.5D light records and receivers `[LGI-1]`

- **Problem:** pools are 2:1 ellipses around the emitter's **screen** position (`GpuWorldRenderer.js:424-425`) and receivers are flat, so a window 40+ world px up a facade lights the wall and roof around itself (the Harbor wears three orange discs on its roofs), the Lighthouse lamp paints a ring on the sea behind the tower, and bodies are washed by whichever disc overlaps them with no lit side.
- **Change:** extend `normalizeLightSource` (`LightSourceRegistry.js:3-35`) to V5 (a new `role` field; `kind` unchanged). Producers: `BuildingSprite._staticLightSources` (`:1568-1637`) takes the foot on the landmark footprint's front edge under the source x (from `BUILDING_DEFS` through `tileToWorld`), height = foot.y − origin.y, normal (±0.7071, 0.7071) by side of the front corner; village fixtures (`IsometricRenderer.js:8944-8960`) foot = source.y + 10, height 16 (brazier) / 24 (lantern); attention lights (`:8962-8985`) foot = the sprite's foot, height 4, `ownerId` = agent. Receiver fields come from V9 (foot y, front corner, landmark id). The loop evaluates falloff between the receiver's ground point and the light foot, adds a height term, lights walls by facing and bodies with a fill on the lamp side plus a 1-texel rim (quantized from the record's origin, V9), and lands everything through `stepPool` on the existing stepped courses (`GpuWorldPolicy.js:235-242`). Canvas parity covers ground courses only; Canvas stamps cannot show facing or rim.
- **Cost:** substitutes today's per-light loop (`GpuWorldRenderer.js:417-474`); **cost-neutral within noise**: the standalone prototype measured 0.72 vs 0.76 ms at 1920×1080 and 2.52 vs 2.67 at 5120×1440 with 38 lights, but 0.89 vs 0.75 and 2.80 vs 2.74 with 26 lights (TIME_ELAPSED on a pass without overdraw, loaded host). **Before starting this Effort-L item, take a V2 K8 receipt with the prototype loop injected into the real scene pass.** **Impact 5 · Effort L.**
- **Evidence:** LGI registered same-frame buffers (`tools/lighting-gi-session.mjs`; the GLSL replica of today's loop matches the shipping frame to 0.08/255), prototype `proto/lighting-gi/` before/after stills, `shots/lighting-gi-08.jpg`, `-26-lighthouse-beam.jpg`.
- **Acceptance:** forced FULL, dense-24 22:00 z3 at the Forge (25,31) and Command (15,22), registered A/B: bodies within one tile of a lit emitter gain ≥ +50 % lit px; the Command door light lays ≥ 2 courses on its steps; zero lit sea px behind the Lighthouse; no stepped disc on any roof; ground lit coverage within ±10 %; scene pass ≤ today under V2. Canvas ground courses follow the same records.
- **Risks:** landmark art that extends past its footprint (Harbor decks, piers) reads as wall until 2.3; a body in front of a facade must use its own foot.

### 2.2 World-locked footprint occlusion replaces the screen occlusion pass `[LGI-2]`

- **Problem:** `occlusionBetween` (`GpuWorldRenderer.js:211-229`) marches three screen-space taps into the 0.375-scale occlusion target with every light at ground level; the receiver's own silhouette and the emitter's own facade always lie between them. At FULL the forge fire lights neither its arch, its anvil nor the wizards at its door (upright lit px 74,601 → 22,528, bodies 27,144 → 15,883); MINIMAL, without occlusion, lights bodies better than FULL.
- **Change:** bake once per map/scenery revision an **RG8** `footprintHeight` texture at world px/4 (≈ 820×500): R = height (building diamonds at landmark height, trees and props > 12 world px as small diamonds, bodies excluded), G = landmark id. In `SCENE_FRAGMENT`, an 8-step march in world ground space from receiver foot to light foot (REDUCED 4, MINIMAL off), ray height `mix(recvH, lightH, t)`, skipping samples within 10 world px of a fixture's foot and samples whose G equals the receiver's own `landmarkId` (V9); blocked if field > rayH + 2. Delete `_renderOcclusion` (`:1453-1468`), `OCCLUSION_FRAGMENT`, the occlusion target, `a_occluder` and the second staging copy in `_stageFrameVertices` (`:1328-1375`), and the `EFFECT_BUDGET` occlusion row. The occluder sidecar upload is gated today on occlusion or fog (`:1741, 1751-1753, 1414-1418`); gate it on the local-light phase instead so 2.3's surface data is present at MINIMAL (which still ships ≥ 12 lights).
- **Cost:** substitutes the occlusion pass (−967,680 B of target) with a ~0.8 MB static RG8 bake; the march measured +0.05–0.17 ms inside the loop (prototype, standalone; take a K8 receipt in the real pass). **Impact 4 · Effort M.**
- **Acceptance:** body lit px near the Forge door ≥ 95 % of occlusion-off; a brazier behind a building wing leaves a stepped shadow on the street in front; the occlusion pass is gone from Shift-D; roofs stay unlit at MINIMAL.

### 2.3 Landmark surface channel: height above ground and a 2-bit face class `[LGI-3]`

- **Problem:** horizontal surfaces baked into landmark sprites (Harbor decks and piers, Command steps, Observatory stairs) cannot be told from walls by any screen or footprint rule — the wall OF-010 hit. The shipped occluder R is a fake row ramp, or zero on 4 of 9 landmarks.
- **Change:** under V9's one channel contract (agreed before 2.3 or B.2 lands), `scripts/sprites/bake-surface-channel.mjs` writes `B = face·64 + min(63, round(heightAboveGround/4))` into the occluder B channel (`docs/material-channel-contract.md:117-126`), face 0 up/apron, 1 left, 2 right, 3 roof; R becomes true height/255, so the fog elevation that reads R (`GpuWorldRenderer.js:366, 494`) is retuned in the same change. Hand-correct Harbor, Lighthouse, Observatory and Portal (decks, piers, stairs = up). `SCENE_FRAGMENT` reads it where `geometry.a > 0` and overrides 2.1's analytic landmark geometry; `atlas-bake.mjs` copies B. 5.2's roof snowcaps read face class 3 instead of adding a separate `roof` material class.
- **Cost:** baked (a channel of a texture already fetched). **Impact 4 · Effort M.** 0 generations; ~1–2 h hand touch-up per complex landmark (M5).
- **Acceptance:** `storm-night-reduced-motion` and dense-24 22:00 at forced FULL: Harbor decks and piers take stepped light and roofs stay unlit; the sprite audit reports no landmark with an all-zero occluder R/B.

### 2.4 Aperture lights from the emissive sidecars, with a clustered light list `[LGI-4]`

- **Problem:** light comes only from hand-placed registry points; lit windows, the Task board lanterns and the forge's secondary openings light nothing, and the feed drops lantern halos first (`PostFxFeed.js:10, 345-370`). At 5120×1440 the 32-light resident cap is hit.
- **Change:** extract per-landmark emitter blobs from `base.emissive.png` at load (A > 0.1, 4-connected, area ≥ 10 px) into templates, each tagged with its room index from 6.3's room masks (baked in this wave, after 0.8's `at` fix); `getLightSources` emits them with `role: 'aperture'`, intensity `min(1.2, 0.5 + area/400) · energy.core · roomGate(building, room)` (the per-room occupancy gate, so a dark room lights nothing), radius `min(106, 30 + 2.2·√area)`, skipping blobs within 30 px of a registry point. Replace the uniform arrays with an RGBA32F light texture (≤ 256 lights) and CPU binning into 64×64-px tiles (≤ 16 per tile; attention > aperture > fixture) in an R16UI index texture (V9 upload path). Land only after 0.1 and 2.1 are measured: WPG found only 9–16 low-rank lights dropped today, so the clustering must pay for the added apertures.
- **Cost:** ~0.05–0.1 ms CPU binning [INFERENCE]; GPU falls to local density. **Impact 4 · Effort M.**
- **Acceptance:** dense-24 22:00 z2 at 5120×1440: every visible source admitted, scene pass ≤ today under V2; every window with gated emission lays a stepped course in front of its face; a building without a real worker has none.

### 2.5 Truthful attention light `[LGI-5]`

- **Problem:** the attention light (`ATTENTION_LIGHT_STYLES`, `IsometricRenderer.js:150-154, 8962-8985`) lights any fragment in its screen radius, so a neighbour's robe or a wall takes waiting-amber or error-red — a status that neighbour does not have — while the agent's own body is self-occluded.
- **Change:** apply attention lights only to ground/apron fragments and fragments whose record `ownerSlot` matches (V9's integer owner slot, not a float hash, which collides beyond 2^24), and never to water receivers (material 8), so an errored agent on a pier does not tint the sea; keep max-not-sum; attention is exempt from 1.2's receiver knee, so the attention course is always the brightest pool.
- **Cost:** 0. **Impact 3 · Effort S.**
- **Acceptance:** `many-waiting` and `team-gather` z3 at FULL: no non-owner body or wall within 40 world px changes hue versus attention-light-off; the owner's hem gains ≥ 1 course; every non-attention pool stays below the attention course.

### 2.6 Fire breathes in stepped quanta `[LGI-6]`

- **Change:** fire-kind sources (forge door/spill, village and gate braziers) multiply intensity by `[0.86, 0.94, 1.0][hash(floor(t/140 ms), sourceId) % 3]` instead of continuous sines (`BuildingSprite.js:1499, 1540`); declared as an ambient fire band in `docs/motion-budget.md`; forge heat stays `_forgeGlowIntensity`-driven; windows, non-fire sources and attention lights never flicker; reduced motion holds 1.0.
- **Cost:** 0. **Impact 3 · Effort S.** **Acceptance:** a 10 fps Forge capture shows course boundaries stepping between three states with no ramp; reduced-motion frames byte-identical over 5 s.

### 2.7 The Lighthouse in pixel grammar `[LGI-7, AD-6]` (M22)

- **Problem:** the lamp pool (radius 65, intensity 1.61) rings the sea behind the tower in screen space; the searchlight is an anti-aliased overlay wedge clipped to the sky, mostly off-frame, lighting nothing, and it draws by day (0.8). Its colour and sweep speed follow fleet distress today (`_fleetDistressRatio`, `BuildingSprite.js:793-817`; the sweep runs at lerp(0.45, 1.7 rad/s, distress)), so errored agents speed up a beam over the sky and, once it touches the water, the sea.
- **Change:** the lamp becomes a 2.5D emitter (foot at the tower base, height at the lantern), lighting only the gallery masonry facing it and a faint base course. Draw the beam in `COMPOSITE_FRAGMENT` (`GpuWorldRenderer.js:568-628`) as a world-locked fan (pivot, sweep angle, length 320, far width 58) in 3 `SEARCHLIGHT_COURSES` with an ordered-dither edge on the world texel grid, additive only on sky/void pixels, at night only (0.8), in a fixed calm amber at a constant 0.45 rad/s; the water dash cells under its ground footprint take their lit phase as an ambient cycle that reads no agent state. Delete the overlay `fillConvex` wedge and the distress mapping (M22; distress stays on T1 plates, the top bar and the C4 bracket).
- **Cost:** ~0.05 ms in the composite [INFERENCE], substituting the overlay fill. **Impact 3 · Effort M.**
- **Acceptance:** Lighthouse at z2 22:00: no lit sea px behind the tower; three stepped courses with integer-texel edges and a moving dash sheen on the water; the beam's colour and speed are identical in `no-agents` and `failed-push`; static under reduced motion; no beam by day.

### 2.8 Night lamp casts: villagers throw shadows away from real lamps `[OE-2]`

- **Problem:** at night a body standing in a warm pool throws nothing: `RakingLight.villagerCastStamps` (`RakingLight.js:305-311`) returns `[]` when rake = 0. Point-light character shadows are the core of Octopath's and Sea of Stars' night look.
- **Change:** `pointCastStamp(contactWidth, angleBucket, reachBucket, alphaBucket)` in `RakingLight.js`: a 3+ ellipse `castTrail` via `rasterizeCourses` (rx 9 → ≈ 6, ry 3.2 → ≈ 2.4 texels), colour `[22, 16, 26]`, ⅛-stepped alpha, LRU ≤ 256 keys. In `AgentGroundMarks` (`:103-110`), when rake is 0 and the local-light phase is visible, choose the strongest non-attention ambient light whose radius contains the body (iso distance, from the light's **foot**, V5), angle in 1/16-rad buckets, reach `clamp(round((18 + 60·d/r)/4), 3, 14)`, alpha 4–6, hysteresis 0.15 against flip-flopping between lights; Canvas draws in the ground pass, GPU through `GroundCueRecords`; cap under crowd pressure; the strongest course wins, never a double darkening.
- **Cost:** ~0.05–0.15 ms CPU at dense-24 (≤ 24 cached stamps). **Impact 4 · Effort M.** Depends on 2.1.
- **Evidence:** OE `shots/outside-eye-mock-03-lampcast-pair.jpg` (real renderer, 13–14 casts per frame).
- **Acceptance:** at 22:00 bodies in a brazier or lantern pool show a stepped trail pointing away from its foot, correctly depth-sorted; none by day; attention lights never cast; Canvas and GPU match.

### 2.9 Night window and lamp columns on water `[WS-6]`

- **Problem:** the resident water reflection term is `smoothstep × reflectionCourse × 0.10` per light (`GpuWorldRenderer.js:449-453`) — anti-aliased and invisible; the Canvas `_drawBuildingLightReflections` (`IsometricRenderer.js:8084`) never runs on WebGL. A fully lit Harbor at 22:00 puts no warm light on the water.
- **Change:** for water receivers below and within 1.8 × radius of an admitted light: column half-width `(2 + floor(d/24))` texels, row wobble `floor(1.5·sin(row·0.7 + tick))` texels, lit on `mod(row + tick, 3) < 2` (broken rows), courses 0.8/0.55/0.3 by `floor(d/24)`, add `color · course · w · 0.45` emissive-exempt through 1.2's separate reflection knee, clipped by 2.2's blocked term; only lights whose room gate is lit (2.4); never attention lights; the Lighthouse beacon gets 2× reach; reduced motion freezes the tick on a static column.
- **Cost:** substitutes the existing term. **Impact 4 · Effort S.** Depends on 2.1.
- **Acceptance:** 22:00 `git-harbor` z2/z3: a broken warm column of ≥ 3 courses with whole-texel wobble under each lit window over water; absent when the room or building is unoccupied. Golden-hour raking casts on water stay at ≤ 35 % strength and are broken by the ripple rows (WS contract), instead of lying on open sea as hard parallelograms.

### 2.10 Ground-plane radiance cascades and one warm bounce (optional, after 2.1–2.4) `[LGI-8]`

- **Change:** a 2D radiance-cascade solve on the **world ground plane** (≈ 820×500, 4 cascades, base 4 rays, the Osborne–Sannikov bilinear fix), emitters from 2.1 feet and 2.4 blob projections, occluders from 2.2's field, one bounce of ground albedo × irradiance, recomputed only on light-state change (≤ 4 Hz), sampled at each fragment's foot and capped at course 1 before `poolSteps` so bounce never outshines direct light. Screen-space RC on the iso frame is rejected (it reproduces today's self-occlusion).
- **Cost:** ~0.3–1 ms per update, amortized 0.05–0.25 ms/frame [INFERENCE]; 3–6 MB RGBA16F. **Impact 3 · Effort L.** Not prototyped; a pilot must show a soft stepped fan at the forge door and ≤ 1 warm course on walls facing a lit plaza before it lands.

## Wave 3 — A living sea (water fills 30–85 % of the main display)

WaterSea's all-effects prototype measured +1.3–1.7 ms per 7.4 Mpx of pure water on the loaded host and put 3.1, 3.2, 3.6, 2.9 and 3.9 together at ≈ +0.3–0.6 ms at FULL [INFERENCE]; price them on the cumulative shader under V2. The water samplers (cycle offset, coast field) belong in V9's sampler table, ideally on a terrain/water program separate from sprites.

### 3.1 Palette-true water cycle on in-map water `[PT-4, WS-1 in-map part]`

- **Problem:** deep water is one flat navy: the dash contrast is scaled to ≈ 1.5 % at the deep stop (`GpuWorldRenderer.js:307-313`); over 2 s, 0.6 % of harbor deep-water pixels change at noon and 0 % at night. Shallow water animates as random 3×1 dashes brightened by `× 1.10–1.16` (`:292-316`), which produces off-palette colours with no direction.
- **Change:** in `CoastBake.js`, bake a world-space R8 **cycle-offset** field from `signedDistanceAtWorld` (`:398`): where 0.09 < sd < 2.2, `offset = floor(sd·9 + hash(cell)·1.2) mod 16`, else 255; along authored river and canal axes, a current group whose offset advances along the channel instead (PT-4's channel option), so the river keeps a flow cue when 3.12 retires `_drawAnimatedCurrentBands`; upload once per coast key beside `u_paletteLut` (`GpuWorldRenderer.js:1536`) through V9's typed upload path. In `applyWaterState`, near-shore dashes light when `course[(off + phase) & 15]` hits {14, 15}, so swell moves toward the shore in 250 ms steps; beyond it, the deep-sea swell phase field `ph = fract(dot(p, (0.5, 1.0))/22 + 0.35·sin(p.x·0.031) + 0.2·sin(p.y·0.07 + p.x·0.013))` over world texels, 16 steps at 6 Hz (2.7 s period), broken 3×1 dashes (density 0.35 shallow / 0.5 deep), lead crest and a Bayer half-lit trail. **A lit texel takes the next shallower `COAST_WATER_STOPS` colour (or `FOAM_CREST` on the two shallowest stops), never a multiply** (V4); a texel is a stop only by exact match of its **ungraded** albedo against `COAST_WATER_STOPS`, and everything else (reflections, dither, foam, flight-frame blends) is skipped. Remove the deep-fade clamp for crests. Storm (`u_weather.z ≥ 0.5`) shortens the wavelength to 14, raises density to 0.7 and turns every 4th crest cell to `FOAM` (whitecaps, from real weather). Reduced motion freezes on today's static frame.
- **Cost:** substitutes the hashed dash term; one R8 fetch and ~12 ALU on water fragments; 0.8 MB R8 (100 KB at dash-cell resolution). `EFFECT_BUDGET` `waterCrests` FULL/REDUCED, frozen at MINIMAL. **Impact 5 · Effort M.** Bends the "animated wave shader" kill (M7).
- **Evidence:** PT `proto/pixel-technique/color-cycle.html` (real C1 ramps and CoastBake classes); WS `shots/water-sea-20/21/22-uw-z1-*.jpg`, `-02-harbor-z2-noon.jpg`, prototype `proto/water-sea/water-sea-proto-noon.png`.
- **Acceptance:** fixed-camera 2 s screencasts of `git-harbor` z2 at 12:00, 22:00 and storm: the per-step (not per-frame) changed share of deep-water boxes is 2–5 % (PT measured 2–3 % per 250 ms step as calm) and the share that ever changes over 3 s stays ≤ 35 % (WS called 45 % too busy; M7 sets the final band); lit dashes advance one band toward the waterline per step; every water pixel's ungraded albedo is a C1, CoastBake or `seaPath` colour; the river shows a downstream current; no seam at the map-edge diamond; reduced motion identical to today.

### 3.2 Sun and moon path across the near sea and the ocean `[WS-2, AD-2 (c)]`

- **Problem:** golden hour, the most cinematic moment, has a darker, greyer sea and no warm path; glints exist only in a 70-row column inside the horizon band (`CoastBake.js:1228-1248, 1302-1308`), visible only when the horizon is in frame; the moon path was never built (aesthetic record).
- **Change:** source of truth `atmosphere.sky.sun|moon.{visible, xFrac}`. Sun when visible and cloudCover < 0.7; moon when visible, `moonFill ≥ 0.5` and clear. Uniform `u_glint = (screenX, strength, kind, grow)`, strength 1 near sunrise/golden hour falling to 0.35 at noon (a broad sparse sparkle), moon strength = `moonFill`. On water fragments after the crest step: half-width `5 + screenY·0.12/zoom` texels, sparse hashed 3×1 dashes on the shared tick, two stops (gold `[236, 176, 104]`/`[196, 128, 84]` at golden hour, pale by day, silver `[196, 214, 226]`/`[132, 154, 176]` at night) registered as the C1 `seaPath` ramp; the stops are graded, pass through 1.2's reflection knee and stay at HSL L ≤ 0.70 on screen (the raw silver is L 0.83). On the outer ocean, extend the glint strip from the horizon to the view bottom under the body's screen x (width 30 → 260 world px, speck probability ≤ 0.22 × (1 − |dx|/halfWidth)) as one extra drawImage of a baked tall strip, rebaked with the ocean key. The path follows the sky body's **screen** x, so it behaves like a specular path under pans. Reduced motion: a static speck set.
- **Cost:** ~8 ALU replacing `u_waterSilver` (`GpuWorldRenderer.js:317-321`) plus one drawImage; `EFFECT_BUDGET` `glitterPath` FULL/REDUCED, static at MINIMAL. **Impact 5 · Effort S.**
- **Evidence:** WS `shots/water-sea-04-harbor-z2-golden.jpg`, `-21-uw-z1-golden.jpg`; AD `shots/art-director-mock-03-*` (painted over real 5120×1440 captures).
- **Acceptance:** dense-24 z1 at 5120×1440, 17:36 clear: a continuous path of warm dashes under the sun's x from the horizon to the frame bottom, crossing the map-edge seam without a gap; 22:00 with the moon ≥ half: a silver path; none under full cloud or when the body is hidden.

### 3.3 A dressed outer sea: shelf stops, swell, 1-texel grid, the horizon takes the sky `[AD-2 (a, b), AD-4, WS-11, WS-1 ocean part]`

- **Problem:** below 300 world px from the horizon the ocean is one flat fill (`CoastBake.js:1310-1314`): 37 % of the survey frame, 44.5 % at 5120×1440 tier 1 and 30 % of the default tier-2 boot is texture-free. Coast colour decisions run on 2-world-px cells and the ocean band texel is 4 world px (`:540-558, :1072`), so at z3 DPR 2 the depth dither shows 12–24 px blocks beside 6 px sprite texels, and the shelf handover leaves dotted seams. At 18:00 the sky (`#c09878`) sits over a sea (`#465751`) with a haze band only 16–24 world px deep (`:1200-1210`).
- **Change:** (a) `bakeSeaTile(state, spec)`: a world-anchored tile on the 1-texel grid from the graded `oceanPalette` (`:1117-1156`), large enough not to repeat visibly across a 5120-wide z1 view (a 512-px tile repeats ≈ 9.5×; use a period ≥ 2× the widest world viewport or an offset second octave): 3 stepped depth stops lightening toward the island (continuing the outer-shelf field of `:562-601`), Bayer per world texel, sparse 2:1 swell dashes (10×5 cells, one 3–5 px dash, presence 0.10 far → 0.45 near shore). (b) **Preferred route:** sample that tile in `COMPOSITE_FRAGMENT` for `scene.a == 0` pixels below the horizon (world-locked, on the shader's clock, under 3.4's cloud multiply and 4.6's sub-pixel offset), keeping the 2D backdrop for the sky, the horizon band and the Canvas fallback; this removes the hue step at the coast (3.4) and the ocean slipping against in-map water while the GL layer moves (4.6). Fallback route: `drawOuterOcean` (`:1275-1316`) replaces the deep fillRect with a world-anchored `createPattern` fill and the backdrop takes the unrounded camera offset. (c) Colour decisions per world texel (`bayer(worldX, worldY)`, bilinear signed distance across the 2 px cell), `OCEAN_TEXEL = 1`, and the last shelf stop clamped to `oceanIndexAt(wy)` at the handover (`:594-598`). (d) A sky-reflection band 24–40 texel rows below the haze mixing the C2 horizon colour into the water stop in 4 courses (0.45/0.30/0.18/0.08, Bayer transitions), broken on swell rows. (e) Per M7, ocean crests use 3.1's 16-step phase on the **shader's clock** (`feed.timeMs % 1e6 × motionScale`, `GpuWorldRenderer.js:1541-1543`), not `performance.now` (`CoastBake.js:1279`); on the fallback route bake 16 phase variants one per frame, never 8 in one burst (a dusk hitch under the 900 ms throttle, `:1083`).
- **Cost:** substitutes the flat fill with one pattern fill (+ phase selection); bake ~2–5 ms per palette bucket [INFERENCE] on the existing ≥ 900 ms rebake throttle; coast colour pass 2–4× once (re-measure; if > 150 ms, 1-texel only within 3 tiles of shore). **Impact 5 · Effort M.**
- **Evidence:** AD `shots/art-director-07-ultrawide-sheet.jpg`, `-08-water-lattice-night-z3.png`, `-09-sea-seams-survey-noon.png`, `-mock-03-*`; CH `shots/color-hdr-08.png` (horizon seam); WS addendum WS-11.
- **Acceptance:** at 5120×1440 tier 1 and DPR-2 survey, 12:00/18:00/22:00: stepped shelf stops around the island, no dotted seam and no hard-edged dark wedge under the Harbor at the shelf (AD regression 5, [INFERENCE] a 3.7 reflection clipped at the shelf), water colour runs are multiples of the world texel at z3, no visible tile period, the pattern never swims on pan or glide, ocean crests line up with in-map crests at the map edge, the golden-hour horizon shows 4 warm courses fading into the sea; Canvas paints the preimage (`ungradeRgb`, `:1145-1149`).

### 3.4 Weather on the open sea `[SW-2]`

- **Problem:** the composite shades cloud courses only where `scene.a > 0` (`GpuWorldRenderer.js:597`), so at 5120×1440 z1 partly-cloudy noon 67 % of the world viewport is a single sea colour while the island carries cloud shadows.
- **Change:** in `COMPOSITE_FRAGMENT` (`:593-628`), for `scene.a <= 0` below `OCEAN_HORIZON_WORLD_Y` (uniform) with cloud cover, compute the same world position and sample `u_cloudTile` exactly as at `:606-608`. On 3.3's preferred route apply the same tinted multiply the island uses (`(1, 0.96, 0.84)`, `:610`); premultiplied black over a 2D backdrop can only darken by a scalar and leaves a hue step at the coast. Break the 1024-world-px tile period (`GpuWorldPolicy.js:300-303`), which repeats ≈ 4.8× across a 5120 z1 frame: sample a second time at ×1.73 scale with a (317, 911) offset and take `max(n1, n2·0.9)`, or bake a 512² R8 tile. Add a sunlit course where the noise is lowest (sun on water), wind-driven cat's paws from C-W3 (a 128² gust field; darken 7 % and scatter hashed 3×1 lighter dashes on the art grid, sea only), and a forecast squall: when the timeline's next knot is rain or storm and the transition is 35–50 % through, one world-anchored dark course patch with 2-px streak columns drifts in from the upwind sea and becomes the rain when the type flips (the timeline's own future, so truthful). ≤ 2 shadow courses on the dark sea. Canvas: `drawCloudShadowCourses` covers the visible sea rect below the horizon, not only the island diamond (`IsometricRenderer.js:9180-9186`). Reduced motion: frozen offsets, as for today's island courses.
- **Cost:** ≈ 1–2 fetches per sea pixel inside the existing composite; SW's live A/B returned before bloom and was priced with the gpuMs EMA, so take a V2 receipt. **Impact 5 · Effort M.** Depends on 0.2 (cloud cover must vary).
- **Evidence:** SW live prototype `tools/sky-weather-route-seashadow.mjs` (a 14-line patch served through `page.route` into the real renderer).
- **Acceptance:** at 5120×1440 z1 partly-cloudy noon, pixels within ±4 of the flat sea colour fall from 67 % to under 25 %; no visible tile period across the frame; cloud edges cross the coastline with no seam and no hue step; a pinned rain knot shows its squall approaching before it rains; Canvas shows sea shadows.

### 3.5 Shoreline mass on the SW/SE edges `[AD-3]`

- **Problem:** the two camera-facing edges read as a cut board: a ruler-straight 2:1 sandstone band with ±1 px wobble, a dotted foam line and reflection alphas of 0.1875/0.125/0.0625 (`CoastBake.js:778-849, :843`). 3.5 shipped but under-delivers; at DPR 1 z1 the SW edge is one tan line against dead sea.
- **Change:** in `drawStratifiedCliff`: vary `CLIFF_FACE` 34 (`:65`) by ±8 world px on low-frequency value noise; a boulder revetment after the wet foot (overlapping 2:1 boulders rx 3–5, ry 2–3, 60–80 % coverage, hash-seeded, `ART_RAMPS.stone` with upper-left lit texels and a dark-warm rim), the waterline following the lowest boulder texel per column; surf lace hugging the boulder bases; the face reflection uses `REFLECTION_ALPHAS` (already 0.42/0.28/0.16 at `:70`) instead of the literals 0.1875/0.125/0.0625 at `:843`, including boulders and a palisade band, every 3rd row dropped; one shallow stop dithered out over 4 texels. Skip columns under building footprints and the Harbor slip.
- **Cost:** baked. **Impact 4 · Effort M.** Optional 60–160 generations for boulder objects if the procedural stones fail review.
- **Acceptance:** the SW/SE waterline varies ≥ 6 world px along any 4-tile run; boulders and foam visible at z2; face reflection visible (mean |Δluma| ≥ 6); `world:validate-terrain` passes; walkability unchanged.

### 3.6 Lapping foam and a drying wet band `[WS-5]`

- **Change:** pack a coast-field texture at the coast lattice (1536×768, R = clamped signed distance, G = flags: reflection cell, breaker-eligible) uploaded once per coast bake with a `u_coastRect` transform. Terrain fragments inside the rect run an 8-step swash cycle (`floor(u_time·0.005·u_motionScale) % 8`: in 4, out 3, hold 1, ≈ 1.6 s): foam where `sd < 0.05 + reach·0.035`, a wet-sand band darkening and drying in 2 steps behind the retreating front, never on road, plaza or footprints; others early-out. Static swash at MINIMAL and under reduced motion.
- **Cost:** R8 1.18 MB (RG8 2.36 MB) against OF-012; 1 fetch + ~10 ALU on terrain fragments inside the coast rect. **Impact 4 · Effort M.**
- **Acceptance:** lagoon z3 screencast: the foam front moves through 4 whole-lattice steps and back in ≈ 1.6 s; the wet band darkens and dries in 2 steps.

### 3.7 Full-colour baked reflections of everything static at the water `[WS-3]`

- **Problem:** 3.7 reflections are a darkening only (`CoastBake.js:629-702`) for three landmarks — 3,486 of 223,754 water cells — and read as cast shadows, not mirrors.
- **Change:** `staticReflections(renderer, coast)`: every static sprite whose base is within 1.5 tiles of water with `sd(base) > −0.3` (buildings, trees from `FoliageRenderer`'s caches, buoys, mangroves, driftwood, the net rack, bridges, dock and causeway tiles), mirrored about its own base line (the existing per-column axis at `:658-688`), stored as `mix(stopColour, src·0.72, a)` in 3 alpha courses with broken rows; the water shader adds a whole-texel row ripple on reflection cells (3.6's G flag), frozen under reduced motion.
- **Cost:** baked, plus 1 fetch and ~6 ALU on reflection cells. **Impact 4 · Effort M.**
- **Acceptance:** lagoon, Command pond and Harbor at z2/z3 noon show recognisable colour mirrors of willows, bridge, piles, Harbor and Lighthouse; no reflection behind land.

### 3.8 Ships belong to the water `[WS-4, BL-7, PT-6]`

- **Problem:** Harbor traffic replays on the ungraded overlay and ignores `context.ungradedOverlay` (`DrawablePass.js:402-404`; hull luma 135 at golden hour, rain and storm alike); ships draw at 0.64–0.90× with a continuous ±1.5–2.9° `ctx.rotate` roll (`HarborTraffic.js:107-122, 5169-5193`), so texels come out 1–3 px wide; wakes are dead code on WebGL.
- **Change:** re-author each hull at its current on-screen size at `scale: 1` (flagship 92, dreadnought 84, galleon 77, brigantine 72, sloop 67, cutter 63, skiff 52, stacks 180/162/144/106/83 px), quantized to ≤ 24 colours on the timber/cloth ramps; bake five roll frames (−3°, −1.5°, 0, +1.5°, +3°) with cleanEdge at one output px per texel through a dev script (frame 0 = the authored sprite); pick `clamp(round(roll/1.5°), −2, 2)` with no rotate or scale; bob stays a whole-texel translate; retune formation spacing, `labelLift` and `flagOffset`. **Per M23, hulls become resident GPU records in this item** (not an overlay replay): `HarborTraffic` emits them through the scene-category `emitSceneCommands` path as V9 records with a drawable `sortY`, so they take 0.6's painter's depth, the scene grade, 2.1's lamp light, casts and 2.2's occlusion, and the per-(sprite, grade-key) tinted canvases are not needed; the Canvas fallback keeps cached tinted canvases (the `WildlifeRenderer` pattern). Reflections are V9 `reflect` records like 3.11's (mirrored at the waterline, row ripple, water-only discard via 3.6's texture), a 1-px waterline lip is baked into each hull, and V wakes are `EffectStamps` stamps aging out in 4 steps. `prop.flowerCart` draws at 1× (re-author at 32 px or use the 64 px source). Ship label plates move above or beside the hull. The same cleanEdge-at-1× bake replaces the other runtime rotations: the Codex weapon rotation cache (`AgentSprite.js:3618-3645`) and the Observatory clock spin (baked frames).
- **Cost:** ≤ 12 hull records plus ≤ 12 reflection records on the resident path, substituting the per-frame overlay rotate/scale draws. **Impact 4 · Effort M–L.** ≤ 40 generations (Phase B of the spend plan), or the free `pixelart_workbench` plus hand cleanup. Depends on B.1a/V9 and 0.6; lighting arrives with Wave 2.
- **Evidence:** WS `shots/water-sea-05-harbor-z2-night.jpg`; PT `shots/pixel-technique-ship-zoom.png`, `-mock-05-roll-bake-1x.png`; BL F9 survey.
- **Acceptance:** `git-harbor` at 22:00: hull luma within ±10 % of the Harbor's unlit timber, 12:00 unchanged (±3); a hull near a lit lantern takes a stepped course on its lamp side (after 2.1); a hull behind the Harbor deck is occluded by it; a departing ship shows a V wake; every hull has a reflection and a waterline; at k = 3 every ship texel is k×k; no `ctx.rotate` or non-1 scale remains in ship or flower-cart drawing (validator); `?renderer=canvas` shows graded hulls.

### 3.9 Rain rings on water `[WS-8]`

- **Change:** in `applyWaterState`, while precipitation > 0: 12×6-texel cells (8×4 in storm) active when `hash(cell) < 0.55·precipitation`, a 5-stage life (dot → pair → 2:1 ring outline → none), one ramp step lighter than the local stop; reduced motion shows a fixed 20 % static ring set. Rain splashes stay off water (`AmbientGround.js:50`) and rings stay off land. `EFFECT_BUDGET` `rainRings` FULL/REDUCED, static at MINIMAL.
- **Cost:** ~10 ALU on water fragments only while raining. **Impact 3 · Effort S.** **Acceptance:** 12:00 rain z2: rings on harbor, lagoon and river, none on land; density scales with precipitation; zero in clear weather.

### 3.10 Shallows you can see into `[WS-9]`

- **Change:** bake 2×1 seabed specks (SAND[0] at 30 %, density 0.04) into stops 0–1; add a caustic net `step(0.92, fract(v1 + v2))` from two opposing iso phase fields (wavelengths 9 and 13, 4 Hz, 8 phases) at half a ramp step on stop-0/1 fragments, only on clear days (sunBand > 0.3, cloudCover < 0.5), off at night, in rain and at MINIMAL; consider zoom ≥ 2 only.
- **Cost:** baked plus ~6 ALU on shallow fragments. **Impact 2 · Effort S.**

### 3.11 Moving things reflect `[WS-7]` (M11)

- **Change:** for bodies whose feet have `sd > −0.3` (piers, bridges, banks; typically 0–10), emit a duplicate albedo record with V9's `reflect` flag in the ground band, mirrored about the record base in the vertex shader, discarded off water via 3.6's texture, with ±1-texel row ripple (frozen under reduced motion), every 5th row dropped, 3 Bayer alpha courses and 38 % toward the local water stop. Labels, rings, plates and beacons are never duplicated. Cap 12, nearest to camera centre; FULL only.
- **Cost:** +N records, no render target. **Impact 3 · Effort M.**

### 3.12 Canvas water parity and dead code `[WS-10]`

- **Change:** after 3.1–3.9, rebase the Canvas water on the same bakes and cycles (8 cached crest overlays, 4 foam states, the shared wake painter, the glitter strip, cached ring stamps); delete `_drawNightWaterReflections`, `_drawSeaGlitter`, the screen-shimmer loop (`IsometricRenderer.js:7670-7697`) and the dead `HarborTraffic._drawWake`/`_drawDockedShipWake` unless reused; retire `_drawAnimatedCurrentBands` only once 3.1's river current group reads at least as well on both backends; update the README draw order and the motion-budget water row (`docs/motion-budget.md:63`).
- **Cost:** net negative on Canvas [INFERENCE]. **Impact 2 · Effort M.** **Acceptance:** `?renderer=canvas` and WebGL captures of `git-harbor` at 12:00, 22:00 and rain show the same water features within palette tolerance.

## Wave 4 — A camera that knows the screen

### 4.1 Shot scales by visible world area, not tier index `[CC-1]`

- **Problem:** `AUTO_MAX_TIER = 1` (`CameraDirector.js:39`), survey only at backing DPR ≥ 2 (`Camera.js:57, 116-125`), `DEFAULT_FRAME_TIER = 3` (`:62`) and tour stops at hero z1/major z2 (`:1498-1533`) are all tier labels. At 5120×1440 DPR 1 z1 shows the whole island covering 24 % of the canvas; Ambient ran 90 s with wide, cohort and cohort all at z1 — three near-identical stamps with 60–76 % empty sea — while z2 (the panoramic band) and z3 are the best frames in the product.
- **Change:** a pure exported `shotScaleTiers(viewportW, viewportH, zoomSteps) → { survey, wide, medium, close }` beside `zoomTierLadder` (`Camera.js:116`): survey = the largest resting step showing ≥ 95 % of the island diamond (else null), wide/medium/close = the resting step ≥ tier 1 whose visible area is log-nearest to 1.4e6 / 0.55e6 / 0.2e6 world px²; cached in `_applyTierLadder` (`:239`) and recomputed in `onViewportResize` on every size change (`_syncDisplayPixelZoom` returns early when the zoom steps are unchanged, `:264-265`). `tierZoom(SURVEY_TIER)` resolves to `scales.survey` whenever one exists (DPR-1 ultrawide gets a 1:1 survey at z1). Call sites: `establishingShot` (`:610-642`) opens on survey ?? wide with `maxZoom = medium`; `frameContent` (`IsometricRenderer.js:2669`) and `frameTierFloorForBox` (`Camera.js:646-654`); `CameraDirector._ambientGlideOptions` (`:571-593`) wide → `scales.wide`, cohort/chapter → `scales.medium`; `_ambientStaticOverview` (`:517-539`); ordinary Auto (`_currentMaxZoom :821`) caps at `scales.wide` (z2 at 5120×1440); tour stops island = survey, hero = wide, major = medium (invalidate `_tourStopsCache`); `fitAttentionFrame` (`AttentionFraming.js:45`) iterates [close, medium, wide]. Resolved: 1920 DPR 1 wide 1 / medium 2 / close 3; 5120×1440 DPR 1 survey 1 / wide 2 / medium 3; 1512×982 DPR 2 survey 0.5 / wide 1 / medium 2.
- **Cost:** not free: WPG measured the FULL frame at 4880×1392 dense-24 at 1.80 ms GPU at z1 and 4.02 ms at z2, so resting Auto and Ambient at z2/z3 on the main display roughly doubles steady GPU cost (inside the 60 Hz period); take V2 receipts at the new rest zooms and fold them into 0.1's budget. **Impact 5 · Effort M.** Bends "automatic moves never rest above tier 1" for ordinary Auto (wide) and explicit Ambient (medium) (M8).
- **Evidence:** CC `tools/camera-cinema-scales.py`, `shots/camera-cinema-10-ambient-dense24-ultrawide.jpg`, `-13-uw-wide-z2-band.jpg`, `-mock-02-ambient-ladder.jpg` (all real frames at the poses the rule picks).
- **Acceptance:** at 5120×1440 DPR 1 Ambient on dense-24 rests its wide at z2 and cohorts at z3; at 1920 cohorts rest at z2; DPR 2 unchanged except cohorts at z2; the opening at 5120 holds z1 and settles ≤ z3; unit tests of `shotScaleTiers` for five viewports.

### 4.2 Land-weighted composition for automatic shots `[CC-3]`

- **Change:** in `_poseForWorldBox` for automatic owners only, compute the viewport area outside the island diamond analytically (clip against `mapWorldCorners`); while sea > 0.30, step the centre toward the island centroid in 16-world-px steps until sea ≤ 0.30 or the subject would enter a 12 % inner margin. Operator poses, follow and manual pan are untouched.
- **Cost:** 0. **Impact 3 · Effort S.** **Evidence:** `shots/camera-cinema-12-uw-medium-z2-forge.jpg` (~45 % sea) vs `-15-uw-medium-z3-landweighted.jpg` (~15 %). **Acceptance:** Ambient cohort and opening targets on dense-24 and `readme-showcase` at 1920 and 5120 measure sea ≤ 0.30 with every cohort member inside the margin.

### 4.3 `A` holds the attention cohort until it settles `[CC-5]`

- **Change:** after the attention glide, hold for up to 12 s: each update, while no genuine input arrives, soft-follow the union of the included agents' bounds extended by each moving agent's destination (`softFollowWorldBox`, `preferPan`, no zoom-in, `owner: 'user'`); end when all have been still 1.5 s, at 12 s, or on input; overflow goes to the existing excluded count, never silently; reduced motion re-cuts once when the cohort settles.
- **Cost:** ~0.05 ms CPU only while holding. **Impact 3 · Effort S.** **Acceptance:** `many-waiting` at 1920 and 5120: after `A` and 10 s without input, every included body and plate stays in view on every frame; any wheel or drag ends the hold within one frame.

### 4.4 Ambient as a standing choice `[CC-7]` (M8)

- **Change:** persist `cv-ambient-standing` when the operator turns Ambient on (`App.js:1038-1047`), clear it on off; on boot, reclaim after the opening glide; on `world:first-frame` reason `return`, reclaim; input revocation keeps today's RESUME AMBIENT without clearing the choice.
- **Cost:** 0. **Impact 3 · Effort S.**

### 4.5 A survey establishing shot with sky room `[AD-7]`

- **Change:** in `establishingShot` (`Camera.js:610-643`) and the landmark-circuit wide (`:1494-1515`), when the island box leaves vertical slack, shift the pose so `OCEAN_HORIZON_WORLD_Y` projects at 10–12 % of the world viewport below the top bar with the sun or moon disc whole, clamped to a ≥ 4 % bottom margin; fall back when there is no slack.
- **Cost:** 0. **Impact 2 · Effort S.** **Acceptance:** DPR-2 1600×900 and 1920×1080 survey captures at 12:00 and 22:00: horizon at 10–14 %, disc whole, island uncropped.

### 4.6 Fat-pixel flight frames and a sub-pixel camera while moving `[PT-2, PT-5]` (M4)

- **Problem:** every zoom move samples NEAREST at fractional k, so texels come out 2 and 3 px wide at once and crawl: a real 3 → 1 glide spent 53 consecutive frames (≈ 0.9 s) there. On the DPR-1 main display slow motion steps in whole pixels: a 20 px/s pan at k = 3 moved the world on only 32 of 95 frames.
- **Change:** `sampleAlbedo()` in `SCENE_FRAGMENT` (`GpuWorldRenderer.js:342`): when `u_fatPixels` is true, `pix = v_uv·texSize; fw = max(fwidth(pix), 1e-5); seam = floor(pix + 0.5); p = seam + clamp((pix − seam)/fw, −0.5, 0.5); q = p − 0.5`, `texelFetch` the 4 texels around `floor(q)` clamped to V9's flat record rect (with 1-px transparent gutters in the agent, tree and cast pages), blend premultiplied by `fract(q)` and divide by blended alpha; compute `fwidth` in uniform control flow, before any `discard` or slot branch; material, emissive and occluder sidecars keep NEAREST. `u_fatPixels` is a **per-batch** uniform: screen-space records (`ground:semantics` at scale 1 or 0.5, `WorldFrameRenderer.js:1044-1047`) set V9's `fatOptOut`. It is true exactly when k is fractional or the camera offset is (PT-5). World-grid terms that quantize on `floor(v_world)` — water dashes, 3.1's cycle, 3.2's glint, 3.9's rings, pool courses (`:299-300, 413-416`) and the composite's clouds and haze (`:600-608`) — would otherwise keep mixed 2/3-px cells across the sea during flight; give them the same coverage treatment (cell edges blended over ≤ 1 px from `fwidth(v_world)`) or accept and measure the residue on `git-harbor` water. `Camera.renderOffsetGpuX/Y` return the unrounded offset while a glide, follow spring, momentum or tour owns the camera and k ≥ 2 (idle drift keeps rounded offsets); `_setCameraUniforms` (`:1377-1387`) uses them; lights are projected with the same unrounded offset (today the rounded `worldToScreen`, `PostFxFeed.js:249-256`, `Camera.js:1103-1105`), and the outer ocean follows 3.3's composite route or takes the unrounded offset, so nothing slips against the GL layer; the overlay and Canvas keep rounded offsets. Land after 2.1 (lights in world space) and 3.3. With this in place, the aesthetic plan's C3 glide clause becomes "resting frames integer-k nearest; flight frames fat-pixel", and glides become one continuous log-zoom dolly (next bullet).
- **Continuous dolly (M4, approved):** once the fat-pixel path is in, `CameraCurves.planGlide`/`sampleGlide` interpolate the world centre and log-zoom together in one easing (director easeInOutCubic, Ambient/tour easeInOutSine) instead of panning at a resting tier and then stepping 450 ms per rung; the ≥ 75 %-at-integer-tiers lengthening and `ZOOM_STEP_MS` are removed, and the duration formula `clamp(600 + 0.55·screenPx + 350·|log2 z1/z0|, 700, 2400)` ms stays. Every glide still ends on an integer resting tier, the wheel keeps its 150 ms tier step, and reduced motion keeps cuts. Update `CameraCurves` tests and the character-mode README's camera section to the new contract.
- **Cost:** 0 at rest (uniform-gated, byte-identical); in flight +0.09–0.11 ms scene pass at 1.7 Mpx with the patch always on (TIME_ELAPSED, loaded host). Follow, glides and Ambient own the camera much of the time, so this is a steady state, not an edge case: take a K8 receipt at 5120×1440 with the gate forced on. **Impact 4 · Effort M.** Supersedes OE-3.
- **Evidence:** PT `proto/pixel-technique/pan-zoom.html` (real 1:1 capture against exact area-coverage references), `seq/slowpan-d1`; OE `shots/outside-eye-mock-04-glide-*.gif`.
- **Acceptance:** with the flag off, or on at integer k, frames are byte-identical; through a 3 → 1 glide no frame shows two texel widths without coverage seams, on sprites **and** on `git-harbor` water; a 20 px/s pan at k = 3 moves the GL layer every frame and its first settled frame equals today's; the map-edge water seam does not slip during a pan; k = 1 unchanged; an `F` reframe from tier 3 is one continuous move (no plateau between pan and zoom) that ends on an integer tier within the formula's duration.
- **Risks:** the 2D backdrop and overlay stay nearest while moving (≤ 0.5 backing px drift, below today's 1.8–3.2 px body jitter); add a record-rect varying if atlas bleed appears.

### 4.7 Full-rate gait on the resident path `[PT-3]`

- **Problem:** walk frames advance 13–26 times a second by distance (`AgentSprite.js:75, 2196`), but the GPU agent atlas rewrites an unselected body's cell only every 125 ms (`GpuSceneBuilder.js:940-949`): 0–8.9 changes per second.
- **Change:** in `packGpuAgentFrameAtlas` (`GpuSceneBuilder.js:829-1080`), a walking body's slot holds a 6-cell strip of its current direction's walk row (packed with V7's anchor, channel atlases matching); repack only when direction, tool, profile or pose changes; each frame set `record.sx = stripX + frame·cell`. Idle slots keep the 125 ms cadence; crowd-LOD bodies keep single cells; cap strips to on-screen, non-LOD walkers.
- **Cost:** fewer uploads overall; ≈ +169 KB albedo per walker (+4 MB at 24), up to 4× that with the matching material, emissive and occluder atlases, all inside the 48 MiB cache cap (`GpuSceneBuilder.js:49`). **Impact 3 · Effort M.** Depends on 0.4.
- **Acceptance:** an unselected walker's rendered pose changes as often as `sprite.frame`; atlas upload bytes per second at dense-24 do not increase.

### 4.8 Crisp middle rungs on DPR-2 displays `[PT-7]`

- **Change:** in `zoomTierLadder`/`displayPixelZoomSteps` (`Camera.js:104-125`), at backing DPR 2 expose every integer k from 1 to 6 as zoom k/2 (adding 1.5 and 2.5 as wheel and `F` rungs), keeping the logical tier labels; DPR 1 keeps [1, 2, 3]; check CameraDirector caps against the new rungs.
- **Cost:** 0. **Impact 2 · Effort S.** **Acceptance:** each new rung renders texel runs of exactly k px (measured 198/198 at zoom 1.5).

### 4.9 Activity panel as an overlay with camera safe insets (optional) `[CC-4 (M)]`

- **Change:** keep the canvas full width with the panel drawn over the world; add `camera.safeInsets` consumed by `_compositionAnchor` (`Camera.js:1297-1304`), the follow aim (`:880-894`) and the attention viewport (`CameraDirector.js:383-389`); hit testing honours insets. Removes three canvas and GPU-target reallocations per selection on a 5120 canvas. ChromeUI rejected an overlay panel because resize is cheap after the first open; 0.3 (b) removes the visible cost, so this lands only if the reallocations measure as a hitch (M24).
- **Cost:** 0. **Impact 2 · Effort M.**

## Wave 5 — The land lives (bakes; zero or negative per-frame cost)

### 5.1 Seasons in canopy and ground `[TF-1, SW-4 (1)]`

- **Problem:** forcing January or May gives identical land mean RGB (84.8/94.8/82.5 vs 84.9/94.8/82.7); the ground's only season inputs are the bloom palette and a winter tuft tip (`GroundBake.js:661-666, 722`), and tree sprites have none (`FoliageRenderer.js:9-24, 116-132`). Today, 27 September, the island shows full summer.
- **Change:** a `livingGround` pass after `drawYardEdges` (`GroundBake.js:587`) with a tree-proximity field (downwind drop zone): autumn leaf litter under oaks and willows (`#7a3b22 #a4563a` + ochre), dry-grass patches on `GRASS_DRY`, pine needle duff; spring petals under ~35 % of oaks. Canopy caches keyed `${species.size}|${variant}|${season}` with luminance-rank remaps onto new C1 ramps (autumn russet/ochre/turning per tree hash, willow gold, spring blossom speckle; pine unchanged). Add `snow`, `leafAutumn`, `canopyRusset`, `canopyOchre`, `willowGold`, `blossom`, `foliageDeep`, `foliageSun` to `ART_RAMPS` and teach `art:analyze` about them. Invalidate tree caches when `_terrainSeason` changes (`IsometricRenderer.js:6050-6051`). Winter snow is 5.2's job; winter bare deciduous trees need authored sprites (5.5) because a remap reads as white mesh.
- **Cost:** baked (+40–90 ms to the one-time ground bake per season change; tree canvases rebuilt once per season). **Impact 4 · Effort M.**
- **Evidence:** TF `shots/terrain-foliage-mock-01-seasons-forest.jpg`, `-mock-02-seasons-lawn.jpg` (rendered by the real resident WebGL through `page.route`; code in `proto/terrain-foliage/living-ground.inc.js`, `foliage-recolor.inc.js`); SW `shots/sky-weather-13-season-wet-sheet.jpg`.
- **Acceptance:** with the month forced, z3 elderwood and Observatory lawn captures differ per season (autumn russet/ochre oaks beside green pines, litter under crowns; spring blossom); summer lawn metrics stay inside D5 (median S 0.45–0.50).

### 5.2 The ground remembers the weather; snow only when it snowed `[SW-3, SW-4 (roof class, winter ground), TF-1 winter]`

- **Problem:** `WETNESS_ATTACK_MS 480 / RELEASE_MS 4000` (`WorldFrameRenderer.js:53-54, 343-357`) dry a road 4 s after rain stops (a linear 4000 ms release); no snow ever lies on the ground or roofs.
- **Change:** `groundStateAt()` per C-W2 (wetness = Σ precip·dt·exp(−age/45 min); puddles = smoothstep(0.35, 0.7, wetness); snowCover = Σ winter precip over 72 h minus melt 0.02/h above freezing; frost on clear winter nights), memoized per 10-minute bucket; `renderer._surfaceWetness = max(live precip, wetness)`; delete `advanceSurfaceWetness` and its constants and tests. Bake a puddle-site mask (R8, V9 upload path) in `ground-splat`; puddles reflect the graded sky in stepped opaque colour (never the brightest thing). Winter ground: snow courses on grass where `snowCover > 0` (fbm + Bayer, swept on paving with snow only in joints, slush on dirt, thinner under crowns and at eaves), mapped by luminance to the `snow` ramp (`#98a5b4 … #e6e9e6`), rebaked per 0.25 `snowCover` bucket (≤ 4 bakes a day). Roof snowcaps lie only on 2.3's face-class-3 (roof) pixels and silhouette tops; landmarks without an authored surface channel get none until 2.3 covers them; pine gets a 2-px cap.
- **Cost:** baked mask + 1 fetch on ground materials while wet; CPU O(knots) per minute bucket. **Impact 4 · Effort M–L.** Winter exception to D5/Tier A (M9). Depends on 0.2.
- **Evidence:** SW `shots/sky-weather-mock-03-after-rain-puddles.jpg`, `-mock-04a-snowcap-bake.png` (bake on real shipped albedo); TF winter panels in `terrain-foliage-mock-01/02`.
- **Acceptance:** with a pinned rain knot ending 14:00, the ground is wet and puddled at 14:30, fewer puddles at 15:15, dry by ≈ 16:00, identical after a reload; in winter, snow lies only after the village's own winter precipitation and never on doors, banners or status marks; amber/red plates stay distinct over snow (`many-waiting` in winter).

### 5.3 Per-tree canopy variants `[TF-3]`

- **Change:** `variant = floor(frac(sin(tileX·91.7 + tileY·17.3)·43758.55)·3)` in the canopy cache key; variant 0 authored, 1 deep/cool, 2 sunlit/yellow, expressed as luminance-rank remaps onto `foliageDeep`/`foliageSun` (hue 90–110°, S ≤ 0.5, ±1 ramp step of value, hue ±8°), biased deep in the elderwood and sunlit near meadows.
- **Cost:** 0 (folded into 0.7's frame keys). **Impact 3 · Effort S.** **Acceptance:** at z2 over the elderwood, adjacent same-species trees share a ramp ≤ 50 % of the time; no off-ramp canopy pixels.

### 5.4 A micro-detail density field in the ground bake `[TF-4]`

- **Problem:** lawns are flat carpet: tufts on 37 tiles, flowers on 10, mushrooms on 3, stones on 0; grass meets paths with one tuck step (`GroundBake.js:509-511`).
- **Change:** a two-pass chamfer distance from grass/sand to non-grass texels; a verge band (2 ≤ edge ≤ 6) with 2–4-texel blades and seed heads (dead stems in winter), twigs, moss or needle duff under crowns, wall-base weeds (by AO), and rare meadow pockets, all clustered; darken the forest floor inside `FOREST_FLOOR_REGIONS` by half a ramp step.
- **Cost:** baked (+~45 ms once). **Impact 3 · Effort S.** **Evidence:** `shots/terrain-foliage-mock-04-microdetail.png`. **Acceptance:** at z3 every path/grass boundary shows a verge band; open-lawn luminance σ grows ≤ 8 %; median saturation stays 0.45–0.50.

### 5.5 Woodland scale and winter tree states `[TF-5, SW-4 (2)]` (M10)

- **Problem:** since D1, trees are villager-sized (oak.large 51 px, pine 52, willow 53 vs bodies 48–75 px), so woods read as shrubs; bare winter trees cannot be made by remapping.
- **Change:** author at native 1×: `veg.tree.oak.tall` ≈ 96×80, `veg.tree.pine.tall` ≈ 56×84, `veg.tree.willow.tall` ≈ 88×78, plus bare-winter oak and willow and snow-laden pine states; place tall sheets only in `TREE_CLUSTERS` woodland regions (`config/scenery.js:273-282`), never within 1.5 tiles of paths or lanes; keep 51-px oaks near districts; run `scripts/sprites/foliage-pass.mjs` and `art:analyze`.
- **Cost:** substitutes sprites (≈ 2.2× texture area for large sheets, shared). **Impact 4 · Effort L.** Funded inside the spend cap: one tall-oak candidate round in Phase A (≤ 30), the other tall sheets and the bare-winter and snow states in Phase B (≤ 246).
- **Acceptance:** at z2 the elderwood and south wildwood read as forest (crowns ≥ 1.3× the tallest villager); no villager hidden by a tall tree in 20 sampled dense-24/dense-100 frames.

### 5.6 (moved to 0.10)

Fog, ground haze, lightning and the sun disc landed with the weather fix as 0.10, because 0.2 turns fog and storms on for the first time.

### 5.7 A sky that belongs to the horizon `[SW-6]`

- **Change:** anchor sky clouds to the sky band (`y = horizonY − f·(horizonY − top)`), nothing below `SKY_HORIZON_WORLD_Y`; bake a 3-strip horizon cloud deck (procedural stepped-noise silhouettes on `round(zoom)` cells with sun-side rims and graded undersides; dusk rim `#f6be96` over `#a07492`, noon `#eef3f8`/`#b9c9d9`/`#8fa3ba`), coverage = cloudCover, parallax 0.02/0.05/0.09, drift from C-W3, rebaked per bucket; retire the 28×16 icon clouds. Reduced motion: the deck holds its offset (parallax on pan only).
- **Cost:** baked. **Impact 3 · Effort M.** Reach is mostly the survey tier, the opening and pans north (the horizon is off-screen at DPR-1 default framings unless 4.1/4.5 put it in the establishing shot).

### 5.8 A true sky: meteor calendar and after-rain rainbows `[SW-8 (1, 2)]`

- **Change:** an IMO 2026 meteor calendar (Quadrantids Jan 3–4 … Ursids Dec 22) drops the ambient interval to 20–70 s within ±1 day of a peak on clear nights, radiant-consistent and cell-rasterized; a 6-band stepped rainbow (2-px cells, Bayer edges, alpha ≤ 0.35) opposite the sun for up to 20 min when the timeline goes from rain to clearing with sun elevation < 42°, faded in 3 quanta (static under reduced motion). The push and sub-agent rewards were removed in 0.2. While here, check `SeasonalAmbience`'s drift particles: SW's probe saw 0 tagged drift particles at z2 in January, April and October [INFERENCE: a tag or gating mismatch].
- **Cost:** 0. **Impact 2 · Effort S.**

### 5.9 (rejected — M13)

Work wear from observed traffic was rejected on 2026-09-28: the ground never records history. See Killed and rejected.

## Wave 6 — Working architecture

### 6.1 Building parts and emitter cycles gated by real work `[BL-1, OE-1]`

- **Problem:** with 24 agents working, only the Forge hearth, the Observatory clock and a little Portal and Harbor-flag motion move; the Mine headframe, Harbor crane, Command gate, Archive, Task board structure and Lighthouse never change. The only generic hook is a smooth-sine alpha `pulse` (`BuildingSprite.js:2147-2148`); the Forge hearth is a static gradient busy or idle.
- **Change:** extend manifest `layers:` with frame-strip parts `{ frames, frameW, frameH, fps: 4–8, staticFrame, gate, oneShot? }` (bottom-centre anchor per `BuildingSprite.js:2134-2143`); `_drawManifestLayers` (`:2114-2155`) blits `frame·frameW` from a stepped clock, drawing `staticFrame` when the gate is false or motion is reduced. Gates resolve from existing state only through a new `BuildingPartGates.js` built on V8's `isWorkingVisitor` (so rest-seat, queue and inferred-leg visitors never animate a building). First parts: Mine sheave, Harbor crane, Forge bellows, Task board lantern flame; one looping part per building, loops only while gated; a part must change ≥ 4–6 world px of value-contrasting pixels to read at z1 on the 5120×1440 main display (BL). Emitter cycles per V4 through a pure `EmitterCycle.js` `bakeEmitterCycle(baseImg, maskImg, { frames: 8, bandPx: 4, riseStepPx: 2, fixedBelowRankFrac: 1/3 })` (ramp the authored colours under the mask by luma, rise the ranks in 4-px bands, keep dark embers fixed), Forge first while `_forgeGlow > FORGE_BANKED_GLOW` (`BuildingSprite.js:107-110, 2196-2207`), the banked mask at rest; later Lighthouse lens, Portal runes, braziers (each needs a hand-authored mask ordered along the flame height). On GPU, one small record per cycled emitter or part at the building's sequence.
- **Cost:** ≤ ~8 blits/records per frame, strips atlas-baked (< 0.5 MB), ~0 GPU. **Impact 5 · Effort L.** Hand-authorable (prototypes exist); optional `animate_image` for crane and bellows ≈ 12–24 generations.
- **Evidence:** BL motion heat grids `shots/buildings-life-03/04/05-motion-*.jpg`, prototype `proto/buildings-life/`; OE `shots/outside-eye-mock-01-forge-cycle.gif` (every output pixel one of the Forge's 14 authored colours).
- **Acceptance:** a Mine with a working visitor steps its sheave at ≤ 8 fps and an empty Mine shows frame 0 pixel-identical to `base.png`; the working Forge's flames rise at 8 Hz using only authored colours; banked and reduced-motion frames are the authored art; Canvas and GPU match; parts stay in depth order with the split pass.

### 6.2 Doors that open, and a Command gate at ≥ 1.2× body `[BL-2]`

- **Change:** re-author the Command gate as a patch layer `building.command.gate` lifting the arch ~10 px so the leaf is ≥ 78 px (hand edit or a masked inpaint confined to the arch), as a 3-frame strip closed/ajar/open with a dark hall `#1a1310` and a stepped warm floor on the C1 emissive ramp; the same strips for the Archive lancet, Observatory and Harbor office doors. Gate `door.<type>` open while the building has ≥ 1 `isWorkingVisitor` (V8), a one-shot 3-frame open on arrival (100–120 ms per frame); static under reduced motion.
- **Cost:** ≤ 4 blits. **Impact 4 · Effort M.** Phase B: ≤ 60 generations for the gate inpaint (or 0 by hand) and ≤ 12 for door strips (M15).
- **Acceptance:** the Command leaf measures ≥ 78 px in `base.png` (≥ 1.2× the median 1:1 body, closing the C3 item); occupied buildings' doors open, empty ones closed; an arrival triggers one 3-frame open.

### 6.3 Windows count the workers `[BL-3 (2–4)]`

- **Problem:** night light is binary per building: one working visitor lights the whole sidecar, and three readers at the Archive at 22:00 leave it dark; `assignRoomSlots` runs only for the selected building; painted amber daylight glass makes empty buildings look lit at noon.
- **Change:** the per-building room masks (`base.rooms.png`, room index in R, segmented from `base.emissive.png` into connected glass components) are baked in Wave 2 for 2.4 and 2.9; here, run `assignRoomSlots({ previous, workingIds, rooms })` for every building in `_updateVisitorCounts` with `workingIds` from V8's `isWorkingVisitor`; at night light room k's glass pixels with the sidecar texels (art-shaped, not rects) and expose the per-room gate that 2.4's aperture lights and 2.9's water columns read; unoccupied rooms stay dark; waiting occupants are counted, never lit; overflow stays an exact count. Per M15, recolour daylight glass in `base.png` to unlit slate glass.
- **Cost:** substitutes the binary gate (`BuildingSprite.js:4462-4473`); ≤ ~30 masks baked once. **Impact 4 · Effort M.** 0 spend. Depends on 0.8.
- **Acceptance:** at 22:00 with N working visitors exactly min(N, rooms) glass shapes are lit on every building, stable per agent while it works; a validator checks each room rect against the sidecar.

### 6.4 Smoke that reads, from every real chimney `[BL-4]`

- **Change:** `ChimneySmoke.js` puffs grow from 2 to 5 art-px radius over life, in 3 tones (lit `#d3d6dc`, body `#a9aeb8`, shade `#787c86`) and 4 alpha quanta by height, keeping wind lean, wet flattening and moonlit tones; `smokeTop` anchors for both Harbor stacks; delete the ungated Harbor `smoke` fallback emitter; scale the reduced-motion `STATIC_WISP` to match; column ≤ 60 world px.
- **Cost:** substitutes existing puffs (same ≤ 10 cap). **Impact 3 · Effort S.** **Acceptance:** with the Forge occupied (`isWorkingVisitor`), ≥ 3 puffs visible above the cap at z1 on 5120×1440 and at z3; the Harbor smokes only when it has a working visitor; the reduced-motion wisp is static.

### 6.5 Pixel pennants and flags `[BL-5]`

- **Change:** ship `sprites/overlays/pennant.strip.png` (24×16 × 4 frames, indexed rim/accent/shade/pole/finial) recoloured per repo accent into a bounded cache, stepped at 4 fps from C-W3 wind (frame 1 when calm; frame 1 under reduced motion); apply to the occupancy pennant (`BuildingSprite.js:1849-1886`), the Harbor mast pennants (`:114-118`) and `HarborTraffic` flags (`:3301-3305`).
- **Cost:** substitutes path fills with blits. **Impact 3 · Effort S.** **Acceptance:** no `beginPath` or AA polygon remains in pennant or flag drawing; every pennant pixel on the art grid at every integer zoom.

### 6.6 Wet slate and eave drips in real rain `[BL-9]`

- **Change:** a per-building `roofEdge` mask of upper-left-facing slate edge pixels (2.3's face class 3 where authored); a stepped 1-art-px wet course `#5A6C8C → #8fa3c0` scaled by `u_wetness` in 4 quanta (from 5.2's ground state); 1-px drips at 3–4 eave points only while precipitation > 0 (hidden under reduced motion; the wet course stays).
- **Cost:** baked per wetness bucket. **Impact 2 · Effort M.** **Acceptance:** in rain, roof edges show a stepped wet course that fades with wetness; clear weather identical to today.

### 6.7 Chronicle dressing tiers `[BL-8]` (M16)

- **Change:** one static manifest layer per verified lifetime tier (maiden 1 / ribbon 10 / flagship 100 / aurora 1000) from `MonumentRules` (`application/MonumentRules.js:27-32, 123-160`): Harbor bunting with one pennant per verified release (max 5), a Forge billet rack at 10 feat/fix commits, an Archive brass lectern at 100; inside the footprint, no light, at most one visible dressing layer per building; nothing with an empty store; records past retention keep the earned tier. The day-long release pennant (8.2) and the bunting share one pennant sprite family (6.5).
- **Cost:** baked. **Impact 2 · Effort M.** ≤ 18 generations (Phase B), or hand-authored.
- **Acceptance:** with an empty Chronicle store no dressing appears; with the sim release fixture the Harbor bunting count equals the verified release records; no dressing layer casts light or moves; reduced motion identical.

## Wave 7 — Villagers who work and rest

### 7.1 Rest seats: idle villagers sit `[SM-2]`

- **Problem:** working and idle bodies are indistinguishable at every zoom, and idle bodies move more (72 % vs 46 % of samples); idle agents loiter at Command, so its plaque reads 13 when 2 are working.
- **Change:** `config/townPlan.js` `REST_SEATS`: ~16 authored seats `{ tileX, tileY, facing, occluder: 'bench' | 'step' | 'well' | 'pier' }` on greens, Command steps, the well rim and the pier edge, off the Command approach reserved by 7.2. IDLE agents reserve the nearest free seat through `VisitTileAllocator` (`AgentSprite._ambientDestination :1324-1331`, `_ambientBuildingTypeForState :1686`), walk there once and hold a seated pose; idle strolls stop. **Seated pose (M12: true seated frames):** a `sit` action-strip group per profile in the four seat facings, authored with PixelLab (the `crouching` template at ~1 generation per direction, or `animate_with_skeleton_v3` with hip/knee/ankle keypoints bent once and then held, for heavy-armour sheets), assembled into the existing strip PNGs, lazily loaded, placed by V7's foot anchor with the seat line as the new foot; a front occluder slice (a new 1-texel-outlined timber bench stamp on the C1 timber ramp, or existing step/well/pier geometry) drawn after the body still hides the legs behind the bench. Pilot two profiles first; profiles without an approved sit strip fall back to the lowered-body pose (body 5 texels down, clipped at the seat line). Seats on building visit points (Command steps, the pier edge, `Building.js:146-149`) must not raise `_visitorCountByType`: resting bodies are excluded from every building visitor count and from the light and emitter boosts (`BuildingSprite.js:1443-1444, 4344-4345`), per V8. Seats never hide T1 beacons or names; overflow stands at the seat cluster, never at a building; seating reads status only, never freshness.
- **Cost:** substitutes idle-stroll pathing and walk cycles; ≤ 16 occluder-slice records; lazily loaded sit strips. **Impact 5 · Effort M–L.** Pilot ≈ 16–24 generations (Phase A), roster ≈ 104 (template) to ≈ 300 (skeleton-v3) (Phase C).
- **Evidence:** SM `shots/signal-moments-mock-02-rest-seats.jpg` (panels 1–2 real).
- **Acceptance:** dense-24 with 8 injected idles at z1/z2: every IDLE body seated within 15 s and still; working bodies never sit; plaques count only non-seated visitors; a building's static light and emitter strength are identical with and without seated idles on its steps; reduced motion identical.

### 7.2 Petitioners queue at Command in order of their real wait `[SM-5]`

- **Change:** `COMMAND_QUEUE` in `townPlan.js`: a 12-slot polyline along the Command approach (≥ 24 world px spacing); waiting-on-user agents take slots by `SignalLedger.waitAnchor()` rank (oldest nearest the door, unknown ages last with an unlit stub), re-ranked only on membership change; a floor candle beside each whose wax steps down by wait age (< 1 min 12 texels, 1–4 min 9, 4–16 min 6, ≥ 16 min 3) with the C4 cream cap and ember flame, static between steps. Queued petitioners count at their own district's plaque, not at Command (V8), and never raise Command's visitor count. Errored and rate-limited agents keep their places; T1 plates are unchanged; the 13th+ stand at the plaza with the group plate carrying the exact total. Moving waiting bodies (and their plates) away from their own district is a maintainer decision (M12).
- **Cost:** ≤ one cached stamp per waiting agent. **Impact 3 · Effort M.** Shares the slot registry with 7.1.
- **Acceptance:** `many-waiting` at z1/z2: body order along the queue equals the sidebar NEEDS YOU order; candle steps match the age buckets; group plate text unchanged.

### 7.3 Authored work and wait strips with pinned feet `[CM-3]` (M10)

- **Problem:** Bash, Edit, Task, WebFetch, waiting, rate-limited and chat all play the same 4-frame breathing idle; only read is authored (16 of 24). The wait row failed OF-009 four times because regenerated frames moved the feet ≥ 3 px.
- **Change:** PixelLab `animate_with_skeleton_v3` per profile and work facing (V7): first frame = the direction's idle row-6 cell, 18 keypoints (estimated or authored once per body family), per-frame keypoints with arm/torso deltas only — ankle, knee and hip joints are copied verbatim so the feet should not drift [INFERENCE: CM expects this from the keypoint contract; the pilot must prove it]. Groups: strike (Edit/Write/apply_patch at the Forge, 6 frames), tinker (Bash/test, 6), gaze (WebFetch/search at the Observatory, 4), wait (3, static hold), plus read for the six strip-less profiles; assembled into the existing strip PNGs (`actionStrip.groups`), selected by real tool class and `RitualConductor` admission (≤ 6 animated), never elapsed time; `WorkDownbeats` fires on the strip's contact frame; lazy per-action loading. Pilot first: Sonnet + gpt55, strike + wait, 4 facings. Before any new strips, audit sheet-wide frame consistency (CM found `deepseek.pro`'s E walk shows its scimitar in only 3 of 6 frames).
- **Cost:** baked. **Impact 5 · Effort L.** Funded inside the spend cap: the pilot in Phase A (≤ 40); in Phase C, wait strips for the whole roster (≤ 208) first, then strike/tinker/gaze for the most-seen profiles with what remains. The full strike/tinker/gaze rollout (~936) and read strips for the six strip-less profiles (96–144) are outside the cap. Mirroring E↔W is rejected (it flips the baked key light).
- **Acceptance:** the pilot passes the ±2 px feet audit in every frame and shows distinct strike, tinker and wait silhouettes at z2 in a contact sheet; Phase C starts only after that pilot passes, and every rolled-out strip passes the same audit.

### 7.4 The crowd reads as foot traffic `[CM-7]`

- **Change:** in `_applyLocalAvoidance` (`IsometricRenderer.js:4735-4815`), two walkers within 22 px with heading dot > 0.7 mark the trailing one down one V7 rung until the gap is ≥ 24 px (a loose file); in `_resolveStationaryOverlaps` (`:4947-4963`) break exact stacks (`dist <= 0`) with the stable hash angle and fan `performing` villagers at one building on a ±6 px 2:1 ring by visit-slot order, walkable-checked.
- **Cost:** 0. **Impact 3 · Effort M.** **Acceptance:** dense-24: overlapping pairs per sample ≤ 0.3 (today 1.37), no pair at distance 0 after 10 s, same-heading pairs ≥ 20 px apart on shared roads, no walker moves backward.

### 7.5 Run gait for real urgency (optional) `[CM-8]`

- **Change:** a `run` strip group (`running-6-frames`, template 1 generation per direction) allowed while moving only for chat/alert intents at the 1.5 rung, stride 7.5 px per run frame; otherwise those intents walk (0.4 caps them).
- **Cost:** baked. **Impact 2 · Effort M.** 208 generations (template) or 416–832 (skeleton-v3).

## Wave 8 — Moments on stage

### 8.1 The moment staging contract `[SM-4]`

- **Problem:** moments land where the eye isn't: a dispatch played while the parent was hidden by the gate tower; the failed-push bracket sat at an empty slip while the actor walked in for 7 s; the release crown played 123 px above the viewport at its own scenario camera.
- **Change:** implement V8's `resolveMomentAnchor` next to the moment ledger in `EffectStamps.js` and use it in `ArrivalDeparture` dispatch/merge, the `HarborTraffic` failure bracket, the `ChronicleMonuments` crown and `LandmarkActivity` plates; when actor ≠ place and both are on screen, one `dottedCurve` thread in the family colour for the residue only; the V8 caption priority in `captionSource`.
- **Cost:** 0. **Impact 4 · Effort M.** **Acceptance:** in `parent-subagents`, `failed-push`, `release-parade` and `quota-rate-limit` at their metadata cameras and at z1/z2/z3, every Medium/Major peak frame lies fully inside the safe area and unoccluded.

### 8.2 A verified release sails from the pier `[SM-3]`

- **Change:** anchor the crown to the release's ship mast-head (or the slip), clamped into the safe area (`ChronicleMonuments._harborCrownAnchor :808-818`); keep `RELEASE_CROWN = defineMoment('major', { anticipation: 200, peak: 80, follow: 1200, residue: 6000 })`: a gold pennant climbs the mast in 3 held steps, one cream frame on the sail outline, the crown blooms above the mast as the ship casts off along the existing channel route with 2 wake chevrons, the seal rides out past the buoys; per M16 a verified-release pennant stays on the Harbor for the local day. Gold is verified success only.
- **Cost:** ≤ 60 fillRects for ≤ 2.5 s plus one existing ship record. **Impact 4 · Effort M.** Depends on 3.8 (integer-scale hulls) and 8.1.
- **Acceptance:** at 1920×1080, 1600×900 and 5120×1440 the crown's full radius is inside the safe area in ≥ 1 follow frame and the ship leaves the slip.

### 8.3 Moments peak on the score's notes `[SM-8]`

- **Change:** gate the peak frames of the arrival column, the dispatch/merge impact, the release crown and the failure bracket on `cueNoteDue(kind, id, 0, now)` and their residues on the last note (CueKit kinds arrival, summons/return, release, distress); with no score `cueNoteDue` returns true (`CueScore.js:330-333`), so silence and reduced motion are unchanged.
- **Cost:** 0. **Impact 2 · Effort S.** **Acceptance:** with Signals on, peak frames land within one frame of the published note time.

## Wave 9 — Chrome and Dashboard (DOM only; parallel from Wave 0)

### 9.1 A mode-stable top bar and a World camera dock (fixes OF-014) `[CU-1]` (M14)

- **Problem:** at 1280 with three alert buckets `.topbar__center` has 355 px but needs 501, clipping WORKING mid-glyph; at 1280 and 1440 TOKENS SEEN TODAY wraps to y = 48 and is never shown; READ/AMBIENT hide in Dashboard (`App.js:1014-1016, 1052-1057`), so switching modes shifts the Chronicle icon 1353 → 1556 px at 1920.
- **Change:** move `#topbarCinemaToggle`, the READ/AMBIENT well and `#topbarWorldControls` out of `.topbar__right` (`index.html:91-105`) into a `<div class="world-dock" role="group" aria-label="World camera">` as the last child of `#characterMode` (`:152-172`), absolutely positioned at the world's top-right (height 36, below `.first-run-hint`), framed with 9.5's walnut slice on its left, right and bottom edges; ids, handlers and the compass's `anchor-name` keep working. **Per M14, the Auto camera toggle and AMBIENT CAM merge into one three-state segmented control `FREE | AUTO | AMBIENT`** in the dock (one `aria-pressed` segment at a time; the existing Auto and Ambient handlers and 4.4's standing choice map onto it; input revocation shows AMBIENT's resume state inside the same control); READ stays a separate hold button. Stack each lit-slot part as numeral over caption (`topbar.css:522-551`: 288 → ≈ 214 px) and set `.topbar__center` padding-top 8 → 4. The dock publishes its reserved rect (V8).
- **Cost:** 0. **Impact 4 · Effort M.** **Evidence:** CU `shots/chrome-ui-02`, `-14`, `-26`; mock `shots/chrome-ui-mock-01-of014-1280.png` (centre scroll = client = 607 px). **Acceptance:** at 1280×800 with all three buckets, no overflow, every count and the ledger on row 1, no clipped glyph; every top-bar control keeps its x (±0 px) across modes; the dock never covers a T1 plate.

### 9.2 The call card: the ask leads an action-needed agent's panel `[CU-2]`

- **Change:** move the blocked banner directly under `.activity-panel__header` and restyle it as a card (9.5's status-hue slice or a `color-mix` fallback): an 8 px PS2P eyebrow `${WORD} · ${waitReasonLabel}` using `ATTENTION_PARTS` words with the `waitAnchor()` age right-aligned; the ask from `safePromptDetail(agent, Infinity)` (already redacted) at 22 px DM, always expanded, capped at 4 lines with the existing disclosure; an 11 px provenance line. The header status wraps instead of ellipsizing. No buttons that imply ClaudeVille can approve anything. Whether the card also says where to answer (for example `Answer in the claude terminal · tidepool-app`) or shows only observed facts is M25.
- **Cost:** 0. **Impact 4 · Effort S.** **Acceptance:** with `readme-moss` selected at 1280 and 1920 the full prompt is visible without interaction within 200 px of the header; its age matches the sidebar and the plate to the second; idle and working agents show no card.

### 9.3 Sidebar busts `[CU-3]`

- **Change:** each agent row gets an `AvatarCanvas(agent, 'sheet')` (64 px 2× canvas) displayed at 32 CSS px with `image-rendering: pixelated` (exactly 1× at DPR 1, native at DPR 2), the status dot moved onto its corner as an 8 px pip keeping the attention blink; grid `32px minmax(0, 1fr) auto`, rows stay 44 px; the parent chip moves to row 2 or the age gets a fixed 5ch column (it jumps 203 → 131 px today); busts redraw only on identity change and are created lazily if rows are not contained.
- **Cost:** 0 per frame (≈ 0.5 MB of canvases at 31 agents). **Impact 4 · Effort M.** **Acceptance:** every row shows its own crisp bust with no fractional scaling; age right edges align within 0 px across rows.

### 9.4 One pixel tooltip for the chrome `[CU-4]`

- **Change:** one `<div id="cvTip" popover="manual" role="tooltip">` and a ~60-line `shared/ChromeTooltip.js` (delegated pointer/focus listeners on `[data-tip]` inside the top bar, dock, sidebar and panel; 400 ms delay, 0 ms if another tip closed within 300 ms; Escape hides) positioned by CSS anchor positioning with `position-try-fallbacks`; 11/16 px DM with an optional `<kbd>` shortcut; convert the top-bar glyph buttons from `title` to `data-tip`; redraw the Chronicle glyph (`index.html:71`, reads as "E"/"€") as an open book.
- **Cost:** 0. **Impact 3 · Effort M.** **Acceptance:** any top-bar or dock glyph shows the tooltip within 400 ms on hover or focus, on the 11 px grid, never clipped, flipped inside the viewport at 1280; no native tooltip on converted controls; no animation.

### 9.5 A hand-authored 9-slice pixel frame kit `[CU-5]`

- **Change:** four 9×9 PNGs in `claudeville/assets/ui/` with 3 px slices (black seam with a 1 px notch, lit top/left walnut `#6e533a`, shade `#2a1f16`, fill): `walnut`, `bg2`, `well` (inverted), `attn`, plus `attn-error` and `attn-limit`; applied with `border-image: url(…) 3 fill / 3px / 0 stretch; image-rendering: pixelated` to the modal, world grammar popover, first-run hint, wells (2 px slice to keep 28 px), the active mode button, the hero portrait, the lit slot, the dock and the call card; the three big columns keep their 1 px bevel. Record it in `DESIGN.md`.
- **Cost:** 0. **Impact 3 · Effort S.** **Acceptance:** frame pixels are exact 1× or 2× copies of the PNGs at DPR 1 and 2, light reads from the upper-left, contrast inside unchanged (≥ 4.5:1).

### 9.6 Stepped enter and exit `[CU-6]`

- **Change:** one curve `--cv-step-in: 120ms steps(3, end)` in `reset.css`; the Activity Panel, modal and popovers enter and exit through `@starting-style` + `transition-behavior: allow-discrete` in integer 4 px steps (today the panel slides smoothly for 160 ms and exits instantly, `activity-panel.css:20, 31-34`, `ActivityPanel.js:1367`); the tooltip stays instant; every rule has a reduced-motion cut.
- **Cost:** 0. **Impact 2 · Effort S.** **Acceptance:** no mid-transition frame shows bitmap text at a fractional x; reduced motion cuts in one frame; the world canvas resizes once per open or close.

### 9.7 Calm Dashboard transitions `[D2]`

- **Change:** (a) FLIP a card whose parent changes (row ↔ bell lane) and the sections below it in `DashboardRenderer.render()` (`:595-695`): translate only, 240 ms `cubic-bezier(.2, 0, 0, 1)`, gated on `_motionQuery`. (b) The mode crossfade: 0.3's frame-colour bands and no-black cut ship first; a document View Transition (`ModeManager.switchMode`, `:19-24`) with a 220 ms linear root crossfade — paused on `transition.ready` until `world:first-frame` or a 900 ms cap, never awaiting first-frame inside the update callback — is optional and lands only if a quiet-host W → D crossfade starts ≤ 150 ms (loaded host measured 113–425 ms) and the snapshot memory is acceptable (ChromeUI rejected it for a ≈ 29 MB snapshot at 5120; M18).
- **Cost:** compositor transforms on lane changes; one snapshot per switch. **Impact 4 · Effort M.** **Acceptance:** a dense-24 screencast with one agent set to waiting shows the card travel to the lane in ≤ 280 ms with no scaled frames; reduced motion cuts.

### 9.8 A richer, truthful LAST 10 MIN tape `[D3]`

- **Change:** `ObservedCallTape.js` buckets store `{ act, look }` counts and exception statuses per bucket; paint up to three 3×3 blocks per bucket (act `#d9c9a3`, look `#8c7c64`), a 4×2 status band in the status token, and unobserved buckets as one 1 px dot on the baseline instead of the full-height hatch that reads as a loading bar; tape 160×16 (`dashboard.css:18, 511`); update the legend, README and tests.
- **Cost:** 0. **Impact 4 · Effort M.** **Acceptance:** on tab open rows show a dotted baseline plus real ticks; after a waiting → working cycle the band covers exactly the observed buckets.

### 9.9 Faces that read `[D4]`

- **Change:** `cropScale: 2` for the `niche` box (`AvatarCanvas.js:157`) with the window anchored lower (`sy = crop.y + floor((crop.h − winH)·0.75)`); an optional per-character `portraitFace: { x, y }` beside `portraitCrop` in `manifest.yaml` for characters that crop badly; an optional roomy 64 px tier when content is < 60 % of the viewport (with 0.9).
- **Cost:** 0. **Impact 4 · Effort S.** **Acceptance:** every roster character shows eyes and hair in the 44×40 niche at integer 2× nearest.

### 9.10 Bell-lane age tiers `[D5]`

- **Change:** `data-age` from `rowWaitAnchor` in `_updateCallBlock` (`DashboardRenderer.js:1278-1324`): '2' ≥ 5 min fills the elapsed plate in the spine colour, '1' ≥ 1 min rims it; per M18 an 8 px PS2P `ANSWER FIRST` under the first card's clock (the card `A` focuses); no animation.
- **Cost:** 0. **Impact 3 · Effort S.** **Acceptance:** `many-waiting` shows filled plates only for waits ≥ 5 min and `ANSWER FIRST` only on the first card.

### 9.11 The selected detail as a session strip `[D6]`

- **Change:** a 480×48 canvas beside the hero drawing 9.8's tape at 3× with fetched `toolHistory` entries as 1 px transcript-timed ticks on the same axis (labelled TRANSCRIPT, distinct from browser-observed blocks); only the selected agent is fetched, as today.
- **Cost:** 0. **Impact 3 · Effort M.** Depends on 9.8.

## Lane B — Budget (parallel; pays for dense-100 at 120 Hz and OF-012)

### B.1 Collapse the draw stream `[PB-2, PB-6]`

- **Problem:** 449–559 batches per frame, 407–487 holding a single record (tree prop caches 305–343 batches, tree casts 84–108); night occlusion re-issues them (draws 452 → 789 at dense-24). Each record is staged as 6 vertices × 11 floats (584 KB/frame at dense-100 z1, 1.30 MB at survey).
- **Change, in two parts.** **B.1a — instanced layout (early, right after 0.1a, before 0.6):** one instance per record in V9's layout with `vertexAttribDivisor` and `drawArraysInstanced(TRIANGLE_STRIP, 0, 4, n)`, instance attributes re-pointed per batch (WebGL2 has no base instance); later items only add V9 fields. **B.1b — texture-array pages (after 2.2, which deletes the occlusion pass):** pack sidecar-less families (tree lean frames after 0.7, tree casts per sun bucket, ground stamps) into `TEXTURE_2D_ARRAY` pages with a per-record layer index, so those families batch together; batches with sidecars break on texture as today. The earlier "8-slot multi-bind" design is dropped: GLSL ES 3.00 only indexes sampler arrays with constants, the fragment stage has 16 units and units 0–5 are already bound, and PB's 36–41-batch simulation assumed 32 samplers; re-run the simulation for array pages.
- **Cost:** substitutes up to ~400 draws/frame (~0.4–0.6 ms main-thread issue at dense-100) and 0.5–1.1 MB/frame of `bufferSubData`. **Impact 3 · Effort M.** **Acceptance:** B.1a — identical frame hash at a fixed pose, vertex buffer ≤ 1/5 of today, stage p50 halved; B.1b — dense-100 z1 1080p ≤ 80 batches by day and ≤ 160 draws at night, gpu-world segment p50 ≥ 0.4 ms lower same-session, frame hash identical.

### B.2 Memory `[PB-3]` (OF-012)

- **Change:** under V9's one channel contract (the occluder B channel is also 2.3's surface code), pack equipped-sheet material + occluder into one canvas (R material id, G height, B occluder strength, A presence) and create emissive sheets only for profiles with authored emission (`AgentSprite.js:445-451`); evict unpinned sheets at the cap and show pinned overage on Shift-D; the same packing for world-pilot and agent-atlas channels; release the terrain CPU canvas after upload on the resident path (re-bake on context loss); upload `ground:semantics` through dirty-rect `texSubImage2D` (`GpuWorldRenderer.js:1129-1190`); consider `depth: false` on the context (0.6's note, ≈ 27 MB at 4880×1392 [INFERENCE]).
- **Cost:** 0 (−50 % agent-atlas channel upload bytes, −27 MB/s `ground:semantics` upload at 5120×1440). **Impact 2 · Effort M.** **Acceptance:** GPU-process footprint at dense-100 1080p ≤ 1.0 GB (today 1,371 MB); `gpuEquippedSheetEstimateBytes` ≤ 192 MB (today 426.5 MB); no pixel diff at a fixed pose; Canvas parity checked.

### B.3 Council-ring and hairline cues as segment records `[PB-5]`

- **Change:** in `GroundCueRecorder.stroke()` (`GroundCueRecords.js:733-780`) flatten each curve to ≤ 8 segments and emit one oriented quad per segment with the 1-px art-grid line test in the scene shader under a cue-atlas material code (fallback: cache a team loop's records by quantized member positions). Cue records are 64–85 % of all resident records (346 at dense-24 z1, 3,256 at dense-100 survey).
- **Cost:** substitutes ~0.4–0.9 ms appRender. **Impact 2 · Effort M.** **Acceptance:** cue records at dense-100 survey ≤ 900; appRender p50 ≥ 0.5 ms lower; ring pixels hash-identical.

## Wave 10 — The platform frontier (approved, M19; follows Waves 1–3)

The maintainer is enabling HDR on the G95C and watches on the XDR laptop too (M1), so HDR now reaches both screens. Stage A of 10.1 can start once B.1a/V9 and 0.6 land; its WGSL twins port the WebGL2 shaders after Waves 1–3 have settled them, so the pixel-parity gate compares final shaders, not moving targets.

### 10.1 A WebGPU backend behind the WebGL2 fallback, staged `[WPG-3]` (OF-008)

- **Why:** on an SDR screen nothing in this plan is blocked by WebGL2 — the depth-sorted particles (0.6), fat-pixel sampling (4.6), 2.5D light (2.1) and radiance cascades (2.10) all run on WebGL2 — and the pixel-identical replay prototype measured WebGPU equal at 1680×1032 and 10–30 % lower at 4880×1392. WebGPU uniquely brings HDR present (10.2), which M1 puts on both of the maintainer's screens, plus trustworthy per-pass timestamps and Safari/Firefox GPU timing.
- **Change (staged):** Stage A (L) `gpu/GpuWorldRendererWebGPU.js` implementing the exact resident interface over the same `GpuSceneBuilder` record stream, WGSL twins as JS template strings (a `GRADE_WGSL` generated beside `GRADE_GLSL` from the same constants), records in a storage buffer drawn instanced per batch, timestamps feeding 0.1's ladder, 0.6's painter's depth as a transient attachment, `device.lost` rebuilding like `GpuWorldRenderer.js:810-832`, opt-in via `?renderer=webgpu` (backend selection at `IsometricRenderer.js:1563-1582` and `resolveGpuWorldRendererMode` becomes async). Go/no-go gate: a parity harness (≤ 1 LSB on ≥ 99.9 % of pixels across ≥ 8 scenario frames incl. night, storm and dense-100), gpu-burst FULL cost ≤ WebGL2 at 1680 and 4880, device-loss recovery. Stage B makes it the default in Chrome where `navigator.gpu` is available once the gate passes; Firefox stays on WebGL2 and Safari needs its own parity check before it defaults. Stage C adds 10.2 and 10.3.
- **Cost:** substitutes the WebGL2 path. **Impact 3 · Effort XL.**

### 10.2 Tier-H HDR highlights on the WebGPU presenter `[CH-3]`

- **Precondition:** T1 plates, beacons and bells become GPU mark records (or move to a WebGPU overlay) before any role-1 gain ships. They live on the 2D overlay today, which cannot present HDR, and emitters must never outshine the action-needed marks.
- **Change:** the emission attachment becomes `rgba16float` with a role in alpha (0 none, 1 building/prop emitter, 2 action-needed mark); the composite multiplies linear light for role pixels only, in stepped courses while lamps are lit, with the verified-success cream peak frame at the mark gain for its single frame. A Settings control **HDR highlights: off / subtle / full, default subtle** (M1): subtle = emitters up to 1.5×, marks 2.0×; full = emitters 1.35/1.65/2.0×, marks 2.5×; marks always ≥ the emitter peak + 0.5. `rgba16float` + `toneMapping: { mode: 'extended' }` only when `(dynamic-range: high)` matches (re-evaluated on `change`) and the setting is not off; it replaces the blurred bloom downsample while active. SDR screens get byte-identical frames.
- **Cost:** substitutes bloom while HDR is active; ≈ 15 ALU on role pixels (0.9 % of the frame) on HDR screens only. **Impact 4 · Effort L.** Reaches the XDR laptop and the G95C once HDR is enabled there (M1). A WebGL2 → WebGPU bridge was measured at +0.9 to +4.1 ms and is rejected.
- **Evidence:** CH `proto/color-hdr/index.html` (real 22:00 frame; split mode and viewing steps in the note §5).
- **Acceptance:** on the XDR and on the HDR-enabled G95C in Chrome, `NSScreen.maximumExtendedDynamicRangeColorComponentValue` > 1 while a lit night scene is on screen and returns to 1 with the setting off; 0 px differ from the SDR frame on SDR screens and headless; no pixel gains above the selected mode's mark gain (2.0× subtle, 2.5× full); every mark pixel is brighter than every emitter pixel.

### 10.3 Reserved-role wide gamut on P3 screens `[CH-4]`

- **Change:** only when `(color-gamut: p3)`: `drawingBufferColorSpace = 'display-p3'` on the world canvas with an sRGB→P3 matrix at the end of the composite (colorimetrically identical for world pixels) and a ×1.22 chroma stretch for emission-MRT pixels; overlay 2D context in `display-p3`; `P3_VARIANTS` for reserved status and C4 hues generated from `proto/color-hdr/p3-ramps.json`; water, void, ground and pennants never remapped.
- **Cost:** ~0.02–0.05 ms on P3 screens only [INFERENCE]. **Impact 2 · Effort M.** **Acceptance:** 0 px differ on sRGB screens; on the XDR, non-role pixels ΔE_ok = 0 and role pixels gain chroma with |ΔL_ok| < 0.005 and |Δh| < 2°.

---

## Killed and rejected

Kept from the aesthetic plan's list (still binding; see its lines 440–452): spectacle to fake mood (bloom/grain/CRT increases, god rays or volumetric beams on the resident path — bent only for 2.7 under M22 — brighter lightning, more rain streaks, pitch-black nights); per-frame full-screen passes, a second grade pass or render target, per-pixel animated wave shaders and per-frame GPU ground blending (the water motions of Wave 3 bend the last two by name under M7); smooth gradients and blur; non-integer resting scales; regenerating Wang sheets; distant shore, skyline or bigger island; cloud-sea or floating-island framing; simulated tides; weather, sky tint or birds driven by agent state; a third typeface; animated label entry; world-scaled labels; hiding action-needed marks; walking avatars per Dashboard row, KPI tile grids, the World → Dashboard morph; tinting the chrome cool; passive roof fades.

New this round, with reasons:

- **Screen-space radiance cascades or JFA SDF shadows on the iso frame** — flatland treats every facade as a wall between a window and its own street, reproducing the measured self-occlusion (LGI). 2D light propagation volumes — superseded by RC. Full normal-mapped sprite lighting — breaks the baked key; the 2-bit face class (2.3) suffices.
- **Re-landing OF-010 as specified** — its field cannot reach receivers baked into landmark sprites and its elevation gate read a row ramp; superseded by 2.1–2.3 (M6).
- **Tens of thousands of GPU compute particles** — +0.4–0.7 ms at 100k with no truthful use; the app caps at 240 event-driven particles (WPG). Transform-feedback particles as the default — 2.5–4× the stateless price.
- **OffscreenCanvas/worker rendering (OF-007)** — trigger unmet; long tasks 0 in 36 of 37 rows. Render bundles and multi-draw — 0.02 ms saved. Frame skipping — 0 % identical consecutive frames. Scissoring passes to the island — a full-screen pass is ≤ 0.05 ms at 5120×1440.
- **Raising `MAX_LIGHTS` by itself** — only 9–16 low-rank candidates are dropped; the real darkening is the ladder (0.1); more lights arrive only with clustering (2.4).
- **An art-resolution world target with a sharp-bilinear composite (PB-4, t3ssel8r architecture)** — puts moving bodies back on whole-texel steps; 0.4 + 4.6 reach the motion goal and B.2 the memory goal. cleanEdge as a live sampler — 25–36 ms per Mpx and redraws 6–9 % of pixels at rest; bake-time rotation only (3.8). Fat-pixel sampling at k = 1 and non-integer resting zooms — they blur at rest. Blue-noise dither — reads as grain. Shader outlines, TAA, motion blur.
- **HDR through WebGL2, CSS HDR colours, a WebGL→WebGPU copy bridge, a Canvas `float16` overlay** — WebGL has no `drawingBufferToneMapping` (KhronosGroup/WebGL#3668), CSS HDR colours are unsupported in Chrome 153, and the bridge costs 0.9–4.1 ms; HDR ships only through the native WebGPU presenter (10.1–10.2). A linear-light regrade — ΔL_ok ≤ 0.05 for retuning three rounds of approved constants. A 3D LUT or output deband pass — no unintended banding measured; the analytic grade has zero quantization.
- **Environment coupled to agent state in any form** — weather, fog, snow, gulls, sky, sea liveliness (including halving it while T1 plates show), sky rewards for pushes, camera grade tints and a distress-driven beam (V3, 0.2, M22).
- **Work wear / desire paths from observed traffic (TF-6, SM-6)** — rejected by the maintainer (M13, 2026-09-28): the ground never records history.
- **Dropped without an item, with reasons:** the second sun/moon crowding at 06:00 (plausible); a rank number per bell-lane card (noisy in the prototype); a pixel cursor over the world. **Triage, not an item:** faint 1-px anti-aliased diagonals over night water at z3 (AD regression 9; [INFERENCE] relationship tethers on the ground-cue layer) — the 0.8 owner finds the source and moves it to the pixel grammar or deletes it.
- **Whole-scene screen-space mirrored reflections** — they mirror labels and marks and fail under iso occlusion; baked statics (3.7) and flagged records (3.11) instead. Gerstner or normal-mapped waves and smooth UV distortion. Fish shadows (invented life). Re-adding waterfalls (still no source). Real local weather via geolocation or an API (a network dependency and a privacy cost). Raymarched clouds and god rays.
- **Grass that parts under walkers and live footprints** — they would need live records (ground cues already cost 0.4–0.9 ms); villagers touch sand in 1 of 1,920 samples. Live-updating desire paths — 100–230 ms hitch per rebake. Mirroring trees or E↔W character art — flips the key light. Upscaling current trees — a mixel scale.
- **Procedural cape/hair sway, locomotion smear frames, facial emotes, head-only look-at, idle micro-strips, pro-mode roster animation** (CM) — pixel grammar, illegible at 11–13 px faces, implied feelings, or cost without information.
- **A "thinking" mote, token rate as speed or plume, wait age as a slumping body, celebration on tool completion or sub-agent return, camera shake on failure** (SM) — unobservable or untruthful semantics, or they break Ambient ownership.
- **Foreground framing elements, time-of-day-chosen opening subjects, a panoramic truck on every boot, longer continuous dollies before 4.6, DOF/tilt-shift** (CC).
- **`create_building_kit` and `animate_object` for landmarks** (they need PixelLab object ids; `animate_image` returns frame 0 unchanged); decorative harbour workers; ships sized by diff lines (BL).
- **Same-document View Transitions for panels, `interpolate-size`, `corner-shape: notch`, `popover=hint`/`interestfor`, a pixel cursor over the world, glyph-only READ/AMBIENT, per-row token sparklines without a per-minute series, `display: grid-lanes`** (CU, D) — Chrome-only, anti-aliased, unsupported, or no data.
- **Recessing T3 plaques at wide tiers** — measured no salience gain for T1 (AD). A 9th "afternoon" grade key — breaks the 8-name audio coupling; `approach` does the job.

## Maintainer decisions (settled 2026-09-28)

Asked and answered in one session. "Answer" is the maintainer's; where it differs from the coordinator's recommendation, the item text above already carries the answer.

| ID | Decision | Answer |
| --- | --- | --- |
| M1 | Viewing conditions | Watches on **both** the G95C and the XDR laptop about equally; **window width varies** (verify at 5120 and 2560); usually rests at **z2**; **will enable HDR** on the G95C (re-probe before 10.2/10.3) |
| M2 | Remove agent-driven environment effects (0.2) | **Remove all**: fleet weather, dry-day flurries, release/push gull effects, drift suppression, fog nudge, glide/chapter/tour tints, push and sub-agent sky rewards |
| M3 | Fog at 13.7 % of minutes | **Keep the odds**; fog lands with 0.10's stepped courses |
| M4 | C3 in motion | **Approve** 0.4's backing-pixel walks and 4.6's fat-pixel flight frames; **adopt the continuous dolly** (4.6) |
| M5 | Wall facing and 2-bit surface class for night lights | **Approve; hand-author** Harbor, Lighthouse, Observatory, Portal |
| M6 | 2.5D light, OF-010, clustering, radiance cascades | **Approve** the move and OF-010's closure; clustering **only if its receipt pays**; 2.10 **pilot after 2.1–2.4** |
| M7 | Sea liveliness and the sun/moon path | **Calm, animated** (≤ 35 % ever-changed over 3 s; the open ocean shares the phase); **allow** the `seaPath` stops |
| M8 | Camera shot scales, Ambient, horizon | **Approve** Auto at `scales.wide` and Ambient cohorts at `scales.medium`; **Ambient persists**; horizon in the **survey and opening shots only** |
| M9 | Winter | **Approve** snow only after the village's own winter precipitation; **northern hemisphere, no setting** |
| M10 | PixelLab spend | **Up to 1,000 generations** of the 1,262 remaining (maintainer, 2026-09-28): "use it as long as it makes ClaudeVille more awesome". Allocation below |
| M11 | Villagers reflect on water | **Approve, cap 12** |
| M12 | Rest seats and the petitioner queue | **True seated frames** (PixelLab, pilot first; lowered-body fallback per profile); **approve the queue** |
| M13 | Work wear | **Rejected** |
| M14 | Dock, control merge, frame kit | **Approve the dock**; **merge Auto and AMBIENT now** into `FREE / AUTO / AMBIENT`; **approve the frame kit** |
| M15 | Touch approved art (doors, glass, emissive ramp) | **Approve all three** |
| M16 | Release pennant and Chronicle dressing | **Pennant for the local day: yes**; **dressing tiers: approve** (6.7 is no longer optional) |
| M17 | Colour script | Golden hour **tuned within 1.12–1.20** against the salience guard; sunrise **rose and mist** |
| M18 | Dashboard | **Ultrawide columns: yes**; **bands and cut now**, View Transition only if it passes its gate; **`ANSWER FIRST`: yes** |
| M19 | WebGPU, HDR, P3 | **Full frontier**: 10.1 Stage A → gate → Stage B default in Chrome; 10.2 HDR highlights with a **user setting, default subtle**; 10.3 P3 roles |
| M20 | Side-on work facing | **Approve** |
| M21 | DPR-2 zoom rungs | **Add k = 3/k = 5 rungs; keep today's default zoom** |
| M22 | Lighthouse beam | **Constant calm night beam**; distress mapping removed |
| M23 | Hulls as resident GPU records | **With 3.8** |
| M24 | Activity panel overlay | **Only if** reallocations measure as a hitch after 0.3 (b) |
| M25 | Call card content | **Observed facts only** |
| M26 | Ladder pacing rule; dense-100 at 120 Hz | **Approve** the half-period pacing rule; **require Lane B** for dense-100 at 120 Hz |
| M27 | Working travel speed | **Keep the 1.5 rung** |

## PixelLab spend plan (cap 1,000 generations; nothing generated yet)

The maintainer set a cap of 1,000 of the 1,262 generations remaining on 2026-09-28. Spend runs in three phases; before each phase the lane re-reads the balance with `get_balance`, and stops at the cap. Every generation goes into the provenance ledger with its item id. Unspent phase budget rolls forward; a failed pilot frees its later phase for the next item on the list.

| Phase | Item | Cap | Route |
| --- | --- | --- | --- |
| A — pilots (≤ 100) | 7.3 work/wait strips pilot (Sonnet + gpt55, strike + wait, 4 facings) | 40 | `animate_with_skeleton_v3`, feet keypoints copied |
| | 7.1 sit-strip pilot (2 profiles × 4 facings) | 24 | `crouching` template, skeleton-v3 for armour |
| | 5.5 tall woodland oak, one candidate round | 30 | `create_1_direction_object` at native 1× |
| B — landmark and world assets (≤ 400) | 3.8 hull classes at display size | 40 | `create_map_object`, or `pixelart_workbench` at 0 |
| | 6.2 Command gate (leaf ≥ 78 px) and door strips | 72 | masked inpaint confined to the arch (≤ 60); `animate_image` doors (≤ 12) |
| | 6.1 building part strips (crane, bellows) | 24 | `animate_image` (frame 0 unchanged) |
| | 6.7 Chronicle dressing props | 18 | `create_map_object` |
| | 5.5 tall pine and willow, bare-winter oak and willow, snow-laden pine | 246 | `create_1_direction_object` / `create_object_state` |
| C — villager rollout (≤ 500) | 7.1 sit strips for the roster | ≤ 200 | template first, skeleton-v3 only where the template fails the feet audit |
| | 7.3 wait strips for the roster (the action-needed pose) | ≤ 208 | skeleton-v3 |
| | 7.3 strike/tinker/gaze for the most-seen profiles, with what remains | remainder | skeleton-v3 |

Not funded inside the cap (hand-authored or deferred): the full 7.3 strike/tinker/gaze rollout (~936), 7.5 run strips (208–832), 3.5 procedural-fallback boulders (only if the procedural stones fail review, from any unspent remainder), the 8.2 sloop (reuse an existing hull).

## Sequencing, ownership and parallelism

```
0.1a measurement (1-in-4 timer, gpu-burst, K8 bench) ── before any receipt in this plan
0.1b ladder policy (parallel; accepted after 0.2 lands, so rain and storm rows exist)
0.2 + 0.10 weather truth, fog, haze, lightning ─► 0.7 wind ─► 3.4 sea weather, 5.1 seasons ─► 5.2 ground state ─► 6.6 wet slate
B.1a instanced layout + V9 ─► 0.6 painter's depth ─► 2.1 ─► 2.2 + 2.3 (channel contract first) ─► 2.4 (with 6.3's room masks), 2.5–2.9, 2.10 (optional)
1.3 sidecars ─► 1.2 knee; 1.1 constants ─► 3.1–3.3 (read the graded sea colour) ─► 4.6 (after 2.1 and 3.3; M4)
0.4 + 0.5 bodies ─► 4.7 gait strips; 7.1 + 7.2 seats and queue (zero spend); 7.3 strips (pilot first, M10)
0.6 + 0.8 ─► 6.1 parts and emitter cycles, 6.3 rooms (V8 isWorkingVisitor); 2.3 ─► 5.2 roof snow
4.1–4.5 camera any time (4.1 receipts fold into 0.1's budget); 4.6 last     Wave 8 after 3.8 and 9.1's reserved rects
Wave 9 DOM throughout; B.1b and B.3 after 2.2; B.2 after the channel contract; 3.8's GPU hulls after B.1a and 0.6, lit after 2.1
Wave 10: 10.1 Stage A after B.1a and 0.6, gated after Waves 1–3; 10.2 after T1 marks become GPU records and the G95C HDR re-probe; 10.3 with 10.2
PixelLab Phase A (pilots) any time; Phase B with Waves 5–6 and 3.8; Phase C after the 7.1/7.3 pilots pass
```

- **Disjoint owners:** ladder and GPU policy (`gpu/GpuWorldRenderer.js` ladder and light loop, `postfx/PostFxLadder.js`, `gpu/GpuWorldPolicy.js`); atmosphere (`AtmosphereState.js`, `WeatherRenderer.js`, `SkyRenderer.js`, `SeasonalAmbience.js`, the weather section of `WorldFrameRenderer.js`, `VillageDirector` weather parts, `application/MoodService.js`); bodies (`AgentSprite.js`, `AgentGroundMarks.js`, `MovementSteering.js`, the avoidance section of `IsometricRenderer.js`, the agent atlas in `GpuSceneBuilder.js`); water and coast (`CoastBake.js`, `applyWaterState`, `HarborTraffic.js`); camera (`Camera.js`, `CameraCurves.js`, `CameraDirector.js`, `AttentionFraming.js`, the App reveal); ground and foliage (`GroundBake.js`, `FoliageRenderer.js`, `SceneryEngine.js`, `config/artPalette.js`); buildings (`BuildingSprite.js`, `BuildingVisualRegistry.js`, `manifest.yaml`, `ChimneySmoke.js`, `scripts/world/validate-buildings.mjs`); moments (`EffectStamps.js`, `ChronicleMonuments.js`, `ArrivalDeparture.js`, new `config/townPlan.js`); DOM (`css/`, `index.html`, TopBar, Sidebar, ActivityPanel, `dashboard-mode/`).
- **Hotspots with one integration owner per wave:** `GpuWorldRenderer.js` (0.1, 0.6, 1.x, 2.x, 3.1–3.4, 4.6, B.1), `GpuSceneBuilder.js` (0.6, 0.7, 2.1, 2.5, 3.11, 4.7, B.1, B.2), `BuildingSprite.js` (0.8, 2.1, 2.4, 2.6, 2.7, 6.1–6.5, 7.1), `WorldFrameRenderer.js` (0.2, 0.6, 0.10, 5.2), `IsometricRenderer.js` (0.2, 0.3, 2.1, 7.4) and `AgentSprite.js` (0.4, 0.5, 3.8, 4.7, 7.1, 7.3). 0.2 also edits `Camera.js` and `CameraDirector.js`, which the camera owner holds.
- `townPlan.js` seat and queue slots are one registry shared by 7.1 and 7.2; ground bakes (5.x) keep those tiles walkable and unoccluded.

## Budget and measurement

Measured by PerfBudget and WebPlatformGPU on a loaded host (V2 re-prices every row):

- **The real frame is main-thread-bound, not GPU-bound.** Vsync-unlocked frame p50/p95 at FULL: dense-24 1080p 3.7/4.8 ms, dense-24 5120×1440 3.9/5.0, dense-100 z1 1080p 7.1/9.0, dense-100 survey DPR 2 8.2/10.3. At 60 Hz the headroom is ≈ 6–12 ms; at 120 Hz dense-100 is already over at p95, so new per-frame CPU work needs a matching Lane B cut.
- **Timer-free GPU cost of the real FULL frame:** 1.27 ms (1680 z1) to 4.02 ms (4880×1392 z2 night); FULL vs MINIMAL differs by only 0.1–0.5 ms of unlocked frame time.
- **Candidate prices (K8 slopes, ms/frame at 1920×1080 / 2560×1440 / 3840×2160 / 5120×1440):** an extra full-screen RGBA8 pass 0.025 / 0.021 / 0.061 / 0.046 (RGBA16F about the same, 2× bytes); a 256×144 or 480×270 lighting field (3 passes) 0.05–0.18; a CPU-built 256×144 field upload ≈ 0.012 ms CPU; stateless particles 10k 0.02–0.06, 50k 0.12–0.34; transform feedback 10k 0.11–0.16; a 150-sprite reflection to a half-res target ≤ 0.01 slope; each extra pass has a ~0.03–0.05 ms fixed cost, so minimize pass count before pixels. Most items in this plan add no pass.
- **Memory:** GPU-process footprint 1,018 MB (dense-24 1080p), 1,404 MB (dense-24 5120×1440), 1,371 MB (dense-100), 1,803 MB (dense-100 DPR 2); 5120×1440 DPR 1 carries the same 66 MB of attachments as 1920×1080 DPR 2. New textures in this plan: depth16 (+13.6 MB at 4880), the coast field (1.2–2.4 MB), the cycle offset (≤ 0.8 MB), the RG8 footprint field (≈ 0.8 MB), the light texture and tile index (< 0.5 MB), room masks (small), minus the occlusion target (−0.97 MB) and minus ≈ 1.6 MB of per-tree textures; 4.7's walk strips add up to ≈ 16 MB inside the existing 48 MiB cap; B.2 recovers far more.

## Verification matrix

| Change | Evidence required |
| --- | --- |
| Any `src/` change | `npm run verify:render` exit 0, plus visual judgment on the maintained server at 5120×1440 DPR 1 and one DPR-2 viewport (V1) |
| Ladder (0.1) | 180 s free-ladder histograms at 5120×1440 and 1920×1080, dense-24/dense-100, 12:00/22:00 and pinned rain and storm; GPU-side injected-load demotion; steady-60-on-120 Hz demotion; headed 120 Hz run; Dashboard-return resume; `scripts/tests/postfx-ladder.test.mjs` |
| Anything with a frame cost | V2 receipt (K8 slope at two resolutions, unlocked FULL/MINIMAL delta, A/A spread) on a quiet host; Shift-D shed line; `world:benchmark-trails` where camera invalidation changes |
| Weather and environment (0.2, 0.7, 0.10, 5.x) | Timeline statistics over 365 dates; `cause === 'timeline'` probes in agent-heavy scenarios; regression tests that agent input cannot change weather and that no snow spawns on a dry winter minute; a push or release changes no sky, gull or fog pixel; canvas-call probe for gradients and strokes |
| Grade and light (1.x, 2.x) | Pinned fixed-camera series with luma/saturation/R−B tables (V6); registered same-frame A/B buffers for lit-pixel counts; value-ladder OKLab measurement; Canvas parity |
| Motion (0.4, 4.6, 4.7, 7.x) | Frame-stepper traces: step CV, hold histograms, facing deltas, head range per profile; kymographs; reduced-motion frames byte-identical |
| Water and sea (3.x) | 2 s screencasts with per-step changed shares; palette-membership check on the ungraded albedo (C1, CoastBake, `seaPath`); 1-texel run measurement at z3; tile-period check across a 5120 z1 frame |
| Particles (0.6) | Magenta probe on resident WebGL; depth A/B at the Forge |
| Camera (0.3, 4.x) | Frame-accurate boot, selection and mode-switch recordings (luma per frame, centre deltas); `shotScaleTiers` unit tests |
| Buildings and assets (6.x, 3.8, 5.5, 7.3) | `npm run world:validate-buildings` (extended per 0.8); `npm run sprites:audit-refresh`; `sprites:capture-fresh` + `sprites:visual-diff`; `npm run art:analyze`; ±2 px feet audit for strips |
| Terrain bakes (3.3, 3.5–3.7, 5.x) | `npm run world:validate-terrain`; bake times re-measured on a quiet host |
| DOM (0.9, 9.x) | Screenshots at 1280/1440/1920/2560/5120, DPR 1 and 2; computed-style audit for off-grid type; keyboard walk |
| Structure and docs | `npm run verify:architecture`; `npm run check:artifacts`; README and `docs/motion-budget.md` rows for every new motion |
| Release | `npm run gate:release`, and the OF-006 soak before a push |

## Definition of done

- Every item is implemented, or explicitly not done with a reason and evidence, in an execution record appended to this file.
- The ten-item headline is visible in a before/after contact sheet at the same pinned cameras on the **5120×1440 DPR 1** main viewport and one DPR-2 viewport: wide day, wide golden hour, wide night, wide storm, z2 dense-24, z3 detail, many-waiting, the Dashboard, and a chrome close-up.
- With the ladder free, dense-24 at 5120×1440 60 Hz holds FULL for ≥ 98 % of frames; no item regresses the unlocked frame p95 beyond its V2 receipt.
- No environment pixel changes with agent state (V3 probes), and every new motion has a static reduced-motion frame.
- Docs follow the code: `character-mode/README.md` (draw order, contracts V1–V9), `docs/motion-budget.md`, `docs/building-style-contract.md`, `docs/material-channel-contract.md` (the occluder channel contract), `docs/world-visual-qa-checklist.md`, `DESIGN.md` (frame kit), and the open-followups ledger (OF-009, OF-010, OF-011, OF-012, OF-014 closed or updated as their items land).

## Council review (applied)

Three read-only Opus 5.5 reviewers (max effort) checked the draft on 2026-09-27: **truth and sequencing** (verified the seed-0 timeline and the fleet path by importing the modules, reproduced the fixed-seed weather table, and confirmed the ladder and light-cap lines), **technical feasibility** (read every cited GPU, camera and bake anchor), and **fidelity to the evidence** (mapped all ~120 explorer items to plan items). Their findings changed the plan as follows:

- **Truth.** The daytime distress beam became "no beam by day" and the Lighthouse's distress mapping became decision M22 (it was an agent-driven change to sky and sea). 0.2 now also removes dry-day winter flurries, the release-crown and push gull effects, the push fog nudge and a second `getWeatherInfluence` reader, and its grep acceptance no longer forbids the legitimate word `fleet`. Attention light never touches water (2.5). V8 gained `isWorkingVisitor`, so seats, queues and inferred legs never animate or light a building. Every environment bend now has a row and a decision (M22–M27 added).
- **Technical.** 0.1's period is latched from warm-up and snapped to standard rates (a median of achieved gaps would never shed a steady 60 fps on a 120 Hz panel); promotion and the revert guard follow pacing; Dashboard returns resume their level; 0.1 splits into measurement and policy. A new contract V9 owns the instanced record layout, the sampler table, typed uploads and the occluder channel; B.1 splits into early instancing and later texture-array pages (8-slot multi-bind cannot be built in GLSL ES 3.00). 0.6 gained the depth-state, clamp, soft-alpha, air-emitter sortY and bloom-alpha details. 4.6 became per-batch, projects lights and the ocean with the same sub-pixel offset, lands after 2.1 and 3.3, and prices its steady-state cost. V5 keeps `kind` and adds `role`; `stepPool` takes attention separately. 2.2's field carries a landmark id; the occluder upload no longer disappears at MINIMAL. 3.1 identifies stops on ungraded albedo; 3.3 prefers a composite-drawn ocean on the shader's clock; 3.4 breaks the cloud tile period. 4.1's cost is no longer called free.
- **Fidelity.** The top ten now carries every item's prerequisites (1.3, 2.3) and prefers real-app evidence (3.4, 0.3) over painted mocks (3.3, 6.3). Restored: AD-5 pool chroma (1.2), CH-1's plate-brightness and chroma criteria, CH-3's marks-first precondition and acceptance (10.2), the dawn ground-haze regression (0.10), the SW-2 squall, tile-period and Canvas parts (3.4), PT-4's river current (3.1), PT-6's other rotations (3.8), the WS raking-cast-on-water contract (2.9), CC-2's pre-renderer band and D's World → Dashboard black frame (0.3), BL's z1 legibility threshold (6.1), the CM scimitar audit (7.3) and the dropped maintainer questions (M1, M6, M8, M25–M27). Corrected: AD ids, the cliff reflection literals, the 4 s wetness release, 2.1's cost claim, ballot credits and the host-load range.

## Execution record

Executed 2026-09-28 → 2026-09-29 by an orchestrator and Opus 5.5 implementer, fixer and auditor agents, one commit per phase: P1 `3e0d876` (foundations and truth), P2 `5f4abfe` (light, sea, land, buildings, villagers), P3 `6559335` (aperture light, sea form, fat-pixel flight, roofs, release sail), P4 `ee145a3` (WebGPU, GPU marks, HDR, P3); **P5** is the closure commit that carries this record (3.5 completion, V3 probes and `smoke:v3-truth`, the docs sweep, the ledger). Each phase was audited, fixed and re-verified before its commit, and each commit records `validate:full` and `verify:render` green. Evidence paths are relative to `output/waking-isle/` (gitignored; local evidence). Performance acceptance (V2 receipts, frame ms) is not judged per row: every run in P1–P4 was on a host at load 4–27, so the receipts come from the quiet-host wave below.

Status: **done** = implemented and its acceptance met; **done with deviation** = implemented, with an acceptance line missed, met another way or scoped down (reason given); **not done** = reason given.

### Items

| Item | Status | Commit | Evidence (local) | Deviation or reason |
| --- | --- | --- | --- | --- |
| 0.1 | done | `3e0d876` | `Ladder/` | Ladder histograms and the dense-100 soak wait for quiet-host receipts ([OF-011](open-followups.md)) |
| 0.2 | done | `3e0d876` + P5 | `audit/AuditWeather/`, `V3Probes/PROBE-TABLE.md` | P5's V3 probes found and removed two late leaks: the Canvas hybrid PostFx "incident pulse" (a full-frame tint on failed push, quota, waiting) and a null override seed coerced to 0 |
| 0.3 | done | `3e0d876` | `FixFrames2/` | |
| 0.4 | done | `3e0d876` | `FixBodies/` | |
| 0.5 | done with deviation | `3e0d876` | `FixBodies/` | `mixed-tools` side-facing share dips to 50 % in 6 of 11 samples (n = 4); dense-24 meets every line |
| 0.6 | done with deviation | `3e0d876` | `GpuCore/` | Footfall parity, reduced-motion and 5120/DPR-2 particle captures not run; magenta probe 315/0, Forge depth A/B and Canvas parity pass |
| 0.7 | done | `3e0d876` + `5f4abfe` | `audit/AuditLand/` | Harbor pennants joined the wind with 6.5 |
| 0.8 | done with deviation | `3e0d876` | `CraftContract/` | No-beam-by-day gate (AD-6) checked by an hour test in Node, never rendered by day; validator, usage stat, chips and plaques verified |
| 0.9 | done | `3e0d876` | `audit/AuditChromeDash/` | |
| 0.10 | done | `3e0d876` | `AtmosFinish/` | |
| 1.1 | done with deviation | `3e0d876` + `5f4abfe` | `FixPools2/` | Land V6 rows pass at 5120 and DPR 2 (sea basis: decision 1); 5120 WebGL golden Y below blue hour (51.0 < 51.8); Canvas T1 salience 12–17 % < 20 % |
| 1.2 | done with deviation | `3e0d876` + `5f4abfe` | `FixPools/` | Knee ships as a value-only variant of V5's `y2/y`; all ladder numbers pass the P3 re-audits (max non-emitter OKLab L 0.837 < 0.84, 0 px reach the T1 plate) |
| 1.3 | done with deviation | `3e0d876` + `5f4abfe` | `Colour/after/` | Forge, Command and Observatory emitters pass; 9–321 px in the 65–160° hue window on some frames, untraced (suspected bloom) |
| 2.1 | done with deviation | `5f4abfe` + `6559335` | `LightCore2/s10/` | Command bodies +50 % lit px unreachable (decision 3; reached ×1.27–1.32); DPR-2 ground coverage outside ±10 % |
| 2.2 | done | `5f4abfe` + `6559335` | `LightCore/s3/` | |
| 2.3 | done with deviation | `5f4abfe` + `6559335` | `Surfaces/viz/` | Storm-night Harbor clause unmeasurable: the Harbor emits no light in that scenario |
| 2.4 | done with deviation | `6559335` | `LightApertures/r7/`, `LightCloseout/` | One aperture per room (merged blobs), `APERTURE_SPILL` 0.35; Command drum room 1's light hidden inside the brazier pool (documented exception) |
| 2.5 | done with deviation | `5f4abfe` + `6559335` | `LightCore2/s11/` | Owner bodies 0 px leak; ~363–400 translucent prop and wall fringe texels still take the owner hue (making them opaque would solidify smoke) |
| 2.6 | done | `5f4abfe` + `6559335` | `LightFx2/fire3/` | |
| 2.7 | done with deviation | `5f4abfe` + `6559335` | `audit3/ReAuditWorld/ReLighthouse/lh/` | Beam ships as lit dash cells on the water footprint, not the sky-additive fan (the open sea fills the void; the fan read as a flat quad); every audited clause passes |
| 2.8 | done | `5f4abfe` + `6559335` | `audit3/ReAuditWorld/ReLighthouse/c28/` | |
| 2.9 | done | `6559335` | `audit6/ReAuditWorldP3/light-columns/` | |
| 2.10 | done with deviation | `6559335` | `RCPilot/final/` | Pilot built and verified, never landed: off at every level (decision 7) |
| 3.1 | done | `5f4abfe` + `6559335` | `audit6/ReAuditSeaP3/` | |
| 3.2 | done | `5f4abfe` + `6559335` | `audit3/ReAuditSea/` | Golden horizon courses: decision 2 |
| 3.3 | done | `5f4abfe` + `6559335` | `audit6/ReAuditSeaP3/` | z1 noon open-sea mode share 60.3 % against the sub-60 % example |
| 3.4 | done | `5f4abfe` + `6559335` | `FixSea2/squall-sweep.json` | Squall precedes rain (10:01–10:30, rain 10:31) in FixSea2's sweep; cloud edges across the coastline not re-audited |
| 3.5 | done with deviation | `5f4abfe` + P5 | `Coast35/` | Boulder coverage brought into 60–80 %, palisade band in the face reflection, `world:validate-terrain` passes; 22:00 face-reflection \|ΔL\| 5.6–5.7 under the ≥ 6 target; at z1 the SW edge still reads straight (map geometry) |
| 3.6 | done | `5f4abfe` | `audit3/ReAuditSea/` | |
| 3.7 | done | `5f4abfe` + `6559335` | `MirrorRoof/` | ReAuditSeaP3's Lighthouse-mirror and storm-ghost fails fixed with measurements; not re-audited |
| 3.8 | done | `5f4abfe` + `6559335` | `audit3/ReAuditWorld/ReShips/` | |
| 3.9 | done | `5f4abfe` | `audit3/ReAuditSea/` | |
| 3.10 | done with deviation | `5f4abfe` | `SeaSurface/` | Caustic net re-derived (the `fract(v1 + v2)` form draws straight stripes); seabed specks authored in the shader, not baked |
| 3.11 | done | `5f4abfe` | `audit2/AuditShipsMoments/` | |
| 3.12 | done | `6559335` | `CanvasParity2/`, `CanvasCloseout2/` | 12:00, 22:00 and rain pairs match; the Canvas cloud field keeps one octave, so partly-cloudy shadow shapes differ |
| 4.1 | done with deviation | `3e0d876` + `5f4abfe` | `FixCamera/` | DPR-2 Ambient wide rests at z1, not 0.5 (rule and acceptance line conflict, README documents it); 5120 establishing shot crops the Archive crown (decision 17) |
| 4.2 | done with deviation | `3e0d876` + `5f4abfe` | `FixCamera/` | Sea ≤ 0.30 everywhere; the 12 % margin holds for at-building cohort members only (Portal chat walkers are not subjects) |
| 4.3 | done | `3e0d876` | `audit/AuditMotionCam/` | |
| 4.4 | done | `3e0d876` | `ChromeA/` | |
| 4.5 | done | `3e0d876` | `audit/AuditMotionCam/` | |
| 4.6 | done with deviation | `6559335` | `audit6/ReAuditWorldP3/dolly/` | Night flight keeps hard 2–3 px lamp columns and pool-rim teeth (accepted, AuditMotion3); Canvas stepped glide reverses off-centre content mid-step (ReDolly rank 1, open) |
| 4.7 | done | `5f4abfe` | `Gait/` | |
| 4.8 | done | `3e0d876` | `audit/AuditMotionCam/` | |
| 4.9 | not done | — (recorded in `6559335`) | `Decisions/` | M24 not triggered: 0/10 open and 0/10 close cycles over 2× the period at 2560 and 5120 ([OF-021](open-followups.md)) |
| 5.1 | done | `3e0d876` + `5f4abfe` | `FixLand/` | |
| 5.2 | done | `5f4abfe` + `6559335` | `audit3/ReAuditWorld/ReGround/`, `FixRoofs2/` | Ground re-audit 10/10; Canvas roof residuals closed later (pool mask off roofs in `CanvasCloseout/`, roof band ruled intended in `CanvasCloseout2/`, well and cart in `WellCart/`) |
| 5.3 | done | `3e0d876` | `audit/AuditLand/` | |
| 5.4 | done | `3e0d876` + `5f4abfe` | `FixLand/` | |
| 5.5 | done | `5f4abfe` + `6559335` | `Woodland/`, `FixGround/` | |
| 5.6 | done as 0.10 | `3e0d876` | — | Moved to 0.10 |
| 5.7 | done | `5f4abfe` + `6559335` | `Ground/` | The deck is off-frame in the DPR-1 opening (reach depends on 4.1/4.5, as the item says) |
| 5.8 | done | `5f4abfe` + `6559335` | `audit2/AuditLandSky2/` | |
| 5.9 | not done | — | — | Rejected (M13) |
| 6.1 | done with deviation | `5f4abfe` | `BuildingsA2/` | Canvas night part emitters (Pharos lens, portal runes, Task board lanterns) grade cooler than GPU; Canvas lantern flicker 4–13 px per step at z1 (ReMotionBldg) |
| 6.2 | done | `5f4abfe` | `BuildingsA/`, `FixBuildings/` | |
| 6.3 | done | `5f4abfe` | `BuildingsB2/` | |
| 6.4 | done | `5f4abfe` | `BuildingsB2/` | |
| 6.5 | done | `5f4abfe` | `BuildingsB2/` | |
| 6.6 | done with deviation | `6559335` | `Roofs3/`, `FixRoofs2/` | Drips and wet course seen live by Roofs3, the final FixRoofs2 round checked offline only; Canvas 22:00 snow parity uncaptured |
| 6.7 | done | `5f4abfe` | `BuildingsB2/` | |
| 7.1 | done with deviation | `5f4abfe` | `FixSeats/`, `FixVillagers/` | Two DeepSeek profiles use the lowered-body fallback (two-fails rule); grok and haiku sit rows hand-edited, not re-checked in scene; seat reached in ≤ 15 s on a settled village, 16.6 s from boot |
| 7.2 | done | `5f4abfe` | `FixVillagers/` | |
| 7.3 | done | `5f4abfe` | `Strips73b/` | All 26 profiles carry wait, strike and tinker in E/W/SE/SW, 10 carry gaze; audit 1,720 frames in 88 groups, feet ±2 px; `read` for six profiles stays open ([OF-009](open-followups.md)) |
| 7.4 | done with deviation | `5f4abfe` | `FixMotion/`, `Gait2/` | Fan ring ±16 × ±8 px, not ±6 (±6 cannot reach ≤ 0.3 overlaps); overlaps ≤ 0.098 per sample, 0 same-heading road pairs |
| 7.5 | deferred | — (recorded in `6559335`) | `Decisions/`, `RunGait/` | Deferred by the maintainer to after the 2026-10-09 PixelLab reset. Pilot (19 generations, 338.6 → 319.6): template failed identity on the robed profile; skeleton-v3 kept identity at ~24 generations per profile; nothing shipped ([OF-020](open-followups.md)) |
| 8.1 | done | `5f4abfe` | `Moments/`, `FixMoments/` | Plaques became moment occluders (0/365 bad anchors) |
| 8.2 | done | `6559335` | `MotionRelease/`, `CueAnchor/` | Crown redrawn after ReRelease's z2 taste fail and tag pushes classify as releases; not re-audited after the redraw |
| 8.3 | done | `5f4abfe` + `6559335` | `FixMoments/`, `CueAnchor/` | `pushFailed` score chain fixed; release crown on peal note 0 (decision 10) |
| 9.1 | done | `3e0d876` | `audit/AuditChromeDash/p91-topbar.json` | Closes OF-014 |
| 9.2 | done with deviation | `3e0d876` | `audit/AuditChromeDash/p92-age.json` | World plate age 1 s ahead of card, sidebar and shelf in 3/77 and 3/32 samples at second boundaries |
| 9.3 | done | `3e0d876` | `audit/AuditChromeDash/p93-busts.json` | |
| 9.4 | done | `3e0d876` | `audit/AuditChromeDash/p94-tip.json` | |
| 9.5 | done | `3e0d876` | `audit/AuditChromeDash/p95-frames.json` | |
| 9.6 | done | `3e0d876` | `audit/AuditChromeDash/p96-steps.json` | |
| 9.7a | done | `3e0d876` | `audit/AuditChromeDash/p97-flip.json` | |
| 9.7b | not done | — | `Dashboard-2/` | Optional (M18); its quiet-host W → D start ≤ 150 ms gate was never run, so no View Transition ships; the bands and no-black cut shipped with 0.3 |
| 9.8 | done | `3e0d876` | `audit/AuditChromeDash/p98-tape.json` | |
| 9.9 | done | `3e0d876` | `audit/AuditChromeDash/p99-faces.json` | |
| 9.10 | done with deviation | `3e0d876` | `audit/AuditChromeDash/p910-age.json` | Age tier reads `statusSinceMs` (the printed clock), not `rowWaitAnchor`; same for waiting cards, differs on errored and quota cards |
| 9.11 | done with deviation | `3e0d876` | `audit/AuditChromeDash/p911-strip.json` | Strip widened to 480 × 56 (an 8 px tick lane) after the audit passed 480 × 48; not re-audited |
| B.1a | done | `3e0d876` | `GpuCore/` | |
| B.1b | done; regressed after P3 | `6559335` | `Batches/`, `Receipts/` | Met at P3 (58/61 batches at dense-100 z1 1080p); the P5 quiet-host receipt reads 123/131 (> 80), [INFERENCE] from the P5 wall and gate props' own channel canvases; pager still saves 0.30–0.40 ms ([OF-024](open-followups.md)) |
| B.2 | done with deviation | `5f4abfe` | `audit2/AuditMemory2/` | Footprint 821–877 MB, sheet estimate 0 MB, 0 px diff; world-pilot packing skipped (V9 surface-code conflict); texture-cache cap resized 48 → 160 MiB on measured numbers ([OF-012](open-followups.md)) |
| B.3 | done with deviation | `6559335` | `CueSegments/`, `Receipts/` | Records ≤ 900 met (118–391 runs); appRender saving 0.40 ms at WebGPU dense-100 day, below the ≥ 0.5 target ([OF-024](open-followups.md)) |
| 10.1 Stage A | done with deviation | `ee145a3` | `audit7/AuditWGPU/parity/report.json`, `output/webgpu-parity/2026-09-29T06-25-34-928Z/` | `smoke:webgpu-parity` 36/36 at ≤ 1 LSB with device loss; 2.10 not ported (off at every level, reports unsupported on WebGPU) |
| 10.1 Stage B | done with deviation | `ee145a3` | `StageB/`, `WGPUPerf/`, `audit8/ReAuditP4/` | Default in Chromium (decisions 8, 12, 16); ReAuditP4 13/13 after the swap and recovery fixes; real Safari and Firefox unmeasured ([OF-018](open-followups.md)) |
| 10.2 | done with deviation | `ee145a3` | `audit7/AuditHDR/`, `HDR/xdr-check.json`, `HDR/g95c-check-*.json` | Every AuditHDR line passes; headed XDR (EDR 1 → 16 → 1) and, after `28ddff3`, headed G95C at 5120×1440 (dynamic-range high, P3, EDR 1 → 2.03 → 1; [OF-016](open-followups.md) closed); by-eye judgement open ([OF-017](open-followups.md)) |
| 10.3 | done with deviation | `ee145a3` | `P3Fix/` | Forced-P3 headless passes on both backends; on-screen ΔE_ok on the XDR unmeasured ([OF-017](open-followups.md)) |
| PixelLab A | done | `3e0d876` | `AssetsA/` | 84.8 generations: 7.3 pilot (feet held by copied keypoints), 7.1 sit pilot (template failed, skeleton-v3 passed), 5.5 tall oak |
| PixelLab B | done | `5f4abfe` | `Ships/`, `Woodland/` | ≈ 35 generations: hulls 16 of 40, trees 19 of 246; 6.1, 6.2 and 6.7 hand-authored at 0 |
| PixelLab C | done | `5f4abfe` | `Strips73b/`, `pixellab-ledger.jsonl` | ≈ 813.6 generations (B's unspent budget rolled forward): 24 sit rows, wait/strike/tinker for 26 profiles, gaze for 10 |

### Orchestrator decisions taken during execution

| # | Decision | Basis |
| --- | --- | --- |
| 1 | **V6 sea basis.** V6's sea clause caps outer ocean and in-map water at HSV S ≤ 0.40 outside the sun/moon path; golden S ≥ 1.15× noon is measured on land only (island minus in-map water) | The global grade pushed ocean S to 0.45–0.53; the sea's golden warmth comes from 3.2's `seaPath`, not saturation |
| 2 | **Golden-horizon courses are sky reflection**, not sea body: exempt from the sea cap and the 24-hour sea sweep | P2 closeout read 2 warm courses of 4 (R−B +27/+12/+1/−11); SeaPolish then set 4 warm courses (+44.5/+33.4/+14.3/+7.4), passed by AuditSea3 and ReAuditSeaP3 |
| 3 | **Unreachable acceptance lines recorded, not chased**: 2.1 Command bodies +50 % lit px; DPR-2 ground lit coverage within ±10 % | Base lights already cover 73 % (ceiling ×1.38); the base loop is not DPR-invariant (brazier ×5.48 vs ×4.00) |
| 4 | **Body backlight rule.** A lamp draws a body rim, and counts toward back reach, only when its foot stands ≥ 0.8 × the figure's half-width off the axis; elsewhere the body keeps its dark 1-px outline | The Command door wizards wore an amber outline all round from a lamp straight behind them (FixOutline) |
| 5 | **4.9 not triggered** | 0/10 hitches (decision M24's bar is 3/10) |
| 6 | **7.5 deferred to after the 2026-10-09 PixelLab reset** | Pilot (19 generations): the `running-6-frames` template failed identity on the robed profile (props pop in, robe redrawn as trousers); skeleton-v3 kept identity at ~24 generations per profile (≈ 624 for 26). Recipe in [OF-020](open-followups.md) |
| 7 | **2.10 kept off at every level** (`EFFECT_BUDGET['radiance-bounce']`) | The forge-door fan read as a larger pool; value-ladder excess with it on (64 px at 5120 z3); needs `EXT_color_buffer_float` |
| 8 | **Software GL → Canvas by default** (SwiftShader WebGL2 or a fallback adapter); an explicit `?renderer=` still wins | Stage B's order: hardware adapter → WebGPU (Chromium), hardware WebGL2 → WebGL2, software → Canvas |
| 9 | **Chronicler Canvas draw removed for parity** (P3); the errand logic stays | Canvas-only procedural body that walked over water; the GPU path never drew it ([OF-022](open-followups.md)) |
| 10 | **Release accent on peal note 0.** The crown's peak anchors to a declared body-led accent keyed by the peal's own agent id | 8.3 had it on the carrying note 4 (91–157 ms late); after: lag ≤ 12.4 ms, 8/8 Signals and 4/4 Town-band runs (CueAnchor) |
| 11 | **P1 exact bytes.** WebGPU uploads with `writeTexture` from the same decoded bytes as WebGL2; atlas bytes unchanged | Translucent texels match by construction; the gate is ≤ 1 LSB on ≥ 99.9 % of pixels |
| 12 | **Safari opt-in (`?renderer=webgpu`), Firefox WebGL2** | No in-Safari parity run; Firefox exposes no adapter |
| 13 | **Marks: role-2 rim.** Rim, status cell, notch, leader, beacon and edge arrow are GPU mark records; the two text runs stay on the 2D overlay | SDR pixel identity with the overlay held on both backends |
| 14 | **HDR emitter luminance cap under the NEEDS-YOU mark.** Mark gain ≥ emitter gain + 0.5, and a lifted emitter pixel may not exceed `#e8d44d` at its mode's mark gain; never below its SDR value | Subtle: max emitter Y 1.2753 vs min NEEDS-YOU 1.2948; white flame cores trimmed to ×1.28 (subtle) and ×1.6 (full) |
| 15 | **GPU-process crash: reload once**, at most once per 2 min, then the in-place Canvas world with the reason on Shift-D | Crash 1 reloads, crashes 2–3 inside 2 min do not, a crash after 121 s reloads once; after 4 crashes Chrome itself disabled the GPU (HDRRecovery) |
| 16 | **Device-loss gate bounded at 3 frames** (`DEVICE_LOSS_MAX_FRAMES`), not "within one frame" | `device.lost` resolves asynchronously (0.4–23 ms after `destroy()`); inactive after 1 frame in 3 of 10 runs, 2 in 7; 0 dark frames over ~440 screencast frames |
| 17 | **Camera priority at 5120**: villagers first and sea ≤ 0.30, above keeping every landmark crown in frame | 4.1/4.2 could not meet every constraint at once (FixCamera) |
| 18 | **WebGPU is the Chromium default** after it measured cheaper than WebGL2 | `world:gpu-burst` (dense-24, 22:00, FULL) with light records in a storage buffer: 2.19 vs 2.35 ms at 1680, 4.85 vs 5.02 ms at 4880 (shared host) |

### PixelLab spend

Balance 1,272 → 338.6 generations: **933.4 used under the 1,000 cap** (floor 272 never crossed), from the balance deltas in `pixellab-ledger.jsonl` (local evidence; 410 lines). Phase B and C jobs overlapped, so their split is approximate.

| Phase | Cap | Used | Shipped |
| --- | --- | --- | --- |
| A — pilots | ≤ 100 | 84.8 (1,272 → 1,187.2) | 7.3 strike and wait pilot, 7.1 sit pilot, 5.5 tall oak, feet-audit and spend tooling |
| B — landmark and world assets | ≤ 400 | ≈ 35 | 13 hull strips, tall pine and willow, bare-winter and snow-laden states |
| C — villager rollout | ≤ 500 + B's roll-forward | ≈ 813.6 | 24 sit rows; wait, strike and tinker for 26 profiles; gaze for 10 |
| Left under the cap | | 66.6 | 7.5 deferred (its 19-generation pilot ran on the raised budget, after the cap) |

### Known limits and carried items

Carried in [open-followups](open-followups.md):

- **OF-009** `read` strips for six strip-less profiles; 15 of 20 pre-existing `read` strips fail the ±2 px feet audit.
- **OF-011** quiet-host ladder receipt (dense-100 soak). **OF-012** GPU-owned estimate at DPR 2; ~44 MB of Chrome transfer-cache textures unattributed.
- **OF-017** headed by-eye HDR and P3 on the XDR. **OF-018** real Safari and Firefox runs. (OF-016, the G95C HDR re-probe, closed after `28ddff3`.)
- **OF-019** art-director carries that need maintainer decisions (clone-crowd identity, overlay density at z1/z2, static z1, night light on volumes).
- **OF-020** 7.5 run gait. **OF-021** 4.9 overlay panel, conditional.
- **OF-022** the Chronicler has no body on any backend.
- **OF-023** automated gates render only the Canvas world headless; the GPU paths rely on `smoke:webgpu-parity` and `smoke:v3-truth`, which need a real GPU and are not in CI.
- **OF-024** frame-cost regressions found by the Phase 5 receipts (unlocked p95, B.1b batch count, boot). **OF-025** quiet-host receipts not run (ladder soak, deferred R1 receipts, post-M6 per-level check, 9.7b gate).

Residuals recorded, not carried (auditor in brackets):

- Canvas: night part emitters cooler than GPU and lantern flicker 4–13 px per step [ReMotionBldg]; stepped glide reverses off-centre content [ReDolly]; storm water ~8 luma darker than WebGL and one cloud octave [ReAuditSeaP3]; fog brighter on WebGL (~34–42 vs ~25 luma) [FixWeather].
- WebGPU: an in-frame fallback to WebGL2 re-bakes terrain in-task (440–620 ms); after two GPU-process crashes in 2 min the in-place Canvas world keeps blank module caches until reload [ReAuditP4, RecoveryFix]. A window opened on sRGB and moved to P3 keeps an sRGB overlay; WebGL2 without `OES_draw_buffers_indexed` loses P3 emitter chroma [P3Fix].
- Bodies: walk-to-idle head pop up to 5.2 world px on `claude.fable` and `claude.opus` [AuditMotionCam]; the dense-100 gate queue drains in ~40 s; reduced-motion chat pairing cuts a body across the map in one frame [FixMotion]; 23 sheet frame-consistency defects predate the round [AssetsA].
- Chrome: Escape cannot close a `#worldGrammar` popover opened from script [ChromeB]; `#panelClose` keeps a native title [FixChrome]; two roster faces read dark at 2× in the niche [AuditChromeDash].
- Sea: the Forge mirror is faint [ReAuditSeaP3]; a reduced-motion load once showed no ships for over 60 s, not reproduced [ShipsFinish].

### Phase 5 additions

Phase 5 added, after this record's item table was written: the maintainer's two requests — the Command well and flower cart moved to the south-bank green with walk-blocking footprints (and a stale fan-anchor bug that sent walkers across water fixed), and the wall, gatehouse and sea tower rebuilt as one full-stone family at native scale (`VillageWall.js`, `bake-village-gate.mjs`; masonry walk blocking via `inVillageMasonry`); the Forge hearth and Command braziers now climb their authored flame tongues (EmitterCycle `mode: tongues`); 3.5 shoreline completion (palisade mirror band, boulder coverage, halo-width noise); V3 fixes (the Canvas incident pulse removed, the weather-override null seed) and the permanent `smoke:v3-truth`; 7.5 deferred by the maintainer to after the 2026-10-09 PixelLab reset (pilot 19 generations, reverted).

### Receipts (quiet host)

One lane (`ReceiptsA`, 2026-09-29, load < 4 before every context, 3 contexts) ran before the maintainer asked to wrap up — they report a flat 60 FPS in daily use. Tables: `Receipts/RECEIPTS-tables.md` (local evidence).

| Receipt | Result |
| --- | --- |
| Stage B go condition (`gpu-burst` FULL, dense-24 22:00) | Holds everywhere: WebGPU vs WebGL2 2.226 vs 2.364 ms (1680 z1), 2.229 vs 2.446 (1680 z2), 4.820 vs 4.982 (4880 z1), 7.323 vs 7.732 (4880 z2) |
| M6 `light-clusters` | Clustered walk cheaper in all 32 cases (1.42–16.96 ms saved at FULL, 1.28–11.46 at MINIMAL; each case measured with clusters forced on vs off at that level); default now on at every level. The per-level `gpu-burst` sweep after the switch (confirming MINIMAL is no longer costlier than FULL) was not run ([OF-025](open-followups.md)) |
| EFFECT_BUDGET rows (per-frame interleaved shed A/B, not true K8 — no per-row K hook) | Resolved savings at 4880: waterCrests 0.51–0.66 ms, light-admission 0.38–0.39, footprint-occlusion 0.40 (WebGL2), cloud-courses 0.29 (WebGL2), aerial-perspective / coastSwash / bodyReflections 0.13–0.16 (WebGPU); bloom 0.82 at DPR 2 storm; radiance-bounce would cost +0.09. Recorded in the `EFFECT_BUDGET` header |
| Unlocked frame (FULL, dense-24) | p50/p95 WebGL2 4.3/7.4 ms (1080p), 5.9/10.4 (5120); WebGPU 3.9/12.6, 4.3/20.9 — p95 above the pre-plan 4.8/5.0 ([OF-024](open-followups.md)) |
| B.1b / B.3 | Pager saves 0.30–0.40 ms (WebGPU) and 0.14–0.22 (WebGL2) of gpu-world p50; cue runs save 0.40 ms appRender (WebGPU dense-100 day); batches now 123/131 at dense-100 z1 1080p against the P3 58/61 ([OF-024](open-followups.md)) |
| Boot (warm Metal cache) | First world frame 1838 / 1852 ms (WebGPU, 2560 / 5120), 1901 / 1865 (WebGL2), against 1479 / 1430 at `3e0d876` ([OF-024](open-followups.md)) |
| Not run | Free-ladder soak (≥ 98 % FULL), deferred R1 receipts, post-M6 per-level `gpu-burst`, cold-cache boot, 9.7b gate ([OF-025](open-followups.md)) |
