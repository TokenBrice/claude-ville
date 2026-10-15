import test from 'node:test';
import assert from 'node:assert/strict';

import {
    normalizeGitEvent,
    reduceHarborTrafficState,
} from '../../claudeville/src/presentation/character-mode/HarborTraffic.js';

// S-H4 / P-D3: a non-success push settles once its lifecycle has played. A
// later event-bearing reduce (any repo's new commit) must not re-run it: no
// second sortie or boomerang, no reset failure clock, no post-push commit
// swept into the old push.

const T = Date.parse('2026-10-15T10:00:00Z');
const S = 1000;
const ev = (raw) => normalizeGitEvent({ project: '/r/a', branch: 'main', targetRef: 'main', ...raw }, {}, 0, { fallbackTimestamp: T });

const OUTCOMES = {
    cancelled: { status: 'cancelled' },
    rejected: { success: false, stderr: '! [rejected] main -> main (non-fast-forward)' },
    failed: { success: false, stderr: 'fatal: unable to access' },
};

for (const [status, fields] of Object.entries(OUTCOMES)) {
    test(`a ${status} push does not re-fire after its batch expires`, () => {
        const events = [
            ev({ id: 'c1', type: 'commit', sha: 'aaaaaaa1', label: 'first commit long', timestamp: T }),
            ev({ id: 'p1', type: 'push', timestamp: T + S, ...fields }),
        ];
        let state = reduceHarborTrafficState(null, events, { now: T + 2 * S });
        const firstFailedAt = state.ships.get('c1').failedAt;
        for (const at of [40, 80]) state = reduceHarborTrafficState(state, [], { now: T + at * S });
        assert.equal(state.ships.get('c1').status, 'docked', 'lifecycle finished by t+80s');

        events.push(ev({ id: 'c2', type: 'commit', sha: 'bbbbbbb2', label: 'later commit long', timestamp: T + 85 * S }));
        state = reduceHarborTrafficState(state, events, { now: T + 90 * S });
        const c1 = state.ships.get('c1');
        const c2 = state.ships.get('c2');
        assert.equal(c1.status, 'docked', 'no second sortie');
        if (status === 'failed') assert.equal(c1.failedAt, firstFailedAt, 'failure clock is not reset');
        assert.equal(c2.status, 'docked');
        assert.equal(c2.pushStatus ?? null, null, 'a post-push commit is not swept into the old push');
        assert.equal(state.batches.size, 0, 'no rebuilt batch');
        assert.ok(state.pushEvents.get('p1')?.settledAt, 'the push is settled');

        state = reduceHarborTrafficState(state, events, { now: T + 100 * S });
        assert.equal(state.ships.get('c1').status, 'docked');
    });
}

test('a settled push replays again when its status changes', () => {
    const events = [
        ev({ id: 'c1', type: 'commit', sha: 'aaaaaaa1', label: 'first commit long', timestamp: T }),
        ev({ id: 'p1', type: 'push', timestamp: T + S, status: 'cancelled' }),
    ];
    let state = reduceHarborTrafficState(null, events, { now: T + 2 * S });
    state = reduceHarborTrafficState(state, [], { now: T + 80 * S });
    events[1] = ev({ id: 'p1', type: 'push', timestamp: T + S, success: true, exitCode: 0 });
    state = reduceHarborTrafficState(state, events, { now: T + 90 * S });
    assert.equal(state.ships.get('c1').status, 'departing');
});

test('a push never re-derives the start tile of a ship that is not docked', () => {
    const events = [
        ev({ id: 'c1', type: 'commit', sha: 'aaaaaaa1', label: 'first commit long', timestamp: T }),
        ev({ id: 'p1', type: 'push', timestamp: T + S, status: 'cancelled' }),
    ];
    let state = reduceHarborTrafficState(null, events, { now: T + 2 * S });
    const from = state.ships.get('c1').departFromTile;
    assert.equal(state.ships.get('c1').status, 'cancelling');
    events.push(ev({ id: 'c2', type: 'commit', sha: 'bbbbbbb2', label: 'unrelated commit long', timestamp: T + 3 * S, project: '/r/b' }));
    state = reduceHarborTrafficState(state, events, { now: T + 4 * S });
    assert.deepEqual(state.ships.get('c1').departFromTile, from);
});
