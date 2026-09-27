#!/usr/bin/env node
// The score analyzer (plan 6.5, MUS-18): a pure, audio-free reading of the
// songbook and of rendered note streams. Two layers:
//
//   * render level — note streams as the probe records them
//     (`{ t, dur, midi, seat, piece, bar }`), chord frames from the
//     MusicClock (`{ t, root?, pcs }`, pitch classes C = 0), cue notes
//     (`{ t, midi }`) and music-on windows (`{ from, to }`): parallels,
//     cue clash, ranges, identical renditions, tonal and phrase re-hearing,
//     motif statements;
//   * score level — `analyzeSongbook()` checks every piece, cell, phrase
//     end, interlude, tag and stinger of `bgm/BgmSongbook.js` against the
//     composition invariants and returns the failures.
//
// `node scripts/audio/score-analyzer.mjs` prints the songbook report and
// exits 1 on any failure.

import { pathToFileURL } from 'node:url';
import { CUE_ROLES, clashesWithChord, roleSemi } from '../../claudeville/src/presentation/shared/audio/MusicalScale.js';
import { MOTIF_SIGNATURES } from '../../claudeville/src/presentation/shared/audio/Motifs.js';
import * as SONGBOOK from '../../claudeville/src/presentation/shared/audio/bgm/BgmSongbook.js';
import { RANGES } from '../../claudeville/src/presentation/shared/audio/bgm/ScoreKit.js';

const EPS = 1e-6;
const mod12 = n => ((n % 12) + 12) % 12;
// Score notes are semitones from A4 whatever the piece's key.
const A4_PC = 9;
const pcOfSemi = semi => mod12(A4_PC + semi);
const round = (n, d = 2) => Number(n.toFixed(d));

// ── lines ──

/** Score notes `[[semi|null, beats]]` → a line `[{ start, dur, pitch }]` (rests dropped). */
export function timeline(notes, { offset = 0 } = {}) {
    const out = [];
    let at = offset;
    for (const [pitch, beats] of notes) {
        if (pitch != null) out.push({ start: at, dur: beats, pitch });
        at += beats;
    }
    return out;
}

/** Total beats of score notes. */
export function totalBeats(notes) {
    return notes.reduce((sum, [, beats]) => sum + beats, 0);
}

/** One seat of a rendered stream as a line (`start` = t, `pitch` = midi). */
export function seatLine(notes, seat) {
    return notes.filter(n => n.seat === seat)
        .map(n => ({ start: n.t, dur: n.dur, pitch: n.midi }))
        .sort((a, b) => a.start - b.start);
}

function soundingAt(line, t) {
    let hit = null;
    for (const note of line) {
        if (note.start > t + EPS) break;
        if (t < note.start + note.dur - EPS) hit = note;
    }
    return hit;
}

// ── parallels ──

/**
 * Parallel (or contrary) perfect fifths and octaves between an upper and a
 * lower line, read on consecutive lower-line onsets (MUS-18): both voices
 * change pitch class and the interval class stays 0 (octave) or 7 (fifth).
 * A rest in the upper line breaks the chain.
 */
export function parallelPerfects(upper, lower) {
    const found = [];
    const sorted = [...lower].sort((a, b) => a.start - b.start);
    let prev = null;
    for (const low of sorted) {
        const up = soundingAt(upper, low.start);
        if (!up) { prev = null; continue; }
        const cls = mod12(up.pitch - low.pitch);
        if (prev && (cls === 0 || cls === 7) && cls === prev.cls
            && mod12(up.pitch) !== mod12(prev.up) && mod12(low.pitch) !== mod12(prev.low)) {
            found.push({ at: low.start, interval: cls === 0 ? 'octave' : 'fifth', from: [prev.up, prev.low], to: [up.pitch, low.pitch] });
        }
        prev = { cls, up: up.pitch, low: low.pitch };
    }
    return found;
}

/** Lower-line onsets where the lower voice sounds above the upper one. */
export function crossings(upper, lower) {
    const out = [];
    const points = [...upper.map(n => n.start), ...lower.map(n => n.start)].sort((a, b) => a - b);
    for (const t of points) {
        const up = soundingAt(upper, t);
        const low = soundingAt(lower, t);
        if (up && low && low.pitch > up.pitch) out.push({ at: t, upper: up.pitch, lower: low.pitch });
    }
    return out;
}

// ── cue clash ──

const CLASH = new Set([1, 6, 11]);

/**
 * Rendered cue notes against the chord sounding at each (`chords` sorted
 * frames `{ t, pcs }`): semitone, major-seventh or tritone contact.
 */
export function cueClash(cues, chords) {
    const frames = [...chords].sort((a, b) => a.t - b.t);
    let checked = 0, clashes = 0;
    for (const cue of cues) {
        let chord = null;
        for (const frame of frames) { if (frame.t <= cue.t + EPS) chord = frame; else break; }
        if (!chord) continue;
        checked++;
        const pc = mod12(cue.midi);
        if (chord.pcs.some(tone => CLASH.has(mod12(pc - tone)))) clashes++;
    }
    return { checked, clashes, pct: checked ? round(100 * clashes / checked, 1) : 0 };
}

/** Every routine cue role resolved over a chord (`{ rootPc, pcs }`) against it. */
export function routineRoleClashes(chord) {
    return CUE_ROLES.filter(role => clashesWithChord(roleSemi(role, chord), chord));
}

// ── the needs-you figure ──

// S1: no music voice plays a quick same-pitch pair (the ship's bell strikes
// its note twice 150 ms apart). Onsets of one pitch closer than this fail.
export const QUICK_PAIR_SEC = 0.3;

/** Same-pitch consecutive onsets of a line closer than `QUICK_PAIR_SEC`. */
export function quickPairs(line, secPerUnit = 1) {
    const out = [];
    for (let i = 1; i < line.length; i++) {
        const a = line[i - 1], b = line[i];
        if (a.pitch === b.pitch && (b.start - a.start) * secPerUnit < QUICK_PAIR_SEC) out.push({ at: b.start, pitch: b.pitch });
    }
    return out;
}

// ── ranges and density ──

export function range(line) {
    if (!line.length) return { low: null, high: null, span: 0 };
    let low = Infinity, high = -Infinity;
    for (const { pitch } of line) { low = Math.min(low, pitch); high = Math.max(high, pitch); }
    return { low, high, span: high - low };
}

// ── renditions ──

/**
 * Group a rendered stream into renditions: a new one starts when the piece
 * or the segment changes or the bar number goes backwards. Only notes of
 * `segments` count (the sequencer marks a piece's loops `pass`; interludes,
 * tags, pickups and stingers are not 16-bar renditions); notes without a
 * `segment` count. The key is every note of `seats` as seat, pitch, bar and
 * sixteenth-grid position, so humanization jitter never makes two equal
 * renditions differ.
 */
export function renditions(notes, { beatSec = {}, seats = ['lead', 'bass'], segments = ['pass'] } = {}) {
    const keep = new Set(seats);
    const kinds = new Set(segments);
    const sorted = notes
        .filter(n => keep.has(n.seat) && n.bar != null && (n.segment == null || kinds.has(n.segment)))
        .sort((a, b) => a.t - b.t);
    const out = [];
    let current = null;
    for (const note of sorted) {
        if (!current || current.piece !== note.piece || current.segment !== note.segment || note.bar < current.lastBar) {
            current = { piece: note.piece, segment: note.segment, t: note.t, lastBar: note.bar, firstBar: note.bar, notes: [] };
            out.push(current);
        }
        current.lastBar = Math.max(current.lastBar, note.bar);
        current.notes.push(note);
    }
    return out.map(r => {
        const sec = beatSec[r.piece] || 0.5;
        const t0 = r.notes.find(n => n.bar === r.firstBar)?.t ?? r.t;
        const key = r.notes
            .map(n => `${n.seat}:${n.midi}:${n.bar}:${Math.round(((n.t - t0) / sec) * 4)}`)
            .sort()
            .join('|');
        return { piece: r.piece, t: r.t, key };
    });
}

/** The shortest time between two identical renditions of one piece. */
export function identicalRenditionGap(list) {
    const last = new Map();
    let minGapSec = Infinity;
    const pairs = [];
    for (const r of [...list].sort((a, b) => a.t - b.t)) {
        const id = `${r.piece}#${r.key}`;
        if (last.has(id)) {
            const gap = r.t - last.get(id);
            pairs.push({ piece: r.piece, from: last.get(id), to: r.t, gapSec: gap });
            minGapSec = Math.min(minGapSec, gap);
        }
        last.set(id, r.t);
    }
    return { minGapSec, pairs };
}

// ── re-hearing ──

const insideAny = (from, to, windows) => windows.some(w => from >= w.from - EPS && to <= w.to + EPS);

/**
 * Tonal re-hearing from notes, the session-metrics definition: 10 s windows
 * (hop 5 s) of 0.5 s chroma frames, inside music-on windows only; a window is
 * re-heard when some stretch starting ≥ `minLag` s earlier matches it at
 * cosine ≥ `thresh` (searched at every frame offset up to `maxLag` s back;
 * an hour of music takes about two seconds).
 */
export function tonalReheard(notes, musicOn, { win = 10, hop = 5, frame = 0.5, minLag = 30, maxLag = Infinity, thresh = 0.9, seats } = {}) {
    const pitched = notes.filter(n => n.seat !== 'percussion' && (!seats || seats.includes(n.seat)));
    if (!pitched.length || !musicOn.length) return { windows: 0, reheard: 0, pct: 0 };
    const end = Math.max(...musicOn.map(w => w.to));
    const frames = Math.ceil(end / frame) + 1;
    const chroma = new Float32Array(frames * 12);
    for (const n of pitched) {
        const a = Math.max(0, Math.floor(n.t / frame));
        const b = Math.min(frames - 1, Math.floor((n.t + Math.max(n.dur, frame * 0.5)) / frame));
        const pc = mod12(n.midi);
        for (let f = a; f <= b; f++) chroma[f * 12 + pc] += 1;
    }
    const W = Math.round(win / frame);
    const H = Math.round(hop / frame);
    const L = Math.round(minLag / frame);
    const energy = new Float32Array(frames);
    for (let f = 0; f < frames; f++) {
        let s = 0;
        for (let k = 0; k < 12; k++) s += chroma[f * 12 + k] ** 2;
        energy[f] = s;
    }
    const prefix = new Float64Array(frames + 1);
    for (let f = 0; f < frames; f++) prefix[f + 1] = prefix[f] + energy[f];
    const winEnergy = f => prefix[Math.min(frames, f + W)] - prefix[f];
    let windows = 0, reheard = 0;
    for (let w = 0; w + W <= frames; w += H) {
        if (!insideAny(w * frame, (w + W) * frame, musicOn)) continue;
        const ew = winEnergy(w);
        if (ew <= 0) continue;
        windows++;
        for (let j = Math.max(0, w - Math.round(maxLag / frame)); j + L <= w; j++) {
            const ej = winEnergy(j);
            if (ej <= 0) continue;
            let dot = 0;
            for (let k = 0; k < W * 12; k++) dot += chroma[w * 12 + k] * chroma[j * 12 + k];
            if (dot / Math.sqrt(ew * ej) >= thresh) { reheard++; break; }
        }
    }
    return { windows, reheard, pct: windows ? round(100 * reheard / windows, 1) : 0 };
}

/**
 * Phrase re-hearing: n-note onset grams of one seat (pitch classes plus
 * IOIs quantised to 1/8 s, spanning ≤ `maxSpan` s) inside music-on windows;
 * a gram is re-heard when the same gram started ≥ `minLag` s earlier.
 */
export function phraseReheard(notes, musicOn, { n = 4, maxSpan = 4, minLag = 20, seat = 'lead' } = {}) {
    const line = notes.filter(x => x.seat === seat).sort((a, b) => a.t - b.t);
    const firstSeen = new Map();
    let grams = 0, reheard = 0;
    for (let i = 0; i + n <= line.length; i++) {
        const run = line.slice(i, i + n);
        const span = run[n - 1].t - run[0].t;
        if (span > maxSpan || !insideAny(run[0].t, run[n - 1].t, musicOn)) continue;
        const key = run.map((x, k) => `${mod12(x.midi)}${k ? `/${Math.round((x.t - run[k - 1].t) * 8)}` : ''}`).join(' ');
        grams++;
        const seen = firstSeen.get(key);
        if (seen != null && run[0].t - seen >= minLag) reheard++;
        if (seen == null) firstSeen.set(key, run[0].t);
    }
    return { grams, reheard, pct: grams ? round(100 * reheard / grams, 1) : 0 };
}

// ── motif statements ──

/**
 * Statements of the village motif (Motifs.js `MOTIF_SIGNATURES`): runs of
 * consecutive onsets in `seats` whose pitch classes, relative to the tonic
 * A, spell a figure (the call or the home phrase, major or minor), each onset
 * ≤ `maxGap` s after the one before. Non-overlapping; `excludePieces` skips a
 * piece's own performance (Willowbrook plays its own opening).
 */
export function motifStatements(notes, { seats = ['lead'], excludePieces = [], maxGap = 1.5, signatures = MOTIF_SIGNATURES } = {}) {
    const keep = new Set(seats);
    const skip = new Set(excludePieces);
    const line = notes.filter(x => keep.has(x.seat) && !skip.has(x.piece)).sort((a, b) => a.t - b.t);
    const at = [];
    for (let i = 0; i < line.length; i++) {
        for (const { figure, mode, pcs } of signatures) {
            if (i + pcs.length > line.length) continue;
            let ok = true;
            for (let k = 0; k < pcs.length && ok; k++) {
                const note = line[i + k];
                ok = mod12(note.midi - 69) === mod12(pcs[k])
                    && (k === 0 || (note.t - line[i + k - 1].t <= maxGap && note.piece === line[i + k - 1].piece));
            }
            if (ok) { at.push({ t: line[i].t, piece: line[i].piece, figure, mode }); i += pcs.length - 1; break; }
        }
    }
    const span = line.length ? line[line.length - 1].t - line[0].t : 0;
    return { count: at.length, perHour: round(at.length * 3600 / Math.max(span, 3600), 2), at };
}

// ── the songbook ──

// Onsets per bar of the melody (MUS-5 states 3.75 for The Painted Isle and
// 2.25 for Lanternlight; every tune stays between a lullaby and an engine).
// The ranges (`RANGES`) are the songbook's own (ScoreKit), absolute in
// every key.
export const MELODY_DENSITY = Object.freeze({ min: 1, max: 6 });
export const MUS5_DENSITY = Object.freeze({ paintedIsle: 3.75, lanternlight: 2.25 });
// An interlude plays its melody at 40–50 % of the piece's density (6.7).
export const INTERLUDE_DENSITY = Object.freeze({ min: 0.4, max: 0.5 });
// MUSL-3: every band adds a player.
export const BAND_SIZE_MIN_STEP = 1;
const PHASES = Object.freeze(['dawn', 'day', 'dusk', 'night']);

function chordSpans(chords, beatsPerBar, offset = 0) {
    const spans = [];
    chords.forEach((entry, bar) => {
        const parts = Array.isArray(entry) ? entry : [entry];
        const each = beatsPerBar / parts.length;
        parts.forEach((name, k) => spans.push({ start: offset + bar * beatsPerBar + k * each, dur: each, name }));
    });
    return spans;
}

/**
 * Check one passage `{ chords, melody, bass, counterNotes? }` in
 * `beatsPerBar`, reporting problems into `fail` under `label`.
 */
export function checkPassage(label, passage, { beatsPerBar, bpm = null, night = false, bars = null, fail, book = SONGBOOK }) {
    const { chords, melody, bass } = passage;
    const n = bars ?? chords.length;
    const want = n * beatsPerBar;
    for (const [voice, notes] of [['melody', melody], ['bass', bass], ['counter', passage.counterNotes]]) {
        if (!notes) continue;
        const got = totalBeats(notes);
        if (Math.abs(got - want) > EPS) fail(`${label}: ${voice} sums to ${got} beats, want ${want}`);
    }
    for (const span of chordSpans(chords, beatsPerBar)) {
        const pcs = book.chordPitchClasses(span.name);
        if (!pcs) { fail(`${label}: unknown chord ${span.name}`); continue; }
        const bad = routineRoleClashes(pcs);
        if (bad.length) fail(`${label}: routine roles ${bad.join(',')} clash with ${span.name}`);
    }
    const lead = timeline(melody);
    const low = timeline(bass);
    for (const p of parallelPerfects(lead, low)) {
        fail(`${label}: parallel ${p.interval}s at beat ${p.at} (${p.from} → ${p.to})`);
    }
    if (bpm) for (const q of quickPairs(lead, 60 / bpm)) fail(`${label}: quick same-pitch pair at beat ${q.at}`);
    const r = range(lead);
    const high = night ? RANGES.nightLeadHigh : RANGES.lead.high;
    if (r.low != null && (r.low < RANGES.lead.low || r.high > high)) fail(`${label}: melody ${r.low}…${r.high} outside ${RANGES.lead.low}…${high}`);
    const rb = range(low);
    if (rb.low != null && (rb.low < RANGES.bass.low || rb.high > RANGES.bass.high)) fail(`${label}: bass ${rb.low}…${rb.high} outside ${RANGES.bass.low}…${RANGES.bass.high}`);
    for (const c of crossings(lead, low)) fail(`${label}: bass above melody at beat ${c.at}`);
    if (passage.counterNotes) {
        const counter = timeline(passage.counterNotes);
        const rc = range(counter);
        if (rc.low < RANGES.counter.low || rc.high > RANGES.counter.high) fail(`${label}: counter ${rc.low}…${rc.high} outside ${RANGES.counter.low}…${RANGES.counter.high}`);
        for (const c of crossings(lead, counter)) fail(`${label}: counter above melody at beat ${c.at}`);
        for (const c of crossings(counter, low)) fail(`${label}: bass above counter at beat ${c.at}`);
    }
    return { lead, low, range: r, onsetsPerBar: lead.length / n };
}

const sliceNotes = (notes, from, to) => {
    const out = [];
    let at = 0;
    for (const note of notes) {
        const end = at + note[1];
        if (at >= from - EPS && end <= to + EPS) out.push(note);
        at = end;
    }
    return out;
};

/** Every variant pair of adjacent slots (the loop wraps), joined, as passages to check. */
function slotJoins(piece) {
    const joins = [];
    const slots = piece.grammar;
    for (let i = 0; i < slots.length; i++) {
        const next = slots[(i + 1) % slots.length];
        const a = piece.cells[slots[i]];
        const b = piece.cells[next];
        a.forEach((va, ia) => b.forEach((vb, ib) => {
            const pick = (v, cells, key) => v[key] ?? cells[0][key];
            joins.push({
                label: `${piece.name} ${slots[i]}#${ia}+${next}#${ib}`,
                passage: {
                    chords: [...va.chords, ...vb.chords],
                    melody: [...va.melody, ...vb.melody],
                    bass: [...pick(va, a, 'bass'), ...pick(vb, b, 'bass')],
                    counterNotes: [...pick(va, a, 'counterNotes'), ...pick(vb, b, 'counterNotes')],
                },
            });
        }));
    }
    return joins;
}

/** One piece: every invariant this songbook relies on. */
export function analyzePiece(piece, { fail, book = SONGBOOK }) {
    const bpb = piece.beatsPerBar;
    const night = piece.family === 'night';
    const opts = { beatsPerBar: bpb, bpm: piece.bpm, night, fail, book };
    const base = checkPassage(piece.name, piece, opts);
    const report = {
        name: piece.name, family: piece.family, bpm: piece.bpm, beatsPerBar: bpb, bars: piece.chords.length,
        seconds: round(piece.chords.length * bpb * 60 / piece.bpm, 1),
        range: base.range, onsetsPerBar: round(base.onsetsPerBar, 2),
    };
    if (base.onsetsPerBar < MELODY_DENSITY.min || base.onsetsPerBar > MELODY_DENSITY.max) fail(`${piece.name}: melody density ${report.onsetsPerBar}/bar`);
    // Identity (C3): a title, a key whose scale holds the signal cues'
    // pitches, its playlists, a meter, a comp that fits it, a feel and the
    // Isle Band's players.
    report.key = piece.key ? `${piece.key.tonic} ${piece.key.mode}` : '?';
    if (typeof piece.title !== 'string' || !piece.title.trim()) fail(`${piece.name}: no title`);
    if (!book.keyAllowed(piece.family, piece.key)) fail(`${piece.name}: key ${JSON.stringify(piece.key)} is not allowed for ${piece.family}`);
    if (!Array.isArray(piece.phases) || !piece.phases.includes(night ? 'night' : 'day') || piece.phases.some(p => !PHASES.includes(p))) {
        fail(`${piece.name}: phases ${JSON.stringify(piece.phases)} must include ${night ? 'night' : 'day'}`);
    }
    if (!book.METERS.includes(bpb)) fail(`${piece.name}: ${bpb} beats per bar`);
    if (!book.ENGINES.includes(piece.engine)) fail(`${piece.name}: unknown engine ${piece.engine}`);
    if (piece.engine === 'waltz' && bpb !== 3) fail(`${piece.name}: the waltz comp is 3/4`);
    if (piece.engine === 'jig' && bpb !== 6) fail(`${piece.name}: the jig comp is 6/8`);
    if (!book.FEELS.includes(piece.feel)) fail(`${piece.name}: unknown feel ${piece.feel}`);
    if (['lead', 'counter', 'engine', 'descant'].some(seat => !Array.isArray(piece.arrangement?.[seat]))) {
        fail(`${piece.name}: the arrangement seats a lead, a counter, an engine and a descant`);
    }
    const tonic = piece.key ? book.tonicChord(piece.key) : null;
    if (MUS5_DENSITY[piece.name] != null && Math.abs(base.onsetsPerBar - MUS5_DENSITY[piece.name]) > 0.01) {
        fail(`${piece.name}: melody density ${report.onsetsPerBar}/bar, MUS-5 notates ${MUS5_DENSITY[piece.name]}`);
    }
    // Bands (MUS-8 / MUSL-3): four, each a strict superset adding a player.
    if (!Array.isArray(piece.bands) || piece.bands.length !== 4) fail(`${piece.name}: needs four bands`);
    else {
        for (let b = 1; b < 4; b++) {
            const below = new Set(piece.bands[b - 1]);
            const added = piece.bands[b].filter(v => !below.has(v));
            if (added.length < BAND_SIZE_MIN_STEP || ![...below].every(v => piece.bands[b].includes(v))) fail(`${piece.name}: band ${b} adds no player`);
        }
        if (!piece.bands[0].includes('lead') || !piece.bands[0].includes('bass')) fail(`${piece.name}: band 0 is the tune and the bass`);
    }
    if (piece.bands?.flat().includes('descant')) {
        if (!piece.descantNotes) fail(`${piece.name}: descant admitted but not written`);
        else {
            const desc = timeline(piece.descantNotes);
            if (Math.abs(totalBeats(piece.descantNotes) - piece.chords.length * bpb) > EPS) fail(`${piece.name}: descant sums wrong`);
            for (const p of parallelPerfects(desc, base.low)) fail(`${piece.name} descant: parallel ${p.interval}s at beat ${p.at}`);
            const rd = range(desc);
            if (rd.high > (night ? RANGES.nightLeadHigh + 12 : 21)) fail(`${piece.name}: descant tops ${rd.high}`);
        }
    }
    // Cells (MUS-6): eight 2-bar slots, variant 0 canonical, ≥ 1 authored alternative each.
    let alternatives = 0;
    if (!piece.grammar || piece.grammar.length * 2 !== piece.chords.length) fail(`${piece.name}: grammar must cover the piece in 2-bar slots`);
    else {
        const concat = key => piece.grammar.flatMap(slot => piece.cells[slot][0][key]);
        for (const key of ['melody', 'bass', 'counterNotes']) {
            if (JSON.stringify(concat(key)) !== JSON.stringify(piece[key])) fail(`${piece.name}: variant-0 ${key} differs from the canonical`);
        }
        if (JSON.stringify(concat('chords')) !== JSON.stringify(piece.chords)) fail(`${piece.name}: variant-0 chords differ`);
        for (const slot of piece.grammar) {
            const variants = piece.cells[slot];
            if (variants.length < 2) fail(`${piece.name}: slot ${slot} has no authored alternative`);
            alternatives += variants.length - 1;
            variants.forEach((v, i) => {
                checkPassage(`${piece.name} ${slot}#${i}`, {
                    chords: v.chords, melody: v.melody,
                    bass: v.bass ?? piece.cells[slot][0].bass,
                    counterNotes: v.counterNotes ?? piece.cells[slot][0].counterNotes,
                }, opts);
                if (i > 0 && JSON.stringify(v.melody) === JSON.stringify(variants[0].melody)) fail(`${piece.name} ${slot}#${i}: same melody as canonical`);
            });
        }
        const joins = slotJoins(piece);
        for (const { label, passage } of joins) {
            for (const p of parallelPerfects(timeline(passage.melody), timeline(passage.bass))) {
                fail(`${label}: parallel ${p.interval}s at beat ${p.at}`);
            }
        }
        // The feel moves eighths, never pitches; the felt lead (every cell and
        // join) keeps the needs-you rule.
        if (piece.feel && piece.feel !== 'straight') {
            const lines = [
                ['', piece.melody],
                ...piece.grammar.flatMap(slot => piece.cells[slot].map((v, i) => [` ${slot}#${i}`, v.melody])),
                ...joins.map(({ label, passage }) => [` ${label.slice(piece.name.length + 1)}`, passage.melody]),
            ];
            for (const [label, melody] of lines) {
                for (const q of quickPairs(timeline(book.applyFeel(melody, piece.feel)), 60 / piece.bpm)) {
                    fail(`${piece.name}${label}: ${piece.feel} makes a quick same-pitch pair at beat ${q.at}`);
                }
            }
        }
    }
    report.alternatives = alternatives;
    report.renditions = piece.grammar ? piece.grammar.reduce((n, slot) => n * piece.cells[slot].length, 1) : 1;
    // Phrase ends (MUS-9): a deceptive chord and bass over each arrival bar; the melody stays.
    if (!piece.phraseEnds?.length) fail(`${piece.name}: no deceptive phrase ends`);
    for (const end of piece.phraseEnds || []) {
        const canon = piece.chords[end.bar];
        if (canon !== tonic) fail(`${piece.name}: phrase end bar ${end.bar} is ${JSON.stringify(canon)}, not the tonic ${tonic}`);
        const barMelody = sliceNotes(piece.melody, end.bar * bpb, (end.bar + 1) * bpb);
        const deceptive = book.chordPitchClasses(end.chord);
        const barLine = timeline(barMelody, { offset: 0 });
        // The melody on the arrival downbeat is a tone of the deceptive chord.
        const downbeat = soundingAt(barLine, 0);
        if (downbeat && deceptive && !deceptive.pcs.includes(pcOfSemi(downbeat.pitch))) fail(`${piece.name}: arrival melody ${downbeat.pitch} is not in ${end.chord}`);
        // The replaced bar between its neighbours (the next bar wraps to bar 1).
        const around = (label, chord, melodyBar, bassBar) => {
            const prev = end.bar - 1;
            const next = (end.bar + 1) % piece.chords.length;
            const bar = (key, i) => sliceNotes(piece[key], i * bpb, (i + 1) * bpb);
            checkPassage(`${piece.name} ${label} bar ${end.bar}`, {
                chords: [piece.chords[prev], chord, piece.chords[next]],
                melody: [...bar('melody', prev), ...melodyBar, ...bar('melody', next)],
                bass: [...bar('bass', prev), ...bassBar, ...bar('bass', next)],
            }, opts);
        };
        around('deceptive', end.chord, barMelody, end.bass);
        if (!end.home) fail(`${piece.name}: phrase end bar ${end.bar} has no home landing`);
        else {
            if (Math.abs(totalBeats(end.home.melody) - bpb) > EPS) fail(`${piece.name}: home landing must fill one bar`);
            around('home', canon, end.home.melody, end.home.bass ?? sliceNotes(piece.bass, end.bar * bpb, (end.bar + 1) * bpb));
        }
    }
    // Interlude (6.7): 40–50 % of the piece's melodic density.
    if (!piece.interlude) fail(`${piece.name}: no interlude`);
    else {
        const il = checkPassage(`${piece.name} interlude`, piece.interlude, opts);
        report.interludeDensity = round(il.onsetsPerBar / base.onsetsPerBar, 2);
        if (report.interludeDensity < INTERLUDE_DENSITY.min || report.interludeDensity > INTERLUDE_DENSITY.max) {
            fail(`${piece.name}: interlude density ${report.interludeDensity} of the piece's`);
        }
    }
    // Tag (MUS-11): two bars replacing the last bar, ending on the tonic.
    if (!piece.tag) fail(`${piece.name}: no tag ending`);
    else {
        if (piece.tag.chords.length !== 2) fail(`${piece.name}: tag must be two bars`);
        const bars = piece.chords.length;
        const pre = { melody: sliceNotes(piece.melody, (bars - 2) * bpb, (bars - 1) * bpb), bass: sliceNotes(piece.bass, (bars - 2) * bpb, (bars - 1) * bpb) };
        checkPassage(`${piece.name} tag`, {
            chords: [piece.chords[bars - 2], ...piece.tag.chords],
            melody: [...pre.melody, ...piece.tag.melody], bass: [...pre.bass, ...piece.tag.bass],
        }, opts);
        const last = piece.tag.chords[1];
        if ((Array.isArray(last) ? last[last.length - 1] : last) !== tonic) fail(`${piece.name}: tag does not end home on ${tonic}`);
    }
    // Season colours (MUS-16): the last two bars' chords replaced; a replaced
    // chord never rubs (semitone or tritone) against the tune over it.
    const bars = piece.chords.length;
    for (const [row, colour] of Object.entries(piece.colour || {})) {
        if (!colour) continue;
        if (colour.chords.length !== 2) { fail(`${piece.name}: colour ${row} must replace two bars`); continue; }
        const canon = chordSpans(piece.chords.slice(-2), bpb, (bars - 2) * bpb);
        const lead = timeline(piece.melody);
        chordSpans(colour.chords, bpb, (bars - 2) * bpb).forEach((span, i) => {
            if (canon[i]?.name === span.name && canon[i]?.dur === span.dur) return;
            const pcs = book.chordPitchClasses(span.name);
            if (!pcs) { fail(`${piece.name}: colour ${row} unknown chord ${span.name}`); return; }
            if (routineRoleClashes(pcs).length) fail(`${piece.name}: colour ${row} ${span.name} clashes with routine roles`);
            for (const note of lead) {
                if (note.start >= span.start + span.dur - EPS || note.start + note.dur <= span.start + EPS) continue;
                if (pcs.pcs.some(tone => CLASH.has(mod12(pcOfSemi(note.pitch) - tone)))) fail(`${piece.name}: colour ${row} ${span.name} rubs against the tune at beat ${note.start}`);
            }
        });
    }
    // The descant rides above the tune and is no bell pair either.
    if (piece.descantNotes) {
        const desc = timeline(piece.descantNotes);
        for (const c of crossings(desc, base.lead)) fail(`${piece.name}: descant under the tune at beat ${c.at}`);
        for (const q of quickPairs(desc, 60 / piece.bpm)) fail(`${piece.name}: descant quick same-pitch pair at beat ${q.at}`);
    }
    // Percussion rows (6.9): one per building, beatsPerBar × 4 steps of weights in [0, 1].
    const steps = bpb * 4;
    for (const building of Object.keys(book.PERCUSSION_VOICE)) {
        const row = piece.percussion?.[building];
        if (!row || row.length !== steps || row.some(w => !(w >= 0 && w <= 1))) fail(`${piece.name}: percussion row ${building} must be ${steps} weights in [0, 1]`);
    }
    report.percussionWeight = piece.percussion ? round(Object.values(piece.percussion).flat().reduce((a, b) => a + b, 0) / Object.keys(piece.percussion).length, 2) : 0;
    return report;
}

/** The whole songbook: pieces, stingers, playlists. */
export function analyzeSongbook(book = SONGBOOK) {
    const failures = [];
    const fail = msg => failures.push(msg);
    const pieces = book.PIECES.map(piece => analyzePiece(piece, { fail, book }));
    const names = new Set(book.PIECES.map(p => p.name));
    if (names.size !== book.PIECES.length) fail('two pieces share a name');
    for (const [label, stinger, night] of [
        ['NIGHTFALL_TAG', book.NIGHTFALL_TAG, true],
        ['RELEASE_FANFARE day', book.RELEASE_FANFARE.day, false],
        ['RELEASE_FANFARE night', book.RELEASE_FANFARE.night, true],
    ]) {
        checkPassage(label, stinger, { beatsPerBar: stinger.beatsPerBar, bpm: stinger.bpm, night, fail, book });
    }
    for (const [phase, list] of Object.entries(book.PLAYLISTS)) {
        for (const name of list) if (!names.has(name)) fail(`playlist ${phase}: unknown piece ${name}`);
    }
    if (book.PLAYLISTS.day.length < 4) fail('playlist day: fewer than four pieces');
    return { pieces, failures };
}

function printReport({ pieces, failures }) {
    const meter = bpb => (bpb === 6 ? '6/8' : `${bpb}/4`);
    const rows = pieces.map(p => `${p.name.padEnd(13)} ${p.family.padEnd(5)} ${p.key.padEnd(8)} ${String(p.bpm).padStart(3)} bpm ${meter(p.beatsPerBar)} ${String(p.seconds).padStart(5)} s  lead ${p.range.low}…${p.range.high}  ${String(p.onsetsPerBar).padStart(4)} onsets/bar  alts ${p.alternatives}  renditions ${p.renditions}  interlude ${p.interludeDensity}`);
    console.log('pieces');
    for (const row of rows) console.log(`  ${row}`);
    console.log(failures.length ? `FAIL: ${failures.length}` : 'OK: 0 parallels, 0 % routine-cue clash, every invariant holds');
    for (const f of failures) console.log(`  ${f}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
    const result = analyzeSongbook();
    printReport(result);
    process.exitCode = result.failures.length ? 1 : 0;
}
