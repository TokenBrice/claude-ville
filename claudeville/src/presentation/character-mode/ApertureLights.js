// 2.4 (LGI-4) — aperture lights from the emissive sidecars.
//
// A landmark's lit windows, lanterns and secondary openings are already
// painted in its `base.emissive.png`; before this module only the hand-placed
// registry points (`lightSources`, `emitters`, fallbacks) threw light. At load
// each landmark's sidecar is cut into emitter blobs (A > 0.1, 4-connected,
// area >= 10 px) and each blob is tagged with the 6.3 glass group its texels
// belong to (`buildGlassMap` over `base.rooms.png` and the registry glass
// rects — the same map the unlit-glass patch uses, so a light and the pane it
// comes from always agree):
//
//   room k (1..N)   lit by BuildingSprite.roomGate(type, k - 1)
//   hall panes      never lit (unlit slate glass at every hour): no template
//   off glass       a lantern, brazier or opening: lit by the building's own
//                   night-shift gate (a real worker inside) at night
//
// Muntins cut one pane into several 4-connected blobs, and a room's window
// into several panes: every glass blob of room k is one aperture (the room
// mask is the authority on what a window is, so a small room's glass — the
// Harbor's 6-11 px panes — is never dropped as a speck). Off-glass blobs of
// area >= 10 px share one gate (the building's night shift), so two of one
// colour family (warm or cool) whose centroids lie closer than
// APERTURE_MERGE_DISTANCE px — nearer than any aperture's radius, so their
// pools would lie on each other — are one aperture (area summed, centroid
// area-weighted), nearest pair first: a crystal cluster lays one light, not
// thirteen overlapping ones that crowd the tile list. BuildingSprite places
// each template (V5 foot, height and face normal from `_lightFootFor`). A
// registry point on a room's glass (within APERTURE_GLASS_SNAP px of its
// box) stands in for that room and takes the room's gate; an off-glass
// template within APERTURE_REGISTRY_CLEARANCE px of any other registry point
// is skipped. Each template is emitted from `getLightSources` as a
// `role: 'aperture'` light with `apertureIntensity(area, energy.core, gate)`
// and `apertureRadius(area)`.

import { buildGlassMap, glassRects, loadImage, readPixels, sidecarUrl } from './RoomGlass.js';

// A > 0.1 of 255.
export const APERTURE_ALPHA_MIN = 26;
export const APERTURE_MIN_AREA = 10;
export const APERTURE_MERGE_DISTANCE = 32;
export const APERTURE_REGISTRY_CLEARANCE = 30;
export const APERTURE_GLASS_SNAP = 2;
export const APERTURE_RADIUS_CAP = 106;
// Glass group of a template off every pane (a lantern, a forge opening).
export const APERTURE_OFF_GLASS = -1;
// Masses whose face-front ground is the landmark's own roof, in sprite px
// `[x0, y0, x1, y1]`: a window there looks out over roofs, which take no
// light (2.3). BuildingSprite stands such a room's aperture on the
// footprint's front edge straight below the window (the analytic foot,
// facing that edge), so a worked room lays its light on the street in front
// of the face under it. The Command's windowed drum rises from the keep roof
// (the surface bake's drum region, `scripts/sprites/bake-surface-channel.mjs`,
// measures its height to the gate wall's foot, so no sidecar texel can tell).
export const APERTURE_OVER_ROOF = Object.freeze({
    command: Object.freeze([Object.freeze([126, 88, 226, 112])]),
});

/** True when the template's centroid lies on a mass that stands on its landmark's own roof. */
export function apertureOverRoof(type, template) {
    const rects = APERTURE_OVER_ROOF[type];
    if (!rects || !template) return false;
    return rects.some(([x0, y0, x1, y1]) => template.cx >= x0 && template.cx <= x1 && template.cy >= y0 && template.cy <= y1);
}

/** min(1.2, 0.5 + area / 400) x core energy x the room (or building) gate. */
export function apertureIntensity(area, core = 1, gate = 1) {
    return Math.min(1.2, 0.5 + Math.max(0, Number(area) || 0) / 400) * Math.max(0, Number(core) || 0) * Math.max(0, Number(gate) || 0);
}

/** min(106, 30 + 2.2 sqrt(area)) world px. */
export function apertureRadius(area) {
    return Math.min(APERTURE_RADIUS_CAP, 30 + 2.2 * Math.sqrt(Math.max(0, Number(area) || 0)));
}

function hexByte(value) {
    return Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, '0');
}

/**
 * Pure: the aperture templates of one landmark. `emissive` is the RGBA byte
 * array of its emissive sidecar (`width x height`); `glass` its 6.3 glass map
 * (`buildGlassMap`) or null. Returns `[{ key, group, area, cx, cy, x0, y0,
 * x1, y1, color }]` in sprite px (`cx, cy` the area-weighted centroid of the
 * texel centres, `color` the blobs' mean emissive colour as #rrggbb), hall
 * panes (group 0) excluded, in scan order of each aperture's first blob. A
 * room's glass (group k >= 1) is one aperture whatever its size; off-glass
 * blobs keep area >= APERTURE_MIN_AREA and join across a muntin gap.
 */
export function extractApertureTemplates({ width, height, emissive, glass = null }) {
    if (!emissive || !(width > 0) || !(height > 0)) return [];
    const size = width * height;
    const label = new Int32Array(size).fill(-1);
    const stack = new Int32Array(size);
    const groupAt = (x, y) => {
        if (!glass) return APERTURE_OFF_GLASS;
        const gx = x - glass.left;
        const gy = y - glass.top;
        if (gx < 0 || gy < 0 || gx >= glass.w || gy >= glass.h) return APERTURE_OFF_GLASS;
        return glass.group[gy * glass.w + gx];
    };
    const blobs = [];
    for (let start = 0; start < size; start++) {
        if (label[start] >= 0 || emissive[start * 4 + 3] < APERTURE_ALPHA_MIN) continue;
        const id = blobs.length;
        const blob = { area: 0, sx: 0, sy: 0, r: 0, g: 0, b: 0, x0: width, y0: height, x1: -1, y1: -1, votes: new Map() };
        let top = 0;
        stack[top++] = start;
        label[start] = id;
        while (top > 0) {
            const i = stack[--top];
            const x = i % width;
            const y = (i - x) / width;
            blob.area++;
            blob.sx += x + 0.5;
            blob.sy += y + 0.5;
            blob.r += emissive[i * 4];
            blob.g += emissive[i * 4 + 1];
            blob.b += emissive[i * 4 + 2];
            if (x < blob.x0) blob.x0 = x;
            if (y < blob.y0) blob.y0 = y;
            if (x > blob.x1) blob.x1 = x;
            if (y > blob.y1) blob.y1 = y;
            const group = groupAt(x, y);
            blob.votes.set(group, (blob.votes.get(group) || 0) + 1);
            if (x > 0 && label[i - 1] < 0 && emissive[(i - 1) * 4 + 3] >= APERTURE_ALPHA_MIN) { label[i - 1] = id; stack[top++] = i - 1; }
            if (x < width - 1 && label[i + 1] < 0 && emissive[(i + 1) * 4 + 3] >= APERTURE_ALPHA_MIN) { label[i + 1] = id; stack[top++] = i + 1; }
            if (y > 0 && label[i - width] < 0 && emissive[(i - width) * 4 + 3] >= APERTURE_ALPHA_MIN) { label[i - width] = id; stack[top++] = i - width; }
            if (y < height - 1 && label[i + width] < 0 && emissive[(i + width) * 4 + 3] >= APERTURE_ALPHA_MIN) { label[i + width] = id; stack[top++] = i + width; }
        }
        let group = APERTURE_OFF_GLASS;
        let best = -1;
        for (const [candidate, votes] of blob.votes) {
            if (votes > best || (votes === best && candidate > group)) {
                best = votes;
                group = candidate;
            }
        }
        blob.group = group;
        blobs.push(blob);
    }
    // Room glass: every blob of one room joins, whatever its size (the room
    // mask names the window). Off glass: the area filter first (a stray 3-px
    // speck never becomes a light), then the nearest same-family pairs join.
    const entries = [];
    const rooms = new Map();
    const add = (entry, blob, index) => {
        entry.area += blob.area;
        entry.sx += blob.sx;
        entry.sy += blob.sy;
        entry.r += blob.r;
        entry.g += blob.g;
        entry.b += blob.b;
        entry.x0 = Math.min(entry.x0, blob.x0);
        entry.y0 = Math.min(entry.y0, blob.y0);
        entry.x1 = Math.max(entry.x1, blob.x1);
        entry.y1 = Math.max(entry.y1, blob.y1);
        entry.first = Math.min(entry.first, index);
    };
    const open = (blob, index) => ({
        group: blob.group, area: 0, sx: 0, sy: 0, r: 0, g: 0, b: 0,
        x0: blob.x0, y0: blob.y0, x1: blob.x1, y1: blob.y1, first: index,
    });
    for (let index = 0; index < blobs.length; index++) {
        const blob = blobs[index];
        if (blob.group > 0) {
            let entry = rooms.get(blob.group);
            if (!entry) {
                entry = open(blob, index);
                rooms.set(blob.group, entry);
                entries.push(entry);
            }
            add(entry, blob, index);
        } else if (blob.group < 0 && blob.area >= APERTURE_MIN_AREA) {
            const entry = open(blob, index);
            add(entry, blob, index);
            entries.push(entry);
        }
    }
    const warm = entry => entry.r >= entry.b;
    for (;;) {
        let best = null;
        let bestD = APERTURE_MERGE_DISTANCE;
        for (let a = 0; a < entries.length; a++) {
            const p = entries[a];
            if (p.group >= 0) continue;
            for (let b = a + 1; b < entries.length; b++) {
                const q = entries[b];
                if (q.group >= 0 || warm(p) !== warm(q)) continue;
                const d = Math.hypot(p.sx / p.area - q.sx / q.area, p.sy / p.area - q.sy / q.area);
                if (d < bestD) {
                    bestD = d;
                    best = [a, b];
                }
            }
        }
        if (!best) break;
        const [a, b] = best;
        add(entries[a], entries[b], entries[b].first);
        entries.splice(b, 1);
    }
    return entries
        .sort((a, b) => a.first - b.first)
        .map((entry) => {
            const cx = entry.sx / entry.area;
            const cy = entry.sy / entry.area;
            return Object.freeze({
                key: `${Math.round(cx)}.${Math.round(cy)}`,
                group: entry.group,
                area: entry.area,
                cx,
                cy,
                x0: entry.x0,
                y0: entry.y0,
                x1: entry.x1,
                y1: entry.y1,
                color: `#${hexByte(entry.r / entry.area)}${hexByte(entry.g / entry.area)}${hexByte(entry.b / entry.area)}`,
            });
        });
}

/**
 * The per-landmark template cache. `templates(type)` returns the frozen
 * template list (empty for a landmark without an emissive sidecar), or null
 * while the sidecars load; `revision` moves whenever a list lands, so the
 * placed-source cache in BuildingSprite rebuilds once.
 */
export class ApertureLights {
    constructor(assets) {
        this.assets = assets;
        this.revision = 0;
        this._templates = new Map();
    }

    templates(type) {
        const cached = this._templates.get(type);
        if (cached !== undefined) return cached === 'loading' ? null : cached;
        const id = `building.${type}`;
        const entry = this.assets?.getEntry?.(id);
        if (!entry) return null;
        if (entry.emissiveSidecar !== true) {
            this._templates.set(type, Object.freeze([]));
            return this._templates.get(type);
        }
        const albedo = this.assets.get?.(id);
        const dims = this.assets.getDims?.(id);
        if (!albedo || !dims) return null;
        this._templates.set(type, 'loading');
        const version = this.assets.assetVersion || '';
        const emissive = this.assets.getCompanion?.(id, 'emissive') || null;
        const rects = glassRects(type);
        // Only a landmark with glass and a declared rooms mask has one to
        // read; the Portal (vortex, runes and crystals, no rooms) has none.
        const withRooms = rects.length > 0 && entry.roomsSidecar === true;
        Promise.all([
            emissive ? Promise.resolve(emissive) : loadImage(sidecarUrl(albedo, 'emissive')),
            withRooms ? loadImage(sidecarUrl(albedo, 'rooms')) : Promise.resolve(null),
        ]).then(([emissiveImage, roomsImage]) => {
            if ((this.assets.assetVersion || '') !== version) {
                this._templates.delete(type);
                return;
            }
            const width = dims.w;
            const height = dims.h;
            const emissivePx = readPixels(emissiveImage, width, height);
            const glass = emissivePx && rects.length
                ? buildGlassMap({
                    width,
                    height,
                    emissive: emissivePx,
                    rooms: roomsImage?.width === width && roomsImage?.height === height
                        ? readPixels(roomsImage, width, height)
                        : null,
                    rects,
                })
                : null;
            this._templates.set(type, Object.freeze(extractApertureTemplates({ width, height, emissive: emissivePx, glass })));
            this.revision++;
        });
        return null;
    }
}
