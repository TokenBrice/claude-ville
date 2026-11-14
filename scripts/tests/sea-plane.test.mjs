import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
    CLOUD_FIELD_PERIOD,
    CLOUD_PLANE,
    CLOUD_PLANE_CORE,
    CLOUD_TILE_SIZE,
    CLOUD_TILE_WORLD_SCALE,
    SEA_SUN_LIFT_FLOOR,
    SEA_SUN_LIFT_STOPS,
    cloudPlaneScale,
    seaSunLiftStops,
} from '../../claudeville/src/presentation/character-mode/gpu/GpuWorldPolicy.js';
import { createAtmosphereCourses, resolveAtmosphereCourses, seaSunLift } from '../../claudeville/src/presentation/character-mode/gpu/GpuFrameState.js';
import { FRAME_UNIFORM_LAYOUT } from '../../claudeville/src/presentation/character-mode/gpu/wgsl/common.js';
import { POST_FX_LEVELS } from '../../claudeville/src/presentation/character-mode/postfx/PostFxLadder.js';
import { resetLookStrengths, setLookStrength } from '../../claudeville/src/presentation/character-mode/LookStrengths.js';

const read = path => readFileSync(new URL(`../../claudeville/src/presentation/character-mode/${path}`, import.meta.url), 'utf8');
const PARTLY = { type: 'partly-cloudy', intensity: 0.5, cloudCover: 0.41, windX: 0.5, fog: 0.02 };
const feedFor = (weather, grade = { sunBand: 1, cloudShadow: 1 }) => ({ timeMs: 60000, atmosphere: { weather, lightGrade: grade } });

test('SEA-1: the plane keeps whole 2-px Canvas texels and the field period', () => {
    for (const s of CLOUD_PLANE) {
        const span = (CLOUD_TILE_SIZE * CLOUD_TILE_WORLD_SCALE) / s;
        assert.equal(Math.round(span) % 2, 0, `${span} world px per tile`);
        assert.ok(Math.abs(span - Math.round(span)) < 1e-9);
    }
    assert.ok(CLOUD_PLANE[1] / CLOUD_PLANE[0] >= 2, 'foreshortened and stretched along the wind');
    assert.deepEqual(cloudPlaneScale(0), [1, 1]);
    assert.deepEqual(cloudPlaneScale(0.5), CLOUD_PLANE);
});

test('SEA-1: the GLSL and WGSL twins read the field on the plane and lift the same way', () => {
    const glsl = read('gpu/GpuWorldRenderer.js');
    const atmosphere = read('gpu/wgsl/atmosphere.js');
    const water = read('gpu/wgsl/water.js');
    const openSea = read('gpu/wgsl/openSea.js');
    const scene = read('gpu/wgsl/scene.js');
    assert.match(glsl, /if \(u_cloud\.w > 0\.0\) p = \(cell \+ 0\.5\) \* vec2\(\$\{CLOUD_PLANE/);
    assert.match(atmosphere, /if \(frame\.cloud\.w > 0\.0\) \{ p = \(cell \+ 0\.5\) \* vec2f\(\$\{CLOUD_PLANE/);
    // The lifted stop, floored, in both dialects; in the cloud shade one
    // stop less (s6b: one stop between light and shade); r2: the fraction
    // dithered in on the sea's own Bayer order.
    assert.match(glsl, /if \(u_cloud\.z > 0\.0 && m >= u_cloudThresholds\.x\) lift -= 1\.0;[\s\S]{0,200}lift = floor\(lift \+ order\);\s+if \(lift <= 0\.0\) return stop;\s+return max\(stop - lift, min\(stop, \$\{SEA_SUN_LIFT_FLOOR/);
    assert.match(water, /if \(frame\.cloud\.z > 0\.0 && m >= frame\.cloudThresholds\.x\) \{ lift -= 1\.0; \}[\s\S]{0,120}lift = floor\(lift \+ order\);\s+if \(lift <= 0\.0\) \{ return stop; \}\s+return max\(stop - lift, min\(stop, \$\{SEA_SUN_LIFT_FLOOR/);
    assert.ok(glsl.includes('if (u_cloud.w > 0.0) stop = seaLiftedStop(stop, u_seaLift, m, order);'));
    assert.ok(openSea.includes('if (frame.cloud.w > 0.0) { stop = seaLiftedStop(stop, frame.seaLift, m, order); }'));
    assert.ok(glsl.includes('base = int(seaLiftedStop(float(base), u_seaLift, m, order));'));
    assert.ok(water.includes('base = i32(seaLiftedStop(f32(base), frame.seaLift, m, order));'));
    // The sun band's dim fades out with the look; one cloud course on open water.
    assert.ok(glsl.includes('mix(1.0, 0.86, u_seaSunBand * (1.0 - u_cloud.w))'));
    assert.ok(openSea.includes('mix(1.0, 0.86, frame.seaSunBand * (1.0 - frame.cloud.w))'));
    assert.ok(glsl.includes('if (u_cloud.w > 0.0) quantized = mix(quantized, 1.0, materialNear(material, 8.0) * u_cloud.w);'));
    assert.ok(scene.includes('if (frame.cloud.w > 0.0) { quantized = mix(quantized, 1.0, materialNear(material, 8.0) * frame.cloud.w); }'));
    // s6b — open water takes no cloud multiply: its shade is the lift's stop.
    assert.ok(glsl.includes('if (u_cloud.w > 0.0) shade = 0.0;'));
    assert.ok(openSea.includes('if (frame.cloud.w > 0.0) { shade = 0.0; }'));
    assert.ok(glsl.includes('if (oneCourse) cloud = 0.0;'));
    assert.ok(read('gpu/wgsl/atmosphere.js').includes('if (oneCourse) { cloud = 0.0; }'));
    assert.ok(FRAME_UNIFORM_LAYOUT.fields.some(field => field.name === 'seaLift'));
});

test('SEA-1: the lift is whole stops of the visible sun, nothing at night, overcast or in fog', () => {
    assert.equal(seaSunLiftStops(0, 1), 0);
    assert.equal(seaSunLiftStops(1, 1), SEA_SUN_LIFT_STOPS);
    assert.equal(seaSunLiftStops(0.5, 1), 1);
    assert.equal(seaSunLiftStops(1, 0), 0);
    assert.equal(seaSunLift(1, { sunBand: 1 }, { fog: 0.02 }), 2);
    assert.equal(seaSunLift(1, { sunBand: 1 }, { fog: 0.89 }), 0, 'a fog bank hides the sun');
    assert.ok(SEA_SUN_LIFT_FLOOR >= 2, 'lifted water never takes the shoal stops');
    // r2 — on the real sun: none below the horizon, the first stop swept in
    // over its first two degrees, the second only above ten, in sixteenths.
    assert.equal(seaSunLiftStops(1, 1, -9.5), 0, 'no lift with the sun below the horizon');
    assert.equal(seaSunLiftStops(1, 1, 1), 0.5);
    assert.equal(seaSunLiftStops(1, 1, 5), 1);
    assert.equal(seaSunLiftStops(1, 1, 11), 1.5);
    assert.equal(seaSunLiftStops(1, 1, 20), 2);
    assert.equal(seaSunLiftStops(1, 0, 20), 0, 'overcast: none');
    for (let e = -3; e <= 14; e += 0.25) {
        const v = seaSunLiftStops(1, 1, e);
        assert.equal(v * 16, Math.round(v * 16), 'sixteenths');
        assert.ok(Math.abs(seaSunLiftStops(1, 1, e + 0.25) - v) <= 0.125 + 1e-9, `no jump at ${e}`);
    }
    assert.equal(seaSunLift(1, { sunBand: 1 }, { fog: 0.89 }, 20), 0, 'fog still hides it');
});

test('SEA-1: at 0 the courses are today\'s rings; above 0 one course with a rim, drift in plane units', () => {
    try {
        setLookStrength('sea1', 0);
        const today = resolveAtmosphereCourses(POST_FX_LEVELS.FULL, { zoom: 1 }, feedFor(PARTLY), { sunBand: 1, cloudShadow: 1 }, createAtmosphereCourses());
        assert.equal(today.cloud[3], 0);
        assert.equal(today.lift, 0);
        assert.ok(today.thresholds[2] < 2 && today.sunlit > 0);
        setLookStrength('sea1', 1);
        const plane = resolveAtmosphereCourses(POST_FX_LEVELS.FULL, { zoom: 1 }, feedFor(PARTLY), { sunBand: 1, cloudShadow: 1 }, createAtmosphereCourses());
        assert.equal(plane.cloud[3], 1);
        assert.equal(plane.thresholds[2], 2, 'no third ring');
        assert.ok(plane.thresholds[1] > plane.thresholds[0], 'the core lies inside the rim');
        assert.equal(plane.sunlit, 0, 'the lift replaces the sunlit course');
        assert.equal(plane.lift, 2);
        for (const v of [plane.cloud[0], plane.cloud[1]]) assert.ok(v >= 0 && v < CLOUD_FIELD_PERIOD);
        assert.ok(CLOUD_PLANE_CORE > 0.55 && CLOUD_PLANE_CORE < 1);
        // MINIMAL keeps today's frame (`sea-weather` off).
        const minimal = resolveAtmosphereCourses(POST_FX_LEVELS.MINIMAL, { zoom: 1 }, feedFor(PARTLY), { sunBand: 1, cloudShadow: 1 }, createAtmosphereCourses());
        assert.equal(minimal.cloud[3], 0);
        assert.equal(minimal.lift, 0);
    } finally {
        resetLookStrengths();
    }
});

// r6 — the gate sits above the overcast band, the strength is a ceiling on
// the stops, and the frame lift slews a sixteenth a second.
test('SEA-1: no lift under overcast; sea1 0.5 is a clean single stop; the frame lift slews', async () => {
    const { slewSeaLift } = await import('../../claudeville/src/presentation/character-mode/gpu/GpuFrameState.js');
    assert.equal(seaSunLiftStops(1, 0.2, 30), 0, 'the steady overcast band lifts nothing');
    assert.equal(seaSunLiftStops(1, 1, 30), 2);
    assert.equal(seaSunLiftStops(0.5, 1, 30), 1, 'sea1 0.5: one whole stop at noon');
    assert.equal(seaSunLiftStops(0.5, 1, 1), 0.5, 'the first stop still sweeps in after sunrise');
    for (let e = 0; e <= 40; e += 0.5) assert.ok(seaSunLiftStops(0.5, 1, e) <= 1, `never past one stop at ${e}`);
    // Slew: a held clock, the first frame and a long gap land at once.
    const state = { lift: 0, liftTick: null };
    assert.equal(state.lift = slewSeaLift(state, 2, null), 2, 'held clock');
    const s2 = { lift: 0, liftTick: null };
    assert.equal(s2.lift = slewSeaLift(s2, 2, 100), 2, 'first frame');
    s2.lift = slewSeaLift(s2, 0, 106);
    assert.ok(Math.abs(s2.lift - (2 - 6 / 96)) < 1e-9, 'a sixteenth a second');
    let worst = 0;
    let prev = s2.lift;
    for (let t = 112; t <= 106 + 60; t += 6) { s2.lift = slewSeaLift(s2, 0, t); worst = Math.max(worst, Math.abs(s2.lift - prev)); prev = s2.lift; }
    assert.ok(2 - s2.lift < 1, 'under a stop in 10 s');
    assert.equal(slewSeaLift(s2, 0, 1000), 0, 'a hidden tab lands on the target');
});
