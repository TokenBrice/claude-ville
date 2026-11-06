import test from 'node:test';
import assert from 'node:assert/strict';
import { GpuWorldRenderer } from '../../claudeville/src/presentation/character-mode/gpu/GpuWorldRenderer.js';
import { NEUTRAL_GRADE } from '../../claudeville/src/presentation/character-mode/GradeEvaluator.js';
import { GPU_RECORD_FLAGS } from '../../claudeville/src/presentation/character-mode/gpu/GpuWorldPolicy.js';

function fixture({ radiance = false, timers = false } = {}) {
    const work = { draws: 0, writes: 0, binds: 0, units: 0, queryReady: false };
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
                if (key === 'bindTexture') work.binds++;
                if (key === 'activeTexture') work.units++;
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
    assert.equal(f.renderer.lastFrameReused, false, 'a drawn frame is not a confirmed static one');
    const draws = f.work.draws;
    const writes = f.work.writes;
    assert.equal(f.renderer.render(f.input), true);
    assert.equal(f.work.draws, draws, 'identical staged frame must retain pixels');
    assert.equal(f.work.writes, writes, 'retained frame must not rewrite staged buffers');
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

// PF-1 — a live clock puts a new u_time in every recorded stream, so the byte
// gate can never match; such frames submit directly and record no commands.
test('a live-clock frame submits directly, records nothing, and still presents', () => {
    const f = fixture();
    baseline(f);
    const draws = f.work.draws;
    f.input.feed.timeMs++;
    assert.equal(f.renderer.render(f.input), true);
    assert.ok(f.work.draws > draws, 'the direct frame still draws');
    assert.equal(f.renderer.lastFrameReused, false);
    assert.equal(f.renderer._sceneCommands._count, 0, 'scene stream records nothing');
    assert.equal(f.renderer._particleCommands._count, 0, 'particle stream records nothing');
    assert.equal(f.renderer._compositeCommands._count, 0, 'composite stream records nothing');
    assert.equal(f.renderer._bloomCommandsA._count, 0, 'bloom streams record nothing');
    assert.equal(f.renderer._batchCommands[0]._count, 0, 'batch streams record nothing');
    f.renderer.dispose();
});

// A direct frame invalidates the reuse baseline (the presented output no
// longer matches it); one further recorded frame re-primes it.
test('a fixed clock re-engages output reuse after a direct frame', () => {
    const f = fixture();
    baseline(f);
    const skipped = f.renderer.getDiagnostics().skippedFrames;
    f.input.feed.timeMs++;
    assert.equal(f.renderer.render(f.input), true);
    assert.equal(f.renderer.getDiagnostics().skippedFrames, skipped, 'a direct frame is no skip');
    assert.equal(f.renderer.render(f.input), true);
    assert.equal(f.renderer.getDiagnostics().skippedFrames, skipped, 'the first re-priming frame repaints');
    assert.equal(f.renderer.render(f.input), true);
    assert.equal(f.renderer.getDiagnostics().skippedFrames, skipped + 1, 'reuse re-engages');
    assert.equal(f.renderer.lastFrameReused, true);
    f.renderer.dispose();
});

// PF-5 — the bind mirror drops no-op bindTexture calls (the per-batch sidecar
// rebinds of emptyMaterialTexture) before the driver. Unit selects between
// genuinely different units still issue: only binds that would not change the
// context are skipped.
test('a many-batch frame binds far fewer textures than it has batches', () => {
    const f = fixture();
    f.input.records = Array.from({ length: 24 }, (_, index) => ({
        ...f.input.records[0], id: `sprite-${index}`, textureKey: `sprite-${index}`,
    }));
    assert.equal(f.renderer.render(f.input), true);
    assert.equal(f.renderer.batches, 24);
    const before = { binds: f.work.binds, units: f.work.units };
    f.input.feed.timeMs++;
    assert.equal(f.renderer.render(f.input), true);
    const binds = f.work.binds - before.binds;
    // Unmirrored, each batch rebinds albedo + its sidecar: the 24 batches
    // alone cost ≥48 binds. The mirror keeps one bind per distinct
    // (unit, target, texture): the empty sidecars settle once per frame and
    // only the 24 genuinely different albedos pay.
    assert.ok(binds <= 44, `expected ≤44 binds for 24 distinct-atlas batches, saw ${binds}`);
    assert.ok(f.work.units > before.units, 'unit selects still flow for real unit changes');
    f.renderer.dispose();
});
