// Music listening metrics (MUSL; ported from the MUSL notes,
// musl-snippets/measure.mjs):
//   lufs          BS.1770 integrated
//   laptopDeltaLu LUFS after a 4th-order 200 Hz high-pass (a crude 13–16″
//                 laptop speaker) minus full range: how much music survives
//   presenceDb    2–5 kHz energy share of the mid channel (dB re total)
//   holesPerMin   momentary (400 ms) dips ≥ 3 dB under the running 3 s median
//   mStdLu        standard deviation of momentary loudness over gated blocks
import { loudness } from '../lib/analyze.mjs';
import { biquad, midOf, round } from './dsp.mjs';

function hp4(x, fs, f0) {
    // Butterworth 4th order as two biquads (Q 0.54, 1.31).
    return biquad(biquad(x, 'hp', f0, fs, 0.54), 'hp', f0, fs, 1.31);
}

function bandShareDb(mid, fs, lo, hi) {
    const hpLo = biquad(biquad(mid, 'hp', lo, fs), 'hp', lo, fs);
    const hpHi = biquad(biquad(mid, 'hp', hi, fs), 'hp', hi, fs);
    let eAll = 0;
    let eLo = 0;
    let eHi = 0;
    for (let i = 0; i < mid.length; i++) { eAll += mid[i] * mid[i]; eLo += hpLo[i] * hpLo[i]; eHi += hpHi[i] * hpHi[i]; }
    return 10 * Math.log10(Math.max(1e-30, eLo - eHi) / eAll);
}

export function musicMeasure(L, R, fs) {
    const full = loudness(L, R, fs);
    const lap = loudness(Float32Array.from(hp4(L, fs, 200)), Float32Array.from(hp4(R, fs, 200)), fs);
    const presence = bandShareDb(midOf(L, R), fs, 2000, 5000);
    const win = Math.round(0.4 * fs);
    const hop = Math.round(0.1 * fs);
    const kw = [];
    for (let s = 0; s + win <= L.length; s += hop) {
        let e = 0;
        for (let i = s; i < s + win; i += 4) e += L[i] * L[i] + R[i] * R[i];
        kw.push(10 * Math.log10(e / (win / 4) + 1e-20));
    }
    const gated = kw.filter(v => v > full.integrated - 20 - 0.691);
    const mean = gated.reduce((a, b) => a + b, 0) / Math.max(1, gated.length);
    const mStd = Math.sqrt(gated.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, gated.length));
    let holes = 0;
    let inHole = false;
    for (let i = 15; i < kw.length - 15; i++) {
        const around = kw.slice(i - 15, i + 15).sort((a, b) => a - b);
        const med = around[15];
        const dip = kw[i] < med - 3 && med > full.integrated - 10;
        if (dip && !inHole) holes++;
        inHole = dip;
    }
    const minutes = L.length / fs / 60;
    return {
        lufs: round(full.integrated),
        laptopDeltaLu: round(lap.integrated - full.integrated),
        presenceDb: round(presence),
        holesPerMin: round(holes / minutes),
        mStdLu: round(mStd, 2),
    };
}
