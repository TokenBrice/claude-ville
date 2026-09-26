// Loudness meter accumulator (ENG-10). Exists only while the debug meters
// are enabled; the engine loads this module on the first enable, never at boot.
//
// Inputs come in pairs per tap: input 2k is the tap after the engine's
// K-weighting IIR filters, input 2k + 1 is the same tap unfiltered (sample
// peak must be read before weighting). Every input is explicit stereo, so a
// mono bus is up-mixed to L = R exactly as the destination hears it.
//
// Every ~100 ms it posts one Float64Array:
//   [samples, then per tap: sumSquaresL, sumSquaresR, samplePeak]
// The main thread turns those blocks into momentary / short-term / gated
// integrated loudness. process() allocates nothing; the posted array is the
// preallocated one (postMessage copies it).

const BLOCK_SEC = 0.1;
const FIELDS = 3;

class MeterProcessor extends AudioWorkletProcessor {
    constructor(options) {
        super();
        this._taps = Math.max(0, options?.processorOptions?.taps | 0);
        this._blockLen = Math.max(1, Math.round(sampleRate * BLOCK_SEC));
        this._block = new Float64Array(1 + this._taps * FIELDS);
        this._samples = 0;
        this._active = true;
        this.port.onmessage = (event) => {
            if (event.data === 'stop') this._active = false;
        };
    }

    process(inputs) {
        // Returning false lets the node be collected once the engine drops it.
        if (!this._active) return false;
        const block = this._block;
        let frames = 128;
        for (let tap = 0; tap < this._taps; tap++) {
            const base = 1 + tap * FIELDS;
            const weighted = inputs[2 * tap];
            // An input with no active connection has zero channels: silence.
            if (weighted && weighted.length) {
                frames = weighted[0].length;
                const left = weighted[0];
                const right = weighted.length > 1 ? weighted[1] : left;
                let sumL = 0;
                let sumR = 0;
                for (let i = 0; i < left.length; i++) {
                    sumL += left[i] * left[i];
                    sumR += right[i] * right[i];
                }
                block[base] += sumL;
                block[base + 1] += sumR;
            }
            const raw = inputs[2 * tap + 1];
            if (raw && raw.length) {
                let peak = block[base + 2];
                for (let c = 0; c < raw.length; c++) {
                    const channel = raw[c];
                    for (let i = 0; i < channel.length; i++) {
                        const a = channel[i] < 0 ? -channel[i] : channel[i];
                        if (a > peak) peak = a;
                    }
                }
                block[base + 2] = peak;
            }
        }
        this._samples += frames;
        if (this._samples >= this._blockLen) {
            block[0] = this._samples;
            this.port.postMessage(block);
            block.fill(0);
            this._samples = 0;
        }
        return true;
    }
}

registerProcessor('claudeville-meter', MeterProcessor);
