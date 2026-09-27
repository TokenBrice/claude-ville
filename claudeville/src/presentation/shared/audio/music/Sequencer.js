// The one music sequencer (plan 2.3, Wave 6): the Town band. It plays the
// songbook on the Transport; `Voicings.js` seats the players and
// `Instruments.js` plays each note.
//
//   A time-of-day playlist of pieces (6.7), each visited for two loops and
//   closed by its tag, then a true 1.4 s breath before the next pickup. The
//   rotation is a shuffle bag (C7): each round plays the phase's whole
//   playlist once in a seeded order, a new round never opens on the piece
//   that just played, and none comes back within 6 min of its end once the
//   set has ≥ 4 pieces (4 min below that). Every INTERLUDE_EVERY visits the
//   band plays the last piece's 8-bar interlude cell (MUS-6/MUS-7) at
//   40–50 % density instead.
//   Expected interlude share from these constants: one 8-bar interlude
//   (≈ 23 s at 84 bpm) per 3–4 visits of two 16-bar loops (≈ 95 s each)
//   ≈ 6–8 % of the hour (target ≤ 15 %).
//
// A rendition is compiled per loop from the piece's grammar of 2-bar cells
// (MUS-6): the first pass of a piece in an hour is canonical, later passes
// vary cell by cell from the `choice` stream, and no 16-bar tuple repeats
// within 60 min. The lead of every pass plays with the piece's `feel`
// (straight, lilt or dotted). Each four-bar chunk is compiled when it
// opens, with what is in force then: the working band (MUSL-3), the
// arrangement (the piece's own players, weather, season, keyframe →
// voicing, C4, MUS-16/MUSL-8), the voice (isle or chip, D2) and the waiting
// cadence (MUS-9: while someone waits each phrase end turns V→vi with only
// the bass and chord changing; the next cadence after the answer lands home
// on the `home` figure). The comp is voiced by nearest inversion (MUS-12).
// Percussion (6.9, D4) admits a hit per building and step when
// `rand < density_b × pattern_b[step]`, only in bands that admit
// percussion.
//
// Scheduling is per window (S4): the Transport hands the sequencer a window
// of audio time and it places every note inside it; a note whose time has
// passed is dropped and counted, never moved to now. What is sounding — the
// piece's key and chord — is published to the MusicClock once per chunk.
// Randomness comes from the sequencer's own seeded streams: `choice`
// (pieces, renditions), `perform` (humanization, instrument takes) and
// `percussion`.

import { eventBus } from '../../../../domain/events/DomainEvent.js';
import { BaseLayer } from '../layers/BaseLayer.js';
import { pick, rand } from '../AudioEngine.js';
import { noteHz } from '../MusicalScale.js';
import { rngStream } from '../Rng.js';
import {
    CHORDS, NIGHTFALL_TAG, PERCUSSION_VOICE, PIECES, PLAYLISTS, RELEASE_FANFARE,
    applyFeel, chordPitchClasses, musicKey,
} from '../bgm/BgmSongbook.js';
import { INSTRUMENTS, createInstrument } from './Instruments.js';
import { DEFAULT_VOICE, SEATS, voicingFor } from './Voicings.js';

const EPS = 1e-6;
const A4_PC = 9; // score notes are semitones from A4
const CHUNK_BARS = 4; // the grain of band, arrangement, voice and cadence changes

// ── Town band (6.7) ──
const LOOPS_PER_VISIT = 2;
const BREATH_SEC = 1.4; // from the written end to the next first note
const FIRST_PIECE_SEC = 0.6;
const NO_RETURN_SEC = 360;
const NO_RETURN_SMALL_SET_SEC = 240;
const SMALL_SET = 4;
const INTERLUDE_EVERY = Object.freeze([3, 4]);
// S7: ≤ 12 loops of one piece in any hour (a short piece comes round more).
const LOOPS_PER_HOUR = 12; // visits between interludes (seeded)
const INTERLUDE_VOICES = Object.freeze(['lead', 'bass', 'counter']);
const INTERLUDE_BAND_CAP = 1;
// No identical 16-bar rendition within this window (S7, 6.5).
const RENDITION_WINDOW_SEC = 3600;
const RENDITION_TRIES = 64;

// ── stingers ──
// The release fanfare and the nightfall cadence: the tune, the bass, the
// counter and the comp.
const STINGER_VOICES = Object.freeze(['lead', 'bass', 'counter', 'engine']);

// ── performance ──
const LEAD_JITTER_SEC = 0.007;
// Written length share per seat (the instrument owns the articulation).
const LENGTH = Object.freeze({ lead: 0.92, counter: 0.95, bass: 0.98, descant: 0.9, engine: 0.9, percussion: 0.25 });
// The comp's register window (MUS-12): bottom ≥ E3, top ≤ F♯4.
const COMP_LOW = -17;
const COMP_HIGH = -3;
// The comp's velocity where its figure names none.
const ENGINE_VEL = 0.85;
// Players whose note sounds its written length (the chip waves, the bow,
// the bellows, the breath); plucked and struck players ring by their own
// decay (`engineFigure`'s chord strikes).
const HELD_KINDS = new Set(['chip', 'bowed', 'reed', 'wind']);
// Descant (MUS-8): a sixth over the melody, snapped to a chord tone, on notes
// of at least a beat.
const DESCANT_INTERVAL = 9;
const DESCANT_MIN_BEATS = 1;
const PERC_PER_STEP = 2;
const PRESETS = Object.freeze({
    // Puts the Town band at −31 LUFS-I with its stem short-term max under
    // −28 at the standard step (S2): the Isle Band measures −31.2 (stem ST
    // max −29.2) in the probe's 3-min `townBand` scene, where a wait leans it
    // back −2 dB for most of it, and −30.3 over the 60-min `townband` session.
    townBand: Object.freeze({ trim: 0.536, director: 'bgm' }),
});

const byBeat = (a, b) => a.beat - b.beat;
const pcOf = semi => (((semi % 12) + 12) % 12);
const dbToGain = db => Math.pow(10, (Number(db) || 0) / 20);

function timedChord(name, time) {
    const pcs = chordPitchClasses(name);
    return pcs ? { time, ...pcs } : null;
}

// ── pure score compilation ──

/** `[[semi, beats]]` → `[{ beat, semi, beats }]` from `offset` beats; rests skipped. */
export function lineFrom(notes, offset = 0) {
    const out = [];
    let beat = offset;
    for (const [semi, beats] of notes || []) {
        if (semi != null) out.push({ beat, semi, beats });
        beat += beats;
    }
    return out;
}

/** Per-bar chords (a pair splits the bar in half) → `[{ beat, name }]`. */
export function timelineFrom(chords, beatsPerBar, offsetBar = 0) {
    const out = [];
    (chords || []).forEach((entry, i) => {
        const halves = Array.isArray(entry) ? entry : [entry, entry];
        const beat = (offsetBar + i) * beatsPerBar;
        out.push({ beat, name: halves[0] });
        if (halves[1] !== halves[0]) out.push({ beat: beat + beatsPerBar / 2, name: halves[1] });
    });
    return out;
}

const sliceLine = (line, from, to) => line.filter(n => n.beat >= from - EPS && n.beat < to - EPS);

const canonicalCache = new WeakMap();
function canonicalLines(piece) {
    let lines = canonicalCache.get(piece);
    if (!lines) {
        lines = {
            lead: lineFrom(applyFeel(piece.melody, piece.feel)),
            counter: lineFrom(piece.counterNotes),
            bass: lineFrom(piece.bass),
            descant: lineFrom(piece.descantNotes),
        };
        canonicalCache.set(piece, lines);
    }
    return lines;
}

/** The grammar's slot sizes: `[variants per position]`, empty without cells. */
export function grammarShape(piece) {
    if (!Array.isArray(piece?.grammar) || !piece.cells) return [];
    return piece.grammar.map(slot => Math.max(1, piece.cells[slot]?.length || 1));
}

export function renditionKey(name, tuple) {
    return `${name}:${tuple.length ? tuple.join('') : 'canonical'}`;
}

/**
 * One rendition of a piece: the grammar's cells at `tuple` (variant per
 * position; all zeros is the canonical piece), the lead with the piece's
 * feel. A variant without its own bass or counter plays the canonical bars
 * under it (cells share chords); the authored descant is kept over
 * canonical cells (the sequencer adds a sixth over the rest). Pure.
 */
export function renditionScore(piece, tuple = []) {
    const bpb = piece.beatsPerBar || 4;
    const canon = canonicalLines(piece);
    const shape = grammarShape(piece);
    const base = {
        name: piece.name,
        family: piece.family,
        bpb,
        engine: piece.engine || null,
        percussion: piece.percussion || null,
        phraseEnds: piece.phraseEnds || [],
        bands: piece.bands || null,
        key: renditionKey(piece.name, tuple),
        musicKey: musicKey(piece.key),
    };
    if (!shape.length || !tuple.length || tuple.every(v => v === 0)) {
        return {
            ...base,
            bars: piece.chords.length,
            lead: canon.lead,
            counter: canon.counter,
            bass: canon.bass,
            descant: canon.descant,
            timeline: timelineFrom(piece.chords, bpb),
        };
    }
    const lead = [];
    const counter = [];
    const bass = [];
    const descant = [];
    const chords = [];
    piece.grammar.forEach((slot, i) => {
        const variants = piece.cells[slot] || [];
        const v0 = variants[0] || {};
        const variant = variants[tuple[i]] || v0;
        const cellChords = variant.chords || v0.chords || [];
        const at = chords.length * bpb;
        const end = at + cellChords.length * bpb;
        lead.push(...lineFrom(applyFeel(variant.melody, piece.feel), at));
        counter.push(...(variant.counterNotes ? lineFrom(variant.counterNotes, at) : sliceLine(canon.counter, at, end)));
        bass.push(...(variant.bass ? lineFrom(variant.bass, at) : sliceLine(canon.bass, at, end)));
        if ((tuple[i] || 0) === 0) descant.push(...sliceLine(canon.descant, at, end));
        chords.push(...cellChords);
    });
    return { ...base, bars: chords.length, lead, counter, bass, descant, timeline: timelineFrom(chords, bpb) };
}

/**
 * A cell (`{ chords, melody, bass, counterNotes }`) as a one-off score.
 * `tonality` is the published key (`{ tonicPc, mode }`); a cell without one
 * — the stingers — is in A, minor at night.
 */
export function cellScore(name, cell, { family = 'day', engine = null, tonality = null } = {}) {
    const bpb = cell.beatsPerBar || 4;
    return {
        name,
        family,
        bpb,
        bars: (cell.chords || []).length,
        engine: engine ?? cell.engine ?? null,
        percussion: null,
        phraseEnds: [],
        bands: null,
        key: name,
        musicKey: tonality ?? { tonicPc: A4_PC, mode: family === 'night' ? 'minor' : 'major' },
        lead: lineFrom(cell.melody),
        counter: lineFrom(cell.counterNotes),
        bass: lineFrom(cell.bass),
        descant: [],
        timeline: timelineFrom(cell.chords, bpb),
    };
}

/**
 * The close voicing of `name` inside the comp window nearest to `prev`
 * (MUS-12): least total motion, ties broken away from the melody's pitch
 * class on top. With no `prev`, the one nearest the table's root position.
 * Returns `{ semis, moves }`.
 */
export function nearestVoicing(name, prev = null, { avoidTopPc = null, low = COMP_LOW, high = COMP_HIGH } = {}) {
    const table = CHORDS[name];
    if (!table) return null;
    const order = table.map(pcOf).filter((pc, i, all) => all.indexOf(pc) === i);
    const candidates = [];
    for (let i = 0; i < order.length; i++) {
        for (let bottom = low; bottom <= high; bottom++) {
            if (pcOf(bottom) !== order[i]) continue;
            const semis = [bottom];
            for (let k = 1; k < order.length; k++) {
                const pc = order[(i + k) % order.length];
                let next = semis[k - 1] + 1;
                while (pcOf(next) !== pc) next++;
                semis.push(next);
            }
            if (semis[semis.length - 1] <= high) candidates.push(semis);
        }
    }
    if (!candidates.length) return { semis: [...table], moves: 0 };
    const reference = prev?.length ? prev : table;
    const distance = (semis) => {
        if (semis.length === reference.length) return semis.reduce((sum, s, k) => sum + Math.abs(s - reference[k]), 0);
        return semis.reduce((sum, s) => sum + Math.min(...reference.map(r => Math.abs(s - r))), 0);
    };
    let best = null;
    let bestScore = Infinity;
    for (const semis of candidates) {
        const score = distance(semis) + (avoidTopPc != null && pcOf(semis[semis.length - 1]) === avoidTopPc ? 0.5 : 0);
        if (score < bestScore - EPS) {
            best = semis;
            bestScore = score;
        }
    }
    return { semis: best, moves: prev?.length ? distance(best) : 0 };
}

/**
 * The comp's figure over one chord span [b0, b1) (beats): notes as indices
 * into the voicing; `barBeat` anchors the pattern to the bar grid. In 6/8
 * the beat is the eighth: `block2` strikes on the dotted quarters and `jig`
 * rolls the chord in threes (low, top, middle), leaning on each dotted
 * quarter. `held`: the comp's player sounds each note for its written
 * length (HELD_KINDS). Pure.
 */
export function engineFigure(pattern, voicing, b0, b1, bpb, barBeat, { held = false } = {}) {
    const out = [];
    const grid = (step, fn) => {
        const first = barBeat + Math.ceil((b0 - barBeat) / step - EPS) * step;
        for (let g = first; g < b1 - EPS; g += step) fn(g, Math.round((g - barBeat) / step));
    };
    const arp = [0, 1, 2, 1];
    const at = k => voicing[Math.min(voicing.length - 1, k)];
    // A chord strike (block2, waltz) plays at the arpeggio's level (MUSL-2):
    // a rung player's tones decay by their own ring, so n tones struck
    // together stand in for n of the arpeggio's single strikes as written;
    // a held player's n tones each sound their whole `beats`, so each plays
    // at 1/√(n · beats), the energy of one tone of one beat.
    const strike = (vel, n, beats) => (held ? vel / Math.sqrt(n * beats) : vel);
    switch (pattern) {
        case 'arp8':
            grid(0.5, (g, k) => out.push({ beat: g, semi: at(arp[k % 4]), beats: 0.45 }));
            break;
        case 'arpQ':
            grid(1, (g, k) => out.push({ beat: g, semi: at(arp[k % 4]), beats: 0.9 }));
            break;
        case 'glitter':
            // The seat's octave shift lifts it (the snow arrangement).
            grid(0.25, (g, k) => out.push({ beat: g, semi: at(arp[k % 4]), beats: 0.2, vel: 0.35 }));
            break;
        case 'block2': {
            const step = bpb === 3 || bpb === 6 ? 3 : 2;
            const beats = step * 0.9;
            const vel = strike(ENGINE_VEL, voicing.length, beats);
            grid(step, g => {
                for (const semi of voicing) out.push({ beat: g, semi, beats, vel });
            });
            break;
        }
        case 'jig': {
            const roll = [0, voicing.length - 1, 1];
            grid(1, (g, k) => out.push({ beat: g, semi: at(roll[k % 3]), beats: 0.9, vel: k % 3 === 0 ? 0.9 : 0.75 }));
            break;
        }
        case 'waltz': {
            // Beat 1 is the bass's; the upper dyad on the others.
            const dyad = voicing.slice(-2);
            const vel = strike(0.8, dyad.length, 0.9);
            grid(1, (g) => {
                const inBar = Math.round(g - barBeat) % bpb;
                if (inBar === 0) return;
                for (const semi of dyad) out.push({ beat: g, semi, beats: 0.9, vel });
            });
            break;
        }
        case 'sustain':
        case 'roll':
            // A roll up the chord, 35 ms apart (in beats at the caller's tempo), held for the span.
            voicing.forEach((semi, k) => out.push({ beat: b0, semi, beats: b1 - b0, rollIndex: k }));
            break;
        default:
            break;
    }
    return out;
}

function withinRange(semi, range) {
    if (!range) return semi;
    let s = semi;
    while (s > range[1]) s -= 12;
    while (s < range[0]) s += 12;
    return s > range[1] ? null : s;
}

// ── the sequencer ──

export class Sequencer extends BaseLayer {
    constructor(engine, { preset = 'townBand', voice = DEFAULT_VOICE, ...options } = {}) {
        const config = PRESETS[preset];
        if (!config) throw new Error(`unknown music preset ${preset}`);
        super(engine, {
            trim: config.trim, director: config.director, ...options, group: 'music', rng: `music.${preset}.choice`,
        });
        this.preset = preset;
        this._arrangedPiece = null; // whose own players the voicing seats (C4)
        this.name = `music:${preset}`;
        this.phase = 'day';
        this.voice = voice;
        this.band = 2;
        this.arrangement = { weather: 'clear', season: 'summer', keyframe: 'noon' };
        this._pendingVoice = null;
        this._pendingBand = null;
        this._pendingArrangement = null;
        this._pinned = null; // { piece, band, voice }
        this._density = {};
        this._waiting = false;
        this._homeOwed = false;
        this._nightfallPending = false;
        this._choice = this.rng;
        this._perform = rngStream(`music.${preset}.perform`);
        this._percRng = rngStream(`music.${preset}.percussion`);
        this._voicing = this._voicingNow();
        this._seats = null;
        this._mix = null;
        this._players = new Map();
        this._listeners = new Set();
        this._marks = [];
        this._visit = null; // what is planned or playing: { kind, name, piece, reason }
        this._queue = []; // segment builders played back to back
        this._seg = null; // the segment being scheduled
        this._nextAt = null; // audio time of the next queued segment
        this._committedTo = 0;
        this._skipBefore = -Infinity;
        this._comp = null; // the last comp voicing (voice-leading carries across)
        this._renditions = new Map(); // rendition key → audio time last started
        this._lastEnded = new Map(); // piece → audio time its last visit ended
        this._loopStarts = new Map(); // piece → audio times of its loops (last hour)
        this._lastPiece = null;
        this._round = { phase: null, played: new Set() }; // the shuffle bag (C7)
        this._lastWasInterlude = false;
        this._visitsSinceInterlude = 0;
        this._interludeEvery = INTERLUDE_EVERY[0];
        this._nowPlayingKey = null;
        this._prevTuple = null;
    }

    // ── public API ──

    get pendingBand() {
        return this._pendingBand;
    }

    // Working band 0..3 (MUSL-3); lands at the next chunk boundary.
    setBand(band) {
        const n = Math.max(0, Math.min(3, Math.round(Number(band))));
        if (!Number.isFinite(n)) return false;
        if (n === (this._pendingBand ?? this.band)) return false;
        this._pendingBand = n === this.band ? null : n;
        return this._pendingBand != null;
    }

    // Town band voice (D2): 'isle' or 'chip'; lands at the next chunk boundary.
    setVoice(voice) {
        const next = voice === 'chip' ? 'chip' : 'isle';
        if (next === (this._pendingVoice ?? this.voice)) return false;
        this._pendingVoice = next === this.voice ? null : next;
        return true;
    }

    // Weather, season and grade keyframe (MUS-16, MUSL-8); a changed
    // arrangement lands at the next chunk boundary.
    setArrangement({ weather, season, keyframe } = {}) {
        const current = this._pendingArrangement ?? this.arrangement;
        const next = {
            weather: weather ?? current.weather,
            season: season ?? current.season,
            keyframe: keyframe ?? current.keyframe,
        };
        if (next.weather === current.weather && next.season === current.season && next.keyframe === current.keyframe) return false;
        // Night-fall (MUS-11): the evening's turn into night, once.
        if (next.keyframe === 'night' && current.keyframe === 'blue-hour') {
            this._nightfallPending = true;
        }
        this._pendingArrangement = next;
        return true;
    }

    // Town band percussion (6.9): `{ [building]: 0..1 }`, read at chunk opens.
    setWorkshopDensity(densities = {}) {
        const next = {};
        for (const [building, value] of Object.entries(densities || {})) {
            const d = Number(value);
            if (d > 0) next[building] = Math.min(1, d);
        }
        this._density = next;
    }

    // MUS-9: while true each phrase end turns deceptive.
    setWaiting(waiting) {
        this._waiting = Boolean(waiting);
    }

    setPhase(phase) {
        if (!PLAYLISTS[phase]) return;
        this.phase = phase;
        this.engine.musicClock?.setPhase(phase);
    }

    // Probe and QA: `{ piece, band, voice }`. `piece` makes that piece the
    // only candidate from the next start on; `band` holds the working band
    // against setBand; `null` releases every pin.
    pin(spec) {
        if (spec == null) {
            this._pinned = null;
            return true;
        }
        const name = spec.piece ?? null;
        if (name !== null && !PIECES.some(p => p.name === name)) return false;
        const band = spec.band == null ? null : Math.max(0, Math.min(3, Math.round(Number(spec.band))));
        this._pinned = { piece: name, band, voice: spec.voice ?? null };
        if (band != null) this._pendingBand = band === this.band ? null : band;
        if (spec.voice) this.setVoice(spec.voice);
        return true;
    }

    // Marks at schedule time (audio time `t`) for the probe's timeline.
    observe(fn) {
        this._listeners.add(fn);
        return () => this._listeners.delete(fn);
    }

    // Each seat's post-pan output (before the music group), for stem taps.
    seatOutputs() {
        const out = {};
        for (const [name, seat] of Object.entries(this._seats || {})) out[name] = seat.pan;
        return out;
    }

    // What is sounding now (not what is committed ahead); null when silent.
    // `lead` and `counter` are the instruments the arrangement seats (C6).
    get nowPlaying() {
        const mark = this._soundingMark();
        if (!mark || mark.kind === 'pieceEnd' || mark.kind === 'breath' || mark.kind === 'end') return null;
        const now = this.engine.now();
        const bar = mark.barSec > 0 ? mark.barOffset + Math.floor((now - mark.t0) / mark.barSec + EPS) + 1 : null;
        return {
            piece: mark.piece,
            title: mark.title,
            lead: mark.lead,
            counter: mark.counter,
            kind: mark.what,
            bar: bar != null ? Math.max(1, Math.min(mark.bars, bar)) : null,
            bars: mark.bars,
            band: mark.band,
            reason: mark.reason,
        };
    }

    snapshot() {
        const playing = this.nowPlaying;
        return {
            preset: this.preset,
            voice: this.voice,
            playing: Boolean(playing),
            kind: playing?.kind ?? null,
            piece: playing?.piece ?? null,
            title: playing?.title ?? null,
            lead: playing?.lead ?? null,
            counter: playing?.counter ?? null,
            bar: playing?.bar ?? null,
            bars: playing?.bars ?? null,
            band: this.band,
            reason: playing?.reason ?? null,
            arrangement: { ...this.arrangement },
            waiting: this._waiting,
            rendition: this._seg?.score?.key ?? null,
        };
    }

    /**
     * `release` (6.8): the fanfare at the next bar that is not yet
     * committed and not before `at`, then the piece resumes. Returns
     * `{ ok, startsAt, endsAt }` in audio seconds or `{ ok: false, why }`.
     */
    playOccasion(kind, { reason = kind, at = null } = {}) {
        if (!this.running || !this._seats) return { ok: false, why: 'stopped' };
        return kind === 'release' ? this._interjectFanfare(reason, at) : { ok: false, why: 'unknown' };
    }

    // ── layer lifecycle ──

    _start(ctx) {
        this._mix = ctx.createGain();
        this._mix.gain.value = 1;
        this._mix.connect(this.out);
        this.track(this._mix);
        this._seats = {};
        for (const name of SEATS) {
            const bus = ctx.createGain();
            let pan = bus;
            if (ctx.createStereoPanner) {
                pan = ctx.createStereoPanner();
                bus.connect(pan);
            }
            pan.connect(this._mix);
            const air = this.airSend(0, pan);
            this.track(bus, pan);
            this._seats[name] = { bus, pan, air };
        }
        // What the director set before the start is what the band opens with.
        this._applyPending(ctx.currentTime);
        this._voicing = this._voicingNow();
        this._applySeats(this._voicing, ctx.currentTime, true);
        this._committedTo = ctx.currentTime;
        this._planTownBand(ctx.currentTime + FIRST_PIECE_SEC);
        this.registerProcess(this);
    }

    stop() {
        const silentAt = super.stop() ?? this.engine.now();
        for (const player of this._players.values()) player.dispose?.(silentAt);
        this._players.clear();
        this.engine.musicClock?.clear(this.preset);
        this._seats = null;
        this._mix = null;
        this._visit = null;
        this._queue = [];
        this._seg = null;
        this._nextAt = null;
        this._marks = [];
        this._publishNowPlaying(true);
        return silentAt;
    }

    // ── Transport process ──

    rearm(now) {
        this._skipBefore = now;
        if (this._nextAt !== null && this._nextAt < now) this._nextAt = now;
    }

    schedule(from, to) {
        if (!this.running || !this.engine.context || !this._seats) return 0;
        const dropped = this._scheduleWindow(from, to);
        this._committedTo = Math.max(this._committedTo, to);
        this._publishNowPlaying();
        return dropped;
    }

    _scheduleWindow(from, to) {
        let dropped = 0;
        for (;;) {
            if (!this._seg) {
                if (this._nextAt === null || this._nextAt >= to) return dropped;
                const build = this._queue.shift();
                if (!build) {
                    this._nextAt = null;
                    return dropped;
                }
                this._seg = build(this._nextAt);
                this._nextAt = null;
            }
            const seg = this._seg;
            while (seg.bar < seg.toBar) {
                if (seg.openBar !== seg.bar) {
                    if (seg.t0 + seg.bar * seg.barSec >= to) return dropped;
                    this._openChunk(seg);
                    if (this._seg !== seg) break;
                }
                while (seg.index < seg.events.length) {
                    const ev = seg.events[seg.index];
                    const nominal = seg.t0 + ev.beat * seg.beatSec;
                    if (nominal >= to) return dropped;
                    seg.index++;
                    const t = nominal + (ev.jitter || 0);
                    if (t < this._skipBefore) continue;
                    if (nominal < from - EPS || t < this.engine.now()) {
                        dropped++;
                        continue;
                    }
                    this._play(t, ev, seg);
                }
                seg.bar = seg.chunkEnd;
            }
            if (this._seg !== seg) continue;
            const endT = seg.t0 + seg.toBar * seg.barSec;
            if (endT >= to) return dropped;
            this._seg = null;
            const next = this._queue.shift();
            if (next) {
                this._seg = next(endT);
            } else {
                this._endVisit(endT);
            }
        }
    }

    // ── visits ──

    _beginVisit(visit, builders, t) {
        this._visit = { ...visit, startsAt: t };
        this._queue = builders;
        this._nextAt = t;
        this._mark({ kind: 'start', t, what: visit.kind, name: visit.name, piece: visit.piece, reason: visit.reason }, true);
    }

    _endVisit(endT) {
        const visit = this._visit;
        this._visit = null;
        this._seg = null;
        if (!visit) return;
        if (visit.kind === 'piece') {
            this._lastEnded.set(visit.piece, endT);
            this._lastPiece = visit.piece;
            this._lastWasInterlude = false;
            this._visitsSinceInterlude += 1;
        } else if (visit.kind === 'interlude') {
            this._lastWasInterlude = true;
            this._visitsSinceInterlude = 0;
            this._interludeEvery = pick(this._choice, INTERLUDE_EVERY);
        }
        this._mark({ kind: 'pieceEnd', t: endT, piece: visit.piece, what: visit.kind }, true);
        this._mark({
            kind: 'end', t: endT, what: visit.kind, name: visit.name, piece: visit.piece, reason: visit.reason,
        }, true);
        if (this.running) {
            const next = endT + BREATH_SEC;
            this._mark({ kind: 'breath', t: endT, until: next }, true);
            this._planTownBand(next);
        }
    }

    _playlist() {
        if (this._pinned?.piece) return PIECES.filter(p => p.name === this._pinned.piece);
        const names = PLAYLISTS[this.phase] || PLAYLISTS.day;
        return PIECES.filter(p => names.includes(p.name));
    }

    // The next Town band visit, first note at `t`.
    _planTownBand(t) {
        const list = this._playlist();
        if (!list.length) return;
        const last = PIECES.find(p => p.name === this._lastPiece) || null;
        if (!this._pinned?.piece && last?.interlude && !this._lastWasInterlude
            && this._visitsSinceInterlude >= this._interludeEvery) {
            this._planInterlude(last, t);
            return;
        }
        let piece;
        if (this._pinned?.piece) {
            piece = list[0];
        } else {
            // C7: a shuffle bag per phase. A round plays every piece of the
            // playlist once, each pick seeded-uniform among the round's
            // unplayed pieces the gap and the hourly cap allow; the next round
            // never opens on the piece that just played, and a phase change
            // opens a fresh round.
            if (this._round.phase !== this.phase) this._round = { phase: this.phase, played: new Set() };
            let unplayed = list.filter(p => !this._round.played.has(p.name));
            if (!unplayed.length) {
                this._round.played.clear();
                unplayed = list;
            }
            const gap = list.length >= SMALL_SET ? NO_RETURN_SEC : NO_RETURN_SMALL_SET_SEC;
            const eligible = unplayed.filter(p => p.name !== this._lastPiece
                && t - (this._lastEnded.get(p.name) ?? -Infinity) >= gap
                && this._loopsWithinHour(p.name, t) + LOOPS_PER_VISIT <= LOOPS_PER_HOUR);
            if (eligible.length) {
                piece = pick(this._choice, eligible);
            } else if (last?.interlude && !this._lastWasInterlude) {
                this._planInterlude(last, t);
                return;
            } else {
                // Nothing may play yet: the one that ended longest ago, the
                // round's own first.
                const pool = [unplayed, list].map(set => set.filter(p => p.name !== this._lastPiece)).find(set => set.length) ?? list;
                piece = pool.reduce((a, b) => ((this._lastEnded.get(a.name) ?? -Infinity)
                    <= (this._lastEnded.get(b.name) ?? -Infinity) ? a : b));
            }
            this._round.played.add(piece.name);
        }
        const beatSec = 60 / (piece.bpm * (this._voicingNow().tempoScale || 1));
        // Its players exist before the pickup (C4: the piece's own seats).
        this._preparePlayers(voicingFor({ ...this._voicingArgs(), piece: piece.name }));
        const builders = [];
        if (piece.pickup?.length) builders.push(start => this._pickupSegment(piece, beatSec, start));
        for (let loop = 1; loop <= LOOPS_PER_VISIT; loop++) {
            builders.push(start => this._passSegment(piece, beatSec, start, {
                loop, of: LOOPS_PER_VISIT, last: loop === LOOPS_PER_VISIT, what: 'piece',
            }));
        }
        this._beginVisit({
            kind: 'piece', name: piece.name, piece: piece.name, reason: this._pinned?.piece ? 'pinned' : 'rotation',
        }, builders, t);
    }

    _loopsWithinHour(name, t) {
        const starts = (this._loopStarts.get(name) || []).filter(at => t - at < RENDITION_WINDOW_SEC);
        this._loopStarts.set(name, starts);
        return starts.length;
    }

    _planInterlude(piece, t) {
        const beatSec = 60 / (piece.bpm * (this._voicingNow().tempoScale || 1));
        this._beginVisit({ kind: 'interlude', name: `${piece.name}:interlude`, piece: piece.name, reason: 'interlude' }, [
            start => this._cellSegment(`${piece.name}:interlude`, { beatsPerBar: piece.beatsPerBar, ...piece.interlude }, beatSec, start, {
                kind: 'interlude', voices: INTERLUDE_VOICES, family: piece.family, bandCap: INTERLUDE_BAND_CAP,
                engine: piece.engine, piece: piece.name, tonality: musicKey(piece.key),
            }),
        ], t);
    }

    // ── segments ──

    _segment(fields) {
        const bpb = fields.score.bpb;
        const beatSec = fields.beatSec;
        return {
            kind: 'pass',
            fromBar: 0,
            toBar: fields.score.bars,
            barOffset: 0,
            loop: 1,
            of: 1,
            last: true,
            cadences: true,
            voices: null,
            bandCap: 3,
            ...fields,
            bpb,
            barSec: bpb * beatSec,
            bar: fields.fromBar ?? 0,
            openBar: -1,
            chunkEnd: fields.fromBar ?? 0,
            events: [],
            index: 0,
        };
    }

    _passSegment(piece, beatSec, t0, { loop, of, last, what }) {
        const tuple = this._pickTuple(piece, t0, loop);
        const score = renditionScore(piece, tuple);
        this._renditions.set(score.key, t0);
        if (!this._loopStarts.has(piece.name)) this._loopStarts.set(piece.name, []);
        this._loopStarts.get(piece.name).push(t0);
        this._prevTuple = { piece: piece.name, tuple };
        const seg = this._segment({
            kind: 'pass', piece, score, beatSec, t0, loop, of, last, what, tuple,
        });
        this._mark({
            kind: 'rendition', t: t0, piece: piece.name, loop, key: score.key,
        });
        return seg;
    }

    _pickupSegment(piece, beatSec, start) {
        const bpb = piece.beatsPerBar || 4;
        const beats = piece.pickup.reduce((s, [, b]) => s + b, 0);
        const score = {
            ...cellScore(`${piece.name}:pickup`, { beatsPerBar: bpb, chords: [piece.chords[0]], melody: [] }, {
                family: piece.family, tonality: musicKey(piece.key),
            }),
            lead: lineFrom(piece.pickup, bpb - beats),
            timeline: [{ beat: bpb - beats, name: Array.isArray(piece.chords[0]) ? piece.chords[0][0] : piece.chords[0] }],
        };
        return this._segment({
            kind: 'pickup', piece, score, beatSec, t0: start - (bpb - beats) * beatSec, barOffset: -1,
            what: this._visit?.kind ?? 'piece', voices: ['lead'], cadences: false,
        });
    }

    _cellSegment(name, cell, beatSec, t0, { kind, voices, family = 'day', bandCap = 3, engine = null, piece = null, barOffset = 0, tonality = null }) {
        const score = cellScore(name, cell, { family, engine, tonality });
        return this._segment({
            kind, piece: piece ? PIECES.find(p => p.name === piece) : null, pieceName: piece ?? name, score, beatSec, t0,
            voices, bandCap, cadences: false, what: this._visit?.kind ?? kind, barOffset,
        });
    }

    // MUS-6: a variant tuple not heard within the hour. The first pass of a
    // visit keeps the opening cell canonical; the first pass in an hour is
    // the canonical piece; a later pass changes at least one cell.
    _pickTuple(piece, t, loop) {
        const shape = grammarShape(piece);
        if (!shape.length) return [];
        const fresh = key => t - (this._renditions.get(key) ?? -Infinity) >= RENDITION_WINDOW_SEC;
        const canonical = shape.map(() => 0);
        if (loop === 1 && fresh(renditionKey(piece.name, canonical))) return canonical;
        const previous = this._prevTuple?.piece === piece.name ? this._prevTuple.tuple : null;
        let best = null;
        let bestAt = Infinity;
        for (let i = 0; i < RENDITION_TRIES; i++) {
            const tuple = shape.map((n, k) => (loop === 1 && k === 0 ? 0 : Math.floor(this._choice() * n)));
            if (previous && tuple.every((v, k) => v === previous[k])) continue;
            const key = renditionKey(piece.name, tuple);
            if (fresh(key)) return tuple;
            const at = this._renditions.get(key) ?? -Infinity;
            if (at < bestAt) {
                best = tuple;
                bestAt = at;
            }
        }
        return best || canonical;
    }

    // Truncates `seg` at the first bar at or after `atLeast` (audio time)
    // that is not yet committed; returns that bar.
    _cut(seg, atLeast) {
        const bar = Math.max(seg.bar === seg.openBar ? seg.openBar : seg.bar,
            Math.ceil((Math.max(atLeast, this._committedTo) - seg.t0) / seg.barSec - EPS));
        const cutBar = Math.min(seg.toBar, Math.max(seg.fromBar, bar));
        const cutBeat = cutBar * seg.bpb;
        if (seg.openBar >= 0 && cutBar < seg.chunkEnd) {
            seg.events = seg.events.slice(0, seg.index).concat(seg.events.slice(seg.index).filter(ev => ev.beat < cutBeat - EPS));
            seg.chunkEnd = cutBar;
        }
        seg.toBar = cutBar;
        return cutBar;
    }

    // Release (6.8): the fanfare, in A, at the next free bar, then the piece resumes.
    _interjectFanfare(reason, at) {
        const seg = this._seg;
        const cell = RELEASE_FANFARE?.[seg?.score.family === 'night' ? 'night' : 'day'] ?? null;
        if (!seg || seg.kind !== 'pass' || !cell) return { ok: false, why: 'between' };
        const originalTo = seg.toBar;
        const cutBar = this._cut(seg, Math.max(Number(at) || 0, this.engine.now()));
        if (cutBar >= originalTo) {
            seg.toBar = originalTo;
            return { ok: false, why: 'ending' };
        }
        const beatSec = seg.beatSec;
        const fanfareSec = cell.chords.length * (cell.beatsPerBar || 4) * beatSec;
        const startsAt = seg.t0 + cutBar * seg.barSec;
        const rest = { ...seg };
        this._queue.unshift(
            start => this._cellSegment('releaseFanfare', cell, beatSec, start, {
                kind: 'fanfare', voices: STINGER_VOICES, family: seg.score.family, piece: seg.piece?.name,
            }),
            start => ({
                ...rest,
                t0: start - cutBar * rest.barSec,
                fromBar: cutBar,
                toBar: originalTo,
                bar: cutBar,
                openBar: -1,
                chunkEnd: cutBar,
                events: [],
                index: 0,
            }),
        );
        this._mark({ kind: 'stinger', t: startsAt, piece: seg.piece?.name, reason });
        return { ok: true, startsAt, endsAt: startsAt + fanfareSec };
    }

    // ── chunks ──

    _voicingNow() {
        const arrangement = this._pendingArrangement ?? this.arrangement;
        return voicingFor({
            voice: this._pendingVoice ?? this.voice,
            keyframe: arrangement.keyframe,
            weather: arrangement.weather,
            season: arrangement.season,
            band: this._pinned?.band ?? this._pendingBand ?? this.band,
            piece: this._arrangedPiece,
        });
    }

    // Pending band, voice and arrangement land here (a chunk boundary at `t`),
    // and the players of the piece the chunk belongs to (C4).
    _applyPending(t, piece = this._arrangedPiece) {
        let changed = false;
        if (piece !== this._arrangedPiece) {
            this._arrangedPiece = piece;
            changed = true;
        }
        if (this._pinned?.band != null) {
            this._pendingBand = null;
            if (this.band !== this._pinned.band) {
                this.band = this._pinned.band;
                changed = true;
            }
        } else if (this._pendingBand != null) {
            this.band = this._pendingBand;
            this._pendingBand = null;
            changed = true;
        }
        if (this._pendingVoice) {
            this.voice = this._pendingVoice;
            this._pendingVoice = null;
            changed = true;
        }
        let arrangementChanged = false;
        if (this._pendingArrangement) {
            this.arrangement = this._pendingArrangement;
            this._pendingArrangement = null;
            changed = true;
            arrangementChanged = true;
        }
        if (!changed) return;
        const next = this._voicingNow();
        const reseat = next.key !== this._voicing.key;
        this._voicing = next; // the band changes what is admitted, not the seats
        if (reseat) this._applySeats(next, t, false);
        if (arrangementChanged) {
            this._mark({ kind: 'arrangement', t, key: next.key, ...this.arrangement });
        }
    }

    // Every player of the arrangement exists before its first note
    // (persistent lanes and bakes never land on a note's schedule).
    _preparePlayers(voicing) {
        for (const name of Object.keys(this._seats || {})) {
            const spec = voicing.seats?.[name];
            if (!spec) continue;
            if (name === 'percussion') {
                for (const voice of new Set(Object.values(PERCUSSION_VOICE || {}))) this._player(name, spec.kit?.[voice] ?? voice);
            } else if (spec.instrument) {
                this._player(name, spec.instrument);
            }
        }
    }

    _applySeats(voicing, t, immediate) {
        this._preparePlayers(voicing);
        // A pickup's bar opens before its first note (and before the context's 0).
        t = Math.max(t, this.engine.now());
        for (const [name, seat] of Object.entries(this._seats || {})) {
            const spec = voicing.seats?.[name];
            const gain = spec ? dbToGain(spec.gainDb) : 0;
            const air = spec ? Math.max(0, Number(spec.air) || 0) : 0;
            const pan = spec ? Math.max(-1, Math.min(1, Number(spec.pan) || 0)) : 0;
            if (immediate) {
                seat.bus.gain.value = gain;
                if (seat.pan.pan) seat.pan.pan.value = pan;
                if (seat.air) seat.air.gain.value = air;
            } else {
                seat.bus.gain.setTargetAtTime(gain, t, 0.05);
                seat.pan.pan?.setTargetAtTime(pan, t, 0.05);
                seat.air?.gain.setTargetAtTime(air, t, 0.05);
            }
        }
    }

    _openChunk(seg) {
        const fromBar = seg.bar;
        const t = seg.t0 + fromBar * seg.barSec;
        seg.openBar = fromBar;
        seg.events = [];
        seg.index = 0;
        this._applyPending(t, seg.piece?.name ?? this._arrangedPiece);

        // Night-fall (MUS-11): the next chunk of a Town band pass becomes
        // the lantern-lighting cadence, which closes the visit.
        if (this._nightfallPending && seg.kind === 'pass' && NIGHTFALL_TAG) {
            this._nightfallPending = false;
            seg.toBar = fromBar;
            seg.chunkEnd = fromBar;
            const beatSec = NIGHTFALL_TAG.bpm ? 60 / NIGHTFALL_TAG.bpm : seg.beatSec;
            this._queue = [start => this._cellSegment('nightfall', NIGHTFALL_TAG, beatSec, start, {
                kind: 'nightfall', voices: STINGER_VOICES, family: 'night', piece: seg.piece?.name,
            })];
            this._mark({ kind: 'nightfall', t, piece: seg.piece?.name });
            return;
        }

        let toBar = Math.min(fromBar + CHUNK_BARS, seg.toBar);
        const { score, bpb } = seg;
        const piece = seg.piece;

        // The visit's last pass: the piece may have left the playlist, and a
        // closed ending takes the tag in place of the final bar (MUS-11); a
        // wait keeps the written final bar, which turns deceptive.
        if (seg.kind === 'pass' && seg.what === 'piece' && !seg.last
            && toBar >= seg.toBar && !this._playlist().some(p => p.name === piece.name)) {
            seg.last = true;
            this._queue = [];
        }
        if (seg.kind === 'pass' && seg.last && piece?.tag && toBar >= seg.toBar && !seg.tagQueued
            && !this._waiting && seg.toBar === score.bars) {
            seg.tagQueued = true;
            seg.toBar = score.bars - 1;
            toBar = Math.min(toBar, seg.toBar);
            const tag = piece.tag;
            const ritard = tag.ritard || 1;
            const beatSec = seg.beatSec * ritard;
            const offset = score.bars - 1;
            this._queue.unshift(start => this._cellSegment(`${piece.name}:tag`, { beatsPerBar: bpb, ...tag }, beatSec, start, {
                kind: 'tag', voices: null, family: piece.family, engine: score.engine, piece: piece.name, barOffset: offset,
                tonality: score.musicKey,
            }));
        }
        seg.chunkEnd = toBar;
        if (fromBar >= toBar) return;

        const beatFrom = fromBar * bpb;
        const beatTo = toBar * bpb;
        const openFrom = fromBar === seg.fromBar ? -Infinity : beatFrom;
        const inChunk = n => n.beat >= openFrom - EPS && n.beat < beatTo - EPS;
        const barOf = beat => Math.floor(beat / bpb + EPS);

        // Cadences (MUS-9).
        const chordAt = new Map();
        const bassAt = new Map();
        const leadAt = new Map();
        if (seg.cadences) {
            for (const end of score.phraseEnds) {
                if (end.bar < fromBar || end.bar >= toBar) continue;
                const at = seg.t0 + end.bar * seg.barSec;
                let type = 'authentic';
                if (this._waiting && end.chord && CHORDS[end.chord]) {
                    type = 'deceptive';
                    chordAt.set(end.bar, end.chord);
                    if (end.bass) bassAt.set(end.bar, lineFrom(end.bass, end.bar * bpb));
                    this._homeOwed = true;
                } else if (this._homeOwed) {
                    type = 'home';
                    if (end.home?.melody) leadAt.set(end.bar, lineFrom(end.home.melody, end.bar * bpb));
                    this._homeOwed = false;
                }
                this._mark({ kind: 'cadence', t: at, piece: score.name, bar: end.bar + 1, type, deceptive: type === 'deceptive' });
            }
        } else if (seg.kind === 'tag' && this._homeOwed) {
            this._homeOwed = false;
            this._mark({ kind: 'cadence', t, piece: score.name, bar: seg.barOffset + 1, type: 'home', deceptive: false });
        }

        // The chord timeline of this chunk, the one in force at its start first.
        let timeline = [];
        let inForce = null;
        for (const c of score.timeline) {
            if (c.beat <= beatFrom + EPS) inForce = c;
            else if (c.beat < beatTo - EPS) timeline.push(c);
        }
        if (inForce) timeline.unshift({ beat: Math.max(inForce.beat, beatFrom), name: inForce.name });
        if (chordAt.size) {
            timeline = timeline.filter(c => !chordAt.has(barOf(c.beat)));
            for (const [bar, name] of chordAt) timeline.push({ beat: bar * bpb, name });
            timeline.sort(byBeat);
            // A deceptive bar holds its chord for the whole bar; restore the
            // written chord at the next bar if the chunk continues.
            for (const bar of chordAt.keys()) {
                const nextBeat = (bar + 1) * bpb;
                if (nextBeat < beatTo - EPS && !timeline.some(c => Math.abs(c.beat - nextBeat) < EPS)) {
                    let written = null;
                    for (const c of score.timeline) if (c.beat <= nextBeat + EPS) written = c;
                    if (written) timeline.push({ beat: nextBeat, name: written.name });
                }
            }
            timeline.sort(byBeat);
        }
        // MUS-16 cadence colour: the piece's authored chords for its last two
        // bars (`piece.colour[row].chords`), where no cadence turned them.
        const colour = seg.kind === 'pass' && this._voicing.colourRow
            ? piece?.colour?.[this._voicing.colourRow]?.chords ?? null
            : null;
        if (colour?.length) {
            const firstBar = score.bars - colour.length;
            const recoloured = timelineFrom(colour, bpb, firstBar)
                .filter(c => c.beat >= beatFrom - EPS && c.beat < beatTo - EPS && !chordAt.has(barOf(c.beat)));
            if (recoloured.length) {
                const bars = new Set(recoloured.map(c => barOf(c.beat)));
                timeline = timeline.filter(c => !bars.has(barOf(c.beat))).concat(recoloured).sort(byBeat);
            }
        }

        const band = Math.min(this.band, seg.bandCap);
        const seats = this._seatsFor(seg, band);
        const events = [];

        // Lead (humanized), counter, bass, descant.
        if (seats.has('lead')) {
            for (const note of score.lead) {
                if (inChunk(note) && !leadAt.has(barOf(note.beat))) events.push(this._leadEvent(note, bpb));
            }
            for (const line of leadAt.values()) {
                for (const note of line) events.push(this._leadEvent(note, bpb));
            }
        }
        if (seats.has('counter')) {
            for (const note of score.counter) {
                if (inChunk(note)) events.push({ ...note, seat: 'counter', vel: note.beat % bpb === 0 ? 0.95 : 0.85 });
            }
        }
        const bassFigure = this._voicing.seats?.bass?.figure;
        const rootsOnly = bassFigure === 'drone' || bassFigure === 'sustain';
        if (rootsOnly && seats.has('bass')) {
            for (let bar = fromBar; bar < toBar; bar++) {
                const chord = [...timeline].reverse().find(c => c.beat <= bar * bpb + EPS) || timeline[0];
                const root = chord ? CHORDS[chord.name]?.[0] : null;
                if (root == null) continue;
                let semi = root;
                while (semi > -17) semi -= 12;
                while (semi < -29) semi += 12;
                events.push({ beat: bar * bpb, semi, beats: bpb, seat: 'bass', vel: 0.9 });
            }
        }
        if (!rootsOnly && seats.has('bass')) {
            for (const note of score.bass) {
                if (inChunk(note) && !bassAt.has(barOf(note.beat))) {
                    events.push({ ...note, seat: 'bass', vel: note.beat % bpb === 0 ? 1 : 0.9 });
                }
            }
            for (const line of bassAt.values()) {
                for (const note of line) events.push({ ...note, seat: 'bass', vel: 1 });
            }
        }
        if (seats.has('descant')) {
            // The authored descant where the cell is canonical, and a sixth
            // over every other melody note of a beat or more (MUS-8).
            const authored = score.descant.filter(inChunk);
            const at = new Set(authored.map(n => Math.round(n.beat * 8)));
            const descant = authored.concat(this._descantFor(
                score.lead.filter(n => inChunk(n) && !at.has(Math.round(n.beat * 8))), timeline,
            ));
            for (const note of descant) {
                const bar = barOf(note.beat);
                if (!leadAt.has(bar)) events.push({ ...note, seat: 'descant', vel: 0.8 });
            }
        }

        // The comp: nearest inversions on every chord change (MUS-12).
        const figure = this._voicing.seats?.engine?.figure;
        const pattern = figure && figure !== 'written' && figure !== 'drone'
            ? figure
            : (score.engine || (score.family === 'night' ? 'arpQ' : 'arp8'));
        const compPlays = seats.has('engine') && figure !== 'drone';
        const held = HELD_KINDS.has(INSTRUMENTS[this._voicing.seats?.engine?.instrument]?.kind);
        for (let i = 0; i < timeline.length; i++) {
            const span = timeline[i];
            const b1 = Math.min(timeline[i + 1]?.beat ?? beatTo, beatTo);
            if (b1 <= span.beat + EPS) continue;
            const melodyNote = [...score.lead].reverse().find(n => n.beat <= span.beat + EPS && n.beat + n.beats > span.beat + EPS);
            const voiced = nearestVoicing(span.name, this._comp, {
                avoidTopPc: melodyNote ? pcOf(melodyNote.semi) : null,
            });
            if (!voiced) continue;
            if (this._comp) this._mark({ kind: 'comp', t: seg.t0 + span.beat * seg.beatSec, chord: span.name, moves: voiced.moves });
            this._comp = voiced.semis;
            if (!compPlays) continue;
            const barBeat = barOf(span.beat) * bpb;
            for (const ev of engineFigure(pattern, voiced.semis, span.beat, b1, bpb, barBeat, { held })) {
                const jitter = ev.rollIndex ? ev.rollIndex * 0.035 : 0;
                events.push({ ...ev, seat: 'engine', vel: ev.vel ?? ENGINE_VEL, jitter });
            }
        }

        // Percussion (6.9): per building, on the piece's weight rows.
        if (seats.has('percussion') && score.percussion) {
            const kit = this._voicing.seats?.percussion?.kit || null;
            for (let bar = fromBar; bar < toBar; bar++) {
                const hitsAt = new Map();
                for (const [building, voice] of Object.entries(PERCUSSION_VOICE || {})) {
                    const d = this._density[building] || 0;
                    const row = score.percussion[building];
                    if (!(d > 0) || !Array.isArray(row) || !row.length) continue;
                    const stepBeats = bpb / row.length;
                    for (let s = 0; s < row.length; s++) {
                        const w = Number(row[s]) || 0;
                        if (!(w > 0)) continue;
                        if (this._percRng() >= d * w) continue;
                        const n = hitsAt.get(s) || 0;
                        if (n >= PERC_PER_STEP) continue;
                        hitsAt.set(s, n + 1);
                        events.push({
                            beat: bar * bpb + s * stepBeats, seat: 'percussion', semi: 0, beats: stepBeats,
                            vel: 0.55 + 0.45 * w, instrument: kit?.[voice] ?? voice, building, step: s,
                        });
                    }
                }
            }
        }

        // The band's own groove seat (MUSL-3's full row: brushes) on the song
        // grid wherever the voicing admits it; the workshop kit above stays
        // density-driven.
        const groove = this._voicing.seats?.groove;
        const grooveSteps = groove?.steps?.[bpb];
        if (groove?.instrument && grooveSteps && band > 0 && seats.has('groove')) {
            for (let bar = fromBar; bar < toBar; bar++) {
                for (const [step, beats, vel] of grooveSteps) {
                    events.push({
                        beat: bar * bpb + step / 4, seat: 'groove', semi: 0, beats, vel: vel ?? 0.7,
                        instrument: groove.instrument, exactLength: true, groove: true,
                        jitter: rand(this._percRng, -LEAD_JITTER_SEC, LEAD_JITTER_SEC),
                    });
                }
            }
        }

        events.sort(byBeat);
        seg.events = events;

        // The MusicClock frame (the piece's key and the sounding chords) and
        // the chunk mark (what `nowPlaying` reads: the piece's title and the
        // instruments its lead and counter sound on).
        const until = seg.t0 + toBar * seg.barSec;
        this.engine.musicClock?.publish({
            source: this.preset,
            key: score.musicKey,
            originTime: seg.t0 - seg.barOffset * seg.barSec,
            beatSec: seg.beatSec,
            beatsPerBar: bpb,
            chords: timeline.map(c => timedChord(c.name, seg.t0 + Math.max(c.beat, beatFrom) * seg.beatSec)).filter(Boolean),
            until,
        });
        const state = {
            t,
            piece: seg.pieceName ?? piece?.name ?? score.name,
            title: piece?.title ?? null,
            lead: this._voicing.seats?.lead?.instrument ?? null,
            counter: this._voicing.seats?.counter?.instrument ?? null,
            what: seg.what,
            segment: seg.kind,
            reason: this._visit?.reason ?? null,
            bar: seg.barOffset + fromBar + 1,
            bars: seg.kind === 'tag' ? seg.barOffset + score.bars
                : seg.kind === 'pickup' ? (piece?.chords.length ?? 1) : score.bars,
            loop: seg.loop,
            band,
            t0: seg.t0,
            barOffset: seg.barOffset,
            barSec: seg.barSec,
            beatSec: seg.beatSec,
            loopStart: seg.t0,
            loopSeconds: score.bars * seg.barSec,
            arrangement: { ...this.arrangement },
            voice: this.voice,
        };
        const first = fromBar === seg.fromBar;
        if (first && seg.kind === 'pass') this._mark({ kind: 'loop', ...state }, true);
        else if (first && seg.kind === 'interlude') this._mark({ kind: 'interlude', ...state, bars: score.bars }, true);
        else this._mark({ kind: 'chunk', ...state }, true);
    }

    _leadEvent(note, bpb) {
        const onBar = Math.abs(note.beat / bpb - Math.round(note.beat / bpb)) < EPS;
        return {
            ...note,
            seat: 'lead',
            vel: onBar ? 1 : rand(this._perform, 0.85, 0.95),
            jitter: rand(this._perform, -LEAD_JITTER_SEC, LEAD_JITTER_SEC),
        };
    }

    // The seats a chunk plays: the voicing's admitted seats, within the
    // piece's band plan and the segment's own voices.
    _seatsFor(seg, band) {
        let seats = new Set(this._voicing.admitted || []);
        if (band < this.band) {
            const capped = voicingFor({ ...this._voicingArgs(), band });
            seats = new Set(capped.admitted || []);
        }
        const planned = seg.score.bands?.[band];
        // The score plans its own voices; the band's groove is the voicing's.
        if (planned && seg.kind === 'pass') seats = new Set([...seats].filter(s => s === 'groove' || planned.includes(s)));
        if (seg.voices) seats = new Set([...seats].filter(s => seg.voices.includes(s)));
        return seats;
    }

    _voicingArgs() {
        return {
            voice: this.voice, keyframe: this.arrangement.keyframe, weather: this.arrangement.weather,
            season: this.arrangement.season, band: this.band, piece: this._arrangedPiece,
        };
    }

    // MUS-8: a sixth over each long melody note, snapped to the chord.
    _descantFor(lead, timeline) {
        const out = [];
        for (const note of lead) {
            if (note.beats < DESCANT_MIN_BEATS) continue;
            const chord = [...timeline].reverse().find(c => c.beat <= note.beat + EPS) || timeline[0];
            const pcs = chord ? chordPitchClasses(chord.name)?.pcs : null;
            if (!pcs) continue;
            let semi = note.semi + DESCANT_INTERVAL;
            for (let d = 0; d <= 2; d++) {
                if (pcs.includes(pcOf(semi - d + A4_PC))) { semi -= d; break; }
                if (pcs.includes(pcOf(semi + d + A4_PC))) { semi += d; break; }
            }
            out.push({ beat: note.beat, semi, beats: note.beats });
        }
        return out;
    }

    // ── voices ──

    _player(seatName, instrument) {
        const key = `${seatName}|${instrument}`;
        let player = this._players.get(key);
        if (!player) {
            const seat = this._seats?.[seatName];
            if (!seat) return null;
            player = createInstrument(this.engine, instrument, { dest: seat.bus, rng: this._perform });
            if (!player) return null;
            this._players.set(key, player);
        }
        return player;
    }

    _play(t, ev, seg) {
        const spec = this._voicing.seats?.[ev.seat];
        if (!spec) return;
        // A building that stopped working stops drumming at once, not at the
        // next chunk (6.9: zero percussion when working === 0).
        if (ev.building && !(this._density[ev.building] > 0)) return;
        const instrument = ev.instrument || spec.instrument;
        if (!instrument) return;
        const player = this._player(ev.seat, instrument);
        if (!player) return;
        let hz = 0;
        let semi = null;
        if (ev.seat !== 'percussion' && ev.seat !== 'groove') {
            semi = withinRange(ev.semi + (spec.octaveShift || 0), INSTRUMENTS[instrument]?.range);
            if (semi == null) return;
            hz = noteHz(semi);
        }
        const dur = ev.beats * seg.beatSec * (ev.exactLength ? 1 : (LENGTH[ev.seat] ?? 1));
        player.note(t, hz, dur, ev.vel ?? 1, { bright: spec.bright, soft: spec.soft });
        if (this._listeners.size) {
            this._mark({
                kind: ev.seat === 'percussion' || ev.seat === 'groove' ? 'perc' : 'note',
                t,
                dur,
                seat: ev.seat,
                instrument,
                midi: semi == null ? null : semi + 69,
                vel: ev.vel ?? 1,
                piece: seg.pieceName ?? seg.piece?.name ?? seg.score.name,
                bar: seg.barOffset + Math.floor(ev.beat / seg.bpb + EPS) + 1,
                segment: seg.kind,
                what: seg.what,
                loop: seg.loop,
                ...(ev.building ? { building: ev.building, voice: instrument, step: ev.step } : {}),
                ...(ev.groove ? { groove: true } : {}),
            });
        }
    }

    // ── marks and now-playing ──

    // `state` marks describe what sounds from `t` on; they are kept for
    // `nowPlaying`. Others only reach observers.
    _mark(mark, state = false) {
        if (state) {
            let i = this._marks.length;
            while (i > 0 && this._marks[i - 1].t > mark.t + EPS) i--;
            this._marks.splice(i, 0, mark);
            const now = this.engine.now();
            while (this._marks.length > 2 && this._marks[1].t <= now) this._marks.shift();
            if (this._marks.length > 64) this._marks.splice(0, this._marks.length - 64);
        }
        if (!this._listeners.size) return;
        for (const fn of this._listeners) {
            try { fn({ ...mark }); } catch { /* an observer never breaks the music */ }
        }
    }

    _soundingMark() {
        const now = this.engine.now();
        let mark = null;
        for (const candidate of this._marks) {
            if (candidate.kind === 'start') continue;
            if (candidate.t <= now + EPS) mark = candidate;
            else break;
        }
        return mark;
    }

    // `audio:now-playing` on change only (UX-7): the piece, its title, and
    // the players that sound it (a reseat mid-piece is a change).
    _publishNowPlaying(force = false) {
        const playing = force ? null : this.nowPlaying;
        const key = playing ? `${playing.kind}:${playing.piece}:${playing.lead}:${playing.counter}` : null;
        if (key === this._nowPlayingKey) return;
        this._nowPlayingKey = key;
        eventBus.emit('audio:now-playing', playing
            ? {
                preset: this.preset, kind: playing.kind, piece: playing.piece, title: playing.title,
                lead: playing.lead, counter: playing.counter, reason: playing.reason,
            }
            : { preset: this.preset, kind: null, piece: null, title: null, lead: null, counter: null, reason: null });
    }
}
