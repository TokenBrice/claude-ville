# Motion Budget And Pulse Policy

ClaudeVille's World mode uses motion to communicate state. New motion-bearing work must follow this budget before it ships.

## Required Gates

- Check `motionScale` before allocating animation state, particles, paths, timers, or offscreen caches.
- Ship a static fallback for `motionScale <= 0`. The fallback may show a fixed pose, fixed alpha, or snapped end-state, but it must not allocate continuous motion resources.
- Declare the pulse band claimed by each new animated cue.
- Prefer alpha decay, static tint, or one-shot flashes when motion is ornamental rather than semantic.
- Reuse the shared `getPulsePriority()` hook for visual A/B work instead of hardcoding competing priority orders in feature modules.

## Shared Helper Direction

World mode exposes shared pulse helpers in `claudeville/src/presentation/character-mode/PulsePolicy.js`. Before adding another repeating sine cadence, use `pulseValue()` or `pulseAlpha()` when possible. The helper:

- accepts `motionScale` and returns fixed fallback values when motion is disabled
- exposes named bands (`selection`, `working`, `recent`, `alert`, `harbor`, `intrinsic`); an unknown name falls back to `intrinsic`. The `slow`/`medium`/`fast`/`static` cadences in the table below are the budget taxonomy (and the `pulseBand` labels in `RitualConductor.js`), not `pulseValue()` arguments
- keeps band choice visible at the call site
- avoids allocating timers, particles, paths, or offscreen caches when `motionScale <= 0`

Existing local pulse math can migrate gradually as nearby features are touched. Add local pulse math only when a feature needs a distinct waveform or timing model, and document why the shared helper is not enough.

## Pulse Bands

| Band | Cadence | Canonical owner | Permitted claimants | Forbidden |
| --- | --- | --- | --- | --- |
| `slow` | More than 1 second | Selection ring | Observatory sweep, lighthouse beam, directional chat flow (dotted chat/dispatch connections march on this band and hold still under reduced motion; talk-arc motes step through 12 positions), ambient camera lateral glides (one-shot moves, never while a competing claimant is active), the `A` attention hold's soft follow (≤ 12 s, operator-owned), work-score playback cursor (one 24 s pass over the kept span), selected-agent chevron one-texel lift (the selection claimant, replacing the old ring pulse), fireflies (2 s cycle, 600 ms lit, on per-firefly phases), Sidebar waiting-on-you and errored dot blink (1.6 s, stepped) | Competing pulse claimants when selection is active on the same agent |
| `medium` | Around 600 ms | Working-status glow | Forge burst, archive page flip, mine pickaxe, portal rune boost, mote orbit, carrier-bird flight, action-strip read beat (a two-frame beat that replaces the working-status glow on that body instead of stacking on it) | A second medium pulse on an entity already showing working glow |
| `fast` | Less than 300 ms | Recent-event flash | Spark ring, taskboard pin, re-merge sparkle, the C4 cream peak frame (one frame per moment, never repeated), work downbeat strike | Continuous use |
| `static` | No pulse | Idle agents, building lights, hearth glow | Command flag, harbor crate, mine seam tint, council ring, council gather notches and team mark, recovery bracket and relief diamond, building activity footprints and dais rings (static in every motion mode), the docked Harbor wake, the villager work dot (a static 2×2 texel, no blink), attention lights, departure sigil, monument freshness, manifest plank weathering, parent receive beat, shared-file knot thread and plate, work-score glyph nodes and interval brackets, held-wait hand props, child-return miniature, C4 residues (arrival rune notch, release crown seal, failed-push bracket), T1 attention plates and beacons, T3 plaques, villager contact shadows and rings, golden-hour casts | Replacing these static cues with repeating motion |

## Priority Iteration

Foundation freezes the bands, not the final visual priority order. The default order is exposed through `getPulsePriority()` and can be overridden with `?pulsePriority=selection,working,recent,intrinsic` during browser visual testing.

Feature work that introduces motion should test dense worlds with mixed selected, working, and recent-event states. If a different priority order reads better, update the hook default with that feature and record the tested order in the change notes.

## One-Shot Moments (C4)

Transient event moments follow the effect-language envelope in `character-mode/EffectStamps.js` (`defineMoment`, `momentPhase`): anticipation 120–250 ms, one cream peak frame 60–100 ms, a follow-through in four alpha quanta (1, 0.66, 0.33, 0), and an optional static residue. Tiers bound the active part: Minor ≤ 400 ms, Medium ≤ 1.2 s plus residue, Major ≤ 2.5 s with only one Major active at a time (`claimMajorMoment`). Out-of-contract timings are clamped. None of these repeats; the only repeating element is the static residue, which does not pulse. Under reduced motion `momentPhase` returns only the residue frame.

| Moment | Owner | Timing as implemented | Cap | Reduced-motion frame |
| --- | --- | --- | --- | --- |
| Arrival column (Medium) | `ArrivalDeparture.js` | Rune ring and violet column rise in three held steps (200 ms) while the body stays hidden, one cream rim frame (a 1-texel outline of the body, 80 ms), the column sinks in three steps with dust chips (520 ms), then a 2 s static rune notch while the villager walks in through the gate | 6 at once; extra arrivals just walk in | The body is placed inside the gate with the static rune notch only |
| Dispatch / merge comet (Medium) | `ArrivalDeparture.js` | 150 ms gather at the sender, 500 ms comet with the child miniature as its head, 80 ms cream impact (a 1-texel rim), 400 ms chip splash; the child lands on a free, reserved tile 2–3.25 tiles from its parent; returns fly in stone | One per child | No comet: a dispatched child appears on its landing tile 2–3 tiles from its parent, a merge resolves without flight |
| Completion cue and departure sigil | `ArrivalDeparture.js` | Static stone diamond and miniature with stepped alpha (2.2 s completion, 12 s sigil) | 8 cues, 6 sigils | Held static (3.6 s completion, 6 s sigil) |
| Release crown (Major) | `ChronicleMonuments.js` | 200 ms rising gold streak, one cream flash frame, spokes grow in three steps, open out in three alpha steps (1.2 s), then a 6 s static crown seal; waits while a failure bracket stands and is dropped after 30 s; never touches the gulls, sky or weather (V3) | One crown; further releases add to its count | The static crown seal only |
| Failed-push bracket (Medium) | `HarborTraffic.js` | 120 ms the halves close in, one cream flash, a three-step shake of the stamp only (never the camera), then static red for as long as the failure stands; events older than 15 s appear static | One per repo, 4 shown | Static bracket |
| Work downbeat (Minor) | `RitualConductor.js`, `WorkDownbeats.js` | 120 ms wind-up, 70 ms cream strike, 210 ms stepped decay, no residue; fires on the first beat of a playing ritual and every third after, on the same clock as the gesture | 6 rituals | No beat; the static pose stays |

## Ambient Life, Weather, and Light

| Motion | Owner | Budget as implemented | Reduced-motion frame |
| --- | --- | --- | --- |
| Gulls | `WildlifeRenderer.js` | Pool of 43 in ten lanes, one gull per lane aloft (at most 10; 4–10 by day, 6–8 at dawn/dusk, ×0.3 in rain); visible caps 8/5/3 by zoom; no off-map flights; storm: roost on four perches; night: only the lighthouse gull; no push, release or other agent event changes them | Roosting gulls only |
| Songbirds, ducks | `WildlifeRenderer.js` | Songbirds 0/2/3 by zoom, none in rain, storm, or at night; ducks hidden in storms | One perched songbird |
| Fireflies | `WildlifeRenderer.js` | Apr–Oct, dusk and night, clear air, on 48 fixed homes on grass within two tiles of water; none below zoom 3, at most 12 at zoom 3 and above; `slow` band blink | None |
| Rain and snow | `WeatherRenderer.js` | Pixel streaks on the art grid in parallax layers, area-scaled (100 rain, 150 storm, at most 64 at zoom ≤ 1.5), leaning with `windAt` under the view centre (stepped gusts) and drifting with the knot wind; splashes are a three-frame crown anchored in world space on open ground only; storm curtains are two stepped courses | Half the streaks in one frozen layer; static world-anchored splash rings on a fixed share of open tiles; a frozen snow field |
| Lightning | `WeatherRenderer.js` (`stormStrikeAt`, `drawFlashExposure`), `gpu/GpuWorldRenderer.js` (`u_flash`) | Storm only, on the MotionClock: a strike in about one 7.2 s cycle in four; `fast` band C4 quanta 0.30 → 0.18 → 0.12 → 0.07 → 0.035 (83 ms steps), a 0.16 re-strike at 470 ms, gone by 720 ms; the flash is an exposure step on both backends (world and backdrop × 1 + scalar × gain, gain 0.27 day → 0.18 night, cool tint; peak frame-mean and p99 luma measured under the old source-over flash at 5120×1440, 2560×1440 and DPR 2, both backends, day and night); a pixel bolt on `round(zoom)` cells (cream core, checker halo, 0–2 forks) lands on the open ocean with a stepped 2:1 splash ring, or ends in the sky | No strike and no flash |
| Fog banks and weather washes | `WeatherRenderer.js` (`groundFogLayer`), `WorldFrameRenderer.js` (Canvas ground pass, resident `ground:fog` records and the pre-graded backdrop over the outer ocean) | Fog: world-locked three-course banks on the ground plane, under every body, building and tree (2 world px texels, two noise octaves about 5:1 along the iso horizontal so they lie as long banks, course alpha 0.11/0.20/0.31 at full fog, solid interiors with ordered dither held to one texel either side of each seam) below the horizon, creeping with the cloud-course drift (fog wind 0.1 ≈ 3.7 world px/s); overcast and fog washes are flat 1/48 alpha courses down the frame; no gradients. Under reduced motion the governor level these layers read is latched per static scene (`weatherPressureLevel`), so no fog, haze or rain density pops between frames | Banks hold their offset; washes unchanged |
| Ground haze | `WorldFrameRenderer.js` (`bakeHazeField`), `gpu/GpuSceneBuilder.js` (`ground:haze`) | Dawn mist and fog only (never rain), one world-locked field baked per map revision: flat 16 world px bands of streaks along the iso horizontal inside the water/lowland reach, three stepped courses (alpha 0.10/0.19/0.30) with ordered dither only where a streak ends, strength stepped in eighths; no motion of its own | Unchanged (static) |
| Chimney smoke | `ChimneySmoke.js` | Only from registry chimney anchors while the building is occupied (420 ms spawn) or busy (260 ms); at most 10 puffs per chimney; each puff leans with `windAt` at the chimney mouth (fog barely tilts it, a storm lays it flat), rain flattens | One static three-puff wisp per smoking chimney |
| Seasonal drift | `SeasonalAmbience.js` | Spring petals, autumn leaves, summer butterflies by day, in world space, none in rain or storm; winter snow only while the village's own timeline precipitates; none below zoom 2, at most 6 live, none at night | None |
| Cloud shadows | `gpu/GpuWorldRenderer.js`, `CloudShadowCourses.js`, `Wind.js` (`cloudCourseDrift`) | World-locked, three dithered courses drifting at 3 + 7·\|windX\| world px/s along the wind (fog 3.7, clear 5.5, storm 12.1), integrated on the MotionClock so both backends agree; about 15 % ground cover on clear days, 35 % partly cloudy, none under overcast, rain, or at night | Frozen offset |
| Wind gusts | `Wind.js` (`windAt`) | The one wind (C-W3): knot `windX` = sign × speed (fog 0.1, clear 0.35, partly 0.55, overcast 0.7, rain 0.9, storm 1.3); gust patches travel downwind and step in thirds of the weather's gustiness (none in fog), holding about 1.7 s at a point in a storm | Gusts frozen with the MotionClock |
| Tree lean frames | `FoliageRenderer.js` (`swayFrame`), `Wind.js` | Slow band: whole-texel row shear with the trunk planted (bottom 30 %, pines 40 %), shared baked frames on both backends; upright below \|windX\| 0.15 (fog is still); in a breeze a tree runs the {0, +1, 0, −1} cycle only while a `windAt` gust crosses it (one texel); from \|windX\| 0.6 every tree rests one texel downwind and cycles around that, a gust letting a willow reach two; each step holds 300–600 ms on the tree's own phase, on the MotionClock | The static rest lean (upright, or one texel downwind from \|windX\| 0.6) |
| Water ripple dashes | `gpu/GpuWorldRenderer.js` (`applyWaterState`) | Depth stops stay flat; each 8×4 world-px cell (6×3 in a storm) may hold one 3×1 dash, lit on one palette-cycle phase in four, brightening only; the bright-moon silver rides the same dashes | Phase frozen |
| Time-of-day grade, casts, water mood | `GradeEvaluator.js`, `RakingLight.js`, `CoastBake.js` | Follow the real clock and weather in quantized buckets (casts rebake per sun bucket, water mood per 1/8 bucket); no animation of their own | Unchanged; no motion terms |

## Villager Bodies (V7)

All run on the sprite update clock (the one `MotionClock` dt); none reads mood, director or environment state beyond the agent's own status, intent and mood already driving its gait.

| Motion | Owner | Timing as implemented | Reduced-motion frame |
| --- | --- | --- | --- |
| Walk gait | `AgentSprite.js`, `MotionClock.js` | Travel at one speed rung (`SPEED_RUNGS`, px per 16.67 ms: WORKING 1.5, WAITING 1.125, IDLE 0.75, scenic stroll 0.5625, chat approach 1.5; intent, model and mood move at most one rung, congestion whole rungs); one walk frame per 4.5 px, so every frame holds 3/4/5/6/8 refreshes at 60 Hz (double at 120 Hz); a walking body rides the backing-pixel grid (`snapBodyPx`) and lands on a whole texel when it stops | Idle frame 0 while the body still travels |
| Turn | `AgentSprite.js` (`_setFacingGoal`, `_advanceFacing`) | One 45° column per 55 ms toward the goal; an exact reversal turns through the camera-facing side; ±45° travel changes debounce 70 ms | Facing snaps to the goal |
| Planted pivot | `AgentSprite.js` (`_holdGait`) | A turn of 135° or more holds the walk frame and the body in place until the facing arrives (≤ 220 ms) | None (facing snaps, body walks on) |
| Start and stop beats | `AgentSprite.js` (`_holdGait`, `_beginStopBeat`) | Leaving rest holds the push-off walk frame 60 ms before the first step; arriving holds the nearest contact frame (0 or 3) 80 ms before the seeded idle phase | None; idle frame 0 at once |
| Work facing and fidget | `AgentSprite.js` (`_workFacing`, `_fidgetGlance`) | At rest a villager faces E/W/SE/SW (NE/NW only for a north bearing); a fidget glances one column aside every 4–9 s for 0.6–1 s, never into NE/N/NW or past its building's half-plane | Work facing held, no fidget |

## Camera and Chrome

| Motion | Owner | Timing as implemented | Reduced-motion frame |
| --- | --- | --- | --- |
| Wheel zoom | `Camera.js`, `CameraCurves.js` | One 150 ms easeOutCubic step in log space through every resting rung (at backing DPR 2 the half rungs 1.5 and 2.5 too) | The rung changes at once |
| Director and Ambient glides | `Camera.js`, `CameraCurves.js`, `CameraDirector.js` | Director easeInOutCubic, Ambient/tour easeInOutSine; `clamp(600 + 0.55·screenPx + 350·\|log2 z1/z0\|, 700, 2400)` ms, Ambient ×2.2 capped at 5 s; pan at a resting integer tier plus a 450 ms zoom step for every logical tier crossed (never squeezed; DPR-2 half rungs are not landings), and the glide lengthened to at least four times its zoom time, so at least 75 % of every glide is pixel-exact (`F` from tier 3: 900 ms of zoom inside about 3.6 s); shots rest at the 4.1 shot scales and never grade the world | Cut to the target frame; no letterbox |
| Follow window | `Camera.js` | 28 % × 22 % composition window; critically damped spring ω = 3.5/s, idle relax ω = 1.2/s; 500 ms entry; a follow that begins before the first presented frame snaps | Cut |
| Attention hold (`A`, 4.3) | `CameraDirector.js`, `Camera.softFollowWorldBox` | `slow` band. After the attention glide lands, up to 12 s of soft-follow on the included bodies and plates (moving bodies extended to their path's end): an eased pan of at most 600 screen px/s (600 ms stiffness, 28 px dead zone), a zoom only outward as one 450 ms tier step, never inward; ends when every body has stood still 1.5 s, at 12 s, or on any operator input, within one frame | One cut when the set settles (or at 12 s), then still |
| Opening | `Camera.js` | Survey shot (the wide at 1920 × 1080 DPR 1) held 1600 ms, with the sea horizon at 11 % of the world viewport where the island leaves slack, then a dolly of at least 2400 ms to the content at the medium scale at most, its zoom climbing the logical tiers in 450 ms steps, one per rung (about 4 s in total at DPR 2) | Static cut to the content |
| World reveal | `App.js`, `RevealBands.js`, `css/character.css` | Canvases fade in 360 ms on boot and 220 ms on return from Dashboard, once `world:first-frame` has fired (the boot signal waits for the opening pose), over the container's static stepped bands measured from the World's own frame; a canvas resize draws synchronously and holds the screen centre | No fade; the bands are static |
| Mode switch | `ModeManager.js` | A cut in one task: the incoming surface is laid out before the browser paints; no fade in either direction | Same cut |
| Dashboard lane moves (9.7a) | `dashboard-mode/DashboardRenderer.js` | `fast` band, one-shot. When bell-lane membership changes, the crossing card, the cards around it and the sections below FLIP from their old places: translate only (never scaled), 240 ms `cubic-bezier(0.2, 0, 0, 1)`; within-section reorders use the same curve. Bell-lane age tiers (rim ≥ 1 min, filled plate ≥ 5 min) and `ANSWER FIRST` are static | Cut to the new layout |
| Chrome enter and exit (9.6) | `css/reset.css` (`--cv-step-in`), `css/activity-panel.css`, `css/modal.css`, `shared/ActivityPanel.js`, `shared/Modal.js` | `fast` band, one-shot. One curve, `120ms steps(3, end)`, 12 px of travel in three whole 4 px steps with three opacity steps, so no frame puts bitmap text on a fractional x: the Activity Panel steps in from the right and back out; the modal dim steps while the dialog rises and sinks; the World-controls popover and the top bar's connection, spend and SOUND panels step down out of the bar and back up. `display` (and a popover's top layer) holds through the exit, and the panel's visual teardown and the modal's content clear wait for it, so the World canvas resizes once per panel open or close; a mode switch cuts the panel. The chrome tooltip is instant | `transition: none`: every surface cuts in one frame |
| Chrome | `css/*.css` | Toasts enter and leave in four opacity steps; the Dashboard errored flash is one 600 ms four-step pass; the reconnect sweep is one eight-step pass; sidebar content fades in once (180 ms) on expand. The only infinite chrome loops are the stepped waiting-on-you/errored attention blinks (in the sidebar, on the bust's corner pip) and the offline/stale connection warnings | `animation: none` |

## Reduced Motion

Reduced motion means:

- State machines may advance logical time if downstream state depends on completion.
- No particles, path walkers, drifting trails, or repeated pulse allocations should be created.
- Existing static visual meaning should remain visible through fixed alpha, fixed pose, or snapped final state.
