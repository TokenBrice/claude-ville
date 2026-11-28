// Compare staged GPU bytes, not a derived scene signature. Only a successful
// presentation commits the baseline; failed staging/rendering cannot poison it.
export class GpuFrameReuse {
    constructor() {
        this._presentedScalars = [];
        this._currentScalars = [];
        this._bytes = [];
        this._valid = false;
        this._scalarCount = 0;
        this._byteCount = 0;
        this._presentedScalarCount = 0;
        this._presentedByteCount = 0;
        this.same = false;
    }

    begin() {
        this._scalarCount = 0;
        this._byteCount = 0;
        this.same = this._valid;
        return this;
    }

    scalar(value) {
        const index = this._scalarCount++;
        if (this.same && !Object.is(this._presentedScalars[index], value)) this.same = false;
        this._currentScalars[index] = value;
    }

    bytes(source, length = source.byteLength, offset = 0) {
        const index = this._byteCount++;
        const slot = this._bytes[index] || (this._bytes[index] = {
            saved: new Uint8Array(0),
            saved32: null,
            length: -1,
            buffer: null,
            offset: -1,
            view: null,
            view32: null,
        });
        const buffer = source.buffer || source;
        const start = (source.byteOffset || 0) + offset;
        if (slot.buffer !== buffer || slot.offset !== start || slot.view?.byteLength !== length) {
            slot.buffer = buffer;
            slot.offset = start;
            slot.view = new Uint8Array(buffer, start, length);
            slot.view32 = (start & 3) === 0 && length >= 16 ? new Uint32Array(buffer, start, length >> 2) : null;
        }
        if (slot.length !== length) this.same = false;
        else if (this.same) {
            const view = slot.view;
            const saved = slot.saved;
            let byte = 0;
            if (slot.view32 && slot.saved32) {
                const view32 = slot.view32;
                const saved32 = slot.saved32;
                const words = view32.length;
                for (let word = 0; word < words; word++) {
                    if (saved32[word] !== view32[word]) {
                        this.same = false;
                        return;
                    }
                }
                byte = words << 2;
            }
            for (; byte < length; byte++) {
                if (saved[byte] !== view[byte]) {
                    this.same = false;
                    break;
                }
            }
        }
    }

    unchanged() {
        return this.same
            && this._scalarCount === this._presentedScalarCount
            && this._byteCount === this._presentedByteCount;
    }

    commit() {
        if (this.unchanged()) return;
        const scalarCount = this._scalarCount;
        const presented = this._presentedScalars;
        const current = this._currentScalars;
        for (let index = 0; index < scalarCount; index++) {
            presented[index] = current[index];
        }
        presented.length = scalarCount;
        current.length = scalarCount;
        for (let index = 0; index < this._byteCount; index++) {
            const slot = this._bytes[index];
            const length = slot.view.byteLength;
            if (slot.saved.byteLength < length) {
                const capacity = Math.max(4, 2 ** Math.ceil(Math.log2(Math.max(4, length))));
                slot.saved = new Uint8Array(capacity);
                slot.saved32 = new Uint32Array(slot.saved.buffer);
            }
            slot.saved.set(slot.view);
            slot.length = length;
        }
        this._presentedScalarCount = scalarCount;
        this._presentedByteCount = this._byteCount;
        this._valid = true;
    }

    invalidate() {
        this._valid = false;
    }

    reset() {
        this._valid = false;
        this._presentedScalars.length = 0;
        this._currentScalars.length = 0;
        this._bytes.length = 0;
        this._scalarCount = 0;
        this._byteCount = 0;
        this._presentedScalarCount = 0;
        this._presentedByteCount = 0;
        this.same = false;
    }
}

// Binding identities and revisions supplement the staged bytes. Cache entries
// may be replaced without changing their key/revision (device rebuild, eviction,
// or a new source), and batch boundaries select draw state outside the records.
export function stageGpuFrameBindings(reuse, renderer, batches, marks) {
    reuse.scalar(renderer.device || renderer.gl);
    reuse.scalar(renderer.canvas);
    reuse.scalar(renderer.width);
    reuse.scalar(renderer.height);
    reuse.scalar(renderer.canvas?.width);
    reuse.scalar(renderer.canvas?.height);
    reuse.scalar(renderer.sceneTarget);
    reuse.scalar(renderer.sceneTarget?.emission?.texture);
    reuse.scalar(renderer.bloomA);
    reuse.scalar(renderer.bloomB);
    reuse.scalar(renderer._canvasGeneration);
    reuse.scalar(renderer._display);
    reuse.scalar(renderer._p3);
    reuse.scalar(renderer.hdrMode);
    reuse.scalar(renderer.canvasFormat);
    reuse.scalar(renderer.canvasColorSpace);
    reuse.scalar(renderer.canvasToneMapping);
    reuse.scalar(renderer.gl?.drawingBufferColorSpace);
    reuse.scalar(renderer._frameBindKey);
    reuse.scalar(renderer._albedoPage?.texture);
    reuse.scalar(renderer._albedoPage?.uploads);
    reuse.scalar(renderer.uploads);
    reuse.scalar(renderer._lightRecordsRevision);
    reuse.scalar(renderer._textureEntries.size);
    for (const [key, entry] of renderer._textureEntries) {
        reuse.scalar(key);
        reuse.scalar(entry.texture);
        reuse.scalar(entry.source);
        reuse.scalar(entry.revision);
        reuse.scalar(entry.width);
        reuse.scalar(entry.height);
    }
    stageBatches(reuse, batches);
    stageBatches(reuse, marks);
}

function stageBatches(reuse, batches) {
    const length = batches.length;
    reuse.scalar(length);
    for (let index = 0; index < length; index++) {
        const batch = batches[index];
        reuse.scalar(batch.count);
        reuse.scalar(batch.instanceOffset);
        reuse.scalar(batch.tail);
        reuse.scalar(batch.blend);
        reuse.scalar(batch.writesDepth);
        reuse.scalar(batch.cueRuns);
        reuse.scalar(batch.records?.[0]?.id === 'terrain:static');
        reuse.scalar(batch.albedoTexture);
        reuse.scalar(batch.materialTexture);
        reuse.scalar(batch.emissiveTexture);
        reuse.scalar(batch.occluderTexture);
    }
}
