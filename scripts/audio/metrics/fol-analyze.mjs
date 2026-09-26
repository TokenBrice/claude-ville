// Workshop-voice metrics (FOL; ported from the FOL notes,
// fol-snippets/fol-analyze.mjs): schedule budgets of a strike list, and each
// strike's audibility in context as its band's rise over the local bed.
// Strikes: [{ t, b (building), slot, variant, kind: 'accent'|'downbeat'|'ghost'|'flam' }].
// wavs: { name: { L, R, sampleRate } } — at least `context` (the full mix).

// Analysis band per building (Hz) and the voices that swell rather than strike.
export const WORKSHOP_BANDS = Object.freeze({
    forge: [1500, 5000], archive: [1500, 5000], mine: [1500, 6000], taskboard: [1500, 5000],
    observatory: [1500, 5000], portal: [700, 4000], command: [500, 2500], harbor: [400, 2000],
});
const SWELLS = new Set(['page', 'rope', 'rune', 'chalk', 'quill']);

const r2 = x => Math.round(x * 100) / 100;
const r1 = x => Math.round(x * 10) / 10;

// S7 work budgets: onsets per building per second, the densest 1 s island-wide
// (≤ 3) and 1.25 s per building, the median inter-onset interval.
export function scheduleStats(strikes, { seconds = 60 } = {}) {
    const onsetsOf = list => list.filter(s => s.kind !== 'flam');
    const maxIn = (list, w) => {
        let m = 0;
        for (const s of list) m = Math.max(m, list.filter(x => x.t >= s.t && x.t < s.t + w).length);
        return m;
    };
    const perB = {};
    for (const s of strikes) (perB[s.b] ||= []).push(s);
    const out = { strikes: strikes.length, onsets: onsetsOf(strikes).length, globalMaxOnsetsIn1s: maxIn(onsetsOf(strikes), 1), perBuilding: {} };
    for (const [b, list] of Object.entries(perB)) {
        const c = onsetsOf(list);
        const iois = c.slice(1).map((s, i) => s.t - c[i].t).sort((x, y) => x - y);
        out.perBuilding[b] = {
            strikes: list.length, onsets: c.length, perSecond: r2(c.length / seconds),
            accents: list.filter(s => s.kind === 'accent' || s.kind === 'downbeat').length,
            ghosts: list.filter(s => s.kind === 'ghost').length,
            flams: list.filter(s => s.kind === 'flam').length,
            maxOnsetsIn1_25s: maxIn(c, 1.25),
            medianIoiS: r2(iois[Math.floor(iois.length / 2)] || 0),
            distinctSlots: new Set(list.map(s => s.slot)).size,
        };
    }
    return out;
}

function biquad(x, type, f, q, sr) {
    const w = 2 * Math.PI * f / sr;
    const cw = Math.cos(w);
    const al = Math.sin(w) / (2 * q);
    let b0;
    let b1;
    if (type === 'lp') { b0 = (1 - cw) / 2; b1 = 1 - cw; } else { b0 = (1 + cw) / 2; b1 = -(1 + cw); }
    const a0 = 1 + al;
    const a1 = -2 * cw / a0;
    const a2 = (1 - al) / a0;
    const b2 = b0 / a0;
    b0 /= a0;
    b1 /= a0;
    const y = new Float32Array(x.length);
    let x1 = 0;
    let x2 = 0;
    let y1 = 0;
    let y2 = 0;
    for (let i = 0; i < x.length; i++) {
        const v = b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
        x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v;
    }
    return y;
}

// 5 ms RMS envelope of the mid channel through a 4th-order band [lo, hi].
export function bandEnvelope({ L, R, sampleRate: sr }, lo, hi) {
    const mid = new Float32Array(L.length);
    for (let i = 0; i < L.length; i++) mid[i] = 0.5 * (L[i] + R[i]);
    let y = biquad(biquad(mid, 'hp', lo, 0.707, sr), 'hp', lo, 0.707, sr);
    y = biquad(biquad(y, 'lp', hi, 0.707, sr), 'lp', hi, 0.707, sr);
    const hop = Math.round(sr * 0.005);
    const n = Math.floor(y.length / hop);
    const env = new Float32Array(n);
    for (let k = 0; k < n; k++) {
        let s = 0;
        for (let i = k * hop; i < (k + 1) * hop; i++) s += y[i] * y[i];
        env[k] = Math.sqrt(s / hop) + 1e-12;
    }
    return { env, hop: 0.005 };
}

// A strike's rise (dB): its band peak in 40 ms (200 ms for swells) over the
// median of [t − 300 ms, t − 30 ms).
export function riseAt(E, t, variant) {
    const k = Math.round(t / E.hop);
    const win = SWELLS.has(variant) ? 40 : 8;
    let peak = 0;
    for (let i = k; i < k + win && i < E.env.length; i++) peak = Math.max(peak, E.env[i]);
    const pre = [];
    for (let i = k - 60; i < k - 6; i++) if (i >= 0) pre.push(E.env[i]);
    pre.sort((a, b) => a - b);
    const med = pre[Math.floor(pre.length / 2)] || 1e-12;
    return 20 * Math.log10(peak / med);
}

// Rises ≥ 6 dB in [a, b) (texture density heard in context).
export function riseCount(E, a, b) {
    let n = 0;
    let last = -1;
    for (let t = a; t < b; t += E.hop) {
        const k = Math.round(t / E.hop);
        if (k < 60) continue;
        const pre = [];
        for (let i = k - 40; i < k - 4; i++) pre.push(E.env[i]);
        pre.sort((x, y) => x - y);
        if (E.env[k] / pre[Math.floor(pre.length / 2)] > 2 && t - last > 0.15) { n++; last = t; }
    }
    return n;
}

// Per building and group (accent/ghost): median rise and the share heard
// (≥ 6 dB) in each wav; heard gaps per building in the context mix.
export function strikeAudibility(strikes, wavs, { bandsFor = b => WORKSHOP_BANDS[b], activeUntil = () => Infinity } = {}) {
    const envs = {};
    const env = (name, [lo, hi]) => ((envs[name] ||= {})[`${lo}-${hi}`] ||= bandEnvelope(wavs[name], lo, hi));
    const rises = {};
    const heard = {};
    for (const s of strikes) {
        const band = bandsFor(s.b);
        const group = s.kind === 'ghost' ? 'ghost' : 'accent';
        const g = ((rises[s.b] ||= {})[group] ||= Object.fromEntries(Object.keys(wavs).map(k => [k, []])));
        for (const name of Object.keys(wavs)) g[name].push(riseAt(env(name, band), s.t, s.variant));
        if (wavs.context && riseAt(env('context', band), s.t, s.variant) >= 6) (heard[s.b] ||= []).push(s.t);
    }
    const summary = {};
    for (const [b, groups] of Object.entries(rises)) {
        summary[b] = {};
        for (const [grp, byWav] of Object.entries(groups)) {
            summary[b][grp] = {};
            for (const [name, arr] of Object.entries(byWav)) {
                const sorted = [...arr].sort((x, y) => x - y);
                summary[b][grp][name] = { n: arr.length, medianRiseDb: r1(sorted[Math.floor(sorted.length / 2)]), pctOver6dB: Math.round(100 * arr.filter(v => v >= 6).length / arr.length) };
            }
        }
    }
    const heardGaps = {};
    for (const [b, ts] of Object.entries(heard)) {
        const u = [...new Set(ts.map(t => Math.round(t * 20) / 20))].sort((x, y) => x - y);
        const inside = u.filter(t => t < activeUntil(b));
        const gaps = inside.slice(1).map((t, i) => t - inside[i]);
        heardGaps[b] = { heard: u.length, maxGapWhileActiveS: r2(Math.max(0, ...gaps)), lastHeardS: r2(u.at(-1)) };
    }
    return { summary, heardGaps };
}

// Mean energy per `winSec` window of a narrow (±15 cent) line at `hz`, dB.
export function lineLevelDb({ L, R, sampleRate: sr }, hz, { winSec = 2 } = {}) {
    const mid = new Float32Array(L.length);
    for (let i = 0; i < mid.length; i++) mid[i] = 0.5 * (L[i] + R[i]);
    const w = 2 * Math.PI * hz / sr;
    const al = Math.sin(w) / (2 * 35);
    const a0 = 1 + al;
    const b0 = al / a0;
    const b2 = -al / a0;
    const a1 = -2 * Math.cos(w) / a0;
    const a2 = (1 - al) / a0;
    let y = mid;
    for (let pass = 0; pass < 2; pass++) {
        const o = new Float32Array(y.length);
        let x1 = 0;
        let x2 = 0;
        let y1 = 0;
        let y2 = 0;
        for (let i = 0; i < y.length; i++) {
            const v = b0 * y[i] + b2 * x2 - a1 * y1 - a2 * y2;
            x2 = x1; x1 = y[i]; y2 = y1; y1 = v; o[i] = v;
        }
        y = o;
    }
    const win = Math.round(winSec * sr);
    const out = [];
    for (let k = 0; (k + 1) * win <= y.length; k++) {
        let e = 0;
        for (let i = k * win; i < (k + 1) * win; i++) e += y[i] * y[i];
        out.push(10 * Math.log10(e / win + 1e-20));
    }
    return out;
}
