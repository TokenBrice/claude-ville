// SCN long-session metrics for a stereo render (ported from the SCN notes,
// scn-snippets/session-metrics.mjs): silence ratio, tonal repetition
// (chroma-sequence self-similarity), melodic n-gram repetition, loudness per
// minute, music on-time and the Town band pieces heard, cue density. Pure
// Node; used by the probe's --soak.
import fs from 'node:fs';
import zlib from 'node:zlib';
import { loudness, onsets } from '../lib/analyze.mjs';

// ---- radix-2 FFT (power spectrum of a Hann-windowed frame) ----
function makeFft(n) {
    const rev = new Uint32Array(n);
    const bits = Math.log2(n);
    for (let i = 0; i < n; i++) { let r = 0; for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b); rev[i] = r; }
    const cos = new Float64Array(n / 2), sin = new Float64Array(n / 2);
    for (let i = 0; i < n / 2; i++) { cos[i] = Math.cos(2 * Math.PI * i / n); sin[i] = -Math.sin(2 * Math.PI * i / n); }
    const win = new Float64Array(n);
    for (let i = 0; i < n; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / n);
    const re = new Float64Array(n), im = new Float64Array(n);
    return (x, start) => {
        for (let i = 0; i < n; i++) { const j = start + i; const v = j >= 0 && j < x.length ? x[j] : 0; re[rev[i]] = v * win[i]; im[rev[i]] = 0; }
        for (let size = 2; size <= n; size <<= 1) {
            const half = size >> 1, step = n / size;
            for (let s = 0; s < n; s += size) for (let k = 0; k < half; k++) {
                const c = cos[k * step], si = sin[k * step];
                const a = s + k, b = a + half;
                const tr = re[b] * c - im[b] * si, ti = re[b] * si + im[b] * c;
                re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
            }
        }
        const p = new Float64Array(n / 2);
        for (let k = 0; k < n / 2; k++) p[k] = re[k] * re[k] + im[k] * im[k];
        return p;
    };
}

// Tonal chroma per 0.5 s frame: only spectral peaks ≥ 12 dB above the local
// median (so broadband noise and the air's reverb tails contribute ~nothing).
function tonalChromaFrames(mid, fs) {
    const n = 8192, hop = Math.round(fs * 0.5), fft = makeFft(n), binHz = fs / n;
    const kmin = Math.ceil(80 / binHz), kmax = Math.floor(4200 / binHz);
    const pc = new Int8Array(n / 2).fill(-1);
    for (let k = kmin; k <= kmax; k++) pc[k] = ((Math.round(12 * Math.log2((k * binHz) / 440)) % 12) + 12 + 9) % 12; // 0 = C
    const frames = [];
    for (let s = 0; s + n <= mid.length; s += hop) {
        const p = fft(mid, s);
        const c = new Float64Array(12);
        let tonal = 0;
        for (let k = kmin + 8; k <= kmax - 8; k++) {
            if (!(p[k] > p[k - 1] && p[k] >= p[k + 1])) continue;
            const nb = [];
            for (let d = -8; d <= 8; d++) if (Math.abs(d) > 2) nb.push(p[k + d]);
            nb.sort((a, b) => a - b);
            const med = nb[nb.length >> 1] || 1e-30;
            if (p[k] < med * 16) continue; // 12 dB
            c[pc[k]] += p[k];
            tonal += p[k];
        }
        frames.push({ c, tonal });
    }
    return { frames, hopS: 0.5 };
}

function cos(a, b) {
    let ab = 0, aa = 0, bb = 0;
    for (let i = 0; i < a.length; i++) { ab += a[i] * b[i]; aa += a[i] * a[i]; bb += b[i] * b[i]; }
    return aa > 0 && bb > 0 ? ab / Math.sqrt(aa * bb) : 0;
}

// Windows of W s (hop H s) of the chroma sequence, each frame sqrt-compressed
// and L2-normalised, flattened. Similarity = best cosine over ±1 frame shift.
function repetition(rawFrames, hopS, { W = 10, H = 5, minLag = 30, thresh = 0.9 } = {}) {
    const fw = Math.round(W / hopS), fh = Math.round(H / hopS);
    // Remove stationary tones (drones, pads, a held note): subtract each pitch
    // class's running median over ±30 s, so only changing tonal material counts.
    const half = Math.round(30 / hopS);
    const frames = rawFrames.map((f, i) => {
        const lo = Math.max(0, i - half), hi = Math.min(rawFrames.length, i + half + 1);
        const c = new Float64Array(12);
        for (let k = 0; k < 12; k++) {
            const col = [];
            for (let j = lo; j < hi; j++) col.push(rawFrames[j].c[k]);
            col.sort((a, b) => a - b);
            c[k] = Math.max(0, f.c[k] - col[col.length >> 1]);
        }
        return { c, tonal: c.reduce((s, x) => s + x, 0) };
    });
    const norm = frames.map(f => { const v = Array.from(f.c, x => Math.sqrt(x)); const s = Math.hypot(...v); return s > 0 ? v.map(x => x / s) : v; });
    const tonalDb = frames.map(f => 10 * Math.log10(f.tonal + 1e-30));
    // A window is "tonal" when ≥ 40 % of its frames carry changing peaks within 40 dB of the render's p95.
    const sorted = [...tonalDb].sort((a, b) => a - b);
    const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? -300;
    const wins = [];
    for (let s = 0; s + fw <= frames.length; s += fh) {
        let active = 0;
        for (let i = s; i < s + fw; i++) if (tonalDb[i] > p95 - 40) active++;
        wins.push({ t: s * hopS, s, tonal: active / fw >= 0.4 });
    }
    // Per-frame unit vectors → the similarity of two fw-frame sequences is the
    // mean per-frame dot product over frames where both carry changing tones.
    const F = frames.length;
    const nz = norm.map(v => v.some(x => x > 0));
    const seqSim = (a, b) => {
        let dot = 0, n = 0;
        for (let k = 0; k < fw; k++) {
            const x = a + k, y = b + k;
            if (x >= F || y >= F || y < 0) continue;
            if (!nz[x] && !nz[y]) continue;
            n++;
            if (!nz[x] || !nz[y]) continue;
            const u = norm[x], v = norm[y];
            let d = 0;
            for (let c = 0; c < 12; c++) d += u[c] * v[c];
            dot += d;
        }
        return n >= fw * 0.4 ? dot / n : 0;
    };
    const N = wins.length;
    // Matrix (for the picture): window vs window, best over ±2.5 s alignment.
    const M = Array.from({ length: N }, () => new Float32Array(N));
    for (let i = 0; i < N; i++) {
        for (let j = 0; j < i; j++) {
            let best = 0;
            for (let sh = -5; sh <= 5; sh++) best = Math.max(best, seqSim(wins[i].s, wins[j].s + sh));
            M[i][j] = M[j][i] = best;
        }
        M[i][i] = 1;
    }
    // Déjà-heard: slide each tonal window over EVERY earlier frame position ≥ minLag back.
    const tonalWins = wins.map((w, i) => ({ ...w, i })).filter(w => w.tonal);
    let reheard = 0, firstRepeat = null;
    const lags = [];
    const minLagFrames = Math.round(minLag / hopS);
    for (const w of tonalWins) {
        let best = 0, bestLag = null;
        for (let j = 0; j + minLagFrames <= w.s; j++) {
            const sim = seqSim(w.s, j);
            if (sim > best) { best = sim; bestLag = (w.s - j) * hopS; }
        }
        if (best >= thresh) { reheard++; lags.push(bestLag); if (firstRepeat == null) firstRepeat = w.t; }
    }
    lags.sort((a, b) => a - b);
    return {
        windowS: W, hopS: H, minLagS: minLag, threshold: thresh,
        windows: N, tonalWindows: tonalWins.length,
        tonalPct: N ? Number((100 * tonalWins.length / N).toFixed(1)) : 0,
        dejaHeardPct: tonalWins.length ? Number((100 * reheard / tonalWins.length).toFixed(1)) : 0,
        firstRepeatAtS: firstRepeat,
        medianRepeatLagS: lags.length ? lags[lags.length >> 1] : null,
        matrix: M, winTonal: wins.map(w => w.tonal),
    };
}

// Melodic n-grams: onset pitch classes (+ quantised IOI) re-heard ≥ 20 s later.
function ngramRepetition(mid, fs, times, { n = 4, minLag = 20 } = {}) {
    const N = 4096, fft = makeFft(N), binHz = fs / N;
    const notes = [];
    for (const t of times) {
        const p = fft(mid, Math.round(t * fs));
        let bk = -1, bv = 0;
        for (let k = Math.ceil(60 / binHz); k < Math.floor(5000 / binHz); k++) if (p[k] > bv) { bv = p[k]; bk = k; }
        if (bk < 0) continue;
        notes.push({ t, midi: Math.round(69 + 12 * Math.log2((bk * binHz) / 440)) });
    }
    const seen = new Map();
    let total = 0, rep = 0;
    for (let i = 0; i + n <= notes.length; i++) {
        const g = notes.slice(i, i + n);
        if (g[n - 1].t - g[0].t > 4) continue; // phrase-scale grams only
        const key = g.map((x, k) => `${x.midi}${k ? ':' + Math.round((x.t - g[k - 1].t) * 8) : ''}`).join(' ');
        total++;
        const prev = seen.get(key);
        if (prev != null && g[0].t - prev >= minLag) rep++;
        if (prev == null) seen.set(key, g[0].t);
    }
    return { n, grams: total, reheardPct: total ? Number((100 * rep / total).toFixed(1)) : 0, distinct: seen.size };
}

export function sessionMetrics(L, R, fs, { state = [], timeline = [] } = {}) {
    const n = L.length, dur = n / fs;
    const mid = new Float32Array(n);
    for (let i = 0; i < n; i++) mid[i] = (L[i] + R[i]) / 2;
    const lou = loudness(L, R, fs);
    const mom = lou.momentaryCurve.map(([, v]) => v);
    const pct = f => Number((100 * mom.filter(f).length / Math.max(1, mom.length)).toFixed(1));
    // longest run below -60 LUFS momentary (100 ms hop)
    let run = 0, longest = 0;
    for (const v of mom) { if (!(v > -60)) { run++; longest = Math.max(longest, run); } else run = 0; }
    const st1 = [];
    for (let s = 1; s <= Math.floor(dur); s++) {
        const idx = Math.min(lou.shortTermCurve.length - 1, Math.max(0, Math.round((s - 3) * 10)));
        const v = lou.shortTermCurve[idx]?.[1];
        st1.push(Number.isFinite(v) ? Number(v.toFixed(1)) : null);
    }
    const perMinute = [];
    const onsetTimes = onsets(mid, fs);
    const cueEvents = timeline.filter(e => e.type === 'audio:cue-played');
    for (let m = 0; m * 60 < dur - 5; m++) {
        const a = Math.round(m * 60 * fs), b = Math.min(n, Math.round((m + 1) * 60 * fs));
        const lm = loudness(L.subarray(a, b), R.subarray(a, b), fs);
        perMinute.push({
            minute: m, lufsI: Number.isFinite(lm.integrated) ? Number(lm.integrated.toFixed(1)) : null,
            onsets: onsetTimes.filter(t => t >= m * 60 && t < (m + 1) * 60).length,
            cues: cueEvents.filter(e => e.t >= m * 60 && e.t < (m + 1) * 60).map(e => e.kind).join(',') || '',
        });
    }
    const { frames, hopS } = tonalChromaFrames(mid, fs);
    const rep = repetition(frames, hopS);
    const ng = ngramRepetition(mid, fs, onsetTimes);
    // Music is on while the Town band reports a piece; Signals has none.
    const playingStates = state.filter(s => s.running);
    const musicOn = playingStates.filter(s => s.nowPlaying?.piece != null);
    const byKind = {};
    for (const e of cueEvents) byKind[e.kind] = (byKind[e.kind] || 0) + 1;
    const cueTimes = cueEvents.map(e => e.t).sort((a, b) => a - b);
    const gaps = cueTimes.slice(1).map((t, i) => t - cueTimes[i]);
    // Pieces heard: runs of nowPlaying.piece (null between pieces and under Signals).
    const runs = [];
    for (const s of state) {
        const np = s.nowPlaying?.piece ?? null;
        if (!runs.length || runs[runs.length - 1].name !== np) runs.push({ name: np, from: s.t, to: s.t });
        else runs[runs.length - 1].to = s.t;
    }
    return {
        durationS: Number(dur.toFixed(1)),
        silence: {
            below60Pct: pct(v => !(v > -60)), below70Pct: pct(v => !(v > -70)), below50Pct: pct(v => !(v > -50)),
            longestBelow60S: Number((longest / 10).toFixed(1)),
        },
        repetition: {
            dejaHeardPct: rep.dejaHeardPct, tonalPct: rep.tonalPct, firstRepeatAtS: rep.firstRepeatAtS,
            medianRepeatLagS: rep.medianRepeatLagS, windows: rep.windows, tonalWindows: rep.tonalWindows,
            def: `10 s tonal-chroma sequence windows (hop 5 s, 0.5 s frames, peaks ≥12 dB over local median); a tonal window is "re-heard" if its best match ≥ ${rep.threshold} cosine at a lag ≥ ${rep.minLagS} s`,
            ngram: ng, matrix: rep.matrix, winTonal: rep.winTonal,
        },
        music: {
            onPct: playingStates.length ? Number((100 * musicOn.length / playingStates.length).toFixed(1)) : null,
            runs: runs.map(r => ({ name: r.name, from: r.from, to: r.to, s: Number((r.to - r.from + 1).toFixed(0)) })),
        },
        cues: {
            count: cueEvents.length, perHour: Number((cueEvents.length / (dur / 3600)).toFixed(0)), byKind,
            minGapS: gaps.length ? Number(Math.min(...gaps).toFixed(2)) : null, medianGapS: gaps.length ? Number(gaps.sort((a, b) => a - b)[gaps.length >> 1].toFixed(1)) : null,
        },
        onsetsPerMinuteMean: Number((onsetTimes.length / (dur / 60)).toFixed(1)),
        perMinute,
        curves: { shortTerm1s: st1 },
        onsetTimes: onsetTimes.map(t => Number(t.toFixed(3))),
    };
}

// ---- tiny PNG writer for the self-similarity matrix ----
function crc32(buf) {
    let c, crc = 0xffffffff;
    for (let n = 0; n < buf.length; n++) { c = (crc ^ buf[n]) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; }
    return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
}
export function writeSsmPng(file, M, winTonal, scale = 4) {
    const N = M.length, W = N * scale;
    const raw = Buffer.alloc((W * 3 + 1) * W);
    for (let y = 0; y < W; y++) {
        raw[y * (W * 3 + 1)] = 0;
        for (let x = 0; x < W; x++) {
            const i = Math.floor(y / scale), j = Math.floor(x / scale);
            const v = Math.max(0, Math.min(1, (M[i][j] - 0.5) / 0.5));
            const both = winTonal[i] && winTonal[j];
            // tonal pairs: black→yellow; non-tonal: dark blue-grey
            const o = y * (W * 3 + 1) + 1 + x * 3;
            if (both) { raw[o] = Math.round(255 * v); raw[o + 1] = Math.round(220 * v * v); raw[o + 2] = Math.round(40 * v); }
            else { raw[o] = 20; raw[o + 1] = 24; raw[o + 2] = Math.round(40 + 30 * v); }
        }
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(W, 4); ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
    fs.writeFileSync(file, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
}
