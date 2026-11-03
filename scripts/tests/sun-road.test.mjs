import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAtmosphereSnapshot } from '../../claudeville/src/presentation/character-mode/AtmosphereState.js';
import { canvasGlint } from '../../claudeville/src/presentation/character-mode/CoastBake.js';
import {
    createWaterFx,
    resolveWaterFx,
    SUN_ROAD_NARROW_ALPHA,
    sunRoadFor,
} from '../../claudeville/src/presentation/character-mode/gpu/GpuFrameState.js';

const CLEAR = { type: 'clear', intensity: 0.18, cloudCover: 0.08 };

function at(date, minute) {
    const now = new Date(`${date}T00:00:00`);
    now.setHours(0, minute, 0, 0);
    return createAtmosphereSnapshot({ now, weatherOverride: CLEAR });
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
    for (let minute = 18 * 60; minute <= 20 * 60; minute += 1) {
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
