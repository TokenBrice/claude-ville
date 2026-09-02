import test from 'node:test';
import assert from 'node:assert/strict';

import { foldTimeline } from '../../claudeville/src/presentation/shared/ChroniclePanel.js';

const MINUTE = 60_000;
const event = (ts, kind, extra = {}) => ({ ts, kind, ...extra });

function shape(rows) {
    return rows.map(({ kind, ts, count, label }) => ({ kind, ts, count, label }));
}

test('folds same-kind events in the same minute and carries their count', () => {
    const rows = foldTimeline([
        event(5_000, 'arrived'),
        event(12_000, 'arrived'),
        event(59_999, 'arrived'),
    ]);

    assert.deepEqual(shape(rows), [{
        kind: 'arrived',
        ts: 5_000,
        count: 3,
        label: 'arrivals',
    }]);
});

test('does not fold same-kind events across a minute boundary', () => {
    const rows = foldTimeline([
        event(MINUTE - 1, 'arrived'),
        event(MINUTE, 'arrived'),
    ]);

    assert.deepEqual(shape(rows), [
        { kind: 'arrived', ts: MINUTE - 1, count: 1, label: 'arrival' },
        { kind: 'arrived', ts: MINUTE, count: 1, label: 'arrival' },
    ]);
});

test('does not fold events across a kind boundary', () => {
    const rows = foldTimeline([
        event(5_000, 'arrived'),
        event(6_000, 'completed'),
        event(7_000, 'arrived'),
    ]);

    assert.deepEqual(shape(rows), [
        { kind: 'arrived', ts: 5_000, count: 1, label: 'arrival' },
        { kind: 'completed', ts: 6_000, count: 1, label: 'completed turn' },
        { kind: 'arrived', ts: 7_000, count: 1, label: 'arrival' },
    ]);
});

test('preserves chronological order while folding', () => {
    const rows = foldTimeline([
        event(3 * MINUTE + 1_000, 'completed'),
        event(1_000, 'arrived'),
        event(1_500, 'arrived'),
        event(2 * MINUTE, 'waiting'),
    ]);

    assert.deepEqual(shape(rows), [
        { kind: 'arrived', ts: 1_000, count: 2, label: 'arrivals' },
        { kind: 'waiting', ts: 2 * MINUTE, count: 1, label: 'wait' },
        { kind: 'completed', ts: 3 * MINUTE + 1_000, count: 1, label: 'completed turn' },
    ]);
});

test('folds and labels new event kinds without a closed kind list', () => {
    for (const [kind, label] of [['pr', 'PRs'], ['issue', 'issues'], ['release', 'releases']]) {
        const rows = foldTimeline([
            event(5_000, kind),
            event(20_000, kind),
        ]);
        assert.deepEqual(shape(rows), [{ kind, ts: 5_000, count: 2, label }]);
    }
});

test('returns an empty array for empty input', () => {
    assert.deepEqual(foldTimeline([]), []);
    assert.deepEqual(foldTimeline(null), []);
});
