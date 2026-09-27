import { SEATS } from '../../../claudeville/src/presentation/shared/audio/music/Voicings.js';

// The virtual-clock probe's named scenes (page/virtual.js specs). Scene
// time: `warmup` seconds settle the enable fade and the director's level
// slews and are discarded; action `at` is seconds after warmup.
// Targets live in Loudness.js (S2); the judges in checks.mjs.

const DAY = Object.freeze({ phase: 'day', progress: 0.5, weather: { type: 'clear', windX: 0.3 } });
const RAIN = Object.freeze({ phase: 'day', progress: 0.5, weather: { type: 'rain', intensity: 0.7, windX: 0.6 } });
const STORM = Object.freeze({ phase: 'day', progress: 0.5, weather: { type: 'storm', intensity: 0.9, windX: 1.2 } });
const NIGHT = Object.freeze({ phase: 'night', progress: 0.5, weather: { type: 'clear', windX: 0.3 } });

// Wave 6: the music ledger (OccasionClock, SoundSettings MUSIC_LEDGER_KEY)
// on the virtual clock's calendar day (page/virtual-clock.js: 2026-07-15).
// A settled profile has had its first occasion and today's welcome, so
// only the phase occasions and fragments remain; no ledger at all is the
// first-ever enable.
export const MUSIC_LEDGER_KEY = 'claudeville.sound.musicLedger';
export const TOWN_BAND_VOICE_KEY = 'claudeville.sound.townBandVoice';
export const VIRTUAL_DAY = '2026-07-15';
export function settledLedger(occasions = []) {
    return JSON.stringify({ firstOccasion: true, welcomeDay: VIRTUAL_DAY, islandDay: VIRTUAL_DAY, occasions });
}

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

// `voice` (MARGIN_VOICES) picks one of the lane's cue kinds; `atmosphere` is
// the bed's, which an hour bell's clock step must keep.
export function laneActions(lane, at, agentIndex, { voice = null, atmosphere = DAY } = {}) {
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
    if (lane === 'routine') {
        const v = voice ?? 'arrival';
        const vtag = { ...tag, voice: v, label: `${lane}:${v}#${agentIndex}` };
        if (v === 'arrival' || v === 'departure') return [{ at, emit: 'village:scene', payload: { kind: v }, agentIndex, ...vtag }];
        if (v === 'council') return [{ at, emit: 'team:gather', payload: { teamName: `probe-${agentIndex}`, members: COUNCIL_MEMBERS }, ...vtag }];
        throw new Error(`unknown routine voice ${v}`);
    }
    if (lane === 'scenery') {
        const v = voice ?? 'aurora';
        const vtag = { ...tag, voice: v, label: `${lane}:${v}#${agentIndex}` };
        if (v === 'aurora') return [{ at, emit: 'chronicle:aurora', payload: {}, ...vtag }];
        // The hour bell rings on the director's own tick when the scene's
        // clock reaches the hour (D7: the phrase, count off), then moves on.
        if (v === 'hourBell') {
            return [
                { at, atmosphere: { ...atmosphere, hour: CHIME_HOUR }, ...vtag },
                { at: at + 1.5, atmosphere: { ...atmosphere, hour: CHIME_HOUR + 0.02 }, label: 'clock past the hour' },
            ];
        }
        throw new Error(`unknown scenery voice ${v}`);
    }
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
    // `musicProbe`: the sequencer's marks and the MusicClock frames (6.5's
    // routine-cue clash reads both).
    villageBusy: { mode: 'ambient', world: BUSY_WORLD, atmosphere: DAY, warmup: 10, seconds: 180, actions: busyActions(), stems: ['world', 'work', 'music', 'cue'], musicProbe: {} },
    townBand: { mode: 'bgm', world: BUSY_WORLD, atmosphere: DAY, warmup: 10, seconds: 180, actions: busyActions(), stems: ['music', 'cue'], musicProbe: {} },
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
    // against noon at the same load, each with its phase occasion (6.3,
    // 6.6): a profile that has had its first occasion and today's welcome,
    // at 22:30 (the night waltz) and 12:30 (noon), so the occasion starts
    // at the enable and fills the window.
    nightProgram: { mode: 'ambient', world: { counts: { working: 3, idle: 1 } }, atmosphere: { ...NIGHT, hour: 22.5 }, storage: { [MUSIC_LEDGER_KEY]: settledLedger() }, warmup: 4, seconds: 75, stems: ['world', 'work', 'music'], musicProbe: { stopLint: true } },
    noonProgram: { mode: 'ambient', world: { counts: { working: 3, idle: 1 } }, atmosphere: { ...DAY, hour: 12.5 }, storage: { [MUSIC_LEDGER_KEY]: settledLedger() }, warmup: 4, seconds: 75, stems: ['world', 'work', 'music'], musicProbe: {} },
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

// Cue lanes over each probe bed: 3 placements per lane, each on its own
// agent, on a slot grid 7 s apart with the lanes interleaved (so a lane's
// own placements sit 42–56 s apart, clear of CueKit's per-kind cooldowns and
// the governor's spacing). Each lane renders alone on that grid: the bed
// under a placement depends on the cues before it (their ducks, and the
// music, which takes different turns for good after the first cue), so a
// lane over one shared render moved whenever another lane's voice changed
// (limit's presence rise over music read 6.8, then 6.0 dB, its voice
// untouched). Scenery (the aurora) has a 120 s CueKit cooldown and the
// release is the one Major
// outcome, so each is placed once. The Village bed is S2's "Village bed (no
// music)": its music is held at 0.
export const MARGIN_LANES = ['needsYou', 'error', 'limit', 'routine', 'scenery', 'outcomeMinor', 'outcomeMedium', 'outcomeMajor'];
const URGENT_MARGIN_LANES = ['needsYou', 'error', 'limit'];
// Every cue kind a lane carries that S2's row names, each judged on its own
// placements (reel v3: council, departure and the hour bell sat over their
// windows where the lane's one voice passed). The first is the lane's
// default voice (the `margin:<bed>:<lane>` render); the others render as
// `margin:<bed>:<lane>:<voice>`.
export const MARGIN_VOICES = Object.freeze({
    routine: Object.freeze(['arrival', 'council', 'departure']),
    scenery: Object.freeze(['aurora', 'hourBell']),
});
export function marginVoices(lane) {
    return MARGIN_VOICES[lane] ?? [LANE_CUE_KIND[lane]];
}
// The beds: `village` is the busy Village (a counted crowd at work, 22 at
// the full lane grid) and `villageLight` a 3–6-worker Village (4 at work):
// reel v3 found the lighter bed 1.2 LU quieter, where the push reached its
// −6 dB trim floor. `bandBusy` / `bandBusyChip` are the Town band over the
// busy island (every building working, so the arrangement and percussion
// play; Willowbrook pinned, the reel's piece), in the Isle voice and in
// Chip, for the urgent lanes; the probe prints the band each placement meets.
export const MARGIN_BEDS = {
    village: { bed: 'village', mode: 'ambient', atmosphere: DAY, force: { music: 0 } },
    villageLight: { bed: 'village', mode: 'ambient', atmosphere: DAY, force: { music: 0 }, working: 4 },
    music: { bed: 'music', mode: 'bgm', atmosphere: DAY },
    bandBusy: { bed: 'music', mode: 'bgm', atmosphere: DAY, busy: true, piece: 'willowbrook', voice: 'isle', lanes: URGENT_MARGIN_LANES },
    bandBusyChip: { bed: 'music', mode: 'bgm', atmosphere: DAY, busy: true, piece: 'willowbrook', voice: 'chip', lanes: URGENT_MARGIN_LANES },
    rain: { bed: 'weather', mode: 'ambient', atmosphere: RAIN },
    storm: { bed: 'weather', mode: 'ambient', atmosphere: STORM },
};
export function marginLanes(bedName) {
    return MARGIN_BEDS[bedName]?.lanes ?? MARGIN_LANES;
}
export const MARGIN_PLACEMENTS = 3;
const MARGIN_SPACING = 7;
const PLACEMENTS_BY_LANE = { scenery: 1, outcomeMajor: 1 };
// Voices whose CueKit cooldown outlasts the lane grid: the council (60 s)
// keeps its three placements 63 s apart; the hour bell (55 min) renders one
// placement per scene (`margin:<bed>:scenery:hourBell#<p>`), at its slot.
const VOICE_SPACING = Object.freeze({ council: 63 });
export const PER_RENDER_VOICES = Object.freeze(['hourBell']);
const PLACEMENTS_BY_VOICE = Object.freeze({ aurora: 1, hourBell: MARGIN_PLACEMENTS });
const COUNCIL_MEMBERS = Object.freeze(['probe-a', 'probe-b', 'probe-c', 'probe-d']);
const CHIME_HOUR = 13;
// After a lane's last placement: its onset (≤ 5 s after the marker when
// the score waits for a beat) and the 2.5 s margin window.
const MARGIN_TAIL_SEC = 8;

// The margin render keys of one lane's voice over one bed.
export function marginKeys(bedName, lane, voice = marginVoices(lane)[0]) {
    const base = voice === marginVoices(lane)[0] ? `margin:${bedName}:${lane}` : `margin:${bedName}:${lane}:${voice}`;
    if (!PER_RENDER_VOICES.includes(voice)) return [base];
    return Array.from({ length: PLACEMENTS_BY_VOICE[voice] ?? MARGIN_PLACEMENTS }, (_, p) => `${base}#${p}`);
}

export function marginScene(bedName, lane, voice = null, only = null) {
    const bed = MARGIN_BEDS[bedName];
    if (!bed || !marginLanes(bedName).includes(lane)) throw new Error(`unknown margin scene ${bedName}:${lane}`);
    const v = voice ?? marginVoices(lane)[0];
    if (!marginVoices(lane).includes(v)) throw new Error(`unknown margin voice ${lane}:${v}`);
    const lanes = marginLanes(bedName);
    const placements = [];
    let agent = 0;
    let slot = 0;
    for (let p = 0; p < MARGIN_PLACEMENTS; p++) {
        for (const l of lanes) {
            if (p >= (PLACEMENTS_BY_LANE[l] ?? MARGIN_PLACEMENTS)) continue;
            if (l === lane) placements.push({ p, at: 3 + slot * MARGIN_SPACING, agent });
            slot++;
            agent++;
        }
    }
    // A voice keeps its lane's slots (and agents) unless its cooldown or
    // placement count says otherwise; a per-render voice (the hour bell)
    // takes the p-th slot of the 7 s grid in its own render.
    const n = PLACEMENTS_BY_VOICE[v] ?? placements.length;
    const spots = Array.from({ length: n }, (_, p) => placements[p] ?? { p, at: 3 + p * MARGIN_SPACING * lanes.length, agent: placements[0].agent + p })
        .map(s => (VOICE_SPACING[v] ? { ...s, at: 3 + s.p * VOICE_SPACING[v] } : s))
        .map(s => (PER_RENDER_VOICES.includes(v) ? { ...s, at: 3 + s.p * MARGIN_SPACING } : s))
        .filter(s => only == null || s.p === only);
    // The busy Town band: the island's tool fixture (every building working)
    // leads the world; the lane's agents are idle bystanders after it.
    const lead = bed.busy ? workFixture(TOWN_BUSY, { seconds: Math.max(...spots.map(s => s.at)) + MARGIN_TAIL_SEC, seed: 71 }) : null;
    const offset = lead ? lead.world.agents.length : 0;
    const actions = spots.flatMap(s => laneActions(lane, s.at, s.agent + offset, { voice: v, atmosphere: bed.atmosphere }));
    const seconds = Math.max(...actions.map(a => a.at)) + MARGIN_TAIL_SEC;
    const crowd = agent + 2;
    const world = lead ? { agents: [...lead.world.agents, ...Array.from({ length: crowd }, () => ({ status: 'idle' }))] }
        : bed.working != null ? { counts: { working: bed.working, idle: Math.max(0, crowd - bed.working) } }
            : { counts: { working: crowd } };
    return {
        mode: bed.mode, world, atmosphere: bed.atmosphere, force: bed.force,
        ...(bed.voice ? { storage: { [TOWN_BAND_VOICE_KEY]: bed.voice } } : {}),
        ...(bed.piece ? { bgm: { piece: bed.piece } } : {}),
        warmup: 10, seconds, actions: [...(lead?.actions ?? []), ...actions].sort((a, b) => a.at - b.at),
        stems: ['cue', 'world', 'work', 'music', 'limiterIn', 'limiterOut'],
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

// The same wait over the Town band (reel v3: there the ladder held its first
// reminder's trim, not the entry's). The band's own world: no music force.
export const LADDER_TRIM_BAND_SCENE = (({ force, ...rest }) => ({ ...rest, mode: 'bgm' }))(LADDER_TRIM_SCENE);

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
// `music`: the Village plays (no ledger: the first-ever enable's occasion).
export function heldNoteScene({ working, mode = 'ambient', music = false, signals = false, seconds = HELD_ANSWER_SEC + 15, answerAt = HELD_ANSWER_SEC } = {}) {
    return {
        mode, atmosphere: DAY, warmup: 10, seconds,
        world: { counts: { working }, agents: [{ status: 'working' }] },
        ...(music ? {} : { force: mode === 'ambient' ? { music: 0 } : {} }),
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

// ================================================================ Wave 5 ====
// The workshop fixtures (FOL-9, FOL round 2). Agents work at a building
// through their current tool (`classifyTool(currentTool, currentToolInput)`,
// the World model's own fields); a tool start is a change of that pair,
// observed on the 2 s poll (phase 0.4 s) as the real feed delivers it. Each
// start also burns tokens, which keeps the Mine working (WorkshopModel).
export const WORK_POLL = Object.freeze({ phaseSec: 0.4, periodSec: 2 });
const snapPoll = t => WORK_POLL.phaseSec + Math.ceil((t - WORK_POLL.phaseSec - 1e-9) / WORK_POLL.periodSec) * WORK_POLL.periodSec;

// One tool per building, varied by call so each start changes the key.
export const WORK_TOOLS = Object.freeze({
    forge: k => ({ currentTool: 'Edit', currentToolInput: { file_path: `src/work-${k}.js` } }),
    archive: k => ({ currentTool: 'Read', currentToolInput: { file_path: `docs/notes-${k}.md` } }),
    taskboard: k => ({ currentTool: 'TodoWrite', currentToolInput: { todos: [{ content: `step ${k}` }] } }),
    observatory: k => ({ currentTool: 'WebSearch', currentToolInput: { query: `query ${k}` } }),
    portal: k => ({ currentTool: 'mcp__playwright__browser_navigate', currentToolInput: { url: `http://localhost:3000/page-${k}` } }),
    command: k => ({ currentTool: 'Task', currentToolInput: { description: `task ${k}` } }),
    harbor: k => ({ currentTool: 'Bash', currentToolInput: { command: k % 2 ? 'git status' : 'git push' } }),
});
const TOKENS_PER_START = 900;

function lcg(seed) {
    let s = seed >>> 0;
    return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296;
}

// agents: [{ b, gap (median s between starts) | calls: [scene s], to (turn
// ends), staleAt, tokens (default true) }] after `extra` leading world
// agents (idle bystanders). → { world, actions, ends: { index: s },
// stale: { index: s } }. Times are scene seconds (after warmup); the
// world's initial tool is the first start, observed at the enable.
export function workFixture(agents, { seconds, seed = 4242, idle = 0, until = Infinity } = {}) {
    const rng = lcg(seed);
    const world = { agents: [] };
    const actions = [];
    const ends = {};
    const stale = {};
    agents.forEach((a, i) => {
        const tokens = { totalInput: 0, totalOutput: 0 };
        let k = 0;
        const start = (at) => {
            k++;
            if (a.tokens !== false) { tokens.totalInput += TOKENS_PER_START; tokens.totalOutput += TOKENS_PER_START / 3; }
            return { ...WORK_TOOLS[a.b](k), tokens: { ...tokens } };
        };
        world.agents.push({ status: 'working', ...start(), label: `${a.b}#${i}` });
        const last = Math.min(a.to ?? Infinity, a.staleAt ?? Infinity, seconds, until);
        const times = a.calls ? a.calls.map(snapPoll) : [];
        if (!a.calls) {
            for (let t = snapPoll(a.gap * (0.3 + 0.7 * rng())); t < last; t = snapPoll(t + a.gap * (0.6 + 0.8 * rng()))) times.push(t);
        }
        for (const t of times.filter(x => x < last)) {
            actions.push({ at: t, status: { index: i, status: 'working', fields: start() }, label: `${a.b}#${i} tool` });
        }
        if (a.staleAt != null) {
            stale[i] = snapPoll(a.staleAt);
            actions.push({ at: stale[i], status: { index: i, status: 'working', fields: { freshness: { state: 'stale' } } }, label: `${a.b}#${i} stale` });
        }
        if (a.to != null) {
            ends[i] = snapPoll(a.to);
            actions.push({ at: ends[i], status: { index: i, status: 'idle', fields: { currentTool: null, currentToolInput: null } }, label: `${a.b}#${i} idle` });
        }
    });
    for (let j = 0; j < idle; j++) world.agents.push({ status: 'idle' });
    return { world, actions: actions.sort((x, y) => x.at - y.at), ends, stale };
}

// FOL round 2's two reference patterns: the busy day (3 Forge — one goes
// stale at 34 s, two end their turn at 46 s — 2 Archive, 1 Harbor with a
// push and a status) and the other four buildings, two agents each; the
// Mine works from everyone's token burn in both.
export const WORK_PATTERNS = Object.freeze({
    reference: [
        { b: 'forge', gap: 6, to: 46 }, { b: 'forge', gap: 6, to: 46 }, { b: 'forge', gap: 6, staleAt: 34 },
        { b: 'archive', gap: 5 }, { b: 'archive', gap: 7 }, { b: 'harbor', calls: [6, 40] },
    ],
    other: [
        { b: 'taskboard', gap: 6 }, { b: 'taskboard', gap: 6 }, { b: 'observatory', gap: 6 }, { b: 'observatory', gap: 6 },
        { b: 'portal', gap: 6 }, { b: 'portal', gap: 6 }, { b: 'command', gap: 6 }, { b: 'command', gap: 6 },
    ],
});
export const WORK_SECONDS = 60;
// Two routine cues (FOL: arrival and council; both arrivals here, 24 s
// apart — over CueKit's 20 s arrival cooldown — because the lane measure
// reads the routine lane's arrival voice) for the margin-loss check.
const WORK_ROUTINE_AT = Object.freeze([20.2, 44.2]);

// The reference scene (5.1, 5.3, 5.5): `pattern` of WORK_PATTERNS by day or
// night, Village with no music (S2's Village bed), the two routine cues on
// two idle bystanders. `env`: the same scene with the Workshops fader at 0 —
// the environment the stratum is judged in, sample-aligned (one seed), so
// ctx − env on a stem is the workshop stratum alone.
export function workshopScene(pattern, { phase = 'day', env = false } = {}) {
    const agents = WORK_PATTERNS[pattern];
    const f = workFixture(agents, { seconds: WORK_SECONDS, idle: 2 });
    const bystander = agents.length;
    return {
        mode: 'ambient', world: f.world, atmosphere: phase === 'night' ? NIGHT : DAY, force: { music: 0 },
        ...(env ? { layerSteps: { workshops: 0 } } : {}),
        warmup: 10, seconds: WORK_SECONDS, stems: ['work', 'airWet', 'cue', 'limiterIn', 'limiterOut'],
        actions: [
            ...f.actions,
            ...WORK_ROUTINE_AT.map((at, i) => ({ at, emit: 'village:scene', payload: { kind: 'arrival' }, agentIndex: bystander + i, label: `arrival ${i + 1}`, lane: 'routine' })),
        ],
        fixture: { ends: f.ends, stale: f.stale },
    };
}

// 5.3 / 5.5 audibility cells: a percentage must rest on ≥ 20 accents per
// building, and accents are density-driven (never one per call), so the
// audibility fixtures keep every agent working for longer and start tools
// more often than FOL's 60 s pattern: each building of the pattern, two or
// three agents starting a tool every poll or two (two at the Harbor, a git
// call every other poll each), no routine cue, the program alone (and its
// `env` twin).
export const AUDIBILITY_SECONDS = 180;
export const AUDIBILITY_MIN_ACCENTS = 20;
const AUDIBILITY_PATTERNS = Object.freeze({
    reference: [
        { b: 'forge', gap: 2.4 }, { b: 'forge', gap: 2.4 }, { b: 'forge', gap: 2.4 },
        { b: 'archive', gap: 2.4 }, { b: 'archive', gap: 2.4 },
        { b: 'harbor', calls: Array.from({ length: 45 }, (_, i) => 2 + 4 * i) },
        { b: 'harbor', calls: Array.from({ length: 45 }, (_, i) => 4 + 4 * i) },
    ],
    other: [
        { b: 'taskboard', gap: 2.4 }, { b: 'taskboard', gap: 2.4 }, { b: 'observatory', gap: 2.4 }, { b: 'observatory', gap: 2.4 },
        { b: 'portal', gap: 2.4 }, { b: 'portal', gap: 2.4 }, { b: 'command', gap: 2.4 }, { b: 'command', gap: 2.4 },
    ],
});
export function audibilityScene(pattern, { phase = 'day', env = false } = {}) {
    const f = workFixture(AUDIBILITY_PATTERNS[pattern], { seconds: AUDIBILITY_SECONDS, seed: 31 });
    return {
        mode: 'ambient', world: f.world, atmosphere: phase === 'night' ? NIGHT : DAY, force: { music: 0 },
        ...(env ? { layerSteps: { workshops: 0 } } : {}),
        warmup: 10, seconds: AUDIBILITY_SECONDS, stems: [], lint: false, actions: f.actions,
    };
}

// S6 / 5.1: zero onsets from stale agents, `working === 0` and a lost link.
// 0–20 s: two stale working agents and an idle one; 20 s: a fresh smith
// starts; 36.4 s: it goes idle; 44.4 s: it works again; 50 s: the feed
// drops (lost after AudibleWorld's LINK_LOST_AFTER_MS, the `linkLost` cue).
export const WORK_HONESTY = Object.freeze({ freshAt: 20.4, idleAt: 36.4, againAt: 44.4, dropAt: 50 });
export const WORK_HONESTY_SCENE = {
    mode: 'ambient', atmosphere: DAY, force: { music: 0 }, warmup: 10, seconds: 75, stems: ['work'],
    world: {
        agents: [
            { status: 'working', ...WORK_TOOLS.forge(1), signalStale: true },
            { status: 'working', ...WORK_TOOLS.archive(1), freshness: { state: 'stale' } },
            { status: 'idle' },
        ],
    },
    actions: [
        // LinkHealth only declares a loss after the feed was live once.
        { at: -9.5, emit: 'ws:state', raw: true, payload: { state: 'live' }, label: 'feed live' },
        { at: WORK_HONESTY.freshAt, addAgent: { status: 'working', fields: WORK_TOOLS.forge(2) }, label: 'fresh smith' },
        { at: WORK_HONESTY.freshAt + 4, status: { index: 3, status: 'working', fields: WORK_TOOLS.forge(3) }, label: 'smith tool' },
        { at: WORK_HONESTY.idleAt, status: { index: 3, status: 'idle', fields: { currentTool: null, currentToolInput: null } }, label: 'smith idle' },
        { at: WORK_HONESTY.againAt, status: { index: 3, status: 'working', fields: WORK_TOOLS.forge(4) }, label: 'smith again' },
        { at: WORK_HONESTY.dropAt, emit: 'ws:disconnected', raw: true, payload: {}, label: 'feed drops' },
    ],
};

// 5.1 (FOL-5, HAR-12): accents on the drawn downbeat in World (a stand-in
// ritual conductor, page/workshop.js) — and the same village in Dashboard,
// where no ritual exists and the grid de-clumps the poll.
const DOWNBEAT_AGENTS = [
    { b: 'forge', gap: 4 }, { b: 'forge', gap: 4 }, { b: 'archive', gap: 5 }, { b: 'portal', gap: 6 },
    { b: 'command', gap: 6 }, { b: 'observatory', gap: 6 }, { b: 'taskboard', gap: 6 }, { b: 'harbor', calls: [4, 50] },
];
export function workDownbeatScene({ dashboard = false } = {}) {
    const f = workFixture(DOWNBEAT_AGENTS, { seconds: 90, seed: 77 });
    return {
        mode: 'ambient', world: f.world, atmosphere: DAY, force: { music: 0 }, warmup: 10, seconds: 90, rituals: !dashboard, lint: false,
        actions: [
            ...(dashboard ? [{ at: -9.5, emit: 'mode:changed', raw: true, payload: 'dashboard', label: 'mode:dashboard' }] : []),
            ...f.actions,
        ],
    };
}

// 5.4: two smiths (slots) starting a tool every poll or two, so each earns
// accents on both sides of the selection, and a bystander who comes to need
// you; the first smith is selected at 45 s. `select: false` is the twin.
export const WORK_SLOTS = Object.freeze({ selectAt: 45.2, needsYouAt: 62 });
export function workSlotsScene({ select = true } = {}) {
    const f = workFixture([{ b: 'forge', gap: 2.5, tokens: false }, { b: 'forge', gap: 2.5, tokens: false }], { seconds: 90, seed: 11, idle: 1 });
    return {
        mode: 'ambient', world: f.world, atmosphere: DAY, force: { music: 0 }, warmup: 10, seconds: 90, stems: ['work', 'cue'],
        actions: [
            ...f.actions,
            ...(select ? [{ at: WORK_SLOTS.selectAt, select: { index: 0 }, label: 'select smith 1' }] : []),
            ...laneActions('needsYou', WORK_SLOTS.needsYouAt, 2),
        ],
    };
}

// 5.6 (D3): blur 20 s, focus 40 s, against a twin that never blurs.
// village: music playing (no ledger: the first-ever enable's occasion, which
// the blur must release), workers; held: no
// music and a waiting agent (the held note sounds; a needs-you at 30 s);
// town: the Town band (−3 dB) with the same workers (no work stratum, D4).
export const QUIET_MIX = Object.freeze({ blurAt: 20, focusAt: 40, needsYouAt: 30 });
const QUIET_WORKERS = [{ b: 'forge', gap: 2.5 }, { b: 'forge', gap: 2.5 }, { b: 'archive', gap: 3 }, { b: 'harbor', calls: [2] }];
export function quietMixScene(kind, { blur = true } = {}) {
    const f = workFixture(QUIET_WORKERS, { seconds: 55, seed: 23, idle: 2 });
    const window = blur ? [{ at: QUIET_MIX.blurAt, window: 'blur' }, { at: QUIET_MIX.focusAt, window: 'focus' }] : [];
    const base = { atmosphere: DAY, warmup: 10, seconds: 55, world: f.world, actions: [...f.actions, ...window] };
    if (kind === 'village') return { ...base, mode: 'ambient', stems: ['world', 'work', 'music', 'signalBed'] };
    if (kind === 'held') {
        return {
            ...base, mode: 'ambient', force: { music: 0 }, stems: ['world', 'work', 'signalBed', 'cue'],
            world: { agents: [...f.world.agents.slice(0, -1), { status: 'waiting_on_user' }] },
            actions: [...base.actions, ...laneActions('needsYou', QUIET_MIX.needsYouAt, f.world.agents.length - 2)],
        };
    }
    if (kind === 'town') return { ...base, mode: 'bgm', bgm: { piece: 'willowbrook' }, stems: ['music', 'work'] };
    throw new Error(`unknown quiet-mix scene ${kind}`);
}

// 5.7 (SIG-13): the 5-hour quota ratio stepped 0.7 → 1.0 every 8 s through
// `usage:updated`, then the quota going unavailable (stale). One reader
// keeps the village awake. `sweep: false` is the twin without usage.
export const QUOTA_STEPS = Object.freeze({ ratios: [0.7, 0.8, 0.9, 1.0], firstAt: 5, spacing: 8 });
export const QUOTA_STALE_AT = QUOTA_STEPS.firstAt + QUOTA_STEPS.ratios.length * QUOTA_STEPS.spacing;
export function quotaScene({ sweep = true } = {}) {
    const usage = (at, fiveHour, quotaAvailable = true) => ({ at, emit: 'usage:updated', raw: true, payload: { quota: { fiveHour }, quotaAvailable }, label: `quota ${fiveHour}${quotaAvailable ? '' : ' (stale)'}` });
    return {
        mode: 'ambient', atmosphere: DAY, force: { music: 0 }, warmup: 10, seconds: QUOTA_STALE_AT + 8, stems: ['work'],
        world: { agents: [{ status: 'working', ...WORK_TOOLS.archive(1) }] },
        actions: sweep ? [
            ...QUOTA_STEPS.ratios.map((r, i) => usage(QUOTA_STEPS.firstAt + i * QUOTA_STEPS.spacing, r)),
            usage(QUOTA_STALE_AT, 1, false),
        ] : [],
    };
}

// 5.8 (D8): the camera still, then panning across the Harbor (1000 px of a
// 1280 px view at zoom 1 in 6 s: W5Spatial's envelope wants ≥ 4 s over 80 %
// of the viewport), then still again. A smith at the Harbor keeps its chain
// sounding. Scene seconds; `harbor` is SpatialField.BUILDING_WORLD.harbor.
export const CAMERA_PAN = Object.freeze({ stillUntil: 8, panUntil: 14, spanPx: 500, viewportW: 1280, viewportH: 720, zoom: 1, stillFrom: 16 });
export function cameraScene(harbor) {
    const c = CAMERA_PAN;
    return {
        mode: 'ambient', atmosphere: DAY, force: { music: 0 }, warmup: 6, seconds: 30, lint: false,
        world: { agents: [{ status: 'working', ...WORK_TOOLS.harbor(0) }] },
        camera: {
            viewportW: c.viewportW, viewportH: c.viewportH, zoom: c.zoom,
            path: [{ at: c.stillUntil, cx: harbor.x - c.spanPx, cy: harbor.y }, { at: c.panUntil, cx: harbor.x + c.spanPx, cy: harbor.y }],
        },
    };
}

// ================================================================ Wave 6 ====

// Every seat a voicing can admit.
export const MUSIC_SEATS = SEATS;
// The night the Town band and the night occasion are judged at: 22:30 (the
// `night` keyframe, inside the night occasion's 21:00–02:00).
const NIGHT_2230 = Object.freeze({ ...NIGHT, hour: 22.5 });

// A busy island for the Town band's percussion (6.9): every building
// staffed, a tool start every couple of seconds.
const TOWN_BUSY = [
    { b: 'forge', gap: 2.5 }, { b: 'forge', gap: 3 }, { b: 'archive', gap: 3 }, { b: 'archive', gap: 3.5 }, { b: 'harbor', gap: 4 },
    { b: 'taskboard', gap: 3 }, { b: 'observatory', gap: 3.5 }, { b: 'portal', gap: 3.5 }, { b: 'command', gap: 4 },
];

// 6.1 / 6.2 / 6.3: one piece of the Town band pinned in its full band (3)
// at 13:00 (the `noon` keyframe) or 22:30 (`night`)
// in one voice, every seat on its own stem (seat content never depends on
// the band, so each lower band is the sum of the seats it admits), long
// enough for one 16-bar rendition. `seconds` from the piece's own tempo.
// The Town band has no world or work stratum (D4), so the air's wet return
// (`airWet`) is the band's own room: the A/B hears music + air.
export function musicStemScene({ piece, seconds, phase = 'day', voice = 'isle' }) {
    const f = workFixture(TOWN_BUSY, { seconds: seconds + 4, seed: 61 });
    return {
        mode: 'bgm', world: f.world, actions: f.actions, atmosphere: phase === 'night' ? NIGHT_2230 : { ...DAY, hour: 13 },
        bgm: { piece, band: 3, voice }, storage: { [TOWN_BAND_VOICE_KEY]: voice },
        warmup: 1, seconds, stems: ['music', 'airWet'], lint: false,
        musicProbe: { seatStems: MUSIC_SEATS, countNodes: true, stopLint: true },
    };
}

// 6.6 / S7 / must-never 9 fixtures in Village. Times are scene seconds.
//   first    the first-ever enable (no ledger): one full occasion, with
//            its reason, the Village bed under it
//   rain     rain from the start with the first occasion due; clears at 60
//   wait     a needs-you 7 min old with the first occasion due; answered at 60
//   urgent   rain until 20 (so nothing plays), a needs-you at 19: nothing
//            may start before 24
//   resting  a light village whose noon occasion is done: everyone idle at
//            5 (resting from ≈ 35), working again at 150
//   fragment a light village whose noon occasion is done: fragments only
export const VILLAGE_FIXTURES = Object.freeze({
    first: { seconds: 90 },
    fragment: { seconds: 240 },
    rain: { seconds: 110, clearAt: 60 },
    wait: { seconds: 110, answerAt: 60, waitAgeMs: 7 * 60e3 },
    urgent: { seconds: 90, clearAt: 20, urgentAt: 19 },
    resting: { seconds: 240, idleAt: 5, workAt: 150 },
});
// The virtual clock's epoch (page/virtual-clock.js): Date.now() at the
// scene's start is this plus the setup's few seconds.
const VIRTUAL_EPOCH_MS = new Date(2026, 6, 15, 12, 0, 0).getTime();

export function villageMusicScene(kind) {
    const f = VILLAGE_FIXTURES[kind];
    const base = { mode: 'ambient', warmup: 2, seconds: f.seconds, stems: ['world', 'work', 'music'], lint: false, musicProbe: {} };
    const working = { counts: { working: 3, idle: 1 } };
    if (kind === 'first') return { ...base, world: working, atmosphere: DAY };
    if (kind === 'fragment') {
        return { ...base, world: { counts: { working: 2, idle: 1 } }, atmosphere: { ...DAY, hour: 14 }, storage: { [MUSIC_LEDGER_KEY]: settledLedger(['noon']) } };
    }
    if (kind === 'rain') {
        return { ...base, world: working, atmosphere: DAY_RAIN, actions: [{ at: f.clearAt, atmosphere: DAY, label: 'rain clears' }] };
    }
    if (kind === 'wait') {
        return {
            ...base, atmosphere: DAY,
            world: { counts: { working: 3 }, agents: [{ status: 'waiting_on_user', awaitingSince: VIRTUAL_EPOCH_MS - f.waitAgeMs }] },
            actions: [{ at: f.answerAt, status: { index: 3, status: 'working' }, label: 'answered' }, { at: f.answerAt + 0.01, ack: { index: 3 } }],
        };
    }
    if (kind === 'urgent') {
        return {
            ...base, world: { counts: { working: 4 } }, atmosphere: DAY_RAIN,
            actions: [...laneActions('needsYou', f.urgentAt, 3), { at: f.clearAt, atmosphere: DAY, label: 'rain clears' }],
        };
    }
    if (kind === 'resting') {
        const idle = [0, 1].map(index => ({ at: f.idleAt, status: { index, status: 'idle' }, label: 'idle' }));
        const again = [0, 1].map(index => ({ at: f.workAt, status: { index, status: 'working' }, label: 'working' }));
        return {
            ...base, world: { counts: { working: 2 } }, atmosphere: { ...DAY, hour: 14 },
            storage: { [MUSIC_LEDGER_KEY]: settledLedger(['noon']) }, actions: [...idle, ...again],
        };
    }
    throw new Error(`unknown village fixture ${kind}`);
}
const DAY_RAIN = Object.freeze({ ...RAIN });

// 6.7: an hour of the Town band by day on the virtual clock at 12 kHz
// (program only; LUFS-I, re-hearing and the marks): the busy island, a
// needs-you at 20:00 answered at 26:00 (the waiting cadence), arrivals.
export const TOWN_SESSION = Object.freeze({ seconds: 3600, sampleRate: 12000, waitAt: 1200, answerAt: 1560 });
export function townSessionScene({ seconds = TOWN_SESSION.seconds } = {}) {
    const f = workFixture(TOWN_BUSY.map(a => ({ ...a, gap: a.gap * 3 })), { seconds, seed: 67 });
    const actions = [...f.actions];
    if (seconds > TOWN_SESSION.answerAt) {
        actions.push(...laneActions('needsYou', TOWN_SESSION.waitAt, 1));
        actions.push({ at: TOWN_SESSION.answerAt, status: { index: 1, status: 'working' }, label: 'answered' }, { at: TOWN_SESSION.answerAt + 0.01, ack: { index: 1 } });
    }
    return {
        mode: 'bgm', world: { agents: [...f.world.agents, { status: 'idle' }, { status: 'idle' }] }, atmosphere: DAY,
        warmup: 2, seconds, sampleRate: TOWN_SESSION.sampleRate, stepFrames: 256, stems: [], lint: false, actions, musicProbe: {},
    };
}

// 6.7 MUS-9: the waiting cadence — a needs-you at 10 s, answered at 70 s.
export const WAIT_CADENCE = Object.freeze({ waitAt: 10, answerAt: 70, seconds: 140 });
export function waitCadenceScene() {
    return {
        mode: 'bgm', world: { counts: { working: 4 } }, atmosphere: DAY, warmup: 2, seconds: WAIT_CADENCE.seconds, sampleRate: 24000, lint: false,
        actions: [
            ...laneActions('needsYou', WAIT_CADENCE.waitAt, 0),
            { at: WAIT_CADENCE.answerAt, status: { index: 0, status: 'working' }, label: 'answered' },
            { at: WAIT_CADENCE.answerAt + 0.01, ack: { index: 0 } },
        ],
        musicProbe: {},
    };
}

// 6.9: ten minutes of the Town band while the island's workshop density
// climbs and falls — two-minute segments of more and busier agents, then
// nobody working. Agents exist from the start (idle) and work only inside
// their segment, starting a tool every `gap` s.
export const PERCUSSION_SEGMENTS = Object.freeze([
    { from: 0, to: 120, agents: [{ b: 'forge', gap: 9 }, { b: 'archive', gap: 10 }] },
    { from: 120, to: 240, agents: [{ b: 'forge', gap: 4 }, { b: 'archive', gap: 5 }, { b: 'harbor', gap: 5 }, { b: 'taskboard', gap: 5 }] },
    { from: 240, to: 360, agents: TOWN_BUSY.map(a => ({ ...a, gap: 2 })) },
    { from: 360, to: 480, agents: [{ b: 'forge', gap: 6 }, { b: 'command', gap: 7 }, { b: 'observatory', gap: 7 }] },
    { from: 480, to: 600, agents: [] },
]);
export function percussionScene({ segments = PERCUSSION_SEGMENTS, seconds = 600 } = {}) {
    const rng = lcg(69);
    const agents = [];
    const actions = [];
    for (const seg of segments) {
        for (const a of seg.agents) {
            const index = agents.length;
            let k = 0;
            agents.push({ status: 'idle' });
            for (let t = seg.from + a.gap * rng(); t < seg.to - 0.5; t += a.gap * (0.7 + 0.6 * rng())) {
                actions.push({ at: snapPoll(t), status: { index, status: 'working', fields: WORK_TOOLS[a.b](++k) }, label: `${a.b}#${index} tool` });
            }
            actions.push({ at: snapPoll(seg.to - 0.5), status: { index, status: 'idle', fields: { currentTool: null, currentToolInput: null } }, label: `${a.b}#${index} idle` });
        }
    }
    return {
        mode: 'bgm', world: { agents }, atmosphere: DAY, warmup: 2, seconds, sampleRate: 24000, lint: false,
        actions: actions.sort((x, y) => x.at - y.at), stems: ['music'], musicProbe: { seatStems: ['lead', 'percussion'] },
    };
}

// 6.9 MUS-16: rain arrives at 30 s over a busy Town band.
export const RAIN_SWITCH_AT = 30;
export function rainSwitchScene() {
    const f = workFixture(TOWN_BUSY, { seconds: 70, seed: 71 });
    return {
        mode: 'bgm', world: f.world, atmosphere: DAY, warmup: 2, seconds: 70, sampleRate: 24000, lint: false,
        actions: [...f.actions, { at: RAIN_SWITCH_AT, atmosphere: RAIN, label: 'rain' }], musicProbe: {},
    };
}

// ================================================================ Wave 7 ====

// 7.2 Signals: the busy stretch (arrivals, a needs-you answered at 70 s, an
// error that recovers, a limit, a departure) in the Signals preset, captions
// at the default setting; `openWait` keeps the needs-you open to the end (the
// ladder's L2 rings at 2 min; no held note in Signals).
export const SIGNALS_ANSWER_AT = 70;
export function signalsScene({ openWait: keepOpen = false } = {}) {
    const actions = busyActions().filter(a => !(keepOpen && a.at === SIGNALS_ANSWER_AT && a.status?.index === 0));
    return { mode: 'signals', world: BUSY_WORLD, atmosphere: DAY, warmup: 10, seconds: 180, actions, stems: ['cue'], captions: ['auto'] };
}

// 7.4: the first enable of a page session in Village (no ledger: the
// first-ever enable, so the welcome follows), recorded from the enable; a
// needs-you at 26 s for the awakening's level; Off at 33 s and Village again
// at 35 s — the same page session, so no second awakening.
export const AWAKEN = Object.freeze({ steadyFrom: 10, steadyTo: 25, needsYouAt: 26, offAt: 33, onAt: 35, stAtSec: 4 });
export const AWAKEN_SCENE = {
    // 10:15, off the hour: no hour bell at the enable (D7) over the awakening.
    mode: 'ambient', world: { counts: { working: 4, idle: 1 } }, atmosphere: { ...DAY, hour: 10.25 }, warmup: 0, seconds: 40, stems: ['cue', 'music'], musicProbe: {},
    actions: [
        ...laneActions('needsYou', AWAKEN.needsYouAt, 0),
        { at: AWAKEN.offAt, preset: 'off' },
        { at: AWAKEN.onAt, preset: 'village' },
    ],
};

// 7.7 output, tone and soften, through the stored settings the controller
// applies at the enable (`claudeville.sound.output|tone|soften`).
// `outputScene`: the Village with no music and no work stratum, cue-free —
// the program is the world bed (Headphones' ICC, Mono's fold).
// `outputBusyScene`: the same bed with an arrival and a needs-you (Mono's
// loudness with cues). `toneScene`: the world bed in Village or the Town
// band's music, cue-free, for the ±4 dB shelf at 3 kHz.
export function listeningStorage({ output, tone, soften } = {}) {
    return {
        ...(output != null ? { 'claudeville.sound.output': output } : {}),
        ...(tone != null ? { 'claudeville.sound.tone': String(tone) } : {}),
        ...(soften != null ? { 'claudeville.sound.soften': soften } : {}),
    };
}
export function outputScene(listening = {}) {
    return { mode: 'ambient', world: { counts: { working: 4, idle: 1 } }, atmosphere: DAY, layerSteps: { hum: 0 }, force: { music: 0 }, warmup: 10, seconds: 30, stems: [], storage: listeningStorage(listening) };
}
export function outputBusyScene(listening = {}) {
    return {
        ...outputScene(listening), layerSteps: {},
        actions: [{ at: 6, emit: 'village:scene', payload: { kind: 'arrival' }, agentIndex: 1, label: 'arrival', lane: 'routine' }, ...laneActions('needsYou', 16, 0)],
    };
}
export function toneScene(bed, tone) {
    if (bed === 'music') return { mode: 'bgm', world: { counts: { working: 4, idle: 1 } }, atmosphere: DAY, bgm: { piece: 'willowbrook' }, warmup: 6, seconds: 30, stems: [], storage: listeningStorage({ tone }) };
    return outputScene({ tone });
}

// 7.7 soften: a storm Village (no music) with an arrival (a struck bell), a
// full-intensity flash (thunder), a needs-you (stays whole) and an error,
// rendered with Soften on and off.
export const SOFTEN = Object.freeze({ arrivalAt: 4, flashAt: 10, needsYouAt: 22, errorAt: 32 });
export function softenScene(soften) {
    return {
        mode: 'ambient', world: { counts: { working: 4, idle: 1 } }, atmosphere: STORM, force: { music: 0 }, warmup: 10, seconds: 42,
        stems: ['cue'], storage: listeningStorage({ soften: soften ? 'on' : 'off' }),
        actions: [
            { at: SOFTEN.arrivalAt, emit: 'village:scene', payload: { kind: 'arrival' }, agentIndex: 3, label: 'arrival', lane: 'routine' },
            { at: SOFTEN.flashAt, emit: 'weather:storm-flash', payload: { intensity: 1 }, label: 'storm-flash 1' },
            ...laneActions('needsYou', SOFTEN.needsYouAt, 0),
            ...laneActions('error', SOFTEN.errorAt, 1),
        ],
    };
}
