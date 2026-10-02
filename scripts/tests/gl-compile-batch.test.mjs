import assert from 'node:assert/strict';
import test from 'node:test';

import { GpuWorldRenderer } from '../../claudeville/src/presentation/character-mode/gpu/GpuWorldRenderer.js';

function fakeGl({ shaderFailure = null, linkFailure = null, shaderLog = '', programLog = '' } = {}) {
    const events = [];
    const programs = [];
    const shaders = [];
    const constants = {
        VERTEX_SHADER: 35633,
        FRAGMENT_SHADER: 35632,
        COMPILE_STATUS: 35713,
        LINK_STATUS: 35714,
        FRAMEBUFFER_COMPLETE: 36053,
    };
    let nextHandle = 0;
    const handle = kind => ({ kind, id: ++nextHandle });
    const gl = new Proxy(constants, {
        get(target, property) {
            if (property in target) return target[property];
            if (property === 'isContextLost') return () => false;
            return (...args) => {
                events.push({ name: property, args });
                switch (property) {
                    case 'createShader': {
                        const shader = { ...handle('shader'), type: args[0] };
                        shaders.push(shader);
                        return shader;
                    }
                    case 'shaderSource':
                        args[0].source = args[1];
                        break;
                    case 'compileShader':
                        args[0].compiled = true;
                        break;
                    case 'createProgram': {
                        const program = { ...handle('program'), index: programs.length, shaders: [] };
                        programs.push(program);
                        return program;
                    }
                    case 'attachShader':
                        args[0].shaders.push(args[1]);
                        break;
                    case 'linkProgram':
                        args[0].linked = true;
                        break;
                    case 'getShaderParameter':
                        assert.equal(args[1], target.COMPILE_STATUS);
                        assert.equal(args[0].compiled, true);
                        args[0].checked = true;
                        return !shaderFailure?.(args[0], programs);
                    case 'getProgramParameter':
                        assert.equal(args[1], target.LINK_STATUS);
                        assert.equal(args[0].linked, true);
                        args[0].checked = true;
                        return !linkFailure?.(args[0]);
                    case 'getShaderInfoLog': return shaderLog;
                    case 'getProgramInfoLog': return programLog;
                    case 'getUniformLocation': {
                        const [program, name] = args;
                        assert.equal(program.checked, true, 'locations require a validated program');
                        return { program, name };
                    }
                    case 'deleteShader':
                    case 'deleteProgram':
                        args[0].deleted = true;
                        break;
                    case 'checkFramebufferStatus': return target.FRAMEBUFFER_COMPLETE;
                    case 'getExtension': return null;
                    case 'isProgram': return !args[0].deleted;
                    default:
                        if (String(property).startsWith('create')) return handle(property);
                }
                return null;
            };
        },
    });
    return { gl, events, programs, shaders };
}

function rendererFor(gl = null) {
    const canvas = { width: 64, height: 64, style: {} };
    if (gl) canvas.getContext = () => gl;
    return new GpuWorldRenderer(canvas);
}

function assertBatchOrdering(events, programs) {
    const firstStatus = events.findIndex(({ name }) => name === 'getShaderParameter' || name === 'getProgramParameter');
    const firstLocation = events.findIndex(({ name }) => name === 'getUniformLocation' || name === 'getAttribLocation');
    assert.ok(firstStatus >= 0, 'the batch must be validated synchronously');
    for (const program of programs) {
        const link = events.findIndex(({ name, args }) => name === 'linkProgram' && args[0] === program);
        assert.ok(link >= 0 && link < firstStatus);
        for (const shader of program.shaders) {
            const compile = events.findIndex(({ name, args }) => name === 'compileShader' && args[0] === shader);
            const attach = events.findIndex(({ name, args }) => name === 'attachShader' && args[1] === shader);
            assert.ok(compile >= 0 && compile < firstStatus);
            assert.ok(attach >= 0 && attach < firstStatus);
        }
    }
    if (firstLocation >= 0) {
        for (const [index, event] of events.entries()) {
            if (event.name === 'getShaderParameter' || event.name === 'getProgramParameter') {
                assert.ok(index < firstLocation, 'validate the whole batch before resolving locations');
            }
        }
    }
}

test('initial WebGL programs compile and link as a batch before status checks or locations', () => {
    const { gl, events, programs, shaders } = fakeGl();
    const renderer = rendererFor(gl);
    assert.equal(renderer.contextHealthy, true);
    assert.deepEqual(programs, [
        renderer.sceneProgram, renderer.particleProgram, renderer.bloomProgram,
        renderer.compositeProgram, renderer.markProgram,
    ]);
    assertBatchOrdering(events, programs);
    for (const program of programs) {
        assert.deepEqual(program.shaders.map(shader => shader.type), [gl.VERTEX_SHADER, gl.FRAGMENT_SHADER]);
        assert.ok(program.shaders.every(shader => shader.checked && shader.deleted));
        assert.equal(program.deleted, undefined);
    }
    assert.ok(shaders.every(shader => shader.checked));
    for (const [programKey, uniformsKey] of [
        ['sceneProgram', 'sceneUniforms'], ['particleProgram', 'particleUniforms'],
        ['bloomProgram', 'bloomUniforms'], ['compositeProgram', 'compositeUniforms'],
        ['markProgram', 'markUniforms'],
    ]) {
        for (const [name, location] of Object.entries(renderer[uniformsKey])) {
            assert.equal(location.program, renderer[programKey]);
            assert.equal(location.name, name);
        }
    }
});

for (const [shaderLog, expected] of [['driver shader failure', 'driver shader failure'], ['', 'unknown shader error']]) {
    test(`failed shader preserves the reported error: ${expected}`, () => {
        const { gl, events, programs, shaders } = fakeGl({
            shaderFailure: shader => shader.type === gl.FRAGMENT_SHADER,
            linkFailure: () => true,
            shaderLog,
            programLog: 'link failure must not mask the shader error',
        });
        const renderer = rendererFor();
        renderer.gl = gl;
        assert.throws(() => renderer._initResources(), { message: expected });
        assertBatchOrdering(events, programs);
        assert.ok(shaders.every(shader => shader.deleted), 'failed batch releases its shader handles');
        assert.ok(programs.every(program => program.deleted), 'failed batch releases unvalidated programs');
        assert.equal(events.some(({ name }) => name === 'getUniformLocation'), false);
        assert.equal(events.some(({ name }) => name === 'getProgramInfoLog'), false);
    });
}

test('a later shader failure still marks construction unhealthy and stops location resolution', t => {
    const warn = t.mock.method(console, 'warn', () => {});
    const { gl, events, programs } = fakeGl({
        shaderFailure: (shader, programs) => programs[1].shaders.includes(shader),
        shaderLog: 'particle shader failure',
    });
    const renderer = rendererFor(gl);
    assert.equal(renderer.contextHealthy, false);
    assert.equal(warn.mock.calls[0].arguments[1].message, 'particle shader failure');
    assert.equal(programs[0].deleted, undefined, 'the previously validated scene program stays owned by the renderer');
    assert.ok(programs.slice(1).every(program => program.deleted));
    assert.equal(events.some(({ name }) => name === 'getUniformLocation'), false);
});

for (const [programLog, expected] of [['driver link failure', 'driver link failure'], ['', 'unknown program link error']]) {
    test(`failed link leaves initialization unhealthy and preserves its error: ${expected}`, t => {
        const warn = t.mock.method(console, 'warn', () => {});
        const { gl, programs } = fakeGl({ linkFailure: () => true, programLog });
        const renderer = rendererFor(gl);
        assert.equal(renderer.supported, true);
        assert.equal(renderer.contextHealthy, false);
        assert.equal(warn.mock.calls[0].arguments[0], '[GpuWorldRenderer] initialization failed:');
        assert.equal(warn.mock.calls[0].arguments[1].message, expected);
        assert.ok(programs.every(program => program.deleted));
    });
}

test('P3 and debug-load programs remain synchronous lazy creations', () => {
    const { gl, events, programs } = fakeGl();
    const renderer = rendererFor(gl);
    events.length = 0;
    const basePrograms = [...programs];
    assert.equal(renderer._ensureP3Programs(), true);
    for (const [program, uniforms] of [
        [renderer.compositeP3Program, renderer.compositeP3Uniforms],
        [renderer.markP3Program, renderer.markP3Uniforms],
    ]) {
        assert.equal(program.checked, true);
        for (const [name, location] of Object.entries(uniforms)) {
            assert.equal(location.program, program);
            assert.equal(location.name, name);
        }
    }
    assert.deepEqual(Object.keys(renderer.compositeP3Uniforms), [...Object.keys(renderer.compositeUniforms), 'u_emission', 'u_roles']);
    assert.deepEqual(Object.keys(renderer.markP3Uniforms), Object.keys(renderer.markUniforms));
    renderer.setDebugLoad({ passes: 1 });
    renderer._drawDebugLoad(1);
    assert.equal(renderer._debugLoad.program.checked, true);
    assert.equal(renderer._debugLoad.sceneLocation.program, renderer._debugLoad.program);
    assert.equal(renderer._debugLoad.sceneLocation.name, 'u_scene');
    assert.equal(renderer._debugLoad.owner, renderer.compositeProgram);
    assert.ok(basePrograms.every(program => !program.deleted));
});

test('a lazy P3 shader failure keeps the existing sRGB fallback', t => {
    const warn = t.mock.method(console, 'warn', () => {});
    const { gl } = fakeGl({
        shaderFailure: (shader, programs) => programs.find(program => program.shaders.includes(shader))?.index >= 5,
        shaderLog: 'P3 compile failure',
    });
    const renderer = rendererFor(gl);
    renderer._p3 = true;
    assert.equal(renderer._ensureP3Programs(), false);
    assert.equal(renderer.contextHealthy, true);
    assert.equal(renderer._p3, false);
    assert.equal(gl.drawingBufferColorSpace, 'srgb');
    assert.equal(warn.mock.calls[0].arguments[1].message, 'P3 compile failure');
});
