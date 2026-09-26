// The loudness contract (plan S2, C-MIX-7): one table read by the engine's
// meters and by the audio probe, so a level claim is always measured against
// the same numbers. Pure data; importable from Node as well as the browser.
//
// Units: LUFS / LU are ITU-R BS.1770-4 (K-weighted, gated for -I); every
// target is measured at the engine output at the default slider unless a
// field says otherwise. "A" is the Anchor A scene below.

// Gain (dB) on the program sum that makes Anchor A true on the current bed.
// Applied twice in the master (S3): on the bed sum and on the cue sum, so a
// cue keeps the level relation it was measured with. Re-measured and the
// probe re-baselined at the end of Waves 1, 4 and 6.
// Wave 1 (tonal bed retired, wind-led world stratum; the sea lands in 4.1):
// the virtual-clock anchor scene (scripts/audio/lib/scenes.mjs `anchor`:
// seed 0x5eed, July day progress 0.5, clear, 4 working + 1 idle, hum and
// music trims at step 0, standard volume step 6, worklet limiter; LUFS-I
// over the 60 s after a 10 s warmup, `node scripts/audio/probe.mjs --only
// scenes`) read −38.17 LUFS-I at 28 dB (−66.04 at 0 dB), sample peak
// −25.5 dBFS, no limiter gain reduction; 28.2 dB makes it −37.97.
export const PROGRAM_TRIM_DB = 28.2;

// Slider law (UX-8, S2 "Slider semantics"): steps 0-10, 0 = off.
// Master volume: 3.6 dB per step, step 10 = unity, the last gain before the
// fade (after the limiter), so a step changes level only.
export const VOLUME_STEP_DB = 3.6;
export const STANDARD_VOLUME_STEP = 6;
// Mixer trims (group faders): 2.4 dB per step, step 10 = unity.
export const TRIM_STEP_DB = 2.4;

function stepGain(step, dbPerStep) {
    const s = Math.max(0, Math.min(10, Math.round(Number(step))));
    if (!Number.isFinite(s) || s === 0) return 0;
    return Math.pow(10, (s - 10) * dbPerStep / 20);
}

export function volumeStepGain(step) {
    return stepGain(step, VOLUME_STEP_DB);
}

export function trimStepGain(step) {
    return stepGain(step, TRIM_STEP_DB);
}

// Note-timed duck depths per cue class (S3), dB per bus; 0 = no duck on that
// bus. `village` covers routine, outcome and scenery cues in Village,
// `townBand` the same classes over the Town band. The engine floors every
// window at DUCK_FLOOR_DB (−9, DuckScheduler.js).
export const DUCK_DEPTHS = Object.freeze({
    village: Object.freeze({ world: -2, work: -3, music: 0 }),
    townBand: Object.freeze({ world: 0, work: 0, music: -2 }),
    urgent: Object.freeze({ world: -7, work: -6, music: -9 }),
    // Thunder is weather: it ducks nothing.
    thunder: Object.freeze({ world: 0, work: 0, music: 0 }),
});
// Total ducked time per bus, as a fraction of an hour (C-MIX-5).
export const DUCKED_TIME_BUDGET = 0.05;

// Scene-keyed targets, keyed to the probe's named scenes. Relative fields
// name their reference in the key: `overA` is LU over Anchor A's LUFS-I,
// `overBed` is LU over the scene's bed.
export const LOUDNESS_TARGETS = Object.freeze({
    // Calm clear day, world stratum only (sea, wind, birds; no work, music or cues).
    anchorA: Object.freeze({ lufsI: -38, toleranceLu: 1 }),
    // Village, 10-minute busy session.
    villageSession: Object.freeze({ overA: 4, toleranceLu: 2, lraMaxLu: 8 }),
    // Village music (an occasion or a fragment), short-term over the bed.
    villageMusic: Object.freeze({ stMaxOverBed: 3, fragmentStMaxOverBed: 1 }),
    // Town band. The band stem's ST max excludes cues: a needs-you over the
    // band is meant to lift the program ST max past it.
    townBand: Object.freeze({ lufsI: -31, toleranceLu: 1, bandStemStMax: -28 }),
    // Night, clear, with its occasion: no louder than the Village session,
    // and the 2-5 kHz band at least 4 dB under noon.
    night: Object.freeze({ maxOverVillageSession: 0, presenceUnderNoonDb: 4, presenceBandHz: Object.freeze([2000, 5000]) }),
    rain: Object.freeze({ maxOverA: 5 }),
    // Storm, thunder included.
    storm: Object.freeze({ maxOverA: 6, stMax: -27 }),
    // Resting (the pilot light).
    resting: Object.freeze({ overA: -10, toleranceLu: 3, lufsSFloor: -55 }),
    // At full slider.
    ceiling: Object.freeze({ truePeakDbtp: -1, urgentGrMaxDb: 3, thunderGrMaxDb: 6 }),
});

// The program limiter's sample ceiling (dBFS). The worklet detects sample
// peaks, not true peaks; 0.5 dB under the −1 dBTP ceiling above covers the
// inter-sample overshoot of a worst-case burst (the probe's +14 dBFS limiter
// unit read −0.64 dBTP at a −1 dBFS sample ceiling). The no-AudioWorklet
// fallback (emergency path only) is not bound by this: its true peak can
// pass −1 dBTP.
export const LIMITER_CEILING_DBFS = -1.5;

// Audibility lane windows: LU of the cue over the `bedWindowSec` of bed
// before it. Per bed context a lane has `min` and/or `max`; `ceiling` caps
// every context. A cue that lands into resting is exempt from its ceiling
// (the trim never pulls it below 0 dB) and is gated only by the limiter GR.
export const AUDIBILITY_WINDOWS = Object.freeze({
    bedWindowSec: 3,
    lanes: Object.freeze({
        needsYou: Object.freeze({
            village: Object.freeze({ min: 10 }),
            music: Object.freeze({ min: 8 }),
            weather: Object.freeze({ min: 6 }),
            ceiling: 12,
        }),
        error: Object.freeze({
            village: Object.freeze({ min: 8 }),
            music: Object.freeze({ min: 6 }),
            weather: Object.freeze({ min: 6 }),
            ceiling: 12,
        }),
        limit: Object.freeze({
            village: Object.freeze({ min: 6 }),
            music: Object.freeze({ min: 4 }),
            weather: Object.freeze({ min: 4 }),
            ceiling: 10,
        }),
        routine: Object.freeze({
            village: Object.freeze({ min: 3, max: 6 }),
            music: Object.freeze({ min: 3, max: 6 }),
            weather: Object.freeze({ min: 3, max: 6 }),
        }),
        // Also at least 3 LU under the routine cue it accompanies.
        outcomeMinor: Object.freeze({
            village: Object.freeze({ min: 0, max: 3 }),
            music: Object.freeze({ min: 0, max: 3 }),
            weather: Object.freeze({ min: 0, max: 3 }),
            underRoutineLu: 3,
        }),
        outcomeMedium: Object.freeze({
            village: Object.freeze({ min: 3, max: 6 }),
            music: Object.freeze({ min: 3, max: 6 }),
            weather: Object.freeze({ min: 3, max: 6 }),
        }),
        // Release; one active globally.
        outcomeMajor: Object.freeze({
            village: Object.freeze({ min: 4, max: 8 }),
            music: Object.freeze({ min: 4, max: 8 }),
            weather: Object.freeze({ min: 4, max: 8 }),
        }),
        // Hour chime, aurora, link cues, the return digest.
        scenery: Object.freeze({
            village: Object.freeze({ min: 0, max: 5 }),
            music: Object.freeze({ min: 0, max: 5 }),
            weather: Object.freeze({ min: 0, max: 5 }),
        }),
        // Over its own storm only, measured from the thunder onset, not the flash.
        thunder: Object.freeze({
            near: Object.freeze({ min: 5, max: 10 }),
            far: Object.freeze({ min: 2, max: 6 }),
        }),
    }),
    // Urgent cues (needs-you, error) also need spectral room, not just LU.
    urgentBandRule: Object.freeze({
        // Over music: 0.5-4 kHz energy in [t, t + 1.2 s] vs [t - 3 s, t).
        overMusic: Object.freeze({ bandHz: Object.freeze([500, 4000]), afterSec: 1.2, beforeSec: 3, minRiseDb: 6 }),
        // Over non-music beds: at least two third-octave bands rise by 6 dB.
        overBed: Object.freeze({ thirdOctaveBands: 2, minRiseDb: 6 }),
    }),
});

// Voice registry: every cue, grain and musical voice declares its raw
// nominal loudness so trims and the probe can predict where it lands.
// Shape: { [voiceId]: { nominalLufsM, plr } }
//   voiceId       stable id, e.g. 'cue.needsYou', 'work.forge.anvil', 'music.isle.lead'
//   nominalLufsM  momentary max (LUFS-M) of one voice render at unit gain,
//                 pre-trim, in the bedLoudness() domain: at the bus stage,
//                 before PROGRAM_TRIM, fade and volume
//   plr           peak-to-loudness ratio (dB): sample peak dBFS minus nominalLufsM; null until measured
// Entries arrive with the voices that own them (Waves 1, 3, 5, 6).
// Today's cue voices (Wave 1): MIX's mix-v2-nominal renders (program trim 0,
// volume 1, the cue's fixed 0.72 stage included); `limit` borrows distress.
export const VOICE_REGISTRY = Object.freeze({
    'cue.summons': Object.freeze({ nominalLufsM: -36.7, plr: null }),
    'cue.distress': Object.freeze({ nominalLufsM: -36.4, plr: null }),
    'cue.arrival': Object.freeze({ nominalLufsM: -38.5, plr: null }),
    'cue.departure': Object.freeze({ nominalLufsM: -39.1, plr: null }),
    'cue.recovery': Object.freeze({ nominalLufsM: -40.0, plr: null }),
    'cue.council': Object.freeze({ nominalLufsM: -39.4, plr: null }),
    'cue.hourBell': Object.freeze({ nominalLufsM: -33.5, plr: null }),
    // Wave 2: the aurora rendered with its Island Air send (0.35), voice −2 dB.
    'cue.aurora': Object.freeze({ nominalLufsM: -38.7, plr: null }),
    'cue.thunder': Object.freeze({ nominalLufsM: -33.7, plr: null }),
});

// Memory table (S8): resident AudioBuffer bytes per SampleBank client
// (length × channels × 4), MiB-based. The noise pool counts under `noise`
// although it is built by the engine, not baked. Rates are each client's
// planned bake rate; a client may store a band-limited colour lower.
const MIB = 1024 * 1024;
export const MEMORY_BUDGET = Object.freeze({
    totalBytes: 32 * MIB,
    air: 1.5 * MIB,        // Island Air IRs (2), 48 kHz
    noise: 8 * MIB,        // noise buffer pool, ≤ 48 kHz
    workshop: 8 * MIB,     // workshop takes, 32 kHz
    rareWorld: 5 * MIB,    // gulls, clinks, groans, thunder takes, 32 kHz
    music: 8 * MIB,        // music instruments (6.1), 32 kHz
    cueStrikes: 2 * MIB,   // optional; the node path is the default, 48 kHz
});
