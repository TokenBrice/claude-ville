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
// `var<private> v_originFrac` and the batch block, so it is scene-only.
import { CLOUD_SECOND_OCTAVE, CLOUD_TILE_SIZE, CLOUD_TILE_WORLD_SCALE } from '../GpuWorldPolicy.js';

const CLOUD_FIELD_SPAN = (CLOUD_TILE_WORLD_SCALE * CLOUD_TILE_SIZE).toFixed(1);

export const ATMOSPHERE_WGSL = /* wgsl */ `
fn cloudNoiseAt(cell: vec2f) -> f32 {
    let p = cell + 0.5 + frame.cloud.xy;
    let n1 = textureSampleLevel(cloudTile, cloudSampler, fract(p / ${CLOUD_FIELD_SPAN}), 0.0).r;
    let n2 = textureSampleLevel(cloudTile, cloudSampler, fract((p / ${CLOUD_SECOND_OCTAVE.scale.toFixed(4)} + vec2f(${CLOUD_SECOND_OCTAVE.offset.map(v => v.toFixed(1)).join(', ')}))
        / ${CLOUD_FIELD_SPAN}), 0.0).r;
    var n = max(n1, n2 * ${CLOUD_SECOND_OCTAVE.weight.toFixed(3)});
    // W6.3 — the lone fair-weather cumulus (GLSL u_cloudLone).
    if (frame.cloudLone.z > 0.0) {
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
        let t = clamp((0.55 - yTop) / 0.55, 0.0, 1.0);
        let level = pow(t, 1.4) * frame.haze.a * 48.0;
        let perTexel = 48.0 * frame.haze.a * 1.4 * pow(max(t, 1e-4), 0.4) / (0.55 * max(1.0, frame.resolution.y)) * max(1.0, frame.cameraScale);
        let seam = clamp(2.0 * perTexel, 1e-3, 1.0);
        var k = floor(level);
        let f = level - k;
        if (f > 1.0 - seam && (f - (1.0 - seam)) / seam > order) { k += 1.0; }
        let haze = k / 48.0;
        if (haze > 0.0) {
            let l = dot(color, vec3f(0.2126, 0.7152, 0.0722));
            color = mix(color, mix(vec3f(l), color, 0.8), min(1.0, haze * 8.0));
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
`;

export const ATMOSPHERE_SCENE_WGSL = /* wgsl */ `
fn fatAtmosphereCourses(color: vec3f, t: FatTaps, waterMaterial: bool) -> vec3f {
    var sum = vec3f(0.0);
    for (var i = 0; i < 4; i++) {
        let w = fatTapWeight(t, i);
        if (w <= 0.0) { continue; }
        let cell = t.base + fatTapOffset(i);
        var contour = 0.0;
        if (waterMaterial) { contour = seaContourRows(cell) * frame.cameraScale; }
        let rowPx = (cell.y + v_originFrac.y + 0.5 + frame.cameraXy.y) * frame.cameraScale + contour;
        sum += applyAtmosphereCourses(color, cell, bayer4(cell), rowPx, batch.additive != 0u) * w;
    }
    return sum;
}
`;
