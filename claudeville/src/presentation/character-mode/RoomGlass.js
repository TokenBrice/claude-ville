// 6.3 — windows count the workers.
//
// A landmark's glass is the emissive-sidecar texels under its registry
// `windowRects` and `rooms.slots` (1-texel margin, the same rule the M15 slate
// recolour and `bake-room-masks.mjs` use). `base.rooms.png` (Surfaces, 6.3)
// names each glass texel's room in R (1..N); glass with R = 0 is the hall's
// ordinary panes. Every glass texel carries its own gate:
//
//   room k      night × (a working visitor holds room k)   (BuildingSprite)
//   hall panes  never lit: unlit slate glass at every hour
//
// By day every pane is unlit slate glass (M15): the sidecar still keeps the
// forge mouth, braziers and lanterns identifiable, but no window glows.
//
// Both backends switch a pane off the same way — with the pane's own unlit
// albedo: the resident scene pass draws one "glass patch" record per landmark
// right after the landmark (same texels, no emission), and the Canvas emitter
// cut carves the same canvas out of the lit cut. The patch alpha of a group is
// 1 - gate, stepped in quarters (no smooth fade), so a canvas is rebuilt only
// when a room changes hands or crosses a quarter.

import { getBuildingRoomProfile, getBuildingVisual, getBuildingWindowRects, windowRectBounds } from './BuildingVisualRegistry.js';

export const ROOM_GLASS_STEPS = 4;
const NONE = -1;
const HALL = 0;

function readPixels(image, w, h) {
    if (!image || typeof document === 'undefined') return null;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(image, 0, 0);
    const data = ctx.getImageData(0, 0, w, h).data;
    canvas.width = 0;
    canvas.height = 0;
    return data;
}
function glassRects(type) {
    return [
        ...(getBuildingWindowRects(type) || []),
        ...(getBuildingRoomProfile(type)?.slots || []),
        ...(getBuildingVisual(type)?.glassRects || []),
    ].filter((rect) => Array.isArray(rect?.at));
}

function sidecarUrl(albedo, suffix) {
    const src = typeof albedo?.src === 'string' ? albedo.src : '';
    return src ? src.replace(/\.png(?=([?#]|$))/, `.${suffix}.png`) : '';
}

function loadImage(url) {
    return new Promise((resolve) => {
        if (!url || typeof Image === 'undefined') {
            resolve(null);
            return;
        }
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = () => resolve(null);
        image.src = url;
    });
}

/**
 * Pure: the glass map of one landmark from its sidecar pixels.
 * `emissive` and `rooms` are RGBA byte arrays of the sprite size (`rooms` may
 * be null). Returns `{ left, top, w, h, group: Int8Array, rooms }` in the
 * sprite's local texels, or null when the landmark has no glass. `group` is
 * -1 off glass, 0 on hall panes, k (1..rooms) on room k.
 */
export function buildGlassMap({ width, height, emissive, rooms = null, rects = [] }) {
    if (!emissive || !(width > 0) || !(height > 0)) return null;
    const inRect = new Uint8Array(width * height);
    for (const rect of rects) {
        const { left, top, w, h } = windowRectBounds(rect);
        for (let y = Math.max(0, top - 1); y < Math.min(height, top + h + 1); y++) {
            for (let x = Math.max(0, left - 1); x < Math.min(width, left + w + 1); x++) inRect[y * width + x] = 1;
        }
    }
    let x0 = width;
    let y0 = height;
    let x1 = -1;
    let y1 = -1;
    let roomCount = 0;
    for (let i = 0; i < width * height; i++) {
        const room = rooms && rooms[i * 4 + 3] > 0 ? rooms[i * 4] : 0;
        if (!(room > 0) && !(inRect[i] && emissive[i * 4 + 3] > 0)) continue;
        if (room > roomCount) roomCount = room;
        const x = i % width;
        const y = (i - x) / width;
        if (x < x0) x0 = x;
        if (y < y0) y0 = y;
        if (x > x1) x1 = x;
        if (y > y1) y1 = y;
    }
    if (x1 < 0) return null;
    const w = x1 - x0 + 1;
    const h = y1 - y0 + 1;
    const group = new Int8Array(w * h).fill(NONE);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const i = (y + y0) * width + x + x0;
            const room = rooms && rooms[i * 4 + 3] > 0 ? rooms[i * 4] : 0;
            if (room > 0) group[y * w + x] = room;
            else if (inRect[i] && emissive[i * 4 + 3] > 0) group[y * w + x] = HALL;
        }
    }
    return { left: x0, top: y0, w, h, group, rooms: roomCount };
}

/** Unlit share of a group, stepped in quarters: 0 lit … 1 dark. */
export function unlitStep(gate) {
    const lit = Math.max(0, Math.min(1, Number(gate) || 0));
    return Math.round((1 - lit) * ROOM_GLASS_STEPS) / ROOM_GLASS_STEPS;
}

export class RoomGlass {
    constructor(assets) {
        this.assets = assets;
        this._maps = new Map();
        this._patches = new Map();
    }

    // The glass map of `type`, loading it on first use (null until ready and
    // for landmarks without authored glass).
    map(type) {
        const cached = this._maps.get(type);
        if (cached !== undefined) return cached === 'loading' ? null : cached;
        const id = `building.${type}`;
        const albedo = this.assets?.get?.(id);
        const dims = this.assets?.getDims?.(id);
        if (!albedo || !dims || this.assets.getEntry?.(id)?.emissiveSidecar !== true) return null;
        const rects = glassRects(type);
        if (!rects.length) {
            this._maps.set(type, null);
            return null;
        }
        this._maps.set(type, 'loading');
        const emissive = this.assets.getCompanion?.(id, 'emissive') || null;
        const version = this.assets.assetVersion || '';
        Promise.all([
            emissive ? Promise.resolve(emissive) : loadImage(sidecarUrl(albedo, 'emissive')),
            loadImage(sidecarUrl(albedo, 'rooms')),
        ]).then(([emissiveImage, roomsImage]) => {
            if ((this.assets.assetVersion || '') !== version) {
                this._maps.delete(type);
                return;
            }
            const width = dims.w;
            const height = dims.h;
            const map = buildGlassMap({
                width,
                height,
                emissive: readPixels(emissiveImage, width, height),
                rooms: roomsImage?.width === width && roomsImage?.height === height
                    ? readPixels(roomsImage, width, height)
                    : null,
                rects,
            });
            if (map) {
                map.albedo = readPixels(albedo, width, height);
                map.spriteWidth = width;
                map.channels = {
                    material: this._crop(this.assets.getCompanion?.(id, 'material'), map),
                    occluder: this._crop(this.assets.getCompanion?.(id, 'occluder'), map),
                };
            }
            this._maps.set(type, map);
        });
        return null;
    }

    roomCount(type) {
        return this.map(type)?.rooms || 0;
    }

    _crop(image, map) {
        if (!image || typeof document === 'undefined') return null;
        const canvas = document.createElement('canvas');
        canvas.width = map.w;
        canvas.height = map.h;
        canvas.getContext('2d').drawImage(image, map.left, map.top, map.w, map.h, 0, 0, map.w, map.h);
        return canvas;
    }

    /**
     * The unlit-glass patch of `type`: `{ canvas, left, top, w, h, key,
     * channels }` with every pane's own unlit albedo at its group's unlit step,
     * or null when every pane is fully lit. `gateFor(group)` returns the
     * group's lit share (0 hall, 1..N rooms).
     */
    patch(type, gateFor) {
        const map = this.map(type);
        if (!map?.albedo) return null;
        const steps = new Array(map.rooms + 1);
        let key = '';
        let any = false;
        for (let group = 0; group <= map.rooms; group++) {
            steps[group] = unlitStep(gateFor(group));
            if (steps[group] > 0) any = true;
            key += steps[group] * ROOM_GLASS_STEPS;
        }
        if (!any) return null;
        let entry = this._patches.get(type);
        if (entry?.key === key) return entry;
        if (!entry) {
            const canvas = document.createElement('canvas');
            canvas.width = map.w;
            canvas.height = map.h;
            entry = { canvas, left: map.left, top: map.top, w: map.w, h: map.h, key: '', revision: 0, channels: map.channels };
            this._patches.set(type, entry);
        }
        const ctx = entry.canvas.getContext('2d');
        const image = ctx.createImageData(map.w, map.h);
        const out = image.data;
        const src = map.albedo;
        for (let y = 0; y < map.h; y++) {
            for (let x = 0; x < map.w; x++) {
                const group = map.group[y * map.w + x];
                if (group === NONE) continue;
                const step = steps[group] ?? 1;
                if (!(step > 0)) continue;
                const i = ((y + map.top) * map.spriteWidth + x + map.left) * 4;
                const o = (y * map.w + x) * 4;
                out[o] = src[i];
                out[o + 1] = src[i + 1];
                out[o + 2] = src[i + 2];
                out[o + 3] = Math.round(src[i + 3] * step);
            }
        }
        ctx.putImageData(image, 0, 0);
        entry.key = key;
        entry.revision++;
        return entry;
    }
}
