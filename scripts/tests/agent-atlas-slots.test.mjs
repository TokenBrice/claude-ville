import test from 'node:test';
import assert from 'node:assert/strict';

import { packGpuAgentFrameAtlas } from '../../claudeville/src/presentation/character-mode/gpu/GpuSceneBuilder.js';

function fakeCanvas(width = 0, height = 0) {
    const pixels = new Set();
    function paint(x, y, w, h, opaque) {
        for (let dy = 0; dy < h; dy++) {
            for (let dx = 0; dx < w; dx++) {
                const key = `${x + dx},${y + dy}`;
                if (opaque(dx, dy)) pixels.add(key);
                else pixels.delete(key);
            }
        }
    }
    return {
        width,
        height,
        alphaAt(x, y) { return pixels.has(`${x},${y}`) ? 255 : 0; },
        getContext() {
            return {
                clearRect(x, y, w, h) { paint(x, y, w, h, () => false); },
                fillRect(x, y, w, h) { paint(x, y, w, h, () => true); },
                drawImage(source, sx, sy, sw, sh, dx, dy, dw, dh) {
                    paint(dx, dy, dw, dh, (x, y) => source.alphaAt(sx + Math.floor(x * sw / dw), sy + Math.floor(y * sh / dh)));
                },
            };
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

test('a replacement slot clears both channels in a same-sized atlas upload', t => {
    globalThis.document = { createElement: () => fakeCanvas() };
    t.after(() => { delete globalThis.document; });
    const renderer = { agentSprites: new Map([['b', {}], ['z', {}]]) };
    const lit = (id) => {
        const frame = record(`agent:${id}`);
        const sheet = fakeCanvas(8, 8);
        sheet.getContext('2d').fillRect(0, 0, 8, 8);
        return { ...frame, materialSource: sheet, emissiveSource: sheet };
    };
    const [b] = packGpuAgentFrameAtlas(renderer, [lit('b'), lit('z')]);
    renderer.agentSprites.delete('b');
    renderer.agentSprites.set('a', {});
    const [a, z] = packGpuAgentFrameAtlas(renderer, [record('agent:a'), lit('z')]);
    for (const channel of ['material', 'emissive']) {
        const page = a[`${channel}Source`];
        assert.equal(page, b[`${channel}Source`], 'grid size holds');
        assert.equal(page.alphaAt(a.sx, a.sy), 0, `replacement ${channel} is transparent`);
        assert.equal(page.alphaAt(z.sx, z.sy), 255, `neighbor ${channel} stays opaque`);
        assert.equal(a[`${channel}Revision`], b[`${channel}Revision`] + 1);
        assert.deepEqual(a[`${channel}TextureUpdates`], [], 'the updated revision uploads the cleared page in full');
    }
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
