import test from 'node:test';
import assert from 'node:assert/strict';

import {
    avSync, duckedTime, frameCostDelta, judgeAirT60, judgeBank, judgeLane, judgeQuietMix, judgeSceneTargets,
    judgeTransport, laneWindow, limiterGainReduction, maxGrIn, onsetNear, quietStemRow, resumeBurst,
    stageOutcome, presetSwitch,
} from '../audio/lib/checks.mjs';

const SR = 48000;

test('ducked time unions overlapping windows on the music bus and ignores ducks that leave it', () => {
    const ducks = [
        { from: 10, until: 11, attack: 0, release: 0, depths: { music: 0 } },
        { from: 10.5, until: 12, attack: 0, release: 0, depths: { music: -9 } },
        { from: 11, until: 13, attack: 0, release: 0, depths: { music: -2 } },
    ];
    assert.deepEqual(duckedTime(ducks, 0, 100), { music: 0.025 });
});

test('a duck cancelled before it opens adds no ducked time; one cancelled midway stops there', () => {
    const f = duckedTime([
        { from: 5, until: 6, attack: 0.04, release: 0.6, depths: { music: -2 }, cancelledAt: 4 },
        { from: 20, until: 30, attack: 0, release: 0, depths: { music: -2 }, cancelledAt: 22 },
    ], 0, 100);
    assert.equal(f.music, 0.02);
});

test('ducked time includes the attack before the note and the release after the window, clipped to the scene', () => {
    const f = duckedTime([{ from: 0.02, until: 1, depths: { music: -2 } }], 0, 10);
    // Attack (0.04 s) is clipped at the scene start; release defaults to 0.6 s.
    assert.ok(Math.abs(f.music - 0.16) < 1e-9);
});

test('every lane is held to its full S2 window per bed', () => {
    assert.deepEqual(laneWindow('needsYou', 'village'), { min: 10, max: 12 });
    assert.deepEqual(laneWindow('needsYou', 'music'), { min: 8, max: 12 });
    assert.deepEqual(laneWindow('error', 'music'), { min: 6, max: 12 });
    assert.deepEqual(laneWindow('limit', 'village'), { min: 6, max: 10 });
    assert.deepEqual(laneWindow('routine', 'music'), { min: 3, max: 6 });
    assert.deepEqual(laneWindow('outcomeMinor', 'village'), { min: 0, max: 3 });
    assert.deepEqual(laneWindow('outcomeMajor', 'music'), { min: 4, max: 8 });
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

test('over the Signals silence a lane keeps its floor and GR limit but not its ceiling', () => {
    const call = { bandsOver6dB: 5, grDb: 1 };
    // A call over silence reads its level over the −80 LUFS floor: far past +12.
    assert.equal(judgeLane('needsYou', 'village', [{ ...call, margin: 40 }]).pass, false);
    assert.equal(judgeLane('needsYou', 'village', [{ ...call, margin: 40 }], { ceilingExempt: true }).pass, true);
    assert.equal(judgeLane('needsYou', 'village', [{ ...call, margin: 40, grDb: 3.5 }], { ceilingExempt: true }).pass, false);
    assert.equal(judgeLane('needsYou', 'village', [{ ...call, margin: 9 }], { ceilingExempt: true }).pass, false);
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
    const gated = { 'margin:bandBusy:error': 8 };
    const busyError = [{ margin: 5.7, presenceRiseDb: 7, grDb: 3.4 }];
    const busy = judgeLane('error', 'music', busyError, { probeBed: 'bandBusy', stage: 7, gated });
    assert.equal(busy.outcome, 'DEFER');
    assert.deepEqual(busy.failures.map(f => f.gatedFrom), [8, 8]);
    assert.equal(judgeLane('error', 'music', busyError, { probeBed: 'bandBusy', stage: 8, gated }).outcome, 'FAIL');
    assert.equal(judgeLane('error', 'music', busyError, { probeBed: 'music', stage: 7, gated }).outcome, 'FAIL');
});

test('the Town band scene holds S2 LUFS-I and its band stem short-term ceiling, or defers while gated later', () => {
    assert.equal(judgeSceneTargets({ townBand: { lufsI: -31.4, bandStemStMax: -29 } })[0].outcome, 'PASS');
    assert.equal(judgeSceneTargets({ townBand: { lufsI: -29.8, bandStemStMax: -29 } })[0].outcome, 'FAIL');
    assert.equal(judgeSceneTargets({ townBand: { lufsI: -31, bandStemStMax: -27.5 } })[0].outcome, 'FAIL');
    const late = judgeSceneTargets({ townBand: { lufsI: -29.8 } }, undefined, { stage: 7, gated: { 'scene:townBand': 8 } });
    assert.equal(late[0].outcome, 'DEFER');
    assert.deepEqual(judgeSceneTargets({}), []);
});

const TICK = { site: 'Transport.js:88', fired: 2400, p95Ms: 0.2, maxMs: 1.1, starts: 900 };

test('the transport passes only when its own timer is the one that placed sound', () => {
    const diag = { underruns: 0, processes: [{ name: 'music', maxAheadSec: 1.5 }] };
    const harness = { site: 'harness', fired: 40, starts: 30 };
    assert.equal(judgeTransport(diag, [TICK, harness]).pass, true);
    const otherTimer = { site: 'music/Sequencer.js:55', fired: 300, p95Ms: 0.1, maxMs: 0.3, starts: 12 };
    const two = judgeTransport(diag, [TICK, otherTimer]);
    assert.equal(two.pass, false);
    assert.deepEqual(two.soundSites.map(s => s.site), ['Transport.js:88', 'music/Sequencer.js:55']);
    // A lone sound-placing timer that is not the Transport fails too.
    assert.equal(judgeTransport(diag, [{ ...TICK, starts: 0 }, otherTimer]).pass, false);
});

test('the transport holds each process to its horizon and counts underruns and tick cost', () => {
    const ok = { underruns: 0, processes: [{ name: 'music', maxAheadSec: 1.4 }] };
    assert.equal(judgeTransport(ok, [TICK]).pass, true);
    assert.equal(judgeTransport({ ...ok, underruns: 1 }, [TICK]).pass, false);
    assert.equal(judgeTransport({ underruns: 0, processes: [{ name: 'music', maxAheadSec: 1.6 }] }, [TICK]).pass, false);
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

// A 1 kHz tone at -20 dBFS until `offAt` (a linear fade over `fadeSec`
// before it), from `onAt` on; its momentary curve is read off the tone.
function switchProgram({ seconds = 30, onAt = 0, offAt = Infinity, fadeSec = 0.8 }) {
    const L = new Float32Array(seconds * SR);
    for (let i = 0; i < L.length; i++) {
        const t = i / SR;
        const g = t < onAt ? 0 : (t >= offAt ? 0 : Math.min(1, (offAt - t) / fadeSec));
        L[i] = 0.1 * g * Math.sin(2 * Math.PI * 1000 * i / SR);
    }
    const curve = [];
    for (let t = 0.4; t < seconds; t += 0.1) {
        const sounding = t - 0.4 >= onAt && t <= offAt - fadeSec;
        curve.push([t, sounding ? -23 : -Infinity]);
    }
    return { L, R: L, sr: SR, curve };
}

test('a switch into Signals passes a fade to silence and catches a click after the fade', () => {
    const p = switchProgram({ offAt: 10.8 });
    const r = presetSwitch(p.curve, p, 10, { fadeSec: 0.8 });
    assert.equal(r.direction, 'out');
    assert.ok(r.pass, JSON.stringify(r));
    assert.equal(r.clickDb, 0);
    // A 5 ms pop at 11.5 s, after the band has gone.
    for (let i = Math.round(11.5 * SR); i < Math.round(11.505 * SR); i++) p.L[i] = 0.05;
    const click = presetSwitch(p.curve, p, 10, { fadeSec: 0.8 });
    assert.ok(!click.pass && click.clickDb > 6, JSON.stringify(click));
});

test('a switch into the Town band wants the band heard by the fade\'s end, and a band louder than it settles fails as a bump', () => {
    const on = switchProgram({ onAt: 10.6 });
    const r = presetSwitch(on.curve, on, 10, { fadeSec: 0.8 });
    assert.equal(r.direction, 'in');
    assert.ok(r.pass && Math.abs(r.entryAfter - 0.6) < 0.011, JSON.stringify(r));
    const late = switchProgram({ onAt: 11.2 });
    assert.ok(!presetSwitch(late.curve, late, 10, { fadeSec: 0.8 }).pass);
    const bump = on.curve.map(([t, v]) => [t, t > 11 && t < 12 ? -17 : v]);
    assert.ok(!presetSwitch(bump, on, 10, { fadeSec: 0.8 }).pass);
    // Both sides sounding is not a Town band ↔ Signals switch.
    assert.equal(presetSwitch(on.curve.map(([t]) => [t, -23]), on, 10, { fadeSec: 0.8 }), null);
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

test('the Town band quiet mix is judged on its blur level and on how fast focus restores it', () => {
    const curve = [];
    for (let t = 0; t < 30; t += 0.1) curve.push([t, t >= 10 && t < 20.4 ? -3 : 0]);
    const row = quietStemRow(curve, { blurSec: 10, focusSec: 20 });
    assert.equal(row.levelDb, -3);
    assert.ok(Math.abs(row.restoreLagSec - 0.4) < 1e-6);
    assert.equal(judgeQuietMix({ music: { ...row, want: -3 } }).pass, true);
    assert.equal(judgeQuietMix({ music: { levelDb: -3, restoreLagSec: 1.4, want: -3 } }).pass, false);
    assert.equal(judgeQuietMix({ music: { levelDb: -6, restoreLagSec: 0.2, want: -3 } }).pass, false);
    assert.equal(judgeQuietMix({ music: { levelDb: -3, restoreLagSec: null, want: -3 } }).pass, false);
});
