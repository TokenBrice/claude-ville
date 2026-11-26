// Plans 7.1 and 7.2 — the places villagers wait: rest seats (idle villagers
// sit) and the petitioners' candles along the Command queue.
//
// Seat furniture is set dressing painted on the art-pixel grid (one world
// texel per pixel, C1 timber/stone ramps, upper-left key, 1-px selective
// outline). A timber seat (a Tavern bench and its table, the pier kerb) is two
// static sorted props: the BACK slice (its top face) sorts just behind the
// seat point, the FRONT slice (the faces toward the camera, and the whole
// table) just in front of it, so a villager seated at the seat point is drawn
// between them and the front slice hides its legs (M12). A stone seat (a step at Command) is part of the masonry it sits
// against, so it is never drawn empty: the sitter carries its two slices in
// its own depth slot (`seatStoneStamps`), back before the body
// and front after it. The sitter's seat line lands on the front slice's top
// edge (`seatLineOffset`).
//
// W1-D 1.6 — the Tavern's beer garden is oak trestle furniture authored as
// 64×48 two-slice sprites (`prop.tavernTable.{se,sw}.{back,front}`, anchor
// [32, 30] on the seat point; scripts/sprites/bake-rest-seats.mjs bakes them
// from `tavernTableArt`): a planked bench with splayed legs under the sitter
// and an open A-frame trestle table in front, planked oak with 1-px end-grain
// notches, iron strap corners and a beeswax candle stub whose flame is the
// front slice's night-only emissive sidecar. Each seat carries one tile of
// bench and table, so neighbours abut into one long table. Until the sheet
// loads (and in Node) the same pixels draw from `tavernTableArt` itself, and
// each seat lays one seeded dressing stamp on the table (`tableDressingFor`:
// a foam tankard, a folded parchment or a wooden trencher).
//
// A petitioner's floor candle is a ground stamp beside its feet whose wax
// steps down on the shared wait-age ladder (`SignalLedger.waitAgeTier`:
// < 1 min 12 texels, 1–5 min 9, 5–15 min 6, >= 15 min 3), with the C4 cream
// cap and an ember flame. It never animates: the stamp
// only changes when the age crosses a step. An unknown age shows an unlit stub.

import { REST_SEATS } from '../../config/townPlan.js';
import { ART_RAMPS, EFFECT_COLORS } from '../../config/artPalette.js';
import { StaticPropSprite } from './StaticPropDrawables.js';
import { tileToWorld } from './Projection.js';
import { waitAgeTier } from '../../domain/services/SignalLedger.js';

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
// bench seat between its legs; `post` raises a mooring post; `courses` lays
// dressed blocks of that many texels high (running bond, one mortar joint
// every `block` texels); `stone` marks a seat drawn only under its sitter;
// `art` marks the Tavern's authored oak trestle (TAVERN_TABLE), which never
// takes the box path.
const SEAT_KINDS = Object.freeze({
    step: { half: 0.3, depth: 0.13, height: 7, ramp: 'masonry', courses: 4, block: 8, stone: true },
    pier: { half: 0.4, depth: 0.1, height: 6, ramp: 'timber', seam: true, post: true },
    // The Tavern's beer garden: a plank bench under the sitter and a trestle
    // table segment in front of it (`table.offset` tiles toward its facing).
    // Each seat carries one tile of bench and table, so seats side by side
    // along the long axis read as one long table.
    // A bar stool on the Tavern's floor: `lift` world px up (the floor's
    // height above the ground) and no table; the drinker holds its tankard.
    stool: { half: 0.14, depth: 0.12, height: 7, lift: 5, ramp: 'timber', recess: true },
    // W1-D 1.6 — the oak trestle bench and table (`art`: the authored
    // two-slice sprite, TAVERN_TABLE), same bench depth and height as the
    // box bench it replaced, so the seat line stays put.
    tavern: { half: 0.5, depth: 0.1, height: 7, ramp: 'timber', art: true },
});

export function isArtSeat(seat) {
    return Boolean(SEAT_KINDS[seat?.occluder]?.art);
}

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
    const kind = SEAT_KINDS[seat?.occluder] || SEAT_KINDS.tavern;
    return Math.round(kind.depth * 2 * TILE_HALF_H - kind.height - (kind.lift || 0));
}

export function restSeatById(id) {
    return REST_SEATS.find((seat) => seat.id === id) || null;
}

// ─── the Tavern's oak trestle tables (W1-D 1.6) ──────────────────────────────

// Tile units around the seat point (`along` the seat's long axis, `across`
// toward its facing), heights in world px. One tile of bench and table per
// seat (`half` 0.5), so seats side by side abut into one long trestle; the
// bench keeps the box bench's depth and height (`seatLineOffset` -4), the
// table stands `table.offset` in front of the sitter, shallow enough that
// the whole slice fits the 64×48 cell at anchor [32, 30].
export const TAVERN_TABLE = Object.freeze({
    width: 64,
    height: 48,
    anchor: Object.freeze([32, 30]),
    half: 0.5,
    bench: Object.freeze({ depth: 0.1, height: 7, apron: 2, end: 0.42 }),
    table: Object.freeze({ offset: 0.34, depth: 0.16, height: 15, apron: 3, frame: 0.42, stretcher: 4 }),
    // Where the candle stub and the seat's dressing stand on the table top.
    candle: Object.freeze({ along: -0.4, across: 0.22 }),
    dressing: Object.freeze({ along: -0.35, across: 0.45 }),
});
// The candle's emissive contribution (the front slice's `.emissive.png`).
export const TAVERN_CANDLE_ALPHA = 160;
export const TAVERN_DRESSINGS = Object.freeze(['tankard', 'parchment', 'trencher']);

const OAK = TIMBER;
const IRON = ART_RAMPS.slate;
const OAK_INK = '#060402';
const FOOT_CONTACT = STONE[0];
const WAX = ART_RAMPS.trimGold;
const GLOW = ART_RAMPS.emissive;

// The authored sheets per facing and slice (manifest ids, literal so the
// sprite-id audit can see them).
const TAVERN_TABLE_IDS = Object.freeze({
    'south-west': Object.freeze({ back: 'prop.tavernTable.sw.back', front: 'prop.tavernTable.sw.front' }),
    'south-east': Object.freeze({ back: 'prop.tavernTable.se.back', front: 'prop.tavernTable.se.front' }),
});

/** The sprite id of a Tavern seat's slice: `back`, `front`. */
export function tavernTableSpriteId(facing, part) {
    return TAVERN_TABLE_IDS[facing === 'south-east' ? 'south-east' : 'south-west'][part] || null;
}

function hexRgb(hex) {
    const n = parseInt(String(hex).slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function seatHash(text) {
    let hash = 2166136261;
    const key = String(text ?? '');
    for (let i = 0; i < key.length; i++) hash = Math.imul(hash ^ key.charCodeAt(i), 16777619);
    return hash >>> 0;
}

/** The seat's seeded table dressing (one of TAVERN_DRESSINGS). */
export function tableDressingFor(seat) {
    return TAVERN_DRESSINGS[(seatHash(`table:${seat?.id ?? ''}`) >>> 7) % TAVERN_DRESSINGS.length];
}

const tableArtCache = new Map();

/**
 * The oak trestle bench and table for a seat facing `facing`, as RGBA bytes
 * of the 64×48 cell (anchor TAVERN_TABLE.anchor on the seat point):
 * `{ back, front, emissive }`. The back slice is the bench's seat boards;
 * the front slice its apron, end grain and legs, and the whole table with
 * its candle stub; the emissive sidecar the candle's wick and wax pool.
 * Pure and deterministic (Node and browser alike).
 */
export function tavernTableArt(facing = 'south-west') {
    const se = facing === 'south-east';
    const cacheKey = se ? 'se' : 'sw';
    if (tableArtCache.has(cacheKey)) return tableArtCache.get(cacheKey);
    const { width: W, height: H, anchor: [AX, AY], half: L, bench: B, table: T } = TAVERN_TABLE;
    const cells = new Array(W * H).fill(null);
    const at = (x, y) => (x + AX < 0 || x + AX >= W || y + AY < 0 || y + AY >= H ? -1 : (y + AY) * W + x + AX);
    const get = (x, y) => { const i = at(x, y); return i < 0 ? null : cells[i]; };
    const put = (x, y, colour, part, kind = 'board') => {
        const i = at(x, y);
        if (i >= 0) cells[i] = { colour, part, kind };
    };
    // Screen <-> seat space. The camera sees the faces at the far end of
    // `across` (the long face toward the sitter's facing) and of `along`
    // (the end cap): south-west, the long face looks SW (lit) and the cap
    // SE (shade); south-east, the other way round.
    const toAA = (u, v) => (se ? [v, u] : [u, v]);
    const topAt = (x, y, h) => {
        const s = (y + h) / 16;
        const d = x / 32;
        return toAA((s + d) / 2, (s - d) / 2);
    };
    const acrossPlane = (x, y, A) => {
        const u = se ? A : x / 32 + A;
        const v = se ? A - x / 32 : A;
        return [se ? v : u, (u + v) * 16 - y];
    };
    const alongPlane = (x, y, P) => {
        const u = se ? x / 32 + P : P;
        const v = se ? P : P - x / 32;
        return [se ? u : v, (u + v) * 16 - y];
    };
    const project = (along, across, h) => {
        const [u, v] = se ? [across, along] : [along, across];
        return [Math.floor((u - v) * 32), Math.floor((u + v) * 16 - h)];
    };
    const each = (fn) => {
        for (let y = -AY; y < H - AY; y++) for (let x = -AX; x < W - AX; x++) fn(x, y, x + 0.5, y + 0.5);
    };
    const longLit = !se;
    const LONG = longLit ? OAK[2] : OAK[1];
    const LONG_HI = longLit ? OAK[3] : OAK[2];
    const CAP = longLit ? OAK[1] : OAK[2];
    // Smooth 2–3 px elongated oak grain dashes along the plank axis (~1 in 9).
    const grainDash = (a, c, salt) => seatHash(`${Math.floor(a * 5)}:${Math.floor(c * 24)}:${salt}`) % 9 === 0;
    // At most one subtle heartwood knot per plank (never dark speckled dots).
    const plankKnot = (a, c, boardIdx, cMin, cMax, salt) => {
        const h = seatHash(`knot:${boardIdx}:${salt}`);
        const knotA = -0.34 + ((h & 255) / 255) * 0.68;
        const knotC = cMin + 0.32 * (cMax - cMin) + (((h >>> 8) & 255) / 255) * 0.36 * (cMax - cMin);
        return Math.abs(a - knotA) < 0.048 && Math.abs(c - knotC) < 0.017;
    };

    // A board top at height h over [a0, a1] x [c0, c1], `seams` across.
    // Crafted oak planks with crisp dark seams (`OAK[0]`), subtle plank-edge
    // bevel highlights, joinery dowel pegs over the trestle cleats, at most
    // one subtle knot per plank and smooth elongated grain dashes along the
    // plank axis.
    const boardTop = (a0, a1, c0, c1, h, seams, part, salt, pegAt = null) => {
        const edges = [c0, ...seams, c1];
        each((x, y, cx, cy) => {
            const [a, c] = topAt(cx, cy, h);
            if (a < a0 || a > a1 || c < c0 || c > c1) return;
            let boardIdx = 0;
            for (let i = 0; i < seams.length; i++) if (c >= seams[i]) boardIdx = i + 1;
            const cMin = edges[boardIdx];
            const cMax = edges[boardIdx + 1];
            const cMid = (cMin + cMax) / 2;
            const altPlank = (boardIdx & 1) === 1;
            let colour = altPlank ? OAK[2] : OAK[3];
            if (seams.some((s) => Math.abs(c - s) < 0.02)) {
                colour = OAK[0];
            } else if (c - cMin > 0.018 && c - cMin < 0.04) {
                // Crisp sunlit bevel catchlight along each plank's upper edge.
                colour = OAK[3];
            } else if (pegAt !== null && Math.abs(Math.abs(a) - pegAt) < 0.028 && Math.abs(c - cMid) < 0.02) {
                // Recessed oak joinery peg over the A-frame cleat.
                colour = OAK[0];
            } else if (plankKnot(a, c, boardIdx, cMin, cMax, salt)) {
                colour = OAK[1];
            } else if (grainDash(a, c, salt)) {
                colour = altPlank ? OAK[1] : OAK[2];
            }
            put(x, y, colour, part);
        });
    };
    // The long face at across = A over [a0, a1], rows h in [h0, h1).
    const longFace = (A, a0, a1, h0, h1, part, rows) => each((x, y, cx, cy) => {
        const [a, h] = acrossPlane(cx, cy, A);
        if (a < a0 || a > a1 || h < h0 || h >= h1) return;
        put(x, y, rows(Math.floor(h - h0), a), part);
    });
    // The end cap at along = P over [c0, c1], rows h in [h0, h1): end grain,
    // a 1-px notch at each board seam and a lighter heart on each board.
    const endGrain = (P, c0, c1, h0, h1, seams, part) => each((x, y, cx, cy) => {
        const [c, h] = alongPlane(cx, cy, P);
        if (c < c0 || c > c1 || h < h0 || h >= h1) return;
        let colour = CAP;
        if (seams.some((s) => Math.abs(c - s) < 0.017)) colour = OAK[0];
        else if (Math.floor(h - h0) === Math.floor((h1 - h0) / 2)) {
            const edges = [c0, ...seams, c1];
            const board = edges.findIndex((s, i, list) => i < list.length - 1 && c >= s && c < list[i + 1]);
            const mid = (edges[board] + edges[board + 1]) / 2;
            if (Math.abs(c - mid) < 0.017) colour = longLit ? OAK[2] : OAK[3];
        }
        put(x, y, colour, part);
    });
    // A splayed leg board in the plane along = P, from (cFoot, h 0) to
    // (cTop, hTop), `w` texels wide; `far` legs stand in the table's shade,
    // while near legs carry subtle vertical bevel shading.
    const legBoard = (P, cFoot, cTop, h0, hTop, w, part, far) => each((x, y, cx, cy) => {
        const [c, h] = alongPlane(cx, cy, P);
        if (h < h0 || h >= hTop) return;
        const mid = cFoot + (cTop - cFoot) * (h - h0) / (hTop - h0);
        const halfW = w / 64;
        if (Math.abs(c - mid) > halfW) return;
        let colour = far ? OAK[0] : CAP;
        if (!far) {
            if (c - mid < -halfW * 0.35) colour = longLit ? OAK[2] : OAK[3];
            else if (c - mid > halfW * 0.45) colour = OAK[0];
        }
        put(x, y, colour, part, h < h0 + 1 ? 'foot' : 'leg');
    });
    // A cross cleat in the plane along = P: rows [h0, h1) over [c0, c1].
    const cleat = (P, c0, c1, h0, h1, part, far) => each((x, y, cx, cy) => {
        const [c, h] = alongPlane(cx, cy, P);
        if (c < c0 || c > c1 || h < h0 || h >= h1) return;
        put(x, y, far ? OAK[0] : (Math.floor(h) === h1 - 1 ? (longLit ? OAK[2] : OAK[3]) : CAP), part, 'leg');
    });

    // --- the bench: legs, then its seat boards (back), apron and end -----
    const bd = B.depth;
    for (const P of [-B.end, B.end]) {
        const far = P < 0;
        // A board end with an inverted-V notch: two feet under the seat.
        legBoard(P, -bd + 0.02, -0.02, 0, B.height - B.apron, 2.6, 'front', far);
        legBoard(P, bd - 0.02, 0.02, 0, B.height - B.apron, 2.6, 'front', far);
    }
    boardTop(-L, L, -bd, bd, B.height, [0], 'back', 1, B.end);
    longFace(bd, -L, L, B.height - B.apron, B.height, 'front', (row) => (row === B.apron - 1 ? LONG_HI : row === 0 ? OAK[0] : LONG));
    endGrain(L, -bd, bd, B.height - B.apron, B.height, [0], 'front');

    // --- the table: the far A-frame, the stretcher, the near A-frame, then
    // the planked top, its apron and its end grain ------------------------
    const c = T.offset;
    const d = T.depth;
    const legTop = T.height - T.apron;
    const aFrame = (P, far) => {
        legBoard(P, c - d + 0.025, c - 0.035, 0, legTop, 3.2, 'front', far);
        legBoard(P, c + d - 0.025, c + 0.035, 0, legTop, 3.2, 'front', far);
        cleat(P, c - d + 0.02, c + d - 0.02, legTop - 2, legTop, 'front', far);
        cleat(P, c - 0.07, c + 0.07, 5, 7, 'front', far);
    };
    aFrame(-T.frame, true);
    longFace(c + 0.02, -T.frame, T.frame, T.stretcher, T.stretcher + 2, 'front', (row) => (row === 1 ? LONG : OAK[0]));
    aFrame(T.frame, false);
    const seams = [c - d / 3, c + d / 3];
    boardTop(-L, L, c - d, c + d, T.height, seams, 'front', 2, T.frame);
    // Clean horizontal board-thickness bevel on the front apron (zero flecks).
    longFace(c + d, -L, L, legTop, T.height, 'front', (row) => {
        if (row === T.apron - 1) return LONG_HI;
        if (row === 0) return OAK[0];
        return LONG;
    });
    endGrain(L, c - d, c + d, legTop, T.height, seams, 'front');

    // --- selective outline on the union silhouette: ink below and right,
    // the board's own dark stop above and left; legs keep their lit edge.
    const isSolid = (x, y) => Boolean(get(x, y));
    const outline = [];
    for (let y = -AY; y < H - AY; y++) {
        for (let x = -AX; x < W - AX; x++) {
            const cell = get(x, y);
            if (!cell) continue;
            const openDown = !isSolid(x, y + 1);
            const openRight = !isSolid(x + 1, y);
            const openUp = !isSolid(x, y - 1);
            const openLeft = !isSolid(x - 1, y);
            if (openDown || openRight) outline.push([x, y, OAK_INK]);
            else if (cell.kind === 'board' && (openUp || openLeft)) outline.push([x, y, OAK[1]]);
            else if (cell.kind !== 'board' && openLeft && !cell.part.startsWith('back')) outline.push([x, y, longLit ? OAK[2] : OAK[1]]);
        }
    }
    for (const [x, y, colour] of outline) get(x, y).colour = colour;
    // A 1-texel ground contact under every foot.
    const feet = [];
    for (let y = -AY; y < H - AY; y++) {
        for (let x = -AX; x < W - AX; x++) {
            if (get(x, y)?.kind === 'foot' && !get(x, y + 1)) feet.push([x, y + 1]);
        }
    }
    for (const [x, y] of feet) put(x, y, FOOT_CONTACT, 'front', 'contact');

    // --- iron strap corners: an L of strap over each end of the table's
    // apron and down the end grain at the front corner, a crisp rivet on each.
    for (const a of [-L + 0.05, L - 0.05]) {
        for (let row = 0; row < T.apron; row++) {
            const [sx, sy] = project(a, c + d, legTop + row + 0.5);
            put(sx, sy, row === 1 ? IRON[3] : IRON[0], 'front');
        }
    }
    for (let row = 0; row < T.apron; row++) {
        const [sx, sy] = project(L, c + d - 0.05, legTop + row + 0.5);
        put(sx, sy, row === 1 ? IRON[2] : IRON[0], 'front');
    }
    for (const a of [-L + 0.05, L - 0.05]) {
        const [sx, sy] = project(a, c + d - 0.03, T.height);
        put(sx, sy, IRON[1], 'front');
    }

    // --- the beeswax candle stub on its iron dish ----------------------
    const emissive = new Uint8ClampedArray(W * H * 4);
    const glow = (x, y, hex) => {
        const i = at(x, y);
        if (i < 0) return;
        emissive.set([...hexRgb(hex), TAVERN_CANDLE_ALPHA], i * 4);
    };
    const [kx, ky] = project(TAVERN_TABLE.candle.along, TAVERN_TABLE.candle.across, T.height);
    const left = se ? kx : kx - 1;
    for (let dx = -1; dx <= 2; dx++) put(left + dx, ky, dx === -1 || dx === 2 ? IRON[0] : IRON[2], 'front');
    for (let row = 1; row <= 3; row++) {
        put(left, ky - row, row === 3 ? WAX[2] : WAX[1], 'front');
        put(left + 1, ky - row, row === 3 ? WAX[1] : WAX[0], 'front');
    }
    put(left + (se ? 1 : 0), ky - 4, OAK[0], 'front');
    glow(left + (se ? 1 : 0), ky - 4, GLOW[1]);
    glow(left + (se ? 1 : 0), ky - 3, GLOW[0]);

    const slice = (part) => {
        const out = new Uint8ClampedArray(W * H * 4);
        cells.forEach((cell, i) => {
            if (!cell || cell.part !== part) return;
            out.set([...hexRgb(cell.colour), 255], i * 4);
        });
        return out;
    };
    const art = Object.freeze({ back: slice('back'), front: slice('front'), emissive });
    tableArtCache.set(cacheKey, art);
    return art;
}

// The seeded dressing stamps (6 texels wide, foot on the bottom row),
// authored for a south-west table; a south-east one mirrors them.
// Foam and parchment stay strictly below Tier A (< 0.62 luma at noon;
// never EFFECT_COLORS.peak on a static daytime prop).
const DRESSING_ROWS = Object.freeze({
    // A foam tankard, the patrons' own (warm ivory foam head, iron hoops).
    tankard: ['.FFFF.', 'FFFFFF', 'LMMMSh', 'IIIIIh', 'LMMMSh', 'LMMMS.', 'IIIII.', '.DDD..'],
    // A folded parchment lying flat, its fold a stop down, its shadow on the oak.
    parchment: ['..PPPP', 'PPPPfp', 'ppppf.', '.kkkk.'],
    // A wooden trencher with a heel of bread.
    trencher: ['..bb..', '.kMbM.', 'kMLLMk', '.kkkk.'],
});
const DRESSING_COLOURS = Object.freeze({
    F: PLAZA[4], L: OAK[3], M: OAK[2], S: OAK[1], I: STONE[1], D: OAK[0], h: STONE[2],
    P: SAND[2], p: SAND[1], f: SAND[0], k: OAK[1], b: SAND[1],
});

/**
 * A dressing stamp as `{ width, height, rows }` (rows of colour or null),
 * mirrored for a south-east table, foot centred on the dressing point.
 */
export function tableDressingStamp(kind, facing = 'south-west') {
    const rows = DRESSING_ROWS[kind];
    if (!rows) return null;
    const mirror = facing === 'south-east';
    return {
        width: rows[0].length,
        height: rows.length,
        rows: rows.map((row) => {
            const codes = [...row];
            if (mirror) codes.reverse();
            return codes.map((code) => (code === '.' ? null : DRESSING_COLOURS[code]));
        }),
    };
}

/** World px from the seat point to the dressing stamp's top-left texel. */
export function tableDressingOrigin(seat, stamp) {
    const se = seat?.facing === 'south-east';
    const { along, across } = TAVERN_TABLE.dressing;
    const [u, v] = se ? [across, along] : [along, across];
    const x = Math.floor((u - v) * 32);
    const y = Math.floor((u + v) * 16 - TAVERN_TABLE.table.height);
    return { x: x - Math.floor(stamp.width / 2), y: y - stamp.height + 1 };
}

// ─── seat stamps ─────────────────────────────────────────────────────────────

const stampCache = new Map();

// Rasterize one box seat (a step, the pier kerb, a bar stool) into its back
// (top face) and front (camera-facing faces + contact row) pixel lists,
// relative to the seat point.
function seatPixels(seat) {
    const kind = SEAT_KINDS[seat.occluder] || SEAT_KINDS.pier;
    const colours = RAMPS[kind.ramp];
    const southEast = seat.facing !== 'south-west';
    // Long axis along tileY for a south-east sitter, tileX for south-west.
    // A lifted seat stands on a floor `lift` px above the ground.
    const lift = kind.lift || 0;
    const project = (along, across, h) => {
        const u = southEast ? across : along;
        const v = southEast ? along : across;
        return [(u - v) * TILE_HALF_W, (u + v) * TILE_HALF_H - h - lift];
    };
    const out = boxPixels(kind, project, southEast, colours, { top: 'back', front: 'front' });
    if (kind.post) {
        // A mooring post at the far (back) end of the kerb, 3 texels wide.
        const { half: L, height: H } = kind;
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

// One timber or masonry box (`half` along, ±`depth` across, `height` up)
// through `project`, its top face in the `parts.top` slice and its
// camera-facing faces in `parts.front`.
function boxPixels(kind, project, southEast, colours, parts) {
    const { half: L, depth: D, height: H } = kind;
    const quad = (points) => points.map(([a, b, h]) => project(a, b, h));
    const faces = [
        { part: parts.top, face: 'top', poly: quad([[-L, -D, H], [L, -D, H], [L, D, H], [-L, D, H]]) },
        // The long face toward the camera: +u (shade) for a south-east
        // sitter, +v (lit) for a south-west one.
        { part: parts.front, face: 'long', poly: quad([[-L, D, H], [L, D, H], [L, D, 0], [-L, D, 0]]) },
        // The end cap at +along: +v (lit) for south-east, +u (shade) for south-west.
        { part: parts.front, face: 'cap', poly: quad([[L, -D, H], [L, D, H], [L, D, 0], [L, -D, 0]]) },
    ];
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
            const hit = faces.find((face) => insideConvex(face.poly, cx, cy));
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
            : cell.face === 'long' ? longTone : capTone;
        const lift = planeLift(cell, project, kind, kind.depth);
        if (cell.face === 'long') {
            if (kind.recess && lift < H - (kind.apron || 2) && !nearLeg(cell, project, kind)) colour = colours.dark;
            if (kind.seam && Math.round(lift) === Math.round(H / 2)) colour = colours.seam;
        }
        if (kind.courses && (cell.face === 'long' || cell.face === 'cap')) {
            // Dressed blocks: a mortar row atop each course below the top one,
            // and running-bond joints (every other course offset half a block).
            const faceLift = cell.face === 'long' ? lift : capLift(cell, project, kind);
            const row = Math.floor(faceLift);
            const course = Math.floor(row / kind.courses);
            const topRow = row >= H - 1;
            const offset = course % 2 ? Math.floor(kind.block / 2) : 0;
            if (!topRow && positiveMod(row, kind.courses) === kind.courses - 1) colour = colours.seam;
            else if (!topRow && positiveMod(x + offset, kind.block) === 0) colour = colours.seam;
        }
        const up = cells.has(key(x, y - 1)); const down = cells.has(key(x, y + 1));
        const left = cells.has(key(x - 1, y)); const right = cells.has(key(x + 1, y));
        if (!down || !right) colour = colours.dark;
        else if (!up || !left) colour = colours.soft;
        out.push({ x, y, part: cell.part, colour });
    }
    // One contact row under the front faces.
    for (const cell of cells.values()) {
        if (cell.part !== parts.front || cells.has(key(cell.x, cell.y + 1))) continue;
        if (cell.face === 'top') continue;
        out.push({ x: cell.x, y: cell.y + 1, part: parts.front, colour: CONTACT });
    }
    return out;
}

// World px of a pixel above the ground, measured on the vertical plane at
// `across` (the long face at +depth): the plane's
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
    if (isArtSeat(seat)) {
        const { width, height, anchor: [ax, ay] } = TAVERN_TABLE;
        return { left: -ax, right: width - ax, top: -ay, bottom: height - ay, splitY: 0 };
    }
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

// The oak trestle cell as a canvas (`back`, `front` or `emissive`), from
// `tavernTableArt`: the fallback until the authored sheet loads, and the
// emissive channel where no sidecar companion is resident.
const tableCanvasCache = new Map();
function tavernTableCanvas(facing, part) {
    const cacheKey = `${facing === 'south-east' ? 'se' : 'sw'}|${part}`;
    if (tableCanvasCache.has(cacheKey)) return tableCanvasCache.get(cacheKey);
    if (typeof document === 'undefined') return null;
    const { width, height } = TAVERN_TABLE;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    const image = ctx.createImageData(width, height);
    image.data.set(tavernTableArt(facing)[part]);
    ctx.putImageData(image, 0, 0);
    canvas.__cvGroundKey = `tavern-table:${cacheKey}`;
    tableCanvasCache.set(cacheKey, canvas);
    return canvas;
}

const dressingCanvasCache = new Map();
function tableDressingCanvas(kind, facing) {
    const cacheKey = `${kind}|${facing}`;
    if (dressingCanvasCache.has(cacheKey)) return dressingCanvasCache.get(cacheKey);
    if (typeof document === 'undefined') return null;
    const stamp = tableDressingStamp(kind, facing);
    if (!stamp) return null;
    const canvas = document.createElement('canvas');
    canvas.width = stamp.width;
    canvas.height = stamp.height;
    const ctx = canvas.getContext('2d');
    stamp.rows.forEach((cells, y) => cells.forEach((colour, x) => {
        if (!colour) return;
        ctx.fillStyle = colour;
        ctx.fillRect(x, y, 1, 1);
    }));
    canvas.__cvGroundKey = `tavern-dressing:${cacheKey}`;
    const out = { canvas, stamp };
    dressingCanvasCache.set(cacheKey, out);
    return out;
}

// One slice of a Tavern seat at its seat point (x, y): the authored sheet
// when `assets` holds it, else the identical pixels from `tavernTableArt`;
// the front slice then lays the seat's seeded dressing on the table top.
function drawTavernSlice(ctx, x, y, seat, part, assets) {
    const [ax, ay] = TAVERN_TABLE.anchor;
    const image = assets?.get?.(tavernTableSpriteId(seat.facing, part)) || tavernTableCanvas(seat.facing, part);
    const left = Math.round(x) - ax;
    const top = Math.round(y) - ay;
    if (image) ctx.drawImage(image, left, top);
    if (part !== 'front') return;
    const dressing = tableDressingCanvas(tableDressingFor(seat), seat.facing);
    if (!dressing) return;
    const origin = tableDressingOrigin(seat, dressing.stamp);
    ctx.drawImage(dressing.canvas, Math.round(x) + origin.x, Math.round(y) + origin.y);
}

// The candle's glow for a Tavern front slice: the sidecar companion when
// resident, else the same texels from `tavernTableArt`.
function drawTavernGlow(ctx, x, y, seat, assets) {
    const [ax, ay] = TAVERN_TABLE.anchor;
    const id = tavernTableSpriteId(seat.facing, 'front');
    const glow = assets?.getCompanion?.(id, 'emissive') || tavernTableCanvas(seat.facing, 'emissive');
    if (glow) ctx.drawImage(glow, Math.round(x) - ax, Math.round(y) - ay);
}

// Two sorted props per timber seat. The back slice sorts one texel behind the
// seat point and the front slice two texels in front, so the seated body
// (sorted at its foot, the seat point) paints between them on Canvas and on
// the GPU. Where the sitter sorts behind a split building instead, the
// slices follow it there (`bracketsSitter`, DrawablePass). Stone seats have
// no prop: their sitter draws them. A Tavern seat draws the authored oak
// trestle (`assets`, the AssetManager, when given; else its own pixels);
// with `lampsLit` (the village lamp clock, `() => boolean`) its front slice
// also carries the candle's emissive channel, gated on that clock.
export function buildRestSeatPropSprites({ assets = null, lampsLit = null } = {}) {
    const sprites = [];
    for (const seat of REST_SEATS) {
        if (isStoneSeat(seat)) continue;
        const world = tileToWorld(seat.tileX, seat.tileY);
        const bounds = seatBounds(seat);
        const art = isArtSeat(seat);
        for (const [part, sortOffset] of [['back', -1], ['front', 2]]) {
            const glow = art && part === 'front' && typeof lampsLit === 'function';
            const sprite = new StaticPropSprite({
                tileX: seat.tileX,
                tileY: seat.tileY,
                id: `rest-seat.${seat.occluder}.${seat.id}.${part}`,
                bounds,
                sortY: world.y + sortOffset,
                materialClass: art ? 'timber' : null,
                channels: glow ? { emissive: (ctx, x, y) => drawTavernGlow(ctx, x, y, seat, assets) } : null,
                drawFn: (ctx, x, y) => {
                    if (art) {
                        drawTavernSlice(ctx, x, y, seat, part, assets);
                        return;
                    }
                    const stamp = seatStamp(seat, part);
                    if (stamp) ctx.drawImage(stamp.canvas, Math.round(x) + stamp.x, Math.round(y) + stamp.y);
                },
            });
            if (glow) sprite.emitterGate = () => (lampsLit() === true ? 1 : 0);
            sprite.bracketsSitter = true;
            sprites.push(sprite);
        }
    }
    return sprites;
}

// ─── the Tavern's tankards ─────────────────────────────────────────────────────

// A patron seated at a Tavern table holds a wooden tankard of ale at its chest
// and now and then lifts it to drink: SIP_LIFT texels per step of a sip, held
// on the pixel grid (never a tween). The sip cadence is seeded per patron so a
// table never drinks in unison; reduced motion holds the tankard at rest.
export const TANKARD_SIP_LIFT = Object.freeze([0, 3, 6, 7, 7, 6, 3]);
// The authored `drink` strip frame for each sip step (0 rest, 1 raising, 2–3
// at the mouth, 4 lowering), for profiles whose action strip draws the drink.
export const DRINK_FRAME_BY_STEP = Object.freeze([0, 1, 2, 3, 3, 4, 4]);
export const TANKARD_SIP_STEP_MS = 160;
const TANKARD_SIP_MIN_MS = 7000;
const TANKARD_SIP_MAX_MS = 15000;

const tankardCache = new Map();

// A 6x8 wooden tankard: a cream head of foam, iron-hooped staves (lit left,
// shaded right, dark selective edge), a handle on the outer side. `mirror`
// puts the handle on the left (a south-west sitter holds it in its left side).
// Returns a canvas whose bottom-left corner is the tankard's foot.
export function tankardStamp(mirror = false) {
    const cacheKey = mirror ? 'w' : 'e';
    if (tankardCache.has(cacheKey)) return tankardCache.get(cacheKey);
    if (typeof document === 'undefined') return null;
    const rows = [
        '.FFFF.',
        'FFFFFF',
        'LMMMSh',
        'IIIIIh',
        'LMMMSh',
        'LMMMS.',
        'IIIII.',
        '.DDD..',
    ];
    const colours = {
        F: PLAZA[4], L: TIMBER[3], M: TIMBER[2], S: TIMBER[1],
        I: STONE[1], D: TIMBER[0], h: STONE[2],
    };
    const canvas = document.createElement('canvas');
    canvas.width = 6;
    canvas.height = rows.length;
    const ctx = canvas.getContext('2d');
    rows.forEach((row, y) => {
        [...row].forEach((code, x) => {
            if (code === '.') return;
            ctx.fillStyle = colours[code];
            ctx.fillRect(mirror ? 5 - x : x, y, 1, 1);
        });
    });
    canvas.__cvGroundKey = `tavern-tankard:${cacheKey}`;
    tankardCache.set(cacheKey, canvas);
    return canvas;
}

// The sip step (an index into TANKARD_SIP_LIFT) at `now` for patron
// `agentId`, or -1 between sips and under reduced motion.
export function tankardSipStep(agentId, now, motion = true) {
    if (!motion) return -1;
    let hash = 2166136261;
    const key = String(agentId ?? '');
    for (let i = 0; i < key.length; i++) hash = Math.imul(hash ^ key.charCodeAt(i), 16777619);
    hash >>>= 0;
    const period = TANKARD_SIP_MIN_MS + (hash % (TANKARD_SIP_MAX_MS - TANKARD_SIP_MIN_MS));
    const t = (now + (hash % period)) % period;
    const step = Math.floor(t / TANKARD_SIP_STEP_MS);
    return step < TANKARD_SIP_LIFT.length ? step : -1;
}

// Texels the tankard stands above its rest at `now` for patron `agentId`:
// 0 between sips, a TANKARD_SIP_LIFT step during one.
export function tankardLift(agentId, now, motion = true) {
    const step = tankardSipStep(agentId, now, motion);
    return step < 0 ? 0 : TANKARD_SIP_LIFT[step];
}

// ─── petitioner candles (7.2) ────────────────────────────────────────────────

// Wax texels per wait-age rung (< 1 / 1–5 / 5–15 / >= 15 min).
const CANDLE_WAX_BY_TIER = Object.freeze([12, 9, 6, 3]);

// Wax texels for a wait age; null age (unknown) is the unlit 3-texel stub.
export function candleWaxTexels(ageMs) {
    const tier = waitAgeTier(ageMs);
    return tier === null ? 3 : CANDLE_WAX_BY_TIER[tier];
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
