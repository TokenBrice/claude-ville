import {
    MATERIAL_CLASS_IDS,
    materialClassId as registryMaterialClassId,
} from '../MaterialRegistry.js';
import { RECEIVER_LUMA_CEILING } from '../../../config/artPalette.js';
import { WATER_MAX_SATURATION } from '../GradeEvaluator.js';
import { footprintFieldRect } from '../FootprintField.js';

const FOOTPRINT_FIELD_RECT = footprintFieldRect();
const FOOTPRINT_FIELD_BYTES = FOOTPRINT_FIELD_RECT.width * FOOTPRINT_FIELD_RECT.height * 2;

// 1.2 — the pool strength (luma of colour x course weight x energy, the
// `strength` stepPool reads) at which a warm course lands on its C1 stop in
// full: a village lantern's or brazier's thin rim course at night (0.21-0.26)
// already does, a faint light lands in proportion. The Canvas pool stamp
// (CanvasGrade) lands on the same rule.
export const LAND_FULL_STRENGTH = 0.2;

export const GPU_WORLD_RENDERER_MODES = Object.freeze({
    WEBGL: 'webgl',
    CANVAS: 'canvas',
    // Wave 10 Stage A — opt-in only (`?renderer=webgpu`), never a default.
    WEBGPU: 'webgpu',
});

// EFFECT_BUDGET — the optional work the resident renderer ships and what each
// quality level keeps. Key order is the shedding order: embellishment first,
// depth cues and the night's light last. Every level entry states what ships
// at that ladder level (a mode, or for `light-admission` a count), so the
// table is the only authority the renderer reads: there is no second ladder,
// and Shift-D's shed line lists every entry below its FULL value.
//
// Receipt rule (V2, plan 0.1). A band is a K8 slope, not a timer sample:
// interleave K in {0, 1, 8} copies of the candidate per frame in the real
// frame (`node scripts/smoke/world-fps-benchmark.mjs --mode=kslope`; the
// candidate's loop injected into the pass it will live in, so it is priced on
// the cumulative shader), price = (T8 - T0) / 8, with the A/A slope of the
// same session beside it. A receipt resolves only above 2x its A/A spread;
// below that the band is written `[0, ceiling]` — the resolvable limit, not a
// claim of zero cost. Take it at 1920x1080 and 5120x1440, add the
// vsync-unlocked FULL-vs-MINIMAL frame delta (`--mode=unlocked`) and real-frame
// throughput per level (`node scripts/world/gpu-burst.mjs`), on a quiet host
// (load < 4; 3 x 12 s fresh contexts), and state the refresh rate the receipt
// assumes. Isolated per-pass `TIME_ELAPSED` samples are not evidence on
// ANGLE-Metal: the query flushes the command buffer and reports its GPU wall
// span, which grows with contention and DVFS, not with this frame's work.
// Rows dated before 2026-09-28 predate this rule: their bands are per-pass or
// paired timer observations on a shared host (`ANGLE Metal Renderer: Apple M5
// Pro`), upper bounds until re-receipted, never portable entitlements. The
// undated rows (`bloom` through `water-reflection`) are the 0.1 per-pass
// sampler at 1680x1026, fixed 22:00 clear, FULL, 13-24 rotating samples per
// pass, 2026-09-05, spanning the dense-24 and dense-100 observations.
//
// `cost.scope` says how to read the band. `own-pass`: the effect is its own
// pass, so the band is what shedding returns. `shared-scene-envelope` /
// `shared-composite-envelope`: the effect is a branch inside that pass, so
// shedding it returns nothing of its band. A row prices added time as
// `cost.gpuMsBand` or removed time as `cost.gpuMsSavedBand`, never both: work
// that a substitution *removes* is not an optional effect, ships at every
// level, and is never shed. Attachment bytes stay allocated across levels
// (`GpuWorldRenderer._ensureTargets`); `bytes` prices what an effect keeps
// resident, not what it returns when shed.
//
// Unshed CPU cost outside these rows (B.2, for B.1b/B.3 CPU accounting): the
// agent atlases are CPU-backed (GpuSceneBuilder `createAgentAtlasCanvas`), so
// their slot and 4.7 walk-strip patches upload from CPU memory on the main
// thread: +0.18 ms/frame at dense-24 2560x1440 with 17 strips (14.0-14.3 vs
// 3.2-3.5 ms/s GPU-backed; per upload p95 0.3 ms, max 0.6 ms), in exchange
// for 80-150 MB less GPU-process memory at dense-100 1080p.
//
// Phase 5 quiet-host receipts (2026-09-29, Apple M5 Pro, headless Chromium,
// 60 Hz, every context started at load < 4; tables in the local evidence
// `output/waking-isle/Receipts/RECEIPTS-tables.md`). Rows are priced by what
// shedding returns: per-frame interleaved arms, each row forced to its
// MINIMAL mode on its own frames, whole-frame GPU ms, dense-24 forced FULL,
// 3 contexts x 24 s, A/A arms alongside. Resolved (> 2x A/A), ms at
// WebGPU 4880x1392 / WebGPU DPR-2 2544x1868 / WebGL2 4880x1392:
// `light-admission` 0.39 / 0.46 / 0.38; `waterCrests` 0.66 / 0.36 / 0.51;
// `footprint-occlusion` WebGL2 0.40; `aerial-perspective`, `coastSwash`,
// `bodyReflections` WebGPU 4880 0.13-0.16; `cloud-courses` WebGL2 0.29
// (12:00 z2); `bloom` DPR-2 storm 0.82. Every other cell is unresolved
// (ceilings 0.07-2.3 ms; the day scenes' A/A spreads are the widest), and
// no row resolved at 1680x1032 (`light-clusters` has its own receipt
// below). `glitterPath` and `rainRings` shed to
// `static`, which the GPU path reads as on (only `off` gates them): forcing
// either alone changes no pixel, and their static frame at MINIMAL comes
// from `waterCrests` stopping the water clock. Rows with no switch
// (`water-reflection`, `exposure-envelope`, `time-grade`, `wet-reflection`,
// `palette-ramp`, `particle-depth`) cannot be priced this way; their bands
// stand. The rig's own K8 (one composite-sized pass per K, one context per
// run): 0.164 ms at WebGPU 4880, 0.123 at DPR 2, 0.191 at WebGL2 4880;
// 0.066 at WebGPU 1680 is unresolved (A/A 0.041). `radiance-bounce` on:
// +0.09 ms at WebGL2 4880 (1680 unresolved).
export const EFFECT_BUDGET = Object.freeze({
    bloom: Object.freeze({
        id: 'bloom',
        levels: Object.freeze({ FULL: 'on', REDUCED: 'reduced', MINIMAL: 'off' }),
        cost: Object.freeze({ gpuMsBand: [1.131, 2.232], cpuMsBand: [0.003, 0.085], bytes: 8830080, scope: 'own-pass' }),
        staticFallback: 'authored-emission',
        canvas: 'authored-emission',
    }),
    'weather-amplitude': Object.freeze({
        id: 'weather-amplitude',
        levels: Object.freeze({ FULL: 'on', REDUCED: 'reduced', MINIMAL: 'off' }),
        cost: Object.freeze({ gpuMsBand: [1.392, 2.155], cpuMsBand: [0.100, 0.150], bytes: 0, scope: 'shared-scene-envelope' }),
        staticFallback: 'phase-grade',
        canvas: 'canvas-weather',
    }),
    // 2.2 — the world-locked footprint march substitutes the screen occlusion
    // pass (its 0.375-scale RGBA8 target, 967,680 B at 1680x1032, and its
    // own draw of every occluder): per admitted light, 8 texel fetches (4 at
    // REDUCED, none at MINIMAL) of a static RG8 field along the ground segment
    // receiver foot -> light foot, only where that light already lays a
    // course. Band: LightingGI's prototype in a pass without overdraw (+0.05
    // to +0.17 ms over the loop, 1680x1032 to 5120x1440); the K8 receipt in
    // the real scene pass waits for a quiet host. `bytes`: the field
    // (`FootprintField.footprintFieldRect`, 704x384 RG8), resident from its
    // first night frame at every level.
    'footprint-occlusion': Object.freeze({
        id: 'footprint-occlusion',
        levels: Object.freeze({ FULL: 'on', REDUCED: 'four-steps', MINIMAL: 'off' }),
        cost: Object.freeze({ gpuMsBand: [0.05, 0.17], cpuMsBand: [0, 0.01], bytes: FOOTPRINT_FIELD_BYTES, scope: 'shared-scene-envelope' }),
        staticFallback: 'direct-light',
        canvas: 'ground-courses-only',
    }),
    // 1.4 — world-locked cloud shadows: one baked 256x256 noise tile
    // (262,144 B) fetched once per pixel in the composite, cut into three
    // dithered courses. Replaces the three uniform ellipses the scene pass
    // tested per fragment. MINIMAL sheds it (the grade still reads weather).
    // Paired in-session A/B of the present pass (courses + haze on vs both
    // forced off) on `ANGLE Metal Renderer: Apple M5 Pro`, 1920x1080, forced
    // FULL, dense-24, 12:00 partly cloudy, zoom 1, 2026-09-25, 26-28 samples
    // per arm, host shared with ten agents: on 1.853 / 2.129, off 3.280 /
    // 1.889. The branch never resolved above the noise floor; the band is the
    // largest on-minus-off seen, an upper bound for both composite rows.
    'cloud-courses': Object.freeze({
        id: 'cloud-courses',
        levels: Object.freeze({ FULL: 'on', REDUCED: 'on', MINIMAL: 'off' }),
        cost: Object.freeze({ gpuMsBand: [0, 0.24], cpuMsBand: [0, 0.01], bytes: 262144, scope: 'shared-composite-envelope' }),
        staticFallback: 'frozen-offset',
        canvas: 'cached-course-tile',
    }),
    // 3.4 — weather on the open sea, in the composite's open-sea branch
    // (3.3): the sunlit course where the cloud field is lowest, C-W3 cat's
    // paws (one bilinear fetch of the 128x128 R8 gust field, 16,384 B,
    // refilled from `Wind.windAt` on 125 ms motion steps) and the forecast
    // squall. The island's cloud courses reach the sea under `cloud-courses`.
    // No receipt yet (V2 quiet host pending): the band is the resolvable
    // limit of the rig that priced `cloud-courses`.
    'sea-weather': Object.freeze({
        id: 'sea-weather',
        levels: Object.freeze({ FULL: 'on', REDUCED: 'on', MINIMAL: 'off' }),
        cost: Object.freeze({ gpuMsBand: [0, 0.24], cpuMsBand: [0, 0.3], bytes: 16384, scope: 'shared-composite-envelope' }),
        staticFallback: 'frozen-offset',
        canvas: 'none',
    }),
    // W6.11 (AW-P13) — the grass gust course: on terrain grass texels at a
    // grass ramp's stop 3 (`GroundBake.GRASS_GUST_STOPS`, verge stems and the
    // meadow's upper course), where the `sea-weather` gust field (no second
    // texture) passes a static ruffle-and-Bayer order, the texel steps one
    // authored stop lighter for that 125 ms gust step. One bilinear gust
    // fetch, one cloud-tile fetch and three exact-colour tests on terrain
    // fragments only. No receipt yet (V2 quiet host pending): the band is
    // [INFERENCE] the sea cat's-paw branch's. FULL only; the static frame is
    // the baked grass (also under reduced motion).
    grassGust: Object.freeze({
        id: 'grassGust',
        levels: Object.freeze({ FULL: 'on', REDUCED: 'off', MINIMAL: 'off' }),
        cost: Object.freeze({ gpuMsBand: [0, 0.24], cpuMsBand: [0, 0.3], bytes: 0, scope: 'shared-scene-envelope' }),
        staticFallback: 'baked-grass',
        canvas: 'step-overlay',
    }),
    // 1.6 — screen-Y aerial perspective toward the C2 horizon haze; ALU only,
    // in the composite, world layer only. Same rig as `cloud-courses`.
    'aerial-perspective': Object.freeze({
        id: 'aerial-perspective',
        levels: Object.freeze({ FULL: 'on', REDUCED: 'on', MINIMAL: 'off' }),
        cost: Object.freeze({ gpuMsBand: [0, 0.24], cpuMsBand: [0, 0.005], bytes: 0, scope: 'shared-composite-envelope' }),
        staticFallback: 'none',
        canvas: 'cached-haze-stamp',
    }),
    'water-reflection': Object.freeze({
        id: 'water-reflection',
        levels: Object.freeze({ FULL: 'on', REDUCED: 'on', MINIMAL: 'on' }),
        cost: Object.freeze({ gpuMsBand: [1.392, 2.155], cpuMsBand: [0.100, 0.150], bytes: 0, scope: 'shared-scene-envelope' }),
        staticFallback: 'authored-water',
        canvas: 'authored-water',
    }),
    // Wave 3 rows. Same rig as the Wave 0 rows but re-measured at 1920x1080,
    // forced FULL, `dense-24-agents`, fixed 22:00 clear, 30 s per sample,
    // 32 samples per pass, 2026-09-06, on `ANGLE Metal Renderer: Apple M5 Pro`.
    // The host was shared with seven concurrent capture agents: the bands are
    // wide for that reason, and any delta under ~0.35 ms sits inside the noise
    // floor rather than being resolvable.
    //
    // 3.1 is a substitution, not an optional effect: it replaces the stacked
    // `lightBoost` x emissive-phase x beacon products and caps halo area, so
    // its row prices the work it *removes* (`gpuMsSavedBand`) and ships at
    // every ladder level — there is nothing here to shed. Before (neutral
    // envelope, uncapped halos): scene 1.197-1.731, bloom 1.511-2.040,
    // whole-frame 2.335-2.790. After: scene 1.054-1.466, bloom 1.080-1.723,
    // whole-frame 1.560-2.264, with the same 25 admitted lights and the same
    // 124,969,776 texture bytes.
    'exposure-envelope': Object.freeze({
        id: 'exposure-envelope',
        levels: Object.freeze({ FULL: 'on', REDUCED: 'on', MINIMAL: 'on' }),
        cost: Object.freeze({ gpuMsSavedBand: [0.143, 0.679], cpuMsBand: [0, 0.005], bytes: 0, scope: 'shared-scene-envelope' }),
        staticFallback: 'same-envelope',
        canvas: 'same-envelope',
    }),
    // Wave 3 water motion (the Waking Isle plan, M7). Each is a branch in
    // the scene pass on water or coast fragments only; the WaterSea
    // prototype put 3.1 + 3.2 + 3.6 + 3.9 together at +0.3-0.6 ms at FULL
    // [INFERENCE, loaded host], so each band is that ceiling split by ALU
    // share until the V2 K8 receipt lands on a quiet host. Every one has a
    // static frame: reduced motion freezes the water clock (u_waterFx.x 0).
    // 3.1 — palette-true crest cycle: near-shore swell and river current
    // from the R8 cycle-offset field on the 1536x768 coast lattice (unit 7),
    // the deep-sea phase field beyond. MINIMAL sheds the field and freezes
    // the water on today's static dash frame.
    waterCrests: Object.freeze({
        id: 'waterCrests',
        levels: Object.freeze({ FULL: 'on', REDUCED: 'on', MINIMAL: 'off' }),
        cost: Object.freeze({ gpuMsBand: [0, 0.25], cpuMsBand: [0, 0.005], bytes: 1179648, scope: 'shared-scene-envelope' }),
        staticFallback: 'frozen-static-dashes',
        canvas: 'step-overlay',
    }),
    // 3.2 — the sun/moon path on in-map water (replaces the FULL-only moon
    // silver course): sparse seaPath dashes under the body's screen x, one
    // hash per water fragment inside the path. MINIMAL holds a static set.
    glitterPath: Object.freeze({
        id: 'glitterPath',
        levels: Object.freeze({ FULL: 'on', REDUCED: 'on', MINIMAL: 'static' }),
        cost: Object.freeze({ gpuMsBand: [0, 0.08], cpuMsBand: [0, 0.005], bytes: 0, scope: 'shared-scene-envelope' }),
        staticFallback: 'static-speck-set',
        canvas: 'step-overlay',
    }),
    // 3.9 — rain rings on water stops, only while it rains; MINIMAL and
    // reduced motion hold a fixed 20 % ring set.
    rainRings: Object.freeze({
        id: 'rainRings',
        levels: Object.freeze({ FULL: 'on', REDUCED: 'on', MINIMAL: 'static' }),
        cost: Object.freeze({ gpuMsBand: [0, 0.08], cpuMsBand: [0, 0.005], bytes: 0, scope: 'shared-scene-envelope' }),
        staticFallback: 'static-ring-set',
        canvas: 'step-overlay',
    }),
    // 3.6 — lapping swash and the drying wet band on the terrain batch,
    // from the RG8 coast field (unit 8; also read by 3.7's ripple and 3.11's
    // water-only discard). MINIMAL leaves the baked foam lace.
    coastSwash: Object.freeze({
        id: 'coastSwash',
        levels: Object.freeze({ FULL: 'on', REDUCED: 'on', MINIMAL: 'off' }),
        cost: Object.freeze({ gpuMsBand: [0, 0.12], cpuMsBand: [0, 0.005], bytes: 2359296, scope: 'shared-scene-envelope' }),
        staticFallback: 'baked-foam-lace',
        canvas: 'step-overlay',
    }),
    // 3.10 — the clear-day caustic net on the two shallowest stops at zoom
    // >= 2 (the 2x1 seabed specks are static at every level).
    shallowCaustics: Object.freeze({
        id: 'shallowCaustics',
        levels: Object.freeze({ FULL: 'on', REDUCED: 'on', MINIMAL: 'off' }),
        cost: Object.freeze({ gpuMsBand: [0, 0.05], cpuMsBand: [0, 0.005], bytes: 0, scope: 'shared-scene-envelope' }),
        staticFallback: 'seabed-specks',
        canvas: 'step-overlay',
    }),
    // 1.1/1.2 — the C2 keyframed grade (~20 ALU on the albedo before the
    // light loop) and the multiplicative stepped light pools replace the
    // constant phase multiply and the additive flat discs in the same scene
    // pass. Not optional: every level grades the world by the clock. There is
    // no in-session A/B (the grade is not switchable); scene pass after the
    // change, same rig as `cloud-courses`: 1.763 / 1.835 at noon. The band is
    // the noise-floor ceiling used for other unresolved scene branches.
    'time-grade': Object.freeze({
        id: 'time-grade',
        levels: Object.freeze({ FULL: 'on', REDUCED: 'on', MINIMAL: 'on' }),
        cost: Object.freeze({ gpuMsBand: [0, 0.35], cpuMsBand: [0, 0.01], bytes: 0, scope: 'shared-scene-envelope' }),
        staticFallback: 'same-grade',
        canvas: 'same-grade',
    }),
    // 3.2 lays the real source hue on approved wet cobble/stone/earth. Paired
    // in-session A/B at storm 23:00 forced FULL (`storm-night-reduced-motion`):
    // on scene 0.956 / 2.091, off 2.112 / 2.431; across separate sessions on
    // 1.506-2.234, off 0.870-2.685. The branch never resolved above the host
    // noise floor, so the band is an upper bound, not a measured mean.
    'wet-reflection': Object.freeze({
        id: 'wet-reflection',
        levels: Object.freeze({ FULL: 'eight-sources', REDUCED: 'four-sources', MINIMAL: 'static-wet-darkening' }),
        cost: Object.freeze({ gpuMsBand: [0, 0.35], cpuMsBand: [0, 0.02], bytes: 0, scope: 'shared-scene-envelope' }),
        staticFallback: 'static-wet-darkening',
        canvas: 'cached-stepped-stamps',
    }),
    // 3.5 quantizes the Command pilot's admitted light to an authored ramp.
    // The table is 11x3 RGBA (132 B) plus one extra vertex float; the resident
    // texture ceiling is unchanged because `MAX_CACHED_TEXTURE_BYTES` gives up
    // exactly those bytes. Measured at 22:00 clear FULL, zoom 3 on Command:
    // scene 1.054-1.466 with the table, 1.099-1.461 without it.
    'palette-ramp': Object.freeze({
        id: 'palette-ramp',
        levels: Object.freeze({ FULL: 'on', REDUCED: 'on', MINIMAL: 'off' }),
        cost: Object.freeze({ gpuMsBand: [0, 0.05], cpuMsBand: [0, 0.005], bytes: 132, scope: 'shared-scene-envelope' }),
        staticFallback: 'authored-albedo',
        canvas: 'authored-albedo',
    }),
    // 0.1 / 2.4 — light admission is a declared row: how many ranked local
    // lights the scene pass admits (`clampGpuLights` ranks attention >
    // aperture > fixture > point; `binGpuLights` then admits in that order
    // while every 64x64 backing-px tile the light reaches has one of its 16
    // slots free; attention lights are admitted past the count). The night's
    // pools ship at every level (V2 tier contract: never below 12 at
    // MINIMAL). 2.4 moved the records into the RGBA32F light texture (unit
    // 9, MAX_LIGHT_RECORDS 256, 16 KiB baseline, like the uniform arrays it
    // replaced), so the count now covers every visible window, lamp and
    // opening at 5120x1440. Band: the ceiling is the whole FULL - MINIMAL
    // real-frame delta (WebPlatformGPU appburst, dense-24 22:00 z2
    // 4880x1392, 4.02 - 1.55 ms, which also sheds bloom and occlusion) until
    // per-level `gpu-burst.mjs` receipts land; 60 Hz assumed.
    'light-admission': Object.freeze({
        id: 'light-admission',
        levels: Object.freeze({ FULL: 128, REDUCED: 64, MINIMAL: 24 }),
        cost: Object.freeze({ gpuMsBand: [0, 2.47], cpuMsBand: [0, 0.01], bytes: 0, scope: 'shared-scene-envelope' }),
        staticFallback: 'ranked-admission',
        canvas: 'feed-ranked-48',
    }),
    // 2.4 (M6: clustering only if its receipt pays) — the switch between the
    // two walks of the SAME admitted list: `on`, each fragment walks only
    // its 64x64 tile's <= 16 lights from the R16UI tile index (unit 10,
    // tilesX*17 x tilesY: count, then light indices); `off`, every fragment
    // walks every admitted light (the flat path). Admission is binned in
    // both, so the admitted set and every lit pixel are identical:
    // `gpuWorld.setLightClusterOverride(true | false | null)` forces a walk
    // (null = this row). M6 receipt (Phase 5 quiet host, 2026-09-29): the
    // gpu-burst method with on / off / on-again arms interleaved (3 fresh
    // contexts x 8 reps x 60 frames), 22:00 clear, dense-24 and dense-100,
    // 1680x1032 and 4880x1392, z1 and z2, WebGPU and WebGL2: the flat walk
    // costs 1.42-16.96 ms more at FULL (A/A <= 0.32) and 1.28-11.46 ms more
    // with MINIMAL's 24 lights (A/A <= 1.45), all 32 cases resolved. So the
    // clustered walk ships at every level (MINIMAL included) and the row is
    // a substitution that prices the time it removes; the flat walk is only
    // the override's A/B arm. Bytes: the index at 4880x1392 (77 x 22 tiles
    // x 17 x 2 B), resident at every level. 60 Hz assumed.
    'light-clusters': Object.freeze({
        id: 'light-clusters',
        levels: Object.freeze({ FULL: 'on', REDUCED: 'on', MINIMAL: 'on' }),
        cost: Object.freeze({ gpuMsSavedBand: [1.28, 16.96], cpuMsBand: [0, 0.1], bytes: 57596, scope: 'shared-scene-envelope' }),
        staticFallback: 'flat-light-walk',
        canvas: 'none',
    }),
    // 2.10 (M6 pilot, V2 bend: RGBA16F cascades) — ground-plane radiance
    // cascades and one warm bounce (gpu/GroundRadiance.js): a 176x192-probe,
    // 4-cascade solve over the island's ground plane, re-run only when the
    // light state moves (<= 4 Hz; 6 draws: emit, 4 cascades, resolve), read
    // once per lit-candidate fragment on unit 15. OFF AT EVERY LEVEL (pilot
    // verdict, 2026-09-28: at z2 the wall-base course and the door fans do
    // not clearly improve the night frame; see the character-mode README).
    // `gpuWorld.setRadianceOverride(true | false | null)` forces it for the
    // Phase 5 A/B; to land it, set FULL 'on' and `bytes` to RADIANCE_BYTES
    // (4,071,424: scene 352x384 + 2 cascades 352x384 + result 528x192,
    // RGBA16F, and the 256x4 RGBA32F emitter rows; released whenever off, so
    // 0 resident as shipped). Band [INFERENCE] (LGI-8: ~0.3-1 ms per solve,
    // amortized; one filtered fetch per candidate fragment); the K8 receipt
    // lands with the Phase 5 A/B, 60 Hz assumed.
    'radiance-bounce': Object.freeze({
        id: 'radiance-bounce',
        levels: Object.freeze({ FULL: 'off', REDUCED: 'off', MINIMAL: 'off' }),
        cost: Object.freeze({ gpuMsBand: [0, 0.25], cpuMsBand: [0, 0.05], bytes: 0, scope: 'shared-scene-envelope' }),
        staticFallback: 'direct-light',
        canvas: 'none',
    }),
    // 0.6 — painter's depth and one instanced particle draw. Opaque sprite
    // records write a DEPTH_COMPONENT16 key from their painter sortY with
    // `depthFunc(ALWAYS)` (painter order still decides every colour), then
    // the <= 240 live particles draw once with LEQUAL and no depth write, so
    // an ember behind a building front or a nearer body is hidden and one in
    // front shows. It substitutes the ungraded, unsorted overlay replay of the
    // open-air layer and draws the foot/hand-height effects layer the resident
    // path used to drop, so it ships at every level and is never shed.
    // `bytes` stays 0 because the depth attachment is baseline, not optional:
    // it scales with the backing store at `attachmentBytesPerPixel` (3.5 MB at
    // 1680x1032, 13.6 MB at 4880x1392; Shift-D `resources.attachments.sceneDepth`).
    // Band: WebPlatformGPU's standalone WebGL2/WebGPU prototype (depth + 240
    // particles, <= 0.15 ms at 4880x1392, ~0 at 1680x1032); the V2 K8 receipt
    // in the real scene pass waits for a quiet host.
    'particle-depth': Object.freeze({
        id: 'particle-depth',
        levels: Object.freeze({ FULL: 'on', REDUCED: 'on', MINIMAL: 'on' }),
        cost: Object.freeze({
            gpuMsBand: [0, 0.15],
            cpuMsBand: [0, 0.03],
            bytes: 0,
            attachmentBytesPerPixel: 2,
            scope: 'shared-scene-envelope',
        }),
        staticFallback: 'same-depth-pass',
        canvas: 'depth-sorted-drawables',
    }),
    // 3.11 (M11) — bodies standing on piers, bridges and banks (feet within
    // 0.3 tiles of water) get a `reflect` twin record in the ground band:
    // water-only, row ripple, dropped rows, three alpha courses. At most 12,
    // nearest the camera centre; FULL only. No render target: +N records
    // (typically 0-10) sharing the agent atlas. Band [INFERENCE] from the
    // WS-7 note (one extra sprite record each); receipt on a quiet host.
    bodyReflections: Object.freeze({
        id: 'bodyReflections',
        levels: Object.freeze({ FULL: 'on', REDUCED: 'off', MINIMAL: 'off' }),
        cost: Object.freeze({ gpuMsBand: [0, 0.03], cpuMsBand: [0, 0.02], bytes: 0, scope: 'shared-scene-envelope' }),
        staticFallback: 'none',
        canvas: 'none',
    }),
});

const EFFECT_LEVEL_NAMES = ['FULL', 'REDUCED', 'MINIMAL'];

/**
 * What the named effect does at a resident quality level: `on`, a named
 * degraded mode, `off`, or a count (`light-admission`). Levels beyond MINIMAL
 * (the minimal-resident override) keep MINIMAL's row; the renderer never
 * renders below it.
 */
export function effectBudgetMode(id, level) {
    const effect = EFFECT_BUDGET[id];
    if (!effect) throw new Error(`unknown effect budget: ${id}`);
    const index = Math.min(EFFECT_LEVEL_NAMES.length - 1, Math.max(0, Math.round(Number(level) || 0)));
    return effect.levels[EFFECT_LEVEL_NAMES[index]];
}

/** Effects not at their FULL mode, in declared shedding order. */
export function shedEffectsForLevel(level) {
    const shed = [];
    for (const effect of Object.values(EFFECT_BUDGET)) {
        const mode = effectBudgetMode(effect.id, level);
        if (mode !== effect.levels.FULL) shed.push({ id: effect.id, mode });
    }
    return shed;
}

// C2 — the grade is no longer six constant phase rows. `GradeEvaluator`
// interpolates eight authored daily keys plus weather and moon rows on the
// CPU; every backend runs this one GLSL block on the unpremultiplied albedo
// (resident scene pass, hybrid PostFx) or its CPU mirror (Canvas), then adds
// local light pools and authored emission after it, so lit pixels are exempt
// from the night desaturation.
export const GRADE_UNIFORM_NAMES = Object.freeze([
    'u_gradeExposure', 'u_gradeSaturation', 'u_gradeGain', 'u_gradeLift',
    'u_gradeGamma', 'u_gradePurkinje', 'u_gradeShadow', 'u_gradeHighlight',
    'u_gradeEdge', 'u_edgeAlpha', 'u_poolGain',
]);

// The numbers GRADE_GLSL and its WebGPU twin (wgsl/grade.js GRADE_WGSL) share,
// each interpolated into both dialects at the precision written here, so the
// two shaders cannot drift apart and a change here changes both (CanvasGrade
// mirrors the pool/land stops on the CPU).
export const GRADE_CONSTANTS = Object.freeze({
    WATER_MAX_SATURATION: Object.freeze({ value: WATER_MAX_SATURATION, digits: 3 }),
    POOL_RIM: Object.freeze({ value: Object.freeze([1.484, 0.914, 0.430]), digits: 3 }),
    POOL_MID: Object.freeze({ value: Object.freeze([1.208, 0.981, 0.577]), digits: 3 }),
    POOL_CORE: Object.freeze({ value: Object.freeze([1.089, 0.995, 0.786]), digits: 3 }),
    LAND_MID: Object.freeze({ value: Object.freeze([1.346, 0.948, 0.504]), digits: 3 }),
    LAND_SHARE: Object.freeze({ value: Object.freeze([0.84, 0.88, 0.90]), digits: 2 }),
    LAND_FULL_STRENGTH: Object.freeze({ value: LAND_FULL_STRENGTH, digits: 2 }),
    RECEIVER_LUMA_CEILING: Object.freeze({ value: RECEIVER_LUMA_CEILING, digits: 4 }),
    RECEIVER_HEADROOM: Object.freeze({ value: 0.018, digits: 3 }),
    RECEIVER_OKL_CEILING: Object.freeze({ value: 0.836, digits: 3 }),
    ATTENTION_OKL_CEILING: Object.freeze({ value: 0.852, digits: 3 }),
});

/** One GRADE_CONSTANTS entry as shader literal text (`1.484, 0.914, 0.430` for a triple). */
export function gradeLiteral(constants, name) {
    const { value, digits } = constants[name];
    return Array.isArray(value) ? value.map(lane => lane.toFixed(digits)).join(', ') : value.toFixed(digits);
}

/** GRADE_GLSL from a constants table (the shipped one is `GRADE_CONSTANTS`). */
export function gradeGlsl(constants = GRADE_CONSTANTS) {
    const k = name => gradeLiteral(constants, name);
    return `
uniform float u_gradeExposure;
uniform float u_gradeSaturation;
uniform vec3 u_gradeGain;
uniform vec3 u_gradeLift;
uniform vec3 u_gradeGamma;
uniform vec3 u_gradePurkinje;
uniform vec3 u_gradeShadow;
uniform vec3 u_gradeHighlight;
uniform vec3 u_gradeEdge;
uniform float u_edgeAlpha;
// 1.2 — pool multiply strength from the grade (falls as the ambient rises).
uniform float u_poolGain;

const vec3 GRADE_LUMA = vec3(0.2126, 0.7152, 0.0722);

// Night desaturates toward a Purkinje-blue grey, the key light and weather
// set the ambient, the lift keeps a floor, and a luminance-keyed split tone
// gives golden hour warm highlights over violet shadows. \`lift\` is false for
// additive batches so a full-viewport additive field never lifts the void.
vec3 applyTimeGrade(vec3 albedo, bool lift) {
    float lin = dot(albedo, GRADE_LUMA);
    vec3 c = mix(vec3(lin) * u_gradePurkinje, albedo, u_gradeSaturation);
    c = max(c, vec3(0.0)) * u_gradeGain * u_gradeExposure;
    if (lift) c = u_gradeLift + c * (1.0 - u_gradeLift);
    c = pow(max(c, vec3(0.0)), u_gradeGamma);
    float sh = 1.0 - smoothstep(0.06, 0.42, lin);
    float hi = smoothstep(0.38, 0.82, lin);
    c *= mix(mix(vec3(1.0), u_gradeShadow, sh), u_gradeHighlight, hi);
    // Highlight protection: a channel pushed past 1 scales the pixel down
    // instead of clipping to a flat hue.
    return c / max(1.0, max(c.r, max(c.g, c.b)));
}

// V6 — graded water held at WATER_MAX_SATURATION (HSV), pulled toward its
// own luma so hue, luma and the cool R−B sign are kept. The CPU twin is
// GradeEvaluator \`capSaturation\` (CoastBake's outer ocean).
const float WATER_MAX_SATURATION = ${k('WATER_MAX_SATURATION')};
vec3 capSaturation(vec3 c, float maxS) {
    float hi = max(c.r, max(c.g, c.b));
    float spread = hi - min(c.r, min(c.g, c.b));
    if (hi <= 0.0 || spread <= maxS * hi) return c;
    float y = dot(c, GRADE_LUMA);
    float k = clamp(maxS * y / max(1e-6, spread - maxS * (hi - y)), 0.0, 1.0);
    return y + (c - y) * k;
}

// 1.2 — stepped light pools. Each light is stepped on its own falloff
// \`shape\` (0..1, occlusion applied): three courses at 0.12 / 0.40 / 0.75
// with an ordered dither (\`order\` in [0, 1)) on the edges, so every pool has
// a rim, a mid ring and a core at ~0.8 / 0.54 / 0.33 of its radius whatever
// its intensity (a bright brazier no longer fills its disc with one flat
// core). The caller accumulates \`colour x poolWeight(steps) x energy\` and the
// deepest step at the pixel.
float poolSteps(float shape, float order) {
    float q = shape + (order - 0.5) * 0.08;
    return step(0.12, q) + step(0.40, q) + step(0.75, q);
}

float poolWeight(float steps) {
    return steps < 0.5 ? 0.0 : steps < 1.5 ? 0.30 : steps < 2.5 ? 0.54 : 0.76;
}

// Warm sources (lanterns, braziers, windows) land on the C1 emissive ramp —
// #ff9d4a rim, #ffcf7a mid, #ffe9b8 core, luma-normalised — so each course
// reads as its own amber step; cool/rune lights keep 70 % of their own hue.
const vec3 POOL_RIM = vec3(${k('POOL_RIM')});
const vec3 POOL_MID = vec3(${k('POOL_MID')});
const vec3 POOL_CORE = vec3(${k('POOL_CORE')});
// The course tint of an accumulated light (luma-normalised) and its strength.
vec3 poolTint(vec3 light, float steps, out float strength, out float warm) {
    float l = dot(light, GRADE_LUMA);
    vec3 hue = light / l;
    warm = clamp((hue.r - hue.b) * 1.25, 0.0, 1.0);
    strength = min(l, 1.0);
    vec3 ramp = steps < 1.5 ? POOL_RIM : steps < 2.5 ? POOL_MID : POOL_CORE;
    return mix(mix(vec3(1.0), hue, 0.7), ramp, warm);
}

// 1.2 — where a warm pool lands. Light added onto a receiver keeps the
// receiver's hue (blue night grass + amber = lime, blue-grey stone + amber =
// khaki), so each warm course also pulls the lit pixel toward its own stop on
// the C1 emissive ramp at the pixel's luma: the rim on #ff9d4a, the mid ring
// half way to #ffcf7a, the core on #ffcf7a. The core lands one stop below the
// flame core (#ffe9b8), so the source still reads brighter and the core keeps
// its chroma. Luma is kept, so the receiver's texture stays in the value.
const vec3 LAND_RIM = POOL_RIM;
const vec3 LAND_MID = vec3(${k('LAND_MID')});
const vec3 LAND_CORE = POOL_MID;
// Share of the landing per course (rim, mid, core) at full pool light: high
// enough that a pool on night grass lands on its amber stop instead of
// reading as khaki or olive (the grass's own green keeps a sixth at most).
const vec3 LAND_SHARE = vec3(${k('LAND_SHARE')});
// The least share of the value a course lands with, whatever the pool adds:
// the thin outer course on night grass adds little value, so without a floor
// its green kept most of the pixel and it read khaki-olive beside the amber
// inner course. The floor is the pool's own strength over
// LAND_FULL_STRENGTH, one rule on every course: a deeper course only lies
// where more light falls, so an inner course never lands duller than the rim
// round it and no light, however faint, lands as a ring (a lantern lands
// every course in full, a faint light every course in part). Luma is kept,
// so the value ladder is unchanged.
const float LAND_FULL_STRENGTH = ${k('LAND_FULL_STRENGTH')};
// The stop at luma \`y\`, pulled toward grey only as far as the gamut needs
// (hue and luma kept).
vec3 onStop(vec3 stop, float y) {
    vec3 c = stop * y;
    float hi = max(c.r, max(c.g, c.b));
    return hi > 1.0 ? y + (c - y) * ((1.0 - y) / (hi - y)) : c;
}

// V5 — the receiver ceiling (C1 \`RECEIVER_LUMA_CEILING\`, encoded Rec.709
// luma, okL 0.80). Light that lifts a receiver above it, or above the
// receiver's own graded value where daylight already put it higher, keeps a
// quarter of the excess at the knee, so the cobble under a pool core keeps
// its texture instead of clipping to cream. Summed lamps can put several
// times the ceiling on bright stone, so the quarter-slope eases into a fixed
// headroom (0.018 luma) instead of running on to white; the course steps stay
// distinct because the curve never goes flat. The knee takes value only: the
// colour's offset from its luma is kept (fitted into gamut), so a pool keeps
// its warmth and chroma instead of greying as it is pulled down — scaling the
// colour by y2/y cost the plaza pools a third of their R−B.
const float RECEIVER_LUMA_CEILING = ${k('RECEIVER_LUMA_CEILING')};
const float RECEIVER_HEADROOM = ${k('RECEIVER_HEADROOM')};
vec3 kneeValue(vec3 lit, float y, float ceilY) {
    float kneed = ceilY + RECEIVER_HEADROOM * (1.0 - exp(-(y - ceilY) * 0.25 / RECEIVER_HEADROOM));
    vec3 chroma = lit - y;
    float lo = min(chroma.r, min(chroma.g, chroma.b));
    float hi = max(chroma.r, max(chroma.g, chroma.b));
    float fit = 1.0;
    if (lo < 0.0) fit = min(fit, kneed / -lo);
    if (hi > 0.0) fit = min(fit, (1.0 - kneed) / hi);
    return kneed + chroma * fit;
}
vec3 lumaKnee(vec3 lit, float floorLuma) {
    float y = dot(lit, GRADE_LUMA);
    float ceilY = max(RECEIVER_LUMA_CEILING, floorLuma);
    return y <= ceilY ? lit : kneeValue(lit, y, ceilY);
}
// V5 — encoded luma under-reads saturated yellow and amber (#ffc71a sits at
// luma 0.80 but okL 0.87), so a lit receiver is also held at okL
// \`RECEIVER_OKL_CEILING\` (0.836: under 0.84 after 8-bit rounding), or at its
// own graded value (\`floorColour\`) where daylight or an authored emitter
// already put it higher. Scaling linear light by k scales okL by cbrt(k), so
// the cap is exact and keeps hue. Only a pixel with a channel above 0.74 can
// reach it (grey 0.74 is okL 0.79).
const float RECEIVER_OKL_CEILING = ${k('RECEIVER_OKL_CEILING')};
const float ATTENTION_OKL_CEILING = ${k('ATTENTION_OKL_CEILING')};
vec3 decodeSrgb(vec3 c) {
    c = max(c, vec3(0.0));
    return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), c));
}
vec3 encodeSrgb(vec3 l) {
    l = max(l, vec3(0.0));
    return mix(l * 12.92, 1.055 * pow(l, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), l));
}
float okLightness(vec3 lin) {
    vec3 lms = vec3(
        dot(lin, vec3(0.4122214708, 0.5363325363, 0.0514459929)),
        dot(lin, vec3(0.2119034982, 0.6806995451, 0.1073969566)),
        dot(lin, vec3(0.0883024619, 0.2817188376, 0.6299787005))
    );
    lms = pow(max(lms, vec3(0.0)), vec3(1.0 / 3.0));
    return dot(lms, vec3(0.2104542553, 0.7936177850, -0.0040720468));
}
vec3 okCeiling(vec3 lit, vec3 floorColour, float ceilL) {
    if (max(lit.r, max(lit.g, lit.b)) <= 0.74) return lit;
    vec3 lin = decodeSrgb(lit);
    float l = okLightness(lin);
    if (l <= ceilL) return lit;
    float floorL = max(ceilL, okLightness(decodeSrgb(floorColour)));
    if (l <= floorL) return lit;
    float k = floorL / l;
    return encodeSrgb(lin * (k * k * k));
}
vec3 receiverKnee(vec3 lit, float floorLuma) {
    return okCeiling(lumaKnee(lit, floorLuma), vec3(floorLuma), RECEIVER_OKL_CEILING);
}

// V5 — the single landing function for local light. \`ambient\` is the summed
// ambient pool light and \`ambientSteps\` its deepest course; \`attention\` the
// strongest action-needed light at the pixel (max, never summed) and its
// course; \`reflection\` the summed water and wet-ground reflection adds. The
// light multiplies the albedo's luminance with 55 % of its chroma (AD-5).
// Once the pools carry the frame (poolGain rises as the ambient falls), a
// warm course trades part of the graded ambient's blue night cast for its own
// hue (blue + amber would grey the pool into peach), and lands on its C1 stop
// in proportion to the share of the pixel's value the pool supplies: grass,
// stone and timber under a lantern read as warm courses of their own value,
// never lime or khaki (maintainer, round 2: warmer pools). Ambient pools and
// reflections land together through one receiver knee against the graded
// (pre-loop) luma. The attention course is added after that knee, so it is
// always the brightest pool, and eases into its own ceiling one headroom
// above the receivers' (okL <= 0.852): the T1 plate fill (okL 0.862) stays
// brighter than every lit world pixel. \`land\` scales the hue landing (1 on
// the ground and walls; a body passes less, so a figure in a warm pool reads
// as warm light on its own costume colour, which names the agent, instead of
// an amber silhouette). Returns the lit colour.
vec3 stepPool(vec3 graded, vec3 ambient, float ambientSteps, vec3 attention, float attentionSteps, vec3 albedo, vec3 reflection, float land) {
    bool lit = ambientSteps > 0.5 && dot(ambient, GRADE_LUMA) > 0.01;
    bool marked = attentionSteps > 0.5 && dot(attention, GRADE_LUMA) > 0.01;
    if (!lit && !marked && reflection == vec3(0.0)) return graded;
    float gradedLuma = dot(graded, GRADE_LUMA);
    vec3 base = mix(vec3(dot(albedo, GRADE_LUMA)), albedo, 0.55);
    float carry = clamp((u_poolGain - 0.15) / 1.05, 0.0, 1.0);
    float strength;
    float warm;
    float landWarm = 0.0;
    vec3 result = graded;
    vec3 add = reflection;
    if (lit) {
        vec3 tint = poolTint(ambient, ambientSteps, strength, warm);
        vec3 pool = tint * strength;
        float adapt = min(1.0, strength * 1.5) * warm * (0.85 * 0.6) * carry * land;
        result = mix(graded, gradedLuma * tint, adapt);
        add += base * pool * u_poolGain + pool * 0.035 * u_poolGain;
        landWarm = warm;
    }
    result = lumaKnee(result + add, gradedLuma);
    if (landWarm > 0.0) {
        float y = dot(result, GRADE_LUMA);
        float share = clamp((y - gradedLuma) / max(y, 0.02) * 1.6, 0.0, 1.0);
        vec3 stop = ambientSteps < 1.5 ? LAND_RIM : ambientSteps < 2.5 ? LAND_MID : LAND_CORE;
        float course = ambientSteps < 1.5 ? LAND_SHARE.x : ambientSteps < 2.5 ? LAND_SHARE.y : LAND_SHARE.z;
        share = max(share, min(1.0, strength / LAND_FULL_STRENGTH));
        result = mix(result, onStop(stop, y), landWarm * share * course * land);
    }
    result = okCeiling(result, graded, RECEIVER_OKL_CEILING);
    if (marked) {
        vec3 tint = poolTint(attention, attentionSteps, strength, warm);
        vec3 pool = tint * strength;
        if (!lit) {
            float adapt = min(1.0, strength * 1.5) * warm * (0.85 * 0.6) * carry;
            result = mix(result, dot(result, GRADE_LUMA) * tint, adapt);
        }
        result += base * pool * u_poolGain + pool * 0.035 * u_poolGain;
        float y = dot(result, GRADE_LUMA);
        float ceilY = max(RECEIVER_LUMA_CEILING + RECEIVER_HEADROOM, gradedLuma);
        if (y > ceilY) result = kneeValue(result, y, ceilY);
        result = okCeiling(result, graded, ATTENTION_OKL_CEILING);
    }
    return result;
}

// The stepped edge darkening. \`topLeftPx\` is in top-left screen pixels.
vec3 applyGradeVignette(vec3 color, vec2 topLeftPx, vec2 resolution) {
    vec2 centre = vec2(resolution.x * 0.5, resolution.y * 0.46);
    float inner = min(resolution.x, resolution.y) * 0.18;
    float outer = max(resolution.x, resolution.y) * 0.72;
    float t = clamp((distance(topLeftPx, centre) - inner) / max(1.0, outer - inner), 0.0, 1.0);
    float edge = u_edgeAlpha * (step(0.62, t) * 0.4 + step(0.84, t) * 0.6);
    return color * mix(vec3(1.0), u_gradeEdge, edge);
}
`;
}

export const GRADE_GLSL = gradeGlsl();

/** Upload one evaluated C2 grade to a program that includes GRADE_GLSL. */
export function uploadGradeUniforms(gl, uniforms, grade) {
    gl.uniform1f(uniforms.u_gradeExposure, grade.exposure);
    gl.uniform1f(uniforms.u_gradeSaturation, grade.saturation);
    gl.uniform3fv(uniforms.u_gradeGain, grade.gain);
    gl.uniform3fv(uniforms.u_gradeLift, grade.lift);
    gl.uniform3fv(uniforms.u_gradeGamma, grade.gamma);
    gl.uniform3fv(uniforms.u_gradePurkinje, grade.purkinje);
    gl.uniform3fv(uniforms.u_gradeShadow, grade.shadowTint);
    gl.uniform3fv(uniforms.u_gradeHighlight, grade.highlightTint);
    gl.uniform3fv(uniforms.u_gradeEdge, grade.vignetteEdge);
    gl.uniform1f(uniforms.u_edgeAlpha, grade.vignetteAlpha);
    gl.uniform1f(uniforms.u_poolGain, grade.poolGain ?? 1);
}

// 1.4 — world-locked cloud shadows. One tileable 256x256 value-noise field
// (two octaves plus a detail octave), baked once, sampled in world space by
// every record (ATMOSPHERE_COURSES_GLSL) and the open sea, and cut into three
// dithered courses there. Pure: no DOM.
export const CLOUD_TILE_SIZE = 256;
// World pixels per tile texel: one tile spans 1024 world px.
export const CLOUD_TILE_WORLD_SCALE = 4;
// 3.4 — a 1024 px tile repeats ~4.8x across a 5120 z1 frame, so the field is
// the tile read twice: `max(n1, weight x n2)`, n2 at `scale` x the size and
// shifted by `offset` world px. 1.75 x 1024 = 1792, so the combined field
// repeats every lcm(1024, 1792) = 7168 world px (CLOUD_FIELD_PERIOD); the
// drift wraps on that period.
export const CLOUD_SECOND_OCTAVE = Object.freeze({ scale: 1.75, offset: Object.freeze([317, 911]), weight: 0.9 });
export const CLOUD_FIELD_PERIOD = 7168;
// W6.3 — the lone cumulus: the shaders mix the field 0.3 : 0.7 with a dome
// (1 - r / radius) round the cloud's field point and cut two courses at
// these values, so the patch reaches about 0.35–0.6 of its radius.
export const LONE_CLOUD_MIX = 0.7;
export const LONE_CLOUD_THRESHOLDS = Object.freeze([0.55, 0.68]);

/**
 * 1.4 / 3.4 — the share of the ground and sea under a cloud course at a
 * weather's cloud cover, one rule for both backends (GpuFrameState
 * `resolveAtmosphereCourses`, CloudShadowCourses). A fair-weather sky (cover
 * below 0.15) casts none, so a clear day reads clear on the 5120 sea; the
 * share then rises on one slope (partly cloudy 0.45 -> 0.38) to 0.45.
 */
export function cloudCoveredShare(cover) {
    const value = Number(cover);
    return Math.max(0, Math.min(0.45, ((Number.isFinite(value) ? value : 0) - 0.15) * 1.27));
}

function sampleCloudTile(data, size, u, v) {
    // Bilinear with REPEAT, texel centres at (i + 0.5) / size: the GPU's
    // LINEAR sampler on the uploaded tile.
    const x = u * size - 0.5;
    const y = v * size - 0.5;
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const fx = x - x0;
    const fy = y - y0;
    const at = (ix, iy) => data[((((iy % size) + size) % size) * size + (((ix % size) + size) % size)) * 4] / 255;
    const top = at(x0, y0) + (at(x0 + 1, y0) - at(x0, y0)) * fx;
    const bottom = at(x0, y0 + 1) + (at(x0 + 1, y0 + 1) - at(x0, y0 + 1)) * fx;
    return top + (bottom - top) * fy;
}

/**
 * 3.4 — the combined cloud field at world point (x, y) (drift applied by the
 * caller), as the shader reads it from the RGBA tile `data`.
 */
export function cloudFieldAt(data, x, y, size = CLOUD_TILE_SIZE) {
    const span = CLOUD_TILE_WORLD_SCALE * size;
    const n1 = sampleCloudTile(data, size, x / span, y / span);
    const { scale, offset, weight } = CLOUD_SECOND_OCTAVE;
    const n2 = sampleCloudTile(data, size, (x / scale + offset[0]) / span, (y / scale + offset[1]) / span);
    return Math.max(n1, n2 * weight);
}

/**
 * The combined field's values over one CLOUD_FIELD_PERIOD, sorted ascending:
 * a covered share maps to an exact noise threshold (`sorted[(1 - share) n]`).
 */
export function sortedCloudField(data, size = CLOUD_TILE_SIZE, samples = 384) {
    const out = new Float32Array(samples * samples);
    const step = CLOUD_FIELD_PERIOD / samples;
    for (let j = 0; j < samples; j++) {
        for (let i = 0; i < samples; i++) out[j * samples + i] = cloudFieldAt(data, (i + 0.5) * step, (j + 0.5) * step, size);
    }
    return out.sort();
}

export function buildCloudShadowTile(size = CLOUD_TILE_SIZE, seed = 0x5eed) {
    const data = new Uint8Array(size * size * 4);
    const hash = (x, y, octave) => {
        let h = (x * 374761393 + y * 668265263 + octave * 2147483647 + seed) | 0;
        h = Math.imul(h ^ (h >>> 13), 1274126177);
        return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
    };
    const fade = t => t * t * (3 - 2 * t);
    const octaves = [
        { cells: 4, weight: 0.58 },
        { cells: 8, weight: 0.28 },
        { cells: 16, weight: 0.14 },
    ];
    const field = new Float32Array(size * size);
    let min = Infinity;
    let max = -Infinity;
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            let value = 0;
            for (let index = 0; index < octaves.length; index++) {
                const { cells, weight } = octaves[index];
                const fx = (x / size) * cells;
                const fy = (y / size) * cells;
                const x0 = Math.floor(fx);
                const y0 = Math.floor(fy);
                const tx = fade(fx - x0);
                const ty = fade(fy - y0);
                // Lattice indices wrap on the cell count, so the tile repeats.
                const a = hash(x0 % cells, y0 % cells, index);
                const b = hash((x0 + 1) % cells, y0 % cells, index);
                const c = hash(x0 % cells, (y0 + 1) % cells, index);
                const d = hash((x0 + 1) % cells, (y0 + 1) % cells, index);
                value += weight * ((a + (b - a) * tx) + ((c + (d - c) * tx) - (a + (b - a) * tx)) * ty);
            }
            field[y * size + x] = value;
            if (value < min) min = value;
            if (value > max) max = value;
        }
    }
    const span = Math.max(1e-6, max - min);
    for (let index = 0; index < field.length; index++) {
        const value = Math.round(((field[index] - min) / span) * 255);
        const offset = index * 4;
        data[offset] = value;
        data[offset + 1] = value;
        data[offset + 2] = value;
        data[offset + 3] = 255;
    }
    return data;
}

// 1.6 — screen-Y aerial perspective strength by zoom (survey 0.18, tier 1
// 0.14, tier 2 0.08, tier 3 0.04), raised by fog.
export function aerialPerspectiveStrength(zoom = 1, fog = 0) {
    const z = Math.max(0.25, Number(zoom) || 1);
    const stops = [[0.5, 0.18], [1, 0.14], [2, 0.08], [3, 0.04]];
    let strength = stops[stops.length - 1][1];
    if (z <= stops[0][0]) strength = stops[0][1];
    else {
        for (let index = 1; index < stops.length; index++) {
            const [z1, s1] = stops[index];
            const [z0, s0] = stops[index - 1];
            if (z <= z1) {
                strength = s0 + (s1 - s0) * ((z - z0) / (z1 - z0));
                break;
            }
        }
    }
    return strength * (1 + Math.max(0, Math.min(1, Number(fog) || 0)));
}

// Ambient sources currently use the registry default (0). Keeping attention
// in an explicit high band makes the operator signal stable if ambient source
// priorities grow later.
export const GPU_ATTENTION_LIGHT_PRIORITY = 1_000_000;

// Compatibility aliases stay public for focused renderer tests, while the
// manifest/tooling registry is the single numeric authority.
export const GPU_MATERIAL_CLASSES = Object.freeze({
    ...MATERIAL_CLASS_IDS,
    default: MATERIAL_CLASS_IDS.unlit,
    rune: MATERIAL_CLASS_IDS['glass-rune'],
});

const VALID_MODES = new Set(Object.values(GPU_WORLD_RENDERER_MODES));

// PostFxFeed and the direct GPU renderer share this slot shape. Colors stay in
// 0-255 byte space until the renderer stages normalized uniforms; keeping the
// conversion here prevents a string-vs-channel contract drift from silently
// replacing authored light colors with a fallback.
export const GPU_LIGHT_COLOR_ENCODING = 'rgb-255';

export function setGpuLightColor(slot, rgb = []) {
    if (!slot || !Array.isArray(rgb) || rgb.length < 3) return slot;
    slot.r = Math.max(0, Math.min(255, finite(rgb[0], 255)));
    slot.g = Math.max(0, Math.min(255, finite(rgb[1], 255)));
    slot.b = Math.max(0, Math.min(255, finite(rgb[2], 255)));
    return slot;
}

export function gpuLightColorForShader(light = {}, fallback = [1, 0.78, 0.42], target = null) {
    const output = target || new Array(3);
    const r = Number(light?.r);
    const g = Number(light?.g);
    const b = Number(light?.b);
    if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) {
        output[0] = fallback[0];
        output[1] = fallback[1];
        output[2] = fallback[2];
        return output;
    }
    output[0] = Math.max(0, Math.min(1, r / 255));
    output[1] = Math.max(0, Math.min(1, g / 255));
    output[2] = Math.max(0, Math.min(1, b / 255));
    return output;
}

export function createGpuTimingMetricsScratch() {
    return {
        cpu: {
            source: 'cpu-fallback',
            metrics: { uploadMs: 0, frameGapMs: 0, shaderCpuMs: 0 },
        },
        gpu: {
            source: 'gpu-timer',
            metrics: { uploadMs: 0, frameGapMs: 0, gpuMs: 0 },
        },
    };
}

export function selectGpuTimingMetrics({
    uploadMs = 0,
    shaderCpuMs = 0,
    gpuMs = null,
    gpuTimerSupported = false,
    frameGapMs = 0,
} = {}, scratch = null) {
    const useGpu = Boolean(
        gpuTimerSupported
        && gpuMs !== null
        && gpuMs !== undefined
        && Number.isFinite(Number(gpuMs)),
    );
    const result = scratch?.cpu && scratch?.gpu
        ? (useGpu ? scratch.gpu : scratch.cpu)
        : scratch || null;
    if (!result) {
        return {
            source: useGpu ? 'gpu-timer' : 'cpu-fallback',
            metrics: {
                uploadMs: Math.max(0, finite(uploadMs)),
                frameGapMs: Math.max(0, finite(frameGapMs)),
                ...(useGpu
                    ? { gpuMs: Math.max(0, finite(gpuMs)) }
                    : { shaderCpuMs: Math.max(0, finite(shaderCpuMs)) }),
            },
        };
    }
    const metrics = result.metrics ||= {};
    metrics.uploadMs = Math.max(0, finite(uploadMs));
    metrics.frameGapMs = Math.max(0, finite(frameGapMs));
    if (useGpu) {
        metrics.gpuMs = Math.max(0, finite(gpuMs));
        delete metrics.shaderCpuMs;
    } else {
        metrics.shaderCpuMs = Math.max(0, finite(shaderCpuMs));
        delete metrics.gpuMs;
    }
    result.source = useGpu ? 'gpu-timer' : 'cpu-fallback';
    return result;
}

function finite(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

// A software rasterizer (SwiftShader, llvmpipe, lavapipe, WARP) runs the
// resident diorama's shaders on the CPU: its cost grows with the whole shader
// (every branch), so the scene and composite programs JIT for seconds on the
// first frame and then draw at a few frames per second, with the main thread
// blocked on each frame's readback. The Canvas world is the faster picture
// there. Matched on the unmasked renderer string (the browser's own
// `failIfMajorPerformanceCaveat` judgement is the other signal).
const SOFTWARE_RASTER_PATTERN = /\b(swiftshader|llvmpipe|softpipe|lavapipe|software rasterizer|microsoft basic render)\b/i;

export function isSoftwareRasterizer(rendererString) {
    return SOFTWARE_RASTER_PATTERN.test(String(rendererString || ''));
}

// The renderer `?renderer=` forces: exactly `webgl`, `webgpu` or `canvas` (any
// case), else null. Only a forced mode may skip the software-raster probe; an
// empty or unknown value takes the default like no parameter at all.
export function forcedGpuWorldRendererMode(search = '') {
    const params = search instanceof URLSearchParams
        ? search
        : new URLSearchParams(String(search || '').replace(/^\?/, ''));
    const requested = String(params.get('renderer') || '').trim().toLowerCase();
    return Object.values(GPU_WORLD_RENDERER_MODES).includes(requested) ? requested : null;
}

// Stage B (webgpu contract §8.1, §9.3): WebGPU is the default only in a
// Chromium-family browser (Dawn: the engine the parity gate measured).
// `navigator.userAgentData.brands` names Chromium in Chrome, Edge, Brave and
// Opera; where it is absent or empty (an insecure context, a UA override) the
// UA string decides. Safari (its own WebGPU compiler, not yet gated in
// Safari) and Firefox never match: they default to WebGL2.
const CHROMIUM_BRAND_PATTERN = /^(chromium|google chrome)$/i;
const CHROMIUM_UA_PATTERN = /\b(?:headless)?(?:chrome|chromium)\/\d/i;

export function isChromiumBrowser(nav = globalThis.navigator) {
    const brands = nav?.userAgentData?.brands;
    if (Array.isArray(brands) && brands.length) {
        return brands.some(entry => CHROMIUM_BRAND_PATTERN.test(String(entry?.brand || '').trim()));
    }
    return CHROMIUM_UA_PATTERN.test(String(nav?.userAgent || ''));
}

// Whether backend selection should request a WebGPU adapter, device and
// pipelines before `show()`: `?renderer=webgpu` anywhere, or no forced mode
// in a Chromium browser (`chromium`) whose WebGL2 rasterizer is hardware (a
// software one takes the Canvas world before any adapter is requested).
// Never under `?postfx=0` or without `navigator.gpu` (`gpu`).
export function shouldProbeWebGpu(search = '', { chromium = false, gpu = false, softwareRaster = false } = {}) {
    const params = search instanceof URLSearchParams
        ? search
        : new URLSearchParams(String(search || '').replace(/^\?/, ''));
    if (!gpu || params.get('postfx') === '0') return false;
    const forced = forcedGpuWorldRendererMode(params);
    if (forced) return forced === GPU_WORLD_RENDERER_MODES.WEBGPU;
    return chromium && !softwareRaster;
}

// Precedence, first match wins:
// 1. `?renderer=canvas` → Canvas.
// 2. `?renderer=webgpu` → WebGPU when a hardware adapter, its device and the
//    world's pipelines were had (`webgpu`); Canvas on a fallback (software)
//    adapter (`webgpuSoftware`); else WebGL2, else Canvas.
// 3. `?renderer=webgl` → WebGL2 wherever it exists (a software rasterizer
//    included), else Canvas.
// 4. No forced mode: a software WebGL2 rasterizer or a fallback WebGPU
//    adapter → Canvas; a Chromium browser (`chromium`) with a WebGPU world
//    (`webgpu`) → WebGPU (Stage B); else hardware WebGL2 → WebGL2; else
//    Canvas. Safari and Firefox (`chromium` false) default to WebGL2.
export function resolveGpuWorldRendererMode(search = '', {
    webgl2 = true, softwareRaster = false, webgpu = false, webgpuSoftware = false, chromium = false,
} = {}) {
    const forced = forcedGpuWorldRendererMode(search);
    if (forced === GPU_WORLD_RENDERER_MODES.CANVAS) return GPU_WORLD_RENDERER_MODES.CANVAS;
    if (forced === GPU_WORLD_RENDERER_MODES.WEBGPU) {
        if (webgpu) return GPU_WORLD_RENDERER_MODES.WEBGPU;
        if (webgpuSoftware) return GPU_WORLD_RENDERER_MODES.CANVAS;
        return webgl2 ? GPU_WORLD_RENDERER_MODES.WEBGL : GPU_WORLD_RENDERER_MODES.CANVAS;
    }
    if (forced === GPU_WORLD_RENDERER_MODES.WEBGL) {
        return webgl2 ? GPU_WORLD_RENDERER_MODES.WEBGL : GPU_WORLD_RENDERER_MODES.CANVAS;
    }
    if (softwareRaster || webgpuSoftware) return GPU_WORLD_RENDERER_MODES.CANVAS;
    if (chromium && webgpu) return GPU_WORLD_RENDERER_MODES.WEBGPU;
    return webgl2 ? GPU_WORLD_RENDERER_MODES.WEBGL : GPU_WORLD_RENDERER_MODES.CANVAS;
}

export function materialClassId(value) {
    if (Number.isFinite(Number(value))) {
        return Math.max(0, Math.min(255, Math.round(Number(value))));
    }
    return registryMaterialClassId(value);
}

// V9 — the GPU record contract (docs/material-channel-contract.md, "V9 GPU
// record layout"). Flag bits ride instance loc3.w. Bits 4 and 5 are reserved
// by name so 2.3's surface code and B.2's packed geometry cannot collide.
export const GPU_RECORD_FLAGS = Object.freeze({
    writesDepth: 1,
    reflect: 2,
    fatOptOut: 4,
    screenSpace: 8,
    surfaceCode: 16,
    packedGeometry: 32,
    // 3.8 — an upright prop that turns round a vertical axis (a Harbor hull:
    // frontCornerX is its pivot x, footY its waterline): the light loop gives
    // it the body's wrap response without any ownerSlot attention.
    receiverAxis: 64,
    // B.3 — a ground-cue dot run (GroundCueRecords): loc1 carries the run's
    // packed integer payload instead of UVs, and the vertex stage expands it
    // into one quad per dot on the cue atlas's swatch texel.
    cueRun: 128,
    // 2.9 — a building or tree ground cast (GpuSceneBuilder): over painted
    // water (3.6 coast flag `water`, not `covered`) the scene fragment holds
    // it to RakingLight.GROUND_CAST_WATER_SHARE and breaks it by the ripple rows.
    groundCast: 256,
    // Wave 10 S5 — a T1 attention-mark record's §7.1 role 2 (action-needed:
    // status cell, notch status rows, beacon, edge arrow). Mark records are
    // `screenSpace`; the rest of a mark (rim, text cell, leader) is role 0.
    actionMark: 512,
});

// V9 / 0.6 — painter's depth. A record's or particle's painter `sortY` is
// clamped to [GPU_DEPTH_SORT_Y_MIN, GPU_DEPTH_SORT_Y_MIN + 65535/8] world px
// and quantized to 1/8 px: exactly the 65,536 steps of the DEPTH_COMPONENT16
// attachment, so a particle and the record it shares a sortY with store the
// same depth and LEQUAL keeps the particle visible over its own owner. Key 0
// is the cleared far plane (terrain, haze, ground and cue records carry it
// and never write); a nearer sortY is a larger key. Shaders write
// `depth = 1 - key / 65535`. A raw `1 - sortY / 4096` would leave [0, 1] for
// split back halves at negative sortY (StaticPropDrawables.propBackSortY).
export const GPU_DEPTH_SORT_Y_MIN = -2048;
export const GPU_DEPTH_KEY_STEPS_PER_PX = 8;
export const GPU_DEPTH_KEY_MAX = 65535;

export function gpuDepthKey(sortY) {
    const value = sortY == null ? Number.NaN : Number(sortY);
    if (Number.isNaN(value)) return 0;
    const key = Math.round((value - GPU_DEPTH_SORT_Y_MIN) * GPU_DEPTH_KEY_STEPS_PER_PX);
    return key <= 0 ? 0 : key >= GPU_DEPTH_KEY_MAX ? GPU_DEPTH_KEY_MAX : key;
}

// 0.6 — one GPU particle instance (ParticleSystem.packGpuInstances writes it,
// GpuWorldRenderer draws it in one instanced call):
//   bytes  0-15  FLOAT  x4  left, top, width, height (whole world texels)
//   bytes 16-19  UBYTE  x4  straight RGBA, normalized
//   bytes 20-23  UBYTE  x4  shape, flags, motif index, 0 (integer)
//   bytes 24-25  USHORT     painter depth key (`gpuDepthKey` of its sortY)
//   bytes 26-27  USHORT     0
// `graded` particles are matter and take the C2 grade in the shader; `emits`
// particles are light and feed bloom. A particle with neither (a pre-graded
// night smoke tone, a fire-lit smoke underside) keeps its colour unlit.
export const GPU_PARTICLE_INSTANCE_BYTES = 28;
export const GPU_PARTICLE_SHAPES = Object.freeze({ rect: 0, blob: 1, wings: 2, motif: 3, smoke: 4 });
// 6.4 — a smoke puff's lit and shade rims, per channel, from its body tone:
// body #a9aeb8 → lit #d3d6dc, shade #787c86 (ParticleSystem `drawSmokePuff`
// derives the same tones for Canvas).
export const SMOKE_PUFF_LIT_GAIN = Object.freeze([211 / 169, 214 / 174, 220 / 184]);
export const SMOKE_PUFF_SHADE_GAIN = Object.freeze([120 / 169, 124 / 174, 134 / 184]);
export const GPU_PARTICLE_FLAGS = Object.freeze({ graded: 1, emits: 2 });
// Event-shape motifs are 8x8 masks stacked vertically in one R8 texture.
export const GPU_PARTICLE_MOTIF_SIZE = 8;

function uint16Field(value) {
    const number = Math.round(finite(value, 0));
    return number <= 0 ? 0 : number >= 65535 ? 65535 : number;
}

// Writes every V9 field onto `target` (a normalized record or a producer's
// own prenormalized record). `writesDepth` is the writer's per-kind opt-in
// (opaque sprite kinds); soft alpha and additive blending never write, so a
// departed body at 0.58 or an archive fade cannot hide particles behind it.
// Receiver geometry is integer world px: `footY` defaults to the painter sortY
// (the drawable's ground line), -1 = ground self; `frontCornerY` -1 = none.
export function assignGpuRecordV9Fields(target, record, alpha, blend) {
    const depthSortY = record.depthSortY == null ? Number.NaN : Number(record.depthSortY);
    const hasDepth = !Number.isNaN(depthSortY);
    const writesDepth = hasDepth && record.writesDepth === true && alpha >= 1 && blend === 'normal';
    target.depthSortY = hasDepth ? depthSortY : null;
    target.depthKey = hasDepth ? gpuDepthKey(depthSortY) : 0;
    target.writesDepth = writesDepth;
    target.flags = (writesDepth ? GPU_RECORD_FLAGS.writesDepth : 0)
        | (record.reflect === true ? GPU_RECORD_FLAGS.reflect : 0)
        | (record.fatOptOut === true ? GPU_RECORD_FLAGS.fatOptOut : 0)
        | (record.screenSpace === true ? GPU_RECORD_FLAGS.screenSpace : 0)
        | (record.surfaceCode === true ? GPU_RECORD_FLAGS.surfaceCode : 0)
        | (record.packedGeometry === true ? GPU_RECORD_FLAGS.packedGeometry : 0)
        | (record.receiverAxis === true ? GPU_RECORD_FLAGS.receiverAxis : 0)
        | (record.groundCast === true ? GPU_RECORD_FLAGS.groundCast : 0);
    target.footY = finite(record.footY, Number.isFinite(depthSortY) ? depthSortY : -1);
    target.frontCornerX = finite(record.frontCornerX, 0);
    target.frontCornerY = finite(record.frontCornerY, -1);
    target.ownerSlot = uint16Field(record.ownerSlot);
    target.landmarkId = uint16Field(record.landmarkId);
    target.paletteRamp = Boolean(record.paletteRamp);
    return target;
}

export function normalizeGpuRecord(record = {}, sequence = 0, target = null) {
    const source = record.source || record.image || null;
    const sourceWidth = Math.max(1, finite(record.sourceWidth, source?.width || 1));
    const sourceHeight = Math.max(1, finite(record.sourceHeight, source?.height || 1));
    const sx = finite(record.sx, 0);
    const sy = finite(record.sy, 0);
    const sw = Math.max(0, finite(record.sw, sourceWidth));
    const sh = Math.max(0, finite(record.sh, sourceHeight));
    const width = Math.max(0, finite(record.width ?? record.w, sw));
    const height = Math.max(0, finite(record.height ?? record.h, sh));
    const alpha = Math.max(0, Math.min(1, finite(record.alpha, 1)));
    const elevation = Math.max(0, Math.min(1, finite(record.elevation, 0)));
    const emissive = Math.max(0, Math.min(2, finite(record.emissive, 0)));
    const occluder = Math.max(0, Math.min(1, finite(record.occluder, 0)));
    const blend = record.blend === 'add' ? 'add' : 'normal';
    const textureKey = String(record.textureKey || record.stableKey || record.id || `texture:${sequence}`);
    const sidecarKey = String(record.sidecarKey || record.materialSidecarKey || '');
    const normalized = target || { ...record };
    if (target) Object.assign(normalized, record);
    normalized.source = source;
    normalized.materialSource = record.materialSource || record.sidecar || null;
    normalized.emissiveSource = record.emissiveSource || null;
    normalized.occluderSource = record.occluderSource || null;
    normalized.occluderTextureUpdates = record.occluderTextureUpdates || null;
    normalized.textureKey = textureKey;
    normalized.sidecarKey = sidecarKey;
    normalized.sourceWidth = sourceWidth;
    normalized.sourceHeight = sourceHeight;
    normalized.sx = sx;
    normalized.sy = sy;
    normalized.sw = sw;
    normalized.sh = sh;
    normalized.x = finite(record.x);
    normalized.y = finite(record.y);
    normalized.width = width;
    normalized.height = height;
    normalized.alpha = alpha;
    normalized.elevation = elevation;
    normalized.emissive = emissive;
    normalized.emissiveGate = Math.max(0, Math.min(1, finite(record.emissiveGate, 1)));
    normalized.occluder = occluder;
    normalized.material = materialClassId(record.material ?? record.materialId);
    normalized.blend = blend;
    normalized.sequence = finite(record.sequence, sequence);
    // B.1b — written every time: a reused scratch record must not keep a
    // previous occupant's opt-out.
    normalized.pageable = record.pageable !== false;
    normalized.textureRevision = record.textureRevision ?? null;
    normalized.sidecarRevision = record.sidecarRevision ?? null;
    normalized.textureUpdates = record.textureUpdates ?? null;
    normalized.materialTextureUpdates = record.materialTextureUpdates ?? null;
    normalized.emissiveTextureUpdates = record.emissiveTextureUpdates ?? null;
    return assignGpuRecordV9Fields(normalized, record, alpha, blend);
}

export function validGpuRecord(record) {
    return Boolean(
        record?.source
        && record.sw > 0
        && record.sh > 0
        && record.width > 0
        && record.height > 0
        && Number.isFinite(record.x)
        && Number.isFinite(record.y),
    );
}

// B.1b — a record may live on the albedo texture-array page when it has no
// sidecar (material, emissive, occluder), is not screen-space nor opted out
// (`pageable: false`: a screen-sized field such as the ground haze, fog or
// the semantic cue layer), and samples a whole-source rect of a source no
// larger than `limit` texels a side (a page layer less its gutter). The
// renderer's pager decides whether it fits.
export function gpuRecordPageable(record, limit) {
    if (record.materialSource || record.emissiveSource || record.occluderSource || record.sidecarKey
        || record.pageable === false || (record.flags & GPU_RECORD_FLAGS.screenSpace)) return false;
    const source = record.source;
    if (!source || source.gpuResident === true) return false;
    const width = record.sourceWidth;
    const height = record.sourceHeight;
    return width === source.width && height === source.height
        && width <= limit && height <= limit
        && record.sx >= 0 && record.sy >= 0
        && record.sx + record.sw <= width && record.sy + record.sh <= height;
}

// A producer that emits many small records per frame (0.2 ground cues) may
// hand them over already normalized: `prenormalized: true` promises every
// field normalizeGpuRecord would write — the V9 fields of
// `assignGpuRecordV9Fields` included — is present, finite and in range, and
// that the record is valid. Those records skip the per-record copy and are
// batched as-is. 0.6 — `writesDepth` joins the batch key: one batch is drawn
// under one `depthMask`. B.1b — `pager(record)` (optional) places a normalized
// record on the albedo page and returns the page, writing `pageLayer`,
// `pageX`, `pageY` onto it, or returns null; paged records batch by page (any
// texture on it), everything else by texture and sidecars as before.
// Prenormalized records are never paged.
export function buildStableGpuBatches(records = [], batches = [], normalizedRecords = [], pager = null) {
    let batchCount = 0;
    let current = null;
    for (let index = 0; index < records.length; index++) {
        const raw = records[index];
        let record;
        let page = null;
        if (raw?.prenormalized === true) {
            if (!raw.source) continue;
            record = raw;
        } else {
            const normalized = normalizedRecords[index] || (normalizedRecords[index] = {});
            record = normalizeGpuRecord(raw, index, normalized);
            if (!validGpuRecord(record)) continue;
            record.pageLayer = -1;
            if (pager) page = pager(record);
        }
        if (!current || current.page !== page
            || (!page && (current.textureKey !== record.textureKey || current.source !== record.source))
            || current.sidecarKey !== record.sidecarKey
            || current.blend !== record.blend
            || current.writesDepth !== record.writesDepth
            || current.materialSource !== record.materialSource
            || current.emissiveSource !== record.emissiveSource
            || current.occluderSource !== record.occluderSource) {
            current = batches[batchCount];
            if (!current) {
                current = { records: [] };
                batches[batchCount] = current;
            }
            const textureKey = page ? page.key : record.textureKey;
            if (current.textureKey !== textureKey
                || current.sidecarKey !== record.sidecarKey
                || current.blend !== record.blend
                || current.writesDepth !== record.writesDepth) {
                current.key = `${textureKey}|${record.sidecarKey}|${record.blend}|${record.writesDepth ? 'depth' : 'flat'}`;
            }
            current.page = page;
            current.writesDepth = record.writesDepth;
            current.source = page ? null : record.source;
            current.materialSource = record.materialSource;
            current.emissiveSource = record.emissiveSource;
            current.occluderSource = record.occluderSource;
            current.textureKey = textureKey;
            current.sidecarKey = record.sidecarKey;
            current.blend = record.blend;
            current.records.length = 0;
            current.first = 0;
            current.count = 0;
            current.occluderMax = 0;
            batchCount++;
        }
        current.records.push(record);
    }
    batches.length = batchCount;
    normalizedRecords.length = records.length;
    return batches;
}

// 3.1 — action-needed overlays are outside the exposure budget: the renderer
// asks this before applying the envelope's spill share to a light.
export function isAttentionLight(light) {
    return Boolean(light?.attention) || String(light?.id || '').startsWith('attention:')
        || light?.role === LIGHT_ROLE_CODES.attention;
}

// V5 / 2.1 — the role codes the resident loop reads (light record row 1 w),
// set on each feed slot by PostFxFeed.
export const LIGHT_ROLE_CODES = Object.freeze({ point: 0, aperture: 1, fixture: 2, attention: 3 });
// 2.4 — admission order by role: attention > aperture > fixture > point.
const LIGHT_ROLE_RANK = Object.freeze([3, 1, 2, 0]);

function lightRoleRank(light) {
    if (isAttentionLight(light)) return 0;
    const code = Math.round(finite(light?.role, LIGHT_ROLE_CODES.point));
    return LIGHT_ROLE_RANK[code] ?? 3;
}

export function clampGpuLights(lights = [], limit = 16, hardLimit = limit, cache = null) {
    const cap = Math.max(0, Math.floor(finite(limit, 16)));
    const hardCap = Math.max(cap, Math.floor(finite(hardLimit, cap)));
    const source = lights || [];
    const ranked = cache?.ranked || [];
    let unchanged = Boolean(cache && cache.source === source && cache.sourceLength === source.length);
    if (unchanged) {
        for (let index = 0; index < source.length; index++) {
            const light = source[index];
            const snapshot = cache.snapshots[index];
            if (!snapshot || snapshot.light !== light
                || snapshot.x !== light?.x || snapshot.y !== light?.y
                || snapshot.priority !== light?.priority || snapshot.intensity !== light?.intensity
                || snapshot.id !== light?.id || snapshot.attention !== light?.attention
                || snapshot.role !== light?.role) {
                unchanged = false;
                break;
            }
        }
    }
    if (!unchanged) {
        ranked.length = 0;
        if (cache) cache.snapshots.length = source.length;
        for (let index = 0; index < source.length; index++) {
            const light = source[index];
            if (Number.isFinite(Number(light?.x)) && Number.isFinite(Number(light?.y))) ranked.push(light);
            if (cache) {
                const snapshot = cache.snapshots[index] || (cache.snapshots[index] = {});
                snapshot.light = light;
                snapshot.x = light?.x;
                snapshot.y = light?.y;
                snapshot.priority = light?.priority;
                snapshot.intensity = light?.intensity;
                snapshot.id = light?.id;
                snapshot.attention = light?.attention;
                snapshot.role = light?.role;
            }
        }
        ranked.sort((a, b) => (
            lightRoleRank(a) - lightRoleRank(b)
            || finite(b.priority, 0) - finite(a.priority, 0)
            || finite(b.intensity, 1) - finite(a.intensity, 1)
            || String(a.id || '').localeCompare(String(b.id || ''))
        ));
        if (cache) {
            cache.source = source;
            cache.sourceLength = source.length;
        }
    }
    let protectedCount = 0;
    while (protectedCount < ranked.length && isAttentionLight(ranked[protectedCount])) protectedCount++;
    const admittedCount = Math.min(ranked.length, hardCap, Math.max(cap, protectedCount));
    if (!cache) return ranked.slice(0, admittedCount);
    const admitted = cache.admitted;
    admitted.length = admittedCount;
    for (let index = 0; index < admittedCount; index++) admitted[index] = ranked[index];
    return admitted;
}

// 2.4 — the resident light list: up to MAX_LIGHT_RECORDS admitted lights in
// an RGBA32F texture (unit 9) of LIGHT_RECORD_ROWS rows x 256 texels; light i
// is column i: row 0 (foot x, foot y, ground radius, intensity), row 1
// (emitter height, face normal nx, ng, role code), row 2 (shader rgb,
// envelope share), row 3 (owner slot, landmark id, LIGHT_RECORD_FLAGS,
// column reach). The R16UI tile index (unit 10) holds, per 64x64 backing-px
// tile (tx, ty), texel (tx * LIGHT_TILE_STRIDE, ty) = count and the next
// `count` texels the admitted light indices in admission order.
export const MAX_LIGHT_RECORDS = 256;
export const LIGHT_RECORD_ROWS = 4;
export const LIGHT_TILE_PX = 64;
export const LIGHT_TILE_SLOTS = 16;
export const LIGHT_TILE_STRIDE = LIGHT_TILE_SLOTS + 1;
export const LIGHT_RECORD_FLAGS = Object.freeze({
    // 3.2 — lays its hue on wet ground (the first `wetReflectionCount`
    // admitted non-attention lights).
    wetReflection: 1,
    // 2.9 — lays a broken column on the water in front of its foot
    // (apertures and fixtures; never attention or omni effect lights).
    waterColumn: 2,
    // 2.9 — lights nothing but its column (the Lighthouse lamp).
    waterOnly: 4,
});
// 2.9 — a column runs this many ground radii toward the camera from the foot.
export const WATER_COLUMN_REACH = 1.8;
// The tallest body (hat included) above its foot, in world px.
const LIGHT_BODY_REACH_UP = 96;
// A body takes one falloff from its foot, so its art below that foot (the
// feet and hem under the placement point) lights with it: the rect's ground
// reach below the foot carries this much more for them, in world px. Every
// other upright record's art below its foot is its own ground there.
const LIGHT_BODY_REACH_DOWN = 8;

/** 2.9 — does this admitted light lay a water column? */
export function lightLaysColumn(light) {
    if (isAttentionLight(light)) return false;
    const role = Math.round(finite(light?.role, LIGHT_ROLE_CODES.point));
    return role === LIGHT_ROLE_CODES.aperture || role === LIGHT_ROLE_CODES.fixture;
}

/**
 * The world rect `{ x0, y0, x1, y1 }` holding every art pixel SCENE_FRAGMENT
 * can light from `light` (a feed slot: footX/footY, radiusWorld, height,
 * waterOnly, columnReach). A conservative superset of the loop's tests, so
 * binning by it never changes a lit pixel: the reach in iso ground space
 * (`sqrt(r^2 + max(0, h - 24)^2)`, 1.25x for a body's axis, plus its 10 px
 * half-width), a receiver's ground point up to half a reach behind the foot
 * and its pixel up to `h + 24 + reach` above that point (a wall), or a body's
 * height; below the foot, half a reach on the ground, 1.3 radii of wet
 * reflection (`wet`) and the water column (WATER_COLUMN_REACH x radius x
 * columnReach; a water-only lamp's column starts at its mirror point, its
 * height below the foot; dashes at most 2 + floor(r/32) texels either side
 * plus a hashed end, the row wobble and a flight frame's covered cell).
 */
export function lightReachRect(light, { wet = false } = {}, out = {}) {
    const x = finite(light?.footX);
    const y = finite(light?.footY);
    const radius = Math.max(1, finite(light?.radiusWorld, 64));
    const height = Math.max(0, finite(light?.height, 0));
    const column = lightLaysColumn(light) || light?.waterOnly === true;
    const columnDown = column ? WATER_COLUMN_REACH * radius * Math.max(1, finite(light?.columnReach, 1)) : 0;
    if (light?.waterOnly === true) {
        const columnHalf = 7 + Math.floor(radius / 32);
        out.x0 = x - columnHalf;
        out.x1 = x + columnHalf;
        out.y0 = y + height - 2;
        out.y1 = y + height + columnDown + 2;
        return out;
    }
    const reach = Math.hypot(radius, Math.max(0, height - 24));
    const body = reach * 1.25;
    out.x0 = x - body - 12;
    out.x1 = x + body + 12;
    out.y0 = y - body * 0.5 - Math.max(height + 24 + reach, LIGHT_BODY_REACH_UP);
    out.y1 = y + Math.max(body * 0.5 + LIGHT_BODY_REACH_DOWN, wet && !isAttentionLight(light) ? radius * 1.3 : 0, columnDown) + 1;
    return out;
}

export function createLightBinScratch() {
    return {
        admitted: [],
        counts: new Uint8Array(0),
        index: new Uint16Array(0),
        tilesX: 0,
        tilesY: 0,
        rect: {},
        visible: 0,
        culled: 0,
        tileFull: 0,
        overCap: 0,
        maxPerTile: 0,
    };
}

/**
 * 2.4 — admission by binning. Walks `ranked` (clampGpuLights order) and
 * admits a light while the count allows (`cap`; attention lights always) and
 * every LIGHT_TILE_PX tile its reach rect covers on the `width x height`
 * backing store has a free slot (LIGHT_TILE_SLOTS). A light whose rect misses
 * the backing store is culled (it lights no visible pixel). The camera is the
 * scene pass's `u_camera` triple: backing px = (world + camera) x scale.
 * Fills `scratch` (createLightBinScratch): `admitted`, the tile `index`
 * (Uint16Array, tilesX * LIGHT_TILE_STRIDE x tilesY) and the counters
 * `visible` (offered and on screen), `culled`, `tileFull`, `overCap`,
 * `maxPerTile`. The clustered and the flat walk both read this one list, so
 * the admitted set never depends on the walk.
 */
export function binGpuLights(ranked = [], {
    cap = 0, cameraX = 0, cameraY = 0, scale = 1, width = 0, height = 0, wet = false,
} = {}, scratch = createLightBinScratch()) {
    const tilesX = Math.max(1, Math.ceil(Math.max(1, finite(width)) / LIGHT_TILE_PX));
    const tilesY = Math.max(1, Math.ceil(Math.max(1, finite(height)) / LIGHT_TILE_PX));
    const tiles = tilesX * tilesY;
    if (scratch.counts.length !== tiles) {
        scratch.counts = new Uint8Array(tiles);
        scratch.index = new Uint16Array(tiles * LIGHT_TILE_STRIDE);
    } else {
        scratch.counts.fill(0);
    }
    scratch.tilesX = tilesX;
    scratch.tilesY = tilesY;
    const counts = scratch.counts;
    const index = scratch.index;
    const admitted = scratch.admitted;
    admitted.length = 0;
    scratch.visible = 0;
    scratch.culled = 0;
    scratch.tileFull = 0;
    scratch.overCap = 0;
    scratch.maxPerTile = 0;
    const limit = Math.max(0, Math.floor(finite(cap)));
    const s = Math.max(1e-6, finite(scale, 1));
    const w = finite(width);
    const h = finite(height);
    const rect = scratch.rect;
    for (let n = 0; n < ranked.length; n++) {
        const light = ranked[n];
        const attention = isAttentionLight(light);
        if (!Number.isFinite(light?.footX) || !Number.isFinite(light?.footY)) {
            scratch.culled++;
            continue;
        }
        lightReachRect(light, { wet }, rect);
        // One world px (an art cell's centre) plus two backing px of margin.
        const sx0 = (rect.x0 - 1 + cameraX) * s - 2;
        const sx1 = (rect.x1 + 1 + cameraX) * s + 2;
        const sy0 = (rect.y0 - 1 + cameraY) * s - 2;
        const sy1 = (rect.y1 + 1 + cameraY) * s + 2;
        if (sx1 < 0 || sy1 < 0 || sx0 >= w || sy0 >= h) {
            scratch.culled++;
            continue;
        }
        scratch.visible++;
        if (admitted.length >= MAX_LIGHT_RECORDS || (!attention && admitted.length >= limit)) {
            scratch.overCap++;
            continue;
        }
        const tx0 = Math.max(0, Math.floor(sx0 / LIGHT_TILE_PX));
        const tx1 = Math.min(tilesX - 1, Math.floor(sx1 / LIGHT_TILE_PX));
        const ty0 = Math.max(0, Math.floor(sy0 / LIGHT_TILE_PX));
        const ty1 = Math.min(tilesY - 1, Math.floor(sy1 / LIGHT_TILE_PX));
        let fits = true;
        for (let ty = ty0; ty <= ty1 && fits; ty++) {
            for (let tx = tx0; tx <= tx1; tx++) {
                if (counts[ty * tilesX + tx] >= LIGHT_TILE_SLOTS) {
                    fits = false;
                    break;
                }
            }
        }
        if (!fits) {
            scratch.tileFull++;
            continue;
        }
        const slot = admitted.length;
        for (let ty = ty0; ty <= ty1; ty++) {
            for (let tx = tx0; tx <= tx1; tx++) {
                const tile = ty * tilesX + tx;
                const count = counts[tile];
                index[(ty * tilesX + tx) * LIGHT_TILE_STRIDE + 1 + count] = slot;
                counts[tile] = count + 1;
                if (count + 1 > scratch.maxPerTile) scratch.maxPerTile = count + 1;
            }
        }
        admitted.push(light);
    }
    for (let tile = 0; tile < tiles; tile++) index[tile * LIGHT_TILE_STRIDE] = counts[tile];
    return scratch;
}

/**
 * Local point lights are a darkness response, not a second daytime sun. This
 * stays the *admission gate* only: 3.1's source-energy envelope owns how much
 * energy an admitted light, its core, and its bloom may spend, so nothing
 * multiplies this scalar into brightness any more.
 */
export function localLightPhaseForLighting(lighting = {}) {
    const ambient = Math.max(0, Math.min(1, finite(lighting?.ambientLight, 1)));
    const beacon = Math.max(0, Math.min(1, finite(lighting?.beaconIntensity, 0)));
    return Math.max(1 - ambient, beacon);
}
