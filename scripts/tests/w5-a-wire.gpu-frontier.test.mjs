import assert from 'node:assert/strict';
import test from 'node:test';
import { registerCoastBake } from '../../claudeville/src/presentation/character-mode/CoastBake.js';
import { validTerrainSubstrate } from '../../claudeville/src/presentation/character-mode/TerrainArtifactStore.js';
import { resolveFrontierFrame } from '../../claudeville/src/presentation/character-mode/gpu/GpuFrameState.js';
import {
    BATCH_UNIFORM_LAYOUT, FRAME_UNIFORM_BYTES, FRAME_UNIFORM_LAYOUT, RECORD_CONSTANTS_WGSL, createUniformViews, writeFrameUniforms,
} from '../../claudeville/src/presentation/character-mode/gpu/wgsl/common.js';

test('the Frontier suffix round-trips its uint row and clears reused staging when disabled', () => {
    assert.equal(FRAME_UNIFORM_BYTES, 960);
    assert.deepEqual(['planarRect', 'basinParams', 'depthRange', 'frontier'].map(k => FRAME_UNIFORM_LAYOUT.byName[k].offset), [896, 912, 928, 944]);
    assert.deepEqual(['supportH', 'surfaceOffset'].map(k => BATCH_UNIFORM_LAYOUT.byName[k].offset), [52, 56]);
    const staging = createUniformViews(FRAME_UNIFORM_BYTES);
    const planarRect = [-33, 72, 256, 80];
    writeFrameUniforms(staging, resolveFrontierFrame(31, { planarRect, basinHandle: 2, waterH: -1, fieldRevision: 0xf0000001 }));
    assert.deepEqual([...staging.f32.slice(224, 236)], [...planarRect, -1, 2, 8, 2, -2048, 6144, 1 / 8192, 8]);
    assert.deepEqual([...staging.u32.slice(236)], [31, 2, 0xf0000001, 0]);
    writeFrameUniforms(staging, resolveFrontierFrame(0));
    assert.ok(staging.u32.slice(224).every(v => v === 0));
    for (const [name, bit] of Object.entries({ RELIEF: 131072, SURFACE_DEPTH: 262144, MIRROR_SOURCE: 524288, SHAFT_RECEIVER: 1048576 })) {
        assert.ok(RECORD_CONSTANTS_WGSL.includes('RECORD_FLAG_' + name + ': u32 = ' + bit + 'u;'));
    }
});

function bakeCoast(substrateRevision) {
    const passes = [];
    const renderer = {
        substrateRevision, waterTiles: new Set(), waterMeta: new Map(), pathTiles: new Set(), bridgeTiles: new Set(),
        registerTerrainBakePass(pass) { passes.push(pass); return () => {}; },
    };
    for (let x = 8; x < 22; x++) for (let y = 25; y < 29; y++) {
        const key = x + ',' + y;
        renderer.waterTiles.add(key);
        renderer.waterMeta.set(key, { region: 'river' });
    }
    registerCoastBake(renderer);
    let image;
    const ctx = {
        getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }),
        getImageData(x, y, width, height) {
            return width !== 1 && image || { data: new Uint8ClampedArray(width * height * 4) };
        },
        putImageData(value) { image = value; },
    };
    for (const pass of passes) pass.draw(ctx, renderer);
    return { bake: renderer._coastBake, rgba: image.data };
}

test('the opt-in coast keeps real bank contacts out of the bed and registers their fine ownership', () => {
    const legacy = bakeCoast(0);
    const clean = bakeCoast(1);
    assert.equal(legacy.bake.contacts, undefined);
    assert.ok(clean.bake.contacts.length > 0);
    assert.ok(validTerrainSubstrate({ substrateRevision: 1 }, clean));
    const samples = new DataView(clean.bake.contacts.buffer);
    let changed = 0;
    for (let p = 0; p < samples.byteLength; p += 8) {
        const o = 4 * samples.getUint32(p, true);
        if (!legacy.rgba.subarray(o, o + 4).every((byte, i) => byte === clean.rgba[o + i])) changed++;
    }
    assert.ok(changed > 0);
    clean.bake.exposure[0] |= 16;
    assert.equal(validTerrainSubstrate({ substrateRevision: 1 }, clean), false);
});

// The ordinary unit gate runs on GPU-less hosts. Opt in to the real compiler,
// real surface-page readback, device rebuild, and a live Harbor frame.
test('hardware Frontier submits, uses per-pixel height in both draw orders, and rebuilds after device loss',
    { skip: !process.env.CLAUDEVILLE_TEST_FRONTIER_GPU, timeout: 150000 }, async () => {
        const { launchBenchBrowser, openWorld, resolveServer } = await import('../smoke/support/world-bench.mjs');
        const server = await resolveServer();
        let browser;
        try {
            browser = await launchBenchBrowser();
            const { page, errors } = await openWorld(browser, { baseUrl: server.baseUrl, scenario: 'readme-showcase',
                width: 1440, height: 900, query: { renderer: 'webgpu', frontier: 1 } });
            await page.waitForFunction(() => {
                const w = window.__claudeVilleApp.renderer.gpuWorld;
                return w?.getDiagnostics().frontier?.featureMask === 31 && w._frontierPasses.get('mirror').pass._mirrorClearCount >= 2;
            }, null, { timeout: 60000 });
            const result = await page.evaluate(async () => {
                const { createGpuWorldRendererWebGPU, prepareGpuWorldWebGPU } = await import('/src/presentation/character-mode/gpu/GpuWorldRendererWebGPU.js');
                const gpu = await prepareGpuWorldWebGPU();
                const canvas = document.createElement('canvas');
                canvas.width = canvas.height = 8;
                const w = createGpuWorldRendererWebGPU({ ...gpu, canvas, frontierEnabled: true });
                try {
                    w.setFrontierConfig({ ripples: false, mirror: false, wind: false, shafts: false });
                    const record = (key, color, h) => {
                        const source = new OffscreenCanvas(2, 1);
                        const c = source.getContext('2d');
                        c.fillStyle = color;
                        c.fillRect(0, 0, 2, 1);
                        return { id: key, textureKey: key, source, sourceWidth: 2, sourceHeight: 1,
                            x: 0, y: 0, width: 8, height: 8, footY: 8, depthSortY: 8, writesDepth: true,
                            surfacePage: true, pageable: false,
                            surfaceSource: { width: 2, height: 1, data: Uint8Array.of(h * 16, 0, 30, 192, 0, key === 'far' ? 1 : 0, 30, 192) } };
                    };
                    const near = record('near', '#ff2200', 8), far = record('far', '#0066ff', 2);
                    const draw = records => w.render({ records, camera: { x: 0, y: 0, zoom: 1 }, feed: { reducedMotion: true, timeMs: 0 }, forceFreshOutput: true });
                    const prepare = async () => {
                        for (let i = 0; i < 300; i++) {
                            draw([near, far]);
                            const d = w.getDiagnostics().frontier;
                            if (d.featureMask === 4) return;
                            if (d.passes.surfaceDepth.error) throw Error(d.passes.surfaceDepth.error);
                            await new Promise(resolve => setTimeout(resolve, 16));
                        }
                        throw Error('surface pipeline did not become ready');
                    };
                    const pixel = async records => {
                        draw(records);
                        const capture = await w.debugCaptureTargets();
                        return [...capture.scene.slice(136, 140), ...capture.scene.slice(152, 156)];
                    };
                    await prepare();
                    const first = await pixel([near, far]), reversed = await pixel([far, near]);
                    const farAlone = await pixel([far]);
                    const flat = await pixel([{ ...near, surfacePage: false }, { ...far, surfacePage: false }]);
                    const device = w.device;
                    device.destroy();
                    await device.lost;
                    const lost = w.getDiagnostics().frontier;
                    if (!await w._rebuildDevice()) throw Error(w.deviceRebuildError);
                    await prepare();
                    return { first, reversed, farAlone, flat, lostBytes: lost.logicalBytes, rebuilt: await pixel([far, near]), failure: w.failure };
                } finally { w.dispose(); }
            });
            assert.equal(result.failure, null);
            assert.equal(result.lostBytes, 0);
            assert.ok(result.first[0] > result.first[2] && result.farAlone[2] > result.farAlone[0], JSON.stringify(result));
            assert.ok(result.first[6] > result.first[4], JSON.stringify(result));
            assert.ok(result.flat[2] > result.flat[0], JSON.stringify(result));
            assert.deepEqual(result.first, result.reversed);
            assert.deepEqual(result.rebuilt, result.first);
            assert.deepEqual(errors, []);
        } finally {
            await browser?.close();
            await server.stop();
        }
    });
