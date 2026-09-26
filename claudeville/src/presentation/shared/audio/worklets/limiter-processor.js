// Program limiter (MIX-1, plan S3): stereo-linked, 2.5 ms lookahead, a
// sample ceiling from processorOptions (the engine passes Loudness.js
// LIMITER_CEILING_DBFS, −1.5 dBFS), instant attack, 120 ms one-pole
// release. The engine loads this module in ensureContext before the graph
// exists; without AudioWorklet it falls back to a DynamicsCompressor + tanh
// WaveShaper.
//
// Per sample: the gain that would bring the louder channel to the ceiling
// (1 when under it) enters a monotonic deque that yields the running minimum
// over the last L + 2 samples; that minimum, released by a one-pole, is box
// averaged over the last L + 1 samples. The audio is delayed by L + 1
// samples, so every value in the box has the delayed sample inside its
// minimum window: the applied gain is at or under that sample's target,
// nothing passes the ceiling, and the gain moves smoothly into each peak.
// Below the ceiling the gain is exactly 1 (unity static gain).
//
// process() allocates nothing. While the engine's meters are on
// (`port.postMessage({ report: true })`) it posts, about once a second, a
// preallocated [minGainDb over the window, frames with > 1 dB of reduction,
// frames in the window].

const REPORT_SEC = 1;
const GR_1DB = Math.pow(10, -1 / 20);
const RELEASED_SNAP = 1 - 1e-7;

class LimiterProcessor extends AudioWorkletProcessor {
    constructor(options) {
        super();
        const o = options?.processorOptions || {};
        this.ceiling = Math.pow(10, (o.ceilingDb ?? -1.5) / 20);
        const lookahead = Math.max(1, Math.round((o.lookaheadMs ?? 2.5) * sampleRate / 1000));
        const n = lookahead + 1;
        this.n = n;
        this.invN = 1 / n;
        this.releaseK = 1 - Math.exp(-1 / ((o.releaseMs ?? 120) * sampleRate / 1000));
        this.delayL = new Float32Array(n);
        this.delayR = new Float32Array(n);
        this.box = new Float64Array(n).fill(1);
        this.boxSum = n;
        this.write = 0;
        // Deque of (target, sample index) with increasing targets; one push
        // before its pop holds at most L + 3 entries.
        this.cap = n + 3;
        this.dequeValue = new Float64Array(this.cap);
        this.dequeIndex = new Float64Array(this.cap);
        this.head = 0;
        this.tail = 0;
        this.count = 0;
        this.index = 0;
        this.released = 1;
        this.sinceResum = 0;

        this.reporting = false;
        this.report = new Float64Array(3);
        this.windowMin = 1;
        this.windowGrFrames = 0;
        this.windowFrames = 0;
        this.port.onmessage = (event) => {
            const report = Boolean(event.data?.report);
            if (report && !this.reporting) this._resetWindow();
            this.reporting = report;
        };
    }

    _resetWindow() {
        this.windowMin = 1;
        this.windowGrFrames = 0;
        this.windowFrames = 0;
    }

    process(inputs, outputs) {
        const input = inputs[0];
        const output = outputs[0];
        const inL = input && input.length ? input[0] : null;
        const inR = input && input.length > 1 ? input[1] : inL;
        const outL = output[0];
        const outR = output.length > 1 ? output[1] : null;
        const frames = outL.length;
        const n = this.n;
        const invN = this.invN;
        const cap = this.cap;
        const ceiling = this.ceiling;
        const releaseK = this.releaseK;
        const box = this.box;
        const delayL = this.delayL;
        const delayR = this.delayR;
        const dequeValue = this.dequeValue;
        const dequeIndex = this.dequeIndex;
        let head = this.head;
        let tail = this.tail;
        let count = this.count;
        let index = this.index;
        let released = this.released;
        let boxSum = this.boxSum;
        let write = this.write;
        let windowMin = this.windowMin;
        let windowGrFrames = this.windowGrFrames;

        // Fully released and the block stays under the ceiling: every gain
        // is exactly 1, so only the delay line moves (the usual case).
        let quiet = released === 1 && boxSum === n;
        for (let i = 0; quiet && i < frames; i++) {
            const a = inL ? inL[i] : 0;
            const b = inR ? inR[i] : 0;
            if (a > ceiling || -a > ceiling || b > ceiling || -b > ceiling) quiet = false;
        }
        if (quiet) {
            for (let i = 0; i < frames; i++) {
                outL[i] = delayL[write];
                if (outR) outR[i] = delayR[write];
                delayL[write] = inL ? inL[i] : 0;
                delayR[write] = inR ? inR[i] : 0;
                write = write + 1 === n ? 0 : write + 1;
            }
            index += frames;
            dequeValue[0] = 1;
            dequeIndex[0] = index - 1;
            head = 0;
            tail = 1;
            count = 1;
        }

        for (let i = 0; !quiet && i < frames; i++) {
            const a = inL ? inL[i] : 0;
            const b = inR ? inR[i] : 0;
            const absA = a < 0 ? -a : a;
            const absB = b < 0 ? -b : b;
            const peak = absA > absB ? absA : absB;
            const target = peak > ceiling ? ceiling / peak : 1;

            while (count > 0) {
                const back = tail === 0 ? cap - 1 : tail - 1;
                if (dequeValue[back] < target) break;
                tail = back;
                count--;
            }
            dequeValue[tail] = target;
            dequeIndex[tail] = index;
            tail = tail + 1 === cap ? 0 : tail + 1;
            count++;
            const oldest = index - n - 1;
            while (dequeIndex[head] <= oldest) {
                head = head + 1 === cap ? 0 : head + 1;
                count--;
            }
            const min = dequeValue[head];
            released = min < released ? min : released + (min - released) * releaseK;
            // Snap the tail of the release so it lands on exactly 1.
            if (released > RELEASED_SNAP) released = 1;

            boxSum += released - box[write];
            box[write] = released;
            const avg = boxSum * invN;
            const gain = avg < 1 ? avg : 1;
            const delayedL = delayL[write];
            const delayedR = delayR[write];
            delayL[write] = a;
            delayR[write] = b;
            write = write + 1 === n ? 0 : write + 1;
            index++;

            outL[i] = delayedL * gain;
            if (outR) outR[i] = delayedR * gain;
            if (gain < windowMin) windowMin = gain;
            if (gain < GR_1DB) windowGrFrames++;
        }

        this.head = head;
        this.tail = tail;
        this.count = count;
        this.index = index;
        this.released = released;
        this.boxSum = boxSum;
        this.write = write;

        // Re-sum the box once a second so float drift never accumulates.
        this.sinceResum += frames;
        if (this.sinceResum >= sampleRate) {
            this.sinceResum = 0;
            let sum = 0;
            for (let k = 0; k < n; k++) sum += box[k];
            this.boxSum = sum;
        }

        this.windowMin = windowMin;
        this.windowGrFrames = windowGrFrames;
        this.windowFrames += frames;
        if (this.reporting && this.windowFrames >= sampleRate * REPORT_SEC) {
            this.report[0] = 20 * Math.log10(this.windowMin);
            this.report[1] = this.windowGrFrames;
            this.report[2] = this.windowFrames;
            this.port.postMessage(this.report);
            this._resetWindow();
        } else if (!this.reporting && this.windowFrames >= sampleRate * REPORT_SEC) {
            this._resetWindow();
        }
        return true;
    }
}

registerProcessor('claudeville-limiter', LimiterProcessor);
