// The ladder intentionally knows nothing about WebGL. Keeping the pacing
// policy here makes it deterministic in unit tests and keeps renderer state
// out of its decisions.
//
// Plan 0.1 / V2: the ladder's authority is display pacing, in both
// directions. It latches the display period from the fastest warm-up frame
// gaps, demotes one level only while frames are really being missed AND the
// timing score confirms the GPU is involved (the veto), keeps a demotion only
// if it cut the misses, and climbs back through one-level probes that must hold
// the pacing (a probe reverts on misses the same veto confirms). The timer
// never demotes or promotes on its own: ANGLE-Metal's TIME_ELAPSED is a
// command-buffer wall span that grows with contention and DVFS, not with this
// frame's work.

// Every active level uploads and presents the full-resolution source each
// frame; levels reduce only optional effect work.
export const POST_FX_LEVELS = Object.freeze({
    FULL: 0,
    REDUCED: 1,
    MINIMAL: 2,
    DISABLED: 3,
});

// The latched period snaps to one of these refresh rates.
export const DISPLAY_REFRESH_RATES_HZ = Object.freeze([60, 75, 90, 100, 120, 144, 165, 240]);

export const POST_FX_LADDER_REASONS = Object.freeze({
    INITIAL: 'initial',
    LATCHING: 'latching',
    PACED: 'paced',
    PROBE_BACKOFF: 'probe-backoff',
    HOLD_GPU_OVER_BUDGET: 'hold:gpu-over-budget',
    MISSING_TIMER_UNDER_BUDGET: 'missing:timer-under-budget',
    MISSING_COOL_DOWN: 'missing:cool-down',
    MISSING_AT_FLOOR: 'missing:at-floor',
    DEMOTE: 'demote:missed-frames',
    STEP_EVALUATING: 'step-evaluating',
    STEP_KEPT: 'step-kept',
    STEP_REVERTED: 'step-reverted:shed-did-not-help',
    PROBE: 'probe',
    PROBE_KEPT: 'probe-kept',
    PROBE_REVERTED: 'probe-reverted',
    RESUME: 'resume',
    OVERRIDE: 'override',
});

// The pacing ring is two 30-bit words of miss flags: allocation-free, and a
// plain value inside the immutable state.
const WORD_BITS = 30;
const WORD_MASK = 0x3fffffff;
const MAX_PACING_WINDOW = WORD_BITS * 2;
// Warm-up gaps outside this range are not display intervals (an out-of-band
// render, a stall, a hidden tab), so they never reach the latch.
const MIN_LATCH_GAP_MS = 2;
const MAX_LATCH_GAP_MS = 100;
// After the latch, intervals above 4x the period are pauses, not misses.
const STALE_GAP_PERIODS = 4;

const DEFAULT_OPTIONS = Object.freeze({
    // Timer veto budget until a period is latched: half a 60 Hz period (M26).
    budgetMs: 1000 / 60 / 2,
    // Deepest level pacing may demote to. The resident GPU world passes
    // MINIMAL (its DISABLED renders MINIMAL's composition, so stepping there
    // could never help); the hybrid PostFx keeps DISABLED, which turns it off.
    maxLevel: POST_FX_LEVELS.DISABLED,
    // Warm-up display intervals whose p5 latches the period.
    latchSamples: 60,
    // Intervals the miss share is read over, and the length of a probe or
    // post-demotion window (at most 60).
    pacingWindow: 60,
    // An interval above this multiple of the latched period is a missed frame
    // (a missed vsync lands at 2x; jitter stays well under 1.5x).
    missRatio: 1.5,
    demoteMissShare: 0.2,
    probeMissShare: 0.05,
    // A demotion is kept only if the miss share falls to this share of its
    // pre-step value (a quarter fewer misses).
    stepHelpedRatio: 0.75,
    probeBackoffMs: 8000,
    probeBackoffMaxMs: 64000,
    coolDownMs: 60000,
    coolDownMaxMs: 960000,
    scoreWindowFrames: 15,
    uploadGraceMs: 3000,
});

function clampLevel(value) {
    if (value === null || value === undefined || value === '') return null;
    const level = Number(value);
    if (!Number.isFinite(level)) return null;
    return Math.max(0, Math.min(3, Math.round(level)));
}

function finite(value, fallback = 0) {
    return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

function positive(value, fallback) {
    const number = finite(value, fallback);
    return number > 0 ? number : fallback;
}

function share(value, fallback) {
    return Math.max(0, Math.min(1, finite(value, fallback)));
}

function positiveOrNull(value) {
    if (value === null || value === undefined) return null;
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : null;
}

function timeOrNull(value) {
    if (value === null || value === undefined) return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

function count(value) {
    return Math.max(0, Math.floor(finite(value)));
}

function normalizeOptions(options = {}) {
    const merged = { ...DEFAULT_OPTIONS, ...options };
    const probeBackoffMs = positive(merged.probeBackoffMs, DEFAULT_OPTIONS.probeBackoffMs);
    const coolDownMs = positive(merged.coolDownMs, DEFAULT_OPTIONS.coolDownMs);
    return {
        budgetMs: positive(merged.budgetMs, DEFAULT_OPTIONS.budgetMs),
        maxLevel: clampLevel(merged.maxLevel) ?? DEFAULT_OPTIONS.maxLevel,
        latchSamples: Math.max(1, Math.floor(positive(merged.latchSamples, DEFAULT_OPTIONS.latchSamples))),
        pacingWindow: Math.min(MAX_PACING_WINDOW, Math.max(1, Math.floor(positive(
            merged.pacingWindow,
            DEFAULT_OPTIONS.pacingWindow,
        )))),
        missRatio: Math.max(1, finite(merged.missRatio, DEFAULT_OPTIONS.missRatio)),
        demoteMissShare: share(merged.demoteMissShare, DEFAULT_OPTIONS.demoteMissShare),
        probeMissShare: share(merged.probeMissShare, DEFAULT_OPTIONS.probeMissShare),
        stepHelpedRatio: share(merged.stepHelpedRatio, DEFAULT_OPTIONS.stepHelpedRatio),
        probeBackoffMs,
        probeBackoffMaxMs: Math.max(probeBackoffMs, finite(merged.probeBackoffMaxMs, DEFAULT_OPTIONS.probeBackoffMaxMs)),
        coolDownMs,
        coolDownMaxMs: Math.max(coolDownMs, finite(merged.coolDownMaxMs, DEFAULT_OPTIONS.coolDownMaxMs)),
        scoreWindowFrames: Math.max(1, Math.floor(positive(
            merged.scoreWindowFrames,
            DEFAULT_OPTIONS.scoreWindowFrames,
        ))),
        uploadGraceMs: Math.max(0, finite(merged.uploadGraceMs, DEFAULT_OPTIONS.uploadGraceMs)),
    };
}

/** The refresh rate in `DISPLAY_REFRESH_RATES_HZ` nearest (in ratio) to `hz`. */
export function snapRefreshRateHz(hz) {
    const measured = positive(hz, 60);
    let best = DISPLAY_REFRESH_RATES_HZ[0];
    let bestDistance = Infinity;
    for (const candidate of DISPLAY_REFRESH_RATES_HZ) {
        const distance = Math.abs(Math.log(measured / candidate));
        if (distance < bestDistance) {
            best = candidate;
            bestDistance = distance;
        }
    }
    return best;
}

/**
 * The display period a warm-up latches: p5 of the gaps, snapped to a refresh
 * rate. p5, never the median: a steady 60 fps on a 120 Hz panel must not
 * redefine the period, or the ladder could never see it missing frames.
 */
export function latchDisplayPeriod(gapsMs = []) {
    const gaps = gapsMs.map(Number)
        .filter(gap => Number.isFinite(gap) && gap >= MIN_LATCH_GAP_MS && gap <= MAX_LATCH_GAP_MS)
        .sort((a, b) => a - b);
    if (!gaps.length) return null;
    const p5 = gaps[Math.floor((gaps.length - 1) * 0.05)];
    const refreshHz = snapRefreshRateHz(1000 / p5);
    return { refreshHz, periodMs: 1000 / refreshHz, p5Ms: p5 };
}

export function assessPostFxTimings(metrics = {}) {
    if (Number.isFinite(Number(metrics.totalMs))
        && !Number.isFinite(Number(metrics.uploadMs))
        && !Number.isFinite(Number(metrics.cpuMs))
        && !Number.isFinite(Number(metrics.shaderCpuMs))) {
        return {
            score: Math.max(0, Number(metrics.totalMs)),
            driver: 'total',
            components: { totalMs: Math.max(0, Number(metrics.totalMs)) },
        };
    }
    const upload = finite(metrics.uploadMs);
    const auxiliaryUpload = finite(metrics.auxUploadMs);
    const setupCpu = finite(metrics.setupCpuMs);
    const cpu = Number.isFinite(Number(metrics.shaderCpuMs))
        ? Number(metrics.shaderCpuMs)
        : finite(metrics.cpuMs);
    const gpu = Number.isFinite(Number(metrics.gpuMs)) ? Number(metrics.gpuMs) : 0;
    const components = {
        uploadMs: Math.max(0, upload),
        auxUploadMs: Math.max(0, auxiliaryUpload),
        setupCpuMs: Math.max(0, setupCpu),
        shaderCpuMs: Math.max(0, cpu),
        gpuMs: Math.max(0, gpu),
        frameGapPenaltyMs: 0,
    };
    let score = components.uploadMs
        + components.auxUploadMs
        + components.setupCpuMs
        + components.shaderCpuMs
        + components.gpuMs;
    let driver = Object.entries(components)
        .filter(([name]) => name !== 'frameGapPenaltyMs')
        .sort((a, b) => b[1] - a[1])[0]?.[0] || 'combined';
    // Driver stalls (e.g. canvas-producer readbacks) can land outside the
    // instrumented windows: an oversized gap between consecutive renders is
    // the only visible symptom, so fold the excess above ~30 FPS pacing in.
    const frameGap = finite(metrics.frameGapMs);
    if (frameGap > 35) {
        components.frameGapPenaltyMs = frameGap - 33;
        if (components.frameGapPenaltyMs > score) driver = 'frameGapMs';
        score = Math.max(score, components.frameGapPenaltyMs);
    }
    return { score: Math.max(0, score), driver, components };
}

function hasTimer(metrics) {
    for (const key of ['gpuMs', 'totalMs']) {
        const value = metrics[key];
        if (value !== null && value !== undefined && Number.isFinite(Number(value))) return true;
    }
    return false;
}

function normalizeSample(sample) {
    if (!sample || typeof sample !== 'object') return null;
    const score = Math.max(0, finite(sample.score));
    return {
        score,
        driver: typeof sample.driver === 'string' ? sample.driver : 'none',
        components: sample.components && typeof sample.components === 'object'
            ? { ...sample.components }
            : {},
    };
}

function medianAssessment(samples) {
    const sorted = [...samples].sort((a, b) => a.score - b.score);
    const middle = Math.floor(sorted.length / 2);
    if (sorted.length % 2 === 1) return sorted[middle];
    const lower = sorted[middle - 1];
    const upper = sorted[middle];
    return {
        ...(upper.score >= lower.score ? upper : lower),
        score: (lower.score + upper.score) / 2,
    };
}

function popcount(value) {
    let v = value - ((value >>> 1) & 0x55555555);
    v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
    return Math.imul((v + (v >>> 4)) & 0x0f0f0f0f, 0x01010101) >>> 24;
}

function lowMask(bits) {
    return bits >= WORD_BITS ? WORD_MASK : (1 << bits) - 1;
}

/** Misses among the newest `window` intervals of the pacing ring. */
function pacingMisses(state, window) {
    const intervals = Math.min(window, state.pacingCount);
    let misses = popcount(state.pacingLo & lowMask(Math.min(intervals, WORD_BITS)));
    if (intervals > WORD_BITS) misses += popcount(state.pacingHi & lowMask(intervals - WORD_BITS));
    return misses;
}

function pushInterval(state, miss) {
    const carry = (state.pacingLo >>> (WORD_BITS - 1)) & 1;
    state.pacingLo = ((state.pacingLo << 1) | (miss ? 1 : 0)) & WORD_MASK;
    state.pacingHi = ((state.pacingHi << 1) | carry) & WORD_MASK;
    state.pacingCount = Math.min(MAX_PACING_WINDOW, state.pacingCount + 1);
    state.windowIntervals += 1;
    if (miss) state.windowMisses += 1;
}

function clearPacingFields(state) {
    state.pacingLo = 0;
    state.pacingHi = 0;
    state.pacingCount = 0;
    state.windowIntervals = 0;
    state.windowMisses = 0;
}

function applyLatch(state, gaps, config) {
    const latched = latchDisplayPeriod(gaps);
    state.latchSamples = [];
    if (!latched) return;
    state.refreshHz = latched.refreshHz;
    state.periodMs = latched.periodMs;
    // M26: the timer veto budget is half the latched period.
    state.budgetMs = latched.periodMs * 0.5;
    clearPacingFields(state);
    // The warm-up gaps are pacing evidence at the warm-up level.
    for (const gap of gaps) {
        if (gap <= state.periodMs * STALE_GAP_PERIODS) pushInterval(state, gap > state.periodMs * config.missRatio);
    }
}

function recordInterval(state, interval, config) {
    if (interval === null || interval === undefined) return;
    const gap = Number(interval);
    if (!Number.isFinite(gap) || gap <= 0) return;
    if (state.periodMs === null) {
        if (gap < MIN_LATCH_GAP_MS || gap > MAX_LATCH_GAP_MS) return;
        const gaps = [...state.latchSamples, gap];
        if (gaps.length < config.latchSamples) state.latchSamples = gaps;
        else applyLatch(state, gaps, config);
        return;
    }
    if (gap > state.periodMs * STALE_GAP_PERIODS) return;
    pushInterval(state, gap > state.periodMs * config.missRatio);
}

function normalizePending(pending) {
    if (!pending || typeof pending !== 'object') return null;
    if (pending.kind !== 'probe' && pending.kind !== 'step') return null;
    const fromLevel = clampLevel(pending.fromLevel);
    if (fromLevel === null) return null;
    return {
        kind: pending.kind,
        fromLevel,
        baselineShare: share(pending.baselineShare, 0),
        atMs: finite(pending.atMs),
    };
}

function normalizeState(state = {}, options = {}) {
    const config = normalizeOptions({ ...(state.options || {}), ...options });
    const level = clampLevel(state.level) ?? 0;
    const periodMs = positiveOrNull(state.periodMs);
    return {
        level,
        override: clampLevel(state.override),
        pacedLevel: clampLevel(state.pacedLevel) ?? level,
        periodMs,
        refreshHz: periodMs === null ? null : positiveOrNull(state.refreshHz),
        budgetMs: positive(state.budgetMs, config.budgetMs),
        latchSamples: periodMs === null && Array.isArray(state.latchSamples)
            ? state.latchSamples.map(Number).filter(Number.isFinite).slice(-config.latchSamples)
            : [],
        pacingLo: (Math.floor(finite(state.pacingLo)) & WORD_MASK) >>> 0,
        pacingHi: (Math.floor(finite(state.pacingHi)) & WORD_MASK) >>> 0,
        pacingCount: Math.min(MAX_PACING_WINDOW, count(state.pacingCount)),
        windowIntervals: count(state.windowIntervals),
        windowMisses: count(state.windowMisses),
        missShare: share(state.missShare, 0),
        pending: normalizePending(state.pending),
        stepFailures: count(state.stepFailures),
        holdUntilMs: timeOrNull(state.holdUntilMs),
        probeFailures: count(state.probeFailures),
        nextProbeAtMs: timeOrNull(state.nextProbeAtMs),
        uploadGraceUntilMs: timeOrNull(state.uploadGraceUntilMs),
        scoreWindow: Array.isArray(state.scoreWindow)
            ? state.scoreWindow.map(normalizeSample).filter(Boolean).slice(-config.scoreWindowFrames)
            : [],
        lastSampleAtMs: timeOrNull(state.lastSampleAtMs),
        lastScore: Math.max(0, finite(state.lastScore)),
        lastDriver: typeof state.lastDriver === 'string' ? state.lastDriver : 'none',
        timerVeto: typeof state.timerVeto === 'string' ? state.timerVeto : 'waived',
        lastDecisionReason: typeof state.lastDecisionReason === 'string'
            ? state.lastDecisionReason
            : POST_FX_LADDER_REASONS.INITIAL,
        lastDegradationReason: typeof state.lastDegradationReason === 'string'
            ? state.lastDegradationReason
            : null,
        lastTransitionReason: typeof state.lastTransitionReason === 'string'
            ? state.lastTransitionReason
            : null,
        lastTransitionAtMs: timeOrNull(state.lastTransitionAtMs),
        lastTransitionMetrics: state.lastTransitionMetrics && typeof state.lastTransitionMetrics === 'object'
            ? { ...state.lastTransitionMetrics }
            : null,
        transitions: count(state.transitions),
        options: config,
    };
}

function transition(state, level, reason, now, median) {
    state.lastTransitionMetrics = {
        score: median.score,
        driver: median.driver,
        missShare: state.missShare,
        periodMs: state.periodMs,
        budgetMs: state.budgetMs,
        ...median.components,
    };
    state.level = level;
    state.lastDecisionReason = reason;
    state.lastTransitionReason = reason;
    state.lastTransitionAtMs = now;
    state.transitions += 1;
    // Decisions read only intervals rendered at the current level.
    clearPacingFields(state);
}

function backoff(baseMs, maxMs, failures) {
    return Math.min(maxMs, baseMs * 2 ** Math.max(0, failures - 1));
}

function evaluatePending(state, now, median, config, gpuConfirmed) {
    const pending = state.pending;
    const window = config.pacingWindow;
    if (pending.kind === 'probe') {
        const limit = Math.max(config.probeMissShare, pending.baselineShare + config.probeMissShare);
        // A revert is a demotion, so it takes the same veto: probe-window
        // misses with a healthy timer are main-thread hitches (boot decodes,
        // uploads), not the level the probe added, and must not park the
        // village a level down behind an exponential backoff.
        if (state.windowMisses >= limit * window && gpuConfirmed) {
            // The probe can no longer finish under its limit: revert now.
            state.pending = null;
            state.probeFailures += 1;
            state.nextProbeAtMs = now + backoff(config.probeBackoffMs, config.probeBackoffMaxMs, state.probeFailures);
            transition(state, pending.fromLevel, POST_FX_LADDER_REASONS.PROBE_REVERTED, now, median);
        } else if (state.windowIntervals >= window) {
            state.pending = null;
            state.probeFailures = 0;
            state.nextProbeAtMs = now;
            state.lastDecisionReason = POST_FX_LADDER_REASONS.PROBE_KEPT;
        } else {
            state.lastDecisionReason = POST_FX_LADDER_REASONS.PROBE;
        }
        return;
    }
    if (state.windowIntervals < window) {
        state.lastDecisionReason = POST_FX_LADDER_REASONS.STEP_EVALUATING;
        return;
    }
    const postShare = state.windowMisses / state.windowIntervals;
    state.pending = null;
    if (postShare <= pending.baselineShare * config.stepHelpedRatio) {
        state.stepFailures = 0;
        state.nextProbeAtMs = now + backoff(config.probeBackoffMs, config.probeBackoffMaxMs, state.probeFailures + 1);
        state.lastDecisionReason = POST_FX_LADDER_REASONS.STEP_KEPT;
        return;
    }
    // Shedding did not reduce the misses: they are not this ladder's to fix.
    state.stepFailures += 1;
    state.holdUntilMs = now + backoff(config.coolDownMs, config.coolDownMaxMs, state.stepFailures);
    transition(state, pending.fromLevel, POST_FX_LADDER_REASONS.STEP_REVERTED, now, median);
}

function finish(state) {
    state.pacedLevel = state.pending?.kind === 'probe' ? state.pending.fromLevel : state.level;
    return state;
}

/**
 * Advance the ladder by one frame. `metrics.intervalMs` is the display
 * interval that ended this frame (`null`: this render was outside the display
 * cadence and carries no pacing sample); without it `frameGapMs` stands in.
 * The veto reads the median timing score: `gpuMs` is the renderer's timer p25,
 * and without a timer (Safari, Firefox) the veto is waived, so pacing and the
 * shed-did-not-help guard decide alone. Returns a new state.
 */
export function advancePostFxLadder(state = {}, metrics = {}, nowMs = Date.now(), options = {}) {
    const next = normalizeState(state, options);
    const config = next.options;
    const now = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();

    const rawAssessment = assessPostFxTimings(metrics);
    next.uploadGraceUntilMs ??= now + config.uploadGraceMs;
    const uploadDriven = rawAssessment.driver === 'uploadMs' || rawAssessment.driver === 'auxUploadMs';
    const assessment = uploadDriven && now < next.uploadGraceUntilMs
        ? assessPostFxTimings({ ...metrics, uploadMs: 0, auxUploadMs: 0 })
        : rawAssessment;
    next.scoreWindow = [...next.scoreWindow, assessment].slice(-config.scoreWindowFrames);
    const median = medianAssessment(next.scoreWindow);
    next.lastSampleAtMs = now;
    next.lastScore = median.score;
    next.lastDriver = median.driver;
    const vetoWaived = !hasTimer(metrics);
    const timerOver = median.score > next.budgetMs;
    next.timerVeto = vetoWaived ? 'waived' : timerOver ? 'over-budget' : 'under-budget';

    recordInterval(next, metrics.intervalMs !== undefined ? metrics.intervalMs : metrics.frameGapMs, config);
    const window = config.pacingWindow;
    const intervals = Math.min(window, next.pacingCount);
    next.missShare = intervals ? pacingMisses(next, window) / intervals : 0;

    if (next.override !== null) {
        next.lastDecisionReason = POST_FX_LADDER_REASONS.OVERRIDE;
        return finish(next);
    }
    if (next.periodMs === null) {
        next.lastDecisionReason = POST_FX_LADDER_REASONS.LATCHING;
        return finish(next);
    }
    if (next.pending) {
        evaluatePending(next, now, median, config, vetoWaived || timerOver);
        return finish(next);
    }

    const windowFull = next.pacingCount >= window;
    if (windowFull && next.missShare >= config.demoteMissShare) {
        if (next.level >= config.maxLevel) {
            next.lastDecisionReason = POST_FX_LADDER_REASONS.MISSING_AT_FLOOR;
        } else if (!vetoWaived && !timerOver) {
            // Misses with a healthy timer are main-thread-bound; shedding GPU
            // work would not help.
            next.lastDecisionReason = POST_FX_LADDER_REASONS.MISSING_TIMER_UNDER_BUDGET;
        } else if (next.holdUntilMs !== null && now < next.holdUntilMs) {
            next.lastDecisionReason = POST_FX_LADDER_REASONS.MISSING_COOL_DOWN;
        } else {
            next.pending = { kind: 'step', fromLevel: next.level, baselineShare: next.missShare, atMs: now };
            next.lastDegradationReason = `missed-frames:${median.driver}`;
            transition(next, next.level + 1, POST_FX_LADDER_REASONS.DEMOTE, now, median);
        }
        return finish(next);
    }

    if (next.level > POST_FX_LEVELS.FULL) {
        if (next.nextProbeAtMs !== null && now < next.nextProbeAtMs) {
            next.lastDecisionReason = POST_FX_LADDER_REASONS.PROBE_BACKOFF;
        } else if (!windowFull) {
            next.lastDecisionReason = POST_FX_LADDER_REASONS.PACED;
        } else if (next.missShare >= config.probeMissShare && !vetoWaived && timerOver) {
            // Frames already miss and the timer says the GPU is the reason.
            next.lastDecisionReason = POST_FX_LADDER_REASONS.HOLD_GPU_OVER_BUDGET;
        } else {
            next.pending = { kind: 'probe', fromLevel: next.level, baselineShare: next.missShare, atMs: now };
            transition(next, next.level - 1, POST_FX_LADDER_REASONS.PROBE, now, median);
        }
        return finish(next);
    }

    next.lastDecisionReason = POST_FX_LADDER_REASONS.PACED;
    return finish(next);
}

export function createPostFxLadder(options = {}) {
    let state = normalizeState({}, options);

    return {
        update(metrics = {}, nowMs = Date.now()) {
            state = advancePostFxLadder(state, metrics, nowMs);
            return this.getState();
        },
        step(metrics = {}, nowMs = Date.now()) {
            return this.update(metrics, nowMs);
        },
        getLevel() {
            return state.override ?? state.level;
        },
        getState() {
            return { ...state, effectiveLevel: state.override ?? state.level };
        },
        setOverride(levelOrNull) {
            state = { ...state, override: clampLevel(levelOrNull) };
            return this.getLevel();
        },
        /** The timer veto budget. A latch replaces it with half the period. */
        setBudgetMs(budgetMs) {
            state = { ...state, budgetMs: positive(budgetMs, state.budgetMs) };
            return state.budgetMs;
        },
        /** Forget the latched period (screen or DPR change); the level holds while it re-latches. */
        relatch() {
            state = {
                ...state,
                periodMs: null,
                refreshHz: null,
                latchSamples: [],
                pending: null,
                lastDecisionReason: POST_FX_LADDER_REASONS.LATCHING,
            };
            clearPacingFields(state);
            return this.getState();
        },
        /** Drop the pacing window (the page was hidden); a pending probe or step restarts its window. */
        clearPacing() {
            state = { ...state };
            clearPacingFields(state);
            return this.getState();
        },
        /**
         * Return from a suspension (Dashboard) at the last paced level, keeping
         * the latched period and every backoff; the pacing window and the timer
         * scores restart.
         */
        resume() {
            state = {
                ...state,
                level: state.pacedLevel,
                pending: null,
                scoreWindow: [],
                uploadGraceUntilMs: null,
                lastDecisionReason: POST_FX_LADDER_REASONS.RESUME,
            };
            clearPacingFields(state);
            return this.getState();
        },
        reset(level = 0) {
            state = normalizeState({ level, override: null }, state.options);
            return this.getState();
        },
    };
}
