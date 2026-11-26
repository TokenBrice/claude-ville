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
// frame differs. The pass-local 2.5D district pilot below uses separate resources.
import {
    radianceGrid,
    RADIANCE_CONTRAST,
    RADIANCE_LAND,
    RADIANCE_WALL_OFFSET,
    RADIANCE_WALL_REACH,
} from '../GroundRadiance.js';

import { uniformLayout } from './common.js';

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

// The district solve has its own layout. Nothing below is in the legacy scene module.
export const RADIANCE_STRATA_H = Object.freeze([4, 28, 76]);
export const RADIANCE_INTERVALS = Object.freeze([0, 8, 32, 128, 512]);
export const DISTRICT_PARAMS = uniformLayout('DistrictParams', [
    ['level', 'u32'], ['activeCells', 'vec4i'],
]);
export const DISTRICT_COURSES = Object.freeze({
    warm: Object.freeze([12, 5, 2]), violet: Object.freeze([8, 3, 13]),
});
const geometry = /* wgsl */ `
const heights = array<i32,3>(${RADIANCE_STRATA_H});
const radii = array<i32,5>(${RADIANCE_INTERVALS});
fn rayOffset(ray: u32, count: u32, radius: i32) -> vec2i {
    let a = (f32(ray) + 0.5) * (6.28318530718 / f32(count)) - .3926990817;
    return vec2i(round(vec2f(cos(a), sin(a)) * f32(radius)));
}
fn hitsSlab(z: vec2f, ends: vec2u) -> bool {
    return ends.x <= ends.y && min(z.x,z.y) <= f32(ends.y) && max(z.x,z.y) >= f32(ends.x);
}
// Walk every crossed 4 px cell, including slabs intersected between pitched endpoints.
// RGB is incident linear flux on the air side of a lit surface. A is remaining transmission. Both use byte units.
fn districtTrace(slabs: texture_2d<u32>, flux: texture_2d_array<u32>, bounds: vec4i,
                 a: vec3i, b: vec3i, layer: i32, collect: bool) -> vec4f {
    var result = vec4f(0.,0.,0.,255.);
    var cell = vec2i(floor(vec2f(a.xy) / 4.));
    let last = vec2i(floor(vec2f(b.xy) / 4.));
    if (any(max(cell,last) < bounds.xy) || any(min(cell,last) >= bounds.zw)) { return result; }
    let delta = b - a;
    let step = sign(delta.xy);
    let span = max(abs(delta.xy), vec2i(1));
    let denominator = span.x * span.y;
    let scale = span.yx;
    var next = abs(4 * (cell + max(step, vec2i(0))) - a.xy) * scale;
    next = select(next, vec2i(denominator + 1), step == vec2i(0));
    var t = 0;
    loop {
        let end = min(min(next.x,next.y), denominator);
        if (end > t && all(cell >= bounds.xy) && all(cell < bounds.zw)) {
            let z = vec2f(f32(a.z)) + f32(delta.z) * vec2f(f32(t),f32(end)) / f32(denominator);
            let slab = textureLoad(slabs, cell, 0);
            if (hitsSlab(z,slab.xy) || hitsSlab(z,slab.zw)) {
                let opacity = f32(textureLoad(flux, cell, 0, 0).a);
                result.a = floor((result.a * (255. - opacity) + 127.) / 255.);
                if (result.a == 0.) { break; }
            }
            if (collect) {
                let energy = vec3f(textureLoad(flux, cell, layer, 0).rgb);
                if (any(energy > vec3f(0))) {
                    result = vec4f(floor((result.a * energy + 127.) / 255.), 0.);
                    break;
                }
            }
        }
        if (end == denominator) { break; }
        let cross = next == vec2i(end);
        cell += select(vec2i(0), step, cross);
        next += select(vec2i(0), 4 * scale, cross);
        t = end;
    }
    return result;
}
`;

// Binding-free landing for the integrator. Field alpha is an eight-direction sky mask.
// GI contributes zero emission, including on Role 1/2 receivers.
export const DISTRICT_RECEIVER_WGSL = geometry + /* wgsl */ `
struct DistrictLanding { encoded: vec3f, emission: vec4f }
fn districtLinear(c: vec3f) -> vec3f {
    return select(pow((c + .055) / 1.055, vec3f(2.4)), c / 12.92, c <= vec3f(.04045));
}
fn districtEncoded(c: vec3f) -> vec3f {
    return select(1.055 * pow(c, vec3f(1./2.4)) - .055, 12.92*c, c <= vec3f(.0031308));
}
fn districtLand(base: vec3f, bounce: vec3f, role: u32) -> DistrictLanding {
    if (role != 0u || all(bounce == vec3f(0))) { return DistrictLanding(base, vec4f(0)); }
    let weights = vec3f(.2126,.7152,.0722);
    var c = districtEncoded(min(vec3f(1.), districtLinear(base) + bounce));
    let peak = max(max(c.r,c.g),c.b);
    if (peak >= .50) { c = max(c, vec3f(peak * (1. - .65))); }
    c *= min(1., .74 / max(.0001,dot(c,weights)));
    c *= min(1., .70 / max(.0001,dot(districtLinear(c),weights)));
    var bytes = floor(c*255.);
    loop {
        let hi = max(max(bytes.r,bytes.g),bytes.b);
        if (hi >= 128.) { bytes = max(bytes, vec3f(ceil(hi * .35))); }
        let rgb = bytes / 255.;
        if (dot(rgb,weights) <= .74 && dot(districtLinear(rgb),weights) <= .70) {
            break;
        }
        bytes = max(vec3f(0), bytes - 1.);
    }
    return DistrictLanding(bytes / 255., vec4f(0));
}
// Supply ground (X,Y,H), with the window origin subtracted from XY. Nearest reads only.
fn districtLookup(field: texture_2d_array<u32>, slabs: texture_2d<u32>, flux: texture_2d_array<u32>,
                  local: vec3i) -> vec4u {
    if (any(local.xy < vec2i(0)) || any(local.xy >= vec2i(1024))) { return vec4u(0,0,0,255); }
    let probe = local.xy / 16;
    let layer = select(select(0,1,local.z > 16),2,local.z > 52);
    let anchor = vec3i(probe * 16 + 8, heights[layer]);
    let visibility = districtTrace(slabs,flux,vec4i(0,0,256,256),local,anchor,layer,false).a;
    if (visibility < 255.) { return vec4u(0); }
    return textureLoad(field,probe,layer,0);
}
`;

export const DISTRICT_RADIANCE_WGSL = geometry + /* wgsl */ `
${DISTRICT_PARAMS.wgsl}
@group(0) @binding(0) var<uniform> params: DistrictParams;
@group(0) @binding(1) var slabs: texture_2d<u32>;
@group(0) @binding(2) var outField: texture_storage_2d_array<rgba8uint, write>;
@group(0) @binding(3) var previous: texture_2d_array<u32>;
@group(0) @binding(4) var flux: texture_2d_array<u32>;

fn address(probe: vec2i, level: u32, ray: u32) -> vec2i {
    let lane = u32(probe.y * (64 >> level) + probe.x) * (8u << (2u*level)) + ray;
    return vec2i(i32(lane % 256u), i32(lane / 256u));
}
@compute @workgroup_size(8,8)
fn districtCascade(@builtin(global_invocation_id) id: vec3u) {
    let level = params.level;
    let count = 8u << (2u*level);
    let pitch = 16 << level;
    let lane = id.y * 256u + id.x;
    let ray = lane % count;
    let row = 64u >> level;
    let probe = vec2i(i32(lane/count % row),i32(lane/count / row));
    let center = probe * pitch + pitch/2;
    let h = heights[id.z];
    let start = vec3i(center + rayOffset(ray,count,radii[level]), h);
    var merged = vec4f(0);
    if (level == 3u) {
        let far = vec3i(center + rayOffset(ray,count,512),h);
        merged = 255. * districtTrace(slabs,flux,params.activeCells,start,far,i32(id.z),true);
    } else {
        let at = vec2f(center) / f32(2*pitch) - .5;
        let f = fract(at);
        for (var q = 0; q < 4; q++) {
            let corner = vec2i(q & 1, q >> 1);
            let parent = clamp(vec2i(floor(at)) + corner, vec2i(0), vec2i(i32(row/2u)-1));
            let w = select(1.-f, f, corner == vec2i(1));
            let parentCenter = parent * (pitch*2) + pitch;
            for (var child = 4u*ray; child < 4u*ray+4u; child++) {
                let end = vec3i(parentCenter + rayOffset(child,count*4u,radii[level+1u]), h);
                let near = districtTrace(slabs,flux,params.activeCells,start,end,i32(id.z),true);
                let far = vec4f(textureLoad(previous,address(parent,level+1u,child),i32(id.z),0));
                merged += .25*w.x*w.y * (vec4f(255.*near.rgb, 0.) + near.a*far);
            }
        }
    }
    textureStore(outField,vec2i(id.xy),i32(id.z),vec4u(floor(merged/255.+.5)));
}
@compute @workgroup_size(8,8)
fn districtResolve(@builtin(global_invocation_id) id: vec3u) {
    let probe = vec2i(id.xy);
    let center = probe * 16 + 8;
    let layer = i32(id.z);
    let start = vec3i(center,heights[layer]);
    var energy = vec3f(0);
    var weight = 0.;
    var sky = 0u;
    for (var ray = 0u; ray < 8u; ray++) {
        let step = rayOffset(ray,8u,1);
        let neighbor = probe + step;
        energy += vec3f(textureLoad(previous,address(probe,0u,ray),layer,0).rgb);
        weight += 1.;
        if (all(neighbor >= vec2i(0)) && all(neighbor < vec2i(64))) {
            for (var other = 0; other < 3; other++) {
                if (other == layer) { continue; }
                let pitchWeight = .5 / f32(abs(other-layer));
                let end = vec3i(neighbor*16+8,heights[other]);
                let visible = districtTrace(slabs,flux,params.activeCells,start,end,layer,false).a;
                let pitched = vec3f(textureLoad(previous,address(neighbor,0u,ray),other,0).rgb);
                energy += pitchWeight * floor((visible * pitched + 127.) / 255.);
                weight += pitchWeight;
            }
        }
        let skyEnd = vec3i(center + rayOffset(ray,8u,512),start.z + 256);
        if (districtTrace(slabs,flux,params.activeCells,start,skyEnd,layer,false).a >= 128.) {
            sky |= 1u << ray;
        }
    }
    energy /= weight;
    let peak = max(max(energy.r,energy.g),energy.b);
    let course = u32(peak >= 2.) + u32(peak >= 20.);
    let swatch = select(vec3u(${DISTRICT_COURSES.warm}), vec3u(${DISTRICT_COURSES.violet}), energy.b > energy.r);
    textureStore(outField,probe,layer,vec4u(course * swatch,sky));
}
`;
