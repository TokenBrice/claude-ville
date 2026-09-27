import { SEATS } from '../../../claudeville/src/presentation/shared/audio/music/Voicings.js';

// The virtual-clock probe's named scenes (page/virtual.js specs). Scene
// time: `warmup` seconds settle the enable fade and the director's level
// slews and are discarded; action `at` is seconds after warmup. `mode` is
// the stored preset: 'bgm' (the Town band) or 'signals' (no music: nothing
// sounds between the cues).
// Targets live in Loudness.js (S2); the judges in checks.mjs.

const DAY = Object.freeze({ phase: 'day', progress: 0.5, weather: { type: 'clear', windX: 0.3 } });
const RAIN = Object.freeze({ phase: 'day', progress: 0.5, weather: { type: 'rain', intensity: 0.7, windX: 0.6 } });
const NIGHT = Object.freeze({ phase: 'night', progress: 0.5, weather: { type: 'clear', windX: 0.3 } });

export const TOWN_BAND_VOICE_KEY = 'claudeville.sound.townBandVoice';

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
    // S2's Town band row. `musicProbe`: the sequencer's marks and the
    // MusicClock frames (6.5's routine-cue clash reads both).
    townBand: { mode: 'bgm', world: BUSY_WORLD, atmosphere: DAY, warmup: 10, seconds: 180, actions: busyActions(), stems: ['music', 'cue'], musicProbe: {} },
    // The same busy stretch in Signals: the attention voices over silence.
    signalsBusy: { mode: 'signals', world: BUSY_WORLD, atmosphere: DAY, warmup: 10, seconds: 180, actions: busyActions(), stems: ['cue'] },
    // Must-never 12: Signals → Town band at 15 s, back at 45 s (the
    // controller's 0.8 s signals fade both ways).
    presetSwitch: {
        mode: 'signals', world: { counts: { working: 4, idle: 1 } }, atmosphere: DAY, warmup: 15, seconds: 65,
        actions: [{ at: 15, mode: 'bgm' }, { at: 45, mode: 'signals' }],
    },
    // HAR-12: body-anchored arrivals whose accent the "renderer" declares
    // 450–800 ms ahead (sooner than the cue's own lead, the sound follows the
    // body and lands late by design), plus free cues; published and accent
    // times vs heard. Cues sit 16 s apart — within the routine lane's 4/min
    // (6/min with 2/min reserved for outcomes) — and each kind ≥ its CueKit
    // cooldown (arrival and departure 20 s), so every one is admitted. Over
    // the Town band (Signals sounds no arrival): 3.5's grid may move a
    // body-anchored cue by up to 60 ms onto the band's grid, and the
    // published notes carry it; the MusicClock frames (musicProbe) let the
    // gate check each move landed on that grid.
    avSync: {
        mode: 'bgm', world: { counts: { working: 12 } }, atmosphere: DAY, warmup: 8, seconds: 140, stems: ['cue'], musicProbe: {},
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
// release is the one Major outcome, so each is placed once.
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
// The beds: `signals` is S2's no-music bed (CueLevel's `village` context)
// as the Signals preset plays it — silence between the attention voices,
// the only lanes it sounds; each call meets a bed quieter than any S2 row,
// so its window's ceiling is exempt (S2: a cue that lands into a bed that
// quiet is gated only by the limiter GR). `music` is the Town band;
// `bandBusy` / `bandBusyChip` the Town band over the busy island (every
// building working, so the arrangement and percussion play; Willowbrook
// pinned, the reel's piece), in the Isle voice and in Chip, for the urgent
// lanes; the probe prints the band each placement meets.
export const MARGIN_BEDS = {
    signals: { bed: 'village', mode: 'signals', atmosphere: DAY, silent: true, lanes: URGENT_MARGIN_LANES },
    music: { bed: 'music', mode: 'bgm', atmosphere: DAY },
    bandBusy: { bed: 'music', mode: 'bgm', atmosphere: DAY, busy: true, piece: 'willowbrook', voice: 'isle', lanes: URGENT_MARGIN_LANES },
    bandBusyChip: { bed: 'music', mode: 'bgm', atmosphere: DAY, busy: true, piece: 'willowbrook', voice: 'chip', lanes: URGENT_MARGIN_LANES },
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
        : { counts: { working: crowd } };
    return {
        mode: bed.mode, world, atmosphere: bed.atmosphere,
        ...(bed.voice ? { storage: { [TOWN_BAND_VOICE_KEY]: bed.voice } } : {}),
        ...(bed.piece ? { bgm: { piece: bed.piece } } : {}),
        warmup: 10, seconds, actions: [...(lead?.actions ?? []), ...actions].sort((a, b) => a.at - b.at),
        stems: ['cue', 'music', 'limiterIn', 'limiterOut'],
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

// 2.1 (ENG-8): ten minutes of a working island on the Transport, both
// presets, a weather change, with the lint's stack capture off so timer
// costs are the app's. Three busy stretches in the Town band, rain at 5:00,
// Signals from 7:00 to 9:00.
export const TRANSPORT_SCENE = {
    mode: 'bgm', world: BUSY_WORLD, atmosphere: DAY, warmup: 10, seconds: 600, lint: false,
    actions: [
        ...[0, 180, 360].flatMap(offset => busyActions().map(a => ({ ...a, at: a.at + offset }))),
        { at: 300, atmosphere: RAIN, label: 'rain' },
        { at: 420, mode: 'signals' },
        { at: 540, mode: 'bgm' },
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

// 2.4 Island Air on the engine alone: the two baked IRs (T60), and an 8 ms
// burst through connectVoice at raw place() values for d = 0 (screen
// centre) and d = 1 (the right edge), 4.5 s apart — INFO beside the cue
// path's D/R below.
const VIEW = { viewportW: 1440, viewportH: 900 };
export const AIR_UNIT = {
    seconds: 10, phase: 'day', kind: 'world',
    bursts: [
        { at: 0.5, d: 0, screen: { screenX: 720, screenY: 450, ...VIEW } },
        { at: 5, d: 1, screen: { screenX: 1440, screenY: 450, ...VIEW } },
    ],
};

// Through the real cue path over the Town band with its air sends cut (the
// wet return carries cue sends only): an arrival placed at d = 0 and one at
// d = 1 (their direct-to-reverberant ratio), and three needs-you calls
// (urgent wet re dry). Arrivals sit 28 s apart (CueKit's 20 s arrival
// cooldown).
export const AIR_ARRIVALS = [{ at: 3, d: 0, x: 0.5 }, { at: 31, d: 1, x: 1 }];
export const AIR_CUE_SCENE = {
    mode: 'bgm', world: { counts: { working: 6 } }, atmosphere: DAY, warmup: 10, seconds: 38,
    actions: [
        ...AIR_ARRIVALS.map(a => ({ at: a.at, emit: 'village:scene', payload: { kind: 'arrival', normalizedScreenX: a.x, normalizedScreenY: 0.5 }, agentIndex: 4 + a.d, label: `arrival d = ${a.d}`, lane: 'routine' })),
        ...[0, 1, 2].flatMap(i => laneActions('needsYou', 10 + i * 7, i)),
    ],
    stems: ['cue', 'airWet'], airOff: 'bed',
};

// Air contribution: the Town band scene with every air send cut.
export const TOWN_DRY_SCENE = { ...SCENES.townBand, stems: [], airOff: 'all' };

// ================================================================ Wave 3 ====

// 3.1–3.6 / S1: every cue voice once, governor-free (the capture tool's
// path: what a voice sounds like once admitted), in Signals (nothing
// sounds between the cues) on the cue stem, each in its own slot.
// `stratum` is S1's; `family` groups a reminder with its family's entry
// voice (the same figure by design, never judged against it);
// `signalsOnly` marks a voice heard only where nothing but signals plays
// (`answered`, the Signals preset: judged against the signal voices
// alone); `sec` the slot (the counted hour needs its strikes ≥ 1 s apart).
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
        mode: 'signals', atmosphere: night ? NIGHT : DAY, warmup: 4, seconds: Math.ceil(slots[slots.length - 1].end + 1),
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
        mode: 'bgm', world: { counts: { working: 3 } }, atmosphere: DAY, seconds, captions: ['auto'],
        actions: [
            ...openWait(family, LADDER_OPEN_SEC, 0),
            ...(ackAt != null ? [{ at: ackAt, ack: { index: 0 }, label: 'ack' }] : []),
        ],
    };
}

// 3.3 hidden tab with sound on (Signals): the wait opens while visible, the
// tab hides 20 s later and stays hidden past the second L4; each reminder
// must wake the paused context. The audio clock freezes while suspended, so
// `seconds` is audio time (the visible start and every wake); the tab shows
// again at the end so the render finishes.
export const WAKE_HIDE_SEC = 25;
export const WAKE_SHOW_SEC = 940;
export const WAKE_SCENE = {
    mode: 'signals', world: { counts: { working: 3 } }, atmosphere: DAY, warmup: 10, seconds: 120, freezeOnSuspend: true,
    stems: ['cue'], lint: false,
    actions: [
        ...openWait('needsYou', LADDER_OPEN_SEC, 0),
        { at: WAKE_HIDE_SEC, visibility: 'hidden', label: 'hide' },
        { at: WAKE_SHOW_SEC, visibility: 'visible', label: 'show' },
    ],
};

// 3.3 held trim, sound on: one needs-you wait through L1, L2 (2 min) and L3
// (6 min) in Signals (the no-music bed); the ladder takes its trim at entry
// and holds it, so L2 lands ≥ 4 LU under L1 and L3 keeps urgent GR ≤ 3 dB.
export const LADDER_TRIM_SCENE = {
    mode: 'signals', world: { counts: { working: 4 } }, atmosphere: DAY, warmup: 10, seconds: 380,
    stems: ['cue', 'limiterIn', 'limiterOut'], lint: false,
    actions: openWait('needsYou', LADDER_OPEN_SEC, 0),
};

// The same wait over the Town band (reel v3: there the ladder held its first
// reminder's trim, not the entry's).
export const LADDER_TRIM_BAND_SCENE = { ...LADDER_TRIM_SCENE, mode: 'bgm' };

// SIG-10 cluster: one raise vs six same-tick raises in Signals, needs-you or
// errors.
export const CLUSTER_AT = 6;
export const CLUSTER_KIND = Object.freeze({ needsYou: 'summons', errors: 'distress' });
export function clusterScene(n, family = 'needsYou') {
    return {
        mode: 'signals', world: { counts: { working: 6 + n } }, atmosphere: DAY, warmup: 10, seconds: 16,
        stems: ['cue', 'limiterIn', 'limiterOut'],
        actions: Array.from({ length: n }, (_, i) => openWait(family, CLUSTER_AT, 6 + i)).flat(),
    };
}

// Must-never 13 (SIG-9): stale agents make no sound — a stale waiting, a
// stale errored and a stale working agent, each flagged by one of the
// AudibleWorld stale markers, raise their events like fresh ones would.
export const STALE_SCENE = {
    mode: 'signals', atmosphere: DAY, warmup: 10, seconds: 40,
    world: {
        counts: { idle: 2 },
        agents: [
            { status: 'working', signalStale: true },
            { status: 'working', freshness: { state: 'stale' } },
            { status: 'working', resident: true },
        ],
    },
    stems: ['cue'],
    actions: [
        { at: 5, status: { index: 2, status: 'waiting_on_user' } },
        { at: 5.01, emit: 'attention:raised', payload: { waitingCount: 1, oldestWaitMs: 0, status: 'waiting_on_user' }, agentIndex: 2, label: 'stale needs-you' },
        { at: 12, status: { index: 3, status: 'errored' } },
        { at: 12.01, emit: 'distress:watchtower', payload: { kind: 'errored' }, agentIndex: 3, label: 'stale error' },
    ],
};

// 3.4 outcome fixtures through their producers (World mode, then
// Dashboard), over the Town band (Signals only captions outcomes).
// Agents: 0–3 workers, 4 a parent with sub-agents added below.
const OUTCOME_WORLD = { counts: { working: 5 } };
export const OUTCOME_SCENE = {
    mode: 'bgm', world: OUTCOME_WORLD, atmosphere: DAY, warmup: 10, seconds: 150, stems: ['cue'], captions: ['auto'],
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
    mode: 'bgm', world: OUTCOME_WORLD, atmosphere: DAY, warmup: 10, seconds: 45, stems: ['cue'],
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
export const CAPTION_MODES = Object.freeze(['signals', 'bgm']);
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

// ======================================================= the busy island ====
// Agents work at a building through their current tool
// (`classifyTool(currentTool, currentToolInput)`, the World model's own
// fields); a tool start is a change of that pair, observed on the 2 s poll
// (phase 0.4 s) as the real feed delivers it. Each start also burns tokens,
// which keeps the Mine working (WorkshopModel, the Town band's percussion
// densities).
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

// agents: [{ b, gap (median s between starts) }] then `idle` idle
// bystanders. → { world, actions }. Times are scene seconds (after warmup);
// the world's initial tool is the first start, observed at the enable.
export function workFixture(agents, { seconds, seed = 4242, idle = 0 } = {}) {
    const rng = lcg(seed);
    const world = { agents: [] };
    const actions = [];
    agents.forEach((a, i) => {
        const tokens = { totalInput: 0, totalOutput: 0 };
        let k = 0;
        const start = () => {
            k++;
            tokens.totalInput += TOKENS_PER_START;
            tokens.totalOutput += TOKENS_PER_START / 3;
            return { ...WORK_TOOLS[a.b](k), tokens: { ...tokens } };
        };
        world.agents.push({ status: 'working', ...start(), label: `${a.b}#${i}` });
        for (let t = snapPoll(a.gap * (0.3 + 0.7 * rng())); t < seconds; t = snapPoll(t + a.gap * (0.6 + 0.8 * rng()))) {
            actions.push({ at: t, status: { index: i, status: 'working', fields: start() }, label: `${a.b}#${i} tool` });
        }
    });
    for (let j = 0; j < idle; j++) world.agents.push({ status: 'idle' });
    return { world, actions: actions.sort((x, y) => x.at - y.at) };
}

// A busy island for the Town band's percussion (6.9): every building
// staffed, a tool start every couple of seconds.
const TOWN_BUSY = [
    { b: 'forge', gap: 2.5 }, { b: 'forge', gap: 3 }, { b: 'archive', gap: 3 }, { b: 'archive', gap: 3.5 }, { b: 'harbor', gap: 4 },
    { b: 'taskboard', gap: 3 }, { b: 'observatory', gap: 3.5 }, { b: 'portal', gap: 3.5 }, { b: 'command', gap: 4 },
];

// 5.6 (D3): the Town band (−3 dB while the window is blurred) over the busy
// island; blur 20 s, focus 40 s, against a twin that never blurs.
export const QUIET_MIX = Object.freeze({ blurAt: 20, focusAt: 40 });
export function quietMixScene({ blur = true } = {}) {
    const f = workFixture(TOWN_BUSY.slice(0, 4), { seconds: 55, seed: 23, idle: 2 });
    const window = blur ? [{ at: QUIET_MIX.blurAt, window: 'blur' }, { at: QUIET_MIX.focusAt, window: 'focus' }] : [];
    return {
        mode: 'bgm', bgm: { piece: 'willowbrook' }, atmosphere: DAY, warmup: 10, seconds: 55, world: f.world,
        actions: [...f.actions, ...window], stems: ['music'],
    };
}

// ================================================================ Wave 6 ====

// Every seat a voicing can admit.
export const MUSIC_SEATS = SEATS;
// The night the Town band is judged at: 22:30 (the `night` keyframe).
const NIGHT_2230 = Object.freeze({ ...NIGHT, hour: 22.5 });

// 6.1 / 6.2 / 6.3: one piece of the Town band pinned in its full band (3)
// at 13:00 (the `noon` keyframe) or 22:30 (`night`)
// in one voice, every seat on its own stem (seat content never depends on
// the band, so each lower band is the sum of the seats it admits), long
// enough for one 16-bar rendition. `seconds` from the piece's own tempo.
// The Town band is the whole program between cues, so the air's wet return
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
// ladder's L2 rings at 2 min).
export const SIGNALS_ANSWER_AT = 70;
export function signalsScene({ openWait: keepOpen = false } = {}) {
    const actions = busyActions().filter(a => !(keepOpen && a.at === SIGNALS_ANSWER_AT && a.status?.index === 0));
    return { mode: 'signals', world: BUSY_WORLD, atmosphere: DAY, warmup: 10, seconds: 180, actions, stems: ['cue'], captions: ['auto'] };
}

// 7.4: the first enable of a page session in the Town band (the default
// preset), recorded from the enable; a needs-you at 26 s for the
// awakening's level; Off at 33 s and the Town band again at 35 s — the same
// page session, so no second awakening.
export const AWAKEN = Object.freeze({ steadyFrom: 10, steadyTo: 25, needsYouAt: 26, offAt: 33, onAt: 35, stAtSec: 4 });
export const AWAKEN_SCENE = {
    // 10:15, off the hour: no hour bell at the enable (D7) over the awakening.
    mode: 'bgm', world: { counts: { working: 4, idle: 1 } }, atmosphere: { ...DAY, hour: 10.25 }, warmup: 0, seconds: 40, stems: ['cue', 'music'], musicProbe: {},
    actions: [
        ...laneActions('needsYou', AWAKEN.needsYouAt, 0),
        { at: AWAKEN.offAt, preset: 'off' },
        { at: AWAKEN.onAt, preset: 'townBand' },
    ],
};

// 7.7 output, tone and soften, through the stored settings the controller
// applies at the enable (`claudeville.sound.output|tone|soften`).
// `outputScene`: the Town band (Willowbrook pinned), cue-free — the program
// is the band (Mono's fold, the tone shelf). `outputBusyScene`: the same
// band with an arrival and a needs-you (Mono's loudness with cues).
export function listeningStorage({ output, tone, soften } = {}) {
    return {
        ...(output != null ? { 'claudeville.sound.output': output } : {}),
        ...(tone != null ? { 'claudeville.sound.tone': String(tone) } : {}),
        ...(soften != null ? { 'claudeville.sound.soften': soften } : {}),
    };
}
export function outputScene(listening = {}) {
    return { mode: 'bgm', world: { counts: { working: 4, idle: 1 } }, atmosphere: DAY, bgm: { piece: 'willowbrook' }, warmup: 6, seconds: 30, stems: [], storage: listeningStorage(listening) };
}
export function outputBusyScene(listening = {}) {
    return {
        ...outputScene(listening),
        actions: [{ at: 6, emit: 'village:scene', payload: { kind: 'arrival' }, agentIndex: 1, label: 'arrival', lane: 'routine' }, ...laneActions('needsYou', 16, 0)],
    };
}

// 7.7 soften: the Town band with an arrival (a struck bell), a needs-you
// (stays whole) and an error, rendered with Soften on and off; the band's
// note-timed ducks under the non-urgent cues carry Soften's duck scale.
export const SOFTEN = Object.freeze({ arrivalAt: 4, needsYouAt: 22, errorAt: 32 });
export function softenScene(soften) {
    return {
        mode: 'bgm', world: { counts: { working: 4, idle: 1 } }, atmosphere: DAY, warmup: 10, seconds: 42,
        stems: ['cue'], storage: listeningStorage({ soften: soften ? 'on' : 'off' }),
        actions: [
            { at: SOFTEN.arrivalAt, emit: 'village:scene', payload: { kind: 'arrival' }, agentIndex: 3, label: 'arrival', lane: 'routine' },
            ...laneActions('needsYou', SOFTEN.needsYouAt, 0),
            ...laneActions('error', SOFTEN.errorAt, 1),
        ],
    };
}
