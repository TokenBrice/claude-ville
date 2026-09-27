// In-page runner for the ClaudeVille listening harness. Imports the SHIPPED
// audio modules straight from the repo (served read-only at "/") and drives
// them through their public surfaces: the real AmbientAudioController, the
// real event bus, real AtmosphereState snapshots. Nothing here edits
// synthesis; the only intervention is a selection pin (which Town band piece
// plays, set on the sequencer as it starts, scene.js pinSequencer).

import { AmbientAudioController } from '/src/presentation/shared/AmbientAudioController.js';
import { eventBus } from '/src/domain/events/DomainEvent.js';
import { createAtmosphereSnapshot } from '/src/presentation/character-mode/AtmosphereState.js';
import { AudioEngine } from '/src/presentation/shared/audio/AudioEngine.js';
import { SignalDirector } from '/src/presentation/shared/audio/SignalDirector.js';
import { CueKit, laneForCueKind } from '/src/presentation/shared/audio/cues/CueKit.js';
import { CueGovernor } from '/src/presentation/shared/audio/CueGovernor.js';
import { cueNoteOffsetsMs } from '/src/presentation/shared/audio/CueScore.js';
import { STANDARD_VOLUME_STEP } from '/src/presentation/shared/audio/Loudness.js';
import { PIECES } from '/src/presentation/shared/audio/bgm/BgmSongbook.js';
import {
    PRESET_FOR_MODE, atmosphereFor, atmosphereSummary, hourFor, makeMarker, makeWorld, pinSequencer, plain, runAction, seedSoundStorage,
} from './scene.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));

export const modules = {
    AmbientAudioController, eventBus, createAtmosphereSnapshot, AudioEngine,
    SignalDirector, CueKit, CueGovernor, cueNoteOffsetsMs, PIECES, laneForCueKind,
};

// ------------------------------------------------------------ realtime ----
// spec: { mode ('signals' | 'bgm', default 'bgm'), volumeStep, world:{counts},
//         atmosphere:{phase,progress,weather}, bgm:{piece, loop}, warmup,
//         seconds, actions:[see scene.js runAction], maxSeconds, tailSeconds,
//         snippet }
export async function runRealtime(spec) {
    seedSoundStorage(spec);

    const world = makeWorld(spec.world);
    const { snapshot, hour } = atmosphereFor(spec.atmosphere);
    const pump = setInterval(() => eventBus.emit('atmosphere:updated', snapshot), 400);
    eventBus.emit('atmosphere:updated', snapshot);

    const snippet = spec.snippet ? await import(spec.snippet) : null;
    let controller = null;
    const { markers, mark } = makeMarker(() => controller?.engine?.context);
    const api = () => ({
        context: controller?.engine?.context,
        destination: controller?.engine?.context?.destination,
        engine: controller?.engine,
        controller,
        world,
        eventBus,
        modules,
        mark,
        seconds: spec.seconds,
    });
    if (snippet?.before) await snippet.before({ ...api(), modules, eventBus, world, mark });

    // Town band pins and marks (set before the controller: the sequencer
    // picks its first piece as it starts): the pinned piece, every loop and
    // four-bar chunk marked, done once the requested loop has finished
    // (`loop: 0` pins only). Signals has no music, so nothing to pin.
    let done = null;
    let resolveDone = null;
    if (spec.bgm) {
        if (!PIECES.some(p => p.name === spec.bgm.piece)) throw new Error(`unknown BGM piece ${spec.bgm.piece}`);
        const wantLoop = spec.bgm.loop ?? 2;
        if (wantLoop > 0) done = new Promise(r => { resolveDone = r; });
        const ok = await pinSequencer({
            preset: 'townBand',
            piece: spec.bgm.piece,
            onMark(m) {
                if (m.kind === 'loop') {
                    markers.push({ label: `${m.piece}:loop${m.loop}:band${m.band}`, t: m.t, kind: 'loop', loop: m.loop, band: m.band });
                    if (m.loop === wantLoop && resolveDone) {
                        resolveDone({ startT: m.t, endT: m.t + m.loopSeconds, loopSeconds: m.loopSeconds });
                        resolveDone = null;
                    }
                } else if (m.kind === 'chunk' && m.bar > 1) {
                    markers.push({ label: `bar${m.bar}:band${m.band}`, t: m.t, kind: 'chunk', loop: m.loop, band: m.band });
                }
            },
        });
        if (!ok) throw new Error('the harness pins music through audio/music/Sequencer.js, which this tree lacks');
    }

    controller = new AmbientAudioController({ world });
    // The page already holds a real user activation (openHarness clicks it),
    // so this is the same enable a TopBar pick performs.
    controller.setPreset(PRESET_FOR_MODE[spec.mode || 'bgm'], { fromUser: true });
    const t0 = performance.now();
    while (!(controller.engine.running && controller.director.running)) {
        if (performance.now() - t0 > 10000) throw new Error(`audio did not start: ${controller.engine.context?.state}`);
        await sleep(20);
    }
    mark('audio-started');

    if (snippet?.default) await snippet.default(api());

    // State log once per second (audio clock), for the JSON sidecar: the
    // Town band's level, piece and section; the Signals director's state.
    const stateLog = [];
    const logTimer = setInterval(() => {
        const snap = window.__claudevilleAudio?.();
        if (!snap) return;
        stateLog.push(plain({
            t: controller.engine.now(),
            state: snap.state,
            levels: snap.levels,
            nowPlaying: snap.nowPlaying,
            section: snap.section?.applied,
            framePressureLevel: snap.framePressureLevel,
            rms: snap.rms,
        }));
    }, 1000);

    await sleep((spec.warmup ?? 0) * 1000);
    mark('rec-start');
    const recStart = controller.engine.now();

    for (const action of spec.actions || []) {
        setTimeout(() => runAction(action, { world, mark, controller }), action.at * 1000);
    }

    let endT;
    let windowStart = recStart;
    let doneInfo = null;
    if (done) {
        const cap = (spec.maxSeconds ?? 240) * 1000;
        doneInfo = await Promise.race([done, sleep(cap).then(() => null)]);
        endT = doneInfo ? doneInfo.endT + (spec.tailSeconds ?? 0) : controller.engine.now();
        if (doneInfo?.startT != null) windowStart = doneInfo.startT;
        while (controller.engine.now() < endT + 0.3) await sleep(100);
    } else {
        await sleep((spec.seconds ?? 20) * 1000);
        endT = controller.engine.now();
    }
    markers.push({ label: 'rec-end', t: endT });
    clearInterval(logTimer);
    clearInterval(pump);

    const snap = plain(window.__claudevilleAudio?.());
    return {
        markers,
        recStart,
        recEnd: endT,
        window: { start: windowStart, end: endT },
        loopSeconds: doneInfo?.loopSeconds ?? null,
        timedOut: Boolean(done && !doneInfo),
        hour,
        atmosphere: atmosphereSummary(snapshot),
        worldCounts: snap?.section?.counts,
        finalSnapshot: snap,
        stateLog,
    };
}

// ------------------------------------------------------------- offline ----
// A CueKit voice rendered sample-accurately: a real AudioEngine (the full
// master chain, limiter worklet included) is attached to an
// OfflineAudioContext and the cue goes through CueKit._playAccepted, i.e. the
// same schedule/anchor/voice path the governor calls once a cue is admitted.
// The fade stage is pinned open (engine.start() would fade in over ~1 s).
export async function runOfflineCues(spec) {
    const sampleRate = spec.sampleRate || 48000;
    const seconds = spec.seconds || 6;
    const ctx = new OfflineAudioContext(2, Math.ceil(seconds * sampleRate), sampleRate);
    if (Array.isArray(window.__harVoiceLog)) window.__harVoiceLog.length = 0;
    const engine = new AudioEngine();
    engine.setVolumeStep(spec.volumeStep ?? STANDARD_VOLUME_STEP);
    await engine.attachContext(ctx);
    engine.fadeGain.gain.value = 1;
    engine.started = true;
    const kit = new CueKit(engine, new CueGovernor());
    const markers = [];

    // Offline contexts do not advance while suspended; each cue is armed at
    // its own time via suspend()/resume() so engine.now() reads the cue time.
    const cues = [...(spec.cues || [])].sort((a, b) => a.at - b.at);
    for (const cue of cues) {
        const at = Math.round(cue.at * sampleRate / 128) * 128 / sampleRate;
        ctx.suspend(at).then(async () => {
            const payload = { phase: 'day', ...cue.payload };
            payload.lane = laneForCueKind(cue.kind);
            const offsets = cueNoteOffsetsMs(cue.kind, payload);
            kit._playAccepted({ ...payload, kind: cue.kind }, {});
            // Arrival/departure schedule on a 0 ms task; let it run.
            await sleep(5);
            markers.push({ label: cue.label || cue.kind, t: at, kind: 'event', offsetsMs: offsets, lane: payload.lane });
            ctx.resume();
        });
    }
    const buffer = await ctx.startRendering();
    const L = buffer.getChannelData(0);
    const R = buffer.getChannelData(1);
    const pcm = new Float32Array(L.length * 2);
    for (let i = 0; i < L.length; i++) { pcm[2 * i] = L[i]; pcm[2 * i + 1] = R[i]; }
    window.__harPcm = pcm;
    return { frames: L.length, sampleRate, markers };
}

// ------------------------------------------------------------- snippet ----
// Standalone snippet render: the snippet module's default export receives
// { context, destination, engine, modules, mark, seconds }. `destination` is
// the context destination (tapped in realtime, rendered offline); `engine` is
// a real AudioEngine whose master chain already feeds that destination, so
// connecting to engine.busInput('cue' | 'music') hears the
// shipped mix.
export async function runSnippet({ url, seconds = 8, offline = false, sampleRate = 48000, volumeStep = STANDARD_VOLUME_STEP }) {
    const mod = await import(url);
    const fn = mod.default || mod.render;
    if (typeof fn !== 'function') throw new Error('snippet must export default async function(api)');
    const engine = new AudioEngine();
    engine.setVolumeStep(volumeStep);
    let context;
    if (offline) {
        context = new OfflineAudioContext(2, Math.ceil(seconds * sampleRate), sampleRate);
    } else {
        context = new AudioContext({ sampleRate });
        await context.resume();
    }
    await engine.attachContext(context);
    engine.fadeGain.gain.value = 1;
    engine.started = true;
    const { markers, mark } = makeMarker(() => context);
    if (offline) {
        await fn({ context, destination: context.destination, engine, modules, mark, seconds, offline });
        const buffer = await context.startRendering();
        const L = buffer.getChannelData(0);
        const R = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : L;
        const pcm = new Float32Array(L.length * 2);
        for (let i = 0; i < L.length; i++) { pcm[2 * i] = L[i]; pcm[2 * i + 1] = R[i]; }
        window.__harPcm = pcm;
        return { offline: true, frames: L.length, sampleRate, markers, recStart: 0, recEnd: seconds };
    }
    // Make sure the tap exists even if the snippet never touches destination
    // directly (the engine's analyser already connects to it).
    await window.__harTap.tapFor(context).ready;
    await sleep(100);
    const recStart = context.currentTime;
    mark('rec-start');
    await fn({ context, destination: context.destination, engine, modules, mark, seconds, offline });
    const until = recStart + seconds;
    while (context.currentTime < until + 0.3) await sleep(100);
    mark('rec-end');
    markers[markers.length - 1].t = until;
    return { offline: false, markers, recStart, recEnd: until };
}

window.__har = { runRealtime, runOfflineCues, runSnippet, hourFor, atmosphereFor, makeWorld, modules };
window.__harReady = true;
