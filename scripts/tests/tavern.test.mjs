import test from 'node:test';
import assert from 'node:assert/strict';

import { BUILDING_DEFS } from '../../claudeville/src/config/buildings.js';
import { REST_SEATS } from '../../claudeville/src/config/townPlan.js';
import { classifyTool } from '../../claudeville/src/domain/services/ToolIdentity.js';
import { AgentSprite } from '../../claudeville/src/presentation/character-mode/AgentSprite.js';
import { BuildingSprite } from '../../claudeville/src/presentation/character-mode/BuildingSprite.js';
import { restSeatStepBias } from '../../claudeville/src/presentation/character-mode/DayRoutine.js';
import { MIDNIGHT_OIL_RISE_MS } from '../../claudeville/src/presentation/character-mode/NightOccupancyGate.js';
import {
    DRINK_FRAME_BY_STEP,
    TANKARD_SIP_LIFT,
    tankardLift,
    tankardSipStep,
} from '../../claudeville/src/presentation/character-mode/RestSeats.js';

// The Tavern replaced the Observatory: a rest place, never a workplace.

test('web research works at the Portal; no tool routes to the Tavern', () => {
    assert.equal(BUILDING_DEFS.some((def) => def.type === 'observatory'), false);
    for (const [tool, input] of [
        ['WebSearch', { query: 'pixel art' }],
        ['WebFetch', { url: 'https://example.com/' }],
        ['web.run', {}],
        ['Bash', { command: 'curl https://example.com/' }],
        ['web_lookup', {}],
    ]) {
        assert.equal(classifyTool(tool, input)?.building, 'portal', tool);
    }
    const tavern = BUILDING_DEFS.find((def) => def.type === 'tavern');
    assert.equal(tavern.capacity.work, 0);
    assert.ok(tavern.visitTiles.every((tile) => tile.role !== 'work'));
});

test('the beer garden seats face the camera, and idlers prefer them', () => {
    const tables = REST_SEATS.filter((seat) => seat.occluder === 'tavern');
    assert.ok(tables.length >= 5);
    for (const seat of tables) {
        assert.equal(seat.building, 'tavern', seat.id);
        assert.ok(['south-east', 'south-west'].includes(seat.facing), seat.id);
    }
    // Command's steps and the pier stay; the greens' benches are gone.
    assert.ok(REST_SEATS.some((seat) => seat.occluder === 'step'));
    assert.ok(REST_SEATS.some((seat) => seat.occluder === 'pier'));
    assert.equal(REST_SEATS.some((seat) => seat.occluder === 'bench'), false);
    const step = REST_SEATS.find((seat) => seat.occluder === 'step');
    for (const hour of [9, 13, 19, 23]) {
        assert.ok(restSeatStepBias(hour, tables[0]) < restSeatStepBias(hour, step), `${hour}h`);
    }
});

test('a patron sips on its own seeded clock, and never under reduced motion', () => {
    assert.equal(tankardSipStep('a', 1000, false), -1);
    assert.equal(tankardLift('a', 1000, false), 0);
    assert.equal(DRINK_FRAME_BY_STEP.length, TANKARD_SIP_LIFT.length);
    const sipsOf = (id) => {
        const steps = [];
        for (let t = 0; t < 60_000; t += 40) steps.push(tankardSipStep(id, t));
        return steps;
    };
    const a = sipsOf('patron-a');
    const b = sipsOf('patron-b');
    assert.ok(a.some((step) => step >= 0) && a.some((step) => step < 0), 'sips between rests');
    assert.notDeepEqual(a, b, 'two patrons never drink in unison');
    assert.deepEqual(sipsOf('patron-a'), a, 'seeded');
    for (const [index, step] of a.entries()) {
        assert.equal(tankardLift('patron-a', index * 40), step < 0 ? 0 : TANKARD_SIP_LIFT[step]);
    }
    assert.ok(DRINK_FRAME_BY_STEP.every((frame) => frame >= 0 && frame <= 4));
});

test('a stale patron (a long wait on subagents) keeps sipping, and still rests under reduced motion', () => {
    const sprite = new AgentSprite({ id: 'patron-stale', status: 'working', provider: 'omp', model: 'claude-opus-5-5' }, {});
    sprite.observation = { state: 'stale', observedAt: 0, ageMs: 600_000 };
    sprite.motionScale = 1;
    let sip = 0;
    while (tankardSipStep('patron-stale', sip) < 0) sip += 40;
    const step = tankardSipStep('patron-stale', sip);
    assert.equal(sprite._actionStripFrame({}, 'drink', sip), DRINK_FRAME_BY_STEP[step]);
    sprite.motionScale = 0;
    assert.equal(sprite._actionStripFrame({}, 'drink', sip), 'hold');
});

test("the Tavern's windows light for seated patrons, not for passers-by", () => {
    const seat = REST_SEATS.find((candidate) => candidate.building === 'tavern');
    const tavern = { type: 'tavern', containsPoint: () => false };
    const patron = { agent: { id: 'p1', status: 'idle' }, visitRole: 'rest', _seatedSeat: () => seat };
    const stroller = { agent: { id: 's1', status: 'idle' }, visitRole: 'stroll', _seatedSeat: () => null };
    const renderer = Object.assign(Object.create(BuildingSprite.prototype), {
        buildings: [tavern],
        agentSprites: [patron, stroller],
        motionScale: 1,
        _visitorCountByType: new Map(),
        _visitorStatusByType: new Map(),
        _visitorRepoByType: new Map(),
        _litGateByType: new Map(),
        _roomSlotsByType: new Map(),
        _roomLitByType: new Map(),
        roomGlass: { roomCount: () => 5 },
        _spriteTilePosition: () => ({ tileX: 23, tileY: 21 }),
    });
    renderer._updateVisitorCounts();
    // A patron is no visitor (V8): no working count, no part or door.
    assert.equal(renderer._visitorStatusByType.get('tavern'), undefined);
    assert.equal(renderer._roomSlotsByType.get('tavern').assignment.size, 1);
    renderer._updateNightLightGates(MIDNIGHT_OIL_RISE_MS);
    assert.equal(renderer._nightShiftLit('tavern'), 1);
    assert.equal(renderer._workTierFor(tavern), 'occupied');

    patron.visitRole = 'stroll';
    patron._seatedSeat = () => null;
    renderer._updateVisitorCounts();
    assert.equal(renderer._roomSlotsByType.get('tavern').assignment.size, 0);
    assert.equal(renderer._workTierFor(tavern), 'dormant');
});

test('the bar floor is walkable, paints inside the Tavern, and its arcade redraws over it', async () => {
    const { Building } = await import('../../claudeville/src/domain/entities/Building.js');
    const { SceneryEngine } = await import('../../claudeville/src/presentation/character-mode/SceneryEngine.js');
    const { MAP_SIZE } = await import('../../claudeville/src/config/constants.js');
    const { buildTavernArcadeSprites } = await import('../../claudeville/src/presentation/character-mode/TavernArcade.js');
    const def = BUILDING_DEFS.find((candidate) => candidate.type === 'tavern');
    const tavern = new Building(def);
    const bar = REST_SEATS.filter((seat) => seat.occluder === 'stool');
    assert.ok(bar.length >= 3);
    for (const seat of bar) {
        assert.equal(seat.building, 'tavern');
        assert.ok(tavern.containsPoint(seat.tileX, seat.tileY), `${seat.id} stands inside the footprint`);
        assert.ok(tavern.isOpenFloor(seat.tileX, seat.tileY), `${seat.id} stands on the open floor`);
    }
    // The bar block behind the floor stays solid.
    assert.equal(tavern.isOpenFloor(22, 14), false);
    const world = { buildings: new Map([['tavern', tavern]]) };
    const scenery = new SceneryEngine({ world, terrainSeed: 1, tileNoise: () => 0.5 });
    scenery.generateBridges();
    const grid = scenery.getWalkabilityGrid();
    for (const seat of bar) assert.ok(grid[seat.tileY * MAP_SIZE + seat.tileX], `${seat.id} is walkable`);
    assert.equal(Boolean(grid[14 * MAP_SIZE + 22]), false, 'the bar block is not');
    // One column-sliced prop along the post line, sorted in front of the bar
    // stools and behind the yard.
    const assets = {
        get: () => ({ width: 296, height: 288 }),
        getAnchor: () => [158, 218],
        getEntry: () => ({ materialClass: 'stone' }),
    };
    const [arcade] = buildTavernArcadeSprites({ building: tavern, assets });
    assert.ok(arcade.occlusionColumns.length > 4);
    const sortAt = (worldX) => arcade.occlusionColumns
        .find((column) => worldX - arcade.x >= column.left && worldX - arcade.x < column.right).sortY;
    const { tileToWorld } = await import('../../claudeville/src/presentation/character-mode/Projection.js');
    for (const seat of bar) {
        const body = tileToWorld(seat.tileX, seat.tileY);
        assert.ok(sortAt(body.x) > body.y, `${seat.id} paints before the arcade`);
    }
    const yard = tileToWorld(22, 18);
    assert.ok(sortAt(yard.x) < yard.y, 'a body in the yard paints after it');
});

test('an empty Tavern banks its painted hearth; a patron or worker lights it (B3-03\')', () => {
    const tavern = { type: 'tavern' };
    const renderer = Object.assign(Object.create(BuildingSprite.prototype), {
        atmosphereState: { clock: { minuteOfDay: 12 * 60 } },
        _visitorStatusByType: new Map(),
        _patronIdsByType: new Map(),
        _litGateByType: new Map(),
    });
    assert.equal(renderer._restMaskShowing(tavern), true);
    assert.equal(renderer._emissiveGateFor(tavern), 0);

    renderer._patronIdsByType.set('tavern', new Set(['lead-1']));
    assert.equal(renderer._restMaskShowing(tavern), false);
    assert.equal(renderer._emissiveGateFor(tavern), 1);

    renderer._patronIdsByType.clear();
    renderer._visitorStatusByType.set('tavern', { working: 1 });
    assert.equal(renderer._restMaskShowing(tavern), false);

    // Buildings without an authored rest mask never bank.
    assert.equal(renderer._restMaskShowing({ type: 'archive' }), false);
});
