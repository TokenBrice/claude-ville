import test from 'node:test';
import assert from 'node:assert/strict';

import {
    CREST_GUARD_AFTER_SEC,
    CREST_GUARD_SEC,
    SWELL_PERIODS_SEC,
    YIELD_SLACK_SEC,
    audioTimeForMonotonic,
    balanceGains,
    coastLane,
    crestClear,
    harborLane,
    guardWindow,
    seaParams,
    seaState,
    swellSets,
} from '../../claudeville/src/presentation/shared/audio/layers/SeaLayer.js';
import {
    BUILDING_WORLD,
    OPEN_LOWPASS_HZ,
    placeCoastFromCamera,
    placeFromCamera,
} from '../../claudeville/src/presentation/shared/audio/SpatialField.js';

test('the sets swing between small and big waves and never repeat within an hour', () => {
    let lo = Infinity;
    let hi = -Infinity;
    for (let t = 0; t < 3600; t += 0.5) {
        const s = swellSets(t, 0.3, 1.7);
        lo = Math.min(lo, s);
        hi = Math.max(hi, s);
    }
    assert.ok(lo >= 0.28 - 1e-9 && lo < 0.35, `smallest sets ${lo}`);
    assert.ok(hi <= 1.16 + 1e-9 && hi > 1.1, `biggest sets ${hi}`);
    // Neither cycle's period (nor a short common multiple) brings the pair back.
    for (const lag of [...SWELL_PERIODS_SEC, 4, 12.5]) {
        let worst = 0;
        for (let t = 0; t < 600; t += 1) worst = Math.max(worst, Math.abs(swellSets(t + lag) - swellSets(t)));
        assert.ok(worst > 0.1, `the sets repeat after ${lag} s`);
    }
});

test('the sea state follows wind and storm, never cloud or rain alone', () => {
    const calm = seaState({ wind: 0.3 });
    assert.equal(seaState({ wind: 0.1 }), calm);
    assert.equal(seaState({ wind: 0.4 }), calm);
    assert.ok(seaState({ wind: 0.6 }) > calm);
    assert.ok(seaState({ wind: 1.2 }) > seaState({ wind: 0.8 }));
    assert.equal(seaState({ wind: -1.2 }), seaState({ wind: 1.2 }), '|windX|');
    assert.equal(seaState({ wind: 0.3, storm: 0.9 }), 0.9);
    // Precipitation is not an input to the state.
    assert.equal(seaParams({ wind: 0.3, precipitation: 0.6 }).state, calm);
});

test('a rougher sea breaks bigger and more often; gulls roost at night, in storms and in rain', () => {
    const calm = seaParams({ wind: 0.3 }, 'day');
    const storm = seaParams({ wind: 1.2, precipitation: 0.9, storm: 0.9 }, 'day');
    assert.ok(storm.periodSec < calm.periodSec);
    assert.ok(storm.size > calm.size && storm.roar > calm.roar);
    // About five breaks a minute on a calm day, 7–10 in a storm.
    assert.ok(Math.abs(60 / calm.periodSec - 5.2) < 0.5, `${60 / calm.periodSec}/min`);
    assert.ok(60 / storm.periodSec >= 7 && 60 / storm.periodSec <= 10, `${60 / storm.periodSec}/min`);
    assert.ok(calm.gullsPerMin > 0);
    assert.equal(seaParams({ wind: 0.3 }, 'night').gullsPerMin, 0);
    assert.equal(storm.gullsPerMin, 0);
    assert.equal(seaParams({ wind: 0.3, precipitation: 0.5 }, 'day').gullsPerMin, 0);
    // Night darkens and thins the foam; it is never brighter than day.
    const night = seaParams({ wind: 0.3 }, 'night');
    assert.ok(night.dark < calm.dark && night.foam < calm.foam);
    assert.equal(night.level, calm.level, 'phase never changes the sea level (the day arc does)');
});

test('a crest yields out of a cue window: 1.5 s before its first note, 2.5 s after its last', () => {
    const g = guardWindow([10, 10.22]);
    assert.deepEqual(g, { from: 10 - CREST_GUARD_SEC, to: 10.22 + CREST_GUARD_AFTER_SEC });
    assert.equal(guardWindow([]), null);
    assert.equal(guardWindow([Number.NaN]), null);

    assert.equal(crestClear(8, [g]), 8, 'clear of the window stays put');
    assert.equal(crestClear(g.from, [g]), g.from, 'the edge is allowed');
    assert.equal(crestClear(10.1, [g]), g.to + YIELD_SLACK_SEC);
    assert.equal(crestClear(9, [g]), g.to + YIELD_SLACK_SEC, 'a crest just before the cue moves after it, never earlier');
});

test('a crest pushed out of one window into another keeps moving until it is clear of both', () => {
    const a = guardWindow([10]);
    const b = guardWindow([13.5]);
    const t = crestClear(10.5, [b, a]);
    assert.ok(t >= b.to, `landed at ${t}`);
    for (const w of [a, b]) assert.ok(!(t > w.from && t < w.to));
    assert.equal(crestClear(20, [a, b]), 20);
});

test('a published note time maps back to the audio time it was scheduled at', () => {
    const ctx = { currentTime: 42 };
    assert.equal(audioTimeForMonotonic(10_500, ctx, 10_000), 42.5);
    assert.equal(audioTimeForMonotonic(9_000, ctx, 10_000), 41);
    // With an output timestamp, the pairing CueKit published with is used.
    const stamped = { currentTime: 42, getOutputTimestamp: () => ({ contextTime: 41.9, performanceTime: 9_950 }) };
    assert.ok(Math.abs(audioTimeForMonotonic(10_950, stamped, 10_000) - 42.9) < 1e-9);
});

test('lane balance is equal power and centred at unity', () => {
    assert.deepEqual(balanceGains(0).map(v => Number(v.toFixed(12))), [1, 1]);
    for (const pan of [-1, -0.6, 0.33, 0.8, 1]) {
        const [l, r] = balanceGains(pan);
        assert.ok(Math.abs(l * l + r * r - 2) < 1e-12);
        assert.ok(pan > 0 ? r > l : l > r);
    }
    assert.deepEqual(balanceGains(3), balanceGains(1));
});

test('the camera brings the harbor close and loud, and never loses it or the coast across the island', () => {
    const home = harborLane(null);
    assert.deepEqual(home, { pan: 0.33, lowpassHz: OPEN_LOWPASS_HZ, level: 1, send: 0.22 });
    const onTheJetty = harborLane(placeFromCamera('harbor', { x: 800 - BUILDING_WORLD.harbor.x, y: 450 - BUILDING_WORLD.harbor.y, zoom: 1, viewportW: 1600, viewportH: 900 }));
    assert.ok(onTheJetty.level > home.level && onTheJetty.level <= Math.pow(10, 2 / 20) + 1e-9, `on the jetty ${onTheJetty.level}`);
    assert.equal(onTheJetty.pan, 0);
    let previous = Infinity;
    for (const gain of [1, 0.8, 0.6, 0.4, 0.2, 0.12]) {
        const lane = harborLane({ pan: 0.5, lowpassHz: 4000, gain, air: 0.3 });
        assert.ok(lane.level <= previous);
        assert.ok(lane.level >= Math.pow(10, -7 / 20) - 1e-3, `farthest harbor ${lane.level}`);
        assert.ok(lane.send >= home.send);
        previous = lane.level;
    }
    assert.deepEqual(coastLane(null), { pan: 0, lowpassHz: OPEN_LOWPASS_HZ, level: 1 });
    const inland = coastLane(placeCoastFromCamera({ x: 800 / 3, y: 450 / 3 - 624, zoom: 3, viewportW: 1600, viewportH: 900 }));
    assert.ok(inland.level >= 0.5 && inland.level < 1 && inland.lowpassHz >= 2000);
});
