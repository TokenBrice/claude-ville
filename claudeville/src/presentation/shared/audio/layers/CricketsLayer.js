// A field-cricket chorus (AMB-8): five individuals, two near and three far,
// each a persistent oscillator gated by gain automation, so a chirp creates
// no nodes (S8). A chirp is 3–5 pulses of 16 ms on a 33 ms grid; each
// individual chirps at a Dolbear rate from the night's temperature
// (`setTemperature`), sings in 8–25 s bouts with 3–14 s rests, and at most
// two sing at once, so the night breathes instead of ringing. Season,
// rain and storm arrive through `setLevel` (the director's law: silent in
// winter and in rain). Far singers are quieter, duller and wetter. One
// Transport process draws from the layer's own stream (S6).

import { BaseLayer } from './BaseLayer.js';
import { rand } from '../AudioEngine.js';
import { makeFilter } from '../Filters.js';
import { distanceGain, distanceLowpassHz } from '../SpatialField.js';

// Carrier (AMB-8): a near-sine with a whisper of harmonics. Each pulse is
// 16 ms, far under S1's 150 ms limit for a steady tone above 2 kHz.
const CARRIER = Object.freeze([0, 1, 0.1, 0.035]);
const CARRIER_HZ = Object.freeze([4300, 5000]);
// Near singers flank the listener; far ones sit anywhere in the field
// (SpatialField distance units: near inside the knee, far duller).
const NEAR = Object.freeze([
    Object.freeze({ pan: -0.45, distance: [0.3, 0.45] }),
    Object.freeze({ pan: 0.5, distance: [0.3, 0.45] }),
]);
const FAR_COUNT = 3;
const FAR_DISTANCE = Object.freeze([1.0, 1.4]);
const FAR_PAN = 0.75;
// Island Air sends (AMB-8): near nearly dry, far in the reverb.
const NEAR_AIR = 0.06;
const FAR_AIR = 0.35;
// Pulse shape: 4 ms linear rise, hold to 11 ms, fall to 16 ms, every 33 ms.
const PULSE_RISE = 0.004;
const PULSE_HOLD = 0.011;
const PULSE_END = 0.016;
const PULSE_GRID = 0.033;
// Peak gain of a near singer's pulse (the layer's level and trim scale it).
const PULSE_GAIN = 0.002;
// Bouts and rests (s), and the chorus cap: two singers keep the night's
// onsets inside S7's 180/min and its 2–5 kHz under noon's (4.4).
const BOUT = Object.freeze([8, 25]);
const REST = Object.freeze([3, 14]);
const MAX_SINGERS = 2;
const CROWDED_WAIT = Object.freeze([2, 6]);
// Per-individual rate spread and per-chirp jitter.
const RATE_SPREAD = 0.07;
const CHIRP_JITTER = 0.1;
// A summer night's middle (AMB-8: 21 − 4·progress °C).
const DEFAULT_TEMP_C = 19;
// Chirps sound above this level; below it the rhythm keeps running.
export const CHIRP_MIN_LEVEL = 0.03;

/**
 * Chirps per second of one field cricket at `tempC` (Dolbear's law, the
 * AMB-8 form): (7·T + 30)/60 × 0.9, never below 0.5.
 */
export function dolbearChirpsPerSec(tempC) {
    const t = Number.isFinite(Number(tempC)) ? Number(tempC) : DEFAULT_TEMP_C;
    return Math.max(0.5, ((7 * t + 30) / 60) * 0.9);
}

/**
 * Pulse start offsets (s) of one chirp of `pulses` pulses, on the 33 ms grid.
 */
export function chirpPulses(pulses) {
    const n = Math.max(1, Math.floor(pulses));
    return Array.from({ length: n }, (_, i) => i * PULSE_GRID);
}

/**
 * How many of `bouts` (`[start, end)` intervals) are singing at `t`.
 */
export function singersAt(bouts, t) {
    let count = 0;
    for (const [start, end] of bouts) if (t >= start && t < end) count++;
    return count;
}

export class CricketsLayer extends BaseLayer {
    constructor(engine, options = {}) {
        super(engine, { trim: 0.5, group: 'wildlife', ...options });
        this._chirpsPerSec = dolbearChirpsPerSec(DEFAULT_TEMP_C);
        this._voices = [];
    }

    // The night's temperature (°C) sets every individual's chirp rate.
    setTemperature(tempC) {
        this._chirpsPerSec = dolbearChirpsPerSec(tempC);
    }

    _start(ctx) {
        const wave = ctx.createPeriodicWave(new Float32Array(CARRIER.length), Float32Array.from(CARRIER));
        const sites = [
            ...NEAR.map(site => ({ pan: site.pan, distance: rand(this.rng, ...site.distance), near: true })),
            ...Array.from({ length: FAR_COUNT }, () => ({
                pan: rand(this.rng, -FAR_PAN, FAR_PAN),
                distance: rand(this.rng, ...FAR_DISTANCE),
                near: false,
            })),
        ];
        const t = ctx.currentTime;
        this._voices = sites.map((site) => {
            const osc = ctx.createOscillator();
            osc.setPeriodicWave(wave);
            osc.frequency.value = rand(this.rng, ...CARRIER_HZ);
            const env = ctx.createGain();
            env.gain.value = 0;
            const pan = ctx.createStereoPanner();
            pan.pan.value = site.pan;
            const lowpassHz = distanceLowpassHz(site.distance);
            const lowpass = lowpassHz ? makeFilter(ctx, 'lowpass', lowpassHz) : null;
            osc.connect(env);
            (lowpass ? env.connect(lowpass) : env).connect(pan).connect(this.out);
            this.airSend(site.near ? NEAR_AIR : FAR_AIR, pan);
            osc.start(t);
            this.trackSource(osc);
            this.track(env, lowpass, pan);
            return {
                env,
                amp: PULSE_GAIN * distanceGain(site.distance) * (site.near ? 1 : rand(this.rng, 0.55, 0.9)),
                pulses: 3 + Math.floor(rand(this.rng, 0, 3)),
                rate: rand(this.rng, 1 - RATE_SPREAD, 1 + RATE_SPREAD),
                next: null,
                bout: null,
            };
        });
        this.registerProcess({
            name: 'crickets',
            rearm: (now) => {
                for (const voice of this._voices) {
                    if (voice.next === null || voice.next < now) voice.next = null;
                }
            },
            schedule: (from, to) => this._schedule(from, to),
        });
    }

    _schedule(from, to) {
        let dropped = 0;
        for (const voice of this._voices) {
            if (voice.next === null) this._restFrom(voice, from, rand(this.rng, 0, REST[1]));
            while (voice.next < to) {
                const t = voice.next;
                if (t < from) dropped++;
                else if (this.level > CHIRP_MIN_LEVEL) this._chirp(voice, t);
                this._advance(voice, t);
            }
        }
        return dropped;
    }

    // After a chirp at `t`: the next chirp of this bout, or a rest.
    _advance(voice, t) {
        const gap = (1 / (this._chirpsPerSec * voice.rate)) * rand(this.rng, 1 - CHIRP_JITTER, 1 + CHIRP_JITTER);
        const next = t + gap;
        if (next < voice.bout[1]) voice.next = next;
        else this._restFrom(voice, voice.bout[1], rand(this.rng, ...REST));
    }

    // Rest from `t` for `rest` s, then open a bout — later while the chorus
    // already has its full complement of singers.
    _restFrom(voice, t, rest) {
        let start = t + rest;
        const others = this._voices.filter(v => v !== voice && v.bout).map(v => v.bout);
        for (let tries = 0; tries < 8 && singersAt(others, start) >= MAX_SINGERS; tries++) {
            start += rand(this.rng, ...CROWDED_WAIT);
        }
        voice.bout = [start, start + rand(this.rng, ...BOUT)];
        voice.next = start;
    }

    // One chirp at audio time `t`: pulses on the individual's gain, each
    // starting from silence (linear ramps: no exponential from ~0).
    _chirp(voice, t) {
        const g = voice.env.gain;
        const amp = voice.amp;
        for (const offset of chirpPulses(voice.pulses)) {
            const p = t + offset;
            g.setValueAtTime(0, p);
            g.linearRampToValueAtTime(amp, p + PULSE_RISE);
            g.setValueAtTime(amp, p + PULSE_HOLD);
            g.linearRampToValueAtTime(0, p + PULSE_END);
        }
    }

    stop() {
        const silentAt = super.stop();
        this._voices = [];
        return silentAt;
    }
}
