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
    { skip: !process.env.CLAUDEVILLE_TEST_FRONTIER_GPU, timeout: 240000 }, async () => {
        const { launchBenchBrowser, openWorld, poseWorld, resolveServer } = await import('../smoke/support/world-bench.mjs');
        const server = await resolveServer();
        let browser;
        try {
            browser = await launchBenchBrowser();
            const { page, errors } = await openWorld(browser, { baseUrl: server.baseUrl, scenario: 'readme-showcase',
                width: 1440, height: 900, query: { renderer: 'webgpu', frontier: 1 } });
            await poseWorld(page, { hour: 12, tile: [32, 20], zoom: 2 });
            await page.evaluate(() => window.__claudeVilleApp.renderer.gpuWorld.qualityLadder.setOverride(0));
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
                    // Real RGBA8 pages, with the first texel of each crop at exactly H=32.
                    const landmark = async (prototype, name, x, y, sublayerRank) => {
                        const response = await fetch('/assets/sprites/buildings/building.' + name + '/base.surface.png');
                        const image = await createImageBitmap(await response.blob(), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
                        return { ...prototype, surfaceSource: image, surfaceOffset: [x, y], sublayerRank };
                    };
                    const forge = await landmark(near, 'forge', 20, 133, 4);
                    const command = await landmark(far, 'command', 100, 127, 2);
                    const pagePixels = async records => {
                        draw(records);
                        return Array.from((await w.debugCaptureTargets()).scene);
                    };
                    const realFirst = await pagePixels([forge, command]);
                    const realReversed = await pagePixels([command, forge]);
                    const realWinner = await pagePixels([forge]);
                    const fullPages = [];
                    for (const [name, landmark] of [['forge', forge], ['command', command]]) {
                        const response = await fetch('/assets/sprites/buildings/building.' + name + '/base.png');
                        const base = await createImageBitmap(await response.blob());
                        const { width, height } = base;
                        const overlay = new OffscreenCanvas(width, height);
                        const ctx = overlay.getContext('2d');
                        ctx.drawImage(base, 0, 0);
                        ctx.globalCompositeOperation = 'source-in';
                        ctx.fillStyle = '#48bfe0';
                        ctx.fillRect(0, 0, width, height);
                        const under = { ...landmark, textureKey: name + '-albedo', source: base, sourceWidth: width, sourceHeight: height,
                            width, height, surfaceOffset: [0, 0], surfaceKey: landmark.textureKey, sublayerRank: 0 };
                        const over = { ...under, textureKey: name + '-overlay', source: overlay, sublayerRank: 1 };
                        w.resize(width, height);
                        const forward = await pagePixels([under, over]), backward = await pagePixels([over, under]);
                        const baseOnly = await pagePixels([under]);
                        fullPages.push({ name, differs: forward.some((byte, i) => byte !== backward[i]),
                            overlayVisible: forward.some((byte, i) => byte !== baseOnly[i]) });
                        base.close();
                    }
                    w.resize(8, 8);
                    forge.surfaceSource.close();
                    command.surfaceSource.close();
                    const device = w.device;
                    device.destroy();
                    await device.lost;
                    const lost = w.getDiagnostics().frontier;
                    if (!await w._rebuildDevice()) throw Error(w.deviceRebuildError);
                    await prepare();
                    return { first, reversed, farAlone, flat, realFirst, realReversed, realWinner, fullPages,
                        lostBytes: lost.logicalBytes, rebuilt: await pixel([far, near]), failure: w.failure };
                } finally { w.dispose(); }
            });
            assert.deepEqual(result.realFirst, result.realReversed);
            assert.ok(result.fullPages.every(p => !p.differs && p.overlayVisible), JSON.stringify(result.fullPages));
            assert.deepEqual(result.realFirst.slice(136, 140), result.realWinner.slice(136, 140));
            assert.ok(result.realWinner[136] > result.realWinner[138]);
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

test('Harbor mirror, clean bed, two-step ripple and shaft occlusion on hardware',
    { skip: !process.env.CLAUDEVILLE_TEST_FRONTIER_GPU, timeout: 240000 }, async t => {
        const { launchBenchBrowser, openWorld, poseWorld, resolveServer } = await import('../smoke/support/world-bench.mjs');
        const server = await resolveServer();
        let browser;
        try {
            browser = await launchBenchBrowser();
            const { page, errors } = await openWorld(browser, { baseUrl: server.baseUrl, scenario: 'readme-showcase',
                width: 1920, height: 1080, query: { renderer: 'webgpu', frontier: 1 } });
            await poseWorld(page, { hour: 22, tile: [32, 20], zoom: 2 });
            await page.evaluate(() => window.__claudeVilleApp.renderer.gpuWorld.qualityLadder.setOverride(0));
            await page.waitForFunction(() => {
                const w = window.__claudeVilleApp.renderer.gpuWorld;
                const d = w.getDiagnostics().frontier;
                for (const entry of Object.values(d.passes)) if (entry.error) throw Error(entry.error);
                return d.featureMask === 31 && w._waterBed && w._mirrorBuffer && w._frontierPasses.get('mirror').pass._mirrorClearCount > 1;
            }, null, { timeout: 90000 });
            const metrics = await page.evaluate(async () => {
                const renderer = window.__claudeVilleApp.renderer;
                renderer._stopLoop();
                const w = renderer.gpuWorld, device = w.device;
                const { WaterRippleCompute } = await import('/src/presentation/character-mode/gpu/wgpu/WaterRippleCompute.js');
                const read = async (texture, bytesPerPixel = 4) => {
                    const stride = Math.ceil(texture.width * bytesPerPixel / 256) * 256;
                    const buffer = device.createBuffer({ size: stride * texture.height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
                    try {
                        const enc = device.createCommandEncoder();
                        enc.copyTextureToBuffer({ texture }, { buffer, bytesPerRow: stride }, [texture.width, texture.height]);
                        device.queue.submit([enc.finish()]);
                        await buffer.mapAsync(GPUMapMode.READ);
                        return new Uint8Array(buffer.getMappedRange().slice(0));
                    } finally { buffer.destroy(); }
                };

                const ripple = new WaterRippleCompute({ width: 32, height: 32 });
                let impulseCells, steps;
                try {
                    await ripple.prepare(device);
                    ripple.queueImpulse({ x: 15, y: 15, radius: 2, strength: 1 });
                    const enc = device.createCommandEncoder();
                    steps = ripple.encode(enc, { dtSec: 2 / 30 }).steps;
                    device.queue.submit([enc.finish()]);
                    const half = new Uint16Array((await read(ripple.getReadTexture(), 8)).buffer);
                    impulseCells = half.filter((v, i) => i % 4 === 0 && (v & 0x7fff) > 0).length;
                } finally { ripple.release(); }

                const mask = w._waterInputs;
                const frame = renderer._gpuRenderContext;
                const terrain = frame.records.find(r => r.id === 'terrain:static');
                const records = frame.records.filter(r => r.mirrorColumns);
                const draw = () => {
                    const enc = device.createCommandEncoder();
                    w._encodeFrontierWater(enc, records, w.sceneTarget, false, { reducedMotion: true });
                    device.queue.submit([enc.finish()]);
                };
                const mirror = w._frontierPasses.get('mirror').pass;
                // Clear to a distinctive bed, then run the production resolve with real Harbor columns.
                const base = device.createCommandEncoder();
                base.beginRenderPass({ colorAttachments: [{ view: w.sceneTarget.color.view, loadOp: 'clear', storeOp: 'store',
                    clearValue: [0.25, 0.5, 0.75, 1] }] }).end();
                device.queue.submit([base.finish()]);
                const before = await read(w.sceneTarget.color.texture);
                draw();
                const staging = w._mirrorStaging;
                const groups = w._mirrorBatches.map(batch => batch.bindGroup);
                const after = await read(w.sceneTarget.color.texture);
                const night = await read(mirror.colorTexture);
                const { cameraScale: k, cameraXy: [cx, cy] } = w._frameState;
                const [rx, ry, rw, rh] = mask.planarRect;
                let outside = 0, outsideChanged = 0, insideChanged = 0;
                const stride = Math.ceil(w.width * 4 / 256) * 256;
                for (let y = 0; y < w.height; y++) for (let x = 0; x < w.width; x++) {
                    const xx = Math.floor((x + 0.5) / k - cx) - rx;
                    const yy = Math.floor((w.height - y - 0.5) / k - cy) - ry;
                    const i = y * stride + x * 4;
                    const changed = before[i] !== after[i] || before[i + 1] !== after[i + 1] || before[i + 2] !== after[i + 2];
                    if (xx < 0 || xx >= rw || yy < 0 || yy >= rh || !mask.mask[yy * rw + xx]) {
                        outside++;
                        if (changed) outsideChanged++;
                    } else if (changed) insideChanged++;
                }
                Object.assign(w._frameState, { gradeGain: [1, 1, 1], gradeExposure: 1, gradeSaturation: 1,
                    gradeLift: [0, 0, 0], gradeGamma: [1, 1, 1], gradeHighlight: [1, 1, 1], gradeShadow: [1, 1, 1] });
                draw();
                const mirrorCacheReused = staging === w._mirrorStaging && groups.length > 0 && groups.length === w._mirrorBatches.length
                    && groups.every((group, i) => group === w._mirrorBatches[i].bindGroup);
                const neutral = await read(mirror.colorTexture);
                let hits = 0, nightLuma = 0, neutralLuma = 0;
                for (let i = 0; i < night.length; i += 4) if (night[i + 3]) {
                    hits++;
                    nightLuma += night[i] + 2 * night[i + 1] + night[i + 2];
                    neutralLuma += neutral[i] + 2 * neutral[i + 1] + neutral[i + 2];
                }

                const { detectPilingTips } = await import('/src/presentation/character-mode/CoastBake.js');
                const harbor = records.find(r => r.mirrorProxy);
                const pixelsOf = source => {
                    const canvas = new OffscreenCanvas(source.width, source.height);
                    const ctx = canvas.getContext('2d');
                    ctx.drawImage(source, 0, 0);
                    return ctx.getImageData(0, 0, canvas.width, canvas.height).data;
                };
                const artWidth = harbor.sourceWidth, artHeight = harbor.sourceHeight;
                const tips = detectPilingTips({ w: artWidth, h: artHeight, data: pixelsOf(harbor.source) });
                const underside = pixelsOf(harbor.mirrorProxy.source);
                let joists = 0, clippedJoists = 0;
                for (let i = 0; i < artWidth * artHeight; i++) if (underside[i * 4 + 3] >= 128) {
                    joists++;
                    const row = Math.floor(i / artWidth);
                    if (!harbor.mirrorColumns[i % artWidth].some(s => row >= s.start && row < s.end && row < s.foot)) clippedJoists++;
                }
                const state = w._frameState;
                const saved = { cameraXy: state.cameraXy, cameraScale: state.cameraScale, basinParams: state.basinParams };
                let checkedFeet = 0, detachedFeet = 0;
                for (const [pan, zoom, tide] of [[0, 1, 0], [0.375, 2, 1], [-0.5, 3, 2], [0.25, 2, -2]]) {
                    const cameraXy = [w.width / (2 * zoom) - rx - rw / 2 + pan, w.height / (2 * zoom) - ry - rh / 2 - pan];
                    Object.assign(state, { cameraXy, cameraScale: zoom, basinParams: [tide, 2, 8, 2] });
                    draw();
                    const reflection = await read(mirror.colorTexture);
                    const stride = Math.ceil(mirror.width * 4 / 256) * 256;
                    for (const tip of tips) for (let j = 0; j < tip.run; j++) {
                        const x = harbor.x - harbor.sx + tip.sx + j - rx;
                        const y = harbor.y - harbor.sy + tip.colY[j] - Math.max(0, tide) - ry;
                        if (x < 0 || x >= rw || y < 0 || y + 1 >= rh) throw Error('piling outside mirror');
                        checkedFeet++;
                        if (!reflection[y * stride + 4 * x + 3] && !reflection[(y + 1) * stride + 4 * x + 3]) detachedFeet++;
                    }
                }
                Object.assign(state, saved);

                const shafts = w._frontierPasses.get('shafts').pass;
                const color = device.createTexture({ size: [64, 32], format: 'rgba8unorm',
                    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
                const depth = device.createTexture({ size: [64, 32], format: 'depth32float',
                    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
                const colorView = color.createView(), depthView = depth.createView();
                const lintelPipeline = device.createRenderPipeline({ layout: 'auto',
                    vertex: { module: device.createShaderModule({ code: `
                        @vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
                            return vec4f(array<vec2f, 3>(vec2f(-1,-1), vec2f(3,-1), vec2f(-1,3))[i], 0.25, 1);
                        }` }), entryPoint: 'vs' },
                    depthStencil: { format: 'depth32float', depthCompare: 'always', depthWriteEnabled: true } });
                const shaftHits = async lintel => {
                    const enc = device.createCommandEncoder();
                    enc.beginRenderPass({ colorAttachments: [{ view: colorView, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] }],
                        depthStencilAttachment: { view: depthView, depthLoadOp: 'clear', depthStoreOp: 'store', depthClearValue: 1 } }).end();
                    if (lintel) {
                        const pass = enc.beginRenderPass({ colorAttachments: [],
                            depthStencilAttachment: { view: depthView, depthLoadOp: 'load', depthStoreOp: 'store' } });
                        pass.setPipeline(lintelPipeline);
                        pass.setScissorRect(20, 0, 12, 32);
                        pass.draw(3);
                        pass.end();
                    }
                    shafts.encode(enc, { shafts: [{ originX: 4, originY: 15, reachX: 48, reachY: 0, apertureHalfW: 5, spread: 4,
                        intensity: 1, maxAlpha: 0.6, depthOriginD: 640, depthEndD: 360 }], sceneDepthView: depthView, depthView,
                        colorView, resolution: [64, 32], hasEmissionAttachment: false });
                    device.queue.submit([enc.finish()]);
                    const rgba = await read(color);
                    let behind = 0, beside = 0;
                    for (let i = 3; i < rgba.length; i += 4) if (rgba[i]) {
                        const x = Math.floor(i / 4) % 64;
                        if (x >= 20 && x < 32) behind++;
                        else beside++;
                    }
                    return { behind, beside };
                };
                let unoccluded, clipped;
                try { unoccluded = await shaftHits(false); clipped = await shaftHits(true); }
                finally { depth.destroy(); color.destroy(); }
                const receipt = [];
                for (const [width, height] of [[1920, 1080], [5120, 1440]]) {
                    w.resize(width, height);
                    w._gpuTimerRing = null;
                    const input = { ...frame, records: frame.records, forceFreshOutput: true };
                    for (let i = 0; i < 140; i++) {
                        w.render(input);
                        if (i % 4 === 3) await device.queue.onSubmittedWorkDone();
                    }
                    await w.drain();
                    const d = w.getDiagnostics();
                    receipt.push({ width: w.width, height: w.height, bytes: d.frontier.logicalBytes, totalBytes: d.resources.totalBytes,
                        p95Ms: d.frontier.gpuMsP95, samples: d.timestamps.samples, mask: d.frontier.featureMask });
                }
                const emberCapacity = w._frontierPasses.get('wind').pass.getEmberBuffer().size / 32;
                w.gpuMsP95 = 20;
                w._frontierWindow = 30;
                w.render({ ...frame, forceFreshOutput: true });
                const shed = w.getDiagnostics().frontier;
                w.setFrontierConfig({ enabled: false });
                w.render({ ...frame, forceFreshOutput: true });
                const ultraLedgerDelta = receipt.at(-1).totalBytes - w.getResourceAccounting().totalBytes;
                return { steps, impulseCells, hits, nightLuma, neutralLuma, outside, outsideChanged, insideChanged, emberCapacity,
                    ultraLedgerDelta, mirrorCacheReused, shed: shed.policy.shed, shedMask: shed.featureMask,
                    checkedFeet, detachedFeet, joists, clippedJoists, unoccluded, clipped, receipt, adapter: w.adapterInfo, terrain: terrain?.id };
            });
            assert.equal(metrics.steps, 2);
            assert.ok(metrics.impulseCells > 4, JSON.stringify(metrics));
            assert.ok(metrics.hits > 1000 && metrics.nightLuma < 0.8 * metrics.neutralLuma, JSON.stringify(metrics));
            assert.ok(metrics.outside > 10000 && metrics.insideChanged > 1000);
            assert.equal(metrics.outsideChanged, 0);
            assert.ok(metrics.mirrorCacheReused);
            assert.ok(metrics.checkedFeet > 0 && metrics.joists > 19000);
            assert.equal(metrics.detachedFeet, 0);
            assert.equal(metrics.clippedJoists, 0);
            assert.ok(metrics.unoccluded.behind > 0 && metrics.unoccluded.beside > 0);
            assert.equal(metrics.clipped.behind, 0);
            assert.equal(metrics.clipped.beside, metrics.unoccluded.beside);
            assert.equal(metrics.emberCapacity, 4096);
            assert.equal(metrics.shed, 'shafts');
            assert.equal(metrics.shedMask & 20, 4);
            assert.ok(metrics.ultraLedgerDelta > 0 && metrics.ultraLedgerDelta < 28.07 * 1024 ** 2);
            assert.ok(metrics.receipt.every(row => row.bytes < 28.07 * 1024 ** 2 && row.samples > 0 && row.p95Ms > 0));
            t.diagnostic(JSON.stringify(metrics));
            assert.deepEqual(errors, []);
        } finally { await browser?.close(); await server.stop(); }
    });

test('idle Forge banks its furnace at noon and a second Frontier boot restores the same substrate',
    { skip: !process.env.CLAUDEVILLE_TEST_FRONTIER_GPU, timeout: 180000 }, async t => {
        const { launchBenchBrowser, openWorld, poseWorld, resolveServer } = await import('../smoke/support/world-bench.mjs');
        const server = await resolveServer();
        let browser;
        try {
            browser = await launchBenchBrowser();
            const { page, errors } = await openWorld(browser, { baseUrl: server.baseUrl, scenario: 'no-agents',
                width: 1440, height: 900, reducedMotion: true, query: { renderer: 'webgpu', frontier: 1 } });
            await poseWorld(page, { hour: 12, zoom: 2, tile: [28, 27.5] });
            await page.evaluate(() => window.__claudeVilleApp.renderer.gpuWorld.qualityLadder.setOverride(0));
            await page.waitForFunction(() => {
                const r = window.__claudeVilleApp.renderer;
                return r._terrainArtifactStats?.writes && (r.gpuWorld.getDiagnostics().frontier.featureMask & 4)
                    && r._gpuRenderContext.records.some(rec => rec.id.startsWith('building.forge') && rec.id.endsWith(':part:banked'));
            }, null, { timeout: 65000 });
            const forgeResult = await page.evaluate(async () => {
                const r = window.__claudeVilleApp.renderer, w = r.gpuWorld;
                r._stopLoop();
                const frame = r._gpuRenderContext;
                const forge = frame.records.filter(rec => rec.id.startsWith('building.forge'));
                const draw = async records => {
                    w.render({ ...frame, records, forceFreshOutput: true });
                    return (await w.debugCaptureTargets()).scene;
                };
                const idle = await draw(forge);
                const hot = await draw(forge.filter(rec => !rec.id.endsWith(':part:banked')));
                let cooled = 0;
                for (let i = 0; i < hot.length; i += 4) {
                    if (hot[i] > 180 && hot[i] - hot[i + 2] > 80 && idle[i] < hot[i] - 50) cooled++;
                }
                const { buildGpuWorldRecords } = await import('/src/presentation/character-mode/gpu/GpuSceneBuilder.js');
                const slices = [];
                const buildings = r.buildingRenderer;
                buildings._openFrontActive = 'forge;';
                buildings._appendOpenFrontDrawables(slices);
                const drawables = slices.map(payload => ({ kind: payload.kind, sortY: payload.sortY, payload }));
                const arch = buildGpuWorldRecords(r, { drawables }).filter(rec => rec.id.startsWith('prop:forge-open-front'));
                const first = forge.find(rec => rec.surfacePage && !rec.id.includes(':part:'));
                const registered = arch.every(rec => rec.surfaceSource === first.surfaceSource && rec.sublayerRank > first.sublayerRank
                    && rec.surfaceOffset[0] + rec.sx === rec.x - (first.x - first.sx)
                    && rec.surfaceOffset[1] + rec.sy === rec.y - (first.y - first.sy));
                return { cooled, slices: arch.length, registered };
            });
            assert.ok(forgeResult.cooled > 1000, 'banked overlay did not cover the furnace');
            assert.ok(forgeResult.slices > 0 && forgeResult.registered, JSON.stringify(forgeResult));
            await page.reload({ waitUntil: 'load' });
            await page.waitForFunction(() => window.__claudeVilleApp?.renderer?._terrainArtifactStats?.hits > 0, null, { timeout: 65000 });
            const warm = await page.evaluate(() => {
                const r = window.__claudeVilleApp.renderer;
                return { ...r._terrainArtifactStats, revision: r.gpuWorld.substrateRevision };
            });
            assert.equal(warm.bakes, 0);
            assert.equal(warm.revision, 1);
            assert.deepEqual(errors, []);
            t.diagnostic(JSON.stringify({ ...forgeResult, warm }));
        } finally { await browser?.close(); await server.stop(); }
    });
