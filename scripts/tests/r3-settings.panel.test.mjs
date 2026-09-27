import test from 'node:test';
import assert from 'node:assert/strict';
import { installReducedMotionOverride } from '../../claudeville/src/presentation/shared/SettingsPanel.js';

import {
    PERSISTED_SETTING_DEFAULTS,
    TopBar,
    readPersistedSettings,
    resetPersistedSettings,
} from '../../claudeville/src/presentation/shared/TopBar.js';
import {
    SOUND_SETTING_DEFAULTS,
    readCaptionSetting,
    readCountHours,
    readReminderSetting,
    readTownBandVoice,
    writeCaptionSetting,
    writeCountHours,
    writeReminderSetting,
    writeTownBandVoice,
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

test('reduced-motion reads reuse one native query and preserve override notifications', () => {
    let queryCount = 0;
    let nativeListenerCount = 0;
    let legacyListenerCount = 0;
    let notifyNative;
    const native = {
        media: '(prefers-reduced-motion: reduce)', matches: false,
        addEventListener(type, listener) {
            assert.equal(type, 'change');
            nativeListenerCount++;
            notifyNative = listener;
        },
        addListener() { legacyListenerCount++; },
    };
    const unrelated = { media: '(min-width: 1280px)', matches: true };
    const root = {
        localStorage: new MemoryStorage(),
        document: { documentElement: { classList: { toggle() {} } } },
        matchMedia(query) { queryCount++; return query === native.media ? native : unrelated; },
    };
    const controller = installReducedMotionOverride(root);
    for (let index = 0; index < 100; index++) assert.equal(root.matchMedia(native.media).matches, false);
    assert.equal(queryCount, 1);
    assert.equal(nativeListenerCount, 1);
    assert.equal(legacyListenerCount, 0);
    const query = root.matchMedia(native.media);
    const changes = [];
    const listener = event => changes.push(event.matches);
    query.addEventListener('change', listener);
    controller.set(true);
    controller.set(true);
    native.matches = true;
    notifyNative();
    controller.set(false);
    assert.equal(query.matches, true, 'native preference remains effective when override is off');
    native.matches = false;
    notifyNative();
    assert.deepEqual(changes, [true, false]);
    query.removeEventListener('change', listener);
    controller.set(true);
    assert.deepEqual(changes, [true, false], 'removed observers are released');
    assert.equal(root.matchMedia(unrelated.media), unrelated, 'other queries retain native behavior');
    assert.equal(queryCount, 2);
});

test('settings review reads every operator preference, sound levels as steps', () => {
    const storage = new MemoryStorage({
        'claudeville.sound.enabled': 'true',
        'claudeville.sound.volumes': JSON.stringify({ signals: 8, ambient: 4, bgm: 7 }),
        'claudeville.sound.mode': 'bgm',
        'claudeville.sound.background': 'signals',
        'claudeville.sound.calibration': '2',
        'claudeville.sound.reminders': 'gentle',
        'claudeville.sound.countHours': '1',
        'claudeville.captions': 'all',
        'claudeville.sound.townBandVoice': 'chip',
        'claudeville.sound.output': 'mono',
        'claudeville.sound.tone': '-0.5',
        'claudeville.sound.soften': 'on',
        'claudeville.sound.hushUntil': '1790000000000',
        'claudeville.sound.quietHours': '23-07',
        'claudeville.sound.invited': '1',
        'claudeville.sound.chipSeen': '1',
        'cv-auto-camera': '0',
        'claudeville.alerts.desktop': '1',
        'claudeville.sidebarCollapsed': 'true',
    });

    assert.deepEqual(readPersistedSettings(storage), {
        soundEnabled: true,
        soundMode: 'bgm',
        soundPreset: 'townBand',
        soundVolumes: { signals: 8, bgm: 7 },
        soundBackground: 'signals',
        soundReminders: 'gentle',
        soundCountHours: true,
        captions: 'all',
        soundTownBandVoice: 'chip',
        soundOutput: 'mono',
        soundTone: -0.5,
        soundSoften: 'on',
        soundHushUntil: 1790000000000,
        soundQuietHours: '23-07',
        soundInvited: true,
        soundChipSeen: true,
        autoCamera: false,
        desktopAlerts: true,
        sidebarCollapsed: true,
    });
});

test('an uncalibrated profile reads as the standard level before the controller resets it', () => {
    const settings = readPersistedSettings(new MemoryStorage({ 'claudeville.sound.volume': '0.72' }));
    assert.deepEqual(settings.soundVolumes, { signals: STANDARD_VOLUME_STEP, bgm: STANDARD_VOLUME_STEP });
});

test('reminder, caption and hour-count preferences read their defaults and reject unknown values', () => {
    const fresh = readPersistedSettings(new MemoryStorage());
    assert.equal(fresh.soundReminders, 'standard');
    assert.equal(fresh.captions, 'auto');
    assert.equal(fresh.soundCountHours, false);
    assert.equal(fresh.soundPreset, 'off');

    const odd = readPersistedSettings(new MemoryStorage({
        'claudeville.sound.reminders': 'loud',
        'claudeville.captions': 'everything',
        'claudeville.sound.countHours': 'true',
    }));
    assert.equal(odd.soundReminders, 'standard');
    assert.equal(odd.captions, 'auto');
    assert.equal(odd.soundCountHours, false);
});

test('SET writes the preferences its readers take on use', () => {
    const storage = new MemoryStorage();
    assert.equal(writeReminderSetting('off', storage), 'off');
    assert.equal(writeCaptionSetting('signals', storage), 'signals');
    assert.equal(writeCountHours(true, storage), true);
    assert.equal(readReminderSetting(storage), 'off');
    assert.equal(readCaptionSetting(storage), 'signals');
    assert.equal(readCountHours(storage), true);
    assert.equal(storage.getItem('claudeville.sound.countHours'), '1');

    assert.equal(writeReminderSetting('shout', storage), 'standard', 'an unknown choice writes the default');
    assert.equal(writeCaptionSetting(undefined, storage), 'auto');
    assert.equal(readReminderSetting(storage), 'standard');
    assert.equal(readCaptionSetting(storage), 'auto');

    // D2: the Isle Band unless the operator picked Chip restored.
    assert.equal(readTownBandVoice(storage), 'isle');
    assert.equal(writeTownBandVoice('chip', storage), 'chip');
    assert.equal(readTownBandVoice(storage), 'chip');
    assert.equal(writeTownBandVoice('kazoo', storage), 'isle');
    storage.setItem('claudeville.sound.townBandVoice', 'console');
    assert.equal(readTownBandVoice(storage), 'isle');
});

test('settings defaults cover every sound key, with the calibration key written after the levels', () => {
    for (const [key, value] of Object.entries(SOUND_SETTING_DEFAULTS)) {
        assert.equal(PERSISTED_SETTING_DEFAULTS[key], value, key);
    }
    assert.equal(PERSISTED_SETTING_DEFAULTS['claudeville.sound.volume'], undefined, 'the legacy single step is never written again');
    assert.equal(PERSISTED_SETTING_DEFAULTS['claudeville.sound.layers'], undefined, 'the retired mix is never written again');
    assert.deepEqual(JSON.parse(PERSISTED_SETTING_DEFAULTS['claudeville.sound.volumes']),
        { signals: STANDARD_VOLUME_STEP, bgm: STANDARD_VOLUME_STEP });
    const order = Object.keys(PERSISTED_SETTING_DEFAULTS);
    assert.ok(order.indexOf('claudeville.sound.calibration') > order.indexOf('claudeville.sound.volumes'));
});

test('reset writes defaults in place without clearing unrelated local data', () => {
    const storage = new MemoryStorage({
        ...Object.fromEntries(Object.keys(PERSISTED_SETTING_DEFAULTS).map(key => [key, 'changed'])),
        'claudeville.generatedNames': '["Ada"]',
    });

    const result = resetPersistedSettings(storage);

    for (const [key, value] of Object.entries(PERSISTED_SETTING_DEFAULTS)) {
        assert.equal(storage.getItem(key), value, key);
    }
    assert.equal(storage.getItem('claudeville.generatedNames'), '["Ada"]');
    assert.equal(result.soundEnabled, false);
    assert.equal(result.soundPreset, 'off', 'a reset sets the preset to Off');
    assert.equal(result.soundBackground, 'play');
    assert.equal(result.soundOutput, 'speakers');
    assert.equal(result.soundTone, 0);
    assert.equal(result.soundSoften, 'auto');
    assert.equal(result.soundHushUntil, 0);
    assert.equal(result.soundQuietHours, 'off');
    assert.equal(result.autoCamera, true);
    assert.equal(result.soundReminders, 'standard');
    assert.equal(result.soundCountHours, false);
    assert.equal(result.captions, 'auto');
});

test('reset returns a user-changed profile to the standard step in every preset', () => {
    const storage = new MemoryStorage({
        'claudeville.sound.volumes': JSON.stringify({ signals: 9, ambient: 2, bgm: 3 }),
        'claudeville.sound.calibration': '2',
    });
    const result = resetPersistedSettings(storage);
    assert.deepEqual(result.soundVolumes, { signals: STANDARD_VOLUME_STEP, bgm: STANDARD_VOLUME_STEP });
    assert.deepEqual(JSON.parse(storage.getItem('claudeville.sound.volumes')), { signals: STANDARD_VOLUME_STEP, bgm: STANDARD_VOLUME_STEP });
    assert.equal(storage.getItem('claudeville.sound.calibration'), '2');
});

test('opening settings first dismisses both topbar popovers', () => {
    const calls = [];
    const topbar = Object.create(TopBar.prototype);
    topbar._destroyed = false;
    topbar._hideSoundPanel = () => calls.push('sound');
    topbar._hideSpendPanel = () => calls.push('spend');
    topbar._buildSettingsContent = () => ({ node: true });
    topbar.modal = {
        openContent(title, content, options) {
            calls.push(['modal', title, content, options]);
        },
    };

    topbar._openSettings();

    assert.equal(calls[0], 'sound');
    assert.equal(calls[1], 'spend');
    assert.deepEqual(calls[2], [
        'modal',
        'Settings',
        { node: true },
        { wide: true, owner: 'topbar-settings' },
    ]);
});

test('Spend Map closes settings and the SOUND popover before it becomes visible', () => {
    const previousWindow = globalThis.window;
    globalThis.window = { innerWidth: 1280 };
    try {
        const spendCalls = [];
        const spend = Object.create(TopBar.prototype);
        spend._destroyed = false;
        spend._closeSettings = () => spendCalls.push('settings');
        spend._hideSoundPanel = () => spendCalls.push('sound');
        spend._ensureSpendPanel = () => {};
        spend._renderSpendPanel = () => {};
        spend._spendPanelEl = { style: { display: 'none' } };
        spend.els = {
            rateWrap: {
                getBoundingClientRect: () => ({ left: 300, bottom: 40 }),
                setAttribute: () => {},
            },
        };
        spend._showSpendPanel();
        assert.deepEqual(spendCalls, ['settings', 'sound']);
        assert.equal(spend._spendPanelEl.style.display, 'block');
    } finally {
        globalThis.window = previousWindow;
    }
});
