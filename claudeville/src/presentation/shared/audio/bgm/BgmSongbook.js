// The songbook: every tune the village plays, in one place, for both presets
// and both voices (the sequencer plays it through `music/Voicings.js`).
//
// Every piece is sixteen bars (Moonwell eight) in A — major by day, minor at
// night — the key the cues' fixed pitches come from; the sequencer publishes
// the sounding chord to the MusicClock, so routine cues sing its chord tones
// (MusicalScale roles) instead of trusting the key.
//
// A piece is voicing-agnostic score data (MUS-17, MUSL-6):
//   chords        one per bar; a two-element array splits the bar in half
//   melody, counterNotes, bass, descantNotes
//                 [semitonesFromA4 | null, beats]; null is a rest. The counter
//                 is a guide-tone line under the tune; the descant (the full
//                 band's extra player) is a sixth above the tune's long notes
//   pickup        the first entry's upbeat, played once before bar 1
//   engine        the eighth-note player's figure: `arp8` (day), `arpQ`
//                 (night), `waltz` (3/4); the sequencer voices each chord by
//                 nearest inversion (MUS-12)
//   bands         score voices admitted per working band, rest → full
//                 (MUS-8, MUSL-3): each band adds a player
//   grammar, cells
//                 the piece as 2-bar slots (MUS-6); `cells[slot][0]` is the
//                 canonical cut of the piece (a repeated slot name repeats
//                 the same bars), the rest are authored variants of the
//                 melody over the same chords, bass and counter (MUS-14)
//   phraseEnds    per cadence bar (0-based, the tonic arrival): the
//                 deceptive chord and bass the waiting cadence plays while
//                 someone waits (MUS-9; the melody is a tone of that chord),
//                 and the home landing (melody and bass) — the village
//                 motif's home phrase (Motifs.js) — for the first closed
//                 cadence after a wait
//   interlude     the piece's second half at 40–50 % melodic density, with a
//                 sustained counter and bass (6.7)
//   tag           two bars that replace the last bar when a visit ends
//                 (MUS-11: plagal close, `ritard` stretches the beat)
//   colour        the season's cadence colour (MUS-16): replacement chords
//                 for the last two bars, or null where the tune forbids it
//   percussion    per workshop building, one weight per sixteenth step
//                 (beatsPerBar × 4); the Town band admits a stroke of the
//                 building's voice (`PERCUSSION_VOICE`) when a seeded draw
//                 falls under density × weight (6.9)
//   lead, air     the Chip voicing's melody timbre and the lead's air send
//
// No voice plays a quick same-pitch pair: that is the needs-you figure (S1).
// `scripts/audio/score-analyzer.mjs` checks every invariant this relies on.

// The one chord table: voicings in semitones from A4, root position, mid-low
// register.
export const CHORDS = Object.freeze({
    'A': [-12, -8, -5],
    'Bm': [-10, -7, -3],
    'C#m': [-20, -17, -13],
    'D': [-19, -15, -12],
    'Dm': [-19, -16, -12],
    'E': [-17, -13, -10],
    'F#m': [-15, -12, -8],
    'G': [-14, -10, -7],
    'Am': [-12, -9, -5],
    'C': [-21, -17, -14],
    'Em': [-17, -14, -10],
    'F': [-16, -12, -9],
    // Season colours (MUS-16): an added ninth for spring, a sixth for
    // winter (a major seventh would put every routine cue a semitone off).
    'Aadd9': [-12, -10, -8, -5],
    'A6': [-12, -8, -5, -3],
});

const pitchClass = semi => (((9 + semi) % 12) + 12) % 12;

// A chord name as pitch classes (C = 0): `{ rootPc, pcs }`, root first.
export function chordPitchClasses(name) {
    const voicing = CHORDS[name];
    if (!voicing) return null;
    const pcs = voicing.map(pitchClass);
    return { rootPc: pcs[0], pcs };
}

export const BAND_NAMES = Object.freeze(['rest', 'light', 'steady', 'full']);
// MUSL-3: a resting village is a duet; work brings in the counter and the
// workshop percussion, then the engine, then the descant. At night the
// percussion is a shimmer that only the full band admits.
const DAY_BANDS = Object.freeze([
    Object.freeze(['lead', 'bass']),
    Object.freeze(['lead', 'bass', 'counter', 'percussion']),
    Object.freeze(['lead', 'bass', 'counter', 'percussion', 'engine']),
    Object.freeze(['lead', 'bass', 'counter', 'percussion', 'engine', 'descant']),
]);
const NIGHT_BANDS = Object.freeze([
    Object.freeze(['lead', 'bass']),
    Object.freeze(['lead', 'bass', 'counter']),
    Object.freeze(['lead', 'bass', 'counter', 'engine']),
    Object.freeze(['lead', 'bass', 'counter', 'engine', 'descant', 'percussion']),
]);

// One Isle Band percussion voice per workshop building (6.9, SIG-16).
export const PERCUSSION_VOICE = Object.freeze({
    forge: 'rim',
    archive: 'brush',
    mine: 'lowTom',
    taskboard: 'rim',
    observatory: 'shaker',
    portal: 'shaker',
    command: 'lowTom',
    harbor: 'brush',
});
export const PERCUSSION_STEPS_PER_BEAT = 4;

// The waiting cadence (MUS-9): V → vi by day (F♯2 then B2 walking back to
// A), V → VI at night; only the chord and the bass change. The landing after
// a wait is the motif's home phrase, E C♯ B A (E C B A in minor), over the
// tonic with its third, then its fifth, in the bass (a root under the E or
// the A would move in parallel with the tune).
const DECEPTIVE = Object.freeze({
    day: Object.freeze({
        chord: 'F#m', bass: [[-27, 2], [-22, 2]],
        home: { melody: [[7, 1], [4, 0.5], [2, 0.5], [0, 2]], bass: [[-20, 2], [-17, 2]] },
    }),
    night: Object.freeze({
        chord: 'F', bass: [[-28, 4]],
        home: { melody: [[7, 1], [3, 0.5], [2, 0.5], [0, 2]], bass: [[-21, 2], [-17, 2]] },
    }),
    waltz: Object.freeze({
        chord: 'F', bass: [[-28, 3]],
        home: { melody: [[7, 1], [3, 0.5], [2, 0.5], [0, 1]], bass: [[-21, 1], [-17, 2]] },
    }),
});

// Piece exits (MUS-11): I–IV | I by day, i–iv | i at night, iv | i in 3/4.
const TAG = Object.freeze({
    day: { chords: [['A', 'D'], 'A'], melody: [[4, 2], [9, 1], [5, 1], [0, 4]], bass: [[-24, 2], [-19, 2], [-24, 4]], ritard: 1.15 },
    night: { chords: [['Am', 'Dm'], 'Am'], melody: [[3, 2], [8, 1], [5, 1], [0, 4]], bass: [[-24, 2], [-19, 2], [-24, 4]], ritard: 1.15 },
    waltz: { chords: ['Dm', 'Am'], melody: [[8, 2], [5, 1], [0, 3]], bass: [[-19, 3], [-24, 3]], ritard: 1.15 },
});

function deepFreeze(value) {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
        Object.freeze(value);
        for (const inner of Object.values(value)) deepFreeze(inner);
    }
    return value;
}

// The notes of `notes` in [from, to) beats; a note across either edge is an
// authoring error (a cell is whole bars).
function sliceBeats(notes, from, to, label) {
    const out = [];
    let at = 0;
    for (const note of notes) {
        const end = at + note[1];
        if (at >= from - 1e-9 && end <= to + 1e-9) out.push(note);
        else if (at < to - 1e-9 && end > from + 1e-9) throw new Error(`BgmSongbook: ${label} crosses a cell edge at beat ${at}`);
        at = end;
    }
    return out;
}

const SLOT_BARS = 2;

// A piece as written plus its cells: the canonical cut of every slot, then
// the authored variants (sharing the slot's chords, bass and counter).
function piece({ variations, ...def }) {
    const span = SLOT_BARS * def.beatsPerBar;
    const cells = {};
    def.grammar.forEach((slot, i) => {
        if (cells[slot]) return;
        const cut = key => sliceBeats(def[key], i * span, (i + 1) * span, `${def.name} ${key}`);
        const chords = def.chords.slice(i * SLOT_BARS, (i + 1) * SLOT_BARS);
        cells[slot] = [
            { kind: 'canonical', chords, melody: cut('melody'), bass: cut('bass'), counterNotes: cut('counterNotes') },
            ...(variations[slot] || []).map(variant => ({ ...variant, chords })),
        ];
    });
    return deepFreeze({ ...def, bands: def.family === 'night' ? NIGHT_BANDS : DAY_BANDS, cells });
}

export const PIECES = Object.freeze([
    // ── Willowbrook ── the gentle home-village theme (Pallet-style), and the
    // source of the village motif (D9): bar 1 is the call. Lilting arpeggio
    // openings answered stepwise, a guide-tone counter line, a walking bass
    // (re-voiced where it doubled the arpeggio in octaves).
    piece({
        name: 'willowbrook', family: 'day', bpm: 84, beatsPerBar: 4, lead: 'pulse25', air: 0.22, engine: 'arp8',
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
            [-24, 2], [-20, 1], [-17, 1], [-29, 2], [-25, 1], [-22, 1],
            [-15, 2], [-19, 2], [-24, 2], [-29, 2],
            [-24, 2], [-20, 1], [-17, 1], [-19, 2], [-15, 1], [-12, 1],
            [-22, 2], [-29, 2], [-24, 3], [-25, 1],
            [-19, 2], [-15, 1], [-12, 1], [-24, 2], [-20, 1], [-17, 1],
            [-29, 2], [-17, 1], [-13, 1], [-15, 2], [-12, 1], [-15, 1],
            [-19, 2], [-15, 1], [-19, 1], [-24, 2], [-20, 1], [-24, 1],
            [-22, 2], [-29, 2], [-24, 2], [-17, 1], [-25, 1],
        ],
        descantNotes: [
            [7, 1], [12, 1], [16, 1.5], [null, 0.5], [11, 1], [7, 1], [11, 2],
            [12, 1], [null, 1], [5, 1], [9, 1], [null, 3], [2, 1],
            [7, 1], [12, 1], [16, 1.5], [null, 0.5], [17, 1], [null, 2], [12, 1],
            [null, 1], [9, 1], [7, 1], [11, 1], [7, 3], [null, 1],
            [12, 1], [17, 1], [17, 1.5], [null, 0.5], [12, 1], [null, 1], [7, 2],
            [11, 1], [null, 1], [7, 1], [2, 1], [4, 1], [9, 1], [12, 2],
            [12, 1.5], [null, 0.5], [9, 1], [9, 1], [12, 1], [7, 1], [null, 2],
            [2, 1], [5, 1], [11, 1], [7, 1], [7, 4],
        ],
        grammar: ['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8'],
        variations: {
            s1: [
                { kind: 'passing', melody: [[0, 0.5], [2, 0.5], [4, 0.5], [5, 0.5], [7, 1.5], [4, 0.5], [2, 1], [-1, 1], [2, 2]] },
                { kind: 'dotted', melody: [[0, 1.5], [4, 0.5], [7, 1.5], [4, 0.5], [2, 1], [-1, 1], [2, 2]] },
            ],
            s2: [
                { kind: 'turn', melody: [[4, 1], [2, 0.5], [0, 0.5], [-3, 1], [0, 1], [2, 1.5], [4, 0.5], [2, 0.5], [-1, 0.5], [-5, 1]] },
                { kind: 'dotted', melody: [[4, 1], [2, 0.5], [0, 0.5], [-3, 1.5], [0, 0.5], [2, 2.5], [-1, 0.5], [-5, 1]] },
            ],
            s3: [
                { kind: 'dotted', melody: [[0, 1.5], [4, 0.5], [7, 1.5], [9, 0.5], [7, 1], [5, 0.5], [4, 0.5], [2, 1], [5, 1]] },
                { kind: 'passing', melody: [[0, 0.5], [2, 0.5], [4, 0.5], [5, 0.5], [7, 1.5], [9, 0.5], [7, 1], [5, 0.5], [4, 0.5], [2, 1], [5, 1]] },
            ],
            s4: [
                { kind: 'octave', melody: [[4, 1], [2, 1], [-1, 1], [2, 1], [12, 3], [null, 1]] },
                { kind: 'passing', melody: [[4, 1], [2, 0.5], [0, 0.5], [-1, 0.5], [0, 0.5], [2, 1], [0, 3], [null, 1]] },
            ],
            s5: [
                { kind: 'octave', melody: [[5, 1], [9, 1], [7, 1.5], [5, 0.5], [4, 1], [7, 0.5], [4, 0.5], [12, 2]] },
                { kind: 'passing', melody: [[5, 0.5], [7, 0.5], [9, 1], [7, 1.5], [5, 0.5], [4, 0.5], [5, 0.5], [7, 0.5], [4, 0.5], [0, 2]] },
            ],
            s6: [
                { kind: 'passing', melody: [[2, 1], [4, 0.5], [2, 0.5], [-1, 0.5], [-3, 0.5], [-5, 1], [-3, 0.5], [-1, 0.5], [0, 1], [4, 2]] },
            ],
            s7: [
                { kind: 'passing', melody: [[5, 1.5], [4, 0.5], [2, 1], [0, 0.5], [2, 0.5], [4, 0.5], [2, 0.5], [0, 1], [-3, 2]] },
                { kind: 'dotted', melody: [[5, 1.5], [4, 0.5], [2, 1.5], [0, 0.5], [4, 1], [0, 1], [-3, 2]] },
            ],
            s8: [
                { kind: 'dotted', melody: [[-7, 1.5], [-3, 0.5], [2, 1], [-1, 1], [0, 4]] },
                { kind: 'lower', melody: [[-7, 1], [-3, 1], [2, 1], [-1, 1], [0, 3.5], [-1, 0.5]] },
            ],
        },
        phraseEnds: [{ bar: 7, ...DECEPTIVE.day }, { bar: 15, ...DECEPTIVE.day }],
        interlude: {
            chords: [
                'D', 'A', 'E', 'F#m', 'D', 'A', ['Bm', 'E'], 'A',
            ],
            melody: [
                [5, 2], [7, 2], [4, 2], [0, 2],
                [2, 2], [-1, 2], [-3, 2], [4, 2],
                [5, 2], [2, 2], [4, 2], [-3, 2],
                [-7, 4], [0, 4],
            ],
            counterNotes: [
                [-7, 4], [-8, 4], [-10, 4], [-12, 4],
                [-12, 4], [-12, 4], [-15, 2], [-13, 2], [-12, 4],
            ],
            bass: [
                [-19, 4], [-24, 4], [-29, 4], [-24, 4],
                [-24, 4], [-24, 4], [-22, 2], [-29, 2], [-20, 4],
            ],
        },
        tag: TAG.day,
        colour: { add9: { chords: [['Bm', 'E'], 'Aadd9'] }, borrowedIv: null, sixth: { chords: [['Bm', 'E'], 'A6'] } },
        percussion: {
            forge: [0, 0, 0, 0, 0, 0, 0.5, 0, 0, 0, 0, 0, 0, 0, 0.5, 0],
            archive: [0.15, 0, 0, 0, 0.8, 0, 0.2, 0, 0.15, 0, 0, 0, 0.8, 0, 0.25, 0],
            mine: [0.8, 0, 0, 0, 0, 0, 0, 0, 0.4, 0, 0, 0, 0, 0, 0, 0],
            taskboard: [0, 0, 0.3, 0, 0, 0, 0, 0, 0, 0, 0.3, 0, 0, 0, 0, 0.2],
            observatory: [0.5, 0, 0.3, 0, 0.5, 0, 0.3, 0, 0.5, 0, 0.3, 0, 0.5, 0, 0.3, 0],
            portal: [0, 0, 0, 0.2, 0, 0, 0.4, 0, 0, 0, 0, 0.2, 0, 0, 0.4, 0],
            command: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.3, 0, 0, 0.3, 0],
            harbor: [0, 0, 0.25, 0, 0.5, 0, 0, 0, 0, 0, 0.25, 0, 0.5, 0, 0, 0.2],
        },
    }),

    // ── Cobblemarket ── warm market-street theme (Azalea-style): a flowing
    // melody with a mixolydian G-natural over constant eighth-note motion.
    piece({
        name: 'cobblemarket', family: 'day', bpm: 92, beatsPerBar: 4, lead: 'pulse25', air: 0.18, engine: 'arp8',
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
        counterNotes: [
            [-8, 4], [-10, 4],
            [-7, 4], [-8, 4],
            [-8, 4], [-10, 4],
            [-12, 2], [-10, 2], [-8, 4],
            [-8, 4], [null, 4],
            [-8, 4], [-10, 4],
            [-12, 4], [-10, 4],
            [-12, 2], [-13, 2], [-12, 4],
        ],
        bass: [
            [-24, 1], [-17, 1], [-24, 1], [-17, 1], [-26, 1], [-19, 1], [-26, 1], [-19, 1],
            [-19, 1], [-12, 1], [-15, 1], [-12, 1], [-24, 1], [-17, 1], [-24, 1], [-20, 1],
            [-24, 1], [-17, 1], [-24, 1], [-17, 1], [-26, 1], [-19, 1], [-26, 1], [-19, 1],
            [-19, 1], [-15, 1], [-17, 1], [-13, 1], [-24, 1], [-17, 1], [-24, 2],
            [-15, 1], [-20, 1], [-15, 1], [-20, 1], [-19, 1], [-12, 1], [-19, 1], [-12, 1],
            [-24, 1], [-17, 1], [-24, 1], [-17, 1], [-29, 1], [-22, 1], [-29, 1], [-25, 1],
            [-15, 1], [-20, 1], [-15, 1], [-20, 1], [-26, 1], [-19, 1], [-26, 1], [-19, 1],
            [-19, 1], [-15, 1], [-17, 1], [-22, 1], [-24, 1], [-17, 1], [-24, 2],
        ],
        descantNotes: [
            [16, 1], [null, 1], [7, 1], [12, 1], [5, 1.5], [null, 1.5], [5, 1],
            [5, 1], [null, 1], [12, 1], [null, 1], [7, 2.5], [null, 1.5],
            [12, 1], [null, 1], [12, 1], [null, 1], [10, 1], [null, 1], [10, 2],
            [5, 1], [null, 1], [7, 1], [null, 1], [7, 3], [null, 1],
            [12, 1], [9, 1], [9, 1.5], [null, 0.5], [5, 1], [null, 1], [9, 2],
            [12, 1.5], [null, 0.5], [12, 1], [12, 1], [11, 1], [7, 1], [11, 2],
            [16, 1], [16, 1], [12, 1.5], [null, 0.5], [10, 1], [10, 1], [5, 2],
            [5, 1], [null, 2], [7, 1], [7, 4],
        ],
        grammar: ['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8'],
        variations: {
            s1: [
                { kind: 'passing', melody: [[7, 0.5], [5, 0.5], [4, 0.5], [2, 0.5], [0, 1], [2, 0.5], [0, 0.5], [-2, 1.5], [0, 0.5], [2, 1], [-2, 1]] },
                { kind: 'dotted', melody: [[7, 1], [4, 0.5], [2, 0.5], [0, 1.5], [2, 0.5], [-2, 1.5], [0, 0.5], [2, 1], [-2, 1]] },
            ],
            s2: [
                { kind: 'turn', melody: [[-3, 1], [0, 0.5], [2, 0.5], [5, 1], [4, 0.5], [2, 0.5], [0, 1.5], [2, 0.5], [0, 0.5], [null, 0.5], [0, 0.5], [2, 0.5]] },
                { kind: 'passing', melody: [[-3, 0.5], [-1, 0.5], [0, 0.5], [2, 0.5], [5, 1], [4, 0.5], [2, 0.5], [0, 2.5], [null, 0.5], [0, 0.5], [2, 0.5]] },
            ],
            s3: [
                { kind: 'dotted', melody: [[4, 1], [7, 0.5], [4, 0.5], [2, 1.5], [0, 0.5], [2, 1], [-2, 1], [0, 2]] },
                { kind: 'passing', melody: [[4, 0.5], [5, 0.5], [7, 0.5], [4, 0.5], [2, 1], [0, 1], [2, 0.5], [0, 0.5], [-2, 1], [0, 2]] },
            ],
            s4: [
                { kind: 'octave', melody: [[-3, 1], [-5, 0.5], [-3, 0.5], [-1, 1], [2, 1], [12, 3], [null, 1]] },
                { kind: 'passing', melody: [[-3, 1], [-5, 0.5], [-3, 0.5], [-1, 0.5], [0, 0.5], [2, 1], [0, 3], [null, 1]] },
            ],
            s5: [
                { kind: 'octave', melody: [[4, 1], [2, 1], [0, 1.5], [-3, 0.5], [-3, 1], [-7, 0.5], [-3, 0.5], [12, 2]] },
                { kind: 'dotted', melody: [[4, 1.5], [2, 0.5], [0, 1.5], [-3, 0.5], [-3, 1], [-7, 0.5], [-3, 0.5], [0, 2]] },
            ],
            s6: [
                { kind: 'dotted', melody: [[4, 1.5], [7, 0.5], [4, 1.5], [2, 0.5], [2, 1], [-1, 1], [2, 2]] },
            ],
            s7: [
                { kind: 'passing', melody: [[9, 1], [7, 0.5], [5, 0.5], [4, 1.5], [2, 0.5], [2, 1], [0, 1], [-2, 2]] },
                { kind: 'dotted', melody: [[9, 1.5], [7, 0.5], [4, 1.5], [2, 0.5], [2, 1], [0, 1], [-2, 2]] },
            ],
            s8: [
                { kind: 'dotted', melody: [[-3, 1.5], [0, 0.5], [2, 0.5], [4, 0.5], [-1, 1], [0, 4]] },
                { kind: 'octave', melody: [[-3, 1], [0, 1], [2, 0.5], [4, 0.5], [-1, 1], [12, 4]] },
            ],
        },
        phraseEnds: [{ bar: 7, ...DECEPTIVE.day }, { bar: 15, ...DECEPTIVE.day }],
        interlude: {
            chords: [
                'F#m', 'D', 'A', 'E', 'F#m', 'G', ['D', 'E'], 'A',
            ],
            melody: [
                [4, 2], [0, 2], [-3, 2], [0, 2],
                [4, 2], [4, 2], [2, 2], [2, 2],
                [9, 2], [4, 2], [2, 2], [-2, 2],
                [-3, 2], [2, 2], [0, 4],
            ],
            counterNotes: [
                [-8, 4], [-7, 4], [-8, 4], [-10, 4],
                [-12, 4], [-10, 4], [-12, 2], [-13, 2], [-12, 4],
            ],
            bass: [
                [-27, 4], [-19, 4], [-24, 4], [-29, 4],
                [-24, 4], [-26, 4], [-19, 2], [-29, 2], [-20, 4],
            ],
        },
        tag: TAG.day,
        colour: { add9: { chords: [['D', 'E'], 'Aadd9'] }, borrowedIv: null, sixth: { chords: [['D', 'E'], 'A6'] } },
        percussion: {
            forge: [0, 0, 0.6, 0, 0, 0, 0.6, 0, 0, 0, 0.6, 0, 0, 0, 0.6, 0],
            archive: [0.2, 0, 0.1, 0, 0.9, 0, 0.1, 0, 0.2, 0, 0.1, 0, 0.9, 0, 0.3, 0],
            mine: [0.9, 0, 0, 0, 0, 0, 0, 0.2, 0.6, 0, 0, 0, 0, 0, 0, 0],
            taskboard: [0, 0, 0, 0.3, 0, 0, 0, 0, 0, 0, 0, 0.3, 0.5, 0, 0, 0],
            observatory: [0.6, 0.1, 0.4, 0.1, 0.6, 0.1, 0.4, 0.1, 0.6, 0.1, 0.4, 0.1, 0.6, 0.1, 0.4, 0.1],
            portal: [0, 0, 0.5, 0, 0, 0, 0.5, 0, 0, 0, 0.5, 0, 0, 0, 0.5, 0.3],
            command: [0, 0, 0, 0, 0, 0, 0, 0.3, 0, 0, 0, 0, 0, 0, 0.6, 0.3],
            harbor: [0, 0, 0.3, 0, 0.7, 0, 0.3, 0, 0, 0, 0.3, 0, 0.7, 0, 0.4, 0.2],
        },
    }),

    // ── Millwheel ── the brisk workday theme (Route-style energy, kept
    // village-gentle): eighth-note runs over an octave-bouncing bass.
    piece({
        name: 'millwheel', family: 'day', bpm: 126, beatsPerBar: 4, lead: 'pulse25', air: 0.14, engine: 'arp8',
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
        counterNotes: [
            [-8, 4], [-8, 4],
            [-3, 4], [-5, 4],
            [-5, 4], [-8, 4],
            [-7, 2], [-10, 2], [-8, 4],
            [-8, 4], [-3, 4],
            [-5, 4], [-5, 4],
            [-8, 4], [-3, 4],
            [-5, 4], [-5, 4],
        ],
        bass: [
            [-24, 1], [-24, 1], [-12, 1], [-24, 1], [-24, 1], [-24, 1], [-12, 1], [-24, 1],
            [-19, 1], [-19, 1], [-7, 1], [-19, 1], [-29, 1], [-29, 1], [-17, 1], [-29, 1],
            [-24, 1], [-24, 1], [-12, 1], [-24, 1], [-27, 1], [-27, 1], [-15, 1], [-27, 1],
            [-19, 1], [-19, 1], [-17, 1], [-17, 1], [-24, 1], [-24, 1], [-12, 1], [-24, 1],
            [-27, 1], [-27, 1], [-15, 1], [-27, 1], [-19, 1], [-19, 1], [-7, 1], [-19, 1],
            [-24, 1], [-24, 1], [-12, 1], [-24, 1], [-29, 1], [-29, 1], [-17, 1], [-29, 1],
            [-27, 1], [-27, 1], [-15, 1], [-27, 1], [-19, 1], [-19, 1], [-7, 1], [-19, 1],
            [-29, 1], [-29, 1], [-17, 1], [-29, 1], [-24, 1], [-24, 1], [-12, 1], [-24, 1],
        ],
        descantNotes: [
            [null, 2], [16, 1], [16, 1], [null, 2], [7, 1], [12, 1],
            [null, 2], [17, 1], [17, 1], [null, 2], [11, 2],
            [null, 2], [19, 1], [16, 1], [null, 2], [12, 1], [9, 1],
            [12, 1], [9, 1], [7, 1], [11, 1], [7, 2], [null, 2],
            [12, 1], [null, 1], [12, 1], [16, 1], [null, 2], [12, 1], [17, 1],
            [19, 1.5], [null, 0.5], [16, 1], [16, 1], [14, 1], [null, 1], [7, 2],
            [null, 2], [12, 1], [16, 1], [null, 2], [12, 1], [17, 1],
            [14, 1], [11, 1], [7, 1], [11, 1], [7, 2], [null, 2],
        ],
        grammar: ['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8'],
        variations: {
            s1: [
                { kind: 'passing', melody: [[0, 0.5], [2, 0.5], [4, 0.5], [7, 0.5], [9, 1], [7, 0.5], [5, 0.5], [4, 0.5], [7, 0.5], [4, 0.5], [2, 0.5], [0, 1], [2, 1]] },
                { kind: 'dotted', melody: [[0, 0.5], [2, 0.5], [4, 0.5], [7, 0.5], [9, 1.5], [7, 0.5], [4, 0.5], [7, 0.5], [4, 0.5], [2, 0.5], [0, 1], [2, 1]] },
            ],
            s2: [
                { kind: 'dotted', melody: [[5, 0.5], [4, 0.5], [2, 0.5], [5, 0.5], [9, 1], [7, 1], [7, 0.5], [4, 0.5], [2, 0.5], [-1, 0.5], [2, 1.5], [-1, 0.5]] },
            ],
            s3: [
                { kind: 'octave', melody: [[0, 0.5], [2, 0.5], [4, 0.5], [7, 0.5], [12, 1], [9, 1], [9, 0.5], [7, 0.5], [4, 0.5], [7, 0.5], [4, 1], [12, 1]] },
                { kind: 'passing', melody: [[0, 0.5], [2, 0.5], [4, 0.5], [7, 0.5], [12, 0.5], [11, 0.5], [9, 1], [9, 0.5], [7, 0.5], [4, 0.5], [7, 0.5], [4, 0.5], [2, 0.5], [0, 1]] },
            ],
            s4: [
                { kind: 'passing', melody: [[5, 0.5], [4, 0.5], [2, 0.5], [0, 0.5], [-1, 1], [2, 1], [0, 2], [null, 0.5], [-5, 0.5], [-3, 0.5], [-1, 0.5]] },
                { kind: 'dotted', melody: [[5, 1.5], [2, 0.5], [-1, 1], [2, 1], [0, 2], [null, 0.5], [-5, 0.5], [-3, 0.5], [-1, 0.5]] },
            ],
            s5: [
                { kind: 'passing', melody: [[4, 1], [4, 0.5], [2, 0.5], [4, 0.5], [5, 0.5], [7, 1], [5, 1], [5, 0.5], [4, 0.5], [5, 0.5], [7, 0.5], [9, 1]] },
                { kind: 'dotted', melody: [[4, 1], [4, 0.5], [2, 0.5], [4, 1.5], [7, 0.5], [5, 1], [5, 0.5], [4, 0.5], [5, 1], [9, 1]] },
            ],
            s6: [
                { kind: 'octave', melody: [[12, 1.5], [11, 0.5], [9, 1], [7, 1], [7, 1], [4, 0.5], [2, 0.5], [11, 2]] },
                { kind: 'passing', melody: [[12, 1.5], [11, 0.5], [9, 1], [7, 1], [7, 0.5], [5, 0.5], [4, 0.5], [2, 0.5], [-1, 2]] },
            ],
            s7: [
                { kind: 'passing', melody: [[4, 0.5], [2, 0.5], [0, 0.5], [2, 0.5], [4, 0.5], [5, 0.5], [7, 1], [5, 0.5], [4, 0.5], [2, 0.5], [4, 0.5], [5, 0.5], [7, 0.5], [9, 1]] },
                { kind: 'dotted', melody: [[4, 0.5], [2, 0.5], [0, 0.5], [2, 0.5], [4, 1.5], [7, 0.5], [5, 0.5], [4, 0.5], [2, 0.5], [4, 0.5], [5, 1], [9, 1]] },
            ],
            s8: [
                { kind: 'dotted', melody: [[7, 1.5], [2, 0.5], [-1, 1], [2, 1], [0, 2], [0, 0.5], [4, 0.5], [7, 0.5], [9, 0.5]] },
                { kind: 'lower', melody: [[7, 1], [2, 1], [-1, 1], [2, 1], [0, 1.5], [-1, 0.5], [0, 0.5], [4, 0.5], [7, 0.5], [9, 0.5]] },
            ],
        },
        phraseEnds: [{ bar: 7, ...DECEPTIVE.day }, { bar: 15, ...DECEPTIVE.day }],
        interlude: {
            chords: [
                'F#m', 'D', 'A', 'E', 'F#m', 'D', 'E', 'A',
            ],
            melody: [
                [4, 1], [4, 1], [4, 2], [5, 2], [5, 2],
                [12, 2], [9, 2], [7, 2], [-1, 2],
                [4, 2], [4, 2], [5, 2], [5, 2],
                [7, 2], [-1, 2], [0, 2], [0, 2],
            ],
            counterNotes: [
                [-8, 4], [-7, 4], [-8, 4], [-10, 4],
                [-12, 4], [-12, 4], [-13, 4], [-12, 4],
            ],
            bass: [
                [-27, 4], [-24, 4], [-20, 4], [-25, 4],
                [-27, 4], [-24, 4], [-25, 4], [-20, 4],
            ],
        },
        tag: TAG.day,
        colour: { add9: { chords: ['E', 'Aadd9'] }, borrowedIv: null, sixth: { chords: ['E', 'A6'] } },
        percussion: {
            forge: [0, 0, 0, 0, 0.7, 0, 0, 0, 0, 0, 0, 0, 0.7, 0, 0, 0],
            archive: [0, 0, 0.3, 0, 0, 0, 0.3, 0, 0, 0, 0.3, 0, 0, 0, 0.3, 0],
            mine: [0.9, 0, 0, 0, 0, 0, 0, 0, 0.7, 0, 0, 0, 0, 0, 0, 0],
            taskboard: [0, 0, 0, 0, 0, 0, 0, 0.3, 0, 0, 0, 0, 0, 0, 0, 0.3],
            observatory: [0.5, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0.5, 0],
            portal: [0, 0.2, 0, 0.2, 0, 0.2, 0, 0.2, 0, 0.2, 0, 0.2, 0, 0.2, 0, 0.2],
            command: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.5, 0.4],
            harbor: [0.3, 0, 0, 0, 0.6, 0, 0, 0, 0.3, 0, 0, 0, 0.6, 0, 0, 0],
        },
    }),

    // ── The Painted Isle ── the village's own theme (MUS-5, as notated).
    // Opens with the Isle call (5̣ 1 2 3), answers on a D-maj7 colour,
    // climbs the "stairs" sequence (IV iii ii V), peaks once at bar 13 and
    // sighs through the borrowed iv (Dm) before home.
    piece({
        name: 'paintedIsle', family: 'day', bpm: 88, beatsPerBar: 4, lead: 'pulse25', air: 0.18, engine: 'arp8',
        pickup: [[-5, 0.5]],
        chords: [
            'A', 'D', 'F#m', 'E', 'A', 'D', ['Bm', 'E'], 'A',
            'D', 'C#m', 'Bm', 'E', 'A', ['D', 'Dm'], ['A', 'E'], 'A',
        ],
        melody: [
            [0, 1], [2, 0.5], [4, 2], [7, 0.5],
            [9, 1], [7, 0.5], [5, 0.5], [4, 2],
            [4, 1], [2, 0.5], [0, 0.5], [-3, 1], [0, 1],
            [2, 3], [null, 0.5], [-5, 0.5],
            [0, 1], [2, 0.5], [4, 1], [7, 1.5],
            [9, 1.5], [7, 0.5], [5, 1], [9, 1],
            [7, 1], [5, 1], [2, 1], [-1, 1],
            [0, 3], [4, 0.5], [7, 0.5],
            [9, 1.5], [12, 0.5], [9, 1], [5, 1],
            [7, 1.5], [11, 0.5], [7, 1], [4, 1],
            [5, 1.5], [9, 0.5], [5, 1], [2, 1],
            [4, 1], [2, 1], [-1, 1.5], [-5, 0.5],
            [0, 1], [2, 0.5], [4, 0.5], [12, 2],
            [9, 1], [7, 1], [5, 1.5], [2, 0.5],
            [4, 1], [0, 1], [2, 1], [-1, 1],
            [0, 3], [null, 0.5], [-5, 0.5],
        ],
        counterNotes: [
            [-12, 2], [-5, 2], [-3, 2], [-7, 2],
            [-8, 2], [-12, 2], [-13, 2], [-10, 2],
            [-8, 2], [-5, 2], [-3, 2], [-7, 2],
            [-7, 2], [-13, 2], [-12, 2], [-8, 2],
            [-12, 4], [-13, 4],
            [-15, 4], [-13, 2], [-10, 2],
            [-8, 2], [-5, 2], [-3, 2], [-4, 2],
            [-5, 4], [-8, 4],
        ],
        bass: [
            [-24, 2], [-17, 2], [-31, 2], [-24, 2],
            [-27, 2], [-20, 2], [-29, 2], [-22, 1], [-25, 1],
            [-24, 2], [-17, 1], [-20, 1], [-19, 3], [-20, 1],
            [-22, 2], [-29, 2], [-24, 2], [-22, 1], [-20, 1],
            [-19, 2], [-24, 2], [-20, 2], [-25, 2],
            [-22, 2], [-27, 2], [-29, 2], [-25, 1], [-22, 1],
            [-24, 2], [-20, 2], [-19, 4],
            [-24, 2], [-29, 2], [-24, 2], [-17, 1], [-25, 1],
        ],
        descantNotes: [
            [7, 1], [null, 3], [17, 1], [null, 3],
            [12, 1], [null, 1], [4, 1], [9, 1], [11, 3], [null, 1],
            [7, 1], [null, 3], [17, 1.5], [null, 0.5], [12, 1], [17, 1],
            [14, 1], [14, 1], [11, 1], [7, 1], [7, 3], [null, 1],
            [17, 1.5], [null, 0.5], [17, 1], [12, 1], [16, 1.5], [null, 0.5], [16, 1], [11, 1],
            [14, 1.5], [null, 0.5], [14, 1], [9, 1], [11, 1], [11, 1], [7, 1.5], [null, 0.5],
            [7, 1], [null, 1], [19, 2], [17, 1], [17, 1], [12, 1.5], [null, 1.5], [7, 1], [11, 1], [7, 1], [7, 3], [null, 1],
        ],
        grammar: ['call', 'answerOpen', 'call2', 'answerClosed', 'stairs', 'turn', 'summit', 'cadence'],
        variations: {
            call: [
                { kind: 'turn', melody: [[0, 1], [2, 0.5], [4, 1], [5, 0.5], [4, 0.5], [7, 0.5], [9, 1], [7, 0.5], [5, 0.5], [4, 2]] },
                { kind: 'lower', melody: [[0, 1], [2, 0.5], [4, 2], [7, 0.5], [9, 1], [7, 0.5], [5, 0.5], [4, 1.5], [2, 0.5]] },
            ],
            answerOpen: [
                { kind: 'dotted', melody: [[4, 1], [2, 0.5], [0, 0.5], [-3, 1.5], [0, 0.5], [2, 3], [null, 0.5], [-5, 0.5]] },
                { kind: 'passing', melody: [[4, 1], [2, 0.5], [0, 0.5], [-3, 0.5], [-1, 0.5], [0, 1], [2, 3], [null, 0.5], [-5, 0.5]] },
            ],
            call2: [
                { kind: 'dotted', melody: [[0, 1], [2, 0.5], [4, 1], [7, 1.5], [9, 1.5], [7, 0.5], [5, 1.5], [9, 0.5]] },
                { kind: 'anticipate', melody: [[0, 1], [2, 0.5], [4, 1], [7, 1], [9, 2], [7, 0.5], [5, 1], [9, 1]] },
            ],
            answerClosed: [
                { kind: 'anticipate', melody: [[7, 1], [5, 1], [2, 1], [-1, 1], [0, 2.5], [4, 1], [7, 0.5]] },
                { kind: 'passing', melody: [[7, 1], [5, 0.5], [4, 0.5], [2, 0.5], [0, 0.5], [-1, 1], [0, 3], [4, 0.5], [7, 0.5]] },
            ],
            stairs: [
                { kind: 'dotted', melody: [[9, 1.5], [12, 0.5], [9, 1.5], [5, 0.5], [7, 1.5], [11, 0.5], [7, 1], [4, 1]] },
            ],
            turn: [
                { kind: 'dotted', melody: [[5, 1.5], [9, 0.5], [5, 1.5], [2, 0.5], [4, 1], [2, 1], [-1, 1.5], [-5, 0.5]] },
            ],
            summit: [
                { kind: 'dotted', melody: [[0, 1], [2, 0.5], [4, 0.5], [12, 2], [9, 1.5], [7, 0.5], [5, 1.5], [2, 0.5]] },
                { kind: 'anticipate', melody: [[0, 1], [2, 0.5], [4, 0.5], [12, 1.5], [9, 1.5], [7, 1], [5, 1.5], [2, 0.5]] },
            ],
            cadence: [
                { kind: 'dotted', melody: [[4, 1.5], [0, 0.5], [2, 1], [-1, 1], [0, 3], [null, 0.5], [-5, 0.5]] },
                { kind: 'passing', melody: [[4, 0.5], [2, 0.5], [0, 1], [2, 0.5], [0, 0.5], [-1, 1], [0, 3], [null, 0.5], [-5, 0.5]] },
            ],
        },
        phraseEnds: [{ bar: 7, ...DECEPTIVE.day }, { bar: 15, ...DECEPTIVE.day }],
        interlude: {
            chords: [
                'D', 'C#m', 'Bm', 'E', 'A', ['D', 'Dm'], ['A', 'E'], 'A',
            ],
            melody: [
                [9, 2], [9, 2], [7, 2], [7, 2],
                [5, 2], [5, 2], [4, 2], [-1, 2],
                [0, 2], [12, 2], [9, 2], [5, 2],
                [4, 2], [2, 2], [0, 4],
            ],
            counterNotes: [
                [-7, 4], [-5, 4], [-7, 4], [-10, 4],
                [-8, 4], [-7, 2], [-4, 2], [-5, 2], [-5, 2], [-5, 4],
            ],
            bass: [
                [-19, 4], [-20, 4], [-22, 4], [-29, 4],
                [-20, 4], [-19, 2], [-24, 2], [-24, 2], [-29, 2], [-20, 4],
            ],
        },
        tag: TAG.day,
        colour: { add9: { chords: [['A', 'E'], 'Aadd9'] }, borrowedIv: null, sixth: { chords: [['A', 'E'], 'A6'] } },
        percussion: {
            forge: [0, 0, 0.6, 0, 0, 0, 0.6, 0, 0, 0, 0.6, 0, 0, 0, 0.6, 0],
            archive: [0.2, 0, 0.1, 0, 0.9, 0, 0.1, 0, 0.2, 0, 0.1, 0, 0.9, 0, 0.3, 0],
            mine: [0.9, 0, 0, 0, 0, 0, 0, 0, 0.5, 0, 0.3, 0, 0, 0, 0, 0],
            taskboard: [0, 0, 0, 0.3, 0, 0, 0, 0, 0, 0, 0, 0.3, 0.5, 0, 0, 0],
            observatory: [0.6, 0.1, 0.4, 0.1, 0.6, 0.1, 0.4, 0.1, 0.6, 0.1, 0.4, 0.1, 0.6, 0.1, 0.4, 0.1],
            portal: [0, 0, 0.5, 0, 0, 0, 0.5, 0, 0, 0, 0.5, 0, 0, 0, 0.5, 0.3],
            command: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.6, 0.3],
            harbor: [0, 0, 0.3, 0, 0.7, 0, 0.3, 0, 0, 0, 0.3, 0, 0.7, 0, 0.4, 0.2],
        },
    }),

    // ── Hearthfire ── the hearth-side Village tune, now a 16-bar piece: A A
    // B and a closing A whose last two bars cadence home (E → A) instead
    // of ending on the dominant. A rising pentatonic hook over a root–fifth
    // bass.
    piece({
        name: 'hearthfire', family: 'day', bpm: 88, beatsPerBar: 4, lead: 'pulse25', air: 0.2, engine: 'arp8',
        chords: [
            'A', 'D', 'A', 'E', 'A', 'D', 'A', 'E',
            'F#m', 'D', 'A', 'E', 'A', 'D', 'E', 'A',
        ],
        melody: [
            [-5, 1], [-3, 0.5], [0, 0.5], [2, 1], [4, 1],
            [0, 1], [-3, 0.5], [-5, 0.5], [-3, 2],
            [-5, 1], [-8, 0.5], [-5, 0.5], [0, 1], [2, 1],
            [2, 1.5], [0, 0.5], [2, 2],
            [-5, 1], [-3, 0.5], [0, 0.5], [2, 1], [4, 1],
            [0, 1], [-3, 0.5], [-5, 0.5], [-3, 2],
            [-5, 1], [-8, 0.5], [-5, 0.5], [0, 1], [2, 1],
            [2, 1.5], [0, 0.5], [2, 2],
            [4, 1], [2, 0.5], [0, 0.5], [-3, 1], [0, 1],
            [2, 1], [0, 0.5], [-3, 0.5], [-5, 2],
            [-8, 1], [-5, 0.5], [-3, 0.5], [0, 1], [-3, 1],
            [2, 2], [-5, 2],
            [-5, 1], [-3, 0.5], [0, 0.5], [2, 1], [4, 1],
            [0, 1], [-3, 0.5], [-5, 0.5], [-3, 2],
            [2, 1.5], [0, 0.5], [-1, 2],
            [4, 1], [2, 1], [0, 2],
        ],
        counterNotes: [
            [-8, 4], [-12, 4],
            [-12, 4], [-13, 4],
            [-8, 4], [-12, 4],
            [-12, 4], [-13, 4],
            [-12, 4], [-12, 4],
            [-12, 4], [-13, 4],
            [-8, 4], [-12, 4],
            [-13, 4], [-12, 4],
        ],
        bass: [
            [-24, 2], [-20, 2], [-19, 2], [-24, 2],
            [-24, 2], [-29, 2], [-29, 2], [-22, 2],
            [-24, 2], [-20, 2], [-19, 2], [-24, 2],
            [-24, 2], [-29, 2], [-29, 2], [-22, 2],
            [-27, 2], [-20, 2], [-19, 2], [-24, 2],
            [-24, 2], [-29, 2], [-29, 2], [-22, 2],
            [-24, 2], [-20, 2], [-19, 2], [-24, 2],
            [-29, 2], [-22, 2], [-24, 4],
        ],
        descantNotes: [
            [4, 1], [null, 1], [12, 1], [12, 1], [9, 1], [null, 1], [5, 2],
            [4, 1], [null, 1], [7, 1], [12, 1], [11, 1.5], [null, 0.5], [11, 2],
            [4, 1], [null, 1], [12, 1], [12, 1], [9, 1], [null, 1], [5, 2],
            [4, 1], [null, 1], [7, 1], [12, 1], [11, 1.5], [null, 0.5], [11, 2],
            [12, 1], [null, 1], [4, 1], [9, 1], [9, 1], [null, 1], [5, 2],
            [0, 1], [null, 2], [4, 1], [11, 2], [2, 2],
            [4, 1], [null, 1], [12, 1], [12, 1], [9, 1], [null, 1], [5, 2],
            [11, 1.5], [null, 0.5], [7, 2], [12, 1], [12, 1], [7, 2],
        ],
        grammar: ['a1', 'a2', 'a1', 'a2', 'b1', 'b2', 'a1', 'close'],
        variations: {
            a1: [
                { kind: 'passing', melody: [[-5, 1], [-3, 0.5], [0, 0.5], [2, 1], [4, 0.5], [2, 0.5], [0, 0.5], [-1, 0.5], [-3, 0.5], [-5, 0.5], [-3, 2]] },
                { kind: 'dotted', melody: [[-5, 1], [-3, 0.5], [0, 0.5], [2, 1.5], [4, 0.5], [0, 1], [-3, 0.5], [-5, 0.5], [-3, 2]] },
            ],
            a2: [
                { kind: 'dotted', melody: [[-5, 1], [-8, 0.5], [-5, 0.5], [0, 1.5], [2, 0.5], [2, 1.5], [0, 0.5], [2, 2]] },
                { kind: 'passing', melody: [[-5, 0.5], [-7, 0.5], [-8, 0.5], [-5, 0.5], [0, 1], [2, 1], [2, 1.5], [0, 0.5], [2, 2]] },
            ],
            b1: [
                { kind: 'passing', melody: [[4, 1], [2, 0.5], [0, 0.5], [-3, 0.5], [-1, 0.5], [0, 1], [2, 1], [0, 0.5], [-3, 0.5], [-5, 2]] },
                { kind: 'turn', melody: [[4, 1], [2, 0.5], [0, 0.5], [-3, 1], [0, 1], [2, 1], [0, 0.5], [-3, 0.5], [-5, 1], [-3, 0.5], [-5, 0.5]] },
            ],
            b2: [
                { kind: 'octave', melody: [[-8, 1], [-5, 0.5], [-3, 0.5], [0, 1], [-3, 1], [2, 2], [7, 2]] },
                { kind: 'passing', melody: [[-8, 0.5], [-7, 0.5], [-5, 0.5], [-3, 0.5], [0, 0.5], [-1, 0.5], [-3, 1], [2, 2], [-5, 2]] },
            ],
            close: [
                { kind: 'dotted', melody: [[2, 1.5], [0, 0.5], [-1, 2], [4, 1.5], [2, 0.5], [0, 2]] },
                { kind: 'anticipate', melody: [[2, 1.5], [0, 0.5], [-1, 1.5], [4, 1.5], [2, 1], [0, 2]] },
            ],
        },
        phraseEnds: [{ bar: 15, ...DECEPTIVE.day }],
        interlude: {
            chords: [
                'F#m', 'D', 'A', 'E', 'A', 'D', 'E', 'A',
            ],
            melody: [
                [4, 2], [-3, 2], [2, 2], [-5, 2],
                [-8, 2], [0, 2], [2, 2], [-5, 2],
                [-5, 2], [2, 2], [0, 2], [-3, 2],
                [2, 2], [-1, 2], [4, 2], [0, 2],
            ],
            counterNotes: [
                [-8, 4], [-12, 4], [-12, 4], [-13, 4],
                [-12, 4], [-12, 4], [-13, 4], [-12, 4],
            ],
            bass: [
                [-27, 4], [-19, 4], [-24, 4], [-29, 4],
                [-20, 4], [-19, 4], [-25, 4], [-24, 4],
            ],
        },
        tag: TAG.day,
        colour: { add9: { chords: ['E', 'Aadd9'] }, borrowedIv: null, sixth: { chords: ['E', 'A6'] } },
        percussion: {
            forge: [0, 0, 0, 0, 0, 0, 0.5, 0, 0, 0, 0, 0, 0, 0, 0.5, 0],
            archive: [0.15, 0, 0, 0, 0.8, 0, 0.2, 0, 0.15, 0, 0, 0, 0.8, 0, 0.25, 0],
            mine: [0.8, 0, 0, 0, 0, 0, 0, 0, 0.4, 0, 0, 0, 0, 0, 0, 0],
            taskboard: [0, 0, 0.3, 0, 0, 0, 0, 0, 0, 0, 0.3, 0, 0, 0, 0, 0.2],
            observatory: [0.5, 0, 0.3, 0, 0.5, 0, 0.3, 0, 0.5, 0, 0.3, 0, 0.5, 0, 0.3, 0],
            portal: [0, 0, 0.3, 0, 0, 0, 0.3, 0, 0, 0, 0.3, 0, 0, 0, 0.3, 0],
            command: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.3, 0, 0, 0.3, 0],
            harbor: [0, 0, 0.25, 0, 0.5, 0, 0, 0, 0, 0, 0.25, 0, 0.5, 0, 0, 0.2],
        },
    }),

    // ── Millbrook ── the slow A–C♯–B Village theme, now a 16-bar piece:
    // A A B and a closing A that lands home. B peaks on F♯5 over D (a warm
    // sixth). The dawn occasion plays it.
    piece({
        name: 'millbrook', family: 'day', bpm: 72, beatsPerBar: 4, lead: 'pulse25', air: 0.22, engine: 'arp8',
        chords: [
            'A', 'F#m', 'D', 'E', 'A', 'F#m', 'D', 'E',
            'D', 'A', 'F#m', 'E', 'A', 'F#m', ['D', 'E'], 'A',
        ],
        melody: [
            [0, 2], [4, 1], [2, 1],
            [0, 1], [-3, 1], [-5, 2],
            [-3, 1], [0, 0.5], [2, 0.5], [4, 1], [2, 1],
            [2, 3], [null, 1],
            [0, 2], [4, 1], [2, 1],
            [0, 1], [-3, 1], [-5, 2],
            [-3, 1], [0, 0.5], [2, 0.5], [4, 1], [2, 1],
            [2, 3], [null, 1],
            [9, 1], [7, 1], [4, 2],
            [7, 1], [4, 0.5], [2, 0.5], [0, 2],
            [4, 1], [0, 1], [-3, 2],
            [-5, 1], [-3, 1], [2, 2],
            [0, 2], [4, 1], [2, 1],
            [0, 1], [-3, 1], [-5, 2],
            [-3, 1], [0, 0.5], [2, 0.5], [4, 1], [2, 1],
            [0, 4],
        ],
        counterNotes: [
            [-8, 4], [-8, 4],
            [-7, 4], [-10, 4],
            [-8, 4], [-8, 4],
            [-7, 4], [-10, 4],
            [-12, 4], [-12, 4],
            [-12, 4], [-13, 4],
            [-8, 4], [-8, 4],
            [-7, 2], [-10, 2], [-8, 4],
        ],
        bass: [
            [-24, 2], [-29, 2], [-27, 2], [-20, 2],
            [-19, 2], [-24, 2], [-29, 2], [-25, 2],
            [-24, 2], [-29, 2], [-27, 2], [-20, 2],
            [-19, 2], [-24, 2], [-29, 2], [-25, 2],
            [-19, 2], [-24, 2], [-24, 2], [-29, 2],
            [-27, 2], [-20, 2], [-29, 2], [-25, 2],
            [-24, 2], [-29, 2], [-27, 2], [-20, 2],
            [-19, 2], [-29, 2], [-24, 4],
        ],
        descantNotes: [
            [7, 2], [12, 1], [12, 1], [9, 1], [4, 1], [null, 2],
            [5, 1], [null, 2], [9, 1], [11, 3], [null, 1],
            [7, 2], [12, 1], [12, 1], [9, 1], [4, 1], [null, 2],
            [5, 1], [null, 2], [9, 1], [11, 3], [null, 2], [17, 1], [12, 2], [16, 1], [null, 1], [7, 2],
            [12, 1], [9, 1], [4, 2], [2, 1], [7, 1], [11, 2],
            [7, 2], [12, 1], [12, 1], [9, 1], [4, 1], [null, 2],
            [5, 1], [null, 1], [11, 1], [11, 1], [7, 4],
        ],
        grammar: ['a1', 'a2', 'a1', 'a2', 'b1', 'b2', 'a1', 'close'],
        variations: {
            a1: [
                { kind: 'passing', melody: [[0, 1.5], [2, 0.5], [4, 1], [2, 1], [0, 0.5], [-1, 0.5], [-3, 1], [-5, 2]] },
                { kind: 'dotted', melody: [[0, 2], [4, 1.5], [2, 0.5], [0, 1], [-3, 1], [-5, 2]] },
            ],
            a2: [
                { kind: 'dotted', melody: [[-3, 1], [0, 0.5], [2, 0.5], [4, 1.5], [2, 0.5], [2, 3], [null, 1]] },
                { kind: 'passing', melody: [[-3, 0.5], [-1, 0.5], [0, 0.5], [2, 0.5], [4, 1], [2, 1], [2, 3], [null, 1]] },
            ],
            b1: [
                { kind: 'anticipate', melody: [[9, 1], [7, 1], [4, 1.5], [7, 1.5], [4, 0.5], [2, 0.5], [0, 2]] },
                { kind: 'octave', melody: [[9, 1], [7, 1], [4, 2], [7, 1], [4, 0.5], [2, 0.5], [12, 2]] },
            ],
            b2: [
                { kind: 'passing', melody: [[4, 0.5], [2, 0.5], [0, 0.5], [-1, 0.5], [-3, 2], [-5, 1], [-3, 1], [2, 2]] },
                { kind: 'dotted', melody: [[4, 1.5], [0, 0.5], [-3, 2], [-5, 1], [-3, 1], [2, 2]] },
            ],
            close: [
                { kind: 'dotted', melody: [[-3, 1], [0, 0.5], [2, 0.5], [4, 1.5], [2, 0.5], [0, 4]] },
                { kind: 'lower', melody: [[-3, 1], [0, 0.5], [2, 0.5], [4, 1], [2, 1], [0, 3.5], [-1, 0.5]] },
            ],
        },
        phraseEnds: [{ bar: 15, ...DECEPTIVE.day }],
        interlude: {
            chords: [
                'D', 'A', 'F#m', 'E', 'A', 'F#m', ['D', 'E'], 'A',
            ],
            melody: [
                [9, 2], [4, 2], [7, 2], [0, 2],
                [4, 2], [-3, 2], [-5, 2], [2, 2],
                [0, 4], [0, 4],
                [-3, 4], [0, 4],
            ],
            counterNotes: [
                [-7, 4], [-8, 4], [-8, 4], [-10, 4],
                [-8, 4], [-8, 4], [-7, 2], [-10, 2], [-8, 4],
            ],
            bass: [
                [-19, 4], [-24, 4], [-24, 4], [-25, 4],
                [-20, 4], [-27, 4], [-19, 2], [-29, 2], [-20, 4],
            ],
        },
        tag: TAG.day,
        colour: { add9: { chords: [['D', 'E'], 'Aadd9'] }, borrowedIv: null, sixth: { chords: [['D', 'E'], 'A6'] } },
        percussion: {
            forge: [0, 0, 0, 0, 0, 0, 0.4, 0, 0, 0, 0, 0, 0, 0, 0.4, 0],
            archive: [0.12, 0, 0, 0, 0.64, 0, 0.16, 0, 0.12, 0, 0, 0, 0.64, 0, 0.2, 0],
            mine: [0.64, 0, 0, 0, 0, 0, 0, 0, 0.32, 0, 0, 0, 0, 0, 0, 0],
            taskboard: [0, 0, 0.24, 0, 0, 0, 0, 0, 0, 0, 0.24, 0, 0, 0, 0, 0.16],
            observatory: [0.4, 0, 0.24, 0, 0.4, 0, 0.24, 0, 0.4, 0, 0.24, 0, 0.4, 0, 0.24, 0],
            portal: [0, 0, 0, 0.16, 0, 0, 0.32, 0, 0, 0, 0, 0.16, 0, 0, 0.32, 0],
            command: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.24, 0, 0, 0.24, 0],
            harbor: [0, 0, 0.2, 0, 0.4, 0, 0, 0, 0, 0, 0.2, 0, 0.4, 0, 0, 0.16],
        },
    }),

    // ── Starfall ── the night city theme (Anistar-style): dark and slow, a
    // music box over a harp; the bass takes a second chord tone where it
    // shadowed the tune in octaves.
    piece({
        name: 'starfall', family: 'night', bpm: 64, beatsPerBar: 4, lead: 'bell', air: 0.3, engine: 'arpQ',
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
        counterNotes: [
            [-9, 4], [-9, 4],
            [-9, 4], [-10, 4],
            [-9, 4], [-9, 4],
            [-10, 4], [-9, 4],
            [-9, 4], [-10, 4],
            [-9, 4], [-10, 4],
            [-12, 4], [-14, 4],
            [-14, 4], [-17, 4],
        ],
        bass: [
            [-24, 4], [-24, 2], [-28, 2],
            [-21, 4], [-26, 4],
            [-24, 4], [-28, 4],
            [-29, 2], [-26, 2], [-24, 2], [-17, 2],
            [-28, 4], [-26, 4],
            [-24, 4], [-29, 2], [-26, 2],
            [-28, 4], [-21, 4],
            [-26, 4], [-24, 4],
        ],
        descantNotes: [
            [19, 1.5], [null, 0.5], [15, 2], [15, 1], [15, 1], [12, 2],
            [15, 1.5], [null, 0.5], [10, 1], [10, 1], [null, 2], [5, 2],
            [7, 1], [12, 1], [15, 1.5], [null, 0.5], [12, 1], [8, 1], [15, 2],
            [14, 1.5], [null, 0.5], [10, 1], [7, 1], [7, 3], [null, 1],
            [15, 2], [15, 1], [12, 1], [14, 1], [10, 1], [17, 1.5], [null, 0.5],
            [19, 1.5], [null, 0.5], [15, 1], [12, 1], [10, 2], [7, 2],
            [12, 1], [12, 1], [15, 1.5], [null, 0.5], [15, 1], [10, 1], [10, 2],
            [14, 1], [null, 1], [5, 2], [7, 4],
        ],
        grammar: ['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8'],
        variations: {
            s1: [
                { kind: 'passing', melody: [[12, 1.5], [10, 0.5], [7, 2], [8, 1], [7, 0.5], [5, 0.5], [3, 2]] },
                { kind: 'anticipate', melody: [[12, 1.5], [10, 0.5], [7, 1.5], [8, 1.5], [7, 1], [3, 2]] },
            ],
            s2: [
                { kind: 'passing', melody: [[7, 1.5], [5, 0.5], [3, 1], [2, 1], [2, 0.5], [3, 0.5], [5, 0.5], [2, 0.5], [-2, 2]] },
                { kind: 'dotted', melody: [[7, 1.5], [5, 0.5], [3, 1.5], [2, 0.5], [2, 1], [5, 0.5], [2, 0.5], [-2, 2]] },
            ],
            s3: [
                { kind: 'dotted', melody: [[0, 1.5], [3, 0.5], [7, 1.5], [5, 0.5], [3, 1], [0, 1], [8, 2]] },
                { kind: 'passing', melody: [[0, 0.5], [2, 0.5], [3, 0.5], [5, 0.5], [7, 1.5], [5, 0.5], [3, 1], [0, 1], [8, 2]] },
            ],
            s4: [
                { kind: 'dotted', melody: [[7, 1.5], [3, 0.5], [2, 1.5], [-2, 0.5], [0, 3], [null, 1]] },
                { kind: 'turn+anticipate', melody: [[7, 1.5], [3, 0.5], [2, 1], [-2, 1], [0, 1.5], [2, 1], [0, 0.5], [null, 1]] },
            ],
            s5: [
                { kind: 'dotted', melody: [[8, 2], [7, 1.5], [5, 0.5], [5, 1], [2, 1], [10, 1.5], [7, 0.5]] },
                { kind: 'anticipate', melody: [[8, 1.5], [7, 1.5], [5, 1], [5, 1], [2, 1], [10, 1.5], [7, 0.5]] },
            ],
            s6: [
                { kind: 'passing', melody: [[12, 1.5], [10, 0.5], [7, 0.5], [5, 0.5], [3, 1], [2, 1.5], [0, 0.5], [-2, 2]] },
                { kind: 'anticipate', melody: [[12, 1.5], [10, 0.5], [7, 1], [3, 1], [2, 1.5], [-2, 2.5]] },
            ],
            s7: [
                { kind: 'passing', melody: [[3, 1], [5, 0.5], [7, 0.5], [8, 1.5], [7, 0.5], [7, 0.5], [5, 0.5], [3, 1], [2, 2]] },
                { kind: 'turn', melody: [[3, 1], [5, 1], [8, 1.5], [7, 0.5], [7, 1], [3, 1], [2, 1], [3, 0.5], [2, 0.5]] },
            ],
            s8: [
                { kind: 'anticipate', melody: [[5, 1], [2, 0.5], [0, 0.5], [-2, 1.5], [0, 4.5]] },
                { kind: 'passing', melody: [[5, 0.5], [3, 0.5], [2, 0.5], [0, 0.5], [-2, 2], [0, 4]] },
            ],
        },
        phraseEnds: [{ bar: 7, ...DECEPTIVE.night }, { bar: 15, ...DECEPTIVE.night }],
        interlude: {
            chords: [
                'F', 'G', 'Am', 'Em', 'F', 'C', 'G', 'Am',
            ],
            melody: [
                [8, 2], [7, 2], [5, 2], [10, 2],
                [12, 2], [7, 2], [2, 2], [-2, 2],
                [3, 4], [7, 4],
                [5, 4], [0, 4],
            ],
            counterNotes: [
                [-9, 4], [-10, 4], [-9, 4], [-10, 4],
                [-12, 4], [-14, 4], [-14, 4], [-17, 4],
            ],
            bass: [
                [-28, 4], [-26, 4], [-21, 4], [-29, 4],
                [-24, 4], [-21, 4], [-26, 4], [-21, 4],
            ],
        },
        tag: TAG.night,
        colour: { add9: null, borrowedIv: null, sixth: null },
        percussion: {
            forge: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
            archive: [0, 0, 0, 0, 0, 0, 0, 0, 0.22, 0, 0, 0, 0, 0, 0, 0],
            mine: [0.38, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
            taskboard: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
            observatory: [0.45, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
            portal: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.22, 0, 0, 0],
            command: [0, 0, 0, 0, 0, 0, 0, 0, 0.18, 0, 0, 0, 0, 0, 0, 0],
            harbor: [0, 0, 0, 0, 0.18, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        },
    }),

    // ── Moonwell ── a shorter night piece: the well square after dark.
    piece({
        name: 'moonwell', family: 'night', bpm: 70, beatsPerBar: 4, lead: 'bell', air: 0.3, engine: 'arpQ',
        chords: [
            'Am', 'C', 'F', 'G', 'Am', 'F', 'G', 'Am',
        ],
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
        counterNotes: [
            [-9, 4], [-9, 4],
            [-9, 4], [-10, 4],
            [-9, 4], [-9, 4],
            [-10, 4], [-9, 4],
        ],
        bass: [
            [-24, 4], [-21, 4],
            [-28, 4], [-26, 4],
            [-24, 4], [-28, 4],
            [-26, 4], [-24, 4],
        ],
        descantNotes: [
            [15, 2], [15, 1], [15, 1], [15, 1.5], [null, 0.5], [10, 2],
            [null, 1], [12, 1], [15, 2], [17, 1.5], [null, 0.5], [14, 1], [10, 1],
            [12, 1], [15, 1], [19, 2], [15, 1.5], [null, 0.5], [12, 1], [8, 1],
            [10, 1], [14, 1], [5, 1], [10, 1], [7, 4],
        ],
        grammar: ['s1', 's2', 's3', 's4'],
        variations: {
            s1: [
                { kind: 'anticipate', melody: [[7, 1.5], [8, 1.5], [7, 1], [5, 1.5], [3, 0.5], [2, 2]] },
                { kind: 'dotted', melody: [[7, 2], [8, 1.5], [7, 0.5], [5, 1.5], [3, 0.5], [2, 2]] },
            ],
            s2: [
                { kind: 'anticipate', melody: [[0, 1], [3, 1], [8, 1.5], [10, 2], [7, 0.5], [5, 1], [2, 1]] },
                { kind: 'dotted', melody: [[0, 1.5], [3, 0.5], [8, 2], [10, 1.5], [7, 0.5], [5, 1], [2, 1]] },
            ],
            s3: [
                { kind: 'anticipate', melody: [[3, 1], [7, 1], [12, 1.5], [8, 2], [5, 0.5], [3, 1], [0, 1]] },
                { kind: 'dotted', melody: [[3, 1.5], [7, 0.5], [12, 2], [8, 1.5], [5, 0.5], [3, 1], [0, 1]] },
            ],
            s4: [
                { kind: 'dotted', melody: [[2, 1.5], [5, 0.5], [-2, 1], [2, 1], [0, 4]] },
                { kind: 'passing', melody: [[2, 0.5], [3, 0.5], [5, 1], [-2, 0.5], [0, 0.5], [2, 1], [0, 4]] },
            ],
        },
        phraseEnds: [{ bar: 4, ...DECEPTIVE.night }, { bar: 7, ...DECEPTIVE.night }],
        interlude: {
            chords: [
                'Am', 'C', 'F', 'G', 'Am', 'F', 'G', 'Am',
            ],
            melody: [
                [7, 2], [8, 2], [5, 2], [2, 2],
                [0, 2], [8, 2], [10, 2], [5, 2],
                [3, 4], [8, 4],
                [2, 4], [0, 4],
            ],
            counterNotes: [
                [-9, 4], [-9, 4], [-9, 4], [-10, 4],
                [-9, 4], [-9, 4], [-10, 4], [-9, 4],
            ],
            bass: [
                [-24, 4], [-21, 4], [-28, 4], [-22, 4],
                [-24, 4], [-24, 4], [-26, 4], [-21, 4],
            ],
        },
        tag: TAG.night,
        colour: { add9: null, borrowedIv: null, sixth: null },
        percussion: {
            forge: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
            archive: [0, 0, 0, 0, 0, 0, 0, 0, 0.07, 0, 0, 0, 0, 0, 0, 0],
            mine: [0.12, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
            taskboard: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
            observatory: [0.12, 0, 0, 0, 0, 0, 0, 0, 0.05, 0, 0, 0, 0, 0, 0, 0],
            portal: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.07, 0, 0, 0],
            command: [0, 0, 0, 0, 0, 0, 0, 0, 0.06, 0, 0, 0, 0, 0, 0, 0],
            harbor: [0, 0, 0, 0, 0.06, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        },
    }),

    // ── Lanternlight ── the Isle call in minor as a night waltz (MUS-5, as
    // notated). A deceptive V→VI at bar 8→9 keeps the night open; one A5
    // peak at bar 13.
    piece({
        name: 'lanternlight', family: 'night', bpm: 69, beatsPerBar: 3, lead: 'bell', air: 0.36, engine: 'waltz',
        pickup: [[-5, 1]],
        chords: [
            'Am', 'Am', 'F', 'G', 'Am', 'Dm', 'E', 'E',
            'F', 'C', 'Dm', 'E', 'Am', 'Dm', 'E', 'Am',
        ],
        melody: [
            [0, 2], [2, 1],
            [3, 3],
            [3, 1], [5, 1], [8, 1],
            [7, 2], [5, 1],
            [3, 2], [0, 1],
            [2, 1], [3, 1], [5, 1],
            [2, 2], [-1, 1],
            [-5, 2], [-1, 1],
            [0, 1], [3, 1], [8, 1],
            [7, 2], [3, 1],
            [5, 1], [8, 1], [12, 1],
            [11, 2], [7, 1],
            [12, 2], [7, 1],
            [8, 1], [5, 1], [3, 1],
            [2, 2], [-1, 1],
            [0, 2], [-5, 1],
        ],
        counterNotes: [
            [-9, 3], [-9, 3],
            [-9, 3], [-10, 3],
            [-9, 3], [-12, 3],
            [-13, 3], [-13, 3],
            [-12, 3], [-14, 3],
            [-16, 3], [-13, 3],
            [-9, 3], [-12, 3],
            [-13, 3], [-9, 3],
        ],
        bass: [
            [-24, 3], [-17, 3],
            [-28, 3], [-26, 3],
            [-24, 3], [-19, 3],
            [-29, 3], [-29, 3],
            [-28, 3], [-21, 3],
            [-19, 3], [-17, 3],
            [-24, 3], [-19, 3],
            [-29, 3], [-24, 3],
        ],
        descantNotes: [
            [7, 2], [12, 1], [12, 3],
            [12, 1], [12, 1], [15, 1], [14, 2], [14, 1],
            [12, 2], [7, 1], [12, 1], [12, 1], [12, 1],
            [11, 2], [7, 1], [2, 2], [7, 1],
            [8, 1], [12, 1], [15, 1], [null, 2], [10, 1],
            [12, 1], [17, 1], [20, 1], [19, 2], [14, 1],
            [19, 2], [15, 1], [17, 1], [12, 1], [12, 1],
            [11, 2], [7, 1], [7, 2], [3, 1],
        ],
        grammar: ['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8'],
        variations: {
            s1: [
                { kind: 'lower', melody: [[0, 2], [2, 1], [3, 2.5], [2, 0.5]] },
                { kind: 'anticipate', melody: [[0, 1.5], [2, 1.5], [3, 3]] },
            ],
            s2: [
                { kind: 'passing', melody: [[3, 1], [5, 0.5], [7, 0.5], [8, 1], [7, 2], [5, 1]] },
                { kind: 'anticipate', melody: [[3, 1], [5, 1], [8, 1], [7, 1.5], [5, 1.5]] },
            ],
            s3: [
                { kind: 'anticipate', melody: [[3, 1.5], [0, 1.5], [2, 1], [3, 1], [5, 1]] },
                { kind: 'passing', melody: [[3, 1.5], [2, 0.5], [0, 1], [2, 1], [3, 1], [5, 1]] },
            ],
            s4: [
                { kind: 'anticipate', melody: [[2, 1.5], [-1, 1.5], [-5, 2], [-1, 1]] },
                { kind: 'passing', melody: [[2, 1.5], [0, 0.5], [-1, 0.5], [-2, 0.5], [-5, 2], [-1, 1]] },
            ],
            s5: [
                { kind: 'dotted', melody: [[0, 1.5], [3, 0.5], [8, 1], [7, 2], [3, 1]] },
                { kind: 'passing', melody: [[0, 0.5], [2, 0.5], [3, 1], [8, 1], [7, 1.5], [5, 0.5], [3, 1]] },
            ],
            s6: [
                { kind: 'passing', melody: [[5, 0.5], [7, 0.5], [8, 0.5], [10, 0.5], [12, 1], [11, 2], [7, 1]] },
                { kind: 'anticipate', melody: [[5, 1], [8, 1], [12, 1], [11, 1.5], [7, 1.5]] },
            ],
            s7: [
                { kind: 'passing', melody: [[12, 2], [7, 1], [8, 0.5], [7, 0.5], [5, 1], [3, 1]] },
                { kind: 'anticipate', melody: [[12, 1.5], [7, 1.5], [8, 1], [5, 1], [3, 1]] },
            ],
            s8: [
                { kind: 'anticipate', melody: [[2, 1.5], [-1, 1.5], [0, 2], [-5, 1]] },
                { kind: 'passing', melody: [[2, 1.5], [0, 0.5], [-1, 1], [0, 2], [-5, 1]] },
            ],
        },
        phraseEnds: [{ bar: 12, ...DECEPTIVE.waltz }, { bar: 15, ...DECEPTIVE.waltz }],
        interlude: {
            chords: [
                'F', 'C', 'Dm', 'E', 'Am', 'Dm', 'E', 'Am',
            ],
            melody: [
                [0, 3], [7, 3],
                [5, 3], [11, 3],
                [12, 3], [8, 3],
                [2, 3], [0, 3],
            ],
            counterNotes: [
                [-9, 3], [-9, 3], [-12, 3], [-13, 3],
                [-9, 3], [-12, 3], [-13, 3], [-9, 3],
            ],
            bass: [
                [-28, 3], [-21, 3], [-24, 3], [-29, 3],
                [-21, 3], [-19, 3], [-29, 3], [-21, 3],
            ],
        },
        tag: TAG.waltz,
        colour: { add9: null, borrowedIv: null, sixth: null },
        percussion: {
            forge: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
            archive: [0, 0, 0, 0, 0.3, 0, 0, 0, 0.3, 0, 0, 0],
            mine: [0.4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
            taskboard: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
            observatory: [0.3, 0, 0, 0, 0.15, 0, 0, 0, 0.15, 0, 0, 0],
            portal: [0, 0, 0.1, 0, 0, 0, 0.1, 0, 0, 0, 0.1, 0],
            command: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
            harbor: [0, 0, 0, 0, 0.2, 0, 0, 0, 0.2, 0, 0, 0],
        },
    }),

    // ── Lanternway ── the lantern-lit lane lullaby, now a 16-bar piece: A A
    // B B, the A phrase settling on the minor dominant, the B phrase
    // walking home down the scale.
    piece({
        name: 'lanternway', family: 'night', bpm: 56, beatsPerBar: 4, lead: 'flute', air: 0.32, engine: 'arpQ',
        chords: [
            'Am', 'Am', 'C', 'Em', 'Am', 'Am', 'C', 'Em',
            'F', 'G', 'Am', 'Am', 'F', 'G', 'Am', 'Am',
        ],
        melody: [
            [0, 2], [-2, 1], [-5, 1],
            [-7, 1], [-5, 1], [-9, 2],
            [-12, 1], [-9, 1], [-7, 1], [-5, 1],
            [-5, 3], [null, 1],
            [0, 2], [-2, 1], [-5, 1],
            [-7, 1], [-5, 1], [-9, 2],
            [-12, 1], [-9, 1], [-7, 1], [-5, 1],
            [-5, 3], [null, 1],
            [3, 2], [0, 1], [-2, 1],
            [-2, 1], [-5, 0.5], [-7, 0.5], [-2, 2],
            [0, 1], [-2, 0.5], [-5, 0.5], [-7, 1], [-9, 1],
            [-12, 4],
            [3, 2], [0, 1], [-2, 1],
            [-2, 1], [-5, 0.5], [-7, 0.5], [-2, 2],
            [0, 1], [-2, 0.5], [-5, 0.5], [-7, 1], [-9, 1],
            [-12, 4],
        ],
        counterNotes: [
            [-9, 4], [-12, 4],
            [-17, 4], [-14, 4],
            [-9, 4], [-12, 4],
            [-17, 4], [-14, 4],
            [-12, 4], [-10, 4],
            [-12, 4], [-17, 4],
            [-12, 4], [-10, 4],
            [-12, 4], [-17, 4],
        ],
        bass: [
            [-24, 2], [-29, 2], [-24, 2], [-29, 2],
            [-21, 2], [-26, 2], [-29, 2], [-22, 2],
            [-24, 2], [-29, 2], [-24, 2], [-29, 2],
            [-21, 2], [-26, 2], [-29, 2], [-22, 2],
            [-28, 2], [-21, 2], [-26, 2], [-31, 2],
            [-24, 2], [-29, 2], [-24, 2], [-29, 2],
            [-28, 2], [-21, 2], [-26, 2], [-31, 2],
            [-24, 2], [-29, 2], [-24, 2], [-29, 2],
        ],
        descantNotes: [
            [7, 2], [7, 1], [3, 1], [null, 1], [3, 1], [0, 2],
            [-5, 1], [-2, 1], [3, 1], [3, 1], [2, 3], [null, 1],
            [7, 2], [7, 1], [3, 1], [null, 1], [3, 1], [0, 2],
            [-5, 1], [-2, 1], [3, 1], [3, 1], [2, 3], [null, 1],
            [12, 2], [8, 1], [8, 1], [5, 1], [null, 1], [5, 2],
            [7, 1], [null, 1], [0, 1], [0, 1], [-5, 4],
            [12, 2], [8, 1], [8, 1], [5, 1], [null, 1], [5, 2],
            [7, 1], [null, 1], [0, 1], [0, 1], [-5, 4],
        ],
        grammar: ['a1', 'a2', 'a1', 'a2', 'b1', 'b2', 'b1', 'b2'],
        variations: {
            a1: [
                { kind: 'passing', melody: [[0, 2], [-2, 0.5], [-4, 0.5], [-5, 1], [-7, 1], [-5, 0.5], [-7, 0.5], [-9, 2]] },
                { kind: 'anticipate', melody: [[0, 1.5], [-2, 1.5], [-5, 1], [-7, 1], [-5, 1], [-9, 2]] },
            ],
            a2: [
                { kind: 'passing', melody: [[-12, 0.5], [-10, 0.5], [-9, 1], [-7, 1], [-5, 1], [-5, 3], [null, 1]] },
                { kind: 'dotted', melody: [[-12, 1.5], [-9, 0.5], [-7, 1], [-5, 1], [-5, 3], [null, 1]] },
            ],
            b1: [
                { kind: 'dotted', melody: [[3, 2], [0, 1.5], [-2, 0.5], [-2, 1], [-5, 0.5], [-7, 0.5], [-2, 2]] },
                { kind: 'passing', melody: [[3, 1.5], [2, 0.5], [0, 1], [-2, 1], [-2, 0.5], [-4, 0.5], [-5, 0.5], [-7, 0.5], [-2, 2]] },
            ],
            b2: [
                { kind: 'passing', melody: [[0, 1], [-2, 0.5], [-5, 0.5], [-7, 1], [-9, 0.5], [-10, 0.5], [-12, 4]] },
                { kind: 'dotted', melody: [[0, 1], [-2, 0.5], [-5, 0.5], [-7, 1.5], [-9, 0.5], [-12, 4]] },
            ],
        },
        phraseEnds: [{ bar: 10, ...DECEPTIVE.night }, { bar: 14, ...DECEPTIVE.night }],
        interlude: {
            chords: [
                'F', 'G', 'Am', 'Am', 'F', 'G', 'Am', 'Am',
            ],
            melody: [
                [3, 2], [0, 2], [-2, 2], [-2, 2],
                [0, 2], [-7, 2], [-12, 4],
                [3, 2], [0, 2], [-2, 4],
                [0, 4], [-12, 4],
            ],
            counterNotes: [
                [-9, 4], [-10, 4], [-12, 4], [-17, 4],
                [-16, 4], [-14, 4], [-17, 4], [-17, 4],
            ],
            bass: [
                [-28, 4], [-22, 4], [-21, 4], [-21, 4],
                [-28, 4], [-22, 4], [-21, 4], [-21, 4],
            ],
        },
        tag: TAG.night,
        colour: { add9: null, borrowedIv: null, sixth: null },
        percussion: {
            forge: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
            archive: [0, 0, 0, 0, 0, 0, 0, 0, 0.22, 0, 0, 0, 0, 0, 0, 0],
            mine: [0.3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
            taskboard: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
            observatory: [0.45, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
            portal: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.22, 0, 0, 0],
            command: [0, 0, 0, 0, 0, 0, 0, 0, 0.18, 0, 0, 0, 0, 0, 0, 0],
            harbor: [0, 0, 0, 0, 0.18, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        },
    }),

    // ── Starwake ── the small-hours lullaby, now a 16-bar piece: A A B A,
    // each phrase sinking to the low tonic.
    piece({
        name: 'starwake', family: 'night', bpm: 60, beatsPerBar: 4, lead: 'flute', air: 0.32, engine: 'arpQ',
        chords: [
            'Am', 'C', 'G', 'Am', 'Am', 'C', 'G', 'Am',
            'F', 'C', 'G', 'Am', 'Am', 'C', 'G', 'Am',
        ],
        melody: [
            [-5, 1.5], [-2, 0.5], [0, 2],
            [-2, 1], [-5, 1], [-9, 2],
            [-7, 1], [-5, 0.5], [-2, 0.5], [-7, 2],
            [-12, 3], [null, 1],
            [-5, 1.5], [-2, 0.5], [0, 2],
            [-2, 1], [-5, 1], [-9, 2],
            [-7, 1], [-5, 0.5], [-2, 0.5], [-7, 2],
            [-12, 3], [null, 1],
            [3, 2], [0, 2],
            [-2, 1.5], [-5, 0.5], [-2, 2],
            [-7, 1], [-2, 1], [-5, 2],
            [-12, 4],
            [-5, 1.5], [-2, 0.5], [0, 2],
            [-2, 1], [-5, 1], [-9, 2],
            [-7, 1], [-5, 0.5], [-2, 0.5], [-7, 2],
            [-12, 3], [null, 1],
        ],
        counterNotes: [
            [-9, 4], [-14, 4],
            [-14, 4], [-17, 4],
            [-9, 4], [-14, 4],
            [-14, 4], [-17, 4],
            [-16, 4], [-17, 4],
            [-14, 4], [-17, 4],
            [-9, 4], [-14, 4],
            [-14, 4], [-17, 4],
        ],
        bass: [
            [-24, 2], [-29, 2], [-21, 2], [-26, 2],
            [-26, 2], [-31, 2], [-21, 2], [-24, 2],
            [-24, 2], [-29, 2], [-21, 2], [-26, 2],
            [-26, 2], [-31, 2], [-21, 2], [-24, 2],
            [-28, 2], [-21, 2], [-21, 2], [-26, 2],
            [-26, 2], [-31, 2], [-24, 2], [-29, 2],
            [-24, 2], [-29, 2], [-21, 2], [-26, 2],
            [-26, 2], [-31, 2], [-21, 2], [-24, 2],
        ],
        descantNotes: [
            [3, 1.5], [null, 0.5], [7, 2], [7, 1], [3, 1], [-2, 2],
            [2, 1], [null, 1], [2, 2], [-5, 3], [null, 1],
            [3, 1.5], [null, 0.5], [7, 2], [7, 1], [3, 1], [-2, 2],
            [2, 1], [null, 1], [2, 2], [-5, 3], [null, 1],
            [12, 2], [8, 2], [7, 1.5], [null, 0.5], [7, 2],
            [2, 1], [5, 1], [2, 2], [-5, 4],
            [3, 1.5], [null, 0.5], [7, 2], [7, 1], [3, 1], [-2, 2],
            [2, 1], [null, 1], [2, 2], [-5, 3], [null, 1],
        ],
        grammar: ['a1', 'a2', 'a1', 'a2', 'b1', 'b2', 'a1', 'a2'],
        variations: {
            a1: [
                { kind: 'anticipate', melody: [[-5, 1.5], [-2, 0.5], [0, 1.5], [-2, 1.5], [-5, 1], [-9, 2]] },
                { kind: 'dotted', melody: [[-5, 1.5], [-2, 0.5], [0, 2], [-2, 1.5], [-5, 0.5], [-9, 2]] },
            ],
            a2: [
                { kind: 'anticipate', melody: [[-7, 1], [-5, 0.5], [-2, 0.5], [-7, 1.5], [-12, 3.5], [null, 1]] },
            ],
            b1: [
                { kind: 'anticipate', melody: [[3, 1.5], [0, 2.5], [-2, 1.5], [-5, 0.5], [-2, 2]] },
            ],
            b2: [
                { kind: 'passing', melody: [[-7, 1], [-2, 0.5], [-4, 0.5], [-5, 2], [-12, 4]] },
                { kind: 'anticipate', melody: [[-7, 1], [-2, 1], [-5, 1.5], [-12, 4.5]] },
            ],
        },
        phraseEnds: [{ bar: 7, ...DECEPTIVE.night }, { bar: 15, ...DECEPTIVE.night }],
        interlude: {
            chords: [
                'F', 'C', 'G', 'Am', 'Am', 'C', 'G', 'Am',
            ],
            melody: [
                [3, 2], [0, 2], [-2, 2], [-2, 2],
                [-7, 4], [-12, 4],
                [-5, 4], [-2, 4],
                [-7, 4], [-12, 4],
            ],
            counterNotes: [
                [-9, 4], [-9, 4], [-10, 4], [-17, 4],
                [-17, 4], [-17, 4], [-14, 4], [-17, 4],
            ],
            bass: [
                [-28, 4], [-29, 4], [-26, 4], [-21, 4],
                [-24, 4], [-29, 4], [-26, 4], [-21, 4],
            ],
        },
        tag: TAG.night,
        colour: { add9: null, borrowedIv: null, sixth: null },
        percussion: {
            forge: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
            archive: [0, 0, 0, 0, 0, 0, 0, 0, 0.15, 0, 0, 0, 0, 0, 0, 0],
            mine: [0.38, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
            taskboard: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
            observatory: [0.45, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
            portal: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.22, 0, 0, 0],
            command: [0, 0, 0, 0, 0, 0, 0, 0, 0.18, 0, 0, 0, 0, 0, 0, 0],
            harbor: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.15, 0, 0, 0],
        },
    }),
]);

// ── Fragments ── closed 2–4 bar cells cut from the pieces (D1, MUSL round 2):
// the Village busker's material between occasions: the round-2 set, then
// every other phrase of every day piece closed by a cadence bar (a day pool
// large enough that no cell returns within an hour), and a night pool. Each
// closes home; `source` and `phrase` name the piece and the grammar slot(s)
// it is cut from, `bars` the source bars; `comp` is the harp's figure
// (`arpQ` quarter arpeggio, `block2` two block chords a bar, `roll` one
// rolled chord a chord); `motif` names the village motif figure the cell
// states (Motifs.js), if any.
export const FRAGMENTS = Object.freeze([
    {
        id: 'willowbrook-call-home', source: 'willowbrook', phrase: 's1+s8', bars: '1–2 (the call) + 15–16 (the cadence)',
        bpm: 84, beatsPerBar: 4, comp: 'arpQ', night: false, motif: 'call',
        chords: ['A', 'E', ['Bm', 'E'], 'A'],
        melody: [
            [0, 1], [4, 1], [7, 1.5], [4, 0.5],
            [2, 1], [-1, 1], [2, 2],
            [-7, 1], [-3, 1], [2, 1], [-1, 1],
            [0, 4],
        ],
        bass: [[-24, 2], [-20, 2], [-29, 2], [-22, 2], [-22, 2], [-29, 2], [-24, 4]],
    },
    {
        id: 'willowbrook-b', source: 'willowbrook', phrase: 's5', bars: '9–10 (the b phrase, closing on A)',
        bpm: 84, beatsPerBar: 4, comp: 'arpQ', night: false, motif: null,
        chords: ['D', 'A'],
        melody: [
            [5, 1], [9, 1], [7, 1.5], [5, 0.5],
            [4, 1], [7, 0.5], [4, 0.5], [0, 2],
        ],
        bass: [[-19, 2], [-24, 2], [-24, 4]],
    },
    {
        id: 'willowbrook-a2', source: 'willowbrook', phrase: 's3+s4', bars: '5–8 (a′, the authentic cadence)',
        bpm: 84, beatsPerBar: 4, comp: 'arpQ', night: false, motif: null,
        chords: ['A', 'D', ['Bm', 'E'], 'A'],
        melody: [
            [0, 1], [4, 1], [7, 1.5], [9, 0.5],
            [7, 1], [5, 0.5], [4, 0.5], [2, 1], [5, 1],
            [4, 1], [2, 1], [-1, 1], [2, 1],
            [0, 3], [null, 1],
        ],
        bass: [[-24, 2], [-20, 2], [-19, 2], [-24, 2], [-22, 2], [-29, 2], [-24, 4]],
    },
    {
        id: 'millbrook-b', source: 'millbrook', phrase: 'b1', bars: 'B 1–2 (the F♯5 peak, closing on A)',
        bpm: 72, beatsPerBar: 4, comp: 'block2', night: false, motif: 'home',
        chords: ['D', 'A'],
        melody: [
            [9, 1], [7, 1], [4, 2],
            [7, 1], [4, 0.5], [2, 0.5], [0, 2],
        ],
        bass: [[-19, 2], [-24, 2], [-24, 4]],
    },
    {
        id: 'millbrook-a-close', source: 'millbrook', phrase: 'a1+a2', bars: 'A 1–3 + the cadence cell (E → A)',
        bpm: 72, beatsPerBar: 4, comp: 'arpQ', night: false, motif: null,
        chords: ['A', 'F#m', 'D', ['E', 'A']],
        melody: [
            [0, 2], [4, 1], [2, 1],
            [0, 1], [-3, 1], [-5, 2],
            [-3, 1], [0, 0.5], [2, 0.5], [4, 1], [2, 1],
            [2, 1], [-1, 1], [0, 2],
        ],
        bass: [[-24, 2], [-29, 2], [-27, 2], [-20, 2], [-19, 2], [-24, 2], [-29, 2], [-24, 2]],
    },
    {
        id: 'hearthfire-a-close', source: 'hearthfire', phrase: 'a1', bars: 'A 1–2 + the cadence cell (E → A)',
        bpm: 88, beatsPerBar: 4, comp: 'arpQ', night: false, motif: null,
        chords: ['A', 'D', ['E', 'A']],
        melody: [
            [-5, 1], [-3, 0.5], [0, 0.5], [2, 1], [4, 1],
            [0, 1], [-3, 0.5], [-5, 0.5], [-3, 2],
            [2, 1], [-1, 1], [0, 2],
        ],
        bass: [[-24, 2], [-20, 2], [-19, 2], [-24, 2], [-29, 2], [-24, 2]],
    },
    {
        id: 'isle-call-home', source: 'paintedIsle', phrase: 'call', bars: 'the pickup and the Isle call, answered by the home phrase',
        bpm: 84, beatsPerBar: 4, comp: 'roll', night: false, motif: 'home',
        pickup: [[-5, 0.5]],
        chords: ['A', ['E', 'A']],
        melody: [
            [0, 1], [2, 0.5], [4, 2.5],
            [7, 1], [4, 0.5], [2, 0.5], [0, 2],
        ],
        bass: [[-24, 2], [-29, 2], [-25, 2], [-24, 2]],
    },
    {
        id: 'lanternway-b-night', source: 'lanternway', phrase: 'b1+b2', bars: 'B 1–4 (night)',
        bpm: 56, beatsPerBar: 4, comp: 'roll', night: true, motif: null,
        chords: ['F', 'G', 'Am', 'Am'],
        melody: [
            [3, 2], [0, 1], [-2, 1],
            [-2, 1], [-5, 0.5], [-7, 0.5], [-2, 2],
            [0, 1], [-2, 0.5], [-5, 0.5], [-7, 1], [-9, 1],
            [-12, 4],
        ],
        bass: [[-28, 2], [-21, 2], [-26, 2], [-31, 2], [-24, 2], [-29, 2], [-24, 4]],
    },
    {
        id: 'starfall-close', source: 'starfall', phrase: 's7+s8', bars: '13–16 (night)',
        bpm: 64, beatsPerBar: 4, comp: 'roll', night: true, motif: null,
        chords: ['F', 'C', 'G', 'Am'],
        melody: [
            [3, 1], [5, 1], [8, 1.5], [7, 0.5],
            [7, 1], [3, 1], [2, 2],
            [5, 1], [2, 0.5], [0, 0.5], [-2, 2],
            [0, 4],
        ],
        bass: [[-28, 2], [-21, 2], [-21, 2], [-26, 2], [-26, 2], [-31, 2], [-24, 4]],
    },
    {
        id: 'moonwell-b', source: 'moonwell', phrase: 's3+s4', bars: '5–8 (night)',
        bpm: 70, beatsPerBar: 4, comp: 'roll', night: true, motif: null,
        chords: ['Am', 'F', 'G', 'Am'],
        melody: [
            [3, 1], [7, 1], [12, 2],
            [8, 1.5], [5, 0.5], [3, 1], [0, 1],
            [2, 1], [5, 1], [-2, 1], [2, 1],
            [0, 4],
        ],
        bass: [[-24, 2], [-29, 2], [-28, 2], [-24, 2], [-26, 2], [-31, 2], [-24, 4]],
    },
    {
        id: 'starwake-a', source: 'starwake', phrase: 'a1+a2', bars: 'A 1–4 (night)',
        bpm: 60, beatsPerBar: 4, comp: 'roll', night: true, motif: null,
        chords: ['Am', 'C', 'G', 'Am'],
        melody: [
            [-5, 1.5], [-2, 0.5], [0, 2],
            [-2, 1], [-5, 1], [-9, 2],
            [-7, 1], [-5, 0.5], [-2, 0.5], [-7, 2],
            [-12, 4],
        ],
        bass: [[-24, 2], [-29, 2], [-21, 2], [-26, 2], [-26, 2], [-22, 2], [-24, 4]],
    },
    {
        id: 'lanternlight-close', source: 'lanternlight', phrase: 's7+s8', bars: '13–16 (night waltz)',
        bpm: 69, beatsPerBar: 3, comp: 'roll', night: true, motif: null,
        chords: ['Am', 'Dm', 'E', 'Am'],
        melody: [
            [12, 2], [7, 1],
            [8, 1], [5, 1], [3, 1],
            [2, 2], [-1, 1],
            [0, 3],
        ],
        bass: [[-24, 3], [-19, 3], [-29, 3], [-24, 3]],
    },
    {
        id: 'starfall-a', source: 'starfall', phrase: 's1+s2', bars: '1–3 + the cadence (G → Am, night)',
        bpm: 64, beatsPerBar: 4, comp: 'roll', night: true, motif: null,
        chords: ['Am', 'F', 'C', ['G', 'Am']],
        melody: [
            [12, 1.5], [10, 0.5], [7, 2],
            [8, 1], [7, 1], [3, 2],
            [7, 1.5], [5, 0.5], [3, 1], [2, 1],
            [2, 1], [-2, 1], [0, 2],
        ],
        bass: [[-24, 2], [-21, 2], [-28, 2], [-24, 2], [-21, 2], [-26, 2], [-26, 2], [-24, 2]],
    },
    {
        id: 'starfall-b', source: 'starfall', phrase: 's5+s6', bars: '9–11 (night)',
        bpm: 64, beatsPerBar: 4, comp: 'roll', night: true, motif: null,
        chords: ['F', 'G', 'Am'],
        melody: [
            [8, 2], [7, 1], [5, 1],
            [5, 1], [2, 1], [10, 1.5], [7, 0.5],
            [12, 1.5], [10, 0.5], [7, 1], [3, 1],
        ],
        bass: [[-28, 2], [-21, 2], [-26, 2], [-31, 2], [-24, 4]],
    },
    {
        id: 'moonwell-a', source: 'moonwell', phrase: 's1+s2', bars: '1–3 + the cadence (G → Am, night)',
        bpm: 70, beatsPerBar: 4, comp: 'roll', night: true, motif: null,
        chords: ['Am', 'C', 'F', ['G', 'Am']],
        melody: [
            [7, 2], [8, 1], [7, 1],
            [5, 1.5], [3, 0.5], [2, 2],
            [0, 1], [3, 1], [8, 2],
            [2, 1], [-2, 1], [0, 2],
        ],
        bass: [[-24, 2], [-29, 2], [-21, 2], [-26, 2], [-28, 2], [-21, 2], [-26, 2], [-24, 2]],
    },
    {
        id: 'lanternway-a', source: 'lanternway', phrase: 'a1+a2', bars: 'A 1–3 + the cadence (Em → Am, night)',
        bpm: 56, beatsPerBar: 4, comp: 'roll', night: true, motif: null,
        chords: ['Am', 'Am', 'C', ['Em', 'Am']],
        melody: [
            [0, 2], [-2, 1], [-5, 1],
            [-7, 1], [-5, 1], [-9, 2],
            [-12, 1], [-9, 1], [-7, 1], [-5, 1],
            [-5, 2], [-12, 2],
        ],
        bass: [[-24, 2], [-29, 2], [-24, 2], [-29, 2], [-21, 2], [-26, 2], [-26, 2], [-24, 2]],
    },
    {
        id: 'starwake-b', source: 'starwake', phrase: 'b1+b2', bars: 'B 1–4 (night)',
        bpm: 60, beatsPerBar: 4, comp: 'roll', night: true, motif: null,
        chords: ['F', 'C', 'G', 'Am'],
        melody: [
            [3, 2], [0, 2],
            [-2, 1.5], [-5, 0.5], [-2, 2],
            [-7, 1], [-2, 1], [-5, 2],
            [-12, 4],
        ],
        bass: [[-28, 2], [-21, 2], [-21, 2], [-26, 2], [-26, 2], [-31, 2], [-24, 4]],
    },
    {
        id: 'lanternlight-call-home', source: 'lanternlight', phrase: 's1+s8', bars: '1–2 (the call in minor) + 15–16 (night waltz)',
        bpm: 69, beatsPerBar: 3, comp: 'roll', night: true, motif: null,
        chords: ['Am', 'Am', 'E', 'Am'],
        melody: [
            [0, 2], [2, 1],
            [3, 3],
            [2, 2], [-1, 1],
            [0, 3],
        ],
        bass: [[-24, 3], [-24, 3], [-29, 3], [-24, 3]],
    },
    {
        id: 'starfall-answer', source: 'starfall', phrase: 's3+s4', bars: '5–8 (night)',
        bpm: 64, beatsPerBar: 4, comp: 'roll', night: true, motif: null,
        chords: ['Am', 'F', 'Em', 'Am'],
        melody: [
            [0, 1], [3, 1], [7, 1.5], [5, 0.5],
            [3, 1], [0, 1], [8, 2],
            [7, 1.5], [3, 0.5], [2, 1], [-2, 1],
            [0, 3], [null, 1],
        ],
        bass: [[-24, 2], [-21, 2], [-28, 2], [-21, 2], [-29, 2], [-26, 2], [-24, 4]],
    },
    {
        id: 'lanternlight-b', source: 'lanternlight', phrase: 's5', bars: '9–10 + the half cadence and home (night waltz)',
        bpm: 69, beatsPerBar: 3, comp: 'roll', night: true, motif: null,
        chords: ['F', 'C', 'E', 'Am'],
        melody: [
            [0, 1], [3, 1], [8, 1],
            [7, 2], [3, 1],
            [2, 2], [-1, 1],
            [0, 3],
        ],
        bass: [[-28, 3], [-21, 3], [-29, 3], [-24, 3]],
    },
    {
        id: 'willowbrook-3-4', source: 'willowbrook', phrase: 's2', bars: '3–4 + a cadence bar',
        bpm: 84, beatsPerBar: 4, comp: 'arpQ', night: false, motif: null,
        chords: [['F#m', 'D'], ['A', 'E'], ['E', 'A']],
        melody: [
            [4, 1], [2, 0.5], [0, 0.5], [-3, 1], [0, 1],
            [2, 2.5], [-1, 0.5], [-5, 1],
            [2, 1], [-1, 1], [0, 2],
        ],
        bass: [[-27, 2], [-19, 2], [-24, 2], [-29, 2], [-29, 2], [-24, 2]],
    },
    {
        id: 'willowbrook-11-12', source: 'willowbrook', phrase: 's6', bars: '11–12 + a cadence bar',
        bpm: 84, beatsPerBar: 4, comp: 'block2', night: false, motif: null,
        chords: ['E', 'F#m', ['D', 'A']],
        melody: [
            [2, 1], [4, 0.5], [2, 0.5], [-1, 1], [-5, 1],
            [-3, 1], [0, 1], [4, 2],
            [5, 1], [2, 1], [0, 2],
        ],
        bass: [[-29, 2], [-22, 2], [-27, 2], [-24, 2], [-27, 2], [-24, 2]],
    },
    {
        id: 'willowbrook-13-14', source: 'willowbrook', phrase: 's7', bars: '13–14',
        bpm: 84, beatsPerBar: 4, comp: 'arpQ', night: false, motif: null,
        chords: ['D', 'A'],
        melody: [
            [5, 1.5], [4, 0.5], [2, 1], [0, 1],
            [4, 1], [0, 3],
        ],
        bass: [[-19, 2], [-24, 2], [-24, 4]],
    },
    {
        id: 'cobblemarket-1-2', source: 'cobblemarket', phrase: 's1', bars: '1–2 + a cadence bar',
        bpm: 92, beatsPerBar: 4, comp: 'arpQ', night: false, motif: 'home',
        chords: ['A', 'G', ['E', 'A']],
        melody: [
            [7, 1], [4, 0.5], [2, 0.5], [0, 1], [2, 1],
            [-2, 1.5], [0, 0.5], [2, 1], [-2, 1],
            [-1, 1], [2, 1], [0, 2],
        ],
        bass: [[-24, 2], [-29, 2], [-26, 2], [-31, 2], [-29, 2], [-24, 2]],
    },
    {
        id: 'cobblemarket-3-4', source: 'cobblemarket', phrase: 's2', bars: '3–4',
        bpm: 92, beatsPerBar: 4, comp: 'block2', night: false, motif: null,
        chords: ['D', 'A'],
        melody: [
            [-3, 1], [0, 0.5], [2, 0.5], [5, 1], [4, 0.5], [2, 0.5],
            [0, 2.5], [null, 0.5], [0, 1],
        ],
        bass: [[-19, 2], [-24, 2], [-24, 4]],
    },
    {
        id: 'cobblemarket-5-6', source: 'cobblemarket', phrase: 's3', bars: '5–6 + a cadence bar',
        bpm: 92, beatsPerBar: 4, comp: 'arpQ', night: false, motif: 'home',
        chords: ['A', 'G', ['D', 'A']],
        melody: [
            [4, 1], [7, 0.5], [4, 0.5], [2, 1], [0, 1],
            [2, 1], [-2, 1], [0, 2],
            [5, 1], [2, 1], [0, 2],
        ],
        bass: [[-24, 2], [-29, 2], [-26, 2], [-31, 2], [-27, 2], [-24, 2]],
    },
    {
        id: 'cobblemarket-7-8', source: 'cobblemarket', phrase: 's4', bars: '7–8',
        bpm: 92, beatsPerBar: 4, comp: 'arpQ', night: false, motif: null,
        chords: [['D', 'E'], 'A'],
        melody: [
            [-3, 1], [-5, 0.5], [-3, 0.5], [-1, 1], [2, 1],
            [0, 4],
        ],
        bass: [[-19, 2], [-29, 2], [-24, 4]],
    },
    {
        id: 'cobblemarket-9-10', source: 'cobblemarket', phrase: 's5', bars: '9–10 + a cadence bar',
        bpm: 92, beatsPerBar: 4, comp: 'block2', night: false, motif: null,
        chords: ['F#m', 'D', ['E', 'A']],
        melody: [
            [4, 1], [2, 1], [0, 1.5], [-3, 0.5],
            [-3, 1], [-7, 0.5], [-3, 0.5], [0, 2],
            [-1, 1], [2, 1], [0, 2],
        ],
        bass: [[-27, 2], [-20, 2], [-19, 2], [-24, 2], [-29, 2], [-24, 2]],
    },
    {
        id: 'cobblemarket-11-12', source: 'cobblemarket', phrase: 's6', bars: '11–12 + a cadence bar',
        bpm: 92, beatsPerBar: 4, comp: 'arpQ', night: false, motif: null,
        chords: ['A', 'E', ['E', 'A']],
        melody: [
            [4, 1.5], [7, 0.5], [4, 1], [2, 1],
            [2, 1], [-1, 1], [2, 2],
            [2, 1], [-1, 1], [0, 2],
        ],
        bass: [[-24, 2], [-29, 2], [-29, 2], [-22, 2], [-29, 2], [-24, 2]],
    },
    {
        id: 'cobblemarket-13-14', source: 'cobblemarket', phrase: 's7', bars: '13–14 + a cadence bar',
        bpm: 92, beatsPerBar: 4, comp: 'arpQ', night: false, motif: null,
        chords: ['F#m', 'G', ['D', 'A']],
        melody: [
            [9, 1], [7, 1], [4, 1.5], [2, 0.5],
            [2, 1], [0, 1], [-2, 2],
            [5, 1], [2, 1], [0, 2],
        ],
        bass: [[-27, 2], [-24, 2], [-26, 2], [-31, 2], [-27, 2], [-24, 2]],
    },
    {
        id: 'cobblemarket-15-16', source: 'cobblemarket', phrase: 's8', bars: '15–16',
        bpm: 92, beatsPerBar: 4, comp: 'block2', night: false, motif: null,
        chords: [['D', 'E'], 'A'],
        melody: [
            [-3, 1], [0, 1], [2, 0.5], [4, 0.5], [-1, 1],
            [0, 4],
        ],
        bass: [[-19, 2], [-29, 2], [-24, 4]],
    },
    {
        id: 'millwheel-1-2', source: 'millwheel', phrase: 's1', bars: '1–2',
        bpm: 126, beatsPerBar: 4, comp: 'arpQ', night: false, motif: 'home',
        chords: ['A', 'A'],
        melody: [
            [0, 0.5], [2, 0.5], [4, 0.5], [7, 0.5], [9, 1], [7, 1],
            [4, 0.5], [7, 0.5], [4, 0.5], [2, 0.5], [0, 2],
        ],
        bass: [[-24, 2], [-29, 2], [-24, 4]],
    },
    {
        id: 'millwheel-3-4', source: 'millwheel', phrase: 's2', bars: '3–4 + a cadence bar',
        bpm: 126, beatsPerBar: 4, comp: 'arpQ', night: false, motif: null,
        chords: ['D', 'E', ['E', 'A']],
        melody: [
            [5, 0.5], [4, 0.5], [2, 0.5], [5, 0.5], [9, 1], [7, 1],
            [7, 0.5], [4, 0.5], [2, 0.5], [-1, 0.5], [2, 2],
            [2, 1], [-1, 1], [0, 2],
        ],
        bass: [[-19, 2], [-24, 2], [-29, 2], [-25, 2], [-29, 2], [-24, 2]],
    },
    {
        id: 'millwheel-5-6', source: 'millwheel', phrase: 's3', bars: '5–6 + a cadence bar',
        bpm: 126, beatsPerBar: 4, comp: 'block2', night: false, motif: null,
        chords: ['A', 'F#m', ['D', 'A']],
        melody: [
            [0, 0.5], [2, 0.5], [4, 0.5], [7, 0.5], [12, 1], [9, 1],
            [9, 0.5], [7, 0.5], [4, 0.5], [7, 0.5], [4, 1], [0, 1],
            [5, 1], [2, 1], [0, 2],
        ],
        bass: [[-24, 2], [-29, 2], [-27, 2], [-24, 2], [-27, 2], [-24, 2]],
    },
    {
        id: 'millwheel-7-8', source: 'millwheel', phrase: 's4', bars: '7–8 + a cadence bar',
        bpm: 126, beatsPerBar: 4, comp: 'arpQ', night: false, motif: null,
        chords: [['D', 'E'], 'A', ['E', 'A']],
        melody: [
            [5, 1], [2, 1], [-1, 1], [2, 1],
            [0, 2], [null, 0.5], [-5, 0.5], [-3, 0.5], [-1, 0.5],
            [7, 1], [2, 1], [4, 2],
        ],
        bass: [[-19, 2], [-29, 2], [-24, 2], [-29, 2], [-29, 2], [-24, 2]],
    },
    {
        id: 'millwheel-9-10', source: 'millwheel', phrase: 's5', bars: '9–10 + a cadence bar',
        bpm: 126, beatsPerBar: 4, comp: 'arpQ', night: false, motif: null,
        chords: ['F#m', 'D', ['E', 'A']],
        melody: [
            [4, 1], [4, 0.5], [2, 0.5], [4, 1], [7, 1],
            [5, 1], [5, 0.5], [4, 0.5], [5, 1], [9, 1],
            [2, 1], [-1, 1], [0, 2],
        ],
        bass: [[-27, 2], [-20, 2], [-27, 2], [-19, 2], [-29, 2], [-24, 2]],
    },
    {
        id: 'millwheel-11-12', source: 'millwheel', phrase: 's6', bars: '11–12 + a cadence bar',
        bpm: 126, beatsPerBar: 4, comp: 'block2', night: false, motif: null,
        chords: ['A', 'E', ['E', 'A']],
        melody: [
            [12, 1.5], [11, 0.5], [9, 1], [7, 1],
            [7, 1], [4, 0.5], [2, 0.5], [-1, 2],
            [2, 1], [-1, 1], [0, 2],
        ],
        bass: [[-24, 2], [-29, 2], [-29, 2], [-22, 2], [-29, 2], [-24, 2]],
    },
    {
        id: 'millwheel-13-14', source: 'millwheel', phrase: 's7', bars: '13–14 + a cadence bar',
        bpm: 126, beatsPerBar: 4, comp: 'arpQ', night: false, motif: null,
        chords: ['F#m', 'D', ['D', 'A']],
        melody: [
            [4, 0.5], [2, 0.5], [0, 0.5], [2, 0.5], [4, 1], [7, 1],
            [5, 0.5], [4, 0.5], [2, 0.5], [4, 0.5], [5, 1], [9, 1],
            [5, 1], [2, 1], [0, 2],
        ],
        bass: [[-27, 2], [-20, 2], [-27, 2], [-19, 2], [-27, 2], [-24, 2]],
    },
    {
        id: 'millwheel-15-16', source: 'millwheel', phrase: 's8', bars: '15–16 + a cadence bar',
        bpm: 126, beatsPerBar: 4, comp: 'arpQ', night: false, motif: null,
        chords: ['E', 'A', ['E', 'A']],
        melody: [
            [7, 1], [2, 1], [-1, 1], [2, 1],
            [0, 2], [0, 0.5], [4, 0.5], [7, 0.5], [9, 0.5],
            [7, 1], [2, 1], [4, 2],
        ],
        bass: [[-29, 2], [-22, 2], [-24, 2], [-29, 2], [-29, 2], [-24, 2]],
    },
    {
        id: 'paintedIsle-3-4', source: 'paintedIsle', phrase: 'answerOpen', bars: '3–4 + a cadence bar',
        bpm: 88, beatsPerBar: 4, comp: 'block2', night: false, motif: null,
        chords: ['F#m', 'E', ['E', 'A']],
        melody: [
            [4, 1], [2, 0.5], [0, 0.5], [-3, 1], [0, 1],
            [2, 3], [null, 0.5], [-5, 0.5],
            [-1, 1], [2, 1], [0, 2],
        ],
        bass: [[-27, 2], [-20, 2], [-29, 2], [-22, 2], [-29, 2], [-24, 2]],
    },
    {
        id: 'paintedIsle-5-6', source: 'paintedIsle', phrase: 'call2', bars: '5–6 + a cadence bar',
        bpm: 88, beatsPerBar: 4, comp: 'arpQ', night: false, motif: null,
        chords: ['A', 'D', ['E', 'A']],
        melody: [
            [0, 1], [2, 0.5], [4, 1], [7, 1.5],
            [9, 1.5], [7, 0.5], [5, 1], [9, 1],
            [2, 1], [-1, 1], [0, 2],
        ],
        bass: [[-24, 2], [-29, 2], [-19, 2], [-24, 2], [-29, 2], [-24, 2]],
    },
    {
        id: 'paintedIsle-7-8', source: 'paintedIsle', phrase: 'answerClosed', bars: '7–8',
        bpm: 88, beatsPerBar: 4, comp: 'arpQ', night: false, motif: null,
        chords: [['Bm', 'E'], 'A'],
        melody: [
            [7, 1], [5, 1], [2, 1], [-1, 1],
            [0, 4],
        ],
        bass: [[-22, 2], [-29, 2], [-24, 4]],
    },
    {
        id: 'paintedIsle-9-10', source: 'paintedIsle', phrase: 'stairs', bars: '9–10 + a cadence bar',
        bpm: 88, beatsPerBar: 4, comp: 'block2', night: false, motif: null,
        chords: ['D', 'C#m', ['E', 'A']],
        melody: [
            [9, 1.5], [12, 0.5], [9, 1], [5, 1],
            [7, 1.5], [11, 0.5], [7, 1], [4, 1],
            [7, 1], [2, 1], [4, 2],
        ],
        bass: [[-19, 2], [-24, 2], [-20, 2], [-25, 2], [-29, 2], [-24, 2]],
    },
    {
        id: 'paintedIsle-11-12', source: 'paintedIsle', phrase: 'turn', bars: '11–12 + a cadence bar',
        bpm: 88, beatsPerBar: 4, comp: 'arpQ', night: false, motif: null,
        chords: ['Bm', 'E', ['E', 'A']],
        melody: [
            [5, 1.5], [9, 0.5], [5, 1], [2, 1],
            [4, 1], [2, 1], [-1, 1.5], [-5, 0.5],
            [-1, 1], [2, 1], [0, 2],
        ],
        bass: [[-22, 2], [-27, 2], [-29, 2], [-22, 2], [-29, 2], [-24, 2]],
    },
    {
        id: 'paintedIsle-13-14', source: 'paintedIsle', phrase: 'summit', bars: '13–14 + a cadence bar',
        bpm: 88, beatsPerBar: 4, comp: 'arpQ', night: false, motif: null,
        chords: ['A', ['D', 'Dm'], ['E', 'A']],
        melody: [
            [0, 1], [2, 0.5], [4, 0.5], [12, 2],
            [9, 1], [7, 1], [5, 1.5], [2, 0.5],
            [2, 1], [-1, 1], [0, 2],
        ],
        bass: [[-24, 2], [-29, 2], [-19, 2], [-19, 2], [-29, 2], [-24, 2]],
    },
    {
        id: 'paintedIsle-15-16', source: 'paintedIsle', phrase: 'cadence', bars: '15–16',
        bpm: 88, beatsPerBar: 4, comp: 'block2', night: false, motif: null,
        chords: [['A', 'E'], 'A'],
        melody: [
            [4, 1], [0, 1], [2, 1], [-1, 1],
            [0, 4],
        ],
        bass: [[-24, 2], [-29, 2], [-24, 4]],
    },
    {
        id: 'hearthfire-3-4', source: 'hearthfire', phrase: 'a2', bars: '3–4 + a cadence bar',
        bpm: 88, beatsPerBar: 4, comp: 'arpQ', night: false, motif: null,
        chords: ['A', 'E', ['E', 'A']],
        melody: [
            [-5, 1], [-8, 0.5], [-5, 0.5], [0, 1], [2, 1],
            [2, 1.5], [0, 0.5], [2, 2],
            [7, 1], [2, 1], [4, 2],
        ],
        bass: [[-24, 2], [-29, 2], [-29, 2], [-22, 2], [-25, 2], [-24, 2]],
    },
    {
        id: 'hearthfire-9-10', source: 'hearthfire', phrase: 'b1', bars: '9–10 + a cadence bar',
        bpm: 88, beatsPerBar: 4, comp: 'arpQ', night: false, motif: null,
        chords: ['F#m', 'D', ['E', 'A']],
        melody: [
            [4, 1], [2, 0.5], [0, 0.5], [-3, 1], [0, 1],
            [2, 1], [0, 0.5], [-3, 0.5], [-5, 2],
            [-1, 1], [2, 1], [0, 2],
        ],
        bass: [[-27, 2], [-20, 2], [-19, 2], [-24, 2], [-29, 2], [-24, 2]],
    },
    {
        id: 'hearthfire-11-12', source: 'hearthfire', phrase: 'b2', bars: '11–12 + a cadence bar',
        bpm: 88, beatsPerBar: 4, comp: 'block2', night: false, motif: null,
        chords: ['A', 'E', ['E', 'A']],
        melody: [
            [-8, 1], [-5, 0.5], [-3, 0.5], [0, 1], [-3, 1],
            [2, 2], [-5, 2],
            [2, 1], [-1, 1], [0, 2],
        ],
        bass: [[-24, 2], [-29, 2], [-29, 2], [-22, 2], [-29, 2], [-24, 2]],
    },
    {
        id: 'hearthfire-15-16', source: 'hearthfire', phrase: 'close', bars: '15–16',
        bpm: 88, beatsPerBar: 4, comp: 'arpQ', night: false, motif: null,
        chords: ['E', 'A'],
        melody: [
            [2, 1.5], [0, 0.5], [-1, 2],
            [4, 1], [2, 1], [0, 2],
        ],
        bass: [[-29, 2], [-22, 2], [-24, 4]],
    },
    {
        id: 'millbrook-11-12', source: 'millbrook', phrase: 'b2', bars: '11–12 + a cadence bar',
        bpm: 72, beatsPerBar: 4, comp: 'arpQ', night: false, motif: null,
        chords: ['F#m', 'E', ['E', 'A']],
        melody: [
            [4, 1], [0, 1], [-3, 2],
            [-5, 1], [-3, 1], [2, 2],
            [7, 1], [2, 1], [4, 2],
        ],
        bass: [[-27, 2], [-20, 2], [-29, 2], [-25, 2], [-29, 2], [-24, 2]],
    },
    {
        id: 'millbrook-15-16', source: 'millbrook', phrase: 'close', bars: '15–16',
        bpm: 72, beatsPerBar: 4, comp: 'block2', night: false, motif: null,
        chords: [['D', 'E'], 'A'],
        melody: [
            [-3, 1], [0, 0.5], [2, 0.5], [4, 1], [2, 1],
            [0, 4],
        ],
        bass: [[-19, 2], [-29, 2], [-24, 4]],
    },
].map(fragment => deepFreeze(fragment)));

// Which pieces the Town band plays at which time of day. Every day set has at
// least four pieces, so no piece has to return within six minutes (6.7).
export const PLAYLISTS = Object.freeze({
    dawn: Object.freeze(['millbrook', 'willowbrook', 'paintedIsle', 'hearthfire']),
    day: Object.freeze(['willowbrook', 'paintedIsle', 'cobblemarket', 'millwheel', 'hearthfire', 'millbrook']),
    dusk: Object.freeze(['hearthfire', 'millbrook', 'willowbrook', 'paintedIsle']),
    night: Object.freeze(['lanternlight', 'starfall', 'moonwell', 'lanternway', 'starwake']),
});

// The lantern-lighting cadence (MUS-11): four bars at the blue-hour → night
// boundary, the major tonic darkening through the borrowed iv to minor.
export const NIGHTFALL_TAG = deepFreeze({
    bpm: 64, beatsPerBar: 4,
    chords: ['A', 'Dm', 'E', 'Am'],
    melody: [[4, 2], [7, 2], [5, 2], [8, 2], [2, 1], [-1, 1], [2, 2], [0, 4]],
    bass: [[-24, 4], [-19, 4], [-29, 4], [-24, 4]],
});

// The release stinger (MUS-11): the motif's call answered by its home phrase
// over the tonic, on the bar after the gold peal. Minor at night.
export const RELEASE_FANFARE = deepFreeze({
    day: {
        bpm: 96, beatsPerBar: 4,
        chords: ['A', 'A'],
        melody: [[0, 1], [4, 1], [7, 1.5], [4, 0.5], [7, 1], [4, 0.5], [2, 0.5], [0, 2]],
        bass: [[-24, 2], [-20, 2], [-24, 2], [-17, 2]],
    },
    night: {
        bpm: 80, beatsPerBar: 4,
        chords: ['Am', 'Am'],
        melody: [[0, 1], [3, 1], [7, 1.5], [3, 0.5], [7, 1], [3, 0.5], [2, 0.5], [0, 2]],
        bass: [[-24, 2], [-21, 2], [-24, 2], [-17, 2]],
    },
});

// The Village occasions (SCN-3, D1): what each one plays. A phase occasion is
// one pass of a piece at `tempoScale` ending with its tag; `entries` stage
// the players by bar (the dawn occasion wakes like the village: the whistle
// over a quarter-note harp and bass roots, then the harp's eighths, then the
// tune handed to the lute seat over block chords, then the whistle again).
// `prelude` plays first (the release stinger). Release, return and welcome
// differ by day and night; the welcome is a fragment.
export const OCCASIONS = deepFreeze({
    dawn: {
        piece: 'millbrook', tempoScale: 0.9,
        entries: [
            { fromBar: 0, voices: ['lead', 'engine', 'bass'], engine: 'arpQ', leadSeat: 'lead', bass: 'roots' },
            { fromBar: 4, voices: ['lead', 'engine', 'bass'], engine: 'arp8', leadSeat: 'lead' },
            { fromBar: 8, voices: ['lead', 'engine', 'bass'], engine: 'block2', leadSeat: 'counter' },
            { fromBar: 12, voices: ['lead', 'counter', 'engine', 'bass'], engine: 'arp8', leadSeat: 'lead' },
        ],
    },
    noon: { piece: 'paintedIsle', tempoScale: 1 },
    dusk: { piece: 'hearthfire', tempoScale: 0.85 },
    night: { piece: 'lanternlight', tempoScale: 1 },
    release: {
        day: { prelude: 'releaseFanfare', piece: 'willowbrook', tempoScale: 1 },
        night: { prelude: 'releaseFanfare', piece: 'starwake', tempoScale: 1 },
    },
    return: {
        day: { piece: 'cobblemarket', tempoScale: 1 },
        night: { piece: 'moonwell', tempoScale: 1 },
    },
    welcome: {
        day: { fragment: 'willowbrook-call-home' },
        night: { fragment: 'lanternway-b-night' },
    },
});
