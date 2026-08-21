// The ladder intentionally knows nothing about WebGL. Keeping the timing policy
// here makes it deterministic in unit tests and prevents renderer state from
// leaking into the hysteresis decisions.

// Every active level uploads and presents the full-resolution source each
// frame; levels reduce only optional effect work.
export const POST_FX_LEVELS = Object.freeze({
    FULL: 0,
    REDUCED: 1,
    MINIMAL: 2,
    DISABLED: 3,
});

export const POST_FX_LADDER_REASONS = Object.freeze({
    INITIAL: 'initial',
    WITHIN_BUDGET: 'within-budget',
    HEALTHY_PROBE: 'healthy-probe',
    HEALTHY_RECOVERY: 'healthy-recovery',
    OVERRIDE: 'override',
});

const DEFAULT_OPTIONS = Object.freeze({
    budgetMs: 4,
    healthyMs: 2,
    overBudgetFrames: 60,
    probeMs: 5000,
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

function normalizeState(state = {}, options = {}) {
    const config = { ...DEFAULT_OPTIONS, ...options };
    return {
        level: clampLevel(state.level) ?? 0,
        override: clampLevel(state.override),
        overBudgetFrames: Math.max(0, Math.floor(finite(state.overBudgetFrames))),
        healthySinceMs: state.healthySinceMs !== null
            && state.healthySinceMs !== undefined
            && Number.isFinite(Number(state.healthySinceMs))
            ? Number(state.healthySinceMs)
            : null,
        lastScore: Math.max(0, finite(state.lastScore)),
        lastDriver: typeof state.lastDriver === 'string' ? state.lastDriver : 'none',
        lastDecisionReason: typeof state.lastDecisionReason === 'string'
            ? state.lastDecisionReason
            : POST_FX_LADDER_REASONS.INITIAL,
        lastDegradationReason: typeof state.lastDegradationReason === 'string'
            ? state.lastDegradationReason
            : null,
        lastTransitionAtMs: state.lastTransitionAtMs !== null
            && state.lastTransitionAtMs !== undefined
            && Number.isFinite(Number(state.lastTransitionAtMs))
            ? Number(state.lastTransitionAtMs)
            : null,
        lastTransitionMetrics: state.lastTransitionMetrics && typeof state.lastTransitionMetrics === 'object'
            ? { ...state.lastTransitionMetrics }
            : null,
        options: config,
    };
}

/**
 * Advance the ladder by one frame. The returned object is a new state, which
 * keeps callers free to retain snapshots for diagnostics or tests.
 */
export function advancePostFxLadder(state = {}, metrics = {}, nowMs = Date.now(), options = {}) {
    const current = normalizeState(state, options);
    const config = current.options;
    const now = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
    const assessment = assessPostFxTimings(metrics);
    const score = assessment.score;
    const driver = assessment.driver;

    // A QA override is deliberately sticky and does not poison the underlying
    // level's healthy/budget counters.
    if (current.override !== null) {
        return {
            ...current,
            lastScore: score,
            lastDriver: driver,
            lastDecisionReason: POST_FX_LADDER_REASONS.OVERRIDE,
        };
    }

    let level = current.level;
    let overBudgetFrames = current.overBudgetFrames;
    let healthySinceMs = current.healthySinceMs;
    let lastDecisionReason = current.lastDecisionReason;
    let lastDegradationReason = current.lastDegradationReason;
    let lastTransitionAtMs = current.lastTransitionAtMs;
    let lastTransitionMetrics = current.lastTransitionMetrics;

    if (score > config.budgetMs) {
        overBudgetFrames += 1;
        healthySinceMs = null;
        lastDecisionReason = `over-budget:${driver}`;
        if (overBudgetFrames >= config.overBudgetFrames && level < POST_FX_LEVELS.DISABLED) {
            level += 1;
            overBudgetFrames = 0;
            lastDegradationReason = `sustained-${driver}`;
            lastDecisionReason = `degrade:${lastDegradationReason}`;
            lastTransitionAtMs = now;
            lastTransitionMetrics = {
                score,
                driver,
                ...assessment.components,
            };
        } else if (level >= POST_FX_LEVELS.DISABLED) {
            lastDecisionReason = `disabled:${driver}`;
        }
    } else {
        overBudgetFrames = 0;
        if (score < config.healthyMs && level > POST_FX_LEVELS.FULL) {
            if (healthySinceMs === null) healthySinceMs = now;
            lastDecisionReason = POST_FX_LADDER_REASONS.HEALTHY_PROBE;
            if (now - healthySinceMs >= config.probeMs) {
                level -= 1;
                healthySinceMs = now;
                lastDecisionReason = POST_FX_LADDER_REASONS.HEALTHY_RECOVERY;
                lastTransitionAtMs = now;
                lastTransitionMetrics = {
                    score,
                    driver,
                    ...assessment.components,
                };
            }
        } else {
            healthySinceMs = null;
            lastDecisionReason = POST_FX_LADDER_REASONS.WITHIN_BUDGET;
        }
    }

    return {
        ...current,
        level,
        overBudgetFrames,
        healthySinceMs,
        lastScore: score,
        lastDriver: driver,
        lastDecisionReason,
        lastDegradationReason,
        lastTransitionAtMs,
        lastTransitionMetrics,
    };
}

export function createPostFxLadder(options = {}) {
    let state = normalizeState({}, options);

    return {
        update(metrics = {}, nowMs = Date.now()) {
            state = advancePostFxLadder(state, metrics, nowMs, state.options);
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
        reset(level = 0) {
            state = normalizeState({ level, override: null }, state.options);
            return this.getState();
        },
    };
}

// Named aliases make the pure transition convenient for small diagnostics and
// tests without forcing them to instantiate the stateful facade.
export const updatePostFxLadder = advancePostFxLadder;
export const stepPostFxLadder = advancePostFxLadder;
export const createLadder = createPostFxLadder;
