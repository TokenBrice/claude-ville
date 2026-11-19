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
        assert.deepEqual(a[`${channel}TextureUpdates`], [
            { x: a.sx, y: a.sy, sx: a.sx, sy: a.sy, width: 8, height: 8, source: page },
        ], 'only the replacement cell is patched');
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

test('walk frames wrap after all pose and prop cells and refill when only the base moves', t => {
    globalThis.document = { createElement: () => fakeCanvas() };
    t.after(() => { delete globalThis.document; });
    const renderer = { agentSprites: new Map(Array.from({ length: 8 }, (_, n) => [String(n), {}])) };
    const sheet = fakeCanvas(48, 8);
    const cells = Array.from({ length: 6 }, (_, i) => {
        sheet.getContext('2d').fillRect(8 * i + i, i, 1, 1);
        return { source: sheet, materialSource: sheet, emissiveSource: sheet, sx: i * 8, sy: 0, sw: 8, sh: 8 };
    });
    const pack = (frame, prop = false) => {
        const body = { ...record('agent:0'), ...cells[frame], walkStrip: { key: 'walk', cells, frame } };
        return packGpuAgentFrameAtlas(renderer, prop ? [body, record('agent:0:prop')] : [body])[0];
    };
    for (const [frame, withProp] of [[3, false], [4, false], [5, false], [0, false], [4, true], [4, false]]) {
        const previous = renderer._gpuAgentFrameAtlas;
        const packed = pack(frame, withProp);
        const base = renderer._gpuAgentAtlasSlots.size * 4;
        const index = base + frame;
        const x = index % 6 * 8, y = Math.floor(index / 6) * 8;
        assert.deepEqual([packed.sx, packed.sy, packed.sourceWidth, packed.sourceHeight], [x, y, 48, 96]);
        if (previous) assert.equal(packed.source, previous, 'growth by one prop keeps the grid dimensions');
        for (const [page, updates] of [[packed.source, packed.textureUpdates],
            [packed.materialSource, packed.materialTextureUpdates], [packed.emissiveSource, packed.emissiveTextureUpdates]]) {
            assert.equal(page.alphaAt(x + frame, y + frame), 255, 'the sampled texel follows the walk frame');
            assert.equal(page.alphaAt(x + (frame + 1) % 6, y + frame), 0);
            for (const patch of updates) {
                assert.equal(patch.source, page);
                assert.deepEqual([patch.x, patch.y, patch.width, patch.height], [patch.sx, patch.sy, 8, 8]);
                assert.ok(patch.x + 8 <= page.width && patch.y + 8 <= page.height);
            }
        }
    }
});

function equippedWalkers(t) {
    const ctx = { drawImage() {}, clearRect() {} };
    globalThis.document = { createElement: () => ({ getContext: () => ctx }) };
    t.after(() => { delete globalThis.document; });
    const sheet = { width: 140, height: 140 };
    const cell = { source: sheet, materialSource: sheet, emissiveSource: sheet, sw: 140, sh: 140 };
    const walkStrip = { key: 'walk', frame: 5, cells: Array(6).fill(cell) };
    return count => Array.from({ length: count }, (_, n) => ({ ...cell, walkStrip, id: `agent:${n}` }));
}

test('24 equipped bodies reserve 96 pose cells plus 102 strip cells', t => {
    const walkers = equippedWalkers(t);
    const records = walkers(24);
    const renderer = {};
    packGpuAgentFrameAtlas(renderer, records);
    assert.equal(renderer._gpuAgentStripCapacity, 17);
    assert.deepEqual([records[0].sourceWidth, records[0].sourceHeight], [1400, 2940]);
    assert.equal(new Set(records.map(r => `${r.sx},${r.sy}`)).size, 24);
});

test('single arrivals from 2 to 30 equipped walkers resize all three pages only 12 times', t => {
    const walkers = equippedWalkers(t);
    const renderer = { agentSprites: new Map([['0', {}]]) };
    const resizedAt = [];
    let previous;
    for (let count = 2; count <= 30; count++) {
        renderer.agentSprites.set(String(count - 1), {});
        const [frame] = packGpuAgentFrameAtlas(renderer, walkers(count));
        const resized = frame.source !== previous;
        if (previous && resized) resizedAt.push(count);
        for (const updates of [frame.textureUpdates, frame.materialTextureUpdates, frame.emissiveTextureUpdates]) {
            assert.equal(updates.length === 0, resized, `full upload only on resize at ${count} walkers`);
        }
        previous = frame.source;
    }
    assert.equal(resizedAt.length, 12, `resized on arrival at ${resizedAt.join(', ')}`);
    assert.ok(!resizedAt.includes(25), 'the 25th walker uses the row reserved at 24');
});

test('a reassigned padded slot patches its old and new channel bounds, including after the channel sleeps', t => {
    globalThis.document = { createElement: () => fakeCanvas() };
    t.after(() => { delete globalThis.document; });
    const renderer = { agentSprites: new Map([['b', {}], ['z', {}]]) };
    const source = fakeCanvas(8, 8);
    source.getContext('2d').fillRect(0, 0, 8, 8);
    const padded = (id, dx, dy, sw, sh) => ({
        ...record('agent:' + id), materialSource: source,
        channelRect: { sx: 0, sy: 0, sw, sh, dx, dy },
    });
    const [before] = packGpuAgentFrameAtlas(renderer, [padded('b', 2, 2, 5, 4), record('agent:z')]);
    const page = before.materialSource;
    assert.equal(page.alphaAt(6, 5), 255);
    packGpuAgentFrameAtlas(renderer, [record('agent:b'), record('agent:z')]);
    renderer.agentSprites.delete('b');
    renderer.agentSprites.set('a', {});
    const [after] = packGpuAgentFrameAtlas(renderer, [padded('a', 1, 1, 3, 3), record('agent:z')]);
    assert.equal(after.materialSource, page);
    assert.equal(page.alphaAt(1, 1), 255);
    assert.equal(page.alphaAt(6, 5), 0);
    assert.deepEqual(after.materialTextureUpdates, [
        { x: 1, y: 1, sx: 1, sy: 1, width: 6, height: 5, source: page },
    ]);
});

test('a clipped half-resolution pose uploads every touched texel', t => {
    globalThis.document = { createElement: () => fakeCanvas() };
    t.after(() => { delete globalThis.document; });
    const renderer = {};
    const pose = (sx) => ({ ...record('agent:a', sx), sh: 5.5, urgentPose: true });
    packGpuAgentFrameAtlas(renderer, [pose(0)]);
    const [frame] = packGpuAgentFrameAtlas(renderer, [pose(8)]);
    assert.equal(frame.sh, 5.5);
    assert.deepEqual(frame.textureUpdates, [
        { x: frame.sx, y: frame.sy, sx: frame.sx, sy: frame.sy, width: 8, height: 6, source: frame.source },
    ]);
});
