import test from 'node:test';
import assert from 'node:assert/strict';

import { packGpuAgentFrameAtlas } from '../../claudeville/src/presentation/character-mode/gpu/GpuSceneBuilder.js';

function fakeCanvas(width = 0, height = 0) {
    return {
        width,
        height,
        getContext() {
            return { imageSmoothingEnabled: false, clearRect() {}, fillRect() {}, drawImage() {} };
        },
    };
}

const record = (id, sx = 0) => ({
    id,
    textureKey: `sheet:${id}`,
    source: fakeCanvas(32, 32),
    sourceWidth: 32,
    sourceHeight: 32,
    sx,
    sy: 0,
    sw: 8,
    sh: 8,
    width: 8,
    height: 8,
    textureRevision: `rev:${id}`,
});

test('every assigned agent atlas slot lies on the grid, though extra ids outnumber the records present', () => {
    const previousDocument = globalThis.document;
    globalThis.document = { createElement: () => fakeCanvas() };
    try {
        const renderer = { agentSprites: new Map([['a', {}], ['b', {}]]) };
        // A waits (its candle takes a slot), then B waits (A's candle gone):
        // the slots handed out (4) exceed the records present (3).
        packGpuAgentFrameAtlas(renderer, [record('agent:a'), record('agent:b'), record('agent:a:queue-candle')]);
        const frame = [record('agent:a'), record('agent:b'), record('agent:b:queue-candle')];
        const packed = packGpuAgentFrameAtlas(renderer, frame);
        const atlas = renderer._gpuAgentFrameAtlas;
        const cells = new Set();
        for (const r of packed) {
            assert.ok(r.sx + r.sw <= atlas.width && r.sy + r.sh <= atlas.height, `${r.id} lies inside the atlas`);
            const key = `${r.sx},${r.sy}`;
            assert.ok(!cells.has(key), `${r.id} has a cell of its own`);
            cells.add(key);
        }
    } finally {
        if (previousDocument === undefined) delete globalThis.document;
        else globalThis.document = previousDocument;
    }
});
