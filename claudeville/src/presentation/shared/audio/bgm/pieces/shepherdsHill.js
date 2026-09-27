// ── Shepherd's Hill ── a pastoral air on the hills above the village, in
// E and unhurried. The hook leaps a sixth (E4 → C♯5) and settles down the
// pentatonic scale (C♯ B G♯ F♯) on long notes; the answer climbs back to a
// held B4. The counter is a drone through the A section (the tonic, then
// the fifth) and a guide-tone line elsewhere; the second climb (bar 13)
// leaps a sixth again, to the G♯5 peak. The whistle over the concertina's
// drone and the harp's block chords, dotted; a fiddle descant.

import { cadenceKit, piece } from '../ScoreKit.js';

const KEY = Object.freeze({ tonic: 'E', mode: 'major' });
const { tag, deceptive } = cadenceKit(KEY, 4);

export default piece({
    name: 'shepherdsHill', title: "Shepherd's Hill", family: 'day', bpm: 76, beatsPerBar: 4, engine: 'block2',
    key: KEY, phases: ['dawn', 'day'], feel: 'dotted',
    arrangement: { lead: ['whistle'], counter: ['concertina'], engine: ['harp'], descant: ['fiddle'] },
    pickup: [[-10, 1]],
    chords: [
        'E', 'C#m', 'A', 'B', 'C#m', 'F#m', ['A', 'B'], 'E',
        'E', 'C#m', 'A', 'B', 'C#m', 'G#m', ['A', 'B'], 'E',
    ],
    melody: [
        [-5, 1], [4, 2], [2, 1],
        [-1, 3], [-3, 1],
        [-5, 1], [-3, 0.5], [0, 0.5], [4, 2],
        [2, 4],
        [4, 1.5], [2, 0.5], [4, 1], [7, 1],
        [9, 2], [7, 1], [4, 1],
        [7, 2], [6, 1], [9, 1],
        [7, 3], [null, 1],
        [-5, 1], [4, 2], [2, 1],
        [-1, 3], [-3, 1],
        [-5, 1], [-3, 0.5], [0, 0.5], [4, 2],
        [2, 4],
        [-1, 1], [7, 2], [9, 0.5], [7, 0.5],
        [11, 3], [9, 1],
        [7, 2], [6, 1], [9, 1],
        [7, 3], [null, 1],
    ],
    counterNotes: [
        [-5, 4], [-5, 4],
        [-10, 4], [-10, 4],
        [-1, 4], [0, 2], [-5, 2],
        [-5, 2], [-10, 2], [-1, 4],
        [-5, 4], [-5, 4],
        [-10, 4], [-10, 4],
        [-5, 4], [-10, 2], [-6, 2],
        [-5, 2], [-10, 2], [-1, 4],
    ],
    bass: [
        [-29, 2], [-22, 2], [-20, 2], [-25, 2],
        [-24, 2], [-17, 2], [-22, 4],
        [-29, 2], [-25, 2], [-27, 2], [-20, 2],
        [-24, 2], [-22, 2], [-29, 2], [-22, 2],
        [-29, 2], [-22, 2], [-20, 2], [-25, 2],
        [-24, 2], [-17, 2], [-22, 4],
        [-20, 2], [-25, 2], [-25, 4],
        [-24, 2], [-22, 2], [-29, 2], [-22, 2],
    ],
    descantNotes: [
        [null, 1], [11, 3], [7, 4],
        [null, 2], [12, 2], [11, 4],
        [16, 2], [11, 2], [16, 2], [12, 2],
        [12, 2], [11, 1], [14, 1], [11, 3], [null, 1],
        [null, 1], [11, 3], [7, 4],
        [null, 2], [12, 2], [11, 4],
        [7, 1], [16, 3], [14, 4],
        [12, 2], [11, 1], [14, 1], [11, 3], [null, 1],
    ],
    grammar: ['a', 'b', 'c', 'd', 'a', 'b', 'e', 'd'],
    variations: {
        a: [
            { kind: 'dotted', melody: [[-5, 1], [4, 2], [2, 0.5], [4, 0.5], [-1, 3], [-3, 1]] },
            { kind: 'passing', melody: [[-5, 1], [4, 2], [2, 1], [-1, 2], [2, 0.5], [-1, 0.5], [-3, 1]] },
        ],
        b: [
            { kind: 'dotted', melody: [[-5, 1], [-3, 0.5], [0, 0.5], [4, 1], [2, 0.5], [4, 0.5], [2, 4]] },
            { kind: 'anticipate', melody: [[-5, 1.5], [-3, 0.5], [0, 1], [4, 1], [2, 3], [6, 1]] },
        ],
        c: [
            { kind: 'dotted', melody: [[4, 1], [2, 0.5], [4, 0.5], [7, 2], [9, 1], [11, 1], [7, 1], [4, 1]] },
            { kind: 'anticipate', melody: [[4, 1.5], [2, 0.5], [7, 2], [9, 3], [4, 1]] },
        ],
        d: [
            { kind: 'lower', melody: [[7, 2], [6, 1], [9, 1], [7, 2], [-1, 1], [null, 1]] },
            { kind: 'dotted', melody: [[7, 2], [6, 0.5], [9, 0.5], [11, 1], [7, 3], [null, 1]] },
        ],
        e: [
            { kind: 'dotted', melody: [[-1, 1], [7, 2], [4, 0.5], [7, 0.5], [11, 2], [9, 1], [6, 1]] },
            { kind: 'passing', melody: [[-1, 1.5], [2, 0.5], [7, 2], [11, 3], [9, 1]] },
        ],
    },
    phraseEnds: [{ bar: 7, ...deceptive }, { bar: 15, ...deceptive }],
    interlude: {
        chords: [
            'E', 'C#m', 'A', 'B', 'C#m', 'G#m', ['A', 'B'], 'E',
        ],
        melody: [
            [-5, 1], [4, 3],
            [-1, 4],
            [4, 4],
            [2, 4],
            [7, 4],
            [11, 4],
            [7, 2], [6, 2],
            [7, 4],
        ],
        counterNotes: [
            [-5, 4], [-5, 4], [-5, 4], [-10, 4],
            [-1, 4], [-10, 4], [-5, 2], [-10, 2], [-1, 4],
        ],
        bass: [
            [-29, 4], [-20, 4], [-24, 4], [-22, 4],
            [-20, 4], [-25, 4], [-24, 2], [-22, 2], [-29, 4],
        ],
    },
    tag,
    // Autumn's borrowed iv (Am) under bar 15's E5.
    colour: { add9: { chords: [['A', 'B'], 'Eadd9'] }, borrowedIv: { chords: [['Am', 'B'], 'E'] }, sixth: { chords: [['A', 'B'], 'E6'] } },
    percussion: {
        forge: [0, 0, 0, 0, 0.4, 0, 0, 0, 0, 0, 0, 0, 0.4, 0, 0, 0],
        archive: [0.6, 0, 0, 0, 0, 0, 0, 0, 0.6, 0, 0, 0, 0, 0, 0, 0],
        mine: [0.35, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        taskboard: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        observatory: [0, 0, 0, 0, 0.6, 0, 0, 0, 0, 0, 0, 0, 0.9, 0, 0, 0],
        portal: [0, 0, 0, 0, 0.6, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        command: [0.6, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        harbor: [0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0],
    },
});
