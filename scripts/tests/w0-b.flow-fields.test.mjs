import test from 'node:test';
import assert from 'node:assert/strict';

import { BUILDING_DEFS } from '../../claudeville/src/config/buildings.js';
import { MAP_SIZE } from '../../claudeville/src/config/constants.js';
import { VILLAGE_GATE } from '../../claudeville/src/config/townPlan.js';
import { Building } from '../../claudeville/src/domain/entities/Building.js';
import { AgentSprite } from '../../claudeville/src/presentation/character-mode/AgentSprite.js';
import { IsometricRenderer } from '../../claudeville/src/presentation/character-mode/IsometricRenderer.js';
import {
    FLOW_REBUILD_WINDOW_MS,
    FLOW_TRACE_STEP_LIMIT,
    Pathfinder,
    ROUTE_PERSONALITIES,
    SINK_COUNT,
    SINK_IDS,
    SINK_NAMES,
} from '../../claudeville/src/presentation/character-mode/Pathfinder.js';
import { SceneryEngine } from '../../claudeville/src/presentation/character-mode/SceneryEngine.js';
import { VisitTileAllocator } from '../../claudeville/src/presentation/character-mode/VisitTileAllocator.js';

// W0.2 — numeric sink flow fields: flat typed-array routing layers, 16
// semantic sinks rebuilt by backward multi-source Dijkstra once per crowd
// window, an O(8) personality lookup, and A* (field-guided for a sink's
// other seeds, octile for ad-hoc tiles) behind the unchanged findPath API.

const CELLS = MAP_SIZE * MAP_SIZE;
const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]];
const keyOf = (tile) => `${tile.tileX},${tile.tileY}`;
const quiet = (fn) => {
    const warn = console.warn;
    console.warn = () => {};
    try { return fn(); } finally { console.warn = warn; }
};

// Synthetic maps start with no sinks, so only the seeds a test registers
// can answer a lookup (the town's config seeds would land on open tiles).
function syntheticPathfinder(grid, options) {
    const pathfinder = new Pathfinder(grid, options);
    for (let sink = 0; sink < SINK_COUNT; sink++) pathfinder.setSinkTiles(sink, []);
    return pathfinder;
}

function gridWith(predicate) {
    const grid = new Uint8Array(CELLS);
    for (let y = 0; y < MAP_SIZE; y++) for (let x = 0; x < MAP_SIZE; x++) grid[y * MAP_SIZE + x] = predicate(x, y) ? 1 : 0;
    return grid;
}

// The renderer's own world: terrain noise, buildings, bridges, the gate's
// walk component, its road tiles (bridges included) and its lane index.
let realWorldCache = null;
function realWorld() {
    if (realWorldCache) return realWorldCache;
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
    const grid = scenery.getWalkabilityGrid();
    realWorldCache = { buildings, grid, bridgeTiles, roadTiles: renderer.pathTiles, laneTiles };
    return realWorldCache;
}

function realPathfinder(options) {
    const world = realWorld();
    const pathfinder = new Pathfinder(world.grid.slice(), options);
    pathfinder.keepReachableFrom(VILLAGE_GATE.inside);
    return pathfinder;
}

// Deterministic crowd: `count` bodies on walkable tiles, about half standing.
function crowdSnapshot(pathfinder, count, seed = 1) {
    let state = seed >>> 0;
    const rnd = () => ((state = (Math.imul(state, 1103515245) + 12345) >>> 0) / 4294967296);
    const allocator = new VisitTileAllocator();
    const walk = pathfinder.walkableTiles;
    for (let i = 0; i < count; i++) {
        const tile = walk[Math.floor(rnd() * walk.length)];
        const key = keyOf(tile);
        const bucket = allocator._occupancyBuckets.get(key) || [];
        bucket.push({ moving: rnd() < 0.5, pending: false });
        allocator._occupancyBuckets.set(key, bucket);
    }
    return allocator.getCongestionSnapshot(10_000);
}

// AgentSprite's own long-trip options (roads, lanes, plazas, bridges,
// crowd, personality), exactly as a villager passes them.
function productionRouter(snapshot) {
    const world = realWorld();
    const sprite = Object.assign(Object.create(AgentSprite.prototype), {
        getRoadTiles: () => world.roadTiles,
        bridgeTiles: world.bridgeTiles,
        getRoutingContext: () => ({ laneTiles: world.laneTiles, ...snapshot }),
    });
    return (id, from, to) => {
        sprite.agent = { id };
        return sprite._pathOptions(from, to);
    };
}

function rng(seed) {
    let state = seed >>> 0;
    return () => ((state = (Math.imul(state, 1103515245) + 12345) >>> 0) / 4294967296);
}

function legalStep(pathfinder, ax, ay, bx, by) {
    const dx = bx - ax;
    const dy = by - ay;
    if (Math.max(Math.abs(dx), Math.abs(dy)) !== 1) return false;
    if (!pathfinder.isWalkable(bx, by)) return false;
    if (dx !== 0 && dy !== 0 && (!pathfinder.isWalkable(ax + dx, ay) || !pathfinder.isWalkable(ax, ay + dy))) return false;
    return true;
}

// A weighted route is `_simplify`'s corners: every segment runs along one
// of the eight directions, so it expands back to its exact tile walk.
function expandWeighted(from, waypoints) {
    const tiles = [];
    let x = from.tileX;
    let y = from.tileY;
    for (const point of waypoints) {
        const dx = point.tileX - x;
        const dy = point.tileY - y;
        assert.ok(dx === 0 || dy === 0 || Math.abs(dx) === Math.abs(dy), `segment (${x},${y})->(${point.tileX},${point.tileY}) is not an 8-way run`);
        while (x !== point.tileX || y !== point.tileY) {
            x += Math.sign(point.tileX - x);
            y += Math.sign(point.tileY - y);
            tiles.push({ tileX: x, tileY: y });
        }
    }
    return tiles;
}

function assertLegalWalk(pathfinder, from, tiles, label) {
    let prev = from;
    const seen = new Set([keyOf(from)]);
    for (const tile of tiles) {
        assert.ok(legalStep(pathfinder, prev.tileX, prev.tileY, tile.tileX, tile.tileY),
            `${label}: illegal step (${prev.tileX},${prev.tileY})->(${tile.tileX},${tile.tileY})`);
        assert.ok(!seen.has(keyOf(tile)), `${label}: revisits ${keyOf(tile)}`);
        seen.add(keyOf(tile));
        prev = tile;
    }
}

function reachableFrom(pathfinder, start) {
    const reached = new Set([keyOf(start)]);
    const queue = [start];
    for (let head = 0; head < queue.length; head++) {
        const { tileX: x, tileY: y } = queue[head];
        for (const [dx, dy] of DIRS) {
            if (!legalStep(pathfinder, x, y, x + dx, y + dy) || reached.has(`${x + dx},${y + dy}`)) continue;
            reached.add(`${x + dx},${y + dy}`);
            queue.push({ tileX: x + dx, tileY: y + dy });
        }
    }
    return reached;
}

test('flat typed-array layers, 16 semantic sinks and a footprint under 140 KiB', () => {
    const pathfinder = realPathfinder();
    const layout = {
        staticFlags: Uint8Array, bridgeIdGrid: Uint8Array, baseCostLayer: Float32Array, tierGrid: Uint8Array,
        standingGrid: Uint8Array, congestionRaw: Uint8Array, congestionBlur: Float32Array,
        heapCost: Float32Array, visited: Uint8Array,
    };
    for (const [name, type] of Object.entries(layout)) {
        assert.ok(pathfinder[name] instanceof type, `${name} is a ${type.name}`);
        assert.equal(pathfinder[name].length, CELLS, `${name} covers every tile`);
    }
    assert.equal(pathfinder.heapIdx.length, CELLS);
    assert.ok(pathfinder.tierGrid.every((tier) => tier === 0), 'Wave 6 tiers start flat');
    assert.ok(pathfinder.sinkIntegration instanceof Float32Array);
    assert.equal(pathfinder.sinkIntegration.length, SINK_COUNT * CELLS);
    assert.equal(SINK_COUNT, 16);
    assert.deepEqual(SINK_NAMES.slice(0, 9), ['command', 'taskboard', 'forge', 'mine', 'archive', 'tavern', 'portal', 'watchtower', 'harbor']);
    assert.deepEqual(SINK_NAMES.slice(9), ['command-queue', 'rest:tavern-garden', 'rest:plaza-steps', 'rest:harbor-pier', 'village-gate', 'north-island', 'portal-exit']);
    const bytes = pathfinder.getMemoryFootprint();
    assert.ok(bytes < 140 * 1024, `routing grid holds ${bytes} B (< 140 KiB)`);
    assert.equal(pathfinder.getDiagnostics().memoryBytes, bytes);
    assert.equal(pathfinder.getDiagnostics().cacheLimit, 384);

    const gate = pathfinder.nearestWalkable(VILLAGE_GATE.inside.tileX, VILLAGE_GATE.inside.tileY, 8);
    for (let sink = 0; sink < SINK_COUNT; sink++) {
        const seeds = pathfinder.getSinkTiles(sink).filter((tile) => pathfinder.isWalkable(tile.tileX, tile.tileY));
        assert.ok(seeds.length > 0, `${SINK_NAMES[sink]} has a walkable seed on the live map`);
        assert.ok(Number.isFinite(pathfinder.sinkCostAt(sink, gate.tileX, gate.tileY)), `${SINK_NAMES[sink]} is reachable from the gate`);
        for (const seed of seeds) assert.equal(pathfinder.sinkCostAt(sink, seed.tileX, seed.tileY), 0);
    }
});

test('reachability parity: every walkable tile resolves from the gate in every routing mode', () => {
    const pathfinder = realPathfinder();
    const { bridgeTiles } = realWorld();
    const route = productionRouter(crowdSnapshot(pathfinder, 37, 7));
    const gate = pathfinder.nearestWalkable(VILLAGE_GATE.inside.tileX, VILLAGE_GATE.inside.tileY, 8);
    const reached = reachableFrom(pathfinder, gate);
    assert.equal(reached.size, pathfinder.walkableTiles.length, 'the routing grid is one component');
    const failures = [];
    for (const target of pathfinder.walkableTiles) {
        if (target.tileX === gate.tileX && target.tileY === gate.tileY) continue;
        const weighted = pathfinder.findPath(gate, target, bridgeTiles, route(`parity-${keyOf(target)}`, gate, target));
        const bare = pathfinder.findPath(gate, target, bridgeTiles);
        const unweighted = pathfinder.findPath(gate, target, null, null);
        for (const [mode, path] of [['weighted', weighted], ['bridges', bare], ['unweighted', unweighted]]) {
            const end = path.at(-1);
            if (!end || end.tileX !== target.tileX || end.tileY !== target.tileY) failures.push(`${mode} ${keyOf(target)}`);
        }
        assertLegalWalk(pathfinder, gate, expandWeighted(gate, weighted), `weighted ${keyOf(target)}`);
        let prev = gate;
        for (const point of unweighted) {
            assert.ok(pathfinder._lineWalkable(prev.tileX, prev.tileY, point.tileX, point.tileY), `unweighted ${keyOf(target)} segment stays walkable`);
            prev = point;
        }
    }
    assert.deepEqual(failures, []);
    const flow = pathfinder.getDiagnostics().flow;
    assert.ok(flow.sinkLookups > 0 && flow.adhocSearches > 0, 'both sink and ad-hoc lookups ran');
});

test('bridge decks and landings stay explicit waypoints on flow-field routes', () => {
    const pathfinder = realPathfinder();
    const { bridgeTiles } = realWorld();
    const route = productionRouter(crowdSnapshot(pathfinder, 24, 3));
    const crossing = (key) => bridgeTiles.has(key) && bridgeTiles.get(key)?.kind !== 'dock';
    const random = rng(99);
    const walk = pathfinder.walkableTiles;
    let crossings = 0;
    for (let i = 0; i < 300; i++) {
        const from = walk[Math.floor(random() * walk.length)];
        const sink = Math.floor(random() * SINK_COUNT);
        const seeds = pathfinder.getSinkTiles(sink).filter((tile) => pathfinder.isWalkable(tile.tileX, tile.tileY));
        const to = seeds[Math.floor(random() * seeds.length)];
        const path = pathfinder.findPath(from, to, bridgeTiles, route(`bridge-${i}`, from, to));
        const explicit = new Set(path.map(keyOf));
        const tiles = expandWeighted(from, path);
        tiles.forEach((tile, index) => {
            const key = keyOf(tile);
            const landing = [tiles[index - 1], tiles[index + 1]].some((next) => next && crossing(keyOf(next)));
            if (bridgeTiles.has(key) || landing) {
                assert.ok(explicit.has(key), `${keyOf(from)}->${keyOf(to)} keeps ${key} explicit`);
                if (crossing(key)) crossings++;
            }
        });
    }
    assert.ok(crossings > 0, 'some routes crossed a bridge');
});

test('diagonal corner-cut guard: no route, trace or flow step squeezes between blocked corners', () => {
    // A diagonal wall (x, x) for x 5..25: crossing it needs a corner cut, so
    // every legal route walks around one of its ends.
    const grid = gridWith((x, y) => !(x === y && x >= 5 && x <= 25) && !(x === 30 && y === 29) && !(x === 29 && y === 30)
        && !(x === 31 && y === 30) && !(x === 30 && y === 31));
    const pathfinder = syntheticPathfinder(grid);
    for (let y = 0; y < MAP_SIZE; y++) {
        for (let x = 0; x < MAP_SIZE; x++) {
            const bits = pathfinder.stepMask[y * MAP_SIZE + x];
            DIRS.forEach(([dx, dy], dir) => {
                const expected = pathfinder.isWalkable(x, y) && legalStep(pathfinder, x, y, x + dx, y + dy);
                assert.equal(!!(bits & (1 << dir)), expected, `step mask (${x},${y}) dir ${dir}`);
            });
        }
    }
    const from = { tileX: 10, tileY: 20 };
    const sinkTarget = { tileX: 20, tileY: 10 };
    const adhocTarget = { tileX: 21, tileY: 9 };
    pathfinder.setSinkTiles(SINK_IDS['portal-exit'], [sinkTarget]);
    const options = { preferRoads: true, roadTiles: new Set(['10,10', '11,11']) };
    for (const [label, to, opts] of [['sink', sinkTarget, options], ['ad-hoc', adhocTarget, options], ['unweighted', adhocTarget, null]]) {
        const path = pathfinder.findPath(from, to, new Map(), opts);
        assert.deepEqual(path.at(-1), to, `${label} route arrives`);
        if (opts) assertLegalWalk(pathfinder, from, expandWeighted(from, path), label);
        let prev = from;
        for (const point of path) {
            assert.ok(pathfinder._lineWalkable(prev.tileX, prev.tileY, point.tileX, point.tileY), `${label} segment is walkable`);
            prev = point;
        }
    }
    // The O(8) lookup never offers a corner cut either.
    let cur = { ...from };
    for (let steps = 0; steps < 200; steps++) {
        const dir = pathfinder.sampleFlowDirection('portal-exit', cur.tileX, cur.tileY, 0);
        if (dir < 0) break;
        const next = { tileX: cur.tileX + DIRS[dir][0], tileY: cur.tileY + DIRS[dir][1] };
        assert.ok(legalStep(pathfinder, cur.tileX, cur.tileY, next.tileX, next.tileY), `flow step (${keyOf(cur)})->(${keyOf(next)})`);
        cur = next;
    }
    assert.deepEqual(cur, sinkTarget, 'the flow field descends onto its seed');
    // A tile reachable only by corner cutting is a sealed pocket.
    assert.ok(pathfinder.isWalkable(30, 30));
    assert.ok(pathfinder.keepReachableFrom({ tileX: 0, tileY: 0 }) >= 1);
    assert.equal(pathfinder.isWalkable(30, 30), false, 'the diagonal-only pocket closes');
});

// A river on rows 10..12 with a west deck at x = 8 and an east deck at x = 14.
function riverWorld(clock) {
    const decks = new Map();
    for (const [x, bridgeId] of [[8, 'west-river'], [14, 'east-river']]) {
        for (let y = 10; y <= 12; y++) decks.set(`${x},${y}`, { bridgeId, kind: 'landmark', orientation: 'NS' });
    }
    const grid = gridWith((x, y) => x <= 30 && (y < 10 || y > 12 || decks.has(`${x},${y}`)));
    return { pathfinder: syntheticPathfinder(grid, { clock }), decks };
}
const crossesAt = (from, path, x) => expandWeighted(from, path).some((tile) => tile.tileX === x && tile.tileY === 11);

test('bridge splitting: a congested deck sends routes over the other crossing', () => {
    let now = 50_000;
    const { pathfinder, decks } = riverWorld(() => now);
    const from = { tileX: 7, tileY: 4 };
    const to = { tileX: 9, tileY: 18 };
    const adhoc = { tileX: 10, tileY: 19 };
    pathfinder.setSinkTiles('rest:harbor-pier', [to]);
    const roadTiles = new Set(['0,0']);
    const calm = { preferRoads: true, roadTiles, bridgeTiles: decks };
    assert.ok(crossesAt(from, pathfinder.findPath(from, to, decks, calm), 8), 'a calm crowd takes the near west deck');
    assert.ok(crossesAt(from, pathfinder.findPath(from, adhoc, decks, calm), 8));
    const calmWest = pathfinder.sinkCostAt('rest:harbor-pier', 8, 9);
    const calmEast = pathfinder.sinkCostAt('rest:harbor-pier', 14, 9);

    const jam = new Map([['8,10', 8], ['8,11', 8], ['8,12', 8]]);
    const crowded = { ...calm, congestionTiles: jam };
    // Same window: the sink field is stale, so the lookup runs A* on the new crowd.
    const before = pathfinder.getDiagnostics().flow;
    const sameWindow = pathfinder.findPath(from, to, decks, crowded);
    assert.ok(crossesAt(from, sameWindow, 14), 'the jammed west deck splits the walk east');
    const deferred = pathfinder.getDiagnostics().flow;
    assert.equal(deferred.rebuilds, before.rebuilds, 'no second crowd rebuild inside one window');
    assert.equal(deferred.staleFieldFallbacks, before.staleFieldFallbacks + 1);
    // Next window: the field rebuilds once with the congestion field.
    now += FLOW_REBUILD_WINDOW_MS;
    const nextWindow = pathfinder.findPath(from, to, decks, crowded);
    assert.ok(crossesAt(from, nextWindow, 14));
    assert.equal(pathfinder.getDiagnostics().flow.rebuilds, before.rebuilds + 1);
    const adhocBefore = pathfinder.getDiagnostics().flow.adhocSearches;
    assert.ok(crossesAt(from, pathfinder.findPath(from, adhoc, decks, crowded), 14), 'ad-hoc routes split too');
    assert.equal(pathfinder.getDiagnostics().flow.adhocSearches, adhocBefore + 1);
    assert.ok(pathfinder.sinkCostAt('rest:harbor-pier', 8, 9) > calmWest + 1, 'the rebuilt field carries the jam onto the west landing');
    assert.ok(Math.abs(pathfinder.sinkCostAt('rest:harbor-pier', 14, 9) - calmEast) < 1e-4, 'the east crossing is untouched');

    // The Gaussian field (r 2, sigma 1.15) spreads the jam onto the approaches.
    const deck = pathfinder.congestionCostAt(8, 11);
    const landing = pathfinder.congestionCostAt(8, 9);
    const far = pathfinder.congestionCostAt(8, 6);
    assert.ok(Math.abs(deck - 2.6) < 1e-6, 'a jammed bridge deck tile caps at 2.6 (bridgeCongestionMax)');
    assert.ok(landing > 0 && landing <= deck, 'the landing shares the jam');
    assert.equal(far, 0, 'beyond the kernel radius the field is clear');
});

test('route personalities: profiles prefer their own surfaces and authored bridges', () => {
    // A two-way fork below S (10,10): a plaza tile west, a road tile east,
    // symmetric grass corridors down to T (10,14); (10,11..13) is a wall.
    const open = new Set(['10,10', '10,14', '10,15']);
    for (let y = 10; y <= 14; y++) { open.add(`9,${y}`); open.add(`11,${y}`); }
    const pathfinder = syntheticPathfinder(gridWith((x, y) => open.has(`${x},${y}`)));
    const start = { tileX: 10, tileY: 10 };
    const sinkTarget = { tileX: 10, tileY: 14 };
    const adhocTarget = { tileX: 10, tileY: 15 };
    pathfinder.setSinkTiles('portal-exit', [sinkTarget]);
    const plazaTiles = new Set(['9,10']);
    const roadTiles = new Set(['11,10']);
    const firstStep = (bucket, to) => pathfinder.findPath(start, to, new Map(), {
        preferRoads: true, roadTiles, plazaTiles, personalityBucket: bucket, weights: ROUTE_PERSONALITIES[bucket],
    })[0];
    // Bucket 0 trims road weights, bucket 1 plaza weights (±8%).
    assert.deepEqual(firstStep(0, sinkTarget), { tileX: 11, tileY: 10 }, 'road-loving profile takes the road branch');
    assert.deepEqual(firstStep(1, sinkTarget), { tileX: 9, tileY: 10 }, 'plaza-loving profile takes the plaza branch');
    assert.deepEqual(firstStep(0, adhocTarget), { tileX: 11, tileY: 10 });
    assert.deepEqual(firstStep(1, adhocTarget), { tileX: 9, tileY: 10 });
    const lookups = pathfinder.getDiagnostics().flow;
    assert.equal(lookups.traceHits, 2, 'the sink trips were answered by the O(8) trace');
    assert.equal(lookups.adhocSearches, 2, 'the off-sink trips by octile A*');
    // The O(8) lookup itself: same field, different personality deltas.
    assert.equal(pathfinder.sampleFlowDirection('portal-exit', 10, 10, 0), 0, 'east (+x)');
    assert.equal(pathfinder.sampleFlowDirection('portal-exit', 10, 10, 1), 1, 'west (-x)');
    assert.equal(pathfinder.sampleFlowDirection('portal-exit', 10, 10, null), 0, 'the neutral field prefers the cheaper road');
    assert.equal(pathfinder.sampleFlowDirection('portal-exit', 10, 14, 0), -1, 'a seed has no next step');

    // Alternate authored bridges: from a point equidistant between two
    // decks, each profile crosses the bridge it prefers.
    const { pathfinder: river, decks } = riverWorld(() => 0);
    const from = { tileX: 11, tileY: 4 };
    const to = { tileX: 11, tileY: 18 };
    const roads = new Set(['0,0']);
    for (const [preferredBridgeId, x] of [['west-river', 8], ['east-river', 14]]) {
        const path = river.findPath(from, to, decks, { preferRoads: true, roadTiles: roads, bridgeTiles: decks, preferredBridgeId, weights: ROUTE_PERSONALITIES[0] });
        assert.ok(crossesAt(from, path, x), `${preferredBridgeId} profile crosses at x ${x}`);
    }
});

test('cycle safety: the trace is capped at 128 strictly-descending steps and A* finishes the route', () => {
    // A serpentine: rows 1, 3, ..., 37 open from x 1..38, joined at
    // alternating ends — the walk to the far end is ~700 steps.
    const open = (x, y) => {
        if (x < 1 || x > 38 || y < 1 || y > 37) return false;
        if (y % 2 === 1) return true;
        const row = (y - 2) / 2;
        return row % 2 === 0 ? x === 38 : x === 1;
    };
    const pathfinder = syntheticPathfinder(gridWith(open));
    const from = { tileX: 1, tileY: 1 };
    const to = { tileX: 38, tileY: 37 };
    pathfinder.setSinkTiles('portal-exit', [to]);
    const options = { preferRoads: true, roadTiles: new Set(['1,1']) };
    const path = pathfinder.findPath(from, to, new Map(), options);
    assert.deepEqual(path.at(-1), to);
    const tiles = expandWeighted(from, path);
    assert.ok(tiles.length > FLOW_TRACE_STEP_LIMIT, `the walk (${tiles.length} steps) outruns the trace cap`);
    assertLegalWalk(pathfinder, from, tiles, 'serpentine');
    const flow = pathfinder.getDiagnostics().flow;
    assert.equal(flow.traceHits, 0, 'the capped trace hands over');
    assert.equal(flow.guidedSearches, 1, 'the field-guided A* finished the route');

    // Flow steps strictly descend, so a walk of samples can never loop.
    let cur = { ...from };
    let cost = pathfinder.sinkCostAt('portal-exit', cur.tileX, cur.tileY);
    const seen = new Set([keyOf(cur)]);
    for (let steps = 0; steps < 2000; steps++) {
        const dir = pathfinder.sampleFlowDirection('portal-exit', cur.tileX, cur.tileY, 2);
        if (dir < 0) break;
        cur = { tileX: cur.tileX + DIRS[dir][0], tileY: cur.tileY + DIRS[dir][1] };
        const next = pathfinder.sinkCostAt('portal-exit', cur.tileX, cur.tileY);
        assert.ok(next < cost, 'every flow step lowers the integrated cost');
        assert.ok(!seen.has(keyOf(cur)), 'no tile repeats');
        seen.add(keyOf(cur));
        cost = next;
    }
    assert.deepEqual(cur, to);

    // A corrupted plateau (no descending neighbour) stops the lookup cold and
    // findPath still returns a legal route.
    const field = pathfinder.sinkIntegration.subarray(SINK_IDS['portal-exit'] * CELLS, (SINK_IDS['portal-exit'] + 1) * CELLS);
    for (let index = 0; index < CELLS; index++) if (field[index] > 0 && field[index] !== Infinity) field[index] = 5;
    assert.equal(pathfinder.sampleFlowDirection('portal-exit', 20, 1, 0), -1);
    const repaired = pathfinder.findPath({ tileX: 20, tileY: 1 }, to, new Map(), options);
    assert.deepEqual(repaired.at(-1), to);
    assertLegalWalk(pathfinder, { tileX: 20, tileY: 1 }, expandWeighted({ tileX: 20, tileY: 1 }, repaired), 'plateau');
});

test('FNV-1a dirty check: unchanged occupancy never rebuilds a sink, a change rebuilds once per window', () => {
    let now = 1_000_000;
    const pathfinder = realPathfinder({ clock: () => now });
    const { bridgeTiles, roadTiles, laneTiles } = realWorld();
    const forge = pathfinder.getSinkTiles('forge')
        .filter((tile) => pathfinder.isWalkable(tile.tileX, tile.tileY) && pathfinder.sinkIdAt(tile.tileX, tile.tileY) === SINK_IDS.forge);
    assert.ok(forge.length >= 2);
    const from = { tileX: 20, tileY: 37 };
    const standing = ['21,30', '22,26', '19,33'];
    const congestion = [['21,30', 4], ['22,26', 2]];
    const options = (extra = []) => ({
        preferRoads: true, roadTiles, preferredTiles: roadTiles, laneTiles, bridgeTiles,
        standingTiles: new Set([...standing, ...extra]),
        congestionTiles: new Map(congestion),
        personalityBucket: 1, weights: ROUTE_PERSONALITIES[1],
    });
    pathfinder.findPath(from, forge[0], bridgeTiles, options());
    const first = pathfinder.getDiagnostics().flow;
    assert.ok(first.rebuilds >= 1);
    for (let i = 0; i < 20; i++) {
        now += FLOW_REBUILD_WINDOW_MS + 500;
        // Fresh Set/Map objects with identical content, across new windows.
        const path = pathfinder.findPath(from, forge[i % forge.length], bridgeTiles, options());
        assert.ok(path.length > 0);
    }
    const steady = pathfinder.getDiagnostics().flow;
    assert.equal(steady.rebuilds, first.rebuilds, 'an unchanged fingerprint costs 0 rebuilds');
    assert.ok(steady.crowdIngests > first.crowdIngests, 'new objects were re-read');
    assert.equal(steady.crowdChanges, first.crowdChanges, 'but their fingerprint never changed');
    assert.equal(steady.staleFieldFallbacks, 0);

    // A new standing body: same window defers, next window rebuilds once.
    pathfinder.findPath(from, forge[0], bridgeTiles, options(['20,30']));
    pathfinder.findPath(from, forge[1], bridgeTiles, options(['20,30']));
    const changed = pathfinder.getDiagnostics().flow;
    assert.equal(changed.crowdChanges, steady.crowdChanges + 1);
    assert.equal(changed.rebuilds, steady.rebuilds + 1, 'the new crowd rebuilds the forge sink once');
    now += 100;
    pathfinder.findPath(from, forge[0], bridgeTiles, options(['20,31']));
    const deferred = pathfinder.getDiagnostics().flow;
    assert.equal(deferred.rebuilds, changed.rebuilds, 'a second change inside the window waits');
    assert.equal(deferred.staleFieldFallbacks, changed.staleFieldFallbacks + 1);
    now += FLOW_REBUILD_WINDOW_MS;
    pathfinder.findPath(from, forge[0], bridgeTiles, options(['20,31']));
    assert.equal(pathfinder.getDiagnostics().flow.rebuilds, deferred.rebuilds + 1);
});

test('congestion snapshots fingerprint occupancy without sorting and carry unchanged windows over', () => {
    const allocator = new VisitTileAllocator();
    allocator._occupancyBuckets.set('12,1', [{ moving: false }]);
    allocator._occupancyBuckets.set('3,5', [{ moving: false }, { moving: true }, { moving: true }]);
    allocator._occupancyBuckets.set('30,2', [{ moving: true }]);
    const first = allocator.getCongestionSnapshot(2000);
    assert.deepEqual(Object.keys(first).sort(), [
        'bucket', 'congestionGrid', 'congestionTiles', 'congestionVersion', 'occupancyFingerprint',
        'standingGrid', 'standingTiles', 'standingVersion',
    ]);
    assert.equal(first.standingVersion, '12,1;3,5', 'standing keys in tile order');
    assert.match(first.congestionVersion, /^fnv:[0-9a-f]{8}$/);
    assert.equal(first.congestionTiles.get('3,5'), 4);
    assert.equal(first.standingGrid[1 * MAP_SIZE + 12], 1);
    assert.equal(first.congestionGrid[5 * MAP_SIZE + 3], 4);
    assert.ok(Number.isInteger(first.occupancyFingerprint) && first.occupancyFingerprint >= 0);
    // A new window over the same occupancy (inserted in another order).
    allocator._occupancyBuckets = new Map([...allocator._occupancyBuckets].reverse());
    const carried = allocator.getCongestionSnapshot(4000);
    assert.notEqual(carried, first);
    assert.equal(carried.bucket, 2);
    assert.equal(carried.congestionTiles, first.congestionTiles, 'maps carry over');
    assert.equal(carried.standingTiles, first.standingTiles);
    assert.equal(carried.congestionVersion, first.congestionVersion);
    assert.equal(carried.standingVersion, first.standingVersion);
    // A body stops walking: the fingerprint moves even though counts hold.
    allocator._occupancyBuckets.set('30,2', [{ moving: false }]);
    const moved = allocator.getCongestionSnapshot(6000);
    assert.notEqual(moved.occupancyFingerprint, first.occupancyFingerprint);
    assert.equal(moved.congestionVersion, first.congestionVersion, 'congestion counts are unchanged');
    assert.equal(moved.standingVersion, '12,1;30,2;3,5');
    assert.equal(new VisitTileAllocator().getCongestionSnapshot(0).congestionVersion, '');
});

test('the allocator registers live building sinks and ranks slots by canal-aware walk cost', () => {
    // A canal at x = 10 (y 0..30): the east slot is two tiles away as the
    // crow flies but a walk around the canal's south end; the west slot is
    // seven tiles down the same bank.
    const pathfinder = syntheticPathfinder(gridWith((x, y) => !(x === 10 && y <= 30)));
    const source = { tileX: 9, tileY: 5 };
    pathfinder.setSinkTiles('village-gate', [source]);
    const across = { tileX: 11, tileY: 5 };
    const sameBank = { tileX: 9, tileY: 12 };
    const building = { type: 'forge', visitTiles: [across, sameBank] };
    const allocate = (finder) => {
        const allocator = new VisitTileAllocator();
        allocator.updateContext({ buildings: new Map([['forge', building]]), agentSprites: [], pathfinder: finder });
        for (const tile of [across, sameBank]) assert.ok(allocator._isStandable(tile.tileX, tile.tileY), `${keyOf(tile)} is standable`);
        return allocator.allocate({ agent: { id: 'walker' }, sprite: { tileX: source.tileX, tileY: source.tileY }, building });
    };
    const walked = allocate(pathfinder);
    assert.equal(keyOf(walked), keyOf(sameBank), 'the flow field knows the canal');
    const euclid = allocate({ isWalkable: (x, y) => pathfinder.isWalkable(x, y) });
    assert.equal(keyOf(euclid), keyOf(across), 'without sinks the allocator keeps straight-line distance');
    // The live building became the forge sink (plus its configured ring).
    const forgeSink = new Set(pathfinder.getSinkTiles('forge').map(keyOf));
    assert.ok(forgeSink.has(keyOf(across)) && forgeSink.has(keyOf(sameBank)));
    assert.equal(pathfinder.sinkIdAt(source.tileX, source.tileY), SINK_IDS['village-gate']);
    assert.ok(pathfinder.sinkCostAt('village-gate', across.tileX, across.tileY) > 40);
    assert.ok(pathfinder.sinkCostAt('village-gate', sameBank.tileX, sameBank.tileY) < 8);
});

test('benchmark: sink findPath lookups average <= 0.10 ms over 500 production queries', (t) => {
    const pathfinder = realPathfinder();
    const { bridgeTiles } = realWorld();
    const route = productionRouter(crowdSnapshot(pathfinder, 37, 11));
    const random = rng(2026);
    const walk = pathfinder.walkableTiles;
    const targets = [];
    for (let sink = 0; sink < SINK_COUNT; sink++) {
        for (const tile of pathfinder.getSinkTiles(sink)) if (pathfinder.isWalkable(tile.tileX, tile.tileY)) targets.push(tile);
    }
    const queries = [];
    while (queries.length < 500) {
        const from = walk[Math.floor(random() * walk.length)];
        const to = targets[Math.floor(random() * targets.length)];
        if (Math.hypot(to.tileX - from.tileX, to.tileY - from.tileY) <= 4.5) continue;
        queries.push({ from, to, options: route(`bench-${queries.length}`, from, to) });
    }
    const run = () => {
        const t0 = performance.now();
        for (const query of queries) pathfinder.findPath(query.from, query.to, bridgeTiles, query.options);
        return (performance.now() - t0) / queries.length;
    };
    quiet(run); // warm the JIT and build the sinks
    pathfinder._resetStats();
    const wallMs = Math.min(run(), run(), run());
    const flow = pathfinder.getDiagnostics().flow;
    t.diagnostic(`findPath wall ${wallMs.toFixed(4)} ms/query (best of 3 × 500)`);
    t.diagnostic(`lookup avg ${flow.avgLookupMs.toFixed(4)} ms · trace ${flow.avgTraceLookupMs.toFixed(4)} ms · guided ${flow.avgGuidedLookupMs.toFixed(4)} ms · ad-hoc ${flow.avgAdhocLookupMs.toFixed(4)} ms`);
    t.diagnostic(`sink hit rate ${(flow.sinkHitRate * 100).toFixed(1)}% · trace hit rate ${(flow.traceHitRate * 100).toFixed(1)}% · rebuilds ${flow.rebuilds} · memory ${pathfinder.getMemoryFootprint()} B`);
    assert.equal(flow.sinkLookups, flow.lookups, 'every benchmark target is a sink seed');
    assert.equal(flow.rebuilds, 0, 'a steady crowd rebuilds nothing');
    assert.ok(wallMs <= 0.10, `average sink findPath ${wallMs.toFixed(4)} ms <= 0.10 ms`);

    // Rebuild cost: all 16 sinks once.
    const rebuild = realPathfinder();
    rebuild.findPath(queries[0].from, queries[0].to, bridgeTiles, queries[0].options);
    for (let sink = 0; sink < SINK_COUNT; sink++) rebuild.sinkCostAt(sink, 20, 30);
    const rebuilt = rebuild.getDiagnostics().flow;
    t.diagnostic(`16-sink rebuild ${rebuilt.rebuildMs.toFixed(3)} ms total · ${rebuilt.avgRebuildMs.toFixed(3)} ms/sink`);
    assert.equal(rebuilt.rebuilds, SINK_COUNT);
});

// The tiles a straight segment walks: the same Bresenham stepping the
// Pathfinder's line test and `_lookahead` use, written out independently.
function lineTiles(from, to) {
    const tiles = [];
    let x = from.tileX;
    let y = from.tileY;
    const dx = Math.abs(to.tileX - x);
    const dy = Math.abs(to.tileY - y);
    const sx = x < to.tileX ? 1 : -1;
    const sy = y < to.tileY ? 1 : -1;
    let err = dx - dy;
    while (x !== to.tileX || y !== to.tileY) {
        const e2 = 2 * err;
        if (e2 > -dy) { err -= dy; x += sx; }
        if (e2 < dx) { err += dx; y += sy; }
        tiles.push({ tileX: x, tileY: y });
    }
    return tiles;
}

const expandLines = (from, waypoints) => {
    const tiles = [];
    let prev = from;
    for (const point of waypoints) {
        tiles.push(...lineTiles(prev, point));
        prev = point;
    }
    return tiles;
};

test('terrace edges: straight-line shortcuts and lookahead never step across a tier change without a stair', () => {
    // Open ground split into two terraces: x 0..19 is tier 0, x 20..39 tier
    // 1, joined by one orthogonal stair pair at (19,30)/(20,30).
    const tiers = new Uint8Array(CELLS);
    for (let y = 0; y < MAP_SIZE; y++) for (let x = 20; x < MAP_SIZE; x++) tiers[y * MAP_SIZE + x] = 1;
    const stairs = [{ tileX: 19, tileY: 30 }, { tileX: 20, tileY: 30 }];
    const stairKeys = new Set(stairs.map(keyOf));
    const tierAt = (tile) => tiers[tile.tileY * MAP_SIZE + tile.tileX];
    // Independent of stepMask: a walk/corner-legal step that changes tier
    // only orthogonally, by one, between two stair tiles.
    const terraceStep = (pathfinder, a, b) => {
        if (!legalStep(pathfinder, a.tileX, a.tileY, b.tileX, b.tileY)) return false;
        if (tierAt(a) === tierAt(b)) return true;
        return (a.tileX === b.tileX || a.tileY === b.tileY) && Math.abs(tierAt(a) - tierAt(b)) === 1
            && stairKeys.has(keyOf(a)) && stairKeys.has(keyOf(b));
    };
    const assertTerraceWalk = (pathfinder, from, tiles, label) => {
        let prev = from;
        for (const tile of tiles) {
            assert.ok(terraceStep(pathfinder, prev, tile), `${label}: illegal terrace step ${keyOf(prev)}->${keyOf(tile)}`);
            prev = tile;
        }
    };
    const build = (withStairs, wall = []) => {
        const blocked = new Set(wall);
        const pathfinder = syntheticPathfinder(gridWith((x, y) => !blocked.has(`${x},${y}`)));
        pathfinder.setTierGrid(tiers, withStairs ? stairs : []);
        return pathfinder;
    };

    const pathfinder = build(true);
    // The terrace edge's step mask is zero everywhere but the stair.
    for (let y = 0; y < MAP_SIZE; y++) {
        const west = pathfinder.stepMask[y * MAP_SIZE + 19];
        const east = pathfinder.stepMask[y * MAP_SIZE + 20];
        assert.equal(!!(west & 1), y === 30, `(19,${y}) east step`);
        assert.equal(!!(east & 2), y === 30, `(20,${y}) west step`);
        for (const dir of [4, 6]) assert.equal(west & (1 << dir), 0, `(19,${y}) never steps diagonally onto the upper terrace`);
        for (const dir of [5, 7]) assert.equal(east & (1 << dir), 0, `(20,${y}) never steps diagonally onto the lower terrace`);
    }
    assert.equal(pathfinder._lineWalkable(19, 10, 20, 10), false, 'adjacent walkable tiles across the edge are not a line');
    assert.equal(pathfinder._lineWalkable(10, 4, 30, 8), false, 'nor is a long line across it');
    assert.equal(pathfinder._lineWalkable(19, 30, 20, 30), true, 'the stair pair is');

    // (a) The straight-line fast path: adjacent tiles, no stair between.
    // (b) `_lookahead`: a wall blocks the direct row, so BFS runs and the
    //     lookahead looks for shortcuts back across the edge.
    const sinkTarget = { tileX: 20, tileY: 10 };
    for (const [label, finder, from, to] of [
        ['fast path', pathfinder, { tileX: 19, tileY: 10 }, { tileX: 20, tileY: 10 }],
        ['lookahead', build(true, ['19,10', '20,10']), { tileX: 18, tileY: 10 }, { tileX: 21, tileY: 10 }],
    ]) {
        finder.setSinkTiles('portal-exit', [label === 'fast path' ? sinkTarget : to]);
        const weightedOptions = { preferRoads: true, roadTiles: new Set(['0,0']) };
        const routes = [
            ['weighted sink', finder.findPath(from, to, new Map(), weightedOptions), expandWeighted],
            ['weighted ad-hoc', finder.findPath(from, { tileX: to.tileX + 1, tileY: to.tileY }, new Map(), weightedOptions), expandWeighted],
            ['unweighted', finder.findPath(from, to, null, null), expandLines],
            ['unweighted again (cached)', finder.findPath(from, to, null, null), expandLines],
        ];
        for (const [mode, path, expand] of routes) {
            assert.ok(path.length > 1, `${label} ${mode}: a multi-waypoint route, not a shortcut`);
            const tiles = expand(from, path);
            assertTerraceWalk(finder, from, tiles, `${label} ${mode}`);
            assert.ok(tiles.some((tile) => stairKeys.has(keyOf(tile))), `${label} ${mode} climbs the stair`);
        }
    }

    // No stair at all: the terraces are sealed, and no mode falls back to a
    // straight line across the edge.
    const sealed = build(false);
    for (const options of [{ preferRoads: true, roadTiles: new Set(['0,0']) }, null]) {
        assert.deepEqual(quiet(() => sealed.findPath({ tileX: 19, tileY: 10 }, { tileX: 20, tileY: 10 }, null, options)), []);
    }
});

test('crowd and route dirty checks: in-place edits re-read on a bumped version or by content, never by identity and size', () => {
    let now = 0;
    const pathfinder = syntheticPathfinder(gridWith(() => true), { clock: () => now });
    const roadTiles = new Set(['0,0']);
    const from = { tileX: 20, tileY: 14 };
    const to = { tileX: 20, tileY: 26 };
    const congestion = new Map([['3,3', 8]]);
    const route = (extra) => pathfinder.findPath(from, to, null, { preferRoads: true, roadTiles, congestionTiles: congestion, ...extra });
    const crosses = (path, x, y) => expandWeighted(from, path).some((tile) => tile.tileX === x && tile.tileY === y);

    assert.ok(crosses(route({ congestionVersion: 'fnv:1' }), 20, 20), 'a calm column walks straight down');
    assert.ok(pathfinder.congestionCostAt(3, 3) > 1);
    assert.equal(pathfinder.congestionCostAt(20, 20), 0);

    // The same Map moves its crowd from (3,3) to (20,20) in place (same
    // object, same size) and the caller bumps its version.
    congestion.delete('3,3');
    congestion.set('20,20', 8);
    const bumped = route({ congestionVersion: 'fnv:2' });
    assert.equal(pathfinder.congestionCostAt(3, 3), 0, 'the old crowd is gone at once');
    assert.ok(Math.abs(pathfinder.congestionCostAt(20, 20) - 1.2) < 1e-6, 'the new crowd costs at once');
    assert.ok(!crosses(bumped, 20, 20), 'the route steps around the moved jam');
    assertLegalWalk(pathfinder, from, expandWeighted(from, bumped), 'bumped');

    // A supplied version is authoritative: same object, same version is
    // not re-read.
    const ingests = pathfinder.getDiagnostics().flow.crowdIngests;
    route({ congestionVersion: 'fnv:2' });
    assert.equal(pathfinder.getDiagnostics().flow.crowdIngests, ingests, 'an unchanged (object, version) pair is not re-read');

    // Unversioned, the same Map edited in place is re-read on every lookup.
    congestion.delete('20,20');
    congestion.set('30,5', 8);
    assert.ok(crosses(route({}), 20, 20), 'the cleared column is walkable again');
    assert.equal(pathfinder.congestionCostAt(20, 20), 0);
    assert.ok(pathfinder.congestionCostAt(30, 5) > 1);

    // Standing bodies: a Set edited in place with a bumped version.
    const standing = new Set(['5,5']);
    const standingRoute = (standingVersion) => pathfinder.findPath(from, to, null, { preferRoads: true, roadTiles, standingTiles: standing, standingVersion });
    standingRoute('5,5');
    assert.equal(pathfinder.standingGrid[5 * MAP_SIZE + 5], 1);
    standing.delete('5,5');
    standing.add('20,20');
    assert.ok(!crosses(standingRoute('20,20'), 20, 20), 'the route steps around the moved body');
    assert.equal(pathfinder.standingGrid[5 * MAP_SIZE + 5], 0);
    assert.equal(pathfinder.standingGrid[20 * MAP_SIZE + 20], 1);

    // Authored route layers: a road Set edited in place (same size) reloads
    // by content, with or without a route revision.
    const roadBit = (x, y) => !!(pathfinder.staticFlags[y * MAP_SIZE + x] & 16);
    const roads = new Set(['5,5', '5,6']);
    const roadRoute = (routeVersion) => pathfinder.findPath(from, to, null, { preferRoads: true, roadTiles: roads, routeVersion });
    roadRoute('');
    assert.ok(roadBit(5, 5) && roadBit(5, 6));
    roads.delete('5,5');
    roads.add('6,6');
    roadRoute('');
    assert.ok(!roadBit(5, 5) && roadBit(6, 6), 'an unversioned in-place edit reloads the road layer');
    roadRoute('roads-1');
    roads.delete('6,6');
    roads.add('7,7');
    roadRoute('roads-2');
    assert.ok(!roadBit(6, 6) && roadBit(7, 7), 'a bumped route revision reloads it');
});

test('setGrid: blocking a tile in place invalidates every route, sink field and walkability answer through it', () => {
    // A wall at x = 20 with gaps at (20,10) and (20,30).
    const grid = gridWith((x, y) => x !== 20 || y === 10 || y === 30);
    const pathfinder = syntheticPathfinder(grid);
    const from = { tileX: 15, tileY: 10 };
    const to = { tileX: 25, tileY: 10 };
    const adhoc = { tileX: 25, tileY: 11 };
    pathfinder.setSinkTiles('portal-exit', [to]);
    const options = { preferRoads: true, roadTiles: new Set(['0,0']) };
    const gapIndex = 10 * MAP_SIZE + 20;
    const throughGap = (tiles) => tiles.some((tile) => tile.tileX === 20 && tile.tileY === 10);
    const routes = () => [
        ['weighted sink', from, pathfinder.findPath(from, to, new Map(), options), expandWeighted],
        ['weighted ad-hoc', from, pathfinder.findPath(from, adhoc, new Map(), options), expandWeighted],
        ['unweighted', from, pathfinder.findPath(from, to, null, null), expandLines],
    ];
    for (const [mode, start, path, expand] of routes()) {
        assert.ok(throughGap(expand(start, path)), `${mode} takes the near gap while it is open`);
    }
    const openCost = pathfinder.sinkCostAt('portal-exit', from.tileX, from.tileY);

    const assertBlocked = (label) => {
        assert.equal(pathfinder.isWalkable(20, 10), false, `${label}: isWalkable reads the rebuilt walk bit`);
        assert.ok(!pathfinder.walkableTiles.some((tile) => tile.tileX === 20 && tile.tileY === 10), `${label}: the walkable list drops it`);
        for (let index = 0; index < CELLS; index++) {
            const x = index % MAP_SIZE;
            assert.equal(pathfinder.isWalkable(x, (index - x) / MAP_SIZE), grid[index] === 1, `${label}: isWalkable matches the grid at ${index}`);
        }
        for (const [mode, start, path, expand] of routes()) {
            const tiles = expand(start, path);
            assert.ok(tiles.length > 0 && !throughGap(tiles), `${label} ${mode} never walks through the blocked gap`);
            assertLegalWalk(pathfinder, start, tiles, `${label} ${mode}`);
        }
        assert.ok(pathfinder.sinkCostAt('portal-exit', from.tileX, from.tileY) > openCost + 20, `${label}: the sink field rebuilt around the far gap`);
    };

    grid[gapIndex] = 0;
    pathfinder.setGrid(grid);
    assertBlocked('setGrid');

    // The same edit without setGrid: the next lookup notices the array no
    // longer matches its walk bits and resyncs before routing.
    grid[gapIndex] = 1;
    pathfinder.setGrid(grid);
    for (const [mode, start, path, expand] of routes()) assert.ok(throughGap(expand(start, path)), `${mode} reopens through the gap`);
    grid[gapIndex] = 0;
    assert.ok(!throughGap(expandWeighted(from, pathfinder.findPath(from, to, new Map(), options))), 'an in-place edit is seen by the next findPath');
    assertBlocked('in place');
});
