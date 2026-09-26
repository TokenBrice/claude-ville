// The virtual-clock probe's named scenes (page/virtual.js specs). Scene
// time: `warmup` seconds settle the enable fade and the director's level
// slews and are discarded; action `at` is seconds after warmup.
// Targets live in Loudness.js (S2); the judges in checks.mjs.

const DAY = Object.freeze({ phase: 'day', progress: 0.5, weather: { type: 'clear', windX: 0.3 } });
const RAIN = Object.freeze({ phase: 'day', progress: 0.5, weather: { type: 'rain', intensity: 0.7, windX: 0.6 } });
const STORM = Object.freeze({ phase: 'day', progress: 0.5, weather: { type: 'storm', intensity: 0.9, windX: 1.2 } });

// One lane's cue through the real producers (the harness page has no
// AttentionService or VillageDirector, so the probe emits their events):
// the agent's status is set first, so bucket routing sees it.
export const LANE_CUE_KIND = Object.freeze({ needsYou: 'summons', error: 'distress', limit: 'limit', routine: 'arrival', scenery: 'aurora' });
const LANE_STATUS = { needsYou: 'waiting_on_user', error: 'errored', limit: 'rate_limited' };

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
    anchor: { mode: 'ambient', world: { counts: { working: 4, idle: 1 } }, layerSteps: { hum: 0, music: 0 }, atmosphere: DAY, warmup: 10, seconds: 60, stems: ['world'] },
    villageBusy: { mode: 'ambient', world: BUSY_WORLD, atmosphere: DAY, warmup: 10, seconds: 180, actions: busyActions(), stems: ['world', 'work', 'music', 'cue'] },
    townBand: { mode: 'bgm', world: BUSY_WORLD, atmosphere: DAY, warmup: 10, seconds: 180, actions: busyActions(), stems: ['music', 'cue'] },
    rain: { mode: 'ambient', world: { counts: { working: 4, idle: 1 } }, atmosphere: RAIN, warmup: 10, seconds: 60, stems: ['world'] },
    storm: {
        mode: 'ambient', world: { counts: { working: 4, idle: 1 } }, atmosphere: STORM, warmup: 10, seconds: 60, stems: ['world', 'limiterIn', 'limiterOut'],
        actions: [0.8, 1, 0.5].map((intensity, i) => ({ at: 8 + i * 18, emit: 'weather:storm-flash', payload: { intensity }, label: `storm-flash ${intensity}` })),
    },
    // Nobody working, nothing actionable: the quiet floor enters resting after
    // 30 s, so the recording starts after 40.
    resting: { mode: 'ambient', world: { counts: { idle: 3 } }, atmosphere: DAY, warmup: 40, seconds: 30, stems: ['world'] },
    // Must-never 12: AMBIENT → BGM at 15 s, back at 45 s.
    presetSwitch: {
        mode: 'ambient', world: { counts: { working: 4, idle: 1 } }, atmosphere: DAY, warmup: 15, seconds: 65,
        actions: [{ at: 15, mode: 'bgm' }, { at: 45, mode: 'ambient' }],
    },
    // HAR-12: body-anchored arrivals whose accent the "renderer" declares
    // 450–800 ms ahead (sooner than the cue's own lead, the sound follows the
    // body and lands late by design), plus free cues; published and accent
    // times vs heard. Cues sit 10.5 s apart and each kind ≥ its CueKit
    // cooldown (arrival and departure 20 s), inside the governor's spacing
    // and rate, so every one is admitted.
    avSync: {
        mode: 'ambient', world: { counts: { working: 12 } }, atmosphere: DAY, warmup: 8, seconds: 95, stems: ['cue'],
        actions: [
            ...[0, 1, 2, 3].map(i => ({ at: 2 + i * 21, accent: { kind: 'arrival', leadMs: 450 + 110 * i }, emit: 'village:scene', payload: { kind: 'arrival' }, agentIndex: i, label: `arrival (accent +${450 + 110 * i} ms)`, lane: 'routine' })),
            ...[0, 1, 2].map(i => ({ at: 12.5 + i * 21, emit: 'village:scene', payload: { kind: 'departure' }, agentIndex: 6 + i, label: 'departure', lane: 'routine' })),
            { at: 75.5, emit: 'distress:watchtower', payload: { kind: 'recovered' }, agentIndex: 10, label: 'recovery', lane: 'routine' },
            { at: 86, emit: 'team:gather', payload: { teamName: 'probe', members: ['probe-a', 'probe-b', 'probe-c'] }, label: 'council', lane: 'routine' },
        ],
    },
};

// Cue lanes over each probe bed: 3 placements per lane, 7 s apart, each on
// its own agent, lanes interleaved so no placement follows its own lane.
// Scenery (the aurora) has a 120 s CueKit cooldown, so it is placed once.
export const MARGIN_LANES = ['needsYou', 'error', 'limit', 'routine', 'scenery'];
export const MARGIN_BEDS = {
    village: { bed: 'village', mode: 'ambient', atmosphere: DAY },
    music: { bed: 'music', mode: 'bgm', atmosphere: DAY },
    rain: { bed: 'weather', mode: 'ambient', atmosphere: RAIN },
    storm: { bed: 'weather', mode: 'ambient', atmosphere: STORM },
};
export const MARGIN_PLACEMENTS = 3;
const MARGIN_SPACING = 7;
const PLACEMENTS_BY_LANE = { scenery: 1 };

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
        mode: bed.mode, world: { counts: { working: agent + 2 } }, atmosphere: bed.atmosphere,
        warmup: 10, seconds, actions, stems: ['cue', 'limiterIn', 'limiterOut'],
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
