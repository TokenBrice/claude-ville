import test from 'node:test';
import assert from 'node:assert/strict';

import {
    AUDIO_MIXER_DEFAULTS,
    AmbientAudioController,
    readStoredLayerLevels,
} from '../../claudeville/src/presentation/shared/AmbientAudioController.js';
import { AUDIO_GROUPS, AudioEngine } from '../../claudeville/src/presentation/shared/audio/AudioEngine.js';
import { TopBar } from '../../claudeville/src/presentation/shared/TopBar.js';

function memoryStorage(initial = {}) {
    const values = new Map(Object.entries(initial));
    return {
        getItem: key => values.has(key) ? values.get(key) : null,
        setItem: (key, value) => values.set(key, String(value)),
    };
}

function mixerHarness(storage = memoryStorage()) {
    const controller = Object.create(AmbientAudioController.prototype);
    Object.assign(controller, {
        _destroyed: false,
        layerLevels: readStoredLayerLevels(storage),
        layerControls: {},
        engine: new AudioEngine(),
    });
    return controller;
}

// Stand-in faders for a built graph: record every gain target per group.
function faderEngine(engine) {
    const faders = {};
    engine.context = { currentTime: 0 };
    engine._groups = new Map(AUDIO_GROUPS.map((name) => {
        faders[name] = [];
        return [name, { gain: { setTargetAtTime: value => faders[name].push(value) } }];
    }));
    return faders;
}

test('stored mixer levels are complete, clamped, and tolerate corrupt data', () => {
    const stored = memoryStorage({
        'claudeville.sound.layers': JSON.stringify({
            wind: 0.25,
            rain: 4,
            wildlife: -2,
            hum: '0.4',
        }),
    });
    assert.deepEqual(readStoredLayerLevels(stored), {
        wind: 0.25,
        rain: 1,
        wildlife: 0,
        hum: 0.4,
        music: 1,
    });
    assert.deepEqual(
        readStoredLayerLevels(memoryStorage({ 'claudeville.sound.layers': '{oops' })),
        { ...AUDIO_MIXER_DEFAULTS },
    );
});

test('mixer trims persist and drive the group faders on the square law', () => {
    const previousWindow = globalThis.window;
    const storage = memoryStorage();
    globalThis.window = { localStorage: storage };
    try {
        const controller = mixerHarness(storage);
        const faders = faderEngine(controller.engine);

        assert.equal(controller.setLayerLevel('wind', 0.25), true);
        assert.equal(faders.wind.at(-1), 0.0625);
        assert.equal(JSON.parse(storage.getItem('claudeville.sound.layers')).wind, 0.25);
        assert.equal(mixerHarness(storage).layerLevels.wind, 0.25);

        // Zero is a closed fader, never a negative or NaN gain.
        controller.setLayerLevel('music', 0);
        assert.ok(faders.music.at(-1) > 0 && faders.music.at(-1) <= 0.0001);
        controller.setLayerLevel('rain', 7);
        assert.equal(faders.rain.at(-1), 1);

        assert.equal(controller.setLayerLevel('unknown', 0), false);
        assert.equal(faders.hum.length, 0, 'one channel never moves another fader');
    } finally {
        if (previousWindow === undefined) delete globalThis.window;
        else globalThis.window = previousWindow;
    }
});

test('each of the five mixer channels drives the fader of its own group', () => {
    const controller = mixerHarness();
    const faders = faderEngine(controller.engine);
    controller.layerLevels = { wind: 0.5, rain: 0.4, wildlife: 0.3, hum: 0.2, music: 0.1 };
    controller._applyGroupLevels();

    assert.equal(faders.wind.at(-1), 0.25);
    assert.ok(Math.abs(faders.rain.at(-1) - 0.16) < 1e-12);
    assert.ok(Math.abs(faders.wildlife.at(-1) - 0.09) < 1e-12);
    assert.ok(Math.abs(faders.hum.at(-1) - 0.04) < 1e-12);
    assert.ok(Math.abs(faders.music.at(-1) - 0.01) < 1e-12);
});

test('a click on an armed control starts sound; only a playing control turns it off', () => {
    const controller = Object.create(AmbientAudioController.prototype);
    const requested = [];
    const director = { running: false };
    Object.assign(controller, {
        _destroyed: false,
        _gestureSeen: false,
        available: true,
        enabled: true,
        mode: 'ambient',
        engine: { context: { state: 'suspended' } },
        directors: { ambient: director, bgm: { running: false } },
        setEnabled: value => requested.push(value),
    });

    // Stored on, context not yet running (armed): the chip's toggle and an
    // unchecked SET switch both activate.
    controller.activateFromUser(!controller.enabled);
    controller.activateFromUser(false);
    assert.deepEqual(requested, [true, true]);
    assert.equal(controller.userActivated, true, 'the click is recorded as the gesture');

    controller.engine.context.state = 'running';
    director.running = true;
    controller.activateFromUser(!controller.enabled);
    assert.equal(requested.at(-1), false);

    controller.enabled = false;
    controller.activateFromUser(true);
    assert.equal(requested.at(-1), true);
});

function wakeHarness(events, { enabled = true, gestureSeen = true, owns = true } = {}) {
    const controller = Object.create(AmbientAudioController.prototype);
    Object.assign(controller, {
        _destroyed: false,
        _visibilityGeneration: 7,
        _hiddenSummonsPending: new Set(),
        _suspendTimer: null,
        _wakeToken: 0,
        _wakeHoldUntil: 0,
        _wakeCount: 0,
        _windowBlurred: true,
        background: 'signals',
        _gestureSeen: gestureSeen,
        enabled,
        available: true,
        engine: {
            now: () => 10,
            wake: async () => { events.push('wake'); return true; },
            endWake: async (until) => { events.push(['endWake', until]); return owns; },
            suspend: async () => { events.push('suspend'); },
            start: () => events.push('engine:start'),
        },
        directors: {
            ambient: { cue: (kind, payload) => events.push(`${kind}:${payload.agentId}`) },
        },
    });
    return controller;
}

async function settle() {
    await new Promise(resolve => setTimeout(resolve, 10));
}

test('a hidden-tab summons wakes the cue path, holds past the tail, then suspends', async () => {
    const events = [];
    const controller = wakeHarness(events);

    controller._handleHiddenSummons({ agentId: 'agent-hidden', audioCueKind: 'summons' });
    await settle();
    assert.equal(events[0], 'wake');
    assert.equal(events[1], 'summons:agent-hidden');
    assert.equal(events[2][0], 'endWake');
    assert.ok(events[2][1] >= 10 + 3, 'the wake holds until the bell has rung out');
    assert.equal(events[3], 'suspend');
    assert.ok(!events.includes('engine:start'), 'a wake never opens the bed');
    assert.equal(controller._wakeCount, 1);
    assert.equal(controller._hiddenSummonsPending.size, 0);
});

test('hidden urgent cues keep their bucket kind, and a superseded wake never suspends', async () => {
    const events = [];
    const controller = wakeHarness(events, { owns: false });
    controller._handleHiddenSummons({ agentId: 'agent-limit', audioCueKind: 'limit' });
    await settle();
    assert.ok(events.includes('limit:agent-limit'));
    assert.ok(!events.includes('suspend'), 'a newer start or wake owns the fade');
});

test('without a user activation a hidden summons is captioned, never woken', async () => {
    const events = [];
    const controller = wakeHarness(events, { gestureSeen: false });
    controller._handleHiddenSummons({ agentId: 'agent-quiet', audioCueKind: 'distress' });
    await settle();
    assert.deepEqual(events, ['distress:agent-quiet']);
});

test('mixer and Spend Map explicitly close one another before opening', () => {
    const classNames = new Set();
    const mixer = {
        style: { display: 'none' },
    };
    const button = {
        getBoundingClientRect: () => ({ right: 1240, bottom: 48 }),
        setAttribute() {},
        classList: {
            add: name => classNames.add(name),
            remove: name => classNames.delete(name),
        },
    };
    let spendClosed = 0;
    const previousWindow = globalThis.window;
    globalThis.window = { innerWidth: 1280 };
    try {
        TopBar.prototype._showMixerPanel.call({
            _destroyed: false,
            _mixerButtonEl: button,
            _mixerPanelEl: mixer,
            _hideSpendPanel: () => { spendClosed++; },
        });
        assert.equal(spendClosed, 1);
        assert.equal(mixer.style.display, 'block');

        let mixerClosed = 0;
        const spendPanel = { style: { display: 'none' } };
        TopBar.prototype._showSpendPanel.call({
            _destroyed: false,
            els: {
                rateWrap: {
                    getBoundingClientRect: () => ({ left: 300, bottom: 48 }),
                    setAttribute() {},
                },
            },
            _hideMixerPanel: () => { mixerClosed++; },
            _ensureSpendPanel() {},
            _renderSpendPanel() {},
            _spendPanelEl: spendPanel,
        });
        assert.equal(mixerClosed, 1);
        assert.equal(spendPanel.style.display, 'block');
    } finally {
        if (previousWindow === undefined) delete globalThis.window;
        else globalThis.window = previousWindow;
    }
});
