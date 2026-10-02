import test from 'node:test';
import assert from 'node:assert/strict';
import { sampleRevealBands, sampleRevealBandsAsync } from '../../claudeville/src/presentation/character-mode/RevealBands.js';
import { GpuWorldRendererWebGPU } from '../../claudeville/src/presentation/character-mode/gpu/GpuWorldRendererWebGPU.js';
import { snapshotWebglFence } from '../../claudeville/src/presentation/character-mode/gpu/GpuWorldRenderer.js';

const WIDTH = 96;
const HEIGHT = 64;
const BLUE_BANDS = { bands: [{ top: 0, color: '#183060' }], sea: '#183060' };
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

function replaceGlobals(t, values) {
    for (const [name, value] of Object.entries(values)) {
        const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
        Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
        t.after(() => descriptor ? Object.defineProperty(globalThis, name, descriptor) : delete globalThis[name]);
    }
}

function surface(color = [24, 48, 96, 255], width = WIDTH, height = HEIGHT) {
    const pixels = new Uint8ClampedArray(width * height * 4);
    for (let offset = 0; offset < pixels.length; offset += 4) pixels.set(color, offset);
    return { width, height, pixels, style: {} };
}

function installSnapshotEnvironment(t) {
    const canvases = [];
    let reads = 0;
    let readError = false;
    replaceGlobals(t, {
        document: { createElement() {
            const canvas = { width: 0, height: 0 };
            let pixels;
            const context = {
                fillRect() {
                    pixels = new Uint8ClampedArray(canvas.width * canvas.height * 4);
                    for (let offset = 3; offset < pixels.length; offset += 4) pixels[offset] = 255;
                },
                drawImage(source) {
                    for (let y = 0; y < canvas.height; y++) {
                        for (let x = 0; x < canvas.width; x++) {
                            const sx = Math.floor((x + 0.5) * source.width / canvas.width);
                            const sy = Math.floor((y + 0.5) * source.height / canvas.height);
                            const from = (sy * source.width + sx) * 4;
                            const to = (y * canvas.width + x) * 4;
                            const alpha = source.pixels[from + 3] / 255;
                            for (let channel = 0; channel < 3; channel++) {
                                pixels[to + channel] = source.pixels[from + channel] * alpha + pixels[to + channel] * (1 - alpha);
                            }
                        }
                    }
                },
                getImageData() {
                    reads++;
                    if (readError) throw new Error('unreadable canvas');
                    return { data: pixels.slice() };
                },
            };
            canvas.getContext = () => context;
            canvases.push(canvas);
            return canvas;
        } },
        Worker: undefined, OffscreenCanvas: undefined, createImageBitmap: undefined,
    });
    return {
        canvases, reads: () => reads,
        failRead: () => { readError = true; },
    };
}

function sdrSnapshot(source, ready, deviceLost = new Promise(() => {})) {
    const renderer = Object.assign(Object.create(GpuWorldRendererWebGPU.prototype), {
        canvas: source, ensureFreshOutput: () => true, isActive: () => true,
        _lastCanvasTexture: {},
        device: { lost: deviceLost, queue: { onSubmittedWorkDone: () => ready } },
    });
    return renderer.snapshotReadoutSurface(WIDTH, HEIGHT);
}

function installWebglFence(t) {
    const frames = new Map();
    let nextFrame = 0;
    replaceGlobals(t, {
        requestAnimationFrame: callback => { frames.set(++nextFrame, callback); return nextFrame; },
        cancelAnimationFrame: id => frames.delete(id),
    });
    const state = { signalled: false, lost: false, failed: false };
    const gl = {
        SYNC_GPU_COMMANDS_COMPLETE: 1, ALREADY_SIGNALED: 2, CONDITION_SATISFIED: 3,
        TIMEOUT_EXPIRED: 4, WAIT_FAILED: 5,
        isContextLost: () => state.lost,
        fenceSync: () => ({}), flush() {}, deleteSync() {},
        clientWaitSync(sync, flags, timeout) {
            assert.equal(flags, 0);
            assert.equal(timeout, 0, 'the main thread must never wait on an unfinished fence');
            return state.failed ? gl.WAIT_FAILED : state.signalled ? gl.CONDITION_SATISFIED : gl.TIMEOUT_EXPIRED;
        },
    };
    return {
        gl, state, pending: () => frames.size,
        frame() {
            const callbacks = [...frames.values()];
            frames.clear();
            for (const callback of callbacks) callback();
        },
    };
}

test('Canvas reveal works without worker APIs and matches synchronous bands from the captured composite', async t => {
    installSnapshotEnvironment(t);
    const backdrop = surface([32, 64, 128, 255], 192, 128);
    const scene = surface([0, 0, 0, 0], 192, 128);
    for (let y = 32; y < scene.height; y++) {
        const color = y < 88 ? [72, 104, 56, 255] : [24, 48, 96, 255];
        for (let x = 0; x < scene.width; x++) scene.pixels.set(color, (y * scene.width + x) * 4);
    }
    const overlay = surface([0, 0, 0, 0]);
    for (let y = 40; y < 48; y++) {
        for (let x = 0; x < WIDTH; x++) overlay.pixels.set([128, 64, 32, 128], (y * WIDTH + x) * 4);
    }
    const hidden = surface([255, 0, 0, 255]);
    hidden.style.display = 'none';
    const surfaces = [backdrop, scene, overlay, hidden];
    const options = { count: 4, horizonY: 0.25 };
    const expected = sampleRevealBands(surfaces, options);
    const pending = sampleRevealBandsAsync(surfaces, options);
    for (const source of surfaces) source.pixels.fill(255);
    const measured = await pending;
    assert.deepEqual(measured, expected);
    assert.equal(measured.bands[0].color, '#204080');
    assert.ok(measured.bands.some(band => band.top === 0.25));
    assert.equal(measured.sea, '#486838');
});

test('an unresolved SDR fence returns null at two seconds without a CPU readback', async t => {
    const env = installSnapshotEnvironment(t);
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let result = 'pending';
    const snapshot = sdrSnapshot(surface(), new Promise(() => {}));
    const pending = sampleRevealBandsAsync([snapshot.surface], snapshot).then(value => { result = value; });
    await flush();
    t.mock.timers.tick(1999);
    await flush();
    assert.equal(result, 'pending');
    assert.equal(env.reads(), 0);
    t.mock.timers.tick(1);
    await pending;
    assert.equal(result, null);
    assert.equal(env.reads(), 0);
    assert.deepEqual([env.canvases[0].width, env.canvases[0].height], [0, 0]);
});

test('device loss settles an unfinished SDR fence before the deadline without reading it', async t => {
    const env = installSnapshotEnvironment(t);
    let lose;
    const snapshot = sdrSnapshot(surface(), new Promise(() => {}), new Promise(resolve => { lose = resolve; }));
    const pending = sampleRevealBandsAsync([snapshot.surface], snapshot);
    await flush();
    lose({ reason: 'destroyed' });
    assert.equal(await pending, null);
    assert.equal(env.reads(), 0);
});

test('GPU completion after timeout cannot read or revive the expired snapshot', async t => {
    const env = installSnapshotEnvironment(t);
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let complete;
    const pending = sampleRevealBandsAsync([surface()], { ready: new Promise(resolve => { complete = resolve; }) });
    t.mock.timers.tick(2000);
    assert.equal(await pending, null);
    complete(true);
    await flush();
    assert.equal(env.reads(), 0);
});

test('a rejected SDR fence returns null rather than attempting readback', async t => {
    const env = installSnapshotEnvironment(t);
    const snapshot = sdrSnapshot(surface(), Promise.reject(new Error('lost')));
    assert.equal(await sampleRevealBandsAsync([snapshot.surface], snapshot), null);
    assert.equal(env.reads(), 0);
});

test('SDR samples only after GPU completion and retains the original frame while later frames change', async t => {
    const env = installSnapshotEnvironment(t);
    let complete;
    const source = surface([24, 48, 96, 255], 192, 128);
    const snapshot = sdrSnapshot(source, new Promise(resolve => { complete = resolve; }));
    let result = 'pending';
    const pending = sampleRevealBandsAsync([snapshot.surface], snapshot).then(value => { result = value; });
    source.pixels.fill(255);
    await flush();
    assert.equal(result, 'pending');
    assert.equal(env.reads(), 0);
    complete();
    await pending;
    assert.deepEqual(result, BLUE_BANDS);
    assert.equal(env.reads(), 1);
});

test('a completed GPU frame with an unreadable Canvas publishes null bands', async t => {
    const env = installSnapshotEnvironment(t);
    env.failRead();
    const snapshot = sdrSnapshot(surface(), Promise.resolve());
    assert.equal(await sampleRevealBandsAsync([snapshot.surface], snapshot), null);
});

test('HDR samples the clamped readout only after its submitted GPU work completes', async t => {
    const env = installSnapshotEnvironment(t);
    let complete;
    const texture = { createView: () => ({}) };
    const readout = surface();
    const context = { getCurrentTexture: () => texture };
    const renderer = Object.assign(Object.create(GpuWorldRendererWebGPU.prototype), {
        canvas: { width: 2880, height: 1800 }, canvasColorSpace: 'srgb',
        ensureFreshOutput: () => true, isActive: () => true,
        _lastCanvasTexture: texture,
        _display: { hdr: true, readout: { getBindGroupLayout: () => ({}) } },
        _readout: { canvas: readout, context, colorSpace: 'srgb' },
        device: {
            lost: new Promise(() => {}),
            queue: { submit() {}, onSubmittedWorkDone: () => new Promise(resolve => { complete = resolve; }) },
            pushErrorScope() {}, popErrorScope: async () => null,
            createBindGroup: () => ({}),
            createCommandEncoder: () => ({
                beginRenderPass: () => ({ setPipeline() {}, setBindGroup() {}, draw() {}, end() {} }),
                finish: () => ({}),
            }),
        },
    });
    const snapshot = renderer.snapshotReadoutSurface(WIDTH, HEIGHT);
    let result = 'pending';
    const pending = sampleRevealBandsAsync([snapshot.surface], snapshot).then(value => { result = value; });
    await flush();
    assert.equal(result, 'pending');
    assert.equal(env.reads(), 0);
    complete();
    await pending;
    assert.deepEqual(result, BLUE_BANDS);
});

test('WebGL polls unfinished fences without CPU waits, then reads the captured frame', async t => {
    const env = installSnapshotEnvironment(t);
    const gpu = installWebglFence(t);
    let result = 'pending';
    const pending = sampleRevealBandsAsync([surface()], snapshotWebglFence(gpu.gl)).then(value => { result = value; });
    gpu.frame();
    await flush();
    assert.equal(result, 'pending');
    assert.equal(env.reads(), 0);
    gpu.frame();
    assert.equal(env.reads(), 0);
    gpu.state.signalled = true;
    gpu.frame();
    await pending;
    assert.deepEqual(result, BLUE_BANDS);
    assert.equal(gpu.pending(), 0);
});

test('WebGL context loss or fence failure yields null bands without a read', async t => {
    const env = installSnapshotEnvironment(t);
    const gpu = installWebglFence(t);
    for (const failure of ['lost', 'failed']) {
        const pending = sampleRevealBandsAsync([surface()], snapshotWebglFence(gpu.gl));
        gpu.state[failure] = true;
        gpu.frame();
        assert.equal(await pending, null);
        assert.equal(env.reads(), 0);
        assert.equal(gpu.pending(), 0);
        gpu.state[failure] = false;
    }
});

test('WebGL deadline cancels polling, so a late fence cannot start a readback', async t => {
    const env = installSnapshotEnvironment(t);
    const gpu = installWebglFence(t);
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const pending = sampleRevealBandsAsync([surface()], snapshotWebglFence(gpu.gl));
    gpu.frame();
    t.mock.timers.tick(2000);
    assert.equal(await pending, null);
    assert.equal(gpu.pending(), 0);
    gpu.state.signalled = true;
    gpu.frame();
    await flush();
    assert.equal(env.reads(), 0);
});
