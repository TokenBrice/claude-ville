import { clearDetachedCodexWrench } from './CodexEngineerGrips.js';
import { DEFAULT_CELL, DIRECTIONS, WALK_FRAMES, IDLE_FRAMES } from './SpriteSheet.js';

// Compositor produces per-agent character bitmaps by:
// 1. selecting a model/provider base sheet,
// 2. recolouring provider trim from palettes.yaml (plan 2.6: provider hue lives
//    in trim only; authored robes keep their colours and take a per-variant
//    value step),
// 3. compositing an allowed runtime effort/accessory overlay over the head pixels,
// 4. optionally baking the shared 1-texel warm rim (plan 2.4) that both the
//    Canvas and resident WebGL bodies sample.
// Result is cached per (base sprite, paletteVariant, runtimeAccessory, outline) tuple.
// halfScaleSheet() bakes the 0.5x crowd LOD copy of any composed sheet (plan 2.7).

const CACHE_ENTRY_LIMIT = 24;
const CACHE_PIXEL_LIMIT = 12_500_000;
// Reuse still-live outputs across compositor registration/LRU misses without
// owning a second set of backing stores. Metadata has the same entry bound.
const LIVE_COMPOSED_SHEETS = new WeakMap();

function liveComposedSheets(assets) {
    let sheets = LIVE_COMPOSED_SHEETS.get(assets);
    if (!sheets) {
        sheets = new Map();
        LIVE_COMPOSED_SHEETS.set(assets, sheets);
    }
    return sheets;
}

// Direction columns that show the back of the head — face-side accessory
// detail (goggle lenses, veil openings) must not appear here.
const BACK_DIRECTIONS = new Set(['n', 'ne', 'nw']);
// Small downward nudge so the stamp sits onto the crown, not hovering above it.
const ACCESSORY_TOP_INSET = 1;
const DEFAULT_BACK_CROP = 0.6;
// Per-accessory back-facing crop fraction: how much of the overlay's top rows
// to keep when drawing the back of the head. Face-side detail lives in the
// lower rows, so crop harder for lenses/veils. Empty today — the runtime set
// is effort crests only (plan 0.12 deleted the role hats); kept so future
// accessories can opt into a custom crop.
const ACCESSORY_BACK_CROP = {};

// Plan 2.4 — one baked rim for both backends: 4-neighbour, 1 texel, warm
// near-black at half alpha, so the authored dark outline gains ground
// separation without doubling into a heavy line.
const OUTLINE_RGB = [28, 20, 16];
const OUTLINE_ALPHA = 128;
const OPAQUE_ALPHA = 16;
// Plan 2.6 — variant identity inside a family is a value step on the authored
// robe, never a hue swap. Indexed by the historical 0..3 variant.
const ROBE_VALUE_STEPS = Object.freeze([1, 1.1, 0.9, 1.2]);
// Plan 2.7 — LOD downsample: pixels at or above this alpha vote; the baked
// rim (OUTLINE_ALPHA) never does, and is re-baked at half resolution.
const LOD_VOTE_ALPHA = 160;
const LOD_DARK_LUMA = 70;
const LOD_CACHE = new WeakMap();
export class Compositor {
    // 1.7 — the world's compositor registers itself here so DOM-side consumers
    // (dashboard AvatarCanvas) can request the exact composited bitmap the
    // world draws (variant + accessory + team trim) and share its cache,
    // instead of re-loading raw sheet frames. Last-created wins; dispose()
    // releases the slot.
    static shared() {
        return Compositor._shared || null;
    }

    // Fires immediately when a shared compositor already exists, otherwise on
    // registration. Used by avatars created before the world renderer boots.
    static onSharedAvailable(cb) {
        if (typeof cb !== 'function') return () => {};
        if (Compositor._shared) {
            cb(Compositor._shared);
            return () => {};
        }
        Compositor._sharedListeners.push(cb);
        return () => {
            const index = Compositor._sharedListeners.indexOf(cb);
            if (index >= 0) Compositor._sharedListeners.splice(index, 1);
        };
    }

    constructor(assetManager) {
        this.assets = assetManager;
        this.cache = new Map();
        this.cachePixels = 0;
        Compositor._shared = this;
        for (const cb of Compositor._sharedListeners.splice(0)) cb(this);
    }

    spriteFor(baseSpriteId, paletteKey, paletteVariant, runtimeAccessory, teamTrim = null, { outline = false } = {}) {
        const baseId = baseSpriteId?.startsWith('agent.')
            ? baseSpriteId
            : `agent.${baseSpriteId || 'claude'}.base`;
        const palette = paletteKey || baseId.split('.')[1] || 'claude';
        // 4.14: include team trim accent in cache key so team-sashed sprites
        // cache independently from solo agents using the same palette variant.
        const teamHash = teamTrim ? String(teamTrim).toLowerCase() : '_';
        const variantKey = this._resolvedVariantKey(palette, paletteVariant, teamTrim);
        const key = `${baseId}|${palette}|${variantKey}|${runtimeAccessory ?? '_'}|${teamHash}|${outline ? 'rim' : '_'}`;
        if (this.cache.has(key) && this.cache.get(key)?.width > 0 && this.cache.get(key)?.height > 0) {
            const cached = this.cache.get(key);
            this.cache.delete(key);
            this.cache.set(key, cached);
            return cached;
        }

        const baseImg = this.assets.get(baseId);
        if (!baseImg) return null;
        const overlayId = runtimeAccessory
            ? runtimeAccessory.startsWith('overlay.') ? runtimeAccessory : `overlay.accessory.${runtimeAccessory}`
            : null;
        const overlayImg = overlayId ? this.assets.get(overlayId) : null;
        const live = liveComposedSheets(this.assets);
        const generationKey = `${key}|${this.assets.assetVersion || ''}`;
        const previous = live.get(generationKey);
        const reused = previous?.baseImg === baseImg && previous?.overlayImg === overlayImg
            ? previous.canvas.deref()
            : null;
        if (reused?.width > 0 && reused?.height > 0) {
            live.delete(generationKey);
            live.set(generationKey, previous);
            this.cache.set(key, reused);
            this.cachePixels += reused.width * reused.height;
            this._trimCache();
            return reused;
        }
        const dims = this.assets.getDims(baseId);
        // 0.5 — per-sheet sampled swap sources (manifest `paletteSource`) so
        // variants and team sashes recolor sheets whose generated garment hues
        // diverge from the palette family's first ramp color.
        const sheetSource = this.assets.getEntry?.(baseId)?.paletteSource || null;
        const canvas = document.createElement('canvas');
        canvas.width = dims.w;
        canvas.height = dims.h;
        // Composite-time pixel scans (palette swap, apex anchoring, contact
        // shadow) read this canvas back several times before caching.
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.imageSmoothingEnabled = false;

        ctx.drawImage(baseImg, 0, 0);
        // The detached tool must not become the head apex for effort crests.
        if (baseId === 'agent.codex.gpt54') clearDetachedCodexWrench(ctx, canvas.width, canvas.height);
        this._applyPaletteSwap(ctx, canvas.width, canvas.height, palette, paletteVariant, teamTrim, sheetSource);
        if (runtimeAccessory) this._compositeAccessory(ctx, baseId, runtimeAccessory, palette);
        if (outline) bakeSpriteOutline(ctx, canvas.width, canvas.height, dims.w / DIRECTIONS.length || DEFAULT_CELL);
        live.delete(generationKey);
        live.set(generationKey, { baseImg, overlayImg, canvas: new WeakRef(canvas) });
        while (live.size > CACHE_ENTRY_LIMIT) live.delete(live.keys().next().value);
        this.cache.set(key, canvas);
        this.cachePixels += canvas.width * canvas.height;
        this._trimCache();
        return canvas;
    }

    // C2 action strips are authored in the character's base colours, so they
    // must pass through the same palette swap and head accessory as the base
    // sheet: an agent that starts reading keeps its robe, its team sash, and
    // its effort crest. Cached beside the base sheets under the same limits.
    stripFor(stripKey, stripImage, {
        baseSpriteId,
        paletteKey,
        paletteVariant,
        runtimeAccessory = null,
        teamTrim = null,
        cellSize = DEFAULT_CELL,
        outline = false,
    } = {}) {
        if (!stripImage) return null;
        const baseId = baseSpriteId?.startsWith('agent.') ? baseSpriteId : `agent.${baseSpriteId || 'claude'}.base`;
        const palette = paletteKey || baseId.split('.')[1] || 'claude';
        const teamHash = teamTrim ? String(teamTrim).toLowerCase() : '_';
        const variantKey = this._resolvedVariantKey(palette, paletteVariant, teamTrim);
        const key = `strip|${stripKey}|${palette}|${variantKey}|${runtimeAccessory ?? '_'}|${teamHash}|${outline ? 'rim' : '_'}`;
        if (this.cache.has(key)) {
            const cached = this.cache.get(key);
            this.cache.delete(key);
            this.cache.set(key, cached);
            return cached;
        }
        const width = stripImage.naturalWidth || stripImage.width || 0;
        const height = stripImage.naturalHeight || stripImage.height || 0;
        if (!width || !height) return null;
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(stripImage, 0, 0);
        const sheetSource = this.assets.getEntry?.(baseId)?.paletteSource || null;
        this._applyPaletteSwap(ctx, width, height, palette, paletteVariant, teamTrim, sheetSource);
        if (runtimeAccessory) {
            this._compositeAccessory(ctx, baseId, runtimeAccessory, palette, {
                dims: { w: width, h: height },
                rows: Math.floor(height / (cellSize || DEFAULT_CELL)),
                cellSize: cellSize || DEFAULT_CELL,
            });
        }
        if (outline) bakeSpriteOutline(ctx, width, height, cellSize || DEFAULT_CELL);
        this.cache.set(key, canvas);
        this.cachePixels += width * height;
        this._trimCache();
        return canvas;
    }

    _resolvedVariantKey(paletteKey, variant, teamTrim) {
        const index = Math.max(0, Number(variant) || 0);
        const trimRamp = this.assets.palettes?.[paletteKey]?.trim || [];
        const trim = parseTrimColor(teamTrim)
            ? String(teamTrim).toLowerCase()
            : (trimRamp[index % Math.max(1, trimRamp.length)] || '_');
        return `${ROBE_VALUE_STEPS[index % ROBE_VALUE_STEPS.length]},${trim}`;
    }

    _trimCache() {
        while (this.cache.size > CACHE_ENTRY_LIMIT || this.cachePixels > CACHE_PIXEL_LIMIT) {
            const oldestKey = this.cache.keys().next().value;
            if (oldestKey == null) break;
            const oldest = this.cache.get(oldestKey);
            this.cache.delete(oldestKey);
            this.cachePixels -= (oldest?.width || 0) * (oldest?.height || 0);
        }
        this.cachePixels = Math.max(0, this.cachePixels);
    }

    cacheStats() {
        return {
            entries: this.cache.size,
            pixels: this.cachePixels,
            entryLimit: CACHE_ENTRY_LIMIT,
            pixelLimit: CACHE_PIXEL_LIMIT,
        };
    }

    releaseCache() {
        // Bodies, avatars and a replacement compositor can still sample the
        // same output. Drop ownership; never invalidate their backing stores.
        this.cache.clear();
        this.cachePixels = 0;
    }

    dispose() {
        this.releaseCache();
        if (Compositor._shared === this) Compositor._shared = null;
    }

    // Plan 2.6 — provider hue lives in trim only. The sheet's declared trim
    // source (manifest `paletteSource.trim`) takes the provider trim ramp or a
    // team sash; declared robe sources keep their authored hue and take the
    // variant's value step so four family members stay distinguishable. Sheets
    // that declare no source for a role are left exactly as authored — there is
    // no guessed fallback colour that could catch skin or hair.
    _applyPaletteSwap(ctx, w, h, provider, variant, teamTrim = null, sheetSource = null) {
        const index = Math.max(0, Number(variant) || 0);
        const trimRamp = this.assets.palettes?.[provider]?.trim || [];
        // 4.14: a team accent overrides the variant-derived trim so the sash
        // band reads as a team marker.
        const trimOverride = parseTrimColor(teamTrim);
        const targetTrim = trimOverride
            ? rgbToHex(trimOverride)
            : trimRamp[index % Math.max(1, trimRamp.length)] || null;
        const robeStep = ROBE_VALUE_STEPS[index % ROBE_VALUE_STEPS.length];
        const sourceRobe = robeStep !== 1 ? sourceList(sheetSource?.robe) : [];
        const sourceTrim = targetTrim ? sourceList(sheetSource?.trim) : [];
        if (!sourceRobe.length && !sourceTrim.length) return;
        const robe = sourceRobe.map(hexToRgb);
        const trimSwap = sourceTrim.map((src) => [hexToRgb(src), hexToRgb(targetTrim)]);

        const img = ctx.getImageData(0, 0, w, h);
        const data = img.data;
        // ΔE bucket: tolerate ±12 per channel so painterly shading steps of the
        // same garment also match. Without it only marker pixels change.
        const TOL = 12;
        const near = (r, g, b, src) => Math.abs(r - src[0]) <= TOL && Math.abs(g - src[1]) <= TOL && Math.abs(b - src[2]) <= TOL;
        for (let i = 0; i < data.length; i += 4) {
            const r = data[i], g = data[i + 1], b = data[i + 2];
            if (data[i + 3] < OPAQUE_ALPHA) continue;
            let done = false;
            for (let k = 0; k < robe.length; k++) {
                if (!near(r, g, b, robe[k])) continue;
                data[i] = Math.min(255, Math.round(r * robeStep));
                data[i + 1] = Math.min(255, Math.round(g * robeStep));
                data[i + 2] = Math.min(255, Math.round(b * robeStep));
                done = true;
                break;
            }
            if (done) continue;
            for (let k = 0; k < trimSwap.length; k++) {
                const [src, dst] = trimSwap[k];
                if (!near(r, g, b, src)) continue;
                data[i] = Math.max(0, Math.min(255, dst[0] + (r - src[0])));
                data[i + 1] = Math.max(0, Math.min(255, dst[1] + (g - src[1])));
                data[i + 2] = Math.max(0, Math.min(255, dst[2] + (b - src[2])));
                break;
            }
        }
        ctx.putImageData(img, 0, 0);
    }

    // `grid` lets an action strip reuse the same head-apex anchoring on its own
    // row count; the base sheet passes nothing and keeps the 10-row layout.
    _compositeAccessory(ctx, baseId, accessory, paletteKey, grid = null) {
        const overlayId = accessory.startsWith?.('overlay.')
            ? accessory
            : `overlay.accessory.${accessory}`;
        const overlayImg = this.assets.get(overlayId);
        if (!overlayImg) return;
        const dims = grid?.dims || this.assets.getDims(baseId);
        const cellSize = grid?.cellSize || (dims.w / DIRECTIONS.length || DEFAULT_CELL);
        const rows = grid?.rows ?? (WALK_FRAMES + IDLE_FRAMES);
        const cols = DIRECTIONS.length;
        if (!Number.isInteger(cellSize) || !Number.isInteger(rows) || rows <= 0 || dims.h < rows * cellSize) return;

        const overlayDims = this.assets.getDims(overlayId);
        const [ax, ay] = this.assets.getAnchor(overlayId);
        const palette = this.assets.palettes?.[paletteKey];
        const { front, back, colBottom } = this._harmonizeOverlay(overlayImg, overlayDims, palette);
        const cropFrac = ACCESSORY_BACK_CROP[accessory] ?? DEFAULT_BACK_CROP;

        // Single composite-time read of the palette-swapped, accessory-free
        // sheet: locates each cell's head apex (D1) and paints the contact
        // shadow (D4) before the overlay is stamped on top.
        const sheet = ctx.getImageData(0, 0, dims.w, dims.h);
        const sdata = sheet.data;
        const width = dims.w;
        const stamps = [];

        for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
                const cellX = c * cellSize;
                const cellY = r * cellSize;
                const isBack = BACK_DIRECTIONS.has(DIRECTIONS[c]);
                const apex = this._cellHeadApex(sdata, width, cellX, cellY, cellSize);

                const anchorX = apex.found ? apex.centroidX : cellX + Math.floor(cellSize / 2);
                const anchorY = apex.found ? apex.topY + ACCESSORY_TOP_INSET : cellY + Math.floor(cellSize * 0.22);
                const stampX = Math.round(anchorX - ax);
                const stampY = Math.round(anchorY - ay);
                const cropH = isBack ? Math.max(1, Math.round(overlayDims.h * cropFrac)) : overlayDims.h;
                stamps.push({ cellX, cellY, stampX, stampY, isBack, cropH });

                // Contact shadow: multiply the ~2 body pixels beneath the
                // overlay's opaque bottom edge (per column) so the hat reads as
                // seated on the crown, not a floating sticker.
                const shadowShift = isBack ? 1 : 0;
                for (let ox = 0; ox < overlayDims.w; ox++) {
                    let bottom = colBottom[ox];
                    if (bottom < 0) continue;
                    if (isBack) bottom = Math.min(bottom, cropH - 1);
                    const px = stampX + ox;
                    if (px < cellX || px >= cellX + cellSize) continue;
                    const edgeY = stampY + bottom + shadowShift;
                    for (let k = 1; k <= 2; k++) {
                        const py = edgeY + k;
                        if (py < cellY || py >= cellY + cellSize) continue;
                        const idx = (py * width + px) * 4;
                        if (sdata[idx + 3] < 16) continue;
                        sdata[idx] = Math.round(sdata[idx] * 0.78);
                        sdata[idx + 1] = Math.round(sdata[idx + 1] * 0.78);
                        sdata[idx + 2] = Math.round(sdata[idx + 2] * 0.78);
                    }
                }
            }
        }
        ctx.putImageData(sheet, 0, 0);

        for (const s of stamps) {
            // Accessories may extend above their owner's cell. Clip each stamp
            // so those pixels cannot become the preceding frame's false feet.
            ctx.save();
            ctx.beginPath();
            ctx.rect(s.cellX, s.cellY, cellSize, cellSize);
            ctx.clip();
            if (s.isBack) {
                // Back of the head: top slice only, nudged +1px down and using
                // the darkened overlay so face-side detail stops showing (D5).
                ctx.drawImage(back, 0, 0, overlayDims.w, s.cropH, s.stampX, s.stampY + 1, overlayDims.w, s.cropH);
            } else {
                ctx.drawImage(front, s.stampX, s.stampY, overlayDims.w, overlayDims.h);
            }
            ctx.restore();
        }
    }

    // Scans one cell of the accessory-free sheet: topmost opaque row and the
    // alpha-weighted centroid X of the top ~6 opaque rows (the head apex the
    // overlay anchors to).
    _cellHeadApex(data, width, cellX, cellY, cellSize) {
        let topY = -1;
        let minX = cellSize;
        let minY = cellSize;
        let maxX = 0;
        let maxY = 0;
        let found = false;
        for (let y = 0; y < cellSize; y++) {
            let rowHas = false;
            const base = ((cellY + y) * width + cellX) * 4;
            for (let x = 0; x < cellSize; x++) {
                if (data[base + x * 4 + 3] < 16) continue;
                rowHas = true;
                found = true;
                if (x < minX) minX = x;
                if (x > maxX) maxX = x;
                if (y < minY) minY = y;
                if (y > maxY) maxY = y;
            }
            if (rowHas && topY < 0) topY = y;
        }
        if (!found) return { found: false };
        let sumA = 0;
        let sumAX = 0;
        const bandEnd = Math.min(cellSize, topY + 6);
        for (let y = topY; y < bandEnd; y++) {
            const base = ((cellY + y) * width + cellX) * 4;
            for (let x = 0; x < cellSize; x++) {
                const a = data[base + x * 4 + 3];
                if (a < 16) continue;
                sumA += a;
                sumAX += a * x;
            }
        }
        const localCx = sumA > 0 ? sumAX / sumA : (minX + maxX) / 2;
        return {
            found: true,
            topY: cellY + topY,
            centroidX: cellX + localCx,
        };
    }

    // Builds the front and back (darkened) overlay canvases once per palette:
    // pre-tints the overlay ~0.25 toward the palette trim so hats harmonize
    // with the body (D4), and returns each column's opaque bottom row so the
    // caller can seat the contact shadow.
    _harmonizeOverlay(overlayImg, dims, palette) {
        const front = document.createElement('canvas');
        front.width = dims.w;
        front.height = dims.h;
        const fctx = front.getContext('2d', { willReadFrequently: true });
        fctx.imageSmoothingEnabled = false;
        fctx.drawImage(overlayImg, 0, 0);
        const trim = palette?.trim?.[0];
        if (trim) {
            fctx.globalCompositeOperation = 'color';
            fctx.globalAlpha = 0.25;
            fctx.fillStyle = trim;
            fctx.fillRect(0, 0, dims.w, dims.h);
            fctx.globalAlpha = 1;
            fctx.globalCompositeOperation = 'destination-in';
            fctx.drawImage(overlayImg, 0, 0);
            fctx.globalCompositeOperation = 'source-over';
        }

        const back = document.createElement('canvas');
        back.width = dims.w;
        back.height = dims.h;
        const bctx = back.getContext('2d');
        bctx.imageSmoothingEnabled = false;
        bctx.drawImage(front, 0, 0);
        bctx.globalCompositeOperation = 'source-atop';
        bctx.fillStyle = 'rgba(0, 0, 0, 0.12)';
        bctx.fillRect(0, 0, dims.w, dims.h);
        bctx.globalCompositeOperation = 'source-over';

        const fdata = fctx.getImageData(0, 0, dims.w, dims.h).data;
        const colBottom = new Int16Array(dims.w).fill(-1);
        for (let x = 0; x < dims.w; x++) {
            for (let y = dims.h - 1; y >= 0; y--) {
                if (fdata[(y * dims.w + x) * 4 + 3] >= 16) {
                    colBottom[x] = y;
                    break;
                }
            }
        }
        return { front, back, colBottom };
    }

    // Plan 2.7 — the 0.5x crowd LOD copy of a composed sheet, baked once per
    // source canvas. Each 2x2 block votes: the most common opaque colour wins
    // (so the result is snapped to the sheet's own palette); ties at a
    // silhouette edge keep the darker pixel so the outline survives; interior
    // ties take the pixel nearest the block mean. The rim is then re-baked at
    // half resolution instead of being averaged away. Drawn at world scale 1,
    // the LOD body sits on the same texel grid as everything else.
    halfScaleSheet(source, cellSize = DEFAULT_CELL) {
        if (!source?.width || !source?.height || typeof document === 'undefined') return null;
        const cell = Math.round(Number(cellSize) || DEFAULT_CELL);
        if (cell % 2 !== 0) return null;
        let bySize = LOD_CACHE.get(source);
        const cached = bySize?.get(cell);
        if (cached && cached.width === Math.floor(source.width / 2)) return cached;
        const canvas = document.createElement('canvas');
        const width = Math.floor(source.width / 2);
        const height = Math.floor(source.height / 2);
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.imageSmoothingEnabled = false;
        const src = source.getContext?.('2d', { willReadFrequently: true })
            ?.getImageData(0, 0, width * 2, height * 2);
        if (!src) return null;
        const out = ctx.createImageData(width, height);
        downsampleMajority(src.data, width * 2, out.data, width, height);
        ctx.putImageData(out, 0, 0);
        bakeSpriteOutline(ctx, width, height, cell / 2);
        if (!bySize) {
            bySize = new Map();
            LOD_CACHE.set(source, bySize);
        }
        bySize.set(cell, canvas);
        return canvas;
    }
}

Compositor._shared = null;
Compositor._sharedListeners = [];

// 0.5 — normalize a manifest paletteSource role (string or short string list)
// to a source color list. A role the sheet does not declare swaps nothing.
function sourceList(value) {
    const list = Array.isArray(value) ? value : [value];
    return list.filter((v) => /^#[0-9a-fA-F]{6}$/.test(String(v || ''))).slice(0, 3);
}

// Plan 2.4 — bakes the shared 1-texel warm rim into every cell of a sheet in
// place: each transparent texel with an opaque 4-neighbour in the same cell
// becomes OUTLINE_RGB at OUTLINE_ALPHA. Cell edges are respected so a rim can
// never become a neighbouring frame's false feet.
export function bakeSpriteOutline(ctx, width, height, cellSize = DEFAULT_CELL) {
    const cell = Math.max(1, Math.round(Number(cellSize) || DEFAULT_CELL));
    const image = ctx.getImageData(0, 0, width, height);
    const data = image.data;
    const solid = new Uint8Array(width * height);
    for (let i = 0; i < solid.length; i++) solid[i] = data[i * 4 + 3] >= OPAQUE_ALPHA ? 1 : 0;
    for (let y = 0; y < height; y++) {
        const cellTop = y - (y % cell);
        for (let x = 0; x < width; x++) {
            const index = y * width + x;
            if (solid[index]) continue;
            const cellLeft = x - (x % cell);
            const touches = (x > cellLeft && solid[index - 1])
                || (x + 1 < cellLeft + cell && x + 1 < width && solid[index + 1])
                || (y > cellTop && solid[index - width])
                || (y + 1 < cellTop + cell && y + 1 < height && solid[index + width]);
            if (!touches) continue;
            const offset = index * 4;
            data[offset] = OUTLINE_RGB[0];
            data[offset + 1] = OUTLINE_RGB[1];
            data[offset + 2] = OUTLINE_RGB[2];
            data[offset + 3] = OUTLINE_ALPHA;
        }
    }
    ctx.putImageData(image, 0, 0);
}

function lodLuma(data, offset) {
    return data[offset] * 0.299 + data[offset + 1] * 0.587 + data[offset + 2] * 0.114;
}

function downsampleMajority(src, srcWidth, dst, width, height) {
    const picks = [0, 0, 0, 0];
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const base = ((y * 2) * srcWidth + x * 2) * 4;
            const block = [base, base + 4, base + srcWidth * 4, base + srcWidth * 4 + 4];
            let count = 0;
            for (let k = 0; k < 4; k++) {
                if (src[block[k] + 3] >= LOD_VOTE_ALPHA) picks[count++] = block[k];
            }
            const out = (y * width + x) * 4;
            if (count === 0) continue;
            if (count === 1 && lodLuma(src, picks[0]) >= LOD_DARK_LUMA) continue;
            let best = picks[0];
            let bestVotes = 0;
            let tied = false;
            for (let a = 0; a < count; a++) {
                let votes = 0;
                for (let b = 0; b < count; b++) {
                    if (src[picks[a]] === src[picks[b]] && src[picks[a] + 1] === src[picks[b] + 1]
                        && src[picks[a] + 2] === src[picks[b] + 2]) votes++;
                }
                if (votes > bestVotes) {
                    bestVotes = votes;
                    best = picks[a];
                    tied = false;
                } else if (votes === bestVotes && !(src[picks[a]] === src[best]
                    && src[picks[a] + 1] === src[best + 1] && src[picks[a] + 2] === src[best + 2])) {
                    tied = true;
                }
            }
            if (tied) {
                if (count < 4) {
                    for (let a = 0; a < count; a++) {
                        if (lodLuma(src, picks[a]) < lodLuma(src, best)) best = picks[a];
                    }
                } else {
                    let mr = 0, mg = 0, mb = 0;
                    for (let a = 0; a < count; a++) {
                        mr += src[picks[a]];
                        mg += src[picks[a] + 1];
                        mb += src[picks[a] + 2];
                    }
                    mr /= count;
                    mg /= count;
                    mb /= count;
                    let bestDistance = Infinity;
                    for (let a = 0; a < count; a++) {
                        const dr = src[picks[a]] - mr;
                        const dg = src[picks[a] + 1] - mg;
                        const db = src[picks[a] + 2] - mb;
                        const distance = dr * dr + dg * dg + db * db;
                        if (distance < bestDistance) {
                            bestDistance = distance;
                            best = picks[a];
                        }
                    }
                }
            }
            dst[out] = src[best];
            dst[out + 1] = src[best + 1];
            dst[out + 2] = src[best + 2];
            dst[out + 3] = 255;
        }
    }
}

function hexToRgb(hex) {
    const h = hex.replace('#', '');
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

// 4.14: accept "#rrggbb" only (TeamColor accents are 7-char hex strings).
// Returns [r, g, b] or null if not recognized — callers then skip the override.
function parseTrimColor(value) {
    if (!value || typeof value !== 'string') return null;
    const text = value.trim().replace('#', '');
    if (!/^[0-9a-fA-F]{6}$/.test(text)) return null;
    return [parseInt(text.slice(0, 2), 16), parseInt(text.slice(2, 4), 16), parseInt(text.slice(4, 6), 16)];
}

function rgbToHex([r, g, b]) {
    const clamp = (v) => Math.max(0, Math.min(255, v | 0));
    return `#${clamp(r).toString(16).padStart(2, '0')}${clamp(g).toString(16).padStart(2, '0')}${clamp(b).toString(16).padStart(2, '0')}`;
}
