import test from 'node:test';
import assert from 'node:assert/strict';

import { AMBIENT_SCENIC_POINTS } from '../../claudeville/src/config/scenery.js';
import { BUILDING_DEFS, VISIT_OVERFLOW_TILES } from '../../claudeville/src/config/buildings.js';
import { APPROACH_FILES, COMMAND_QUEUE, REST_SEATS } from '../../claudeville/src/config/townPlan.js';
import { MAP_SIZE, TILE_HEIGHT, TILE_WIDTH } from '../../claudeville/src/config/constants.js';
import { Building } from '../../claudeville/src/domain/entities/Building.js';
import { SceneryEngine } from '../../claudeville/src/presentation/character-mode/SceneryEngine.js';
import {
    overCapacityPenalty,
    standsOnFixture,
    VisitTileAllocator,
} from '../../claudeville/src/presentation/character-mode/VisitTileAllocator.js';

// W4.2 — door discipline: approach files, the ranked outer ring and the
// progressive over-capacity penalty.

const scenery = new SceneryEngine({ world: null, terrainSeed: 1, tileNoise: () => 0.5 });
scenery.generateBridges();
const grid = scenery.getWalkabilityGrid();
const walkable = (tileX, tileY) => Boolean(grid[tileY * MAP_SIZE + tileX]);
const keyOf = (place) => `${place.tileX},${place.tileY}`;
const rectOf = (def, part = { dx: 0, dy: 0, width: def.width, height: def.height }) => ({
    x0: def.x + part.dx, y0: def.y + part.dy, x1: def.x + part.dx + part.width - 1, y1: def.y + part.dy + part.height - 1,
});
const inside = (place, rect) => place.tileX >= rect.x0 && place.tileX <= rect.x1 && place.tileY >= rect.y0 && place.tileY <= rect.y1;
// A file step: along a tile axis away from the camera, or across the screen at one depth.
const LINE_STEPS = new Set(['0,-1', '-1,0', '1,-1', '-1,1']);

function town() {
    const buildings = new Map(BUILDING_DEFS.map((def) => [def.type, new Building(def)]));
    const allocator = new VisitTileAllocator();
    allocator.updateContext({ buildings, agentSprites: [], pathfinder: { isWalkable: walkable } });
    const visit = (id, type, source = 'tool') => allocator.allocate({
        agent: { id, status: 'working' },
        building: buildings.get(type),
        intent: { id: `intent-${id}`, source, building: type },
    });
    return { allocator, buildings, visit };
}

test('every landmark has an approach file of 4-8 places and a ranked outer ring', () => {
    for (const def of BUILDING_DEFS) {
        const file = APPROACH_FILES[def.type];
        const ring = VISIT_OVERFLOW_TILES[def.type];
        assert.ok(file, `${def.type} has an approach file`);
        assert.ok(file.length >= 4 && file.length <= 8, `${def.type} file holds ${file.length} places`);
        assert.ok(ring?.length >= 3, `${def.type} ring holds ${ring?.length} places`);
        assert.ok(file.length + ring.length >= 7, `${def.type} seats its 6th-12th waiting bodies on distinct places`);
    }
    assert.deepEqual(Object.keys(APPROACH_FILES).sort(), BUILDING_DEFS.map((def) => def.type).sort());
});

test('an approach file leaves the door and trails away from the camera, one tile per step', () => {
    for (const def of BUILDING_DEFS) {
        const file = APPROACH_FILES[def.type];
        const doorPlaces = [def.entrance, ...def.visitTiles];
        assert.ok(doorPlaces.some((tile) => Math.hypot(tile.tileX - file[0].tileX, tile.tileY - file[0].tileY) <= 2.5),
            `${def.type} file head stands by its door`);
        for (let index = 1; index < file.length; index++) {
            const step = `${file[index].tileX - file[index - 1].tileX},${file[index].tileY - file[index - 1].tileY}`;
            assert.ok(LINE_STEPS.has(step), `${def.type} file step ${index} is ${step}`);
        }
    }
});

test('no approach or ring place stands on a fixture, off the walk grid, in a footprint or on another standing place', () => {
    const others = new Map();
    const claim = (place, owner) => others.set(keyOf({ tileX: Math.round(place.tileX), tileY: Math.round(place.tileY) }), owner);
    REST_SEATS.forEach((seat) => claim(seat, `seat ${seat.id}`));
    [...COMMAND_QUEUE.slots, ...COMMAND_QUEUE.overflow].forEach((slot) => claim(slot, 'command petitioners'));
    AMBIENT_SCENIC_POINTS.forEach((point) => claim(point, `scenic ${point.id}`));
    const visitOwner = new Map();
    for (const def of BUILDING_DEFS) {
        for (const tile of def.visitTiles) visitOwner.set(keyOf(tile), { type: def.type, role: tile.role });
    }

    const seen = new Set();
    for (const def of BUILDING_DEFS) {
        const places = [
            ...APPROACH_FILES[def.type].map((place) => ({ place, kind: 'file' })),
            ...VISIT_OVERFLOW_TILES[def.type].map((place) => ({ place, kind: 'ring' })),
        ];
        for (const { place, kind } of places) {
            const label = `${def.type} ${kind} ${keyOf(place)}`;
            assert.ok(Number.isInteger(place.tileX) && Number.isInteger(place.tileY), `${label} is a whole tile`);
            assert.ok(walkable(place.tileX, place.tileY), `${label} is walkable`);
            const world = { x: (place.tileX - place.tileY) * TILE_WIDTH / 2, y: (place.tileX + place.tileY) * TILE_HEIGHT / 2 };
            assert.equal(standsOnFixture(world.x, world.y), false, `${label} stands on a fixture`);
            for (const obstacle of BUILDING_DEFS) {
                assert.ok(!inside(place, rectOf(obstacle)), `${label} sits in ${obstacle.type}'s footprint`);
                for (const exclusion of obstacle.walkExclusion) {
                    assert.ok(!inside(place, rectOf(obstacle, exclusion)), `${label} sits in ${obstacle.type}'s walk exclusion`);
                }
            }
            assert.ok(!seen.has(keyOf(place)), `${label} is claimed twice`);
            seen.add(keyOf(place));
            assert.ok(!others.has(keyOf(place)), `${label} is ${others.get(keyOf(place))}'s place`);
            const visit = visitOwner.get(keyOf(place));
            if (visit) {
                // Only a file may take over its own building's queue or scenic slot.
                assert.equal(kind, 'file', `${label} is ${visit.type}'s visit tile`);
                assert.equal(visit.type, def.type, `${label} is ${visit.type}'s visit tile`);
                assert.notEqual(visit.role, 'work', `${label} is a work slot`);
            }
        }
    }
});

test('the over-capacity penalty is progressive and tells the 6th body from the 11th', () => {
    assert.equal(overCapacityPenalty(0), 0);
    for (let over = 1; over < 8; over++) {
        const step = overCapacityPenalty(over + 1) - overCapacityPenalty(over);
        assert.ok(step > overCapacityPenalty(over) - overCapacityPenalty(over - 1), `penalty grows faster past ${over}`);
    }
    // Five slots: the 6th body is one over capacity, the 11th six over.
    const { allocator } = town();
    const score = (buildingOccupancy) => allocator._scoreSlot({
        slot: { tileX: 23, tileY: 30, slotId: 'probe', capacity: 99 },
        agentId: 'probe',
        buildingType: 'probe',
        sourceTile: null,
        buildingCapacity: 5,
        buildingOccupancy,
        existingReservation: null,
        intent: null,
        now: Date.now(),
    });
    const sixth = score(5);
    const eleventh = score(10);
    assert.equal(sixth.overBuildingCapacity, 1);
    assert.equal(eleventh.overBuildingCapacity, 6);
    assert.ok(eleventh.score - sixth.score >= overCapacityPenalty(6) - overCapacityPenalty(1));
    assert.ok(eleventh.score > 30 * overCapacityPenalty(1), 'the 11th costs far more than six 6ths');
});

test('a full landmark lines waiting visitors up by arrival, facing the door', () => {
    const { visit } = town();
    const file = APPROACH_FILES.forge;
    const entrance = BUILDING_DEFS.find((def) => def.type === 'forge').entrance;
    for (const id of ['w1', 'w2', 'w3', 'w4']) assert.equal(visit(id, 'forge').line, false, `${id} goes in`);
    const waiting = ['q1', 'q2', 'q3'].map((id) => visit(id, 'forge'));
    waiting.forEach((place, rank) => {
        assert.equal(place.line, true);
        assert.equal(place.queueIndex, rank);
        assert.deepEqual([place.tileX, place.tileY], [file[rank].tileX, file[rank].tileY]);
        assert.equal(place.slotId, `forge:line:${rank}`);
    });
    assert.deepEqual(waiting[0].facingPoint, { x: entrance.tileX, y: entrance.tileY }, 'the head faces the door');
    assert.deepEqual(waiting[1].facingPoint, { x: file[0].tileX, y: file[0].tileY }, 'a later place faces the one ahead');
    // Asking again keeps a place: arrival order, not asking order.
    assert.equal(visit('q3', 'forge').queueIndex, 2);
    assert.equal(visit('q2', 'forge').queueIndex, 1);
    // An idle stroller never joins the line.
    assert.equal(visit('stroller', 'forge', 'ambient').line, false);
});

test('a freed slot goes to the head, the line steps up, and newcomers join the back', () => {
    const { allocator, visit } = town();
    const file = APPROACH_FILES.forge;
    for (const id of ['w1', 'w2', 'w3', 'w4', 'q1', 'q2', 'q3']) visit(id, 'forge');
    allocator.release('w1');
    assert.equal(visit('q2', 'forge').queueIndex, 1, 'the second does not jump the head');
    const head = visit('q1', 'forge');
    assert.equal(head.line, false, 'the head goes in');
    assert.ok(!file.some((place) => place.tileX === head.tileX && place.tileY === head.tileY));
    const second = visit('q2', 'forge');
    assert.equal(second.queueIndex, 0, 'the second steps up');
    assert.deepEqual([second.tileX, second.tileY], [file[0].tileX, file[0].tileY]);
    assert.deepEqual([visit('q3', 'forge').tileX], [file[1].tileX]);
    allocator.release('w2');
    const late = visit('late', 'forge');
    assert.equal(late.line, true, 'a newcomer waits behind the line even with a slot free');
    assert.equal(late.queueIndex, 2);
});

test('the 6th-12th bodies at Command land on distinct authored places; its petitioners keep their queue', () => {
    const { allocator, buildings, visit } = town();
    const places = [];
    for (let index = 1; index <= 13; index++) places.push(visit(`c${index}`, 'command'));
    assert.ok(places.slice(0, 5).every((place) => !place.line), 'five go in');
    const waiting = places.slice(5, 12);
    const authored = [...APPROACH_FILES.command, ...VISIT_OVERFLOW_TILES.command].map(keyOf);
    assert.deepEqual(waiting.map(keyOf), authored.slice(0, 7));
    assert.deepEqual(waiting.map((place) => place.slotId), [
        'command:line:0', 'command:line:1', 'command:line:2', 'command:line:3',
        'command:ring:0', 'command:ring:1', 'command:ring:2', 'command:ring:3',
    ].slice(0, waiting.length));
    assert.equal(places[12].line, true, 'past the ring the 13th still waits, on a scored slot');
    assert.ok(!authored.includes(keyOf(places[12])));
    // The Harbor quay slots belong to its line, never to a scored visit.
    const harborSlots = allocator._candidateTiles({ building: buildings.get('harbor'), buildingType: 'harbor', candidates: null });
    for (const place of APPROACH_FILES.harbor) {
        assert.ok(!harborSlots.some((slot) => slot.tileX === place.tileX && slot.tileY === place.tileY), `${keyOf(place)} is the line's`);
    }
    assert.equal(COMMAND_QUEUE.slots.length, 12);
});
