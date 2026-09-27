// Pure judges for the audio probe (Wave 6 gate): the S2 scene targets, the
// cue lane windows at their full S2 floors, limiter gain reduction from the
// limiter's two taps, the preset-switch hole/bump, ducked time, the AV-sync
// pairing, Wave 2's clock, air, noise and bank judges, Wave 3's
// discrimination, ladder, cluster, held-note, caption and honesty judges,
// Wave 4's world scene map, sea, thunder and must-never 7/8 judges, and
// Wave 5's workshop timing, level, focus, quiet-mix, quota and camera
// judges, and Wave 6's music judges (stem balance, working bands, the Isle
// Band A/B, the stop lint's envelope, rotation, breaths, loops, duty and
// the percussion's rank correlation). No I/O; every function takes plain arrays and numbers. Targets
// come from Loudness.js or the plan's acceptance lines, never from a
// baseline: a baseline only detects drift, it cannot pass a failure.
import { AUDIBILITY_WINDOWS, DUCKED_TIME_BUDGET, LOUDNESS_TARGETS, MEMORY_BUDGET } from '../../../claudeville/src/presentation/shared/audio/Loudness.js';

export function median(values) {
    const v = values.filter(Number.isFinite).sort((a, b) => a - b);
    if (!v.length) return null;
    const m = v.length >> 1;
    return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

export function percentile(values, p) {
    const v = values.filter(Number.isFinite).sort((a, b) => a - b);
    if (!v.length) return null;
    return v[Math.min(v.length - 1, Math.max(0, Math.ceil(p * v.length) - 1))];
}

// Energy mean of LUFS values (silence as zero energy); null when all silent.
export function energyMeanLufs(values) {
    let e = 0;
    let n = 0;
    for (const v of values) {
        n++;
        if (Number.isFinite(v)) e += Math.pow(10, (v + 0.691) / 10);
    }
    return n && e > 0 ? -0.691 + 10 * Math.log10(e / n) : null;
}

// ---------------------------------------------------------- plan stage ----
// The wave the probe gates today. A criterion whose owner lands later in the
// plan is measured and printed as DEFER (never a failure) until PLAN_STAGE
// reaches its wave; bump PLAN_STAGE at each wave's exit. Keys not listed are
// gated now.
export const PLAN_STAGE = 7;
export const GATED_FROM = Object.freeze({});

export function gatedFrom(key, table = GATED_FROM) {
    return table[key] ?? 0;
}

// failures: [{ what, gatedFrom }] → 'PASS' | 'FAIL' | 'DEFER'. A result
// fails when any failure is gated at or before `stage`; it defers when every
// failure is gated later.
export function stageOutcome(failures, stage = PLAN_STAGE) {
    if (!failures.length) return 'PASS';
    return failures.some(f => f.gatedFrom <= stage) ? 'FAIL' : 'DEFER';
}

// ------------------------------------------------------- scene targets ----
// S2 targets on the named scenes (Loudness.js only), relative targets
// against the anchor as measured in the same run.

// scenes: { anchor, villageBusy, townBand, rain, storm, resting }, each
// { lufsI, lra, stMax, stMean, stMin, bandStemStMax? }, and optionally
// nightProgram / noonProgram { lufsI, presenceDb } (S2's night row with its
// occasion; presenceDb the 2–5 kHz band level). Missing scenes skip.
export function judgeSceneTargets(scenes, targets = LOUDNESS_TARGETS, { stage = PLAN_STAGE, gated = GATED_FROM } = {}) {
    const rows = [];
    const f = v => (Number.isFinite(v) ? v.toFixed(1) : '—');
    const A = scenes.anchor?.lufsI;
    if (scenes.anchor) {
        const t = targets.anchorA;
        rows.push({ scene: 'anchor', pass: Math.abs(A - t.lufsI) <= t.toleranceLu, detail: `LUFS-I ${f(A)}; want ${t.lufsI} ± ${t.toleranceLu}` });
    }
    if (!Number.isFinite(A)) return rows;
    if (scenes.villageBusy) {
        const t = targets.villageSession;
        const s = scenes.villageBusy;
        const over = s.lufsI - A;
        rows.push({
            scene: 'villageBusy',
            pass: Math.abs(over - t.overA) <= t.toleranceLu && s.lra <= t.lraMaxLu,
            detail: `LUFS-I ${f(s.lufsI)} = A ${over >= 0 ? '+' : ''}${f(over)}, LRA ${f(s.lra)} LU; want A + ${t.overA} ± ${t.toleranceLu}, LRA ≤ ${t.lraMaxLu}`,
        });
    }
    if (scenes.townBand) {
        const t = targets.townBand;
        const s = scenes.townBand;
        rows.push({
            scene: 'townBand',
            pass: Math.abs(s.lufsI - t.lufsI) <= t.toleranceLu && (s.bandStemStMax == null || s.bandStemStMax <= t.bandStemStMax),
            detail: `LUFS-I ${f(s.lufsI)}, band stem ST max ${f(s.bandStemStMax)}; want ${t.lufsI} ± ${t.toleranceLu}, band ST max ≤ ${t.bandStemStMax}`,
        });
    }
    if (scenes.rain) {
        const over = scenes.rain.lufsI - A;
        rows.push({ scene: 'rain', pass: over <= targets.rain.maxOverA, detail: `LUFS-I ${f(scenes.rain.lufsI)} = A + ${f(over)}; want ≤ A + ${targets.rain.maxOverA}` });
    }
    if (scenes.storm) {
        const t = targets.storm;
        const s = scenes.storm;
        const over = s.lufsI - A;
        rows.push({
            scene: 'storm',
            pass: over <= t.maxOverA && s.stMax <= t.stMax,
            detail: `LUFS-I ${f(s.lufsI)} = A + ${f(over)}, ST max ${f(s.stMax)}; want ≤ A + ${t.maxOverA} and ST max ≤ ${t.stMax}`,
        });
    }
    if (scenes.resting) {
        const t = targets.resting;
        const s = scenes.resting;
        const over = s.stMean - A;
        rows.push({
            scene: 'resting',
            pass: Math.abs(over - t.overA) <= t.toleranceLu && s.stMin >= t.lufsSFloor,
            detail: `ST mean ${f(s.stMean)} = A ${over >= 0 ? '+' : ''}${f(over)}, ST min ${f(s.stMin)}; want A ${t.overA} ± ${t.toleranceLu}, never below ${t.lufsSFloor} LUFS-S`,
        });
    }
    if (scenes.nightProgram && scenes.noonProgram) {
        const t = targets.night;
        const s = scenes.nightProgram;
        const session = A + targets.villageSession.overA;
        const under = scenes.noonProgram.presenceDb - s.presenceDb;
        rows.push({
            scene: 'nightProgram',
            pass: s.lufsI - session <= t.maxOverVillageSession && under >= t.presenceUnderNoonDb,
            detail: `LUFS-I ${f(s.lufsI)} vs the Village session target ${f(session)} (A + ${targets.villageSession.overA}); 2–5 kHz ${f(under)} dB under noon; want ≤ the session + ${t.maxOverVillageSession} and ≥ ${t.presenceUnderNoonDb} dB under noon`,
        });
    }
    // Each row: pass (the criterion itself), gatedFrom, and outcome at `stage`.
    return rows.map((row) => {
        const from = gatedFrom(`scene:${row.scene}`, gated);
        return { ...row, gatedFrom: from, outcome: stageOutcome(row.pass ? [] : [{ what: row.scene, gatedFrom: from }], stage) };
    });
}

// --------------------------------------------------------- lane windows ----
// Every lane is held to its full S2 window per bed (the Wave-1 interim
// floors retired with the Wave-3 signal voices).
export const URGENT_LANES = Object.freeze(['needsYou', 'error', 'limit']);

// bed: 'village' | 'music' | 'weather'. → { min, max } (either may be null).
export function laneWindow(lane, bed, { windows = AUDIBILITY_WINDOWS } = {}) {
    const spec = windows.lanes[lane];
    if (!spec) throw new Error(`unknown lane ${lane}`);
    const ctx = spec[bed] || {};
    const min = ctx.min ?? null;
    const max = ctx.max ?? spec.ceiling ?? null;
    return { min, max };
}

// placements: [{ margin, bandsOver6dB, presenceRiseDb, grDb }] for one lane
// over one bed. Median of placements against the window; the band rule and
// the GR limit apply to urgent lanes only. `probeBed` names the probe's bed
// (MARGIN_BEDS key): a `margin:<probeBed>:<lane>` GATED_FROM row defers every
// criterion of that lane on that bed.
export function judgeLane(lane, bed, placements, { grMaxDb = LOUDNESS_TARGETS.ceiling.urgentGrMaxDb, bandRule = AUDIBILITY_WINDOWS.urgentBandRule, stage = PLAN_STAGE, probeBed = null, gated = GATED_FROM } = {}) {
    const win = laneWindow(lane, bed);
    const margin = median(placements.map(p => p.margin));
    // Every failure carries the wave that gates it (GATED_FROM).
    const failures = [];
    const row = probeBed ? gatedFrom(`margin:${probeBed}:${lane}`, gated) : 0;
    const fail = (what, key) => failures.push({ what, gatedFrom: Math.max(row, gatedFrom(key ? `${key}:${lane}` : '', gated)) });
    if (margin == null) fail('no admitted cue');
    else {
        if (win.min != null && margin < win.min) fail(`margin < ${win.min}`);
        if (win.max != null && margin > win.max) fail(`margin > ${win.max}`, 'ceiling');
    }
    const urgent = URGENT_LANES.includes(lane);
    let band = null;
    let gr = null;
    if (urgent) {
        if (bed === 'music') {
            band = median(placements.map(p => p.presenceRiseDb));
            if (!(band >= bandRule.overMusic.minRiseDb)) fail(`presence rise < ${bandRule.overMusic.minRiseDb} dB`, 'band');
        } else {
            band = median(placements.map(p => p.bandsOver6dB));
            if (!(band >= bandRule.overBed.thirdOctaveBands)) fail(`< ${bandRule.overBed.thirdOctaveBands} bands rising ${bandRule.overBed.minRiseDb} dB`, 'band');
        }
        gr = Math.max(...placements.map(p => p.grDb ?? 0));
        if (gr > grMaxDb) fail(`GR > ${grMaxDb} dB`);
    }
    const outcome = stageOutcome(failures, stage);
    return { lane, bed, window: win, margin, band, gr, n: placements.filter(p => Number.isFinite(p.margin)).length, pass: outcome !== 'FAIL', outcome, failures };
}

// ------------------------------------------------------ limiter GR -------
// Gain reduction from the limiter's input and output taps. The limiter
// delays by its lookahead; the delay is found once on the loudest second of
// the input, then each block's GR is its input peak over its output peak.
export function limiterDelay(inp, out, sr, { maxSec = 0.012 } = {}) {
    const win = Math.min(inp.length, sr);
    let best = 0;
    let bestE = -1;
    for (let s = 0; s + win <= inp.length; s += win) {
        let e = 0;
        for (let i = s; i < s + win; i += 4) e += inp[i] * inp[i];
        if (e > bestE) { bestE = e; best = s; }
    }
    let delay = 0;
    let bestC = -Infinity;
    for (let d = 0; d <= Math.round(maxSec * sr); d++) {
        let c = 0;
        for (let i = best + d; i < best + win && i < out.length; i += 2) c += inp[i - d] * out[i];
        if (c > bestC) { bestC = c; delay = d; }
    }
    return delay;
}

// inL/inR/outL/outR: Float32Arrays of the limiter's input and output.
// → { delay, blockSec, grDb: Float32Array } (0 where the input is silent).
export function limiterGainReduction(inL, inR, outL, outR, sr, { blockSec = 0.005, floor = 1e-4 } = {}) {
    const delay = limiterDelay(inL, outL, sr);
    const B = Math.max(1, Math.round(blockSec * sr));
    const n = Math.floor(outL.length / B);
    const grDb = new Float32Array(n);
    for (let b = 0; b < n; b++) {
        let pin = 0;
        let pout = 0;
        for (let i = b * B; i < (b + 1) * B; i++) {
            const j = i - delay;
            if (j >= 0) pin = Math.max(pin, Math.abs(inL[j]), Math.abs(inR[j]));
            pout = Math.max(pout, Math.abs(outL[i]), Math.abs(outR[i]));
        }
        grDb[b] = pin > floor && pout > 0 ? Math.max(0, 20 * Math.log10(pin / pout)) : 0;
    }
    return { delay, blockSec: B / sr, grDb };
}

export function maxGrIn(gr, t0, t1) {
    const a = Math.max(0, Math.floor(t0 / gr.blockSec));
    const b = Math.min(gr.grDb.length, Math.ceil(t1 / gr.blockSec));
    let m = 0;
    for (let i = a; i < b; i++) m = Math.max(m, gr.grDb[i]);
    return m;
}

// --------------------------------------------------------- preset switch ----
// Must-never 12: a preset switch at `t` leaves no hole and no bump. The
// steady states are the momentary loudness before the switch [t − 8, t) and
// after it has settled [t + 6, t + 14]; the switch window is [t, t + 4].
// A hole is the switch window's minimum under the quieter side's p10, a
// bump its maximum over the louder side's p90.
export function switchHoleBump(momentary, t, { before = 8, settle = [6, 14], window = 4 } = {}) {
    const inRange = (a, b) => momentary.filter(([end]) => end - 0.2 >= a && end - 0.2 < b).map(([, v]) => (Number.isFinite(v) ? v : -120));
    const old = inRange(t - before, t);
    const next = inRange(t + settle[0], t + settle[1]);
    const during = inRange(t, t + window);
    if (!old.length || !next.length || !during.length) return null;
    const floor = Math.min(percentile(old, 0.1), percentile(next, 0.1));
    const ceil = Math.max(percentile(old, 0.9), percentile(next, 0.9));
    const lo = Math.min(...during);
    const hi = Math.max(...during);
    return {
        oldLufs: energyMeanLufs(old), newLufs: energyMeanLufs(next),
        holeDb: Math.max(0, floor - lo), bumpDb: Math.max(0, hi - ceil),
        minDuring: lo, maxDuring: hi,
    };
}

// ---------------------------------------------------------- ducked time ----
// Union of every duck window per bus (a bus counts where its depth < 0); a
// cancelled window ends at its cancellation (before it opened: nothing).
// Clipped to [start, end]. → { world, work, music } fractions of end − start.
export function duckedTime(ducks, start, end, { buses = ['world', 'work', 'music'] } = {}) {
    const out = {};
    for (const bus of buses) {
        const spans = [];
        for (const d of ducks) {
            if (!(Number(d.depths?.[bus]) < 0)) continue;
            const a = Math.max(start, d.from - (d.attack ?? 0.04));
            let b = Math.min(end, d.until + (d.release ?? 0.6));
            if (d.cancelledAt != null) b = Math.min(b, d.cancelledAt);
            if (b > a) spans.push([a, b]);
        }
        spans.sort((x, y) => x[0] - y[0]);
        let total = 0;
        let cur = null;
        for (const s of spans) {
            if (cur && s[0] <= cur[1]) cur[1] = Math.max(cur[1], s[1]);
            else { if (cur) total += cur[1] - cur[0]; cur = [...s]; }
        }
        if (cur) total += cur[1] - cur[0];
        out[bus] = total / Math.max(1e-9, end - start);
    }
    return out;
}

export function judgeDuckedTime(fractions, budget = DUCKED_TIME_BUDGET) {
    const worst = Math.max(...Object.values(fractions));
    return { pass: worst <= budget, worst, budget };
}

// --------------------------------------------------------------- AV sync ----
// The heard onset of a note published at `t` on a mono stem: the first 1 ms
// frame in [t − before, t + after] whose energy is ≥ 6 dB over the mean of
// the 10 ms before it and above `floorDb`; when no frame rises 6 dB (a bell
// struck into two others' ring), the first that rises 3 dB. From silence
// this reads the note's first millisecond; a note struck over its
// predecessor's ring reads late by as much as its attack needs to lift the
// ring (≈ 8–17 ms on today's voices), so a pair's second note carries that
// bias. Returns seconds or null.
export function onsetNear(mono, sr, t, { before = 0.03, after = 0.08, floorDb = -80 } = {}) {
    const F = Math.max(1, Math.round(sr / 1000));
    const energy = (a) => {
        let e = 0;
        for (let i = a; i < a + F && i < mono.length; i++) e += mono[i] * mono[i];
        return e / F;
    };
    const floor = Math.pow(10, floorDb / 10);
    const a0 = Math.max(10 * F, Math.round((t - before) * sr));
    const a1 = Math.min(mono.length - F, Math.round((t + after) * sr));
    for (const rise of [4, 2]) {
        for (let a = a0; a <= a1; a += F) {
            const e = energy(a);
            if (e < floor) continue;
            let pre = 0;
            for (let k = 1; k <= 10; k++) pre += energy(a - k * F);
            pre /= 10;
            if (e >= rise * pre) return a / sr;
        }
    }
    return null;
}

// Published times vs heard onsets. → { n, missed, medianAbsMs, p95AbsMs, errorsMs }
export function avSync(pairs) {
    const errors = pairs.filter(p => p.heard != null).map(p => (p.heard - p.published) * 1000);
    const abs = errors.map(Math.abs);
    return {
        n: pairs.length,
        missed: pairs.filter(p => p.heard == null).length,
        medianAbsMs: median(abs),
        p95AbsMs: percentile(abs, 0.95),
        medianMs: median(errors),
        errorsMs: errors.map(e => Number(e.toFixed(2))),
    };
}

// ------------------------------------------------------------ baselines ----
// Numbers compared against the committed baseline, and how far each may
// drift before the probe fails (HAR-2: LUFS-I within ±1.5 LU).
export const BASELINE_TOLERANCE = Object.freeze({ lufsI: 1.5, margin: 1.5, stMax: 1.5 });

export function compareBaseline(current, baseline, tolerance = BASELINE_TOLERANCE) {
    const rows = [];
    for (const [key, cur] of Object.entries(current)) {
        const base = baseline?.[key];
        for (const [metric, tol] of Object.entries(tolerance)) {
            const a = cur?.[metric];
            const b = base?.[metric];
            if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
            rows.push({ key, metric, current: a, baseline: b, delta: a - b, pass: Math.abs(a - b) <= tol, tolerance: tol });
        }
    }
    return rows;
}

// ========================================================== Wave 2 =========

const finite = v => Number.isFinite(v);

// ------------------------------------------------------------- transport ----
// S4 / 2.1 (ENG-8): the Transport's own diagnostics plus the virtual clock's
// timer attribution. `timers`: [{ site, fired, p95Ms, maxMs, starts }] per
// timer call site ('harness' = the probe's own timers, 'untimed' = outside
// any timer); `starts` counts continuous and stochastic sources (layers,
// the sequencer, bank playback) — discrete cue voices, control-rate
// decisions placed on the audio clock with a lead, are counted apart and
// exempt. Exactly one app timer may start such sources, and it must be the
// Transport's; its tick costs ≤ 0.5 ms p95, ≤ 2 ms max on the main thread.
export const TRANSPORT_LIMITS = Object.freeze({
    horizonSec: 1.5, workHorizonSec: 0.35, tickP95Ms: 0.5, tickMaxMs: 2, underruns: 0,
    site: /(^|\/)Transport\.js:\d+$/,
    // Work processes (the work stratum, Wave 5) keep the short horizon.
    workProcess: /^(work|workshop|murmur)/,
});

export function judgeTransport(diag, timers, limits = TRANSPORT_LIMITS) {
    const failures = [];
    const soundSites = timers.filter(t => t.starts > 0 && t.site !== 'harness' && t.site !== 'untimed');
    const tick = timers.find(t => limits.site.test(t.site)) || null;
    if (!diag) failures.push('no engine.transport.diagnostics()');
    const processes = (diag?.processes || []).map((p) => {
        const limit = limits.workProcess.test(p.name || '') ? limits.workHorizonSec : limits.horizonSec;
        return { ...p, limit, pass: finite(p.maxAheadSec) && p.maxAheadSec <= limit + 1e-6 };
    });
    if (diag && diag.underruns !== limits.underruns) failures.push(`underruns ${diag.underruns}`);
    for (const p of processes) if (!p.pass) failures.push(`${p.name} ahead ${p.maxAheadSec} s > ${p.limit} s`);
    if (soundSites.length !== 1 || !limits.site.test(soundSites[0].site)) {
        failures.push(`sound placed by ${soundSites.length} timer site(s): ${soundSites.map(s => s.site).join(', ') || 'none'}`);
    }
    if (!tick) failures.push('no Transport tick seen');
    else if (!(tick.p95Ms <= limits.tickP95Ms) || !(tick.maxMs <= limits.tickMaxMs)) failures.push(`tick p95 ${tick.p95Ms?.toFixed(3)} ms / max ${tick.maxMs?.toFixed(2)} ms`);
    return { pass: failures.length === 0, failures, processes, soundSites, tick };
}

// ------------------------------------------------------- pause in place ----
// 2.1: `starts` [{ t (scheduled audio time), at (call time), suspended }]
// from the virtual clock; hideT/resumeT the context's suspend and resume.
// While suspended nothing may start; after resume the onsets (distinct
// scheduled times, 1 ms grid) of the first second may exceed the steady
// rate of the `steadySec` before hiding by at most one; a start scheduled
// before its own call time after resume is a smear (catch-up).
export function resumeBurst(starts, { hideT, resumeT, steadySec = 30, windowSec = 1 }) {
    const onsets = (a, b) => new Set(starts.filter(s => s.t >= a && s.t < b).map(s => Math.round(s.t * 1000))).size;
    const steadySpan = Math.min(steadySec, hideT);
    const steadyPerSec = steadySpan > 0 ? onsets(hideT - steadySpan, hideT) / steadySpan : 0;
    const firstWindow = onsets(resumeT, resumeT + windowSec);
    const suspended = starts.filter(s => s.suspended && s.at >= hideT && s.at <= resumeT).length;
    const smeared = starts.filter(s => s.at >= resumeT && s.t < s.at - 0.02).length;
    return {
        steadyPerSec, firstWindow, suspended, smeared,
        pass: suspended === 0 && smeared === 0 && firstWindow <= steadyPerSec * windowSec + 1,
    };
}

// ------------------------------------------------------------ noise lanes ----
// 2.5 (AMB-3): two lanes reading one pool buffer must stay ≥ `minSepSec`
// of buffer time apart for as long as both play. `starts`: buffer-source
// starts [{ t, e (stop or null), buf, len, off, rate }]; only buffers of
// at least `minBufferSec` count (the pool; short one-shot buffers are not
// shared noise). Read heads are sampled every `stepSec` of the overlap.
export function noiseLaneConflicts(starts, { minSepSec = 5, minBufferSec = 10, end, stepSec = 0.25 } = {}) {
    const lanes = starts.filter(s => s.buf != null && s.len >= minBufferSec);
    const byBuf = new Map();
    for (const s of lanes) {
        if (!byBuf.has(s.buf)) byBuf.set(s.buf, []);
        byBuf.get(s.buf).push(s);
    }
    const head = (s, t) => {
        const p = (s.off + (t - s.t) * (s.rate || 1)) % s.len;
        return p < 0 ? p + s.len : p;
    };
    const conflicts = [];
    let pairs = 0;
    for (const group of byBuf.values()) {
        for (let i = 0; i < group.length; i++) {
            for (let j = i + 1; j < group.length; j++) {
                const a = group[i];
                const b = group[j];
                const from = Math.max(a.t, b.t);
                const to = Math.min(a.e ?? end ?? Infinity, b.e ?? end ?? Infinity);
                if (!(to > from)) continue;
                pairs++;
                let closest = Infinity;
                let at = from;
                for (let t = from; t <= to; t += stepSec) {
                    const d = Math.abs(head(a, t) - head(b, t));
                    const circ = Math.min(d, a.len - d);
                    if (circ < closest) { closest = circ; at = t; }
                }
                if (closest < minSepSec) conflicts.push({ buf: a.buf, a: a.t, b: b.t, at, closestSec: closest });
            }
        }
    }
    return { lanes: lanes.length, buffers: byBuf.size, pairs, conflicts };
}

// ------------------------------------------------------------ Island Air ----
// S5 / 2.4 acceptance: T60 at 1 kHz by phase, T60(4 kHz) ≤ 0.8 × T60(1 kHz),
// direct-to-reverberant at d = 0 and d = 1, urgent cues' wet re dry, and
// what the air adds to the program.
export const ISLAND_AIR = Object.freeze({
    t60Day: Object.freeze({ min: 0.95, max: 1.25 }),
    t60Night: Object.freeze({ min: 1.35, max: 1.75 }),
    hfRatioMax: 0.8,
    drNearMinDb: 8,
    drFarMaxDb: 1,
    urgentWetMaxDb: -14,
    programMaxLu: 1,
});

export function judgeAirT60(phase, t60, limits = ISLAND_AIR) {
    const want = phase === 'night' ? limits.t60Night : limits.t60Day;
    const ratio = finite(t60.t60_4000) && finite(t60.t60_1000) ? t60.t60_4000 / t60.t60_1000 : null;
    const inRange = finite(t60.t60_1000) && t60.t60_1000 >= want.min && t60.t60_1000 <= want.max;
    return { pass: inRange && ratio != null && ratio <= limits.hfRatioMax, ratio, want };
}

// Energy ratio of two signals in dB (a over b); null when either is silent.
export function energyRatioDb(a, b) {
    let ea = 0;
    let eb = 0;
    for (const x of a) ea += x * x;
    for (const x of b) eb += x * x;
    return ea > 0 && eb > 0 ? 10 * Math.log10(ea / eb) : null;
}

// --------------------------------------------------------------- textures ----
// 2.5: every continuous texture's autocorrelation peak over 0.5–20 s lags
// < 0.05; the world bed's ICC 0.15–0.5 on 60 s; program mono fold ≤ 2 LU.
export const NOISE_LIMITS = Object.freeze({ autocorrMax: 0.05, icc: Object.freeze({ min: 0.15, max: 0.5 }), monoLossMaxLu: 2, laneSepSec: 5 });

// ------------------------------------------------------------- SampleBank ----
// S8 / 2.6: resident bytes per client within MEMORY_BUDGET, the total within
// its budget, every bake slice ≤ 5 ms of main thread.
export const BAKE_SLICE_MAX_MS = 5;

export function judgeBank(stats, sliceMaxMs, budget = MEMORY_BUDGET) {
    const failures = [];
    if (!stats) return { pass: false, failures: ['no engine.bank.stats()'], clients: [] };
    const clients = Object.entries(stats.byClient || {}).map(([name, bytes]) => ({ name, bytes, budget: budget[name] ?? null }));
    for (const c of clients) {
        if (c.budget == null) failures.push(`client ${c.name} has no MEMORY_BUDGET row`);
        else if (c.bytes > c.budget) failures.push(`${c.name} ${c.bytes} B > ${c.budget} B`);
    }
    if (!(stats.residentBytes <= budget.totalBytes)) failures.push(`resident ${stats.residentBytes} B > ${budget.totalBytes} B`);
    if (finite(sliceMaxMs) && sliceMaxMs > BAKE_SLICE_MAX_MS) failures.push(`slice ${sliceMaxMs.toFixed(2)} ms > ${BAKE_SLICE_MAX_MS} ms`);
    return { pass: failures.length === 0, failures, clients };
}

// ------------------------------------------------------------ frame cost ----
// 2.4: `world:benchmark-fps`-style app frame total (update + render) with
// sound on vs off; the p95 delta may not exceed 0.1 ms.
export const FRAME_COST_MAX_DELTA_MS = 0.1;

export function frameCostDelta(onMs, offMs) {
    const on = percentile(onMs, 0.95);
    const off = percentile(offMs, 0.95);
    const delta = on != null && off != null ? on - off : null;
    // 1e-9: performance.now() differences carry float residue (a +0.100 ms
    // delta can read 0.10000000000000053).
    return { onP95: on, offP95: off, delta, pass: delta != null && delta <= FRAME_COST_MAX_DELTA_MS + 1e-9 };
}

// ========================================================== Wave 3 =========

// ------------------------------------------------------ discrimination ----
// S1 / 3.2 / 3.4: every signal voice differs from every other cue voice in
// ≥ 2 of contour, rhythm and timbre (metrics/discrim.mjs `differs`); the
// three urgent families pairwise ≥ 2. 3.4 asks every outcome to differ from
// needs-you in all 3, written for the door chime's falling opening: the
// ship's bell (the binding needs-you decision) opens flat, which S1's
// opening-interval rule scores the same as any single strike, so a
// one-strike outcome can reach 2/3 at most. Outcomes are gated at the S1
// rule and their 3/3 count reported. `stratum` maps a feature's label to
// signal | outcome | routine | scenery. `rows`: discrim.mjs
// `discriminationMatrix` rows.
export const DISCRIM_LIMITS = Object.freeze({ minDims: 2, outcomeVsNeedsYouDims: 2 });

export function judgeDiscrimination(rows, { stratum, urgent, needsYou }, limits = DISCRIM_LIMITS) {
    const signalRows = rows.filter(r => stratum[r.signal] === 'signal');
    const failures = signalRows.filter(r => r.n < limits.minDims).map(r => `${r.signal} vs ${r.other} ${r.n}/3`);
    const urgentRows = signalRows.filter(r => urgent.includes(r.signal) && urgent.includes(r.other));
    const outcomeRows = signalRows.filter(r => r.signal === needsYou && stratum[r.other] === 'outcome');
    const outcomeShort = outcomeRows.filter(r => r.n < limits.outcomeVsNeedsYouDims).map(r => `${r.other} ${r.n}/3 (${r.dims.join('+') || 'none'})`);
    const outcomeNot3 = outcomeRows.filter(r => r.n < 3).map(r => `${r.other} ${r.n}/3 (${r.dims.join('+') || 'none'})`);
    const count = n => signalRows.filter(r => r.n === n).length;
    return {
        rows: signalRows.length, three: count(3), two: count(2), below: failures.length, failures,
        urgentMin: urgentRows.length ? Math.min(...urgentRows.map(r => r.n)) : null,
        outcomeShort, outcomeNot3, outcomeFull: outcomeRows.filter(r => r.n === 3).length, outcomes: outcomeRows.length,
        pass: signalRows.length > 0 && failures.length === 0 && urgentRows.length > 0 && outcomeShort.length === 0,
    };
}

// S1: the needs-you ship's bell is the only quick same-pitch pair. A
// non-signal cue fails when its opening two onsets are < `minGapMs` apart
// on one pitch (within half a semitone); unpitched notes (hz null) have no
// pitch and never pair. `notes`: [{ ms, hz }] with chords collapsed to their
// melody note.
export const SAME_PITCH_MIN_GAP_MS = 1000;

export function quickSamePitchOpening(notes, { minGapMs = SAME_PITCH_MIN_GAP_MS } = {}) {
    const [a, b] = notes;
    if (!a || !b || !(a.hz > 0) || !(b.hz > 0)) return false;
    return b.ms - a.ms < minGapMs && Math.abs(12 * Math.log2(b.hz / a.hz)) < 0.5;
}

// --------------------------------------------------------------- ladder ----
// D6 / SIG-2 as the plan states it: L1 at entry, L2 at 2 min, L3 at 6, L4
// at 15 and 30, then one L2 every 30 min until acknowledged; errors hold at
// L3; quota plays one L2 only. → [{ atSec, level }] up to `endSec`.
export const LADDER = Object.freeze({
    steps: Object.freeze([[0, 1], [120, 2], [360, 3], [900, 4], [1800, 4]]),
    postEverySec: 1800,
    maxLevel: Object.freeze({ needsYou: 4, errors: 3, quota: 2 }),
    minGapSec: 120,
    perHour: 12,
});

export function expectedLadder(family, endSec, ladder = LADDER) {
    const cap = ladder.maxLevel[family];
    if (cap == null) throw new Error(`unknown family ${family}`);
    if (family === 'quota') return ladder.steps.slice(0, 2).filter(([t]) => t <= endSec).map(([atSec, level]) => ({ atSec, level }));
    const out = ladder.steps.map(([atSec, level]) => ({ atSec, level: Math.min(level, cap) }));
    const last = ladder.steps[ladder.steps.length - 1][0];
    for (let t = last + ladder.postEverySec; t <= endSec; t += ladder.postEverySec) out.push({ atSec: t, level: 2 });
    return out.filter(x => x.atSec <= endSec);
}

// Observed calls [{ atSec, level }] against the expected list: each expected
// call matches the first unused observed call at its level within
// [at − earlySec, at + lateSec] (the 1 Hz route may run a tick late); any
// observed call left over is unexpected. Reminders (every call after the
// entry) also keep S7's caps: ≥ 120 s apart and ≤ 12 in any hour.
export function judgeLadder(observed, expected, { earlySec = 1, lateSec = 3, ladder = LADDER } = {}) {
    const used = new Set();
    const rows = expected.map((e) => {
        const i = observed.findIndex((o, k) => !used.has(k) && o.level === e.level && o.atSec >= e.atSec - earlySec && o.atSec <= e.atSec + lateSec);
        if (i >= 0) used.add(i);
        return { ...e, observedSec: i >= 0 ? observed[i].atSec : null };
    });
    const missing = rows.filter(r => r.observedSec == null);
    const extra = observed.filter((_, k) => !used.has(k));
    const reminders = observed.filter(o => o.reminder ?? o.level > 1).map(o => o.atSec).sort((a, b) => a - b);
    const gaps = reminders.slice(1).map((t, i) => t - reminders[i]);
    const minGap = gaps.length ? Math.min(...gaps) : null;
    let perHour = 0;
    for (let i = 0; i < reminders.length; i++) perHour = Math.max(perHour, reminders.filter(t => t >= reminders[i] && t < reminders[i] + 3600).length);
    const capsOk = (minGap == null || minGap >= ladder.minGapSec - earlySec) && perHour <= ladder.perHour;
    return { rows, missing, extra, minGapSec: minGap, perHour, pass: missing.length === 0 && extra.length === 0 && capsOk };
}

// 3.3 held trim: the ladder takes its cue trim once, at entry, and holds it
// for every reminder of that wait, so L2 lands ≥ 4 LU under L1 and L3 keeps
// urgent GR ≤ 3 dB. `calls`: [{ level, margin, grDb, trimDb }] in order.
export const LADDER_TRIM = Object.freeze({ l2UnderL1Lu: 4, trimTolDb: 0.05 });

export function judgeHeldTrim(calls, { grMaxDb = LOUDNESS_TARGETS.ceiling.urgentGrMaxDb, limits = LADDER_TRIM } = {}) {
    const at = level => calls.find(c => c.level === level) ?? null;
    const l1 = at(1);
    const l2 = at(2);
    const l3 = at(3);
    const under = l1 && l2 && Number.isFinite(l1.margin) && Number.isFinite(l2.margin) ? l1.margin - l2.margin : null;
    const trims = calls.map(c => c.trimDb).filter(Number.isFinite);
    const spread = trims.length ? Math.max(...trims) - Math.min(...trims) : null;
    const failures = [];
    if (!l1 || !l2 || !l3) failures.push('missing L1, L2 or L3');
    if (under == null || under < limits.l2UnderL1Lu) failures.push(`L2 not ${limits.l2UnderL1Lu} LU under L1`);
    if (!(l3?.grDb <= grMaxDb)) failures.push(`L3 GR > ${grMaxDb} dB`);
    if (spread == null || trims.length < calls.length || spread > limits.trimTolDb) failures.push('trim re-taken');
    return { l2UnderL1Lu: under, l3GrDb: l3?.grDb ?? null, trimSpreadDb: spread, failures, pass: failures.length === 0 };
}

// Hidden tab with sound on: every due reminder is heard (its cue sounded
// with the context running) within `withinSec` of its due time.
export function judgeWakes(dueSec, heardSec, { withinSec = 60 } = {}) {
    const rows = dueSec.map((due) => {
        const heard = heardSec.find(h => h >= due - 1 && h <= due + withinSec);
        return { due, heard: heard ?? null, lagSec: heard != null ? heard - due : null };
    });
    return { rows, pass: rows.length > 0 && rows.every(r => r.heard != null) };
}

// -------------------------------------------------------------- cluster ----
// SIG-10 / 3.3: six same-tick raises ring one call — M-max within +1 LU of
// a single call — and every agent keeps its caption.
export const CLUSTER_MAX_OVER_ONE_LU = 1;

export function judgeCluster({ oneMaxLufs, manyMaxLufs, agents, captionedAgents }) {
    const over = Number.isFinite(oneMaxLufs) && Number.isFinite(manyMaxLufs) ? manyMaxLufs - oneMaxLufs : null;
    const missing = agents.filter(a => !captionedAgents.includes(a));
    return { overLu: over, missing, pass: over != null && over <= CLUSTER_MAX_OVER_ONE_LU && missing.length === 0 };
}

// Must-never 13 (SIG-10): N identical phase-locked urgent bells. Two urgent
// scores of one kind for different agents are phase-locked when ≥ 2 of
// their notes coincide within `tolMs`. `scores`: [{ kind, agentId, notes: [s] }].
export function phaseLockedPairs(scores, { tolMs = 5 } = {}) {
    const pairs = [];
    for (let i = 0; i < scores.length; i++) {
        for (let j = i + 1; j < scores.length; j++) {
            const a = scores[i];
            const b = scores[j];
            if (a.kind !== b.kind || a.agentId === b.agentId) continue;
            const hits = a.notes.filter(t => b.notes.some(u => Math.abs(u - t) * 1000 <= tolMs)).length;
            if (hits >= 2) pairs.push({ kind: a.kind, a: a.agentId, b: b.agentId, hits });
        }
    }
    return pairs;
}

// ------------------------------------------------------------ held note ----
// 3.3: the 270–310 Hz band (the held D4) rises ≥ 6 dB within 6 s of a wait
// opening and is back (within `backTolDb` of the level before the wait)
// within 5 s of the answer; beating depth ≤ 3 dB; level bed − 8 ± 1 LU.
// `curve`: [[t, dB], …] of band power on a fixed hop.
export const HELD_NOTE = Object.freeze({
    bandHz: Object.freeze([270, 310]), riseDb: 6, riseWithinSec: 6, backWithinSec: 5, backTolDb: 3,
    beatingMaxDb: 3, underBedLu: -8, levelTolLu: 1,
    // "Absent": the held stem's short-term max, output-referred, stays under this.
    absentMaxLufs: -80,
});

function meanDb(curve, t0, t1) {
    let e = 0;
    let n = 0;
    for (const [t, db] of curve) if (t >= t0 && t < t1) { e += Math.pow(10, db / 10); n++; }
    return n && e > 0 ? 10 * Math.log10(e / n) : null;
}

export function heldNoteRise(curve, openSec, answerSec, { preSec = 3, winSec = 1, limits = HELD_NOTE } = {}) {
    const pre = meanDb(curve, openSec - preSec, openSec);
    let riseAt = null;
    let backAt = null;
    let held = null;
    if (pre != null) {
        for (const [t] of curve) {
            if (t <= openSec || t > openSec + limits.riseWithinSec - winSec) continue;
            const m = meanDb(curve, t, t + winSec);
            if (m != null && m - pre >= limits.riseDb) { riseAt = t + winSec - openSec; break; }
        }
        held = meanDb(curve, openSec + limits.riseWithinSec, answerSec) - pre;
        if (answerSec != null) {
            for (const [t] of curve) {
                if (t < answerSec || t > answerSec + limits.backWithinSec - winSec) continue;
                const m = meanDb(curve, t, t + winSec);
                if (m != null && m - pre <= limits.backTolDb) { backAt = t + winSec - answerSec; break; }
            }
        }
    }
    return { preDb: pre, riseAtSec: riseAt, heldRiseDb: Number.isFinite(held) ? held : null, backAtSec: backAt, pass: riseAt != null && (answerSec == null || backAt != null) };
}

// Peak-to-trough depth of an envelope (dB), robust to one stray block:
// the 99th minus the 1st percentile.
export function beatingDepthDb(envDb) {
    const v = envDb.filter(Number.isFinite);
    if (v.length < 4) return null;
    return percentile(v, 0.99) - percentile(v, 0.01);
}

// Must-never 3: in Village with no music a wait stays audible while it
// lasts — the held note's band holds ≥ `minRiseDb` over the level before
// the wait in every `stepSec` window from the rise until the answer.
export function waitAudibleWindows(curve, openSec, answerSec, { preSec = 3, fromSec = 6, stepSec = 10, minRiseDb = HELD_NOTE.riseDb } = {}) {
    const pre = meanDb(curve, openSec - preSec, openSec);
    const rows = [];
    for (let t = openSec + fromSec; t + stepSec <= answerSec + 1e-9; t += stepSec) {
        const m = meanDb(curve, t, t + stepSec);
        rows.push({ t, riseDb: pre != null && m != null ? m - pre : null });
    }
    const worst = rows.length ? Math.min(...rows.map(r => r.riseDb ?? -Infinity)) : null;
    return { rows, worstRiseDb: worst, pass: rows.length > 0 && worst >= minRiseDb };
}

// ------------------------------------------------------------- captions ----
// S6 / 3.8 (HAR-13): whether a cue's caption shows, from the plan: signals
// always; events (outcome and routine) with *Signals and events* or
// *Everything*, and by default (`auto`) only while sound is on; scenery only
// with *Everything* while sound is on; the digest is sound-only (its toast is
// the `attention:digest` notice).
export const CUE_STRATUM = Object.freeze({
    summons: 'signal', distress: 'signal', limit: 'signal', reminder: 'signal', answered: 'signal',
    turnDone: 'outcome', subagentReturn: 'outcome', toolFailed: 'outcome', commit: 'outcome', push: 'outcome',
    release: 'outcome', pushFailed: 'outcome', dispatch: 'outcome',
    arrival: 'routine', departure: 'routine', recovery: 'routine', council: 'routine',
    hourBell: 'scenery', aurora: 'scenery', thunder: 'scenery', linkLost: 'scenery', linkRestored: 'scenery',
    digest: 'soundOnly',
});

export function captionExpected(kind, setting, soundOn) {
    const s = CUE_STRATUM[kind];
    if (s === 'signal') return true;
    if (s === 'outcome' || s === 'routine') return setting === 'events' || setting === 'all' || (setting === 'auto' && soundOn);
    if (s === 'scenery') return setting === 'all' && soundOn;
    return false;
}

// rows: [{ kind, setting, soundOn, played, shown, heard }] — `played` a
// cue-played event, `shown` a caption Toast rendered for it, `heard` a
// sounding score. Parity: a caption shows exactly when the plan says; no
// caption without a played cue; with sound on, every played cue sounded
// (the digest included) — a caption never claims a sound that did not ring.
export function judgeCaptionParity(rows) {
    const failures = [];
    for (const r of rows) {
        const want = r.played && captionExpected(r.kind, r.setting, r.soundOn);
        if (r.shown !== want) failures.push(`${r.kind} (${r.setting}, sound ${r.soundOn ? 'on' : 'off'}): caption ${r.shown ? 'shown' : 'hidden'}, want ${want ? 'shown' : 'hidden'}`);
        if (r.soundOn && r.played && r.heard === false) failures.push(`${r.kind} (sound on): captioned event with no sounding score`);
    }
    return { failures, pass: rows.length > 0 && failures.length === 0 };
}

// ------------------------------------------------------------ crown sync ----
// 3.4 / HAR-12: the release peal's published carrying note vs the crown's
// accent timestamp within ±15 ms.
export const CROWN_SYNC_MS = 15;

// ========================================================== Wave 4 =========

// ------------------------------------------------------- world scene map ----
// 4.5 (AMB-12, HAR-9): every world scene — work and music faders at 0, so
// the program is the world stratum as in Anchor A — against its S2 row,
// relative to A as measured in the same run. Resting (any weather) is the
// pilot light, judged on its short-term mean and floor; rain and storm
// (thunder included) have their own rows; every other waking scene is the
// day arc: within A ± `dayArc.toleranceLu`, with at least
// `dayArc.withinShare` of those cells inside it, and night (the Decision:
// darker and quieter than day) never over A + `night.maxOverA`.
export function worldSceneRow({ weather, load }) {
    if (load === 'resting') return 'resting';
    if (weather === 'rain') return 'rain';
    if (weather === 'storm') return 'storm';
    return 'dayArc';
}

// cell: { phase, weather, load, lufsI, stMax, stMean, stMin }; A the anchor's
// LUFS-I. → { row, over (LU over A), pass (the hard criterion), inArc (day
// arc cells: inside the band), want }
export function judgeWorldCell(cell, A, targets = LOUDNESS_TARGETS) {
    const row = worldSceneRow(cell);
    if (row === 'resting') {
        const t = targets.resting;
        const over = cell.stMean - A;
        return { row, over, pass: Math.abs(over - t.overA) <= t.toleranceLu && cell.stMin >= t.lufsSFloor, want: `ST mean A ${t.overA} ± ${t.toleranceLu}, ST min ≥ ${t.lufsSFloor}` };
    }
    const over = cell.lufsI - A;
    if (row === 'rain') return { row, over, pass: over <= targets.rain.maxOverA, want: `≤ A + ${targets.rain.maxOverA}` };
    if (row === 'storm') {
        const t = targets.storm;
        return { row, over, pass: over <= t.maxOverA && cell.stMax <= t.stMax, want: `≤ A + ${t.maxOverA}, ST max ≤ ${t.stMax}` };
    }
    const arc = targets.dayArc;
    if (!arc) return { row, over, inArc: false, pass: false, want: 'a Loudness.js dayArc row' };
    const nightMax = cell.phase === 'night' ? targets.night?.maxOverA ?? null : null;
    return {
        row, over,
        inArc: Math.abs(over - arc.overA) <= arc.toleranceLu,
        pass: nightMax == null || over <= nightMax,
        want: `A ${arc.overA >= 0 ? '+' : ''}${arc.overA} ± ${arc.toleranceLu}${nightMax != null ? `, night ≤ A + ${nightMax}` : ''}`,
    };
}

// → { rows: [{ ...cell, ...judgement }], arc: { n, within, share, minShare,
// pass }, failures: rows failing their hard criterion, pass }
export function judgeWorldMap(cells, A, targets = LOUDNESS_TARGETS) {
    const rows = cells.map(c => ({ ...c, ...judgeWorldCell(c, A, targets) }));
    const arcRows = rows.filter(r => r.row === 'dayArc');
    const within = arcRows.filter(r => r.inArc).length;
    const share = arcRows.length ? within / arcRows.length : null;
    const minShare = targets.dayArc?.withinShare ?? null;
    const arc = { n: arcRows.length, within, share, minShare, pass: share != null && minShare != null && share >= minShare };
    const failures = rows.filter(r => !r.pass);
    return { rows, arc, failures, pass: rows.length > 0 && arc.pass && failures.length === 0 };
}

// Must-never 7: night or weather louder than the day by more than 6 LU at
// one slider setting — every cell against the clear day at the same load.
export const MUST_NEVER_7_LU = 6;

export function nightWeatherOverDay(cells, { maxLu = MUST_NEVER_7_LU, reference = { phase: 'day', weather: 'clear' } } = {}) {
    const rows = [];
    for (const c of cells) {
        const ref = cells.find(r => r.load === c.load && r.phase === reference.phase && r.weather === reference.weather);
        if (!ref || ref === c) continue;
        rows.push({ ...c, overDay: c.lufsI - ref.lufsI });
    }
    const worst = rows.reduce((w, r) => (w == null || r.overDay > w.overDay ? r : w), null);
    const failures = rows.filter(r => !(r.overDay <= maxLu));
    return { rows, worst, failures, pass: rows.length > 0 && failures.length === 0 };
}

// S2 night row, world stratum (4.4): the night bed's 2–5 kHz band at least
// `minDb` under noon's. Levels in dB of the same band on the same stem.
export function presenceUnderNoon(nightDb, noonDb, { minDb = LOUDNESS_TARGETS.night.presenceUnderNoonDb } = {}) {
    const underDb = Number.isFinite(nightDb) && Number.isFinite(noonDb) ? noonDb - nightDb : null;
    return { underDb, minDb, pass: underDb != null && underDb >= minDb };
}

// S7: ambient non-musical onsets ≤ 180/min island-wide, crickets included.
// cells: [{ onsetsPerMin }] → { worst, over, pass }
export const AMBIENT_ONSETS_PER_MIN = 180;

export function judgeOnsetBudget(cells, { max = AMBIENT_ONSETS_PER_MIN } = {}) {
    const measured = cells.filter(c => Number.isFinite(c.onsetsPerMin));
    const worst = measured.reduce((w, c) => (w == null || c.onsetsPerMin > w.onsetsPerMin ? c : w), null);
    const over = measured.filter(c => c.onsetsPerMin > max);
    return { worst, over, max, pass: measured.length === cells.length && measured.length > 0 && over.length === 0 };
}

// S6 / C-AMB-1: the world stem at two agent counts, one seed, is the same
// stem. The virtual clock is not bit-exact run to run: two renders of one
// scene differ by max |Δ| ≈ 1e-9…1e-8 (Chrome's offline renderer), so
// "bit-identical" is judged as identical within renderer noise: max |Δ| ≤
// 1e-6 (−120 dBFS) or ≤ the same-count repeat's max |Δ| measured beside it
// (a repeat over 1e-6 is real nondeterminism and prints a WARN; the last
// one, 5e-4 in the wind, was an unvirtualized `new Date()`). A world that
// followed agents — a level step, a moved event — differs by orders of
// magnitude more. The sea's yield to scheduled cues (4.6, AMB-9) is a
// sanctioned coupling to cues, not to agent state; the fixtures schedule
// no cue.
export const WORLD_STEM_MAX_ABS = 1e-6;

// maxAbs: the largest sample difference across agent counts (0 when
// bit-identical), null when unmeasured, Infinity when the stems differ in
// length; noise: the same-count repeat's max |Δ| (optional).
export function judgeWorldStem(maxAbs, { max = WORLD_STEM_MAX_ABS, noise = null } = {}) {
    const limit = Math.max(max, Number.isFinite(noise) ? noise : 0);
    return { identical: maxAbs === 0, pass: maxAbs != null && maxAbs <= limit, max, limit };
}

// Bakes that land at different audio times in two renders of one scene
// (the renderer's known source of run-to-run difference: a bake finishing
// a step earlier or later). bakes: [{ key, t }] per render, in order; the
// n-th landing of a key pairs with the n-th. → [{ key, a, b }] (a/b null
// when one render never landed it)
export function bakeLandingDiffs(a, b, { tolSec = 0.001 } = {}) {
    const index = (list) => {
        const n = new Map();
        return (list || []).map((x) => {
            const k = n.get(x.key) ?? 0;
            n.set(x.key, k + 1);
            return { ...x, id: `${x.key}#${k}` };
        });
    };
    const B = new Map(index(b).map(x => [x.id, x]));
    const diffs = [];
    for (const x of index(a)) {
        const y = B.get(x.id);
        B.delete(x.id);
        if (!y || Math.abs(x.t - y.t) > tolSec) diffs.push({ key: x.key, a: x.t, b: y ? y.t : null });
    }
    for (const y of B.values()) diffs.push({ key: y.key, a: null, b: y.t });
    return diffs;
}

// Map cells: the `b`-load row of each phase × weather carries the max |Δ|
// of its world stem against the `a`-load render. → { pairs, differing, pass }
export function worldStemDiffers(cells, { b = 'w12', max = WORLD_STEM_MAX_ABS } = {}) {
    const pairs = cells.filter(c => c.load === b).map(c => ({ phase: c.phase, weather: c.weather, maxAbs: c.worldMaxAbs ?? null, ...judgeWorldStem(c.worldMaxAbs ?? null, { max }) }));
    const differing = pairs.filter(p => !p.pass);
    return { pairs, differing, pass: pairs.length > 0 && differing.length === 0 };
}

// --------------------------------------------------------------------- sea ----
// 4.1 (AMB-1) acceptance: the day sea stem 2–6 LU under A; ICC 0.1–0.4 and
// r(4 s) < 0.05 on a 60 s capture; about five breaking waves a minute by day
// (AMB-1: 4–7 clear, 7–10 in a storm); the night bed +7…+20 dB in
// 250 Hz–1 kHz with the sea against without it; no gulls at night or in a
// storm (C-AMB-7: gulls roost); hull groans out of 500–700 Hz (every
// resonance ≤ 450 or ≥ 800 Hz); zero nodes per wave (only rare-voice takes
// create nodes, ≤ 2 each: C-AMB-4).
export const SEA_LIMITS = Object.freeze({
    underA: Object.freeze([2, 6]),
    icc: Object.freeze([0.1, 0.4]),
    r4Max: 0.05,
    breaksPerMin: Object.freeze([4, 7]),
    stormBreaksPerMin: Object.freeze([7, 10]),
    nightGainDb: Object.freeze([7, 20]),
    nightGainBandHz: Object.freeze([250, 1000]),
    groanForbiddenHz: Object.freeze([450, 800]),
    nodesPerTake: 2,
});

// Whether `v` lies in [lo, hi] (a finite number only).
export function withinRange(v, [lo, hi]) {
    return Number.isFinite(v) && v >= lo && v <= hi;
}

// Breaking waves per minute: the sea's committed crests (each is one wave
// breaking on one of its crash lanes) in [t0, t1).
export function crestRate(crests, t0, t1) {
    if (!(t1 > t0)) return null;
    const n = (crests || []).filter(c => c.t >= t0 && c.t < t1).length;
    return (60 * n) / (t1 - t0);
}

// The crest nearest `t` → { t, lane, gapSec, moved } | null.
export function nearestCrest(crests, t) {
    let best = null;
    for (const c of crests || []) {
        const gapSec = Math.abs(c.t - t);
        if (!best || gapSec < best.gapSec) best = { t: c.t, lane: c.lane ?? null, gapSec, moved: Boolean(c.moved) };
    }
    return best;
}

// Groan resonances inside the forbidden band (exclusive of its edges).
export function groanViolations(rare, [lo, hi] = SEA_LIMITS.groanForbiddenHz) {
    return (rare || []).filter(r => r.kind === 'groan').flatMap(r => (r.hz || []).filter(hz => hz > lo && hz < hi).map(hz => ({ t: r.t, hz })));
}

// ---------------------------------------------------------------- thunder ----
// 4.2 (AMB-6): each strike's LU over its storm bed from the thunder onset —
// near (intensity ≥ nearAt) and far windows from Loudness.js; the level
// monotonic in intensity (a louder-for-less step beyond `monotonicTolLu`
// fails); the onset `0.4 + 4.5·(1 − intensity)` s after the flash; limiter
// GR ≤ ceiling.thunderGrMaxDb; a fresh noise grain per strike (its reads
// ≥ `grainSepSec` of buffer from the last `grainRecent` strikes'); no duck.
export const THUNDER_LIMITS = Object.freeze({ delayTolSec: 0.25, monotonicTolLu: 0.5, grainSepSec: 5, grainRecent: 2 });

export function thunderDelaySec(intensity) {
    return 0.4 + 4.5 * (1 - Math.min(1, Math.max(0, intensity)));
}

// Loudness.js: the windows in AUDIBILITY_WINDOWS.lanes.thunder ({ near, far }),
// the near/far split in LOUDNESS_TARGETS.storm.thunderNearFrom (intensity at
// or above it is near). → { near: {min,max}, far, nearAt }
export function thunderWindows(targets = LOUDNESS_TARGETS, windows = AUDIBILITY_WINDOWS) {
    const w = windows.lanes.thunder;
    return { near: w.near, far: w.far, nearAt: targets.storm?.thunderNearFrom ?? null };
}

// A strike whose read of a pool buffer — a span [off, end] of buffer time —
// comes closer than `sepSec` to (or overlaps) a read of one of the `recent`
// strikes before it reuses a grain (the pool's brown buffers hold ≈ 68 s,
// so freshness is audible against the last strikes, not the whole storm);
// `end` defaults to `off`. strikes: [{ grains: [{ buf, off, end }] }] in
// strike order → [{ a, b, buf, gapSec }]
export function grainReuse(strikes, { sepSec = THUNDER_LIMITS.grainSepSec, recent = THUNDER_LIMITS.grainRecent } = {}) {
    const reused = [];
    const gap = (x, y) => Math.max(x.off ?? 0, y.off ?? 0) - Math.min(x.end ?? x.off ?? 0, y.end ?? y.off ?? 0);
    for (let i = 0; i < strikes.length; i++) {
        for (let j = i + 1; j < Math.min(strikes.length, i + 1 + recent); j++) {
            let hit = null;
            for (const x of strikes[i].grains || []) {
                if (x.buf == null) continue;
                for (const y of strikes[j].grains || []) {
                    if (y.buf === x.buf && gap(x, y) < sepSec && (!hit || gap(x, y) < hit.gapSec)) hit = { a: i, b: j, buf: x.buf, gapSec: gap(x, y) };
                }
            }
            if (hit) reused.push(hit);
        }
    }
    return reused;
}

// strikes: [{ intensity, margin, delaySec, grDb, grains }] in flash order.
export function judgeThunder(strikes, { windows = thunderWindows(), grMaxDb = LOUDNESS_TARGETS.ceiling.thunderGrMaxDb, limits = THUNDER_LIMITS } = {}) {
    const rows = strikes.map((s) => {
        const near = windows.nearAt != null && s.intensity >= windows.nearAt;
        const win = near ? windows.near : windows.far;
        const expected = thunderDelaySec(s.intensity);
        const failures = [];
        if (windows.nearAt == null) failures.push('no near/far boundary in Loudness.js');
        if (!Number.isFinite(s.margin)) failures.push('no thunder heard');
        else if (s.margin < win.min || s.margin > win.max) failures.push(`${near ? 'near' : 'far'} margin outside +${win.min}…+${win.max}`);
        if (!Number.isFinite(s.delaySec) || Math.abs(s.delaySec - expected) > limits.delayTolSec) failures.push(`onset ${Number.isFinite(s.delaySec) ? s.delaySec.toFixed(2) : '—'} s after the flash, want ${expected.toFixed(2)} ± ${limits.delayTolSec}`);
        if (Number.isFinite(s.grDb) && s.grDb > grMaxDb) failures.push(`GR > ${grMaxDb} dB`);
        return { ...s, near, window: win, expectedDelaySec: expected, failures, pass: failures.length === 0 };
    });
    const sorted = rows.filter(r => Number.isFinite(r.margin)).sort((a, b) => a.intensity - b.intensity);
    const drops = [];
    for (let i = 1; i < sorted.length; i++) {
        if (sorted[i].intensity > sorted[i - 1].intensity && sorted[i].margin < sorted[i - 1].margin - limits.monotonicTolLu) {
            drops.push({ from: sorted[i - 1].intensity, to: sorted[i].intensity, deltaLu: sorted[i].margin - sorted[i - 1].margin });
        }
    }
    const reused = grainReuse(strikes, { sepSec: limits.grainSepSec, recent: limits.grainRecent });
    return {
        rows, drops, reused,
        monotonic: sorted.length === rows.length && drops.length === 0,
        pass: rows.length > 0 && rows.every(r => r.pass) && drops.length === 0 && reused.length === 0 && sorted.length === rows.length,
    };
}

// ------------------------------------------------------------- CPU proxy ----
// S8 / 4.1 / 4.3 (INFO): the offline-render proxy of one core — wall ms of
// the stepped render over audio ms, in percent. It includes the harness's
// virtual clock and the app's director work, so it reads high; compare
// scenes relatively.
export function cpuProxyPct(renderMs, audioSec) {
    return Number.isFinite(renderMs) && audioSec > 0 ? (100 * renderMs) / (audioSec * 1000) : null;
}

// ========================================================== Wave 5 =========
// The acceptance lines of 5.1 and 5.3–5.8 (the plan's numbers; FOL-9 and
// FOL round 2 give the reference scene and its metrics).
export const WORK_LIMITS = Object.freeze({
    // 5.1: the Forge's longest gap while it works; the stop.
    forgeMaxGapSec: 2.8, stopLeadSec: 1,
    // 5.1 (FOL-5, HAR-12): published strikes vs the drawn downbeats; the
    // 2 s poll must not become a rhythm.
    syncMedianMs: 15, syncP95Ms: 30, pulseIndexMax: 1.8, pollSec: 2, pulseBins: 8,
    // 5.1: the scheduler's main-thread cost per tick (INFO on this host).
    tickMs: 0.1,
    // 5.3 (C-FOL-3). Audibility rests on ≥ 20 accents per building (a 3/4
    // share is not evidence); the 2–5 kHz share is judged absolute in the
    // reference scene and as the stratum's increment elsewhere.
    underProgramLu: 8, programDeltaMaxLu: 0.5, tpUnderUrgentDb: 2, heardShare: 0.8, heardRiseDb: 6, heardMinAccents: 20,
    share25MaxPct: 1.5, share25IncrementMaxPts: 0.3, maxOnsetsPer1s: 3, routineLossMaxLu: 0.3,
    // 5.4 (SIG-11, SIG-12).
    focusDb: 4, focusTolDb: 0.5, signalTolLu: 0.5,
    // 5.6 (D3): Village world and work ×0.5, music 0, Town band −3 dB; the
    // held note and signals untouched; focus restores within 1 s.
    quietWorldDb: 20 * Math.log10(0.5), quietTownDb: -3, quietTolDb: 1, heldTolDb: 0.5, musicOffDb: -40, restoreSec: 1,
    // The accents' unblurred reference (before the blur and after focus):
    // one noisy strike peak per building is no reference.
    quietRefAccentsMin: 8,
    // 5.7 (SIG-13).
    quotaRiseDb: 10, quotaMonotonicTolDb: 0.2, quotaSilentDb: -40,
    // 5.8 (D8).
    crossWithinSec: 0.6, panStep: 0.2,
});

// FOL round 2's detection bands (C-FOL-3's 1.2–5 kHz lane by day; the
// shutters' 1.2–3 kHz at night).
export const WORK_BANDS_DAY = Object.freeze({
    forge: [1500, 5000], archive: [1500, 5000], mine: [1500, 6000], harbor: [1200, 5000],
    taskboard: [1200, 5000], observatory: [1500, 5000], portal: [1200, 5000], command: [1200, 5000],
});
export const WORK_BANDS_NIGHT = Object.freeze(Object.fromEntries(Object.keys(WORK_BANDS_DAY).map(b => [b, [1200, 3000]])));

// ------------------------------------------------------------ work timing ----
// The longest gap between consecutive strikes inside [from, to] (the first
// strike at or after `from` opens the span). → { maxGapSec, at, n }
export function longestGap(times, { from = -Infinity, to = Infinity } = {}) {
    const t = times.filter(x => Number.isFinite(x) && x >= from && x <= to).sort((a, b) => a - b);
    let maxGapSec = null;
    let at = null;
    for (let i = 1; i < t.length; i++) {
        const g = t[i] - t[i - 1];
        if (maxGapSec == null || g > maxGapSec) { maxGapSec = g; at = t[i - 1]; }
    }
    return { maxGapSec, at, n: t.length };
}

// 5.1 / FOL-7: a building stops with its agents. The last strike lands no
// more than `leadSec` before the first non-working observation (`stopSec`)
// and none later than one gesture period after it.
// → { lastSec, leadSec (stop − last), late: strikes after stop + period, pass }
export function stopTiming(times, stopSec, periodSec, { leadSec = WORK_LIMITS.stopLeadSec } = {}) {
    const t = times.filter(Number.isFinite);
    const lastSec = t.length ? Math.max(...t) : null;
    const late = t.filter(x => x > stopSec + periodSec).length;
    const pass = lastSec != null && lastSec >= stopSec - leadSec && late === 0;
    return { lastSec, leadSec: lastSec != null ? stopSec - lastSec : null, late, pass };
}

// 5.1 (FOL-5, HAR-12): every published accent against the downbeats the
// harness's conductor draws (Date.now ms). Each strike pairs with its
// nearest drawn downbeat; a strike farther than `maxPairMs` from every
// downbeat is off the drawn grid. → { n, unmatched, medianAbsMs, p95AbsMs,
// covered (drawn downbeats with a strike within `syncMs`), drawn, pass }
export function downbeatSync(strikeMs, drawnMs, { maxPairMs = 100, syncMs = WORK_LIMITS.syncMedianMs, limits = WORK_LIMITS } = {}) {
    const drawn = drawnMs.filter(Number.isFinite).sort((a, b) => a - b);
    const nearest = (t) => {
        let best = null;
        for (const d of drawn) if (best == null || Math.abs(d - t) < Math.abs(best - t)) best = d;
        return best;
    };
    const errs = [];
    let unmatched = 0;
    for (const t of strikeMs.filter(Number.isFinite)) {
        const d = nearest(t);
        if (d == null || Math.abs(t - d) > maxPairMs) unmatched++;
        else errs.push(Math.abs(t - d));
    }
    const covered = drawn.filter(d => strikeMs.some(t => Math.abs(t - d) <= syncMs)).length;
    const medianAbsMs = median(errs);
    const p95AbsMs = percentile(errs, 0.95);
    return {
        n: errs.length, unmatched, medianAbsMs, p95AbsMs, covered, drawn: drawn.length,
        pass: errs.length > 0 && unmatched === 0 && medianAbsMs <= limits.syncMedianMs && p95AbsMs <= limits.syncP95Ms,
    };
}

// FOL-5: the poll-lock pulse index — onsets folded onto the poll cycle in
// `bins` bins, the fullest bin over the mean. 1 is flat; FOL's downbeats-only
// bed read 2.21. → { index, histogram }
export function pulseIndex(times, { pollPhaseSec = 0, pollSec = WORK_LIMITS.pollSec, bins = WORK_LIMITS.pulseBins } = {}) {
    const t = times.filter(Number.isFinite);
    const histogram = new Array(bins).fill(0);
    for (const x of t) {
        const ph = (((x - pollPhaseSec) % pollSec) + pollSec) % pollSec;
        histogram[Math.min(bins - 1, Math.floor((ph / pollSec) * bins))]++;
    }
    return { index: t.length ? Math.max(...histogram) / (t.length / bins) : null, histogram };
}

// S7: the densest `winSec` window of onsets (strikes within 1 ms are one).
export function maxOnsetsIn(times, winSec = 1) {
    const t = [...new Set(times.filter(Number.isFinite).map(x => Math.round(x * 1000)))].sort((a, b) => a - b).map(x => x / 1000);
    let max = 0;
    let j = 0;
    for (let i = 0; i < t.length; i++) {
        while (t[i] - t[j] >= winSec) j++;
        max = Math.max(max, i - j + 1);
    }
    return max;
}

// ------------------------------------------------------------- work level ----
// 5.3 (C-FOL-3) in the reference scene. All levels output-referred: work
// (the workshop stratum alone, dry + air), program with and without it,
// the workshop true peak against the quietest urgent cue's.
// → { underLu, deltaLu, tpMarginDb, failures: [what], pass }
export function judgeWorkLevel({ workLufs, programLufs, envProgramLufs, workTpDbtp, urgentTpDbtp }, limits = WORK_LIMITS) {
    const failures = [];
    const underLu = finite(workLufs) && finite(programLufs) ? programLufs - workLufs : null;
    const deltaLu = finite(programLufs) && finite(envProgramLufs) ? programLufs - envProgramLufs : null;
    const minUrgent = (urgentTpDbtp || []).filter(finite);
    const floor = minUrgent.length ? Math.min(...minUrgent) : null;
    const tpMarginDb = finite(workTpDbtp) && floor != null ? floor - workTpDbtp : null;
    if (!(underLu >= limits.underProgramLu)) failures.push(`work bed ${underLu == null ? 'unmeasured' : `${underLu.toFixed(1)} LU`} under the program (want ≥ ${limits.underProgramLu})`);
    if (!(deltaLu <= limits.programDeltaMaxLu)) failures.push(`program Δ ${deltaLu == null ? 'unmeasured' : `${deltaLu >= 0 ? '+' : ''}${deltaLu.toFixed(2)} LU`} (want ≤ +${limits.programDeltaMaxLu})`);
    if (!(tpMarginDb >= limits.tpUnderUrgentDb)) failures.push(`work TP ${tpMarginDb == null ? 'unmeasured' : `${tpMarginDb.toFixed(1)} dB`} under the quietest urgent cue (want ≥ ${limits.tpUnderUrgentDb})`);
    return { underLu, deltaLu, tpMarginDb, urgentFloorDbtp: floor, failures, pass: failures.length === 0 };
}

// 5.3 / 5.5: accents heard per building. rows: { [building]: { n, heard } }
// (heard = strikes whose band rose ≥ 6 dB in context). A building fails with
// fewer than `minAccents` accents (the scene put agents there: too few
// strikes is no evidence) or under `minShare`. → { rows: [{ building, n,
// share, enough, pass }], failing, pass }
export function judgeHeard(rows, buildings, { minShare = WORK_LIMITS.heardShare, minAccents = WORK_LIMITS.heardMinAccents } = {}) {
    const out = buildings.map((building) => {
        const r = rows[building] || { n: 0, heard: 0 };
        const share = r.n ? r.heard / r.n : null;
        const enough = r.n >= minAccents;
        return { building, n: r.n, heard: r.heard, share, enough, pass: enough && share != null && share >= minShare };
    });
    const failing = out.filter(r => !r.pass);
    return { rows: out, failing, pass: failing.length === 0 };
}

// ------------------------------------------------------------------ focus ----
// 5.4 (SIG-12): the selected agent's accents step forward by focusDb ±
// tol; the other agents' do not move. Inputs: per-strike gain differences
// (dB) of the same accents with and without the selection (one seed).
// → { focusDb, otherDb (medians), pass }
export function judgeFocus({ focusDb: selected = [], otherDb: others = [] }, limits = WORK_LIMITS) {
    const focusDb = median(selected);
    const otherDb = median(others);
    const pass = focusDb != null && Math.abs(focusDb - limits.focusDb) <= limits.focusTolDb
        && (otherDb == null || Math.abs(otherDb) <= limits.focusTolDb);
    return { focusDb, otherDb, pass };
}

// ------------------------------------------------------------- quiet mix ----
// 5.6 (D3): a stem's level during the blur window against its twin render
// that never blurred (same seed: the difference is the fader), and how
// long after focus it came back within `tolDb`. curveDb: [[t, dB], …] of
// blurred-minus-twin level on a fixed hop.
// → { levelDb (median over the blur window), restoreLagSec }
export function quietStemRow(curveDb, { blurSec, focusSec, settleSec = 1, tolDb = WORK_LIMITS.quietTolDb } = {}) {
    const during = curveDb.filter(([t]) => t >= blurSec + settleSec && t < focusSec).map(([, v]) => v);
    let restoreLagSec = null;
    for (const [t, v] of curveDb) {
        if (t < focusSec) continue;
        if (Math.abs(v) <= tolDb) {
            // Restored when it stays within tolerance for the next 0.5 s.
            const hold = curveDb.filter(([u]) => u >= t && u < t + 0.5);
            if (hold.every(([, w]) => Math.abs(w) <= tolDb)) { restoreLagSec = t - focusSec; break; }
        }
    }
    return { levelDb: median(during), restoreLagSec };
}

// stems: { name: { levelDb, restoreLagSec, want (dB), tolDb } } →
// { rows, failing, pass }
export function judgeQuietMix(stems, limits = WORK_LIMITS) {
    const rows = Object.entries(stems).map(([name, s]) => {
        const off = s.want === -Infinity;
        const levelOk = off ? finite(s.levelDb) && s.levelDb <= limits.musicOffDb : finite(s.levelDb) && Math.abs(s.levelDb - s.want) <= (s.tolDb ?? limits.quietTolDb);
        const restoreOk = s.restore === false || (finite(s.restoreLagSec) && s.restoreLagSec <= limits.restoreSec);
        return { name, ...s, levelOk, restoreOk, pass: levelOk && restoreOk };
    });
    const failing = rows.filter(r => !r.pass);
    return { rows, failing, pass: rows.length > 0 && failing.length === 0 };
}

// ------------------------------------------------------------------ quota ----
// 5.7 (SIG-13): the mine's 80–160 Hz band at each ratio step (ascending
// ratios), rising monotonically by ≥ quotaRiseDb from the first to the
// last. A silent step is −Infinity (a measured silence); only a missing
// number is unmeasured. → { riseDb, drops: [{ from, to, deltaDb }], pass }
export function judgeQuotaSweep(steps, limits = WORK_LIMITS) {
    const s = steps.filter(x => typeof x.levelDb === 'number' && !Number.isNaN(x.levelDb));
    const drops = [];
    for (let i = 1; i < s.length; i++) {
        const deltaDb = s[i].levelDb - s[i - 1].levelDb;
        if (deltaDb < -limits.quotaMonotonicTolDb) drops.push({ from: s[i - 1].ratio, to: s[i].ratio, deltaDb });
    }
    const riseDb = s.length >= 2 ? s[s.length - 1].levelDb - s[0].levelDb : null;
    return { riseDb, drops, pass: s.length === steps.length && s.length >= 2 && riseDb >= limits.quotaRiseDb && drops.length === 0 };
}

// ----------------------------------------------------------------- camera ----
// 5.8: a parameter driven by setTargetAtTime writes, reconstructed exactly:
// log rows [{ at, value, tc }] in time order from `initial`. → value(t)
export function targetTrajectory(log, initial) {
    const rows = log.filter(r => finite(r.at) && finite(r.value)).sort((a, b) => a.at - b.at);
    return (t) => {
        let from = null;
        let start = initial;
        let target = initial;
        let tc = 0.25;
        const valueAt = x => (from == null ? initial : target + (start - target) * Math.exp(-(x - from) / Math.max(tc, 1e-9)));
        for (const r of rows) {
            if (r.at > t) break;
            // Each write starts from wherever the previous approach had got to.
            start = valueAt(r.at);
            from = r.at;
            target = r.value;
            tc = r.tc ?? 0.25;
        }
        return valueAt(t);
    };
}

// The first time in [t0, t1] at which f changes sign (bisection on a
// `stepSec` scan), or null.
export function signCrossing(f, t0, t1, { stepSec = 0.005 } = {}) {
    let a = t0;
    let fa = f(a);
    for (let b = t0 + stepSec; b <= t1 + 1e-9; b += stepSec) {
        const fb = f(b);
        if (fa === 0) return a;
        if (Math.sign(fb) !== Math.sign(fa) && fb !== 0) {
            let lo = a;
            let hi = b;
            for (let k = 0; k < 40; k++) {
                const m = (lo + hi) / 2;
                if (Math.sign(f(m)) === Math.sign(fa)) lo = m; else hi = m;
            }
            return (lo + hi) / 2;
        }
        a = b;
        fa = fb;
    }
    return null;
}

// 5.8: the emitter's heard pan crosses 0 within `crossWithinSec` of the
// camera's crossing; no single write moves the pan target more than
// `panStep`; no write at all while the camera is still.
// → { lagSec, maxStep, stillWrites, pass }
export function judgeCameraPan({ cameraCrossSec, heardCrossSec, targets, stillWrites }, limits = WORK_LIMITS) {
    const lagSec = finite(cameraCrossSec) && finite(heardCrossSec) ? heardCrossSec - cameraCrossSec : null;
    let maxStep = 0;
    for (let i = 1; i < targets.length; i++) maxStep = Math.max(maxStep, Math.abs(targets[i] - targets[i - 1]));
    const pass = lagSec != null && lagSec >= 0 && lagSec <= limits.crossWithinSec
        && maxStep <= limits.panStep + 1e-9 && stillWrites === 0;
    return { lagSec, maxStep, stillWrites, pass };
}

// ================================================================ Wave 6 ====
// The music: MUSL-10's stem gate (6.2), the Isle Band A/B (6.1), the night
// voicing (6.3), the score (6.5), the occasion clock's day (6.6), the Town
// band hour (6.7) and the band's workshop percussion (6.9). Targets are the
// plan's acceptance lines, S2 (Loudness.js) and S7.
export const MUSIC_LIMITS = Object.freeze({
    // MUSL-2 stem balance, LU re the lead stem: [target, ± tolerance].
    stems: Object.freeze({
        bass: Object.freeze([-3.5, 1.5]), counter: Object.freeze([-6, 2]), engine: Object.freeze([-8, 2]), percussion: Object.freeze([-14, 3]),
        // The band's own brushes / chip hat at the full band (Voicings
        // STEM_TARGETS.groove): a percussion stem, the percussion window.
        groove: Object.freeze([-14, 3]),
    }),
    // MUSL-1's harp row (−8…−9) for the descant: printed, not gated (the
    // plan's acceptance names the four stems above and the floor).
    descantInfo: Object.freeze([-9, -8]),
    floorLu: -15,
    // MUSL-3 / HAR-11: each working band vs the one below.
    bandOnsetRise: 0.3, bandOctaveDb: 3,
    // 6.1: level-matched A/B of the same notes.
    laptopLossMaxLu: 1.5, sideMidDb: Object.freeze([-16, -9]), monoLossMaxLu: 1, nightPresenceUnderDayDb: 4, nodesPerNote: 4,
    // 6.3.
    nightLeadMaxMidi: 81, stopMaxDb: -60,
    // 6.5 (S7): identical 16-bar renditions ≥ 60 min apart, re-hearing over
    // music-on windows, motif statements per hour.
    renditionGapSec: 3600, reheardMaxPct: 10, motifPerHour: 6,
    // 6.7 / S7 / must-never 10.
    loopsPerVisit: 2, noReturnSec: 360, noReturnSmallSetSec: 240, smallSet: 4,
    breathEverySec: 600, breathSec: 1.4, breathTolSec: 0.05, townDutyMin: 0.85, townReheardMaxPct: 25, loopsPerPieceHour: 12,
    // 6.9.
    spearmanMin: 0.7,
    // Must-never 10: Village music-on per working hour.
    villageOnMax: 0.15,
});

// D1 (Decisions, MUSL's revised duty): the Village duty band per regime,
// as a share of the hour. `busy` is while ≥ 3 agents work; `light` with
// fewer; `night` and `deepNight` are ceilings (OccasionClock's regimes).
export const D1_DUTY = Object.freeze({
    busy: Object.freeze([0.06, 0.10]), light: Object.freeze([0, 0.20]), night: Object.freeze([0, 0.08]), deepNight: Object.freeze([0, 0.03]),
});

// MUSL-2 / MUSL-3 floor: `seats` { seat: LUFS-I } of one render (every
// seat measured alone at the output), `admitted` the seats the band plays.
// Every admitted seat other than the lead sits in its window re the lead,
// ≥ the floor and under the lead (the melody is the loudest stem).
// → { rows: [{ seat, reLead, window, inWindow, aboveFloor, pass }], pass }
export function judgeStemBalance(seats, admitted, limits = MUSIC_LIMITS) {
    const lead = seats.lead;
    const rows = [];
    for (const seat of admitted) {
        if (seat === 'lead') continue;
        const v = seats[seat];
        const reLead = finite(lead) && finite(v) ? v - lead : (finite(lead) && v === -Infinity ? -Infinity : null);
        const w = limits.stems[seat] ?? null;
        const inWindow = w ? reLead != null && Math.abs(reLead - w[0]) <= w[1] + 1e-9 : true;
        const aboveFloor = reLead != null && reLead >= limits.floorLu;
        const underLead = reLead != null && reLead < 0;
        rows.push({ seat, reLead, window: w, inWindow, aboveFloor, underLead, pass: inWindow && aboveFloor && underLead });
    }
    return { lead, rows, pass: finite(lead) && rows.every(r => r.pass) };
}

// HAR-11: band `upper` vs the band below: ≥ 30 % more onsets, or ≥ 3 dB
// more in some octave band. `lower`/`upper` { onsets, octaveDb: number[] }
// (the same octave bands, same duration). → { rise, maxOctaveDb, pass }
export function bandStep(lower, upper, limits = MUSIC_LIMITS) {
    const rise = lower.onsets > 0 ? upper.onsets / lower.onsets - 1 : (upper.onsets > 0 ? Infinity : 0);
    let maxOctaveDb = -Infinity;
    for (let i = 0; i < Math.min(lower.octaveDb.length, upper.octaveDb.length); i++) {
        const a = lower.octaveDb[i];
        const b = upper.octaveDb[i];
        if (b === -Infinity) continue;
        const d = a === -Infinity ? Infinity : b - a;
        if (Number.isNaN(d)) continue;
        maxOctaveDb = Math.max(maxOctaveDb, d);
    }
    return { rise, maxOctaveDb, pass: rise >= limits.bandOnsetRise - 1e-9 || maxOctaveDb >= limits.bandOctaveDb };
}

// 6.1: one arm's music stem, level-matched: laptop-model loss (a positive
// LU number), S/M, mono fold loss. → { failures: [string], pass }
export function judgeIsleArm({ laptopLossLu, sideMidDb, monoLossLu }, limits = MUSIC_LIMITS) {
    const failures = [];
    if (!(finite(laptopLossLu) && laptopLossLu <= limits.laptopLossMaxLu)) failures.push('laptop');
    if (!(finite(sideMidDb) && sideMidDb >= limits.sideMidDb[0] && sideMidDb <= limits.sideMidDb[1])) failures.push('S/M');
    if (!(finite(monoLossLu) && monoLossLu <= limits.monoLossMaxLu)) failures.push('mono');
    return { failures, pass: failures.length === 0 };
}

// 2–5 kHz share (dB re total) of night vs day: night ≤ day − minDb.
export function nightDarker(dayDb, nightDb, minDb = MUSIC_LIMITS.nightPresenceUnderDayDb) {
    const under = finite(dayDb) && finite(nightDb) ? dayDb - nightDb : null;
    return { under, pass: under != null && under >= minDb - 1e-9 };
}

// Level of a stopped voice at its stop re its own peak, from the recorded
// automation of its envelope: `events` in call order, each { type, t, v,
// tau?, values?, dur? }, the param's value before any automation `v0`.
// Web Audio semantics (setValue, linear/exponential ramps from the
// previous event, setTarget, setValueCurve, cancel, cancelAndHold).
// → value(t)
export function automationCurve(events, v0 = 1) {
    let list = [];
    const valueIn = (evs, t) => {
        let v = v0;
        let prevT = 0;
        let prevV = v0;
        for (let i = 0; i < evs.length; i++) {
            const e = evs[i];
            if (e.type === 'linear' || e.type === 'exponential') {
                if (t < e.t) {
                    if (t < prevT) return v;
                    const f = (t - prevT) / Math.max(1e-12, e.t - prevT);
                    if (e.type === 'linear') return prevV + (e.v - prevV) * f;
                    if (prevV > 0 && e.v > 0) return prevV * Math.pow(e.v / prevV, f);
                    return prevV;
                }
                v = e.v; prevT = e.t; prevV = e.v;
                continue;
            }
            if (t < e.t) return v;
            if (e.type === 'set' || e.type === 'hold') { v = e.v; prevT = e.t; prevV = e.v; continue; }
            if (e.type === 'target') {
                const next = evs[i + 1];
                const end = next && next.t <= t && next.type !== 'linear' && next.type !== 'exponential' ? next.t : t;
                const at = next && (next.type === 'linear' || next.type === 'exponential') ? Math.min(t, next.t) : end;
                v = e.v + (prevV - e.v) * Math.exp(-(at - e.t) / Math.max(1e-9, e.tau));
                prevT = at; prevV = v;
                continue;
            }
            if (e.type === 'curve') {
                const n = e.values.length;
                if (t < e.t + e.dur) {
                    const x = ((t - e.t) / e.dur) * (n - 1);
                    const k = Math.floor(x);
                    return e.values[k] + (e.values[Math.min(n - 1, k + 1)] - e.values[k]) * (x - k);
                }
                v = e.values[n - 1]; prevT = e.t + e.dur; prevV = v;
            }
        }
        return v;
    };
    for (const e of events) {
        if (e.type === 'cancel') { list = list.filter(x => x.t < e.t); continue; }
        if (e.type === 'cancelHold') {
            const held = valueIn(list, e.t);
            list = list.filter(x => x.t <= e.t && !((x.type === 'linear' || x.type === 'exponential') && x.t > e.t));
            list.push({ type: 'hold', t: e.t, v: held });
            continue;
        }
        list.push(e);
        list.sort((a, b) => a.t - b.t);
    }
    return t => valueIn(list, t);
}

// Spearman rank correlation (average ranks for ties); null under 3 pairs
// or with a constant side.
export function spearman(xs, ys) {
    const n = Math.min(xs.length, ys.length);
    if (n < 3) return null;
    const rank = (a) => {
        const idx = a.map((v, i) => [v, i]).sort((p, q) => p[0] - q[0]);
        const r = new Array(a.length);
        for (let i = 0; i < idx.length;) {
            let j = i;
            while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
            for (let k = i; k <= j; k++) r[idx[k][1]] = (i + j) / 2 + 1;
            i = j + 1;
        }
        return r;
    };
    const rx = rank(xs.slice(0, n));
    const ry = rank(ys.slice(0, n));
    const mean = (n + 1) / 2;
    let sxy = 0;
    let sxx = 0;
    let syy = 0;
    for (let i = 0; i < n; i++) {
        sxy += (rx[i] - mean) * (ry[i] - mean);
        sxx += (rx[i] - mean) ** 2;
        syy += (ry[i] - mean) ** 2;
    }
    return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : null;
}

// Union length of [from, to) intervals clipped to [t0, t1).
export function coveredSec(intervals, t0, t1) {
    const v = intervals.map(i => [Math.max(t0, i.from), Math.min(t1, i.to)]).filter(([a, b]) => b > a).sort((a, b) => a[0] - b[0]);
    let sum = 0;
    let end = -Infinity;
    for (const [a, b] of v) {
        if (b <= end) continue;
        sum += b - Math.max(a, end);
        end = b;
    }
    return sum;
}

// Seconds of music inside forbidden windows (each { from, to, why }), and
// the starts inside them. → { overlapSec, starts, rows, pass }
export function musicInWindows(music, windows, starts = []) {
    const rows = windows.map(w => ({ ...w, sec: coveredSec(music, w.from, w.to), starts: starts.filter(t => t >= w.from && t < w.to).length }));
    const overlapSec = rows.reduce((a, r) => a + r.sec, 0);
    const n = rows.reduce((a, r) => a + r.starts, 0);
    return { overlapSec, starts: n, rows, pass: overlapSec === 0 && n === 0 };
}

// 6.9: a rain fixture — the arrangement switch lands on a chunk boundary,
// the first one the band had not yet committed when the atmosphere
// changed (`commitSec`: the director's 1 s tick + the 1.5 s music horizon).
// → { switchAt, firstBoundary, onBoundary, pass }
export function arrangementSwitch(switches, boundaries, changeAt, { commitSec = 2.5, tolSec = 0.002 } = {}) {
    const sw = switches.filter(t => t >= changeAt - tolSec).sort((a, b) => a - b)[0] ?? null;
    const after = boundaries.filter(t => t >= changeAt - tolSec).sort((a, b) => a - b);
    const onBoundary = sw != null && boundaries.some(b => Math.abs(b - sw) <= tolSec);
    const allowed = after.filter((b, i) => i === 0 || (i === 1 && after[0] < changeAt + commitSec));
    const pass = onBoundary && allowed.some(b => Math.abs(b - sw) <= tolSec);
    return { switchAt: sw, firstBoundary: after[0] ?? null, onBoundary, pass };
}

// 6.7 / must-never 10: a piece starting again less than `noReturnSec` after
// its previous visit ended (the smaller window when the set has < 4
// pieces). `visits` [{ piece, from, to }] in time order.
// → { returns: [{ piece, gapSec, at }], minGapSec, pass }
export function earlyReturns(visits, { setSize = Infinity, limits = MUSIC_LIMITS } = {}) {
    const minSec = setSize < limits.smallSet ? limits.noReturnSmallSetSec : limits.noReturnSec;
    const lastEnd = new Map();
    const returns = [];
    let minGapSec = Infinity;
    for (const v of visits) {
        if (lastEnd.has(v.piece)) {
            const gap = v.from - lastEnd.get(v.piece);
            minGapSec = Math.min(minGapSec, gap);
            if (gap < minSec) returns.push({ piece: v.piece, gapSec: gap, at: v.from });
        }
        lastEnd.set(v.piece, v.to);
    }
    return { returns, minGapSec, minSec, pass: returns.length === 0 };
}

// S7: at least one breath or interlude in every 10 minutes (consecutive
// windows from `from`; a trailing part shorter than the window is ignored).
// → { windows, empty: [start], pass }
export function breathsPerWindow(times, from, to, { windowSec = MUSIC_LIMITS.breathEverySec } = {}) {
    const empty = [];
    let windows = 0;
    for (let a = from; a + windowSec <= to + 1e-9; a += windowSec) {
        windows++;
        if (!times.some(t => t >= a && t < a + windowSec)) empty.push(a);
    }
    return { windows, empty, pass: windows > 0 && empty.length === 0 };
}

// S7 loops: identical 16-bar renditions per piece per clock hour — a
// rendition whose key repeats one already heard in that hour.
// `renditions` [{ piece, t, key }]. → { worst: { piece, hour, loops }, pass }
export function loopsPerPieceHour(renditions, { max = MUSIC_LIMITS.loopsPerPieceHour, from = 0 } = {}) {
    const seen = new Map();
    const loops = new Map();
    for (const r of renditions) {
        const hour = Math.floor((r.t - from) / 3600);
        const k = `${r.piece}|${hour}`;
        const keys = seen.get(k) || new Set();
        if (keys.has(r.key)) loops.set(k, (loops.get(k) || 0) + 1);
        keys.add(r.key);
        seen.set(k, keys);
    }
    let worst = { piece: null, hour: null, loops: 0 };
    for (const [k, n] of loops) if (n > worst.loops) worst = { piece: k.split('|')[0], hour: Number(k.split('|')[1]), loops: n };
    return { worst, pass: worst.loops <= max };
}

// Motif statements per clock hour: `times` in seconds from `from`.
// → { perHour: number[], max, pass }
export function perHourMax(times, from, to, max = MUSIC_LIMITS.motifPerHour) {
    const hours = Math.max(1, Math.ceil((to - from) / 3600 - 1e-9));
    const perHour = Array.from({ length: hours }, (_, h) => times.filter(t => t >= from + h * 3600 && t < from + (h + 1) * 3600).length);
    const worst = Math.max(...perHour);
    return { perHour, max: worst, pass: worst <= max };
}

// D1 duty for one regime: music-on share of the regime's time.
export function judgeDuty(share, regime, bands = D1_DUTY) {
    const [lo, hi] = bands[regime];
    return { share, band: [lo, hi], pass: finite(share) && share >= lo - 1e-9 && share <= hi + 1e-9 };
}

// ------------------------------------------------------------- Wave 7 ----
// 7.2 Signals: between cues the program stays under the floor, in a busy
// sim with or without an open wait; the needs-you call stands ≥ 20 dB over
// the loudest floor window; an arrival captions without raising the floor.
// 7.4 the awakening: its first onset ≤ 150 ms after the click (realtime,
// the worklet load included); the program's short-term within 3 dB of steady
// 4 s after the enable; its M max ≤ the needs-you call's − 12 LU; once per
// page session. 7.7: Mono's fold compensation within 0.5 LU of Speakers;
// Headphones' world bed ICC ≥ 0.4; tone ±1 → ±4 dB (± 1) above the 3 kHz
// shelf and ≤ 0.5 dB under it; Soften: struck-bell attacks ≥ 22 ms (a 25 ms
// ramp reads 24–25 ms, the 12 ms default ≤ 13), a slower thunder attack (≥ 200 ms),
// non-needs-you ducks at 0.7 × their depth (± 0.05), the needs-you call whole
// (M max within 0.2 LU).
export const WAVE7_LIMITS = Object.freeze({
    signalsFloorDbfs: -80, callOverFloorDb: 20,
    awakenOnsetMs: 150, awakenStWithinDb: 3, awakenStAtSec: 4, awakenUnderCallLu: 12,
    monoCompLu: 0.5, headphonesIccMin: 0.4,
    toneShelfDb: 4, toneTolDb: 1, toneLowTolDb: 0.5,
    softBellAttackMinMs: 22, softThunderAttackMinMs: 200, softDuckScale: 0.7, softDuckTol: 0.05, callWholeLu: 0.2,
});
