import { clearDetachedCodexWrench } from './CodexEngineerGrips.js';
import { DEFAULT_CELL, DIRECTIONS, WALK_FRAMES, IDLE_FRAMES } from './SpriteSheet.js';

// Compositor produces per-agent character bitmaps by:
// 1. selecting a model/provider base sheet,
// 2. recolouring provider trim from palettes.yaml (plan 2.6: provider hue lives
//    in trim) and giving the authored robe the agent's crowd variant: a value
//    step plus a hue rotation bounded to ±ROBE_HUE_LIMIT_DEG (W2.3),
// 3. compositing an allowed runtime effort/accessory overlay over the head pixels,
// 4. optionally baking the shared 1-texel warm rim (plan 2.4) that both the
//    Canvas and resident WebGL bodies sample.
// Result is cached per (base sprite, resolved variant, runtimeAccessory, outline) tuple.
// halfScaleSheet() bakes the 0.5x crowd LOD copy of any composed sheet (plan 2.7).

const CACHE_ENTRY_LIMIT = 24;
const CACHE_PIXEL_LIMIT = 12_500_000;
// A composite sampled within this window is the live working set (twelve
// robe variants × a 1.7 Mpx action strip each outgrow the pixel limit with
// nine idle agents). Evicting one only rebakes it — palette swap and rim over
// the whole sheet — and re-uploads it to the GPU on its next frame, so the
// limits bound cold entries and never trim a set that is still being drawn.
const CACHE_HOT_MS = 2000;
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
// lower rows, so crop harder for lenses/veils: the circlet's band and front
// gem sit at brow height, so from behind it is not drawn at all. Hoods keep
// their full drape from behind (their face opening is filled, see below).
const ACCESSORY_BACK_CROP = Object.freeze({
    circlet: 0.3,
    hoodUp: 1,
    pinnedHood: 1,
});
// Hoods frame the face through a transparent opening. From behind that
// opening is the back of the hood, so the back stamp fills each row's span
// between the hood's outer pixels with the hood's own cloth colour.
const ACCESSORY_BACK_FILL = new Set(['hoodUp', 'pinnedHood']);

// W8.2a (AD-P1b) — cosmetic head overlays. A villager whose sheet shows a
// bare head and who carries no effort crest wears one of these, picked by a
// hash of the agent id: same-model crowds stop being a clone army without any
// state behind the choice. Cosmetic overlays keep their own material colour
// (no provider-trim pre-tint; that harmonization is for the crests).
export const COSMETIC_HEAD_ACCESSORIES = Object.freeze([
    'hoodUp', 'flatCap', 'strawHat', 'bandana', 'biretta', 'circlet', 'laurelCrown',
    'hornedHelm', 'featherCap', 'wingedHelm', 'turban', 'pinnedHood',
]);
// Hair reads as a wig over authored hair: only shaved (`headBare`) sheets.
export const HAIR_TUFT_ACCESSORIES = Object.freeze(['hairTuftLight', 'hairTuftDark']);
const COSMETIC_SET = new Set([...COSMETIC_HEAD_ACCESSORIES, ...HAIR_TUFT_ACCESSORIES]);
const BARE_HEAD_ACCESSORIES = Object.freeze([...COSMETIC_HEAD_ACCESSORIES, ...HAIR_TUFT_ACCESSORIES]);

// The head accessory a villager composites. The effort crest always wins
// (its semantics are untouched); a sheet flagged `headCovered` (authored
// hat, helm, hood or crown) takes none; otherwise a deterministic cosmetic.
export function resolveHeadAccessory({ effortAccessory = null, allowEffort = true, agentId = null, headCovered = false, headBare = false } = {}) {
    if (allowEffort !== false && effortAccessory) return effortAccessory;
    if (headCovered || agentId == null || agentId === '') return null;
    const pool = headBare ? BARE_HEAD_ACCESSORIES : COSMETIC_HEAD_ACCESSORIES;
    return pool[cosmeticHash(String(agentId)) % pool.length];
}

// FNV-1a + fmix32 over `hat:<id>`: decorrelated from the robe variant hash so
// hat and robe hue vary independently across a crowd.
function cosmeticHash(id) {
    let h = 0x811c9dc5;
    const text = `hat:${id}`;
    for (let i = 0; i < text.length; i++) {
        h ^= text.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    h ^= h >>> 16;
    h = Math.imul(h, 0x85ebca6b);
    h ^= h >>> 13;
    h = Math.imul(h, 0xc2b2ae35);
    h ^= h >>> 16;
    return h >>> 0;
}

// Plan 2.4 — one baked rim for both backends: 4-neighbour, 1 texel, warm
// near-black at half alpha, so the authored dark outline gains ground
// separation without doubling into a heavy line.
const OUTLINE_RGB = [28, 20, 16];
const OUTLINE_ALPHA = 128;
const OPAQUE_ALPHA = 16;
// W2.3 — crowd individuation. Variant identity inside a family is the
// authored robe taking a value step and a bounded hue rotation (OKLab, L kept)
// on the sheet's declared `paletteSource.robe` pixels only; skin, hair, trim
// and metal stay as authored. ROBE_HUE_LIMIT_DEG is the hard clamp that keeps
// the provider family legible (Codex stays steel-blue, DeepSeek stays green).
// A rotation's visible shift grows with chroma, so the turn is tuned per
// garment for roughly equal visibility: a saturated robe (Sonnet violet,
// GLM vermilion) turns less than the band (it would read magenta or pink at
// the full band), and a near-neutral one (Codex plate, OKLCH C≈0.03) also
// takes a bounded chroma lift toward ROBE_CHROMA_FLOOR so the turn reads at
// all. The variant index is 0..ROBE_VARIANT_COUNT-1. `index % 4` is the
// historical variant, so every agent keeps its value step and trim colour;
// `index / 4` selects the hue band.
const ROBE_VALUE_STEPS = Object.freeze([1, 1.1, 0.9, 1.2]);
const ROBE_HUE_BANDS = Object.freeze([0, 16, -16]);
export const ROBE_HUE_LIMIT_DEG = 18;
export const ROBE_VALUE_RANGE = Object.freeze([0.9, 1.2]);
export const ROBE_VARIANT_COUNT = ROBE_VALUE_STEPS.length * ROBE_HUE_BANDS.length;
// Above this source chroma the band turn scales down by TURN_CHROMA / C.
const ROBE_TURN_CHROMA = 0.09;
// Rotated near-neutral garments lift toward this chroma, by at most LIFT_MAX.
const ROBE_CHROMA_FLOOR = 0.09;
const ROBE_CHROMA_LIFT_MAX = 0.04;
const ROBE_VARIANTS = Object.freeze(Array.from({ length: ROBE_VARIANT_COUNT }, (_, index) => Object.freeze({
    value: ROBE_VALUE_STEPS[index % ROBE_VALUE_STEPS.length],
    hue: Math.max(-ROBE_HUE_LIMIT_DEG, Math.min(ROBE_HUE_LIMIT_DEG,
        ROBE_HUE_BANDS[Math.floor(index / ROBE_VALUE_STEPS.length)])),
})));
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
        this.cacheUsedAt = new Map();
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
        const variantKey = this._resolvedVariantKey(palette, paletteVariant, teamTrim, baseId);
        const key = `${baseId}|${palette}|${variantKey}|${runtimeAccessory ?? '_'}|${teamHash}|${outline ? 'rim' : '_'}`;
        if (this.cache.has(key) && this.cache.get(key)?.width > 0 && this.cache.get(key)?.height > 0) {
            const cached = this.cache.get(key);
            this.cache.delete(key);
            this.cache.set(key, cached);
            this._trimCache(this._markUsed(key));
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
            this._trimCache(this._markUsed(key));
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
        this._trimCache(this._markUsed(key));
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
        const variantKey = this._resolvedVariantKey(palette, paletteVariant, teamTrim, baseId);
        const key = `strip|${stripKey}|${palette}|${variantKey}|${runtimeAccessory ?? '_'}|${teamHash}|${outline ? 'rim' : '_'}`;
        if (this.cache.has(key)) {
            const cached = this.cache.get(key);
            this.cache.delete(key);
            this.cache.set(key, cached);
            this._trimCache(this._markUsed(key));
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
        this._trimCache(this._markUsed(key));
        return canvas;
    }

    // The pixels a variant actually changes on this sheet: a role the sheet
    // declares no source for contributes nothing, so its variants share one
    // composite (and one live canvas) instead of twelve identical copies.
    _resolvedVariantKey(paletteKey, variant, teamTrim, baseId) {
        const index = variantIndex(variant);
        const robe = ROBE_VARIANTS[index];
        const sheetSource = this.assets.getEntry?.(baseId)?.paletteSource || null;
        const robeKey = sourceList(sheetSource?.robe).length ? `${robe.value},${robe.hue}` : '_';
        const trimRamp = this.assets.palettes?.[paletteKey]?.trim || [];
        const trim = !sourceList(sheetSource?.trim).length
            ? '_'
            : parseTrimColor(teamTrim)
                ? String(teamTrim).toLowerCase()
                : (trimRamp[trimIndex(index, trimRamp.length)] || '_');
        return `${robeKey},${trim}`;
    }

    // Hits trim too, so a transient peak (a crowd passing through) is released
    // once it cools instead of waiting for the next bake.
    _markUsed(key) {
        const now = performance.now();
        this.cacheUsedAt.set(key, now);
        return now;
    }

    _trimCache(now = performance.now()) {
        while (this.cache.size > CACHE_ENTRY_LIMIT || this.cachePixels > CACHE_PIXEL_LIMIT) {
            // Map order is recency order: once the oldest entry is hot, all are.
            const oldestKey = this.cache.keys().next().value;
            if (oldestKey == null || now - (this.cacheUsedAt.get(oldestKey) ?? -Infinity) < CACHE_HOT_MS) break;
            const oldest = this.cache.get(oldestKey);
            this.cache.delete(oldestKey);
            this.cacheUsedAt.delete(oldestKey);
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
        this.cacheUsedAt.clear();
        this.cachePixels = 0;
    }

    dispose() {
        this.releaseCache();
        if (Compositor._shared === this) Compositor._shared = null;
    }

    // Plan 2.6 — provider hue lives in trim. The sheet's declared trim source
    // (manifest `paletteSource.trim`) takes the provider trim ramp or a team
    // sash; declared robe sources take the agent's crowd variant (W2.3: value
    // step + hue rotation clamped to ±ROBE_HUE_LIMIT_DEG) so twelve family
    // members stay distinguishable. Sheets that declare no source for a role
    // are left exactly as authored — there is no guessed fallback colour that
    // could catch skin or hair.
    _applyPaletteSwap(ctx, w, h, provider, variant, teamTrim = null, sheetSource = null) {
        const index = variantIndex(variant);
        const robeVariant = ROBE_VARIANTS[index];
        const trimRamp = this.assets.palettes?.[provider]?.trim || [];
        // 4.14: a team accent overrides the variant-derived trim so the sash
        // band reads as a team marker.
        const trimOverride = parseTrimColor(teamTrim);
        const targetTrim = trimOverride
            ? rgbToHex(trimOverride)
            : trimRamp[trimIndex(index, trimRamp.length)] || null;
        const robeChanges = robeVariant.value !== 1 || robeVariant.hue !== 0;
        const sourceRobe = robeChanges ? sourceList(sheetSource?.robe) : [];
        const sourceTrim = targetTrim ? sourceList(sheetSource?.trim) : [];
        if (!sourceRobe.length && !sourceTrim.length) return;
        const robe = sourceRobe.map(hexToRgb);
        const trimSwap = sourceTrim.map((src) => [hexToRgb(src), hexToRgb(targetTrim)]);
        // One shift per distinct garment colour: sheets carry a few hundred.
        const shifted = new Map();

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
                const key = (r << 16) | (g << 8) | b;
                let out = shifted.get(key);
                if (!out) {
                    out = shiftRobeColor([r, g, b], index, robe[k]);
                    shifted.set(key, out);
                }
                data[i] = out[0];
                data[i + 1] = out[1];
                data[i + 2] = out[2];
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
        const name = overlayId.slice('overlay.accessory.'.length);
        const { front, back, colBottom } = this._harmonizeOverlay(overlayImg, overlayDims, palette, {
            tint: !COSMETIC_SET.has(name),
            fillBack: ACCESSORY_BACK_FILL.has(name),
        });
        const cropFrac = ACCESSORY_BACK_CROP[name] ?? DEFAULT_BACK_CROP;

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
    // effort crests pre-tint ~0.25 toward the palette trim so they harmonize
    // with the body (D4; cosmetic hats keep their own material, `tint`
    // false), and returns each column's opaque bottom row so the caller can
    // seat the contact shadow. `fillBack` closes a hood's face opening on the
    // back canvas with the hood's dominant cloth colour.
    _harmonizeOverlay(overlayImg, dims, palette, { tint = true, fillBack = false } = {}) {
        const front = document.createElement('canvas');
        front.width = dims.w;
        front.height = dims.h;
        const fctx = front.getContext('2d', { willReadFrequently: true });
        fctx.imageSmoothingEnabled = false;
        fctx.drawImage(overlayImg, 0, 0);
        const trim = tint ? palette?.trim?.[0] : null;
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

        const fdata = fctx.getImageData(0, 0, dims.w, dims.h).data;
        const back = document.createElement('canvas');
        back.width = dims.w;
        back.height = dims.h;
        const bctx = back.getContext('2d', { willReadFrequently: fillBack });
        bctx.imageSmoothingEnabled = false;
        if (fillBack) {
            const filled = bctx.createImageData(dims.w, dims.h);
            filled.data.set(fdata);
            fillOverlayGaps(filled.data, dims.w, dims.h);
            bctx.putImageData(filled, 0, 0);
        } else {
            bctx.drawImage(front, 0, 0);
        }
        bctx.globalCompositeOperation = 'source-atop';
        bctx.fillStyle = 'rgba(0, 0, 0, 0.12)';
        bctx.fillRect(0, 0, dims.w, dims.h);
        bctx.globalCompositeOperation = 'source-over';

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

// W8.2a — closes the transparent gaps inside each row of an overlay (a hood's
// face opening) with the overlay's dominant cloth colour: the most frequent
// opaque colour among texels at or above the 25th luma percentile, so the
// dark outline never becomes the fill. Rows with fewer than two opaque
// texels stay as they are. RGBA in place.
export function fillOverlayGaps(data, width, height) {
    const lumas = [];
    for (let i = 0; i < data.length; i += 4) {
        if (data[i + 3] >= OPAQUE_ALPHA) lumas.push(data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114);
    }
    if (!lumas.length) return data;
    lumas.sort((a, b) => a - b);
    const floor = lumas[Math.floor(lumas.length * 0.25)];
    const counts = new Map();
    let fill = 0;
    let best = 0;
    for (let i = 0; i < data.length; i += 4) {
        if (data[i + 3] < OPAQUE_ALPHA) continue;
        if (data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114 < floor) continue;
        const key = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
        const n = (counts.get(key) || 0) + 1;
        counts.set(key, n);
        if (n > best) { best = n; fill = key; }
    }
    for (let y = 0; y < height; y++) {
        let first = -1;
        let last = -1;
        for (let x = 0; x < width; x++) {
            if (data[(y * width + x) * 4 + 3] < OPAQUE_ALPHA) continue;
            if (first < 0) first = x;
            last = x;
        }
        for (let x = first + 1; first >= 0 && x < last; x++) {
            const i = (y * width + x) * 4;
            if (data[i + 3] >= OPAQUE_ALPHA) continue;
            data[i] = (fill >> 16) & 255;
            data[i + 1] = (fill >> 8) & 255;
            data[i + 2] = fill & 255;
            data[i + 3] = 255;
        }
    }
    return data;
}

// W2.3 — the agent's crowd variant, 0..ROBE_VARIANT_COUNT-1, deterministic
// from (agent id, model, provider). The world body and the dashboard avatar
// both call this, so they land on the same compositor cache entry. The 32-bit
// string hash is the historical one: `variant % 4` equals the old 0..3 variant.
export function agentPaletteVariant(agentId, model, providerKey) {
    const text = `${agentId ?? ''}:${model || ''}:${providerKey || ''}`;
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
        hash = ((hash << 5) - hash) + text.charCodeAt(i);
        hash |= 0;
    }
    return Math.abs(hash) % ROBE_VARIANT_COUNT;
}

// `{ value, hue }` for a variant index (out-of-range wraps). `hue` is the
// band in degrees; the turn a garment actually takes is robeHueTurn().
export function robeVariant(variant) {
    return ROBE_VARIANTS[variantIndex(variant)];
}

function variantIndex(variant) {
    return Math.max(0, Math.floor(Number(variant) || 0)) % ROBE_VARIANT_COUNT;
}

// Trim follows the historical 0..3 variant so every agent keeps its sash.
function trimIndex(index, rampLength) {
    return (index % ROBE_VALUE_STEPS.length) % Math.max(1, rampLength);
}

// The hue turn (degrees) a garment whose declared source colour is `source`
// takes in `variant`: the band, scaled down for saturated sources so every
// family shows about the same visible shift. Never beyond ±ROBE_HUE_LIMIT_DEG.
export function robeHueTurn(variant, source) {
    const { hue } = robeVariant(variant);
    if (hue === 0) return 0;
    const [, sa, sb] = srgbToOklab(source[0], source[1], source[2]);
    const scale = Math.min(1, ROBE_TURN_CHROMA / Math.max(1e-4, Math.hypot(sa, sb)));
    return Math.max(-ROBE_HUE_LIMIT_DEG, Math.min(ROBE_HUE_LIMIT_DEG, hue * scale));
}

// Shifts one robe texel into a variant: rotate its OKLab hue by the garment's
// turn (lightness and chroma kept), lift a near-neutral garment's chroma along
// the rotated hue of its declared source colour (so its texels move together
// instead of scattering by their own noisy hue), then take the historical
// sRGB value step.
export function shiftRobeColor(rgb, variant, source = rgb) {
    const { value, hue } = robeVariant(variant);
    let [r, g, b] = rgb;
    if (hue !== 0) {
        const [L, A, B] = srgbToOklab(r, g, b);
        const theta = (robeHueTurn(variant, source) * Math.PI) / 180;
        const cos = Math.cos(theta);
        const sin = Math.sin(theta);
        let a = A * cos - B * sin;
        let bb = A * sin + B * cos;
        const [, sa, sb] = srgbToOklab(source[0], source[1], source[2]);
        const sc = Math.hypot(sa, sb);
        const lift = Math.min(ROBE_CHROMA_LIFT_MAX, Math.max(0, ROBE_CHROMA_FLOOR - sc));
        if (lift > 0 && sc > 1e-4) {
            a += lift * ((sa * cos - sb * sin) / sc);
            bb += lift * ((sa * sin + sb * cos) / sc);
        }
        // Fit into sRGB by shrinking chroma at the turned hue: a channel
        // clipped at 0 or 255 would otherwise swing the hue past the clamp.
        let lin = oklabToLinear(L, a, bb);
        for (let k = 0.85; k >= 0 && !inGamut(lin); k -= 0.15) lin = oklabToLinear(L, a * k, bb * k);
        [r, g, b] = lin.map(linearToSrgb);
    }
    return [
        Math.max(0, Math.min(255, Math.round(r * value))),
        Math.max(0, Math.min(255, Math.round(g * value))),
        Math.max(0, Math.min(255, Math.round(b * value))),
    ];
}

function srgbToLinear(c) {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

function linearToSrgb(v) {
    const c = v <= 0.0031308 ? v * 12.92 : 1.055 * Math.max(0, v) ** (1 / 2.4) - 0.055;
    return Math.max(0, Math.min(255, c * 255));
}

function srgbToOklab(r8, g8, b8) {
    const r = srgbToLinear(r8), g = srgbToLinear(g8), b = srgbToLinear(b8);
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
    const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
    const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
    return [
        0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
        1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
        0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
    ];
}

function oklabToLinear(L, a, b) {
    const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
    const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
    const s = (L - 0.0894841775 * a - 1.2914855480 * b) ** 3;
    return [
        4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
        -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
        -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
    ];
}

function inGamut(linear) {
    return linear.every((c) => c >= -1e-4 && c <= 1 + 1e-4);
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
