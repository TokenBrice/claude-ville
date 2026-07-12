// Shared tonal vocabulary for every pitched element in the soundscape.
//
// All layers and cues draw notes from one pentatonic scale per time-of-day
// phase so nothing can clash harmonically: A major pentatonic while the sun
// is up, drifting to A minor pentatonic at night. Registers shift with the
// phase (airy at dawn, warm and low at dusk, dark and sparse at night).

const A4 = 440;

export function noteHz(semitonesFromA4) {
    return A4 * Math.pow(2, semitonesFromA4 / 12);
}

// `tones` are semitone offsets from A4 forming the melodic pool for the
// music layer. `bass` anchors the tonal bed. `brightness` 0..1 maps to
// filter cutoffs downstream.
const SCALES = {
    dawn: { tones: [0, 2, 4, 7, 9, 12, 14], bass: -24, brightness: 0.85 },
    day: { tones: [-12, -10, -8, -5, -3, 0, 2], bass: -24, brightness: 1 },
    dusk: { tones: [-12, -10, -8, -5, -3, 0], bass: -36, brightness: 0.62 },
    night: { tones: [-12, -9, -7, -5, -2, 0], bass: -36, brightness: 0.4 },
};

export function scaleForPhase(phase) {
    return SCALES[phase] || SCALES.day;
}

// Fixed interval set for one-shot cues, voiced from the same tonal center.
// Night borrows the minor third so cues agree with the night scale.
export function cueTones(phase) {
    const minor = phase === 'night';
    return {
        low: noteHz(-24), // A2
        root: noteHz(-12), // A3
        third: noteHz(minor ? -9 : -8), // C4 / C#4
        fifth: noteHz(-5), // E4
        octave: noteHz(0), // A4
        high: noteHz(minor ? 3 : 4), // C5 / C#5
    };
}
