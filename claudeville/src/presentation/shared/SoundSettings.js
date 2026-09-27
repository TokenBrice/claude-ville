// The persisted sound levels and preferences (plan 1.2, 3.8, 7.1–7.8, UX-3,
// UX-8, UX-10–UX-18, decisions D2, D5–D7): one owner for the storage keys,
// their defaults, the volume step's stored form, the preset vocabulary, and
// the one-time recalibration and per-preset volume migration. TopBar, SET and
// the invitation read it at boot; the sound controller reads and writes it
// once the idle build lands. Pure and DOM-free: it loads no audio module
// beyond the Loudness table, so the v0.37 boot deferral holds.
//
// Volume is stored as whole steps 0–10; the gain law lives in Loudness
// (`volumeStepGain`), the standard step is its STANDARD_VOLUME_STEP. Each
// preset keeps its own volume step (UX-18), its only level (v0.47.1).

import { STANDARD_VOLUME_STEP } from './audio/Loudness.js';

const defaultStorage = () => globalThis.window?.localStorage;

export const SOUND_ENABLED_KEY = 'claudeville.sound.enabled';
// The single volume step of profiles before 7.8: read once, to seed every
// preset's step (`migratePresetVolumes`), never written again.
export const LEGACY_SOUND_VOLUME_KEY = 'claudeville.sound.volume';
export const SOUND_VOLUMES_KEY = 'claudeville.sound.volumes';
export const SOUND_CALIBRATION_KEY = 'claudeville.sound.calibration';
// The level standard the stored steps are calibrated to. A profile without it
// predates the calibrated master (1.1) and is reset once (D5).
export const SOUND_CALIBRATION = '2';
export const SOUND_STEP_MAX = 10;
export const SOUND_RECALIBRATED_MESSAGE = 'Sound was recalibrated to a new standard level.';

// Presets (7.2, UX-3): storage keeps `enabled` plus a mode id; the UI names
// the three ways to listen and never shows a mode id. A mode id stored by an
// older build (the retired Village, 'ambient') is not a choice any more and
// reads as the default, the Town band.
export const SOUND_MODE_KEY = 'claudeville.sound.mode';
export const SOUND_MODES = Object.freeze(['signals', 'bgm']);
export const DEFAULT_SOUND_MODE = 'bgm';
export const SOUND_PRESETS = Object.freeze(['off', 'signals', 'townBand']);
export const SOUND_PRESET_LABELS = Object.freeze({
    off: 'Off',
    signals: 'Signals',
    townBand: 'Town band',
});
export const SOUND_PRESET_DETAILS = Object.freeze({
    off: 'Silent. Captions still appear.',
    signals: 'Only a bell when an agent needs you, errors, or hits a limit.',
    townBand: 'Continuous town music. The signal bells ring over it.',
});
const PRESET_MODES = Object.freeze({ signals: 'signals', townBand: 'bgm' });
const MODE_PRESETS = Object.freeze({ signals: 'signals', bgm: 'townBand' });

// What a visible but unfocused window plays (D3, UX-4).
export const SOUND_BACKGROUND_KEY = 'claudeville.sound.background';
export const SOUND_BACKGROUNDS = Object.freeze(['play', 'signals']);
export const DEFAULT_SOUND_BACKGROUND = 'play';

// Signal reminders (D6): Standard follows the capped ladder, Gentle and Off
// are the operator's quieter choices.
export const SOUND_REMINDERS_KEY = 'claudeville.sound.reminders';
export const SOUND_REMINDER_SETTINGS = Object.freeze(['standard', 'gentle', 'off']);
export const DEFAULT_SOUND_REMINDERS = 'standard';

// Captions (3.8, S6): `auto` shows signals only while sound is off and
// signals and events while it is on.
export const CAPTIONS_KEY = 'claudeville.captions';
export const CAPTION_SETTINGS = Object.freeze(['auto', 'signals', 'events', 'all']);
export const DEFAULT_CAPTIONS = 'auto';

// D7: the hour bell plays its phrase; counting the strokes is opt-in.
export const SOUND_COUNT_HOURS_KEY = 'claudeville.sound.countHours';
export const DEFAULT_SOUND_COUNT_HOURS = '0';

// D2: the Town band plays as the Isle Band; Chip restored is its one-click
// alternative voicing.
export const TOWN_BAND_VOICE_KEY = 'claudeville.sound.townBandVoice';
export const TOWN_BAND_VOICES = Object.freeze(['isle', 'chip']);
export const DEFAULT_TOWN_BAND_VOICE = 'isle';

// Output (7.7, UX-10): chosen by hand, never detected.
export const SOUND_OUTPUT_KEY = 'claudeville.sound.output';
export const SOUND_OUTPUTS = Object.freeze(['speakers', 'headphones', 'mono']);
export const DEFAULT_SOUND_OUTPUT = 'speakers';

// Tone (7.7, SOTA-14): Warm −1 … Bright +1, ±4 dB at the 3 kHz shelf.
export const SOUND_TONE_KEY = 'claudeville.sound.tone';
export const DEFAULT_SOUND_TONE = '0';
export const TONE_RANGE_DB = 4;

// Soften sudden sounds (7.7, UX-14): `auto` follows Reduce motion.
export const SOUND_SOFTEN_KEY = 'claudeville.sound.soften';
export const SOUND_SOFTEN_SETTINGS = Object.freeze(['auto', 'on', 'off']);
export const DEFAULT_SOUND_SOFTEN = 'auto';

// Hush and quiet hours (7.7, UX-11): both drop to Signals. Hush is a
// timestamp (ms since the epoch, 0 = none) and survives a reload; quiet
// hours are fixed local-clock windows.
export const SOUND_HUSH_UNTIL_KEY = 'claudeville.sound.hushUntil';
export const HUSH_DURATION_MS = 60 * 60 * 1000;
export const SOUND_QUIET_HOURS_KEY = 'claudeville.sound.quietHours';
export const QUIET_HOURS_SETTINGS = Object.freeze(['off', '22-08', '20-08', '23-07']);
export const DEFAULT_QUIET_HOURS = 'off';

// Once per profile (7.5, UX-6): the moment-of-need offer was made.
export const SOUND_INVITED_KEY = 'claudeville.sound.invited';
// 7.1: the first-ever click on the sound control opened the presets.
export const SOUND_CHIP_SEEN_KEY = 'claudeville.sound.chipSeen';

const PRESET_VOLUME_DEFAULTS = Object.freeze(Object.fromEntries(SOUND_MODES.map(mode => [mode, STANDARD_VOLUME_STEP])));

// Every sound key and the value a reset writes. The calibration key comes
// last, so a reset never needs the D5 recalibration.
export const SOUND_SETTING_DEFAULTS = Object.freeze({
    [SOUND_ENABLED_KEY]: 'false',
    [SOUND_MODE_KEY]: DEFAULT_SOUND_MODE,
    [SOUND_VOLUMES_KEY]: JSON.stringify(PRESET_VOLUME_DEFAULTS),
    [SOUND_BACKGROUND_KEY]: DEFAULT_SOUND_BACKGROUND,
    [SOUND_OUTPUT_KEY]: DEFAULT_SOUND_OUTPUT,
    [SOUND_TONE_KEY]: DEFAULT_SOUND_TONE,
    [SOUND_SOFTEN_KEY]: DEFAULT_SOUND_SOFTEN,
    [SOUND_HUSH_UNTIL_KEY]: '0',
    [SOUND_QUIET_HOURS_KEY]: DEFAULT_QUIET_HOURS,
    [SOUND_REMINDERS_KEY]: DEFAULT_SOUND_REMINDERS,
    [SOUND_COUNT_HOURS_KEY]: DEFAULT_SOUND_COUNT_HOURS,
    [CAPTIONS_KEY]: DEFAULT_CAPTIONS,
    [TOWN_BAND_VOICE_KEY]: DEFAULT_TOWN_BAND_VOICE,
    [SOUND_INVITED_KEY]: '0',
    [SOUND_CHIP_SEEN_KEY]: '0',
    [SOUND_CALIBRATION_KEY]: SOUND_CALIBRATION,
});

function storageGet(storage, key) {
    try { return storage?.getItem(key) ?? null; } catch { return null; }
}

function storageSet(storage, key, value) {
    try {
        storage?.setItem(key, value);
        return Boolean(storage);
    } catch {
        return false;
    }
}

function storedJson(storage, key) {
    try {
        const parsed = JSON.parse(storageGet(storage, key) ?? 'null');
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch {
        return null;
    }
}

function storedChoice(storage, key, choices, fallback) {
    const value = storageGet(storage, key);
    return choices.includes(value) ? value : fallback;
}

function writeChoice(storage, key, choices, value, fallback) {
    const next = choices.includes(value) ? value : fallback;
    storageSet(storage, key, next);
    return next;
}

// Any input → a whole step 0–10; missing or non-numeric input → `fallback`.
export function soundStep(value, fallback) {
    if (value == null || value === '') return fallback;
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.max(0, Math.min(SOUND_STEP_MAX, Math.round(number)));
}

export function soundCalibrated(storage = defaultStorage()) {
    return storageGet(storage, SOUND_CALIBRATION_KEY) !== null;
}

// ------------------------------------------------------------------ presets

/** The mode id a UI preset plays ('off' → null), or null for an unknown one. */
export function modeForPreset(preset) {
    return PRESET_MODES[preset] ?? null;
}

/** The UI preset a mode id plays as; an unknown mode reads as the Town band. */
export function presetForMode(mode) {
    return MODE_PRESETS[mode] ?? MODE_PRESETS[DEFAULT_SOUND_MODE];
}

// A UI preset or a mode id → the mode whose volume slot it uses; 'off' (and
// anything unknown) → the stored mode, the preset the toggle turns back on.
function volumeMode(preset, storage) {
    if (SOUND_MODES.includes(preset)) return preset;
    return modeForPreset(preset) ?? readStoredSoundMode(storage);
}

export function readStoredSoundEnabled(storage = defaultStorage()) {
    return storageGet(storage, SOUND_ENABLED_KEY) === 'true';
}

export function writeStoredSoundEnabled(enabled, storage = defaultStorage()) {
    storageSet(storage, SOUND_ENABLED_KEY, enabled ? 'true' : 'false');
    return Boolean(enabled);
}

export function readStoredSoundMode(storage = defaultStorage()) {
    return storedChoice(storage, SOUND_MODE_KEY, SOUND_MODES, DEFAULT_SOUND_MODE);
}

export function writeStoredSoundMode(mode, storage = defaultStorage()) {
    return writeChoice(storage, SOUND_MODE_KEY, SOUND_MODES, mode, DEFAULT_SOUND_MODE);
}

/** The preset the operator chose: 'off' while sound is disabled. */
export function readStoredSoundPreset(storage = defaultStorage()) {
    return readStoredSoundEnabled(storage) ? presetForMode(readStoredSoundMode(storage)) : 'off';
}

export function readSoundBackground(storage = defaultStorage()) {
    return storedChoice(storage, SOUND_BACKGROUND_KEY, SOUND_BACKGROUNDS, DEFAULT_SOUND_BACKGROUND);
}

export function writeSoundBackground(value, storage = defaultStorage()) {
    return writeChoice(storage, SOUND_BACKGROUND_KEY, SOUND_BACKGROUNDS, value, DEFAULT_SOUND_BACKGROUND);
}

// ------------------------------------------------------------------- levels

// An uncalibrated profile reads as the standard level even before the reset
// is written, so SET never shows a legacy value as a step. Until the one-time
// migration has written the per-preset steps, every preset reads the legacy
// single step.
export function readPresetVolumeStep(preset, storage = defaultStorage()) {
    if (!soundCalibrated(storage)) return STANDARD_VOLUME_STEP;
    const mode = volumeMode(preset, storage);
    const volumes = storedJson(storage, SOUND_VOLUMES_KEY);
    if (volumes) return soundStep(volumes[mode], STANDARD_VOLUME_STEP);
    return soundStep(storageGet(storage, LEGACY_SOUND_VOLUME_KEY), STANDARD_VOLUME_STEP);
}

/** Stores `step` for `preset` (a UI preset or a mode id); returns the step kept. */
export function writePresetVolumeStep(preset, step, storage = defaultStorage()) {
    const mode = volumeMode(preset, storage);
    const volumes = readPresetVolumeSteps(storage);
    volumes[mode] = soundStep(step, volumes[mode]);
    storageSet(storage, SOUND_VOLUMES_KEY, JSON.stringify(volumes));
    return volumes[mode];
}

/** Every preset's step, keyed by mode id. */
export function readPresetVolumeSteps(storage = defaultStorage()) {
    return Object.fromEntries(SOUND_MODES.map(mode => [mode, readPresetVolumeStep(mode, storage)]));
}

// UX-18: a profile with a single stored step gets it in every preset's slot,
// once; the per-preset key marks the migration done. Returns true when it
// wrote. Run after `recalibrateStoredSound`.
export function migratePresetVolumes(storage = defaultStorage()) {
    if (!storage || storageGet(storage, SOUND_VOLUMES_KEY) !== null) return false;
    return storageSet(storage, SOUND_VOLUMES_KEY, JSON.stringify(readPresetVolumeSteps(storage)));
}

// D5: a profile without the calibration key has every preset's volume
// replaced by the standard step; the key is written last, so an interrupted
// reset repeats rather than leaving legacy values marked calibrated. Returns
// true when stored levels were actually replaced (the caller captions it
// once); a fresh profile is only marked.
export function recalibrateStoredSound(storage = defaultStorage()) {
    if (!storage || soundCalibrated(storage)) return false;
    const legacy = storageGet(storage, LEGACY_SOUND_VOLUME_KEY) !== null
        || storageGet(storage, SOUND_VOLUMES_KEY) !== null;
    if (legacy) storageSet(storage, SOUND_VOLUMES_KEY, JSON.stringify(PRESET_VOLUME_DEFAULTS));
    const marked = storageSet(storage, SOUND_CALIBRATION_KEY, SOUND_CALIBRATION);
    return legacy && marked;
}

// ------------------------------------------------------ listening preferences

export function readSoundOutput(storage = defaultStorage()) {
    return storedChoice(storage, SOUND_OUTPUT_KEY, SOUND_OUTPUTS, DEFAULT_SOUND_OUTPUT);
}

export function writeSoundOutput(value, storage = defaultStorage()) {
    return writeChoice(storage, SOUND_OUTPUT_KEY, SOUND_OUTPUTS, value, DEFAULT_SOUND_OUTPUT);
}

// Tone is kept to quarter steps (1 dB of the ±4 dB shelf).
function toneValue(value) {
    if (value == null || value === '') return null;
    const number = Number(value);
    if (!Number.isFinite(number)) return null;
    return Math.round(Math.max(-1, Math.min(1, number)) * TONE_RANGE_DB) / TONE_RANGE_DB + 0;
}

/** −1 (warm) … +1 (bright); 0 when absent or unreadable. */
export function readSoundTone(storage = defaultStorage()) {
    return toneValue(storageGet(storage, SOUND_TONE_KEY)) ?? 0;
}

export function writeSoundTone(value, storage = defaultStorage()) {
    const next = toneValue(value) ?? 0;
    storageSet(storage, SOUND_TONE_KEY, String(next));
    return next;
}

/** The shelf gain of a tone value, in dB. */
export function toneDb(tone) {
    return (toneValue(tone) ?? 0) * TONE_RANGE_DB + 0;
}

export function readSoundSoften(storage = defaultStorage()) {
    return storedChoice(storage, SOUND_SOFTEN_KEY, SOUND_SOFTEN_SETTINGS, DEFAULT_SOUND_SOFTEN);
}

export function writeSoundSoften(value, storage = defaultStorage()) {
    return writeChoice(storage, SOUND_SOFTEN_KEY, SOUND_SOFTEN_SETTINGS, value, DEFAULT_SOUND_SOFTEN);
}

/** Whether sudden sounds are softened: `auto` follows Reduce motion. */
export function softenActive(setting, reducedMotion) {
    if (setting === 'on') return true;
    if (setting === 'off') return false;
    return Boolean(reducedMotion);
}

/** The hush's end in ms since the epoch; 0 when none is stored. */
export function readHushUntil(storage = defaultStorage()) {
    const until = Number(storageGet(storage, SOUND_HUSH_UNTIL_KEY));
    return Number.isFinite(until) && until > 0 ? Math.round(until) : 0;
}

export function writeHushUntil(until, storage = defaultStorage()) {
    const number = Number(until);
    const next = Number.isFinite(number) && number > 0 ? Math.round(number) : 0;
    storageSet(storage, SOUND_HUSH_UNTIL_KEY, String(next));
    return next;
}

export function hushActive(until, now = Date.now()) {
    return Number(until) > now;
}

export function readQuietHours(storage = defaultStorage()) {
    return storedChoice(storage, SOUND_QUIET_HOURS_KEY, QUIET_HOURS_SETTINGS, DEFAULT_QUIET_HOURS);
}

export function writeQuietHours(value, storage = defaultStorage()) {
    return writeChoice(storage, SOUND_QUIET_HOURS_KEY, QUIET_HOURS_SETTINGS, value, DEFAULT_QUIET_HOURS);
}

function quietWindow(setting) {
    if (!QUIET_HOURS_SETTINGS.includes(setting) || setting === 'off') return null;
    const [start, end] = setting.split('-').map(Number);
    return { start, end };
}

/** Whether a local time falls inside the quiet-hours window (local `Date` hours). */
export function inQuietHours(setting, date = new Date()) {
    const window = quietWindow(setting);
    if (!window) return false;
    const hour = date.getHours();
    return window.start > window.end
        ? hour >= window.start || hour < window.end
        : hour >= window.start && hour < window.end;
}

/** When the current quiet hours end (a local `Date`), or null outside them. */
export function quietHoursEndsAt(setting, date = new Date()) {
    if (!inQuietHours(setting, date)) return null;
    const { end } = quietWindow(setting);
    const ends = new Date(date.getFullYear(), date.getMonth(), date.getDate(), end, 0, 0, 0);
    if (ends <= date) ends.setDate(ends.getDate() + 1);
    return ends;
}

export function readSoundInvited(storage = defaultStorage()) {
    return storageGet(storage, SOUND_INVITED_KEY) === '1';
}

export function writeSoundInvited(storage = defaultStorage()) {
    storageSet(storage, SOUND_INVITED_KEY, '1');
    return true;
}

export function readSoundChipSeen(storage = defaultStorage()) {
    return storageGet(storage, SOUND_CHIP_SEEN_KEY) === '1';
}

export function writeSoundChipSeen(storage = defaultStorage()) {
    storageSet(storage, SOUND_CHIP_SEEN_KEY, '1');
    return true;
}

export function readReminderSetting(storage = defaultStorage()) {
    return storedChoice(storage, SOUND_REMINDERS_KEY, SOUND_REMINDER_SETTINGS, DEFAULT_SOUND_REMINDERS);
}

export function writeReminderSetting(value, storage = defaultStorage()) {
    return writeChoice(storage, SOUND_REMINDERS_KEY, SOUND_REMINDER_SETTINGS, value, DEFAULT_SOUND_REMINDERS);
}

export function readCaptionSetting(storage = defaultStorage()) {
    return storedChoice(storage, CAPTIONS_KEY, CAPTION_SETTINGS, DEFAULT_CAPTIONS);
}

export function writeCaptionSetting(value, storage = defaultStorage()) {
    return writeChoice(storage, CAPTIONS_KEY, CAPTION_SETTINGS, value, DEFAULT_CAPTIONS);
}

export function readCountHours(storage = defaultStorage()) {
    return storageGet(storage, SOUND_COUNT_HOURS_KEY) === '1';
}

export function writeCountHours(on, storage = defaultStorage()) {
    storageSet(storage, SOUND_COUNT_HOURS_KEY, on ? '1' : '0');
    return Boolean(on);
}

export function readTownBandVoice(storage = defaultStorage()) {
    return storedChoice(storage, TOWN_BAND_VOICE_KEY, TOWN_BAND_VOICES, DEFAULT_TOWN_BAND_VOICE);
}

export function writeTownBandVoice(value, storage = defaultStorage()) {
    return writeChoice(storage, TOWN_BAND_VOICE_KEY, TOWN_BAND_VOICES, value, DEFAULT_TOWN_BAND_VOICE);
}

/**
 * Every stored sound preference, as SET and the popover show it. TopBar's
 * `readPersistedSettings` spreads it.
 */
export function readSoundSettings(storage = defaultStorage()) {
    return {
        soundEnabled: readStoredSoundEnabled(storage),
        soundMode: readStoredSoundMode(storage),
        soundPreset: readStoredSoundPreset(storage),
        soundVolumes: readPresetVolumeSteps(storage),
        soundBackground: readSoundBackground(storage),
        soundReminders: readReminderSetting(storage),
        soundCountHours: readCountHours(storage),
        captions: readCaptionSetting(storage),
        soundTownBandVoice: readTownBandVoice(storage),
        soundOutput: readSoundOutput(storage),
        soundTone: readSoundTone(storage),
        soundSoften: readSoundSoften(storage),
        soundHushUntil: readHushUntil(storage),
        soundQuietHours: readQuietHours(storage),
        soundInvited: readSoundInvited(storage),
        soundChipSeen: readSoundChipSeen(storage),
    };
}
