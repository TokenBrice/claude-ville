import test from 'node:test';
import assert from 'node:assert/strict';

import {
    AUDIO_MIXER_DEFAULTS,
    SOUND_SETTING_DEFAULTS,
    channelStep,
    channelTrimSteps,
    hushActive,
    inQuietHours,
    migratePresetVolumes,
    mixChannelsFor,
    quietHoursEndsAt,
    readHushUntil,
    readPresetVolumeStep,
    readQuietHours,
    readSoundChipSeen,
    readSoundInvited,
    readSoundOutput,
    readSoundSettings,
    readSoundSoften,
    readSoundTone,
    readStoredSoundPreset,
    recalibrateStoredSound,
    softenActive,
    toneDb,
    writeHushUntil,
    writePresetVolumeStep,
    writeQuietHours,
    writeSoundChipSeen,
    writeSoundInvited,
    writeSoundOutput,
    writeSoundSoften,
    writeSoundTone,
} from '../../claudeville/src/presentation/shared/SoundSettings.js';
import { STANDARD_VOLUME_STEP } from '../../claudeville/src/presentation/shared/audio/Loudness.js';

class MemoryStorage {
    constructor(entries = {}) {
        this.values = new Map(Object.entries(entries));
    }

    getItem(key) {
        return this.values.has(key) ? this.values.get(key) : null;
    }

    setItem(key, value) {
        this.values.set(key, String(value));
    }
}

const CALIBRATED = { 'claudeville.sound.calibration': '2' };

test('the single stored step seeds every preset once, then each preset keeps its own', () => {
    const storage = new MemoryStorage({ ...CALIBRATED, 'claudeville.sound.volume': '7' });
    // Before the migration every preset reads the legacy step.
    for (const preset of ['signals', 'village', 'townBand']) assert.equal(readPresetVolumeStep(preset, storage), 7);
    assert.equal(migratePresetVolumes(storage), true);
    assert.equal(migratePresetVolumes(storage), false, 'once');
    assert.deepEqual(JSON.parse(storage.getItem('claudeville.sound.volumes')), { signals: 7, ambient: 7, bgm: 7 });

    assert.equal(writePresetVolumeStep('village', 4, storage), 4);
    assert.equal(writePresetVolumeStep('signals', 8, storage), 8);
    // A later change to the legacy key (an old tab) no longer moves anything.
    storage.setItem('claudeville.sound.volume', '1');
    const reloaded = new MemoryStorage(Object.fromEntries(storage.values));
    assert.equal(readPresetVolumeStep('village', reloaded), 4);
    assert.equal(readPresetVolumeStep('ambient', reloaded), 4, 'a mode id reads the same slot');
    assert.equal(readPresetVolumeStep('signals', reloaded), 8);
    assert.equal(readPresetVolumeStep('townBand', reloaded), 7);
    assert.equal(migratePresetVolumes(reloaded), false);
});

test('Off reads and writes the volume of the preset the toggle turns back on', () => {
    const storage = new MemoryStorage({
        ...CALIBRATED,
        'claudeville.sound.mode': 'bgm',
        'claudeville.sound.volumes': JSON.stringify({ signals: 3, ambient: 5, bgm: 9 }),
    });
    assert.equal(readPresetVolumeStep('off', storage), 9);
    writePresetVolumeStep('off', 2, storage);
    assert.equal(readPresetVolumeStep('townBand', storage), 2);
    assert.equal(readPresetVolumeStep('village', storage), 5);
});

test('a first write without a migration keeps the legacy step in the other presets', () => {
    const storage = new MemoryStorage({ ...CALIBRATED, 'claudeville.sound.volume': '3' });
    writePresetVolumeStep('signals', 10, storage);
    assert.deepEqual(JSON.parse(storage.getItem('claudeville.sound.volumes')), { signals: 10, ambient: 3, bgm: 3 });
});

test('invalid volume steps fall back or clamp; an uncalibrated profile reads the standard step', () => {
    const corrupt = new MemoryStorage({ ...CALIBRATED, 'claudeville.sound.volumes': '{not json' });
    assert.equal(readPresetVolumeStep('village', corrupt), STANDARD_VOLUME_STEP);
    const odd = new MemoryStorage({
        ...CALIBRATED,
        'claudeville.sound.volumes': JSON.stringify({ signals: 14, ambient: 'loud', bgm: -2 }),
    });
    assert.equal(readPresetVolumeStep('signals', odd), 10);
    assert.equal(readPresetVolumeStep('village', odd), STANDARD_VOLUME_STEP);
    assert.equal(readPresetVolumeStep('townBand', odd), 0);
    assert.equal(writePresetVolumeStep('village', 'x', odd), STANDARD_VOLUME_STEP, 'a non-number keeps the slot');
    assert.equal(writePresetVolumeStep('village', 6.6, odd), 7);

    const legacy = new MemoryStorage({ 'claudeville.sound.volume': '0.72', 'claudeville.sound.volumes': '{"signals":2}' });
    assert.equal(readPresetVolumeStep('signals', legacy), STANDARD_VOLUME_STEP);
    // D5 resets every preset's slot, then marks the profile.
    assert.equal(recalibrateStoredSound(legacy), true);
    assert.deepEqual(JSON.parse(legacy.getItem('claudeville.sound.volumes')),
        { signals: STANDARD_VOLUME_STEP, ambient: STANDARD_VOLUME_STEP, bgm: STANDARD_VOLUME_STEP });
    assert.equal(migratePresetVolumes(legacy), false, 'the reset already wrote the per-preset steps');
});

test('output, tone, soften, hush, quiet hours, invited and first click read their defaults and reject junk', () => {
    const fresh = new MemoryStorage();
    assert.equal(readSoundOutput(fresh), 'speakers');
    assert.equal(readSoundTone(fresh), 0);
    assert.equal(readSoundSoften(fresh), 'auto');
    assert.equal(readHushUntil(fresh), 0);
    assert.equal(readQuietHours(fresh), 'off');
    assert.equal(readSoundInvited(fresh), false);
    assert.equal(readSoundChipSeen(fresh), false);

    const junk = new MemoryStorage({
        'claudeville.sound.output': 'surround',
        'claudeville.sound.tone': 'bright',
        'claudeville.sound.soften': 'yes',
        'claudeville.sound.hushUntil': '-5',
        'claudeville.sound.quietHours': '21-06',
        'claudeville.sound.invited': 'true',
        'claudeville.sound.chipSeen': 'yes',
    });
    assert.equal(readSoundOutput(junk), 'speakers');
    assert.equal(readSoundTone(junk), 0);
    assert.equal(readSoundSoften(junk), 'auto');
    assert.equal(readHushUntil(junk), 0);
    assert.equal(readQuietHours(junk), 'off');
    assert.equal(readSoundInvited(junk), false);
    assert.equal(readSoundChipSeen(junk), false);

    const storage = new MemoryStorage();
    assert.equal(writeSoundOutput('headphones', storage), 'headphones');
    assert.equal(writeSoundOutput('surround', storage), 'speakers');
    assert.equal(writeSoundSoften('off', storage), 'off');
    assert.equal(writeQuietHours('22-08', storage), '22-08');
    assert.equal(writeQuietHours('9-5', storage), 'off');
    // Tone clamps to −1…+1 in quarter steps (1 dB of the ±4 dB shelf).
    assert.equal(writeSoundTone(3, storage), 1);
    assert.equal(writeSoundTone(-0.3, storage), -0.25);
    assert.equal(readSoundTone(storage), -0.25);
    assert.equal(toneDb(readSoundTone(storage)), -1);
    assert.equal(toneDb(-1), -4);
    assert.equal(writeSoundTone('nope', storage), 0);
    assert.equal(writeHushUntil(1790000000000.4, storage), 1790000000000);
    assert.equal(readHushUntil(storage), 1790000000000);
    assert.equal(writeHushUntil(null, storage), 0);
    writeSoundInvited(storage);
    writeSoundChipSeen(storage);
    assert.equal(readSoundInvited(storage), true);
    assert.equal(readSoundChipSeen(storage), true);
    assert.equal(storage.getItem('claudeville.sound.invited'), '1');
});

test('hush lasts until its timestamp; soften follows Reduce motion unless set', () => {
    assert.equal(hushActive(0, 1000), false);
    assert.equal(hushActive(2000, 1000), true);
    assert.equal(hushActive(1000, 1000), false);
    assert.equal(softenActive('auto', true), true);
    assert.equal(softenActive('auto', false), false);
    assert.equal(softenActive('on', false), true);
    assert.equal(softenActive('off', true), false);
});

test('quiet hours wrap midnight on the local clock and say when they end', () => {
    const at = (h, m = 0) => new Date(2026, 8, 27, h, m);
    assert.equal(inQuietHours('22-08', at(21, 59)), false);
    assert.equal(inQuietHours('22-08', at(22)), true);
    assert.equal(inQuietHours('22-08', at(3)), true);
    assert.equal(inQuietHours('22-08', at(7, 59)), true);
    assert.equal(inQuietHours('22-08', at(8)), false);
    assert.equal(inQuietHours('23-07', at(22, 30)), false);
    assert.equal(inQuietHours('20-08', at(20)), true);
    assert.equal(inQuietHours('off', at(3)), false);
    assert.equal(inQuietHours('bogus', at(3)), false);
    assert.equal(quietHoursEndsAt('22-08', at(12)), null);
    assert.deepEqual(quietHoursEndsAt('22-08', at(23)), new Date(2026, 8, 28, 8));
    assert.deepEqual(quietHoursEndsAt('22-08', at(2)), new Date(2026, 8, 27, 8));
});

test('each preset shows only the trims it plays through, named for what you hear', () => {
    const labels = preset => mixChannelsFor(preset).map(channel => channel.label);
    assert.deepEqual(labels('off'), []);
    assert.deepEqual(labels('signals'), []);
    assert.deepEqual(labels('townBand'), ['Band']);
    assert.deepEqual(labels('village'), ['Weather & sea', 'Wildlife', 'Workshops', 'Band']);
    assert.deepEqual(labels('ambient'), [], 'mode ids are not presets');
    // Every group fader is reachable from the Village mix exactly once.
    const trims = mixChannelsFor('village').flatMap(channel => channel.trims);
    assert.deepEqual([...trims].sort(), Object.keys(AUDIO_MIXER_DEFAULTS).sort());
});

test('one mix slider moves all its trims, keeping their default offsets', () => {
    const workshops = mixChannelsFor('village').find(channel => channel.id === 'workshops');
    assert.equal(channelStep(workshops, AUDIO_MIXER_DEFAULTS), AUDIO_MIXER_DEFAULTS.workshops);
    assert.deepEqual(channelTrimSteps(workshops, AUDIO_MIXER_DEFAULTS.workshops), { workshops: 9, hum: 10 });
    assert.deepEqual(channelTrimSteps(workshops, 5), { workshops: 5, hum: 6 });
    assert.deepEqual(channelTrimSteps(workshops, 10), { workshops: 10, hum: 10 });
    assert.deepEqual(channelTrimSteps(workshops, 0), { workshops: 0, hum: 0 }, 'off is off for every trim');
    const weather = mixChannelsFor('village')[0];
    assert.deepEqual(channelTrimSteps(weather, 4), { wind: 4, rain: 4 });
    assert.equal(channelStep(weather, { wind: 3, rain: 8 }), 3);
});

test('the preset reads Off while sound is disabled, and the defaults match what a fresh profile reads', () => {
    assert.equal(readStoredSoundPreset(new MemoryStorage({ 'claudeville.sound.mode': 'bgm' })), 'off');
    assert.equal(readStoredSoundPreset(new MemoryStorage({ 'claudeville.sound.enabled': 'true', 'claudeville.sound.mode': 'signals' })), 'signals');
    assert.equal(readStoredSoundPreset(new MemoryStorage({ 'claudeville.sound.enabled': 'true', 'claudeville.sound.mode': 'chip' })), 'village');
    const keys = Object.keys(SOUND_SETTING_DEFAULTS);
    assert.equal(keys.at(-1), 'claudeville.sound.calibration', 'written last');
    assert.deepEqual(readSoundSettings(new MemoryStorage(SOUND_SETTING_DEFAULTS)), readSoundSettings(new MemoryStorage(CALIBRATED)));
});
