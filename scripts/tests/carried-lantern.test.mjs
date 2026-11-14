import test from 'node:test';
import assert from 'node:assert/strict';

import {
    LANTERN_CROWD_DISTANCE,
    LANTERN_CROWD_RADIUS,
    LANTERN_ID_PREFIX,
    LANTERN_POOL_RADIUS,
    lanternCandidate,
    lanternIntensity,
    lanternPoolRadius,
    selectLanternCarriers,
} from '../../claudeville/src/presentation/character-mode/CarriedLantern.js';
import {
    LIGHT_ROLE_CODES,
    binGpuLights,
    clampGpuLights,
    effectBudgetMode,
} from '../../claudeville/src/presentation/character-mode/gpu/GpuWorldPolicy.js';

const body = (id, x, y, extra = {}) => ({ id, x, y, tileX: 10, tileY: 10, ...extra });
const ids = list => list.map(c => c.id);

test('NL-4: no lantern at strength 0, before the lamps, or before the round reaches the tile', () => {
    const bodies = [body('a', 0, 0), body('b', 10, 0, { tileX: 30 })];
    assert.deepEqual(selectLanternCarriers(bodies, { strength: 0, lampsLit: true }), []);
    assert.deepEqual(selectLanternCarriers(bodies, { strength: 1, lampsLit: false }), []);
    const round = (tileX) => tileX < 20;
    assert.deepEqual(ids(selectLanternCarriers(bodies, { strength: 1, lampsLit: true, roundLit: round })), ['a']);
});

// A sprite as IsometricRenderer hands it to `lanternCandidate`.
const sprite = (status, extra = {}) => ({
    agent: { status, isDeparted: false },
    x: 0,
    y: 0,
    _placeX: extra.x ?? 0,
    _placeY: extra.y ?? 0,
    moving: extra.moving ?? false,
    visitRole: extra.visitRole ?? null,
    _seatedSeat: () => extra.seat ?? null,
    isArrivalPending: () => extra.pending === true,
    ...extra.more,
});
const tileOf = () => ({ tileX: 10, tileY: 10 });
const carry = (sprites, options = {}) => ids(selectLanternCarriers(
    [...sprites].map(([id, s]) => lanternCandidate(id, s, tileOf)),
    { strength: 1, lampsLit: true, ...options },
));

test('NL-4: the same bodies with any statuses carry the same lanterns, a waiting walker included', () => {
    const place = [
        ['walker', { moving: true, x: 0 }],
        ['stander', { x: 40 }],
        ['sitter', { x: 80, seat: { building: 'command' } }],
    ];
    const results = ['working', 'idle', 'waiting_on_user', 'errored', 'rate_limited'].map(status =>
        carry(place.map(([id, extra]) => [id, sprite(status, extra)])));
    for (const result of results) assert.deepEqual(result, results[0]);
    assert.deepEqual(results[0].sort(), ['sitter', 'stander', 'walker']);
});

test('NL-4: every eligible body carries a stamp, whatever the camera', () => {
    const bodies = Array.from({ length: 30 }, (_, n) => [`v${n}`, sprite('working', { x: n * 10 })]);
    const near = carry(bodies, { centre: { x: 0, y: 0 } });
    const far = carry(bodies, { centre: { x: 5000, y: 0 } });
    assert.equal(near.length, 30);
    assert.deepEqual([...near].sort(), [...far].sort());
    // The centre only orders them (the pool cap takes the nearest).
    assert.equal(near[0], 'v0');
    assert.equal(far[0], 'v29');
});

test('NL-4: rules of place: a Command queue slot and the indoor bar stools carry none, the beer garden does', () => {
    const got = carry([
        ['queued', sprite('waiting_on_user', { visitRole: 'queue' })],
        ['to-queue', sprite('waiting_on_user', { visitRole: 'queue', moving: true })],
        ['bar', sprite('idle', { seat: { building: 'tavern', occluder: 'stool' } })],
        ['garden', sprite('idle', { seat: { id: 'tavern-yard-w', building: 'tavern', occluder: 'tavern' } })],
        ['arriving', sprite('working', { pending: true })],
        ['departed', sprite('working', { more: { agent: { status: 'working', isDeparted: true } } })],
        ['fading', sprite('working', { more: { _archiveAnim: { startedAt: 0 } } })],
    ]);
    assert.deepEqual(got.sort(), ['garden', 'to-queue']);
});

test('NL-4: the pool stays smaller than a street lamp pool, dimmer than an attention light, and scales with the look', () => {
    // A street lamp: radius 66 at 0.82; an attention light: 0.45-0.6.
    assert.equal(lanternPoolRadius(1), LANTERN_POOL_RADIUS);
    assert.ok(LANTERN_POOL_RADIUS < 66);
    assert.ok(lanternIntensity(1, 1) < 0.6);
    assert.ok(lanternPoolRadius(0.5) < lanternPoolRadius(1));
    assert.ok(lanternIntensity(0.5, 1) < lanternIntensity(1, 1));
    // A crowded carrier lays the smaller pool.
    assert.equal(lanternPoolRadius(1, true), LANTERN_CROWD_RADIUS);
    assert.ok(LANTERN_CROWD_RADIUS < LANTERN_POOL_RADIUS);
});

test('NL-4: carriers within the crowd distance of another carrier are crowded, a lone one is not', () => {
    const bodies = [body('a', 0, 0), body('b', 60, 0), body('c', 600, 0)];
    const carriers = selectLanternCarriers(bodies, { strength: 1, lampsLit: true });
    const crowded = Object.fromEntries(carriers.map(c => [c.id, c.crowded]));
    assert.deepEqual(crowded, { a: true, b: true, c: false });
    // Ground distance counts y twice (iso): 60 px down is 120 apart.
    const far = selectLanternCarriers([body('a', 0, 0), body('b', 0, LANTERN_CROWD_DISTANCE / 2 + 1)], { strength: 1, lampsLit: true });
    assert.ok(far.every(c => !c.crowded));
});

test('NL-4: the quality ladder keeps 12 / 6 / 0 pools', () => {
    assert.deepEqual([0, 1, 2].map(level => effectBudgetMode('carried-lanterns', level)), [12, 6, 0]);
});

test('NL-4: lanterns rank last and never take a lamp, window or attention slot', () => {
    const slot = (id, x, role, priority = 0) => ({
        id, x, y: 300, footX: x, footY: 300, radiusWorld: 30, height: 14,
        role: LIGHT_ROLE_CODES[role], attention: role === 'attention', priority, intensity: 1,
    });
    const lights = [
        ...Array.from({ length: 4 }, (_, n) => slot(`${LANTERN_ID_PREFIX}${n}`, 40 + n * 60, 'fixture', -1)),
        slot('lamp', 300, 'fixture'),
        slot('window', 400, 'aperture'),
        slot('mote', 500, 'point'),
        slot('attention:a', 600, 'attention'),
    ];
    const ranked = clampGpuLights(lights, 64, 64);
    assert.deepEqual(ranked.slice(0, 4).map(l => l.id), ['attention:a', 'window', 'lamp', 'mote']);
    const view = { cameraX: 0, cameraY: 0, scale: 1, width: 1024, height: 640 };
    // A count of four: every non-lantern light is admitted, no lantern.
    const tight = binGpuLights(ranked, { ...view, cap: 4 });
    assert.deepEqual(tight.admitted.map(l => l.id), ['attention:a', 'window', 'lamp', 'mote']);
    // With room, lanterns take only the leftover slots.
    const roomy = binGpuLights(ranked, { ...view, cap: 6 });
    assert.equal(roomy.admitted.filter(l => l.id.startsWith(LANTERN_ID_PREFIX)).length, 2);
});
