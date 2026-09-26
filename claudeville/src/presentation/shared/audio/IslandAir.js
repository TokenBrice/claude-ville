// Island Air (plan S5, AMB-2, ENG-6): the one outdoor space every placed
// voice shares. Two stereo impulse responses — day and night — are baked
// after unlock through the SampleBank (an OfflineAudioContext render):
// early reflections off plaza stone, then a decorrelated velvet-noise tail
// whose highs die first (a low-pass falling 10 kHz → 1 kHz) over a warmer,
// slower low band. Energy-normalised, so a send of s returns ≈ s × the
// input RMS before the return gain.
//
// Return: bed sends ─► bed gate ─┐
//         cue sends ─────────────┴► HP 140 Hz ─┬► conv day ─► g day ──┬► LP (weather) ─► return gain ─► wet
//                                              └► conv night ─► g night ┘
// Phase changes cross the two convolvers with an equal-power glide (τ 6 s);
// once a convolver's gain has settled at zero its input is disconnected so
// it stops convolving. Rain and fog colour only the return. A convolver's
// buffer is set once, when its bake lands, and never replaced.

import { makeFilter } from './Filters.js';

// Mid-band decay constants of the two IRs. The tail's falling low-pass
// shortens the decay above ~500 Hz, so these sit above the S5 targets
// (T60 at 1 kHz: 1.1 ± 0.15 s day, 1.55 ± 0.2 s night). Measured on the
// baked buffers (Schroeder T20, octave bands, 48 kHz): day 1.15 s at 1 kHz,
// 0.83 s at 4 kHz; night 1.57 s and 1.17 s; C80 +5.4 / +2.8 dB; ICC ≈ 0.
// Each IR has a fixed seed: the air is the island's architecture, the same
// every day (a day-seeded IR would move every bell partial's wet level by
// several dB from one day to the next).
export const AIR_MOODS = Object.freeze({
    day: Object.freeze({ t60: 1.2, seed: 0x1a11d }),
    night: Object.freeze({ t60: 1.7, seed: 0x1a11e }),
});

// mulberry32 on a fixed seed: `() => [0, 1)`.
function placeRng(seed) {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6d2b79f5) | 0;
        let t = Math.imul(state ^ (state >>> 15), state | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
// How far each phase leans into the night IR (0 = day, 1 = night).
export const AIR_PHASE_NIGHT = Object.freeze({ dawn: 0, day: 0, dusk: 0.5, night: 1 });
export const AIR_CROSSFADE_TAU_SEC = 6;
export const AIR_RETURN_GAIN = 0.55;
export const AIR_HIGHPASS_HZ = 140;

const PRE_DELAY_MS = 8;
const TAIL_START_MS = 14;
const TAIL_FADE_SEC = 0.05;
const VELVET_DENSITY = 2400;
const LOW_BAND_HZ = 450;
const LOW_BAND_GAIN = 1.2;
// Tail level against the early reflections (the AMB-2 recipe's balance).
const TAIL_GAIN = 0.35;
const LOW_BAND_RATIO = 1.15;
const TAIL_CUTOFF_TAU_RATIO = 0.22;
const ER_BURST_SEC = 0.0016;
const ER_LOWPASS_HZ = 5500;
const ER_GAIN = 2.2;
const EARLY_REFLECTIONS = Object.freeze([
    // [ms after the pre-delay, gain], left then right
    Object.freeze([[9, 0.42], [17, 0.30], [26, 0.25], [38, 0.18], [55, 0.12], [81, 0.08], [118, 0.05]]),
    Object.freeze([[12, 0.40], [21, 0.28], [31, 0.22], [46, 0.15], [67, 0.10], [94, 0.07], [131, 0.045]]),
]);
// An idle convolver's gain is ≈ −43 dB after 5 τ; its own tail then rings
// out before the input is cut.
const IDLE_DISCONNECT_SEC = 5 * AIR_CROSSFADE_TAU_SEC + 2;
const LN_1000 = Math.log(1000);

// ------------------------------------------------------------- pure IR math

export function irSeconds(t60) {
    return Math.min(2.6, 1.25 * t60 + 0.1);
}

// Amplitude envelope that falls 60 dB in `t60` seconds.
export function decayGain(t, t60) {
    return Math.exp(-LN_1000 * Math.max(0, t) / t60);
}

// The tail's low-pass cutoff at `t` seconds into the tail.
export function tailCutoffHz(t, t60) {
    return 1000 + 9000 * Math.exp(-Math.max(0, t) / (TAIL_CUTOFF_TAU_RATIO * t60));
}

// The extra low band: the difference between a 1.15× slower decay and the
// mid decay, so below ~450 Hz the tail as a whole decays 1.15× slower.
export function lowBandGain(t, t60) {
    return decayGain(t, t60 * LOW_BAND_RATIO) - decayGain(t, t60);
}

// Raised-cosine fade-in over the tail's first 50 ms.
export function tailFadeIn(t) {
    if (t <= 0) return 0;
    return t < TAIL_FADE_SEC ? 0.5 - 0.5 * Math.cos(Math.PI * t / TAIL_FADE_SEC) : 1;
}

// Velvet noise: one ±1 impulse at a random position inside every grid cell
// of 1/density seconds. Calls `emit(index, sign)`.
export function velvetImpulses(rng, length, sampleRate, emit, density = VELVET_DENSITY) {
    const cell = sampleRate / density;
    for (let k = 0; k * cell < length; k++) {
        const index = Math.floor(k * cell + rng() * cell);
        const sign = rng() < 0.5 ? -1 : 1;
        if (index < length) emit(index, sign);
    }
}

// Gain that brings the mean per-channel energy to 1.
export function unitEnergyScale(channels) {
    let energy = 0;
    for (const data of channels) {
        for (let i = 0; i < data.length; i++) energy += data[i] * data[i];
    }
    energy /= channels.length || 1;
    return energy > 0 ? 1 / Math.sqrt(energy) : 1;
}

// Equal-power day/night gains for a night amount 0..1.
export function airCrossfadeGains(night) {
    const x = Math.max(0, Math.min(1, Number(night) || 0)) * Math.PI / 2;
    return { day: Math.cos(x), night: Math.sin(x) };
}

// Return colour: rain and fog dull the air, night darkens it a little; wet
// air is shorter-sounding (less return), fog carries slightly more.
export function airReturnColour({ night = 0, rain = 0, fog = 0 } = {}) {
    const lowpassHz = Math.max(2500, Math.min(7000 - 2000 * night, 7000 - 3500 * rain, 7000 - 4000 * fog));
    const gain = AIR_RETURN_GAIN * (1 - 0.3 * rain) * (1 + 0.1 * fog);
    return { lowpassHz, gain };
}

// Build the raw IR parts for one channel on the main thread (sparse: a few
// thousand velvet impulses and seven short bursts); the per-sample filtering
// runs in the offline render.
function rawChannel(rng, length, sampleRate, t60, taps) {
    const mid = new Float32Array(length);
    const low = new Float32Array(length);
    const early = new Float32Array(length);
    const t0 = (PRE_DELAY_MS + TAIL_START_MS) / 1000;
    velvetImpulses(rng, length, sampleRate, (i, sign) => {
        const t = i / sampleRate - t0;
        if (t <= 0) return;
        const fade = TAIL_GAIN * tailFadeIn(t);
        mid[i] = sign * fade * decayGain(t, t60);
        low[i] = sign * fade * LOW_BAND_GAIN * lowBandGain(t, t60);
    });
    const a = Math.exp(-2 * Math.PI * ER_LOWPASS_HZ / sampleRate);
    const burst = Math.round(ER_BURST_SEC * sampleRate);
    for (const [ms, gain] of taps) {
        const start = Math.round((PRE_DELAY_MS + ms) * sampleRate / 1000);
        let y = 0;
        for (let k = 0; k < burst + 64 && start + k < length; k++) {
            const x = k < burst ? (rng() * 2 - 1) * Math.sin(Math.PI * k / burst) ** 2 : 0;
            y = (1 - a) * x + a * y;
            early[start + k] += gain * ER_GAIN * y;
        }
    }
    return { mid, low, early };
}

// A SampleBank recipe for one mood's IR at `sampleRate`.
export function airIrRecipe(mood, sampleRate) {
    const { t60 } = AIR_MOODS[mood];
    const seconds = irSeconds(t60);
    return {
        client: 'air',
        seconds,
        channels: 2,
        sampleRate,
        pinned: true,
        render(offline) {
            const length = offline.length;
            const rng = placeRng(AIR_MOODS[mood].seed);
            const parts = [0, 1].map(ch => rawChannel(rng, length, sampleRate, t60, EARLY_REFLECTIONS[ch]));
            const buffers = ['mid', 'low', 'early'].map((part) => {
                const buffer = offline.createBuffer(2, length, sampleRate);
                buffer.copyToChannel(parts[0][part], 0);
                buffer.copyToChannel(parts[1][part], 1);
                return buffer;
            });
            const tailStart = (PRE_DELAY_MS + TAIL_START_MS) / 1000;
            const [mid, low, early] = buffers.map((buffer) => {
                const source = offline.createBufferSource();
                source.buffer = buffer;
                source.start(0);
                return source;
            });
            const midLp = makeFilter(offline, 'lowpass', 10000, { q: 'gentle' });
            midLp.frequency.setValueAtTime(10000, tailStart);
            midLp.frequency.setTargetAtTime(1000, tailStart, TAIL_CUTOFF_TAU_RATIO * t60);
            mid.connect(midLp).connect(offline.destination);
            low.connect(makeFilter(offline, 'lowpass', LOW_BAND_HZ, { q: 'gentle' })).connect(offline.destination);
            early.connect(offline.destination);
        },
        finish(buffer) {
            const channels = [buffer.getChannelData(0), buffer.getChannelData(1)];
            const k = unitEnergyScale(channels);
            for (const data of channels) {
                for (let i = 0; i < data.length; i++) data[i] *= k;
            }
        },
    };
}

// ------------------------------------------------------------------ runtime

export class IslandAir {
    constructor(ctx, bank, { phase = 'day', weather = {}, timers = globalThis } = {}) {
        this.context = ctx;
        this.bank = bank;
        this._timers = timers;
        this._night = AIR_PHASE_NIGHT[phase] ?? 0;
        this._weather = { rain: clamp01(weather.rain), fog: clamp01(weather.fog) };
        this._idleTimer = null;
        this._destroyed = false;

        this.bedInput = ctx.createGain();
        this.bedGate = ctx.createGain();
        this.cueInput = ctx.createGain();
        this._highpass = makeFilter(ctx, 'highpass', AIR_HIGHPASS_HZ);
        this._lowpass = makeFilter(ctx, 'lowpass', 7000);
        this.output = ctx.createGain();
        this._convolvers = {};
        this._gains = {};
        for (const mood of ['day', 'night']) {
            const conv = ctx.createConvolver();
            conv.normalize = false;
            const gain = ctx.createGain();
            conv.connect(gain).connect(this._lowpass);
            this._convolvers[mood] = conv;
            this._gains[mood] = gain;
        }
        this._connected = { day: false, night: false };
        this.bedInput.connect(this.bedGate).connect(this._highpass);
        this.cueInput.connect(this._highpass);
        this._lowpass.connect(this.output);
        this._applyMix(ctx.currentTime, 0);
        this._applyColour(ctx.currentTime, 0);

        this.ready = Promise.all(['day', 'night'].map(mood => this._bake(mood)))
            .then(results => results.every(Boolean));
    }

    buffers() {
        return { day: this._convolvers.day.buffer ?? null, night: this._convolvers.night.buffer ?? null };
    }

    // 'dawn' | 'day' | 'dusk' | 'night'. Repeated calls with the same phase do nothing.
    setPhase(phase) {
        const night = AIR_PHASE_NIGHT[phase] ?? 0;
        if (night === this._night || this._destroyed) return;
        this._night = night;
        const now = this.context.currentTime;
        this._applyMix(now, AIR_CROSSFADE_TAU_SEC);
        this._applyColour(now, AIR_CROSSFADE_TAU_SEC);
    }

    setWeather({ rain = 0, fog = 0 } = {}) {
        const next = { rain: clamp01(rain), fog: clamp01(fog) };
        if (this._destroyed || (next.rain === this._weather.rain && next.fog === this._weather.fog)) return;
        this._weather = next;
        this._applyColour(this.context.currentTime, AIR_CROSSFADE_TAU_SEC);
    }

    destroy() {
        this._destroyed = true;
        this._clearIdleTimer();
        for (const node of [this.bedInput, this.bedGate, this.cueInput, this._highpass, this._lowpass, this.output,
            ...Object.values(this._convolvers), ...Object.values(this._gains)]) {
            try { node.disconnect(); } catch { /* already disconnected */ }
        }
    }

    async _bake(mood) {
        const key = `air:${mood}:${this.context.sampleRate}`;
        const ok = await this.bank.bake(key, airIrRecipe(mood, this.context.sampleRate));
        if (!ok || this._destroyed) return false;
        // Set once: this convolver has never had a buffer.
        this._convolvers[mood].buffer = this.bank.get(key);
        return true;
    }

    _applyMix(now, tau) {
        const gains = airCrossfadeGains(this._night);
        for (const mood of ['day', 'night']) {
            const target = gains[mood];
            if (target > 0 && !this._connected[mood]) {
                this._highpass.connect(this._convolvers[mood]);
                this._connected[mood] = true;
            }
            const param = this._gains[mood].gain;
            if (tau > 0) param.setTargetAtTime(target, now, tau);
            else param.setValueAtTime(target, now);
        }
        this._clearIdleTimer();
        const idle = ['day', 'night'].filter(mood => gains[mood] === 0 && this._connected[mood]);
        if (!idle.length) return;
        const cut = () => {
            this._idleTimer = null;
            for (const mood of idle) {
                if (airCrossfadeGains(this._night)[mood] !== 0 || !this._connected[mood]) continue;
                try { this._highpass.disconnect(this._convolvers[mood]); } catch { /* already */ }
                this._connected[mood] = false;
            }
        };
        if (tau > 0) this._idleTimer = this._timers.setTimeout(cut, IDLE_DISCONNECT_SEC * 1000);
        else cut();
    }

    _applyColour(now, tau) {
        const { lowpassHz, gain } = airReturnColour({ night: this._night, ...this._weather });
        const lp = this._lowpass.frequency;
        const out = this.output.gain;
        if (tau > 0) {
            lp.setTargetAtTime(lowpassHz, now, tau);
            out.setTargetAtTime(gain, now, tau);
        } else {
            lp.setValueAtTime(lowpassHz, now);
            out.setValueAtTime(gain, now);
        }
    }

    _clearIdleTimer() {
        if (this._idleTimer !== null) this._timers.clearTimeout(this._idleTimer);
        this._idleTimer = null;
    }
}

function clamp01(value) {
    return Math.max(0, Math.min(1, Number(value) || 0));
}
