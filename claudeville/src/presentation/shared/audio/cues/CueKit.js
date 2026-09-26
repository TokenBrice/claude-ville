// One-shot cue voices (plan Wave 3). Every cue is struck from the material
// palette (cues/Materials.js): signal bells at fixed pitches, routine chimes
// on the sounding chord (MusicalScale roles), outcomes and scenery on the key
// with a clash guard, the motif quotes from Motifs.js. Each accepted cue gets
// its own bed-aware trim, placed once through `engine.connectVoice` (pan,
// distance, Island Air; plan S5) onto the cue bus, and one note-timed duck of
// the bed (plan S3), cancelled with the cue. While music plays, routine and
// outcome cues land on the band's grid and scenery on its next bar (S4);
// signal cues never wait.

import { MIN_GAIN, rand } from '../AudioEngine.js';
import { degreeSemi, guardSemi, noteHz, phaseKey, roleSemi, tonicTriad } from '../MusicalScale.js';
import { CUE_LANES, isUrgentCueLane, outcomeTier } from '../CueGovernor.js';
import { URGENT_TRIM_MEMORY_MS, cueTrimDb, isUrgentLevelLane } from '../CueLevel.js';
import { makeFilter } from '../Filters.js';
import { AUDIBILITY_WINDOWS, DUCK_DEPTHS, VOICE_REGISTRY } from '../Loudness.js';
import { ARRIVAL_LEAP, AURORA_FIGURE, HOUR_FIGURE } from '../Motifs.js';
import {
    CUE_ACCENT_NOTE,
    anchoredCueDelayMs,
    cueNoteOffsetsMs,
    cueScoreKey,
    cueSourceEventId,
    hourCount,
    hourCounts,
    ladderLevel,
    publishCueScore,
    reminderVoice,
    shipBellPairs,
} from '../CueScore.js';
import { eventBus } from '../../../../domain/events/DomainEvent.js';
import { rngStream } from '../Rng.js';
import { place } from '../SpatialField.js';
import {
    ESCAPEMENT,
    HORN,
    LANTERN_OUT,
    LEVELS as G,
    STONE,
    WHOOSH,
    chimeForProvider,
    material,
    strikePlan,
} from './Materials.js';

const COOLDOWNS_MS = {
    arrival: 20000,
    departure: 20000,
    distress: 30000,
    limit: 30000,
    recovery: 30000,
    council: 60000,
    hourBell: 55 * 60000,
    aurora: 120000,
    thunder: 8000,
    summons: 45000,
    // The ladder and the governor's reminder caps pace reminders (S7).
    reminder: 0,
    answered: 2000,
    // Outcomes arrive aggregated by the director (1.5 s, exact counts); the
    // kind cooldown only stops a double delivery. Major: one release a time.
    turnDone: 1500,
    subagentReturn: 1500,
    commit: 1500,
    dispatch: 3000,
    toolFailed: 3000,
    pushFailed: 3000,
    push: 3000,
    release: 5 * 60000,
    linkLost: 60000,
    linkRestored: 60000,
    digest: 60000,
};

// The stratum each kind speaks in (S1): it decides pitch rule and timing.
const STRATUM_BY_KIND = Object.freeze({
    summons: 'signal',
    distress: 'signal',
    limit: 'signal',
    reminder: 'signal',
    answered: 'signal',
    arrival: 'routine',
    departure: 'routine',
    recovery: 'routine',
    council: 'routine',
    turnDone: 'outcome',
    subagentReturn: 'outcome',
    toolFailed: 'outcome',
    pushFailed: 'outcome',
    commit: 'outcome',
    push: 'outcome',
    release: 'outcome',
    dispatch: 'outcome',
    hourBell: 'scenery',
    aurora: 'scenery',
    linkLost: 'scenery',
    linkRestored: 'scenery',
    digest: 'scenery',
    thunder: 'weather',
});

// Which cues are located, and how (plan S5): signal cues stay close, dry and
// at full level; routine and outcome cues carry distance. Scenery sounds
// from the island.
const PLACEMENT_BY_STRATUM = Object.freeze({ signal: 'signal', routine: 'world', outcome: 'world' });

export function cuePlacementKind(kind) {
    return PLACEMENT_BY_STRATUM[STRATUM_BY_KIND[kind]] ?? null;
}

// Island Air sends (AMB-2 / ENG-6 table). Signal cues take place()'s cap
// (0.12; S5 overrides ENG-6's distress 0.2); routine and outcome cues grow
// wetter with distance; scenery has fixed sends, except thunder, which is
// wetter the farther the strike (thunderPlan).
const ROUTINE_AIR_NEAR = 0.18;
const ROUTINE_AIR_PER_DISTANCE = 0.45;
const SCENERY_AIR = Object.freeze({
    hourBell: 0.45,
    aurora: 0.4,
    linkLost: 0.2,
    linkRestored: 0.3,
    digest: 0.15,
});

function cuePlacement(kind, cue = {}) {
    const placementKind = cuePlacementKind(kind);
    if (kind === 'thunder') return { pan: 0, gain: 1, lowpassHz: null, air: thunderAir(cue.intensity ?? 1) };
    if (!placementKind) return { pan: 0, gain: 1, lowpassHz: null, air: SCENERY_AIR[kind] ?? 0 };
    const placed = place(cue.spot ?? null, { kind: placementKind });
    if (placementKind === 'signal') return placed;
    return { ...placed, air: ROUTINE_AIR_NEAR + ROUTINE_AIR_PER_DISTANCE * Math.min(1, placed.distance) };
}

// Weather/clock cues and the once-per-return digest are exempt from the
// global chatter budget.
const UNBUDGETED = new Set(['thunder', 'hourBell', 'digest']);
// Routine and scenery bursts collapse into one representative; everything
// else carries its own identity (councils, outcomes already aggregated by
// the director, reminders, link cues, the digest).
const AGGREGATED = new Set(['arrival', 'departure', 'recovery', 'hourBell', 'aurora', 'thunder']);

// The kind decides the lane: the directors already chose the kind from the
// agent's bucket (ActionableRouting), so status is never consulted again here.
const LANE_BY_KIND = Object.freeze({
    arrival: CUE_LANES.ROUTINE,
    departure: CUE_LANES.ROUTINE,
    recovery: CUE_LANES.ROUTINE,
    council: CUE_LANES.ROUTINE,
    distress: CUE_LANES.ERRORS,
    limit: CUE_LANES.QUOTA,
    summons: CUE_LANES.NEEDS_YOU,
    // The non-urgent signal lane: plays while hidden, dropped only under an
    // urgent guard (3.3, 3.7: link cues are not scenery, which is suppressed
    // while hidden).
    reminder: CUE_LANES.REMINDER,
    answered: CUE_LANES.REMINDER,
    linkLost: CUE_LANES.REMINDER,
    linkRestored: CUE_LANES.REMINDER,
    turnDone: CUE_LANES.OUTCOME,
    subagentReturn: CUE_LANES.OUTCOME,
    toolFailed: CUE_LANES.OUTCOME,
    pushFailed: CUE_LANES.OUTCOME,
    commit: CUE_LANES.OUTCOME,
    push: CUE_LANES.OUTCOME,
    release: CUE_LANES.OUTCOME,
    dispatch: CUE_LANES.OUTCOME,
    hourBell: CUE_LANES.SCENERY,
    aurora: CUE_LANES.SCENERY,
    thunder: CUE_LANES.SCENERY,
    digest: CUE_LANES.SCENERY,
});

export function laneForCueKind(kind) {
    return LANE_BY_KIND[kind] || null;
}

// The S2 audibility lane each kind is levelled against (CueLevel.js).
const LEVEL_LANE_BY_STRATUM = Object.freeze({ routine: 'routine', scenery: 'scenery', weather: 'thunder' });
const LEVEL_LANE_BY_SIGNAL = Object.freeze({ summons: 'needsYou', answered: 'needsYou', distress: 'error', limit: 'limit' });
const OUTCOME_LEVEL_LANE = Object.freeze({ minor: 'outcomeMinor', medium: 'outcomeMedium', major: 'outcomeMajor' });

// The voice a kind sounds with: a reminder rings its family's entry voice.
// Over the Town band a Minor outcome's knock is voiced a little firmer: its
// trim may never lift it (S2), and over the band it would sit more than 1 LU
// under the bed (the Town band window, −1…+3 LU) while still ≥ 3 LU under a
// routine cue.
const TOWN_BAND_MINOR_VOICE_DB = 0.6;
function presetVoiceDb(kind, cue) {
    if (cue.preset !== 'townBand' || STRATUM_BY_KIND[kind] !== 'outcome') return 0;
    return (cue.tier ?? outcomeTier(kind)) === 'minor' ? TOWN_BAND_MINOR_VOICE_DB : 0;
}

// The Signals-only answer is levelled as part of the call it answers.
function voiceKind(kind, cue) {
    if (kind === 'reminder') return reminderVoice(cue).kind;
    return kind === 'answered' ? 'summons' : kind;
}

function levelLane(kind, cue) {
    const stratum = STRATUM_BY_KIND[kind];
    if (stratum === 'signal') return LEVEL_LANE_BY_SIGNAL[voiceKind(kind, cue)];
    if (stratum === 'outcome') return OUTCOME_LEVEL_LANE[cue.tier ?? outcomeTier(kind)] ?? 'outcomeMinor';
    return LEVEL_LANE_BY_STRATUM[stratum] ?? null;
}

// The fixed cue stage the registry's nominal loudness was measured through
// (mix-v2-nominal: trim 0 behind a 0.72 cue bus). Each cue's own trim gain
// carries it, so a registry value stays the level the voice really has.
const CUE_STAGE_GAIN = 0.72;

// Each voice's own level (dB) at trim 0 over its palette balance, so its
// registry nominal sits where its lane's trim can place it: an urgent voice
// quiet enough that a trim ≥ 0 never pushes it past its lane ceiling over a
// calm bed, an unlifted one (Minor outcomes, scenery) loud enough for its
// window floor over a busy bed. A reminder takes its family's voice level.
const VOICE_LEVEL_DB = Object.freeze({
    summons: -10.3,
    distress: -15.0,
    limit: -12.4,
    arrival: -8,
    departure: -8,
    recovery: -8,
    council: -8,
    toolFailed: -4,
    pushFailed: -4,
    commit: -4,
    push: -4,
    release: -9,
    turnDone: -1.8,
    subagentReturn: 0.2,
    dispatch: 5.7,
    hourBell: -3,
    aurora: -1.5,
    linkLost: 3,
});

// The bed stays ducked this long past the last note, so it returns as the
// bell rings out rather than under its strike (S3). An urgent call holds the
// full 0.35 s with the scheduler's release; routine, outcome and scenery
// cues give the bed back sooner, so the room they take stays within the
// ducked-time budget (≤ 5 % of an hour per bus, C-MIX-5).
const DUCK_HOLD_AFTER_LAST_NOTE_SEC = 0.35;
const LIGHT_DUCK_HOLD_SEC = 0.2;
const LIGHT_DUCK_RELEASE_SEC = 0.4;

const dbToGain = db => Math.pow(10, db / 20);

// Thunder is weather and ducks nothing; urgent cues carve the deepest room;
// the rest depend on the preset (Village ducks the bed, Town band the band).
// A reminder ducks as its ladder step does (SIG-2): L2 nothing, L3 like a
// routine cue, L4 like an urgent call.
function duckDepthsFor(kind, lane, cue) {
    if (kind === 'thunder') return DUCK_DEPTHS.thunder;
    const routine = cue.preset === 'townBand' ? DUCK_DEPTHS.townBand : DUCK_DEPTHS.village;
    if (kind === 'reminder') {
        const { level } = reminderVoice(cue);
        if (level <= 2) return null;
        return level >= 4 ? DUCK_DEPTHS.urgent : routine;
    }
    if (isUrgentCueLane(lane)) return DUCK_DEPTHS.urgent;
    return routine;
}

function ducksAnything(depths) {
    return Boolean(depths) && Object.values(depths).some(db => Number(db) < 0);
}

// Fallback caption labels; the caption surface composes its own copy from
// the fields `_emitCue` forwards.
const CUE_LABELS = {
    arrival: 'Agent arrived',
    departure: 'Agent departed',
    distress: 'hit an error',
    limit: 'is rate limited',
    recovery: 'Agent recovered',
    council: 'Council gathering',
    hourBell: 'Hour bell',
    aurora: 'Chronicle milestone',
    summons: 'Agent needs you',
    thunder: 'Thunder',
    reminder: 'Still waiting',
    answered: 'Answered',
    turnDone: 'Turn finished',
    subagentReturn: 'Sub-agent returned',
    toolFailed: 'Command failed',
    pushFailed: 'Push failed',
    commit: 'Committed',
    push: 'Pushed',
    release: 'Released',
    dispatch: 'Sub-agents dispatched',
    linkLost: 'Live feed lost',
    linkRestored: 'Live feed restored',
    digest: 'While you were away',
};

// Cue fields the caption surface reads, forwarded when present.
const CAPTION_FIELDS = Object.freeze([
    'count', 'level', 'family', 'oldestMs', 'hour', 'teamName', 'teamSize', 'repo', 'version', 'status', 'soundOnly',
    'flock', 'clusterIndex',
]);

// Web Audio needs a moment of lead time before the first note; the score is
// published with the same lead, so a published time is a heard time. The
// error's grace strike (−25 ms) sits inside it.
const START_LEAD_MS = 30;

const URGENT_GUARD_MS = Object.freeze({
    distress: 3300,
    limit: 3300,
    summons: 2800,
});

// A superseded note that has not sounded yet is released over this ramp, so
// cancelling it can never click (S8: every stop is a ≥ 60 ms ramp).
const CANCEL_RELEASE_SEC = 0.06;

// Grid rules (S4): routine and outcome cues wait ≤ 250 ms for the band's
// grid; a body-anchored cue keeps the body's time unless a grid point lies
// within ±60 ms of its carrying note; scenery waits ≤ one bar.
const ROUTINE_GRID_WAIT_SEC = 0.25;
const BODY_SNAP_SEC = 0.06;
const GRID_EPS_SEC = 1e-6;

// Flock strikes (SIG-10): after the lead's last note, 70 ms apart, −9 dB.
const FLOCK_GAP_MS = 220;
const FLOCK_SPACING_MS = 70;
const FLOCK_GAIN = 0.355;
const FLOCK_LEAD_MEMORY_SEC = 3;

// Needs-you: the ship's bell on E5, the same by day and night (S1). Its last
// strike rings longest, so the call rings on ≥ 1.6× the limit's ticks.
const SHIP_BELL_SEMI = 7;
const LAST_RING_DMUL = 2;
// A soft mallet: no strike transient, a rounded attack.
const SOFT_MALLET_ATTACK_SEC = 0.004;
// Error: the cracked bell's falling fifth, E4 → A3; its grace flam.
const ERROR_SEMIS = Object.freeze([-5, -12]);
const ERROR_GRACE_SEC = 0.025;
// Answered (Signals only): a hand-damped handbell strike on the tonic A4.
const ANSWERED_SEMI = 0;
// Outcomes: mode-neutral A and E (open fifths), the same by day and night.
const OUTCOME_SEMIS = Object.freeze({ E4: -5, A3: -12, A5: 12, E6: 19, A6: 24 });
// The hour count: the great bell (A2) stands for six, singles on A3.
const GREAT_BELL_SEMI = -24;
const HOUR_STRIKE_SEMI = -12;
// Relit: a rising fourth on glass, E4 → A4, key degrees 5 → 1.
const RELIT_FIGURE = Object.freeze([[5, -1], [1, 0]]);
// The digest's colours: each colour's first and second note (≤ 2 per colour).
const DIGEST_VOICES = Object.freeze({
    red: Object.freeze({ material: 'iron', semis: Object.freeze([-5, -12]), gain: G.iron * 0.8 }),
    amber: Object.freeze({ material: 'handbell', semis: Object.freeze([7, 2]), gain: G.handbell * 0.5, Dmul: 0.5 }),
    gold: Object.freeze({ material: 'glock', semis: Object.freeze([12, 19]), gain: G.glock }),
    // Stone (done): the oak knock of a finished turn.
    stone: Object.freeze({ material: 'oak', semis: Object.freeze([0, -5]), gain: G.oak }),
});

// A cue's chord role for a key degree of the motif's leap.
const DEGREE_ROLE = Object.freeze({ 1: 'root', 3: 'third', 5: 'fifth' });
const ARRIVAL_ROLES = Object.freeze([DEGREE_ROLE[ARRIVAL_LEAP.from], DEGREE_ROLE[ARRIVAL_LEAP.to]]);
const COUNCIL_ROLES = Object.freeze(['root', 'fifth', 'octave', 'third', 'high']);

// The bed context a cue is levelled against when the director names none.
function bedContextFor(cue) {
    if (cue.bed === 'village' || cue.bed === 'music' || cue.bed === 'weather') return cue.bed;
    return cue.preset === 'townBand' ? 'music' : 'village';
}

function monotonicNow() {
    return performance.now();
}

// Audio-clock → monotonic clock. `getOutputTimestamp` pairs the two properly,
// so a note's published time is when it is *heard*, output latency included;
// without it the pairing falls back to this instant in both clocks.
function monotonicTimeForAudioTime(engine, audioTime) {
    const ctx = engine?.context;
    const now = monotonicNow();
    if (!ctx) return now;
    let contextTime = ctx.currentTime;
    let performanceTime = now;
    const stamp = typeof ctx.getOutputTimestamp === 'function' ? ctx.getOutputTimestamp() : null;
    if (stamp
        && Number.isFinite(stamp.contextTime) && stamp.contextTime > 0
        && Number.isFinite(stamp.performanceTime) && stamp.performanceTime > 0) {
        contextTime = stamp.contextTime;
        performanceTime = stamp.performanceTime;
    }
    return performanceTime + (audioTime - contextTime) * 1000;
}

// How long after "now" a note started right now would actually be heard: the
// engine's start lead plus the device's output latency. A body-anchored cue
// subtracts this so the bell is *heard* on the accent, not scheduled on it.
const MAX_OUTPUT_LEAD_MS = 250;
function heardLeadMs(engine) {
    if (!engine?.context) return START_LEAD_MS;
    const latency = monotonicTimeForAudioTime(engine, engine.now()) - monotonicNow();
    if (!Number.isFinite(latency)) return START_LEAD_MS;
    return START_LEAD_MS + Math.max(0, Math.min(MAX_OUTPUT_LEAD_MS, latency));
}

// Offsets moved onto the sixteenth grid (while music plays): each note keeps
// its order and chords stay chords.
function quantizeOffsets(offsetsMs, unitMs) {
    const out = [];
    for (let i = 0; i < offsetsMs.length; i++) {
        if (i === 0) { out.push(0); continue; }
        if (offsetsMs[i] === offsetsMs[i - 1]) { out.push(out[i - 1]); continue; }
        const snapped = Math.round(offsetsMs[i] / unitMs) * unitMs;
        out.push(Math.max(out[i - 1] + unitMs, snapped));
    }
    return out;
}

// Thunder with distance (AMB-6, plan 4.2). Distance d = 1 − intensity. A
// near strike tears (a crackle of short white-noise bursts) and then rolls
// bright; a far one arrives later (the director's lead), duller, longer and
// wetter, with no crack. The strike is one 5–8 s roll that crosses the sky in
// pan, read from a fresh noise-pool grain, and it ducks nothing. Its level is
// monotonic in intensity: the first roll peaks at the strike's amplitude and
// every later roll is smaller.
export const THUNDER = Object.freeze({
    lengthSec: Object.freeze([5, 8]),
    // The crackle sounds for strikes nearer than this distance.
    crackMaxDistance: 0.6,
    // The crackle's first burst, relative to the first roll's peak (low
    // enough that a near strike's limiter GR stays small: its peaks, not
    // its loudness, would otherwise decide how loud it lands).
    crackLevel: 0.3,
    // The last roll's hold ends this long before the strike's end, where
    // the release has fallen 60 dB.
    releaseSec: 1.5,
    // The first roll's fall time at distance 0, as a share of the others'
    // (rising to all of it at distance 1): a call placed just into a near
    // roll hears the clap gone, not a held rumble, in its bed (must-never 8).
    clapFall: 0.25,
    // Voice level of a strike at intensity 1 into the cue sink (a call
    // placed ≈ 1 s into a full roll, lifted no further than its trim cap,
    // must still clear the roll in its bed: must-never 8).
    gain: 0.065,
    airNear: 0.2,
    airPerDistance: 0.3,
});

const clampUnit = value => Math.max(0, Math.min(1, Number.isFinite(Number(value)) ? Number(value) : 1));

// Fresh grains: each strike's read keeps clear of the last this-many
// strikes' reads (with three brown pool buffers of ≈ 22 s, the most that
// still leaves one free for the next roll).
const THUNDER_READ_STRIKES = 2;
// The grain stops this long after its envelope has ended.
const THUNDER_STOP_TAIL_SEC = 0.05;
// Under an urgent call a roll yields as deep as the world bus does, just
// before the call's first note, and comes back after its window.
const THUNDER_YIELD_GAIN = dbToGain(DUCK_DEPTHS.urgent.world);
const THUNDER_YIELD_LEAD_SEC = 0.05;
const THUNDER_YIELD_TAU_SEC = 0.03;
const THUNDER_RETURN_TAU_SEC = 0.25;
// The intensity the registry's `cue.thunder` nominal was measured at.
const THUNDER_REFERENCE_INTENSITY = 0.55;
// Points per second when a roll's recent loudness is estimated from its plan.
const THUNDER_BED_STEPS_PER_SEC = 8;

// A strike's envelope (linear, 1 = its first roll's peak) `tau` s after its
// onset, from its plan: the roll sounding (its peak through its hold, a
// quarter of it after), then the release.
export function thunderEnvelope(plan, tau) {
    if (!(tau >= 0) || tau > plan.lengthSec) return 0;
    let env = 0;
    for (const roll of plan.rolls) {
        if (roll.at > tau) break;
        env = tau <= roll.at + roll.attack + roll.hold ? roll.peak : 0.25 * roll.peak;
    }
    if (tau > plan.releaseAt) env *= Math.exp(-(tau - plan.releaseAt) / plan.releaseTau);
    return env;
}

// A strike's linear amplitude: 0.18 at intensity 0, 1 at intensity 1,
// strictly increasing; steeper in dB below the near boundary than above it,
// so the far strikes spread across their window and the near ones leave a
// call room over them.
export function thunderAmplitude(intensity) {
    return 0.18 + 0.82 * Math.pow(clampUnit(intensity), 1.15);
}

// Island Air send: far strikes are wetter.
export function thunderAir(intensity) {
    return THUNDER.airNear + THUNDER.airPerDistance * (1 - clampUnit(intensity));
}

// One strike's shape, times in seconds from its onset. Pure: every draw
// comes from `rng`, in a fixed order.
export function thunderPlan(intensity, rng) {
    const i = clampUnit(intensity);
    const d = 1 - i;
    const [minLen, maxLen] = THUNDER.lengthSec;
    const lengthSec = Math.min(maxLen, minLen + 2.4 * d + rand(rng, 0, 0.6));
    const rate = rand(rng, 0.95, 1.05);
    const side = rng() < 0.5 ? -1 : 1;
    const panFrom = side * rand(rng, 0.35, 0.6);
    const pan = { from: panFrom, to: -panFrom * rand(rng, 0.6, 0.9) };

    const count = d < 0.5 ? 4 + Math.floor(rng() * 3) : 3 + Math.floor(rng() * 2);
    const rolls = [];
    let at = 0;
    let peak = 1;
    for (let k = 0; k < count; k++) {
        const attack = k === 0 ? (d < 0.3 ? 0.03 : 0.3 + 0.8 * d) : rand(rng, 0.08, 0.3) + 0.3 * d;
        // The first roll's hold is fixed: it carries the strike's level.
        const hold = (k === 0 ? 0.4 : rand(rng, 0.15, 0.5)) + 0.4 * d;
        const fall = rand(rng, 0.35, 0.8) + 0.5 * d;
        // A near strike's first roll is a clap that dies fast; a far one's
        // smears like the rolls after it.
        const fallTau = k === 0 ? fall * (THUNDER.clapFall + (1 - THUNDER.clapFall) * d) : fall;
        rolls.push({ at, attack, peak, hold, fallTau });
        at += attack + hold + rand(rng, 0.4, 1.3) + 0.9 * d;
        peak *= rand(rng, 0.55, 0.85);
    }
    // Squeeze the rolls so the last hold ends `releaseSec` before the end.
    const last = rolls[rolls.length - 1];
    const lastEnd = last.at + last.attack + last.hold;
    const room = lengthSec - THUNDER.releaseSec;
    if (lastEnd > room) {
        const k = room / lastEnd;
        for (const roll of rolls) {
            roll.at *= k;
            roll.attack *= k;
            roll.hold *= k;
        }
    }
    const releaseAt = Math.min(room, lastEnd);

    const crack = [];
    if (d < THUNDER.crackMaxDistance) {
        const first = THUNDER.crackLevel * (1 - d / THUNDER.crackMaxDistance);
        const bursts = 8 + Math.floor(rng() * 7);
        let burstAt = 0;
        for (let k = 0; k < bursts; k++) {
            if (k > 0) burstAt += rand(rng, 0.012, 0.05);
            const level = k === 0 ? first : first * rand(rng, 0.2, 0.7) * Math.pow(0.9, k);
            crack.push({ at: burstAt, level, tau: k === 0 ? 0.03 : rand(rng, 0.004, 0.012) });
        }
    }
    return {
        intensity: i,
        distance: d,
        amplitude: thunderAmplitude(i),
        lengthSec,
        rate,
        pan,
        // The roll's low-pass: bright for a near strike, falling over 0.8 of the roll.
        lp: { fromHz: 2400 * Math.pow(i, 1.5) + 250 * d, toHz: 140 * i + 100 * d, sweepSec: 0.8 * lengthSec },
        rolls,
        releaseAt,
        releaseTau: (lengthSec - releaseAt) / 6.9,
        crack,
        crackEndSec: crack.length ? Math.max(...crack.map(b => b.at + 7 * b.tau)) : 0,
    };
}

export class CueKit {
    constructor(engine, governor) {
        this.engine = engine;
        this.governor = governor;
        this.lastCue = null;
        this.lastLevel = null;
        // Foreground urgent trims ({ at, trimDb }) for a wake with no bed read.
        this._urgentTrims = [];
        // The last sounding urgent call per lane, for its flock (SIG-10).
        this._leads = new Map();
        // Thunder is weather (S6): its plans draw from a stream no agent cue
        // touches. Cue noise grains draw nothing: the pool places them.
        this._thunderRng = rngStream('cue.thunder');
        // The last strikes' pool reads ({ index, offset, span }), so the
        // next strike reads fresh noise.
        this._strikeReads = [];
        // Sounding strikes ({ param, level, start, end }) and urgent call
        // windows ({ from, until }): a roll yields under a call.
        this._thunders = [];
        this._urgentWindows = [];
    }

    // Returns true when the governor accepted the cue. Routine cues sound
    // after the short aggregation window; urgent lanes sound immediately.
    play(kind, options = {}) {
        const cooldownMs = COOLDOWNS_MS[kind];
        const lane = laneForCueKind(kind);
        if (cooldownMs == null || !lane) return false;
        return this.governor.submit({
            ...options,
            kind,
            lane,
            cooldownMs,
            guardMs: URGENT_GUARD_MS[kind],
            budget: !UNBUDGETED.has(kind),
            aggregate: AGGREGATED.has(kind),
        }, (cue, stage) => this._playAccepted(cue, stage));
    }

    // With no active audio context this still emits the cue event for captions
    // and other accessibility consumers; it simply skips synthesis. Either way
    // the cue's real note times reach the shared score, so visual accents land
    // on the note that carries them.
    _playAccepted(cue = {}, {
        prepare = false,
        announceOnly = false,
        delayMs = 0,
    } = {}) {
        const { kind, lane } = cue;
        if (announceOnly) return this._emitCue(cue);
        if (cue.flock) return this._playFlock(cue);

        const offsetsMs = cueNoteOffsetsMs(kind, cue);
        if (!offsetsMs) return false;
        const identity = {
            kind,
            agentId: cue.agentId ?? null,
            teamName: cue.teamName ?? null,
            sourceEventId: cueSourceEventId(cue),
        };
        const canSound = Boolean(this.engine?.context && this.engine?.started);

        if (!canSound) {
            // The muted route uses the same score at the monotonic now, so
            // every accent appears at once instead of waiting for an audio
            // permission that may never arrive.
            const pitches = this._voice(kind, 0, offsetsMs, cue, null);
            publishCueScore({ ...identity, startMs: monotonicNow(), offsetsMs, pitches, silent: true });
            if (prepare) return () => {};
            return this._emitCue(cue);
        }

        const cancels = [];
        let withdrawn = false;
        const schedule = () => {
            if (withdrawn) return;
            const baseDelayMs = Math.max(0, Number(delayMs) || 0);
            const anchoredDelayMs = anchoredCueDelayMs(
                kind,
                cueScoreKey(cue),
                offsetsMs,
                baseDelayMs,
                heardLeadMs(this.engine),
            );
            // `leadMs` lets a director trail its event on the audio clock
            // (thunder after the drawn flash) instead of with a timer.
            const leadMs = Math.max(0, Number(cue.leadMs) || 0);
            const earliest = this.engine.now() + START_LEAD_MS / 1000;
            const planned = earliest + (anchoredDelayMs + leadMs) / 1000;
            const { t, offsetsMs: notes } = this._onGrid(kind, planned, offsetsMs, {
                bodyAnchored: anchoredDelayMs > baseDelayMs,
                earliest,
            });
            const sink = this._openSink(kind, cue, t, cancels);
            const pitches = this._voice(kind, t, notes, cue, sink);
            this._closeSink(sink);
            this._duck(kind, lane, cue, t, notes, cancels);
            if (isUrgentCueLane(lane)) {
                this._leads.set(lane, { t, lastMs: notes[notes.length - 1], kind, trimDb: sink.trimDb });
            }
            publishCueScore({
                ...identity,
                startMs: monotonicTimeForAudioTime(this.engine, t),
                offsetsMs: notes,
                pitches,
                silent: false,
            });
        };

        // Body-led cues (arrival, departure, the release peal) wait out the
        // current (synchronous) event dispatch so the renderer can declare
        // when its accent is really drawn, then ring on it. A microtask, not
        // a timer: only the Transport's timer may lead to a sound (S4).
        if (CUE_ACCENT_NOTE[kind] != null) queueMicrotask(schedule);
        else schedule();

        if (prepare) {
            return () => {
                withdrawn = true;
                for (const cancel of cancels) cancel();
            };
        }
        return this._emitCue(cue);
    }

    // The grid (S4). With no music, or for signal cues and thunder, the cue
    // keeps its time and today's offsets. While music plays a routine or
    // outcome cue moves to the next grid point ≤ 250 ms away and its notes
    // onto sixteenths; a body-anchored one moves only when a grid point lies
    // within ±60 ms of its carrying note; scenery waits for the next bar.
    _onGrid(kind, t, offsetsMs, { bodyAnchored = false, earliest = t } = {}) {
        const stratum = STRATUM_BY_KIND[kind];
        const clock = this.engine?.musicClock;
        const kept = { t, offsetsMs };
        if (!clock?.playing?.(t) || !['routine', 'outcome', 'scenery'].includes(stratum)) return kept;
        const snap = clock.snapshot(t);
        if (!(snap?.beatSec > 0)) return kept;
        if (stratum === 'scenery') {
            return { t: clock.nextGrid(t, { maxWaitSec: snap.beatSec * snap.beatsPerBar }), offsetsMs };
        }
        const unitMs = snap.beatSec * 1000 / 4;
        const notes = quantizeOffsets(offsetsMs, unitMs);
        if (bodyAnchored) {
            const carry = Math.min(CUE_ACCENT_NOTE[kind] ?? 0, offsetsMs.length - 1);
            const carryAt = t + offsetsMs[carry] / 1000;
            const from = carryAt - BODY_SNAP_SEC;
            const grid = clock.nextGrid(from, { maxWaitSec: ROUTINE_GRID_WAIT_SEC });
            const start = grid - notes[carry] / 1000;
            if (grid === from || Math.abs(grid - carryAt) > BODY_SNAP_SEC + GRID_EPS_SEC || start < earliest - GRID_EPS_SEC) return kept;
            return { t: start, offsetsMs: notes };
        }
        return { t: clock.nextGrid(t, { maxWaitSec: ROUTINE_GRID_WAIT_SEC }), offsetsMs: notes };
    }

    // The pitch rules of one cue at audio time `t` (S1, 3.5). With no music
    // every rule answers the phase key's tonic — today's pitches exactly.
    _pitches(cue, t, offsetsMs) {
        const clock = this.engine?.musicClock;
        const idleKey = phaseKey(cue.phase);
        const music = time => Boolean(clock?.playing?.(time));
        const chord = time => (music(time) ? clock.chordAt(time) : tonicTriad(idleKey));
        const key = time => (music(time) ? clock.keyAt(time) : idleKey);
        const at = i => t + (offsetsMs[Math.min(i, offsetsMs.length - 1)] || 0) / 1000;
        const guarded = (semi, time) => (music(time) ? guardSemi(semi, chord(time)) : semi);
        return {
            at,
            // Routine: a chord role at the note's own chord.
            role: (role, i) => noteHz(roleSemi(role, chord(at(i)))),
            // Outcome and scenery: a fixed or key pitch, clash-guarded.
            fixed: (semi, i) => noteHz(guarded(semi, at(i))),
            degree: (degree, octave, i) => noteHz(guarded(degreeSemi(degree, key(at(i)), octave), at(i))),
            // Signal: never moved. A colour voice under a carrier (the horn's
            // fifth) drops out instead of clashing.
            signal: semi => noteHz(semi),
            colourClashes: (semi, time) => music(time) && guardSemi(semi, chord(time)) !== semi,
        };
    }

    // One voice per cue kind, struck at the score's note offsets. With no
    // sink it strikes nothing and only answers the pitches (the muted score).
    // Returns each note's struck pitch (Hz, an array for a chord).
    _voice(kind, t, offsetsMs, cue = {}, sink) {
        const P = this._pitches(cue, t, offsetsMs);
        const { at } = P;
        const phase = cue.phase ?? 'day';
        const pitches = new Array(offsetsMs.length).fill(null);
        const note = (i, hz) => {
            const prev = pitches[i];
            pitches[i] = prev == null ? hz : [...(Array.isArray(prev) ? prev : [prev]), hz];
            return hz;
        };
        const strike = (i, hz, recipe, opts, when = at(i)) => this._strike(sink, when, note(i, hz), recipe, opts);

        switch (kind) {
            case 'arrival': {
                const chime = chimeForProvider(cue.provider, phase);
                strike(0, P.role(ARRIVAL_ROLES[0], 0), chime, { gain: G.chime });
                strike(1, P.role(ARRIVAL_ROLES[1], 1), chime, { gain: G.chime * 0.95, Dmul: 1.2 });
                break;
            }
            case 'departure': {
                const chime = chimeForProvider(cue.provider, phase);
                strike(0, P.role('fifth', 0), chime, { gain: G.chime * 0.9, lp: 2200 });
                strike(1, P.role('root', 1), chime, { gain: G.chime * 0.95, lp: 1800, Dmul: 1.3 });
                break;
            }
            case 'recovery': {
                const healed = material('healed', phase);
                strike(0, P.role('third', 0), healed, { gain: G.healed });
                strike(1, P.role('octave', 1), healed, { gain: G.healed * 0.8, Dmul: 1.2 });
                break;
            }
            case 'council': {
                const chime = chimeForProvider(cue.provider, phase);
                const count = offsetsMs.length;
                for (let i = 0; i < count; i++) {
                    strike(i, P.role(COUNCIL_ROLES[i], i), chime, {
                        gain: G.chime * (1 - i * 0.05),
                        Dmul: i === count - 1 ? 1.8 : 1.3,
                    });
                }
                break;
            }
            case 'aurora': {
                const glass = material('glass', phase);
                const last = AURORA_FIGURE.notes.length - 1;
                AURORA_FIGURE.notes.forEach(({ degree, octave }, i) => {
                    strike(i, P.degree(degree, octave, i), glass, { gain: G.glass, Dmul: i === last ? 1.2 : 1 });
                });
                break;
            }
            case 'hourBell':
                this._hourBell(cue, P, strike, offsetsMs);
                break;
            case 'summons':
                this._shipBell(sink, P, strike, note, cue.level);
                break;
            case 'distress':
                this._crackedBell(sink, P, strike, 1);
                break;
            case 'limit':
                this._escapement(sink, P, note, 1);
                break;
            case 'reminder': {
                const voice = reminderVoice(cue);
                if (voice.kind === 'summons') this._shipBell(sink, P, strike, note, voice.level);
                else if (voice.kind === 'distress') this._crackedBell(sink, P, strike, voice.level);
                else this._escapement(sink, P, note, voice.level);
                break;
            }
            // Rung on the call's trim and voice level, as loud as an L2 pair.
            case 'answered':
                strike(0, P.signal(ANSWERED_SEMI), material('handbell'), { gain: G.handbell * 1.1, Dmul: 0.3 });
                break;
            case 'turnDone':
                strike(0, P.fixed(OUTCOME_SEMIS.E4, 0), material('oak'), { gain: G.oak });
                break;
            case 'subagentReturn':
                this._stone(sink, at(0), G.stone);
                this._stone(sink, at(1), G.stone * 0.45);
                break;
            case 'toolFailed':
            case 'pushFailed': {
                const iron = material('iron');
                strike(0, P.fixed(OUTCOME_SEMIS.E4, 0), iron, { gain: G.iron });
                strike(1, P.fixed(OUTCOME_SEMIS.A3, 1), iron, { gain: G.iron * 1.1, Dmul: 1.3 });
                break;
            }
            // A commit is the small gold: one soft-mallet bar left to ring;
            // a push strikes two hard ones.
            case 'commit':
                strike(0, P.fixed(OUTCOME_SEMIS.A5, 0), material('glock'), { gain: G.glock * 0.9, Dmul: 1.7, lp: 2000, soft: true });
                break;
            case 'push': {
                const glock = material('glock');
                strike(0, P.fixed(OUTCOME_SEMIS.A5, 0), glock, { gain: G.glock });
                strike(1, P.fixed(OUTCOME_SEMIS.E6, 1), glock, { gain: G.glock * 0.9, Dmul: 1.3 });
                break;
            }
            case 'release': {
                // The civic bell (day recipe always) under a gold peal of
                // open fifths, landing its chord on the crown.
                const tower = material('tower', 'day');
                const glock = material('glock');
                strike(0, P.fixed(OUTCOME_SEMIS.A3, 0), tower, { gain: G.tower * 0.8, Dmul: 0.9 });
                strike(1, P.fixed(OUTCOME_SEMIS.A5, 1), glock, { gain: G.glock });
                strike(2, P.fixed(OUTCOME_SEMIS.E6, 2), glock, { gain: G.glock });
                strike(3, P.fixed(OUTCOME_SEMIS.A6, 3), glock, { gain: G.glock });
                strike(4, P.fixed(OUTCOME_SEMIS.E4, 4), tower, { gain: G.tower * 0.7, Dmul: 0.9 });
                strike(4, P.fixed(OUTCOME_SEMIS.A6, 4), glock, { gain: G.glock * 0.8, Dmul: 1.5 });
                strike(4, P.fixed(OUTCOME_SEMIS.E6, 4), glock, { gain: G.glock * 0.7, Dmul: 1.5 });
                break;
            }
            case 'dispatch':
                this._sweep(sink, at(0), WHOOSH, G.whoosh, { peakAt: WHOOSH.peakAt });
                break;
            case 'linkLost':
                // The lantern goes out: a muted wooden knock and a falling breath.
                strike(0, P.fixed(OUTCOME_SEMIS.A3, 0), material('oak'), { gain: G.oak * 0.8, lp: 1200 });
                this._sweep(sink, at(0), LANTERN_OUT, G.lantern, { peakAt: 0.02 });
                break;
            case 'linkRestored': {
                const glass = material('glass', phase);
                RELIT_FIGURE.forEach(([degree, octave], i) => {
                    strike(i, P.degree(degree, octave, i), glass, { gain: G.glass * 1.2, Dmul: i ? 0.6 : 0.4 });
                });
                break;
            }
            case 'digest':
                this._digest(P, strike, cue.notes, offsetsMs.length);
                break;
            case 'thunder':
                if (sink) this._thunder(sink, at(0), cue.intensity ?? 1);
                break;
        }
        return pitches;
    }

    // Needs-you: the ship's bell — a quick double strike on E5 (second ×0.85),
    // the pair repeated every 650 ms, every strike ringing on; L2 one pair
    // ×0.6, L1 two pairs, L3 three, L4 three with the watchtower horn under.
    _shipBell(sink, P, strike, note, level) {
        const L = ladderLevel(level);
        const pairs = shipBellPairs(L);
        const handbell = material('handbell');
        const gain = G.handbell * 0.85 * (L === 2 ? 0.6 : 1);
        const hz = P.signal(SHIP_BELL_SEMI);
        for (let k = 0; k < pairs; k++) {
            strike(2 * k, hz, handbell, { gain, Dmul: 1 });
            strike(2 * k + 1, hz, handbell, { gain: gain * 0.85, Dmul: k === pairs - 1 ? LAST_RING_DMUL : 1 });
        }
        if (L >= 4) {
            for (const hz of this._horn(sink, P, P.at(0))) note(0, hz);
        }
    }

    // Error: the cracked bell — a flam onto E4, then the heavy fall to A3.
    // An errors reminder: L2 once at ×0.6, L3 twice, 1.2 s apart.
    _crackedBell(sink, P, strike, level) {
        const L = ladderLevel(level);
        const cracked = material('cracked');
        const scale = L === 2 ? 0.6 : 1;
        const figures = L >= 3 ? 2 : 1;
        const [high, low] = ERROR_SEMIS.map(semi => P.signal(semi));
        for (let k = 0; k < figures; k++) {
            const first = 2 * k;
            this._strike(sink, P.at(first) - ERROR_GRACE_SEC, high, cracked, { gain: G.cracked * 0.3 * scale, Dmul: 0.4 });
            strike(first, high, cracked, { gain: G.cracked * 0.9 * scale });
            strike(first + 1, low, cracked, { gain: G.cracked * 1.1 * scale, Dmul: 1.1 });
        }
    }

    // Rate limit: three escapement ticks slowing down (a quota reminder: −3 dB).
    _escapement(sink, P, note, level) {
        const scale = ladderLevel(level) === 2 ? 0.708 : 1;
        ESCAPEMENT.levels.forEach((g, i) => {
            note(i, P.signal(ESCAPEMENT.bodySemi));
            this._tick(sink, P.at(i), G.tick * g * scale);
        });
    }

    // The hour (D7, D9): the cell's answer on the tower bell; with *Count the
    // hours*, the great A2 bell stands for six, single A3 strikes count the
    // rest, each ≥ 1 s apart. Soft (21:00) and night: the phrase alone, ×0.6.
    _hourBell(cue, P, strike, offsetsMs) {
        const phase = cue.phase ?? 'day';
        const tower = material('tower', phase);
        const soft = cue.soft || phase === 'night' ? 0.6 : 1;
        const phrase = HOUR_FIGURE.notes;
        phrase.forEach(({ degree, octave }, i) => {
            const last = i === phrase.length - 1;
            strike(i, P.degree(degree, octave, i), tower, {
                gain: G.tower * soft * (last ? 1.1 : 0.9),
                Dmul: last ? 1.2 : 0.8,
            });
        });
        if (!hourCounts(cue)) return;
        let i = phrase.length;
        if (hourCount(cue.hour) >= 6) {
            strike(i, P.fixed(GREAT_BELL_SEMI, i), tower, { gain: G.tower * 0.825, Dmul: 1.0 });
            i++;
        }
        for (; i < offsetsMs.length; i++) {
            strike(i, P.fixed(HOUR_STRIKE_SEMI, i), tower, { gain: G.tower * 0.75, Dmul: 0.7 });
        }
    }

    // The return digest (SIG-15): one note per colour in the order given,
    // ≤ 5; a colour's second note moves (never a quick same-pitch pair).
    _digest(P, strike, colours = [], count) {
        const seen = new Map();
        for (let i = 0; i < count; i++) {
            const voice = DIGEST_VOICES[colours[i]] ?? DIGEST_VOICES.stone;
            const n = seen.get(voice) ?? 0;
            seen.set(voice, n + 1);
            const semi = voice.semis[Math.min(n, voice.semis.length - 1)];
            strike(i, P.fixed(semi, i), material(voice.material), { gain: voice.gain, Dmul: voice.Dmul ?? 1 });
        }
    }

    // A follower of an urgent call (SIG-10): its caption, its score, and one
    // soft strike of its family's voice after the lead's last note, placed at
    // its own agent and levelled with the lead.
    _playFlock(cue) {
        const { kind, lane } = cue;
        const index = Math.max(1, Math.trunc(Number(cue.clusterIndex) || 1));
        const identity = { kind, agentId: cue.agentId ?? null, teamName: null, sourceEventId: cueSourceEventId(cue) };
        const canSound = Boolean(this.engine?.context && this.engine?.started);
        if (!canSound) {
            publishCueScore({ ...identity, startMs: monotonicNow(), offsetsMs: [0], silent: true });
            return this._emitCue(cue);
        }
        const now = this.engine.now();
        const earliest = now + START_LEAD_MS / 1000;
        const lead = this._leads.get(lane);
        const fresh = lead && now - lead.t < FLOCK_LEAD_MEMORY_SEC;
        const planned = fresh
            ? lead.t + (lead.lastMs + FLOCK_GAP_MS + (index - 1) * FLOCK_SPACING_MS) / 1000
            : earliest;
        const t = Math.max(earliest, planned);
        const sink = this._openSink(kind, cue, t, [], fresh ? { trimDb: lead.trimDb } : {});
        const P = this._pitches(cue, t, [0]);
        let hz = null;
        if (kind === 'summons') {
            hz = this._strike(sink, t, P.signal(SHIP_BELL_SEMI), material('handbell'), { gain: G.handbell * 0.85 * FLOCK_GAIN, Dmul: 0.5 });
        } else if (kind === 'distress') {
            const semi = ERROR_SEMIS[(index - 1) % ERROR_SEMIS.length];
            hz = this._strike(sink, t, P.signal(semi), material('cracked'), { gain: G.cracked * 0.9 * FLOCK_GAIN, Dmul: 0.5 });
        } else {
            hz = P.signal(ESCAPEMENT.bodySemi);
            this._tick(sink, t, G.tick * FLOCK_GAIN);
        }
        this._closeSink(sink);
        this._duck(kind, lane, cue, t, [0], []);
        publishCueScore({
            ...identity,
            startMs: monotonicTimeForAudioTime(this.engine, t),
            offsetsMs: [0],
            pitches: [hz],
            silent: false,
        });
        return this._emitCue(cue);
    }

    // One trim gain per cue into the cue bus, so overlapping cues each keep
    // their own bed-aware level, placed once (S5). The distance gain acts on
    // the direct path: the send is divided back out, so the air keeps the
    // cue's level and a far cue is quieter and relatively wetter (AMB-2). The
    // sink collects the cue's cancels and counts its live sources; the chain
    // is disposed when the last one has ended.
    _openSink(kind, cue, t, cancels, { trimDb = this._levelDb(kind, cue) } = {}) {
        const placement = cuePlacement(kind, cue);
        const out = this.engine.context.createGain();
        const voiceDb = (VOICE_LEVEL_DB[voiceKind(kind, cue)] ?? 0) + presetVoiceDb(kind, cue);
        out.gain.value = CUE_STAGE_GAIN * dbToGain(trimDb + voiceDb) * placement.gain;
        const voice = this.engine.connectVoice(out, {
            bus: 'cue',
            pan: placement.pan,
            air: placement.air / placement.gain,
            lowpassHz: placement.lowpassHz,
        });
        this.lastLevel = { kind, trimDb, at: t };
        return { out, voice, cancels, trimDb, live: 0, closed: false };
    }

    _closeSink(sink) {
        sink.closed = true;
        if (sink.live === 0) this._disposeSink(sink);
    }

    _disposeSink(sink) {
        try { sink.out.disconnect(); } catch { /* gone */ }
        sink.voice?.dispose?.();
    }

    // Every source of a strike is counted on its sink; the strike's nodes are
    // released when its last source ends, the sink after its last strike.
    // A strike still ahead of the audio clock can be cancelled with a ramp.
    _track(sink, t, voiceGain, sources, nodes) {
        let pending = sources.length;
        sink.live += pending;
        const ended = () => {
            pending--;
            sink.live--;
            if (pending === 0) {
                for (const node of nodes) {
                    try { node.disconnect(); } catch { /* gone */ }
                }
            }
            if (sink.closed && sink.live === 0) this._disposeSink(sink);
        };
        for (const source of sources) source.onended = ended;
        let cancelled = false;
        sink.cancels.push(() => {
            if (cancelled) return;
            cancelled = true;
            const now = this.engine.now();
            if (t <= now) return;
            this.engine.releaseVoice({ sources, env: voiceGain, at: now, sec: CANCEL_RELEASE_SEC });
        });
    }

    // A strike's own level gain → [voice low-pass] → the sink.
    _voiceGain(sink, gain, lp = 0) {
        const ctx = this.engine.context;
        const voice = ctx.createGain();
        voice.gain.value = gain;
        const nodes = [voice];
        if (lp > 0) {
            const filter = makeFilter(ctx, 'lowpass', lp, { q: 'gentle' });
            voice.connect(filter).connect(sink.out);
            nodes.push(filter);
        } else {
            voice.connect(sink.out);
        }
        return { voice, nodes };
    }

    // One modal strike of `recipe` at `hz` (plan 3.1): every partial its own
    // sine (two for a doublet) with a linear attack and its own T60, the
    // noise transient and thud on the attack. `gain` is the prime's peak; a
    // `soft` mallet leaves out the transient and rounds the attack.
    // Returns `hz`; with no sink (the muted score) it strikes nothing.
    _strike(sink, t, hz, recipe, { gain, Dmul = 1, lp = recipe.lp, soft = false } = {}) {
        if (!sink) return hz;
        const ctx = this.engine.context;
        const plan = strikePlan(recipe, hz, { Dmul, sampleRate: ctx.sampleRate });
        if (soft) {
            plan.transient = null;
            plan.attack = Math.max(plan.attack, SOFT_MALLET_ATTACK_SEC);
        }
        const { voice, nodes } = this._voiceGain(sink, gain, lp);
        const sources = [];
        for (const partial of plan.partials) {
            const env = ctx.createGain();
            env.gain.setValueAtTime(0, t);
            env.gain.linearRampToValueAtTime(partial.gain / partial.freqs.length, t + plan.attack);
            env.gain.setTargetAtTime(0, t + plan.attack, partial.t60 / 6.91);
            env.connect(voice);
            nodes.push(env);
            const stopAt = t + plan.attack + 1.1 * partial.t60 + 0.05;
            for (const freq of partial.freqs) {
                const osc = ctx.createOscillator();
                osc.frequency.value = freq;
                osc.connect(env);
                osc.start(t);
                osc.stop(stopAt);
                sources.push(osc);
                nodes.push(osc);
            }
        }
        const bursts = [];
        if (plan.transient) bursts.push({ ...plan.transient, type: 'bandpass' });
        if (plan.thud) bursts.push({ hz: plan.thud.lp, q: 0.7, dur: plan.thud.dur, gain: plan.thud.gain, type: 'lowpass' });
        this._noiseBursts(t, voice, bursts, sources, nodes);
        this._track(sink, t, voice, sources, nodes);
        return hz;
    }

    // Filtered noise bursts at `t`, all from one pool grain read for the
    // longest of them (placed at its real start for its real length:
    // NoisePool.reserveOneShot), so a strike takes one read of the pool.
    // Each: 0 → gain in 0.5 ms, then a fall with τ = dur / 3.
    _noiseBursts(t, into, bursts, sources, nodes) {
        if (!bursts.length) return;
        const stop = t + Math.max(...bursts.map(b => b.dur)) * 6 + 0.02;
        const src = this._noiseGrain(t, stop);
        if (!src) return;
        const ctx = this.engine.context;
        for (const { hz, q, dur, gain, type } of bursts) {
            const filter = makeFilter(ctx, type, hz, { q });
            const env = ctx.createGain();
            env.gain.setValueAtTime(0, t);
            env.gain.linearRampToValueAtTime(gain, t + 0.0005);
            env.gain.setTargetAtTime(0, t + 0.0005, dur / 3);
            src.connect(filter).connect(env).connect(into);
            nodes.push(filter, env);
        }
        src.start(t);
        src.stop(stop);
        sources.push(src);
        nodes.push(src);
    }

    // A white-noise grain read from `t` until `stop`, placed by the pool
    // ≥ 5 s from every live lane for its whole read; null without a pool.
    _noiseGrain(t, stop) {
        const ctx = this.engine.context;
        return this.engine.noisePool?.reserveOneShot(ctx, 'white', stop - t, { at: t }) ?? null;
    }

    // A short sine mode: 1 ms attack, fall to silence with T60.
    _mode(t, into, hz, gain, t60, sources, nodes) {
        const ctx = this.engine.context;
        const osc = ctx.createOscillator();
        osc.frequency.value = hz;
        const env = ctx.createGain();
        env.gain.setValueAtTime(0, t);
        env.gain.linearRampToValueAtTime(gain, t + 0.001);
        env.gain.setTargetAtTime(0, t + 0.001, t60 / 6.91);
        osc.connect(env).connect(into);
        osc.start(t);
        osc.stop(t + 0.001 + 1.1 * t60 + 0.02);
        sources.push(osc);
        nodes.push(osc, env);
    }

    // Escapement tick: a steel click and a 25 ms wooden A5 body. No bell partials.
    _tick(sink, t, gain) {
        if (!sink) return;
        const { voice, nodes } = this._voiceGain(sink, gain);
        const sources = [];
        this._noiseBursts(t, voice, [{ ...ESCAPEMENT.click, type: 'bandpass' }], sources, nodes);
        this._mode(t, voice, noteHz(ESCAPEMENT.bodySemi), ESCAPEMENT.bodyGain, ESCAPEMENT.bodyT60, sources, nodes);
        this._track(sink, t, voice, sources, nodes);
    }

    // Stone: a pebble dropped on stone — a click and two short stone modes.
    _stone(sink, t, gain) {
        if (!sink) return;
        const { voice, nodes } = this._voiceGain(sink, gain);
        const sources = [];
        this._noiseBursts(t, voice, [{ ...STONE.click, type: 'bandpass' }], sources, nodes);
        for (const [hz, g] of STONE.modes) this._mode(t, voice, hz, g, STONE.t60, sources, nodes);
        this._track(sink, t, voice, sources, nodes);
    }

    // The watchtower horn (L4), only under a call: A2 + E3 saws, low-passed,
    // a 1.4 s swell from the first note. Its fifth drops out rather than
    // clash with the band's chord. Returns the pitches it sounds.
    _horn(sink, P, t) {
        const voices = HORN.voices.filter(([semi]) => !P.colourClashes(semi, t));
        const pitches = [...new Set(voices.map(([semi]) => P.signal(semi)))];
        if (!sink) return pitches;
        const ctx = this.engine.context;
        const { voice, nodes } = this._voiceGain(sink, G.horn, HORN.lp);
        const sources = [];
        for (const [semi, g, detune] of voices) {
            const osc = ctx.createOscillator();
            osc.type = 'sawtooth';
            osc.frequency.value = noteHz(semi) * detune;
            const env = ctx.createGain();
            env.gain.setValueAtTime(0, t);
            env.gain.linearRampToValueAtTime(g, t + HORN.rise);
            env.gain.setValueAtTime(g, t + HORN.hold);
            env.gain.linearRampToValueAtTime(0, t + HORN.end);
            osc.connect(env).connect(voice);
            osc.start(t);
            osc.stop(t + HORN.end + 0.05);
            sources.push(osc);
            nodes.push(osc, env);
        }
        this._track(sink, t, voice, sources, nodes);
        return pitches;
    }

    // Filtered noise swept from `fromHz` to `toHz` over `sec`, rising to its
    // peak at `peakAt` and falling linearly to silence at the sweep's end:
    // the dispatch whoosh, the lantern going out.
    _sweep(sink, t, { fromHz, toHz, q, sec }, gain, { peakAt }) {
        if (!sink) return;
        const end = t + Math.max(sec, peakAt + 0.06);
        const src = this._noiseGrain(t, end + 0.02);
        if (!src) return;
        const ctx = this.engine.context;
        const { voice, nodes } = this._voiceGain(sink, gain);
        const filter = makeFilter(ctx, 'bandpass', fromHz, { q });
        filter.frequency.setValueAtTime(fromHz, t);
        filter.frequency.exponentialRampToValueAtTime(toHz, t + sec);
        const env = ctx.createGain();
        env.gain.setValueAtTime(0, t);
        env.gain.linearRampToValueAtTime(1, t + peakAt);
        env.gain.linearRampToValueAtTime(0, end);
        src.connect(filter).connect(env).connect(voice);
        src.start(t);
        src.stop(end + 0.02);
        nodes.push(src, filter, env);
        this._track(sink, t, voice, [src], nodes);
    }

    // One read of the pre-duck bed at schedule time (S3). Urgent trims taken
    // over a known bed are remembered for a wake that has none to read. The
    // ladder takes its trim once, at entry, and holds it (`heldTrimDb`).
    _levelDb(kind, cue) {
        if (kind === 'reminder' && Number.isFinite(cue.heldTrimDb)) return cue.heldTrimDb;
        const lane = levelLane(kind, cue);
        const voice = VOICE_REGISTRY[`cue.${voiceKind(kind, cue)}`];
        const urgent = isUrgentLevelLane(lane);
        let bedLufs = this.engine.bedLoudness();
        // A roll sounding now is part of what an urgent call must clear:
        // the bed tap never hears the cue bus it rides.
        if (urgent && Number.isFinite(bedLufs)) bedLufs = this._withThunder(bedLufs);
        const now = monotonicNow();
        if (urgent) this._urgentTrims = this._urgentTrims.filter(entry => now - entry.at < URGENT_TRIM_MEMORY_MS);
        const trimDb = cueTrimDb({
            lane,
            nominalLufsM: voice?.nominalLufsM,
            plr: voice?.plr,
            bedLufs,
            recentUrgentTrims: this._urgentTrims.map(entry => entry.trimDb),
            bed: bedContextFor(cue),
        });
        if (urgent && Number.isFinite(bedLufs)) this._urgentTrims.push({ at: now, trimDb });
        return trimDb;
    }

    // The bed yields from the first note to the last note + its hold. A cue
    // withdrawn before its first note sounds withdraws its duck with it, so
    // the bed never dips for a cue that did not play.
    _duck(kind, lane, cue, t, offsetsMs, cancels) {
        const depths = duckDepthsFor(kind, lane, cue);
        if (!ducksAnything(depths)) return;
        const light = depths !== DUCK_DEPTHS.urgent;
        const from = t + (offsetsMs[0] || 0) / 1000;
        const hold = light ? LIGHT_DUCK_HOLD_SEC : DUCK_HOLD_AFTER_LAST_NOTE_SEC;
        const until = t + (offsetsMs[offsetsMs.length - 1] || 0) / 1000 + hold;
        const token = this.engine.duck(light
            ? { from, until, depths, release: LIGHT_DUCK_RELEASE_SEC }
            : { from, until, depths });
        cancels.push(() => {
            if (this.engine.now() < from) token?.cancel?.();
        });
        if (!light) this._urgentWindow(from, until, cancels);
    }

    // `bedLufs` (the bed tap's ~3 s mean) with the sounding strikes' mean
    // power over the same window, estimated from their plans and levels.
    _withThunder(bedLufs) {
        const now = this.engine.now();
        const windowSec = AUDIBILITY_WINDOWS.bedWindowSec;
        const steps = Math.max(1, Math.round(windowSec * THUNDER_BED_STEPS_PER_SEC));
        let power = 0;
        for (const strike of this._thunders) {
            if (!Number.isFinite(strike.lufs) || strike.start > now || strike.end < now - windowSec) continue;
            let sum = 0;
            for (let k = 0; k < steps; k++) {
                const env = thunderEnvelope(strike.plan, now - windowSec * (k + 0.5) / steps - strike.start);
                sum += env * env;
            }
            power += Math.pow(10, strike.lufs / 10) * sum / steps;
        }
        return power > 0 ? 10 * Math.log10(Math.pow(10, bedLufs / 10) + power) : bedLufs;
    }

    // An urgent call's window (AMB-9: weather never hides a signal). Thunder
    // ducks nothing, but a roll sounding under a call yields as the world
    // bus does (DUCK_DEPTHS.urgent.world) and returns after it; a strike
    // that starts inside a window yields on its own start (_thunder).
    _urgentWindow(from, until, cancels) {
        const now = this.engine.now();
        this._urgentWindows = this._urgentWindows.filter(w => w.until > now);
        const window = { from, until };
        this._urgentWindows.push(window);
        this._thunders = this._thunders.filter(x => x.end > now);
        const undo = this._thunders.map(strike => this._yieldThunder(strike, from, until)).filter(Boolean);
        cancels.push(() => {
            if (this.engine.now() >= from) return;
            this._urgentWindows = this._urgentWindows.filter(w => w !== window);
            for (const fn of undo) fn();
        });
    }

    // Returns an undo for a yield still ahead of the audio clock.
    _yieldThunder(strike, from, until) {
        if (strike.end <= from || strike.start >= until) return null;
        const down = Math.max(this.engine.now(), from - THUNDER_YIELD_LEAD_SEC);
        strike.param.setTargetAtTime(strike.level * THUNDER_YIELD_GAIN, down, THUNDER_YIELD_TAU_SEC);
        strike.param.setTargetAtTime(strike.level, until, THUNDER_RETURN_TAU_SEC);
        return () => {
            if (this.engine.now() < down) strike.param.cancelScheduledValues(down);
        };
    }

    // A ceremony that absorbed an announced aggregate names it in `replaces`
    // (its caption identity plus the count it keeps), so the caption surface
    // swaps the aggregate's caption for the ceremony instead of stacking both.
    // The digest is sound-only: its caption is the digest toast.
    _emitCue(cue = {}) {
        const { kind, eventKind = kind, lane, agentId = null, label = null, replaces = null } = cue;
        const at = Date.now();
        this.lastCue = { kind: eventKind, lane, at };
        const payload = {
            kind: eventKind,
            agentId: agentId ?? null,
            label: String(label || CUE_LABELS[kind] || kind),
            at,
        };
        for (const field of CAPTION_FIELDS) {
            if (cue[field] !== undefined) payload[field] = cue[field];
        }
        if (kind === 'digest') payload.soundOnly = true;
        if (replaces) payload.replaces = replaces;
        eventBus.emit('audio:cue-played', payload);
        return true;
    }

    // Thunder (thunderPlan): the roll is a one-shot brown-noise grain through
    // a low shelf and a falling low-pass, its rolls drawn on one envelope;
    // the near crackle is the same grain above 1.2 kHz (the pool's brown
    // reaches 2.5 kHz), so a strike reads one span of the pool. Both cross
    // the sky on one panner. The grain is a one-shot lane the pool places
    // (NoisePool.reserveOneShot) ≥ 5 s from every live lane for its whole
    // read and from the last strikes' reads, so no two strikes share a
    // texture. The white pool buffer is left to the continuous lanes and
    // short cue bursts: one live white lane already fences off half of it.
    _thunder(sink, t, intensity = 1) {
        const ctx = this.engine.context;
        const plan = thunderPlan(intensity, this._thunderRng);
        const rollSec = plan.lengthSec + THUNDER_STOP_TAIL_SEC;
        const roll = this.engine.noisePool?.reserveOneShot(ctx, 'brown', rollSec, { rate: plan.rate, at: t, avoid: this._strikeReads });
        if (!roll) return;
        this._strikeReads.push(roll.read);
        if (this._strikeReads.length > THUNDER_READ_STRIKES) this._strikeReads.shift();
        const end = t + plan.lengthSec;
        const level = THUNDER.gain * plan.amplitude;
        const { voice, nodes } = this._voiceGain(sink, level);
        const reference = VOICE_REGISTRY['cue.thunder']?.nominalLufsM;
        const lufs = Number.isFinite(reference)
            ? reference + sink.trimDb + 20 * Math.log10(plan.amplitude / thunderAmplitude(THUNDER_REFERENCE_INTENSITY))
            : null;
        const strike = { param: voice.gain, level, start: t, end, plan, lufs };
        const now = this.engine.now();
        this._thunders = this._thunders.filter(x => x.end > now);
        this._thunders.push(strike);
        for (const w of this._urgentWindows) if (w.until > now) this._yieldThunder(strike, w.from, w.until);

        const panner = ctx.createStereoPanner();
        panner.pan.setValueAtTime(plan.pan.from, t);
        panner.pan.linearRampToValueAtTime(plan.pan.to, end);
        panner.connect(voice);
        nodes.push(panner);

        const hp = makeFilter(ctx, 'highpass', 35, { q: 'butterworth' });
        const shelf = makeFilter(ctx, 'lowshelf', 120, { gain: 6 });
        const lp = makeFilter(ctx, 'lowpass', plan.lp.fromHz, { q: 'butterworth' });
        lp.frequency.setValueAtTime(plan.lp.fromHz, t);
        lp.frequency.exponentialRampToValueAtTime(plan.lp.toHz, t + plan.lp.sweepSec);
        const env = ctx.createGain();
        env.gain.value = 0;
        env.gain.setValueAtTime(0, t);
        for (const r of plan.rolls) {
            env.gain.setTargetAtTime(r.peak, t + r.at, r.attack / 2.5);
            env.gain.setTargetAtTime(0.25 * r.peak, t + r.at + r.attack + r.hold, r.fallTau);
        }
        env.gain.setTargetAtTime(0, t + plan.releaseAt, plan.releaseTau);
        roll.connect(hp).connect(shelf).connect(lp).connect(env).connect(panner);
        roll.start(t);
        roll.stop(t + rollSec);
        nodes.push(roll, hp, shelf, lp, env);

        if (plan.crack.length) {
            const crackHp = makeFilter(ctx, 'highpass', 1200, { q: 'butterworth' });
            const crackLp = makeFilter(ctx, 'lowpass', 7000, { q: 'butterworth' });
            const crackEnv = ctx.createGain();
            crackEnv.gain.value = 0;
            crackEnv.gain.setValueAtTime(0, t);
            for (const b of plan.crack) {
                crackEnv.gain.setTargetAtTime(b.level, t + b.at, 0.0015);
                crackEnv.gain.setTargetAtTime(0, t + b.at + 0.003, b.tau);
            }
            roll.connect(crackHp).connect(crackLp).connect(crackEnv).connect(panner);
            nodes.push(crackHp, crackLp, crackEnv);
        }
        this._track(sink, t, voice, [roll], nodes);
    }
}
