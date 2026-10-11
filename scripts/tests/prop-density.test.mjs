import test from 'node:test';
import assert from 'node:assert/strict';
import {
    AMBIENT_GROUND_PROPS,
    BOULDERS,
    DISTRICT_PROPS,
    SCENIC_POINT_PROPS,
} from '../../claudeville/src/config/scenery.js';
import { REST_SEATS } from '../../claudeville/src/config/townPlan.js';
import { IsometricRenderer } from '../../claudeville/src/presentation/character-mode/IsometricRenderer.js';
import { SceneryEngine } from '../../claudeville/src/presentation/character-mode/SceneryEngine.js';

// The prop cleanup (v0.51.4) cut the island's standing props by a third.
// These budgets keep the density from creeping back: raising one is a
// deliberate decision, not a side effect of adding dressing.
const STANDING_PROP_BUDGET = 90;
const CROWD_RADIUS = 1.5;
const CROWD_LIMIT = 3;
const WATER_DRESSING = /lilypad|harborBeaconBuoy/;

function authoredProps() {
    return [
        ...DISTRICT_PROPS.map((prop) => ({ id: prop.id, tileX: prop.tileX, tileY: prop.tileY, district: prop.district })),
        ...AMBIENT_GROUND_PROPS.map((prop) => ({ id: `prop.${prop.type}`, tileX: prop.tileX, tileY: prop.tileY })),
        ...SCENIC_POINT_PROPS.map((prop) => ({ id: prop.id, tileX: prop.tileX, tileY: prop.tileY })),
        ...BOULDERS.map((boulder) => ({ id: 'boulder', tileX: boulder.tileX, tileY: boulder.tileY })),
        ...REST_SEATS.filter((seat) => seat.occluder === 'bench')
            .map((seat) => ({ id: `bench.${seat.id}`, tileX: seat.tileX, tileY: seat.tileY })),
    ];
}

test('standing authored props stay inside the density budget', () => {
    const standing = authoredProps().filter((prop) => !WATER_DRESSING.test(prop.id));
    assert.ok(standing.length <= STANDING_PROP_BUDGET, `${standing.length} standing props > ${STANDING_PROP_BUDGET}`);
});

test('no land prop gathers more than three neighbours (the farm pocket is one composition)', () => {
    const land = authoredProps().filter((prop) => !WATER_DRESSING.test(prop.id) && prop.district !== 'farm');
    for (const prop of land) {
        const near = land.filter((other) => other !== prop
            && Math.hypot(other.tileX - prop.tileX, other.tileY - prop.tileY) <= CROWD_RADIUS);
        assert.ok(near.length <= CROWD_LIMIT,
            `${prop.id} @ ${prop.tileX},${prop.tileY} has ${near.length} props within ${CROWD_RADIUS} tiles`);
    }
});

// The live island's scenery, generated headless with the renderer's own noise.
function islandScenery() {
    const noise = Object.create(IsometricRenderer.prototype);
    const terrainSeed = [];
    for (let y = 0; y < 40; y++) for (let x = 0; x < 40; x++) terrainSeed.push(noise._tileNoise(x, y));
    const scenery = new SceneryEngine({
        world: null,
        terrainSeed,
        tileNoise: (x, y) => noise._tileNoise(x, y),
        smoothNoise: (x, y, scale) => noise._smoothNoise(x, y, scale),
    });
    scenery.generateBridges();
    return scenery;
}

// A coast stand-in: signed distance to the nearest water tile square (> 0 in
// water), the shape of CoastBake's field without its sub-tile growth.
function tileCoast(water) {
    return (x, y) => {
        if (water.has(`${Math.floor(x)},${Math.floor(y)}`)) return 1;
        let best = Infinity;
        for (let ty = Math.floor(y) - 2; ty <= Math.floor(y) + 2; ty++) {
            for (let tx = Math.floor(x) - 2; tx <= Math.floor(x) + 2; tx++) {
                if (!water.has(`${tx},${ty}`)) continue;
                const cx = Math.max(tx, Math.min(x, tx + 1));
                const cy = Math.max(ty, Math.min(y, ty + 1));
                best = Math.min(best, Math.hypot(cx - x, cy - y));
            }
        }
        return -best;
    };
}

test('every generated trunk stands inland of the drawn coast and clear of its neighbours', () => {
    const scenery = islandScenery();
    const coast = tileCoast(scenery.getWaterTiles());
    const bridges = scenery.getBridgeTiles();
    scenery.generateFlatVegetation(new Set(), bridges);
    scenery.generateTrees(new Set(), bridges, null, coast);
    const trees = scenery.getTreeProps().filter((tree) => tree.size !== 'world');
    assert.ok(trees.length > 40, `only ${trees.length} trees grew`);
    for (const tree of trees) {
        const inland = tree.species === 'willow' ? 0.15 : 0.35;
        assert.ok(coast(tree.tileX, tree.tileY) <= -inland,
            `${tree.species} @ ${tree.tileX.toFixed(2)},${tree.tileY.toFixed(2)} stands ${coast(tree.tileX, tree.tileY).toFixed(2)} from the coast`);
    }
    // Clumps keep 0.9 tile between trunks; a tall stand spaces by crown width.
    const spaced = trees.filter((tree) => tree.size !== 'tall');
    for (let a = 0; a < spaced.length; a++) {
        for (let b = a + 1; b < spaced.length; b++) {
            const d = Math.hypot(spaced[a].tileX - spaced[b].tileX, spaced[a].tileY - spaced[b].tileY);
            assert.ok(d >= 0.9 - 1e-9, `trunks ${d.toFixed(2)} apart @ ${spaced[a].tileX.toFixed(2)},${spaced[a].tileY.toFixed(2)}`);
        }
    }
});

test('the busy-walk verge keeps clumps off it but not the authored avenue', () => {
    const scenery = islandScenery();
    const bridges = scenery.getBridgeTiles();
    scenery.generateFlatVegetation(new Set(), bridges);
    scenery.generateTrees(new Set(), bridges, null, null, () => true);
    const trees = scenery.getTreeProps();
    assert.ok(trees.every((tree) => tree.avenue || tree.size === 'world'), 'a clump tree grew on a busy verge');
    assert.ok(trees.some((tree) => tree.avenue), 'the avenue row was kept off its own walk');
});
