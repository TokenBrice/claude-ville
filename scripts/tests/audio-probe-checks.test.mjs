import test from 'node:test';
import assert from 'node:assert/strict';

import {
    avSync, compareOnsets, duckedTime, frameCostDelta, judgeAirT60, judgeBank, judgeLane, judgeSceneTargets, judgeSequencer,
    judgeTransport, laneWindow, limiterGainReduction, maxGrIn, noiseLaneConflicts, onsetNear, pieceOnsets, resumeBurst,
    stageOutcome, switchHoleBump,
} from '../audio/lib/checks.mjs';

const SR = 48000;

test('ducked time unions overlapping windows per bus and counts only buses that dip', () => {
    const ducks = [
        { from: 10, until: 11, attack: 0, release: 0, depths: { world: -2, work: -3, music: 0 } },
        { from: 10.5, until: 12, attack: 0, release: 0, depths: { world: -7, work: -6, music: -9 } },
    ];
    const f = duckedTime(ducks, 0, 100);
    assert.equal(f.world, 0.02);
    assert.equal(f.work, 0.02);
    assert.equal(f.music, 0.015);
});

test('a duck cancelled before it opens adds no ducked time; one cancelled midway stops there', () => {
    const f = duckedTime([
        { from: 5, until: 6, attack: 0.04, release: 0.6, depths: { world: -2 }, cancelledAt: 4 },
        { from: 20, until: 30, attack: 0, release: 0, depths: { world: -2 }, cancelledAt: 22 },
    ], 0, 100, { buses: ['world'] });
    assert.equal(f.world, 0.02);
});

test('ducked time includes the attack before the note and the release after the window, clipped to the scene', () => {
    const f = duckedTime([{ from: 0.02, until: 1, depths: { world: -2 } }], 0, 10, { buses: ['world'] });
    // Attack (0.04 s) is clipped at the scene start; release defaults to 0.6 s.
    assert.ok(Math.abs(f.world - 0.16) < 1e-9);
});

test('every lane is held to its full S2 window per bed', () => {
    assert.deepEqual(laneWindow('needsYou', 'village'), { min: 10, max: 12 });
    assert.deepEqual(laneWindow('needsYou', 'music'), { min: 8, max: 12 });
    assert.deepEqual(laneWindow('error', 'music'), { min: 6, max: 12 });
    assert.deepEqual(laneWindow('error', 'weather'), { min: 6, max: 12 });
    assert.deepEqual(laneWindow('limit', 'weather'), { min: 4, max: 10 });
    assert.deepEqual(laneWindow('routine', 'music'), { min: 3, max: 6 });
    assert.deepEqual(laneWindow('outcomeMinor', 'village'), { min: 0, max: 3 });
    assert.deepEqual(laneWindow('outcomeMajor', 'weather'), { min: 4, max: 8 });
});

test('a lane is judged on the median placement, and an urgent lane also on the band rule and GR', () => {
    const ok = { bandsOver6dB: 3, presenceRiseDb: 9, grDb: 1 };
    const pass = judgeLane('needsYou', 'village', [{ ...ok, margin: 9 }, { ...ok, margin: 11 }, { ...ok, margin: 12 }]);
    assert.equal(pass.margin, 11);
    assert.equal(pass.pass, true);
    // +9 passed Wave 1's interim floor; the full Village floor is +10.
    assert.equal(judgeLane('needsYou', 'village', [{ ...ok, margin: 9 }]).pass, false);
    const gr = judgeLane('needsYou', 'village', [{ ...ok, margin: 11 }, { ...ok, margin: 11, grDb: 3.5 }, { ...ok, margin: 11 }]);
    assert.equal(gr.pass, false);
    assert.match(gr.failures.map(f => f.what).join(), /GR/);
    const band = judgeLane('needsYou', 'music', [{ ...ok, margin: 9, presenceRiseDb: 4 }]);
    assert.equal(band.pass, false);
    // Routine ignores the band rule and the GR limit but not its ceiling.
    const loud = judgeLane('routine', 'village', [{ margin: 7, bandsOver6dB: 0, grDb: 9 }]);
    assert.deepEqual(loud.failures.map(f => f.what), ['margin > 6']);
    assert.equal(judgeLane('scenery', 'village', [{ margin: null }]).pass, false);
});

test('a criterion owned by a later wave defers at an earlier stage and gates once the stage reaches it', () => {
    assert.equal(stageOutcome([]), 'PASS');
    assert.equal(stageOutcome([{ what: 'band', gatedFrom: 3 }], 1), 'DEFER');
    assert.equal(stageOutcome([{ what: 'band', gatedFrom: 3 }], 3), 'FAIL');
    // A failure gated now outweighs any deferred one.
    assert.equal(stageOutcome([{ what: 'band', gatedFrom: 3 }, { what: 'GR', gatedFrom: 0 }], 1), 'FAIL');
    // The error and limit band rule and ceilings gate from Wave 3 on.
    const limit = judgeLane('limit', 'music', [{ margin: 10.6, presenceRiseDb: -3, grDb: 0.5 }]);
    assert.equal(limit.outcome, 'FAIL');
    assert.deepEqual(limit.failures.map(f => f.what), ['margin > 10', 'presence rise < 6 dB']);
    // A `margin:<bed>:<lane>` row defers every criterion of that lane on
    // that bed until its wave, and only on that bed.
    const gated = { 'margin:storm:error': 5 };
    const stormError = [{ margin: 5.7, bandsOver6dB: 3, grDb: 3.4 }];
    const storm = judgeLane('error', 'weather', stormError, { probeBed: 'storm', stage: 4, gated });
    assert.equal(storm.outcome, 'DEFER');
    assert.deepEqual(storm.failures.map(f => f.gatedFrom), [5, 5]);
    assert.equal(judgeLane('error', 'weather', stormError, { probeBed: 'storm', stage: 5, gated }).outcome, 'FAIL');
    assert.equal(judgeLane('error', 'weather', stormError, { probeBed: 'rain', stage: 4, gated }).outcome, 'FAIL');
    // From Wave 4 the storm's error row and the busy village gate.
    assert.equal(judgeLane('error', 'weather', stormError, { probeBed: 'storm' }).outcome, 'FAIL');
    const busy = judgeSceneTargets({ anchor: { lufsI: -38 }, villageBusy: { lufsI: -31, lra: 4 } });
    assert.deepEqual(busy.map(r => [r.scene, r.outcome]), [['anchor', 'PASS'], ['villageBusy', 'FAIL']]);
});

test('the night program row (music included) defers to Wave 6', () => {
    const scenes = { anchor: { lufsI: -38 }, nightProgram: { lufsI: -33, presenceDb: -60 }, noonProgram: { lufsI: -34, presenceDb: -58 } };
    const [, night] = judgeSceneTargets(scenes);
    assert.equal(night.scene, 'nightProgram');
    assert.equal(night.pass, false);
    assert.equal(night.outcome, 'DEFER');
    assert.equal(judgeSceneTargets(scenes, undefined, { stage: 6 })[1].outcome, 'FAIL');
    // ≤ A + 4 (the session) and 4 dB darker than noon passes.
    assert.equal(judgeSceneTargets({ ...scenes, nightProgram: { lufsI: -34.5, presenceDb: -63 } }, undefined, { stage: 6 })[1].outcome, 'PASS');
});

test('scene targets are relative to the anchor measured in the same run', () => {
    const rows = judgeSceneTargets({
        anchor: { lufsI: -38.4 },
        villageBusy: { lufsI: -33.9, lra: 6 },
        rain: { lufsI: -33.3 },
        storm: { lufsI: -33.0, stMax: -28 },
        resting: { stMean: -48, stMin: -56 },
    });
    const by = Object.fromEntries(rows.map(r => [r.scene, r.pass]));
    assert.deepEqual(by, { anchor: true, villageBusy: true, rain: false, storm: true, resting: false });
});

test('a scene over its Loudness.js target fails, or defers while its row is gated later', () => {
    const anchor = { lufsI: -38 };
    // Rain at A + 5.7 is over S2's A + 5.
    const rain = judgeSceneTargets({ anchor, rain: { lufsI: -32.3 } });
    assert.equal(rain[1].outcome, 'FAIL');
    // Storm at A + 7.8 is over S2's A + 6.
    const storm = { lufsI: -30.2, stMax: -27.5 };
    assert.equal(judgeSceneTargets({ anchor, storm })[1].outcome, 'FAIL');
    assert.equal(judgeSceneTargets({ anchor, storm }, undefined, { stage: 4, gated: { 'scene:storm': 5 } })[1].outcome, 'DEFER');
    // Its short-term ceiling fails on its own.
    assert.equal(judgeSceneTargets({ anchor, storm: { lufsI: -33, stMax: -26.5 } })[1].outcome, 'FAIL');
    assert.equal(judgeSceneTargets({ anchor, storm: { lufsI: -33, stMax: -27.5 } })[1].outcome, 'PASS');
});

const TICK = { site: 'Transport.js:88', fired: 2400, p95Ms: 0.2, maxMs: 1.1, starts: 900 };

test('the transport passes only when its own timer is the one that placed sound', () => {
    const diag = { underruns: 0, processes: [{ name: 'music', maxAheadSec: 1.5 }, { name: 'birds', maxAheadSec: 1.2 }] };
    const harness = { site: 'harness', fired: 40, starts: 30 };
    assert.equal(judgeTransport(diag, [TICK, harness]).pass, true);
    const layerTimer = { site: 'layers/BaseLayer.js:55', fired: 300, p95Ms: 0.1, maxMs: 0.3, starts: 12 };
    const two = judgeTransport(diag, [TICK, layerTimer]);
    assert.equal(two.pass, false);
    assert.deepEqual(two.soundSites.map(s => s.site), ['Transport.js:88', 'layers/BaseLayer.js:55']);
    // A lone sound-placing timer that is not the Transport fails too.
    assert.equal(judgeTransport(diag, [{ ...TICK, starts: 0 }, layerTimer]).pass, false);
});

test('the transport holds each process to its horizon, work to 350 ms, and counts underruns and tick cost', () => {
    const ok = { underruns: 0, processes: [{ name: 'music', maxAheadSec: 1.4 }] };
    assert.equal(judgeTransport({ ...ok, underruns: 1 }, [TICK]).pass, false);
    assert.equal(judgeTransport({ underruns: 0, processes: [{ name: 'workshop', maxAheadSec: 0.5 }] }, [TICK]).pass, false);
    assert.equal(judgeTransport({ underruns: 0, processes: [{ name: 'wind', maxAheadSec: 1.6 }] }, [TICK]).pass, false);
    assert.equal(judgeTransport(ok, [{ ...TICK, p95Ms: 0.7 }]).pass, false);
    assert.equal(judgeTransport(ok, [{ ...TICK, maxMs: 2.5 }]).pass, false);
    assert.equal(judgeTransport(null, [TICK]).pass, false);
});

test('resume after a hidden stretch: nothing starts while suspended, no catch-up burst, no smear', () => {
    // Two onsets a second before hiding at 30 s; resume at 150 s.
    const steady = Array.from({ length: 60 }, (_, i) => ({ t: i * 0.5, at: i * 0.5 - 0.3, suspended: false }));
    const after = [150.2, 150.7].map(t => ({ t, at: t - 0.3, suspended: false }));
    const ok = resumeBurst([...steady, ...after], { hideT: 30, resumeT: 150 });
    assert.equal(ok.steadyPerSec, 2);
    assert.equal(ok.firstWindow, 2);
    assert.equal(ok.pass, true);
    // Catch-up: everything missed while hidden lands in the first second.
    const burst = Array.from({ length: 8 }, (_, i) => ({ t: 150 + i * 0.1, at: 150, suspended: false }));
    assert.equal(resumeBurst([...steady, ...burst], { hideT: 30, resumeT: 150 }).pass, false);
    // A start while suspended, and a note placed in the past after resume.
    assert.equal(resumeBurst([...steady, { t: 90, at: 90, suspended: true }], { hideT: 30, resumeT: 150 }).pass, false);
    assert.equal(resumeBurst([...steady, { t: 149.5, at: 150.1, suspended: false }], { hideT: 30, resumeT: 150 }).smeared, 1);
});

test('noise lanes on one pool buffer conflict when their read heads come within 5 s', () => {
    const lane = (t, off, extra = {}) => ({ t, e: null, buf: 1, len: 21.3, off, rate: 1, ...extra });
    // Same rate, offsets 8 s apart: always 8 s apart.
    assert.equal(noiseLaneConflicts([lane(0, 0), lane(0, 8)], { end: 60 }).conflicts.length, 0);
    // Started 3 s later at the same offset: 3 s behind for the whole overlap.
    const late = noiseLaneConflicts([lane(0, 0), lane(3, 0)], { end: 60 });
    assert.equal(late.conflicts.length, 1);
    assert.ok(Math.abs(late.conflicts[0].closestSec - 3) < 1e-6);
    // Distance wraps around the buffer end (0 vs 19 s is 2.3 s apart).
    assert.equal(noiseLaneConflicts([lane(0, 0), lane(0, 19)], { end: 60 }).conflicts.length, 1);
    // Lanes that never overlap in time, other buffers and short buffers do not count.
    assert.equal(noiseLaneConflicts([lane(0, 0, { e: 10 }), lane(11, 0)], { end: 60 }).conflicts.length, 0);
    assert.equal(noiseLaneConflicts([lane(0, 0), lane(0, 0, { buf: 2 })], { end: 60 }).conflicts.length, 0);
    assert.equal(noiseLaneConflicts([lane(0, 0, { len: 4 }), lane(0, 0, { len: 4 })], { end: 60 }).lanes, 0);
});

test('Island Air T60 is judged per phase and needs the 4 kHz tail shorter than 0.8 of 1 kHz', () => {
    assert.equal(judgeAirT60('day', { t60_1000: 1.1, t60_4000: 0.8 }).pass, true);
    assert.equal(judgeAirT60('night', { t60_1000: 1.1, t60_4000: 0.8 }).pass, false);
    assert.equal(judgeAirT60('night', { t60_1000: 1.55, t60_4000: 1.2 }).pass, true);
    assert.equal(judgeAirT60('day', { t60_1000: 1.1, t60_4000: 0.95 }).pass, false);
});

test('the bank fails over a client budget, over the total, or on a long slice', () => {
    const budget = { totalBytes: 100, air: 20, noise: 50 };
    assert.equal(judgeBank({ residentBytes: 60, byClient: { air: 15, noise: 45 } }, 2, budget).pass, true);
    assert.equal(judgeBank({ residentBytes: 60, byClient: { air: 25, noise: 35 } }, 2, budget).pass, false);
    assert.equal(judgeBank({ residentBytes: 120, byClient: { air: 15, noise: 45 } }, 2, budget).pass, false);
    assert.equal(judgeBank({ residentBytes: 60, byClient: { air: 15, noise: 45 } }, 6, budget).pass, false);
    assert.equal(judgeBank({ residentBytes: 10, byClient: { gulls: 10 } }, 1, budget).pass, false);
    assert.equal(judgeBank(null, 1, budget).pass, false);
});

test('piece onsets: one Village song ends at its first long gap, one Town band loop at its length', () => {
    const song = pieceOnsets([10.5, 10, 10.25, 10.25, 11, 20, 20.5]);
    assert.deepEqual(song.onsets, [0, 0.25, 0.5, 1]);
    const loop = pieceOnsets([3, 4, 5, 6, 7, 8], { loopSec: 4 });
    assert.deepEqual(loop.onsets, [0, 1, 2, 3]);
});

test('sequencer equivalence needs identical onsets and the level within 0.5 LU', () => {
    const ref = { onsets: [0, 0.5, 1, 1.5], lufsI: -40 };
    // Level drifts against the current baseline, not the Wave-1 render.
    const same = [0, 0.5, 1, 1.5];
    assert.equal(judgeSequencer(ref, { onsets: same, lufsI: -41.4 }, { baselineLufs: -41 }).pass, true);
    assert.equal(judgeSequencer(ref, { onsets: same, lufsI: -41.6 }, { baselineLufs: -41 }).pass, false);
    assert.equal(judgeSequencer(ref, { onsets: same, lufsI: -40 }).pass, false);
    const moved = judgeSequencer(ref, { onsets: [0, 0.5, 1.002, 1.5], lufsI: -40 }, { baselineLufs: -40 });
    assert.equal(moved.pass, false);
    assert.equal(moved.onsets.firstMismatch.index, 2);
    // A missing note is a mismatch even when every shared onset agrees.
    assert.equal(compareOnsets(ref.onsets, [0, 0.5, 1]).identical, false);
    assert.equal(judgeSequencer({ onsets: [], lufsI: -40 }, { onsets: [], lufsI: -40 }, { baselineLufs: -40 }).pass, false);
});

test('frame cost compares sound-on and sound-off p95', () => {
    const off = Array.from({ length: 100 }, (_, i) => 4 + i / 100);
    assert.equal(frameCostDelta(off.map(x => x + 0.05), off).pass, true);
    assert.equal(frameCostDelta(off.map(x => x + 0.2), off).pass, false);
});

function noise(seconds, amp) {
    const x = new Float32Array(Math.round(seconds * SR));
    let seed = 12345;
    for (let i = 0; i < x.length; i++) {
        seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
        x[i] = amp * ((seed / 4294967296) * 2 - 1);
    }
    return x;
}

test('limiter GR is the input peak over the delayed output peak', () => {
    const inp = noise(1, 0.5);
    const delay = 120;
    const out = new Float32Array(inp.length);
    // Output = input delayed by the lookahead, 6 dB down in the second half.
    for (let i = delay; i < out.length; i++) out[i] = inp[i - delay] * (i >= SR / 2 ? 0.5 : 1);
    const gr = limiterGainReduction(inp, inp, out, out, SR);
    assert.equal(gr.delay, delay);
    assert.ok(maxGrIn(gr, 0.05, 0.45) < 0.01);
    assert.ok(Math.abs(maxGrIn(gr, 0.55, 0.95) - 6.02) < 0.05);
});

test('switch hole and bump compare the switch window with both steady states', () => {
    const curve = [];
    for (let t = 0.4; t < 30; t += 0.1) {
        let v = t < 10 ? -40 : -36;
        if (t >= 10.5 && t < 11.5) v = -46;
        curve.push([t, v]);
    }
    const r = switchHoleBump(curve, 10.2);
    assert.equal(Math.round(r.holeDb), 6);
    assert.equal(r.bumpDb, 0);
    const flat = switchHoleBump(curve.map(([t]) => [t, -40]), 10.2);
    assert.equal(flat.holeDb, 0);
});

test('onsetNear reads a note from silence at its first millisecond and over a ring within its attack', () => {
    const x = new Float32Array(SR);
    for (let i = Math.round(0.5 * SR); i < x.length; i++) x[i] = 0.2 * Math.sin(2 * Math.PI * 800 * i / SR);
    const t = onsetNear(x, SR, 0.49);
    assert.ok(t != null && Math.abs(t - 0.5) <= 0.001);
    // A louder second note at 0.7 s, 10 ms linear attack, over a quiet ring.
    const y = Float32Array.from(x, v => v / 4);
    for (let i = Math.round(0.7 * SR); i < y.length; i++) {
        const env = Math.min(1, (i - 0.7 * SR) / (0.01 * SR));
        y[i] += 0.3 * env * Math.sin(2 * Math.PI * 1100 * i / SR);
    }
    const t2 = onsetNear(y, SR, 0.7);
    assert.ok(t2 != null && t2 >= 0.7 && t2 - 0.7 <= 0.004, `second note at ${t2}`);
    assert.equal(onsetNear(new Float32Array(SR), SR, 0.5), null);
});

test('AV sync reports absolute error statistics and counts unheard notes', () => {
    const s = avSync([
        { published: 1, heard: 1.004 },
        { published: 2, heard: 1.99 },
        { published: 3, heard: null },
    ]);
    assert.equal(s.n, 3);
    assert.equal(s.missed, 1);
    assert.ok(Math.abs(s.medianAbsMs - 7) < 1e-6);
    assert.ok(Math.abs(s.p95AbsMs - 10) < 1e-6);
});
