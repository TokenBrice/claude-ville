// The probe's Wave-5 measurements ("the work: workshop voices") on the
// virtual clock (lib/virtual.mjs): the workshop layer's published strikes
// (`audio:work-scheduled`, meta.work) against the scene's own facts — the
// stops, the drawn downbeats, the poll — and the workshop stratum isolated
// as the difference of two sample-aligned renders (ctx − env: one seed, the
// Workshops fader at 0 in env). Every function returns numbers; probe.mjs
// judges them through checks.mjs.
import { loudness, peaks } from './analyze.mjs';
import { laneMarginRows, sceneMetrics } from './probe-virtual.mjs';
import { bandLevelDb } from './probe-wave4.mjs';
import { median, percentile } from './checks.mjs';
import { bandEnvelope, riseAt } from '../metrics/fol-analyze.mjs';
import { PROGRAM_TRIM_DB } from '../../../claudeville/src/presentation/shared/audio/Loudness.js';
import { BUILDING_WORLD, placeFromCamera } from '../../../claudeville/src/presentation/shared/audio/SpatialField.js';
import { RITUAL_GESTURE_PERIOD_MS, RITUAL_POSE_BY_BUILDING } from '../../../claudeville/src/presentation/character-mode/RitualConductor.js';

const volumeDb = step => (step > 0 ? (step - 10) * 3.6 : -Infinity);
const toDb = x => (x > 0 ? 20 * Math.log10(x) : -Infinity);
// Output-referred: a bus or cue tap sits before the program trim and volume.
export const outputGainDb = r => PROGRAM_TRIM_DB + volumeDb(r.meta.volumeStep ?? 6);

export const HARBOR_WORLD = BUILDING_WORLD.harbor;

// A building's gesture period (s): the renderer's own table.
export function periodSec(building) {
    return RITUAL_GESTURE_PERIOD_MS[RITUAL_POSE_BY_BUILDING[building]] / 1000;
}

function slice(pair, sr, a, b) {
    const i = Math.max(0, Math.round(a * sr));
    const j = Math.min(pair.L.length, Math.round(b * sr));
    return { L: pair.L.subarray(i, j), R: pair.R.subarray(i, j) };
}

// a − b, sample by sample (two renders of one seed).
export function diffPair(a, b) {
    const n = Math.min(a.L.length, b.L.length);
    const L = new Float32Array(n);
    const R = new Float32Array(n);
    for (let i = 0; i < n; i++) { L[i] = a.L[i] - b.L[i]; R[i] = a.R[i] - b.R[i]; }
    return { L, R };
}

function sumPairs(a, b) {
    const n = Math.min(a.L.length, b.L.length);
    const L = new Float32Array(n);
    const R = new Float32Array(n);
    for (let i = 0; i < n; i++) { L[i] = a.L[i] + b.L[i]; R[i] = a.R[i] + b.R[i]; }
    return { L, R };
}

const midOf = ({ L, R }) => {
    const m = new Float32Array(L.length);
    for (let i = 0; i < m.length; i++) m[i] = 0.5 * (L[i] + R[i]);
    return m;
};

// The published strikes inside [from, to] (audio s), in time order, less
// the booked ones the layer stopped before they sounded
// (`audio:work-cancelled`).
export function strikesOf(r, { from = r.meta.warmup, to = r.meta.warmup + r.meta.seconds } = {}) {
    const cancelled = r.meta.workCancelled || [];
    const gone = s => cancelled.some(c => c.building === s.building && (c.agentId ?? null) === (s.agentId ?? null) && Math.abs(c.at - s.at) < 0.001);
    return (r.meta.work || []).filter(s => Number.isFinite(s.at) && s.at >= from && s.at <= to && !gone(s)).sort((a, b) => a.at - b.at);
}

// Onsets: a flam cluster (the 2nd/3rd smith on one downbeat, FOL-4) is one.
export const onsetsOf = strikes => strikes.filter(s => !s.flam);

// C-FOL-1 (INFO): strikes on their building's gesture grid (k·P_b on the
// wall clock) within `tolMs`, as a share.
export function gridShare(strikes, { tolMs = 15 } = {}) {
    const on = strikes.filter(s => !s.flam && Number.isFinite(s.wallMs)).map((s) => {
        const P = periodSec(s.building) * 1000;
        return Math.abs(s.wallMs - Math.round(s.wallMs / P) * P) <= tolMs;
    });
    return on.length ? on.filter(Boolean).length / on.length : null;
}

// The action marker labelled `label` (its audio time), or null.
export const markerAt = (r, label) => r.meta.markers.find(m => m.label === label)?.t ?? null;

// ------------------------------------------------------------ 5.1 timing ----
// The reference scene's Forge: its longest gap while it works and its stop
// (F1 + F2 go idle together; F3 went stale before), and zero accents from
// the stale smith after its stale observation.
export function forgeRow(r, { stopLabel, staleLabel, staleAgentIndex }) {
    const stopSec = markerAt(r, stopLabel);
    const staleSec = markerAt(r, staleLabel);
    const forge = strikesOf(r, { from: 0, to: Infinity }).filter(s => s.building === 'forge');
    const staleId = r.meta.markers.find(m => m.label === staleLabel)?.agentId ?? `har-${staleAgentIndex + 1}`;
    return {
        stopSec, staleSec, periodSec: periodSec('forge'),
        times: forge.map(s => s.at),
        active: forge.filter(s => s.at >= r.meta.warmup && s.at <= stopSec).map(s => s.at),
        staleAccents: forge.filter(s => s.agentId === staleId && s.at > staleSec).length,
    };
}

// S6: strikes in each honesty window, and the linkLost cue's time.
export function honestyRows(r, { freshAt, idleAt, againAt, dropAt }) {
    const w = r.meta.warmup;
    const all = strikesOf(r, { from: 0, to: Infinity });
    const lostAt = r.meta.cues.find(c => c.kind === 'linkLost')?.t ?? null;
    const P = periodSec('forge');
    const count = (a, b) => all.filter(s => s.at >= a && s.at < b).length;
    const tail = lostAt != null ? slice(r.stems.work, r.sr, lostAt + 4, r.meta.warmup + r.meta.seconds) : null;
    const pre = slice(r.stems.work, r.sr, w + againAt + 1, w + dropAt);
    const lou = pair => loudness(pair.L, pair.R, r.sr).integrated + outputGainDb(r);
    return {
        staleOnly: count(0, w + freshAt), fresh: count(w + freshAt, w + idleAt), idle: count(w + idleAt + P, w + againAt),
        again: count(w + againAt, w + dropAt), lostAt, afterLost: lostAt != null ? count(lostAt + 0.35, Infinity) : null,
        workLufsBefore: lou(pre), workLufsAfterLost: tail ? lou(tail) : null,
    };
}

// FOL-5: accents (flam followers excluded: they sit +28/+56 ms after their
// lead by design and carry its downbeat), the drawn downbeats (Date.now ms),
// every onset and the grid share.
export function downbeatRows(r) {
    const all = strikesOf(r);
    return {
        accents: all.filter(s => s.kind === 'accent' && !s.flam),
        drawn: r.meta.rituals || [],
        onsets: onsetsOf(all).map(s => s.at),
        grid: gridShare(all),
    };
}

// Main-thread cost per tick (INFO): the director's 1 Hz tick and the
// Transport's 250 ms tick (the layer schedules inside it), real ms.
export function tickRows(r) {
    const site = re => (r.meta.timers || []).find(t => re.test(t.site)) || null;
    const row = t => (t ? { site: t.site, fired: t.fired, p95Ms: t.p95Ms, maxMs: t.maxMs } : null);
    return { director: row(site(/AudioDirector\.js/)), transport: row(site(/Transport\.js/)), layer: r.meta.workshops?.scheduleMs ?? null };
}

// ------------------------------------------------------------- 5.3 level ----
// The workshop stratum (dry work bus + its air return, ctx − env) and the
// program with and without it, output-referred; the strikes' 2–5 kHz
// share at their onsets; accents heard per building.
export function workLevelRow(ctx, env) {
    const w = ctx.meta.warmup;
    const end = w + ctx.meta.seconds;
    const gain = outputGainDb(ctx);
    const stratum = sumPairs(diffPair(ctx.stems.work, env.stems.work), diffPair(ctx.stems.airWet, env.stems.airWet));
    const rec = slice(stratum, ctx.sr, w, end);
    const lou = loudness(rec.L, rec.R, ctx.sr);
    const tp = Math.max(peaks(rec.L).truePeak, peaks(rec.R).truePeak);
    return {
        workLufs: lou.integrated + gain, workMMax: lou.momentaryMax + gain, workTpDbtp: toDb(tp) + gain,
        programLufs: sceneMetrics(ctx).lufsI, envProgramLufs: sceneMetrics(env).lufsI, stratum,
    };
}

// FOL round 2: 2–5 kHz energy ÷ full-band energy (mid, plain energy) summed
// over every strike window [t, t + 150 ms], in percent.
export function onsetShare25(pair, sr, times, { winSec = 0.15 } = {}) {
    const mid = midOf(pair);
    const E = bandEnvelope({ L: mid, R: mid, sampleRate: sr }, 2000, 5000);
    let eb = 0;
    let et = 0;
    for (const t of times) {
        const a = Math.max(0, Math.round(t * sr));
        const b = Math.min(mid.length, a + Math.round(winSec * sr));
        for (let i = a; i < b; i++) et += mid[i] * mid[i];
        const ka = Math.round(t / E.hop);
        const kb = Math.round((t + winSec) / E.hop);
        for (let k = ka; k < kb && k < E.env.length; k++) eb += E.env[k] * E.env[k] * E.hop * sr;
    }
    return et > 0 ? (100 * eb) / et : null;
}

// Accents heard per building: band rise ≥ 6 dB (FOL's riseAt: 40 ms, 200 ms
// for swells, over the median of [t − 300, t − 30) ms) in `context`; the
// same instants in `control` (the environment alone: its false positives).
export function heardRows(accents, context, control, sr, bands, { minRiseDb = 6 } = {}) {
    const envs = {};
    const env = (name, pair, [lo, hi]) => ((envs[`${name}:${lo}-${hi}`]) ||= bandEnvelope({ ...pair, sampleRate: sr }, lo, hi));
    const rows = {};
    for (const s of accents) {
        const band = bands[s.building];
        if (!band) continue;
        const row = (rows[s.building] ||= { n: 0, heard: 0, control: 0, rises: [] });
        const rise = riseAt(env('ctx', context, band), s.at, s.variant);
        row.n++;
        row.rises.push(rise);
        if (rise >= minRiseDb) row.heard++;
        if (control && riseAt(env('ctl', control, band), s.at, s.variant) >= minRiseDb) row.control++;
    }
    for (const row of Object.values(rows)) row.medianRiseDb = median(row.rises);
    return rows;
}

// Routine cues with and without the stratum: margin lost per cue (LU).
export function routineLossRows(ctx, env) {
    const on = laneMarginRows(ctx, 'village').filter(x => x.lane === 'routine');
    const off = laneMarginRows(env, 'village').filter(x => x.lane === 'routine');
    return on.map((row) => {
        const twin = off.find(x => x.label === row.label);
        return { label: row.label, on: row.margin, off: twin?.margin ?? null, lossLu: twin?.margin != null && row.margin != null ? twin.margin - row.margin : null };
    });
}

// The quietest urgent voice's true peak at the output, per lane: each
// placement's cue-stem TP over [t, t + 2.5 s] (Wave-3 voices at their
// in-context trims), the lane's median.
export function urgentTpRows(r, lanes) {
    const rows = laneMarginRows(r, 'village');
    const gain = outputGainDb(r);
    return lanes.map((lane) => {
        const tps = rows.filter(x => x.lane === lane && Number.isFinite(x.at)).map((x) => {
            const s = slice(r.stems.cue, r.sr, x.at, x.at + 2.5);
            return toDb(Math.max(peaks(s.L).truePeak, peaks(s.R).truePeak)) + gain;
        });
        return { lane, tpDbtp: median(tps), n: tps.length };
    });
}

// ------------------------------------------------------------- 5.4 slots ----
export function slotRows(r, { selectLabel, needsYouAt }) {
    const selectAt = markerAt(r, selectLabel);
    const forge = strikesOf(r).filter(s => s.building === 'forge' && s.kind === 'accent');
    const byAgent = {};
    for (const s of forge) (byAgent[s.agentId] ||= []).push(s);
    const cueAt = (r.meta.scheduled.find(x => x.kind === 'summons' && x.t >= r.meta.warmup + needsYouAt - 0.1)?.notes || [])[0] ?? null;
    let needsYou = null;
    if (cueAt != null) {
        const s = slice(r.stems.cue, r.sr, cueAt, cueAt + 2.5);
        const lou = loudness(s.L, s.R, r.sr);
        const level = r.meta.levels.find(l => l.kind === 'summons' && Math.abs((l.at ?? l.t) - cueAt) < 1);
        needsYou = { at: cueAt, mMax: lou.momentaryMax + outputGainDb(r), trimDb: level?.trimDb ?? null };
    }
    return { selectAt, byAgent, needsYou };
}

// --------------------------------------------------------- 5.6 quiet mix ----
// A stem's level in `hopSec` blocks, blurred render minus its twin (dB),
// as [[t, dB], …]; blocks where the twin is silent are skipped.
export function levelDiffCurve(a, b, sr, { hopSec = 0.1, floor = 1e-7 } = {}) {
    const hop = Math.round(hopSec * sr);
    const n = Math.min(a.L.length, b.L.length);
    const out = [];
    for (let k = 0; (k + 1) * hop <= n; k++) {
        let ea = 0;
        let eb = 0;
        for (let i = k * hop; i < (k + 1) * hop; i++) {
            ea += a.L[i] * a.L[i] + a.R[i] * a.R[i];
            eb += b.L[i] * b.L[i] + b.R[i] * b.R[i];
        }
        if (eb / hop < floor * floor) continue;
        out.push([(k + 1) * hopSec, ea > 0 ? 10 * Math.log10(ea / eb) : -120]);
    }
    return out;
}

// The work fader as the accents hear it: each accent's work-stem peak over
// its first 40 ms minus its own published gain (dB), median per building
// over the `windows` ([{ from, to }]). Blurred minus unblurred windows of one
// render, building by building, is the fader's step (ghosts off reshuffle
// the schedule, so accents cannot be paired with a twin). → { n, byBuilding: { b: dB } }
export function accentGainOffsetDb(r, windows) {
    const rows = {};
    const strikes = windows.flatMap(w => strikesOf(r, w));
    for (const s of strikes.filter(x => x.kind === 'accent' && !x.flam && Number.isFinite(x.gainDb))) {
        const p = slice(r.stems.work, r.sr, s.at, s.at + 0.04);
        const d = toDb(Math.max(peaks(p.L).sample, peaks(p.R).sample)) - s.gainDb;
        if (Number.isFinite(d)) (rows[s.building] ||= []).push(d);
    }
    return {
        n: Object.values(rows).reduce((k, v) => k + v.length, 0),
        byBuilding: Object.fromEntries(Object.entries(rows).map(([b, v]) => [b, median(v)])),
    };
}

// Two windows' per-building offsets → the median step over the buildings
// heard in both (dB), or null.
export function offsetStepDb(inside, outside) {
    return median(Object.keys(inside.byBuilding).filter(b => outside.byBuilding[b] != null).map(b => inside.byBuilding[b] - outside.byBuilding[b]));
}

// Accents booked in both renders of one seed (same agent and building,
// within 1 ms): the published gain here minus there (dB), per agent.
export function pairedGainDiffs(a, b, { from, to }) {
    const bs = strikesOf(b, { from, to }).filter(s => s.kind === 'accent');
    const out = {};
    for (const s of strikesOf(a, { from, to }).filter(x => x.kind === 'accent')) {
        const m = bs.find(x => x.building === s.building && x.agentId === s.agentId && Math.abs(x.at - s.at) < 0.001);
        if (m && Number.isFinite(s.gainDb) && Number.isFinite(m.gainDb)) (out[s.agentId] ||= []).push(s.gainDb - m.gainDb);
    }
    return out;
}

export function ghostsIn(r, from, to) {
    return strikesOf(r, { from, to }).filter(s => s.kind === 'ghost').length;
}

// ------------------------------------------------------------- 5.7 quota ----
// The mine's 80–160 Hz band per quota step: the work stem minus its twin
// without usage (the quota lane alone), over each step's last 4 s, and
// after the quota goes stale.
export function quotaRows(sweep, twin, { ratios, firstAt, spacing, staleAt }) {
    const w = sweep.meta.warmup;
    const lane = diffPair(sweep.stems.work, twin.stems.work);
    const level = (a, b) => bandLevelDb(slice(lane, sweep.sr, w + a, w + b), sweep.sr, 80, 160);
    const heard = (a, b) => bandLevelDb(slice(sweep.stems.work, sweep.sr, w + a, w + b), sweep.sr, 80, 160);
    const steps = ratios.map((ratio, i) => {
        const a = firstAt + i * spacing + spacing - 4;
        return { ratio, levelDb: level(a, a + 4), heardDb: heard(a, a + 4) };
    });
    return {
        steps,
        before: level(0, firstAt), staleDb: level(staleAt + 3, staleAt + 7),
        cues: sweep.meta.cues.filter(c => c.t >= w).length,
    };
}

// ------------------------------------------------------------ 5.8 camera ----
// The camera crossing the Harbor (scene path → the unstepped placement's
// pan through 0), the heard crossing (the layer's / sea's writes rebuilt),
// the pan targets and the writes while the camera is still.
export function cameraPanTarget(camera, sceneSec) {
    const c = camera;
    const pts = c.path;
    const at = t => {
        if (t <= pts[0].at) return pts[0];
        const b = pts[pts.length - 1];
        if (t >= b.at) return b;
        const a = pts[0];
        const f = (t - a.at) / (b.at - a.at);
        return { cx: a.cx + (b.cx - a.cx) * f, cy: a.cy + (b.cy - a.cy) * f };
    };
    const p = at(sceneSec);
    return placeFromCamera('harbor', { x: c.viewportW / (2 * c.zoom) - p.cx, y: c.viewportH / (2 * c.zoom) - p.cy, zoom: c.zoom, viewportW: c.viewportW, viewportH: c.viewportH })?.pan ?? null;
}

export function placementLogRows(log, key, value) {
    return (log || []).filter(x => (x.building ?? x.lane) === key).map(x => ({ at: x.at, value: x[value], tc: x.tc ?? 0.25 }));
}

export { median, percentile };
