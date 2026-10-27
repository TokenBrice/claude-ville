import test from 'node:test';
import assert from 'node:assert/strict';
import { IsometricRenderer } from '../../claudeville/src/presentation/character-mode/IsometricRenderer.js';
import { createMotionClock, SPEED_RUNGS } from '../../claudeville/src/presentation/character-mode/MotionClock.js';
import { defineMoment, momentPhase } from '../../claudeville/src/presentation/character-mode/EffectStamps.js';
import { FRAME_PACING_INTERVAL_MS, createFramePacing } from '../../claudeville/src/presentation/character-mode/FramePacing.js';

function fixture() {
    return Object.assign(Object.create(IsometricRenderer.prototype), {
        running: true, _worldModeActive: true, _contextLost: false,
        _worldResourceGeneration: 0,
        _lastFrameTime: null, _lastLoopFrameTime: null, _framePacing: createFramePacing(),
        _motionClock: createMotionClock(), motionScale: 0,
        _frameFailureStats: { paused: false, consecutive: 2 },
        _fallbackPrep: null, _worldSwap: null, _performanceSamples: [],
        updates: 0, paints: 0, fpsTicks: 0, envelopes: [], scheduled: 0, signals: 0,
        _fallBackFromWebGpu() {}, _canSkipIdleFrame() { return true; },
        _update() { this.updates++; }, _render() { this.paints++; },
        _recordPerformanceSample() {},
        _recordFrameEnvelope(...args) { this.envelopes.push(args); },
        _trackFps() { this.fpsTicks++; },
        _recordFrameSuccess() { this._frameFailureStats.consecutive = 0; },
        _signalFirstFrame() { this.signals++; },
        _stepFallbackPrep() {},
        _startLoop() { this.scheduled++; },
        _reportFrameFailure(error) { throw error; },
    });
}

test('idle output reuse still updates logical state, FPS, envelope, and failure recovery', () => {
    const renderer = fixture();
    renderer._loop(100);
    assert.equal(renderer.updates, 1, 'retained pixels do not suspend simulation');
    assert.equal(renderer.paints, 0);
    assert.equal(renderer.fpsTicks, 1);
    assert.equal(renderer.envelopes[0][4], null);
    assert.equal(renderer._frameFailureStats.consecutive, 0);
});

test('GPU frames must stage exact inputs rather than use the coarse tableau idle shortcut', () => {
    const renderer = fixture();
    delete renderer._canSkipIdleFrame;
    renderer._idleFrameDirty = false;
    renderer.gpuWorld = { isActive: () => true };
    assert.equal(renderer._canSkipIdleFrame(), false);
});

for (const key of ['_firstFrameReason', '_revealSnapshotPending', '_idleFrameDirty', '_forceFreshGpuOutput', '_worldSwap', '_contextLost']) {
    test(`${key} always requires fresh GPU output`, () => {
        const renderer = fixture();
        renderer._idleFrameDirty = false;
        assert.equal(renderer._requiresFreshGpuOutput(), false);
        renderer[key] = true;
        assert.equal(renderer._requiresFreshGpuOutput(), true);
    });
}

test('pending GPU queries require a fresh output independently of logical motion', () => {
    const renderer = fixture();
    renderer._idleFrameDirty = false;
    let pending = false;
    renderer.gpuWorld = { hasPendingGpuQueries: () => pending };
    assert.equal(renderer._requiresFreshGpuOutput(), false);
    assert.equal(renderer._pendingIdleResourceWork(), false);
    pending = true;
    assert.equal(renderer._requiresFreshGpuOutput(), true);
    assert.equal(renderer._pendingIdleResourceWork(), true);
    pending = false;
    assert.equal(renderer._requiresFreshGpuOutput(), false);
    assert.equal(renderer._pendingIdleResourceWork(), true, 'completion admits one resource-settling frame');
    assert.equal(renderer._pendingIdleResourceWork(), false);
});

function initialPaintFixture(clock) {
    const renderer = fixture();
    renderer._firstFrameReason = 'boot';
    renderer._canSkipIdleFrame = () => false;
    renderer._render = function (_dt, allowWait = false) {
        if (allowWait && clock.now < clock.deadline) return false;
        this.paints++;
        return true;
    };
    return renderer;
}

test('a withheld initial paint keeps logical work and RAF alive, paints by deadline, then never holds again', () => {
    const clock = { now: 0, deadline: 250 };
    const renderer = initialPaintFixture(clock);
    renderer._loop(0);
    clock.now = 249;
    renderer._loop(249);
    assert.equal(renderer.paints, 0);
    assert.equal(renderer.signals, 0, 'a retained blank surface is not a first-frame presentation');
    assert.equal(renderer.updates, 2);
    assert.equal(renderer.fpsTicks, 2);
    assert.equal(renderer.scheduled, 2, 'the matching lookup never stalls RAF retries');
    assert.equal(renderer.envelopes.length, 2);
    assert.equal(renderer._frameFailureStats.consecutive, 0, 'a hold is not a failed frame');
    clock.now = 250;
    renderer._loop(266);
    assert.equal(renderer.paints, 1);
    assert.equal(renderer.signals, 1);
    // A subsequent cache read is not allowed to hold an already-presented
    // world, even if the boot reveal is still waiting for its band snapshot.
    clock.deadline = 1000;
    clock.now = 266;
    renderer._loop(283);
    assert.equal(renderer.paints, 2);
    assert.equal(renderer.scheduled, 4);
});

test('renderNow paints without waiting on an initial terrain read and disables later holds', () => {
    const renderer = initialPaintFixture({ now: 0, deadline: 250 });
    renderer.camera = { x: 0, y: 0, zoom: 1 };
    renderer._idleLastRenderCamera = {};
    renderer._lastAtmosphere = {};
    assert.equal(renderer.renderNow(), true);
    assert.equal(renderer.paints, 1);
    assert.equal(renderer.signals, 1);
    renderer._loop(16);
    assert.equal(renderer.paints, 2, 'a later loop cannot hold output that renderNow already presented');
});

test('resume frames never wait on the initial terrain-read budget', () => {
    const renderer = initialPaintFixture({ now: 0, deadline: 250 });
    renderer._firstFrameReason = 'resume';
    renderer._loop(0);
    assert.equal(renderer.paints, 1);
    assert.equal(renderer.signals, 1);
    assert.equal(renderer.scheduled, 1);
});

test('a Dashboard-first return cannot hold its first World paint while boot is still armed', () => {
    const renderer = initialPaintFixture({ now: 0, deadline: 250 });
    renderer._firstFrameReason = 'boot-pending';
    renderer._stopLoop = () => {};
    renderer._suspendWorldModeResources = () => {};
    renderer._beginWorldModeResume = () => {};
    renderer.setWorldModeActive(false);
    renderer.setWorldModeActive(true);
    renderer._loop(0);
    assert.equal(renderer.paints, 1);
    assert.equal(renderer.signals, 1);
    assert.equal(renderer.scheduled, 1);
});

// FP-1a: the 60 fps cap. rAF ticks of a 240 Hz panel.
const VSYNC_240 = 1000 / 240;

test('a tick the 60 fps cap holds only re-arms RAF: no update, clock, envelope or FPS sample', () => {
    const renderer = fixture();
    renderer.motionScale = 1;
    renderer.worldRendererMode = 'canvas';
    renderer._loop(0);
    const after = {
        updates: renderer.updates, fps: renderer.fpsTicks, envelopes: renderer.envelopes.length,
        clock: renderer._motionClock.elapsedMs, lastFrameTime: renderer._lastFrameTime,
    };
    assert.equal(after.updates, 1);
    for (const tick of [1, 2, 3]) {
        renderer._loop(tick * VSYNC_240);
        assert.equal(renderer.scheduled, 1 + tick, 'every held tick re-arms RAF');
    }
    assert.deepEqual({
        updates: renderer.updates, fps: renderer.fpsTicks, envelopes: renderer.envelopes.length,
        clock: renderer._motionClock.elapsedMs, lastFrameTime: renderer._lastFrameTime,
    }, after);
    renderer._loop(4 * VSYNC_240);
    assert.equal(renderer.updates, 2, 'the fourth 240 Hz tick renders');
    assert.equal(renderer.envelopes.length, 2);
});

test('the ladder hears the paced interval, never the panel refresh', () => {
    const renderer = fixture();
    const intervals = [];
    renderer.gpuWorld = { notePresentInterval: intervalMs => intervals.push(intervalMs) };
    for (let tick = 0; tick <= 12; tick++) renderer._loop(tick * VSYNC_240);
    assert.equal(renderer.updates, 4);
    assert.deepEqual(intervals.map(ms => Math.round(ms * 1000) / 1000), [16.667, 16.667, 16.667]);
    assert.ok(Math.abs(intervals[0] - FRAME_PACING_INTERVAL_MS) < 1e-9);
});

// FP-1b: the renderer's own ambient verdict, judged after each frame.
function ambientFixture() {
    const renderer = fixture();
    renderer.motionScale = 1;
    renderer._ambientHint = false;
    renderer._ambientCamera = { x: NaN, y: NaN, zoom: NaN };
    renderer._pointerInputAt = -Infinity;
    renderer._visibleSortedSprites = [];
    renderer.camera = { x: 10, y: 20, zoom: 2 };
    renderer.arrivalDeparture = { dispatches: new Map(), merges: new Map(), orphanReturns: [] };
    return renderer;
}

function renderedOver(renderer, fromMs, toMs, hz = 240) {
    const before = renderer.updates;
    for (let tick = Math.ceil(fromMs * hz / 1000); tick * 1000 / hz < toMs; tick++) renderer._loop(tick * 1000 / hz);
    return renderer.updates - before;
}

test('an ambient-only village renders at 30 fps; a walker above the stroll rung restores 60', () => {
    const renderer = ambientFixture();
    assert.ok(renderedOver(renderer, 0, 1000) <= 32, 'ambient-only frames pace at 30 fps');
    const walker = { moving: true, _gaitSpeed: SPEED_RUNGS[0] };
    renderer._visibleSortedSprites.push(walker);
    assert.ok(renderedOver(renderer, 1000, 2000) <= 32, 'a stroller stays ambient');
    walker._gaitSpeed = SPEED_RUNGS[SPEED_RUNGS.length - 1];
    const walking = renderedOver(renderer, 2000, 3000);
    assert.ok(walking >= 59 && walking <= 61, `a WORKING walker on screen renders at 60 fps (${walking})`);
});

test('pointer input, camera easing, a comet, a strike and a playing moment each hold 60 fps', () => {
    const causes = {
        pointer: r => { r._pointerInputAt = 2500; },
        camera: r => { r.camera._directorGlide = {}; },
        follow: r => { r.camera.x += 1; },
        comet: r => { r.arrivalDeparture.dispatches.set('child', {}); },
        strike: r => { r._frameStrikeActive = true; },
        moment: () => { momentPhase(10, defineMoment('minor')); },
    };
    for (const [name, apply] of Object.entries(causes)) {
        const renderer = ambientFixture();
        assert.ok(renderedOver(renderer, 0, 2000) <= 62, name);
        // Each cause is re-applied every frame: follow moves the camera, a
        // moment resolves its phase as it draws.
        const update = renderer._update;
        renderer._update = function (...args) { apply(this); return update.apply(this, args); };
        apply(renderer);
        renderer._noteAmbientFrame();
        const rendered = renderedOver(renderer, 2000, 3000);
        assert.ok(rendered >= 59, `${name} holds 60 fps (${rendered})`);
    }
});

test('a stopped loop forgets its cadence: the first tick after a restart renders at once', () => {
    const renderer = fixture();
    renderer._loop(1000);
    renderer._loop(1004);
    assert.equal(renderer.updates, 1);
    renderer._stopLoop();
    renderer._loop(1008);
    assert.equal(renderer.updates, 2);
});
