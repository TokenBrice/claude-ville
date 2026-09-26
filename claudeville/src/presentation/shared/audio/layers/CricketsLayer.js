// Night crickets: two "individuals" with their own rhythms and stereo
// positions, each chirruping in pulse clusters. Summer nights are dense,
// spring/autumn sparse, winter silent (season gating upstream). Each
// individual is a renewal process in audio time, so the rhythm holds under
// render load; both share one Transport process and the layer's own stream.

import { BaseLayer } from './BaseLayer.js';
import { MIN_GAIN, rand } from '../AudioEngine.js';
import { makeFilter } from '../Filters.js';
import { renewalProcess } from '../Transport.js';

const VOICES = [
    { hz: 4150, intervalSec: 0.56, pan: -0.45 },
    { hz: 4480, intervalSec: 0.81, pan: 0.4 },
];
// Chirrups sound above this level; below it the rhythm keeps running.
const CHIRRUP_MIN_LEVEL = 0.03;
// ENG-6 send table.
const AIR_SEND = 0.12;

export class CricketsLayer extends BaseLayer {
    constructor(engine, options = {}) {
        super(engine, { trim: 0.7, group: 'wildlife', ...options });
    }

    _start(ctx) {
        this.airSend(AIR_SEND);
        const individuals = VOICES.map((voice) => {
            const filter = makeFilter(ctx, 'bandpass', voice.hz, { q: 7 });
            const pan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
            if (pan) {
                pan.pan.value = voice.pan;
                filter.connect(pan).connect(this.out);
            } else {
                filter.connect(this.out);
            }
            this.track(filter, pan);
            const wait = () => voice.intervalSec * rand(this.rng, 0.8, 1.35);
            return renewalProcess({
                first: wait,
                gap: wait,
                emit: (at) => {
                    if (this.level > CHIRRUP_MIN_LEVEL) this._chirrup(voice, filter, at);
                },
            });
        });
        this.registerProcess({
            name: 'crickets',
            rearm: (now) => {
                for (const individual of individuals) individual.rearm(now);
            },
            schedule: (from, to) => individuals.reduce(
                (dropped, individual) => dropped + individual.schedule(from, to),
                0,
            ),
        });
    }

    // A chirrup at audio time `t`: 3–4 fast pulses of a narrow-band
    // triangle tone. The oscillator starts at the envelope's first event (an
    // untimed start() blips 15.8 dB over the chirrup, ENG-4).
    _chirrup(voice, filter, t) {
        const ctx = this.engine.context;
        if (!ctx) return;
        const pulses = 3 + (this.rng() < 0.35 ? 1 : 0);
        const startAt = t;

        const osc = ctx.createOscillator();
        osc.type = 'triangle';
        osc.frequency.value = voice.hz * rand(this.rng, 0.98, 1.02);
        const gain = ctx.createGain();
        gain.gain.setValueAtTime(MIN_GAIN, t);
        for (let i = 0; i < pulses; i++) {
            gain.gain.exponentialRampToValueAtTime(0.05, t + 0.006);
            gain.gain.exponentialRampToValueAtTime(MIN_GAIN, t + 0.028);
            t += 0.045;
        }
        osc.connect(gain).connect(filter);
        osc.start(startAt);
        osc.stop(t + 0.05);
        osc.onended = () => {
            try { osc.disconnect(); gain.disconnect(); } catch { /* gone */ }
        };
    }
}
