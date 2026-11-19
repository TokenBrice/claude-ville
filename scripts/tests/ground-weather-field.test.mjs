import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { MAP_SIZE, TILE_WIDTH, TILE_HEIGHT } from '../../claudeville/src/config/constants.js';
import {
    GROUND_WEATHER_COLS,
    GROUND_WEATHER_NEUTRAL,
    GROUND_WEATHER_ROWS,
    GROUND_WEATHER_X0,
    GROUND_WEATHER_Y0,
    decodeGroundWeather,
    groundWeatherTexel,
    packGroundWeather,
    validGroundWeather,
} from '../../claudeville/src/presentation/character-mode/GroundWeatherField.js';
import { bakeGround, validGroundArtifact } from '../../claudeville/src/presentation/character-mode/GroundBake.js';

// Item 5 — the ground weather field: RGBA8 on the ground bake's grid.

const cols = GROUND_WEATHER_COLS;
const rows = GROUND_WEATHER_ROWS;
const n = cols * rows;

function packed(fill = {}) {
    const surfaces = new Uint8Array(n).fill(255);
    const stops = new Uint8Array(n);
    const shelter = new Float32Array(n);
    const order = new Float32Array(n);
    const puddleMask = new Uint8Array(n);
    for (const [i, s] of Object.entries(fill)) {
        surfaces[i] = s.surface; stops[i] = s.stop; shelter[i] = s.shelter; order[i] = s.order; puddleMask[i] = s.puddle;
    }
    return packGroundWeather({ cols, rows, surfaces, stops, shelter, order, puddleMask });
}

test('the grid is the ground bake grid over the island bounds', () => {
    assert.equal(cols, MAP_SIZE * TILE_WIDTH / 2);
    assert.equal(rows, MAP_SIZE * TILE_HEIGHT);
    assert.equal(GROUND_WEATHER_X0, -MAP_SIZE * TILE_WIDTH / 2);
    assert.equal(GROUND_WEATHER_Y0, -TILE_HEIGHT / 2);
    assert.equal(cols, 1280);
    assert.equal(rows, 1280);
});

test('channels pack surface·16 + stop, shelter, drying order and the puddle byte', () => {
    const i = 300 * cols + 641;
    const field = packed({ [i]: { surface: 4, stop: 3, shelter: 1, order: 0.5, puddle: 200 }, 0: { surface: 0, stop: 0, shelter: -1, order: 2, puddle: 0 } });
    assert.ok(validGroundWeather(field));
    const bytes = groundWeatherTexel(field, GROUND_WEATHER_X0 + 641 * 2 + 1.9, GROUND_WEATHER_Y0 + 300.5);
    assert.deepEqual(bytes, [4 * 16 + 3, 255, 128, 200]);
    assert.deepEqual(decodeGroundWeather(bytes), { land: true, surface: 4, stop: 3, shelter: 1, dryingOrder: 128 / 255, puddleThreshold: 1 - 200 / 255 });
    // Clamped to bytes; a land texel with no puddle site decodes a null threshold.
    assert.deepEqual(groundWeatherTexel(field, GROUND_WEATHER_X0, GROUND_WEATHER_Y0), [0, 0, 255, 0]);
    assert.equal(decodeGroundWeather([0, 0, 255, 0]).puddleThreshold, null);
});

test('no land and off-grid read the neutral texel', () => {
    const field = packed();
    assert.deepEqual(groundWeatherTexel(field, 0, 400), [...GROUND_WEATHER_NEUTRAL]);
    for (const [x, y] of [[GROUND_WEATHER_X0 - 0.01, 0], [GROUND_WEATHER_X0 + cols * 2, 0], [0, GROUND_WEATHER_Y0 - 0.01], [0, GROUND_WEATHER_Y0 + rows]]) {
        assert.deepEqual(groundWeatherTexel(field, x, y), [...GROUND_WEATHER_NEUTRAL]);
    }
    assert.deepEqual(GROUND_WEATHER_NEUTRAL, [255, 0, 128, 0]);
    assert.equal(decodeGroundWeather(GROUND_WEATHER_NEUTRAL).land, false);
});

function groundBakeFixture(t) {
    globalThis.ImageData = class {
        constructor(width, height) { this.data = new Uint8ClampedArray(width * height * 4); }
    };
    globalThis.document = { createElement: () => ({ getContext: () => ({ putImageData() {} }) }) };
    t.after(() => {
        delete globalThis.ImageData;
        delete globalThis.document;
    });
    return {
        _coastField: { key: '0:0:0:0:0:0', signedDistance: (x, y) => Math.hypot(x - 20, y - 20) - 5 },
        townSquareTiles: new Set(['20,20']),
        world: { buildings: new Map([['archive', { type: 'archive', position: { tileX: 21, tileY: 20 }, width: 2, height: 2 }]]) },
        scenery: { getTreeProps: () => [{ species: 'oak', size: 'large', tileX: 19, tileY: 20 }] },
    };
}

test('weather bake adds only two Float32 planes to the ground bake', t => {
    const renderer = groundBakeFixture(t);
    const FloatPlane = globalThis.Float32Array;
    let allocations = 0;
    globalThis.Float32Array = new Proxy(FloatPlane, {
        construct(target, args) {
            if (args[0] === n) allocations++;
            return new target(...args);
        },
    });
    t.after(() => { globalThis.Float32Array = FloatPlane; });
    bakeGround(renderer);
    const dryAllocations = allocations;
    allocations = 0;
    const { weather } = bakeGround(renderer, true);
    assert.ok(validGroundWeather(weather));
    assert.equal(allocations - dryAllocations, 2, 'the consumed eave and sun-shade planes hold the weather outputs');
});

test('persisted summer and winter weather bytes match the non-aliased bake', t => {
    const renderer = groundBakeFixture(t);
    // SHA-256 from the pre-PF-5 bake over grass, sand, dirt, road, plaza and off-island texels.
    const reference = {
        summer: 'c3f128d37c1d06798692485a5e41a64445ce61b7997ecd4c5d3fd02e74b1775e',
        winter: '400b3859fc6c658cf19de7da32b44dc9930070cbf2dede1632cd4aa6dd63a64d',
    };
    for (const [season, expected] of Object.entries(reference)) {
        renderer._terrainSeason = season;
        const { field } = bakeGround(renderer, true);
        assert.equal(createHash('sha256').update(field.weather.data).digest('hex'), expected, season);
    }
});

test('the weather field is optional in a ground artifact, but a wrong-sized one is never valid', () => {
    const w = MAP_SIZE * TILE_WIDTH;
    const h = MAP_SIZE * TILE_HEIGHT;
    const ground = {
        field: { bounds: { x: -w / 2, y: -TILE_HEIGHT / 2, w, h }, cols: w / 2, rows: h, texelW: 2, classes: new Uint8Array(n), weather: packed() },
        puddleMask: { data: new Uint8Array(n), cols: w / 2, rows: h, x0: -w / 2, y0: -TILE_HEIGHT / 2, texelW: 2, revision: 'sites' },
    };
    assert.equal(validGroundArtifact(ground), true);
    const bare = { ...ground, field: { ...ground.field } };
    delete bare.field.weather;
    assert.equal(validGroundArtifact(bare), true, 'a bake at looks 0 carries no field (schema-1 artifacts fail the schema check)');
    assert.equal(validGroundArtifact({ ...ground, field: { ...ground.field, weather: { ...ground.field.weather, data: new Uint8Array(4) } } }), false);
    assert.equal(validGroundArtifact({ ...ground, field: { ...ground.field, weather: { ...ground.field.weather, x0: 0 } } }), false);
});

test('GW-3: the persisted terrain key carries the frost-patch strength only for a frosty bake', async () => {
    const { terrainArtifactKey } = await import('../../claudeville/src/presentation/character-mode/TerrainArtifactStore.js');
    const inputs = { assetVersion: 'a', configHash: 'c', season: 'winter', sceneryRevision: 0, snowBucket: 0, frost: 0,
        phenology: 'winter', bounds: { x: 0, y: 0, w: 10, h: 10 }, dpr: 1 };
    assert.equal(terrainArtifactKey({ ...inputs, frostPatches: 0 }), terrainArtifactKey({ ...inputs, frostPatches: 1 }));
    assert.notEqual(terrainArtifactKey({ ...inputs, frost: 4, frostPatches: 0 }), terrainArtifactKey({ ...inputs, frost: 4, frostPatches: 1 }));
    const { resetLookStrengths, setLookStrength } = await import('../../claudeville/src/presentation/character-mode/LookStrengths.js');
    try {
        setLookStrength('gw3', 0);
        assert.equal(terrainArtifactKey({ ...inputs, frost: 4 }), terrainArtifactKey({ ...inputs, frost: 4, frostPatches: 0 }), 'the key reads the look when unstated (gw3 0)');
    } finally {
        resetLookStrengths();
    }
    assert.equal(terrainArtifactKey({ ...inputs, frost: 4 }), terrainArtifactKey({ ...inputs, frost: 4, frostPatches: 1 }), 'the look reads 1 by default');
});

test('GW: the field is baked, keyed and saved only while a look reads it', async () => {
    const { groundWeatherWanted, groundWeatherLooksOn } = await import('../../claudeville/src/presentation/character-mode/GroundBake.js');
    const { terrainArtifactKey } = await import('../../claudeville/src/presentation/character-mode/TerrainArtifactStore.js');
    const { resetLookStrengths, setLookStrength } = await import('../../claudeville/src/presentation/character-mode/LookStrengths.js');
    const inputs = { assetVersion: 'a', configHash: 'c', season: 'autumn', sceneryRevision: 0, snowBucket: 0, frost: 0,
        phenology: 'autumn', bounds: { x: 0, y: 0, w: 10, h: 10 }, dpr: 1 };
    const looksOff = () => { for (const id of ['gw1', 'gw2', 'gw3']) setLookStrength(id, 0); };
    try {
        looksOff();
        const atZero = terrainArtifactKey(inputs);
        assert.equal(groundWeatherLooksOn(), false);
        for (const mode of ['webgl', 'webgpu', 'canvas']) assert.equal(groundWeatherWanted({ worldRendererMode: mode }), false, mode);
        assert.ok(!atZero.includes('weather'), 'looks 0: the key carries no field');
        setLookStrength('gw1', 0.5);
        assert.equal(groundWeatherWanted({ worldRendererMode: 'webgl' }), true);
        assert.equal(groundWeatherWanted({ worldRendererMode: 'canvas' }), false, 'Canvas never reads GW-1 / GW-2');
        assert.notEqual(terrainArtifactKey(inputs), atZero);
        looksOff();
        setLookStrength('gw3', 1);
        assert.equal(groundWeatherWanted({ worldRendererMode: 'canvas', _groundState: { frost: 4 } }), true, 'GW-3 frost patches are baked on every backend');
        assert.equal(groundWeatherWanted({ worldRendererMode: 'webgl', _groundState: { frost: 0 } }), false, 'GW-3 without a frost needs no field');
        assert.equal(terrainArtifactKey(inputs), atZero, 'GW-3 at frost 0 keeps the key');
        assert.notEqual(terrainArtifactKey({ ...inputs, frost: 2 }), terrainArtifactKey({ ...inputs, frost: 2, frostPatches: 0, groundWeather: false }));
        looksOff();
        assert.equal(terrainArtifactKey(inputs), atZero, 'looks 0 again: the key returns');
    } finally {
        resetLookStrengths();
    }
});

