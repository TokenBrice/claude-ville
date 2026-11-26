// The Evensong band (spec 04 §5.5, W6.3): the one stinger that plays as a
// visit of its own. At the soft 21:00 chime BgmDirector queues the day's
// score (`composeEvensong`); the Town band's Sequencer finishes the visit it
// is in, takes its breath, and instead of the next piece this engine plays
// the 16 bars on three players only — the lead, the bass and the comp
// (`engine`), no counter, no descant, no percussion — 3 dB under the band.
// The band's next visit opens a breath after the last bar.
//
// The level is the listening harness's (scripts/audio/evensong-harness.mjs):
// the Town band preset trim × the director's band level × −3 dB, routed into
// the music group like the band, with the same per-seat offsets that put a
// three-voice Evensong at the band's −31 LUFS-I target less 3 dB, so the
// harness's loudness pre-gate measures exactly what plays. Notes are placed
// per Transport window (S4), never by timers; a note whose time has passed
// is dropped, never moved.
//
// The Sequencer owns its playlist and has no public "hold" hook, so
// `holdTownBand` wraps the one call where a visit hands over to the next
// (`_planTownBand`, called a breath after a visit ends) on that instance
// only, and hands it back untouched on release.

import { BaseLayer } from '../layers/BaseLayer.js';
import { noteHz } from '../MusicalScale.js';
import { rngStream } from '../Rng.js';
import { INSTRUMENTS, createInstrument } from '../music/Instruments.js';
import { cellScore, engineFigure, nearestVoicing } from '../music/Sequencer.js';
import { voicingFor } from '../music/Voicings.js';
import { EVENSONG_BPM, EVENSONG_DAY_BARS, EVENSONG_GAIN_DB, EVENSONG_VOICES } from './Evensong.js';

const EPS = 1e-6;
const dbToGain = db => Math.pow(10, (Number(db) || 0) / 20);

// Sequencer PRESETS.townBand.trim (S2) and its breath between visits.
export const TOWN_BAND_TRIM = 0.536;
export const EVENSONG_BREATH_SEC = 1.4;
// The Evensong layer's trim: the band's, 3 dB down (EVENSONG_GAIN_DB).
export const EVENSONG_TRIM = TOWN_BAND_TRIM * dbToGain(EVENSONG_GAIN_DB);
// The three-voice balance the harness calibrated against the shipped engine
// and the Isle Band players (no counter, descant or percussion seats): dB on
// top of each seat's voicing gain, per score family.
export const EVENSONG_SEAT_OFFSET_DB = Object.freeze({
    night: Object.freeze({ lead: 4.35, bass: 11.85, engine: 12.35 }),
    day: Object.freeze({ lead: -1.5, bass: 11.7, engine: 11.7 }),
});
// Written length share per seat (the Sequencer's LENGTH for these seats).
export const EVENSONG_LENGTH_SHARE = Object.freeze({ lead: 0.92, bass: 0.98, engine: 0.9 });
// The band a voicing is read at: the harness's steady band.
const EVENSONG_VOICING_BAND = 2;
// After the last written beat, the players ring out this long before the
// engine counts itself finished.
export const EVENSONG_TAIL_SEC = 2;

/**
 * The score as one timed event list, `{ events: [{ seat, t, dur, semi, vel }],
 * totalSec }`, seconds from the first beat: the lead and bass lines, and the
 * comp voiced by nearest inversion on every chord span (the Sequencer's own
 * `nearestVoicing` and `engineFigure`), the close's two bars at the score's
 * ritard. The harness compiles the same list for its pre-gate. Pure.
 */
export function compileEvensongEvents(score) {
    if (!score) return { events: [], totalSec: 0 };
    const cs = cellScore('evensong', score, {
        family: score.family,
        engine: score.engine || 'arpQ',
    });
    const bpb = cs.bpb;
    const baseBeatSec = 60 / (score.bpm || EVENSONG_BPM);
    const ritard = score.close?.ritard || 1;
    const dayBeatEnd = EVENSONG_DAY_BARS * bpb;
    const beatToSec = (beat) => {
        if (beat <= dayBeatEnd) return beat * baseBeatSec;
        return dayBeatEnd * baseBeatSec + (beat - dayBeatEnd) * baseBeatSec * ritard;
    };

    const events = [];
    for (const n of cs.lead) {
        const t = beatToSec(n.beat);
        events.push({ seat: 'lead', t, dur: beatToSec(n.beat + n.beats) - t, semi: n.semi, vel: 0.85 });
    }
    for (const n of cs.bass) {
        const t = beatToSec(n.beat);
        events.push({ seat: 'bass', t, dur: beatToSec(n.beat + n.beats) - t, semi: n.semi, vel: 0.95 });
    }
    let prevComp = null;
    const totalBeats = cs.bars * bpb;
    for (let i = 0; i < cs.timeline.length; i++) {
        const span = cs.timeline[i];
        const b1 = i + 1 < cs.timeline.length ? cs.timeline[i + 1].beat : totalBeats;
        if (b1 <= span.beat + EPS) continue;
        const mel = cs.lead.find(n => n.beat <= span.beat + EPS && n.beat + n.beats > span.beat + EPS);
        const voiced = nearestVoicing(span.name, prevComp, {
            avoidTopPc: mel ? (((mel.semi % 12) + 12) % 12) : null,
        });
        if (!voiced) continue;
        prevComp = voiced.semis;
        const barBeat = Math.floor(span.beat / bpb + EPS) * bpb;
        for (const ev of engineFigure(cs.engine || 'arpQ', voiced.semis, span.beat, b1, bpb, barBeat)) {
            const t = beatToSec(ev.beat);
            events.push({ seat: 'engine', t, dur: beatToSec(ev.beat + ev.beats) - t, semi: ev.semi, vel: ev.vel ?? 0.85 });
        }
    }
    events.sort((a, b) => (a.t - b.t) || (EVENSONG_VOICES.indexOf(a.seat) - EVENSONG_VOICES.indexOf(b.seat)));
    return { events, totalSec: beatToSec(totalBeats) };
}

function withinRange(semi, range) {
    if (!range) return semi;
    let s = semi;
    while (s > range[1]) s -= 12;
    while (s < range[0]) s += 12;
    return s > range[1] ? null : s;
}

/**
 * Hold the Town band's next visit for an Evensong: `onBreath(t)` is asked at
 * each hand-over (`t`, audio seconds, is where the next visit's first note
 * would fall) and returns null to let the band go on, or `{ resumeAt }` to
 * keep the band silent until `resumeAt`. Returns `release()`, which restores
 * the instance's own method. False when the sequencer has no hand-over to
 * hold.
 */
export function holdTownBand(sequencer, onBreath) {
    if (!sequencer || typeof sequencer._planTownBand !== 'function' || typeof onBreath !== 'function') return false;
    const own = Object.prototype.hasOwnProperty.call(sequencer, '_planTownBand') ? sequencer._planTownBand : null;
    const plan = sequencer._planTownBand;
    const held = function heldPlanTownBand(t) {
        let taken = null;
        try {
            taken = onBreath(t);
        } catch {
            taken = null; // an Evensong never stops the band
        }
        const resumeAt = Number(taken?.resumeAt);
        return plan.call(this, Number.isFinite(resumeAt) && resumeAt > t ? resumeAt : t);
    };
    sequencer._planTownBand = held;
    return function release() {
        if (sequencer._planTownBand !== held) return;
        if (own) sequencer._planTownBand = own;
        else delete sequencer._planTownBand;
    };
}

export class BandEngine extends BaseLayer {
    constructor(engine, options = {}) {
        super(engine, {
            trim: EVENSONG_TRIM, group: 'music', director: 'bgm', rng: 'music.evensong.choice', ...options,
        });
        this.name = 'music:evensong';
        this._perform = rngStream('music.evensong.perform');
        this._seats = null;
        this._players = new Map();
        this._song = null; // { events, index, startsAt, endsAt, family }
        this._prepared = null; // the arrangement the seats were built for
        this.dropped = 0;
    }

    /**
     * Build the three seats (lead, bass, comp) and their players for a score
     * family and the band's arrangement, starting the layer at `level` (the
     * director's band level). Call ahead of `play`, so baked players are
     * ready before the first note.
     */
    prepare({ family = 'night', voice = 'isle', keyframe = null, weather = 'clear', season = 'summer', level = 1 } = {}) {
        if (!this.engine?.context) return false;
        if (!this.running) this.start();
        if (!this.running) return false;
        const fam = family === 'day' ? 'day' : 'night';
        const voicing = voicingFor({
            voice,
            keyframe: keyframe || (fam === 'night' ? 'night' : 'golden-hour'),
            weather,
            season,
            band: EVENSONG_VOICING_BAND,
        });
        const offsets = EVENSONG_SEAT_OFFSET_DB[fam];
        const ctx = this.engine.context;
        const now = this.engine.now();
        for (const name of EVENSONG_VOICES) {
            const spec = voicing.seats?.[name];
            const seat = this._seats[name];
            if (!seat) continue;
            seat.spec = spec || null;
            const gain = spec ? dbToGain((Number(spec.gainDb) || 0) + (offsets[name] || 0)) : 0;
            seat.bus.gain.setTargetAtTime(gain, now, 0.02);
            seat.pan.pan?.setTargetAtTime(spec ? Math.max(-1, Math.min(1, Number(spec.pan) || 0)) : 0, now, 0.02);
            seat.air?.gain.setTargetAtTime(spec ? Math.max(0, Number(spec.air) || 0) : 0, now, 0.02);
            if (spec?.instrument) this._player(name, spec.instrument, ctx);
        }
        this.setLevel(level, 0.05);
        this._prepared = { family: fam, voice, keyframe: voicing.keyframe ?? keyframe, voicing };
        return true;
    }

    /**
     * Play `score` from audio time `at`. Returns `{ ok: true, startsAt,
     * endsAt, durationMs }` (endsAt = the last written beat) or
     * `{ ok: false, why }`.
     */
    play(score, { at = null, ...arrangement } = {}) {
        if (!score) return { ok: false, why: 'silent' };
        const family = score.family === 'day' ? 'day' : 'night';
        if (!this._prepared || this._prepared.family !== family || !this.running) {
            if (!this.prepare({ ...arrangement, family })) return { ok: false, why: 'stopped' };
        }
        const { events, totalSec } = compileEvensongEvents(score);
        if (!events.length) return { ok: false, why: 'silent' };
        const startsAt = Math.max(Number(at) || 0, this.engine.now());
        this._song = { events, index: 0, startsAt, endsAt: startsAt + totalSec, family };
        this.registerProcess(this);
        return { ok: true, startsAt, endsAt: startsAt + totalSec, durationMs: Math.round(totalSec * 1000) };
    }

    get playing() {
        return Boolean(this._song) && this.running;
    }

    // True once the song's last written beat and its tail have passed.
    finishedAt(now = this.engine.now()) {
        return !this._song || now >= this._song.endsAt + EVENSONG_TAIL_SEC;
    }

    snapshot() {
        const song = this._song;
        return {
            running: this.running,
            playing: Boolean(song),
            startsAt: song?.startsAt ?? null,
            endsAt: song?.endsAt ?? null,
            notes: song?.events.length ?? 0,
            played: song?.index ?? 0,
            seats: Object.fromEntries(EVENSONG_VOICES.map(name => [name, this._seats?.[name]?.spec?.instrument ?? null])),
            dropped: this.dropped,
        };
    }

    // ── layer lifecycle ──

    _start(ctx) {
        this._seats = {};
        for (const name of EVENSONG_VOICES) {
            const bus = ctx.createGain();
            bus.gain.value = 0;
            let pan = bus;
            if (ctx.createStereoPanner) {
                pan = ctx.createStereoPanner();
                bus.connect(pan);
            }
            pan.connect(this.out);
            const air = this.airSend(0, pan);
            this.track(bus, pan);
            this._seats[name] = { bus, pan, air, spec: null };
        }
        this._prepared = null;
    }

    stop() {
        if (!this.running) return undefined;
        const silentAt = super.stop() ?? this.engine.now();
        for (const player of this._players.values()) player.dispose?.(silentAt);
        this._players.clear();
        this._seats = null;
        this._song = null;
        this._prepared = null;
        return silentAt;
    }

    // ── Transport process ──

    rearm() {}

    schedule(from, to) {
        const song = this._song;
        if (!this.running || !song || !this._seats) return 0;
        let dropped = 0;
        const now = this.engine.now();
        while (song.index < song.events.length) {
            const ev = song.events[song.index];
            const t = song.startsAt + ev.t;
            if (t >= to) break;
            song.index++;
            if (t < from - EPS || t < now - EPS) {
                dropped++;
                continue;
            }
            this._play(t, ev);
        }
        this.dropped += dropped;
        return dropped;
    }

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

    _play(t, ev) {
        const seat = this._seats?.[ev.seat];
        const spec = seat?.spec;
        if (!spec?.instrument) return;
        const player = this._player(ev.seat, spec.instrument);
        if (!player) return;
        const semi = withinRange(ev.semi + (spec.octaveShift || 0), INSTRUMENTS[spec.instrument]?.range);
        if (semi == null) return;
        const dur = Math.max(0.05, ev.dur * (EVENSONG_LENGTH_SHARE[ev.seat] ?? 0.92));
        player.note(t, noteHz(semi), dur, ev.vel ?? 1, { bright: spec.bright, soft: spec.soft });
    }
}
