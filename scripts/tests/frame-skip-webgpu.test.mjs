import test from 'node:test';
import assert from 'node:assert/strict';
import { GpuWorldRendererWebGPU } from '../../claudeville/src/presentation/character-mode/gpu/GpuWorldRendererWebGPU.js';
import { NEUTRAL_GRADE } from '../../claudeville/src/presentation/character-mode/GradeEvaluator.js';
import { GPU_RECORD_FLAGS } from '../../claudeville/src/presentation/character-mode/gpu/GpuWorldPolicy.js';

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
    const before = { ...f.work };
    assert.equal(f.renderer.render(f.input), true);
    assert.deepEqual(f.work, before, 'identical staged input must issue no passes/submits/buffer writes');
    assert.equal(f.renderer.getDiagnostics().skippedFrames, 1, 'diagnostics report output reuse');
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
    'beam uniform': f => { f.input.feed.beam = { foot: { x: 10, y: 20 }, angle: 0.5, length: 40, farWidth: 8, sheenStep: 1 }; },
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
    f.completeQueries();
    await Promise.resolve();
    assert.equal(f.renderer.hasPendingGpuQueries(), false);
    const completed = f.renderer.getDiagnostics();
    assert.equal(f.renderer.render(f.input), true);
    assert.equal(f.renderer.getDiagnostics().skippedFrames, completed.skippedFrames + 1);
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
