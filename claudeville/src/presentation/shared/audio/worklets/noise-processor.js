// Island noise worklet (AMB-3): the two rain textures that need a live
// event process — `dust` (sparse ticks) and `bubbles` (Minnaert plinks
// that glide up) — at `density` events per second (k-rate AudioParam).
// Every continuous colour comes from the engine's buffer pool instead.
// Seeded per node (processorOptions.seed); zero allocations in process().
// Loaded by AudioEngine with the limiter; without AudioWorklet the rain
// layer keeps its per-drop voices.

const BUBBLE_VOICES = 8;

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
        for (let i = 0; i < BUBBLE_VOICES; i++) this.voices.push({ a: 0, ph: 0, f: 0, d: 0, gl: 0, gr: 0 });
        this.next = 0;
        this.alive = true;
        this.port.onmessage = (event) => {
            if (event.data === 'stop') this.alive = false;
        };
    }

    // xorshift32 on stream k, in [0, 1).
    r(k) {
        let x = this.s[k];
        x ^= x << 13;
        x ^= x >>> 17;
        x ^= x << 5;
        this.s[k] = x >>> 0;
        return this.s[k] / 4294967296;
    }

    process(_inputs, outputs, parameters) {
        if (!this.alive) return false;
        const out = outputs[0];
        const left = out[0];
        const right = out[1] || null;
        const n = left.length;
        const p = parameters.density[0] / sampleRate;
        const g = this.gain;
        if (this.kind === 'dust') {
            for (let i = 0; i < n; i++) {
                if (this.r(2) < p) {
                    const amp = 0.2 + 0.8 * this.r(2);
                    const pan = this.r(2) * Math.PI / 2;
                    this.gl = amp * Math.cos(pan);
                    this.gr = amp * Math.sin(pan);
                    this.env = 1;
                }
                this.env *= this.decay;
                left[i] = (this.r(0) * 2 - 1) * this.env * this.gl * g;
                if (right) right[i] = (this.r(1) * 2 - 1) * this.env * this.gr * g;
            }
            return true;
        }
        const voices = this.voices;
        const tau = this.tauMs * 0.001 * sampleRate;
        for (let i = 0; i < n; i++) {
            if (this.r(2) < p) {
                const v = voices[this.next];
                this.next = (this.next + 1) % voices.length;
                v.f = this.fmin * Math.pow(this.fmax / this.fmin, this.r(2));
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
                if (v.a < 1e-4) continue;
                v.ph += 2 * Math.PI * v.f / sampleRate;
                v.f *= this.glide;
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
}

registerProcessor('claudeville-noise', IslandNoiseProcessor);
