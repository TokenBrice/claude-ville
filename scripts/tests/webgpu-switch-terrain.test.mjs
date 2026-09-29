import test from 'node:test';
import assert from 'node:assert/strict';
import { IsometricRenderer } from '../../claudeville/src/presentation/character-mode/IsometricRenderer.js';

// The WebGL2 world holds the terrain bake as a texture, so the CPU canvas is
// released. A pending WebGL2→WebGPU switch must keep it: the new world starts
// without the texture and would otherwise re-bake the terrain inside the swap
// frame (a 300–500 ms freeze and a camera step mid-glide).
function host(state = {}) {
    const renderer = Object.create(IsometricRenderer.prototype);
    renderer.terrainCache = { width: 4096, height: 2048 };
    renderer.terrainCacheKey = 'bake-key';
    renderer._terrainResident = null;
    renderer._pendingWebGpu = null;
    renderer._worldSwap = null;
    return Object.assign(renderer, state);
}

for (const [label, state] of [
    ['a compiling', { _pendingWebGpu: { settled: false } }],
    ['an armed', { _worldSwap: { gpuWorld: {}, canvas: {}, previous: null } }],
]) {
    test(`${label} WebGPU switch keeps the terrain bake for the incoming world`, () => {
        const renderer = host(state);
        const canvas = renderer.terrainCache;
        renderer.releaseTerrainCanvas();
        assert.equal(renderer.terrainCache, canvas);
        assert.equal(canvas.width, 4096);
        assert.equal(renderer._terrainResident, null);
    });
}

test('with no switch pending the bake is released to its resident stand-in', () => {
    const renderer = host();
    const canvas = renderer.terrainCache;
    renderer.releaseTerrainCanvas();
    assert.equal(renderer.terrainCache, null);
    assert.equal(canvas.width, 0);
    assert.deepEqual(renderer._terrainResident, { width: 4096, height: 2048, gpuResident: true, key: 'bake-key' });
});
