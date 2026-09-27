// ── Emberwatch ── the hearth-side nocturne for the last watch, a 16-bar
// piece in D minor: A A′ over i–VI–III–VII, the second closing through
// a Dorian A–B♮–C♯ climb, then a B phrase that rises once to A5 and sinks
// back to the low tonic. Every figure is a long breath and a falling
// second; the lute sings it low over the concertina and a darkened harp.

import { cadenceKit, piece } from '../ScoreKit.js';

const KEY = { tonic: 'D', mode: 'minor' };
const { tag: TAG, deceptive: DECEPTIVE } = cadenceKit(KEY);
// The kit's landing (A5 F5 E5 D5) sits an octave over this low tune: the
// same home phrase an octave down, over the tonic's third, then its fifth.
const HOME = { melody: [[0, 1], [-4, 0.5], [-5, 0.5], [-7, 2]], bass: [[-28, 2], [-24, 2]] };

export default piece({
    name: 'emberwatch', title: 'Emberwatch', family: 'night', bpm: 58, beatsPerBar: 4, engine: 'arpQ',
    key: KEY, phases: ['night'], feel: 'straight',
    arrangement: {
        lead: ['lute', 0, { bright: 0.6 }], counter: ['concertina', 0, { bright: 0.6 }],
        engine: ['harp', 0, { bright: 0.5 }], descant: ['fiddle', 0, { bright: 0.6 }],
        // The full band's descant is a bowed fiddle above the tune (MUSL-3: the
        // harp's range folds the written descant under it).
    },
    chords: [
        'Dm', 'Bb', 'F', 'C', 'Dm', 'Bb', ['Gm', 'A'], 'Dm',
        'Bb', 'F', 'Gm', 'C', 'Bb', 'F', ['Gm', 'A'], 'Dm',
    ],
    melody: [
        [0, 1.5], [-2, 0.5], [-4, 2],
        [5, 1.5], [3, 0.5], [1, 2],
        [3, 1.5], [1, 0.5], [0, 2],
        [-2, 1.5], [-4, 0.5], [-5, 1], [null, 1],
        [0, 1.5], [-2, 0.5], [-4, 2],
        [5, 1.5], [3, 0.5], [1, 2],
        [1, 1.5], [-2, 0.5], [0, 1], [2, 0.5], [4, 0.5],
        [5, 1.5], [3, 0.5], [5, 2],
        [1, 1], [5, 1], [8, 1.5], [10, 0.5],
        [12, 2], [10, 1], [8, 1],
        [5, 1.5], [3, 0.5], [1, 2],
        [-2, 1.5], [0, 0.5], [3, 2],
        [1, 1], [5, 1], [8, 1.5], [10, 0.5],
        [12, 2], [10, 1], [8, 1],
        [5, 1], [-2, 1], [-5, 1], [-8, 1],
        [-7, 3], [null, 1],
    ],
    counterNotes: [
        [-9, 4], [-7, 4],
        [-12, 4], [-14, 4],
        [-9, 4], [-7, 4],
        [-7, 2], [-8, 2], [-4, 2], [-9, 2],
        [-7, 4], [-9, 4],
        [-11, 4], [-9, 4],
        [-7, 4], [-9, 4],
        [-7, 2], [-12, 2], [-16, 4],
    ],
    bass: [
        [-31, 2], [-24, 2], [-23, 2], [-19, 2],
        [-28, 4], [-29, 2], [-33, 2],
        [-31, 2], [-24, 2], [-23, 2], [-19, 2],
        [-26, 2], [-20, 2], [-19, 2], [-24, 2],
        [-23, 2], [-19, 2], [-28, 2], [-24, 2],
        [-26, 2], [-19, 2], [-21, 2], [-26, 2],
        [-23, 2], [-19, 2], [-28, 2], [-24, 2],
        [-23, 2], [-24, 2], [-31, 4],
    ],
    descantNotes: [
        [8, 1.5], [null, 0.5], [5, 2], [13, 1.5], [null, 0.5], [10, 2],
        [12, 1.5], [null, 0.5], [8, 2], [7, 1.5], [null, 2.5],
        [8, 1.5], [null, 0.5], [5, 2], [13, 1.5], [null, 0.5], [10, 2],
        [10, 1.5], [null, 0.5], [7, 2], [8, 2], [null, 2],
        [null, 2], [13, 2], [20, 2], [null, 2],
        [13, 1.5], [null, 0.5], [10, 2], [7, 1.5], [null, 0.5], [12, 2],
        [null, 2], [13, 2], [20, 2], [null, 2],
        [null, 4], [8, 3], [null, 1],
    ],
    grammar: ['a1', 'a2', 'a1', 'a3', 'b1', 'b2', 'b1', 'close'],
    variations: {
        a1: [
            { kind: 'dorian', melody: [[0, 1], [2, 0.5], [0, 0.5], [-4, 2], [5, 1.5], [3, 0.5], [1, 2]] },
            { kind: 'passing', melody: [[0, 1.5], [-2, 0.5], [-4, 2], [5, 1.5], [3, 0.5], [1, 1], [0, 0.5], [-2, 0.5]] },
        ],
        a2: [
            { kind: 'turn', melody: [[3, 1], [5, 0.5], [3, 0.5], [1, 1], [0, 1], [-2, 1.5], [-4, 0.5], [-5, 1], [null, 1]] },
            { kind: 'breath', melody: [[3, 1.5], [1, 0.5], [0, 2], [-2, 1], [-4, 1], [-5, 2]] },
        ],
        a3: [
            { kind: 'turn', melody: [[1, 1.5], [-2, 0.5], [0, 1], [2, 0.5], [4, 0.5], [5, 1.5], [8, 0.5], [5, 1], [3, 1]] },
            { kind: 'passing', melody: [[1, 1], [0, 0.5], [-2, 0.5], [0, 1], [2, 0.5], [4, 0.5], [5, 1.5], [3, 0.5], [5, 2]] },
        ],
        b1: [
            { kind: 'sigh', melody: [[1, 1], [5, 1], [8, 1.5], [10, 0.5], [12, 1.5], [10, 0.5], [8, 2]] },
            { kind: 'passing', melody: [[1, 1], [3, 0.5], [5, 0.5], [8, 1.5], [10, 0.5], [12, 2], [10, 1], [8, 1]] },
        ],
        b2: [
            { kind: 'passing', melody: [[5, 1.5], [3, 0.5], [1, 1], [0, 1], [-2, 1.5], [0, 0.5], [3, 2]] },
            { kind: 'climb', melody: [[5, 1.5], [3, 0.5], [1, 2], [-2, 1], [0, 1], [3, 1], [5, 1]] },
        ],
        close: [
            { kind: 'return', melody: [[5, 1], [-2, 1], [-5, 1], [-8, 1], [-7, 2], [-4, 1], [-2, 1]] },
            { kind: 'passing', melody: [[5, 0.5], [3, 0.5], [1, 0.5], [-2, 0.5], [-5, 1], [-8, 1], [-7, 3], [null, 1]] },
        ],
    },
    phraseEnds: [{ bar: 7, ...DECEPTIVE, home: HOME }, { bar: 15, ...DECEPTIVE, home: HOME }],
    interlude: {
        chords: [
            'Bb', 'F', 'Gm', 'C', 'Bb', 'F', ['Gm', 'A'], 'Dm',
        ],
        melody: [
            [5, 2], [1, 2], [3, 2], [0, 2],
            [1, 2], [-2, 2], [-5, 4],
            [-4, 4], [0, 4],
            [-2, 2], [-5, 2], [-7, 4],
        ],
        counterNotes: [
            [-4, 4], [-12, 4], [-7, 4], [-9, 4],
            [-7, 4], [-9, 4], [-11, 2], [-12, 2], [-16, 4],
        ],
        bass: [
            [-23, 4], [-28, 4], [-26, 4], [-21, 4],
            [-23, 4], [-28, 4], [-26, 2], [-24, 2], [-31, 4],
        ],
    },
    tag: TAG,
    colour: { add9: null, borrowedIv: null, sixth: null },
    percussion: {
        forge: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        archive: [0, 0, 0, 0, 0, 0, 0, 0, 0.25, 0, 0, 0, 0, 0, 0, 0],
        mine: [0.3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        taskboard: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        observatory: [0.4, 0, 0, 0, 0, 0, 0, 0, 0.15, 0, 0, 0, 0, 0, 0, 0],
        portal: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.25, 0, 0, 0],
        command: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        harbor: [0, 0, 0, 0, 0.2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    },
});
