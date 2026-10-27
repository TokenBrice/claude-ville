import test from 'node:test';
import assert from 'node:assert/strict';

import {
    HarborTraffic,
    normalizeGitEvent,
    reduceHarborTrafficState,
    snapshotHarborTrafficState,
} from '../../claudeville/src/presentation/character-mode/HarborTraffic.js';

// S-M1: the dock layout follows every layout-relevant ship field (branch,
// detached HEAD, push status), is cached per state version rather than in a
// module-global map, and never hands out ship objects from an older state.

const T = Date.parse('2026-10-15T10:00:00Z');
const ev = (raw) => normalizeGitEvent({ project: '/r/cache', ...raw }, {}, 0, { fallbackTimestamp: T });

test('enriching a branch-less ship regroups it into its branch squad', () => {
    const e1 = ev({ id: 'c1', type: 'commit', sha: 'aaaaaaa1', label: 'one main commit', branch: 'main', timestamp: T });
    // A quiet commit that landed (its output named no sha).
    const e2 = ev({ id: 'c2', type: 'commit', label: 'second commit here', timestamp: T + 1000, success: true });
    let state = reduceHarborTrafficState(null, [e1, e2], { now: T + 2000 });
    const before = snapshotHarborTrafficState(state).ships;
    assert.equal(before.find(ship => ship.id === 'c1').squadCount, 2, 'main and branch-less squads');

    const e2b = ev({ id: 'c2-inferred', type: 'commit', sha: 'bbbbbbb2', label: 'second commit here', branch: 'main', timestamp: T + 1500, inferred: true });
    state = reduceHarborTrafficState(state, [e1, e2, e2b], { now: T + 3000 });
    assert.equal(state.ships.get('c2').branch, 'main');
    const after = snapshotHarborTrafficState(state).ships;
    assert.ok(after.every(ship => ship.squadCount === 1), 'one main squad after enrichment');
    assert.ok(after.every(ship => ship.squadIndex === 0));
});

test('the live dock layout holds the current state ship objects', () => {
    const agent = { id: 'a1', projectPath: '/r/cache', provider: 'claude', sessionId: 's1', gitEvents: [] };
    const harbor = new HarborTraffic();
    agent.gitEvents = [
        { id: 'c1', type: 'commit', project: '/r/cache', sha: 'aaaaaaa1', label: 'one main commit', branch: 'main', timestamp: T },
        { id: 'c2', type: 'commit', project: '/r/cache', label: 'second commit here', timestamp: T + 1000, success: true },
    ];
    harbor.reconcile([agent], T + 2000, { force: true });
    agent.gitEvents = [...agent.gitEvents,
        { id: 'c2-inferred', type: 'commit', project: '/r/cache', sha: 'bbbbbbb2', label: 'second commit here', branch: 'main', timestamp: T + 1500, inferred: true }];
    harbor.reconcile([agent], T + 3000, { force: true });
    let stale = 0;
    for (const squad of harbor._dockLayout.squads) {
        for (const ship of squad.ships) if (harbor.state.ships.get(ship.id) !== ship) stale++;
    }
    assert.equal(stale, 0, 'no stale ship objects in the layout');
    assert.equal(harbor._dockLayout.squads.length, 1);
    harbor.dispose();
});

test('two harbors with identical docked sets do not share a layout', () => {
    const events = [ev({ id: 'c1', type: 'commit', sha: 'aaaaaaa1', label: 'one main commit', branch: 'main', timestamp: T })];
    const left = new HarborTraffic();
    const right = new HarborTraffic();
    left.state = reduceHarborTrafficState(null, events, { now: T + 1000 });
    right.state = reduceHarborTrafficState(null, events, { now: T + 1000 });
    left.reconcile([], T + 1000, { force: true });
    right.reconcile([], T + 1000, { force: true });
    assert.notEqual(left._dockLayout, right._dockLayout);
    left.dispose();
    right.dispose();
});
