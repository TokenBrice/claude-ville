// In-page runner for the ClaudeVille listening harness. Imports the SHIPPED
// audio modules straight from the repo (served read-only at "/") and drives
// them through their public surfaces: the real AmbientAudioController, the
// real event bus, real AtmosphereState snapshots. Nothing here edits
// synthesis; the only interventions are selection pins (which tune plays),
// layer isolation through the director's own forceLayer() QA hook, and a
// start gate for the first ambient song (see README "fidelity").

import { AmbientAudioController } from '/src/presentation/shared/AmbientAudioController.js';
import { eventBus } from '/src/domain/events/DomainEvent.js';
import { createAtmosphereSnapshot } from '/src/presentation/character-mode/AtmosphereState.js';
import { seasonTokenForAtmosphere } from '/src/presentation/character-mode/SeasonalAmbience.js';
import { AudioEngine } from '/src/presentation/shared/audio/AudioEngine.js';
import { AudioDirector } from '/src/presentation/shared/audio/AudioDirector.js';
import { CueKit, laneForCueKind } from '/src/presentation/shared/audio/cues/CueKit.js';
import { CueGovernor } from '/src/presentation/shared/audio/CueGovernor.js';
import { cueNoteOffsetsMs } from '/src/presentation/shared/audio/CueScore.js';
import { PIECES } from '/src/presentation/shared/audio/bgm/BgmSongbook.js';

const LAYERS = ['wind', 'rain', 'birds', 'crickets', 'hum', 'bed', 'music'];
const MUSIC_FAMILY = {
    hearthfire: 'millbrook', millbrook: 'hearthfire',
    lanternway: 'starwake', starwake: 'lanternway',
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

export const modules = {
    AmbientAudioController, eventBus, createAtmosphereSnapshot, AudioEngine,
    AudioDirector, CueKit, CueGovernor, cueNoteOffsetsMs, PIECES, laneForCueKind,
};

// ---------------------------------------------------------------- world ----
let agentSeq = 0;
function makeAgent(status, provider = 'claude', extra = {}) {
    agentSeq++;
    return {
        id: `har-${agentSeq}`,
        name: `Villager ${agentSeq}`,
        provider,
        status,
        position: { tileX: 10 + (agentSeq * 7) % 20, tileY: 12 + (agentSeq * 5) % 16 },
        ...extra,
    };
}

export function makeWorld(spec = {}) {
    const agents = new Map();
    const providers = spec.providers || ['claude', 'codex', 'gemini', 'kimi'];
    let p = 0;
    for (const [status, count] of Object.entries(spec.counts || {})) {
        for (let i = 0; i < count; i++) {
            const agent = makeAgent(status, providers[p++ % providers.length]);
            agents.set(agent.id, agent);
        }
    }
    return { agents };
}

// ----------------------------------------------------------- atmosphere ----
const FIXED_DATE = () => new Date(2026, 6, 15, 12, 0, 0); // mid-July: summer

// Find the hour that lands the requested phase at the requested progress for
// this weather, scanning the day in 2-minute steps. Minute 0 is avoided so the
// hour bell never fires inside a render.
export function hourFor(phase, progress = 0.5, weatherOverride = null) {
    let best = null;
    for (let m = 1; m < 1440; m += 2) {
        if (m % 60 === 0) continue;
        const snap = createAtmosphereSnapshot({ now: FIXED_DATE(), hourOverride: m / 60, weatherOverride });
        if (snap.phase !== phase) continue;
        const d = Math.abs((snap.phaseProgress ?? 0) - progress);
        if (!best || d < best.d) best = { d, hour: m / 60 };
    }
    return best ? best.hour : 12.5;
}

export function atmosphereFor(spec = {}) {
    const weatherOverride = spec.weather || { type: 'clear' };
    const hour = spec.hour ?? hourFor(spec.phase || 'day', spec.progress ?? 0.5, weatherOverride);
    const snapshot = createAtmosphereSnapshot({ now: FIXED_DATE(), hourOverride: hour, weatherOverride });
    return { snapshot, hour };
}

function atmosphereSummary(snapshot) {
    return {
        phase: snapshot.phase,
        phaseProgress: Number((snapshot.phaseProgress ?? 0).toFixed(3)),
        season: seasonTokenForAtmosphere(snapshot),
        clock: snapshot.clock ? { hours: snapshot.clock.hours, minutes: snapshot.clock.minutes } : null,
        weather: snapshot.weather ? {
            type: snapshot.weather.type,
            intensity: Number((snapshot.weather.intensity ?? 0).toFixed(3)),
            precipitation: Number((snapshot.weather.precipitation ?? 0).toFixed(3)),
            fog: Number((snapshot.weather.fog ?? 0).toFixed(3)),
            windX: snapshot.weather.windX,
        } : null,
    };
}

// -------------------------------------------------------------- markers ----
function makeMarker(getCtx) {
    const markers = [];
    const mark = (label, extra = {}) => {
        const ctx = getCtx();
        markers.push({ label, t: ctx ? ctx.currentTime : null, ...extra });
    };
    return { markers, mark };
}

function plain(value) {
    return JSON.parse(JSON.stringify(value ?? null, (k, v) => (typeof v === 'function' ? undefined : v)));
}

// ------------------------------------------------------------ realtime ----
// spec: { mode, volume, world:{counts}, atmosphere:{phase,progress,weather},
//         isolate, music:{tune, phase}, bgm:{piece, loop}, warmup, seconds,
//         actions:[{at, emit, payload} | {at, status:{index,status}} | {at, flash}],
//         maxSeconds, snippet }
export async function runRealtime(spec) {
    try {
        localStorage.setItem('claudeville.sound.enabled', 'true');
        localStorage.setItem('claudeville.sound.mode', spec.mode || 'ambient');
        localStorage.setItem('claudeville.sound.volume', String(spec.volume ?? 0.5));
        localStorage.removeItem('claudeville.sound.layers');
    } catch { /* storage optional */ }

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

    controller = new AmbientAudioController({ world });
    // The page already holds a real user activation (openHarness clicks it),
    // so this is the same enable a TopBar click performs.
    controller.activateFromUser(true);
    const t0 = performance.now();
    while (!(controller.engine.running && controller.director.running)) {
        if (performance.now() - t0 > 10000) throw new Error(`audio did not start: ${controller.engine.context?.state}`);
        await sleep(20);
    }
    mark('audio-started');

    const director = controller.director;
    let done = null;

    if (spec.isolate) {
        for (const name of LAYERS) {
            if (name !== spec.isolate) director.forceLayer(name, 0, 1e9);
        }
    }

    // Ambient composer: pin the tune by excluding its sibling, gate the first
    // song until the layer's level slew has settled, mark every section.
    if (spec.music) {
        const layer = director.layers.music;
        layer._lastSongName = MUSIC_FAMILY[spec.music.tune];
        const gateUntil = performance.now() + (spec.music.gateMs ?? 9000);
        const origPlay = layer._playSong.bind(layer);
        layer._playSong = function gatedPlaySong() {
            if (performance.now() < gateUntil) { layer._scheduleSong(250); return; }
            layer._playSong = origPlay;
            mark('song-start');
            return origPlay();
        };
        const origSection = layer._sectionAt.bind(layer);
        let resolveDone;
        done = new Promise(r => { resolveDone = r; });
        layer._sectionAt = function markedSectionAt(t, index) {
            const plan = layer._plan;
            if (plan && index < plan.queue.length) {
                const step = plan.queue[index];
                markers.push({ label: `${plan.song.name}:${step.kind}${step.variation ? `(${step.variation})` : ''}`, t, kind: 'section' });
            } else if (plan) {
                markers.push({ label: 'song-end', t, kind: 'section' });
                resolveDone?.({ endT: t });
                resolveDone = null;
            }
            return origSection(t, index);
        };
    }

    // BGM: pin the piece through the player's playlist, mark each chunk, and
    // resolve once the requested loop has finished (`loop: 0` pins only).
    if (spec.bgm) {
        const player = director.player;
        const only = PIECES.filter(p => p.name === spec.bgm.piece);
        if (!only.length) throw new Error(`unknown BGM piece ${spec.bgm.piece}`);
        player._playlist = () => only;
        const wantLoop = spec.bgm.loop ?? 2;
        const origChunk = player._chunkAt.bind(player);
        let resolveDone;
        if (wantLoop > 0) done = new Promise(r => { resolveDone = r; });
        player._chunkAt = function markedChunkAt(t, chunkStart) {
            const cur = player._current;
            const result = origChunk(t, chunkStart);
            if (cur) {
                const loop = cur.loop + 1;
                const section = player.section;
                if (chunkStart === 0) {
                    markers.push({ label: `${cur.piece.name}:loop${loop}:${section}`, t, kind: 'loop', loop, section });
                    if (loop === wantLoop && resolveDone) {
                        const loopSeconds = cur.totalBeats * cur.beatSec;
                        resolveDone({ startT: t, endT: t + loopSeconds, loopSeconds });
                        resolveDone = null;
                    }
                } else {
                    markers.push({ label: `bar${chunkStart / 4 + 1}:${section}`, t, kind: 'chunk', loop, section });
                }
            }
            return result;
        };
    }

    if (snippet?.default) await snippet.default(api());

    // Level/state log once per second (audio clock), for the JSON sidecar.
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
    if (spec.music) {
        const first = markers.find(m => m.kind === 'section');
        if (first) windowStart = Math.max(recStart, first.t - 0.5);
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
        worldCounts: snap?.sectionCounts,
        finalSnapshot: snap,
        stateLog,
    };
}

function runAction(action, { world, mark, controller }) {
    if (action.status) {
        const agents = [...world.agents.values()];
        const agent = agents[action.status.index ?? 0];
        if (agent) {
            agent.status = action.status.status;
            if (action.status.status === 'waiting_on_user') agent.awaitingSince = Date.now();
            eventBus.emit('agent:updated', agent);
        }
        mark(`status:${action.status.status}`, { kind: 'action' });
        return;
    }
    if (action.addAgent) {
        const agent = makeAgent(action.addAgent.status || 'working', action.addAgent.provider || 'claude');
        world.agents.set(agent.id, agent);
        eventBus.emit('agent:added', agent);
        mark(`add:${agent.id}`, { kind: 'action' });
        return;
    }
    if (action.emit) {
        const agents = [...world.agents.values()];
        const payload = { ...(action.payload || {}) };
        if (action.agentIndex != null && agents[action.agentIndex]) {
            const agent = agents[action.agentIndex];
            payload.agentId = agent.id;
            payload.agent = agent;
            payload.provider = payload.provider || agent.provider;
        }
        mark(action.label || action.emit, { kind: 'event' });
        eventBus.emit(action.emit, payload);
        return;
    }
    if (action.mode) {
        mark(`mode:${action.mode}`, { kind: 'action' });
        controller.setMode(action.mode);
        return;
    }
    if (action.cue) {
        mark(`debug-cue:${action.cue}`, { kind: 'event' });
        controller.director.cue(action.cue, action.payload || {});
    }
}

// ------------------------------------------------------------- offline ----
// A CueKit voice rendered sample-accurately: a real AudioEngine (full master
// chain: volume² gain, 6.2 kHz tone, limiter, analyser) is built on an
// OfflineAudioContext and the cue goes through CueKit._playAccepted, i.e. the
// same schedule/anchor/voice path the governor calls once a cue is admitted.
// The fade stage is pinned open (engine.start() would fade in over ~1 s).
export async function runOfflineCues(spec) {
    const sampleRate = spec.sampleRate || 48000;
    const seconds = spec.seconds || 6;
    const ctx = new OfflineAudioContext(2, Math.ceil(seconds * sampleRate), sampleRate);
    if (Array.isArray(window.__harVoiceLog)) window.__harVoiceLog.length = 0;
    const engine = new AudioEngine();
    engine.setVolume(spec.volume ?? 0.5);
    engine.context = ctx;
    engine._buildGraph();
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
// connecting to engine.cueBus / engine.ambienceBus hears the shipped mix.
export async function runSnippet({ url, seconds = 8, offline = false, sampleRate = 48000, volume = 0.5 }) {
    const mod = await import(url);
    const fn = mod.default || mod.render;
    if (typeof fn !== 'function') throw new Error('snippet must export default async function(api)');
    const engine = new AudioEngine();
    engine.setVolume(volume);
    let context;
    if (offline) {
        context = new OfflineAudioContext(2, Math.ceil(seconds * sampleRate), sampleRate);
    } else {
        context = new AudioContext({ sampleRate });
        await context.resume();
    }
    engine.context = context;
    engine._buildGraph();
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
