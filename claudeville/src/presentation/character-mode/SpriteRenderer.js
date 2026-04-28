// SpriteRenderer is the sole entry point for blitting pixel-art sprites.
// Enforces image-smoothing-off and integer-snapped destinations.

export class SpriteRenderer {
    constructor(assets) {
        this.assets = assets;
    }

    static disableSmoothing(ctx) {
        ctx.imageSmoothingEnabled = false;
        ctx.mozImageSmoothingEnabled = false;
        ctx.webkitImageSmoothingEnabled = false;
    }

    // Draw a sprite anchored at bottom-center of its footprint at world (wx, wy).
    drawSprite(ctx, id, wx, wy, opts = {}) {
        const img = opts.image || this.assets.get(id);
        if (!img) return;
        const dims = opts.dims || this.assets.getDims(id);
        const [ax, ay] = opts.anchor || this.assets.getAnchor(id);
        const dx = Math.round(wx - ax);
        const dy = Math.round(wy - ay);
        if (opts.alpha != null) {
            const prev = ctx.globalAlpha;
            ctx.globalAlpha = prev * opts.alpha;
            ctx.drawImage(img, dx, dy);
            ctx.globalAlpha = prev;
        } else {
            ctx.drawImage(img, dx, dy);
        }
        if (dims) {
            return { dx, dy, w: dims.w, h: dims.h };
        }
    }

    // Per-pixel hit test against a cached alpha mask.
    hitTest(id, mx, my, dx, dy) {
        const mask = this.assets.getMask(id);
        if (!mask) return false;
        const dims = this.assets.getDims(id);
        const lx = Math.floor(mx - dx);
        const ly = Math.floor(my - dy);
        if (lx < 0 || ly < 0 || lx >= dims.w || ly >= dims.h) return false;
        return mask[ly * dims.w + lx] === 1;
    }

    // Draw a 1-px outline using the pre-baked outline canvas from AssetManager.
    // Per Phase 2.5.3: edge detection moved to load time, this is now O(1) per call.
    drawOutline(ctx, id, wx, wy) {
        const outline = this.assets.getOutline(id);
        if (!outline) return;
        const [ax, ay] = this.assets.getAnchor(id);
        const dx = Math.round(wx - ax);
        const dy = Math.round(wy - ay);
        ctx.drawImage(outline, dx, dy);
    }

}
