import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAtmosphereSnapshot } from '../../claudeville/src/presentation/character-mode/AtmosphereState.js';
import { canvasGlint } from '../../claudeville/src/presentation/character-mode/CoastBake.js';
import {
    createWaterFx,
    MOON_ARC_BASE_Y,
    MOON_ROAD_FILL,
    MOON_ROAD_RISE_Y,
    moonRoadFor,
    resolveWaterFx,
    SUN_ROAD_FOG_FULL,
    SUN_ROAD_FOG_START,
    SUN_ROAD_NARROW_ALPHA,
    sunRoadFor,
} from '../../claudeville/src/presentation/character-mode/gpu/GpuFrameState.js';
import { resetLookStrengths, setLookStrength } from '../../claudeville/src/presentation/character-mode/LookStrengths.js';

const CLEAR = { type: 'clear', intensity: 0.18, cloudCover: 0.08 };
// LA-2: the village keeps the real sun, so these dates read Belgrade's on
// its own clock (3-4 Nov are CET) on any host: sunset 16:24, and the waning
// half moon rises near midnight (LA-4a).
const BELGRADE = { zone: 'Europe/Belgrade', lat: 44.8, lon: 20.5, offsetMinutes: () => 60 };

function at(date, minute) {
    const now = new Date(`${date}T00:00:00`);
    now.setHours(0, minute, 0, 0);
    return createAtmosphereSnapshot({ now, weatherOverride: CLEAR, solarSite: BELGRADE });
}

test('LA-1: a high sun keeps today\'s road (pale at noon, gold at golden hour)', () => {
    assert.deepEqual(sunRoadFor({ visible: true, alpha: 1 }, 0, 0.1), { kind: 2, strength: 0.35, growScale: 1 });
    assert.deepEqual(sunRoadFor({ visible: true, alpha: 0.9 }, 1, 0.1), { kind: 1, strength: 1, growScale: 1 });
    assert.deepEqual(sunRoadFor({ visible: true }, 0, 0.1), { kind: 2, strength: 0.35, growScale: 1 }, 'no alpha reads as fully up');
    assert.equal(sunRoadFor({ visible: true, alpha: 1 }, 1, 0.7), null, 'heavy cloud hides the road');
    assert.equal(sunRoadFor({ visible: false, alpha: 0 }, 1, 0.1), null);
});

test('LA-1: a low sun keeps a gold road that narrows, then fades out with the sun', () => {
    const low = sunRoadFor({ visible: true, alpha: 0.04 }, 0.38, 0.08);
    assert.equal(low.kind, 1, 'never the pale noon sparkle once the sun is low');
    assert.ok(low.strength < 0.1 && low.growScale < 0.6, JSON.stringify(low));
    assert.ok(sunRoadFor({ visible: true, alpha: 0.021 }, 0.37, 0.08).strength < 0.001, 'nothing left to pop at the edge');
    let last = -1;
    for (let alpha = 0.02; alpha <= 1.0001; alpha += 0.01) {
        const road = sunRoadFor({ visible: true, alpha }, 0.6, 0.08);
        assert.ok(road.strength >= last - 1e-9, `strength rises with the sun (alpha ${alpha.toFixed(2)})`);
        last = road.strength;
    }
});

test('LA-1: the real dusk of 2026-11-03 sets the road without a pale field or a pop', () => {
    let prev = null;
    for (let minute = 15 * 60; minute <= 17 * 60 + 30; minute += 1) {
        const atmosphere = at('2026-11-03', minute);
        const feed = { timeMs: 1000, motionScale: 1, atmosphere, weather: atmosphere.weather };
        const water = resolveWaterFx(feed, { zoom: 1 }, 0, atmosphere.lightGrade, atmosphere.lighting.moonFill, 2000, createWaterFx());
        const kind = water.glint[2];
        const strength = water.glint[1];
        if ((atmosphere.sky.sun.alpha ?? 1) < SUN_ROAD_NARROW_ALPHA) assert.notEqual(kind, 2, `no pale sparkle at ${minute}`);
        if (prev !== null) assert.ok(Math.abs(strength - prev) <= 0.1, `no pop at ${minute}: ${prev} -> ${strength}`);
        prev = strength;
        const canvas = canvasGlint(atmosphere);
        assert.equal(canvas?.kind ?? 0, kind, `Canvas twin kind at ${minute}`);
        assert.ok(Math.abs((canvas?.strength ?? 0) - strength) < 1e-6, `Canvas twin strength at ${minute}`);
    }
});

// LA-1b (look `la1b`) and LA-4b (look `la4`): each look at 0 is the old rule
// exactly; at 1 the look as proposed.
const FOG = { type: 'fog', intensity: 0.58, cloudCover: 0.61, fog: 0.79 };

function localMinute(date, minute) {
    const now = new Date(`${date}T00:00:00`);
    now.setHours(0, minute, 0, 0);
    return now;
}

function roadAt(atmosphere) {
    const feed = { timeMs: 1000, motionScale: 1, atmosphere, weather: atmosphere.weather };
    const water = resolveWaterFx(feed, { zoom: 1 }, 0, atmosphere.lightGrade, atmosphere.lighting.moonFill, 2000, createWaterFx());
    const canvas = canvasGlint(atmosphere);
    assert.equal(canvas?.kind ?? 0, water.glint[2], 'Canvas twin kind');
    assert.ok(Math.abs((canvas?.strength ?? 0) - water.glint[1]) < 1e-6, 'Canvas twin strength');
    return { kind: water.glint[2], strength: water.glint[1] };
}

test('LA-1b: fog thins the sun\'s road and a fog bank hides it; at 0 it is the old road', () => {
    const sun = { visible: true, alpha: 0.9 };
    const clear = sunRoadFor(sun, 0.6, 0.6, 0, 1);
    assert.deepEqual(sunRoadFor(sun, 0.6, 0.6, 0.79, 0), clear, 'la1b 0 ignores the fog');
    assert.deepEqual(sunRoadFor(sun, 0.6, 0.6, SUN_ROAD_FOG_START, 1), clear, 'a trace of fog changes nothing');
    assert.equal(sunRoadFor(sun, 0.6, 0.6, SUN_ROAD_FOG_FULL, 1).strength, 0, 'a fog bank hides the road');
    let last = Infinity;
    for (let fog = 0; fog <= 1.0001; fog += 0.05) {
        const road = sunRoadFor(sun, 0.6, 0.6, fog, 1);
        assert.ok(road.strength <= last + 1e-9, `thinner as the fog thickens (fog ${fog.toFixed(2)})`);
        assert.equal(road.kind, clear.kind, 'the fog keeps the road\'s kind and width');
        assert.equal(road.growScale, clear.growScale);
        last = road.strength;
    }
    const half = sunRoadFor(sun, 0.6, 0.6, 0.79, 0.5).strength;
    assert.ok(Math.abs(half - clear.strength / 2) < 1e-9, 'half the look, half the road');
});

test('LA-1b: a fogged afternoon and dusk on 2026-11-03 hide the road on both paths; la1b 0 keeps it', () => {
    try {
        for (const minute of [14 * 60, 15 * 60 + 30, 16 * 60]) {
            const atmosphere = createAtmosphereSnapshot({ now: localMinute('2026-11-03', minute), weatherOverride: FOG, solarSite: BELGRADE });
            setLookStrength('la1b', 0);
            assert.ok(roadAt(atmosphere).strength > 0, `the old road showed through fog at ${minute}`);
            setLookStrength('la1b', 1);
            assert.equal(roadAt(atmosphere).strength, 0, `no road in the fog bank at ${minute}`);
        }
    } finally {
        resetLookStrengths();
    }
});

test('LA-4b: at la4 0 the moon road is the old rule exactly', () => {
    const moon = { visible: true, yFrac: 0.44 };
    for (let step = 0; step <= 100; step += 1) {
        const fill = step / 100;
        const road = moonRoadFor(moon, fill, 0.2, false, 0);
        if (fill < MOON_ROAD_FILL) assert.equal(road, null, `no road under a ${fill.toFixed(2)} moon`);
        else assert.deepEqual(road, { kind: 3, strength: fill, growScale: 1 });
    }
    assert.equal(moonRoadFor({ visible: true }, 0.9, 0.5, false, 0), null, 'cloud cover 0.5 hides it');
    assert.equal(moonRoadFor({ visible: true }, 0.9, 0.2, true, 0), null, 'rain hides it');
});

test('LA-4b: at la4 1 every visible moon lays a road, faint for a crescent, growing in after moonrise', () => {
    const high = { visible: true, yFrac: 0.2 };
    const crescent = moonRoadFor(high, 0.08, 0.1, false, 1);
    assert.ok(crescent && crescent.strength > 0 && crescent.strength < 0.1, `a crescent's faint road ${JSON.stringify(crescent)}`);
    assert.equal(moonRoadFor(high, 0.86, 0.1, false, 1).strength, 0.86, 'a high full moon keeps its bright road');
    assert.equal(moonRoadFor({ visible: true }, 0.86, 0.1, false, 1).strength, 0.86, 'no yFrac reads as high');
    assert.equal(moonRoadFor({ visible: true, yFrac: MOON_ARC_BASE_Y }, 0.86, 0.1, false, 1), null, 'nothing at the horizon');
    assert.equal(moonRoadFor(high, 0.86, 0.5, false, 1), null, 'clear air only');
    assert.equal(moonRoadFor(high, 0.86, 0.1, true, 1), null);
    assert.equal(moonRoadFor({ visible: false, yFrac: 0.2 }, 0.86, 0.1, false, 1), null);
    let last = -1;
    for (let y = MOON_ARC_BASE_Y; y >= MOON_ARC_BASE_Y - MOON_ROAD_RISE_Y - 0.05; y -= 0.005) {
        const strength = moonRoadFor({ visible: true, yFrac: y }, 0.3, 0.1, false, 1)?.strength ?? 0;
        assert.ok(strength >= last - 1e-9, `the road grows as the moon climbs (y ${y.toFixed(3)})`);
        last = strength;
    }
    assert.ok(Math.abs(last - 0.3) < 1e-9);
    assert.ok(Math.abs(moonRoadFor(high, 0.6, 0.1, false, 0.5).strength - 0.6) < 1e-9, 'above the old gate both rules agree');
    assert.ok(Math.abs(moonRoadFor(high, 0.3, 0.1, false, 0.5).strength - 0.15) < 1e-9, 'below it, half the look');
});

test('LA-4b: the half moon of 2026-11-03 lays its road from moonrise to dawn with no pop; la4 0 lays none', () => {
    try {
        let prev = 0;
        let lit = 0;
        for (let minute = 17 * 60 + 30; minute <= 30 * 60 + 30; minute += 1) {
            const atmosphere = createAtmosphereSnapshot({ now: localMinute('2026-11-03', minute), weatherOverride: CLEAR, solarSite: BELGRADE });
            if (atmosphere.sky.sun.visible) continue;
            setLookStrength('la4', 0);
            assert.equal(roadAt(atmosphere).kind, 0, `the old rule lays no road for a half moon at ${minute}`);
            setLookStrength('la4', 1);
            const road = roadAt(atmosphere);
            if (road.kind) assert.equal(road.kind, 3);
            // LA-4a: the fill follows the instant's age (no midnight step)
            // and eases in and out of the night, so nothing pops anywhere.
            assert.ok(Math.abs(road.strength - prev) <= 0.05, `no pop at ${minute}: ${prev} -> ${road.strength}`);
            if (minute === 21 * 60) assert.equal(road.strength, 0, 'the waning half moon is not up at 21:00');
            if (road.strength > 0) lit += 1;
            prev = road.strength;
        }
        assert.ok(lit > 4 * 60, `the road lies from moonrise to dawn (${lit} minutes)`);
    } finally {
        resetLookStrengths();
    }
});
