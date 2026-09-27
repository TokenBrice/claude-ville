// Environment metrics (AMB; ported from the AMB notes, amb-snippets/metrics.mjs):
// repetition (normalised autocorrelation at chosen lags), stereo
// interchannel correlation (ICC), Schroeder RT60 per octave band for IR
// renders, and the wet share of a with/without-air pair. Pure Node on
// Float32Array channels.
import { biquad, fft, midOf, round } from './dsp.mjs';

// Normalised autocorrelation r(lag) over all lags via FFT on a 4×-decimated
// copy; r(lagS, searchMs) takes the strongest value within ±searchMs (absorbs
// realtime splice shifts). `peak` is the strongest lag in 0.5…min(20, dur/2) s.
export function autocorrelation(x, fs, { hp = 0 } = {}) {
    const y = hp ? biquad(x, 'hp', hp, fs) : x;
    const D = 4;
    const n = Math.floor(y.length / D);
    const d = new Float64Array(n);
    for (let i = 0; i < n; i++) {
        let s = 0;
        for (let k = 0; k < D; k++) s += y[i * D + k];
        d[i] = s / D;
    }
    let N = 1;
    while (N < 2 * n) N <<= 1;
    const re = new Float64Array(N);
    const im = new Float64Array(N);
    re.set(d);
    fft(re, im);
    for (let i = 0; i < N; i++) { re[i] = re[i] * re[i] + im[i] * im[i]; im[i] = 0; }
    fft(re, im, true);
    const cum = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) cum[i + 1] = cum[i] + d[i] * d[i];
    const fsD = fs / D;
    const r = (lagS, searchMs = 20) => {
        const c = Math.round(lagS * fsD);
        const w = Math.round(searchMs / 1000 * fsD);
        let best = 0;
        for (let L = Math.max(1, c - w); L <= c + w && L < n; L++) {
            const e1 = cum[n - L];
            const e2 = cum[n] - cum[L];
            const v = re[L] / Math.sqrt(e1 * e2 + 1e-30);
            if (Math.abs(v) > Math.abs(best)) best = v;
        }
        return best;
    };
    let peak = { lag: 0, r: 0 };
    const maxLag = Math.min(20, n / fsD / 2);
    for (let lag = 0.5; lag <= maxLag; lag += 0.005) {
        const v = r(lag, 2.5);
        if (v > peak.r) peak = { lag: Number(lag.toFixed(3)), r: v };
    }
    return { r, peak };
}

export function icc(L, R) {
    let lr = 0;
    let ll = 0;
    let rr = 0;
    for (let i = 0; i < L.length; i++) { lr += L[i] * R[i]; ll += L[i] * L[i]; rr += R[i] * R[i]; }
    return lr / Math.sqrt(ll * rr + 1e-30);
}

// Repetition of a texture (C-AMB-3: autocorrelation < 0.05 at 0.5–20 s lags).
export function repetition(L, R, fs) {
    const m = midOf(L, R);
    const ac = autocorrelation(m, fs);
    const acHi = autocorrelation(m, fs, { hp: 1000 });
    return {
        durationS: round(L.length / fs),
        r1: round(ac.r(1), 3), r2_5: round(ac.r(2.5), 3), r4: round(ac.r(4), 3), r8: round(ac.r(8), 3),
        r4Hp1k: round(acHi.r(4), 3), peak: { lagS: ac.peak.lag, r: round(ac.peak.r, 3) },
        icc: round(icc(L, R), 3),
    };
}

// Schroeder backward integration, T20 fit (−5…−25 dB) ×3, per octave band on
// the mid channel; C80 and ICC. For impulse-response renders (S5 Island Air).
export function rt60(L, R, fs, { bands = [250, 500, 1000, 2000, 4000] } = {}) {
    const m = midOf(L, R);
    let pk = 0;
    for (const v of m) pk = Math.max(pk, Math.abs(v));
    let on = 0;
    while (on < m.length && Math.abs(m[on]) < pk * 0.01) on++;
    const out = {};
    for (const fc of bands) {
        const y = biquad(biquad(m, 'bp', fc, fs, 1.414), 'bp', fc, fs, 1.414);
        const e = new Float64Array(y.length);
        let s = 0;
        for (let i = y.length - 1; i >= on; i--) { s += y[i] * y[i]; e[i] = s; }
        const e0 = e[on];
        const db = i => 10 * Math.log10(e[i] / e0 + 1e-30);
        let i5 = on;
        while (i5 < y.length && db(i5) > -5) i5++;
        let i25 = i5;
        while (i25 < y.length && db(i25) > -25) i25++;
        let sx = 0;
        let sy = 0;
        let sxx = 0;
        let sxy = 0;
        let k = 0;
        for (let i = i5; i < i25; i += 16) { const x = i / fs; const v = db(i); sx += x; sy += v; sxx += x * x; sxy += x * v; k++; }
        const slope = (k * sxy - sx * sy) / (k * sxx - sx * sx);
        out[`t60_${fc}`] = round(-60 / slope, 2);
    }
    let early = 0;
    let late = 0;
    const c80 = on + Math.round(0.08 * fs);
    for (let i = on; i < m.length; i++) { if (i < c80) early += m[i] * m[i]; else late += m[i] * m[i]; }
    out.c80Db = round(10 * Math.log10(early / late));
    out.icc = round(icc(L, R), 3);
    return out;
}

// Wet share of a deterministic pair (a = with air, b = dry): energy of
// (a − b) relative to b, overall and per band, and the wet ICC.
export function wetDry(a, b, fs) {
    const n = Math.min(a.L.length, b.L.length);
    const dm = new Float64Array(n);
    const bm = new Float64Array(n);
    let lr = 0;
    let ll = 0;
    let rr = 0;
    for (let i = 0; i < n; i++) {
        const l = a.L[i] - b.L[i];
        const r = a.R[i] - b.R[i];
        dm[i] = 0.5 * (l + r);
        bm[i] = 0.5 * (b.L[i] + b.R[i]);
        lr += l * r; ll += l * l; rr += r * r;
    }
    const e = x => x.reduce((s, v) => s + v * v, 0);
    const out = { wetToDryDb: round(10 * Math.log10(e(dm) / e(bm))) };
    for (const fc of [250, 1000, 4000]) out[`band${fc}Db`] = round(10 * Math.log10(e(biquad(dm, 'bp', fc, fs, 1.4)) / e(biquad(bm, 'bp', fc, fs, 1.4))));
    out.wetIcc = round(lr / Math.sqrt(ll * rr), 3);
    return out;
}
