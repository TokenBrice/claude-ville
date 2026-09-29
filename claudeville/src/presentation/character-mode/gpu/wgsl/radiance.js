// Wave 10 (10.1 Stage A, S3) — the WGSL twin of GroundRadiance
// RADIANCE_SCENE_GLSL: the scene pass's reader of the 2.10 ground radiance
// field (`radianceAt`, `radianceShape`), its grid and display constants
// interpolated from GroundRadiance. u_radiance -> radianceTex/radianceSampler
// (linear clamp, level 0), u_radianceGrid / u_radianceGain /
// u_radianceStrength -> frame.*.
//
// Only the reader is ported. The GroundRadiance solve (its own multi-pass
// targets) is a declared exclusion on WebGPU: the backend binds a 1x1 stand-in
// with frame.radianceGrid.w = 0, so the scene's `radianceGrid.w > 0.5` gate
// never reads it, and diagnostics report `radianceBounce: false`. 2.10 is off
// at every ladder level (EFFECT_BUDGET['radiance-bounce']), so no shipped
// frame differs; the pilot cannot be turned on under WebGPU until the solve
// is ported.
import {
    radianceGrid,
    RADIANCE_CONTRAST,
    RADIANCE_LAND,
    RADIANCE_WALL_OFFSET,
    RADIANCE_WALL_REACH,
} from '../GroundRadiance.js';

const GRID = radianceGrid();

export const RADIANCE_WGSL = /* wgsl */ `
const RADIANCE_LAND: f32 = ${RADIANCE_LAND.toFixed(2)};
fn radianceAt(world: vec2f, panel: i32) -> vec4f {
    let size = vec2f(${GRID.probesX}.0, ${GRID.probesY}.0);
    let p = clamp((vec2f(world.x, world.y * 2.0) - frame.radianceGrid.xy) / frame.radianceGrid.z, vec2f(0.5), size - 0.5);
    return textureSampleLevel(radianceTex, radianceSampler, vec2f((f32(panel) * size.x + p.x) / (size.x * 3.0), p.y / size.y), 0.0);
}
fn radianceShape(foot: vec2f, normal: vec2f, height: f32, wall: bool, light: ptr<function, vec3f>) -> f32 {
    var panel = 0;
    if (wall) { panel = select(2, 1, normal.x < 0.0); }
    var at = foot;
    if (wall) { at = foot + vec2f(normal.x, normal.y * 0.5) * ${RADIANCE_WALL_OFFSET.toFixed(1)}; }
    let field = radianceAt(at, panel);
    let fieldY = dot(field.rgb, vec3f(0.2126, 0.7152, 0.0722));
    let bounceY = max(0.0, fieldY - field.a);
    var raw = field.a * frame.radianceGain.x + bounceY * frame.radianceGain.y;
    if (wall) { raw = bounceY * frame.radianceGain.z; }
    var shape = min(0.12 + (raw - 0.12) * ${RADIANCE_CONTRAST.toFixed(1)}, 0.355);
    if (wall) { shape *= clamp(1.0 - height / ${RADIANCE_WALL_REACH.toFixed(1)}, 0.0, 1.0); }
    var strength = frame.radianceStrength.x;
    if (wall) { strength = frame.radianceStrength.y; }
    *light = field.rgb / max(fieldY, 1e-4) * strength;
    return shape;
}
`;
