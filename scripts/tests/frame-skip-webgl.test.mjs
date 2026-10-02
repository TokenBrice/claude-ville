import test from 'node:test';
import assert from 'node:assert/strict';
import { GpuWorldRenderer } from '../../claudeville/src/presentation/character-mode/gpu/GpuWorldRenderer.js';
import { NEUTRAL_GRADE } from '../../claudeville/src/presentation/character-mode/GradeEvaluator.js';
import { GPU_RECORD_FLAGS } from '../../claudeville/src/presentation/character-mode/gpu/GpuWorldPolicy.js';

function fixture({ radiance = false, timers = false } = {}) {
    const work = { draws: 0, writes: 0, queryReady: false };
    let id = 0;
    const constants = new Map();
    const functions = new Map();
    const gl = new Proxy({ drawingBufferColorSpace: 'srgb' }, {
        get(target, key) {
            if (key in target) return target[key];
            if (/^[A-Z_0-9]+$/.test(key)) {
                if (!constants.has(key)) constants.set(key, ++id);
                return constants.get(key);
            }
            if (!functions.has(key)) functions.set(key, function (...args) {
                if (key.startsWith('create') || key === 'getUniformLocation') return { key, id: ++id };
                if (key === 'getShaderParameter' || key === 'getProgramParameter') return true;
                if (key === 'checkFramebufferStatus') return gl.FRAMEBUFFER_COMPLETE;
                if (key === 'getExtension') {
                    if (radiance && args[0] === 'EXT_color_buffer_float') return {};
                    if (timers && args[0] === 'EXT_disjoint_timer_query_webgl2') {
                        return { TIME_ELAPSED_EXT: -1, GPU_DISJOINT_EXT: -2 };
                    }
                    return null;
                }
                if (key === 'getParameter') return args[0] === -2 ? false : 16;
                if (key === 'getQueryParameter') return args[1] === gl.QUERY_RESULT_AVAILABLE ? work.queryReady : 1000000;
                if (key === 'isContextLost') return false;
                if (key.startsWith('drawArrays')) work.draws++;
                if (key === 'bufferSubData') work.writes++;
                return null;
            });
            return functions.get(key);
        },
    });
    const canvas = { width: 64, height: 64, style: {}, getContext: () => gl };
    const renderer = new GpuWorldRenderer(canvas);
    renderer._albedoPage = null;
    renderer.qualityLadder.setOverride(2);
    const source = { width: 8, height: 8 };
    const input = {
        records: [{ id: 'sprite', textureKey: 'sprite', source, textureRevision: 1,
            x: 0, y: 0, width: 8, height: 8, sx: 0, sy: 0, sw: 8, sh: 8,
            alpha: 1, material: 1, emissive: 0, elevation: 0 }],
        camera: { x: 0, y: 0, zoom: 1 },
        feed: { timeMs: 1234, motionScale: 0, reducedMotion: true },
    };
    return { renderer, input, work };
}

function baseline(f) {
    assert.equal(f.renderer.render(f.input), true);
    assert.ok(f.work.draws > 0);
    const draws = f.work.draws;
    const writes = f.work.writes;
    assert.equal(f.renderer.render(f.input), true);
    assert.equal(f.work.draws, draws, 'identical staged frame must retain pixels');
    assert.equal(f.work.writes, writes, 'retained frame must not rewrite staged buffers');
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
    'mark stream': f => { f.input.marks = [{ ...f.input.records[0], flags: GPU_RECORD_FLAGS.screenSpace | GPU_RECORD_FLAGS.actionMark }]; },
    'particle stream': f => { f.input.particles = { packGpuInstances(views) { views.f32[0] = 1; return 1; } }; },
};
for (const [name, poison] of Object.entries(poisons)) {
    test(`WebGL repaints when ${name} alone changes`, () => {
        const f = fixture();
        baseline(f);
        const draws = f.work.draws;
        poison(f);
        assert.equal(f.renderer.render(f.input), true);
        assert.ok(f.work.draws > draws, 'a poisoned input must repaint');
        f.renderer.dispose();
    });
}

test('late marks cannot draw onto reused or previous-task output', async () => {
    const f = fixture();
    baseline(f);
    const marks = [{ ...f.input.records[0], flags: GPU_RECORD_FLAGS.screenSpace | GPU_RECORD_FLAGS.actionMark }];
    assert.equal(f.renderer.drawLateMarks(marks), 0);
    assert.equal(f.renderer.ensureFreshOutput(), true);
    assert.equal(f.renderer.drawLateMarks(marks), 1);
    await Promise.resolve();
    assert.equal(f.renderer.drawLateMarks(marks), 0);
    const draws = f.work.draws;
    assert.equal(f.renderer.render(f.input), true);
    assert.ok(f.work.draws > draws, 'next frame must clear the late marks');
    f.renderer.dispose();
});

test('a settled radiance field reuses output, but an in-place solve repaints', t => {
    let now = 1000;
    t.mock.method(performance, 'now', () => now);
    const f = fixture({ radiance: true });
    t.after(() => f.renderer.dispose());
    // The ladder keeps radiance off at every level; the public pilot
    // override enables the real solve path without changing other effects.
    f.renderer.setRadianceOverride(true);
    f.input.feed.lighting = { ambientLight: 0 };
    f.input.feed.footprint = {
        width: 1, height: 1, originX: 0, originY: 0, cell: 4,
        data: new Uint8Array([0, 0]), revision: 1,
    };
    f.input.feed.radiance = { sources: [{ id: 'lamp', role: 'fixture', x: 0, y: 0, radius: 64, intensity: 1 }] };
    baseline(f);
    const settled = f.renderer.getDiagnostics();
    assert.equal(settled.radiance.ready, true);
    assert.equal(settled.radiance.solves, 1);
    now += 1000;
    assert.equal(f.renderer.render(f.input), true);
    assert.equal(f.renderer.getDiagnostics().skippedFrames, settled.skippedFrames + 1);
    const retained = f.renderer.getDiagnostics();
    // Only the island-wide bounce emitter changes; the staged direct-light
    // uniforms and the radiance texture identity remain the same.
    f.input.feed.radiance.sources[0].x = 20;
    now += 1000;
    assert.equal(f.renderer.render(f.input), true);
    const repainted = f.renderer.getDiagnostics();
    assert.equal(repainted.radiance.solves, 2);
    assert.equal(repainted.frames, retained.frames + 1, 'new radiance texels reach the presented output');
    assert.equal(repainted.skippedFrames, retained.skippedFrames);
});

test('WebGL query readiness is exposed without leaking backend timer state', t => {
    const f = fixture({ timers: true });
    t.after(() => f.renderer.dispose());
    assert.equal(f.renderer.hasPendingGpuQueries(), false);
    assert.equal(f.renderer.render(f.input), true);
    assert.equal(f.renderer.hasPendingGpuQueries(), true);
    const first = f.renderer.getDiagnostics().frames;
    assert.equal(f.renderer.render(f.input), true);
    assert.equal(f.renderer.getDiagnostics().frames, first + 1, 'pending timing work vetoes identical-output reuse');
    f.work.queryReady = true;
    assert.equal(f.renderer.render(f.input), true);
    assert.equal(f.renderer.hasPendingGpuQueries(), false);
    const completed = f.renderer.getDiagnostics();
    assert.equal(f.renderer.render(f.input), true);
    assert.equal(f.renderer.getDiagnostics().skippedFrames, completed.skippedFrames + 1);
});

test('WebGL rescue repaint preserves the primary pacing and timing sample', t => {
    let now = 1000;
    t.mock.method(performance, 'now', () => now);
    const f = fixture();
    t.after(() => f.renderer.dispose());
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
