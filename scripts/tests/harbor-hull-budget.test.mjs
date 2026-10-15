import test from 'node:test';
import assert from 'node:assert/strict';

import {
    HARBOR_HULL_BUDGET_HIGH,
    HARBOR_HULL_BUDGET_LOW,
    buildDockLayoutFresh,
} from '../../claudeville/src/presentation/character-mode/HarborLayout.js';
import { reduceHarborTrafficState } from '../../claudeville/src/presentation/character-mode/HarborState.js';

// The adaptive hull budget: a busy harbor packs its largest regular fleets
// sooner (5 → 3 → 2), hysteretically; a calm one is untouched.

const T = Date.parse('2026-10-15T10:00:00Z');
let seq = 0;
const commit = (project, branch = 'main') => {
    seq += 1;
    return { id: `b-${seq}`, type: 'commit', project, branch, targetRef: branch, sha: seq.toString(16).padStart(40, '0'), label: `c ${seq}`, timestamp: T + seq * 1000, success: true, status: 'success' };
};
const hulls = state => [...buildDockLayoutFresh(state).byShipId.values()].filter(meta => meta.visualLeadId === meta.id).length;

function busy() {
    const events = [];
    for (let r = 0; r < 12; r++) for (let b = 0; b < 3; b++) for (let c = 0; c < 4; c++) events.push(commit(`/w/busy-${r}`, b ? `feat/${b}` : 'main'));
    return events;
}

test('a calm harbor keeps one hull per commit under five', () => {
    const events = [];
    for (let r = 0; r < 5; r++) for (let c = 0; c < 3; c++) events.push(commit(`/w/calm-${r}`));
    const state = reduceHarborTrafficState(null, events, { now: T + 600_000, motionScale: 0 });
    assert.equal(state.packThresholds.size, 0);
    assert.equal(hulls(state), 15);
});

test('a busy harbor packs its largest fleets until it fits the budget', () => {
    const state = reduceHarborTrafficState(null, busy(), { now: T + 600_000, motionScale: 0 });
    assert.ok(state.packThresholds.size > 0);
    assert.ok(hulls(state) <= HARBOR_HULL_BUDGET_HIGH, `${hulls(state)} hulls`);
    for (const threshold of state.packThresholds.values()) assert.ok([2, 3].includes(threshold));
});

test('the budget is hysteretic: one more or one less commit flips nothing', () => {
    let state = reduceHarborTrafficState(null, busy(), { now: T + 600_000, motionScale: 0 });
    const before = new Map(state.packThresholds);
    state = reduceHarborTrafficState(state, [commit('/w/busy-0')], { now: T + 700_000, motionScale: 0 });
    assert.deepEqual(new Map(state.packThresholds), before);
    // Shrinking into the band between the budgets keeps the packs: a fleet
    // only unpacks once the harbor would stay under the low budget.
    const pushes = ['/w/busy-11', '/w/busy-10'].map((project, i) => ({ id: `shrink-${i}`, type: 'push', project, branch: 'main', targetRef: 'main', timestamp: T + 800_000 + i, success: true, exitCode: 0 }));
    state = reduceHarborTrafficState(state, pushes, { now: T + 800_100, motionScale: 0 });
    if (hulls(state) > HARBOR_HULL_BUDGET_LOW) {
        for (const [key, threshold] of before) {
            if (state.packThresholds.has(key)) assert.ok(state.packThresholds.get(key) <= threshold, `${key} unpacked inside the band`);
        }
    }
});

test('failed squads keep their own packing whatever the budget', () => {
    const events = busy();
    for (let c = 0; c < 4; c++) events.push(commit('/w/failing', 'main'));
    events.push({ id: 'fail-push', type: 'push', project: '/w/failing', branch: 'main', targetRef: 'main', timestamp: T + (seq + 1) * 1000, success: false, stderr: 'fatal: unable to access' });
    const state = reduceHarborTrafficState(null, events, { now: T + 600_000, motionScale: 0 });
    const failing = [...buildDockLayoutFresh(state).byShipId.values()].filter(meta => meta.id.startsWith('b-') && state.ships.get(meta.id)?.project === '/w/failing' && meta.visualLeadId === meta.id);
    assert.equal(failing.length, 4, 'four failed ships stay four hulls (they pack at five)');
});
