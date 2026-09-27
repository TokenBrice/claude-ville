// Web Audio context lifecycle and the master mix for the village soundscape
// (plan S3: bus map and master).
//
// Graph:
//   layer ─► director group (groupInput(name, director); crossfade gain)
//         ─► group fader (mixer trim) ─► bus
//   world (wind, rain, wildlife) ─► presence dip −3 dB @ 3.4 kHz ─► weather ceiling ─► worldDuck ─┐ tilt
//   work (hum, workshops) ─────────────────────────────────────────────────────────► workDuck ──┤
//   music ─► low shelf −3 dB @ 160 Hz ─► bass < 300 Hz mono ─► attention ───────────► musicDuck ─┘ tilt
//     programSum (tilt = circadian high shelf + the listener's tone on world + music only;
//     headphones narrow the world bed before it: worldWidth)
//       ─► bedGate ─► PROGRAM_TRIM ─► HPF 30 Hz ─┐
//   cue ───────────► PROGRAM_TRIM ───────────────┤
//   Island Air wet ► PROGRAM_TRIM ───────────────┤
//   signalBed ─► signalBedDuck ─► signalGate ─► PROGRAM_TRIM ─┴─► mono fold ─► LP 14 kHz ─► limiter (−1.5 dBFS) ─► volume ─► fade ─► out
//
// The listener's output (7.7, OutputStage.js): Mono folds the whole program
// to both ears before the limiter (compensated, so it never gets quieter or
// passes the ceiling); Headphones scales every voice's pan and narrows the
// world bed; Speakers leaves the mix as made.
//
// `signalBed` carries the held note (S3, plan 3.3): no presence dip, no
// attention stage, no music duck, outside the bed tap; it ducks only under
// urgent cues (DUCK_DEPTHS.urgent.signalBed) and its gate moves with bedGate,
// so a hidden-tab wake sounds the cue alone.
//
// Island Air (IslandAir.js, S5): layer sends enter per (director, group)
// wet inputs that follow the director crossfade and the group fader, then
// the bed air gate (which mirrors bedGate); cue and one-shot sends enter the
// cue air input. One convolver pair serves both, and its wet return joins
// at the cue staging, so a wet path gets exactly the trim its dry path gets.
//
// Every voice joins a bus through `busInput(name)` or a group through
// `groupInput(name, director)`. The ducks are note-timed windows per bus
// (`duck()`, DuckScheduler.js). `bedGate` closes the whole program during a
// hidden-tab wake so only the cue path sounds. The volume is the last gain
// before the fade, after the limiter, so a slider step changes level only.
// The limiter is an AudioWorklet (worklets/limiter-processor.js), loaded
// before the graph is built; without AudioWorklet (or with
// `globalThis.__claudevilleAudioNoWorklets = true`) a DynamicsCompressor and
// a tanh WaveShaper stand in.
//
// Side branches (never in series): the pre-duck bed tap that
// `bedLoudness()` reads (K-weighting IIR ×2 → per-channel square → one-pole
// mean → a 32-sample analyser), the `rms()` analyser on the output, and the
// debug meters (ENG-10), which exist only while enabled:
//   output / bed tap / music / cue bus → K-weighting IIR ×2 ─┐
//                                  (unweighted, peak) ──────┴→ meter worklet

import { DuckScheduler, dbToGain } from './DuckScheduler.js';
import { makeFilter } from './Filters.js';
import { IslandAir } from './IslandAir.js';
import { LIMITER_CEILING_DBFS, PROGRAM_TRIM_DB, STANDARD_VOLUME_STEP, volumeStepGain } from './Loudness.js';
import { MusicClock } from './MusicClock.js';
import { TONE_TAU_SEC, outputSettings, toneDb, widthMatrix } from './OutputStage.js';
import { rngStream } from './Rng.js';
import { NoisePool, SampleBank } from './SampleBank.js';
import { Transport } from './Transport.js';

export const MIN_GAIN = 0.0001;

// Mixer groups with a persistent fader each; layers name theirs via BaseLayer's `group`.
export const AUDIO_GROUPS = Object.freeze(['wind', 'rain', 'wildlife', 'hum', 'workshops', 'music']);
export const AUDIO_BUSES = Object.freeze(['world', 'work', 'music', 'cue', 'signalBed']);
const GROUP_BUS = Object.freeze({
    wind: 'world',
    rain: 'world',
    wildlife: 'world',
    hum: 'work',
    workshops: 'work',
    music: 'music',
});
const DUCKED_BUSES = Object.freeze(['world', 'work', 'music', 'signalBed']);

// Circadian high shelf at 3 kHz on world + music (SOTA-14, MIX-5), dB by phase.
export const TILT_DB = Object.freeze({ dawn: 1, day: 0, dusk: -1.5, night: -3 });
const TILT_TAU_SEC = 10;
const CUE_TRIM_TAU_SEC = 0.017;

const METER_TAPS = Object.freeze(['program', 'bed', 'music', 'cue']);
const WAKE_OPEN_SEC = 0.015;
const WAKE_CLOSE_SEC = 0.08;
// A cancelled duck that is shaping the bed returns over this (S8: ≥ 60 ms).
const DUCK_SETTLE_SEC = 0.08;
const CROSSFADE_POINTS = 64;
// Bed-aware tap: a one-pole mean with the variance of BS.1770's 3 s window.
const BED_TAU_SEC = 1.5;
const BED_PRIME_SEC = 1.5;
const BED_FLOOR_LUFS = -70;

const LIMITER_OPTIONS = Object.freeze({ ceilingDb: LIMITER_CEILING_DBFS, lookaheadMs: 2.5, releaseMs: 120 });
// Fallback ceiling, an emergency path that runs only without AudioWorklet
// (or with the debug flag): its hard shaping aliases, so its true peak can
// pass the −1 dBTP ceiling (probe: +0.10 dBTP on a +14 dBFS burst).
// Chrome/Firefox/WebKit's DynamicsCompressor adds a fixed
// makeup of (1 / gain at 0 dBFS)^0.6: with −2 dB / knee 0 / 20:1 that is
// +1.14 dB, cancelled here so the fallback keeps unity static gain.
const FALLBACK_MAKEUP_CANCEL_DB = -1.14;
// The WaveShaper is linear to −4 dBFS, then saturates smoothly toward −1 dBFS;
// every input at or past full scale maps to the curve's end, −1.29 dBFS.
const SHAPER_KNEE = Math.pow(10, -4 / 20);
const SHAPER_CEILING = Math.pow(10, -1 / 20);

export function clamp01(value, fallback = 0) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(0, Math.min(1, n));
}

// Every draw names its stream (Rng.js): `rng` is a `() => [0, 1)` function.
export function rand(rng, min, max) {
    return min + rng() * (max - min);
}

export function pick(rng, list) {
    return list[Math.floor(rng() * list.length)];
}

// Freeze an AudioParam at its current trajectory value at time `t` so a new
// ramp starts from where the sound actually is (a bare cancel jumps back to
// the previous event's value and clicks). Firefox lacks cancelAndHoldAtTime;
// its fallback reads `.value`, exact for t = now and for settled params.
export function holdAt(param, t) {
    if (typeof param.cancelAndHoldAtTime === 'function') {
        param.cancelAndHoldAtTime(t);
    } else {
        param.cancelScheduledValues(t);
        param.setValueAtTime(param.value, t);
    }
}

function noWorkletsRequested() {
    return globalThis.__claudevilleAudioNoWorklets === true;
}

// Equal-power level between two gains: interpolate the angle whose sine is the gain.
function equalPowerAt(from, to, x) {
    const a = Math.asin(clamp01(from));
    const b = Math.asin(clamp01(to));
    return Math.sin(a + (b - a) * clamp01(x));
}

function shaperCurve() {
    const size = 2049;
    const curve = new Float32Array(size);
    const span = SHAPER_CEILING - SHAPER_KNEE;
    for (let i = 0; i < size; i++) {
        const x = (i / (size - 1)) * 2 - 1;
        const ax = Math.abs(x);
        const y = ax <= SHAPER_KNEE ? ax : SHAPER_KNEE + span * Math.tanh((ax - SHAPER_KNEE) / span);
        curve[i] = Math.sign(x) * y;
    }
    return curve;
}

// ITU-R BS.1770-4 K-weighting for any sample rate (the pyloudnorm design the
// harness uses): a high-shelf "head" stage then the RLB high-pass, each as
// IIRFilterNode feedforward/feedback arrays.
export function kWeightingCoefficients(sampleRate) {
    let k = Math.tan(Math.PI * 1681.974450955533 / sampleRate);
    const q1 = 0.7071752369554196;
    const vh = Math.pow(10, 3.999843853973347 / 20);
    const vb = Math.pow(vh, 0.4996667741545416);
    let a0 = 1 + k / q1 + k * k;
    const shelf = {
        feedforward: [(vh + vb * k / q1 + k * k) / a0, 2 * (k * k - vh) / a0, (vh - vb * k / q1 + k * k) / a0],
        feedback: [1, 2 * (k * k - 1) / a0, (1 - k / q1 + k * k) / a0],
    };
    k = Math.tan(Math.PI * 38.13547087602444 / sampleRate);
    const q2 = 0.5003270373238773;
    a0 = 1 + k / q2 + k * k;
    const highpass = {
        feedforward: [1, -2, 1],
        feedback: [1, 2 * (k * k - 1) / a0, (1 - k / q2 + k * k) / a0],
    };
    return { shelf, highpass };
}

const SHORT_TERM_BLOCKS = 30; // 3 s of 100 ms blocks
const MOMENTARY_BLOCKS = 4;   // 400 ms
const GATE_FLOOR_LUFS = -70;
const GATE_BIN_LU = 0.1;
const GATE_BINS = 800;        // -70 … +10 LUFS

function lufsOf(meanSquare) {
    return meanSquare > 0 ? -0.691 + 10 * Math.log10(meanSquare) : null;
}

// Main-thread side of one meter tap: turns the worklet's 100 ms blocks of
// K-weighted sum of squares into momentary (400 ms), short-term (3 s) and
// gated integrated loudness (BS.1770-4: 400 ms gating blocks on a 100 ms hop,
// -70 LUFS absolute gate, -10 LU relative gate). Gating blocks go into a
// fixed 0.1 LU histogram that keeps each bin's exact power sum, so memory
// stays constant over an all-day session and only the relative-gate edge is
// quantized.
export class LoudnessMeterState {
    constructor() {
        this._sums = new Float64Array(SHORT_TERM_BLOCKS);
        this._samples = new Float64Array(SHORT_TERM_BLOCKS);
        this._head = 0;
        this._filled = 0;
        this._gateSums = new Float64Array(GATE_BINS);
        this._gateCounts = new Uint32Array(GATE_BINS);
        this._peak = 0;
        this.blocks = 0;
    }

    // `sumSquares` is the channel-summed K-weighted energy of `samples` frames.
    push(sumSquares, samples, peak = 0) {
        if (!(samples > 0)) return;
        this._sums[this._head] = sumSquares;
        this._samples[this._head] = samples;
        this._head = (this._head + 1) % SHORT_TERM_BLOCKS;
        this._filled = Math.min(SHORT_TERM_BLOCKS, this._filled + 1);
        this.blocks++;
        if (peak > this._peak) this._peak = peak;

        if (this._filled < MOMENTARY_BLOCKS) return;
        const z = this._meanSquare(MOMENTARY_BLOCKS);
        const lufs = lufsOf(z);
        if (lufs === null || lufs <= GATE_FLOOR_LUFS) return;
        const bin = Math.min(GATE_BINS - 1, Math.floor((lufs - GATE_FLOOR_LUFS) / GATE_BIN_LU));
        this._gateSums[bin] += z;
        this._gateCounts[bin]++;
    }

    _meanSquare(blocks) {
        const n = Math.min(blocks, this._filled);
        let sum = 0;
        let samples = 0;
        for (let i = 1; i <= n; i++) {
            const idx = (this._head - i + SHORT_TERM_BLOCKS) % SHORT_TERM_BLOCKS;
            sum += this._sums[idx];
            samples += this._samples[idx];
        }
        return samples > 0 ? sum / samples : 0;
    }

    _integrated() {
        let sum = 0;
        let count = 0;
        for (let i = 0; i < GATE_BINS; i++) {
            sum += this._gateSums[i];
            count += this._gateCounts[i];
        }
        if (!count) return null;
        const relativeGate = lufsOf(sum / count) - 10;
        sum = 0;
        count = 0;
        for (let i = 0; i < GATE_BINS; i++) {
            const binCentre = GATE_FLOOR_LUFS + (i + 0.5) * GATE_BIN_LU;
            if (binCentre <= relativeGate) continue;
            sum += this._gateSums[i];
            count += this._gateCounts[i];
        }
        return count ? lufsOf(sum / count) : null;
    }

    // LUFS / dBFS; null means no signal (or no data yet).
    read() {
        return {
            momentary: this._filled ? lufsOf(this._meanSquare(MOMENTARY_BLOCKS)) : null,
            shortTerm: this._filled ? lufsOf(this._meanSquare(SHORT_TERM_BLOCKS)) : null,
            integrated: this._integrated(),
            peak: this._peak > 0 ? 20 * Math.log10(this._peak) : null,
        };
    }
}

function gainDb(value) {
    return value > 0 ? 20 * Math.log10(value) : null;
}

// Disconnect every node of a released voice chain.
function disconnectAll(nodes) {
    for (const node of nodes) {
        try { node?.disconnect(); } catch { /* already disconnected */ }
    }
}

export class AudioEngine {
    constructor() {
        this.context = null;
        this.bedGate = null;
        this.fadeGain = null;
        this.volumeGain = null;
        this.analyser = null;
        this.volumeStep = STANDARD_VOLUME_STEP;
        this.started = false;
        this.limiterKind = null;
        // Probe taps: the node feeding the limiter and the limiter's output.
        this._limiterIn = null;
        this._limiterOut = null;
        this._limiterNode = null;
        this._limiterReport = { reductionDb: 0, grOver1dBFrac: 0 };
        this._buses = new Map();
        this._busOuts = new Map();
        this._groups = new Map();
        this._directorGroups = new Map();
        // Island Air: per-director wet inputs per group, per-group wet faders.
        this._directorAir = new Map();
        this._groupAir = new Map();
        this.air = null;
        this._airBedGate = null;
        this._airWetTrim = null;
        this._signalGate = null;
        this._airPhase = 'day';
        this._airWeather = { rain: 0, fog: 0 };
        this._noiseWorklet = false;
        this._tilt = null;
        this._attention = null;
        this._weatherCeiling = null;
        this._bedTap = null;
        this._bedMeter = null;
        this._bedOpenAt = null;
        // D3's quiet mix lowers the bed on purpose; its readers hear the full
        // bed through this compensation (setBedCompensation).
        this._bedComp = { from: 0, to: 0, at: 0 };
        this._musicPre = null;
        // Mix state outlives the context so a rebuilt graph keeps the mix.
        this._groupLevels = new Map(AUDIO_GROUPS.map(name => [name, 1]));
        this._directors = new Map();
        this._tiltPhase = 'day';
        // The listener's output, tone and soften (7.7); set before or after
        // the graph exists.
        this._output = outputSettings('speakers');
        this._tone = 0;
        this._softened = false;
        // Quiet hours (UX-11): the cue bus a little softer, dB ≤ 0.
        this._cueTrimDb = 0;
        this._cueTrim = null;
        this._worldWidth = null;
        this._monoFold = null;
        this._attentionDb = 0;
        this._weatherCeilingDb = 0;
        this._duckSchedulers = new Map(DUCKED_BUSES.map(name => [name, new DuckScheduler()]));
        this._contextPromise = null;
        this._pendingContext = null;
        // Context-independent services: one Transport (S4), one MusicClock,
        // the bake queue and the noise pool (S8). Torn down in dispose().
        this.transport = new Transport(this);
        this.musicClock = new MusicClock();
        this.bank = new SampleBank(this);
        this.noisePool = new NoisePool(this.bank, key => rngStream(`noise.pool.${key}`));
        this._analyserData = null;
        // Bumped by every fade transition; a pending endWake() that sees it
        // changed knows a newer start or wake owns the fade.
        this._fadeEpoch = 0;
        this._meters = null;
        this._metersPending = null;
        this._meterToken = null;
        this._meterModuleContext = null;
        this._disposed = false;
        this._disposePromise = null;
    }

    get running() {
        return Boolean(this.context && this.context.state === 'running');
    }

    now() {
        return this.context ? this.context.currentTime : 0;
    }

    // Create the context on first use (inside the user gesture: resume is
    // kicked before anything is awaited), load the limiter worklet, build
    // the graph, then resume. Memoised; resolves true once running.
    async ensureContext() {
        if (this._disposed) return false;
        if (!this._contextPromise && !this._createContext()) return false;
        // Resume inside the gesture, before anything is awaited: a context
        // prewarmed on hover (prewarm) is still suspended here.
        Promise.resolve(this._pendingContext?.resume?.()).catch(() => { /* needs a user gesture */ });
        if (!(await this._contextPromise)) return false;
        const context = this.context;
        if (!context || this._disposed) return false;
        if (context.state === 'suspended') {
            try { await context.resume(); } catch { /* needs a user gesture */ }
        }
        return !this._disposed && this.context === context && context.state === 'running';
    }

    // Create the (suspended) context and start loading the worklets and
    // building the graph before the click that enables sound, so the click
    // only has to resume it (7.4: first sound ≤ 150 ms after the click). Call
    // on hover or focus of the sound control; no sound, no resume. Idempotent.
    prewarm() {
        if (this._disposed || this._contextPromise) return;
        this._createContext();
    }

    _createContext() {
        const Ctor = globalThis.window?.AudioContext || globalThis.window?.webkitAudioContext;
        if (!Ctor) return false;
        const ctx = new Ctor();
        this._pendingContext = ctx;
        this._contextPromise = this._attach(ctx);
        return true;
    }

    // Build the engine on an existing context (an OfflineAudioContext in the
    // probe): loads the limiter and noise worklets, then builds the graph.
    attachContext(ctx) {
        if (!this._contextPromise) this._contextPromise = this._attach(ctx);
        return this._contextPromise;
    }

    async _attach(ctx) {
        const [worklet, noiseWorklet] = await Promise.all([
            this._loadWorklet(ctx, './worklets/limiter-processor.js'),
            this._loadWorklet(ctx, './worklets/noise-processor.js'),
        ]);
        if (this._disposed) {
            try { await ctx.close(); } catch { /* already closed */ }
            return false;
        }
        this.context = ctx;
        this._noiseWorklet = noiseWorklet;
        this._buildGraph(worklet);
        return true;
    }

    async _loadWorklet(ctx, path) {
        if (noWorkletsRequested() || !ctx.audioWorklet || typeof AudioWorkletNode !== 'function') return false;
        try {
            await ctx.audioWorklet.addModule(new URL(path, import.meta.url));
            return true;
        } catch {
            return false;
        }
    }

    _buildGraph(worklet = false) {
        const ctx = this.context;
        const gain = (value = 1) => {
            const node = ctx.createGain();
            node.gain.value = value;
            return node;
        };
        const now = ctx.currentTime;

        this._buses = new Map(AUDIO_BUSES.map(name => [name, gain()]));
        this._busOuts = new Map(DUCKED_BUSES.map(name => [name, gain()]));
        for (const scheduler of this._duckSchedulers.values()) scheduler.prune(Infinity);

        // world: presence dip, weather ceiling
        this._weatherCeiling = gain(dbToGain(this._weatherCeilingDb));
        this._buses.get('world')
            .connect(makeFilter(ctx, 'peaking', 3400, { q: 0.9, gain: -3 }))
            .connect(this._weatherCeiling);
        const worldPre = this._weatherCeiling;
        const workPre = this._buses.get('work');

        // music: low shelf, bass mono, attention
        this._attention = gain(dbToGain(this._attentionDb));
        const bassMono = this._buildBassMono(ctx);
        this._buses.get('music')
            .connect(makeFilter(ctx, 'lowshelf', 160, { gain: -3 }))
            .connect(bassMono.input);
        bassMono.output.connect(this._attention);
        const musicPre = this._attention;
        this._musicPre = musicPre;

        // The pre-duck bed tap (world + work + music), explicit stereo.
        this._bedTap = gain();
        this._bedTap.channelCount = 2;
        this._bedTap.channelCountMode = 'explicit';
        this._bedTap.channelInterpretation = 'speakers';
        for (const pre of [worldPre, workPre, musicPre]) pre.connect(this._bedTap);
        this._bedMeter = this._buildBedMeter(ctx, this._bedTap);
        this._bedOpenAt = now;

        this._worldWidth = this._buildWidth(ctx, this._output.worldWidth, this._output.worldMakeupDb);
        worldPre.connect(this._worldWidth.input);
        this._worldWidth.output.connect(this._busOuts.get('world'));
        workPre.connect(this._busOuts.get('work'));
        musicPre.connect(this._busOuts.get('music'));

        // Program: tilt on world + music, then gate, trim, HPF.
        this._tilt = makeFilter(ctx, 'highshelf', 3000, { gain: this._tiltDb() });
        const programSum = gain();
        this._busOuts.get('world').connect(this._tilt);
        this._busOuts.get('music').connect(this._tilt);
        this._tilt.connect(programSum);
        this._busOuts.get('work').connect(programSum);
        this.bedGate = gain();
        const masterSum = gain();
        programSum
            .connect(this.bedGate)
            .connect(gain(dbToGain(PROGRAM_TRIM_DB)))
            .connect(makeFilter(ctx, 'highpass', 30))
            .connect(masterSum);
        this._cueTrim = gain(dbToGain(this._cueTrimDb));
        this._buses.get('cue').connect(this._cueTrim).connect(gain(dbToGain(PROGRAM_TRIM_DB))).connect(masterSum);

        // Island Air: one convolver pair; the wet return joins at the cue
        // staging. Its bed gate mirrors bedGate (start / wake).
        this.air?.destroy();
        this.air = new IslandAir(ctx, this.bank, { phase: this._airPhase, weather: this._airWeather });
        this._airBedGate = this.air.bedGate;
        this._airWetTrim = gain(dbToGain(PROGRAM_TRIM_DB));
        this.air.output.connect(this._airWetTrim).connect(masterSum);

        // The held note's own path (S3): its duck, then a gate that mirrors
        // bedGate, then the same program trim as the bed it sits over.
        this._signalGate = gain();
        this._buses.get('signalBed').connect(this._busOuts.get('signalBed'));
        this._busOuts.get('signalBed')
            .connect(this._signalGate)
            .connect(gain(dbToGain(PROGRAM_TRIM_DB)))
            .connect(masterSum);

        // Master: LP 14 kHz → limiter → volume → fade → out.
        this._limiterIn = makeFilter(ctx, 'lowpass', 14000);
        this._monoFold = this._buildWidth(ctx, this._output.mono ? 0 : 1, this._output.monoCompDb);
        masterSum.connect(this._monoFold.input);
        this._monoFold.output.connect(this._limiterIn);
        this._limiterOut = worklet ? this._buildWorkletLimiter(ctx) : this._buildFallbackLimiter(ctx);
        this.volumeGain = gain(this._volumeGainValue());
        this.fadeGain = gain(MIN_GAIN);
        this._limiterOut.connect(this.volumeGain).connect(this.fadeGain).connect(ctx.destination);

        this.analyser = ctx.createAnalyser();
        this.analyser.fftSize = 2048;
        this._analyserData = new Float32Array(this.analyser.fftSize);
        this.fadeGain.connect(this.analyser);

        this._groups.clear();
        this._groupAir.clear();
        for (const name of AUDIO_GROUPS) {
            const fader = gain(this._faderGain(name));
            fader.connect(this._buses.get(GROUP_BUS[name]));
            this._groups.set(name, fader);
            const wetFader = gain(this._faderGain(name));
            wetFader.connect(this.air.bedInput);
            this._groupAir.set(name, wetFader);
        }
        this._directorGroups.clear();
        this._directorAir.clear();
        // The noise pool builds in idle slices from here on (a lane that
        // asks first finishes it synchronously). Queued after the graph so
        // no idle slice is pending across the worklet loads that enabling
        // awaits. Nothing that sounds ever waits for it (or for a bake).
        this.noisePool.prebuild();
    }

    _buildWorkletLimiter(ctx) {
        const node = new AudioWorkletNode(ctx, 'claudeville-limiter', {
            numberOfInputs: 1,
            numberOfOutputs: 1,
            outputChannelCount: [2],
            channelCount: 2,
            channelCountMode: 'explicit',
            channelInterpretation: 'speakers',
            processorOptions: LIMITER_OPTIONS,
        });
        node.port.onmessage = (event) => {
            const [minGainDb, grFrames, frames] = event.data;
            this._limiterReport = {
                reductionDb: Math.min(0, minGainDb),
                grOver1dBFrac: frames > 0 ? grFrames / frames : 0,
            };
        };
        this._limiterIn.connect(node);
        this._limiterNode = node;
        this.limiterKind = 'worklet';
        return node;
    }

    _buildFallbackLimiter(ctx) {
        const comp = ctx.createDynamicsCompressor();
        comp.threshold.value = -2;
        comp.knee.value = 0;
        comp.ratio.value = 20;
        comp.attack.value = 0.001;
        comp.release.value = 0.08;
        const makeupCancel = ctx.createGain();
        makeupCancel.gain.value = dbToGain(FALLBACK_MAKEUP_CANCEL_DB);
        const shaper = ctx.createWaveShaper();
        shaper.curve = shaperCurve();
        // No oversampling: the output is then always a value of the curve,
        // so the curve's end is a hard sample ceiling. With '2x' the
        // resampling filters overshot it (a +14 dBFS noise burst came out
        // at −0.69 dBFS in the probe's limiter unit).
        shaper.oversample = 'none';
        this._limiterIn.connect(comp).connect(makeupCancel).connect(shaper);
        this._limiterNode = comp;
        this.limiterKind = 'fallback';
        return shaper;
    }

    // Bass under 300 Hz mono, width above it untouched: L/R → mid + side,
    // the side high-passed at 300 Hz, recombined. The mono sum is exact.
    _buildBassMono(ctx) {
        const input = ctx.createGain();
        input.channelCount = 2;
        input.channelCountMode = 'explicit';
        input.channelInterpretation = 'speakers';
        const split = ctx.createChannelSplitter(2);
        const monoGain = (value) => {
            const node = ctx.createGain();
            node.gain.value = value;
            node.channelCount = 1;
            node.channelCountMode = 'explicit';
            return node;
        };
        const mid = monoGain(0.5);
        const side = monoGain(0.5);
        const negateRight = monoGain(-1);
        const negateSide = monoGain(-1);
        const sideHp = makeFilter(ctx, 'highpass', 300);
        const output = ctx.createChannelMerger(2);
        input.connect(split);
        split.connect(mid, 0);
        split.connect(mid, 1);
        split.connect(side, 0);
        split.connect(negateRight, 1);
        negateRight.connect(side);
        side.connect(sideHp);
        mid.connect(output, 0, 0);
        mid.connect(output, 0, 1);
        sideHp.connect(output, 0, 0);
        sideHp.connect(negateSide).connect(output, 0, 1);
        return { input, output };
    }

    // Always-on, native-only loudness of the pre-duck bed: K-weighting,
    // each channel squared by feeding it to its own gain param (x · x),
    // summed (true-stereo power), a one-pole mean, and a tiny analyser that
    // bedLoudness() reads at cue schedule time. No worklet, no timer.
    _buildBedMeter(ctx, tap) {
        const { shelf, highpass } = kWeightingCoefficients(ctx.sampleRate);
        const head = ctx.createIIRFilter(shelf.feedforward, shelf.feedback);
        const rlb = ctx.createIIRFilter(highpass.feedforward, highpass.feedback);
        const split = ctx.createChannelSplitter(2);
        tap.connect(head).connect(rlb).connect(split);
        const power = ctx.createGain();
        power.channelCount = 1;
        power.channelCountMode = 'explicit';
        for (const channel of [0, 1]) {
            const square = ctx.createGain();
            square.gain.value = 0;
            split.connect(square, channel);
            split.connect(square.gain, channel);
            square.connect(power);
        }
        const a = Math.exp(-1 / (BED_TAU_SEC * ctx.sampleRate));
        const mean = ctx.createIIRFilter([1 - a], [1, -a]);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 32;
        power.connect(mean).connect(analyser);
        return { analyser, data: new Float32Array(analyser.fftSize) };
    }

    // LUFS of the pre-duck bed (world + work + music) over ~3 s, K-weighted,
    // true-stereo power, in the bus domain: before PROGRAM_TRIM, tilt, fade
    // and volume (the domain of Loudness.js VOICE_REGISTRY nominals), plus
    // the bed compensation. null while the bed is paused or unprimed (not
    // started, a wake, a suspended context, or < 1.5 s since the bed
    // opened); silence reads −70.
    bedLoudness() {
        const meter = this._bedMeter;
        const ctx = this.context;
        if (!meter || !ctx || ctx.state !== 'running' || !this.started || this._bedOpenAt === null) return null;
        if (ctx.currentTime < this._bedOpenAt + BED_PRIME_SEC) return null;
        meter.analyser.getFloatTimeDomainData(meter.data);
        let sum = 0;
        for (let i = 0; i < meter.data.length; i++) sum += meter.data[i];
        const meanSquare = sum / meter.data.length;
        if (!(meanSquare > 0)) return BED_FLOOR_LUFS;
        return Math.max(BED_FLOOR_LUFS, -0.691 + 10 * Math.log10(meanSquare) + this._bedCompensationAt(ctx.currentTime));
    }

    // D3 (5.6): the blurred window's quiet mix lowers the bed faders by
    // `db` on purpose; every bed reader (cue trims, the held note) must
    // still level against the full bed, so signals sound unchanged. The
    // compensation eases with the tap's own one-pole mean (BED_TAU_SEC),
    // so a steady bed reads the same across the change.
    setBedCompensation(db) {
        const now = this.now();
        const to = Math.max(0, Number(db) || 0);
        this._bedComp = { from: this._bedCompensationAt(now), to, at: now };
    }

    _bedCompensationAt(t) {
        const { from, to, at } = this._bedComp;
        // A rebuilt context restarts its clock: the change is long settled.
        if (from === to || t < at) return to;
        const g0 = Math.pow(10, -from / 10);
        const g1 = Math.pow(10, -to / 10);
        return -10 * Math.log10(g1 + (g0 - g1) * Math.exp(-(t - at) / BED_TAU_SEC));
    }

    // A continuous noise lane (AMB-3): an unstarted, looping
    // AudioBufferSourceNode on the colour's stereo pool buffer ('white' |
    // 'brown'); `start(t)` reads from a seeded offset ≥ 5 s from every live
    // continuous lane (`startOffset`). One-shot grains (knocks, thunder) take
    // `noisePool.reserveOneShot` instead, which avoids every live lane, so
    // world offsets never depend on work events.
    noiseSource(color, { rng } = {}) {
        if (!this.context) return null;
        return this.noisePool.source(this.context, color, { rng });
    }

    // Rain dust or bubbles (worklets/noise-processor.js): a 2-channel
    // AudioWorkletNode with a k-rate `density` AudioParam (events/s), or
    // null without AudioWorklet (the caller keeps its native voices).
    noiseWorklet(kind, { rng, density = 0, gain = 1, fmin, fmax, decayMs, tauMs } = {}) {
        if (!this.context || !this._noiseWorklet) return null;
        if (typeof rng !== 'function') throw new Error('noiseWorklet needs an rng stream');
        const node = new AudioWorkletNode(this.context, 'claudeville-noise', {
            numberOfInputs: 0,
            numberOfOutputs: 1,
            outputChannelCount: [2],
            processorOptions: { kind, seed: Math.floor(rng() * 4294967295) >>> 0, gain, fmin, fmax, decayMs, tauMs },
        });
        node.parameters.get('density').value = density;
        return node;
    }

    // One voice's placement chain (S3, S5): node → [low-pass] → panner →
    // bus (or a director's group input), plus an Island Air send of `air`
    // (linear) tapped after the panner — into the cue air input for cues
    // and ungrouped one-shots, into the group's wet input for grouped ones.
    // Built once per voice; `dispose()` disconnects it after the last tail.
    connectVoice(node, { bus = 'cue', group = null, director = 'ambient', pan = 0, air = 0, lowpassHz = null } = {}) {
        const ctx = this.context;
        if (!ctx || !node) return { output: null, dispose() {} };
        const nodes = [];
        let head = node;
        if (Number(lowpassHz) > 0) {
            const lp = makeFilter(ctx, 'lowpass', Math.min(Number(lowpassHz), ctx.sampleRate / 2 - 100));
            head.connect(lp);
            head = lp;
            nodes.push(lp);
        }
        const panner = ctx.createStereoPanner();
        panner.pan.value = Math.max(-1, Math.min(1, (Number(pan) || 0) * this._output.panScale));
        head.connect(panner);
        nodes.push(panner);
        panner.connect(group ? this.groupInput(group, director) : this.busInput(bus));
        const amount = Math.max(0, Number(air) || 0);
        if (amount > 0) {
            nodes.push(this.airSendFrom(panner, amount, group ? { group, director } : { cue: bus === 'cue' }));
        }
        let disposed = false;
        return {
            output: panner,
            dispose: () => {
                if (disposed) return;
                disposed = true;
                try { node.disconnect(nodes[0]); } catch { /* already disconnected */ }
                disconnectAll(nodes);
            },
        };
    }

    // An Island Air send (C-AMB-2: tap it after the layer's level gain):
    // `from` → gain(amount) → the air input. With `group` the send lands in
    // that director's wet input for the group, which follows the director
    // crossfade and the group fader like the dry path; `cue: true` feeds the
    // cue air input (no bed gate); otherwise the bed air input. Returns the
    // send gain (automate `.gain`; disconnect it to remove the send).
    airSendFrom(from, amount, { group = null, director = 'ambient', cue = false } = {}) {
        if (!this.context || !this.air || !from) return null;
        const send = this.context.createGain();
        send.gain.value = Math.max(0, Number(amount) || 0);
        const target = group ? this._groupAirInput(group, director) : cue ? this.air.cueInput : this.air.bedInput;
        from.connect(send).connect(target);
        return send;
    }

    // Island Air mood by phase ('dawn' | 'day' | 'dusk' | 'night'): an
    // equal-power crossfade between the day and night IRs (τ 6 s).
    setAirPhase(phase) {
        this._airPhase = phase;
        this.air?.setPhase(phase);
    }

    // Rain and fog (0..1) colour only the air's return.
    setAirWeather({ rain = 0, fog = 0 } = {}) {
        this._airWeather = { rain, fog };
        this.air?.setWeather(this._airWeather);
    }

    // Probe taps: the bed and cue send sums and the wet return (pre-trim).
    get airReturns() {
        if (!this.air) return null;
        return { bed: this.air.bedGate, cue: this.air.cueInput, wet: this.air.output };
    }

    _groupAirInput(name, director) {
        const wetFader = this._groupAir.get(name);
        if (!wetFader) throw new Error(`Unknown audio group: ${name}`);
        let groups = this._directorAir.get(director);
        if (!groups) {
            groups = new Map();
            this._directorAir.set(director, groups);
        }
        let node = groups.get(name);
        if (!node) {
            node = this._directorNode(director);
            node.connect(wetFader);
            groups.set(name, node);
        }
        return node;
    }

    // A gain that carries a director's crossfade level (and any running fade).
    _directorNode(director) {
        const node = this.context.createGain();
        const state = this._directorState(director);
        const now = this.now();
        node.gain.value = this._directorLevelAt(state, now);
        this._followDirectorFade(node.gain, state, now);
        return node;
    }

    // bedGate, the air's bed gate and the signal-bed gate move together
    // (start / wake).
    _bedGateParams() {
        return [this.bedGate.gain, this._airBedGate?.gain, this._signalGate?.gain].filter(Boolean);
    }

    // Cached console-style timbres: band-limited pulse waves (NES duty
    // cycles) and a soft flute (sine plus a whisper of harmonics).
    wave(name) {
        if (!this.context) return null;
        if (!this._waves) this._waves = new Map();
        if (!this._waves.has(name)) {
            const ctx = this.context;
            let wave = null;
            if (name === 'pulse25' || name === 'pulse12') {
                const duty = name === 'pulse25' ? 0.25 : 0.125;
                const n = 24;
                const real = new Float32Array(n);
                const imag = new Float32Array(n);
                for (let k = 1; k < n; k++) {
                    imag[k] = (2 / (k * Math.PI)) * Math.sin(k * Math.PI * duty);
                }
                wave = ctx.createPeriodicWave(real, imag);
            } else if (name === 'flute') {
                wave = ctx.createPeriodicWave(
                    new Float32Array([0, 0, 0, 0, 0]),
                    new Float32Array([0, 1, 0.22, 0.1, 0.04]),
                );
            }
            this._waves.set(name, wave);
        }
        return this._waves.get(name);
    }

    start() {
        if (this._disposed || !this.context || !this.fadeGain) return;
        this.started = true;
        this._fadeEpoch++;
        const now = this.now();
        const fade = this.fadeGain.gain;
        // Reopen the bed after a wake. If the fade is already open (a start
        // during a wake) the bed must glide in, not step in under the cue.
        const fadeOpen = fade.value > 0.001;
        for (const gate of this._bedGateParams()) {
            holdAt(gate, now);
            if (fadeOpen) gate.setTargetAtTime(1, now, 0.4);
            else gate.setValueAtTime(1, now);
        }
        if (this._bedOpenAt === null) this._bedOpenAt = now;
        holdAt(fade, now);
        fade.setTargetAtTime(1, now, 0.4);
    }

    stop() {
        if (!this.context || !this.fadeGain) return;
        this.started = false;
        this._fadeEpoch++;
        this._bedOpenAt = null;
        const now = this.now();
        holdAt(this.fadeGain.gain, now);
        this.fadeGain.gain.setTargetAtTime(MIN_GAIN, now, 0.16);
    }

    // Urgent wake from a hidden tab (0.2): resume the context and open the
    // cue path at full level within 15 ms, with the program (bed and music)
    // gated off so only the cue sounds. Resolves true once the context runs
    // and the cue path is open; CueKit sounds while `started` is true.
    async wake() {
        const ready = await this.ensureContext();
        if (!ready || !this.fadeGain) return false;
        this.started = true;
        this._fadeEpoch++;
        this._bedOpenAt = null;
        const now = this.now();
        const fade = this.fadeGain.gain;
        // A closed fade makes the gate step inaudible; an open one (a wake
        // over a running mix) needs the same short ramp the cue path gets.
        for (const gate of this._bedGateParams()) {
            holdAt(gate, now);
            if (fade.value > 0.001) gate.linearRampToValueAtTime(0, now + WAKE_OPEN_SEC);
            else gate.setValueAtTime(0, now);
        }
        holdAt(fade, now);
        fade.linearRampToValueAtTime(1, now + WAKE_OPEN_SEC);
        return true;
    }

    // End a wake: at `untilTime` (the last note + its tail + margin, on the
    // audio clock) ramp the fade to silence over 80 ms. Resolves true after
    // the ramp when this wake still owns the fade — the caller may then
    // suspend — or false when a start() or newer wake superseded it.
    endWake(untilTime = this.now()) {
        if (!this.context || !this.fadeGain) return Promise.resolve(false);
        const epoch = ++this._fadeEpoch;
        const now = this.now();
        const at = Math.max(now, Number(untilTime) || now);
        const fade = this.fadeGain.gain;
        holdAt(fade, at);
        fade.linearRampToValueAtTime(0, at + WAKE_CLOSE_SEC);
        // A timer only reports that the scheduled ramp has finished; the
        // ramp itself lives on the audio clock.
        const waitMs = (at + WAKE_CLOSE_SEC - now) * 1000 + 20;
        return new Promise((resolve) => {
            setTimeout(() => {
                const owns = !this._disposed && this._fadeEpoch === epoch;
                if (owns) this.started = false;
                resolve(owns);
            }, waitMs);
        });
    }

    async suspend() {
        const context = this.context;
        if (!context || context.state !== 'running') return;
        try { await context.suspend(); } catch { /* best effort */ }
    }

    // Master volume on the step law (UX-8): 0 = off, 3.6 dB per step,
    // step 10 = unity. The last gain before the fade.
    setVolumeStep(step) {
        const n = Math.round(Number(step));
        this.volumeStep = Number.isFinite(n) ? Math.max(0, Math.min(10, n)) : STANDARD_VOLUME_STEP;
        if (!this.volumeGain) return;
        this.volumeGain.gain.setTargetAtTime(this._volumeGainValue(), this.now(), 0.05);
    }

    _volumeGainValue() {
        return volumeStepGain(this.volumeStep);
    }

    // The persistent input of a bus: 'world' | 'work' | 'music' | 'cue' |
    // 'signalBed'. With `director`, a gain into that bus that carries the
    // director's crossfade (and pause), for a voice a director owns outside
    // the mixer groups (the held note).
    busInput(name, director = null) {
        const bus = this._buses.get(name);
        if (!bus) throw new Error(`Unknown audio bus: ${name}`);
        if (!director) return bus;
        let inputs = this._directorGroups.get(director);
        if (!inputs) {
            inputs = new Map();
            this._directorGroups.set(director, inputs);
        }
        const key = `bus:${name}`;
        let node = inputs.get(key);
        if (!node) {
            node = this._directorNode(director);
            node.connect(bus);
            inputs.set(key, node);
        }
        return node;
    }

    // Probe tap: a ducked bus after its duck ('world' | 'work' | 'music' | 'signalBed').
    _busOut(name) {
        const out = this._busOuts.get(name);
        if (!out) throw new Error(`Unknown ducked bus: ${name}`);
        return out;
    }

    // A director's input to a mixer group: layers and players connect here.
    // Each director has its own gain per group so a preset switch can
    // crossfade the two directors (fadeDirector) under the same faders.
    groupInput(name, director = 'ambient') {
        const fader = this._groups.get(name);
        if (!fader) throw new Error(`Unknown audio group: ${name}`);
        let groups = this._directorGroups.get(director);
        if (!groups) {
            groups = new Map();
            this._directorGroups.set(director, groups);
        }
        let node = groups.get(name);
        if (!node) {
            node = this._directorNode(director);
            node.connect(fader);
            groups.set(name, node);
        }
        return node;
    }

    // Equal-power fade of every group gain (dry and air) of one director to
    // `to01` over `duration` seconds (64-point setValueCurveAtTime); duration
    // ≤ 0 sets it at once. Works before a context exists (the level is kept
    // for the next graph). Returns the audio time at which the fade ends.
    fadeDirector(directorId, to01, { duration = 2.5 } = {}) {
        const state = this._directorState(directorId);
        const to = clamp01(to01, 1);
        const now = this.now();
        const nodes = [
            ...(this._directorGroups.get(directorId)?.values() ?? []),
            ...(this._directorAir.get(directorId)?.values() ?? []),
        ];
        const sec = Number(duration);
        if (!this.context || !(sec > 0)) {
            const previous = state.fade;
            state.level = to;
            state.fade = null;
            for (const node of nodes) {
                this._releaseDirectorParam(node.gain, now, previous);
                node.gain.setValueAtTime(to, now);
            }
            return now;
        }
        // Start one render quantum ahead so the curve never overlaps the hold.
        const start = now + 128 / this.context.sampleRate;
        // From the level held at `now`, so the curve continues without a step.
        const from = this._directorLevelAt(state, now);
        const previous = state.fade;
        state.fade = { start, duration: sec, from, to };
        state.level = to;
        for (const node of nodes) {
            this._releaseDirectorParam(node.gain, now, previous);
            this._followDirectorFade(node.gain, state, now);
        }
        return start + sec;
    }

    _directorState(id) {
        let state = this._directors.get(id);
        if (!state) {
            state = { level: 1, fade: null };
            this._directors.set(id, state);
        }
        return state;
    }

    _directorLevelAt(state, t) {
        const fade = state.fade;
        if (!fade || t >= fade.start + fade.duration) return state.level;
        if (t <= fade.start) return fade.from;
        return equalPowerAt(fade.from, fade.to, (t - fade.start) / fade.duration);
    }

    // Replays the remainder of the director's fade (if any) onto `param`.
    _followDirectorFade(param, state, now) {
        const fade = state.fade;
        if (!fade) return;
        const end = fade.start + fade.duration;
        const start = Math.max(fade.start, now + 128 / this.context.sampleRate);
        if (end - start <= 0.001) {
            param.setValueAtTime(state.level, Math.max(now, end));
            return;
        }
        const curve = new Float32Array(CROSSFADE_POINTS);
        for (let i = 0; i < CROSSFADE_POINTS; i++) {
            curve[i] = this._directorLevelAt(state, start + (end - start) * i / (CROSSFADE_POINTS - 1));
        }
        param.setValueCurveAtTime(curve, start, end - start);
    }

    // Cancel a director gain's future at `now` and restate the level it has
    // reached. A running value curve is removed from its start and the level
    // computed here: Chromium's cancelAndHoldAtTime inside a
    // setValueCurveAtTime holds the wrong value (measured on an offline
    // context: 1.0 where the curve stood at 0.81, a step on reversal), and
    // without it a setValueAtTime inside the curve throws.
    _releaseDirectorParam(param, now, fade) {
        const level = fade
            ? (now >= fade.start + fade.duration ? fade.to
                : now <= fade.start ? fade.from
                    : equalPowerAt(fade.from, fade.to, (now - fade.start) / fade.duration))
            : param.value;
        param.cancelScheduledValues(fade ? Math.min(fade.start, now) : now);
        param.setValueAtTime(level, now);
    }

    // Mixer trim as a linear fader gain (the step law lives with the
    // settings); 0 closes the fader, never a negative or NaN gain.
    setGroupLevel(name, value) {
        if (!this._groupLevels.has(name)) throw new Error(`Unknown audio group: ${name}`);
        this._groupLevels.set(name, clamp01(value, 1));
        for (const fader of [this._groups.get(name), this._groupAir.get(name)]) {
            if (fader) fader.gain.setTargetAtTime(this._faderGain(name), this.now(), 0.05);
        }
    }

    _faderGain(name) {
        return Math.max(MIN_GAIN, this._groupLevels.get(name));
    }

    // Circadian tilt (world + music): high shelf at 3 kHz by phase, gliding
    // with τ 10 s. Repeated calls with the same phase do nothing.
    setTilt(phase) {
        const key = Object.hasOwn(TILT_DB, phase) ? phase : 'day';
        if (key === this._tiltPhase) return;
        this._tiltPhase = key;
        if (this._tilt) this._tilt.gain.setTargetAtTime(this._tiltDb(), this.now(), TILT_TAU_SEC);
    }

    _tiltDb() {
        return (TILT_DB[this._tiltPhase] ?? 0) + toneDb(this._tone);
    }

    // Warm ↔ Bright (7.7, SOTA-14): −1…+1 → ±4 dB on the same 3 kHz shelf,
    // world and music only.
    setTone(value) {
        const v = Math.max(-1, Math.min(1, Number(value) || 0));
        if (v === this._tone) return;
        this._tone = v;
        if (this._tilt) this._tilt.gain.setTargetAtTime(this._tiltDb(), this.now(), TONE_TAU_SEC);
    }

    get tone() {
        return this._tone;
    }

    // Speakers · Headphones · Mono (7.7, UX-10). Pans apply to voices placed
    // from now on; the world width and the mono fold glide over 0.1 s.
    setOutput(mode) {
        const next = outputSettings(mode);
        if (next.output === this._output.output) return;
        this._output = next;
        const now = this.now();
        this._worldWidth?.set(next.worldWidth, next.worldMakeupDb, now);
        this._monoFold?.set(next.mono ? 0 : 1, next.monoCompDb, now);
    }

    get outputMode() {
        return this._output.output;
    }

    // Soften sudden sounds (7.7, UX-14). CueKit reads it at schedule time:
    // gentler bell attacks and thunder, shallower ducks; the needs-you call
    // stays whole. The controller resolves `auto` from Reduce motion.
    setSoften(on) {
        this._softened = Boolean(on);
    }

    get softened() {
        return this._softened;
    }

    // The cue bus trim (UX-11 quiet hours: −6 dB), dB ≤ 0, glided ~50 ms.
    // It trims the dry cue path; a cue's Island Air send (≥ 14 dB under its
    // dry, S5) is left as is. Bed-aware trims never see it: they read the bed.
    setCueTrim(db) {
        const next = Math.min(0, Number(db) || 0);
        if (next === this._cueTrimDb) return;
        this._cueTrimDb = next;
        this._cueTrim?.gain.setTargetAtTime(dbToGain(next), this.now(), CUE_TRIM_TAU_SEC);
    }

    // Plain JSON for the probe and `__claudevilleAudio()`.
    outputSnapshot() {
        return {
            output: this._output.output,
            panScale: this._output.panScale,
            worldWidth: this._output.worldWidth,
            monoCompDb: this._output.monoCompDb,
            tone: this._tone,
            toneDb: toneDb(this._tone),
            tiltDb: TILT_DB[this._tiltPhase] ?? 0,
            softened: this._softened,
            cueTrimDb: this._cueTrimDb,
        };
    }

    // A stereo width stage (OutputStage.widthMatrix): L' = a·L + b·R,
    // R' = b·L + a·R, then a make-up gain. Width 1 and 0 dB is transparent.
    _buildWidth(ctx, width, makeupDb) {
        const input = ctx.createGain();
        const split = ctx.createChannelSplitter(2);
        const merge = ctx.createChannelMerger(2);
        const output = ctx.createGain();
        input.channelCount = 2;
        input.channelCountMode = 'explicit';
        input.channelInterpretation = 'speakers';
        const { a, b } = widthMatrix(width);
        const ll = ctx.createGain(); const rl = ctx.createGain();
        const lr = ctx.createGain(); const rr = ctx.createGain();
        ll.gain.value = a; rr.gain.value = a; rl.gain.value = b; lr.gain.value = b;
        input.connect(split);
        split.connect(ll, 0); split.connect(lr, 0);
        split.connect(rl, 1); split.connect(rr, 1);
        ll.connect(merge, 0, 0); rl.connect(merge, 0, 0);
        lr.connect(merge, 0, 1); rr.connect(merge, 0, 1);
        output.gain.value = dbToGain(makeupDb);
        merge.connect(output);
        return {
            input,
            output,
            set: (w, db, at) => {
                const m = widthMatrix(w);
                for (const [param, v] of [[ll.gain, m.a], [rr.gain, m.a], [rl.gain, m.b], [lr.gain, m.b], [output.gain, dbToGain(db)]]) {
                    param.setTargetAtTime(v, at, TONE_TAU_SEC);
                }
            },
        };
    }

    // Weather ceiling on the world bus (1.4), dB ≤ 0, before the duck and
    // inside the bed-aware tap.
    setWeatherCeiling(db, timeConstant = 4) {
        this._weatherCeilingDb = Math.min(0, Number(db) || 0);
        if (this._weatherCeiling) {
            this._weatherCeiling.gain.setTargetAtTime(dbToGain(this._weatherCeilingDb), this.now(), timeConstant);
        }
    }

    // The music bus attention stage (Town band while someone waits), dB ≤ 0;
    // composes with the ducks and the director crossfade.
    setAttention(db, { tau = 0.5 } = {}) {
        this._attentionDb = Math.min(0, Number(db) || 0);
        if (this._attention) {
            this._attention.gain.setTargetAtTime(dbToGain(this._attentionDb), this.now(), tau);
        }
    }

    // Note-timed ducks (S3, ENG-5): from `from − attack` the bus ramps to its
    // depth by `from` (the first heard note), holds to `until` (the last note
    // + hold), and releases over `release`. `depths` in dB per bus (world,
    // work, music; 0 or missing = no duck). Deepest wins over overlapping
    // windows; none is deeper than −9 dB. `cancel()` removes the window (a
    // pre-empted cue leaves no dip).
    duck({ from, until, depths = {}, attack, release } = {}) {
        const entries = [];
        const context = this.context;
        if (context && this._busOuts.size) {
            const now = this.now();
            for (const bus of DUCKED_BUSES) {
                const scheduler = this._duckSchedulers.get(bus);
                scheduler.prune(now);
                const id = scheduler.add({ from, until, depthDb: depths?.[bus], attack, release });
                if (id === null) continue;
                entries.push([bus, id]);
                this._applyDuck(bus, now, 0);
            }
        }
        let cancelled = false;
        return {
            cancel: () => {
                if (cancelled) return;
                cancelled = true;
                if (this.context !== context || !context) return;
                const now = this.now();
                for (const [bus, id] of entries) {
                    const scheduler = this._duckSchedulers.get(bus);
                    const active = scheduler.isActive(id, now);
                    if (!scheduler.remove(id)) continue;
                    scheduler.prune(now);
                    this._applyDuck(bus, now, active ? DUCK_SETTLE_SEC : 0);
                }
            },
        };
    }

    _applyDuck(bus, now, settle) {
        const param = this._busOuts.get(bus).gain;
        const scheduler = this._duckSchedulers.get(bus);
        holdAt(param, now);
        let points = scheduler.curve(now);
        if (settle > 0) {
            const t = now + settle;
            points = [{ t, gain: scheduler.valueAt(t) }, ...points.filter(p => p.t > t)];
        }
        for (const point of points) param.linearRampToValueAtTime(point.gain, point.t);
    }

    // Release one voice without a click: from wherever its envelope is at
    // `at`, ramp linearly to silence over `sec`, then stop its sources just
    // after. Returns the stop time.
    releaseVoice({ sources = [], env, at = this.now(), sec = 0.03 } = {}) {
        const t = Math.max(this.now(), Number(at) || 0);
        if (env?.gain) {
            holdAt(env.gain, t);
            env.gain.linearRampToValueAtTime(MIN_GAIN, t + sec);
        }
        const stopAt = t + sec + 0.01;
        for (const source of sources) {
            try { source?.stop(stopAt); } catch { /* not started or already stopped */ }
        }
        return stopAt;
    }

    // Silence a bus or group gain with a linear ramp (S8: every group stop
    // is ≥ 60 ms linear). Returns the audio time at which it is silent.
    stopGroup(gainNode, sec = 0.08) {
        const now = this.now();
        if (!gainNode?.gain) return now;
        holdAt(gainNode.gain, now);
        gainNode.gain.linearRampToValueAtTime(0, now + sec);
        return now + sec;
    }

    // Post-mix RMS, for QA: lets a headless browser check "is sound actually
    // playing and does it get louder in a storm" without ears.
    rms() {
        if (!this.analyser || !this._analyserData) return 0;
        this.analyser.getFloatTimeDomainData(this._analyserData);
        let sum = 0;
        for (let i = 0; i < this._analyserData.length; i++) {
            sum += this._analyserData[i] * this._analyserData[i];
        }
        return Math.sqrt(sum / this._analyserData.length);
    }

    // Debug loudness meters (0.8a / ENG-10). Nothing — no module, node or
    // timer — exists until this runs; the worklet module loads on the first
    // enable only. Resolves false when the context or AudioWorklet is missing.
    enableMeters() {
        if (this._meters) return Promise.resolve(true);
        if (this._metersPending) return this._metersPending;
        const ctx = this.context;
        if (this._disposed || !ctx || !ctx.audioWorklet || typeof AudioWorkletNode !== 'function') {
            return Promise.resolve(false);
        }
        const token = {};
        this._meterToken = token;
        this._metersPending = (async () => {
            try {
                if (this._meterModuleContext !== ctx) {
                    await ctx.audioWorklet.addModule(new URL('./worklets/meter-processor.js', import.meta.url));
                    this._meterModuleContext = ctx;
                }
                // Disabled, disposed or rebuilt while the module loaded.
                if (this._meterToken !== token || this.context !== ctx) return false;
                this._meters = this._buildMeters(ctx);
                this._limiterReporting(true);
                return true;
            } catch {
                return false;
            } finally {
                if (this._meterToken === token) this._metersPending = null;
            }
        })();
        return this._metersPending;
    }

    _limiterReporting(on) {
        if (this.limiterKind !== 'worklet' || !this._limiterNode) return;
        try { this._limiterNode.port.postMessage({ report: on }); } catch { /* context closed */ }
    }

    _buildMeters(ctx) {
        const sources = {
            program: this.fadeGain,
            bed: this._bedTap,
            music: this._musicPre,
            cue: this._buses.get('cue'),
        };
        const { shelf, highpass } = kWeightingCoefficients(ctx.sampleRate);
        // One silent output connected to the destination keeps the node
        // pulled by the render graph in every engine.
        const node = new AudioWorkletNode(ctx, 'claudeville-meter', {
            numberOfInputs: METER_TAPS.length * 2,
            numberOfOutputs: 1,
            outputChannelCount: [1],
            channelCount: 2,
            channelCountMode: 'explicit',
            channelInterpretation: 'speakers',
            processorOptions: { taps: METER_TAPS.length },
        });
        const states = new Map(METER_TAPS.map(name => [name, new LoudnessMeterState()]));
        const links = [];
        const filters = [];
        METER_TAPS.forEach((name, i) => {
            const source = sources[name];
            const head = ctx.createIIRFilter(shelf.feedforward, shelf.feedback);
            const rlb = ctx.createIIRFilter(highpass.feedforward, highpass.feedback);
            source.connect(head);
            head.connect(rlb).connect(node, 0, 2 * i);
            source.connect(node, 0, 2 * i + 1);
            links.push([source, head], [source, node]);
            filters.push(head, rlb);
        });
        node.connect(ctx.destination);
        node.port.onmessage = (event) => {
            const block = event.data;
            const samples = block[0];
            METER_TAPS.forEach((name, i) => {
                const base = 1 + i * 3;
                states.get(name).push(block[base] + block[base + 1], samples, block[base + 2]);
            });
        };
        return { node, states, links, filters };
    }

    // Disconnects and drops every meter node; the worklet stops processing.
    disableMeters() {
        this._meterToken = null;
        this._metersPending = null;
        const meters = this._meters;
        this._meters = null;
        if (!meters) return;
        this._limiterReporting(false);
        meters.node.port.onmessage = null;
        try { meters.node.port.postMessage('stop'); } catch { /* context closed */ }
        // Targeted disconnects only: the taps are live nodes of the main chain.
        for (const [source, target] of meters.links) {
            try { source.disconnect(target); } catch { /* already disconnected */ }
        }
        for (const filter of meters.filters) {
            try { filter.disconnect(); } catch { /* already disconnected */ }
        }
        try { meters.node.disconnect(); } catch { /* already disconnected */ }
    }

    // Current readings, or null while meters are off. Loudness in LUFS, peak
    // in dBFS (sample peak since enable); null inside a tap means silence.
    // `program` is the engine output (after volume and fade); `bed` is the
    // pre-duck bed tap bedLoudness() reads.
    readMeters() {
        const meters = this._meters;
        if (!meters) return null;
        const reading = {};
        for (const [name, state] of meters.states) reading[name] = state.read();
        reading.seconds = meters.states.get('program').blocks * 0.1;
        reading.limiter = this.limiterKind === 'worklet'
            ? { ...this._limiterReport }
            : { reductionDb: Number(this._limiterNode?.reduction) || 0, grOver1dBFrac: null };
        reading.duck = {};
        for (const [bus, node] of this._busOuts) reading.duck[`${bus}Db`] = gainDb(node.gain.value);
        reading.bedLoudness = this.bedLoudness();
        return reading;
    }

    async dispose() {
        if (this._disposePromise) return this._disposePromise;
        this.disableMeters();
        this._disposed = true;
        this.started = false;
        this._fadeEpoch++;
        const context = this.context;
        if (this._limiterNode?.port) this._limiterNode.port.onmessage = null;
        this.context = null;
        this.bedGate = null;
        this.fadeGain = null;
        this.volumeGain = null;
        this.analyser = null;
        this._limiterIn = null;
        this._limiterOut = null;
        this._limiterNode = null;
        this._buses.clear();
        this._busOuts.clear();
        this._groups.clear();
        this._directorGroups.clear();
        this._groupAir.clear();
        this._directorAir.clear();
        // The Transport's interval, pending bakes and pool slices, and the
        // air's idle-convolver timer.
        this.transport.destroy();
        this.bank.destroy();
        this.noisePool.destroy();
        this.air?.destroy();
        this.air = null;
        this._airBedGate = null;
        this._airWetTrim = null;
        this._signalGate = null;
        this._tilt = null;
        this._attention = null;
        this._weatherCeiling = null;
        this._bedTap = null;
        this._bedMeter = null;
        this._musicPre = null;
        this._meterModuleContext = null;
        this._waves = null;
        this._disposePromise = (async () => {
            if (context) {
                try { await context.close(); } catch { /* already closed */ }
            }
        })();
        return this._disposePromise;
    }
}
