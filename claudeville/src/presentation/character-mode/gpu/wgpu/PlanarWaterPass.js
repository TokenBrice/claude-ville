// Wave 5-A — WebGPU Harbor Planar Water Reflection Pass (Spec 01 §1, §3, §5).
//
// Self-contained modular WebGPU render pass (`{ prepare, encode, release,
// getDiagnostics }`) plus bit-exact integer CPU reference helpers and WGSL
// shader sources (`PLANAR_MIRROR_CAPTURE_WGSL`, `PLANAR_WATER_RESOLVE_WGSL`).
//
// Resource budget (Spec 01 §3 / §5):
//   Mirror color target : 1024 x 512 rgba8unorm   = 2,097,152 B
//   Mirror depth target : 1024 x 512 depth32float = 2,097,152 B
//   Total mirror budget :                           4,194,304 B (4.0 MiB)
//
// Invariants enforced identically on CPU and WGSL:
//   - Mirror clears to transparent black (0, 0, 0, 0) and depth 1.0, keeping
//     valid-empty ("reflected ray hit sky") strictly distinct from out-of-rect
//     fallback ("use authored contact supplier").
//   - Reflected geometry: H' = 2*Z - H, sy' = sy + 2*(H - Z).
//   - Mirror admission requires bit 19 (`reflectMirror` / `mirrorSource`,
//     524288) and strictly rejects recursive `reflect` (2), `screenSpace` (8),
//     `cueRun` (128), `actionMark` (512), additive draws, labels, and HUD.
//   - World-anchored 4x4 Bayer collar: `2 * rank + 1 < 4 * clamp(d, 0, 8)`.
//     At d = 0 no rank passes (outer ring equals fallback bit-for-bit); at
//     d = 8 all 16 ranks pass.
//   - Integer water compositor: `mix256rgb(x, y, w) = ((256 - w) * x + w * y
//     + 128) / 256` across 4 sky courses k = 0..3 with Fresnel weights
//     F = (128 - 16*k) / 256 = [128, 112, 96, 80] / 256, and sky share W from
//     skyFar.w (W = 0 at deep night preserves bed: S' = B).
//   - Strict role 0 receiver guard: emission RGB = 0, role alpha = 0, no bloom,
//     linear luminance <= 0.70, encoded Rec.709 Y <= 0.74, HSV S <= maxSat
//     (and S <= 0.65 at V >= 0.50).
import { TIME_GRADE_WGSL } from '../wgsl/grade.js';
import { GPU_RECORD_FLAGS } from '../GpuWorldPolicy.js';
import {
    createUniformViews,
    FULLSCREEN_WGSL,
    uniformLayout,
    writeUniforms,
} from '../wgsl/common.js';

export const PLANAR_WIDTH = 1024;
export const PLANAR_HEIGHT = 512;
export const PLANAR_COLOR_FORMAT = 'rgba8unorm';
export const PLANAR_DEPTH_FORMAT = 'depth32float';
export const PLANAR_COLOR_BYTES = PLANAR_WIDTH * PLANAR_HEIGHT * 4;
export const PLANAR_DEPTH_BYTES = PLANAR_WIDTH * PLANAR_HEIGHT * 4;
export const PLANAR_MIRROR_BYTES = PLANAR_COLOR_BYTES + PLANAR_DEPTH_BYTES;

export const PLANAR_CLEAR_COLOR = Object.freeze({ r: 0, g: 0, b: 0, a: 0 });
export const PLANAR_CLEAR_DEPTH = 1.0;

export const PLANAR_COLLAR_PX = 8;
export const PLANAR_CONTACT_BAND_PX = 2;
export const PLANAR_MAX_SHIFT_PX = 2;

export const PLANAR_BED_MAX_BYTES = 1024 * 1024;
export const PLANAR_BED_MIN_STRIP_HEIGHT = 64;
export const PLANAR_BED_MAX_STRIP_HEIGHT = 256;

/**
 * Projects a world-space `planarRect = [left, top, width, height]` into
 * GL-row backing-pixel coordinates clipped to `[0, viewportWidth) x [0, viewportHeight)`.
 * When `visible` is false (`w <= 0 || h <= 0`), the basin cannot affect any
 * viewport pixel, so callers can skip both the render-pass split and mirror capture.
 */
export function projectPlanarBasinRect(planarRect, cameraXy, cameraScale, viewportWidth, viewportHeight) {
    if (!planarRect || !(planarRect[2] > 0) || !(planarRect[3] > 0)
        || !(cameraScale > 0) || !(viewportWidth > 0) || !(viewportHeight > 0)) {
        return { x: 0, y: 0, w: 0, h: 0, visible: false };
    }
    const [left, top, width, height] = planarRect;
    const cx = cameraXy?.[0] || 0;
    const cy = cameraXy?.[1] || 0;
    const x = Math.max(0, Math.floor((left + cx) * cameraScale));
    const y = Math.max(0, viewportHeight - Math.ceil((top + height + cy) * cameraScale));
    const w = Math.min(viewportWidth, Math.ceil((left + width + cx) * cameraScale)) - x;
    const h = Math.min(viewportHeight, viewportHeight - Math.floor((top + cy) * cameraScale)) - y;
    return { x, y, w, h, visible: w > 0 && h > 0 };
}

/**
 * Chooses the clean-bed strip scratch height within `[minHeight, maxHeight]`
 * bounded to `maxBytes` (default 1 MiB for RGBA8) and capped by `viewportHeight`.
 * Depends only on `bedWidth` and `viewportHeight`, so panning never reallocates.
 */
export function selectPlanarBedStripHeight(bedWidth, viewportHeight, {
    maxBytes = PLANAR_BED_MAX_BYTES,
    minHeight = PLANAR_BED_MIN_STRIP_HEIGHT,
    maxHeight = PLANAR_BED_MAX_STRIP_HEIGHT,
} = {}) {
    const safeW = Math.max(1, Math.floor(Number(bedWidth) || 1));
    const safeH = Math.max(1, Math.floor(Number(viewportHeight) || 1));
    const rowBytes = safeW * 4;
    const budgetRows = Math.floor(Math.max(rowBytes, Number(maxBytes) || PLANAR_BED_MAX_BYTES) / rowBytes);
    const clamped = Math.max(minHeight, Math.min(maxHeight, budgetRows));
    return Math.min(clamped, safeH);
}

export const PLANAR_DEPTH_MIN = -2048;
export const PLANAR_DEPTH_MAX = 6144;
export const PLANAR_DEPTH_SPAN = PLANAR_DEPTH_MAX - PLANAR_DEPTH_MIN;
export const PLANAR_DEPTH_RECIP = 1 / PLANAR_DEPTH_SPAN;

export const WATER_HORIZON_Y = -144;
export const WATER_COURSE_SPAN = 1408;

export const WATER_RECEIVER_LINEAR_LUMA_MAX = 0.70;
export const WATER_RECEIVER_ENCODED_LUMA_MAX = 0.74;
export const WATER_RECEIVER_TIER_A_SAT_MAX = 0.65;
export const WATER_RECEIVER_TIER_A_VAL_MIN = 0.50;

// Bit 19 (0x80000 = 524288): real reflectable scene object in the admitted
// basin's mirror list. Supports both `reflectMirror` and `mirrorSource` names.
export const MIRROR_SOURCE_FLAG = GPU_RECORD_FLAGS.reflectMirror ?? GPU_RECORD_FLAGS.mirrorSource ?? 524288;
export const MIRROR_FORBIDDEN_FLAGS = (
    GPU_RECORD_FLAGS.reflect
    | GPU_RECORD_FLAGS.screenSpace
    | GPU_RECORD_FLAGS.cueRun
    | GPU_RECORD_FLAGS.actionMark
);

const FORBIDDEN_MIRROR_KINDS = new Set(['label', 'hud', 'reflection', 'cue', 'mark', 'actionMark']);
const FORBIDDEN_MIRROR_ROLES = new Set(['label', 'hud', 'mark', 'emitter-only']);

// Canonical Bayer 4x4 ranks in row-major order (Spec 01 §3).
export const CANONICAL_BAYER4_RANKS = Object.freeze([
    0, 8, 2, 10,
    12, 4, 14, 6,
    3, 11, 1, 9,
    15, 7, 13, 5,
]);

// 4 sky courses k = 0..3: F = (128 - 16 * k) / 256 (far 1/2 -> near 5/16).
export const FRESNEL_COURSE_WEIGHTS = Object.freeze([128, 112, 96, 80]);
// Quantized course blend k / 3 into [0, 256] via round-half-up.
export const SKY_COURSE_WEIGHTS = Object.freeze([0, 85, 171, 256]);
// Seam Y coordinates: -144 + 1408 * (j + 0.5) / 3 for j = 0, 1, 2.
export const SKY_COURSE_BOUNDARIES = Object.freeze([
    WATER_HORIZON_Y + (WATER_COURSE_SPAN * 0.5) / 3,
    WATER_HORIZON_Y + (WATER_COURSE_SPAN * 1.5) / 3,
    WATER_HORIZON_Y + (WATER_COURSE_SPAN * 2.5) / 3,
]);

// Group 1 bindings 0..8 for the water resolve pipeline (Spec 01 §1, §2).
export const PLANAR_WATER_RESOLVE_BINDING = Object.freeze({
    bed: 0,
    contacts: 1,
    occupancy: 2,
    coast: 3,
    cycle: 4,
    gust: 5,
    planarColor: 6,
    rippleState: 7,
    basinMap: 8,
});

// Group 0 bindings for mirror capture pipeline.
export const PLANAR_MIRROR_BINDING = Object.freeze({
    params: 0,
    albedo: 1,
    albedoSampler: 2,
});

// Uniform blocks (generated via common.js uniformLayout so offsets never drift).
export const PLANAR_MIRROR_UNIFORM_LAYOUT = uniformLayout('PlanarMirrorUniforms', [
    ['planarRect', 'vec4f'],      // left, top, validW, validH (art px)
    ['basinParams', 'vec4f'],     // waterZ, contactBandPx, collarPx, maxShiftPx
    ['depthRange', 'vec4f'],      // Dmin=-2048, Dmax=6144, recip=1/8192, reserved
    ['targetSize', 'vec4f'],      // 1024, 512, 1/1024, 1/512
    ['gradeGain', 'vec3f'], ['gradeExposure', 'f32'],
    ['gradePurkinje', 'vec3f'], ['gradeSaturation', 'f32'],
    ['gradeLift', 'vec3f'], ['gradeGamma', 'vec3f'],
    ['gradeHighlight', 'vec3f'], ['gradeShadow', 'vec3f'],
]);

export const PLANAR_WATER_PARAMS_LAYOUT = uniformLayout('PlanarWaterParams', [
    ['cameraXy', 'vec2f'], ['resolution', 'vec2f'],
    ['cameraScale', 'f32'], ['waterZ', 'f32'], ['maxSat', 'f32'], ['reducedMotion', 'u32'],
    ['planarRect', 'vec4f'],      // left, top, validWidth, validHeight (0 disables live mirror)
    ['basinParams', 'vec4f'],     // waterZ, contactBandPx (=2), collarPx (=8), maxShiftPx (=2)
    ['depthRange', 'vec4f'],      // -2048, 6144, 1/8192, 8
    ['frontier', 'vec4u'],        // featureMask, basinHandle, revision, flags
    ['skyFar', 'vec4f'],          // graded horizon linear sRGB, sky share W in [0,1]
    ['skyNear', 'vec4f'],         // graded upper sky linear sRGB, reserved 0
    ['coastOrigin', 'vec4f'],     // coastOriginX, coastOriginY, rippleOriginX, rippleOriginY
    ['bedOrigin', 'vec2i'],
    ['rippleSize', 'vec4f'],      // rippleW, rippleH, rippleScale, contactY
]);

// ------------------------------------------------------------------ sRGB LUTs
// Precomputed 256-entry IEC 61966-2-1 sRGB8 -> linear Q16 [0..65535] table
// using round-half-up, plus exact 255-entry inverse thresholds compiled into
// both CPU and WGSL so cross-backend rounding ties match bit-for-bit.
function srgbByteToLinearFloat(byte) {
    const c = byte / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function linearFloatToSrgbFloat(lin) {
    const l = Math.max(0, Math.min(1, lin));
    return l <= 0.0031308 ? l * 12.92 : 1.055 * (l ** (1 / 2.4)) - 0.055;
}

export const SRGB8_TO_LINEAR16 = Uint16Array.from({ length: 256 }, (_, byte) => (
    Math.floor(srgbByteToLinearFloat(byte) * 65535 + 0.5)
));

// For each boundary b in 0..254, store the smallest linear Q16 value that
// inverse-encodes to at least byte (b + 1) under round-half-up.
export const LINEAR16_TO_SRGB8_THRESHOLDS = Uint16Array.from({ length: 255 }, (_, byte) => {
    const srgbMid = (byte + 0.5) / 255;
    const linMid = srgbMid <= 0.04045 ? srgbMid / 12.92 : ((srgbMid + 0.055) / 1.055) ** 2.4;
    let q = Math.max(0, Math.min(65535, Math.floor(linMid * 65535)));
    while (q < 65535 && Math.floor(linearFloatToSrgbFloat(q / 65535) * 255 + 0.5) <= byte) q++;
    while (q > 0 && Math.floor(linearFloatToSrgbFloat((q - 1) / 65535) * 255 + 0.5) > byte) q--;
    return q;
});

export function srgb8ToLinear16(byte) {
    const b = Math.max(0, Math.min(255, Math.trunc(Number(byte) || 0)));
    return SRGB8_TO_LINEAR16[b];
}

export function linear16ToSrgb8(q16) {
    const q = Math.max(0, Math.min(65535, Math.trunc(Number(q16) || 0)));
    let lo = 0;
    let hi = 255;
    while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (q >= LINEAR16_TO_SRGB8_THRESHOLDS[mid]) lo = mid + 1;
        else hi = mid;
    }
    return lo;
}

export function linear01ToLinear16(value) {
    const clamped = Math.max(0, Math.min(1, Number(value) || 0));
    return Math.floor(clamped * 65535 + 0.5);
}

export function srgbRgbToLinear16(rgb) {
    return [srgb8ToLinear16(rgb[0]), srgb8ToLinear16(rgb[1]), srgb8ToLinear16(rgb[2])];
}

export function linear16RgbToSrgb8(rgb16) {
    return [linear16ToSrgb8(rgb16[0]), linear16ToSrgb8(rgb16[1]), linear16ToSrgb8(rgb16[2])];
}

// ------------------------------------------------------ Reflected geometry math

/** Reflected height about water plane Z: H' = 2*Z - H. */
export function reflectWorldHeight(height, waterZ = 0) {
    return 2 * waterZ - height;
}

/** Reflected projected art Y about water plane Z: sy' = sy + 2*(H - Z). */
export function reflectWorldY(sy, height, waterZ = 0) {
    return sy + 2 * (height - waterZ);
}

/**
 * Geometric depth for depth32float (clear=1.0, compare=less):
 * d = (6144 - D) / 8192, clamped to strict interior (0, 1).
 */
export function geometricDepth(depthOrder) {
    const d = (PLANAR_DEPTH_MAX - depthOrder) * PLANAR_DEPTH_RECIP;
    if (!Number.isFinite(d)) return 1.0;
    return Math.max(1e-6, Math.min(1 - 1e-6, d));
}

// ------------------------------------------------------ Mirror admission filter

/**
 * Admits ONLY real scene objects carrying bit 19 (`reflectMirror` /
 * `mirrorSource` = 524288) and strictly rejects recursive `reflect = 2`,
 * screen-space marks, labels, HUD, cue runs, and additive glows.
 */
export function isMirrorAdmittedRecord(record, { basinId = null } = {}) {
    if (!record || typeof record !== 'object') return false;
    const flags = (Number(record.flags) || 0) >>> 0;
    if ((flags & MIRROR_FORBIDDEN_FLAGS) !== 0) return false;
    if (
        record.reflect === true
        || record.reflect === 2
        || record.screenSpace === true
        || record.cueRun === true
        || record.actionMark === true
        || record.isLabel === true
        || record.isHud === true
        || record.blend === 'add'
    ) {
        return false;
    }
    if (record.kind && FORBIDDEN_MIRROR_KINDS.has(String(record.kind))) return false;
    if (record.role && FORBIDDEN_MIRROR_ROLES.has(String(record.role))) return false;
    const hasMirrorBit = (flags & MIRROR_SOURCE_FLAG) !== 0
        || record.reflectMirror === true
        || record.mirrorSource === true;
    if (!hasMirrorBit) return false;
    if (basinId != null && record.basinId != null && record.basinId !== basinId) return false;
    return true;
}

export function filterMirrorRecords(records, options = {}) {
    if (!Array.isArray(records) || records.length === 0) return [];
    const admitted = [];
    for (let index = 0; index < records.length; index++) {
        const record = records[index];
        if (isMirrorAdmittedRecord(record, options)) admitted.push(record);
    }
    return admitted;
}

// ------------------------------------------------- Integer water oracle (CPU)

export function bayer4Rank(x, y) {
    const ix = Math.floor(x) & 3;
    const iy = Math.floor(y) & 3;
    return CANONICAL_BAYER4_RANKS[(iy << 2) | ix];
}

/**
 * Distance in texels inward from the valid mirror rect perimeter.
 * Returns -1 when outside or when the rect is disabled (width/height <= 0).
 */
export function collarDistance(x, y, rect) {
    if (!rect || !(rect.width > 0) || !(rect.height > 0)) return -1;
    const ix = Math.floor(x) - Math.floor(rect.left);
    const iy = Math.floor(y) - Math.floor(rect.top);
    const w = Math.floor(rect.width);
    const h = Math.floor(rect.height);
    if (ix < 0 || iy < 0 || ix >= w || iy >= h) return -1;
    return Math.min(ix, iy, w - 1 - ix, h - 1 - iy);
}

/**
 * Exact integer Bayer 4x4 collar test (Spec 01 §3 & §5):
 * `2 * rank + 1 < 4 * clamp(d, 0, 8)`.
 * At d = 0, no rank passes (edge ring equals fallback bit-for-bit).
 * At d = 8, all 16 ranks pass.
 */
export function bayerCollarSelect(d, x, y) {
    if (!Number.isFinite(d) || d < 0) return false;
    const dc = Math.max(0, Math.min(PLANAR_COLLAR_PX, Math.floor(d)));
    const rank = bayer4Rank(x, y);
    return (2 * rank + 1) < (4 * dc);
}

/** Exact integer 8-bit weight blend (Spec 01 §3). */
export function mix256(x, y, w) {
    return Math.floor(((256 - w) * x + w * y + 128) / 256);
}

/** Exact integer 3-channel mix256 (CPU twin of WGSL `mix256rgb`). */
export function mix256rgb(x, y, w) {
    return [
        mix256(x[0], y[0], w),
        mix256(x[1], y[1], w),
        mix256(x[2], y[2], w),
    ];
}

/** Convert straight RGBA8 alpha byte [0..255] to integer weight [0..256]. */
export function alphaByteToWeight(alphaByte) {
    const a = Math.max(0, Math.min(255, Math.trunc(Number(alphaByte) || 0)));
    return Math.floor((256 * a + 127) / 255);
}

/**
 * Scalar integer water channel compositor (Spec 01 §3 & §5 oracle verbatim).
 * `contact` and `live` are `[linear16Channel, alphaByte]` pairs.
 */
export function waterChannel(bed, sky, skyWeight, contact, live, useLive, fresnel) {
    const [object, alphaByte] = useLive ? live : contact;
    const alpha = Math.floor((256 * alphaByte + 127) / 255);
    const skyRay = mix256(bed, sky, skyWeight);
    return mix256(bed, mix256(skyRay, object, alpha), fresnel);
}

/**
 * 3-channel linear Q16 water compositor matching `waterChannel` per channel.
 */
export function waterPixelLinear16({ bed, sky, skyWeight, contact, live, useLive, fresnel }) {
    const source = useLive ? live : contact;
    const alpha = alphaByteToWeight(source.alphaByte);
    const skyRay = mix256rgb(bed, sky, skyWeight);
    const env = mix256rgb(skyRay, source.rgb16, alpha);
    return mix256rgb(bed, env, fresnel);
}

/**
 * Quantized 4-course sky index k in 0..3 from world art coordinates (x, y)
 * per Spec 01 §3 step 3, with 2-row Bayer dither transitions at the 3 seams.
 */
export function skyCourseAt(x, y) {
    const py = Math.floor(y);
    const t = Math.max(0, Math.min(1, (py + 0.5 - WATER_HORIZON_Y) / WATER_COURSE_SPAN));
    for (let j = 0; j < 3; j++) {
        const boundary = SKY_COURSE_BOUNDARIES[j];
        const delta = py - boundary;
        if (delta >= -1 && delta <= 1) {
            const coverage = Math.max(0, Math.min(1, (delta + 1) / 2));
            const threshold = (bayer4Rank(x, y) + 0.5) / 16;
            return threshold < coverage ? j + 1 : j;
        }
    }
    return Math.max(0, Math.min(3, Math.floor(3 * t + 0.5)));
}

/** Fresnel weight in [0..256] for sky course k = 0..3: 128, 112, 96, 80. */
export function fresnelWeightForCourse(course) {
    const k = Math.max(0, Math.min(3, Math.trunc(Number(course) || 0)));
    return FRESNEL_COURSE_WEIGHTS[k];
}

/** Quantized sky color linear Q16 for course k = 0..3: mix(horizon, top, k/3). */
export function skyCourseColorLinear16(horizon16, top16, course) {
    const k = Math.max(0, Math.min(3, Math.trunc(Number(course) || 0)));
    return mix256rgb(horizon16, top16, SKY_COURSE_WEIGHTS[k]);
}

/** Round signed value to nearest integer, ties away from zero (Spec 01 §3.2). */
export function roundHalfAwayFromZero(value) {
    if (!Number.isFinite(value) || value === 0) return 0;
    return value > 0 ? Math.floor(value + 0.5) : -Math.floor(-value + 0.5);
}

/**
 * Integer horizontal ripple offset q (Spec 01 §3 step 2):
 * - 0 under reducedMotion or on first contact row (contactRow <= 0)
 * - clamped to [-1, 1] through next two rows (contactRow 1..2)
 * - clamped to [-maxShift, maxShift] (default [-2, 2]) further out
 * - rejects displacement outside valid rect, into another basin, or into an
 *   occluder, retrying x unshifted (returns 0).
 */
export function computeRippleShift({
    slopeX = 0,
    contactRow = 999,
    maxShift = PLANAR_MAX_SHIFT_PX,
    reducedMotion = false,
    x = 0,
    y = 0,
    rect = null,
    basinId = null,
    basinAt = null,
    occluderAt = null,
} = {}) {
    if (reducedMotion || !Number.isFinite(slopeX) || contactRow <= 0) return 0;
    const cap = contactRow <= PLANAR_CONTACT_BAND_PX
        ? Math.min(1, Math.max(0, Math.floor(maxShift)))
        : Math.max(0, Math.floor(maxShift));
    if (cap === 0) return 0;
    let q = roundHalfAwayFromZero(slopeX);
    q = Math.max(-cap, Math.min(cap, q));
    if (q === 0) return 0;
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    const sx = ix + q;
    if (rect) {
        const left = Math.floor(rect.left);
        const right = left + Math.floor(rect.width);
        if (sx < left || sx >= right) return 0;
    }
    if (typeof basinAt === 'function' && basinId != null) {
        if (basinAt(sx, iy) !== basinId) return 0;
    }
    if (typeof occluderAt === 'function' && occluderAt(sx, iy)) return 0;
    return q;
}

// ------------------------------------------------- Strict role 0 receiver guard

function linearLumaFromBytes(r, g, b) {
    return (
        0.2126 * (SRGB8_TO_LINEAR16[r] / 65535)
        + 0.7152 * (SRGB8_TO_LINEAR16[g] / 65535)
        + 0.0722 * (SRGB8_TO_LINEAR16[b] / 65535)
    );
}

function encodedLumaFromBytes(r, g, b) {
    return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

function hsvSatValFromBytes(r, g, b) {
    const hi = Math.max(r, g, b);
    const lo = Math.min(r, g, b);
    return { s: hi === 0 ? 0 : (hi - lo) / hi, v: hi / 255 };
}

/**
 * Explicit final byte receiver guard (Spec 01 §3 "Receiver landing"):
 * Guarantees role 0 (emission RGB = 0, role alpha = 0, no bloom),
 * encoded Rec.709 Y <= 0.74, linear luminance <= 0.70, HSV S <= maxSat,
 * and HSV S <= 0.65 whenever V >= 0.50.
 */
export function applyWaterReceiverGuardByte(rgb8, maxSat = 0.44) {
    const satCap = Math.max(0, Math.min(1, Number.isFinite(maxSat) ? maxSat : 0.44));
    let r = Math.max(0, Math.min(255, Math.round(Number(rgb8[0]) || 0)));
    let g = Math.max(0, Math.min(255, Math.round(Number(rgb8[1]) || 0)));
    let b = Math.max(0, Math.min(255, Math.round(Number(rgb8[2]) || 0)));

    // Step 1: raise channels below ceil(m * (1 - Smax))
    const m0 = Math.max(r, g, b);
    const effectiveSat0 = (m0 / 255) >= WATER_RECEIVER_TIER_A_VAL_MIN
        ? Math.min(satCap, WATER_RECEIVER_TIER_A_SAT_MAX)
        : satCap;
    const minCh = Math.ceil(m0 * (1 - effectiveSat0));
    if (r < minCh) r = minCh;
    if (g < minCh) g = minCh;
    if (b < minCh) b = minCh;

    // Step 2: scale by min(1, 0.74 / max(Yencoded, eps)) and floor to bytes
    const y0 = encodedLumaFromBytes(r, g, b);
    if (y0 > WATER_RECEIVER_ENCODED_LUMA_MAX) {
        const scale = WATER_RECEIVER_ENCODED_LUMA_MAX / Math.max(y0, 1e-6);
        r = Math.floor(r * scale);
        g = Math.floor(g * scale);
        b = Math.floor(b * scale);
    }

    // Step 3: recompute all predicates after rounding and step down until valid
    for (let iter = 0; iter < 768; iter++) {
        const yEnc = encodedLumaFromBytes(r, g, b);
        const yLin = linearLumaFromBytes(r, g, b);
        const { s, v } = hsvSatValFromBytes(r, g, b);
        const satLimit = v >= WATER_RECEIVER_TIER_A_VAL_MIN
            ? Math.min(satCap, WATER_RECEIVER_TIER_A_SAT_MAX)
            : satCap;
        const satFail = s > satLimit + 1e-9;
        const encFail = yEnc > WATER_RECEIVER_ENCODED_LUMA_MAX + 1e-9;
        const linFail = yLin > WATER_RECEIVER_LINEAR_LUMA_MAX + 1e-9;
        if (!satFail && !encFail && !linFail) break;

        if (linFail && !satFail) {
            // Step all positive channels down proportionally (at least 1 step).
            const ratio = Math.sqrt(WATER_RECEIVER_LINEAR_LUMA_MAX / Math.max(yLin, 1e-6));
            let nr = r > 0 ? Math.min(r - 1, Math.floor(r * ratio)) : 0;
            let ng = g > 0 ? Math.min(g - 1, Math.floor(g * ratio)) : 0;
            let nb = b > 0 ? Math.min(b - 1, Math.floor(b * ratio)) : 0;
            if (nr === r && ng === g && nb === b) {
                if (r >= g && r >= b && r > 0) nr--;
                else if (g >= r && g >= b && g > 0) ng--;
                else if (b > 0) nb--;
            }
            r = Math.max(0, nr);
            g = Math.max(0, ng);
            b = Math.max(0, nb);
        } else {
            // Decrease maximum offending channel by 1.
            if (r >= g && r >= b && r > 0) r--;
            else if (g >= r && g >= b && g > 0) g--;
            else if (b > 0) b--;
            else break;
        }
    }

    const encodedLuma = encodedLumaFromBytes(r, g, b);
    const linearLuma = linearLumaFromBytes(r, g, b);
    const { s: hsvS, v: hsvV } = hsvSatValFromBytes(r, g, b);
    return {
        rgb: [r, g, b],
        emission: [0, 0, 0],
        roleAlpha: 0,
        linearLuma,
        encodedLuma,
        hsvS,
        hsvV,
    };
}

/**
 * Full CPU reference resolve for one exposed water texel `(x, y)`.
 * Mirrors `PLANAR_WATER_RESOLVE_WGSL` bit-for-bit on integer inputs.
 */
export function resolvePlanarWaterTexel({
    x,
    y,
    exposed = true,
    bedRgb8,
    skyFarRgb8,
    skyNearRgb8 = skyFarRgb8,
    skyShare = 1,
    contactRgb8 = [0, 0, 0],
    contactAlpha = 0,
    liveSampleAt = null,
    planarRect = null,
    mirrorAvailable = true,
    basinMatch = true,
    basinId = 1,
    basinAt = null,
    occluderAt = null,
    slopeX = 0,
    contactRow = 999,
    maxShift = PLANAR_MAX_SHIFT_PX,
    reducedMotion = false,
    maxSat = 0.44,
    courseOverride = null,
    applyGuard = true,
}) {
    const bed16 = srgbRgbToLinear16(bedRgb8);
    if (!exposed || !basinMatch || collarDistance(x, y, planarRect) < 0) {
        return {
            rgb8: [bedRgb8[0], bedRgb8[1], bedRgb8[2]],
            linear16: bed16,
            emission: [0, 0, 0],
            roleAlpha: 0,
            useLive: false,
            shift: 0,
            collarDist: -1,
            course: 0,
            fresnel: 0,
        };
    }

    const d = (mirrorAvailable && basinMatch) ? collarDistance(x, y, planarRect) : -1;
    const useLive = d >= 0 && bayerCollarSelect(d, x, y);
    const shift = useLive
        ? computeRippleShift({
            slopeX,
            contactRow,
            maxShift,
            reducedMotion,
            x,
            y,
            rect: planarRect,
            basinId,
            basinAt,
            occluderAt,
        })
        : 0;

    let liveRgb8 = [0, 0, 0];
    let liveAlpha = 0;
    if (useLive && typeof liveSampleAt === 'function') {
        const sampled = liveSampleAt(Math.floor(x) + shift, Math.floor(y));
        if (sampled) {
            liveRgb8 = sampled.rgb8 || [sampled[0] || 0, sampled[1] || 0, sampled[2] || 0];
            liveAlpha = sampled.alphaByte ?? sampled[3] ?? 0;
        }
    }

    const course = courseOverride != null ? Math.max(0, Math.min(3, courseOverride)) : skyCourseAt(x, y);
    const fresnel = fresnelWeightForCourse(course);
    const horizon16 = srgbRgbToLinear16(skyFarRgb8);
    const top16 = srgbRgbToLinear16(skyNearRgb8);
    const sky16 = skyCourseColorLinear16(horizon16, top16, course);
    const skyWeight = Math.max(0, Math.min(256, Math.floor(Math.max(0, Math.min(1, Number(skyShare) || 0)) * 256 + 0.5)));

    const linear16 = waterPixelLinear16({
        bed: bed16,
        sky: sky16,
        skyWeight,
        contact: { rgb16: srgbRgbToLinear16(contactRgb8), alphaByte: contactAlpha },
        live: { rgb16: srgbRgbToLinear16(liveRgb8), alphaByte: liveAlpha },
        useLive,
        fresnel,
    });

    const rawSrgb8 = linear16RgbToSrgb8(linear16);
    if (!applyGuard) {
        return {
            rgb8: rawSrgb8,
            linear16,
            emission: [0, 0, 0],
            roleAlpha: 0,
            useLive,
            shift,
            collarDist: d,
            course,
            fresnel,
        };
    }

    const guarded = applyWaterReceiverGuardByte(rawSrgb8, maxSat);
    return {
        rgb8: guarded.rgb,
        rawRgb8: rawSrgb8,
        linear16,
        emission: guarded.emission,
        roleAlpha: guarded.roleAlpha,
        linearLuma: guarded.linearLuma,
        encodedLuma: guarded.encodedLuma,
        hsvS: guarded.hsvS,
        hsvV: guarded.hsvV,
        useLive,
        shift,
        collarDist: d,
        course,
        fresnel,
    };
}

// ---------------------------------------------------------------- WGSL sources

function formatU32Array(name, values) {
    const body = Array.from(values, v => `${v}u`).join(', ');
    return `const ${name} = array<u32, ${values.length}>(${body});`;
}

export const PLANAR_MIRROR_CAPTURE_WGSL = /* wgsl */ `
${PLANAR_MIRROR_UNIFORM_LAYOUT.wgsl}
@group(0) @binding(${PLANAR_MIRROR_BINDING.params}) var<uniform> mirror: PlanarMirrorUniforms;
@group(0) @binding(${PLANAR_MIRROR_BINDING.albedo}) var mirrorAlbedo: texture_2d<f32>;
@group(0) @binding(${PLANAR_MIRROR_BINDING.albedoSampler}) var mirrorSampler: sampler;

${TIME_GRADE_WGSL.replaceAll('frame.', 'mirror.')}

struct MirrorInstanceIn {
  @location(0) rect: vec4f,       // x, y, w, h in world art px
  @location(1) uvRect: vec4f,     // u0, v0, u1, v1
  @location(2) geom: vec4f,       // baseH, topH, depthOrder, flags
}

struct MirrorVsOut {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
  @location(1) worldHeight: f32,
  @location(2) @interpolate(flat) waterZ: f32,
}

@vertex fn planarMirrorVs(@builtin(vertex_index) vi: u32, inst: MirrorInstanceIn) -> MirrorVsOut {
  let right = (vi & 1u) == 1u;
  let bottom = vi >= 2u;
  let sx = select(inst.rect.x, inst.rect.x + inst.rect.z, right);
  let sy = select(inst.rect.y, inst.rect.y + inst.rect.w, bottom);
  let h = select(inst.geom.y, inst.geom.x, bottom);
  let z = mirror.basinParams.x;
  // Exact planar reflection about water plane Z: H' = 2*Z - H, sy' = sy + 2*(H - Z).
  let syReflected = sy + 2.0 * (h - z);
  let local = vec2f(sx, syReflected) - mirror.planarRect.xy;
  let ndc = vec2f(
    (local.x / max(1.0, mirror.targetSize.x)) * 2.0 - 1.0,
    1.0 - (local.y / max(1.0, mirror.targetSize.y)) * 2.0
  );
  // Reflection keeps ground Y fixed and replaces H by 2Z-H in D=Y+H/2.
  let reflectedOrder = inst.geom.z + z - 0.5 * h;
  let depth = clamp((mirror.depthRange.y - reflectedOrder) * mirror.depthRange.z, 0.00001, 0.99999);
  var out: MirrorVsOut;
  out.position = vec4f(ndc, depth, 1.0);
  out.uv = vec2f(select(inst.uvRect.x, inst.uvRect.z, right), select(inst.uvRect.y, inst.uvRect.w, bottom));
  out.worldHeight = h;
  out.waterZ = z;
  return out;
}

@fragment fn planarMirrorFs(in: MirrorVsOut) -> @location(0) vec4f {
  // Clip geometry below the reflecting water plane Z.
  if (in.worldHeight < in.waterZ) { discard; }
  let texel = textureSampleLevel(mirrorAlbedo, mirrorSampler, in.uv, 0.0);
  // Alpha cutout discard before writing depth; role-neutral straight sRGB8 + alpha.
  if (texel.a < 0.5) { discard; }
  return vec4f(applyTimeGrade(texel.rgb, true), texel.a);
}
`;

export const PLANAR_WATER_RESOLVE_WGSL = /* wgsl */ `
${FULLSCREEN_WGSL}
${PLANAR_WATER_PARAMS_LAYOUT.wgsl}

@group(0) @binding(0) var<uniform> params: PlanarWaterParams;

// Group 1 bindings 0..8 matching Spec 01 §1 & §2 water resolve contract.
@group(1) @binding(${PLANAR_WATER_RESOLVE_BINDING.bed}) var bedTex: texture_2d<f32>;
@group(1) @binding(${PLANAR_WATER_RESOLVE_BINDING.contacts}) var contactTex: texture_2d<f32>;
@group(1) @binding(${PLANAR_WATER_RESOLVE_BINDING.occupancy}) var occupancyTex: texture_2d<f32>;
@group(1) @binding(${PLANAR_WATER_RESOLVE_BINDING.coast}) var coastTex: texture_2d<f32>;
@group(1) @binding(${PLANAR_WATER_RESOLVE_BINDING.cycle}) var cycleTex: texture_2d<f32>;
@group(1) @binding(${PLANAR_WATER_RESOLVE_BINDING.gust}) var gustTex: texture_2d<f32>;
@group(1) @binding(${PLANAR_WATER_RESOLVE_BINDING.planarColor}) var planarColorTex: texture_2d<f32>;
@group(1) @binding(${PLANAR_WATER_RESOLVE_BINDING.rippleState}) var rippleStateTex: texture_2d<f32>;
@group(1) @binding(${PLANAR_WATER_RESOLVE_BINDING.basinMap}) var basinMapTex: texture_2d<u32>;

${formatU32Array('BAYER4_RANKS', CANONICAL_BAYER4_RANKS)}
${formatU32Array('FRESNEL_WEIGHTS', FRESNEL_COURSE_WEIGHTS)}
${formatU32Array('SKY_COURSE_MIX', SKY_COURSE_WEIGHTS)}
${formatU32Array('SRGB8_TO_LIN16', SRGB8_TO_LINEAR16)}
${formatU32Array('LIN16_TO_SRGB8_THRESH', LINEAR16_TO_SRGB8_THRESHOLDS)}

const WATER_HORIZON_Y: f32 = ${WATER_HORIZON_Y}.0;
const WATER_COURSE_SPAN: f32 = ${WATER_COURSE_SPAN}.0;
const RECEIVER_LINEAR_LUMA_MAX: f32 = ${WATER_RECEIVER_LINEAR_LUMA_MAX.toFixed(2)};
const RECEIVER_ENCODED_LUMA_MAX: f32 = ${WATER_RECEIVER_ENCODED_LUMA_MAX.toFixed(2)};
const RECEIVER_TIER_A_SAT_MAX: f32 = ${WATER_RECEIVER_TIER_A_SAT_MAX.toFixed(2)};
const RECEIVER_TIER_A_VAL_MIN: f32 = ${WATER_RECEIVER_TIER_A_VAL_MIN.toFixed(2)};

fn mix256rgb(x: vec3u, y: vec3u, w: u32) -> vec3u {
  return ((256u - w) * x + w * y + vec3u(128u)) / vec3u(256u);
}

fn alphaByteToWeight(a: u32) -> u32 {
  return (256u * min(a, 255u) + 127u) / 255u;
}

fn bayer4RankAt(p: vec2i) -> u32 {
  let ix = u32(p.x & 3);
  let iy = u32(p.y & 3);
  return BAYER4_RANKS[(iy << 2u) | ix];
}

// Exact Bayer collar predicate: 2 * rank + 1 < 4 * clamp(d, 0, 8).
fn bayerCollarSelect(d: i32, p: vec2i) -> bool {
  if (d < 0) { return false; }
  let dc = u32(clamp(d, 0, 8));
  return (2u * bayer4RankAt(p) + 1u) < (4u * dc);
}

fn srgbByteToLin16(b: u32) -> u32 {
  return SRGB8_TO_LIN16[min(b, 255u)];
}

fn srgbBytesToLin16(rgb: vec3u) -> vec3u {
  return vec3u(srgbByteToLin16(rgb.r), srgbByteToLin16(rgb.g), srgbByteToLin16(rgb.b));
}

fn lin16ToSrgbByte(q0: u32) -> u32 {
  let q = min(q0, 65535u);
  var lo = 0u;
  var hi = 255u;
  for (var step = 0u; step < 8u; step++) {
    let mid = (lo + hi) >> 1u;
    if (q >= LIN16_TO_SRGB8_THRESH[mid]) {
      lo = mid + 1u;
    } else {
      hi = mid;
    }
  }
  return lo;
}

fn lin16ToSrgbBytes(rgb16: vec3u) -> vec3u {
  return vec3u(lin16ToSrgbByte(rgb16.r), lin16ToSrgbByte(rgb16.g), lin16ToSrgbByte(rgb16.b));
}

fn skyCourseForPixel(p: vec2i) -> u32 {
  let py = f32(p.y);
  let t = clamp((py + 0.5 - WATER_HORIZON_Y) / WATER_COURSE_SPAN, 0.0, 1.0);
  for (var j = 0u; j < 3u; j++) {
    let boundary = WATER_HORIZON_Y + WATER_COURSE_SPAN * (f32(j) + 0.5) / 3.0;
    let delta = py - boundary;
    if (delta >= -1.0 && delta <= 1.0) {
      let coverage = clamp((delta + 1.0) * 0.5, 0.0, 1.0);
      let threshold = (f32(bayer4RankAt(p)) + 0.5) / 16.0;
      return select(j, j + 1u, threshold < coverage);
    }
  }
  return min(3u, u32(floor(3.0 * t + 0.5)));
}

fn roundAwayFromZero(v: f32) -> i32 {
  if (v >= 0.0) { return i32(floor(v + 0.5)); }
  return -i32(floor(-v + 0.5));
}

fn isWaterExposed(p: vec2i) -> bool {
  let local = p - vec2i(floor(params.coastOrigin.xy));
  let cell = local >> vec2u(1u);
  let dims = vec2i(textureDimensions(occupancyTex));
  if (cell.x < 0 || cell.y < 0 || cell.x >= dims.x || cell.y >= dims.y) { return false; }
  let maskByte = u32(floor(textureLoad(occupancyTex, cell, 0).r * 255.0 + 0.5));
  let bit = u32((local.x & 1) + 2 * (local.y & 1));
  return ((maskByte & 15u) & (1u << bit)) != 0u;
}

fn basinAtPixel(p: vec2i) -> u32 {
  let local = p - vec2i(floor(params.coastOrigin.xy));
  let cell = local >> vec2u(1u);
  let dims = vec2i(textureDimensions(basinMapTex));
  if (cell.x < 0 || cell.y < 0 || cell.x >= dims.x || cell.y >= dims.y) { return 0u; }
  return textureLoad(basinMapTex, cell, 0).r;
}

fn rippleShiftAt(p: vec2i, rectMin: vec2i, rectSize: vec2i, basinId: u32) -> i32 {
  if (params.reducedMotion != 0u || (params.frontier.x & 2u) == 0u) { return 0; }
  let contactCoord = p - rectMin;
  let contactRow = i32(round(textureLoad(coastTex, contactCoord, 0).r * 255.0)) - 1;
  if (contactRow <= 0) { return 0; }
  let maxShift = i32(floor(params.basinParams.w + 0.5));
  let cap = select(maxShift, min(1, maxShift), contactRow <= i32(floor(params.basinParams.y + 0.5)));
  if (cap <= 0) { return 0; }
  let rDims = vec2i(textureDimensions(rippleStateTex));
  let rCoord = vec2i(floor((vec2f(p) - params.coastOrigin.zw) * params.rippleSize.z));
  if (rCoord.x < 0 || rCoord.y < 0 || rCoord.x >= rDims.x || rCoord.y >= rDims.y) { return 0; }
  let slopeX = textureLoad(rippleStateTex, rCoord, 0).b;
  let q = clamp(roundAwayFromZero(slopeX), -cap, cap);
  if (q == 0) { return 0; }
  let shifted = vec2i(p.x + q, p.y);
  let local = shifted - rectMin;
  if (local.x < 0 || local.x >= rectSize.x) { return 0; }
  if (basinId != 0u && basinAtPixel(shifted) != basinId) { return 0; }
  if (!isWaterExposed(shifted)) { return 0; }
  return q;
}

fn encodedLumaByte(c: vec3u) -> f32 {
  return (0.2126 * f32(c.r) + 0.7152 * f32(c.g) + 0.0722 * f32(c.b)) / 255.0;
}

fn linearLumaByte(c: vec3u) -> f32 {
  return (
    0.2126 * f32(srgbByteToLin16(c.r))
    + 0.7152 * f32(srgbByteToLin16(c.g))
    + 0.0722 * f32(srgbByteToLin16(c.b))
  ) / 65535.0;
}

fn waterReceiverGuard(rgbIn: vec3u, maxSat: f32) -> vec3u {
  var c = min(rgbIn, vec3u(255u));
  let m0 = max(c.r, max(c.g, c.b));
  let sat0 = select(maxSat, min(maxSat, RECEIVER_TIER_A_SAT_MAX), f32(m0) / 255.0 >= RECEIVER_TIER_A_VAL_MIN);
  let minCh = u32(ceil(f32(m0) * (1.0 - sat0)));
  c = max(c, vec3u(minCh));
  let y0 = encodedLumaByte(c);
  if (y0 > RECEIVER_ENCODED_LUMA_MAX) {
    let scale = RECEIVER_ENCODED_LUMA_MAX / max(y0, 0.000001);
    c = vec3u(floor(vec3f(c) * scale));
  }
  for (var iter = 0u; iter < 96u; iter++) {
    let yEnc = encodedLumaByte(c);
    let yLin = linearLumaByte(c);
    let hi = max(c.r, max(c.g, c.b));
    let lo = min(c.r, min(c.g, c.b));
    let v = f32(hi) / 255.0;
    let s = select(0.0, f32(hi - lo) / f32(hi), hi > 0u);
    let satLimit = select(maxSat, min(maxSat, RECEIVER_TIER_A_SAT_MAX), v >= RECEIVER_TIER_A_VAL_MIN);
    let satFail = s > satLimit + 0.00001;
    let encFail = yEnc > RECEIVER_ENCODED_LUMA_MAX + 0.00001;
    let linFail = yLin > RECEIVER_LINEAR_LUMA_MAX + 0.00001;
    if (!satFail && !encFail && !linFail) { break; }
    if (linFail && !satFail) {
      let ratio = sqrt(RECEIVER_LINEAR_LUMA_MAX / max(yLin, 0.000001));
      let scaled = vec3u(floor(vec3f(c) * ratio));
      c = vec3u(
        select(0u, min(c.r - 1u, scaled.r), c.r > 0u),
        select(0u, min(c.g - 1u, scaled.g), c.g > 0u),
        select(0u, min(c.b - 1u, scaled.b), c.b > 0u)
      );
    } else {
      if (c.r >= c.g && c.r >= c.b && c.r > 0u) { c.r -= 1u; }
      else if (c.g >= c.r && c.g >= c.b && c.g > 0u) { c.g -= 1u; }
      else if (c.b > 0u) { c.b -= 1u; }
      else { break; }
    }
  }
  return c;
}

fn resolveWaterAt(fragPos: vec2f) -> vec4f {
  let screen = vec2f(fragPos.x, params.resolution.y - fragPos.y);
  let world = screen / max(params.cameraScale, 0.0001) - params.cameraXy;
  let p = vec2i(floor(world));
  let bedDims = vec2i(textureDimensions(bedTex));
  let absolute = vec2i(fragPos) - params.bedOrigin;
  let bedCoord = vec2i(absolute.x, absolute.y % bedDims.y);
  let bedSample = textureLoad(bedTex, bedCoord, 0);
  if (!isWaterExposed(p)) { discard; }

  var refracted = bedSample;

  let rectMin = vec2i(floor(params.planarRect.xy));
  let rectSize = vec2i(floor(params.planarRect.zw));
  let local = p - rectMin;
  let mirrorEnabled = (params.frontier.x & 1u) != 0u && rectSize.x > 0 && rectSize.y > 0;
  let basinId = params.frontier.y;
  let basinOk = basinId == 0u || basinAtPixel(p) == basinId;
  var collarDist = -1;
  if (mirrorEnabled && basinOk && local.x >= 0 && local.y >= 0 && local.x < rectSize.x && local.y < rectSize.y) {
    collarDist = min(min(local.x, local.y), min(rectSize.x - 1 - local.x, rectSize.y - 1 - local.y));
  }
  if (collarDist < 0 || bedSample.a == 0.0 || textureLoad(coastTex, local, 0).r == 0.0) { discard; }
  let useLive = bayerCollarSelect(collarDist, p);

  var objBytes = vec3u(0u);
  var objAlpha = 0u;
  if (useLive) {
    let shift = rippleShiftAt(p, rectMin, rectSize, basinId);
    if (shift != 0) {
      let delta = roundAwayFromZero(f32(shift) * params.cameraScale);
      let copiedMaxX = min(bedDims.x, i32(params.resolution.x) - params.bedOrigin.x) - 1;
      let q = vec2i(clamp(bedCoord.x + delta, 0, copiedMaxX), bedCoord.y);
      refracted = textureLoad(bedTex, q, 0);
    }
    let mDims = vec2i(textureDimensions(planarColorTex));
    let mCoord = clamp(vec2i(local.x + shift, local.y), vec2i(0), mDims - vec2i(1));
    let live = textureLoad(planarColorTex, mCoord, 0);
    objBytes = vec3u(floor(clamp(live.rgb, vec3f(0.0), vec3f(1.0)) * 255.0 + 0.5));
    objAlpha = u32(floor(clamp(live.a, 0.0, 1.0) * 255.0 + 0.5));
  } else {
    let cDims = vec2i(textureDimensions(contactTex));
    let cLocal = p - vec2i(floor(params.coastOrigin.xy));
    if (cLocal.x >= 0 && cLocal.y >= 0 && cLocal.x < cDims.x && cLocal.y < cDims.y) {
      let contact = textureLoad(contactTex, cLocal, 0);
      objBytes = vec3u(floor(clamp(contact.rgb, vec3f(0.0), vec3f(1.0)) * 255.0 + 0.5));
      objAlpha = u32(floor(clamp(contact.a, 0.0, 1.0) * 255.0 + 0.5));
    }
  }

  let course = skyCourseForPixel(p);
  let fresnel = FRESNEL_WEIGHTS[course];
  let skyFar16 = vec3u(floor(clamp(params.skyFar.rgb, vec3f(0.0), vec3f(1.0)) * 65535.0 + 0.5));
  let skyNear16 = vec3u(floor(clamp(params.skyNear.rgb, vec3f(0.0), vec3f(1.0)) * 65535.0 + 0.5));
  let sky16 = mix256rgb(skyFar16, skyNear16, SKY_COURSE_MIX[course]);
  let skyWeight = u32(floor(clamp(params.skyFar.w, 0.0, 1.0) * 256.0 + 0.5));

  let bed16 = srgbBytesToLin16(vec3u(round(refracted.rgb * 255.0)));
  let skyRay = mix256rgb(bed16, sky16, skyWeight);
  let env = mix256rgb(skyRay, srgbBytesToLin16(objBytes), alphaByteToWeight(objAlpha));
  let landed16 = mix256rgb(bed16, env, fresnel);
  let guarded = waterReceiverGuard(lin16ToSrgbBytes(landed16), params.maxSat);
  return vec4f(vec3f(guarded) / 255.0, 1.0);
}

struct WaterResolveTargets {
  @location(0) color: vec4f,
  // Strict role 0 receiver guard: emission RGB = 0, role alpha = 0 (no bloom).
  @location(1) emission: vec4f,
}

@fragment fn planarWaterResolveFs(in: FullscreenOut) -> WaterResolveTargets {
  var out: WaterResolveTargets;
  out.color = resolveWaterAt(in.position.xy);
  out.emission = vec4f(0.0, 0.0, 0.0, 0.0);
  return out;
}

@fragment fn planarWaterResolveColorFs(in: FullscreenOut) -> @location(0) vec4f {
  return resolveWaterAt(in.position.xy);
}
`;

// ------------------------------------------------------------ WebGPU Pass class

function gpuTextureUsage() {
    return globalThis.GPUTextureUsage || {
        COPY_SRC: 0x01,
        COPY_DST: 0x02,
        TEXTURE_BINDING: 0x04,
        STORAGE_BINDING: 0x08,
        RENDER_ATTACHMENT: 0x10,
    };
}

function gpuBufferUsage() {
    return globalThis.GPUBufferUsage || {
        VERTEX: 0x20,
        UNIFORM: 0x40,
        COPY_DST: 0x08,
    };
}

function gpuShaderStage() {
    return globalThis.GPUShaderStage || {
        VERTEX: 0x1,
        FRAGMENT: 0x2,
    };
}

async function compileShaderModule(device, code, label) {
    const module = device.createShaderModule({ label, code });
    const info = await module.getCompilationInfo?.();
    const errors = (info?.messages || []).filter(msg => msg.type === 'error');
    if (errors.length) {
        const lines = code.split('\n');
        const detail = errors.slice(0, 8).map(msg => (
            `${label}:${msg.lineNum}:${msg.linePos} ${msg.message}\n    ${lines[msg.lineNum - 1]?.trim() ?? ''}`
        )).join('\n');
        throw new Error(`WGSL compilation failed (${errors.length} errors)\n${detail}`);
    }
    return module;
}

export class PlanarWaterPass {
    constructor({
        width = PLANAR_WIDTH,
        height = PLANAR_HEIGHT,
    } = {}) {
        this.width = width;
        this.height = height;
        this.device = null;
        this.ready = false;

        this.colorTexture = null;
        this.colorView = null;
        this.depthTexture = null;
        this.depthView = null;
        this.mirrorUniformBuffer = null;
        this.resolveUniformBuffer = null;
        this.mirrorSampler = null;

        this.mirrorBindGroupLayout = null;
        this.resolveParamsLayout = null;
        this.resolveTexturesLayout = null;
        this.mirrorPipeline = null;
        this.resolvePipeline = null;
        this.resolveColorOnlyPipeline = null;
        this.resolveParamsBindGroup = null;

        this._mirrorViews = createUniformViews(PLANAR_MIRROR_UNIFORM_LAYOUT.size);
        this._resolveViews = createUniformViews(PLANAR_WATER_PARAMS_LAYOUT.size);
        this._allocatedBytes = 0;
        this._mirrorClearCount = 0;
        this._admittedRecords = 0;
        this._rejectedRecords = 0;
        this._lastRect = [0, 0, 0, 0];
        this._activeBasin = 0;
        this._revision = 0;
        this._mirrorStale = true;
    }

    /**
     * Marks the cached mirror target stale (for example when the projected
     * basin leaves the viewport and mirror capture is suspended), guaranteeing
     * a fresh mirror capture on the first frame the basin re-enters view.
     */
    markMirrorStale() {
        this._mirrorStale = true;
    }

    needsMirrorCapture() {
        return this._mirrorStale || this._mirrorClearCount === 0;
    }

    async prepare(device, {
        colorFormat = 'rgba8unorm',
        emissionFormat = 'rgba8unorm',
        withEmission = true,
    } = {}) {
        if (!device) throw new Error('PlanarWaterPass.prepare requires a WebGPU device');
        this.release();
        this.device = device;

        const tu = gpuTextureUsage();
        const bu = gpuBufferUsage();
        const stage = gpuShaderStage();
        const vf = stage.VERTEX | stage.FRAGMENT;

        this.colorTexture = device.createTexture({
            label: 'planar-water-mirror-color',
            size: [this.width, this.height, 1],
            format: PLANAR_COLOR_FORMAT,
            usage: tu.RENDER_ATTACHMENT | tu.TEXTURE_BINDING | tu.COPY_SRC,
        });
        this.colorView = this.colorTexture.createView();

        this.depthTexture = device.createTexture({
            label: 'planar-water-mirror-depth',
            size: [this.width, this.height, 1],
            format: PLANAR_DEPTH_FORMAT,
            usage: tu.RENDER_ATTACHMENT,
        });
        this.depthView = this.depthTexture.createView();

        this.mirrorUniformBuffer = device.createBuffer({
            label: 'planar-water-mirror-uniforms',
            size: PLANAR_MIRROR_UNIFORM_LAYOUT.size,
            usage: bu.UNIFORM | bu.COPY_DST,
        });
        this.resolveUniformBuffer = device.createBuffer({
            label: 'planar-water-resolve-uniforms',
            size: PLANAR_WATER_PARAMS_LAYOUT.size,
            usage: bu.UNIFORM | bu.COPY_DST,
        });
        this.mirrorSampler = device.createSampler({
            label: 'planar-water-mirror-nearest',
            magFilter: 'nearest',
            minFilter: 'nearest',
            addressModeU: 'clamp-to-edge',
            addressModeV: 'clamp-to-edge',
        });

        this.mirrorBindGroupLayout = device.createBindGroupLayout({
            label: 'planar-water-mirror-bgl',
            entries: [
                { binding: PLANAR_MIRROR_BINDING.params, visibility: vf, buffer: { type: 'uniform', minBindingSize: PLANAR_MIRROR_UNIFORM_LAYOUT.size } },
                { binding: PLANAR_MIRROR_BINDING.albedo, visibility: stage.FRAGMENT, texture: { sampleType: 'float' } },
                { binding: PLANAR_MIRROR_BINDING.albedoSampler, visibility: stage.FRAGMENT, sampler: { type: 'filtering' } },
            ],
        });

        this.resolveParamsLayout = device.createBindGroupLayout({
            label: 'planar-water-resolve-params-bgl',
            entries: [
                { binding: 0, visibility: vf, buffer: { type: 'uniform', minBindingSize: PLANAR_WATER_PARAMS_LAYOUT.size } },
            ],
        });

        const B = PLANAR_WATER_RESOLVE_BINDING;
        this.resolveTexturesLayout = device.createBindGroupLayout({
            label: 'planar-water-resolve-textures-bgl',
            entries: [
                { binding: B.bed, visibility: stage.FRAGMENT, texture: { sampleType: 'float' } },
                { binding: B.contacts, visibility: stage.FRAGMENT, texture: { sampleType: 'float' } },
                { binding: B.occupancy, visibility: stage.FRAGMENT, texture: { sampleType: 'float' } },
                { binding: B.coast, visibility: stage.FRAGMENT, texture: { sampleType: 'float' } },
                { binding: B.cycle, visibility: stage.FRAGMENT, texture: { sampleType: 'float' } },
                { binding: B.gust, visibility: stage.FRAGMENT, texture: { sampleType: 'float' } },
                { binding: B.planarColor, visibility: stage.FRAGMENT, texture: { sampleType: 'float' } },
                { binding: B.rippleState, visibility: stage.FRAGMENT, texture: { sampleType: 'float' } },
                { binding: B.basinMap, visibility: stage.FRAGMENT, texture: { sampleType: 'uint' } },
            ],
        });

        const mirrorPipelineLayout = device.createPipelineLayout({
            label: 'planar-water-mirror-layout',
            bindGroupLayouts: [this.mirrorBindGroupLayout],
        });
        const resolvePipelineLayout = device.createPipelineLayout({
            label: 'planar-water-resolve-layout',
            bindGroupLayouts: [this.resolveParamsLayout, this.resolveTexturesLayout],
        });

        const [mirrorModule, resolveModule] = await Promise.all([
            compileShaderModule(device, PLANAR_MIRROR_CAPTURE_WGSL, 'planar-mirror.wgsl'),
            compileShaderModule(device, PLANAR_WATER_RESOLVE_WGSL, 'planar-water-resolve.wgsl'),
        ]);

        const mirrorVertexBufferLayout = {
            arrayStride: 48,
            stepMode: 'instance',
            attributes: [
                { shaderLocation: 0, offset: 0, format: 'float32x4' },
                { shaderLocation: 1, offset: 16, format: 'float32x4' },
                { shaderLocation: 2, offset: 32, format: 'float32x4' },
            ],
        };

        const pipelines = await Promise.all([
            device.createRenderPipelineAsync({
                label: 'planar-water-mirror-pipeline',
                layout: mirrorPipelineLayout,
                vertex: { module: mirrorModule, entryPoint: 'planarMirrorVs', buffers: [mirrorVertexBufferLayout] },
                primitive: { topology: 'triangle-strip', cullMode: 'none' },
                depthStencil: {
                    format: PLANAR_DEPTH_FORMAT,
                    depthWriteEnabled: true,
                    depthCompare: 'less',
                },
                fragment: {
                    module: mirrorModule,
                    entryPoint: 'planarMirrorFs',
                    targets: [{ format: PLANAR_COLOR_FORMAT }],
                },
            }),
            withEmission
                ? device.createRenderPipelineAsync({
                    label: 'planar-water-resolve-mrt-pipeline',
                    layout: resolvePipelineLayout,
                    vertex: { module: resolveModule, entryPoint: 'fullscreenVs' },
                    primitive: { topology: 'triangle-list' },
                    fragment: {
                        module: resolveModule,
                        entryPoint: 'planarWaterResolveFs',
                        targets: [{ format: colorFormat }, { format: emissionFormat }],
                    },
                })
                : null,
            device.createRenderPipelineAsync({
                label: 'planar-water-resolve-color-pipeline',
                layout: resolvePipelineLayout,
                vertex: { module: resolveModule, entryPoint: 'fullscreenVs' },
                primitive: { topology: 'triangle-list' },
                fragment: {
                    module: resolveModule,
                    entryPoint: 'planarWaterResolveColorFs',
                    targets: [{ format: colorFormat }],
                },
            }),
        ]);

        this.mirrorPipeline = pipelines[0];
        this.resolvePipeline = pipelines[1];
        this.resolveColorOnlyPipeline = pipelines[2];

        this.resolveParamsBindGroup = device.createBindGroup({
            label: 'planar-water-resolve-params-bg',
            layout: this.resolveParamsLayout,
            entries: [{ binding: 0, resource: { buffer: this.resolveUniformBuffer } }],
        });

        this._allocatedBytes = this.width * this.height * 4 * 2;
        this._mirrorStale = true;
        this.ready = true;
        return this;
    }

    /**
     * Creates a group-1 bind group for the 9 resolve textures (bindings 0..8).
     */
    createResolveTextureBindGroup(views) {
        if (!this.device || !this.resolveTexturesLayout) {
            throw new Error('PlanarWaterPass is not prepared');
        }
        const B = PLANAR_WATER_RESOLVE_BINDING;
        return this.device.createBindGroup({
            label: 'planar-water-resolve-textures-bg',
            layout: this.resolveTexturesLayout,
            entries: [
                { binding: B.bed, resource: views.bed },
                { binding: B.contacts, resource: views.contacts },
                { binding: B.occupancy, resource: views.occupancy },
                { binding: B.coast, resource: views.coast },
                { binding: B.cycle, resource: views.cycle },
                { binding: B.gust, resource: views.gust },
                { binding: B.planarColor, resource: views.planarColor || this.colorView },
                { binding: B.rippleState, resource: views.rippleState },
                { binding: B.basinMap, resource: views.basinMap },
            ],
        });
    }

    /**
     * Encodes the mirror capture pass (always clearing color to transparent
     * black (0,0,0,0) and depth to 1.0 so departed hulls vanish) and, when a
     * resolve target + texture bind group are supplied, encodes the water
     * resolve pass with strict role-0 emission zeroing.
     */
    encode(encoder, {
        planarRect = [0, 0, 0, 0],
        gradeGain = [1, 1, 1], gradeExposure = 1, gradePurkinje = [1, 1, 1], gradeSaturation = 1,
        gradeLift = [0, 0, 0], gradeGamma = [1, 1, 1], gradeHighlight = [1, 1, 1], gradeShadow = [1, 1, 1],
        waterZ = 0,
        basinId = 0,
        records = [],
        admittedCount = null,
        mirrorBatches = [],
        bedCopy = null, captureMirror = true,
        resolveTargetView = null,
        resolveEmissionView = null,
        resolveTextureBindGroup = null,
        cameraXy = [0, 0],
        resolution = [1280, 720],
        cameraScale = 1,
        skyFar = [0, 0, 0, 0],
        skyNear = [0, 0, 0, 0],
        coastOrigin = [-1536, -144, 0, 0],
        rippleSize = [256, 256, 1, 0],
        maxSat = 0.44,
        reducedMotion = false,
        featureMask = 1,
        revision = this._revision + 1,
    } = {}) {
        if (!this.ready || !this.device || !encoder) return { encoded: false, admitted: 0, rejected: 0 };

        const rectW = Math.max(0, Math.min(this.width, Math.floor(planarRect[2] || 0)));
        const rectH = Math.max(0, Math.min(this.height, Math.floor(planarRect[3] || 0)));
        const validRect = [Math.floor(planarRect[0] || 0), Math.floor(planarRect[1] || 0), rectW, rectH];

        const sources = Array.isArray(records) ? records : [];
        if (typeof admittedCount === 'number' && Number.isFinite(admittedCount)) {
            this._admittedRecords = Math.max(0, Math.floor(admittedCount));
            this._rejectedRecords = Math.max(0, sources.length - this._admittedRecords);
        } else if (captureMirror) {
            const admission = { basinId: basinId || null };
            this._admittedRecords = 0;
            for (const source of sources) if (isMirrorAdmittedRecord(source, admission)) this._admittedRecords++;
            this._rejectedRecords = sources.length - this._admittedRecords;
        }
        this._lastRect = validRect;
        this._activeBasin = basinId >>> 0;
        this._revision = revision >>> 0;

        // Pass 1: Reflected mirror capture — always clears to transparent black
        // (0,0,0,0) and depth 1.0 so valid-empty = reflected sky and departed
        // hulls are purged cleanly. Skip uniform staging when mirror capture is
        // intentionally held on a cadence off-frame.
        if (captureMirror) {
            writeUniforms(PLANAR_MIRROR_UNIFORM_LAYOUT, this._mirrorViews, {
                planarRect: validRect,
                basinParams: [waterZ, PLANAR_CONTACT_BAND_PX, PLANAR_COLLAR_PX, PLANAR_MAX_SHIFT_PX],
                depthRange: [PLANAR_DEPTH_MIN, PLANAR_DEPTH_MAX, PLANAR_DEPTH_RECIP, 0],
                gradeGain, gradeExposure, gradePurkinje, gradeSaturation, gradeLift, gradeGamma, gradeHighlight, gradeShadow,
                targetSize: [this.width, this.height, 1 / this.width, 1 / this.height],
            });
            this.device.queue.writeBuffer(this.mirrorUniformBuffer, 0, this._mirrorViews.buffer);
            const mirrorPass = encoder.beginRenderPass({
                label: 'planar-water-mirror-capture',
                colorAttachments: [{
                    view: this.colorView,
                    clearValue: PLANAR_CLEAR_COLOR,
                    loadOp: 'clear',
                    storeOp: 'store',
                }],
                depthStencilAttachment: {
                    view: this.depthView,
                    depthClearValue: PLANAR_CLEAR_DEPTH,
                    depthLoadOp: 'clear',
                    depthStoreOp: 'store',
                },
            });
            this._mirrorClearCount++;
            this._mirrorStale = false;
            if (rectW > 0 && rectH > 0) {
                mirrorPass.setScissorRect?.(0, 0, rectW, rectH);
                mirrorPass.setViewport?.(0, 0, this.width, this.height, 0, 1);
                if (Array.isArray(mirrorBatches) && mirrorBatches.length > 0 && this.mirrorPipeline) {
                    mirrorPass.setPipeline(this.mirrorPipeline);
                    for (const batch of mirrorBatches) {
                        if (!batch?.bindGroup || !batch?.instanceBuffer || !(batch.instanceCount > 0)) continue;
                        mirrorPass.setBindGroup(0, batch.bindGroup);
                        mirrorPass.setVertexBuffer(0, batch.instanceBuffer, batch.instanceOffset || 0);
                        mirrorPass.draw(4, batch.instanceCount, 0, batch.firstInstance || 0);
                    }
                }
            }
            mirrorPass.end();
        }

        // Pass 2: Integer water resolve pass (optional when caller resolves later).
        let resolved = false;
        if (resolveTargetView && resolveTextureBindGroup) {
            writeUniforms(PLANAR_WATER_PARAMS_LAYOUT, this._resolveViews, {
                cameraXy,
                bedOrigin: bedCopy?.origin || [0, 0],
                resolution,
                cameraScale,
                waterZ,
                maxSat,
                reducedMotion: reducedMotion ? 1 : 0,
                planarRect: validRect,
                basinParams: [waterZ, PLANAR_CONTACT_BAND_PX, PLANAR_COLLAR_PX, PLANAR_MAX_SHIFT_PX],
                depthRange: [PLANAR_DEPTH_MIN, PLANAR_DEPTH_MAX, PLANAR_DEPTH_RECIP, 8],
                frontier: [featureMask >>> 0, basinId >>> 0, this._revision, 0],
                skyFar,
                skyNear,
                coastOrigin,
                rippleSize,
            });
            this.device.queue.writeBuffer(this.resolveUniformBuffer, 0, this._resolveViews.buffer);

            const useMrt = Boolean(resolveEmissionView && this.resolvePipeline);
            const attachments = [{
                view: resolveTargetView,
                loadOp: 'load',
                storeOp: 'store',
            }];
            if (useMrt) {
                attachments.push({
                    view: resolveEmissionView,
                    loadOp: 'load',
                    storeOp: 'store',
                });
            }
            const [x, y] = bedCopy?.origin || [0, 0];
            const [width, height] = bedCopy?.size || resolution;
            const strip = bedCopy?.bed.height || height;
            for (let dy = 0; dy < height; dy += strip) {
                const rows = Math.min(strip, height - dy);
                if (bedCopy) encoder.copyTextureToTexture({ texture: bedCopy.source, origin: [x, y + dy] },
                    { texture: bedCopy.bed }, [width, rows]);
                const resolvePass = encoder.beginRenderPass({
                    label: 'planar-water-resolve',
                    colorAttachments: attachments,
                });
                resolvePass.setPipeline(useMrt ? this.resolvePipeline : this.resolveColorOnlyPipeline);
                resolvePass.setBindGroup(0, this.resolveParamsBindGroup);
                resolvePass.setBindGroup(1, resolveTextureBindGroup);
                if (bedCopy) resolvePass.setScissorRect(x, y + dy, width, rows);
                resolvePass.draw(3, 1, 0, 0);
                resolvePass.end();
            }
            resolved = true;
        }

        return {
            encoded: true,
            resolved,
            admitted: this._admittedRecords,
            rejected: this._rejectedRecords,
            validRect,
        };
    }

    release() {
        this.colorTexture?.destroy?.();
        this.depthTexture?.destroy?.();
        this.mirrorUniformBuffer?.destroy?.();
        this.resolveUniformBuffer?.destroy?.();
        this.colorTexture = null;
        this.colorView = null;
        this.depthTexture = null;
        this.depthView = null;
        this.mirrorUniformBuffer = null;
        this.resolveUniformBuffer = null;
        this.mirrorSampler = null;
        this.mirrorBindGroupLayout = null;
        this.resolveParamsLayout = null;
        this.resolveTexturesLayout = null;
        this.mirrorPipeline = null;
        this.resolvePipeline = null;
        this.resolveColorOnlyPipeline = null;
        this.resolveParamsBindGroup = null;
        this.device = null;
        this.ready = false;
        this._allocatedBytes = 0;
        this._mirrorStale = true;
    }

    getDiagnostics() {
        return {
            ready: this.ready,
            width: this.width,
            height: this.height,
            colorFormat: PLANAR_COLOR_FORMAT,
            depthFormat: PLANAR_DEPTH_FORMAT,
            colorBytes: this.width * this.height * 4,
            depthBytes: this.width * this.height * 4,
            totalBytes: this.width * this.height * 4 * 2,
            allocatedBytes: this._allocatedBytes,
            mirrorClearCount: this._mirrorClearCount,
            mirrorStale: this._mirrorStale,
            admittedRecords: this._admittedRecords,
            rejectedRecords: this._rejectedRecords,
            lastRect: [...this._lastRect],
            activeBasin: this._activeBasin,
            revision: this._revision,
        };
    }
}

export function createPlanarWaterPass(options = {}) {
    return new PlanarWaterPass(options);
}
