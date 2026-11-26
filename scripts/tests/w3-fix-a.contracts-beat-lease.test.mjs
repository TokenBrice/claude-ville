import test from 'node:test';
import assert from 'node:assert/strict';
import gitEvents from '../../claudeville/adapters/gitEvents.js';
import { eventBus } from '../../claudeville/src/domain/events/DomainEvent.js';
import { VERIFIED_OUTCOME_EVENT } from '../../claudeville/src/domain/services/VerifiedOutcome.js';
import { ChronicleStore } from '../../claudeville/src/infrastructure/ChronicleStore.js';
import { ChronicleLog, chronicleDateKey, hasCoverageQuarter, quarterIndexForTime } from '../../claudeville/src/application/ChronicleLog.js';
import { ART_RAMPS } from '../../claudeville/src/config/artPalette.js';
import { AmbientAudioController } from '../../claudeville/src/presentation/shared/AmbientAudioController.js';
import { Camera } from '../../claudeville/src/presentation/character-mode/Camera.js';
import { BuildingSprite } from '../../claudeville/src/presentation/character-mode/BuildingSprite.js';
import { RoomGlass } from '../../claudeville/src/presentation/character-mode/RoomGlass.js';
import { partCutFor } from '../../claudeville/src/presentation/character-mode/EmitterCuts.js';
import { HarborTraffic } from '../../claudeville/src/presentation/character-mode/HarborTraffic.js';
import { admitRoutineStatusArc, stillWorkState } from '../../claudeville/src/presentation/character-mode/MarkGovernor.js';
import { AtmosphereState, resolveFreezingState } from '../../claudeville/src/presentation/character-mode/AtmosphereState.js';
import { setRestSeatVisualBeat, tankardLift, tankardSipStep } from '../../claudeville/src/presentation/character-mode/RestSeats.js';

function browserGlobal(t, name, value) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
    t.after(() => {
        if (previous) Object.defineProperty(globalThis, name, previous);
        else delete globalThis[name];
    });
}

test('Off → Town Band → hush → resume publishes one callback and event per beat identity', async t => {
    const callbacks = [];
    const events = [];
    const audio = new AmbientAudioController({ onVisualBeatChange: beat => callbacks.push(beat) });

    t.after(eventBus.on('audio:visual-beat', ({ beat }) => events.push(beat)));
    const player = { preset: 'townBand', observe: () => () => {} };
    audio.available = true;
    // Supply just the sounding clock and director. The controller owns the actual transitions.
    t.mock.method(audio, 'soundView', () => ({}));
    t.mock.method(audio, '_startActivation', () => {});
    t.mock.method(audio, '_applyEffectiveMode', () => {});
    t.mock.method(audio.engine.musicClock, 'playing', () => true);
    t.mock.method(audio.engine, 'now', () => 1);
    audio.engine.context = { currentTime: 1, state: 'running' };
    const band = audio.directors.bgm;
    band.player = player;
    band.running = true;
    t.after(() => {
        band.player = null;
        band.running = false;
        audio.engine.context = null;
        return audio.destroy();
    });
    assert.equal(audio.getVisualBeat(), null);
    audio.setPreset('townBand', { fromUser: true });
    const first = audio.getVisualBeat();
    assert.ok(first?.active());
    audio._publishView();
    audio.hush(60_000);
    assert.equal(first.active(), false);
    assert.equal(audio.getVisualBeat(), null);
    audio.resumeFromHush();
    const second = audio.getVisualBeat();
    assert.ok(second?.active());
    assert.notEqual(first, second);
    audio._setVisualBeat(null);
    assert.deepEqual(callbacks, [first, null, second, null]);
    assert.deepEqual(events, callbacks);
});

test('World return reads the current audio identity and the Chronicle reads the phase illumination and snow', async t => {
    browserGlobal(t, 'window', Object.assign(new EventTarget(), { location: { origin: 'http://localhost' } }));
    const { App, chronicleSkyCode } = await import('../../claudeville/src/presentation/App.js');
    browserGlobal(t, 'document', { getElementById: () => ({ dataset: {} }) });
    const received = [];
    let current = {};
    const app = Object.assign(Object.create(App.prototype), {
        renderer: { setVisualBeat: beat => received.push(beat) },
        topBar: { audio: { getVisualBeat: () => current } }, _eventUnsubscribers: [],
    });
    app._initWorldReveal();
    t.after(() => app._eventUnsubscribers.forEach(unsubscribe => unsubscribe()));
    eventBus.emit('mode:changed', 'dashboard');
    eventBus.emit('mode:changed', 'character');
    current = null;
    eventBus.emit('mode:changed', 'character');
    assert.deepEqual(received, [{}, null]);
    const snapshot = { effectiveDate: new Date(2026, 0, 10), weather: { type: 'rain' },
        sky: { moon: { phase: { illumination: 0.95 }, illumination: 0 } } };
    assert.deepEqual(chronicleSkyCode(snapshot), { cloud: 0, rain: 1, snow: 1, moon: 3 });
    delete snapshot.sky.moon.phase;
    snapshot.sky.moon.illumination = 0.6;
    snapshot.weather.frozen = false;
    assert.deepEqual(chronicleSkyCode(snapshot), { cloud: 0, rain: 1, snow: 0, moon: 2 });
});

// Each transaction drains all its requests before the next tab runs, as IndexedDB does.
function metaDatabase() {
    const rows = new Map();
    return { transaction() {
        const reads = [];
        const store = {
            get(key) {
                const req = {};
                reads.push(() => { req.result = rows.get(key); req.onsuccess?.(); });
                return req;
            },
            put: row => rows.set(row.key, row),
            delete: key => rows.delete(key),
        };
        const tx = { objectStore: () => store };
        setImmediate(() => {
            for (const read of reads) read();
            tx.oncomplete?.();
        });
        return tx;
    } };
}

test('trail and metadata coexist, and the losing tab retries sky only after it can write', async t => {
    const storage = new Map();
    browserGlobal(t, 'localStorage', {
        getItem: key => storage.get(key), setItem: (k, v) => storage.set(k, v), removeItem: k => storage.delete(k),
    });
    const [a, b] = [new ChronicleStore(), new ChronicleStore()];
    t.after(() => { a.close(); b.close(); });
    a.db = b.db = metaDatabase();
    const trail = a.acquireCaptureLease();
    assert.equal(trail.acquired, true);
    assert.equal(b.acquireCaptureLease().acquired, false);
    const date = new Date(2026, 0, 26, 6, 15);
    t.mock.method(Date, 'now', () => +date);
    const day = chronicleDateKey(+date);
    const sky = { cloud: 2, rain: 1, snow: 1, moon: 0 };
    const callbacks = [];
    t.mock.method(globalThis, 'setInterval', fn => { callbacks.push(fn); return { unref() {} }; });
    const writer = new ChronicleLog({ store: a, skyProvider: () => sky });
    const other = new ChronicleLog({ store: b, skyProvider: () => ({ ...sky, moon: 3 }) });
    writer.startMetaSampling();
    other.startMetaSampling();
    await Promise.all([writer._metaSample, other._metaSample]);
    assert.ok(hasCoverageQuarter(await a.getDayCoverage(day), quarterIndexForTime(+date)));
    assert.deepEqual((await a.getDaySky(day))[6], sky);
    assert.ok(writer._lastSkyHourKey);
    assert.equal(other._lastSkyHourKey, null);
    assert.equal(await b.markCoverageQuarter(day, 75), null);
    assert.equal(hasCoverageQuarter(await b.getDayCoverage(day), 75), false);
    assert.equal(trail.renew(), true);
    await writer.stopMetaSampling();
    const failure = t.mock.method(b, 'recordSkyHour', async () => { throw Error('interrupted write'); });
    await callbacks[1]();
    assert.equal(other._lastSkyHourKey, null);
    failure.mock.restore();
    await callbacks[1]();
    assert.ok(other._lastSkyHourKey);
    assert.equal((await b.getDaySky(day))[6].moon, 3);
    await other.stopMetaSampling();
    trail.release();
});

test('raw git and nearby verified release notifications write one row per project and agent', async () => {
    const rows = [];
    const store = { queryRange: async () => rows, put: async (_, row) => rows.push(row) };
    const log = new ChronicleLog({ store }).start();
    const at = Date.now() - 120_000;
    const release = { kind: 'release', project: '/src/game', agentId: 'worker', at };
    const emit = extra => eventBus.emit(VERIFIED_OUTCOME_EVENT, { ...release, ...extra });
    try {
        log._noteGitEvents({ id: 'worker', projectPath: release.project,
            gitEvents: [{ id: 'release-1', type: 'release', success: true, completedAt: at }] });
        emit({});
        emit({ at: at + 5000 });
        emit({ at: at + 65_000 });
        emit({ project: '/other/game' });
        emit({ agentId: 'other' });
        await log.flush();
        assert.equal(rows.length, 4);
        assert.ok(rows.every(row => row.kind === 'release'));
    } finally { await log.stop(); }
    const reloaded = new ChronicleLog({ store }).start();
    try {
        emit({ at: at + 2000 });
        await reloaded.flush();
        assert.equal(rows.length, 4);
    } finally { await reloaded.stop(); }
});

test('provider shell aliases receive unconditional watching arcs after 60 seconds', () => {
    for (const tool of ['Bash', 'bash', 'exec_command', 'functions.exec_command', 'run_shell_command', 'command_execution']) {
        const agent = { status: 'working', pendingTool: tool, pendingSince: 0 };
        assert.equal(stillWorkState(agent, 59_999), null);
        const state = stillWorkState(agent, 60_000);
        assert.equal(state?.kind, 'watching', tool);
        assert.equal(admitRoutineStatusArc(null, 'working', 0, 0, state).unconditional, true);
    }
    assert.equal(stillWorkState({ status: 'working', pendingTool: 'Read', pendingSince: 0 }, 60_000), null);
});

test('formatted checks commands keep exit zero unknown', () => {
    const outcome = args => gitEvents.parseGitEventsFromCommand('gh pr checks 18 ' + args,
        { exitCode: 0, exitCodeSource: 'exit' })[0].outcome;
    for (const args of ['--json state', '--jq .', '--template=x', '-q .', '-tx']) {
        assert.equal(outcome(args), 'unknown', args);
    }
    assert.equal(outcome('--repo example/demo'), 'pass');
});

test('Harbor reconciliation ignores initial and delayed backfill and flashes once for a live pass', () => {
    const harbor = new HarborTraffic();
    const at = Date.now();
    const pass = (id, ts) => ({ id, type: 'checks', project: '/src/game', outcome: 'pass', ts });
    const events = [pass('cold', at - 2000)];
    const reconcile = ts => harbor.reconcile([{ id: 'a', gitEvents: [...events] }], ts);
    harbor.reconcile([], at - 3000);
    reconcile(at);
    assert.equal(harbor.consumeChecksPassFlash(), false);
    events.push(pass('late-history', at - 1000));
    reconcile(at + 1000);
    assert.equal(harbor.consumeChecksPassFlash(), false);
    events.push(pass('live', at + 2000));
    reconcile(at + 2000);
    assert.equal(harbor.consumeChecksPassFlash(), true);
    reconcile(at + 3000);
    assert.equal(harbor.consumeChecksPassFlash(), false);
});

test('watchtower paints one palette peak on the next daytime frame even after a long draw gap', () => {
    const marks = [];
    const tower = Object.assign(Object.create(BuildingSprite.prototype), {
        motionScale: 1, atmosphereState: { clock: { minuteOfDay: 720 } },
        _fillPixelCircle: ctx => marks.push(ctx.fillStyle),
    });
    const ctx = { save() {}, restore() {} };
    tower.triggerWatchtowerChecksFlash(0);
    tower._drawWatchtowerFire(ctx, { x: 4, y: 5 });
    tower._drawWatchtowerFire(ctx, { x: 4, y: 5 });
    tower.motionScale = 0;
    tower.triggerWatchtowerChecksFlash();
    tower._drawWatchtowerFire(ctx, { x: 4, y: 5 });
    assert.deepEqual(marks, [ART_RAMPS.beaconFire[6]]);
});

function canvas() {
    let pixels;
    const ctx = {
        createImageData: (width, height) => ({ width, height, data: new Uint8ClampedArray(width * height * 4) }),
        putImageData(image) { pixels = image.data; },
        getImageData() { return { data: pixels.slice() }; },
        drawImage(image) { pixels = image.data; },
        clearRect() { pixels = null; },
    };
    return { getContext: () => ctx, get data() { return pixels; } };
}

test('emitter part revisions, blank poses and grade changes reuse both backing canvases', t => {
    browserGlobal(t, 'document', { createElement: canvas });
    const image = { width: 1, height: 1, data: Uint8Array.of(100, 60, 10, 255) };
    const channels = { key: 'pose:0', emissive: { ...image, data: Uint8Array.of(255, 128, 32, 255) } };
    const buildings = { partChannelsFor: () => channels };
    const part = { id: 'forge.glass', textureKey: 'strip-0', image };
    const cut = () => partCutFor({}, buildings, { id: 'forge' }, part);
    const first = cut();
    assert.equal(cut(), first);
    channels.key = 'pose:1';
    channels.emissive.data[3] = 0;
    assert.equal(cut(), null);
    part.textureKey = 'strip-2';
    channels.emissive.data[3] = 200;
    const next = cut();
    assert.equal(next.canvas, first.canvas);
    assert.equal(next.bloom, first.bloom);
    const graded = partCutFor({}, buildings, { id: 'forge' }, part, { poolGain: 1.2 });
    assert.notEqual(graded, next);
    assert.equal(graded.canvas, first.canvas);
    assert.equal(graded.bloom, first.bloom);
});

test('both Forge paths quantize night share first, then apply the smith’s 0.75 dip', t => {
    browserGlobal(t, 'document', { createElement: canvas });
    const pixels = Uint8Array.of(80, 60, 40, 255);
    const glass = new RoomGlass(null);
    glass._maps.set('forge', { w: 1, h: 1, spriteWidth: 1, top: 0, left: 0, group: [1],
        rooms: 1, albedo: pixels, emissive: pixels });
    const renderer = Object.assign(Object.create(BuildingSprite.prototype), {
        roomGlass: glass, _nightWindowGate: () => 1, _roomUnderOpenAperture: () => false,
        _roomLitByType: new Map([['forge', [1]]]), _roomShadowState: new Map([['forge', { dips: new Set([0]) }]]),
        _emissiveGateFor: () => 1, roomGate: () => renderer._roomLitByType.get('forge')[0],
    });
    for (const [raw, stepped] of [[1, 1], [0.64, 0.6]]) {
        renderer._roomLitByType.get('forge')[0] = raw;
        renderer._emissiveGateFor = () => 1;
        assert.equal(renderer.glassPatchFor({ type: 'forge' }).canvas.data[3], Math.round(255 * (1 - stepped * 0.75)));
        renderer._emissiveGateFor = () => 0;
        assert.equal(renderer._roomGlassLitPart({ type: 'forge' }).image.data[3], Math.round(255 * stepped * 0.75));
    }
});

test('shadow rest zoom follows the destination throughout a glide, then the actual zoom', () => {
    const camera = Object.assign(Object.create(Camera.prototype), { zoom: 1.7, _zoomAnimation: { toZoom: 2 } });
    const building = Object.assign(Object.create(BuildingSprite.prototype), { camera });
    for (const [target, expected] of [[2, 2], [1, 1], [NaN, 1.7]]) {
        camera._zoomAnimation.toZoom = target;
        assert.equal(camera.restZoomTarget, expected);
        assert.equal(building._shadowRestZoom(), expected);
    }
    camera._zoomAnimation = null;
    assert.equal(camera.restZoomTarget, 1.7);
});

test('modeled snow and frost or snowy night/dawn drive breath until measured temperature is available', () => {
    const date = new Date(2026, 0, 15, 6);
    const rain = { date, weather: { type: 'rain', precipitation: 1 } };
    assert.equal(resolveFreezingState(null, false, false, rain), true);
    assert.equal(resolveFreezingState(null, false, false, { ...rain, date: new Date(2026, 6, 2) }), false);
    assert.equal(resolveFreezingState(null, false, false, { date, weather: { type: 'clear' }, frost: 2 }), true);
    for (const [phase, expected] of [['night', true], ['dawn', true], ['day', false]]) {
        assert.equal(resolveFreezingState(null, true, false, { date, frost: 0, snowCover: 0.1, phase }), expected);
    }
    for (const [temp, previous, expected] of [[0, false, true], [0.5, true, true], [0.5, false, false], [1, true, false]]) {
        assert.equal(resolveFreezingState(temp, previous, true, rain), expected);
    }
    const state = new AtmosphereState({ nowProvider: () => date });
    const snow = state.setWeather('rain').weather;
    assert.equal(snow.frozen, true);
    assert.equal(snow.freezing, true);
});

test('a nearby cadence moves the same seeded sip onset across the period boundary for both lift and pose', t => {
    let onset = Math.ceil(performance.timeOrigin);
    while (tankardSipStep('innkeeper', onset - 1) !== -1 || tankardSipStep('innkeeper', onset) !== 0) onset++;
    let calls = 0;
    const beat = { active: () => true, cadenceNear(ms, window) {
        calls++;
        assert.equal(window, 1000);
        assert.equal(ms, onset - performance.timeOrigin);
        return ms - 500;
    } };
    const now = onset - 340;
    assert.equal(tankardSipStep('innkeeper', now, true, null), -1);
    assert.equal(tankardSipStep('innkeeper', now, true, beat), 1);
    assert.equal(calls, 1);
    setRestSeatVisualBeat(beat);
    t.after(() => setRestSeatVisualBeat(null));
    assert.equal(tankardLift('innkeeper', now), 3);
    assert.equal(calls, 2);
    beat.active = () => false;
    assert.equal(tankardLift('innkeeper', now), 0);
    assert.equal(tankardSipStep('innkeeper', onset), 0);
    assert.equal(tankardSipStep('innkeeper', onset, false), -1);
    assert.equal(calls, 2);
});
