// Cue discrimination (CUE-9; ported from the CUE notes, cue-snippets/discrim.mjs
// and discrim2.mjs). Contour, rhythm and register come from each cue's
// designed score (cross-checked against measured onsets); timbre from its
// render:
//   brightness  spectral centroid / first-note f0 (register-independent)
//   strike      HF (> 2.5 kHz) vs body (100–2500 Hz) energy in the 15 ms
//               after the first onset, dB
//   ring        time for the 10 ms RMS envelope to fall 30 dB after its max, s
// Two cues "differ" on a dimension when:
//   contour  (round 2, binding per S1) the OPENING interval differs: its sign
//            differs, or the same sign and |Δ| ≥ 3 semitones; a single note is
//            a flat (0) opening. Round 1 (`differsRound1`) also counted note
//            count and later intervals.
//   rhythm   onset count differs, or any aligned IOI differs by ≥ 100 ms
//   timbre   brightness ratio ≥ 1.35, strike Δ ≥ 6 dB, or ring ratio ≥ 1.6
//   register first-note Δ ≥ 7 semitones (reported, never counted)
// S1's rule: every signal-stratum sound differs from every other audible
// voice in ≥ 2 of contour, rhythm and timbre. `sameOpening` flags an
// identical opening interval on the same pitch class ("it quotes the call").

// Note name (A4, C#5, …) → semitones from A4.
export function semitonesFromA4(name) {
    const m = /^([A-G])(#?)(-?\d)$/.exec(name);
    if (!m) throw new Error(`note ${name}`);
    return { C: -9, D: -7, E: -5, F: -4, G: -2, A: 0, B: 2 }[m[1]] + (m[2] ? 1 : 0) + (Number(m[3]) - 4) * 12;
}

// render: { L, R, sampleRate, metrics } where metrics is analyze().metrics
// (onsets, spectralCentroidHz, stereo, loudness, peak). notes: [[ms, name], …];
// several notes at one ms are a chord whose first entry is the melody.
export function cueFeatures({ label, notes }, { L, R, sampleRate: fs, metrics }) {
    const mid = new Float32Array(L.length);
    for (let i = 0; i < L.length; i++) mid[i] = (L[i] + R[i]) / 2;
    const t0 = metrics.onsets.times[0] ?? 0.5;
    const i0 = Math.max(0, Math.floor((t0 - 0.004) * fs));
    const i1 = i0 + Math.floor(0.019 * fs);
    let lp = 0;
    let lp2 = 0;
    let hi = 0;
    let body = 0;
    const a = Math.exp(-2 * Math.PI * 2500 / fs);
    const b = Math.exp(-2 * Math.PI * 100 / fs);
    for (let i = i0; i < i1 && i < mid.length; i++) {
        lp = (1 - a) * mid[i] + a * lp;
        lp2 = (1 - b) * mid[i] + b * lp2;
        const h = mid[i] - lp;
        const bd = lp - lp2;
        hi += h * h;
        body += bd * bd;
    }
    const strike = 10 * Math.log10((hi + 1e-20) / (body + 1e-20));
    const w = Math.floor(0.01 * fs);
    const env = [];
    for (let i = 0; i + w < mid.length; i += w) {
        let s = 0;
        for (let k = i; k < i + w; k++) s += mid[k] * mid[k];
        env.push(Math.sqrt(s / w));
    }
    let mi = 0;
    env.forEach((v, i) => { if (v > env[mi]) mi = i; });
    let last = mi;
    for (let i = mi; i < env.length; i++) if (env[i] > env[mi] * 0.0316) last = i;
    const onsetsMs = [...new Set(notes.map(n => n[0]))];
    const melody = onsetsMs.map(ms => notes.find(n => n[0] === ms)[1]);
    const semis = melody.map(semitonesFromA4);
    const intervals = semis.slice(1).map((s, i) => s - semis[i]);
    const centroid = metrics.spectralCentroidHz.mean;
    return {
        label, onsetsMs, melody, intervals, first: semis[0],
        centroid, bright: centroid / (440 * Math.pow(2, semis[0] / 12)), strike, ring: (last - mi) * 0.01,
        sideMidDb: metrics.stereo?.sideToMidDB ?? null,
        momentaryMaxLufs: metrics.loudness.momentaryMaxLUFS, truePeakDbtp: metrics.peak.truePeakDBTP,
        measured: (metrics.onsets.pitches || []).map(p => p.note).join(' '),
    };
}

const ratio = (x, y) => Math.max(x, y) / Math.max(1e-9, Math.min(x, y));
const opening = f => f.intervals[0] ?? 0;

function rhythmDiffers(a, b) {
    const ioiA = a.onsetsMs.slice(1).map((x, i) => x - a.onsetsMs[i]);
    const ioiB = b.onsetsMs.slice(1).map((x, i) => x - b.onsetsMs[i]);
    return a.onsetsMs.length !== b.onsetsMs.length || ioiA.some((x, i) => Math.abs(x - ioiB[i]) >= 100);
}

function timbreDiffers(a, b) {
    return ratio(a.bright, b.bright) >= 1.35 || Math.abs(a.strike - b.strike) >= 6 || ratio(a.ring, b.ring) >= 1.6;
}

export function differs(a, b) {
    const oa = opening(a);
    const ob = opening(b);
    const contour = Math.sign(oa) !== Math.sign(ob) || Math.abs(oa - ob) >= 3;
    const rhythm = rhythmDiffers(a, b);
    const timbre = timbreDiffers(a, b);
    const register = Math.abs(a.first - b.first) >= 7;
    const sameOpening = a.intervals.length > 0 && b.intervals.length > 0 && oa === ob && (((a.first - b.first) % 12) + 12) % 12 === 0;
    return { contour, rhythm, timbre, register, sameOpening, n: [contour, rhythm, timbre].filter(Boolean).length };
}

export function differsRound1(a, b) {
    const contour = a.intervals.length !== b.intervals.length
        || a.intervals.some((x, i) => Math.sign(x) !== Math.sign(b.intervals[i]) || Math.abs(x - b.intervals[i]) >= 3);
    const rhythm = rhythmDiffers(a, b);
    const timbre = timbreDiffers(a, b);
    const register = Math.abs(a.first - b.first) >= 7;
    return { contour, rhythm, timbre, register, n: [contour, rhythm, timbre].filter(Boolean).length };
}

// Every signal cue against every other voice. → [{ signal, other, n, dims, sameOpening, pass }]
export function discriminationMatrix(signals, others, { rule = differs } = {}) {
    const rows = [];
    for (const s of signals) {
        for (const o of [...signals, ...others]) {
            if (o === s) continue;
            const d = rule(s, o);
            rows.push({
                signal: s.label, other: o.label, n: d.n, sameOpening: Boolean(d.sameOpening),
                dims: ['contour', 'rhythm', 'timbre'].filter(k => d[k]), pass: d.n >= 2,
            });
        }
    }
    return rows;
}
