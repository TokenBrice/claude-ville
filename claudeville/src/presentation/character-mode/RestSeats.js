// Plans 7.1 and 7.2 — the places villagers wait: rest seats (idle villagers
// sit) and the petitioners' candles along the Command queue.
//
// Seat furniture is set dressing painted on the art-pixel grid (one world
// texel per pixel, C1 timber/stone ramps, upper-left key, 1-px selective
// outline). A timber seat (bench, pier kerb) is two static sorted props: the
// BACK slice (its top face) sorts just behind the seat point, the FRONT slice
// (the faces toward the camera) just in front of it, so a villager seated at
// the seat point is drawn between them and the front slice hides its legs
// (M12). A stone seat (a step at Command, the fountain rim) is part of the
// masonry it sits against, so it is never drawn empty: the sitter carries its
// two slices in its own depth slot (`seatStoneStamps`), back before the body
// and front after it. The sitter's seat line lands on the front slice's top
// edge (`seatLineOffset`).
//
// A petitioner's floor candle is a ground stamp beside its feet whose wax
// steps down by wait age (< 1 min 12 texels, 1–4 min 9, 4–16 min 6, >= 16 min
// 3), with the C4 cream cap and an ember flame. It never animates: the stamp
// only changes when the age crosses a step. An unknown age shows an unlit stub.

import { REST_SEATS } from '../../config/townPlan.js';
import { ART_RAMPS, EFFECT_COLORS } from '../../config/artPalette.js';
import { StaticPropSprite } from './StaticPropDrawables.js';
import { tileToWorld } from './Projection.js';

const TILE_HALF_W = 32;
const TILE_HALF_H = 16;
const TIMBER = ART_RAMPS.timber;
const STONE = ART_RAMPS.stone;
const SAND = ART_RAMPS.sand;
const PLAZA = ART_RAMPS.plaza;
const CONTACT = 'rgba(18, 14, 22, 0.34)';

// SpriteSheet DIRECTIONS index of each authored seat facing.
export const SEAT_FACING_DIR = Object.freeze({ 'south-east': 1, 'south-west': 7 });
// Lowered-body fallback for a profile without an approved sit strip: the
// standing idle body drops this many texels and is clipped at the seat line.
export const FALLBACK_SEAT_DROP = 5;

// Box furniture per occluder kind, in tile units around the seat point:
// `half` along the seat's long axis, `depth` half-depth along its facing,
// `height` world px of the seat top. `recess` paints the shaded space under a
// bench seat between its legs; `backrest` raises two rails on posts along the
// back edge (part of the back slice, behind the sitter's torso); `planks`
// splits the seat top into two boards; `post` raises a mooring post;
// `courses` lays dressed blocks of that many texels high (running bond, one
// mortar joint every `block` texels); `stone` marks a seat drawn only under
// its sitter.
const SEAT_KINDS = Object.freeze({
    bench: { half: 0.36, depth: 0.1, height: 8, ramp: 'timber', recess: true, planks: true, backrest: 8 },
    step: { half: 0.3, depth: 0.13, height: 7, ramp: 'masonry', courses: 4, block: 8, stone: true },
    well: { half: 0.28, depth: 0.12, height: 8, ramp: 'masonry', courses: 4, block: 7, lip: true, stone: true },
    pier: { half: 0.4, depth: 0.1, height: 6, ramp: 'timber', seam: true, post: true },
});

const RAMPS = Object.freeze({
    timber: { top: TIMBER[3], lit: TIMBER[2], shade: TIMBER[1], dark: TIMBER[0], soft: TIMBER[1], seam: TIMBER[2] },
    // Dressed masonry matching Command's walls and plinth (warm lit blocks,
    // violet-grey mortar and shade, near-black selective edge).
    masonry: { top: PLAZA[4], lit: PLAZA[3], shade: PLAZA[0], dark: STONE[0], soft: PLAZA[2], seam: STONE[3] },
});

export function isStoneSeat(seat) {
    return Boolean(SEAT_KINDS[seat?.occluder]?.stone);
}

// World px from the seat point (the sitter's foot) up to the front slice's
// top edge under the sitter's centre column: where its seat line lands.
export function seatLineOffset(seat) {
    const kind = SEAT_KINDS[seat?.occluder] || SEAT_KINDS.bench;
    return Math.round(kind.depth * 2 * TILE_HALF_H - kind.height);
}

export function restSeatById(id) {
    return REST_SEATS.find((seat) => seat.id === id) || null;
}

// ─── seat stamps ─────────────────────────────────────────────────────────────

const stampCache = new Map();

// Rasterize one seat's box into its back (top face) and front (camera-facing
// faces + contact row) pixel lists, relative to the seat point.
function seatPixels(seat) {
    const kind = SEAT_KINDS[seat.occluder] || SEAT_KINDS.bench;
    const colours = RAMPS[kind.ramp];
    const southEast = seat.facing !== 'south-west';
    // Long axis along tileY for a south-east sitter, tileX for south-west.
    const project = (along, across, h) => {
        const u = southEast ? across : along;
        const v = southEast ? along : across;
        return [(u - v) * TILE_HALF_W, (u + v) * TILE_HALF_H - h];
    };
    const { half: L, depth: D, height: H } = kind;
    const quad = (points) => points.map(([a, b, h]) => project(a, b, h));
    const faces = [
        { part: 'back', face: 'top', poly: quad([[-L, -D, H], [L, -D, H], [L, D, H], [-L, D, H]]) },
        // The long face toward the camera: +u (shade) for a south-east
        // sitter, +v (lit) for a south-west one.
        { part: 'front', face: 'long', poly: quad([[-L, D, H], [L, D, H], [L, D, 0], [-L, D, 0]]) },
        // The end cap at +along: +v (lit) for south-east, +u (shade) for south-west.
        { part: 'front', face: 'cap', poly: quad([[L, -D, H], [L, D, H], [L, D, 0], [L, -D, 0]]) },
    ];
    // The backrest plane rises from the seat's back edge; only its rails and
    // end posts are solid (see `backrestSolid`).
    const backrest = kind.backrest
        ? { part: 'back', face: 'backrest', poly: quad([[-L, -D, H], [L, -D, H], [L, -D, H + kind.backrest], [-L, -D, H + kind.backrest]]) }
        : null;
    if (backrest) faces.push(backrest);
    const longTone = southEast ? colours.shade : colours.lit;
    const capTone = southEast ? colours.lit : colours.shade;
    let minX = Infinity; let maxX = -Infinity; let minY = Infinity; let maxY = -Infinity;
    for (const { poly } of faces) {
        for (const [x, y] of poly) {
            minX = Math.min(minX, x); maxX = Math.max(maxX, x);
            minY = Math.min(minY, y); maxY = Math.max(maxY, y);
        }
    }
    const x0 = Math.floor(minX) - 1; const x1 = Math.ceil(maxX) + 1;
    const y0 = Math.floor(minY) - 1; const y1 = Math.ceil(maxY) + 2;
    const cells = new Map();
    const key = (x, y) => `${x},${y}`;
    for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
            const cx = x + 0.5; const cy = y + 0.5;
            const rail = backrest && insideConvex(backrest.poly, cx, cy) && backrestSolid(cx, cy, project, kind);
            const hit = rail ? backrest : faces.find((face) => face !== backrest && insideConvex(face.poly, cx, cy));
            if (!hit) continue;
            cells.set(key(x, y), { x, y, part: hit.part, face: hit.face });
        }
    }
    // Face texture, then the selective outline on the silhouette: the lit
    // (upper/left) edges take the soft ramp step, the shaded ones the darkest.
    const out = [];
    for (const cell of cells.values()) {
        const { x, y } = cell;
        let colour = cell.face === 'top' ? colours.top
            : cell.face === 'long' ? longTone
                : cell.face === 'backrest' ? colours.lit
                    : capTone;
        const lift = planeLift(cell, project, kind, kind.depth);
        if (cell.face === 'long') {
            if (kind.recess && lift < H - 2 && !nearLeg(cell, project, kind)) colour = colours.dark;
            if (kind.seam && Math.round(lift) === Math.round(H / 2)) colour = colours.seam;
            if (kind.lip && lift >= H - 1.5) colour = colours.top;
        }
        if (kind.courses && (cell.face === 'long' || cell.face === 'cap')) {
            // Dressed blocks: a mortar row atop each course below the top one,
            // and running-bond joints (every other course offset half a block).
            const faceLift = cell.face === 'long' ? lift : capLift(cell, project, kind);
            const row = Math.floor(faceLift);
            const course = Math.floor(row / kind.courses);
            const topRow = row >= H - 1 || (kind.lip && faceLift >= H - 1.5);
            const offset = course % 2 ? Math.floor(kind.block / 2) : 0;
            if (!topRow && positiveMod(row, kind.courses) === kind.courses - 1) colour = colours.seam;
            else if (!topRow && positiveMod(x + offset, kind.block) === 0) colour = colours.seam;
        }
        if (cell.face === 'top' && kind.planks) {
            // Board seam along the long axis, one texel wide.
            const across = acrossAt(x + 0.5, y + 0.5, H, southEast);
            if (Math.abs(across) < 0.035) colour = colours.seam;
        }
        if (cell.face === 'backrest' && planeLift(cell, project, kind, -kind.depth) > H + kind.backrest - 1.5) colour = colours.top;
        const up = cells.has(key(x, y - 1)); const down = cells.has(key(x, y + 1));
        const left = cells.has(key(x - 1, y)); const right = cells.has(key(x + 1, y));
        if (!down || !right) colour = colours.dark;
        else if (!up || !left) colour = colours.soft;
        out.push({ x, y, part: cell.part, colour });
    }
    // One contact row under the front faces.
    for (const cell of cells.values()) {
        if (cell.part !== 'front' || cells.has(key(cell.x, cell.y + 1))) continue;
        out.push({ x: cell.x, y: cell.y + 1, part: 'front', colour: CONTACT });
    }
    if (kind.post) {
        // A mooring post at the far (back) end of the kerb, 3 texels wide.
        const [px, py] = project(-L + 0.05, 0, 0);
        const top = Math.round(py) - H - 5;
        for (let y = top; y <= Math.round(py) - H; y++) {
            for (let dx = -1; dx <= 1; dx++) {
                const x = Math.round(px) + dx;
                out.push({ x, y, part: 'back', colour: y === top ? colours.soft : dx < 0 ? colours.lit : dx > 0 ? colours.dark : colours.shade });
            }
        }
    }
    return out;
}

// World px of a pixel above the ground, measured on the vertical plane at
// `across` (the long face at +depth, the backrest at -depth): the plane's
// bottom edge slopes with the long axis, so each column has its own ground.
function planeLift(cell, project, kind, across) {
    const [ax, ay] = project(-kind.half, across, 0);
    const [bx, by] = project(kind.half, across, 0);
    const t = bx === ax ? 0 : (cell.x + 0.5 - ax) / (bx - ax);
    const edgeY = ay + (by - ay) * Math.max(0, Math.min(1, t));
    return edgeY - (cell.y + 0.5);
}

// `planeLift` for the end cap (the vertical plane at +half along the seat).
function capLift(cell, project, kind) {
    const [ax, ay] = project(kind.half, -kind.depth, 0);
    const [bx, by] = project(kind.half, kind.depth, 0);
    const t = bx === ax ? 0 : (cell.x + 0.5 - ax) / (bx - ax);
    const edgeY = ay + (by - ay) * Math.max(0, Math.min(1, t));
    return edgeY - (cell.y + 0.5);
}

// A backrest pixel is solid on its two rails (top two rows, and one row
// halfway up) and on the two end posts; the rest of the plane is open.
function backrestSolid(cx, cy, project, kind) {
    const lift = planeLift({ x: cx - 0.5, y: cy - 0.5 }, project, kind, -kind.depth) - kind.height;
    const rise = kind.backrest;
    if (lift >= rise - 2 || (lift >= rise / 2 - 1.5 && lift < rise / 2 - 0.5)) return true;
    const [ax] = project(-kind.half, -kind.depth, 0);
    const [bx] = project(kind.half, -kind.depth, 0);
    return Math.abs(cx - ax) < 2.5 || Math.abs(cx - bx) < 2.5;
}

// Position across the seat (tile units, 0 = the seat's long centre line) of
// a top-face pixel centre.
function acrossAt(x, y, height, southEast) {
    const uMinusV = x / TILE_HALF_W;
    const uPlusV = (y + height) / TILE_HALF_H;
    const u = (uMinusV + uPlusV) / 2;
    const v = (uPlusV - uMinusV) / 2;
    return southEast ? u : v;
}

// True for the long-face columns that carry a bench leg (both ends, 2 texels).
function nearLeg(cell, project, kind) {
    const [ax] = project(-kind.half, kind.depth, 0);
    const [bx] = project(kind.half, kind.depth, 0);
    const lo = Math.min(ax, bx); const hi = Math.max(ax, bx);
    const x = cell.x + 0.5;
    return x - lo < 3 || hi - x < 3.5;
}

function positiveMod(value, mod) {
    return ((value % mod) + mod) % mod;
}

function insideConvex(poly, x, y) {
    let sign = 0;
    for (let i = 0; i < poly.length; i++) {
        const [ax, ay] = poly[i];
        const [bx, by] = poly[(i + 1) % poly.length];
        const cross = (bx - ax) * (y - ay) - (by - ay) * (x - ax);
        if (Math.abs(cross) < 1e-9) continue;
        const s = cross > 0 ? 1 : -1;
        if (sign === 0) sign = s;
        else if (s !== sign) return false;
    }
    return true;
}

// Cached { canvas, x, y } (offset from the seat point) for a seat part.
function seatStamp(seat, part) {
    const cacheKey = `${seat.occluder}|${seat.facing}|${part}`;
    if (stampCache.has(cacheKey)) return stampCache.get(cacheKey);
    if (typeof document === 'undefined') return null;
    const pixels = seatPixels(seat).filter((pixel) => pixel.part === part);
    if (!pixels.length) {
        stampCache.set(cacheKey, null);
        return null;
    }
    const minX = Math.min(...pixels.map((p) => p.x)); const maxX = Math.max(...pixels.map((p) => p.x));
    const minY = Math.min(...pixels.map((p) => p.y)); const maxY = Math.max(...pixels.map((p) => p.y));
    const canvas = document.createElement('canvas');
    canvas.width = maxX - minX + 1;
    canvas.height = maxY - minY + 1;
    const ctx = canvas.getContext('2d');
    for (const pixel of pixels) {
        ctx.fillStyle = pixel.colour;
        ctx.fillRect(pixel.x - minX, pixel.y - minY, 1, 1);
    }
    canvas.__cvGroundKey = `rest-seat:${cacheKey}`;
    const stamp = { canvas, x: minX, y: minY };
    stampCache.set(cacheKey, stamp);
    return stamp;
}

function seatBounds(seat) {
    const pixels = seatPixels(seat);
    const xs = pixels.map((p) => p.x); const ys = pixels.map((p) => p.y);
    return {
        left: Math.min(...xs) - 1,
        right: Math.max(...xs) + 2,
        top: Math.min(...ys) - 1,
        bottom: Math.max(...ys) + 2,
        splitY: 0,
    };
}

// 7.1 — a stone seat's two slices for the villager sitting on it, as
// { back, front } stamps ({ canvas, x, y } offset from the seat point), or
// null for a timber seat (its furniture is a static prop).
export function seatStoneStamps(seat) {
    if (!isStoneSeat(seat)) return null;
    const back = seatStamp(seat, 'back');
    const front = seatStamp(seat, 'front');
    return back && front ? { back, front } : null;
}

// Two sorted props per timber seat. The back slice sorts one texel behind the
// seat point and the front slice two texels in front, so the seated body
// (sorted at its foot, the seat point) paints between them on Canvas and on
// the GPU. Where the sitter sorts behind a split building instead, the
// slices follow it there (`bracketsSitter`, DrawablePass). Stone seats have
// no prop: their sitter draws them.
export function buildRestSeatPropSprites() {
    const sprites = [];
    for (const seat of REST_SEATS) {
        if (isStoneSeat(seat)) continue;
        const world = tileToWorld(seat.tileX, seat.tileY);
        const bounds = seatBounds(seat);
        for (const [part, sortOffset] of [['back', -1], ['front', 2]]) {
            const sprite = new StaticPropSprite({
                tileX: seat.tileX,
                tileY: seat.tileY,
                id: `rest-seat.${seat.occluder}.${seat.id}.${part}`,
                bounds,
                sortY: world.y + sortOffset,
                drawFn: (ctx, x, y) => {
                    const stamp = seatStamp(seat, part);
                    if (stamp) ctx.drawImage(stamp.canvas, Math.round(x) + stamp.x, Math.round(y) + stamp.y);
                },
            });
            sprite.bracketsSitter = true;
            sprites.push(sprite);
        }
    }
    return sprites;
}

// ─── petitioner candles (7.2) ────────────────────────────────────────────────

// Wax texels for a wait age; null age (unknown) is the unlit 3-texel stub.
export function candleWaxTexels(ageMs) {
    if (!Number.isFinite(ageMs)) return 3;
    if (ageMs < 60000) return 12;
    if (ageMs < 240000) return 9;
    if (ageMs < 960000) return 6;
    return 3;
}

// World px from the petitioner's foot to the candle's base: right of its feet,
// clear of a robe's hem, on the side away from the next petitioner in line.
export const CANDLE_OFFSET = Object.freeze({ x: 17, y: 3 });

const candleCache = new Map();

// A 5-texel-wide floor candle: iron dish, wax column (lit left, shaded right
// with a dark selective edge), the C4 cream cap, a wick and a two-texel ember
// flame. Returns a canvas whose bottom-centre is the candle's base point.
export function queueCandleStamp(ageMs) {
    const lit = Number.isFinite(ageMs);
    const wax = candleWaxTexels(ageMs);
    const cacheKey = `${lit ? 'lit' : 'stub'}:${wax}`;
    if (candleCache.has(cacheKey)) return candleCache.get(cacheKey);
    if (typeof document === 'undefined') return null;
    const flame = lit ? 2 : 0;
    const height = flame + 1 + wax + 2;
    const canvas = document.createElement('canvas');
    canvas.width = 5;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    const px = (x, y, colour) => {
        ctx.fillStyle = colour;
        ctx.fillRect(x, y, 1, 1);
    };
    let y = 0;
    if (lit) {
        px(2, y++, EFFECT_COLORS.work[2]);
        px(2, y++, EFFECT_COLORS.work[1]);
    }
    px(2, y++, TIMBER[0]); // wick
    for (let row = 0; row < wax; row++, y++) {
        const cap = row === 0;
        px(1, y, cap ? (lit ? EFFECT_COLORS.peak : SAND[2]) : SAND[4]);
        px(2, y, cap ? (lit ? EFFECT_COLORS.peak : SAND[2]) : SAND[3]);
        px(3, y, cap ? SAND[3] : SAND[1]);
        px(4, y, TIMBER[1]);
    }
    for (let x = 0; x < 5; x++) px(x, y, STONE[2]);
    y++;
    for (let x = 1; x < 4; x++) px(x, y, STONE[0]);
    canvas.__cvGroundKey = `queue-candle:${cacheKey}`;
    candleCache.set(cacheKey, canvas);
    return canvas;
}
