import test from 'node:test';
import assert from 'node:assert/strict';
import { IsometricRenderer } from '../../claudeville/src/presentation/character-mode/IsometricRenderer.js';
import { GpuWorldRenderer } from '../../claudeville/src/presentation/character-mode/gpu/GpuWorldRenderer.js';
import { GpuWorldRendererWebGPU } from '../../claudeville/src/presentation/character-mode/gpu/GpuWorldRendererWebGPU.js';
import { createGpuRainField } from '../../claudeville/src/presentation/character-mode/WeatherRenderer.js';

// A WebGPU world that failed while the World was away (a device lost during a
// Dashboard visit) hands over to WebGL2 on the return's armed first frame, so
// the reveal shows the WebGL2 frame, never a Canvas-world frame of the failed
// world. A forward WebGL2→WebGPU switch still waits for the reveal.
function world(backend, { active = true } = {}) {
    return {
        backend,
        width: 2560,
        height: 1440,
        resized: null,
        isActive: () => active,
        resize(width, height) { this.resized = [width, height]; },
        qualityLadder: null,
    };
}

function host({ firstFrameReason, swap }) {
    const renderer = Object.create(IsometricRenderer.prototype);
    renderer._applyDisplayColor = () => {};
    renderer._firstFrameReason = firstFrameReason;
    renderer._worldSwap = swap;
    return renderer;
}

for (const reason of ['return', 'boot']) {
    test(`a WebGL2 fallback swap runs on an armed '${reason}' first frame`, () => {
        const failed = world('webgpu', { active: false });
        const next = world(undefined);
        const renderer = host({ firstFrameReason: reason, swap: { gpuWorld: next, canvas: {}, previous: null, fallback: 'failed in frame: device: destroyed' } });
        renderer.gpuWorld = failed;
        renderer.worldRendererMode = 'webgpu';
        const swap = renderer._beginWorldSwap();
        assert.ok(swap);
        assert.equal(renderer.gpuWorld, next);
        assert.equal(renderer.worldRendererMode, 'webgl');
        assert.equal(swap.previous, failed);
        assert.deepEqual(next.resized, [2560, 1440]);
    });
}

test('a forward WebGPU switch waits for the armed first frame', () => {
    const webgl = world(undefined);
    const next = world('webgpu');
    const renderer = host({ firstFrameReason: 'return', swap: { gpuWorld: next, canvas: {}, previous: null } });
    renderer.gpuWorld = webgl;
    renderer.worldRendererMode = 'webgl';
    assert.equal(renderer._beginWorldSwap(), null);
    assert.equal(renderer.gpuWorld, webgl);
    renderer._firstFrameReason = null;
    assert.ok(renderer._beginWorldSwap());
    assert.equal(renderer.gpuWorld, next);
});

for (const [from, to] of [['webgl', 'webgpu'], ['webgpu', 'webgl']]) {
    test(`falling rain keeps its three phases when swapping from ${from} to ${to}`, () => {
        const prototype = { webgl: GpuWorldRenderer.prototype, webgpu: GpuWorldRendererWebGPU.prototype };
        const previous = Object.assign(world(from), { _rain: createGpuRainField(), _rainBuffer: {} });
        const next = Object.assign(world(to), { _rain: createGpuRainField(), _rainBuffer: {} });
        const fallback = to === 'webgl' ? 'device lost' : null;
        const renderer = host({ swap: { gpuWorld: next, canvas: {}, fallback } });
        renderer.gpuWorld = previous;
        renderer.worldRendererMode = from;
        const camera = { zoom: 2, screenToWorld: (x, y) => ({ x: x / 2, y: y / 2 }) };
        const feed = {
            rainViewport: { width: 2508, height: 1398 },
            atmosphere: {
                weather: { type: 'rain', intensity: 0.85, windX: 0.9, seed: 111 },
                clock: { localDate: '2026-07-15' },
                motion: { particleEnabled: true },
            },
        };
        for (let elapsed = 0; elapsed <= 60_000; elapsed += 40) {
            feed.timeMs = 1_200_000 + elapsed;
            feed.atmosphere.weather.precipitation = 0.60 + 0.28 * elapsed / 60_000;
            prototype[from]._prepareRain.call(previous, feed, camera, 0);
        }
        if (fallback) previous.isActive = () => false;
        assert.ok(renderer._beginWorldSwap());
        prototype[to]._prepareRain.call(next, feed, camera, 0);
        assert.ok(next.rainInstances > 0);
        assert.equal(next.rainInstances, previous.rainInstances);
        assert.deepEqual(next._rain.uniforms.slice(8, 11), previous._rain.uniforms.slice(8, 11));
    });
}
