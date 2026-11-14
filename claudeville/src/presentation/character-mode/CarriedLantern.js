// NL-4 (look `nl4`) — a lantern carried by villagers abroad after lamp-lighting.
//
// After the village lamps are lit and the Lamplighter's Round has reached a
// villager's tile, a villager who is out of doors carries a small lantern: a
// code-drawn 6x7 stamp (a lit 2x3 core in a dark iron frame) at the hand while
// walking, set at the feet while standing, plus one small warm fixture pool.
// The lantern exists because the villager is there, never because of its
// status: no rule reads status or attention lights, and every carrier shows
// the identical stamp and pool. Rules of place only: not carried on the
// Tavern's indoor bar stools (a lit room), at a Command queue slot (its
// candle and brazier), by arrivals still pending, departed tableaux or a body
// in its removal fade. Every eligible body carries a stamp; EFFECT_BUDGET
// `carried-lanterns` caps the pools, nearest the view centre.

import { ART_RAMPS } from '../../config/artPalette.js';

// The pool, in world px of iso ground distance (x, 2y). Its courses are set by
// geometry alone (falloff 1 - smoothstep(0, radius, d) against the six
// ambient pool stops, GRADE_CONSTANTS AMBIENT_POOL_STOPS), so the radius
// decides where they land: at 44 the 0.20-weight course reaches ~29 px, the
// 0.32 course ~24 px and the 0.50 course ~19 px, clear of the body that
// covers the inner ~12 px. The intensity (before the frame's source-energy
// core and spill) sets how bright they land: an attention light is radius
// 34-40 at 0.45-0.6 on the brighter three-course landing, a street lamp
// radius 66 at 0.82.
export const LANTERN_POOL_RADIUS = 44;
// A carrier with another carrier within LANTERN_CROWD_DISTANCE (~3 tiles of
// ground distance) lays the smaller pool, so a cluster stays separate lights.
export const LANTERN_CROWD_RADIUS = 30;
export const LANTERN_CROWD_DISTANCE = 136;
export const LANTERN_INTENSITY = 0.45;
// World px of the flame above the light's foot (the carrier's own foot, so
// the 2.8 lamp casts skip its carrier: RakingLight.pointCastFor ignores a
// body under 2 px from a light's foot).
export const LANTERN_HEIGHT = 14;
export const LANTERN_COLOR = '#ffc95e';
export const LANTERN_ID_PREFIX = 'carried-lantern:';
// World px from the standing carrier's foot to the stamp's foot.
export const LANTERN_SET_DOWN = Object.freeze({ x: 9, y: 2 });
// The core is the bridge candles' authored flame amber
// (bridge.landmark.*.emissive.png), a street-lamp core's luma; the glass
// beside it the deeper work amber. Both emit (the scene reads A x 2, mixing
// toward the ungraded albedo and into bloom); the iron frame does not. The
// NEEDS YOU bell is #e8d44d, luma 207, and a waiting candle lands 192-207:
// the core must stay at most 185 at every zoom in clear, fog and wet. At the
// bridge candles' flame amber (#f2bc57) and authored alpha (0.565) it
// measured 204-222. The stamp also takes the night's pools (as a small prop,
// AgentSprite._lanternRecord), so the core is a deeper amber at a low
// emission: ~142 in the dark, <= 167 in its own and nearby pools (z1-z3,
// clear, fog and wet). Inside a street lamp's core course the pool landing
// sets the luma whatever the albedo (193-204, as a robe there).
const GLASS_AMBER = '#e8762b';
const CORE_AMBER = '#d99a45';
export const LANTERN_EMISSION_ALPHA = 0.1;
const FLAME_EMISSION = `rgba(%c, ${LANTERN_EMISSION_ALPHA})`;

const ROWS = Object.freeze([
    '..DD..',
    '.DDDD.',
    'DACCAD',
    'DACCAD',
    'DACCAD',
    '.DDDD.',
    '..DD..',
]);

let stampCache = null;

function paint(colourFor) {
    const canvas = document.createElement('canvas');
    canvas.width = ROWS[0].length;
    canvas.height = ROWS.length;
    const ctx = canvas.getContext('2d');
    ROWS.forEach((row, y) => {
        [...row].forEach((code, x) => {
            const colour = colourFor(code);
            if (!colour) return;
            ctx.fillStyle = colour;
            ctx.fillRect(x, y, 1, 1);
        });
    });
    return canvas;
}

function hexRgb(hex) {
    const n = parseInt(hex.slice(1), 16);
    return `${n >> 16}, ${(n >> 8) & 255}, ${n & 255}`;
}

// A 6x7 iron lantern: a ring, a cap, a 2x3 flame-amber core between deeper glass,
// a base. Returns a canvas whose top-centre is the ring (the hand point) and
// whose bottom row is the foot, with `__cvEmissive`, its emissive companion
// (core and glass only). Never animated.
export function carriedLanternStamp() {
    if (stampCache) return stampCache;
    if (typeof document === 'undefined') return null;
    const albedo = { D: ART_RAMPS.stone[0], A: GLASS_AMBER, C: CORE_AMBER };
    const canvas = paint(code => albedo[code] || null);
    canvas.__cvEmissive = paint(code => (code === 'A' || code === 'C'
        ? FLAME_EMISSION.replace('%c', hexRgb(albedo[code]))
        : null));
    canvas.__cvGroundKey = 'carried-lantern:7';
    stampCache = canvas;
    return canvas;
}

/**
 * One body's lantern candidate, from place and presence only (never from its
 * status or from owning an attention light): `{ id, sprite, x, y, tileX,
 * tileY, pending, departed, barStool, queued }`. `barStool`: seated on one of
 * the Tavern's indoor bar stools (a lit room; its beer-garden seats outdoors
 * keep the lantern). `queued`: standing still at a Command queue slot (the
 * queue has its candle and brazier); a body walking there keeps its lantern
 * until it arrives. `departed` / `fading`: a departed tableau, or a body in
 * its removal fade. `tileOf(x, y)` maps the foot to a tile.
 */
export function lanternCandidate(id, sprite, tileOf) {
    const x = Number.isFinite(sprite?._placeX) ? sprite._placeX : sprite?.x;
    const y = Number.isFinite(sprite?._placeY) ? sprite._placeY : sprite?.y;
    const tile = tileOf ? tileOf(x, y) : { tileX: x, tileY: y };
    const seat = sprite?._seatedSeat?.() || null;
    return {
        id,
        sprite,
        x,
        y,
        tileX: Math.round(tile.tileX),
        tileY: Math.round(tile.tileY),
        pending: sprite?.isArrivalPending?.() === true,
        // AgentGpuOverlayRenderer.departedTableau, and the removal fade.
        departed: (Boolean(sprite?.agent?.isDeparted) && !sprite?.leaving) || Boolean(sprite?._archiveAnim),
        barStool: seat?.building === 'tavern' && seat?.occluder === 'stool',
        queued: sprite?.visitRole === 'queue' && sprite?.moving !== true,
    };
}

/**
 * The frame's lantern carriers: every eligible candidate (a stamp each),
 * nearest `centre` first, so the pool cap (EFFECT_BUDGET `carried-lanterns`)
 * takes the nearest. `candidates` from `lanternCandidate`; `roundLit(tileX,
 * tileY)` is the Lamplighter's Round. Empty unless `strength > 0` and
 * `lampsLit`. Each carrier gets `crowded`: another carrier stands within
 * LANTERN_CROWD_DISTANCE.
 */
export function selectLanternCarriers(candidates, {
    strength = 0, lampsLit = false, roundLit = null, centre = null,
} = {}) {
    if (!(strength > 0) || !lampsLit || !candidates?.length) return [];
    const cx = Number(centre?.x) || 0;
    const cy = Number(centre?.y) || 0;
    const out = [];
    for (const c of candidates) {
        if (!c || c.pending || c.departed || c.barStool || c.queued) continue;
        if (!Number.isFinite(c.x) || !Number.isFinite(c.y)) continue;
        if (roundLit && roundLit(c.tileX, c.tileY) !== true) continue;
        out.push({ ...c, d: Math.hypot(c.x - cx, c.y - cy), crowded: false });
    }
    out.sort((a, b) => a.d - b.d || String(a.id).localeCompare(String(b.id)));
    for (let i = 0; i < out.length; i++) {
        for (let j = i + 1; j < out.length; j++) {
            if (Math.hypot(out[i].x - out[j].x, (out[i].y - out[j].y) * 2) < LANTERN_CROWD_DISTANCE) {
                out[i].crowded = true;
                out[j].crowded = true;
            }
        }
    }
    return out;
}

/** The pool's ground radius (world px) at look strength `strength` (> 0). */
export function lanternPoolRadius(strength, crowded = false) {
    const base = crowded ? LANTERN_CROWD_RADIUS : LANTERN_POOL_RADIUS;
    return Math.max(1, Math.round(base * (0.5 + 0.5 * Math.min(1, Math.max(0, strength)))));
}

/** The pool's intensity at look strength `strength` and source core `core`. */
export function lanternIntensity(strength, core = 1) {
    return LANTERN_INTENSITY * core * (0.5 + 0.5 * Math.min(1, Math.max(0, strength)));
}
