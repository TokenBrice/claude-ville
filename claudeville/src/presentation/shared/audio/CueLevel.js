// Bed-aware cue level (plan S2 "Trim rules per class", S3): one read of the
// pre-duck bed at schedule time sets a cue's trim so it lands inside its
// audibility window. Pure; importable from Node as well as the browser.
//
// A cue aims a little over its lane's floor on the bed it plays into:
//   trim = bedLufs + (floor + aim) − nominalLufsM, clamped per class.
// `nominalLufsM` is the voice's raw momentary-max loudness at trim 0
// (Loudness.js VOICE_REGISTRY); `bedLufs` is the engine's pre-duck bed tap
// in the same domain (before PROGRAM_TRIM, tilt and volume).
//
// The aim over the floor depends on the class. Urgent cues aim 2 LU over:
// they must also clear the band rule over music (≥ +6 dB in 0.5–4 kHz), and
// their ceilings (+12 / +10) leave the room. Routine cues aim 2 LU over too
// (window +3…+6). A Minor outcome aims just under its floor (−0.2 LU): its
// short knock reads ≈ +0.7…+1 LU over the bed on its own stem, inside 0…+3,
// and ≥ 3 LU under a routine cue on the same measure (S2; Wave-4 probe,
// cue stem over the bed stems: routine +4.2…+4.3). Every other lane aims
// 1 LU over.
//
// An urgent trim is also capped by the limiter: the voice's predicted peak
// (nominal + trim + its registry PLR, raised by PROGRAM_TRIM_DB to the limiter
// input) stays within the urgent gain-reduction budget (S2 ceiling row:
// ≤ 3 dB), less a guard for the ducked bed that shares the limiter (measured
// on the probe's beds: the bed adds 1.5–1.7 dB of GR over the cue's own
// peak). A lift the limiter would take back is not a lift; the cap never
// takes an urgent cue below 0 dB.
//
// Urgent cues are not cut to reach their floor + aim. Over a very quiet bed
// (a still night), though, a call at 0 dB would pass its lane ceiling, so
// there, and only there, it comes down to 1 LU under the ceiling, never
// more than URGENT_MIN_TRIM_DB. With no bed to read (a hidden-tab wake, an
// unprimed tap) urgent trims stay ≥ 0 dB.

import { AUDIBILITY_WINDOWS, LIMITER_CEILING_DBFS, LOUDNESS_TARGETS, PROGRAM_TRIM_DB } from './Loudness.js';

export const CUE_AIM_OVER_FLOOR_LU = 1;
export const URGENT_AIM_OVER_FLOOR_LU = 2;
const AIM_OVER_FLOOR_BY_LANE = Object.freeze({
    needsYou: URGENT_AIM_OVER_FLOOR_LU,
    error: URGENT_AIM_OVER_FLOOR_LU,
    limit: URGENT_AIM_OVER_FLOOR_LU,
    routine: 2,
    outcomeMinor: -0.2,
});

// The highest peak (dBFS, in the bedLoudness domain) an urgent voice may
// reach: the limiter ceiling plus the urgent GR budget, less the bed's guard.
const URGENT_PEAK_GUARD_DB = 2;
export const URGENT_PEAK_MAX_DBFS = LIMITER_CEILING_DBFS
    + LOUDNESS_TARGETS.ceiling.urgentGrMaxDb - URGENT_PEAK_GUARD_DB - PROGRAM_TRIM_DB;

// Urgent cues are never trimmed below 0 dB; with no bed to read (a hidden-tab
// wake, an unprimed tap) they take the median of the recent foreground urgent
// trims, else this lift.
export const URGENT_FALLBACK_TRIM_DB = 6;
export const URGENT_MIN_TRIM_DB = -4;
const UNDER_CEILING_LU = 1;
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

/** The most an urgent voice of this nominal loudness and PLR may be lifted. */
export function urgentTrimCapDb(nominalLufsM, plr) {
    if (!Number.isFinite(nominalLufsM) || !Number.isFinite(plr)) return Infinity;
    return Math.max(0, URGENT_PEAK_MAX_DBFS - (nominalLufsM + plr));
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
 * @param {number|null} [args.plr]  the voice's peak-to-loudness ratio (dB),
 *   for the urgent limiter cap; no cap without it
 */
export function cueTrimDb({
    lane,
    nominalLufsM,
    bedLufs,
    recentUrgentTrims = [],
    bed = 'village',
    plr = null,
} = {}) {
    const range = TRIM_RANGE_BY_LANE[lane];
    if (!range) return 0;
    const urgent = isUrgentLevelLane(lane);
    const [lo, hi] = range;
    const capped = urgent ? [lo, Math.max(lo, Math.min(hi, urgentTrimCapDb(nominalLufsM, plr)))] : range;
    if (!Number.isFinite(bedLufs)) {
        if (!urgent) return 0;
        const recent = median(Array.isArray(recentUrgentTrims) ? recentUrgentTrims : []);
        return clamp(recent ?? URGENT_FALLBACK_TRIM_DB, capped);
    }
    const floor = laneFloorLu(lane, bed);
    if (!Number.isFinite(nominalLufsM) || floor == null) return clamp(0, capped);
    const aim = AIM_OVER_FLOOR_BY_LANE[lane] ?? CUE_AIM_OVER_FLOOR_LU;
    const trim = clamp(bedLufs + floor + aim - nominalLufsM, capped);
    const ceiling = AUDIBILITY_WINDOWS.lanes[lane]?.ceiling;
    if (!urgent || !Number.isFinite(ceiling)) return trim;
    const underCeiling = bedLufs + ceiling - UNDER_CEILING_LU - nominalLufsM;
    return underCeiling < 0 ? Math.max(URGENT_MIN_TRIM_DB, underCeiling) : trim;
}
