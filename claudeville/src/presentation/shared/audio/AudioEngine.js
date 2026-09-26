// Web Audio context lifecycle and master mix chain for the village soundscape.
//
// Graph:
//   wind ─────┐
//   rain ─────┤  group faders
//   wildlife ─┤  (mixer trims, v²)
//   hum ──────┤
//   music ────┴→ ambienceBus → bedGate → duckGain ─┐
//   cueBus ────────────────────────────────────────┴→ mixBus → fade → masterGain(volume²) → tone → limiter → analyser → destination
//
// Continuous layers connect to their group fader (or `ambienceBus`); one-shot
// cues connect to `cueBus`, which bypasses the duck so cues briefly sit above
// the ambience. `bedGate` closes the bed and music path during a hidden-tab
// wake so only the cue sounds. `fade` rides on mixBus for enable/disable
// transitions. The limiter is a safety net only — target levels are mixed to
// never engage it audibly.
//
// Debug meters (ENG-10) are side branches that exist only while enabled:
//   limiter / ambienceBus / music fader / cueBus → K-weighting IIR ×2 ─┐
//                                                 (unweighted, peak) ──┴→ meter worklet
// Bus taps read before the fade and master volume; `program` reads the
// engine output after the limiter.

export const MIN_GAIN = 0.0001;

// Mixer groups with a persistent fader each; layers name theirs via BaseLayer's `group`.
export const AUDIO_GROUPS = Object.freeze(['wind', 'rain', 'wildlife', 'hum', 'music']);

const METER_TAPS = Object.freeze(['program', 'bed', 'music', 'cue']);
const WAKE_OPEN_SEC = 0.015;
const WAKE_CLOSE_SEC = 0.08;

export function clamp01(value, fallback = 0) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(0, Math.min(1, n));
}

export function rand(min, max) {
    return min + Math.random() * (max - min);
}

export function pick(list) {
    return list[Math.floor(Math.random() * list.length)];
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

function buildNoiseBuffer(ctx, type, seconds = 4) {
    const length = Math.max(1, Math.floor(ctx.sampleRate * seconds));
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buffer.getChannelData(0);

    if (type === 'brown') {
        let last = 0;
        for (let i = 0; i < length; i++) {
            const white = Math.random() * 2 - 1;
            last = (last + 0.02 * white) / 1.02;
            data[i] = last * 3.2;
        }
    } else {
        for (let i = 0; i < length; i++) {
            data[i] = (Math.random() * 2 - 1) * 0.6;
        }
    }
    return buffer;
}

export class AudioEngine {
    constructor() {
        this.context = null;
        this.ambienceBus = null;
        this.cueBus = null;
        this.bedGate = null;
        this.duckGain = null;
        this.mixBus = null;
        this.fadeGain = null;
        this.masterGain = null;
        this.analyser = null;
        this.volume = 0.5;
        this.started = false;
        this._groups = new Map();
        // Fader values outlive the context so a rebuilt graph keeps the mix.
        this._groupLevels = new Map(AUDIO_GROUPS.map(name => [name, 1]));
        this._limiter = null;
        this._noiseBuffers = new Map();
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

    async ensureContext() {
        if (this._disposed) return false;
        if (!this.context) {
            const Ctor = window.AudioContext || window.webkitAudioContext;
            if (!Ctor) return false;
            this.context = new Ctor();
            this._buildGraph();
        }
        const context = this.context;
        if (context.state === 'suspended') {
            try { await context.resume(); } catch { /* needs a user gesture */ }
        }
        return !this._disposed && this.context === context && context.state === 'running';
    }

    _buildGraph() {
        const ctx = this.context;

        this.ambienceBus = ctx.createGain();
        this.cueBus = ctx.createGain();
        this.bedGate = ctx.createGain();
        this.duckGain = ctx.createGain();
        this.mixBus = ctx.createGain();
        this.fadeGain = ctx.createGain();
        this.fadeGain.gain.value = MIN_GAIN;
        this.masterGain = ctx.createGain();
        this.masterGain.gain.value = this._volumeGain();

        this._groups.clear();
        for (const name of AUDIO_GROUPS) {
            const fader = ctx.createGain();
            fader.gain.value = this._faderGain(name);
            fader.connect(this.ambienceBus);
            this._groups.set(name, fader);
        }

        const tone = ctx.createBiquadFilter();
        tone.type = 'lowpass';
        tone.frequency.value = 6200;
        tone.Q.value = 0.4;

        const limiter = ctx.createDynamicsCompressor();
        limiter.threshold.value = -10;
        limiter.knee.value = 16;
        limiter.ratio.value = 6;
        limiter.attack.value = 0.01;
        limiter.release.value = 0.4;
        this._limiter = limiter;

        this.analyser = ctx.createAnalyser();
        this.analyser.fftSize = 2048;
        this._analyserData = new Float32Array(this.analyser.fftSize);

        this.ambienceBus.connect(this.bedGate).connect(this.duckGain).connect(this.mixBus);
        this.cueBus.connect(this.mixBus);
        this.mixBus.connect(this.fadeGain)
            .connect(this.masterGain)
            .connect(tone)
            .connect(limiter)
            .connect(this.analyser)
            .connect(ctx.destination);
    }

    noise(type = 'white') {
        if (!this.context) return null;
        if (!this._noiseBuffers.has(type)) {
            this._noiseBuffers.set(type, buildNoiseBuffer(this.context, type));
        }
        return this._noiseBuffers.get(type);
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
        const gate = this.bedGate.gain;
        // Reopen the bed after a wake. If the fade is already open (a start
        // during a wake) the bed must glide in, not step in under the cue.
        const fadeOpen = fade.value > 0.001;
        holdAt(gate, now);
        if (fadeOpen) gate.setTargetAtTime(1, now, 0.4);
        else gate.setValueAtTime(1, now);
        holdAt(fade, now);
        fade.setTargetAtTime(1, now, 0.4);
    }

    stop() {
        if (!this.context || !this.fadeGain) return;
        this.started = false;
        this._fadeEpoch++;
        const now = this.now();
        holdAt(this.fadeGain.gain, now);
        this.fadeGain.gain.setTargetAtTime(MIN_GAIN, now, 0.16);
    }

    // Urgent wake from a hidden tab (0.2): resume the context and open the
    // cue path at full level within 15 ms, with the bed and music path closed
    // so only the cue sounds. Resolves true once the context runs and the
    // cue path is open; CueKit sounds while `started` is true.
    async wake() {
        const ready = await this.ensureContext();
        if (!ready || !this.fadeGain) return false;
        this.started = true;
        this._fadeEpoch++;
        const now = this.now();
        const fade = this.fadeGain.gain;
        const gate = this.bedGate.gain;
        holdAt(gate, now);
        // A closed fade makes the gate step inaudible; an open one (a wake
        // over a running mix) needs the same short ramp the cue path gets.
        if (fade.value > 0.001) gate.linearRampToValueAtTime(0, now + WAKE_OPEN_SEC);
        else gate.setValueAtTime(0, now);
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

    setVolume(value) {
        this.volume = clamp01(value, 0.5);
        if (!this.masterGain) return;
        this.masterGain.gain.setTargetAtTime(this._volumeGain(), this.now(), 0.05);
    }

    // Perceptual volume: square the slider value so mid-slider feels mid-loud.
    _volumeGain() {
        return Math.max(MIN_GAIN, this.volume * this.volume * 0.9);
    }

    // The persistent fader for a mixer group; layers and players connect here.
    groupInput(name) {
        const fader = this._groups.get(name);
        if (!fader) throw new Error(`Unknown audio group: ${name}`);
        return fader;
    }

    // Mixer trim 0..1 → fader gain on the same square law as the master, so
    // a trim scales loudness and never the world's density.
    setGroupLevel(name, value) {
        if (!this._groupLevels.has(name)) throw new Error(`Unknown audio group: ${name}`);
        this._groupLevels.set(name, clamp01(value, 1));
        const fader = this._groups.get(name);
        if (fader) fader.gain.setTargetAtTime(this._faderGain(name), this.now(), 0.05);
    }

    _faderGain(name) {
        const v = this._groupLevels.get(name);
        return Math.max(MIN_GAIN, v * v);
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

    // Duck the ambience bus under a cue, then recover.
    duck(depth = 0.4, holdSec = 0.6) {
        if (!this.duckGain) return;
        const now = this.now();
        const g = this.duckGain.gain;
        g.cancelScheduledValues(now);
        g.setTargetAtTime(1 - clamp01(depth), now, 0.06);
        g.setTargetAtTime(1, now + holdSec, 0.9);
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
                return true;
            } catch {
                return false;
            } finally {
                if (this._meterToken === token) this._metersPending = null;
            }
        })();
        return this._metersPending;
    }

    _buildMeters(ctx) {
        const sources = {
            program: this._limiter,
            bed: this.ambienceBus,
            music: this._groups.get('music'),
            cue: this.cueBus,
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
    readMeters() {
        const meters = this._meters;
        if (!meters) return null;
        const reading = {};
        for (const [name, state] of meters.states) reading[name] = state.read();
        reading.seconds = meters.states.get('program').blocks * 0.1;
        reading.limiter = { reductionDb: Number(this._limiter?.reduction) || 0 };
        reading.duck = { bedDb: gainDb(this.duckGain?.gain.value ?? 1) };
        return reading;
    }

    async dispose() {
        if (this._disposePromise) return this._disposePromise;
        this.disableMeters();
        this._disposed = true;
        this.started = false;
        this._fadeEpoch++;
        const context = this.context;
        this.context = null;
        this.ambienceBus = null;
        this.cueBus = null;
        this.bedGate = null;
        this.duckGain = null;
        this.mixBus = null;
        this.fadeGain = null;
        this.masterGain = null;
        this.analyser = null;
        this._limiter = null;
        this._groups.clear();
        this._meterModuleContext = null;
        this._noiseBuffers.clear();
        this._waves = null;
        this._disposePromise = (async () => {
            if (context) {
                try { await context.close(); } catch { /* already closed */ }
            }
        })();
        return this._disposePromise;
    }
}
