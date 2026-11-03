// BI-6 — reeds bow as a gust crosses.
//
// The lake- and river-edge reed and cattail clumps (scenery.js DISTRICT_PROPS
// `layer: 'live'`: the same ids and placements the terrain bake carried until
// 2026-11) are StaticPropSprites that paint ahead of every sorted drawable
// (REED_SORT_Y, the ground records' far depth plane on the resident path), so
// they keep the bake's layering: under every building (the reed behind
// Command's dome stays hidden by it), tree, body and raindrop. Each holds at
// most three cached frames: upright (0, its authored art with its contact
// shadow, which the winter state repaints like any flora prop) and bowed one
// texel either way, sheared from it by the tree lean frames' own
// `leanFrameImage` with the bottom half planted. A clump re-reads the one wind (`Wind.windAt`) at its
// own foot once per REED_STEP_MS (4 Hz, the ambient `slow` band) and bows one
// texel downwind while a gust crosses it, so a gust front walks along the
// bank clump by clump; between gusts and in still air (|windX| below
// REED_CALM, fog) it stands upright, and reduced motion holds frame 0.
//
// Cost: no loop of its own. A clump is evaluated only when the depth pass
// draws it (both backends read `_getCachedCanvas`, the GPU record keyed per
// frame like the windmill's sails), with one `windAt` per clump per step.

import { DISTRICT_PROPS } from '../../config/scenery.js';
import { releaseCanvasBackingStore } from './CanvasBudget.js';
import { leanFrameImage } from './FoliageRenderer.js';
import { SpriteRenderer } from './SpriteRenderer.js';
import { StaticPropSprite } from './StaticPropDrawables.js';
import { baseWindX, windAt } from './Wind.js';

export const REED_LAYER = 'live';
export const REED_STEP_MS = 250;
// Below this knot wind the reeds stand still (the trees' and the mill's calm).
export const REED_CALM = 0.15;
const REED_PLANTED = 0.5;
// Below GPU_DEPTH_SORT_Y_MIN (depth key 0) and every painter sortY.
export const REED_SORT_Y = -1e5;
// `leanFrameImage` pads its frames by this many px on both sides.
const LEAN_PAD = 2;

export const REED_PROPS = Object.freeze(DISTRICT_PROPS.filter((prop) => prop.layer === REED_LAYER));

/**
 * The frame a clump shows (−1, 0 or 1 texels at its tip) for the knot wind
 * `windX`, the gust `gust` at its foot and the motion scale: one texel
 * downwind while a gust crosses it, else upright; upright in still air and
 * under reduced motion.
 */
export function reedBowFrame(windX, gust, motionScale = 1) {
    const wind = Number(windX) || 0;
    if (!(Number(motionScale) > 0) || Math.abs(wind) < REED_CALM || !(Number(gust) > 0)) return 0;
    return wind < 0 ? -1 : 1;
}

class ReedClumpSprite extends StaticPropSprite {
    constructor(host, prop) {
        super({
            tileX: prop.tileX,
            tileY: prop.tileY,
            id: prop.id,
            bounds: host._assetPropBounds(prop.id),
            sortY: REED_SORT_Y,
            materialClass: 'foliage',
            drawFn: (ctx, x, y) => {
                host._drawPropContactShadow?.(ctx, x, y, prop.id, prop.tileX, prop.tileY);
                host.sprites?.drawSprite(ctx, prop.id, x, y, host._winterPropOpts?.(prop.id));
            },
        });
        this.host = host;
        this._bow = 0;
        this._stepAt = -Infinity;
        this._wind = { x: 0, gust: 0 };
        this._bowed = new Map();
    }

    /** The frame now: re-read on REED_STEP_MS steps, 0 under reduced motion. */
    bowFrame() {
        const host = this.host;
        const motionScale = host.motionScale ?? 1;
        const weather = host._lastAtmosphere?.weather;
        const windX = baseWindX(weather);
        if (!(motionScale > 0) || Math.abs(windX) < REED_CALM) {
            this._bow = 0;
            return 0;
        }
        const t = host.motionTimeMs || 0;
        if (t < this._stepAt) this._stepAt = -Infinity; // clock reset
        if (t - this._stepAt >= REED_STEP_MS) {
            this._stepAt = t;
            this._bow = reedBowFrame(windX, windAt(this.x, this.y, t, weather, this._wind).gust, motionScale);
        }
        return this._bow;
    }

    draw(ctx) {
        const frame = this._getCachedCanvas();
        if (!frame) {
            this.drawFn(ctx, this.x, this.y);
            return;
        }
        ctx.save();
        SpriteRenderer.disableSmoothing(ctx);
        ctx.drawImage(frame.canvas, frame.x, frame.y);
        ctx.restore();
    }

    _getCachedCanvas(zoom) {
        // Never cache a frame painted before the clump's sheet has loaded.
        if (!this._cacheCanvas && !this.host.assets?.get?.(this.id)) return null;
        const upright = super._getCachedCanvas(zoom);
        if (!upright) return null;
        upright.textureKey ||= `prop.reed:${this.tileX},${this.tileY}:bow0`;
        const frame = this.bowFrame();
        if (!frame) return upright;
        const hit = this._bowed.get(frame);
        if (hit) return hit;
        const { width, height } = upright.canvas;
        const pixels = upright.canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, width, height);
        const lean = leanFrameImage(pixels.data, width, height, frame, REED_PLANTED);
        const canvas = document.createElement('canvas');
        canvas.width = lean.width;
        canvas.height = lean.height;
        const ctx = canvas.getContext('2d');
        const image = ctx.createImageData(lean.width, lean.height);
        image.data.set(lean.data);
        ctx.putImageData(image, 0, 0);
        const bowed = {
            canvas,
            x: upright.x - LEAN_PAD,
            y: upright.y,
            textureKey: `prop.reed:${this.tileX},${this.tileY}:bow${frame}`,
        };
        this._bowed.set(frame, bowed);
        return bowed;
    }

    // A winter step repaints the upright frame; the bowed ones shear from it.
    releaseCache() {
        super.releaseCache();
        for (const bowed of this._bowed.values()) releaseCanvasBackingStore(bowed.canvas);
        this._bowed.clear();
    }
}

/** The live reed and cattail clumps for the renderer's depth pass. */
export function buildReedSprites(host) {
    return REED_PROPS.map((prop) => new ReedClumpSprite(host, prop));
}
