// Village theme: a retro-game music layer. An authored 8-bar melody with a
// walking bass, voiced like an old console (square-wave lead, triangle bass,
// low-passed soft), loops with short breathing rests like an RPG town theme.
// The arrangement follows the time of day: brisk and bright at noon, slower
// and an octave lower at dusk, a sparse minor-pentatonic lullaby at night.
//
// Notes are [semitonesFromA4, beats]; null pitch is a rest. Every theme stays
// inside the shared pentatonic vocabulary (MusicalScale) so the tonal bed and
// cues can never clash with it.

import { BaseLayer } from './BaseLayer.js';
import { MIN_GAIN, rand } from '../AudioEngine.js';
import { noteHz } from '../MusicalScale.js';

const THEMES = {
    // A major pentatonic, 8 bars of 4/4 — a small folk tune for the village.
    day: {
        melody: [
            [-5, 1], [-3, 0.5], [0, 0.5], [2, 1], [0, 1],
            [-3, 1.5], [-5, 0.5], [-8, 2],
            [-5, 1], [-3, 0.5], [0, 0.5], [2, 1], [4, 1],
            [2, 2], [0, 2],
            [0, 1], [2, 0.5], [4, 0.5], [7, 1], [4, 1],
            [2, 1.5], [0, 0.5], [-3, 2],
            [-5, 1], [-3, 0.5], [0, 0.5], [-3, 1], [-5, 1],
            [0, 3], [null, 1],
        ],
        bass: [
            [-24, 2], [-17, 2],
            [-24, 2], [-17, 2],
            [-24, 2], [-17, 2],
            [-17, 2], [-15, 2],
            [-24, 2], [-17, 2],
            [-15, 2], [-17, 2],
            [-24, 2], [-17, 2],
            [-24, 4],
        ],
    },
    // A minor pentatonic, slow and sparse — the night watch's lullaby.
    night: {
        melody: [
            [0, 2], [-2, 1], [-5, 1],
            [3, 3], [null, 1],
            [0, 1], [-2, 1], [-5, 1], [-7, 1],
            [-9, 3], [null, 1],
            [-5, 1], [-2, 1], [0, 1], [3, 1],
            [0, 2], [-2, 2],
            [-5, 2], [-7, 1], [-9, 1],
            [-12, 3], [null, 1],
        ],
        bass: [
            [-24, 4],
            [-24, 4],
            [-26, 4],
            [-24, 4],
            [-24, 4],
            [-26, 4],
            [-17, 4],
            [-24, 4],
        ],
    },
};

const ARRANGEMENTS = {
    dawn: { theme: 'day', bpm: 72, octave: 0, gain: 0.8 },
    day: { theme: 'day', bpm: 84, octave: 0, gain: 1 },
    dusk: { theme: 'day', bpm: 66, octave: -12, gain: 0.9 },
    night: { theme: 'night', bpm: 58, octave: 0, gain: 0.85 },
};

export class MusicLayer extends BaseLayer {
    constructor(engine) {
        super(engine, { trim: 0.5 });
        this.phase = 'day';
        this.restScale = 1;
        this.melodyBus = null;
        this.bassBus = null;
        this._songSources = new Set();
        this._playing = false;
    }

    _start(ctx) {
        const melodyTone = ctx.createBiquadFilter();
        melodyTone.type = 'lowpass';
        melodyTone.frequency.value = 2400;
        melodyTone.Q.value = 0.4;

        this.melodyBus = ctx.createGain();
        this.melodyBus.gain.value = 1;
        this.melodyBus.connect(melodyTone).connect(this.out);

        const bassTone = ctx.createBiquadFilter();
        bassTone.type = 'lowpass';
        bassTone.frequency.value = 900;
        bassTone.Q.value = 0.4;

        this.bassBus = ctx.createGain();
        this.bassBus.gain.value = 1;
        this.bassBus.connect(bassTone).connect(this.out);

        // A touch of echo gives the lead the "town square" distance.
        const delay = ctx.createDelay(1.5);
        delay.delayTime.value = 0.42;
        const feedback = ctx.createGain();
        feedback.gain.value = 0.14;
        const delayTone = ctx.createBiquadFilter();
        delayTone.type = 'lowpass';
        delayTone.frequency.value = 2000;
        delayTone.Q.value = 0.3;
        const delayReturn = ctx.createGain();
        delayReturn.gain.value = 0.12;
        const delaySend = ctx.createGain();
        delaySend.gain.value = 0.24;

        this.melodyBus.connect(delaySend).connect(delay);
        delay.connect(delayTone).connect(feedback).connect(delay);
        delayTone.connect(delayReturn).connect(this.out);

        this.track(melodyTone, this.melodyBus, bassTone, this.bassBus,
            delay, feedback, delayTone, delayReturn, delaySend);
        // First tune shortly after enabling, so the toggle feels rewarding.
        this._scheduleSong(rand(2500, 5000));
    }

    setPhase(phase) {
        if (ARRANGEMENTS[phase]) this.phase = phase;
    }

    setRestScale(value) {
        this.restScale = Math.max(0.4, Math.min(1.6, Number(value) || 1));
    }

    _scheduleSong(delayMs) {
        this.timer(() => {
            if (this.level > 0.04 && !this._playing) this._playSong();
            else this._scheduleSong(4000);
        }, delayMs);
    }

    _playSong() {
        const ctx = this.engine.context;
        if (!ctx || !this.melodyBus) return;
        const arrangement = ARRANGEMENTS[this.phase] || ARRANGEMENTS.day;
        const theme = THEMES[arrangement.theme];
        const beatSec = 60 / arrangement.bpm;
        const t0 = ctx.currentTime + 0.1;
        this._playing = true;

        const melodyEnd = this._scheduleVoice(theme.melody, {
            t0,
            beatSec,
            octave: arrangement.octave,
            type: 'square',
            gain: 0.042 * arrangement.gain,
            bus: this.melodyBus,
            staccato: 0.86,
        });
        this._scheduleVoice(theme.bass, {
            t0,
            beatSec,
            octave: 0,
            type: 'triangle',
            gain: 0.06 * arrangement.gain,
            bus: this.bassBus,
            staccato: 0.94,
        });

        // Rest, then play again — a town theme that breathes between loops.
        const songMs = (melodyEnd - ctx.currentTime) * 1000;
        const restMs = rand(8000, 18000) * this.restScale;
        this.timer(() => { this._playing = false; }, songMs + 200);
        this._scheduleSong(songMs + restMs);
    }

    _scheduleVoice(notes, { t0, beatSec, octave, type, gain, bus, staccato }) {
        let t = t0;
        for (const [semi, beats] of notes) {
            const dur = beats * beatSec;
            if (semi != null) this._note(t, noteHz(semi + octave), dur * staccato, type, gain, bus);
            t += dur;
        }
        return t;
    }

    _note(t, hz, dur, type, gain, bus) {
        const ctx = this.engine.context;
        const osc = ctx.createOscillator();
        const env = ctx.createGain();

        osc.type = type;
        osc.frequency.value = hz;

        env.gain.setValueAtTime(MIN_GAIN, t);
        env.gain.exponentialRampToValueAtTime(gain, t + 0.015);
        env.gain.setValueAtTime(gain, t + Math.max(0.02, dur - 0.06));
        env.gain.exponentialRampToValueAtTime(MIN_GAIN, t + dur);

        osc.connect(env).connect(bus);
        osc.start(t);
        osc.stop(t + dur + 0.05);
        this._songSources.add(osc);
        osc.onended = () => {
            this._songSources.delete(osc);
            try { osc.disconnect(); env.disconnect(); } catch { /* gone */ }
        };
    }

    stop() {
        const now = this.engine.now();
        for (const osc of this._songSources) {
            try { osc.stop(now + 0.3); } catch { /* already stopped */ }
        }
        this._songSources.clear();
        this._playing = false;
        super.stop();
    }
}
