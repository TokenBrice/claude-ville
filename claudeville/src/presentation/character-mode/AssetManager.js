// AssetManager loads sprites declared in manifest.yaml, decodes them into
// HTMLImageElements + alpha masks + pre-baked outlines, and exposes lookup by id.

const PLACEHOLDER_PATH = 'assets/sprites/_placeholder/checker-64.png';
const OUTLINE_COLOR = '#f2d36b';
const ALPHA_THRESHOLD = 16;

export class AssetManager {
    constructor(manifestPath = 'assets/sprites/manifest.yaml') {
        this.manifestPath = manifestPath;
        this.manifest = null;          // parsed YAML root
        this.palettes = null;
        this.bitmaps = new Map();      // id → HTMLImageElement (or composed canvas)
        this.alphaMasks = new Map();   // id → Uint8Array
        this.dimensions = new Map();   // id → { w, h }
        this.anchors = new Map();      // id → [cx, cy] in sprite-local px
        this.outlines = new Map();     // id → HTMLCanvasElement (1-px gold edge)
        this._entriesCache = null;
        this.assetVersion = null;
        // IDs that resolved to the placeholder checker (404 or load error).
        // has(id) returns false for these so callers can skip drawing them.
        this.missing = new Set();
    }

    async load() {
        const [manifestText, palettesText] = await Promise.all([
            this._fetchText(this.manifestPath),
            this._fetchText('assets/sprites/palettes.yaml'),
        ]);
        try {
            this.manifest = jsyaml.load(manifestText);
            this.palettes = jsyaml.load(palettesText);
        } catch (err) {
            throw new Error(`[AssetManager] failed to parse YAML: ${err.message}`);
        }

        this.assetVersion = this.manifest?.style?.assetVersion || null;
        const entries = this._flattenManifest(this.manifest);
        this._entriesCache = entries;
        await Promise.all(entries.map(e => this._loadEntry(e)));
    }

    async _fetchText(path) {
        const r = await fetch(path);
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

    async _loadEntry(entry) {
        // For composed buildings: stitch quadrant PNGs into one canvas.
        if (entry.composeGrid && entry.layers?.base) {
            await this._loadComposedBuilding(entry);
            return;
        }
        // Standard single-PNG entry.
        const path = this._pathFor(entry);
        const { img: loadedImg, ok } = await this._loadImage(path);
        if (!ok) this.missing.add(entry.id);
        const img = this._normalizeImageToManifestSize(entry, loadedImg);
        this.bitmaps.set(entry.id, img);
        this.dimensions.set(entry.id, { w: img.width, h: img.height });
        if (entry.anchor) {
            this.anchors.set(entry.id, entry.anchor);
        } else if (entry.id.startsWith('building.')) {
            // Standard single-tile buildings: anchor at bottom-center so the iso
            // footprint sits at the building screen center.
            this.anchors.set(entry.id, [Math.floor(img.width / 2), Math.floor(img.height * 7 / 8)]);
        }
        const mask = this._buildAlphaMask(img);
        this.alphaMasks.set(entry.id, mask);
        this.outlines.set(entry.id, this._bakeOutline(img.width, img.height, mask));
        // Recurse for layered entries (overlays).
        if (entry.layers) {
            for (const [name, layer] of Object.entries(entry.layers)) {
                if (name === 'base') continue;
                const layerId = `${entry.id}.${name}`;
                const layerPath = this._pathFor({ id: layerId, ...layer });
                const { img: loadedLayerImg, ok: layerOk } = await this._loadImage(layerPath);
                if (!layerOk) this.missing.add(layerId);
                const layerImg = this._normalizeImageToManifestSize({ id: layerId, ...layer }, loadedLayerImg);
                this.bitmaps.set(layerId, layerImg);
                this.dimensions.set(layerId, { w: layerImg.width, h: layerImg.height });
                if (layer.anchor) this.anchors.set(layerId, layer.anchor);
            }
        }
    }

    async _loadComposedBuilding(entry) {
        const [cols, rows] = entry.composeGrid;
        const sourceCellSize = entry.layers.base.size || 64;
        const cellSize = entry.layers.base.displaySize || sourceCellSize * 2;
        const canvas = document.createElement('canvas');
        canvas.width = cols * cellSize;
        canvas.height = rows * cellSize;
        const ctx = canvas.getContext('2d');
        ctx.imageSmoothingEnabled = false;
        const missingCells = [];
        for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
                const cellPath = `assets/sprites/buildings/${entry.id}/base-${c}-${r}.png`;
                const { img, ok } = await this._loadImage(cellPath);
                if (!ok) missingCells.push(cellPath);
                ctx.drawImage(img, c * cellSize, r * cellSize, cellSize, cellSize);
            }
        }
        if (missingCells.length > 0) {
            this.missing.add(entry.id);
            throw new Error(
                `[AssetManager] missing required composed cells for ${entry.id}: ${missingCells.join(', ')}`
            );
        }
        this.bitmaps.set(entry.id, canvas);
        this.dimensions.set(entry.id, { w: canvas.width, h: canvas.height });
        // Composed hero buildings without an explicit manifest anchor land their
        // bottom-of-footprint near the iso tile center: bottom-center horizontally,
        // 7/8 down vertically (lower band ≈ ground footprint, upper band ≈ tower).
        if (entry.anchor) {
            this.anchors.set(entry.id, entry.anchor);
        } else {
            this.anchors.set(entry.id, [Math.floor(canvas.width / 2), Math.floor(canvas.height * 7 / 8)]);
        }
        const mask = this._buildAlphaMaskFromCanvas(canvas);
        this.alphaMasks.set(entry.id, mask);
        this.outlines.set(entry.id, this._bakeOutline(canvas.width, canvas.height, mask));
        // Layer overlays (beacon, banner, etc.)
        if (entry.layers) {
            for (const [name, layer] of Object.entries(entry.layers)) {
                if (name === 'base') continue;
                const layerId = `${entry.id}.${name}`;
                const layerPath = `assets/sprites/buildings/${entry.id}/${name}.png`;
                const { img: loadedImg, ok: layerOk } = await this._loadImage(layerPath);
                if (!layerOk) this.missing.add(layerId);
                const img = this._normalizeImageToManifestSize({ id: layerId, ...layer }, loadedImg);
                this.bitmaps.set(layerId, img);
                this.dimensions.set(layerId, { w: img.width, h: img.height });
                if (layer.anchor) this.anchors.set(layerId, layer.anchor);
            }
        }
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
    _loadImage(path) {
        return new Promise((resolve) => {
            const img = new Image();
            img.onload = () => resolve({ img, ok: true });
            img.onerror = () => {
                console.warn(`[AssetManager] missing asset: ${path} — using placeholder`);
                const ph = new Image();
                ph.onload = () => resolve({ img: ph, ok: false });
                ph.onerror = () => resolve({ img, ok: false });   // give up
                ph.src = this._versionedPath(PLACEHOLDER_PATH);
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
        return this._buildAlphaMaskFromCanvas(canvas);
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
        return this._entriesCache?.find(e => e.id === id);
    }
}
