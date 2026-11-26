import {
    MATERIAL_CLASS_IDS,
    materialClassId as registryMaterialClassId,
} from '../MaterialRegistry.js';
import { RECEIVER_LUMA_CEILING } from '../../../config/artPalette.js';
import { WATER_DAY_MAX_SATURATION, WATER_MAX_SATURATION, WATER_NIGHT_MAX_SATURATION } from '../GradeEvaluator.js';
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
    // limit of the rig that priced `cloud-courses`. SEA-1 (look `sea1`) lives
    // here too and is ALU only: the plane field is a multiply-add before the
    // same two fetches, and the sunlit lift reuses the open sea's field (one
    // extra field read on in-map open water). MINIMAL keeps today's look.
    // SEA-2 / SEA-3 (looks `sea2`, `sea3`) live here as well: ALU and two
    // integer hashes per open-water texel (the streak rows), one cloud-tile
    // fetch per texel only on a calm sea (its lanes); no new texture, no new
    // pass. FULL and REDUCED; MINIMAL keeps today's static sea; Canvas keeps
    // today's sea (declared lower tier).
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
    // BI-1 — still water answers the wind: on lagoon water where the
    // `sea-weather` gust field (no second texture) passes the C-W3 paw rule,
    // a static order steps one stop deeper and a baked mirror gives a
    // gust-scaled Bayer share of its texels back to its stop, for that 125 ms
    // gust step. On water fragments one coast-field fetch at the dash origin;
    // inside a lagoon paw one bilinear gust fetch and two cloud-tile fetches;
    // the mirror test reads the coast field (already fetched by the 3.7
    // ripple) before any gust fetch. No receipt yet (V2 quiet host pending):
    // the band is [INFERENCE] the grass gust course's. The static frame is
    // the glassy baked lake (also under reduced motion).
    stillPaws: Object.freeze({
        id: 'stillPaws',
        levels: Object.freeze({ FULL: 'on', REDUCED: 'on', MINIMAL: 'off' }),
        cost: Object.freeze({ gpuMsBand: [0, 0.24], cpuMsBand: [0, 0.3], bytes: 0, scope: 'shared-scene-envelope' }),
        staticFallback: 'baked-mirror',
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
    // MS-1 (look `ms1`) — low mist with a top: in the scene fragment, only
    // while the mist has density, one coast-field fetch and two cloud-tile
    // fetches per fragment (two more mist-top reads, four fetches, on a
    // course seam only) and ~30 ALU; the open sea in the composite the same
    // minus the coast field. It retires the fog-bank `ground:fog` records
    // (up to ~6 full-viewport layers of the scene shader) and the
    // `ground:haze` record on the GPU paths. No receipt yet (quiet host
    // pending; the spike's loaded-host GPU timer read 4.3-6.4 ms against
    // today's fog 3.3-7.1 ms, not a receipt): the band is [INFERENCE] the
    // grass gust course's. MINIMAL keeps today's flat veil and banks; the
    // static frame holds the drift; Canvas keeps today's banks (lower tier).
    // MS-2 (look `ms2`) extends this row: the burn-off is one more uniform
    // (u_mistBurn) and one multiply-add in the same top; the lamp halos are
    // at most 64 small scene records a frame (MistHalos: cached 21-37 px
    // stamps, one texture per radius and colour, placed in painter order),
    // only while the mist runs at night. Loaded-host figures (r2 review,
    // awaiting a quiet-host receipt): at dense-100 in fog, 56 halos add 64
    // draw batches (210 -> 274) and 0.05 ms renderer CPU; on a foggy night
    // about +55 records and +70 batches, main thread 3.6 -> 3.9 ms at
    // 1920x1200 zoom 2 and 5.1 -> 5.4 ms at 5120x1440. MINIMAL: the mist
    // is off, so neither runs; Canvas: neither (declared lower tier).
    'low-mist': Object.freeze({
        id: 'low-mist',
        levels: Object.freeze({ FULL: 'on', REDUCED: 'on', MINIMAL: 'off' }),
        cost: Object.freeze({ gpuMsBand: [0, 0.24], cpuMsBand: [0, 0.3], bytes: 0, scope: 'shared-scene-envelope' }),
        staticFallback: 'frozen-offset',
        canvas: 'fog-banks',
    }),
    // GW-1 / GW-2 (looks `gw1`, `gw2`) — wet ground read from the ground
    // weather field (GroundWetShader.js). While either look is on and the
    // ground is wet or puddled, the RGBA8 field (1280 x 1280, 6,553,600
    // bytes, uploaded once per ground bake) takes the puddle unit in place of
    // the R8 mask (1,638,400 bytes): +4.9 MB resident. Per terrain fragment
    // one texelFetch for the wet step and one for the sheen, a puddle texel
    // as before; per flat-ground fragment a lazy fetch and one column test
    // per wet-reflection light for the lamp mirrors. No receipt yet (quiet
    // host pending): the band is [INFERENCE] the puddle courses' order of
    // cost. FULL mirrors every admitted fixed light (no attention light, no
    // carried lantern), REDUCED 8; the field is built only while a GW look
    // reads it (nothing at looks 0);
    // MINIMAL sheds the field (today's uniform darkening and R8 puddles).
    // Static: no motion. Canvas keeps today's uniform wet darkening and
    // puddle courses (declared lower tier).
    'wet-ground': Object.freeze({
        id: 'wet-ground',
        levels: Object.freeze({ FULL: 'on', REDUCED: 'on', MINIMAL: 'off' }),
        cost: Object.freeze({ gpuMsBand: [0, 0.3], cpuMsBand: [0, 0.01], bytes: 4915200, scope: 'shared-scene-envelope' }),
        staticFallback: 'static',
        canvas: 'uniform-wet',
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
    // while every 64x64 backing-px tile the light reaches has one of its 24
    // slots free; attention lights are admitted past the count). The night's
    // pools ship at every level (V2 tier contract: never below 12 at
    // MINIMAL). 2.4 moved the records into the RGBA32F light texture (unit
    // 9, MAX_LIGHT_RECORDS 256, 16 KiB baseline, like the uniform arrays it
    // replaced), so the count now covers every visible window, lamp and
    // opening at 5120x1440. NE P2.6 — LIGHT_TILE_SLOTS 16 -> 24 and
    // FIXTURE_LIGHT_RESERVE 12 -> 24 to hold the wider night pools; a fresh
    // K8 receipt at 1920x1080 and 5120x1440 is pending (`gpu-burst.mjs`).
    // Band: the ceiling is the whole FULL - MINIMAL real-frame delta
    // (WebPlatformGPU appburst, dense-24 22:00 z2 4880x1392, 4.02 - 1.55 ms,
    // which also sheds bloom and occlusion) until the re-receipt lands;
    // 60 Hz assumed.
    'light-admission': Object.freeze({
        id: 'light-admission',
        levels: Object.freeze({ FULL: 128, REDUCED: 64, MINIMAL: 24 }),
        cost: Object.freeze({ gpuMsBand: [0, 2.47], cpuMsBand: [0, 0.01], bytes: 0, scope: 'shared-scene-envelope' }),
        staticFallback: 'ranked-admission',
        canvas: 'feed-ranked-48',
    }),
    // 2.4 (M6: clustering only if its receipt pays) — the switch between the
    // two walks of the SAME admitted list: `on`, each fragment walks only
    // its 64x64 tile's <= 24 lights from the R16UI tile index (unit 10,
    // tilesX*25 x tilesY: count, then light indices; NE P2.6 raised slots
    // 16 -> 24); `off`, every fragment walks every admitted light (the flat
    // path). Admission is binned in both, so the admitted set and every lit
    // pixel are identical: `gpuWorld.setLightClusterOverride(true | false | null)`
    // forces a walk (null = this row). M6 receipt (Phase 5 quiet host,
    // 2026-09-29): the gpu-burst method with on / off / on-again arms
    // interleaved (3 fresh contexts x 8 reps x 60 frames), 22:00 clear,
    // dense-24 and dense-100, 1680x1032 and 4880x1392, z1 and z2, WebGPU
    // and WebGL2: the flat walk costs 1.42-16.96 ms more at FULL (A/A <=
    // 0.32) and 1.28-11.46 ms more with MINIMAL's 24 lights (A/A <= 1.45),
    // all 32 cases resolved. So the clustered walk ships at every level
    // (MINIMAL included) and the row is a substitution that prices the time
    // it removes; the flat walk is only the override's A/B arm. Bytes: the
    // index at 4880x1392 (77 x 22 tiles x 25 x 2 B), resident at every
    // level. 60 Hz assumed.
    'light-clusters': Object.freeze({
        id: 'light-clusters',
        levels: Object.freeze({ FULL: 'on', REDUCED: 'on', MINIMAL: 'on' }),
        cost: Object.freeze({ gpuMsSavedBand: [1.28, 16.96], cpuMsBand: [0, 0.1], bytes: 84700, scope: 'shared-scene-envelope' }),
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
    // RN-1 (look `rn1`, WeatherRenderer `gpuRainField`) — rain in the world:
    // one instanced draw after the particles on the same painter depth, two
    // quads per 32-px ground cell of the view plus the fall height below it
    // (about 5,000-25,000 instances, most of them degenerate, a few hundred to ~2,000 of them drawn,
    // each a streak of <= 11 texels or a 7x4 splash), no attributes, no
    // per-frame packing. It replaces the overlay's 100-1,600 rect fills a
    // frame (CPU, not priced here). `bytes`: the 64-B uniform block and the
    // 40x40 R8 splash mask. MINIMAL hands the whole field back to the overlay
    // (`canvas-weather`), as Canvas keeps it. No receipt yet (quiet host
    // pending): the band is [INFERENCE] the particle-depth prototype's (a
    // depth-tested instanced draw of small quads, <= 0.15 ms at 4880x1392).
    'world-rain': Object.freeze({
        id: 'world-rain',
        levels: Object.freeze({ FULL: 'on', REDUCED: 'on', MINIMAL: 'off' }),
        cost: Object.freeze({ gpuMsBand: [0, 0.15], cpuMsBand: [0, 0.03], bytes: 1664, scope: 'shared-scene-envelope' }),
        staticFallback: 'canvas-weather',
        canvas: 'canvas-weather',
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
    // NL-4 (look `nl4`, CarriedLantern.js) — every eligible carrier keeps its
    // stamp; this caps how many of them, nearest the view centre, lay a
    // pool: one small fixture light each, admitted after every other light
    // (`binGpuLights`), so it only ever spends a leftover slot of
    // `light-admission`. MINIMAL keeps the lit 6x7 stamps (one tiny record
    // per carrier) with no pool. No receipt yet (quiet host pending): the
    // band is [INFERENCE] a dozen more lights in an already-admitted list of
    // up to 128. Canvas lands the pool as it lands every fixture pool
    // (`_drawLightGlowStamps`): the stepped dodge courses over the finished
    // frame, so they also wash the carrier's own lower robe.
    'carried-lanterns': Object.freeze({
        id: 'carried-lanterns',
        // NE v0.67.1 L: lifted from 12/6/0 so moving/scattered carriers keep pools at z1.
        levels: Object.freeze({ FULL: 24, REDUCED: 12, MINIMAL: 0 }),
        cost: Object.freeze({ gpuMsBand: [0, 0.05], cpuMsBand: [0, 0.02], bytes: 0, scope: 'shared-scene-envelope' }),
        staticFallback: 'static-stamp',
        canvas: 'frame-pool-courses',
    }),
    // NL-3 (look `nl3`, LampSilhouette.js) — the 2.8 lamp casts as the
    // body's own silhouette (the stepped trails had no row: they ride the
    // contact-shadow stamps). CPU: one inverse-mapped mask per cluster of
    // overlapping shadows (<= 24 bodies, cached by frame cell, foot and
    // lamp), one small ground record each; GPU: those few records. MINIMAL
    // falls back to the stepped trails. No receipt yet (quiet host pending):
    // the bands are [INFERENCE] a handful of ground records.
    'lamp-silhouettes': Object.freeze({
        id: 'lamp-silhouettes',
        levels: Object.freeze({ FULL: 'on', REDUCED: 'on', MINIMAL: 'off' }),
        cost: Object.freeze({ gpuMsBand: [0, 0.05], cpuMsBand: [0, 0.5], bytes: 0, scope: 'shared-scene-envelope' }),
        staticFallback: 'stepped-trails',
        canvas: 'stepped-trails',
    }),
    // SD-1 (look `sd1`, ShadeField.js) — the sun's shade as one `ground:shade`
    // record: the shade field's canvas (1408x1536 RGBA) over its world rect
    // through the scene fragment, in place of the sun trails of the
    // per-building and per-tree stamps. No shader work of its own: an albedo
    // fetch and discard across its rect, the scene shader on the texels it
    // shades. The field is rebuilt each time the sun's sweep leaves its
    // bucket: measured 104 times on 13 November and 187 on 15 July, about
    // once per 5 minutes of daylight (and repainted when the cast colour
    // steps, 9 colours a day). A rebuild runs in idle slices (measured in
    // review with receivers on: 66 slices, 69 ms in all, none over 4 ms,
    // landing 3.5 s or more after the bucket) and ends in one 8.25 MiB
    // canvas upload, which lands in a 25 ms frame against a 16 ms median.
    // Memory, measured on WebGL2: 12.4 MiB at rest (the 4.1 MiB field
    // buffer and the 8.25 MiB canvas; 4.8 MiB more while a rebuild runs)
    // plus the 8.25 MiB texture (`bytes`). Canvas holds the same 12.4 MiB
    // and, while it repaints, 8.25 MiB more of ImageData. MINIMAL sheds the
    // record and its texture and keeps today's sun stamps
    // (`RakingLight.castLightingFor` reads this row). No frame-time receipt
    // yet (quiet host pending): the band is [INFERENCE] the grass gust
    // course's. Canvas draws the same field canvas.
    'sundial-shade': Object.freeze({
        id: 'sundial-shade',
        levels: Object.freeze({ FULL: 'on', REDUCED: 'on', MINIMAL: 'off' }),
        cost: Object.freeze({ gpuMsBand: [0, 0.24], cpuMsBand: [0, 0.01], bytes: 8650752, scope: 'shared-scene-envelope' }),
        staticFallback: 'none',
        canvas: 'shade-field',
    }),
    // SD-2 (look `sd2`, gpu/SunShade.js) — receivers take the sun's shade:
    // per sprite fragment (never terrain; a ground record only if it is a
    // sun trail) texel fetches of the shade field's RGBA8 texels on unit 2,
    // before the grade: none for a right wall or an attention record
    // (`shadeExempt`), one for any other landmark texel (the massing's
    // verdict; a second only where the massing draws nothing there), two or
    // three for a body or prop (what it stands on, the ceiling at its foot,
    // a body's canopy), one for a trail; about 30 ALU. By day it also keeps
    // the occluder companions bound (one more sample a sprite fragment,
    // `resolveOccluderChannel`), which a clear day otherwise skips. Its
    // texture is the field's second upload per rebuild (1408x1536 RGBA8,
    // 8.25 MiB, the frame after the layer's; about once per 5 minutes of
    // daylight, see `sundial-shade`); the build's texel pass and the view
    // plane (once per scenery) stay in the field's idle slices. Memory,
    // measured on WebGL2, over `sundial-shade`: 12.4 MiB of buffers (the
    // 8.25 MiB texels and the 4.1 MiB view plane; 2.1 MiB more while the
    // view plane is built) plus the 8.25 MiB texture (`bytes`), so the two
    // rows together hold 24.8 MiB and two 8.25 MiB textures. MINIMAL sheds
    // the fetches, the texture and the occluder samples
    // (`RakingLight.setFrameCastLighting` reads this row; `sundial-shade`
    // sheds the ground layer at the same level); Canvas keeps the ground
    // layer only. No frame-time receipt yet (quiet host pending): the band
    // is [INFERENCE] the footprint march's, which reads a like field per
    // light per fragment.
    'sundial-receivers': Object.freeze({
        id: 'sundial-receivers',
        levels: Object.freeze({ FULL: 'on', REDUCED: 'on', MINIMAL: 'off' }),
        cost: Object.freeze({ gpuMsBand: [0, 0.17], cpuMsBand: [0, 0.01], bytes: 8650752, scope: 'shared-scene-envelope' }),
        staticFallback: 'none',
        canvas: 'ground-layer-only',
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
    WATER_DAY_MAX_SATURATION: Object.freeze({ value: WATER_DAY_MAX_SATURATION, digits: 3 }),
    // NE v0.67.1 S
    WATER_NIGHT_MAX_SATURATION: Object.freeze({ value: WATER_NIGHT_MAX_SATURATION, digits: 3 }),
    POOL_RIM: Object.freeze({ value: Object.freeze([1.484, 0.914, 0.430]), digits: 3 }),
    POOL_MID: Object.freeze({ value: Object.freeze([1.208, 0.981, 0.577]), digits: 3 }),
    POOL_CORE: Object.freeze({ value: Object.freeze([1.089, 0.995, 0.786]), digits: 3 }),
    LAND_MID: Object.freeze({ value: Object.freeze([1.346, 0.948, 0.504]), digits: 3 }),
    LAND_SHARE: Object.freeze({ value: Object.freeze([0.84, 0.88, 0.90]), digits: 2 }),
    // Ambient-only falloff: six held courses, lower energy than the old
    // three-course discs; attention and authored ramp receivers stay unchanged.
    // NE v0.67.1 A: warm outer rings without lifting pool weights.
    AMBIENT_POOL_STOPS: Object.freeze({ value: Object.freeze([0.04, 0.12, 0.25, 0.40, 0.58, 0.75]), digits: 2 }),
    AMBIENT_POOL_WEIGHTS: Object.freeze({ value: Object.freeze([0.035, 0.10, 0.20, 0.32, 0.50, 0.76]), digits: 3 }),
    AMBIENT_POOL_CHROMA: Object.freeze({ value: Object.freeze([0.40, 0.55, 0.68, 0.80, 0.90, 1.00]), digits: 2 }),
    AMBIENT_POOL_SHARE: Object.freeze({ value: Object.freeze([0.30, 0.45, 0.58, 0.72, 0.84, 0.92]), digits: 2 }),
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

// V6 / NE v0.67.1 S — graded water held at WATER_DAY_MAX_SATURATION (0.44) by
// day, WATER_NIGHT_MAX_SATURATION (0.52) on clear nights, and blends back to
// WATER_MAX_SATURATION (0.37) in storm (HSV), pulled toward its own luma
// so hue, luma and the cool R−B sign are kept. CPU twin: GradeEvaluator.
const float WATER_MAX_SATURATION = ${k('WATER_MAX_SATURATION')};
const float WATER_DAY_MAX_SATURATION = ${k('WATER_DAY_MAX_SATURATION')};
const float WATER_NIGHT_MAX_SATURATION = ${k('WATER_NIGHT_MAX_SATURATION')};
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

// Six ambient courses on the same world-texel Bayer seams. The outer veil
// is near-neutral and very faint, not another saturated orange ring.
const float AMBIENT_POOL_STOPS[6] = float[6](${k('AMBIENT_POOL_STOPS')});
const float AMBIENT_POOL_WEIGHTS[6] = float[6](${k('AMBIENT_POOL_WEIGHTS')});
const float AMBIENT_POOL_CHROMA[6] = float[6](${k('AMBIENT_POOL_CHROMA')});
const float AMBIENT_POOL_SHARE[6] = float[6](${k('AMBIENT_POOL_SHARE')});
int ambientPoolIndex(float steps) { return clamp(int(steps) - 1, 0, 5); }
float ambientPoolSteps(float shape, float order) {
    float q = shape + (order - 0.5) * 0.08;
    float steps = 0.0;
    for (int i = 0; i < 6; i++) steps += step(AMBIENT_POOL_STOPS[i], q);
    return steps;
}
float ambientPoolWeight(float steps) {
    return steps < 0.5 ? 0.0 : AMBIENT_POOL_WEIGHTS[ambientPoolIndex(steps)];
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

vec3 ambientPoolTint(vec3 light, float steps, out float strength, out float warm) {
    float l = dot(light, GRADE_LUMA);
    vec3 hue = light / l;
    warm = clamp((hue.r - hue.b) * 1.25, 0.0, 1.0);
    strength = min(l, 1.0);
    int course = ambientPoolIndex(steps);
    vec3 ramp = mix(POOL_RIM, POOL_CORE, float(course) / 5.0);
    vec3 tint = mix(mix(vec3(1.0), hue, 0.7), ramp, warm);
    return mix(vec3(1.0), tint, AMBIENT_POOL_CHROMA[course]);
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
// an amber silhouette). \`inkGuard\` (1 on villager bodies, 0 on ground/walls)
// suppresses the 0.035 albedo-free ambient pool lift on dark sprite ink so
// visors, eyes and outlines keep contrast without dimming ground/wall pools.
// Returns the lit colour.
vec3 stepPool(vec3 graded, vec3 ambient, float ambientSteps, vec3 attention, float attentionSteps, vec3 albedo, vec3 reflection, float land, float inkGuard) {
    bool lit = ambientSteps > 0.5 && dot(ambient, GRADE_LUMA) > 0.01;
    bool marked = attentionSteps > 0.5 && dot(attention, GRADE_LUMA) > 0.01;
    if (!lit && !marked && reflection == vec3(0.0)) return graded;
    float gradedLuma = dot(graded, GRADE_LUMA);
    float albedoLuma = dot(albedo, GRADE_LUMA);
    vec3 base = mix(vec3(albedoLuma), albedo, 0.55);
    float inkKeep = mix(1.0, smoothstep(0.05, 0.14, albedoLuma), inkGuard);
    float carry = clamp((u_poolGain - 0.15) / 1.05, 0.0, 1.0);
    float strength;
    float warm;
    float landWarm = 0.0;
    vec3 result = graded;
    vec3 add = reflection;
    if (lit) {
        vec3 tint = ambientPoolTint(ambient, ambientSteps, strength, warm);
        vec3 pool = tint * strength;
        float adapt = min(1.0, strength * 1.5) * warm * (0.85 * 0.6) * carry * land;
        result = mix(graded, gradedLuma * tint, adapt);
        add += base * pool * u_poolGain + pool * (0.035 * inkKeep) * u_poolGain;
        landWarm = warm;
    }
    result = lumaKnee(result + add, gradedLuma);
    if (landWarm > 0.0) {
        float y = dot(result, GRADE_LUMA);
        float share = clamp((y - gradedLuma) / max(y, 0.02) * 1.6, 0.0, 1.0);
        int index = ambientPoolIndex(ambientSteps);
        vec3 stop = mix(vec3(1.0), mix(LAND_RIM, LAND_CORE, float(index) / 5.0), AMBIENT_POOL_CHROMA[index]);
        float course = AMBIENT_POOL_SHARE[index];
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
// SEA-1 (look `sea1` > 0) — the cloud field lies on the ground plane: a world
// point (x, y) reads the field at (x * 0.64, y * 1.0) (relaxed 2026-11-23,
// operator decision: village-scaled 1600 × 1024 world-px tile with whole 2-px
// Canvas texels and exact 32-bit integer parity). On land one firm course
// replaces the three nested rings: the rim (the covered share) one course,
// its core (CLOUD_PLANE_CORE of the share) two; open water takes no multiply
// (its shade is one stop of the lift).
export const CLOUD_PLANE = Object.freeze([0.64, 1.0]);
export const CLOUD_PLANE_CORE = 0.85;
// PERF-01 — exact 32-bit integer bilinear constants derived from CLOUD_TILE_*,
// CLOUD_FIELD_PERIOD, CLOUD_PLANE and CLOUD_SECOND_OCTAVE so GLSL, WGSL and the
// JS twin evaluate the same cloud field without hardware linear-filter drift.
const CLOUD_FIELD_SPAN_PX = CLOUD_TILE_WORLD_SCALE * CLOUD_TILE_SIZE;
const CLOUD_U16_PER_PX = Math.round(65536 / CLOUD_FIELD_SPAN_PX);
const CLOUD_OCT2_NUM = 4;
const CLOUD_OCT2_DEN = Math.round(CLOUD_SECOND_OCTAVE.scale * CLOUD_OCT2_NUM);
const intGcd = (a, b) => (b === 0 ? a : intGcd(b, a % b));
const intLcm = (a, b) => (a / intGcd(a, b)) * b;
const CLOUD_PLANE_PERIOD = CLOUD_PLANE.map(s => Math.round(CLOUD_FIELD_PERIOD / s));
const CLOUD_SHIFT_LCM = intLcm(CLOUD_FIELD_PERIOD, intLcm(CLOUD_PLANE_PERIOD[0], CLOUD_PLANE_PERIOD[1]));
const CLOUD_OCT2_WEIGHT_MILLI = Math.round(CLOUD_SECOND_OCTAVE.weight * 1000);
const CLOUD_OCT2_WEIGHT_GCD = intGcd(CLOUD_OCT2_WEIGHT_MILLI, 1000);
export const CLOUD_INT_CONSTANTS = Object.freeze({
    spanPx: CLOUD_FIELD_SPAN_PX,
    u16PerPx: CLOUD_U16_PER_PX,
    u16Half: Math.round(CLOUD_U16_PER_PX / 2),
    periodPx: CLOUD_FIELD_PERIOD,
    periodU16: Math.round(CLOUD_FIELD_PERIOD * CLOUD_U16_PER_PX),
    shiftLcm: CLOUD_SHIFT_LCM,
    planePeriod: Object.freeze(CLOUD_PLANE_PERIOD),
    planeScale100: Object.freeze(CLOUD_PLANE.map(s => Math.round(s * CLOUD_U16_PER_PX * 100))),
    planeHalf100: Object.freeze(CLOUD_PLANE.map(s => Math.round(0.5 * s * CLOUD_U16_PER_PX * 100))),
    oct2Num: CLOUD_OCT2_NUM,
    oct2Den: CLOUD_OCT2_DEN,
    oct2Half: Math.floor(CLOUD_OCT2_DEN / 2),
    oct2OffsetU16: Object.freeze(CLOUD_SECOND_OCTAVE.offset.map(o => Math.round(o * CLOUD_U16_PER_PX))),
    oct2WeightMilli: CLOUD_OCT2_WEIGHT_MILLI,
    oct2WeightNum: CLOUD_OCT2_WEIGHT_MILLI / CLOUD_OCT2_WEIGHT_GCD,
    oct2WeightDen: 1000 / CLOUD_OCT2_WEIGHT_GCD,
});
// SEA-1 — sunlit water lifts by up to this many palette stops (by day, under
// a visible sun, outside the cloud shade), never lighter than stop
// SEA_SUN_LIFT_FLOOR (a stop already lighter keeps its own), so a lifted
// body (5 -> 3), its lit slope (3 -> 2) and trough (6 -> 4) stay three tones.
export const SEA_SUN_LIFT_STOPS = 2;
export const SEA_SUN_LIFT_FLOOR = 2;
// SEA-2 (look `sea2`) — the sky's share on lit open water (a set's lit slope
// and the static swell caps; never the body, troughs, shade or moving
// dashes), at the texel's own value (hue only), times the look and the day
// (1 − the water's night). Warm horizon inside the sun's road on the open
// sea, the cool water sky outside it.
export const SEA_SKY_WEIGHT = 0.3;
// SEA-3 (look `sea3`) — the sea state from the one wind's knot speed
// |windX| (Wind.baseWindX): calm below `calm` × strength, fresh from
// `fresh` + (1 − strength) × 0.4, storm on the weather's storm flag,
// breeze (today's sea) between; `hysteresis` keeps a state from flapping.
// Calm: no caps or deep dashes on open water, glassy lanes (the cloud tile
// at `lane` scale over `laneThreshold`) take the sky's hue at `laneWeight`.
// Fresh: `freshCaps` more cap clusters, and whitecap streak rows: one texel
// row in every `streakRow`, `streakCell`-px cells holding a streak of
// `streakLength[0]` + up to `streakLength[1]` − 1 px at `streakDensity` ×
// strength, its two downwind texels FOAM, the rest one
// stop lighter, sliding downwind one world px per two 6 Hz water ticks.
export const SEA_STATE = Object.freeze({
    calm: 0.25,
    fresh: 0.7,
    hysteresis: 0.04,
    lane: Object.freeze([1536, 64]),
    laneOffset: Object.freeze([0.61, 0.27]),
    laneThreshold: 0.56,
    laneWeight: 0.4,
    freshCaps: 0.2,
    streakRow: 6,
    streakCell: 32,
    streakLength: Object.freeze([6, 10]),
    streakDensity: 0.28,
    // Wrap of the streak shift: a multiple of streakCell (~9 h at 3 px/s).
    streakWrap: 98304,
});

/** SEA-1 — the field's scale per axis at a `sea1` strength (1, 1 when off). */
export function cloudPlaneScale(strength) {
    return strength > 0 ? CLOUD_PLANE : [1, 1];
}

// r2 — the two stops arrive on the real sun: the first as it clears the
// horizon, the second above about 10°, each swept in across SEA_LIFT_BAND
// degrees of elevation (the shaders take floor(lift + the sea's own Bayer
// order), so a stop arrives a sixteenth of the sea per JS step, world-
// anchored, never the whole sea in one frame).
export const SEA_LIFT_ELEVATIONS = Object.freeze([0, 10]);
export const SEA_LIFT_BAND = 2;
// r6 — the C2 sun band from which the lift is on (whole at the second).
export const SEA_LIFT_SUN_GATE = Object.freeze([0.5, 0.7]);
// r6 — the frame lift moves at most this many stops per 6 Hz water tick
// toward its target (GpuFrameState.slewSeaLift): a sixteenth a second, so a
// weather change spreads a stop over 16 s (under a stop in any 10 s) and
// never steps the whole sea at once.
export const SEA_LIFT_SLEW = 1 / 96;

/**
 * SEA-1 — the sunlit water's lift in stops at a strength and sun band.
 * With `elevationDeg` (the real sun) it is fractional, in sixteenths: each
 * stop sweeps in over SEA_LIFT_BAND degrees above its SEA_LIFT_ELEVATIONS
 * entry. Without it (no solar snapshot), whole stops on the sun band.
 */
export function seaSunLiftStops(strength, sunBand, elevationDeg) {
    if (!(strength > 0)) return 0;
    const band = Math.max(0, Math.min(1, Number(sunBand) || 0));
    const elevation = Number(elevationDeg);
    if (!Number.isFinite(elevation)) return Math.floor(SEA_SUN_LIFT_STOPS * strength * band + 0.5);
    const unit = value => Math.max(0, Math.min(1, value));
    const stops = SEA_LIFT_ELEVATIONS.reduce((sum, at) => sum + unit((elevation - at) / SEA_LIFT_BAND), 0);
    // The sun band only gates, never dims: from SEA_LIFT_SUN_GATE, above the
    // steady overcast band (0.2), so overcast, rain and night have none.
    const sun = unit((band - SEA_LIFT_SUN_GATE[0]) / (SEA_LIFT_SUN_GATE[1] - SEA_LIFT_SUN_GATE[0]));
    // r6 — the strength is a ceiling on the stops (2 × strength), never a
    // multiplier: at 0.5 the first stop sweeps in whole and nothing follows.
    return Math.round(Math.min(stops * sun, SEA_SUN_LIFT_STOPS * Math.min(1, strength)) * 16) / 16;
}

/**
 * 1.4 / 3.4 — the share of the ground and sea under a cloud course at a
 * weather's cloud cover, one rule for both backends (GpuFrameState
 * `resolveAtmosphereCourses`, CloudShadowCourses). Floor lowered from 0.15 to
 * 0.04 (relaxed 2026-11-23, operator decision) so clear days cast sparse
 * shadows (~12 %) and partly cloudy reaches ~45 %.
 */
export function cloudCoveredShare(cover) {
    const value = Number(cover);
    return Math.max(0, Math.min(0.45, ((Number.isFinite(value) ? value : 0) - 0.04) * 2.0));
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
 * PERF-01 — exact JS twin of the GLSL/WGSL positive 32-bit integer bilinear
 * cloud-tile sampler (returns 0..16711680 = 255 * 65536).
 */
export function cloudTileBilinear16(data, u16x, u16y, size = CLOUD_TILE_SIZE) {
    const sx = (u16x - 128) & 65535;
    const sy = (u16y - 128) & 65535;
    const t0x = sx >> 8;
    const t0y = sy >> 8;
    const fx = sx & 255;
    const fy = sy & 255;
    const mask = size - 1;
    const byteAt = (ix, iy) => data[(((iy & mask) * size) + (ix & mask)) * 4];
    const a = byteAt(t0x, t0y);
    const b = byteAt(t0x + 1, t0y);
    const c = byteAt(t0x, t0y + 1);
    const d = byteAt(t0x + 1, t0y + 1);
    const top = a * 256 + (b - a) * fx;
    const bot = c * 256 + (d - c) * fx;
    return top * 256 + (bot - top) * fy;
}

/**
 * PERF-01 — exact JS twin of GLSL/WGSL `cloudNoiseIntAt(ic)` (0..16711680),
 * deriving all scales and weights from `CLOUD_INT_CONSTANTS`.
 */
export function cloudNoiseIntAt(data, icx, icy, driftX = 0, driftY = 0, planeOn = false, size = CLOUD_TILE_SIZE) {
    const C = CLOUD_INT_CONSTANTS;
    const ix = Math.floor(icx);
    const iy = Math.floor(icy);
    let baseX;
    let baseY;
    if (planeOn) {
        const wx = ((ix % C.planePeriod[0]) + C.planePeriod[0]) % C.planePeriod[0];
        const wy = ((iy % C.planePeriod[1]) + C.planePeriod[1]) % C.planePeriod[1];
        baseX = Math.trunc((wx * C.planeScale100[0] + C.planeHalf100[0] + 50) / 100);
        baseY = Math.trunc((wy * C.planeScale100[1] + C.planeHalf100[1] + 50) / 100);
    } else {
        const wx = ((ix % C.periodPx) + C.periodPx) % C.periodPx;
        const wy = ((iy % C.periodPx) + C.periodPx) % C.periodPx;
        baseX = wx * C.u16PerPx + C.u16Half;
        baseY = wy * C.u16PerPx + C.u16Half;
    }
    const dx = Math.floor(driftX * C.u16PerPx + 0.5);
    const dy = Math.floor(driftY * C.u16PerPx + 0.5);
    const ipx = (((baseX + dx) % C.periodU16) + C.periodU16) % C.periodU16;
    const ipy = (((baseY + dy) % C.periodU16) + C.periodU16) % C.periodU16;
    const n1 = cloudTileBilinear16(data, ipx & 65535, ipy & 65535, size);
    const u2x = (Math.trunc((ipx * C.oct2Num + C.oct2Half) / C.oct2Den) + C.oct2OffsetU16[0]) & 65535;
    const u2y = (Math.trunc((ipy * C.oct2Num + C.oct2Half) / C.oct2Den) + C.oct2OffsetU16[1]) & 65535;
    const b2 = cloudTileBilinear16(data, u2x, u2y, size);
    const n2 = Math.trunc((b2 * C.oct2WeightNum + Math.floor(C.oct2WeightDen / 2)) / C.oct2WeightDen);
    return Math.max(n1, n2);
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

// C1, C2, C3, C5, C6, C4: the largest cloud enters last.
export const CUMULUS_STAMPS = Object.freeze([
    [400, 200, [[0,0,180,80],[150,-20,140,64],[-140,10,120,56],[40,-50,110,48]]],
    [1500, 420, [[0,0,220,96],[190,20,150,70],[-170,-10,130,60]]],
    [2600, 180, [[0,0,140,64],[110,-30,100,48],[-90,20,90,40],[30,40,80,36],[-40,-40,70,32]]],
    [2100, 1000, [[0,0,120,56],[90,10,80,40],[-80,-10,70,32]]],
    [3000, 700, [[0,0,200,90],[170,30,120,56],[-150,20,140,62],[60,-60,100,44]]],
    [900, 900, [[0,0,260,110],[220,-30,170,76],[-230,10,160,70],[0,-70,140,60]]],
]);
export const cumulusCount = share => Math.max(0, Math.min(6, Math.round(6 * share / 0.38)));

function bakeCumulus(data, size) {
    // R remains the weather texture for ruffles, mist and squalls. G identifies
    // the nearest stamp, B carries squared lobe distance at 1/128 resolution.
    for (let i = 2; i < data.length; i += 4) data[i] = 255;
    for (const [index, [cx, cy, lobes]] of CUMULUS_STAMPS.entries()) {
        for (const [dx, dy, rx, ry] of lobes) {
            const x0 = (cx + dx) * size / 3200, y0 = (cy + dy) * size / 1280;
            const w = rx * size / 3200, h = ry * size / 1280;
            for (let y = Math.floor(y0 - 1.42*h); y <= y0 + 1.42*h; y++) {
                for (let x = Math.floor(x0 - 1.42*w); x <= x0 + 1.42*w; x++) {
                    const d = Math.round(128 * (((x + 0.5 - x0) / w) ** 2 + ((y + 0.5 - y0) / h) ** 2));
                    const i = 4 * ((((y % size) + size) % size) * size + ((x % size) + size) % size);
                    if (d >= data[i + 2]) continue;
                    data[i + 1] = index + 1;
                    data[i + 2] = d;
                }
            }
        }
    }
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
    bakeCumulus(data, size);
    return data;
}

// 1.6 — clear-daylight blend weight (0 at night, dusk, overcast, storm or fog;
// 1 on clear sunlit days) so lighter clear-air haze never changes night, storm
// or foggy scenes.
export function clearDayHazeWeight(fog = 0, daylight = 0, cloudCover = 0) {
    const f = Math.max(0, Math.min(1, Number(fog) || 0));
    const d = Math.max(0, Math.min(1, Number(daylight) || 0));
    const c = Math.max(0, Math.min(1, Number(cloudCover) || 0));
    const dayShare = Math.max(0, Math.min(1, (d - 0.30) / 0.60));
    const airShare = Math.max(0, Math.min(1, (0.20 - f) / 0.15));
    const skyShare = Math.max(0, Math.min(1, (0.85 - c) / 0.30));
    return dayShare * airShare * skyShare;
}

// NE v0.67.1 C — clear-night blend weight (night > 0.5, fog < 0.05,
// cloudCover < 0.35): lets crisp clear nights shed the overcast/fog haze curve
// without changing day, blue hour, overcast, rain, storm or fog.
export function clearNightHazeWeight(fog = 0, night = 0, cloudCover = 0) {
    const f = Math.max(0, Math.min(1, Number(fog) || 0));
    const n = Math.max(0, Math.min(1, Number(night) || 0));
    const c = Math.max(0, Math.min(1, Number(cloudCover) || 0));
    if (!(n > 0.5 && f < 0.05 && c < 0.35)) return 0;
    const nightShare = Math.max(0, Math.min(1, (n - 0.5) / 0.35));
    const airShare = Math.max(0, Math.min(1, (0.05 - f) / 0.04));
    const skyShare = Math.max(0, Math.min(1, (0.35 - c) / 0.20));
    return nightShare * airShare * skyShare;
}

// 1.6 / NE v0.67.1 C — screen-Y aerial perspective strength by zoom (base
// survey 0.18, tier 1 0.14, tier 2 0.08, tier 3 0.04), raised by fog. Clear
// daylight and clear night blend toward crisp clear-air stops
// (0.08 / 0.06 / 0.03 / 0.01); storm, overcast and fog stay on the base curve.
export function aerialPerspectiveStrength(zoom = 1, fog = 0, clearDay = 0, clearNight = 0) {
    const z = Math.max(0.25, Number(zoom) || 1);
    const f = Math.max(0, Math.min(1, Number(fog) || 0));
    const air = Math.max(0, Math.min(1, (0.20 - f) / 0.15));
    const clear = Math.max(0, Math.min(1, Number(clearDay) || 0)) * air;
    const night = Math.min(1 - clear, Math.max(0, Math.min(1, Number(clearNight) || 0)) * air);
    const baseStops = [[0.5, 0.18], [1, 0.14], [2, 0.08], [3, 0.04]];
    const clearStops = [[0.5, 0.08], [1, 0.06], [2, 0.03], [3, 0.01]];
    const nightStops = [[0.5, 0.08], [1, 0.06], [2, 0.03], [3, 0.01]];
    const sample = (stops) => {
        let strength = stops[stops.length - 1][1];
        if (z <= stops[0][0]) return stops[0][1];
        for (let index = 1; index < stops.length; index++) {
            const [z1, s1] = stops[index];
            const [z0, s0] = stops[index - 1];
            if (z <= z1) return s0 + (s1 - s0) * ((z - z0) / (z1 - z0));
        }
        return strength;
    };
    const base = sample(baseStops);
    let strength = clear > 0 ? base + (sample(clearStops) - base) * clear : base;
    if (night > 0) strength += (sample(nightStops) - base) * night;
    return strength * (1 + f);
}

// 1.6 / NE v0.67.1 C — vertical reach of the screen-Y aerial haze: 0.55 by
// default (storm, overcast, fog), pulling up to 0.30 in clear daylight and
// 0.35 on clear nights.
export function aerialHazeStart(fog = 0, clearDay = 0, clearNight = 0) {
    const f = Math.max(0, Math.min(1, Number(fog) || 0));
    const air = Math.max(0, Math.min(1, (0.20 - f) / 0.15));
    const clear = Math.max(0, Math.min(1, Number(clearDay) || 0)) * air;
    const night = Math.max(0, Math.min(1, Number(clearNight) || 0)) * air;
    if (clear <= 0 && night <= 0) return 0.55;
    if (clear >= 1) return 0.30;
    if (clear <= 0 && night >= 1) return 0.35;
    return Math.max(0.30, 0.55 - 0.25 * clear - 0.20 * night);
}

// Daytime bloom: only buildings with an open work gate (working Forge fire,
// awake Portal, working Command braziers) activate the daytime bloom path;
// static props (such as prop.runeBrazier) never trigger daytime bloom on their
// own, and passive emitters stay at the 0.14 daylight core.
export const DAYTIME_WORK_BLOOM_CORE = 0.36;
export const DAYTIME_WORK_BLOOM_STRENGTH = 0.22;
export const DAYLIGHT_PASSIVE_CORE_SCALE = 0.14 / DAYTIME_WORK_BLOOM_CORE;

export function isDaytimeHighEnergyBuilding(buildingType, active, emissiveGate) {
    if (!active || !(emissiveGate > 0.01)) return false;
    return buildingType === 'forge' || buildingType === 'portal' || buildingType === 'command';
}

export function hasActiveBloomEmitters(batches) {
    if (!Array.isArray(batches)) return false;
    for (let b = 0; b < batches.length; b++) {
        const batch = batches[b];
        if (!batch?.emissiveTexture && !batch?.emissiveSource) continue;
        const records = batch.records;
        for (let r = 0; r < records.length; r++) {
            const rec = records[r];
            if (rec?.daytimeEmitter && rec.emissiveGate > 0.01) return true;
        }
    }
    return false;
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
// Never under `?postfx=0` or without `navigator.gpu` (`gpu`). FP-9: nor by
// default when a recent boot of this browser build found no adapter
// (`knownNoAdapter`, `webGpuOutcomeSkipsProbe`); `?renderer=webgpu` still
// requests one.
export function shouldProbeWebGpu(search = '', { chromium = false, gpu = false, softwareRaster = false, knownNoAdapter = false } = {}) {
    const params = search instanceof URLSearchParams
        ? search
        : new URLSearchParams(String(search || '').replace(/^\?/, ''));
    if (!gpu || params.get('postfx') === '0') return false;
    const forced = forcedGpuWorldRendererMode(params);
    if (forced) return forced === GPU_WORLD_RENDERER_MODES.WEBGPU;
    return chromium && !softwareRaster && !knownNoAdapter;
}

// FP-9 — a browser with no WebGPU adapter (Linux Chrome without its WebGPU
// flags) still imported the WebGPU module graph and asked for an adapter on
// every boot. The boot that finds none stores `{ webgpu: 'no-adapter', ua,
// at }`; a default boot of the same user agent within the recheck window
// skips the resolution. A browser update (a new user agent) or a day later
// probes again, so a newly enabled WebGPU is found within a day.
export const WEBGPU_NO_ADAPTER_RECHECK_MS = 24 * 60 * 60 * 1000;
export function webGpuOutcomeSkipsProbe(record, { userAgent = '', now = Date.now() } = {}) {
    if (record?.webgpu !== 'no-adapter' || record.ua !== String(userAgent)) return false;
    const age = now - Number(record.at);
    return age >= 0 && age < WEBGPU_NO_ADAPTER_RECHECK_MS;
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
    // LA-7 — a sea-fret fog-bank record (`ground:fog`): its own alpha is the
    // banks' share over land; over painted water and the open sea the scene
    // fragment keeps the tile's full alpha (`seaFretAlpha`).
    seaFret: 1024,
    // SD-2 — a record the shade field already holds (gpu/SunShade.js): a
    // ground stamp of the sun's own shade (a villager's trail) is hidden
    // wherever the field shades the ground, and an upright prop standing in
    // its own mass (PROP_MASSING) takes no shade from it. (2048 is the 2.8
    // lamp-shadow twin's.)
    sunSelf: 4096,
    // SD-2 — a record the sun's shade never dims (gpu/SunShade.js): the body
    // of an action-needed villager (and what lies on it) and a petitioner's
    // floor candle. Attention loses nothing in shade.
    shadeExempt: 8192,
    recolorIndex: 16384,
    faceKeyed: 32768,
    goldenRim: 65536,
    reliefMaterial: 131072,
    surfacePage: 262144,
    mirrorSource: 524288,
    shaftReceiver: 1048576,
    surfaceRelative: 2097152,
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
        | (record.groundCast === true ? GPU_RECORD_FLAGS.groundCast : 0)
        | (record.seaFret === true ? GPU_RECORD_FLAGS.seaFret : 0)
        | (record.sunSelf === true ? GPU_RECORD_FLAGS.sunSelf : 0)
        | (record.shadeExempt === true ? GPU_RECORD_FLAGS.shadeExempt : 0)
        | ((record.flags || 0) & 0x3fc000)
        | (record.recolorIndex === true ? GPU_RECORD_FLAGS.recolorIndex : 0)
        | (record.faceKeyed === true ? GPU_RECORD_FLAGS.faceKeyed : 0)
        | (record.goldenRim === true ? GPU_RECORD_FLAGS.goldenRim : 0)
        | (record.reliefMaterial === true ? GPU_RECORD_FLAGS.reliefMaterial : 0)
        | (record.surfacePage === true ? GPU_RECORD_FLAGS.surfacePage : 0)
        | (record.mirrorSource === true ? GPU_RECORD_FLAGS.mirrorSource : 0)
        | (record.shaftReceiver === true ? GPU_RECORD_FLAGS.shaftReceiver : 0)
        | (record.surfaceRelative === true ? GPU_RECORD_FLAGS.surfaceRelative : 0);
    target.footY = finite(record.footY, Number.isFinite(depthSortY) ? depthSortY : -1);
    target.frontCornerX = finite(record.frontCornerX, 0);
    target.frontCornerY = finite(record.frontCornerY, -1);
    target.ownerSlot = uint16Field(record.ownerSlot);
    target.landmarkId = uint16Field(record.landmarkId);
    target.paletteRamp = Boolean(record.paletteRamp);
    const indexed = (target.flags & GPU_RECORD_FLAGS.recolorIndex) !== 0;
    target.recolorRow = indexed ? Math.min(255, uint16Field(record.recolorRow)) : 0;
    target.meta = indexed ? Math.min(11, uint16Field(record.variant ?? record.meta)) : uint16Field(record.alpenglowRow ?? record.meta);
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
    normalized.daytimeEmitter = record.daytimeEmitter === true;
    normalized.occluder = occluder;
    normalized.material = materialClassId(record.material ?? record.materialId);
    normalized.blend = blend;
    normalized.sequence = finite(record.sequence, sequence);
    // B.1b — written every time: a reused scratch record must not keep a
    // previous occupant's opt-out.
    normalized.pageable = record.pageable !== false;
    normalized.textureRevision = record.textureRevision ?? null;
    normalized.sidecarRevision = record.sidecarRevision ?? null;
    // FP-6 — the agent atlas's per-channel revisions; reset like every field,
    // so a scratch record's next occupant never inherits them.
    normalized.materialRevision = record.materialRevision ?? null;
    normalized.emissiveRevision = record.emissiveRevision ?? null;
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

// NL-4 — a carried lantern ranks after every other light and holds no
// fixture reserve, so it never takes a slot or a tile from a street lamp, a
// window or an attention light.
function isCarriedLantern(light) {
    return String(light?.id || '').startsWith('carried-lantern:');
}

function lightRoleRank(light) {
    if (isAttentionLight(light)) return 0;
    if (isCarriedLantern(light)) return 4;
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
// NE P2.6 — raised 16 -> 24 for the wider deep-night pools (reach 1.5x).
export const LIGHT_TILE_SLOTS = 24;
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
    // GW-2 — lays its mirror column on wet paving and puddles (every
    // admitted fixed light at FULL with look `gw2` on, never a carried
    // lantern or an attention light; GpuFrameState.resolveLights).
    groundMirror: 8,
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

// T4 / NE P2.6 — the night's fixtures (street lamps, braziers, watchfires)
// keep up to this many slots, at most half the count, ahead of apertures and
// attention lights: at MINIMAL (24) half-cap still holds 12, while REDUCED
// (64) and FULL (128) hold up to 24 for the wider lamp network.
export const FIXTURE_LIGHT_RESERVE = 24;

function isFixtureLight(light) {
    return !isAttentionLight(light) && !isCarriedLantern(light)
        && Math.round(finite(light?.role, LIGHT_ROLE_CODES.point)) === LIGHT_ROLE_CODES.fixture;
}

/**
 * 2.4 — admission by binning. Walks `ranked` (clampGpuLights order) and
 * admits a light while the count allows (`cap`; attention lights always;
 * T4: min(FIXTURE_LIGHT_RESERVE, cap / 2, visible fixtures) of the count is
 * held for fixtures, which apertures and points cannot take and attention
 * lights cannot crowd out) and
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
    const onScreen = (light) => {
        lightReachRect(light, { wet }, rect);
        return !((rect.x1 + 1 + cameraX) * s + 2 < 0 || (rect.y1 + 1 + cameraY) * s + 2 < 0
            || (rect.x0 - 1 + cameraX) * s - 2 >= w || (rect.y0 - 1 + cameraY) * s - 2 >= h);
    };
    let fixtureReserve = 0;
    const reserveCap = Math.min(FIXTURE_LIGHT_RESERVE, Math.floor(limit / 2));
    for (let n = 0; n < ranked.length && fixtureReserve < reserveCap; n++) {
        const light = ranked[n];
        if (isFixtureLight(light) && Number.isFinite(light?.footX) && Number.isFinite(light?.footY) && onScreen(light)) fixtureReserve++;
    }
    let fixturesAdmitted = 0;
    for (let n = 0; n < ranked.length; n++) {
        const light = ranked[n];
        const attention = isAttentionLight(light);
        const fixture = !attention && isFixtureLight(light);
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
        const heldForFixtures = Math.max(0, fixtureReserve - fixturesAdmitted);
        const overCap = attention ? false
            : fixture ? admitted.length >= limit && fixturesAdmitted >= fixtureReserve
                : admitted.length >= limit - heldForFixtures;
        if (admitted.length >= MAX_LIGHT_RECORDS || overCap) {
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
        if (fixture) fixturesAdmitted++;
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
