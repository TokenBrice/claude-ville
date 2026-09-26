// The virtual-clock renderer (HAR-1). Renders the SHIPPED controller and
// directors on an OfflineAudioContext while page/virtual-clock.js steps every
// timer the audio code reads in lock-step with the render: two renders with
// one seed are sample-identical, and a minute of village renders in seconds.
//
// How: `window.AudioContext` is replaced by a factory that hands the engine
// one prepared OfflineAudioContext, whose `state`, `resume`, `suspend` and
// `close` are shimmed (an offline context cannot resume before rendering), so
// the real AmbientAudioController enables exactly as a click would: the
// engine's ensureContext loads its worklets (awaited by the clock) and builds
// the graph. Rendering then suspends every `stepFrames` (512 = 10.7 ms); each
// suspension advances the virtual clock to that audio time and fires the
// timers due by then before resuming. Suspension of the scene context itself
// (a hidden tab) is not modelled: the away/resume checks stay on the realtime
// app path.
//
// Stems (HAR-5) ride extra destination channels: channels 0–1 carry the
// program, and each requested tap adds a stereo pair through a channel
// merger, so every stem is sample-aligned with the program.
import { AmbientAudioController } from '/src/presentation/shared/AmbientAudioController.js';
import { eventBus } from '/src/domain/events/DomainEvent.js';
import { AudioEngine } from '/src/presentation/shared/audio/AudioEngine.js';
import { cueScoreDiagnostics, scheduleAccent } from '/src/presentation/shared/audio/CueScore.js';
import { PROGRAM_TRIM_DB } from '/src/presentation/shared/audio/Loudness.js';
import { PIECES } from '/src/presentation/shared/audio/bgm/BgmSongbook.js';
import {
    LAYERS, atmosphereFor, atmosphereSummary, makeMarker, makeWorld, plain, runAction, seedSoundStorage,
} from './scene.js';

const vc = window.__vc;
if (!vc) throw new Error('virtual.js needs page/virtual-clock.js as an init script');
const realSleep = ms => new Promise(r => vc.real.setTimeout(r, ms));
const offline = OfflineAudioContext.prototype;
const SETUP_LIMIT_MS = 20000;

// Stem taps: world/work/music post-duck (what each bus adds to the program
// sum), the cue sum before its trim, and both sides of the limiter.
export const STEM_SOURCES = {
    world: engine => engine._busOut('world'),
    work: engine => engine._busOut('work'),
    music: engine => engine._busOut('music'),
    cue: engine => engine.busInput('cue'),
    limiterIn: engine => engine._limiterIn,
    limiterOut: engine => engine._limiterOut,
};

function sceneContext({ seconds, stems, sampleRate }) {
    const ctx = new OfflineAudioContext({
        numberOfChannels: 2 + 2 * stems.length,
        length: Math.ceil(seconds * sampleRate),
        sampleRate,
    });
    vc.sceneContext = ctx;
    let state = 'suspended';
    const setState = (next) => {
        if (state === next || state === 'closed') return;
        state = next;
        ctx.dispatchEvent(new Event('statechange'));
    };
    // The render's own running/suspended transitions are the harness's, not
    // the app's: keep them from any statechange listener the app adds later.
    ctx.addEventListener('statechange', (event) => { if (event.isTrusted) event.stopImmediatePropagation(); });
    Object.defineProperty(ctx, 'state', { configurable: true, get: () => state });
    ctx.resume = () => { setState('running'); return Promise.resolve(); };
    ctx.suspend = () => { setState('suspended'); return Promise.resolve(); };
    ctx.close = () => { setState('closed'); return Promise.resolve(); };
    let handed = false;
    function VirtualAudioContext() {
        if (handed) throw new Error('virtual clock: the scene has one AudioContext');
        handed = true;
        return ctx;
    }
    window.AudioContext = VirtualAudioContext;
    window.webkitAudioContext = VirtualAudioContext;
    return ctx;
}

function attachStems(ctx, engine, stems) {
    if (!stems.length) return;
    const merger = ctx.createChannelMerger(ctx.destination.channelCount);
    stems.forEach((name, i) => {
        const pick = STEM_SOURCES[name];
        if (!pick) throw new Error(`unknown stem ${name}`);
        const source = pick(engine);
        if (!source) throw new Error(`the engine exposes no ${name} tap`);
        // A mono source must reach both channels of its pair.
        const up = new GainNode(ctx, { channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'speakers' });
        const split = ctx.createChannelSplitter(2);
        source.connect(up).connect(split);
        split.connect(merger, 0, 2 + 2 * i);
        split.connect(merger, 1, 3 + 2 * i);
    });
    merger.connect(ctx.destination);
}

// Renders the context with the clock stepping; resolves the AudioBuffer.
async function renderStepped(ctx, { perfBase, stepFrames }) {
    const sr = ctx.sampleRate;
    let k = 1;
    let failure = null;
    const arm = () => {
        const frame = k * stepFrames;
        if (frame >= ctx.length) return;
        offline.suspend.call(ctx, frame / sr).then(async () => {
            try {
                await vc.advanceTo(perfBase + (frame / sr) * 1000);
                k++;
                arm();
            } catch (err) {
                failure ||= err;
            }
            offline.resume.call(ctx);
        }, (err) => { failure ||= err; });
    };
    await vc.advanceTo(perfBase);
    arm();
    const buffer = await offline.startRendering.call(ctx);
    if (failure) throw failure;
    return buffer;
}

// The rendered channels stay in the AudioBuffer; `stage(name)` interleaves
// one stereo pair at a time into window.__vcStage for the Node side to pull,
// so a long multi-stem scene never holds two copies of every stem.
let rendered = null;
function publishPcm(buffer, stems) {
    const names = ['program', ...stems];
    rendered = { buffer, names };
    return names;
}

export function stage(name) {
    const i = rendered?.names.indexOf(name) ?? -1;
    if (i < 0) throw new Error(`no rendered channel pair ${name}`);
    const L = rendered.buffer.getChannelData(2 * i);
    const R = rendered.buffer.getChannelData(2 * i + 1);
    const pcm = new Float32Array(L.length * 2);
    for (let k = 0; k < L.length; k++) { pcm[2 * k] = L[k]; pcm[2 * k + 1] = R[k]; }
    window.__vcStage = pcm;
    return L.length;
}

// Wait (on the virtual clock, which may run ahead of the not-yet-started
// render during setup) until `ready()` holds.
async function pumpUntil(ready, what) {
    const start = vc.now;
    while (!ready()) {
        if (vc.now - start > SETUP_LIMIT_MS) throw new Error(`virtual clock: ${what} did not happen within ${SETUP_LIMIT_MS} ms`);
        await vc.advanceTo(vc.now + 5);
        await realSleep(0);
    }
}

// spec: { name, mode, volumeStep, layerSteps, world:{counts},
//         atmosphere:{phase,progress,weather,hour}, bgm:{piece}, warmup, seconds,
//         actions:[scene.js runAction | {atmosphere} | {accent:{kind, leadMs}}, …],
//         stems:[STEM_SOURCES keys], stepFrames, noWorklets, sampleRate }
// Action `at` is seconds after warmup. Every returned time is audio time in
// seconds from the start of the render.
export async function runVirtual(spec) {
    const sampleRate = spec.sampleRate || 48000;
    const stems = spec.stems || [];
    const warmup = spec.warmup ?? 0;
    const total = warmup + spec.seconds;
    if (spec.noWorklets) globalThis.__claudevilleAudioNoWorklets = true;
    const ctx = sceneContext({ seconds: total, stems, sampleRate });

    seedSoundStorage(spec);
    const world = makeWorld(spec.world);
    let { snapshot, hour } = atmosphereFor(spec.atmosphere);
    eventBus.emit('atmosphere:updated', snapshot);
    const pump = setInterval(() => eventBus.emit('atmosphere:updated', snapshot), 400);

    const log = { cues: [], scheduled: [], ducks: [], accents: [], levels: [] };
    let controller = null;
    const kitOf = () => controller?.cues?.kit ?? null;
    eventBus.on('audio:cue-played', (p) => {
        log.cues.push({ t: ctx.currentTime, kind: p?.kind ?? null, agentId: p?.agentId ?? null, label: p?.label ?? null });
        const level = kitOf()?.lastLevel;
        if (level) log.levels.push({ t: ctx.currentTime, kind: p?.kind ?? null, ...plain(level) });
    });
    eventBus.on('audio:cue-scheduled', (p) => {
        log.scheduled.push({ t: ctx.currentTime, kind: p?.kind ?? null, agentId: p?.agentId ?? null, silent: Boolean(p?.silent), notesMs: (p?.notes || []).map(n => n.atMs) });
    });

    controller = new AmbientAudioController({ world });
    controller.activateFromUser(true);
    await pumpUntil(() => controller.isRunning(), 'the enable');
    const engine = controller.engine;
    const perfBase = vc.now - ctx.currentTime * 1000;

    // Note-timed ducks (1.3): every window the engine is asked for, and when
    // its cue cancelled it.
    const duck = engine.duck.bind(engine);
    engine.duck = (opts = {}) => {
        const entry = { at: ctx.currentTime, from: opts.from, until: opts.until, attack: opts.attack, release: opts.release, depths: { ...(opts.depths || {}) }, cancelledAt: null };
        log.ducks.push(entry);
        const token = duck(opts);
        if (token && typeof token.cancel === 'function') {
            const cancel = token.cancel.bind(token);
            try {
                token.cancel = () => { if (entry.cancelledAt == null) entry.cancelledAt = ctx.currentTime; return cancel(); };
            } catch { /* frozen token: cancellations go unrecorded */ }
        }
        return token;
    };
    attachStems(ctx, engine, stems);

    if (spec.bgm?.piece) {
        const only = PIECES.filter(p => p.name === spec.bgm.piece);
        if (!only.length) throw new Error(`unknown BGM piece ${spec.bgm.piece}`);
        const player = controller.directors?.bgm?.player;
        if (player) player._playlist = () => only;
    }
    if (spec.isolate) {
        for (const name of LAYERS) if (name !== spec.isolate) controller.director.forceLayer(name, 0, 1e9);
    }

    const { markers, mark } = makeMarker(() => ctx);
    const stateLog = [];
    setInterval(() => {
        const snap = window.__claudevilleAudio?.();
        if (!snap) return;
        stateLog.push(plain({ t: ctx.currentTime, mode: snap.mode, state: snap.state, running: snap.running, levels: snap.levels, nowPlaying: snap.nowPlaying }));
    }, 1000);
    const perfAt = sec => perfBase + sec * 1000;
    setTimeout(() => mark('rec-start'), Math.max(0, perfAt(warmup) - vc.now));
    for (const action of spec.actions || []) {
        setTimeout(() => {
            if (action.atmosphere) {
                ({ snapshot } = atmosphereFor(action.atmosphere));
                eventBus.emit('atmosphere:updated', snapshot);
                mark(action.label || 'atmosphere', { kind: 'action' });
                if (!action.emit && !action.cue) return;
            }
            if (action.accent) {
                const agent = [...world.agents.values()][action.agentIndex ?? 0];
                const atMs = performance.now() + (action.accent.leadMs ?? 400);
                const drawAt = scheduleAccent(agent?.id ?? null, atMs, action.accent.kind);
                log.accents.push({ kind: action.accent.kind, agentId: agent?.id ?? null, t: ctx.currentTime, accentT: (drawAt - perfBase) / 1000 });
            }
            runAction(action, { world, mark, controller });
        }, Math.max(0, perfAt(warmup + action.at) - vc.now));
    }

    const wallStart = vc.real.performanceNow();
    const buffer = await renderStepped(ctx, { perfBase, stepFrames: spec.stepFrames || 512 });
    const renderMs = vc.real.performanceNow() - wallStart;
    clearInterval(pump);
    const names = publishPcm(buffer, stems);
    const toT = ms => (ms - perfBase) / 1000;
    const snap = plain(window.__claudevilleAudio?.());
    return {
        sampleRate,
        frames: buffer.length,
        names,
        warmup,
        seconds: spec.seconds,
        renderMs,
        hour,
        atmosphere: atmosphereSummary(snapshot),
        limiterKind: engine.limiterKind ?? null,
        programTrimDb: PROGRAM_TRIM_DB,
        volumeStep: snap?.volumeStep ?? null,
        markers,
        cues: log.cues,
        scheduled: log.scheduled.map(s => ({ ...s, notes: s.notesMs.map(toT) })),
        ducks: log.ducks,
        accents: log.accents,
        levels: log.levels,
        stateLog,
        finalSnapshot: snap,
        cueScore: plain(cueScoreDiagnostics()),
        clock: { fired: vc.fired, errors: vc.errors.slice(0, 20), timersLeft: vc.timers() },
    };
}

// The engine alone, no controller: a scheduled signal list into one bus at a
// level stated at the limiter input (1.1 acceptance: a +12 dBFS burst, the
// static gain at -20 dBFS). The fade is pinned open.
//   signals: [{ at, dur, dbAtLimiter, hz? (sine) | noise: true }]
export async function runEngineUnit(spec) {
    const sampleRate = spec.sampleRate || 48000;
    const stems = spec.stems || ['limiterIn', 'limiterOut'];
    if (spec.noWorklets) globalThis.__claudevilleAudioNoWorklets = true;
    const ctx = sceneContext({ seconds: spec.seconds, stems, sampleRate });
    const engine = new AudioEngine();
    engine.setVolumeStep(spec.volumeStep ?? 10);
    const ready = engine.ensureContext();
    let ok = false;
    ready.then((v) => { ok = v; });
    await pumpUntil(() => ok, 'ensureContext');
    engine.fadeGain.gain.value = 1;
    engine.started = true;
    attachStems(ctx, engine, stems);
    const bus = engine.busInput(spec.bus || 'cue');
    for (const s of spec.signals || []) {
        const amp = Math.pow(10, (s.dbAtLimiter - PROGRAM_TRIM_DB) / 20);
        let src;
        if (s.noise) {
            const n = Math.ceil(s.dur * sampleRate);
            const buf = ctx.createBuffer(2, n, sampleRate);
            let seed = 0x1234567;
            for (let c = 0; c < 2; c++) {
                const d = buf.getChannelData(c);
                for (let i = 0; i < n; i++) {
                    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
                    d[i] = amp * ((seed / 4294967296) * 2 - 1);
                }
            }
            src = new AudioBufferSourceNode(ctx, { buffer: buf });
            src.connect(bus);
        } else {
            src = new OscillatorNode(ctx, { frequency: s.hz || 1000 });
            const g = new GainNode(ctx, { gain: amp });
            src.connect(g).connect(bus);
        }
        src.start(s.at);
        src.stop(s.at + s.dur);
    }
    const perfBase = vc.now;
    const buffer = await renderStepped(ctx, { perfBase, stepFrames: 4096 });
    const names = publishPcm(buffer, stems);
    return { sampleRate, frames: buffer.length, names, limiterKind: engine.limiterKind ?? null, programTrimDb: PROGRAM_TRIM_DB };
}

window.__vcRender = { runVirtual, runEngineUnit, stage };
window.__vcReady = true;
