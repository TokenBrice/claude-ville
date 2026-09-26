// The held note (plan 3.3, SIG-3, S6 "state is audible for as long as it is
// true"): while anyone waits on the operator and no music plays, the Village
// sustains a faint open fourth, A3 + D4, over the island; when the last wait
// is answered the D falls to C♯ (C at night) over 1.2 s and exhales away.
//
// Two single sines, each drifting ≤ 1 cent on its own slow LFO, so the pair
// never beats (the retired tonal bed's ±4-cent pair beat to silence every
// 3.9 s). The level is specified by loudness, never by gain: bed − 8 LU
// short-term, read from the engine's pre-duck bed tap (`bedLoudness()`, the
// same bus domain the signal bed joins in). The voice lives on its own bus,
// `signalBed` (S3: no presence dip, no attention stage, no music duck; −6 dB
// only under urgent cues), through the owning director's crossfade gain, so
// a preset switch or a pause carries it with the director.
//
// The director decides when it is open (Village, no music, link live, a
// non-stale actionable agent) and calls `setState` on its 1 Hz tick;
// repeated calls with the same state only re-level it, and every call reads
// the bed, so the note opens on a settled bed rather than the instant's
// swell. Its sources start with the director, silent, and stop with it:
// nothing here places a sound from a timer.
//
// The held note's lane (S1, like the needs-you lane): the world bed (wind
// and sea) and the murmur carry a permanent narrow cut centred on the D
// (HELD_SLOT, `heldSlot`), so a note 8 LU under the bed still lifts the
// 270–310 Hz band ≥ 6 dB over the bed before the wait. The slot never
// moves: the bed sounds the same with or without a wait.

import { MIN_GAIN, holdAt } from '../AudioEngine.js';
import { makeFilter } from '../Filters.js';

export const HELD_NOTE_HZ = Object.freeze({ low: 220, open: 293.66 }); // A3, D4
export const RESOLVED_HZ = Object.freeze({ day: 277.18, night: 261.63 }); // C♯4, C4
export const HELD_UNDER_BED_LU = 8;
// The lane's cut in the world bed and the murmur (peaking, at the D).
export const HELD_SLOT = Object.freeze({ hz: HELD_NOTE_HZ.open, q: 4, gainDb: -6 });

/** One persistent HELD_SLOT filter for a bed voice's chain (the caller tracks it). */
export function heldSlot(ctx) {
    return makeFilter(ctx, 'peaking', HELD_SLOT.hz, { q: HELD_SLOT.q, gain: HELD_SLOT.gainDb });
}
// The A sits this far under the D: the suspended note carries the tension
// and most of the pair's energy, inside the band a listener (and the probe's
// 270–310 Hz rise) hears it by.
export const LOW_UNDER_OPEN_DB = -4;
// K-weighting of the pair at 220 and 294 Hz, energy-weighted (RLB high-pass
// at 38 Hz −0.26 / −0.15 dB, the shelf stage ≈ 0): the rendered pair on
// the signalBed stem measures this against its sine amplitudes (virtual
// clock, Village W = 1 and 15: −0.1 / −0.15 LU).
const PAIR_WEIGHT_DB = -0.15;
// The bed before any tap reading exists (a wake, the first 1.5 s): anchor A
// in the bus domain (−38 LUFS at the output, PROGRAM_TRIM_DB +28.2).
const DEFAULT_BED_LUFS = -66;

const DRIFT_CENTS = 0.9;
const DRIFT_HZ = Object.freeze({ low: 0.031, open: 0.043 });
const ATTACK_TAU_SEC = 1.2;
// The bed reading is smoothed (an energy mean, τ 20 s, read on every tick
// so it is settled when a wait opens) and the note follows it only past
// ±0.5 dB, slowly: a gusting bed must not modulate the note (its level
// tolerance is ±1 LU; beating depth ≤ 3 dB). A reading older than
// BED_STALE_SEC restarts the mean.
const BED_SMOOTH_TAU_SEC = 20;
const BED_STALE_SEC = 30;
const RELEVEL_TAU_SEC = 6;
const RELEVEL_MIN_DB = 0.5;
const RESOLVE_SEC = 1.2;
const RELEASE_TAU_SEC = 0.45;
const FADE_TAU_SEC = 0.8;
// A setTarget release is ~60 dB down after 7τ; it is then set to silence.
const SETTLE_TAUS = 7;

const gainToDb = gain => (gain > 0 ? 20 * Math.log10(gain) : -Infinity);

const LOW_RATIO = Math.pow(10, LOW_UNDER_OPEN_DB / 20);

// The envelope gain (the D's amplitude; the A plays LOW_RATIO under it) whose
// pair measures `bedLufs − 8` LUFS: sines of amplitude g and r·g, duplicated
// on both output channels, carry g²·(1 + r²) of channel-summed mean square
// (BS.1770: L = −0.691 + 10·log10 Σ ms).
export function heldNoteGain(bedLufs) {
    const bed = Number.isFinite(bedLufs) ? bedLufs : DEFAULT_BED_LUFS;
    const targetLufs = bed - HELD_UNDER_BED_LU;
    return Math.sqrt(Math.pow(10, (targetLufs + 0.691 - PAIR_WEIGHT_DB) / 10) / (1 + LOW_RATIO * LOW_RATIO));
}

export function resolvedHz(phase) {
    return phase === 'night' ? RESOLVED_HZ.night : RESOLVED_HZ.day;
}

export class HeldNote {
    constructor(engine, { director = 'ambient' } = {}) {
        this.engine = engine;
        this.director = director;
        this.running = false;
        this.state = 'closed';
        this.phase = 'day';
        this._bedLufs = null;
        this._bedAt = -Infinity;
        this._gain = 0;
        this._silentAt = 0;
        this._nodes = [];
        this._sources = [];
        this._env = null;
        this._open = null;
    }

    start() {
        if (this.running || !this.engine.context) return;
        const ctx = this.engine.context;
        const t = this.engine.now();
        this._env = ctx.createGain();
        this._env.gain.setValueAtTime(0, t);
        this._env.connect(this.engine.busInput('signalBed', this.director));
        this._sine(ctx, HELD_NOTE_HZ.low, DRIFT_HZ.low, t, LOW_RATIO);
        this._open = this._sine(ctx, HELD_NOTE_HZ.open, DRIFT_HZ.open, t, 1);
        this.running = true;
        this.state = 'closed';
    }

    // One sine with its own ≤ 1 cent drift, started silent under the envelope.
    _sine(ctx, hz, driftHz, t, level) {
        const osc = ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(hz, t);
        const lfo = ctx.createOscillator();
        lfo.type = 'sine';
        lfo.frequency.value = driftHz;
        const depth = ctx.createGain();
        depth.gain.value = DRIFT_CENTS;
        lfo.connect(depth).connect(osc.detune);
        const trim = ctx.createGain();
        trim.gain.value = level;
        osc.connect(trim).connect(this._env);
        osc.start(t);
        lfo.start(t);
        this._sources.push(osc, lfo);
        this._nodes.push(depth, trim);
        return osc;
    }

    // `open`: someone waits, the Village plays no music, the link is live.
    // Closing with `reason: 'answered'` resolves D→C♯ (C at night) and
    // releases; any other close (music, link, preset) simply fades.
    setState({ open = false, reason = null, phase } = {}) {
        if (phase) this.phase = phase;
        if (!this.running) return;
        const now = this.engine.now();
        this._readBed(now);
        if (this.state !== 'closed' && this.state !== 'open' && now >= this._silentAt) this.state = 'closed';
        if (open) {
            this._level(now);
            return;
        }
        if (this.state !== 'open') return;
        if (reason === 'answered') this._resolve(now);
        else this._release(now, FADE_TAU_SEC, 'fading');
    }

    _level(now) {
        const gain = heldNoteGain(this._bedLufs);
        const env = this._env.gain;
        if (this.state !== 'open') {
            // Opening, or re-opening mid-resolution: back to D, rise to level.
            holdAt(env, now);
            holdAt(this._open.frequency, now);
            this._open.frequency.setTargetAtTime(HELD_NOTE_HZ.open, now, 0.05);
            env.setTargetAtTime(gain, now, ATTACK_TAU_SEC);
            this._gain = gain;
            this.state = 'open';
            return;
        }
        if (Math.abs(gainToDb(gain) - gainToDb(this._gain)) < RELEVEL_MIN_DB) return;
        holdAt(env, now);
        env.setTargetAtTime(gain, now, RELEVEL_TAU_SEC);
        this._gain = gain;
    }

    _readBed(now) {
        const bed = this.engine.bedLoudness?.();
        if (!Number.isFinite(bed)) return;
        const dt = now - this._bedAt;
        if (!Number.isFinite(this._bedLufs) || !(dt >= 0) || dt > BED_STALE_SEC) {
            this._bedLufs = bed;
        } else {
            const a = 1 - Math.exp(-dt / BED_SMOOTH_TAU_SEC);
            const mean = (1 - a) * Math.pow(10, this._bedLufs / 10) + a * Math.pow(10, bed / 10);
            this._bedLufs = 10 * Math.log10(mean);
        }
        this._bedAt = now;
    }

    // The answer: D glides to the third over 1.2 s at the held level, then
    // the pair exhales to silence.
    _resolve(now) {
        const freq = this._open.frequency;
        holdAt(freq, now);
        freq.setValueAtTime(freq.value || HELD_NOTE_HZ.open, now);
        freq.exponentialRampToValueAtTime(resolvedHz(this.phase), now + RESOLVE_SEC);
        this._release(now + RESOLVE_SEC, RELEASE_TAU_SEC, 'resolving', now);
    }

    _release(at, tau, state, holdTime = at) {
        const env = this._env.gain;
        holdAt(env, holdTime);
        env.setTargetAtTime(0, at, tau);
        this._silentAt = at + SETTLE_TAUS * tau;
        env.setValueAtTime(0, this._silentAt);
        this._gain = 0;
        this.state = state;
    }

    // Declicked stop with the director (S8): hold, 80 ms to silence, then
    // stop the sources.
    stop() {
        if (!this.running) return undefined;
        this.running = false;
        const silentAt = this.engine.stopGroup(this._env, 0.08);
        for (const source of this._sources) {
            try { source.stop(silentAt + 0.01); } catch { /* already stopped */ }
        }
        const doomed = [...this._sources, ...this._nodes, this._env];
        const disconnectMs = Math.max(0, (silentAt - this.engine.now() + 0.2) * 1000);
        setTimeout(() => {
            for (const node of doomed) {
                try { node.disconnect(); } catch { /* gone */ }
            }
        }, disconnectMs);
        this._sources = [];
        this._nodes = [];
        this._env = null;
        this._open = null;
        this.state = 'closed';
        this._gain = 0;
        return silentAt;
    }

    snapshot() {
        const bedLufs = this._bedLufs;
        const settled = this.state !== 'open' && this.engine.now() >= this._silentAt;
        return {
            state: settled ? 'closed' : this.state,
            phase: this.phase,
            bedLufs,
            targetLufs: (Number.isFinite(bedLufs) ? bedLufs : DEFAULT_BED_LUFS) - HELD_UNDER_BED_LU,
            gainDb: this._gain > MIN_GAIN ? Number(gainToDb(this._gain).toFixed(2)) : null,
        };
    }
}
