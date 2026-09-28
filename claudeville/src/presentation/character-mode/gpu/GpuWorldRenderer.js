import {
    buildStableGpuBatches,
    clampGpuLights,
    createGpuTimingMetricsScratch,
    effectBudgetMode,
    shedEffectsForLevel,
    estimateGpuWorldTextureBytes,
    gpuLightColorForShader,
    isAttentionLight,
    localLightPhaseForLighting,
    selectGpuTimingMetrics,
    GRADE_GLSL,
    GRADE_UNIFORM_NAMES,
    uploadGradeUniforms,
    buildCloudShadowTile,
    CLOUD_TILE_SIZE,
    CLOUD_TILE_WORLD_SCALE,
    aerialPerspectiveStrength,
    EFFECT_BUDGET,
    GPU_PARTICLE_FLAGS,
    GPU_PARTICLE_INSTANCE_BYTES,
    GPU_PARTICLE_MOTIF_SIZE,
    GPU_PARTICLE_SHAPES,
    GPU_RECORD_FLAGS,
} from './GpuWorldPolicy.js';
import { NEUTRAL_GRADE } from '../GradeEvaluator.js';
import { waterMoodFor } from '../CoastBake.js';
import {
    createPostFxLadder,
    POST_FX_LEVELS,
} from '../postfx/PostFxLadder.js';
import { glslMaterialWeatherFunctions } from '../MaterialRegistry.js';
import { NEUTRAL_SOURCE_ENERGY, sourceEnergyFor } from '../AtmosphereState.js';
import { growTypedArray } from '../AssetManager.js';
import { particleMotifMask } from '../ParticleSystem.js';
import { cloudCourseDrift } from '../Wind.js';

const MAX_LIGHTS = 32;
// V9 / B.1a — one instance per record, drawn as a 4-vertex TRIANGLE_STRIP
// with every attribute at divisor 1 (docs/material-channel-contract.md):
//   loc0 FLOAT  x4  rect (x, y, w, h), world px                  bytes  0-15
//   loc1 FLOAT  x4  uv rect (u0, v0, u1, v1)                            16-31
//   loc2 FLOAT  x4  (alpha, material, elevation, emissive)              32-47
//   loc3 USHORT x4  (occluder, gate) x 65535, ramp, flags               48-55
//   loc4 USHORT x4  depth key, footY, frontCornerX, frontCornerY        56-63
//                   (receiver coordinates integer world px + 32768)
//   loc5 USHORT x2  (ownerSlot, landmarkId), vertexAttribIPointer        64-67
// Continuous surface values stay float32, so the frame is bit-exact with the
// six-vertex staging it replaced; the integer fields pack as uint16. A batch
// whose records all carry the default V9 tail (loc3-loc5: no occluder, gate
// 1, no ramp or flags, far-plane depth, ground-self receiver, no identity) —
// terrain, ground casts and marks, every ground-cue chord — stages only the
// 48-byte head; its draw disables arrays 3-5 and the vertex stage reads the
// tail as constant generic attributes. WebGL2 has no base instance: every
// batch re-points its attributes at its own byte range
// (`_pointRecordInstances`).
const RECORD_HEAD_BYTES = 48;
const RECORD_INSTANCE_BYTES = 68;
const RECEIVER_BIAS = 32768;
const RECORD_TAIL_RESPONSE = Object.freeze([0, 65535, 0, 0]);
const RECORD_TAIL_RECEIVER = Object.freeze([0, RECEIVER_BIAS - 1, RECEIVER_BIAS, RECEIVER_BIAS - 1]);
const SCENE_DEPTH_BYTES_PER_PIXEL = EFFECT_BUDGET['particle-depth'].cost.attachmentBytesPerPixel;
// V9 sampler table: one fixed texture unit per field per program, never
// reassigned (WebGL2 guarantees 16 fragment units). A `reserved` unit is held
// for the named item and bound only by it; see the channel contract doc.
export const SCENE_SAMPLER_UNITS = Object.freeze({
    albedo: 0,
    material: 1,
    occlusion: 2,
    emissive: 3,
    occluder: 4,
    paletteLut: 5,
    footprint: 6,
    cycleOffset: 7,
    coastField: 8,
    lightData: 9,
    lightTiles: 10,
    puddleMask: 11,
    cloudTile: 12,
});
export const PARTICLE_SAMPLER_UNITS = Object.freeze({ motifs: 0, cloudTile: 1 });
export const COMPOSITE_SAMPLER_UNITS = Object.freeze({ scene: 0, bloom: 1 });
// V9 typed-texture formats: `bytesPerTexel` is the real resident size (the
// cache's accounting unit), never the x4 of an RGBA canvas.
const TEXTURE_FORMATS = Object.freeze({
    rgba8: Object.freeze({ internalFormat: 'RGBA8', format: 'RGBA', type: 'UNSIGNED_BYTE', bytesPerTexel: 4, array: Uint8Array }),
    r8: Object.freeze({ internalFormat: 'R8', format: 'RED', type: 'UNSIGNED_BYTE', bytesPerTexel: 1, array: Uint8Array }),
    rg8: Object.freeze({ internalFormat: 'RG8', format: 'RG', type: 'UNSIGNED_BYTE', bytesPerTexel: 2, array: Uint8Array }),
    r16ui: Object.freeze({ internalFormat: 'R16UI', format: 'RED_INTEGER', type: 'UNSIGNED_SHORT', bytesPerTexel: 2, array: Uint16Array }),
    rgba32f: Object.freeze({ internalFormat: 'RGBA32F', format: 'RGBA', type: 'FLOAT', bytesPerTexel: 16, array: Float32Array }),
});
// 0.6 — an emissive particle's bloom share, scaled by the same source-energy
// core as authored emission (fire props without a sidecar sit at 0.35).
const PARTICLE_EMISSION = 0.5;
// The app caps live particles at 240 (ParticleSystem MAX_PARTICLES).
const MAX_PARTICLE_INSTANCES = 240;
const BLOOM_SCALE = 0.375;
const OCCLUSION_SCALE = 0.375;
const EMA_ALPHA = 0.1;
// 3.5's ramp table (11x3 RGBA = 132 B) and 3.3's ground-receiver field
// (2 x 256x144 RGBA8 = 294,912 B) are new resident bytes, so the evictable
// cached-source ceiling gives up exactly that much: the renderer's total
// resident texture ceiling is unchanged from the shipped 48 MiB.
const PALETTE_LUT_WIDTH = 11;
const PALETTE_LUT_HEIGHT = 3;
const PALETTE_LUT_BYTES = PALETTE_LUT_WIDTH * PALETTE_LUT_HEIGHT * 4;
const SPILL_FIELD_WIDTH = 256;
const SPILL_FIELD_HEIGHT = 144;
const SPILL_FIELD_BYTES = SPILL_FIELD_WIDTH * SPILL_FIELD_HEIGHT * 4 * 2;
const MAX_CACHED_TEXTURE_BYTES = 48 * 1024 * 1024 - PALETTE_LUT_BYTES - SPILL_FIELD_BYTES;
const MAX_CACHED_TEXTURES = 512;
const LOCAL_LIGHT_VISIBILITY_FLOOR = 0.04;
const DEFAULT_LIGHT_COLOR = Object.freeze([1, 0.78, 0.42]);
const GPU_PASS_NAMES = ['upload', 'occlusion', 'scene', 'bloom', 'present'];
const PASS_RING_CAPACITY = 32;
// 0.1 — the whole-frame GPU timer is a veto, not a clock. It is begun on 1
// frame in 4 (each begin/end forces an ANGLE-Metal command-buffer flush), on
// every frame while at least 10 % of the pacing window misses (a real overload
// then confirms within 2 s), and the ladder reads the p25 of the last 30
// samples: contention only ever lengthens a span.
const GPU_TIMER_EVERY = 4;
const GPU_TIMER_DENSE_MISS_SHARE = 0.1;
const GPU_TIMER_RING = 30;
// 0.1 — debug-only injected GPU load (`setDebugLoad`, `?gpuLoad=N`): one
// composite-sized pass (a scene fetch and ~20 ALU) that adds exactly zero,
// which no compiler can prove, so every pass executes and the frame is
// unchanged. Additive blending also keeps TBDR hidden-surface removal from
// culling the stacked full-screen draws.
const DEBUG_LOAD_FRAGMENT = `#version 300 es
precision highp float;
in vec2 v_uv;
layout(location = 0) out vec4 outColor;
uniform sampler2D u_scene;
void main() {
    vec3 c = texture(u_scene, v_uv).rgb;
    float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
    vec3 g = mix(vec3(l), c * vec3(0.9, 0.95, 1.05) + vec3(0.02), 0.7);
    g = pow(max(g, vec3(0.0)), vec3(1.08));
    outColor = vec4(max(g - vec3(4.0), vec3(0.0)), 0.0);
}`;

function unitToUint16(value) {
    const number = Number(value);
    if (!(number > 0)) return 0;
    return number >= 1 ? 65535 : Math.round(number * 65535);
}

function receiverToUint16(value) {
    const number = Math.round(Number(value)) + RECEIVER_BIAS;
    if (!(number > 0)) return 0;
    return number >= 65535 ? 65535 : number;
}

// True when a record's V9 tail (loc3-loc5) is all defaults, so its batch may
// stage the head alone.
function recordHasDefaultTail(record) {
    return !(record.occluder > 0)
        && (record.emissiveGate ?? 1) >= 1
        && !record.paletteRamp
        && !record.flags
        && !record.depthKey
        && (record.footY ?? -1) === -1
        && !record.frontCornerX
        && (record.frontCornerY ?? -1) === -1
        && !record.ownerSlot
        && !record.landmarkId;
}

// One V9 instance at `byteOffset`; `tail` false stages the 48-byte head only.
// The float and uint16 views share one ArrayBuffer.
function writeGpuRecordInstance(f32, u16, byteOffset, record, tail) {
    const f = byteOffset >> 2;
    const sourceWidth = record.sourceWidth;
    const sourceHeight = record.sourceHeight;
    f32[f] = record.x;
    f32[f + 1] = record.y;
    f32[f + 2] = record.width;
    f32[f + 3] = record.height;
    f32[f + 4] = record.sx / sourceWidth;
    f32[f + 5] = record.sy / sourceHeight;
    f32[f + 6] = (record.sx + record.sw) / sourceWidth;
    f32[f + 7] = (record.sy + record.sh) / sourceHeight;
    f32[f + 8] = record.alpha;
    f32[f + 9] = record.material;
    f32[f + 10] = record.elevation;
    f32[f + 11] = record.emissive;
    if (!tail) return;
    const h = (byteOffset >> 1) + RECORD_HEAD_BYTES / 2;
    u16[h] = unitToUint16(record.occluder);
    u16[h + 1] = unitToUint16(record.emissiveGate ?? 1);
    u16[h + 2] = record.paletteRamp ? 1 : 0;
    u16[h + 3] = record.flags || 0;
    u16[h + 4] = record.depthKey || 0;
    u16[h + 5] = receiverToUint16(record.footY ?? -1);
    u16[h + 6] = receiverToUint16(record.frontCornerX ?? 0);
    u16[h + 7] = receiverToUint16(record.frontCornerY ?? -1);
    u16[h + 8] = record.ownerSlot || 0;
    u16[h + 9] = record.landmarkId || 0;
}

// The shared record vertex stage. The occlusion variant draws each batch's
// whole instance range and culls, here, the records that neither carry an
// occluder companion nor occlude (instead of staging them a second time).
function quadVertexSource({ occlusion = false } = {}) {
    return `#version 300 es
precision highp float;
precision highp int;
layout(location = 0) in vec4 a_rect;
layout(location = 1) in vec4 a_uvRect;
layout(location = 2) in vec4 a_surface;
layout(location = 3) in vec4 a_response;
layout(location = 4) in vec4 a_receiver;
layout(location = 5) in uvec2 a_identity;
uniform vec3 u_camera;
uniform vec2 u_resolution;
uniform sampler2D u_albedo;
${occlusion ? 'uniform bool u_batchOccluderSource;\n' : ''}out vec2 v_uv;
out vec2 v_world;
out float v_alpha;
out float v_material;
out float v_elevation;
out float v_emissive;
out float v_occluder;
out float v_gate;
out float v_ramp;
flat out vec2 v_originFrac;
flat out vec4 v_uvClamp;
flat out vec3 v_receiver;
flat out uvec2 v_identity;
flat out uint v_flags;
void main() {
    // Strip corners (0,0) (1,0) (0,1) (1,1). Each coordinate is selected from
    // the staged rect, never interpolated, so every edge is the staged value.
    bool right = (gl_VertexID & 1) == 1;
    bool bottom = gl_VertexID >= 2;
    vec2 world = vec2(right ? a_rect.x + a_rect.z : a_rect.x, bottom ? a_rect.y + a_rect.w : a_rect.y);
    uint flags = uint(a_response.w + 0.5);
    vec2 screen = (world + u_camera.xy) * u_camera.z;
    vec2 clip = vec2(
        screen.x / max(1.0, u_resolution.x) * 2.0 - 1.0,
        1.0 - screen.y / max(1.0, u_resolution.y) * 2.0
    );
    // 0.6 — the painter depth key (0 = far plane, 65535 = nearest).
    gl_Position = vec4(clip, (1.0 - a_receiver.x / 65535.0) * 2.0 - 1.0, 1.0);
${occlusion ? `    if (!u_batchOccluderSource && a_response.x <= 0.0 && a_surface.z <= 0.05) {
        gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    }
` : ''}    v_uv = vec2(right ? a_uvRect.z : a_uvRect.x, bottom ? a_uvRect.w : a_uvRect.y);
    v_world = world;
    v_alpha = a_surface.x;
    v_material = a_surface.y;
    v_elevation = a_surface.z;
    v_emissive = a_surface.w;
    v_occluder = a_response.x / 65535.0;
    v_gate = a_response.y / 65535.0;
    v_ramp = a_response.z;
    // PT-1 / M4 — a sprite record quantizes world-grid shading from its own
    // origin, so a body resting between world texels (the backing-pixel grid)
    // still lights in whole k x k blocks. Ground-self records (footY -1:
    // terrain, casts, marks, cues) and screen-space records keep the world grid.
    bool worldGrid = (flags & ${GPU_RECORD_FLAGS.screenSpace}u) != 0u || a_receiver.y == ${RECEIVER_BIAS - 1}.0;
    v_originFrac = worldGrid ? vec2(0.0) : fract(a_rect.xy);
    // The record-rect clamp: sampling never leaves the record's own source
    // rect (atlas neighbours), inset half a texel but never past its centre.
    vec2 uvLow = min(a_uvRect.xy, a_uvRect.zw);
    vec2 uvHigh = max(a_uvRect.xy, a_uvRect.zw);
    vec2 inset = min(0.5 / vec2(textureSize(u_albedo, 0)), (uvHigh - uvLow) * 0.5);
    v_uvClamp = vec4(uvLow + inset, uvHigh - inset);
    v_receiver = a_receiver.yzw - ${RECEIVER_BIAS}.0;
    v_identity = a_identity;
    v_flags = flags;
}`;
}

const QUAD_VERTEX = quadVertexSource();
const OCCLUSION_QUAD_VERTEX = quadVertexSource({ occlusion: true });
// 1.4 + 1.6 — the world-locked cloud-shadow courses and the screen-Y aerial
// haze, quantized on one art pixel `cell`: a sprite record's own texel grid
// (its V9 origin fraction), the world grid for ground records and particles.
// They ran in the composite on the world grid, which split a body resting
// between world texels into 2+1 px sub-blocks. Per record the maths is the
// same: the cloud course is a multiply and the haze an affine map, so painter
// blending of the premultiplied records lands on the composite's old result
// on the world grid. The haze reads its screen row at the cell centre
// (`cellCentreY`, top-left px), so a course never changes inside one texel.
// Additive records (the ground haze field) take the multiply and the haze's
// scale, never its colour lift.
const ATMOSPHERE_COURSES_GLSL = `
uniform sampler2D u_cloudTile;
// xy: world-space drift offset (world px), z: darkening per course (0 = off).
uniform vec4 u_cloud;
// Noise thresholds for course 1/2/3 at the current cover.
uniform vec3 u_cloudThresholds;
// rgb: C2 horizon haze, a: strength at the top of the frame (0 = off).
uniform vec4 u_haze;
vec3 applyAtmosphereCourses(vec3 color, vec2 cell, float order, float cellCentreY, bool additive) {
    if (u_cloud.z > 0.0) {
        vec2 cloudUv = fract((cell + 0.5 + u_cloud.xy) / ${CLOUD_TILE_WORLD_SCALE.toFixed(1)} / ${CLOUD_TILE_SIZE.toFixed(1)});
        float n = texture(u_cloudTile, cloudUv).r + (order - 0.5) * 0.018;
        float course = step(u_cloudThresholds.x, n) + step(u_cloudThresholds.y, n) + step(u_cloudThresholds.z, n);
        // Slightly cool shade: blue loses less than red.
        color *= vec3(1.0) - course * u_cloud.z * vec3(1.0, 0.96, 0.84);
    }
    if (u_haze.a > 0.0) {
        float yTop = cellCentreY / max(1.0, u_resolution.y);
        float haze = pow(clamp((0.55 - yTop) / 0.55, 0.0, 1.0), 1.4) * u_haze.a;
        haze = floor(haze * 48.0 + order) / 48.0;
        if (haze > 0.0) {
            float l = dot(color, vec3(0.2126, 0.7152, 0.0722));
            color = mix(color, mix(vec3(l), color, 0.8), min(1.0, haze * 8.0));
            color = additive ? color * (1.0 - haze) : mix(color, u_haze.rgb, haze);
        }
    }
    return color;
}`;
const ATMOSPHERE_COURSE_UNIFORM_NAMES = ['u_cloudTile', 'u_cloud', 'u_cloudThresholds', 'u_haze'];

const SCENE_FRAGMENT = `#version 300 es
precision highp float;
in vec2 v_uv;
in vec2 v_world;
in float v_alpha;
in float v_material;
in float v_elevation;
in float v_emissive;
in float v_gate;
in float v_ramp;
// V9 per-record values, flat: the record's origin fraction (sprite-origin
// shading grid), its source-rect clamp, receiver geometry (footY,
// frontCornerX, frontCornerY; integer world px, -1 = none/ground self),
// identity (ownerSlot, landmarkId) and flag bits.
flat in vec2 v_originFrac;
flat in vec4 v_uvClamp;
flat in vec3 v_receiver;
flat in uvec2 v_identity;
flat in uint v_flags;
layout(location = 0) out vec4 outColor;
layout(location = 1) out vec4 outEmission;
uniform sampler2D u_albedo;
uniform sampler2D u_materialMap;
uniform sampler2D u_emissiveMap;
uniform sampler2D u_occlusion;
uniform bool u_hasMaterialMap;
uniform sampler2D u_occluderMap;
uniform bool u_hasOccluderMap;
uniform bool u_hasEmissiveMap;
uniform vec2 u_resolution;
uniform vec2 u_occlusionResolution;
// The vertex stage's camera, read here to snap light pools to art pixels.
uniform vec3 u_camera;
uniform vec3 u_fogColor;
uniform vec4 u_weather;
// xy: iso sun direction, z: warmth, w: C2 sun-band share (0 at night and
// under overcast, so lit faces stop reading sunny).
uniform vec4 u_sun;
// C2 overcast flattening (cloudCover 0.7 -> 0.9): calms water shimmer.
uniform float u_overcast;
// Additive batches (the ground haze field) are graded without the lift so a
// full-viewport field never lifts the void.
uniform bool u_additive;
uniform float u_time;
uniform float u_motionScale;
uniform bool u_useOcclusion;
uniform int u_lightCount;
uniform vec4 u_lights[32];
uniform vec4 u_lightColors[32];
// 3.1 — the emissive-core share of the shared source-energy envelope. The
// spill/reflection share rides each light's own alpha channel (staged on the
// CPU) so action-needed overlays stay outside this budget, and the bloom share
// is applied once in the composite. One envelope, three consumers.
uniform float u_coreEnergy;
// 3.4 — reviewed night fill (0 outside night). Only the FULL water silver
// course reads it in the scene pass; the ambient course is a grade selection.
uniform float u_moonFill;
uniform bool u_waterSilver;
// 3.4 — water mood (x: night, y: storm), CoastBake.waterMoodFor: night sits
// shallow water below lit ground in value, storm reads grey-green. The
// terrain bake stays phase-free; this recolour is the only time-of-day term.
uniform vec2 u_waterMood;
// 3.2 — accumulated surface wetness from real precipitation history, and how
// many admitted sources may carry a wet reflection at this ladder level.
uniform float u_wetness;
uniform int u_wetReflectionCount;
// 3.5 — authored palette ramp for the Command pilot. 11 px wide (material
// class id) x 3 px tall (course: barely lit / mid / light). RGB is a tint
// multiplier encoded as texel * 2 (0.5 = x1.0), A an authored additive lift
// scaled by PALETTE_LUT_LIFT. Nearest-sampled; absent table = today response.
uniform sampler2D u_paletteLut;
uniform bool u_hasPaletteLut;
// Action-needed lights are outside the exposure budget and outside the ramp:
// bit i is set when admitted light i is an attention source.
uniform uint u_attentionMask;
// 3.2 — bit i is set when admitted light i lays a wet-ground reflection: the
// first u_wetReflectionCount non-attention lights in admission order.
uniform uint u_wetMask;

float materialNear(float value, float target) {
    return 1.0 - step(0.45, abs(value - target));
}

float occlusionBetween(vec2 fromPx, vec2 toPx, float elevation) {
    vec2 fromUv = fromPx / max(vec2(1.0), u_resolution);
    vec2 toUv = toPx / max(vec2(1.0), u_resolution);
    float blocked = 0.0;
    // Three samples keep the stepped pixel-art shadow read while avoiding the
    // previous five texture fetches for every admitted light and scene pixel.
    for (int stepIndex = 1; stepIndex <= 3; stepIndex++) {
        float t = float(stepIndex) / 4.0;
        vec2 uv = mix(fromUv, toUv, t);
        vec4 occluder = texture(u_occlusion, clamp(uv, vec2(0.0), vec2(1.0)));
        // Treat the light as ground-level and descend the receiver-to-light
        // ray through the existing three samples. A short occluder can then
        // block a low receiver without incorrectly shadowing a taller one.
        float rayHeight = mix(elevation, 0.0, t);
        float heightBlock = smoothstep(rayHeight + 0.03, rayHeight + 0.18, occluder.r);
        blocked = max(blocked, heightBlock * occluder.a);
    }
    return blocked;
}

${glslMaterialWeatherFunctions()}
${GRADE_GLSL}
${ATMOSPHERE_COURSES_GLSL}

float orderedDither4(vec2 px) {
    return mod(floor(px.x) + 2.0 * floor(px.y), 4.0) / 3.0;
}

float bayer2(vec2 a) {
    a = floor(a);
    return fract(dot(a, vec2(0.5, a.y * 0.75)));
}

// 4x4 ordered threshold in [0, 1) on whatever grid p is on.
float bayer4(vec2 p) {
    return bayer2(0.5 * p) * 0.25 + bayer2(p);
}

vec3 applyMaterialWeather(vec3 color, float material, vec2 px) {
    float rain = u_weather.x;
    float wetness = materialWetness(material);
    float reflection = materialReflection(material);
    float foliage = materialNear(material, 4.0);
    float phase = u_motionScale <= 0.0 ? 0.37 : u_time * 0.001 * u_motionScale;
    float ordered = orderedDither4(px);
    // 3.2 — darkening follows the accumulated surface wetness, not just live
    // precipitation, so a street stays wet as the rain stops and MINIMAL (with
    // weather amplitude shed) still shows the static wet course.
    float wet = max(rain, u_wetness) * wetness;
    color *= mix(1.0, 0.80, wet);
    color = mix(color, color * vec3(0.82, 0.94, 1.08), wet * 0.24);
    // Where an admitted source reflection carries the read, the anonymous
    // glint noise steps aside instead of competing with it.
    float glintShare = u_wetReflectionCount > 0 ? 0.30 : 1.0;
    float glint = step(0.86, fract((px.x + px.y * 0.5) * 0.031 + phase * 0.07 + ordered * 0.08));
    color += vec3(0.22, 0.30, 0.34) * glint * wet * reflection * 0.16 * glintShare;
    color = mix(color, color * vec3(0.86, 0.94, 0.82), rain * foliage * 0.12);
    return color;
}

// CPU mirror: CoastBake.applyWaterMood (the Canvas twin and the outer ocean).
vec3 applyWaterMood(vec3 color) {
    if (u_waterMood.y > 0.0) {
        float l = dot(color, vec3(0.2126, 0.7152, 0.0722));
        color = mix(color, l * vec3(0.90, 1.04, 0.97), u_waterMood.y * 0.72);
    }
    if (u_waterMood.x > 0.0) {
        float l = dot(color, vec3(0.2126, 0.7152, 0.0722));
        color = mix(color, l * vec3(0.78, 0.94, 1.10), u_waterMood.x * 0.55);
        color *= 1.0 - u_waterMood.x * 0.2;
    }
    return clamp(color, 0.0, 1.0);
}

vec3 applyWaterState(vec3 color, vec2 px) {
    // The material map is quarter resolution: a coast block can hold sand or
    // foam pixels. Water stops are teal/blue-dominant; anything else keeps
    // its land response.
    if (color.b < color.r + 0.02 || color.g < color.r) return color;
    // The baked depth stop, read from its (day) value before the mood.
    float depthLuma = dot(color, vec3(0.2126, 0.7152, 0.0722));
    color = applyWaterMood(color);
    float phase = u_motionScale <= 0.0 ? 0.0 : floor(u_time * 0.004 * u_motionScale);
    float storm = step(0.5, u_weather.z);
    // 3.4 — sparse 2:1 ripple dashes, never a lattice: each 8x4 world-px
    // cell (6x3 in a storm) may hold one 3x1 dash, and a dash is lit on one
    // palette-cycle phase in four. Stop interiors stay flat between them;
    // reduced motion freezes the phase.
    vec2 cellSize = mix(vec2(8.0, 4.0), vec2(6.0, 3.0), storm);
    vec2 cell = floor(px / cellSize);
    vec2 local = floor(px) - cell * cellSize;
    float seed = fract(sin(dot(cell, vec2(12.9898, 78.233))) * 43758.5453);
    float dashX = floor(seed * (cellSize.x - 2.0));
    float dashY = floor(fract(seed * 7.13) * cellSize.y);
    float present = step(fract(seed * 31.7), mix(0.30, 0.55, storm));
    float onDash = present * step(dashX, local.x) * step(local.x, dashX + 2.0) * (1.0 - step(0.5, abs(local.y - dashY)));
    float lit = 1.0 - step(0.5, mod(floor(seed * 4.0) + phase, 4.0));
    float contrast = mix(0.10, 0.16, storm);
    // An overcast sky has no sun sparkle; storm chop keeps its dashes.
    contrast = mix(contrast, min(contrast, 0.06), u_overcast * (1.0 - storm));
    // 3.4 — deep water is calm: the dashes fade with the baked depth stop,
    // so the deepest stop meets the flat outer ocean seamlessly and the
    // shallows carry the sparkle.
    contrast *= clamp((depthLuma - 0.27) / 0.15, mix(0.15, 0.35, storm), 1.0);
    // The time-of-day hue is the C2 grade's job; water keeps a light cool
    // cast (CPU mirror: CoastBake WATER_CAST).
    vec3 tinted = color * vec3(0.94, 0.98, 1.03) * (1.0 + contrast * onDash * lit);
    // 3.4 — FULL only, bright moon only: every dash turns silver at once, a
    // moonlit path of the same marks. A new-moon night never receives it.
    if (u_waterSilver && u_moonFill >= 0.5) {
        tinted = mix(tinted, tinted * vec3(1.10, 1.14, 1.20), onDash * 0.5);
    }
    return tinted;
}

vec3 applyAuthoredSunBand(vec3 color, float material) {
    float response = 0.36;
    response = mix(response, 0.62, materialNear(material, 1.0));
    response = mix(response, 0.48, materialNear(material, 2.0));
    response = mix(response, 0.82, materialNear(material, 3.0));
    response = mix(response, 0.56, materialNear(material, 4.0));
    response = mix(response, 0.42, materialNear(material, 5.0));
    response = mix(response, 0.58, materialNear(material, 7.0));
    response = mix(response, 0.24, materialNear(material, 8.0));
    float keyFacing = clamp(0.5 + (-u_sun.x - u_sun.y) * 0.25, 0.0, 1.0);
    float rawBand = 0.84 + response * (0.12 + keyFacing * 0.12);
    // Two restrained material-wide bands preserve the baked upper-left key.
    float quantized = rawBand < 0.93 ? 0.86 : 1.0;
    return color * mix(1.0, quantized, clamp(u_sun.w, 0.0, 1.0));
}

void main() {
    // V9 — sample inside the record's own source rect (never an atlas
    // neighbour), whatever sub-texel offset the record rests at.
    vec2 uv = clamp(v_uv, v_uvClamp.xy, v_uvClamp.zw);
    vec4 albedo = texture(u_albedo, uv);
    float alpha = albedo.a * v_alpha;
    if (alpha < 0.01) discard;
    vec4 sidecar = u_hasMaterialMap ? texture(u_materialMap, uv) : vec4(0.0);
    vec4 authoredEmission = u_hasEmissiveMap ? texture(u_emissiveMap, uv) : vec4(0.0);
    float material = sidecar.a > 0.0 ? floor(sidecar.r * 255.0 + 0.5) : v_material;
    float emissive = max(v_emissive, sidecar.g * 2.0);
    vec3 emissionColor = albedo.rgb;
    if (u_hasEmissiveMap) {
        // The emissive channel owns both hue (RGB) and contribution (A). Do
        // not reconstruct authored emission from the albedo texture.
        emissionColor = authoredEmission.rgb;
        emissive = authoredEmission.a * 2.0 * clamp(v_gate, 0.0, 1.0);
    } else if (u_hasMaterialMap) {
        // A material map without an authored emissive channel is explicitly
        // non-emissive; never infer a glow from its albedo pixels.
        emissionColor = vec3(0.0);
        emissive = 0.0;
    }
    // 3.1 — the reviewed emissive-core share replaces the old continuous
    // ambient ramp: authored emitters stay identifiable by day and reach full
    // energy once the exposure envelope says the village needs them.
    emissive *= u_coreEnergy;
    vec4 geometry = u_hasOccluderMap ? texture(u_occluderMap, uv) : vec4(0.0);
    float elevation = geometry.a > 0.0 ? geometry.r : v_elevation;
    vec2 px = vec2(gl_FragCoord.x, u_resolution.y - gl_FragCoord.y);
    vec2 glPx = gl_FragCoord.xy;
    vec3 color = albedo.rgb;
    // Clear weather is the overwhelmingly common case. Avoid the ordered
    // glint/material classification work when every weather contribution is
    // mathematically zero; rainy output remains byte-for-byte equivalent.
    // Water is never "wet": its storm/rain look is the water mood (mirrored
    // by the outer ocean), so the island's sea and the ocean stay one value.
    bool waterMaterial = materialNear(material, 8.0) > 0.5;
    if (!waterMaterial && (u_weather.x > 0.001 || u_wetness > 0.001)) color = applyMaterialWeather(color, material, v_world);
    if (waterMaterial) color = applyWaterState(color, v_world);
    color = applyAuthoredSunBand(color, material);
    // 1.2 — the pools light the ungraded surface, so warm light shows the real
    // cobble, grass and wall texture instead of a desaturated night albedo.
    vec3 poolAlbedo = color;
    // 1.1 — C2 time-of-day and weather grade, before any local light or
    // authored emission.
    color = applyTimeGrade(color, !u_additive);
    // V6 — graded water stays quiet at every hour (CoastBake's outer ocean
    // takes the same cap, so the two still meet without a seam).
    if (waterMaterial) color = capSaturation(color, WATER_MAX_SATURATION);
    color = applyGradeVignette(color, px, u_resolution);
    // 1.3 — emitters keep their own light: a lit authored-emitter pixel skips
    // the grade in proportion to its lit contribution (emissive already
    // carries the occupancy gate and the core energy), so the night Purkinje
    // target and highlight tint no longer turn yellow glass lime or dull the
    // Forge fire, and an unlit or daytime window grades like any wall.
    float emitterWeight = u_hasEmissiveMap ? clamp(emissive, 0.0, 1.0) : 0.0;
    color = mix(color, poolAlbedo, emitterWeight);
    // V5 — the receiver knee's floor: the graded value before any local light.
    float receiverLuma = dot(color, GRADE_LUMA);

    // 3.2 — the approved wet receiver is classified lazily: only a fragment
    // that a reflecting source actually reaches pays for the classification,
    // so an unlit street costs nothing. Water keeps its own reflection course;
    // timber, fabric and foliage never carry a source reflection.
    float wetReceiver = -1.0;
    float waterReceiver = materialNear(material, 8.0);
    // 3.5 — a pilot pixel collects the admitted light as one scalar instead of
    // adding it toward white; the authored ramp then decides what that much
    // light does to this material.
    bool rampPixel = u_hasPaletteLut && v_ramp > 0.5;
    float admitted = 0.0;
    // 1.2 — ambient light pools: each light is stepped on its own falloff
    // (poolSteps), accumulated, and lands once after the loop. Distances are
    // measured from the art-pixel centre so course edges sit on the world
    // texel grid, in iso ground space (screen y doubled): a pool is a 2:1
    // ellipse on the ground, and a wall or figure above the light's ground
    // line gets a short wash, never a camera-facing disc.
    vec3 poolLight = vec3(0.0);
    float poolDepth = 0.0;
    // V5 — water and wet-ground reflections accumulate apart from the graded
    // colour and land through the same receiver knee as the pools.
    vec3 reflectionLight = vec3(0.0);
    // Action-needed lights take the same stepped courses, but the strongest
    // one at the pixel wins instead of summing: a crowd of waiting agents
    // reads as one warm ground course under the bodies, never a bloom that
    // washes them out. Their beacon and plate carry the salience.
    vec3 attentionLight = vec3(0.0);
    float attentionLuma = 0.0;
    float attentionDepth = 0.0;
    // PT-1 — courses quantize on the record's own texel grid (its origin
    // fraction; 0 for ground and screen-space records), so a sprite resting
    // between world texels still lights in whole k x k blocks.
    vec2 artCell = floor(v_world - v_originFrac);
    float poolOrder = bayer4(artCell);
    vec2 artTopLeftPx = (artCell + v_originFrac + 0.5 + u_camera.xy) * u_camera.z;
    vec2 poolPx = vec2(artTopLeftPx.x, u_resolution.y - artTopLeftPx.y);
    for (int i = 0; i < 32; i++) {
        if (i >= u_lightCount) break;
        vec4 light = u_lights[i];
        float radius = max(1.0, light.z);
        float distanceToLight = distance(glPx, light.xy);
        if (distanceToLight >= radius + u_camera.z) continue;
        bool attention = (u_attentionMask & (1u << uint(i))) != 0u;
        vec2 isoDelta = (poolPx - light.xy) * vec2(1.0, 2.0);
        float falloff = 1.0 - smoothstep(0.0, radius, length(isoDelta));
        float blocked = u_useOcclusion ? occlusionBetween(glPx, light.xy, elevation) : 0.0;
        float shape = falloff * (1.0 - blocked * 0.88);
        if (attention) {
            // Outside the exposure budget (colour alpha is 1), inside the
            // courses; no water or wet reflection streak.
            float steps = poolSteps(shape, poolOrder);
            vec3 lit = u_lightColors[i].rgb * poolWeight(steps) * light.w * u_lightColors[i].a;
            float litLuma = dot(lit, GRADE_LUMA);
            if (litLuma > attentionLuma) {
                attentionLight = lit;
                attentionLuma = litLuma;
            }
            attentionDepth = max(attentionDepth, steps);
            continue;
        }
        float amount = shape * light.w;
        if (rampPixel) {
            admitted += amount * u_lightColors[i].a;
        } else {
            float steps = poolSteps(shape, poolOrder);
            poolLight += u_lightColors[i].rgb * poolWeight(steps) * light.w * u_lightColors[i].a;
            poolDepth = max(poolDepth, steps);
        }
        float reflectionX = 1.0 - smoothstep(0.0, radius * 0.30, abs(glPx.x - light.x));
        float reflectionY = 1.0 - smoothstep(0.0, radius * 1.70, abs(glPx.y - light.y));
        float reflectionCourse = step(0.52, fract((floor(v_world.x) + floor(v_world.y) * 0.5) * 0.125));
        reflectionLight += u_lightColors[i].rgb * waterReceiver * reflectionX * reflectionY
            * reflectionCourse * light.w * u_lightColors[i].a * 0.10;
        // The source's own hue lies in a world-space downward footprint below
        // the lantern or window, broken on the world grid and clipped by the
        // same occluders as its direct light, so it never crosses a roof.
        // Action-needed lights never spend one of these slots (u_wetMask).
        if ((u_wetMask & (1u << uint(i))) != 0u) {
            if (wetReceiver < 0.0) {
                wetReceiver = max(
                    materialNear(material, 7.0),
                    max(materialNear(material, 1.0), materialNear(material, 6.0))
                ) * u_wetness * materialWetness(material);
            }
            if (wetReceiver > 0.01) {
                float drop = light.y - glPx.y;
                float footprint = step(0.0, drop) * (1.0 - smoothstep(0.0, radius * 1.30, drop));
                float lateral = 1.0 - smoothstep(0.0, radius * 0.26, abs(glPx.x - light.x));
                float wetCourse = step(0.55, fract((floor(v_world.x) + floor(v_world.y) * 0.5) * 0.125 + 0.37));
                reflectionLight += u_lightColors[i].rgb * wetReceiver * footprint * lateral * wetCourse
                    * light.w * u_lightColors[i].a * (1.0 - blocked) * 0.22;
            }
        }
    }
    // 3.5 — two reviewed thresholds pick the dark / mid / light course. The
    // ramp multiplies the authored albedo and adds one authored lift, so slate
    // stays slate and gold reaches its own highlight instead of bleaching. The
    // ramp light and the pilot's reflections land through the receiver knee.
    if (rampPixel && admitted > 0.0) {
        float course = step(0.14, admitted) + step(0.45, admitted);
        vec4 ramp = texture(u_paletteLut, vec2(
            (material + 0.5) / 11.0,
            (course + 0.5) / 3.0
        ));
        color = receiverKnee(
            color * (ramp.rgb * 2.0) + vec3(ramp.a * 0.25) * step(0.14, admitted) + reflectionLight,
            receiverLuma
        );
        reflectionLight = vec3(0.0);
    }
    // 1.2 / V5 — the pools land once, stepped, multiplying the ungraded
    // albedo: ambient pools and reflections under the receiver knee, the
    // strongest action-needed course added outside it.
    color = stepPool(color, poolLight, poolDepth, attentionLight, attentionDepth, poolAlbedo, reflectionLight);

    float fog = clamp(u_weather.y, 0.0, 1.0);
    float groundFog = fog * (1.0 - elevation * 0.72) * smoothstep(0.18, 0.98, gl_FragCoord.y / max(1.0, u_resolution.y));
    // Fog veils toward the C2 haze colour but may raise a pixel's luma by at
    // most 0.06: storm fog no longer lifts the blacks.
    vec3 fogged = mix(color, u_fogColor, groundFog * 0.48);
    float fogRise = dot(fogged - color, GRADE_LUMA);
    if (fogRise > 0.06) fogged = mix(color, fogged, 0.06 / fogRise);
    color = fogged;
    vec3 emission = emissionColor * emissive;
    color += emission * 0.42;
    // 1.3 — hue-preserving protection after emission: a lit emitter pushed
    // past 1 scales down on its brightest channel instead of clipping toward
    // cream or a flat hue.
    color /= max(1.0, max(color.r, max(color.g, color.b)));
    // 1.4 + 1.6 — cloud courses and aerial haze on this record's own grid.
    color = applyAtmosphereCourses(color, artCell, poolOrder, artTopLeftPx.y, u_additive);
    outColor = vec4(max(color, vec3(0.0)) * alpha, alpha);
    outEmission = vec4(emission * alpha, alpha > 0.0 ? 1.0 : 0.0);
}`;

const OCCLUSION_FRAGMENT = `#version 300 es
precision highp float;
in vec2 v_uv;
flat in vec4 v_uvClamp;
in float v_alpha;
in float v_elevation;
uniform sampler2D u_albedo;
uniform sampler2D u_materialMap;
uniform bool u_hasMaterialMap;
uniform sampler2D u_occluderMap;
uniform bool u_hasOccluderMap;
in float v_occluder;
layout(location = 0) out vec4 outColor;
void main() {
    vec2 uv = clamp(v_uv, v_uvClamp.xy, v_uvClamp.zw);
    float alpha = texture(u_albedo, uv).a * v_alpha;
    if (alpha < 0.05) discard;
    vec4 sidecar = u_hasMaterialMap ? texture(u_materialMap, uv) : vec4(0.0);
    // Height and strength are independent: authored strength attenuates the
    // trace in the target alpha channel and never lowers the height itself.
    vec4 geometry = u_hasOccluderMap ? texture(u_occluderMap, uv) : vec4(0.0);
    float height = geometry.a > 0.0 ? geometry.r : v_elevation;
    float strength = geometry.a > 0.0 ? geometry.g : v_occluder;
    outColor = vec4(height * alpha, 0.0, 0.0, strength * alpha);
}`;

const FULLSCREEN_VERTEX = `#version 300 es
precision highp float;
const vec2 POS[3] = vec2[](vec2(-1.0,-1.0), vec2(3.0,-1.0), vec2(-1.0,3.0));
const vec2 UV[3] = vec2[](vec2(0.0,0.0), vec2(2.0,0.0), vec2(0.0,2.0));
out vec2 v_uv;
void main() {
    gl_Position = vec4(POS[gl_VertexID], 0.0, 1.0);
    v_uv = UV[gl_VertexID];
}`;

const BLOOM_FRAGMENT = `#version 300 es
precision highp float;
in vec2 v_uv;
layout(location = 0) out vec4 outColor;
uniform sampler2D u_input;
uniform vec2 u_texel;
uniform bool u_blur;
vec4 sampleAt(vec2 uv) { return texture(u_input, clamp(uv, vec2(0.0), vec2(1.0))); }
void main() {
    if (!u_blur) {
        vec4 sum = vec4(0.0);
        for (int x = -1; x <= 1; x++) {
            for (int y = -1; y <= 1; y++) {
                sum += sampleAt(v_uv + vec2(float(x), float(y)) * u_texel * 2.0);
            }
        }
        outColor = sum / 9.0;
        return;
    }
    vec4 sum = sampleAt(v_uv) * 0.20;
    sum += sampleAt(v_uv + vec2( 1.0, 1.0) * u_texel * 2.0) * 0.20;
    sum += sampleAt(v_uv + vec2(-1.0, 1.0) * u_texel * 2.0) * 0.20;
    sum += sampleAt(v_uv + vec2( 1.0,-1.0) * u_texel * 2.0) * 0.20;
    sum += sampleAt(v_uv + vec2(-1.0,-1.0) * u_texel * 2.0) * 0.20;
    outColor = sum;
}`;

const COMPOSITE_FRAGMENT = `#version 300 es
precision highp float;
in vec2 v_uv;
layout(location = 0) out vec4 outColor;
uniform sampler2D u_scene;
uniform sampler2D u_bloom;
uniform float u_bloomStrength;
// 0.10 — the lightning flash as an exposure step: the island is multiplied by
// (1 + u_flash) per channel, the same scale the 2D backdrop takes (0 = none).
// The cloud courses and aerial haze are shaded per record
// (ATMOSPHERE_COURSES_GLSL), on each record's own texel grid.
uniform vec3 u_flash;
void main() {
    vec4 scene = texture(u_scene, clamp(v_uv, vec2(0.0), vec2(1.0)));
    vec3 bloom = texture(u_bloom, clamp(v_uv, vec2(0.0), vec2(1.0))).rgb;
    vec3 color = scene.rgb;
    color *= vec3(1.0) + u_flash;
    outColor = vec4(color + bloom * u_bloomStrength, scene.a);
}`;

// 0.6 — one instanced draw for every live world particle, after the record
// loop, depth-tested LEQUAL against the painter depth the sprite records
// wrote (and never writing it): a particle behind a nearer building front or
// body is hidden, one at or in front of its owner shows. Instances are laid
// out by GpuWorldPolicy (GPU_PARTICLE_INSTANCE_BYTES) and packed by
// ParticleSystem.packGpuInstances with the Canvas Particle.draw geometry, so
// both backends cut the same whole-texel rects.
const PARTICLE_VERTEX = `#version 300 es
precision highp float;
precision highp int;
layout(location = 0) in vec4 a_rect;
layout(location = 1) in float a_depthKey;
layout(location = 2) in vec4 a_color;
layout(location = 3) in uvec4 a_shape;
uniform vec3 u_camera;
uniform vec2 u_resolution;
out vec2 v_local;
out vec2 v_world;
flat out vec4 v_color;
flat out uvec4 v_shape;
flat out ivec2 v_size;
void main() {
    vec2 corner = vec2((gl_VertexID & 1) == 1 ? 1.0 : 0.0, gl_VertexID >= 2 ? 1.0 : 0.0);
    vec2 world = a_rect.xy + corner * a_rect.zw;
    vec2 screen = (world + u_camera.xy) * u_camera.z;
    vec2 clip = vec2(
        screen.x / max(1.0, u_resolution.x) * 2.0 - 1.0,
        1.0 - screen.y / max(1.0, u_resolution.y) * 2.0
    );
    gl_Position = vec4(clip, (1.0 - a_depthKey / 65535.0) * 2.0 - 1.0, 1.0);
    v_local = corner * a_rect.zw;
    v_world = world;
    v_color = a_color;
    v_shape = a_shape;
    v_size = ivec2(a_rect.zw + 0.5);
}`;

const PARTICLE_FRAGMENT = `#version 300 es
precision highp float;
precision highp int;
in vec2 v_local;
in vec2 v_world;
flat in vec4 v_color;
flat in uvec4 v_shape;
flat in ivec2 v_size;
layout(location = 0) out vec4 outColor;
layout(location = 1) out vec4 outEmission;
uniform sampler2D u_motifs;
uniform vec2 u_resolution;
uniform vec3 u_camera;
uniform float u_coreEnergy;
${GRADE_GLSL}
${ATMOSPHERE_COURSES_GLSL}
float bayer2(vec2 a) {
    a = floor(a);
    return fract(dot(a, vec2(0.5, a.y * 0.75)));
}
float bayer4(vec2 p) {
    return bayer2(0.5 * p) * 0.25 + bayer2(p);
}
void main() {
    ivec2 cell = clamp(ivec2(floor(v_local)), ivec2(0), v_size - 1);
    vec3 rgb = v_color.rgb;
    uint shape = v_shape.x;
    if (shape == ${GPU_PARTICLE_SHAPES.blob}u) {
        // A puff, not a tile: the four corner texels drop out.
        bool edgeX = cell.x == 0 || cell.x == v_size.x - 1;
        bool edgeY = cell.y == 0 || cell.y == v_size.y - 1;
        if (edgeX && edgeY) discard;
    } else if (shape == ${GPU_PARTICLE_SHAPES.wings}u) {
        // Two wing rects about a 1-texel body at half the wing's own value.
        if (cell.x == (v_size.x - 1) / 2) rgb = floor(floor(rgb * 255.0 + 0.5) * 0.5) / 255.0;
    } else if (shape == ${GPU_PARTICLE_SHAPES.motif}u) {
        ivec2 texel = ivec2(cell.x, int(v_shape.z) * ${GPU_PARTICLE_MOTIF_SIZE} + cell.y);
        if (texelFetch(u_motifs, texel, 0).r < 0.5) discard;
    }
    float alpha = v_color.a;
    if ((v_shape.y & ${GPU_PARTICLE_FLAGS.graded}u) != 0u) {
        // Matter (dust, smoke, leaves) takes the frame's C2 grade.
        vec2 px = vec2(gl_FragCoord.x, u_resolution.y - gl_FragCoord.y);
        rgb = applyGradeVignette(applyTimeGrade(rgb, true), px, u_resolution);
    }
    // Light (embers, sparks, motes) keeps its colour and feeds bloom; its
    // emission alpha is its own coverage, so a fading spark never punches a
    // hole in the halo beneath it.
    vec3 emission = (v_shape.y & ${GPU_PARTICLE_FLAGS.emits}u) != 0u
        ? rgb * ${PARTICLE_EMISSION.toFixed(2)} * u_coreEnergy
        : vec3(0.0);
    // 1.4 + 1.6 — cloud courses and aerial haze on the world grid (colour
    // only; the bloom share above stays unshaded, as it was in the composite).
    vec2 artCell = floor(v_world);
    vec3 shaded = applyAtmosphereCourses(rgb, artCell, bayer4(artCell), (artCell.y + 0.5 + u_camera.y) * u_camera.z, false);
    outColor = vec4(shaded * alpha, alpha);
    outEmission = vec4(emission * alpha, alpha);
}`;

function finite(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function ema(previous, sample) {
    const value = Math.max(0, finite(sample));
    return previous == null ? value : previous + (value - previous) * EMA_ALPHA;
}

function compileShader(gl, type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        const message = gl.getShaderInfoLog(shader) || 'unknown shader error';
        gl.deleteShader(shader);
        throw new Error(message);
    }
    return shader;
}

function createProgram(gl, vertexSource, fragmentSource) {
    const vertex = compileShader(gl, gl.VERTEX_SHADER, vertexSource);
    const fragment = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
    const program = gl.createProgram();
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    gl.deleteShader(vertex);
    gl.deleteShader(fragment);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        const message = gl.getProgramInfoLog(program) || 'unknown program link error';
        gl.deleteProgram(program);
        throw new Error(message);
    }
    return program;
}

function uniformLocations(gl, program, names) {
    return names.reduce((out, name) => {
        out[name] = gl.getUniformLocation(program, name);
        return out;
    }, {});
}

function frameGrade(feed = {}) {
    return feed.atmosphere?.lightGrade || feed.lightGrade || NEUTRAL_GRADE;
}

// The baked field plus its sorted values, so a cover fraction maps to an
// exact noise threshold (the covered share of the ground equals the cover).
let _cloudTile = null;
function cloudTile() {
    if (_cloudTile) return _cloudTile;
    const data = buildCloudShadowTile(CLOUD_TILE_SIZE);
    const sorted = new Uint8Array(CLOUD_TILE_SIZE * CLOUD_TILE_SIZE);
    for (let index = 0; index < sorted.length; index++) sorted[index] = data[index * 4];
    sorted.sort();
    _cloudTile = { data, sorted };
    return _cloudTile;
}

function cloudThreshold(coveredShare) {
    const { sorted } = cloudTile();
    const index = Math.round(clamp(1 - coveredShare, 0, 1) * (sorted.length - 1));
    return sorted[index] / 255;
}

function weatherUniform(feed = {}) {
    const weather = feed.weather || feed.atmosphere?.weather || {};
    const type = String(weather.type || 'clear');
    const rainy = type === 'rain' || type === 'storm' || type === 'overcast';
    return [
        rainy ? clamp(finite(weather.precipitation, weather.intensity), 0, 1) : 0,
        clamp(finite(weather.fog, type === 'storm' ? 0.35 : 0), 0, 1),
        type === 'storm' ? 1 : 0,
        clamp(finite(weather.intensity), 0, 1),
    ];
}

export class GpuWorldRenderer {
    constructor(canvas, { enabled = true } = {}) {
        this.canvas = canvas || null;
        this.enabled = Boolean(enabled);
        this.supported = false;
        this.contextHealthy = false;
        this.disposed = false;
        this.suspended = false;
        this.width = Math.max(1, Math.floor(canvas?.width || 1));
        this.height = Math.max(1, Math.floor(canvas?.height || 1));
        this.frames = 0;
        this.records = 0;
        this.batches = 0;
        this.lightCount = 0;
        this.sourceEnergy = NEUTRAL_SOURCE_ENERGY;
        this.wetReflectionCount = 0;
        this.localLightPhase = 0;
        this.uploadMs = null;
        this.cpuMs = null;
        this.shaderCpuMs = null;
        this.gpuMs = null;
        this.timerExtension = null;
        this.pendingGpuQueries = [];
        this.passSamplingEnabled = false;
        this._passCursor = 0;
        this._sampledPass = null;
        this._activePassQuery = null;
        this.gpuDisjointDiscards = 0;
        this._passStarted = 0;
        this._passUploadBytes = 0;
        this._passResults = Object.fromEntries(GPU_PASS_NAMES.map(name => [name, {
            samples: new Array(PASS_RING_CAPACITY).fill(null),
            count: 0, next: 0, gpuSum: 0, gpuCount: 0, cpuSum: 0, latest: null,
        }]));
        this.qualityTimingSource = 'cpu-fallback';
        this._qualityTimingScratch = createGpuTimingMetricsScratch();
        this._qualityTimingInput = {
            uploadMs: 0,
            shaderCpuMs: 0,
            gpuMs: null,
            gpuTimerSupported: false,
            frameGapMs: 0,
        };
        this.gpuTimerErrors = 0;
        this.frameGapMs = null;
        this.uploads = 0;
        this.uploadBytes = 0;
        this.skippedOccluderUploads = 0;
        this.textureBytes = 0;
        this.textureEvictions = 0;
        // 0.1 — the pacing-true ladder. It boots at MINIMAL (shader compilation
        // and first-use uploads land together on a fresh context), latches the
        // display period from that warm-up, and climbs through pacing probes.
        // DISABLED would render MINIMAL's composition here, so pacing never
        // demotes past MINIMAL.
        this.qualityLadder = createPostFxLadder({ maxLevel: POST_FX_LEVELS.MINIMAL });
        this.qualityLadder.reset(POST_FX_LEVELS.MINIMAL);
        this.gpuMsP25 = null;
        this._gpuTimerRing = null;
        this._gpuTimerEvery = GPU_TIMER_EVERY;
        this._pendingPresentIntervalMs = null;
        this._presentIntervalsNoted = false;
        this._displayDpr = null;
        this._displayScreenWidth = 0;
        this._displayScreenHeight = 0;
        this._onVisibilityChange = () => {
            this._pendingPresentIntervalMs = null;
            this.qualityLadder.clearPacing();
        };
        this.lightAdmission = { cap: 0, admitted: 0, offered: 0, daylight: true };
        this._debugLoad = null;
        this._frameLoadPasses = 0;
        this._frameLoadArm = null;
        const debugParams = new URLSearchParams(globalThis.location?.search || '');
        const debugLoadPasses = Number(debugParams.get('gpuLoad'));
        if (debugLoadPasses > 0) {
            this.setDebugLoad({ passes: debugLoadPasses, levels: debugParams.get('gpuLoadLevels') || 'full' });
        }
        this._frameUploadMs = 0;
        this._lastRenderAtMs = null;
        this._textureEntries = new Map();
        this._cachedTextureBytes = 0;
        this._textureCacheNeedsTrim = false;
        this._lastTextureTrimFrame = 0;
        // V9 instance staging: one ArrayBuffer seen as float32 and uint16.
        this._instanceF32 = new Float32Array(64);
        this._instanceU16 = new Uint16Array(this._instanceF32.buffer);
        this._vertexScratchUsed = 0;
        this.vertexBufferBytes = 0;
        this._pointedInstance = -1;
        // 0.6 — the particle instance scratch (<= 240 x 28 B), written by
        // ParticleSystem.packGpuInstances through these views.
        this._particleBytes = new ArrayBuffer(MAX_PARTICLE_INSTANCES * GPU_PARTICLE_INSTANCE_BYTES);
        this._particleViews = {
            f32: new Float32Array(this._particleBytes),
            u16: new Uint16Array(this._particleBytes),
            u8: new Uint8Array(this._particleBytes),
            capacity: MAX_PARTICLE_INSTANCES,
        };
        this._particleCount = 0;
        this._particleMotifTexture = null;
        this.particleInstances = 0;
        this._batchScratch = [];
        this._normalizedRecordScratch = [];
        this._lightAdmissionCache = { source: null, sourceLength: 0, ranked: [], admitted: [], snapshots: [] };
        this._singleLightColorScratch = [0, 0, 0];
        this._lightScratch = new Float32Array(MAX_LIGHTS * 4);
        this._lightColorScratch = new Float32Array(MAX_LIGHTS * 4);
        this.cloudCourses = 0;
        this.aerialHaze = 0;
        this._occlusionRecords = [];
        this._occlusionBatch = {
            key: '',
            source: null,
            materialSource: null,
            emissiveSource: null,
            textureKey: '',
            sidecarKey: '',
            blend: 'normal',
            records: this._occlusionRecords,
        };
        this._sourceCensus = {
            atlasRecords: 0,
            individualRecords: 0,
            batchCount: 0,
            uploadBytes: 0,
        };
        this._renderErrorLogged = false;
        this._onContextLost = event => {
            event.preventDefault();
            this.contextHealthy = false;
            // A restored WebGL context has a new object namespace. Forget old
            // handles without deleting them; delete* on the restored context
            // produces INVALID_OPERATION warnings for every stale object.
            this._abandonGpuResources();
        };
        this._onContextRestored = () => {
            if (this.disposed) return;
            if (this.suspended) {
                this.contextHealthy = true;
                return;
            }
            try {
                this._initResources();
                this.resize(this.width, this.height);
                this.contextHealthy = true;
            } catch (error) {
                console.warn('[GpuWorldRenderer] context restore failed:', error);
                this.contextHealthy = false;
            }
        };

        if (!canvas?.getContext) return;
        canvas.addEventListener?.('webglcontextlost', this._onContextLost, false);
        canvas.addEventListener?.('webglcontextrestored', this._onContextRestored, false);
        try {
            this.gl = canvas.getContext('webgl2', {
                alpha: true,
                premultipliedAlpha: true,
                antialias: false,
                preserveDrawingBuffer: false,
            });
            if (!this.gl) return;
            this.supported = true;
            this.contextHealthy = true;
            this._initResources();
            this.resize(this.width, this.height);
        } catch (error) {
            console.warn('[GpuWorldRenderer] initialization failed:', error);
            this.contextHealthy = false;
        }
    }

    _initResources() {
        const gl = this.gl;
        this._releaseGpuResources();
        this.sceneProgram = createProgram(gl, QUAD_VERTEX, SCENE_FRAGMENT);
        this.occlusionProgram = createProgram(gl, OCCLUSION_QUAD_VERTEX, OCCLUSION_FRAGMENT);
        this.particleProgram = createProgram(gl, PARTICLE_VERTEX, PARTICLE_FRAGMENT);
        this.bloomProgram = createProgram(gl, FULLSCREEN_VERTEX, BLOOM_FRAGMENT);
        this.compositeProgram = createProgram(gl, FULLSCREEN_VERTEX, COMPOSITE_FRAGMENT);
        this.timerExtension = gl.getExtension?.('EXT_disjoint_timer_query_webgl2') || null;
        this.sceneUniforms = uniformLocations(gl, this.sceneProgram, [
            'u_camera', 'u_resolution', 'u_albedo', 'u_materialMap', 'u_emissiveMap', 'u_occlusion',
            'u_hasMaterialMap', 'u_occluderMap', 'u_hasOccluderMap', 'u_hasEmissiveMap', 'u_occlusionResolution',
            ...GRADE_UNIFORM_NAMES,
            'u_fogColor', 'u_weather', 'u_time', 'u_motionScale',
            'u_sun', 'u_overcast', 'u_additive',
            'u_lightCount', 'u_lights[0]', 'u_lightColors[0]',
            'u_useOcclusion', 'u_coreEnergy', 'u_moonFill', 'u_waterSilver', 'u_waterMood',
            'u_wetness', 'u_wetReflectionCount',
            'u_paletteLut', 'u_hasPaletteLut', 'u_attentionMask', 'u_wetMask',
            ...ATMOSPHERE_COURSE_UNIFORM_NAMES,
        ]);
        this.occlusionUniforms = uniformLocations(gl, this.occlusionProgram, [
            'u_camera', 'u_resolution', 'u_albedo', 'u_materialMap',
            'u_hasMaterialMap', 'u_occluderMap', 'u_hasOccluderMap', 'u_batchOccluderSource',
        ]);
        this.particleUniforms = uniformLocations(gl, this.particleProgram, [
            'u_camera', 'u_resolution', 'u_motifs', 'u_coreEnergy', ...GRADE_UNIFORM_NAMES,
            ...ATMOSPHERE_COURSE_UNIFORM_NAMES,
        ]);
        this.bloomUniforms = uniformLocations(gl, this.bloomProgram, ['u_input', 'u_texel', 'u_blur']);
        this.compositeUniforms = uniformLocations(gl, this.compositeProgram, [
            'u_scene', 'u_bloom', 'u_bloomStrength', 'u_flash',
        ]);
        // V9 record VAO: six instance attributes (divisor 1), re-pointed per
        // batch by `_pointRecordInstances`; the strip corner is gl_VertexID.
        this.vao = gl.createVertexArray();
        this.vertexBuffer = gl.createBuffer();
        gl.bindVertexArray(this.vao);
        for (let location = 0; location <= 5; location++) {
            gl.enableVertexAttribArray(location);
            gl.vertexAttribDivisor(location, 1);
        }
        gl.bindVertexArray(null);
        this._pointedInstance = -1;
        this._recordTailArrays = true;
        // 0.6 particle VAO: one static layout over its own small buffer.
        this.particleVao = gl.createVertexArray();
        this.particleBuffer = gl.createBuffer();
        gl.bindVertexArray(this.particleVao);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.particleBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, this._particleBytes.byteLength, gl.DYNAMIC_DRAW);
        const particleStride = GPU_PARTICLE_INSTANCE_BYTES;
        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(0, 4, gl.FLOAT, false, particleStride, 0);
        gl.enableVertexAttribArray(1);
        gl.vertexAttribPointer(1, 1, gl.UNSIGNED_SHORT, false, particleStride, 24);
        gl.enableVertexAttribArray(2);
        gl.vertexAttribPointer(2, 4, gl.UNSIGNED_BYTE, true, particleStride, 16);
        gl.enableVertexAttribArray(3);
        gl.vertexAttribIPointer(3, 4, gl.UNSIGNED_BYTE, particleStride, 20);
        for (let location = 0; location <= 3; location++) gl.vertexAttribDivisor(location, 1);
        gl.bindVertexArray(null);
        gl.bindBuffer(gl.ARRAY_BUFFER, null);
        this.emptyMaterialTexture = this._createTexture(1, 1, {
            data: new Uint8Array([0, 0, 0, 0]),
            filter: gl.NEAREST,
        });
        // 1.4 — the baked cloud field. Linear sampling of a smooth noise
        // value; the scene and particle programs quantize it into dithered
        // art-pixel courses on each record's own grid.
        this.cloudTileTexture = this._createTexture(CLOUD_TILE_SIZE, CLOUD_TILE_SIZE, {
            data: cloudTile().data,
            filter: gl.LINEAR,
        });
        gl.bindTexture(gl.TEXTURE_2D, this.cloudTileTexture);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
        gl.bindTexture(gl.TEXTURE_2D, null);
        this._textureEntries.clear();
    }

    // V9 typed-texture creation. `format` names a TEXTURE_FORMATS row: RGBA8
    // (targets, canvases), R8 / RG8 (masks and fields), R16UI (integer
    // indices, read through a usampler2D) and RGBA32F (data rows). Typed
    // fields upload with UNPACK_ALIGNMENT 1 and are read with texelFetch, so
    // they are always nearest-sampled; integer and float32 textures are not
    // filterable in WebGL2.
    _createTexture(width, height, { data = null, filter = null, format = 'rgba8' } = {}) {
        const gl = this.gl;
        const spec = TEXTURE_FORMATS[format];
        if (!spec) throw new Error(`unknown GPU texture format: ${format}`);
        const texture = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, texture);
        const sampling = format === 'rgba8' ? (filter ?? gl.NEAREST) : gl.NEAREST;
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, sampling);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, sampling);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        if (format !== 'rgba8') gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl[spec.internalFormat], width, height, 0,
            gl[spec.format], gl[spec.type], data);
        if (format !== 'rgba8') gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
        gl.bindTexture(gl.TEXTURE_2D, null);
        return texture;
    }

    /**
     * V9 typed-field upload, cached by key beside the canvas textures: `data`
     * is a typed array of `width x height` texels in `format` (`r8`, `rg8`,
     * `r16ui`, `rgba32f`; `rgba8` also accepted). Re-uploads only when the
     * revision or size changes (texSubImage2D when the size holds). The cache
     * counts its real bytes (width x height x bytesPerTexel), so the 48 MiB
     * ceiling and Shift-D see an R8 field at a quarter of an RGBA canvas.
     * Returns the texture, or null for an invalid field.
     */
    uploadTypedTexture(key, { width, height, format, data, revision = null } = {}) {
        const gl = this.gl;
        const spec = TEXTURE_FORMATS[format];
        const w = Math.floor(finite(width));
        const h = Math.floor(finite(height));
        const channels = spec ? spec.bytesPerTexel / spec.array.BYTES_PER_ELEMENT : 0;
        if (!gl || !spec || w <= 0 || h <= 0 || !(data instanceof spec.array) || data.length < w * h * channels) {
            return null;
        }
        const bytes = w * h * spec.bytesPerTexel;
        let entry = this._textureEntries.get(key);
        const storageChanged = !entry || entry.format !== format || entry.width !== w || entry.height !== h;
        if (!entry || entry.format !== format) {
            if (entry?.texture) gl.deleteTexture(entry.texture);
            this._cachedTextureBytes -= entry?.bytes || 0;
            entry = { texture: null, source: null, revision: null, width: 0, height: 0, bytes: 0, format };
            this._textureEntries.set(key, entry);
            this._textureCacheNeedsTrim = true;
        }
        if (storageChanged || entry.revision !== revision || entry.source !== data) {
            const started = performance.now();
            if (storageChanged) {
                if (entry.texture) gl.deleteTexture(entry.texture);
                entry.texture = this._createTexture(w, h, { data, format });
            } else {
                gl.bindTexture(gl.TEXTURE_2D, entry.texture);
                gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
                gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl[spec.format], gl[spec.type], data);
                gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
                gl.bindTexture(gl.TEXTURE_2D, null);
            }
            this._cachedTextureBytes += bytes - entry.bytes;
            entry.source = data;
            entry.revision = revision;
            entry.width = w;
            entry.height = h;
            entry.bytes = bytes;
            this.uploads++;
            this.uploadBytes += bytes;
            this._frameUploadMs += performance.now() - started;
            if (storageChanged) {
                this._textureCacheNeedsTrim = true;
                this._updateTextureBytes();
            }
        }
        entry.lastUsedFrame = this.frames + 1;
        return entry.texture;
    }

    _createTarget(width, height, { attachments = 1, filter = null, depth = false } = {}) {
        const gl = this.gl;
        const framebuffer = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
        const textures = [];
        const drawBuffers = [];
        for (let index = 0; index < attachments; index++) {
            const texture = this._createTexture(width, height, { filter });
            textures.push(texture);
            const attachment = gl.COLOR_ATTACHMENT0 + index;
            gl.framebufferTexture2D(gl.FRAMEBUFFER, attachment, gl.TEXTURE_2D, texture, 0);
            drawBuffers.push(attachment);
        }
        // 0.6 — the painter depth: a DEPTH_COMPONENT16 renderbuffer, written
        // by opaque sprite records and read (LEQUAL) by the particle draw, then
        // invalidated before the scene target is unbound.
        let depthBuffer = null;
        if (depth) {
            depthBuffer = gl.createRenderbuffer();
            gl.bindRenderbuffer(gl.RENDERBUFFER, depthBuffer);
            gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, width, height);
            gl.bindRenderbuffer(gl.RENDERBUFFER, null);
            gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depthBuffer);
        }
        gl.drawBuffers(drawBuffers);
        if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
            for (const texture of textures) gl.deleteTexture(texture);
            if (depthBuffer) gl.deleteRenderbuffer(depthBuffer);
            gl.deleteFramebuffer(framebuffer);
            throw new Error('GPU world framebuffer is incomplete');
        }
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        return { framebuffer, textures, depthBuffer, width, height, attachments };
    }

    _releaseTarget(target) {
        if (!target || !this.gl) return;
        this.gl.deleteFramebuffer(target.framebuffer);
        for (const texture of target.textures || []) this.gl.deleteTexture(texture);
        if (target.depthBuffer) this.gl.deleteRenderbuffer(target.depthBuffer);
    }

    _releaseGpuResources() {
        const gl = this.gl;
        if (!gl) return;
        if (gl.isContextLost?.()) {
            this._abandonGpuResources();
            return;
        }
        for (const sample of this.pendingGpuQueries) gl.deleteQuery?.(sample.query);
        this.pendingGpuQueries.length = 0;
        this.timerExtension = null;
        this._releaseTarget(this.sceneTarget);
        this._releaseTarget(this.bloomA);
        this._releaseTarget(this.bloomB);
        this._releaseTarget(this.occlusionTarget);
        this.sceneTarget = null;
        this.bloomA = null;
        this.bloomB = null;
        this.occlusionTarget = null;
        for (const entry of this._textureEntries?.values?.() || []) {
            if (entry.texture) gl.deleteTexture(entry.texture);
        }
        this._textureEntries?.clear?.();
        this._cachedTextureBytes = 0;
        this._textureCacheNeedsTrim = false;
        if (this.emptyMaterialTexture) gl.deleteTexture(this.emptyMaterialTexture);
        if (this.cloudTileTexture) gl.deleteTexture(this.cloudTileTexture);
        if (this.vertexBuffer) gl.deleteBuffer(this.vertexBuffer);
        if (this.vao) gl.deleteVertexArray(this.vao);
        if (this.particleBuffer) gl.deleteBuffer(this.particleBuffer);
        if (this.particleVao) gl.deleteVertexArray(this.particleVao);
        for (const program of [this.sceneProgram, this.occlusionProgram, this.particleProgram, this.bloomProgram, this.compositeProgram]) {
            if (program) gl.deleteProgram(program);
        }
        this.emptyMaterialTexture = null;
        this.cloudTileTexture = null;
        this.vertexBuffer = null;
        this.vao = null;
        this.particleBuffer = null;
        this.particleVao = null;
        this.sceneProgram = null;
        this.occlusionProgram = null;
        this.particleProgram = null;
        this.bloomProgram = null;
        this.compositeProgram = null;
        this._pointedInstance = -1;
        this._particleMotifTexture = null;
        // The next _initResources creates a zero-size VBO; a stale capacity
        // here would make _uploadVertices skip its bufferData allocation and
        // leave every draw without geometry after suspend/resume.
        this.vertexBufferBytes = 0;
    }

    _abandonGpuResources() {
        this.sceneTarget = null;
        this.bloomA = null;
        this.bloomB = null;
        this.occlusionTarget = null;
        this._textureEntries?.clear?.();
        this.emptyMaterialTexture = null;
        this.cloudTileTexture = null;
        this.vertexBuffer = null;
        this.vao = null;
        this.particleBuffer = null;
        this.particleVao = null;
        this.sceneProgram = null;
        this.occlusionProgram = null;
        this.particleProgram = null;
        this.bloomProgram = null;
        this.compositeProgram = null;
        this._pointedInstance = -1;
        this._particleMotifTexture = null;
        this.textureBytes = 0;
        this._cachedTextureBytes = 0;
        this._textureCacheNeedsTrim = false;
        this.vertexBufferBytes = 0;
        this.pendingGpuQueries.length = 0;
        this.timerExtension = null;
        this.gpuMs = null;
        this.qualityTimingSource = 'cpu-fallback';
    }

    _ensureTargets() {
        const gl = this.gl;
        const bloomWidth = Math.max(1, Math.floor(this.width * BLOOM_SCALE));
        const bloomHeight = Math.max(1, Math.floor(this.height * BLOOM_SCALE));
        const occWidth = Math.max(1, Math.floor(this.width * OCCLUSION_SCALE));
        const occHeight = Math.max(1, Math.floor(this.height * OCCLUSION_SCALE));
        const matches = this.sceneTarget?.width === this.width
            && this.sceneTarget?.height === this.height
            && this.bloomA?.width === bloomWidth
            && this.bloomA?.height === bloomHeight
            && this.bloomB?.width === bloomWidth
            && this.bloomB?.height === bloomHeight
            && this.occlusionTarget?.width === occWidth
            && this.occlusionTarget?.height === occHeight;
        if (matches) return;
        this._releaseTarget(this.sceneTarget);
        this._releaseTarget(this.bloomA);
        this._releaseTarget(this.bloomB);
        this._releaseTarget(this.occlusionTarget);
        this.sceneTarget = this._createTarget(this.width, this.height, { attachments: 2, filter: gl.NEAREST, depth: true });
        this.bloomA = this._createTarget(bloomWidth, bloomHeight, { filter: gl.LINEAR });
        this.bloomB = this._createTarget(bloomWidth, bloomHeight, { filter: gl.LINEAR });
        this.occlusionTarget = this._createTarget(occWidth, occHeight, { filter: gl.NEAREST });
        this._updateTextureBytes();
    }

    _updateTextureBytes() {
        const estimate = estimateGpuWorldTextureBytes({
            width: this.width,
            height: this.height,
            bloomScale: BLOOM_SCALE,
            occlusionScale: OCCLUSION_SCALE,
        });
        // The scene target has two full-resolution colour attachments rather
        // than the policy helper's one, plus 0.6's DEPTH_COMPONENT16 painter
        // depth, so add both explicitly.
        const sceneDepthBytes = this.sceneTarget?.depthBuffer
            ? this.width * this.height * SCENE_DEPTH_BYTES_PER_PIXEL
            : 0;
        this.textureBytes = estimate.total + this.width * this.height * 4 + sceneDepthBytes + this._cachedTextureBytes;
    }

    resize(width, height) {
        this.width = Math.max(1, Math.floor(finite(width, this.width)));
        this.height = Math.max(1, Math.floor(finite(height, this.height)));
        if (this.canvas) {
            if (this.canvas.width !== this.width) this.canvas.width = this.width;
            if (this.canvas.height !== this.height) this.canvas.height = this.height;
            this.canvas.style.pointerEvents = 'none';
            this.canvas.style.imageRendering = 'pixelated';
        }
        if (this.gl && this.contextHealthy && !this.suspended) this._ensureTargets();
    }

    isActive() {
        return Boolean(this.enabled && this.supported && this.contextHealthy && !this.disposed && !this.suspended);
    }

    setEnabled(enabled) {
        this.enabled = Boolean(enabled);
    }

    suspend() {
        if (this.disposed || this.suspended) return;
        this.suspended = true;
        this._releaseGpuResources();
        this.textureBytes = 0;
    }

    resume() {
        if (this.disposed || !this.suspended || !this.gl) return this.isActive();
        try {
            this.suspended = false;
            this._initResources();
            this.resize(this.width, this.height);
            // 0.1 — a Dashboard return resumes the last paced level (the
            // display period stays latched) instead of re-climbing from
            // MINIMAL; the timer ring holds pre-suspend spans, so it restarts.
            this.qualityLadder.resume();
            this._gpuTimerRing = null;
            this.gpuMsP25 = null;
            this._pendingPresentIntervalMs = null;
            this.contextHealthy = true;
            return true;
        } catch (error) {
            this.suspended = true;
            this.contextHealthy = false;
            console.warn('[GpuWorldRenderer] resume failed; Canvas fallback remains active:', error);
            return false;
        }
    }

    _textureFor(key, source, revision = null, updates = null) {
        const gl = this.gl;
        if (!source || source.width === 0 || source.height === 0) return null;
        const width = Math.max(1, Math.floor(source.width || source.videoWidth || 1));
        const height = Math.max(1, Math.floor(source.height || source.videoHeight || 1));
        let entry = this._textureEntries.get(key);
        const storageChanged = !entry
            || entry.source !== source
            || entry.width !== width
            || entry.height !== height;
        const revisionChanged = !entry || entry.revision !== revision;
        if (!entry) {
            entry = { texture: gl.createTexture(), source: null, revision: null, width: 0, height: 0, bytes: 0, format: 'rgba8' };
            this._textureEntries.set(key, entry);
            this._textureCacheNeedsTrim = true;
        }
        if (storageChanged || revisionChanged) {
            const started = performance.now();
            gl.bindTexture(gl.TEXTURE_2D, entry.texture);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
            gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
            const canPatch = !storageChanged
                && Array.isArray(updates)
                && updates.length > 0
                && updates.every((update) => {
                    const updateWidth = Math.floor(update?.width || update?.source?.width || 0);
                    const updateHeight = Math.floor(update?.height || update?.source?.height || 0);
                    const updateX = Math.floor(update?.x || 0);
                    const updateY = Math.floor(update?.y || 0);
                    return Boolean(
                        update?.source
                        && updateWidth > 0
                        && updateHeight > 0
                        && update?.source?.width === updateWidth
                        && update?.source?.height === updateHeight
                        && updateX >= 0
                        && updateY >= 0
                        && updateX + updateWidth <= width
                        && updateY + updateHeight <= height
                    );
                });
            let uploadedBytes = 0;
            if (canPatch) {
                for (const update of updates) {
                    if (!update?.source) continue;
                    gl.texSubImage2D(
                        gl.TEXTURE_2D,
                        0,
                        Math.max(0, Math.floor(update.x || 0)),
                        Math.max(0, Math.floor(update.y || 0)),
                        gl.RGBA,
                        gl.UNSIGNED_BYTE,
                        update.source,
                    );
                    uploadedBytes += Math.max(0, Math.floor(update.width || update.source.width || 0))
                        * Math.max(0, Math.floor(update.height || update.source.height || 0)) * 4;
                }
            } else {
                gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
                uploadedBytes = width * height * 4;
            }
            gl.bindTexture(gl.TEXTURE_2D, null);
            // Canvas and image sources upload as RGBA8: 4 B per texel.
            const bytes = width * height * TEXTURE_FORMATS.rgba8.bytesPerTexel;
            entry.source = source;
            entry.revision = revision;
            entry.width = width;
            entry.height = height;
            this._cachedTextureBytes += bytes - (entry.bytes || 0);
            entry.bytes = bytes;
            this.uploads++;
            this.uploadBytes += uploadedBytes;
            this._frameUploadMs += performance.now() - started;
            if (storageChanged) {
                this._textureCacheNeedsTrim = true;
                this._updateTextureBytes();
            }
        }
        entry.lastUsedFrame = this.frames + 1;
        return entry.texture;
    }

    _trimTextureCache() {
        const overCap = this._cachedTextureBytes > MAX_CACHED_TEXTURE_BYTES
            || this._textureEntries.size > MAX_CACHED_TEXTURES;
        if (!overCap) {
            this._textureCacheNeedsTrim = false;
            return;
        }
        if (!this._textureCacheNeedsTrim && this.frames - this._lastTextureTrimFrame < 120) return;
        this._lastTextureTrimFrame = this.frames;
        this._textureCacheNeedsTrim = false;
        const candidates = [...this._textureEntries.entries()]
            .filter(([, entry]) => entry.lastUsedFrame !== this.frames + 1)
            .sort((a, b) => finite(a[1].lastUsedFrame) - finite(b[1].lastUsedFrame));
        for (const [key, entry] of candidates) {
            if (this._cachedTextureBytes <= MAX_CACHED_TEXTURE_BYTES
                && this._textureEntries.size <= MAX_CACHED_TEXTURES) break;
            this.gl.deleteTexture(entry.texture);
            this._textureEntries.delete(key);
            this._cachedTextureBytes -= entry.bytes || 0;
            this.textureEvictions++;
        }
        this._updateTextureBytes();
    }

    setPassSamplingEnabled(enabled) {
        this.passSamplingEnabled = Boolean(enabled);
    }

    _beginPass(name) {
        if (this._sampledPass !== name) return;
        this._passStarted = performance.now();
        this._passUploadBytes = this.uploadBytes;
        this._activePassQuery = this._beginGpuTimer();
    }

    _endPass(name, draws, bytes) {
        if (this._sampledPass !== name) return;
        const cpuMs = performance.now() - this._passStarted;
        const sample = { pass: name, draws, bytes: bytes + this.uploadBytes - this._passUploadBytes, cpuMs };
        if (this._activePassQuery) this._endGpuTimer(this._activePassQuery, sample);
        else this._recordPass({ ...sample, gpuMs: null });
        this._activePassQuery = null;
    }

    // The ring is fixed capacity and its aggregates are maintained on write:
    // getDiagnostics() runs every frame from the render-stats builder and must
    // never walk the samples.
    _recordPass(sample) {
        const ring = this._passResults[sample.pass];
        const evicted = ring.samples[ring.next];
        if (evicted) {
            ring.cpuSum -= evicted.cpuMs;
            if (evicted.gpuMs != null) {
                ring.gpuSum -= evicted.gpuMs;
                ring.gpuCount -= 1;
            }
        }
        ring.samples[ring.next] = sample;
        ring.next = (ring.next + 1) % PASS_RING_CAPACITY;
        ring.count = Math.min(PASS_RING_CAPACITY, ring.count + 1);
        ring.cpuSum += sample.cpuMs;
        if (sample.gpuMs != null) {
            ring.gpuSum += sample.gpuMs;
            ring.gpuCount += 1;
        }
        ring.latest = sample;
    }

    _beginGpuTimer() {
        if (!this.timerExtension || !this.gl?.createQuery) return null;
        let query = null;
        try {
            query = this.gl.createQuery();
            if (!query) return null;
            this.gl.beginQuery(this.timerExtension.TIME_ELAPSED_EXT, query);
            return query;
        } catch {
            this.gl.deleteQuery?.(query);
            this.gpuTimerErrors++;
            return null;
        }
    }

    _endGpuTimer(query, metadata = null) {
        if (!query || !this.timerExtension) return;
        try {
            const gl = this.gl;
            gl.endQuery(this.timerExtension.TIME_ELAPSED_EXT);
            this.pendingGpuQueries.push({ query, ...metadata });
            if (this.pendingGpuQueries.length > 8) {
                gl.deleteQuery?.(this.pendingGpuQueries.shift().query);
            }
        } catch {
            this.gpuTimerErrors++;
            if (!metadata?.pass) this.gpuMs = null;
            this.gl.deleteQuery?.(query);
        }
    }

    _pollGpuQueries() {
        if (!this.timerExtension || !this.pendingGpuQueries.length) return;
        const gl = this.gl;
        if (gl.getParameter(this.timerExtension.GPU_DISJOINT_EXT)) {
            // Even not-yet-available queries intersect this invalid interval.
            this.gpuDisjointDiscards += this.pendingGpuQueries.length;
            for (const sample of this.pendingGpuQueries) gl.deleteQuery?.(sample.query);
            this.pendingGpuQueries.length = 0;
            this.gpuMs = null;
            return;
        }
        for (let index = 0; index < this.pendingGpuQueries.length;) {
            const sample = this.pendingGpuQueries[index];
            try {
                if (!gl.getQueryParameter(sample.query, gl.QUERY_RESULT_AVAILABLE)) {
                    index++;
                    continue;
                }
                const gpuMs = Number(gl.getQueryParameter(sample.query, gl.QUERY_RESULT)) / 1e6;
                if (Number.isFinite(gpuMs) && gpuMs >= 0) {
                    if (sample.pass) this._recordPass({ ...sample, query: undefined, gpuMs });
                    else this._recordFrameTimerSample(gpuMs, sample.arm);
                }
            } catch {
                this.gpuTimerErrors++;
                if (!sample.pass) this.gpuMs = null;
            }
            this.pendingGpuQueries.splice(index, 1);
            gl.deleteQuery?.(sample.query);
        }
    }

    // 0.1 — raw EMA for the readout, p25 of the last GPU_TIMER_RING samples
    // for the ladder's veto. The sort copy is at most 30 numbers, on 1 frame
    // in 4. A K-slope arm (`setDebugLoad({ schedule })`) also gets its sample.
    _recordFrameTimerSample(gpuMs, arm = undefined) {
        this.gpuMs = ema(this.gpuMs, gpuMs);
        const ring = this._gpuTimerRing ||= {
            samples: new Float64Array(GPU_TIMER_RING),
            sorted: new Float64Array(GPU_TIMER_RING),
            count: 0,
            next: 0,
        };
        ring.samples[ring.next] = gpuMs;
        ring.next = (ring.next + 1) % GPU_TIMER_RING;
        ring.count = Math.min(GPU_TIMER_RING, ring.count + 1);
        const sorted = ring.sorted.subarray(0, ring.count);
        sorted.set(ring.samples.subarray(0, ring.count));
        sorted.sort();
        this.gpuMsP25 = sorted[Math.floor((ring.count - 1) * 0.25)];
        if (arm !== undefined) this._debugLoad?.samples?.[arm]?.push(gpuMs);
    }

    // V9 / B.1a — one instance per record, every batch in one buffer at its
    // own byte offset: 68 bytes, or the 48-byte head alone when every record
    // of the batch has the default tail. The occlusion pass draws the same
    // ranges and culls the non-occluders in its vertex stage, so nothing is
    // staged twice. `batch.occlusionCount` counts a batch's occluding records
    // (0 skips it in that pass).
    _stageFrameVertices(batches, occluderChannelEnabled = true) {
        let byteLength = 0;
        for (let index = 0; index < batches.length; index++) {
            const batch = batches[index];
            const records = batch.records;
            let tail = false;
            for (let recordIndex = 0; !tail && recordIndex < records.length; recordIndex++) {
                tail = !recordHasDefaultTail(records[recordIndex]);
            }
            batch.tail = tail;
            batch.instanceOffset = byteLength;
            batch.count = records.length;
            byteLength += records.length * (tail ? RECORD_INSTANCE_BYTES : RECORD_HEAD_BYTES);
        }
        const floats = byteLength / Float32Array.BYTES_PER_ELEMENT;
        const grown = growTypedArray(Float32Array, this._instanceF32, floats, 64);
        if (grown !== this._instanceF32) {
            this._instanceF32 = grown;
            this._instanceU16 = new Uint16Array(grown.buffer);
        }
        const f32 = this._instanceF32;
        const u16 = this._instanceU16;
        for (let index = 0; index < batches.length; index++) {
            const batch = batches[index];
            const records = batch.records;
            const stride = batch.tail ? RECORD_INSTANCE_BYTES : RECORD_HEAD_BYTES;
            batch.occlusionCount = 0;
            for (let recordIndex = 0; recordIndex < records.length; recordIndex++) {
                const record = records[recordIndex];
                writeGpuRecordInstance(f32, u16, batch.instanceOffset + recordIndex * stride, record, batch.tail);
                if (occluderChannelEnabled
                    && (record.occluderSource || record.occluder > 0 || record.elevation > 0.05)) {
                    batch.occlusionCount++;
                }
            }
        }
        this._vertexScratchUsed = floats;
        const gl = this.gl;
        gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer);
        const allocatedBytes = this.vertexBufferBytes || 0;
        if (byteLength > allocatedBytes) {
            gl.bufferData(gl.ARRAY_BUFFER, byteLength, gl.DYNAMIC_DRAW);
            this.vertexBufferBytes = byteLength;
        }
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, f32, 0, floats);
        this._pointedInstance = -1;
    }

    // WebGL2 has no base instance: point the V9 attributes at the batch's own
    // byte range (skipped when that range is already current). A head-only
    // batch disables arrays 3-5 and sets the default tail as constant generic
    // attributes instead.
    _pointRecordInstances(batch) {
        const offset = batch.instanceOffset;
        if (this._pointedInstance === offset) return;
        const gl = this.gl;
        const stride = batch.tail ? RECORD_INSTANCE_BYTES : RECORD_HEAD_BYTES;
        gl.vertexAttribPointer(0, 4, gl.FLOAT, false, stride, offset);
        gl.vertexAttribPointer(1, 4, gl.FLOAT, false, stride, offset + 16);
        gl.vertexAttribPointer(2, 4, gl.FLOAT, false, stride, offset + 32);
        if (batch.tail) {
            if (!this._recordTailArrays) {
                for (let location = 3; location <= 5; location++) gl.enableVertexAttribArray(location);
                this._recordTailArrays = true;
            }
            gl.vertexAttribPointer(3, 4, gl.UNSIGNED_SHORT, false, stride, offset + 48);
            gl.vertexAttribPointer(4, 4, gl.UNSIGNED_SHORT, false, stride, offset + 56);
            gl.vertexAttribIPointer(5, 2, gl.UNSIGNED_SHORT, stride, offset + 64);
        } else if (this._recordTailArrays !== false) {
            for (let location = 3; location <= 5; location++) gl.disableVertexAttribArray(location);
            gl.vertexAttrib4fv(3, RECORD_TAIL_RESPONSE);
            gl.vertexAttrib4fv(4, RECORD_TAIL_RECEIVER);
            gl.vertexAttribI4ui(5, 0, 0, 0, 0);
            this._recordTailArrays = false;
        }
        this._pointedInstance = offset;
    }

    _setCameraUniforms(uniforms, camera, scale = 1) {
        const gl = this.gl;
        const dpr = Math.max(0.25, finite(camera?._dpr?.(), 1));
        const zoom = Math.max(0.01, finite(camera?.zoom, 1));
        gl.uniform3f(
            uniforms.u_camera,
            finite(camera?.renderOffsetX, Math.round(finite(camera?.x) * zoom * dpr) / dpr) / zoom,
            finite(camera?.renderOffsetY, Math.round(finite(camera?.y) * zoom * dpr) / dpr) / zoom,
            zoom * dpr * scale,
        );
    }

    // Resolve (and, when a revision moved, upload) every channel texture for
    // the frame once. Both draw passes then only bind: the sidecar key strings
    // are built once per frame instead of once per batch per pass, and every
    // texSubImage/texImage cost is attributed to the upload phase rather than
    // appearing inside whichever pass happened to bind the batch first.
    _uploadBatchTextures(batches, occluderChannelEnabled = true) {
        for (let index = 0; index < batches.length; index++) {
            const batch = batches[index];
            const first = batch.records[0];
            const sidecar = batch.sidecarKey || batch.textureKey;
            batch.albedoTexture = this._textureFor(
                batch.textureKey,
                batch.source,
                first?.textureRevision,
                first?.textureUpdates,
            );
            batch.materialTexture = batch.materialSource
                ? this._textureFor(`material:${sidecar}`, batch.materialSource,
                    first?.sidecarRevision, first?.materialTextureUpdates)
                : null;
            batch.emissiveTexture = batch.emissiveSource
                ? this._textureFor(`emissive:${sidecar}`, batch.emissiveSource,
                    first?.sidecarRevision, first?.emissiveTextureUpdates)
                : null;
            if (!occluderChannelEnabled && batch.occluderSource) this.skippedOccluderUploads++;
            batch.occluderTexture = occluderChannelEnabled && batch.occluderSource
                ? this._textureFor(`occluder:${sidecar}`, batch.occluderSource,
                    first?.sidecarRevision, first?.occluderTextureUpdates)
                : null;
        }
    }

    _bindBatch(program, uniforms, batch, { occlusion = false } = {}) {
        const gl = this.gl;
        const albedo = batch.albedoTexture;
        if (!albedo) return 0;
        const material = batch.materialTexture;
        const units = SCENE_SAMPLER_UNITS;
        gl.activeTexture(gl.TEXTURE0 + units.albedo);
        gl.bindTexture(gl.TEXTURE_2D, albedo);
        gl.uniform1i(uniforms.u_albedo, units.albedo);
        gl.activeTexture(gl.TEXTURE0 + units.material);
        gl.bindTexture(gl.TEXTURE_2D, material || this.emptyMaterialTexture);
        gl.uniform1i(uniforms.u_materialMap, units.material);
        gl.uniform1i(uniforms.u_hasMaterialMap, material ? 1 : 0);
        if (uniforms.u_emissiveMap) {
            gl.activeTexture(gl.TEXTURE0 + units.emissive);
            gl.bindTexture(gl.TEXTURE_2D, batch.emissiveTexture || this.emptyMaterialTexture);
            gl.uniform1i(uniforms.u_emissiveMap, units.emissive);
            gl.uniform1i(uniforms.u_hasEmissiveMap, batch.emissiveTexture ? 1 : 0);
        }
        if (uniforms.u_occluderMap) {
            gl.activeTexture(gl.TEXTURE0 + units.occluder);
            gl.bindTexture(gl.TEXTURE_2D, batch.occluderTexture || this.emptyMaterialTexture);
            gl.uniform1i(uniforms.u_occluderMap, units.occluder);
            gl.uniform1i(uniforms.u_hasOccluderMap, batch.occluderTexture ? 1 : 0);
        }
        if (occlusion) gl.uniform1i(uniforms.u_batchOccluderSource, batch.occluderSource ? 1 : 0);
        this._pointRecordInstances(batch);
        gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, batch.count);
        return batch.records.length;
    }

    _renderOcclusion(batches, camera) {
        const gl = this.gl;
        const target = this.occlusionTarget;
        gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
        gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
        gl.viewport(0, 0, target.width, target.height);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.useProgram(this.occlusionProgram);
        this._setCameraUniforms(this.occlusionUniforms, camera, OCCLUSION_SCALE);
        gl.uniform2f(this.occlusionUniforms.u_resolution, target.width, target.height);
        for (const batch of batches) {
            if (!batch.occlusionCount) continue;
            this._bindBatch(this.occlusionProgram, this.occlusionUniforms, batch, { occlusion: true });
        }
    }

    _setSceneUniforms(feed, camera, qualityLevel = POST_FX_LEVELS.FULL) {
        const gl = this.gl;
        const uniforms = this.sceneUniforms;
        const grade = frameGrade(feed);
        const weather = weatherUniform(feed);
        const weatherMode = effectBudgetMode('weather-amplitude', qualityLevel);
        if (weatherMode === 'reduced') {
            weather[0] *= 0.72;
            weather[3] *= 0.72;
        } else if (weatherMode === 'off') {
            weather[0] = 0;
            weather[2] = 0;
            weather[3] = 0;
        }
        gl.uniform1i(uniforms.u_useOcclusion, effectBudgetMode('occlusion', qualityLevel) !== 'off');
        this._setCameraUniforms(uniforms, camera, 1);
        gl.uniform2f(uniforms.u_resolution, this.width, this.height);
        gl.uniform2f(uniforms.u_occlusionResolution, this.occlusionTarget.width, this.occlusionTarget.height);
        uploadGradeUniforms(gl, uniforms, grade);
        gl.uniform3fv(uniforms.u_fogColor, grade.fogColor);
        gl.uniform1i(uniforms.u_additive, 0);
        const cloudCover = clamp(finite(feed.atmosphere?.weather?.cloudCover, 0), 0, 1);
        gl.uniform1f(uniforms.u_overcast, clamp((cloudCover - 0.7) / 0.2, 0, 1));
        gl.uniform4fv(uniforms.u_weather, weather);
        const sun = feed.lighting?.sunDirIso || {};
        gl.uniform4f(
            uniforms.u_sun,
            finite(sun.x, -0.7071),
            finite(sun.y, -0.7071),
            clamp(finite(feed.lighting?.sunWarmth), 0, 1),
            // C2 owns the sun band: flat at night and under a covered sky.
            clamp(finite(grade.sunBand, 1), 0, 1),
        );
        this._frameGradeForComposite = grade;
        this._compositeCloudCover = cloudCover;
        this._compositeQualityLevel = qualityLevel;
        this._resolveAtmosphereCourses(qualityLevel, camera, feed, grade);
        this._uploadAtmosphereCourses(uniforms, SCENE_SAMPLER_UNITS.cloudTile);
        // 3.1 — one envelope, three consumers: the core here, the spill on each
        // admitted light below, and the bloom share in `_present`.
        const energy = sourceEnergyFor(feed.lighting);
        this.sourceEnergy = energy;
        gl.uniform1f(uniforms.u_coreEnergy, clamp(finite(energy.core, 1), 0, 2));
        // 3.4 — night fill drives the grade course above; the optional water
        // silver course is FULL-only and stays out of REDUCED and MINIMAL.
        const moonFill = clamp(finite(feed.lighting?.moonFill, 0), 0, 1);
        gl.uniform1f(uniforms.u_moonFill, moonFill);
        gl.uniform1i(uniforms.u_waterSilver, qualityLevel <= POST_FX_LEVELS.FULL ? 1 : 0);
        const mood = waterMoodFor({ lightGrade: grade, weather: feed.weather || feed.atmosphere?.weather });
        gl.uniform2f(uniforms.u_waterMood, mood.night, mood.storm);
        // 3.2 — real accumulated wetness; FULL reflects eight admitted sources,
        // REDUCED four, MINIMAL none (the static wet darkening still reads).
        const wetness = clamp(finite(feed.wetness, 0), 0, 1);
        gl.uniform1f(uniforms.u_wetness, wetness);
        this.wetReflectionCount = wetness <= 0.01 || qualityLevel >= POST_FX_LEVELS.MINIMAL
            ? 0
            : qualityLevel >= POST_FX_LEVELS.REDUCED ? 4 : 8;
        gl.uniform1i(uniforms.u_wetReflectionCount, this.wetReflectionCount);
        // 3.5 — the authored ramp table. An absent, wrong-sized, or shed table
        // leaves the pilot with today's additive response.
        const lutSource = qualityLevel >= POST_FX_LEVELS.MINIMAL ? null : feed.paletteLut || null;
        const lut = lutSource
            && lutSource.width === PALETTE_LUT_WIDTH
            && lutSource.height === PALETTE_LUT_HEIGHT
            ? this._textureFor('lut:palette-ramp', lutSource, feed.paletteLutRevision ?? null)
            : null;
        this.paletteLutActive = Boolean(lut);
        gl.activeTexture(gl.TEXTURE0 + SCENE_SAMPLER_UNITS.paletteLut);
        gl.bindTexture(gl.TEXTURE_2D, lut || this.emptyMaterialTexture);
        gl.uniform1i(uniforms.u_paletteLut, SCENE_SAMPLER_UNITS.paletteLut);
        gl.uniform1i(uniforms.u_hasPaletteLut, lut ? 1 : 0);
        // Keep the existing time channel inside float32's precise range. The
        // one-million-ms period closes on both shader phase multipliers.
        const shaderTimeMs = ((finite(feed.timeMs, Date.now()) % 1000000) + 1000000) % 1000000;
        gl.uniform1f(uniforms.u_time, shaderTimeMs);
        gl.uniform1f(uniforms.u_motionScale, feed.reducedMotion ? 0 : clamp(finite(feed.motionScale, 1), 0, 2));
        gl.activeTexture(gl.TEXTURE0 + SCENE_SAMPLER_UNITS.occlusion);
        gl.bindTexture(gl.TEXTURE_2D, this.occlusionTarget.textures[0]);
        gl.uniform1i(uniforms.u_occlusion, SCENE_SAMPLER_UNITS.occlusion);

        this.localLightPhase = localLightPhaseForLighting(feed.lighting);
        const daylightSuppressesLights = this.localLightPhase <= LOCAL_LIGHT_VISIBILITY_FLOOR;
        // 0.1 — admission is the declared `light-admission` row (FULL 32,
        // REDUCED 24, MINIMAL 12): the night's pools ship at every level.
        const lightLimit = daylightSuppressesLights
            ? 0
            : Math.min(MAX_LIGHTS, effectBudgetMode('light-admission', qualityLevel));
        const lights = clampGpuLights(
            feed.lights,
            lightLimit,
            daylightSuppressesLights ? 0 : MAX_LIGHTS,
            this._lightAdmissionCache,
        );
        const admission = this.lightAdmission;
        admission.cap = lightLimit;
        admission.admitted = lights.length;
        admission.offered = feed.lights?.length || 0;
        admission.daylight = daylightSuppressesLights;
        const lightValues = this._lightScratch;
        const lightColors = this._lightColorScratch;
        lightValues.fill(0);
        lightColors.fill(0);
        let attentionMask = 0;
        let wetMask = 0;
        let wetSlots = this.wetReflectionCount;
        for (let index = 0; index < lights.length; index++) {
            const light = lights[index];
            const color = gpuLightColorForShader(light, DEFAULT_LIGHT_COLOR, this._singleLightColorScratch);
            const offset = index * 4;
            lightValues[offset] = finite(light.x);
            lightValues[offset + 1] = this.height - finite(light.y);
            lightValues[offset + 2] = Math.max(1, finite(light.radius, 64));
            lightValues[offset + 3] = clamp(finite(light.intensity, 1), 0, 3);
            const attention = isAttentionLight(light);
            if (attention) {
                attentionMask |= (1 << index) >>> 0;
            } else if (wetSlots > 0) {
                wetMask |= (1 << index) >>> 0;
                wetSlots--;
            }
            lightColors[offset] = color[0];
            lightColors[offset + 1] = color[1];
            lightColors[offset + 2] = color[2];
            // The spill share of the envelope rides here, so an action-needed
            // overlay light keeps its full read outside the exposure budget.
            lightColors[offset + 3] = (light.night
                ? clamp(finite(feed.lighting?.beaconIntensity, 0), 0, 1)
                : 1) * (attention ? 1 : clamp(finite(energy.spill, 1), 0, 2));
        }
        this.lightCount = lights.length;
        gl.uniform1i(uniforms.u_lightCount, lights.length);
        gl.uniform4fv(uniforms['u_lights[0]'], lightValues);
        gl.uniform4fv(uniforms['u_lightColors[0]'], lightColors);
        gl.uniform1ui(uniforms.u_attentionMask, attentionMask >>> 0);
        gl.uniform1ui(uniforms.u_wetMask, wetMask >>> 0);
    }

    _renderScene(batches, camera, feed, qualityLevel = POST_FX_LEVELS.FULL) {
        const gl = this.gl;
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.sceneTarget.framebuffer);
        const bloomEnabled = effectBudgetMode('bloom', qualityLevel) !== 'off'
            && localLightPhaseForLighting(feed.lighting) > LOCAL_LIGHT_VISIBILITY_FLOOR;
        gl.drawBuffers(bloomEnabled
            ? [gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]
            : [gl.COLOR_ATTACHMENT0]);
        gl.viewport(0, 0, this.width, this.height);
        gl.clearColor(0, 0, 0, 0);
        // 0.6 — the particle draw leaves depthMask false, and a masked depth
        // clear is a no-op: open the mask before clearing to the far plane.
        gl.depthMask(true);
        gl.clearDepth(1);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
        gl.depthFunc(gl.ALWAYS);
        let depthWrites = true;
        gl.useProgram(this.sceneProgram);
        this._setSceneUniforms(feed, camera, qualityLevel);
        let additive = false;
        for (const batch of batches) {
            const add = batch.blend === 'add';
            if (add) gl.blendFunc(gl.ONE, gl.ONE);
            else gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
            if (add !== additive) {
                additive = add;
                gl.uniform1i(this.sceneUniforms.u_additive, add ? 1 : 0);
            }
            // Painter order still decides every colour (depthFunc ALWAYS);
            // opaque sprite batches also leave their depth key behind.
            if (batch.writesDepth !== depthWrites) {
                depthWrites = batch.writesDepth === true;
                gl.depthMask(depthWrites);
            }
            this._bindBatch(this.sceneProgram, this.sceneUniforms, batch);
        }
        this._renderParticles(camera);
        // The painter depth never leaves the pass.
        gl.invalidateFramebuffer(gl.FRAMEBUFFER, [gl.DEPTH_ATTACHMENT]);
        return bloomEnabled;
    }

    // 0.6 — every live world particle in one instanced draw, LEQUAL against
    // the painter depth, never writing it. Lit particles take the frame grade
    // uploaded here; emissive ones feed bloom with their own coverage.
    _renderParticles(camera) {
        const count = this._particleCount;
        if (!count || !this._particleMotifTexture) return;
        const gl = this.gl;
        const uniforms = this.particleUniforms;
        gl.useProgram(this.particleProgram);
        this._setCameraUniforms(uniforms, camera, 1);
        gl.uniform2f(uniforms.u_resolution, this.width, this.height);
        uploadGradeUniforms(gl, uniforms, this._frameGradeForComposite || NEUTRAL_GRADE);
        gl.uniform1f(uniforms.u_coreEnergy, clamp(finite(this.sourceEnergy?.core, 1), 0, 2));
        gl.activeTexture(gl.TEXTURE0 + PARTICLE_SAMPLER_UNITS.motifs);
        gl.bindTexture(gl.TEXTURE_2D, this._particleMotifTexture);
        gl.uniform1i(uniforms.u_motifs, PARTICLE_SAMPLER_UNITS.motifs);
        if (this._atmosphereCourses) this._uploadAtmosphereCourses(uniforms, PARTICLE_SAMPLER_UNITS.cloudTile);
        gl.bindVertexArray(this.particleVao);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.particleBuffer);
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, this._particleViews.u8, 0, count * GPU_PARTICLE_INSTANCE_BYTES);
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        gl.depthFunc(gl.LEQUAL);
        gl.depthMask(false);
        gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, count);
        gl.depthFunc(gl.ALWAYS);
        gl.bindVertexArray(this.vao);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer);
    }

    _renderBloom() {
        const gl = this.gl;
        gl.useProgram(this.bloomProgram);
        gl.uniform1i(this.bloomUniforms.u_input, 0);
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.bloomA.framebuffer);
        gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
        gl.viewport(0, 0, this.bloomA.width, this.bloomA.height);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.sceneTarget.textures[1]);
        gl.uniform2f(this.bloomUniforms.u_texel, 1 / this.width, 1 / this.height);
        gl.uniform1i(this.bloomUniforms.u_blur, 0);
        gl.drawArrays(gl.TRIANGLES, 0, 3);

        gl.bindFramebuffer(gl.FRAMEBUFFER, this.bloomB.framebuffer);
        gl.viewport(0, 0, this.bloomB.width, this.bloomB.height);
        gl.bindTexture(gl.TEXTURE_2D, this.bloomA.textures[0]);
        gl.uniform2f(this.bloomUniforms.u_texel, 1 / this.bloomA.width, 1 / this.bloomA.height);
        gl.uniform1i(this.bloomUniforms.u_blur, 1);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    _present(qualityLevel = POST_FX_LEVELS.FULL, camera = null, feed = {}) {
        const gl = this.gl;
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.drawBuffers([gl.BACK]);
        gl.viewport(0, 0, this.width, this.height);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.useProgram(this.compositeProgram);
        gl.uniform1i(this.compositeUniforms.u_scene, COMPOSITE_SAMPLER_UNITS.scene);
        gl.uniform1i(this.compositeUniforms.u_bloom, COMPOSITE_SAMPLER_UNITS.bloom);
        const bloomMode = effectBudgetMode('bloom', qualityLevel);
        const bloomStrength = bloomMode === 'off' ? 0 : bloomMode === 'reduced' ? 0.42 : 0.72;
        // 3.1 — bloom is served last from the same envelope, so broad halo
        // energy shrinks while the cores it came from stay readable.
        const bloomEnergy = clamp(finite(this.sourceEnergy?.bloom, 1), 0, 2);
        gl.uniform1f(
            this.compositeUniforms.u_bloomStrength,
            this.lightCount > 0 ? bloomStrength * bloomEnergy : 0,
        );
        const flash = feed.flash;
        gl.uniform3f(this.compositeUniforms.u_flash, finite(flash?.[0], 0), finite(flash?.[1], 0), finite(flash?.[2], 0));
        gl.activeTexture(gl.TEXTURE0 + COMPOSITE_SAMPLER_UNITS.scene);
        gl.bindTexture(gl.TEXTURE_2D, this.sceneTarget.textures[0]);
        gl.activeTexture(gl.TEXTURE0 + COMPOSITE_SAMPLER_UNITS.bloom);
        gl.bindTexture(gl.TEXTURE_2D, this.bloomB.textures[0]);
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        if (this._frameLoadPasses > 0) this._drawDebugLoad(this._frameLoadPasses);
    }

    /**
     * 0.1 — debug-only GPU-side load for the ladder acceptance run and V2
     * K-slope receipts; off unless set here or by `?gpuLoad=<passes>`.
     * `{ passes, levels }`: `levels: 'full'` (default) draws only at FULL, a
     * load the ladder can shed; `'all'` draws at every level, so shedding
     * cannot help. `{ schedule: [{ id, passes }, …] }` interleaves arms per
     * frame instead, times every frame, and files each whole-frame timer
     * sample under its arm id (`takeDebugLoadSamples()`). `null` or 0 turns it
     * off.
     */
    setDebugLoad(config = null) {
        const previous = this._debugLoad;
        const spec = typeof config === 'number' ? { passes: config } : config;
        const schedule = Array.isArray(spec?.schedule) && spec.schedule.length
            ? spec.schedule.map((arm, index) => ({
                id: String(arm?.id ?? index),
                passes: Math.max(0, Math.floor(finite(arm?.passes))),
            }))
            : null;
        const passes = Math.max(0, Math.floor(finite(spec?.passes)));
        if (!schedule && passes === 0) {
            if (previous?.program && this.gl?.isProgram?.(previous.program)) this.gl.deleteProgram(previous.program);
            this._debugLoad = null;
            return null;
        }
        this._debugLoad = {
            passes,
            levels: spec.levels === 'all' ? 'all' : 'full',
            schedule,
            cursor: 0,
            samples: schedule ? Object.fromEntries(schedule.map(arm => [arm.id, []])) : null,
            program: previous?.program ?? null,
            owner: previous?.owner ?? null,
            sceneLocation: previous?.sceneLocation ?? null,
        };
        return { passes, levels: this._debugLoad.levels, schedule };
    }

    /** K-slope timer samples per arm id since the last call; the arms restart empty. */
    takeDebugLoadSamples() {
        const samples = this._debugLoad?.samples;
        if (!samples) return null;
        const taken = {};
        for (const [id, values] of Object.entries(samples)) {
            taken[id] = values.slice();
            values.length = 0;
        }
        return taken;
    }

    _drawDebugLoad(passes) {
        const gl = this.gl;
        const load = this._debugLoad;
        // The program follows the composite program's lifetime: suspend,
        // resume and context restore all recreate the composite.
        if (!load.program || load.owner !== this.compositeProgram) {
            if (load.program && gl.isProgram(load.program)) gl.deleteProgram(load.program);
            load.program = createProgram(gl, FULLSCREEN_VERTEX, DEBUG_LOAD_FRAGMENT);
            load.owner = this.compositeProgram;
            load.sceneLocation = gl.getUniformLocation(load.program, 'u_scene');
        }
        gl.useProgram(load.program);
        // TEXTURE0 still holds the scene target from the composite.
        gl.uniform1i(load.sceneLocation, 0);
        gl.blendFunc(gl.ONE, gl.ONE);
        for (let index = 0; index < passes; index++) gl.drawArrays(gl.TRIANGLES, 0, 3);
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    }

    // 1.4 + 1.6 — the frame's world-locked cloud-shadow courses and screen-Y
    // aerial perspective, resolved once per frame with the scene uniforms.
    // The scene and particle programs shade them per record, on each record's
    // own texel grid (ATMOSPHERE_COURSES_GLSL), so a body resting between
    // world texels keeps whole k x k blocks.
    _resolveAtmosphereCourses(qualityLevel, camera, feed, grade) {
        const courses = this._atmosphereCourses || (this._atmosphereCourses = {
            cloud: new Float32Array(4),
            thresholds: new Float32Array(3),
            haze: new Float32Array(4),
        });
        // Cover sets the covered share (clear ~15 %, partly cloudy ~35 %);
        // overcast/rain get none (the grade flattens instead) and the night
        // has no sun to cast them. Darkening per course is 8.5 %: three
        // courses reach ~25 % at the thickest core (course 1 ~0.92).
        const cover = clamp(finite(this._compositeCloudCover, 0), 0, 1);
        const cloudMode = effectBudgetMode('cloud-courses', qualityLevel);
        const cloudStrength = cloudMode === 'off' ? 0 : clamp(finite(grade.cloudShadow, 0), 0, 1);
        const covered = clamp(0.1 + cover * 0.62, 0, 0.45);
        // C-W3 — the one wind: the courses drift at 3 + 7·|windX| world px/s
        // along it (a third of that down-screen), integrated over the motion
        // clock in Wind.js so both backends agree and a wind change never
        // jumps them; frozen under reduced motion.
        const moving = !feed.reducedMotion && finite(feed.motionScale, 1) > 0;
        const drift = cloudCourseDrift(moving ? finite(feed.timeMs, 0) : null, feed.atmosphere?.weather);
        this.cloudCourses = cloudStrength > 0.02 ? 3 : 0;
        if (this.cloudCourses) {
            // Wrapped to one tile period for float precision.
            const period = CLOUD_TILE_SIZE * CLOUD_TILE_WORLD_SCALE;
            courses.cloud[0] = ((-drift.x % period) + period) % period;
            courses.cloud[1] = ((-drift.y % period) + period) % period;
            courses.cloud[2] = 0.085 * cloudStrength;
            courses.thresholds[0] = cloudThreshold(covered);
            courses.thresholds[1] = cloudThreshold(covered * 0.55);
            courses.thresholds[2] = cloudThreshold(covered * 0.22);
        } else {
            courses.cloud.fill(0);
            courses.thresholds.fill(2);
        }

        const hazeMode = effectBudgetMode('aerial-perspective', qualityLevel);
        const fog = clamp(finite(feed.atmosphere?.weather?.fog, 0), 0, 1);
        const haze = hazeMode === 'off' ? 0 : aerialPerspectiveStrength(finite(camera?.zoom, 1), fog);
        this.aerialHaze = haze;
        const hazeColor = grade.fogColor || [0.6, 0.7, 0.78];
        courses.haze[0] = hazeColor[0];
        courses.haze[1] = hazeColor[1];
        courses.haze[2] = hazeColor[2];
        courses.haze[3] = haze;
    }

    _uploadAtmosphereCourses(uniforms, unit) {
        const gl = this.gl;
        const courses = this._atmosphereCourses;
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(gl.TEXTURE_2D, this.cloudTileTexture);
        gl.uniform1i(uniforms.u_cloudTile, unit);
        gl.uniform4fv(uniforms.u_cloud, courses.cloud);
        gl.uniform3fv(uniforms.u_cloudThresholds, courses.thresholds);
        gl.uniform4fv(uniforms.u_haze, courses.haze);
    }

    /**
     * 0.1 — the render loop's display interval for the coming frame (rAF
     * timestamp gap), the ladder's pacing sample. A screen or DPR change
     * re-latches the display period; `visibilitychange` clears the pacing
     * window so a hidden page never reads as missed frames.
     */
    notePresentInterval(intervalMs) {
        if (!this._presentIntervalsNoted) {
            this._presentIntervalsNoted = true;
            globalThis.document?.addEventListener?.('visibilitychange', this._onVisibilityChange);
        }
        this._pendingPresentIntervalMs = intervalMs;
        const dpr = globalThis.devicePixelRatio || 1;
        const screenWidth = globalThis.screen?.width || 0;
        const screenHeight = globalThis.screen?.height || 0;
        if (dpr !== this._displayDpr
            || screenWidth !== this._displayScreenWidth
            || screenHeight !== this._displayScreenHeight) {
            if (this._displayDpr !== null) {
                this.qualityLadder.relatch();
                this._pendingPresentIntervalMs = null;
            }
            this._displayDpr = dpr;
            this._displayScreenWidth = screenWidth;
            this._displayScreenHeight = screenHeight;
        }
    }

    prepareFrame(feed = {}) {
        // Pacing never demotes past MINIMAL here; a QA override may still ask
        // for DISABLED (minimal-resident), which renders MINIMAL's composition
        // rather than swapping composition paths mid-scene (Canvas-only fauna
        // and water details sit beneath this surface and would blink).
        const qualityLevel = Math.min(this.qualityLadder.getLevel(), POST_FX_LEVELS.MINIMAL);
        this._preparedQualityLevel = qualityLevel;
        this._preparedFeed = feed;
        return effectBudgetMode('occlusion', qualityLevel) !== 'off' || weatherUniform(feed)[1] !== 0;
    }

    render({ records = [], camera = null, feed = {}, particles = null } = {}) {
        if (!this.isActive() || !camera || !records.length) return false;
        const gl = this.gl;
        const started = performance.now();
        const frameGapMs = this._lastRenderAtMs == null ? 0 : started - this._lastRenderAtMs;
        this._lastRenderAtMs = started;
        // 0.1 — the pacing sample is the display interval the loop noted for
        // this frame; a render outside that cadence (a resize redraw, a
        // gpu-burst) carries none. Without a noting loop the render gap stands in.
        const presentIntervalMs = this._presentIntervalsNoted ? this._pendingPresentIntervalMs : frameGapMs;
        this._pendingPresentIntervalMs = null;
        this._frameUploadMs = 0;
        const occluderChannelEnabled = this._preparedFeed === feed
            ? effectBudgetMode('occlusion', this._preparedQualityLevel) !== 'off' || weatherUniform(feed)[1] !== 0
            : this.prepareFrame(feed);
        const qualityLevel = this._preparedQualityLevel;
        this._preparedFeed = null;
        let gpuTimer = null;
        if (occluderChannelEnabled && this._occluderChannelSkipped) {
            for (const [key, entry] of this._textureEntries) {
                if (key.startsWith('occluder:')) entry.source = null;
            }
        }
        this._occluderChannelSkipped = !occluderChannelEnabled;
        try {
            // Timer results are asynchronous. Polling only availability keeps
            // this path non-blocking; until the first clean result arrives the
            // existing CPU submission measurement remains the ladder fallback.
            this._pollGpuQueries();
            this._ensureTargets();
            const batches = buildStableGpuBatches(records, this._batchScratch, this._normalizedRecordScratch);
            if (!batches.length) return false;
            // One pass replaces (never nests inside) the whole-frame query on
            // one frame in twelve. Only whole-frame results feed the ladder.
            this._sampledPass = this.passSamplingEnabled && this.frames % 12 === 0
                ? GPU_PASS_NAMES[this._passCursor++ % GPU_PASS_NAMES.length] : null;
            this._beginPass('upload');
            this._stageFrameVertices(batches, occluderChannelEnabled);
            this._uploadBatchTextures(batches, occluderChannelEnabled);
            // 0.6 — the live world particles, packed with the Canvas geometry;
            // the event-shape motifs ride one cached R8 field (V9 typed path).
            this._particleCount = particles?.packGpuInstances
                ? particles.packGpuInstances(this._particleViews)
                : 0;
            this.particleInstances = this._particleCount;
            if (this._particleCount > 0) {
                const motifs = particleMotifMask();
                this._particleMotifTexture = this.uploadTypedTexture('particle:motifs', {
                    width: motifs.width,
                    height: motifs.height,
                    format: 'r8',
                    data: motifs.data,
                    revision: motifs.revision,
                });
            }
            this._endPass('upload', 0, this._vertexScratchUsed * 4);
            let atlasRecords = 0;
            let individualRecords = 0;
            for (let index = 0; index < records.length; index++) {
                if (records[index]?.sourceKind === 'atlas') atlasRecords += 1;
                else individualRecords += 1;
            }
            this._sourceCensus = {
                atlasRecords,
                individualRecords,
                batchCount: batches.length,
                uploadBytes: this.uploadBytes,
            };
            gl.bindVertexArray(this.vao);
            gl.enable(gl.BLEND);
            // 0.6 — painter's depth: records keep painter order (ALWAYS) and
            // opaque sprite batches write their key; particles test LEQUAL.
            gl.enable(gl.DEPTH_TEST);
            gl.depthFunc(gl.ALWAYS);
            gl.disable(gl.CULL_FACE);
            // 0.1 — this frame's debug load: a K-slope arm, or a fixed load at
            // FULL only (sheddable) or at every level.
            this._frameLoadPasses = 0;
            this._frameLoadArm = null;
            const load = this._debugLoad;
            if (load?.schedule) {
                const arm = load.schedule[load.cursor++ % load.schedule.length];
                this._frameLoadPasses = arm.passes;
                this._frameLoadArm = arm.id;
            } else if (load && (load.levels === 'all' || qualityLevel === POST_FX_LEVELS.FULL)) {
                this._frameLoadPasses = load.passes;
            }
            const timeThisFrame = this._frameLoadArm !== null || this.frames % this._gpuTimerEvery === 0;
            gpuTimer = this._sampledPass || !timeThisFrame ? null : this._beginGpuTimer();
            const localLightsVisible = localLightPhaseForLighting(feed.lighting)
                > LOCAL_LIGHT_VISIBILITY_FLOOR;
            this._beginPass('occlusion');
            if (effectBudgetMode('occlusion', qualityLevel) !== 'off' && localLightsVisible) {
                this._renderOcclusion(batches, camera);
            } else if (occluderChannelEnabled) {
                gl.bindFramebuffer(gl.FRAMEBUFFER, this.occlusionTarget.framebuffer);
                gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
                gl.viewport(0, 0, this.occlusionTarget.width, this.occlusionTarget.height);
                gl.clearColor(0, 0, 0, 0);
                gl.clear(gl.COLOR_BUFFER_BIT);
            }
            this._endPass('occlusion', this._sampledPass === 'occlusion'
                && effectBudgetMode('occlusion', qualityLevel) !== 'off' && localLightsVisible
                ? batches.reduce((count, batch) => count + Boolean(batch.occlusionCount), 0) : 0,
                this.occlusionTarget.width * this.occlusionTarget.height * 4);
            this._beginPass('scene');
            const bloomEnabled = this._renderScene(batches, camera, feed, qualityLevel);
            this._endPass('scene', batches.length, this.width * this.height * 4 * (bloomEnabled ? 2 : 1));
            gl.disable(gl.BLEND);
            gl.disable(gl.DEPTH_TEST);
            this._beginPass('bloom');
            if (bloomEnabled && this.lightCount > 0) this._renderBloom();
            this._endPass('bloom', bloomEnabled && this.lightCount > 0 ? 2 : 0,
                bloomEnabled && this.lightCount > 0 ? this.bloomA.width * this.bloomA.height * 8 : 0);
            gl.enable(gl.BLEND);
            this._beginPass('present');
            this._present(qualityLevel, camera, feed);
            this._endPass('present', 1, this.width * this.height * 4);
            this._endGpuTimer(gpuTimer, this._frameLoadArm !== null ? { arm: this._frameLoadArm } : null);
            gpuTimer = null;
            this._trimTextureCache();
            gl.bindTexture(gl.TEXTURE_2D, null);
            gl.bindBuffer(gl.ARRAY_BUFFER, null);
            gl.bindVertexArray(null);
            let renderedRecords = 0;
            for (let index = 0; index < batches.length; index++) {
                renderedRecords += batches[index].records.length;
            }
            this.records = renderedRecords;
            this.batches = batches.length;
            this.frames++;
            const totalMs = performance.now() - started;
            const shaderCpuMs = Math.max(0, totalMs - this._frameUploadMs);
            this.uploadMs = ema(this.uploadMs, this._frameUploadMs);
            this.shaderCpuMs = ema(this.shaderCpuMs, shaderCpuMs);
            this.cpuMs = ema(this.cpuMs, totalMs);
            this.frameGapMs = ema(this.frameGapMs, frameGapMs);
            const timingInput = this._qualityTimingInput;
            timingInput.uploadMs = this._frameUploadMs;
            timingInput.shaderCpuMs = shaderCpuMs;
            timingInput.gpuMs = this.gpuMsP25;
            timingInput.gpuTimerSupported = Boolean(this.timerExtension);
            timingInput.frameGapMs = frameGapMs;
            const timing = selectGpuTimingMetrics(timingInput, this._qualityTimingScratch);
            timing.metrics.intervalMs = presentIntervalMs;
            this.qualityTimingSource = timing.source;
            const quality = this.qualityLadder.update(timing.metrics, started);
            this._gpuTimerEvery = quality.missShare >= GPU_TIMER_DENSE_MISS_SHARE ? 1 : GPU_TIMER_EVERY;
            return true;
        } catch (error) {
            gpuTimer ||= this._activePassQuery;
            this._activePassQuery = null;
            if (gpuTimer) {
                try {
                    gl.endQuery(this.timerExtension?.TIME_ELAPSED_EXT);
                } catch {
                    // Context loss or a driver error may already have ended it.
                }
                gl.deleteQuery?.(gpuTimer);
            }
            if (!this._renderErrorLogged) {
                this._renderErrorLogged = true;
                console.warn('[GpuWorldRenderer] render failed; Canvas fallback remains active:', error);
            }
            this.contextHealthy = false;
            return false;
        }
    }

    getDiagnostics() {
        const quality = this.qualityLadder.getState();
        return {
            supported: this.supported,
            active: this.isActive(),
            contextHealthy: this.contextHealthy,
            suspended: this.suspended,
            width: this.width,
            height: this.height,
            frames: this.frames,
            records: this.records,
            batches: this.batches,
            lights: this.lightCount,
            localLightPhase: this.localLightPhase,
            // 3.1/3.2 receipts an operator can read in Shift-D beside the bands.
            exposureBucket: this.sourceEnergy?.bucket ?? 'unreviewed',
            wetReflections: this.wetReflectionCount,
            // C2 / 1.4 / 1.6 receipts: which grade keys are blending, and
            // whether the record passes spent their cloud fetch and haze mix.
            gradeKey: this._frameGradeForComposite?.key ?? null,
            gradeExposure: this._frameGradeForComposite?.exposure ?? null,
            cloudCourses: this.cloudCourses,
            aerialHaze: this.aerialHaze,
            uploads: this.uploads,
            uploadBytes: this.uploadBytes,
            skippedOccluderUploads: this.skippedOccluderUploads,
            uploadMs: this.uploadMs ?? 0,
            cpuMs: this.cpuMs ?? 0,
            shaderCpuMs: this.shaderCpuMs ?? 0,
            // 0.1 — raw EMA beside the contention-robust p25 the ladder reads.
            gpuMs: this.gpuMs,
            gpuMsP25: this.gpuMsP25,
            gpuTimerSamples: this._gpuTimerRing?.count ?? 0,
            gpuTimerEvery: this._gpuTimerEvery,
            gpuTimerSupported: Boolean(this.timerExtension),
            gpuTimerExtension: this.timerExtension ? 'EXT_disjoint_timer_query_webgl2' : null,
            gpuTimerPendingQueries: this.pendingGpuQueries.length,
            gpuTimerErrors: this.gpuTimerErrors,
            gpuDisjointDiscards: this.gpuDisjointDiscards,
            passSamplingEnabled: this.passSamplingEnabled,
            passes: Object.fromEntries(GPU_PASS_NAMES.map(name => {
                const ring = this._passResults[name];
                return [name, {
                    gpuMs: ring.gpuCount ? ring.gpuSum / ring.gpuCount : null,
                    cpuMs: ring.count ? ring.cpuSum / ring.count : null,
                    draws: ring.latest?.draws ?? null,
                    bytes: ring.latest?.bytes ?? null,
                    samples: ring.count,
                }];
            })),
            qualityTimingSource: this.qualityTimingSource,
            frameGapMs: this.frameGapMs ?? 0,
            textureBytes: this.textureBytes,
            residentTextureBytes: this.textureBytes,
            cachedTextureBytes: this._cachedTextureBytes,
            cachedTextureCapBytes: MAX_CACHED_TEXTURE_BYTES,
            cachedTextureCapExceeded: this._cachedTextureBytes > MAX_CACHED_TEXTURE_BYTES,
            cachedTextures: this._textureEntries.size,
            textureEvictions: this.textureEvictions,
            maxCachedTextureBytes: MAX_CACHED_TEXTURE_BYTES,
            maxCachedTextures: MAX_CACHED_TEXTURES,
            materialAttachments: 2,
            // 0.6 — live world particles drawn this frame (one instanced draw).
            particleInstances: this.particleInstances,
            occlusionScale: OCCLUSION_SCALE,
            bloomScale: BLOOM_SCALE,
            qualityLevel: quality.effectiveLevel,
            qualityReason: quality.lastDecisionReason,
            shedEffects: shedEffectsForLevel(quality.effectiveLevel),
            shedReason: quality.lastDecisionReason,
            qualityDegradationReason: quality.lastDegradationReason,
            qualityTransitionReason: quality.lastTransitionReason,
            qualityTransitionAtMs: quality.lastTransitionAtMs,
            qualityTransitionMetrics: quality.lastTransitionMetrics,
            qualityTransitions: quality.transitions,
            pacing: {
                refreshHz: quality.refreshHz,
                periodMs: quality.periodMs,
                budgetMs: quality.budgetMs,
                timerVeto: quality.timerVeto,
                missShare: quality.missShare,
                intervals: Math.min(quality.pacingCount, quality.options.pacingWindow),
                window: quality.options.pacingWindow,
                pending: quality.pending ? `${quality.pending.kind} from ${quality.pending.fromLevel}` : null,
                pacedLevel: quality.pacedLevel,
                coolDownUntilMs: quality.holdUntilMs,
                nextProbeAtMs: quality.nextProbeAtMs,
                sampledAtMs: quality.lastSampleAtMs,
            },
            lightAdmission: { ...this.lightAdmission },
            debugLoad: this._debugLoad
                ? { passes: this._debugLoad.passes, levels: this._debugLoad.levels, arms: this._debugLoad.schedule?.length ?? 0 }
                : null,
            resources: this.getResourceAccounting(),
            atlasRecords: this._sourceCensus?.atlasRecords || 0,
            individualRecords: this._sourceCensus?.individualRecords || 0,
            sourceBatchCount: this._sourceCensus?.batchCount || this.batches,
            sourceUploadBytes: this._sourceCensus?.uploadBytes || this.uploadBytes,
        };
    }

    getResourceAccounting() {
        if (this.suspended || !this.contextHealthy) {
            return { textures: {}, attachments: {}, buffers: {} };
        }
        let pinnedSourceBytes = 0;
        let evictableSourceBytes = 0;
        const atlasPages = [];
        for (const [name, entry] of this._textureEntries) {
            const bytes = entry.bytes || 0;
            const pinned = entry.lastUsedFrame === this.frames;
            if (pinned) pinnedSourceBytes += bytes;
            else evictableSourceBytes += bytes;
            if (name.includes('world-pilot') || name.includes('agent-frame-atlas')) {
                atlasPages.push({ name, width: entry.width, height: entry.height, bytes, pinned });
            }
        }
        const targetBytes = target => target ? target.width * target.height * 4 : 0;
        const depthBytes = target => target?.depthBuffer
            ? target.width * target.height * SCENE_DEPTH_BYTES_PER_PIXEL
            : 0;
        const attachmentBytes = targetBytes(this.sceneTarget) * 2 + depthBytes(this.sceneTarget)
            + targetBytes(this.bloomA) + targetBytes(this.bloomB) + targetBytes(this.occlusionTarget);
        const bufferBytes = (this.vertexBufferBytes || 0) + (this.particleBuffer ? this._particleBytes.byteLength : 0);
        const pinnedBytes = pinnedSourceBytes + attachmentBytes + bufferBytes;
        return {
            textures: { pinnedSources: pinnedSourceBytes, evictableSources: evictableSourceBytes },
            pinnedBytes,
            evictableBytes: evictableSourceBytes,
            totalBytes: pinnedBytes + evictableSourceBytes,
            atlasPages,
            liveBodyAtlas: atlasPages.find(page => page.name === 'agent-frame-atlas') || null,
            cachedSourceOverageBytes: Math.max(0, pinnedSourceBytes + evictableSourceBytes - MAX_CACHED_TEXTURE_BYTES),
            attachments: {
                sceneColor: targetBytes(this.sceneTarget),
                sceneEmission: targetBytes(this.sceneTarget),
                sceneDepth: depthBytes(this.sceneTarget),
                bloomA: targetBytes(this.bloomA),
                bloomB: targetBytes(this.bloomB),
                occlusion: targetBytes(this.occlusionTarget),
            },
            buffers: {
                vertices: this.vertexBufferBytes || 0,
                particles: this.particleBuffer ? this._particleBytes.byteLength : 0,
            },
        };
    }

    dispose() {
        if (this.disposed) return;
        this.disposed = true;
        this.canvas?.removeEventListener?.('webglcontextlost', this._onContextLost, false);
        this.canvas?.removeEventListener?.('webglcontextrestored', this._onContextRestored, false);
        globalThis.document?.removeEventListener?.('visibilitychange', this._onVisibilityChange);
        this.setDebugLoad(null);
        this._releaseGpuResources();
        this.contextHealthy = false;
        this.textureBytes = 0;
    }
}

export function createGpuWorldRenderer({ canvas, enabled = true } = {}) {
    if (!canvas?.getContext) return null;
    const renderer = new GpuWorldRenderer(canvas, { enabled });
    return renderer.supported ? renderer : null;
}
