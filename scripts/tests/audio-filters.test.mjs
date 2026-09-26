import test from 'node:test';
import assert from 'node:assert/strict';

import { makeFilter } from '../../claudeville/src/presentation/shared/audio/Filters.js';

const SR = 48000;

// A BiquadFilterNode stand-in that keeps the values makeFilter writes.
const fakeCtx = {
    createBiquadFilter: () => ({
        type: 'lowpass',
        frequency: { value: 350 },
        Q: { value: 1 },
        gain: { value: 0 },
    }),
};

// The node's magnitude response in dB at `hz`, from the Web Audio spec's
// biquad coefficients (the Audio EQ Cookbook with lowpass/highpass Q in dB),
// i.e. what getFrequencyResponse reports.
function responseDb(node, hz, sampleRate = SR) {
    const w0 = 2 * Math.PI * node.frequency.value / sampleRate;
    const cos = Math.cos(w0);
    const sin = Math.sin(w0);
    const Q = node.Q.value;
    const A = Math.pow(10, node.gain.value / 40);
    let b;
    let a;
    if (node.type === 'lowpass' || node.type === 'highpass') {
        const alpha = sin / (2 * Math.pow(10, Q / 20));
        const k = node.type === 'lowpass' ? 1 - cos : 1 + cos;
        const sign = node.type === 'lowpass' ? 1 : -1;
        b = [k / 2, sign * k, k / 2];
        a = [1 + alpha, -2 * cos, 1 - alpha];
    } else if (node.type === 'bandpass') {
        const alpha = sin / (2 * Q);
        b = [alpha, 0, -alpha];
        a = [1 + alpha, -2 * cos, 1 - alpha];
    } else if (node.type === 'peaking') {
        const alpha = sin / (2 * Q);
        b = [1 + alpha * A, -2 * cos, 1 - alpha * A];
        a = [1 + alpha / A, -2 * cos, 1 - alpha / A];
    } else {
        throw new Error(`no response model for ${node.type}`);
    }
    const w = 2 * Math.PI * hz / sampleRate;
    const eval2 = ([c0, c1, c2]) => {
        const re = c0 + c1 * Math.cos(-w) + c2 * Math.cos(-2 * w);
        const im = c1 * Math.sin(-w) + c2 * Math.sin(-2 * w);
        return Math.hypot(re, im);
    };
    return 20 * Math.log10(eval2(b) / eval2(a));
}

function logSweep(from, to, points = 400) {
    const out = [];
    for (let i = 0; i <= points; i++) out.push(from * Math.pow(to / from, i / points));
    return out;
}

test("a 'butterworth' low-pass is -3.0 dB at its cutoff and never peaks", () => {
    for (const fc of [200, 1000, 6200, 14000]) {
        const lp = makeFilter(fakeCtx, 'lowpass', fc, { q: 'butterworth' });
        const atFc = responseDb(lp, fc);
        assert.ok(Math.abs(atFc - -3.0) <= 0.1, `LP ${fc} Hz: ${atFc.toFixed(3)} dB at fc`);
        const peak = Math.max(...logSweep(10, fc).map(hz => responseDb(lp, hz)));
        assert.ok(peak <= 0.001, `LP ${fc} Hz peaks at +${peak.toFixed(4)} dB`);
    }
});

test("the default low/high-pass Q is 'butterworth'", () => {
    const lp = makeFilter(fakeCtx, 'lowpass', 14000);
    assert.ok(Math.abs(responseDb(lp, 14000) - -3.0) <= 0.1);
    const hp = makeFilter(fakeCtx, 'highpass', 30);
    assert.ok(Math.abs(responseDb(hp, 30) - -3.0) <= 0.1);
    // Program path: within 0.5 dB from 55 Hz up.
    assert.ok(responseDb(hp, 55) >= -0.5, `HP 30 Hz at 55 Hz: ${responseDb(hp, 55).toFixed(3)} dB`);
});

test("a 'gentle' low-pass has no point above +0.05 dB below its cutoff", () => {
    const lp = makeFilter(fakeCtx, 'lowpass', 2600, { q: 'gentle' });
    for (const hz of logSweep(10, 2600)) {
        assert.ok(responseDb(lp, hz) <= 0.05, `${hz.toFixed(1)} Hz: ${responseDb(lp, hz).toFixed(4)} dB`);
    }
    // Softer than Butterworth at the cutoff (linear Q 0.5 → -6 dB).
    assert.ok(Math.abs(responseDb(lp, 2600) - -6.02) <= 0.1);
});

test('a numeric low/high-pass Q is linear: 0.4 is a soft knee, not a peak', () => {
    const lp = makeFilter(fakeCtx, 'lowpass', 900, { q: 0.4 });
    const peak = Math.max(...logSweep(10, 900).map(hz => responseDb(lp, hz)));
    assert.ok(peak <= 0.001, `peak +${peak.toFixed(4)} dB`);
    const hp = makeFilter(fakeCtx, 'highpass', 300, { q: 0.7071 });
    assert.ok(Math.abs(responseDb(hp, 300) - -3.0) <= 0.1);
});

test('band-pass and peaking keep linear Q semantics', () => {
    // A 1 kHz band-pass at linear Q 2 has a -3 dB bandwidth of fc / Q.
    const bp = makeFilter(fakeCtx, 'bandpass', 1000, { q: 2 });
    const sweep = logSweep(200, 5000, 4000);
    const passing = sweep.filter(hz => responseDb(bp, hz) >= -3.0103);
    const bandwidth = passing.at(-1) - passing[0];
    assert.ok(Math.abs(bandwidth - 500) <= 10, `bandwidth ${bandwidth.toFixed(1)} Hz`);

    // The world presence dip: -3 dB at 3.4 kHz, back within 0.5 dB an octave and a half away.
    const dip = makeFilter(fakeCtx, 'peaking', 3400, { q: 0.9, gain: -3 });
    assert.ok(Math.abs(responseDb(dip, 3400) - -3) <= 0.01);
    assert.ok(responseDb(dip, 1000) >= -0.5 && responseDb(dip, 12000) >= -0.5);
});

test('an invalid Q is refused rather than silently misread', () => {
    assert.throws(() => makeFilter(fakeCtx, 'lowpass', 1000, { q: 0 }), RangeError);
    assert.throws(() => makeFilter(fakeCtx, 'peaking', 1000, { q: 'resonant' }), RangeError);
});
