import test from 'node:test';
import assert from 'node:assert/strict';

import { AmbientAudioController } from '../../claudeville/src/presentation/shared/AmbientAudioController.js';
import { SOUND_RECALIBRATED_MESSAGE } from '../../claudeville/src/presentation/shared/SoundSettings.js';
import { AudioEngine } from '../../claudeville/src/presentation/shared/audio/AudioEngine.js';
import { STANDARD_VOLUME_STEP } from '../../claudeville/src/presentation/shared/audio/Loudness.js';
import { eventBus } from '../../claudeville/src/domain/events/DomainEvent.js';

const CALIBRATED = { 'claudeville.sound.calibration': '2' };

function memoryStorage(initial = {}) {
    const values = new Map(Object.entries(initial));
    return {
        getItem: key => values.has(key) ? values.get(key) : null,
        setItem: (key, value) => values.set(key, String(value)),
    };
}

function mixerHarness() {
    const controller = Object.create(AmbientAudioController.prototype);
    Object.assign(controller, {
        _destroyed: false,
        _windowBlurred: false,
        _quietMix: { active: false, preset: null },
        background: 'play',
        mode: 'bgm',
        enabled: true,
        hushedUntil: 0,
        _quietActive: false,
        engine: new AudioEngine(),
        _publishView() {},
    });
    return controller;
}

// A stand-in fader for a built graph: record every music gain target.
function faderEngine(engine) {
    const music = [];
    engine.context = { currentTime: 0 };
    engine._groups = new Map([['music', { gain: { setTargetAtTime: value => music.push(value) } }]]);
    return music;
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

test('a blurred Town band keeps playing at −3 dB with its bed compensated; focus restores it', () => {
    const controller = mixerHarness();
    const music = faderEngine(controller.engine);
    const bedDb = () => controller.engine._bedComp.to;

    controller._windowBlurred = true;
    controller._syncQuietMix();
    assert.ok(Math.abs(20 * Math.log10(music.at(-1)) + 3) < 1e-9, 'the Town band plays on at −3 dB');
    assert.equal(bedDb(), 3, 'cues level against the full band');

    // Signals has no bed: the fader and the bed reading stay whole.
    controller.mode = 'signals';
    controller._syncQuietMix();
    assert.equal(music.at(-1), 1);
    assert.equal(bedDb(), 0);

    controller.mode = 'bgm';
    controller._syncQuietMix();
    controller._windowBlurred = false;
    controller._syncQuietMix();
    assert.equal(music.at(-1), 1);
    assert.equal(bedDb(), 0);

    // "Signals only" pauses a blurred window instead: no quiet mix.
    controller.background = 'signals';
    controller._windowBlurred = true;
    controller._syncQuietMix();
    assert.equal(controller._quietMix.active, false);
    assert.equal(music.at(-1), 1);
});

test('a legacy profile loads once at the standard step, captions once, then keeps user changes', async () => {
    const storage = memoryStorage({
        'claudeville.sound.volume': '0.8',
        'claudeville.sound.mode': 'bgm',
    });
    const captions = collect('audio:recalibrated');
    try {
        await withWindow(browserWindow(storage), async () => {
            const first = new AmbientAudioController();
            assert.equal(first.volumeStep, STANDARD_VOLUME_STEP);
            assert.equal(first.engine.volumeStep, STANDARD_VOLUME_STEP);
            assert.equal(JSON.parse(storage.getItem('claudeville.sound.volumes')).bgm, STANDARD_VOLUME_STEP);
            assert.equal(storage.getItem('claudeville.sound.calibration'), '2');
            assert.equal(first.mode, 'bgm', 'only levels are recalibrated');
            assert.deepEqual(captions.payloads, [{ message: SOUND_RECALIBRATED_MESSAGE }]);

            // The Town band's own step (7.8).
            first.setVolumeStep(3);
            await first.destroy();

            const second = new AmbientAudioController();
            assert.equal(second.volumeStep, 3);
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

test('one shared governor: an agent summoned by one director is not summoned again by the other', async () => {
    const storage = memoryStorage(CALIBRATED);
    const played = collect('audio:cue-played');
    try {
        await withWindow(browserWindow(storage), async () => {
            const controller = new AmbientAudioController();
            assert.equal(controller.directors.signals.cue('summons', { agentId: 'ada' }), true);
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

test('the Town band line names the piece and its players, one name when they read alike', () => {
    const controller = Object.create(AmbientAudioController.prototype);
    const player = { nowPlaying: null };
    Object.assign(controller, { _playingMode: 'bgm', directors: { bgm: { player } } });
    const line = (nowPlaying) => {
        player.nowPlaying = nowPlaying;
        return controller._nowLine('playing');
    };
    assert.equal(line(null), 'Now · between tunes');
    assert.equal(line({ piece: 'paintedIsle', title: 'The Painted Isle', lead: 'whistle', counter: 'upright' }),
        'Now · The Painted Isle · whistle & bass');
    assert.equal(line({ piece: 'paintedIsle', title: 'The Painted Isle', lead: 'harp', counter: 'harp' }),
        'Now · The Painted Isle · harp');
    assert.equal(line({ piece: 'paintedIsle', title: 'The Painted Isle', lead: 'chipPulse25', counter: 'chipPulse12' }),
        'Now · The Painted Isle · chip pulse');
    assert.equal(line({ piece: 'paintedIsle', title: 'The Painted Isle' }), 'Now · The Painted Isle');

    controller._playingMode = 'signals';
    assert.equal(controller._nowLine('playing'), 'Listening for agents that need you');
});

function crossfadeHarness({ mode = 'signals' } = {}) {
    const log = [];
    const director = (id) => ({
        running: false,
        paused: false,
        start() { this.running = true; log.push(`${id}:start`); },
        stop() { this.running = false; log.push(`${id}:stop`); },
        setSignalRouting(on) { this.signals = on; },
    });
    const controller = Object.create(AmbientAudioController.prototype);
    Object.assign(controller, {
        _destroyed: false,
        _windowBlurred: false,
        _quietMix: { active: false, preset: null },
        _crossfadeStops: new Map(),
        _playingMode: mode,
        _quietActive: false,
        hushedUntil: 0,
        available: true,
        background: 'play',
        enabled: true,
        mode,
        volumeStep: STANDARD_VOLUME_STEP,
        directors: { signals: director('signals'), bgm: director('bgm') },
        engine: {
            context: { state: 'running' },
            now: () => 0,
            setVolumeStep() {},
            setGroupLevel() {},
            setBedCompensation() {},
            // A 10 ms fade keeps the test fast; the controller waits for the
            // end time the engine reports, whatever the duration.
            fadeDirector: (id, to, { duration }) => {
                log.push(`${id}->${to}@${duration}`);
                return 0.01;
            },
        },
        _publishView() {},
        _emitBellState() {},
    });
    controller.directors[mode === 'bgm' ? 'bgm' : 'signals'].running = true;
    return { controller, log };
}

test('a preset switch crossfades over 0.8 s, and switching back before the fade ends keeps the returning director', async () => {
    const { controller, log } = crossfadeHarness();
    const { signals, bgm } = controller.directors;

    controller.setPreset('townBand');
    assert.deepEqual(log, ['bgm->0@0', 'bgm:start', 'bgm->1@0.8', 'signals->0@0.8']);
    assert.equal(signals.running, true, 'the outgoing director plays through the fade');
    assert.equal(signals.signals, false, 'the town band owns the signals from the switch');

    log.length = 0;
    controller.setPreset('signals');
    assert.deepEqual(log, ['signals->1@0.8', 'bgm->0@0.8'], 'a fading director turns around, never restarts');

    await new Promise(resolve => setTimeout(resolve, 120));
    assert.equal(signals.running, true, 'the returning director is never stopped by the earlier fade');
    assert.equal(bgm.running, false, 'the outgoing director stops once faded');
    assert.deepEqual(log.slice(2), ['bgm:stop']);
    assert.equal(signals.signals, true);
});

test('a hush drops the Town band to Signals and its end brings the band back; the preset never changes', async () => {
    const { controller, log } = crossfadeHarness({ mode: 'bgm' });
    const { signals, bgm } = controller.directors;

    controller.hush(60_000);
    assert.equal(controller.preset, 'townBand');
    assert.equal(controller._effectiveMode(), 'signals');
    assert.deepEqual(log, ['signals->0@0', 'signals:start', 'signals->1@0.8', 'bgm->0@0.8']);
    await new Promise(resolve => setTimeout(resolve, 120));
    assert.equal(bgm.running, false);
    assert.equal(signals.signals, true, 'Signals owns the route while hushed');

    log.length = 0;
    controller.resumeFromHush();
    assert.equal(controller._effectiveMode(), 'bgm');
    assert.deepEqual(log, ['bgm->0@0', 'bgm:start', 'bgm->1@0.8', 'signals->0@0.8']);
    assert.equal(signals.signals, false);
});

test('a click on an armed control starts sound; only a sounding control turns it off', () => {
    const controller = Object.create(AmbientAudioController.prototype);
    const calls = [];
    const director = { running: false, paused: false };
    Object.assign(controller, {
        _destroyed: false,
        _gestureSeen: false,
        _windowBlurred: false,
        _playingMode: null,
        _quietActive: false,
        hushedUntil: 0,
        available: true,
        enabled: true,
        mode: 'signals',
        engine: { context: { state: 'suspended' } },
        directors: { signals: director, bgm: { running: false } },
        _startActivation: () => calls.push('start'),
        setPreset: (preset, options) => calls.push(`${preset}:${options.fromUser}`),
    });

    // Stored on, context not yet running (armed): the chip starts it.
    controller.toggleFromUser();
    assert.deepEqual(calls, ['start']);
    assert.equal(controller.userActivated, true, 'the click is recorded as the gesture');

    controller.engine.context.state = 'running';
    director.running = true;
    controller.toggleFromUser();
    assert.equal(calls.at(-1), 'off:true');

    controller.enabled = false;
    controller.toggleFromUser();
    assert.equal(calls.at(-1), 'signals:true', 'off turns on the last preset');
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
            signals: { cue: (kind, payload) => events.push(`${kind}:${payload.agentId}`) },
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
