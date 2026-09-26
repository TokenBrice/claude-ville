// Birdsong: short frequency-glide chirp phrases with long randomized rests.
// Intensity controls both loudness and phrase density — a dawn chorus sings
// every few seconds, a quiet afternoon only occasionally. Rain, storm, night
// and winter suppression happen upstream in the director. Chirps are one
// renewal process on the Transport: within a phrase the gap is a flutter,
// after its last chirp a rest, all drawn from the layer's own stream.

import { BaseLayer } from './BaseLayer.js';
import { MIN_GAIN, rand, pick } from '../AudioEngine.js';
import { renewalProcess } from '../Transport.js';

const FIRST_PHRASE_SEC = 2;
// Phrases start only above this level; below it the rests keep running.
const PHRASE_MIN_LEVEL = 0.04;
// Birds sit in trees (plan 2.4, ENG-6 send table).
const AIR_SEND = 0.3;
const SHAPES = ['rise', 'fall', 'warble'];

export class BirdsLayer extends BaseLayer {
    constructor(engine, options = {}) {
        super(engine, { trim: 0.55, group: 'wildlife', ...options });
        this._phrase = null;
    }

    _start(_ctx) {
        this._phrase = null;
        this.airSend(AIR_SEND);
        this.registerProcess(renewalProcess({
            name: 'birds',
            first: () => FIRST_PHRASE_SEC,
            gap: () => this._gap(),
            emit: (at) => this._event(at),
        }));
    }

    // Seconds from one chirp to the next: a flutter inside a phrase, a rest
    // that shortens as the chorus thickens after it.
    _gap() {
        if (this._phrase?.remaining > 0) return rand(this.rng, 0.14, 0.34);
        const density = Math.max(this.level, 0.001);
        return (5 + (1 - density) * 26) * rand(this.rng, 0.6, 1.6);
    }

    // A phrase opens on its first chirp; a rest ending under the level floor
    // is skipped silently.
    _event(t) {
        if (!(this._phrase?.remaining > 0)) {
            this._phrase = null;
            if (this.level <= PHRASE_MIN_LEVEL) return;
            this._phrase = {
                remaining: 2 + Math.floor(rand(this.rng, 0, 4)),
                pan: rand(this.rng, -0.6, 0.6),
                baseHz: rand(this.rng, 2300, 4100),
            };
        }
        const phrase = this._phrase;
        phrase.remaining--;
        this._chirp(t, phrase.baseHz * rand(this.rng, 0.92, 1.12), phrase.pan);
    }

    _chirp(t, f0, panValue) {
        const ctx = this.engine.context;
        if (!ctx || !this.out) return;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        const pan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
        const dur = rand(this.rng, 0.05, 0.11);

        osc.type = 'sine';
        const shape = pick(this.rng, SHAPES);
        osc.frequency.setValueAtTime(f0, t);
        if (shape === 'rise') {
            osc.frequency.exponentialRampToValueAtTime(f0 * rand(this.rng, 1.2, 1.5), t + dur);
        } else if (shape === 'fall') {
            osc.frequency.exponentialRampToValueAtTime(f0 * rand(this.rng, 0.65, 0.85), t + dur);
        } else {
            osc.frequency.exponentialRampToValueAtTime(f0 * 1.3, t + dur * 0.4);
            osc.frequency.exponentialRampToValueAtTime(f0 * 0.9, t + dur);
        }

        gain.gain.setValueAtTime(MIN_GAIN, t);
        gain.gain.exponentialRampToValueAtTime(rand(this.rng, 0.02, 0.035), t + 0.008);
        gain.gain.exponentialRampToValueAtTime(MIN_GAIN, t + dur + 0.06);

        if (pan) {
            pan.pan.value = panValue;
            osc.connect(gain).connect(pan).connect(this.out);
        } else {
            osc.connect(gain).connect(this.out);
        }
        osc.start(t);
        osc.stop(t + dur + 0.1);
        osc.onended = () => {
            try { osc.disconnect(); gain.disconnect(); pan?.disconnect(); } catch { /* gone */ }
        };
    }
}
