import test from 'node:test';
import assert from 'node:assert/strict';

import {
    avSync, duckedTime, judgeLane, judgeSceneTargets, laneWindow, limiterGainReduction, maxGrIn, onsetNear, stageOutcome, switchHoleBump,
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

test('needs-you and error take the Wave-1 interim floor; other lanes keep their S2 window', () => {
    assert.deepEqual(laneWindow('needsYou', 'village'), { min: 8, max: 12 });
    assert.deepEqual(laneWindow('error', 'music'), { min: 4, max: 12 });
    assert.deepEqual(laneWindow('limit', 'weather'), { min: 4, max: 10 });
    assert.deepEqual(laneWindow('routine', 'music'), { min: 3, max: 6 });
});

test('a lane is judged on the median placement, and an urgent lane also on the band rule and GR', () => {
    const ok = { bandsOver6dB: 3, presenceRiseDb: 9, grDb: 1 };
    const pass = judgeLane('needsYou', 'village', [{ ...ok, margin: 7 }, { ...ok, margin: 9 }, { ...ok, margin: 12 }]);
    assert.equal(pass.margin, 9);
    assert.equal(pass.pass, true);
    const gr = judgeLane('needsYou', 'village', [{ ...ok, margin: 9 }, { ...ok, margin: 9, grDb: 3.5 }, { ...ok, margin: 9 }]);
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
    const placements = [{ margin: 10.6, presenceRiseDb: -3, grDb: 0.5 }];
    const early = judgeLane('limit', 'music', placements, { stage: 1 });
    assert.equal(early.outcome, 'DEFER');
    assert.equal(early.pass, true);
    assert.deepEqual(early.failures.map(f => [f.what, f.gatedFrom]), [['margin > 10', 3], ['presence rise < 6 dB', 3]]);
    assert.equal(judgeLane('limit', 'music', placements, { stage: 3 }).outcome, 'FAIL');
    // The needs-you band rule and every lane's floor gate now.
    assert.equal(judgeLane('needsYou', 'music', [{ margin: 9, presenceRiseDb: -3, grDb: 0 }], { stage: 1 }).outcome, 'FAIL');
    assert.equal(judgeLane('error', 'music', [{ margin: 2, presenceRiseDb: 9, grDb: 0 }], { stage: 1 }).outcome, 'FAIL');
    const busy = judgeSceneTargets({ anchor: { lufsI: -38 }, villageBusy: { lufsI: -31, lra: 4 } }, undefined, { stage: 1 });
    assert.deepEqual(busy.map(r => [r.scene, r.outcome]), [['anchor', 'PASS'], ['villageBusy', 'DEFER']]);
    assert.equal(judgeSceneTargets({ anchor: { lufsI: -38 }, villageBusy: { lufsI: -31, lra: 4 } }, undefined, { stage: 4 })[1].outcome, 'FAIL');
});

test('scene targets are relative to the anchor measured in the same run', () => {
    const rows = judgeSceneTargets({
        anchor: { lufsI: -38.4 },
        villageBusy: { lufsI: -33.9, lra: 6 },
        rain: { lufsI: -33.3 },
        storm: { lufsI: -30.6 },
        resting: { stMean: -48, stMin: -56 },
    });
    const by = Object.fromEntries(rows.map(r => [r.scene, r.pass]));
    assert.deepEqual(by, { anchor: true, villageBusy: true, rain: false, storm: true, resting: false });
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
