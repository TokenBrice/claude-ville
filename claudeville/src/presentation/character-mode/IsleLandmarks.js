// Living Isle W8.5b (AD-P10) + v0.69 E2 — the isle landmarks: the windmill and
// the modular N-provider Runic Tide-Terrace (DISTRICT_PROPS `landmark`).
//
// They are not places: no occupancy, label, gate or session reading of any
// kind (V3). Each standing landmark is a sorted StaticPropSprite (tall, among
// the trees) whose placement carries `walkBlock`, so no body ever stands on or
// behind one. The windmill is scenery and moves from the environment only; the
// Runic Tide-Terrace is the multi-provider account quota monument and reads
// `/api/usage` alone:
//
// - The windmill's sails (`prop.windmillSails`, 8 frames of the cross turned
//   11.25° a step, MB-7) advance one frame per 125 ms (8 fps in gusts) or
//   300 ms (~3.3 fps in steady breeze) only while wind crosses the mill; calm
//   air holds the frame they stopped on, and reduced motion (`motionScale <= 0`)
//   holds frame 0.
// - The Runic Tide-Terrace (v0.69 E2, replacing the 2-account Hourglass Belfry
//   on the NW lagoon headland) sets a baked weathered ashlar sundial apron
//   (`prop.quotaTerraceApron`, `layer: 'cache'`, `walkBlock: false`) beneath
//   one modular `prop.quotaPillar` per provider in `QUOTA_TERRACE_PROVIDERS`
//   (Claude, Codex, GLM, Antigravity). Each pillar stamps its own cell from
//   `prop.quotaPillarStrip` into its recessed 5-course runic gauge channel via
//   an offscreen composite cached in-place (`_gpuCacheRevision` bumps with
//   zero GPU `textureKey` churn):
//   - `l0`–`l5`: 5 bold runic crystal courses showing weekly quota left
//   - `unknown`: draped woven linen shroud veil
//   - `limit`: calm lavender wax-seal ribbon
//   - `peak`: C4 cream weekly-reset refill flash (150 ms) followed by 150 ms/step
//     climb up to the new level (`medium` band; instant under reduced motion)
//   - MB-5 (`slow` band): while a provider's spend rose within the last 10 min
//     (`quotaDraining`), its pillar cycles 3 baked trickle/shimmer phases at
//     2 fps (500 ms); reduced motion keeps the static cell.
// - W1-D 1.10 — both keep a light in at night, on the village lamp clock only
//   (`villageLampsLit`; never occupancy or quota): the windmill's doorway and
//   windows, and each quota pillar's stone lantern-crown soffit (strictly off
//   the gauge channel) carry `.emissive.png` sidecars gated by `emitterGate`.

import { StaticPropSprite } from './StaticPropDrawables.js';
import { SpriteRenderer } from './SpriteRenderer.js';
import { baseWindX, windAt } from './Wind.js';
import { DISTRICT_PROPS, QUOTA_TERRACE_CENTER, QUOTA_TERRACE_PROVIDERS } from '../../config/scenery.js';
import { tileToWorld } from './Projection.js';
import {
    QUOTA_PILLAR_LEVELS,
    QUOTA_PILLAR_STATES,
    QUOTA_PILLAR_STREAM_PHASES,
    QUOTA_PILLAR_STRIP_FRAME,
    QUOTA_PILLAR_STRIP_ORIGIN,
    quotaDrainStep,
    quotaDraining,
    quotaPillarKey,
    quotaPillarReadings,
    quotaPillarStateCell,
    quotaPillarStreamCell,
    quotaPillarTooltip,
} from './QuotaTerrace.js';

export const WINDMILL_SAIL_HUB = Object.freeze([50, 86]); // windmill base-local px
export const QUOTA_PILLAR_ID = 'prop.quotaPillar';
export const QUOTA_PILLAR_STRIP_ID = 'prop.quotaPillarStrip';
export const QUOTA_TERRACE_APRON_ID = 'prop.quotaTerraceApron';
export {
    QUOTA_PILLAR_STATES,
    QUOTA_PILLAR_STREAM_PHASES,
    QUOTA_PILLAR_STRIP_FRAME,
    QUOTA_PILLAR_STRIP_ORIGIN,
    quotaPillarStateCell,
    quotaPillarStreamCell,
};

const PILLAR_PEAK_MS = 150;
const PILLAR_STEP_MS = 150;
const PILLAR_STREAM_STEP_MS = 500; // 2 fps
const SAIL_FRAMES = 8;
const SAIL_FRAME_PX = 112;
const SAIL_STEP_MS = 125; // 8 fps in gusts
const SAIL_BREEZE_STEP_MS = 300; // ~3.3 fps in steady breeze (2–4 fps, relaxed 2026-11-23)
const SAIL_CALM = 0.15; // knot wind below this is still air (pennants rest too)

const LANDMARK_PROPS = Object.freeze(DISTRICT_PROPS.filter((prop) => prop.landmark));

// W1-D 1.10 — night pools on the village lamp clock (`lamps` fixtures).
// Windmill casts from its doorway; the Runic Tide-Terrace casts a soft warm
// lantern pool across its stone apron from the terrace crown arc.
export const LANDMARK_LIGHT_RADIUS = 36;
export const LANDMARK_LIGHTS = Object.freeze({
    'prop.windmill': Object.freeze({ foot: Object.freeze([-0.25, 0.5]), height: 16, intensity: 0.62 }),
    'prop.quotaTerraceApron': Object.freeze({ foot: Object.freeze([0.0, 0.1]), height: 50, intensity: 0.44 }),
});
const LANDMARK_LIGHT_COLOR = '#ffc95e';

function lampsLit(host) {
    return host?.villageLampsLit?.() === true;
}

function glowKey(host, id) {
    return host?.assets?.getCompanion?.(id, 'emissive') ? '1' : '0';
}

function boundsFor(assets, id, extraLeft = 0) {
    const dims = assets?.getDims?.(id) || { w: 64, h: 64 };
    const [ax, ay] = assets?.getAnchor?.(id) || [dims.w / 2, dims.h];
    return {
        left: -ax - extraLeft,
        right: dims.w - ax,
        top: -ay,
        bottom: dims.h - ay,
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
            splitForOcclusion: false,
            materialClass: 'stone',
            drawFn: (ctx, x, y) => this._paint(ctx, x, y, this._paintFrame),
            channels: { emissive: (ctx, x, y) => this._paintGlow(ctx, x, y, this._paintFrame) },
        });
        this.host = host;
        this.emitterGate = () => (lampsLit(host) ? 1 : 0);
        this._glowKey = '';
        this._paintFrame = 0;
        this._sailFrame = 0;
        this._sailStepAt = -Infinity;
        this._wind = { x: 0, gust: 0 };
        this._frames = new Array(SAIL_FRAMES).fill(null);
        this._snowKey = '';
    }

    /** The sail frame now: steady-breeze + gust-accelerated, calm-held, frame 0 under reduced motion. */
    sailFrame() {
        const host = this.host;
        if (!((host.motionScale ?? 1) > 0)) return 0;
        const weather = host._lastAtmosphere?.weather;
        if (Math.abs(baseWindX(weather)) < SAIL_CALM) return this._sailFrame;
        const t = host.motionTimeMs || 0;
        if (t < this._sailStepAt) this._sailStepAt = -Infinity; // clock reset
        const gust = windAt(this.x, this.y, t, weather, this._wind).gust;
        const stepMs = gust > 0 ? SAIL_STEP_MS : SAIL_BREEZE_STEP_MS;
        if (t - this._sailStepAt >= stepMs) {
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
        const snowKey = this.host.propWinter?.key || '0';
        const glow = glowKey(this.host, this.id);
        if (snowKey !== this._snowKey || glow !== this._glowKey) {
            this._snowKey = snowKey;
            this._glowKey = glow;
            this._frames = new Array(SAIL_FRAMES).fill(null);
            this._gpuCacheRevision++;
        }
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
        const winter = host.propWinter?.image?.(this.id) || null;
        host.sprites?.drawSprite(ctx, this.id, x, y, winter ? { image: winter } : undefined);
        const sails = host.assets?.get?.('prop.windmillSails');
        if (!sails) return;
        const [ax, ay] = host.assets.getAnchor(this.id);
        const ox = Math.round(x) - ax + WINDMILL_SAIL_HUB[0] - SAIL_FRAME_PX / 2;
        const oy = Math.round(y) - ay + WINDMILL_SAIL_HUB[1] - SAIL_FRAME_PX / 2;
        ctx.drawImage(sails, frame * SAIL_FRAME_PX, 0, SAIL_FRAME_PX, SAIL_FRAME_PX, ox, oy, SAIL_FRAME_PX, SAIL_FRAME_PX);
    }

    _paintGlow(ctx, x, y, frame) {
        const host = this.host;
        if (!host.sprites?.drawCompanion?.(ctx, this.id, 'emissive', x, y)) return;
        const sails = host.assets?.get?.('prop.windmillSails');
        if (!sails) return;
        const [ax, ay] = host.assets.getAnchor(this.id);
        const ox = Math.round(x) - ax + WINDMILL_SAIL_HUB[0] - SAIL_FRAME_PX / 2;
        const oy = Math.round(y) - ay + WINDMILL_SAIL_HUB[1] - SAIL_FRAME_PX / 2;
        ctx.save();
        ctx.globalCompositeOperation = 'destination-out';
        ctx.drawImage(sails, frame * SAIL_FRAME_PX, 0, SAIL_FRAME_PX, SAIL_FRAME_PX, ox, oy, SAIL_FRAME_PX, SAIL_FRAME_PX);
        ctx.restore();
    }

    releaseCache() {
        super.releaseCache();
        this._frames = new Array(SAIL_FRAMES).fill(null);
    }
}

function keyLevel(key) {
    if (key === 'limit') return 0;
    return /^l\d$/.test(key) ? Number(key.slice(1)) : null;
}

export class QuotaPillarSprite extends StaticPropSprite {
    constructor(host, prop, reading) {
        super({
            tileX: prop.tileX,
            tileY: prop.tileY,
            id: prop.id,
            bounds: boundsFor(host.assets, prop.id),
            splitForOcclusion: false,
            materialClass: 'stone',
            drawFn: (ctx, x, y) => this._paint(ctx, x, y),
            channels: {
                emissive: (ctx, x, y) => host.sprites?.drawCompanion?.(ctx, prop.id, 'emissive', x, y),
                material: (ctx, x, y) => host.sprites?.drawCompanion?.(ctx, prop.id, 'material', x, y),
                occluder: (ctx, x, y) => host.sprites?.drawCompanion?.(ctx, prop.id, 'occluder', x, y),
            },
        });
        this.host = host;
        this.provider = prop.provider;
        this.emitterGate = () => (lampsLit(host) ? 1 : 0);
        this._shownGlow = '';
        this._shownSnow = '';
        this._target = 'unknown';
        this._moment = null;
        this._shown = 'unknown';
        this._shownPhase = null;
        this._drain = null;
        this.setReading(reading);
    }

    /** MB-5 — the drain record (`quotaDrainStep`) the trickle shimmer runs on. */
    setDrain(drain) {
        this._drain = drain || null;
    }

    /**
     * MB-5 — this pillar's running spend phase now, or null: its provider
     * drains, quota remains (`l1`–`l5`, no reset moment playing) and motion is on.
     */
    streamPhase(now = Date.now()) {
        if (!((this.host.motionScale ?? 1) > 0) || this._moment) return null;
        if (!(keyLevel(this._target) > 0) || !quotaDraining(this._drain, this.provider, now)) return null;
        return Math.floor((this.host.motionTimeMs || 0) / PILLAR_STREAM_STEP_MS) % QUOTA_PILLAR_STREAM_PHASES;
    }

    /** Update reading; returns true when the target strip state changed. */
    setReading(reading) {
        const motion = (this.host.motionScale ?? 1) > 0;
        const key = quotaPillarKey(reading);
        if (key === this._target) return false;
        const from = keyLevel(this._target);
        const to = keyLevel(key);
        this._moment = motion && from !== null && to !== null && to > from
            ? { from, to, at: this.host.motionTimeMs || 0 }
            : null;
        this._target = key;
        return true;
    }

    /** Current drawn strip state key: steady reading, or the active reset-refill step. */
    pillarKey() {
        const moment = this._moment;
        if (!moment) return this._target;
        const t = (this.host.motionTimeMs || 0) - moment.at;
        const level = moment.from + 1 + Math.floor((t - PILLAR_PEAK_MS) / PILLAR_STEP_MS);
        if (!((this.host.motionScale ?? 1) > 0) || t < 0 || level >= moment.to) {
            this._moment = null;
            return this._target;
        }
        return t < PILLAR_PEAK_MS ? 'peak' : `l${level}`;
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

    // Repaints the cached composite in place and bumps `_gpuCacheRevision`
    // without touching `textureKey` (zero GPU texture-key churn).
    _getCachedCanvas(zoom) {
        if (!this.host.assets?.get?.(QUOTA_PILLAR_STRIP_ID)) return null;
        let changed = false;
        const snowKey = this.host.propWinter?.key || '0';
        if (snowKey !== this._shownSnow) {
            this._shownSnow = snowKey;
            changed = true;
        }
        const glow = glowKey(this.host, this.id);
        if (glow !== this._shownGlow) {
            this._shownGlow = glow;
            changed = true;
        }
        const key = this.pillarKey();
        const phase = this.streamPhase();
        if (key !== this._shown || phase !== this._shownPhase) {
            this._shown = key;
            this._shownPhase = phase;
            changed = true;
        }
        if (changed && this._cacheCanvas) this.invalidateCache();
        return super._getCachedCanvas(zoom);
    }

    _paint(ctx, x, y) {
        const host = this.host;
        host._drawPropContactShadow?.(ctx, x, y, this.id, this.tileX, this.tileY);
        const winter = host.propWinter?.image?.(this.id) || null;
        host.sprites?.drawSprite(ctx, this.id, x, y, winter ? { image: winter } : undefined);
        const strip = host.assets?.get?.(QUOTA_PILLAR_STRIP_ID);
        if (!strip) return;
        const [ax, ay] = host.assets.getAnchor(this.id);
        const [fw, fh] = QUOTA_PILLAR_STRIP_FRAME;
        const [ox, oy] = QUOTA_PILLAR_STRIP_ORIGIN;
        const phase = this._shownPhase;
        const level = keyLevel(this._shown);
        const cell = phase !== null && level > 0
            ? quotaPillarStreamCell(this.provider, level, phase)
            : quotaPillarStateCell(this.provider, this._shown);
        ctx.drawImage(strip, cell * fw, 0, fw, fh, Math.round(x) - ax + ox, Math.round(y) - ay + oy, fw, fh);
    }
}

function plainSprite(host, prop) {
    return new StaticPropSprite({
        tileX: prop.tileX,
        tileY: prop.tileY,
        id: prop.id,
        bounds: boundsFor(host.assets, prop.id),
        splitForOcclusion: false,
        materialClass: 'stone',
        drawFn: (ctx, x, y) => {
            host._drawPropContactShadow?.(ctx, x, y, prop.id, prop.tileX, prop.tileY);
            const winter = host.propWinter?.image?.(prop.id) || null;
            host.sprites?.drawSprite(ctx, prop.id, x, y, winter ? { image: winter } : undefined);
        },
    });
}

export class IsleLandmarks {
    constructor(host) {
        this.host = host;
        this._terrace = {
            pillars: [],
            pillarsByProvider: new Map(),
            usage: null,
            readings: quotaPillarReadings(null),
            drain: null,
            opaque: null,
            version: 0,
        };
    }

    /** One sorted sprite per landmark placement; built with the district props. */
    buildSprites() {
        const out = [];
        this._terrace.pillars = [];
        this._terrace.pillarsByProvider.clear();
        for (const prop of LANDMARK_PROPS) {
            if (prop.id === 'prop.windmill') {
                out.push(new WindmillSprite(this.host, prop));
            } else if (prop.id === QUOTA_PILLAR_ID && prop.provider) {
                const sprite = new QuotaPillarSprite(this.host, prop, this._terrace.readings[prop.provider]);
                sprite.setDrain(this._terrace.drain);
                this._terrace.pillars.push(sprite);
                this._terrace.pillarsByProvider.set(prop.provider, sprite);
                out.push(sprite);
            } else {
                out.push(plainSprite(this.host, prop));
            }
        }
        return out;
    }

    /**
     * W1-D 1.10 — night pools while the village lamps are lit (else none).
     * Clock and geography only; never gated on quota or occupancy.
     */
    lightFixtures() {
        if (!lampsLit(this.host)) return [];
        const out = [];
        const windmill = LANDMARK_PROPS.find((prop) => prop.id === 'prop.windmill');
        if (windmill) {
            const light = LANDMARK_LIGHTS['prop.windmill'];
            out.push({
                id: 'landmark.prop.windmill',
                tileX: windmill.tileX + light.foot[0],
                tileY: windmill.tileY + light.foot[1],
                height: light.height,
                radius: LANDMARK_LIGHT_RADIUS,
                intensity: light.intensity,
                color: LANDMARK_LIGHT_COLOR,
            });
        }
        const terraceLight = LANDMARK_LIGHTS[QUOTA_TERRACE_APRON_ID];
        if (terraceLight && this._terrace.pillars.length > 0) {
            out.push({
                id: `landmark.${QUOTA_TERRACE_APRON_ID}`,
                tileX: QUOTA_TERRACE_CENTER.tileX + terraceLight.foot[0],
                tileY: QUOTA_TERRACE_CENTER.tileY + terraceLight.foot[1],
                height: terraceLight.height,
                radius: LANDMARK_LIGHT_RADIUS,
                intensity: terraceLight.intensity,
                color: LANDMARK_LIGHT_COLOR,
            });
        }
        return out;
    }

    /** The account quota from `/api/usage` (IsometricRenderer.setQuotaState), received at `now`. */
    setUsage(usage, now = Date.now()) {
        const terrace = this._terrace;
        terrace.usage = usage || null;
        terrace.version++;
        terrace.readings = quotaPillarReadings(terrace.usage, now, QUOTA_TERRACE_PROVIDERS);
        terrace.drain = quotaDrainStep(terrace.drain, terrace.readings, now, QUOTA_TERRACE_PROVIDERS);
        let anyChanged = false;
        for (const sprite of terrace.pillars) {
            sprite.setDrain(terrace.drain);
            if (sprite.setReading(terrace.readings[sprite.provider])) anyChanged = true;
        }
        if (anyChanged) this.host._invalidateIdleFrame?.();
    }

    getQuotaPillars() {
        return this._terrace.pillars;
    }

    getQuotaPillar(provider) {
        return this._terrace.pillarsByProvider.get(provider) || null;
    }

    usageSnapshot() {
        return { usage: this._terrace.usage, version: this._terrace.version };
    }

    /** Front-most quota pillar whose opaque texel contains world point (x, y), else null. */
    hitTestQuotaPillar(worldX, worldY) {
        const pillars = this._terrace.pillars;
        const assets = this.host.assets;
        const image = assets?.get?.(QUOTA_PILLAR_ID);
        if (!pillars.length || !image) return null;
        const [ax, ay] = assets.getAnchor(QUOTA_PILLAR_ID);
        const opaque = this._pillarOpaque(image);
        // Check front-most pillars first (larger world Y wins).
        const ordered = pillars.length > 1
            ? [...pillars].sort((a, b) => (b.y - a.y) || (a.x - b.x))
            : pillars;
        for (const sprite of ordered) {
            const lx = Math.floor(worldX - (Math.round(sprite.x) - ax));
            const ly = Math.floor(worldY - (Math.round(sprite.y) - ay));
            if (lx < 0 || ly < 0 || lx >= image.width || ly >= image.height) continue;
            if (!opaque || opaque[ly * image.width + lx]) return sprite;
        }
        return null;
    }

    /** XP-4 — the hovered pillar's drawn world rect, for the hover plate to keep clear of. */
    quotaPillarWorldBounds(pillar) {
        const sprite = typeof pillar === 'string' ? this.getQuotaPillar(pillar) : pillar;
        const assets = this.host.assets;
        const image = assets?.get?.(QUOTA_PILLAR_ID);
        if (!sprite || !image) return null;
        const [ax, ay] = assets.getAnchor(QUOTA_PILLAR_ID);
        const left = Math.round(sprite.x) - ax;
        const top = Math.round(sprite.y) - ay;
        return { left, top, right: left + image.width, bottom: top + image.height };
    }

    /** World anchor `{ x, y }` for positioning the Quota Ledger card beside a pillar (or terrace center). */
    quotaTerraceAnchor(pillar = null) {
        const sprite = typeof pillar === 'string' ? this.getQuotaPillar(pillar) : pillar;
        if (sprite) return { x: sprite.x, y: sprite.y - 34 };
        const center = tileToWorld(QUOTA_TERRACE_CENTER.tileX, QUOTA_TERRACE_CENTER.tileY);
        return { x: center.x, y: center.y - 24 };
    }

    /** Crisp 2-line hover text for one specific pillar at `now`. */
    quotaPillarTooltip(pillar, now = Date.now()) {
        const provider = typeof pillar === 'string' ? pillar : pillar?.provider;
        if (!provider) return '';
        return quotaPillarTooltip(provider, this._terrace.usage, now);
    }

    _pillarOpaque(image) {
        const terrace = this._terrace;
        if (terrace.opaque || typeof document === 'undefined') return terrace.opaque;
        const canvas = document.createElement('canvas');
        canvas.width = image.width;
        canvas.height = image.height;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) return null;
        ctx.drawImage(image, 0, 0);
        const data = ctx.getImageData(0, 0, image.width, image.height).data;
        terrace.opaque = new Uint8Array(image.width * image.height);
        for (let i = 0; i < terrace.opaque.length; i++) terrace.opaque[i] = data[i * 4 + 3] > 0 ? 1 : 0;
        return terrace.opaque;
    }
}
