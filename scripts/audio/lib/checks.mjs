// Pure judges for the audio probe (Wave 7 gate): the S2 Town band target,
// the cue lane windows at their full S2 floors, limiter gain reduction from
// the limiter's two taps, the preset switch (fade out, entry), ducked time, the
// AV-sync pairing, Wave 2's clock, air and bank judges, Wave 3's
// discrimination, ladder, cluster, caption and honesty judges, 5.6's quiet
// mix, Wave 6's music judges (stem balance, working bands, the Isle Band
// A/B, the stop lint's envelope, rotation, breaths, loops and the
// percussion's rank correlation) and Wave 7's limits. No I/O; every
// function takes plain arrays and numbers. Targets come from Loudness.js or
// the plan's acceptance lines, never from a baseline: a baseline only
// detects drift, it cannot pass a failure.
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
// S2 targets on the named scenes (Loudness.js only).

// scenes: { townBand: { lufsI, bandStemStMax? } }. Missing scenes skip.
export function judgeSceneTargets(scenes, targets = LOUDNESS_TARGETS, { stage = PLAN_STAGE, gated = GATED_FROM } = {}) {
    const rows = [];
    const f = v => (Number.isFinite(v) ? v.toFixed(1) : '—');
    if (scenes.townBand) {
        const t = targets.townBand;
        const s = scenes.townBand;
        rows.push({
            scene: 'townBand',
            pass: Math.abs(s.lufsI - t.lufsI) <= t.toleranceLu && (s.bandStemStMax == null || s.bandStemStMax <= t.bandStemStMax),
            detail: `LUFS-I ${f(s.lufsI)}, band stem ST max ${f(s.bandStemStMax)}; want ${t.lufsI} ± ${t.toleranceLu}, band ST max ≤ ${t.bandStemStMax}`,
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

// bed: 'village' (no music: CueLevel's bed id) | 'music'. → { min, max } (either may be null).
export function laneWindow(lane, bed, { windows = AUDIBILITY_WINDOWS } = {}) {
    const spec = windows.lanes[lane];
    if (!spec) throw new Error(`unknown lane ${lane}`);
    const ctx = spec[bed] || {};
    const min = ctx.min ?? null;
    const max = ctx.max ?? spec.ceiling ?? null;
    return { min, max };
}

// S2's band rule, lowered at closure for one context: the error call over a
// busy Town band clears the presence band by ≥ +5 dB (its trim at the
// limiter cap; one more dB would pass the 3 dB GR budget). The probe's busy
// Town band beds (lib/scenes.mjs MARGIN_BEDS `busy`) judge their error rows
// with it; every other lane and bed keeps S2's ≥ +6.
export const BUSY_BAND_ERROR_BAND_RULE = Object.freeze({
    ...AUDIBILITY_WINDOWS.urgentBandRule,
    overMusic: Object.freeze({ ...AUDIBILITY_WINDOWS.urgentBandRule.overMusic, minRiseDb: 5 }),
});

// placements: [{ margin, bandsOver6dB, presenceRiseDb, grDb }] for one lane
// over one bed. Median of placements against the window; the band rule and
// the GR limit apply to urgent lanes only. `probeBed` names the probe's bed
// (MARGIN_BEDS key): a `margin:<probeBed>:<lane>` GATED_FROM row defers every
// criterion of that lane on that bed. `ceilingExempt`: the bed is quieter
// than any S2 row (the Signals preset's silence), where S2 exempts a cue
// from its ceiling and gates it by the limiter GR alone.
export function judgeLane(lane, bed, placements, { grMaxDb = LOUDNESS_TARGETS.ceiling.urgentGrMaxDb, bandRule = AUDIBILITY_WINDOWS.urgentBandRule, stage = PLAN_STAGE, probeBed = null, gated = GATED_FROM, ceilingExempt = false } = {}) {
    const win = laneWindow(lane, bed);
    if (ceilingExempt) win.max = null;
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
// Must-never 12, Town band ↔ Signals: the controller crossfades the two
// directors over its 800 ms signals fade (`fadeSec`). Signals has no bed, so
// one side of every switch is silence by design and each direction is judged
// for what the listener hears. The steady states are the momentary loudness
// before the switch [t − 8, t) and after it has settled [t + 6, t + 14]; the
// switch window is [t, t + 4]; a side is silent when its energy mean is
// under `silentLufs`. The sample judges read the program's 10 ms peak
// envelope (both channels).
//   out (Town band → Signals): no bump — the window's M max over the band's
//   p90; the band faded — the peak in the 100 ms after the fade's end
//   `fadedDb` under the peak of the 2 s before the switch (what remains is
//   the room's tail); silent (under `silenceDbfs`) by the window's end; no
//   click — after the fade's end no 10 ms block over `clickFloorDbfs` rises
//   more than `clickRiseDb` over the three before it (a tail only decays).
//   in (Signals → Town band): no bump — the window's M max over the band's
//   p90; a clean entry — the first 10 ms block over `soundDbfs` by the
//   fade's end.
// → null when unmeasurable or neither side is silent.
export const SWITCH_LIMITS = Object.freeze({
    bumpDb: 3, silentLufs: -70, fadedDb: 20, silenceDbfs: -80, soundDbfs: -60, clickFloorDbfs: -90, clickRiseDb: 6,
});
export function presetSwitch(momentary, { L, R, sr }, t, { fadeSec, before = 8, settle = [6, 14], window = 4, limits = SWITCH_LIMITS } = {}) {
    const inRange = (a, b) => momentary.filter(([end]) => end - 0.2 >= a && end - 0.2 < b).map(([, v]) => (Number.isFinite(v) ? v : -120));
    const old = inRange(t - before, t);
    const next = inRange(t + settle[0], t + settle[1]);
    const during = inRange(t, t + window);
    if (!old.length || !next.length || !during.length) return null;
    const oldLufs = energyMeanLufs(old);
    const newLufs = energyMeanLufs(next);
    const silent = v => v == null || v < limits.silentLufs;
    const direction = silent(newLufs) && !silent(oldLufs) ? 'out' : (silent(oldLufs) && !silent(newLufs) ? 'in' : null);
    if (!direction) return null;
    const block = Math.max(1, Math.round(sr * 0.01));
    const peakDb = (a, b) => {
        let p = 0;
        for (let i = Math.max(0, Math.round(a * sr)), end = Math.min(L.length, Math.round(b * sr)); i < end; i++) p = Math.max(p, Math.abs(L[i]), Math.abs(R[i]));
        return p > 0 ? 20 * Math.log10(p) : -Infinity;
    };
    const blocks = (a, b) => {
        const out = [];
        for (let s = a; s + block / sr <= b + 1e-9; s += block / sr) out.push([s, peakDb(s, s + block / sr)]);
        return out;
    };
    const hi = Math.max(...during);
    const band = direction === 'out' ? old : next;
    const row = { direction, oldLufs, newLufs, minDuring: Math.min(...during), maxDuring: hi, bumpDb: Math.max(0, hi - percentile(band, 0.9)) };
    const fadeEnd = t + fadeSec;
    if (direction === 'out') {
        const tail = blocks(fadeEnd, t + window);
        let clickDb = 0;
        for (let i = 3; i < tail.length; i++) {
            if (tail[i][1] < limits.clickFloorDbfs) continue;
            clickDb = Math.max(clickDb, tail[i][1] - Math.max(tail[i - 1][1], tail[i - 2][1], tail[i - 3][1]));
        }
        const silentAt = tail.find(([s], i) => tail.slice(i).every(([, p]) => p < limits.silenceDbfs))?.[0] ?? null;
        const fadedDb = peakDb(t - 2, t) - peakDb(fadeEnd, fadeEnd + 0.1);
        return {
            ...row, fadedDb, clickDb, silentAfter: silentAt != null ? silentAt - t : null,
            pass: row.bumpDb <= limits.bumpDb && fadedDb >= limits.fadedDb && silentAt != null && clickDb <= limits.clickRiseDb,
        };
    }
    const first = blocks(t, t + window).find(([, p]) => p > limits.soundDbfs);
    const entryAfter = first ? first[0] - t : null;
    return { ...row, entryAfter, pass: row.bumpDb <= limits.bumpDb && entryAfter != null && entryAfter <= fadeSec };
}

// ---------------------------------------------------------- ducked time ----
// Union of every duck window per bus (a bus counts where its depth < 0); a
// cancelled window ends at its cancellation (before it opened: nothing).
// Clipped to [start, end]. → { music } fraction of end − start.
export function duckedTime(ducks, start, end, { buses = ['music'] } = {}) {
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

// HAR-12 accents over the Town band. A body-anchored cue's carrying note
// sounds at its declared accent (C-CUE-5), unless S4's grid moved it onto a
// band grid point within ±`snapSec` of that accent; either way the note is
// heard where it was published. `frames` are the MusicClock frames the band
// published ({ originTime, beatSec, until }); every grid division is a
// multiple of a sixteenth (beatSec / 4).
// accents: [{ kind, published (the accent), carrying (the published note), heard }]
// → rows { offsetMs, heardMs, how: 'kept'|'moved'|'off grid'|'unheard', pass }
export function accentSync(accents, frames, { snapSec, syncMs, tolSec = 0.001 } = {}) {
    const onGrid = t => (frames || []).some((f) => {
        if (!(f?.beatSec > 0) || t < f.originTime - tolSec || t > f.until + tolSec) return false;
        const units = (t - f.originTime) / (f.beatSec / 4);
        return Math.abs(units - Math.round(units)) * (f.beatSec / 4) <= tolSec;
    });
    return accents.map((a) => {
        if (a.carrying == null || a.heard == null) return { kind: a.kind, offsetMs: null, heardMs: null, how: 'unheard', pass: false };
        const offset = a.carrying - a.published;
        const heardMs = (a.heard - a.carrying) * 1000;
        const how = Math.abs(offset) <= tolSec ? 'kept' : (Math.abs(offset) <= snapSec + tolSec && onGrid(a.carrying) ? 'moved' : 'off grid');
        return { kind: a.kind, offsetMs: offset * 1000, heardMs, how, pass: how !== 'off grid' && Math.abs(heardMs) <= syncMs };
    });
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
// any timer); `starts` counts continuous sources (the sequencer, bank
// playback) — discrete cue voices, control-rate decisions placed on the
// audio clock with a lead, are counted apart and exempt. Exactly one app
// timer may start such sources, and it must be the Transport's; its tick
// costs ≤ 0.5 ms p95, ≤ 2 ms max on the main thread.
export const TRANSPORT_LIMITS = Object.freeze({
    horizonSec: 1.5, tickP95Ms: 0.5, tickMaxMs: 2, underruns: 0,
    site: /(^|\/)Transport\.js:\d+$/,
});

export function judgeTransport(diag, timers, limits = TRANSPORT_LIMITS) {
    const failures = [];
    const soundSites = timers.filter(t => t.starts > 0 && t.site !== 'harness' && t.site !== 'untimed');
    const tick = timers.find(t => limits.site.test(t.site)) || null;
    if (!diag) failures.push('no engine.transport.diagnostics()');
    const processes = (diag?.processes || []).map(p => ({ ...p, limit: limits.horizonSec, pass: finite(p.maxAheadSec) && p.maxAheadSec <= limits.horizonSec + 1e-6 }));
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
    hourBell: 'scenery', aurora: 'scenery', linkLost: 'scenery', linkRestored: 'scenery',
    digest: 'soundOnly',
});

export function captionExpected(kind, setting, soundOn) {
    const s = CUE_STRATUM[kind];
    if (s === 'signal') return true;
    if (s === 'outcome' || s === 'routine') return setting === 'events' || setting === 'all' || (setting === 'auto' && soundOn);
    if (s === 'scenery') return setting === 'all' && soundOn;
    return false;
}

// rows: [{ kind, setting, soundOn, played, shown, heard, announceOnly }] —
// `played` a cue-played event, `shown` a caption Toast rendered for it,
// `heard` a sounding score, `announceOnly` a cue the preset captions
// without sounding it (Signals: every kind but the attention voices).
// Parity: a caption shows exactly when the plan says; no caption without a
// played cue; with sound on, every played cue sounded (the digest included)
// unless it was announced only — a caption never claims a sound that did
// not ring.
export function judgeCaptionParity(rows) {
    const failures = [];
    for (const r of rows) {
        const want = r.played && captionExpected(r.kind, r.setting, r.soundOn);
        if (r.shown !== want) failures.push(`${r.kind} (${r.setting}, sound ${r.soundOn ? 'on' : 'off'}): caption ${r.shown ? 'shown' : 'hidden'}, want ${want ? 'shown' : 'hidden'}`);
        if (r.soundOn && r.played && !r.announceOnly && r.heard === false) failures.push(`${r.kind} (sound on): captioned event with no sounding score`);
    }
    return { failures, pass: rows.length > 0 && failures.length === 0 };
}

// ------------------------------------------------------------ crown sync ----
// 3.4 / HAR-12: the release peal's published carrying note vs the crown's
// accent timestamp within ±15 ms.
export const CROWN_SYNC_MS = 15;

// ========================================================= quiet mix ======
// 5.6 (D3): the Town band −3 dB while the window is blurred; focus restores
// it within 1 s.
export const QUIET_MIX_LIMITS = Object.freeze({ quietTownDb: -3, quietTolDb: 1, restoreSec: 1 });

// A stem's level during the blur window against its twin render that never
// blurred (same seed: the difference is the fader), and how long after
// focus it came back within `tolDb`. curveDb: [[t, dB], …] of
// blurred-minus-twin level on a fixed hop.
// → { levelDb (median over the blur window), restoreLagSec }
export function quietStemRow(curveDb, { blurSec, focusSec, settleSec = 1, tolDb = QUIET_MIX_LIMITS.quietTolDb } = {}) {
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
export function judgeQuietMix(stems, limits = QUIET_MIX_LIMITS) {
    const rows = Object.entries(stems).map(([name, s]) => {
        const levelOk = finite(s.levelDb) && Math.abs(s.levelDb - s.want) <= (s.tolDb ?? limits.quietTolDb);
        const restoreOk = finite(s.restoreLagSec) && s.restoreLagSec <= limits.restoreSec;
        return { name, ...s, levelOk, restoreOk, pass: levelOk && restoreOk };
    });
    const failing = rows.filter(r => !r.pass);
    return { rows, failing, pass: rows.length > 0 && failing.length === 0 };
}

// ================================================================ Wave 6 ====
// The music: MUSL-10's stem gate (6.2), the Isle Band A/B (6.1), the night
// voicing (6.3), the score (6.5), the Town band hour (6.7) and the band's
// workshop percussion (6.9). Targets are the plan's acceptance lines, S2
// (Loudness.js) and S7.
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
    // 6.5 (S7): identical 16-bar renditions ≥ 60 min apart.
    renditionGapSec: 3600,
    // 6.7 / S7 / must-never 10.
    loopsPerVisit: 2, noReturnSec: 360, noReturnSmallSetSec: 240, smallSet: 4,
    breathEverySec: 600, breathSec: 1.4, breathTolSec: 0.05, townDutyMin: 0.85, townReheardMaxPct: 25, loopsPerPieceHour: 12,
    // 6.9.
    spearmanMin: 0.7,
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

// ------------------------------------------------------------- Wave 7 ----
// 7.2 Signals: between cues the program stays under the floor, in a busy
// sim with or without an open wait; the needs-you call stands ≥ 20 dB over
// the loudest floor window; an arrival captions without raising the floor.
// 7.4 the awakening: its first onset ≤ 150 ms after the click (realtime,
// the worklet load included); the program's short-term within 3 dB of steady
// 4 s after the enable; its M max ≤ the needs-you call's − 12 LU; once per
// page session. 7.7: Mono's fold compensation within 0.5 LU of Speakers;
// tone ±1 → ±4 dB (± 1) above the 3 kHz shelf and ≤ 0.5 dB under it;
// Soften: struck-bell attacks ≥ 22 ms (a 25 ms ramp reads 24–25 ms, the
// 12 ms default ≤ 13), non-needs-you ducks at 0.7 × their depth (± 0.05),
// the needs-you call whole (M max within 0.2 LU).
export const WAVE7_LIMITS = Object.freeze({
    signalsFloorDbfs: -80, callOverFloorDb: 20,
    awakenOnsetMs: 150, awakenStWithinDb: 3, awakenStAtSec: 4, awakenUnderCallLu: 12,
    monoCompLu: 0.5,
    toneShelfDb: 4, toneTolDb: 1, toneLowTolDb: 0.5,
    softBellAttackMinMs: 22, softDuckScale: 0.7, softDuckTol: 0.05, callWholeLu: 0.2,
});
