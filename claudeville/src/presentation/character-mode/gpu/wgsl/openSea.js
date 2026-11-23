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
import { DEEP_DASH_DENSITY, MIST } from '../GpuFrameState.js';
import { SEA_STATE } from '../GpuWorldPolicy.js';

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
    let needCloudM = (frame.cloud.z > 0.0 && (frame.cloud.w <= 0.0 || frame.seaLift > 0.0)) || frame.seaSunlit > 0.0;
    var n = 1.0;
    if (needCloudM || frame.squall.w > 0.0) { n = cloudNoiseAt(cell); }
    var m = n;
    if (needCloudM) { m = cloudSeamField(cell, n, order, frame.seaSunlit); }
    let near = seaNear(excess);
    var marked = false;
    var c: vec3f;
    let glint = glintDash(cell, texelPx, frame.glint, frame.cameraScale, tick);
    let beam = lighthouseSheen(cell, tick, storm);
    if (glint > 0.5) {
        c = frame.glintStops[select(1, 0, glint > 1.5)].xyz * mix(1.0, 0.86, frame.seaSunBand);
        c = seaPathCap(applyTimeGrade(c, true));
        marked = true;
    } else if (beam > 0.5) {
        c = beaconWaterStop(beam) * mix(1.0, 0.86, frame.seaSunBand);
        marked = true;
    } else {
        let s = swellPhase(cell);
        let horizonStop = stop;
        stop = seaBodyStop(cell, s, stop, excess, order);
        // SEA-2 — a set's lit slope.
        let litSlope = stop < horizonStop;
        // SEA-1 — sunlit water lifts outside the cloud shade.
        if (frame.cloud.w > 0.0) { stop = seaLiftedStop(stop, frame.seaLift, m, order); }
        // SEA-3 — calm: no caps or deep dashes; fresh: more caps and streaks.
        let calm = seaCalm();
        var paw = 0.0;
        if (!calm) { paw = seaPawCaps(cell, order); }
        if (seaFresh()) { paw += ${SEA_STATE.freshCaps.toFixed(2)}; }
        var cap = 0.0;
        if (!calm) { cap = swellCap(cell, s, near, paw); }
        var lighter = cap;
        var whitecap = false;
        if (clock > 0.0 && !calm) {
            let lit = deepSwellLit(cell, tick, storm, ${DEEP_DASH_DENSITY.toFixed(2)});
            whitecap = lit > 1.5;
            if (lit > 0.5) { lighter = max(lighter, select(1.0, 2.0, near > 0.8)); }
        }
        var streak = 0.0;
        if (clock > 0.0) { streak = seaStreakAt(cell); }
        if (streak > 1.5) { whitecap = true; } else if (streak > 0.5) { lighter = max(lighter, 1.0); }
        marked = lighter > 0.0 || whitecap;
        if (frame.seaSunlit > 0.0 && m < frame.seaSunlit) { lighter += 1.0; }
        var albedo = WATER_FOAM;
        if (!whitecap) { albedo = seaStopRgb(max(stop - lighter, 0.0)); }
        if (starlightAt(cell, cap, frame.starlight, tick)) { albedo = WATER_FOAM_CREST; }
        // SEA-1 — the sun band's dim fades out with the look.
        c = applyWaterMood(albedo) * WATER_CAST * mix(1.0, 0.86, frame.seaSunBand * (1.0 - frame.cloud.w));
        c = capSaturation(applyWaterSky(capSaturation(applyTimeGrade(c, true), WATER_MAX_SATURATION)), WATER_MAX_SATURATION);
        // SEA-2 / SEA-3 — lit slopes, static caps and calm lanes take the
        // sky's hue: the warm horizon inside the sun's road, cool outside.
        var take = 0.0;
        if (!whitecap && (litSlope || cap > 0.0)) { take = frame.seaState.x; }
        if (calm && seaCalmLane(cell)) { take = max(take, ${SEA_STATE.laneWeight.toFixed(2)}); }
        if (take > 0.0) {
            var sky = frame.waterSky.rgb;
            if (inSunRoad(texelPx, frame.glint, frame.cameraScale)) { sky = frame.seaSky; }
            c = capSaturation(seaSkyHue(c, sky, take), WATER_MAX_SATURATION);
        }
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
    if (frame.mist.w > 0.0) {
        // MS-1 — the low mist on open water: fair/frosty-dawn radiation mist
        // hugs the island coves and tapers offshore, while fog weather holds;
        // marked swell crests rise one course.
        if (frame.mist.x > 0.0) {
            let fogHold = clamp(frame.weather.y / 0.55, 0.0, 1.0);
            // Near the island (excess <= 1.5) both factors are 1, the coast
            // water's mistNear, so the handover at the map edge shows no seam.
            let nearIsland = clamp(1.0 - max(0.0, excess - 1.5) / 7.5, 0.0, 1.0);
            let seaMistNear = mix(mix(0.18, 0.82, fogHold), 1.0, nearIsland)
                * mix(clamp((t - hazeRows) / 140.0, 0.28, 1.0), 1.0, max(fogHold, nearIsland));
            let crestH = select(0.0, clamp((excess - 0.5) / 2.0, 0.0, 1.0) * ${MIST.coursePx.toFixed(1)}, marked);
            c = applyMist(c, mistCourse(cell + 0.5, crestH, seaMistNear, false, waterBayer4(floor(cell * 0.5))), frame.fogColor, false);
        }
    } else {
        let groundFog = clamp(frame.weather.y, 0.0, 1.0) * smoothstep(0.18, 0.98, 1.0 - texelPx.y / max(1.0, frame.resolution.y));
        var fogged = mix(c, frame.fogColor, groundFog * 0.48);
        let fogRise = dot(fogged - c, GRADE_LUMA);
        if (fogRise > 0.06) { fogged = mix(c, fogged, 0.06 / fogRise); }
        c = fogged;
    }
    var shade = 0.0;
    if (frame.cloud.z > 0.0) {
        shade = step(frame.cloudThresholds.x, m) + step(frame.cloudThresholds.y, m) + step(mix(frame.cloudThresholds.z, 1.2, reach), m);
    }
    // SEA-1 — no cloud multiply on open water: its shade is the lift's one stop.
    if (frame.cloud.w > 0.0) { shade = 0.0; }
    let cloudDark = shade * frame.cloud.z;
    shade = max(shade, squallShade(cell, n, order));
    if (shade > 0.0) { c *= vec3f(1.0) - max(cloudDark, shade * 0.085) * vec3f(1.0, 0.96, 0.84); }
    return applyAerialHaze(c, order, (cell.y + 0.5 + seaContourRows(cell) + frame.cameraXy.y) * frame.cameraScale, false);
}
`;
