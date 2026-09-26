// The music probe (Wave 6) for page/virtual.js: every sequencer mark from
// both presets (notes, pieces, chunks, breaths, cadences, percussion,
// arrangement switches, Village starts), pins (piece, working band, voice),
// per-seat stem taps, node constructions per note and the stop lint's raw
// material (each stopped music voice's envelope automation). Everything
// here attaches through the sequencer's public surface (`observe`, `pin`,
// `seatOutputs`) plus the harness's prototype-patch pattern (scene.js
// pinSequencer): the Town band starts its first piece in the window that
// opens at its start, before any caller can reach the instance.

const vc = window.__vc;

// Node constructions on the scene context: every `create*` factory and
// every AudioNode constructor (a Proxy keeps `instanceof` intact).
const FACTORIES = [
    'createGain', 'createOscillator', 'createBufferSource', 'createBiquadFilter', 'createStereoPanner', 'createPanner', 'createDelay',
    'createWaveShaper', 'createConstantSource', 'createConvolver', 'createChannelMerger', 'createChannelSplitter', 'createDynamicsCompressor',
    'createIIRFilter',
];
const CONSTRUCTORS = [
    'GainNode', 'OscillatorNode', 'AudioBufferSourceNode', 'BiquadFilterNode', 'StereoPannerNode', 'PannerNode', 'DelayNode', 'WaveShaperNode',
    'ConstantSourceNode', 'ConvolverNode', 'ChannelMergerNode', 'ChannelSplitterNode', 'DynamicsCompressorNode', 'IIRFilterNode',
];
let counting = null;
function installNodeCounter() {
    if (counting) return counting;
    counting = { n: 0 };
    const proto = BaseAudioContext.prototype;
    for (const name of FACTORIES) {
        const orig = proto[name];
        if (typeof orig !== 'function') continue;
        proto[name] = function countedFactory(...a) {
            if (this === vc.sceneContext) counting.n++;
            return orig.apply(this, a);
        };
    }
    for (const name of CONSTRUCTORS) {
        const Orig = window[name];
        if (typeof Orig !== 'function') continue;
        window[name] = new Proxy(Orig, {
            construct(target, a, newTarget) {
                if (a[0] === vc.sceneContext) counting.n++;
                return Reflect.construct(target, a, newTarget === window[name] ? target : newTarget);
            },
        });
    }
    return counting;
}

// Automation of every AudioParam, recorded per param as { v0, events }
// (events in call order, audio seconds) for the stop lint.
let recording = false;
function installAutomationRecorder() {
    if (recording) return;
    recording = true;
    const P = AudioParam.prototype;
    const rec = (param, e) => {
        const a = param.__vcAuto || (param.__vcAuto = { v0: param.value, events: [] });
        if (a.events.length < 64) a.events.push(e);
    };
    const wrap = (name, toEvent) => {
        const orig = P[name];
        if (typeof orig !== 'function') return;
        P[name] = function recorded(...a) {
            try { rec(this, toEvent(...a)); } catch { /* never break the app */ }
            return orig.apply(this, a);
        };
    };
    wrap('setValueAtTime', (v, t) => ({ type: 'set', t: Number(t), v: Number(v) }));
    wrap('linearRampToValueAtTime', (v, t) => ({ type: 'linear', t: Number(t), v: Number(v) }));
    wrap('exponentialRampToValueAtTime', (v, t) => ({ type: 'exponential', t: Number(t), v: Number(v) }));
    wrap('setTargetAtTime', (v, t, tau) => ({ type: 'target', t: Number(t), v: Number(v), tau: Number(tau) }));
    wrap('setValueCurveAtTime', (values, t, dur) => ({ type: 'curve', t: Number(t), dur: Number(dur), values: Array.from(values, Number) }));
    wrap('cancelScheduledValues', t => ({ type: 'cancel', t: Number(t) }));
    wrap('cancelAndHoldAtTime', t => ({ type: 'cancelHold', t: Number(t) }));
}

// spec: { bgm: { piece, band, voice }, village: { piece }, seatStems: [seat],
// countNodes, stopLint }. `connectSeat(seat, node)` wires a seat's output
// into its stem pair (virtual.js owns the merger).
export async function installMusicProbe(spec, { connectSeat }) {
    const mod = await import('/src/presentation/shared/audio/music/Sequencer.js').catch(() => null);
    const clock = await import('/src/presentation/shared/audio/MusicClock.js').catch(() => null);
    const marks = [];
    const perNote = [];
    const instances = [];
    // Every MusicClock frame as published (6.5: the chords routine cues
    // are judged against), `{ source, originTime, beatSec, chords }`.
    const frames = [];
    if (clock?.MusicClock) {
        const publish = clock.MusicClock.prototype.publish;
        clock.MusicClock.prototype.publish = function recordedPublish(frame) {
            try {
                if (frames.length < 20000) frames.push({ source: frame?.source ?? null, originTime: frame?.originTime, beatSec: frame?.beatSec, until: frame?.until, chords: (frame?.chords || []).map(c => ({ time: c.time, rootPc: c.rootPc, pcs: [...(c.pcs || [])] })) });
            } catch { /* never break the app */ }
            return publish.call(this, frame);
        };
    }
    const counter = spec.countNodes ? installNodeCounter() : null;
    if (spec.stopLint) installAutomationRecorder();
    if (!mod?.Sequencer) return { marks, perNote, instances, frames, available: false };
    const proto = mod.Sequencer.prototype;
    const start = proto._start;
    let base = 0;
    proto._start = function probedStart(...a) {
        const preset = this.preset;
        instances.push(this);
        const pin = preset === 'townBand' ? spec.bgm : spec.village;
        if (pin && Object.values(pin).some(v => v != null)) this.pin?.(pin);
        this.observe?.((m) => {
            marks.push({ ...m, preset });
            if (counter && (m.kind === 'note' || m.kind === 'perc')) {
                perNote.push({ t: m.t, kind: m.kind, seat: m.seat ?? null, instrument: m.instrument ?? m.voice ?? null, nodes: counter.n - base });
                base = counter.n;
            }
        });
        const result = start.apply(this, a);
        const seats = typeof this.seatOutputs === 'function' ? this.seatOutputs() : null;
        const wanted = preset === 'townBand' ? spec.mode === 'bgm' : spec.mode !== 'bgm';
        if (seats && wanted) for (const seat of spec.seatStems || []) if (seats[seat]) connectSeat(seat, seats[seat]);
        return result;
    };
    if (counter) {
        const schedule = proto.schedule;
        proto.schedule = function countedSchedule(...a) {
            base = counter.n;
            return schedule.apply(this, a);
        };
    }
    // The director's calls the probe correlates against (6.9): workshop
    // densities and arrangement requests, stamped in audio time.
    for (const name of ['setWorkshopDensity', 'setArrangement', 'setWaiting', 'setBand', 'setVoice']) {
        const orig = proto[name];
        if (typeof orig !== 'function') continue;
        proto[name] = function recordedCall(arg, ...rest) {
            try { marks.push({ kind: `call:${name}`, t: this.engine?.now?.() ?? null, preset: this.preset, arg: JSON.parse(JSON.stringify(arg ?? null)) }); } catch { /* never break the app */ }
            return orig.call(this, arg, ...rest);
        };
    }
    return { marks, perNote, instances, frames, available: true };
}

// The stop lint's raw rows: every music source that was stopped (finite
// `e`) after `from`, with the automation of the note-owned gains it feeds
// (a GainNode within six hops whose first event is at or after the note's
// start − 50 ms: seat, group and duck gains are persistent and excluded)
// and, for a buffer source, the buffer's level at the stop offset re its
// loudest 10 ms (dB).
const bufferPeak = new WeakMap();
function rmsAt(data, i, n) {
    let e = 0;
    const a = Math.max(0, i);
    const b = Math.min(data.length, i + n);
    for (let k = a; k < b; k++) e += data[k] * data[k];
    return b > a ? Math.sqrt(e / (b - a)) : 0;
}
function bufferLevelDb(buffer, offsetSec) {
    const data = buffer.getChannelData(0);
    const n = Math.max(1, Math.round(0.01 * buffer.sampleRate));
    let peak = bufferPeak.get(buffer);
    if (peak == null) {
        peak = 0;
        for (let i = 0; i < data.length; i += n >> 1) peak = Math.max(peak, rmsAt(data, i, n));
        bufferPeak.set(buffer, peak);
    }
    const at = Math.round(offsetSec * buffer.sampleRate);
    if (at >= data.length) return -Infinity;
    const v = rmsAt(data, at, n);
    return peak > 0 && v > 0 ? 20 * Math.log10(v / peak) : -Infinity;
}

export function stopLintRows(starts, reachesMusic, { from = 0, limit = 4000 } = {}) {
    const rows = [];
    for (const s of starts) {
        if (rows.length >= limit) break;
        if (!(s.t >= from) || !Number.isFinite(s.e) || !s.node || !reachesMusic(s.node)) continue;
        const gains = [];
        const seen = new Set();
        let frontier = [s.node];
        for (let depth = 0; depth < 6 && frontier.length; depth++) {
            const next = [];
            for (const node of frontier) {
                for (const d of vc.audio.edges.get(node) || []) {
                    if (seen.has(d)) continue;
                    seen.add(d);
                    next.push(d);
                    const auto = d instanceof GainNode ? d.gain.__vcAuto : null;
                    if (auto && auto.events.length && auto.events[0].t >= s.t - 0.05) gains.push({ v0: auto.v0, events: auto.events });
                }
            }
            frontier = next;
        }
        let bufDb = null;
        if (s.node instanceof AudioBufferSourceNode && s.node.buffer) {
            bufDb = s.node.loop ? null : bufferLevelDb(s.node.buffer, (s.off || 0) + (s.e - s.t) * (s.rate || 1));
            if (bufDb === -Infinity) bufDb = -999;
        }
        rows.push({ t: s.t, e: s.e, k: s.k, bufDb, gains });
    }
    return rows;
}
