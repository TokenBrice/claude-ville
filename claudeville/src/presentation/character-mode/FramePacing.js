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

//
// FP-1b: an ambient-only frame renders at 30 fps. Every stepped ambient
// cadence is 12 Hz or slower (docs/motion-budget.md), so each of its steps
// still shows for at least two frames; what would visibly step at 30 fps
// holds the World at 60 (`ambientFrame` below). `AMBIENT_FRAME_PACING` is the
// one switch: false renders every frame at 60 fps, as FP-1a alone did.

export const FRAME_PACING_FPS = 60;
export const FRAME_PACING_INTERVAL_MS = 1000 / FRAME_PACING_FPS;
export const FRAME_PACING_TOLERANCE_MS = 2;
export const AMBIENT_FRAME_PACING = true;
export const AMBIENT_FRAME_PACING_FPS = 30;
export const AMBIENT_FRAME_PACING_INTERVAL_MS = 1000 / AMBIENT_FRAME_PACING_FPS;
// Pointer input holds 60 fps this long, so hover feedback, a click and the
// first drag frame are never paced.
export const AMBIENT_INPUT_HOLD_MS = 1000;

export function createFramePacing() {
    return { lastRenderMs: null, lastTickMs: null, carryMs: 0, intervalMs: null, ambient: false };
}

/**
 * FP-1b: whether a frame may wait for the ambient (30 fps) cadence. All of
 * these must hold: no body on screen walks above the stroll rung
 * (`fastWalker`), the camera holds (`cameraMoving`: a drag, glide, follow or
 * zoom ease; the idle breath is allowed), no comet or lightning strike is in
 * flight, no C4 moment is playing, and the last pointer input is at least
 * AMBIENT_INPUT_HOLD_MS old (`msSinceInput`; NaN or Infinity = none).
 */
export function ambientFrame({
    fastWalker = false,
    cameraMoving = false,
    cometInFlight = false,
    strikeActive = false,
    momentPlaying = false,
    msSinceInput = Infinity,
} = {}) {
    return AMBIENT_FRAME_PACING
        && !fastWalker
        && !cameraMoving
        && !cometInFlight
        && !strikeActive
        && !momentPlaying
        && !(msSinceInput < AMBIENT_INPUT_HOLD_MS);
}

/** Forget the cadence (the loop stopped): the next tick renders at once. */
export function resetFramePacing(pacing) {
    pacing.lastRenderMs = null;
    pacing.lastTickMs = null;
    pacing.carryMs = 0;
    pacing.intervalMs = null;
    pacing.ambient = false;
    return pacing;
}

/**
 * Admit or skip one rAF tick (`tickMs`, its timestamp). A skipped tick only
 * moves the tick clock; the loop re-arms rAF without updating anything. An
 * admitted tick sets `pacing.intervalMs` to its paced display interval: the
 * gap since the previous tick, rendered or skipped, never under the 60 fps
 * interval, so a frame the cap held is never read as a missed one. It is
 * null for the first tick after a reset (or a clock that ran backwards).
 * `ambient` (FP-1b, see `ambientFrame`) paces this tick at 30 fps instead;
 * `pacing.ambient` keeps the cadence the last tick was judged on.
 */
export function admitFrame(pacing, tickMs, ambient = false) {
    const lastTick = pacing.lastTickMs;
    const lastRender = pacing.lastRenderMs;
    pacing.lastTickMs = tickMs;
    pacing.ambient = Boolean(ambient && AMBIENT_FRAME_PACING);
    if (lastRender === null || !(tickMs >= lastRender)) {
        pacing.lastRenderMs = tickMs;
        pacing.carryMs = 0;
        pacing.intervalMs = null;
        return true;
    }
    const targetMs = pacing.ambient ? AMBIENT_FRAME_PACING_INTERVAL_MS : FRAME_PACING_INTERVAL_MS;
    // Lateness carried from the 30 fps cadence never exceeds the 60 fps one's.
    const owedMs = tickMs - lastRender + Math.min(pacing.carryMs, targetMs / 2);
    if (owedMs < targetMs - FRAME_PACING_TOLERANCE_MS) return false;
    const carryMs = owedMs - targetMs;
    pacing.carryMs = Math.min(targetMs / 2, lastTick > lastRender ? carryMs : Math.max(0, carryMs));
    pacing.lastRenderMs = tickMs;
    pacing.intervalMs = Math.max(FRAME_PACING_INTERVAL_MS, tickMs - lastTick);
    return true;
}
