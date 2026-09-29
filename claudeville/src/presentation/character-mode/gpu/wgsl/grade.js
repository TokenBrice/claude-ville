// Wave 10 — GRADE_WGSL, the WebGPU twin of GpuWorldPolicy GRADE_GLSL (C2 grade,
// V6 water cap, 1.2 stepped pools, V5 receiver knee and ceilings, vignette).
// Expression for expression the GLSL; every shared number is interpolated from
// the same GRADE_CONSTANTS table through the same `gradeLiteral` formatter, so
// the two dialects carry identical literals. GLSL's `1.0 / 3.0` and `2.4`
// spellings are kept on purpose (same constant folding in both compilers).
// Uniforms come from the frame block (wgsl/common.js FrameUniforms):
// u_gradeX -> frame.gradeX, u_edgeAlpha -> frame.edgeAlpha, u_poolGain ->
// frame.poolGain. GLSL `out` parameters are `ptr<function, f32>`.
import { GRADE_CONSTANTS, gradeLiteral } from '../GpuWorldPolicy.js';

/** GRADE_WGSL from a constants table (the shipped one is `GRADE_CONSTANTS`). */
export function gradeWgsl(constants = GRADE_CONSTANTS) {
    const k = name => gradeLiteral(constants, name);
    return /* wgsl */ `
const GRADE_LUMA: vec3f = vec3f(0.2126, 0.7152, 0.0722);

fn applyTimeGrade(albedo: vec3f, lift: bool) -> vec3f {
    let lin = dot(albedo, GRADE_LUMA);
    var c = mix(vec3f(lin) * frame.gradePurkinje, albedo, frame.gradeSaturation);
    c = max(c, vec3f(0.0)) * frame.gradeGain * frame.gradeExposure;
    if (lift) { c = frame.gradeLift + c * (1.0 - frame.gradeLift); }
    c = pow(max(c, vec3f(0.0)), frame.gradeGamma);
    let sh = 1.0 - smoothstep(0.06, 0.42, lin);
    let hi = smoothstep(0.38, 0.82, lin);
    c *= mix(mix(vec3f(1.0), frame.gradeShadow, sh), frame.gradeHighlight, hi);
    return c / max(1.0, max(c.r, max(c.g, c.b)));
}

const WATER_MAX_SATURATION: f32 = ${k('WATER_MAX_SATURATION')};
fn capSaturation(c: vec3f, maxS: f32) -> vec3f {
    let hi = max(c.r, max(c.g, c.b));
    let spread = hi - min(c.r, min(c.g, c.b));
    if (hi <= 0.0 || spread <= maxS * hi) { return c; }
    let y = dot(c, GRADE_LUMA);
    let k = clamp(maxS * y / max(1e-6, spread - maxS * (hi - y)), 0.0, 1.0);
    return y + (c - y) * k;
}

fn poolSteps(shape: f32, order: f32) -> f32 {
    let q = shape + (order - 0.5) * 0.08;
    return step(0.12, q) + step(0.40, q) + step(0.75, q);
}

fn poolWeight(steps: f32) -> f32 {
    if (steps < 0.5) { return 0.0; }
    if (steps < 1.5) { return 0.30; }
    if (steps < 2.5) { return 0.54; }
    return 0.76;
}

const POOL_RIM: vec3f = vec3f(${k('POOL_RIM')});
const POOL_MID: vec3f = vec3f(${k('POOL_MID')});
const POOL_CORE: vec3f = vec3f(${k('POOL_CORE')});
fn poolTint(light: vec3f, steps: f32, strength: ptr<function, f32>, warm: ptr<function, f32>) -> vec3f {
    let l = dot(light, GRADE_LUMA);
    let hue = light / l;
    *warm = clamp((hue.r - hue.b) * 1.25, 0.0, 1.0);
    *strength = min(l, 1.0);
    var ramp = POOL_CORE;
    if (steps < 1.5) { ramp = POOL_RIM; } else if (steps < 2.5) { ramp = POOL_MID; }
    return mix(mix(vec3f(1.0), hue, 0.7), ramp, *warm);
}

const LAND_RIM: vec3f = POOL_RIM;
const LAND_MID: vec3f = vec3f(${k('LAND_MID')});
const LAND_CORE: vec3f = POOL_MID;
const LAND_SHARE: vec3f = vec3f(${k('LAND_SHARE')});
const LAND_FULL_STRENGTH: f32 = ${k('LAND_FULL_STRENGTH')};
fn onStop(stop: vec3f, y: f32) -> vec3f {
    let c = stop * y;
    let hi = max(c.r, max(c.g, c.b));
    if (hi > 1.0) { return y + (c - y) * ((1.0 - y) / (hi - y)); }
    return c;
}

const RECEIVER_LUMA_CEILING: f32 = ${k('RECEIVER_LUMA_CEILING')};
const RECEIVER_HEADROOM: f32 = ${k('RECEIVER_HEADROOM')};
fn kneeValue(lit: vec3f, y: f32, ceilY: f32) -> vec3f {
    let kneed = ceilY + RECEIVER_HEADROOM * (1.0 - exp(-(y - ceilY) * 0.25 / RECEIVER_HEADROOM));
    let chroma = lit - y;
    let lo = min(chroma.r, min(chroma.g, chroma.b));
    let hi = max(chroma.r, max(chroma.g, chroma.b));
    var fit = 1.0;
    if (lo < 0.0) { fit = min(fit, kneed / -lo); }
    if (hi > 0.0) { fit = min(fit, (1.0 - kneed) / hi); }
    return kneed + chroma * fit;
}
fn lumaKnee(lit: vec3f, floorLuma: f32) -> vec3f {
    let y = dot(lit, GRADE_LUMA);
    let ceilY = max(RECEIVER_LUMA_CEILING, floorLuma);
    if (y <= ceilY) { return lit; }
    return kneeValue(lit, y, ceilY);
}
const RECEIVER_OKL_CEILING: f32 = ${k('RECEIVER_OKL_CEILING')};
const ATTENTION_OKL_CEILING: f32 = ${k('ATTENTION_OKL_CEILING')};
fn decodeSrgb(c0: vec3f) -> vec3f {
    let c = max(c0, vec3f(0.0));
    return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3f(2.4)), step(vec3f(0.04045), c));
}
fn encodeSrgb(l0: vec3f) -> vec3f {
    let l = max(l0, vec3f(0.0));
    return mix(l * 12.92, 1.055 * pow(l, vec3f(1.0 / 2.4)) - 0.055, step(vec3f(0.0031308), l));
}
fn okLightness(lin: vec3f) -> f32 {
    var lms = vec3f(
        dot(lin, vec3f(0.4122214708, 0.5363325363, 0.0514459929)),
        dot(lin, vec3f(0.2119034982, 0.6806995451, 0.1073969566)),
        dot(lin, vec3f(0.0883024619, 0.2817188376, 0.6299787005))
    );
    lms = pow(max(lms, vec3f(0.0)), vec3f(1.0 / 3.0));
    return dot(lms, vec3f(0.2104542553, 0.7936177850, -0.0040720468));
}
fn okCeiling(lit: vec3f, floorColour: vec3f, ceilL: f32) -> vec3f {
    if (max(lit.r, max(lit.g, lit.b)) <= 0.74) { return lit; }
    let lin = decodeSrgb(lit);
    let l = okLightness(lin);
    if (l <= ceilL) { return lit; }
    let floorL = max(ceilL, okLightness(decodeSrgb(floorColour)));
    if (l <= floorL) { return lit; }
    let k = floorL / l;
    return encodeSrgb(lin * (k * k * k));
}
fn receiverKnee(lit: vec3f, floorLuma: f32) -> vec3f {
    return okCeiling(lumaKnee(lit, floorLuma), vec3f(floorLuma), RECEIVER_OKL_CEILING);
}

fn stepPool(graded: vec3f, ambient: vec3f, ambientSteps: f32, attention: vec3f, attentionSteps: f32, albedo: vec3f, reflection: vec3f, land: f32) -> vec3f {
    let lit = ambientSteps > 0.5 && dot(ambient, GRADE_LUMA) > 0.01;
    let marked = attentionSteps > 0.5 && dot(attention, GRADE_LUMA) > 0.01;
    if (!lit && !marked && all(reflection == vec3f(0.0))) { return graded; }
    let gradedLuma = dot(graded, GRADE_LUMA);
    let base = mix(vec3f(dot(albedo, GRADE_LUMA)), albedo, 0.55);
    let carry = clamp((frame.poolGain - 0.15) / 1.05, 0.0, 1.0);
    var strength: f32;
    var warm: f32;
    var landWarm = 0.0;
    var result = graded;
    var add = reflection;
    if (lit) {
        let tint = poolTint(ambient, ambientSteps, &strength, &warm);
        let pool = tint * strength;
        let adapt = min(1.0, strength * 1.5) * warm * (0.85 * 0.6) * carry * land;
        result = mix(graded, gradedLuma * tint, adapt);
        add += base * pool * frame.poolGain + pool * 0.035 * frame.poolGain;
        landWarm = warm;
    }
    result = lumaKnee(result + add, gradedLuma);
    if (landWarm > 0.0) {
        let y = dot(result, GRADE_LUMA);
        var share = clamp((y - gradedLuma) / max(y, 0.02) * 1.6, 0.0, 1.0);
        var stop = LAND_CORE;
        if (ambientSteps < 1.5) { stop = LAND_RIM; } else if (ambientSteps < 2.5) { stop = LAND_MID; }
        var course = LAND_SHARE.z;
        if (ambientSteps < 1.5) { course = LAND_SHARE.x; } else if (ambientSteps < 2.5) { course = LAND_SHARE.y; }
        share = max(share, min(1.0, strength / LAND_FULL_STRENGTH));
        result = mix(result, onStop(stop, y), landWarm * share * course * land);
    }
    result = okCeiling(result, graded, RECEIVER_OKL_CEILING);
    if (marked) {
        let tint = poolTint(attention, attentionSteps, &strength, &warm);
        let pool = tint * strength;
        if (!lit) {
            let adapt = min(1.0, strength * 1.5) * warm * (0.85 * 0.6) * carry;
            result = mix(result, dot(result, GRADE_LUMA) * tint, adapt);
        }
        result += base * pool * frame.poolGain + pool * 0.035 * frame.poolGain;
        let y = dot(result, GRADE_LUMA);
        let ceilY = max(RECEIVER_LUMA_CEILING + RECEIVER_HEADROOM, gradedLuma);
        if (y > ceilY) { result = kneeValue(result, y, ceilY); }
        result = okCeiling(result, graded, ATTENTION_OKL_CEILING);
    }
    return result;
}

fn applyGradeVignette(color: vec3f, topLeftPx: vec2f, resolution: vec2f) -> vec3f {
    let centre = vec2f(resolution.x * 0.5, resolution.y * 0.46);
    let inner = min(resolution.x, resolution.y) * 0.18;
    let outer = max(resolution.x, resolution.y) * 0.72;
    let t = clamp((distance(topLeftPx, centre) - inner) / max(1.0, outer - inner), 0.0, 1.0);
    let edge = frame.edgeAlpha * (step(0.62, t) * 0.4 + step(0.84, t) * 0.6);
    return color * mix(vec3f(1.0), frame.gradeEdge, edge);
}
`;
}

export const GRADE_WGSL = gradeWgsl();
