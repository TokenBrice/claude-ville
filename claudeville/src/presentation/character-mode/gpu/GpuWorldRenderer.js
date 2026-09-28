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
    cloudCoveredShare,
    CLOUD_TILE_SIZE,
    CLOUD_TILE_WORLD_SCALE,
    CLOUD_FIELD_PERIOD,
    CLOUD_SECOND_OCTAVE,
    sortedCloudField,
    aerialPerspectiveStrength,
    EFFECT_BUDGET,
    GPU_PARTICLE_FLAGS,
    GPU_PARTICLE_INSTANCE_BYTES,
    GPU_PARTICLE_MOTIF_SIZE,
    GPU_PARTICLE_SHAPES,
    SMOKE_PUFF_LIT_GAIN,
    SMOKE_PUFF_SHADE_GAIN,
    GPU_RECORD_FLAGS,
    isSoftwareRasterizer,
} from './GpuWorldPolicy.js';
import { NEUTRAL_GRADE } from '../GradeEvaluator.js';
import {
    COAST_PALETTE,
    OCEAN_HORIZON_WORLD_Y,
    OPEN_SEA_BAND_DEPTH,
    OPEN_SEA_BAND_WEIGHTS,
    OPEN_SEA_DEEPEST,
    OPEN_SEA_LIGHT_REACH,
    OPEN_SEA_STOP_SEAM,
    SEA_SEAM_BAND,
    SEA_SEAM_OCTAVES,
    SEA_SEAM_PERIOD,
    SEA_SEAM_ROWS,
    openSeaHazeRows,
    openSeaSky,
    openSeaSquall,
    waterMoodFor,
} from '../CoastBake.js';
import { MAP_SIZE, TILE_HEIGHT, TILE_WIDTH } from '../../../config/constants.js';
import { ART_RAMPS } from '../../../config/artPalette.js';
import {
    createPostFxLadder,
    POST_FX_LEVELS,
} from '../postfx/PostFxLadder.js';
import { glslMaterialWeatherFunctions } from '../MaterialRegistry.js';
import { NEUTRAL_SOURCE_ENERGY, sourceEnergyFor } from '../AtmosphereState.js';
import { growTypedArray } from '../AssetManager.js';
import { particleMotifMask } from '../ParticleSystem.js';
import { baseWindX, cloudCourseDrift, gustinessFor, windAt } from '../Wind.js';

// 3.4 — the open sea's C-W3 gust field (R8, SEA_GUST_SIZE^2 over the view),
// refreshed on SEA_GUST_STEP_MS steps of the motion clock (an 8 Hz band).
const SEA_GUST_SIZE = 128;
const SEA_GUST_STEP_MS = 125;
const OPEN_SEA_ZERO4 = new Float32Array(4);
const OPEN_SEA_ZERO6 = new Float32Array(6);

const MAX_LIGHTS = 32;
// V5 / 2.1 — the resident loop's light role codes (u_lightShape.w, fed by
// PostFxFeed's LIGHT_ROLE_CODES): point (omni), aperture (lobed facade
// emitter), fixture (free-standing lamp), attention (its owner only).
const LIGHT_ROLE_POINT = 0;
const LIGHT_ROLE_ATTENTION = 3;
// 2.2 — the footprint march step count per ladder mode.
const FOOTPRINT_MARCH_STEPS = Object.freeze({ on: 8, 'four-steps': 4, off: 0 });
// 3.1 — dash presence of the palette cycle: near-shore swell and river
// current dashes, and deep-stop swell dashes inside a set (storm raises both
// to 0.7); SWELL_SET_SHARE of each deep crest's 48-texel runs carry dashes.
// Tuned against M7 (<= 35 % of deep water ever changes over 3 s, 2-5 % per
// step): see docs/motion-budget.md.
const NEAR_SHORE_DASH_DENSITY = 0.3;
const DEEP_DASH_DENSITY = 0.5;
const SWELL_SET_SHARE = 0.5;
// 3.2 — peak presence of path dashes at the path's centre, full strength.
const GLINT_DASH_DENSITY = 0.3;
// 3.2 — water ticks (6 Hz) a moon-path dash holds before it re-rolls.
const MOON_DASH_HOLD = 6;
// 3.2 — the pale day path (kind 2) is a broad sparse sparkle: its half-width
// starts at this many texels and grows NOON_GLINT_GROW_GAIN x faster down
// the frame than the gold and silver paths.
const GLINT_NOON_BASE = 14;
const NOON_GLINT_GROW_GAIN = 2.5;
// 3.3 / N3 — long swell contours (`seaContourRows`): lattice cell of the
// smooth field (world px along x, y) and its amplitude (world rows).
const SEA_CONTOUR_CELL = Object.freeze([520, 170]);
const SEA_CONTOUR_ROWS = 14;
// 3.4 — a cat's paw: where the ruffled gust passes SEA_PAW_THRESHOLD (a
// light clear-day breeze already lays sparse paws), SEA_PAW_DASH_BASE of
// its 3x1 dash cells (plus 0.6 x gust) catch the sky two stops lighter.
const SEA_PAW_THRESHOLD = 0.12;
const SEA_PAW_DASH_BASE = 0.16;
// 3.3 (a) — swell sets on the open sea: the static dashes gather in long
// 2:1 bands (SWELL_SET_PERIOD world rows along the swell's normal, the
// set taking SWELL_SET_SHARE_OPEN of it) at SWELL_SET_GAIN x presence,
// with calm gaps between at SWELL_GAP_GAIN x.
const SWELL_SET_PERIOD = 150;
const SWELL_SET_SHARE_OPEN = 0.38;
const SWELL_SET_GAIN = 1.7;
const SWELL_GAP_GAIN = 0.35;
// 3.2 — the C1 `seaPath` ramp as (hi, lo) pairs per u_glint kind, 0..1:
// 1 gold (sunrise / golden hour), 2 pale (day), 3 silver (moon).
function seaPathPair(lo, hi) {
    return [hi, lo].flatMap(hex => [1, 3, 5].map(at => parseInt(hex.slice(at, at + 2), 16) / 255));
}
const SEA_PATH_STOPS = Object.freeze({
    1: Object.freeze(seaPathPair(ART_RAMPS.seaPath[0], ART_RAMPS.seaPath[1])),
    2: Object.freeze(seaPathPair(ART_RAMPS.seaPath[2], ART_RAMPS.seaPath[3])),
    3: Object.freeze(seaPathPair(ART_RAMPS.seaPath[4], ART_RAMPS.seaPath[5])),
});
// V9 / B.1a — one instance per record, drawn as a 4-vertex TRIANGLE_STRIP
// with every attribute at divisor 1 (docs/material-channel-contract.md):
//   loc0 FLOAT  x4  rect (x, y, w, h), world px                  bytes  0-15
//   loc1 FLOAT  x4  uv rect (u0, v0, u1, v1)                            16-31
//   loc2 FLOAT  x4  (alpha, material, elevation, emissive)              32-47
//   loc3 USHORT x4  (reserved 0, gate x 65535), ramp, flags             48-55
//   loc4 USHORT x4  depth key, footY, frontCornerX, frontCornerY        56-63
//                   (receiver coordinates integer world px + 32768)
//   loc5 USHORT x2  (ownerSlot, landmarkId), vertexAttribIPointer        64-67
// Continuous surface values stay float32, so the frame is bit-exact with the
// six-vertex staging it replaced; the integer fields pack as uint16. A batch
// whose records all carry the default V9 tail (loc3-loc5: gate
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
    // 2 is free: 2.2 deleted the screen occlusion target.
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
    // 3.3 / 3.4 — the C-W3 gust field the in-map open water shares with the
    // composite's open sea (cat's paws).
    seaGust: 13,
});
export const PARTICLE_SAMPLER_UNITS = Object.freeze({ motifs: 0, cloudTile: 1 });
// 3.3 / 3.4 — the composite's open sea reads the cloud tile and the C-W3
// gust field on its own units.
export const COMPOSITE_SAMPLER_UNITS = Object.freeze({ scene: 0, bloom: 1, cloudTile: 2, seaGust: 3 });
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
const EMA_ALPHA = 0.1;
// 3.5's ramp table (11x3 RGBA = 132 B) and 3.3's ground-receiver field
// (2 x 256x144 RGBA8 = 294,912 B) are new resident bytes, so the evictable
// cached-source ceiling gives up exactly that much.
// B.2 — the ceiling is 160 MiB, not the shipped 48 MiB: the sources every
// frame samples already exceed 48 MiB, so the old cap was always "exceeded"
// and only evicted what the camera had just left (re-upload churn). Measured
// resident set, all of it sampled in the current frame: terrain bake 25.0 MB
// + four 2048² world-pilot channels 64.0 MB + ground fields ~10.5 MB +
// agent atlases (0.7 k² slots: 1.9 MB each; 4.7 walk strips at 840x3080:
// 9.9 MB each, three channels) = 105-111 MB at dense-100 / readme-showcase,
// 134-137 MB at dense-24 (2560 and 5120 wide).
const PALETTE_LUT_WIDTH = 11;
const PALETTE_LUT_HEIGHT = 3;
const PALETTE_LUT_BYTES = PALETTE_LUT_WIDTH * PALETTE_LUT_HEIGHT * 4;
const SPILL_FIELD_WIDTH = 256;
const SPILL_FIELD_HEIGHT = 144;
const SPILL_FIELD_BYTES = SPILL_FIELD_WIDTH * SPILL_FIELD_HEIGHT * 4 * 2;
const MAX_CACHED_TEXTURE_BYTES = 160 * 1024 * 1024 - PALETTE_LUT_BYTES - SPILL_FIELD_BYTES;
const MAX_CACHED_TEXTURES = 512;
const LOCAL_LIGHT_VISIBILITY_FLOOR = 0.04;
const DEFAULT_LIGHT_COLOR = Object.freeze([1, 0.78, 0.42]);
const GPU_PASS_NAMES = ['upload', 'scene', 'bloom', 'present'];
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
    return (record.emissiveGate ?? 1) >= 1
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
    // loc3.x is reserved (2.2 deleted the screen occlusion pass, its only
    // reader): staged as 0.
    u16[h] = 0;
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

// The shared record vertex stage.
function quadVertexSource() {
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
out vec2 v_uv;
out vec2 v_world;
out float v_alpha;
out float v_material;
out float v_elevation;
out float v_emissive;
out float v_gate;
out float v_ramp;
flat out vec2 v_originFrac;
flat out vec4 v_uvClamp;
flat out vec3 v_receiver;
flat out uvec2 v_identity;
flat out uint v_flags;
// 3.8 / 3.11 — a reflect record's mirror axis (world y of its rect base) and
// its rect height; zero for every other record.
flat out vec2 v_reflect;
void main() {
    // Strip corners (0,0) (1,0) (0,1) (1,1). Each coordinate is selected from
    // the staged rect, never interpolated, so every edge is the staged value.
    bool right = (gl_VertexID & 1) == 1;
    bool bottom = gl_VertexID >= 2;
    vec2 world = vec2(right ? a_rect.x + a_rect.z : a_rect.x, bottom ? a_rect.y + a_rect.w : a_rect.y);
    uint flags = uint(a_response.w + 0.5);
    // 3.8 / 3.11 — a \`reflect\` record is its source's water twin: the rect is
    // the source's own, mirrored here about its base (the waterline or the
    // feet), so the top row lands deepest and the uv runs unchanged.
    bool mirrored = (flags & ${GPU_RECORD_FLAGS.reflect}u) != 0u;
    float reflectBase = a_rect.y + a_rect.w;
    if (mirrored) world.y = 2.0 * reflectBase - world.y;
    v_reflect = mirrored ? vec2(reflectBase, a_rect.w) : vec2(0.0);
    vec2 screen = (world + u_camera.xy) * u_camera.z;
    vec2 clip = vec2(
        screen.x / max(1.0, u_resolution.x) * 2.0 - 1.0,
        1.0 - screen.y / max(1.0, u_resolution.y) * 2.0
    );
    // 0.6 — the painter depth key (0 = far plane, 65535 = nearest).
    gl_Position = vec4(clip, (1.0 - a_receiver.x / 65535.0) * 2.0 - 1.0, 1.0);
    v_uv = vec2(right ? a_uvRect.z : a_uvRect.x, bottom ? a_uvRect.w : a_uvRect.y);
    v_world = world;
    v_alpha = a_surface.x;
    v_material = a_surface.y;
    v_elevation = a_surface.z;
    v_emissive = a_surface.w;
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
// 3.4 — the cloud field is the tile at two scales, `max(n1, 0.9 n2)` with n2
// 1.75x larger and offset (GpuWorldPolicy CLOUD_SECOND_OCTAVE), so the
// field repeats only every CLOUD_FIELD_PERIOD (7168 world px), wider than a
// 5120 z1 view; the thresholds are calibrated on that combined field. The
// open sea (COMPOSITE_FRAGMENT) calls the same helpers on the world grid, so
// a cloud edge crosses the coastline with no seam and no hue step.
const ATMOSPHERE_COURSES_GLSL = `
uniform sampler2D u_cloudTile;
// xy: world-space drift offset (world px, wrapped to CLOUD_FIELD_PERIOD),
// z: darkening per course (0 = off).
uniform vec4 u_cloud;
// Noise thresholds for course 1/2/3 at the current cover.
uniform vec3 u_cloudThresholds;
// rgb: C2 horizon haze, a: strength at the top of the frame (0 = off).
uniform vec4 u_haze;
float cloudNoiseAt(vec2 cell) {
    vec2 p = cell + 0.5 + u_cloud.xy;
    float n1 = texture(u_cloudTile, fract(p / ${(CLOUD_TILE_WORLD_SCALE * CLOUD_TILE_SIZE).toFixed(1)})).r;
    float n2 = texture(u_cloudTile, fract((p / ${CLOUD_SECOND_OCTAVE.scale.toFixed(4)} + vec2(${CLOUD_SECOND_OCTAVE.offset.map(v => v.toFixed(1)).join(', ')}))
        / ${(CLOUD_TILE_WORLD_SCALE * CLOUD_TILE_SIZE).toFixed(1)})).r;
    return max(n1, n2 * ${CLOUD_SECOND_OCTAVE.weight.toFixed(3)});
}
// Solid courses, dithered only in a 1-2 texel seam at each edge: the field is
// smooth, so a fixed dither band in field units spread a Bayer checker over
// every gentle slope. Near a threshold (seamAt: any extra ceiling such as
// the sea's sunlit course) the field's slope over one texel, from two
// neighbour samples taken only there, sets the seam's half-width.
float cloudSeamField(vec2 cell, float n, float order, float seamAt) {
    float near = min(min(abs(n - u_cloudThresholds.x), abs(n - u_cloudThresholds.y)),
        min(abs(n - u_cloudThresholds.z), abs(n - seamAt)));
    if (near > 0.03) return n;
    float slope = max(abs(cloudNoiseAt(cell + vec2(1.0, 0.0)) - n), abs(cloudNoiseAt(cell + vec2(0.0, 1.0)) - n));
    return n + (order - 0.5) * 2.0 * slope;
}
float cloudCourseAt(float m) {
    return step(u_cloudThresholds.x, m) + step(u_cloudThresholds.y, m) + step(u_cloudThresholds.z, m);
}
// Slightly cool shade: blue loses less than red.
vec3 applyCloudCourse(vec3 color, float course) {
    return color * (vec3(1.0) - course * u_cloud.z * vec3(1.0, 0.96, 0.84));
}
// 48 solid haze courses down the upper frame; each hands to the next in a
// two-texel ordered seam (its height from the curve's slope at this row), so
// the haze never lays a full-field checker over flat water.
vec3 applyAerialHaze(vec3 color, float order, float cellCentreY, bool additive) {
    if (u_haze.a > 0.0) {
        float yTop = cellCentreY / max(1.0, u_resolution.y);
        float t = clamp((0.55 - yTop) / 0.55, 0.0, 1.0);
        float level = pow(t, 1.4) * u_haze.a * 48.0;
        float perTexel = 48.0 * u_haze.a * 1.4 * pow(max(t, 1e-4), 0.4) / (0.55 * max(1.0, u_resolution.y)) * max(1.0, u_camera.z);
        float seam = clamp(2.0 * perTexel, 1e-3, 1.0);
        float k = floor(level);
        float f = level - k;
        if (f > 1.0 - seam && (f - (1.0 - seam)) / seam > order) k += 1.0;
        float haze = k / 48.0;
        if (haze > 0.0) {
            float l = dot(color, vec3(0.2126, 0.7152, 0.0722));
            color = mix(color, mix(vec3(l), color, 0.8), min(1.0, haze * 8.0));
            color = additive ? color * (1.0 - haze) : mix(color, u_haze.rgb, haze);
        }
    }
    return color;
}
vec3 applyAtmosphereCourses(vec3 color, vec2 cell, float order, float cellCentreY, bool additive) {
    if (u_cloud.z > 0.0) color = applyCloudCourse(color, cloudCourseAt(cloudSeamField(cell, cloudNoiseAt(cell), order, 2.0)));
    return applyAerialHaze(color, order, cellCentreY, additive);
}`;
const ATMOSPHERE_COURSE_UNIFORM_NAMES = ['u_cloudTile', 'u_cloud', 'u_cloudThresholds', 'u_haze'];

// 3.4 — water mood (x: night, y: storm), CoastBake.waterMoodFor: night sits
// shallow water below lit ground in value, storm reads grey-green. The
// terrain bake stays phase-free; this recolour is the only time-of-day term.
// Shared by the in-map water (SCENE_FRAGMENT) and the open sea
// (COMPOSITE_FRAGMENT), so both recolour one stop to one value.
// CPU mirror: CoastBake.applyWaterMood (the Canvas twin).
const WATER_MOOD_GLSL = `
uniform vec2 u_waterMood;
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
}`;

// 3.1 / 3.2 — the sea's shared crest and path grammar, uniform-free so the
// in-map water (SCENE_FRAGMENT) and the open ocean (COMPOSITE_FRAGMENT)
// light the same dashes on the same step (M7: the ocean shares the phase).
// `p` is a world texel (world px), `tick` the 6 Hz water step
// floor(u_time * 0.006 * scale), `storm` 0/1.
//  - deepSwellLit: 3x1 dash cells present at `density` (0.7 in a storm), a
//    phase field over world texels (wavelength 22, 14 in a storm) stepped 16
//    times a period; the lead band is lit and the band behind it half-lit on
//    a 4x4 Bayer. Crests travel toward decreasing phase (up the screen, onto
//    the island's camera-facing shores). 0 unlit, 1 lit (the next shallower
//    stop), 2 storm whitecap (FOAM, one lit crest cell in four).
//  - glintDash: sparse 3x1 dashes under the sky body's screen x, half-width
//    5 + fragY * grow texels, re-hashed every tick; `texelPx` is backing px
//    per world texel. 0 none, 1 the lo seaPath stop, 2 the hi stop. The moon
//    (kind 3) lays a calmer path: longer 6x1 dashes at half the density, one
//    tone (lo), each dash holding for MOON_DASH_HOLD ticks on its own phase
//    (never a whole-path re-hash), thinning to the edge as weight squared
//    over 0.7 of the sun's width, so it tapers instead of ending in a cut.
//  - seaPathCap: a graded path stop held at HSL L <= 0.70, hue kept.
//  - openSeaDepth / openSeaStop: the open sea's stop at a world row (CoastBake
//    openSeaDepthAt / openSeaStopAt): solid stops, the next deeper one
//    dithered in over a two-texel seam. The in-map water uses it to know
//    which of its texels are open water (as deep as the open sea there).
export const SEA_SWELL_GLSL = `
float waterHash12(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
}
float waterBayer2(vec2 a) {
    a = floor(a);
    return fract(dot(a, vec2(0.5, a.y * 0.75)));
}
float waterBayer4(vec2 p) {
    return waterBayer2(0.5 * p) * 0.25 + waterBayer2(p);
}
float deepSwellLit(vec2 p, float tick, float storm, float density) {
    vec2 cell = floor(floor(p) / vec2(3.0, 1.0));
    if (waterHash12(cell) >= mix(density, 0.7, storm)) return 0.0;
    vec2 o = cell * vec2(3.0, 1.0);
    float wavelength = mix(22.0, 14.0, storm);
    float phase = dot(o, vec2(0.5, 1.0)) / wavelength + 0.35 * sin(o.x * 0.031) + 0.2 * sin(o.y * 0.07 + o.x * 0.013);
    float wave = phase + tick / 16.0;
    float band = fract(wave);
    bool lit = band < 0.0625 || (band < 0.125 && waterBayer4(floor(p)) >= 0.5);
    if (!lit) return 0.0;
    // Swell arrives in sets: each crest (its id is constant as it travels)
    // is broken into 48-texel runs along its length and SWELL_SET_SHARE of
    // them carry dashes, re-drawn for the next crest. Dense crest lines,
    // a calm sea: M7's ever-changed share stays near density x share.
    vec2 run = vec2(floor(wave), floor(dot(o, vec2(1.0, -0.5)) / 48.0));
    if (waterHash12(run + vec2(59.0, 11.0)) >= ${SWELL_SET_SHARE.toFixed(2)}) return 0.0;
    return storm > 0.5 && waterHash12(cell + vec2(17.0, 31.0)) < 0.25 ? 2.0 : 1.0;
}
float glintDash(vec2 p, vec2 fragPx, vec4 glint, float texelPx, float tick) {
    if (glint.z < 0.5 || glint.y <= 0.0) return 0.0;
    bool moon = glint.z > 2.5;
    // The pale day path is a broad sparse sparkle (3.2): a wider base under a
    // high sun (its grow rate is wider too, see _resolveWaterFx).
    float base = glint.z > 1.5 && !moon ? ${GLINT_NOON_BASE.toFixed(1)} : 5.0;
    float halfWidth = (base + fragPx.y * glint.w) * (moon ? 0.7 : 1.0);
    float weight = 1.0 - abs(fragPx.x - glint.x) / max(texelPx, 1e-3) / halfWidth;
    if (weight <= 0.0) return 0.0;
    if (moon) {
        vec2 cell = floor(floor(p) / vec2(6.0, 1.0));
        float life = floor((tick + floor(waterHash12(cell + vec2(37.0, 5.0)) * ${MOON_DASH_HOLD.toFixed(1)})) / ${MOON_DASH_HOLD.toFixed(1)});
        return waterHash12(cell + vec2(life * 5.0, life * 2.0)) < ${(GLINT_DASH_DENSITY * 0.5).toFixed(3)} * glint.y * weight * weight ? 1.0 : 0.0;
    }
    vec2 cell = floor(floor(p) / vec2(3.0, 1.0));
    if (waterHash12(cell + vec2(tick * 7.0, tick * 3.0)) >= ${GLINT_DASH_DENSITY.toFixed(2)} * glint.y * weight) return 0.0;
    return waterHash12(cell + vec2(5.0, tick * 11.0)) < weight ? 2.0 : 1.0;
}
vec3 seaPathCap(vec3 c) {
    float l = 0.5 * (max(c.r, max(c.g, c.b)) + min(c.r, min(c.g, c.b)));
    return l > 0.70 ? c * (0.70 / l) : c;
}
const float OPEN_SEA_HORIZON_Y = ${OCEAN_HORIZON_WORLD_Y.toFixed(1)};
// 3.3 / N3 — long swell contours: smooth world-anchored fields in whole
// world rows (every seam they bend is a stepped staircase), so the open
// sea's horizontal seams wander instead of ruling straight lines across the
// frame. No clock.
//  - seaSeamRows: the depth-stop seams (CoastBake seaSeamRowsAt is its exact
//    CPU twin, which the terrain bake's outer shelf and in-map clamp read):
//    one 1-D contour per seam band on an integer hash, periodic over
//    SEA_SEAM_PERIOD world px so the Canvas strip can tile it.
//  - seaContourRows: the reflection band's and the aerial haze's seams on
//    water (GPU only, the same function in the scene and the composite).
float seaSeamLattice(float k, float salt) {
    uint h = (uint(int(k)) * 1597334677u) ^ (uint(int(salt) + 4096) * 3812015801u);
    h = (h ^ (h >> 16u)) * 2246822519u;
    h ^= h >> 13u;
    return float(h >> 8u) / 16777216.0;
}
float seaSeamOctave(float x, float lx, float salt) {
    float cells = ${SEA_SEAM_PERIOD.toFixed(1)} / lx;
    float k = floor(x / lx);
    float f = (x - k * lx) / lx;
    float s = f * f * (3.0 - 2.0 * f);
    float k0 = k - floor(k / cells) * cells;
    float k1 = k0 + 1.0 < cells ? k0 + 1.0 : 0.0;
    float a = seaSeamLattice(k0, salt);
    float b = seaSeamLattice(k1, salt);
    return a + (b - a) * s;
}
float seaSeamRows(vec2 cell) {
    float t = cell.y - OPEN_SEA_HORIZON_Y;
    if (t < ${SEA_SEAM_BAND.toFixed(1)} * 0.5 || t >= ${SEA_SEAM_BAND.toFixed(1)} * 3.5) return 0.0;
    float band = floor((t + ${SEA_SEAM_BAND.toFixed(1)} * 0.5) / ${SEA_SEAM_BAND.toFixed(1)});
    float n = seaSeamOctave(cell.x, ${SEA_SEAM_OCTAVES[0].toFixed(1)}, band * 2.0) * 0.7
        + seaSeamOctave(cell.x, ${SEA_SEAM_OCTAVES[1].toFixed(1)}, band * 2.0 + 1.0) * 0.3;
    return floor((n - 0.5) * 2.0 * ${SEA_SEAM_ROWS.toFixed(1)} + 0.5);
}
float seaNoise(vec2 q) {
    vec2 i = floor(q);
    vec2 f = q - i;
    f = f * f * (3.0 - 2.0 * f);
    float a = waterHash12(i + vec2(71.0, 13.0));
    float b = waterHash12(i + vec2(72.0, 13.0));
    float c = waterHash12(i + vec2(71.0, 14.0));
    float d = waterHash12(i + vec2(72.0, 14.0));
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
float seaContourRows(vec2 cell) {
    float n = seaNoise(cell / vec2(${SEA_CONTOUR_CELL[0].toFixed(1)}, ${SEA_CONTOUR_CELL[1].toFixed(1)})) * 0.7
        + seaNoise(cell / vec2(${(SEA_CONTOUR_CELL[0] * 0.29).toFixed(1)}, ${(SEA_CONTOUR_CELL[1] * 0.36).toFixed(1)}) + vec2(17.0, 5.0)) * 0.3;
    return floor((n - 0.5) * 2.0 * ${SEA_CONTOUR_ROWS.toFixed(1)} + 0.5);
}
const float OPEN_SEA_REACH = ${OPEN_SEA_LIGHT_REACH.toFixed(1)};
const float OPEN_SEA_DEEPEST = ${OPEN_SEA_DEEPEST.toFixed(1)};
const float OPEN_SEA_SEAM = ${OPEN_SEA_STOP_SEAM.toFixed(5)};
// The open sea's continuous depth at a world texel, its stop seams bent by
// seaSeamRows (CoastBake openSeaDepthAt).
float openSeaDepth(vec2 cell) {
    return 2.0 + (OPEN_SEA_DEEPEST - 2.0) * clamp((cell.y + 0.5 + seaSeamRows(cell) - OPEN_SEA_HORIZON_Y) / OPEN_SEA_REACH, 0.0, 1.0);
}
float openSeaStop(float depth, float order) {
    float stop = floor(depth);
    float frac = depth - stop;
    if (stop < OPEN_SEA_DEEPEST && frac > 1.0 - OPEN_SEA_SEAM && (frac - (1.0 - OPEN_SEA_SEAM)) / OPEN_SEA_SEAM > order) stop += 1.0;
    return min(stop, OPEN_SEA_DEEPEST);
}`;

// 3.3 / 3.4 — the sea's weather courses, shared by the in-map open water
// (SCENE_FRAGMENT applyWaterState, texels as deep as the open sea on their
// row) and the open sea (COMPOSITE_FRAGMENT shadeOpenSea), so each crosses
// the map edge unbroken (no reach fade from the island diamond):
//  - the sunlit course: one stop lighter where the (seamed) cloud field is
//    below u_seaSunlit (0 = off: no clouds, no sun, or MINIMAL);
//  - C-W3 cat's paws: where a gust (bilinear R8 field, u_seaGustRect origin
//    and texel size; z 0 = calm) ruffled by a static octave of the cloud tile
//    stretched 3:1 along the wind crosses 0.24, the water is ruffled: hashed
//    3x1 dashes one stop lighter, denser with the gust, on an ordered edge.
//    No flat darkening (a soft dark patch reads as a smudge, not wind).
// Needs ATMOSPHERE_COURSES_GLSL (u_cloudTile) and waterHash12.
const SEA_WEATHER_GLSL = `
uniform float u_seaSunlit;
uniform sampler2D u_seaGust;
uniform vec4 u_seaGustRect;
float seaGustAt(vec2 cell) {
    if (u_seaGustRect.z <= 0.0) return 0.0;
    vec2 g = (cell + 0.5 - u_seaGustRect.xy) / (u_seaGustRect.zw * 128.0);
    if (any(lessThan(g, vec2(0.0))) || any(greaterThanEqual(g, vec2(1.0)))) return 0.0;
    return texture(u_seaGust, g).r;
}
// The gust field is coarse (a texel spans tens of world px): a static detail
// octave of the cloud tile, stretched along the wind, breaks its bilinear
// edges into streaky ruffled patches.
bool seaPawAt(vec2 cell, float gust, float order) {
    if (gust <= 0.0) return false;
    float ruffle = texture(u_cloudTile, fract((cell + vec2(517.0, 229.0)) / vec2(768.0, 256.0))).r;
    return gust + (ruffle - 0.5) * 0.36 + (order - 0.5) * 0.06 > ${SEA_PAW_THRESHOLD.toFixed(2)};
}
bool seaPawDash(vec2 cell, float gust) {
    return waterHash12(floor(cell / vec2(3.0, 1.0)) + vec2(61.0, 7.0)) < ${SEA_PAW_DASH_BASE.toFixed(2)} + 0.6 * gust;
}`;
const SEA_WEATHER_UNIFORM_NAMES = ['u_seaSunlit', 'u_seaGust', 'u_seaGustRect'];

// 2.7 — the Lighthouse beam (M22) lands on the sea, shared by the in-map
// water (SCENE_FRAGMENT applyWaterState) and the open sea (COMPOSITE_FRAGMENT
// shadeOpenSea) so the fan crosses the map edge with no seam. The lantern
// turns a bi-form lens: two fans 180 degrees apart lie on the ground plane
// from the lamp's foot at the tower base (world px, 2:1 iso depth), sweeping
// at the constant rate BuildingSprite.lighthouseBeam sets on the one motion
// clock, so one of them is always out over the sea while the other crosses
// the land (water only takes it). Each fan widens from the foot (near to far
// half-width) and its three SEARCHLIGHT_COURSES are the share of 3x1 dash
// cells each lights (near 0.9 from the tower's waterline out, mid 0.6, far
// 0.3 thinning to nothing at the fan's end), with an ordered 4x4 Bayer edge
// on the dash-cell grid, so every lit texel is a whole dash. Lit dashes take
// the C1 cool-white lampBeam low stops (near: mid stop, mid and far: low
// stop; never the seaPath gold, always under the T1 plate text); the band
// that steps outward every sheen step (u_beamShape.w) lifts a dash one stop.
// Reads no agent state; 0 by day (u_beamGround.w = 0).
// Needs waterHash12 (SEA_SWELL_GLSL).
function lampBeamStop(index) {
    const hex = ART_RAMPS.lampBeam[index];
    return `vec3(${[1, 3, 5].map(at => (parseInt(hex.slice(at, at + 2), 16) / 255).toFixed(4)).join(', ')})`;
}
const LIGHTHOUSE_BEAM_GLSL = `
// xy: the lamp's foot (world px), z: sweep angle, w: 1 while the lamps are lit.
uniform vec4 u_beamGround;
// x: fan length, y/z: near/far half-width (ground px), w: sheen step 0..2.
uniform vec4 u_beamShape;
// The three courses' outer ends (share of length) and dash shares.
uniform vec3 u_beamCourseEnds;
uniform vec3 u_beamCourseShares;
// The lamp's light on the water stays under the T1 plates: the near course
// takes the ramp's mid stop, the mid and far courses its low stop (a sheen
// dash lifts one stop), so a dash never reaches the plate text.
const vec3 BEAM_STOPS[3] = vec3[3](${lampBeamStop(0)}, ${lampBeamStop(0)}, ${lampBeamStop(1)});
float beamBayer2(vec2 p) {
    vec2 q = mod(floor(p), 2.0);
    return q.x == q.y ? (q.x > 0.5 ? 0.25 : 0.0) : (q.x > 0.5 ? 0.5 : 0.75);
}
float beamBayer4(vec2 p) {
    return beamBayer2(0.5 * p) * 0.25 + beamBayer2(p);
}
// Set by the scene's applyWaterState when this fragment is a beam-lit dash,
// so main() keeps its colour through the night grade.
bool lighthouseDash = false;
// One fan along dir: 0 unlit, else 1 + the BEAM_STOPS index (0 far .. 2
// near) for the dash cell at g (ground offset from the foot). The fan widens
// from the lamp's foot and its far course thins out to nothing, so it ends in
// scattered dashes, never a square cut.
float lighthouseFan(vec2 g, vec2 dir, float order, vec2 cell) {
    float along = dot(g, dir);
    float t = (along + order * 12.0) / u_beamShape.x;
    if (t <= 0.0 || t >= u_beamCourseEnds.z) return 0.0;
    float halfWidth = mix(u_beamShape.y, u_beamShape.z, clamp(along / u_beamShape.x, 0.0, 1.0));
    if (abs(dot(g, vec2(-dir.y, dir.x))) + order * 6.0 >= halfWidth) return 0.0;
    float course = t < u_beamCourseEnds.x ? 2.0 : t < u_beamCourseEnds.y ? 1.0 : 0.0;
    float share = course > 1.5
        ? u_beamCourseShares.x
        : course > 0.5
            ? u_beamCourseShares.y
            : u_beamCourseShares.z * clamp((u_beamCourseEnds.z - t) / max(0.01, u_beamCourseEnds.z - u_beamCourseEnds.y), 0.0, 1.0);
    if (waterHash12(cell + vec2(83.0, 19.0)) >= share) return 0.0;
    float sheen = mod(floor(along / 16.0) - u_beamShape.w, 3.0) < 0.5 ? 1.0 : 0.0;
    return 1.0 + min(2.0, course + sheen);
}
// 0 unlit, else 1 + the BEAM_STOPS index for the dash cell holding p.
float lighthouseSheen(vec2 p) {
    if (u_beamGround.w <= 0.0) return 0.0;
    vec2 cell = floor(p / vec2(3.0, 1.0));
    vec2 d = cell * vec2(3.0, 1.0) + vec2(1.5, 0.5) - u_beamGround.xy;
    vec2 g = vec2(d.x, d.y * 2.0);
    vec2 dir = vec2(cos(u_beamGround.z), sin(u_beamGround.z));
    float order = beamBayer4(cell) - 0.5;
    return max(lighthouseFan(g, dir, order, cell), lighthouseFan(g, -dir, order, cell));
}
vec3 lighthouseStop(float beam) {
    return BEAM_STOPS[int(clamp(beam - 1.0, 0.0, 2.0))];
}`;

// The water palette the scene pass compares against and writes (CoastBake
// COAST_PALETTE, 0..1). Constants, so a texel's membership is exact.
function glslRgb(rgb) {
    return `vec3(${rgb.map(channel => (channel / 255).toFixed(6)).join(', ')})`;
}
function glslRgbArray(name, list) {
    return `const vec3 ${name}[${list.length}] = vec3[${list.length}](${list.map(glslRgb).join(', ')});`;
}
const WATER_PALETTE_GLSL = [
    glslRgbArray('WATER_STOPS', COAST_PALETTE.stops),
    `const vec3 WATER_FOAM = ${glslRgb(COAST_PALETTE.foam)};`,
    `const vec3 WATER_FOAM_CREST = ${glslRgb(COAST_PALETTE.foamCrest)};`,
    `const vec3 WET_SAND = ${glslRgb(COAST_PALETTE.wetSand)};`,
    `const vec3 WET_SAND_DARK = ${glslRgb(COAST_PALETTE.wetSandDark)};`,
    glslRgbArray('SEABED_SPECKS', COAST_PALETTE.seabedSpecks),
    glslRgbArray('CAUSTICS', COAST_PALETTE.caustics),
    // The light cool cast every water texel takes (CPU mirror: CoastBake
    // WATER_CAST); the time-of-day hue is the C2 grade's job.
    'const vec3 WATER_CAST = vec3(0.94, 0.98, 1.03);',
].join('\n');

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
flat in vec2 v_reflect;
layout(location = 0) out vec4 outColor;
layout(location = 1) out vec4 outEmission;
uniform sampler2D u_albedo;
uniform sampler2D u_materialMap;
uniform sampler2D u_emissiveMap;
uniform bool u_hasMaterialMap;
uniform sampler2D u_occluderMap;
uniform bool u_hasOccluderMap;
// B.2 — V9 flag 32 (packedGeometry): the material map also carries the
// record's geometry (R material id, 255 = none; G height; B strength,
// 0 = none; A presence) in place of a separate occluder companion. Gated like
// the occluder upload it replaces (the occluder channel's frame toggle).
uniform bool u_packedGeometry;
uniform bool u_hasEmissiveMap;
uniform vec2 u_resolution;
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
// 2.2 — the footprint field (unit 6, FootprintField.js): u_footprintRect =
// (origin x, origin y, world px per texel), u_footprintSize its texels;
// u_marchSteps 0 turns the march off (MINIMAL, or no field yet).
uniform sampler2D u_footprint;
uniform vec3 u_footprintRect;
uniform ivec2 u_footprintSize;
uniform int u_marchSteps;
uniform int u_lightCount;
// V5 / 2.1 — admitted lights in world space: u_lights = (foot x, foot y,
// ground radius, intensity); u_lightShape = (emitter height above the foot,
// face normal nx, ng (0, 0 = omni), role code 0 point / 1 aperture /
// 2 fixture / 3 attention); u_lightIds = (owner slot, landmark id);
// u_lightColors = rgb + the envelope share.
uniform vec4 u_lights[32];
uniform vec4 u_lightShape[32];
uniform uvec2 u_lightIds[32];
uniform vec4 u_lightColors[32];
// 3.1 — the emissive-core share of the shared source-energy envelope. The
// spill/reflection share rides each light's own alpha channel (staged on the
// CPU) so action-needed overlays stay outside this budget, and the bloom share
// is applied once in the composite. One envelope, three consumers.
uniform float u_coreEnergy;
// 3.1 / 3.6 — the coast lattice fields, one texel per 2x2 world-px coast
// cell (CoastBake bakeWaterFields): unit 7 cycle offset (R8: 0-15 shoreward
// swell band, 16-31 river current band, 255 none), unit 8 coast field (RG8:
// R = sd * 64 + 128 in tiles, > 0 water; G = COAST_FIELD_FLAGS bits 1
// reflection, 2 swash-eligible, 4 painted water, 8 wet sand). u_coastRect =
// (x0, y0, cols, rows) in world px / cells; z == 0 means absent.
uniform sampler2D u_cycleOffset;
uniform sampler2D u_coastField;
uniform vec4 u_coastRect;
// x: the water clock's scale (u_motionScale; 0 under reduced motion and at
// MINIMAL = the static frame), y: precipitation for rain rings (0 = none),
// z: 3.10 caustics on, w: 3.6 swash on.
uniform vec4 u_waterFx;
// 3.2 — the sky body's path: (screenX backing px, strength, kind 0 off /
// 1 gold / 2 pale / 3 silver, grow = texels of half-width per backing row).
uniform vec4 u_glint;
// The active kind's two raw seaPath stops: [0] hi, [1] lo.
uniform vec3 u_glintStops[2];
// True only for the terrain-cache batch: the swash and wet band touch the
// baked ground, never a sprite standing on it.
uniform bool u_terrainBatch;
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
// 3.2 — bit i is set when admitted light i lays a wet-ground reflection: the
// first u_wetReflectionCount non-attention lights in admission order.
uniform uint u_wetMask;
// 5.2 — puddles on the terrain record only (u_puddleGround): GroundBake's R8
// site mask (unit 11, one byte per 2x1-world-px texel over u_puddleRect =
// origin xy, cols, rows) holds water where mask >= 1 - u_puddles, the C-W2
// ground history's puddle level. u_puddleSky: the graded sky palette's
// [upper band, horizon] the water reflects.
uniform sampler2D u_puddleMask;
uniform vec4 u_puddleRect;
uniform float u_puddles;
uniform vec3 u_puddleSky[2];
uniform bool u_puddleGround;

float materialNear(float value, float target) {
    return 1.0 - step(0.45, abs(value - target));
}

// 2.2 — world-locked footprint occlusion. The RG8 field on unit 6 holds, per
// 4x4-world-px ground texel, the tallest occluder standing there (R, world
// px) and its landmark id (G). The ground segment receiver foot -> light foot
// is marched in u_marchSteps steps (FULL 8, REDUCED 4, MINIMAL 0) while the
// ray rises from the receiver's height to the light's. A sample on the
// receiver's own landmark or the light's own landmark, or within 10 world px
// of a fixture's foot, never blocks: a facade never shadows its own window
// and a lamp post never shadows its lamp. Blocked when the field stands more
// than 2 world px above the ray.
float footprintBlocked(vec2 from, vec2 to, float fromH, float toH, uint ownLandmark, uint lightLandmark, bool fixture) {
    float steps = float(u_marchSteps);
    for (int s = 1; s <= 8; s++) {
        if (s > u_marchSteps) break;
        float t = float(s) / (steps + 1.0);
        vec2 p = mix(from, to, t);
        if (fixture && distance(p, to) < 10.0) continue;
        ivec2 cell = ivec2(floor((p - u_footprintRect.xy) / u_footprintRect.z));
        if (cell.x < 0 || cell.y < 0 || cell.x >= u_footprintSize.x || cell.y >= u_footprintSize.y) continue;
        vec2 field = texelFetch(u_footprint, cell, 0).rg;
        uint landmark = uint(field.g * 255.0 + 0.5);
        if (landmark != 0u && (landmark == ownLandmark || landmark == lightLandmark)) continue;
        if (field.r * 255.0 > mix(fromH, toH, t) + 2.0) return 1.0;
    }
    return 0.0;
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

float puddleAt(ivec2 cell) {
    if (cell.x < 0 || cell.y < 0 || cell.x >= int(u_puddleRect.z) || cell.y >= int(u_puddleRect.w)) return 0.0;
    float mask = texelFetch(u_puddleMask, cell, 0).r;
    return mask > 0.0 && mask >= 1.0 - u_puddles ? 1.0 : 0.0;
}

// 5.2 — a puddle reflects the graded sky in stepped opaque courses on the
// ground's own 2x1 texel grid: a dark bank lip on the far (upper) rim, the
// sky body, and a sparse horizon glint along the near rim. The reflection
// is capped a little above the wet ground around it, so it is never the
// brightest thing on the street (lamp pools and marks stay above it).
vec3 applyPuddle(vec3 color, vec2 world) {
    vec2 local = world - u_puddleRect.xy;
    ivec2 cell = ivec2(floor(local.x * 0.5), floor(local.y));
    if (puddleAt(cell) < 0.5) return color;
    float groundLuma = dot(color, GRADE_LUMA);
    float cap = min(0.56, groundLuma * 1.30 + 0.06);
    vec3 body = u_puddleSky[0];
    float bodyLuma = dot(body, GRADE_LUMA);
    if (bodyLuma > cap) body *= cap / max(bodyLuma, 1e-4);
    // One course toward the street it lies in: the reflection is dim water,
    // not a hole cut to the sky.
    body = mix(body, color, 0.28);
    if (puddleAt(cell + ivec2(0, -1)) < 0.5) return color * 0.64;
    if (puddleAt(cell + ivec2(0, 1)) < 0.5) {
        float glint = fract(sin(dot(vec2(cell), vec2(12.9898, 78.233))) * 43758.5453);
        if (glint < 0.42) {
            vec3 edge = u_puddleSky[1];
            float edgeLuma = dot(edge, GRADE_LUMA);
            float edgeCap = min(0.62, cap + 0.06);
            if (edgeLuma > edgeCap) edge *= edgeCap / max(edgeLuma, 1e-4);
            return edge;
        }
    }
    // The shallow rim (the last 0.12 of the level above this texel's
    // threshold) lets more of the street through: the puddle reads as a
    // dish that dries from its edge.
    float depth = texelFetch(u_puddleMask, cell, 0).r - (1.0 - u_puddles);
    return depth < 0.12 ? mix(body, color, 0.5) : body;
}

${WATER_MOOD_GLSL}

${SEA_SWELL_GLSL}
${SEA_WEATHER_GLSL}
${LIGHTHOUSE_BEAM_GLSL}

${WATER_PALETTE_GLSL}

bool sameColour(vec3 a, vec3 b) {
    return all(lessThan(abs(a - b), vec3(0.0019)));
}

// Index of the CoastBake depth stop an UNGRADED albedo is (0 shallowest ..
// 4 deepest), or -1: a texel cycles only by exact match, so reflections,
// dither blends, foam and flight-frame mixes are never recoloured.
int waterStopIndex(vec3 c) {
    for (int k = 0; k < ${COAST_PALETTE.stops.length}; k++) {
        if (sameColour(c, WATER_STOPS[k])) return k;
    }
    return -1;
}

// The stop a signed distance (tiles) bakes to, ignoring river/lagoon caps
// and the boundary dither (CoastBake DEPTH_BOUNDS). Index into WATER_STOPS.
int waterStopForSd(float sd) {
    return int(step(0.30, sd) + step(0.78, sd) + step(1.38, sd) + step(2.15, sd));
}

// 3.6 — the coast field at a world point; false outside the lattice or when
// the field is absent (MINIMAL, no coast). sd in tiles, flags as above.
bool coastFieldAt(vec2 world, out float sd, out uint flags) {
    sd = 0.0;
    flags = 0u;
    if (u_coastRect.z <= 0.0) return false;
    ivec2 cell = ivec2(floor((world - u_coastRect.xy) * 0.5));
    if (cell.x < 0 || cell.y < 0 || cell.x >= int(u_coastRect.z) || cell.y >= int(u_coastRect.w)) return false;
    vec2 field = texelFetch(u_coastField, cell, 0).rg;
    sd = (floor(field.r * 255.0 + 0.5) - 128.0) / 64.0;
    flags = uint(field.g * 255.0 + 0.5);
    return true;
}

float cycleOffsetAt(vec2 world) {
    if (u_coastRect.z <= 0.0) return 255.0;
    ivec2 cell = ivec2(floor((world - u_coastRect.xy) * 0.5));
    if (cell.x < 0 || cell.y < 0 || cell.x >= int(u_coastRect.z) || cell.y >= int(u_coastRect.w)) return 255.0;
    return floor(texelFetch(u_cycleOffset, cell, 0).r * 255.0 + 0.5);
}

// 3.7 — the baked static reflections ripple by whole texel rows: on the
// terrain's reflection cells (3.6 G flag 1) each world row takes a one-texel
// shift left or right on two of eight 2 Hz steps, never toward a texel that
// is not itself a reflection cell (so land never slides onto the water). The
// caller runs it only on the water clock (a still frame under reduced motion
// and at MINIMAL).
vec2 reflectionRippleUv(vec2 uv, float uvStepX) {
    float sd;
    uint flags;
    if (!coastFieldAt(v_world, sd, flags) || (flags & 1u) == 0u) return uv;
    float row = floor(v_world.y);
    float phase = mod(floor(waterHash12(vec2(row, 7.0)) * 8.0) + floor(u_time * 0.002 * u_waterFx.x), 8.0);
    float dx = phase < 0.5 ? -1.0 : (abs(phase - 4.0) < 0.5 ? 1.0 : 0.0);
    if (dx == 0.0) return uv;
    float shiftedSd;
    uint shiftedFlags;
    if (!coastFieldAt(v_world + vec2(dx, 0.0), shiftedSd, shiftedFlags) || (shiftedFlags & 1u) == 0u) return uv;
    return vec2(clamp(uv.x + dx * uvStepX, v_uvClamp.x, v_uvClamp.z), uv.y);
}

// 3.6 — lapping swash on the baked shore (terrain batch, swash cells only):
// an 8-step cycle of 200 ms (in 4, out 3, hold 1). Seaward the foam sheet
// grows through four lattice steps (FOAM, a FOAM_CREST front, a Bayer
// FOAM wash edge) and falls back; up the beach the reach it left is wet
// sand two ramp steps darker, then one, then dry. Only exact shore colours
// change (stops, foam, the sand ramp, wet sand); roads, plazas, footprints
// and bridges are excluded by the bake's swash flag.
vec3 applyCoastSwash(vec3 color, vec2 px) {
    float sd;
    uint flags;
    if (!coastFieldAt(px, sd, flags) || (flags & 2u) == 0u) return color;
    float cyc = mod(floor(u_time * 0.005 * u_waterFx.x), 8.0);
    float reach = cyc < 4.0 ? cyc : (cyc < 7.0 ? 6.0 - cyc : 0.0);
    if (sd > 0.0) {
        if (waterStopIndex(color) < 0 && !sameColour(color, WATER_FOAM) && !sameColour(color, WATER_FOAM_CREST)) {
            return color;
        }
        float front = 0.05 + reach * 0.035;
        if (sd < front - 0.035) return WATER_FOAM;
        if (sd < front) return WATER_FOAM_CREST;
        if (sd < front + 0.06 && waterBayer4(floor(px)) < 0.5) return WATER_FOAM;
        return color;
    }
    float extent = cyc < 4.0 ? cyc : 3.0;
    float darker = cyc < 4.5 ? 2.0 : (cyc < 6.5 ? 1.0 : 0.0);
    if (darker < 0.5 || sd <= -0.02 - extent * 0.035) return color;
    if (sameColour(color, WET_SAND_DARK)) return color;
    if (sameColour(color, WET_SAND)) return WET_SAND_DARK;
    // The ground bake's beach (the sand ramp under its drift, AO and far-row
    // haze) is never one exact colour: take any warm, light ground texel.
    // Grass, stone and timber fail the test and stay dry.
    bool beach = color.r > color.b + 0.12 && color.r >= color.g && dot(color, vec3(0.2126, 0.7152, 0.0722)) > 0.45;
    if (beach) return darker > 1.5 ? WET_SAND_DARK : WET_SAND;
    return color;
}

// 3.9 — one rain ring pixel at world texel p: 12x6-texel cells (8x4 in a
// storm), active per life when hash < 0.55 x precipitation, a 5-stage life
// on 7 Hz steps (dot -> pair -> 2:1 ring -> wide ring -> none; storm cells
// skip the wide ring). The static frame is a fixed 20 % set of rings.
bool rainRingAt(vec2 p, float precipitation, float storm, float clock) {
    vec2 size = mix(vec2(12.0, 6.0), vec2(8.0, 4.0), storm);
    vec2 cell = floor(p / size);
    vec2 local = p - cell * size;
    float seed = waterHash12(cell + vec2(41.0, 7.0));
    float stage = 2.0;
    float life = 0.0;
    if (clock > 0.0) {
        float s = floor(u_time * 0.007 * clock) + floor(seed * 5.0);
        life = floor(s / 5.0);
        stage = mod(s, 5.0);
        if (waterHash12(cell + vec2(life * 1.7, 3.1)) >= 0.55 * precipitation) return false;
    } else if (seed >= min(0.20, 0.55 * precipitation)) {
        return false;
    }
    if (stage > 3.5 || (storm > 0.5 && stage > 2.5)) return false;
    vec2 room = storm > 0.5 ? vec2(2.0, 1.0) : vec2(4.0, 2.0);
    vec2 jitter = vec2(waterHash12(cell + vec2(life, 13.0)), waterHash12(cell + vec2(29.0, life)));
    vec2 centre = room + floor(jitter * (size - room * 2.0));
    vec2 d = abs(local - centre);
    if (stage < 0.5) return d.x < 0.5 && d.y < 0.5;
    if (stage < 1.5) return d.y < 0.5 && abs(d.x - 1.0) < 0.5;
    if (stage < 2.5) return (abs(d.y - 1.0) < 0.5 && d.x < 1.5) || (d.y < 0.5 && abs(d.x - 2.0) < 0.5);
    return (abs(d.y - 2.0) < 0.5 && d.x < 2.5) || (abs(d.y - 1.0) < 0.5 && abs(d.x - 3.0) < 0.5)
        || (d.y < 0.5 && abs(d.x - 4.0) < 0.5);
}

// 3.10 — a calm caustic net over the clear-day shallows: two opposing iso
// phase fields (wavelengths 9 and 13) drifting one eighth per 4 Hz step,
// lit where either crosses its 0.92 band.
bool causticAt(vec2 p, float clock) {
    float t8 = mod(floor(u_time * 0.004 * clock), 8.0) / 8.0;
    float a = (p.x * 0.5 + p.y) / 9.0 + 0.45 * sin((p.x * 0.5 - p.y) * 0.13) + t8;
    float b = (p.y - p.x * 0.5) / 13.0 + 0.45 * sin((p.x * 0.5 + p.y) * 0.09) - t8;
    return fract(a) >= 0.92 || fract(b) >= 0.92;
}

// Today's static water frame (the reduced-motion and MINIMAL crest frame):
// sparse 3x1 dashes in 8x4 cells (6x3 in a storm) brightened on their
// phase-0 set, faded with depth. Kept verbatim so reduced motion is unchanged.
vec3 staticWaterDashes(vec3 color, vec2 px) {
    float depthLuma = dot(color, vec3(0.2126, 0.7152, 0.0722));
    color = applyWaterMood(color);
    float storm = step(0.5, u_weather.z);
    vec2 cellSize = mix(vec2(8.0, 4.0), vec2(6.0, 3.0), storm);
    vec2 cell = floor(px / cellSize);
    vec2 local = floor(px) - cell * cellSize;
    float seed = fract(sin(dot(cell, vec2(12.9898, 78.233))) * 43758.5453);
    float dashX = floor(seed * (cellSize.x - 2.0));
    float dashY = floor(fract(seed * 7.13) * cellSize.y);
    float present = step(fract(seed * 31.7), mix(0.30, 0.55, storm));
    float onDash = present * step(dashX, local.x) * step(local.x, dashX + 2.0) * (1.0 - step(0.5, abs(local.y - dashY)));
    float lit = 1.0 - step(0.5, mod(floor(seed * 4.0), 4.0));
    float contrast = mix(0.10, 0.16, storm);
    contrast = mix(contrast, min(contrast, 0.06), u_overcast * (1.0 - storm));
    contrast *= clamp((depthLuma - 0.27) / 0.15, mix(0.15, 0.35, storm), 1.0);
    return color * WATER_CAST * (1.0 + contrast * onDash * lit);
}

// 3.1 / 3.2 / 3.9 / 3.10 — the resident water state on ungraded albedo.
// Palette-true cycling (V4): a lit texel takes the next shallower depth
// stop, FOAM_CREST on the two shallowest, FOAM for a storm whitecap; a rain
// ring one stop lighter; the shallows show seabed specks and, on clear days,
// a caustic half step; the sun/moon path takes a seaPath stop and leaves
// through \`seaPath\` (it skips the water mood and the saturation cap).
// 3.3 / 3.4 — open water (a texel as deep as the open sea on its row) takes
// the open sea's sunlit course and cat's paws (SEA_WEATHER_GLSL) exactly as
// the composite does, so they cross the map edge unbroken; a sunlit texel's
// colours then step from the stop one lighter.
vec3 applyWaterState(vec3 color, vec2 px, out bool seaPath) {
    seaPath = false;
    // The material map is quarter resolution: a coast block can hold sand or
    // foam pixels. Water stops are teal/blue-dominant; anything else keeps
    // its land response.
    if (color.b < color.r + 0.02 || color.g < color.r) {
        // 3.7 — a baked reflection of warm timber or sandstone is still water:
        // it takes the night and storm mood like the stops around it.
        float sd;
        uint flags;
        if (u_terrainBatch && coastFieldAt(px, sd, flags) && (flags & 1u) != 0u) {
            return applyWaterMood(color) * WATER_CAST;
        }
        return color;
    }
    int stop = waterStopIndex(color);
    float clock = u_waterFx.x;
    vec2 p = floor(px);
    if (stop < 0) return clock <= 0.0 ? staticWaterDashes(color, px) : applyWaterMood(color) * WATER_CAST;
    float storm = step(0.5, u_weather.z);
    float deepTick = floor(u_time * 0.006 * clock);
    // 3.2 — the path, on top of everything below it. Its screen terms read
    // the texel's centre pixel (as the composite does), so every dash is
    // whole texels of one tone at any zoom.
    float glint = glintDash(p, (p + 0.5 + u_camera.xy) * u_camera.z, u_glint, u_camera.z, deepTick);
    if (glint > 0.5) {
        seaPath = true;
        return u_glintStops[glint > 1.5 ? 0 : 1];
    }
    // 2.7 — the Lighthouse fan's lit dashes, under the sky body's path.
    float beam = lighthouseSheen(p);
    if (beam > 0.5) {
        seaPath = true;
        lighthouseDash = true;
        return lighthouseStop(beam);
    }
    int base = stop;
    bool pawDash = false;
    if (stop >= 2) {
        float order = waterBayer4(p);
        if (float(stop) >= openSeaStop(openSeaDepth(p), order)) {
            if (u_seaSunlit > 0.0 && cloudSeamField(p, cloudNoiseAt(p), order, u_seaSunlit) < u_seaSunlit) base = stop - 1;
            float gust = seaGustAt(p);
            if (seaPawAt(p, gust, order)) pawDash = seaPawDash(p, gust);
        }
    }
    if (base != stop) color = WATER_STOPS[base];
    int lighter = max(base - 1, 0);
    vec3 shallower = base <= 1 ? WATER_FOAM_CREST : WATER_STOPS[lighter];
    if (u_waterFx.y > 0.0 && rainRingAt(p, u_waterFx.y, storm, clock)) {
        return applyWaterMood(base == 0 ? WATER_FOAM : WATER_STOPS[lighter]) * WATER_CAST;
    }
    bool shallows = stop <= 1;
    if (shallows && waterHash12(floor(p / vec2(2.0, 1.0)) + vec2(3.0, 71.0)) < 0.04) {
        return applyWaterMood(SEABED_SPECKS[stop]) * WATER_CAST;
    }
    if (pawDash) return applyWaterMood(WATER_STOPS[max(base - 2, 0)]) * WATER_CAST;
    if (clock <= 0.0) {
        if (shallows && u_waterFx.z > 0.0 && causticAt(p, 0.0)) return applyWaterMood(CAUSTICS[stop]) * WATER_CAST;
        return staticWaterDashes(color, px);
    }
    // 3.1 — crests on 3x1 dash cells, the whole dash read at its origin.
    vec2 cell = floor(p / vec2(3.0, 1.0));
    vec2 origin = cell * vec2(3.0, 1.0);
    float offset = cycleOffsetAt(origin);
    float course = 0.0;
    if (offset < 31.5) {
        // Near shore and river current: lit on course entries 14 (the lead,
        // FOAM_CREST on the shallowest stops) and 15, stepping every 250 ms.
        if (waterHash12(cell) < mix(${NEAR_SHORE_DASH_DENSITY.toFixed(2)}, 0.7, storm)) {
            float entry = mod(mod(offset, 16.0) + floor(u_time * 0.004 * clock), 16.0);
            course = entry > 14.5 ? 1.0 : (entry > 13.5 ? 2.0 : 0.0);
            if (course > 0.0 && storm > 0.5 && waterHash12(cell + vec2(17.0, 31.0)) < 0.25) course = 3.0;
        }
    } else if (stop >= 2) {
        float lit = deepSwellLit(p, deepTick, storm, stop >= 3 ? ${DEEP_DASH_DENSITY.toFixed(2)} : ${NEAR_SHORE_DASH_DENSITY.toFixed(2)});
        course = lit > 1.5 ? 3.0 : lit;
    }
    if (course > 2.5) return applyWaterMood(WATER_FOAM) * WATER_CAST;
    if (course > 1.5) return applyWaterMood(shallower) * WATER_CAST;
    if (course > 0.5) return applyWaterMood(WATER_STOPS[lighter]) * WATER_CAST;
    if (shallows && u_waterFx.z > 0.0 && causticAt(p, clock)) return applyWaterMood(CAUSTICS[stop]) * WATER_CAST;
    return applyWaterMood(color) * WATER_CAST;
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
    // 2.1 — one source texel along world +x (a mirrored record's u runs
    // backwards), for the body rim; taken before any non-uniform branch.
    float uvStepX = (dFdx(v_uv.x) < 0.0 ? -1.0 : 1.0) / float(textureSize(u_albedo, 0).x);
    // 3.8 / 3.11 — reflect records (hull and body water twins): only over
    // painted water (3.6's coast field, flag 4), every fifth row dropped, a
    // whole-texel row ripple on the shared palette tick (a fixed per-row
    // offset under reduced motion), three Bayer alpha courses by depth below
    // the axis and 38 % toward the local water stop. No render target.
    bool reflectRecord = (v_flags & ${GPU_RECORD_FLAGS.reflect}u) != 0u;
    float reflectRow = 0.0;
    float reflectSd = 0.0;
    if (reflectRecord) {
        reflectRow = floor(v_world.y - v_reflect.x);
        if (mod(reflectRow, 5.0) > 3.5) discard;
        uint reflectFlags = 0u;
        if (!coastFieldAt(v_world, reflectSd, reflectFlags) || (reflectFlags & 4u) == 0u) discard;
        float tick = u_motionScale <= 0.0 ? 0.0 : floor(u_time * 0.004 * u_motionScale);
        float ripple = clamp(floor(1.5 * sin(reflectRow * 0.9 + tick * 0.7)), -1.0, 1.0);
        uv.x = clamp(uv.x + ripple * uvStepX, v_uvClamp.x, v_uvClamp.z);
    }
    if (u_terrainBatch && u_waterFx.x > 0.0) uv = reflectionRippleUv(uv, uvStepX);
    vec4 albedo = texture(u_albedo, uv);
    float alpha = albedo.a * v_alpha;
    if (alpha < 0.01) discard;
    if (reflectRecord) {
        float course = clamp(floor(reflectRow / max(1.0, v_reflect.y) * 3.0 + bayer4(floor(v_world)) - 0.5), 0.0, 2.0);
        alpha *= course < 0.5 ? 0.42 : course < 1.5 ? 0.28 : 0.16;
        albedo.rgb = mix(albedo.rgb, WATER_STOPS[waterStopForSd(reflectSd)], 0.38);
    }
    vec4 sidecar = u_hasMaterialMap ? texture(u_materialMap, uv) : vec4(0.0);
    vec4 authoredEmission = u_hasEmissiveMap ? texture(u_emissiveMap, uv) : vec4(0.0);
    bool packedMap = (v_flags & ${GPU_RECORD_FLAGS.packedGeometry}u) != 0u;
    float materialId = floor(sidecar.r * 255.0 + 0.5);
    float material = sidecar.a > 0.0 && !(packedMap && materialId > 254.5) ? materialId : v_material;
    float emissive = v_emissive;
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
    vec4 geometry = packedMap
        ? (u_packedGeometry && sidecar.b > 0.0 ? vec4(sidecar.g, sidecar.b, 0.0, 1.0) : vec4(0.0))
        : u_hasOccluderMap ? texture(u_occluderMap, uv) : vec4(0.0);
    // 2.3 — a surface-coded landmark (V9 flag 16) carries the true height
    // above ground / 255 in R and its face and height code in B; its fog lift
    // runs over 128 world px (the old R was a row ramp reaching 1 at the
    // sprite's top). Other records keep their authored elevation.
    bool surfaceCoded = geometry.a > 0.0 && (v_flags & ${GPU_RECORD_FLAGS.surfaceCode}u) != 0u;
    float elevation = geometry.a > 0.0
        ? (surfaceCoded ? min(1.0, geometry.r * 255.0 / 128.0) : geometry.r)
        : v_elevation;
    vec2 px = vec2(gl_FragCoord.x, u_resolution.y - gl_FragCoord.y);
    vec3 color = albedo.rgb;
    // Clear weather is the overwhelmingly common case. Avoid the ordered
    // glint/material classification work when every weather contribution is
    // mathematically zero; rainy output remains byte-for-byte equivalent.
    // Water is never "wet": its storm/rain look is the water mood (mirrored
    // by the outer ocean), so the island's sea and the ocean stay one value.
    bool waterMaterial = materialNear(material, 8.0) > 0.5;
    // 3.6 — the swash laps the baked shore before any weather darkening.
    if (u_terrainBatch && u_waterFx.w > 0.0) color = applyCoastSwash(color, v_world);
    if (!waterMaterial && (u_weather.x > 0.001 || u_wetness > 0.001)) color = applyMaterialWeather(color, material, v_world);
    bool seaPath = false;
    // V6 — the water cap holds the sea's own stops. A sprite record carrying
    // the water material (a red buoy) and a baked full-colour mirror (3.7)
    // keep their colour: only water-hued texels (applyWaterState's own gate)
    // are capped.
    bool waterHue = waterMaterial && !(color.b < color.r + 0.02 || color.g < color.r);
    if (waterMaterial) color = applyWaterState(color, v_world, seaPath);
    color = applyAuthoredSunBand(color, material);
    // 1.2 — the pools light the ungraded surface, so warm light shows the real
    // cobble, grass and wall texture instead of a desaturated night albedo.
    vec3 poolAlbedo = color;
    // 1.1 — C2 time-of-day and weather grade, before any local light or
    // authored emission.
    color = applyTimeGrade(color, !u_additive);
    // V6 — graded water stays quiet at every hour (CoastBake's outer ocean
    // takes the same cap, so the two still meet without a seam). The 3.2
    // path is the one exception (M7): its seaPath stop keeps its colour and
    // is held at HSL L <= 0.70 instead.
    if (waterHue) color = seaPath ? seaPathCap(color) : capSaturation(color, WATER_MAX_SATURATION);
    // 2.7 — a Lighthouse-lit dash is the lamp's own light (like 1.3's
    // emitters below): it keeps its lampBeam stop (okL <= 0.83) instead of
    // the night Purkinje grey.
    if (lighthouseDash) color = poolAlbedo;
    // 5.2 — puddles take the graded sky over the graded street.
    if (u_puddleGround && u_puddles > 0.0) color = applyPuddle(color, v_world);
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
    // V5 / V9 — the receiver: this art pixel's ground point, its height above
    // it and which way it faces, all in world px. Class 0 faces up (terrain
    // and every ground-self record, a landmark's apron, 2.3 decks, stairs and
    // roofs), 1 is a landmark wall facing its face's normal, 2 a body (fill
    // on the lamp side plus a 1-texel rim), 3 any other upright record (props,
    // effects), facing the camera, 4 an upright prop turning round its own
    // axis (V9 flag receiverAxis: a Harbor hull), lit like a body but never
    // by an attention light. A 2.3 surface code (flag 16) overrides the
    // analytic landmark geometry: its height puts the ground point straight
    // below the pixel. Analytic: above the footprint's front edges (from the
    // record's front corner) a wall, in front of them an apron.
    vec2 artPoint = artCell + v_originFrac + 0.5;
    vec2 recvGround = artPoint;
    float recvH = 0.0;
    vec2 recvNormal = vec2(0.0, 1.0);
    // A body's or hull's half-width round its axis (world px).
    float recvHalfWidth = 10.0;
    int recvClass = 0;
    bool roofFace = false;
    uint ownOwner = v_identity.x;
    uint ownLandmark = v_identity.y;
    if (v_receiver.x > -0.5) {
        if (surfaceCoded) {
            float code = floor(geometry.b * 255.0 + 0.5);
            float face = floor(code / 64.0);
            recvH = (code - face * 64.0) * 4.0;
            recvGround = vec2(artPoint.x, artPoint.y + recvH);
            if (face > 0.5 && face < 2.5) {
                recvClass = 1;
                recvNormal = vec2(face < 1.5 ? -0.70710678 : 0.70710678, 0.70710678);
            }
            roofFace = face > 2.5;
        } else if (ownLandmark != 0u && v_receiver.z > -0.5) {
            float edgeY = v_receiver.z - abs(artPoint.x - v_receiver.y) * 0.5;
            if (artPoint.y < edgeY - 1.0) {
                recvClass = 1;
                recvGround = vec2(artPoint.x, edgeY);
                recvH = edgeY - artPoint.y;
                recvNormal = vec2(artPoint.x < v_receiver.y ? -0.70710678 : 0.70710678, 0.70710678);
            }
        } else {
            bool axisProp = (v_flags & ${GPU_RECORD_FLAGS.receiverAxis}u) != 0u;
            recvClass = ownOwner != 0u ? 2 : (axisProp ? 4 : 3);
            recvGround = vec2(artPoint.x, v_receiver.x);
            recvH = max(0.0, v_receiver.x - artPoint.y);
            if (recvClass == 2 || recvClass == 4) {
                // A body (or hull) wraps round its axis (frontCornerX): the
                // texels on the lamp's side face it, the far side falls to
                // the fill. A hull's half-width is its record's.
                recvHalfWidth = recvClass == 2
                    ? 10.0
                    : max(8.0, 0.5 * (v_uvClamp.z - v_uvClamp.x) / abs(uvStepX));
                float across = clamp((artPoint.x - v_receiver.y) / recvHalfWidth, -0.85, 0.85);
                recvNormal = vec2(across, sqrt(1.0 - across * across));
            }
        }
    }
    // 2.5 / 2.1 — a translucent edge texel over a lit pool would show that
    // pool through itself. The baked 2.4 rim (a dark 1-texel outline at half
    // alpha round bodies and props) turns opaque as the lamps take the night
    // (the pools' carry, a grade uniform), in every frame alike: a pool
    // behind a figure never reads as a warm outline on both of its edges, and
    // an attention pool behind a neighbour never changes that neighbour,
    // whether the light is on or off. By day the rim keeps its authored half
    // alpha; a reflection twin keeps its own courses.
    bool bakedRim = recvClass != 0 && !reflectRecord && albedo.a > 0.4 && albedo.a < 0.6
        && max(albedo.r, max(albedo.g, albedo.b)) < 0.16;
    float nightCarry = clamp((u_poolGain - 0.15) / 1.05, 0.0, 1.0);
    // 2.1 — a backlit figure wears one rim: the strongest lamp behind it
    // (backReach) lights the silhouette edge on its side, two texels deep in
    // two steps (rimInner: the second texel, one course down). Several lamps
    // behind a figure never outline both of its edges.
    float backReach = 0.0;
    float rimReach = 0.0;
    vec3 rimLight = vec3(0.0);
    float rimSteps = 0.0;
    bool rimInner = false;
    // 2.3 — a roof (face 3) takes no local light at all: every lamp in the
    // village stands below or beside the roofs, so any course there would
    // be the old disc on the slates.
    int receiverLights = roofFace ? 0 : u_lightCount;
    for (int i = 0; i < 32; i++) {
        if (i >= receiverLights) break;
        vec4 light = u_lights[i];
        vec4 lightShape = u_lightShape[i];
        float lightH = lightShape.x;
        float role = lightShape.w;
        bool attention = role > ${(LIGHT_ROLE_ATTENTION - 0.5).toFixed(1)};
        // 2.5 — an attention light lights its owner's ground and its owner's
        // body only: never a neighbour, a wall, a prop or water.
        if (attention && (waterMaterial || (recvClass != 0 && (ownOwner == 0u || ownOwner != u_lightIds[i].x)))) {
            continue;
        }
        bool backlitRim = false;
        // V5 — the sea behind a light's foot stays dark: water takes a light
        // only on the near side of its foot (no ring behind the Lighthouse).
        if (waterMaterial && recvGround.y < light.y) continue;
        // V5 — falloff between the receiver's ground point and the light's
        // foot in iso ground space (y doubled). Height counts only beyond a
        // 24 world px band around the lamp: a lantern, brazier or door light
        // lays its ground radius exactly and lights a wall up to its own
        // height and a little above it, while a lamp high on a tower (the
        // Lighthouse) reaches the street only faintly, and a facade far above
        // a low door light stays dark. The reach keeps the ground radius
        // under the foot. toReceiver keeps the true height for facing.
        vec3 toReceiver = vec3(recvGround.x - light.x, (recvGround.y - light.y) * 2.0, recvH - lightH);
        float d = length(toReceiver);
        float lampBand = max(0.0, lightH - 24.0);
        float falloffD = length(vec3(toReceiver.xy, max(0.0, abs(recvH - lightH) - 24.0)));
        float falloffReach = sqrt(light.z * light.z + lampBand * lampBand);
        // A body takes one falloff for the whole figure, from its foot on its
        // axis at mid-body height (only its facing varies across the
        // silhouette), and as a small upright cylinder it still catches a lamp
        // a little past the edge of the pool the lamp throws on the ground.
        if (recvClass == 2) {
            falloffD = length(vec3(v_receiver.y - light.x, (v_receiver.x - light.y) * 2.0, max(0.0, abs(20.0 - lightH) - 24.0)));
            falloffReach *= 1.25;
        }
        if (falloffD >= falloffReach) continue;
        float falloff = 1.0 - smoothstep(0.0, falloffReach, falloffD);
        // An aperture (window, door) emits into its face's half-space: the
        // street in front of the facade, never the wall around it.
        if (role > 0.5 && role < 1.5 && dot(lightShape.yz, lightShape.yz) > 0.25) {
            falloff *= clamp(0.30 + 1.4 * dot(lightShape.yz, toReceiver.xy) / max(d, 1.0), 0.0, 1.0);
        }
        // Receiver response: an up-facing surface takes the light while the
        // lamp stands above it, and a deck, step or apron (face 0) up to 12
        // world px above a lamp standing at its foot still catches it (a door
        // light on its own steps). A wall responds by its facing. A body or
        // hull (class 2 / 4) is judged from its axis. Frontlit or side-lit
        // (front >= -0.3: the lamp on the camera's side of it or beside it)
        // it takes Lambert over its cylinder on the lamp side and, while its
        // foot stands in the lamp's reach, a one-course fill over the whole
        // figure (the lit ground's bounce: a figure in a pool never stands
        // black, yet keeps its costume colour); the fill only fades in the
        // last tenth before the lamp stands behind it. Backlit (the lamp
        // behind it: a Forge door, the Command steps) the camera side keeps
        // its own value
        // and the strongest lamp standing behind it and beside it (its foot
        // past most of the figure's half-width) lights a two-texel stepped
        // rim on its side of the silhouette, only up to a little above the
        // lamp's own height: a robe's lamp-side edge, never the hat's top or
        // brim. A lamp hidden straight behind the figure draws no rim (which
        // side would be a coin toss); the figure stands as a silhouette on
        // its pool. Always on the record's own texel grid.
        float response = 1.0;
        if (recvClass == 0) {
            response = lightH + 12.0 >= recvH ? 1.0 : 0.0;
        } else {
            float facing = clamp(-dot(recvNormal, toReceiver.xy) / max(d, 1.0), -1.0, 1.0);
            if (recvClass == 2 || recvClass == 4) {
                vec2 axisTo = vec2(v_receiver.y - light.x, (v_receiver.x - light.y) * 2.0);
                float planar = length(axisTo);
                float front = attention || planar < 2.0 ? 1.0 : -axisTo.y / planar;
                if (front < -0.3) {
                    response = 0.0;
                    if (falloff > 0.12 && abs(axisTo.x) >= 0.8 * recvHalfWidth) {
                        backReach = max(backReach, falloff);
                        vec2 rimStep = vec2((axisTo.x < 0.0 ? 1.0 : -1.0) * uvStepX, 0.0);
                        vec2 rimUv = uv + rimStep;
                        vec2 innerUv = uv + 2.0 * rimStep;
                        bool outer = any(lessThan(rimUv, v_uvClamp.xy)) || any(greaterThan(rimUv, v_uvClamp.zw))
                            || texture(u_albedo, rimUv).a < 0.01;
                        bool inner = !outer && (any(lessThan(innerUv, v_uvClamp.xy)) || any(greaterThan(innerUv, v_uvClamp.zw))
                            || texture(u_albedo, innerUv).a < 0.01);
                        if ((outer || inner) && recvH <= lightH + 28.0 && falloff >= rimReach) {
                            response = 0.95;
                            backlitRim = true;
                            rimInner = inner;
                        }
                    }
                } else {
                    float fill = falloff > 0.08
                        ? clamp(0.62 * falloff, 0.2, 0.36) * clamp((front + 0.4) / 0.1, 0.0, 1.0)
                        : 0.0;
                    response = max(facing, fill / max(falloff, 0.01));
                }
            } else {
                response = clamp(0.15 + 0.85 * facing, 0.0, 1.0);
            }
        }
        float shape = falloff * response;
        // 2.2 — the footprint march, only where this light lays a course.
        float blocked = 0.0;
        if (!attention && u_marchSteps > 0 && poolSteps(shape, poolOrder) > 0.5) {
            blocked = footprintBlocked(recvGround, light.xy, recvH, lightH, ownLandmark, u_lightIds[i].y,
                role > 1.5 && role < 2.5);
        }
        shape *= 1.0 - blocked * 0.92;
        if (backlitRim) {
            rimReach = falloff;
            // One course for the whole rim (no Bayer order): dithered along
            // a one-texel line it would read as a stitched dotted outline.
            rimSteps = poolSteps(shape, 0.5);
            rimLight = u_lightColors[i].rgb * light.w * u_lightColors[i].a;
            continue;
        }
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
        // V5 — water takes no diffuse pool (warm light on blue water would
        // lay a green disc on the sea); it takes the source's hue only as a
        // broken column in front of its foot, never behind it (the sea behind
        // the Lighthouse stays dark): every other world row, in dashes. A
        // lamp high on a tower lays no column at its foot (2.7: the
        // Lighthouse's light on the sea is its beam).
        if (waterReceiver > 0.5) {
            if (lightH > 96.0) continue;
            float ahead = v_world.y - light.y;
            float reflectionX = 1.0 - smoothstep(0.0, light.z * 0.30, abs(v_world.x - light.x));
            float reflectionY = step(0.0, ahead) * (1.0 - smoothstep(0.0, light.z * 1.70, ahead));
            float row = floor(v_world.y);
            float reflectionCourse = step(0.5, fract(row * 0.5))
                * step(0.45, fract(floor(v_world.x) * 0.125 + fract(row * 0.618)));
            reflectionLight += u_lightColors[i].rgb * reflectionX * reflectionY
                * reflectionCourse * light.w * u_lightColors[i].a * 0.10;
            continue;
        }
        float steps = poolSteps(shape, poolOrder);
        if (rampPixel) {
            // 3.5 / 2.1 — a ramp pixel takes the strongest light's stepped
            // course (0.15 per course of its own intensity, on the pools'
            // Bayer order), as a pool takes its deepest step, so the ramp's
            // course edges sit where the pool's do: a door light standing
            // on its steps lays its core on the middle of the flight and its
            // mid course round it, not one flat band.
            admitted = max(admitted, steps * 0.15 * light.w * u_lightColors[i].a);
        } else {
            poolLight += u_lightColors[i].rgb * poolWeight(steps) * light.w * u_lightColors[i].a;
            poolDepth = max(poolDepth, steps);
        }
        // The source's own hue lies on wet ground in front of its foot,
        // broken on the world grid and clipped by the footprint march, so it
        // never crosses a building. Action-needed lights never spend one of
        // these slots (u_wetMask).
        if (recvClass == 0 && (u_wetMask & (1u << uint(i))) != 0u) {
            if (wetReceiver < 0.0) {
                wetReceiver = max(
                    materialNear(material, 7.0),
                    max(materialNear(material, 1.0), materialNear(material, 6.0))
                ) * u_wetness * materialWetness(material);
            }
            if (wetReceiver > 0.01) {
                float drop = v_world.y - light.y;
                float footprint = step(0.0, drop) * (1.0 - smoothstep(0.0, light.z * 1.30, drop));
                float lateral = 1.0 - smoothstep(0.0, light.z * 0.26, abs(v_world.x - light.x));
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
    // strongest action-needed course added outside it. A body lands under
    // half the warm hue shift, so its costume colour survives the pool, and
    // takes a small additive share of the pool's own hue on top of the
    // multiply (at most 0.045 luma): a multiply leaves its dark outline and
    // shadow texels black, so a lit figure's outline turns a dark warm tone
    // of the light (selective outline), never a bright line round it.
    vec3 bodyLift = recvClass == 2
        ? poolLight * min(0.15 * u_poolGain, 0.045 / max(dot(poolLight, GRADE_LUMA), 0.01))
        : vec3(0.0);
    color = stepPool(color, poolLight, poolDepth, attentionLight, attentionDepth, poolAlbedo, reflectionLight + bodyLift,
        recvClass == 2 ? 0.4 : 1.0);
    // 2.1 — a lit rim texel is the silhouette's outline on the lamp's side:
    // a multiply would leave the dark outline dark, so the rim takes the
    // lamp's own hue at a stepped value (one step per course), the pixel art
    // rim light, held under the receiver ceiling. Only the strongest lamp
    // behind the figure draws it (a lamp in front or beside it lights the
    // figure's lamp side through the Lambert term instead), the outer edge
    // texel on that lamp's course and the second texel one course down.
    if (rimReach > 0.0 && rimReach >= backReach - 0.001 && rimSteps > 0.5) {
        float rimCourse = rimInner ? rimSteps - 1.0 : rimSteps;
        float rimY = 0.26 + 0.1 * rimCourse;
        vec3 rimHue = rimLight / max(dot(rimLight, GRADE_LUMA), 0.01);
        vec3 rimStop = rimCourse < 1.5 ? LAND_RIM : rimCourse < 2.5 ? LAND_MID : LAND_CORE;
        vec3 rim = receiverKnee(onStop(mix(rimHue, rimStop, 0.6), rimY), receiverLuma);
        if (dot(rim, GRADE_LUMA) > dot(color, GRADE_LUMA)) color = rim;
    }

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
    // 1.4 + 1.6 — cloud courses and aerial haze on this record's own grid;
    // on water the haze courses follow the sea's swell contours (N3, the
    // open sea's own rows, so they cross the map edge unbroken).
    color = applyAtmosphereCourses(color, artCell, poolOrder,
        artTopLeftPx.y + (waterMaterial ? seaContourRows(artCell) * u_camera.z : 0.0), u_additive);
    if (bakedRim && !u_additive) alpha = mix(alpha, max(alpha, v_alpha), nightCarry);
    outColor = vec4(max(color, vec3(0.0)) * alpha, alpha);
    outEmission = vec4(emission * alpha, alpha > 0.0 ? 1.0 : 0.0);
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

// 2.7 — the Lighthouse fan's half-width at the lamp's foot (ground px); the
// rest of its shape, sweep and sheen step come from lighthouseBeam.
const BEAM_NEAR_HALF_WIDTH = 6;

// 3.3 / 3.4 / 3.2 (outer) — the open sea. Every scene.a < 1 pixel below the
// horizon is shaded here on the world texel grid, under whatever the scene
// drew, with the in-map water's own pipeline so the two meet without a seam
// or hue step: the stop (CoastBake `openSeaStopAt`: stop 2 at the horizon to
// the deepest stop, 4x4 Bayer per texel), static 2:1 swell dashes and 3.1's
// deep crests one stop lighter (a storm whitecap is FOAM), the 3.2 path on
// its seaPath stop, then the water mood, cast and sun band, the C2 grade and
// V6's cap. The top rows take the sky (the plate's haze, then a four-course
// reflection band of its horizon colour, broken on marked texels); then the
// vignette and the scene pass's ground fog, every screen term read at the
// texel's centre. Weather on the sea: the island's own cloud courses and
// aerial haze, the sunlit course and C-W3 cat's paws (SEA_WEATHER_GLSL, the
// same rule the in-map open water runs, so neither fades at the map edge)
// and the forecast squall. The third cloud course fades out with the
// distance from the island by shifting its own threshold (at most two
// courses far out). Every course edge is solid with a 1-2 texel seam.
const OPEN_SEA_GLSL = `
uniform bool u_seaOn;
uniform float u_time;
uniform vec4 u_weather;
uniform vec4 u_waterFx;
uniform vec4 u_glint;
uniform vec3 u_glintStops[2];
uniform float u_seaSunBand;
uniform vec3 u_fogColor;
// rgb: the sky plate's haze course, a: haze rows below the horizon (world px).
uniform vec4 u_seaHaze;
// The sky just above the horizon, which the reflection band mirrors.
uniform vec3 u_seaSky;
// Forecast squall: centre xy and half-width z (world px), strength w (0 = none);
// streak fall offset (world px, stepped on the motion clock).
uniform vec4 u_squall;
uniform float u_squallFall;
const float OPEN_SEA_BAND = ${OPEN_SEA_BAND_DEPTH.toFixed(1)};
const float OPEN_SEA_MAP_LAST = ${(MAP_SIZE - 0.56).toFixed(2)};
// Tiles past the island diamond (CoastBake's outer-shelf \`excess\`: Euclidean
// in tile space, so its contours round past the map corners).
float islandExcess(vec2 w) {
    vec2 uv = vec2(w.y / ${TILE_HEIGHT.toFixed(1)} + w.x / ${TILE_WIDTH.toFixed(1)}, w.y / ${TILE_HEIGHT.toFixed(1)} - w.x / ${TILE_WIDTH.toFixed(1)});
    vec2 edge = clamp(uv, vec2(-0.44), vec2(OPEN_SEA_MAP_LAST));
    return length(uv - edge);
}
// One 3-5 texel dash per 10x5 texel cell, present at \`presence\`.
bool openSeaSwell(vec2 cell, float presence) {
    vec2 k = floor(cell / vec2(10.0, 5.0));
    if (waterHash12(k + vec2(211.0, 17.0)) >= presence) return false;
    vec2 local = cell - k * vec2(10.0, 5.0);
    float len = 3.0 + floor(waterHash12(k + vec2(223.0, 5.0)) * 3.0);
    float x0 = floor(waterHash12(k + vec2(227.0, 41.0)) * (10.0 - len));
    float y0 = floor(waterHash12(k + vec2(229.0, 83.0)) * 5.0);
    return local.y == y0 && local.x >= x0 && local.x < x0 + len;
}
vec3 shadeOpenSea(vec2 cell) {
    float order = waterBayer4(cell);
    // Screen terms (path width, vignette) read the texel's centre pixel, so
    // every texel stays one colour at any zoom (3.3 (c)).
    vec2 texelPx = (cell + 0.5 + u_camera.xy) * u_camera.z;
    float t = cell.y - OPEN_SEA_HORIZON_Y;
    float excess = islandExcess(cell + 0.5);
    float clock = u_waterFx.x;
    float storm = step(0.5, u_weather.z);
    float tick = floor(u_time * 0.006 * clock);
    // N3 / N8 — the stop seams wander on the seam contours (the terrain
    // bake's outer shelf and in-map clamp read the same CPU twin, so the
    // handover stays per-texel exact) and the reflection band's course seams
    // on the smooth sea contours, never ruled straight across the frame.
    float contour = seaContourRows(cell);
    float stop = openSeaStop(openSeaDepth(cell), order);
    // The third cloud course fades with the distance from the island by
    // shifting its threshold, so its shapes shrink along their own contours
    // and no line parallel to the map edge appears: 0 within 1.5 tiles, 1
    // past 6.
    float reach = clamp((excess - 1.5) / 4.5, 0.0, 1.0);
    float n = (u_cloud.z > 0.0 || u_squall.w > 0.0 || u_seaSunlit > 0.0) ? cloudNoiseAt(cell) : 1.0;
    float m = u_cloud.z > 0.0 || u_seaSunlit > 0.0 ? cloudSeamField(cell, n, order, u_seaSunlit) : n;
    float gust = seaGustAt(cell);
    bool paw = seaPawAt(cell, gust, order);
    bool marked = false;
    vec3 c;
    float glint = glintDash(cell, texelPx, u_glint, u_camera.z, tick);
    // 2.7 — the Lighthouse fan's lit dashes, the same cells as the in-map water.
    float beam = lighthouseSheen(cell);
    if (glint > 0.5) {
        c = u_glintStops[glint > 1.5 ? 0 : 1] * mix(1.0, 0.86, u_seaSunBand);
        c = seaPathCap(applyTimeGrade(c, true));
        marked = true;
    } else if (beam > 0.5) {
        // The lamp's own light keeps its lampBeam stop through the night grade.
        c = lighthouseStop(beam) * mix(1.0, 0.86, u_seaSunBand);
        marked = true;
    } else {
        // Swell presence (3.3 (a)): rising from the shelf to 0.45 three tiles
        // out, easing to 0.10 far out, gathered into long 2:1 sets (the
        // swell's own direction, wandering on a slow field) with calm gaps
        // between, so the calm sea reads in sets, not an even speckle. The
        // leading half of a set carries its crest: dashes there catch the
        // sky two stops lighter.
        float presence = excess < 3.0
            ? clamp((excess - 0.5) * 0.18, 0.0, 0.45)
            : mix(0.45, 0.10, clamp((excess - 3.0) / 12.0, 0.0, 1.0));
        float setAt = fract(dot(cell, vec2(0.5, 1.0)) / ${SWELL_SET_PERIOD.toFixed(1)} + 1.3 * seaNoise(cell / vec2(640.0, 320.0) + vec2(3.0, 11.0)));
        bool inSet = setAt < ${SWELL_SET_SHARE_OPEN.toFixed(2)};
        presence *= inSet ? ${SWELL_SET_GAIN.toFixed(2)} : ${SWELL_GAP_GAIN.toFixed(2)};
        float lighter = openSeaSwell(cell, presence) ? (inSet && setAt < ${(SWELL_SET_SHARE_OPEN * 0.5).toFixed(2)} ? 2.0 : 1.0) : 0.0;
        bool whitecap = false;
        if (clock > 0.0) {
            float lit = deepSwellLit(cell, tick, storm, ${DEEP_DASH_DENSITY.toFixed(2)});
            whitecap = lit > 1.5;
            if (lit > 0.5) lighter = max(lighter, 1.0);
        }
        // A cat's paw's ruffle catches the sky two stops lighter.
        if (paw && seaPawDash(cell, gust)) lighter = 2.0;
        marked = lighter > 0.0 || whitecap;
        // Sun on water: one stop lighter where the cloud field is lowest.
        if (u_seaSunlit > 0.0 && m < u_seaSunlit) lighter += 1.0;
        vec3 albedo = whitecap ? WATER_FOAM : WATER_STOPS[int(max(stop - lighter, 0.0))];
        c = applyWaterMood(albedo) * WATER_CAST * mix(1.0, 0.86, u_seaSunBand);
        c = capSaturation(applyTimeGrade(c, true), WATER_MAX_SATURATION);
    }
    float hazeRows = u_seaHaze.a;
    // 3.3 (d) / WS-11 — the sky-reflection band: the sky's own horizon colour
    // (warm at golden hour, like the path is the sun's) in four courses fading
    // into the sea, held at HSL L <= 0.70 like the path; V6's cool cap rules
    // the sea body below it. Its seams follow the swell contours, deepening
    // from level at the haze.
    float band = t - hazeRows + floor(contour * clamp((t - hazeRows) / 96.0, 0.0, 1.0) + 0.5);
    if (!marked && t >= hazeRows && band >= 0.0 && band < OPEN_SEA_BAND) {
        // Four solid courses, each handing to the next in a 2-row seam.
        float p = band / OPEN_SEA_BAND * 4.0;
        float k = floor(p);
        float seam = 8.0 / OPEN_SEA_BAND;
        if (p - k > 1.0 - seam && (p - k - (1.0 - seam)) / seam > order) k += 1.0;
        float w = k < 0.5 ? ${OPEN_SEA_BAND_WEIGHTS[0].toFixed(2)} : k < 1.5 ? ${OPEN_SEA_BAND_WEIGHTS[1].toFixed(2)}
            : k < 2.5 ? ${OPEN_SEA_BAND_WEIGHTS[2].toFixed(2)} : k < 3.5 ? ${OPEN_SEA_BAND_WEIGHTS[3].toFixed(2)} : 0.0;
        c = seaPathCap(mix(c, u_seaSky, w));
    }
    if (t < hazeRows) {
        // Three solid haze courses meeting the sky plate, 1-row seams.
        float p = t / hazeRows * 3.0;
        float k = floor(p);
        float seam = min(1.0, 3.0 / hazeRows);
        if (p - k > 1.0 - seam && (p - k - (1.0 - seam)) / seam > order) k += 1.0;
        c = mix(c, u_seaHaze.rgb, k < 0.5 ? 1.0 : k < 1.5 ? 0.6 : k < 2.5 ? 0.28 : 0.0);
    }
    c = applyGradeVignette(c, texelPx, u_resolution);
    // The scene pass's ground fog at elevation 0 (luma rise held at 0.06).
    float groundFog = clamp(u_weather.y, 0.0, 1.0) * smoothstep(0.18, 0.98, 1.0 - texelPx.y / max(1.0, u_resolution.y));
    vec3 fogged = mix(c, u_fogColor, groundFog * 0.48);
    float fogRise = dot(fogged - c, GRADE_LUMA);
    if (fogRise > 0.06) fogged = mix(c, fogged, 0.06 / fogRise);
    c = fogged;
    float shade = 0.0;
    if (u_cloud.z > 0.0) {
        // At most two courses on the open sea: the third fades out past the
        // island as its threshold climbs above the field.
        shade = step(u_cloudThresholds.x, m) + step(u_cloudThresholds.y, m) + step(mix(u_cloudThresholds.z, 1.2, reach), m);
    }
    if (u_squall.w > 0.0) {
        vec2 d = (cell + 0.5 - u_squall.xy) / vec2(u_squall.z, u_squall.z * 0.5);
        // The rim dithers over a two-texel seam only.
        float edge = length(d) + (n - 0.5) * 0.5 + (order - 0.5) * 3.0 / u_squall.z;
        if (edge < 1.0) {
            // Three courses in the core, stepping out to one at the rim, so the
            // squall reads darker than any cloud shadow it crosses.
            float courses = edge < 0.5 ? 3.0 : edge < 0.78 ? 2.0 : 1.0;
            // 2-px rain streak columns hanging under the patch.
            float h = waterHash12(vec2(floor(cell.x / 2.0), 409.0));
            if (h < 0.45 && mod(cell.y - u_squallFall + floor(h * 97.0), 24.0) < 12.0 + h * 10.0) courses += 1.0;
            shade = max(shade, courses * u_squall.w);
        }
    }
    if (shade > 0.0) c *= vec3(1.0) - shade * 0.085 * vec3(1.0, 0.96, 0.84);
    // N3 — the aerial haze's courses on water follow the swell contours (the
    // in-map water takes the same rows, SCENE_FRAGMENT), never a ruled line.
    return applyAerialHaze(c, order, (cell.y + 0.5 + seaContourRows(cell) + u_camera.y) * u_camera.z, false);
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
// The camera (offset xy, zoom z) and backing size, for world-grid shading.
uniform vec3 u_camera;
uniform vec2 u_resolution;
${GRADE_GLSL}
${ATMOSPHERE_COURSES_GLSL}
${WATER_MOOD_GLSL}
${SEA_SWELL_GLSL}
${SEA_WEATHER_GLSL}
${LIGHTHOUSE_BEAM_GLSL}
${WATER_PALETTE_GLSL}
${OPEN_SEA_GLSL}
void main() {
    vec4 scene = texture(u_scene, clamp(v_uv, vec2(0.0), vec2(1.0)));
    vec3 bloom = texture(u_bloom, clamp(v_uv, vec2(0.0), vec2(1.0))).rgb;
    vec3 color = scene.rgb;
    float alpha = scene.a;
    // 3.3 — the open sea below the horizon, under everything the scene drew.
    if (u_seaOn && alpha < 1.0) {
        vec2 fragPx = vec2(gl_FragCoord.x, u_resolution.y - gl_FragCoord.y);
        vec2 world = fragPx / u_camera.z - u_camera.xy;
        if (world.y >= OPEN_SEA_HORIZON_Y) {
            color += shadeOpenSea(floor(world)) * (1.0 - alpha);
            alpha = 1.0;
        }
    }
    color *= vec3(1.0) + u_flash;
    outColor = vec4(color + bloom * u_bloomStrength, alpha);
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
    if (shape == ${GPU_PARTICLE_SHAPES.smoke}u) {
        // 6.4 — a round smoke puff in three tones (ParticleSystem
        // smokePuffTone, same half-texel arithmetic): the lit rim faces the
        // upper-left key, the shade rim the lower right, both stepped from the
        // body tone by fixed per-channel gains before the grade.
        int radius = v_size.x / 2;
        int limit = 4 * radius * radius;
        ivec2 d = cell * 2 + 1 - 2 * radius;
        if (d.x * d.x + d.y * d.y > limit) discard;
        ivec2 lit = d - 2;
        ivec2 shade = d + (radius >= 4 ? 6 : 4);
        if (lit.x * lit.x + lit.y * lit.y > limit) {
            rgb = min(vec3(1.0), floor(rgb * 255.0 * vec3(${SMOKE_PUFF_LIT_GAIN.map((g) => g.toFixed(5)).join(', ')}) + 0.5) / 255.0);
        } else if (shade.x * shade.x + shade.y * shade.y > limit) {
            rgb = floor(rgb * 255.0 * vec3(${SMOKE_PUFF_SHADE_GAIN.map((g) => g.toFixed(5)).join(', ')}) + 0.5) / 255.0;
        }
    } else if (shape == ${GPU_PARTICLE_SHAPES.blob}u) {
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

// `#rrggbb` → [r, g, b] in 0..1, or `fallback` for anything else.
function hexRgb01(hex, fallback) {
    const text = String(hex || '');
    if (!/^#[0-9a-f]{6}$/i.test(text)) return fallback;
    return [1, 3, 5].map(index => parseInt(text.slice(index, index + 2), 16) / 255);
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

// The baked tile plus the combined field's sorted values (3.4: two octaves
// of the tile, CLOUD_SECOND_OCTAVE), so a cover fraction maps to an exact
// noise threshold (the covered share of the ground equals the cover).
let _cloudTile = null;
function cloudTile() {
    if (_cloudTile) return _cloudTile;
    const data = buildCloudShadowTile(CLOUD_TILE_SIZE);
    _cloudTile = { data, sorted: sortedCloudField(data, CLOUD_TILE_SIZE) };
    return _cloudTile;
}

function cloudThreshold(coveredShare) {
    const { sorted } = cloudTile();
    const index = Math.round(clamp(1 - coveredShare, 0, 1) * (sorted.length - 1));
    return sorted[index];
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

// 2.2 — the occluder companions (2.3's surface code, fog elevation) upload
// whenever the local-light phase is up, at every ladder level (MINIMAL still
// ships its lights), or while fog reads their height; never on a clear day.
function occluderChannelFor(feed = {}) {
    return localLightPhaseForLighting(feed.lighting) > LOCAL_LIGHT_VISIBILITY_FLOOR
        || weatherUniform(feed)[1] !== 0;
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
        // V5 — the admitted lights' world-space uniforms (see SCENE_FRAGMENT).
        this._lightScratch = new Float32Array(MAX_LIGHTS * 4);
        this._lightShapeScratch = new Float32Array(MAX_LIGHTS * 4);
        this._lightIdScratch = new Uint32Array(MAX_LIGHTS * 2);
        this._lightColorScratch = new Float32Array(MAX_LIGHTS * 4);
        this.cloudCourses = 0;
        this.aerialHaze = 0;
        this.footprintMarchSteps = 0;
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
                // B.2 — nothing reads the default framebuffer's depth: the
                // painter depth (0.6) is the scene target's own DEPTH16
                // renderbuffer and bloom/composite run with DEPTH_TEST off.
                depth: false,
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
        this.particleProgram = createProgram(gl, PARTICLE_VERTEX, PARTICLE_FRAGMENT);
        this.bloomProgram = createProgram(gl, FULLSCREEN_VERTEX, BLOOM_FRAGMENT);
        this.compositeProgram = createProgram(gl, FULLSCREEN_VERTEX, COMPOSITE_FRAGMENT);
        this.timerExtension = gl.getExtension?.('EXT_disjoint_timer_query_webgl2') || null;
        this.sceneUniforms = uniformLocations(gl, this.sceneProgram, [
            'u_camera', 'u_resolution', 'u_albedo', 'u_materialMap', 'u_emissiveMap',
            'u_hasMaterialMap', 'u_occluderMap', 'u_hasOccluderMap', 'u_packedGeometry', 'u_hasEmissiveMap',
            ...GRADE_UNIFORM_NAMES,
            'u_fogColor', 'u_weather', 'u_time', 'u_motionScale',
            'u_sun', 'u_overcast', 'u_additive',
            'u_lightCount', 'u_lights[0]', 'u_lightShape[0]', 'u_lightIds[0]', 'u_lightColors[0]',
            'u_footprint', 'u_footprintRect', 'u_footprintSize', 'u_marchSteps',
            'u_coreEnergy', 'u_waterMood',
            'u_cycleOffset', 'u_coastField', 'u_coastRect', 'u_waterFx', 'u_glint', 'u_glintStops[0]',
            'u_terrainBatch',
            'u_wetness', 'u_wetReflectionCount', 'u_beamGround', 'u_beamShape', 'u_beamCourseEnds', 'u_beamCourseShares',
            'u_puddleMask', 'u_puddleRect', 'u_puddles', 'u_puddleSky', 'u_puddleGround',
            'u_paletteLut', 'u_hasPaletteLut', 'u_wetMask',
            ...ATMOSPHERE_COURSE_UNIFORM_NAMES,
            ...SEA_WEATHER_UNIFORM_NAMES,
        ]);
        this.particleUniforms = uniformLocations(gl, this.particleProgram, [
            'u_camera', 'u_resolution', 'u_motifs', 'u_coreEnergy', ...GRADE_UNIFORM_NAMES,
            ...ATMOSPHERE_COURSE_UNIFORM_NAMES,
        ]);
        this.bloomUniforms = uniformLocations(gl, this.bloomProgram, ['u_input', 'u_texel', 'u_blur']);
        this.compositeUniforms = uniformLocations(gl, this.compositeProgram, [
            'u_scene', 'u_bloom', 'u_bloomStrength', 'u_flash',
            'u_camera', 'u_resolution', 'u_beamGround', 'u_beamShape', 'u_beamCourseEnds', 'u_beamCourseShares',
            ...GRADE_UNIFORM_NAMES, ...ATMOSPHERE_COURSE_UNIFORM_NAMES,
            'u_waterMood', 'u_seaOn', 'u_time', 'u_weather', 'u_waterFx', 'u_glint', 'u_glintStops[0]',
            'u_seaSunBand', 'u_fogColor', 'u_seaHaze', 'u_seaSky', 'u_seaSunlit',
            'u_seaGust', 'u_seaGustRect', 'u_squall', 'u_squallFall',
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
     * counts its real bytes (width x height x bytesPerTexel), so the 160 MiB
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
            // Binding-neutral: the upload binds on whatever unit is active, so
            // restore that unit's texture (a caller that already bound its
            // sampler, e.g. the cloud tile, keeps it for this frame's draw).
            const bound = gl.getParameter(gl.TEXTURE_BINDING_2D);
            if (storageChanged) {
                if (entry.texture) gl.deleteTexture(entry.texture);
                entry.texture = this._createTexture(w, h, { data, format });
            } else {
                gl.bindTexture(gl.TEXTURE_2D, entry.texture);
                gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
                gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl[spec.format], gl[spec.type], data);
                gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
            }
            gl.bindTexture(gl.TEXTURE_2D, bound && gl.isTexture(bound) ? bound : null);
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
        this.sceneTarget = null;
        this.bloomA = null;
        this.bloomB = null;
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
        for (const program of [this.sceneProgram, this.particleProgram, this.bloomProgram, this.compositeProgram]) {
            if (program) gl.deleteProgram(program);
        }
        this.emptyMaterialTexture = null;
        this.cloudTileTexture = null;
        this.vertexBuffer = null;
        this.vao = null;
        this.particleBuffer = null;
        this.particleVao = null;
        this.sceneProgram = null;
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
        this._textureEntries?.clear?.();
        this.emptyMaterialTexture = null;
        this.cloudTileTexture = null;
        this.vertexBuffer = null;
        this.vao = null;
        this.particleBuffer = null;
        this.particleVao = null;
        this.sceneProgram = null;
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
        const matches = this.sceneTarget?.width === this.width
            && this.sceneTarget?.height === this.height
            && this.bloomA?.width === bloomWidth
            && this.bloomA?.height === bloomHeight
            && this.bloomB?.width === bloomWidth
            && this.bloomB?.height === bloomHeight;
        if (matches) return;
        this._releaseTarget(this.sceneTarget);
        this._releaseTarget(this.bloomA);
        this._releaseTarget(this.bloomB);
        this.sceneTarget = this._createTarget(this.width, this.height, { attachments: 2, filter: gl.NEAREST, depth: true });
        this.bloomA = this._createTarget(bloomWidth, bloomHeight, { filter: gl.LINEAR });
        this.bloomB = this._createTarget(bloomWidth, bloomHeight, { filter: gl.LINEAR });
        this._updateTextureBytes();
    }

    _updateTextureBytes() {
        const estimate = estimateGpuWorldTextureBytes({
            width: this.width,
            height: this.height,
            bloomScale: BLOOM_SCALE,
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

    // 3.8 / M23 — a scene category is native when every command it emits is
    // a V9 record (a drawable source and a finite world rect). DrawablePass
    // then lets the category's depth drawables emit those records in painter
    // order; anything else replays on the overlay.
    supportsSceneCommands(request) {
        const commands = request?.commands;
        if (!commands?.length) return false;
        for (let index = 0; index < commands.length; index++) {
            const command = commands[index];
            if (!command?.source || !Number.isFinite(command.x) || !Number.isFinite(command.y)
                || !(command.width > 0) || !(command.height > 0)) return false;
        }
        return true;
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

    // B.2 — true once `key` holds an uploaded texture of `revision` on a
    // healthy context, so its CPU source may be released (a GPU-resident
    // stand-in keeps drawing it). A lost context or an evicted entry reports
    // false, and the caller re-bakes the source.
    hasResidentTexture(key, revision) {
        const entry = this._textureEntries.get(key);
        return Boolean(this.contextHealthy && entry?.texture && entry.source && entry.revision === revision);
    }

    _textureFor(key, source, revision = null, updates = null) {
        const gl = this.gl;
        if (!source || source.width === 0 || source.height === 0) return null;
        const width = Math.max(1, Math.floor(source.width || source.videoWidth || 1));
        const height = Math.max(1, Math.floor(source.height || source.videoHeight || 1));
        let entry = this._textureEntries.get(key);
        // B.2 — a GPU-resident source ({ width, height, gpuResident: true })
        // stands in for a CPU canvas released after its upload (the terrain
        // bake): it resolves only to a live texture of the same revision.
        if (source.gpuResident === true) {
            if (!entry || entry.revision !== revision || entry.width !== width || entry.height !== height) return null;
            entry.lastUsedFrame = this.frames + 1;
            return entry.texture;
        }
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
                    // A sub-rect update (sx/sy set) reads that rect of a larger
                    // source; otherwise the source is exactly the patch.
                    const subRect = update?.sx != null;
                    const sx = Math.floor(update?.sx || 0);
                    const sy = Math.floor(update?.sy || 0);
                    return Boolean(
                        update?.source
                        && updateWidth > 0
                        && updateHeight > 0
                        && (subRect
                            ? sx >= 0 && sy >= 0
                                && sx + updateWidth <= update.source.width
                                && sy + updateHeight <= update.source.height
                            : update.source.width === updateWidth && update.source.height === updateHeight)
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
                    if (update.sx != null) {
                        gl.pixelStorei(gl.UNPACK_ROW_LENGTH, update.source.width);
                        gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, Math.floor(update.sx));
                        gl.pixelStorei(gl.UNPACK_SKIP_ROWS, Math.floor(update.sy || 0));
                        gl.texSubImage2D(gl.TEXTURE_2D, 0, Math.floor(update.x || 0), Math.floor(update.y || 0),
                            Math.floor(update.width), Math.floor(update.height), gl.RGBA, gl.UNSIGNED_BYTE, update.source);
                        gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
                        gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0);
                        gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 0);
                    } else {
                        gl.texSubImage2D(
                            gl.TEXTURE_2D,
                            0,
                            Math.max(0, Math.floor(update.x || 0)),
                            Math.max(0, Math.floor(update.y || 0)),
                            gl.RGBA,
                            gl.UNSIGNED_BYTE,
                            update.source,
                        );
                    }
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
    // of the batch has the default tail.
    _stageFrameVertices(batches) {
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
            for (let recordIndex = 0; recordIndex < records.length; recordIndex++) {
                writeGpuRecordInstance(f32, u16, batch.instanceOffset + recordIndex * stride, records[recordIndex], batch.tail);
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

    _bindBatch(program, uniforms, batch) {
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
        if (uniforms.u_puddleGround || uniforms.u_terrainBatch) {
            const terrain = batch.records[0]?.id === 'terrain:static';
            if (uniforms.u_puddleGround) gl.uniform1i(uniforms.u_puddleGround, this._puddleActive && terrain ? 1 : 0);
            if (uniforms.u_terrainBatch) gl.uniform1i(uniforms.u_terrainBatch, terrain ? 1 : 0);
        }
        this._pointRecordInstances(batch);
        gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, batch.count);
        return batch.records.length;
    }

    // 3.1 / 3.2 / 3.6 / 3.9 / 3.10 — per-frame water state from the clock,
    // the village's own weather and sky, and the ladder (EFFECT_BUDGET rows
    // `waterCrests`, `glitterPath`, `rainRings`, `coastSwash`,
    // `shallowCaustics`). `_glint` / `_glintStops` are the exact values the
    // scene pass uploads; the composite's open-ocean strip reuses them.
    _resolveWaterFx(feed, camera, qualityLevel, grade, moonFill) {
        const fx = this._waterFx || (this._waterFx = new Float32Array(4));
        const glint = this._glint || (this._glint = new Float32Array(4));
        const stops = this._glintStops || (this._glintStops = new Float32Array(6));
        const motion = feed.reducedMotion ? 0 : clamp(finite(feed.motionScale, 1), 0, 2);
        // One water clock: every cycle freezes on its static frame under
        // reduced motion and at MINIMAL.
        fx[0] = effectBudgetMode('waterCrests', qualityLevel) === 'on' ? motion : 0;
        const weather = feed.weather || feed.atmosphere?.weather || {};
        const type = String(weather.type || 'clear');
        const raining = type === 'rain' || type === 'storm';
        fx[1] = raining && effectBudgetMode('rainRings', qualityLevel) !== 'off'
            ? clamp(finite(weather.precipitation, weather.intensity), 0, 1)
            : 0;
        const cloudCover = clamp(finite(weather.cloudCover, 0), 0, 1);
        const zoom = finite(camera?.zoom, 1);
        fx[2] = effectBudgetMode('shallowCaustics', qualityLevel) === 'on'
            && !raining
            && finite(grade.sunBand, 0) > 0.3
            && cloudCover < 0.5
            && finite(grade.night, 0) < 0.5
            && zoom >= 2
            ? 1 : 0;
        fx[3] = effectBudgetMode('coastSwash', qualityLevel) === 'on' && motion > 0 ? 1 : 0;
        // 3.2 — the sky body's screen x (the sky spans the canvas), gold near
        // sunrise and golden hour (the grade's rake) at full strength, pale
        // and sparse (0.35) toward noon, silver under a moon at least half
        // full in clear air; none under heavy cloud or when the body is hidden.
        glint.fill(0);
        stops.fill(0);
        if (effectBudgetMode('glitterPath', qualityLevel) === 'off') return;
        const sun = feed.atmosphere?.sky?.sun;
        const moon = feed.atmosphere?.sky?.moon;
        let kind = 0;
        let strength = 0;
        let xFrac = 0;
        if (sun?.visible && cloudCover < 0.7) {
            const rake = clamp(finite(grade.rake, 0), 0, 1);
            kind = rake >= 0.4 ? 1 : 2;
            strength = 0.35 + 0.65 * rake;
            xFrac = finite(sun.xFrac, 0.5);
        } else if (moon?.visible && moonFill >= 0.5 && cloudCover < 0.5 && !raining) {
            kind = 3;
            strength = moonFill;
            xFrac = finite(moon.xFrac, 0.5);
        }
        if (!kind) return;
        const texelPx = Math.max(0.01, zoom * Math.max(0.25, finite(camera?._dpr?.(), 1)));
        glint[0] = xFrac * this.width;
        glint[1] = strength;
        glint[2] = kind;
        // The pale day path spreads into a broad sparse sparkle under a high sun.
        glint[3] = (kind === 2 ? 0.12 * NOON_GLINT_GROW_GAIN : 0.12) / texelPx;
        stops.set(SEA_PATH_STOPS[kind]);
    }

    // 3.1 / 3.6 — the coast lattice fields on units 7 (cycle offset, R8) and
    // 8 (coast field, RG8), uploaded through the V9 typed path once per coast
    // bake. MINIMAL (crests frozen, swash off) leaves both unbound and
    // `u_coastRect.z` 0, so every reader early-outs.
    _bindWaterFields(uniforms, fields, qualityLevel) {
        const gl = this.gl;
        let cycle = null;
        let coast = null;
        const live = effectBudgetMode('waterCrests', qualityLevel) === 'on'
            || effectBudgetMode('coastSwash', qualityLevel) === 'on';
        if (live && fields?.cols > 0 && fields?.rows > 0) {
            cycle = this.uploadTypedTexture('field:cycle-offset', {
                width: fields.cols, height: fields.rows, format: 'r8', data: fields.cycleOffset, revision: fields.revision,
            });
            coast = this.uploadTypedTexture('field:coast', {
                width: fields.cols, height: fields.rows, format: 'rg8', data: fields.coastField, revision: fields.revision,
            });
        }
        const present = Boolean(cycle && coast);
        gl.activeTexture(gl.TEXTURE0 + SCENE_SAMPLER_UNITS.cycleOffset);
        gl.bindTexture(gl.TEXTURE_2D, present ? cycle : this.emptyMaterialTexture);
        gl.uniform1i(uniforms.u_cycleOffset, SCENE_SAMPLER_UNITS.cycleOffset);
        gl.activeTexture(gl.TEXTURE0 + SCENE_SAMPLER_UNITS.coastField);
        gl.bindTexture(gl.TEXTURE_2D, present ? coast : this.emptyMaterialTexture);
        gl.uniform1i(uniforms.u_coastField, SCENE_SAMPLER_UNITS.coastField);
        if (present) gl.uniform4f(uniforms.u_coastRect, fields.x, fields.y, fields.cols, fields.rows);
        else gl.uniform4f(uniforms.u_coastRect, 0, 0, 0, 0);
        this.waterFieldsActive = present;
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
        // B.2 — packed agent geometry follows the occluder channel toggle
        // (render() sets it before the scene pass), as its uploads did.
        gl.uniform1i(uniforms.u_packedGeometry, this._occluderChannelSkipped ? 0 : 1);
        this._setCameraUniforms(uniforms, camera, 1);
        gl.uniform2f(uniforms.u_resolution, this.width, this.height);
        uploadGradeUniforms(gl, uniforms, grade);
        gl.uniform3fv(uniforms.u_fogColor, grade.fogColor);
        gl.uniform1i(uniforms.u_additive, 0);
        const cloudCover = clamp(finite(feed.atmosphere?.weather?.cloudCover, 0), 0, 1);
        gl.uniform1f(uniforms.u_overcast, clamp((cloudCover - 0.7) / 0.2, 0, 1));
        gl.uniform4fv(uniforms.u_weather, weather);
        this._frameWeather = weather;
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
        this._resolveSeaWeather(qualityLevel, camera, feed);
        this._uploadAtmosphereCourses(uniforms, SCENE_SAMPLER_UNITS.cloudTile);
        this._uploadSeaWeather(uniforms, SCENE_SAMPLER_UNITS.seaGust);
        // 3.1 — one envelope, three consumers: the core here, the spill on each
        // admitted light below, and the bloom share in `_present`.
        const energy = sourceEnergyFor(feed.lighting);
        this.sourceEnergy = energy;
        gl.uniform1f(uniforms.u_coreEnergy, clamp(finite(energy.core, 1), 0, 2));
        // 3.1 / 3.2 / 3.6 / 3.9 / 3.10 — the water clock, rings, caustics,
        // swash and the sun/moon path, then the coast lattice fields.
        const moonFill = clamp(finite(feed.lighting?.moonFill, 0), 0, 1);
        this._resolveWaterFx(feed, camera, qualityLevel, grade, moonFill);
        gl.uniform4fv(uniforms.u_waterFx, this._waterFx);
        gl.uniform4fv(uniforms.u_glint, this._glint);
        gl.uniform3fv(uniforms['u_glintStops[0]'], this._glintStops);
        this._bindWaterFields(uniforms, feed.coastWater, qualityLevel);
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
        this._uploadPuddles(uniforms, feed);
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
        this._uploadBeamUniforms(uniforms, feed.beam || null);

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
        // V5 — the admitted lights in world space: foot, ground radius,
        // intensity; emitter height, face normal, role; owner slot and
        // landmark id. PostFxFeed supplies the world geometry; a light
        // without it (a bare backing-px producer) is lifted back into the
        // world through the camera, standing on its own point.
        const dpr = Math.max(0.25, finite(camera?._dpr?.(), 1));
        const zoom = Math.max(0.01, finite(camera?.zoom, 1));
        const backingScale = zoom * dpr;
        const cameraX = finite(camera?.renderOffsetX, Math.round(finite(camera?.x) * zoom * dpr) / dpr) / zoom;
        const cameraY = finite(camera?.renderOffsetY, Math.round(finite(camera?.y) * zoom * dpr) / dpr) / zoom;
        const lightValues = this._lightScratch;
        const lightShapes = this._lightShapeScratch;
        const lightIds = this._lightIdScratch;
        const lightColors = this._lightColorScratch;
        lightValues.fill(0);
        lightShapes.fill(0);
        lightIds.fill(0);
        lightColors.fill(0);
        let wetMask = 0;
        let wetSlots = this.wetReflectionCount;
        for (let index = 0; index < lights.length; index++) {
            const light = lights[index];
            const color = gpuLightColorForShader(light, DEFAULT_LIGHT_COLOR, this._singleLightColorScratch);
            const offset = index * 4;
            const world = Number.isFinite(light.footX) && Number.isFinite(light.footY);
            lightValues[offset] = world ? light.footX : finite(light.x) / backingScale - cameraX;
            lightValues[offset + 1] = world ? light.footY : finite(light.y) / backingScale - cameraY;
            lightValues[offset + 2] = Math.max(1, Number.isFinite(light.radiusWorld)
                ? light.radiusWorld
                : finite(light.radius, 64) / backingScale);
            lightValues[offset + 3] = clamp(finite(light.intensity, 1), 0, 3);
            const attention = isAttentionLight(light);
            lightShapes[offset] = Math.max(0, finite(light.height, 0));
            lightShapes[offset + 1] = finite(light.nx, 0);
            lightShapes[offset + 2] = finite(light.ng, 0);
            lightShapes[offset + 3] = attention ? LIGHT_ROLE_ATTENTION : finite(light.role, LIGHT_ROLE_POINT);
            lightIds[index * 2] = Math.max(0, Math.round(finite(light.ownerSlot, 0)));
            lightIds[index * 2 + 1] = Math.max(0, Math.round(finite(light.landmarkId, 0)));
            if (!attention && wetSlots > 0) {
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
        gl.uniform4fv(uniforms['u_lightShape[0]'], lightShapes);
        gl.uniform2uiv(uniforms['u_lightIds[0]'], lightIds);
        gl.uniform4fv(uniforms['u_lightColors[0]'], lightColors);
        gl.uniform1ui(uniforms.u_wetMask, wetMask >>> 0);
        // 2.2 — the footprint field on unit 6, uploaded once per map/scenery
        // revision, and this level's march length (FULL 8, REDUCED 4,
        // MINIMAL 0; 0 in daylight or before a field exists).
        const field = lights.length > 0 ? feed.footprint : null;
        const fieldTexture = field?.data
            ? this.uploadTypedTexture('field:footprint', {
                width: field.width,
                height: field.height,
                format: 'rg8',
                data: field.data,
                revision: field.revision ?? null,
            })
            : null;
        this.footprintMarchSteps = fieldTexture
            ? FOOTPRINT_MARCH_STEPS[effectBudgetMode('footprint-occlusion', qualityLevel)] ?? 0
            : 0;
        gl.activeTexture(gl.TEXTURE0 + SCENE_SAMPLER_UNITS.footprint);
        gl.bindTexture(gl.TEXTURE_2D, fieldTexture || this.emptyMaterialTexture);
        gl.uniform1i(uniforms.u_footprint, SCENE_SAMPLER_UNITS.footprint);
        gl.uniform3f(uniforms.u_footprintRect, finite(field?.originX), finite(field?.originY), fieldTexture ? finite(field.cell, 4) : 0);
        gl.uniform2i(uniforms.u_footprintSize, fieldTexture ? field.width : 0, fieldTexture ? field.height : 0);
        gl.uniform1i(uniforms.u_marchSteps, this.footprintMarchSteps);
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
        // The composite's world mapping (the scene pass's camera at full
        // backing resolution), read by the beam and the open-sea route.
        this._setCameraUniforms(this.compositeUniforms, camera, 1);
        gl.uniform2f(this.compositeUniforms.u_resolution, this.width, this.height);
        this._uploadBeamUniforms(this.compositeUniforms, feed.beam || null);
        this._uploadOpenSeaUniforms(qualityLevel, camera, feed);
        gl.activeTexture(gl.TEXTURE0 + COMPOSITE_SAMPLER_UNITS.scene);
        gl.bindTexture(gl.TEXTURE_2D, this.sceneTarget.textures[0]);
        gl.activeTexture(gl.TEXTURE0 + COMPOSITE_SAMPLER_UNITS.bloom);
        gl.bindTexture(gl.TEXTURE_2D, this.bloomB.textures[0]);
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        if (this._frameLoadPasses > 0) this._drawDebugLoad(this._frameLoadPasses);
    }

    // 2.7 — the Lighthouse fan (LIGHTHOUSE_BEAM_GLSL) for either program:
    // the in-map water and the open sea light the same dash cells. Off when
    // `beam` is null (day, dusk settling, dawn, or no Lighthouse).
    _uploadBeamUniforms(uniforms, beam) {
        const gl = this.gl;
        gl.uniform4f(uniforms.u_beamGround, finite(beam?.foot?.x, 0), finite(beam?.foot?.y, 0), finite(beam?.angle, 0), beam ? 1 : 0);
        if (!beam) return;
        gl.uniform4f(uniforms.u_beamShape, finite(beam.length, 320), BEAM_NEAR_HALF_WIDTH, finite(beam.farWidth, 58) / 2, finite(beam.sheenStep, 0));
        const courses = beam.courses || [];
        gl.uniform3f(uniforms.u_beamCourseEnds, finite(courses[0]?.[1], 0.34), finite(courses[1]?.[1], 0.68), finite(courses[2]?.[1], 1));
        gl.uniform3f(uniforms.u_beamCourseShares, finite(courses[0]?.[2], 1), finite(courses[1]?.[2], 0.6), finite(courses[2]?.[2], 0.3));
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
            // 3.4 — noise ceiling of the open sea's sunlit course (0 = off).
            sunlit: 0,
        });
        // Cover sets the covered share (`cloudCoveredShare`: none below cover
        // 0.15, so a fair-weather sky casts no blobs; partly cloudy ~38 %);
        // overcast/rain get none (the grade flattens instead) and the night
        // has no sun to cast them. Darkening per course is 8.5 %: three
        // courses reach ~25 % at the thickest core (course 1 ~0.92).
        const cover = clamp(finite(this._compositeCloudCover, 0), 0, 1);
        const cloudMode = effectBudgetMode('cloud-courses', qualityLevel);
        const cloudStrength = cloudMode === 'off' ? 0 : clamp(finite(grade.cloudShadow, 0), 0, 1);
        const covered = cloudCoveredShare(cover);
        // C-W3 — the one wind: the courses drift at 3 + 7·|windX| world px/s
        // along it (a third of that down-screen), integrated over the motion
        // clock in Wind.js so both backends agree and a wind change never
        // jumps them; frozen under reduced motion.
        const moving = !feed.reducedMotion && finite(feed.motionScale, 1) > 0;
        const drift = cloudCourseDrift(moving ? finite(feed.timeMs, 0) : null, feed.atmosphere?.weather);
        this.cloudCourses = cloudStrength > 0.02 && covered > 0 ? 3 : 0;
        if (this.cloudCourses) {
            // Wrapped to the combined field's period for float precision.
            const period = CLOUD_FIELD_PERIOD;
            courses.cloud[0] = ((-drift.x % period) + period) % period;
            courses.cloud[1] = ((-drift.y % period) + period) % period;
            courses.cloud[2] = 0.085 * cloudStrength;
            courses.thresholds[0] = cloudThreshold(covered);
            courses.thresholds[1] = cloudThreshold(covered * 0.55);
            courses.thresholds[2] = cloudThreshold(covered * 0.22);
            // 3.4 — sun on water: the sea's clearest share, 0.8 of the
            // covered share (where the field is lowest), takes one stop
            // lighter while the sun band is up; no clouds, no course (the
            // sea keeps its own stops, uniform).
            courses.sunlit = clamp(finite(grade.sunBand, 0), 0, 1) > 0.3 ? cloudThreshold(1 - covered * 0.8) : 0;
        } else {
            courses.cloud.fill(0);
            courses.thresholds.fill(2);
            courses.sunlit = 0;
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

    // 5.2 — the puddle courses: GroundBake's R8 site mask on scene unit 11
    // (uploaded once per ground bake through the V9 typed path, bound only
    // while the C-W2 ground history holds puddles), the puddle level, and
    // the graded sky palette's upper band and horizon the water reflects.
    _uploadPuddles(uniforms, feed) {
        const gl = this.gl;
        const puddles = clamp(finite(feed.puddles, 0), 0, 1);
        const mask = feed.puddleMask;
        const texture = puddles > 0.001 && mask?.data
            ? this.uploadTypedTexture('ground:puddle-mask', {
                width: mask.cols,
                height: mask.rows,
                format: 'r8',
                data: mask.data,
                revision: mask.revision,
            })
            : null;
        this._puddleActive = Boolean(texture);
        gl.activeTexture(gl.TEXTURE0 + SCENE_SAMPLER_UNITS.puddleMask);
        gl.bindTexture(gl.TEXTURE_2D, texture || this.emptyMaterialTexture);
        gl.uniform1i(uniforms.u_puddleMask, SCENE_SAMPLER_UNITS.puddleMask);
        gl.uniform1f(uniforms.u_puddles, texture ? puddles : 0);
        if (!texture) return;
        gl.uniform4f(uniforms.u_puddleRect, finite(mask.x0, 0), finite(mask.y0, 0), mask.cols, mask.rows);
        const palette = feed.skyPalette;
        if (palette !== this._puddleSkyPalette) {
            this._puddleSkyPalette = palette;
            this._puddleSky = new Float32Array([
                ...hexRgb01(palette?.upperBand, [0.62, 0.72, 0.80]),
                ...hexRgb01(palette?.horizon, [0.80, 0.84, 0.86]),
            ]);
        }
        gl.uniform3fv(uniforms.u_puddleSky, this._puddleSky);
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

    // 3.3 / 3.4 — the composite's open sea: the scene pass's grade, water
    // mood, weather, water clock and path (`_waterFx`, `_glint`), the sky's
    // horizon colours, this frame's cloud courses, the gust field and the
    // forecast squall. `sea-weather` sheds the sunlit course, the cat's paws
    // and the squall at MINIMAL (the island's cloud courses shed there too).
    _uploadOpenSeaUniforms(qualityLevel, camera, feed) {
        const gl = this.gl;
        const uniforms = this.compositeUniforms;
        const grade = this._frameGradeForComposite || frameGrade(feed);
        const atmosphere = feed.atmosphere || null;
        const weather = feed.weather || atmosphere?.weather || null;
        gl.uniform1i(uniforms.u_seaOn, 1);
        uploadGradeUniforms(gl, uniforms, grade);
        gl.uniform3fv(uniforms.u_fogColor, grade.fogColor);
        gl.uniform1f(uniforms.u_seaSunBand, clamp(finite(grade.sunBand, 1), 0, 1));
        const mood = waterMoodFor({ lightGrade: grade, weather });
        gl.uniform2f(uniforms.u_waterMood, mood.night, mood.storm);
        gl.uniform4fv(uniforms.u_weather, this._frameWeather || weatherUniform(feed));
        const shaderTimeMs = ((finite(feed.timeMs, Date.now()) % 1000000) + 1000000) % 1000000;
        gl.uniform1f(uniforms.u_time, shaderTimeMs);
        gl.uniform4fv(uniforms.u_waterFx, this._waterFx || OPEN_SEA_ZERO4);
        gl.uniform4fv(uniforms.u_glint, this._glint || OPEN_SEA_ZERO4);
        gl.uniform3fv(uniforms['u_glintStops[0]'], this._glintStops || OPEN_SEA_ZERO6);
        const sky = openSeaSky(atmosphere);
        gl.uniform4f(uniforms.u_seaHaze, sky.haze[0], sky.haze[1], sky.haze[2], openSeaHazeRows(weather?.fog));
        gl.uniform3fv(uniforms.u_seaSky, sky.horizon);
        const seaWeather = effectBudgetMode('sea-weather', qualityLevel) === 'on';
        if (this._atmosphereCourses) this._uploadAtmosphereCourses(uniforms, COMPOSITE_SAMPLER_UNITS.cloudTile);
        this._uploadSeaWeather(uniforms, COMPOSITE_SAMPLER_UNITS.seaGust);
        const squall = seaWeather ? openSeaSquall(weather, feed.timeMs) : null;
        gl.uniform4f(uniforms.u_squall, squall?.x ?? 0, squall?.y ?? 0, squall?.halfWidth ?? 1, squall?.strength ?? 0);
        gl.uniform1f(uniforms.u_squallFall, squall?.fall ?? 0);
        this.openSeaDiagnostics = { squall: Boolean(squall), paws: Boolean(this._seaWeatherFrame?.gust), sunlit: finite(this._seaWeatherFrame?.sunlit, 0) > 0 };
    }

    // 3.3 / 3.4 — the frame's sea weather (SEA_WEATHER_GLSL) for both the
    // scene's in-map open water and the composite's open sea: the sunlit
    // ceiling and the gust field, resolved once per frame so both passes read
    // the same step. `sea-weather` sheds both at MINIMAL. The gust upload (V9
    // typed path) runs here, before either pass binds a sampler.
    _resolveSeaWeather(qualityLevel, camera, feed) {
        const frame = this._seaWeatherFrame || (this._seaWeatherFrame = { sunlit: 0, gust: null });
        const seaWeather = effectBudgetMode('sea-weather', qualityLevel) === 'on';
        const weather = feed.weather || feed.atmosphere?.weather || null;
        frame.sunlit = seaWeather ? finite(this._atmosphereCourses?.sunlit, 0) : 0;
        frame.gust = seaWeather ? this._resolveSeaGust(camera, feed, weather) : null;
    }

    _uploadSeaWeather(uniforms, unit) {
        const gl = this.gl;
        const frame = this._seaWeatherFrame;
        const gust = frame?.gust || null;
        gl.uniform1f(uniforms.u_seaSunlit, finite(frame?.sunlit, 0));
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(gl.TEXTURE_2D, gust || this.emptyMaterialTexture);
        if (gust) {
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        }
        gl.uniform1i(uniforms.u_seaGust, unit);
        gl.uniform4fv(uniforms.u_seaGustRect, gust ? this._seaGust.rect : OPEN_SEA_ZERO4);
    }

    // 3.4 — C-W3 cat's paws: `Wind.windAt` gusts on a world-locked 128 x 128
    // grid over the view (texels 2:1, at least 16 x 8 world px), refreshed on
    // 125 ms steps of the motion clock (frozen under reduced motion) or when
    // the grid moves. Null in calm air.
    _resolveSeaGust(camera, feed, weather) {
        if (gustinessFor(baseWindX(weather)) <= 0) return null;
        const dpr = Math.max(0.25, finite(camera?._dpr?.(), 1));
        const zoom = Math.max(0.01, finite(camera?.zoom, 1));
        const originX = -finite(camera?.renderOffsetX, Math.round(finite(camera?.x) * zoom * dpr) / dpr) / zoom;
        const originY = -finite(camera?.renderOffsetY, Math.round(finite(camera?.y) * zoom * dpr) / dpr) / zoom;
        const viewW = this.width / (zoom * dpr);
        const viewH = this.height / (zoom * dpr);
        const cellX = Math.max(16, Math.ceil(viewW / (SEA_GUST_SIZE - 8) / 8) * 8);
        const cellY = Math.max(cellX / 2, Math.ceil(viewH / (SEA_GUST_SIZE - 8) / 4) * 4);
        const x0 = Math.floor(originX / cellX) * cellX - cellX * 4;
        const y0 = Math.floor(originY / cellY) * cellY - cellY * 4;
        const t = Math.floor(finite(feed.timeMs, 0) / SEA_GUST_STEP_MS) * SEA_GUST_STEP_MS;
        const state = this._seaGust || (this._seaGust = {
            data: new Uint8Array(SEA_GUST_SIZE * SEA_GUST_SIZE),
            rect: new Float32Array(4),
            key: '',
            revision: 0,
            wind: { x: 0, gust: 0 },
        });
        const key = `${x0},${y0},${cellX},${cellY},${t},${weather?.windX},${weather?.type},${weather?.seed}`;
        if (key !== state.key) {
            for (let j = 0; j < SEA_GUST_SIZE; j++) {
                const wy = y0 + (j + 0.5) * cellY;
                for (let i = 0; i < SEA_GUST_SIZE; i++) {
                    state.data[j * SEA_GUST_SIZE + i] = Math.round(windAt(x0 + (i + 0.5) * cellX, wy, t, weather, state.wind).gust * 255);
                }
            }
            state.key = key;
            state.revision += 1;
            state.rect[0] = x0;
            state.rect[1] = y0;
            state.rect[2] = cellX;
            state.rect[3] = cellY;
        }
        return this.uploadTypedTexture('sea:gust', {
            width: SEA_GUST_SIZE,
            height: SEA_GUST_SIZE,
            format: 'r8',
            data: state.data,
            revision: state.revision,
        });
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
        return occluderChannelFor(feed);
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
            ? occluderChannelFor(feed)
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
            this._stageFrameVertices(batches);
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
            // 2.2 — the footprint march length this frame (0 = off).
            footprintMarchSteps: this.footprintMarchSteps,
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
            + targetBytes(this.bloomA) + targetBytes(this.bloomB);
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

// The browser's WebGL2 rasterizer, probed once per page on throwaway
// canvases (the World's own canvases keep their first context type). A
// software rasterizer is one the browser flags with a major performance
// caveat, or whose renderer string names one (headless Chromium's
// SwiftShader passes the caveat check). `RENDERER` is unmasked in Firefox and
// Safari; Chromium masks it, so its debug extension names the driver.
let rasterProbe = null;

export function probeWebgl2Raster() {
    if (rasterProbe) return rasterProbe;
    rasterProbe = { webgl2: false, softwareRaster: false, renderer: null };
    if (typeof document === 'undefined') return rasterProbe;
    const contexts = [];
    try {
        const strict = document.createElement('canvas').getContext('webgl2', { failIfMajorPerformanceCaveat: true });
        if (strict) contexts.push(strict);
        const gl = strict || document.createElement('canvas').getContext('webgl2');
        if (!gl) return rasterProbe;
        if (gl !== strict) contexts.push(gl);
        let renderer = String(gl.getParameter(gl.RENDERER) || '');
        if (!renderer || /^webkit webgl$/i.test(renderer)) {
            const info = gl.getExtension('WEBGL_debug_renderer_info');
            if (info) renderer = String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL) || renderer);
        }
        rasterProbe = { webgl2: true, softwareRaster: !strict || isSoftwareRasterizer(renderer), renderer };
    } catch {
        // No WebGL2 at all: the Canvas world.
    } finally {
        for (const context of contexts) context.getExtension('WEBGL_lose_context')?.loseContext();
    }
    return rasterProbe;
}
