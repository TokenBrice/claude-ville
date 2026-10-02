import test from 'node:test';
import assert from 'node:assert/strict';
import { IsometricRenderer } from '../../claudeville/src/presentation/character-mode/IsometricRenderer.js';
import { eventBus } from '../../claudeville/src/domain/events/DomainEvent.js';
import { GpuWorldRendererWebGPU } from '../../claudeville/src/presentation/character-mode/gpu/GpuWorldRendererWebGPU.js';

function installFrameSurfaces(t) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');
    globalThis.document = { createElement() {
        let color;
        return {
            width: 0, height: 0,
            getContext: () => ({
                fillRect() { color = [0, 0, 0, 255]; },
                drawImage(source) { color = [...source.color]; },
                getImageData() {
                    const data = new Uint8ClampedArray(96 * 64 * 4);
                    for (let offset = 0; offset < data.length; offset += 4) data.set(color, offset);
                    return { data };
                },
            }),
        };
    } };
    t.after(() => descriptor ? Object.defineProperty(globalThis, 'document', descriptor) : delete globalThis.document);
    return {
        width: 192, height: 128, style: { display: 'block' }, color: [24, 48, 96, 255],
    };
}

function renderer() {
    return Object.assign(Object.create(IsometricRenderer.prototype), {
        camera: { presented: false, setPresented(value) { this.presented = value; } },
        _invalidateIdleFrame() {},
        _horizonScreenFraction: () => 0.25,
        _revealCell: () => 2,
    });
}
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

test('a superseded activation cannot reveal the new activation with an old snapshot', async t => {
    const r = renderer();
    const events = [];
    const off = eventBus.on('world:first-frame', event => events.push(event));
    t.after(off);
    const completions = [];
    r._sampleFrameBands = () => new Promise(resolve => completions.push(resolve));
    r.armFirstFrameSignal('boot');
    r._signalFirstFrame();
    r.armFirstFrameSignal('return');
    r._signalFirstFrame();
    completions[0]({ bands: [{ top: 0, color: '#0000ff' }], sea: '#0000ff' });
    await flush();
    assert.deepEqual(events, []);
    assert.equal(r.camera.presented, false);
    completions[1]({ bands: [{ top: 0, color: '#00ff00' }], sea: '#00ff00' });
    await flush();
    assert.equal(events.length, 1);
    assert.equal(events[0].reason, 'return');
    assert.deepEqual(events[0].bands, [{ top: 0, color: '#00ff00' }]);
    assert.equal(r.camera.presented, true);
});

test('a failed readback still publishes the null-band first frame', async t => {
    const r = renderer();
    const events = [];
    t.after(eventBus.on('world:first-frame', event => events.push(event)));
    r._sampleFrameBands = () => Promise.resolve(null);
    r.armFirstFrameSignal('boot');
    r._signalFirstFrame();
    await flush();
    assert.equal(events.length, 1);
    assert.equal(events[0].reason, 'boot');
    assert.equal(events[0].bands, null);
    assert.equal(r.camera.presented, true);
    assert.equal(Boolean(r._revealSnapshotPending), false);
});

test('disposing while bands are pending cannot publish a late first frame', async t => {
    const r = renderer();
    const events = [];
    t.after(eventBus.on('world:first-frame', event => events.push(event)));
    let complete;
    r._sampleFrameBands = () => new Promise(resolve => { complete = resolve; });
    r.armFirstFrameSignal('return');
    r._signalFirstFrame();
    r._disposed = true;
    complete({ bands: [{ top: 0, color: '#abcdef' }], sea: '#abcdef' });
    await flush();
    assert.deepEqual(events, []);
});

test('first-frame publication waits only for GPU completion and uses its captured frame and metadata', async t => {
    const fx = installFrameSurfaces(t);
    const r = renderer();
    let complete;
    r.fxCanvas = fx;
    r.gpuWorld = Object.assign(Object.create(GpuWorldRendererWebGPU.prototype), {
        canvas: fx, ensureFreshOutput: () => true, isActive: () => true,
        _lastCanvasTexture: {},
        device: {
            lost: new Promise(() => {}),
            queue: { onSubmittedWorkDone: () => new Promise(resolve => { complete = resolve; }) },
        },
    });
    r._lastAtmosphere = { sky: { palette: ['#204080', '#183060'] } };
    const events = [];
    t.after(eventBus.on('world:first-frame', event => events.push(event)));
    r.armFirstFrameSignal('boot');
    r._signalFirstFrame();
    fx.color = [255, 0, 0, 255];
    r._lastAtmosphere = { sky: { palette: ['#ff0000'] } };
    r._horizonScreenFraction = () => 0.5;
    r.camera.zoom = 3;
    r._signalFirstFrame();
    await flush();
    assert.deepEqual(events, []);
    assert.equal(r.camera.presented, false);
    complete();
    await flush();
    assert.deepEqual(events, [{
        reason: 'boot', horizonY: 0.25, cell: 2, sky: ['#204080', '#183060'],
        bands: [{ top: 0, color: '#183060' }, { top: 0.25, color: '#183060' }],
        sea: '#183060',
    }]);
    assert.equal(r.camera.presented, true);
    r._signalFirstFrame();
    await flush();
    assert.equal(events.length, 1);
});

test('Dashboard capture remains synchronous and measures the frame it just drew', t => {
    const fx = installFrameSurfaces(t);
    const r = renderer();
    r.fxCanvas = fx;
    r.renderNow = () => {
        fx.color = [32, 64, 128, 255];
        return true;
    };
    assert.deepEqual(r.captureFrameBands(8), {
        horizonY: 0.25, cell: 2,
        bands: [{ top: 0, color: '#204080' }, { top: 0.25, color: '#204080' }],
        sea: '#204080',
    });
});

test('resident and hybrid WebGL activations hold reveal until their captured GPU frame completes', async t => {
    const fx = installFrameSurfaces(t);
    const saved = new Map(['requestAnimationFrame', 'cancelAnimationFrame'].map(name => (
        [name, Object.getOwnPropertyDescriptor(globalThis, name)]
    )));
    const frames = new Map();
    let nextFrame = 0;
    globalThis.requestAnimationFrame = callback => { frames.set(++nextFrame, callback); return nextFrame; };
    globalThis.cancelAnimationFrame = id => frames.delete(id);
    t.after(() => {
        for (const [name, descriptor] of saved) {
            if (descriptor) Object.defineProperty(globalThis, name, descriptor);
            else delete globalThis[name];
        }
    });
    const runFrame = () => {
        const callbacks = [...frames.values()];
        frames.clear();
        for (const callback of callbacks) callback();
    };
    const events = [];
    t.after(eventBus.on('world:first-frame', event => events.push(event)));
    for (const owner of ['gpuWorld', 'postFx']) {
        const r = renderer();
        let signalled = false;
        r.fxCanvas = fx;
        fx.color = [24, 48, 96, 255];
        r[owner] = { gl: {
            SYNC_GPU_COMMANDS_COMPLETE: 1, ALREADY_SIGNALED: 2,
            CONDITION_SATISFIED: 3, TIMEOUT_EXPIRED: 4,
            isContextLost: () => false, fenceSync: () => ({}), flush() {}, deleteSync() {},
            clientWaitSync: () => signalled ? 3 : 4,
        } };
        r.armFirstFrameSignal('return');
        r._signalFirstFrame();
        fx.color = [255, 0, 0, 255];
        runFrame();
        await flush();
        assert.equal(r.camera.presented, false);
        signalled = true;
        runFrame();
        await flush();
        assert.equal(r.camera.presented, true);
    }
    assert.deepEqual(events.map(event => ({ reason: event.reason, sea: event.sea })), [
        { reason: 'return', sea: '#183060' }, { reason: 'return', sea: '#183060' },
    ]);
});

test('Dashboard ignores a late reveal, and the next World activation accepts null bands', async t => {
    const names = ['window', 'document'];
    const saved = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
    const root = { dataset: { worldReady: 'boot' } };
    globalThis.window = { location: { origin: 'http://localhost' }, addEventListener() {} };
    globalThis.document = { getElementById: id => id === 'characterMode' ? root : null };
    const { App } = await import('../../claudeville/src/presentation/App.js');
    const app = Object.assign(Object.create(App.prototype), {
        renderer: Object.assign(renderer(), { captureFrameBands: () => null }),
        _eventUnsubscribers: [], _paintRevealBands: () => false,
    });
    app._initWorldReveal();
    t.after(() => {
        for (const off of app._eventUnsubscribers) off();
        for (const name of names) {
            const descriptor = saved.get(name);
            if (descriptor) Object.defineProperty(globalThis, name, descriptor);
            else delete globalThis[name];
        }
    });
    eventBus.emit('mode:changed', 'dashboard');
    eventBus.emit('world:first-frame', { reason: 'boot', bands: null });
    assert.equal(root.dataset.worldReady, undefined);
    eventBus.emit('mode:changed', 'character');
    eventBus.emit('world:first-frame', { reason: 'return', bands: null });
    assert.equal(root.dataset.worldReady, 'return');
});
