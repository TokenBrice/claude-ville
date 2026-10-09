// Wave 10 (10.1 Stage A) — the WGSL pieces every WebGPU module shares: the
// GLSL-builtin spellings the twins transliterate through, the frame and batch
// uniform blocks (field tables with generated WGSL-uniform offsets, so the
// struct text and the CPU writer cannot drift), the V9 record struct built
// from GpuRecordLayout's own field table, and the bind-group declarations of
// the scene, particle and composite modules (docs/material-channel-contract.md,
// "WebGPU backend").
//
// Naming: a uniform field is its GLSL uniform without `u_` (u_gradeGain ->
// frame.gradeGain), except the few the WebGPU twins spell by meaning
// (cameraXy/cameraScale for u_camera, timeMs for u_time, radianceTex for
// u_radiance). GLSL bools are u32 (0/1): `u_seaOn` reads `frame.seaOn != 0u`.
import { GPU_RECORD_FLAGS } from '../GpuWorldPolicy.js';
import { RECORD_LAYOUT, RECORD_INSTANCE_BYTES, RECEIVER_BIAS } from '../GpuRecordLayout.js';

// GLSL builtins WGSL spells differently. `fract` stays the builtin (ANGLE and
// Tint both lower it to Metal's fract, so the two agree bit for bit); `mod` is
// GLSL's x - y * floor(x / y), never WGSL's truncating `%`.
export const WGSL_COMMON = /* wgsl */ `
fn glslMod(x: f32, y: f32) -> f32 { return x - y * floor(x / y); }
fn glslMod2(x: vec2f, y: vec2f) -> vec2f { return x - y * floor(x / y); }
fn glslMod3(x: vec3f, y: vec3f) -> vec3f { return x - y * floor(x / y); }
fn glslMod4(x: vec4f, y: vec4f) -> vec4f { return x - y * floor(x / y); }
fn glslFract(x: f32) -> f32 { return fract(x); }
fn fract3(v: vec3f) -> vec3f { return fract(v); }
fn glslSign(x: f32) -> f32 { return select(select(0.0, -1.0, x < 0.0), 1.0, x > 0.0); }
fn glslAtan(y: f32, x: f32) -> f32 { return atan2(y, x); }
fn bayer2(a0: vec2f) -> f32 { let a = floor(a0); return fract(dot(a, vec2f(0.5, a.y * 0.75))); }
fn bayer4(p: vec2f) -> f32 { return bayer2(0.5 * p) * 0.25 + bayer2(p); }
fn encodeBits(v: f32) -> vec4f { let b = bitcast<u32>(v); return vec4f(f32(b & 255u), f32((b >> 8u) & 255u), f32((b >> 16u) & 255u), f32(b >> 24u)) / 255.0; }
`;

// WGSL `uniform` address-space layout: [align, size] per member type. vec3
// aligns to 16 with size 12 (a following scalar packs into its fourth lane);
// arrays are only of vec4 (16-byte stride, legal in uniform space).
const UNIFORM_TYPES = Object.freeze({
    f32: [4, 4], i32: [4, 4], u32: [4, 4],
    vec2f: [8, 8], vec2i: [8, 8], vec2u: [8, 8],
    vec3f: [16, 12], vec3i: [16, 12], vec3u: [16, 12],
    vec4f: [16, 16], vec4i: [16, 16], vec4u: [16, 16],
});
const SCALAR_KIND = Object.freeze({ f: 'f32', i: 'i32', u: 'u32' });

function memberShape(type) {
    const array = /^array<(vec4[fiu]), (\d+)>$/.exec(type);
    if (array) return { align: 16, size: 16 * Number(array[2]), lanes: 4 * Number(array[2]), kind: array[1].at(-1) };
    const spec = UNIFORM_TYPES[type];
    if (!spec) throw new Error(`unsupported WGSL uniform type: ${type}`);
    const lanes = type.startsWith('vec') ? Number(type[3]) : 1;
    const kind = type.startsWith('vec') ? type.at(-1) : type[0];
    return { align: spec[0], size: spec[1], lanes, kind };
}

/**
 * The generated layout of one uniform struct: every field's byte offset by
 * WGSL's uniform rules, the struct size rounded to 16, and the struct text.
 * `fields` is `[name, type]` in declaration order.
 */
export function uniformLayout(name, fields, { minSize = 0 } = {}) {
    let offset = 0;
    const out = [];
    for (const [field, type] of fields) {
        const shape = memberShape(type);
        offset = Math.ceil(offset / shape.align) * shape.align;
        out.push(Object.freeze({ name: field, type, offset, lanes: shape.lanes, kind: shape.kind }));
        offset += shape.size;
    }
    const size = Math.max(minSize, Math.ceil(offset / 16) * 16);
    const wgsl = `struct ${name} {\n${out.map(field => `  ${field.name}: ${field.type},`).join('\n')}\n}\n`;
    return Object.freeze({
        name,
        fields: Object.freeze(out),
        byName: Object.freeze(Object.fromEntries(out.map(field => [field.name, field]))),
        size,
        wgsl,
    });
}

/** Views over one uniform staging buffer (`f32`, `i32`, `u32` share bytes). */
export function createUniformViews(byteLength) {
    const buffer = new ArrayBuffer(byteLength);
    return { buffer, f32: new Float32Array(buffer), i32: new Int32Array(buffer), u32: new Uint32Array(buffer) };
}

function laneValue(value, kind) {
    if (kind === 'f') {
        const number = Number(value);
        return Number.isFinite(number) ? number : 0;
    }
    if (typeof value === 'boolean') return value ? 1 : 0;
    const number = Math.trunc(Number(value));
    return Number.isFinite(number) ? number : 0;
}

/**
 * Writes `state[field]` for every field present in `state` at `byteOffset`
 * (a dynamic-offset slot). Scalars take a number or boolean; vectors and
 * arrays an array-like of their lanes (missing lanes stay as they were).
 */
export function writeUniforms(layout, views, state, byteOffset = 0) {
    const base = byteOffset >> 2;
    for (const field of layout.fields) {
        if (!(field.name in state)) continue;
        const value = state[field.name];
        const view = views[SCALAR_KIND[field.kind]];
        const at = base + (field.offset >> 2);
        if (field.lanes === 1) {
            view[at] = laneValue(value, field.kind);
            continue;
        }
        const count = Math.min(field.lanes, value?.length ?? 0);
        for (let lane = 0; lane < count; lane++) view[at + lane] = laneValue(value[lane], field.kind);
    }
}

// §2.5 — the frame block: the scene pass, the particle draw and the composite
// (its open sea) bind the same instance.
export const FRAME_UNIFORM_LAYOUT = uniformLayout('FrameUniforms', [
    ['cameraXy', 'vec2f'], ['resolution', 'vec2f'],
    ['cameraScale', 'f32'], ['timeMs', 'f32'], ['motionScale', 'f32'], ['overcast', 'f32'],
    ['fogColor', 'vec3f'], ['coreEnergy', 'f32'],
    ['weather', 'vec4f'],
    ['sun', 'vec4f'],
    ['gradeGain', 'vec3f'], ['gradeExposure', 'f32'],
    ['gradeLift', 'vec3f'], ['gradeSaturation', 'f32'],
    ['gradeGamma', 'vec3f'], ['edgeAlpha', 'f32'],
    ['gradePurkinje', 'vec3f'], ['poolGain', 'f32'],
    ['gradeShadow', 'vec3f'], ['packedGeometry', 'u32'],
    ['gradeHighlight', 'vec3f'], ['fatPixels', 'u32'],
    ['gradeEdge', 'vec3f'], ['seaSunlit', 'f32'],
    ['cloud', 'vec4f'],
    ['cloudThresholds', 'vec3f'], ['seaSunBand', 'f32'],
    ['haze', 'vec4f'],
    ['seaGustRect', 'vec4f'],
    ['waterFx', 'vec4f'],
    ['glint', 'vec4f'],
    ['glintStops', 'array<vec4f, 2>'],
    ['coastRect', 'vec4f'],
    ['waterMood', 'vec2f'], ['wetness', 'f32'], ['wetReflectionCount', 'i32'],
    ['lightTileGrid', 'vec3i'], ['lightCount', 'i32'],
    ['footprintRect', 'vec3f'], ['marchSteps', 'i32'],
    ['footprintSize', 'vec2i'], ['puddles', 'f32'], ['hasPaletteLut', 'u32'],
    ['beamGround', 'vec4f'],
    ['beamShape', 'vec4f'],
    ['beamCourseEnds', 'vec3f'], ['seaOn', 'u32'],
    ['beamCourseShares', 'vec3f'], ['squallFall', 'f32'],
    ['puddleRect', 'vec4f'],
    ['puddleSky', 'array<vec4f, 2>'],
    ['radianceGrid', 'vec4f'],
    ['radianceGain', 'vec4f'],
    ['radianceStrength', 'vec2f'], ['bloomStrength', 'f32'], ['hdrEnabled', 'u32'],
    ['seaHaze', 'vec4f'],
    ['seaSky', 'vec3f'], ['hdrMode', 'u32'],
    ['squall', 'vec4f'],
    ['flash', 'vec3f'], ['hdrMarkGain', 'f32'],
    ['hdrEmitterGain', 'vec3f'], ['p3Enabled', 'u32'],
    // 10.2 — DisplayColor hdrGainTable(mode).emitterCap (linear luminance).
    // W6.11 — `grassGust` (GpuFrameState.resolveSeaWeather) takes the pad
    // before `cloudLone`, so the block's size is unchanged.
    ['hdrEmitterCap', 'f32'], ['grassGust', 'f32'],
    // W6.3 — the lone fair-weather cumulus (GpuFrameState courses.lone).
    ['cloudLone', 'vec4f'],
    // Night sea glints; appended so every existing frame offset stays fixed.
    ['starlight', 'f32'],
]);

// §2.6 — the per-batch block, one 256-byte slot per batch in a frame ring
// bound with a dynamic offset.
export const BATCH_UNIFORM_STRIDE = 256;
export const BATCH_UNIFORM_LAYOUT = uniformLayout('BatchUniforms', [
    ['albedoSize', 'vec2f'],
    ['albedoPaged', 'u32'], ['fatPixels', 'u32'],
    ['additive', 'u32'], ['terrainBatch', 'u32'], ['puddleGround', 'u32'], ['hasMaterialMap', 'u32'],
    ['hasEmissiveMap', 'u32'], ['hasOccluderMap', 'u32'], ['cueRuns', 'u32'], ['writesDepth', 'u32'],
]);
if (BATCH_UNIFORM_LAYOUT.size > BATCH_UNIFORM_STRIDE) throw new Error('BatchUniforms exceeds its dynamic-offset slot');

export function writeFrameUniforms(views, state) {
    writeUniforms(FRAME_UNIFORM_LAYOUT, views, state, 0);
}

export function writeBatchUniforms(views, slot, state) {
    writeUniforms(BATCH_UNIFORM_LAYOUT, views, state, slot * BATCH_UNIFORM_STRIDE);
}

// §2.4 — the V9 record as GpuRecordLayout stages it, in scalar lanes so the
// storage array stride is exactly RECORD_INSTANCE_BYTES (vec4 lanes would pad
// it to 80). float32 fields are one f32 lane per component; uint16 pairs are
// one u32 lane each (low half = first component, little-endian). Built from
// RECORD_LAYOUT, so a layout change changes the struct.
const LANE_NAMES = 'xyzw';
function recordLanes() {
    const lanes = [];
    for (const field of RECORD_LAYOUT) {
        if (field.type === 'float32') {
            for (let index = 0; index < field.count; index++) lanes.push([`${field.name}${LANE_NAMES[index]}`, 'f32', field]);
        } else {
            for (let index = 0; index < field.count; index += 2) {
                lanes.push([`${field.name}${LANE_NAMES[index]}${LANE_NAMES[index + 1]}`, 'u32', field]);
            }
        }
    }
    return lanes;
}
const RECORD_LANES = recordLanes();
if (RECORD_LANES.length * 4 !== RECORD_INSTANCE_BYTES) throw new Error('RecordInstance lanes do not tile the record');

function recordAccessor(field) {
    const lanes = RECORD_LANES.filter(lane => lane[2] === field).map(lane => lane[0]);
    if (field.type === 'float32') {
        return `fn record${field.name[0].toUpperCase()}${field.name.slice(1)}(r: RecordInstance) -> vec4f { return vec4f(${lanes.map(lane => `r.${lane}`).join(', ')}); }`;
    }
    // A uint16 attribute, read as the GLSL attribute reads it: the exact
    // integer as a float (loc3/loc4) or as an unsigned integer (loc5).
    const halves = lanes.flatMap(lane => [`(r.${lane} & 0xffffu)`, `(r.${lane} >> 16u)`]);
    if (field.count === 2) {
        return `fn record${field.name[0].toUpperCase()}${field.name.slice(1)}(r: RecordInstance) -> vec2u { return vec2u(${halves.join(', ')}); }`;
    }
    return `fn record${field.name[0].toUpperCase()}${field.name.slice(1)}(r: RecordInstance) -> vec4f { return vec4f(${halves.map(half => `f32${half}`).join(', ')}); }`;
}

export const RECORD_STRUCT_WGSL = `
struct RecordInstance {
${RECORD_LANES.map(([name, type]) => `  ${name}: ${type},`).join('\n')}
}
${RECORD_LAYOUT.map(recordAccessor).join('\n')}
`;

// Generated constants: the V9 flag bits and the receiver bias, from the JS.
export const RECORD_CONSTANTS_WGSL = [
    ...Object.entries(GPU_RECORD_FLAGS).map(([name, bit]) => (
        `const RECORD_FLAG_${name.replace(/[A-Z]/g, letter => `_${letter}`).toUpperCase()}: u32 = ${bit}u;`
    )),
    `const RECEIVER_BIAS: f32 = ${RECEIVER_BIAS}.0;`,
].join('\n');

// §2.2 — group 0, rebound per frame. Shared by the scene, particle and
// composite modules (one bind group per frame). Nearest reads use
// `nearestSampler` (clamp) or textureLoad; `linearSampler` is linear clamp.
// The light records are a read-only storage buffer holding the floats the
// WebGL2 world uploads as its RGBA32F record texture, verbatim (row r, light
// i at r * MAX_LIGHT_RECORDS + i): the light walk reads them per light per
// pixel, where a buffer load is measurably cheaper than a texture fetch.
export const FRAME_BINDING = Object.freeze({
    frame: 0, cloudTile: 1, cloudSampler: 2, seaGust: 3, seaGustSampler: 4,
    lightData: 5, lightTiles: 6, footprint: 7, cycleOffset: 8, coastField: 9,
    puddleMask: 10, paletteLut: 11, nearestSampler: 12, radianceTex: 13, radianceSampler: 14,
    motifs: 15, linearSampler: 16,
});
export const FRAME_BINDINGS_WGSL = `
${FRAME_UNIFORM_LAYOUT.wgsl}
@group(0) @binding(${FRAME_BINDING.frame}) var<uniform> frame: FrameUniforms;
@group(0) @binding(${FRAME_BINDING.cloudTile}) var cloudTile: texture_2d<f32>;
@group(0) @binding(${FRAME_BINDING.cloudSampler}) var cloudSampler: sampler;
@group(0) @binding(${FRAME_BINDING.seaGust}) var seaGust: texture_2d<f32>;
@group(0) @binding(${FRAME_BINDING.seaGustSampler}) var seaGustSampler: sampler;
@group(0) @binding(${FRAME_BINDING.lightData}) var<storage, read> lightData: array<vec4f>;
@group(0) @binding(${FRAME_BINDING.lightTiles}) var lightTiles: texture_2d<u32>;
@group(0) @binding(${FRAME_BINDING.footprint}) var footprint: texture_2d<f32>;
@group(0) @binding(${FRAME_BINDING.cycleOffset}) var cycleOffset: texture_2d<f32>;
@group(0) @binding(${FRAME_BINDING.coastField}) var coastField: texture_2d<f32>;
@group(0) @binding(${FRAME_BINDING.puddleMask}) var puddleMask: texture_2d<f32>;
@group(0) @binding(${FRAME_BINDING.paletteLut}) var paletteLut: texture_2d<f32>;
@group(0) @binding(${FRAME_BINDING.nearestSampler}) var nearestSampler: sampler;
@group(0) @binding(${FRAME_BINDING.radianceTex}) var radianceTex: texture_2d<f32>;
@group(0) @binding(${FRAME_BINDING.radianceSampler}) var radianceSampler: sampler;
@group(0) @binding(${FRAME_BINDING.motifs}) var motifs: texture_2d<f32>;
@group(0) @binding(${FRAME_BINDING.linearSampler}) var linearSampler: sampler;
`;

// §2.3 — group 1 of the scene (and mark) pipelines, per batch. Both albedo
// bindings always exist (the inactive one is a 1x1 stand-in); `recs` holds
// the whole frame's records and a batch draws its slice through
// firstInstance (`@builtin(instance_index)` includes it).
export const BATCH_BINDING = Object.freeze({
    batch: 0, recs: 1, albedo: 2, albedoPage: 3, materialMap: 4, emissiveMap: 5, occluderMap: 6, albedoSampler: 7,
});
export const BATCH_BINDINGS_WGSL = `
${BATCH_UNIFORM_LAYOUT.wgsl}
${RECORD_STRUCT_WGSL}
${RECORD_CONSTANTS_WGSL}
@group(1) @binding(${BATCH_BINDING.batch}) var<uniform> batch: BatchUniforms;
@group(1) @binding(${BATCH_BINDING.recs}) var<storage, read> recs: array<RecordInstance>;
@group(1) @binding(${BATCH_BINDING.albedo}) var albedo: texture_2d<f32>;
@group(1) @binding(${BATCH_BINDING.albedoPage}) var albedoPage: texture_2d_array<f32>;
@group(1) @binding(${BATCH_BINDING.materialMap}) var materialMap: texture_2d<f32>;
@group(1) @binding(${BATCH_BINDING.emissiveMap}) var emissiveMap: texture_2d<f32>;
@group(1) @binding(${BATCH_BINDING.occluderMap}) var occluderMap: texture_2d<f32>;
@group(1) @binding(${BATCH_BINDING.albedoSampler}) var albedoSampler: sampler;
`;

// Group 1 of the composite: the scene colour target (nearest) and the bloom
// result (linear), sampled with group 0's samplers.
export const COMPOSITE_BINDING = Object.freeze({ sceneColor: 0, bloomColor: 1 });
export const COMPOSITE_BINDINGS_WGSL = `
@group(1) @binding(${COMPOSITE_BINDING.sceneColor}) var sceneColor: texture_2d<f32>;
@group(1) @binding(${COMPOSITE_BINDING.bloomColor}) var bloomColor: texture_2d<f32>;
`;

// The full-screen triangle the presenting passes draw onto the (unmirrored)
// canvas. `uv` keeps GL's bottom-left origin (the interpolation GL's v_uv
// runs), because every offscreen target a post pass reads is stored in GL's
// row order (scene.js, bloom.js): the bloom result is sampled at `uv`, the
// scene target loaded at row `H - 1 - position.y`.
export const FULLSCREEN_WGSL = `
struct FullscreenOut {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
}
@vertex fn fullscreenVs(@builtin(vertex_index) vi: u32) -> FullscreenOut {
  var positions = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  var uvs = array<vec2f, 3>(vec2f(0.0, 0.0), vec2f(2.0, 0.0), vec2f(0.0, 2.0));
  var out: FullscreenOut;
  out.position = vec4f(positions[vi], 0.0, 1.0);
  out.uv = uvs[vi];
  return out;
}
`;
