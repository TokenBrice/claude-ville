// The village murmur (work stratum, S1; SIG-8): a band of brown noise that
// breathes with how many agents are working. Density is logarithmic —
// B = log2(1 + W)/log2(17) over the audible working agents W — so one, three,
// seven and fifteen agents are each one audible step: louder, wider and a
// little higher. At night the murmur darkens (centre −30 %, low-pass 900 Hz)
// and keeps its level (4.7: work at night is work behind shutters, not less
// work). `setLevel` is only the gate (0 on a lost link or a resting village).
// The murmur is work, not world: its own random stream, on the work bus. It
// leaves the held note's lane open (HELD_SLOT, a fixed cut at the D).

import { BaseLayer } from './BaseLayer.js';
import { MIN_GAIN } from '../AudioEngine.js';
import { makeFilter } from '../Filters.js';
import { heldSlot } from './HeldNote.js';

// B reaches 1 at sixteen working agents.
const FULL_WORKERS = 16;
// Loudness is linear in B on a dB scale, 12 dB from B = 0 to 1: each
// doubling of W is ≈ 3 dB (≥ 2 dB in 150–600 Hz after the centre moves up;
// 4.7), and one agent sits ≈ −9 dB under a full village. Width
// 0.1 + 0.6·B (the two decorrelated noise channels panned ±width); band
// centre 260 + 140·B Hz (SIG-8).
const SPAN_DB = 12;
const WIDTH_FLOOR = 0.1;
const WIDTH_SPAN = 0.6;
const CENTRE_HZ = 260;
const CENTRE_SPAN_HZ = 140;
const BAND_Q = 0.6;
// Night darkening: the centre falls 30 % and the low-pass closes from the
// day's 1.1 kHz to 900 Hz.
const NIGHT_CENTRE_SCALE = 0.7;
const DAY_LOWPASS_HZ = 1100;
const NIGHT_LOWPASS_HZ = 900;
// The band's gain at full density (the level is set by the layer trim),
// with the 1.1 dB the held note's slot takes from the band given back.
const BODY_GAIN = 0.12 * Math.pow(10, 1.1 / 20);
// Polls never flutter (SIG-8: τ 4 s).
const SLEW_SEC = 4;

const clamp01 = value => Math.max(0, Math.min(1, Number(value) || 0));

/** SIG-8 density: 0 idle, 0.24 at one agent, 0.49 at 3, 0.73 at 7, 1 from 16. */
export function murmurDensity(working) {
    const w = Math.max(0, Number(working) || 0);
    return w > 0 ? Math.min(1, Math.log2(1 + w) / Math.log2(1 + FULL_WORKERS)) : 0;
}

/**
 * The murmur's shape for `working` audible agents and night `dark` (0 day,
 * 1 night): `{ gain, width, centreHz, lowpassHz }`. `gain` never depends
 * on `dark`.
 */
export function murmurShape({ working = 0, dark = 0 } = {}) {
    const b = murmurDensity(working);
    const d = clamp01(dark);
    return {
        gain: b > 0 ? Math.pow(10, (-SPAN_DB * (1 - b)) / 20) : 0,
        width: WIDTH_FLOOR + WIDTH_SPAN * b,
        centreHz: (CENTRE_HZ + CENTRE_SPAN_HZ * b) * (1 - (1 - NIGHT_CENTRE_SCALE) * d),
        lowpassHz: DAY_LOWPASS_HZ * Math.pow(NIGHT_LOWPASS_HZ / DAY_LOWPASS_HZ, d),
    };
}

export class VillageHumLayer extends BaseLayer {
    constructor(engine, options = {}) {
        super(engine, { trim: 0.11, group: 'hum', ...options });
        this._murmur = { working: 0, dark: 0 };
        this._body = null;
        this._band = null;
        this._lowpass = null;
        this._pans = [];
    }

    _start(ctx) {
        const src = this.engine.noiseSource('brown', { rng: this.rng });
        const shape = murmurShape(this._murmur);
        this._band = makeFilter(ctx, 'bandpass', shape.centreHz, { q: BAND_Q });
        this._lowpass = makeFilter(ctx, 'lowpass', shape.lowpassHz);
        const slot = heldSlot(ctx);
        this._body = ctx.createGain();
        this._body.gain.value = Math.max(MIN_GAIN, BODY_GAIN * shape.gain);
        // The pool's two decorrelated channels become two voices at ±width.
        const split = ctx.createChannelSplitter(2);
        this._pans = [-1, 1].map((side, channel) => {
            const pan = ctx.createStereoPanner();
            pan.pan.value = side * shape.width;
            split.connect(pan, channel);
            pan.connect(this.out);
            return pan;
        });
        if (src) {
            src.connect(this._band);
            src.start(ctx.currentTime);
            this.trackSource(src);
        }
        this._band.connect(this._lowpass).connect(slot).connect(this._body).connect(split);
        this.track(this._band, this._lowpass, slot, this._body, split, ...this._pans);
    }

    // `working`: audible working agents; `dark`: 0 by day … 1 at night.
    setMurmur({ working = 0, dark = 0 } = {}, timeConstant = SLEW_SEC) {
        this._murmur = { working: Math.max(0, Number(working) || 0), dark: clamp01(dark) };
        if (!this._body || !this.engine.context) return;
        const shape = murmurShape(this._murmur);
        const now = this.engine.now();
        const tau = timeConstant ?? SLEW_SEC;
        this._body.gain.setTargetAtTime(Math.max(MIN_GAIN, BODY_GAIN * shape.gain), now, tau);
        this._band.frequency.setTargetAtTime(shape.centreHz, now, tau);
        this._lowpass.frequency.setTargetAtTime(shape.lowpassHz, now, tau);
        this._pans.forEach((pan, i) => pan.pan.setTargetAtTime((i ? 1 : -1) * shape.width, now, tau));
    }

    stop() {
        const silentAt = super.stop();
        this._body = null;
        this._band = null;
        this._lowpass = null;
        this._pans = [];
        return silentAt;
    }
}
