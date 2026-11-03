import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ART_RAMPS } from '../../claudeville/src/config/artPalette.js';
import { createAtmosphereSnapshot } from '../../claudeville/src/presentation/character-mode/AtmosphereState.js';
import { applyWaterSky } from '../../claudeville/src/presentation/character-mode/CanvasGrade.js';
import {
    applyWaterMood,
    goldenSeaShare,
    overcastPearlShare,
    waterMoodFor,
    waterMoodKey,
    waterSunBandFor,
    waterSurfaceRgb,
} from '../../claudeville/src/presentation/character-mode/CoastBake.js';
import { applyGradeToRgb, capSaturation, evaluateGrade, WATER_MAX_SATURATION } from '../../claudeville/src/presentation/character-mode/GradeEvaluator.js';
import { resetLookStrengths, setLookStrength } from '../../claudeville/src/presentation/character-mode/LookStrengths.js';

// E2-01 — the sky on the sea: graded water takes some of the grade's own
// sky-horizon colour after V6's cap, at its own value (lifted a little, never
// darker), from the weather and the clock only.
const WEATHERS = {
    clear: { type: 'clear', cloudCover: 0.08, fog: 0, intensity: 0.18 },
    overcast: { type: 'overcast', cloudCover: 0.86, fog: 0.08, intensity: 0.68 },
    fog: { type: 'fog', cloudCover: 0.6, fog: 0.8, intensity: 0.7 },
    rain: { type: 'rain', cloudCover: 0.92, fog: 0.16, intensity: 0.82, precipitation: 0.9 },
    storm: { type: 'storm', cloudCover: 0.97, fog: 0.18, intensity: 0.9, precipitation: 0.92 },
};
const rgb01 = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255);
const luma = c => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
const WATER = [...ART_RAMPS.deepWater, ...ART_RAMPS.shallowWater].map(rgb01);

function graded(rgb, minute, weather, sky = true) {
    const grade = evaluateGrade({ minuteOfDay: minute, weather, moonFill: 0.5 });
    const atmosphere = { lightGrade: grade, weather };
    const mood = waterMoodFor(atmosphere);
    const capped = capSaturation(applyGradeToRgb(waterSurfaceRgb(rgb, mood, waterSunBandFor(atmosphere)), grade));
    return sky ? capSaturation(applyWaterSky(capped, mood)) : capped;
}

test('the sky never darkens the sea and keeps it cool at every hour and weather (V6)', () => {
    for (const [name, weather] of Object.entries(WEATHERS)) {
        for (let minute = 0; minute < 24 * 60; minute += 30) {
            for (const rgb of WATER) {
                const off = graded(rgb, minute, weather, false);
                const on = graded(rgb, minute, weather, true);
                assert.ok(luma(on) >= luma(off) - 0.25 / 255, `${name} ${minute / 60}h: the sky darkened the sea ${((luma(off) - luma(on)) * 255).toFixed(2)} of ${(luma(off) * 255).toFixed(1)}`);
                assert.ok(luma(on) <= luma(off) * 1.3 + 1e-6, `${name} ${minute / 60}h: the sky lifted the sea past its cap`);
            }
            const deep = WATER.slice(0, 3).map(rgb => graded(rgb, minute, weather, true));
            const rb = deep.reduce((sum, c) => sum + c[0] - c[2], 0) / deep.length;
            assert.ok(rb < 0, `${name} ${minute / 60}h: deep sea R-B ${(rb * 255).toFixed(1)}`);
        }
    }
});

test('at looks la3 and la5 0, golden hour warms the sea and an overcast lifts it toward pewter', () => {
    try {
        setLookStrength('la3', 0);
        setLookStrength('la5', 0);
        const body = rgb01(ART_RAMPS.deepWater[1]);
        const rb = c => c[0] - c[2];
        const goldenOff = graded(body, 18 * 60, WEATHERS.clear, false);
        const goldenOn = graded(body, 18 * 60, WEATHERS.clear, true);
        // J29 — the weight is 0.16 (was 0.22), so the warm shift scales with it
        // (about 10.6 -> 7.7 levels); it stays a visible course.
        assert.ok(rb(goldenOn) - rb(goldenOff) > 6 / 255, `golden R-B ${(rb(goldenOff) * 255).toFixed(1)} -> ${(rb(goldenOn) * 255).toFixed(1)}`);
        const greyOff = graded(body, 12.5 * 60, WEATHERS.overcast, false);
        const greyOn = graded(body, 12.5 * 60, WEATHERS.overcast, true);
        assert.ok(luma(greyOn) > luma(greyOff) * 1.05, 'the overcast sea is lighter');
        const chroma = c => Math.max(...c) - Math.min(...c);
        assert.ok(chroma(greyOn) < chroma(greyOff), 'and greyer');
        // Exactly the old sky term (E2-01), at every hour and weather.
        const q = v => Math.round(Math.max(0, Math.min(1, v)) * 32) / 32;
        for (const weather of Object.values(WEATHERS)) {
            for (let minute = 0; minute < 24 * 60; minute += 60) {
                const grade = evaluateGrade({ minuteOfDay: minute, weather, moonFill: 0.5 });
                const mood = waterMoodFor({ lightGrade: grade, weather });
                const weight = q((0.16 + 0.12 * weather.cloudCover + 0.08 * weather.fog) * (1 - 0.5 * mood.night));
                assert.equal(mood.skyWeight, weight, `${weather.type} ${minute / 60}h weight`);
                assert.deepEqual(mood.sky, rgb01(grade.skyHorizon).map(q), `${weather.type} ${minute / 60}h sky`);
            }
        }
    } finally {
        resetLookStrengths();
    }
});

test('LA-3: the golden sea takes the land\'s shadow violet — lighter, cooler, inside V6', () => {
    const hsv = c => (Math.max(...c) - Math.min(...c)) / Math.max(...c);
    try {
        for (const minute of [17 * 60, 17.5 * 60, 18 * 60, 18.5 * 60]) {
            for (const [index, rgb] of WATER.entries()) {
                setLookStrength('la3', 0);
                const before = graded(rgb, minute, WEATHERS.clear, true);
                setLookStrength('la3', 1);
                const after = graded(rgb, minute, WEATHERS.clear, true);
                const label = `${minute / 60}h ${rgb.map(c => Math.round(c * 255)).join(',')}`;
                // The sea body (every stop but the palest shallows, already
                // lighter than the violet) is lifted past the old warm term.
                if (index < WATER.length - 1) assert.ok(luma(after) > luma(before), `${label}: the golden sea is lifted`);
                assert.ok(after[0] - after[2] < before[0] - before[2], `${label}: and cooler, never amber`);
                assert.ok(after[2] >= after[0] && after[2] >= after[1], `${label}: blue leads`);
                assert.ok(hsv(after) <= WATER_MAX_SATURATION + 1e-6, `${label}: inside V6`);
            }
        }
        // No golden hour, no golden sea: sunrise, noon, the blue hour, overcast.
        for (const [minute, weather] of [[6 * 60, WEATHERS.clear], [12.5 * 60, WEATHERS.clear], [19.75 * 60, WEATHERS.clear], [18 * 60, WEATHERS.overcast]]) {
            assert.equal(goldenSeaShare(evaluateGrade({ minuteOfDay: minute, weather, moonFill: 0.5 })), 0, `${minute / 60}h ${weather.type}`);
        }
        const golden = evaluateGrade({ minuteOfDay: 18 * 60, weather: WEATHERS.clear, moonFill: 0.5 });
        assert.equal(goldenSeaShare(golden, 1), 1);
        assert.equal(goldenSeaShare(golden, 0.5), 0.5);
    } finally {
        resetLookStrengths();
    }
});

test('LA-5: a dry overcast sea takes more of the deck\'s pewter; rain and storm keep theirs', () => {
    const body = rgb01(ART_RAMPS.deepWater[1]);
    try {
        setLookStrength('la5', 0);
        const before = graded(body, 12.5 * 60, WEATHERS.overcast, true);
        const moods = Object.fromEntries(['rain', 'storm', 'fog', 'clear'].map(name => [name, waterMoodFor({ lightGrade: evaluateGrade({ minuteOfDay: 12.5 * 60, weather: WEATHERS[name] }), weather: WEATHERS[name] })]));
        setLookStrength('la5', 1);
        const after = graded(body, 12.5 * 60, WEATHERS.overcast, true);
        assert.ok(luma(after) > luma(before), 'the overcast sea is lighter still');
        for (const [name, mood] of Object.entries(moods)) {
            const now = waterMoodFor({ lightGrade: evaluateGrade({ minuteOfDay: 12.5 * 60, weather: WEATHERS[name] }), weather: WEATHERS[name] });
            assert.deepEqual(now, mood, `${name} keeps its sea`);
        }
        assert.equal(overcastPearlShare({ precipitation: 0.04 }, 1), 1, 'the overcast drizzle stays pearl');
        assert.equal(overcastPearlShare({ precipitation: 0.6 }, 1), 0, 'rain is dark');
        assert.equal(overcastPearlShare({ precipitation: 0.04 }, 0), 0);
        let last = 2;
        for (let p = 0; p <= 1.0001; p += 0.02) {
            const share = overcastPearlShare({ precipitation: p }, 1);
            assert.ok(share <= last + 1e-9, `the pearl fades as rain sets in (${p.toFixed(2)})`);
            last = share;
        }
    } finally {
        resetLookStrengths();
    }
});

test('the sky term reads the atmosphere only, and buckets for the Canvas rebakes', () => {
    const snapshot = createAtmosphereSnapshot({ now: new Date(2026, 9, 24, 12), hourOverride: 18, weatherOverride: 'overcast', timelineMode: 'fixed' });
    const a = waterMoodFor(snapshot);
    const b = waterMoodFor({ lightGrade: snapshot.lightGrade, weather: snapshot.weather, agents: [{ status: 'working' }] });
    assert.deepEqual(a, b);
    assert.ok(a.skyWeight > 0);
    for (const value of [a.skyWeight, ...a.sky]) assert.equal(Math.round(value * 32), value * 32);
    assert.equal(waterMoodKey(a), waterMoodKey(b));
    assert.notEqual(waterMoodKey(a), waterMoodKey({ ...a, skyWeight: 0 }));
    assert.equal(waterMoodFor({ weather: snapshot.weather }).skyWeight, 0, 'no grade, no sky');
    assert.deepEqual(applyWaterMood([0.2, 0.3, 0.4], { night: 0, storm: 0 }), [0.2, 0.3, 0.4]);
});

test('GLSL, WGSL and Canvas share the one sky-on-sea rule', () => {
    const read = path => readFileSync(new URL(`../../claudeville/src/presentation/character-mode/${path}`, import.meta.url), 'utf8');
    const glsl = read('gpu/GpuWorldRenderer.js');
    const wgsl = read('gpu/wgsl/water.js');
    assert.match(glsl, /uniform vec4 u_waterSky;/);
    assert.match(glsl, /u_waterSky\.rgb \* \(min\(max\(ls, l\), l \* \$\{WATER_SKY_LIFT\.toFixed\(2\)\}\) \/ ls\), u_waterSky\.w\)/);
    assert.match(wgsl, /frame\.waterSky\.rgb \* \(min\(max\(ls, l\), l \* \$\{WATER_SKY_LIFT\.toFixed\(2\)\}\) \/ ls\), frame\.waterSky\.w\)/);
    // After V6's cap, capped again: the in-map scene water and the open sea.
    const twice = /capSaturation\(applyWaterSky\(capSaturation\(/g;
    assert.equal((glsl.match(twice) || []).length, 2);
    assert.equal((read('gpu/wgsl/scene.js').match(twice) || []).length, 1);
    assert.equal((read('gpu/wgsl/openSea.js').match(twice) || []).length, 1);
    for (const path of ['CoastBake.js', 'CanvasWaterState.js']) {
        const source = read(path);
        const calls = source.match(/canvasWaterPreimage\([^\n]*/g) || [];
        assert.ok(calls.length >= 2 && calls.every(call => call.includes('sky: mood')), `${path}: ${calls.join(' / ')}`);
    }
    assert.equal((glsl.match(/gl\.uniform4f\(uniforms\.u_waterSky, mood\.sky\[0\], mood\.sky\[1\], mood\.sky\[2\], mood\.skyWeight\)/g) || []).length, 2);
    assert.match(read('gpu/GpuWorldRendererWebGPU.js'), /s\.waterSky = \[mood\.sky\[0\], mood\.sky\[1\], mood\.sky\[2\], mood\.skyWeight\]/);
    assert.match(read('CanvasWaterState.js'), /waterMoodKey\(mood\)/);
});
