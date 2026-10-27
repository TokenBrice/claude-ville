import test from 'node:test';
import assert from 'node:assert/strict';

import { BUILDING_DEFS, VISIT_OVERFLOW_TILES } from '../../claudeville/src/config/buildings.js';
import { MAP_SIZE, TILE_HEIGHT, TILE_WIDTH } from '../../claudeville/src/config/constants.js';
import { AMBIENT_SCENIC_POINTS } from '../../claudeville/src/config/scenery.js';
import {
    APPROACH_FILES,
    COMMAND_QUEUE,
    PORTAL_SPAWN_TILE,
    REST_SEATS,
    REST_STANDS,
    VILLAGE_GATE,
} from '../../claudeville/src/config/townPlan.js';
import { Agent } from '../../claudeville/src/domain/entities/Agent.js';
import { Building } from '../../claudeville/src/domain/entities/Building.js';
import { AgentSprite, QUAY_PLACES } from '../../claudeville/src/presentation/character-mode/AgentSprite.js';
import { IsometricRenderer } from '../../claudeville/src/presentation/character-mode/IsometricRenderer.js';
import { Pathfinder } from '../../claudeville/src/presentation/character-mode/Pathfinder.js';
import { SceneryEngine } from '../../claudeville/src/presentation/character-mode/SceneryEngine.js';
import VisitTileAllocator, { standsOnFixture } from '../../claudeville/src/presentation/character-mode/VisitTileAllocator.js';

// VB-5 / VB-15 — every standing place a body is sent to is reachable on foot
// from the village gate, on the walk grid the renderer actually builds: its
// own terrain noise (a flat-noise grid misdraws shore tiles), the real
// buildings and bridges, then the Pathfinder closed to the gate's component.

const noise = Object.create(IsometricRenderer.prototype);
const terrainSeed = [];
for (let y = 0; y < MAP_SIZE; y++) for (let x = 0; x < MAP_SIZE; x++) terrainSeed.push(noise._tileNoise(x, y));
const buildings = new Map(BUILDING_DEFS.map((def) => [def.type, new Building(def)]));
const scenery = new SceneryEngine({
    world: { buildings },
    terrainSeed,
    tileNoise: (x, y) => noise._tileNoise(x, y),
    smoothNoise: (x, y, scale) => noise._smoothNoise(x, y, scale),
});
scenery.generateBridges();
const ground = scenery.getWalkabilityGrid();
const pathfinder = new Pathfinder(ground.slice());
pathfinder.keepReachableFrom(VILLAGE_GATE.inside);
const bridgeTiles = scenery.getBridgeTiles();
const gate = pathfinder.nearestWalkable(VILLAGE_GATE.inside.tileX, VILLAGE_GATE.inside.tileY, 8);
const keyOf = (tile) => `${Math.round(tile.tileX)},${Math.round(tile.tileY)}`;

// Walkable ground no route from the gate reaches, closed for routing (VB-15):
// the shore tile under the pier lantern, and the far north-west shore behind
// the farm's fences and the Archive. A new sealed pocket fails below.
const SEALED_POCKETS = Object.freeze([
    { label: 'the shore tile under the pier lantern', has: (x, y) => x === 25 && y === 22 },
    { label: 'the far north-west shore behind the farm', has: (x, y) => x <= 16 && y <= 17 },
]);

// Scenic loiter points that are open water today. The ambient picker skips
// them (dead destinations, not traps), and the quay places stand on the quay
// instead (VB-6). They stay a todo below, never a silent pass.
const KNOWN_GAPS = new Map([
    ['harbor-rail', 'the harbor-rail and harbor-ledger loiter points stand in open water (QUAY_PLACES stand on the quay: VB-6)'],
    ['harbor-ledger', 'the harbor-rail and harbor-ledger loiter points stand in open water (QUAY_PLACES stand on the quay: VB-6)'],
    ['lighthouse-shore', 'lighthouse-shore is open water on the live grid (the ambient picker skips it: dead, not a trap)'],
]);
function standingPlaces() {
    const places = [];
    const add = (tile, label) => places.push({ tileX: tile.tileX, tileY: tile.tileY, label });
    for (const def of BUILDING_DEFS) {
        add(def.entrance, `${def.type} entrance`);
        for (const tile of def.visitTiles || []) add(tile, `${def.type} visit slot`);
        for (const tile of VISIT_OVERFLOW_TILES[def.type] || []) add(tile, `${def.type} overflow slot`);
        for (const tile of APPROACH_FILES[def.type] || []) add(tile, `${def.type} approach file`);
    }
    for (const seat of REST_SEATS) add(seat, `rest seat ${seat.id}`);
    for (const [room, stand] of Object.entries(REST_STANDS)) for (const tile of stand.tiles) add(tile, `${room} rest stand`);
    for (const point of AMBIENT_SCENIC_POINTS) if (!KNOWN_GAPS.has(point.id)) add(point, `scenic point ${point.id}`);
    for (const slot of [...COMMAND_QUEUE.slots, ...COMMAND_QUEUE.overflow]) add(slot, 'command queue');
    add(VILLAGE_GATE.outside, 'gate arrival (outside)');
    add(PORTAL_SPAWN_TILE, 'portal arrival');
    return places;
}

function unreachable(place) {
    const tileX = Math.round(place.tileX);
    const tileY = Math.round(place.tileY);
    if (!pathfinder.isWalkable(tileX, tileY)) return 'blocked';
    const end = pathfinder.findPath(gate, { tileX, tileY }, bridgeTiles).at(-1);
    if (tileX === gate.tileX && tileY === gate.tileY) return null;
    return end?.tileX === tileX && end?.tileY === tileY ? null : 'unreachable';
}

test('the walk grid bodies route on is one component from the village gate (VB-15)', () => {
    assert.ok(gate, 'the village gate resolves to a walkable tile');
    const reached = new Set([keyOf(gate)]);
    const queue = [gate];
    for (let head = 0; head < queue.length; head++) {
        const { tileX: x, tileY: y } = queue[head];
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]]) {
            if (!pathfinder.isWalkable(x + dx, y + dy) || reached.has(`${x + dx},${y + dy}`)) continue;
            if (dx && dy && (!pathfinder.isWalkable(x + dx, y) || !pathfinder.isWalkable(x, y + dy))) continue;
            reached.add(`${x + dx},${y + dy}`);
            queue.push({ tileX: x + dx, tileY: y + dy });
        }
    }
    assert.equal(reached.size, pathfinder.walkableTiles.length, 'every routing node is reachable from the gate');
    for (let y = 0; y < MAP_SIZE; y++) {
        for (let x = 0; x < MAP_SIZE; x++) {
            if (ground[y * MAP_SIZE + x] !== 1 || pathfinder.isWalkable(x, y)) continue;
            assert.ok(SEALED_POCKETS.some((pocket) => pocket.has(x, y)), `${x},${y} is walkable ground in a new sealed pocket`);
        }
    }
});

test('every standing place is reachable on foot from the village gate (VB-5)', () => {
    const failures = [];
    for (const place of standingPlaces()) {
        const why = unreachable(place);
        if (why) failures.push(`${place.label} ${keyOf(place)} is ${why}`);
    }
    assert.deepEqual(failures, []);
});

// VB-6 — the quay a finished session waits on (and a quay errand's stop) is
// reachable, standable quay ground that reads as no work: off every visit
// slot, overflow slot, approach file, rest seat, rest stand and queue place.
test('QUAY_PLACES stand on reachable quay ground off every slot and fixture (VB-6)', () => {
    const claimed = new Set(standingPlaces().filter((place) => !place.label.startsWith('scenic point')).map(keyOf));
    const failures = [];
    assert.ok(QUAY_PLACES.length >= 1);
    for (const place of QUAY_PLACES) {
        for (const tile of place.visitTiles) {
            const why = unreachable(tile);
            if (why) failures.push(`${place.type} ${keyOf(tile)} is ${why}`);
            if (claimed.has(keyOf(tile))) failures.push(`${place.type} ${keyOf(tile)} is a claimed standing place`);
            if (standsOnFixture((tile.tileX - tile.tileY) * TILE_WIDTH / 2, (tile.tileX + tile.tileY) * TILE_HEIGHT / 2)) {
                failures.push(`${place.type} ${keyOf(tile)} stands inside a fixture box`);
            }
        }
    }
    assert.deepEqual(failures, []);
});

// VB-5 — with the salt crates at the causeway's end, the two pier slots stand
// clear of every fixture box again, so the allocator hands them out.
test('the allocator hands out both Harbor pier slots (VB-5)', () => {
    const allocator = new VisitTileAllocator();
    allocator.updateContext({ buildings, agentSprites: [], pathfinder });
    const harbor = buildings.get('harbor');
    const taken = new Set();
    for (let i = 0; i < harbor.visitTiles.length + 4; i++) {
        const reservation = allocator.allocate({ agent: { id: `pier-${i}` }, building: harbor });
        if (reservation) taken.add(keyOf(reservation));
    }
    for (const pier of ['26,21', '27,21']) assert.ok(taken.has(pier), `the allocator uses the pier slot ${pier}`);
});

test('the water scenic points are reachable', { todo: [...new Set(KNOWN_GAPS.values())].join('; ') }, () => {
    const failures = [];
    for (const point of AMBIENT_SCENIC_POINTS) {
        const why = KNOWN_GAPS.has(point.id) ? unreachable(point) : null;
        if (why) failures.push(`scenic point ${point.id} ${keyOf(point)} is ${why}`);
    }
    assert.deepEqual(failures, []);
});

test('a body the renderer places runs no route search in its constructor (VB-15)', () => {
    const allocator = new VisitTileAllocator();
    allocator.updateContext({ buildings, agentSprites: [], pathfinder });
    let searches = 0;
    const counting = Object.create(pathfinder);
    counting.findPath = (...args) => { searches++; return pathfinder.findPath(...args); };
    const options = {
        pathfinder: counting,
        bridgeTiles,
        getBuilding: (type) => buildings.get(type),
        allocateVisitTile: (request) => allocator.allocate({ ...request, building: request.building || buildings.get(request.intent?.building) }) || null,
        releaseVisitReservation: (id) => allocator.release?.(id),
        renewVisitReservation: (id) => allocator.renew?.(id),
        getRoadTiles: () => new Set(),
        getRoutingContext: () => ({ laneTiles: new Map(), ...allocator.getCongestionSnapshot() }),
        getDayHour: () => 15,
    };
    const agent = (id) => new Agent({ id, name: id, provider: 'claude', model: 'claude-sonnet-4-5', status: 'working', currentTool: 'Edit' });
    new AgentSprite(agent('placed'), { ...options, deferInitialTarget: true });
    assert.equal(searches, 0, 'the gate arrival picks its route, not the constructor');
    new AgentSprite(agent('standalone'), options);
    assert.ok(searches > 0, 'a standalone sprite still picks a target at once');
});

// Boot residents in the gate mouth: the east gate lane's entry rounds to tile
// 20,39, off the walk grid. A lane walk starts on its entry anyway (the path
// snap had lifted every east-lane walker onto 20,38, where they stacked and
// the entry queue saw that lane clear), and it finishes the lane before any
// reroute, so its gate transit ends at the arch, not at its work.
test('a gate lane walk starts on its entry and finishes before the body reroutes', () => {
    const allocator = new VisitTileAllocator();
    const options = {
        pathfinder,
        bridgeTiles,
        getBuilding: (type) => buildings.get(type),
        allocateVisitTile: (request) => allocator.allocate({ ...request, building: request.building || buildings.get(request.intent?.building) }) || null,
        releaseVisitReservation: (id) => allocator.release?.(id),
        renewVisitReservation: (id) => allocator.renew?.(id),
        getRoadTiles: () => new Set(),
        getRoutingContext: () => ({ laneTiles: new Map(), ...allocator.getCongestionSnapshot() }),
        getDayHour: () => 15,
        deferInitialTarget: true,
    };
    const toWorld = (tileX, tileY) => ({
        x: (tileX - tileY) * TILE_WIDTH / 2,
        y: (tileX + tileY) * TILE_HEIGHT / 2,
    });
    assert.equal(pathfinder.isWalkable(20, 39), false, 'the east lane entry tile is off the grid');
    for (const laneX of [18.65, 19.55]) {
        const id = `lane-${laneX}`;
        const sprite = new AgentSprite(new Agent({
            id, name: id, provider: 'claude', model: 'claude-sonnet-4-5', status: 'working',
            currentTool: 'Edit', currentToolInput: { file_path: 'src/lane.js' },
        }), options);
        sprite.setTilePosition(laneX, 39.35);
        sprite.walkStraightToTile(laneX, 37.6);
        const entry = toWorld(laneX, 39.35);
        const inside = toWorld(laneX, 37.6);
        assert.ok(Math.hypot(sprite.x - entry.x, sprite.y - entry.y) < 0.01, `${laneX}: the walk starts on its entry`);
        let frames = 0;
        while (sprite.moving && frames++ < 600) {
            sprite.update(null, 1000 / 60);
            if (sprite.moving) {
                assert.ok(Math.hypot(sprite.targetX - inside.x, sprite.targetY - inside.y) < 0.01, `${laneX}: no reroute mid-lane`);
            }
        }
        assert.equal(sprite.moving, false, `${laneX}: the lane walk ends`);
        assert.ok(sprite.hasReachedTarget(), `${laneX}: on the lane's inside point`);
        // The renderer's hand-off at the arch (gate transit end): on to work.
        sprite.waitTimer = 0;
        sprite.update(null, 1000 / 60);
        assert.equal(sprite.moving, true, `${laneX}: then it walks on to its work`);
        assert.ok(Math.hypot(sprite.targetX - inside.x, sprite.targetY - inside.y) > 1, `${laneX}: toward its work`);
    }
});
