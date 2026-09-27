// The baseline catalog. Every target is either:
//   method 'offline'  — CueKit voices rendered sample-accurately on an
//                       OfflineAudioContext through the real engine chain;
//   method 'realtime' — the real AmbientAudioController running in headless
//                       Chromium, recorded through the destination tap;
//   method 'app'      — the full app (isolated server, ?sim=1, renderer on),
//                       sound enabled through the real topbar note (Town band).
//
// Realtime world/atmosphere vocabulary (see page/runtime.js):
//   mode              'bgm' (Town band) | 'signals' (no music, silence between cues)
//   world.counts      {working, waiting, waiting_on_user, idle, errored, ...}
//   atmosphere        {phase, progress, weather:{type,intensity,precipitation,fog,windX}}
//   bgm               {piece, loop}: the pinned Town band piece and the loop recorded
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
    // Night borrows the minor third: every pitched cue whose notes change.
    for (const kind of ['arrival', 'recovery', 'council', 'aurora', 'summons', 'hourBell']) {
        t.push(cue(`cue-${kind}-night`, kind, { phase: 'night', teamSize: 5, hour: 21, status: kind === 'summons' ? 'waiting_on_user' : undefined }, { seconds: kind === 'council' || kind === 'hourBell' ? 6 : 5 }));
    }
    // One gallery strip with every kind, 4.5 s apart, for side-by-side reading.
    const gallery = [
        'arrival', 'departure', 'recovery', 'council', 'aurora', 'hourBell', 'distress', 'limit', 'summons', 'reminder', 'answered',
        'turnDone', 'subagentReturn', 'toolFailed', 'commit', 'push', 'release', 'pushFailed', 'dispatch', 'linkLost', 'linkRestored', 'digest',
    ];
    t.push({
        name: 'cue-gallery', category: 'cues', method: 'offline', seconds: gallery.length * 4.5 + 3,
        cues: gallery.map((kind, i) => ({
            at: 0.5 + i * 4.5, kind, label: kind,
            payload: { status: CUE_STATUS[kind], teamSize: 4, hour: 9, count: kind === 'dispatch' ? 3 : kind === 'hourBell' ? false : 1, level: kind === 'reminder' ? 3 : 1, family: 'needsYou', notes: ['gold', 'red', 'amber'] },
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

    // ------------------------------------------------------ Town band (BGM)
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
    // The fullest band at unity volume (step 10): the limiter and true peak.
    t.push({ ...bgm('bgm-millwheel-full-vol100', 'millwheel', 'day', { working: 12 }), volumeStep: 10 });
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

    // A night piece, then a preset switch to Signals: the band's fade out
    // (800 ms, UX-3) and the silence after it (Signals has no bed) in one
    // render.
    t.push({
        name: 'bgm-night-to-signals', category: 'bgm', method: 'realtime', mode: 'bgm',
        atmosphere: { phase: 'night', progress: 0.5, weather: { type: 'clear' } }, world: { counts: BUSY },
        bgm: { piece: 'moonwell', loop: 0 }, warmup: 2, seconds: 26,
        actions: [{ at: 16, mode: 'signals' }],
    });

    // ------------------------------------------------------------ Signals
    // The Signals preset sounds only summons/distress/limit/reminder/
    // answered/recovery and captions every other kind, over no bed at all:
    // the three signals ring out of silence, and the arrival between them
    // must stay silent.
    t.push({
        name: 'signals-day-urgent', category: 'signals', method: 'realtime', mode: 'signals',
        atmosphere: { phase: 'day', progress: 0.5, weather: { type: 'clear' } }, world: { counts: { working: 4, idle: 1 } },
        warmup: 4, seconds: 40,
        actions: [
            { at: 4, status: { index: 0, status: 'waiting_on_user' } },
            { at: 4.05, emit: 'attention:raised', payload: { waitingCount: 1, status: 'waiting_on_user', screenX: 0.8 }, agentIndex: 0, label: 'summons' },
            { at: 14, emit: 'village:scene', payload: { kind: 'arrival', screenX: 0.3 }, agentIndex: 2, label: 'arrival (captioned only)' },
            { at: 22, emit: 'distress:watchtower', payload: { kind: 'errored', screenX: 0.2 }, agentIndex: 1, label: 'distress (errored)' },
            { at: 32, emit: 'distress:watchtower', payload: { kind: 'recovered', screenX: 0.2 }, agentIndex: 1, label: 'recovery' },
        ],
    });

    // --------------------------------------------------------- fidelity
    // The same seed twice: realtime timer interleaving makes two runs close,
    // not identical.
    t.push({ ...bgm('repeat-bgm-willowbrook-steady', 'willowbrook', 'day'), category: 'fidelity', seedOffset: 0, repeatOf: 'bgm-willowbrook-steady' });
    t.push({ name: 'app-live-sim-day', category: 'fidelity', method: 'app', hour: 13.3, weather: 'clear', warmup: 15, seconds: 40 });

    return t;
}
