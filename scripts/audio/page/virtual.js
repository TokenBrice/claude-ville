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
// timers due by then before resuming. A hidden tab is modelled by the
// document.hidden override and a real visibilitychange: the controller's
// pause and `context.suspend()` reach the shimmed state, the render itself
// keeps running (a real suspended context would also stop its clock).
//
// Stems (HAR-5) ride extra destination channels: channels 0–1 carry the
// program, and each requested tap adds a stereo pair through a channel
// merger, so every stem is sample-aligned with the program.
import { AmbientAudioController } from '/src/presentation/shared/AmbientAudioController.js';
import { eventBus } from '/src/domain/events/DomainEvent.js';
import { AudioEngine } from '/src/presentation/shared/audio/AudioEngine.js';
import { cueScoreDiagnostics, scheduleAccent } from '/src/presentation/shared/audio/CueScore.js';
import { laneForCueKind } from '/src/presentation/shared/audio/cues/CueKit.js';
import { PROGRAM_TRIM_DB } from '/src/presentation/shared/audio/Loudness.js';
import { PIECES } from '/src/presentation/shared/audio/bgm/BgmSongbook.js';
import {
    LAYERS, atmosphereFor, atmosphereSummary, makeMarker, makeWorld, pinSequencer, plain, runAction, seedSoundStorage,
} from './scene.js';
import { installRitualConductor, scriptedCamera } from './workshop.js';

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
    // Island Air (S5): the wet return before its program trim — the same
    // staging as the cue and bus taps above.
    airWet: engine => engine.airReturns?.wet ?? null,
    // The held note's own path (S3, 3.3), post-duck: what it adds to the
    // program before its PROGRAM_TRIM.
    signalBed: (engine) => { try { return engine._busOut('signalBed'); } catch { return null; } },
};

function sceneContext({ seconds, stems, sampleRate }) {
    const ctx = new OfflineAudioContext({
        numberOfChannels: 2 + 2 * stems.length,
        length: Math.ceil(seconds * sampleRate),
        sampleRate,
    });
    vc.sceneContext = ctx;
    let state = 'suspended';
    const stateLog = [];
    const setState = (next) => {
        if (state === next || state === 'closed') return;
        state = next;
        stateLog.push({ t: ctx.currentTime, perf: vc.now, state: next });
        ctx.dispatchEvent(new Event('statechange'));
    };
    ctx.__vcStateLog = stateLog;
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
// With `freeze`, a context the app suspended (a hidden tab) stops the audio
// clock as a real suspended context does: the render holds at its step
// while the virtual clock (timers, the hidden page) keeps moving, until the
// app resumes it. Audio time then continues where it stopped.
async function renderStepped(ctx, { perfBase, stepFrames, freeze = false }) {
    const sr = ctx.sampleRate;
    const stepMs = (stepFrames / sr) * 1000;
    let k = 1;
    let frozenMs = 0;
    let failure = null;
    const arm = () => {
        const frame = k * stepFrames;
        if (frame >= ctx.length) return;
        offline.suspend.call(ctx, frame / sr).then(async () => {
            try {
                await vc.advanceTo(perfBase + frozenMs + (frame / sr) * 1000);
                while (freeze && ctx.state === 'suspended') {
                    if (frozenMs > 3600e3) throw new Error('virtual clock: the context stayed suspended for an hour');
                    frozenMs += stepMs;
                    await vc.advanceTo(perfBase + frozenMs + (frame / sr) * 1000);
                }
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
function publishPcm(buffer, stems, extra = {}) {
    const names = ['program', ...stems];
    rendered = { buffer, names, extra };
    return [...names, ...Object.keys(extra)];
}

export function stage(name) {
    const i = rendered?.names.indexOf(name) ?? -1;
    const pair = rendered?.extra[name];
    if (i < 0 && !pair) throw new Error(`no rendered channel pair ${name}`);
    const L = pair ? pair[0] : rendered.buffer.getChannelData(2 * i);
    const R = pair ? pair[1] : rendered.buffer.getChannelData(2 * i + 1);
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

// Seeded streams (S6): the probe seed reaches Rng.js when the tree has it;
// `rng: { constant }` pins every draw (Rng.js streams and Math.random) to
// one value, which is how the sequencer-equivalence renders make two
// implementations with different stream layouts make the same choices.
async function setupRng(spec) {
    const rng = await import('/src/presentation/shared/audio/Rng.js').catch(() => null);
    const constant = spec.rng?.constant;
    if (constant != null) {
        Math.random = () => constant;
        rng?.setRngOverride?.(() => constant);
    } else if (rng?.setRngSeed) {
        rng.setRngSeed(Number(window.__HAR_SEED) >>> 0);
    }
    return rng ? { module: true, seed: rng.rngSeed?.() ?? null, constant: constant ?? null } : { module: false, constant: constant ?? null };
}

// The Village tunes' siblings (the Wave-1 pin excludes the sibling).
const VILLAGE_SIBLING = { hearthfire: 'millbrook', millbrook: 'hearthfire', lanternway: 'starwake', starwake: 'lanternway' };

// Pin one piece: the sequencer's `pin()`; the Wave-1 hooks (`_playlist`,
// `_lastSongName`) only for rendering the sequencer check's reference from
// the Wave-1 tree.
function pinPiece(controller, spec) {
    if (spec.bgm?.piece) {
        const player = controller.directors?.bgm?.player;
        if (!player) return 'no Town band player';
        if (typeof player.pin === 'function') { player.pin({ piece: spec.bgm.piece }); return 'pin'; }
        const only = PIECES.filter(p => p.name === spec.bgm.piece);
        if (!only.length) throw new Error(`unknown BGM piece ${spec.bgm.piece}`);
        player._playlist = () => only;
        return 'playlist';
    }
    if (spec.music?.piece) {
        const layer = controller.director?.layers?.music;
        if (!layer) return 'no Village music layer';
        // A held level from the start: the first song slot (3.75 s at
        // rng 0.5) finds the level settled in both implementations.
        if (spec.music.level != null) controller.director.forceLayer('music', spec.music.level, 1e9);
        if (typeof layer.pin === 'function') { layer.pin({ piece: spec.music.piece }); return 'pin'; }
        layer._lastSongName = VILLAGE_SIBLING[spec.music.piece];
        return 'sibling';
    }
    return null;
}

// Whether a node's graph reaches `target` (node → node edges only;
// modulators feeding an AudioParam are not notes).
function reacherOf(target) {
    const memo = new Map();
    const reaches = (node, seen) => {
        if (node === target) return true;
        if (memo.has(node)) return memo.get(node);
        if (seen.has(node)) return false;
        seen.add(node);
        let hit = false;
        for (const next of vc.audio.edges.get(node) || []) {
            if (reaches(next, seen)) { hit = true; break; }
        }
        memo.set(node, hit);
        return hit;
    };
    return node => Boolean(node) && reaches(node, new Set());
}

// Per timer call site: callbacks fired, their real duration, and the
// sources started while it ran — continuous ones (`starts`) apart from
// discrete cues (`cueStarts`, sources reaching the cue bus: control-rate
// decisions placed on the audio clock with a lead, exempt from S4's
// one-timer rule), with the first few start times and node kinds.
function timerReport() {
    const perSite = new Map();
    const row = site => perSite.get(site) || perSite.set(site, { starts: 0, cueStarts: 0, first: [] }).get(site);
    for (const s of vc.audio.starts) {
        const r = row(s.site);
        if (s.cue) r.cueStarts++;
        else {
            r.starts++;
            if (r.first.length < 3) r.first.push({ t: Number(s.t.toFixed(3)), k: s.k });
        }
    }
    const stats = vc.timerStats();
    const empty = { starts: 0, cueStarts: 0, first: [] };
    return stats.map((s) => {
        const d = s.durationsMs.slice().sort((a, b) => a - b);
        const q = p => (d.length ? d[Math.min(d.length - 1, Math.floor(p * d.length))] : null);
        return { site: s.site, callers: s.callers.slice(0, 4), fired: s.fired, p95Ms: q(0.95), maxMs: d.length ? d[d.length - 1] : null, ...(perSite.get(s.site) || empty) };
    }).concat(['harness', 'untimed'].filter(k => !stats.some(s => s.site === k) && perSite.has(k)).map(k => ({ site: k, callers: [], fired: 0, p95Ms: null, maxMs: null, ...perSite.get(k) })));
}

function engineDiagnostics(engine) {
    const call = (fn) => { try { return plain(fn()); } catch (err) { return { error: String(err?.message || err) }; } };
    return {
        transport: engine.transport?.diagnostics ? call(() => engine.transport.diagnostics()) : null,
        bank: engine.bank?.stats ? call(() => engine.bank.stats()) : null,
        airReady: engine.air ? Boolean(engine.air.buffers?.().day && engine.air.buffers?.().night) : null,
    };
}

let hiddenFlag = false;
let hiddenInstalled = false;
function setHidden(value) {
    if (!hiddenInstalled) {
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => hiddenFlag });
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (hiddenFlag ? 'hidden' : 'visible') });
        hiddenInstalled = true;
    }
    hiddenFlag = value;
    document.dispatchEvent(new Event('visibilitychange'));
}

// Every discrete cue as the page saw it: `audio:cue-played` (captions: the
// Wave-3 payload fields a probe judges) and `audio:cue-scheduled` (the
// published notes, with each note's pitch when the tree publishes it).
// `now()` → the scene's time in seconds; `perf` is the virtual clock.
function logCues(log, now, kitOf) {
    eventBus.on('audio:cue-played', (p) => {
        log.cues.push({
            t: now(), perf: vc.now, kind: p?.kind ?? null, agentId: p?.agentId ?? null, label: p?.label ?? null,
            level: p?.level ?? p?.payload?.level ?? null, family: p?.family ?? null, count: p?.count ?? null,
            soundOnly: Boolean(p?.soundOnly), flock: Boolean(p?.flock), cluster: Array.isArray(p?.cluster) ? p.cluster.length : null,
            notes: Array.isArray(p?.notes) ? p.notes.slice() : null, silent: Boolean(p?.silent),
        });
        const level = kitOf()?.lastLevel;
        if (level) log.levels.push({ t: now(), kind: p?.kind ?? null, ...plain(level) });
    });
    eventBus.on('audio:cue-scheduled', (p) => {
        const notes = p?.notes || [];
        log.scheduled.push({
            t: now(), perf: vc.now, kind: p?.kind ?? null, agentId: p?.agentId ?? null, silent: Boolean(p?.silent),
            notesMs: notes.map(n => n.atMs), hz: notes.map(n => (Number.isFinite(n.hz) ? n.hz : null)),
        });
    });
}

// HAR-13: one real Toast per caption setting, each reading its own storage
// (that setting, and sound on or off) through the `storage` option, every
// rendered caption recorded. `clear()` empties every stack so the next cue
// is judged alone (Toast caps and coalesces a visible stack).
async function installCaptions(settings, soundOn) {
    if (!settings?.length) return null;
    const { Toast } = await import('/src/presentation/shared/Toast.js');
    let container = document.getElementById('toastContainer');
    if (!container) {
        container = document.createElement('div');
        container.id = 'toastContainer';
        document.body.appendChild(container);
    }
    const shown = [];
    const toasts = settings.map((setting) => {
        const storage = {
            getItem: (key) => {
                if (key === 'claudeville.captions') return setting;
                if (key === 'claudeville.sound.enabled') return soundOn ? 'true' : 'false';
                return localStorage.getItem(key);
            },
            setItem() {},
            removeItem() {},
        };
        const toast = new Toast({ storage });
        const show = toast._show.bind(toast);
        toast._show = (message, type, opts = {}) => {
            shown.push({ setting, perf: vc.now, message: String(message ?? ''), type, cueKind: opts.cueKind ?? null, agentId: opts.agentId ?? opts.attentionAgentId ?? null });
            return show(message, type, opts);
        };
        return toast;
    });
    return {
        shown,
        clear: () => { for (const toast of toasts) for (const entry of [...toast.toasts]) toast._remove(entry); },
        destroy: () => { for (const toast of toasts) toast.destroy?.(); },
    };
}

// The Wave-3 state a scene may judge: the ladder (`__claudevilleAudio().ladder`)
// and the held note's snapshot, when the tree has them.
function signalState(controller, snap) {
    let held = null;
    try { const d = controller?.directors?.ambient; held = (d?.layers?.heldNote ?? d?._heldNote)?.snapshot?.() ?? null; } catch { held = null; }
    return { ladder: snap?.ladder ?? null, heldNote: held };
}

// The sea's own account (4.1, 4.6) at the end of a render: committed crest
// times, yields to cues, node creations after start and the rare voices.
function seaState(controller) {
    try { return plain(controller?.directors?.ambient?.layers?.sea?.snapshot?.() ?? null); } catch (err) { return { error: String(err?.message || err) }; }
}

// The workshop layer's own account (5.1–5.8): strikes, guard hits, node
// creations, placements and the quota lane, when the tree has the layer.
function workshopState(controller) {
    try { return plain(controller?.directors?.ambient?.layers?.workshops?.snapshot?.() ?? null); } catch (err) { return { error: String(err?.message || err) }; }
}

// When each baked buffer lands, in audio time (SampleBank `_store`: the
// Island Air IRs and the rare takes; the noise pool's `_complete`): a bake
// that lands at a different audio time in two renders of one scene is the
// renderer's known source of run-to-run difference.
function logBakes(engine, ctx) {
    const bakes = [];
    const hook = (owner, name) => {
        const fn = owner?.[name];
        if (typeof fn !== 'function') return;
        owner[name] = function loggedBake(key, ...rest) {
            bakes.push({ key: String(key), t: ctx.currentTime });
            return fn.call(this, key, ...rest);
        };
    };
    hook(engine.bank, '_store');
    hook(engine.noisePool, '_complete');
    return bakes;
}

// Every AudioWorkletNode built on the scene context, with the audio time it
// was built at. Chrome constructs the processor on the audio thread
// asynchronously, so a node built while the render runs starts at a
// render quantum that can differ between two renders of one scene.
function logWorkletNodes(ctx) {
    const nodes = [];
    const Base = window.AudioWorkletNode;
    if (typeof Base !== 'function') return nodes;
    window.AudioWorkletNode = class LoggedAudioWorkletNode extends Base {
        constructor(context, name, options) {
            super(context, name, options);
            if (context === ctx) nodes.push({ name, t: context.currentTime });
        }
    };
    return nodes;
}

// Every scripted action on the virtual clock at `at(sec)` (a perf time).
// Beyond scene.js runAction: {visibility}, {window}, {atmosphere},
// {accent:{kind, leadMs}} (declared before the action's cue, as the
// renderer does), {input} (a pointerdown: the operator is looking). With
// captions installed each action starts from empty caption stacks.
function scheduleActions(actions, { world, mark, controller, captions, at, onAccent, onAtmosphere }) {
    for (const action of actions || []) {
        setTimeout(() => {
            captions?.clear();
            if (action.visibility) {
                setHidden(action.visibility === 'hidden');
                mark(action.label || `visibility:${action.visibility}`, { kind: 'action' });
                return;
            }
            if (action.window) {
                window.dispatchEvent(new Event(action.window));
                mark(action.label || `window:${action.window}`, { kind: 'action' });
                return;
            }
            if (action.input) {
                document.dispatchEvent(new Event(action.input, { bubbles: true }));
                mark(action.label || `input:${action.input}`, { kind: 'action' });
                return;
            }
            if (action.atmosphere) {
                const { snapshot } = atmosphereFor(action.atmosphere);
                onAtmosphere?.(snapshot);
                eventBus.emit('atmosphere:updated', snapshot);
                mark(action.label || 'atmosphere', { kind: 'action' });
                if (!action.emit && !action.cue) return;
            }
            if (action.accent) {
                const agent = [...world.agents.values()][action.agentIndex ?? 0];
                const drawAt = scheduleAccent(agent?.id ?? null, performance.now() + (action.accent.leadMs ?? 400), action.accent.kind);
                onAccent?.({ kind: action.accent.kind, agentId: agent?.id ?? null }, drawAt);
            }
            if (action.play) {
                // Governor-free (the capture tool's path): what the voice
                // sounds like once admitted — the discrimination gallery.
                const agent = action.agentIndex != null ? [...world.agents.values()][action.agentIndex] : null;
                const payload = { phase: 'day', ...(agent ? { agentId: agent.id, provider: agent.provider } : {}), ...(action.play.payload || {}) };
                mark(action.label || `play:${action.play.kind}`, { kind: 'event', cueKind: action.play.kind, agentId: agent?.id ?? null, voice: action.voice ?? null });
                controller.cues.kit._playAccepted({ ...payload, kind: action.play.kind, lane: laneForCueKind(action.play.kind) }, {});
                return;
            }
            runAction(action, { world, mark, controller });
        }, Math.max(0, at(action.at) - vc.now));
    }
}

// spec: { name, mode, volumeStep, layerSteps, world:{counts},
//         atmosphere:{phase,progress,weather,hour}, bgm:{piece}, warmup, seconds,
//         actions:[scene.js runAction | {atmosphere} | {accent:{kind, leadMs}}, …],
//         stems:[STEM_SOURCES keys], stepFrames, noWorklets, sampleRate,
//         rng:{constant}, music:{piece, level}, lint:false (skip the HAR-4
//         stack capture: timing scenes), trace:'music' (onsets of every
//         source reaching the music bus), collect:['starts'], airOff,
//         freezeOnSuspend, rituals:true (a stand-in ritual conductor for the
//         World path, page/workshop.js), camera:{viewportW, viewportH, zoom,
//         path:[{at, cx, cy}]} (a scripted camera through the director's
//         setCameraSource) }
// Every start is traced to the cue bus: `cue` marks discrete cue voices.
// Actions also take {visibility:'hidden'|'visible'} and {window:'blur'|'focus'}.
// Action `at` is seconds after warmup. Every returned time is audio time in
// seconds from the start of the render.
export async function runVirtual(spec) {
    const sampleRate = spec.sampleRate || 48000;
    const stems = spec.stems || [];
    const warmup = spec.warmup ?? 0;
    const total = warmup + spec.seconds;
    if (spec.noWorklets) globalThis.__claudevilleAudioNoWorklets = true;
    if (spec.lint === false) window.__harNoLint = true;
    vc.audio.keepNodes = true;
    const rngInfo = await setupRng(spec);
    const ctx = sceneContext({ seconds: total, stems, sampleRate });
    const workletNodes = logWorkletNodes(ctx);

    seedSoundStorage(spec);
    const world = makeWorld(spec.world);
    let { snapshot, hour } = atmosphereFor(spec.atmosphere);
    eventBus.emit('atmosphere:updated', snapshot);
    const pump = setInterval(() => eventBus.emit('atmosphere:updated', snapshot), 400);

    // World's renderer stand-ins (5.1, 5.8): rituals before the controller,
    // so the conductor sees the first tool start the director sees.
    const conductor = spec.rituals ? installRitualConductor() : null;
    const log = { cues: [], scheduled: [], ducks: [], accents: [], levels: [], work: [], workCancelled: [] };
    // Every workshop strike as the layer publishes it at booking (5.1), and
    // the booked strikes it stopped before they sounded.
    eventBus.on('audio:work-scheduled', (p) => { log.work.push({ ...plain(p), bookedAt: ctx.currentTime }); });
    eventBus.on('audio:work-cancelled', (p) => { log.workCancelled.push({ ...plain(p), cancelledAt: ctx.currentTime }); });
    let controller = null;
    const kitOf = () => controller?.cues?.kit ?? null;
    logCues(log, () => ctx.currentTime, kitOf);
    const captions = await installCaptions(spec.captions, true);

    // The Town band chooses its first piece as it starts: pin it there (a
    // tree without the sequencer pins after the enable, below).
    const pinAtStart = spec.bgm?.piece && await pinSequencer({ preset: 'townBand', piece: spec.bgm.piece }) ? 'pin at start' : null;
    controller = new AmbientAudioController({ world });
    let pinned = pinAtStart;
    controller.activateFromUser(true);
    await pumpUntil(() => controller.isRunning(), 'the enable');
    const engine = controller.engine;
    const perfBase = vc.now - ctx.currentTime * 1000;
    let cameraSeam = null;
    if (spec.camera) {
        const ambient = controller.directors?.ambient;
        cameraSeam = typeof ambient?.setCameraSource === 'function';
        if (cameraSeam) ambient.setCameraSource(scriptedCamera(spec.camera, () => (vc.now - perfBase) / 1000 - warmup));
    }

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
    const bakes = logBakes(engine, ctx);
    if (!pinned || pinned.startsWith('no ')) pinned = pinPiece(controller, spec);
    // airOff: 'all' (no air: both send sums cut) | 'bed' (dry bed, so the wet
    // return carries the cue sends only). Taps on `wet` stay connected.
    let airOff = null;
    if (spec.airOff) {
        const returns = engine.airReturns;
        airOff = Boolean(returns?.bed && returns?.cue);
        if (airOff) {
            returns.bed.disconnect();
            if (spec.airOff === 'all') returns.cue.disconnect();
        }
    }
    if (spec.isolate) {
        for (const name of LAYERS) if (name !== spec.isolate) controller.director.forceLayer(name, 0, 1e9);
    }
    // force: { layer: level } pinned for the whole scene (Village music at 0
    // is "no music": the sequencer starts no song and publishes nothing).
    for (const [name, level] of Object.entries(spec.force || {})) controller.directors.ambient.forceLayer(name, level, 1e9);

    const { markers, mark } = makeMarker(() => ctx);
    const stateLog = [];
    setInterval(() => {
        const snap = window.__claudevilleAudio?.();
        if (!snap) return;
        stateLog.push(plain({ t: ctx.currentTime, perf: vc.now, mode: snap.mode, state: snap.state, running: snap.running, levels: snap.levels, nowPlaying: snap.nowPlaying, quietMix: snap.quietMix ?? null, ...signalState(controller, snap) }));
    }, 1000);
    const perfAt = sec => perfBase + sec * 1000;
    setTimeout(() => mark('rec-start'), Math.max(0, perfAt(warmup) - vc.now));
    scheduleActions(spec.actions, {
        world, mark, controller, captions, at: sec => perfAt(warmup + sec),
        onAccent: (a, drawAt) => log.accents.push({ ...a, t: ctx.currentTime, accentT: (drawAt - perfBase) / 1000 }),
        onAtmosphere: (s) => { snapshot = s; },
    });

    const wallStart = vc.real.performanceNow();
    const buffer = await renderStepped(ctx, { perfBase, stepFrames: spec.stepFrames || 512, freeze: Boolean(spec.freezeOnSuspend) });
    const renderMs = vc.real.performanceNow() - wallStart;
    clearInterval(pump);
    const names = publishPcm(buffer, stems);
    const toT = ms => (ms - perfBase) / 1000;
    const wall = rows => rows.map(({ perf, ...r }) => ({ ...r, wall: perf != null ? toT(perf) : null }));
    const snap = plain(window.__claudevilleAudio?.());
    const starts = vc.audio.starts;
    const toCue = reacherOf(engine.busInput('cue'));
    for (const s of starts) s.cue = toCue(s.node);
    const toMusic = spec.trace === 'music' ? reacherOf(engine.busInput('music')) : null;
    const traced = toMusic ? starts.filter(s => toMusic(s.node)).map(s => s.t) : null;
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
        cues: wall(log.cues),
        scheduled: wall(log.scheduled).map(s => ({ ...s, notes: s.notesMs.map(toT) })),
        ducks: log.ducks,
        accents: log.accents,
        levels: log.levels,
        stateLog: wall(stateLog),
        captions: captions ? wall(captions.shown) : null,
        finalSnapshot: snap,
        cueScore: plain(cueScoreDiagnostics()),
        clock: { fired: vc.fired, errors: vc.errors.slice(0, 20), timersLeft: vc.timers() },
        rng: rngInfo,
        pinned,
        airOff,
        contextStates: wall(ctx.__vcStateLog),
        timers: timerReport(),
        diagnostics: engineDiagnostics(engine),
        sea: seaState(controller),
        work: log.work,
        workCancelled: log.workCancelled,
        workshops: workshopState(controller),
        rituals: conductor ? conductor.drawn() : null,
        cameraSeam,
        bakes,
        workletNodes,
        musicOnsets: traced,
        starts: (spec.collect || []).includes('starts')
            ? starts.map(({ node, ...s }) => ({ ...s, e: Number.isFinite(s.e) ? s.e : null }))
            : null,
        startCount: starts.length,
    };
}

// Sound off (3.3, 3.8): the controller built as TopBar builds it at boot and
// never enabled — no AudioContext — with the virtual clock stepped to the
// end. What remains is the signal route: captions (`audio:cue-played`), the
// published scores, the ladder's state and, with `captions: [settings]`,
// what a real Toast renders per caption setting. Every time is seconds from
// the start. spec: { mode, world, atmosphere, seconds, actions, storage,
// captions, stepMs }.
export async function runSilent(spec) {
    const rngInfo = await setupRng(spec);
    seedSoundStorage({ ...spec, soundOff: true });
    const world = makeWorld(spec.world);
    let { snapshot } = atmosphereFor(spec.atmosphere);
    eventBus.emit('atmosphere:updated', snapshot);
    const pump = setInterval(() => eventBus.emit('atmosphere:updated', snapshot), 400);
    const perfBase = vc.now;
    const toT = ms => (ms - perfBase) / 1000;
    const log = { cues: [], scheduled: [], levels: [] };
    let controller = null;
    logCues(log, () => toT(vc.now), () => controller?.cues?.kit ?? null);
    const captions = await installCaptions(spec.captions, false);
    controller = new AmbientAudioController({ world });
    const { markers, mark } = makeMarker(() => ({ currentTime: toT(vc.now) }));
    const stateLog = [];
    setInterval(() => {
        const snap = window.__claudevilleAudio?.();
        const s = signalState(controller, snap);
        if (s.ladder || s.heldNote) stateLog.push(plain({ t: toT(vc.now), state: snap?.state ?? null, ...s }));
    }, 1000);
    scheduleActions(spec.actions, { world, mark, controller, captions, at: sec => perfBase + sec * 1000, onAtmosphere: (s) => { snapshot = s; } });
    const end = perfBase + spec.seconds * 1000;
    const wallStart = vc.real.performanceNow();
    while (vc.now < end) await vc.advanceTo(Math.min(end, vc.now + (spec.stepMs || 1000)));
    clearInterval(pump);
    const snap = plain(window.__claudevilleAudio?.());
    const shown = captions ? captions.shown.map(({ perf, ...r }) => ({ ...r, t: toT(perf) })) : null;
    captions?.destroy();
    return {
        seconds: spec.seconds, renderMs: vc.real.performanceNow() - wallStart,
        markers,
        cues: log.cues.map(({ perf, ...r }) => r),
        scheduled: log.scheduled.map(({ perf, ...s }) => ({ ...s, notes: s.notesMs.map(toT) })),
        captions: shown, stateLog, finalSnapshot: snap,
        contextCreated: Boolean(controller.engine?.context),
        clock: { fired: vc.fired, errors: vc.errors.slice(0, 20) }, rng: rngInfo,
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

// Island Air (2.4, S5) on the engine alone: waits for the two baked IRs and
// publishes them (`irDay`, `irNight`, at their own rate), then renders
// decaying 8 ms noise bursts through `engine.connectVoice` at the
// placements SpatialField gives (world kind): `bursts: [{ at, screen:
// {screenX, screenY, viewportW, viewportH} }]`. Taps: the world bus (dry)
// and the air's wet return, both before the program trim.
export async function runAirUnit(spec) {
    const sampleRate = spec.sampleRate || 48000;
    const stems = ['world', 'airWet'];
    const rngInfo = await setupRng(spec);
    const ctx = sceneContext({ seconds: spec.seconds, stems, sampleRate });
    const { place } = await import('/src/presentation/shared/audio/SpatialField.js');
    const engine = new AudioEngine();
    engine.setVolumeStep(10);
    const ready = engine.ensureContext();
    let ok = false;
    ready.then((v) => { ok = v; });
    await pumpUntil(() => ok, 'ensureContext');
    engine.fadeGain.gain.value = 1;
    engine.started = true;
    engine.start?.();
    await pumpUntil(() => Boolean(engine.air?.buffers?.().day && engine.air.buffers().night), 'the Island Air bake');
    engine.setAirPhase?.(spec.phase || 'day');
    attachStems(ctx, engine, stems);
    const placements = [];
    const bus = spec.bus || 'world';
    for (const b of spec.bursts || []) {
        const p = place(b.screen, { kind: spec.kind || 'world' });
        placements.push({ at: b.at, ...plain(p) });
        const n = Math.round(0.008 * sampleRate);
        const buf = ctx.createBuffer(1, n, sampleRate);
        const d = buf.getChannelData(0);
        let seed = 0x2468ace;
        for (let i = 0; i < n; i++) {
            seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
            d[i] = 0.5 * ((seed / 4294967296) * 2 - 1) * Math.exp(-i / (0.002 * sampleRate));
        }
        const src = new AudioBufferSourceNode(ctx, { buffer: buf });
        const g = new GainNode(ctx, { gain: p.gain });
        src.connect(g);
        engine.connectVoice(g, { bus, pan: p.pan, air: p.air, lowpassHz: p.lowpassHz });
        src.start(b.at);
    }
    const perfBase = vc.now - ctx.currentTime * 1000;
    const irs = engine.air.buffers();
    const pair = b => [b.getChannelData(0).slice(), b.getChannelData(b.numberOfChannels > 1 ? 1 : 0).slice()];
    const extra = { irDay: pair(irs.day), irNight: pair(irs.night) };
    const buffer = await renderStepped(ctx, { perfBase, stepFrames: 4096 });
    const names = publishPcm(buffer, stems, extra);
    return {
        sampleRate, frames: buffer.length, names, placements, rng: rngInfo,
        irRates: { irDay: irs.day.sampleRate, irNight: irs.night.sampleRate },
        diagnostics: engineDiagnostics(engine), timers: timerReport(),
    };
}

window.__vcRender = { runVirtual, runSilent, runEngineUnit, runAirUnit, stage };

window.__vcReady = true;
