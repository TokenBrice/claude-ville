// The probe's Wave-3 rows (3.1–3.8): the cue gallery's discrimination
// features, the ladder, wake, cluster, outcome, caption and honesty
// measurements. Every function returns numbers; probe.mjs judges them with
// lib/checks.mjs and prints the lines.
import { analyze, loudness, noteName, peaks } from './analyze.mjs';
import { marginAt } from './timeline.mjs';
import { limiterGainReduction, maxGrIn, phaseLockedPairs, quickSamePitchOpening } from './checks.mjs';
import { CLUSTER_AT, CLUSTER_KIND, GALLERY_VOICES, gallerySlots } from './scenes.mjs';
import { cueFeatures } from '../metrics/discrim.mjs';
import { AUDIBILITY_WINDOWS, PROGRAM_TRIM_DB } from '../../../claudeville/src/presentation/shared/audio/Loudness.js';
import { CUE_ACCENT_NOTE } from '../../../claudeville/src/presentation/shared/audio/CueScore.js';

const MARGIN = { bedWindowSec: AUDIBILITY_WINDOWS.bedWindowSec, cueWindowSec: 2.5, silenceFloorLufs: -80 };
const volumeDb = step => (step > 0 ? (step - 10) * 3.6 : -Infinity);
const toDb = x => (x > 0 ? 20 * Math.log10(x) : -Infinity);
const outputGainDb = r => PROGRAM_TRIM_DB + volumeDb(r.meta.volumeStep ?? 6);

function slice(pair, sr, t0, t1) {
    const a = Math.max(0, Math.round(t0 * sr));
    const b = Math.min(pair.L.length, Math.round(t1 * sr));
    return { L: pair.L.subarray(a, b), R: pair.R.subarray(a, b) };
}

function mono(pair) {
    const m = new Float32Array(pair.L.length);
    for (let i = 0; i < m.length; i++) m[i] = 0.5 * (pair.L[i] + pair.R[i]);
    return m;
}

// The first non-silent published score of `kind` raised in [t0, t1].
function scoreIn(scheduled, kinds, t0, t1, agentId = null) {
    return scheduled.find(s => !s.silent && kinds.includes(s.kind) && s.t >= t0 - 0.002 && s.t <= t1
        && (agentId == null || s.agentId == null || s.agentId === agentId)) ?? null;
}

// ------------------------------------------------------------- gallery ----
// Each gallery voice: its published notes (ms from the first, with the
// resolved pitch the tree publishes; a tree that publishes no pitch falls
// back to the pitch measured at the nearest onset) and its render's
// discrimination features.
export function galleryRows(r, voices = GALLERY_VOICES) {
    const slots = gallerySlots(voices);
    const warm = r.meta.warmup;
    return slots.map((slot) => {
        const t0 = warm + slot.at;
        const t1 = warm + slot.end;
        const score = scoreIn(r.meta.scheduled, [slot.kind], t0 - 0.01, t0 + 2);
        if (!score) return { ...slot, missing: 'no sounding score' };
        const start = score.notes[0];
        const cut = slice(r.stems.cue, r.sr, start - 0.25, t1);
        const { metrics } = analyze(cut.L, cut.R, r.sr);
        const measured = (metrics.onsets.pitches || []).map((p, i) => ({ t: metrics.onsets.times[i] - 0.25, note: p?.note ?? null }));
        const published = score.hz?.some(h => h > 0);
        const notes = score.notes.map((t, i) => {
            const ms = Math.round((t - start) * 1000);
            const hz = score.hz?.[i] ?? null;
            if (hz > 0) return { ms, hz, name: noteName(hz).name };
            if (published) return { ms, hz: null, name: null };
            const near = measured.filter(m => m.note).sort((a, b) => Math.abs(a.t - ms / 1000) - Math.abs(b.t - ms / 1000))[0];
            return { ms, hz: null, name: near?.note ?? null };
        });
        // Unpitched notes (ticks, clicks, whooshes) take the last pitch
        // before them, else the first after, else A4: they add no interval.
        const firstName = notes.find(n => n.name)?.name ?? 'A4';
        let last = firstName;
        const named = notes.map((n) => { if (n.name) last = n.name; return [n.ms, n.name ?? last]; });
        const melody = [];
        for (const n of notes) if (!melody.some(m => m.ms === n.ms)) melody.push(n);
        const features = cueFeatures({ label: slot.label, notes: named }, { ...cut, sampleRate: r.sr, metrics });
        return {
            ...slot, notes, pitchSource: published ? 'published' : 'measured', features,
            quickPair: slot.stratum !== 'signal' && quickSamePitchOpening(melody),
            momentaryMaxLufs: metrics.loudness.momentaryMaxLUFS + outputGainDb(r),
        };
    });
}

// ---------------------------------------------------------------- ladder ----
// Sound off: the signal route's calls as captions (entry and reminders),
// and what the default-setting Toast rendered for them.
export function ladderCalls(meta) {
    const calls = meta.cues.filter(c => ['summons', 'distress', 'limit', 'reminder'].includes(c.kind) && !c.flock);
    return calls.map(c => ({ atSec: c.t, level: c.kind === 'reminder' ? c.level : (c.level ?? 1), reminder: c.kind === 'reminder', kind: c.kind, family: c.family }));
}

export function ladderCaptioned(meta, calls) {
    const shown = meta.captions || [];
    return calls.filter(c => shown.some(s => Math.abs(s.t - c.atSec) <= 1.5 && (s.cueKind === c.kind || s.cueKind === 'attention'))).length;
}

// Published note times are on the page clock; with `freezeOnSuspend` the
// audio clock stops while the context is suspended, so a wall time maps to
// audio time through the context's last state change before it.
export function wallToAudio(states, wall) {
    const last = [...states].reverse().find(s => s.wall != null && s.wall <= wall);
    if (!last) return wall;
    return last.state === 'running' ? last.t + (wall - last.wall) : last.t;
}

// Hidden with sound on: each reminder's first note (wall time) and whether
// it rendered on the cue stem (≥ −60 dBFS within 1 s of its audio time).
export function wakeRows(r) {
    const cue = mono(r.stems.cue);
    const rows = [];
    for (const s of r.meta.scheduled.filter(x => x.kind === 'reminder')) {
        const wall = s.notes[0];
        const t = wallToAudio(r.meta.contextStates, wall);
        const a = Math.round(t * r.sr);
        const seg = cue.subarray(Math.max(0, a), Math.min(cue.length, a + r.sr));
        const peakDb = seg.length ? toDb(peaks(seg).sample) : -Infinity;
        rows.push({ wall, audio: t, silent: s.silent, peakDb, heard: !s.silent && peakDb >= -60 });
    }
    const hides = r.meta.contextStates.filter(x => x.state === 'suspended').length;
    return { rows, suspensions: hides, wakes: r.meta.contextStates.filter(x => x.state === 'running').length };
}

// Sound on: every sounding ladder call (the L1 entry summons, then the
// reminders) with its margin over the bed, limiter GR and cue trim, and
// the call's own level: the cue stem's M max over [t, t + 2.5 s] at the
// output (over music a quiet reminder's program margin reads the band).
export function ladderTrimRows(r) {
    const lou = loudness(r.program.L, r.program.R, r.sr);
    const gr = limiterGainReduction(r.stems.limiterIn.L, r.stems.limiterIn.R, r.stems.limiterOut.L, r.stems.limiterOut.R, r.sr);
    const cueMax = (t) => {
        if (!r.stems.cue) return null;
        const cut = slice(r.stems.cue, r.sr, t, t + MARGIN.cueWindowSec);
        return loudness(cut.L, cut.R, r.sr).momentaryMax + outputGainDb(r);
    };
    return r.meta.scheduled.filter(s => !s.silent && (s.kind === 'summons' || s.kind === 'reminder')).map((s) => {
        const t = s.notes[0];
        const cue = r.meta.cues.filter(c => c.kind === s.kind).sort((a, b) => Math.abs(a.t - s.t) - Math.abs(b.t - s.t))[0];
        const level = r.meta.levels.filter(l => l.kind === s.kind).sort((a, b) => Math.abs(a.t - s.t) - Math.abs(b.t - s.t))[0];
        return {
            kind: s.kind, t, level: s.kind === 'reminder' ? cue?.level ?? null : (cue?.level ?? 1),
            margin: marginAt(lou.momentaryCurve, t, MARGIN).margin, grDb: maxGrIn(gr, t, t + MARGIN.cueWindowSec),
            cueMaxLufs: cueMax(t),
            trimDb: level && Math.abs(level.t - s.t) < 0.5 ? level.trimDb ?? null : null,
        };
    });
}

// --------------------------------------------------------------- cluster ----
// Program M-max over the 4 s after the raise, captions per agent, the
// urgent GR, and phase-locked pairs among the family's sounding scores.
export function clusterRow(r, family = 'needsYou') {
    const kind = CLUSTER_KIND[family];
    const t = r.meta.warmup + CLUSTER_AT;
    const lou = loudness(r.program.L, r.program.R, r.sr);
    const mMax = Math.max(...lou.momentaryCurve.filter(([end]) => end - 0.2 >= t && end - 0.2 <= t + 4).map(([, v]) => v));
    const agents = r.meta.markers.filter(m => m.label === `open ${family}`).map(m => m.agentId);
    const captioned = [...new Set(r.meta.cues.filter(c => c.kind === kind).map(c => c.agentId))];
    const gr = limiterGainReduction(r.stems.limiterIn.L, r.stems.limiterIn.R, r.stems.limiterOut.L, r.stems.limiterOut.R, r.sr);
    const scores = r.meta.scheduled.filter(s => !s.silent && s.kind === kind).map(s => ({ kind: s.kind, agentId: s.agentId, notes: s.notes }));
    // The lead call and its flock strikes each publish a summons score.
    return {
        mMaxLufs: mMax, agents, captioned, grDb: maxGrIn(gr, t, t + 4),
        sounding: scores.length, flock: Math.max(0, scores.length - 1), phaseLocked: phaseLockedPairs(scores),
    };
}

// -------------------------------------------------------------- outcomes ----
// Per fixture lane: the cue-played events and sounding scores after its
// marker (within `withinSec`), for the outcome acceptance lines.
export function laneEvents(r, lane, { withinSec = 4, kinds = null } = {}) {
    const marks = r.meta.markers.filter(m => m.lane === lane);
    if (!marks.length) return { marks: 0, cues: [], scores: [] };
    const t0 = marks[0].t;
    const t1 = marks[marks.length - 1].t + withinSec;
    const want = kinds || [lane];
    return {
        marks: marks.length,
        cues: r.meta.cues.filter(c => want.includes(c.kind) && c.t >= t0 - 0.002 && c.t <= t1),
        scores: r.meta.scheduled.filter(s => want.includes(s.kind) && s.t >= t0 - 0.002 && s.t <= t1),
    };
}

// The release crown (HAR-12): the published carrying note of the peal vs
// the accent the "renderer" declared, and the note as heard on the cue stem.
export function crownRow(r, onsetNear) {
    const a = r.meta.accents.find(x => x.kind === 'release');
    if (!a) return null;
    const s = r.meta.scheduled.find(x => !x.silent && x.kind === 'release' && x.t >= a.t - 0.002);
    const index = CUE_ACCENT_NOTE.release ?? null;
    const note = s && index != null ? s.notes[index] : null;
    const heard = note != null ? onsetNear(mono(r.stems.cue), r.sr, note) : null;
    return {
        index, accent: a.accentT, published: note,
        publishedMs: note != null ? (note - a.accentT) * 1000 : null,
        heardMs: heard != null ? (heard - a.accentT) * 1000 : null,
    };
}

// -------------------------------------------------------------- captions ----
// One caption-parity run → rows { kind, setting, soundOn, played, shown,
// heard, announceOnly }.
export function captionRows(meta, { settings, soundOn }) {
    const rows = [];
    const t = x => x.t ?? x.wall;
    for (const m of meta.markers.filter(x => x.kind === 'event' && x.cueKind)) {
        const kind = m.cueKind;
        const inWin = x => t(x) >= m.t - 0.002 && t(x) <= m.t + 6;
        const cues = meta.cues.filter(c => c.kind === kind && inWin(c) && (m.agentId == null || c.agentId == null || c.agentId === m.agentId));
        const played = cues.length > 0;
        const announceOnly = played && cues.every(c => c.announceOnly);
        const heard = soundOn ? meta.scheduled.some(s => s.kind === kind && !s.silent && inWin(s)) : null;
        for (const setting of settings) {
            const shown = (meta.captions || []).some(c => c.setting === setting && inWin(c) && c.cueKind === kind);
            rows.push({ kind, setting, soundOn, played, shown, heard, announceOnly });
        }
    }
    return rows;
}
