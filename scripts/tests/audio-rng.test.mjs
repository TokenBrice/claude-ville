import test from 'node:test';
import assert from 'node:assert/strict';

import {
    daySeed,
    rngSeed,
    rngStream,
    setRngOverride,
    setRngSeed,
} from '../../claudeville/src/presentation/shared/audio/Rng.js';

function draws(next, n) {
    return Array.from({ length: n }, () => next());
}

test.afterEach(() => {
    setRngSeed(null);
    setRngOverride(null);
});

test('one seed and one name replay the same sequence, in [0, 1)', () => {
    setRngSeed(20260926);
    const first = draws(rngStream('RainLayer'), 2000);
    const again = draws(rngStream('RainLayer'), 2000);
    assert.deepEqual(first, again);
    assert.ok(first.every((x) => x >= 0 && x < 1));
    assert.ok(new Set(first).size > 1990, 'the stream does not cycle early');
});

test('streams are independent: work draws never move the weather', () => {
    setRngSeed('fixture');
    const quiet = draws(rngStream('RainLayer'), 500);

    const rain = rngStream('RainLayer');
    const work = rngStream('VillageHumLayer');
    const busy = [];
    for (let i = 0; i < 500; i++) {
        // Twelve agents' worth of work draws between every weather draw.
        for (let k = 0; k < 12; k++) work();
        busy.push(rain());
    }
    assert.deepEqual(busy, quiet);

    const other = draws(rngStream('BirdsLayer'), 500);
    const same = quiet.filter((x, i) => x === other[i]).length;
    assert.ok(same < 5, 'two names do not share a sequence');
});

test('the seed picks the day; neighbouring seeds differ', () => {
    assert.equal(daySeed(new Date(2026, 8, 26, 23, 59)), 20260926);
    assert.equal(daySeed(new Date(2026, 8, 27, 0, 1)), 20260927);
    setRngSeed(null);
    assert.equal(rngSeed(), String(daySeed()));

    setRngSeed(20260926);
    const today = draws(rngStream('BirdsLayer'), 50);
    setRngSeed(20260927);
    const tomorrow = draws(rngStream('BirdsLayer'), 50);
    assert.notDeepEqual(today, tomorrow);
});

test('the probe override pins existing and new streams until cleared', () => {
    setRngSeed(1);
    const existing = rngStream('CricketsLayer');
    const reference = draws(rngStream('CricketsLayer'), 3);
    setRngOverride(() => 0.5);
    assert.deepEqual(draws(existing, 3), [0.5, 0.5, 0.5]);
    assert.deepEqual(draws(rngStream('music.village.choice'), 2), [0.5, 0.5]);
    setRngOverride(null);
    // The override draws never advanced the stream's own state.
    assert.deepEqual(draws(existing, 3), reference);
});
