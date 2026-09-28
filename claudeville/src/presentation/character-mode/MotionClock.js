/**
 * C3 — one elapsed-millisecond clock for the whole village.
 *
 * Before this module, motion was counted in frames: camera follow applied a
 * fixed per-update lerp coefficient, the world water clock advanced by a
 * constant 0.03 per update despite `_loop` already computing a clamped dt, and
 * idle stride pauses were counted in update calls. All three ran at a
 * different real-world speed on a 120 Hz display than on a 60 Hz one.
 *
 * Every animated subsystem now derives its phase from elapsed milliseconds.
 * A virtual 60 Hz frame counter may be derived from the same clock so existing
 * frame-domain consumers keep their authored cadence, but no subsystem may
 * keep a second private clock.
 *
 * Pure: no DOM, no timers, no allocation beyond the caller's clock object.
 */

import { snapRefreshRateHz } from './postfx/PostFxLadder.js';

/** The reference frame duration the existing cadences were authored against. */
export const REF_DT_MS = 1000 / 60;

/**
 * A single very long frame (tab return, GC pause, breakpoint) must not
 * teleport the village. Callers already clamp dt; this is the backstop.
 */
export const MAX_DT_MS = 250;

/** Clamp a raw frame delta into a sane range. */
export function clampDt(dtMs, maxDtMs = MAX_DT_MS) {
    const dt = Number(dtMs);
    if (!Number.isFinite(dt) || dt <= 0) return 0;
    return Math.min(dt, maxDtMs);
}

/**
 * Convert a legacy per-frame lerp coefficient into its time constant.
 *
 * A per-frame `x += (target - x) * s` is exponential decay sampled at the
 * reference frame duration, so `tau = -refDt / ln(1 - s)`.
 */
export function smoothingToTau(perFrameSmoothing, refDtMs = REF_DT_MS) {
    const s = Number(perFrameSmoothing);
    if (!Number.isFinite(s) || s <= 0) return Infinity;
    if (s >= 1) return 0;
    return -refDtMs / Math.log(1 - s);
}

/**
 * The frame-rate-independent lerp factor equivalent to a legacy per-frame
 * coefficient. At `dtMs === refDtMs` this returns the original coefficient
 * exactly, so authored feel is preserved at 60 Hz while 30 Hz and 120 Hz
 * finally agree with it.
 */
export function dtAlpha(perFrameSmoothing, dtMs, refDtMs = REF_DT_MS) {
    const s = Number(perFrameSmoothing);
    if (!Number.isFinite(s) || s <= 0) return 0;
    if (s >= 1) return 1;
    const dt = clampDt(dtMs);
    if (dt === 0) return 0;
    const tau = smoothingToTau(s, refDtMs);
    if (!Number.isFinite(tau) || tau <= 0) return 1;
    return Math.min(1, 1 - Math.exp(-dt / tau));
}

/**
 * V7 — frame gaps the stride latch reads: about half a second at 60 Hz.
 * Gaps outside 2–100 ms (a stall, a paused tab) are not display intervals.
 */
const STRIDE_LATCH_SAMPLES = 31;
const STRIDE_LATCH_MIN_GAP_MS = 2;
const STRIDE_LATCH_MAX_GAP_MS = 100;

/** A fresh clock. `virtualFrame` is derived, never independently advanced. */
export function createMotionClock() {
    return {
        elapsedMs: 0,
        virtualFrame: 0,
        lastDtMs: 0,
        // V7 — the stride clock's display-period latch (`latchStrideDt`).
        periodMs: 0,
        strideDtMs: 0,
        strideGaps: new Float64Array(STRIDE_LATCH_SAMPLES),
        strideGapScratch: new Float64Array(STRIDE_LATCH_SAMPLES),
        strideGapCount: 0,
        strideGapCursor: 0,
        strideCarryMs: 0,
    };
}
/**
 * Advance a clock by one frame.
 *
 * Reduced motion (`motionScale <= 0`) freezes the clock in place: the village
 * holds a static tableau rather than running a second, slower animation.
 *
 * A fractional scale between 0 and 1 slows the clock proportionally, which
 * preserves the semantics of the per-frame accumulators this replaced (they
 * multiplied their step by `motionScale`). Returns the same object so callers
 * can chain without allocating. The same frame also latches the stride
 * clock's dt (`strideDtMs`, see `latchStrideDt`).
 */
export function advanceMotionClock(clock, dtMs, motionScale = 1) {
    if (!clock) return createMotionClock();
    const scale = Number(motionScale);
    if (!Number.isFinite(scale) || scale <= 0) {
        clock.lastDtMs = 0;
        clock.strideDtMs = 0;
        return clock;
    }
    const dt = clampDt(dtMs) * Math.min(1, scale);
    clock.lastDtMs = dt;
    clock.elapsedMs += dt;
    clock.virtualFrame = virtualFramesFor(clock.elapsedMs);
    clock.strideDtMs = latchStrideDt(clock, dtMs) * Math.min(1, scale);
    return clock;
}

/**
 * V7 — the stride clock's dt for this frame, latched to the display period.
 * Walkers travel a whole speed rung per 16.67 ms, so a raw dt carrying host
 * jitter (a callback 5 ms late, then 5 ms early) moved a body by uneven steps
 * and split steady walk-frame holds. The period is the median of the recent
 * frame gaps, snapped to a display refresh rate; each frame then counts a
 * whole number of periods: at least one (a presented frame always steps),
 * and a second only once the owed time reaches 1.75 periods, so callback
 * jitter never doubles a step while a real missed refresh still does. The
 * remainder carries into the next frame (within one period), so the pace
 * stays true over time. A clock without latch state returns the clamped dt.
 */
export function latchStrideDt(clock, dtMs) {
    const dt = clampDt(dtMs);
    const gaps = clock?.strideGaps;
    if (dt === 0 || !gaps) return dt;
    if (dt >= STRIDE_LATCH_MIN_GAP_MS && dt <= STRIDE_LATCH_MAX_GAP_MS) {
        gaps[clock.strideGapCursor] = dt;
        clock.strideGapCursor = (clock.strideGapCursor + 1) % gaps.length;
        clock.strideGapCount = Math.min(gaps.length, clock.strideGapCount + 1);
    }
    const count = clock.strideGapCount;
    if (count === 0) return dt;
    const scratch = clock.strideGapScratch;
    for (let index = 0; index < gaps.length; index++) {
        scratch[index] = index < count ? gaps[index] : Infinity;
    }
    scratch.sort();
    const period = 1000 / snapRefreshRateHz(1000 / scratch[(count - 1) >> 1]);
    clock.periodMs = period;
    const owed = dt + clock.strideCarryMs;
    const refreshes = Math.max(1, Math.floor(owed / period + 0.25));
    clock.strideCarryMs = Math.max(-period, Math.min(period, owed - refreshes * period));
    return refreshes * period;
}

/** Elapsed milliseconds expressed as 60 Hz frames. */
export function virtualFramesFor(elapsedMs) {
    const ms = Number(elapsedMs);
    if (!Number.isFinite(ms) || ms <= 0) return 0;
    return ms / REF_DT_MS;
}

/** 60 Hz frames expressed as milliseconds. */
export function msForVirtualFrames(frames) {
    const f = Number(frames);
    if (!Number.isFinite(f) || f <= 0) return 0;
    return f * REF_DT_MS;
}

/**
 * V7 — travel speed rungs, in world px per 16.67 ms. Each rung covers one
 * 4.5 px walk frame of stride in a whole number of 60 Hz refreshes (3, 4, 5,
 * 6, 8), so the distance-driven legs hold every frame for the same count at
 * 60 and at 120 Hz: 20, 15, 12, 10 and 7.5 frames/s. Ascending.
 */
export const SPEED_RUNGS = Object.freeze([0.5625, 0.75, 0.9, 1.125, 1.5]);

/** Index of the rung nearest `speed` by ratio (so ×1.2 and ÷1.2 weigh alike). */
export function speedRungIndex(speed) {
    const s = Number(speed);
    if (!Number.isFinite(s) || s <= SPEED_RUNGS[0]) return 0;
    const top = SPEED_RUNGS.length - 1;
    if (s >= SPEED_RUNGS[top]) return top;
    let index = 0;
    while (index < top && SPEED_RUNGS[index + 1] <= s) index += 1;
    // Between rungs `index` and `index + 1`: compare in log space.
    return s * s >= SPEED_RUNGS[index] * SPEED_RUNGS[index + 1] ? index + 1 : index;
}

/**
 * V7 / PT-1 — where a body stands this frame, in world texels. While it
 * moves and k = zoom × dpr is a whole number, it rides the backing-pixel grid
 * (every texel still lands as an exact k×k block), so a walker steps an even
 * 4–5 px per refresh at k = 3 instead of alternating 3 and 6, and never
 * stalls at 120 Hz. At rest, or at a fractional k, it sits on a whole world
 * texel (C3). Every per-agent layer reads this one value.
 */
export function snapBodyPx(v, moving, zoom, dpr) {
    if (moving) {
        const k = zoom * dpr;
        const whole = Math.round(k);
        if (whole >= 1 && Math.abs(k - whole) <= 1e-3) return Math.round(v * whole) / whole;
    }
    return Math.round(v);
}
