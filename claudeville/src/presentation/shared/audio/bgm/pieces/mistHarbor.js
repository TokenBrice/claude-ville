// ── Mist Harbor ── boats rocking in fog: a barcarolle-waltz in E minor
// over the falling i–VII–VI–V, each phrase a wide arpeggio rise that sinks
// back by step. The B section turns to G major (two chords to the bar) and
// slides home by D → Em. The harp over a long-bowed fiddle and the
// dulcimer's waltz.

import { cadenceKit, piece } from '../ScoreKit.js';

const KEY = { tonic: 'E', mode: 'minor' };
const { tag, deceptive } = cadenceKit(KEY, 3);

export default piece({
    name: 'mistHarbor', title: 'Mist Harbor', family: 'night', bpm: 66, beatsPerBar: 3, engine: 'waltz',
    key: KEY, phases: ['night'], feel: 'straight',
    arrangement: {
        lead: ['harp', 0, { bright: 0.6 }], counter: ['fiddle', 0, { bright: 0.55 }],
        engine: ['dulcimer', 0, { bright: 0.5 }], descant: ['whistle', 0, { bright: 0.6 }],
        // The full band's descant is a whistle in the fog above the tune (MUSL-3: the
        // harp's range folds the written descant under it).
    },
    pickup: [[-10, 1]],
    chords: [
        'Em', 'D', 'C', 'B', 'Em', 'D', ['Am', 'B'], 'Em',
        'G', ['D', 'G'], 'C', ['Am', 'D'], 'Em', 'D', ['Am', 'B'], 'Em',
    ],
    melody: [
        [-5, 1], [2, 1], [10, 1],
        [9, 1.5], [7, 0.5], [5, 1],
        [-2, 1], [3, 1], [7, 1],
        [6, 2], [2, 1],
        [-5, 1], [2, 1], [10, 1],
        [9, 1.5], [7, 0.5], [5, 1],
        [3, 1.5], [2, 1], [0, 0.5],
        [-2, 2], [-5, 1],
        [2, 1], [5, 1], [10, 1],
        [12, 1], [9, 0.5], [10, 1.5],
        [7, 2], [5, 1],
        [3, 1], [2, 0.5], [0, 1], [-3, 0.5],
        [-5, 1], [2, 1], [10, 1],
        [9, 1.5], [7, 0.5], [5, 1],
        [3, 1.5], [2, 1], [0, 0.5],
        [-2, 2], [-5, 1],
    ],
    counterNotes: [
        [-10, 6],
        [-5, 3], [-6, 3],
        [-10, 6],
        [-9, 1.5], [-10, 1.5], [-14, 3],
        [-10, 3], [-12, 1.5], [-10, 1.5],
        [-5, 3], [-9, 3],
        [-10, 6],
        [-9, 1.5], [-10, 1.5], [-14, 3],
    ],
    bass: [
        [-29, 3], [-19, 3],
        [-21, 3], [-22, 3],
        [-29, 3], [-19, 3],
        [-24, 1.5], [-22, 1.5], [-29, 3],
        [-26, 3], [-19, 1.5], [-26, 1.5],
        [-21, 3], [-24, 1.5], [-19, 1.5],
        [-29, 3], [-19, 3],
        [-24, 1.5], [-22, 1.5], [-29, 3],
    ],
    descantNotes: [
        [7, 2], [19, 1], [14, 1.5], [12, 1.5],
        [7, 2], [15, 1], [9, 3],
        [7, 2], [19, 1], [14, 1.5], [12, 1.5],
        [12, 1.5], [9, 1.5], [7, 3],
        [14, 2], [19, 1], [17, 3],
        [15, 4.5], [9, 1.5],
        [7, 2], [19, 1], [14, 1.5], [12, 1.5],
        [12, 1.5], [9, 1.5], [7, 3],
    ],
    grammar: ['a1', 'a2', 'a1', 'a3', 'b1', 'b2', 'a1', 'a3'],
    variations: {
        a1: [
            { kind: 'passing', melody: [[-5, 1], [2, 1], [7, 0.5], [10, 0.5], [9, 1.5], [7, 0.5], [5, 1]] },
            { kind: 'suspension', melody: [[-5, 1], [2, 1], [10, 1.5], [9, 1], [7, 0.5], [5, 1]] },
        ],
        a2: [
            { kind: 'passing', melody: [[-2, 0.5], [0, 0.5], [3, 1], [7, 1], [6, 2], [2, 1]] },
            { kind: 'dotted', melody: [[-2, 1.5], [3, 0.5], [7, 1], [6, 2], [2, 1]] },
        ],
        a3: [
            { kind: 'passing', melody: [[3, 1], [5, 0.5], [2, 1], [0, 0.5], [-2, 2], [-5, 1]] },
            { kind: 'turn', melody: [[3, 1.5], [2, 1], [0, 0.5], [-2, 1.5], [-3, 0.5], [-5, 1]] },
        ],
        b1: [
            { kind: 'passing', melody: [[2, 1], [5, 1], [7, 0.5], [10, 0.5], [12, 1], [9, 0.5], [10, 1.5]] },
            { kind: 'dotted', melody: [[2, 1.5], [5, 0.5], [10, 1], [12, 1], [9, 0.5], [10, 1.5]] },
        ],
        b2: [
            { kind: 'lengthen', melody: [[7, 1.5], [5, 1.5], [3, 1], [2, 0.5], [0, 1], [-3, 0.5]] },
            { kind: 'passing', melody: [[7, 2], [5, 1], [3, 1], [2, 0.5], [0, 0.5], [-2, 0.5], [-3, 0.5]] },
        ],
    },
    phraseEnds: [{ bar: 7, ...deceptive }, { bar: 15, ...deceptive }],
    interlude: {
        chords: [
            'G', ['D', 'G'], 'C', ['Am', 'D'], 'Em', 'D', ['Am', 'B'], 'Em',
        ],
        melody: [
            [2, 3], [9, 1.5], [10, 1.5],
            [7, 3], [3, 3],
            [2, 3], [5, 3],
            [3, 1.5], [2, 1.5], [-2, 3],
        ],
        counterNotes: [
            [-10, 6], [-5, 3], [-9, 3],
            [-10, 3], [-12, 3], [-9, 1.5], [-10, 1.5], [-14, 3],
        ],
        bass: [
            [-26, 3], [-19, 1.5], [-26, 1.5], [-21, 3], [-24, 1.5], [-19, 1.5],
            [-29, 3], [-19, 3], [-24, 1.5], [-22, 1.5], [-29, 3],
        ],
    },
    tag,
    colour: { add9: null, borrowedIv: null, sixth: null },
    percussion: {
        forge: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        archive: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        mine: [0.15, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        taskboard: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        observatory: [0, 0, 0, 0, 0.25, 0, 0, 0, 0, 0, 0, 0],
        portal: [0, 0, 0, 0, 0, 0, 0, 0, 0.2, 0, 0, 0],
        command: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        harbor: [0.3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    },
});
