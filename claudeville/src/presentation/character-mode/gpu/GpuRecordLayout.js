// V9 / B.1a — the GPU record instance layout both world backends stage from
// (docs/material-channel-contract.md). One instance per record, drawn as a
// 4-vertex strip:
//   loc0 FLOAT  x4  rect (x, y, w, h), world px                  bytes  0-15
//   loc1 FLOAT  x4  uv rect (u0, v0, u1, v1); a paged record's rect is its
//                   slot in its albedo-page layer                       16-31
//   loc2 FLOAT  x4  (alpha, material, elevation, emissive)              32-47
//   loc3 USHORT x4  (page layer, gate x 65535), ramp, flags             48-55
//   loc4 USHORT x4  depth key, footY, frontCornerX, frontCornerY        56-63
//                   (receiver coordinates integer world px + 32768)
//   loc5 USHORT x2  (ownerSlot, landmarkId)                             64-67
// Continuous surface values stay float32; the integer fields pack as
// uint16, little-endian (a WGSL reader takes each u32 lane's low half). A
// batch whose records all carry the default tail (loc3-loc5: layer 0, gate
// 1, no ramp or flags, far-plane depth, ground-self receiver, no identity) —
// terrain, ground casts and marks, every ground-cue chord — stages only the
// 48-byte head; WebGL2 then reads the tail as constant generic attributes.
import { ALBEDO_PAGE_SIZE } from './GpuAlbedoPage.js';
import { growTypedArray } from '../AssetManager.js';
import { GROUND_CUE_TEXTURE_KEY } from '../GroundCueRecords.js';

export const RECEIVER_BIAS = 32768;
// Every field, in staging order: byte offset, component type and count.
export const RECORD_LAYOUT = Object.freeze([
    Object.freeze({ name: 'loc0', offset: 0, type: 'float32', count: 4 }),
    Object.freeze({ name: 'loc1', offset: 16, type: 'float32', count: 4 }),
    Object.freeze({ name: 'loc2', offset: 32, type: 'float32', count: 4 }),
    Object.freeze({ name: 'loc3', offset: 48, type: 'uint16', count: 4 }),
    Object.freeze({ name: 'loc4', offset: 56, type: 'uint16', count: 4 }),
    Object.freeze({ name: 'loc5', offset: 64, type: 'uint16', count: 2 }),
]);
export const RECORD_OFFSETS = Object.freeze(Object.fromEntries(RECORD_LAYOUT.map(field => [field.name, field.offset])));
export const RECORD_HEAD_BYTES = 48;
export const RECORD_INSTANCE_BYTES = 68;
// The default tail as WebGL2 constant generic attributes (loc3, loc4).
export const RECORD_TAIL_RESPONSE = Object.freeze([0, 65535, 0, 0]);
export const RECORD_TAIL_RECEIVER = Object.freeze([0, RECEIVER_BIAS - 1, RECEIVER_BIAS, RECEIVER_BIAS - 1]);

const COMPONENT_BYTES = Object.freeze({ float32: 4, uint16: 2 });

// Build-time layout assertion: the fields tile the record with no gap or
// overlap, the head ends where loc3 starts, and the record is exactly
// `stride` bytes. The layout table checks itself at module load; a backend
// passes the stride its shader layout reports (a WebGPU storage struct of
// scalar lanes must report 68, never the 80 of vec4 lanes).
export function assertRecordStride(stride = RECORD_INSTANCE_BYTES) {
    let end = 0;
    for (const field of RECORD_LAYOUT) {
        if (field.offset !== end) throw new Error(`V9 record field ${field.name} at byte ${field.offset}, expected ${end}`);
        end += field.count * COMPONENT_BYTES[field.type];
    }
    if (RECORD_OFFSETS.loc3 !== RECORD_HEAD_BYTES) throw new Error(`V9 record head ends at ${RECORD_OFFSETS.loc3}, expected ${RECORD_HEAD_BYTES}`);
    if (end !== RECORD_INSTANCE_BYTES || stride !== RECORD_INSTANCE_BYTES) {
        throw new Error(`V9 record stride ${stride} (layout ${end}), expected ${RECORD_INSTANCE_BYTES}`);
    }
    return true;
}
assertRecordStride();

function unitToUint16(value) {
    const number = Number(value);
    if (!(number > 0)) return 0;
    return number >= 1 ? 65535 : Math.round(number * 65535);
}

function receiverToUint16(value) {
    const number = Math.round(Number(value)) + RECEIVER_BIAS;
    if (!(number > 0)) return 0;
    return number >= 65535 ? 65535 : number;
}

// True when a record's V9 tail (loc3-loc5) is all defaults, so its batch may
// stage the head alone.
export function recordHasDefaultTail(record) {
    return (record.emissiveGate ?? 1) >= 1
        && !record.paletteRamp
        && !record.flags
        && !record.depthKey
        && (record.footY ?? -1) === -1
        && !record.frontCornerX
        && (record.frontCornerY ?? -1) === -1
        && !record.ownerSlot
        && !record.landmarkId
        && !(record.pageLayer > 0);
}

// One V9 instance at `byteOffset`; `tail` false stages the 48-byte head only.
// The float and uint16 views share one ArrayBuffer.
export function writeGpuRecordInstance(f32, u16, byteOffset, record, tail) {
    const f = byteOffset >> 2;
    // B.1b — a paged record addresses its slot in a page layer.
    const paged = record.pageLayer >= 0;
    const sourceWidth = paged ? ALBEDO_PAGE_SIZE : record.sourceWidth;
    const sourceHeight = paged ? ALBEDO_PAGE_SIZE : record.sourceHeight;
    const sx = paged ? record.pageX + record.sx : record.sx;
    const sy = paged ? record.pageY + record.sy : record.sy;
    f32[f] = record.x;
    f32[f + 1] = record.y;
    f32[f + 2] = record.width;
    f32[f + 3] = record.height;
    f32[f + 4] = sx / sourceWidth;
    f32[f + 5] = sy / sourceHeight;
    f32[f + 6] = (sx + record.sw) / sourceWidth;
    f32[f + 7] = (sy + record.sh) / sourceHeight;
    f32[f + 8] = record.alpha;
    f32[f + 9] = record.material;
    f32[f + 10] = record.elevation;
    f32[f + 11] = record.emissive;
    if (!tail) return;
    const h = (byteOffset >> 1) + RECORD_HEAD_BYTES / 2;
    // loc3.x — the record's albedo-page layer (0 when unpaged).
    u16[h] = paged ? record.pageLayer : 0;
    u16[h + 1] = unitToUint16(record.emissiveGate ?? 1);
    u16[h + 2] = record.paletteRamp ? 1 : 0;
    u16[h + 3] = record.flags || 0;
    u16[h + 4] = record.depthKey || 0;
    u16[h + 5] = receiverToUint16(record.footY ?? -1);
    u16[h + 6] = receiverToUint16(record.frontCornerX ?? 0);
    u16[h + 7] = receiverToUint16(record.frontCornerY ?? -1);
    u16[h + 8] = record.ownerSlot || 0;
    u16[h + 9] = record.landmarkId || 0;
}

// Staging views over one growable ArrayBuffer (`stageGpuRecords` fills it).
export function createRecordStaging() {
    const f32 = new Float32Array(64);
    return { f32, u16: new Uint16Array(f32.buffer) };
}

// Every batch of the frame into one staging buffer at its own byte offset:
// sets `batch.tail` (68-byte records, else the 48-byte head), `batch.cueRuns`
// (B.3: plain ground-cue records keep the default tail, so a cue batch with
// a tail holds dot runs), `batch.instanceOffset` and `batch.count`. Returns
// the staged byte length. `fullTail` stages every batch at 68 bytes (a
// backend with base-instance draws reads one stride for the whole frame).
export function stageGpuRecords(batches, staging, { fullTail = false } = {}) {
    let byteLength = 0;
    for (let index = 0; index < batches.length; index++) {
        const batch = batches[index];
        const records = batch.records;
        let tail = false;
        for (let recordIndex = 0; !tail && recordIndex < records.length; recordIndex++) {
            tail = !recordHasDefaultTail(records[recordIndex]);
        }
        batch.cueRuns = tail && batch.textureKey === GROUND_CUE_TEXTURE_KEY;
        batch.tail = tail || fullTail;
        batch.instanceOffset = byteLength;
        batch.count = records.length;
        byteLength += records.length * (batch.tail ? RECORD_INSTANCE_BYTES : RECORD_HEAD_BYTES);
    }
    const floats = byteLength / Float32Array.BYTES_PER_ELEMENT;
    const grown = growTypedArray(Float32Array, staging.f32, floats, 64);
    if (grown !== staging.f32) {
        staging.f32 = grown;
        staging.u16 = new Uint16Array(grown.buffer);
    }
    const f32 = staging.f32;
    const u16 = staging.u16;
    for (let index = 0; index < batches.length; index++) {
        const batch = batches[index];
        const records = batch.records;
        const stride = batch.tail ? RECORD_INSTANCE_BYTES : RECORD_HEAD_BYTES;
        for (let recordIndex = 0; recordIndex < records.length; recordIndex++) {
            writeGpuRecordInstance(f32, u16, batch.instanceOffset + recordIndex * stride, records[recordIndex], batch.tail);
        }
    }
    return byteLength;
}
