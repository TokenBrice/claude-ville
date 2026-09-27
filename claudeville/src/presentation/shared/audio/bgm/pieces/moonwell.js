// ── Moonwell ── a shorter night piece: the well square after dark, a
// darkened dulcimer over two harps.

import { DECEPTIVE, TAG, piece } from '../ScoreKit.js';

export default piece({
    name: 'moonwell', title: 'Moonwell', family: 'night', bpm: 70, beatsPerBar: 4, engine: 'arpQ',
    key: { tonic: 'A', mode: 'minor' }, phases: ['night'], feel: 'straight',
    arrangement: {
        lead: ['dulcimer', 0, { bright: 0.6 }], counter: ['harp', 0, { bright: 0.5 }],
        engine: ['harp', 0, { bright: 0.5 }], descant: ['fiddle', 0, { bright: 0.6 }],
        // The full band's descant is a bowed fiddle above the tune (MUSL-3: the
        // harp's range folds the written descant under it).
    },
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
});
