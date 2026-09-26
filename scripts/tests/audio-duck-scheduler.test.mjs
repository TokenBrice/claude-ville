import test from 'node:test';
import assert from 'node:assert/strict';

import {
    DUCK_FLOOR_DB,
    DuckScheduler,
    dbToGain,
} from '../../claudeville/src/presentation/shared/audio/DuckScheduler.js';

const near = (actual, expected, tol = 1e-6, label = '') => {
    assert.ok(Math.abs(actual - expected) <= tol, `${label} ${actual} ≠ ${expected} ±${tol}`);
};
const db = gain => 20 * Math.log10(gain);

// Replays curve(now) the way the engine does: hold at `now` with `held`,
// then linear ramps between the vertices. Returns the gain at `t`.
function replay(held, now, points, t) {
    let prev = { t: now, gain: held };
    for (const p of points) {
        if (t <= p.t) return prev.gain + (p.gain - prev.gain) * (t - prev.t) / (p.t - prev.t);
        prev = p;
    }
    return prev.gain;
}

test('a window ramps in over the attack before the first note and releases after the hold', () => {
    const s = new DuckScheduler();
    s.add({ from: 10, until: 12, depthDb: -6, attack: 0.04, release: 0.6 });
    const g = dbToGain(-6);
    assert.equal(s.valueAt(9.95), 1, 'flat before from − attack');
    near(s.valueAt(9.98), (1 + g) / 2, 1e-9, 'half-way through the attack');
    near(s.valueAt(10), g, 1e-12, 'full depth on the first note');
    near(s.valueAt(12), g, 1e-12, 'held to until');
    near(s.valueAt(12.3), (1 + g) / 2, 1e-9, 'half-way through the release');
    assert.equal(s.valueAt(12.6), 1, 'back to unity after the release');

    const points = s.curve(0);
    assert.deepEqual(points.map(p => p.t), [9.96, 10, 12, 12.6]);
    near(points[0].gain, 1, 0, 'the envelope leaves unity exactly at from − attack');
    assert.equal(points.at(-1).gain, 1, 'the curve always ends at unity');
});

test('overlapping windows: the deepest wins, per time', () => {
    const s = new DuckScheduler();
    s.add({ from: 1, until: 3, depthDb: -2 });
    s.add({ from: 2, until: 2.5, depthDb: -7 });
    near(db(s.valueAt(1.5)), -2, 1e-9);
    near(db(s.valueAt(2.2)), -7, 1e-9);
    // Part-way through the deep window's release, the shallow hold is deeper again.
    near(db(s.valueAt(2.95)), -2, 1e-9);
    // At 3.05 both release; the shallow window's release is still the lower line.
    near(s.valueAt(3.05), dbToGain(-2) + (1 - dbToGain(-2)) * 0.05 / 0.6, 1e-9);
    assert.ok(s.valueAt(3.3) > dbToGain(-2) && s.valueAt(3.3) < 1);
    assert.equal(s.valueAt(3.6), 1);
});

test('the replayed curve equals the deepest-wins envelope, crossings included', () => {
    const s = new DuckScheduler();
    // A release that crosses the next window's attack.
    s.add({ from: 1, until: 1.2, depthDb: -9, release: 0.6 });
    s.add({ from: 1.5, until: 2, depthDb: -3, attack: 0.3 });
    const now = 0.5;
    const points = s.curve(now);
    for (let t = now; t <= 3; t += 0.0017) {
        near(replay(1, now, points, t), s.valueAt(t), 1e-9, `t=${t.toFixed(4)}`);
    }
});

test('no window ducks deeper than the floor, even stacked', () => {
    const s = new DuckScheduler();
    s.add({ from: 0, until: 1, depthDb: -20 });
    s.add({ from: 0, until: 1, depthDb: -12 });
    near(db(s.valueAt(0.5)), DUCK_FLOOR_DB, 1e-9);
    assert.equal(DUCK_FLOOR_DB, -9);
});

test('a window that ducks nothing is not scheduled', () => {
    const s = new DuckScheduler();
    assert.equal(s.add({ from: 1, until: 2, depthDb: 0 }), null);
    assert.equal(s.add({ from: 1, until: 2, depthDb: 3 }), null);
    assert.equal(s.add({ from: 1, until: 2, depthDb: undefined }), null);
    assert.equal(s.size, 0);
    assert.deepEqual(s.curve(0), []);
});

test('cancelling a window removes its dip and restores the others', () => {
    const s = new DuckScheduler();
    const shallow = s.add({ from: 1, until: 4, depthDb: -2 });
    const deep = s.add({ from: 2, until: 3, depthDb: -7 });
    assert.equal(s.remove(deep), true);
    near(db(s.valueAt(2.5)), -2, 1e-9);
    assert.equal(s.remove(deep), false, 'a second cancel is a no-op');

    // A prepared cue cancelled before its window starts leaves the bed flat.
    assert.equal(s.remove(shallow), true);
    assert.deepEqual(s.curve(0), []);
    assert.equal(s.valueAt(2.5), 1);
});

test('activity and pruning follow the window corners', () => {
    const s = new DuckScheduler();
    const id = s.add({ from: 1, until: 2, depthDb: -3, attack: 0.04, release: 0.6 });
    assert.equal(s.isActive(id, 0.9), false);
    assert.equal(s.isActive(id, 0.97), true);
    assert.equal(s.isActive(id, 2.5), true);
    s.prune(2.5);
    assert.equal(s.size, 1, 'a releasing window is kept');
    s.prune(2.6);
    assert.equal(s.size, 0, 'a released window is dropped');
});

test('a window whose attack began before now starts from the envelope, not a step', () => {
    const s = new DuckScheduler();
    s.add({ from: 1.01, until: 1.5, depthDb: -6, attack: 0.04 });
    const points = s.curve(1);
    assert.deepEqual(points.map(p => p.t), [1.01, 1.5, 2.1]);
    near(points[0].gain, dbToGain(-6), 1e-12);
});
