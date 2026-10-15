import test from 'node:test';
import assert from 'node:assert/strict';

import { buildDockLayoutFresh } from '../../claudeville/src/presentation/character-mode/HarborLayout.js';
import { reduceHarborTrafficState } from '../../claudeville/src/presentation/character-mode/HarborState.js';

// Detached-HEAD work consolidates like any fleet: one stack hull that keeps
// its detached marker, never a long line of skiffs.

const T = Date.parse('2026-10-15T10:00:00Z');

test('24 detached-HEAD commits in one repo draw as at most two hulls', () => {
    const events = Array.from({ length: 24 }, (_, i) => ({
        id: `det-${i}`, type: 'commit', project: '/w/detached', branch: '', targetRef: '',
        sha: `${i + 1}`.padStart(40, '0'), label: `detached ${i}`, timestamp: T + i * 1000, success: true, status: 'success',
    }));
    const state = reduceHarborTrafficState(null, events, { now: T + 60_000, motionScale: 0 });
    const ships = [...state.ships.values()].filter(ship => ship.status === 'docked');
    assert.equal(ships.length, 24);
    assert.ok(ships.every(ship => ship.detachedHead), 'the commits are detached');
    const layout = buildDockLayoutFresh(state);
    const leads = [...layout.byShipId.values()].filter(meta => meta.visualLeadId === meta.id);
    assert.ok(leads.length <= 2, `${leads.length} hulls`);
    const packed = leads.map(meta => layout.visualPackByShipId.get(meta.id).visualPackSize).reduce((a, b) => a + b, 0);
    assert.equal(packed, 24, 'the badge counts every commit');
    for (const meta of leads) assert.equal(state.ships.get(meta.id).detachedHead, true, 'the stack keeps its detached marker');
});
