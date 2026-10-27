import test from 'node:test';
import assert from 'node:assert/strict';

import { BUILDING_DEFS } from '../../claudeville/src/config/buildings.js';
import { REST_SEATS, REST_STANDS } from '../../claudeville/src/config/townPlan.js';
import { MAP_SIZE } from '../../claudeville/src/config/constants.js';
import { Building } from '../../claudeville/src/domain/entities/Building.js';
import { WAIT_AGE_STEPS_MS } from '../../claudeville/src/domain/services/SignalLedger.js';
import { classifyTool } from '../../claudeville/src/domain/services/ToolIdentity.js';
import { AgentSprite } from '../../claudeville/src/presentation/character-mode/AgentSprite.js';
import { BuildingSprite } from '../../claudeville/src/presentation/character-mode/BuildingSprite.js';
import { restSeatStepBias } from '../../claudeville/src/presentation/character-mode/DayRoutine.js';
import { MIDNIGHT_OIL_RISE_MS } from '../../claudeville/src/presentation/character-mode/NightOccupancyGate.js';
import { SceneryEngine } from '../../claudeville/src/presentation/character-mode/SceneryEngine.js';
import { VisitTileAllocator } from '../../claudeville/src/presentation/character-mode/VisitTileAllocator.js';
import { LABEL_INK, WALNUT } from '../../claudeville/src/presentation/character-mode/WorldLabelKit.js';
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

// ─── The Honest Tavern (Q1): a crowd of leads waiting on their subagents ──────

const MIN = 60_000;

function townAllocator() {
    const buildings = new Map(BUILDING_DEFS.map((def) => [def.type, new Building(def)]));
    const scenery = new SceneryEngine({ world: null, terrainSeed: 1, tileNoise: () => 0.5 });
    scenery.generateBridges();
    const grid = scenery.getWalkabilityGrid();
    const allocator = new VisitTileAllocator();
    allocator.updateContext({ buildings, agentSprites: [], pathfinder: { isWalkable: (x, y) => Boolean(grid[y * MAP_SIZE + x]) } });
    const rest = { type: 'rest-seat', restSeats: true, visitTiles: [] };
    return (id, restAt = null) => allocator.allocate({
        agent: { id, status: 'working' },
        sprite: { tile: { tileX: 20, tileY: 21 } },
        building: rest,
        dayHour: 17,
        restAt,
    });
}

test('AG-2: Tavern patrons fill its seats, then stand at its bar, never on Command\'s steps or the pier', () => {
    const sit = townAllocator();
    const tavernSeats = REST_SEATS.filter((seat) => seat.building === 'tavern');
    const stands = REST_STANDS.tavern.tiles;
    const places = Array.from({ length: tavernSeats.length + stands.length }, (_, index) => sit(`lead-${index}`, 'tavern'));
    assert.ok(places.every((place) => place?.restBuilding === 'tavern'), 'every patron is the Tavern\'s');
    const seated = places.slice(0, tavernSeats.length);
    assert.deepEqual(seated.map((place) => place.seat?.id).sort(), tavernSeats.map((seat) => seat.id).sort());
    const standing = places.slice(tavernSeats.length);
    assert.deepEqual(standing.map((place) => [place.tileX, place.tileY]), stands.map((tile) => [tile.tileX, tile.tileY]),
        'the 9th onward stands in authored order, the bar floor first');
    assert.ok(standing.every((place) => !place.seat && place.overflow));
    const beyond = sit('lead-late', 'tavern');
    assert.equal(beyond.restBuilding, 'tavern', 'past the standing room a patron still stands at the Tavern');
    const tavernKeys = new Set([...tavernSeats, ...stands].map((tile) => `${tile.tileX},${tile.tileY}`));
    assert.ok(!tavernKeys.has(`${beyond.tileX},${beyond.tileY}`));
    assert.ok(Math.min(...tavernSeats.map((seat) => Math.hypot(seat.tileX - beyond.tileX, seat.tileY - beyond.tileY))) <= 2.3);
});

// VQ-1b: a stander in a bar stool's screen column, less than a body height in
// front of it, hides that sitter's tankard, sip and slump; such tiles fill last.
test('VQ-1b: Tavern standers hide no bar sitter until the standing room is full', () => {
    const screen = ({ tileX, tileY }) => ({ x: (tileX - tileY) * 32, y: (tileX + tileY) * 16 });
    const stools = REST_SEATS.filter((seat) => seat.occluder === 'stool').map(screen);
    const hides = (tile) => {
        const at = screen(tile);
        return stools.some((stool) => stool.x === at.x && at.y > stool.y && at.y - stool.y < 64);
    };
    const hidden = REST_STANDS.tavern.tiles.map(hides);
    const first = hidden.indexOf(true);
    assert.ok(first > 0, 'the first stander hides nobody');
    assert.ok(hidden.slice(first).every(Boolean), 'every stander that hides a sitter fills after all that do not');
});

test('AG-2: an idle villager still takes the nearest free seat anywhere once the Tavern is full', () => {
    const sit = townAllocator();
    for (let index = 0; index < 8; index++) sit(`patron-${index}`, 'tavern');
    const idle = sit('idler');
    assert.ok(idle.seat, 'an idler sits');
    assert.notEqual(idle.seat.building, 'tavern');
    assert.equal(idle.restBuilding, null, 'a Command step makes no Tavern patron');
});

function patronSprite(id, { since = null, restBuilding = 'tavern' } = {}) {
    return {
        agent: { id, status: 'working' },
        visitRole: 'rest',
        _restBuilding: restBuilding,
        _subagentWait: since == null ? null : { since, seenAt: since, pint: true },
    };
}

function tavernTally(sprites, now) {
    const renderer = Object.create(BuildingSprite.prototype);
    renderer.agentSprites = sprites;
    const counts = renderer._plaqueCountsByType(now);
    return { counts, patrons: renderer.plaquePatrons.get('tavern') || null };
}

test('AG-1: the Tavern plaque tallies its patrons apart from work, with the oldest wait', () => {
    const now = 100 * MIN;
    const { counts, patrons } = tavernTally([
        patronSprite('a', { since: now - 14 * MIN - 30_000 }),
        patronSprite('b', { since: now - 3 * MIN }),
        patronSprite('wind-down'),
        patronSprite('step-sitter', { restBuilding: null }),
        { agent: { id: 'worker', status: 'working' }, _lastBuildingType: 'forge' },
    ], now);
    assert.equal(counts.has('tavern'), false, 'V8: patrons never join a work count');
    assert.equal(counts.get('forge'), 1);
    assert.deepEqual(patrons, { count: 3, age: '14m', full: false });
    assert.deepEqual(tavernTally([patronSprite('w')], now).patrons, { count: 1, age: '', full: false },
        'a wind-down drinker carries no wait');
    assert.equal(tavernTally([], now).patrons, null, 'no patrons, no cell');

    const seats = REST_SEATS.filter((seat) => seat.building === 'tavern').length;
    const full = tavernTally(Array.from({ length: seats }, (_, index) => patronSprite(`p${index}`, { since: now - MIN })), now).patrons;
    assert.deepEqual(full, { count: seats, age: '1m', full: true }, 'at seat capacity the cell turns full');
});

test('AG-1: the patron cell widens the plaque and never touches the work count', () => {
    const ctx = { font: '', save() {}, restore() {}, measureText: (text) => ({ width: String(text).length * 7 }) };
    const renderer = Object.create(BuildingSprite.prototype);
    const measure = (patrons) => renderer._measurePlaque(ctx, { type: 'tavern' }, { text: '', motif: false }, {
        count: 0, zoom: 1, isHovered: false, isLandmark: true, scaleMode: 'screen-fixed', patrons,
    });
    const bare = measure(null);
    const tally = measure({ count: 5, age: '14m', full: false });
    assert.equal(tally.countText, '', 'the work count stays empty');
    assert.equal(tally.patronText, '5');
    assert.equal(tally.patronAge, ' · 14m');
    assert.equal(tally.patronFull, false);
    assert.ok(tally.width > bare.width);
    assert.equal(tally.width, tally.headWidth + tally.patronCell + 2, 'the cell follows the head band');
    assert.equal(measure({ count: 8, age: '', full: true }).patronFull, true);
});

function inkCtx() {
    const texts = [];
    const ctx = {
        fillStyle: '',
        font: '',
        save() {}, restore() {}, translate() {}, scale() {}, fillRect() {}, setTransform() {},
        getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }),
        measureText: (text) => ({ width: String(text).length * 7 }),
        fillText(text) { texts.push([text, this.fillStyle]); },
    };
    return { ctx, texts };
}

test('G7-2: an empty building\'s board steps back to the dim ink; an occupied one keeps its gold', () => {
    const renderer = Object.create(BuildingSprite.prototype);
    renderer._labelMetricsCache = new Map();
    const titleInk = (count, paint = {}) => {
        const { ctx, texts } = inkCtx();
        const plaque = renderer._measurePlaque(ctx, { type: 'forge' }, { text: 'FORGE', motif: false, maxTextWidth: 96 }, {
            count, zoom: 1, isHovered: false, isLandmark: false, scaleMode: 'screen-fixed',
        });
        renderer._paintPlaque(ctx, plaque, { x: 0, y: 0, labelScale: 1, poleBottom: 20, accent: '#fff', quiet: !count, ...paint });
        return texts.find(([text]) => text === plaque.title)?.[1];
    };
    assert.equal(titleInk(0), LABEL_INK.textDim, 'empty: dim ink');
    assert.equal(titleInk(3), WALNUT.text, 'occupied: gold');
    assert.equal(titleInk(0, { isHovered: true }), '#ffe7a3', 'hover still lights it');
    assert.equal(titleInk(0, { alert: true }), WALNUT.text, 'an alert never dims');
    assert.equal(titleInk(0, { quiet: false }), WALNUT.text, 'READ mode never dims');
});

test('AG-4: a patron wears its wait on the 1/5/15-min ladder, held still', (t) => {
    const seat = REST_SEATS.find((candidate) => candidate.building === 'tavern' && candidate.occluder === 'tavern');
    const sprite = new AgentSprite({ id: 'patron-wait', status: 'working', provider: 'claude', model: 'claude-opus-5-5' }, {});
    sprite.motionScale = 1;
    sprite._seatedSeat = () => seat;
    sprite._placeX = 0;
    sprite._placeY = 0;
    let now = 0;
    t.mock.method(Date, 'now', () => now);
    // The tankard stamp bakes on a DOM canvas; a stand-in keeps its size.
    const hadDocument = 'document' in globalThis;
    const realDocument = globalThis.document;
    globalThis.document = { createElement: () => ({ getContext: () => ({ fillRect() {} }) }) };
    t.after(() => { if (hadDocument) globalThis.document = realDocument; else delete globalThis.document; });
    let sip = 100 * MIN;
    while (tankardLift('patron-wait', sip) === 0) sip += 40;
    let rest = sip;
    while (tankardSipStep('patron-wait', rest) >= 0) rest += 40;
    const markAt = (at, waited) => {
        now = at;
        sprite._subagentWait = waited == null ? null : { since: at - waited, seenAt: at, pint: true };
        const mark = sprite._tankardMark();
        return [mark.x, mark.y];
    };
    // Under 5 min, and with no wait at all, the tankard rises on each sip.
    assert.notDeepEqual(markAt(sip, 2 * MIN), markAt(rest, 2 * MIN), 'sipping under 5 min');
    assert.notDeepEqual(markAt(sip, null), markAt(rest, null), 'a wind-down drinker sips');
    // From 5 min the tankard stands set down: one place at every instant.
    assert.deepEqual(markAt(sip, WAIT_AGE_STEPS_MS[1]), markAt(rest, WAIT_AGE_STEPS_MS[1]), 'set down, never lifted');
    assert.notDeepEqual(markAt(rest, WAIT_AGE_STEPS_MS[1]), markAt(rest, 2 * MIN), 'set apart from the hand');
    assert.equal((markAt(rest, WAIT_AGE_STEPS_MS[1]), sprite._patronWaitTier()), 2);
    assert.equal((markAt(rest, WAIT_AGE_STEPS_MS[2]), sprite._patronWaitTier()), 3);
    sprite._subagentWait = null;
    assert.equal(sprite._patronWaitTier(), null, 'a wind-down drinker carries no wait');
    sprite._seatedSeat = () => null;
    sprite._subagentWait = { since: 1, seenAt: rest, pint: true };
    assert.equal(sprite._patronWaitTier(), null, 'a standing patron has no seated posture');
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

test('the banked hearth is a part at the base origin only while banked (B3-03\')', () => {
    const tavern = { type: 'tavern' };
    const entry = { id: 'building.tavern', layers: { banked: { width: 296, height: 288, anchor: [158, 218] } } };
    const renderer = Object.assign(Object.create(BuildingSprite.prototype), {
        assets: {
            getAnchor: () => [158, 218],
            get: (id) => (id === 'building.tavern.banked' ? { width: 296, height: 288 } : null),
            assetVersion: 'test',
        },
        _visitorStatusByType: new Map(),
        _patronIdsByType: new Map(),
    });
    const banked = renderer.partDrawsFor(entry, tavern, 1000, 2000);
    assert.equal(banked.length, 1);
    assert.equal(banked[0].name, 'banked');
    assert.equal(banked[0].x, 1000 - 158);
    assert.equal(banked[0].y, 2000 - 218);

    renderer._patronIdsByType.set('tavern', new Set(['lead-1']));
    assert.equal(renderer.partDrawsFor(entry, tavern, 1000, 2000).length, 0);
});

// VQ-8 — the banked Forge keeps a low ember floor: the mask's own ember
// course emits through its own part gate, open only while the lamps burn.
test('the banked Forge mask carries its ember floor and lamp gate; the Tavern mask none (VQ-8)', () => {
    const entry = { id: 'building.forge', layers: { banked: { width: 256, height: 232, anchor: [128, 169] } } };
    const renderer = Object.assign(Object.create(BuildingSprite.prototype), {
        assets: {
            getAnchor: () => [128, 169],
            get: (id) => (id === 'building.forge.banked' ? { width: 256, height: 232 } : null),
            assetVersion: 'test',
        },
        _villageAtRest: () => false,
        _forgeWorkload: { banked: true },
    });
    const at = (hour) => {
        renderer.atmosphereState = { clock: { minuteOfDay: hour * 60 } };
        const [banked] = renderer.partDrawsFor(entry, { type: 'forge' }, 0, 0);
        return banked;
    };
    const night = at(22);
    assert.equal(night.name, 'banked');
    assert.deepEqual(night.ember.colors, ['#d67634', '#803e22'], 'the course\'s own authored colours');
    assert.ok(night.ember.strength > 0 && night.ember.strength <= 0.5, 'a low floor, never a working fire');
    assert.equal(night.emissiveGate, 1, 'lit through no work gate at night');
    assert.equal(night.fixture, false);
    assert.equal(at(12).emissiveGate, 0, 'dark by day');
    // Never while the hearth works: no mask, no ember.
    renderer._forgeWorkload = { banked: false };
    assert.equal(at(22), undefined);
    // The Tavern's banked mask declares no ember: the building gate rules it.
    const tavernEntry = { id: 'building.tavern', layers: { banked: { width: 296, height: 288, anchor: [158, 218] } } };
    const tavern = Object.assign(Object.create(BuildingSprite.prototype), {
        assets: {
            getAnchor: () => [158, 218],
            get: (id) => (id === 'building.tavern.banked' ? { width: 296, height: 288 } : null),
            assetVersion: 'test',
        },
        atmosphereState: { clock: { minuteOfDay: 22 * 60 } },
        _visitorStatusByType: new Map(),
        _patronIdsByType: new Map(),
    });
    const [hearth] = tavern.partDrawsFor(tavernEntry, { type: 'tavern' }, 0, 0);
    assert.equal(hearth.ember, null);
    assert.equal(hearth.emissiveGate, null);
});
