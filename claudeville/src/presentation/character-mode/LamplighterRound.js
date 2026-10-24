// D4 — the Lamplighter's Round. At dusk the street lamps no longer all light
// in one frame: the Pharos lights first, then each lamp catches once, in
// order of its distance from the lighthouse, inland to the far gate over
// ROUND_SPAN_MIN minutes. At dawn they go out in reverse, the far lamps
// first and the Pharos last. Each lamp changes state once per course; nothing
// pulses. Bodiless: no lamplighter figure.
//
// V3: a pure function of the clock (minute of day, season shift) and fixed
// geography (the lamp's tile). It never reads agents, weather or work, so a
// page loaded mid-dusk shows the same partial round as one that watched it.
// Reduced motion collapses the round: every lamp keeps the shared lamp
// clock (`lampsLitAt`), lit at its final state from the first minute.

import { BUILDING_DEFS } from '../../config/buildings.js';
import { lampCourseAt, lampSettlingWindows } from './GradeEvaluator.js';
import { seasonShiftFor } from './AtmosphereState.js';
import { seasonTokenForAtmosphere } from './SeasonalAmbience.js';

// Real minutes from the Pharos lighting to the farthest lamp catching.
export const ROUND_SPAN_MIN = 7;
// Tiles from the lighthouse at which the round reaches its last step; the
// island's far corner (the Portal gate, the Archive) sits past it.
export const ROUND_REACH_TILES = 30;

const lighthouse = BUILDING_DEFS.find(def => def.type === 'watchtower');
export const LIGHTHOUSE_TILE = Object.freeze({
    tileX: lighthouse.x + lighthouse.width / 2,
    tileY: lighthouse.y + lighthouse.height / 2,
});

/** The lamp's place in the round: 0 at the lighthouse, 1 at the far reach. */
export function roundFraction(tileX, tileY) {
    const d = Math.hypot(Number(tileX) - LIGHTHOUSE_TILE.tileX, Number(tileY) - LIGHTHOUSE_TILE.tileY);
    return Number.isFinite(d) ? Math.max(0, Math.min(1, d / ROUND_REACH_TILES)) : 1;
}

/**
 * Whether a lamp at round fraction `fraction` is lit at `minuteOfDay`. Lit
 * from `duskStart + fraction × span` to `dawnEnd − fraction × span`; every
 * lamp is lit through the lamplight and deep-night courses and dark by day.
 */
export function roundLampLit(minuteOfDay, fraction, shift = undefined) {
    const minute = Number(minuteOfDay);
    if (!Number.isFinite(minute)) return false;
    const course = lampCourseAt(minute, shift);
    if (course === 0) return false;
    if (course >= 2) return true;
    const windows = lampSettlingWindows(shift);
    const offset = Math.max(0, Math.min(1, Number(fraction) || 0)) * ROUND_SPAN_MIN;
    const day = ((minute % 1440) + 1440) % 1440;
    // Settling at dusk (evening) or at dawn (morning).
    if (day >= 720) return day >= windows.duskStart + offset;
    return day < windows.dawnEnd - offset;
}

/**
 * One frame's round: a predicate `(tileX, tileY) => lit`, resolved once for
 * the atmosphere snapshot. With `motionScale <= 0` every lamp follows the
 * shared lamp clock (no round). Without a clock, nothing is lit.
 */
export function lampRoundFor(atmosphere, { motionScale = 1 } = {}) {
    const minute = Number(atmosphere?.clock?.minuteOfDay);
    if (!Number.isFinite(minute)) return () => false;
    const shift = seasonShiftFor(seasonTokenForAtmosphere(atmosphere));
    const course = lampCourseAt(minute, shift);
    if (course === 0) return () => false;
    if (course >= 2 || !(Number(motionScale) > 0)) return () => true;
    return (tileX, tileY) => roundLampLit(minute, roundFraction(tileX, tileY), shift);
}
