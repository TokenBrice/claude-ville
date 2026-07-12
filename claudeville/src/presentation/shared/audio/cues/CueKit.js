// One-shot cue voices. Every pitched cue draws from the shared tonal center
// (MusicalScale.cueTones) so cues can never clash with the ambient layers.
// All cues route through the engine's cue bus and gently duck the ambience.

import { MIN_GAIN, rand } from '../AudioEngine.js';
import { cueTones } from '../MusicalScale.js';

const COOLDOWNS_MS = {
    arrival: 20000,
    departure: 20000,
    distress: 30000,
    recovery: 30000,
    council: 60000,
    hourBell: 55 * 60000,
    aurora: 120000,
    thunder: 8000,
};

// Weather/clock cues are scenery, exempt from the global chatter budget.
const UNBUDGETED = new Set(['thunder', 'hourBell']);

export class CueKit {
    constructor(engine, governor) {
        this.engine = engine;
        this.governor = governor;
        this.lastCue = null;
    }

    // Returns true when the cue actually played (survived the governor).
    play(kind, { phase = 'day', intensity = 1 } = {}) {
        if (!this.engine.context || !this.engine.started) return false;
        const cooldown = COOLDOWNS_MS[kind];
        if (cooldown == null) return false;
        if (!this.governor.allow(kind, cooldown, { budget: !UNBUDGETED.has(kind) })) return false;

        const notes = cueTones(phase);
        const t = this.engine.now() + 0.03;
        switch (kind) {
            case 'arrival':
                this.engine.duck(0.25, 0.5);
                this._bell(t, notes.root, { gain: 0.035, decay: 1.6 });
                this._bell(t + 0.22, notes.fifth, { gain: 0.03, decay: 2 });
                break;
            case 'departure':
                this.engine.duck(0.25, 0.5);
                this._bell(t, notes.fifth, { gain: 0.03, decay: 1.6 });
                this._bell(t + 0.24, notes.root, { gain: 0.032, decay: 2.2 });
                break;
            case 'distress':
                this.engine.duck(0.3, 0.8);
                this._bell(t, notes.low, { gain: 0.05, decay: 3, cutoff: 900 });
                break;
            case 'recovery':
                this.engine.duck(0.2, 0.5);
                this._bell(t, notes.third, { gain: 0.028, decay: 1.4 });
                this._bell(t + 0.2, notes.octave, { gain: 0.026, decay: 2 });
                break;
            case 'council':
                this.engine.duck(0.25, 1);
                this._bell(t, notes.root, { gain: 0.03, decay: 1.8 });
                this._bell(t + 0.28, notes.fifth, { gain: 0.028, decay: 1.8 });
                this._bell(t + 0.56, notes.octave, { gain: 0.026, decay: 2.4 });
                break;
            case 'hourBell':
                this.engine.duck(0.3, 1.2);
                this._bell(t, 220, { gain: 0.06, decay: 4, cutoff: 1600 });
                break;
            case 'aurora': {
                this.engine.duck(0.2, 1);
                const run = [notes.root, notes.fifth, notes.octave, notes.high];
                run.forEach((hz, i) => {
                    this._bell(t + i * 0.16, hz, { gain: 0.022, decay: 2.6, cutoff: 3200 });
                });
                break;
            }
            case 'thunder':
                this._thunder(t, intensity);
                break;
            default:
                return false;
        }
        this.lastCue = { kind, at: Date.now() };
        return true;
    }

    // A small bell: fundamental plus one inharmonic partial (×2.756, the
    // classic bell hum-to-prime ratio), low-passed and left to ring out.
    _bell(t, hz, { gain = 0.04, decay = 2, cutoff = 2400 } = {}) {
        const ctx = this.engine.context;
        const tone = ctx.createBiquadFilter();
        tone.type = 'lowpass';
        tone.frequency.value = cutoff;
        tone.Q.value = 0.3;
        tone.connect(this.engine.cueBus);

        const partials = [
            { ratio: 1, gain, decay },
            { ratio: 2.756, gain: gain * 0.3, decay: decay * 0.5 },
        ];
        const nodes = [tone];
        for (const partial of partials) {
            const osc = ctx.createOscillator();
            const env = ctx.createGain();
            osc.type = 'sine';
            osc.frequency.value = hz * partial.ratio;
            env.gain.setValueAtTime(MIN_GAIN, t);
            env.gain.exponentialRampToValueAtTime(partial.gain, t + 0.012);
            env.gain.exponentialRampToValueAtTime(MIN_GAIN, t + partial.decay);
            osc.connect(env).connect(tone);
            osc.start(t);
            osc.stop(t + partial.decay + 0.1);
            nodes.push(osc, env);
        }
        setTimeout(() => {
            for (const node of nodes) {
                try { node.disconnect(); } catch { /* gone */ }
            }
        }, (decay + 0.5) * 1000);
    }

    // Thunder: a swept low-pass burst of brown noise with a secondary rumble
    // bump, so strikes roll instead of thump.
    _thunder(t, intensity = 1) {
        const ctx = this.engine.context;
        const level = Math.max(0.2, Math.min(1, intensity));
        this.engine.duck(0.45, 1.5);

        const src = ctx.createBufferSource();
        src.buffer = this.engine.noise('brown');
        src.playbackRate.value = rand(0.65, 0.95);

        const lp = ctx.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.setValueAtTime(rand(260, 380), t);
        lp.frequency.exponentialRampToValueAtTime(75, t + rand(2, 3));
        lp.Q.value = 0.6;

        const env = ctx.createGain();
        const peak = 0.1 + level * 0.14;
        const tail = rand(2.4, 4.5);
        env.gain.setValueAtTime(MIN_GAIN, t);
        env.gain.exponentialRampToValueAtTime(peak, t + rand(0.06, 0.14));
        env.gain.exponentialRampToValueAtTime(peak * 0.35, t + 0.9);
        env.gain.exponentialRampToValueAtTime(peak * 0.5, t + 1.3); // secondary roll
        env.gain.exponentialRampToValueAtTime(MIN_GAIN, t + tail);

        src.connect(lp).connect(env).connect(this.engine.cueBus);
        src.start(t);
        src.stop(t + tail + 0.2);
        src.onended = () => {
            try { src.disconnect(); lp.disconnect(); env.disconnect(); } catch { /* gone */ }
        };
    }
}
