// Wind that gusts across the island (AMB-4). One brown-noise read split into
// two decorrelated lanes, one on each side, carries scheduled gusts: a gust
// rises on the upwind lane first and reaches the other a moment later, so
// it crosses the stereo field. A leaf-canopy rustle follows every gust, and
// at real wind the harbor rigging sings two faint whistles that bend with
// the gust. Nearly silent on a calm day; the director's strength sets the
// level, the wind speed the brightness, fog muffles it.
//
// Every node is persistent (S8): a gust is automation on the lanes' own
// gust gains, the low-pass detune, the canopy's tick density and the
// whistle band-passes, placed on the Transport from the layer's seeded
// stream, never a node. The director's 1 Hz mapping moves separate params
// (levels and base cutoffs), so its slews never cut a gust short.
//
// The lanes leave the held note's lane open (plan 3.3, S1): a fixed cut at
// the D (HELD_SLOT) after the high-pass, where the brown lanes are loudest.

import { BaseLayer } from './BaseLayer.js';
import { MIN_GAIN, rand } from '../AudioEngine.js';
import { makeFilter } from '../Filters.js';
import { heldSlot } from './HeldNote.js';
import { renewalProcess } from '../Transport.js';

const WHISTLE_AIR_SEND = 0.15;
// The rigging's two Aeolian whistles (Hz at a gust's peak drive 0 → 1).
// Both stay above 800 Hz at every bend (S1: no world voice sustains a
// fundamental in 500–700 Hz).
export const WHISTLE_HZ = Object.freeze([930, 1370]);
export const WHISTLE_BEND = Object.freeze([0.95, 0.3]);
const WHISTLE_Q = 18;
// Canopy: leaf ticks (dust) in the leaf band, up to CANOPY_DENSITY ticks/s
// at a full gust, and its winter factor (bare trees).
const CANOPY_BAND_HZ = Object.freeze([2200, 7000]);
const CANOPY_TICK_MS = 2.5;
const CANOPY_DENSITY = 2500;
const CANOPY_WINTER = 0.3;
// Output gains: the two lanes at rest, with their gusts, read as the
// Wave-1 wind at the same strength (the calibrated anchor's wind), with the
// 0.9 dB the held note's slot takes from the lanes given back.
const LANE_GAIN = 0.65 * Math.pow(10, 0.9 / 20);
const CANOPY_GAIN = 0.05;
const WHISTLE_GAIN = 0.9;

const clamp01 = v => Math.max(0, Math.min(1, Number(v) || 0));

// The base low-pass of both lanes (Hz): brighter with wind speed and
// strength, duller in fog.
export function windCutoffHz({ strength = 0, wind = 0, fog = 0 } = {}) {
    return Math.max(160, 240 + 220 * wind + 380 * strength - 120 * fog);
}

// How much the rigging sings (0..1): only in real weather and real wind.
export function whistleDrive({ strength = 0, wind = 0 } = {}) {
    return clamp01((strength - 0.15) / 0.35) * clamp01((wind - 0.4) / 0.8);
}

// One gust, drawn from `rng` in a fixed order. `strength` sets how often
// gusts come; `g` (0.35..1) is its size. Lane gains swell by up to
// `swell`× over their rest level, the low-pass opens by (1 + 0.8g), the
// whistles bend up with g. Times in seconds from the gust's start.
export function gustPlan(strength, rng) {
    const s = clamp01(strength);
    const g = rand(rng, 0.35, 1);
    const rise = rand(rng, 1, 3);
    const fall = rand(rng, 2.5, 7);
    const trail = rand(rng, 0.3, 0.9);
    const swellA = 1 + 1.7 * g * rand(rng, 0.8, 1);
    const swellB = 1 + 1.7 * g * rand(rng, 0.8, 1);
    // The next gust starts after this one's rise plus an exponential wait
    // averaging 9 s on a calm day and 4 s at full strength.
    const gap = -Math.log(1 - rng()) * (9 - 5 * s) + rise;
    return { g, rise, fall, trail, swell: [swellA, swellB], openCents: 1200 * Math.log2(1 + 0.8 * g), gap };
}

export class WindLayer extends BaseLayer {
    constructor(engine, options = {}) {
        super(engine, { trim: 0.16, group: 'wind', ...options });
        this.state = { strength: 0, wind: 0, fog: 0, windX: 0, winter: false };
        this._lanes = [];
        this._canopy = null;
        this._whistles = [];
        this._whistleLevel = null;
        this._nextGap = 4;
    }

    _start(ctx) {
        // One brown-noise read → HP 90 → rest level, split into its two
        // channels: each is a gust lane (its own low-pass, which a gust
        // opens through detune, and its own gust gain) that stays on its
        // side. The pool's channels are two noises correlated 0.35, so the
        // lanes are decorrelated without panning (a balance pan would fold
        // one channel into the other and raise the bed's ICC) and without a
        // second pool lane.
        const source = this.engine.noiseSource('brown', { rng: this.rng });
        const hp = makeFilter(ctx, 'highpass', 90, { q: 'butterworth' });
        const slot = heldSlot(ctx);
        const level = ctx.createGain();
        level.gain.value = LANE_GAIN;
        const split = ctx.createChannelSplitter(2);
        const merge = ctx.createChannelMerger(2);
        source.connect(hp).connect(slot).connect(level).connect(split);
        for (const ch of [0, 1]) {
            const lp = makeFilter(ctx, 'lowpass', windCutoffHz(this.state), { q: 'butterworth' });
            const gust = ctx.createGain();
            gust.gain.value = 1;
            split.connect(lp, ch).connect(gust).connect(merge, 0, ch);
            this.track(lp, gust);
            this._lanes.push({ lp, gust });
        }
        merge.connect(this.out);
        this.trackSource(source);
        this.track(hp, slot, level, split, merge);

        // Canopy: leaf ticks from the dust worklet in the leaf band, their
        // density raised by each gust and at rest nothing (the worklet idles
        // at zero density). Without AudioWorklet the trees stay still.
        const leaves = this.engine.noiseWorklet('dust', { rng: this.rng, density: 0, decayMs: CANOPY_TICK_MS });
        if (leaves) {
            const canopyHp = makeFilter(ctx, 'highpass', CANOPY_BAND_HZ[0], { q: 'butterworth' });
            const canopyLp = makeFilter(ctx, 'lowpass', CANOPY_BAND_HZ[1], { q: 'butterworth' });
            const canopyLevel = ctx.createGain();
            canopyLevel.gain.value = this._canopyLevel();
            leaves.connect(canopyHp).connect(canopyLp).connect(canopyLevel).connect(this.out);
            this.track(leaves, canopyHp, canopyLp, canopyLevel);
            this._canopy = { node: leaves, level: canopyLevel, density: leaves.parameters.get('density') };
        }

        // Rigging whistles: narrow band-passes on the wind's noise, gated by
        // each gust (quadratic in its size) and by the weather.
        this._whistleLevel = ctx.createGain();
        this._whistleLevel.gain.value = MIN_GAIN;
        const whistleBus = ctx.createGain();
        whistleBus.gain.value = 1;
        this._whistleLevel.connect(whistleBus).connect(this.out);
        this.track(this._whistleLevel, whistleBus);
        for (const hz of WHISTLE_HZ) {
            const bp = makeFilter(ctx, 'bandpass', hz * WHISTLE_BEND[0], { q: WHISTLE_Q });
            const gate = ctx.createGain();
            gate.gain.value = 0;
            source.connect(bp).connect(gate).connect(this._whistleLevel);
            this.track(bp, gate);
            this._whistles.push({ hz, bp, gate });
        }
        this.airSend(WHISTLE_AIR_SEND, whistleBus);

        source.start(ctx.currentTime);

        // The first gust lands at a steady-state phase of the mean gap (a
        // 2 s rise plus the exponential wait), so an enable never opens
        // gustier than the wind runs (7.4, C-UX7): one draw, as before.
        this.registerProcess(renewalProcess({
            name: 'wind',
            first: () => 1 + this.rng() * (2 + 9 - 5 * this.state.strength),
            gap: () => this._nextGap,
            emit: at => this._gust(at),
        }));
    }

    // strength 0..1 overall wind presence (the level); wind = |windX| 0..1.4;
    // fog 0..1; `windX` (signed, optional) picks the upwind lane; `winter`
    // bares the trees. `timeConstant` overrides the slow slews (a starting
    // director primes its layers at their targets under its own fade-in).
    setWind({ strength = 0, wind = 0, fog = 0, windX = null, winter = false } = {}, timeConstant = null) {
        this.state = {
            strength: clamp01(strength),
            wind: Math.max(0, Number(wind) || 0),
            fog: clamp01(fog),
            windX: Number.isFinite(Number(windX)) ? Number(windX) : this.state.windX,
            winter: Boolean(winter),
        };
        this.setLevel(this.state.strength, timeConstant ?? 4);
        if (!this._lanes.length || !this.engine.context) return;
        const now = this.engine.now();
        const tau = timeConstant ?? 5;
        const cutoff = windCutoffHz(this.state);
        for (const lane of this._lanes) lane.lp.frequency.setTargetAtTime(cutoff, now, tau);
        this._canopy?.level.gain.setTargetAtTime(this._canopyLevel(), now, tau);
        this._whistleLevel.gain.setTargetAtTime(Math.max(MIN_GAIN, WHISTLE_GAIN * whistleDrive(this.state)), now, tau);
    }

    _canopyLevel() {
        return CANOPY_GAIN * (0.4 + this.state.strength) * (this.state.winter ? CANOPY_WINTER : 1);
    }

    // One gust at audio time `t`: the upwind lane swells, the other follows
    // `trail` s later; the canopy and whistles follow the gust's size. Each
    // param is cleared from the gust's start first, so a gust that starts
    // before the last one has settled takes over from wherever it is.
    _gust(t) {
        const plan = gustPlan(this.state.strength, this.rng);
        this._nextGap = plan.gap;
        const upwind = this.state.windX < 0 ? 1 : 0;
        const riseTau = plan.rise / 3;
        const fallTau = plan.fall / 3;
        [upwind, 1 - upwind].forEach((index, k) => {
            const lane = this._lanes[index];
            const start = t + (k === 0 ? 0 : plan.trail);
            const peakAt = start + plan.rise;
            for (const param of [lane.gust.gain, lane.lp.detune]) param.cancelScheduledValues(start);
            lane.gust.gain.setTargetAtTime(plan.swell[k], start, riseTau);
            lane.gust.gain.setTargetAtTime(1, peakAt, fallTau);
            lane.lp.detune.setTargetAtTime(plan.openCents, start, riseTau);
            lane.lp.detune.setTargetAtTime(0, peakAt, fallTau);
        });
        if (this._canopy) {
            const density = this._canopy.density;
            const canopyAt = t + plan.trail * 0.5;
            density.cancelScheduledValues(canopyAt);
            density.setTargetAtTime(CANOPY_DENSITY * plan.g, canopyAt, riseTau);
            density.setTargetAtTime(0, canopyAt + plan.rise, fallTau);
        }
        const whistle = plan.g * plan.g;
        const bend = WHISTLE_BEND[0] + WHISTLE_BEND[1] * plan.g;
        for (const { hz, bp, gate } of this._whistles) {
            for (const param of [gate.gain, bp.frequency]) param.cancelScheduledValues(t);
            gate.gain.setTargetAtTime(whistle, t, riseTau);
            gate.gain.setTargetAtTime(0, t + plan.rise, fallTau);
            bp.frequency.setTargetAtTime(hz * bend, t, riseTau);
            bp.frequency.setTargetAtTime(hz * WHISTLE_BEND[0], t + plan.rise, fallTau);
        }
    }

    stop() {
        const silentAt = super.stop();
        const leaves = this._canopy?.node;
        if (leaves && silentAt !== undefined) {
            const ms = Math.max(0, (silentAt - this.engine.now() + 0.2) * 1000);
            setTimeout(() => leaves.port.postMessage('stop'), ms);
        }
        this._lanes = [];
        this._canopy = null;
        this._whistles = [];
        this._whistleLevel = null;
        return silentAt;
    }
}
