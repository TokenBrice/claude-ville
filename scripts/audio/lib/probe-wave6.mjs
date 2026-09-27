// The probe's Wave-6 measurements ("the music") on the virtual clock: the
// sequencer's own marks (page/music.js: notes, pieces, chunks, breaths,
// cadences, percussion, arrangement switches) against the rendered seat
// stems and program. Every function returns numbers; probe.mjs judges them
// through checks.mjs.
import { loudness } from './analyze.mjs';
import { automationCurve, coveredSec } from './checks.mjs';
import { outputGainDb } from './probe-virtual.mjs';
import { levelMap } from '../metrics/levelmap.mjs';
import { musicMeasure } from '../metrics/musl-measure.mjs';
import { welch } from '../metrics/dsp.mjs';

export const OCTAVE_CENTERS = Object.freeze([63, 125, 250, 500, 1000, 2000, 4000, 8000]);

function slice(pair, sr, a, b) {
    const i = Math.max(0, Math.round(a * sr));
    const j = Math.min(pair.L.length, Math.round(b * sr));
    return { L: pair.L.subarray(i, j), R: pair.R.subarray(i, j) };
}

// A stem scaled to the output (bus and seat taps sit before the program
// trim and the volume), so BS.1770's absolute gate reads what is heard.
export function toOutput(pair, gainDb) {
    const g = 10 ** (gainDb / 20);
    const L = new Float32Array(pair.L.length);
    const R = new Float32Array(pair.R.length);
    for (let i = 0; i < L.length; i++) { L[i] = pair.L[i] * g; R[i] = pair.R[i] * g; }
    return { L, R };
}

export function sumOf(pairs, n) {
    const L = new Float32Array(n);
    const R = new Float32Array(n);
    for (const p of pairs) for (let i = 0; i < n; i++) { L[i] += p.L[i]; R[i] += p.R[i]; }
    return { L, R };
}

// Octave-band levels (dB, power) of a stereo pair, 63 Hz – 8 kHz.
export function octaveBandsDb({ L, R }, sr) {
    if (L.length < 8192) return OCTAVE_CENTERS.map(() => -Infinity);
    const psd = welch([L, R]);
    const N = (psd.length - 1) * 2;
    return OCTAVE_CENTERS.map((c) => {
        const lo = c / Math.SQRT2;
        const hi = Math.min(c * Math.SQRT2, sr / 2);
        let e = 0;
        for (let k = 1; k < psd.length; k++) {
            const f = k * sr / N;
            if (f >= lo && f < hi) e += psd[k];
        }
        return e > 0 ? 10 * Math.log10(e) : -Infinity;
    });
}

// The render's window [from, to): the warmup to the end by default.
export function windowOf(r, { from = r.meta.warmup, to = r.meta.warmup + r.meta.seconds } = {}) {
    return { from, to };
}

// Every seat stem (`seat:<name>`) output-referred over the window.
export function seatPairs(r, win = windowOf(r)) {
    const g = outputGainDb(r);
    const out = {};
    for (const [name, pair] of Object.entries(r.stems)) {
        if (!name.startsWith('seat:')) continue;
        out[name.slice(5)] = toOutput(slice(pair, r.sr, win.from, win.to), g);
    }
    return out;
}

// LUFS-I per seat (−Infinity for a silent seat).
export function seatLufs(pairs, sr) {
    return Object.fromEntries(Object.entries(pairs).map(([seat, p]) => [seat, loudness(p.L, p.R, sr).integrated]));
}

// Notes and percussion hits in [from, to) as analyzer rows, from a render
// (`r.meta.music.marks`) or a mark list.
export function noteRows(source, { from = -Infinity, to = Infinity } = {}) {
    const all = Array.isArray(source) ? source : (source.meta.music?.marks || []);
    const within = kind => all.filter(m => m.kind === kind && m.t >= from && m.t < to);
    const notes = within('note')
        .map(m => ({ t: m.t, dur: m.dur, midi: m.midi, seat: m.seat, piece: m.piece, bar: m.bar, segment: m.segment, what: m.what, instrument: m.instrument, vel: m.vel, preset: m.preset }));
    const perc = within('perc')
        .map(m => ({ t: m.t, dur: 0, midi: null, seat: 'percussion', building: m.building, instrument: m.voice ?? m.instrument ?? null, preset: m.preset }));
    return [...notes, ...perc].sort((a, b) => a.t - b.t);
}

// MUSL-3 bands from one full-band render: band k's mix is the sum of the
// seats it admits (seat content never depends on the band; Voicings), its
// onsets the admitted seats' notes. → [{ band, admitted, onsets, octaveDb }]
export function bandRows(r, pairs, admittedByBand, win = windowOf(r)) {
    const n = Math.min(...Object.values(pairs).map(p => p.L.length));
    const notes = noteRows(r, win);
    return admittedByBand.map((admitted, band) => {
        const mix = sumOf(admitted.filter(s => pairs[s]).map(s => pairs[s]), n);
        return { band, admitted, onsets: notes.filter(x => admitted.includes(x.seat)).length, octaveDb: octaveBandsDb(mix, r.sr) };
    });
}

// 6.1: one arm as heard — the music bus and the air's wet return (the
// Town band's only send: no world or work stratum), output-referred over
// the window: laptop-model loss (positive LU), 2–5 kHz share (dB re total),
// S/M, correlation, mono fold loss and LUFS-I; `dry` the same of the seats'
// sum without the room.
export function armRow(r, win = windowOf(r)) {
    const g = outputGainDb(r);
    const music = toOutput(slice(r.stems.music, r.sr, win.from, win.to), g);
    const wet = r.stems.airWet ? toOutput(slice(r.stems.airWet, r.sr, win.from, win.to), g) : null;
    const mix = wet ? sumOf([music, wet], music.L.length) : music;
    const measure = (pair) => {
        const m = musicMeasure(pair.L, pair.R, r.sr);
        const lm = levelMap(pair.L, pair.R, r.sr);
        return { lufsI: m.lufs, laptopLossLu: m.laptopDeltaLu != null ? -m.laptopDeltaLu : null, presenceDb: m.presenceDb, sideMidDb: lm.sideMidDB, corr: lm.corr, monoLossLu: lm.monoLossLU };
    };
    return { ...measure(mix), dry: measure(music), air: Boolean(wet) };
}

// ≤ 4 nodes per note: node constructions attributed to each note
// (page/music.js counts constructions inside the sequencer's schedule
// between one note's mark and the next). A player's first note also builds
// the player (createInstrument), so each (seat, instrument)'s first note is
// reported apart and not judged. → { notes, max, over, byInstrument, firsts }
export function nodesPerNoteRow(r, { from = r.meta.warmup, limit = 4 } = {}) {
    const seen = new Set();
    const byInstrument = {};
    let max = 0;
    let over = 0;
    let notes = 0;
    let firsts = 0;
    for (const x of r.meta.music?.perNote || []) {
        const key = `${x.seat}|${x.instrument}`;
        if (!seen.has(key)) { seen.add(key); firsts++; continue; }
        if (x.t < from) continue;
        notes++;
        max = Math.max(max, x.nodes);
        if (x.nodes > limit) over++;
        const k = x.instrument || x.kind;
        byInstrument[k] = Math.max(byInstrument[k] ?? 0, x.nodes);
    }
    return { notes, max, over, byInstrument, firsts };
}

// The stop lint: each stopped music voice's level at its stop re its own
// peak (envelope automation of its note-owned gains × the buffer's level
// at the stop offset). A voice ramped to exactly peak × 1e-3 reads −60.0;
// `tolDb` absorbs float residue and the 2 ms peak sampling.
// → { voices, worstDb, over, rows }
export function stopLevels(r, { maxDb = -60, tolDb = 0.05 } = {}) {
    const rows = [];
    for (const s of r.meta.music?.stops || []) {
        const curves = s.gains.map(g => automationCurve(g.events, g.v0));
        const env = t => curves.reduce((p, f) => p * Math.abs(f(t)), 1);
        let peak = 0;
        const step = Math.max(0.002, (s.e - s.t) / 2000);
        for (let t = s.t; t <= s.e + 1e-9; t += step) peak = Math.max(peak, env(t));
        const atStop = env(s.e);
        let db = curves.length ? (peak > 0 ? (atStop > 0 ? 20 * Math.log10(atStop / peak) : -Infinity) : -Infinity) : 0;
        if (s.bufDb != null) db += s.bufDb <= -999 ? -Infinity : s.bufDb;
        rows.push({ t: s.t, e: s.e, k: s.k, db, gains: curves.length, buf: s.bufDb });
    }
    const finiteDb = rows.map(x => x.db).filter(v => v > -Infinity);
    return { voices: rows.length, worstDb: finiteDb.length ? Math.max(...finiteDb) : -Infinity, over: rows.filter(x => x.db > maxDb + tolDb).length, rows };
}

// Visits from the sequencer's start/end marks (what: piece, interlude),
// breaths, renditions and cadences of one preset.
export function visitRows(marks, end, preset = 'townBand') {
    const own = marks.filter(m => m.preset === preset);
    const visits = [];
    let open = null;
    const close = (v, to) => { if (to > v.from) visits.push({ ...v, to }); };
    for (const m of own) {
        if (m.kind === 'start') {
            if (open) close(open, m.t);
            open = { what: m.what, piece: m.piece, name: m.name, reason: m.reason ?? null, from: m.t };
        } else if (m.kind === 'end' && open) {
            close(open, m.t);
            open = null;
        }
    }
    if (open) close(open, end);
    return {
        visits,
        pieces: visits.filter(v => v.what === 'piece'),
        interludes: visits.filter(v => v.what === 'interlude').map(v => v.from),
        breaths: own.filter(m => m.kind === 'breath').map(m => ({ t: m.t, until: m.until })),
        renditions: own.filter(m => m.kind === 'rendition').map(m => ({ piece: m.piece, t: m.t, key: m.key })),
        cadences: own.filter(m => m.kind === 'cadence'),
    };
}

// Music-on share of [from, to) from spans.
export function dutyOf(spans, from, to) {
    return to > from ? coveredSec(spans, from, to) / (to - from) : null;
}

// The workshop kit per bar on the Town band's song grid: bars from the
// chunk marks (loop, chunk, interlude: `t`, `barSec`, `band`), each bar up
// to the next boundary. The band reads the directors' densities when it
// compiles a chunk (Sequencer, 6.9) and marks the chunk as it compiles it,
// so a bar's `density` is the total of the last `call:setWorkshopDensity`
// before its chunk's mark (each building capped at 1). Pieces drum on very
// different rows (a lullaby near silent, a march dense), so a bar's `level`
// is its kit hits, each in units of its building's row in the piece —
// Σ min(1, weight) over the row's steps, the hits that row plays per bar at
// density 1 — and so estimates the density the band played whatever the
// piece. `capacity` is the sum of those rows; only a piece pass drums (a tag,
// an interlude or a stinger plays no workshop kit: capacity 0).
// rowsOf(piece name) → { [building]: [weight per step] } | null
const BOUNDARY = new Set(['loop', 'chunk', 'interlude']);
export function percussionPerBar(marks, { from, to, rowsOf }) {
    const band = marks.filter(m => m.preset === 'townBand');
    const read = new Map();
    let density = 0;
    for (const m of band) {
        if (m.kind === 'call:setWorkshopDensity') density = Object.values(m.arg || {}).reduce((s, v) => s + (Number(v) > 0 ? Math.min(1, Number(v)) : 0), 0);
        else if (BOUNDARY.has(m.kind) && m.barSec > 0) read.set(m, density);
    }
    const chunks = [...read.keys()].sort((a, b) => a.t - b.t);
    const kit = band.filter(m => m.kind === 'perc' && m.building);
    const bars = [];
    chunks.forEach((c, i) => {
        const end = Math.min(to, chunks[i + 1]?.t ?? to);
        const segment = c.segment ?? c.kind;
        const caps = {};
        if (segment === 'pass') {
            for (const [building, row] of Object.entries(rowsOf(c.piece) || {})) {
                caps[building] = (row || []).reduce((s, w) => s + Math.min(1, Math.max(0, Number(w) || 0)), 0);
            }
        }
        const capacity = Object.values(caps).reduce((s, v) => s + v, 0);
        for (let a = c.t; a + c.barSec <= end + 1e-6; a += c.barSec) {
            if (a < from) continue;
            const hits = kit.filter(p => p.t >= a - 1e-6 && p.t < a + c.barSec - 1e-6);
            bars.push({
                from: a, to: a + c.barSec, band: c.band, piece: c.piece, segment, density: read.get(c), capacity,
                onsets: hits.length, level: hits.reduce((s, p) => s + (caps[p.building] > 0 ? 1 / caps[p.building] : 0), 0),
            });
        }
    });
    return bars;
}
