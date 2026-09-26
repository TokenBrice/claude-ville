// Rain on materials (AMB-5): a diffuse wash, leaf and ground patter,
// slate-roof ticks, drops on the harbor water, and the storm's rumble, each
// with its own density law. Light rain is a soft wash with a scatter of
// close roof ticks and glassy plinks off the harbor; heavy rain thickens the
// patter into a wide hiss around the listener. Drops on water glide *up*,
// like real ones (a Minnaert bubble's pitch rises as it shrinks). Winter
// (snow on screen) is handled upstream — the director mutes precipitation so
// snowfall stays hushed with only wind carrying the scene.
//
// Every lane is persistent (S8): the wash's dark body and the rumble share
// one brown noise-pool read; the patter, ticks and plinks are the dust and
// bubbles worklet (worklets/noise-processor.js), whose event densities are
// k-rate params the director's mapping slews — zero nodes per drop. Without
// AudioWorklet a white sizzle lane stands in for the patter and ticks, and
// the plinks fall back to three persistent oscillator lanes played at a
// quarter of the density on the Transport, still gliding up.

import { BaseLayer } from './BaseLayer.js';
import { MIN_GAIN, rand } from '../AudioEngine.js';
import { makeFilter } from '../Filters.js';
import { renewalProcess } from '../Transport.js';

// Rain sounds above this precipitation; below it every lane rests.
const RAIN_AUDIBLE = 0.02;
// Plinks sit in the air (AMB-2 environment sends); the beds stay dry.
const PLINK_AIR_SEND = 0.25;
// Where the materials sit: the roofs left of centre, the harbor right.
const ROOF_PAN = -0.2;
const PLINK_PAN = 0.35;
// Drops on water: Minnaert plinks between these pitches, gliding up ×1.35
// over 14 ms (the worklet's glide) with a 9 ms amplitude decay.
export const PLINK_HZ = Object.freeze([1200, 3400]);
export const PLINK_GLIDE = Object.freeze({ ratio: 1.35, sec: 0.014 });
const PLINK_TAU_MS = 9;
// Native fallback: persistent plink lanes and their share of the density.
const FALLBACK_PLINK_LANES = 3;
const FALLBACK_DENSITY = 0.25;

// Per-material gain and density (events/s) at precipitation p (0..1), and
// the rumble at storm intensity s. Pure, so the density laws are testable.
export function rainMaterials(p, storm = 0) {
    const rain = Math.max(0, Math.min(1, Number(p) || 0));
    const s = Math.max(0, Math.min(1, Number(storm) || 0));
    const on = rain > RAIN_AUDIBLE;
    const root = Math.sqrt(rain);
    return {
        wash: on ? (0.2 + 0.8 * rain) * rain : 0,
        leaf: { gain: on ? 0.9 * root : 0, density: on ? 300 + 3200 * rain : 0 },
        roof: { gain: on ? 0.55 * root : 0, density: on ? 30 + 520 * rain : 0 },
        plink: { gain: on ? 0.16 * root : 0, density: on ? 3 + 45 * rain : 0 },
        rumble: 0.5 * s,
    };
}

// Output gains per material, balanced against each other in the layer's
// trim (measured through the probe's rain and storm scenes). The wash is a
// dark body (the brown lane, 250–700 Hz) under the patter, so the
// rain reads wide and wet without filling the 0.8–2.5 kHz valley the
// urgent calls ring in (S3; the rate limit's 880 Hz body and 1.6 kHz click
// kept their two bands over the storm only below 700 Hz) or piling energy
// into 2–5 kHz (S7: ≤ 20 % of a scene's loudness). The white sizzle
// (400 Hz – 6 kHz) plays only without AudioWorklet, in the patter's place:
// a white pool lane is the scarcest (every one-shot grain avoids it).
const WASH_BODY_GAIN = 2.0;
const WASH_SIZZLE_GAIN = 0.35;
const WASH_GAIN = 0.6;
const LEAF_HZ = 2600;
const LEAF_GAIN = 0.3;
const ROOF_GAIN = 0.2;
const PLINK_GAIN = 0.6;
const RUMBLE_GAIN = 0.8;

export class RainLayer extends BaseLayer {
    // Trim 0.07 is ×0.35 of the pre-calibration 0.2 (plan 1.4, MIX-3): the
    // storm swells without blasting and leaves the urgent bell its headroom.
    constructor(engine, options = {}) {
        super(engine, { trim: 0.07, group: 'rain', ...options });
        this.precipitation = 0;
        this.storm = 0;
        this._gains = null;
        this._worklets = [];
        this._densities = null;
        this._plinkLanes = [];
        this._nextPlink = 0;
    }

    _start(ctx) {
        // The out gain stays at full trim; the materials do the mixing.
        this.setLevel(1, 0.1);
        const materials = rainMaterials(this.precipitation, this.storm);
        const gain = value => {
            const node = ctx.createGain();
            node.gain.value = Math.max(MIN_GAIN, value);
            this.track(node);
            return node;
        };
        const filter = (type, hz, opts) => {
            const node = makeFilter(ctx, type, hz, opts);
            this.track(node);
            return node;
        };
        const panner = value => {
            const node = ctx.createStereoPanner();
            node.pan.value = value;
            this.track(node);
            return node;
        };

        // Wash: the dark body; it shares the rumble's brown lane (the two
        // bands never overlap).
        const brown = this.engine.noiseSource('brown', { rng: this.rng });
        const wash = gain(WASH_GAIN * materials.wash);
        brown.connect(filter('highpass', 250)).connect(filter('lowpass', 700)).connect(gain(WASH_BODY_GAIN)).connect(wash);
        wash.connect(this.out);

        // Rumble: the brown lane under 90 Hz.
        const rumble = gain(RUMBLE_GAIN * materials.rumble);
        brown.connect(filter('lowpass', 90)).connect(rumble).connect(this.out);

        const leaf = gain(LEAF_GAIN * materials.leaf.gain);
        const roof = gain(ROOF_GAIN * materials.roof.gain);
        const plink = gain(PLINK_GAIN * materials.plink.gain);
        leaf.connect(this.out);
        roof.connect(panner(ROOF_PAN)).connect(this.out);
        const plinkPan = panner(PLINK_PAN);
        plink.connect(plinkPan).connect(this.out);
        this.airSend(PLINK_AIR_SEND, plinkPan);
        this._gains = { wash, rumble, leaf, roof, plink };

        const leafDust = this.engine.noiseWorklet('dust', { rng: this.rng, density: materials.leaf.density, decayMs: 3 });
        const roofDust = this.engine.noiseWorklet('dust', { rng: this.rng, density: materials.roof.density, decayMs: 0.8 });
        const bubbles = this.engine.noiseWorklet('bubbles', {
            rng: this.rng, density: materials.plink.density, fmin: PLINK_HZ[0], fmax: PLINK_HZ[1], tauMs: PLINK_TAU_MS,
        });
        const sources = [brown];
        if (leafDust && roofDust && bubbles) {
            // Leaves and ground: a broad band around 2.6 kHz, above the valley.
            leafDust.connect(filter('bandpass', LEAF_HZ, { q: 0.7 })).connect(leaf);
            // Slate: bright ticks with a +6 dB ring at 4.3 kHz.
            roofDust.connect(filter('highpass', 3000)).connect(filter('peaking', 4300, { q: 2, gain: 6 })).connect(roof);
            bubbles.connect(plink);
            this._worklets = [leafDust, roofDust, bubbles];
            this.track(...this._worklets);
            this._densities = {
                leaf: leafDust.parameters.get('density'),
                roof: roofDust.parameters.get('density'),
                plink: bubbles.parameters.get('density'),
            };
        } else {
            for (const node of [leafDust, roofDust, bubbles]) node?.port?.postMessage('stop');
            const white = this.engine.noiseSource('white', { rng: this.rng });
            white.connect(filter('highpass', 400)).connect(filter('lowpass', 6000)).connect(gain(WASH_SIZZLE_GAIN)).connect(wash);
            sources.push(white);
            this._startFallbackPlinks(ctx, plink);
        }

        const t = ctx.currentTime;
        for (const source of sources) source.start(t);
        this.trackSource(...sources);
    }

    // Three persistent sine lanes, each re-struck by automation: a drop on
    // water is a pitch glide up and a 9 ms decay (no node per drop).
    _startFallbackPlinks(ctx, plink) {
        const t = ctx.currentTime;
        for (let i = 0; i < FALLBACK_PLINK_LANES; i++) {
            const osc = ctx.createOscillator();
            osc.type = 'sine';
            osc.frequency.value = PLINK_HZ[0];
            const env = ctx.createGain();
            env.gain.value = 0;
            const pan = ctx.createStereoPanner();
            pan.pan.value = (i - 1) * 0.3;
            osc.connect(env).connect(pan).connect(plink);
            osc.start(t);
            this.trackSource(osc);
            this.track(env, pan);
            this._plinkLanes.push({ osc, env });
        }
        const wait = () => this._plinkGap();
        this.registerProcess(renewalProcess({
            name: 'rain',
            first: wait,
            gap: wait,
            emit: (at) => {
                if (this.precipitation > RAIN_AUDIBLE) this._plink(at);
            },
        }));
    }

    // Seconds to the next fallback plink; a slow idle pulse while dry, so
    // rain that starts is heard within a beat.
    _plinkGap() {
        const density = rainMaterials(this.precipitation).plink.density * FALLBACK_DENSITY;
        return density > 0 ? -Math.log(1 - this.rng()) / density : 1.5;
    }

    _plink(t) {
        const lane = this._plinkLanes[this._nextPlink];
        this._nextPlink = (this._nextPlink + 1) % this._plinkLanes.length;
        const f0 = PLINK_HZ[0] * Math.pow(PLINK_HZ[1] / PLINK_HZ[0], this.rng());
        const amp = rand(this.rng, 0.25, 1);
        lane.osc.frequency.setValueAtTime(f0, t);
        lane.osc.frequency.exponentialRampToValueAtTime(f0 * PLINK_GLIDE.ratio, t + PLINK_GLIDE.sec);
        lane.env.gain.setTargetAtTime(amp, t, 0.0008);
        lane.env.gain.setTargetAtTime(0, t + 0.003, PLINK_TAU_MS / 1000);
    }

    // `timeConstant` overrides the slow slews (a starting director primes
    // its layers at their targets under its own fade-in).
    setPrecipitation(p, timeConstant = 4) {
        this.precipitation = Math.max(0, Math.min(1, Number(p) || 0));
        this._apply(timeConstant);
    }

    setStorm(intensity, timeConstant = 6) {
        this.storm = Math.max(0, Math.min(1, Number(intensity) || 0));
        if (!this._gains || !this.engine.context) return;
        const m = rainMaterials(this.precipitation, this.storm);
        this._gains.rumble.gain.setTargetAtTime(Math.max(MIN_GAIN, RUMBLE_GAIN * m.rumble), this.engine.now(), timeConstant);
    }

    _apply(tau) {
        if (!this._gains || !this.engine.context) return;
        const now = this.engine.now();
        const m = rainMaterials(this.precipitation, this.storm);
        const set = (param, value) => param.setTargetAtTime(Math.max(MIN_GAIN, value), now, tau);
        set(this._gains.wash.gain, WASH_GAIN * m.wash);
        set(this._gains.leaf.gain, LEAF_GAIN * m.leaf.gain);
        set(this._gains.roof.gain, ROOF_GAIN * m.roof.gain);
        set(this._gains.plink.gain, PLINK_GAIN * m.plink.gain);
        if (this._densities) {
            this._densities.leaf.setTargetAtTime(m.leaf.density, now, tau);
            this._densities.roof.setTargetAtTime(m.roof.density, now, tau);
            this._densities.plink.setTargetAtTime(m.plink.density, now, tau);
        }
    }

    stop() {
        const silentAt = super.stop();
        const worklets = this._worklets;
        if (worklets.length && silentAt !== undefined) {
            const ms = Math.max(0, (silentAt - this.engine.now() + 0.2) * 1000);
            setTimeout(() => { for (const node of worklets) node.port.postMessage('stop'); }, ms);
        }
        this._gains = null;
        this._worklets = [];
        this._densities = null;
        this._plinkLanes = [];
        return silentAt;
    }
}
