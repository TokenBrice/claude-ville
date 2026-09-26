// Bed-aware cue level (plan S2 "Trim rules per class", S3): one read of the
// pre-duck bed at schedule time sets a cue's trim so it lands inside its
// audibility window. Pure; importable from Node as well as the browser.
//
// A cue aims at its lane's floor + 1 LU over the bed it plays into:
//   trim = bedLufs + (floor + 1) − nominalLufsM, clamped per class.
// `nominalLufsM` is the voice's raw momentary-max loudness at trim 0
// (Loudness.js VOICE_REGISTRY); `bedLufs` is the engine's pre-duck bed tap
// in the same domain (before PROGRAM_TRIM, tilt and volume).

import { AUDIBILITY_WINDOWS } from './Loudness.js';

export const CUE_AIM_OVER_FLOOR_LU = 1;

// Urgent cues are never trimmed below 0 dB; with no bed to read (a hidden-tab
// wake, an unprimed tap) they take the median of the recent foreground urgent
// trims, else this lift.
export const URGENT_FALLBACK_TRIM_DB = 6;
export const URGENT_TRIM_MEMORY_MS = 60000;

const URGENT_LANES = new Set(['needsYou', 'error', 'limit']);

// Trim range per S2 lane, in dB. Minor outcomes, scenery and thunder are
// never lifted: a short knock or a far rumble must not jump out of a quiet bed.
const RANGE_URGENT = Object.freeze([0, 12]);
const RANGE_LIFTED = Object.freeze([-6, 12]);
const RANGE_UNLIFTED = Object.freeze([-6, 0]);
const TRIM_RANGE_BY_LANE = Object.freeze({
    needsYou: RANGE_URGENT,
    error: RANGE_URGENT,
    limit: RANGE_URGENT,
    routine: RANGE_LIFTED,
    outcomeMedium: RANGE_LIFTED,
    outcomeMajor: RANGE_LIFTED,
    outcomeMinor: RANGE_UNLIFTED,
    scenery: RANGE_UNLIFTED,
    thunder: RANGE_UNLIFTED,
});

// Thunder has no distance model yet (plan 4.2), so it aims at the far window:
// over its own storm it is never lifted, and a calm-day strike comes down.
const THUNDER_CONTEXT = 'far';

function clamp(value, [lo, hi]) {
    return Math.max(lo, Math.min(hi, value));
}

function median(values) {
    const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
    if (!sorted.length) return null;
    const mid = sorted.length >> 1;
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function isUrgentLevelLane(lane) {
    return URGENT_LANES.has(lane);
}

/** The S2 window floor (LU over the bed) a lane must clear in a bed context. */
export function laneFloorLu(lane, bed = 'village') {
    const windows = AUDIBILITY_WINDOWS.lanes[lane];
    if (!windows) return null;
    const context = lane === 'thunder' ? THUNDER_CONTEXT : bed;
    const floor = (windows[context] ?? windows.village)?.min;
    return Number.isFinite(floor) ? floor : null;
}

/**
 * The trim (dB) one cue takes at schedule time.
 * @param {object} args
 * @param {string} args.lane  S2 lane: needsYou | error | limit | routine |
 *   outcomeMinor | outcomeMedium | outcomeMajor | scenery | thunder
 * @param {number} args.nominalLufsM  the voice's raw nominal loudness
 * @param {number|null} args.bedLufs  pre-duck bed loudness, null when unknown
 * @param {number[]} [args.recentUrgentTrims]  foreground urgent trims of the
 *   last URGENT_TRIM_MEMORY_MS, used only when the bed is unknown
 * @param {'village'|'music'|'weather'} [args.bed]  which window the bed is
 */
export function cueTrimDb({
    lane,
    nominalLufsM,
    bedLufs,
    recentUrgentTrims = [],
    bed = 'village',
} = {}) {
    const range = TRIM_RANGE_BY_LANE[lane];
    if (!range) return 0;
    const urgent = isUrgentLevelLane(lane);
    if (!Number.isFinite(bedLufs)) {
        if (!urgent) return 0;
        const recent = median(Array.isArray(recentUrgentTrims) ? recentUrgentTrims : []);
        return clamp(recent ?? URGENT_FALLBACK_TRIM_DB, range);
    }
    const floor = laneFloorLu(lane, bed);
    if (!Number.isFinite(nominalLufsM) || floor == null) return clamp(0, range);
    return clamp(bedLufs + floor + CUE_AIM_OVER_FLOOR_LU - nominalLufsM, range);
}
