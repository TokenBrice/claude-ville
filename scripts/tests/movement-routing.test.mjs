import test from 'node:test';
import assert from 'node:assert/strict';

import { AMBIENT_SCENIC_POINTS, BRIDGE_HINTS, DISTRICT_PROPS, PLANK_BRIDGES } from '../../claudeville/src/config/scenery.js';
import { BUILDING_DEFS, VISIT_OVERFLOW_TILES } from '../../claudeville/src/config/buildings.js';
import { COMMAND_QUEUE, REST_SEATS, REST_STANDS, TOWN_ROAD_ROUTES, VILLAGE_GATE, VILLAGE_GATE_GEOMETRY } from '../../claudeville/src/config/townPlan.js';
import { MAP_SIZE } from '../../claudeville/src/config/constants.js';
import { AgentStatus } from '../../claudeville/src/domain/value-objects/AgentStatus.js';
import {
    resolveUpdateRouteBuilding,
} from '../../claudeville/src/presentation/character-mode/MovementRouting.js';
import { IsometricRenderer } from '../../claudeville/src/presentation/character-mode/IsometricRenderer.js';
import { Pathfinder } from '../../claudeville/src/presentation/character-mode/Pathfinder.js';
import { SceneryEngine } from '../../claudeville/src/presentation/character-mode/SceneryEngine.js';

test('completed villagers keep their in-flight ambient destination', () => {
    assert.equal(resolveUpdateRouteBuilding({
        status: AgentStatus.COMPLETED,
        currentBuilding: 'forge',
    }), 'forge');
});

test('idle villagers keep their in-flight ambient destination', () => {
    assert.equal(resolveUpdateRouteBuilding({
        status: AgentStatus.IDLE,
        currentBuilding: 'archive',
    }), 'archive');
});

test('directed statuses still replace the current route immediately', () => {
    assert.equal(resolveUpdateRouteBuilding({
        status: AgentStatus.WORKING,
        currentBuilding: 'archive',
        targetBuilding: 'forge',
    }), 'forge');
    assert.equal(resolveUpdateRouteBuilding({
        status: AgentStatus.WAITING,
        currentBuilding: 'forge',
    }), 'taskboard');
    assert.equal(resolveUpdateRouteBuilding({
        status: AgentStatus.ERRORED,
        currentBuilding: 'mine',
    }), 'watchtower');
    assert.equal(resolveUpdateRouteBuilding({
        status: AgentStatus.WAITING_ON_USER,
        currentBuilding: 'mine',
    }), 'command');
});

test('active intent routing takes priority over status routing', () => {
    assert.equal(resolveUpdateRouteBuilding({
        activeIntentBuilding: 'harbor',
        status: AgentStatus.COMPLETED,
        currentBuilding: 'archive',
    }), 'harbor');
});

test('the landmark bridge keeps decorative side spans non-walkable', () => {
    const bridge = BRIDGE_HINTS.find(hint => hint.id === 'central-river-bridge');

    assert.ok(bridge, 'the central landmark bridge must remain authored');
    assert.equal(bridge.walkableRadius, 0);
    assert.ok(bridge.widthRadius > bridge.walkableRadius);

    const scenery = new SceneryEngine({
        world: null,
        terrainSeed: 1,
        tileNoise: () => 0.5,
    });
    scenery.generateBridges();
    const grid = scenery.getWalkabilityGrid();
    const isWalkable = (tileX, tileY) => grid[tileY * MAP_SIZE + tileX] === 1;

    assert.equal(isWalkable(18, 24), true, 'the center deck must remain walkable');
    assert.equal(isWalkable(17, 24), false, 'the west decoration span must block traversal');
    assert.equal(isWalkable(19, 24), false, 'the east decoration span must block traversal');
});

// A baked fixture draws under every body, so a body on or behind the well
// would read as standing on it: its foot nodes leave the walk grid, and no
// authored standing place may sit on them.
test('walk-blocking fixtures take their foot out of the walk grid and off every standing place', () => {
    const blockers = DISTRICT_PROPS.filter(prop => prop.walkBlock);
    assert.ok(blockers.some(prop => prop.id === 'prop.well'), 'the village well blocks walking');

    const scenery = new SceneryEngine({ world: null, terrainSeed: 1, tileNoise: () => 0.5 });
    scenery.generateBridges();
    const grid = scenery.getWalkabilityGrid();
    const blocked = new Set();
    for (const prop of blockers) {
        for (const x of [Math.floor(prop.tileX), Math.ceil(prop.tileX)]) {
            for (const y of [Math.floor(prop.tileY), Math.ceil(prop.tileY)]) {
                assert.equal(grid[y * MAP_SIZE + x], 0, `${prop.id} node ${x},${y} must not be walkable`);
                blocked.add(`${x},${y}`);
            }
        }
    }

    const places = [
        ...REST_SEATS,
        ...Object.values(REST_STANDS).flatMap(room => room.tiles),
        ...COMMAND_QUEUE.slots,
        ...COMMAND_QUEUE.overflow,
        ...AMBIENT_SCENIC_POINTS,
        ...Object.values(VISIT_OVERFLOW_TILES).flat(),
        ...BUILDING_DEFS.flatMap(def => [def.entrance, ...(def.visitTiles || [])]),
    ];
    for (const place of places) {
        assert.ok(!blocked.has(`${place.tileX},${place.tileY}`), `standing place ${place.tileX},${place.tileY} lies under a walk-blocking fixture`);
    }
});

// The walk grid is one node per tile, so a foot between nodes can stand
// inside a gate tower's drum while its nearest node is open. Steering steps
// (lane discipline, pair pushes, the bend round standing bodies) check the
// foot itself: none lands within a body's half-width of the stone, and the
// arch passage stays open.
test('a steering step never puts a foot on the gatehouse drums the walk grid misses', () => {
    const scenery = new SceneryEngine({ world: null, terrainSeed: 1, tileNoise: () => 0.5 });
    scenery.generateBridges();
    const grid = scenery.getWalkabilityGrid();
    const renderer = Object.create(IsometricRenderer.prototype);
    renderer.pathfinder = { isWalkable: (x, y) => Boolean(grid[y * MAP_SIZE + x]) };
    const sprite = { _screenToTile: (x, y) => ({ tileX: (x / 32 + y / 16) / 2, tileY: (y / 16 - x / 32) / 2 }) };
    const walkable = (tileX, tileY) => renderer._isSpritePositionWalkable(sprite, (tileX - tileY) * 32, (tileX + tileY) * 16);

    const G = VILLAGE_GATE_GEOMETRY;
    let gridOpen = 0;
    for (const towerX of G.towerX) {
        const cx = VILLAGE_GATE.tileX + towerX;
        const cy = VILLAGE_GATE.tileY;
        for (let a = 0; a < 64; a++) {
            for (const r of [0.3, 0.6, 0.75, 0.85]) {
                const tileX = cx + Math.cos(a * Math.PI / 32) * r;
                const tileY = cy + Math.sin(a * Math.PI / 32) * r;
                if (grid[Math.round(tileY) * MAP_SIZE + Math.round(tileX)]) gridOpen++;
                assert.equal(walkable(tileX, tileY), false, `foot ${tileX.toFixed(2)},${tileY.toFixed(2)} lies ${r} tiles from a drum's centre`);
            }
        }
    }
    assert.ok(gridOpen > 0, 'some feet on the drums round to an open walk node');
    assert.equal(walkable(VILLAGE_GATE.tileX, VILLAGE_GATE.tileY), true, 'the arch passage is walkable');
    assert.equal(walkable(VILLAGE_GATE.inside.tileX, VILLAGE_GATE.inside.tileY), true, 'the ground inside the gate is walkable');
});

test('Tavern–Forge walkers route over the central bridge (no east footbridge) and the north farm stays reachable over the NS plank bridge', () => {
    assert.equal(BRIDGE_HINTS.some((hint) => hint.id === 'east-river-footbridge'), false, 'east footbridge removed');
    assert.equal(TOWN_ROAD_ROUTES.some((route) => route.id === 'forge-footbridge-road'), false, 'east footbridge road removed');
    assert.equal(BRIDGE_HINTS.some((hint) => hint.id === 'north-farm-bridge'), false, 'north farm bridge is no longer a rustic trestle');
    const northPlank = PLANK_BRIDGES.find((hint) => hint.id === 'north-farm-bridge');
    assert.deepEqual(northPlank, { id: 'north-farm-bridge', tileX: 3, tileY: 7, orientation: 'NS' });

    const scenery = new SceneryEngine({ world: null, terrainSeed: 1, tileNoise: () => 0.5 });
    scenery.generateBridges();
    const bridges = scenery.getBridgeTiles();
    assert.equal(bridges.has('22,24'), false, 'no bridge at the old east river crossing');
    for (const y of [6, 7, 8, 9]) {
        const info = bridges.get(`3,${y}`);
        assert.equal(info?.bridgeId, 'north-farm-bridge');
        assert.equal(info?.kind, 'plank');
        assert.equal(info?.orientation, 'NS');
        assert.equal(info?.walkable, true);
    }

    const pathfinder = new Pathfinder(scenery.getWalkabilityGrid());
    const tavernToForge = pathfinder.findPath({ tileX: 23, tileY: 18 }, { tileX: 25, tileY: 30 }, bridges);
    assert.ok(tavernToForge?.length > 0, 'Tavern to Forge remains connected');
    assert.ok(tavernToForge.some((t) => t.tileX === 18 && t.tileY === 24), 'Tavern to Forge crosses the central bridge');

    for (const id of ['north-farm', 'north-windmill', 'north-shore']) {
        const pt = AMBIENT_SCENIC_POINTS.find((p) => p.id === id);
        const path = pathfinder.findPath({ tileX: 9, tileY: 17 }, { tileX: pt.tileX, tileY: pt.tileY }, bridges);
        assert.ok(path?.length > 0, `${id} (${pt.tileX},${pt.tileY}) stays reachable on foot from Archive`);
        assert.ok(path.some((t) => t.tileX === 3 && t.tileY === 7), `${id} crosses the north farm plank bridge`);
    }

    // NS plank tiles mirror bridge.ew horizontally onto integer texels when bridge.ns is absent.
    const draws = [];
    const ctx = {
        imageSmoothingEnabled: true,
        save() { draws.push(['save']); },
        restore() { draws.push(['restore']); },
        translate(x, y) { draws.push(['translate', x, y]); },
        scale(x, y) { draws.push(['scale', x, y]); },
        drawImage(_img, x, y) { draws.push(['drawImage', x, y]); },
    };
    const renderer = Object.create(IsometricRenderer.prototype);
    renderer.bridgeTiles = new Map([['3,7', { kind: 'plank', orientation: 'NS', bridgeId: 'north-farm-bridge' }]]);
    renderer.sprites = { drawSprite() { throw new Error('expected mirrored fallback for NS plank'); } };
    renderer.assets = {
        has: (id) => id === 'bridge.ew',
        get: (id) => (id === 'bridge.ew' ? { width: 64, height: 64 } : null),
        getDims: () => ({ w: 64, h: 64 }),
        getAnchor: () => [32, 32],
    };
    renderer._drawTerrainOverlayTiles(ctx);
    assert.deepEqual(draws, [
        ['save'],
        ['translate', -128, 0],
        ['scale', -1, 1],
        ['drawImage', -32, 128],
        ['restore'],
    ]);
});
