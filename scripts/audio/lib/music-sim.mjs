// Headless music: the shipped Sequencer driven on a stepped clock in Node
// against a node-less fake audio graph, so hours of the Town band compile
// in seconds (MUS-18: "compile N hours of the scheduler with seeded RNG").
// What it yields is the sequencer's own marks — every note, rendition,
// visit, breath, cadence and percussion hit — and the MusicClock frames; no
// audio. Levels, stems and nodes are measured on the virtual clock in the
// browser (page/music.js); this is the score.
//
// The Transport is modelled as in scripts/tests/audio-sequencer.test.mjs: a
// tick every 0.25 s hands the sequencer [cursor, now + 1.5 s).
import { Sequencer } from '../../../claudeville/src/presentation/shared/audio/music/Sequencer.js';
import { MusicClock } from '../../../claudeville/src/presentation/shared/audio/MusicClock.js';
import { setRngSeed } from '../../../claudeville/src/presentation/shared/audio/Rng.js';
import { bandForWorking } from '../../../claudeville/src/presentation/shared/audio/BgmDirector.js';

class FakeParam {
    constructor(value = 1) { this.value = value; this.defaultValue = value; }
    setValueAtTime() { return this; }
    setTargetAtTime() { return this; }
    linearRampToValueAtTime() { return this; }
    exponentialRampToValueAtTime() { return this; }
    setValueCurveAtTime() { return this; }
    cancelScheduledValues() { return this; }
    cancelAndHoldAtTime() { return this; }
}
class FakeNode {
    constructor(ctx) {
        this.context = ctx;
        for (const name of ['gain', 'pan', 'frequency', 'detune', 'Q', 'playbackRate', 'offset', 'delayTime']) this[name] = new FakeParam(1);
    }
    connect(node) { return node; }
    disconnect() {}
    setPeriodicWave() {}
    start() {}
    stop() {}
    addEventListener() {}
}

function makeSimEngine() {
    const ctx = {
        currentTime: 0,
        sampleRate: 48000,
        state: 'running',
        createPeriodicWave: () => ({}),
        createBuffer: (channels, length, sampleRate) => {
            const data = Array.from({ length: channels }, () => new Float32Array(length));
            return { length, sampleRate, numberOfChannels: channels, duration: length / sampleRate, getChannelData: c => data[c] };
        },
    };
    for (const f of ['createGain', 'createStereoPanner', 'createBiquadFilter', 'createOscillator', 'createBufferSource', 'createDelay', 'createWaveShaper', 'createConstantSource', 'createConvolver', 'createChannelMerger', 'createChannelSplitter']) {
        ctx[f] = () => new FakeNode(ctx);
    }
    const node = () => new FakeNode(ctx);
    const engine = {
        context: ctx,
        musicClock: new MusicClock(),
        transport: { register(proc) { proc.rearm?.(ctx.currentTime); return proc; }, unregister() {} },
        now: () => ctx.currentTime,
        groupInput: node,
        stopGroup: () => ctx.currentTime,
        airSendFrom: node,
        wave: () => null,
        noiseSource: node,
        bank: null,
    };
    return { engine, ctx };
}

// The Town band's sequencer started as its director starts it; every mark
// collected.
function startSim({ seed = 24301, voice = 'isle', phase = 'day', keyframe = 'noon', weather = 'clear', season = 'summer', band = 2 } = {}) {
    setRngSeed(seed);
    const { engine, ctx } = makeSimEngine();
    const preset = 'townBand';
    const seq = new Sequencer(engine, { preset, voice });
    const marks = [];
    const frames = [];
    const publish = engine.musicClock.publish.bind(engine.musicClock);
    engine.musicClock.publish = (frame) => { frames.push({ originTime: frame.originTime, beatSec: frame.beatSec, chords: frame.chords.map(c => ({ time: c.time, rootPc: c.rootPc, pcs: [...c.pcs] })) }); return publish(frame); };
    seq.observe(mark => marks.push({ ...mark, preset }));
    seq.setPhase(phase);
    seq.setArrangement({ weather, season, keyframe });
    seq.setBand(band);
    seq.start();
    seq.setLevel(1, 0.1);
    return { seq, ctx, engine, marks, frames };
}

// The Transport: a tick every `step` s hands [cursor, now + horizon).
function drive(seq, ctx, { seconds, step = 0.25, horizon = 1.5, onTick = null }) {
    let cursor = ctx.currentTime;
    const end = ctx.currentTime + seconds;
    let tick = 0;
    for (let now = ctx.currentTime; now < end; now = ctx.currentTime + step) {
        ctx.currentTime = now;
        if (onTick && tick++ % Math.round(1 / step) === 0) onTick(now);
        seq.schedule(Math.max(cursor, now), now + horizon);
        cursor = now + horizon;
    }
}

function lcg(seed) {
    let s = seed >>> 0;
    return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296;
}

// 6.5 / 6.7: `hours` of the Town band by day. Every 2–6 min the working
// count and each building's percussion density move (a seeded walk), and a
// wait opens now and then (the waiting cadence) and is answered 2–8 min
// later, as a working day does. → { marks, frames, seconds }
export function townBandHours({ hours = 8, seed = 24301, voice = 'isle' } = {}) {
    const sim = startSim({ seed, voice, band: 2 });
    const r = lcg(seed ^ 0x5eed);
    const buildings = ['forge', 'archive', 'harbor', 'taskboard', 'observatory', 'portal', 'command', 'mine'];
    let nextChange = 0;
    let waitUntil = -1;
    let nextWait = 600 + 1200 * r();
    drive(sim.seq, sim.ctx, {
        seconds: hours * 3600,
        onTick(now) {
            if (now >= nextChange) {
                const working = Math.floor(16 * r());
                sim.seq.setBand(bandForWorking(working));
                const dens = {};
                for (const b of buildings) if (r() < Math.min(1, working / 6)) dens[b] = 0.3 + 0.7 * r();
                sim.seq.setWorkshopDensity(dens);
                nextChange = now + 120 + 240 * r();
            }
            if (waitUntil < 0 && now >= nextWait) { sim.seq.setWaiting(true); waitUntil = now + 120 + 360 * r(); }
            if (waitUntil >= 0 && now >= waitUntil) { sim.seq.setWaiting(false); waitUntil = -1; nextWait = now + 900 + 1800 * r(); }
        },
    });
    sim.seq.stop();
    return { marks: sim.marks, frames: sim.frames, seconds: hours * 3600 };
}
