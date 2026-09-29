// Wave 10 (10.1 Stage A) — the WGSL twin of SEA_SWELL_GLSL's hash and its
// smooth world fields (GpuWorldRenderer SEA_SWELL_GLSL): `waterHash12`, the
// water Bayer, the open sea's depth-stop seams (`seaSeamRows`, whose exact CPU
// twin is CoastBake seaSeamRowsAt) and the long swell contours
// (`seaContourRows`). These are the float32-sensitive fields: every step is
// spelled as the GLSL spells it (the same builtins, the same operand order,
// the same literals), because a rounding difference moves a seam by a whole
// world row. Literal-only subexpressions carry an `f` suffix so WGSL folds
// them in f32 as ANGLE does (an abstract-float fold could land one ulp away).
// Shared by the scene and composite modules; no bindings.
import { OCEAN_HORIZON_WORLD_Y, SEA_SEAM_BAND, SEA_SEAM_OCTAVES, SEA_SEAM_PERIOD, SEA_SEAM_ROWS } from '../../CoastBake.js';
import { SEA_CONTOUR_CELL, SEA_CONTOUR_ROWS } from '../GpuWorldRenderer.js';

export const SEAM_WGSL = /* wgsl */ `
fn waterHash12(p: vec2f) -> f32 {
    var p3 = fract(vec3f(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
}
fn waterBayer2(a0: vec2f) -> f32 {
    let a = floor(a0);
    return fract(dot(a, vec2f(0.5, a.y * 0.75)));
}
fn waterBayer4(p: vec2f) -> f32 {
    return waterBayer2(0.5 * p) * 0.25 + waterBayer2(p);
}
const OPEN_SEA_HORIZON_Y: f32 = ${OCEAN_HORIZON_WORLD_Y.toFixed(1)};
fn seaSeamLattice(k: f32, salt: f32) -> f32 {
    var h = (u32(i32(k)) * 1597334677u) ^ (u32(i32(salt) + 4096) * 3812015801u);
    h = (h ^ (h >> 16u)) * 2246822519u;
    h ^= h >> 13u;
    return f32(h >> 8u) / 16777216.0;
}
fn seaSeamOctave(x: f32, lx: f32, salt: f32) -> f32 {
    let cells = ${SEA_SEAM_PERIOD.toFixed(1)} / lx;
    let k = floor(x / lx);
    let f = (x - k * lx) / lx;
    let s = f * f * (3.0 - 2.0 * f);
    let k0 = k - floor(k / cells) * cells;
    let k1 = select(0.0, k0 + 1.0, k0 + 1.0 < cells);
    let a = seaSeamLattice(k0, salt);
    let b = seaSeamLattice(k1, salt);
    return a + (b - a) * s;
}
fn seaSeamRows(cell: vec2f) -> f32 {
    let t = cell.y - OPEN_SEA_HORIZON_Y;
    if (t < ${SEA_SEAM_BAND.toFixed(1)}f * 0.5f || t >= ${SEA_SEAM_BAND.toFixed(1)}f * 3.5f) { return 0.0; }
    let band = floor((t + ${SEA_SEAM_BAND.toFixed(1)}f * 0.5f) / ${SEA_SEAM_BAND.toFixed(1)});
    let n = seaSeamOctave(cell.x, ${SEA_SEAM_OCTAVES[0].toFixed(1)}, band * 2.0) * 0.7
        + seaSeamOctave(cell.x, ${SEA_SEAM_OCTAVES[1].toFixed(1)}, band * 2.0 + 1.0) * 0.3;
    return floor((n - 0.5) * 2.0 * ${SEA_SEAM_ROWS.toFixed(1)} + 0.5);
}
fn seaNoise(q: vec2f) -> f32 {
    let i = floor(q);
    var f = q - i;
    f = f * f * (3.0 - 2.0 * f);
    let a = waterHash12(i + vec2f(71.0, 13.0));
    let b = waterHash12(i + vec2f(72.0, 13.0));
    let c = waterHash12(i + vec2f(71.0, 14.0));
    let d = waterHash12(i + vec2f(72.0, 14.0));
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
fn seaContourRows(cell: vec2f) -> f32 {
    let n = seaNoise(cell / vec2f(${SEA_CONTOUR_CELL[0].toFixed(1)}, ${SEA_CONTOUR_CELL[1].toFixed(1)})) * 0.7
        + seaNoise(cell / vec2f(${(SEA_CONTOUR_CELL[0] * 0.29).toFixed(1)}, ${(SEA_CONTOUR_CELL[1] * 0.36).toFixed(1)}) + vec2f(17.0, 5.0)) * 0.3;
    return floor((n - 0.5) * 2.0 * ${SEA_CONTOUR_ROWS.toFixed(1)} + 0.5);
}
`;
