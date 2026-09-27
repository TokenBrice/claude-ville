// ── Lanternlight ── the Isle call in minor as a night waltz (MUS-5, as
// notated). A deceptive V→VI at bar 8→9 keeps the night open; one A5
// peak at bar 13. The music box over two darkened harps.

import { DECEPTIVE, TAG, piece } from '../ScoreKit.js';

export default piece({
    name: 'lanternlight', title: 'Lanternlight', family: 'night', bpm: 69, beatsPerBar: 3, engine: 'waltz',
    key: { tonic: 'A', mode: 'minor' }, phases: ['night'], feel: 'straight',
    arrangement: {
        lead: ['musicBox'], counter: ['harp', 0, { bright: 0.5 }],
        engine: ['harp', 0, { bright: 0.5 }], descant: ['harp', 0, { bright: 0.5 }],
    },
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
});
