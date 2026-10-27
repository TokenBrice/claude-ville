import test from 'node:test';
import assert from 'node:assert/strict';

import { HarborTraffic } from '../../claudeville/src/presentation/character-mode/HarborTraffic.js';

// VB-13 (lane 03 harness harbor/h12): moored PR cutters fill the
// outer-roadstead anchorages in turn, so two open PRs never share a tile,
// even after an earlier cutter has left its mooring.

const T = Date.parse('2026-10-27T10:00:00Z');
const S = 1000;
const REPO = '/w/roadstead';
const agent = (events) => ({ id: 'a', sessionId: 'a', projectPath: REPO, repoRoot: REPO, gitEvents: events });
const pr = (action, n, at) => ({
    id: `${action}-${n}`, type: 'pr', action, project: REPO, repoRoot: REPO, ts: at, completedAt: at + S,
    success: true, exitCode: 0, url: `https://github.com/o/r/pull/${n}`, inferred: true, observed: false,
});
const moorings = (harbor) => [...harbor.state.ships.values()]
    .filter(ship => ship.prShip && ship.arrivingKind === 'pr')
    .map(ship => `${ship.inboundRoadsteadTile.tileX},${ship.inboundRoadsteadTile.tileY}`);

test('VB-13: a new PR cutter takes the first free mooring, never an occupied one', () => {
    for (const merged of [1, 2, 3]) {
        const harbor = new HarborTraffic({});
        const events = [];
        for (const n of [1, 2, 3]) {
            events.push(pr('create', n, T + n * S));
            harbor.reconcile([agent([...events])], T + n * S + 500);
        }
        const before = moorings(harbor);
        assert.equal(new Set(before).size, 3);
        events.push(pr('merge', merged, T + 10 * S));
        harbor.reconcile([agent([...events])], T + 11 * S);
        events.push(pr('create', 4, T + 20 * S));
        harbor.reconcile([agent([...events])], T + 21 * S);
        const after = moorings(harbor);
        assert.equal(after.length, 3, `merged #${merged}`);
        assert.equal(new Set(after).size, 3, `merged #${merged}: two open PRs share a mooring`);
        // The new cutter takes the freed mooring, so the others stay put.
        assert.deepEqual([...after].sort(), [...before].sort(), `merged #${merged}: the freed mooring is reused`);
        harbor.dispose();
    }
});
