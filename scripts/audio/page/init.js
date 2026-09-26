// Injected before any page script (Playwright addInitScript). Three jobs:
//  1. Deterministic Math.random (mulberry32) when window.__HAR_SEED is set.
//  2. Keep the page "focused": parallel headless pages must never trip the
//     controller's blur handling through a browser-originated blur. Synthetic
//     blur events (dispatchEvent, isTrusted false) pass, so the probe can
//     drive the real window-blur path.
//  3. A capture tap: every realtime AudioContext gets a hidden recorder that
//     receives, in parallel, everything connected to ctx.destination. The
//     recorder is an AudioWorklet that timestamps chunks with the audio-clock
//     frame so markers (ctx.currentTime) map to exact sample indices; each
//     chunk also carries its main-thread arrival time so a capture can be laid
//     on the wall clock (a suspended context renders nothing, and the listener
//     hears that as silence).
(() => {
    if (window.__harInit) return;
    window.__harInit = true;

    const seed = Number(window.__HAR_SEED);
    if (Number.isFinite(seed)) {
        let a = seed >>> 0;
        Math.random = function harSeededRandom() {
            a = (a + 0x6D2B79F5) >>> 0;
            let t = a;
            t = Math.imul(t ^ (t >>> 15), t | 1);
            t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
    }

    window.addEventListener('blur', (event) => { if (event.isTrusted) event.stopImmediatePropagation(); }, true);

    const RECORDER_SRC = `
class HarRecorder extends AudioWorkletProcessor {
    constructor() {
        super();
        this.batch = 32; // render quanta per message
        this.buf = null;
        this.q = 0;
        this.first = 0;
        this.stopped = false;
        this.port.onmessage = (e) => { if (e.data === 'stop') { this.flush(); this.stopped = true; } };
    }
    flush() {
        if (!this.buf || this.q === 0) return;
        const data = this.buf.subarray(0, this.q * 256).slice();
        this.port.postMessage({ frame: this.first, data }, [data.buffer]);
        this.buf = null;
        this.q = 0;
    }
    process(inputs) {
        if (this.stopped) return false;
        const input = inputs[0] || [];
        const L = input[0];
        const R = input[1] || input[0];
        // A render quantum that does not follow the previous one means the
        // audio thread skipped frames (underrun): close the batch so the gap
        // lands at its true position and is counted.
        if (this.expect != null && currentFrame !== this.expect) {
            this.flush();
            const lost = currentFrame - this.expect;
            this.dropped = (this.dropped || 0) + Math.max(0, lost);
            this.port.postMessage({ dropped: this.dropped, at: this.expect, lost });
        }
        this.expect = currentFrame + 128;
        if (!this.buf) { this.buf = new Float32Array(this.batch * 256); this.first = currentFrame; }
        const off = this.q * 256;
        const n = 128;
        if (L) {
            for (let i = 0; i < n; i++) { this.buf[off + 2 * i] = L[i]; this.buf[off + 2 * i + 1] = R[i]; }
        } // else: silence (buffer is zero-filled)
        this.q++;
        if (this.q >= this.batch) this.flush();
        return true;
    }
}
registerProcessor('har-recorder', HarRecorder);
`;
    const recorderUrl = URL.createObjectURL(new Blob([RECORDER_SRC], { type: 'application/javascript' }));
    const origConnect = AudioNode.prototype.connect;
    const origDisconnect = AudioNode.prototype.disconnect;
    const taps = new Map();

    function tapFor(ctx) {
        let tap = taps.get(ctx);
        if (tap) return tap;
        const bus = new GainNode(ctx, { channelCount: 2, channelCountMode: 'explicit' });
        tap = { ctx, bus, chunks: [], recorder: null, ready: null, sampleRate: ctx.sampleRate };
        taps.set(ctx, tap);
        tap.ready = ctx.audioWorklet.addModule(recorderUrl).then(() => {
            const rec = new AudioWorkletNode(ctx, 'har-recorder', {
                numberOfInputs: 1,
                numberOfOutputs: 1,
                outputChannelCount: [1],
                channelCount: 2,
                channelCountMode: 'explicit',
                channelInterpretation: 'speakers',
            });
            rec.port.onmessage = (e) => {
                if (e.data.dropped != null) { tap.dropped = e.data.dropped; (tap.gapList ||= []).push([e.data.at, e.data.lost]); }
                else { e.data.wall = performance.now(); tap.chunks.push(e.data); }
            };
            const silent = new GainNode(ctx, { gain: 0 });
            origConnect.call(bus, rec);
            origConnect.call(rec, silent);
            origConnect.call(silent, ctx.destination);
            tap.recorder = rec;
        });
        return tap;
    }

    AudioNode.prototype.connect = function harConnect(dest, output, input) {
        const result = origConnect.apply(this, arguments);
        if (dest instanceof AudioDestinationNode
            && typeof AudioContext !== 'undefined'
            && this.context instanceof AudioContext) {
            origConnect.call(this, tapFor(this.context).bus, output || 0);
        }
        if (this instanceof AudioScheduledSourceNode && dest instanceof GainNode) {
            (this.__harGains ||= []).push(dest);
        }
        return result;
    };

    // Envelope-hygiene lint (HAR-4): a source that starts while the GainNode
    // it feeds still sits at its default gain of 1, with the envelope's first
    // (near-silent) setValueAtTime only later, sounds at full level until then.
    const origSetValueAtTime = AudioParam.prototype.setValueAtTime;
    AudioParam.prototype.setValueAtTime = function harSetValueAtTime(value, time) {
        const t = Number(time) || 0;
        if (!this.__harFirst || t < this.__harFirst.t) this.__harFirst = { t, v: Number(value) };
        return origSetValueAtTime.call(this, value, time);
    };
    const hazards = new Map();
    window.__harHazards = hazards;
    const checkHazard = (node, when, stack) => {
        const ctx = node.context;
        const start = Math.max(Number(when) || 0, ctx.currentTime);
        for (const gain of node.__harGains || []) {
            const first = gain.gain.__harFirst;
            if (!first || first.v > 0.01 || first.t <= start + 0.001) continue;
            if (gain.gain.value < 0.5) continue;
            const site = (stack || '').split('\n').filter(l => l.includes('/src/')).slice(0, 2).map(l => l.trim()).join(' <- ') || 'unknown';
            const entry = hazards.get(site) || { site, count: 0, maxLeadMs: 0 };
            entry.count++;
            entry.maxLeadMs = Math.max(entry.maxLeadMs, Math.round((first.t - start) * 1000));
            hazards.set(site, entry);
        }
    };
    AudioNode.prototype.disconnect = function harDisconnect(dest) {
        if (dest instanceof AudioDestinationNode) {
            const tap = taps.get(this.context);
            if (tap) { try { origDisconnect.call(this, tap.bus); } catch { /* not connected */ } }
        }
        return origDisconnect.apply(this, arguments);
    };

    // Voice accounting: every scheduled source (oscillator, buffer source,
    // constant source) records its audio-clock [start, stop] window so the
    // harness can report concurrent voices and source starts per minute.
    const voiceLog = [];
    const origStart = AudioScheduledSourceNode.prototype.start;
    const origStop = AudioScheduledSourceNode.prototype.stop;
    const logStart = (node, when) => {
        const ctx = node.context;
        if (ctx instanceof BaseAudioContext && voiceLog.length < 400000 && !node.__harVoice) {
            const entry = { s: Math.max(Number(when) || 0, ctx.currentTime), e: Infinity, k: node.constructor.name[0] };
            node.__harVoice = entry;
            voiceLog.push(entry);
        }
    };
    // `window.__harNoLint` (a timing scene on the virtual clock) skips the
    // stack capture, which would otherwise dominate a scheduler's cost.
    AudioScheduledSourceNode.prototype.start = function harStart(when = 0, ...rest) {
        logStart(this, when);
        if (!window.__harNoLint) {
            const stack = new Error().stack;
            queueMicrotask(() => checkHazard(this, when, stack));
        }
        return origStart.call(this, when, ...rest);
    };
    // AudioBufferSourceNode declares its own start(when, offset, duration).
    const origBufferStart = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function harBufferStart(when = 0, ...rest) {
        logStart(this, when);
        if (!window.__harNoLint) {
            const stack = new Error().stack;
            queueMicrotask(() => checkHazard(this, when, stack));
        }
        return origBufferStart.call(this, when, ...rest);
    };
    AudioScheduledSourceNode.prototype.stop = function harStop(when = 0) {
        const entry = this.__harVoice;
        if (entry) entry.e = Math.min(entry.e, Math.max(Number(when) || 0, this.context.currentTime));
        return origStop.call(this, when);
    };
    window.__harVoiceLog = voiceLog;

    window.__harTap = {
        taps,
        tapFor,
        // Merge every chunk of the first (or given) realtime context into one
        // interleaved Float32Array plus its first audio-clock frame.
        // `chunkTimes` lists [frame, frames, arrival ms (performance.now)] per
        // chunk, in PCM order, for wall-clock alignment.
        async collect(ctx = null) {
            const tap = ctx ? taps.get(ctx) : [...taps.values()][0];
            if (!tap) return null;
            await tap.ready;
            tap.recorder?.port.postMessage('stop');
            await new Promise(r => setTimeout(r, 250));
            const chunks = tap.chunks.sort((a, b) => a.frame - b.frame);
            if (!chunks.length) return { firstFrame: 0, frames: 0, sampleRate: tap.sampleRate, gapList: [], chunkTimes: [] };
            // Frames the audio thread never rendered (underrun skips) are not
            // zero-filled: the rendered quanta are spliced end to end and the
            // skipped spans are reported so callers can map clock → sample.
            const firstFrame = chunks[0].frame;
            const frames = chunks.reduce((n, c) => n + c.data.length / 2, 0);
            const all = new Float32Array(frames * 2);
            let off = 0;
            for (const c of chunks) { all.set(c.data, off); off += c.data.length; }
            window.__harPcm = all;
            tap.chunks = [];
            const chunkTimes = chunks.map(c => [c.frame, c.data.length / 2, c.wall]);
            return { firstFrame, frames, sampleRate: tap.sampleRate, droppedFrames: tap.dropped || 0, gapList: tap.gapList || [], chunkTimes };
        },
    };

    // Pull a slice of window.__harPcm (or a named Float32Array) as base64.
    window.__harPull = (offset, length, name = '__harPcm') => {
        const src = window[name];
        const view = new Uint8Array(src.buffer, src.byteOffset + offset * 4, Math.min(length, src.length - offset) * 4);
        let s = '';
        const step = 0x8000;
        for (let i = 0; i < view.length; i += step) s += String.fromCharCode.apply(null, view.subarray(i, i + step));
        return btoa(s);
    };
})();
