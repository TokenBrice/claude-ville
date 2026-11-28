import test from 'node:test';
import assert from 'node:assert/strict';

import { BUILDING_DEFS } from '../../claudeville/src/config/buildings.js';
import { MAP_SIZE } from '../../claudeville/src/config/constants.js';
import { VILLAGE_GATE } from '../../claudeville/src/config/townPlan.js';
import { Building } from '../../claudeville/src/domain/entities/Building.js';
import { AgentSprite } from '../../claudeville/src/presentation/character-mode/AgentSprite.js';
import { IsometricRenderer } from '../../claudeville/src/presentation/character-mode/IsometricRenderer.js';
import { Pathfinder, SINK_COUNT } from '../../claudeville/src/presentation/character-mode/Pathfinder.js';
import { SceneryEngine } from '../../claudeville/src/presentation/character-mode/SceneryEngine.js';
import { VILLAGE_SURFACES } from '../../claudeville/src/presentation/character-mode/SurfaceProjection.js';
import { VisitTileAllocator } from '../../claudeville/src/presentation/character-mode/VisitTileAllocator.js';

function buildRealWorld() {
    const renderer = Object.create(IsometricRenderer.prototype);
    const buildings = new Map(BUILDING_DEFS.map((def) => [def.type, new Building(def)]));
    renderer.world = { buildings, agents: new Map() };
    renderer.terrainSeed = [];
    for (let y = 0; y < MAP_SIZE; y++) for (let x = 0; x < MAP_SIZE; x++) renderer.terrainSeed.push(renderer._tileNoise(x, y));
    for (const name of ['pathTiles', 'townSquareTiles', 'mainAvenueTiles', 'dirtPathTiles', 'busyWalkTiles', 'commandCenterRoadTiles']) renderer[name] = new Set();
    renderer._generatePaths();
    const scenery = new SceneryEngine({
        world: renderer.world,
        terrainSeed: renderer.terrainSeed,
        tileNoise: (x, y) => renderer._tileNoise(x, y),
        smoothNoise: (x, y, scale) => renderer._smoothNoise(x, y, scale),
    });
    scenery.generateBridges();
    const bridgeTiles = scenery.getBridgeTiles();
    for (const key of bridgeTiles.keys()) renderer.pathTiles.add(key);
    renderer.bridgeTiles = bridgeTiles;
    renderer.scenery = scenery;
    renderer._laneTiles = new Map();
    const laneTiles = renderer._buildLaneTileIndex();
    const plazaTiles = new Set();
    for (const [key, info] of laneTiles.entries()) if (info?.plazaLike) plazaTiles.add(key);
    const grid = scenery.getWalkabilityGrid();
    return { grid, bridgeTiles, roadTiles: renderer.pathTiles, laneTiles, plazaTiles };
}

test('AgentSprite._pathOptions reuses shared plazaTiles while keeping exact routes and content-hash validation', () => {
    const world = buildRealWorld();
    const pfLegacy = new Pathfinder(world.grid.slice(), { surfaceRegistry: VILLAGE_SURFACES });
    pfLegacy.keepReachableFrom(VILLAGE_GATE.inside);
    const pfShared = new Pathfinder(world.grid.slice(), { surfaceRegistry: VILLAGE_SURFACES });
    pfShared.keepReachableFrom(VILLAGE_GATE.inside);

    const walk = pfShared.walkableTiles;
    const allocator = new VisitTileAllocator();
    for (let i = 0; i < 20; i++) {
        const t = walk[(i * 23 + 5) % walk.length];
        allocator._occupancyBuckets.set(`${t.tileX},${t.tileY}`, [{ moving: i % 2 === 0, pending: false }]);
    }
    const snapshot = allocator.getCongestionSnapshot(10_000);

    const spriteLegacy = Object.assign(Object.create(AgentSprite.prototype), {
        getRoadTiles: () => world.roadTiles,
        bridgeTiles: world.bridgeTiles,
        getRoutingContext: () => ({ laneTiles: world.laneTiles, ...snapshot }),
    });
    const spriteShared = Object.assign(Object.create(AgentSprite.prototype), {
        getRoadTiles: () => world.roadTiles,
        bridgeTiles: world.bridgeTiles,
        getRoutingContext: () => ({ laneTiles: world.laneTiles, plazaTiles: world.plazaTiles, ...snapshot }),
    });

    const targets = [];
    for (let s = 0; s < SINK_COUNT; s++) {
        for (const t of pfShared.getSinkTiles(s)) if (pfShared.isWalkable(t.tileX, t.tileY)) targets.push(t);
    }

    let state = 1337;
    const rnd = () => ((state = (Math.imul(state, 1103515245) + 12345) >>> 0) / 4294967296);
    for (let i = 0; i < 60; i++) {
        const from = walk[Math.floor(rnd() * walk.length)];
        const to = i % 4 === 0 ? walk[Math.floor(rnd() * walk.length)] : targets[Math.floor(rnd() * targets.length)];
        spriteLegacy.agent = { id: `agent-${i}` };
        spriteShared.agent = { id: `agent-${i}` };
        const optsLegacy = spriteLegacy._pathOptions(from, to);
        const optsShared = spriteShared._pathOptions(from, to);
        if (optsShared?.preferRoads) {
            assert.equal(optsShared.plazaTiles, world.plazaTiles, 'uses shared plazaTiles set');
            assert.equal(optsShared.routeVersion, undefined, 'relies on Pathfinder content-hash validation');
        }
        assert.deepEqual(
            pfShared.findPath(from, to, world.bridgeTiles, optsShared),
            pfLegacy.findPath(from, to, world.bridgeTiles, optsLegacy),
            `route #${i} must match exactly`,
        );
    }
    assert.equal(pfShared.getMemoryFootprint(), pfLegacy.getMemoryFootprint());

    // Verify same-size in-place mutation of shared plazaTiles still reloads via content-hash validation.
    const mutablePlazas = new Set(['5,5', '5,6']);
    const mutSprite = Object.assign(Object.create(AgentSprite.prototype), {
        getRoadTiles: () => world.roadTiles,
        bridgeTiles: world.bridgeTiles,
        getRoutingContext: () => ({ laneTiles: world.laneTiles, plazaTiles: mutablePlazas, ...snapshot }),
    });
    mutSprite.agent = { id: 'mut-test' };
    const from = walk[0];
    const to = walk[walk.length - 1];
    pfShared.findPath(from, to, world.bridgeTiles, mutSprite._pathOptions(from, to));
    assert.ok(pfShared.staticFlags[5 * MAP_SIZE + 5] & 8);
    assert.equal(pfShared.staticFlags[6 * MAP_SIZE + 6] & 8, 0);
    mutablePlazas.delete('5,5');
    mutablePlazas.add('6,6');
    pfShared.findPath(from, to, world.bridgeTiles, mutSprite._pathOptions(from, to));
    assert.equal(pfShared.staticFlags[5 * MAP_SIZE + 5] & 8, 0, 'removed plaza tile clears after same-size mutation');
    assert.ok(pfShared.staticFlags[6 * MAP_SIZE + 6] & 8, 'added plaza tile loads after same-size mutation');
});

test('_simplify preserves bridge decks, landings, surface transitions and corners identically', () => {
    const pf = new Pathfinder(new Uint8Array(MAP_SIZE * MAP_SIZE).fill(1));
    const bridges = new Map([
        ['12,10', { bridgeId: 'west-river', kind: 'landmark' }],
        ['13,10', { bridgeId: 'west-river', kind: 'landmark' }],
        ['16,10', { bridgeId: 'harbor-dock', kind: 'dock' }],
    ]);
    const tiles = [
        { tileX: 10, tileY: 10, surfaceId: 0 },
        { tileX: 11, tileY: 10, surfaceId: 0 }, // landing before landmark bridge
        { tileX: 12, tileY: 10, surfaceId: 0 }, // landmark deck
        { tileX: 13, tileY: 10, surfaceId: 0 }, // landmark deck
        { tileX: 14, tileY: 10, surfaceId: 0 }, // landing after landmark bridge
        { tileX: 15, tileY: 10, surfaceId: 0 }, // straight off-bridge (dock neighbor is NOT a crossing landing)
        { tileX: 16, tileY: 10, surfaceId: 0 }, // dock tile (kept as onBridge)
        { tileX: 17, tileY: 10, surfaceId: 0 }, // straight
        { tileX: 18, tileY: 10, surfaceId: 1 }, // surface transition
        { tileX: 19, tileY: 10, surfaceId: 1 }, // corner into south run
        { tileX: 19, tileY: 11, surfaceId: 1 }, // straight
        { tileX: 19, tileY: 12, surfaceId: 1 }, // final target
    ];
    const simplified = pf._simplify(tiles, bridges);
    assert.deepEqual(simplified.map((t) => `${t.tileX},${t.tileY}@${t.surfaceId}`), [
        '10,10@0',
        '11,10@0',
        '12,10@0',
        '13,10@0',
        '14,10@0',
        '16,10@0',
        '17,10@0',
        '18,10@1',
        '19,10@1',
        '19,12@1',
    ]);
});
