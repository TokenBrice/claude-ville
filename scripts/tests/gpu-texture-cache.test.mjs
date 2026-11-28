import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
    GpuTextureCacheState,
    STALE_COLD_FRAMES,
    agentModelSheetGroupKey,
    isAgentModelCellKey,
    isEvictableAgentTexture,
    selectEvictionCandidates,
    textureCacheFamily,
} from '../../claudeville/src/presentation/character-mode/gpu/GpuTextureCache.js';
import { GpuWorldRenderer, evictableAgentTexture } from '../../claudeville/src/presentation/character-mode/gpu/GpuWorldRenderer.js';
import { GpuWorldRendererWebGPU } from '../../claudeville/src/presentation/character-mode/gpu/GpuWorldRendererWebGPU.js';
import { buildStableGpuBatches } from '../../claudeville/src/presentation/character-mode/gpu/GpuWorldPolicy.js';
import { GpuAlbedoPage } from '../../claudeville/src/presentation/character-mode/gpu/GpuAlbedoPage.js';
import {
    clearLayerCaches,
    finishAgentLayerFrame,
    layerCacheStats,
    preferAgentModelCells,
} from '../../claudeville/src/presentation/character-mode/AgentLayerRecords.js';

function fakeGl() {
    let nextId = 1;
    const deleted = [];
    const fullUploads = [];
    const subUploads = [];
    const gl = {
        TEXTURE_2D: 0x0de1,
        TEXTURE_2D_ARRAY: 0x8c1a,
        TEXTURE0: 0x84c0,
        READ_FRAMEBUFFER: 0x8ca8,
        READ_FRAMEBUFFER_BINDING: 0x8caa,
        COLOR_ATTACHMENT0: 0x8ce0,
        TEXTURE_MIN_FILTER: 0x2801,
        TEXTURE_MAG_FILTER: 0x2800,
        TEXTURE_WRAP_S: 0x2802,
        TEXTURE_WRAP_T: 0x2803,
        NEAREST: 0x2600,
        CLAMP_TO_EDGE: 0x812f,
        UNPACK_PREMULTIPLY_ALPHA_WEBGL: 0x9241,
        UNPACK_FLIP_Y_WEBGL: 0x9240,
        UNPACK_ALIGNMENT: 0x0cf5,
        UNPACK_ROW_LENGTH: 0x0cf2,
        UNPACK_SKIP_PIXELS: 0x0cf4,
        UNPACK_SKIP_ROWS: 0x0cf3,
        RGBA: 0x1908,
        RGBA8: 0x8058,
        UNSIGNED_BYTE: 0x1401,
        TEXTURE_BINDING_2D: 0x8069,
        getParameter: () => null,
        isTexture: () => true,
        createTexture: () => ({ id: nextId++ }),
        createFramebuffer: () => ({}),
        deleteTexture: (tex) => { deleted.push(tex); },
        activeTexture() {},
        bindTexture() {},
        bindFramebuffer() {},
        framebufferTexture2D() {},
        texParameteri() {},
        pixelStorei() {},
        texImage2D(...args) { fullUploads.push(args); },
        texSubImage2D(...args) { subUploads.push(args); },
        texImage3D() {},
        copyTexSubImage3D() {},
    };
    return { gl, deleted, fullUploads, subUploads };
}

function makeWebGlStub() {
    const { gl, deleted, fullUploads, subUploads } = fakeGl();
    const renderer = Object.create(GpuWorldRenderer.prototype);
    Object.assign(renderer, {
        gl,
        contextHealthy: true,
        suspended: false,
        frames: 0,
        uploads: 0,
        uploadBytes: 0,
        textureBytes: 0,
        textureEvictions: 0,
        _frameUploadMs: 0,
        _textureEntries: new Map(),
        _textureCacheState: new GpuTextureCacheState(),
        _cachedTextureBytes: 0,
        _textureCacheNeedsTrim: false,
        _lastTextureTrimFrame: 0,
        _updateTextureBytes() { this.textureBytes = this._cachedTextureBytes; },
    });
    return { renderer, gl, deleted, fullUploads, subUploads };
}

function makeWebGpuStub() {
    const previousUsage = globalThis.GPUTextureUsage;
    globalThis.GPUTextureUsage = {
        COPY_SRC: 1,
        COPY_DST: 2,
        TEXTURE_BINDING: 4,
        RENDER_ATTACHMENT: 16,
    };
    let nextId = 1;
    const created = [];
    const destroyed = [];
    const copies = [];
    const writes = [];
    const device = {
        createTexture(desc) {
            const tex = {
                id: nextId++,
                label: desc.label,
                destroyed: false,
                createView: () => ({ textureId: tex.id }),
                destroy() {
                    this.destroyed = true;
                    destroyed.push(this);
                },
            };
            created.push(tex);
            return tex;
        },
        queue: {
            copyExternalImageToTexture(src, dst, size) {
                copies.push({ src, dst, size });
            },
            writeTexture(dst, data, layout, size) {
                writes.push({ dst, data, layout, size });
            },
        },
    };
    const renderer = Object.create(GpuWorldRendererWebGPU.prototype);
    Object.assign(renderer, {
        device,
        contextHealthy: true,
        suspended: false,
        width: 100,
        height: 100,
        presentFormat: 'bgra8unorm',
        frames: 0,
        uploads: 0,
        uploadBytes: 0,
        _uploadByteKinds: { wholeImages: 0, imagePatches: 0, albedoPage: 0, typedFields: 0, lightRecords: 0 },
        textureBytes: 0,
        textureEvictions: 0,
        _frameUploadMs: 0,
        _textureEntries: new Map(),
        _textureCacheState: new GpuTextureCacheState(),
        _deferredDestroyTextures: [],
        _frontierPasses: new Map(),
        _surfaceGroups: new Map(),
        _batchBindGroups: new Map(),
        _cachedTextureBytes: 0,
        _textureCacheNeedsTrim: false,
        _lastTextureTrimFrame: 0,
        _frontierDiagnostics: () => ({ passOwnedBytes: 0 }),
        _updateTextureBytes() { this.textureBytes = this._cachedTextureBytes; },
    });
    const cleanup = () => {
        if (previousUsage === undefined) delete globalThis.GPUTextureUsage;
        else globalThis.GPUTextureUsage = previousUsage;
    };
    return { renderer, device, created, destroyed, copies, writes, cleanup };
}

test('textureCacheFamily classifies all families and sidecars consistently', () => {
    const cases = [
        ['world-pilot', 'world-pilot'],
        ['occluder:world-pilot:channels', 'world-pilot'],
        ['terrain:static', 'terrain'],
        ['material:terrain:static', 'terrain'],
        ['ground:semantics', 'terrain'],
        ['agent-model:agent.claude.sonnet||false|1|2|3|4|false', 'agent-model-sheet'],
        ['material:agent.claude.sonnet||false|1|2|3|4|false', 'agent-model-sheet'],
        ['agent-model:agent.claude.sonnet||false|1|2|3|4|false|cell:92,0', 'agent-model-cell'],
        ['emissive:agent.claude.sonnet||false|1|2|3|4|false|cell:92,0', 'agent-model-cell'],
        ['agent-frame-atlas', 'agent-frame-atlas'],
        ['agent-sheet:foo', 'agent-legacy-sheet'],
        ['agent-ground:shadow|a', 'agent-layer'],
        ['hat|crown|1|false', 'agent-layer'],
        ['weaponFront|codex|1', 'agent-layer'],
        ['building.forge', 'building'],
        ['building-ground-shadow:building.forge', 'building'],
        ['occluder:proc:building.forge.roomGlassLit:channels', 'building'],
        ['prop-cache:lantern:1,2', 'prop'],
        ['tree:oak|0|summer|0', 'prop'],
        ['offshore:buoy-1', 'prop'],
        ['harbor-collar:skiff|c0', 'prop'],
        ['tide-wet:0:0', 'terrain'],
        ['frontier:contacts', 'frontier'],
        ['field:coast', 'field'],
        ['light:tiles', 'light'],
        ['lut:palette-ramp', 'lut'],
        ['mark:badge', 'mark'],
        ['albedo-page', 'albedo-page'],
        ['custom:unknown', 'other'],
    ];
    for (const [key, expected] of cases) {
        assert.equal(textureCacheFamily(key), expected, `family for ${key}`);
    }
});

test('evictableAgentTexture allows live full sheets while protecting live model cells', () => {
    assert.equal(isEvictableAgentTexture('agent-model:agent.claude.sonnet||false|1|2|3|4|false'), true);
    assert.equal(evictableAgentTexture('material:agent.claude.sonnet||false|1|2|3|4|false'), true);
    assert.equal(evictableAgentTexture('agent-strip:profile:walk'), true);
    assert.equal(isAgentModelCellKey('agent-model:agent.claude.sonnet||false|1|2|3|4|false|cell:92,0'), true);
    assert.equal(evictableAgentTexture('agent-model:agent.claude.sonnet||false|1|2|3|4|false|cell:92,0'), false);
    assert.equal(evictableAgentTexture('material:agent.claude.sonnet||false|1|2|3|4|false|cell:92,0'), false);
    assert.equal(agentModelSheetGroupKey('emissive:agent.claude.sonnet||false|1|2|3|4|false'), 'agent.claude.sonnet||false|1|2|3|4|false');
    assert.equal(agentModelSheetGroupKey('agent-model:agent.claude.sonnet||false|1|2|3|4|false|cell:0,0'), null);
});

test('tiered eviction demotes full model sheets before thrashing warm model cells and never evicts live cells', () => {
    const MiB = 1024 * 1024;
    const protectedFrame = 100;
    const entries = new Map([
        ['world-pilot', { bytes: 100 * MiB, lastUsedFrame: 100 }],
        ['stale-prop', { bytes: 1 * MiB, lastUsedFrame: protectedFrame - STALE_COLD_FRAMES - 5 }],
        ['agent-model:agent.claude.sonnet||false|1|2|3|4|false', { bytes: 4 * MiB, lastUsedFrame: 100 }],
        ['material:agent.claude.sonnet||false|1|2|3|4|false', { bytes: 4 * MiB, lastUsedFrame: 100 }],
        ['agent-model:agent.codex.gpt54||false|1|2|3|4|false|cell:0,0', { bytes: 33 * 1024, lastUsedFrame: 99 }],
        ['agent-model:agent.codex.gpt54||false|1|2|3|4|false|cell:92,0', { bytes: 33 * 1024, lastUsedFrame: 100 }],
        ['building.recent-cold', { bytes: 2 * MiB, lastUsedFrame: 95 }],
    ]);
    const ordered = selectEvictionCandidates(entries, { protectedFrame, overBytes: true }).map(c => c.key);
    assert.deepEqual(ordered, [
        'stale-prop',
        'agent-model:agent.claude.sonnet||false|1|2|3|4|false',
        'material:agent.claude.sonnet||false|1|2|3|4|false',
        'building.recent-cold',
        'agent-model:agent.codex.gpt54||false|1|2|3|4|false|cell:0,0',
    ]);
    assert.equal(ordered.includes('agent-model:agent.codex.gpt54||false|1|2|3|4|false|cell:92,0'), false, 'live cell is never evicted');
    assert.equal(ordered.includes('world-pilot'), false, 'live non-agent atlas is never evicted');
});

test('both backends protect live model cells, demote full sheets under byte pressure, and preserve 160 MiB cap', () => {
    const MiB = 1024 * 1024;
    clearLayerCaches();
    const { renderer: glRenderer } = makeWebGlStub();
    const gpuStub = makeWebGpuStub();
    try {
        for (const renderer of [glRenderer, gpuStub.renderer]) {
            clearLayerCaches();
            renderer.frames = 10;
            renderer._textureCacheNeedsTrim = true;
            const addFake = (key, bytes, lastUsedFrame) => {
                const texture = { id: key, destroy() { this.destroyed = true; } };
                const backing = renderer._textureCache().createBacking({
                    key, texture, view: {}, width: 64, height: 64, format: 'rgba8', bytes,
                });
                const entry = { texture, view: {}, source: {}, revision: 1, width: 64, height: 64, bytes, format: 'rgba8', backing: null, lastUsedFrame };
                renderer._textureCache().attachEntry(key, entry, backing);
                renderer._textureEntries.set(key, entry);
                renderer._cachedTextureBytes += bytes;
            };
            addFake('world-pilot', 110 * MiB, 11);
            addFake('agent-model:agent.claude.sonnet||false|1|2|3|4|false', 15 * MiB, 11);
            addFake('material:agent.claude.sonnet||false|1|2|3|4|false', 15 * MiB, 11);
            addFake('agent-model:agent.codex.gpt54||false|1|2|3|4|false|cell:0,0', 64 * 1024, 10);
            addFake('agent-model:agent.codex.gpt54||false|1|2|3|4|false|cell:92,0', 64 * 1024, 11);
            renderer.textureBytes = renderer._cachedTextureBytes + 35 * MiB;
            renderer._updateTextureBytes = () => { renderer.textureBytes = renderer._cachedTextureBytes + 35 * MiB; };
            renderer._trimTextureCache();

            // Full sheets evicted first; warm cold cell AND live cell survive because
            // freeing the two 15 MiB sheets drops total below 160 MiB!
            assert.equal(renderer._textureEntries.has('agent-model:agent.claude.sonnet||false|1|2|3|4|false'), false);
            assert.equal(renderer._textureEntries.has('material:agent.claude.sonnet||false|1|2|3|4|false'), false);
            assert.equal(renderer._textureEntries.has('agent-model:agent.codex.gpt54||false|1|2|3|4|false|cell:0,0'), true);
            assert.equal(renderer._textureEntries.has('agent-model:agent.codex.gpt54||false|1|2|3|4|false|cell:92,0'), true);
            assert.ok(renderer.textureBytes <= 160 * MiB);

            const diag = renderer._textureCache().getDiagnostics({
                cachedKeys: renderer._textureEntries.size,
                cachedBytes: renderer._cachedTextureBytes,
            });
            assert.equal(diag.families['agent-model-sheet'].evictions, 2);
            assert.equal(diag.families['agent-model-sheet'].liveEvictions, 2);
            assert.equal(diag.families['agent-model-cell'].evictions, 0);
            assert.equal(layerCacheStats().sheetPressureActive, true);
        }
    } finally {
        clearLayerCaches();
        gpuStub.cleanup();
    }
});

test('identical immutable sources share one GPU texture backing across keys with ref-counted destruction', () => {
    const glStub = makeWebGlStub();
    const gpuStub = makeWebGpuStub();
    try {
        // WebGL2
        {
            const { renderer, deleted, fullUploads } = glStub;
            const sharedCanvas = { width: 32, height: 16, __cvImmutable: true };
            const t1 = renderer._textureFor('occluder:building.forge:glass', sharedCanvas, 'v1:glass');
            const t2 = renderer._textureFor('occluder:proc:building.forge.roomGlassLit:channels', sharedCanvas, 'v1:lit:step1');
            // Different revision on same immutable source still reuses backing with zero extra upload.
            const t3 = renderer._textureFor('occluder:proc:building.forge.roomGlassLit:channels', sharedCanvas, 'v1:lit:step2');
            assert.equal(t1, t2);
            assert.equal(t2, t3);
            assert.equal(fullUploads.length, 1);
            assert.equal(renderer.uploads, 1);
            assert.equal(renderer._cachedTextureBytes, 32 * 16 * 4);
            const diag = renderer._textureCache().getDiagnostics({
                cachedKeys: renderer._textureEntries.size,
                cachedBytes: renderer._cachedTextureBytes,
            });
            assert.equal(diag.uniqueBackings, 1);
            assert.equal(diag.aliasedKeys, 1);
            assert.equal(diag.sourceReuses, 1);
            assert.equal(diag.savedAliasBytes, 32 * 16 * 4);

            // Resource accounting charges the shared backing once.
            renderer.frames = 1;
            const res = renderer.getResourceAccounting();
            assert.equal(res.textures.pinnedSources + res.textures.evictableSources, 32 * 16 * 4);

            // Evict one alias key: backing stays alive, texture NOT deleted.
            const entryA = renderer._textureEntries.get('occluder:building.forge:glass');
            const r1 = renderer._textureCache().detachEntry('occluder:building.forge:glass', entryA, { removeEntry: true });
            assert.equal(r1.destroyedTexture, null);
            assert.equal(r1.freedBytes, 0);
            assert.equal(deleted.length, 0);
            renderer._textureEntries.delete('occluder:building.forge:glass');

            // Evict second alias key: refCount hits 0 -> texture destroyed once.
            const entryB = renderer._textureEntries.get('occluder:proc:building.forge.roomGlassLit:channels');
            const r2 = renderer._textureCache().detachEntry('occluder:proc:building.forge.roomGlassLit:channels', entryB, { removeEntry: true });
            assert.equal(r2.destroyedTexture, t1);
            assert.equal(r2.freedBytes, 32 * 16 * 4);
        }

        // WebGPU
        {
            const { renderer, created, destroyed, copies } = gpuStub;
            const sharedCanvas = { width: 32, height: 16, __cvImmutable: true };
            const v1 = renderer._textureFor('occluder:building.forge:glass', sharedCanvas, 'v1:glass');
            const v2 = renderer._textureFor('occluder:proc:building.forge.roomGlassLit:channels', sharedCanvas, 'v1:lit:step1');
            assert.equal(v1, v2);
            assert.equal(created.length, 1);
            assert.equal(copies.length, 1);
            assert.equal(renderer._cachedTextureBytes, 32 * 16 * 4);
            assert.equal(Object.values(renderer._uploadByteKinds).reduce((a, b) => a + b, 0), renderer.uploadBytes);

            // Release destroys the shared texture exactly once.
            renderer._releaseGpuResources();
            assert.equal(destroyed.length, 1);
            assert.equal(renderer._cachedTextureBytes, 0);
            assert.equal(renderer._textureCache().uniqueBackings, 0);
        }
    } finally {
        gpuStub.cleanup();
    }
});

test('mutable shared canvas copy-on-write detaches cleanly without mutating the other key', () => {
    const { renderer, fullUploads } = makeWebGlStub();
    const mutableCanvas = { width: 16, height: 16 };
    const t1 = renderer._textureFor('material:building.a:glass', mutableCanvas, 'rev-1');
    const t2 = renderer._textureFor('material:proc:building.a.roomGlassLit:channels', mutableCanvas, 'rev-1');
    assert.equal(t1, t2, 'same mutable canvas with identical revision shares backing');
    assert.equal(fullUploads.length, 1);

    // Key A advances to rev-2: must detach into its own fresh texture so Key B keeps rev-1 intact.
    const t1Next = renderer._textureFor('material:building.a:glass', mutableCanvas, 'rev-2');
    assert.notEqual(t1Next, t2);
    assert.equal(renderer._textureEntries.get('material:proc:building.a.roomGlassLit:channels').texture, t2);
    assert.equal(fullUploads.length, 2);
    assert.equal(renderer._cachedTextureBytes, 2 * 16 * 16 * 4);
});

test('same-frame re-uploads are recorded and WebGPU defers texture destruction until post-submit', () => {
    const gpuStub = makeWebGpuStub();
    try {
        const { renderer, destroyed } = gpuStub;
        const srcA = { width: 16, height: 16 };
        const srcB = { width: 16, height: 16 };
        renderer.frames = 5;
        const v1 = renderer._textureFor('building.forge', srcA, 1);
        const tex1 = renderer._textureEntries.get('building.forge').texture;
        // Same frame (frames === 5), different source under same key.
        const v2 = renderer._textureFor('building.forge', srcB, 2);
        assert.notEqual(v1, v2);
        assert.equal(tex1.destroyed, false, 'WebGPU must not destroy a texture already bound in the current unsubmitted frame');
        assert.equal(destroyed.length, 0);

        const diag = renderer._textureCache().getDiagnostics({
            cachedKeys: renderer._textureEntries.size,
            cachedBytes: renderer._cachedTextureBytes,
        });
        assert.equal(diag.sameFrameReuploads, 1);
        assert.equal(diag.families.building.sameFrameReuploads, 1);

        // Post-submit trim flushes the deferred destroy even when under cap.
        renderer._trimTextureCache();
        assert.equal(tex1.destroyed, true);
        assert.equal(destroyed.length, 1);
    } finally {
        gpuStub.cleanup();
    }
});

test('re-load correctness: unloaded images skip caching and src mutations force re-upload', () => {
    const { renderer, fullUploads } = makeWebGlStub();
    const img = { tagName: 'IMG', width: 64, height: 64, naturalWidth: 0, complete: false, src: 'a.png' };
    assert.equal(renderer._textureFor('building.hall', img, null), null, 'unloaded IMG must not be uploaded');
    assert.equal(fullUploads.length, 0);

    img.complete = true;
    img.naturalWidth = 64;
    const t1 = renderer._textureFor('building.hall', img, null);
    assert.ok(t1);
    assert.equal(fullUploads.length, 1);

    // Same IMG object reloaded with a new src of identical dimensions must re-upload!
    img.src = 'b.png';
    renderer.frames = 2;
    renderer._textureFor('building.hall', img, null);
    assert.equal(fullUploads.length, 2, 'mutated img.src must invalidate and re-upload');
    assert.equal(renderer._textureEntries.get('building.hall').src, 'b.png');
});

test('repeat evictions are tracked per family across eviction cycles', () => {
    const { renderer } = makeWebGlStub();
    const cache = renderer._textureCache();
    const key = 'agent-ground:shadow|walk|0';
    cache.recordEviction(key, 1024, { isLive: false });
    cache.recordEviction(key, 1024, { isLive: false });
    cache.recordEviction(key, 1024, { isLive: false });
    const diag = cache.getDiagnostics({ cachedKeys: 0, cachedBytes: 0 });
    assert.equal(diag.repeatEvictions, 2);
    assert.equal(diag.families['agent-layer'].evictions, 3);
    assert.equal(diag.families['agent-layer'].repeatEvictions, 2);
    assert.equal(diag.topEvictedFamilies[0].family, 'agent-layer');
});

test('preferAgentModelCells persists across brief pauses and resets cleanly on clearLayerCaches', () => {
    clearLayerCaches();
    try {
        preferAgentModelCells('agent-model:agent.claude.sonnet||false|1|2|3|4|false', { pressure: true });
        assert.equal(layerCacheStats().activeCellModels, 1);
        assert.equal(layerCacheStats().sheetPressureActive, true);
        // Previously expired after 2 frames; now persists across brief pauses / pan-away.
        for (let i = 0; i < 30; i++) finishAgentLayerFrame();
        assert.equal(layerCacheStats().activeCellModels, 1);
        assert.equal(layerCacheStats().sheetPressureActive, true);
        // Expires after TTL.
        for (let i = 0; i < 320; i++) finishAgentLayerFrame();
        assert.equal(layerCacheStats().activeCellModels, 0);
        assert.equal(layerCacheStats().sheetPressureActive, false);

        preferAgentModelCells('material:agent.codex.gpt54||false|1|2|3|4|false', { pressure: true });
        assert.equal(layerCacheStats().activeCellModels, 1);
        clearLayerCaches();
        assert.equal(layerCacheStats().activeCellModels, 0);
        assert.equal(layerCacheStats().sheetPressureActive, false);
    } finally {
        clearLayerCaches();
    }
});

test('GpuAlbedoPage recycles exact-size stale slots and reports page occupancy and same-frame reuploads', () => {
    const { gl } = fakeGl();
    const page = new GpuAlbedoPage(gl, 14);
    const rec = (textureKey, width, height, source = { width, height }, rev = 1) => ({
        textureKey, source, sourceWidth: width, sourceHeight: height, textureRevision: rev,
    });
    page.beginFrame(0);
    assert.equal(page.place(rec('seed', 250, 250)), null);
    assert.equal(page.repackIfOverflowed(), true);

    // Fill layer 0 with sixteen 250x250 slots (4x4 = 16 fit in 1024x1024 with 2px gutter).
    for (let i = 0; i < 16; i++) {
        assert.ok(page.place(rec(`slot:${i}`, 250, 250)), `slot ${i} fits`);
    }
    page.flushUploads();

    // Frame 1: slots 0..15 were used on frame 0 (frame - 1), so cannot be recycled yet.
    page.beginFrame(1);
    assert.equal(page.place(rec('too-soon', 250, 250)), null);

    // Frame 2: slots 0..15 are now older than frame - 1 (stale!), so exact-size recycling succeeds!
    page.beginFrame(2);
    const recycled = rec('replacement', 250, 250);
    assert.ok(page.place(recycled), 'stale exact-size slot recycled without overflow');
    assert.equal(page.overflowRecords, 0);
    assert.equal(page.recycledSlots, 1);

    // The first record keeps its slot when another revision uses the standalone texture.
    assert.equal(page.place(rec('replacement', 250, 250, { width: 250, height: 250 }, 2)), null);
    assert.equal(page.entries.get('replacement').source, recycled.source);
    assert.equal(page.sameFrameReuploads, 0);

    const diag = page.getDiagnostics();
    assert.equal(diag.recycledSlots, 1);
    assert.equal(diag.sameFrameReuploads, 0);
    assert.equal(diag.staleEntries, 15);
    assert.ok(diag.occupancy > 0.9);
    assert.ok(diag.staleShare > 0.9);
    assert.equal(diag.usedArea, diag.liveArea + diag.staleArea);

    // When stale entries outnumber live entries and a non-matching size overflows,
    // compaction runs at the shorter stale-dominated cooldown (15 frames, not 90).
    page.beginFrame(16);
    assert.equal(page.place(rec('different-size', 300, 300)), null);
    assert.equal(page.repackIfOverflowed(), true, 'stale-dominated page compacts after 15 frames');
    assert.equal(page.repacks, 2);
});

test('count-only pressure trims cold entries first and falls back to live eligible sheets to enforce MAX_CACHED_TEXTURES=512 on both backends', () => {
    const glStub = makeWebGlStub();
    const gpuStub = makeWebGpuStub();
    try {
        for (const [label, renderer] of [['webgl', glStub.renderer], ['webgpu', gpuStub.renderer]]) {
            clearLayerCaches();
            renderer._textureEntries.clear();
            renderer._textureCache().clearResident();
            renderer._cachedTextureBytes = 0;
            renderer.textureBytes = 0;
            renderer.textureEvictions = 0;
            renderer.frames = 10;

            const insertSheet = (key, bytes, lastUsedFrame) => {
                const texture = { id: key, destroyed: false, destroy() { this.destroyed = true; } };
                const backing = renderer._textureCache().createBacking({
                    key, texture, view: {}, width: 1, height: 1, format: 'rgba8', bytes,
                });
                const entry = {
                    texture, view: {}, source: {}, src: '', revision: 1,
                    width: 1, height: 1, bytes, format: 'rgba8', backing: null, lastUsedFrame,
                };
                renderer._textureCache().attachEntry(key, entry, backing);
                renderer._textureEntries.set(key, entry);
                renderer._cachedTextureBytes += bytes;
            };

            // Exact Council Astra repro: 513 live eligible sheet keys totaling 2,052 bytes
            // (well under 160 MiB byte cap), zero cold entries.
            for (let i = 0; i < 513; i++) {
                insertSheet(`agent-model:agent.claude.sonnet|s${i}|false|1|2|3|4|false`, 4, 11);
            }
            assert.equal(renderer._cachedTextureBytes, 2052);
            renderer.textureBytes = renderer._cachedTextureBytes;
            renderer._textureCacheNeedsTrim = true;
            renderer._trimTextureCache();

            assert.equal(renderer._textureEntries.size, 512, `${label}: 513 live eligible sheets must trim to 512`);
            assert.equal(renderer.textureEvictions, 1, `${label}: exactly 1 live sheet evicted`);
            assert.equal(renderer._cachedTextureBytes, 2048);
            const diag1 = renderer._textureCache().getDiagnostics({
                cachedKeys: renderer._textureEntries.size,
                cachedBytes: renderer._cachedTextureBytes,
            });
            assert.equal(diag1.liveEvictions, 1);
            assert.equal(diag1.families['agent-model-sheet'].evictions, 1);
            assert.equal(layerCacheStats().activeCellModels, 1, `${label}: evicted sheet marked for cell preference`);
            assert.equal(layerCacheStats().sheetPressureActive, false, `${label}: count-only trim does not arm global byte-pressure mode`);

            // Cold entries must still absorb count-only pressure BEFORE live eligible sheets.
            const evictedBefore = renderer.textureEvictions;
            const liveBefore = diag1.liveEvictions;
            insertSheet('prop-cache:cold-a:1,1', 64, 5);
            insertSheet('prop-cache:cold-b:1,2', 64, 6);
            assert.equal(renderer._textureEntries.size, 514);
            renderer.textureBytes = renderer._cachedTextureBytes;
            renderer._textureCacheNeedsTrim = true;
            renderer._trimTextureCache();

            assert.equal(renderer._textureEntries.size, 512, `${label}: cold entries trim count back to 512`);
            assert.equal(renderer._textureEntries.has('prop-cache:cold-a:1,1'), false);
            assert.equal(renderer._textureEntries.has('prop-cache:cold-b:1,2'), false);
            assert.equal(renderer.textureEvictions, evictedBefore + 2);
            const diag2 = renderer._textureCache().getDiagnostics({
                cachedKeys: renderer._textureEntries.size,
                cachedBytes: renderer._cachedTextureBytes,
            });
            assert.equal(diag2.liveEvictions, liveBefore, `${label}: zero live sheets evicted while cold entries satisfy count cap`);

            // Same-frame churn under count-only pressure: replacing an active key's source
            // mid-frame records sameFrameReuploads and never exceeds 512 after post-submit trim.
            renderer.frames = 11;
            const churnKey = 'agent-model:agent.claude.sonnet|churn|false|1|2|3|4|false';
            const src1 = { width: 2, height: 2 };
            const src2 = { width: 2, height: 2 };
            renderer._textureFor(churnKey, src1, 1);
            const firstTex = renderer._textureEntries.get(churnKey).texture;
            renderer._textureFor(churnKey, src2, 2);
            if (label === 'webgpu') {
                assert.equal(firstTex.destroyed, false, 'WebGPU defers same-frame replacement destroy until post-submit');
            }
            assert.equal(renderer._textureEntries.size, 513);
            renderer._trimTextureCache(12);
            if (label === 'webgpu') {
                assert.equal(firstTex.destroyed, true, 'WebGPU flushes deferred destroy at post-submit trim');
            }
            assert.equal(renderer._textureEntries.size, 512, `${label}: count cap holds after same-frame churn`);
            const diag3 = renderer._textureCache().getDiagnostics({
                cachedKeys: renderer._textureEntries.size,
                cachedBytes: renderer._cachedTextureBytes,
            });
            assert.equal(diag3.sameFrameReuploads, 1, `${label}: same-frame churn upload recorded`);
        }
    } finally {
        clearLayerCaches();
        gpuStub.cleanup();
    }
});

test('combined byte and count pressure stops live-sheet eviction once under byte cap and trims remaining cold entries first', () => {
    const MiB = 1024 * 1024;
    const glStub = makeWebGlStub();
    const gpuStub = makeWebGpuStub();
    try {
        for (const [label, renderer] of [['webgl', glStub.renderer], ['webgpu', gpuStub.renderer]]) {
            clearLayerCaches();
            renderer._textureEntries.clear();
            renderer._textureCache().clearResident();
            renderer._cachedTextureBytes = 0;
            renderer.textureBytes = 0;
            renderer.textureEvictions = 0;
            renderer.frames = 20;

            const add = (key, bytes, lastUsedFrame) => {
                const texture = { id: key, destroy() {} };
                const backing = renderer._textureCache().createBacking({
                    key, texture, view: {}, width: 1, height: 1, format: 'rgba8', bytes,
                });
                const entry = {
                    texture, view: {}, source: {}, src: '', revision: 1,
                    width: 1, height: 1, bytes, format: 'rgba8', backing: null, lastUsedFrame,
                };
                renderer._textureCache().attachEntry(key, entry, backing);
                renderer._textureEntries.set(key, entry);
                renderer._cachedTextureBytes += bytes;
            };

            // 508 pinned live entries totaling 150 MiB, 2 live sheets (12 MiB + 1 MiB -> over 160 MiB),
            // and 4 recent cold entries (64 B each) -> total 514 keys, 163 MiB.
            add('world-pilot', 150 * MiB, 21);
            for (let i = 0; i < 507; i++) add(`building.pinned.${i}`, 4, 21);
            add('agent-model:agent.claude.opus|big|false|1|2|3|4|false', 12 * MiB, 21);
            add('agent-model:agent.claude.sonnet|small|false|1|2|3|4|false', 1 * MiB, 21);
            for (let i = 0; i < 4; i++) add(`prop-cache:recent-cold:${i}`, 64, 20);

            renderer.textureBytes = renderer._cachedTextureBytes;
            renderer._textureCacheNeedsTrim = true;
            renderer._trimTextureCache();

            // Big 12 MiB sheet drops bytes under 160 MiB; the 1 MiB live sheet MUST survive
            // while 1 recent cold entry absorbs the remaining count trim (514 -> 513 -> 512).
            assert.equal(renderer._textureEntries.size, 512, `${label}: trimmed to 512`);
            assert.equal(renderer._textureEntries.has('agent-model:agent.claude.opus|big|false|1|2|3|4|false'), false);
            assert.equal(renderer._textureEntries.has('agent-model:agent.claude.sonnet|small|false|1|2|3|4|false'), true,
                `${label}: second live sheet preserved once bytes are under cap and cold entries exist`);
            assert.ok(renderer._cachedTextureBytes <= 160 * MiB);
        }
    } finally {
        clearLayerCaches();
        gpuStub.cleanup();
    }
});

test('Astra P1: shared backing sampled earlier in a frame stays alive and unmodified until post-submit on both backends', () => {
    const glStub = makeWebGlStub();
    const gpuStub = makeWebGpuStub();
    try {
        // 1. Exact Astra P1 immutable sequence:
        //    Frame 1: k1=A, k2=A (shared backing BA)
        //    Frame 2: k1=A (samples BA!), k1=B (detaches BA -> BB), k2=B (last ref to BA detaches!)
        //    BA must stay ALIVE and UNMODIFIED until post-submit _trimTextureCache!
        {
            const { renderer, destroyed, copies } = gpuStub;
            const imgA = { width: 16, height: 16, __cvImmutable: true };
            const imgB = { width: 16, height: 16, __cvImmutable: true };
            renderer.frames = 0;
            const vA1 = renderer._textureFor('building.k1', imgA, 1);
            const vA2 = renderer._textureFor('building.k2', imgA, 1);
            assert.equal(vA1, vA2);
            const texA = renderer._textureEntries.get('building.k1').texture;

            renderer.frames = 1; // Frame 2
            const batch1View = renderer._textureFor('building.k1', imgA, 1);
            assert.equal(batch1View, vA1);
            const batch2View = renderer._textureFor('building.k1', imgB, 1);
            assert.notEqual(batch2View, vA1);
            const batch3View = renderer._textureFor('building.k2', imgB, 1);
            assert.equal(batch3View, batch2View);

            // Before submit: texA MUST NOT be destroyed and MUST NOT have been written to with imgB!
            assert.equal(texA.destroyed, false, 'WebGPU: earlier view A backing must survive until post-submit');
            assert.equal(destroyed.includes(texA), false);
            assert.equal(copies.some(c => c.dst.texture === texA && c.src.source === imgB), false,
                'WebGPU: earlier view A backing must remain unmodified');

            // Post-submit trim destroys texA cleanly.
            renderer._trimTextureCache();
            assert.equal(texA.destroyed, true, 'WebGPU: deferred backing A is destroyed post-submit');
        }

        // 2. Copy-on-write sequence where k2 updates to a new whole revision while
        //    k1 already sampled BA earlier in the same frame (both WebGPU and WebGL2):
        //    Frame 1: k1=(C, rev1), k2=(C, rev1) -> shared BA
        //    Frame 2: k1=(C, rev1) [samples BA], k1=(C, rev2) [COW -> BB], k2=(C, rev3) [must NOT overwrite or destroy BA!]
        for (const [label, stub] of [['webgl', glStub], ['webgpu', gpuStub]]) {
            const { renderer } = stub;
            renderer._textureEntries.clear();
            renderer._textureCache().clearResident();
            renderer._cachedTextureBytes = 0;
            renderer.textureBytes = 0;
            if (stub.deleted) stub.deleted.length = 0;
            if (stub.destroyed) stub.destroyed.length = 0;
            if (stub.copies) stub.copies.length = 0;

            const canvasC = { width: 16, height: 16 };
            renderer.frames = 10;
            const handleA1 = renderer._textureFor('material:building.k1:glass', canvasC, 'rev1');
            const handleA2 = renderer._textureFor('material:building.k2:glass', canvasC, 'rev1');
            assert.equal(handleA1, handleA2);
            const texA = renderer._textureEntries.get('material:building.k1:glass').texture;

            renderer.frames = 11; // Next frame
            const batch1Handle = renderer._textureFor('material:building.k1:glass', canvasC, 'rev1');
            assert.equal(batch1Handle, handleA1);
            const batch2Handle = renderer._textureFor('material:building.k1:glass', canvasC, 'rev2');
            assert.notEqual(batch2Handle, handleA1);
            const batch3Handle = renderer._textureFor('material:building.k2:glass', canvasC, 'rev3');
            assert.notEqual(batch3Handle, handleA1, `${label}: k2 must allocate fresh backing rather than overwriting BA sampled by k1 this frame`);
            assert.notEqual(batch3Handle, batch2Handle);

            if (label === 'webgpu') {
                assert.equal(texA.destroyed, false, 'WebGPU: BA stays alive until post-submit');
                const writesToA = stub.copies.filter(c => c.dst.texture === texA);
                assert.equal(writesToA.length, 1, 'WebGPU: BA was never overwritten after initial rev1 upload');
                renderer._trimTextureCache();
                assert.equal(texA.destroyed, true, 'WebGPU: BA destroyed post-submit');
            } else {
                assert.equal(stub.deleted.includes(texA), false, 'WebGL2: BA stays alive until post-submit');
                renderer._trimTextureCache();
                assert.equal(stub.deleted.includes(texA), true, 'WebGL2: BA deleted post-submit');
            }
        }
    } finally {
        gpuStub.cleanup();
    }
});

test('Astra P2: revision-only divergence and re-alias refresh textureBytes, cachedTextureBytes, and trim flag on both backends', () => {
    const glStub = makeWebGlStub();
    const gpuStub = makeWebGpuStub();
    try {
        for (const [label, renderer] of [['webgl', glStub.renderer], ['webgpu', gpuStub.renderer]]) {
            renderer._textureEntries.clear();
            renderer._textureCache().clearResident();
            renderer._cachedTextureBytes = 0;
            renderer.textureBytes = 0;
            renderer._textureCacheNeedsTrim = false;
            renderer.frames = 0;

            const canvas = { width: 16, height: 16 }; // 16 * 16 * 4 = 1024 B
            renderer._textureFor('material:building.x:glass', canvas, 'rev1');
            renderer._textureFor('material:proc:building.x.roomGlassLit:channels', canvas, 'rev1');
            assert.equal(renderer._cachedTextureBytes, 1024, `${label}: shared rev1 charges 1024`);
            assert.equal(renderer.textureBytes, 1024, `${label}: textureBytes matches 1024`);

            // Clear trim flag before testing revision-only divergence!
            renderer._trimTextureCache();
            assert.equal(renderer._textureCacheNeedsTrim, false);

            // Advance one alias to rev2 (storageChanged === false, revisionChanged === true).
            renderer.frames = 1;
            renderer._textureFor('material:building.x:glass', canvas, 'rev2');
            assert.equal(renderer._cachedTextureBytes, 2048, `${label}: divergence increases cachedTextureBytes to 2048`);
            assert.equal(renderer.textureBytes, 2048, `${label}: divergence immediately refreshes textureBytes to 2048`);
            assert.equal(renderer._textureCacheNeedsTrim, true, `${label}: divergence arms _textureCacheNeedsTrim`);

            // Trim runs cleanly and both counters remain synced.
            renderer._trimTextureCache();
            assert.equal(renderer._cachedTextureBytes, 2048);
            assert.equal(renderer.textureBytes, 2048);
            assert.equal(renderer._textureCacheNeedsTrim, false);

            // Advance second alias to rev2 -> re-aliases back onto a single 1024 B backing!
            renderer.frames = 2;
            renderer._textureFor('material:proc:building.x.roomGlassLit:channels', canvas, 'rev2');
            assert.equal(renderer._cachedTextureBytes, 1024, `${label}: re-alias reduces cachedTextureBytes to 1024`);
            assert.equal(renderer.textureBytes, 1024, `${label}: re-alias immediately refreshes textureBytes to 1024`);
            const res = renderer.getResourceAccounting();
            assert.equal(res.textures.pinnedSources + res.textures.evictableSources, 1024,
                `${label}: resource accounting matches re-aliased 1024 B`);

            // Also verify divergence pushes over 160 MiB cap and triggers real budget trim!
            const MiB = 1024 * 1024;
            renderer.frames = 3;
            const bigPinned = { width: 1, height: 1 };
            renderer._textureFor('world-pilot', bigPinned, 'p1');
            // Inflate pinned bytes just below 160 MiB so a 1024 B divergence crosses the cap!
            const baseOther = 160 * MiB - 1536;
            renderer._updateTextureBytes = () => { renderer.textureBytes = baseOther + renderer._cachedTextureBytes; };
            renderer._updateTextureBytes();
            // Insert one evictable live sheet so trim has something to reclaim.
            const sheetSrc = { width: 32, height: 32 }; // 4096 B
            renderer._textureFor('agent-model:agent.claude.sonnet||false|1|2|3|4|false', sheetSrc, 's1');
            // Reset other bytes so total is right under 160 MiB (160 MiB - 512 B).
            const nonCached = 160 * MiB - renderer._cachedTextureBytes - 512;
            renderer._updateTextureBytes = () => { renderer.textureBytes = nonCached + renderer._cachedTextureBytes; };
            renderer._updateTextureBytes();
            renderer._trimTextureCache();
            assert.ok(renderer.textureBytes <= 160 * MiB, `${label}: starts under 160 MiB cap`);
            assert.equal(renderer._textureCacheNeedsTrim, false);

            // Diverge one 1024 B alias -> +1024 B -> crosses 160 MiB by +512 B!
            renderer.frames = 4;
            renderer._textureFor('material:building.x:glass', canvas, 'rev3');
            assert.equal(renderer._textureCacheNeedsTrim, true, `${label}: rev-only divergence arms trim over cap`);
            assert.ok(renderer.textureBytes > 160 * MiB, `${label}: textureBytes reflects overage before trim`);
            renderer._trimTextureCache();
            assert.ok(renderer.textureBytes <= 160 * MiB, `${label}: trim reclaims sheet and restores <= 160 MiB`);
            assert.equal(renderer._textureEntries.has('agent-model:agent.claude.sonnet||false|1|2|3|4|false'), false);
        }
    } finally {
        clearLayerCaches();
        gpuStub.cleanup();
    }
});

test('world-pilot splits zero-GPU-reference character sheets into world-pilot-characters while preserving all lookups and saving >23 MiB', () => {
    const root = new URL('../../claudeville/assets/sprites/atlases/', import.meta.url);
    const pilot = JSON.parse(readFileSync(new URL('world-pilot.json', root), 'utf8'));
    const chars = JSON.parse(readFileSync(new URL('world-pilot-characters.json', root), 'utf8'));

    assert.equal(pilot.width, 2039);
    assert.equal(pilot.height, 944);
    assert.equal(chars.width, 2016);
    assert.equal(chars.height, 768);

    const pilot4chBytes = pilot.width * pilot.height * 16;
    const baseline4chBytes = 2046 * 1693 * 16; // previous combined world-pilot
    assert.equal(pilot4chBytes, 30797056);
    assert.equal(baseline4chBytes - pilot4chBytes, 24624992, 'saves 23.48 MiB of GPU-resident 4-channel VRAM');

    // All 9 landmarks and 4 pilot props remain in world-pilot.
    for (const key of [
        'building.command', 'building.watchtower', 'building.harbor',
        'building.tavern', 'building.portal', 'building.forge',
        'building.mine', 'building.taskboard', 'building.archive',
        'prop.lantern', 'prop.plazaBrazier', 'prop.plazaBrazier.lit', 'prop.bridgeLanternPost',
    ]) {
        assert.ok(pilot.frames[key]?.rect, `${key} remains in world-pilot`);
    }
    // Zero agent cells remain in world-pilot; all 160 cells live in world-pilot-characters.
    assert.equal(Object.keys(pilot.frames).some(k => k.startsWith('agent.')), false);
    assert.equal(Object.keys(chars.frames).length, 160);
    assert.ok(chars.frames['agent.claude.opus/walk/s/0']?.rect);
    assert.ok(chars.frames['agent.codex.gpt56sol/idle/ne/3']?.rect);
});

test('WebGPU accounts for Frontier and live uniform buffers before trimming to 160 MiB', () => {
    const gpuStub = makeWebGpuStub();
    try {
        const { renderer } = gpuStub;
        const MiB = 1024 * 1024;
        const frontierBytes = 4 * MiB;
        renderer._frontierPasses = new Map();
        renderer._frontierPreparedBytes = frontierBytes;
        renderer._frontierDiagnostics = () => assert.fail('trimming must not read back diagnostics for every pass and cached texture');
        renderer.frames = 10;

        // Textures and Frontier exactly fill the budget before uniforms are allocated.
        const addFake = (key, bytes, lastUsedFrame) => {
            const texture = { destroy() { this.destroyed = true; }, destroyed: false };
            const backing = renderer._textureCache().createBacking({ key, texture, view: {}, width: 1, height: 1, bytes });
            const entry = { texture, view: {}, source: {}, src: '', revision: 1, width: 1, height: 1, bytes, format: 'rgba8', backing: null, lastUsedFrame };
            renderer._textureCache().attachEntry(key, entry, backing);
            renderer._textureEntries.set(key, entry);
            renderer._cachedTextureBytes += bytes;
            renderer.textureBytes += bytes;
        };
        addFake('world-pilot', 151 * MiB, 11);
        addFake('agent-model:agent.claude.sonnet||false|1|2|3|4|false', 5 * MiB, 11);
        const beforeUniforms = renderer.getResourceAccounting().totalBytes;
        renderer._batchBuffer = { size: 131072 };
        renderer._frameBuffer = { size: 256 };
        renderer._bloomParamBuffer = { size: 512 };
        renderer._rainBuffer = { size: 128 };
        const uniformBytes = 131072 + 256 + 512 + 128;
        const accounting = renderer.getResourceAccounting();
        assert.equal(accounting.buffers.uniforms, uniformBytes);
        assert.equal(accounting.totalBytes, beforeUniforms + uniformBytes);
        renderer._textureCacheNeedsTrim = true;

        renderer._trimTextureCache(11);
        assert.equal(renderer._textureEntries.has('agent-model:agent.claude.sonnet||false|1|2|3|4|false'), false,
            'evictable sheet trimmed because textures + frontierBytes exceeded 160 MiB');
        assert.ok(renderer.textureBytes + frontierBytes <= 160 * MiB);
    } finally {
        clearLayerCaches();
        gpuStub.cleanup();
    }
});

test('both renderers copy the staged backing before applying a second revision’s partial upload', () => {
    const gl = makeWebGlStub();
    const gpu = makeWebGpuStub();
    const copies = [];
    gl.gl.copyTexImage2D = (...args) => copies.push(args.slice(5, 7));
    gl.gl.deleteFramebuffer = () => {};
    gpu.device.createCommandEncoder = () => ({
        copyTextureToTexture(from, to, size) { copies.push(size.slice(0, 2)); },
        finish() { return {}; },
    });
    gpu.device.queue.submit = () => {};
    try {
        for (const { renderer } of [gl, gpu]) {
            const atlas = { width: 4, height: 4 };
            const first = renderer._textureFor('agent-frame-atlas', atlas, 1);
            const second = renderer._textureFor('agent-frame-atlas', atlas, 2, [{
                source: atlas, x: 3, y: 2, sy: 1, width: 1, height: 1,
            }]);
            assert.ok(second);
            assert.notEqual(second, first);
        }
        assert.deepEqual(copies, [[4, 4], [4, 4]]);
        assert.equal(gl.subUploads.length, 1);
        assert.deepEqual(gpu.copies.at(-1).src.origin, { x: 0, y: 1 });
        assert.deepEqual(gpu.copies.at(-1).dst.origin, { x: 3, y: 2, z: 0 });
        assert.deepEqual(gl.deleted, []);
        assert.deepEqual(gpu.destroyed, []);
    } finally {
        gpu.cleanup();
    }
});

test('typed revisions, resizes and format changes keep staged textures alive through submission', () => {
    const gl = makeWebGlStub();
    const gpu = makeWebGpuStub();
    try {
        for (const [renderer, deleted] of [[gl.renderer, gl.deleted], [gpu.renderer, gpu.destroyed]]) {
            const textures = [];
            for (const [revision, width, format] of [[1, 2, 'rgba8'], [2, 2, 'rgba8'], [3, 3, 'rgba8'], [4, 3, 'r8']]) {
                const data = new Uint8Array(width * (format === 'rgba8' ? 4 : 1)).fill(revision);
                renderer.uploadTypedTexture('field:test', { width, height: 1, format, data, revision });
                textures.push(renderer._textureEntries.get('field:test').texture);
            }
            assert.equal(new Set(textures).size, 4);
            assert.deepEqual(deleted, []);
            renderer._trimTextureCache();
            assert.deepEqual(deleted, textures.slice(0, -1));
            assert.equal(renderer._cachedTextureBytes, 3);
        }
    } finally {
        gpu.cleanup();
    }
});

test('adjacent batches keep distinct texture and channel revisions', () => {
    const source = { width: 2, height: 2 };
    for (const [channel, revision] of [['source', 'textureRevision'], ['materialSource', 'materialRevision'],
        ['emissiveSource', 'emissiveRevision'], ['occluderSource', 'sidecarRevision']]) {
        const record = { textureKey: 'agent-frame-atlas', source, [channel]: source, [revision]: 1 };
        const next = { ...record, [revision]: 2 };
        const batches = buildStableGpuBatches([record, next, next]);
        assert.deepEqual(batches.map(batch => batch.records.length), [1, 2], revision);
    }
});

test('GPU readback preserves every staged atlas revision and independent patch origin',
    { skip: !process.env.CLAUDEVILLE_TEST_FRONTIER_GPU, timeout: 45000 }, async () => {
        const { launchBenchBrowser, resolveServer } = await import('../smoke/support/world-bench.mjs');
        const server = await resolveServer(process.env.CLAUDEVILLE_TEST_URL);
        let browser;
        try {
            browser = await launchBenchBrowser();
            const page = await browser.newPage();
            const url = server.baseUrl + '/texture-readback-test';
            await page.route(url, route => route.fulfill({ contentType: 'text/html', body: '<title>Texture readback</title>' }));
            await page.goto(url);
            const result = await page.evaluate(async () => {
                const dir = '/src/presentation/character-mode/gpu/';
                const { GpuWorldRenderer } = await import(dir + 'GpuWorldRenderer.js');
                const { GpuWorldRendererWebGPU } = await import(dir + 'GpuWorldRendererWebGPU.js');
                const device = await (await navigator.gpu.requestAdapter()).requestDevice();
                const gl = new OffscreenCanvas(4, 1).getContext('webgl2');
                function paint(canvas, values, x = 0) {
                    const ctx = canvas.getContext('2d');
                    const bytes = Uint8ClampedArray.from(values.flatMap(red => [red, 0, 0, 255]));
                    ctx.putImageData(new ImageData(bytes, Math.min(canvas.width, values.length)), x, 0);
                }
                device.pushErrorScope('validation');
                const frames = [];
                for (const backend of [GpuWorldRenderer, GpuWorldRendererWebGPU]) {
                    const renderer = Object.assign(Object.create(backend.prototype), {
                        gl, device, frames: 0, _textureEntries: new Map(), _cachedTextureBytes: 0, _uploadByteKinds: {},
                        _updateTextureBytes() {},
                    });
                    const atlas = new OffscreenCanvas(4, 1);
                    const patch = new OffscreenCanvas(1, 2);
                    paint(atlas, [10, 20, 30, 40]);
                    paint(patch, [7, 88]);
                    function stage(revision, updates) {
                        renderer._textureFor('agent-frame-atlas', atlas, revision, updates);
                        return renderer._textureEntries.get('agent-frame-atlas').texture;
                    }
                    const original = stage(1);
                    paint(atlas, [99], 1);
                    const updated = stage(2, [{ source: atlas, x: 1, sx: 1, width: 1, height: 1 }]);
                    const cropped = stage(3, [{ source: patch, sy: 1, x: 2, width: 1, height: 1 }]);
                    const last = stage(4, [{ source: patch, sy: 0, x: 3, width: 1, height: 1 }]);
                    for (const texture of [original, updated, cropped, last]) {
                        if (backend === GpuWorldRenderer) {
                            const framebuffer = gl.createFramebuffer();
                            gl.bindFramebuffer(gl.READ_FRAMEBUFFER, framebuffer);
                            gl.framebufferTexture2D(gl.READ_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
                            const bytes = new Uint8Array(16);
                            gl.readPixels(0, 0, 4, 1, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
                            frames.push([...bytes]);
                            gl.deleteFramebuffer(framebuffer);
                        } else {
                            const output = device.createBuffer({ size: 16, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
                            const encoder = device.createCommandEncoder();
                            encoder.copyTextureToBuffer({ texture }, { buffer: output }, [4, 1, 1]);
                            device.queue.submit([encoder.finish()]);
                            await output.mapAsync(GPUMapMode.READ);
                            frames.push([...new Uint8Array(output.getMappedRange())]);
                            output.destroy();
                        }
                    }
                }
                const error = (await device.popErrorScope())?.message;
                device.destroy();
                return { frames, error, glError: gl.getError() };
            });
            assert.equal(result.error, undefined);
            assert.equal(result.glError, 0);
            const expected = [[10, 20, 30, 40], [10, 99, 30, 40], [10, 99, 88, 40], [10, 99, 88, 7]]
                .map(row => row.flatMap(red => [red, 0, 0, 255]));
            assert.deepEqual(result.frames, [...expected, ...expected]);
        } finally {
            await browser?.close();
            await server.stop();
        }
    });
