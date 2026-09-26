// The virtual-clock probe's named scenes (page/virtual.js specs). Scene
// time: `warmup` seconds settle the enable fade and the director's level
// slews and are discarded; action `at` is seconds after warmup.
// Targets live in Loudness.js (S2); the judges in checks.mjs.

const DAY = Object.freeze({ phase: 'day', progress: 0.5, weather: { type: 'clear', windX: 0.3 } });
const RAIN = Object.freeze({ phase: 'day', progress: 0.5, weather: { type: 'rain', intensity: 0.7, windX: 0.6 } });
const STORM = Object.freeze({ phase: 'day', progress: 0.5, weather: { type: 'storm', intensity: 0.9, windX: 1.2 } });
const NIGHT = Object.freeze({ phase: 'night', progress: 0.5, weather: { type: 'clear', windX: 0.3 } });

// One lane's cue through the real producers (the harness page has no
// AttentionService or VillageDirector, so the probe emits their events):
// the agent's status is set first, so bucket routing sees it.
export const LANE_CUE_KIND = Object.freeze({
    needsYou: 'summons', error: 'distress', limit: 'limit', routine: 'arrival', scenery: 'aurora',
    outcomeMinor: 'turnDone', outcomeMedium: 'push', outcomeMajor: 'release',
});
const LANE_STATUS = { needsYou: 'waiting_on_user', error: 'errored', limit: 'rate_limited' };
// A long turn (≥ 20 s, 3.4) ends: the agent is seen working, then idle.
const LONG_TURN_MS = 25000;

export function laneActions(lane, at, agentIndex) {
    const tag = { lane, label: `${lane}#${agentIndex}` };
    if (lane === 'needsYou') {
        return [
            { at, status: { index: agentIndex, status: LANE_STATUS.needsYou } },
            { at: at + 0.01, emit: 'attention:raised', payload: { waitingCount: 1, oldestWaitMs: 0, status: LANE_STATUS.needsYou }, agentIndex, ...tag },
        ];
    }
    if (lane === 'error' || lane === 'limit') {
        return [
            { at, status: { index: agentIndex, status: LANE_STATUS[lane] } },
            { at: at + 0.01, emit: 'distress:watchtower', payload: { kind: LANE_STATUS[lane] }, agentIndex, ...tag },
        ];
    }
    if (lane === 'routine') return [{ at, emit: 'village:scene', payload: { kind: 'arrival' }, agentIndex, ...tag }];
    if (lane === 'scenery') return [{ at, emit: 'chronicle:aurora', payload: {}, ...tag }];
    if (lane === 'outcomeMinor') {
        return [
            { at: at - 1, status: { index: agentIndex, status: 'working' } },
            { at, status: { index: agentIndex, status: 'idle', fields: { lastTurnDurationMs: LONG_TURN_MS } }, ...tag },
        ];
    }
    if (lane === 'outcomeMedium' || lane === 'outcomeMajor') {
        return [{ at, emit: 'outcome:verified', payload: { kind: lane === 'outcomeMedium' ? 'push' : 'release', project: 'probe' }, agentIndex, ...tag }];
    }
    throw new Error(`unknown lane ${lane}`);
}

// A three-minute busy stretch of a workday, in the spirit of SCN's busy
// session (fixtures/scn-plans.mjs), through the harness's producers.
function busyActions() {
    return [
        ...laneActions('needsYou', 20, 0),
        { at: 45, addAgent: { status: 'working', provider: 'codex' } },
        { at: 45.05, emit: 'village:scene', payload: { kind: 'arrival' }, agentIndex: 8, label: 'arrival', lane: 'routine' },
        { at: 70, status: { index: 0, status: 'working' } },
        ...laneActions('error', 95, 1),
        { at: 120, addAgent: { status: 'working', provider: 'gemini' } },
        { at: 120.05, emit: 'village:scene', payload: { kind: 'arrival' }, agentIndex: 9, label: 'arrival', lane: 'routine' },
        { at: 140, status: { index: 1, status: 'working' } },
        { at: 140.01, emit: 'distress:watchtower', payload: { kind: 'recovered' }, agentIndex: 1, label: 'recovery', lane: 'routine' },
        ...laneActions('limit', 160, 2),
        { at: 172, emit: 'village:scene', payload: { kind: 'departure' }, agentIndex: 7, label: 'departure', lane: 'routine' },
    ];
}

const BUSY_WORLD = { counts: { working: 6, idle: 2 } };

export const SCENES = {
    // Anchor A: calm clear day, world stratum only (work and music trims off).
    anchor: { mode: 'ambient', world: { counts: { working: 4, idle: 1 } }, layerSteps: { hum: 0, music: 0 }, atmosphere: DAY, warmup: 10, seconds: 60, stems: ['world'], collect: ['starts'] },
    villageBusy: { mode: 'ambient', world: BUSY_WORLD, atmosphere: DAY, warmup: 10, seconds: 180, actions: busyActions(), stems: ['world', 'work', 'music', 'cue'] },
    townBand: { mode: 'bgm', world: BUSY_WORLD, atmosphere: DAY, warmup: 10, seconds: 180, actions: busyActions(), stems: ['music', 'cue'] },
    rain: { mode: 'ambient', world: { counts: { working: 4, idle: 1 } }, atmosphere: RAIN, warmup: 10, seconds: 60, stems: ['world'], collect: ['starts'] },
    storm: {
        mode: 'ambient', world: { counts: { working: 4, idle: 1 } }, atmosphere: STORM, warmup: 10, seconds: 60, stems: ['world', 'limiterIn', 'limiterOut'], collect: ['starts'],
        actions: [0.8, 1, 0.5].map((intensity, i) => ({ at: 8 + i * 18, emit: 'weather:storm-flash', payload: { intensity }, label: `storm-flash ${intensity}` })),
    },
    // Nobody working, nothing actionable: the quiet floor enters resting after
    // 30 s, so the recording starts after 40.
    resting: { mode: 'ambient', world: { counts: { idle: 3 } }, atmosphere: DAY, warmup: 40, seconds: 30, stems: ['world'] },
    // The anchor's staging at night (C-AMB-3's night bed; 4.1's sea at night).
    nightClear: { mode: 'ambient', world: { counts: { working: 4, idle: 1 } }, layerSteps: { hum: 0, music: 0 }, atmosphere: NIGHT, warmup: 10, seconds: 60, stems: ['world'], collect: ['starts'] },
    // S2's night row with its occasion (the program, music at its default)
    // against noon at the same load (gated from Wave 6: scene:nightProgram).
    nightProgram: { mode: 'ambient', world: { counts: { working: 3, idle: 1 } }, atmosphere: NIGHT, warmup: 10, seconds: 60 },
    noonProgram: { mode: 'ambient', world: { counts: { working: 3, idle: 1 } }, atmosphere: DAY, warmup: 10, seconds: 60 },
    // Must-never 12: AMBIENT → BGM at 15 s, back at 45 s.
    presetSwitch: {
        mode: 'ambient', world: { counts: { working: 4, idle: 1 } }, atmosphere: DAY, warmup: 15, seconds: 65,
        actions: [{ at: 15, mode: 'bgm' }, { at: 45, mode: 'ambient' }],
    },
    // HAR-12: body-anchored arrivals whose accent the "renderer" declares
    // 450–800 ms ahead (sooner than the cue's own lead, the sound follows the
    // body and lands late by design), plus free cues; published and accent
    // times vs heard. Cues sit 16 s apart — within the routine lane's 4/min
    // (6/min with 2/min reserved for outcomes) — and each kind ≥ its CueKit
    // cooldown (arrival and departure 20 s), so every one is admitted. No
    // music plays (C-CUE-5: the shipped offsets hold when no music plays;
    // with music, 3.5's grid moves body-anchored cues by up to 60 ms).
    avSync: {
        mode: 'ambient', world: { counts: { working: 12 } }, atmosphere: DAY, force: { music: 0 }, warmup: 8, seconds: 140, stems: ['cue'],
        actions: [
            ...[0, 1, 2, 3].map(i => ({ at: 2 + i * 32, accent: { kind: 'arrival', leadMs: 450 + 110 * i }, emit: 'village:scene', payload: { kind: 'arrival' }, agentIndex: i, label: `arrival (accent +${450 + 110 * i} ms)`, lane: 'routine' })),
            ...[0, 1, 2].map(i => ({ at: 18 + i * 32, emit: 'village:scene', payload: { kind: 'departure' }, agentIndex: 6 + i, label: 'departure', lane: 'routine' })),
            { at: 114, emit: 'distress:watchtower', payload: { kind: 'recovered' }, agentIndex: 10, label: 'recovery', lane: 'routine' },
            { at: 130, emit: 'team:gather', payload: { teamName: 'probe', members: ['probe-a', 'probe-b', 'probe-c'] }, label: 'council', lane: 'routine' },
        ],
    },
};

// Cue lanes over each probe bed: 3 placements per lane, 7 s apart, each on
// its own agent, lanes interleaved so no placement follows its own lane.
// Scenery (the aurora) has a 120 s CueKit cooldown and the release is the
// one Major outcome, so each is placed once. The Village bed is S2's
// "Village bed (no music)": its music is held at 0.
export const MARGIN_LANES = ['needsYou', 'error', 'limit', 'routine', 'scenery', 'outcomeMinor', 'outcomeMedium', 'outcomeMajor'];
export const MARGIN_BEDS = {
    village: { bed: 'village', mode: 'ambient', atmosphere: DAY, force: { music: 0 } },
    music: { bed: 'music', mode: 'bgm', atmosphere: DAY },
    rain: { bed: 'weather', mode: 'ambient', atmosphere: RAIN },
    storm: { bed: 'weather', mode: 'ambient', atmosphere: STORM },
};
export const MARGIN_PLACEMENTS = 3;
const MARGIN_SPACING = 7;
const PLACEMENTS_BY_LANE = { scenery: 1, outcomeMajor: 1 };

export function marginScene(bedName) {
    const bed = MARGIN_BEDS[bedName];
    const actions = [];
    let agent = 0;
    let slot = 0;
    for (let p = 0; p < MARGIN_PLACEMENTS; p++) {
        for (const lane of MARGIN_LANES) {
            if (p >= (PLACEMENTS_BY_LANE[lane] ?? MARGIN_PLACEMENTS)) continue;
            actions.push(...laneActions(lane, 3 + slot++ * MARGIN_SPACING, agent++));
        }
    }
    const seconds = 3 + slot * MARGIN_SPACING + 2;
    return {
        mode: bed.mode, world: { counts: { working: agent + 2 } }, atmosphere: bed.atmosphere, force: bed.force,
        warmup: 10, seconds, actions, stems: ['cue', 'world', 'work', 'music', 'limiterIn', 'limiterOut'],
    };
}

// The limiter units (1.1): a +12 dBFS burst (sine then noise) and a
// −20 dBFS sine for the static gain, at full slider.
export const LIMITER_UNIT = {
    seconds: 6, volumeStep: 10, stems: ['limiterIn', 'limiterOut'],
    signals: [
        { at: 1, dur: 1, hz: 1000, dbAtLimiter: -20 },
        { at: 3, dur: 0.5, hz: 1000, dbAtLimiter: 12 },
        { at: 4.5, dur: 0.5, noise: true, dbAtLimiter: 12 },
    ],
};

// ================================================================ Wave 2 ====

// 2.1 (ENG-8): ten minutes of a working village on the Transport, both
// presets, a weather change, with the lint's stack capture off so timer
// costs are the app's. Three busy stretches, rain at 5:00, Town band from
// 7:00 to 9:00.
export const TRANSPORT_SCENE = {
    mode: 'ambient', world: BUSY_WORLD, atmosphere: DAY, warmup: 10, seconds: 600, lint: false,
    actions: [
        ...[0, 180, 360].flatMap(offset => busyActions().map(a => ({ ...a, at: a.at + offset }))),
        { at: 300, atmosphere: RAIN, label: 'rain' },
        { at: 420, mode: 'bgm' },
        { at: 540, mode: 'ambient' },
    ],
};

// 2.1 pause in place: 120 s hidden, 30 s of steady state either side.
export const HIDDEN_AT = 30;
export const HIDDEN_SECONDS = 120;
// The context's clock freezes while the app holds it suspended (as a real
// suspended context does), so `seconds` counts audio time only.
export function hiddenScene(mode) {
    return {
        mode, world: BUSY_WORLD, atmosphere: DAY, warmup: 10, seconds: HIDDEN_AT + 35, collect: ['starts'], freezeOnSuspend: true,
        actions: [
            { at: HIDDEN_AT, visibility: 'hidden', label: 'hide' },
            { at: HIDDEN_AT + HIDDEN_SECONDS, visibility: 'visible', label: 'show' },
        ],
    };
}

// 2.5: each continuous texture alone (the others forced to 0), 60 s after
// the level slews settle; `stem` is the bus it plays on.
export const TEXTURE_SCENES = {
    wind: { stem: 'world', spec: { mode: 'ambient', isolate: 'wind', world: { counts: { working: 4 } }, atmosphere: { ...DAY, weather: { type: 'clear', windX: 1.0 } }, warmup: 10, seconds: 60, stems: ['world'], collect: ['starts'] } },
    rain: { stem: 'world', spec: { mode: 'ambient', isolate: 'rain', world: { counts: { working: 4 } }, atmosphere: RAIN, warmup: 10, seconds: 60, stems: ['world'], collect: ['starts'] } },
    hum: { stem: 'work', spec: { mode: 'ambient', isolate: 'hum', world: { counts: { working: 8 } }, atmosphere: DAY, warmup: 10, seconds: 60, stems: ['work'], collect: ['starts'] } },
    // 4.1: the sea alone by day and in a storm (C-AMB-3: sea ICC ≤ 0.4).
    sea: { stem: 'world', spec: { mode: 'ambient', isolate: 'sea', world: { counts: { working: 4 } }, atmosphere: DAY, warmup: 10, seconds: 60, stems: ['world'], collect: ['starts'] } },
    seaStorm: { stem: 'world', spec: { mode: 'ambient', isolate: 'sea', world: { counts: { working: 4 } }, atmosphere: STORM, warmup: 10, seconds: 60, stems: ['world'], collect: ['starts'] } },
};

// 2.4 Island Air on the engine alone: the two baked IRs (T60), and an 8 ms
// burst through connectVoice at raw place() values for d = 0 (screen
// centre) and d = 1 (the right edge), 4.5 s apart — INFO beside the cue
// path's D/R below.
const VIEW = { viewportW: 1440, viewportH: 900 };
export const AIR_UNIT = {
    seconds: 10, phase: 'day', kind: 'world', bus: 'world',
    bursts: [
        { at: 0.5, d: 0, screen: { screenX: 720, screenY: 450, ...VIEW } },
        { at: 5, d: 1, screen: { screenX: 1440, screenY: 450, ...VIEW } },
    ],
};

// Through the real cue path, over a dry bed (the bed's air sends cut, so
// the wet return carries cue sends only): an arrival placed at d = 0 and
// one at d = 1 (their direct-to-reverberant ratio), and three needs-you
// calls (urgent wet re dry). Arrivals sit 28 s apart (CueKit's 20 s
// arrival cooldown).
export const AIR_ARRIVALS = [{ at: 3, d: 0, x: 0.5 }, { at: 31, d: 1, x: 1 }];
export const AIR_CUE_SCENE = {
    mode: 'ambient', world: { counts: { working: 6 } }, atmosphere: DAY, warmup: 10, seconds: 38,
    actions: [
        ...AIR_ARRIVALS.map(a => ({ at: a.at, emit: 'village:scene', payload: { kind: 'arrival', normalizedScreenX: a.x, normalizedScreenY: 0.5 }, agentIndex: 4 + a.d, label: `arrival d = ${a.d}`, lane: 'routine' })),
        ...[0, 1, 2].flatMap(i => laneActions('needsYou', 10 + i * 7, i)),
    ],
    stems: ['cue', 'airWet'], airOff: 'bed',
};

// Air contribution: the village busy scene with every air send cut.
export const VILLAGE_DRY_SCENE = { ...SCENES.villageBusy, stems: [], airOff: 'all' };

// 2.3: every shipped piece, one per render, all random draws pinned to 0.5
// (so the Wave-1 reference and the sequencer make the same choices), the
// music bus traced. Town band: one loop of the pinned piece. Village: one
// song at a held level (isolated), started at its first slot.
export const TOWN_BAND_PIECES = ['willowbrook', 'cobblemarket', 'millwheel', 'starfall', 'moonwell'];
const VILLAGE_TUNE_BPM = { hearthfire: 88, millbrook: 72, lanternway: 56, starwake: 60 };
const VILLAGE_TUNE_PHASE = { hearthfire: 'day', millbrook: 'day', lanternway: 'night', starwake: 'night' };
// Pickup (1 bar) + four 4-bar sections + outro (1.5 bars).
const VILLAGE_SONG_BARS = 18.5;

export function sequencerPieces(pieces) {
    const town = TOWN_BAND_PIECES.map((name) => {
        const piece = pieces.find(p => p.name === name);
        if (!piece) throw new Error(`the songbook has no ${name}`);
        const loopSec = piece.chords.length * 4 * 60 / piece.bpm;
        return {
            key: `townBand:${name}`, preset: 'townBand', piece: name, loopSec,
            spec: { mode: 'bgm', bgm: { piece: name }, world: BUSY_WORLD, atmosphere: piece.family === 'night' ? NIGHT : DAY, warmup: 0, seconds: Math.ceil(loopSec + 4), rng: { constant: 0.5 }, trace: 'music' },
        };
    });
    const village = Object.entries(VILLAGE_TUNE_BPM).map(([name, bpm]) => ({
        key: `village:${name}`, preset: 'village', piece: name, loopSec: null,
        spec: {
            mode: 'ambient', isolate: 'music', music: { piece: name, level: 0.6 }, world: { counts: { working: 4, idle: 1 } },
            atmosphere: VILLAGE_TUNE_PHASE[name] === 'night' ? NIGHT : DAY, warmup: 0,
            seconds: Math.ceil(4 + VILLAGE_SONG_BARS * 4 * 60 / bpm + 4), rng: { constant: 0.5 }, trace: 'music',
        },
    }));
    return [...town, ...village];
}

// ================================================================ Wave 3 ====

// 3.1–3.6 / S1: every cue voice once, governor-free (the capture tool's
// path: what a voice sounds like once admitted), over a silent island
// (every layer held at 0) on the cue stem, each in its own slot. `stratum`
// is S1's; `family` groups a reminder with its family's entry voice (the
// same figure by design, never judged against it); `signalsOnly` marks a
// voice heard only where nothing but signals plays (`answered`, the Signals
// preset: judged against the signal voices alone); `sec` the slot (the
// counted hour needs its strikes ≥ 1 s apart).
// Providers carry the four routine alloys.
export const GALLERY_VOICES = Object.freeze([
    { label: 'needs you', kind: 'summons', payload: { level: 1 }, stratum: 'signal' },
    { label: 'error', kind: 'distress', stratum: 'signal' },
    { label: 'rate limit', kind: 'limit', stratum: 'signal' },
    { label: 'reminder L4', kind: 'reminder', payload: { level: 4, family: 'needsYou', count: 1, oldestMs: 900000 }, stratum: 'signal', family: 'needs you', sec: 8 },
    { label: 'answered', kind: 'answered', stratum: 'signal', signalsOnly: true },
    { label: 'turn done', kind: 'turnDone', payload: { count: 1 }, stratum: 'outcome' },
    { label: 'sub-agent return', kind: 'subagentReturn', payload: { count: 1 }, stratum: 'outcome' },
    { label: 'tool failed', kind: 'toolFailed', payload: { count: 1 }, stratum: 'outcome' },
    { label: 'commit', kind: 'commit', stratum: 'outcome' },
    { label: 'push', kind: 'push', stratum: 'outcome' },
    { label: 'release', kind: 'release', stratum: 'outcome', sec: 9 },
    { label: 'push failed', kind: 'pushFailed', stratum: 'outcome' },
    { label: 'dispatch', kind: 'dispatch', payload: { count: 3 }, stratum: 'outcome' },
    { label: 'arrival (claude)', kind: 'arrival', provider: 'claude', stratum: 'routine' },
    { label: 'arrival (codex)', kind: 'arrival', provider: 'codex', stratum: 'routine' },
    { label: 'arrival (gemini)', kind: 'arrival', provider: 'gemini', stratum: 'routine' },
    { label: 'arrival (kimi)', kind: 'arrival', provider: 'kimi', stratum: 'routine' },
    { label: 'departure', kind: 'departure', stratum: 'routine' },
    { label: 'recovery', kind: 'recovery', stratum: 'routine' },
    { label: 'council', kind: 'council', payload: { teamName: 'probe', teamSize: 3 }, stratum: 'routine' },
    { label: 'hour 9', kind: 'hourBell', payload: { hour: 9, count: false }, stratum: 'scenery', sec: 7 },
    { label: 'hour 12 counted', kind: 'hourBell', payload: { hour: 12, count: true }, stratum: 'scenery', sec: 18 },
    { label: 'aurora', kind: 'aurora', stratum: 'scenery' },
    { label: 'link lost', kind: 'linkLost', stratum: 'scenery' },
    { label: 'link restored', kind: 'linkRestored', stratum: 'scenery' },
    { label: 'digest', kind: 'digest', payload: { notes: ['gold', 'stone', 'red', 'amber'] }, stratum: 'scenery' },
    { label: 'thunder', kind: 'thunder', payload: { intensity: 0.8 }, stratum: 'scenery', sec: 9 },
]);
const GALLERY_SLOT_SEC = 6;

export function gallerySlots(voices = GALLERY_VOICES) {
    let at = 1;
    return voices.map((v, i) => {
        const slot = { ...v, index: i, at, end: at + (v.sec ?? GALLERY_SLOT_SEC) };
        at = slot.end;
        return slot;
    });
}

// `night`: the same voices in a night atmosphere (S1: signal pitches are the
// same by day and night).
export function galleryScene(voices = GALLERY_VOICES, { night = false } = {}) {
    const slots = gallerySlots(voices);
    return {
        mode: 'ambient', isolate: 'none', atmosphere: night ? NIGHT : DAY, warmup: 4, seconds: Math.ceil(slots[slots.length - 1].end + 1),
        world: { agents: slots.map(s => ({ status: 'working', provider: s.provider || 'claude' })) },
        actions: slots.map(s => ({ at: s.at, play: { kind: s.kind, payload: { phase: night ? 'night' : 'day', ...(s.payload || {}), ...(s.provider ? { provider: s.provider } : {}) } }, agentIndex: s.index, label: s.label, voice: s.label })),
        stems: ['cue'],
    };
}

// 3.3 ladder, sound off (the signal route from boot): one wait per family
// opened at `LADDER_OPEN_SEC` and never answered, 61 minutes on the virtual
// clock, captions recorded through a real Toast at the default setting.
// `ack` answers nothing but acknowledges the agent (SIG-2: quiet for 10 min).
export const LADDER_OPEN_SEC = 5;
export const LADDER_SECONDS = 3700;
const FAMILY_STATUS = { needsYou: 'waiting_on_user', errors: 'errored', quota: 'rate_limited' };

function openWait(family, at, index) {
    const status = FAMILY_STATUS[family];
    const raise = family === 'needsYou'
        ? { at: at + 0.01, emit: 'attention:raised', payload: { waitingCount: 1, oldestWaitMs: 0, status }, agentIndex: index, label: `open ${family}` }
        : { at: at + 0.01, emit: 'distress:watchtower', payload: { kind: status }, agentIndex: index, label: `open ${family}` };
    return [{ at, status: { index, status } }, raise];
}

export function ladderSilentScene(family, { ackAt = null, seconds = LADDER_SECONDS } = {}) {
    return {
        mode: 'ambient', world: { counts: { working: 3 } }, atmosphere: DAY, seconds, captions: ['auto'],
        actions: [
            ...openWait(family, LADDER_OPEN_SEC, 0),
            ...(ackAt != null ? [{ at: ackAt, ack: { index: 0 }, label: 'ack' }] : []),
        ],
    };
}

// 3.3 hidden tab with sound on: the wait opens while visible, the tab hides
// 20 s later and stays hidden past the second L4; each reminder must wake
// the paused context. The audio clock freezes while suspended, so `seconds`
// is audio time (the visible start and every wake); the tab shows again at
// the end so the render finishes.
export const WAKE_HIDE_SEC = 25;
export const WAKE_SHOW_SEC = 940;
export const WAKE_SCENE = {
    mode: 'ambient', world: { counts: { working: 3 } }, atmosphere: DAY, warmup: 10, seconds: 120, freezeOnSuspend: true,
    stems: ['cue'], lint: false,
    actions: [
        ...openWait('needsYou', LADDER_OPEN_SEC, 0),
        { at: WAKE_HIDE_SEC, visibility: 'hidden', label: 'hide' },
        { at: WAKE_SHOW_SEC, visibility: 'visible', label: 'show' },
    ],
};

// 3.3 held trim, sound on: one needs-you wait through L1, L2 (2 min) and L3
// (6 min) in Village with no music; the ladder takes its trim at entry and
// holds it, so L2 lands ≥ 4 LU under L1 and L3 keeps urgent GR ≤ 3 dB.
export const LADDER_TRIM_SCENE = {
    mode: 'ambient', world: { counts: { working: 4 } }, atmosphere: DAY, force: { music: 0 }, warmup: 10, seconds: 380,
    stems: ['cue', 'limiterIn', 'limiterOut'], lint: false,
    actions: openWait('needsYou', LADDER_OPEN_SEC, 0),
};

// SIG-10 cluster: one raise vs six same-tick raises over one Village bed,
// needs-you or errors.
export const CLUSTER_AT = 6;
export const CLUSTER_KIND = Object.freeze({ needsYou: 'summons', errors: 'distress' });
export function clusterScene(n, family = 'needsYou') {
    return {
        mode: 'ambient', world: { counts: { working: 6 + n } }, atmosphere: DAY, force: { music: 0 }, warmup: 10, seconds: 16,
        stems: ['cue', 'limiterIn', 'limiterOut'],
        actions: Array.from({ length: n }, (_, i) => openWait(family, CLUSTER_AT, 6 + i)).flat(),
    };
}

// 3.3 held note: a wait opened by status alone (no entry call, so the band
// is the held note's) at W working agents in Village with no music, then
// answered. `answerAt` < 120 s keeps the ladder's L2 out of the window.
export const HELD_OPEN_SEC = 15;
export const HELD_ANSWER_SEC = 60;
// `signals`: the window blurred with *In the background: Signals only* — the
// signal route alone (the plan's Signals preset until 7.2 adds it).
export function heldNoteScene({ working, mode = 'ambient', music = null, signals = false, seconds = HELD_ANSWER_SEC + 15, answerAt = HELD_ANSWER_SEC } = {}) {
    return {
        mode, atmosphere: DAY, warmup: 10, seconds,
        world: { counts: { working }, agents: [{ status: 'working' }] },
        ...(music ? { music } : { force: mode === 'ambient' ? { music: 0 } : {} }),
        ...(signals ? { storage: { 'claudeville.sound.background': 'signals' } } : {}),
        stems: ['signalBed', 'world', 'work', 'music', 'cue'],
        actions: [
            ...(signals ? [{ at: 5, window: 'blur', label: 'blur (signals only)' }] : []),
            { at: HELD_OPEN_SEC, status: { index: working, status: 'waiting_on_user' }, label: 'wait opens' },
            ...(answerAt != null ? [{ at: answerAt, status: { index: working, status: 'working' }, label: 'answered' }] : []),
        ],
    };
}

// Must-never 3: a six-minute wait in Village with no music, never
// answered until the end; the held note must hold for all of it.
export const LONG_WAIT_SECONDS = 390;
export const LONG_WAIT_SCENE = heldNoteScene({ working: 4, seconds: LONG_WAIT_SECONDS, answerAt: LONG_WAIT_SECONDS - 12 });

// Must-never 13 (SIG-9): stale agents make no sound — a stale waiting, a
// stale errored and a stale working agent, each flagged by one of the
// AudibleWorld stale markers, raise their events like fresh ones would.
export const STALE_SCENE = {
    mode: 'ambient', atmosphere: DAY, warmup: 10, seconds: 40, force: { music: 0 },
    world: {
        counts: { idle: 2 },
        agents: [
            { status: 'working', signalStale: true },
            { status: 'working', freshness: { state: 'stale' } },
            { status: 'working', resident: true },
        ],
    },
    stems: ['signalBed', 'cue'],
    actions: [
        { at: 5, status: { index: 2, status: 'waiting_on_user' } },
        { at: 5.01, emit: 'attention:raised', payload: { waitingCount: 1, oldestWaitMs: 0, status: 'waiting_on_user' }, agentIndex: 2, label: 'stale needs-you' },
        { at: 12, status: { index: 3, status: 'errored' } },
        { at: 12.01, emit: 'distress:watchtower', payload: { kind: 'errored' }, agentIndex: 3, label: 'stale error' },
    ],
};

// 3.4 outcome fixtures through their producers (World mode, then Dashboard).
// Agents: 0–3 workers, 4 a parent with sub-agents added below.
const OUTCOME_WORLD = { counts: { working: 5 } };
export const OUTCOME_SCENE = {
    mode: 'ambient', world: OUTCOME_WORLD, atmosphere: DAY, warmup: 10, seconds: 150, force: { music: 0 }, stems: ['cue'], captions: ['auto'],
    actions: [
        // A verified push: one push cue, its caption and its published notes.
        { at: 3, emit: 'outcome:verified', payload: { kind: 'push', project: 'probe' }, agentIndex: 0, label: 'push', lane: 'push' },
        // Ten clean exits: silence.
        ...Array.from({ length: 10 }, (_, i) => ({ at: 12 + i * 0.5, emit: 'tool:result', payload: { tool: 'Bash', exitCode: 0, building: 'forge' }, agentIndex: 1, label: 'exit 0', lane: 'exit0' })),
        // Ten failures from one agent in 60 s: at most two cues.
        ...Array.from({ length: 10 }, (_, i) => ({ at: 25 + i * 6, emit: 'tool:result', payload: { tool: 'Bash', exitCode: 1, building: 'forge' }, agentIndex: 2, label: 'exit 1', lane: 'toolFailed' })),
        // A long turn ends; a sub-agent is dispatched and returns.
        { at: 90, status: { index: 3, status: 'working' } },
        { at: 91, status: { index: 3, status: 'idle', fields: { lastTurnDurationMs: LONG_TURN_MS } }, label: 'turn done', lane: 'turnDone' },
        { at: 100, addAgent: { status: 'working', parentIndex: 4 }, label: 'dispatch', lane: 'dispatch' },
        { at: 115, remove: { index: 5 }, label: 'return', lane: 'subagentReturn' },
        // A verified release, its crown accent declared as the renderer does.
        { at: 130, accent: { kind: 'release', leadMs: 900 }, emit: 'outcome:verified', payload: { kind: 'release', project: 'probe' }, agentIndex: 0, label: 'release', lane: 'release' },
    ],
};

// Dashboard: the World-model transitions only (no tool:result producer).
export const DASHBOARD_SCENE = {
    mode: 'ambient', world: OUTCOME_WORLD, atmosphere: DAY, warmup: 10, seconds: 45, force: { music: 0 }, stems: ['cue'],
    actions: [
        { at: 1, emit: 'mode:changed', payload: 'dashboard', raw: true, label: 'dashboard' },
        { at: 4, status: { index: 3, status: 'working' } },
        { at: 5, status: { index: 3, status: 'idle', fields: { lastTurnDurationMs: LONG_TURN_MS } }, label: 'turn done', lane: 'turnDone' },
        { at: 12, addAgent: { status: 'working', parentIndex: 4 }, label: 'dispatch', lane: 'dispatch' },
        { at: 28, remove: { index: 5 }, label: 'return', lane: 'subagentReturn' },
    ],
};

// HAR-13 caption parity: every kind once, through the director's cue path
// (so the governor, the ladder and the caption route are the shipped
// ones), in both presets, sound on (rendered) and off, four Toasts — one
// per caption setting. Kinds sit 12 s apart (outcomes share the routine
// 6/min); each on its own agent.
export const CAPTION_SETTINGS = ['auto', 'signals', 'events', 'all'];
export const CAPTION_KINDS = Object.freeze([
    ['summons', { level: 1 }], ['distress', {}], ['limit', {}], ['reminder', { level: 2, family: 'needsYou', count: 1, oldestMs: 120000 }],
    ['turnDone', { count: 1 }], ['subagentReturn', { count: 1 }], ['toolFailed', { count: 1 }], ['commit', {}], ['push', {}],
    ['release', {}], ['pushFailed', {}], ['dispatch', { count: 2 }],
    ['arrival', {}], ['departure', {}], ['recovery', {}], ['council', { teamName: 'probe', teamSize: 3 }],
    ['hourBell', { hour: 15, count: false }], ['aurora', {}], ['linkLost', {}], ['linkRestored', {}],
    ['digest', { notes: ['gold', 'red'] }],
]);
const CAPTION_SPACING = 12;

export function captionScene(mode, { soundOn }) {
    const actions = CAPTION_KINDS.map(([kind, payload], i) => ({ at: 2 + i * CAPTION_SPACING, cue: kind, payload, agentIndex: i, label: kind, lane: kind }));
    const seconds = 2 + CAPTION_KINDS.length * CAPTION_SPACING + 4;
    const base = { mode, world: { counts: { working: CAPTION_KINDS.length + 2 } }, atmosphere: DAY, seconds, actions, captions: CAPTION_SETTINGS };
    return soundOn ? { ...base, warmup: 6, stems: ['cue'], lint: false } : base;
}

// ================================================================ Wave 4 ====

const flash = (at, intensity) => ({ at, emit: 'weather:storm-flash', payload: { intensity }, label: `storm-flash ${intensity}` });

// 4.5 (AMB-12, HAR-9): the 72-scene world map — four phases (mid-phase) ×
// the six weather types × resting / 3 / 12 working, 30 s each, work and
// music faders at 0 so the program is the world stratum (Anchor A's
// staging). Resting cells warm up 40 s (the quiet floor rests after 30 s);
// storm cells carry one flash (S2: storm is judged with its thunder).
export const MAP_PHASES = ['dawn', 'day', 'dusk', 'night'];
export const MAP_WEATHERS = Object.freeze({
    clear: { type: 'clear', windX: 0.3 },
    'partly-cloudy': { type: 'partly-cloudy', windX: 0.4 },
    overcast: { type: 'overcast', windX: 0.5 },
    rain: RAIN.weather,
    fog: { type: 'fog', windX: 0.1 },
    storm: STORM.weather,
});
export const MAP_LOADS = Object.freeze({ resting: { idle: 3 }, w3: { working: 3, idle: 1 }, w12: { working: 12 } });
export const MAP_SECONDS = 30;
export const MAP_FLASH = Object.freeze({ at: 4, intensity: 0.9 });

export function worldMapCells() {
    const cells = [];
    for (const phase of MAP_PHASES) {
        for (const [weather, w] of Object.entries(MAP_WEATHERS)) {
            for (const [load, counts] of Object.entries(MAP_LOADS)) {
                cells.push({
                    key: `map:${phase}:${weather}:${load}`, phase, weather, load,
                    spec: {
                        mode: 'ambient', world: { counts }, layerSteps: { hum: 0, music: 0 },
                        atmosphere: { phase, progress: 0.5, weather: w },
                        warmup: load === 'resting' ? 40 : 10, seconds: MAP_SECONDS, stems: ['world'],
                        actions: weather === 'storm' ? [flash(MAP_FLASH.at, MAP_FLASH.intensity)] : [],
                    },
                });
            }
        }
    }
    return cells;
}

// S6: 0 vs 12 working agents at one seed → a bit-identical world stem. Both
// renders end before the quiet floor could rest the empty village (30 s:
// the pilot light is SCN-5's designed response to nobody working).
export const WORLD_STEM_SECONDS = 26;
export const WORLD_STEM_FIXTURES = Object.freeze({
    'dawn clear': { atmosphere: { phase: 'dawn', progress: 0.5, weather: MAP_WEATHERS.clear }, actions: [] },
    'night storm': { atmosphere: { ...STORM, phase: 'night' }, actions: [flash(6, 0.8)] },
});

export function worldStemScene(fixture, working) {
    const f = WORLD_STEM_FIXTURES[fixture];
    return {
        mode: 'ambient', world: { counts: working ? { working } : {} }, atmosphere: f.atmosphere,
        warmup: 2, seconds: WORLD_STEM_SECONDS, stems: ['world'], actions: f.actions,
    };
}

// 4.1: the sea alone at night (TEXTURE_SCENES carries day and storm), four
// minutes of it by day for the rare voices, the night bed with and without
// the sea (250 Hz–1 kHz), and nothing at all (the CPU proxy's floor).
export const SEA_NIGHT_SCENE = { ...TEXTURE_SCENES.sea.spec, atmosphere: NIGHT };
export const SEA_RARE_SCENE = { ...TEXTURE_SCENES.sea.spec, atmosphere: { ...DAY, weather: { type: 'partly-cloudy', windX: 0.8 } }, seconds: 240, collect: [] };
export const NIGHT_BED_NO_SEA = { ...SCENES.nightClear, force: { sea: 0 }, collect: [] };
export const SILENT_ISLAND_SCENE = { ...TEXTURE_SCENES.sea.spec, isolate: 'none', collect: [] };

// 4.2: strikes across near and far intensities in shuffled order, 18 s
// apart (a far onset lands ≤ 3.6 s after its flash and rolls ≤ 8 s), over
// the world-only storm; stems for the bed, the thunder and the limiter.
export const THUNDER_INTENSITIES = Object.freeze([0.9, 0.3, 0.7, 0.5, 1.0, 0.6]);
export const THUNDER_SPACING = 18;
export const THUNDER_FIRST = 4;
export const THUNDER_SCENE = {
    mode: 'ambient', world: { counts: { working: 4, idle: 1 } }, layerSteps: { hum: 0, music: 0 }, atmosphere: STORM,
    warmup: 10, seconds: THUNDER_FIRST + THUNDER_INTENSITIES.length * THUNDER_SPACING + 2,
    stems: ['world', 'cue', 'limiterIn', 'limiterOut'], collect: ['starts'],
    actions: THUNDER_INTENSITIES.map((intensity, i) => flash(THUNDER_FIRST + i * THUNDER_SPACING, intensity)),
};

// Must-never 8: a needs-you and an error each placed 1 s into a full-
// intensity thunder roll (onset 0.4 s after the flash) in the Village storm.
export const MASKING_SCENE = {
    mode: 'ambient', world: { counts: { working: 6 } }, atmosphere: STORM, warmup: 10, seconds: 40,
    stems: ['world', 'cue', 'limiterIn', 'limiterOut'],
    actions: [flash(4, 1), ...laneActions('needsYou', 5.4, 0), flash(22, 1), ...laneActions('error', 23.4, 1)],
};

// 4.6 (AMB-9): a cue whose first note lands on a sea crest. Per bed: one
// render without cues (the crests), one with each lane's cue early (its
// lead from the action to the first note, and its margin off the crest),
// then one render per lane with the cue moved onto the loudest crash crest
// in the window. The night Village bed has no music (the sea is forward at
// night); the storm carries the sea at its biggest.
export const CREST_BEDS = Object.freeze({
    night: { bed: 'village', lanes: ['routine', 'needsYou'], atmosphere: NIGHT },
    storm: { bed: 'weather', lanes: ['error'], atmosphere: STORM },
});
export const CREST_WINDOW = Object.freeze([20, 60]);
const CREST_CAL_AT = 5;
const CREST_CAL_SPACING = 14;

export function crestScene(bedName, actions = []) {
    const b = CREST_BEDS[bedName];
    return {
        mode: 'ambient', world: { counts: { working: 6 } }, atmosphere: b.atmosphere, force: { music: 0 },
        warmup: 10, seconds: 70, stems: ['world', 'cue', 'limiterIn', 'limiterOut'], actions,
    };
}

// → { spec, at: { lane: action time } }
export function crestCalibration(bedName) {
    const at = {};
    const actions = CREST_BEDS[bedName].lanes.flatMap((lane, i) => {
        at[lane] = CREST_CAL_AT + i * CREST_CAL_SPACING;
        return laneActions(lane, at[lane], i);
    });
    return { spec: crestScene(bedName, actions), at };
}

export function crestPlaced(bedName, lane, at) {
    return crestScene(bedName, laneActions(lane, at, 0));
}
