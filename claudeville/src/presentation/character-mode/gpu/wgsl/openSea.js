// Wave 10 (10.1 Stage A) — the WGSL twin of the `shadeOpenSea` half of
// GpuWorldRenderer OPEN_SEA_GLSL (3.3 / 3.4 / 3.2 outer, 2.7 beam on the sea):
// the open sea shaded on the world texel grid under whatever the scene drew,
// with the in-map water's own pipeline. Expression for expression the GLSL,
// its band constants interpolated from CoastBake. u_time / u_weather /
// u_waterFx / u_glint / u_glintStops / u_seaSunBand / u_fogColor / u_seaHaze /
// u_seaSky / u_squall / u_squallFall / u_camera / u_resolution -> frame.*.
// Composite module only (wgsl/composite.js owns main and the fat-seam loop).
// Needs GRADE_WGSL, ATMOSPHERE_WGSL, SEAM_WGSL, WATER_WGSL, BEAM_WGSL.
import {
    OPEN_SEA_BAND_DEPTH,
    OPEN_SEA_BAND_MARK_LIFT,
    OPEN_SEA_BAND_TAIL,
    OPEN_SEA_BAND_WEIGHTS,
} from '../../CoastBake.js';
import { DEEP_DASH_DENSITY } from '../GpuWorldRenderer.js';

export const OPEN_SEA_WGSL = /* wgsl */ `
const OPEN_SEA_BAND: f32 = ${OPEN_SEA_BAND_DEPTH.toFixed(1)};
fn shadeOpenSea(cell: vec2f) -> vec3f {
    let order = waterBayer4(cell);
    let texelPx = (cell + 0.5 + frame.cameraXy) * frame.cameraScale;
    let t = cell.y - OPEN_SEA_HORIZON_Y;
    let excess = islandExcess(cell + 0.5);
    let clock = frame.waterFx.x;
    let storm = step(0.5, frame.weather.z);
    let tick = floor(frame.timeMs * 0.006 * clock);
    let contour = seaContourRows(cell);
    var stop = openSeaStop(openSeaDepth(cell), order);
    let reach = clamp((excess - 1.5) / 4.5, 0.0, 1.0);
    var n = 1.0;
    if (frame.cloud.z > 0.0 || frame.squall.w > 0.0 || frame.seaSunlit > 0.0) { n = cloudNoiseAt(cell); }
    var m = n;
    if (frame.cloud.z > 0.0 || frame.seaSunlit > 0.0) { m = cloudSeamField(cell, n, order, frame.seaSunlit); }
    let near = seaNear(excess);
    var marked = false;
    var c: vec3f;
    let glint = glintDash(cell, texelPx, frame.glint, frame.cameraScale, tick);
    let beam = lighthouseSheen(cell);
    if (glint > 0.5) {
        c = frame.glintStops[select(1, 0, glint > 1.5)].xyz * mix(1.0, 0.86, frame.seaSunBand);
        c = seaPathCap(applyTimeGrade(c, true));
        marked = true;
    } else if (beam > 0.5) {
        c = lighthouseStop(beam) * mix(1.0, 0.86, frame.seaSunBand);
        marked = true;
    } else {
        let s = swellPhase(cell);
        stop = seaBodyStop(cell, s, stop, excess, order);
        var lighter = swellCap(cell, s, near, seaPawCaps(cell, order));
        var whitecap = false;
        if (clock > 0.0) {
            let lit = deepSwellLit(cell, tick, storm, ${DEEP_DASH_DENSITY.toFixed(2)});
            whitecap = lit > 1.5;
            if (lit > 0.5) { lighter = max(lighter, select(1.0, 2.0, near > 0.8)); }
        }
        marked = lighter > 0.0 || whitecap;
        if (frame.seaSunlit > 0.0 && m < frame.seaSunlit) { lighter += 1.0; }
        var albedo = WATER_FOAM;
        if (!whitecap) { albedo = seaStopRgb(max(stop - lighter, 0.0)); }
        c = applyWaterMood(albedo) * WATER_CAST * mix(1.0, 0.86, frame.seaSunBand);
        c = capSaturation(applyTimeGrade(c, true), WATER_MAX_SATURATION);
    }
    let hazeRows = frame.seaHaze.a;
    let band = max(0.0, t - hazeRows) + floor(contour * clamp((t - hazeRows) / 96.0, 0.0, 1.0) + 0.5);
    if (glint < 0.5 && beam < 0.5 && band < OPEN_SEA_BAND) {
        let p = band / OPEN_SEA_BAND * 4.0;
        var k = floor(p);
        var seam = 8.0 / OPEN_SEA_BAND;
        if (k > 2.5) { seam = ${OPEN_SEA_BAND_TAIL.toFixed(2)}; }
        if (p - k > 1.0 - seam && (p - k - (1.0 - seam)) / seam > order) { k += 1.0; }
        var w = 0.0;
        if (k < 0.5) { w = ${OPEN_SEA_BAND_WEIGHTS[0].toFixed(2)}; } else if (k < 1.5) { w = ${OPEN_SEA_BAND_WEIGHTS[1].toFixed(2)}; }
        else if (k < 2.5) { w = ${OPEN_SEA_BAND_WEIGHTS[2].toFixed(2)}; } else if (k < 3.5) { w = ${OPEN_SEA_BAND_WEIGHTS[3].toFixed(2)}; }
        if (marked && w > 0.0) { w += ${OPEN_SEA_BAND_MARK_LIFT.toFixed(2)}; }
        c = seaPathCap(mix(c, frame.seaSky, w));
    }
    if (t < hazeRows) {
        let p = t / hazeRows * 3.0;
        var k = floor(p);
        let seam = min(1.0, 3.0 / hazeRows);
        if (p - k > 1.0 - seam && (p - k - (1.0 - seam)) / seam > order) { k += 1.0; }
        var hw = 0.0;
        if (k < 0.5) { hw = 1.0; } else if (k < 1.5) { hw = 0.6; } else if (k < 2.5) { hw = 0.28; }
        c = mix(c, frame.seaHaze.rgb, hw);
    }
    c = applyGradeVignette(c, texelPx, frame.resolution);
    let groundFog = clamp(frame.weather.y, 0.0, 1.0) * smoothstep(0.18, 0.98, 1.0 - texelPx.y / max(1.0, frame.resolution.y));
    var fogged = mix(c, frame.fogColor, groundFog * 0.48);
    let fogRise = dot(fogged - c, GRADE_LUMA);
    if (fogRise > 0.06) { fogged = mix(c, fogged, 0.06 / fogRise); }
    c = fogged;
    var shade = 0.0;
    if (frame.cloud.z > 0.0) {
        shade = step(frame.cloudThresholds.x, m) + step(frame.cloudThresholds.y, m) + step(mix(frame.cloudThresholds.z, 1.2, reach), m);
    }
    if (frame.squall.w > 0.0) {
        let d = (cell + 0.5 - frame.squall.xy) / vec2f(frame.squall.z, frame.squall.z * 0.5);
        let edge = length(d) + (n - 0.5) * 0.5 + (order - 0.5) * 3.0 / frame.squall.z;
        if (edge < 1.0) {
            var courses = 1.0;
            if (edge < 0.5) { courses = 3.0; } else if (edge < 0.78) { courses = 2.0; }
            let h = waterHash12(vec2f(floor(cell.x / 2.0), 409.0));
            if (h < 0.45 && glslMod(cell.y - frame.squallFall + floor(h * 97.0), 24.0) < 12.0 + h * 10.0) { courses += 1.0; }
            shade = max(shade, courses * frame.squall.w);
        }
    }
    if (shade > 0.0) { c *= vec3f(1.0) - shade * 0.085 * vec3f(1.0, 0.96, 0.84); }
    return applyAerialHaze(c, order, (cell.y + 0.5 + seaContourRows(cell) + frame.cameraXy.y) * frame.cameraScale, false);
}
`;
