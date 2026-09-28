// B.1b — the albedo page: one TEXTURE_2D_ARRAY whose layers hold the
// sources of sidecar-less records (tree lean frames, tree and building ground
// casts, agent ground stamps, static prop caches, the agent frame atlas while
// it has no channel atlas), so their records batch by page instead of
// breaking on every texture. A record keeps its V9 layout; only loc3.x
// carries its layer (`pageLayer`), and its uv rect addresses its slot in that
// layer (`pageX`/`pageY`). Records with sidecars keep their own 2D textures
// and break on texture as before (docs/material-channel-contract.md, sampler
// table: unit 14).
//
// Slots are shelf-packed once and never moved while the page lives. A frame
// whose sources do not fit repacks: the page is reallocated (zeroed) at the
// layer count its live set needs, every slot is dropped, and the frame is
// batched again, re-uploading only what that frame draws. Stale slots (an
// agent stamp nobody stands on, a lean frame out of view) are reclaimed only
// by a repack; a repack cooldown keeps an over-full page from thrashing (its
// overflow simply stays on 2D textures until the next repack).

export const ALBEDO_PAGE_SIZE = 1024;
// Transparent texels right of and below every slot. Sampling never leaves a
// record's own rect (the V9 uv clamp); the gutter keeps a missed clamp from
// ever reading a neighbour's pixels.
export const ALBEDO_PAGE_GUTTER = 2;
export const ALBEDO_PAGE_MAX_LAYERS = 6;
export const ALBEDO_PAGE_UNIT_KEY = 'albedo-page';
// A repack sizes the page so its live set fills at most this share of it.
const REPACK_FILL = 0.6;
const REPACK_COOLDOWN_FRAMES = 90;
// Shelves are snapped to 4 texels and accept items up to a quarter shorter.
const SHELF_SNAP = 4;

/**
 * Shelf packer over `layers` square layers of `size` texels. `place(w, h)`
 * returns `{ layer, x, y }` or null when no layer has room; slots include
 * the gutter on their right and bottom edges.
 */
export class ShelfPacker {
    constructor(size, layers, gutter = ALBEDO_PAGE_GUTTER) {
        this.size = size;
        this.gutter = gutter;
        this.usedArea = 0;
        this.layers = [];
        for (let index = 0; index < layers; index++) this.layers.push({ shelves: [], top: 0 });
    }

    place(width, height) {
        const w = width + this.gutter;
        const h = height + this.gutter;
        if (w > this.size || h > this.size) return null;
        const shelfHeight = Math.ceil(h / SHELF_SNAP) * SHELF_SNAP;
        const tallest = shelfHeight + Math.max(SHELF_SNAP, Math.floor(shelfHeight / 4));
        // A tight shelf (up to a quarter taller) or a new one, layer by
        // layer; failing that, the shortest taller shelf with room anywhere.
        for (let index = 0; index < this.layers.length; index++) {
            const layer = this.layers[index];
            const shelf = this._shelfIn(layer, w, shelfHeight, tallest);
            if (shelf) return this._take(index, shelf, w, width, height);
            if (layer.top + shelfHeight <= this.size) {
                const opened = { y: layer.top, height: shelfHeight, x: 0 };
                layer.shelves.push(opened);
                layer.top += shelfHeight;
                return this._take(index, opened, w, width, height);
            }
        }
        for (let index = 0; index < this.layers.length; index++) {
            const shelf = this._shelfIn(this.layers[index], w, shelfHeight, Infinity);
            if (shelf) return this._take(index, shelf, w, width, height);
        }
        return null;
    }

    _shelfIn(layer, w, shortest, tallest) {
        let best = null;
        for (const shelf of layer.shelves) {
            if (shelf.height < shortest || shelf.height > tallest || shelf.x + w > this.size) continue;
            if (!best || shelf.height < best.height) best = shelf;
        }
        return best;
    }

    _take(layer, shelf, w, width, height) {
        const slot = { layer, x: shelf.x, y: shelf.y };
        shelf.x += w;
        this.usedArea += width * height;
        return slot;
    }
}

function validPatch(update, width, height) {
    const updateWidth = Math.floor(update?.width || update?.source?.width || 0);
    const updateHeight = Math.floor(update?.height || update?.source?.height || 0);
    const updateX = Math.floor(update?.x || 0);
    const updateY = Math.floor(update?.y || 0);
    const subRect = update?.sx != null;
    const sx = Math.floor(update?.sx || 0);
    const sy = Math.floor(update?.sy || 0);
    return Boolean(
        update?.source
        && updateWidth > 0
        && updateHeight > 0
        && (subRect
            ? sx >= 0 && sy >= 0
                && sx + updateWidth <= update.source.width
                && sy + updateHeight <= update.source.height
            : update.source.width === updateWidth && update.source.height === updateHeight)
        && updateX >= 0
        && updateY >= 0
        && updateX + updateWidth <= width
        && updateY + updateHeight <= height,
    );
}

export class GpuAlbedoPage {
    constructor(gl, unit) {
        this.gl = gl;
        this.unit = unit;
        this.key = ALBEDO_PAGE_UNIT_KEY;
        this.texture = null;
        this.layers = 0;
        this.packer = null;
        this.entries = new Map();
        this._pending = [];
        this.frame = -1;
        this.lastRepackFrame = -Infinity;
        this.repacks = 0;
        this._layerFloor = 1;
        this._scratch = null;
        this._readFramebuffer = null;
        // Per frame: records placed, records left on 2D textures because the
        // page was full, and the area (texels) of the distinct sources drawn.
        this.pagedRecords = 0;
        this.overflowRecords = 0;
        this.liveArea = 0;
        this.overflowArea = 0;
        this.liveEntries = 0;
        this.uploads = 0;
        this.uploadBytes = 0;
    }

    get bytes() {
        return ALBEDO_PAGE_SIZE * ALBEDO_PAGE_SIZE * 4 * this.layers;
    }

    beginFrame(frame) {
        this.frame = frame;
        this.pagedRecords = 0;
        this.overflowRecords = 0;
        this.liveArea = 0;
        this.overflowArea = 0;
        this.liveEntries = 0;
        this._overflowKeys = null;
    }

    /**
     * Places a pageable record's source on the page (allocating its slot on
     * first use, queueing its upload when the source or revision moved) and
     * writes `pageLayer`/`pageX`/`pageY` onto the record. Returns the page, or
     * null when the page has no room this frame.
     */
    place(record) {
        const key = record.textureKey;
        const width = record.sourceWidth;
        const height = record.sourceHeight;
        let entry = this.entries.get(key);
        if (entry && (entry.width !== width || entry.height !== height)) {
            this.entries.delete(key);
            entry = null;
        }
        if (!entry) {
            const slot = this.packer ? this.packer.place(width, height) : null;
            if (!slot) {
                this.overflowRecords++;
                const keys = this._overflowKeys || (this._overflowKeys = new Set());
                if (!keys.has(key)) {
                    keys.add(key);
                    this.overflowArea += width * height;
                }
                return null;
            }
            entry = {
                layer: slot.layer, x: slot.x, y: slot.y, width, height,
                source: null, revision: undefined, lastUsedFrame: -1, pending: false,
            };
            this.entries.set(key, entry);
        }
        // A patch list holds only this revision's changes, so it applies only
        // to a slot that saw every earlier revision: one used last frame (or
        // already this frame). A source back from frames on its 2D texture
        // uploads whole.
        const continuous = entry.lastUsedFrame === this.frame || entry.lastUsedFrame === this.frame - 1;
        if (entry.lastUsedFrame !== this.frame) {
            entry.lastUsedFrame = this.frame;
            this.liveArea += width * height;
            this.liveEntries++;
        }
        const source = record.source;
        const revision = record.textureRevision ?? null;
        if (entry.source !== source || entry.revision !== revision) {
            // Same rules as the 2D cache: a new source uploads whole; a new
            // revision of the same source takes its sub-rect updates.
            const whole = entry.source !== source || !continuous;
            entry.source = source;
            entry.revision = revision;
            const updates = !whole && Array.isArray(record.textureUpdates) && record.textureUpdates.length > 0
                && record.textureUpdates.every((update) => validPatch(update, width, height))
                ? record.textureUpdates
                : null;
            if (entry.pending) entry.updates = null;
            else {
                entry.pending = true;
                entry.updates = updates;
                this._pending.push(entry);
            }
        }
        record.pageLayer = entry.layer;
        record.pageX = entry.x;
        record.pageY = entry.y;
        this.pagedRecords++;
        return this;
    }

    /**
     * After a batching pass: true when records overflowed and a repack can
     * help (the page is absent, too small for the live set, or holds stale
     * slots), in which case the page is reallocated empty and the caller
     * batches the frame again.
     */
    repackIfOverflowed() {
        if (!this.overflowRecords) return false;
        if (this.texture && this.frame - this.lastRepackFrame < REPACK_COOLDOWN_FRAMES) return false;
        const capacity = ALBEDO_PAGE_SIZE * ALBEDO_PAGE_SIZE;
        const wanted = this.liveArea + this.overflowArea;
        const estimate = Math.ceil(wanted / (capacity * REPACK_FILL));
        const layers = Math.max(1, this._layerFloor, Math.min(ALBEDO_PAGE_MAX_LAYERS, estimate));
        const stale = (this.packer?.usedArea || 0) - this.liveArea;
        if (this.texture && layers <= this.layers && stale <= 0) return false;
        this._allocate(layers);
        this.lastRepackFrame = this.frame;
        this.repacks++;
        this.beginFrame(this.frame);
        return true;
    }

    /**
     * After the pass that follows a repack: records that still overflow mean
     * the shelves fragment the live set past its area estimate, so every
     * later repack takes at least one more layer (never past the maximum).
     */
    endRepackPass() {
        if (this.overflowRecords) this._layerFloor = Math.min(ALBEDO_PAGE_MAX_LAYERS, this.layers + 1);
    }

    _allocate(layers) {
        const gl = this.gl;
        if (this.texture) gl.deleteTexture(this.texture);
        this.entries.clear();
        this._pending.length = 0;
        this.texture = gl.createTexture();
        gl.activeTexture(gl.TEXTURE0 + this.unit);
        gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.texture);
        gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        // WebGL zero-fills a null-data allocation: every gutter is transparent.
        gl.texImage3D(gl.TEXTURE_2D_ARRAY, 0, gl.RGBA8, ALBEDO_PAGE_SIZE, ALBEDO_PAGE_SIZE, layers, 0,
            gl.RGBA, gl.UNSIGNED_BYTE, null);
        this.layers = layers;
        this.packer = new ShelfPacker(ALBEDO_PAGE_SIZE, layers);
    }

    /**
     * Uploads every slot queued this frame; returns the bytes uploaded. Each
     * source (or patch) goes through a scratch 2D texture with exactly the
     * calls the 2D texture cache makes (texImage2D whole, texSubImage2D per
     * patch), then a GPU copy lands those texels in the slot. A direct
     * texSubImage3D from a canvas takes another un-premultiply path in
     * Chromium (±1 on some translucent texels), which would break the paged
     * frame's parity with the 2D path. The page stays bound on its unit.
     */
    flushUploads() {
        const pending = this._pending;
        if (!pending.length) return 0;
        const gl = this.gl;
        const readBinding = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING);
        if (!this._scratch) {
            this._scratch = gl.createTexture();
            this._readFramebuffer = gl.createFramebuffer();
        }
        gl.activeTexture(gl.TEXTURE0 + this.unit);
        gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.texture);
        gl.bindTexture(gl.TEXTURE_2D, this._scratch);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this._readFramebuffer);
        const copy = (x, y, layer, width, height) => {
            gl.framebufferTexture2D(gl.READ_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this._scratch, 0);
            gl.copyTexSubImage3D(gl.TEXTURE_2D_ARRAY, 0, x, y, layer, 0, 0, width, height);
        };
        let bytes = 0;
        for (let index = 0; index < pending.length; index++) {
            const entry = pending[index];
            entry.pending = false;
            if (!entry.source) continue;
            if (entry.updates) {
                for (const update of entry.updates) {
                    const width = Math.floor(update.width || update.source.width);
                    const height = Math.floor(update.height || update.source.height);
                    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
                    if (update.sx != null) {
                        gl.pixelStorei(gl.UNPACK_ROW_LENGTH, update.source.width);
                        gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, Math.floor(update.sx));
                        gl.pixelStorei(gl.UNPACK_SKIP_ROWS, Math.floor(update.sy || 0));
                        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, update.source);
                        gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
                        gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0);
                        gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 0);
                    } else {
                        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, update.source);
                    }
                    copy(entry.x + Math.floor(update.x || 0), entry.y + Math.floor(update.y || 0), entry.layer, width, height);
                    bytes += width * height * 4;
                }
            } else {
                gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, entry.source);
                copy(entry.x, entry.y, entry.layer, entry.width, entry.height);
                bytes += entry.width * entry.height * 4;
            }
            entry.updates = null;
            this.uploads++;
        }
        pending.length = 0;
        // The scratch keeps no storage between flushes.
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        gl.bindTexture(gl.TEXTURE_2D, null);
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, readBinding);
        this.uploadBytes += bytes;
        return bytes;
    }

    // The page's slots are never sampled outside a record rect; drop them
    // with the GL objects on suspend, dispose or context loss.
    release() {
        const gl = this.gl;
        if (this.texture) gl.deleteTexture(this.texture);
        if (this._scratch) gl.deleteTexture(this._scratch);
        if (this._readFramebuffer) gl.deleteFramebuffer(this._readFramebuffer);
        this.abandon();
    }

    abandon() {
        this.texture = null;
        this._scratch = null;
        this._readFramebuffer = null;
        this.layers = 0;
        this.packer = null;
        this.entries.clear();
        this._pending.length = 0;
        this.lastRepackFrame = -Infinity;
        this._layerFloor = 1;
    }

    getDiagnostics() {
        return {
            layers: this.layers,
            bytes: this.bytes,
            entries: this.entries.size,
            liveEntries: this.liveEntries,
            pagedRecords: this.pagedRecords,
            overflowRecords: this.overflowRecords,
            fill: this.layers ? Number((this.liveArea / (ALBEDO_PAGE_SIZE * ALBEDO_PAGE_SIZE * this.layers)).toFixed(3)) : 0,
            repacks: this.repacks,
            uploads: this.uploads,
            uploadBytes: this.uploadBytes,
        };
    }
}
