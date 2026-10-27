// FP-1a: the World never renders faster than 60 fps, on every backend.
// Motion is authored at 60 Hz (docs/motion-budget.md), so faster frames only
// repeat pixels: a 240 Hz panel rendered every rAF tick, four times the frames
// for the same picture.
//
// A tick renders once the time since the last rendered tick reaches the
// pacing interval, less a small tolerance so a 60 Hz display's slightly early
// ticks never drop. The difference from the interval carries to the next
// frame: lateness up to half an interval, so a 75-165 Hz panel averages
// 60 fps instead of falling to every second or third vsync; earliness only
// after skipped ticks (a panel faster than 60 Hz), so the tolerance never
// lifts the average above 60. Earliness straight after a rendered tick is a
// 60 Hz display's jitter, and is forgiven.

export const FRAME_PACING_FPS = 60;
export const FRAME_PACING_INTERVAL_MS = 1000 / FRAME_PACING_FPS;
export const FRAME_PACING_TOLERANCE_MS = 2;
const MAX_CARRY_MS = FRAME_PACING_INTERVAL_MS / 2;

export function createFramePacing() {
    return { lastRenderMs: null, lastTickMs: null, carryMs: 0, intervalMs: null };
}

/** Forget the cadence (the loop stopped): the next tick renders at once. */
export function resetFramePacing(pacing) {
    pacing.lastRenderMs = null;
    pacing.lastTickMs = null;
    pacing.carryMs = 0;
    pacing.intervalMs = null;
    return pacing;
}

/**
 * Admit or skip one rAF tick (`tickMs`, its timestamp). A skipped tick only
 * moves the tick clock; the loop re-arms rAF without updating anything. An
 * admitted tick sets `pacing.intervalMs` to its paced display interval: the
 * gap since the previous tick, rendered or skipped, never under the pacing
 * interval, so a frame the cap held is never read as a missed one. It is
 * null for the first tick after a reset (or a clock that ran backwards).
 */
export function admitFrame(pacing, tickMs) {
    const lastTick = pacing.lastTickMs;
    const lastRender = pacing.lastRenderMs;
    pacing.lastTickMs = tickMs;
    if (lastRender === null || !(tickMs >= lastRender)) {
        pacing.lastRenderMs = tickMs;
        pacing.carryMs = 0;
        pacing.intervalMs = null;
        return true;
    }
    const owedMs = tickMs - lastRender + pacing.carryMs;
    if (owedMs < FRAME_PACING_INTERVAL_MS - FRAME_PACING_TOLERANCE_MS) return false;
    const carryMs = owedMs - FRAME_PACING_INTERVAL_MS;
    pacing.carryMs = Math.min(MAX_CARRY_MS, lastTick > lastRender ? carryMs : Math.max(0, carryMs));
    pacing.lastRenderMs = tickMs;
    pacing.intervalMs = Math.max(FRAME_PACING_INTERVAL_MS, tickMs - lastTick);
    return true;
}
