// The loudness contract (plan S2, C-MIX-7): one table read by the engine's
// meters and by the audio probe, so a level claim is always measured against
// the same numbers. Pure data; importable from Node as well as the browser.
//
// Units: LUFS / LU are ITU-R BS.1770-4 (K-weighted, gated for -I); every
// target is measured at the engine output at the default slider unless a
// field says otherwise. "A" is the Anchor A scene below.

// Gain (dB) on the program sum that makes Anchor A true on the current bed.
// Wave 0 ships no trim stage, so this stays 0 until Wave 1 (item 1.1)
// measures it with the probe on the retired-tonal-bed village; it is then
// re-measured and the probe re-baselined at the end of Waves 1, 4 and 6.
export const PROGRAM_TRIM_DB = 0;

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
//   nominalLufsM  momentary max (LUFS-M) of one voice render at unit gain, pre-trim
//   plr           peak-to-loudness ratio (dB): sample peak dBFS minus nominalLufsM
// Entries arrive with the voices that own them (Waves 1, 3, 5, 6).
export const VOICE_REGISTRY = {};
