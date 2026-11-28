import assert from 'node:assert/strict';
import test from 'node:test';

import { GpuWorldRenderer } from '../../claudeville/src/presentation/character-mode/gpu/GpuWorldRenderer.js';
import { GPU_RECORD_FLAGS } from '../../claudeville/src/presentation/character-mode/gpu/GpuWorldPolicy.js';

// A small WebGL stub with the object-creation and status responses needed by
// _initResources(). Lifecycle tests still observe calls, but never depend on
// browser-owned WebGL objects.
function stubGl(calls = []) {
    let nextHandle = 0;
    const constants = {
        ARRAY_BUFFER: 34962,
        DYNAMIC_DRAW: 35048,
        FLOAT: 5126,
        FRAMEBUFFER: 36160,
        FRAMEBUFFER_COMPLETE: 36053,
        COLOR_ATTACHMENT0: 36064,
        TEXTURE_2D: 3553,
        TEXTURE_MIN_FILTER: 10241,
        TEXTURE_MAG_FILTER: 10240,
        TEXTURE_WRAP_S: 10242,
        TEXTURE_WRAP_T: 10243,
        CLAMP_TO_EDGE: 33071,
        NEAREST: 9728,
        LINEAR: 9729,
        RGBA: 6408,
        UNSIGNED_BYTE: 5121,
        VERTEX_SHADER: 35633,
        FRAGMENT_SHADER: 35632,
        COMPILE_STATUS: 35713,
        LINK_STATUS: 35714,
    };
    const handle = name => ({ name, id: ++nextHandle });
    return new Proxy(constants, {
        get(target, property) {
            if (property in target) return target[property];
            if (property === 'isContextLost') return () => false;
            return (...args) => {
                const name = String(property);
                calls.push({ name, args });
                if (name === 'createShader') return { ...handle(name), type: args[0] };
                if (name.startsWith('create') || name === 'getUniformLocation') {
                    return handle(name);
                }
                if (name === 'getShaderParameter' || name === 'getProgramParameter') {
                    return true;
                }
                if (name === 'checkFramebufferStatus') return target.FRAMEBUFFER_COMPLETE;
                return null;
            };
        },
        has: () => true,
    });
}

// The renderer bails out of its constructor before touching WebGL when the
// canvas cannot produce a context, which leaves a fully initialised instance
// whose lifecycle methods can be driven directly. The canvas still needs the
// size and style fields resize() writes.
function stubCanvas(gl = null) {
    const canvas = { width: 64, height: 64, style: {} };
    if (gl) canvas.getContext = () => gl;
    return canvas;
}

function detachedRenderer(calls = []) {
    const renderer = new GpuWorldRenderer(stubCanvas());
    renderer.gl = stubGl(calls);
    return renderer;
}

// A renderer whose canvas hands back the stub context, so the constructor runs
// the real _initResources()/resize() pass and suspend()/resume() can be driven
// through their public entry points.
function initializedRenderer(calls = []) {
    const renderer = new GpuWorldRenderer(stubCanvas(stubGl(calls)));
    assert.equal(renderer.supported, true, 'the stub context must initialise the renderer');
    assert.equal(renderer.contextHealthy, true);
    return renderer;
}

function frameBatch() {
    return {
        records: [{
            x: 0, y: 0, width: 8, height: 8,
            u0: 0, v0: 0, u1: 1, v1: 1,
            alpha: 1, material: 1, emissive: 0, elevation: 0, occluder: 0,
        }],
    };
}

test('releasing GPU resources clears the vertex buffer capacity it just invalidated', () => {
    const renderer = detachedRenderer();
    renderer.vertexBuffer = { id: 'vbo' };
    renderer.vertexBufferBytes = 4096;

    renderer._releaseGpuResources();

    assert.equal(renderer.vertexBuffer, null, 'the buffer handle must be dropped');
    assert.equal(
        renderer.vertexBufferBytes,
        0,
        'a stale capacity makes the next upload skip bufferData and draw no geometry',
    );
});

test('fragment shaders with integer math declare high precision', () => {
    const calls = [];
    const renderer = initializedRenderer(calls);
    assert.ok(renderer._ensureP3Programs());
    renderer.setDebugLoad(1);
    renderer._drawDebugLoad(1);
    const fragments = calls.filter(call => call.name === 'shaderSource' && call.args[0].type === renderer.gl.FRAGMENT_SHADER);
    assert.ok(fragments.length >= 9);
    for (const { args: [, source] } of fragments) {
        const code = source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');
        if (/\b(?:u?int|[iu]vec[234])\b|\b\d+u\b/.test(code)) {
            assert.match(code, /^precision highp int;/m, code.split('\n').slice(0, 5).join('\n'));
        }
        if (code.includes('float seaSeamLattice(')) assert.match(code, /highp uint h = .*1597334677u/);
    }
});

test('typed uploads restore the binding directly only when storage holds', () => {
    const calls = [];
    const renderer = detachedRenderer(calls);
    const upload = (width, revision) => renderer.uploadTypedTexture('lights', {
        width, height: 1, format: 'rgba32f', data: new Float32Array(width * 4), revision,
    });
    const first = upload(1, 1);
    renderer.gl.getParameter = () => first;
    renderer.gl.isTexture = texture => {
        calls.push({ name: 'isTexture', args: [texture] });
        return false;
    };

    calls.length = 0;
    renderer.frames++;
    assert.equal(upload(1, 2), first);
    assert.ok(calls.some(call => call.name === 'texSubImage2D'));
    assert.ok(!calls.some(call => call.name === 'isTexture'));
    assert.equal(calls.filter(call => call.name === 'bindTexture').at(-1).args[1], first);

    calls.length = 0;
    renderer.frames++;
    assert.notEqual(upload(2, 3), first);
    assert.ok(calls.some(call => call.name === 'deleteTexture' && call.args[0] === first));
    assert.ok(calls.some(call => call.name === 'isTexture' && call.args[0] === first));
    assert.equal(calls.filter(call => call.name === 'bindTexture').at(-1).args[1], null);
});

test('scene batch flags write only transitions and initialize every direct or replayed pass', () => {
    const calls = [];
    const renderer = initializedRenderer(calls);
    renderer._setSceneUniforms = () => { renderer._puddleActive = true; };
    renderer.fatPixelsFrame = true;
    const flags = ['u_additive', 'u_hasMaterialMap', 'u_hasEmissiveMap', 'u_hasOccluderMap',
        'u_puddleGround', 'u_terrainBatch', 'u_fatPixels', 'u_cueRuns'];
    const plain = { albedoTexture: {}, records: [{}] };
    const lit = {
        ...plain,
        blend: 'add',
        materialTexture: {},
        emissiveTexture: {},
        occluderTexture: {},
        cueRuns: true,
        records: [{ id: 'terrain:static', flags: GPU_RECORD_FLAGS.fatOptOut }],
    };
    const batches = [plain, plain, lit, lit, plain];
    for (const [direct, restore] of [[false, false], [true, false], [false, true]]) {
        if (restore) {
            renderer.suspend();
            assert.equal(renderer.resume(), true);
        }
        renderer._directFrame = direct;
        const values = flags.map(flag => flag === 'u_fatPixels' ? [1, 0, 1] : [0, 1, 0]);
        const drawn = [];
        renderer._drawBatch = () => {
            drawn.push(flags.map(flag => calls.findLast(call => call.name === 'uniform1i'
                && call.args[0] === renderer.sceneUniforms[flag])?.args[1]));
        };
        calls.length = 0;
        renderer._stageGlUniforms({}, {}, 0, batches, null, direct);
        renderer._renderScene(batches, {}, {});
        assert.deepEqual(drawn, [0, 0, 1, 1, 2].map(index => values.map(value => value[index])));
        for (const [index, flag] of flags.entries()) {
            assert.deepEqual(calls.filter(call => call.name === 'uniform1i' && call.args[0] === renderer.sceneUniforms[flag])
                .map(call => call.args[1]), values[index], flag);
        }
    }
});

test('abandoning GPU resources after context loss clears the same capacity', () => {
    const renderer = detachedRenderer();
    renderer.vertexBuffer = { id: 'vbo' };
    renderer.vertexBufferBytes = 8192;

    renderer._abandonGpuResources();

    assert.equal(renderer.vertexBuffer, null);
    assert.equal(renderer.vertexBufferBytes, 0);
});

test('a suspend/resume round trip cannot leave capacity ahead of the live buffer', () => {
    const renderer = initializedRenderer();
    renderer._stageFrameVertices([frameBatch()]);
    assert.ok(renderer.vertexBufferBytes > 0, 'the first upload allocates real capacity');

    // Mode switches suspend the renderer; the resume path rebuilds resources
    // from scratch, so any retained capacity would describe a buffer that no
    // longer exists.
    renderer.suspend();

    assert.equal(renderer.suspended, true);
    assert.equal(
        renderer.vertexBufferBytes,
        0,
        'World -> Dashboard -> World must not inherit the pre-suspend VBO size',
    );
});

test('a resumed renderer allocates the frame VBO before filling it', () => {
    const calls = [];
    const renderer = initializedRenderer(calls);

    renderer._stageFrameVertices([frameBatch()]);
    const firstBufferBytes = renderer.vertexBufferBytes;
    assert.ok(
        calls.some(({ name }) => name === 'bufferData'),
        'the first frame must allocate storage for the buffer',
    );

    // World -> Dashboard suspends the renderer; World again resumes it onto a
    // fresh zero-size buffer. The next upload must allocate before it writes,
    // or every draw reads an empty buffer and the island disappears.
    renderer.suspend();
    assert.equal(renderer.suspended, true);
    assert.equal(renderer.resume(), true);
    assert.equal(renderer.suspended, false);
    assert.ok(renderer.vertexBuffer, 'resume must rebuild the frame VBO');

    calls.length = 0;
    renderer._stageFrameVertices([frameBatch()]);

    const names = calls.map(({ name }) => name);
    const allocated = names.indexOf('bufferData');
    const filled = names.indexOf('bufferSubData');
    assert.notEqual(allocated, -1, 'the resumed buffer must be allocated again');
    assert.notEqual(filled, -1, 'the resumed buffer must still be filled');
    assert.ok(
        allocated < filled,
        'bufferData must precede bufferSubData on the frame after a resume',
    );
    assert.equal(
        renderer.vertexBufferBytes,
        firstBufferBytes,
        'the resumed buffer reports the capacity it just allocated',
    );
});
