// Shared pitch vocabulary: note frequencies, the village key per phase, and
// the cue pitch roles (plan 3.5, S1).
//
// The village is in A — major while the sun is up, minor at night — and
// every tune in the songbook is written in it. Cues name their pitches in
// three ways:
//   * signal voices use fixed semitones (never chord-relative, never moved);
//   * routine cues use chord roles (`root`, `third`, `fifth`, `octave`,
//     `high`, `low`) resolved against the chord sounding at the note, in the
//     register the cue was written in, so with no music (the phase key's
//     tonic triad) every role is exactly the pitch it always was;
//   * motif-derived scenery uses key degrees (`degreeSemi`).
// While music plays, a fixed or degree pitch that would form a semitone or a
// tritone with the sounding chord moves to the nearest chord tone
// (`guardSemi`); a role pitch is a chord tone already.

const A4 = 440;

export function noteHz(semitonesFromA4) {
    return A4 * Math.pow(2, semitonesFromA4 / 12);
}

// The village key by phase: `{ tonicPc, mode }` (pitch classes, C = 0).
const PHASE_KEYS = Object.freeze({
    dawn: Object.freeze({ tonicPc: 9, mode: 'major' }),
    day: Object.freeze({ tonicPc: 9, mode: 'major' }),
    dusk: Object.freeze({ tonicPc: 9, mode: 'major' }),
    night: Object.freeze({ tonicPc: 9, mode: 'minor' }),
});

export function phaseKey(phase) {
    return PHASE_KEYS[phase] || PHASE_KEYS.day;
}

// The tonic triad of a key: `{ rootPc, pcs }`, root first.
export function tonicTriad({ tonicPc, mode } = PHASE_KEYS.day) {
    const third = mode === 'minor' ? 3 : 4;
    return { rootPc: tonicPc, pcs: [tonicPc, (tonicPc + third) % 12, (tonicPc + 7) % 12] };
}

const A_PC = 9;
const mod12 = n => ((n % 12) + 12) % 12;
const pcOfSemi = semi => mod12(A_PC + semi);

// Every cue role in the register it was written in over the A tonic (semitones
// from A4): A2, A3, the third (C♯4 / C4), E4, A4, the upper third (C♯5 / C5).
const ROLE_SEMIS = Object.freeze({
    low: -24,
    root: -12,
    third: -12, // + the chord's third
    fifth: -5,
    octave: 0,
    high: 0, // + the chord's third
});
export const CUE_ROLES = Object.freeze(Object.keys(ROLE_SEMIS));

function chordThird({ rootPc, pcs }) {
    return pcs.includes(mod12(rootPc + 3)) && !pcs.includes(mod12(rootPc + 4)) ? 3 : 4;
}

// How far the chord's root sits from A, as the nearest move (−5 … +6), so a
// role keeps the register it was written in.
function rootShift(rootPc) {
    const up = mod12(rootPc - A_PC);
    return up > 6 ? up - 12 : up;
}

/** A chord role's pitch (semitones from A4) over `chord` `{ rootPc, pcs }`. */
export function roleSemi(role, chord) {
    const base = ROLE_SEMIS[role];
    if (base == null) throw new RangeError(`Unknown cue role: ${role}`);
    const third = role === 'third' || role === 'high' ? chordThird(chord) : 0;
    return base + third + rootShift(chord.rootPc);
}

const SCALE_STEPS = Object.freeze({
    major: Object.freeze([0, 2, 4, 5, 7, 9, 11]),
    minor: Object.freeze([0, 2, 3, 5, 7, 8, 10]),
});

/**
 * A key degree's pitch (semitones from A4): `degree` 1–7 in `key`
 * `{ tonicPc, mode }`, `octave` 0 = the octave from the tonic nearest A4.
 */
export function degreeSemi(degree, key, octave = 0) {
    const steps = SCALE_STEPS[key?.mode === 'minor' ? 'minor' : 'major'];
    const d = Math.trunc(Number(degree)) - 1;
    const step = steps[((d % 7) + 7) % 7] + 12 * Math.floor(d / 7);
    return rootShift(key?.tonicPc ?? A_PC) + step + 12 * octave;
}

// A semitone (or major seventh) or a tritone against any chord tone.
const CLASH_INTERVALS = new Set([1, 6, 11]);

export function clashesWithChord(semi, chord) {
    const pc = pcOfSemi(semi);
    return chord.pcs.some(tone => CLASH_INTERVALS.has(mod12(pc - tone)));
}

/**
 * The clash guard: `semi` unchanged unless it forms a semitone or a tritone
 * with the chord, else the nearest chord tone (the lower one on a tie).
 */
export function guardSemi(semi, chord) {
    if (!clashesWithChord(semi, chord)) return semi;
    for (let step = 1; step <= 6; step++) {
        if (chord.pcs.includes(pcOfSemi(semi - step))) return semi - step;
        if (chord.pcs.includes(pcOfSemi(semi + step))) return semi + step;
    }
    return semi;
}
