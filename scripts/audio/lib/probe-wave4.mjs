// The probe's Wave-4 measurements ("the island: the world stratum") on the
// virtual clock (lib/virtual.mjs): the world scene map, the world stem's
// hash (S6), the sea's own account and its stem, thunder strikes against
// their storm, cue margins inside a thunder roll and on a sea crest. Every
// function returns numbers; probe.mjs judges them through checks.mjs.
import { loudness, onsets } from './analyze.mjs';
import { marginAt } from './timeline.mjs';
import { sceneMetrics } from './probe-virtual.mjs';
import { cpuProxyPct, crestRate, limiterGainReduction, maxGrIn, nearestCrest } from './checks.mjs';
import { repetition } from '../metrics/amb-metrics.mjs';
import { midOf, welch } from '../metrics/dsp.mjs';
import { AUDIBILITY_WINDOWS, PROGRAM_TRIM_DB } from '../../../claudeville/src/presentation/shared/audio/Loudness.js';

const volumeDb = step => (step > 0 ? (step - 10) * 3.6 : -Infinity);

function slice(pair, sr, a, b) {
    const i = Math.max(0, Math.round(a * sr));
    const j = Math.min(pair.L.length, Math.round(b * sr));
    return { L: pair.L.subarray(i, j), R: pair.R.subarray(i, j) };
}

const recorded = (r, pair) => slice(pair, r.sr, r.meta.warmup, r.meta.warmup + r.meta.seconds);

// Band level (dB, Welch PSD summed over [lo, hi) Hz, both channels): only
// differences between two such numbers mean anything.
export function bandLevelDb({ L, R }, sr, lo, hi) {
    const psd = welch([L, R]);
    const N = (psd.length - 1) * 2;
    let e = 0;
    for (let k = 1; k < psd.length; k++) {
        const f = (k * sr) / N;
        if (f >= lo && f < hi) e += psd[k];
    }
    return e > 0 ? 10 * Math.log10(e) : -Infinity;
}

// The largest sample difference of two stems (0 when bit-identical,
// Infinity when their lengths differ).
export function maxSampleDiff(a, b) {
    if (a.L.length !== b.L.length) return Infinity;
    let d = 0;
    for (let i = 0; i < a.L.length; i++) d = Math.max(d, Math.abs(a.L[i] - b.L[i]), Math.abs(a.R[i] - b.R[i]));
    return d;
}

// The first time (s) at which two stems differ by more than `threshold`, or null.
export function firstDivergenceSec(a, b, sr, threshold) {
    const n = Math.min(a.L.length, b.L.length);
    for (let i = 0; i < n; i++) {
        if (Math.abs(a.L[i] - b.L[i]) > threshold || Math.abs(a.R[i] - b.R[i]) > threshold) return i / sr;
    }
    return null;
}

// ------------------------------------------------------------ world map ----
// One map cell: the program (the world stratum: work and music faders at 0)
// after warmup — loudness, its 2–5 kHz band, onsets per minute (the band-rise
// detector of analyze.mjs on the program's mid) — and the CPU proxy of the
// whole render.
export function worldCellRow(r) {
    const m = sceneMetrics(r);
    const program = recorded(r, r.program);
    const onsetCount = onsets(midOf(program.L, program.R), r.sr).length;
    return {
        lufsI: m.lufsI, stMax: m.stMax, stMean: m.stMean, stMin: m.stMin,
        presenceDb: bandLevelDb(program, r.sr, 2000, 5000),
        onsetsPerMin: (60 * onsetCount) / r.meta.seconds,
        cpuPct: cpuProxyPct(r.meta.renderMs, r.meta.warmup + r.meta.seconds),
        dayArc: r.meta.finalSnapshot?.dayArc ?? null,
        errors: r.errors,
    };
}

// ------------------------------------------------------------------ sea ----
// The sea alone on the world stem: loudness as heard at the output (the
// stem tap sits before the program trim and the volume), repetition and
// ICC, breaks per minute from the sea's committed crests, rare voices and
// node creations from its snapshot.
export function seaStemRow(r) {
    const pair = recorded(r, r.stems.world);
    const lou = loudness(pair.L, pair.R, r.sr);
    const rep = repetition(pair.L, pair.R, r.sr);
    const sea = r.meta.sea || null;
    const t0 = r.meta.warmup;
    const t1 = r.meta.warmup + r.meta.seconds;
    return {
        lufsOut: lou.integrated + PROGRAM_TRIM_DB + volumeDb(r.meta.volumeStep ?? 6),
        icc: rep.icc, r4: rep.r4, peak: rep.peak,
        breaksPerMin: sea?.crests ? crestRate(sea.crests, t0, t1) : null,
        crests: sea?.crests?.length ?? null,
        rare: sea?.rare ?? [],
        nodeCreations: sea?.nodeCreations ?? null,
        yields: sea?.yields ?? null,
        snapshot: Boolean(sea && !sea.error),
        cpuPct: cpuProxyPct(r.meta.renderMs, r.meta.warmup + r.meta.seconds),
    };
}

export function worldBandDb(r, lo, hi) {
    return bandLevelDb(recorded(r, r.stems.world), r.sr, lo, hi);
}

// -------------------------------------------------------------- thunder ----
// Each flash (in order) against the first thunder score published at or
// after it: the onset (its first note), the delay from the flash, the LU
// over the 3 s of storm before the onset (max momentary in [onset, onset +
// 8 s], the roll), the limiter GR over the roll and the pool-buffer reads
// that started on the cue path at the onset (the strike's noise grain).
const THUNDER_ROLL_SEC = 8;

export function thunderRows(r) {
    const lou = loudness(r.program.L, r.program.R, r.sr);
    const gr = limiterGainReduction(r.stems.limiterIn.L, r.stems.limiterIn.R, r.stems.limiterOut.L, r.stems.limiterOut.R, r.sr);
    const flashes = r.meta.markers.filter(m => m.label?.startsWith('storm-flash'));
    const scores = r.meta.scheduled.filter(s => s.kind === 'thunder' && !s.silent && s.notes.length).sort((a, b) => a.notes[0] - b.notes[0]);
    const used = new Set();
    const rows = flashes.map((f) => {
        const intensity = Number(f.label.split(' ')[1]);
        const score = scores.find(s => !used.has(s) && s.notes[0] >= f.t - 0.01);
        if (!score) return { intensity, flashT: f.t, onset: null, margin: null, delaySec: null, grDb: null, grains: [] };
        used.add(score);
        const onset = score.notes[0];
        const mg = marginAt(lou.momentaryCurve, onset, { bedWindowSec: AUDIBILITY_WINDOWS.bedWindowSec, cueWindowSec: THUNDER_ROLL_SEC, silenceFloorLufs: -80 });
        const grains = (r.meta.starts || []).filter(s => s.cue && s.buf != null && Math.abs(s.t - onset) < 0.5).map(s => ({ buf: s.buf, off: s.off, end: s.off + ((Number.isFinite(s.e) ? s.e : s.t + THUNDER_ROLL_SEC) - s.t) * (s.rate ?? 1) }));
        return { intensity, flashT: f.t, onset, margin: mg.margin, bedLufs: mg.bed, delaySec: onset - f.t, grDb: maxGrIn(gr, onset, onset + THUNDER_ROLL_SEC), grains };
    });
    const ducks = r.meta.ducks.filter(d => Object.values(d.depths || {}).some(v => v < 0));
    const m = sceneMetrics(r);
    return { rows, ducks, stMax: m.stMax, lufsI: m.lufsI, grMaxDb: m.grMaxDb, extraScores: scores.length - used.size };
}

// ------------------------------------------------------- cue vs its bed ----
// Must-never 8, beside the S2 margin: the cue stem's max momentary over its
// 2.5 s against the world stem's energy over the same 2.5 s (both at bus
// staging, before the program trim) — how far the signal stands over the
// weather while both sound.
export function concurrentOverBedLu(r, t, { windowSec = 2.5 } = {}) {
    const cue = slice(r.stems.cue, r.sr, t, t + windowSec);
    const bed = slice(r.stems.world, r.sr, t, t + windowSec);
    const cueMax = loudness(cue.L, cue.R, r.sr).momentaryMax;
    const bedMom = loudness(bed.L, bed.R, r.sr).momentaryCurve.map(([, v]) => v).filter(Number.isFinite);
    if (!bedMom.length || !Number.isFinite(cueMax)) return null;
    const e = bedMom.reduce((s, v) => s + Math.pow(10, (v + 0.691) / 10), 0) / bedMom.length;
    return cueMax - (-0.691 + 10 * Math.log10(e));
}

// ----------------------------------------------------------------- crest ----
// The loudest crest in [from, to] (audio s) of a cue-free render.
export function loudestCrest(r, from, to) {
    const crests = (r.meta.sea?.crests || []).filter(c => c.t >= from && c.t <= to);
    return crests.reduce((best, c) => (!best || (c.amp ?? 0) > (best.amp ?? 0) ? c : best), null);
}

export function crestGap(r, t) {
    return nearestCrest(r.meta.sea?.crests || [], t);
}
