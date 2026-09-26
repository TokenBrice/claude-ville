// The baseline catalog. Every target is either:
//   method 'offline'  — CueKit voices rendered sample-accurately on an
//                       OfflineAudioContext through the real engine chain;
//   method 'realtime' — the real AmbientAudioController running in headless
//                       Chromium, recorded through the destination tap;
//   method 'app'      — the full app (isolated server, ?sim=1, renderer on),
//                       sound enabled by clicking the real topbar toggle.
//
// Realtime world/atmosphere vocabulary (see page/runtime.js):
//   world.counts      {working, waiting, waiting_on_user, idle, errored, ...}
//   atmosphere        {phase, progress, weather:{type,intensity,precipitation,fog,windX}}
//   isolate           layer name; every other ambient layer pinned to 0 via forceLayer()
//   actions[]         {at, emit, payload, agentIndex, label} | {at, status:{index,status}} | {at, addAgent} | {at, mode}

const PROVIDERS = ['default', 'claude', 'codex', 'gemini', 'grok', 'kimi', 'omp', 'opencode', 'deepseek', 'zai'];
const BUSY = { working: 5, idle: 2 };
// The agent status each actionable cue kind stands for (bucket routing, plan 0.3).
const CUE_STATUS = { distress: 'errored', limit: 'rate_limited', summons: 'waiting_on_user' };

function cue(name, kind, payload = {}, { seconds = 5, at = 0.25, volumeStep } = {}) {
    return { name, category: 'cues', method: 'offline', seconds, volumeStep, cues: [{ at, kind, payload }] };
}

export function buildTargets() {
    const t = [];

    // ---------------------------------------------------------------- cues
    t.push(cue('cue-arrival', 'arrival', { provider: null }));
    t.push(cue('cue-departure', 'departure', { provider: null }));
    t.push(cue('cue-distress-errored', 'distress', { status: 'errored' }, { seconds: 5 }));
    t.push(cue('cue-limit', 'limit', { status: 'rate_limited' }, { seconds: 5 }));
    t.push(cue('cue-recovery', 'recovery', {}));
    t.push(cue('cue-council-3', 'council', { teamSize: 3 }, { seconds: 5 }));
    t.push(cue('cue-council-5', 'council', { teamSize: 5 }, { seconds: 6 }));
    t.push(cue('cue-hourBell', 'hourBell', { hour: 9, count: false }, { seconds: 6 }));
    t.push(cue('cue-hourBell-counted-12', 'hourBell', { hour: 12, count: true }, { seconds: 16 }));
    t.push(cue('cue-hourBell-counted-15', 'hourBell', { hour: 15, count: true }, { seconds: 10 }));
    t.push(cue('cue-aurora', 'aurora', {}, { seconds: 5 }));
    t.push(cue('cue-summons-calm', 'summons', { status: 'waiting_on_user', waitingCount: 1, oldestWaitMs: 0 }));
    t.push(cue('cue-summons-urgent', 'summons', { status: 'waiting_on_user', waitingCount: 5, oldestWaitMs: 20 * 60000 }));
    // Wave 3: the ladder's reminders (the needs-you family voice), the
    // Signals-preset answer, the outcome stratum and the scenery additions.
    for (const level of [2, 3, 4]) t.push(cue(`cue-reminder-L${level}`, 'reminder', { level, family: 'needsYou', count: 1, oldestMs: 6 * 60000 }, { seconds: 6 }));
    t.push(cue('cue-reminder-errors-L3', 'reminder', { level: 3, family: 'errors', count: 1, oldestMs: 6 * 60000 }, { seconds: 6 }));
    t.push(cue('cue-answered', 'answered', {}, { seconds: 3 }));
    for (const kind of ['turnDone', 'subagentReturn', 'toolFailed', 'commit', 'push', 'pushFailed']) t.push(cue(`cue-${kind}`, kind, { count: 1 }, { seconds: 4 }));
    t.push(cue('cue-dispatch', 'dispatch', { count: 3 }, { seconds: 4 }));
    t.push(cue('cue-release', 'release', {}, { seconds: 7 }));
    t.push(cue('cue-linkLost', 'linkLost', {}, { seconds: 4 }));
    t.push(cue('cue-linkRestored', 'linkRestored', {}, { seconds: 4 }));
    t.push(cue('cue-digest', 'digest', { notes: ['gold', 'stone', 'red', 'amber'] }, { seconds: 5 }));
    t.push(cue('cue-thunder-0.3', 'thunder', { intensity: 0.3 }, { seconds: 6 }));
    t.push(cue('cue-thunder-0.6', 'thunder', { intensity: 0.6 }, { seconds: 6 }));
    t.push(cue('cue-thunder-1.0', 'thunder', { intensity: 1 }, { seconds: 6 }));
    t.push(cue('cue-thunder-1.0-vol100', 'thunder', { intensity: 1 }, { seconds: 6, volumeStep: 10 }));
    // Night borrows the minor third: every pitched cue whose notes change.
    for (const kind of ['arrival', 'recovery', 'council', 'aurora', 'summons', 'hourBell']) {
        t.push(cue(`cue-${kind}-night`, kind, { phase: 'night', teamSize: 5, hour: 21, status: kind === 'summons' ? 'waiting_on_user' : undefined }, { seconds: kind === 'council' || kind === 'hourBell' ? 6 : 5 }));
    }
    // One gallery strip with every kind, 4.5 s apart, for side-by-side reading.
    const gallery = [
        'arrival', 'departure', 'recovery', 'council', 'aurora', 'hourBell', 'distress', 'limit', 'summons', 'reminder', 'answered',
        'turnDone', 'subagentReturn', 'toolFailed', 'commit', 'push', 'release', 'pushFailed', 'dispatch', 'linkLost', 'linkRestored', 'digest', 'thunder',
    ];
    t.push({
        name: 'cue-gallery', category: 'cues', method: 'offline', seconds: gallery.length * 4.5 + 3,
        cues: gallery.map((kind, i) => ({
            at: 0.5 + i * 4.5, kind, label: kind,
            payload: { status: CUE_STATUS[kind], teamSize: 4, intensity: 0.7, hour: 9, count: kind === 'dispatch' ? 3 : kind === 'hourBell' ? false : 1, level: kind === 'reminder' ? 3 : 1, family: 'needsYou', notes: ['gold', 'red', 'amber'] },
        })),
    });
    // Alloys (3.5): the provider tints the routine chimes only; signals are
    // never provider-tinted.
    for (const kind of ['arrival', 'departure', 'recovery']) {
        t.push({
            name: `cue-${kind}-providers`, category: 'cues-providers', method: 'offline', seconds: PROVIDERS.length * 3.2 + 2.5,
            cues: PROVIDERS.map((provider, i) => ({
                at: 0.4 + i * 3.2, kind, label: provider,
                payload: { provider: provider === 'default' ? null : provider, status: CUE_STATUS[kind] },
            })),
        });
        for (const provider of PROVIDERS) {
            t.push({
                ...cue(`cue-${kind}-${provider}`, kind, { provider: provider === 'default' ? null : provider, status: CUE_STATUS[kind] }, { seconds: kind === 'distress' ? 4.5 : 3.5 }),
                category: 'cues-providers',
            });
        }
    }
    // Spatial pan: left / centre / right.
    for (const [label, screenX] of [['left', 0], ['centre', 0.5], ['right', 1]]) {
        t.push({ ...cue(`cue-arrival-pan-${label}`, 'arrival', { provider: 'claude', screenX }, { seconds: 3.5 }), category: 'cues-pan' });
        t.push({ ...cue(`cue-summons-pan-${label}`, 'summons', { provider: 'claude', screenX, status: 'waiting_on_user' }, { seconds: 3.5 }), category: 'cues-pan' });
    }

    // -------------------------------------------------------------- layers
    const layer = (name, isolate, atmosphere, world = BUSY, seconds = 30, warmup = 15) => ({
        name, category: 'layers', method: 'realtime', mode: 'ambient', isolate, atmosphere, world: { counts: world }, seconds, warmup,
    });
    // 4.1: the sea (group 'wind', *Weather & sea*) by day, at night and in a storm.
    t.push(layer('layer-sea-day', 'sea', { phase: 'day', weather: { type: 'clear', windX: 0.3 } }, BUSY, 60));
    t.push(layer('layer-sea-night-clear', 'sea', { phase: 'night', weather: { type: 'clear', windX: 0.3 } }, BUSY, 60));
    t.push(layer('layer-sea-storm', 'sea', { phase: 'night', weather: { type: 'storm', intensity: 0.95, windX: 1.4 } }, BUSY, 60));
    t.push(layer('layer-wind-calm', 'wind', { phase: 'day', weather: { type: 'clear', windX: 0.3 } }));
    t.push(layer('layer-wind-overcast', 'wind', { phase: 'day', weather: { type: 'overcast', windX: 0.8 } }));
    t.push(layer('layer-wind-storm', 'wind', { phase: 'night', weather: { type: 'storm', intensity: 0.95, windX: 1.4 } }));
    t.push(layer('layer-rain-light', 'rain', { phase: 'day', weather: { type: 'rain', intensity: 0.4, precipitation: 0.25 } }));
    t.push(layer('layer-rain-heavy-storm', 'rain', { phase: 'night', weather: { type: 'storm', intensity: 0.95, precipitation: 1 } }));
    t.push(layer('layer-birds-dawn', 'birds', { phase: 'dawn', progress: 0.9, weather: { type: 'clear' } }, BUSY, 45));
    t.push(layer('layer-birds-day', 'birds', { phase: 'day', weather: { type: 'clear' } }, BUSY, 60));
    t.push(layer('layer-crickets-night', 'crickets', { phase: 'night', progress: 0.5, weather: { type: 'clear' } }, BUSY, 30));
    t.push(layer('layer-hum-0-workers', 'hum', { phase: 'day', weather: { type: 'clear' } }, { waiting: 1, idle: 2 }, 20));
    t.push(layer('layer-hum-3-workers', 'hum', { phase: 'day', weather: { type: 'clear' } }, { working: 3, idle: 1 }, 40));
    t.push(layer('layer-hum-6-workers', 'hum', { phase: 'day', weather: { type: 'clear' } }, { working: 6 }, 40));

    // ------------------------------------------------ ambient music layer
    const tune = (name, tuneName, phase, world = BUSY) => ({
        name, category: 'music-layer', method: 'realtime', mode: 'ambient', isolate: 'music',
        atmosphere: { phase, progress: 0.5, weather: { type: 'clear' } }, world: { counts: world },
        music: { tune: tuneName, gateMs: 9000 }, warmup: 0, tailSeconds: 3, maxSeconds: 170,
    });
    t.push(tune('music-hearthfire-day', 'hearthfire', 'day'));
    t.push(tune('music-millbrook-day', 'millbrook', 'day'));
    t.push(tune('music-hearthfire-dusk', 'hearthfire', 'dusk'));
    t.push(tune('music-millbrook-dawn', 'millbrook', 'dawn'));
    t.push(tune('music-lanternway-night', 'lanternway', 'night'));
    t.push(tune('music-starwake-night', 'starwake', 'night'));

    // ------------------------------------------------------------- BGM
    const bgm = (name, piece, phase, world = BUSY, loop = 2) => ({
        name, category: 'bgm', method: 'realtime', mode: 'bgm',
        atmosphere: { phase, progress: 0.5, weather: { type: 'clear' } }, world: { counts: world },
        bgm: { piece, loop }, warmup: 0, maxSeconds: 200,
    });
    t.push(bgm('bgm-willowbrook-steady', 'willowbrook', 'day'));
    t.push(bgm('bgm-cobblemarket-steady', 'cobblemarket', 'day'));
    t.push(bgm('bgm-millwheel-steady', 'millwheel', 'day'));
    t.push(bgm('bgm-starfall-steady', 'starfall', 'night'));
    t.push(bgm('bgm-moonwell-steady', 'moonwell', 'night'));
    t.push(bgm('bgm-millwheel-full', 'millwheel', 'day', { working: 12 }));
    t.push(bgm('bgm-willowbrook-rest', 'willowbrook', 'day', { idle: 3 }));
    t.push(bgm('bgm-cobblemarket-light', 'cobblemarket', 'day', { working: 2, idle: 1 }));
    t.push({
        name: 'bgm-willowbrook-summons-arrival', category: 'bgm', method: 'realtime', mode: 'bgm',
        atmosphere: { phase: 'day', progress: 0.5, weather: { type: 'clear' } }, world: { counts: BUSY },
        bgm: { piece: 'willowbrook', loop: 1 }, warmup: 4, seconds: 44,
        actions: [
            { at: 8, emit: 'village:scene', payload: { kind: 'arrival', screenX: 0.25 }, agentIndex: 5, label: 'arrival (village:scene)' },
            { at: 20, status: { index: 0, status: 'waiting_on_user' } },
            { at: 20.05, emit: 'attention:raised', payload: { waitingCount: 1, oldestWaitMs: 0, status: 'waiting_on_user', screenX: 0.7 }, agentIndex: 0, label: 'summons (attention:raised)' },
            { at: 32, emit: 'distress:watchtower', payload: { kind: 'errored' }, agentIndex: 1, label: 'distress (errored)' },
        ],
    });

    // A night piece, then a preset switch back to the reactive ambience: the
    // player stop and the ambient layers' start in one render.
    t.push({
        name: 'bgm-night-to-ambient', category: 'bgm', method: 'realtime', mode: 'bgm',
        atmosphere: { phase: 'night', progress: 0.5, weather: { type: 'clear' } }, world: { counts: BUSY },
        bgm: { piece: 'moonwell', loop: 0 }, warmup: 2, seconds: 26,
        actions: [{ at: 16, mode: 'ambient' }],
    });

    // ------------------------------------------------------ director mixes
    const mix = (name, atmosphere, world, extra = {}) => ({
        name, category: 'mix', method: 'realtime', mode: 'ambient', atmosphere, world: { counts: world }, warmup: 20, seconds: 60, ...extra,
    });
    t.push(mix('mix-day-clear-busy', { phase: 'day', progress: 0.5, weather: { type: 'clear', windX: 0.4 } }, { working: 6, idle: 2 }, {
        actions: [
            { at: 24, emit: 'village:scene', payload: { kind: 'arrival', screenX: 0.3 }, agentIndex: 6, label: 'arrival' },
            { at: 44, emit: 'team:gather', payload: { teamName: 'harness', members: [1, 2, 3, 4] }, label: 'council (4)' },
        ],
    }));
    t.push(mix('mix-dawn-chorus', { phase: 'dawn', progress: 0.8, weather: { type: 'clear', windX: 0.3 } }, { working: 2, idle: 3 }));
    t.push(mix('mix-dusk', { phase: 'dusk', progress: 0.4, weather: { type: 'partly-cloudy', windX: 0.6 } }, { working: 3, idle: 2 }));
    t.push(mix('mix-night-storm', { phase: 'night', progress: 0.5, weather: { type: 'storm', intensity: 0.9, windX: 1.2 } }, { working: 2, idle: 2 }, {
        actions: [
            { at: 8, emit: 'weather:storm-flash', payload: { intensity: 0.8 }, label: 'storm-flash 0.8' },
            { at: 27, emit: 'weather:storm-flash', payload: { intensity: 1 }, label: 'storm-flash 1.0' },
            { at: 44, emit: 'weather:storm-flash', payload: { intensity: 0.5 }, label: 'storm-flash 0.5' },
        ],
    }));
    t.push(mix('mix-night-clear', { phase: 'night', progress: 0.5, weather: { type: 'clear', windX: 0.3 } }, { working: 1, idle: 3 }));
    t.push(mix('mix-resting', { phase: 'day', progress: 0.5, weather: { type: 'clear', windX: 0.3 } }, { idle: 3 }, { warmup: 36, seconds: 40 }));
    t.push(mix('mix-day-rain-urgent', { phase: 'day', progress: 0.5, weather: { type: 'rain', intensity: 0.7 } }, { working: 4, idle: 1 }, {
        actions: [
            { at: 12, status: { index: 0, status: 'waiting_on_user' } },
            { at: 12.05, emit: 'attention:raised', payload: { waitingCount: 1, status: 'waiting_on_user', screenX: 0.8 }, agentIndex: 0, label: 'summons' },
            { at: 30, emit: 'distress:watchtower', payload: { kind: 'errored', screenX: 0.2 }, agentIndex: 1, label: 'distress (errored)' },
            { at: 46, emit: 'distress:watchtower', payload: { kind: 'recovered', screenX: 0.2 }, agentIndex: 1, label: 'recovery' },
        ],
    }));
    t.push({ ...mix('mix-night-storm-vol100', { phase: 'night', progress: 0.5, weather: { type: 'storm', intensity: 0.9, windX: 1.2 } }, { working: 2, idle: 2 }, {
        volumeStep: 10, seconds: 40,
        actions: [{ at: 10, emit: 'weather:storm-flash', payload: { intensity: 1 }, label: 'storm-flash 1.0' }],
    }), category: 'mix' });
    t.push({ ...mix('mix-day-clear-busy-vol100', { phase: 'day', progress: 0.5, weather: { type: 'clear', windX: 0.4 } }, { working: 6, idle: 2 }, { volumeStep: 10, seconds: 40 }), category: 'mix' });

    // --------------------------------------------------------- fidelity
    t.push({ name: 'repeat-mix-day-clear-busy', category: 'fidelity', method: 'realtime', mode: 'ambient', atmosphere: { phase: 'day', progress: 0.5, weather: { type: 'clear', windX: 0.4 } }, world: { counts: { working: 6, idle: 2 } }, warmup: 20, seconds: 60, seedOffset: 0, repeatOf: 'mix-day-clear-busy',
        actions: [
            { at: 24, emit: 'village:scene', payload: { kind: 'arrival', screenX: 0.3 }, agentIndex: 6, label: 'arrival' },
            { at: 44, emit: 'team:gather', payload: { teamName: 'harness', members: [1, 2, 3, 4] }, label: 'council (4)' },
        ] });
    t.push({ name: 'app-live-sim-day', category: 'fidelity', method: 'app', hour: 13.3, weather: 'clear', warmup: 15, seconds: 40 });

    return t;
}
