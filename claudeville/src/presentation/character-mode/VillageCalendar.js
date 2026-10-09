// W6.10 (AW-P10) — the village calendar: static, date-keyed dressing laid into
// the prop pass, and the one local-date key W7.8's dusk ledger shares.
//
// The table lives in `config/villageCalendar.js`. This module resolves it for
// a local date (pure, so tests pin dates without a DOM) and owns the sorted
// prop sprites the renderer folds into its static prop set. The sprite set
// never changes after init: a dressing outside its window simply paints
// nothing, and `update()` repaints (invalidates) only the sprites whose
// answer changed, which happens at most once a local midnight (and, for the
// midsummer bonfire, when the village lamps light or go out). No dressing
// moves, blinks or reads agent state; the bonfire is the one dressing that
// lights, a `lamps` fixture like the Command braziers.
//
// Most dressings are authored PixelLab props (manifest `prop.festival.*`,
// W8.4b) drawn through the renderer's sprite host at the whole-px origin
// `calendarPropTile` snaps. The gate garland and the door wreaths stay small
// code-drawn pixel art in whole world px (one art texel): a swag tied to the
// gatehouse lanterns and a 7-texel wreath have no sprite-sized equivalent.

import {
    CHRONICLE_DRESSING_ANCHORS,
    VILLAGE_CALENDAR_DRESSINGS,
    VILLAGE_OCCASIONS,
} from '../../config/villageCalendar.js';
import { VILLAGE_GATE, VILLAGE_GATE_GEOMETRY } from '../../config/townPlan.js';
import { StaticPropSprite, lineOcclusionColumns } from './StaticPropDrawables.js';
import { TILE_HALF_HEIGHT, TILE_HALF_WIDTH, tileToWorld, worldToTile } from './Projection.js';
import { WALL_SPEC } from './VillageWall.js';

/** Local `YYYY-MM-DD` for a Date or epoch ms (the day the calendar dresses). */
export function calendarDayKey(now = Date.now()) {
    const date = now instanceof Date ? now : new Date(now);
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${date.getFullYear()}-${month}-${day}`;
}

/** Epoch ms of the local midnight that ends the day holding `now`. */
export function nextLocalMidnight(now = Date.now()) {
    const date = now instanceof Date ? new Date(now.getTime()) : new Date(now);
    date.setHours(24, 0, 0, 0);
    return date.getTime();
}

function monthDay(date) {
    return (date.getMonth() + 1) * 100 + date.getDate();
}

/** Whether occasion `id` holds on the local day of `date`. */
export function occasionActive(id, date, occasions = VILLAGE_OCCASIONS) {
    const occasion = occasions[id];
    if (!occasion) return false;
    const day = date instanceof Date ? date : new Date(date);
    if (occasion.weekdays) return occasion.weekdays.includes(day.getDay());
    const md = monthDay(day);
    const from = occasion.from[0] * 100 + occasion.from[1];
    const to = occasion.to[0] * 100 + occasion.to[1];
    return from <= to ? md >= from && md <= to : md >= from || md <= to;
}

/** The occasions holding on `date`, in table order. */
export function calendarOccasionsAt(date, occasions = VILLAGE_OCCASIONS) {
    return Object.keys(occasions).filter((id) => occasionActive(id, date, occasions));
}

/**
 * The dressing rows laid out on `date`. A row whose anchor the Chronicle owns
 * is never laid (the anchors are disjoint by construction; this is the
 * guard), and one anchor carries at most one dressing (the first in table
 * order).
 */
export function calendarDressingAt(date, dressings = VILLAGE_CALENDAR_DRESSINGS, occasions = VILLAGE_OCCASIONS) {
    const live = new Set(calendarOccasionsAt(date, occasions));
    const claimed = new Set(CHRONICLE_DRESSING_ANCHORS);
    const out = [];
    for (const row of dressings) {
        if (!live.has(row.occasion) || claimed.has(row.anchor)) continue;
        claimed.add(row.anchor);
        out.push(row);
    }
    return out;
}

// ── Stamps ──────────────────────────────────────────────────────────────────
const CORD = '#3a2a1e';
const BULBS = Object.freeze(['#d9473a', '#f0c04a', '#5fae5a', '#e98a3a', '#f0c04a']);
// The same bulbs burning: each tone lifted toward the lamp glass (EM ramp).
const BULBS_LIT = Object.freeze(['#ff8a6a', '#ffe9a0', '#b4f08c', '#ffbe6e', '#ffe9a0']);
const GLOW_EMISSIVE_ALPHA = 144 / 255;
const BLOSSOM = Object.freeze(['#f4c6d4', '#fff1f4', '#e9a3bb']);
const LEAF = '#4f7f36';
const PINE = Object.freeze({ light: '#3f8a52', mid: '#2e6b45', dark: '#1f4a35' });
const BOW = Object.freeze({ light: '#e05a4a', dark: '#a32a2a' });
const FLAME = Object.freeze({ rim: '#ff8a33', mid: '#ffbc62', core: '#ffe9b8' });

function px(ctx, color, x, y, w = 1, h = 1) {
    ctx.fillStyle = color;
    ctx.fillRect(Math.round(x), Math.round(y), w, h);
}

// The gatehouse's festoon: a cord tied to the bracket arms of the two wall
// lanterns on the block face (VILLAGE_GATE_GEOMETRY.lanternX, the arm tip
// where `_villageGateLanternSprites` hangs `drawWallLantern`) and pinned at
// the arch's keystone, so it swags in two scallops round the arch ring and
// never across the passage. Each end rests on its arm `GARLAND_TIE` columns
// in from the tip, so the cord leaves the bracket rather than the glass.
// Bulbs or blossom hang every 5 px; a bow (lights) or rosette (blossom)
// marks the pin.
const GARLAND_TIE = 2;
const GARLAND_KEYSTONE_Z = 54;
const GARLAND_SAG = 7;
function gateGarlandPoints() {
    const G = VILLAGE_GATE_GEOMETRY;
    const reach = WALL_SPEC.lanternReach;
    const [west, east] = G.lanternX.map((dx) => {
        const base = tileToWorld(VILLAGE_GATE.tileX + dx, VILLAGE_GATE.tileY + G.blockHalfDepth);
        const tipX = Math.round(base.x) - reach;
        const tipY = Math.round(base.y) + Math.floor(reach / 2) - WALL_SPEC.lanternArmH;
        return { x: tipX + GARLAND_TIE, y: tipY - Math.floor(GARLAND_TIE / 2) - 1 };
    });
    const face = tileToWorld(VILLAGE_GATE.tileX, VILLAGE_GATE.tileY + G.blockHalfDepth);
    const pin = { x: Math.round(face.x), y: Math.round(face.y) - GARLAND_KEYSTONE_Z };
    return [west, pin, east];
}

// `lit`: the bulbs burn (the `lamps` gate). `emissive`: paint only the lit
// bulbs, at the wall lanterns' emissive contribution (drawWallLantern).
function paintGateGarland(ctx, variant, { lit = false, emissive = false } = {}) {
    const points = gateGarlandPoints();
    const bulbs = lit ? BULBS_LIT : BULBS;
    if (emissive) ctx.globalAlpha = GLOW_EMISSIVE_ALPHA;
    let k = 0;
    let i = 0;
    for (let s = 0; s < points.length - 1; s++) {
        const a = points[s];
        const b = points[s + 1];
        const span = b.x - a.x;
        let prevY = a.y;
        for (let c = s === 0 ? 0 : 1; c <= span; c++, i++) {
            const t = c / span;
            const x = a.x + c;
            const y = Math.round(a.y + (b.y - a.y) * t + GARLAND_SAG * 4 * t * (1 - t));
            // A steep run fills the column down (or up) to the last row, so
            // the cord never breaks into dashes.
            if (!emissive) px(ctx, CORD, x, Math.min(y, prevY + 1), 1, Math.max(1, y - prevY));
            if (!emissive && y < prevY - 1) px(ctx, CORD, x, y, 1, prevY - y);
            prevY = y;
            if (i % 5 !== 2 || c < 3 || c > span - 3) continue;
            if (variant === 'blossom') {
                const tone = BLOSSOM[k % BLOSSOM.length];
                px(ctx, LEAF, x - 1, y + 1);
                px(ctx, tone, x, y + 1, 2, 1);
                px(ctx, tone, x, y + 2);
            } else {
                px(ctx, bulbs[k % bulbs.length], x, y + 1, 1, 2);
            }
            k++;
        }
    }
    const pin = points[1];
    if (variant === 'blossom') {
        if (!emissive) {
            px(ctx, LEAF, pin.x - 2, pin.y, 5, 1);
            px(ctx, BLOSSOM[0], pin.x - 1, pin.y - 1, 3, 3);
            px(ctx, BLOSSOM[1], pin.x, pin.y);
        }
    } else {
        if (!emissive) {
            px(ctx, BOW.dark, pin.x - 2, pin.y - 1, 2, 2);
            px(ctx, BOW.dark, pin.x + 1, pin.y - 1, 2, 2);
            px(ctx, BOW.light, pin.x - 2, pin.y - 1);
            px(ctx, BOW.light, pin.x + 1, pin.y - 1);
            px(ctx, BOW.dark, pin.x - 1, pin.y + 1);
            px(ctx, BOW.dark, pin.x + 1, pin.y + 1);
        }
        px(ctx, bulbs[1], pin.x, pin.y, 1, 2);
    }
    if (emissive) ctx.globalAlpha = 1;
}

// The midsummer bonfire's static night flame, laid over the sprite's log
// cone (`prop.festival.bonfire`, foot at the stone ring's centre): a bed of
// fire inside the ring and three tongues licking up the logs, stepped
// rim → mid → core, no motion.
function paintBonfireFlame(ctx, x, y) {
    px(ctx, FLAME.rim, x - 5, y - 5, 11, 4);
    px(ctx, FLAME.rim, x - 4, y - 9, 3, 4);
    px(ctx, FLAME.rim, x - 1, y - 14, 3, 9);
    px(ctx, FLAME.rim, x + 3, y - 10, 2, 5);
    px(ctx, FLAME.mid, x - 4, y - 5, 9, 2);
    px(ctx, FLAME.mid, x - 3, y - 7, 2, 2);
    px(ctx, FLAME.mid, x, y - 11, 1, 6);
    px(ctx, FLAME.mid, x + 3, y - 7, 1, 2);
    px(ctx, FLAME.core, x - 2, y - 4, 5, 1);
    px(ctx, FLAME.core, x, y - 6, 1, 2);
}

// Wreath, in a landmark's sprite-local texels centred on `at`.
export function paintWreath(ctx, cx, cy) {
    const ring = [
        '..ggg..',
        '.gGgGg.',
        'gG...Gg',
        'g.....g',
        'Gg...gG',
        '.gGgGg.',
        '..gbg..',
    ];
    for (let r = 0; r < ring.length; r++) {
        for (let c = 0; c < ring[r].length; c++) {
            const ch = ring[r][c];
            if (ch === '.') continue;
            const tone = ch === 'G' ? PINE.light : ch === 'b' ? '#c8323a' : PINE.mid;
            px(ctx, tone, cx - 3 + c, cy - 3 + r);
        }
    }
    px(ctx, '#d9473a', cx - 2, cy - 2);
    px(ctx, '#d9473a', cx + 2, cy + 1);
    px(ctx, '#c8323a', cx - 1, cy + 4);
    px(ctx, '#c8323a', cx + 1, cy + 4);
}

const GARLAND_BOUNDS = Object.freeze({ left: -56, right: 56, top: -64, bottom: 16, splitY: -18 });
// A sprite row's bounds when no sprite host supplies the asset's own (Node
// tests build the sprite set without assets).
const SPRITE_FALLBACK_BOUNDS = Object.freeze({ left: -24, right: 24, top: -48, bottom: 8, splitY: -16 });

/** Paint one code-drawn prop dressing (the gate garland) at its world origin. */
export function paintCalendarStamp(ctx, row, x, y, { lit = false } = {}) {
    if (row.stamp === 'gateGarland') paintGateGarland(ctx, row.variant, { lit });
}

// A prop dressing's tile, snapped so its world origin is a whole px. The
// stamps paint `fillRect` texels and the sprites blit whole texels, and
// StaticPropSprite bakes its cache with the origin's fraction in the
// translation (the cache itself sits at the floored corner), so a fractional
// origin smears every texel over four canvas pixels at partial alpha: the
// dressing paints as a faint ghost.
export function calendarPropTile(row) {
    const tile = row.stamp === 'gateGarland'
        ? { tileX: VILLAGE_GATE.tileX, tileY: VILLAGE_GATE.tileY + 0.3 }
        : { tileX: row.tileX, tileY: row.tileY };
    if (!Number.isFinite(tile.tileX) || !Number.isFinite(tile.tileY)) return tile;
    const world = tileToWorld(tile.tileX, tile.tileY);
    return worldToTile(Math.round(world.x), Math.round(world.y));
}

// The garland hangs on the arch block's face, in front of the gatehouse's
// own occlusion columns (which sort on the gate's centre line, slope 1/2 in
// world Y per screen x). One sortY at the gate foot put the swag's east half
// behind those columns, so the gate painted over it: slice the swag the same
// way, each slice on the face line (`blockHalfDepth` in front of the centre
// line) plus a px, so at every screen x it paints just after the stone under
// it and before anything standing in front of the face.
const GARLAND_COLUMN_PX = 16;
function gateGarlandColumns(originX, bounds) {
    const gate = tileToWorld(VILLAGE_GATE.tileX, VILLAGE_GATE.tileY);
    const slope = TILE_HALF_HEIGHT / TILE_HALF_WIDTH;
    const face = 2 * TILE_HALF_HEIGHT * VILLAGE_GATE_GEOMETRY.blockHalfDepth + 1;
    return lineOcclusionColumns({
        left: bounds.left,
        right: bounds.right,
        width: GARLAND_COLUMN_PX,
        originY: gate.y + face + slope * (originX - gate.x),
        slope,
    });
}

// The midsummer bonfire's flame stands this many world px above its foot.
export const BONFIRE_FLAME_HEIGHT = 9;

export class VillageCalendar {
    constructor({ dressings = VILLAGE_CALENDAR_DRESSINGS, occasions = VILLAGE_OCCASIONS } = {}) {
        this.dressings = dressings;
        this.occasions = occasions;
        this.dayKey = null;
        this._active = new Set();
        this._dayStartMs = Infinity;
        this._nextMidnightMs = -Infinity;
        this._lampsLit = false;
        this._sprites = new Map();
        this.revision = 0;
    }

    /**
     * Re-resolve the dressing when the local day turns (at most once a
     * midnight) and repaint what changed. While a release reveal is live the
     * turn waits for it to end, so a crown never shares the frame with a
     * rebake. Returns true when the dressing changed.
     */
    update(nowMs = Date.now(), { lampsLit = false, revealLive = false } = {}) {
        let changed = false;
        const turned = nowMs >= this._nextMidnightMs || nowMs < this._dayStartMs;
        if (turned && (!revealLive || this.dayKey === null)) {
            const date = new Date(nowMs);
            const next = new Set(calendarDressingAt(date, this.dressings, this.occasions).map((row) => row.id));
            const day = new Date(nowMs);
            day.setHours(0, 0, 0, 0);
            this._dayStartMs = day.getTime();
            this._nextMidnightMs = nextLocalMidnight(nowMs);
            this.dayKey = calendarDayKey(date);
            for (const row of this.dressings) {
                if (next.has(row.id) !== this._active.has(row.id)) {
                    this._sprites.get(row.id)?.invalidateCache();
                    changed = true;
                }
            }
            this._active = next;
        }
        const lit = lampsLit === true;
        if (lit !== this._lampsLit) {
            this._lampsLit = lit;
            for (const row of this.dressings) {
                if ((row.light || row.glow) && this._active.has(row.id)) this._sprites.get(row.id)?.invalidateCache();
            }
        }
        if (changed) this.revision++;
        return changed;
    }

    isActive(id) {
        return this._active.has(id);
    }

    /** Active landmark dressings for building `type` (sprite-local stamps). */
    partStampsFor(type) {
        const out = [];
        for (const row of this.dressings) {
            if (row.part === type && this._active.has(row.id)) out.push(row);
        }
        return out;
    }

    /** Lit dressing fires: `lamps` fixtures, never occupancy. */
    lightFixtures() {
        if (!this._lampsLit) return [];
        const out = [];
        for (const row of this.dressings) {
            if (!row.light || !this._active.has(row.id)) continue;
            out.push({
                id: `calendar.${row.id}`,
                tileX: row.tileX,
                tileY: row.tileY,
                height: BONFIRE_FLAME_HEIGHT,
                fire: true,
                color: '#ffa94a',
                radius: 46,
                intensity: 0.8,
            });
        }
        return out;
    }

    /**
     * One sorted prop sprite per prop dressing; built once, fixed thereafter.
     * `sprites` is the renderer's sprite host for the authored rows:
     * `draw(ctx, id, x, y, tile)` blits the manifest prop (with its contact
     * shadow), `bounds(id)` and `materialClass(id)` read its asset. Without a
     * host (Node tests) a sprite row keeps its fallback bounds and paints
     * nothing but its night flame.
     */
    buildPropSprites({ sprites = null } = {}) {
        const out = [];
        for (const row of this.dressings) {
            if (row.part) continue;
            const tile = calendarPropTile(row);
            const { tileX, tileY } = tile;
            if (!Number.isFinite(tileX) || !Number.isFinite(tileY)) continue;
            const garland = row.stamp === 'gateGarland';
            const bounds = garland ? GARLAND_BOUNDS : (sprites?.bounds?.(row.sprite) || SPRITE_FALLBACK_BOUNDS);
            const burns = row.light === true || row.glow === true;
            const sprite = new StaticPropSprite({
                tileX,
                tileY,
                id: `calendar.${row.id}`,
                bounds,
                occlusionColumns: garland ? gateGarlandColumns(tileToWorld(tileX, tileY).x, bounds) : null,
                materialClass: garland ? 'timber' : (sprites?.materialClass?.(row.sprite) || 'timber'),
                drawFn: (ctx, x, y) => {
                    if (!this._active.has(row.id)) return;
                    const lit = burns && this._lampsLit;
                    if (garland) {
                        paintGateGarland(ctx, row.variant, { lit });
                        return;
                    }
                    sprites?.draw?.(ctx, row.sprite, x, y, tile);
                    if (lit) paintBonfireFlame(ctx, x, y);
                },
                channels: burns ? {
                    emissive: (ctx, x, y) => {
                        if (!this._active.has(row.id) || !this._lampsLit) return;
                        if (garland) paintGateGarland(ctx, row.variant, { lit: true, emissive: true });
                        else paintBonfireFlame(ctx, x, y);
                    },
                } : null,
            });
            this._sprites.set(row.id, sprite);
            out.push(sprite);
        }
        return out;
    }
}
