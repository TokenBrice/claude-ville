// The one music sequencer (plan 2.3, MUS-17, MUSL-6). It plays the one
// songbook for both presets on the Transport, and a voicing table picks the
// instruments:
//
//   Town band — continuous: a time-of-day playlist of through-composed
//   pieces, each looped 2–3 times, one breath between pieces; a working
//   section (rest / light / steady / full) admits the piece's voices and
//   changes only on a four-bar boundary.
//
//   Village — sparse: now and then one of the Village tunes, performed as
//   pickup, a form (A-A-B-A and kin, repeated sections varied) and an outro,
//   then a long rest. A phase-family change (day → night) sends the tune
//   straight to its outro at the next section.
//
// Scheduling is per window (S4): the Transport hands the sequencer a window
// of audio time and it places every note inside it; nothing is committed
// further ahead than the window, and a note whose time has passed is dropped
// and counted, never moved to now. What is sounding is published to the
// MusicClock once per four-bar chunk (Town band) or section (Village).
// Randomness comes from the sequencer's own seeded streams: `choice` (tune,
// form, variation, loop count, rests) and `perform` (humanization, noise).

import { BaseLayer } from '../layers/BaseLayer.js';
import { MIN_GAIN, rand, pick } from '../AudioEngine.js';
import { makeFilter } from '../Filters.js';
import { noteHz } from '../MusicalScale.js';
import { rngStream } from '../Rng.js';
import {
    CHORDS, PENTATONIC, PIECES, PLAYLISTS, VILLAGE_BASS_ROOT, VILLAGE_FORMS, VILLAGE_TUNES, chordPitchClasses,
} from '../bgm/BgmSongbook.js';
import { DEFAULT_VOICING, voicingFor } from './Voicings.js';

const BEATS_PER_BAR = 4;
const TONIC_PC = 9; // every piece is in A
// A note's source stops this long after its envelope reaches MIN_GAIN.
const NOTE_TAIL_SEC = 0.08;
// The night pad releases as a setTarget decay; its source stops after seven
// time constants, when the tail is 60 dB down (S8).
const PAD_RELEASE_TAU = 0.3;
const PAD_TAIL_SEC = PAD_RELEASE_TAU * 7;

// ── Town band ──
const CHUNK_BEATS = 16; // four bars: the grain of section changes and clock frames
const PIECE_BREATH_SEC = 1.4; // one breath between tunes, on the audio clock
const FIRST_PIECE_SEC = 0.6;
// 5.3 — arrangement sections. Each admits one more of the piece's compiled
// voices: a resting village keeps the tune and the bass; work adds the
// written counter line, then the eighth-note engine, then the percussion.
const SECTION_VOICES = Object.freeze({
    rest: new Set(['lead', 'bell', 'bass']),
    light: new Set(['lead', 'bell', 'bass', 'counter', 'pad']),
    steady: new Set(['lead', 'bell', 'bass', 'counter', 'pad', 'arp']),
    full: new Set(['lead', 'bell', 'bass', 'counter', 'pad', 'arp', 'hat']),
});

// ── Village ──
// Dusk slows the band and nothing else: every voice keeps its written
// register (MUS-13). `gain` scales every note of the arrangement.
const VILLAGE_ARRANGEMENTS = Object.freeze({
    dawn: Object.freeze({ mode: 'major', tempoScale: 0.9, gain: 0.8 }),
    day: Object.freeze({ mode: 'major', tempoScale: 1, gain: 1 }),
    dusk: Object.freeze({ mode: 'major', tempoScale: 0.8, gain: 0.9 }),
    night: Object.freeze({ mode: 'minor', tempoScale: 1, gain: 0.85 }),
});
const SECTION_BARS = 4;
// The first tune waits 2.5–5 s; a tune never starts below this layer level
// (it looks again 4 s later); after a tune the village rests 9–22 s, scaled
// by the director's rest scale. The rest is counted from 1.5 s before the
// outro ends and every start lands 0.15 s after its slot, as the timer chain
// this replaced did.
const VILLAGE_FIRST_SEC = [2.5, 5];
const VILLAGE_REST_SEC = [9, 22];
const VILLAGE_RETRY_SEC = 4;
const VILLAGE_REST_FROM_END_SEC = -1.5;
const VILLAGE_START_LEAD_SEC = 0.15;
const VILLAGE_MIN_LEVEL = 0.04;
const MELODY_JITTER_SEC = 0.007;
// Outro voices relative to the melody voice's level.
const OUTRO_ROOT_VEL = 0.035 / 0.042;
const OUTRO_FIFTH_VEL = 0.024 / 0.042;

const PRESETS = Object.freeze({
    // Puts the Town band at −31 LUFS-I with its stem short-term max under
    // −28 at the standard step (S2, probe `townBand`): 0.49 on the Wave-1
    // program trim, 0.565 (+1.2 dB) on Wave 4's 26.7 dB.
    townBand: Object.freeze({ trim: 0.565, director: 'bgm' }),
    village: Object.freeze({ trim: 0.5, director: 'ambient' }),
});

const byBeat = (a, b) => a.beat - b.beat;

function timedChord(name, time) {
    const pcs = chordPitchClasses(name);
    return pcs ? { time, ...pcs } : null;
}

/**
 * One loop of a Town band piece as beat events for every voice, plus its
 * chord timeline (`{ beat, name }`, half-bar splits included). Pure.
 */
export function compileTownBandPiece(piece) {
    const events = [];
    const chords = [];
    const pushNotes = (notes, voice) => {
        let beat = 0;
        for (const [semi, beats] of notes) {
            if (semi != null) events.push({ beat, semi, beats, voice });
            beat += beats;
        }
    };
    pushNotes(piece.melody, piece.lead === 'bell' ? 'bell' : 'lead');
    pushNotes(piece.bass, 'bass');
    if (piece.counter === 'written' && piece.counterNotes) pushNotes(piece.counterNotes, 'counter');

    piece.chords.forEach((entry, bar) => {
        const halves = Array.isArray(entry) ? entry : [entry, entry];
        const barBeat = bar * BEATS_PER_BAR;
        chords.push({ beat: barBeat, name: halves[0] });
        if (halves[1] !== halves[0]) chords.push({ beat: barBeat + BEATS_PER_BAR / 2, name: halves[1] });
        if (piece.counter === 'arp8') {
            // Constant eighth-note motion — the reference towns' engine.
            const arpPattern = [0, 1, 2, 1];
            for (let i = 0; i < 8; i++) {
                const chord = CHORDS[halves[i < 4 ? 0 : 1]];
                events.push({ beat: barBeat + i * 0.5, semi: chord[arpPattern[i % 4]], beats: 0.45, voice: 'arp' });
            }
        } else if (piece.counter === 'pad') {
            for (const semi of CHORDS[halves[0]]) {
                events.push({ beat: barBeat, semi, beats: BEATS_PER_BAR - 0.1, voice: 'pad' });
            }
        }
        if (piece.perc === 'hat8') {
            for (let i = 0; i < 8; i++) events.push({ beat: barBeat + i * 0.5, voice: 'hat', accent: i % 2 === 0 });
        } else if (piece.perc === 'ticks') {
            events.push({ beat: barBeat + 1, voice: 'hat', accent: false });
            events.push({ beat: barBeat + 3, voice: 'hat', accent: false });
        }
    });
    events.sort(byBeat);
    return { events, chords, totalBeats: piece.chords.length * BEATS_PER_BAR };
}

// A repeated section's phrase-end flourish: the final long note is held one
// beat shorter and followed by two pentatonic passing eighths.
function withFill(melody, mode) {
    const last = melody[melody.length - 1];
    if (!last || last[0] == null || last[1] < 2) return melody;
    const pool = PENTATONIC[mode];
    const i = pool.indexOf(last[0]);
    if (i < 1) return melody;
    const upper = pool[Math.min(pool.length - 1, i + 1)];
    return [...melody.slice(0, -1), [last[0], last[1] - 1], [upper, 0.5], [pool[i - 1], 0.5]];
}

/**
 * The Village performance plan of one tune: pickup, form, outro, with the
 * repeated sections varied. Draws from `rng` exactly as the shipped composer.
 */
export function planVillageSong(rng) {
    const form = pick(rng, VILLAGE_FORMS);
    const queue = [{ kind: 'pickup' }, ...form.map(kind => ({ kind })), { kind: 'outro' }];
    const seen = {};
    for (const step of queue) {
        if (step.kind !== 'A' && step.kind !== 'B') continue;
        seen[step.kind] = (seen[step.kind] || 0) + 1;
        if (seen[step.kind] > 1) step.variation = pick(rng, ['timbre', 'fill']);
    }
    return queue;
}

/**
 * One step of a Village performance as beat events from the step's start,
 * with its chord timeline. `rng` humanizes the melody (±7 ms, velocity).
 */
export function compileVillageStep(song, step, arrangement, rng) {
    const events = [];
    const g = arrangement.gain;
    const firstChord = song.sections.A.chords[0];
    const bass = (beat, chord, { rootOnly = false } = {}) => {
        const root = VILLAGE_BASS_ROOT[chord];
        if (root == null) return;
        // Root on beat 1, fifth on beat 3, each held (almost) to the next.
        events.push({ beat, voice: 'bass', semi: root, beats: 1.98, vel: g });
        if (!rootOnly) events.push({ beat: beat + 2, voice: 'bass', semi: root + 7, beats: 1.98, vel: g * 0.85 });
    };
    const accomp = (beat, chord, style) => {
        const tones = CHORDS[chord];
        if (!tones) return;
        if (style === 'arp8' || style === 'arpQ') {
            const stepBeats = style === 'arp8' ? 0.5 : 1;
            const count = style === 'arp8' ? 8 : 4;
            const pattern = [0, 1, 2, 1];
            // A plucked note is at most 0.3 s whatever the tempo.
            const beats = Math.min(0.3 / arrangement.beatSec, stepBeats * 0.9);
            for (let i = 0; i < count; i++) {
                events.push({ beat: beat + i * stepBeats, voice: 'arp', semi: tones[pattern[i % 4]], beats, vel: g });
            }
        } else {
            for (const hit of style === 'block1' ? [0] : [0, 2]) {
                for (const semi of tones) events.push({ beat: beat + hit, voice: 'chords', semi, beats: 0.5, vel: g });
            }
        }
    };

    if (step.kind === 'pickup') {
        bass(0, firstChord, { rootOnly: true });
        accomp(0, firstChord, 'arpQ');
        events.sort(byBeat);
        return { beats: BEATS_PER_BAR, events, chords: [{ beat: 0, name: firstChord }] };
    }
    if (step.kind === 'outro') {
        // The tonic rings out: bass root, the lead on root and fifth.
        const root = VILLAGE_BASS_ROOT[firstChord];
        events.push({ beat: 0, voice: 'bass', semi: root, beats: BEATS_PER_BAR * 1.3, scale: 1, vel: g });
        events.push({
            beat: 0, voice: 'melody', semi: root + 24, beats: BEATS_PER_BAR * 1.2, scale: 1,
            vel: OUTRO_ROOT_VEL * g, timbre: song.lead, vib: true,
        });
        events.push({
            beat: 1, voice: 'melody', semi: root + 31, beats: BEATS_PER_BAR, scale: 1,
            vel: OUTRO_FIFTH_VEL * g, timbre: song.lead, vib: true,
        });
        return { beats: BEATS_PER_BAR * 1.5, events, chords: [{ beat: 0, name: firstChord }] };
    }

    const section = song.sections[step.kind];
    const timbre = step.variation === 'timbre' ? song.leadAlt : song.lead;
    const melody = step.variation === 'fill' ? withFill(section.melody, arrangement.mode) : section.melody;
    let beat = 0;
    for (const [semi, beats] of melody) {
        if (semi != null) {
            const offset = rand(rng, -MELODY_JITTER_SEC, MELODY_JITTER_SEC);
            const accent = beat % BEATS_PER_BAR === 0 ? 1.12 : rand(rng, 0.85, 1);
            events.push({ beat, voice: 'melody', semi, beats, vel: g * accent, timbre, offset });
        }
        beat += beats;
    }
    const chords = [];
    for (let bar = 0; bar < SECTION_BARS; bar++) {
        const chord = section.chords[bar] || section.chords[section.chords.length - 1];
        chords.push({ beat: bar * BEATS_PER_BAR, name: chord });
        bass(bar * BEATS_PER_BAR, chord);
        accomp(bar * BEATS_PER_BAR, chord, section.accomp);
    }
    events.sort(byBeat);
    return { beats: SECTION_BARS * BEATS_PER_BAR, events, chords };
}

export class Sequencer extends BaseLayer {
    constructor(engine, { preset = 'townBand', voicing = DEFAULT_VOICING, ...options } = {}) {
        const config = PRESETS[preset];
        if (!config) throw new Error(`unknown music preset ${preset}`);
        super(engine, {
            trim: config.trim, director: config.director, ...options, group: 'music', rng: `music.${preset}.choice`,
        });
        this.preset = preset;
        this.name = `music:${preset}`;
        this.voicing = voicingFor(voicing, preset);
        this.phase = 'day';
        this.section = 'steady';
        this.restScale = 1;
        this._pendingSection = null;
        this._choice = this.rng;
        this._perform = rngStream(`music.${preset}.perform`);
        this._seats = null;
        this._airSends = {};
        this._songSources = new Set();
        this._listeners = new Set();
        this._marks = [];
        this._pinned = null;
        this._lastName = null;
        this._nextAt = null; // audio time of the next piece / tune slot while idle
        this._cur = null; // the piece or tune being played
        this._skipBefore = -Infinity; // notes before a re-arm are skipped, not dropped
    }

    // ── public API ──

    get pendingSection() {
        return this._pendingSection;
    }

    // Town band: queue an arrangement density; it lands on the next four-bar
    // boundary, so a change never cuts a bar in half.
    setSection(name) {
        if (!SECTION_VOICES[name]) return false;
        if (name === (this._pendingSection ?? this.section)) return false;
        this._pendingSection = name === this.section ? null : name;
        return this._pendingSection != null;
    }

    setPhase(phase) {
        const known = this.preset === 'townBand' ? PLAYLISTS[phase] : VILLAGE_ARRANGEMENTS[phase];
        if (!known) return;
        this.phase = phase;
        this.engine.musicClock?.setPhase(phase);
    }

    // Village: the director's rest scale (busier village, shorter rests).
    setRestScale(value) {
        this.restScale = Math.max(0.4, Math.min(1.6, Number(value) || 1));
    }

    // Probe and QA: `{ piece: name }` makes that piece (Town band) or tune
    // (Village) the only candidate from the next start on; `null` releases it.
    pin(spec) {
        const name = spec?.piece ?? null;
        if (name !== null && !this._book().some(p => p.name === name)) return false;
        this._pinned = name;
        return true;
    }

    // Marks at schedule time (audio time `t`), for the probe's timeline:
    // Town band `loop` / `chunk` / `pieceEnd`, Village `section` / `songEnd`.
    observe(fn) {
        this._listeners.add(fn);
        return () => this._listeners.delete(fn);
    }

    // What is sounding now (not what is committed ahead).
    get nowPlaying() {
        const now = this.engine.now();
        let mark = null;
        for (const candidate of this._marks) {
            if (candidate.t <= now) mark = candidate;
            else break;
        }
        if (!mark) return null;
        if (mark.kind === 'section') {
            return { song: mark.song, section: mark.step, index: mark.index, variation: mark.variation };
        }
        if (mark.kind === 'loop' || mark.kind === 'chunk') {
            const barSec = mark.beatSec * BEATS_PER_BAR;
            return {
                piece: mark.piece,
                bar: Math.min(mark.bars, Math.floor((now - mark.loopStart) / barSec) + 1),
                bars: mark.bars,
                loop: mark.loop,
                of: mark.of,
                section: mark.section,
            };
        }
        return null;
    }

    // ── layer lifecycle ──

    _start(ctx) {
        this._seats = {};
        for (const [name, seat] of Object.entries(this.voicing.seats)) {
            const bus = ctx.createGain();
            const tone = makeFilter(ctx, seat.filter[0], seat.filter[1], { q: 'butterworth' });
            let tail = tone;
            if (ctx.createStereoPanner) {
                tail = ctx.createStereoPanner();
                tail.pan.value = seat.pan;
                tone.connect(tail);
            }
            bus.connect(tone);
            tail.connect(this.out);
            this.track(bus, tone, tail);
            this._seats[name] = bus;
            if (seat.air) this._airSends[name] = this.airSend(seat.air, tail);
        }
        const now = ctx.currentTime;
        this._nextAt = this.preset === 'townBand'
            ? now + FIRST_PIECE_SEC
            : now + rand(this._choice, ...VILLAGE_FIRST_SEC) + VILLAGE_START_LEAD_SEC;
        this.registerProcess(this);
    }

    stop() {
        const silentAt = super.stop() ?? this.engine.now();
        for (const src of this._songSources) {
            try { src.stop(silentAt + 0.01); } catch { /* already stopped */ }
        }
        this._songSources.clear();
        this.engine.musicClock?.clear(this.preset);
        this._seats = null;
        this._airSends = {};
        this._cur = null;
        this._nextAt = null;
        this._marks = [];
        return silentAt;
    }

    // ── Transport process ──

    rearm(now) {
        this._skipBefore = now;
        if (this._nextAt !== null && this._nextAt < now) this._nextAt = now;
    }

    schedule(from, to) {
        if (!this.running || !this.engine.context || !this._seats) return 0;
        return this.preset === 'townBand' ? this._scheduleTownBand(from, to) : this._scheduleVillage(from, to);
    }

    _book() {
        return this.preset === 'townBand' ? PIECES : VILLAGE_TUNES;
    }

    _mark(mark) {
        this._marks.push(mark);
        // Keep what can still be sounding: marks up to the current one.
        const now = this.engine.now();
        while (this._marks.length > 2 && this._marks[1].t <= now) this._marks.shift();
        for (const fn of this._listeners) {
            try { fn({ ...mark }); } catch { /* an observer never breaks the music */ }
        }
    }

    // A note whose written time is behind the window, or whose placed
    // (humanized) time is behind the audio clock, is dropped and counted —
    // never moved to now. Windows split on written time, so a humanized note
    // just ahead of its window edge is not late.
    _late(nominal, from, at = nominal) {
        return nominal < from || at < this.engine.now();
    }

    // ── Town band ──

    _playlist() {
        if (this._pinned) return PIECES.filter(p => p.name === this._pinned);
        const names = PLAYLISTS[this.phase] || PLAYLISTS.day;
        return PIECES.filter(p => names.includes(p.name));
    }

    _startPiece(t0) {
        const list = this._playlist();
        const candidates = list.filter(p => p.name !== this._lastName);
        const piece = pick(this._choice, candidates.length ? candidates : list);
        this._lastName = piece.name;
        const compiled = compileTownBandPiece(piece);
        this._cur = {
            piece,
            ...compiled,
            beatSec: 60 / piece.bpm,
            loop: 0,
            loopsPlanned: 2 + (this._choice() < 0.4 ? 1 : 0),
            loopStart: t0,
            beat: 0, // the next chunk boundary to open
            index: 0, // the next event
            openChunk: -1,
        };
        const leadAir = this._airSends.lead;
        if (leadAir && piece.air != null) leadAir.gain.setTargetAtTime(piece.air, t0, 0.5);
    }

    _scheduleTownBand(from, to) {
        let dropped = 0;
        for (;;) {
            if (!this._cur) {
                if (this._nextAt === null || this._nextAt >= to) return dropped;
                this._startPiece(this._nextAt);
                this._nextAt = null;
            }
            const cur = this._cur;
            while (cur.beat < cur.totalBeats) {
                const chunkStart = cur.beat;
                const chunkEnd = Math.min(chunkStart + CHUNK_BEATS, cur.totalBeats);
                if (cur.openChunk !== chunkStart) {
                    if (cur.loopStart + chunkStart * cur.beatSec >= to) return dropped;
                    this._openChunk(cur, chunkStart, chunkEnd);
                }
                while (cur.index < cur.events.length && cur.events[cur.index].beat < chunkEnd) {
                    const ev = cur.events[cur.index];
                    const t = cur.loopStart + ev.beat * cur.beatSec;
                    if (t >= to) return dropped;
                    cur.index++;
                    if (t < this._skipBefore) continue;
                    if (this._late(t, from)) {
                        dropped++;
                        continue;
                    }
                    this._playTownBandEvent(t, ev, cur.beatSec);
                }
                cur.beat = chunkEnd;
            }
            // Loop boundary: loop seamlessly unless the piece has played its
            // loops or the time-of-day playlist no longer holds it.
            const endT = cur.loopStart + cur.totalBeats * cur.beatSec;
            if (endT >= to) return dropped;
            cur.loop += 1;
            const stillListed = this._playlist().some(p => p.name === cur.piece.name);
            if (cur.loop < cur.loopsPlanned && stillListed) {
                Object.assign(cur, { loopStart: endT, beat: 0, index: 0, openChunk: -1 });
            } else {
                // The next tune starts a breath after this one's written end.
                this._mark({ kind: 'pieceEnd', t: endT, piece: cur.piece.name });
                this._cur = null;
                this._nextAt = endT + PIECE_BREATH_SEC;
            }
        }
    }

    // A four-bar boundary: a queued section lands, the chunk's chords go to
    // the MusicClock, and the chunk is marked.
    _openChunk(cur, chunkStart, chunkEnd) {
        cur.openChunk = chunkStart;
        if (this._pendingSection) {
            this.section = this._pendingSection;
            this._pendingSection = null;
        }
        const t = cur.loopStart + chunkStart * cur.beatSec;
        const until = cur.loopStart + chunkEnd * cur.beatSec;
        // The chord in force at the chunk start opens the frame.
        let first = 0;
        for (let i = 0; i < cur.chords.length; i++) if (cur.chords[i].beat <= chunkStart) first = i;
        const chords = cur.chords
            .filter((c, i) => i >= first && c.beat < chunkEnd)
            .map(c => timedChord(c.name, cur.loopStart + Math.max(c.beat, chunkStart) * cur.beatSec));
        this.engine.musicClock?.publish({
            source: this.preset,
            key: { tonicPc: TONIC_PC, mode: cur.piece.family === 'night' ? 'minor' : 'major' },
            originTime: cur.loopStart,
            beatSec: cur.beatSec,
            beatsPerBar: BEATS_PER_BAR,
            chords,
            until,
        });
        this._mark({
            kind: chunkStart === 0 ? 'loop' : 'chunk',
            t,
            piece: cur.piece.name,
            bar: chunkStart / BEATS_PER_BAR + 1,
            bars: cur.piece.chords.length,
            loop: cur.loop + 1,
            of: cur.loopsPlanned,
            section: this.section,
            loopStart: cur.loopStart,
            beatSec: cur.beatSec,
            loopSeconds: cur.totalBeats * cur.beatSec,
        });
    }

    _playTownBandEvent(t, ev, beatSec) {
        // Voices the section does not admit are never synthesised.
        if (!SECTION_VOICES[this.section]?.has(ev.voice)) return;
        const voice = this.voicing.voices[ev.voice];
        if (!voice) return;
        if (voice.env === 'tick') {
            this._hat(t, voice, ev.accent);
            return;
        }
        this._note(t, voice, ev, beatSec);
    }

    // ── Village ──

    _scheduleVillage(from, to) {
        let dropped = 0;
        for (;;) {
            if (!this._cur) {
                if (this._nextAt === null || this._nextAt >= to) return dropped;
                const at = Math.max(this._nextAt, from);
                if (this.level > VILLAGE_MIN_LEVEL) {
                    this._startSong(at);
                    this._nextAt = null;
                } else {
                    this._nextAt = at + VILLAGE_RETRY_SEC + VILLAGE_START_LEAD_SEC;
                    continue;
                }
            }
            const cur = this._cur;
            if (!cur.step) {
                if (cur.stepStart >= to) return dropped;
                if (!this._openStep(cur)) continue;
            }
            const { step } = cur;
            while (cur.index < step.events.length) {
                const ev = step.events[cur.index];
                const nominal = cur.stepStart + ev.beat * cur.beatSec;
                if (nominal >= to) return dropped;
                cur.index++;
                const t = nominal + (ev.offset || 0);
                if (t < this._skipBefore) continue;
                if (this._late(nominal, from, t)) {
                    dropped++;
                    continue;
                }
                this._note(t, this.voicing.voices[ev.voice], ev, cur.beatSec);
            }
            // The next step starts where this one ends.
            cur.stepStart += step.beats * cur.beatSec;
            cur.step = null;
            cur.index = 0;
            cur.position += 1;
        }
    }

    _startSong(t0) {
        const arrangement = VILLAGE_ARRANGEMENTS[this.phase] || VILLAGE_ARRANGEMENTS.day;
        const book = this._pinned
            ? VILLAGE_TUNES.filter(s => s.name === this._pinned)
            : VILLAGE_TUNES.filter(s => s.mode === arrangement.mode);
        const candidates = book.filter(s => s.name !== this._lastName);
        const song = pick(this._choice, candidates.length ? candidates : book);
        this._lastName = song.name;
        const beatSec = 60 / (song.bpm * arrangement.tempoScale);
        this._cur = {
            song,
            arrangement: { ...arrangement, beatSec },
            beatSec,
            queue: planVillageSong(this._choice),
            position: 0,
            stepStart: t0,
            step: null,
            index: 0,
        };
    }

    // Opens the step at `cur.position` (a phase-family change jumps to the
    // outro); past the outro the song ends and the rest is drawn. Returns
    // false when the song ended.
    _openStep(cur) {
        const nowMode = (VILLAGE_ARRANGEMENTS[this.phase] || VILLAGE_ARRANGEMENTS.day).mode;
        if (cur.position > 0 && nowMode !== cur.arrangement.mode && cur.queue[cur.position]?.kind !== 'outro') {
            const outro = cur.queue.findIndex((s, i) => i > cur.position && s.kind === 'outro');
            if (outro > 0) cur.position = outro;
        }
        const t0 = cur.stepStart;
        if (cur.position >= cur.queue.length) {
            this._mark({ kind: 'songEnd', t: t0, song: cur.song.name });
            this._cur = null;
            const rest = rand(this._choice, ...VILLAGE_REST_SEC) * this.restScale;
            this._nextAt = Math.max(t0, t0 + VILLAGE_REST_FROM_END_SEC + rest + VILLAGE_START_LEAD_SEC);
            return false;
        }
        const queued = cur.queue[cur.position];
        cur.step = compileVillageStep(cur.song, queued, cur.arrangement, this._perform);
        cur.index = 0;
        this.engine.musicClock?.publish({
            source: this.preset,
            key: { tonicPc: TONIC_PC, mode: cur.song.mode },
            originTime: t0,
            beatSec: cur.beatSec,
            beatsPerBar: BEATS_PER_BAR,
            chords: cur.step.chords.map(c => timedChord(c.name, t0 + c.beat * cur.beatSec)),
            until: t0 + cur.step.beats * cur.beatSec,
        });
        this._mark({
            kind: 'section',
            t: t0,
            song: cur.song.name,
            step: queued.kind,
            index: cur.position,
            variation: queued.variation || null,
        });
        return true;
    }

    // ── voices ──

    // One pitched note: oscillator → envelope → seat (≤ 4 nodes with vibrato).
    _note(t, voice, ev, beatSec) {
        const ctx = this.engine.context;
        const bus = this._seats?.[voice.seat];
        if (!ctx || !bus) return;
        const scale = ev.scale ?? voice.length.scale;
        const sec = Math.max(voice.length.min, ev.beats * beatSec * scale);
        const level = voice.gain * (ev.vel ?? 1);
        const timbre = ev.timbre || voice.timbre;

        const osc = ctx.createOscillator();
        const env = ctx.createGain();
        const wave = this.engine.wave(timbre);
        if (wave) osc.setPeriodicWave(wave);
        else osc.type = timbre;
        osc.frequency.value = noteHz(ev.semi + (voice.transpose || 0));

        const g = env.gain;
        g.setValueAtTime(MIN_GAIN, t);
        let stopAt;
        if (voice.env === 'pluck') {
            g.exponentialRampToValueAtTime(level, t + 0.008);
            g.exponentialRampToValueAtTime(MIN_GAIN, t + sec);
            stopAt = t + sec + NOTE_TAIL_SEC;
        } else if (voice.env === 'swell') {
            g.setTargetAtTime(level, t, 0.4);
            g.setTargetAtTime(0, t + sec - 0.4, PAD_RELEASE_TAU);
            stopAt = t + sec - 0.4 + PAD_TAIL_SEC;
        } else {
            g.exponentialRampToValueAtTime(level, t + voice.attack);
            g.setValueAtTime(level, t + Math.max(0.02, sec - voice.release));
            g.exponentialRampToValueAtTime(MIN_GAIN, t + sec);
            stopAt = t + sec + NOTE_TAIL_SEC;
        }

        const extras = [];
        const vibrato = voice.vibrato;
        if (vibrato && (ev.vib ?? ev.beats >= vibrato.minBeats) && sec > vibrato.minSec) {
            const lfo = ctx.createOscillator();
            const depth = ctx.createGain();
            lfo.type = 'sine';
            lfo.frequency.value = vibrato.rate;
            depth.gain.setValueAtTime(0, t);
            depth.gain.linearRampToValueAtTime(vibrato.cents, t + vibrato.rise);
            lfo.connect(depth).connect(osc.detune);
            lfo.start(t);
            lfo.stop(t + sec + 0.1);
            extras.push(lfo, depth);
        }

        osc.connect(env).connect(bus);
        osc.start(t);
        osc.stop(stopAt);
        this._own(osc, env, extras);
    }

    // A whisper of noise percussion from the shared pool, folded to mono so
    // the hats keep one seat (the √2 restores the fold's −3 dB).
    _hat(t, voice, accent) {
        const ctx = this.engine.context;
        const bus = this._seats?.[voice.seat];
        const src = this.engine.noiseSource?.(voice.noise, { rng: this._perform, oneShot: true });
        if (!ctx || !bus || !src) return;
        const env = ctx.createGain();
        env.channelCount = 1;
        env.channelCountMode = 'explicit';
        const level = voice.gain * (accent ? voice.accent : 1) * Math.SQRT2;
        env.gain.setValueAtTime(MIN_GAIN, t);
        env.gain.exponentialRampToValueAtTime(level, t + 0.004);
        env.gain.exponentialRampToValueAtTime(MIN_GAIN, t + 0.035);
        src.connect(env).connect(bus);
        src.start(t);
        src.stop(t + 0.05);
        this._own(src, env, []);
    }

    _own(src, env, extras) {
        this._songSources.add(src);
        src.onended = () => {
            this._songSources.delete(src);
            try {
                src.disconnect();
                env.disconnect();
                for (const node of extras) node.disconnect();
            } catch { /* gone */ }
        };
    }
}
