import { SpriteRenderer } from './SpriteRenderer.js';
import { canvasMapPixelCount, releaseCanvasMap } from './CanvasBudget.js';

// Tree sprites are drawn at 1× (contract C3: one pixel grid). The PNGs are
// plinth-free since the foliage pass (`scripts/sprites/foliage-pass.mjs`);
// `height` is the trunk-base row + 1, so the cache crops the empty rows below
// the roots and the anchor sits on the lowest root pixel. Three species × two
// sizes caps the cache at six canvases.
const TREE_SPRITES = Object.freeze({
    'oak.large': { id: 'veg.tree.oak.large', width: 64, height: 51 },
    'oak.small': { id: 'veg.tree.oak.small', width: 32, height: 28 },
    'pine.large': { id: 'veg.tree.pine.large', width: 64, height: 52 },
    'willow.large': { id: 'veg.tree.willow.large', width: 64, height: 53 },
    'willow.small': { id: 'veg.tree.willow.small', width: 32, height: 27 },
});
const TREE_SPECIES = Object.freeze(['oak', 'pine', 'willow']);

// Resolve a tree record to a sprite key. The small pine sheet is a snow-tipped
// winter sprite, so pines always use the large sheet.
function treeSpriteKey(tree) {
    const species = TREE_SPECIES.includes(tree?.species) ? tree.species : 'oak';
    const size = tree?.size === 'small' && species !== 'pine' ? 'small' : 'large';
    return `${species}.${size}`;
}

// Owns fantasy-tree caches and foliage drawing. The host supplies only the
// live atmosphere and motion values shared with the world frame.
export class FoliageRenderer {
    constructor(host) {
        this.host = host;
        this.cache = new Map();
    }

    clear() {
        this.releaseCache();
    }

    releaseCache() {
        releaseCanvasMap(this.cache);
    }

    getRetainedPixels() {
        return canvasMapPixelCount(this.cache);
    }

    get cacheSize() {
        return this.cache.size;
    }

    fantasyTreePropBounds(tree) {
        const cached = this._getFantasyForestTreeCache(tree);
        return {
            left: -cached.anchorX,
            right: cached.canvas.width - cached.anchorX,
            top: -cached.anchorY,
            bottom: cached.canvas.height - cached.anchorY,
            splitY: -cached.anchorY + Math.round(cached.canvas.height * 0.58),
        };
    }

    // Deterministic per-tree phase for wind sway. Mixes tile position and
    // species into [0, 2π) so neighbouring trees don't pulse in lockstep.
    windSwaySeed(tree) {
        const tx = Number(tree?.tileX) || 0;
        const ty = Number(tree?.tileY) || 0;
        const species = Math.max(0, TREE_SPECIES.indexOf(tree?.species));
        const n = Math.sin(tx * 12.9898 + ty * 78.233 + species * 7.131) * 43758.5453;
        return (n - Math.floor(n)) * Math.PI * 2;
    }

    // Apply a small horizontal offset to a tree drawFn based on the current
    // atmosphere wind. Clamped to ±2 px so pixel-art sprites do not shimmer;
    // skipped under reduced motion (motionScale === 0).
    withTreeSway(ctx, seed, drawFn, tileX = 0) {
        if (typeof drawFn !== 'function') return;
        const motionScale = this.host.motionScale ?? 1;
        const windX = Number(this.host._lastAtmosphere?.motion?.windX) || 0;
        if (motionScale <= 0 || windX === 0) {
            drawFn();
            return;
        }
        const t = (this.host.motionTimeMs || 0) * 0.001;
        // Spatially-phased gust envelope: wind crosses the forest in slow
        // travelling waves (tileX phase offset) so neighbouring canopies crest a
        // beat apart instead of swaying in lockstep. The whole sprite still moves
        // as one unit — the closure-based drawFn can't be cleanly split into
        // canopy vs trunk without doubling per-tree draw cost — so this stays the
        // gust-modulated whole-sprite fallback the motion budget prefers.
        const gust = 0.4 + 0.6 * Math.sin(t * 0.13 + tileX * 0.05);
        let dx = Math.sin(t + seed) * windX * 1.5 * gust;
        if (dx > 2) dx = 2;
        else if (dx < -2) dx = -2;
        const offset = Math.round(dx);
        if (offset === 0) {
            drawFn();
            return;
        }
        ctx.save();
        ctx.translate(offset, 0);
        drawFn();
        ctx.restore();
    }

    drawFantasyForestTree(ctx, x, y, tree) {
        const cached = this._getFantasyForestTreeCache(tree);
        ctx.save();
        SpriteRenderer.disableSmoothing(ctx);
        ctx.drawImage(
            cached.canvas,
            Math.round(x - cached.anchorX),
            Math.round(y - cached.anchorY)
        );
        ctx.restore();
    }

    _getFantasyForestTreeCache(tree) {
        const key = treeSpriteKey(tree);
        const existing = this.cache.get(key);
        if (existing) return existing;

        const sprite = TREE_SPRITES[key];
        const canvas = document.createElement('canvas');
        canvas.width = sprite.width;
        canvas.height = sprite.height;
        const ctx = canvas.getContext('2d');
        SpriteRenderer.disableSmoothing(ctx);
        const source = this.host.assets.get(sprite.id);
        if (source) ctx.drawImage(source, 0, 0, sprite.width, sprite.height, 0, 0, sprite.width, sprite.height);
        const cached = { canvas, anchorX: sprite.width / 2, anchorY: sprite.height - 1 };
        if (source) this.cache.set(key, cached);
        return cached;
    }
}
