// Rain: broadband high patter scaled by precipitation, sparse pitched
// droplet grains for close texture, and a low storm rumble bed. Winter
// (snow on screen) is handled upstream — the director mutes precipitation
// so snowfall stays hushed with only wind carrying the scene. Droplets are a
// renewal process on the Transport, placed in audio time from the layer's
// own random stream.

import { BaseLayer } from './BaseLayer.js';
import { MIN_GAIN, rand } from '../AudioEngine.js';
import { makeFilter } from '../Filters.js';
import { renewalProcess } from '../Transport.js';

// Droplets sound above this precipitation; below it the process idles.
const DROPLET_MIN_PRECIPITATION = 0.05;
// Droplet plinks sit in the air (AMB-2 environment sends); the beds stay dry.
const DROPLET_AIR_SEND = 0.25;

export class RainLayer extends BaseLayer {
    // Trim 0.07 is ×0.35 of the pre-calibration 0.2 (plan 1.4, MIX-3): the
    // storm swells without blasting and leaves the urgent bell its headroom.
    constructor(engine, options = {}) {
        super(engine, { trim: 0.07, group: 'rain', ...options });
        this.precipitation = 0;
        this.patterGain = null;
        this.rumbleGain = null;
        this._dropBus = null;
    }

    _start(ctx) {
        // The out gain stays at full trim; sub-gains do the mixing so patter
        // and rumble can move independently.
        this.setLevel(1, 0.1);

        const patterSrc = this.engine.noiseSource('white', { rng: this.rng });
        const hp = makeFilter(ctx, 'highpass', 1500, { q: 'butterworth' });
        const lp = makeFilter(ctx, 'lowpass', 6800, { q: 'butterworth' });

        this.patterGain = ctx.createGain();
        this.patterGain.gain.value = MIN_GAIN;

        const rumbleSrc = this.engine.noiseSource('brown', { rng: this.rng });
        const rumbleLp = makeFilter(ctx, 'lowpass', 120, { q: 'butterworth' });

        this.rumbleGain = ctx.createGain();
        this.rumbleGain.gain.value = MIN_GAIN;

        this._dropBus = ctx.createGain();
        this._dropBus.connect(this.out);

        patterSrc.connect(hp).connect(lp).connect(this.patterGain).connect(this.out);
        rumbleSrc.connect(rumbleLp).connect(this.rumbleGain).connect(this.out);

        const t = ctx.currentTime;
        patterSrc.start(t);
        rumbleSrc.start(t);

        this.trackSource(patterSrc, rumbleSrc);
        this.track(hp, lp, this.patterGain, rumbleLp, this.rumbleGain, this._dropBus);
        this.airSend(DROPLET_AIR_SEND, this._dropBus);

        const wait = () => this._dropletGap();
        this.registerProcess(renewalProcess({
            name: 'rain',
            first: wait,
            gap: wait,
            emit: (at) => {
                if (this.precipitation > DROPLET_MIN_PRECIPITATION) this._droplet(at);
            },
        }));
    }

    // `timeConstant` overrides the slow slews (a starting director primes
    // its layers at their targets under its own fade-in).
    setPrecipitation(p, timeConstant = 4) {
        this.precipitation = Math.max(0, Math.min(1, Number(p) || 0));
        if (!this.patterGain || !this.engine.context) return;
        const target = this.precipitation > 0.02 ? this.precipitation * 0.55 : MIN_GAIN;
        this.patterGain.gain.setTargetAtTime(Math.max(MIN_GAIN, target), this.engine.now(), timeConstant);
    }

    setStorm(intensity, timeConstant = 6) {
        if (!this.rumbleGain || !this.engine.context) return;
        const v = Math.max(0, Math.min(1, Number(intensity) || 0));
        this.rumbleGain.gain.setTargetAtTime(Math.max(MIN_GAIN, v * 0.4), this.engine.now(), timeConstant);
    }

    // Seconds to the next droplet: denser as the rain thickens; a slow idle
    // pulse while dry, so rain that starts is heard within a beat.
    _dropletGap() {
        const p = this.precipitation;
        return p > DROPLET_MIN_PRECIPITATION ? rand(this.rng, 0.14, 0.9 - p * 0.65) : 1.5;
    }

    // One close droplet at audio time `t`: a fast downward pitch chirp,
    // panned at random.
    _droplet(t) {
        const ctx = this.engine.context;
        if (!ctx || !this._dropBus) return;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        const pan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;

        osc.type = 'sine';
        const f0 = rand(this.rng, 1800, 3400);
        osc.frequency.setValueAtTime(f0, t);
        osc.frequency.exponentialRampToValueAtTime(f0 * 0.4, t + 0.03);

        const peak = 0.006 + this.precipitation * 0.014;
        gain.gain.setValueAtTime(MIN_GAIN, t);
        gain.gain.exponentialRampToValueAtTime(peak, t + 0.006);
        gain.gain.exponentialRampToValueAtTime(MIN_GAIN, t + rand(this.rng, 0.05, 0.12));

        const panValue = rand(this.rng, -0.7, 0.7);
        if (pan) {
            pan.pan.value = panValue;
            osc.connect(gain).connect(pan).connect(this._dropBus);
        } else {
            osc.connect(gain).connect(this._dropBus);
        }
        osc.start(t);
        osc.stop(t + 0.16);
        osc.onended = () => {
            try { osc.disconnect(); gain.disconnect(); pan?.disconnect(); } catch { /* gone */ }
        };
    }
}
