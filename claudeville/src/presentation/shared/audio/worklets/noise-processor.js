// Island noise worklet (AMB-3): the two rain textures that need a live
// event process — `dust` (sparse ticks) and `bubbles` (Minnaert plinks
// that glide up) — at `density` events per second (k-rate AudioParam).
// Every continuous colour comes from the engine's buffer pool instead.
// Seeded per node (processorOptions.seed); zero allocations in process().
// While the density is 0 and the last event has died away a quantum is
// silence without drawing noise, so a dry island costs almost nothing.
// Loaded by AudioEngine with the limiter; without AudioWorklet the rain
// layer keeps native plink lanes.

const BUBBLE_VOICES = 8;
// A bubble's glide stops at this multiple of its start pitch (a real drop
// rises by about a third; an unbounded glide would alias as it decays).
const GLIDE_MAX = 1.5;
const SILENT = 1e-4;
// A bubble 60 dB under its strike is over.
const VOICE_SILENT = 1e-3;

class IslandNoiseProcessor extends AudioWorkletProcessor {
    static get parameterDescriptors() {
        return [{ name: 'density', defaultValue: 0, minValue: 0, maxValue: 40000, automationRate: 'k-rate' }];
    }

    constructor(options) {
        super();
        const p = options?.processorOptions || {};
        this.kind = p.kind === 'bubbles' ? 'bubbles' : 'dust';
        const seed = (p.seed >>> 0) || 0x9e3779b9;
        this.s = [seed, (Math.imul(seed ^ 0x85ebca6b, 0xc2b2ae35) >>> 0) || 1, (Math.imul(seed ^ 0x27d4eb2f, 0x165667b1) >>> 0) || 2];
        this.gain = Number.isFinite(p.gain) ? p.gain : 1;
        this.decay = Math.exp(-1 / ((p.decayMs || 3) * 0.001 * sampleRate));
        this.fmin = p.fmin || 1200;
        this.fmax = p.fmax || 3400;
        this.glide = Math.pow(p.glide || 1.35, 1 / ((p.glideMs || 14) * 0.001 * sampleRate));
        this.tauMs = p.tauMs || 8;
        this.env = 0;
        this.gl = 0;
        this.gr = 0;
        this.voices = [];
        for (let i = 0; i < BUBBLE_VOICES; i++) this.voices.push({ a: 0, ph: 0, f: 0, top: 0, d: 0, gl: 0, gr: 0 });
        this.next = 0;
        // Events are a Poisson process: `wait` is the unit-exponential
        // distance to the next one, spent at `density / sampleRate` per
        // sample, so a changing density needs no redraw and a sample costs
        // one subtraction instead of a random draw.
        this.wait = this.exp();
        this.alive = true;
        this.port.onmessage = (event) => {
            if (event.data === 'stop') this.alive = false;
        };
    }

    // xorshift32 on stream k, as a uint32.
    u(k) {
        let x = this.s[k];
        x ^= x << 13;
        x ^= x >>> 17;
        x ^= x << 5;
        return (this.s[k] = x >>> 0);
    }

    // [0, 1) on stream k.
    r(k) {
        return this.u(k) / 4294967296;
    }

    // A unit-exponential draw on the event stream.
    exp() {
        return -Math.log(1 - this.r(2));
    }

    process(_inputs, outputs, parameters) {
        if (!this.alive) return false;
        const out = outputs[0];
        const left = out[0];
        const right = out[1] || null;
        const n = left.length;
        // A density slewing to 0 (setTargetAtTime) never quite gets there.
        const density = parameters.density[0];
        const p = density < 0.01 ? 0 : density / sampleRate;
        const g = this.gain;
        if (p === 0 && this._idle()) {
            left.fill(0);
            if (right) right.fill(0);
            return true;
        }
        if (this.kind === 'dust') {
            for (let i = 0; i < n; i++) {
                this.wait -= p;
                if (this.wait <= 0) {
                    this.wait += this.exp();
                    const amp = 0.2 + 0.8 * this.r(2);
                    const pan = this.r(2) * Math.PI / 2;
                    this.gl = amp * Math.cos(pan) * g;
                    this.gr = amp * Math.sin(pan) * g;
                    this.env = 1;
                }
                const env = this.env;
                if (env < SILENT) {
                    left[i] = 0;
                    if (right) right[i] = 0;
                    continue;
                }
                this.env = env * this.decay;
                // One draw feeds both channels: its two 16-bit halves.
                const x = this.u(0);
                left[i] = ((x & 0xffff) / 32768 - 1) * env * this.gl;
                if (right) right[i] = ((x >>> 16) / 32768 - 1) * env * this.gr;
            }
            return true;
        }
        const voices = this.voices;
        const tau = this.tauMs * 0.001 * sampleRate;
        const step = 2 * Math.PI / sampleRate;
        for (let i = 0; i < n; i++) {
            this.wait -= p;
            if (this.wait <= 0) {
                this.wait += this.exp();
                const v = voices[this.next];
                this.next = (this.next + 1) % voices.length;
                v.f = this.fmin * Math.pow(this.fmax / this.fmin, this.r(2));
                v.top = v.f * GLIDE_MAX;
                v.a = 0.25 + 0.75 * this.r(2);
                v.ph = 0;
                v.d = Math.exp(-1 / (tau * (0.6 + 0.8 * this.r(2))));
                const pan = this.r(2) * Math.PI / 2;
                v.gl = Math.cos(pan);
                v.gr = Math.sin(pan);
            }
            let l = 0;
            let r = 0;
            for (let k = 0; k < voices.length; k++) {
                const v = voices[k];
                if (v.a < VOICE_SILENT) continue;
                v.ph += step * v.f;
                if (v.f < v.top) v.f *= this.glide;
                const s = Math.sin(v.ph) * v.a;
                v.a *= v.d;
                l += s * v.gl;
                r += s * v.gr;
            }
            left[i] = l * g;
            if (right) right[i] = r * g;
        }
        return true;
    }

    // Nothing still sounding: the dust envelope and every bubble have died away.
    _idle() {
        if (this.kind === 'dust') return this.env < SILENT;
        for (let k = 0; k < this.voices.length; k++) if (this.voices[k].a >= VOICE_SILENT) return false;
        return true;
    }
}

registerProcessor('claudeville-noise', IslandNoiseProcessor);
