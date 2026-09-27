// ── Maypole ── a spring-green ring dance in D, a bright day waltz. The
// hook circles D5 (D E D C♯ D) and lifts to E5; its answer circles B4 a
// third lower. Bar 7 turns the waltz into a hemiola (two dotted quarters,
// Em | A) before the cadence. The B section is a rising sequence (Em F♯m
// G A): the same turn a step higher each bar over a counter that walks
// down, back to the hook. The hammered dulcimer over the fiddle and the
// harp's waltz, a whistle descant.

import { cadenceKit, piece } from '../ScoreKit.js';

const KEY = Object.freeze({ tonic: 'D', mode: 'major' });
const { tag, deceptive } = cadenceKit(KEY, 3);

export default piece({
    name: 'maypole', title: 'Maypole', family: 'day', bpm: 138, beatsPerBar: 3, engine: 'waltz',
    key: KEY, phases: ['dawn', 'day'], feel: 'straight',
    arrangement: { lead: ['dulcimer'], counter: ['fiddle'], engine: ['harp'], descant: ['whistle'] },
    pickup: [[0, 1]],
    chords: [
        'D', 'A', 'G', 'D', 'D', 'A', ['Em', 'A'], 'D',
        'Em', 'F#m', 'G', 'A', 'D', 'A', ['Em', 'A'], 'D',
    ],
    melody: [
        [5, 1], [7, 0.5], [5, 0.5], [4, 0.5], [5, 0.5],
        [7, 2], [4, 1],
        [2, 1], [4, 0.5], [2, 0.5], [0, 0.5], [2, 0.5],
        [0, 2], [4, 1],
        [5, 1], [7, 0.5], [5, 0.5], [4, 0.5], [5, 0.5],
        [7, 2], [4, 1],
        [10, 1], [9, 0.5], [7, 1], [4, 0.5],
        [5, 2], [0, 1],
        [-2, 1], [0, 0.5], [-2, 0.5], [2, 1],
        [0, 1], [2, 0.5], [0, 0.5], [4, 1],
        [2, 1], [4, 0.5], [2, 0.5], [5, 1],
        [4, 1], [5, 0.5], [4, 0.5], [7, 1],
        [5, 1], [7, 0.5], [5, 0.5], [4, 0.5], [5, 0.5],
        [7, 2], [4, 1],
        [10, 1], [9, 0.5], [7, 1], [4, 0.5],
        [5, 2], [0, 1],
    ],
    counterNotes: [
        [-3, 3], [-2, 3],
        [-2, 3], [-3, 3],
        [-3, 3], [-2, 3],
        [-5, 3], [-3, 3],
        [-7, 3], [-8, 3],
        [-10, 3], [-12, 3],
        [-3, 3], [-2, 3],
        [-5, 3], [-3, 3],
    ],
    bass: [
        [-19, 3], [-24, 3],
        [-26, 3], [-19, 3],
        [-19, 3], [-24, 3],
        [-29, 1.5], [-24, 1.5], [-19, 3],
        [-29, 3], [-27, 3],
        [-26, 3], [-24, 3],
        [-19, 3], [-24, 3],
        [-29, 1.5], [-24, 1.5], [-19, 3],
    ],
    descantNotes: [
        [9, 3], [16, 2], [12, 1],
        [10, 3], [9, 2], [12, 1],
        [9, 3], [16, 2], [12, 1],
        [19, 1.5], [16, 1.5], [9, 3],
        [10, 3], [12, 3],
        [14, 3], [16, 3],
        [9, 3], [16, 2], [12, 1],
        [19, 1.5], [16, 1.5], [9, 3],
    ],
    grammar: ['a', 'b', 'a', 'c', 'd', 'e', 'a', 'c'],
    variations: {
        a: [
            { kind: 'upper', melody: [[5, 1], [7, 0.5], [9, 0.5], [7, 0.5], [5, 0.5], [7, 2], [4, 1]] },
            { kind: 'turn', melody: [[5, 1.5], [7, 0.5], [5, 0.5], [4, 0.5], [7, 1], [9, 0.5], [7, 0.5], [4, 1]] },
        ],
        b: [
            { kind: 'passing', melody: [[2, 1], [5, 0.5], [4, 0.5], [2, 1], [0, 2], [4, 1]] },
            { kind: 'turn', melody: [[2, 1.5], [4, 0.5], [2, 1], [0, 1], [2, 0.5], [0, 0.5], [4, 1]] },
        ],
        c: [
            { kind: 'hemiola', melody: [[10, 1.5], [7, 1.5], [5, 2], [0, 1]] },
            { kind: 'upper', melody: [[10, 1], [12, 0.5], [9, 1], [7, 0.5], [5, 2], [0, 1]] },
        ],
        d: [
            { kind: 'anticipate', melody: [[-2, 1.5], [0, 0.5], [2, 1], [0, 1.5], [2, 0.5], [4, 1]] },
            { kind: 'turn', melody: [[-2, 1], [2, 0.5], [0, 0.5], [-2, 0.5], [2, 0.5], [0, 1], [4, 0.5], [2, 0.5], [0, 0.5], [4, 0.5]] },
        ],
        e: [
            { kind: 'anticipate', melody: [[2, 1.5], [4, 0.5], [5, 1], [4, 1.5], [5, 0.5], [7, 1]] },
            { kind: 'climb', melody: [[2, 1], [4, 0.5], [5, 0.5], [7, 1], [9, 2], [7, 1]] },
        ],
    },
    phraseEnds: [{ bar: 7, ...deceptive }, { bar: 15, ...deceptive }],
    interlude: {
        chords: [
            'Em', 'F#m', 'G', 'A', 'D', 'A', ['Em', 'A'], 'D',
        ],
        melody: [
            [-2, 2], [2, 1],
            [0, 2], [4, 1],
            [2, 2], [5, 1],
            [4, 3],
            [5, 3],
            [7, 3],
            [10, 1.5], [7, 1.5],
            [5, 3],
        ],
        counterNotes: [
            [-7, 3], [-8, 3], [-10, 3], [-12, 3],
            [-3, 3], [-2, 3], [-5, 3], [-3, 3],
        ],
        bass: [
            [-29, 3], [-27, 3], [-26, 3], [-24, 3],
            [-19, 3], [-24, 3], [-29, 1.5], [-24, 1.5], [-19, 3],
        ],
    },
    tag,
    // No borrowed iv: bar 15 has no IV, and a Gm for the ii would rub its B♭
    // against the hemiola's F♯5.
    colour: { add9: { chords: [['Em', 'A'], 'Dadd9'] }, borrowedIv: null, sixth: { chords: [['Em', 'A'], 'D6'] } },
    percussion: {
        forge: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        archive: [0.8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        mine: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        taskboard: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        observatory: [0, 0, 0, 0, 0.7, 0, 0, 0, 0.7, 0, 0, 0],
        portal: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        command: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        harbor: [0.7, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    },
});
