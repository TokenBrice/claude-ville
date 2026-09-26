// Pure judges for the audio probe (Wave 1 gate): the S2 scene targets, the
// cue lane windows with Wave 1's interim floors, limiter gain reduction from
// the limiter's two taps, the preset-switch hole/bump, ducked time and the
// AV-sync pairing. No I/O; every function takes plain arrays and numbers.
import { AUDIBILITY_WINDOWS, DUCKED_TIME_BUDGET, LOUDNESS_TARGETS } from '../../../claudeville/src/presentation/shared/audio/Loudness.js';

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
export const PLAN_STAGE = 1;
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
// S2 targets on the named scenes, relative targets against the anchor as
// measured in the same run. Storm is gated at Wave 1's budget (1.4: A + 8);
// S2's A + 6 and ST max arrive with thunder with distance (4.2).
export const WAVE1_STORM_MAX_OVER_A = 8;

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
        const over = scenes.storm.lufsI - A;
        rows.push({
            scene: 'storm',
            pass: over <= WAVE1_STORM_MAX_OVER_A,
            detail: `LUFS-I ${f(scenes.storm.lufsI)} = A + ${f(over)}, ST max ${f(scenes.storm.stMax)}; want ≤ A + ${WAVE1_STORM_MAX_OVER_A} (1.4; S2's A + ${targets.storm.maxOverA} and ST max ≤ ${targets.storm.stMax} gate from 4.2)`,
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
