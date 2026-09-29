import test from 'node:test';
import assert from 'node:assert/strict';

import {
    assertRecordStride,
    createRecordStaging,
    RECORD_INSTANCE_BYTES,
    RECORD_TAIL_RECEIVER,
    RECORD_TAIL_RESPONSE,
    stageGpuRecords,
} from '../../claudeville/src/presentation/character-mode/gpu/GpuRecordLayout.js';
import { GROUND_CUE_TEXTURE_KEY } from '../../claudeville/src/presentation/character-mode/GroundCueRecords.js';

const record = (i, extra = {}) => ({
    x: 10 * i + 0.25, y: 7 * i, width: 32, height: 24, sx: i, sy: 2 * i, sw: 16, sh: 12, sourceWidth: 256, sourceHeight: 128,
    alpha: 0.75, material: 3, elevation: 1.5, emissive: 0.2, ...extra,
});

function frameBatches() {
    return [
        { records: [record(1), record(2)], textureKey: 'terrain' },
        {
            records: [record(3, {
                flags: 5, depthKey: 900, footY: 40, frontCornerX: -3, frontCornerY: 12,
                ownerSlot: 2, landmarkId: 9, emissiveGate: 0.4, paletteRamp: true,
            })],
            textureKey: 'agents',
        },
        { records: [record(4, { pageLayer: 2, pageX: 64, pageY: 128 })], textureKey: 'paged' },
        { records: [record(5, { flags: 1 }), record(6)], textureKey: GROUND_CUE_TEXTURE_KEY },
    ];
}

function recordHex(staging, offset, bytes) {
    return Buffer.from(staging.f32.buffer, offset, bytes).toString('hex');
}

// The bytes the pre-extraction WebGL2 staging (6559335) wrote for these
// batches: head-only terrain, a full identity/receiver tail, a paged slot, and
// a cue batch whose dot run makes it a cue-run batch.
const STAGED = [
    '000024410000e040000000420000c0410000803b0000803c0000883d0000e03d0000403f000040400000c03fcdcc4c3e',
    '0000a24100006041000000420000c0410000003c0000003d0000903d0000003e0000403f000040400000c03fcdcc4c3e',
    '0000f2410000a841000000420000c0410000403c0000403d0000983d0000103e0000403f000040400000c03fcdcc4c3e000066660100050084032880fd7f0c8002000900',
    '000021420000e041000000420000c0410000883d0000083e0000a83d0000143e0000403f000040400000c03fcdcc4c3e0200ffff000000000000ff7f0080ff7f00000000',
    '0000494200000c42000000420000c0410000a03c0000a03d0000a83d0000303e0000403f000040400000c03fcdcc4c3e0000ffff000001000000ff7f0080ff7f00000000',
    '0000714200002842000000420000c0410000c03c0000c03d0000b03d0000403e0000403f000040400000c03fcdcc4c3e0000ffff000000000000ff7f0080ff7f00000000',
];

test('record staging reproduces the V9 68-byte layout and the head-only default batches byte for byte', () => {
    const batches = frameBatches();
    const staging = createRecordStaging();
    const byteLength = stageGpuRecords(batches, staging);
    assert.deepEqual(batches.map(b => [b.tail, b.cueRuns, b.instanceOffset, b.count]), [
        [false, false, 0, 2],
        [true, false, 96, 1],
        [true, false, 164, 1],
        [true, true, 232, 2],
    ]);
    assert.equal(byteLength, 368);
    const staged = [];
    for (const batch of batches) {
        const stride = batch.tail ? 68 : 48;
        for (let i = 0; i < batch.count; i++) staged.push(recordHex(staging, batch.instanceOffset + i * stride, stride));
    }
    assert.deepEqual(staged, STAGED);
});

test('a full-tail staging writes the default tail WebGL2 feeds as constant attributes, and keeps plain cue batches plain', () => {
    const staging = createRecordStaging();
    const batches = [
        { records: [record(1)], textureKey: 'terrain' },
        { records: [record(2)], textureKey: GROUND_CUE_TEXTURE_KEY },
    ];
    const byteLength = stageGpuRecords(batches, staging, { fullTail: true });
    assert.equal(byteLength, 2 * RECORD_INSTANCE_BYTES);
    assert.deepEqual(batches.map(b => [b.tail, b.cueRuns, b.instanceOffset]), [[true, false, 0], [true, false, 68]]);
    for (const batch of batches) {
        const tail = Array.from(new Uint16Array(staging.f32.buffer, batch.instanceOffset + 48, 10));
        assert.deepEqual(tail, [...RECORD_TAIL_RESPONSE, ...RECORD_TAIL_RECEIVER, 0, 0]);
    }
});

test('the record stride assertion accepts only the 68-byte scalar-lane stride', () => {
    assert.equal(assertRecordStride(68), true);
    assert.throws(() => assertRecordStride(80), /stride 80/);
});
