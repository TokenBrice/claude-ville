import test from 'node:test';
import assert from 'node:assert/strict';
import { IsometricRenderer } from '../../claudeville/src/presentation/character-mode/IsometricRenderer.js';
import { createMotionClock } from '../../claudeville/src/presentation/character-mode/MotionClock.js';

function fixture() {
    return Object.assign(Object.create(IsometricRenderer.prototype), {
        running: true, _worldModeActive: true, _contextLost: false,
        _worldResourceGeneration: 0,
        _lastFrameTime: null, _lastLoopFrameTime: null, _lastVsyncTime: null,
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
    renderer._loop(250);
    assert.equal(renderer.paints, 1);
    assert.equal(renderer.signals, 1);
    // A subsequent cache read is not allowed to hold an already-presented
    // world, even if the boot reveal is still waiting for its band snapshot.
    clock.deadline = 1000;
    clock.now = 266;
    renderer._loop(266);
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
