import test from 'node:test';
import assert from 'node:assert/strict';

import {
    HARBOR_SAIL_ACCEL_MS,
    HARBOR_SAIL_MAX_MS,
    HARBOR_SAIL_MIN_MS,
    composeWaterRouteTiles,
    harborCruiseSpeed,
    harborSailDistance,
    harborSailDurationMs,
    routeLengthTiles,
} from '../../claudeville/src/presentation/character-mode/HarborLayout.js';
import { FORCE_DEPARTURE_MS, reduceHarborTrafficState } from '../../claudeville/src/presentation/character-mode/HarborState.js';

// Phase 3.4 — arc-length sailing: duration from route length and cruise
// speed, rest → cruise acceleration, and line-astern convoys (P-D6, P-D7).

test('a departure accelerates from rest, then holds cruise to the end of its route', () => {
    const length = 20;
    const duration = harborSailDurationMs(length, 0.7);
    assert.equal(harborSailDistance(0, length, duration), 0);
    const early = harborSailDistance(100, length, duration) - harborSailDistance(0, length, duration);
    const cruise = harborSailDistance(duration - 100, length, duration) - harborSailDistance(duration - 200, length, duration);
    assert.ok(early < cruise / 10, 'starts from rest');
    assert.ok(Math.abs(harborSailDistance(duration, length, duration) - length) < 1e-6);
    let previous = 0;
    for (let t = 0; t <= duration; t += 250) {
        const d = harborSailDistance(t, length, duration);
        assert.ok(d >= previous - 1e-9, 'never sails backwards');
        previous = d;
    }
    // Cruise holds to the end: no ease-out.
    const mid = harborSailDistance(HARBOR_SAIL_ACCEL_MS + 1000, length, duration) - harborSailDistance(HARBOR_SAIL_ACCEL_MS, length, duration);
    assert.ok(Math.abs(cruise * 10 - mid) < 0.01);
});

test('duration follows route length at cruise speed, clamped', () => {
    assert.equal(harborSailDurationMs(0.5, 0.8), HARBOR_SAIL_MIN_MS);
    assert.equal(harborSailDurationMs(500, 0.8), HARBOR_SAIL_MAX_MS);
    const d = harborSailDurationMs(30, 0.75);
    assert.equal(d, Math.round((30 / 0.75 + HARBOR_SAIL_ACCEL_MS / 2000) * 1000));
    assert.ok(harborCruiseSpeed({ status: 'docked', repoDockIndex: 0, repoDockCount: 1 }) > harborCruiseSpeed({ status: 'docked', repoDockIndex: 0, repoDockCount: 12 }), 'a skiff out-sails a flagship');
});

const T = Date.parse('2026-10-15T10:00:00Z');
function fleetPush(count, push = {}) {
    const events = Array.from({ length: count }, (_, i) => ({ id: `c${i}`, type: 'commit', project: '/w/sail', branch: 'main', targetRef: 'main', sha: `${i + 1}`.padStart(40, '0'), label: `c ${i}`, timestamp: T + i * 1000, success: true, status: 'success' }));
    events.push({ id: 'p', type: 'push', project: '/w/sail', branch: 'main', targetRef: 'main', timestamp: T + 60_000, success: true, exitCode: 0, ...push });
    return reduceHarborTrafficState(null, events, { now: T + 60_000, motionScale: 1 });
}

test('a convoy casts off nearest-open-water first, one ship at a time, at one speed', () => {
    const state = fleetPush(4);
    const ships = [...state.ships.values()].filter(ship => ship.status === 'departing');
    assert.equal(ships.length, 4);
    const plans = ships.map(ship => ({
        ship,
        length: routeLengthTiles(composeWaterRouteTiles(ship.departFromTile, ship)),
        start: ship.departStartedAt,
    })).sort((a, b) => a.start - b.start);
    for (let i = 1; i < plans.length; i++) {
        assert.ok(plans[i].start > plans[i - 1].start, 'each ship casts off after the one before');
        assert.ok(plans[i].length >= plans[i - 1].length - 1e-6, 'the ship nearest open water leads');
        // One convoy speed: duration ∝ route length.
        const speedA = plans[i - 1].length / (plans[i - 1].ship.departMsOverride / 1000 - HARBOR_SAIL_ACCEL_MS / 2000);
        const speedB = plans[i].length / (plans[i].ship.departMsOverride / 1000 - HARBOR_SAIL_ACCEL_MS / 2000);
        assert.ok(Math.abs(speedA - speedB) < 0.02, `convoy speeds ${speedA.toFixed(3)} / ${speedB.toFixed(3)}`);
    }
});

test('a force-push keeps its short fixed run', () => {
    const state = fleetPush(2, { force: true, flags: ['--force'], command: 'git push --force' });
    const forced = [...state.ships.values()].filter(ship => ship.status === 'departing' && ship.pushForce === true);
    assert.ok(forced.length > 0);
    for (const ship of forced) assert.equal(ship.departMsOverride, FORCE_DEPARTURE_MS);
});
