import test from 'node:test';
import assert from 'node:assert/strict';

import { MAP_SIZE } from '../../claudeville/src/config/constants.js';
import { Pathfinder } from '../../claudeville/src/presentation/character-mode/Pathfinder.js';

function gridWith(tiles) {
    const grid = new Uint8Array(MAP_SIZE * MAP_SIZE);
    for (const [tileX, tileY] of tiles) {
        grid[tileY * MAP_SIZE + tileX] = 1;
    }
    return grid;
}

function corridorTo(tileX, tileY) {
    const tiles = [];
    for (let y = 0; y <= tileY; y++) tiles.push([0, y]);
    for (let x = 1; x <= tileX; x++) tiles.push([x, tileY]);
    return tiles;
}

for (const weighted of [false, true]) {
    test(`blocked targets reject endpoints beyond one tile (${weighted ? 'weighted' : 'unweighted'})`, () => {
        const target = { tileX: 10, tileY: 8 };
        const pathfinder = new Pathfinder(gridWith(corridorTo(8, 10)));
        const path = pathfinder.findPath(
            { tileX: 0, tileY: 0 },
            target,
            new Set(),
            { weighted },
        );

        assert.deepEqual(path, []);
    });

    test(`blocked targets stop at the nearest walkable radius (${weighted ? 'weighted' : 'unweighted'})`, () => {
        const target = { tileX: 10, tileY: 10 };
        const grid = gridWith([
            ...corridorTo(10, 12),
            [11, 10],
        ]);
        const pathfinder = new Pathfinder(grid);
        const path = pathfinder.findPath(
            { tileX: 0, tileY: 0 },
            target,
            new Set(),
            { weighted },
        );

        assert.deepEqual(path, [], 'a reachable farther ring must not replace an unreachable nearest ring');
    });

    test(`reachable blocked targets finish within one tile (${weighted ? 'weighted' : 'unweighted'})`, () => {
        const target = { tileX: 10, tileY: 10 };
        const pathfinder = new Pathfinder(gridWith(corridorTo(9, 10)));
        const path = pathfinder.findPath(
            { tileX: 0, tileY: 0 },
            target,
            new Set(),
            { weighted },
        );
        const endpoint = path.at(-1);

        assert.ok(endpoint);
        assert.ok(Math.max(
            Math.abs(endpoint.tileX - target.tileX),
            Math.abs(endpoint.tileY - target.tileY),
        ) <= 1);
    });
}

test('bridge landing tiles are preserved by _simplify and _lookahead', () => {
    const tiles = [];
    for (let y = 18; y <= 28; y++) tiles.push([18, y]);
    const pathfinder = new Pathfinder(gridWith(tiles));
    const bridges = new Map([
        ['18,23', { kind: 'landmark', orientation: 'NS' }],
        ['18,24', { kind: 'landmark', orientation: 'NS' }],
        ['18,25', { kind: 'landmark', orientation: 'NS' }],
    ]);
    for (const options of [null, { preferRoads: true, roadTiles: new Set(tiles.map(([x, y]) => `${x},${y}`)) }]) {
        const path = pathfinder.findPath({ tileX: 18, tileY: 18 }, { tileX: 18, tileY: 28 }, bridges, options);
        assert.ok(path.some((t) => t.tileX === 18 && t.tileY === 22), 'north landing (18,22) kept');
        assert.ok(path.some((t) => t.tileX === 18 && t.tileY === 26), 'south landing (18,26) kept');
    }
});

test('soft standing occupancy cost routes around non-goal standing tiles without blocking the goal', () => {
    const open = [];
    for (let y = 4; y <= 8; y++) for (let x = 4; x <= 10; x++) open.push([x, y]);
    const pathfinder = new Pathfinder(gridWith(open));
    const roadTiles = new Set(['5,6', '6,6', '7,6', '8,6', '9,6']);

    // Standing villager at (7,6) along the road: route steps 1 tile around it.
    const around = pathfinder.findPath(
        { tileX: 5, tileY: 6 },
        { tileX: 9, tileY: 6 },
        new Set(),
        { preferRoads: true, roadTiles, standingTiles: new Set(['7,6']) },
    );
    assert.ok(around.length > 1, 'detours around standing villager');
    assert.equal(around.some((t) => t.tileX === 7 && t.tileY === 6), false, 'does not walk through (7,6)');
    assert.deepEqual(around.at(-1), { tileX: 9, tileY: 6 });

    // Standing villager on the goal tile itself is NOT penalized away from the goal.
    const toGoal = pathfinder.findPath(
        { tileX: 5, tileY: 6 },
        { tileX: 7, tileY: 6 },
        new Set(),
        { preferRoads: true, roadTiles, standingTiles: new Set(['7,6']) },
    );
    assert.deepEqual(toGoal.at(-1), { tileX: 7, tileY: 6 }, 'still reaches occupied goal tile');
});
