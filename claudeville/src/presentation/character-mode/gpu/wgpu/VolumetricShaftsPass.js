// Wave 5-D (Astra #4) — Depth-Tested Quantized Volumetric Shafts Pass.
//
// Self-contained WebGPU render pass exposing `{ prepare, encode, release,
// buildShaftInstances, getDiagnostics }`.
//
// Contract (specs/01 §1, §3 & §4 D7 addenda; specs/03 Wave 5-D):
// - Renders depth-tested, pixel-grammar quantized volumetric shafts for:
//     * Archive: cool/warm lancet sunbeams gated by solar angle & daylight
//       (strictly zero at night or heavy storm/overcast).
//     * Forge: warm hearth glow shafts out of the open-front furnace bay,
//       gated by active work & dusk/night (strictly zero when banked/cold).
// - Strict Pixel-Art Grammar:
//     * SHAFT_TERMINAL_SLICES = 8 (matches FrameUniforms.depthRange.w = 8).
//     * Stepped 4x4 Bayer dithering (BAYER_4X4) snapped to integer world/art texels.
//     * Discrete 0/1/2 air courses quantized across 8 slices — ZERO smooth
//       linear/radial gradients or smooth interpolation blur.
// - Depth Testing:
//     * Uses specs/01 depthRange: Dmin = -2048, Dmax = 6144, invSpan = 1 / 8192.
//     * d = (6144 - D) / 8192 (closer surfaces have larger D and smaller d).
//     * Tests against scene depth (depthWriteEnabled: false, compare: 'less-equal')
//       so shafts clip cleanly behind building lintels, piers, and foreground characters.
// - Strict Role-0 Receiver Limits (specs/01 §3):
//     * role = 0, emission RGB = 0, role alpha = 0, no bloom.
//     * Linear relative luminance <= 0.70, encoded Rec.709 Y <= 0.74,
//       HSV S <= 0.65 whenever V >= 0.50.
// - Frontier feature mask bit 4 (1 << 4 = 16).

import { BUILDING_DEFS } from '../../../../config/buildings.js';
import { RECEIVER_LUMA_CEILING } from '../../../../config/artPalette.js';
import { BUILDING_VISUAL_REGISTRY } from '../../BuildingVisualRegistry.js';
import { tileToWorld } from '../../Projection.js';
import { createUniformViews, uniformLayout, writeUniforms } from '../wgsl/common.js';
import { BLEND_NORMAL, SCENE_COLOR_FORMAT, SCENE_EMISSION_FORMAT } from './GpuWgpuPipelines.js';

export const SHAFT_TERMINAL_SLICES = 8;
export const SHAFT_DEPTH_MIN = -2048;
export const SHAFT_DEPTH_MAX = 6144;
export const SHAFT_DEPTH_SPAN = SHAFT_DEPTH_MAX - SHAFT_DEPTH_MIN; // 8192
export const SHAFT_DEPTH_INV_SPAN = 1 / SHAFT_DEPTH_SPAN;          // 1 / 8192
export const SHAFT_DEPTH_RANGE = Object.freeze([
    SHAFT_DEPTH_MIN,
    SHAFT_DEPTH_MAX,
    SHAFT_DEPTH_INV_SPAN,
    SHAFT_TERMINAL_SLICES,
]);

export const SHAFT_FRONTIER_MASK_BIT = 1 << 4; // 16 (FrameUniforms.frontier.x bit 4)

// Receiver limits from specs/01 §3 & artPalette.js / art-analyze.mjs.
export const SHAFT_RECEIVER_MAX_LINEAR_LUMA = 0.70;
export const SHAFT_RECEIVER_MAX_ENCODED_LUMA = RECEIVER_LUMA_CEILING; // 0.74
export const SHAFT_RECEIVER_MAX_HSV_SAT = 0.65;
export const SHAFT_RECEIVER_HSV_SAT_MIN_V = 0.50;
export const SHAFT_MAX_ALPHA = 0.36;

// Canonical 4x4 row-major Bayer rank matrix (specs/01 §3).
export const BAYER_4X4 = Object.freeze([
    0, 8, 2, 10,
    12, 4, 14, 6,
    3, 11, 1, 9,
    15, 7, 13, 5,
]);

export const SHAFT_KINDS = Object.freeze({
    archive: 1,
    forge: 2,
});

export const SHAFT_MAX_INSTANCES = 32;
export const SHAFT_INSTANCE_FLOATS = 20;
export const SHAFT_INSTANCE_BYTES = SHAFT_INSTANCE_FLOATS * 4; // 80 B (5 x vec4f)
export const SHAFT_INSTANCE_BUFFER_BYTES = SHAFT_MAX_INSTANCES * SHAFT_INSTANCE_BYTES; // 2,560 B

export const SHAFT_BINDINGS = Object.freeze({
    params: 0,
    shafts: 1,
    sceneDepth: 2,
    windField: 3,
});

export const SHAFT_PARAMS_LAYOUT = uniformLayout('ShaftFrameParams', [
    ['cameraXy', 'vec2f'],
    ['resolution', 'vec2f'],
    ['depthRange', 'vec4f'], // (-2048, 6144, 1/8192, 8)
    ['windBounds', 'vec4f'], // (originX, originY, width, height)
    ['cameraScale', 'f32'],
    ['timeSec', 'f32'],
    ['shaftCount', 'u32'],
    ['flags', 'u32'], // bit0=glRows, bit1=useSceneDepthTex, bit2=useWindTex, bit3=reducedMotion
]);

// Authentic sprite anchors from manifest.yaml for building.archive & building.forge.
const ARCHIVE_SPRITE_ANCHOR = Object.freeze([167, 182]);
const FORGE_SPRITE_ANCHOR = Object.freeze([128, 169]);

// Receiver-safe palettes (pre-calibrated well below L_lin <= 0.70, Y_enc <= 0.74, S <= 0.65).
export const SHAFT_PALETTE = Object.freeze({
    archiveNoon: Object.freeze([0.74, 0.71, 0.63]),   // Cool-warm limestone sunbeam
    archiveGolden: Object.freeze([0.82, 0.68, 0.48]), // Golden-hour amber lancet beam
    forgeHearth: Object.freeze([0.84, 0.58, 0.34]),   // Warm ochre hearth glow (role 0)
});

export const FORGE_BANKED_GLOW_THRESHOLD = 0.20;

export const VOLUMETRIC_SHAFTS_WGSL = /* wgsl */ `
${SHAFT_PARAMS_LAYOUT.wgsl}

struct ShaftInstanceGpu {
  originReach: vec4f, // x=originX, y=originY, z=reachX, w=reachY
  prismDepth: vec4f,  // x=apertureHalfW, y=spread, z=depthOriginD, w=depthEndD
  colorAlpha: vec4f,  // rgb=role0 base color, a=maxAlpha
  gateMeta: vec4f,    // x=intensity, y=kind (1=archive,2=forge), z=lintelClipPx, w=mistGain
  pad0: vec4f,        // reserved zero for 80 B alignment
}

@group(0) @binding(${SHAFT_BINDINGS.params}) var<uniform> params: ShaftFrameParams;
@group(0) @binding(${SHAFT_BINDINGS.shafts}) var<storage, read> shafts: array<ShaftInstanceGpu>;
@group(0) @binding(${SHAFT_BINDINGS.sceneDepth}) var sceneDepthTex: texture_2d<f32>;
@group(0) @binding(${SHAFT_BINDINGS.windField}) var windFieldTex: texture_2d<f32>;

const SHAFT_SLICES: u32 = ${SHAFT_TERMINAL_SLICES}u;
const SHAFT_SLICES_F: f32 = ${SHAFT_TERMINAL_SLICES}.0;
const RECEIVER_MAX_LIN_LUMA: f32 = 0.699;
const RECEIVER_MAX_ENC_LUMA: f32 = 0.739;
const RECEIVER_MAX_SAT: f32 = 0.65;
const RECEIVER_SAT_MIN_V: f32 = 0.50;

const BAYER_4X4 = array<f32, 16>(
  0.0, 8.0, 2.0, 10.0,
  12.0, 4.0, 14.0, 6.0,
  3.0, 11.0, 1.0, 9.0,
  15.0, 7.0, 13.0, 5.0
);

struct ShaftVsOut {
  @builtin(position) position: vec4f,
  @location(0) worldPos: vec2f,
  @location(1) @interpolate(flat) shaftIndex: u32,
}

struct ShaftMrtOut {
  @location(0) color: vec4f,
  @location(1) emission: vec4f,
}

fn srgbToLinearChannel(c: f32) -> f32 {
  if (c <= 0.04045) {
    return c / 12.92;
  }
  return pow((c + 0.055) / 1.055, 2.4);
}

fn linearToSrgbChannel(l: f32) -> f32 {
  let clamped = max(l, 0.0);
  if (clamped <= 0.0031308) {
    return clamped * 12.92;
  }
  return 1.055 * pow(clamped, 1.0 / 2.4) - 0.055;
}

fn clampReceiverColor(rawRgb: vec3f) -> vec3f {
  var c = clamp(rawRgb, vec3f(0.0), vec3f(1.0));
  let v = max(c.r, max(c.g, c.b));
  if (v >= RECEIVER_SAT_MIN_V) {
    let minAllowed = v * (1.0 - RECEIVER_MAX_SAT);
    c = max(c, vec3f(minAllowed));
  }
  let yEnc = dot(c, vec3f(0.2126, 0.7152, 0.0722));
  if (yEnc > RECEIVER_MAX_ENC_LUMA) {
    c = c * (RECEIVER_MAX_ENC_LUMA / max(yEnc, 1e-6));
  }
  let lin = vec3f(
    srgbToLinearChannel(c.r),
    srgbToLinearChannel(c.g),
    srgbToLinearChannel(c.b)
  );
  let yLin = dot(lin, vec3f(0.2126, 0.7152, 0.0722));
  if (yLin > RECEIVER_MAX_LIN_LUMA) {
    let scaledLin = lin * (RECEIVER_MAX_LIN_LUMA / max(yLin, 1e-6));
    c = clamp(vec3f(
      linearToSrgbChannel(scaledLin.r),
      linearToSrgbChannel(scaledLin.g),
      linearToSrgbChannel(scaledLin.b)
    ), vec3f(0.0), vec3f(1.0));
  }
  return c;
}

fn encodeShaftDepth(depthD: f32) -> f32 {
  return clamp((params.depthRange.y - depthD) * params.depthRange.z, 0.0, 1.0);
}

fn bayerThresholdAt(texel: vec2i) -> f32 {
  var bayer = BAYER_4X4;
  let bx = u32(texel.x & 3);
  let by = u32(texel.y & 3);
  return (bayer[(by << 2u) | bx] + 0.5) / 16.0;
}

@vertex fn shaftVs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> ShaftVsOut {
  var out: ShaftVsOut;
  out.shaftIndex = ii;
  if (ii >= params.shaftCount) {
    out.position = vec4f(2.0, 2.0, 2.0, 1.0);
    out.worldPos = vec2f(0.0);
    return out;
  }

  let s = shafts[ii];
  let origin = s.originReach.xy;
  let reach = s.originReach.zw;
  let reachLen = max(length(reach), 1.0);
  let axis = reach / reachLen;
  let perp = vec2f(-axis.y, axis.x);
  let halfW0 = s.prismDepth.x + 1.0;
  let halfW1 = s.prismDepth.x + s.prismDepth.y + 1.0;

  // Two-triangle quad covering the exact prism trapezoid.
  var u: f32 = 0.0;
  var side: f32 = -1.0;
  if (vi == 1u || vi == 4u) {
    u = 0.0;
    side = 1.0;
  } else if (vi == 2u || vi == 3u) {
    u = 1.0;
    side = -1.0;
  } else if (vi == 5u) {
    u = 1.0;
    side = 1.0;
  }

  let halfW = mix(halfW0, halfW1, u);
  let world = origin + reach * u + perp * (side * halfW);
  let depthD = mix(s.prismDepth.z, s.prismDepth.w, u);
  let screen = (world + params.cameraXy) * params.cameraScale;
  var clip = vec2f(
    screen.x / max(1.0, params.resolution.x) * 2.0 - 1.0,
    1.0 - screen.y / max(1.0, params.resolution.y) * 2.0
  );
  if ((params.flags & 1u) != 0u) {
    clip.y = -clip.y;
  }

  out.position = vec4f(clip.x, clip.y, encodeShaftDepth(depthD), 1.0);
  out.worldPos = world;
  return out;
}

fn evaluateShaftFragment(in: ShaftVsOut) -> vec4f {
  let s = shafts[in.shaftIndex];
  if (s.gateMeta.x <= 0.001) {
    discard;
  }

  // Snap to integer world/art texels for strict pixel-art grammar.
  let texel = vec2i(floor(in.worldPos));
  let texelF = vec2f(f32(texel.x), f32(texel.y));
  let rel = texelF - s.originReach.xy;
  let reach = s.originReach.zw;
  let lenSq = max(dot(reach, reach), 1.0);
  let reachLen = sqrt(lenSq);
  let u = dot(rel, reach) / lenSq;
  let v = (-rel.x * reach.y + rel.y * reach.x) / reachLen;
  let halfW = s.prismDepth.x + s.prismDepth.y * u;

  // Clip strictly to the exact aperture prism.
  if (u < 0.0 || u >= 1.0 || abs(v) > halfW) {
    discard;
  }

  let sliceIdx = min(SHAFT_SLICES - 1u, u32(max(0.0, floor(u * SHAFT_SLICES_F))));
  let sliceCenter = (f32(sliceIdx) + 0.5) / SHAFT_SLICES_F;
  let shaftDepthD = mix(s.prismDepth.z, s.prismDepth.w, sliceCenter);
  let shaftDepthNdc = encodeShaftDepth(shaftDepthD);

  // Explicit scene-depth occlusion clip behind lintels, piers, and foreground bodies.
  if ((params.flags & 2u) != 0u) {
    let dims = vec2i(textureDimensions(sceneDepthTex));
    let px = clamp(vec2i(floor(in.position.xy)), vec2i(0), max(dims - vec2i(1), vec2i(0)));
    let sceneDepthNdc = textureLoad(sceneDepthTex, px, 0).r;
    if (sceneDepthNdc < shaftDepthNdc) {
      discard;
    }
  }

  // Optional nearest-cell mist modulation from the 128x128 wind/mist compute field.
  var mistDensity: f32 = 0.0;
  if ((params.flags & 4u) != 0u) {
    let wDims = vec2i(textureDimensions(windFieldTex));
    let norm = clamp((texelF - params.windBounds.xy) / max(params.windBounds.zw, vec2f(1.0)), vec2f(0.0), vec2f(1.0));
    let wCell = clamp(vec2i(floor(norm * vec2f(wDims))), vec2i(0), max(wDims - vec2i(1), vec2i(0)));
    mistDensity = clamp(textureLoad(windFieldTex, wCell, 0).a, 0.0, 1.0);
  }

  // Discrete slice attenuation + stepped 4x4 Bayer dithering across 8 slices.
  let longAtten = 1.0 - f32(sliceIdx) / SHAFT_SLICES_F;
  let edgeRatio = clamp(1.0 - abs(v) / max(halfW, 0.5), 0.0, 1.0);
  let mistBoost = 1.0 + s.gateMeta.w * mistDensity;
  let rawEnergy = clamp(s.gateMeta.x * longAtten * (0.45 + 0.55 * edgeRatio) * mistBoost, 0.0, 1.0);

  let threshold = bayerThresholdAt(texel);
  let qLevel = min(SHAFT_SLICES, u32(max(0.0, floor(rawEnergy * SHAFT_SLICES_F + threshold))));
  if (qLevel == 0u) {
    discard;
  }

  // Quantize into 0 / 1 / 2 air courses and clamp strictly to role-0 receiver limits.
  let courseGain = select(0.84, 1.0, qLevel >= 5u);
  let rgb = clampReceiverColor(s.colorAlpha.rgb * courseGain);
  let alpha = (f32(qLevel) / SHAFT_SLICES_F) * clamp(s.colorAlpha.a, 0.0, ${SHAFT_MAX_ALPHA.toFixed(4)});
  return vec4f(rgb * alpha, alpha);
}

@fragment fn shaftFs(in: ShaftVsOut) -> ShaftMrtOut {
  var out: ShaftMrtOut;
  out.color = evaluateShaftFragment(in);
  // Strictly role 0 receiver: emission RGB = 0, role alpha = 0, never enters bloom.
  out.emission = vec4f(0.0, 0.0, 0.0, 0.0);
  return out;
}

@fragment fn shaftColorFs(in: ShaftVsOut) -> @location(0) vec4f {
  return evaluateShaftFragment(in);
}
`;

function finite(value, fallback = 0) {
    const num = Number(value);
    return Number.isFinite(num) ? num : fallback;
}

function clamp(value, min, max) {
    return value < min ? min : value > max ? max : value;
}

export function srgbToLinear(c) {
    const x = clamp(finite(c, 0), 0, 1);
    return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
}

export function linearToSrgb(l) {
    const x = Math.max(0, finite(l, 0));
    return x <= 0.0031308 ? x * 12.92 : 1.055 * (x ** (1 / 2.4)) - 0.055;
}

export function computeLinearLuma(rgb) {
    return 0.2126 * srgbToLinear(rgb[0]) + 0.7152 * srgbToLinear(rgb[1]) + 0.0722 * srgbToLinear(rgb[2]);
}

export function computeEncodedLuma(rgb) {
    return 0.2126 * clamp(rgb[0], 0, 1) + 0.7152 * clamp(rgb[1], 0, 1) + 0.0722 * clamp(rgb[2], 0, 1);
}

export function computeHsv(rgb) {
    const r = clamp(rgb[0], 0, 1);
    const g = clamp(rgb[1], 0, 1);
    const b = clamp(rgb[2], 0, 1);
    const v = Math.max(r, g, b);
    const mn = Math.min(r, g, b);
    const s = v > 1e-6 ? (v - mn) / v : 0;
    return { s, v };
}

/**
 * Clamp an sRGB `[r, g, b]` color to strict specs/01 §3 role-0 receiver limits:
 * - HSV S <= 0.65 when V >= 0.50
 * - Encoded Rec.709 Y <= 0.74
 * - Linear luminance <= 0.70
 */
export function clampReceiverColor(rgb) {
    let r = clamp(finite(rgb?.[0], 0), 0, 1);
    let g = clamp(finite(rgb?.[1], 0), 0, 1);
    let b = clamp(finite(rgb?.[2], 0), 0, 1);

    const v = Math.max(r, g, b);
    if (v >= SHAFT_RECEIVER_HSV_SAT_MIN_V) {
        const minAllowed = v * (1 - SHAFT_RECEIVER_MAX_HSV_SAT);
        if (r < minAllowed) r = minAllowed;
        if (g < minAllowed) g = minAllowed;
        if (b < minAllowed) b = minAllowed;
    }

    const maxEnc = SHAFT_RECEIVER_MAX_ENCODED_LUMA - 0.001;
    const yEnc = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    if (yEnc > maxEnc) {
        const scale = maxEnc / Math.max(yEnc, 1e-6);
        r *= scale;
        g *= scale;
        b *= scale;
    }

    const maxLin = SHAFT_RECEIVER_MAX_LINEAR_LUMA - 0.001;
    const lr = srgbToLinear(r);
    const lg = srgbToLinear(g);
    const lb = srgbToLinear(b);
    const yLin = 0.2126 * lr + 0.7152 * lg + 0.0722 * lb;
    if (yLin > maxLin) {
        const scale = maxLin / Math.max(yLin, 1e-6);
        r = clamp(linearToSrgb(lr * scale), 0, 1);
        g = clamp(linearToSrgb(lg * scale), 0, 1);
        b = clamp(linearToSrgb(lb * scale), 0, 1);
    }

    return [r, g, b];
}

/** Encode near-order depth `D` into `[0, 1]` using specs/01 `depthRange` (`d = (6144 - D) / 8192`). */
export function encodeShaftDepth(depthD) {
    return clamp((SHAFT_DEPTH_MAX - finite(depthD, SHAFT_DEPTH_MIN)) * SHAFT_DEPTH_INV_SPAN, 0, 1);
}

/** Decode normalized `[0, 1]` depth back to near-order `D`. */
export function decodeShaftDepth(ndcZ) {
    return SHAFT_DEPTH_MAX - clamp(finite(ndcZ, 1), 0, 1) * SHAFT_DEPTH_SPAN;
}

/** Return the 4x4 Bayer rank (0..15) and normalized threshold `(rank + 0.5) / 16` at integer world texel `(tx, ty)`. */
export function bayer4At(texelX, texelY) {
    const bx = Math.floor(texelX) & 3;
    const by = Math.floor(texelY) & 3;
    const rank = BAYER_4X4[(by << 2) | bx];
    return { rank, threshold: (rank + 0.5) / 16 };
}

function findBuildingDef(type) {
    return BUILDING_DEFS.find(b => b.type === type) || null;
}

function resolveDaylightAndSolar(sceneState = {}) {
    if (sceneState.isNight === true) {
        return { daylight: 0, sunElevation: -0.25, sunAzimuth: 0, warmth: 0, nightShare: 1 };
    }

    const hour = sceneState.hour ?? sceneState.atmosphere?.clock?.hour;
    const hasElevation = Number.isFinite(Number(sceneState.sunElevation));
    const hasDaylight = Number.isFinite(Number(sceneState.daylight));

    let sunElevation;
    if (hasElevation) {
        sunElevation = Number(sceneState.sunElevation);
    } else if (Number.isFinite(Number(hour))) {
        const h = Number(hour);
        if (h <= 5.5 || h >= 20.0) {
            sunElevation = -0.2;
        } else {
            const t = clamp((h - 5.5) / (20.0 - 5.5), 0, 1);
            sunElevation = Math.sin(t * Math.PI) * 1.05;
        }
    } else if (hasDaylight) {
        const d = clamp(Number(sceneState.daylight), 0, 1);
        sunElevation = d > 0.05 ? d * 0.95 : -0.15;
    } else {
        sunElevation = -0.2;
    }

    let daylight;
    if (sunElevation <= 0.02) {
        daylight = 0;
    } else if (hasDaylight) {
        daylight = clamp(Number(sceneState.daylight), 0, 1);
    } else {
        daylight = clamp(Math.sin(clamp(sunElevation, 0, Math.PI * 0.5)) * 1.15, 0, 1);
    }

    const sunAlpha = sceneState.sunAlpha !== undefined ? clamp(finite(sceneState.sunAlpha, 1), 0, 1) : 1;
    if (sunAlpha <= 0.04) daylight = 0;

    let sunAzimuth;
    if (Number.isFinite(Number(sceneState.sunAzimuth))) {
        sunAzimuth = Number(sceneState.sunAzimuth);
    } else if (Number.isFinite(Number(sceneState.sunAngleRad))) {
        sunAzimuth = Number(sceneState.sunAngleRad);
    } else if (Number.isFinite(Number(hour))) {
        // Morning (+0.45 rad SE) -> noon (0.20 rad) -> late afternoon (-0.25 rad SW).
        const t = clamp((Number(hour) - 6) / 13, 0, 1);
        sunAzimuth = 0.45 - t * 0.70;
    } else {
        sunAzimuth = 0.25;
    }

    // Golden-hour warmth increases at low positive solar elevation.
    const warmth = daylight > 0 ? clamp(1 - (sunElevation - 0.12) / 0.55, 0, 1) : 0;
    const nightShare = clamp(1 - daylight, 0, 1);
    return { daylight: daylight * sunAlpha, sunElevation, sunAzimuth, warmth, nightShare };
}

function resolveForgeGate(sceneState = {}) {
    const forgeState = String(sceneState.forgeState || '').toLowerCase();
    if (
        sceneState.forgeBanked === true
        || sceneState.forgeCold === true
        || forgeState === 'banked'
        || forgeState === 'cold'
        || forgeState === 'off'
    ) {
        return { active: false, intensity: 0 };
    }

    const workingCount = Math.max(0, finite(sceneState.forgeWorkingCount, 0));
    const forgeGlow = finite(sceneState.forgeGlow, NaN);
    const explicitlyActive = sceneState.forgeActive === true || sceneState.forgeOpen === true || forgeState === 'active' || forgeState === 'working';
    const hasWork = explicitlyActive || workingCount > 0 || (Number.isFinite(forgeGlow) && forgeGlow > FORGE_BANKED_GLOW_THRESHOLD);

    if (!hasWork) {
        return { active: false, intensity: 0 };
    }

    const rawGlow = Number.isFinite(forgeGlow)
        ? clamp(forgeGlow, 0, 1)
        : clamp(0.68 + Math.min(workingCount, 4) * 0.08, 0, 1);

    if (rawGlow <= FORGE_BANKED_GLOW_THRESHOLD) {
        return { active: false, intensity: 0 };
    }

    return { active: true, intensity: rawGlow };
}

/**
 * Build deterministic volumetric shaft instances for Archive lancet sunbeams
 * and Forge open-bay hearth glow from `sceneState`.
 *
 * Gating guarantees:
 * - Archive emits 0 shafts at night (`daylight <= 0.05` / `sunElevation <= 0.02` / `isNight`)
 *   or under heavy overcast/storm (`cloudCover >= 0.92` / `overcast >= 0.92`).
 * - Forge emits 0 shafts when banked or cold (`forgeBanked`, `forgeCold`, or idle/below threshold).
 * - Every shaft color is clamped strictly to role-0 receiver limits.
 */
export function buildShaftInstances(sceneState = {}) {
    if (!sceneState || sceneState.enabled === false) return [];

    const instances = [];
    const { daylight, sunElevation, sunAzimuth, warmth, nightShare } = resolveDaylightAndSolar(sceneState);
    const cloudCover = clamp(finite(sceneState.cloudCover, finite(sceneState.weather?.cloudCover, 0)), 0, 1);
    const overcast = clamp(finite(sceneState.overcast, 0), 0, 1);
    const weatherClearShare = clamp(1 - Math.max(cloudCover, overcast), 0, 1);

    // 1. Archive lancet sunbeams (gated by solar angle, daylight, and clear enough sky).
    const archiveEnabled = sceneState.archiveEnabled !== false;
    if (archiveEnabled && daylight > 0.05 && sunElevation > 0.02 && weatherClearShare > 0.08) {
        const archiveDef = sceneState.archiveBuilding || findBuildingDef('archive');
        const archiveVisual = BUILDING_VISUAL_REGISTRY.archive;
        if (archiveDef && archiveVisual?.windowRects?.length) {
            const center = tileToWorld(
                finite(archiveDef.x, 3) + finite(archiveDef.width, 5) * 0.5,
                finite(archiveDef.y, 15) + finite(archiveDef.height, 3) * 0.5,
            );
            const [ax, ay] = ARCHIVE_SPRITE_ANCHOR;
            // Solar angle controls beam reach & horizontal slant; lower sun stretches beams further.
            const reachLen = clamp(42 + (1 - clamp(sunElevation, 0.1, 1.1)) * 34, 34, 78);
            const slantX = Math.sin(sunAzimuth) * reachLen * 0.65 + 14;
            const slantY = Math.max(24, Math.cos(sunAzimuth * 0.5) * reachLen * 0.72);
            const baseRgb = [
                SHAFT_PALETTE.archiveNoon[0] + (SHAFT_PALETTE.archiveGolden[0] - SHAFT_PALETTE.archiveNoon[0]) * warmth,
                SHAFT_PALETTE.archiveNoon[1] + (SHAFT_PALETTE.archiveGolden[1] - SHAFT_PALETTE.archiveNoon[1]) * warmth,
                SHAFT_PALETTE.archiveNoon[2] + (SHAFT_PALETTE.archiveGolden[2] - SHAFT_PALETTE.archiveNoon[2]) * warmth,
            ];
            const color = clampReceiverColor(baseRgb);
            const intensity = clamp(daylight * weatherClearShare * (0.68 + 0.32 * warmth), 0, 1);

            for (let i = 0; i < archiveVisual.windowRects.length; i++) {
                const win = archiveVisual.windowRects[i];
                const originX = Math.round(center.x - ax + win.at[0]);
                const originY = Math.round(center.y - ay + win.at[1]);
                // Near-order depth D = Y + H/2 (specs/01 §4): aperture sits just behind the stone lintel.
                const heightAboveGround = Math.max(8, (ay + 30) - win.at[1]);
                const depthOriginD = 2 * (originY + heightAboveGround) + heightAboveGround * 0.5 - 6;
                const depthEndD = 2 * (originY + slantY) + 4;
                const lintelDepthD = depthOriginD + 12;

                instances.push({
                    id: `archive:lancet:${i}`,
                    building: 'archive',
                    kind: SHAFT_KINDS.archive,
                    originX,
                    originY,
                    reachX: Math.round(slantX),
                    reachY: Math.round(slantY),
                    apertureHalfW: Math.max(2.5, finite(win.w, 5) * 0.6),
                    spread: 7,
                    depthOriginD,
                    depthEndD,
                    lintelDepthD,
                    color,
                    maxAlpha: 0.28,
                    intensity,
                    mistGain: 0.25,
                    role: 0,
                    emission: Object.freeze([0, 0, 0, 0]),
                });
            }
        }
    }

    // 2. Forge open-front hearth shafts (gated by active work & dusk/night; strictly zero when banked/cold).
    const forgeEnabled = sceneState.forgeEnabled !== false;
    const forgeGate = resolveForgeGate(sceneState);
    if (forgeEnabled && forgeGate.active) {
        const forgeDef = sceneState.forgeBuilding || findBuildingDef('forge');
        const forgeVisual = BUILDING_VISUAL_REGISTRY.forge;
        if (forgeDef && forgeVisual?.effectAnchors) {
            const center = tileToWorld(
                finite(forgeDef.x, 26) + finite(forgeDef.width, 4) * 0.5,
                finite(forgeDef.y, 26) + finite(forgeDef.height, 3) * 0.5,
            );
            const [fx, fy] = FORGE_SPRITE_ANCHOR;
            const hearth = forgeVisual.effectAnchors.hearth || [73, 162];
            const spill = forgeVisual.effectAnchors.spill || [73, 194];
            const originX = Math.round(center.x - fx + hearth[0]);
            const originY = Math.round(center.y - fy + hearth[1]);
            const reachX = Math.round((spill[0] - hearth[0]) - 22);
            const reachY = Math.round(Math.max(28, spill[1] - hearth[1] + 10));

            // Active Forge shines brightest at dusk/night, still legible during active daytime smithing.
            const nightBoost = 0.45 + 0.55 * nightShare;
            const intensity = clamp(forgeGate.intensity * nightBoost, 0, 1);
            const color = clampReceiverColor(SHAFT_PALETTE.forgeHearth);

            const archHeight = 24;
            const depthOriginD = 2 * (originY + archHeight) + archHeight * 0.5 - 8;
            const depthEndD = 2 * (originY + reachY) + 6;
            const lintelDepthD = depthOriginD + 14;

            instances.push({
                id: 'forge:hearth:open-bay',
                building: 'forge',
                kind: SHAFT_KINDS.forge,
                originX,
                originY,
                reachX,
                reachY,
                apertureHalfW: 8,
                spread: 14,
                depthOriginD,
                depthEndD,
                lintelDepthD,
                color,
                maxAlpha: 0.34,
                intensity,
                mistGain: 0.30,
                role: 0,
                emission: Object.freeze([0, 0, 0, 0]),
            });
        }
    }

    return instances.slice(0, SHAFT_MAX_INSTANCES);
}

/**
 * Pure CPU reference evaluator mirroring `VOLUMETRIC_SHAFTS_WGSL` texel-for-texel.
 * Verifies:
 * - Integer world-texel snapping (`Math.floor(worldX), Math.floor(worldY)`).
 * - Exact slit prism clipping.
 * - Depth-tested lintel / foreground occlusion (`D_lintel > D_shaft` -> occluded).
 * - 8-slice Bayer 4x4 quantization (0/1/2 air courses, zero smooth gradients).
 * - Strict role-0 receiver luminance/saturation ceiling & zero emission.
 */
export function evaluateShaftPixelCpu(shaft, worldX, worldY, {
    sceneDepthD = undefined,
    sceneDepthNdc = undefined,
    mistDensity = 0,
} = {}) {
    const texelX = Math.floor(finite(worldX, 0));
    const texelY = Math.floor(finite(worldY, 0));
    const { rank: bayerRank, threshold: bayerThreshold } = bayer4At(texelX, texelY);

    const makeEmpty = ({ occluded = false, clipped = false, sliceIndex = -1, shaftDepthD = SHAFT_DEPTH_MIN } = {}) => ({
        visible: false,
        occluded,
        clipped,
        texelX,
        texelY,
        sliceIndex,
        quantizedLevel: 0,
        airCourse: 0,
        bayerRank,
        shaftDepthD,
        shaftDepthNdc: encodeShaftDepth(shaftDepthD),
        color: [0, 0, 0],
        alpha: 0,
        emission: [0, 0, 0, 0],
        role: 0,
        linearLuma: 0,
        encodedLuma: 0,
        hsvSaturation: 0,
        hsvValue: 0,
    });

    if (!shaft || !(shaft.intensity > 0.001)) {
        return makeEmpty({ clipped: true });
    }

    const relX = texelX - shaft.originX;
    const relY = texelY - shaft.originY;
    const reachX = finite(shaft.reachX, 0);
    const reachY = finite(shaft.reachY, 1);
    const lenSq = Math.max(reachX * reachX + reachY * reachY, 1);
    const reachLen = Math.sqrt(lenSq);
    const u = (relX * reachX + relY * reachY) / lenSq;
    const v = (-relX * reachY + relY * reachX) / reachLen;
    const halfW = finite(shaft.apertureHalfW, 4) + finite(shaft.spread, 6) * u;

    if (u < 0 || u >= 1 || Math.abs(v) > halfW) {
        return makeEmpty({ clipped: true });
    }

    const sliceIndex = Math.min(SHAFT_TERMINAL_SLICES - 1, Math.max(0, Math.floor(u * SHAFT_TERMINAL_SLICES)));
    const sliceCenter = (sliceIndex + 0.5) / SHAFT_TERMINAL_SLICES;
    const shaftDepthD = shaft.depthOriginD + (shaft.depthEndD - shaft.depthOriginD) * sliceCenter;
    const shaftDepthNdc = encodeShaftDepth(shaftDepthD);

    // Resolve scene occluder depth (lintel, pier, foreground character).
    let resolvedSceneNdc = 1.0;
    if (Number.isFinite(Number(sceneDepthD))) {
        resolvedSceneNdc = encodeShaftDepth(Number(sceneDepthD));
    } else if (Number.isFinite(Number(sceneDepthNdc))) {
        resolvedSceneNdc = clamp(Number(sceneDepthNdc), 0, 1);
    }

    // Closer occluder has larger D -> smaller NDC depth -> clips the shaft cleanly.
    if (resolvedSceneNdc < shaftDepthNdc) {
        return makeEmpty({ occluded: true, clipped: false, sliceIndex, shaftDepthD });
    }

    const longAtten = 1 - sliceIndex / SHAFT_TERMINAL_SLICES;
    const edgeRatio = clamp(1 - Math.abs(v) / Math.max(halfW, 0.5), 0, 1);
    const mistGain = finite(shaft.mistGain, 0.25);
    const mistBoost = 1 + mistGain * clamp(finite(mistDensity, 0), 0, 1);
    const rawEnergy = clamp(shaft.intensity * longAtten * (0.45 + 0.55 * edgeRatio) * mistBoost, 0, 1);

    const quantizedLevel = Math.min(
        SHAFT_TERMINAL_SLICES,
        Math.max(0, Math.floor(rawEnergy * SHAFT_TERMINAL_SLICES + bayerThreshold)),
    );
    if (quantizedLevel === 0) {
        return makeEmpty({ occluded: false, clipped: false, sliceIndex, shaftDepthD });
    }

    const airCourse = quantizedLevel >= 5 ? 2 : 1;
    const courseGain = airCourse === 2 ? 1.0 : 0.84;
    const baseColor = shaft.color || SHAFT_PALETTE.archiveNoon;
    const color = clampReceiverColor([
        baseColor[0] * courseGain,
        baseColor[1] * courseGain,
        baseColor[2] * courseGain,
    ]);
    const alpha = (quantizedLevel / SHAFT_TERMINAL_SLICES) * clamp(finite(shaft.maxAlpha, 0.30), 0, SHAFT_MAX_ALPHA);
    const { s: hsvSaturation, v: hsvValue } = computeHsv(color);

    return {
        visible: true,
        occluded: false,
        clipped: false,
        texelX,
        texelY,
        sliceIndex,
        quantizedLevel,
        airCourse,
        bayerRank,
        shaftDepthD,
        shaftDepthNdc,
        color,
        alpha,
        emission: [0, 0, 0, 0],
        role: 0,
        linearLuma: computeLinearLuma(color),
        encodedLuma: computeEncodedLuma(color),
        hsvSaturation,
        hsvValue,
    };
}

async function compileRenderModule(device, code, label) {
    const module = device.createShaderModule({ label, code });
    const info = await module.getCompilationInfo?.();
    const errors = (info?.messages || []).filter(msg => msg.type === 'error');
    if (errors.length) {
        const detail = errors.slice(0, 6).map(m => `${label}:${m.lineNum}:${m.linePos} ${m.message}`).join('\n');
        throw new Error(`WGSL shaft compilation failed (${errors.length} errors)\n${detail}`);
    }
    return module;
}

function gpuUsage(name, fallback) {
    return globalThis.GPUBufferUsage?.[name] ?? fallback;
}

function texUsage(name, fallback) {
    return globalThis.GPUTextureUsage?.[name] ?? fallback;
}

function stageVertexFragment() {
    const s = globalThis.GPUShaderStage;
    return (s?.VERTEX ?? 1) | (s?.FRAGMENT ?? 2);
}

export class VolumetricShaftsPass {
    constructor({
        depthFormat = 'depth32float',
        colorFormat = SCENE_COLOR_FORMAT,
        emissionFormat = SCENE_EMISSION_FORMAT,
        windBounds = { originX: -1280, originY: -16, width: 2560, height: 1280 },
    } = {}) {
        this.depthFormat = depthFormat;
        this.colorFormat = colorFormat;
        this.emissionFormat = emissionFormat;
        this.windBounds = Object.freeze({ ...windBounds });

        this._device = null;
        this._prepared = false;
        this._layout = null;
        this._pipelineLayout = null;
        this._pipelineMrt = null;
        this._pipelineColorOnly = null;

        this._paramsBuffer = null;
        this._shaftBuffer = null;
        this._fallbackDepthTex = null;
        this._fallbackDepthView = null;
        this._fallbackWindTex = null;
        this._fallbackWindView = null;

        this._paramsViews = createUniformViews(SHAFT_PARAMS_LAYOUT.size);
        this._shaftStaging = new Float32Array(SHAFT_MAX_INSTANCES * SHAFT_INSTANCE_FLOATS);
        this._bindGroupCache = new Map();
        this._viewIds = new WeakMap();
        this._nextViewId = 1;

        this._lastShaftCount = 0;
        this._lastArchiveCount = 0;
        this._lastForgeCount = 0;
        this._drawCalls = 0;
    }

    _idForView(view) {
        if (!view) return 0;
        let id = this._viewIds.get(view);
        if (!id) {
            id = this._nextViewId++;
            this._viewIds.set(view, id);
        }
        return id;
    }

    /** Convenience method mirroring the module-level `buildShaftInstances`. */
    buildShaftInstances(sceneState = {}) {
        return buildShaftInstances(sceneState);
    }

    async prepare(device, {
        depthFormat = this.depthFormat,
        colorFormat = this.colorFormat,
        emissionFormat = this.emissionFormat,
    } = {}) {
        if (!device) throw new Error('VolumetricShaftsPass.prepare requires a GPUDevice');
        this.release();
        this._device = device;
        this.depthFormat = depthFormat;
        this.colorFormat = colorFormat;
        this.emissionFormat = emissionFormat;

        const vf = stageVertexFragment();
        const layout = device.createBindGroupLayout({
            label: 'w5d-shafts-layout',
            entries: [
                {
                    binding: SHAFT_BINDINGS.params,
                    visibility: vf,
                    buffer: { type: 'uniform', minBindingSize: SHAFT_PARAMS_LAYOUT.size },
                },
                {
                    binding: SHAFT_BINDINGS.shafts,
                    visibility: vf,
                    buffer: { type: 'read-only-storage', minBindingSize: SHAFT_INSTANCE_BUFFER_BYTES },
                },
                {
                    binding: SHAFT_BINDINGS.sceneDepth,
                    visibility: vf,
                    texture: { sampleType: 'unfilterable-float', viewDimension: '2d' },
                },
                {
                    binding: SHAFT_BINDINGS.windField,
                    visibility: vf,
                    texture: { sampleType: 'float', viewDimension: '2d' },
                },
            ],
        });
        const pipelineLayout = device.createPipelineLayout({
            label: 'w5d-shafts-pipeline-layout',
            bindGroupLayouts: [layout],
        });

        const module = await compileRenderModule(device, VOLUMETRIC_SHAFTS_WGSL, 'w5d-volumetric-shafts.wgsl');
        const depthStencil = {
            format: this.depthFormat,
            depthWriteEnabled: false,
            depthCompare: 'less-equal',
        };
        const [pipelineMrt, pipelineColorOnly] = await Promise.all([
            device.createRenderPipelineAsync({
                label: 'w5d-shafts-mrt',
                layout: pipelineLayout,
                vertex: { module, entryPoint: 'shaftVs' },
                primitive: { topology: 'triangle-list', cullMode: 'none' },
                depthStencil,
                fragment: {
                    module,
                    entryPoint: 'shaftFs',
                    targets: [
                        { format: this.colorFormat, blend: BLEND_NORMAL },
                        { format: this.emissionFormat, blend: BLEND_NORMAL },
                    ],
                },
            }),
            device.createRenderPipelineAsync({
                label: 'w5d-shafts-color',
                layout: pipelineLayout,
                vertex: { module, entryPoint: 'shaftVs' },
                primitive: { topology: 'triangle-list', cullMode: 'none' },
                depthStencil,
                fragment: {
                    module,
                    entryPoint: 'shaftColorFs',
                    targets: [
                        { format: this.colorFormat, blend: BLEND_NORMAL },
                    ],
                },
            }),
        ]);

        const paramsBuffer = device.createBuffer({
            label: 'w5d-shafts-params',
            size: SHAFT_PARAMS_LAYOUT.size,
            usage: gpuUsage('UNIFORM', 64) | gpuUsage('COPY_DST', 8),
        });
        const shaftBuffer = device.createBuffer({
            label: 'w5d-shafts-instances',
            size: SHAFT_INSTANCE_BUFFER_BYTES,
            usage: gpuUsage('STORAGE', 128) | gpuUsage('COPY_DST', 8),
        });

        const tUsage = texUsage('TEXTURE_BINDING', 4) | texUsage('COPY_DST', 2);
        const fallbackDepthTex = device.createTexture({
            label: 'w5d-shafts-fallback-depth',
            size: [1, 1],
            format: 'r32float',
            usage: tUsage,
        });
        device.queue.writeTexture(
            { texture: fallbackDepthTex },
            new Float32Array([1.0]),
            { offset: 0, bytesPerRow: 4, rowsPerImage: 1 },
            { width: 1, height: 1, depthOrArrayLayers: 1 },
        );
        const fallbackWindTex = device.createTexture({
            label: 'w5d-shafts-fallback-wind',
            size: [1, 1],
            format: 'rgba8unorm',
            usage: tUsage,
        });
        device.queue.writeTexture(
            { texture: fallbackWindTex },
            new Uint8Array([0, 0, 0, 0]),
            { offset: 0, bytesPerRow: 4, rowsPerImage: 1 },
            { width: 1, height: 1, depthOrArrayLayers: 1 },
        );

        this._layout = layout;
        this._pipelineLayout = pipelineLayout;
        this._pipelineMrt = pipelineMrt;
        this._pipelineColorOnly = pipelineColorOnly;
        this._paramsBuffer = paramsBuffer;
        this._shaftBuffer = shaftBuffer;
        this._fallbackDepthTex = fallbackDepthTex;
        this._fallbackDepthView = fallbackDepthTex.createView();
        this._fallbackWindTex = fallbackWindTex;
        this._fallbackWindView = fallbackWindTex.createView();
        this._bindGroupCache.clear();
        this._prepared = true;

        return this.getDiagnostics();
    }

    _getBindGroup(sceneDepthView, windFieldView) {
        const dView = sceneDepthView || this._fallbackDepthView;
        const wView = windFieldView || this._fallbackWindView;
        const key = `${this._idForView(dView)}:${this._idForView(wView)}`;
        let group = this._bindGroupCache.get(key);
        if (!group) {
            if (this._bindGroupCache.size >= 8) this._bindGroupCache.clear();
            group = this._device.createBindGroup({
                label: `w5d-shafts-bg-${key}`,
                layout: this._layout,
                entries: [
                    { binding: SHAFT_BINDINGS.params, resource: { buffer: this._paramsBuffer } },
                    { binding: SHAFT_BINDINGS.shafts, resource: { buffer: this._shaftBuffer } },
                    { binding: SHAFT_BINDINGS.sceneDepth, resource: dView },
                    { binding: SHAFT_BINDINGS.windField, resource: wView },
                ],
            });
            this._bindGroupCache.set(key, group);
        }
        return group;
    }

    _stageInstances(instances) {
        const count = Math.min(instances.length, SHAFT_MAX_INSTANCES);
        let archiveCount = 0;
        let forgeCount = 0;
        for (let i = 0; i < count; i++) {
            const s = instances[i];
            const clamped = clampReceiverColor(s.color || SHAFT_PALETTE.archiveNoon);
            const off = i * SHAFT_INSTANCE_FLOATS;
            this._shaftStaging[off] = finite(s.originX, 0);
            this._shaftStaging[off + 1] = finite(s.originY, 0);
            this._shaftStaging[off + 2] = finite(s.reachX, 0);
            this._shaftStaging[off + 3] = finite(s.reachY, 1);

            this._shaftStaging[off + 4] = finite(s.apertureHalfW, 4);
            this._shaftStaging[off + 5] = finite(s.spread, 6);
            this._shaftStaging[off + 6] = finite(s.depthOriginD, 0);
            this._shaftStaging[off + 7] = finite(s.depthEndD, 0);

            this._shaftStaging[off + 8] = clamped[0];
            this._shaftStaging[off + 9] = clamped[1];
            this._shaftStaging[off + 10] = clamped[2];
            this._shaftStaging[off + 11] = clamp(finite(s.maxAlpha, 0.30), 0, SHAFT_MAX_ALPHA);

            this._shaftStaging[off + 12] = clamp(finite(s.intensity, 0), 0, 1);
            this._shaftStaging[off + 13] = finite(s.kind, SHAFT_KINDS.archive);
            this._shaftStaging[off + 14] = 0;
            this._shaftStaging[off + 15] = finite(s.mistGain, 0.25);

            this._shaftStaging[off + 16] = 0;
            this._shaftStaging[off + 17] = 0;
            this._shaftStaging[off + 18] = 0;
            this._shaftStaging[off + 19] = 0;

            if (s.kind === SHAFT_KINDS.archive) archiveCount++;
            else if (s.kind === SHAFT_KINDS.forge) forgeCount++;
        }
        this._lastShaftCount = count;
        this._lastArchiveCount = archiveCount;
        this._lastForgeCount = forgeCount;
        return count;
    }

    /**
     * Encode depth-tested volumetric shafts onto either an active
     * `GPURenderPassEncoder` or a `GPUCommandEncoder` (when target views are given).
     */
    encode(passOrEncoder, {
        sceneState = null,
        shafts = null,
        cameraXy = [0, 0],
        resolution = [1920, 1080],
        cameraScale = 1,
        timeSec = 0,
        glRows = true,
        reducedMotion = false,
        enabled = true,
        hasEmissionAttachment = true,
        sceneDepthView = null,
        windFieldView = null,
        colorView = null,
        emissionView = null,
        depthView = null,
        timestampWrites = undefined,
    } = {}) {
        if (!this._prepared || !passOrEncoder || !enabled) {
            this._lastShaftCount = 0;
            this._lastArchiveCount = 0;
            this._lastForgeCount = 0;
            return { drawnShafts: 0, archiveShafts: 0, forgeShafts: 0 };
        }

        const instances = Array.isArray(shafts) ? shafts : this.buildShaftInstances(sceneState || {});
        const count = this._stageInstances(instances);
        if (count === 0) {
            return { drawnShafts: 0, archiveShafts: 0, forgeShafts: 0 };
        }

        const flags = (glRows ? 1 : 0)
            | (sceneDepthView ? 2 : 0)
            | (windFieldView ? 4 : 0)
            | (reducedMotion ? 8 : 0);

        writeUniforms(SHAFT_PARAMS_LAYOUT, this._paramsViews, {
            cameraXy: [finite(cameraXy?.[0], 0), finite(cameraXy?.[1], 0)],
            resolution: [Math.max(1, finite(resolution?.[0], 1920)), Math.max(1, finite(resolution?.[1], 1080))],
            depthRange: SHAFT_DEPTH_RANGE,
            windBounds: [this.windBounds.originX, this.windBounds.originY, this.windBounds.width, this.windBounds.height],
            cameraScale: Math.max(0.01, finite(cameraScale, 1)),
            timeSec: finite(timeSec, 0),
            shaftCount: count,
            flags,
        }, 0);

        this._device.queue.writeBuffer(this._paramsBuffer, 0, this._paramsViews.buffer);
        this._device.queue.writeBuffer(this._shaftBuffer, 0, this._shaftStaging, 0, count * SHAFT_INSTANCE_FLOATS);

        const useMrt = hasEmissionAttachment && (typeof passOrEncoder.beginRenderPass !== 'function' || Boolean(emissionView));
        const pipeline = useMrt ? this._pipelineMrt : this._pipelineColorOnly;
        const bindGroup = this._getBindGroup(sceneDepthView, windFieldView);

        if (typeof passOrEncoder.beginRenderPass === 'function') {
            if (!colorView || !depthView) {
                throw new Error('VolumetricShaftsPass.encode with GPUCommandEncoder requires colorView and depthView');
            }
            const colorAttachments = [
                { view: colorView, loadOp: 'load', storeOp: 'store' },
                ...(useMrt ? [{ view: emissionView, loadOp: 'load', storeOp: 'store' }] : []),
            ];
            const pass = passOrEncoder.beginRenderPass({
                label: 'w5d-volumetric-shafts',
                colorAttachments,
                depthStencilAttachment: {
                    view: depthView,
                    depthReadOnly: true,
                },
                ...(timestampWrites ? { timestampWrites } : {}),
            });
            pass.setPipeline(pipeline);
            pass.setBindGroup(0, bindGroup);
            pass.draw(6, count, 0, 0);
            pass.end();
        } else {
            passOrEncoder.setPipeline(pipeline);
            passOrEncoder.setBindGroup(0, bindGroup);
            passOrEncoder.draw(6, count, 0, 0);
        }

        this._drawCalls++;
        return {
            drawnShafts: count,
            archiveShafts: this._lastArchiveCount,
            forgeShafts: this._lastForgeCount,
        };
    }

    release() {
        this._paramsBuffer?.destroy?.();
        this._shaftBuffer?.destroy?.();
        this._fallbackDepthTex?.destroy?.();
        this._fallbackWindTex?.destroy?.();
        this._bindGroupCache.clear();

        this._device = null;
        this._prepared = false;
        this._layout = null;
        this._pipelineLayout = null;
        this._pipelineMrt = null;
        this._pipelineColorOnly = null;
        this._paramsBuffer = null;
        this._shaftBuffer = null;
        this._fallbackDepthTex = null;
        this._fallbackDepthView = null;
        this._fallbackWindTex = null;
        this._fallbackWindView = null;
    }

    getDiagnostics() {
        const uniforms = SHAFT_PARAMS_LAYOUT.size;
        const instances = SHAFT_INSTANCE_BUFFER_BYTES;
        const fallbackTextures = 8;
        return {
            ready: this._prepared,
            terminalSlices: SHAFT_TERMINAL_SLICES,
            depthRange: [...SHAFT_DEPTH_RANGE],
            frontierMaskBit: SHAFT_FRONTIER_MASK_BIT,
            depthFormat: this.depthFormat,
            colorFormat: this.colorFormat,
            emissionFormat: this.emissionFormat,
            role: 0,
            receiverLimits: {
                maxLinearLuma: SHAFT_RECEIVER_MAX_LINEAR_LUMA,
                maxEncodedLuma: SHAFT_RECEIVER_MAX_ENCODED_LUMA,
                maxHsvSat: SHAFT_RECEIVER_MAX_HSV_SAT,
            },
            lastShaftCount: this._lastShaftCount,
            lastArchiveCount: this._lastArchiveCount,
            lastForgeCount: this._lastForgeCount,
            drawCalls: this._drawCalls,
            memoryBytes: {
                uniforms,
                instances,
                fallbackTextures,
                total: uniforms + instances + fallbackTextures,
            },
        };
    }
}

export function createVolumetricShaftsPass(options = {}) {
    return new VolumetricShaftsPass(options);
}
