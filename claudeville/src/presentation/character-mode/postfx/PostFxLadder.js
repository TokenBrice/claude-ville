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

function timingScore(metrics = {}) {
    if (Number.isFinite(Number(metrics.totalMs))
        && !Number.isFinite(Number(metrics.uploadMs))
        && !Number.isFinite(Number(metrics.cpuMs))) {
        return Math.max(0, Number(metrics.totalMs));
    }
    const upload = finite(metrics.uploadMs);
    const cpu = finite(metrics.cpuMs);
    const gpu = Number.isFinite(Number(metrics.gpuMs)) ? Number(metrics.gpuMs) : 0;
    let score = Math.max(0, upload + cpu + gpu);
    // Driver stalls (e.g. canvas-producer readbacks) can land outside the
    // instrumented windows: an oversized gap between consecutive renders is
    // the only visible symptom, so fold the excess above ~30 FPS pacing in.
    const frameGap = finite(metrics.frameGapMs);
    if (frameGap > 35) {
        score = Math.max(score, frameGap - 33);
    }
    return score;
}

function normalizeState(state = {}, options = {}) {
    const config = { ...DEFAULT_OPTIONS, ...options };
    return {
        level: clampLevel(state.level) ?? 0,
        override: clampLevel(state.override),
        overBudgetFrames: Math.max(0, Math.floor(finite(state.overBudgetFrames))),
        healthySinceMs: Number.isFinite(Number(state.healthySinceMs)) ? Number(state.healthySinceMs) : null,
        lastScore: Math.max(0, finite(state.lastScore)),
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
    const score = timingScore(metrics);

    // A QA override is deliberately sticky and does not poison the underlying
    // level's healthy/budget counters.
    if (current.override !== null) {
        return { ...current, lastScore: score };
    }

    let level = current.level;
    let overBudgetFrames = current.overBudgetFrames;
    let healthySinceMs = current.healthySinceMs;

    if (score > config.budgetMs) {
        overBudgetFrames += 1;
        healthySinceMs = null;
        if (overBudgetFrames >= config.overBudgetFrames && level < POST_FX_LEVELS.DISABLED) {
            level += 1;
            overBudgetFrames = 0;
        }
    } else {
        overBudgetFrames = 0;
        if (score < config.healthyMs && level > POST_FX_LEVELS.FULL) {
            if (healthySinceMs === null) healthySinceMs = now;
            if (now - healthySinceMs >= config.probeMs) {
                level -= 1;
                healthySinceMs = now;
            }
        } else {
            healthySinceMs = null;
        }
    }

    return {
        ...current,
        level,
        overBudgetFrames,
        healthySinceMs,
        lastScore: score,
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
