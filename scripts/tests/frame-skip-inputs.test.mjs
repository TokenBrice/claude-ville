import test from 'node:test';
import assert from 'node:assert/strict';
import { GpuFrameReuse, stageGpuFrameBindings } from '../../claudeville/src/presentation/character-mode/gpu/GpuFrameReuse.js';

function fixture() {
    const records = new Uint8Array([1, 2, 3, 4]);
    const instances = new Uint8Array([5, 6, 7, 8]);
    const frame = new Uint8Array([9, 10, 11, 12]);
    const batches = new Uint8Array([13, 14, 15, 16]);
    const marks = new Uint8Array([17, 18, 19, 20]);
    const texture = { texture: {}, source: {}, revision: 1, width: 8, height: 8 };
    const renderer = {
        device: {}, canvas: { width: 640, height: 480 }, width: 640, height: 480,
        sceneTarget: {}, _canvasGeneration: 1, _display: {}, hdrMode: 'off',
        _frameBindKey: 'bound', _albedoPage: { texture: {}, uploads: 1 }, uploads: 1,
        _textureEntries: new Map([['albedo', texture]]),
    };
    const batch = { count: 1, instanceOffset: 0, tail: true, blend: 'over', writesDepth: true, albedoTexture: texture.texture };
    const reuse = new GpuFrameReuse();
    function stage() {
        reuse.begin();
        for (const bytes of [records, instances, frame, batches, marks]) reuse.bytes(bytes);
        stageGpuFrameBindings(reuse, renderer, [batch], []);
        return reuse.unchanged();
    }
    return { reuse, records, instances, frame, batches, marks, renderer, texture, batch, stage };
}

const poisons = {
    'record byte': f => f.records[0]++,
    'particle instance byte': f => f.instances[0]++,
    'frame uniform byte': f => f.frame[0]++,
    'batch uniform byte': f => f.batches[0]++,
    'mark byte': f => f.marks[0]++,
    'texture revision': f => f.texture.revision++,
    'texture replacement': f => { f.texture.texture = {}; },
    'texture source replacement': f => { f.texture.source = {}; },
    'texture size': f => f.texture.width++,
    'texture roster': f => f.renderer._textureEntries.set('new', { texture: {}, revision: 1 }),
    'canvas width': f => f.renderer.canvas.width++,
    'canvas height': f => f.renderer.canvas.height++,
    'target width': f => f.renderer.width++,
    'target height': f => f.renderer.height++,
    'canvas generation': f => f.renderer._canvasGeneration++,
    'canvas replacement': f => { f.renderer.canvas = { width: 640, height: 480 }; },
    'backend replacement': f => { f.renderer.device = {}; },
    'target rebuild': f => { f.renderer.sceneTarget = {}; },
    'display mode': f => { f.renderer.hdrMode = 'bright'; },
    'display backend variant': f => { f.renderer._display = {}; },
    'batch draw boundary': f => f.batch.count++,
    'batch blend': f => { f.batch.blend = 'add'; },
    'batch depth': f => { f.batch.writesDepth = false; },
    'atlas revision': f => f.renderer._albedoPage.uploads++,
    'bind group': f => { f.renderer._frameBindKey = 'other'; },
};
for (const [name, poison] of Object.entries(poisons)) {
    test(`presented output is invalidated by ${name} alone`, () => {
        const f = fixture();
        assert.equal(f.stage(), false);
        f.reuse.commit();
        assert.equal(f.stage(), true);
        poison(f);
        assert.equal(f.stage(), false);
        f.reuse.commit();
        assert.equal(f.stage(), true);
    });
}

test('exact byte equality retains output, including subviews and NaN payload bits', () => {
    const reuse = new GpuFrameReuse();
    const data = new Uint32Array([0x7fc00001, 0x80000000, 0]);
    const view = new Uint8Array(data.buffer, 0, 8);
    reuse.begin().bytes(view);
    reuse.commit();
    reuse.begin().bytes(view);
    assert.equal(reuse.unchanged(), true);
    data[0] = 0x7fc00002;
    reuse.begin().bytes(view);
    assert.equal(reuse.unchanged(), false, 'different NaN bits are not equal staged bytes');
    data[0] = 0x7fc00001;
    data[1] = 0;
    reuse.begin().bytes(view);
    assert.equal(reuse.unchanged(), false, 'signed zero bytes are distinct');
});

test('unpresented staging never becomes the baseline and late output invalidates it', () => {
    const f = fixture();
    f.stage();
    f.reuse.commit();
    f.records[0]++;
    assert.equal(f.stage(), false);
    f.records[0]--;
    assert.equal(f.stage(), true, 'failed or abandoned candidate retains last presented baseline');
    f.reuse.invalidate();
    assert.equal(f.stage(), false);
});

test('removing a buffer or scalar from a frame invalidates the presented baseline', () => {
    const reuse = new GpuFrameReuse();
    reuse.begin();
    reuse.bytes(new Uint8Array([1]));
    reuse.scalar(1);
    reuse.commit();
    reuse.begin();
    assert.equal(reuse.unchanged(), false);
});

test('word-wise byte comparison detects single-byte changes across aligned words, tails, and unaligned subviews', () => {
    for (const length of [16, 17, 18, 19, 20, 63, 64, 67]) {
        const reuse = new GpuFrameReuse();
        const backing = new Uint8Array(length + 4);
        for (let i = 0; i < backing.length; i++) backing[i] = (i * 37 + 11) & 255;
        for (const offset of [0, 1, 2, 3]) {
            reuse.reset();
            const subview = new Uint8Array(backing.buffer, offset, length);
            reuse.begin().bytes(subview);
            reuse.commit();
            reuse.begin().bytes(subview);
            assert.equal(reuse.unchanged(), true, `len=${length} off=${offset} unchanged`);
            // Flip first, middle, and final byte individually.
            for (const pos of new Set([0, length >> 1, length - 1])) {
                subview[pos] ^= 1;
                reuse.begin().bytes(subview);
                assert.equal(reuse.unchanged(), false, `len=${length} off=${offset} pos=${pos} must differ`);
                subview[pos] ^= 1;
                reuse.begin().bytes(subview);
                assert.equal(reuse.unchanged(), true, `len=${length} off=${offset} pos=${pos} restored`);
            }
        }
    }
});

test('GpuFrameReuse.reset() and shrinking scalar counts drop stale baselines and references', () => {
    const reuse = new GpuFrameReuse();
    const token = { handle: 'old' };
    const buf = new Uint8Array([1, 2, 3, 4]);
    reuse.begin();
    reuse.bytes(buf);
    reuse.scalar(token);
    reuse.scalar(42);
    reuse.commit();
    assert.equal(reuse._presentedScalars.length, 2);

    // Shrink to 1 scalar and commit: old trailing scalar reference is released.
    reuse.begin();
    reuse.bytes(buf);
    reuse.scalar(99);
    assert.equal(reuse.unchanged(), false);
    reuse.commit();
    assert.equal(reuse._presentedScalars.length, 1);
    assert.equal(reuse._currentScalars.length, 1);
    assert.equal(reuse._presentedScalars.includes(token), false);

    // reset() clears saved buffers and invalidates baseline.
    reuse.reset();
    assert.equal(reuse._bytes.length, 0);
    assert.equal(reuse._presentedScalars.length, 0);
    reuse.begin();
    reuse.bytes(buf);
    reuse.scalar(99);
    assert.equal(reuse.unchanged(), false);
});
