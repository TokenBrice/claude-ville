// GroundBake — the land surface as one art-directed bake (plan items 3.2,
// 3.3, 4.7 and the ground half of 4.2 in
// agents/plans/claudeville-opus55-aesthetic-plan.md).
//
// Replaces per-tile land stamping (square Wang cells stretched into the iso
// diamond, per-tile tone diamonds, 1×1 flecks, cube-shaped vegetation
// sprites) with a pixel bake at the terrain sheets' own texel density: one
// texel = 2×1 world px. Per texel:
//   1. class field   grass / sand / dirt / yard / road / plaza from the tile
//                    sets, bilinear between tile centres, thresholded with an
//                    organic noise offset and a 2×1 texel jitter so edges are
//                    hand-drawn, never tile-shaped. Sand and the waterline
//                    come from Water's coast field (CoastBake.js).
//   2. texture       the existing Wang sheets as luminance sources, sampled
//                    in true 2:1 iso orientation (cell NW corner → the tile's
//                    top vertex) and switched between mirrored/offset
//                    variants along noise contours, so no tile period shows.
//   3. C1 ramps      every texel is a stop of ART_RAMPS (GROUND_RAMP_KEYS):
//                    index = 2 + texture z + macro drift + Bayer 2×2. Grass is
//                    the lowest land value, paths about +1.5 steps, the
//                    Command plaza the lightest paved floor.
//   4. macro fields  6–7-tile value drift plus district-anchored warmth:
//                    drier/warmer grass by the workshops, lusher/cooler under
//                    the northern canopy and by the scholars' buildings; the
//                    forest floor a further half ramp step darker (5.4).
//   5. contact AO    ramp-step darkening outside building footprints (longer
//                    on the down-light sides), under tree canopies and props.
//   6. thresholds    authored worn-earth corridors from each door along its
//                    frontage spur, lighter along the trodden centre line.
//   7. yards (4.7)   each district's frontage apron in its own material
//                    (flagstone, gravel, cinder, earth) with low baked kerbs
//                    or wattle edging where it meets grass.
//   8. living ground (plan 5.1 and 5.4 of
//                    agents/plans/claudeville-opus55-xhigh-visual-plan.md)
//                    a chamfer distance from grass to the paths and a crown
//                    field pushed downwind under every tree place clustered
//                    micro-detail: an unmown verge of blades and seed heads
//                    along every path (dead stems in winter), twigs, moss and
//                    pine needle duff under crowns, weeds at wall bases, rare
//                    meadow pockets; by season, autumn leaf litter matching
//                    the crown above and dry-grass patches, spring petals
//                    under blossoming oaks, winter leaf mould.
//   9. decals        sparse clusters at native texel density: meadow flower
//                    pockets, grass tufts, low shrubs, bank reeds, pebbles.
//
// Registered as terrain bake pass 'ground-splat' (stage 'ground'). The result
// is cached here per season/scenery/coast revision, so a terrain-cache rebake
// for any other reason reuses it. Zero per-frame cost; reduced-motion neutral
// (static); reads no phase, weather or camera — the grade owns time of day.
//
// Publishes `renderer.groundField` (class per texel) for Water's coast pass
// and any later ground consumer.

import { ART_RAMPS } from '../../config/artPalette.js';
import { MAP_SIZE, TILE_WIDTH, TILE_HEIGHT } from '../../config/constants.js';
import { FOREST_FLOOR_REGIONS } from '../../config/scenery.js';
import { YARD_MATERIALS } from '../../config/townPlan.js';
import { readTerrainCellLuma } from './TerrainTileset.js';
import { getCoastField } from './CoastBake.js';

export const GROUND_CLASS = Object.freeze({
    NONE: 0,
    GRASS: 1,
    DIRT: 2,
    ROAD: 3,
    PLAZA: 4,
    SAND: 5,
    WATER: 6,
});

const TEXEL_W = 2;
const HALF_W = TILE_WIDTH / 2;
const HALF_H = TILE_HEIGHT / 2;

// ---- surfaces -------------------------------------------------------------

const S_GRASS = 0;
const S_SAND = 1;
const S_DIRT = 2;
const S_ROAD = 3;
const S_PLAZA = 4;
const S_FLAG = 5;
const S_GRAVEL = 6;
const S_CINDER = 7;
const S_EARTH = 8;

const YARD_SURFACE_IDS = Object.freeze({ flag: S_FLAG, gravel: S_GRAVEL, cinder: S_CINDER, earth: S_EARTH });

const hexRgb = (hex) => [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
];
const mixRgb = (a, b, t) => [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
];
const ramp = (key) => ART_RAMPS[key].map(hexRgb);

const GRASS = ramp('grass');
const DIRT = ramp('dirt');
const ROAD = ramp('road');
const PLAZA = ramp('plaza');
const SAND = ramp('sand');
const FOLIAGE = ramp('foliage');
const TIMBER = ramp('timber');
const OCHRE = ramp('clothOchre');
const LEAF = ramp('leafAutumn');
const BLOSSOM = ramp('blossom');
// Grass drift ramps derived from C1 (same value ladder, shifted hue): dry
// grass leans toward the earth ramp, lush grass toward the sage foliage.
const GRASS_DRY = GRASS.map((c, i) => mixRgb(c, DIRT[Math.max(0, i - 1)], 0.18));
const GRASS_LUSH = GRASS.map((c, i) => mixRgb(c, FOLIAGE[Math.min(4, i + 1)], 0.18));

// Per surface: ramp, texture set, ramp offset (steps), texture contrast,
// published class.
const SURFACES = [
    /* grass  */ { ramp: GRASS, tex: 'grass', offset: 0, contrast: 1.1, cls: GROUND_CLASS.GRASS },
    /* sand   */ { ramp: SAND, tex: 'sand', offset: -0.2, contrast: 0.8, cls: GROUND_CLASS.SAND },
    /* dirt   */ { ramp: DIRT, tex: 'dirt', offset: 0, contrast: 1.0, cls: GROUND_CLASS.DIRT },
    /* road   */ { ramp: ROAD, tex: 'cobble', offset: 0.1, contrast: 0.95, cls: GROUND_CLASS.ROAD },
    /* plaza  */ { ramp: PLAZA, tex: 'square', offset: 0.9, contrast: 0.85, cls: GROUND_CLASS.PLAZA },
    /* flag   */ { ramp: PLAZA, tex: 'square', offset: -0.7, contrast: 0.95, cls: GROUND_CLASS.PLAZA },
    /* gravel */ { ramp: ROAD, tex: 'dirt', offset: -0.2, contrast: 0.75, cls: GROUND_CLASS.ROAD },
    /* cinder */ { ramp: DIRT, tex: 'dirt', offset: -1.5, contrast: 1.0, cls: GROUND_CLASS.DIRT },
    /* earth  */ { ramp: DIRT, tex: 'dirt', offset: 0.3, contrast: 0.95, cls: GROUND_CLASS.DIRT },
];

const SURFACE_EDGE = new Array(SURFACES.length).fill(null);
SURFACE_EDGE[S_PLAZA] = 'kerb';

// Texture sources: full-class cells of the land Wang sheets (cell 0 = all
// lower class, 15 = all upper class). Colours are discarded; only the
// luminance drawing is kept and re-toned onto the ramps.
const TEXTURE_SOURCES = Object.freeze({
    grass: [['terrain.grass-dirt', 0], ['terrain.grass-cobble', 0], ['terrain.grass-shore', 0]],
    dirt: [['terrain.grass-dirt', 15]],
    cobble: [['terrain.grass-cobble', 15]],
    square: [['terrain.cobble-square', 15]],
    sand: [['terrain.grass-shore', 15]],
});

// ---- tile codes and layer membership --------------------------------------

// Sand and water are not tile layers: both come from the coast field.
const T_GRASS = 0;
const T_DIRT = 1;
const T_ROAD = 2;
const T_PLAZA = 3;
const T_YARD = 4;
const T_YARD_PAVED = 5;

const M_DIRT = 1;
const M_YARD = 2;
const M_ROAD = 4;
const M_PLAZA = 8;

const TILE_MASK = [
    /* grass */ 0,
    /* dirt  */ M_DIRT,
    /* road  */ M_DIRT | M_ROAD,
    /* plaza */ M_DIRT | M_ROAD | M_PLAZA,
    /* yard  */ M_YARD,
    /* paved yard */ M_ROAD | M_YARD,
];

// Ordered layers: later wins. `amp` is the organic edge offset (tiles of
// membership), `thr` the threshold. Dirt counts roads and the plaza, so each
// carries a worn-earth shoulder. Yards take no shoulder: they meet the grass
// directly, where their edging is drawn; paved yards also count as road, so
// stone meets stone without an earth seam. The plaza edge stays crisp.
const LAYERS = [
    { bit: M_DIRT, thr: 0.47, amp: 0.34, surface: S_DIRT },
    { bit: M_ROAD, thr: 0.5, amp: 0.18, surface: S_ROAD },
    { bit: M_YARD, thr: 0.5, amp: 0.16, surface: -1 },
    { bit: M_PLAZA, thr: 0.5, amp: 0.07, surface: S_PLAZA },
];

// District drift anchors (4.7/3.2): warmth > 0 dries the grass toward earth,
// < 0 cools it toward sage; value shifts ramp steps. Gaussian, ~6-tile reach.
const DISTRICT_DRIFT = Object.freeze({
    forge: { warm: 0.75, value: 0.1 },
    mine: { warm: 0.6, value: 0 },
    taskboard: { warm: 0.4, value: 0.1 },
    command: { warm: 0.15, value: 0.15 },
    harbor: { warm: 0.3, value: 0.1 },
    archive: { warm: -0.6, value: -0.1 },
    observatory: { warm: -0.35, value: 0 },
    portal: { warm: -0.5, value: -0.2 },
    watchtower: { warm: -0.3, value: -0.1 },
});

const BAYER = [0, 2, 3, 1].map(v => v / 4 - 0.375);
// 5.4 — grass inside the forest floors sits half a ramp step darker.
const FOREST_FLOOR_STEP = 0.5;

// ---- noise ----------------------------------------------------------------

function hash2(x, y, s) {
    let h = (Math.imul(x | 0, 73856093) ^ Math.imul(y | 0, 19349663) ^ Math.imul(s | 0, 83492791)) >>> 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function vnoise(x, y, s) {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const fx = x - xi;
    const fy = y - yi;
    const u = fx * fx * (3 - 2 * fx);
    const v = fy * fy * (3 - 2 * fy);
    const a = hash2(xi, yi, s);
    const b = hash2(xi + 1, yi, s);
    const c = hash2(xi, yi + 1, s);
    const d = hash2(xi + 1, yi + 1, s);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

const fbm = (x, y, s) => 0.62 * vnoise(x * 1.1, y * 1.1, s) + 0.38 * vnoise(x * 2.9, y * 2.9, s + 7);

// ---- inputs ---------------------------------------------------------------

function buildTileGrid(r) {
    const N = MAP_SIZE;
    const code = new Uint8Array(N * N);
    const yardSurface = new Uint8Array(N * N);
    for (let y = 0; y < N; y++) {
        for (let x = 0; x < N; x++) {
            const key = `${x},${y}`;
            const i = y * N + x;
            const bridge = r.bridgeTiles?.has(key);
            // The frontage apron is the yard even where a route crosses it.
            const yardType = r.yardTiles?.get(key);
            const yard = yardType ? YARD_MATERIALS[yardType] : null;
            let c = T_GRASS;
            if (r.townSquareTiles?.has(key)) c = T_PLAZA;
            else if (yard) c = yard.paved ? T_YARD_PAVED : T_YARD;
            else if (r.mainAvenueTiles?.has(key) || bridge) c = T_ROAD;
            else if (r.dirtPathTiles?.has(key) || r.pathTiles?.has(key)) c = T_DIRT;
            code[i] = c;
            if (yard) yardSurface[i] = YARD_SURFACE_IDS[yard.surface] ?? S_EARTH;
        }
    }
    return { code, yardSurface };
}

// Macro value and warmth drift sampled at tile centres (bilinear per texel),
// plus the forest-floor weight (0 outside FOREST_FLOOR_REGIONS, 1 a third of
// the way in) that darkens the woods' grass by FOREST_FLOOR_STEP (5.4).
function buildDriftGrid(r) {
    const N = MAP_SIZE;
    const value = new Float32Array(N * N);
    const warm = new Float32Array(N * N);
    const forest = new Float32Array(N * N);
    const anchors = [];
    for (const b of r.world?.buildings?.values?.() || []) {
        const drift = DISTRICT_DRIFT[b.type];
        if (!drift) continue;
        anchors.push({ x: b.position.tileX + b.width / 2 - 0.5, y: b.position.tileY + b.height / 2 - 0.5, ...drift });
    }
    for (let y = 0; y < N; y++) {
        for (let x = 0; x < N; x++) {
            let v = (vnoise(x / 6.5, y / 6.5, 3) - 0.5) * 1.3;
            let w = (vnoise(x / 7.5 + 40, y / 7.5, 9) - 0.5) * 1.2;
            for (const a of anchors) {
                const d2 = ((x - a.x) ** 2 + (y - a.y) ** 2) / 36;
                if (d2 > 4) continue;
                const g = Math.exp(-d2);
                v += a.value * g;
                w += a.warm * g;
            }
            let f = 0;
            for (const region of FOREST_FLOOR_REGIONS) {
                const dx = (x + 0.5 - region.centerX) / region.radiusX;
                const dy = (y + 0.5 - region.centerY) / region.radiusY;
                const d = dx * dx + dy * dy;
                if (d >= 1) continue;
                const s = (1 - d) * (region.strength ?? 1);
                v -= 0.45 * s;
                w -= 0.7 * s;
                f = Math.max(f, Math.min(1, (1 - d) * 3));
            }
            value[y * N + x] = v;
            warm[y * N + x] = w;
            forest[y * N + x] = f;
        }
    }
    return { value, warm, forest };
}

function readTextures(r) {
    const out = {};
    const assets = r.assets;
    for (const [name, sources] of Object.entries(TEXTURE_SOURCES)) {
        const list = [];
        for (const [id, cell] of sources) {
            const image = assets?.get?.(id, { request: false }) ?? null;
            const luma = image ? readTerrainCellLuma(image, cell) : null;
            if (luma) list.push(luma);
        }
        if (!list.length) list.push(proceduralTexture(name.length * 17));
        out[name] = list;
    }
    return out;
}

// No-assets fallback: a z-scored value-noise texture that tiles at 32.
function proceduralTexture(seed) {
    const t = new Float32Array(32 * 32);
    for (let v = 0; v < 32; v++) {
        for (let u = 0; u < 32; u++) {
            const n = 0.6 * vnoise(u / 4, v / 4, seed) + 0.4 * hash2(u, v, seed + 1);
            t[v * 32 + u] = (n - 0.5) * 3;
        }
    }
    return t;
}

// Contact occluders bucketed by tile so each texel tests only its neighbours.
function buildOccluders(r) {
    const N = MAP_SIZE;
    const buckets = new Array(N * N);
    const add = (occ, reach) => {
        const x0 = Math.max(0, Math.floor(occ.minX - reach));
        const x1 = Math.min(N - 1, Math.ceil(occ.maxX + reach));
        const y0 = Math.max(0, Math.floor(occ.minY - reach));
        const y1 = Math.min(N - 1, Math.ceil(occ.maxY + reach));
        for (let y = y0; y <= y1; y++) {
            for (let x = x0; x <= x1; x++) (buckets[y * N + x] ||= []).push(occ);
        }
    };
    for (const b of r.world?.buildings?.values?.() || []) {
        const minX = b.position.tileX - 0.5;
        const minY = b.position.tileY - 0.5;
        add({ kind: 0, minX, minY, maxX: minX + b.width, maxY: minY + b.height, reach: 0.95, strength: 1 }, 1.4);
    }
    for (const t of r.scenery?.getTreeProps?.() || []) {
        const cx = t.tileX + 0.1;
        const cy = t.tileY + 0.1;
        add({ kind: 1, cx, cy, minX: cx, maxX: cx, minY: cy, maxY: cy, reach: 0.55, strength: 0.75 }, 0.6);
    }
    for (const p of r._staticPropSprites || []) {
        if (p.id === 'fantasy.tree') continue;
        const cx = p.tileX;
        const cy = p.tileY;
        add({ kind: 1, cx, cy, minX: cx, maxX: cx, minY: cy, maxY: cy, reach: 0.34, strength: 0.55 }, 0.4);
    }
    return buckets;
}

function occlusionAt(bucket, tx, ty) {
    let ao = 0;
    for (let i = 0; i < bucket.length; i++) {
        const o = bucket[i];
        let d;
        if (o.kind === 0) {
            // Down-light sides (+tx is screen lower-right, +ty lower-left)
            // take the longer contact shadow; the lit up-left side the least.
            const ex = tx < o.minX ? (o.minX - tx) / 0.65 : tx > o.maxX ? (tx - o.maxX) / 1.35 : 0;
            const ey = ty < o.minY ? (o.minY - ty) / 0.8 : ty > o.maxY ? (ty - o.maxY) / 1.0 : 0;
            if (ex === 0 && ey === 0) return 1;
            d = Math.sqrt(ex * ex + ey * ey);
        } else {
            d = Math.hypot(tx - o.cx, (ty - o.cy) * 1.15);
        }
        if (d >= o.reach) continue;
        const a = (1 - d / o.reach) ** 1.5 * o.strength;
        if (a > ao) ao = a;
    }
    return ao;
}

// Worn-to-the-door corridors: door point on the footprint edge → entrance →
// frontage spur, as tile-space segments.
function buildWearSegments(r) {
    const segs = [];
    const spurs = new Map((r.frontageSpurs || []).map(s => [s.type, s.tiles]));
    for (const b of r.world?.buildings?.values?.() || []) {
        const e = b.entrance;
        if (!e) continue;
        const minX = b.position.tileX - 0.5;
        const minY = b.position.tileY - 0.5;
        const maxX = minX + b.width;
        const maxY = minY + b.height;
        const door = { x: Math.max(minX, Math.min(maxX, e.tileX)), y: Math.max(minY, Math.min(maxY, e.tileY)) };
        const points = [door, { x: e.tileX, y: e.tileY }];
        for (const t of spurs.get(b.type) || []) {
            const last = points[points.length - 1];
            if (t.tileX !== last.x || t.tileY !== last.y) points.push({ x: t.tileX, y: t.tileY });
        }
        // Stop the worn line a little short of the road it joins.
        for (let i = 0; i < points.length - 1; i++) {
            const a = points[i];
            const bpt = points[i + 1];
            const lastSeg = i === points.length - 2 && points.length > 2;
            const end = lastSeg ? { x: a.x + (bpt.x - a.x) * 0.6, y: a.y + (bpt.y - a.y) * 0.6 } : bpt;
            segs.push({ ax: a.x, ay: a.y, bx: end.x, by: end.y, paved: b.type === 'command' });
        }
    }
    const N = MAP_SIZE;
    const buckets = new Array(N * N);
    for (const s of segs) {
        const x0 = Math.max(0, Math.floor(Math.min(s.ax, s.bx) - 1));
        const x1 = Math.min(N - 1, Math.ceil(Math.max(s.ax, s.bx) + 1));
        const y0 = Math.max(0, Math.floor(Math.min(s.ay, s.by) - 1));
        const y1 = Math.min(N - 1, Math.ceil(Math.max(s.ay, s.by) + 1));
        for (let y = y0; y <= y1; y++) {
            for (let x = x0; x <= x1; x++) (buckets[y * N + x] ||= []).push(s);
        }
    }
    return buckets;
}

function segmentDistance(s, x, y) {
    const dx = s.bx - s.ax;
    const dy = s.by - s.ay;
    const len2 = dx * dx + dy * dy || 1e-6;
    const t = Math.max(0, Math.min(1, ((x - s.ax) * dx + (y - s.ay) * dy) / len2));
    return Math.hypot(x - (s.ax + dx * t), y - (s.ay + dy * t));
}

// ---- bake -----------------------------------------------------------------

export function bakeGround(r) {
    const started = performance.now();
    const N = MAP_SIZE;
    const x0 = -N * HALF_W;
    const y0 = -HALF_H;
    const w = N * TILE_WIDTH;
    const h = N * TILE_HEIGHT;
    const cols = w / TEXEL_W;
    const rows = h;
    const coast = getCoastField(r);
    const { code, yardSurface } = buildTileGrid(r);
    const mask = new Uint8Array(N * N);
    for (let i = 0; i < mask.length; i++) mask[i] = TILE_MASK[code[i]];
    const drift = buildDriftGrid(r);
    const textures = readTextures(r);
    const occluders = buildOccluders(r);
    const wear = buildWearSegments(r);
    const texBySurface = SURFACES.map(s => textures[s.tex]);

    const classes = new Uint8Array(cols * rows);
    const surfaces = new Uint8Array(cols * rows).fill(255);
    const sdBuf = new Float32Array(cols * rows).fill(9);
    const aoBuf = new Uint8Array(cols * rows);
    // Ramp stop index per texel, so the living-ground pass can re-tone grass
    // (dry patches) on the same value ladder.
    const stepBuf = new Uint8Array(cols * rows);
    const image = new ImageData(w, h);
    const D = image.data;
    const clampI = (v) => (v < 0 ? 0 : v >= N ? N - 1 : v);

    for (let row = 0; row < rows; row++) {
        const sy = y0 + row + 0.5;
        for (let col = 0; col < cols; col++) {
            const sx = x0 + col * TEXEL_W + 1;
            const tx = sx / TILE_WIDTH + sy / TILE_HEIGHT;
            const ty = sy / TILE_HEIGHT - sx / TILE_WIDTH;
            if (tx < -0.5 || ty < -0.5 || tx >= N - 0.5 || ty >= N - 0.5) continue;
            const ti = row * cols + col;

            const ix = Math.floor(tx);
            const iy = Math.floor(ty);
            const fx = tx - ix;
            const fy = ty - iy;
            const x0i = clampI(ix);
            const x1i = clampI(ix + 1);
            const y0i = clampI(iy);
            const y1i = clampI(iy + 1);
            const i00 = y0i * N + x0i;
            const i10 = y0i * N + x1i;
            const i01 = y1i * N + x0i;
            const i11 = y1i * N + x1i;
            const m00 = mask[i00];
            const m10 = mask[i10];
            const m01 = mask[i01];
            const m11 = mask[i11];
            const any = m00 | m10 | m01 | m11;
            const all = m00 & m10 & m01 & m11;
            const w00 = (1 - fx) * (1 - fy);
            const w10 = fx * (1 - fy);
            const w01 = (1 - fx) * fy;
            const w11 = fx * fy;
            const jitter = (hash2(col, row, 5) - 0.5) * 0.05;
            let edgeNoise = -1;

            // Waterline from Water's coast field. Water pixels belong to the
            // coast pass; the dry sand runs 0.3 tile under its waterline so
            // the two never gap.
            const sd = coast.signedDistance(tx, ty);
            sdBuf[ti] = sd;
            if (sd > 0.3) {
                classes[ti] = GROUND_CLASS.WATER;
                continue;
            }

            let surface = S_GRASS;
            let lip = 0;
            let tuck = 0;
            const sandWidth = 0.18 + 0.5 * vnoise(tx / 2.6, ty / 2.6, 21);
            if (sd > 0 || sd > -sandWidth + jitter) surface = S_SAND;
            else if (sd > -sandWidth - 0.08) tuck = 1;

            for (let li = 0; li < LAYERS.length; li++) {
                const L = LAYERS[li];
                if (!(any & L.bit)) continue;
                let v;
                if (all & L.bit) {
                    v = 1;
                } else {
                    v = (m00 & L.bit ? w00 : 0) + (m10 & L.bit ? w10 : 0) + (m01 & L.bit ? w01 : 0) + (m11 & L.bit ? w11 : 0);
                    if (edgeNoise < 0) edgeNoise = fbm(tx * 1.7, ty * 1.7, 11);
                    const n = li & 1 ? 1 - edgeNoise : edgeNoise;
                    v += (n - 0.5) * 2 * L.amp + jitter;
                }
                if (v > L.thr) {
                    if (L.surface < 0) {
                        // Yard: the material of the strongest yard corner.
                        let best = -1;
                        let bestW = -1;
                        if ((m00 & M_YARD) && w00 > bestW) { best = i00; bestW = w00; }
                        if ((m10 & M_YARD) && w10 > bestW) { best = i10; bestW = w10; }
                        if ((m01 & M_YARD) && w01 > bestW) { best = i01; bestW = w01; }
                        if ((m11 & M_YARD) && w11 > bestW) { best = i11; bestW = w11; }
                        surface = yardSurface[best];
                    } else {
                        surface = L.surface;
                    }
                    lip = v - L.thr < 0.06 ? 1 : 0;
                    tuck = 0;
                } else if (L.thr - v < 0.07 && (surface === S_GRASS || surface === S_SAND)) {
                    tuck = 1;
                }
            }

            // Worn-to-the-door thresholds.
            let wearStep = 0;
            const wb = wear[clampI(Math.round(ty)) * N + clampI(Math.round(tx))];
            if (wb) {
                let dmin = 9;
                let paved = false;
                for (let k = 0; k < wb.length; k++) {
                    const d = segmentDistance(wb[k], tx, ty);
                    if (d < dmin) { dmin = d; paved = wb[k].paved; }
                }
                const half = 0.28 + (vnoise(tx * 2.3, ty * 2.3, 31) - 0.5) * 0.14;
                if (dmin < half) {
                    if (!paved && (surface === S_GRASS || surface === S_SAND)) surface = S_DIRT;
                    wearStep = dmin < 0.1 ? 0.9 : 0.35;
                    tuck = 0;
                } else if (dmin < half + 0.07 && surface === S_GRASS) {
                    tuck = 1;
                }
            }

            // Contact AO.
            const ob = occluders[clampI(Math.round(ty)) * N + clampI(Math.round(tx))];
            const ao = ob ? occlusionAt(ob, tx, ty) : 0;
            aoBuf[ti] = Math.round(ao * 255);

            // Texture (iso-oriented) with variant switching on noise contours.
            const S = SURFACES[surface];
            const texList = texBySurface[surface];
            const variantField = vnoise(tx / 2.2, ty / 2.2, 41 + surface);
            const vi = Math.min(texList.length * 4 - 1, Math.floor(variantField * texList.length * 4));
            const tex = texList[vi >> 2];
            const shift = vi & 2 ? 16 : 0;
            let u = (Math.floor((tx + 0.5) * 32) + shift) & 31;
            const v = (Math.floor((ty + 0.5) * 32) + shift) & 31;
            if (vi & 1) u = 31 - u;
            const z = tex[v * 32 + u];

            const bx = clampI(Math.floor(tx));
            const by = clampI(Math.floor(ty));
            const dfx = tx - bx;
            const dfy = ty - by;
            const bx1 = clampI(bx + 1);
            const by1 = clampI(by + 1);
            const lerp4 = (g) => (g[by * N + bx] * (1 - dfx) + g[by * N + bx1] * dfx) * (1 - dfy)
                + (g[by1 * N + bx] * (1 - dfx) + g[by1 * N + bx1] * dfx) * dfy;
            const macro = lerp4(drift.value);
            const dither = BAYER[(row & 1) * 2 + (col & 1)];

            let k = 2 + S.offset + z * S.contrast + macro + dither * 0.75
                + lip * 0.8 - tuck * 1.0 - ao * 3.2 + wearStep;
            if (surface === S_GRASS) k -= FOREST_FLOOR_STEP * lerp4(drift.forest);
            k = k < 0 ? 0 : k > 4 ? 4 : Math.round(k);

            let rampColors = S.ramp;
            if (surface === S_GRASS) {
                const warmth = lerp4(drift.warm) + dither * 0.5;
                rampColors = warmth > 0.42 ? GRASS_DRY : warmth < -0.42 ? GRASS_LUSH : GRASS;
            }
            const c = rampColors[k];
            const o = (row * w + col * TEXEL_W) * 4;
            D[o] = c[0]; D[o + 1] = c[1]; D[o + 2] = c[2]; D[o + 3] = 255;
            D[o + 4] = c[0]; D[o + 5] = c[1]; D[o + 6] = c[2]; D[o + 7] = 255;
            classes[ti] = sd > 0 ? GROUND_CLASS.WATER : S.cls;
            surfaces[ti] = surface;
            stepBuf[ti] = k;
        }
    }

    const put = (col, row, c) => {
        if (col < 0 || row < 0 || col >= cols || row >= rows) return;
        const o = (row * w + col * TEXEL_W) * 4;
        D[o] = c[0]; D[o + 1] = c[1]; D[o + 2] = c[2]; D[o + 3] = 255;
        D[o + 4] = c[0]; D[o + 5] = c[1]; D[o + 6] = c[2]; D[o + 7] = 255;
    };

    drawYardEdges({ cols, rows, surfaces, put });
    drawLivingGround(r, { cols, rows, x0, y0, surfaces, aoBuf, stepBuf, put, season: r._terrainSeason || 'summer' });
    drawDecals(r, { cols, rows, x0, y0, surfaces, sdBuf, aoBuf, put, season: r._terrainSeason || 'summer' });

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    canvas.getContext('2d').putImageData(image, 0, 0);
    const field = {
        bounds: { x: x0, y: y0, w, h },
        cols,
        rows,
        texelW: TEXEL_W,
        classes,
        CLASS: GROUND_CLASS,
        classAt(worldX, worldY) {
            const col = Math.floor((worldX - x0) / TEXEL_W);
            const row = Math.floor(worldY - y0);
            if (col < 0 || row < 0 || col >= cols || row >= rows) return GROUND_CLASS.NONE;
            return classes[row * cols + col];
        },
    };
    return { canvas, field, ms: performance.now() - started, x0, y0 };
}

// Kerbs and wattle where a paved or fenced yard meets grass/sand (4.7).
function drawYardEdges({ cols, rows, surfaces, put }) {
    const edgeOf = (s) => (s === 255 ? null : s >= S_FLAG ? edgeForYardSurface(s) : SURFACE_EDGE[s]);
    // A kerb dresses every paved edge onto unpaved ground; wattle only fences
    // yard from open grass, never across the earth paths agents walk.
    const unpaved = (s) => s === S_GRASS || s === S_SAND || s === S_DIRT || s === S_EARTH || s === S_CINDER;
    const grassy = (s) => s === S_GRASS || s === S_SAND;
    for (let row = 1; row < rows - 1; row++) {
        for (let col = 1; col < cols - 1; col++) {
            const s = surfaces[row * cols + col];
            const edge = edgeOf(s);
            if (!edge) continue;
            const soft = edge === 'kerb' ? unpaved : grassy;
            const below = surfaces[(row + 1) * cols + col];
            const above = surfaces[(row - 1) * cols + col];
            const left = surfaces[row * cols + col - 1];
            const right = surfaces[row * cols + col + 1];
            const outBelow = soft(below) && below !== s;
            const out = outBelow || (soft(above) && above !== s) || (soft(left) && left !== s) || (soft(right) && right !== s);
            if (!out) continue;
            if (edge === 'kerb') {
                // Dressed kerb: dark riser facing the viewer, light top edge
                // elsewhere.
                put(col, row, outBelow ? ROAD[1] : PLAZA[4]);
            } else {
                // Wattle: a low woven rail with posts every 6 texels.
                put(col, row, TIMBER[1]);
                if (col % 6 === 0) {
                    put(col, row - 1, TIMBER[2]);
                    put(col, row - 2, TIMBER[2]);
                    put(col, row - 3, TIMBER[3]);
                } else if (outBelow) {
                    put(col, row - 1, TIMBER[2]);
                }
            }
        }
    }
}

const edgeForYardSurface = (() => {
    const bySurface = new Map();
    for (const yard of Object.values(YARD_MATERIALS)) {
        const id = YARD_SURFACE_IDS[yard.surface];
        if (id !== undefined && yard.edge && !bySurface.has(id)) bySurface.set(id, yard.edge);
    }
    return (s) => bySurface.get(s) || null;
})();

// ---- living ground (5.1 seasons, 5.4 micro-detail) ------------------------

// Two-pass 5-7 chamfer distance (in fifths of a texel) from every grass or
// sand texel to the nearest paved or trodden texel. The 2×1 texel is square on
// the ground plane (2 world px across = 1 px down in 2:1 iso), so one mask
// serves both axes. Water and off-map texels are not sources.
const CHAMFER_A = 5;
const CHAMFER_B = 7;
function chamferToPaths(cols, rows, surfaces) {
    const far = 65535;
    const d = new Uint16Array(cols * rows);
    for (let i = 0; i < d.length; i++) {
        const s = surfaces[i];
        d[i] = s === S_GRASS || s === S_SAND || s === 255 ? far : 0;
    }
    for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
            const i = row * cols + col;
            let v = d[i];
            if (v === 0) continue;
            if (col > 0) v = Math.min(v, d[i - 1] + CHAMFER_A);
            if (row > 0) {
                v = Math.min(v, d[i - cols] + CHAMFER_A);
                if (col > 0) v = Math.min(v, d[i - cols - 1] + CHAMFER_B);
                if (col < cols - 1) v = Math.min(v, d[i - cols + 1] + CHAMFER_B);
            }
            d[i] = v;
        }
    }
    for (let row = rows - 1; row >= 0; row--) {
        for (let col = cols - 1; col >= 0; col--) {
            const i = row * cols + col;
            let v = d[i];
            if (v === 0) continue;
            if (col < cols - 1) v = Math.min(v, d[i + 1] + CHAMFER_A);
            if (row < rows - 1) {
                v = Math.min(v, d[i + cols] + CHAMFER_A);
                if (col < cols - 1) v = Math.min(v, d[i + cols + 1] + CHAMFER_B);
                if (col > 0) v = Math.min(v, d[i + cols - 1] + CHAMFER_B);
            }
            d[i] = v;
        }
    }
    return d;
}

// Crown half-widths (world px) of the tree sheets (FoliageRenderer's sprite
// keys); the ground under a crown is the iso ellipse of that radius, which is
// a circle of radius/2 in 2×1 texels.
const CROWN_RADIUS = Object.freeze({ 'oak.large': 26, 'oak.small': 9, 'pine.large': 13, 'willow.large': 20, 'willow.small': 12 });
// Leaves and needles fall around the trunk and drift downwind: the prevailing
// knot wind blows toward screen right, so the drop zone sits a fifth of a
// radius that way.
const DROP_DRIFT = 0.2;
const CROWN_REACH = 1.5;

// Per texel: distance to the nearest crown's drop zone in crown radii (9 when
// none within CROWN_REACH) and that tree's index.
function buildCrownField(r, { cols, rows, x0, y0 }) {
    const trees = r.scenery?.getTreeProps?.() || [];
    const dist = new Float32Array(cols * rows).fill(9);
    const owner = new Int16Array(cols * rows).fill(-1);
    trees.forEach((tree, index) => {
        const species = tree.species === 'pine' || tree.species === 'willow' ? tree.species : 'oak';
        const size = tree.size === 'small' && species !== 'pine' ? 'small' : 'large';
        const radius = CROWN_RADIUS[`${species}.${size}`] / 2;
        const cc = ((tree.tileX - tree.tileY) * HALF_W - x0) / TEXEL_W + DROP_DRIFT * radius;
        const rc = (tree.tileX + tree.tileY) * HALF_H - y0;
        const reach = radius * CROWN_REACH;
        const c0 = Math.max(0, Math.floor(cc - reach));
        const c1 = Math.min(cols - 1, Math.ceil(cc + reach));
        const r0 = Math.max(0, Math.floor(rc - reach));
        const r1 = Math.min(rows - 1, Math.ceil(rc + reach));
        for (let row = r0; row <= r1; row++) {
            for (let col = c0; col <= c1; col++) {
                const d = Math.hypot(col + 0.5 - cc, row + 0.5 - rc) / radius;
                const i = row * cols + col;
                if (d < dist[i]) { dist[i] = d; owner[i] = index; }
            }
        }
    });
    return { trees, dist, owner };
}

// Litter colours (leafAutumn stops) by the crown above: russet oaks drop
// russet, ochre oaks gold, turning oaks a mix, willows straw gold.
const LITTER = Object.freeze({
    russet: [LEAF[0], LEAF[1], LEAF[2]],
    ochre: [LEAF[3], LEAF[4], LEAF[1]],
    turning: [LEAF[1], LEAF[3], LEAF[4], LEAF[2]],
    willow: [LEAF[3], LEAF[4]],
    mould: [DIRT[0], LEAF[0]],
});
const NEEDLES = [TIMBER[2], DIRT[1], DIRT[0]];
// The verge (plan 5.4): tufts rooted 2–6 texels from a path, blades 1–3
// texels above the root row.
const VERGE_NEAR = 2 * CHAMFER_A;
const VERGE_FAR = 6 * CHAMFER_A;
const MEADOW_OPEN = 12 * CHAMFER_A;
// Spring's fresh flush: new growth one C1 grass step toward the sunlit
// foliage ramp's yellow-green (the same drift recipe as GRASS_DRY).
const SUN = ramp('foliageSun');
const GRASS_FRESH = GRASS.map((c, i) => mixRgb(c, SUN[Math.min(SUN.length - 1, i + 3)], 0.3));

// Verge colours per season: blade stem and tip, and the seed tufts' heads
// [lower, upper] (none in spring; brown dead heads, rarer, in winter).
const VERGE_STYLE = Object.freeze({
    spring: { stem: GRASS[3], tip: GRASS_FRESH[4], head: null, seeds: 0 },
    summer: { stem: GRASS[3], tip: GRASS[4], head: [SAND[1], SAND[3]], seeds: 0.6 },
    autumn: { stem: GRASS_DRY[2], tip: GRASS_DRY[4], head: [DIRT[2], DIRT[4]], seeds: 0.6 },
    winter: { stem: GRASS_DRY[1], tip: GRASS_DRY[3], head: [DIRT[1], DIRT[3]], seeds: 0.3 },
});
// Seed tufts as [column offset, blade height, head texels] from the root
// texel: two or three blades from one root; the tallest carries a two-texel
// head and one neighbour a single head touching it, so seeds read as one
// small cluster per tuft instead of single flecks.
const SEED_TUFTS = Object.freeze([
    [[-1, 2, 0], [0, 3, 2], [1, 2, 1]],
    [[-1, 2, 1], [0, 3, 2], [1, 1, 0]],
    [[0, 3, 2], [1, 2, 1]],
    [[-1, 1, 0], [0, 2, 1], [1, 3, 2]],
]);

// True when (col, row) is the one hashed candidate texel of its w×h cell:
// clustered marks (tufts, leaf clumps, petals) sit on a jittered grid, so they
// never pile up into noise or leave long gaps.
function cellCandidate(col, row, w, h, salt) {
    const cx = Math.floor(col / w);
    const cy = Math.floor(row / h);
    return col === cx * w + Math.floor(hash2(cx, cy, salt) * w)
        && row === cy * h + Math.floor(hash2(cx, cy, salt + 1) * h);
}

function litterFor(tree, season) {
    if (season === 'winter') return LITTER.mould;
    if (tree.species === 'willow') return LITTER.willow;
    return tree.variant === 1 ? LITTER.russet : tree.variant === 2 ? LITTER.ochre : LITTER.turning;
}

// Fallen leaves and petals lie in small clumps of two to four texels, one
// colour per clump with a darker underside texel.
const CLUMPS = Object.freeze([
    [[0, 0], [1, 0]],
    [[0, 0], [1, 0], [0, -1]],
    [[0, 0], [1, 0], [1, 1]],
    [[-1, 0], [0, 0], [0, -1], [1, 0]],
]);

function drawLivingGround(r, { cols, rows, x0, y0, surfaces, aoBuf, stepBuf, put, season }) {
    const edge = chamferToPaths(cols, rows, surfaces);
    const crowns = buildCrownField(r, { cols, rows, x0, y0 });
    const winter = season === 'winter';
    const autumn = season === 'autumn';
    const spring = season === 'spring';
    const style = VERGE_STYLE[season] || VERGE_STYLE.summer;

    // A blade rising `tall` texels (base included); a tall blade throws its
    // root shadow one texel down-light (screen right).
    const blade = (col, row, tall, stem, tip) => {
        put(col, row, GRASS[0]);
        if (tall > 2) put(col + 1, row, GRASS[0]);
        for (let k = 1; k < tall; k++) put(col, row - k, k === tall - 1 ? tip : stem);
    };
    // A seed tuft rooted at (col, row): its blades and their heads.
    const seedTuft = (col, row, pick) => {
        for (const [dx, h, head] of SEED_TUFTS[Math.floor(pick * SEED_TUFTS.length)]) {
            blade(col + dx, row, h + 1, style.stem, head ? style.stem : style.tip);
            if (head) put(col + dx, row - h - 1, style.head[0]);
            if (head > 1) put(col + dx, row - h - 2, style.head[1]);
        }
    };
    // A clump of fallen leaves or petals.
    const clump = (col, row, pick, c, under) => {
        const shape = CLUMPS[Math.floor(pick * CLUMPS.length)];
        shape.forEach(([dx, dy], k) => put(col + dx, row + dy, k === 0 && under ? under : c));
    };

    for (let row = 4; row < rows - 1; row++) {
        const sy = y0 + row + 0.5;
        for (let col = 1; col < cols - 1; col++) {
            const i = row * cols + col;
            if (surfaces[i] !== S_GRASS) continue;
            const sx = x0 + col * TEXEL_W + 1;
            const e = edge[i];
            const h = hash2(col, row, 1201);
            const pick = hash2(col, row, 1202);
            const cd = crowns.dist[i];
            const tree = cd < CROWN_REACH ? crowns.trees[crowns.owner[i]] : null;
            const ao = aoBuf[i];

            // Seasonal patches away from the crowns: autumn dry grass, a
            // sparser dormant set in winter, spring's fresh flush.
            if (cd > 1.2 && season !== 'summer') {
                const tx = sx / TILE_WIDTH + sy / TILE_HEIGHT;
                const ty = sy / TILE_HEIGHT - sx / TILE_WIDTH;
                const n = vnoise(tx / 2.6, ty / 2.6, spring ? 1310 : 1311) + BAYER[(row & 1) * 2 + (col & 1)] * 0.3;
                if (n > (autumn ? 0.7 : spring ? 0.66 : 0.8)) put(col, row, (spring ? GRASS_FRESH : GRASS_DRY)[stepBuf[i]]);
            }

            // The unmown verge along every path: blades densest at the path's
            // edge and thinning inward in longer and shorter stretches, each
            // a lit stroke over a dark root texel; seed heads only in seed
            // tufts, on a jittered 6×4 grid inside patches of the band. Under
            // a crown the verge keeps its blades in shade colours. A grass
            // sliver too narrow to reach the band carries blades along its
            // ridge (its texels farthest from paving).
            const inBand = e >= VERGE_NEAR && e <= VERGE_FAR;
            const ridge = !inBand && e >= CHAMFER_A && e < VERGE_NEAR
                && edge[i - 1] <= e && edge[i + 1] <= e && edge[i - cols] <= e && edge[i + cols] <= e;
            if (inBand || ridge) {
                const band = vnoise(sx / 60, sy / 30, 1206);
                const inward = ridge ? 0 : (e - VERGE_NEAR) / (VERGE_FAR - VERGE_NEAR);
                const shaded = Boolean(tree) && cd < 1;
                if (style.head && !shaded && cellCandidate(col, row, 6, 4, 1213)
                    && vnoise(sx / 40, sy / 20, 1218) > 0.45
                    && hash2(col, row, 1207) < style.seeds * (1 - inward * 0.5)) {
                    seedTuft(col, row, pick);
                    continue;
                }
                if (h < (ridge ? 0.35 : (0.12 + band * 0.18) * (1 - inward * 0.5))) {
                    const tall = 2 + Math.floor(pick * 3);
                    if (shaded) blade(col, row, tall, GRASS[2], GRASS[3]);
                    else blade(col, row, tall, style.stem, style.tip);
                    continue;
                }
            }

            if (tree && cd < 1) {
                // Under a crown: litter by season, then needles, twigs, moss.
                const near = 1 - cd;
                const drift = 0.6 + 0.8 * vnoise(sx / 14, sy / 7, 1203);
                if (tree.species === 'pine') {
                    if (h < (near + 0.1) * 0.32 * drift) {
                        put(col, row, NEEDLES[Math.floor(pick * NEEDLES.length)]);
                        if (pick > 0.6) put(col + 1, row, NEEDLES[0]);
                    }
                    continue;
                }
                if ((autumn || winter) && cellCandidate(col, row, 3, 2, 1214)) {
                    if (h < near ** 1.2 * (autumn ? 1.1 : 0.3) * drift) {
                        const litter = litterFor(tree, season);
                        const k = Math.floor(pick * litter.length);
                        clump(col, row, hash2(col, row, 1215), litter[k], litter[Math.max(0, k - 1)]);
                    }
                    continue;
                }
                if (spring && tree.species === 'oak' && tree.variant === 2 && cellCandidate(col, row, 3, 2, 1216)) {
                    if (h < near * 0.85 * drift) clump(col, row, hash2(col, row, 1215), BLOSSOM[3], BLOSSOM[2]);
                    continue;
                }
                const q = hash2(col, row, 1205);
                if (q < 0.01) {
                    put(col, row, TIMBER[1]);
                    put(col + 1, row + (pick > 0.5 ? 1 : -1), TIMBER[2]);
                } else if (q < 0.03) {
                    put(col, row, FOLIAGE[2]);
                    put(col + 1, row, FOLIAGE[3]);
                }
                continue;
            }
            if (tree && autumn && tree.species !== 'pine' && cellCandidate(col, row, 3, 2, 1214)
                && h < (CROWN_REACH - cd) * 0.25) {
                // A few leaves blown past the drop zone.
                const litter = litterFor(tree, season);
                put(col, row, litter[Math.floor(pick * 2)]);
                put(col + 1, row, litter[Math.floor(pick * 2)]);
                continue;
            }

            if (ao > 20 && ao < 110) {
                // Weeds at wall and prop bases, in clumps; in winter a dead
                // stalk pair, never a lone brown fleck.
                if (h < (vnoise(sx / 40, sy / 20, 1212) > 0.45 ? 0.06 : 0.012)) {
                    put(col, row, FOLIAGE[1]);
                    put(col, row - 1, winter ? DIRT[2] : FOLIAGE[2]);
                    if (pick > 0.5 || winter) put(col + 1, row - 1, winter ? DIRT[3] : FOLIAGE[3]);
                }
            } else if (e > MEADOW_OPEN && ao === 0 && !tree && !winter) {
                // Rare meadow pockets: daisies (seed tufts in autumn) where a
                // low-frequency mask opens, clover drifts where it closes.
                // Spring opens more pockets.
                const pocket = vnoise(sx / 110, sy / 55, 1208);
                const open = spring ? 0.58 : 0.66;
                if (pocket > open && h < (pocket - open) * 0.2) {
                    put(col, row, GRASS[1]);
                    put(col, row - 1, autumn ? DIRT[4] : pick > 0.85 ? OCHRE[1] : SAND[4]);
                } else if (pocket < 0.22 && h < 0.012) {
                    put(col, row, GRASS[2]);
                    put(col + 1, row, GRASS[3]);
                    put(col, row - 1, GRASS[3]);
                }
            }
        }
    }
}

// ---- decals ---------------------------------------------------------------

const BLOOMS = {
    summer: [hexRgb('#d8cf9c'), OCHRE[1], hexRgb('#b56a8a'), hexRgb('#8a74b8')],
    spring: [hexRgb('#e3d7c4'), hexRgb('#c98aa3'), hexRgb('#d8cf9c'), hexRgb('#a893c9')],
    autumn: [OCHRE[0], hexRgb('#a4563a'), OCHRE[1], DIRT[3]],
    winter: [],
};

function drawDecals(r, ctx) {
    const { cols, rows, x0, y0, surfaces, sdBuf, aoBuf, put, season } = ctx;
    const texelAt = (tx, ty) => {
        const sx = (tx - ty) * HALF_W;
        const sy = (tx + ty) * HALF_H;
        const col = Math.floor((sx - x0) / TEXEL_W);
        const row = Math.floor(sy - y0);
        if (col < 1 || row < 4 || col >= cols - 1 || row >= rows - 1) return -1;
        return row * cols + col;
    };
    const onGrass = (i) => i >= 0 && surfaces[i] === S_GRASS && aoBuf[i] < 110;
    const list = [];
    const cluster = (key, salt, count, radius, fn) => {
        const comma = key.indexOf(',');
        const tileX = Number(key.slice(0, comma));
        const tileY = Number(key.slice(comma + 1));
        const cx = tileX + (hash2(tileX, tileY, salt) - 0.5) * 0.5;
        const cy = tileY + (hash2(tileX, tileY, salt + 1) - 0.5) * 0.5;
        for (let n = 0; n < count; n++) {
            const a = hash2(tileX, tileY, salt + 10 + n) * Math.PI * 2;
            const d = Math.sqrt(hash2(tileX, tileY, salt + 40 + n)) * radius;
            const tx = cx + Math.cos(a) * d;
            const ty = cy + Math.sin(a) * d;
            const i = texelAt(tx, ty);
            if (i < 0) continue;
            list.push({ i, row: Math.floor(i / cols), draw: fn, pick: hash2(tileX, tileY, salt + 70 + n), group: hash2(tileX, tileY, salt + 99) });
        }
    };

    // Meadow pockets: flower tiles and the flower feature bed become one
    // cluster of a single bloom colour each; thinned to about half.
    const blooms = BLOOMS[season] || BLOOMS.summer;
    if (blooms.length) {
        const flower = (d) => {
            if (!onGrass(d.i)) return;
            const col = d.i % cols;
            const color = blooms[Math.floor(d.group * blooms.length)];
            put(col, d.row, GRASS[0]);
            put(col, d.row - 1, color);
        };
        const flowerKeys = new Set([...(r.flowerTiles?.keys?.() || [])]);
        for (const [key, feature] of r.featureTiles || []) if (feature === 'flowers') flowerKeys.add(key);
        for (const key of flowerKeys) {
            const [x, y] = key.split(',').map(Number);
            if (hash2(x, y, 7) > (season === 'spring' ? 0.7 : 0.5)) continue;
            cluster(key, 100, 7, 0.34, flower);
        }
    }

    // Grass tufts: short blades rising 2 texels, lit on top.
    const tuft = (d) => {
        if (!onGrass(d.i)) return;
        const col = d.i % cols;
        put(col, d.row, GRASS[1]);
        put(col, d.row - 1, season === 'winter' ? SAND[2] : GRASS[3]);
        if (d.pick > 0.5) put(col, d.row - 2, GRASS[4]);
    };
    for (const key of r.grassTuftTiles?.keys?.() || []) {
        const [x, y] = key.split(',').map(Number);
        if (hash2(x, y, 8) > 0.55) continue;
        cluster(key, 200, 5, 0.32, tuft);
    }

    // Low shrubs replace the cube-based bush sprites: a small sage mound
    // with a shadow row, drawn on grass only.
    const shrub = (d) => {
        if (!onGrass(d.i)) return;
        const col = d.i % cols;
        const row = d.row;
        for (let c = -2; c <= 2; c++) put(col + c, row + 1, GRASS[0]);
        for (let c = -2; c <= 2; c++) put(col + c, row, FOLIAGE[1]);
        for (let c = -2; c <= 1; c++) put(col + c, row - 1, c < 0 ? FOLIAGE[3] : FOLIAGE[2]);
        for (let c = -1; c <= 0; c++) put(col + c, row - 2, FOLIAGE[3]);
        put(col - 1, row - 3, FOLIAGE[4]);
    };
    for (const key of r.bushTiles?.keys?.() || []) {
        const [x, y] = key.split(',').map(Number);
        if (hash2(x, y, 9) > 0.5) continue;
        cluster(key, 300, 1, 0.12, shrub);
    }

    // Bank reeds: vertical stalks on the dry side of the waterline.
    const reed = (d) => {
        const sd = sdBuf[d.i];
        if (!(sd > -0.55 && sd < -0.24) || surfaces[d.i] === 255) return;
        const col = d.i % cols;
        const height = 3 + Math.floor(d.pick * 3);
        put(col, d.row, FOLIAGE[1]);
        for (let k = 1; k < height; k++) put(col, d.row - k, k === height - 1 ? FOLIAGE[3] : FOLIAGE[2]);
        if (d.pick > 0.6 && season !== 'winter') put(col, d.row - height, OCHRE[0]);
    };
    // Pebbles and field stones: lit top, shadow below.
    const pebble = (d) => {
        const s = surfaces[d.i];
        if (s === 255 || s === S_PLAZA || s === S_FLAG) return;
        const col = d.i % cols;
        put(col, d.row, ROAD[1]);
        put(col, d.row - 1, ROAD[d.pick > 0.5 ? 4 : 3]);
        if (d.pick > 0.7) put(col + 1, d.row, ROAD[2]);
    };
    const mushroom = (d) => {
        if (!onGrass(d.i)) return;
        const col = d.i % cols;
        put(col, d.row, SAND[4]);
        put(col, d.row - 1, d.pick > 0.5 ? hexRgb('#a4563a') : SAND[3]);
    };
    for (const [key, feature] of r.featureTiles || []) {
        if (feature === 'reeds') cluster(key, 400, 6, 0.45, reed);
        else if (feature === 'stones') cluster(key, 500, 4, 0.28, pebble);
        else if (feature === 'mushrooms') cluster(key, 600, 3, 0.22, mushroom);
    }

    // Road-shoulder pebbles: only where a low-frequency mask allows, so they
    // gather in a few stretches rather than peppering every verge.
    for (let row = 4; row < rows - 1; row += 3) {
        for (let col = 1; col < cols - 1; col++) {
            const i = row * cols + col;
            if (surfaces[i] !== S_DIRT) continue;
            if (surfaces[i + 1] !== S_GRASS && surfaces[i - 1] !== S_GRASS) continue;
            const h = hash2(col, row, 77);
            if (h > 0.06) continue;
            const sx = x0 + col * TEXEL_W;
            const sy = y0 + row;
            if (vnoise(sx / 180, sy / 90, 78) < 0.55) continue;
            list.push({ i, row, draw: pebble, pick: h * 16, group: 0 });
        }
    }

    // Meadow pockets: sparse tufts gathered where a low-frequency mask opens,
    // so open grass carries a few lived-in drifts, not an even sprinkle.
    for (let row = 4; row < rows - 1; row += 2) {
        for (let col = 1; col < cols - 1; col++) {
            const i = row * cols + col;
            if (surfaces[i] !== S_GRASS || aoBuf[i] > 40) continue;
            const h = hash2(col, row, 91);
            if (h > 0.03) continue;
            const sx = x0 + col * TEXEL_W;
            const sy = y0 + row;
            const pocket = vnoise(sx / 150, sy / 75, 92);
            if (h > (pocket > 0.62 ? 0.03 : 0.004)) continue;
            list.push({ i, row, draw: tuft, pick: h * 33, group: 0 });
        }
    }

    // Painter order: tall decals further down the screen draw last.
    list.sort((a, b) => a.row - b.row);
    for (const d of list) d.draw(d);
}

// ---- install --------------------------------------------------------------

// Registers the bake on the renderer. The pass revision (read every frame
// as part of the terrain-cache key) only tracks the land sheets loading and
// settles to a constant string once they have; season, scenery and the coast
// field already key the terrain cache through their own entries. The cached
// image is re-keyed on all of them at bake time only.
const SHEET_IDS = [...new Set(Object.values(TEXTURE_SOURCES).flat().map(([id]) => id))];

export function installGroundBake(renderer) {
    let cached = null;
    let sheetsReady = false;
    const sheetsKey = () => {
        if (sheetsReady) return 'sheets';
        const assets = renderer.assets;
        let loaded = 0;
        for (const id of SHEET_IDS) if (assets?.get?.(id, { request: false })) loaded++;
        sheetsReady = loaded === SHEET_IDS.length;
        return sheetsReady ? 'sheets' : `sheets:${loaded}`;
    };
    return renderer.registerTerrainBakePass({
        id: 'ground-splat',
        stage: 'ground',
        revision: sheetsKey,
        draw(ctx) {
            const key = `${getCoastField(renderer).key}|${sheetsKey()}|${renderer._terrainSeason || 'summer'}|${renderer._terrainSceneryRevision || 0}`;
            if (!cached || cached.key !== key) {
                const baked = bakeGround(renderer);
                cached = { key, ...baked };
                renderer.groundField = baked.field;
                renderer.groundBakeMs = Math.round(baked.ms);
            }
            ctx.drawImage(cached.canvas, cached.x0, cached.y0);
        },
    });
}

// ---- GPU material sidecar -------------------------------------------------

// Repaints the land classes of the quarter-res terrain material map from the
// ground class buffer, so GPU material response (wet sheen on paving, earth
// on paths) follows the baked organic edges instead of tile diamonds. Writes
// only land texels, through a transparent layer (no read-back): pixels the
// buffer calls water keep their class for the coast pass, and timber decks
// over water keep theirs. Bake-time only.
export function paintGroundMaterial(ctx, renderer, cached, scale, idForClass) {
    const field = renderer.groundField;
    if (!field || !cached?.bounds || typeof document === 'undefined') return;
    const step = 1 / scale;
    const x0 = Math.max(0, Math.floor((field.bounds.x - cached.bounds.x) * scale));
    const y0 = Math.max(0, Math.floor((field.bounds.y - cached.bounds.y) * scale));
    const x1 = Math.min(ctx.canvas.width, Math.ceil((field.bounds.x + field.bounds.w - cached.bounds.x) * scale));
    const y1 = Math.min(ctx.canvas.height, Math.ceil((field.bounds.y + field.bounds.h - cached.bounds.y) * scale));
    if (x1 <= x0 || y1 <= y0) return;
    const w = x1 - x0;
    const h = y1 - y0;
    const image = new ImageData(w, h);
    const data = image.data;
    for (let py = 0; py < h; py++) {
        const wy = cached.bounds.y + (y0 + py + 0.5) * step;
        for (let px = 0; px < w; px++) {
            const id = idForClass[field.classAt(cached.bounds.x + (x0 + px + 0.5) * step, wy)];
            if (id === undefined) continue;
            const o = (py * w + px) * 4;
            data[o] = id;
            data[o + 3] = 255;
        }
    }
    const layer = document.createElement('canvas');
    layer.width = w;
    layer.height = h;
    layer.getContext('2d').putImageData(image, 0, 0);
    ctx.drawImage(layer, x0, y0);
}
