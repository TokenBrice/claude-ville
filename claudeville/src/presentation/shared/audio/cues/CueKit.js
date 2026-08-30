// One-shot cue voices. Every pitched cue draws from the shared tonal center
// (MusicalScale.cueTones) so cues can never clash with the ambient layers.
// All cues route through the engine's cue bus and gently duck the ambience.

import { MIN_GAIN, rand } from '../AudioEngine.js';
import { bellVoicingForProvider, cueTones } from '../MusicalScale.js';
import { CUE_LANES, computeCueMix } from '../CueGovernor.js';
import { eventBus } from '../../../../domain/events/DomainEvent.js';
import { bucketForStatus } from '../../../../domain/services/SignalLedger.js';

const COOLDOWNS_MS = {
    arrival: 20000,
    departure: 20000,
    distress: 30000,
    recovery: 30000,
    council: 60000,
    hourBell: 55 * 60000,
    aurora: 120000,
    thunder: 8000,
    summons: 45000,
};

// Weather/clock cues are scenery, exempt from the global chatter budget.
const UNBUDGETED = new Set(['thunder', 'hourBell']);

const LANE_BY_KIND = Object.freeze({
    arrival: CUE_LANES.ROUTINE,
    departure: CUE_LANES.ROUTINE,
    distress: CUE_LANES.ERRORS,
    recovery: CUE_LANES.ROUTINE,
    council: CUE_LANES.ROUTINE,
    hourBell: CUE_LANES.SCENERY,
    aurora: CUE_LANES.SCENERY,
    thunder: CUE_LANES.SCENERY,
    summons: CUE_LANES.NEEDS_YOU,
});

function laneForCue(kind, status) {
    if (kind === 'distress') {
        const bucket = bucketForStatus(status);
        if (bucket === 'quota') return CUE_LANES.QUOTA;
        if (bucket === 'needsYou') return CUE_LANES.NEEDS_YOU;
    }
    return LANE_BY_KIND[kind];
}

const CUE_LABELS = {
    arrival: 'Agent arrived',
    departure: 'Agent departed',
    distress: 'Agent in distress',
    recovery: 'Agent recovered',
    council: 'Council gathering',
    hourBell: 'Hour bell',
    aurora: 'Chronicle milestone',
    summons: 'Agent needs you',
    thunder: 'Thunder',
};

const MAX_SUMMONS_WAIT_MS = 20 * 60 * 1000;
const URGENT_GUARD_MS = Object.freeze({
    distress: 3300,
    summons: 2800,
});

function clamp01(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 0;
    return Math.max(0, Math.min(1, n));
}

function summonsUrgency(waitingCount, oldestWaitMs) {
    const count = Number(waitingCount);
    const waitMs = Number(oldestWaitMs);
    const countLift = Number.isFinite(count)
        ? clamp01((Math.max(1, count) - 1) / 4)
        : 0;
    const waitLift = Number.isFinite(waitMs)
        ? clamp01(Math.max(0, waitMs) / MAX_SUMMONS_WAIT_MS)
        : 0;
    return clamp01(countLift * 0.55 + waitLift * 0.45);
}

function panForScreenX(screenX) {
    const x = Number(screenX);
    if (!Number.isFinite(x)) return 0;
    return Math.max(-1, Math.min(1, x * 2 - 1));
}

function councilBellCount(teamSize) {
    const size = Number(teamSize);
    if (!Number.isFinite(size)) return 3;
    return Math.max(2, Math.min(5, Math.round(size)));
}

export class CueKit {
    constructor(engine, governor) {
        this.engine = engine;
        this.governor = governor;
        this.lastCue = null;
    }

    // Returns true when the governor accepted the cue. Routine cues sound
    // after the short aggregation window; urgent lanes sound immediately.
    play(kind, options = {}) {
        const cooldownMs = COOLDOWNS_MS[kind];
        const lane = options.lane || laneForCue(kind, options.status || options.kind);
        if (cooldownMs == null || !lane) return false;
        return this.governor.submit({
            ...options,
            kind,
            lane,
            cooldownMs,
            guardMs: URGENT_GUARD_MS[kind],
            budget: !UNBUDGETED.has(kind),
            aggregate: kind !== 'council',
        }, (cue, stage) => this._playAccepted(cue, stage));
    }

    // With no active audio context this still emits the cue event for captions
    // and other accessibility consumers; it simply skips synthesis.
    _playAccepted({
        kind,
        eventKind = kind,
        lane,
        phase = 'day',
        intensity = 1,
        agentId = null,
        label = null,
        provider = null,
        screenX = 0.5,
        teamSize,
        waitingCount,
        oldestWaitMs,
    } = {}, {
        prepare = false,
        announceOnly = false,
        delayMs = 0,
    } = {}) {
        if (announceOnly) {
            this._emitCue({ kind, eventKind, lane, agentId, label });
            return true;
        }

        const captured = prepare ? [] : null;
        this._capturedCancellations = captured;
        const canSound = Boolean(this.engine?.context && this.engine?.started);
        if (canSound) {
            const mix = computeCueMix(lane);
            const cueGain = this.engine.cueBus?.gain;
            if (cueGain) {
                if (typeof cueGain.setTargetAtTime === 'function') {
                    cueGain.setTargetAtTime(mix.cueBusGain, this.engine.now(), 0.02);
                } else {
                    cueGain.value = mix.cueBusGain;
                }
            }
            const notes = cueTones(phase);
            const t = this.engine.now() + 0.03 + Math.max(0, Number(delayMs) || 0) / 1000;
            const agentBell = { pan: panForScreenX(screenX), provider };
            switch (kind) {
                case 'arrival':
                    this.engine.duck(mix.duckDepth, 0.5);
                    this._bell(t, notes.root, { gain: 0.035, decay: 1.6, ...agentBell });
                    this._bell(t + 0.22, notes.fifth, { gain: 0.03, decay: 2, ...agentBell });
                    break;
                case 'departure':
                    this.engine.duck(mix.duckDepth, 0.5);
                    this._bell(t, notes.fifth, { gain: 0.03, decay: 1.6, ...agentBell });
                    this._bell(t + 0.24, notes.root, { gain: 0.032, decay: 2.2, ...agentBell });
                    break;
                case 'distress':
                    this.engine.duck(mix.duckDepth, 0.8);
                    this._bell(t, notes.low, { gain: 0.05, decay: 3, cutoff: 900, ...agentBell });
                    break;
                case 'recovery':
                    this.engine.duck(mix.duckDepth, 0.5);
                    this._bell(t, notes.third, { gain: 0.028, decay: 1.4, ...agentBell });
                    this._bell(t + 0.2, notes.octave, { gain: 0.026, decay: 2, ...agentBell });
                    break;
                case 'council': {
                    this.engine.duck(mix.duckDepth, 1);
                    const pattern = [notes.root, notes.fifth, notes.octave, notes.third, notes.high];
                    const count = councilBellCount(teamSize);
                    for (let i = 0; i < count; i++) {
                        this._bell(t + i * 0.28, pattern[i], {
                            gain: Math.max(0.022, 0.03 - i * 0.002),
                            decay: i === count - 1 ? 2.4 : 1.8,
                            provider,
                        });
                    }
                    break;
                }
                case 'hourBell':
                    this.engine.duck(mix.duckDepth, 1.2);
                    this._bell(t, 220, { gain: 0.06, decay: 4, cutoff: 1600 });
                    break;
                case 'aurora': {
                    this.engine.duck(mix.duckDepth, 1);
                    const run = [notes.root, notes.fifth, notes.octave, notes.high];
                    run.forEach((hz, i) => {
                        this._bell(t + i * 0.16, hz, { gain: 0.022, decay: 2.6, cutoff: 3200 });
                    });
                    break;
                }
                // Someone in the village needs a person. A rising two-note call,
                // brighter than distress and deliberately unlike any scenery cue,
                // so it reads as "you" rather than "weather".
                case 'summons': {
                    const urgency = summonsUrgency(waitingCount, oldestWaitMs);
                    const gap = 0.18 - urgency * 0.035;
                    this.engine.duck(mix.duckDepth, 0.7);
                    this._bell(t, notes.fifth, {
                        gain: 0.038,
                        decay: 1.2,
                        cutoff: 3000,
                        ...agentBell,
                    });
                    this._bell(t + gap, notes.octave, {
                        gain: 0.042,
                        decay: 2.4,
                        cutoff: 3400,
                        ...agentBell,
                    });
                    break;
                }
                case 'thunder':
                    this._thunder(t, intensity, mix.duckDepth);
                    break;
                default:
                    this._capturedCancellations = null;
                    return false;
            }
        }

        this._capturedCancellations = null;
        if (prepare) {
            return () => {
                for (const cancel of captured) cancel();
            };
        }
        return this._emitCue({ kind, eventKind, lane, agentId, label });
    }

    _emitCue({ kind, eventKind = kind, lane, agentId = null, label = null }) {
        const at = Date.now();
        this.lastCue = { kind: eventKind, lane, at };
        eventBus.emit('audio:cue-played', {
            kind: eventKind,
            agentId: agentId ?? null,
            label: String(label || CUE_LABELS[kind] || kind),
            at,
        });
        return true;
    }

    // A small bell: the fundamental stays in the shared pentatonic scale;
    // provider voicings add quiet harmonic partials and a register shift.
    _bell(t, hz, {
        gain = 0.04,
        decay = 2,
        cutoff = 2400,
        pan = 0,
        provider = null,
    } = {}) {
        const ctx = this.engine.context;
        const tone = ctx.createBiquadFilter();
        tone.type = 'lowpass';
        tone.frequency.value = cutoff;
        tone.Q.value = 0.3;
        const panner = typeof ctx.createStereoPanner === 'function'
            ? ctx.createStereoPanner()
            : null;
        const safePan = Math.max(-1, Math.min(1, Number(pan) || 0));
        if (panner) {
            if (typeof panner.pan?.setValueAtTime === 'function') panner.pan.setValueAtTime(safePan, t);
            else if (panner.pan) panner.pan.value = safePan;
            tone.connect(panner).connect(this.engine.cueBus);
        } else {
            tone.connect(this.engine.cueBus);
        }

        const voicing = bellVoicingForProvider(provider);
        const register = Number(voicing.register) || 1;
        const partials = voicing.partials.map(partial => ({
            ratio: partial.ratio,
            gain: gain * partial.gain,
            decay: decay * partial.decay,
        }));
        const nodes = panner ? [tone, panner] : [tone];
        for (const partial of partials) {
            const osc = ctx.createOscillator();
            const env = ctx.createGain();
            osc.type = 'sine';
            osc.frequency.value = hz * register * partial.ratio;
            env.gain.setValueAtTime(MIN_GAIN, t);
            env.gain.exponentialRampToValueAtTime(partial.gain, t + 0.012);
            env.gain.exponentialRampToValueAtTime(MIN_GAIN, t + partial.decay);
            osc.connect(env).connect(tone);
            osc.start(t);
            osc.stop(t + partial.decay + 0.1);
            nodes.push(osc, env);
        }
        let cancelled = false;
        const cleanup = () => {
            for (const node of nodes) {
                try { node.disconnect(); } catch { /* gone */ }
            }
        };
        const cleanupTimer = setTimeout(cleanup, (decay + 0.5) * 1000);
        const cancel = () => {
            if (cancelled) return;
            cancelled = true;
            clearTimeout(cleanupTimer);
            for (const node of nodes) {
                if (typeof node.stop === 'function') {
                    try { node.stop(this.engine.now()); } catch { /* already stopped */ }
                }
            }
            cleanup();
        };
        if (this._capturedCancellations) this._capturedCancellations.push(cancel);
        return cancel;
    }

    // Thunder: a swept low-pass burst of brown noise with a secondary rumble
    // bump, so strikes roll instead of thump.
    _thunder(t, intensity = 1, duckDepth = 0.45) {
        const ctx = this.engine.context;
        const level = Math.max(0.2, Math.min(1, intensity));
        this.engine.duck(duckDepth, 1.5);

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
        const cancel = () => {
            try { src.stop(this.engine.now()); } catch { /* already stopped */ }
            try { src.disconnect(); lp.disconnect(); env.disconnect(); } catch { /* gone */ }
        };
        if (this._capturedCancellations) this._capturedCancellations.push(cancel);
        return cancel;
    }
}
