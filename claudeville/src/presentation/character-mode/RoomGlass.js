// 6.3 — windows count the workers.
//
// A landmark's glass is the emissive-sidecar texels under its registry
// `windowRects` and `rooms.slots` (1-texel margin, the same rule the M15 slate
// recolour and `bake-room-masks.mjs` use). `base.rooms.png` (Surfaces, 6.3)
// names each glass texel's room in R (1..N); glass with R = 0 is the hall's
// ordinary panes. Every glass texel carries its own gate:
//
//   room k      max(DAYTIME_ROOM_GLASS_SHARE, night) × (a working visitor holds room k)   (BuildingSprite.roomGlassGate)
//   hall panes  never lit: unlit slate glass at every hour
//
// Occupied rooms glow warm interior amber by day (relaxed M15, 2026-11-23
// operator decision), while empty rooms stay unlit slate glass. ApertureLights,
// water columns and bloom keep reading night-only `roomGate`.
//
// Both backends switch a pane off the same way — with the pane's own unlit
// albedo: the resident scene pass draws one "glass patch" record per landmark
// right after the landmark (same texels, no emission), and the Canvas emitter
// cut carves the same canvas out of the lit cut. The patch alpha of a group is
// 1 - gate, stepped in quarters (no smooth fade), so a canvas is rebuilt only
// when a room changes hands or crosses a quarter.
//
// W3.1 — shadow-theatre windows (spec 04 §1.5). `buildGlassMap` also classes
// every room by its tallest clean glass rectangle (`shadowClassFor`: S4 / S5 /
// S6 stamp panes, R rhythm panes on the Forge, null elsewhere) and keeps that
// rectangle. `patch` and `litPatch` take an optional `shadowFor(group)` that
// names a stamp (`RoomShadowStamps`); its ink texels are the pane's unlit
// albedo at full alpha (the dark-glass branch), clipped to the room mask and
// capped at SHADOW_INK_MAX_SHARE of the room's texels, so both backends carve
// the same silhouette out of the same lit glass.

import { getBuildingMaterial, getBuildingRoomProfile, getBuildingVisual, getBuildingWindowRects, windowRectBounds } from './BuildingVisualRegistry.js';
import { stampForShadow } from './RoomShadowStamps.js';

export const ROOM_GLASS_STEPS = 4;
// NE P3.1 — night glass steps in tenths so keeper (0.40), settling (0.50),
// routing (0.60) and worked (1.0) each land on their exact stepped rung.
export const NIGHT_ROOM_GLASS_STEPS = 10;
const NONE = -1;
const HALL = 0;

// W3.1 — the smallest clean glass a stamp may stand in (spec 04 §1.5), the
// widths a stamp class names, and the most of a room's texels ink may cover.
export const SHADOW_MIN_W = 4;
export const SHADOW_MIN_H = 7;
export const SHADOW_CLASS_WIDTHS = Object.freeze({ S4: 4, S5: 5, S6: 6 });
export const SHADOW_INK_MAX_SHARE = 0.45;

/**
 * Pure: the shadow class of one room. `cleanWidths` maps a width k to the
 * height of the room's tallest clean glass rectangle k texels wide (an object
 * or array indexed by k, or a function of k). `emissiveKind` is the kind of the
 * building's `windowRects` emissive source (BUILDING_MATERIAL_REGISTRY).
 *   'windows' (Command, Archive, Tavern, Lighthouse, Harbor): 'S6' | 'S5' | 'S4' | null
 *   'fire' on the Forge: 'R' (rhythm pane, no ink)
 *   'fire' on the Mine (an opening, not glass), 'lantern' (a lamp, not a room): null
 */
export function shadowClassFor(cleanWidths, emissiveKind, buildingType) {
    if (emissiveKind === 'fire') return buildingType === 'forge' ? 'R' : null;
    if (emissiveKind !== 'windows') return null;
    const clean = (k) => Number(typeof cleanWidths === 'function' ? cleanWidths(k) : cleanWidths?.[k]) || 0;
    for (const size of ['S6', 'S5', 'S4']) {
        const width = SHADOW_CLASS_WIDTHS[size];
        if (width >= SHADOW_MIN_W && clean(width) >= SHADOW_MIN_H) return size;
    }
    return null;
}

/** The kind of `type`'s `windowRects` emissive source, or null. */
export function windowEmissiveKind(type) {
    const sources = getBuildingMaterial(type)?.emissive?.sources || [];
    return sources.find((source) => source?.geometry === 'windowRects')?.kind || null;
}

// The tallest rectangle `k` texels wide of room `room` inside its bounding box
// (map-local), or null. Ties go to the rectangle centred nearest the room,
// then to the one standing lowest (nearest the sill).
function tallestCleanRect(group, mapW, room, box, k) {
    let best = null;
    const centre = (box.x0 + box.x1 + 1) / 2;
    for (let x = box.x0; x + k - 1 <= box.x1; x++) {
        let run = 0;
        for (let y = box.y0; y <= box.y1 + 1; y++) {
            let clean = y <= box.y1;
            for (let i = 0; clean && i < k; i++) clean = group[y * mapW + x + i] === room;
            if (clean) {
                run++;
                continue;
            }
            if (run > 0) {
                const off = Math.abs(x + k / 2 - centre);
                if (!best || run > best.h || (run === best.h && (off < best.off || (off === best.off && y > best.y + best.h)))) {
                    best = { x, y: y - run, w: k, h: run, off };
                }
            }
            run = 0;
        }
    }
    return best;
}

// Per room (index 1..rooms; [0] is the hall): `{ cls, rect, clean, texels }`.
// `rect` is the clean rectangle of the stamp's width in sprite-local texels
// (S classes only), `clean` the clean heights at widths 4, 5 and 6, `texels`
// the room's glass texel count (the ink budget's base).
function classifyRooms(group, w, h, left, top, roomCount, kind, type) {
    const out = new Array(roomCount + 1).fill(null);
    if (!(roomCount > 0)) return out;
    const boxes = Array.from({ length: roomCount + 1 }, () => ({ x0: w, y0: h, x1: -1, y1: -1, texels: 0 }));
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const room = group[y * w + x];
            if (!(room > 0)) continue;
            const box = boxes[room];
            box.texels++;
            if (x < box.x0) box.x0 = x;
            if (y < box.y0) box.y0 = y;
            if (x > box.x1) box.x1 = x;
            if (y > box.y1) box.y1 = y;
        }
    }
    for (let room = 1; room <= roomCount; room++) {
        const box = boxes[room];
        if (box.x1 < 0) continue;
        const rects = {};
        const clean = {};
        for (const k of [4, 5, 6]) {
            rects[k] = tallestCleanRect(group, w, room, box, k);
            clean[k] = rects[k]?.h || 0;
        }
        const cls = shadowClassFor(clean, kind, type);
        const width = SHADOW_CLASS_WIDTHS[cls];
        const best = width ? rects[width] : null;
        out[room] = Object.freeze({
            cls,
            rect: best ? Object.freeze({ x: best.x + left, y: best.y + top, w: best.w, h: best.h }) : null,
            clean: Object.freeze(clean),
            texels: box.texels,
        });
    }
    return out;
}

// The stamps `shadowFor(group)` asks for on this map's S-class rooms, placed
// lazily: `{ key, rooms: [{ group, room, stamp, dx }] }`, or null when no room
// carries ink. The key is `S<family><size><frame><dx>` per inked group.
function shadowPlan(map, shadowFor) {
    if (typeof shadowFor !== 'function' || !map?.roomShadows) return null;
    let plan = null;
    for (let group = 1; group <= map.rooms; group++) {
        const room = map.roomShadows[group];
        if (!room?.rect) continue;
        const desc = shadowFor(group);
        if (!desc) continue;
        const stamp = stampForShadow(desc.family, room.cls, desc.frame, room.rect.h, SHADOW_INK_MAX_SHARE * room.texels);
        if (!stamp) continue;
        const dx = Math.max(-1, Math.min(1, Math.trunc(Number(desc.dx) || 0)));
        plan ||= { key: '', rooms: [] };
        plan.key += `|${group}S${stamp.family}${stamp.size}${stamp.frame}${dx}`;
        plan.rooms.push({ group, room, stamp, dx });
    }
    return plan;
}

/**
 * Pure: the ink mask (map-local, 1 = ink) of a shadow plan. Each stamp is
 * bottom-aligned to its clean rectangle's sill row, centred on the rectangle
 * plus `dx`, ANDed with its own room's texels (a came or curtain still
 * occludes it), and dropped whole if it would cover more than
 * SHADOW_INK_MAX_SHARE of the room. `out` (optional) is a reused scratch
 * mask of the map's size.
 */
export function shadowInkMask(map, plan, out = null) {
    if (!map || !plan?.rooms?.length) return null;
    const size = map.w * map.h;
    const mask = out?.length === size ? out.fill(0) : new Uint8Array(size);
    let any = false;
    for (const { group, room, stamp, dx } of plan.rooms) {
        const left = Math.round(room.rect.x + room.rect.w / 2 + dx - stamp.width / 2) - map.left;
        const top = room.rect.y + room.rect.h - stamp.height - map.top;
        const texels = [];
        for (let y = 0; y < stamp.height; y++) {
            const my = top + y;
            if (my < 0 || my >= map.h) continue;
            const row = stamp.rows[y];
            for (let x = 0; x < stamp.width; x++) {
                const mx = left + x;
                if (row[x] !== '#' || mx < 0 || mx >= map.w) continue;
                const index = my * map.w + mx;
                if (map.group[index] === group) texels.push(index);
            }
        }
        if (!texels.length || texels.length > SHADOW_INK_MAX_SHARE * room.texels) continue;
        for (const index of texels) mask[index] = 1;
        any = true;
    }
    return any ? mask : null;
}

/** Pure: the ink mask `shadowFor` paints on `map`, or null (tests, parity checks). */
export function shadowInkFor(map, shadowFor) {
    return shadowInkMask(map, shadowPlan(map, shadowFor));
}

export function readPixels(image, w, h) {
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
export function glassRects(type) {
    return [
        ...(getBuildingWindowRects(type) || []),
        ...(getBuildingRoomProfile(type)?.slots || []),
        ...(getBuildingVisual(type)?.glassRects || []),
    ].filter((rect) => Array.isArray(rect?.at));
}

export function sidecarUrl(albedo, suffix) {
    const src = typeof albedo?.src === 'string' ? albedo.src : '';
    return src ? src.replace(/\.png(?=([?#]|$))/, `.${suffix}.png`) : '';
}

export function loadImage(url) {
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
 * be null). Returns `{ left, top, w, h, group: Int8Array, rooms, roomShadows,
 * shadowRooms }` in the sprite's local texels, or null when the landmark has
 * no glass. `group` is -1 off glass, 0 on hall panes, k (1..rooms) on room k.
 * `roomShadows[k]` is room k's `{ cls, rect, clean, texels }` (W3.1, from
 * `kind`, the `windowRects` emissive kind, and `type`); `shadowRooms` counts
 * the rooms with a class (S or R).
 */
export function buildGlassMap({ width, height, emissive, rooms = null, rects = [], kind = null, type = null }) {
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
    const roomShadows = classifyRooms(group, w, h, x0, y0, roomCount, kind, type);
    const shadowRooms = roomShadows.filter((room) => room?.cls).length;
    return { left: x0, top: y0, w, h, group, rooms: roomCount, roomShadows, shadowRooms };
}

/** Lit share of a group, stepped in quarters: 0 dark … 1 lit. */
export function litStep(gate) {
    const lit = Math.max(0, Math.min(1, Number(gate) || 0));
    return Math.round(lit * ROOM_GLASS_STEPS) / ROOM_GLASS_STEPS;
}

/** Unlit share of a group, stepped in quarters: 0 lit … 1 dark. */
export function unlitStep(gate) {
    return 1 - litStep(gate);
}

/** Night lit share of a group, stepped in tenths so 0.40 / 0.60 / 1.0 stay distinct (NE P3.1). */
export function nightLitStep(gate) {
    const lit = Math.max(0, Math.min(1, Number(gate) || 0));
    return Math.round(lit * NIGHT_ROOM_GLASS_STEPS) / NIGHT_ROOM_GLASS_STEPS;
}

// Hall glass is always dark. A room starts lighting before its painted quarter-step changes.
export function roomGlintMask(buildings, type, glass) {
    const map = glass && buildings?.roomGlass?.map(type);
    if (!map?.emissive) return null;
    const groups = Array.from({ length: map.rooms + 1 }, (_, group) =>
        group === 0 || buildings.roomGlassGate(type, group - 1) === 0 ? '1' : '0').join('');
    if (map.glintMask?.key === groups) return map.glintMask;
    const data = new Uint8Array(map.w * map.h);
    for (let y = 0; y < map.h; y++) {
        for (let x = 0; x < map.w; x++) {
            const i = y * map.w + x;
            if (groups[map.group[i]] === '1') {
                data[i] = map.emissive[((map.top + y) * map.spriteWidth + map.left + x) * 4 + 3];
            }
        }
    }
    const mask = { data, key: groups, map };
    map.glintMask = mask;
    return mask;
}

export class RoomGlass {
    constructor(assets) {
        this.assets = assets;
        this._maps = new Map();
        this._patches = new Map();
        this._litPatches = new Map();
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
            const emissivePixels = readPixels(emissiveImage, width, height);
            const map = buildGlassMap({
                width,
                height,
                emissive: emissivePixels,
                rooms: roomsImage?.width === width && roomsImage?.height === height
                    ? readPixels(roomsImage, width, height)
                    : null,
                rects,
                kind: windowEmissiveKind(type),
                type,
            });
            if (map) {
                map.albedo = readPixels(albedo, width, height);
                map.emissive = emissivePixels;
                map.spriteWidth = width;
                map.channels = {
                    material: this._crop(this.assets.getCompanion?.(id, 'material'), map),
                    occluder: this._crop(this.assets.getCompanion?.(id, 'occluder'), map),
                };
                const material = map.channels.material;
                if (material) map.materialPixels = material.getContext('2d').getImageData(0, 0, map.w, map.h);
            }
            this._maps.set(type, map);
        });
        return null;
    }

    roomCount(type) {
        return this.map(type)?.rooms || 0;
    }

    // True once `map(type)` has its final answer (a map, or null for a
    // landmark without authored glass), false while it loads.
    resolved(type) {
        const cached = this._maps.get(type);
        return cached !== undefined && cached !== 'loading';
    }

    _crop(image, map) {
        if (!image || typeof document === 'undefined') return null;
        const canvas = document.createElement('canvas');
        canvas.width = map.w;
        canvas.height = map.h;
        canvas.getContext('2d', { willReadFrequently: true }).drawImage(image, map.left, map.top, map.w, map.h, 0, 0, map.w, map.h);
        return canvas;
    }

    /**
     * The glass patch of `type`: `{ canvas, left, top, w, h, key, revision,
     * hasDaytimeLit, channels }`, or null when every pane is fully night-lit
     * and no room carries a shadow stamp.
     * `gateFor(group)` returns the group's glass lit share (0 hall, 1..N rooms).
     * When `nightGateFor(group)` is supplied and a group is lit by day
     * (`lit > 0`, `night < 0.5`), its emissive texels paint warm interior amber
     * blended from `base.emissive.png` at `lit` share with zero emission/bloom
     * (relaxed M15, 2026-11-23 operator decision). At dusk/night (`night >= 0.5`)
     * or for dark panes, it paints unlit slate `albedo` at `1 - lit`.
     * W3.1 — `shadowFor(group)` (optional) returns a room's stamp descriptor
     * `{ family, frame, dx }` or null: its ink texels paint unlit `albedo` at
     * full alpha whatever the group's share, and any ink makes a patch even
     * when every pane is fully lit.
     */
    patch(type, gateFor, nightGateFor = null, shadowFor = null, rhythmFor = null) {
        const map = this.map(type);
        if (!map?.albedo) return null;
        const unlitSteps = new Array(map.rooms + 1);
        const dayShares = new Array(map.rooms + 1);
        let key = '';
        let any = false;
        let hasDaytimeLit = false;
        for (let group = 0; group <= map.rooms; group++) {
            const rawGate = gateFor(group);
            const rawNight = nightGateFor ? nightGateFor(group) : rawGate;
            const night = nightLitStep(rawNight);
            const lit = night > 0 ? nightLitStep(rawGate) * (rhythmFor?.(group) ?? 1) : litStep(rawGate);
            if (lit > 0 && night === 0 && map.emissive) {
                dayShares[group] = lit;
                unlitSteps[group] = 0;
                hasDaytimeLit = true;
                any = true;
                key += `D${Math.round(lit * ROOM_GLASS_STEPS)}`;
            } else {
                dayShares[group] = 0;
                unlitSteps[group] = 1 - lit;
                if (unlitSteps[group] > 0) any = true;
                key += `U${lit}`;
            }
        }
        const plan = shadowPlan(map, shadowFor);
        if (plan) {
            key += plan.key;
            any = true;
        }
        if (!any) return null;
        let entry = this._patches.get(type);
        if (entry?.key === key) return entry;
        if (!entry) {
            const canvas = document.createElement('canvas');
            canvas.width = map.w;
            canvas.height = map.h;
            entry = {
                canvas,
                left: map.left,
                top: map.top,
                w: map.w,
                h: map.h,
                key: '',
                revision: 0,
                hasDaytimeLit: false,
                channels: map.channels,
            };
            this._patches.set(type, entry);
        }
        const ctx = entry.canvas.getContext('2d', { willReadFrequently: true });
        // One ImageData and ink scratch per landmark, cleared per rebuild: a
        // budgeted shadow rebuild (W3.1) allocates nothing.
        if (entry.image?.width !== map.w || entry.image?.height !== map.h) entry.image = ctx.createImageData(map.w, map.h);
        const image = entry.image;
        const out = image.data;
        out.fill(0);
        const src = map.albedo;
        const em = map.emissive;
        const ink = shadowInkMask(map, plan, plan ? (map.inkScratch ||= new Uint8Array(map.w * map.h)) : null);
        for (let y = 0; y < map.h; y++) {
            for (let x = 0; x < map.w; x++) {
                const group = map.group[y * map.w + x];
                if (group === NONE) continue;
                const i = ((y + map.top) * map.spriteWidth + x + map.left) * 4;
                const o = (y * map.w + x) * 4;
                const dayShare = ink?.[y * map.w + x] ? 0 : dayShares[group] || 0;
                if (dayShare > 0 && em) {
                    if (em[i + 3] > 0) {
                        out[o] = Math.round(src[i] + (em[i] - src[i]) * dayShare);
                        out[o + 1] = Math.round(src[i + 1] + (em[i + 1] - src[i + 1]) * dayShare);
                        out[o + 2] = Math.round(src[i + 2] + (em[i + 2] - src[i + 2]) * dayShare);
                        out[o + 3] = src[i + 3];
                    }
                    continue;
                }
                const step = ink?.[y * map.w + x] ? 1 : unlitSteps[group] ?? 1;
                if (!(step > 0)) continue;
                const alphaByte = Math.round(src[i + 3] * step);
                // Keep dark glass pixels out of scene.js's half-alpha `bakedRim`
                // branch (`0.4 < a < 0.6 && max(rgb) < 0.16`), which clamps alpha to 1.
                const rimGuard = alphaByte >= 102 && alphaByte <= 153
                    && Math.max(src[i], src[i + 1], src[i + 2]) < 42;
                out[o] = rimGuard ? 42 : src[i];
                out[o + 1] = src[i + 1];
                out[o + 2] = src[i + 2];
                out[o + 3] = alphaByte;
            }
        }
        ctx.putImageData(image, 0, 0);
        entry.key = key;
        entry.hasDaytimeLit = hasDaytimeLit;
        entry.revision++;
        return entry;
    }

    /**
     * NE P3.1 — night-lit room panes when a landmark's base emissive gate is
     * down (0 arrived workers: keeper at 0.40 or routing at 0.60, or a banked
     * hearth). Paints only rooms with stepped night gate > 0: albedo at alpha
     * = srcA * step and full authored emissive, so GPU premultiplied blend and
     * Canvas `buildEmitterCut` both land on `step * worked + (1 - step) * dark`
     * without illuminating off-glass emitters. Returns null when no room is lit.
     * W3.1 — `shadowFor(group)` (optional, as in `patch`): ink texels are left
     * empty (no albedo, no emissive), so the all-unlit base patch under this
     * part shows the same silhouette `patch` paints when the gate is up.
     */
    litPatch(type, nightGateFor, shadowFor = null, rhythmFor = null) {
        const map = this.map(type);
        if (!map?.albedo || !map?.emissive || !(map.rooms > 0)) return null;
        const steps = new Array(map.rooms + 1).fill(0);
        let key = '';
        let any = false;
        for (let group = 1; group <= map.rooms; group++) {
            const step = nightLitStep(nightGateFor(group)) * (rhythmFor?.(group) ?? 1);
            steps[group] = step;
            if (step > 0) any = true;
            key += `${step},`;
        }
        if (!any) return null;
        const plan = shadowPlan(map, shadowFor);
        if (plan) key += plan.key;
        let entry = this._litPatches.get(type);
        if (entry?.key === key) return entry;
        if (!entry) {
            const canvas = document.createElement('canvas');
            canvas.width = map.w;
            canvas.height = map.h;
            const emissiveCanvas = document.createElement('canvas');
            emissiveCanvas.width = map.w;
            emissiveCanvas.height = map.h;
            entry = {
                canvas,
                emissiveCanvas,
                left: map.left,
                top: map.top,
                w: map.w,
                h: map.h,
                key: '',
                revision: 0,
                channels: map.channels,
            };
            this._litPatches.set(type, entry);
        }
        const ctx = entry.canvas.getContext('2d', { willReadFrequently: true });
        const ectx = entry.emissiveCanvas.getContext('2d', { willReadFrequently: true });
        if (entry.albedoImage?.width !== map.w || entry.albedoImage?.height !== map.h) {
            entry.albedoImage = ctx.createImageData(map.w, map.h);
            entry.emissiveImage = ectx.createImageData(map.w, map.h);
        }
        const aImg = entry.albedoImage;
        const eImg = entry.emissiveImage;
        const aOut = aImg.data;
        const eOut = eImg.data;
        aOut.fill(0);
        eOut.fill(0);
        const src = map.albedo;
        const em = map.emissive;
        const ink = shadowInkMask(map, plan, plan ? (map.inkScratch ||= new Uint8Array(map.w * map.h)) : null);
        for (let y = 0; y < map.h; y++) {
            for (let x = 0; x < map.w; x++) {
                const group = map.group[y * map.w + x];
                if (!(group > 0)) continue;
                const step = steps[group];
                if (!(step > 0) || ink?.[y * map.w + x]) continue;
                const i = ((y + map.top) * map.spriteWidth + x + map.left) * 4;
                if (!(em[i + 3] > 0) || !(src[i + 3] > 0)) continue;
                const o = (y * map.w + x) * 4;
                const alphaByte = Math.round(src[i + 3] * step);
                // Keep dark glass pixels (e.g. Mine tunnel mouth) out of scene.js's
                // half-alpha `bakedRim` branch (`0.4 < a < 0.6 && max(rgb) < 0.16`).
                const rimGuard = alphaByte >= 102 && alphaByte <= 153
                    && Math.max(src[i], src[i + 1], src[i + 2]) < 42;
                aOut[o] = rimGuard ? 42 : src[i];
                aOut[o + 1] = src[i + 1];
                aOut[o + 2] = src[i + 2];
                aOut[o + 3] = alphaByte;
                eOut[o] = em[i];
                eOut[o + 1] = em[i + 1];
                eOut[o + 2] = em[i + 2];
                eOut[o + 3] = em[i + 3];
            }
        }
        ctx.putImageData(aImg, 0, 0);
        ectx.putImageData(eImg, 0, 0);
        entry.key = key;
        entry.revision++;
        return entry;
    }
}
