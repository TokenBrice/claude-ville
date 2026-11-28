import test from 'node:test';
import assert from 'node:assert/strict';
import { GpuWorldRendererWebGPU } from '../../claudeville/src/presentation/character-mode/gpu/GpuWorldRendererWebGPU.js';
import { NEUTRAL_GRADE } from '../../claudeville/src/presentation/character-mode/GradeEvaluator.js';
import {
    buildStableGpuBatches,
    GPU_RECORD_FLAGS,
    normalizeGpuRecord,
} from '../../claudeville/src/presentation/character-mode/gpu/GpuWorldPolicy.js';
import { ALBEDO_PAGE_SIZE } from '../../claudeville/src/presentation/character-mode/gpu/GpuAlbedoPage.js';
import { captureRecordWords } from '../../claudeville/src/presentation/character-mode/gpu/GpuWorldRenderer.js';
import {
    BATCH_UNIFORM_STRIDE,
    createUniformViews,
    writeBatchUniforms,
} from '../../claudeville/src/presentation/character-mode/gpu/wgsl/index.js';

function fixture(t, { timers = false } = {}) {
    for (const [name, value] of Object.entries({
        GPUBufferUsage: { UNIFORM: 1, COPY_DST: 2, STORAGE: 4, VERTEX: 8, MAP_READ: 16, QUERY_RESOLVE: 32, COPY_SRC: 64 },
        GPUTextureUsage: { TEXTURE_BINDING: 1, COPY_DST: 2, RENDER_ATTACHMENT: 4, COPY_SRC: 8 },
        GPUMapMode: { READ: 1 },
    })) {
        const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
        Object.defineProperty(globalThis, name, { configurable: true, value });
        t.after(() => descriptor ? Object.defineProperty(globalThis, name, descriptor) : delete globalThis[name]);
    }
    const work = { passes: 0, submits: 0, writes: 0 };
    const resource = () => ({ destroy() {}, createView() { return {}; } });
    const pendingMaps = [];
    const device = {
        features: new Set(timers ? ['timestamp-query'] : []), lost: new Promise(() => {}),
        queue: {
            writeTexture() {}, copyExternalImageToTexture() {},
            writeBuffer() { work.writes++; }, submit() { work.submits++; },
        },
        createTexture: resource, createQuerySet: resource,
        createBuffer({ size }) {
            return {
                ...resource(),
                mapAsync: () => new Promise(resolve => pendingMaps.push(resolve)),
                getMappedRange: () => new ArrayBuffer(size),
                unmap() {},
            };
        },
        createSampler: () => ({}), createBindGroup: () => ({}),
        pushErrorScope() {}, popErrorScope: async () => null,
        createCommandEncoder() {
            return {
                finish: () => ({}),
                resolveQuerySet() {}, copyBufferToBuffer() {},
                beginRenderPass() {
                    work.passes++;
                    return { setBindGroup() {}, setPipeline() {}, setVertexBuffer() {}, setBlendConstant() {}, draw() {}, end() {} };
                },
            };
        },
    };
    const context = { configure() {}, unconfigure() {}, getCurrentTexture: resource };
    const canvas = { width: 64, height: 64, style: {}, getContext: () => context };
    const pipelines = { layouts: { frame: {}, batch: {}, composite: {}, bloom: {}, debugLoad: {} }, scene: () => ({}), particles: () => ({}), bloom: {}, composite: {}, debugLoad: {} };
    const renderer = new GpuWorldRendererWebGPU(canvas, { device, pipelines });
    assert.equal(renderer.isActive(), true, renderer.initError);
    renderer._albedoPage = null;
    renderer.qualityLadder.setOverride(2);
    const input = {
        records: [{ id: 'sprite', textureKey: 'sprite', source: { width: 8, height: 8 }, textureRevision: 1,
            x: 0, y: 0, width: 8, height: 8, sx: 0, sy: 0, sw: 8, sh: 8,
            alpha: 1, material: 1, emissive: 0, elevation: 0 }],
        camera: { x: 0, y: 0, zoom: 1 }, feed: { timeMs: 1234, motionScale: 0, reducedMotion: true },
    };
    t.after(() => renderer.dispose());
    return { renderer, input, work, completeQueries() { pendingMaps.splice(0).forEach(resolve => resolve()); } };
}

function baseline(f) {
    assert.equal(f.renderer.render(f.input), true, f.renderer.failure?.message);
    assert.ok(f.work.passes > 0);
    assert.equal(f.renderer.lastFrameReused, false, 'a submitted frame is not a confirmed static one');
    const before = { ...f.work };
    assert.equal(f.renderer.render(f.input), true);
    assert.deepEqual(f.work, before, 'identical staged input must issue no passes/submits/buffer writes');
    assert.equal(f.renderer.getDiagnostics().skippedFrames, 1, 'diagnostics report output reuse');
    assert.equal(f.renderer.lastFrameReused, true, 'FP-2: the reuse confirms a static scene');
}

const poisons = {
    record: f => { f.input.records[0].x++; },
    camera: f => { f.input.camera.x++; },
    clock: f => { f.input.feed.timeMs++; },
    flash: f => { f.input.feed.flash = [0.1, 0, 0]; },
    texture: f => { f.input.records[0].textureRevision++; },
    display: f => { f.renderer.hdrMode = 'bright'; },
    resize: f => { f.renderer.resize(64, 64); },
    generation: f => { f.renderer._canvasGeneration++; },
    'fresh-output request': f => { f.input.forceFreshOutput = true; },
    'grade uniform': f => { f.input.feed.lightGrade = { ...NEUTRAL_GRADE, exposure: 0.8 }; },
    'weather uniform': f => { f.input.feed.weather = { fog: 0.3 }; },
    'sun uniform': f => { f.input.feed.lighting = { sunDirIso: { x: 0.2, y: 0.3 } }; },
    'batch terrain classification': f => { f.input.records[0].id = 'terrain:static'; },
    'pending readback': f => { f.renderer._readbackPending = 1; },
    'mark stream': f => { f.input.marks = [{ ...f.input.records[0], flags: GPU_RECORD_FLAGS.screenSpace | GPU_RECORD_FLAGS.actionMark }]; },
    'particle stream': f => { f.input.particles = { packGpuInstances(views) { views.f32[0] = 1; return 1; } }; },
};
for (const [name, poison] of Object.entries(poisons)) {
    test(`WebGPU repaints when ${name} alone changes`, t => {
        const f = fixture(t);
        baseline(f);
        const submits = f.work.submits;
        poison(f);
        assert.equal(f.renderer.render(f.input), true, f.renderer.failure?.message);
        assert.ok(f.work.submits > submits, 'a poisoned input must repaint');
    });
}

test('late WebGPU marks require a current-task fresh canvas texture', async t => {
    const f = fixture(t);
    baseline(f);
    const marks = [{ ...f.input.records[0], flags: GPU_RECORD_FLAGS.screenSpace | GPU_RECORD_FLAGS.actionMark }];
    assert.equal(f.renderer.drawLateMarks(marks), 0);
    assert.equal(f.renderer.ensureFreshOutput(), true);
    assert.equal(f.renderer.drawLateMarks(marks), 1);
    await Promise.resolve();
    assert.equal(f.renderer.drawLateMarks(marks), 0);
    const submits = f.work.submits;
    assert.equal(f.renderer.render(f.input), true);
    assert.ok(f.work.submits > submits, 'next presentation clears the late pass');
});

test('WebGPU query readiness is exposed without leaking backend timer state', async t => {
    const f = fixture(t, { timers: true });
    assert.equal(f.renderer.hasPendingGpuQueries(), false);
    assert.equal(f.renderer.render(f.input), true);
    assert.equal(f.renderer.hasPendingGpuQueries(), true);
    const first = f.renderer.getDiagnostics().frames;
    assert.equal(f.renderer.render(f.input), true);
    assert.equal(f.renderer.getDiagnostics().frames, first + 1, 'pending timing work vetoes identical-output reuse');
    assert.equal(f.renderer._reuseStagedBytes, 0, 'bypassed pending-query frame stages zero reuse bytes');
    f.completeQueries();
    await Promise.resolve();
    assert.equal(f.renderer.hasPendingGpuQueries(), false);
    const completed = f.renderer.getDiagnostics();
    // Invalidated baseline on bypass means the first eligible frame genuinely
    // presents and re-primes reuse, and the next identical frame reuses output.
    assert.equal(f.renderer.render(f.input), true);
    assert.equal(f.renderer.getDiagnostics().frames, completed.frames + 1, 'first eligible frame after bypass presents');
    assert.equal(f.renderer.getDiagnostics().skippedFrames, completed.skippedFrames);
    assert.equal(f.renderer.lastFrameReused, false);
    assert.ok(f.renderer._reuseStagedBytes > 0, 're-priming frame stages reuse bytes');
    assert.equal(f.renderer.render(f.input), true);
    assert.equal(f.renderer.getDiagnostics().skippedFrames, completed.skippedFrames + 1);
    assert.equal(f.renderer.lastFrameReused, true);
});

test('fresh-required WebGPU frames skip GpuFrameReuse bookkeeping and stage zero bytes', t => {
    const cases = [
        ['forceFreshOutput', f => { f.input.forceFreshOutput = true; }],
        ['advancing clock', f => { f.input.feed.timeMs++; }],
        ['pending readback', f => { f.renderer._readbackPending = 1; }],
        ['debug load', f => { f.renderer._debugLoad = { passes: 1, levels: 'all' }; }],
        ['pass sampling', f => { f.renderer.passSamplingEnabled = true; }],
    ];
    for (const [label, trigger] of cases) {
        const f = fixture(t);
        baseline(f);
        const begin = t.mock.method(f.renderer._frameReuse, 'begin');
        const bytes = t.mock.method(f.renderer._frameReuse, 'bytes');
        const commit = t.mock.method(f.renderer._frameReuse, 'commit');
        const submits = f.work.submits;
        trigger(f);
        assert.equal(f.renderer.render(f.input), true, `${label}: ${f.renderer.failure?.message}`);
        assert.ok(f.work.submits > submits, `${label} must submit`);
        assert.equal(f.renderer._reuseStagedBytes, 0, `${label} must stage zero reuse bytes`);
        assert.equal(begin.mock.callCount(), 0, `${label} must skip reuse.begin()`);
        assert.equal(bytes.mock.callCount(), 0, `${label} must skip reuse.bytes()`);
        assert.equal(commit.mock.callCount(), 0, `${label} must skip reuse.commit()`);
        assert.equal(f.renderer.lastFrameReused, false, `${label} must not report reuse`);
    }
});

test('returning to scene A after a bypassed scene B genuinely presents A before reusing', t => {
    const f = fixture(t);
    baseline(f);
    const submitsAfterA = f.work.submits;
    // Render scene B while bypassing reuse via forceFreshOutput (invalidates baseline A).
    f.input.records[0].x = 42;
    f.input.forceFreshOutput = true;
    assert.equal(f.renderer.render(f.input), true);
    assert.equal(f.work.submits, submitsAfterA + 1);
    assert.equal(f.renderer._reuseStagedBytes, 0);
    // Return to scene A and allow reuse again: must NOT skip against stale baseline A!
    f.input.records[0].x = 0;
    f.input.forceFreshOutput = false;
    assert.equal(f.renderer.render(f.input), true);
    assert.equal(f.work.submits, submitsAfterA + 2, 'first eligible frame after bypass must present A');
    assert.equal(f.renderer.lastFrameReused, false);
    // Next identical A frame re-engages reuse.
    const skippedBefore = f.renderer.getDiagnostics().skippedFrames;
    assert.equal(f.renderer.render(f.input), true);
    assert.equal(f.work.submits, submitsAfterA + 2, 'second identical frame reuses presented A');
    assert.equal(f.renderer.getDiagnostics().skippedFrames, skippedBefore + 1);
    assert.equal(f.renderer.lastFrameReused, true);
});

test('camera transition presents while moving and re-engages reuse after settling', t => {
    const f = fixture(t);
    baseline(f);
    let submits = f.work.submits;
    for (let step = 1; step <= 3; step++) {
        f.input.camera.x = step * 16;
        assert.equal(f.renderer.render(f.input), true);
        assert.equal(f.work.submits, ++submits, `camera pan step ${step} must present`);
        assert.equal(f.renderer.lastFrameReused, false);
    }
    // Next frame at the settled camera matches the committed pan baseline and skips.
    assert.equal(f.renderer.render(f.input), true);
    assert.equal(f.work.submits, submits, 'settled camera must reuse');
    assert.equal(f.renderer.lastFrameReused, true);
});

test('device loss and resource abandon reset reuse state so post-recovery frames present', t => {
    const f = fixture(t);
    baseline(f);
    const submitsBefore = f.work.submits;
    f.renderer._abandonGpuResources();
    assert.equal(f.renderer._stagedShaderTimeMs, undefined);
    f.renderer._initResources();
    f.renderer._albedoPage = null;
    assert.equal(f.renderer.render(f.input), true, f.renderer.failure?.message);
    assert.ok(f.work.submits > submitsBefore, 'first frame after resource rebuild must present');
    assert.equal(f.renderer.lastFrameReused, false);
    const submitsAfter = f.work.submits;
    assert.equal(f.renderer.render(f.input), true);
    assert.equal(f.work.submits, submitsAfter, 'subsequent identical frame reuses again');
    assert.equal(f.renderer.lastFrameReused, true);
});

test('_writeBatchSlot writes bit-for-bit identical uniforms to writeBatchUniforms', t => {
    const f = fixture(t);
    const r = f.renderer;
    r._textureEntries.set('tex:hero', { width: 128, height: 64 });
    r._textureEntries.set('tex:terrain', { width: 2048, height: 1024 });
    const dummyTex = {};
    const scenarios = [
        {
            fat: true, puddle: true, mark: false,
            batch: {
                textureKey: 'tex:terrain', albedoTexture: dummyTex, page: null,
                blend: 'over', writesDepth: true, cueRuns: false,
                materialTexture: dummyTex, emissiveTexture: null, occluderTexture: dummyTex,
                records: [{ id: 'terrain:static', flags: 0, supportH: 0, surfaceOffset: null, sublayerRank: 0 }],
            },
            expectedSize: [2048, 1024],
        },
        {
            fat: true, puddle: false, mark: false,
            batch: {
                textureKey: 'albedo-page', albedoTexture: dummyTex, page: { key: 'albedo-page' },
                blend: 'add', writesDepth: false, cueRuns: false,
                materialTexture: null, emissiveTexture: dummyTex, occluderTexture: null,
                records: [{ id: 'prop.lamp', flags: GPU_RECORD_FLAGS.fatOptOut, supportH: 14.5, surfaceOffset: [-12.9, 34.7], sublayerRank: 3 }],
            },
            expectedSize: [ALBEDO_PAGE_SIZE, ALBEDO_PAGE_SIZE],
        },
        {
            fat: false, puddle: false, mark: true,
            batch: {
                textureKey: 'tex:hero', albedoTexture: dummyTex, page: null,
                blend: 'add', writesDepth: false, cueRuns: true,
                materialTexture: null, emissiveTexture: null, occluderTexture: null,
                records: [{ id: 'terrain:static', flags: 0, supportH: 2, surfaceOffset: [5, -7], sublayerRank: 1 }],
            },
            expectedSize: [128, 64],
        },
        {
            fat: true, puddle: false, mark: false,
            batch: {
                textureKey: 'cue:atlas', albedoTexture: dummyTex, page: null, albedoSize: [256, 512],
                blend: 'over', writesDepth: false, cueRuns: true,
                materialTexture: null, emissiveTexture: null, occluderTexture: null,
                records: [{ id: 'ground:cue-atlas', flags: 0, supportH: NaN, surfaceOffset: [NaN, 8], sublayerRank: 2.9 }],
            },
            expectedSize: [256, 512],
        },
    ];
    r._ensureBatchSlots(scenarios.length);
    const refViews = createUniformViews(scenarios.length * BATCH_UNIFORM_STRIDE);
    for (let slot = 0; slot < scenarios.length; slot++) {
        const s = scenarios[slot];
        r.fatPixelsFrame = s.fat;
        r._puddleActive = s.puddle;
        r._writeBatchSlot(slot, s.batch, { mark: s.mark });
        const first = s.batch.records[0];
        const terrain = !s.mark && first?.id === 'terrain:static';
        const optOut = Boolean((first?.flags || 0) & GPU_RECORD_FLAGS.fatOptOut);
        writeBatchUniforms(refViews, slot, {
            albedoSize: s.expectedSize,
            albedoPaged: Boolean(s.batch.page),
            fatPixels: !s.mark && s.fat && !optOut,
            additive: !s.mark && s.batch.blend === 'add',
            terrainBatch: terrain,
            puddleGround: s.puddle && terrain,
            hasMaterialMap: Boolean(s.batch.materialTexture),
            hasEmissiveMap: Boolean(s.batch.emissiveTexture),
            hasOccluderMap: Boolean(s.batch.occluderTexture),
            cueRuns: !s.mark && Boolean(s.batch.cueRuns),
            writesDepth: s.batch.writesDepth === true,
            trimColumn: -1,
            supportH: Number.isFinite(first?.supportH) ? first.supportH : 0,
            surfaceOffset: first?.surfaceOffset || [0, 0],
            sublayerRank: Number.isFinite(first?.sublayerRank) ? first.sublayerRank : 0,
        });
        const actual = new Uint32Array(r._batchViews.buffer, slot * BATCH_UNIFORM_STRIDE, BATCH_UNIFORM_STRIDE / 4);
        const expected = new Uint32Array(refViews.buffer, slot * BATCH_UNIFORM_STRIDE, BATCH_UNIFORM_STRIDE / 4);
        assert.deepEqual(actual, expected, `batch slot ${slot} uniforms must match writeBatchUniforms bit-for-bit`);
    }
});

test('_buildSceneBatches matches buildStableGpuBatches across prenormalized, pageableNormalized, and raw records', t => {
    const f = fixture(t);
    const r = f.renderer;
    const srcA = { width: 32, height: 32 };
    const srcB = { width: 64, height: 64 };
    const srcC = { width: 48, height: 48 };
    const pageObj = { key: 'albedo-page' };
    const pager = record => {
        if (record.source === srcA || record.source === srcB) {
            record.pageLayer = 0;
            record.pageX = record.source === srcA ? 4 : 40;
            record.pageY = 4;
            return pageObj;
        }
        return null;
    };
    r._pageRecord = pager;

    const rawPre = normalizeGpuRecord({
        id: 'ground:cue-atlas', textureKey: 'cue:atlas', source: srcC, textureRevision: 1,
        x: 0, y: 0, width: 48, height: 48, sx: 0, sy: 0, sw: 48, sh: 48, writesDepth: false, cueRuns: true,
    }, 0);
    const preRecord = { ...rawPre, prenormalized: true };

    const rawPageableA = normalizeGpuRecord({
        id: 'prop.a', textureKey: 'prop:a', source: srcA, textureRevision: 1,
        x: 10, y: 20, width: 32, height: 32, sx: 0, sy: 0, sw: 32, sh: 32,
    }, 1);
    const pageableRecordA = { ...rawPageableA, pageableNormalized: true };

    const rawPlainB = {
        id: 'prop.b', textureKey: 'prop:b', source: srcB, textureRevision: 2,
        x: 50, y: 20, width: 64, height: 64, sx: 0, sy: 0, sw: 64, sh: 64,
    };

    const rawUnpaged = {
        id: 'building.forge', textureKey: 'building:forge', source: srcC, textureRevision: 3,
        x: 100, y: 100, width: 48, height: 48, sx: 0, sy: 0, sw: 48, sh: 48,
    };

    const webgpuInputs = [preRecord, pageableRecordA, rawPlainB, rawUnpaged];
    const refInputs = [
        { ...rawPre, prenormalized: true },
        { ...rawPageableA },
        { ...rawPlainB },
        { ...rawUnpaged },
    ];

    const actualBatches = r._buildSceneBatches(webgpuInputs);
    const refNormalized = [];
    const expectedBatches = buildStableGpuBatches(refInputs, [], refNormalized, pager);

    assert.equal(actualBatches.length, expectedBatches.length, 'batch count must match');
    assert.equal(actualBatches.length, 3, 'adjacent paged records A and B must merge into one batch');
    for (let i = 0; i < expectedBatches.length; i++) {
        assert.equal(actualBatches[i].key, expectedBatches[i].key);
        assert.equal(actualBatches[i].page, expectedBatches[i].page);
        assert.equal(actualBatches[i].records.length, expectedBatches[i].records.length);
        for (let j = 0; j < expectedBatches[i].records.length; j++) {
            const a = actualBatches[i].records[j];
            const e = expectedBatches[i].records[j];
            assert.equal(a.id, e.id);
            assert.equal(a.pageLayer, e.pageLayer);
            assert.equal(a.pageX, e.pageX);
            assert.equal(a.pageY, e.pageY);
        }
    }
    const actualWords = captureRecordWords(webgpuInputs, r._normalizedRecordScratch, actualBatches);
    const expectedWords = captureRecordWords(refInputs, refNormalized, expectedBatches);
    assert.deepEqual(actualWords, expectedWords, 'attribution captureRecordWords must match');
});

test('WebGPU rescue repaint preserves the primary pacing and timing sample', t => {
    let now = 1000;
    t.mock.method(performance, 'now', () => now);
    const f = fixture(t);
    baseline(f);
    now += 16;
    f.input.feed.timeMs++;
    assert.equal(f.renderer.render(f.input), true);
    const primary = f.renderer.getDiagnostics();
    now++;
    assert.equal(f.renderer.ensureFreshOutput(true), true);
    const rescue = f.renderer.getDiagnostics();
    assert.equal(rescue.frames, primary.frames + 1, 'the rescue really repaints');
    assert.deepEqual(rescue.pacing, primary.pacing, 'no extra fast ladder sample');
    assert.equal(rescue.frameGapMs, primary.frameGapMs);
    now += 15;
    f.input.feed.timeMs++;
    assert.equal(f.renderer.render(f.input), true);
    assert.equal(f.renderer.getDiagnostics().pacing.sampledAtMs, now, 'the next logical frame still records timing');
});

test('diagnostics defer resource accounting until resources are read', t => {
    const f = fixture(t);
    const accounting = t.mock.method(f.renderer, 'getResourceAccounting', () => ({ pinnedBytes: 123 }));
    const diagnostics = f.renderer.getDiagnostics();
    assert.equal(accounting.mock.callCount(), 0);
    assert.deepEqual(diagnostics.resources, { pinnedBytes: 123 });
    assert.equal(accounting.mock.callCount(), 1);
});

test('reopening the WebGPU occluder gate uploads only changed versioned sources', t => {
    const { renderer, input } = fixture(t);
    const record = input.records[0];
    Object.assign(record, { occluderSource: { width: 8, height: 8 }, sidecarKey: 'tile', sidecarRevision: 1 });
    const copies = t.mock.method(renderer.device.queue, 'copyExternalImageToTexture');
    const render = ambientLight => {
        input.feed.lighting = { ambientLight };
        assert.equal(renderer.render(input), true);
    };
    render(0);
    const occluder = renderer._textureEntries.get('occluder:tile').texture;
    const uploads = () => copies.mock.calls.filter(call => call.arguments[1].texture === occluder);
    assert.equal(uploads().length, 1);
    render(1);
    render(0);
    assert.equal(uploads().length, 1);
    render(1);
    record.sidecarRevision++;
    record.occluderTextureUpdates = [{ source: record.occluderSource, sx: 1, sy: 1, x: 1, y: 1, width: 2, height: 2 }];
    render(0);
    assert.equal(uploads().length, 2);
    assert.equal(uploads().at(-1).arguments[2].width, 8, 'a missed update restores the whole occluder');

    const d = renderer.getDiagnostics();
    assert.equal(d.sceneTextureBindings.groupsBound, 1);
    assert.equal(d.sceneTextureBindings.records.other, 1);
    assert.equal(Object.values(d.uploadBytesByKind).reduce((a, b) => a + b, 0), d.uploadBytes);
});
