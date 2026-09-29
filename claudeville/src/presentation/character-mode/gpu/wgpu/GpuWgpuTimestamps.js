// Wave 10 (contract §4.3) — `timestamp-query` spans for the 0.1 ladder. A timed
// frame takes one slot of a small ring: every pass it encodes carries a
// begin/end timestamp pair, the slot is resolved into its own 256-byte region
// and copied to its own mappable buffer, and the result is read on a later
// frame (`mapAsync` never blocks the loop). The whole-frame span (first begin
// to last end) is the ladder's sample; per-pass spans are diagnostics only
// (V2: isolated per-pass timestamps are not evidence on ANGLE-Metal).
export const WGPU_TIMED_PASSES = Object.freeze(['scene', 'bloom', 'present']);
const QUERIES_PER_SLOT = WGPU_TIMED_PASSES.length * 2;
const RESOLVE_STRIDE = 256;

export class GpuWgpuTimer {
    constructor(device, { slots = 6 } = {}) {
        this.device = device;
        this.slots = slots;
        this.querySet = device.createQuerySet({ type: 'timestamp', count: slots * QUERIES_PER_SLOT, label: 'world-timestamps' });
        this.resolveBuffer = device.createBuffer({
            size: slots * RESOLVE_STRIDE,
            usage: globalThis.GPUBufferUsage.QUERY_RESOLVE | globalThis.GPUBufferUsage.COPY_SRC,
            label: 'world-timestamp-resolve',
        });
        this.readback = Array.from({ length: slots }, (_, index) => device.createBuffer({
            size: QUERIES_PER_SLOT * 8,
            usage: globalThis.GPUBufferUsage.MAP_READ | globalThis.GPUBufferUsage.COPY_DST,
            label: `world-timestamp-read-${index}`,
        }));
        this.state = new Array(slots).fill(null);
        this.next = 0;
        this.errors = 0;
        this.dropped = 0;
    }

    /** A free slot for this frame (`metadata` rides to the result), or -1. */
    begin(metadata = {}) {
        for (let tries = 0; tries < this.slots; tries++) {
            const slot = (this.next + tries) % this.slots;
            if (this.state[slot]) continue;
            this.next = (slot + 1) % this.slots;
            this.state[slot] = { metadata, passes: [], phase: 'encoding' };
            return slot;
        }
        this.dropped++;
        return -1;
    }

    /** `timestampWrites` for `pass` in `slot` (undefined when untimed). */
    writes(slot, pass) {
        if (slot < 0) return undefined;
        const index = WGPU_TIMED_PASSES.indexOf(pass);
        this.state[slot].passes.push(index);
        const base = slot * QUERIES_PER_SLOT + index * 2;
        return { querySet: this.querySet, beginningOfPassWriteIndex: base, endOfPassWriteIndex: base + 1 };
    }

    resolve(encoder, slot) {
        if (slot < 0) return;
        encoder.resolveQuerySet(this.querySet, slot * QUERIES_PER_SLOT, QUERIES_PER_SLOT, this.resolveBuffer, slot * RESOLVE_STRIDE);
        encoder.copyBufferToBuffer(this.resolveBuffer, slot * RESOLVE_STRIDE, this.readback[slot], 0, QUERIES_PER_SLOT * 8);
    }

    /**
     * After the frame's submit: maps the slot and calls `onResult({ frameMs,
     * passes: { scene, bloom, present }, metadata })` when the GPU is done.
     */
    collect(slot, onResult) {
        if (slot < 0) return;
        const state = this.state[slot];
        state.phase = 'mapping';
        const buffer = this.readback[slot];
        buffer.mapAsync(globalThis.GPUMapMode.READ).then(() => {
            const times = new BigUint64Array(buffer.getMappedRange().slice(0));
            buffer.unmap();
            let first = null;
            let last = null;
            const passes = {};
            for (const index of state.passes) {
                const begin = times[index * 2];
                const end = times[index * 2 + 1];
                if (end < begin) continue;
                passes[WGPU_TIMED_PASSES[index]] = Number(end - begin) / 1e6;
                if (first === null || begin < first) first = begin;
                if (last === null || end > last) last = end;
            }
            this.state[slot] = null;
            if (first === null) return;
            onResult({ frameMs: Number(last - first) / 1e6, passes, metadata: state.metadata });
        }, () => {
            // A lost device rejects every pending map; the slot dies with it.
            this.errors++;
            this.state[slot] = null;
        });
    }

    get pending() {
        return this.state.filter(Boolean).length;
    }

    destroy() {
        this.querySet?.destroy?.();
        this.resolveBuffer?.destroy?.();
        for (const buffer of this.readback) buffer?.destroy?.();
    }
}
