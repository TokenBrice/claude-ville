import test from 'node:test';
import assert from 'node:assert/strict';

import {
    WORK_LIMITS, downbeatSync, judgeCameraPan, judgeFocus, judgeHeard, judgeQuietMix, judgeQuotaSweep, judgeWorkLevel, longestGap,
    maxOnsetsIn, pulseIndex, quietStemRow, signCrossing, stopTiming, targetTrajectory,
} from '../audio/lib/checks.mjs';

test('the longest gap is measured only between strikes inside the window', () => {
    const j = longestGap([10, 12, 12.5, 16, 30], { from: 10, to: 20 });
    assert.equal(j.maxGapSec, 3.5);
    assert.equal(j.at, 12.5);
    assert.equal(j.n, 4);
    assert.equal(longestGap([5], {}).maxGapSec, null);
});

test('a building stops within a second before its agents and never a period after', () => {
    const P = 0.46;
    assert.equal(stopTiming([40, 45.6], 46, P).pass, true);
    // Silent more than 1 s before the turn ended: a false stall.
    assert.equal(stopTiming([40, 44.8], 46, P).pass, false);
    // A strike after stop + P_b is work that stopped still sounding.
    const late = stopTiming([45.6, 46.3, 46.5], 46, P);
    assert.equal(late.late, 1);
    assert.equal(late.pass, false);
    // A strike inside one period after the stop is the booked horizon.
    assert.equal(stopTiming([45.6, 46.4], 46, P).pass, true);
    assert.equal(stopTiming([], 46, P).pass, false);
});

test('downbeat sync pairs each strike with its nearest drawn downbeat', () => {
    const drawn = [1000, 2380, 3760, 5140];
    const j = downbeatSync([1004, 2390, 3740], drawn);
    assert.deepEqual([j.n, j.unmatched, j.medianAbsMs, j.p95AbsMs], [3, 0, 10, 20]);
    assert.equal(j.covered, 2);
    assert.equal(j.pass, true);
    // An accent off every drawn beat fails however good the others are.
    assert.equal(downbeatSync([1000, 2380, 4500], drawn).unmatched, 1);
    assert.equal(downbeatSync([1000, 2380, 4500], drawn).pass, false);
    // p95 over its limit.
    assert.equal(downbeatSync([1000, 2380, 3795], drawn).pass, false);
    assert.equal(downbeatSync([], drawn).pass, false);
});

test('the pulse index is 1 when onsets spread over the poll and high when they lock to it', () => {
    const flat = Array.from({ length: 80 }, (_, i) => 0.4 + i * 0.25 + 0.1);
    assert.equal(pulseIndex(flat, { pollPhaseSec: 0.4 }).index, 1);
    // Every onset 0.3 s after a poll: all in one bin → index = bins.
    const locked = Array.from({ length: 20 }, (_, i) => 0.4 + 2 * i + 0.3);
    const j = pulseIndex(locked, { pollPhaseSec: 0.4 });
    assert.equal(j.index, WORK_LIMITS.pulseBins);
    assert.equal(j.histogram[1], 20);
    assert.equal(pulseIndex([], {}).index, null);
});

test('onsets in any 1 s window: coincident strikes count once, the window is half-open', () => {
    assert.equal(maxOnsetsIn([0, 0.3, 0.6, 1.0, 1.4]), 3);
    assert.equal(maxOnsetsIn([0, 0.3, 0.6, 0.9]), 4);
    assert.equal(maxOnsetsIn([0, 0.0004, 0.5]), 2);
    assert.equal(maxOnsetsIn([]), 0);
});

test('work level passes only with the bed under the program, a small program rise and TP headroom', () => {
    const ok = { workLufs: -48, programLufs: -34, envProgramLufs: -34.3, workTpDbtp: -43.3, urgentTpDbtp: [-40, -41.3, -38] };
    const j = judgeWorkLevel(ok);
    assert.equal(j.pass, true);
    assert.equal(Math.round(j.tpMarginDb * 10) / 10, 2);
    assert.equal(judgeWorkLevel({ ...ok, workLufs: -41 }).pass, false);
    assert.equal(judgeWorkLevel({ ...ok, envProgramLufs: -34.6 }).pass, false);
    // Judged against the quietest urgent voice, not the loudest.
    assert.equal(judgeWorkLevel({ ...ok, urgentTpDbtp: [-38, -44] }).pass, false);
    assert.equal(judgeWorkLevel({ ...ok, urgentTpDbtp: [] }).pass, false);
});

test('every staffed building must be heard at its share, on at least 20 accents', () => {
    const j = judgeHeard({ forge: { n: 20, heard: 16 }, archive: { n: 20, heard: 15 } }, ['forge', 'archive', 'harbor']);
    assert.deepEqual(j.rows.map(r => r.pass), [true, false, false]);
    assert.equal(j.failing.length, 2);
    assert.equal(j.pass, false);
    // 3 of 4 heard is no evidence either way.
    const few = judgeHeard({ portal: { n: 4, heard: 4 } }, ['portal']);
    assert.equal(few.rows[0].enough, false);
    assert.equal(few.pass, false);
});

test('focus is +4 ± 0.5 dB on the selected agent and leaves the others alone', () => {
    assert.equal(judgeFocus({ focusDb: [4.2, 3.9, 4.1], otherDb: [0, 0.1] }).pass, true);
    assert.equal(judgeFocus({ focusDb: [3], otherDb: [] }).pass, false);
    assert.equal(judgeFocus({ focusDb: [4], otherDb: [2] }).pass, false);
    assert.equal(judgeFocus({ focusDb: [] }).pass, false);
});

test('a quiet-mix stem is judged on its blur level and on how fast focus restores it', () => {
    const curve = [];
    for (let t = 0; t < 30; t += 0.1) curve.push([t, t >= 10 && t < 20.4 ? -6 : 0]);
    const row = quietStemRow(curve, { blurSec: 10, focusSec: 20 });
    assert.equal(row.levelDb, -6);
    assert.ok(Math.abs(row.restoreLagSec - 0.4) < 1e-6);
    const j = judgeQuietMix({
        world: { ...row, want: WORK_LIMITS.quietWorldDb },
        music: { levelDb: -80, restoreLagSec: 0.2, want: -Infinity },
        held: { levelDb: 0.1, want: 0, tolDb: WORK_LIMITS.heldTolDb, restore: false },
    });
    assert.equal(j.pass, true);
    const slow = judgeQuietMix({ world: { levelDb: -6, restoreLagSec: 1.4, want: WORK_LIMITS.quietWorldDb } });
    assert.equal(slow.pass, false);
    const loudMusic = judgeQuietMix({ music: { levelDb: -20, restoreLagSec: 0.2, want: -Infinity } });
    assert.equal(loudMusic.pass, false);
});

test('the quota sweep rises monotonically by 10 dB from the first ratio to the last', () => {
    const steps = [0.7, 0.8, 0.9, 1].map((ratio, i) => ({ ratio, levelDb: -70 + 4 * i }));
    assert.equal(judgeQuotaSweep(steps).pass, true);
    assert.equal(judgeQuotaSweep(steps.map((s, i) => (i === 2 ? { ...s, levelDb: -67 } : s))).drops.length, 1);
    assert.equal(judgeQuotaSweep(steps.map(s => ({ ...s, levelDb: s.levelDb / 2 }))).pass, false);
    // A missing step is not skipped.
    assert.equal(judgeQuotaSweep([...steps, { ratio: 1.1, levelDb: null }]).pass, false);
    // Silent at the first ratio is a measured silence: the rise is unbounded.
    assert.equal(judgeQuotaSweep([{ ratio: 0.7, levelDb: -Infinity }, ...steps.slice(1)]).pass, true);
    assert.equal(judgeQuotaSweep([...steps.slice(0, 3), { ratio: 1, levelDb: -Infinity }]).drops.length, 1);
});

test('a setTargetAtTime trajectory is rebuilt from its writes and its zero crossing found', () => {
    const f = targetTrajectory([{ at: 1, value: -0.5, tc: 0.25 }, { at: 2, value: 0.5, tc: 0.25 }], 0.3);
    assert.equal(f(0.5), 0.3);
    assert.ok(Math.abs(f(1.25) - (-0.5 + 0.8 * Math.exp(-1))) < 1e-9);
    const atTwo = -0.5 + 0.8 * Math.exp(-4);
    assert.ok(Math.abs(f(2) - atTwo) < 1e-9);
    // From ≈ −0.49 toward +0.5 with τ 0.25 s: through 0 at 2 + τ·ln(0.99/0.5).
    const cross = signCrossing(f, 1.5, 3);
    assert.ok(Math.abs(cross - (2 + 0.25 * Math.log((0.5 - atTwo) / 0.5))) < 1e-4);
    assert.equal(signCrossing(() => 1, 0, 1), null);
});

test('camera pan passes on a prompt crossing, bounded steps and a still camera writing nothing', () => {
    const base = { cameraCrossSec: 10, heardCrossSec: 10.35, targets: [0.4, 0.25, 0.1, -0.05, -0.2], stillWrites: 0 };
    assert.equal(judgeCameraPan(base).pass, true);
    assert.equal(judgeCameraPan({ ...base, heardCrossSec: 10.7 }).pass, false);
    assert.equal(judgeCameraPan({ ...base, targets: [0.4, 0.1] }).pass, false);
    assert.equal(judgeCameraPan({ ...base, stillWrites: 1 }).pass, false);
    assert.equal(judgeCameraPan({ ...base, heardCrossSec: null }).pass, false);
});
