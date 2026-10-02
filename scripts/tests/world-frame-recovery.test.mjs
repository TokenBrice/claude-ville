import test from 'node:test';
import assert from 'node:assert/strict';
import { IsometricRenderer } from '../../claudeville/src/presentation/character-mode/IsometricRenderer.js';
import { createMotionClock } from '../../claudeville/src/presentation/character-mode/MotionClock.js';
import { eventBus } from '../../claudeville/src/domain/events/DomainEvent.js';
import { Toast } from '../../claudeville/src/presentation/shared/Toast.js';

class FakeElement {
    constructor() {
        this.children = [];
        this.parentNode = null;
        this.className = '';
        this.classList = {
            add: value => { this.className = `${this.className} ${value}`.trim(); },
        };
        this.dataset = {};
        this.attributes = new Map();
        this.textContent = '';
    }

    appendChild(child) {
        child.parentNode = this;
        this.children.push(child);
    }

    removeChild(child) {
        const index = this.children.indexOf(child);
        if (index !== -1) this.children.splice(index, 1);
        child.parentNode = null;
    }

    setAttribute(name, value) {
        this.attributes.set(name, value);
    }
}

function scheduler(t) {
    const frames = new Map();
    const retries = new Map();
    let nextId = 1;
    const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');
    Object.defineProperty(globalThis, 'document', {
        configurable: true,
        value: { visibilityState: 'visible' },
    });
    const rafDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'requestAnimationFrame');
    const cancelDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'cancelAnimationFrame');
    Object.defineProperty(globalThis, 'requestAnimationFrame', {
        configurable: true,
        value(callback) { const id = nextId++; frames.set(id, callback); return id; },
    });
    Object.defineProperty(globalThis, 'cancelAnimationFrame', {
        configurable: true,
        value(id) { frames.delete(id); },
    });
    t.mock.method(globalThis, 'setTimeout', (callback, delay) => {
        const id = nextId++;
        retries.set(id, { callback, delay });
        return id;
    });
    t.mock.method(globalThis, 'clearTimeout', id => retries.delete(id));
    t.mock.method(console, 'error', () => {});
    t.after(() => {
        for (const [name, descriptor] of [
            ['document', documentDescriptor],
            ['requestAnimationFrame', rafDescriptor],
            ['cancelAnimationFrame', cancelDescriptor],
        ]) {
            if (descriptor) Object.defineProperty(globalThis, name, descriptor);
            else delete globalThis[name];
        }
    });
    return {
        frames,
        retries,
        frame() {
            assert.equal(frames.size, 1, 'a runnable World owns exactly one RAF');
            const [id, callback] = frames.entries().next().value;
            frames.delete(id);
            callback(performance.now());
        },
        retry() {
            assert.equal(retries.size, 1, 'a failed World owns exactly one retry');
            const [id, retry] = retries.entries().next().value;
            retries.delete(id);
            retry.callback();
            return retry.delay;
        },
    };
}

function renderer() {
    return Object.assign(Object.create(IsometricRenderer.prototype), {
        running: true,
        _disposed: false,
        frameId: null,
        _worldModeActive: true,
        _worldResourcesSuspended: false,
        _worldResourceGeneration: 0,
        _worldResumePromise: null,
        _worldResumeGeneration: null,
        _worldResumeFailures: 0,
        _worldSpritesDirty: false,
        _contextLost: false,
        _frameFailureRecoveryTimer: null,
        _frameFailureRetryMs: 1000,
        _frameFailureEpisode: false,
        _frameFailureStats: {
            total: 0, consecutive: 0, lastStage: null, lastMessage: null,
            lastAt: 0, lastReportedAt: -Infinity, byStage: {}, paused: false,
        },
        _motionClock: createMotionClock(),
        motionScale: 1,
        _lastFrameTime: null,
        _lastLoopFrameTime: null,
        _lastVsyncTime: null,
        _fpsWindowStart: null,
        _fpsFrames: 0,
        _idleFrameDirty: true,
        _fallbackPrep: null,
        _worldSwap: null,
        worldRendererMode: 'canvas',
        presented: [],
        _update() {},
        _render() { this.presented.push(this._motionClock.elapsedMs); },
        _canSkipIdleFrame() { return this.motionScale === 0 && !this._idleFrameDirty; },
        _recordIdleRenderState() { this._idleFrameDirty = false; },
        _signalFirstFrame() {},
        _recordFrameEnvelope() {},
        releaseVolatileCaches() {},
        invalidateViewportCaches() { this._idleFrameDirty = true; },
        _resizeAuxiliaryBackingStores() {},
        _applyDisplayColor() {},
        _setPostFxCanvasVisible() {},
        _noteWorldBackend() {},
        agentSprites: new Map(),
    });
}

function failThree(r, clock) {
    r._startLoop();
    for (let index = 0; index < 3; index++) clock.frame();
    assert.equal(r._frameFailureStats.paused, true);
    assert.equal(clock.frames.size, 0);
    assert.equal(clock.retries.size, 1);
}

test('frame faults back off automatically and a presented frame resets the episode', t => {
    const clock = scheduler(t);
    const r = renderer();
    const fps = [];
    const recovered = [];
    t.after(eventBus.on('fps:updated', value => fps.push(value)));
    t.after(eventBus.on('world:frame-recovered', detail => recovered.push(detail)));
    r._update = () => { throw new Error('temporary update fault'); };
    for (const delay of [1000, 2000, 4000, 8000, 8000]) {
        failThree(r, clock);
        assert.equal(fps.at(-1), null, 'a stopped World must not advertise stale numeric FPS');
        assert.equal(clock.retry(), delay);
        assert.equal(r._frameFailureStats.paused, false);
    }
    r._update = () => {};
    clock.frame();
    assert.equal(r.presented.length, 1, 'the first automatic retry after fault removal presents a frame');
    assert.equal(r._frameFailureStats.consecutive, 0);
    assert.equal(r._frameFailureRetryMs, 1000);
    assert.equal(r._frameFailureEpisode, false);
    assert.equal(clock.retries.size, 0);
    assert.deepEqual(recovered, [{ total: 15 }]);
    assert.equal(clock.frames.size, 1);
    clock.frame();
    assert.equal(recovered.length, 1, 'recovery belongs to the episode, not every frame');
});

test('pacing and idle-check exceptions are frame faults rather than silent RAF loss', t => {
    const clock = scheduler(t);
    for (const stage of ['pacing', 'idle']) {
        const r = renderer();
        const ordinaryIdleCheck = r._canSkipIdleFrame;
        r._lastFrameTime = r._lastLoopFrameTime = performance.now();
        r._lastVsyncTime = performance.now();
        if (stage === 'pacing') r.gpuWorld = { notePresentInterval() { throw new Error('pacing fault'); } };
        else r._canSkipIdleFrame = () => { throw new Error('idle fault'); };
        failThree(r, clock);
        assert.equal(r._frameFailureStats.lastStage, stage);
        assert.equal(r.presented.length, 0);
        if (stage === 'pacing') r.gpuWorld.notePresentInterval = () => {};
        else r._canSkipIdleFrame = ordinaryIdleCheck;
        clock.retry();
        clock.frame();
        assert.equal(r.presented.length, 1);
        assert.equal(r._frameFailureEpisode, false);
        r._stopLoop();
    }
});

test('hidden or lost Worlds cancel recovery and restart only after their lifecycle resumes', async t => {
    const clock = scheduler(t);
    const r = renderer();
    r._update = () => { throw new Error('temporary fault'); };
    failThree(r, clock);
    document.visibilityState = 'hidden';
    r.pauseForVisibility();
    assert.equal(clock.retries.size, 0);
    assert.equal(r.resumeAfterFrameFailure(), false);
    r._update = () => {};
    document.visibilityState = 'visible';
    r.resumeFromVisibility();
    await r._worldResumePromise;
    clock.frame();
    assert.equal(r.presented.length, 1);
    r._update = () => { throw new Error('second fault'); };
    for (let index = 0; index < 3; index++) clock.frame();
    r.handleContextLost();
    assert.equal(clock.retries.size, 0);
    assert.equal(r.resumeAfterFrameFailure(), false);
    assert.equal(clock.frames.size, 0);
});

test('overlapping resume signals restore one live frame loop and reject stale asset completion', async t => {
    const clock = scheduler(t);
    const r = renderer();
    r._worldResourcesSuspended = true;
    let resolveAssets;
    r.assets = { resume: () => new Promise(resolve => { resolveAssets = resolve; }) };
    const first = r._beginWorldModeResume();
    r.resumeFromVisibility();
    const second = r._worldResumePromise;
    await Promise.resolve();
    assert.equal(clock.frames.size, 0);
    resolveAssets(true);
    assert.deepEqual(await Promise.all([first, second]), [true, true]);
    assert.equal(r._worldResourcesSuspended, false);
    clock.frame();
    assert.equal(r.presented.length, 1);
    assert.equal(await r._resumeWorldModeResources(), true);
    r._disposed = true;
    assert.equal(await r._resumeWorldModeResources(), false);
    r._disposed = false;
    r._stopLoop();
    r._worldResourcesSuspended = true;
    const stale = r._beginWorldModeResume();
    await Promise.resolve();
    r.pauseForVisibility();
    resolveAssets(true);
    assert.equal(await stale, false);
    assert.equal(r._worldResourcesSuspended, true);
    assert.equal(clock.frames.size, 0);
});

test('failed or overdue fallback preparation terminates its hold and presents Canvas recovery', t => {
    const clock = scheduler(t);
    for (const fault of ['bake', 'deadline', 'build']) {
        const r = renderer();
        const candidate = { disposed: false, dispose() { this.disposed = true; } };
        r.gpuWorld = { failure: { summary: 'lost device' }, dispose() {} };
        r.worldRendererMode = 'webgpu';
        const prep = {
            stage: fault === 'build' ? 'build' : 'bake',
            startedAt: performance.now() - (fault === 'deadline' ? 5001 : 0),
            failed: r.gpuWorld, note: 'lost device', next: candidate,
        };
        r._fallbackPrep = prep;
        r.fxCanvas = { cloneNode() { throw new Error('clone failed'); } };
        r._getTerrainCache = () => { throw new Error('bake failed'); };
        r._stepFallbackPrep({ prep });
        assert.equal(prep.stage, fault === 'build' ? 'build' : 'bake');
        assert.equal(candidate.disposed, true);
        assert.equal(r._fallbackPrep, null);
        assert.equal(r.worldRendererMode, 'canvas');
        clock.frame();
        assert.equal(r.presented.length, 1);
        assert.equal(r._frameFailureStats.consecutive, 0);
        r._stopLoop();
    }
});

test('a World failure notice survives elapsed retries and other notices until recovery', async t => {
    const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
    Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value: { location: { origin: 'http://localhost' }, addEventListener() {} },
    });
    t.after(() => {
        if (windowDescriptor) Object.defineProperty(globalThis, 'window', windowDescriptor);
        else delete globalThis.window;
    });
    const { App } = await import('../../claudeville/src/presentation/App.js');
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const container = new FakeElement();
    const toast = new Toast({
        documentRef: {
            getElementById: id => id === 'toastContainer' ? container : null,
            createElement: () => new FakeElement(),
        },
    });
    const app = Object.assign(Object.create(App.prototype), {
        toast,
        _eventUnsubscribers: [],
    });
    app._initWorldFrameRecovery();
    t.after(() => {
        for (const unsubscribe of app._eventUnsubscribers) unsubscribe();
        toast.destroy();
    });
    const fault = { stage: 'render', message: 'temporary fault', paused: true, retrying: true };
    eventBus.emit('world:frame-error', { ...fault, paused: false });
    assert.equal(container.children.length, 0, 'transient faults do not start an outage notice');
    eventBus.emit('world:frame-error', fault);
    assert.equal(container.children.length, 1);
    const notice = container.children[0];
    assert.match(notice.textContent, /temporary fault/);
    t.mock.timers.tick(3300);
    assert.deepEqual(container.children, [notice], 'the warning outlasts ordinary auto-dismiss');
    assert.doesNotMatch(notice.className, /toast--fadeout/);
    for (let index = 0; index < 8; index++) toast.show(`Routine notice ${index}`);
    assert.ok(container.children.includes(notice), 'routine notice pressure cannot evict the outage');
    t.mock.timers.tick(3000);
    t.mock.timers.tick(300);
    assert.deepEqual(container.children, [notice], 'ordinary notices still auto-dismiss');
    eventBus.emit('world:frame-error', { ...fault, message: 'another retry failed' });
    t.mock.timers.tick(30_000);
    assert.deepEqual(container.children, [notice], 'later retry failures do not duplicate the episode');
    assert.doesNotMatch(notice.className, /toast--fadeout/);
    eventBus.emit('world:frame-recovered', { total: 15 });
    assert.deepEqual(container.children, [], 'recovery clears the episode immediately');
    eventBus.emit('world:frame-error', fault);
    assert.equal(container.children.length, 1, 'a later episode can show its own warning');
    assert.notEqual(container.children[0], notice);
    eventBus.emit('world:frame-recovered');
    assert.deepEqual(container.children, []);
});

test('alternating frame fault signatures have bounded reports without delaying the breaker', t => {
    const clock = scheduler(t);
    let now = 0;
    t.mock.method(performance, 'now', () => now);
    const reports = [];
    t.after(eventBus.on('world:frame-error', detail => reports.push({ ...detail, at: now })));
    const r = renderer();
    let frame = 0;
    r._update = () => {
        if (frame % 3 === 0) throw new Error('update fault');
    };
    r._render = () => {
        if (frame % 3 === 1) throw new Error('render fault');
        r.presented.push(now);
    };
    r._startLoop();
    for (; frame < 600; frame++) {
        now = frame * 16;
        clock.frame();
    }
    assert.equal(r.presented.length, 200, 'successful frames keep intermittent faults below the breaker');
    assert.ok(reports.length > 1, 'ongoing faults remain observable');
    assert.ok(reports.length <= 10, 'alternating signatures cannot report at frame rate');
    for (let index = 1; index < reports.length; index++) {
        assert.ok(reports[index].at - reports[index - 1].at >= 1000);
    }
    assert.ok(reports.every(detail => !detail.paused));
    r._stopLoop();

    reports.length = 0;
    const broken = renderer();
    broken._update = () => { throw new Error('persistent fault'); };
    broken._startLoop();
    for (let index = 0; index < 3; index++) {
        now += 16;
        clock.frame();
    }
    assert.equal(reports.at(-1).paused, true, 'the breaker reports immediately despite the short floor');
    assert.equal(reports.at(-1).retrying, true);
    assert.equal(reports.at(-1).at, now);
    assert.ok(now - reports[0].at < 1000);
});
