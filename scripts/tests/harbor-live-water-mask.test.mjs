import test from 'node:test';
import assert from 'node:assert/strict';

import { MAP_SIZE } from '../../claudeville/src/config/constants.js';
import { BUILDING_DEFS } from '../../claudeville/src/config/buildings.js';
import { SceneryEngine } from '../../claudeville/src/presentation/character-mode/SceneryEngine.js';
import {
    HARBOR_WATER_MASK,
    setHarborWaterMask,
} from '../../claudeville/src/presentation/character-mode/HarborLayout.js';

// HN-7: the baked HARBOR_WATER_MASK must be the live scenery water. The
// harbor-water-bounds suite pins routes, berths and lanes to the baked grid;
// this test pins the baked grid to the water the renderer actually generates
// (polylines, basins and bridges), so the two can never drift apart silently.

function buildLiveScenery() {
    const world = { buildings: new Map() };
    for (const def of BUILDING_DEFS) {
        world.buildings.set(def.type, {
            type: def.type,
            position: { tileX: def.x, tileY: def.y },
            width: def.width,
            height: def.height,
            walkExclusionRects: () => [],
            openFloorRects: () => [],
        });
    }

    // The renderer's own deterministic noise (IsometricRenderer._tileNoise /
    // _smoothNoise), duplicated here so the engine can be built without the
    // renderer itself.
    const tileNoise = (x, y) => {
        const n = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
        return n - Math.floor(n);
    };
    const smoothNoise = (x, y, scale = 6) => {
        const gx = x / scale;
        const gy = y / scale;
        const x0 = Math.floor(gx);
        const y0 = Math.floor(gy);
        const fx = gx - x0;
        const fy = gy - y0;
        const sx = fx * fx * (3 - 2 * fx);
        const sy = fy * fy * (3 - 2 * fy);
        const n00 = tileNoise(x0, y0);
        const n10 = tileNoise(x0 + 1, y0);
        const n01 = tileNoise(x0, y0 + 1);
        const n11 = tileNoise(x0 + 1, y0 + 1);
        const top = n00 + (n10 - n00) * sx;
        const bottom = n01 + (n11 - n01) * sx;
        return top + (bottom - top) * sy;
    };
    const terrainSeed = [];
    for (let y = 0; y < MAP_SIZE; y++) {
        for (let x = 0; x < MAP_SIZE; x++) terrainSeed.push(tileNoise(x, y));
    }

    const scenery = new SceneryEngine({ world, terrainSeed, tileNoise, smoothNoise });
    scenery.generateBridges();
    return scenery;
}

const scenery = buildLiveScenery();
const waterTiles = scenery.getWaterTiles();
const bridgeTiles = scenery.getBridgeTiles();

test('the baked harbor water mask equals the live scenery water', () => {
    const bakedIsWater = (x, y) => HARBOR_WATER_MASK[y]?.[x] === '~';
    const liveIsWater = (x, y) => waterTiles.has(`${x},${y}`) && !bridgeTiles.has(`${x},${y}`);
    const liveWaterBakedLand = [];
    const liveLandBakedWater = [];
    for (let y = 0; y < MAP_SIZE; y++) {
        for (let x = 0; x < MAP_SIZE; x++) {
            if (liveIsWater(x, y) && !bakedIsWater(x, y)) liveWaterBakedLand.push(`${x},${y}`);
            if (!liveIsWater(x, y) && bakedIsWater(x, y)) liveLandBakedWater.push(`${x},${y}`);
        }
    }
    assert.deepEqual(
        { liveWaterBakedLand, liveLandBakedWater },
        { liveWaterBakedLand: [], liveLandBakedWater: [] },
        `the baked HARBOR_WATER_MASK and the live scenery water disagree (${liveWaterBakedLand.length}+${liveLandBakedWater.length} tiles, first: ${(liveWaterBakedLand[0] || liveLandBakedWater[0] || 'none')}); re-bake the mask from the live water, or correct the scenery`,
    );
});

test('registering the live water mask changes no navigable water', () => {
    assert.equal(
        setHarborWaterMask(waterTiles, bridgeTiles),
        false,
        'setHarborWaterMask(waterTiles, bridgeTiles) reported a change: the baked HARBOR_WATER_MASK has drifted from the live scenery water; re-bake the mask, or correct the scenery',
    );
});
