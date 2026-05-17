import { DEFAULT_CELL, DIRECTIONS, WALK_FRAMES, IDLE_FRAMES } from './SpriteSheet.js';

// Compositor produces per-agent character bitmaps by:
// 1. selecting a model/provider base sheet,
// 2. palette-swapping it using palettes.yaml,
// 3. compositing an allowed runtime effort/accessory overlay over the head pixels.
// Result is cached per (base sprite, paletteVariant, runtimeAccessory) tuple.

const cache = new Map();

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
        if (runtimeAccessory) this._compositeAccessory(ctx, baseId, runtimeAccessory);

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

    _compositeAccessory(ctx, baseId, accessory) {
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
        for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
                const headAnchorX = c * cellSize + Math.floor(cellSize / 2);
                const headAnchorY = r * cellSize + Math.floor(cellSize * 0.22);
                ctx.drawImage(
                    overlayImg,
                    Math.round(headAnchorX - ax),
                    Math.round(headAnchorY - ay),
                    overlayDims.w,
                    overlayDims.h
                );
            }
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
