// The probe's Wave-7 measurements ("the front door"): the Signals floor
// (7.2), the awakening (7.4), and the listening options — output, tone and
// soften (7.7) — on the virtual clock. Every function returns numbers;
// probe.mjs turns them into PASS/FAIL lines.
import { loudness } from './analyze.mjs';
import { energyMeanLufs } from './checks.mjs';
import { bandLevelDb } from './probe-virtual.mjs';

const toDb = x => (x > 0 ? 10 * Math.log10(x) : -Infinity);

function slice(pair, sr, a, b) {
    const i = Math.max(0, Math.round(a * sr));
    const j = Math.min(pair.L.length, Math.round(b * sr));
    return { L: pair.L.subarray(i, j), R: pair.R.subarray(i, j) };
}

// Program RMS (dBFS, both channels' energy mean) in `winSec` windows every
// `hopSec` → [[start, dB]].
export function rmsCurveDb({ L, R }, sr, { winSec = 0.4, hopSec = 0.1, from = 0 } = {}) {
    const win = Math.round(winSec * sr);
    const hop = Math.round(hopSec * sr);
    const out = [];
    for (let a = Math.round(from * sr); a + win <= L.length; a += hop) {
        let e = 0;
        for (let i = a; i < a + win; i++) e += L[i] * L[i] + R[i] * R[i];
        out.push([a / sr, toDb(e / (2 * win))]);
    }
    return out;
}

const maxOf = rows => rows.reduce((m, [, v]) => Math.max(m, v), -Infinity);
const inWindow = (rows, a, b, winSec) => rows.filter(([t]) => t >= a && t + winSec <= b);

// 7.2: the Signals floor between cues. A cue sounds from its first published
// note (− 50 ms) to its last note + `ringSec`; every 400 ms window after the
// warmup outside those spans is floor. The needs-you call: the loudest
// window over its first 2.5 s, above the loudest floor window. An arrival:
// its caption (Toast, the default setting) and the loudest window over the
// 3 s after its marker.
export function signalsRows(r, { ringSec = 6, winSec = 0.4 } = {}) {
    const sounding = r.meta.scheduled.filter(s => !s.silent && s.notes?.length)
        .map(s => ({ kind: s.kind, from: s.notes[0] - 0.05, to: s.notes[s.notes.length - 1] + ringSec, onset: s.notes[0] }));
    const curve = rmsCurveDb(r.program, r.sr, { winSec, from: r.meta.warmup });
    const floor = curve.filter(([t]) => !sounding.some(c => t + winSec > c.from && t < c.to));
    const floorMax = maxOf(floor);
    const calls = sounding.filter(c => c.kind === 'summons').map(c => ({ onset: c.onset, peakDb: maxOf(inWindow(curve, c.onset, c.onset + 2.5, winSec)) }));
    const arrivals = r.meta.markers.filter(m => m.label === 'arrival').map((m) => {
        const caption = (r.meta.captions || []).find(c => c.cueKind === 'arrival' && c.wall >= m.t - 0.05 && c.wall <= m.t + 1.5) ?? null;
        const played = r.meta.cues.find(c => c.kind === 'arrival' && c.t >= m.t - 0.05 && c.t <= m.t + 1.5) ?? null;
        return {
            t: m.t, caption: caption?.message ?? null, announceOnly: played ? played.announceOnly : null,
            sounded: sounding.some(c => c.kind === 'arrival' && c.onset >= m.t - 0.05 && c.onset <= m.t + 5),
            peakDb: maxOf(inWindow(curve, m.t, m.t + 3, winSec)),
        };
    });
    const kinds = [...new Set(sounding.map(c => c.kind))];
    return { floorWindows: floor.length, floorMaxDb: floorMax, calls, arrivals, kinds, answered: sounding.filter(c => c.kind === 'answered').map(c => c.onset) };
}

// Momentary max (LUFS) of a stem over [a, b].
function mMax(pair, sr, a, b) {
    const s = slice(pair, sr, a, b);
    return loudness(s.L, s.R, sr).momentaryMax;
}

// 7.4: the awakening. Its plays (`audio:awakened`), its cue-stem M max over
// 2 s against the needs-you call's over 2.5 s, and the program's
// short-term loudness `stAtSec` after the enable against the steady level:
// the energy mean of the short-term values over [steadyFrom, steadyTo] (the
// band's phrases ride through both).
export function awakenRows(r, { steadyFrom, steadyTo, stAtSec }) {
    const plays = r.meta.awakens || [];
    const first = plays[0] ?? null;
    const call = r.meta.scheduled.find(s => s.kind === 'summons' && !s.silent && s.notes?.length);
    const awakenMMax = first ? mMax(r.stems.cue, r.sr, first.t, first.t + 2) : null;
    const callMMax = call ? mMax(r.stems.cue, r.sr, call.notes[0], call.notes[0] + 2.5) : null;
    const st = loudness(r.program.L, r.program.R, r.sr).shortTermCurve;
    const enableAt = first?.t ?? 0;
    // A short-term value is stamped at the end of its 3 s block.
    const stAt = st.find(([t]) => t >= enableAt + stAtSec)?.[1] ?? null;
    const steady = energyMeanLufs(st.filter(([t]) => t >= steadyFrom && t <= steadyTo).map(([, v]) => v));
    return { plays: plays.length, presets: plays.map(p => p.preset), enableAt, awakenMMax, callMMax, stAt, steady };
}

// 7.7 output: program loudness of a render after its warmup; `lrDiffDb` is
// the largest |L − R| sample (dBFS) — a true mono program has none.
export function outputRow(r) {
    const s = slice(r.program, r.sr, r.meta.warmup, r.program.L.length / r.sr);
    let d = 0;
    for (let i = 0; i < s.L.length; i++) d = Math.max(d, Math.abs(s.L[i] - s.R[i]));
    return { lufsI: loudness(s.L, s.R, r.sr).integrated, lrDiffDb: d > 0 ? 20 * Math.log10(d) : -Infinity, output: r.meta.output ?? null };
}

// 7.7 tone: the program's band levels (dB) after the warmup — above the
// 3 kHz shelf (5–10 kHz) and well under it (100–1000 Hz).
export function toneRow(r) {
    const s = slice(r.program, r.sr, r.meta.warmup, r.program.L.length / r.sr);
    return { highDb: bandLevelDb(s, r.sr, 5000, 10000), lowDb: bandLevelDb(s, r.sr, 100, 1000), output: r.meta.output ?? null };
}

// A cue's attack on the cue stem: the RMS envelope (`winMs` windows every
// `hopMs`) from `onset` over `spanSec`; `riseMs` is the time from the first
// window above −40 dB re the peak to the first within 1 dB of it (a linear
// 25 ms ramp reads 24–25 ms, the 12 ms default 11–13 ms, on struck
// partials from 0.5 to 3.5 kHz); `peakDb` the envelope's peak (dBFS).
export function attackOf(pair, sr, onset, { spanSec = 0.3, winMs = 5, hopMs = 1 } = {}) {
    const w = Math.max(1, Math.round(sr * winMs / 1000));
    const h = Math.max(1, Math.round(sr * hopMs / 1000));
    const a = Math.max(0, Math.round((onset - 0.02) * sr));
    const b = Math.min(pair.L.length, Math.round((onset + spanSec) * sr));
    const env = [];
    for (let i = a; i + w <= b; i += h) {
        let e = 0;
        for (let k = i; k < i + w; k++) e += pair.L[k] * pair.L[k] + pair.R[k] * pair.R[k];
        env.push(toDb(e / (2 * w)));
    }
    const peak = Math.max(...env);
    if (!Number.isFinite(peak)) return { riseMs: null, peakDb: null };
    const start = env.findIndex(v => v >= peak - 40);
    const top = env.findIndex(v => v >= peak - 1);
    return { riseMs: (top - start) * hopMs, peakDb: peak };
}

// 7.7 soften: the arrival's bell attack, the needs-you call's M max, and
// every duck's depths paired with the cue that asked for it (the scheduled
// cue nearest its request).
export function softenRow(r) {
    const first = kind => r.meta.scheduled.find(s => s.kind === kind && !s.silent && s.notes?.length) ?? null;
    const arrival = first('arrival');
    const call = first('summons');
    const ducks = r.meta.ducks.map((d) => {
        const cue = r.meta.scheduled.filter(s => !s.silent && Math.abs(s.t - d.at) < 0.1).sort((x, y) => Math.abs(x.t - d.at) - Math.abs(y.t - d.at))[0];
        return { kind: cue?.kind ?? null, at: d.at, depths: d.depths };
    });
    return {
        // The first strike alone: the window ends before the next note.
        bell: arrival ? attackOf(r.stems.cue, r.sr, arrival.notes[0], { spanSec: arrival.notes.length > 1 ? Math.min(0.3, arrival.notes[1] - arrival.notes[0] - 0.005) : 0.3 }) : null,
        callMMax: call ? mMax(r.stems.cue, r.sr, call.notes[0], call.notes[0] + 2.5) : null,
        ducks,
        output: r.meta.output ?? null,
    };
}
