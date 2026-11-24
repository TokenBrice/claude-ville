import test from 'node:test';
import assert from 'node:assert/strict';

import {
    APERTURE_MIN_ZOOM,
    apertureCutContains,
    assignRoomSlots,
    buildApertureModel,
} from '../../claudeville/src/presentation/character-mode/BuildingApertureModel.js';
import {
    getBuildingApertureProfile,
    getBuildingRoomProfile,
} from '../../claudeville/src/presentation/character-mode/BuildingVisualRegistry.js';
import {
    APERTURE_RADIUS_CAP,
    apertureIntensity,
    apertureRadius,
} from '../../claudeville/src/presentation/character-mode/ApertureLights.js';
import { BuildingSprite } from '../../claudeville/src/presentation/character-mode/BuildingSprite.js';

const session = (agentId, extra = {}) => ({
    agentId,
    name: agentId.toUpperCase(),
    tool: 'spawn_agent',
    status: 'working',
    observation: { state: 'fresh', observedAt: 1, ageMs: 0 },
    visiting: false,
    ...extra,
});

test('aperture presents at most the authored desks and an exact overflow', () => {
    const model = buildApertureModel({
        buildingType: 'command',
        capacity: 3,
        sessions: ['a', 'b', 'c', 'd', 'e'].map((id) => session(id)),
    });
    assert.equal(model.slots.length, 3);
    assert.deepEqual(model.slots.map((slot) => slot.agentId), ['a', 'b', 'c']);
    assert.equal(model.overflow, 2);
});

test('overflow is zero and slots empty when nothing is assigned', () => {
    const model = buildApertureModel({ buildingType: 'command', capacity: 3, sessions: [] });
    assert.deepEqual(model.slots, []);
    assert.equal(model.overflow, 0);
});

test('a session is never presented twice', () => {
    const model = buildApertureModel({
        buildingType: 'command',
        capacity: 3,
        sessions: [session('a'), session('a'), session('b')],
    });
    assert.deepEqual(model.slots.map((slot) => slot.agentId), ['a', 'b']);
    assert.equal(model.overflow, 0);
});

test('source distinguishes physically present occupants from assigned sessions', () => {
    const visiting = buildApertureModel({
        buildingType: 'command',
        capacity: 3,
        sessions: [session('a', { visiting: true }), session('b', { visiting: true })],
    });
    assert.equal(visiting.source, 'visit');
    const mixed = buildApertureModel({
        buildingType: 'command',
        capacity: 3,
        sessions: [session('a', { visiting: true }), session('b')],
    });
    assert.equal(mixed.source, 'signal');
});

test('a slot carries the reported tool and status without claiming an outcome', () => {
    const [slot] = buildApertureModel({
        buildingType: 'command',
        capacity: 1,
        sessions: [session('a', { status: 'waiting_on_user', tool: 'wait agent' })],
    }).slots;
    assert.equal(slot.status, 'waiting_on_user');
    assert.equal(slot.tool, 'wait agent');
    assert.equal(slot.observation.state, 'fresh');
});

test('a label too long for a desk row is clipped, never wrapped onto the world', () => {
    const [slot] = buildApertureModel({
        buildingType: 'command',
        capacity: 1,
        sessions: [session('a', { name: 'Quartermaster General', tool: 'run_a_very_long_command' })],
    }).slots;
    assert.ok(slot.name.length <= 10, slot.name);
    assert.ok(slot.tool.length <= 12, slot.tool);
});

test('the aperture only opens at inspection zoom', () => {
    assert.equal(APERTURE_MIN_ZOOM, 2);
});

test('a working occupant keeps its room while it keeps working', () => {
    const first = assignRoomSlots({ previous: null, workingIds: ['a', 'b'], rooms: 3 });
    assert.deepEqual([...first.assignment.entries()], [['a', 0], ['b', 1]]);
    // 'a' stops working: only its room goes dark, 'b' does not move.
    const second = assignRoomSlots({ previous: first.assignment, workingIds: ['b'], rooms: 3 });
    assert.deepEqual([...second.assignment.entries()], [['b', 1]]);
    // A new worker takes the freed room, not 'b' s.
    const third = assignRoomSlots({ previous: second.assignment, workingIds: ['b', 'c'], rooms: 3 });
    assert.equal(third.assignment.get('b'), 1);
    assert.equal(third.assignment.get('c'), 0);
});

test('never more lit rooms than the art has; the surplus is an exact count', () => {
    const { assignment, overflow } = assignRoomSlots({
        previous: null,
        workingIds: ['a', 'b', 'c', 'd'],
        rooms: 2,
    });
    assert.equal(assignment.size, 2);
    assert.equal(overflow, 2);
});

test('rooms with no workers light nothing', () => {
    const { assignment, overflow } = assignRoomSlots({ previous: null, workingIds: [], rooms: 3 });
    assert.equal(assignment.size, 0);
    assert.equal(overflow, 0);
});

test('every painted pane is a room: Archive 10, Command 11 (B3-01)', () => {
    assert.equal(getBuildingRoomProfile('archive').slots.length, 10);
    assert.equal(getBuildingRoomProfile('command').slots.length, 11);
});

test('a Command room pane inside the open aperture cut stays dark (B3-01)', () => {
    const cut = getBuildingApertureProfile('command').cut;
    const inCut = getBuildingRoomProfile('command').slots
        .map((slot, index) => (apertureCutContains(cut, slot.at[0], slot.at[1]) ? index : -1))
        .filter((index) => index >= 0);
    // The east wing's three panes, and no drum, tower or keep pane.
    assert.deepEqual(inCut, [3, 4, 5]);

    const renderer = Object.assign(Object.create(BuildingSprite.prototype), {
        atmosphereState: { clock: { minuteOfDay: 23 * 60 } },
        _roomLitByType: new Map([['command', new Array(11).fill(1)]]),
        _apertureModel: null,
        _apertureProfile: null,
    });
    assert.equal(renderer.roomGate('command', 4), 1);
    renderer._apertureModel = { buildingType: 'command' };
    renderer._apertureProfile = getBuildingApertureProfile('command');
    assert.equal(renderer.roomGate('command', 4), 0);
    assert.equal(renderer.roomGate('command', 0), 1);
});

test('NE v0.67.1 P12: aperture radius (35 + 2.4 sqrt A) and intensity floor (0.61) boost worked rooms at night and leave day unchanged', () => {
    assert.equal(apertureRadius(0), 35);
    assert.ok(Math.abs(apertureRadius(100) - (35 + 2.4 * 10)) < 1e-9);
    assert.equal(apertureRadius(10000), APERTURE_RADIUS_CAP);
    assert.ok(Math.abs(apertureIntensity(0, 1, 1) - 0.61) < 1e-9);
    assert.ok(Math.abs(apertureIntensity(80, 0.95, 1) - (0.61 + 80 / 400) * 0.95) < 1e-9);
    assert.equal(apertureIntensity(1000, 1, 1), 1.2);
    assert.equal(apertureIntensity(80, 1, 0), 0);

    const archive = { type: 'archive' };
    const aperture = {
        building: archive,
        template: { group: 1, area: 64, key: '80.110', cx: 80, cy: 110, color: '#fcb447' },
        source: { id: 'aperture:archive:80.110', kind: 'point', role: 'aperture', x: 80, y: 110, color: '#fcb447', buildingType: 'archive', building: archive },
    };
    const makeRenderer = (minuteOfDay, roomLit) => Object.assign(Object.create(BuildingSprite.prototype), {
        atmosphereState: { clock: { minuteOfDay }, reactions: { windowWarmth: 0 } },
        lightingState: { sourceEnergy: { core: 0.95, halo: 1, spill: 1, bloom: 0.5, reach: 1, gain: 1 } },
        motionScale: 1,
        _roomLitByType: new Map([['archive', [roomLit]]]),
        _apertureModel: null,
        _apertureProfile: null,
        _staticLightSources: () => [],
        _ritualLightSources: () => [],
        _forgeSpillLightSources: () => [],
        _archiveSpillLightSources: () => [],
        _apertureSources: () => [aperture],
    });

    // Night with worked room (1.0): emits boosted radius and intensity.
    const [lit] = makeRenderer(22 * 60, 1).getLightSources();
    assert.equal(lit.id, 'aperture:archive:80.110');
    assert.ok(Math.abs(lit.radius - (35 + 2.4 * 8)) < 1e-9);
    assert.ok(Math.abs(lit.intensity - (0.61 + 64 / 400) * 0.95) < 1e-9);

    // Day (noon): room aperture gate is zero even if roomLit is set -> day unchanged.
    assert.deepEqual(makeRenderer(12 * 60, 1).getLightSources(), []);
});
