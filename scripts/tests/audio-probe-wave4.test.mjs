import test from 'node:test';
import assert from 'node:assert/strict';

import {
    bakeLandingDiffs, crestRate, grainReuse, groanViolations, judgeOnsetBudget, judgeThunder, judgeWorldCell, judgeWorldMap, judgeWorldStem, nearestCrest,
    nightWeatherOverDay, presenceUnderNoon, thunderDelaySec, worldSceneRow, worldStemDiffers,
} from '../audio/lib/checks.mjs';

const TARGETS = {
    rain: { maxOverA: 5 },
    storm: { maxOverA: 6, stMax: -27, thunderNearFrom: 0.7 },
    resting: { overA: -10, toleranceLu: 3, lufsSFloor: -55 },
    night: { maxOverA: 0, presenceUnderNoonDb: 4 },
    dayArc: { overA: 0, toleranceLu: 2, withinShare: 0.9 },
};
const A = -38;
const cell = (phase, weather, load, lufsI, extra = {}) => ({ phase, weather, load, lufsI, stMax: lufsI + 2, stMean: lufsI, stMin: lufsI - 2, ...extra });

test('each world scene takes its S2 row: resting for any weather, rain, storm, else the day arc', () => {
    assert.equal(worldSceneRow({ weather: 'storm', load: 'resting' }), 'resting');
    assert.equal(worldSceneRow({ weather: 'rain', load: 'w3' }), 'rain');
    assert.equal(worldSceneRow({ weather: 'storm', load: 'w12' }), 'storm');
    assert.equal(worldSceneRow({ weather: 'fog', load: 'w3' }), 'dayArc');
    // Resting is judged on its short-term mean and floor, not LUFS-I.
    assert.equal(judgeWorldCell(cell('day', 'storm', 'resting', -47), A, TARGETS).pass, true);
    assert.equal(judgeWorldCell(cell('day', 'clear', 'resting', -47, { stMin: -56 }), A, TARGETS).pass, false);
    assert.equal(judgeWorldCell(cell('dusk', 'rain', 'w3', -33.1), A, TARGETS).pass, true);
    assert.equal(judgeWorldCell(cell('dusk', 'rain', 'w3', -32.9), A, TARGETS).pass, false);
    // Storm: level and its short-term ceiling (thunder included).
    assert.equal(judgeWorldCell(cell('day', 'storm', 'w3', -32.5, { stMax: -27.2 }), A, TARGETS).pass, true);
    assert.equal(judgeWorldCell(cell('day', 'storm', 'w3', -32.5, { stMax: -26.8 }), A, TARGETS).pass, false);
});

test('night is never over A, while a loud dry day only costs the day arc its share', () => {
    const night = judgeWorldCell(cell('night', 'clear', 'w3', -37.5), A, TARGETS);
    assert.equal(night.inArc, true);
    assert.equal(night.pass, false);
    const loudDay = judgeWorldCell(cell('day', 'overcast', 'w3', -35.5), A, TARGETS);
    assert.equal(loudDay.inArc, false);
    assert.equal(loudDay.pass, true);
    // A missing Loudness.js row fails rather than passing unjudged.
    assert.equal(judgeWorldCell(cell('day', 'clear', 'w3', -38), A, { ...TARGETS, dayArc: undefined }).pass, false);
});

test('the day arc passes at its share of cells inside A ± tolerance', () => {
    const arc = Array.from({ length: 10 }, (_, i) => cell('day', 'clear', `w${i}`, i === 0 ? -35 : -38));
    assert.equal(judgeWorldMap(arc, A, TARGETS).arc.share, 0.9);
    assert.equal(judgeWorldMap(arc, A, TARGETS).pass, true);
    const two = arc.map((c, i) => (i === 1 ? { ...c, lufsI: -41 } : c));
    const j = judgeWorldMap(two, A, TARGETS);
    assert.equal(j.arc.within, 8);
    assert.equal(j.pass, false);
    // A hard row failing fails the map whatever the share.
    assert.equal(judgeWorldMap([...arc, cell('day', 'rain', 'w3', -31)], A, TARGETS).failures.length, 1);
});

test('must-never 7 compares every cell with the clear day at the same load', () => {
    const cells = [
        cell('day', 'clear', 'w3', -38), cell('night', 'clear', 'w3', -39), cell('day', 'storm', 'w3', -32.1),
        cell('day', 'clear', 'resting', -48), cell('day', 'storm', 'resting', -41.5),
    ];
    const j = nightWeatherOverDay(cells);
    assert.equal(j.worst.load, 'resting');
    assert.ok(Math.abs(j.worst.overDay - 6.5) < 1e-9);
    assert.equal(j.pass, false);
    assert.equal(nightWeatherOverDay(cells.slice(0, 3)).pass, true);
});

test('night 2–5 kHz must sit the S2 distance under noon; onsets keep the S7 budget', () => {
    assert.deepEqual(presenceUnderNoon(-64, -60, { minDb: 4 }), { underDb: 4, minDb: 4, pass: true });
    assert.equal(presenceUnderNoon(-61, -60, { minDb: 4 }).pass, false);
    assert.equal(presenceUnderNoon(null, -60).pass, false);
    const ok = judgeOnsetBudget([{ onsetsPerMin: 120 }, { onsetsPerMin: 180 }]);
    assert.equal(ok.pass, true);
    assert.equal(ok.worst.onsetsPerMin, 180);
    assert.equal(judgeOnsetBudget([{ onsetsPerMin: 120 }, { onsetsPerMin: 181 }]).pass, false);
    assert.equal(judgeOnsetBudget([{ onsetsPerMin: 120 }, { onsetsPerMin: null }]).pass, false);
});

test('S6: the world stem is the same stem when identical within renderer noise', () => {
    assert.deepEqual(judgeWorldStem(0), { identical: true, pass: true, max: 1e-6, limit: 1e-6 });
    assert.equal(judgeWorldStem(8e-7).pass, true);
    assert.equal(judgeWorldStem(2e-6).pass, false);
    // A same-count repeat that itself differs raises the bar to its noise, never lowers it.
    assert.equal(judgeWorldStem(2e-6, { noise: 5e-4 }).pass, true);
    assert.equal(judgeWorldStem(2e-6, { noise: 1e-9 }).pass, false);
    assert.equal(judgeWorldStem(Infinity).pass, false);
    assert.equal(judgeWorldStem(null).pass, false);
    const cells = [{ phase: 'day', weather: 'clear', load: 'w3' }, { phase: 'day', weather: 'clear', load: 'w12', worldMaxAbs: 3e-9 }, { phase: 'day', weather: 'fog', load: 'w12', worldMaxAbs: 4e-3 }];
    const j = worldStemDiffers(cells);
    assert.deepEqual(j.differing.map(d => d.weather), ['fog']);
    assert.equal(j.pass, false);
});

test('bakes that land at different audio times in two renders are named', () => {
    const a = [{ key: 'air:day', t: 0.2 }, { key: 'sea:gull:0', t: 3.1 }, { key: 'sea:gull:0', t: 9.0 }];
    const b = [{ key: 'air:day', t: 0.2005 }, { key: 'sea:gull:0', t: 3.1 }, { key: 'sea:gull:0', t: 9.4 }, { key: 'noise:brown:2', t: 1 }];
    assert.deepEqual(bakeLandingDiffs(a, b), [{ key: 'sea:gull:0', a: 9.0, b: 9.4 }, { key: 'noise:brown:2', a: null, b: 1 }]);
    assert.deepEqual(bakeLandingDiffs(a, a), []);
});

test('breaking waves per minute, the nearest crest and groans off 500–700 Hz', () => {
    const crests = [{ t: 5, lane: 0 }, { t: 17, lane: 1 }, { t: 29, lane: 2, moved: true }, { t: 70, lane: 0 }];
    assert.equal(crestRate(crests, 0, 60), 3);
    assert.equal(crestRate(crests, 10, 10), null);
    assert.deepEqual(nearestCrest(crests, 27.5), { t: 29, lane: 2, gapSec: 1.5, moved: true });
    assert.equal(nearestCrest([], 3), null);
    const rare = [{ kind: 'groan', t: 3, hz: [300, 820] }, { kind: 'groan', t: 9, hz: [450, 610] }, { kind: 'clink', t: 4, hz: [600] }];
    assert.deepEqual(groanViolations(rare), [{ t: 9, hz: 610 }]);
});

const WINDOWS = { near: { min: 5, max: 10 }, far: { min: 2, max: 6 }, nearAt: 0.7 };
const strike = (intensity, margin, extra = {}) => ({ intensity, margin, delaySec: thunderDelaySec(intensity), grDb: 2, grains: [{ buf: 1, off: intensity * 20 }], ...extra });

test('thunder: near and far windows from the onset, the flash delay and the GR limit', () => {
    assert.ok(Math.abs(thunderDelaySec(1) - 0.4) < 1e-9);
    assert.ok(Math.abs(thunderDelaySec(0.5) - 2.65) < 1e-9);
    const j = judgeThunder([strike(0.3, 2.5), strike(0.7, 5.5), strike(1, 8)], { windows: WINDOWS, grMaxDb: 6 });
    assert.equal(j.pass, true);
    assert.deepEqual(j.rows.map(r => r.near), [false, true, true]);
    // 0.6 is far: +6.5 is over its window even though a near strike could take it.
    assert.equal(judgeThunder([strike(0.6, 6.5)], { windows: WINDOWS, grMaxDb: 6 }).pass, false);
    assert.equal(judgeThunder([strike(0.9, 7, { delaySec: 1.2 })], { windows: WINDOWS, grMaxDb: 6 }).rows[0].pass, false);
    assert.equal(judgeThunder([strike(0.9, 7, { grDb: 6.5 })], { windows: WINDOWS, grMaxDb: 6 }).pass, false);
    assert.equal(judgeThunder([strike(0.9, null)], { windows: WINDOWS, grMaxDb: 6 }).pass, false);
});

test('thunder level is monotonic in intensity, and every strike reads a fresh grain', () => {
    const louderForLess = judgeThunder([strike(0.8, 9), strike(1, 7.9)], { windows: WINDOWS, grMaxDb: 6 });
    assert.equal(louderForLess.monotonic, false);
    assert.deepEqual(louderForLess.drops.map(d => [d.from, d.to]), [[0.8, 1]]);
    // Within the tolerance a step down is noise, not a reversal.
    assert.equal(judgeThunder([strike(0.8, 8), strike(1, 7.6)], { windows: WINDOWS, grMaxDb: 6 }).monotonic, true);
    // Reads are spans of buffer time: a gap under 5 s (or an overlap) reuses noise.
    const same = [
        { grains: [{ buf: 2, off: 10, end: 16 }] }, { grains: [{ buf: 2, off: 19, end: 25 }] },
        { grains: [{ buf: 2, off: 30.5, end: 36 }] }, { grains: [{ buf: 3, off: 10, end: 16 }] },
    ];
    assert.deepEqual(grainReuse(same), [{ a: 0, b: 1, buf: 2, gapSec: 3 }]);
    assert.deepEqual(grainReuse([{ grains: [{ buf: 1, off: 0, end: 8 }] }, { grains: [{ buf: 1, off: 4, end: 12 }] }]), [{ a: 0, b: 1, buf: 1, gapSec: -4 }]);
    // Only the last two strikes count: the third after may read the same noise again.
    const cycle = [0, 20, 40, 1].map(off => ({ grains: [{ buf: 1, off, end: off + 8 }] }));
    assert.deepEqual(grainReuse(cycle), []);
    assert.equal(grainReuse(cycle, { recent: 3 }).length, 1);
});
