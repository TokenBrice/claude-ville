// Audio analysis for the listening harness: WAV I/O, ITU-R BS.1770-4 loudness
// (K-weighted, gated), EBU R128 short-term / momentary / LRA, sample + 4x
// true peak, crest, octave-band RMS, spectral centroid, stereo image, onsets,
// onset pitch estimates, chroma, marker-window cue margins, voice counts, and
// the log-frequency spectrogram matrix the plotter draws. Pure Node, no deps.
import fs from 'node:fs';

// ------------------------------------------------------------------ WAV ----
// 32-bit float stereo WAV (WAVE_FORMAT_IEEE_FLOAT). Cue tails and the
// silence between Signals cues reach -45…-70 LUFS, where 16-bit quantisation
// noise (~-101 dBFS) would sit inside them and bias spectral metrics; float
// keeps renders exact.
export function writeWavFloat(file, L, R, sampleRate) {
    const n = L.length;
    const buf = Buffer.alloc(58 + n * 8);
    buf.write('RIFF', 0); buf.writeUInt32LE(50 + n * 8, 4); buf.write('WAVE', 8);
    buf.write('fmt ', 12); buf.writeUInt32LE(18, 16); buf.writeUInt16LE(3, 20);
    buf.writeUInt16LE(2, 22); buf.writeUInt32LE(sampleRate, 24);
    buf.writeUInt32LE(sampleRate * 8, 28); buf.writeUInt16LE(8, 32); buf.writeUInt16LE(32, 34);
    buf.writeUInt16LE(0, 36);
    buf.write('fact', 38); buf.writeUInt32LE(4, 42); buf.writeUInt32LE(n, 46);
    buf.write('data', 50); buf.writeUInt32LE(n * 8, 54);
    let o = 58;
    for (let i = 0; i < n; i++) { buf.writeFloatLE(L[i], o); buf.writeFloatLE(R[i], o + 4); o += 8; }
    fs.writeFileSync(file, buf);
}

export function readWav(file) {
    const b = fs.readFileSync(file);
    if (b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') throw new Error(`${file}: not a RIFF/WAVE file`);
    let off = 12, fmt = null, data = null;
    while (off + 8 <= b.length) {
        const id = b.toString('ascii', off, off + 4);
        const size = b.readUInt32LE(off + 4);
        if (id === 'fmt ') {
            fmt = {
                format: b.readUInt16LE(off + 8), channels: b.readUInt16LE(off + 10),
                sampleRate: b.readUInt32LE(off + 12), bits: b.readUInt16LE(off + 22),
            };
            if (fmt.format === 0xFFFE) fmt.format = b.readUInt16LE(off + 32);
        } else if (id === 'data') {
            data = b.subarray(off + 8, off + 8 + Math.min(size, b.length - off - 8));
        }
        off += 8 + size + (size & 1);
    }
    if (!fmt || !data) throw new Error(`${file}: missing fmt/data chunk`);
    const { channels, bits, format } = fmt;
    const bytes = bits / 8;
    const frames = Math.floor(data.length / (bytes * channels));
    const out = Array.from({ length: channels }, () => new Float32Array(frames));
    for (let i = 0; i < frames; i++) {
        for (let c = 0; c < channels; c++) {
            const p = (i * channels + c) * bytes;
            let v;
            if (format === 3 && bits === 32) v = data.readFloatLE(p);
            else if (format === 3 && bits === 64) v = data.readDoubleLE(p);
            else if (bits === 16) v = data.readInt16LE(p) / 32768;
            else if (bits === 24) v = data.readIntLE(p, 3) / 8388608;
            else if (bits === 32) v = data.readInt32LE(p) / 2147483648;
            else if (bits === 8) v = (data[p] - 128) / 128;
            else throw new Error(`${file}: unsupported ${bits}-bit format ${format}`);
            out[c][i] = v;
        }
    }
    const L = out[0];
    const R = out[1] || out[0];
    return { sampleRate: fmt.sampleRate, L, R, channels };
}

// ------------------------------------------------------------------ FFT ----
const fftCache = new Map();
function fftPlan(n) {
    let plan = fftCache.get(n);
    if (plan) return plan;
    const levels = Math.log2(n);
    const rev = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
        let r = 0;
        for (let b = 0; b < levels; b++) r |= ((i >> b) & 1) << (levels - 1 - b);
        rev[i] = r;
    }
    const cos = new Float64Array(n / 2), sin = new Float64Array(n / 2);
    for (let i = 0; i < n / 2; i++) { cos[i] = Math.cos(2 * Math.PI * i / n); sin[i] = -Math.sin(2 * Math.PI * i / n); }
    const hann = new Float64Array(n);
    for (let i = 0; i < n; i++) hann[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / n);
    let wsum = 0, w2sum = 0;
    for (let i = 0; i < n; i++) { wsum += hann[i]; w2sum += hann[i] * hann[i]; }
    plan = { n, rev, cos, sin, hann, wsum, w2sum, re: new Float64Array(n), im: new Float64Array(n), mag2: new Float64Array(n / 2 + 1) };
    fftCache.set(n, plan);
    return plan;
}

// Windowed power spectrum |X_k|^2 (k = 0..n/2) of x[start .. start+n) (zero padded).
function powerSpectrum(x, start, plan) {
    const { n, rev, cos, sin, hann, re, im, mag2 } = plan;
    for (let i = 0; i < n; i++) {
        const j = start + i;
        re[rev[i]] = (j >= 0 && j < x.length ? x[j] : 0) * hann[i];
        im[rev[i]] = 0;
    }
    for (let size = 2; size <= n; size <<= 1) {
        const half = size >> 1, step = n / size;
        for (let i = 0; i < n; i += size) {
            for (let j = 0, k = 0; j < half; j++, k += step) {
                const a = i + j, b = a + half;
                const tr = re[b] * cos[k] - im[b] * sin[k];
                const ti = re[b] * sin[k] + im[b] * cos[k];
                re[b] = re[a] - tr; im[b] = im[a] - ti;
                re[a] += tr; im[a] += ti;
            }
        }
    }
    for (let k = 0; k <= n / 2; k++) mag2[k] = re[k] * re[k] + im[k] * im[k];
    return mag2;
}

const db = (v, floor = -200) => (v > 0 ? Math.max(floor, 10 * Math.log10(v)) : floor);
const NOTE_NAMES = ['A', 'A#', 'B', 'C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#'];
export function noteName(hz) {
    if (!(hz > 0)) return null;
    const semis = 12 * Math.log2(hz / 440);
    const r = Math.round(semis);
    const cents = Math.round((semis - r) * 100);
    const idx = ((r % 12) + 12) % 12;
    const octave = 4 + Math.floor((r + 9) / 12);
    return { name: `${NOTE_NAMES[idx]}${octave}`, cents };
}

// ------------------------------------------------------------- biquads ----
function biquad(x, [b0, b1, b2, a1, a2]) {
    const y = new Float64Array(x.length);
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let i = 0; i < x.length; i++) {
        const v = b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
        x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v;
    }
    return y;
}

// BS.1770-4 K-weighting at any sample rate (same design pyloudnorm uses).
export function kWeightCoeffs(fs) {
    let K = Math.tan(Math.PI * 1681.974450955533 / fs);
    const Q1 = 0.7071752369554196;
    const Vh = Math.pow(10, 3.999843853973347 / 20);
    const Vb = Math.pow(Vh, 0.4996667741545416);
    let a0 = 1 + K / Q1 + K * K;
    const shelf = [(Vh + Vb * K / Q1 + K * K) / a0, 2 * (K * K - Vh) / a0, (Vh - Vb * K / Q1 + K * K) / a0,
        2 * (K * K - 1) / a0, (1 - K / Q1 + K * K) / a0];
    K = Math.tan(Math.PI * 38.13547087602444 / fs);
    const Q2 = 0.5003270373238773;
    a0 = 1 + K / Q2 + K * K;
    const hp = [1, -2, 1, 2 * (K * K - 1) / a0, (1 - K / Q2 + K * K) / a0];
    return { shelf, hp };
}

// ------------------------------------------------------------ loudness ----
export function loudness(L, R, fs) {
    const { shelf, hp } = kWeightCoeffs(fs);
    const kl = biquad(biquad(L, shelf), hp);
    const kr = biquad(biquad(R, shelf), hp);
    const hop = Math.round(fs * 0.1);
    const n = L.length;
    // prefix sums of per-sample K-weighted power (L + R)
    const pre = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) pre[i + 1] = pre[i] + kl[i] * kl[i] + kr[i] * kr[i];
    const win = (len) => {
        const out = [];
        const w = Math.round(fs * len);
        for (let s = 0; s + w <= n; s += hop) out.push({ t: (s + w) / fs, z: (pre[s + w] - pre[s]) / w });
        if (!out.length && n > 0) out.push({ t: n / fs, z: pre[n] / n });
        return out;
    };
    const toL = z => (z > 0 ? -0.691 + 10 * Math.log10(z) : -Infinity);
    const momentary = win(0.4);
    const shortTerm = win(3);

    const absGated = momentary.filter(b => toL(b.z) > -70);
    let integrated = -Infinity;
    if (absGated.length) {
        const meanAbs = absGated.reduce((s, b) => s + b.z, 0) / absGated.length;
        const rel = toL(meanAbs) - 10;
        const gated = absGated.filter(b => toL(b.z) > rel);
        if (gated.length) integrated = toL(gated.reduce((s, b) => s + b.z, 0) / gated.length);
    }
    // EBU Tech 3342 loudness range from short-term values.
    let lra = null;
    const stAbs = shortTerm.filter(b => toL(b.z) > -70);
    if (stAbs.length > 1) {
        const meanSt = stAbs.reduce((s, b) => s + b.z, 0) / stAbs.length;
        const relSt = toL(meanSt) - 20;
        const vals = stAbs.map(b => toL(b.z)).filter(v => v > relSt).sort((a, b) => a - b);
        if (vals.length > 1) {
            const pct = p => vals[Math.min(vals.length - 1, Math.max(0, Math.round(p * (vals.length - 1))))];
            lra = pct(0.95) - pct(0.10);
        }
    }
    const maxOf = arr => arr.reduce((m, b) => Math.max(m, toL(b.z)), -Infinity);
    return {
        integrated,
        momentaryMax: maxOf(momentary),
        shortTermMax: maxOf(shortTerm),
        lra,
        momentaryCurve: momentary.map(b => [b.t, toL(b.z)]),
        shortTermCurve: shortTerm.map(b => [b.t, toL(b.z)]),
        kPower: pre,
    };
}

// ---------------------------------------------------------------- peaks ----
const TP_TAPS = 16; // per side
const tpKernel = (() => {
    const phases = [];
    for (let p = 1; p < 4; p++) {
        const frac = p / 4;
        const taps = [];
        for (let k = -TP_TAPS + 1; k <= TP_TAPS; k++) {
            const x = k - frac; // sample offset relative to interpolation point
            const sinc = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
            const w = 0.5 + 0.5 * Math.cos(Math.PI * x / (TP_TAPS + 1));
            taps.push([k, sinc * w]);
        }
        phases.push(taps);
    }
    return phases;
})();

export function peaks(x) {
    let sp = 0;
    for (let i = 0; i < x.length; i++) { const a = Math.abs(x[i]); if (a > sp) sp = a; }
    let tp = sp;
    const thresh = sp * 0.5;
    for (let i = 0; i < x.length - 1; i++) {
        if (Math.abs(x[i]) < thresh && Math.abs(x[i + 1]) < thresh) continue;
        for (const taps of tpKernel) {
            let v = 0;
            for (const [k, w] of taps) { const j = i + k; if (j >= 0 && j < x.length) v += x[j] * w; }
            const a = Math.abs(v);
            if (a > tp) tp = a;
        }
    }
    return { sample: sp, truePeak: tp };
}

// ----------------------------------------------------------- spectrum ----
const OCTAVES = [63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];

function welch(mid, fs, n = 8192) {
    const plan = fftPlan(n);
    const acc = new Float64Array(n / 2 + 1);
    let frames = 0;
    for (let s = 0; s + n <= Math.max(n, mid.length); s += n / 2) {
        const p = powerSpectrum(mid, s, plan);
        for (let k = 0; k <= n / 2; k++) acc[k] += p[k];
        frames++;
    }
    // Mean-square per bin, Parseval-normalised: full-scale sine → -3.01 dB total.
    for (let k = 0; k <= n / 2; k++) acc[k] = (acc[k] / frames) * (k === 0 || k === n / 2 ? 1 : 2) / (n * plan.w2sum);
    return { psd: acc, binHz: fs / n };
}

function octaveBands({ psd, binHz }, fs) {
    const out = {};
    for (const fc of OCTAVES) {
        const lo = fc / Math.SQRT2, hi = Math.min(fc * Math.SQRT2, fs / 2);
        let ms = 0;
        for (let k = Math.ceil(lo / binHz); k < hi / binHz && k < psd.length; k++) ms += psd[k];
        out[fc >= 1000 ? `${fc / 1000}k` : String(fc)] = Number(db(ms).toFixed(1));
    }
    return out;
}

function chroma({ psd, binHz }) {
    const c = new Float64Array(12);
    for (let k = Math.ceil(80 / binHz); k < 4200 / binHz && k < psd.length; k++) {
        const semis = 12 * Math.log2((k * binHz) / 440);
        const idx = ((Math.round(semis) % 12) + 12) % 12;
        c[idx] += psd[k];
    }
    const max = Math.max(...c) || 1;
    const named = {};
    NOTE_NAMES.forEach((name, i) => { named[name] = Number((c[i] / max).toFixed(3)); });
    const top = NOTE_NAMES.map((name, i) => [name, c[i]]).sort((a, b) => b[1] - a[1]).slice(0, 5).map(e => e[0]);
    return { profile: named, top };
}

function centroidStats(mid, fs) {
    const n = 2048, hop = 1024, plan = fftPlan(n);
    const vals = [];
    const lo = Math.ceil(20 / (fs / n));
    for (let s = 0; s + n <= mid.length; s += hop) {
        let ms = 0;
        for (let i = s; i < s + n; i++) ms += mid[i] * mid[i];
        if (db(ms / n) < -70) continue;
        const p = powerSpectrum(mid, s, plan);
        // Ignore bins more than 80 dB under the frame's strongest bin, so a
        // quantisation/noise floor cannot drag the centroid of a quiet tail.
        let peak = 0;
        for (let k = lo; k <= n / 2; k++) if (p[k] > peak) peak = p[k];
        const floor = peak * 1e-8;
        let num = 0, den = 0;
        for (let k = lo; k <= n / 2; k++) { if (p[k] < floor) continue; const m = Math.sqrt(p[k]); num += m * k * fs / n; den += m; }
        if (den > 0) vals.push(num / den);
    }
    if (!vals.length) return { mean: null, sd: null, activeFrames: 0 };
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    const sd = Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length);
    return { mean, sd, activeFrames: vals.length, activeSeconds: vals.length * hop / fs };
}

// ------------------------------------------------------------- onsets ----
// Band-rise onset detector: 7 broad bands (each >= 12 FFT bins so stationary
// noise beds fluctuate by ~1 dB), 2048-point Hann frames every 256 samples.
// A frame's rise in a band is its level minus the loudest level that band
// had one full window earlier (frames t-12..t-8, entirely before the new
// attack entered the window). Onset = local max of the strongest band rise,
// > 7 dB, band level > -95 dBFS, >= 60 ms after the previous onset.
const ONSET_EDGES = [30, 300, 600, 1200, 2400, 4800, 9600, 16000];
export function onsets(mid, fs) {
    const n = 2048, hop = 256, plan = fftPlan(n);
    const binHz = fs / n;
    const bands = [];
    for (let i = 0; i < ONSET_EDGES.length - 1; i++) {
        const a = Math.max(1, Math.round(ONSET_EDGES[i] / binHz));
        const b = Math.min(n / 2, Math.round(Math.min(ONSET_EDGES[i + 1], fs / 2 - binHz) / binHz));
        if (b - a >= 4) bands.push([a, b]);
    }
    const norm = 2 / (plan.w2sum * n);
    const levels = [];
    for (let s = -n / 2; s + n / 2 <= mid.length; s += hop) {
        const p = powerSpectrum(mid, s, plan);
        levels.push(bands.map(([a, b]) => { let e = 0; for (let k = a; k < b; k++) e += p[k]; return db(e * norm, -140); }));
    }
    const D = new Float32Array(levels.length);
    for (let t = 12; t < levels.length; t++) {
        let best = 0;
        for (let bi = 0; bi < bands.length; bi++) {
            const cur = levels[t][bi];
            if (cur < -95) continue;
            let ref = -140;
            for (let k = t - 12; k <= t - 8; k++) ref = Math.max(ref, levels[k][bi]);
            const rise = cur - Math.max(ref, -110);
            if (rise > best) best = rise;
        }
        D[t] = best;
    }
    const half = Math.round(0.03 * fs / hop);
    const minGap = Math.round(0.06 * fs / hop);
    const times = [];
    let last = -1e9;
    for (let t = 1; t < D.length; t++) {
        if (D[t] <= 7 || t - last < minGap) continue;
        let isMax = true;
        for (let k = Math.max(0, t - half); k <= Math.min(D.length - 1, t + half); k++) if (D[k] > D[t] || (D[k] === D[t] && k < t)) { isMax = false; break; }
        if (!isMax) continue;
        // report the attack, ~half a window before the frame centre peak
        times.push(Math.max(0, (t * hop) / fs - 0.01));
        last = t;
    }
    return times;
}

// Dominant pitch shortly after each onset (strongest peak 60-5000 Hz,
// parabolic interpolation on a 4096-point frame starting at the onset).
function onsetPitches(mid, fs, times, limit = 240) {
    const n = 4096, plan = fftPlan(n), binHz = fs / n;
    const out = [];
    for (const t of times.slice(0, limit)) {
        const start = Math.round(t * fs);
        const p = powerSpectrum(mid, start, plan);
        let best = -1, bestV = 0;
        for (let k = Math.ceil(60 / binHz); k < 5000 / binHz; k++) if (p[k] > bestV && p[k] >= p[k - 1] && p[k] >= p[k + 1]) { bestV = p[k]; best = k; }
        if (best < 1) continue;
        const a = Math.log(p[best - 1] + 1e-30), b = Math.log(p[best] + 1e-30), c = Math.log(p[best + 1] + 1e-30);
        const d = (a - c) / (2 * (a - 2 * b + c) || 1);
        const hz = (best + (Number.isFinite(d) ? d : 0)) * binHz;
        const note = noteName(hz);
        out.push({ t: Number(t.toFixed(3)), hz: Number(hz.toFixed(1)), note: note?.name, cents: note?.cents, db: Number(db(bestV * 4 / (plan.wsum * plan.wsum)).toFixed(1)) });
    }
    return out;
}

// ---------------------------------------------------------- spectrogram ----
// Log-frequency dB matrix (rows top=fmax → bottom=fmin), max-pooled per
// pixel column so short chirps survive long renders. Values are dBFS per bin
// where a full-scale sine's peak bin reads 0 dB.
export function spectrogram(mid, fs, { width, height = 420, fmin = 30, fmax = 20000 } = {}) {
    const dur = mid.length / fs;
    const n = dur < 20 ? 2048 : 4096;
    const plan = fftPlan(n);
    const binHz = fs / n;
    fmax = Math.min(fmax, fs / 2);
    const hop = Math.max(64, Math.min(n / 4, Math.floor(mid.length / (width * 2)) || 64));
    const cols = Array.from({ length: width }, () => new Float32Array(n / 2 + 1).fill(0));
    const scale = 4 / (plan.wsum * plan.wsum);
    for (let s = -n / 2; s < mid.length - n / 2; s += hop) {
        const center = s + n / 2;
        const col = Math.min(width - 1, Math.max(0, Math.floor(center / mid.length * width)));
        const p = powerSpectrum(mid, s, plan);
        const c = cols[col];
        for (let k = 0; k <= n / 2; k++) { const v = p[k] * scale; if (v > c[k]) c[k] = v; }
    }
    const rowF = [];
    for (let y = 0; y <= height; y++) rowF.push(fmin * Math.pow(fmax / fmin, 1 - y / height));
    const matrix = new Float32Array(width * height);
    for (let x = 0; x < width; x++) {
        const c = cols[x];
        for (let y = 0; y < height; y++) {
            const fHi = rowF[y], fLo = rowF[y + 1];
            const kLo = fLo / binHz, kHi = fHi / binHz;
            let v;
            if (Math.floor(kHi) - Math.ceil(kLo) >= 1) {
                v = 0;
                for (let k = Math.ceil(kLo); k <= Math.floor(kHi) && k < c.length; k++) if (c[k] > v) v = c[k];
            } else {
                const kc = (kLo + kHi) / 2, k0 = Math.floor(kc), fr = kc - k0;
                v = (c[k0] || 0) * (1 - fr) + (c[k0 + 1] || 0) * fr;
            }
            matrix[y * width + x] = db(v, -160);
        }
    }
    return { matrix, width, height, fmin, fmax, fftSize: n, hop };
}

function envelopes(L, R, width) {
    const out = { L: new Float32Array(width), R: new Float32Array(width) };
    const n = L.length;
    for (let x = 0; x < width; x++) {
        const a = Math.floor(x * n / width), b = Math.max(a + 1, Math.floor((x + 1) * n / width));
        let pl = 0, pr = 0;
        for (let i = a; i < b && i < n; i++) { const l = Math.abs(L[i]), r = Math.abs(R[i]); if (l > pl) pl = l; if (r > pr) pr = r; }
        out.L[x] = pl > 0 ? 20 * Math.log10(pl) : -160;
        out.R[x] = pr > 0 ? 20 * Math.log10(pr) : -160;
    }
    return out;
}

// ------------------------------------------------------------- voices ----
function voiceStats(log, start, end) {
    if (!Array.isArray(log) || !log.length) return null;
    const inWin = log.filter(v => v.s < end && (v.e === null || v.e > start));
    const starts = inWin.filter(v => v.s >= start);
    const events = [];
    for (const v of inWin) {
        events.push([Math.max(v.s, start), 1]);
        events.push([Math.min(v.e ?? Infinity, end), -1]);
    }
    events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    let cur = 0, max = 0;
    for (const [, d] of events) { cur += d; if (cur > max) max = cur; }
    const minutes = Math.max(1e-9, (end - start) / 60);
    const byKind = {};
    for (const v of starts) byKind[v.k] = (byKind[v.k] || 0) + 1;
    return {
        maxConcurrentSources: max,
        sourceStartsPerMinute: Number((starts.length / minutes).toFixed(1)),
        startsByKind: byKind,
        continuousSources: inWin.filter(v => v.e === null).length,
    };
}

// --------------------------------------------------------- marker windows ----
// Cue-vs-bed margin: max momentary loudness in [t, t+2.5 s] minus the energy
// mean momentary loudness over [t-3 s, t).
function markerMetrics(markers, lou, fs, duration) {
    const mom = lou.momentaryCurve;
    const out = [];
    for (const m of markers || []) {
        if (m.kind !== 'event' || !(m.t >= 0) || m.t > duration) continue;
        let cueMax = -Infinity, preE = 0, preN = 0;
        for (const [t, v] of mom) {
            const center = t - 0.2;
            if (center >= m.t && center <= m.t + 2.5) cueMax = Math.max(cueMax, v);
            if (center >= m.t - 3 && center < m.t && Number.isFinite(v)) { preE += Math.pow(10, (v + 0.691) / 10); preN++; }
        }
        const pre = preN ? -0.691 + 10 * Math.log10(preE / preN) : null;
        out.push({
            label: m.label, t: Number(m.t.toFixed(3)),
            cueMomentaryMaxLUFS: Number.isFinite(cueMax) ? Number(cueMax.toFixed(1)) : null,
            preMomentaryLUFS: pre != null && Number.isFinite(pre) ? Number(pre.toFixed(1)) : null,
            marginLU: pre != null && Number.isFinite(pre) && Number.isFinite(cueMax) ? Number((cueMax - pre).toFixed(1)) : null,
        });
    }
    return out;
}

// ---------------------------------------------------------------- main ----
const r1 = v => (v == null || !Number.isFinite(v) ? null : Number(v.toFixed(1)));
const r2 = v => (v == null || !Number.isFinite(v) ? null : Number(v.toFixed(2)));

export function analyze(L, R, fs, { markers = [], voiceLog = null, voiceWindow = null, plotWidth = null } = {}) {
    const n = L.length;
    const duration = n / fs;
    const mid = new Float32Array(n);
    let sumL = 0, sumR = 0, sumLR = 0, sumM = 0, sumS = 0, dcL = 0, dcR = 0;
    for (let i = 0; i < n; i++) {
        const l = L[i], r = R[i];
        mid[i] = (l + r) / 2;
        sumL += l * l; sumR += r * r; sumLR += l * r;
        const m = (l + r) / 2, s = (l - r) / 2;
        sumM += m * m; sumS += s * s; dcL += l; dcR += r;
    }
    const lou = loudness(L, R, fs);
    const pl = peaks(L), pr = peaks(R);
    const samplePeak = Math.max(pl.sample, pr.sample);
    const truePeak = Math.max(pl.truePeak, pr.truePeak);
    const rms = Math.sqrt((sumL + sumR) / (2 * Math.max(1, n)));
    const w = welch(mid, fs);
    const cen = centroidStats(mid, fs);
    const onsetTimes = onsets(mid, fs);
    let clipped = 0;
    for (let i = 0; i < n; i++) if (Math.abs(L[i]) >= 0.999 || Math.abs(R[i]) >= 0.999) clipped++;
    const width = plotWidth || Math.max(1000, Math.min(2400, Math.round(duration * 160)));

    const metrics = {
        durationSeconds: r2(duration),
        sampleRate: fs,
        loudness: {
            integratedLUFS: r1(lou.integrated),
            shortTermMaxLUFS: r1(lou.shortTermMax),
            momentaryMaxLUFS: r1(lou.momentaryMax),
            loudnessRangeLU: r1(lou.lra),
        },
        peak: {
            samplePeakDBFS: r1(20 * Math.log10(samplePeak || 1e-12)),
            truePeakDBTP: r1(20 * Math.log10(truePeak || 1e-12)),
            clippedSamples: clipped,
        },
        rmsDBFS: r1(20 * Math.log10(rms || 1e-12)),
        crestFactorDB: r1(20 * Math.log10((samplePeak || 1e-12) / (rms || 1e-12))),
        octaveBandRmsDBFS: octaveBands(w, fs),
        spectralCentroidHz: { mean: r1(cen.mean), sd: r1(cen.sd), activeSeconds: r1(cen.activeSeconds ?? 0) },
        stereo: {
            correlation: sumL > 0 && sumR > 0 ? r2(sumLR / Math.sqrt(sumL * sumR)) : null,
            sideToMidDB: sumM > 0 ? r1(Math.max(-120, 10 * Math.log10((sumS || 1e-30) / sumM))) : null,
            balanceLminusRDB: sumL > 0 && sumR > 0 ? r1(10 * Math.log10(sumL / sumR)) : null,
        },
        dcOffset: { L: Number((dcL / Math.max(1, n)).toExponential(2)), R: Number((dcR / Math.max(1, n)).toExponential(2)) },
        onsets: {
            count: onsetTimes.length,
            perMinute: r1(onsetTimes.length / Math.max(1e-9, duration / 60)),
            times: onsetTimes.slice(0, 500).map(t => Number(t.toFixed(3))),
            pitches: onsetPitches(mid, fs, onsetTimes),
        },
        chroma: chroma(w),
        markerMetrics: markerMetrics(markers, lou, fs, duration),
        voices: voiceLog ? voiceStats(voiceLog, voiceWindow?.start ?? 0, voiceWindow?.end ?? duration) : null,
    };
    const plot = {
        spec: spectrogram(mid, fs, { width }),
        env: envelopes(L, R, width),
        momentary: lou.momentaryCurve,
        shortTerm: lou.shortTermCurve,
        onsets: onsetTimes,
        duration,
    };
    return { metrics, plot };
}
