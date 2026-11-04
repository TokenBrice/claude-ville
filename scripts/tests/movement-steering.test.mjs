import test from 'node:test';
import assert from 'node:assert/strict';

import {
    bridgeCrossingTiles,
    bridgeLaneShift,
    constrainSteeringToTarget,
    laneAxisForBridgeOrientation,
} from '../../claudeville/src/presentation/character-mode/MovementSteering.js';
import { AgentSprite } from '../../claudeville/src/presentation/character-mode/AgentSprite.js';
import { IsometricRenderer } from '../../claudeville/src/presentation/character-mode/IsometricRenderer.js';
import { Pathfinder } from '../../claudeville/src/presentation/character-mode/Pathfinder.js';
import { SceneryEngine } from '../../claudeville/src/presentation/character-mode/SceneryEngine.js';
import { tileToWorld, worldToTile } from '../../claudeville/src/presentation/character-mode/Projection.js';

function distanceToTarget(position, target = { x: 10, y: 0 }) {
    return Math.hypot(target.x - position.x, target.y - position.y);
}

test('steering cannot increase distance to the current waypoint', () => {
    const current = { x: 5, y: 0 };
    const steered = constrainSteeringToTarget({
        ...current,
        nextX: 4.2,
        nextY: 0,
        targetX: 10,
        targetY: 0,
    });

    assert.equal(steered.constrained, true);
    assert.ok(distanceToTarget(steered) <= distanceToTarget(current) + 1e-6);
    assert.ok(Math.abs(steered.x - current.x) <= 1e-6);
});

test('progress constraint retains useful lateral separation', () => {
    const current = { x: 5, y: 0 };
    const steered = constrainSteeringToTarget({
        ...current,
        nextX: 5,
        nextY: 1,
        targetX: 10,
        targetY: 0,
    });

    assert.equal(steered.constrained, true);
    assert.ok(steered.y > 0.9, 'the lateral correction should remain visible');
    assert.ok(steered.x > current.x, 'projection should compensate with forward progress');
    assert.ok(distanceToTarget(steered) <= distanceToTarget(current) + 1e-6);
});

test('a slow walker still reaches its waypoint against stronger reverse steering', () => {
    const target = { x: 10, y: 0 };
    let position = { x: 0, y: 0 };
    const forwardStep = 0.5;
    const reverseCorrection = 0.8;

    for (let frame = 0; frame < 24 && distanceToTarget(position, target) > 0; frame++) {
        const distance = distanceToTarget(position, target);
        if (distance <= forwardStep) {
            position = { ...target };
            break;
        }

        position.x += forwardStep;
        position = constrainSteeringToTarget({
            ...position,
            nextX: position.x - reverseCorrection,
            nextY: position.y,
            targetX: target.x,
            targetY: target.y,
        });
    }

    assert.deepEqual(
        { x: position.x, y: position.y },
        target,
        'post-movement steering must not cancel every forward step',
    );
});

test('bridge lane axes follow their authored grid orientation', () => {
    assert.deepEqual(laneAxisForBridgeOrientation('NS'), { dx: 0, dy: 1 });
    assert.deepEqual(laneAxisForBridgeOrientation('EW'), { dx: 1, dy: 0 });
    assert.equal(laneAxisForBridgeOrientation('diagonal'), null);
});

// BR-3 — direction-keyed bridge lanes. A synthetic map: the central NS deck
// (x 18, y 23-25, side spans unwalkable), a future NS landmark trestle at x 7,
// the EW pond plank and a harbour dock.
function bridgeMap() {
    const map = new Map();
    const deck = (x, y, walkable = true) => map.set(`${x},${y}`, { orientation: 'NS', kind: 'landmark', bridgeId: 'central-river-bridge', walkable });
    for (const y of [23, 24, 25]) {
        deck(18, y);
        deck(17, y, false);
        deck(19, y, false);
    }
    for (const y of [23, 24, 25, 26]) map.set(`7,${y}`, { orientation: 'NS', kind: 'landmark', bridgeId: 'west-river-plank', walkable: true, laneOffsetPx: 6 });
    for (const x of [16, 17]) map.set(`${x},22`, { orientation: 'EW', kind: 'plank', bridgeId: 'command-pond-plank', walkable: true });
    map.set('29,20', { orientation: 'EW', kind: 'dock', style: 'causeway' });
    return map;
}

test('BR-3: crossing tiles are the walkable decks plus the landings past each landmark deck end', () => {
    const map = bridgeMap();
    const crossings = bridgeCrossingTiles(map);
    const decks = [...crossings].filter(([, c]) => !c.landing).map(([key]) => key).sort();
    const landings = [...crossings].filter(([, c]) => c.landing).map(([key]) => key).sort();
    assert.deepEqual(decks, ['16,22', '17,22', '18,23', '18,24', '18,25', '7,23', '7,24', '7,25', '7,26']);
    assert.deepEqual(landings, ['18,22', '18,26', '7,22', '7,27'], 'side spans, planks and docks have no landings');
    assert.equal(crossings.get('18,22').info, map.get('18,23'), 'a landing carries its deck end\'s info');
    assert.equal(crossings.get('7,27').info.laneOffsetPx, 6);
    assert.equal(bridgeCrossingTiles(null).size, 0);
});

test('BR-3: the lane shift is the hint offset across the deck, keyed by direction of travel', () => {
    const deck = { orientation: 'NS', kind: 'landmark' };
    const along = tileToWorld(0, 1); // the NS lane tangent, world px
    const north = bridgeLaneShift(deck, -along.x, -along.y);
    const south = bridgeLaneShift(deck, along.x, along.y);
    assert.ok(Math.abs(Math.hypot(south.x, south.y) - 10) < 1e-9, 'no hint offset: today\'s 10 px lane');
    assert.ok(Math.abs(south.x * along.x + south.y * along.y) < 1e-9, 'the shift runs across the deck');
    assert.deepEqual({ x: -north.x, y: -north.y }, south, 'opposite directions take opposite lanes');
    const narrow = bridgeLaneShift({ ...deck, laneOffsetPx: 8 }, along.x, along.y);
    assert.ok(Math.abs(Math.hypot(narrow.x, narrow.y) - 8) < 1e-9, 'the hint\'s laneOffsetPx wins');
    assert.equal(bridgeLaneShift(deck, 0, 0), null);
    assert.equal(bridgeLaneShift({ kind: 'landmark' }, along.x, along.y), null);
    // Both lane points stay on the deck's walk column; one 15 px out would not.
    const centre = tileToWorld(18, 24);
    for (const shift of [north, south, narrow]) {
        const tile = worldToTile(centre.x + shift.x, centre.y + shift.y);
        assert.deepEqual([Math.round(tile.tileX), Math.round(tile.tileY)], [18, 24]);
    }
    const wide = bridgeLaneShift({ ...deck, laneOffsetPx: 15 }, along.x, along.y);
    assert.notEqual(Math.round(worldToTile(centre.x + wide.x, centre.y + wide.y).tileX), 18);
});

test('BR-3: a lane waypoint sits where the renderer\'s lane steering holds that walker', () => {
    const map = bridgeMap();
    const renderer = Object.assign(Object.create(IsometricRenderer.prototype), {
        pathTiles: new Set(map.keys()),
        bridgeTiles: map,
        pathfinder: { isWalkable: (x, y) => map.get(`${x},${y}`)?.walkable !== false },
        mainAvenueTiles: new Set(),
        dirtPathTiles: new Set(),
        commandCenterRoadTiles: new Set(),
        townSquareTiles: new Set(),
    });
    const lane = renderer._buildLaneTileIndex().get('18,24');
    const centre = tileToWorld(18, 24);
    for (const [fromY, toY] of [[25, 23], [23, 25]]) {
        const from = tileToWorld(18, fromY);
        const to = tileToWorld(18, toY);
        const shift = bridgeLaneShift(map.get('18,24'), to.x - from.x, to.y - from.y);
        const waypoint = { x: centre.x + shift.x, y: centre.y + shift.y };
        const walker = { x: from.x + shift.x, y: from.y + shift.y, targetX: waypoint.x, targetY: waypoint.y };
        const side = renderer._laneSideForSprite(walker, lane);
        const offset = (waypoint.x - centre.x) * lane.perpX + (waypoint.y - centre.y) * lane.perpY;
        assert.ok(Math.abs(offset - lane.laneOffset * side) < 1e-9, `${fromY}->${toY}: waypoint lane ${offset} vs steering ${lane.laneOffset * side}`);
    }
});

test('BR-3: a route over the central deck keeps both files on their lanes and never moves its end', () => {
    const scenery = new SceneryEngine({ world: null, terrainSeed: 1, tileNoise: () => 0.5 });
    scenery.generateBridges();
    const bridgeTiles = scenery.getBridgeTiles();
    const pathfinder = new Pathfinder(scenery.getWalkabilityGrid());
    // Signed px toward the southbound file's side of the deck.
    const along = tileToWorld(0, 1);
    const southLane = bridgeLaneShift({ orientation: 'NS' }, along.x, along.y);
    const route = (from, to) => {
        const start = tileToWorld(from.tileX, from.tileY);
        const sprite = Object.assign(Object.create(AgentSprite.prototype), {
            agent: { id: 'lane-walker' }, pathfinder, bridgeTiles, x: start.x, y: start.y, waypoints: [],
        });
        const end = tileToWorld(to.tileX, to.tileY);
        sprite._assignTarget(end.x, end.y, to.tileX, to.tileY);
        return sprite.waypoints.map((point) => {
            const tile = worldToTile(point.x, point.y);
            const key = `${Math.round(tile.tileX)},${Math.round(tile.tileY)}`;
            const base = tileToWorld(Math.round(tile.tileX), Math.round(tile.tileY));
            return { key, lane: ((point.x - base.x) * southLane.x + (point.y - base.y) * southLane.y) / 10 };
        });
    };
    const northbound = route({ tileX: 18, tileY: 28 }, { tileX: 18, tileY: 20 });
    const southbound = route({ tileX: 18, tileY: 20 }, { tileX: 18, tileY: 28 });
    for (const [label, points, side] of [['northbound', northbound, -1], ['southbound', southbound, 1]]) {
        const deck = points.filter((point) => ['18,23', '18,24', '18,25'].includes(point.key));
        assert.equal(deck.length, 3, `${label} keeps every deck tile as a waypoint`);
        for (const point of deck) assert.ok(Math.abs(point.lane - side * 10) < 1e-6, `${label} ${point.key} on lane ${point.lane}`);
        assert.ok(Math.abs(points.at(-1).lane) < 1e-9, `${label} ends on its target`);
    }
    // A route that ends on the deck stops on its centre.
    const onDeck = route({ tileX: 18, tileY: 28 }, { tileX: 18, tileY: 24 });
    assert.equal(onDeck.at(-1).key, '18,24');
    assert.ok(Math.abs(onDeck.at(-1).lane) < 1e-9);
});
