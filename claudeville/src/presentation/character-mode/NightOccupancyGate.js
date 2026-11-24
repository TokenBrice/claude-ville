export const MIDNIGHT_OIL_RISE_MS = 400;
export const MIDNIGHT_OIL_FALL_MS = 1600;
// NE P3.1 (D-1, 2026-11-24) — dim night room tiers:
// - KEEPER_ROOM_GATE (0.40): room 0 of each work building at lampCourse >= 2
//   when empty (lights the glass only; aperture pools require gate > 0.5).
// - ROUTING_ROOM_GATE (0.6): working sessions assigned to a building but not
//   yet arrived take room slots after physical workers and lay aperture pools.
export const KEEPER_ROOM_GATE = 0.40;
export const ROUTING_ROOM_GATE = 0.6;
export const ROOM_APERTURE_GATE_MIN = 0.5;

function clamp01(value) {
    return Math.max(0, Math.min(1, Number(value) || 0));
}

// B3-02 — the window clock is the lamp clock. `lampCourse` is
// GradeEvaluator.lampCourseAt (0 daylight, 1 settling, 2 lamplight, 3 deep
// night): a worked room's glass lights at half strength when the street lamps
// light (settling, between golden and blue hour) and fully at lamplight, and
// at dawn it steps down with them, so a worked window is never dark beside a
// lit lamp. Time only: occupancy still decides whether a room lights (V8).
export function nightWindowGate(lampCourse = 0) {
    const course = Number(lampCourse) || 0;
    if (course >= 2) return 1;
    if (course >= 1) return 0.5;
    return 0;
}

export function buildingEmissiveGate(lampCourse, workingFactor) {
    const night = nightWindowGate(lampCourse);
    return 1 + (clamp01(workingFactor) - 1) * night;
}

export function advanceNightOccupancyGate(value, target, dt, motionScale = 1) {
    const from = clamp01(value);
    const to = clamp01(target);
    if (!(Number(motionScale) > 0) || from === to) return to;
    const duration = to > from ? MIDNIGHT_OIL_RISE_MS : MIDNIGHT_OIL_FALL_MS;
    const delta = Math.max(0, Number(dt) || 0) / duration;
    if (delta + Number.EPSILON >= Math.abs(to - from)) return to;
    return to > from
        ? Math.min(to, from + delta)
        : Math.max(to, from - delta);
}
