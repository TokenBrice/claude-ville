import test from 'node:test';
import assert from 'node:assert/strict';

import { BuildingSprite, lampsLitAt } from '../../claudeville/src/presentation/character-mode/BuildingSprite.js';
import {
    KEEPER_ROOM_GATE,
    MIDNIGHT_OIL_FALL_MS,
    MIDNIGHT_OIL_RISE_MS,
    ROOM_APERTURE_GATE_MIN,
    ROUTING_ROOM_GATE,
    advanceNightOccupancyGate,
    buildingEmissiveGate,
    nightWindowGate,
} from '../../claudeville/src/presentation/character-mode/NightOccupancyGate.js';
import { RoomGlass, nightLitStep } from '../../claudeville/src/presentation/character-mode/RoomGlass.js';
import { isWorkingVisitor } from '../../claudeville/src/presentation/character-mode/VisitIntentManager.js';
import { buildGpuWorldRecords } from '../../claudeville/src/presentation/character-mode/gpu/GpuSceneBuilder.js';
import { normalizeGpuRecord } from '../../claudeville/src/presentation/character-mode/gpu/GpuWorldPolicy.js';
import { MIDNIGHT_OIL_SCENARIO } from '../../claudeville/src/presentation/character-mode/__simfixture__/WorldScenarios.js';

function lightFixture(phase, forgeGate) {
    const forge = { type: 'forge' };
    const watchtower = { type: 'watchtower' };
    return Object.assign(Object.create(BuildingSprite.prototype), {
        atmosphereState: {
            phase,
            phaseProgress: phase === 'night' ? 0.5 : 0,
            clock: { minuteOfDay: phase === 'night' ? 23 * 60 : 12 * 60 },
            reactions: { windowWarmth: 0.8 },
        },
        lightingState: { lightBoost: 1, beaconIntensity: 1 },
        harborStatus: { failedPushActive: false, activeWorkingCount: 0 },
        motionScale: 1,
        _litGateByType: new Map([['forge', { value: forgeGate, target: forgeGate }]]),
        _staticLightSources: () => [
            { id: 'forge', kind: 'point', buildingType: 'forge', building: forge, radius: 64, intensity: 1, alpha: 0.4, color: '#fff' },
            { id: 'watchtower', kind: 'point', buildingType: 'watchtower', building: watchtower, radius: 64, intensity: 1, alpha: 0.4, color: '#fff' },
        ],
        _workingVisitorCountFor: () => 0,
        _forgeGlowIntensity: () => 1,
        _beaconScaleFor: () => 1,
        _workTierFor: () => 'dormant',
        _ritualLightSources: () => [],
        _forgeSpillLightSources: () => [],
        _archiveSpillLightSources: () => [],
        _apertureSources: () => [],
    });
}

test('day is unchanged while night follows only live working occupancy', () => {
    assert.equal(buildingEmissiveGate(0, 0), 1);
    assert.equal(buildingEmissiveGate(1, 0), 0.5);
    assert.equal(buildingEmissiveGate(3, 0), 0);
    assert.equal(buildingEmissiveGate(3, 1), 1);

    // The Lighthouse lamp stands up its tower and lays no ground light at any
    // hour (2.7, AD #6); the Forge follows its occupancy gate at night.
    const dayLights = lightFixture('day', 0).getLightSources();
    assert.deepEqual(dayLights.map(light => light.id), ['forge']);
    const nightEmptyLights = lightFixture('night', 0).getLightSources();
    assert.deepEqual(nightEmptyLights.map(light => light.id), []);
    const nightWorkingLights = lightFixture('night', 1).getLightSources();
    assert.deepEqual(nightWorkingLights.map(light => light.id), ['forge']);
});

test('NE P1.2: Command gate braziers and Harbor quay lantern follow the lamp clock and Lamplighter\'s Round as fixtures', () => {
    const command = { type: 'command' };
    const harbor = { type: 'harbor' };
    const makeRenderer = (minuteOfDay, { motionScale = 1 } = {}) => Object.assign(Object.create(BuildingSprite.prototype), {
        atmosphereState: {
            phase: minuteOfDay >= 19 * 60 || minuteOfDay < 6 * 60 ? 'night' : 'day',
            clock: { minuteOfDay },
            reactions: { windowWarmth: 0.8 },
        },
        lightingState: { lightBoost: 1, beaconIntensity: 1 },
        harborStatus: { failedPushActive: false, activeWorkingCount: 0 },
        motionScale,
        assets: { getEntry: () => null },
        _litGateByType: new Map(),
        _staticLightSources: () => [
            { id: 'building.command.point.94.180', kind: 'point', role: 'aperture', normal: [-0.7, 0.7], fire: true, buildingType: 'command', building: command, radius: 42, intensity: 1, alpha: 0.4, color: '#ffbc62' },
            { id: 'building.command.point.148.204', kind: 'point', role: 'fixture', fire: true, buildingType: 'command', building: command, radius: 42, intensity: 1, alpha: 0.4, color: '#ffbc62' },
            { id: 'building.command.point.124.196', kind: 'point', role: 'aperture', fire: false, buildingType: 'command', building: command, radius: 80, intensity: 1, alpha: 0.4, color: '#ffcc66' },
            { id: 'building.harbor.point.18.150', kind: 'point', role: 'aperture', normal: [0.7, 0.7], fire: false, buildingType: 'harbor', building: harbor, radius: 96, intensity: 1, alpha: 0.4, color: '#ffd37a' },
            { id: 'building.harbor.point.187.51', kind: 'point', role: 'aperture', fire: false, buildingType: 'harbor', building: harbor, radius: 48, intensity: 1, alpha: 0.4, color: '#ffd37a' },
        ],
        _workingVisitorCountFor: () => 0,
        _forgeGlowIntensity: () => 0,
        _beaconScaleFor: () => 1,
        _workTierFor: () => 'dormant',
        _ritualLightSources: () => [],
        _forgeSpillLightSources: () => [],
        _archiveSpillLightSources: () => [],
        _apertureSources: () => [],
    });

    // Night, empty village: Command's two braziers and Harbor's quay lantern
    // emit as role: 'fixture' (omni, normal: null); non-fixture sources stay dark.
    const nightLights = makeRenderer(22 * 60).getLightSources();
    assert.deepEqual(
        nightLights.map(l => l.id),
        ['building.command.point.94.180', 'building.command.point.148.204', 'building.harbor.point.18.150'],
    );
    for (const light of nightLights) {
        assert.equal(light.role, 'fixture', `${light.id} emits as a fixture`);
        assert.equal(light.normal, null, `${light.id} is omni (no wall-face normal)`);
    }

    // Noon: lamp clock is off, so the three lamp-clock fixtures are dark while
    // ordinary daytime sources stay unchanged.
    const dayIds = makeRenderer(12 * 60).getLightSources().map(l => l.id);
    assert.ok(!dayIds.includes('building.command.point.94.180'));
    assert.ok(!dayIds.includes('building.command.point.148.204'));
    assert.ok(!dayIds.includes('building.harbor.point.18.150'));
    assert.ok(dayIds.includes('building.command.point.124.196'));

    // Dusk settling (Lamplighter's Round): Harbor sits near the Lighthouse and
    // catches (~1.9 min after duskStart 1132.5) before Command inland (~3.3 min);
    // reduced motion lights both together on the shared lamp clock.
    const midRoundMinute = 1135;
    const midRoundIds = makeRenderer(midRoundMinute, { motionScale: 1 }).getLightSources().map(l => l.id);
    assert.ok(midRoundIds.includes('building.harbor.point.18.150'), 'Harbor catches early in the round');
    assert.ok(!midRoundIds.includes('building.command.point.94.180'), 'Command inland waits for the round');
    const reducedIds = makeRenderer(midRoundMinute, { motionScale: 0 }).getLightSources().map(l => l.id);
    assert.ok(reducedIds.includes('building.command.point.94.180'), 'reduced motion lights Command on the shared clock');
    assert.ok(reducedIds.includes('building.harbor.point.18.150'), 'reduced motion lights Harbor on the shared clock');
});

test('NE v0.67.1 K: Lighthouse keeper cottage hearth is a lamp-clock fixture at night and absent by day', () => {
    const watchtower = { type: 'watchtower', position: { tileX: 28, tileY: 12 }, containsPoint: () => false };
    const makeWatchtower = (minuteOfDay, { motionScale = 1 } = {}) => Object.assign(Object.create(BuildingSprite.prototype), {
        buildings: [watchtower],
        atmosphereState: {
            phase: minuteOfDay >= 19 * 60 || minuteOfDay < 6 * 60 ? 'night' : 'day',
            clock: { minuteOfDay },
            reactions: { windowWarmth: 0 },
        },
        lightingState: { sourceEnergy: { core: 0.95, halo: 1.3, spill: 1, bloom: 0.8, reach: 1.5, gain: 1.2 } },
        harborStatus: { failedPushActive: false, activeWorkingCount: 0 },
        motionScale,
        assets: {
            getEntry: (id) => (id === 'building.watchtower' ? { id } : null),
            getAnchor: () => [144, 320],
        },
        _buildingScreenCenter: () => ({ x: 1000, y: 1000 }),
        _litGateByType: new Map(),
        _staticLightSources: () => [
            { id: 'building.watchtower.point.144.40', kind: 'point', buildingType: 'watchtower', building: watchtower, radius: 120, intensity: 1, alpha: 0.4, color: '#fff' },
        ],
        _workingVisitorCountFor: () => 0,
        _forgeGlowIntensity: () => 0,
        _beaconScaleFor: () => 1,
        _workTierFor: () => 'dormant',
        _ritualLightSources: () => [],
        _forgeSpillLightSources: () => [],
        _archiveSpillLightSources: () => [],
        _apertureSources: () => [],
    });

    // Day (noon): lamp clock off -> no cottage hearth emitted (day unchanged).
    assert.deepEqual(makeWatchtower(12 * 60).getLightSources(), []);

    // Night (22:00), empty village: steady fixture at cottage door [96, 314], foot [90, 334].
    const nightLights = makeWatchtower(22 * 60).getLightSources();
    assert.deepEqual(nightLights.map(l => l.id), ['building.watchtower.cottage-hearth.28.12']);
    const [hearth] = nightLights;
    assert.equal(hearth.role, 'fixture');
    assert.equal(hearth.normal, null);
    assert.equal(hearth.fire, false);
    assert.equal(hearth.color, '#ffc95e');
    assert.equal(hearth.radius, 64);
    assert.ok(Math.abs(hearth.intensity - 0.55 * 0.95) < 1e-9);
    assert.deepEqual(hearth.origin, { x: 1000 - 144 + 96, y: 1000 - 320 + 314 });
    assert.deepEqual(hearth.ground, { x: 1000 - 144 + 90, y: 1000 - 320 + 334 });
    assert.equal(hearth.height, 20);
    assert.equal(hearth.buildingType, 'watchtower');

    // Reduced motion lights the hearth on the shared lamp clock at settling dusk.
    const reduced = makeWatchtower(1135, { motionScale: 0 }).getLightSources();
    assert.deepEqual(reduced.map(l => l.id), ['building.watchtower.cottage-hearth.28.12']);
});

test('only present mid-turn working agents light building windows (V8 isWorkingVisitor)', () => {
    assert.equal(isWorkingVisitor({ status: 'working' }), true);
    assert.equal(isWorkingVisitor({ status: 'waiting', turnState: 'tool_pending' }), true);
    for (const status of ['idle', 'completed', 'waiting', 'waiting_on_user', 'rate_limited', 'errored']) {
        assert.equal(isWorkingVisitor({ status }), false, status);
    }
    // An approval prompt is a pending tool, but the agent is waiting on the
    // operator: counted, never lit.
    assert.equal(isWorkingVisitor({ status: 'waiting_on_user', turnState: 'tool_pending' }), false);
    assert.equal(isWorkingVisitor({ status: 'working', isDeparted: true }), false);
    assert.equal(isWorkingVisitor({ status: 'working', departedAt: 1234 }), false);
    // Rest-seat and queue occupants never count, from the visit or the agent.
    assert.equal(isWorkingVisitor({ status: 'working' }, { role: 'rest' }), false);
    assert.equal(isWorkingVisitor({ status: 'working', visitRole: 'queue' }), false);
    // A body walking an inferred work-cycle leg through another building's
    // visit tiles is travelling; at its own stop it works.
    const intent = { building: 'forge', itinerary: { inferred: true, route: ['archive', 'forge'] } };
    assert.equal(isWorkingVisitor({ status: 'working' }, { building: 'archive', intent }), false);
    assert.equal(isWorkingVisitor({ status: 'working' }, { building: 'forge', intent }), true);
    assert.equal(isWorkingVisitor({ status: 'working' }, {
        building: 'archive',
        intent: { building: 'forge', itinerary: { inferred: false } },
    }), true);
});

test('frame-fresh physical visitor tally drives the rise and completion fade', () => {
    const building = { type: 'forge', containsPoint: () => true };
    const working = { agent: { status: 'working' } };
    const renderer = Object.assign(Object.create(BuildingSprite.prototype), {
        buildings: [building],
        agentSprites: [
            working,
            { agent: { status: 'waiting', turnState: 'tool_pending' } },
            { agent: { status: 'working', departedAt: 100 } },
            { agent: { status: 'idle' } },
        ],
        motionScale: 1,
        _visitorCountByType: new Map(),
        _visitorStatusByType: new Map(),
        _visitorRepoByType: new Map(),
        _litGateByType: new Map(),
        _roomSlotsByType: new Map(),
        _roomLitByType: new Map(),
        roomGlass: { roomCount: () => 0 },
        _spriteTilePosition: () => ({ tileX: 25, tileY: 30 }),
    });
    renderer._updateVisitorCounts();
    assert.equal(renderer._visitorStatusByType.get('forge').working, 2);
    renderer._updateNightLightGates(MIDNIGHT_OIL_RISE_MS);
    assert.equal(renderer._nightShiftLit('forge'), 1);

    working.agent.status = 'completed';
    renderer.agentSprites[1].agent.turnState = null;
    renderer._updateVisitorCounts();
    renderer._updateNightLightGates(MIDNIGHT_OIL_FALL_MS);
    assert.equal(renderer._nightShiftLit('forge'), 0);
});

test('the window gate follows the lamp course (B3-02)', () => {
    assert.equal(nightWindowGate(0), 0);
    assert.equal(nightWindowGate(1), 0.5);
    assert.equal(nightWindowGate(2), 1);
    assert.equal(nightWindowGate(3), 1);
});

test('a worked window is never dark while the street lamps burn (B3-02)', () => {
    // Every minute of dusk (17:00–21:00) and dawn (04:00–08:00), in every
    // season: when lampsLitAt says the lamps are lit, the window gate is open,
    // and in daylight it is shut.
    for (const month of [0, 3, 6, 9, null]) {
        for (const [from, to] of [[17 * 60, 21 * 60], [4 * 60, 8 * 60]]) {
            for (let minute = from; minute <= to; minute++) {
                const renderer = Object.assign(Object.create(BuildingSprite.prototype), {
                    atmosphereState: {
                        clock: { minuteOfDay: minute, ...(month === null ? {} : { date: new Date(2026, month, 15) }) },
                    },
                });
                const lamps = lampsLitAt(renderer.atmosphereState);
                const gate = renderer._nightWindowGate();
                if (lamps) assert.ok(gate > 0, `month ${month} ${minute}: lamps lit, windows dark`);
                else assert.equal(gate, 0, `month ${month} ${minute}: daylight windows lit`);
            }
        }
    }
});

test('working transitions are monotonic and reduced motion snaps instantly', () => {
    const rising = [0];
    for (let elapsed = 0; elapsed < MIDNIGHT_OIL_RISE_MS; elapsed += 80) {
        rising.push(advanceNightOccupancyGate(rising.at(-1), 1, 80, 1));
    }
    assert.equal(rising.at(-1), 1);
    assert.ok(rising.every((value, index) => index === 0 || value >= rising[index - 1]));

    const falling = [1];
    for (let elapsed = 0; elapsed < MIDNIGHT_OIL_FALL_MS; elapsed += 160) {
        falling.push(advanceNightOccupancyGate(falling.at(-1), 0, 160, 1));
    }
    assert.equal(falling.at(-1), 0);
    assert.ok(falling.every((value, index) => index === 0 || value <= falling[index - 1]));
    assert.equal(advanceNightOccupancyGate(0, 1, 16, 0), 1);
    assert.equal(advanceNightOccupancyGate(1, 0, 16, 0), 0);
});

test('GPU building records carry the shared emissive gate and omitted gates normalize to one', () => {
    const image = { width: 20, height: 30 };
    const renderer = {
        assets: {
            assetVersion: 'test',
            get: id => id === 'building.forge' ? image : null,
            getDims: () => ({ w: 20, h: 30 }),
            getAnchor: () => [10, 25],
        },
        buildingRenderer: {
            _workTierFor: () => 'dormant',
            _emissiveGateFor: () => 0,
        },
        camera: { zoom: 1 },
    };
    const records = buildGpuWorldRecords(renderer, {
        drawables: [{
            kind: 'building',
            payload: {
                kind: 'building',
                building: { type: 'forge' },
                entry: { id: 'building.forge' },
                wx: 100,
                wy: 80,
            },
        }],
    });
    assert.equal(records.length, 1);
    assert.equal(records[0].emissiveGate, 0);
    assert.equal(normalizeGpuRecord({ emissiveGate: -2 }).emissiveGate, 0);
    assert.equal(normalizeGpuRecord({ emissiveGate: 4 }).emissiveGate, 1);
    assert.equal(normalizeGpuRecord({}).emissiveGate, 1);
});

test('midnight-oil fixture pins two working buildings and non-working buildings at 23:10', () => {
    assert.equal(MIDNIGHT_OIL_SCENARIO.id, 'midnight-oil');
    assert.equal(MIDNIGHT_OIL_SCENARIO.metadata.atmosphere.clock.hours, 23);
    assert.equal(MIDNIGHT_OIL_SCENARIO.metadata.atmosphere.weather.type, 'clear');
    assert.deepEqual(
        MIDNIGHT_OIL_SCENARIO.agents.filter(agent => isWorkingVisitor(agent)).map(agent => agent.id),
        ['oil-forge', 'oil-archive'],
    );
    assert.deepEqual(
        MIDNIGHT_OIL_SCENARIO.agents.filter(agent => !isWorkingVisitor(agent)).map(agent => agent.id),
        ['oil-idle', 'oil-waiting'],
    );
});

function makeRoomRenderer({ minuteOfDay = 22 * 60, buildings = null, roomsByType = null, agentSprites = [], motionScale = 1 } = {}) {
    const list = buildings || [
        { type: 'command', containsPoint: () => false },
        { type: 'archive', containsPoint: () => false },
        { type: 'forge', containsPoint: () => false },
    ];
    const counts = roomsByType || { command: 11, archive: 10, forge: 2, mine: 1, taskboard: 2, harbor: 8, watchtower: 3, tavern: 5, portal: 0 };
    return Object.assign(Object.create(BuildingSprite.prototype), {
        buildings: list,
        agentSprites,
        motionScale,
        atmosphereState: {
            phase: minuteOfDay >= 19 * 60 || minuteOfDay < 6 * 60 ? 'night' : 'day',
            clock: { minuteOfDay },
            reactions: { windowWarmth: 0.8 },
        },
        lightingState: { lightBoost: 1, beaconIntensity: 1 },
        harborStatus: { failedPushActive: false, activeWorkingCount: 0 },
        assets: { getEntry: () => null },
        _visitorCountByType: new Map(),
        _visitorStatusByType: new Map(),
        _visitorRepoByType: new Map(),
        _litGateByType: new Map(),
        _roomSlotsByType: new Map(),
        _roomLitByType: new Map(),
        _apertureModel: null,
        _apertureProfile: null,
        roomGlass: { roomCount: (type) => counts[type] ?? 0 },
        _spriteTilePosition: (sprite) => sprite._pos || { tileX: 15, tileY: 22 },
        _workingVisitorCountFor(building) { return this._visitorStatusByType.get(building?.type)?.working || 0; },
        _forgeGlowIntensity: () => 0,
        _workTierFor: () => 'dormant',
        _ritualLightSources: () => [],
        _forgeSpillLightSources: () => [],
        _archiveSpillLightSources: () => [],
        _staticLightSources: () => [],
        _apertureSources: () => [],
    });
}

test('NE P3.1: keeper room 0 holds KEEPER_ROOM_GATE at lamp course >= 2 with 0 workers, and stays dark by day and at settling', () => {
    assert.equal(KEEPER_ROOM_GATE, 0.40);
    assert.equal(ROUTING_ROOM_GATE, 0.6);
    assert.equal(ROOM_APERTURE_GATE_MIN, 0.5);

    // Lamp course 2 (lamplight, ~19:45) and 3 (deep night, 22:00): room 0 holds 0.40, other rooms 0.
    for (const minuteOfDay of [19 * 60 + 50, 22 * 60]) {
        const renderer = makeRoomRenderer({ minuteOfDay });
        renderer._updateVisitorCounts();
        renderer._updateNightLightGates(MIDNIGHT_OIL_RISE_MS);
        for (const type of ['command', 'archive', 'forge']) {
            assert.ok(Math.abs(renderer.roomGate(type, 0) - KEEPER_ROOM_GATE) < 1e-6, `${type} at ${minuteOfDay}`);
            assert.ok(Math.abs(renderer.roomGlassGate(type, 0) - KEEPER_ROOM_GATE) < 1e-6, `${type} glass at ${minuteOfDay}`);
            assert.equal(renderer.roomGate(type, 1), 0, `${type} room 1 stays dark`);
        }
    }

    // Settling dusk (lamp course 1, e.g. 19:00): no keeper yet.
    const dusk = makeRoomRenderer({ minuteOfDay: 19 * 60 });
    dusk._updateVisitorCounts();
    dusk._updateNightLightGates(MIDNIGHT_OIL_RISE_MS);
    assert.equal(dusk.roomGate('command', 0), 0);

    // Noon (lamp course 0): no keeper, day unchanged.
    const noon = makeRoomRenderer({ minuteOfDay: 12 * 60 });
    noon._updateVisitorCounts();
    noon._updateNightLightGates(MIDNIGHT_OIL_RISE_MS);
    assert.equal(noon.roomGate('command', 0), 0);
    assert.equal(noon.roomGlassGate('command', 0), 0);
});

test('NE P3.1: routing working session lights at 0.6 after physical workers and lifts to 1.0 on arrival in the same room', () => {
    let arrived = false;
    const archive = { type: 'archive', containsPoint: () => arrived };
    const workerA = {
        agent: { id: 'agent-a', status: 'working', targetBuildingType: 'archive' },
        _lastIntentSnapshot: { building: 'archive', itinerary: { inferred: false } },
    };
    const renderer = makeRoomRenderer({
        minuteOfDay: 22 * 60,
        buildings: [archive],
        agentSprites: [workerA],
    });

    // Walking toward Archive: takes room 0 at ROUTING_ROOM_GATE (0.6).
    renderer._updateVisitorCounts();
    renderer._updateNightLightGates(MIDNIGHT_OIL_RISE_MS);
    assert.equal(renderer._roomSlotsByType.get('archive').routingAssignment.get('agent-a'), 0);
    assert.equal(renderer._roomSlotsByType.get('archive').assignment.size, 0);
    assert.ok(Math.abs(renderer.roomGate('archive', 0) - ROUTING_ROOM_GATE) < 1e-6);
    assert.equal(renderer.roomGate('archive', 1), 0);

    // Arrival: keeps room 0 and lifts to 1.0.
    arrived = true;
    renderer._updateVisitorCounts();
    renderer._updateNightLightGates(MIDNIGHT_OIL_RISE_MS);
    assert.equal(renderer._roomSlotsByType.get('archive').assignment.get('agent-a'), 0);
    assert.equal(renderer._roomSlotsByType.get('archive').routingAssignment.size, 0);
    assert.equal(renderer.roomGate('archive', 0), 1);

    // Second session still walking takes room 1 at 0.6 while room 0 stays at 1.0.
    const workerB = {
        agent: { id: 'agent-b', status: 'working', targetBuildingType: 'archive' },
        _lastIntentSnapshot: { building: 'archive', itinerary: { inferred: false } },
    };
    archive.containsPoint = (x) => x === 9;
    workerA._pos = { tileX: 9, tileY: 17 };
    workerB._pos = { tileX: 16, tileY: 22 };
    renderer.agentSprites = [workerA, workerB];
    renderer._updateVisitorCounts();
    renderer._updateNightLightGates(MIDNIGHT_OIL_RISE_MS);
    assert.equal(renderer.roomGate('archive', 0), 1);
    assert.ok(Math.abs(renderer.roomGate('archive', 1) - ROUTING_ROOM_GATE) < 1e-6);

    // By day, routing lights nothing (day unchanged).
    const noon = makeRoomRenderer({
        minuteOfDay: 12 * 60,
        buildings: [{ type: 'archive', containsPoint: () => false }],
        agentSprites: [workerB],
    });
    noon._updateVisitorCounts();
    noon._updateNightLightGates(MIDNIGHT_OIL_RISE_MS);
    assert.equal(noon.roomGate('archive', 0), 0);
    assert.equal(noon.roomGlassGate('archive', 0), 0);
});

test('NE P3.1: keeper lays no aperture pool (<= 0.5), while routing (0.6) and arrived work (1.0) do', () => {
    const command = { type: 'command', containsPoint: () => false };
    const mine = { type: 'mine', containsPoint: () => false };
    const standInSource = { id: 'mine:standin', kind: 'point', buildingType: 'mine', building: mine, radius: 80, intensity: 1, alpha: 0.4, color: '#ffb84d' };
    const apertureRecord = {
        building: command,
        template: { group: 1, area: 40, key: '143.103', cx: 143, cy: 103, color: '#fcb447' },
        source: { id: 'aperture:command:143.103', kind: 'point', role: 'aperture', x: 100, y: 100, color: '#fcb447', buildingType: 'command', building: command },
    };
    const renderer = makeRoomRenderer({
        minuteOfDay: 22 * 60,
        buildings: [command, mine],
        agentSprites: [],
    });
    renderer._staticLightSources = () => [standInSource];
    renderer._apertureStandIns = new Map([[standInSource, 1]]);
    renderer._apertureSources = () => [apertureRecord];

    // Empty village at 22:00: keeper holds 0.40 on both buildings, emits ZERO street pools.
    renderer._updateVisitorCounts();
    renderer._updateNightLightGates(MIDNIGHT_OIL_RISE_MS);
    assert.ok(Math.abs(renderer.roomGate('command', 0) - KEEPER_ROOM_GATE) < 1e-6);
    assert.ok(Math.abs(renderer.roomGate('mine', 0) - KEEPER_ROOM_GATE) < 1e-6);
    assert.deepEqual(renderer.getLightSources().map(l => l.id), []);

    // Routing session at 0.6 (> 0.5): lays its aperture pool (and stand-in pool on Mine).
    renderer.agentSprites = [
        { agent: { id: 'r1', status: 'working', targetBuildingType: 'command' } },
        { agent: { id: 'r2', status: 'working', targetBuildingType: 'mine' } },
    ];
    renderer._updateVisitorCounts();
    renderer._updateNightLightGates(MIDNIGHT_OIL_RISE_MS);
    const routingLights = renderer.getLightSources();
    assert.deepEqual(routingLights.map(l => l.id).sort(), ['aperture:command:143.103', 'mine:standin']);
    const routingIntensity = routingLights.find(l => l.id === 'aperture:command:143.103').intensity;

    // Arrival lifts Command to 1.0 with stronger full aperture spill.
    command.containsPoint = () => true;
    renderer._updateVisitorCounts();
    renderer._updateNightLightGates(MIDNIGHT_OIL_RISE_MS);
    const workedIntensity = renderer.getLightSources().find(l => l.id === 'aperture:command:143.103').intensity;
    assert.ok(workedIntensity > routingIntensity, `worked (${workedIntensity}) > routing (${routingIntensity})`);
});

test('NE P3.1: waiting, needs-you, errored, rate-limited and idle villagers light nothing beyond the empty keeper', () => {
    const command = { type: 'command', containsPoint: () => true };
    const archive = { type: 'archive', containsPoint: () => false };
    const renderer = makeRoomRenderer({
        minuteOfDay: 22 * 60,
        buildings: [command, archive],
        agentSprites: [
            { agent: { id: 'w1', status: 'waiting', targetBuildingType: 'command' } },
            { agent: { id: 'n1', status: 'waiting_on_user', turnState: 'tool_pending', targetBuildingType: 'command' } },
            { agent: { id: 'e1', status: 'errored', targetBuildingType: 'archive' } },
            { agent: { id: 'q1', status: 'rate_limited', targetBuildingType: 'archive' } },
            { agent: { id: 'i1', status: 'idle', targetBuildingType: 'archive' } },
        ],
    });
    renderer._updateVisitorCounts();
    renderer._updateNightLightGates(MIDNIGHT_OIL_RISE_MS);
    for (const type of ['command', 'archive']) {
        const slots = renderer._roomSlotsByType.get(type);
        assert.equal(slots.assignment.size, 0, `${type} has no worked room`);
        assert.equal(slots.routingAssignment.size, 0, `${type} has no routing room`);
        assert.ok(Math.abs(renderer.roomGate(type, 0) - KEEPER_ROOM_GATE) < 1e-6, `${type} holds only dim keeper`);
        assert.equal(renderer.roomGate(type, 1), 0, `${type} room 1 stays dark`);
    }
});

test('NE P3.1: RoomGlass nightLitStep separates keeper (0.40), routing (0.60) and worked (1.0) and repaints litPatch', () => {
    assert.equal(nightLitStep(KEEPER_ROOM_GATE), 0.4);
    assert.equal(nightLitStep(ROUTING_ROOM_GATE), 0.6);
    assert.equal(nightLitStep(1), 1);

    const prevDoc = globalThis.document;
    const writes = [];
    globalThis.document = {
        createElement: () => ({
            width: 0,
            height: 0,
            getContext: () => ({
                createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
                putImageData: (img) => { writes.push(new Uint8ClampedArray(img.data)); },
            }),
        }),
    };
    try {
        const rg = new RoomGlass(null);
        rg._maps.set('command', {
            left: 0, top: 0, w: 2, h: 1, spriteWidth: 2, rooms: 2,
            group: new Int8Array([1, 2]),
            albedo: new Uint8ClampedArray([47, 52, 69, 255, 47, 52, 69, 255]),
            emissive: new Uint8ClampedArray([252, 180, 71, 124, 252, 180, 71, 124]),
            channels: { material: null, occluder: null },
        });
        const keeper = rg.litPatch('command', (g) => (g === 1 ? KEEPER_ROOM_GATE : 0));
        assert.ok(keeper);
        assert.equal(writes[0][3], Math.round(255 * 0.4));
        assert.equal(writes[0][7], 0);
        const rev1 = keeper.revision;
        const routing = rg.litPatch('command', (g) => (g === 1 ? ROUTING_ROOM_GATE : 0));
        assert.ok(routing.revision > rev1, 'routing tier repaints litPatch');
        assert.equal(writes[2][3], Math.round(255 * 0.6));
    } finally {
        globalThis.document = prevDoc;
    }
});
