// One-shot cue voices. Every pitched cue draws from the shared tonal center
// (MusicalScale.cueTones) so cues can never clash with the ambient layers.
// Each accepted cue gets its own bed-aware trim into the engine's cue bus
// and one note-timed duck of the bed (plan S3), cancelled with the cue.

import { MIN_GAIN, rand } from '../AudioEngine.js';
import { bellVoicingForProvider, cueTones } from '../MusicalScale.js';
import { CUE_LANES, isUrgentCueLane } from '../CueGovernor.js';
import { URGENT_TRIM_MEMORY_MS, cueTrimDb, isUrgentLevelLane } from '../CueLevel.js';
import { makeFilter } from '../Filters.js';
import { DUCK_DEPTHS, VOICE_REGISTRY } from '../Loudness.js';
import {
    CUE_ACCENT_NOTE,
    anchoredCueDelayMs,
    cueNoteOffsetsMs,
    cueScoreKey,
    cueSourceEventId,
    publishCueScore,
} from '../CueScore.js';
import { eventBus } from '../../../../domain/events/DomainEvent.js';

const COOLDOWNS_MS = {
    arrival: 20000,
    departure: 20000,
    distress: 30000,
    limit: 30000,
    recovery: 30000,
    council: 60000,
    hourBell: 55 * 60000,
    aurora: 120000,
    thunder: 8000,
    summons: 45000,
};

// Weather/clock cues are scenery, exempt from the global chatter budget.
const UNBUDGETED = new Set(['thunder', 'hourBell']);

// The kind decides the lane: the directors already chose the kind from the
// agent's bucket (ActionableRouting), so status is never consulted again here.
const LANE_BY_KIND = Object.freeze({
    arrival: CUE_LANES.ROUTINE,
    departure: CUE_LANES.ROUTINE,
    distress: CUE_LANES.ERRORS,
    limit: CUE_LANES.QUOTA,
    recovery: CUE_LANES.ROUTINE,
    council: CUE_LANES.ROUTINE,
    hourBell: CUE_LANES.SCENERY,
    aurora: CUE_LANES.SCENERY,
    thunder: CUE_LANES.SCENERY,
    summons: CUE_LANES.NEEDS_YOU,
});

export function laneForCueKind(kind) {
    return LANE_BY_KIND[kind] || null;
}

// Until the signal families get their own instruments (plan 3.2), the rate
// limit borrows the error voice and its score; its caption stays its own.
const VOICE_BY_KIND = Object.freeze({
    limit: 'distress',
});

// The S2 audibility lane each kind is levelled against (CueLevel.js).
const LEVEL_LANE_BY_KIND = Object.freeze({
    arrival: 'routine',
    departure: 'routine',
    recovery: 'routine',
    council: 'routine',
    distress: 'error',
    limit: 'limit',
    summons: 'needsYou',
    hourBell: 'scenery',
    aurora: 'scenery',
    thunder: 'thunder',
});

// The fixed cue stage the registry's nominal loudness was measured through
// (mix-v2-nominal: trim 0 behind a 0.72 cue bus). Each cue's own trim gain
// carries it, so a registry value stays the level the voice really has.
const CUE_STAGE_GAIN = 0.72;

// The bed stays ducked this long past the last note, so it returns as the
// bell rings out rather than under its strike (S3).
const DUCK_HOLD_AFTER_LAST_NOTE_SEC = 0.35;

// A cue's trim gain outlives its last note by the longest tail it may carry.
const SINK_RELEASE_PAD_SEC = 0.5;

const dbToGain = db => Math.pow(10, db / 20);

// Thunder is weather and ducks nothing; urgent cues carve the deepest room;
// the rest depend on the preset (Village ducks the bed, Town band the band).
function duckDepthsFor(kind, lane, preset) {
    if (kind === 'thunder') return DUCK_DEPTHS.thunder;
    if (isUrgentCueLane(lane)) return DUCK_DEPTHS.urgent;
    return preset === 'townBand' ? DUCK_DEPTHS.townBand : DUCK_DEPTHS.village;
}

function ducksAnything(depths) {
    return Boolean(depths) && Object.values(depths).some(db => Number(db) < 0);
}

const CUE_LABELS = {
    arrival: 'Agent arrived',
    departure: 'Agent departed',
    distress: 'hit an error',
    limit: 'is rate limited',
    recovery: 'Agent recovered',
    council: 'Council gathering',
    hourBell: 'Hour bell',
    aurora: 'Chronicle milestone',
    summons: 'Agent needs you',
    thunder: 'Thunder',
};

// Web Audio needs a moment of lead time before the first note; the score is
// published with the same lead, so a published time is a heard time.
const START_LEAD_MS = 30;

const URGENT_GUARD_MS = Object.freeze({
    distress: 3300,
    limit: 3300,
    summons: 2800,
});

// A superseded note that has not sounded yet is released over this ramp, so
// cancelling it can never click (S8: every stop is a ≥ 60 ms ramp).
const CANCEL_RELEASE_SEC = 0.06;

// The bed context a cue is levelled against when the director names none.
function bedContextFor(cue) {
    if (cue.bed === 'village' || cue.bed === 'music' || cue.bed === 'weather') return cue.bed;
    return cue.preset === 'townBand' ? 'music' : 'village';
}

function panForScreenX(screenX) {
    const x = Number(screenX);
    if (!Number.isFinite(x)) return 0;
    return Math.max(-1, Math.min(1, x * 2 - 1));
}

function monotonicNow() {
    return performance.now();
}

// Audio-clock → monotonic clock. `getOutputTimestamp` pairs the two properly,
// so a note's published time is when it is *heard*, output latency included;
// without it the pairing falls back to this instant in both clocks.
function monotonicTimeForAudioTime(engine, audioTime) {
    const ctx = engine?.context;
    const now = monotonicNow();
    if (!ctx) return now;
    let contextTime = ctx.currentTime;
    let performanceTime = now;
    const stamp = typeof ctx.getOutputTimestamp === 'function' ? ctx.getOutputTimestamp() : null;
    if (stamp
        && Number.isFinite(stamp.contextTime) && stamp.contextTime > 0
        && Number.isFinite(stamp.performanceTime) && stamp.performanceTime > 0) {
        contextTime = stamp.contextTime;
        performanceTime = stamp.performanceTime;
    }
    return performanceTime + (audioTime - contextTime) * 1000;
}

// How long after "now" a note started right now would actually be heard: the
// engine's start lead plus the device's output latency. A body-anchored cue
// subtracts this so the bell is *heard* on the accent, not scheduled on it.
const MAX_OUTPUT_LEAD_MS = 250;
function heardLeadMs(engine) {
    if (!engine?.context) return START_LEAD_MS;
    const latency = monotonicTimeForAudioTime(engine, engine.now()) - monotonicNow();
    if (!Number.isFinite(latency)) return START_LEAD_MS;
    return START_LEAD_MS + Math.max(0, Math.min(MAX_OUTPUT_LEAD_MS, latency));
}

export class CueKit {
    constructor(engine, governor) {
        this.engine = engine;
        this.governor = governor;
        this.lastCue = null;
        this.lastLevel = null;
        // Foreground urgent trims ({ at, trimDb }) for a wake with no bed read.
        this._urgentTrims = [];
    }

    // Returns true when the governor accepted the cue. Routine cues sound
    // after the short aggregation window; urgent lanes sound immediately.
    play(kind, options = {}) {
        const cooldownMs = COOLDOWNS_MS[kind];
        const lane = laneForCueKind(kind);
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
    // and other accessibility consumers; it simply skips synthesis. Either way
    // the cue's real note times reach the shared score, so visual accents land
    // on the note that carries them.
    _playAccepted(cue = {}, {
        prepare = false,
        announceOnly = false,
        delayMs = 0,
    } = {}) {
        const { kind, eventKind = kind, lane, agentId = null, label = null, replaces = null } = cue;
        if (announceOnly) {
            this._emitCue({ kind, eventKind, lane, agentId, label });
            return true;
        }

        const offsetsMs = cueNoteOffsetsMs(VOICE_BY_KIND[kind] ?? kind, cue);
        if (!offsetsMs) return false;
        const identity = {
            kind,
            agentId,
            teamName: cue.teamName ?? null,
            sourceEventId: cueSourceEventId(cue),
        };
        const canSound = Boolean(this.engine?.context && this.engine?.started);

        if (!canSound) {
            // The muted route uses the same score at the monotonic now, so
            // every accent appears at once instead of waiting for an audio
            // permission that may never arrive.
            publishCueScore({ ...identity, startMs: monotonicNow(), offsetsMs, silent: true });
            if (prepare) return () => {};
            return this._emitCue({ kind, eventKind, lane, agentId, label, replaces });
        }

        const cancels = [];
        let timer = null;
        const schedule = () => {
            timer = null;
            const anchoredDelayMs = anchoredCueDelayMs(
                kind,
                cueScoreKey(cue),
                offsetsMs,
                delayMs,
                heardLeadMs(this.engine),
            );
            const t = this.engine.now() + (START_LEAD_MS + anchoredDelayMs) / 1000;
            const sink = this._openSink(kind, cue, t, cancels);
            this._voice(kind, t, offsetsMs, cue, sink);
            this._closeSink(sink);
            this._duck(kind, lane, cue, t, offsetsMs, cancels);
            publishCueScore({
                ...identity,
                startMs: monotonicTimeForAudioTime(this.engine, t),
                offsetsMs,
                silent: false,
            });
        };

        // Arrival and departure bells belong to a body in motion: the foot rune
        // of an arriving villager lands seconds after the scene event that
        // admitted the cue. These two wait out the current event dispatch so the
        // renderer can declare when its accent is really drawn, then ring on it.
        if (CUE_ACCENT_NOTE[kind] != null) timer = setTimeout(schedule, 0);
        else schedule();

        if (prepare) {
            return () => {
                clearTimeout(timer);
                timer = null;
                for (const cancel of cancels) cancel();
            };
        }
        return this._emitCue({ kind, eventKind, lane, agentId, label, replaces });
    }

    // One voice per cue kind, struck at the score's own note offsets.
    _voice(kind, t, offsetsMs, {
        phase = 'day',
        intensity = 1,
        provider = null,
        screenX = 0.5,
    } = {}, sink) {
        const notes = cueTones(phase);
        const at = index => t + (offsetsMs[Math.min(index, offsetsMs.length - 1)] || 0) / 1000;
        const agentBell = { pan: panForScreenX(screenX), provider };
        switch (kind) {
            case 'arrival':
                this._bell(sink, at(0), notes.root, { gain: 0.035, decay: 1.6, ...agentBell });
                this._bell(sink, at(1), notes.fifth, { gain: 0.03, decay: 2, ...agentBell });
                break;
            case 'departure':
                this._bell(sink, at(0), notes.fifth, { gain: 0.03, decay: 1.6, ...agentBell });
                this._bell(sink, at(1), notes.root, { gain: 0.032, decay: 2.2, ...agentBell });
                break;
            // The error toll sounds at one fixed register for every provider:
            // a provider register shift would move it into other cues' ranges
            // (grok and omp put it at 55 Hz). The rate limit shares it until
            // its own voice lands (plan 3.2).
            case 'distress':
            case 'limit':
                this._bell(sink, at(0), notes.low, { gain: 0.05, decay: 3, cutoff: 900, pan: agentBell.pan });
                break;
            case 'recovery':
                this._bell(sink, at(0), notes.third, { gain: 0.028, decay: 1.4, ...agentBell });
                this._bell(sink, at(1), notes.octave, { gain: 0.026, decay: 2, ...agentBell });
                break;
            case 'council': {
                const pattern = [notes.root, notes.fifth, notes.octave, notes.third, notes.high];
                const count = offsetsMs.length;
                for (let i = 0; i < count; i++) {
                    this._bell(sink, at(i), pattern[i], {
                        gain: Math.max(0.022, 0.03 - i * 0.002),
                        decay: i === count - 1 ? 2.4 : 1.8,
                        provider,
                    });
                }
                break;
            }
            case 'hourBell':
                this._bell(sink, at(0), 220, { gain: 0.06, decay: 4, cutoff: 1600 });
                break;
            case 'aurora': {
                const run = [notes.root, notes.fifth, notes.octave, notes.high];
                run.forEach((hz, i) => {
                    this._bell(sink, at(i), hz, { gain: 0.022, decay: 2.6, cutoff: 3200 });
                });
                break;
            }
            // Someone in the village needs a person. A rising two-note call,
            // brighter than distress and deliberately unlike any scenery cue,
            // so it reads as "you" rather than "weather".
            case 'summons':
                this._bell(sink, at(0), notes.fifth, {
                    gain: 0.038,
                    decay: 1.2,
                    cutoff: 3000,
                    ...agentBell,
                });
                this._bell(sink, at(1), notes.octave, {
                    gain: 0.042,
                    decay: 2.4,
                    cutoff: 3400,
                    ...agentBell,
                });
                break;
            case 'thunder':
                this._thunder(sink, at(0), intensity);
                break;
        }
    }

    // One trim gain per cue into the cue bus, so overlapping cues each keep
    // their own bed-aware level. The sink also collects the cue's cancels and
    // the end of its longest tail.
    _openSink(kind, cue, t, cancels) {
        const trimDb = this._levelDb(kind, cue);
        const out = this.engine.context.createGain();
        out.gain.value = CUE_STAGE_GAIN * dbToGain(trimDb);
        out.connect(this.engine.busInput('cue'));
        this.lastLevel = { kind, trimDb, at: t };
        return { out, cancels, endAt: t };
    }

    _closeSink(sink) {
        const leadSec = Math.max(0, sink.endAt - this.engine.now());
        setTimeout(() => {
            try { sink.out.disconnect(); } catch { /* gone */ }
        }, (leadSec + SINK_RELEASE_PAD_SEC) * 1000);
    }

    // One read of the pre-duck bed at schedule time (S3). Urgent trims taken
    // over a known bed are remembered for a wake that has none to read.
    _levelDb(kind, cue) {
        const lane = LEVEL_LANE_BY_KIND[kind];
        const nominalLufsM = VOICE_REGISTRY[`cue.${VOICE_BY_KIND[kind] ?? kind}`]?.nominalLufsM;
        const bedLufs = this.engine.bedLoudness();
        const urgent = isUrgentLevelLane(lane);
        const now = monotonicNow();
        if (urgent) this._urgentTrims = this._urgentTrims.filter(entry => now - entry.at < URGENT_TRIM_MEMORY_MS);
        const trimDb = cueTrimDb({
            lane,
            nominalLufsM,
            bedLufs,
            recentUrgentTrims: this._urgentTrims.map(entry => entry.trimDb),
            bed: bedContextFor(cue),
        });
        if (urgent && Number.isFinite(bedLufs)) this._urgentTrims.push({ at: now, trimDb });
        return trimDb;
    }

    // The bed yields from the first note to the last note + 0.35 s. A cue
    // withdrawn before its first note sounds withdraws its duck with it, so
    // the bed never dips for a cue that did not play.
    _duck(kind, lane, cue, t, offsetsMs, cancels) {
        const depths = duckDepthsFor(kind, lane, cue.preset);
        if (!ducksAnything(depths)) return;
        const from = t + (offsetsMs[0] || 0) / 1000;
        const until = t + (offsetsMs[offsetsMs.length - 1] || 0) / 1000 + DUCK_HOLD_AFTER_LAST_NOTE_SEC;
        const token = this.engine.duck({ from, until, depths });
        cancels.push(() => {
            if (this.engine.now() < from) token?.cancel?.();
        });
    }

    // A ceremony that absorbed an announced aggregate names it in `replaces`
    // (its caption identity plus the count it keeps), so the caption surface
    // swaps the aggregate's caption for the ceremony instead of stacking both.
    _emitCue({ kind, eventKind = kind, lane, agentId = null, label = null, replaces = null }) {
        const at = Date.now();
        this.lastCue = { kind: eventKind, lane, at };
        eventBus.emit('audio:cue-played', {
            kind: eventKind,
            agentId: agentId ?? null,
            label: String(label || CUE_LABELS[kind] || kind),
            at,
            ...(replaces ? { replaces } : {}),
        });
        return true;
    }

    // A small bell: the fundamental stays in the shared pentatonic scale;
    // provider voicings add quiet harmonic partials and a register shift.
    _bell(sink, t, hz, {
        gain = 0.04,
        decay = 2,
        cutoff = 2400,
        pan = 0,
        provider = null,
    } = {}) {
        const ctx = this.engine.context;
        const tone = makeFilter(ctx, 'lowpass', cutoff, { q: 'butterworth' });
        const panner = typeof ctx.createStereoPanner === 'function'
            ? ctx.createStereoPanner()
            : null;
        const safePan = Math.max(-1, Math.min(1, Number(pan) || 0));
        if (panner) {
            if (typeof panner.pan?.setValueAtTime === 'function') panner.pan.setValueAtTime(safePan, t);
            else if (panner.pan) panner.pan.value = safePan;
            tone.connect(panner).connect(sink.out);
        } else {
            tone.connect(sink.out);
        }

        const voicing = bellVoicingForProvider(provider);
        const register = Number(voicing.register) || 1;
        const partials = voicing.partials.map(partial => ({
            ratio: partial.ratio,
            gain: gain * partial.gain,
            decay: decay * partial.decay,
        }));
        const nodes = panner ? [tone, panner] : [tone];
        const voices = [];
        let endAt = t;
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
            voices.push({ osc, env });
            endAt = Math.max(endAt, t + partial.decay + 0.1);
        }
        sink.endAt = Math.max(sink.endAt, endAt);
        const cleanup = () => {
            for (const node of nodes) {
                try { node.disconnect(); } catch { /* gone */ }
            }
        };
        // Timed from the note, not from now: a held (prepared) note may sit
        // up to a routine hold ahead of the clock.
        const leadSec = Math.max(0, t - this.engine.now());
        setTimeout(cleanup, (leadSec + decay + 0.5) * 1000);
        let cancelled = false;
        // A note already heard rings out; only a note still ahead of the
        // audio clock is released, and never without a ramp.
        const cancel = () => {
            if (cancelled) return;
            cancelled = true;
            const now = this.engine.now();
            if (t <= now) return;
            for (const { osc, env } of voices) {
                this.engine.releaseVoice({ sources: [osc], env, at: now, sec: CANCEL_RELEASE_SEC });
            }
        };
        sink.cancels.push(cancel);
        return cancel;
    }

    // Thunder: a swept low-pass burst of brown noise with a secondary rumble
    // bump, so strikes roll instead of thump.
    _thunder(sink, t, intensity = 1) {
        const ctx = this.engine.context;
        const level = Math.max(0.2, Math.min(1, intensity));

        const src = ctx.createBufferSource();
        src.buffer = this.engine.noise('brown');
        src.playbackRate.value = rand(0.65, 0.95);

        const startHz = rand(260, 380);
        const lp = makeFilter(ctx, 'lowpass', startHz, { q: 'butterworth' });
        lp.frequency.setValueAtTime(startHz, t);
        lp.frequency.exponentialRampToValueAtTime(75, t + rand(2, 3));

        const env = ctx.createGain();
        const peak = 0.1 + level * 0.14;
        const tail = rand(2.4, 4.5);
        env.gain.setValueAtTime(MIN_GAIN, t);
        env.gain.exponentialRampToValueAtTime(peak, t + rand(0.06, 0.14));
        env.gain.exponentialRampToValueAtTime(peak * 0.35, t + 0.9);
        env.gain.exponentialRampToValueAtTime(peak * 0.5, t + 1.3); // secondary roll
        env.gain.exponentialRampToValueAtTime(MIN_GAIN, t + tail);

        src.connect(lp).connect(env).connect(sink.out);
        src.start(t);
        src.stop(t + tail + 0.2);
        sink.endAt = Math.max(sink.endAt, t + tail + 0.2);
        src.onended = () => {
            try { src.disconnect(); lp.disconnect(); env.disconnect(); } catch { /* gone */ }
        };
        const cancel = () => {
            const now = this.engine.now();
            if (t <= now) return;
            this.engine.releaseVoice({ sources: [src], env, at: now, sec: CANCEL_RELEASE_SEC });
        };
        sink.cancels.push(cancel);
        return cancel;
    }
}
