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
- exposes named bands matching the table below
- keeps band choice visible at the call site
- avoids allocating timers, particles, paths, or offscreen caches when `motionScale <= 0`

Existing local pulse math can migrate gradually as nearby features are touched. Add local pulse math only when a feature needs a distinct waveform or timing model, and document why the shared helper is not enough.

## Pulse Bands

| Band | Cadence | Canonical owner | Permitted claimants | Forbidden |
| --- | --- | --- | --- | --- |
| `slow` | More than 1 second | Selection ring | Observatory sweep, lighthouse beam, directional chat flow (dotted chat/dispatch connections march on this band and hold still under reduced motion; talk-arc motes step through 12 positions), ambient camera lateral glides (one-shot moves, never while a competing claimant is active), work-score playback cursor (one 24 s pass over the kept span), selected-agent chevron one-texel lift (the selection claimant, replacing the old ring pulse), fireflies (2 s cycle, 600 ms lit, on per-firefly phases), Sidebar waiting-on-you and errored dot blink (1.6 s, stepped) | Competing pulse claimants when selection is active on the same agent |
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
| Release crown (Major) | `ChronicleMonuments.js` | 200 ms rising gold streak, one cream flash frame, spokes grow in three steps, open out in three alpha steps (1.2 s), then a 6 s static crown seal; waits while a failure bracket stands and is dropped after 30 s; suppresses Harbor gulls | One crown; further releases add to its count | The static crown seal only |
| Failed-push bracket (Medium) | `HarborTraffic.js` | 120 ms the halves close in, one cream flash, a three-step shake of the stamp only (never the camera), then static red for as long as the failure stands; events older than 15 s appear static | One per repo, 4 shown | Static bracket |
| Work downbeat (Minor) | `RitualConductor.js`, `WorkDownbeats.js` | 120 ms wind-up, 70 ms cream strike, 210 ms stepped decay, no residue; fires on the first beat of a playing ritual and every third after, on the same clock as the gesture | 6 rituals | No beat; the static pose stays |

## Ambient Life, Weather, and Light

| Motion | Owner | Budget as implemented | Reduced-motion frame |
| --- | --- | --- | --- |
| Gulls | `WildlifeRenderer.js` | Pool of 43 in ten lanes, one gull per lane aloft (at most 10; 4–10 by day, 6–8 at dawn/dusk, ×0.3 in rain); visible caps 8/5/3 by zoom; no off-map flights; storm: roost on four perches; night: only the lighthouse gull; cleared while a release crown suppresses them | Roosting gulls only |
| Songbirds, ducks | `WildlifeRenderer.js` | Songbirds 0/2/3 by zoom, none in rain, storm, or at night; ducks hidden in storms | One perched songbird |
| Fireflies | `WildlifeRenderer.js` | Apr–Oct, dusk and night, clear air, on 48 fixed homes on grass within two tiles of water; none below zoom 3, at most 12 at zoom 3 and above; `slow` band blink | None |
| Rain and snow | `WeatherRenderer.js` | Pixel streaks on the art grid in parallax layers, area-scaled (100 rain, 150 storm, at most 64 at zoom ≤ 1.5); splashes are a three-frame crown anchored in world space on open ground only; storm curtains are two stepped courses | Half the streaks in one frozen layer; static world-anchored splash rings on a fixed share of open tiles; a frozen snow field |
| Chimney smoke | `ChimneySmoke.js` | Only from registry chimney anchors while the building is occupied (420 ms spawn) or busy (260 ms); at most 10 puffs per chimney; wind leans, rain flattens | One static three-puff wisp per smoking chimney |
| Seasonal drift | `SeasonalAmbience.js` | Spring petals, autumn leaves, summer butterflies by day, winter flurries, in world space; none below zoom 2, at most 6 live, none at night or in rain or storm | None |
| Cloud shadows | `gpu/GpuWorldRenderer.js`, `CloudShadowCourses.js` | World-locked, three dithered courses drifting with the wind; about 15 % ground cover on clear days, 35 % partly cloudy, none under overcast, rain, or at night | Frozen offset |
| Water ripple dashes | `gpu/GpuWorldRenderer.js` (`applyWaterState`) | Depth stops stay flat; each 8×4 world-px cell (6×3 in a storm) may hold one 3×1 dash, lit on one palette-cycle phase in four, brightening only; the bright-moon silver rides the same dashes | Phase frozen |
| Time-of-day grade, casts, water mood | `GradeEvaluator.js`, `RakingLight.js`, `CoastBake.js` | Follow the real clock and weather in quantized buckets (casts rebake per sun bucket, water mood per 1/8 bucket); no animation of their own | Unchanged; no motion terms |

## Camera and Chrome

| Motion | Owner | Timing as implemented | Reduced-motion frame |
| --- | --- | --- | --- |
| Wheel zoom | `Camera.js`, `CameraCurves.js` | One 150 ms easeOutCubic tier step in log space | The tier changes at once |
| Director and Ambient glides | `Camera.js`, `CameraCurves.js`, `CameraDirector.js` | Director easeInOutCubic, Ambient/tour easeInOutSine; `clamp(600 + 0.55·screenPx + 350·\|log2 z1/z0\|, 700, 2400)` ms, Ambient ×2.2 capped at 5 s; pan at a resting integer tier plus a 450 ms zoom step for every resting rung crossed (never squeezed), and the glide lengthened to at least four times its zoom time, so at least 75 % of every glide is pixel-exact (`F` from tier 3: 900 ms of zoom inside about 3.6 s) | Cut to the target frame; no glide grade or letterbox |
| Follow window | `Camera.js` | 28 % × 22 % composition window; critically damped spring ω = 3.5/s, idle relax ω = 1.2/s; 500 ms entry; a follow that begins before the first presented frame snaps | Cut |
| Opening | `Camera.js` | Survey tier (tier 1 at DPR 1) held 1600 ms, then a dolly of at least 2400 ms whose zoom climbs the tiers in 450 ms steps, one per rung (about 4 s in total at DPR 2) | Static cut to the content |
| World reveal | `App.js`, `css/character.css` | Canvases fade in 360 ms on boot and 220 ms on return from Dashboard, once `world:first-frame` has fired | No fade |
| Chrome | `css/*.css` | Toasts and the modal overlay enter and leave in four opacity steps; the Dashboard errored flash is one 600 ms four-step pass; the reconnect sweep is one eight-step pass; the Activity Panel (160 ms), sidebar content (180 ms), and Dashboard container (180 ms) fade in once. The only infinite chrome loops are the stepped waiting-on-you/errored attention blinks and the offline/stale connection warnings | `animation: none` |

## Reduced Motion

Reduced motion means:

- State machines may advance logical time if downstream state depends on completion.
- No particles, path walkers, drifting trails, or repeated pulse allocations should be created.
- Existing static visual meaning should remain visible through fixed alpha, fixed pose, or snapped final state.
