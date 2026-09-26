// Pure judges for the audio probe (Wave 2 gate): the S2 scene targets, the
// cue lane windows with Wave 1's interim floors, limiter gain reduction from
// the limiter's two taps, the preset-switch hole/bump, ducked time, the
// AV-sync pairing, and Wave 2's clock, air, noise, bank and sequencer
// judges. No I/O; every function takes plain arrays and numbers. Targets
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
export const PLAN_STAGE = 2;
export const GATED_FROM = Object.freeze({
    // Today's distress voice (A2) has no 0.5–4 kHz energy and urgent trims
    // never go below 0 dB; the cracked bell and escapement ticks (3.2) fix it.
    'band:error': 3,
    'band:limit': 3,
    'ceiling:error': 3,
    'ceiling:limit': 3,
    // The bed is wind + birds until the sea (4.1), and Village music becomes
    // the occasion clock in 6.6; PROGRAM_TRIM_DB is re-measured at both.
    'scene:villageBusy': 4,
    // S2's storm (≤ A + 6, ST max ≤ −27) needs thunder with distance and the
    // sea (4.1, 4.2); until then it prints DEFER with its numbers.
    'scene:storm': 4,
});

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
// { lufsI, lra, stMax, stMean, stMin, bandStemStMax? } (missing scenes skip).
export function judgeSceneTargets(scenes, targets = LOUDNESS_TARGETS, { stage = PLAN_STAGE } = {}) {
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
    // Each row: pass (the criterion itself), gatedFrom, and outcome at `stage`.
    return rows.map((row) => {
        const from = gatedFrom(`scene:${row.scene}`);
        return { ...row, gatedFrom: from, outcome: stageOutcome(row.pass ? [] : [{ what: row.scene, gatedFrom: from }], stage) };
    });
}

// --------------------------------------------------------- lane windows ----
// Wave 1 plays today's cue voices; the new signal voices arrive in 3.2, so
// 1.3 accepts needs-you and error at their S2 floors minus 2 LU. Every other
// lane is held to its full S2 window.
export const WAVE1_INTERIM_FLOOR_LU = Object.freeze({ needsYou: -2, error: -2 });
export const URGENT_LANES = Object.freeze(['needsYou', 'error', 'limit']);

// bed: 'village' | 'music' | 'weather'. → { min, max } (either may be null).
export function laneWindow(lane, bed, { interim = WAVE1_INTERIM_FLOOR_LU, windows = AUDIBILITY_WINDOWS } = {}) {
    const spec = windows.lanes[lane];
    if (!spec) throw new Error(`unknown lane ${lane}`);
    const ctx = spec[bed] || {};
    const min = ctx.min != null ? ctx.min + (interim[lane] || 0) : null;
    const max = ctx.max ?? spec.ceiling ?? null;
    return { min, max };
}

// placements: [{ margin, bandsOver6dB, presenceRiseDb, grDb }] for one lane
// over one bed. Median of placements against the window; the band rule and
// the GR limit apply to urgent lanes only.
export function judgeLane(lane, bed, placements, { grMaxDb = LOUDNESS_TARGETS.ceiling.urgentGrMaxDb, bandRule = AUDIBILITY_WINDOWS.urgentBandRule, stage = PLAN_STAGE } = {}) {
    const win = laneWindow(lane, bed);
    const margin = median(placements.map(p => p.margin));
    // Every failure carries the wave that gates it (GATED_FROM).
    const failures = [];
    const fail = (what, key) => failures.push({ what, gatedFrom: gatedFrom(key ? `${key}:${lane}` : '') });
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

// -------------------------------------------------------------- sequencer ----
// 2.3: every shipped piece through the one sequencer (chip voicing) against
// the Wave-1 reference render of the same piece at the same pinned random
// draws: identical onsets (relative to the piece's first; `onsetTolMs`
// absorbs float rounding only) and level within 0.5 LU.
export const SEQUENCER_LIMITS = Object.freeze({ lufsTolLu: 0.5, onsetTolMs: 0.5 });

export function compareOnsets(ref, cur, tolMs = SEQUENCER_LIMITS.onsetTolMs) {
    const n = Math.min(ref.length, cur.length);
    let maxDeltaMs = 0;
    let firstMismatch = null;
    for (let i = 0; i < n; i++) {
        const d = Math.abs(ref[i] - cur[i]) * 1000;
        if (d > maxDeltaMs) maxDeltaMs = d;
        if (firstMismatch == null && d > tolMs) firstMismatch = { index: i, ref: ref[i], cur: cur[i] };
    }
    if (firstMismatch == null && ref.length !== cur.length) firstMismatch = { index: n, ref: ref[n] ?? null, cur: cur[n] ?? null };
    return { refCount: ref.length, curCount: cur.length, maxDeltaMs, firstMismatch, identical: firstMismatch == null };
}

export function judgeSequencer(ref, cur, limits = SEQUENCER_LIMITS) {
    const onsets = compareOnsets(ref.onsets, cur.onsets, limits.onsetTolMs);
    const lufsDelta = finite(ref.lufsI) && finite(cur.lufsI) ? cur.lufsI - ref.lufsI : null;
    const pass = onsets.identical && onsets.refCount > 0 && lufsDelta != null && Math.abs(lufsDelta) <= limits.lufsTolLu;
    return { pass, onsets, lufsDelta };
}

// Onsets of one piece from a traced render: distinct scheduled times (0.1 ms
// grid), the first cluster (a gap over `gapSec` ends a Village song) or the
// first `loopSec` (one Town band loop), relative to the first onset.
export function pieceOnsets(times, { loopSec = null, gapSec = 4 } = {}) {
    const t = [...new Set(times.filter(finite).map(x => Math.round(x * 1e4)))].sort((a, b) => a - b).map(x => x / 1e4);
    if (!t.length) return { start: null, end: null, onsets: [] };
    const start = t[0];
    let kept;
    if (loopSec != null) kept = t.filter(x => x < start + loopSec - 1e-3);
    else {
        kept = [start];
        for (let i = 1; i < t.length && t[i] - t[i - 1] <= gapSec; i++) kept.push(t[i]);
    }
    return { start, end: kept[kept.length - 1], onsets: kept.map(x => Number((x - start).toFixed(4))) };
}

// ------------------------------------------------------------ frame cost ----
// 2.4: `world:benchmark-fps`-style app frame total (update + render) with
// sound on vs off; the p95 delta may not exceed 0.1 ms.
export const FRAME_COST_MAX_DELTA_MS = 0.1;

export function frameCostDelta(onMs, offMs) {
    const on = percentile(onMs, 0.95);
    const off = percentile(offMs, 0.95);
    const delta = on != null && off != null ? on - off : null;
    return { onP95: on, offP95: off, delta, pass: delta != null && delta <= FRAME_COST_MAX_DELTA_MS };
}
