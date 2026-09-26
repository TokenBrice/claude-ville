// Cue audibility in bands (MIX; ported from mix-snippets/cuebands.mjs):
// third-octave band power in the cue window [t + 0.03, t + 1.2] against the
// bed [t − 3, t − 0.1]. Reports the best band rise (where the cue is audible),
// how many bands rise ≥ 6 dB (S2's band rule over non-music beds), and the
// deepest band fall (the duck "hole" heard instead). `presenceRise` is the
// band rule over music: 0.5–4 kHz energy in [t, t + 1.2) vs [t − 3, t).
import { welch } from './dsp.mjs';

const N = 4096;
// ⅓-octave centres 100 Hz … 8 kHz.
export const THIRD_OCTAVE_CENTERS = Array.from({ length: 20 }, (_, i) => 1000 * Math.pow(2, (i - 10) / 3));

function span(L, R, sr, t0, t1) {
    return { start: Math.max(0, Math.floor(t0 * sr)), end: Math.min(L.length, Math.floor(t1 * sr)) };
}

export function thirdOctavePower(L, R, sr, t0, t1) {
    const psd = welch([L, R], { n: N, hop: N / 4, ...span(L, R, sr, t0, t1) });
    return THIRD_OCTAVE_CENTERS.map((fc) => {
        const lo = fc / Math.pow(2, 1 / 6);
        const hi = fc * Math.pow(2, 1 / 6);
        let p = 0;
        for (let k = Math.ceil(lo * N / sr); k <= Math.floor(hi * N / sr); k++) p += psd[k];
        return p;
    });
}

const fmtHz = hz => (hz >= 1000 ? `${(hz / 1000).toFixed(hz >= 2000 ? 1 : 2)}k` : `${Math.round(hz)}`);

export function cueBandRise(L, R, sr, t) {
    const pre = thirdOctavePower(L, R, sr, t - 3, t - 0.1);
    const cue = thirdOctavePower(L, R, sr, t + 0.03, t + 1.2);
    const rise = pre.map((p, i) => 10 * Math.log10((cue[i] + 1e-30) / (p + 1e-30)));
    let best = 0;
    let worst = 0;
    rise.forEach((r, i) => { if (r > rise[best]) best = i; if (r < rise[worst]) worst = i; });
    return {
        bestBand: fmtHz(THIRD_OCTAVE_CENTERS[best]),
        bestRiseDb: Number(rise[best].toFixed(1)),
        bandsOver6dB: rise.filter(r => r >= 6).length,
        holeBand: fmtHz(THIRD_OCTAVE_CENTERS[worst]),
        holeDb: Number(rise[worst].toFixed(1)),
        riseDb: rise.map(r => Number(r.toFixed(1))),
    };
}

// Band energy rise (dB) of [t, t + afterSec) over [t − beforeSec, t).
export function presenceRise(L, R, sr, t, { bandHz = [500, 4000], afterSec = 1.2, beforeSec = 3 } = {}) {
    const band = (t0, t1) => {
        const psd = welch([L, R], { n: N, hop: N / 4, ...span(L, R, sr, t0, t1) });
        let p = 0;
        for (let k = Math.ceil(bandHz[0] * N / sr); k <= Math.floor(bandHz[1] * N / sr); k++) p += psd[k];
        return p;
    };
    return 10 * Math.log10((band(t, t + afterSec) + 1e-30) / (band(t - beforeSec, t) + 1e-30));
}
