import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { MAP_SIZE, TILE_WIDTH, TILE_HEIGHT } from '../../claudeville/src/config/constants.js';
import { BUILDING_DEFS } from '../../claudeville/src/config/buildings.js';
import { BUILDING_GROUNDING_PROFILES } from '../../claudeville/src/config/buildingGrounding.js';
import { buildingCenterToWorld } from '../../claudeville/src/presentation/character-mode/Projection.js';
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
import { bakeGround, bakeWinterGround, validGroundArtifact } from '../../claudeville/src/presentation/character-mode/GroundBake.js';

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

// The bake texel (index into aoBuf / surfaces) under tile point (tx, ty).
function texelAt(base, tx, ty) {
    const sx = (tx - ty) * (TILE_WIDTH / 2);
    const sy = (tx + ty) * (TILE_HEIGHT / 2);
    return Math.floor(sy - base.y0) * base.cols + Math.floor((sx - base.x0) / 2);
}

// EN-3 — the manifest's sprite anchors of the three seated buildings.
const ANCHORS = { command: [199, 164], tavern: [158, 218], forge: [128, 169] };

test('EN-3: the contact AO and its exclusions sit on the authored plinth edges of the real footprints', t => {
    const renderer = groundBakeFixture(t);
    renderer.assets = { getAnchor: (id) => ANCHORS[id.replace('building.', '')] || [0, 0] };
    renderer._coastField = { key: 'land', signedDistance: () => -9 };
    renderer.world.buildings = new Map(BUILDING_DEFS.filter(def => ANCHORS[def.type]).map(def =>
        [def.type, { type: def.type, position: { tileX: def.x, tileY: def.y }, width: def.width, height: def.height }]));
    const base = bakeGround(renderer);
    const aoAtWorld = (wx, wy) => {
        const col = Math.floor((wx - base.x0) / 2);
        const row = Math.floor(wy - base.y0);
        return base.aoBuf[row * base.cols + col];
    };
    for (const building of renderer.world.buildings.values()) {
        const { plinth } = BUILDING_GROUNDING_PROFILES[building.type];
        const centre = buildingCenterToWorld(building);
        const [ax, ay] = ANCHORS[building.type];
        const world = ([px, py]) => [centre.x + px - ax, centre.y + py - ay];
        const edges = [[plinth.left, plinth.bottom], [plinth.bottom, plinth.right]];
        for (const [a, b] of edges) {
            for (const share of [0.2, 0.5, 0.8]) {
                const [x, y] = world([a[0] + (b[0] - a[0]) * share, a[1] + (b[1] - a[1]) * share]);
                // On the painted foot (2 px up): full contact; just in front of
                // it (3 px down): still the contact course's core, so a puddle
                // (PUDDLE_WALL_AO 70) never reaches the foot; a tile below: open.
                assert.equal(aoAtWorld(x, y - 2), 255, `${building.type} foot at ${share}`);
                assert.ok(aoAtWorld(x, y + 3) >= 180, `${building.type} contact at ${share}: ${aoAtWorld(x, y + 3)}`);
                assert.ok(aoAtWorld(x, y + 40) < 70, `${building.type} open ground at ${share}: ${aoAtWorld(x, y + 40)}`);
            }
        }
        const puddleNearFoot = edges.some(([a, b]) => [0.2, 0.5, 0.8].some(share => {
            const [x, y] = world([a[0] + (b[0] - a[0]) * share, a[1] + (b[1] - a[1]) * share]);
            const col = Math.floor((x - base.x0) / 2);
            const row = Math.floor(y + 3 - base.y0);
            return base.puddleMask[row * base.cols + col] > 0;
        }));
        assert.equal(puddleNearFoot, false, `${building.type}: no puddle at the foot`);
    }
});

test('EY-3: snow lies under the open Task board, not under a solid building', t => {
    const renderer = groundBakeFixture(t);
    renderer.world.buildings.set('taskboard', { type: 'taskboard', position: { tileX: 18, tileY: 17 }, width: 2, height: 2 });
    const base = bakeGround(renderer);
    const green = [80, 140, 60];
    const data = new Uint8ClampedArray(base.cols * 2 * base.rows * 4);
    for (let i = 0; i < data.length; i += 4) data.set([...green, 255], i);
    const image = { data };
    const snowyShare = (tiles) => {
        let snowy = 0;
        let total = 0;
        for (const [tx, ty] of tiles) {
            const i = texelAt(base, tx, ty);
            if (base.surfaces[i] > 1) continue; // grass (0) and sand (1) only
            total++;
            const o = i * 2 * 4;
            if (data[o] !== green[0] || data[o + 1] !== green[1] || data[o + 2] !== green[2]) snowy++;
        }
        return total ? snowy / total : NaN;
    };
    const plot = (x0, y0) => {
        const points = [];
        for (let y = 0; y < 2; y += 0.125) for (let x = 0; x < 2; x += 0.125) points.push([x0 - 0.5 + x, y0 - 0.5 + y]);
        return points;
    };
    bakeWinterGround(renderer, { ...base, canvas: { getContext: () => ({ getImageData: () => image }) } }, 4, 0);
    const board = snowyShare(plot(18, 17));
    const archive = snowyShare(plot(21, 20));
    assert.ok(board > 0.5, `snow under the Task board: ${board}`);
    assert.ok(archive < 0.2, `thinned under a solid building: ${archive}`);
    // The same share spares the rain: the ground under the board wets (the
    // wet test's shelter cut is 0.5), under the Archive it stays dry.
    const { weather } = bakeGround(renderer, true);
    const shelterAt = (tx, ty) => weather.data[texelAt(base, tx, ty) * 4 + 1] / 255;
    assert.ok(shelterAt(19, 18) < 0.5, `rain under the Task board: ${shelterAt(19, 18)}`);
    assert.ok(shelterAt(22, 21) > 0.9, `no rain under the Archive: ${shelterAt(22, 21)}`);
});

test('EY-5: the rising rime grows on the GW-3 patch field, each quarter holding the last', t => {
    const renderer = groundBakeFixture(t);
    const base = bakeGround(renderer, true);
    const rimed = (frost, rising) => {
        const data = new Uint8ClampedArray(base.cols * 2 * base.rows * 4);
        for (let i = 0; i < data.length; i += 4) data.set([80, 140, 60, 255], i);
        bakeWinterGround(renderer, { ...base, canvas: { getContext: () => ({ getImageData: () => ({ data }) }) } }, 0, frost, 1, rising);
        const set = new Set();
        for (let i = 0; i < base.cols * base.rows; i++) if (data[i * 8] !== 80) set.add(i);
        return set;
    };
    const quarters = [rimed(1, true), rimed(2, true), rimed(3, true), rimed(4, false)];
    for (let q = 1; q < 4; q++) {
        assert.ok(quarters[q - 1].size < quarters[q].size, `quarter ${q} under ${q + 1}`);
        for (const i of quarters[q - 1]) assert.ok(quarters[q].has(i), `quarter ${q} inside ${q + 1}`);
    }
    assert.ok(quarters[0].size > 0);
});
