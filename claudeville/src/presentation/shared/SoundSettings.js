// The persisted sound levels and preferences (plan 1.2, 3.8, MIX-9, UX-8,
// UX-12, decisions D5–D7): one owner for the storage keys, the step laws, the
// caption, reminder and hour-count choices, and the one-time recalibration. TopBar
// and SET read it at boot; the sound controller reads and writes it once the
// idle build lands. Pure and DOM-free: it loads no audio module beyond the
// Loudness table, so the v0.37 boot deferral holds.
//
// Volume and every mixer trim are stored as whole steps 0–10; the gain laws
// live in Loudness (`volumeStepGain`, `trimStepGain`), the standard step is
// its STANDARD_VOLUME_STEP.

import { STANDARD_VOLUME_STEP } from './audio/Loudness.js';

export const SOUND_ENABLED_KEY = 'claudeville.sound.enabled';
export const SOUND_VOLUME_KEY = 'claudeville.sound.volume';
export const SOUND_LAYERS_KEY = 'claudeville.sound.layers';
export const SOUND_CALIBRATION_KEY = 'claudeville.sound.calibration';
// The level standard the stored steps are calibrated to. A profile without it
// predates the calibrated master (1.1) and is reset once (D5).
export const SOUND_CALIBRATION = '2';
export const SOUND_STEP_MAX = 10;
export const SOUND_RECALIBRATED_MESSAGE = 'Sound was recalibrated to a new standard level.';

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

// The mixer channels are the engine's group faders, one to one, each at its
// default trim step.
export const AUDIO_MIXER_DEFAULTS = Object.freeze({
    wind: SOUND_STEP_MAX,
    rain: SOUND_STEP_MAX,
    wildlife: SOUND_STEP_MAX,
    hum: SOUND_STEP_MAX,
    music: SOUND_STEP_MAX,
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

// Any input → a whole step 0–10; missing or non-numeric input → `fallback`.
export function soundStep(value, fallback) {
    if (value == null || value === '') return fallback;
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.max(0, Math.min(SOUND_STEP_MAX, Math.round(number)));
}

export function soundCalibrated(storage = globalThis.window?.localStorage) {
    return storageGet(storage, SOUND_CALIBRATION_KEY) !== null;
}

// An uncalibrated profile reads as the standard level even before the reset
// is written, so SET never shows a legacy value as a step.
export function readStoredVolumeStep(storage = globalThis.window?.localStorage) {
    if (!soundCalibrated(storage)) return STANDARD_VOLUME_STEP;
    return soundStep(storageGet(storage, SOUND_VOLUME_KEY), STANDARD_VOLUME_STEP);
}

export function readStoredTrimSteps(storage = globalThis.window?.localStorage) {
    if (!soundCalibrated(storage)) return { ...AUDIO_MIXER_DEFAULTS };
    let parsed = null;
    try {
        parsed = JSON.parse(storageGet(storage, SOUND_LAYERS_KEY) || '{}');
    } catch {
        parsed = null;
    }
    return Object.fromEntries(Object.entries(AUDIO_MIXER_DEFAULTS).map(([name, fallback]) => [
        name,
        soundStep(parsed?.[name], fallback),
    ]));
}

export function writeStoredVolumeStep(step, storage = globalThis.window?.localStorage) {
    storageSet(storage, SOUND_VOLUME_KEY, String(step));
}

export function writeStoredTrimSteps(steps, storage = globalThis.window?.localStorage) {
    storageSet(storage, SOUND_LAYERS_KEY, JSON.stringify(steps));
}

// D5: a profile without the calibration key has its volume replaced by the
// standard step and every trim by its default step; the key is written last,
// so an interrupted reset repeats rather than leaving legacy values marked
// calibrated. Returns true when stored levels were actually replaced (the
// caller captions it once); a fresh profile is only marked.
export function recalibrateStoredSound(storage = globalThis.window?.localStorage) {
    if (!storage || soundCalibrated(storage)) return false;
    const legacy = storageGet(storage, SOUND_VOLUME_KEY) !== null
        || storageGet(storage, SOUND_LAYERS_KEY) !== null;
    if (legacy) {
        writeStoredVolumeStep(STANDARD_VOLUME_STEP, storage);
        writeStoredTrimSteps({ ...AUDIO_MIXER_DEFAULTS }, storage);
    }
    const marked = storageSet(storage, SOUND_CALIBRATION_KEY, SOUND_CALIBRATION);
    return legacy && marked;
}

function storedChoice(storage, key, choices, fallback) {
    const value = storageGet(storage, key);
    return choices.includes(value) ? value : fallback;
}

export function readStoredSoundEnabled(storage = globalThis.window?.localStorage) {
    return storageGet(storage, SOUND_ENABLED_KEY) === 'true';
}

export function readReminderSetting(storage = globalThis.window?.localStorage) {
    return storedChoice(storage, SOUND_REMINDERS_KEY, SOUND_REMINDER_SETTINGS, DEFAULT_SOUND_REMINDERS);
}

export function writeReminderSetting(value, storage = globalThis.window?.localStorage) {
    const next = SOUND_REMINDER_SETTINGS.includes(value) ? value : DEFAULT_SOUND_REMINDERS;
    storageSet(storage, SOUND_REMINDERS_KEY, next);
    return next;
}

export function readCaptionSetting(storage = globalThis.window?.localStorage) {
    return storedChoice(storage, CAPTIONS_KEY, CAPTION_SETTINGS, DEFAULT_CAPTIONS);
}

export function writeCaptionSetting(value, storage = globalThis.window?.localStorage) {
    const next = CAPTION_SETTINGS.includes(value) ? value : DEFAULT_CAPTIONS;
    storageSet(storage, CAPTIONS_KEY, next);
    return next;
}

export function readCountHours(storage = globalThis.window?.localStorage) {
    return storageGet(storage, SOUND_COUNT_HOURS_KEY) === '1';
}

export function writeCountHours(on, storage = globalThis.window?.localStorage) {
    storageSet(storage, SOUND_COUNT_HOURS_KEY, on ? '1' : '0');
    return Boolean(on);
}
