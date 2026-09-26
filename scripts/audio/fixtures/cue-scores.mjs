// Designed note scores for the discrimination metric (metrics/discrim.mjs),
// ported from the CUE notes (cue-snippets/discrim.mjs, discrim2.mjs): the
// evidence-round figures the shipped voices were built from. The probe's
// `discrim` check reads the shipped voices' published scores instead.
// [label, notes: [[ms, note], …]]; several notes at one ms are a chord whose
// first entry is the melody.

// The designed Wave-3 figures (evidence round 2): the three signal families,
// the routine alloys, scenery, outcomes and the music-box quote that round 2
// checked the needs-you figure against.
export const DESIGNED_SIGNAL_SCORES = Object.freeze([
    ['needs you (ship\'s bell E5)', [[0, 'E5'], [150, 'E5'], [650, 'E5'], [800, 'E5']]],
    ['error (cracked bell)', [[-25, 'E4'], [0, 'E4'], [400, 'A3']]],
    ['rate limit (ticks)', [[0, 'A5'], [260, 'A5'], [620, 'A5']]],
    ['answered', [[0, 'A4']]],
]);

export const DESIGNED_OTHER_SCORES = Object.freeze([
    ['arrival', [[0, 'E4'], [220, 'A4']]],
    ['departure', [[0, 'A4'], [240, 'E4']]],
    ['recovery', [[0, 'A3'], [200, 'E4']]],
    ['council-3', [[0, 'A3'], [280, 'E4'], [560, 'C#4']]],
    ['aurora', [[0, 'E5'], [90, 'A5'], [180, 'B5'], [270, 'C#6']]],
    ['aurora night', [[0, 'E5'], [90, 'A5'], [180, 'B5'], [270, 'C6']]],
    ['hour chime `home` day', [[0, 'E4'], [833, 'C#4'], [1250, 'B3'], [1667, 'A3']]],
    ['hour chime `home` night', [[0, 'E4'], [833, 'C4'], [1250, 'B3'], [1667, 'A3']]],
    ['hour chime strikes (A3 ×3)', [[0, 'A3'], [1400, 'A3'], [2800, 'A3']]],
    ['hour chime 9 o\'clock (great bell + 3)', [[0, 'E4'], [833, 'C#4'], [1250, 'B3'], [1667, 'A3'], [4200, 'A2'], [6000, 'A3'], [7400, 'A3'], [8800, 'A3']]],
    ['turn done (oak)', [[0, 'E4']]],
    ['sub-agent return (pebble)', [[0, 'B6'], [60, 'B6']]],
    ['failed (iron)', [[0, 'E4'], [110, 'A3']]],
    ['commit (gold)', [[0, 'A5']]],
    ['push (gold)', [[0, 'A5'], [140, 'E6']]],
    ['release (gold)', [[0, 'A3'], [120, 'A5'], [240, 'E6'], [360, 'A6'], [720, 'E4']]],
    ['music box Lanternlight bar 10', [[0, 'E6'], [1739, 'C6']]],
]);
