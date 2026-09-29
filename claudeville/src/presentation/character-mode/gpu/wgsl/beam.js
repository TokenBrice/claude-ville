// Wave 10 (10.1 Stage A) — the WGSL twin of GpuWorldRenderer
// LIGHTHOUSE_BEAM_GLSL (2.7, the bi-form lens fans on the sea): the same dash
// cells, courses, Bayer edge and sheen step, the stops interpolated from
// ART_RAMPS.lampBeam with the same formatting (four decimals). u_beamGround /
// u_beamShape / u_beamCourseEnds / u_beamCourseShares -> frame.*. Shared by
// the scene (applyWaterState) and the composite (shadeOpenSea). Needs
// waterHash12 (wgsl/seam.js) and glslMod (wgsl/common.js).
import { ART_RAMPS } from '../../../../config/artPalette.js';

function lampBeamStop(index) {
    const hex = ART_RAMPS.lampBeam[index];
    return `vec3f(${[1, 3, 5].map(at => (parseInt(hex.slice(at, at + 2), 16) / 255).toFixed(4)).join(', ')})`;
}

export const BEAM_WGSL = /* wgsl */ `
const BEAM_STOPS = array<vec3f, 3>(${lampBeamStop(0)}, ${lampBeamStop(0)}, ${lampBeamStop(1)});
fn beamBayer2(p: vec2f) -> f32 {
    let fp = floor(p);
    let q = fp - 2.0 * floor(fp / 2.0);
    if (q.x == q.y) { return select(0.0, 0.25, q.x > 0.5); }
    return select(0.75, 0.5, q.x > 0.5);
}
fn beamBayer4(p: vec2f) -> f32 {
    return beamBayer2(0.5 * p) * 0.25 + beamBayer2(p);
}
// Set by the scene's applyWaterState when this fragment is a beam-lit dash,
// so the scene keeps its colour through the night grade.
var<private> lighthouseDash: bool = false;
fn lighthouseFan(g: vec2f, dir: vec2f, order: f32, cell: vec2f) -> f32 {
    let along = dot(g, dir);
    let t = (along + order * 12.0) / frame.beamShape.x;
    if (t <= 0.0 || t >= frame.beamCourseEnds.z) { return 0.0; }
    let halfWidth = mix(frame.beamShape.y, frame.beamShape.z, clamp(along / frame.beamShape.x, 0.0, 1.0));
    if (abs(dot(g, vec2f(-dir.y, dir.x))) + order * 6.0 >= halfWidth) { return 0.0; }
    var course = 0.0;
    if (t < frame.beamCourseEnds.x) { course = 2.0; } else if (t < frame.beamCourseEnds.y) { course = 1.0; }
    var share: f32;
    if (course > 1.5) {
        share = frame.beamCourseShares.x;
    } else if (course > 0.5) {
        share = frame.beamCourseShares.y;
    } else {
        share = frame.beamCourseShares.z * clamp((frame.beamCourseEnds.z - t) / max(0.01, frame.beamCourseEnds.z - frame.beamCourseEnds.y), 0.0, 1.0);
    }
    if (waterHash12(cell + vec2f(83.0, 19.0)) >= share) { return 0.0; }
    let sheen = select(0.0, 1.0, glslMod(floor(along / 16.0) - frame.beamShape.w, 3.0) < 0.5);
    return 1.0 + min(2.0, course + sheen);
}
fn lighthouseSheen(p: vec2f) -> f32 {
    if (frame.beamGround.w <= 0.0) { return 0.0; }
    let cell = floor(p / vec2f(3.0, 1.0));
    let d = cell * vec2f(3.0, 1.0) + vec2f(1.5, 0.5) - frame.beamGround.xy;
    let g = vec2f(d.x, d.y * 2.0);
    let dir = vec2f(cos(frame.beamGround.z), sin(frame.beamGround.z));
    let order = beamBayer4(cell) - 0.5;
    return max(lighthouseFan(g, dir, order, cell), lighthouseFan(g, -dir, order, cell));
}
fn lighthouseStop(beam: f32) -> vec3f {
    return BEAM_STOPS[i32(clamp(beam - 1.0, 0.0, 2.0))];
}
`;
