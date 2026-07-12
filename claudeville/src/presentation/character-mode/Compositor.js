import { DEFAULT_CELL, DIRECTIONS, WALK_FRAMES, IDLE_FRAMES } from './SpriteSheet.js';

// Compositor produces per-agent character bitmaps by:
// 1. selecting a model/provider base sheet,
// 2. palette-swapping it using palettes.yaml,
// 3. compositing an allowed runtime effort/accessory overlay over the head pixels.
// Result is cached per (base sprite, paletteVariant, runtimeAccessory) tuple.

const cache = new Map();

// Direction columns that show the back of the head — face-side accessory
// detail (goggle lenses, veil openings) must not appear here.
const BACK_DIRECTIONS = new Set(['n', 'ne', 'nw']);
// Small downward nudge so the stamp sits onto the crown, not hovering above it.
const ACCESSORY_TOP_INSET = 1;
const DEFAULT_BACK_CROP = 0.6;
// Per-accessory back-facing crop fraction: how much of the overlay's top rows
// to keep when drawing the back of the head. Face-side detail lives in the
// lower rows, so crop harder for lenses/veils.
const ACCESSORY_BACK_CROP = {
    goggles: 0.5,
    oracleVeil: 0.55,
    mageHood: 0.7,
};

export class Compositor {
    constructor(assetManager) {
        this.assets = assetManager;
    }

    spriteFor(baseSpriteId, paletteKey, paletteVariant, runtimeAccessory, teamTrim = null) {
        const baseId = baseSpriteId?.startsWith('agent.')
            ? baseSpriteId
            : `agent.${baseSpriteId || 'claude'}.base`;
        const palette = paletteKey || baseId.split('.')[1] || 'claude';
        // 4.14: include team trim accent in cache key so team-sashed sprites
        // cache independently from solo agents using the same palette variant.
        const teamHash = teamTrim ? String(teamTrim).toLowerCase() : '_';
        const key = `${baseId}|${palette}|${paletteVariant}|${runtimeAccessory ?? '_'}|${teamHash}`;
        if (cache.has(key)) return cache.get(key);

        const baseImg = this.assets.get(baseId);
        if (!baseImg) return null;
        const dims = this.assets.getDims(baseId);
        const canvas = document.createElement('canvas');
        canvas.width = dims.w;
        canvas.height = dims.h;
        const ctx = canvas.getContext('2d');
        ctx.imageSmoothingEnabled = false;

        ctx.drawImage(baseImg, 0, 0);
        this._applyPaletteSwap(ctx, canvas.width, canvas.height, palette, paletteVariant, teamTrim);
        if (runtimeAccessory) this._compositeAccessory(ctx, baseId, runtimeAccessory, palette);

        cache.set(key, canvas);
        return canvas;
    }

    _applyPaletteSwap(ctx, w, h, provider, variant, teamTrim = null) {
        const palette = this.assets.palettes[provider];
        if (!palette) return;
        const targetRobe = palette.robe[variant % palette.robe.length];
        const targetPants = palette.pants[variant % palette.pants.length];
        // 4.14: when teamTrim is supplied (rgb hex), override the variant-derived
        // trim color so the sash band reads as a team marker. Skip cleanly when
        // teamTrim is null/invalid — the >50% of solo agents see no change.
        const trimOverride = parseTrimColor(teamTrim);
        const targetTrim = trimOverride
            ? rgbToHex(trimOverride)
            : palette.trim[variant % palette.trim.length];
        const sourceRobe = palette.robe[0];
        const sourcePants = palette.pants[0];
        const sourceTrim = palette.trim[0];

        const img = ctx.getImageData(0, 0, w, h);
        const data = img.data;
        const swap = [
            [hexToRgb(sourceRobe), hexToRgb(targetRobe)],
            [hexToRgb(sourcePants), hexToRgb(targetPants)],
            [hexToRgb(sourceTrim), hexToRgb(targetTrim)],
        ];
        // ΔE bucket: tolerate ±12 per channel so painterly anti-aliased pixels
        // also recolor. Without this tolerance, only fully-saturated marker
        // pixels swap and the result looks half-painted.
        const TOL = 12;
        for (let i = 0; i < data.length; i += 4) {
            const r = data[i], g = data[i+1], b = data[i+2], a = data[i+3];
            if (a < 16) continue;
            for (const [src, dst] of swap) {
                if (Math.abs(r - src[0]) <= TOL && Math.abs(g - src[1]) <= TOL && Math.abs(b - src[2]) <= TOL) {
                    data[i]   = Math.max(0, Math.min(255, dst[0] + (r - src[0])));
                    data[i+1] = Math.max(0, Math.min(255, dst[1] + (g - src[1])));
                    data[i+2] = Math.max(0, Math.min(255, dst[2] + (b - src[2])));
                    break;
                }
            }
        }
        ctx.putImageData(img, 0, 0);
    }

    _compositeAccessory(ctx, baseId, accessory, paletteKey) {
        const overlayId = accessory.startsWith?.('overlay.')
            ? accessory
            : `overlay.accessory.${accessory}`;
        const overlayImg = this.assets.get(overlayId);
        if (!overlayImg) return;
        const dims = this.assets.getDims(baseId);
        const cellSize = dims.w / DIRECTIONS.length || DEFAULT_CELL;
        const rows = WALK_FRAMES + IDLE_FRAMES;
        const cols = DIRECTIONS.length;
        if (!Number.isInteger(cellSize) || dims.h < rows * cellSize) return;

        const overlayDims = this.assets.getDims(overlayId);
        const [ax, ay] = this.assets.getAnchor(overlayId);
        const palette = this.assets.palettes?.[paletteKey];
        const { front, back, colBottom } = this._harmonizeOverlay(overlayImg, overlayDims, palette);
        const cropFrac = ACCESSORY_BACK_CROP[accessory] ?? DEFAULT_BACK_CROP;

        // Single composite-time read of the palette-swapped, accessory-free
        // sheet: locates each cell's head apex (D1), records accessory-free
        // content bounds for body draw-scale (D3), and paints the contact
        // shadow (D4) before the overlay is stamped on top.
        const sheet = ctx.getImageData(0, 0, dims.w, dims.h);
        const sdata = sheet.data;
        const width = dims.w;
        const baseBounds = new Map();
        const stamps = [];

        for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
                const cellX = c * cellSize;
                const cellY = r * cellSize;
                const isBack = BACK_DIRECTIONS.has(DIRECTIONS[c]);
                const apex = this._cellHeadApex(sdata, width, cellX, cellY, cellSize);
                baseBounds.set(`${cellX},${cellY},${cellSize},${cellSize}`, apex.bounds);

                const anchorX = apex.found ? apex.centroidX : cellX + Math.floor(cellSize / 2);
                const anchorY = apex.found ? apex.topY + ACCESSORY_TOP_INSET : cellY + Math.floor(cellSize * 0.22);
                const stampX = Math.round(anchorX - ax);
                const stampY = Math.round(anchorY - ay);
                const cropH = isBack ? Math.max(1, Math.round(overlayDims.h * cropFrac)) : overlayDims.h;
                stamps.push({ stampX, stampY, isBack, cropH });

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
            if (s.isBack) {
                // Back of the head: top slice only, nudged +1px down and using
                // the darkened overlay so face-side detail stops showing (D5).
                ctx.drawImage(back, 0, 0, overlayDims.w, s.cropH, s.stampX, s.stampY + 1, overlayDims.w, s.cropH);
            } else {
                ctx.drawImage(front, s.stampX, s.stampY, overlayDims.w, overlayDims.h);
            }
        }

        // Expose accessory-free per-cell content bounds so AgentSprite can scale
        // the body from hat-free measurements (D3). Cached on the canvas, which
        // is itself cached per (base, palette, accessory) tuple.
        ctx.canvas.__cvBaseBounds = baseBounds;
    }

    // Scans one cell of the accessory-free sheet: topmost opaque row, the
    // alpha-weighted centroid X of the top ~6 opaque rows (the head apex the
    // overlay anchors to), and the cell-local content bounds.
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
        if (!found) {
            return { found: false, bounds: { minX: 24, minY: 12, maxX: cellSize - 24, maxY: cellSize - 18 } };
        }
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
            bounds: { minX, minY, maxX, maxY },
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
