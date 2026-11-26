// Wave 0.4 — Record-ID Pixel Attribution Encoder, Decoder, Bucketer & Debug Shaders
//
// 32-bit attribution word layout (Spec 03 §3.3):
//   bits  0..15 : recordIndex + 1 (0 = open-sea / background, 1..65535 = records[recordIndex])
//   bits 16..19 : regionClass     (0..15, see REGION_CLASS)
//   bits 20..23 : shaderTag       (4-bit bitmask, see SHADER_TAG)
//   bits 24..31 : layerByte       (0..255, agent layer / draw band)
//
// WebGPU writes directly into an `r32uint` attachment (`u32`).
// WebGL2 writes the identical 32-bit word into a non-blended `RGBA8` attachment
// as little-endian bytes `[idLo, idMid, idHi, flagsByte]`:
//   R = bits  0.. 7  (recordSlot low byte)
//   G = bits  8..15  (recordSlot high byte)
//   B = bits 16..23  ((shaderTag << 4) | regionClass)
//   A = bits 24..31  (layerByte)
//
// Zero production runtime cost: debug pipelines are compiled on demand only
// when `scripts/visual/capture.mjs` or `scripts/smoke/webgpu-parity.mjs` asks
// for an attribution pass.

export const REGION_CLASS = Object.freeze({
    openSea: 0,
    landGround: 1,
    paintedWater: 2,
    buildingRoof: 3,
    buildingWall: 4,
    propOrTree: 5,
    agentBody: 6,
    agentAttachment: 7,
    reflection: 8,
    weatherOrRain: 9,
    markOrOverlay: 10,
});

export const REGION_CLASS_NAMES = Object.freeze(
    Object.fromEntries(Object.entries(REGION_CLASS).map(([name, id]) => [id, name])),
);

export const SHADER_TAG = Object.freeze({
    none: 0,
    waterRipple: 1 << 0,      // word bit 20
    cloudCourseEdge: 1 << 1,  // word bit 21
    bakedRim: 1 << 2,         // word bit 22
    sunShadeEdge: 1 << 3,     // word bit 23
});

export const SHADER_TAG_NAMES = Object.freeze([
    [SHADER_TAG.waterRipple, 'waterRipple'],
    [SHADER_TAG.cloudCourseEdge, 'cloudCourseEdge'],
    [SHADER_TAG.bakedRim, 'bakedRim'],
    [SHADER_TAG.sunShadeEdge, 'sunShadeEdge'],
]);

// Known cross-backend f32-boundary tags that explain <= few-LSB course edges.
export const EXPLAINED_SHADER_TAG_MASK =
    SHADER_TAG.waterRipple
    | SHADER_TAG.cloudCourseEdge
    | SHADER_TAG.bakedRim
    | SHADER_TAG.sunShadeEdge;

export const MAX_RECORD_INDEX = 65534; // recordSlot 65535 = recordIndex + 1

/**
 * Encode a 32-bit attribution word.
 * @param {object} params
 * @param {number|null|undefined} params.recordIndex - 0-based index into frozen records, or -1/null for open-sea background (slot 0)
 * @param {number|string} [params.regionClass=0] - region class id (0..15) or key from REGION_CLASS
 * @param {number} [params.shaderTag=0] - 4-bit shader tag mask (0..15)
 * @param {number} [params.layerByte=0] - 8-bit draw band / agent layer (0..255)
 * @returns {number} unsigned 32-bit integer
 */
export function encodeAttributionWord({
    recordIndex = -1,
    regionClass = 0,
    shaderTag = 0,
    layerByte = 0,
} = {}) {
    let recordSlot = 0;
    if (recordIndex !== null && recordIndex !== undefined && recordIndex >= 0) {
        if (!Number.isInteger(recordIndex) || recordIndex > MAX_RECORD_INDEX) {
            throw new RangeError(`recordIndex must be an integer in [-1, ${MAX_RECORD_INDEX}], got ${recordIndex}`);
        }
        recordSlot = recordIndex + 1;
    } else if (recordIndex !== -1 && recordIndex !== null && recordIndex !== undefined) {
        throw new RangeError(`recordIndex must be >= -1, got ${recordIndex}`);
    }

    const resolvedRegion = typeof regionClass === 'string'
        ? REGION_CLASS[regionClass]
        : regionClass;
    if (!Number.isInteger(resolvedRegion) || resolvedRegion < 0 || resolvedRegion > 15) {
        throw new RangeError(`regionClass must be in [0, 15], got ${regionClass}`);
    }
    if (!Number.isInteger(shaderTag) || shaderTag < 0 || shaderTag > 15) {
        throw new RangeError(`shaderTag must be a 4-bit mask in [0, 15], got ${shaderTag}`);
    }
    if (!Number.isInteger(layerByte) || layerByte < 0 || layerByte > 255) {
        throw new RangeError(`layerByte must be in [0, 255], got ${layerByte}`);
    }

    return (
        (recordSlot & 0xFFFF)
        | ((resolvedRegion & 0x0F) << 16)
        | ((shaderTag & 0x0F) << 20)
        | ((layerByte & 0xFF) << 24)
    ) >>> 0;
}

/**
 * Decode a 32-bit attribution word into structured fields.
 * @param {number} word
 */
export function decodeAttributionWord(word) {
    const u = word >>> 0;
    const recordSlot = u & 0xFFFF;
    const recordIndex = recordSlot > 0 ? recordSlot - 1 : -1;
    const regionClass = (u >>> 16) & 0x0F;
    const shaderTag = (u >>> 20) & 0x0F;
    const layerByte = (u >>> 24) & 0xFF;
    const shaderTags = [];
    for (const [bit, name] of SHADER_TAG_NAMES) {
        if ((shaderTag & bit) !== 0) shaderTags.push(name);
    }
    return {
        word: u,
        recordSlot,
        recordIndex,
        regionClass,
        regionName: REGION_CLASS_NAMES[regionClass] || `region${regionClass}`,
        shaderTag,
        shaderTags,
        layerByte,
    };
}

/**
 * Pack a 32-bit attribution word into 4 RGBA8 bytes (little-endian).
 * Matches WebGL2 RGBA8 attachment layout `[idLo, idMid, idHi, flagsByte]`.
 */
export function packRgba8Attribution(word, target = new Uint8Array(4), offset = 0) {
    const u = word >>> 0;
    target[offset] = u & 0xFF;
    target[offset + 1] = (u >>> 8) & 0xFF;
    target[offset + 2] = (u >>> 16) & 0xFF;
    target[offset + 3] = (u >>> 24) & 0xFF;
    return target;
}

/**
 * Unpack 4 RGBA8 bytes (little-endian) back into a 32-bit attribution word.
 */
export function unpackRgba8Attribution(rgba, offset = 0) {
    return (
        (rgba[offset] & 0xFF)
        | ((rgba[offset + 1] & 0xFF) << 8)
        | ((rgba[offset + 2] & 0xFF) << 16)
        | ((rgba[offset + 3] & 0xFF) << 24)
    ) >>> 0;
}

/**
 * Convert either an `r32uint` (`Uint32Array`) or `rgba8` (`Uint8Array`)
 * attribution readback into a canonical `Uint32Array(width * height)`.
 */
export function decodeAttributionBuffer(buffer, width, height, format = 'auto') {
    if (!buffer) return null;
    const count = width * height;
    const resolved = format === 'auto'
        ? (buffer instanceof Uint32Array ? 'r32uint' : 'rgba8')
        : format;
    if (resolved === 'r32uint') {
        if (buffer instanceof Uint32Array) {
            if (buffer.length !== count) {
                throw new Error(`r32uint attribution length ${buffer.length} != ${count}`);
            }
            return buffer;
        }
        if (buffer.byteLength !== count * 4) {
            throw new Error(`r32uint attribution byteLength ${buffer.byteLength} != ${count * 4}`);
        }
        const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
        const out = new Uint32Array(count);
        for (let i = 0; i < count; i++) out[i] = view.getUint32(i * 4, true);
        return out;
    }
    if (resolved === 'rgba8') {
        const bytes = buffer instanceof Uint8Array
            ? buffer
            : new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
        if (bytes.length !== count * 4) {
            throw new Error(`rgba8 attribution length ${bytes.length} != ${count * 4}`);
        }
        const out = new Uint32Array(count);
        for (let i = 0, b = 0; i < count; i++, b += 4) {
            out[i] = unpackRgba8Attribution(bytes, b);
        }
        return out;
    }
    throw new Error(`Unsupported attribution buffer format: ${format}`);
}

/**
 * Classify a frozen GPU scene record into `{ regionClass, layerByte }`.
 * Works with both normalized GPU records and raw scene records.
 */
export function classifyRecordRegion(record) {
    if (!record || typeof record !== 'object') {
        return { regionClass: REGION_CLASS.openSea, layerByte: 0 };
    }
    const id = String(record.id || record.debugId || record.key || '').toLowerCase();
    const kind = String(record.kind || record.role || '').toLowerCase();
    const flags = (record.flags | 0)
        | (record.reflect === true ? 2 : 0)
        | (record.screenSpace === true ? 8 : 0)
        | (record.cueRun === true ? 128 : 0)
        | (record.actionMark === true ? 512 : 0);
    const layerByte = Math.max(0, Math.min(255, Number.isFinite(record.layer) ? (record.layer | 0) : 0));

    // GPU_RECORD_FLAGS.reflect = 2, screenSpace = 8, cueRun = 128, actionMark = 512
    if ((flags & 2) !== 0 || kind === 'reflection' || id.includes('reflect')) {
        return { regionClass: REGION_CLASS.reflection, layerByte };
    }
    if ((flags & (8 | 128 | 512)) !== 0 || kind === 'mark' || id.startsWith('mark:') || id.startsWith('overlay.')) {
        return { regionClass: REGION_CLASS.markOrOverlay, layerByte };
    }
    if (kind === 'weather' || kind === 'rain' || id.startsWith('weather:') || id.startsWith('atmosphere.')) {
        return { regionClass: REGION_CLASS.weatherOrRain, layerByte };
    }
    if (id.startsWith('agent:') || kind === 'agent') {
        if (
            id.includes(':weapon') || id.includes(':hat') || id.includes(':head')
            || id.includes(':attachment') || id.includes(':artifact') || id.includes(':cape')
            || kind === 'agent-attachment'
        ) {
            return { regionClass: REGION_CLASS.agentAttachment, layerByte };
        }
        return { regionClass: REGION_CLASS.agentBody, layerByte };
    }
    if (id.startsWith('building:') || id.startsWith('building.') || kind === 'building') {
        if (id.includes('roof') || kind === 'building-roof') {
            return { regionClass: REGION_CLASS.buildingRoof, layerByte };
        }
        return { regionClass: REGION_CLASS.buildingWall, layerByte };
    }
    if (id.startsWith('water:') || kind === 'water' || id.includes('coast-water')) {
        return { regionClass: REGION_CLASS.paintedWater, layerByte };
    }
    if (id.startsWith('terrain:') || id.startsWith('ground:') || kind === 'terrain' || kind === 'ground') {
        return { regionClass: REGION_CLASS.landGround, layerByte };
    }
    if (
        id.startsWith('prop:') || id.startsWith('prop.') || id.startsWith('veg.')
        || id.startsWith('bridge.') || id.startsWith('dock.') || kind === 'prop' || kind === 'tree'
    ) {
        return { regionClass: REGION_CLASS.propOrTree, layerByte };
    }
    return { regionClass: REGION_CLASS.landGround, layerByte };
}

/**
 * Bucket >1 LSB parity diff pixels using an attribution buffer.
 *
 * A non-rim >1 LSB pixel is counted as `explainedNonRimOver1` if its
 * attribution word carries a known boundary shaderTag (`waterRipple`,
 * `cloudCourseEdge`, `bakedRim`, `sunShadeEdge`). Otherwise it counts toward
 * `unclassifiedNonRimOver1` so real sprite/building parity bugs fail loudly.
 *
 * @param {object} params
 * @param {Uint8Array} params.pixelD - per-pixel maxAbsDiff over RGBA (`length === width * height`)
 * @param {Uint32Array|Uint8Array} params.attribution - decoded r32uint or raw rgba8 buffer
 * @param {string} [params.attributionFormat='auto']
 * @param {Array<{id?: string}>} [params.records=[]]
 * @param {Uint8Array|null} [params.rimMask=null]
 * @param {number} params.width
 * @param {number} params.height
 * @param {number} [params.threshold=1] - diff > threshold is bucketed
 */
export function bucketAttributionDiffs({
    pixelD,
    attribution,
    attributionFormat = 'auto',
    records = [],
    rimMask = null,
    width,
    height,
    threshold = 1,
}) {
    const count = width * height;
    const words = decodeAttributionBuffer(attribution, width, height, attributionFormat);
    let over1Total = 0;
    let rimOver1 = 0;
    let explainedNonRimOver1 = 0;
    let unclassifiedNonRimOver1 = 0;
    const byTag = {};
    const byRegion = {};
    const byRecord = {};

    for (let p = 0; p < count; p++) {
        if (pixelD[p] <= threshold) continue;
        over1Total++;
        const isRim = Boolean(rimMask && rimMask[p]);
        if (isRim) {
            rimOver1++;
            continue;
        }
        if (!words) {
            unclassifiedNonRimOver1++;
            byTag['unclassified:noAttribution'] = (byTag['unclassified:noAttribution'] || 0) + 1;
            continue;
        }
        const decoded = decodeAttributionWord(words[p]);
        const region = decoded.regionName;
        byRegion[region] = (byRegion[region] || 0) + 1;

        const recordLabel = decoded.recordIndex >= 0
            ? (records[decoded.recordIndex]?.id || records[decoded.recordIndex]?.debugId || `record:${decoded.recordIndex}`)
            : 'openSea';
        byRecord[recordLabel] = (byRecord[recordLabel] || 0) + 1;

        const explained = (decoded.shaderTag & EXPLAINED_SHADER_TAG_MASK) !== 0;
        if (explained) {
            explainedNonRimOver1++;
            const tagSuffix = decoded.shaderTags.join('+');
            const key = `${region}:${tagSuffix}`;
            byTag[key] = (byTag[key] || 0) + 1;
        } else {
            unclassifiedNonRimOver1++;
            const key = `${region}:unclassified`;
            byTag[key] = (byTag[key] || 0) + 1;
        }
    }

    return {
        over1Total,
        rimOver1,
        explainedNonRimOver1,
        unclassifiedNonRimOver1,
        byTag,
        byRegion,
        byRecord,
    };
}

// ---------------------------------------------------------------------------
// Debug-Pass Shader Helpers (ready for W0 Integrator to wire into
// `GpuWorldRendererWebGPU.js` and `GpuWorldRenderer.js`).
// ---------------------------------------------------------------------------

/**
 * WGSL debug-pass shader for WebGPU `r32uint` record-ID pixel attribution.
 * Uses identical clip-space quad transform, `uvClamp`, and `alpha < 0.01`
 * discard as the scene pass; writes one `u32` attribution word per pixel.
 */
export function buildAttributionWgslSource() {
    return /* wgsl */ `
struct AttrCamera {
  viewOriginAndScale: vec4f, // xy = world camera offset, z = scale, w = 0
  viewportSize: vec4f,       // xy = backing width/height, zw = 1/width, 1/height
};

struct AttrInstance {
  @location(0) rect: vec4f,      // x, y, w, h (world or screen)
  @location(1) uvRect: vec4f,    // u0, v0, du, dv
  @location(2) attrWord: u32,    // base word: recordSlot | (regionClass<<16) | (baseTag<<20) | (layerByte<<24)
  @location(3) flags: u32,       // bit1=reflect, bit3=screenSpace
};

struct AttrVertexOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
  @location(1) @interpolate(flat) attrWord: u32,
};

@group(0) @binding(0) var<uniform> uCamera: AttrCamera;
@group(1) @binding(0) var tAlbedo: texture_2d<f32>;
@group(1) @binding(1) var sNearest: sampler;

const QUAD_CORNERS = array<vec2f, 6>(
  vec2f(0.0, 0.0), vec2f(1.0, 0.0), vec2f(0.0, 1.0),
  vec2f(1.0, 0.0), vec2f(1.0, 1.0), vec2f(0.0, 1.0),
);

@vertex
fn vsAttribution(@builtin(vertex_index) vid: u32, inst: AttrInstance) -> AttrVertexOut {
  let corner = QUAD_CORNERS[vid];
  let mirrored = (inst.flags & 2u) != 0u;
  let screenSpace = (inst.flags & 8u) != 0u;
  let wy0 = select(inst.rect.y, inst.rect.y + inst.rect.w, mirrored);
  let p = vec2f(inst.rect.x + corner.x * inst.rect.z, wy0 + corner.y * inst.rect.w);
  let px = select((p + uCamera.viewOriginAndScale.xy) * uCamera.viewOriginAndScale.z, p, screenSpace);
  let ndc = vec2f(
    (px.x * uCamera.viewportSize.z) * 2.0 - 1.0,
    1.0 - (px.y * uCamera.viewportSize.w) * 2.0,
  );
  let vCoord = select(corner.y, 1.0 - corner.y, mirrored);
  var out: AttrVertexOut;
  out.pos = vec4f(ndc, 0.0, 1.0);
  out.uv = inst.uvRect.xy + vec2f(corner.x, vCoord) * inst.uvRect.zw;
  out.attrWord = inst.attrWord;
  return out;
}

@fragment
fn fsAttribution(in: AttrVertexOut) -> @location(0) vec4<u32> {
  let albedo = textureSampleLevel(tAlbedo, sNearest, clamp(in.uv, vec2f(0.0), vec2f(1.0)), 0.0);
  if (albedo.a < 0.01) {
    discard;
  }
  var word = in.attrWord;
  // Detect bakedRim window (alpha ~0.50, maxRgb < 0.16) -> set bit 22 (SHADER_TAG.bakedRim)
  let maxRgb = max(albedo.r, max(albedo.g, albedo.b));
  if (albedo.a > 0.40 && albedo.a < 0.60 && maxRgb < 0.16) {
    word = word | (4u << 20u);
  }
  return vec4<u32>(word, 0u, 0u, 0u);
}
`.trim();
}

/**
 * GLSL ES 3.00 debug-pass vertex & fragment shaders for WebGL2 RGBA8
 * record-ID pixel attribution (blending MUST be disabled on this pass).
 */
export function buildAttributionGlslSources() {
    const vertex = /* glsl */ `#version 300 es
precision highp float;
precision highp int;

layout(location = 0) in vec2 a_corner;
layout(location = 1) in vec4 a_rect;
layout(location = 2) in vec4 a_uvRect;
layout(location = 3) in uint a_attrWord;
layout(location = 4) in uint a_flags;

uniform vec4 u_viewOriginAndScale;
uniform vec4 u_viewportSize;

out vec2 v_uv;
flat out uint v_attrWord;

void main() {
  bool mirrored = (a_flags & 2u) != 0u;
  bool screenSpace = (a_flags & 8u) != 0u;
  float wy0 = mirrored ? (a_rect.y + a_rect.w) : a_rect.y;
  vec2 p = vec2(a_rect.x + a_corner.x * a_rect.z, wy0 + a_corner.y * a_rect.w);
  vec2 px = screenSpace ? p : (p + u_viewOriginAndScale.xy) * u_viewOriginAndScale.z;
  vec2 ndc = vec2(
    (px.x * u_viewportSize.z) * 2.0 - 1.0,
    1.0 - (px.y * u_viewportSize.w) * 2.0
  );
  float vCoord = mirrored ? (1.0 - a_corner.y) : a_corner.y;
  gl_Position = vec4(ndc, 0.0, 1.0);
  v_uv = a_uvRect.xy + vec2(a_corner.x, vCoord) * a_uvRect.zw;
  v_attrWord = a_attrWord;
}
`.trim();

    const fragment = /* glsl */ `#version 300 es
precision highp float;
precision highp int;

uniform sampler2D u_albedo;

in vec2 v_uv;
flat in uint v_attrWord;

out vec4 o_attrRgba;

void main() {
  vec4 albedo = texture(u_albedo, clamp(v_uv, vec2(0.0), vec2(1.0)));
  if (albedo.a < 0.01) {
    discard;
  }
  uint word = v_attrWord;
  float maxRgb = max(albedo.r, max(albedo.g, albedo.b));
  if (albedo.a > 0.40 && albedo.a < 0.60 && maxRgb < 0.16) {
    word |= (4u << 20u);
  }
  o_attrRgba = vec4(
    float(word & 255u) / 255.0,
    float((word >> 8u) & 255u) / 255.0,
    float((word >> 16u) & 255u) / 255.0,
    float((word >> 24u) & 255u) / 255.0
  );
}
`.trim();

    return { vertex, fragment };
}
