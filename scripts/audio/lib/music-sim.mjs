// Headless music: the shipped Sequencer (and the Village's OccasionClock)
// driven on a stepped clock in Node against a node-less fake audio graph,
// so hours of the band compile in seconds (MUS-18: "compile N hours of both
// schedulers with seeded RNG"). What it yields is the sequencer's own marks
// — every note, rendition, visit, breath, cadence and percussion hit — and
// the MusicClock frames; no audio. Levels, stems and nodes are measured on
// the virtual clock in the browser (page/music.js); this is the score.
//
// The Transport is modelled as in scripts/tests/audio-sequencer.test.mjs: a
// tick every 0.25 s hands the sequencer [cursor, now + 1.5 s). The Village
// glue mirrors AudioDirector._syncMusic: decide → release or play → refused
// or started.
import { Sequencer } from '../../../claudeville/src/presentation/shared/audio/music/Sequencer.js';
import { MusicClock } from '../../../claudeville/src/presentation/shared/audio/MusicClock.js';
import { OccasionClock } from '../../../claudeville/src/presentation/shared/audio/OccasionClock.js';
import { rngStream, setRngSeed } from '../../../claudeville/src/presentation/shared/audio/Rng.js';
import { FRAGMENTS, OCCASIONS } from '../../../claudeville/src/presentation/shared/audio/bgm/BgmSongbook.js';
import { arrangementKeyframeAt } from '../../../claudeville/src/presentation/shared/audio/DayArc.js';
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

export function makeSimEngine() {
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

// A sequencer started as its director starts it; every mark collected.
export function startSim(preset, { seed = 24301, voice = 'isle', phase = 'day', keyframe = 'noon', weather = 'clear', season = 'summer', band = 2 } = {}) {
    setRngSeed(seed);
    const { engine, ctx } = makeSimEngine();
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
export function drive(seq, ctx, { seconds, step = 0.25, horizon = 1.5, onTick = null }) {
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
    const sim = startSim('townBand', { seed, voice, band: 2 });
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

// 6.6: the Village's working day through the real OccasionClock and the
// Village sequencer, the director's glue (AudioDirector._syncMusic) on a
// 1 Hz tick. `plan(minute)` → { working, raining, resting, oldestWaitMs,
// urgent } for each minute of the day; the atmosphere follows the clock
// (phase, progress and keyframe from `phaseAt(minuteOfDay)`).
// → { marks, frames, spans (decided starts with reasons), decisions,
//     inputs: per-second { t, input } samples (every 10 s) }
export function villageDay({ fromMinute = 9 * 60, toMinute = 18 * 60, seed = 24301, plan, phaseAt, ledger = null, epochMs = new Date(2026, 6, 15, 0, 0, 0).getTime() }) {
    const sim = startSim('village', { seed, band: 2 });
    const clock = new OccasionClock({ rng: rngStream('music.village.occasion'), ledger, fragments: FRAGMENTS, occasions: OCCASIONS });
    const decisions = [];
    const inputs = [];
    const urgentAt = [];
    let lastPhase = null;
    const t0 = sim.ctx.currentTime;
    const msAt = t => epochMs + fromMinute * 60e3 + (t - t0) * 1000;
    clock.noteEnable(msAt(t0));
    drive(sim.seq, sim.ctx, {
        seconds: (toMinute - fromMinute) * 60,
        onTick(now) {
            const minuteOfDay = fromMinute + (now - t0) / 60;
            const ph = phaseAt(minuteOfDay);
            const p = plan(minuteOfDay);
            const ms = msAt(now);
            if (p.urgent && !urgentAt.some(u => Math.abs(u - now) < 30)) {
                urgentAt.push(now);
                clock.noteUrgent(ms);
            }
            if (ph.phase !== lastPhase) { sim.seq.setPhase(ph.phase); lastPhase = ph.phase; }
            const keyframe = arrangementKeyframeAt({ minuteOfDay });
            sim.seq.setArrangement({ weather: p.raining ? 'rain' : 'clear', season: 'summer', keyframe });
            sim.seq.setBand(bandForWorking(p.working));
            sim.seq.setWaiting((p.oldestWaitMs ?? 0) > 0);
            const input = {
                phase: ph.phase, phaseProgress: ph.progress, minuteOfDay, keyframe,
                working: p.working, resting: Boolean(p.resting), raining: Boolean(p.raining), oldestWaitMs: p.oldestWaitMs ?? 0,
            };
            if (Math.round(now - t0) % 10 === 0) inputs.push({ t: now, ...input });
            const decision = clock.decide(ms, { ...input, quiet: false, playing: Boolean(sim.seq.busy) });
            if (!decision) return;
            decisions.push({ t: now, ...decision });
            if (decision.action === 'stop') {
                sim.seq.release({ reason: decision.reason, fadeSec: 0.4 });
                return;
            }
            const result = decision.kind === 'fragment'
                ? sim.seq.playFragment(decision.cellRef, { reason: decision.reason })
                : sim.seq.playOccasion(decision.occasion, { reason: decision.reason });
            if (!result?.ok) { clock.refused(ms); return; }
            clock.started(ms, decision, { startsAtMs: ms + (result.startsAt - now) * 1000, endsAtMs: ms + (result.endsAt - now) * 1000 });
        },
    });
    sim.seq.stop();
    return { marks: sim.marks, frames: sim.frames, decisions, inputs, urgentAt, t0, seconds: (toMinute - fromMinute) * 60, fromMinute };
}
