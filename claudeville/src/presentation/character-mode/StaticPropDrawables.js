import { propDepthDrawable } from './DrawablePass.js';
import { tileToWorld } from './Projection.js';
import { SpriteRenderer } from './SpriteRenderer.js';
import { releaseCanvasBackingStore } from './CanvasBudget.js';

const CACHE_PAD = 8;

// A static world prop (tree, boulder, district prop, wall piece) painted into
// the depth-sorted pass. It sorts at its footprint Y unless the caller passes an
// explicit `sortY`. A tall prop can `splitForOcclusion` into a back and a front
// half so a villager can stand between them. A long prop can instead carry
// `occlusionColumns` (see `lineOcclusionColumns`): vertical slices of one
// cached image, each sorted on its own. A prop may also paint its own GPU
// channels (`channels: { occluder?, emissive? }`, each a drawFn in the same
// world transform): the cache then carries matching canvases, which the
// resident record binds as its occluder (a 2.3 surface channel) and emissive
// maps (GpuSceneBuilder `recordForProp`).
export class StaticPropSprite {
    constructor({ tileX, tileY, drawFn, id = null, bounds = null, splitForOcclusion = false, sortY = null, occlusionColumns = null, channels = null, materialClass = null }) {
        this.tileX = tileX;
        this.tileY = tileY;
        const world = tileToWorld(tileX, tileY);
        this.x = world.x;
        this.y = world.y;
        // `Number(null)` is 0, so only a real finite number overrides the
        // footprint Y; coercing the default would sort every prop at world 0.
        this.sortY = Number.isFinite(sortY) ? sortY : this.y;
        this.drawFn = drawFn;
        this.id = id;
        this.bounds = bounds || { left: -32, right: 32, top: -64, bottom: 12, splitY: -18 };
        this.splitForOcclusion = splitForOcclusion;
        this.occlusionColumns = occlusionColumns?.length ? occlusionColumns : null;
        this.channels = channels;
        if (materialClass) this.materialClass = materialClass;
        this._cacheCanvas = null;
        this._gpuCacheRevision = 0;
    }
    draw(ctx, zoom) {
        this.drawFn(ctx, this.x, this.y, zoom);
    }
    drawPart(ctx, part, zoom, column = null) {
        // Columns always slice the cached image: redrawing the whole prop once
        // per slice would multiply its paint cost by the column count.
        if (part === 'column') {
            this.drawCachedPart(ctx, part, zoom, column);
            return;
        }
        if (!this.splitForOcclusion || part === 'whole') {
            this.draw(ctx, zoom);
            return;
        }
        ctx.save();
        if (this._clipPart(ctx, part)) this.draw(ctx, zoom);
        ctx.restore();
    }
    drawCached(ctx, zoom) {
        const cached = this._getCachedCanvas(zoom);
        if (!cached) {
            this.draw(ctx, zoom);
            return;
        }
        ctx.drawImage(cached.canvas, cached.x, cached.y);
    }
    drawCachedPart(ctx, part, zoom, column = null) {
        if (part === 'column') {
            this._drawColumn(ctx, column, zoom);
            return;
        }
        if (!this.splitForOcclusion || part === 'whole') {
            this.drawCached(ctx, zoom);
            return;
        }
        ctx.save();
        if (this._clipPart(ctx, part)) this.drawCached(ctx, zoom);
        ctx.restore();
    }
    // Integer source span of one column inside the cached canvas; shared with
    // the GPU record builder so both backends cut identical slices.
    columnSourceSpan(column, cached) {
        const width = cached.canvas.width;
        const start = Math.max(0, Math.min(width, Math.round(this.x + column.left) - cached.x));
        const end = Math.max(start, Math.min(width, Math.round(this.x + column.right) - cached.x));
        return { sx: start, sw: end - start };
    }
    _drawColumn(ctx, column, zoom) {
        if (!column) return;
        const cached = this._getCachedCanvas(zoom);
        if (cached) {
            const { sx, sw } = this.columnSourceSpan(column, cached);
            if (sw <= 0) return;
            const height = cached.canvas.height;
            ctx.drawImage(cached.canvas, sx, 0, sw, height, cached.x + sx, cached.y, sw, height);
            return;
        }
        const { left, right, top, bottom } = this.bounds;
        const x0 = Math.round(this.x + Math.max(column.left, left - CACHE_PAD));
        const x1 = Math.round(this.x + Math.min(column.right, right + CACHE_PAD));
        if (x1 <= x0) return;
        ctx.save();
        ctx.beginPath();
        ctx.rect(x0, Math.floor(this.y + top) - CACHE_PAD, x1 - x0, Math.ceil(bottom - top) + CACHE_PAD * 2);
        ctx.clip();
        this.draw(ctx, zoom);
        ctx.restore();
    }
    _clipPart(ctx, part) {
        const { left, right, top, bottom, splitY } = this.bounds;
        const clipTop = part === 'back' ? top : splitY;
        const clipBottom = part === 'back' ? splitY : bottom;
        if (clipBottom <= clipTop) return false;
        ctx.beginPath();
        ctx.rect(
            Math.floor(this.x + left) - 2,
            Math.floor(this.y + clipTop) - 2,
            Math.ceil(right - left) + 4,
            Math.ceil(clipBottom - clipTop) + 4
        );
        ctx.clip();
        return true;
    }
    _getCachedCanvas(zoom) {
        if (this._cacheCanvas) return this._cacheCanvas;
        if (typeof document === 'undefined') return null;
        const { left, right, top, bottom } = this.bounds;
        const width = Math.max(1, Math.ceil(right - left + CACHE_PAD * 2));
        const height = Math.max(1, Math.ceil(bottom - top + CACHE_PAD * 2));
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (!ctx) return null;
        const originX = -(this.x + left - CACHE_PAD);
        const originY = -(this.y + top - CACHE_PAD);
        SpriteRenderer.disableSmoothing(ctx);
        ctx.translate(originX, originY);
        this.drawFn(ctx, this.x, this.y, zoom);
        this._cacheCanvas = {
            canvas,
            x: Math.floor(this.x + left - CACHE_PAD),
            y: Math.floor(this.y + top - CACHE_PAD),
        };
        for (const [name, paint] of Object.entries(this.channels || {})) {
            if (typeof paint !== 'function') continue;
            const channel = document.createElement('canvas');
            channel.width = width;
            channel.height = height;
            const channelCtx = channel.getContext('2d');
            if (!channelCtx) continue;
            SpriteRenderer.disableSmoothing(channelCtx);
            channelCtx.translate(originX, originY);
            paint(channelCtx, this.x, this.y, zoom);
            this._cacheCanvas[name] = channel;
        }
        return this._cacheCanvas;
    }
    releaseCache() {
        releaseCanvasBackingStore(this._cacheCanvas?.canvas);
        for (const name of Object.keys(this.channels || {})) releaseCanvasBackingStore(this._cacheCanvas?.[name]);
        this._cacheCanvas = null;
    }
    // The drawn state changed (e.g. the gate doors): repaint the cache on the
    // next draw and make the GPU backend re-upload its texture.
    invalidateCache() {
        this.releaseCache();
        this._gpuCacheRevision++;
    }
    propBackSortY() {
        return this.sortY + Math.min(-8, this.bounds.splitY);
    }
    propFrontSortY() {
        return this.sortY + Math.max(0, this.bounds.bottom * 0.25);
    }
}

// Vertical screen slices, `width` px wide, across the local span [left, right]
// of a prop whose footprint is a straight world line through its origin. Each
// slice sorts at the line's world Y under the slice centre (`originY + slope *
// centreX`), so an object standing behind the line at that screen x paints
// first and one in front of it paints after. A single sortY cannot say that
// for a prop many tiles long: its two ends sit at very different depths. The
// outer slices are open-ended so the cache padding is never cut off.
export function lineOcclusionColumns({ left, right, width, originY, slope }) {
    const count = Math.max(1, Math.ceil((right - left) / width));
    const columns = [];
    for (let index = 0; index < count; index++) {
        const start = left + index * width;
        const end = Math.min(right, start + width);
        columns.push({
            index,
            left: index === 0 ? -Infinity : start,
            right: index === count - 1 ? Infinity : end,
            sortY: originY + slope * ((start + end) / 2),
        });
    }
    return columns;
}

export function buildStaticPropDrawables(...spriteGroups) {
    const drawables = [];
    for (const group of spriteGroups) {
        for (const sprite of group || []) {
            if (sprite.occlusionColumns) {
                for (const column of sprite.occlusionColumns) {
                    drawables.push(propDepthDrawable(sprite, 'column', column));
                }
            } else if (sprite.splitForOcclusion) {
                drawables.push(propDepthDrawable(sprite, 'back'));
                drawables.push(propDepthDrawable(sprite, 'front'));
            } else {
                drawables.push(propDepthDrawable(sprite));
            }
        }
    }
    return drawables;
}
