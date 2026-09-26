// The songbook: every tune the village plays, in one place, for both presets.
//
// The Town band pieces (`PIECES`) are original town themes in the Game Boy
// tradition. Style parameters derive from analysis of classic handheld town
// BGM the operator supplied as reference (tempo 80–96 for towns / ~126
// energetic, major keys by day and dark minor for night, near-constant energy
// with arpeggio motion filling the space between phrases). The melodies are
// original compositions — the voice layout is the homage: pulse lead, pulse
// counter/arpeggio, triangle bass, whisper of noise percussion. Each piece is
// through-composed: one event list, looped.
//
// The Village tunes (`VILLAGE_TUNES`) are shorter: a pair of 4-bar sections
// (A, B) over one chord per bar, which the Village arrangement performs as a
// form (pickup, A-A-B-A and kin, outro) between long rests.
//
// Every piece is in A — major by day, minor at night — the key the cues'
// fixed pitches come from. That keeps cues in key, not out of every clash: a
// cue can still rub against the chord that is sounding, which is why the
// sequencer publishes the chord timeline to the MusicClock.
//
// Notes are [semitonesFromA4, beats]; null pitch is a rest. Town band chords
// are one per bar; a two-element array splits the bar in half. `air` is the
// lead's send into the Island Air (the night bells ring longest).

// The one chord table: voicings in semitones from A4, root position, mid-low
// register.
export const CHORDS = {
    'A': [-12, -8, -5],
    'Bm': [-10, -7, -3],
    'D': [-19, -15, -12],
    'E': [-17, -13, -10],
    'F#m': [-15, -12, -8],
    'G': [-14, -10, -7],
    'Am': [-12, -9, -5],
    'C': [-21, -17, -14],
    'Em': [-17, -14, -10],
    'F': [-16, -12, -9],
};

const pitchClass = semi => (((9 + semi) % 12) + 12) % 12;

// A chord name as pitch classes (C = 0): `{ rootPc, pcs }`, root first.
export function chordPitchClasses(name) {
    const voicing = CHORDS[name];
    if (!voicing) return null;
    const pcs = voicing.map(pitchClass);
    return { rootPc: pcs[0], pcs };
}

export const PIECES = [
    // ── Willowbrook ── the gentle home-village theme (Pallet-style).
    // Lilting arpeggio openings answered stepwise, sustained inner voice,
    // walking half-note bass with chromatic pickup back into the loop.
    {
        name: 'willowbrook', family: 'day', bpm: 84,
        lead: 'pulse25', counter: 'written', perc: 'none', air: 0.22,
        chords: [
            'A', 'E', ['F#m', 'D'], ['A', 'E'], 'A', 'D', ['Bm', 'E'], 'A',
            'D', 'A', 'E', 'F#m', 'D', 'A', ['Bm', 'E'], 'A',
        ],
        melody: [
            [0, 1], [4, 1], [7, 1.5], [4, 0.5],
            [2, 1], [-1, 1], [2, 2],
            [4, 1], [2, 0.5], [0, 0.5], [-3, 1], [0, 1],
            [2, 2.5], [-1, 0.5], [-5, 1],
            [0, 1], [4, 1], [7, 1.5], [9, 0.5],
            [7, 1], [5, 0.5], [4, 0.5], [2, 1], [5, 1],
            [4, 1], [2, 1], [-1, 1], [2, 1],
            [0, 3], [null, 1],
            [5, 1], [9, 1], [7, 1.5], [5, 0.5],
            [4, 1], [7, 0.5], [4, 0.5], [0, 2],
            [2, 1], [4, 0.5], [2, 0.5], [-1, 1], [-5, 1],
            [-3, 1], [0, 1], [4, 2],
            [5, 1.5], [4, 0.5], [2, 1], [0, 1],
            [4, 1], [0, 1], [-3, 2],
            [-7, 1], [-3, 1], [2, 1], [-1, 1],
            [0, 4],
        ],
        counterNotes: [
            [-8, 2], [-5, 2], [-10, 2], [-13, 2],
            [-8, 2], [-7, 2], [-10, 2], [-13, 2],
            [-8, 2], [-5, 2], [-7, 2], [-3, 2],
            [-7, 2], [-13, 2], [-8, 4],
            [-3, 2], [-7, 2], [-8, 2], [-5, 2],
            [-13, 2], [-10, 2], [-12, 2], [-8, 2],
            [-7, 2], [-3, 2], [-8, 2], [-12, 2],
            [-10, 2], [-13, 2], [-8, 4],
        ],
        bass: [
            [-24, 2], [-17, 1], [-24, 1],
            [-29, 2], [-25, 1], [-22, 1],
            [-15, 2], [-19, 2],
            [-24, 2], [-29, 2],
            [-24, 2], [-17, 1], [-20, 1],
            [-19, 2], [-15, 1], [-12, 1],
            [-22, 2], [-29, 2],
            [-24, 3], [-25, 1],
            [-19, 2], [-15, 1], [-12, 1],
            [-24, 2], [-20, 1], [-17, 1],
            [-29, 2], [-17, 1], [-13, 1],
            [-15, 2], [-20, 1], [-15, 1],
            [-19, 2], [-15, 1], [-19, 1],
            [-24, 2], [-20, 1], [-24, 1],
            [-22, 2], [-29, 2],
            [-24, 2], [-17, 1], [-25, 1],
        ],
    },

    // ── Cobblemarket ── warm market-street theme (Azalea-style): constant
    // eighth-note arpeggios under a flowing melody with a mixolydian G-natural.
    {
        name: 'cobblemarket', family: 'day', bpm: 92,
        lead: 'pulse25', counter: 'arp8', perc: 'ticks', air: 0.18,
        chords: [
            'A', 'G', 'D', 'A', 'A', 'G', ['D', 'E'], 'A',
            'F#m', 'D', 'A', 'E', 'F#m', 'G', ['D', 'E'], 'A',
        ],
        melody: [
            [7, 1], [4, 0.5], [2, 0.5], [0, 1], [2, 1],
            [-2, 1.5], [0, 0.5], [2, 1], [-2, 1],
            [-3, 1], [0, 0.5], [2, 0.5], [5, 1], [4, 0.5], [2, 0.5],
            [0, 2.5], [null, 0.5], [0, 0.5], [2, 0.5],
            [4, 1], [7, 0.5], [4, 0.5], [2, 1], [0, 1],
            [2, 1], [-2, 1], [0, 2],
            [-3, 1], [-5, 0.5], [-3, 0.5], [-1, 1], [2, 1],
            [0, 3], [null, 1],
            [4, 1], [2, 1], [0, 1.5], [-3, 0.5],
            [-3, 1], [-7, 0.5], [-3, 0.5], [0, 2],
            [4, 1.5], [7, 0.5], [4, 1], [2, 1],
            [2, 1], [-1, 1], [2, 2],
            [9, 1], [7, 1], [4, 1.5], [2, 0.5],
            [2, 1], [0, 1], [-2, 2],
            [-3, 1], [0, 1], [2, 0.5], [4, 0.5], [-1, 1],
            [0, 4],
        ],
        bass: [
            [-24, 1], [-17, 1], [-24, 1], [-17, 1],
            [-26, 1], [-19, 1], [-26, 1], [-19, 1],
            [-19, 1], [-12, 1], [-15, 1], [-12, 1],
            [-24, 1], [-17, 1], [-24, 1], [-20, 1],
            [-24, 1], [-17, 1], [-24, 1], [-17, 1],
            [-26, 1], [-19, 1], [-26, 1], [-19, 1],
            [-19, 1], [-15, 1], [-17, 1], [-13, 1],
            [-24, 1], [-17, 1], [-24, 2],
            [-15, 1], [-20, 1], [-15, 1], [-20, 1],
            [-19, 1], [-12, 1], [-19, 1], [-12, 1],
            [-24, 1], [-17, 1], [-24, 1], [-17, 1],
            [-29, 1], [-22, 1], [-29, 1], [-25, 1],
            [-15, 1], [-20, 1], [-15, 1], [-20, 1],
            [-26, 1], [-19, 1], [-26, 1], [-19, 1],
            [-19, 1], [-15, 1], [-17, 1], [-13, 1],
            [-24, 1], [-17, 1], [-24, 2],
        ],
    },

    // ── Millwheel ── the brisk workday theme (Route-style energy, kept
    // village-gentle): eighth-note runs, octave-bouncing bass, soft hats.
    {
        name: 'millwheel', family: 'day', bpm: 126,
        lead: 'pulse25', counter: 'arp8', perc: 'hat8', air: 0.14,
        chords: [
            'A', 'A', 'D', 'E', 'A', 'F#m', ['D', 'E'], 'A',
            'F#m', 'D', 'A', 'E', 'F#m', 'D', 'E', 'A',
        ],
        melody: [
            [0, 0.5], [2, 0.5], [4, 0.5], [7, 0.5], [9, 1], [7, 1],
            [4, 0.5], [7, 0.5], [4, 0.5], [2, 0.5], [0, 1], [2, 1],
            [5, 0.5], [4, 0.5], [2, 0.5], [5, 0.5], [9, 1], [7, 1],
            [7, 0.5], [4, 0.5], [2, 0.5], [-1, 0.5], [2, 2],
            [0, 0.5], [2, 0.5], [4, 0.5], [7, 0.5], [12, 1], [9, 1],
            [9, 0.5], [7, 0.5], [4, 0.5], [7, 0.5], [4, 1], [0, 1],
            [5, 1], [2, 1], [-1, 1], [2, 1],
            [0, 2], [null, 0.5], [-5, 0.5], [-3, 0.5], [-1, 0.5],
            [4, 1], [4, 0.5], [2, 0.5], [4, 1], [7, 1],
            [5, 1], [5, 0.5], [4, 0.5], [5, 1], [9, 1],
            [12, 1.5], [11, 0.5], [9, 1], [7, 1],
            [7, 1], [4, 0.5], [2, 0.5], [-1, 2],
            [4, 0.5], [2, 0.5], [0, 0.5], [2, 0.5], [4, 1], [7, 1],
            [5, 0.5], [4, 0.5], [2, 0.5], [4, 0.5], [5, 1], [9, 1],
            [7, 1], [2, 1], [-1, 1], [2, 1],
            [0, 2], [0, 0.5], [4, 0.5], [7, 0.5], [9, 0.5],
        ],
        bass: [
            [-24, 1], [-24, 1], [-12, 1], [-24, 1],
            [-24, 1], [-24, 1], [-12, 1], [-24, 1],
            [-19, 1], [-19, 1], [-7, 1], [-19, 1],
            [-29, 1], [-29, 1], [-17, 1], [-29, 1],
            [-24, 1], [-24, 1], [-12, 1], [-24, 1],
            [-27, 1], [-27, 1], [-15, 1], [-27, 1],
            [-19, 1], [-19, 1], [-17, 1], [-17, 1],
            [-24, 1], [-24, 1], [-12, 1], [-24, 1],
            [-27, 1], [-27, 1], [-15, 1], [-27, 1],
            [-19, 1], [-19, 1], [-7, 1], [-19, 1],
            [-24, 1], [-24, 1], [-12, 1], [-24, 1],
            [-29, 1], [-29, 1], [-17, 1], [-29, 1],
            [-27, 1], [-27, 1], [-15, 1], [-27, 1],
            [-19, 1], [-19, 1], [-7, 1], [-19, 1],
            [-29, 1], [-29, 1], [-17, 1], [-29, 1],
            [-24, 1], [-24, 1], [-12, 1], [-24, 1],
        ],
    },

    // ── Starfall ── the night city theme (Anistar-style): dark, slow,
    // music-box bells over soft pad chords, heavy echo, no percussion.
    {
        name: 'starfall', family: 'night', bpm: 64,
        lead: 'bell', counter: 'pad', perc: 'none', air: 0.3,
        chords: [
            'Am', 'F', 'C', 'G', 'Am', 'F', 'Em', 'Am',
            'F', 'G', 'Am', 'Em', 'F', 'C', 'G', 'Am',
        ],
        melody: [
            [12, 1.5], [10, 0.5], [7, 2],
            [8, 1], [7, 1], [3, 2],
            [7, 1.5], [5, 0.5], [3, 1], [2, 1],
            [2, 1], [5, 0.5], [2, 0.5], [-2, 2],
            [0, 1], [3, 1], [7, 1.5], [5, 0.5],
            [3, 1], [0, 1], [8, 2],
            [7, 1.5], [3, 0.5], [2, 1], [-2, 1],
            [0, 3], [null, 1],
            [8, 2], [7, 1], [5, 1],
            [5, 1], [2, 1], [10, 1.5], [7, 0.5],
            [12, 1.5], [10, 0.5], [7, 1], [3, 1],
            [2, 2], [-2, 2],
            [3, 1], [5, 1], [8, 1.5], [7, 0.5],
            [7, 1], [3, 1], [2, 2],
            [5, 1], [2, 0.5], [0, 0.5], [-2, 2],
            [0, 4],
        ],
        bass: [
            [-24, 4], [-28, 4], [-21, 4], [-26, 4],
            [-24, 4], [-28, 4], [-29, 4], [-24, 4],
            [-28, 4], [-26, 4], [-24, 4], [-29, 4],
            [-28, 4], [-21, 4], [-26, 4], [-24, 4],
        ],
    },

    // ── Moonwell ── a shorter night interlude: the well square after dark.
    {
        name: 'moonwell', family: 'night', bpm: 70,
        lead: 'bell', counter: 'pad', perc: 'none', air: 0.3,
        chords: ['Am', 'C', 'F', 'G', 'Am', 'F', 'G', 'Am'],
        melody: [
            [7, 2], [8, 1], [7, 1],
            [5, 1.5], [3, 0.5], [2, 2],
            [0, 1], [3, 1], [8, 2],
            [10, 1.5], [7, 0.5], [5, 1], [2, 1],
            [3, 1], [7, 1], [12, 2],
            [8, 1.5], [5, 0.5], [3, 1], [0, 1],
            [2, 1], [5, 1], [-2, 1], [2, 1],
            [0, 4],
        ],
        bass: [
            [-24, 4], [-21, 4], [-28, 4], [-26, 4],
            [-24, 4], [-28, 4], [-26, 4], [-24, 4],
        ],
    },
];

// Which pieces play at which time of day. Dawn/dusk lean gentle; night is
// the dark music-box pair.
export const PLAYLISTS = {
    dawn: ['willowbrook', 'cobblemarket'],
    day: ['willowbrook', 'cobblemarket', 'millwheel'],
    dusk: ['willowbrook', 'cobblemarket'],
    night: ['starfall', 'moonwell'],
};

// ── The Village tunes ── each a pair of 4-bar sections with one chord per
// bar. Major tunes play by day, minor lullabies at night. `lead` is the
// first-pass timbre, `leadAlt` the timbre a repeated section may swap to.
export const VILLAGE_TUNES = [
    {
        name: 'hearthfire', mode: 'major', bpm: 88,
        lead: 'pulse25', leadAlt: 'flute',
        sections: {
            A: {
                chords: ['A', 'D', 'A', 'E'], accomp: 'arp8',
                melody: [
                    [-5, 1], [-3, 0.5], [0, 0.5], [2, 1], [4, 1],
                    [0, 1], [-3, 0.5], [-5, 0.5], [-3, 2],
                    [-5, 1], [-8, 0.5], [-5, 0.5], [0, 1], [2, 1],
                    [2, 1.5], [0, 0.5], [2, 2],
                ],
            },
            B: {
                chords: ['F#m', 'D', 'A', 'E'], accomp: 'block2',
                melody: [
                    [4, 1], [2, 0.5], [0, 0.5], [-3, 1], [0, 1],
                    [2, 1], [0, 0.5], [-3, 0.5], [-5, 2],
                    [-8, 1], [-5, 0.5], [-3, 0.5], [0, 1], [-3, 1],
                    [2, 2], [-5, 2],
                ],
            },
        },
    },
    {
        name: 'millbrook', mode: 'major', bpm: 72,
        lead: 'pulse25', leadAlt: 'flute',
        sections: {
            A: {
                chords: ['A', 'F#m', 'D', 'E'], accomp: 'arp8',
                melody: [
                    [0, 2], [4, 1], [2, 1],
                    [0, 1], [-3, 1], [-5, 2],
                    [-3, 1], [0, 0.5], [2, 0.5], [4, 1], [2, 1],
                    [2, 3], [null, 1],
                ],
            },
            B: {
                chords: ['D', 'A', 'F#m', 'E'], accomp: 'block2',
                melody: [
                    [9, 1], [7, 1], [4, 2],
                    [7, 1], [4, 0.5], [2, 0.5], [0, 2],
                    [4, 1], [0, 1], [-3, 2],
                    [-5, 1], [-3, 1], [2, 2],
                ],
            },
        },
    },
    {
        name: 'lanternway', mode: 'minor', bpm: 56,
        lead: 'flute', leadAlt: 'flute',
        sections: {
            A: {
                chords: ['Am', 'Am', 'C', 'Em'], accomp: 'block1',
                melody: [
                    [0, 2], [-2, 1], [-5, 1],
                    [-7, 1], [-5, 1], [-9, 2],
                    [-12, 1], [-9, 1], [-7, 1], [-5, 1],
                    [-5, 3], [null, 1],
                ],
            },
            B: {
                chords: ['F', 'G', 'Am', 'Am'], accomp: 'arpQ',
                melody: [
                    [3, 2], [0, 1], [-2, 1],
                    [-2, 1], [-5, 0.5], [-7, 0.5], [-2, 2],
                    [0, 1], [-2, 0.5], [-5, 0.5], [-7, 1], [-9, 1],
                    [-12, 4],
                ],
            },
        },
    },
    {
        name: 'starwake', mode: 'minor', bpm: 60,
        lead: 'flute', leadAlt: 'flute',
        sections: {
            A: {
                chords: ['Am', 'C', 'G', 'Am'], accomp: 'arpQ',
                melody: [
                    [-5, 1.5], [-2, 0.5], [0, 2],
                    [-2, 1], [-5, 1], [-9, 2],
                    [-7, 1], [-5, 0.5], [-2, 0.5], [-7, 2],
                    [-12, 3], [null, 1],
                ],
            },
            B: {
                chords: ['F', 'C', 'G', 'Am'], accomp: 'block1',
                melody: [
                    [3, 2], [0, 2],
                    [-2, 1.5], [-5, 0.5], [-2, 2],
                    [-7, 1], [-2, 1], [-5, 2],
                    [-12, 4],
                ],
            },
        },
    },
];

// The Village bass: root on beat 1, fifth on beat 3, from these roots.
export const VILLAGE_BASS_ROOT = {
    'A': -24, 'D': -19, 'E': -29, 'F#m': -27,
    'Am': -24, 'C': -21, 'Em': -29, 'F': -28, 'G': -26,
};

// The forms a Village tune is performed in (between a pickup and an outro).
export const VILLAGE_FORMS = [
    ['A', 'A', 'B', 'A'],
    ['A', 'B', 'A', 'A'],
    ['A', 'A', 'B', 'B'],
];

// Pentatonic pools for the phrase-end fill of a repeated section.
export const PENTATONIC = {
    major: [-12, -10, -8, -5, -3, 0, 2, 4, 7, 9],
    minor: [-12, -9, -7, -5, -2, 0, 3, 5, 7, 10],
};
