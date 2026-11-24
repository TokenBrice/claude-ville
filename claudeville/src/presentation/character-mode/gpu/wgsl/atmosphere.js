// Wave 10 (10.1 Stage A) — the WGSL twin of GpuWorldRenderer
// ATMOSPHERE_COURSES_GLSL (1.4 cloud-shadow courses, 1.6 aerial haze; 3.4's
// two-octave cloud field) and of SCENE_FRAGMENT's `fatAtmosphereCourses`
// (4.6, the courses per covered cell on a flight frame's seam pixel).
// Expression for expression the GLSL, the field scale and second octave
// interpolated from the same GpuWorldPolicy constants with the same
// formatting. u_cloudTile -> cloudTile/cloudSampler (repeat + linear, sampled
// at level 0 like GL's mip-less texture()), u_cloud / u_cloudThresholds /
// u_haze / u_camera / u_resolution -> frame.*. ATMOSPHERE_WGSL is shared by
// the scene and composite modules; ATMOSPHERE_SCENE_WGSL reads the scene's
// `var<private> v_originFrac` and `seaOpenWater` (RG-5's `applySeaCourses`,
// the squall on open water) and the batch block, so it is scene-only.
import { CLOUD_INT_CONSTANTS, CLOUD_PLANE, CLOUD_SECOND_OCTAVE, CLOUD_TILE_SIZE, CLOUD_TILE_WORLD_SCALE } from '../GpuWorldPolicy.js';
import { MIST } from '../GpuFrameState.js';

const mistNumber = value => value.toFixed(2);

// MS-1 — the WGSL twin of GpuWorldRenderer MIST_GLSL (low mist with a top),
// expression for expression; u_mist -> frame.mist. Part of ATMOSPHERE_WGSL.
export const MIST_WGSL = /* wgsl */ `
fn mistTopAt(ground: vec2f, near: f32) -> f32 {
    let p = floor(ground * 0.5) * 2.0 + frame.mist.yz;
    let n1 = textureSampleLevel(cloudTile, cloudSampler, fract(p / vec2f(${MIST.scaleA.map(mistNumber).join(', ')})), 0.0).r;
    let n2 = textureSampleLevel(cloudTile, cloudSampler, fract(p / vec2f(${MIST.scaleB.map(mistNumber).join(', ')}) + vec2f(${MIST.offsetB.map(mistNumber).join(', ')})), 0.0).r;
    let swell = clamp((0.55 * n1 + 0.45 * n2 - 0.30) / 0.30, 0.0, 1.0);
    // MS-2 — the burn-off shares (land, sea) (GLSL u_mistBurn).
    return frame.mist.x * frame.mist.w * mix(${mistNumber(MIST.inland)} * frame.mistBurn.x, frame.mistBurn.y, near) * (${mistNumber(MIST.topBase)} + ${mistNumber(MIST.topSwell)} * swell);
}
fn mistCourseAt(depth: f32, slope: f32, order: f32) -> f32 {
    let f = max(depth / ${mistNumber(MIST.coursePx)} + 1.0, 0.0);
    var k = floor(f);
    let seam = clamp(slope / ${mistNumber(MIST.coursePx)}, ${mistNumber(MIST.seamMin)}, 0.5);
    if (f - k > 1.0 - seam && (f - k - (1.0 - seam)) / seam > order) { k += 1.0; }
    return min(k, 3.0);
}
fn mistCourse(ground: vec2f, h: f32, near: f32, upright: bool, order: f32) -> f32 {
    let top = mistTopAt(ground, near);
    let f = max((top - h) / ${mistNumber(MIST.coursePx)} + 1.0, 0.0);
    var slope = select(0.0, 2.0, upright);
    if (f - floor(f) > 0.5) {
        slope += max(abs(mistTopAt(ground + vec2f(2.0, 0.0), near) - top), abs(mistTopAt(ground + vec2f(0.0, 2.0), near) - top));
    }
    var k = mistCourseAt(top - h, slope, order);
    // r6 — under one course of top, the first course through the ordered
    // dither (GLSL mistCourse).
    if (top < ${mistNumber(MIST.coursePx)} && top / ${mistNumber(MIST.coursePx)} <= order) { k = 0.0; }
    return k;
}
fn applyMist(color: vec3f, course: f32, fogColor: vec3f, additive: bool) -> vec3f {
    if (course < 0.5) { return color; }
    let w = select(select(${mistNumber(MIST.courseMix[2])}, ${mistNumber(MIST.courseMix[1])}, course < 2.5), ${mistNumber(MIST.courseMix[0])}, course < 1.5);
    if (additive) { return color * (1.0 - w); }
    var misted = mix(color, fogColor, w);
    let rise = dot(misted - color, GRADE_LUMA);
    let cap = ${mistNumber(MIST.riseShare)} * max(dot(fogColor - color, GRADE_LUMA), 0.0) + ${mistNumber(MIST.riseFloor)};
    if (rise > cap) { misted = mix(color, misted, cap / rise); }
    return misted;
}
`;

export const ATMOSPHERE_WGSL = /* wgsl */ `
fn cloudTileByte(x: i32, y: i32) -> i32 {
    return i32(textureLoad(cloudTile, vec2i(x & 255, y & 255), 0).r * 255.0 + 0.5);
}
fn cloudTileBilinear16(u16: vec2i) -> i32 {
    let s = (u16 - vec2i(128)) & vec2i(65535);
    let t0 = s >> vec2u(8u);
    let f = s & vec2i(255);
    let a = cloudTileByte(t0.x, t0.y);
    let b = cloudTileByte(t0.x + 1, t0.y);
    let c = cloudTileByte(t0.x, t0.y + 1);
    let d = cloudTileByte(t0.x + 1, t0.y + 1);
    let top = a * 256 + (b - a) * f.x;
    let bot = c * 256 + (d - c) * f.x;
    return top * 256 + (bot - top) * f.y;
}
fn cloudNoiseIntAt(ic: vec2i) -> i32 {
    let on = frame.cloud.w > 0.0;
    let per = select(vec2u(${CLOUD_INT_CONSTANTS.periodPx}u), vec2u(${CLOUD_INT_CONSTANTS.planePeriod[0]}u, ${CLOUD_INT_CONSTANTS.planePeriod[1]}u), on);
    let sc = select(vec2u(${CLOUD_INT_CONSTANTS.u16PerPx * 100}u), vec2u(${CLOUD_INT_CONSTANTS.planeScale100[0]}u, ${CLOUD_INT_CONSTANTS.planeScale100[1]}u), on);
    let hf = select(vec2u(${CLOUD_INT_CONSTANTS.u16Half * 100 + 50}u), vec2u(${CLOUD_INT_CONSTANTS.planeHalf100[0] + 50}u, ${CLOUD_INT_CONSTANTS.planeHalf100[1] + 50}u), on);
    let iw = vec2u(ic + vec2i(${CLOUD_INT_CONSTANTS.shiftLcm})) % per;
    let base = (iw * sc + hf) / 100u;
    let icloud = vec2u(vec2i(floor(frame.cloud.xy * ${CLOUD_INT_CONSTANTS.u16PerPx.toFixed(1)} + 0.5)) + vec2i(${CLOUD_INT_CONSTANTS.periodU16}));
    let ip = (base + icloud) % ${CLOUD_INT_CONSTANTS.periodU16}u;
    let n1 = cloudTileBilinear16(vec2i(ip & vec2u(65535u)));
    let u2 = ((ip * ${CLOUD_INT_CONSTANTS.oct2Num}u + ${CLOUD_INT_CONSTANTS.oct2Half}u) / ${CLOUD_INT_CONSTANTS.oct2Den}u
        + vec2u(${CLOUD_INT_CONSTANTS.oct2OffsetU16[0]}u, ${CLOUD_INT_CONSTANTS.oct2OffsetU16[1]}u)) & vec2u(65535u);
    let b2 = u32(cloudTileBilinear16(vec2i(u2)));
    let n2 = i32((b2 * ${CLOUD_INT_CONSTANTS.oct2WeightNum}u + ${Math.floor(CLOUD_INT_CONSTANTS.oct2WeightDen / 2)}u) / ${CLOUD_INT_CONSTANTS.oct2WeightDen}u);
    return max(n1, n2);
}
fn cloudNoiseAt(cell: vec2f) -> f32 {
    let ic = vec2i(floor(cell));
    var n = f32(cloudNoiseIntAt(ic)) / 16711680.0;
    // W6.3 — the lone fair-weather cumulus (GLSL u_cloudLone).
    if (frame.cloudLone.z > 0.0) {
        var p = cell + 0.5 + frame.cloud.xy;
        // SEA-1 — the field on the ground plane (GLSL cloudNoiseAt).
        if (frame.cloud.w > 0.0) { p = (cell + 0.5) * vec2f(${CLOUD_PLANE.map(v => v.toFixed(2)).join(', ')}) + frame.cloud.xy; }
        var d = p - frame.cloudLone.xy;
        d = d - 7168.0 * floor(d / 7168.0 + 0.5);
        n = mix(n, 1.0 - length(d) / frame.cloudLone.z, 0.7);
    }
    return n;
}
fn cloudSeamField(cell: vec2f, n: f32, order: f32, seamAt: f32) -> f32 {
    let near = min(min(abs(n - frame.cloudThresholds.x), abs(n - frame.cloudThresholds.y)),
        min(abs(n - frame.cloudThresholds.z), abs(n - seamAt)));
    if (near > 0.03) { return n; }
    if (frame.cloudLone.z <= 0.0) {
        let ic = vec2i(floor(cell));
        let n0 = i32(floor(n * 16711680.0 + 0.5));
        let slope = max(abs(cloudNoiseIntAt(ic + vec2i(1, 0)) - n0), abs(cloudNoiseIntAt(ic + vec2i(0, 1)) - n0));
        let ord16 = i32(floor(order * 16.0 + 0.5)) - 8;
        return f32(n0 + (ord16 * slope) / 8) / 16711680.0;
    }
    let slope = max(abs(cloudNoiseAt(cell + vec2f(1.0, 0.0)) - n), abs(cloudNoiseAt(cell + vec2f(0.0, 1.0)) - n));
    return n + (order - 0.5) * 2.0 * slope;
}
fn cloudCourseAt(m: f32) -> f32 {
    return step(frame.cloudThresholds.x, m) + step(frame.cloudThresholds.y, m) + step(frame.cloudThresholds.z, m);
}
fn applyCloudCourse(color: vec3f, course: f32) -> vec3f {
    return color * (vec3f(1.0) - course * frame.cloud.z * vec3f(1.0, 0.96, 0.84));
}
fn applyAerialHaze(color0: vec3f, order: f32, cellCentreY: f32, additive: bool) -> vec3f {
    var color = color0;
    if (frame.haze.a > 0.0) {
        let yTop = cellCentreY / max(1.0, frame.resolution.y);
        let hazeStart = max(0.05, frame.hazeStart);
        let t = clamp((hazeStart - yTop) / hazeStart, 0.0, 1.0);
        let level = pow(t, 1.4) * frame.haze.a * 48.0;
        let perTexel = 48.0 * frame.haze.a * 1.4 * pow(max(t, 1e-4), 0.4) / (hazeStart * max(1.0, frame.resolution.y)) * max(1.0, frame.cameraScale);
        let seam = clamp(2.0 * perTexel, 1e-3, 1.0);
        var k = floor(level);
        let f = level - k;
        if (f > 1.0 - seam && (f - (1.0 - seam)) / seam > order) { k += 1.0; }
        let haze = k / 48.0;
        if (haze > 0.0) {
            let l = dot(color, vec3f(0.2126, 0.7152, 0.0722));
            // NE v0.67.1 C — clear day (0.30) -> haze * 3.0; clear night (0.35) -> haze * 4.0; overcast/fog (0.55) -> haze * 8.0.
            let clearAir = clamp((0.55 - hazeStart) / 0.25, 0.0, 1.0);
            color = mix(color, mix(vec3f(l), color, 0.8), min(1.0, haze * mix(8.0, 3.0, clearAir)));
            if (additive) {
                color = color * (1.0 - haze);
            } else {
                color = mix(color, frame.haze.rgb, haze);
            }
        }
    }
    return color;
}
fn applyAtmosphereCourses(color0: vec3f, cell: vec2f, order: f32, cellCentreY: f32, additive: bool) -> vec3f {
    var color = color0;
    if (frame.cloud.z > 0.0) { color = applyCloudCourse(color, cloudCourseAt(cloudSeamField(cell, cloudNoiseAt(cell), order, 2.0))); }
    return applyAerialHaze(color, order, cellCentreY, additive);
}
${MIST_WGSL}`;

export const ATMOSPHERE_SCENE_WGSL = /* wgsl */ `
fn applySeaCourses(color0: vec3f, cell: vec2f, order: f32, cellCentreY: f32, additive: bool) -> vec3f {
    var squall = 0.0;
    if (seaOpenWater) { squall = squallShade(cell, cloudNoiseAt(cell), order); }
    // SEA-1 — no cloud multiply on open water (GLSL applySeaCourses).
    let oneCourse = seaOpenWater && frame.cloud.w > 0.0;
    if (squall <= 0.0 && !oneCourse) { return applyAtmosphereCourses(color0, cell, order, cellCentreY, additive); }
    var cloud = 0.0;
    if (frame.cloud.z > 0.0) { cloud = cloudCourseAt(cloudSeamField(cell, cloudNoiseAt(cell), order, 2.0)) * frame.cloud.z; }
    if (oneCourse) { cloud = 0.0; }
    let color = color0 * (vec3f(1.0) - max(cloud, squall * 0.085) * vec3f(1.0, 0.96, 0.84));
    return applyAerialHaze(color, order, cellCentreY, additive);
}
fn fatAtmosphereCourses(color: vec3f, t: FatTaps, waterMaterial: bool) -> vec3f {
    var sum = vec3f(0.0);
    for (var i = 0; i < 4; i++) {
        let w = fatTapWeight(t, i);
        if (w <= 0.0) { continue; }
        let cell = t.base + fatTapOffset(i);
        var contour = 0.0;
        if (waterMaterial) { contour = seaContourRows(cell) * frame.cameraScale; }
        let rowPx = (cell.y + v_originFrac.y + 0.5 + frame.cameraXy.y) * frame.cameraScale + contour;
        sum += applySeaCourses(color, cell, bayer4(cell), rowPx, batch.additive != 0u) * w;
    }
    return sum;
}
`;
