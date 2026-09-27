// The songbook's kit (C3): the one chord table, the working bands, the
// workshop percussion voices, the cadence tables, the keys a piece may be
// written in and the `piece()` helper. Every piece lives in its own file
// under `pieces/` and imports only from here; `BgmSongbook.js` is the index.
//
// A piece is voicing-agnostic score data (MUS-17, MUSL-6):
//   name, title   the id and the display title (the Now line)
//   family        'day' | 'night'
//   key           `{ tonic, mode }`, one of `ALLOWED_KEYS[family]`; the
//                 sequencer publishes it to the MusicClock. The notes stay
//                 absolute (semitones from A4) whatever the key
//   phases        the Town band playlists the piece is in (`dawn`, `day`,
//                 `dusk`, `night`); a day piece is in `day`, a night piece
//                 in `night`
//   bpm, beatsPerBar
//                 4/4, 3/4 or 6/8 (`beatsPerBar: 6`: the beat is the eighth
//                 note, so `bpm` counts eighths)
//   chords        one per bar; a two-element array splits the bar in half
//   melody, counterNotes, bass, descantNotes
//                 [semitonesFromA4 | null, beats]; null is a rest. The counter
//                 is a guide-tone line under the tune; the descant (the full
//                 band's extra player) is a sixth above the tune's long notes
//   pickup        the first entry's upbeat, played once before bar 1
//   engine        the comp's figure (`ENGINES`): `arp8` eighth arpeggios,
//                 `arpQ` quarter arpeggios, `waltz` (3/4), `block2` block
//                 chords twice a bar (on the dotted quarters in 6/8), `jig`
//                 (6/8) a rolling arpeggio in threes; the sequencer voices
//                 each chord by nearest inversion (MUS-12)
//   feel          `FEELS`: `straight` plays the melody as written, `lilt`
//                 swings each on-beat pair of eighths 2:1, `dotted` 3:1
//                 (pitch-preserving, the lead of every pass; `applyFeel`)
//   arrangement   the Isle Band's players for this piece (C4): `{ lead,
//                 counter, engine, descant }`, each `[instrument,
//                 octaveShift?, overrides?]` in the Voicings row format
//   bands         score voices admitted per working band, rest → full
//                 (MUS-8, MUSL-3): each band adds a player (set by `piece()`)
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
//                 cadence after a wait (`cadenceKit(key, meter).deceptive`)
//   interlude     the piece's second half at 40–50 % melodic density, with a
//                 sustained counter and bass (6.7)
//   tag           two bars that replace the last bar when a visit ends
//                 (MUS-11: plagal close, `ritard` stretches the beat;
//                 `cadenceKit(key, meter).tag`)
//   colour        the season's cadence colour (MUS-16): replacement chords
//                 for the last two bars, or null where the tune forbids it
//   percussion    per workshop building, one weight per sixteenth of a beat
//                 (beatsPerBar × 4 steps); the Town band admits a stroke of
//                 the building's voice (`PERCUSSION_VOICE`) when a seeded
//                 draw falls under density × weight (6.9)
//
// No voice plays a quick same-pitch pair: that is the needs-you figure (S1).
// `scripts/audio/score-analyzer.mjs` checks every invariant this relies on.

export function deepFreeze(value) {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
        Object.freeze(value);
        for (const inner of Object.values(value)) deepFreeze(inner);
    }
    return value;
}

// ── chords ──

// The one chord table: voicings in semitones from A4, root position, the
// root in C3…B3. Every diatonic major and minor triad of the allowed keys (A,
// D and E major; A, D and E minor) with their dominants (E, A, B) and the
// secondary dominants (B for A major, E for D major, F♯ for E major and E
// minor). The diminished triads are left out: the routine cue roles put a
// perfect fifth over every root, a tritone against a diminished fifth.
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
    'G#m': [-13, -10, -6],
    'B': [-10, -6, -3],
    'F#': [-15, -11, -8],
    'Gm': [-14, -11, -7],
    'Bb': [-11, -7, -4],
    // Season colours (MUS-16) on each day tonic: an added ninth for spring,
    // a sixth for winter (a major seventh would put every routine cue a
    // semitone off).
    'Aadd9': [-12, -10, -8, -5],
    'A6': [-12, -8, -5, -3],
    'Dadd9': [-19, -17, -15, -12],
    'D6': [-19, -15, -12, -10],
    'Eadd9': [-17, -15, -13, -10],
    'E6': [-17, -13, -10, -8],
});

const mod12 = n => ((n % 12) + 12) % 12;
// Semitones from A4 → pitch class (C = 0).
const pitchClass = semi => mod12(9 + semi);

// A chord name as pitch classes (C = 0): `{ rootPc, pcs }`, root first.
export function chordPitchClasses(name) {
    const voicing = CHORDS[name];
    if (!voicing) return null;
    const pcs = voicing.map(pitchClass);
    return { rootPc: pcs[0], pcs };
}

// ── bands and percussion ──

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

// ── meters, engines, feels ──

// Beats per bar: 4/4, 3/4 and 6/8 (the eighth is the beat).
export const METERS = Object.freeze([4, 3, 6]);
export const ENGINES = Object.freeze(['arp8', 'arpQ', 'waltz', 'block2', 'jig']);
export const FEELS = Object.freeze(['straight', 'lilt', 'dotted']);
const FEEL_LONG = Object.freeze({ lilt: 2 / 3, dotted: 0.75 });
const EPS = 1e-6;

/**
 * Score notes `[[semi | null, beats]]` from a beat (a whole bar) played with
 * `feel`: each pair of eighths that starts on a beat becomes long–short
 * (`lilt` 2:1, `dotted` 3:1); pitches, rests and every other note are kept.
 * `straight` (or no feel) returns the notes as they are. Pure.
 */
export function applyFeel(notes, feel) {
    const long = FEEL_LONG[feel];
    if (!long || !notes) return notes;
    const out = notes.map(note => [...note]);
    let beat = 0;
    for (let i = 0; i < out.length; i++) {
        const a = out[i];
        const b = out[i + 1];
        if (b && a[0] != null && b[0] != null && Math.abs(a[1] - 0.5) < EPS && Math.abs(b[1] - 0.5) < EPS
            && Math.abs(beat - Math.round(beat)) < EPS) {
            a[1] = long;
            b[1] = 1 - long;
            beat += 1;
            i++;
            continue;
        }
        beat += a[1];
    }
    return out;
}

// ── ranges ──

// Ranges (semitones from A4), absolute whatever the key. Leads stay in
// A3…A5 (MUS-5's E4–A5 plus the lullabies' low tonic); night leads sound at
// the written octave, never above A5 (MUSL-4); the bass stays in C2…D4
// (Millwheel's octave bounce reaches D4) and under the lead; counter lines
// stay in E3…A4 and between.
export const RANGES = Object.freeze({
    lead: Object.freeze({ low: -12, high: 12 }),
    nightLeadHigh: 12,
    bass: Object.freeze({ low: -33, high: -7 }),
    counter: Object.freeze({ low: -17, high: 0 }),
});

// ── keys ──

const NOTE_NAMES = Object.freeze(['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'Bb', 'B']);
const NOTE_PC = Object.freeze({ ...Object.fromEntries(NOTE_NAMES.map((name, pc) => [name, pc])), 'A#': 10 });
const SCALE_STEPS = Object.freeze({
    major: Object.freeze([0, 2, 4, 5, 7, 9, 11]),
    minor: Object.freeze([0, 2, 3, 5, 7, 8, 10]),
});

// The signal cues' fixed pitch classes: they are never moved to the chord
// (CueKit `signal`), so a key must hold them. The ship's bell's E5, the
// cracked bell's E4 → A3, the Signals answer on A4, the escapement's A5
// body: A and E. `audio-score-analyzer.test.mjs` reads them back from the
// cues CueKit strikes.
export const SIGNAL_PITCH_CLASSES = Object.freeze([9, 4]);
const KEY_CANDIDATES = Object.freeze({
    day: Object.freeze(['A', 'D', 'E'].map(tonic => Object.freeze({ tonic, mode: 'major' }))),
    night: Object.freeze(['A', 'D', 'E'].map(tonic => Object.freeze({ tonic, mode: 'minor' }))),
});

/** A key `{ tonic, mode }` as the MusicClock reads it: `{ tonicPc, mode }` (C = 0). */
export function musicKey(key) {
    return { tonicPc: NOTE_PC[key?.tonic] ?? 9, mode: key?.mode === 'minor' ? 'minor' : 'major' };
}

/** The pitch classes of a key's scale (natural minor for `minor`). */
export function scalePitchClasses(key) {
    const { tonicPc, mode } = musicKey(key);
    return SCALE_STEPS[mode].map(step => mod12(tonicPc + step));
}

/** The tonic chord's name in `CHORDS`: 'A', 'Dm', 'E' … */
export function tonicChord(key) {
    return `${key.tonic}${key.mode === 'minor' ? 'm' : ''}`;
}

// The keys a piece of each family may be written in: the candidates whose
// scale holds every signal pitch class.
export const ALLOWED_KEYS = Object.freeze(Object.fromEntries(Object.entries(KEY_CANDIDATES).map(([family, keys]) => [
    family,
    Object.freeze(keys.filter(key => SIGNAL_PITCH_CLASSES.every(pc => scalePitchClasses(key).includes(pc)))),
])));

export function keyAllowed(family, key) {
    return (ALLOWED_KEYS[family] || []).some(k => k.tonic === key?.tonic && k.mode === key?.mode);
}

// ── cadences (in A) ──

// The waiting cadence (MUS-9): V → vi by day (F♯2 then B2 walking back to
// A), V → VI at night; only the chord and the bass change. The landing after
// a wait is the motif's home phrase, E C♯ B A (E C B A in minor), over the
// tonic with its third, then its fifth, in the bass (a root under the E or
// the A would move in parallel with the tune). 6/8 counts eighths.
export const DECEPTIVE = deepFreeze({
    day: {
        chord: 'F#m', bass: [[-27, 2], [-22, 2]],
        home: { melody: [[7, 1], [4, 0.5], [2, 0.5], [0, 2]], bass: [[-20, 2], [-17, 2]] },
    },
    night: {
        chord: 'F', bass: [[-28, 4]],
        home: { melody: [[7, 1], [3, 0.5], [2, 0.5], [0, 2]], bass: [[-21, 2], [-17, 2]] },
    },
    waltz: {
        chord: 'F', bass: [[-28, 3]],
        home: { melody: [[7, 1], [3, 0.5], [2, 0.5], [0, 1]], bass: [[-21, 1], [-17, 2]] },
    },
    dayWaltz: {
        chord: 'F#m', bass: [[-27, 3]],
        home: { melody: [[7, 1], [4, 0.5], [2, 0.5], [0, 1]], bass: [[-20, 1], [-17, 2]] },
    },
    jig: {
        chord: 'F#m', bass: [[-27, 3], [-22, 3]],
        home: { melody: [[7, 1], [4, 1], [2, 1], [0, 3]], bass: [[-20, 3], [-17, 3]] },
    },
    nightJig: {
        chord: 'F', bass: [[-28, 6]],
        home: { melody: [[7, 1], [3, 1], [2, 1], [0, 3]], bass: [[-21, 3], [-17, 3]] },
    },
});

// Piece exits (MUS-11): I–IV | I by day, i–iv | i at night, IV | I and
// iv | i in 3/4; 6/8 splits the first bar on its dotted quarters.
export const TAG = deepFreeze({
    day: { chords: [['A', 'D'], 'A'], melody: [[4, 2], [9, 1], [5, 1], [0, 4]], bass: [[-24, 2], [-19, 2], [-24, 4]], ritard: 1.15 },
    night: { chords: [['Am', 'Dm'], 'Am'], melody: [[3, 2], [8, 1], [5, 1], [0, 4]], bass: [[-24, 2], [-19, 2], [-24, 4]], ritard: 1.15 },
    waltz: { chords: ['Dm', 'Am'], melody: [[8, 2], [5, 1], [0, 3]], bass: [[-19, 3], [-24, 3]], ritard: 1.15 },
    dayWaltz: { chords: ['D', 'A'], melody: [[9, 2], [5, 1], [0, 3]], bass: [[-19, 3], [-24, 3]], ritard: 1.15 },
    jig: { chords: [['A', 'D'], 'A'], melody: [[4, 3], [9, 2], [5, 1], [0, 6]], bass: [[-24, 3], [-19, 3], [-24, 6]], ritard: 1.15 },
    nightJig: { chords: [['Am', 'Dm'], 'Am'], melody: [[3, 3], [8, 2], [5, 1], [0, 6]], bass: [[-24, 3], [-19, 3], [-24, 6]], ritard: 1.15 },
});

const CADENCE_ROW = Object.freeze({
    'major:4': 'day', 'minor:4': 'night',
    'major:3': 'dayWaltz', 'minor:3': 'waltz',
    'major:6': 'jig', 'minor:6': 'nightJig',
});

function transposeChord(name, shift) {
    const [, root, suffix] = /^([A-G][#b]?)(.*)$/.exec(name) || [];
    const moved = `${NOTE_NAMES[mod12(NOTE_PC[root] + shift)]}${suffix}`;
    if (!CHORDS[moved]) throw new Error(`cadenceKit: ${name} moved by ${shift} is ${moved}, not in CHORDS`);
    return moved;
}

// A line moved by the key's pitch-class shift, in the octave nearest its
// written one that keeps every note inside `[low, high]`.
function transposeLine(notes, shift, low, high, label) {
    for (const s of [shift, shift - 12, shift + 12].sort((a, b) => Math.abs(a) - Math.abs(b))) {
        const moved = notes.map(([semi, beats]) => [semi == null ? null : semi + s, beats]);
        if (moved.every(([semi]) => semi == null || (semi >= low && semi <= high))) return moved;
    }
    throw new Error(`cadenceKit: ${label} moved by ${shift} leaves ${low}…${high}`);
}

/**
 * The tag and the waiting cadence of a piece in `key` and `meter` (beats
 * per bar): the A tables moved to the key's tonic, each line in the octave
 * that keeps it inside `RANGES`. `{ tag, deceptive }`, where `deceptive` is
 * what a phrase end spreads (`{ bar, ...deceptive }`). A piece may still
 * write its own.
 */
export function cadenceKit(key, meter = 4) {
    const { mode } = musicKey(key);
    const row = CADENCE_ROW[`${mode}:${meter}`];
    if (!row) throw new RangeError(`cadenceKit: no cadence for ${mode} in ${meter} beats`);
    const shift = mod12(musicKey(key).tonicPc - 9);
    const lead = [RANGES.lead.low, mode === 'minor' ? RANGES.nightLeadHigh : RANGES.lead.high];
    const bass = [RANGES.bass.low, RANGES.bass.high];
    const tag = TAG[row];
    const deceptive = DECEPTIVE[row];
    const chords = entry => (Array.isArray(entry) ? entry.map(name => transposeChord(name, shift)) : transposeChord(entry, shift));
    return deepFreeze({
        tag: {
            chords: tag.chords.map(chords),
            melody: transposeLine(tag.melody, shift, ...lead, 'tag melody'),
            bass: transposeLine(tag.bass, shift, ...bass, 'tag bass'),
            ritard: tag.ritard,
        },
        deceptive: {
            chord: transposeChord(deceptive.chord, shift),
            bass: transposeLine(deceptive.bass, shift, ...bass, 'deceptive bass'),
            home: {
                melody: transposeLine(deceptive.home.melody, shift, ...lead, 'home melody'),
                bass: transposeLine(deceptive.home.bass, shift, ...bass, 'home bass'),
            },
        },
    });
}

// ── pieces ──

// The notes of `notes` in [from, to) beats; a note across either edge is an
// authoring error (a cell is whole bars).
function sliceBeats(notes, from, to, label) {
    const out = [];
    let at = 0;
    for (const note of notes) {
        const end = at + note[1];
        if (at >= from - 1e-9 && end <= to + 1e-9) out.push(note);
        else if (at < to - 1e-9 && end > from + 1e-9) throw new Error(`ScoreKit: ${label} crosses a cell edge at beat ${at}`);
        at = end;
    }
    return out;
}

const SLOT_BARS = 2;

// A piece as written plus its cells: the canonical cut of every slot, then
// the authored variants (sharing the slot's chords, bass and counter).
export function piece({ variations, ...def }) {
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
