// The village's signature motif (plan D9): a cell from Willowbrook's opening,
// read from the songbook itself so the cue quotes can never drift from the
// tune the band plays. Cues quote it as key degrees, so a key change (MUS-10)
// moves the quote with the key, and no signal cue ever uses it (S1).
//
// Willowbrook bar 1 is the call — A4 C♯5 E5 (1½ beats) C♯5 — the A–C♯–E
// arpeggio; bar 2 answers it stepwise from B4. The derived figures:
//   * arrival: the cell's leap, its first note to its peak (1 → 5), rung as
//     the routine chime's chord roles `root` → `fifth` (the pitches an
//     arrival has always had with no music);
//   * aurora: the whole call on glass, in the song's register and rhythm;
//   * the hour phrase: the cell's answer — the call's close from its peak
//     (E → C♯), into the answer's first note (B), home to the tonic — on the
//     tower bell, an octave below the song at the tower's slower tempo. The
//     answer's G♯ is left out: it is outside the pentatonic that scenery
//     fundamentals come from (S1 tuning), so the phrase resolves straight home.

import { PIECES } from './bgm/BgmSongbook.js';

const SOURCE = 'willowbrook';
const BEATS_PER_BAR = 4;

// Semitones from A4 → a major-key degree over A (1 = A, 3 = C♯, 5 = E …).
const MAJOR_DEGREE_BY_STEP = Object.freeze({ 0: 1, 2: 2, 4: 3, 5: 4, 7: 5, 9: 6, 11: 7 });

function degreeOf(semi) {
    const step = ((semi % 12) + 12) % 12;
    const degree = MAJOR_DEGREE_BY_STEP[step];
    if (degree == null) return null;
    return { degree, octave: Math.floor(semi / 12) };
}

// The melody's notes in [fromBeat, toBeat) as `{ semi, beat, beats }`.
function melodyBars(piece, fromBar, toBar) {
    const notes = [];
    let beat = 0;
    for (const [semi, beats] of piece.melody) {
        if (beat >= toBar * BEATS_PER_BAR) break;
        if (beat >= fromBar * BEATS_PER_BAR && semi != null) {
            notes.push(Object.freeze({ semi, beat: beat - fromBar * BEATS_PER_BAR, beats }));
        }
        beat += beats;
    }
    return Object.freeze(notes);
}

const piece = PIECES.find(entry => entry.name === SOURCE);
if (!piece) throw new Error(`Motifs: the songbook has no ${SOURCE}`);

// The call (bar 1) and its answer (bar 2), as written: semitones from A4 and
// beats from the bar's downbeat.
export const MOTIF_CELL = Object.freeze({
    source: SOURCE,
    bpm: piece.bpm,
    call: melodyBars(piece, 0, 1),
    answer: melodyBars(piece, 1, 2),
});

const beatMs = bpm => 60000 / bpm;

// A figure: `notes: [{ degree, octave, atMs }]`, key degrees (octave 0 = the
// octave from the tonic nearest A4).
function figure(notes) {
    return Object.freeze({ notes: Object.freeze(notes.map(note => Object.freeze(note))) });
}

const call = MOTIF_CELL.call;
const peakIndex = call.reduce((best, note, i) => (note.semi > call[best].semi ? i : best), 0);

// Arrival: the cell's leap, first note → peak (1 → 5).
export const ARRIVAL_LEAP = Object.freeze({
    from: degreeOf(call[0].semi).degree,
    to: degreeOf(call[peakIndex].semi).degree,
});

// Aurora: the whole call on glass, in the song's register and rhythm.
export const AURORA_FIGURE = figure(call.map(note => ({
    ...degreeOf(note.semi),
    atMs: Math.round(note.beat * beatMs(MOTIF_CELL.bpm)),
})));

// The hour phrase: the call's close from its peak, the answer's first note,
// then home — an octave down, at the tower's tempo, each note keeping the
// song's duration.
export const HOUR_TEMPO_BPM = 72;
export const HOUR_FIGURE = (() => {
    const run = [...call.slice(peakIndex), MOTIF_CELL.answer[0]];
    const notes = [];
    let beat = 0;
    for (const note of run) {
        const { degree, octave } = degreeOf(note.semi);
        notes.push({ degree, octave: octave - 1, atMs: Math.round(beat * beatMs(HOUR_TEMPO_BPM)) });
        beat += note.beats;
    }
    notes.push({ degree: 1, octave: -1, atMs: Math.round(beat * beatMs(HOUR_TEMPO_BPM)) });
    return figure(notes);
})();
