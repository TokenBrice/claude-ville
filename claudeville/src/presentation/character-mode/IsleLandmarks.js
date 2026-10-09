// Living Isle W8.5b (AD-P10) — the four non-semantic landmarks: windmill,
// watermill, wayside chapel and ruined tower (DISTRICT_PROPS `landmark`).
//
// They are scenery, not places: no occupancy, label, gate or session reading
// of any kind (V3). Each is a sorted StaticPropSprite (tall, among the trees)
// whose placement carries `walkBlock`, so no body ever stands on or behind
// one. Two of them move or light, both from the environment only:
//
// - The windmill's sails (`prop.windmillSails`, 4 frames of the cross turned
//   22.5° a step) advance one frame per 250 ms (4 fps, the `slow` ambient
//   band) only while a gust of the one wind field (`Wind.windAt`) crosses the
//   mill; calm air holds the frame they stopped on, and reduced motion
//   (`motionScale <= 0`) holds frame 0. Each frame is one cached composite of
//   the tower and its sails, shared by the Canvas and GPU paths
//   (`textureKey` per frame, like a tree's lean frame).
// - The chapel lantern's glass texels (`prop.waysideChapel.emissive.png`)
//   light on the lamps clock (`lampsLitAt`), painted over the albedo and as
//   the record's own emissive channel; the flip repaints the cache once.

import { StaticPropSprite } from './StaticPropDrawables.js';
import { SpriteRenderer } from './SpriteRenderer.js';
import { baseWindX, windAt } from './Wind.js';
import { DISTRICT_PROPS } from '../../config/scenery.js';

export const WINDMILL_SAIL_HUB = Object.freeze([50, 86]); // windmill base-local px
const SAIL_FRAMES = 4;
const SAIL_FRAME_PX = 112;
const SAIL_STEP_MS = 250;
const SAIL_CALM = 0.15; // knot wind below this is still air (pennants rest too)
// The chapel lantern's foot offset from the chapel's anchor tile, and its
// height above the ground, for its night light record.
const CHAPEL_LANTERN = Object.freeze({ dTileX: 0.64, dTileY: -0.64, height: 18 });

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

function chapelSprite(host, prop, state) {
    const lantern = (ctx, x, y) => {
        const image = state.lit ? host.assets?.getCompanion?.(prop.id, 'emissive') : null;
        state.paintedLight = Boolean(image);
        if (!image) return;
        const [ax, ay] = host.assets.getAnchor(prop.id);
        ctx.drawImage(image, Math.round(x) - ax, Math.round(y) - ay);
    };
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
            lantern(ctx, x, y);
        },
        channels: { emissive: lantern },
    });
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
        this._chapel = { lit: false, paintedLight: false, sprite: null, prop: null };
    }

    /** One sorted sprite per landmark placement; built with the district props. */
    buildSprites() {
        const out = [];
        for (const prop of LANDMARK_PROPS) {
            if (prop.id === 'prop.windmill') out.push(new WindmillSprite(this.host, prop));
            else if (prop.id === 'prop.waysideChapel') {
                this._chapel.prop = prop;
                this._chapel.sprite = chapelSprite(this.host, prop, this._chapel);
                out.push(this._chapel.sprite);
            } else out.push(plainSprite(this.host, prop));
        }
        return out;
    }

    /** Per frame: the lamps clock flips the chapel lantern (repaint once). */
    update(lampsLit) {
        const chapel = this._chapel;
        const lit = lampsLit === true;
        // Repaint on the flip, and once more if the sidecar arrived after a lit paint.
        const late = lit && !chapel.paintedLight && Boolean(this.host.assets?.getCompanion?.(chapel.prop?.id, 'emissive'));
        if (lit === chapel.lit && !late) return;
        chapel.lit = lit;
        chapel.sprite?.invalidateCache();
    }

    /** The chapel lantern's night light record (a `lamps` fixture, never occupancy). */
    lightFixtures() {
        const prop = this._chapel.prop;
        if (!this._chapel.lit || !prop) return [];
        return [{
            id: 'landmark.waysideChapel.lantern',
            tileX: prop.tileX + CHAPEL_LANTERN.dTileX,
            tileY: prop.tileY + CHAPEL_LANTERN.dTileY,
            height: CHAPEL_LANTERN.height,
            color: '#ffcf7a',
            radius: 34,
            intensity: 0.55,
        }];
    }
}
