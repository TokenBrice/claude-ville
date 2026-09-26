import test from 'node:test';
import assert from 'node:assert/strict';

import { AmbientAudioController } from '../../claudeville/src/presentation/shared/AmbientAudioController.js';
import {
    AUDIO_MIXER_DEFAULTS,
    SOUND_RECALIBRATED_MESSAGE,
    readStoredTrimSteps,
} from '../../claudeville/src/presentation/shared/SoundSettings.js';
import { AUDIO_GROUPS, AudioEngine } from '../../claudeville/src/presentation/shared/audio/AudioEngine.js';
import { STANDARD_VOLUME_STEP, trimStepGain } from '../../claudeville/src/presentation/shared/audio/Loudness.js';
import { TopBar } from '../../claudeville/src/presentation/shared/TopBar.js';
import { eventBus } from '../../claudeville/src/domain/events/DomainEvent.js';

const CALIBRATED = { 'claudeville.sound.calibration': '2' };

function memoryStorage(initial = {}) {
    const values = new Map(Object.entries(initial));
    return {
        getItem: key => values.has(key) ? values.get(key) : null,
        setItem: (key, value) => values.set(key, String(value)),
    };
}

function mixerHarness(storage = memoryStorage(CALIBRATED)) {
    const controller = Object.create(AmbientAudioController.prototype);
    Object.assign(controller, {
        _destroyed: false,
        _windowBlurred: false,
        _quietMix: { active: false, preset: null, factors: {} },
        background: 'play',
        mode: 'ambient',
        layerSteps: readStoredTrimSteps(storage),
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

async function withWindow(win, run) {
    const previousWindow = globalThis.window;
    globalThis.window = win;
    try {
        return await run();
    } finally {
        if (previousWindow === undefined) delete globalThis.window;
        else globalThis.window = previousWindow;
    }
}

// The real controller as TopBar's idle build makes it, minus the DOM: no
// document, no controls, a Web Audio constructor that is never called.
function browserWindow(storage) {
    return {
        localStorage: storage,
        AudioContext: class {},
        addEventListener() {},
        removeEventListener() {},
    };
}

function collect(event) {
    const payloads = [];
    const unsubscribe = eventBus.on(event, payload => payloads.push(payload));
    return { payloads, unsubscribe };
}

test('stored trim steps are complete, whole, clamped, and tolerate corrupt data', () => {
    const stored = memoryStorage({
        ...CALIBRATED,
        'claudeville.sound.layers': JSON.stringify({
            wind: 3,
            rain: 14,
            wildlife: -2,
            hum: '4',
            music: 6.6,
        }),
    });
    assert.deepEqual(readStoredTrimSteps(stored), {
        wind: 3,
        rain: 10,
        wildlife: 0,
        hum: 4,
        // A channel the profile never stored reads at its own default.
        workshops: AUDIO_MIXER_DEFAULTS.workshops,
        music: 7,
    });
    assert.deepEqual(
        readStoredTrimSteps(memoryStorage({ ...CALIBRATED, 'claudeville.sound.layers': '{oops' })),
        { ...AUDIO_MIXER_DEFAULTS },
    );
});

test('trim steps follow 2.4 dB per step: unity at 10, off at 0', () => {
    assert.equal(trimStepGain(10), 1);
    assert.ok(Math.abs(20 * Math.log10(trimStepGain(9)) + 2.4) < 1e-9);
    assert.ok(Math.abs(20 * Math.log10(trimStepGain(5)) + 12) < 1e-9);
    assert.ok(Math.abs(20 * Math.log10(trimStepGain(1)) + 21.6) < 1e-9);
    assert.equal(trimStepGain(0), 0);
});

test('mixer trim steps persist and drive the group faders', async () => {
    const storage = memoryStorage(CALIBRATED);
    await withWindow({ localStorage: storage }, () => {
        const controller = mixerHarness(storage);
        const faders = faderEngine(controller.engine);

        assert.equal(controller.setLayerStep('wind', 5), true);
        assert.ok(Math.abs(faders.wind.at(-1) - 10 ** (-12 / 20)) < 1e-9);
        assert.equal(JSON.parse(storage.getItem('claudeville.sound.layers')).wind, 5);
        assert.equal(mixerHarness(storage).layerSteps.wind, 5);

        // Zero is a closed fader, never a negative or NaN gain.
        controller.setLayerStep('music', 0);
        assert.ok(faders.music.at(-1) >= 0 && faders.music.at(-1) <= 0.0001);
        controller.setLayerStep('rain', 17);
        assert.equal(faders.rain.at(-1), 1);
        assert.equal(controller.layerSteps.rain, 10);

        assert.equal(controller.setLayerStep('unknown', 0), false);
        assert.equal(faders.hum.length, 0, 'one channel never moves another fader');
    });
});

test('each of the six mixer channels drives the fader of its own group', () => {
    const controller = mixerHarness();
    const faders = faderEngine(controller.engine);
    controller.layerSteps = { wind: 10, rain: 9, wildlife: 5, hum: 1, workshops: 3, music: 0 };
    controller._applyGroupLevels();

    for (const [name, step] of Object.entries(controller.layerSteps)) {
        const gain = faders[name].at(-1);
        if (step === 0) assert.ok(gain >= 0 && gain <= 0.0001, name);
        else assert.ok(Math.abs(gain - trimStepGain(step)) < 1e-9, name);
    }
});

test('a blurred window keeps playing the D3 quiet mix of its preset; focus restores the trims', () => {
    const controller = mixerHarness();
    const faders = faderEngine(controller.engine);
    const quiet = [];
    controller.directors = { ambient: { setQuietMix: on => quiet.push(on) } };
    controller.layerSteps = { ...AUDIO_MIXER_DEFAULTS, wind: 5 };
    const heard = name => faders[name].at(-1);

    controller._windowBlurred = true;
    controller._syncQuietMix();
    assert.ok(heard('music') <= 0.0001, 'the Village music goes out');
    for (const name of ['wind', 'rain', 'wildlife', 'hum', 'workshops']) {
        assert.ok(Math.abs(heard(name) - trimStepGain(controller.layerSteps[name]) * 0.5) < 1e-9, name);
    }
    assert.deepEqual(quiet, [true], 'the workshops keep their accents only');
    assert.equal(controller.layerSteps.wind, 5, 'the stored trim is untouched');

    controller.mode = 'bgm';
    controller._syncQuietMix();
    assert.ok(Math.abs(20 * Math.log10(heard('music')) + 3) < 1e-9, 'the Town band plays on at −3 dB');
    assert.equal(heard('wind'), trimStepGain(5));
    assert.deepEqual(quiet, [true, false]);

    controller.mode = 'ambient';
    controller._windowBlurred = false;
    controller._syncQuietMix();
    for (const [name, step] of Object.entries(controller.layerSteps)) {
        assert.ok(Math.abs(heard(name) - Math.max(0.0001, trimStepGain(step))) < 1e-9, name);
    }

    // "Signals only" pauses a blurred window instead: no quiet mix.
    controller.background = 'signals';
    controller._windowBlurred = true;
    controller._syncQuietMix();
    assert.equal(controller._quietMix.active, false);
    assert.equal(heard('music'), 1);
});

test('a legacy profile loads once at the standard step, captions once, then keeps user changes', async () => {
    const storage = memoryStorage({
        'claudeville.sound.volume': '0.8',
        'claudeville.sound.layers': JSON.stringify({ wind: 0.2, rain: 1, wildlife: 0.5, hum: 0, music: 0.9 }),
        'claudeville.sound.mode': 'bgm',
    });
    const captions = collect('audio:recalibrated');
    try {
        await withWindow(browserWindow(storage), async () => {
            const first = new AmbientAudioController();
            assert.equal(first.volumeStep, STANDARD_VOLUME_STEP);
            assert.deepEqual(first.layerSteps, { ...AUDIO_MIXER_DEFAULTS });
            assert.equal(first.engine.volumeStep, STANDARD_VOLUME_STEP);
            assert.equal(storage.getItem('claudeville.sound.volume'), String(STANDARD_VOLUME_STEP));
            assert.equal(storage.getItem('claudeville.sound.calibration'), '2');
            assert.equal(first.mode, 'bgm', 'only levels are recalibrated');
            assert.deepEqual(captions.payloads, [{ message: SOUND_RECALIBRATED_MESSAGE }]);

            first.setVolumeStep(3);
            first.setLayerStep('wind', 4);
            await first.destroy();

            const second = new AmbientAudioController();
            assert.equal(second.volumeStep, 3);
            assert.equal(second.layerSteps.wind, 4);
            assert.equal(captions.payloads.length, 1, 'the recalibration captions once');
            await second.destroy();
        });
    } finally {
        captions.unsubscribe();
    }
});

test('a fresh profile is marked calibrated without a recalibration caption', async () => {
    const storage = memoryStorage();
    const captions = collect('audio:recalibrated');
    try {
        await withWindow(browserWindow(storage), async () => {
            const controller = new AmbientAudioController();
            assert.equal(controller.volumeStep, STANDARD_VOLUME_STEP);
            assert.equal(storage.getItem('claudeville.sound.calibration'), '2');
            assert.equal(captions.payloads.length, 0);
            await controller.destroy();
        });
    } finally {
        captions.unsubscribe();
    }
});

test('one shared governor: an agent summoned before a mode switch is not summoned again after it', async () => {
    const storage = memoryStorage(CALIBRATED);
    const played = collect('audio:cue-played');
    try {
        await withWindow(browserWindow(storage), async () => {
            const controller = new AmbientAudioController();
            assert.equal(controller.directors.ambient.cue('summons', { agentId: 'ada' }), true);
            controller.setMode('bgm');
            // The town band's player needs a live AudioContext; marking the
            // director playing reaches the cue route it uses while it plays.
            const bgm = controller.directors.bgm;
            bgm.running = true;
            assert.equal(bgm.cue('summons', { agentId: 'ada' }), false,
                'the 45 s summons cooldown survives the switch');
            assert.equal(bgm.cue('summons', { agentId: 'bo' }), true,
                'the town band still rings for another agent');
            bgm.running = false;
            assert.deepEqual(played.payloads.map(cue => `${cue.kind}:${cue.agentId}`), ['summons:ada', 'summons:bo']);
            await controller.destroy();
        });
    } finally {
        played.unsubscribe();
    }
});

function crossfadeHarness() {
    const log = [];
    const director = (id) => ({
        running: false,
        start() { this.running = true; log.push(`${id}:start`); },
        stop() { this.running = false; log.push(`${id}:stop`); },
        setSignalRouting(on) { this.signals = on; },
    });
    const controller = Object.create(AmbientAudioController.prototype);
    Object.assign(controller, {
        _destroyed: false,
        _windowBlurred: false,
        _quietMix: { active: false, preset: null, factors: {} },
        _crossfadeStops: new Map(),
        background: 'play',
        enabled: true,
        mode: 'ambient',
        layerControls: {},
        layerSteps: { ...AUDIO_MIXER_DEFAULTS },
        directors: { ambient: director('ambient'), bgm: director('bgm') },
        engine: {
            now: () => 0,
            // A 10 ms fade keeps the test fast; the controller waits for the
            // end time the engine reports, whatever the duration.
            fadeDirector: (id, to, { duration }) => {
                log.push(`${id}->${to}@${duration}`);
                return 0.01;
            },
        },
    });
    controller.directors.ambient.running = true;
    return { controller, log };
}

test('a mode switch crossfades, and switching back before the fade ends keeps the returning director', async () => {
    const { controller, log } = crossfadeHarness();
    const { ambient, bgm } = controller.directors;

    controller.setMode('bgm');
    assert.deepEqual(log, ['bgm->0@0', 'bgm:start', 'bgm->1@2.5', 'ambient->0@2.5']);
    assert.equal(ambient.running, true, 'the outgoing director plays through the fade');
    assert.equal(ambient.signals, false, 'the town band owns the signals from the switch');

    log.length = 0;
    controller.setMode('ambient');
    assert.deepEqual(log, ['ambient->1@2.5', 'bgm->0@2.5'], 'a fading director turns around, never restarts');

    await new Promise(resolve => setTimeout(resolve, 120));
    assert.equal(ambient.running, true, 'the returning director is never stopped by the earlier fade');
    assert.equal(bgm.running, false, 'the outgoing director stops once faded');
    assert.deepEqual(log.slice(2), ['bgm:stop']);
    assert.equal(ambient.signals, true);
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
