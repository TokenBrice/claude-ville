import {
    MATERIAL_CLASS_IDS,
    materialClassId as registryMaterialClassId,
} from '../MaterialRegistry.js';
import { RECEIVER_LUMA_CEILING } from '../../../config/artPalette.js';
import { WATER_MAX_SATURATION } from '../GradeEvaluator.js';

export const GPU_WORLD_RENDERER_MODES = Object.freeze({
    WEBGL: 'webgl',
    CANVAS: 'canvas',
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
    occlusion: Object.freeze({
        id: 'occlusion',
        levels: Object.freeze({ FULL: 'on', REDUCED: 'on', MINIMAL: 'off' }),
        cost: Object.freeze({ gpuMsBand: [0.134, 0.608], cpuMsBand: [0.059, 0.128], bytes: 967680, scope: 'own-pass' }),
        staticFallback: 'direct-light',
        canvas: 'authored-shading',
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
    // 3.4 — the moon is now a continuous night term inside the C2 grade
    // (every level); this row prices the FULL-only extra stepped water silver
    // course. No band separable from the scene envelope.
    'moon-course': Object.freeze({
        id: 'moon-course',
        levels: Object.freeze({ FULL: 'on', REDUCED: 'ambient-course-only', MINIMAL: 'ambient-course-only' }),
        cost: Object.freeze({ gpuMsBand: [0, 0.05], cpuMsBand: [0, 0.005], bytes: 0, scope: 'shared-scene-envelope' }),
        staticFallback: 'ambient-course-only',
        canvas: 'ambient-course-only',
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
    // 0.1 — light admission is a declared row: how many ranked local lights
    // (attention lights always first, `clampGpuLights`) the scene pass admits.
    // The night's pools ship at every level (V2 tier contract: never below 12
    // at MINIMAL), replacing the undeclared 32/10/4 cut that deleted the lamp
    // pools at REDUCED — which makes this new light-loop work at REDUCED and
    // MINIMAL. Band: the ceiling is the whole FULL - MINIMAL real-frame delta
    // (WebPlatformGPU appburst, dense-24 22:00 z2 4880x1392, 4.02 - 1.55 ms,
    // which also sheds bloom and occlusion) until per-level `gpu-burst.mjs`
    // receipts land; 60 Hz assumed.
    'light-admission': Object.freeze({
        id: 'light-admission',
        levels: Object.freeze({ FULL: 32, REDUCED: 24, MINIMAL: 12 }),
        cost: Object.freeze({ gpuMsBand: [0, 2.47], cpuMsBand: [0, 0.01], bytes: 0, scope: 'shared-scene-envelope' }),
        staticFallback: 'ranked-admission',
        canvas: 'feed-ranked-48',
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

export const GRADE_GLSL = `
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
const float WATER_MAX_SATURATION = ${WATER_MAX_SATURATION.toFixed(3)};
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
const vec3 POOL_RIM = vec3(1.484, 0.914, 0.430);
const vec3 POOL_MID = vec3(1.208, 0.981, 0.577);
const vec3 POOL_CORE = vec3(1.089, 0.995, 0.786);
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
const vec3 LAND_MID = vec3(1.346, 0.948, 0.504);
const vec3 LAND_CORE = POOL_MID;
// Share of the landing per course (rim, mid, core) at full pool light.
const vec3 LAND_SHARE = vec3(0.62, 0.74, 0.84);
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
const float RECEIVER_LUMA_CEILING = ${RECEIVER_LUMA_CEILING.toFixed(4)};
const float RECEIVER_HEADROOM = 0.018;
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
const float RECEIVER_OKL_CEILING = 0.836;
const float ATTENTION_OKL_CEILING = 0.852;
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
// brighter than every lit world pixel. Returns the lit colour.
vec3 stepPool(vec3 graded, vec3 ambient, float ambientSteps, vec3 attention, float attentionSteps, vec3 albedo, vec3 reflection) {
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
        float adapt = min(1.0, strength * 1.5) * warm * (0.85 * 0.6) * carry;
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
        result = mix(result, onStop(stop, y), landWarm * share * course);
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
// (two octaves plus a detail octave), baked once, sampled in world space in
// the composite and cut into three dithered courses there. Pure: no DOM.
export const CLOUD_TILE_SIZE = 256;
// World pixels per tile texel: the field repeats every 1024 world px, larger
// than any view at the crisp zoom tiers.
export const CLOUD_TILE_WORLD_SCALE = 4;

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

export function resolveGpuWorldRendererMode(search = '', { webgl2 = true } = {}) {
    const params = search instanceof URLSearchParams
        ? search
        : new URLSearchParams(String(search || '').replace(/^\?/, ''));
    const requested = String(params.get('renderer') || '').trim().toLowerCase();
    if (requested === GPU_WORLD_RENDERER_MODES.CANVAS) return GPU_WORLD_RENDERER_MODES.CANVAS;
    if (requested === GPU_WORLD_RENDERER_MODES.WEBGL) {
        return webgl2 ? GPU_WORLD_RENDERER_MODES.WEBGL : GPU_WORLD_RENDERER_MODES.CANVAS;
    }
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
export const GPU_PARTICLE_SHAPES = Object.freeze({ rect: 0, blob: 1, wings: 2, motif: 3 });
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
        | (record.screenSpace === true ? GPU_RECORD_FLAGS.screenSpace : 0);
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

// A producer that emits many small records per frame (0.2 ground cues) may
// hand them over already normalized: `prenormalized: true` promises every
// field normalizeGpuRecord would write — the V9 fields of
// `assignGpuRecordV9Fields` included — is present, finite and in range, and
// that the record is valid. Those records skip the per-record copy and are
// batched as-is. 0.6 — `writesDepth` joins the batch key: one batch is drawn
// under one `depthMask`.
export function buildStableGpuBatches(records = [], batches = [], normalizedRecords = []) {
    let batchCount = 0;
    let current = null;
    for (let index = 0; index < records.length; index++) {
        const raw = records[index];
        let record;
        if (raw?.prenormalized === true) {
            if (!raw.source) continue;
            record = raw;
        } else {
            const normalized = normalizedRecords[index] || (normalizedRecords[index] = {});
            record = normalizeGpuRecord(raw, index, normalized);
            if (!validGpuRecord(record)) continue;
        }
        if (!current || current.textureKey !== record.textureKey
            || current.sidecarKey !== record.sidecarKey
            || current.blend !== record.blend
            || current.writesDepth !== record.writesDepth
            || current.source !== record.source
            || current.materialSource !== record.materialSource
            || current.emissiveSource !== record.emissiveSource
            || current.occluderSource !== record.occluderSource) {
            current = batches[batchCount];
            if (!current) {
                current = { records: [] };
                batches[batchCount] = current;
            }
            if (current.textureKey !== record.textureKey
                || current.sidecarKey !== record.sidecarKey
                || current.blend !== record.blend
                || current.writesDepth !== record.writesDepth) {
                current.key = `${record.textureKey}|${record.sidecarKey}|${record.blend}|${record.writesDepth ? 'depth' : 'flat'}`;
            }
            current.writesDepth = record.writesDepth;
            current.source = record.source;
            current.materialSource = record.materialSource;
            current.emissiveSource = record.emissiveSource;
            current.occluderSource = record.occluderSource;
            current.textureKey = record.textureKey;
            current.sidecarKey = record.sidecarKey;
            current.blend = record.blend;
            current.records.length = 0;
            current.first = 0;
            current.count = 0;
            current.occlusionFirst = 0;
            current.occlusionCount = 0;
            current.occluderMax = 0;
            batchCount++;
        }
        current.records.push(record);
    }
    batches.length = batchCount;
    normalizedRecords.length = records.length;
    return batches;
}

export function estimateGpuWorldTextureBytes({
    width = 0,
    height = 0,
    bloomScale = 0.5,
    occlusionScale = 0.5,
    cachedTextures = [],
} = {}) {
    const w = Math.max(0, Math.floor(finite(width)));
    const h = Math.max(0, Math.floor(finite(height)));
    const bloomW = Math.max(0, Math.floor(w * Math.max(0, finite(bloomScale, 0.5))));
    const bloomH = Math.max(0, Math.floor(h * Math.max(0, finite(bloomScale, 0.5))));
    const occW = Math.max(0, Math.floor(w * Math.max(0, finite(occlusionScale, 0.5))));
    const occH = Math.max(0, Math.floor(h * Math.max(0, finite(occlusionScale, 0.5))));
    const targets = (w * h + bloomW * bloomH * 2 + occW * occH) * 4;
    let textures = 0;
    for (const texture of cachedTextures || []) {
        const tw = Math.max(0, Math.floor(finite(texture?.width)));
        const th = Math.max(0, Math.floor(finite(texture?.height)));
        const copies = Math.max(1, Math.floor(finite(texture?.copies, 1)));
        textures += tw * th * 4 * copies;
    }
    return { targets, textures, total: targets + textures };
}

// 3.1 — action-needed overlays are outside the exposure budget: the renderer
// asks this before applying the envelope's spill share to a light.
export function isAttentionLight(light) {
    return Boolean(light?.attention) || String(light?.id || '').startsWith('attention:');
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
                || snapshot.id !== light?.id || snapshot.attention !== light?.attention) {
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
            }
        }
        ranked.sort((a, b) => (
            Number(isAttentionLight(b)) - Number(isAttentionLight(a))
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
