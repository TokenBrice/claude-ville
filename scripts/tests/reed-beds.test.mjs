import test from 'node:test';
import assert from 'node:assert/strict';

import { DISTRICT_PROPS } from '../../claudeville/src/config/scenery.js';
import {
    REED_CALM,
    REED_PROPS,
    REED_SORT_Y,
    REED_STEP_MS,
    buildReedSprites,
    reedBowFrame,
} from '../../claudeville/src/presentation/character-mode/ReedBeds.js';
import { leanFrameImage } from '../../claudeville/src/presentation/character-mode/FoliageRenderer.js';
import { WIND_SPEED_BY_TYPE } from '../../claudeville/src/presentation/character-mode/Wind.js';
import { GPU_DEPTH_SORT_Y_MIN } from '../../claudeville/src/presentation/character-mode/gpu/GpuWorldPolicy.js';

// BI-6 — the reed and cattail clumps moved from the terrain bake to a live
// layer at the same ids and placements, and bow a texel downwind only while
// a gust crosses them, on 250 ms steps, upright under reduced motion.

const REED_IDS = new Set(['veg.reedClump', 'veg.cattailClump']);

test('the five clumps are live at their cache-era placements', () => {
    assert.deepEqual(REED_PROPS.map((prop) => [prop.id, prop.tileX, prop.tileY]), [
        ['veg.cattailClump', 9.2, 11.4],
        ['veg.reedClump', 12.3, 12.6],
        ['veg.cattailClump', 15.6, 13.6],
        ['veg.cattailClump', 3.4, 27.6],
        ['veg.cattailClump', 14.5, 27.1],
    ]);
    // None stays in the terrain bake, and the live layer holds only them.
    for (const prop of DISTRICT_PROPS) {
        assert.equal(REED_IDS.has(prop.id), prop.layer === 'live', `${prop.id} at ${prop.tileX},${prop.tileY}`);
    }
});

test('a clump bows one texel downwind only in a gust, upright in still air and reduced motion', () => {
    assert.equal(reedBowFrame(WIND_SPEED_BY_TYPE.fog, 1), 0, 'fog is still');
    assert.ok(WIND_SPEED_BY_TYPE.fog < REED_CALM && WIND_SPEED_BY_TYPE.clear >= REED_CALM);
    for (const type of ['clear', 'partly-cloudy', 'overcast', 'rain', 'storm']) {
        const speed = WIND_SPEED_BY_TYPE[type];
        assert.equal(reedBowFrame(speed, 0), 0, `${type}: upright between gusts`);
        assert.equal(reedBowFrame(speed, 1 / 3), 1, `${type}: bows toward screen right`);
        assert.equal(reedBowFrame(-speed, 1), -1, `${type}: bows toward screen left`);
        assert.equal(reedBowFrame(speed, 1, 0), 0, `${type}: reduced motion holds the upright frame`);
    }
});

function hostFor(weather, motionScale = 1) {
    return {
        motionScale,
        motionTimeMs: 0,
        _lastAtmosphere: { weather },
        _assetPropBounds: () => ({ left: -16, right: 16, top: -42, bottom: 6, splitY: -18 }),
    };
}

test('the live frames step on the 4 Hz slow band and follow the gust field', () => {
    const storm = { type: 'storm', windX: -WIND_SPEED_BY_TYPE.storm, seed: 7 };
    const host = hostFor(storm);
    const sprites = buildReedSprites(host);
    assert.equal(sprites.length, 5);
    // They keep the terrain bake's layering: ahead of every painter sortY
    // (under Command's split back half, sorted at its art top) and on the
    // resident path's far depth plane, like the ground records.
    assert.ok(REED_SORT_Y < GPU_DEPTH_SORT_Y_MIN);
    for (const sprite of sprites) assert.equal(sprite.sortY, REED_SORT_Y);
    let bowed = 0;
    for (const sprite of sprites) {
        let last = sprite.bowFrame();
        let changedAt = -Infinity;
        for (let t = 0; t <= 120000; t += 16) {
            host.motionTimeMs = t;
            const frame = sprite.bowFrame();
            assert.ok(frame === 0 || frame === -1, `frame ${frame} bows downwind only`);
            if (frame !== last) {
                assert.ok(t - changedAt >= REED_STEP_MS, `a step held ${t - changedAt} ms`);
                changedAt = t;
                last = frame;
            }
            if (frame) bowed++;
        }
    }
    assert.ok(bowed > 0, 'a storm gust bows the bank');
    // Fog and reduced motion: upright on every frame.
    for (const [weather, motionScale] of [[{ type: 'fog', windX: WIND_SPEED_BY_TYPE.fog }, 1], [storm, 0]]) {
        const quiet = hostFor(weather, motionScale);
        for (const sprite of buildReedSprites(quiet)) {
            for (let t = 0; t <= 60000; t += 50) {
                quiet.motionTimeMs = t;
                assert.equal(sprite.bowFrame(), 0);
            }
        }
    }
});

test('a bow shears the top of the clump one texel and keeps its planted half', () => {
    const width = 6;
    const height = 20;
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 2; y < height; y++) data[(y * width + 2) * 4 + 3] = 255;
    const lean = leanFrameImage(data, width, height, 1, 0.5);
    const column = (y) => {
        for (let x = 0; x < lean.width; x++) if (lean.data[(y * lean.width + x) * 4 + 3]) return x;
        return -1;
    };
    // Padded 2 px a side: the planted base stays at x = 4, the tip one right.
    assert.equal(column(height - 1), 4);
    assert.equal(column(Math.round(height * 0.6)), 4);
    assert.equal(column(2), 5);
});
