// Living Isle W8.5b (AD-P10) — the isle landmarks: the windmill and the
// Hourglass Belfry (DISTRICT_PROPS `landmark`; the wayside chapel was
// withdrawn).
//
// They are not places: no occupancy, label, gate or session reading of any
// kind (V3). Each is a sorted StaticPropSprite (tall, among the trees) whose
// placement carries `walkBlock`, so no body ever stands on or behind one. The
// windmill is scenery and moves from the environment only; the belfry is the
// account instrument and reads the account quota alone:
//
// - The windmill's sails (`prop.windmillSails`, 8 frames of the cross turned
//   11.25° a step, MB-7) advance one frame per 125 ms (8 fps, the `slow`
//   ambient band; one turn per 4 s as before) only while a gust of the one
//   wind field (`Wind.windAt`) crosses the mill; calm air holds the frame they stopped on, and reduced motion
//   (`motionScale <= 0`) holds frame 0. Each frame is one cached composite of
//   the tower and its sails, shared by the Canvas and GPU paths
//   (`textureKey` per frame, like a tree's lean frame).
// - The Hourglass Belfry (2026-10-28, where the ruined tower stood; it now
//   stands on the Archive's north lawn, the chapel's old place) holds one
//   glass per account, Claude's in the lit west arch and Codex's in the
//   shaded east arch: the sand left is the quota left (BelfryQuota.js, from
//   `/api/usage` through `setUsage`), a shroud covers a glass with no reading,
//   and a lavender cord marks Codex at its limit. Each glass is one cell of
//   `prop.hourglassBelfryGlass` laid on the base; a change swaps cells whole
//   and repaints the cache once (static band). A rise of a known level is a
//   window reset: that glass shows the C4 cream frame for 150 ms, then its
//   sand climbs one level per 150 ms step to the new reading (at most 750 ms,
//   the `medium` band); reduced motion swaps at once. MB-5 — while an
//   account spends (its reading rose within the last 10 minutes,
//   `belfryDraining`), its glass's one-texel sand stream steps down through
//   BELFRY_STREAM_PHASES baked phases at 2 fps (the `slow` band), each step
//   one repaint of the cache; reduced motion keeps today's static stream.
//   Hovering it reads out both accounts' windows (`belfryTooltip`). It never
//   reads a villager.

import { StaticPropSprite } from './StaticPropDrawables.js';
import { SpriteRenderer } from './SpriteRenderer.js';
import { baseWindX, windAt } from './Wind.js';
import { DISTRICT_PROPS } from '../../config/scenery.js';
import {
    BELFRY_ACCOUNTS,
    BELFRY_LEVELS,
    belfryDrainStep,
    belfryDraining,
    belfryGlassKey,
    belfryGlasses,
    belfryTooltip,
} from './BelfryQuota.js';

export const WINDMILL_SAIL_HUB = Object.freeze([50, 86]); // windmill base-local px
// The belfry's glass strip (scripts/sprites/bake-hourglass-belfry.mjs): one
// cell per state per glass, Claude's glass first, each laid on its glass at
// its base-local origin; then (MB-5) the running-stream cells, per glass and
// per level l1–l5, BELFRY_STREAM_PHASES phases each (`belfryStreamCell`).
export const BELFRY_GLASS_STATES = Object.freeze(['l0', 'l1', 'l2', 'l3', 'l4', 'l5', 'limit', 'unknown', 'peak']);
export const BELFRY_STREAM_PHASES = 3;
export const BELFRY_GLASS_FRAME = Object.freeze([20, 38]);
export const BELFRY_GLASS_ORIGINS = Object.freeze({ claude: Object.freeze([38, 95]), codex: Object.freeze([70, 95]) });
const BELFRY_ID = 'prop.hourglassBelfry';
const BELFRY_GLASS_ID = 'prop.hourglassBelfryGlass';
const BELFRY_PEAK_MS = 150;
const BELFRY_STEP_MS = 150;
const BELFRY_STREAM_STEP_MS = 500; // 2 fps
const SAIL_FRAMES = 8;
const SAIL_FRAME_PX = 112;
const SAIL_STEP_MS = 125;
const SAIL_CALM = 0.15; // knot wind below this is still air (pennants rest too)

const LANDMARK_PROPS = Object.freeze(DISTRICT_PROPS.filter((prop) => prop.landmark));

function boundsFor(assets, id, extraLeft = 0) {
    const dims = assets?.getDims?.(id) || { w: 64, h: 64 };
    const [ax, ay] = assets?.getAnchor?.(id) || [dims.w / 2, dims.h];
    return {
        left: -ax - extraLeft,
        right: dims.w - ax,
        top: -ay,
        bottom: dims.h - ay,
        // The split sits half a tile behind the footing: bodies never reach
        // a landmark (walkBlock), so this only orders the trees around it.
        splitY: -16,
    };
}

class WindmillSprite extends StaticPropSprite {
    constructor(host, prop) {
        super({
            tileX: prop.tileX,
            tileY: prop.tileY,
            id: prop.id,
            bounds: boundsFor(host.assets, prop.id, 8),
            splitForOcclusion: true,
            materialClass: 'stone',
            drawFn: (ctx, x, y) => this._paint(ctx, x, y, this._paintFrame),
        });
        this.host = host;
        this._paintFrame = 0;
        this._sailFrame = 0;
        this._sailStepAt = -Infinity;
        this._wind = { x: 0, gust: 0 };
        this._frames = new Array(SAIL_FRAMES).fill(null);
    }

    /** The sail frame now: gust-stepped, calm-held, frame 0 under reduced motion. */
    sailFrame() {
        const host = this.host;
        if (!((host.motionScale ?? 1) > 0)) return 0;
        const weather = host._lastAtmosphere?.weather;
        if (Math.abs(baseWindX(weather)) < SAIL_CALM) return this._sailFrame;
        const t = host.motionTimeMs || 0;
        if (t < this._sailStepAt) this._sailStepAt = -Infinity; // clock reset
        if (t - this._sailStepAt >= SAIL_STEP_MS && windAt(this.x, this.y, t, weather, this._wind).gust > 0) {
            this._sailFrame = (this._sailFrame + 1) % SAIL_FRAMES;
            this._sailStepAt = t;
        }
        return this._sailFrame;
    }

    draw(ctx) {
        const frame = this._getCachedCanvas();
        if (!frame) {
            this._paint(ctx, this.x, this.y, this.sailFrame());
            return;
        }
        ctx.save();
        SpriteRenderer.disableSmoothing(ctx);
        ctx.drawImage(frame.canvas, frame.x, frame.y);
        ctx.restore();
    }

    _getCachedCanvas(zoom) {
        const f = this.sailFrame();
        if (this._frames[f]) return this._frames[f];
        if (!this.host.assets?.get?.('prop.windmillSails')) return null;
        this._paintFrame = f;
        this._cacheCanvas = null;
        const cached = super._getCachedCanvas(zoom);
        this._cacheCanvas = null;
        if (!cached) return null;
        cached.textureKey = `prop.windmill:${this.tileX},${this.tileY}:sails${f}`;
        this._frames[f] = cached;
        return cached;
    }

    _paint(ctx, x, y, frame) {
        const host = this.host;
        host._drawPropContactShadow?.(ctx, x, y, this.id, this.tileX, this.tileY);
        host.sprites?.drawSprite(ctx, this.id, x, y);
        const sails = host.assets?.get?.('prop.windmillSails');
        if (!sails) return;
        const [ax, ay] = host.assets.getAnchor(this.id);
        const ox = Math.round(x) - ax + WINDMILL_SAIL_HUB[0] - SAIL_FRAME_PX / 2;
        const oy = Math.round(y) - ay + WINDMILL_SAIL_HUB[1] - SAIL_FRAME_PX / 2;
        ctx.drawImage(sails, frame * SAIL_FRAME_PX, 0, SAIL_FRAME_PX, SAIL_FRAME_PX, ox, oy, SAIL_FRAME_PX, SAIL_FRAME_PX);
    }

    releaseCache() {
        super.releaseCache();
        this._frames = new Array(SAIL_FRAMES).fill(null);
    }
}

// A glass key's sand level; `limit` is the spent glass, `unknown` has none.
function keyLevel(key) {
    if (key === 'limit') return 0;
    return /^l\d$/.test(key) ? Number(key.slice(1)) : null;
}

/** MB-5 — the strip cell of a glass's running stream: after every state cell, per glass, level and phase. */
export function belfryStreamCell(account, level, phase) {
    const glass = BELFRY_ACCOUNTS.indexOf(account);
    return BELFRY_ACCOUNTS.length * BELFRY_GLASS_STATES.length
        + (glass * BELFRY_LEVELS + level - 1) * BELFRY_STREAM_PHASES + phase;
}

class BelfrySprite extends StaticPropSprite {
    constructor(host, prop, glasses) {
        super({
            tileX: prop.tileX,
            tileY: prop.tileY,
            id: prop.id,
            bounds: boundsFor(host.assets, prop.id),
            splitForOcclusion: true,
            materialClass: 'stone',
            drawFn: (ctx, x, y) => this._paint(ctx, x, y),
        });
        this.host = host;
        this._targets = { claude: 'unknown', codex: 'unknown' };
        this._moments = { claude: null, codex: null };
        this._shown = { claude: 'unknown', codex: 'unknown' };
        this._shownPhase = { claude: null, codex: null };
        this._drain = null;
        this.setGlasses(glasses);
    }

    /** MB-5 — the drain record (`belfryDrainStep`) the streams run on. */
    setDrain(drain) {
        this._drain = drain || null;
    }

    /**
     * MB-5 — a glass's running-stream phase now, or null: its account drains,
     * sand remains (`l1`–`l5`, no reset moment playing) and motion is on.
     */
    streamPhase(account, now = Date.now()) {
        if (!((this.host.motionScale ?? 1) > 0) || this._moments[account]) return null;
        if (!(keyLevel(this._targets[account]) > 0) || !belfryDraining(this._drain, account, now)) return null;
        return Math.floor((this.host.motionTimeMs || 0) / BELFRY_STREAM_STEP_MS) % BELFRY_STREAM_PHASES;
    }

    /**
     * New readings; true when a glass changed. A known level that rises is a
     * window reset: that glass refills once.
     */
    setGlasses(glasses) {
        const motion = (this.host.motionScale ?? 1) > 0;
        let changed = false;
        for (const account of BELFRY_ACCOUNTS) {
            const key = belfryGlassKey(glasses?.[account]);
            if (key === this._targets[account]) continue;
            const from = keyLevel(this._targets[account]);
            const to = keyLevel(key);
            this._moments[account] = motion && from !== null && to !== null && to > from
                ? { from, to, at: this.host.motionTimeMs || 0 }
                : null;
            this._targets[account] = key;
            changed = true;
        }
        return changed;
    }

    /** One glass's cell now: its reading, or the step of its reset moment. */
    glassKey(account) {
        const moment = this._moments[account];
        if (!moment) return this._targets[account];
        const t = (this.host.motionTimeMs || 0) - moment.at;
        const level = moment.from + 1 + Math.floor((t - BELFRY_PEAK_MS) / BELFRY_STEP_MS);
        if (!((this.host.motionScale ?? 1) > 0) || t < 0 || level >= moment.to) {
            this._moments[account] = null;
            return this._targets[account];
        }
        return t < BELFRY_PEAK_MS ? 'peak' : `l${level}`;
    }

    draw(ctx) {
        const cached = this._getCachedCanvas();
        if (!cached) {
            this._paint(ctx, this.x, this.y);
            return;
        }
        ctx.save();
        SpriteRenderer.disableSmoothing(ctx);
        ctx.drawImage(cached.canvas, cached.x, cached.y);
        ctx.restore();
    }

    // The cache holds the cells it was painted with; a new cell repaints it
    // and makes the GPU backend re-upload (invalidateCache). Until the strip
    // loads there is no cache, and a draw shows the base alone.
    _getCachedCanvas(zoom) {
        if (!this.host.assets?.get?.(BELFRY_GLASS_ID)) return null;
        let changed = false;
        for (const account of BELFRY_ACCOUNTS) {
            const key = this.glassKey(account);
            const phase = this.streamPhase(account);
            if (key === this._shown[account] && phase === this._shownPhase[account]) continue;
            this._shown[account] = key;
            this._shownPhase[account] = phase;
            changed = true;
        }
        if (changed && this._cacheCanvas) this.invalidateCache();
        return super._getCachedCanvas(zoom);
    }

    _paint(ctx, x, y) {
        const host = this.host;
        host._drawPropContactShadow?.(ctx, x, y, this.id, this.tileX, this.tileY);
        host.sprites?.drawSprite(ctx, this.id, x, y);
        const glass = host.assets?.get?.(BELFRY_GLASS_ID);
        if (!glass) return;
        const [ax, ay] = host.assets.getAnchor(this.id);
        const [fw, fh] = BELFRY_GLASS_FRAME;
        BELFRY_ACCOUNTS.forEach((account, index) => {
            const phase = this._shownPhase[account];
            const cell = phase === null
                ? index * BELFRY_GLASS_STATES.length + BELFRY_GLASS_STATES.indexOf(this._shown[account])
                : belfryStreamCell(account, keyLevel(this._shown[account]), phase);
            const [ox, oy] = BELFRY_GLASS_ORIGINS[account];
            ctx.drawImage(glass, cell * fw, 0, fw, fh, Math.round(x) - ax + ox, Math.round(y) - ay + oy, fw, fh);
        });
    }
}

function plainSprite(host, prop) {
    return new StaticPropSprite({
        tileX: prop.tileX,
        tileY: prop.tileY,
        id: prop.id,
        bounds: boundsFor(host.assets, prop.id),
        splitForOcclusion: true,
        materialClass: 'stone',
        drawFn: (ctx, x, y) => {
            host._drawPropContactShadow?.(ctx, x, y, prop.id, prop.tileX, prop.tileY);
            host.sprites?.drawSprite(ctx, prop.id, x, y);
        },
    });
}

export class IsleLandmarks {
    constructor(host) {
        this.host = host;
        this._belfry = { sprite: null, usage: null, glasses: belfryGlasses(null), drain: null, opaque: null };
    }

    /** One sorted sprite per landmark placement; built with the district props. */
    buildSprites() {
        const out = [];
        for (const prop of LANDMARK_PROPS) {
            if (prop.id === 'prop.windmill') out.push(new WindmillSprite(this.host, prop));
            else if (prop.id === BELFRY_ID) {
                this._belfry.sprite = new BelfrySprite(this.host, prop, this._belfry.glasses);
                this._belfry.sprite.setDrain(this._belfry.drain);
                out.push(this._belfry.sprite);
            } else out.push(plainSprite(this.host, prop));
        }
        return out;
    }

    /** The account quota from `/api/usage` (IsometricRenderer.setQuotaState), received at `now`. */
    setUsage(usage, now = Date.now()) {
        const belfry = this._belfry;
        belfry.usage = usage || null;
        belfry.glasses = belfryGlasses(belfry.usage);
        belfry.drain = belfryDrainStep(belfry.drain, belfry.glasses, now);
        belfry.sprite?.setDrain(belfry.drain);
        // A still world (reduced motion) skips idle paints: a new reading asks for one.
        if (belfry.sprite?.setGlasses(belfry.glasses)) this.host._invalidateIdleFrame?.();
    }

    /** The belfry when world point (x, y) lies on one of its opaque texels, else null. */
    hitTestBelfry(worldX, worldY) {
        const sprite = this._belfry.sprite;
        const assets = this.host.assets;
        const image = assets?.get?.(BELFRY_ID);
        if (!sprite || !image) return null;
        const [ax, ay] = assets.getAnchor(BELFRY_ID);
        const x = Math.floor(worldX - (Math.round(sprite.x) - ax));
        const y = Math.floor(worldY - (Math.round(sprite.y) - ay));
        if (x < 0 || y < 0 || x >= image.width || y >= image.height) return null;
        const opaque = this._belfryOpaque(image);
        return !opaque || opaque[y * image.width + x] ? sprite : null;
    }

    /** The belfry's hover text: both accounts' windows, at `now`. */
    belfryTooltip(now = Date.now()) {
        return belfryTooltip(this._belfry.usage, now);
    }

    // The base's alpha, read once (a box test where no canvas exists).
    _belfryOpaque(image) {
        const belfry = this._belfry;
        if (belfry.opaque || typeof document === 'undefined') return belfry.opaque;
        const canvas = document.createElement('canvas');
        canvas.width = image.width;
        canvas.height = image.height;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) return null;
        ctx.drawImage(image, 0, 0);
        const data = ctx.getImageData(0, 0, image.width, image.height).data;
        belfry.opaque = new Uint8Array(image.width * image.height);
        for (let i = 0; i < belfry.opaque.length; i++) belfry.opaque[i] = data[i * 4 + 3] > 0 ? 1 : 0;
        return belfry.opaque;
    }
}
