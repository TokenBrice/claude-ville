import assert from 'node:assert/strict';
import test from 'node:test';

import { GpuWorldRenderer } from '../../claudeville/src/presentation/character-mode/gpu/GpuWorldRenderer.js';

// A GL stub that answers every entry point with a no-op. The lifecycle paths
// under test only delete handles and reset bookkeeping, so identity of the
// returned values never matters; what matters is that the renderer's own
// capacity bookkeeping is cleared alongside the handles it drops.
function stubGl() {
    const calls = [];
    return new Proxy({ ARRAY_BUFFER: 34962, DYNAMIC_DRAW: 35048 }, {
        get(target, property) {
            if (property in target) return target[property];
            if (property === 'isContextLost') return () => false;
            return (...args) => {
                calls.push({ name: String(property), args });
                return null;
            };
        },
        has: () => true,
    });
}

// The renderer bails out of its constructor before touching WebGL when the
// canvas cannot produce a context, which leaves a fully initialised instance
// whose lifecycle methods can be driven directly.
function detachedRenderer() {
    const renderer = new GpuWorldRenderer({ canvas: {} });
    renderer.gl = stubGl();
    return renderer;
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

test('abandoning GPU resources after context loss clears the same capacity', () => {
    const renderer = detachedRenderer();
    renderer.vertexBuffer = { id: 'vbo' };
    renderer.vertexBufferBytes = 8192;

    renderer._abandonGpuResources();

    assert.equal(renderer.vertexBuffer, null);
    assert.equal(renderer.vertexBufferBytes, 0);
});

test('a suspend/resume round trip cannot leave capacity ahead of the live buffer', () => {
    const renderer = detachedRenderer();
    renderer.supported = true;
    renderer.enabled = true;
    renderer.contextHealthy = true;
    renderer.vertexBuffer = { id: 'vbo' };
    renderer.vertexBufferBytes = 16384;

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
    const renderer = detachedRenderer();
    const calls = [];
    renderer.gl = new Proxy({ ARRAY_BUFFER: 34962, DYNAMIC_DRAW: 35048 }, {
        get(target, property) {
            if (property in target) return target[property];
            if (property === 'isContextLost') return () => false;
            return (...args) => {
                calls.push(String(property));
                return null;
            };
        },
        has: () => true,
    });

    const batch = () => ({
        records: [{
            x: 0, y: 0, width: 8, height: 8,
            u0: 0, v0: 0, u1: 1, v1: 1,
            alpha: 1, material: 1, emissive: 0, elevation: 0, occluder: 0,
        }],
    });

    renderer.vertexBuffer = { id: 'first' };
    renderer._stageFrameVertices([batch()]);
    assert.ok(
        calls.includes('bufferData'),
        'the first frame must allocate storage for the buffer',
    );

    // World -> Dashboard tears the resources down; World again builds a fresh
    // zero-size buffer. The upload must allocate before it writes, or every
    // draw reads an empty buffer and the island disappears.
    renderer._releaseGpuResources();
    renderer.vertexBuffer = { id: 'resumed' };
    calls.length = 0;
    renderer._stageFrameVertices([batch()]);

    const allocated = calls.indexOf('bufferData');
    const filled = calls.indexOf('bufferSubData');
    assert.notEqual(allocated, -1, 'the resumed buffer must be allocated again');
    assert.notEqual(filled, -1, 'the resumed buffer must still be filled');
    assert.ok(
        allocated < filled,
        'bufferData must precede bufferSubData on the frame after a resume',
    );
});
