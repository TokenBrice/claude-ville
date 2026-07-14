// AssetManager loads sprites declared in manifest.yaml, decodes them into
// HTMLImageElements plus interaction-only alpha masks/outlines, and exposes lookup by id.

const PLACEHOLDER_PATH = 'assets/sprites/_placeholder/checker-64.png';
const OUTLINE_COLOR = '#f2d36b';
const ALPHA_THRESHOLD = 16;

export class AssetManager {
    constructor(manifestPath = 'assets/sprites/manifest.yaml') {
        this.manifestPath = manifestPath;
        this.manifest = null;          // parsed YAML root
        this.palettes = null;
        this.bitmaps = new Map();      // id → HTMLImageElement (or composed canvas)
        this.alphaMasks = new Map();   // interactive id → Uint8Array
        this.dimensions = new Map();   // id → { w, h }
        this.anchors = new Map();      // id → [cx, cy] in sprite-local px
        this.outlines = new Map();     // interactive id → HTMLCanvasElement (1-px gold edge)
        this._entriesCache = null;
        this._entryById = new Map();
        this.assetVersion = null;
        // IDs that resolved to the placeholder checker (404 or load error).
        // has(id) returns false for these so callers can skip drawing them.
        this.missing = new Set();
        // Per-asset miss records ({id, path}) collected across this load() pass;
        // flushed as one summary warn when load() resolves.
        this._loadMisses = [];
        this._disposed = false;
    }

    async load({ signal = null } = {}) {
        const [manifestText, palettesText] = await Promise.all([
            this._fetchText(this.manifestPath, { signal }),
            this._fetchText('assets/sprites/palettes.yaml', { signal }),
        ]);
        if (signal?.aborted || this._disposed) return;
        try {
            this.manifest = jsyaml.load(manifestText);
            this.palettes = jsyaml.load(palettesText);
        } catch (err) {
            throw new Error(`[AssetManager] failed to parse YAML: ${err.message}`);
        }

        this.assetVersion = this.manifest?.style?.assetVersion || null;
        const entries = this._flattenManifest(this.manifest);
        this._entriesCache = entries;
        this._entryById = new Map(entries.map((entry) => [entry.id, entry]));
        await Promise.all(entries.map(e => this._loadEntry(e, { signal })));
        if (signal?.aborted || this._disposed) return;

        if (this._loadMisses.length > 0) {
            console.warn(
                `[AssetManager] missing ${this._loadMisses.length} assets:`,
                this._loadMisses.map(m => m.id)
            );
        }
    }

    entryFor(id) {
        return this._entryById.get(id) || null;
    }

    async _fetchText(path, { signal = null } = {}) {
        const r = await fetch(path, { signal });
        if (!r.ok) throw new Error(`[AssetManager] HTTP ${r.status} for ${path}`);
        return r.text();
    }

    _flattenManifest(root) {
        const out = [];
        const collect = (arr) => arr && arr.forEach(e => out.push(e));
        collect(root.characters);
        collect(root.equipment);
        collect(root.accessories);
        collect(root.statusOverlays);
        collect(root.buildings);
        collect(root.props);
        collect(root.vegetation);
        collect(root.terrain);
        collect(root.bridges);
        collect(root.atmosphere);
        return out;
    }

    async _loadEntry(entry, { signal = null } = {}) {
        // Single-PNG entry (buildings are all single-image; composeGrid retired).
        const path = this._pathFor(entry);
        const { img: loadedImg, ok } = await this._loadImage(path, { signal });
        if (signal?.aborted || this._disposed) return;
        if (!ok) {
            this.missing.add(entry.id);
            this._loadMisses.push({ id: entry.id, path });
        }
        const img = this._normalizeImageToManifestSize(entry, loadedImg);
        const anchor = entry.anchor
            ? entry.anchor
            : entry.id.startsWith('building.')
                ? [Math.floor(img.width / 2), Math.floor(img.height * 7 / 8)]
                : null;
        this._storeBitmap(entry.id, img, {
            anchor,
            // Only building bases participate in per-pixel hit testing and
            // hover outlines. Avoid deriving full-sheet buffers for every
            // character, terrain, prop, and atmosphere asset.
            buildMask: entry.id.startsWith('building.'),
        });
        // Recurse for layered entries (overlays).
        if (entry.layers) {
            for (const [name, layer] of Object.entries(entry.layers)) {
                if (name === 'base') continue;
                const layerId = `${entry.id}.${name}`;
                // Building overlay layers (e.g. watchfire, beacon) live beside the
                // base PNG at buildings/<id>/<name>.png — same convention the
                // composed-building loader uses. Without this, single-image
                // buildings with layers would misroute through _pathFor.
                const layerPath = entry.id.startsWith('building.')
                    ? `assets/sprites/buildings/${entry.id}/${name}.png`
                    : this._pathFor({ id: layerId, ...layer });
                await this._loadLayer(layerId, layer, layerPath, { signal });
            }
        }
    }

    _storeBitmap(id, img, { anchor = null, mask = null, buildMask = false } = {}) {
        if (this._disposed) return;
        this.bitmaps.set(id, img);
        this.dimensions.set(id, { w: img.width, h: img.height });
        if (anchor) this.anchors.set(id, anchor);
        if (!buildMask) return;
        const alphaMask = mask || this._buildAlphaMask(img);
        this.alphaMasks.set(id, alphaMask);
        this.outlines.set(id, this._bakeOutline(img.width, img.height, alphaMask));
    }

    async _loadLayer(layerId, layer, layerPath, { signal = null } = {}) {
        const { img: loadedImg, ok } = await this._loadImage(layerPath, { signal });
        if (signal?.aborted || this._disposed) return;
        if (!ok) {
            this.missing.add(layerId);
            this._loadMisses.push({ id: layerId, path: layerPath });
        }
        const img = this._normalizeImageToManifestSize({ id: layerId, ...layer }, loadedImg);
        this._storeBitmap(layerId, img, {
            anchor: layer.anchor || null,
            buildMask: false,
        });
    }

    _pathFor(entry) {
        if (entry.assetPath) return entry.assetPath;
        // Deterministic path mapping by id prefix.
        if (entry.id.startsWith('agent.')) return `assets/sprites/characters/${entry.id}/sheet.png`;
        if (entry.id.startsWith('equipment.')) return `assets/sprites/equipment/${entry.id}.png`;
        if (entry.id.startsWith('overlay.accessory.')) return `assets/sprites/overlays/${entry.id}.png`;
        if (entry.id.startsWith('overlay.status.')) return `assets/sprites/overlays/${entry.id}.png`;
        if (entry.id.startsWith('building.')) return `assets/sprites/buildings/${entry.id}/base.png`;
        if (entry.id.startsWith('prop.')) return `assets/sprites/props/${entry.id}.png`;
        if (entry.id.startsWith('veg.')) return `assets/sprites/vegetation/${entry.id}.png`;
        if (entry.id.startsWith('terrain.')) return `assets/sprites/terrain/${entry.id}/sheet.png`;
        if (entry.id.startsWith('bridge.') || entry.id.startsWith('dock.')) return `assets/sprites/bridges/${entry.id}.png`;
        if (entry.id.startsWith('atmosphere.')) return `assets/sprites/atmosphere/${entry.id}.png`;
        return PLACEHOLDER_PATH;
    }

    // Resolves with { img, ok } where ok=false means the real PNG failed and
    // img is the placeholder checker instead.
    _loadImage(path, { signal = null } = {}) {
        return new Promise((resolve, reject) => {
            const img = new Image();
            let placeholder = null;
            let settled = false;
            const cleanup = () => signal?.removeEventListener?.('abort', abort);
            const finish = (value, error = null) => {
                if (settled) return;
                settled = true;
                cleanup();
                if (error) reject(error);
                else resolve(value);
            };
            const abort = () => {
                img.onload = null;
                img.onerror = null;
                if (placeholder) {
                    placeholder.onload = null;
                    placeholder.onerror = null;
                    placeholder.src = '';
                }
                img.src = '';
                finish(null, signal?.reason instanceof Error
                    ? signal.reason
                    : new DOMException('Asset load aborted', 'AbortError'));
            };
            if (signal?.aborted) {
                abort();
                return;
            }
            signal?.addEventListener?.('abort', abort, { once: true });
            img.onload = () => finish({ img, ok: true });
            img.onerror = () => {
                if (signal?.aborted) return;
                placeholder = new Image();
                placeholder.onload = () => finish({ img: placeholder, ok: false });
                placeholder.onerror = () => finish({ img, ok: false });
                placeholder.src = this._versionedPath(PLACEHOLDER_PATH);
            };
            img.src = this._versionedPath(path);
        });
    }

    _versionedPath(path) {
        if (!this.assetVersion || path.startsWith('data:')) return path;
        const separator = path.includes('?') ? '&' : '?';
        return `${path}${separator}v=${encodeURIComponent(this.assetVersion)}`;
    }

    _normalizeImageToManifestSize(entry, img) {
        if (!entry?.size || !img?.width || !img?.height) return img;
        if (entry.id?.startsWith('agent.') || entry.id?.startsWith('terrain.') || entry.id?.startsWith('atmosphere.')) {
            return img;
        }
        const target = entry.displaySize || entry.size;
        if (img.width === target && img.height === target) return img;

        const canvas = document.createElement('canvas');
        canvas.width = target;
        canvas.height = target;
        const ctx = canvas.getContext('2d');
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(img, 0, 0, target, target);
        return canvas;
    }

    _buildAlphaMask(img) {
        const canvas = document.createElement('canvas');
        canvas.width = img.width;
        canvas.height = img.height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);
        const mask = this._buildAlphaMaskFromCanvas(canvas);
        canvas.width = 0;
        canvas.height = 0;
        return mask;
    }

    _buildAlphaMaskFromCanvas(canvas) {
        const ctx = canvas.getContext('2d');
        const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        const mask = new Uint8Array(canvas.width * canvas.height);
        for (let i = 0; i < mask.length; i++) mask[i] = data[i * 4 + 3] > ALPHA_THRESHOLD ? 1 : 0;
        return mask;
    }

    // Pre-bake a 1-px gold outline as a transparent canvas the same size as the
    // sprite. Edge = pixel where the mask is empty AND any 4-neighbour is filled.
    // Done once at load so per-frame outline draw is a single ctx.drawImage.
    _bakeOutline(w, h, mask) {
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = OUTLINE_COLOR;
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                if (mask[y * w + x]) continue;
                const n = (y > 0 && mask[(y - 1) * w + x])
                       || (y < h - 1 && mask[(y + 1) * w + x])
                       || (x > 0 && mask[y * w + (x - 1)])
                       || (x < w - 1 && mask[y * w + (x + 1)]);
                if (n) ctx.fillRect(x, y, 1, 1);
            }
        }
        return canvas;
    }

    get(id) { return this.bitmaps.get(id); }
    // Returns true only when the real PNG loaded successfully (not a placeholder).
    has(id) { return this.bitmaps.has(id) && !this.missing.has(id); }
    getMask(id) { return this.alphaMasks.get(id); }
    getDims(id) { return this.dimensions.get(id); }
    getAnchor(id) { return this.anchors.get(id) ?? [0, 0]; }
    getOutline(id) { return this.outlines.get(id); }
    getEntry(id) {
        return this._entryById.get(id);
    }

    cacheStats() {
        let bitmapPixels = 0;
        let maskBytes = 0;
        let outlinePixels = 0;
        for (const bitmap of this.bitmaps.values()) {
            bitmapPixels += Math.max(0, Number(bitmap?.width) || 0) * Math.max(0, Number(bitmap?.height) || 0);
        }
        for (const mask of this.alphaMasks.values()) maskBytes += mask?.byteLength || 0;
        for (const outline of this.outlines.values()) {
            outlinePixels += Math.max(0, Number(outline?.width) || 0) * Math.max(0, Number(outline?.height) || 0);
        }
        return {
            bitmaps: this.bitmaps.size,
            bitmapPixels,
            masks: this.alphaMasks.size,
            maskBytes,
            outlines: this.outlines.size,
            outlinePixels,
            missing: this.missing.size,
        };
    }

    dispose() {
        this._disposed = true;
        for (const outline of this.outlines.values()) {
            if (outline && typeof outline === 'object' && 'width' in outline && 'height' in outline) {
                outline.width = 0;
                outline.height = 0;
            }
        }
        for (const bitmap of this.bitmaps.values()) {
            if (typeof HTMLCanvasElement !== 'undefined' && bitmap instanceof HTMLCanvasElement) {
                bitmap.width = 0;
                bitmap.height = 0;
            }
        }
        this.bitmaps.clear();
        this.alphaMasks.clear();
        this.dimensions.clear();
        this.anchors.clear();
        this.outlines.clear();
        this._entryById.clear();
        this.missing.clear();
        this._loadMisses.length = 0;
        this._entriesCache = null;
        this.manifest = null;
        this.palettes = null;
        this.assetVersion = null;
    }
}
