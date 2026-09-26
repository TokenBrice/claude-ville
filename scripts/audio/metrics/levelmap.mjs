// Mix level map (MIX; ported from mix-snippets/levelmap.mjs): loudness,
// K-weighted band shares (who carries the loudness), the 2–5 kHz presence
// share, stereo (S/M, correlation, mono fold loss), the small-speaker loss
// (HAR-7: 4th-order Butterworth high-pass at 180 Hz) and the quiet share.
import { loudness, kWeightCoeffs } from '../lib/analyze.mjs';
import { biquadMag2, round, welch } from './dsp.mjs';

export const LEVEL_BANDS = [
    ['sub<80', 20, 80], ['low80-250', 80, 250], ['box250-800', 250, 800], ['mid0.8-2k', 800, 2000],
    ['pres2-5k', 2000, 5000], ['hi5-10k', 5000, 10000], ['air>10k', 10000, 24000],
];

export function levelMap(L, R, sr) {
    const lou = loudness(L, R, sr);
    const psd = welch([L, R]);
    const N = (psd.length - 1) * 2;
    const { shelf, hp } = kWeightCoeffs(sr);
    const kb = LEVEL_BANDS.map(() => 0);
    const rb = LEVEL_BANDS.map(() => 0);
    let kTot = 0;
    let rawTot = 0;
    let spkTot = 0;
    for (let k = 1; k < psd.length; k++) {
        const f = k * sr / N;
        const w = 2 * Math.PI * f / sr;
        const kw = biquadMag2(shelf, w) * biquadMag2(hp, w);
        const p = psd[k];
        const r = Math.pow(f / 180, 8);
        spkTot += p * kw * (r / (1 + r));
        rawTot += p;
        kTot += p * kw;
        LEVEL_BANDS.forEach(([, lo, hi], i) => { if (f >= lo && f < hi) { rb[i] += p; kb[i] += p * kw; } });
    }
    const kShare = {};
    const rawShare = {};
    LEVEL_BANDS.forEach(([name], i) => {
        kShare[name] = round(100 * kb[i] / kTot);
        rawShare[name] = round(100 * rb[i] / rawTot);
    });
    let sm = 0;
    let ss = 0;
    let sl = 0;
    let srr = 0;
    let slr = 0;
    let peak = 0;
    const M = new Float32Array(L.length);
    for (let i = 0; i < L.length; i++) {
        const m = (L[i] + R[i]) / 2;
        const s = (L[i] - R[i]) / 2;
        M[i] = m;
        sm += m * m; ss += s * s; sl += L[i] * L[i]; srr += R[i] * R[i]; slr += L[i] * R[i];
        peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
    }
    const monoLou = loudness(M, M, sr);
    const st = lou.shortTermCurve.map(([, v]) => v).filter(Number.isFinite).sort((a, b) => a - b);
    const stMed = st.length ? st[Math.floor(st.length / 2)] : -Infinity;
    const mom = lou.momentaryCurve.map(([, v]) => v);
    const quiet = mom.filter(v => !(v > stMed - 10)).length / Math.max(1, mom.length);
    const pct = (arr, p) => (arr.length ? arr[Math.min(arr.length - 1, Math.round(p * (arr.length - 1)))] : null);
    return {
        lufsI: round(lou.integrated), stMax: round(lou.shortTermMax), stP10: round(pct(st, 0.1)), stP90: round(pct(st, 0.9)),
        lra: round(lou.lra), samplePeakDBFS: round(20 * Math.log10(peak || 1e-12)),
        kShare, rawShare,
        speakerLossLU: round(-10 * Math.log10(spkTot / kTot)),
        presenceLU: round(10 * Math.log10(kb[4] / kTot || 1e-12) + lou.integrated),
        presenceSharePct: round(100 * kb[4] / kTot),
        sideMidDB: round(10 * Math.log10((ss || 1e-30) / (sm || 1e-30))),
        corr: round(slr / Math.sqrt(sl * srr || 1), 2),
        monoLossLU: round(lou.integrated - monoLou.integrated),
        quietSharePct: round(100 * quiet, 0),
    };
}
