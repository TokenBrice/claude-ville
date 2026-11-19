// NL-3 (look `nl3`) — the lamp throws the villager's own silhouette.
//
// On the resident path, while the silhouette mode is on (RakingLight
// `setLampSilhouetteMode`: look `nl3` > 0 and EFFECT_BUDGET
// `lamp-silhouettes` on), a body that `pointCastFor` gives a lamp this frame
// (the same pick, cap of 24 nearest the view centre and pool rule as the
// stepped trails it replaces) lays its own current frame down on the ground,
// anchored at its feet and pointing away from the lamp's foot, as long as
// the lamp's height and distance make it (head reach = body height x
// distance / lamp height), ending inside the pool (POINT_CAST_POOL_RIM), in
// one flat course with a Bayer-dithered last 20 % on the world grid.
//
// Record scheme. The silhouette is read from the body's own cell in the
// packed agent frame atlas (its record's source rect after
// `packGpuAgentFrameAtlas`), so it never takes an atlas slot of its own.
// Every silhouette is inverse-mapped on the art grid into a mask; bodies
// whose shadow rects overlap share one mask, so two overlapping shadows
// darken a texel once. Each mask is one `ground:lampshade:<n>` record in the
// ground band, before every body's contact shadow, ring and candle (those
// paint over it, never under it), with the 2.9 `groundCast` water rule. A
// mask texel is cleared over water, on any building, tree or tall prop
// (never up a wall) and within LAMP_SHADOW_CLEARANCE world px of a
// building's footprint (never over a building's contact shade).
//
// Strength: the record's alpha is LAMP_SHADOW_ALPHA x `nl3`.

import { POINT_CAST_RGB } from './RakingLight.js';
import { materialClassId } from './gpu/GpuWorldPolicy.js';

export const LAMP_SHADOW_ALPHA = 0.7;
// The share of the shadow's reach whose texels dither out to the tip.
export const LAMP_SHADOW_TIP = 0.2;
// World px of clearance round a building footprint (its contact shade).
export const LAMP_SHADOW_CLEARANCE = 4;
// A lamp lower than this (a fire at its own foot) counts as this high.
const MIN_LAMP_HEIGHT = 10;
const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

function bayer(x, y) {
    return (BAYER4[((y & 3) << 2) | (x & 3)] + 0.5) / 16;
}

/**
 * The silhouette geometry of one body: unit ground direction away from the
 * lamp (gx, gy; iso ground y doubled), the reach of the head's shadow in
 * ground px, and `k` = ground px of shadow per px of body height.
 */
export function silhouetteGeometry(cast, bodyHeight) {
    const len = Math.hypot(cast.dx, cast.dy);
    if (!(len > 0) || !(bodyHeight > 0)) return null;
    const gx = cast.dx / len;
    const gy = cast.dy / len;
    const lampHeight = Math.max(MIN_LAMP_HEIGHT, Number(cast.height) || 0);
    const reach = Math.min(bodyHeight * cast.distance / lampHeight, cast.room);
    if (!(reach >= 4)) return null;
    return { gx, gy, reach, k: reach / bodyHeight };
}

/**
 * Inverse-maps one body's opaque texels onto the ground. `alphaAt(bx, by)`
 * reads the body's frame at world px; `footX/footY` its foot; `rect` its
 * drawn world rect. Calls `plot(tx, ty)` for every world texel the
 * silhouette covers (tip dither applied). Pure; exported for tests.
 */
export function rasterSilhouette({ footX, footY, rect, top, geometry, alphaAt, plot }) {
    const { gx, gy, k, reach } = geometry;
    const bodyHeight = footY - top;
    // The shadow's world rect: the four corners of the body rect laid down.
    const corners = [
        [rect.x - footX, 0], [rect.x + rect.width - footX, 0],
        [rect.x - footX, bodyHeight], [rect.x + rect.width - footX, bodyHeight],
    ].map(([a, z]) => [footX + a * -gy + z * k * gx, footY + a * gx / 2 + z * k * gy / 2]);
    const x0 = Math.floor(Math.min(...corners.map(c => c[0])));
    const x1 = Math.ceil(Math.max(...corners.map(c => c[0])));
    const y0 = Math.floor(Math.min(...corners.map(c => c[1])));
    const y1 = Math.ceil(Math.max(...corners.map(c => c[1])));
    for (let ty = y0; ty <= y1; ty++) {
        for (let tx = x0; tx <= x1; tx++) {
            const ox = tx + 0.5 - footX;
            const oy = ty + 0.5 - footY;
            // Inverse of o = a * (-gy, gx / 2) + z * k * (gx, gy / 2).
            const a = -gy * ox + 2 * gx * oy;
            const z = (gx * ox + 2 * gy * oy) / k;
            if (z < 0 || z > bodyHeight) continue;
            const along = z * k / reach;
            if (along > 1 - LAMP_SHADOW_TIP
                && bayer(tx, ty) > (1 - along) / LAMP_SHADOW_TIP) continue;
            if (alphaAt(footX + a, footY - z) < 0.3) continue;
            plot(tx, ty, { x0, y0, x1, y1 });
        }
    }
    return { x0, y0, x1, y1 };
}

// ─── records ────────────────────────────────────────────────────────────────
//
// Caches. A silhouette is rasterized once, foot-relative, per content key:
// the frame drawn in the body's atlas cell (the packer's frame key, or its
// walk-strip key and frame: facing is part of either), its offset from the
// foot and its lamp bucket (the direction from the lamp in 1/16-rad buckets,
// the distance, height and room in 2-px buckets). Only standing bodies get a
// silhouette (a walking body keeps its stepped trail, RakingLight
// `pointCastFor`), so a standing body reuses its raster every frame and
// re-rasters only when its frame changes (an idle breath, a glance, a turn).
// LRU of RASTER_CACHE_MAX keys. The atlas pixels are read (getImageData)
// only for a key not in the cache. A group's mask canvas is redrawn and
// re-uploaded when a member's key or foot, the footprints or the coast
// change. Canvases are reused by index and released past this frame's group count.

const _canvases = [];
const _rasters = new Map();
const RASTER_CACHE_MAX = 64;
const ANGLE_BUCKETS = 16;
const REACH_BUCKET = 2;

export function lampSilhouetteCacheStats() {
    let bytes = 0;
    for (const slot of _canvases) bytes += slot.canvas.width * slot.canvas.height * 4;
    let texels = 0;
    for (const entry of _rasters.values()) texels += entry.texels.length / 2;
    return { canvases: _canvases.length, canvasBytes: bytes, rasters: _rasters.size, cachedTexels: texels };
}

function readFrame(record) {
    const ctx = record.source?.getContext?.('2d', { willReadFrequently: true });
    if (!ctx) return null;
    const w = Math.max(1, Math.round(record.sw));
    const h = Math.max(1, Math.round(record.sh));
    const data = ctx.getImageData(Math.round(record.sx), Math.round(record.sy), w, h).data;
    const alpha = new Uint8Array(w * h);
    let top = h;
    for (let i = 0; i < w * h; i++) {
        alpha[i] = data[i * 4 + 3];
        if (alpha[i] > 76 && Math.floor(i / w) < top) top = Math.floor(i / w);
    }
    return { w, h, alpha, top };
}

/** The bucketed cast a cached silhouette is keyed on. */
export function bucketCast(cast) {
    const angle = Math.round(Math.atan2(cast.dy, cast.dx) * ANGLE_BUCKETS / (Math.PI * 2));
    const theta = angle * (Math.PI * 2) / ANGLE_BUCKETS;
    return {
        angle,
        dx: Math.cos(theta),
        dy: Math.sin(theta),
        distance: Math.round(cast.distance / REACH_BUCKET) * REACH_BUCKET,
        height: Math.round(Number(cast.height) || 0),
        room: Math.floor(cast.room / REACH_BUCKET) * REACH_BUCKET,
    };
}

function bodySilhouette(record, cast, contentKey, footX, footY) {
    const b = bucketCast(cast);
    const key = `${contentKey}|${record.sw}x${record.sh}|${Math.round(record.x - footX)},${Math.round(record.y - footY)}|${b.angle}|${b.distance}|${b.height}|${b.room}`;
    const cached = _rasters.get(key);
    if (cached) {
        _rasters.delete(key);
        _rasters.set(key, cached);
        return cached;
    }
    const frame = readFrame(record);
    const entry = { key, texels: [], box: null };
    if (frame) {
        const scaleX = record.sw / record.width;
        const scaleY = record.sh / record.height;
        const rect = { x: record.x - footX, y: record.y - footY, width: record.width, height: record.height };
        const top = rect.y + frame.top / scaleY;
        const geometry = silhouetteGeometry(b, -top);
        if (geometry) {
            entry.box = rasterSilhouette({
                footX: 0, footY: 0, rect, top, geometry,
                alphaAt: (bx, by) => {
                    const u = Math.floor((bx - rect.x) * scaleX);
                    const v = Math.floor((by - rect.y) * scaleY);
                    if (u < 0 || v < 0 || u >= frame.w || v >= frame.h) return 0;
                    return frame.alpha[v * frame.w + u] / 255;
                },
                plot: (tx, ty) => { entry.texels.push(tx, ty); },
            });
        }
    }
    _rasters.set(key, entry);
    while (_rasters.size > RASTER_CACHE_MAX) _rasters.delete(_rasters.keys().next().value);
    return entry;
}

// Per field cell (4 world px): 1 clear, 2 blocked (water at the cell's
// centre, any occluder in it, or a building within the clearance), cached
// per footprint identity and revision and coast identity.
let _blockCache = null;

function blocked(field, coast, wx, wy) {
    if (!field?.data) return Boolean(coast?.signedDistanceAtWorld && coast.signedDistanceAtWorld(wx, wy) > 0);
    const { originX, originY, width, height, cell, data } = field;
    const cx = Math.floor((wx - originX) / cell);
    const cy = Math.floor((wy - originY) / cell);
    if (cx < 0 || cy < 0 || cx >= width || cy >= height) return true;
    if (!_blockCache || _blockCache.field !== field || _blockCache.revision !== field.revision || _blockCache.coast !== coast) {
        _blockCache = { field, revision: field.revision, coast, cells: new Uint8Array(width * height) };
    }
    const index = cy * width + cx;
    let state = _blockCache.cells[index];
    if (!state) {
        state = 1;
        if (data[index * 2] > 0) state = 2;
        if (state === 1 && coast?.signedDistanceAtWorld
            && coast.signedDistanceAtWorld(originX + (cx + 0.5) * cell, originY + (cy + 0.5) * cell) > 0) state = 2;
        const reach = Math.ceil(LAMP_SHADOW_CLEARANCE / cell);
        for (let dy = -reach; dy <= reach && state === 1; dy++) {
            for (let dx = -reach; dx <= reach; dx++) {
                const x = cx + dx;
                const y = cy + dy;
                if (x < 0 || y < 0 || x >= width || y >= height) continue;
                if (data[(y * width + x) * 2 + 1] > 0) { state = 2; break; }
            }
        }
        _blockCache.cells[index] = state;
    }
    return state === 2;
}

/**
 * The frame's silhouette records for `bodies` = [{ agentId, sprite, record,
 * cast, contentKey }] (the body's packed V9 record, its RakingLight pick and
 * the key of the frame in its atlas cell). Returns records.
 */
export function lampSilhouetteRecords(bodies, { strength = 0, field = null, coast = null } = {}) {
    if (!(strength > 0) || !bodies?.length || typeof document === 'undefined') {
        releaseLampSilhouettes();
        return [];
    }
    const shadows = [];
    for (const { sprite, record, cast, contentKey } of bodies) {
        const footX = Math.round(Number.isFinite(sprite._placeX) ? sprite._placeX : sprite.x);
        const footY = Math.round(Number.isFinite(sprite._placeY) ? sprite._placeY : sprite.y);
        const entry = bodySilhouette(record, cast, contentKey, footX, footY);
        if (!entry.box || !entry.texels.length) continue;
        shadows.push({
            entry, footX, footY,
            box: { x0: entry.box.x0 + footX, y0: entry.box.y0 + footY, x1: entry.box.x1 + footX, y1: entry.box.y1 + footY },
            key: `${entry.key}@${footX},${footY}`,
        });
    }
    // Overlapping shadows share one mask (a texel darkens once).
    const clusters = [];
    for (const shadow of shadows) {
        let home = null;
        for (const cluster of clusters) {
            const b = cluster.box;
            if (shadow.box.x0 <= b.x1 && shadow.box.x1 >= b.x0 && shadow.box.y0 <= b.y1 && shadow.box.y1 >= b.y0) {
                if (!home) {
                    home = cluster;
                    home.members.push(shadow);
                    b.x0 = Math.min(b.x0, shadow.box.x0); b.y0 = Math.min(b.y0, shadow.box.y0);
                    b.x1 = Math.max(b.x1, shadow.box.x1); b.y1 = Math.max(b.y1, shadow.box.y1);
                } else {
                    home.members.push(...cluster.members);
                    home.box.x0 = Math.min(home.box.x0, b.x0); home.box.y0 = Math.min(home.box.y0, b.y0);
                    home.box.x1 = Math.max(home.box.x1, b.x1); home.box.y1 = Math.max(home.box.y1, b.y1);
                    cluster.members = null;
                }
            }
        }
        for (let i = clusters.length - 1; i >= 0; i--) if (!clusters[i].members) clusters.splice(i, 1);
        if (!home) clusters.push({ box: { ...shadow.box }, members: [shadow] });
    }
    const out = [];
    const fieldRevision = field?.revision;
    clusters.forEach((cluster, index) => {
        const { x0, y0, x1, y1 } = cluster.box;
        const w = x1 - x0 + 1;
        const h = y1 - y0 + 1;
        const key = cluster.members.map(m => m.key).join(';');
        let slot = _canvases[index];
        if (!slot) slot = _canvases[index] = { canvas: document.createElement('canvas'), key: '', revision: 0 };
        if (slot.key !== key || slot.field !== field || slot.fieldRevision !== fieldRevision || slot.coast !== coast) {
            slot.canvas.width = w;
            slot.canvas.height = h;
            const ctx = slot.canvas.getContext('2d');
            const image = ctx.createImageData(w, h);
            for (const member of cluster.members) {
                const texels = member.entry.texels;
                for (let i = 0; i < texels.length; i += 2) {
                    const tx = texels[i] + member.footX;
                    const ty = texels[i + 1] + member.footY;
                    if (blocked(field, coast, tx + 0.5, ty + 0.5)) continue;
                    const p = ((ty - y0) * w + (tx - x0)) * 4;
                    image.data[p] = POINT_CAST_RGB[0];
                    image.data[p + 1] = POINT_CAST_RGB[1];
                    image.data[p + 2] = POINT_CAST_RGB[2];
                    image.data[p + 3] = 255;
                }
            }
            ctx.putImageData(image, 0, 0);
            slot.key = key;
            slot.field = field;
            slot.fieldRevision = fieldRevision;
            slot.coast = coast;
            slot.revision++;
        }
        const id = `ground:lampshade:${index}`;
        out.push({
            id,
            stableKey: id,
            textureKey: id,
            textureRevision: `${id}:${slot.revision}`,
            source: slot.canvas,
            sourceWidth: w,
            sourceHeight: h,
            sx: 0,
            sy: 0,
            sw: w,
            sh: h,
            x: x0,
            y: y0,
            width: w,
            height: h,
            alpha: LAMP_SHADOW_ALPHA * Math.min(1, strength),
            material: materialClassId('default'),
            elevation: 0,
            occluder: 0,
            emissive: 0,
            groundCast: true,
            sourceKind: 'individual',
            pageable: false,
            // How many bodies' shadows this one mask holds.
            castCount: cluster.members.length,
        });
    });
    releaseCanvases(clusters.length);
    return out;
}

function releaseCanvases(keep) {
    while (_canvases.length > keep) {
        const slot = _canvases.pop();
        slot.canvas.width = 0;
        slot.canvas.height = 0;
    }
}

/** Drops every cached silhouette and mask (the look or the zoom gate is off). */
export function releaseLampSilhouettes() {
    _rasters.clear();
    releaseCanvases(0);
}
