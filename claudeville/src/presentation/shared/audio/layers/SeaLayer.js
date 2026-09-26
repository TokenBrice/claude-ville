// The sea (plan 4.1, AMB-1): the island's shore as the ground of the world
// stratum — a far surf roar that breathes with the sets, breaking waves
// (build, break, foam wash, backwash) grouped by two incommensurate swell
// cycles, close harbor lapping, and rare far gulls, halyard clinks and hull
// groans. Weather and phase drive it; agents never do (S6): every draw comes
// from the layer's own seeded streams, and nothing here reads the World.
//
// Zero nodes per event (S8): 3 crash + 2 wash + 2 lapping lanes are
// persistent chains on two noise-pool reads (1 white, 1 brown), and every wave or
// slap is AudioParam automation placed on the Transport. The rare voices are
// SampleBank takes (client 'rareWorld') played as source + gain into a
// persistent gull or harbor chain: 2 node creations per sounding. A take
// that is not baked yet is simply not heard (a skipped gull is inaudible as
// a fault; a live-synthesised one would cost 5+ nodes a note).
//
// Cue-aware (4.6, AMB-9): every published cue score (`audio:cue-scheduled`)
// becomes a guard window [first note − 1.5 s, last note + 2.5 s]. A crest
// not yet broken that falls inside one is re-committed (cancel and hold,
// reschedule) just past the window, and so is every later committed crest;
// waves not yet committed are planned around the windows. A crest already
// breaking is left to the world duck. The cue is a scheduled sound, not an
// agent: with no cue the sea is identical at 0 and 12 working agents.
//
// The sea leaves the held note's lane open (plan 3.3, S1): dry and wet pass
// a fixed cut at the D (HELD_SLOT), so the surf's low roar never covers it.

import { eventBus } from '../../../../domain/events/DomainEvent.js';
import { BaseLayer } from './BaseLayer.js';
import { clamp01, holdAt, rand } from '../AudioEngine.js';
import { makeFilter } from '../Filters.js';
import { heldSlot } from './HeldNote.js';
import { renewalProcess } from '../Transport.js';
import { rngStream } from '../Rng.js';

const TAU = Math.PI * 2;

// The two swell cycles that group waves into sets (incommensurate, so the
// sets never repeat within an hour).
export const SWELL_PERIODS_SEC = Object.freeze([97.3, 41.9]);
// No crest within 1.5 s before a cue's first note (4.6), nor until 2.5 s
// after its last: the bell's ring and the probe's margin window (the cue's
// loudest 400 ms within 2.5 s of its onset) stay clear of the break.
export const CREST_GUARD_SEC = 1.5;
export const CREST_GUARD_AFTER_SEC = 2.5;
// A crest pushed out of a guard window lands this far past its edge.
export const YIELD_SLACK_SEC = 0.1;
// A committed crest closer to now than this is already breaking: the world
// duck covers it, the sea does not move it.
const RECOMMIT_MIN_LEAD_SEC = 0.02;
// Crests moved by a cue keep at least this far apart.
const MIN_CREST_SPACING_SEC = 3;
// A guard window is forgotten once it ended this long ago.
const GUARD_KEEP_SEC = 1;

// Lanes (persistent chains) and noise-pool use.
export const SEA_LANES = Object.freeze({ crash: 3, wash: 2, lap: 2 });

// Mix trim: the sea stem at `setLevel(0.5)` on a calm clear day (sea state 0.18)
// sits ≈ 4 LU under anchor A (measured through the shipped chain), with
// the +0.7 dB the held note's slot takes from it given back.
const SEA_TRIM = 0.144 * Math.pow(10, 0.7 / 20);
// Island Air sends, taken inside the layer's level (C-AMB-2).
const AIR = Object.freeze({ roar: 0.25, crash: 0.18, wash: 0.12, harbor: 0.22, gull: 0.3 });
// The far roar under the waves: the steady floor between crests (a brown
// lane is darker than AMB-1's pink one, so it is lifted to keep the
// crest-to-floor swing near the prototype's ≈ 6 dB).
const ROAR_GAIN = 1.6;
// Harbor lanes sit where the Harbor is drawn (right of the default camera).
const HARBOR_PAN = 0.33;
// Rare-voice levels, relative to the lanes.
const TAKE_GAIN = Object.freeze({ gull: 0.2, clink: 0.04, groan: 0.9 });
// Rare voices never sound in the first seconds after start (their bakes land
// meanwhile), so a busy bake queue cannot decide whether an early gull plays.
const RARE_WARMUP_SEC = 6;
const BAKE_RATE = 32000;
const TAKES = Object.freeze({ gull: 4, clink: 4, groan: 3 });
// Kept for snapshot().
const CREST_LOG = 256;
const RARE_LOG = 64;

// Gull calls per minute by phase on a calm day (they roost at night, in
// storms and in real rain), and the foam by phase: its colour (`dark`,
// band centres) and level (`foam`). Night is darker, never louder for it.
const GULLS_PER_MIN = Object.freeze({ dawn: 0.8, day: 1.1, dusk: 0.5, night: 0 });
const PHASE_DARK = Object.freeze({ dawn: 0.9, day: 1, dusk: 0.85, night: 0.7 });
const PHASE_FOAM = Object.freeze({ dawn: 0.9, day: 1, dusk: 0.85, night: 0.6 });
// The sea state of still air; clouds alone never raise it.
const CALM_SEA = 0.18;

// The sets: how big the next waves run, 0.28…1.16.
export function swellSets(t, phi1 = 0, phi2 = 0) {
    return 0.72
        + 0.28 * Math.sin(TAU * t / SWELL_PERIODS_SEC[0] + phi1)
        + 0.16 * Math.sin(TAU * t / SWELL_PERIODS_SEC[1] + phi2);
}

// The sea state 0..1 (AMB-1's `i`): wind raises it and a storm sets it;
// cloud, fog and rain without wind leave the calm sea (|windX| ≤ 0.4).
export function seaState({ wind = 0, storm = 0 } = {}) {
    const w = Math.max(0, Math.min(1.4, Math.abs(Number(wind) || 0)));
    return Math.max(clamp01(storm), CALM_SEA + 0.5 * clamp01((w - 0.4) / 1.0));
}

// Sea parameters from the weather (|windX|, heard precipitation, storm
// intensity; never agents) and the phase family.
export function seaParams({ wind = 0, precipitation = 0, storm = 0 } = {}, phase = 'day') {
    const i = seaState({ wind, storm });
    const w = Math.max(0, Math.min(1.4, Math.abs(Number(wind) || 0)));
    const roosting = Number(storm) > 0 || clamp01(precipitation) > 0.3;
    return {
        state: i,
        // A storm sea is bigger, not proportionally louder: the size and the
        // roar grow while the bed gain eases off.
        level: (0.72 + 0.2 * i) * (1 - 0.45 * i * i),
        size: 0.35 + 0.65 * i,
        periodSec: 12.5 - 5.8 * i,
        roar: 0.12 + 0.26 * Math.pow(i, 1.6),
        lap: 0.55 + 0.45 * i,
        lapGapSec: 1.9 - 1.1 * i,
        gullsPerMin: roosting ? 0 : (GULLS_PER_MIN[phase] ?? GULLS_PER_MIN.day) * (1 - 0.6 * i),
        clinksPerMin: 1.5 + 9 * i * Math.min(1.4, w),
        brightness: 0.55 + 0.45 * i,
        dark: PHASE_DARK[phase] ?? 1,
        foam: PHASE_FOAM[phase] ?? 1,
    };
}

// The guard window around one cue's note times (audio s).
export function guardWindow(noteTimes, before = CREST_GUARD_SEC, after = CREST_GUARD_AFTER_SEC) {
    const times = (noteTimes || []).filter(Number.isFinite);
    if (!times.length) return null;
    return { from: Math.min(...times) - before, to: Math.max(...times) + after };
}

// The earliest crest time ≥ t outside every guard window (the edges are
// allowed: a crest exactly 1.5 s from a cue is clear of it).
export function crestClear(t, windows, slack = YIELD_SLACK_SEC) {
    let at = t;
    for (let moved = true; moved;) {
        moved = false;
        for (const w of windows || []) {
            if (at > w.from && at < w.to) {
                at = w.to + slack;
                moved = true;
            }
        }
    }
    return at;
}

// Monotonic (performance.now) ms → audio time: the inverse of CueKit's
// pairing, so a published note maps back to the time it was scheduled at.
export function audioTimeForMonotonic(atMs, ctx, nowMs = globalThis.performance?.now?.() ?? Date.now()) {
    let contextTime = ctx.currentTime;
    let performanceTime = nowMs;
    const stamp = typeof ctx.getOutputTimestamp === 'function' ? ctx.getOutputTimestamp() : null;
    if (stamp
        && Number.isFinite(stamp.contextTime) && stamp.contextTime > 0
        && Number.isFinite(stamp.performanceTime) && stamp.performanceTime > 0) {
        contextTime = stamp.contextTime;
        performanceTime = stamp.performanceTime;
    }
    return contextTime + (Number(atMs) - performanceTime) / 1000;
}

function exponential(rng, mean) {
    return -mean * Math.log(1 - rng());
}

// Filter and pan automation at k-rate where the browser allows it (AMB-13).
function kRate(param) {
    try { param.automationRate = 'k-rate'; } catch { /* a-rate only */ }
    return param;
}

// Equal-power balance for a stereo lane: [left, right] channel gains, 1 and
// 1 at the centre.
export function balanceGains(pan) {
    const angle = (Math.max(-1, Math.min(1, Number(pan) || 0)) + 1) * Math.PI / 4;
    return [Math.cos(angle) * Math.SQRT2, Math.sin(angle) * Math.SQRT2];
}

function balanceTo(bal, pan, t, tau) {
    const [l, r] = balanceGains(pan);
    bal.l.setTargetAtTime(l, t, tau);
    bal.r.setTargetAtTime(r, t, tau);
}

// ------------------------------------------------------------ baked takes

// Herring-gull long call: a laughing series of harsh, nasal notes falling
// across the series (0.82 → 1.45 → 1.05 f₀ per note, f₀ 1.05–1.3 kHz).
function gullTake(index) {
    const r = rngStream(`world.sea.take.gull.${index}`);
    const count = 2 + Math.floor(r() * 5);
    const formantHz = rand(r, 2100, 2500);
    const vibratoHz = rand(r, 22, 30);
    const notes = [];
    let t = 0.005;
    let f0 = rand(r, 1050, 1300);
    for (let k = 0; k < count; k++) {
        const dur = k === 0 ? rand(r, 0.32, 0.42) : rand(r, 0.16, 0.26);
        notes.push({ t, dur, f0, amp: k === 0 ? 0.9 : 0.65 });
        t += dur + rand(r, 0.06, 0.14);
        f0 *= rand(r, 0.93, 0.99);
    }
    return {
        hz: notes.map(n => Math.round(n.f0)),
        recipe: {
            client: 'rareWorld',
            seconds: t + 0.1,
            channels: 1,
            sampleRate: BAKE_RATE,
            render(ctx) {
                const formant = makeFilter(ctx, 'bandpass', formantHz, { q: 2.2 });
                const body = makeFilter(ctx, 'bandpass', 1300, { q: 1.4 });
                formant.connect(ctx.destination);
                body.connect(ctx.destination);
                for (const note of notes) {
                    const osc = ctx.createOscillator();
                    osc.type = 'sawtooth';
                    osc.frequency.setValueAtTime(note.f0 * 0.82, note.t);
                    osc.frequency.exponentialRampToValueAtTime(note.f0 * 1.45, note.t + note.dur * 0.28);
                    osc.frequency.exponentialRampToValueAtTime(note.f0 * 1.05, note.t + note.dur);
                    const vib = ctx.createOscillator();
                    vib.frequency.value = vibratoHz;
                    const depth = ctx.createGain();
                    depth.gain.value = note.f0 * 0.03;
                    vib.connect(depth).connect(osc.frequency);
                    const env = ctx.createGain();
                    env.gain.setValueAtTime(0, note.t);
                    env.gain.linearRampToValueAtTime(note.amp, note.t + 0.03);
                    env.gain.setTargetAtTime(note.amp * 0.6, note.t + 0.05, note.dur * 0.4);
                    env.gain.setTargetAtTime(0, note.t + note.dur - 0.04, 0.012);
                    osc.connect(env);
                    env.connect(formant);
                    env.connect(body);
                    osc.start(note.t);
                    vib.start(note.t);
                    osc.stop(note.t + note.dur + 0.08);
                    vib.stop(note.t + note.dur + 0.08);
                }
            },
        },
    };
}

// A halyard against a mast: one short inharmonic metal ping at 1.5–2.1 kHz
// (C-AMB-8: apart from the git-work rope creak's band and length).
function clinkTake(index) {
    const r = rngStream(`world.sea.take.clink.${index}`);
    const f = rand(r, 1500, 2100);
    const modes = [[1, 1, 0.07], [2.32, 0.6, 0.045], [4.25, 0.35, 0.025], [6.9, 0.2, 0.015]];
    return {
        hz: [Math.round(f)],
        recipe: {
            client: 'rareWorld',
            seconds: 0.6,
            channels: 1,
            sampleRate: BAKE_RATE,
            render(ctx) {
                for (const [ratio, amp, decay] of modes) {
                    const osc = ctx.createOscillator();
                    osc.frequency.value = f * ratio;
                    const env = ctx.createGain();
                    env.gain.setValueAtTime(0, 0.002);
                    env.gain.linearRampToValueAtTime(amp, 0.0035);
                    env.gain.setTargetAtTime(0, 0.004, decay);
                    osc.connect(env).connect(ctx.destination);
                    osc.start(0.002);
                    osc.stop(0.59);
                }
            },
        },
    };
}

// A moored hull groaning on the swell: slow stick–slip (8–11 Hz rising
// ×1.8–2.2) through two hull resonances kept out of 500–700 Hz (S1): one at
// 260–340 Hz, one at 840–960 Hz; 0.9–1.6 s.
function groanTake(index) {
    const r = rngStream(`world.sea.take.groan.${index}`);
    const dur = rand(r, 0.9, 1.6);
    const r0 = rand(r, 8, 11);
    const lift = rand(r, 1.8, 2.2);
    const lowHz = rand(r, 260, 340);
    const highHz = rand(r, 840, 960);
    return {
        hz: [Math.round(lowHz), Math.round(highHz)],
        recipe: {
            client: 'rareWorld',
            seconds: dur + 0.1,
            channels: 1,
            sampleRate: BAKE_RATE,
            render(ctx) {
                const t0 = 0.005;
                const osc = ctx.createOscillator();
                osc.type = 'square';
                osc.frequency.setValueAtTime(r0, t0);
                osc.frequency.linearRampToValueAtTime(r0 * lift, t0 + dur * 0.55);
                osc.frequency.linearRampToValueAtTime(r0 * 1.2, t0 + dur);
                const hp = makeFilter(ctx, 'highpass', 180, { q: 'butterworth' });
                const low = makeFilter(ctx, 'bandpass', lowHz, { q: 7 });
                const high = makeFilter(ctx, 'bandpass', highHz, { q: 5 });
                const env = ctx.createGain();
                env.gain.setValueAtTime(0, t0);
                env.gain.linearRampToValueAtTime(1, t0 + dur * 0.3);
                env.gain.linearRampToValueAtTime(0.6, t0 + dur * 0.8);
                env.gain.linearRampToValueAtTime(0, t0 + dur);
                osc.connect(hp);
                hp.connect(low).connect(env);
                hp.connect(high).connect(env);
                env.connect(ctx.destination);
                osc.start(t0);
                osc.stop(t0 + dur + 0.02);
            },
        },
    };
}

const TAKE_BUILDERS = Object.freeze({ gull: gullTake, clink: clinkTake, groan: groanTake });

// ------------------------------------------------------------------ layer

export class SeaLayer extends BaseLayer {
    constructor(engine, options = {}) {
        super(engine, { trim: SEA_TRIM, group: 'wind', rng: 'world.sea', ...options });
        this._weather = { wind: 0, precipitation: 0, storm: 0 };
        this._phase = 'day';
        this._P = seaParams(this._weather, this._phase);
        this._resetState();
    }

    _resetState() {
        this._crash = [];
        this._wash = [];
        this._lap = [];
        this._bedDry = null;
        this._bedWet = null;
        this._roarBase = null;
        this._roarSwell = null;
        this._fizz = null;
        this._harbor = null;
        this._gull = null;
        this._pending = null;
        this._future = [];
        this._groans = [];
        this._guards = [];
        this._crestLog = [];
        this._rareLog = [];
        this._rareSources = new Set();
        this._takes = null;
        this._waveIndex = 0;
        this._lapIndex = 0;
        this._yields = 0;
        this._nodeCreations = 0;
        this._rareFrom = Infinity;
        this._unsubscribe = null;
    }

    _start(ctx) {
        const engine = this.engine;
        const noise = color => engine.noiseSource(color, { rng: this.rng });
        const node = (value = 1) => {
            const gain = ctx.createGain();
            gain.gain.value = value;
            this.track(gain);
            return gain;
        };
        const filter = (type, hz, q) => {
            const f = makeFilter(ctx, type, hz, { q });
            kRate(f.frequency);
            this.track(f);
            return f;
        };
        const panner = (pan) => {
            const p = ctx.createStereoPanner();
            p.pan.value = pan;
            kRate(p.pan);
            this.track(p);
            return p;
        };
        // Stereo noise lanes are placed by balance (per-channel gains), not a
        // StereoPanner: its stereo law folds one channel into the other and
        // would raise the lane's inter-channel correlation (C-AMB-3).
        const balance = (pan) => {
            const split = ctx.createChannelSplitter(2);
            const merge = ctx.createChannelMerger(2);
            const [gl, gr] = balanceGains(pan);
            const l = node(gl);
            const r = node(gr);
            kRate(l.gain);
            kRate(r.gain);
            split.connect(l, 0);
            split.connect(r, 1);
            l.connect(merge, 0, 0);
            r.connect(merge, 0, 1);
            this.track(split, merge);
            return { input: split, output: merge, l: l.gain, r: r.gain };
        };
        this._waveRng = rngStream('world.sea.waves');
        this._lapRng = rngStream('world.sea.laps');
        this._gullRng = rngStream('world.sea.gulls');
        this._clinkRng = rngStream('world.sea.clinks');
        this._phi = [rand(this._waveRng, 0, TAU), rand(this._waveRng, 0, TAU)];

        // The weather law moves dry and wet together; the layer level
        // (BaseLayer `out` / `airOut`) sits after both, behind the held
        // note's slot.
        const P = this._P;
        const slot = () => {
            const f = heldSlot(ctx);
            this.track(f);
            return f;
        };
        this._bedDry = node(P.level);
        this._bedDry.connect(slot()).connect(this.out);
        this._bedWet = node(P.level);
        const wetSlot = slot();
        this._bedWet.connect(wetSlot);
        this.airSend(1, wetSlot);
        const send = (from, amount) => {
            from.connect(node(amount)).connect(this._bedWet);
        };

        // Two pool reads for the whole sea: one white (roar and foam, in
        // nearly disjoint bands) and one brown (crash lanes, lapping, fizz).
        // Two lanes of the sea — or the sea and the wind — on one pool buffer
        // would echo each other at their read-head distance (a 5–20 s lag
        // peak in the bed's autocorrelation); a shared read only sums
        // coherently where its bands overlap.
        const white = noise('white');
        const brown = noise('brown');
        const t0 = ctx.currentTime;

        // Roar: far surf, breathing with each crest (roarSwell) under the
        // weather's base level (roarBase); tilted toward pink under its band.
        this._roarSwell = node(1);
        this._roarBase = node(P.roar * ROAR_GAIN);
        const tilt = makeFilter(ctx, 'lowshelf', 300, { gain: 8 });
        this.track(tilt);
        white.connect(tilt)
            .connect(filter('bandpass', 420, 0.5))
            .connect(filter('lowpass', 1400, 'butterworth'))
            .connect(this._roarSwell)
            .connect(this._roarBase)
            .connect(this._bedDry);
        send(this._roarBase, AIR.roar);

        // Fizz: slow random AM on the foam (bubbling).
        this._fizz = node(0.9 + 0.5 * P.size);
        brown.connect(filter('lowpass', 22, 'butterworth')).connect(this._fizz);

        // Crash lanes: brown → per-lane resonant low-pass → gain → balance.
        const crashSum = node(1);
        crashSum.connect(this._bedDry);
        send(crashSum, AIR.crash);
        for (let k = 0; k < SEA_LANES.crash; k++) {
            const lp = filter('lowpass', 350, 2);
            const gain = node(0);
            const pan = balance(0);
            brown.connect(lp).connect(gain).connect(pan.input);
            pan.output.connect(crashSum);
            this._crash.push({ lp, gain, pan });
        }

        // Wash lanes: white → band-pass → gain → AM (fizz) → balance.
        const washSum = node(1);
        washSum.connect(this._bedDry);
        send(washSum, AIR.wash);
        for (let k = 0; k < SEA_LANES.wash; k++) {
            const bp = filter('bandpass', 4000, 0.6);
            const gain = node(0);
            const am = node(0.75);
            this._fizz.connect(am.gain);
            const pan = balance(0);
            white.connect(bp).connect(gain).connect(am).connect(pan.input);
            pan.output.connect(washSum);
            this._wash.push({ bp, gain, pan });
        }

        // Harbor: lapping lanes (brown, two band-pass chains), and the clinks
        // and groans, all placed at the Harbor. Mono takes are up-mixed to
        // both channels before the balance.
        this._harbor = node(1);
        this._harbor.channelCount = 2;
        this._harbor.channelCountMode = 'explicit';
        this._harbor.channelInterpretation = 'speakers';
        const harborPan = balance(HARBOR_PAN);
        this._harbor.connect(harborPan.input);
        harborPan.output.connect(this._bedDry);
        send(harborPan.output, AIR.harbor);
        for (let k = 0; k < SEA_LANES.lap; k++) {
            const bp = filter('bandpass', 380, 3.5);
            const gain = node(0);
            brown.connect(bp).connect(gain).connect(this._harbor);
            this._lap.push({ bp, gain });
        }

        // Gulls: one far perch chain (distance low-pass, pan) re-placed per call.
        this._gull = { input: node(1), lp: filter('lowpass', 6000, 'butterworth'), pan: panner(0) };
        this._gull.input.connect(this._gull.lp).connect(this._gull.pan).connect(this._bedDry);
        send(this._gull.pan, AIR.gull);

        for (const src of [white, brown]) {
            src.start(t0);
            this.trackSource(src);
        }

        this._bakeTakes();
        this._rareFrom = t0 + RARE_WARMUP_SEC;
        this._pending = this._planWave(t0 + rand(this._waveRng, 0.5, 2.5) + 2.4);

        this._unsubscribe = eventBus.on('audio:cue-scheduled', payload => this._onCueScheduled(payload));

        this.registerProcess({
            name: 'sea.waves',
            schedule: (from, to) => this._scheduleWaves(from, to),
            rearm: now => this._rearmWaves(now),
        });
        this.registerProcess(renewalProcess({
            name: 'sea.laps',
            first: () => rand(this._lapRng, 0.2, 1),
            gap: () => exponential(this._lapRng, this._P.lapGapSec) + 0.12,
            emit: t => this._slap(t),
        }));
        this.registerProcess(renewalProcess({
            name: 'sea.gulls',
            first: () => rand(this._gullRng, 4, 12),
            gap: () => (this._P.gullsPerMin > 0 ? exponential(this._gullRng, 60 / this._P.gullsPerMin) + 6 : 20),
            emit: t => this._gullCall(t),
        }));
        this.registerProcess(renewalProcess({
            name: 'sea.clinks',
            first: () => rand(this._clinkRng, 2, 6),
            gap: () => exponential(this._clinkRng, 60 / this._P.clinksPerMin) + 1.5,
            emit: t => this._clinkGroup(t),
        }));
    }

    stop() {
        this._unsubscribe?.();
        const silentAt = super.stop();
        if (silentAt !== undefined) {
            for (const src of this._rareSources) {
                try { src.stop(silentAt + 0.01); } catch { /* already stopped */ }
            }
        }
        this._resetState();
        return silentAt;
    }

    // Weather (never agents): { wind: |windX|, precipitation (heard,
    // snow-hushed), storm (storm intensity, 0 unless a storm) }. The sea
    // state follows wind and storm; cloud alone never raises it.
    setWeather({ wind = 0, precipitation = 0, storm = 0 } = {}, timeConstant = null) {
        this._weather = { wind, precipitation, storm };
        this._applyParams(timeConstant ?? 4);
    }

    // The phase family ('dawn' | 'day' | 'dusk' | 'night'): foam colour and
    // whether gulls fly. Level by phase is the director's (DayArc).
    setPhase(phase) {
        if (phase === this._phase) return;
        this._phase = Object.hasOwn(PHASE_DARK, phase) ? phase : 'day';
        this._applyParams(null);
    }

    _applyParams(timeConstant) {
        this._P = seaParams(this._weather, this._phase);
        if (!this.running || !this._bedDry || timeConstant === null) return;
        const now = this.engine.now();
        const P = this._P;
        this._bedDry.gain.setTargetAtTime(P.level, now, timeConstant);
        this._bedWet.gain.setTargetAtTime(P.level, now, timeConstant);
        this._roarBase.gain.setTargetAtTime(P.roar * ROAR_GAIN, now, timeConstant);
        this._fizz.gain.setTargetAtTime(0.9 + 0.5 * P.size, now, timeConstant);
    }

    // --------------------------------------------------------------- waves

    // Every draw for one wave, in a fixed order (the stream stays aligned
    // however the wave is later placed).
    _planWave(T) {
        const r = this._waveRng;
        return {
            T,
            build: rand(r, 1.4, 2.4),
            pan: rand(r, -0.6, 0.6),
            spread: rand(r, 0.62, 1),
            washSec: rand(r, 3.2, 5.2),
            groanChance: r(),
            groanDelay: rand(r, 1.2, 2.6),
            groanTake: Math.floor(r() * TAKES.groan),
            groanRate: rand(r, 0.94, 1.06),
            jitter: rand(r, 0.72, 1.28),
            amp: 0,
            lane: -1,
            washLane: -1,
            dark: 1,
            foam: 1,
            brightness: 1,
            moved: false,
            groan: false,
            groanDone: false,
        };
    }

    _rearmWaves(now) {
        const w = this._pending;
        if (w && w.T - w.build < now) w.T = now + w.build + 0.25;
    }

    _scheduleWaves(from, to) {
        if (!this.running || !this._pending) return 0;
        this._guards = this._guards.filter(g => g.to > from - GUARD_KEEP_SEC);
        this._future = this._future.filter(w => w.T + 8 > from);
        let dropped = 0;
        let w = this._pending;
        while (w.T - w.build < to) {
            const clear = crestClear(w.T, this._guards);
            if (clear !== w.T) {
                w.T = clear;
                w.moved = true;
                this._yields++;
                continue;
            }
            if (w.T - w.build < from) dropped++;
            else this._commitWave(w, from);
            w = this._pending = this._planWave(w.T + this._P.periodSec * w.jitter);
        }
        // Hull groans ride the bigger waves, placed when they come due.
        for (const wave of this._groans) {
            const t = wave.T + wave.groanDelay;
            if (wave.groanDone || t >= to) continue;
            wave.groanDone = true;
            if (t >= from) this._playTake('groan', wave.groanTake, t, TAKE_GAIN.groan * (0.5 + 0.5 * wave.amp), wave.groanRate, this._harbor);
            else dropped++;
        }
        this._groans = this._groans.filter(wave => !wave.groanDone);
        return dropped;
    }

    _commitWave(w, from) {
        const P = this._P;
        w.amp = Math.min(1, P.size * swellSets(w.T, this._phi[0], this._phi[1]) * w.spread);
        w.lane = this._waveIndex % SEA_LANES.crash;
        w.washLane = this._waveIndex % SEA_LANES.wash;
        w.brightness = P.brightness;
        w.dark = P.dark;
        w.foam = P.foam;
        this._waveIndex++;
        this._emitWave(w, from);
        this._future.push(w);
        this._crestLog.push(w);
        if (this._crestLog.length > CREST_LOG) this._crestLog.shift();
        if (w.amp > 0.45 && w.groanChance < 0.45) {
            w.groan = true;
            this._groans.push(w);
        }
    }

    // One wave as automation on its crash and wash lanes, starting no
    // earlier than `startAt` (a re-committed wave keeps building from now).
    _emitWave(w, startAt) {
        const { T, amp: A, pan } = w;
        const crash = this._crash[w.lane];
        const wash = this._wash[w.washLane];
        const buildAt = Math.max(startAt, T - w.build);
        const build = Math.max(0.2, T - buildAt);
        // Build-up: the swell rises and brightens.
        balanceTo(crash.pan, pan, buildAt, 0.05);
        crash.gain.gain.setTargetAtTime(0.13 * A, buildAt, build / 2.5);
        crash.lp.frequency.setTargetAtTime(520, buildAt, build / 2);
        // The break, its body, and the fall back to silence.
        crash.gain.gain.setTargetAtTime(0.7 * A, T, 0.14);
        crash.gain.gain.setTargetAtTime(0.24 * A, T + 0.55, 0.9);
        crash.gain.gain.setTargetAtTime(0, T + 2.4, 1.6);
        crash.lp.frequency.setTargetAtTime(900 + 2600 * A * w.brightness * w.dark, T, 0.16);
        crash.lp.frequency.setTargetAtTime(700, T + 0.45, 1.2);
        crash.lp.frequency.setTargetAtTime(350, T + 2.6, 2);
        // Foam: arrives just after the break, spreads, recedes and darkens.
        const wd = w.washSec;
        balanceTo(wash.pan, pan * 0.8, T, 0.3);
        balanceTo(wash.pan, pan * 0.3, T + 1.5, 1.5);
        wash.gain.gain.setTargetAtTime(0.5 * A * w.foam, T + 0.2, 0.35);
        wash.gain.gain.setTargetAtTime(0.32 * A * w.foam, T + 1.1, 1.0);
        wash.gain.gain.setTargetAtTime(0, T + wd, 0.9);
        wash.bp.frequency.setTargetAtTime(4600 * w.dark, T + 0.15, 0.2);
        wash.bp.frequency.setTargetAtTime(2400 * w.dark, T + 0.7, 1.2);
        wash.bp.frequency.setTargetAtTime(1500 * w.dark, T + 0.7 * wd, 0.8);
        // The roar breathes with the sets.
        this._roarSwell.gain.setTargetAtTime(0.75 + 0.5 * A, T, 1.5);
    }

    // ------------------------------------------------------ cue yielding

    _onCueScheduled(payload) {
        const ctx = this.engine.context;
        if (!this.running || !ctx || !payload || payload.silent) return;
        const notes = Array.isArray(payload.notes) ? payload.notes : [];
        const guard = guardWindow(notes.map(note => audioTimeForMonotonic(note?.atMs, ctx)));
        const now = ctx.currentTime;
        if (!guard || guard.to <= now) return;
        this._guards.push(guard);
        this._recommit(now);
    }

    // Move every committed crest that has not broken and now sits in a
    // guard window, and every committed crest after it, keeping their
    // spacing; the planned next wave follows.
    _recommit(now) {
        const waves = this._future.filter(w => w.T > now + RECOMMIT_MIN_LEAD_SEC).sort((a, b) => a.T - b.T);
        if (!waves.some(w => crestClear(w.T, this._guards) !== w.T)) return;
        holdAt(this._roarSwell.gain, now);
        let prev = -Infinity;
        let shift = 0;
        for (const w of waves) {
            const T = crestClear(Math.max(w.T + shift, prev + MIN_CREST_SPACING_SEC), this._guards);
            if (T !== w.T) {
                shift = T - w.T;
                const crash = this._crash[w.lane];
                const wash = this._wash[w.washLane];
                for (const param of [crash.gain.gain, crash.lp.frequency, crash.pan.l, crash.pan.r,
                    wash.gain.gain, wash.bp.frequency, wash.pan.l, wash.pan.r]) holdAt(param, now);
                w.T = T;
                w.moved = true;
                this._yields++;
                this._emitWave(w, now);
            } else {
                // The roar's breathing was cancelled from now: restore it.
                this._roarSwell.gain.setTargetAtTime(0.75 + 0.5 * w.amp, w.T, 1.5);
            }
            prev = w.T;
        }
        if (this._pending && shift > 0) this._pending.T += shift;
    }

    // ----------------------------------------------------- harbor lapping

    _slap(t) {
        const r = this._lapRng;
        const P = this._P;
        const lane = this._lap[this._lapIndex++ % SEA_LANES.lap];
        const f = rand(r, 240, 500);
        const a = P.lap * rand(r, 0.35, 1);
        const decay = rand(r, 0.05, 0.11);
        const double = r() < 0.35;
        const echo = rand(r, 0.12, 0.2);
        if (!lane) return;
        lane.bp.frequency.setValueAtTime(f, t);
        lane.bp.frequency.setTargetAtTime(f * 0.7, t + 0.02, 0.08);
        lane.gain.gain.setTargetAtTime(0.5 * a, t, 0.012);
        lane.gain.gain.setTargetAtTime(0, t + 0.035, decay);
        if (double) {
            lane.gain.gain.setTargetAtTime(0.25 * a, t + echo, 0.01);
            lane.gain.gain.setTargetAtTime(0, t + echo + 0.03, 0.06);
        }
    }

    // --------------------------------------------------------- rare voices

    _bakeTakes() {
        const bank = this.engine.bank;
        this._takes = {};
        for (const [kind, count] of Object.entries(TAKES)) {
            this._takes[kind] = [];
            for (let i = 0; i < count; i++) {
                const take = TAKE_BUILDERS[kind](i);
                this._takes[kind].push(take);
                bank?.bake(`sea:${kind}:${i}`, take.recipe);
            }
        }
    }

    // A take as source + gain into a persistent chain (2 node creations).
    _playTake(kind, index, t, gain, rate, chain) {
        const ctx = this.engine.context;
        if (!ctx || !chain || t < this._rareFrom) return false;
        const buffer = this.engine.bank?.get(`sea:${kind}:${index}`);
        if (!buffer) return false;
        const src = ctx.createBufferSource();
        src.buffer = buffer;
        src.playbackRate.value = rate;
        const level = ctx.createGain();
        level.gain.value = gain;
        src.connect(level).connect(chain);
        this._nodeCreations += 2;
        this._rareSources.add(src);
        src.addEventListener('ended', () => {
            this._rareSources.delete(src);
            try { src.disconnect(); level.disconnect(); } catch { /* already disconnected */ }
        }, { once: true });
        src.start(t);
        const hz = this._takes?.[kind]?.[index]?.hz ?? [];
        this._rareLog.push({ kind, t, hz: hz.map(f => Math.round(f * rate)) });
        if (this._rareLog.length > RARE_LOG) this._rareLog.shift();
        return true;
    }

    // A far gull's long call: the perch chain is re-placed (pan, distance
    // low-pass and gain, SpatialField's law) just before the call.
    _gullCall(t) {
        const r = this._gullRng;
        const take = Math.floor(r() * TAKES.gull);
        const rate = rand(r, 0.96, 1.04);
        const pan = rand(r, -0.75, 0.75);
        const dist = rand(r, 0.55, 1);
        if (!(this._P.gullsPerMin > 0) || !this._gull) return;
        const lowpass = Math.max(2600, 9000 * Math.pow(2, -1.6 * Math.max(0, dist - 0.5)));
        const near = dist <= 0.6 ? 1 : Math.pow(0.6 / dist, 1.2);
        const at = Math.max(this.engine.now(), t - 0.02);
        this._gull.pan.pan.setValueAtTime(pan, at);
        this._gull.lp.frequency.setValueAtTime(lowpass, at);
        this._playTake('gull', take, t, TAKE_GAIN.gull * near, rate, this._gull.input);
    }

    // A halyard swinging against its mast: 1–3 pings 0.35–0.9 s apart.
    _clinkGroup(t) {
        const r = this._clinkRng;
        const count = 1 + Math.floor(r() * 3);
        let at = t;
        for (let k = 0; k < count; k++) {
            const take = Math.floor(r() * TAKES.clink);
            const gain = TAKE_GAIN.clink * rand(r, 0.4, 1);
            const rate = rand(r, 0.98, 1.02);
            this._playTake('clink', take, at, gain, rate, this._harbor);
            at += rand(r, 0.35, 0.9);
        }
    }

    // ------------------------------------------------------- diagnostics

    // Guard windows the sea is keeping crests out of (audio s).
    protectedWindows() {
        return this._guards.map(g => ({ from: g.from, to: g.to }));
    }

    snapshot() {
        return {
            running: this.running,
            level: this.level,
            phase: this._phase,
            params: { ...this._P },
            lanes: { ...SEA_LANES },
            crests: this._crestLog.map(w => ({ t: w.T, lane: w.lane, amp: w.amp, moved: w.moved })),
            yields: this._yields,
            nodeCreations: this._nodeCreations,
            rare: this._rareLog.map(e => ({ kind: e.kind, t: e.t, hz: [...e.hz] })),
            guards: this.protectedWindows(),
        };
    }
}
