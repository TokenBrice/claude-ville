// WGSL twin of LIGHTHOUSE_BEAM_GLSL: one warm cone beyond the air shaft's
// sea landing. Only existing crest/swell texels catch the mirror fire.
import { ART_RAMPS } from '../../../../config/artPalette.js';
import { DEEP_DASH_DENSITY } from '../GpuFrameState.js';

function beaconFireStop(index) {
    const hex = ART_RAMPS.beaconFire[index];
    return `vec3f(${[1, 3, 5].map(at => (parseInt(hex.slice(at, at + 2), 16) / 255).toFixed(4)).join(', ')})`;
}

export const BEAM_WGSL = /* wgsl */ `
const BEACON_WATER_STOPS = array<vec3f, 3>(${beaconFireStop(0)}, ${beaconFireStop(1)}, ${beaconFireStop(2)});
fn beamBayer2(p: vec2f) -> f32 {
    let fp = floor(p);
    let q = fp - 2.0 * floor(fp / 2.0);
    if (q.x == q.y) { return select(0.0, 0.25, q.x > 0.5); }
    return select(0.75, 0.5, q.x > 0.5);
}
fn beamBayer4(p: vec2f) -> f32 {
    return beamBayer2(0.5 * p) * 0.25 + beamBayer2(p);
}
var<private> lighthouseDash: bool = false;
fn lighthouseFan(g: vec2f, dir: vec2f, order: f32, cell: vec2f) -> f32 {
    let along = dot(g, dir);
    let t = (along + order * 12.0) / frame.beamShape.x;
    if (along <= 0.0 || t >= frame.beamCourseEnds.z) { return 0.0; }
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
fn lighthouseSheen(p: vec2f, tick: f32, storm: f32) -> f32 {
    if (frame.beamGround.w <= 0.0) { return 0.0; }
    let cell = floor(p);
    let d = cell + 0.5 - frame.beamGround.xy;
    let g = vec2f(d.x, d.y * 2.0);
    let dir = vec2f(cos(frame.beamGround.z), sin(frame.beamGround.z));
    let order = beamBayer4(cell) - 0.5;
    let beam = lighthouseFan(g, dir, order, cell);
    if (beam <= 0.0) { return 0.0; }
    let crest = swellCrest(cell, swellPhase(cell));
    let wave = deepSwellLit(cell, tick, storm, ${DEEP_DASH_DENSITY.toFixed(2)});
    return select(0.0, beam, max(crest, wave) > 0.5);
}
fn beaconWaterStop(beam: f32) -> vec3f {
    return BEACON_WATER_STOPS[i32(clamp(beam - 1.0, 0.0, 2.0))];
}
`;
