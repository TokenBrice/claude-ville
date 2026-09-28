// 3.4 / 3.5 / 3.7 — the continuous coast field, the baked water ramp, the
// land-only stratified cliff, the cached outer ocean and the baked landmark
// reflections (agents/plans/claudeville-opus55-aesthetic-plan.md, Wave 3).
//
// Water used to be stamped per tile: two flat tones met at hard 64x32 diamond
// steps, outlined by contour strokes, and the map edge fenced the east sea in
// a teal rim plus a sand-and-cliff slab. Here the coastline comes from one
// sub-tile field instead:
//
//   visual water tiles (8 samples/tile, the map edge is open sea for sea and
//   harbor) -> two box blurs (~0.5 tile) + low-frequency value noise ->
//   threshold 0.5 -> chamfer distance to that contour = `signedDistance`
//   (tiles; > 0 water, < 0 land).
//
// The terrain bake classifies every 2x2 world-px lattice cell near water from
// that distance: wet sand -> dithered foam lace -> five quantized depth stops
// on the C1 water ramps (4x4 Bayer at each boundary), with sparse 2:1 ripple
// dashes. Walkability is untouched: the field is purely visual.
//
// Time of day never enters the terrain cache (0.3). Night and storm water
// change through `waterMoodFor()`: the resident scene shader applies it to
// water-material fragments, the Canvas and hybrid PostFx paths draw a
// recoloured copy of the baked water (the mood, then V6's water saturation
// cap in front of their frame grade; rebuilt per mood bucket and grade
// key), and the cached outer ocean bakes both into its palette.

import { MAP_SIZE, TILE_HEIGHT, TILE_WIDTH } from '../../config/constants.js';
import { ART_RAMPS } from '../../config/artPalette.js';
import { WATER_POLYLINES } from '../../config/scenery.js';
import * as CanvasGrade from './CanvasGrade.js';
import { emissiveSidecarFor } from './EmitterCuts.js';

const HALF_W = TILE_WIDTH / 2;
const HALF_H = TILE_HEIGHT / 2;

// Field resolution and the out-of-map margin it models (tiles).
const SUB = 8;
const PAD = 6;
const GRID = (MAP_SIZE + PAD * 2) * SUB;
const BLUR_RADIUS = 4;
const NOISE_PERIOD = 3;
const NOISE_AMPLITUDE = 0.10;

// Water classification bands, in tiles of signed distance.
const WET_SAND_EDGE = -0.05;
const WET_SAND_BAND = -0.18;
const WET_SAND_DITHER = -0.27;
const FOAM_BAND = 0.09;
const FOAM_SPARSE_BAND = 0.16;
// Stop k + 1 starts at DEPTH_BOUNDS[k]. The sea's deepest stop (5) is the
// open sea's body: in-map sea reaches it three tiles from land, the outer
// shelf deepens into it past the map edge (3.3), so the map diamond never
// shows as a lighter plate in the sea.
const DEPTH_BOUNDS = Object.freeze([0.30, 0.78, 1.38, 2.15, 2.9]);
// Half-width (tiles of signed distance) of the ordered seam where one depth
// stop hands to the next: ~one world texel either side, so every stop is a
// solid band and only its edge dithers (a wider band read as a full-field
// checker once every texel took its own Bayer decision).
const DEPTH_DITHER_HALF = 0.03;
const RIPPLE_SEED_DENSITY = 0.011;
// How far (tiles) the shelf may continue past the map edges into the ocean;
// its deepening (see `outerShelfSd`) reaches the deepest stop before this.
// The open sea (GpuWorldRenderer) bends its stop seams only past it.
export const OUTER_SHELF_TILES = 4;
// Far-edge land (NW/NE, whose cliff faces away from the camera) is treated as
// shore this far inland (tiles of signed distance), with a value-noise wobble,
// so it ends in wet sand and foam lace on the outer ocean.
const BACK_SHORE_SD = 0.3;
const BACK_SHORE_WOBBLE = 0.1;
// Value-noise wobble (tiles of signed distance) on the outer shelf contours.
const SHELF_WOBBLE = 0.4;
// 3.5 — under the SW/SE cliffs the shelf starts at the cliff's foot on stop
// 2, a shallow apron the boulders stand in.
const SHELF_CLIFF_SD = 1.0;
// Shelf deepening per tile past the edge: gentle across the first 1.5
// tiles (the shallow stops keep their width), steeper beyond.
const SHELF_NEAR_TILES = 1.5;
const SHELF_NEAR_RATE = 0.8;
const SHELF_FAR_RATE = 1.6;
// A second, low-frequency wobble (period ~8.6 tiles) past the first tile and
// a half, so the stop 3-4-5 contours meander instead of running as straight
// 2:1 lines parallel to the map edge.
const SHELF_FAR_WOBBLE = 0.7;
// 3.3 — the outer shelf continues the in-map sea's own field (stops 2-4)
// into the open sea's body (stop 5). Where the sea already reaches stop 5 at
// the edge, the field is held deep enough that no wobble can lift a texel
// back to stop 4 (a dotted line along the map edge otherwise).
const SHELF_SEA_EDGE_SD = DEPTH_BOUNDS[4] + DEPTH_DITHER_HALF + SHELF_WOBBLE + SHELF_FAR_WOBBLE;
// How far past its last contour (tiles of signed distance) the shelf keeps
// painting the deepest stop before it leaves texels clear for the open sea.
const SHELF_HANDOVER_SD = 0.35;
// Stop cap of outer-shelf cells: the deepest open-sea stop.
const OUTER_CAP = DEPTH_BOUNDS.length;
// Grade night weight below which water keeps its day mood (see waterMoodFor).
const WATER_NIGHT_FLOOR = 0.15;

// Cliff (3.5) face height in world px (varied +-CLIFF_FACE_WOBBLE).
const CLIFF_FACE = 34;
// 3.5 — the cliff face's reflection alpha courses by distance from its foot.
const REFLECTION_ALPHAS = Object.freeze([0.42, 0.28, 0.16]);

function hexRgb(hex) {
    const value = parseInt(String(hex).slice(1), 16);
    return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

function mixRgb(a, b, t) {
    return [
        Math.round(a[0] + (b[0] - a[0]) * t),
        Math.round(a[1] + (b[1] - a[1]) * t),
        Math.round(a[2] + (b[2] - a[2]) * t),
    ];
}

const SHALLOW = ART_RAMPS.shallowWater.map(hexRgb);
const DEEP = ART_RAMPS.deepWater.map(hexRgb);
const SAND = ART_RAMPS.sand.map(hexRgb);
const DIRT = ART_RAMPS.dirt.map(hexRgb);
const TIMBER = ART_RAMPS.timber.map(hexRgb);

// The depth stops, shallow -> deep, all on the C1 water ramps (S <= 0.40).
// Rivers stop at 2, lagoons at 3; the sea runs to 5, the open sea's body.
export const COAST_WATER_STOPS = Object.freeze([
    SHALLOW[1],
    mixRgb(SHALLOW[0], SHALLOW[1], 0.45),
    SHALLOW[0],
    DEEP[2],
    mixRgb(DEEP[1], DEEP[2], 0.45),
    DEEP[1],
].map(Object.freeze));
// The open sea's stops (COMPOSITE_FRAGMENT and the Canvas `drawOuterOcean`).
export const OPEN_SEA_STOPS = COAST_WATER_STOPS;
// 3.3 (a) — one stop below the deepest, on the same C1 deep ramp at the same
// step: a swell's trough and the far sea's deeper course (`seaBodyStop`).
// Shaded only, never baked, so no exact-match cycle ever reads it.
export const SEA_TROUGH = Object.freeze(mixRgb(DEEP[1], DEEP[0], 0.45));
const FOAM = Object.freeze(SHALLOW[2]);
const FOAM_CREST = Object.freeze(mixRgb(SHALLOW[2], [226, 232, 220], 0.45));
const WET_SAND = Object.freeze(mixRgb(SAND[1], SHALLOW[0], 0.34));
const WET_SAND_DARK = Object.freeze(mixRgb(SAND[0], DEEP[2], 0.5));

// 3.10 — seabed specks (2x1, stops 0-1) and the caustic half step, authored
// once so every water texel stays a named CoastBake colour.
const SEABED_SPECKS = Object.freeze([
    Object.freeze(mixRgb(COAST_WATER_STOPS[0], SAND[0], 0.3)),
    Object.freeze(mixRgb(COAST_WATER_STOPS[1], SAND[0], 0.3)),
]);
const CAUSTICS = Object.freeze([
    Object.freeze(mixRgb(COAST_WATER_STOPS[0], FOAM, 0.5)),
    Object.freeze(mixRgb(COAST_WATER_STOPS[1], COAST_WATER_STOPS[0], 0.5)),
]);

/**
 * Every colour the resident water shader may compare against or write, in
 * 0-255 sRGB. A texel cycles only when its ungraded albedo matches one of
 * these exactly (3.1, 3.6, 3.9, 3.10), and a lit texel only ever takes
 * another entry, so the water stays on the C1 / CoastBake palette.
 */
export const COAST_PALETTE = Object.freeze({
    stops: COAST_WATER_STOPS,
    foam: FOAM,
    foamCrest: FOAM_CREST,
    wetSand: WET_SAND,
    wetSandDark: WET_SAND_DARK,
    seabedSpecks: SEABED_SPECKS,
    caustics: CAUSTICS,
    trough: SEA_TROUGH,
});

// Cliff strata (3.5): root shadow under the turf, warm sandstone blocks with
// a one-pixel highlight course, partial dark fractures with the next block's
// left edge lit by the upper-left key and one darker bedding course per
// block, a darker lower stratum with its own fractures and water stains, and
// a wet foot. The SW face takes the key; the SE face sits one step darker.
const CLIFF_STRATA = Object.freeze({
    sw: Object.freeze({
        root: TIMBER[0], highlight: SAND[3], upper: SAND[0], lit: SAND[2], joint: DIRT[0], bed: DIRT[2],
        speck: DIRT[2], seam: TIMBER[1], lower: DIRT[1], lowLit: DIRT[3], lowJoint: TIMBER[1], stain: TIMBER[2],
        foot: TIMBER[2], wet: TIMBER[0],
    }),
    se: Object.freeze({
        root: TIMBER[0], highlight: SAND[0], upper: DIRT[3], lit: DIRT[4], joint: DIRT[0], bed: DIRT[1],
        speck: DIRT[1], seam: TIMBER[0], lower: DIRT[0], lowLit: DIRT[1], lowJoint: TIMBER[1], stain: TIMBER[1],
        foot: TIMBER[1], wet: TIMBER[0],
    }),
});

const BAYER4 = Object.freeze([
    0 / 16, 8 / 16, 2 / 16, 10 / 16,
    12 / 16, 4 / 16, 14 / 16, 6 / 16,
    3 / 16, 11 / 16, 1 / 16, 9 / 16,
    15 / 16, 7 / 16, 13 / 16, 5 / 16,
]);

function bayer(i, j) {
    return BAYER4[((j & 3) << 2) | (i & 3)];
}

function hash2(i, j, salt = 0) {
    let h = Math.imul(i | 0, 0x27d4eb2d) ^ Math.imul(j | 0, 0x165667b1) ^ Math.imul(salt | 0, 0x9e3779b1);
    h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function smooth01(t) {
    return t * t * (3 - 2 * t);
}

function valueNoise(u, v) {
    const x = u / NOISE_PERIOD;
    const y = v / NOISE_PERIOD;
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const fx = smooth01(x - x0);
    const fy = smooth01(y - y0);
    const a = hash2(x0, y0, 7);
    const b = hash2(x0 + 1, y0, 7);
    const c = hash2(x0, y0 + 1, 7);
    const d = hash2(x0 + 1, y0 + 1, 7);
    return (a + (b - a) * fx) * (1 - fy) + (c + (d - c) * fx) * fy;
}

const SEA_REGIONS = new Set(['sea', 'openSea', 'harbor']);

function isVisualWater(renderer, key) {
    return renderer.waterTiles?.has(key) || renderer.harborWaterApronTiles?.has(key);
}

function regionAt(renderer, key) {
    if (renderer.harborWaterApronTiles?.has(key) && !renderer.waterTiles?.has(key)) return 'harbor';
    const meta = renderer.waterMeta?.get?.(key);
    if (meta?.region) return meta.region;
    if (renderer.lagoonWaterTiles?.has(key)) return 'lagoon';
    return 'sea';
}

// Deepest stop a water body may reach: rivers stay light, lagoons stop two
// short of the open sea, the sea and the Harbor reach the open sea's body.
function depthCapFor(region) {
    if (region === 'river') return 2;
    if (region === 'lagoon') return 3;
    return DEPTH_BOUNDS.length;
}

function buildingFootprintKeys(renderer) {
    const keys = new Set();
    for (const building of renderer.world?.buildings?.values?.() || []) {
        const x0 = building.position?.tileX;
        const y0 = building.position?.tileY;
        if (!Number.isFinite(x0) || !Number.isFinite(y0)) continue;
        for (let y = y0; y < y0 + (building.height || 1); y++) {
            for (let x = x0; x < x0 + (building.width || 1); x++) keys.add(`${x},${y}`);
        }
    }
    return keys;
}

// Water may grow only into shore tiles that carry nothing: no road, plaza,
// building footprint or bridge. It may always shrink (convex corners become
// sand), which never hides anything semantic.
function growableLand(renderer, key, footprints) {
    if (!renderer.shoreTiles?.has(key)) return false;
    if (footprints.has(key)) return false;
    return !(renderer.pathTiles?.has(key)
        || renderer.townSquareTiles?.has(key)
        || renderer.mainAvenueTiles?.has(key)
        || renderer.commandCenterRoadTiles?.has(key)
        || renderer.dirtPathTiles?.has(key)
        || renderer.bridgeTiles?.has(key));
}

function boxBlur(src, dst, tmp, radius) {
    const n = GRID;
    const span = radius * 2 + 1;
    for (let y = 0; y < n; y++) {
        const row = y * n;
        let sum = 0;
        for (let k = -radius; k <= radius; k++) sum += src[row + Math.min(n - 1, Math.max(0, k))];
        for (let x = 0; x < n; x++) {
            tmp[row + x] = sum / span;
            const add = Math.min(n - 1, x + radius + 1);
            const sub = Math.max(0, x - radius);
            sum += src[row + add] - src[row + sub];
        }
    }
    for (let x = 0; x < n; x++) {
        let sum = 0;
        for (let k = -radius; k <= radius; k++) sum += tmp[Math.min(n - 1, Math.max(0, k)) * n + x];
        for (let y = 0; y < n; y++) {
            dst[y * n + x] = sum / span;
            const add = Math.min(n - 1, y + radius + 1);
            const sub = Math.max(0, y - radius);
            sum += tmp[add * n + x] - tmp[sub * n + x];
        }
    }
}

function coastFieldKey(renderer) {
    return [
        renderer._terrainSceneryRevision || 0,
        renderer.waterTiles?.size || 0,
        renderer.harborWaterApronTiles?.size || 0,
        renderer.shoreTiles?.size || 0,
        renderer.bridgeTiles?.size || 0,
        renderer.pathTiles?.size || 0,
    ].join(':');
}

function buildCoastField(renderer) {
    const started = performance.now();
    const n = GRID;
    const seed = new Float32Array(n * n);
    const footprints = buildingFootprintKeys(renderer);
    // Per tile (padded grid): 1 water, 0 land; `growMask` marks land that may
    // take water, `tileCap` the deepest stop allowed near that tile.
    const tiles = MAP_SIZE + PAD * 2;
    const tileWater = new Uint8Array(tiles * tiles);
    const tileGrow = new Uint8Array(tiles * tiles);
    for (let ty = -PAD; ty < MAP_SIZE + PAD; ty++) {
        for (let tx = -PAD; tx < MAP_SIZE + PAD; tx++) {
            const inside = tx >= 0 && ty >= 0 && tx < MAP_SIZE && ty < MAP_SIZE;
            const cx = Math.min(MAP_SIZE - 1, Math.max(0, tx));
            const cy = Math.min(MAP_SIZE - 1, Math.max(0, ty));
            const key = `${cx},${cy}`;
            let water = isVisualWater(renderer, key);
            if (water && !inside) water = SEA_REGIONS.has(regionAt(renderer, key));
            const index = (ty + PAD) * tiles + (tx + PAD);
            tileWater[index] = water ? 1 : 0;
            tileGrow[index] = !water && inside && growableLand(renderer, key, footprints) ? 1 : 0;
        }
    }
    for (let gy = 0; gy < n; gy++) {
        const ty = Math.floor(gy / SUB);
        for (let gx = 0; gx < n; gx++) {
            seed[gy * n + gx] = tileWater[ty * tiles + Math.floor(gx / SUB)];
        }
    }
    const blurred = new Float32Array(n * n);
    const tmp = new Float32Array(n * n);
    boxBlur(seed, blurred, tmp, BLUR_RADIUS);
    boxBlur(blurred, seed, tmp, BLUR_RADIUS);
    const value = seed;
    for (let gy = 0; gy < n; gy++) {
        const v = (gy + 0.5) / SUB - PAD - 0.5;
        const ty = Math.floor(gy / SUB);
        for (let gx = 0; gx < n; gx++) {
            const u = (gx + 0.5) / SUB - PAD - 0.5;
            const index = gy * n + gx;
            let f = value[index] + (valueNoise(u, v) - 0.5) * 2 * NOISE_AMPLITUDE;
            const tIndex = ty * tiles + Math.floor(gx / SUB);
            if (!tileWater[tIndex] && !tileGrow[tIndex]) f = Math.min(f, 0.48);
            value[index] = f;
        }
    }
    // Signed distance: seed each sample next to the 0.5 contour with its
    // sub-sample distance to the crossing, then a two-pass chamfer.
    const dist = blurred;
    dist.fill(1e6);
    for (let gy = 0; gy < n; gy++) {
        for (let gx = 0; gx < n; gx++) {
            const index = gy * n + gx;
            const f = value[index] - 0.5;
            let best = 1e6;
            if (gx + 1 < n) {
                const g = value[index + 1] - 0.5;
                if ((f > 0) !== (g > 0)) best = Math.min(best, f / (f - g));
            }
            if (gx > 0) {
                const g = value[index - 1] - 0.5;
                if ((f > 0) !== (g > 0)) best = Math.min(best, f / (f - g));
            }
            if (gy + 1 < n) {
                const g = value[index + n] - 0.5;
                if ((f > 0) !== (g > 0)) best = Math.min(best, f / (f - g));
            }
            if (gy > 0) {
                const g = value[index - n] - 0.5;
                if ((f > 0) !== (g > 0)) best = Math.min(best, f / (f - g));
            }
            dist[index] = best;
        }
    }
    const D = Math.SQRT2;
    for (let gy = 0; gy < n; gy++) {
        for (let gx = 0; gx < n; gx++) {
            const index = gy * n + gx;
            let d = dist[index];
            if (gx > 0) d = Math.min(d, dist[index - 1] + 1);
            if (gy > 0) {
                d = Math.min(d, dist[index - n] + 1);
                if (gx > 0) d = Math.min(d, dist[index - n - 1] + D);
                if (gx + 1 < n) d = Math.min(d, dist[index - n + 1] + D);
            }
            dist[index] = d;
        }
    }
    for (let gy = n - 1; gy >= 0; gy--) {
        for (let gx = n - 1; gx >= 0; gx--) {
            const index = gy * n + gx;
            let d = dist[index];
            if (gx + 1 < n) d = Math.min(d, dist[index + 1] + 1);
            if (gy + 1 < n) {
                d = Math.min(d, dist[index + n] + 1);
                if (gx + 1 < n) d = Math.min(d, dist[index + n + 1] + D);
                if (gx > 0) d = Math.min(d, dist[index + n - 1] + D);
            }
            dist[index] = d;
        }
    }
    const signed = new Float32Array(n * n);
    for (let index = 0; index < signed.length; index++) {
        const d = Math.min(dist[index], 64 * SUB) / SUB;
        signed[index] = value[index] > 0.5 ? d : -d;
    }

    // The deepest stop allowed per in-map tile: the cap of the nearest water
    // body within one tile (land tiles inherit it for their wet margin).
    const caps = new Uint8Array(MAP_SIZE * MAP_SIZE);
    for (let ty = 0; ty < MAP_SIZE; ty++) {
        for (let tx = 0; tx < MAP_SIZE; tx++) {
            let cap = 0;
            for (let dy = -1; dy <= 1; dy++) {
                for (let dx = -1; dx <= 1; dx++) {
                    const x = tx + dx;
                    const y = ty + dy;
                    if (x < 0 || y < 0 || x >= MAP_SIZE || y >= MAP_SIZE) continue;
                    const key = `${x},${y}`;
                    if (!isVisualWater(renderer, key)) continue;
                    cap = Math.max(cap, depthCapFor(regionAt(renderer, key)));
                }
            }
            caps[ty * MAP_SIZE + tx] = cap || depthCapFor('sea');
        }
    }

    const signedDistance = (u, v) => {
        let gx = (u + 0.5 + PAD) * SUB - 0.5;
        let gy = (v + 0.5 + PAD) * SUB - 0.5;
        if (gx < 0) gx = 0; else if (gx > n - 1.001) gx = n - 1.001;
        if (gy < 0) gy = 0; else if (gy > n - 1.001) gy = n - 1.001;
        const x0 = gx | 0;
        const y0 = gy | 0;
        const fx = gx - x0;
        const fy = gy - y0;
        const i = y0 * n + x0;
        const top = signed[i] + (signed[i + 1] - signed[i]) * fx;
        const bottom = signed[i + n] + (signed[i + n + 1] - signed[i + n]) * fx;
        return top + (bottom - top) * fy;
    };

    return {
        key: coastFieldKey(renderer),
        sub: SUB,
        pad: PAD,
        grid: n,
        signed,
        caps,
        buildMs: performance.now() - started,
        signedDistance,
        isWater: (u, v) => signedDistance(u, v) > 0,
        // Iso inverse of the tile projection: world px -> fractional tile.
        signedDistanceAtWorld: (wx, wy) => signedDistance(wy / TILE_HEIGHT + wx / TILE_WIDTH, wy / TILE_HEIGHT - wx / TILE_WIDTH),
        depthCapAt(tx, ty) {
            const x = Math.min(MAP_SIZE - 1, Math.max(0, Math.round(tx)));
            const y = Math.min(MAP_SIZE - 1, Math.max(0, Math.round(ty)));
            return caps[y * MAP_SIZE + x];
        },
    };
}

/**
 * The shared coast field (also consumed by GroundBake for its sand edge).
 * Cached on the renderer; rebuilt only when the water/shore/scenery inputs
 * change. `signedDistance(tx, ty)` is in tiles: > 0 water, < 0 land.
 */
export function getCoastField(renderer) {
    const key = coastFieldKey(renderer);
    if (renderer._coastField?.key === key) return renderer._coastField;
    renderer._coastField = buildCoastField(renderer);
    renderer.coastField = renderer._coastField;
    return renderer._coastField;
}

// ---------------------------------------------------------------------------
// Water classification (3.4)

// Cell classes kept per lattice cell for reflections and the Canvas mood
// layer: 0 untouched, 1 wet sand, 2 foam, 3.. water stop k = class - 3.
const CLASS_NONE = 0;
const CLASS_WET = 1;
const CLASS_FOAM = 2;
const CLASS_WATER = 3;

function depthStop(sd, cap, i, j) {
    let stop = 0;
    const threshold = bayer(i, j);
    for (let k = 0; k < DEPTH_BOUNDS.length && k < cap; k++) {
        const bound = DEPTH_BOUNDS[k];
        if (sd >= bound + DEPTH_DITHER_HALF) {
            stop = k + 1;
            continue;
        }
        if (sd > bound - DEPTH_DITHER_HALF) {
            const p = (sd - (bound - DEPTH_DITHER_HALF)) / (DEPTH_DITHER_HALF * 2);
            if (p > threshold) stop = k + 1;
        }
        break;
    }
    return stop;
}

// Class of a lattice cell from its signed distance (tiles): dithered wet sand
// on the land side, the foam lace at the waterline, then the depth stops.
function waterClass(sd, cap, i, j) {
    if (sd <= 0) {
        if (sd < WET_SAND_DITHER) return CLASS_NONE;
        if (sd < WET_SAND_BAND && bayer(i, j) > 0.5) return CLASS_NONE;
        return CLASS_WET;
    }
    if (sd < FOAM_BAND && bayer(i, j) < 0.5) return CLASS_FOAM;
    if (sd < FOAM_SPARSE_BAND && bayer(i + 1, j + 2) < 0.1875) return CLASS_FOAM;
    return CLASS_WATER + depthStop(sd, cap, i, j);
}

function isRippleSeed(i, j) {
    return hash2(i, j, 131) < RIPPLE_SEED_DENSITY;
}

function coastTileList(renderer) {
    const out = [];
    for (let ty = 0; ty < MAP_SIZE; ty++) {
        for (let tx = 0; tx < MAP_SIZE; tx++) {
            let near = false;
            for (let dy = -1; dy <= 1 && !near; dy++) {
                for (let dx = -1; dx <= 1; dx++) {
                    const x = tx + dx;
                    const y = ty + dy;
                    if (x < 0 || y < 0 || x >= MAP_SIZE || y >= MAP_SIZE) continue;
                    if (isVisualWater(renderer, `${x},${y}`)) { near = true; break; }
                }
            }
            if (near) out.push(tx, ty);
        }
    }
    return out;
}

function landPaved(renderer, wx, wy, tx, ty) {
    const ground = renderer.groundField;
    const CLASS = ground?.CLASS;
    if (ground?.classAt && CLASS) {
        const cls = ground.classAt(wx, wy);
        return cls === CLASS.ROAD || cls === CLASS.PLAZA;
    }
    const key = `${tx},${ty}`;
    return Boolean(renderer.pathTiles?.has(key) || renderer.townSquareTiles?.has(key)
        || renderer.mainAvenueTiles?.has(key) || renderer.commandCenterRoadTiles?.has(key));
}

/**
 * Classify every 2x2 lattice cell of the coast tiles. Returns a compact
 * record: the world-px rect it covers and a per-cell class/colour buffer.
 */
function classifyCoast(renderer, field) {
    const list = coastTileList(renderer);
    if (!list.length) return null;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let k = 0; k < list.length; k += 2) {
        const cx = (list[k] - list[k + 1]) * HALF_W;
        const cy = (list[k] + list[k + 1]) * HALF_H;
        minX = Math.min(minX, cx - HALF_W);
        maxX = Math.max(maxX, cx + HALF_W);
        minY = Math.min(minY, cy - HALF_H);
        maxY = Math.max(maxY, cy + HALF_H);
    }
    // The shelf continues past every map edge into the outer ocean: where
    // the sea reaches the edge a shallow margin deepens into it, and along
    // the far (NW/NE) edges land ends in a beach instead of a cut.
    const southY = (MAP_SIZE - 1) * TILE_HEIGHT + HALF_H;
    maxY = Math.max(maxY, southY + OUTER_SHELF_TILES * TILE_HEIGHT);
    minY = Math.min(minY, -HALF_H - OUTER_SHELF_TILES * TILE_HEIGHT);
    minX = Math.min(minX, -(MAP_SIZE * HALF_W) - OUTER_SHELF_TILES * TILE_WIDTH);
    maxX = Math.max(maxX, MAP_SIZE * HALF_W + OUTER_SHELF_TILES * TILE_WIDTH);
    minX = Math.floor(minX / 2) * 2;
    minY = Math.floor(minY / 2) * 2;
    const cols = Math.ceil((maxX - minX) / 2);
    const rows = Math.ceil((maxY - minY) / 2);
    const classes = new Uint8Array(cols * rows);
    const depth = new Float32Array(cols * rows);
    // Per cell: the stop cap its texels bake under (0 = not coast), and 1
    // for outer-shelf cells, whose texels hand over to the open sea.
    const caps = new Uint8Array(cols * rows);
    const outer = new Uint8Array(cols * rows);
    for (let k = 0; k < list.length; k += 2) {
        const tx = list[k];
        const ty = list[k + 1];
        const cap = field.caps[ty * MAP_SIZE + tx] || depthCapFor('sea');
        const cx = (tx - ty) * HALF_W;
        const cy = (tx + ty) * HALF_H;
        const c0 = Math.floor((cx - HALF_W - minX) / 2);
        const c1 = Math.ceil((cx + HALF_W - minX) / 2);
        const r0 = Math.floor((cy - HALF_H - minY) / 2);
        const r1 = Math.ceil((cy + HALF_H - minY) / 2);
        for (let r = Math.max(0, r0); r < Math.min(rows, r1); r++) {
            const wy = minY + r * 2 + 1;
            for (let c = Math.max(0, c0); c < Math.min(cols, c1); c++) {
                const wx = minX + c * 2 + 1;
                const u = wy / TILE_HEIGHT + wx / TILE_WIDTH;
                const v = wy / TILE_HEIGHT - wx / TILE_WIDTH;
                // A cell straddling the world diamond's edge belongs to the
                // edge tile, so no transparent 1 px teeth open onto the ocean.
                const ut = Math.min(MAP_SIZE - 1, Math.max(0, Math.floor(u + 0.5)));
                const vt = Math.min(MAP_SIZE - 1, Math.max(0, Math.floor(v + 0.5)));
                if (ut !== tx || vt !== ty) continue;
                if (u < -0.56 || v < -0.56 || u > MAP_SIZE - 0.44 || v > MAP_SIZE - 0.44) continue;
                const sd = field.signedDistance(u, v);
                const cell = r * cols + c;
                depth[cell] = sd;
                const cls = waterClass(sd, cap, wx - 1, wy - 1);
                if (cls === CLASS_WET && landPaved(renderer, wx, wy, tx, ty)) continue;
                caps[cell] = cap;
                classes[cell] = cls;
            }
        }
    }
    // Outer shelf: cells beyond the map edges take the signed distance at the
    // nearest in-map point plus how far past the edge they sit (`outerShelfSd`),
    // so the shelf deepens through stops 4-6 into the open sea. Land on the far
    // edges, whose cliff faces away, is held BACK_SHORE_SD inland so it grows
    // a wobbling wet-sand and foam beach; under the SW/SE cliffs the shelf
    // starts at stop 3. Every texel here is clamped to the open sea's stop at
    // its row, and the texels that come out as the deepest stop stay clear:
    // the open sea (COMPOSITE_FRAGMENT / `drawOuterOcean`) paints them with
    // the same per-texel rule, so the handover has no seam.
    const first = -0.44;
    const last = MAP_SIZE - 0.56;
    for (let r = 0; r < rows; r++) {
        const wy = minY + r * 2 + 1;
        for (let c = 0; c < cols; c++) {
            const wx = minX + c * 2 + 1;
            const u = wy / TILE_HEIGHT + wx / TILE_WIDTH;
            const v = wy / TILE_HEIGHT - wx / TILE_WIDTH;
            const lower = u > MAP_SIZE - 0.44 || v > MAP_SIZE - 0.44;
            if (!lower && u >= -0.5 && v >= -0.5) continue;
            const cell = r * cols + c;
            if (caps[cell] || classes[cell] !== CLASS_NONE) continue;
            const uc = Math.min(Math.max(u, first), last);
            const vc = Math.min(Math.max(v, first), last);
            // N8 — the distance past the diamond is Euclidean in tile space,
            // so past a map corner the shelf contours round into arcs
            // instead of straight chevrons echoing the diamond.
            const excess = Math.hypot(u - uc, v - vc);
            if (excess > OUTER_SHELF_TILES) continue;
            const sd = outerShelfSd(field, u, v, uc, vc, excess, lower);
            depth[cell] = sd;
            caps[cell] = OUTER_CAP;
            outer[cell] = 1;
            const cls = outerClass(waterClass(sd, OUTER_CAP, wx - 1, wy - 1), wx - 1, wy - 1);
            if (cls !== CLASS_NONE) classes[cell] = cls;
        }
    }
    return { x: minX, y: minY, cols, rows, classes, depth, caps, outer };
}

// 3.3 — the outer shelf's signed distance (tiles) past the map edge.
function outerShelfSd(field, u, v, uc, vc, excess, lower) {
    const edgeSd = field.signedDistance(uc, vc);
    const landShare = Math.min(1, Math.max(0, -edgeSd / BACK_SHORE_SD));
    let base;
    let reach = excess;
    if (edgeSd > 0) base = Math.min(edgeSd, SHELF_SEA_EDGE_SD);
    else if (lower) {
        // 3.5 — under the SW/SE cliffs the shelf starts at the cliff's foot,
        // not the map edge: the face covers its first CLIFF_FACE px, and the
        // boulders stand in a shallow apron that steps down from there.
        base = SHELF_CLIFF_SD * landShare;
        reach = Math.max(0, excess - (CLIFF_FACE / TILE_HEIGHT) * landShare);
    } else base = Math.max(edgeSd, -BACK_SHORE_SD) + (valueNoise(uc, vc) - 0.5) * 2 * BACK_SHORE_WOBBLE * landShare;
    const deepen = Math.min(reach, SHELF_NEAR_TILES) * SHELF_NEAR_RATE
        + Math.max(0, reach - SHELF_NEAR_TILES) * SHELF_FAR_RATE;
    // Past the edge the depth contours wobble on value noise (growing with
    // distance, zero at the edge), so the shelf's contours never run parallel
    // to the map edge as straight 2:1 lines.
    return base + deepen + (valueNoise(u + 17, v - 11) - 0.5) * 2 * SHELF_WOBBLE * Math.min(1, reach)
        + (valueNoise(u * 0.35 + 41, v * 0.35 - 23) - 0.5) * 2 * SHELF_FAR_WOBBLE
            * Math.min(1, Math.max(0, (reach - 0.5) / 1.5));
}

// An outer-shelf texel's class at world texel (x, y): the shelf paints only
// where it is shallower than the open sea's own stop at that texel; every
// other outer texel is left clear for the open sea, which paints the same
// stop plus the horizon's haze and sky-reflection courses (so no shelf
// trapezoid sits under the horizon band north of the island).
function outerClass(cls, x, y) {
    if (cls < CLASS_WATER) return cls;
    const stop = cls - CLASS_WATER;
    return stop >= openSeaStopAt(openSeaDepthAt(x, y), bayer(x, y)) ? CLASS_NONE : cls;
}

// The signed distance at one texel (ox, oy in {0, 1}) of cell (c, r):
// bilinear between the cell centre and its neighbours, a quarter cell away.
// Only neighbours on the same side of the map edge count: an in-map cell
// keeps the field's raw distance (often far past its stop cap near the
// edge), so blending it into an outer-shelf texel would push that texel to
// the deepest stop and leave it clear, a 1-texel seam along the whole edge.
function texelSd(coast, c, r, ox, oy) {
    const { cols, rows, depth, caps, outer } = coast;
    const self = r * cols + c;
    const own = depth[self];
    const side = outer[self];
    const at = (cc, rr) => {
        if (cc < 0 || rr < 0 || cc >= cols || rr >= rows) return own;
        const k = rr * cols + cc;
        return caps[k] && outer[k] === side ? depth[k] : own;
    };
    const nc = ox ? c + 1 : c - 1;
    const nr = oy ? r + 1 : r - 1;
    const top = own + (at(nc, r) - own) * 0.25;
    const below = at(c, nr);
    const bottom = below + (at(nc, nr) - below) * 0.25;
    return top + (bottom - top) * 0.25;
}

// Per-texel roles in the coast buffer beyond the water classes: an outer
// texel the open sea paints (left clear), a cliff or boulder texel, and a
// baked reflection (a mixed colour, not a stop).
const TEXEL_OPEN = 249;
const TEXEL_LAND = 250;
const TEXEL_MIRROR = 251;

// 3.3 (c) — every coast colour decision per world texel: the class of each
// texel from its own signed distance and its own Bayer threshold, sparse 3x1
// ripple dashes one stop lighter in the middle stops. `buf.role` keeps each
// texel's class for the cliff and the reflections.
function paintCoastTexels(buf, coast) {
    const { data, w, role } = buf;
    const { cols, rows, caps, outer } = coast;
    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
            const cell = r * cols + c;
            const cap = caps[cell];
            if (!cap) continue;
            for (let oy = 0; oy < 2; oy++) {
                const y = coast.y + r * 2 + oy;
                for (let ox = 0; ox < 2; ox++) {
                    const x = coast.x + c * 2 + ox;
                    const sd = texelSd(coast, c, r, ox, oy);
                    let cls = waterClass(sd, cap, x, y);
                    const at = (r * 2 + oy) * w + c * 2 + ox;
                    if (outer[cell] && cls >= CLASS_WATER) {
                        const kept = outerClass(cls, x, y);
                        // 3.3 — where the open sea is at its deepest too, the
                        // shelf keeps painting its deepest stop a little past
                        // its last contour, so the terrain ends inside one stop
                        // and its 4-5 contour is its own, never the handover.
                        const handover = kept === CLASS_NONE && cls === CLASS_WATER + OPEN_SEA_DEEPEST
                            && sd < DEPTH_BOUNDS[DEPTH_BOUNDS.length - 1] + SHELF_HANDOVER_SD
                            && openSeaStopAt(openSeaDepthAt(x, y), bayer(x, y)) === OPEN_SEA_DEEPEST;
                        if (kept === CLASS_NONE && !handover) {
                            role[at] = TEXEL_OPEN;
                            continue;
                        }
                    } else if (cls >= CLASS_WATER) {
                        // 3.3 — in-map water is never deeper than the open sea
                        // on its row: near the horizon the sea lightens toward
                        // stop 2, and the island's far-corner sea follows it
                        // (no deep in-map wedge against a lighter ocean).
                        cls = Math.min(cls, CLASS_WATER + openSeaStopAt(openSeaDepthAt(x, y), bayer(x, y)));
                    }
                    if (cls === CLASS_NONE) continue;
                    if (cls >= CLASS_WATER + 2 && cls <= CLASS_WATER + 3
                        && (isRippleSeed(x, y) || isRippleSeed(x - 1, y) || isRippleSeed(x - 2, y))) {
                        cls -= 1;
                    }
                    role[at] = cls;
                    putRgb(data, at * 4, colourForClass(cls, sd));
                    // A cell whose centre fell to the open sea (or land) but
                    // holds a painted water texel is water for the material
                    // map, so that texel takes the water response too.
                    if (cls >= CLASS_FOAM && coast.classes[cell] === CLASS_NONE) coast.classes[cell] = cls;
                }
            }
        }
    }
}

function colourForClass(cls, sd) {
    if (cls === CLASS_WET) return sd > WET_SAND_EDGE ? WET_SAND_DARK : WET_SAND;
    if (cls === CLASS_FOAM) return sd < FOAM_BAND * 0.5 ? FOAM_CREST : FOAM;
    return COAST_WATER_STOPS[cls - CLASS_WATER];
}

// ---------------------------------------------------------------------------
// The coast buffer: the coast rect's pixels, one world texel each.

function bufferIndex(buf, x, y) {
    const i = x - buf.x;
    const j = y - buf.y;
    return i < 0 || j < 0 || i >= buf.w || j >= buf.h ? -1 : j * buf.w + i;
}

// The water stop index a texel shows (or would show, for an open-sea texel),
// or -1 when it is not open water.
function texelStop(buf, at, x, y) {
    const role = buf.role[at];
    if (role === TEXEL_OPEN) return openSeaStopAt(openSeaDepthAt(x, y), bayer(x, y));
    return role >= CLASS_WATER && role < TEXEL_OPEN ? role - CLASS_WATER : -1;
}

// Mark the coast lattice cell under texel (x, y): water material for an
// open-sea texel a reflection or cliff now paints, the reflection course for
// the resident row ripple (3.6's G flag), and land under a cliff face.
function markCell(coast, x, y, { water = false, reflect = 0, land = false } = {}) {
    const c = (x - coast.x) >> 1;
    const r = (y - coast.y) >> 1;
    if (c < 0 || r < 0 || c >= coast.cols || r >= coast.rows) return;
    const cell = r * coast.cols + c;
    if (land) coast.classes[cell] = CLASS_NONE;
    if (water && coast.classes[cell] < CLASS_WATER) coast.classes[cell] = CLASS_WATER + OPEN_SEA_DEEPEST;
    if (reflect) {
        coast.reflect ||= new Uint8Array(coast.classes.length);
        coast.reflect[cell] = Math.max(coast.reflect[cell], reflect);
    }
}

// 3.7 — the water stop a mirror texel (coast buffer index `at`, `w` texels a
// row) was painted over, + 1 (0: not a mirror), for the storm fade.
function markMirrorBase(coast, w, at, stop) {
    coast.mirrorBase ||= new Uint8Array(w * coast.rows * 2);
    coast.mirrorBase[at] = Math.max(0, stop) + 1;
}

function readRgb(data, o) {
    return [data[o], data[o + 1], data[o + 2]];
}

// The mean of the opaque texels in column `sx` from row `sy` up `rows` rows
// (the source rows one squashed mirror row stands for).
function massRgb(pixels, sx, sy, rows) {
    let r = 0;
    let g = 0;
    let b = 0;
    let n = 0;
    for (let k = 0; k < rows && sy - k >= 0; k++) {
        const o = ((sy - k) * pixels.w + sx) * 4;
        if (pixels.data[o + 3] < 128) continue;
        r += pixels.data[o];
        g += pixels.data[o + 1];
        b += pixels.data[o + 2];
        n += 1;
    }
    return [r / n, g / n, b / n];
}

// 3.5 — a reflected cliff texel: `mix(stopColour, src x MIRROR_DIM, a)`.
const MIRROR_DIM = 0.84;
function mirrorRgb(base, src, alpha) {
    return mixRgb(base, [src[0] * MIRROR_DIM, src[1] * MIRROR_DIM, src[2] * MIRROR_DIM], alpha);
}

// ---------------------------------------------------------------------------
// The shoreline mass (3.5)

// Cliff geometry in world px: the face height wanders +-CLIFF_FACE_WOBBLE on
// three octaves of value noise (a 48 px swell, a 17 px ripple and a 7 px
// grain, amplitudes CLIFF_FACE_OCTAVE_AMPS), so the waterline moves at
// least 6 px along any four-tile run even after its 2:1 slope is removed;
// boulders (2:1, rx 3-5, ry 2-3) pile along the foot in two rows.
const CLIFF_FACE_WOBBLE = 8;
const CLIFF_FACE_SWELL_PX = 48;
const CLIFF_FACE_RIPPLE_PX = 17;
const CLIFF_FACE_GRAIN_PX = 7;
const CLIFF_FACE_OCTAVE_AMPS = Object.freeze([6, 6, 3]);
// The revetment: a back row seated up on the wet foot and a front row
// standing in the water, each present at a low-frequency "heap" share, so
// the rubble runs in heaps and thin stretches, never as an even dotted row.
const BOULDER_ROWS = Object.freeze([
    Object.freeze({ salt: 0, lift: 3, presence: 0.3, heap: 0.6 }),
    Object.freeze({ salt: 1, lift: 0, presence: 0.5, heap: 0.45 }),
]);
const BOULDER_HEAP_PX = 56;
// Rock fractures: at most one per cell of this many columns (upper / lower
// stratum), on this share of cells, so blocks read as bedded rock rather
// than planks.
const FRACTURE_CELL_UPPER = 13;
const FRACTURE_CELL_LOWER = 8;
const FRACTURE_SHARE = 0.6;
const PALISADE_ROWS = 14;
const STONE = ART_RAMPS.stone.map(hexRgb);

function edgeSides() {
    const last = MAP_SIZE - 1;
    const east = { x: last * HALF_W + HALF_W, y: last * HALF_H };
    const south = { x: 0, y: last * TILE_HEIGHT + HALF_H };
    const west = { x: -last * HALF_W - HALF_W, y: last * HALF_H };
    return [
        // SE face: tileX = MAP-1 edge, faces down-right, in key shadow.
        { a: east, b: south, face: 'se', edgeU: true, salt: 1 },
        // SW face: tileY = MAP-1 edge, faces down-left, takes the key.
        { a: south, b: west, face: 'sw', edgeU: false, salt: 2 },
    ];
}

function edgeYAt(side, x) {
    const t = (x + 0.5 - side.a.x) / (side.b.x - side.a.x);
    return Math.floor(side.a.y + (side.b.y - side.a.y) * t);
}

function cliffFaceAt(side, x, plain) {
    if (plain) return CLIFF_FACE;
    const swell = valueNoise(x / CLIFF_FACE_SWELL_PX, side.salt * 7.3);
    const ripple = valueNoise(x / CLIFF_FACE_RIPPLE_PX, side.salt * 7.3 + 19.1);
    const grain = valueNoise(x / CLIFF_FACE_GRAIN_PX, side.salt * 7.3 + 41.7);
    const [a, b, c] = CLIFF_FACE_OCTAVE_AMPS;
    const wobble = Math.round((swell - 0.5) * 2 * a + (ripple - 0.5) * 2 * b + (grain - 0.5) * 2 * c);
    return CLIFF_FACE + Math.max(-CLIFF_FACE_WOBBLE, Math.min(CLIFF_FACE_WOBBLE, wobble));
}

// A partial vertical fracture in a stratum `rows` tall: at most one per
// `cell` columns, present on FRACTURE_SHARE of cells, running a hashed span
// of rows; the column right of it is the next block's lit edge. Null where
// column `x` is neither.
function fractureAt(x, cell, salt, rows) {
    const k = Math.floor(x / cell);
    if (hash2(k, salt, 409) > FRACTURE_SHARE) return null;
    const at = k * cell + Math.floor(hash2(k, salt, 401) * (cell - 1));
    if (x !== at && x !== at + 1) return null;
    const from = Math.floor(hash2(k, salt, 419) * 4);
    return { lit: x === at + 1, from, to: Math.max(from + 3, rows - Math.floor(hash2(k, salt, 421) * 5)) };
}

// Edge tiles whose columns keep a plain face with no revetment: building
// footprints, the Harbor slip (its water apron) and bridges.
function cliffPlainTiles(renderer) {
    const keys = buildingFootprintKeys(renderer);
    for (const key of renderer.harborWaterApronTiles || []) keys.add(key);
    for (const key of renderer.bridgeTiles || []) keys.add(key);
    return keys;
}

// The village wall sprites' pixels, for the palisade band of the reflection.
function wallPixels(renderer) {
    const out = [];
    for (const sprite of renderer.districtPropSprites || []) {
        if (!String(sprite?.id || '').startsWith('village.wall.')) continue;
        const cached = sprite._getCachedCanvas?.();
        const canvas = cached?.canvas;
        if (!canvas?.width || !canvas.height) continue;
        try {
            const data = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, canvas.width, canvas.height).data;
            out.push({ x: cached.x, y: cached.y, w: canvas.width, h: canvas.height, data });
        } catch {
            // A tainted or lost canvas simply reflects no palisade.
        }
    }
    return out;
}

function wallTexel(walls, x, y) {
    for (const wall of walls) {
        const i = x - wall.x;
        const j = y - wall.y;
        if (i < 0 || j < 0 || i >= wall.w || j >= wall.h) continue;
        const o = (j * wall.w + i) * 4;
        if (wall.data[o + 3] >= 128) return readRgb(wall.data, o);
    }
    return null;
}

// The boulder revetment along one side: two rows of overlapping 2:1 boulders
// (a back row up on the wet foot, a front row standing in the water), each
// present where a low-frequency heap noise allows, hash-seeded, back to front.
function sideBoulders(side, x0, x1, plainAt) {
    const boulders = [];
    for (const row of BOULDER_ROWS) {
        let x = x0 + row.salt * 2;
        let slot = 0;
        while (x < x1) {
            const s = slot * 2 + row.salt;
            const rx = 3 + Math.floor(hash2(s, side.salt, 311) * 3);
            const ry = 2 + Math.floor(hash2(s, side.salt, 313) * 2);
            const cx = x + rx;
            const heap = valueNoise(cx / BOULDER_HEAP_PX, side.salt * 3.1 + row.salt * 5.7);
            if (hash2(s, side.salt, 317) < row.presence + row.heap * heap && !plainAt(cx)) {
                const foot = edgeYAt(side, cx) + cliffFaceAt(side, cx, false);
                boulders.push({ cx, cy: foot - row.lift + Math.floor(hash2(s, side.salt, 331) * 2), rx, ry, dark: side.face === 'se' });
            }
            x += Math.max(3, Math.round(rx * (0.9 + hash2(s, side.salt, 337) * 0.8)));
            slot += 1;
        }
    }
    return boulders.sort((a, b) => a.cy - b.cy);
}

// A boulder texel: upper-left lit body in four stone steps (one step darker
// on the SE face), a dark-warm rim on the lower-right silhouette and a wet
// dark underside where it meets the water.
function boulderRgb(b, x, y) {
    const nx = (x + 0.5 - b.cx) / b.rx;
    const ny = (y + 0.5 - b.cy) / b.ry;
    const inside = (px, py) => ((px + 0.5 - b.cx) / b.rx) ** 2 + ((py + 0.5 - b.cy) / b.ry) ** 2 <= 1;
    if ((nx > 0 || ny > 0) && (!inside(x + 1, y) || !inside(x, y + 1))) return TIMBER[1];
    if (ny > 0.55) return STONE[1];
    const light = (-nx - ny) * 0.5 + 0.5 - (b.dark ? 0.2 : 0);
    if (light > 0.86) return STONE[4];
    if (light > 0.6) return STONE[3];
    if (light > 0.34) return STONE[2];
    return STONE[1];
}

/**
 * 3.5 — the island's camera-facing land edges (SW, SE): a 2:1 stepped top
 * and three strata whose face height wanders +-8 px on low-frequency noise,
 * a boulder revetment at the wet foot (plain under building footprints, the
 * Harbor slip and bridges), the waterline under the lowest boulder texel,
 * surf lace hugging it, one shallow stop dithered out over 4 texels, and the
 * face, boulders and palisade reflected at REFLECTION_ALPHAS with every 3rd
 * row dropped. Only where the edge tile is land: where the sea reaches the
 * map edge it meets the outer shelf.
 */
function paintStratifiedCliff(buf, coast, field, renderer) {
    const edgeLimit = MAP_SIZE - 0.5 - 0.06;
    const plainTiles = cliffPlainTiles(renderer);
    const walls = wallPixels(renderer);
    const { data, role } = buf;
    const set = (x, y, rgb, kind) => {
        const at = bufferIndex(buf, x, y);
        if (at < 0) return;
        putRgb(data, at * 4, rgb);
        role[at] = kind;
    };
    for (const side of edgeSides()) {
        const strata = CLIFF_STRATA[side.face];
        const x0 = Math.ceil(Math.min(side.a.x, side.b.x));
        const x1 = Math.floor(Math.max(side.a.x, side.b.x));
        const columnInfo = (x) => {
            const edgeY = edgeYAt(side, x);
            const wy = edgeY - 1;
            const u = wy / TILE_HEIGHT + (x + 0.5) / TILE_WIDTH;
            const v = wy / TILE_HEIGHT - (x + 0.5) / TILE_WIDTH;
            const su = side.edgeU ? Math.min(u, edgeLimit) : u;
            const sv = side.edgeU ? v : Math.min(v, edgeLimit);
            const tx = side.edgeU ? MAP_SIZE - 1 : Math.min(MAP_SIZE - 1, Math.max(0, Math.floor(su + 0.5)));
            const ty = side.edgeU ? Math.min(MAP_SIZE - 1, Math.max(0, Math.floor(sv + 0.5))) : MAP_SIZE - 1;
            return {
                edgeY,
                land: field.signedDistance(su, sv) <= 0,
                plain: plainTiles.has(`${tx},${ty}`),
                along: Math.floor(side.edgeU ? v : u),
            };
        };
        const info = new Map();
        for (let x = x0; x < x1; x++) info.set(x, columnInfo(x));
        const boulders = sideBoulders(side, x0, x1, (x) => {
            const at = info.get(Math.round(x));
            return !at || !at.land || at.plain;
        });
        // Face strata, one texel column at a time: the stepped courses, block
        // joints (dark, with the next block's left edge lit by the upper-left
        // key) in both strata, grit in the sandstone and short water stains
        // running down from the seam.
        const foot = new Map();
        const upSalt = side.salt + 11;
        const loSalt = side.salt + 13;
        for (let x = x0; x < x1; x++) {
            const col = info.get(x);
            if (!col.land) continue;
            const faceH = cliffFaceAt(side, x, col.plain);
            const extra = faceH - CLIFF_FACE;
            const wobble = Math.floor(hash2(col.along, side.salt, 71) * 3) - 1;
            const lip = Math.floor(hash2(x >> 3, side.salt + 2, 17) * 2);
            let y = col.edgeY;
            const run = (height, pick) => {
                for (let k = 0; k < height; k++, y++) {
                    set(x, y, pick(k), TEXEL_LAND);
                    markCell(coast, x, y, { land: true });
                }
            };
            run(2 + lip, () => strata.root);
            run(1, () => (hash2(x >> 2, col.along, 29) > 0.2 ? strata.highlight : strata.upper));
            const upperTop = y;
            const upperRows = Math.max(4, 12 + wobble + Math.ceil(extra / 2));
            const up = fractureAt(x, FRACTURE_CELL_UPPER, upSalt, upperRows);
            // One darker bedding course per rock block, at a hashed height.
            const bed = 4 + Math.floor(hash2(Math.floor(x / FRACTURE_CELL_UPPER), upSalt, 427) * Math.max(1, upperRows - 7));
            run(upperRows, k => (up && !up.lit && k >= up.from && k < up.to ? strata.joint
                : up?.lit && k >= up.from && k < up.from + 2 ? strata.lit
                    : k === bed ? strata.bed : strata.upper));
            // Sparse 2x1 grit in the sandstone so the course is not a flat band.
            if (!up && hash2(x >> 1, col.along, 43) < 0.16) set(x, upperTop + 2 + Math.floor(hash2(x >> 1, 5, 61) * 8), strata.speck, TEXEL_LAND);
            run(1, () => strata.seam);
            const lowerRows = Math.max(3, 11 - wobble - lip + Math.floor(extra / 2));
            const lo = fractureAt(x, FRACTURE_CELL_LOWER, loSalt, lowerRows);
            const stain = hash2(x >> 1, side.salt, 431) < 0.09 ? 3 + Math.floor(hash2(x >> 1, side.salt, 433) * 6) : 0;
            run(lowerRows, k => (k < stain ? strata.stain
                : lo && !lo.lit && k >= lo.from && k < lo.to ? strata.lowJoint
                    : lo?.lit && k >= lo.from && k < lo.from + 2 ? strata.lowLit : strata.lower));
            run(4, () => strata.foot);
            run(Math.max(1, col.edgeY + faceH - y), () => strata.wet);
            foot.set(x, y);
        }
        // The revetment over the wet foot and into the water.
        for (const b of boulders) {
            for (let y = Math.floor(b.cy - b.ry); y <= Math.ceil(b.cy + b.ry); y++) {
                for (let x = Math.floor(b.cx - b.rx); x <= Math.ceil(b.cx + b.rx); x++) {
                    if (((x + 0.5 - b.cx) / b.rx) ** 2 + ((y + 0.5 - b.cy) / b.ry) ** 2 > 1) continue;
                    const col = info.get(x);
                    if (!col?.land || col.plain) continue;
                    set(x, y, boulderRgb(b, x, y), TEXEL_LAND);
                    foot.set(x, Math.max(foot.get(x) ?? 0, y + 1));
                }
            }
        }
        // Waterline, lace, the shallow foot and the reflection per column.
        for (let x = x0; x < x1; x++) {
            const col = info.get(x);
            if (!col.land) continue;
            const waterline = foot.get(x);
            if (waterline == null) continue;
            let y = waterline;
            // Surf lace hugging the boulder bases: clustered runs (a coarse
            // and a fine hash), two foam buckets, a sparse second texel.
            const lace = hash2(x >> 3, side.salt + 4, 37) * 0.6 + hash2(x >> 1, 1, 41) * 0.4;
            const laceRows = lace < 0.6 ? (hash2(x >> 1, waterline, 83) < 0.4 ? 2 : 1) : 0;
            for (let k = 0; k < laceRows; k++, y++) {
                const at = bufferIndex(buf, x, y);
                if (at < 0 || texelStop(buf, at, x, y) < 0) break;
                set(x, y, k === 0 && lace < 0.22 ? FOAM_CREST : FOAM, CLASS_FOAM);
                markCell(coast, x, y, { water: true });
            }
            // One shallow stop at the foot, dithered out over 4 texels.
            for (let k = 0; k < 4; k++) {
                const at = bufferIndex(buf, x, y + k);
                if (at < 0) break;
                const stop = texelStop(buf, at, x, y + k);
                if (stop < 0) break;
                if (bayer(x, y + k) >= 1 - k / 4) continue;
                set(x, y + k, COAST_WATER_STOPS[Math.max(0, stop - 1)], CLASS_WATER + Math.max(0, stop - 1));
                markCell(coast, x, y + k, { water: true });
            }
            // The mirror: the face (with its boulders) above the waterline,
            // then the palisade standing on the edge, three alpha courses by
            // distance, every 3rd row dropped, jittered a texel on a hash.
            const faceRows = waterline - col.edgeY;
            let palisade = 0;
            while (palisade < PALISADE_ROWS && wallTexel(walls, x, col.edgeY - 1 - palisade)) palisade += 1;
            const length = faceRows + palisade;
            for (let k = 0; k < length; k++) {
                const ty = y + k;
                const at = bufferIndex(buf, x, ty);
                if (at < 0) break;
                const stop = texelStop(buf, at, x, ty);
                if (stop < 0) break;
                if (k % 3 === 2) continue;
                const sy = waterline - 1 - k;
                const jitter = hash2(x >> 1, ty, 97) < 0.18 ? 1 : 0;
                let src = null;
                if (sy >= col.edgeY) {
                    const from = bufferIndex(buf, x + jitter, sy);
                    if (from >= 0 && buf.role[from] === TEXEL_LAND) src = readRgb(data, from * 4);
                } else {
                    src = wallTexel(walls, x + jitter, sy);
                }
                if (!src) continue;
                const course = Math.min(REFLECTION_ALPHAS.length - 1, Math.floor((k * REFLECTION_ALPHAS.length) / length));
                const base = buf.role[at] === TEXEL_OPEN ? COAST_WATER_STOPS[stop] : readRgb(data, at * 4);
                set(x, ty, mirrorRgb(base, src, REFLECTION_ALPHAS[course]), TEXEL_MIRROR);
                markCell(coast, x, ty, { water: true, reflect: course + 1 });
                markMirrorBase(coast, buf.w, at, stop);
            }
        }
    }
}

// ---------------------------------------------------------------------------
// The bake pass (stage 'coast')

function paintCoast(ctx, coast, field, renderer) {
    const transform = ctx.getTransform?.();
    const pure = transform && transform.a === 1 && transform.d === 1 && transform.b === 0 && transform.c === 0
        && Number.isInteger(transform.e) && Number.isInteger(transform.f);
    const w = coast.cols * 2;
    const h = coast.rows * 2;
    let image;
    let px = 0;
    let py = 0;
    if (pure) {
        px = coast.x + transform.e;
        py = coast.y + transform.f;
        image = ctx.getImageData(px, py, w, h);
    } else {
        image = new ImageData(w, h);
    }
    const buf = { data: image.data, w, h, x: coast.x, y: coast.y, role: new Uint8Array(w * h) };
    paintCoastTexels(buf, coast);
    paintStratifiedCliff(buf, coast, field, renderer);
    if (pure) {
        ctx.putImageData(image, px, py);
        // The finish pass mirrors the statics over this exact bake.
        coast.baked = { data: image.data.slice(), role: buf.role, w, h };
        return;
    }
    // Uncached fallback (terrain over the surface budget): stamp through a
    // layer so the camera transform applies. No static reflections there.
    coast.layer ||= (() => {
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        canvas.getContext('2d').putImageData(image, 0, 0);
        return canvas;
    })();
    ctx.drawImage(coast.layer, coast.x, coast.y);
}

// ---------------------------------------------------------------------------
// Full-colour static reflections (3.7, stage 'finish')
//
// Everything static at the water mirrors into the open water below it:
// buildings, landmark bridges (their span sprite, which the terrain bake
// painted), trees (FoliageRenderer's upright frame), boulders and district
// props (mangroves, driftwood, the net rack, buoys, the wall ends), and
// whatever else the terrain bake painted over water (dock and causeway
// tiles, foundations). Each column flips about the source's own waterline,
// the row where the object meets the water, never a fixed offset: a
// building's or bridge's bottom profile (its lowest opaque texel per column)
// under a 2:1 envelope, so a pier deck between two posts mirrors about the
// line of the posts' feet; a tree or prop its base row; a terrain-painted
// structure the foot of its covered run.
//
// Value: a texel is `mix(stop, src x MIRROR_VALUE, a)` in three alpha
// courses over a reach scaled to the source's height, so it reads darker
// than its source and cooled by the stop, but never more than
// MIRROR_STOP_DROP water stops darker than the stop it lies on (two over the
// first MIRROR_NEAR_SHARE of the reach in water, one after), so a dark wall
// over a light shallow stop stays water. A tall source (tallness 0 at
// MIRROR_TALL_FROM px, 1 at MIRROR_TALL_FROM + MIRROR_TALL_SPAN: the
// Harbor's storeys a third, the Lighthouse whole) mirrors as a silhouette:
// up to MIRROR_TALL_REACH more rows, the source squashed so the mirror shows
// up to its full height (the lantern room), lighter courses, a two-texel
// ripple and a taper.
//
// Form: every MIRROR_RIPPLE_EVERY-th row (every third on a tall source)
// drops in 16-texel runs, three-row bands take a whole-texel sideways ripple
// past the first MIRROR_CRISP_ROWS rows of water, and later courses streak.
// Courses count from the source's base row, so columns with different beach
// widths meet on one seam. Edges dither: the last rows of the reach, and the
// last columns of every row run of a source's mirror wider than
// MIRROR_EDGE_MIN_RUN (up to MIRROR_EDGE_COLS, the end wandering a texel,
// widening down a tall mirror's taper), so neither a sprite's side nor the
// beach's curve cuts a vertical wall into the water. A source's mirror keeps
// only the pieces joined to its waterline: a piece that starts under an
// overhang (a crane jib far off the building's feet) with nothing tying it
// to the grounded mirror is dropped, never left as a floating ghost.
//
// Placement: the mirror writes only open water past the surf (signed
// distance >= MIRROR_SURF_SD, so the foam lace and its dither stay on top),
// may cross `gap` rows of land and surf before the water begins, runs on
// under a dock or pier, and stops at the first land after the water began,
// so nothing reflects behind land. The resident water shader ripples these
// cells by whole texel rows (3.6 G flag) and gives them back to the water in
// heavy rain (`mirrorStormDrop`).
//
// Lit accents: an emitter texel of a landmark (its emissive sidecar) mirrors
// into `coast.mirrorAccents` as the lit window it is (albedo plus its
// emission, MIRROR_ACCENT_VALUE over the stop); `mirrorAccentLayers` cuts
// them per 6.3 glass group, and both backends show a group's accents
// ungraded only while its room is lit (EmitterCuts). The bake keeps the
// unlit pane, so a dark room's mirrored window stays dark. A hot texel on a
// source without a sidecar (fire, a lamp) mirrors MIRROR_LIT_RATIO brighter.

const REFLECTION_BASE_SD = -0.3;
// Rows of land a source's mirror may skip before the water begins below it:
// a low source (tree, prop) REFLECTION_LAND_GAP; a tall building a share of
// its height, up to REFLECTION_TALL_GAP (a tower set back from the water
// mirrors its upper storeys in the water in front of it, as a real one does).
const REFLECTION_LAND_GAP = 14;
const REFLECTION_TALL_GAP = 56;
const REFLECTION_TALL_SHARE = 0.34;
// The value rule: the source darkened to MIRROR_VALUE over the water stop at
// the course's alpha; courses end at these shares of the source's reach.
const MIRROR_VALUE = 0.72;
const STATIC_REFLECTION_ALPHAS = Object.freeze([0.8, 0.6, 0.36]);
const STATIC_REFLECTION_COURSE_SHARES = Object.freeze([0.3, 0.62]);
// The value floor, in water stops below the texel's own (near the water's
// start and after); past the deepest stop each further stop keeps
// MIRROR_DEEP_STEP of the luma.
const MIRROR_STOP_DROP = Object.freeze({ near: 2, far: 1 });
const MIRROR_NEAR_SHARE = 0.3;
const MIRROR_DEEP_STEP = 0.84;
// Rows past the waterline a source mirrors: a share of its height, clamped.
const MIRROR_REACH_SHARE = 0.6;
const MIRROR_REACH_MIN = 36;
const MIRROR_REACH_MAX = 112;
// Tall sources (see above).
const MIRROR_TALL_FROM = 160;
const MIRROR_TALL_SPAN = 200;
const MIRROR_TALL_REACH = 48;
const MIRROR_TALL_LIGHTEN = 0.2;
// Columns a tall mirror's edges give up per row of reach (x tallness), at
// most MIRROR_TAPER_SHARE of the row run's width a side: the taper thins the
// edges, never eats the core.
const MIRROR_TAPER = 0.1;
const MIRROR_TAPER_SHARE = 0.12;
// A tower's mirror (tallness >= MIRROR_CORE_TALL) has a core, the texels of
// a row run inside its dithered edges and the whole of its narrow runs (the
// lantern posts, the finial): the shaft keeps the near course's alpha
// (MIRROR_CORE_COURSE) and value range to the lantern, lightened only
// MIRROR_CORE_LIGHTEN (x tallness) and broken on MIRROR_CORE_BREAK_SHARE of
// the ripple rows (the edges MIRROR_BREAK_SHARE), so a tower mirrors as a
// dense inverted column whose edges ripple and thin.
const MIRROR_CORE_LIGHTEN = 0.04;
const MIRROR_CORE_COURSE = 0;
const MIRROR_CORE_TALL = 0.75;
const MIRROR_BREAK_SHARE = 0.6;
const MIRROR_CORE_BREAK_SHARE = 0.15;
// Silhouette edge dither (see above).
const MIRROR_EDGE_COLS = 8;
const MIRROR_EDGE_MIN_RUN = 12;
// The rows of water under the waterline that stay crisp (no ripple).
const MIRROR_CRISP_ROWS = 3;
// A building column whose bottom sits more than this above the 2:1 line
// through its lowest feet is an overhang, not a waterline.
const MIRROR_GROUND_TOL = 8;
// Hot texels on a source without a sidecar keep MIRROR_LIT_RATIO more of
// their value, at least MIRROR_LIT_ALPHA opaque; an emissive sidecar texel
// counts from MIRROR_EMISSIVE_ALPHA and lights its accent at
// MIRROR_ACCENT_VALUE (its lit look: albedo + 0.84 x A x emission, the
// scene pass's emitter).
const MIRROR_LIT_RATIO = 1.3;
const MIRROR_LIT_ALPHA = 0.9;
const MIRROR_EMISSIVE_ALPHA = 26;
const MIRROR_ACCENT_VALUE = 0.85;
// Half-width (px) of the 2:1 envelope over a building's bottom profile.
const MIRROR_ENVELOPE_PX = 40;
// The surf the mirror leaves alone: the foam lace and its sparse dither.
const MIRROR_SURF_SD = FOAM_SPARSE_BAND + 0.08;
const MIRROR_RIPPLE_EVERY = 4;
// The last rows of a mirror's reach dither out on the Bayer order.
const MIRROR_FADE_ROWS = 16;

/**
 * 3.7 — heavy rain breaks the still mirrors: from `from` precipitation (rain
 * or storm) a share of every mirror texel gives way to its water stop on the
 * Bayer order, all of them at from + span, in `steps` buckets. The resident
 * shader (`mirrorStormColour`) and the Canvas mood layer read the same rule.
 */
export const MIRROR_STORM = Object.freeze({ from: 0.3, span: 0.4, steps: 8 });
export function mirrorStormDrop(weather) {
    const type = weather?.type;
    if (type !== 'rain' && type !== 'storm') return 0;
    const precipitation = Number(weather.precipitation ?? weather.intensity) || 0;
    const share = Math.max(0, Math.min(1, (precipitation - MIRROR_STORM.from) / MIRROR_STORM.span));
    return Math.floor(share * MIRROR_STORM.steps + 0.5) / MIRROR_STORM.steps;
}

function mirrorCourse(r, reach) {
    const [first, second] = STATIC_REFLECTION_COURSE_SHARES;
    return r < reach * first ? 0 : r < reach * second ? 1 : 2;
}

// A source `height` px tall: `{ reach, squash, tall }` (rows mirrored past
// the waterline, source rows per mirror row, tallness 0..1).
function mirrorShape(height) {
    const tall = Math.max(0, Math.min(1, (height - MIRROR_TALL_FROM) / MIRROR_TALL_SPAN));
    const reach = Math.max(MIRROR_REACH_MIN,
        Math.min(MIRROR_REACH_MAX + Math.round(MIRROR_TALL_REACH * tall), Math.round(height * MIRROR_REACH_SHARE)));
    const cover = MIRROR_REACH_SHARE + (1 - MIRROR_REACH_SHARE) * tall;
    return { reach, squash: Math.max(1, (height * cover) / reach), tall };
}

/**
 * 2.9 / 3.7 — where a source row lands in a sprite's static mirror: the
 * mirror rows below the column's waterline (its `waterlineProfile` axis, the
 * world row under the column's lowest opaque texel on the 2:1 envelope; the
 * land `gap` never shifts it) of the row `rowsAboveWaterline` rows above that
 * axis, for a sprite `spriteHeight` px tall. The Lighthouse lamp's water
 * column starts here, on the lamp's own mirror.
 */
export function mirrorRowOf(spriteHeight, rowsAboveWaterline) {
    return Math.max(0, Math.round((rowsAboveWaterline - 1) / mirrorShape(spriteHeight).squash));
}

// Ripple rows: every `every`-th row drops in 16-texel runs on a hash (a
// `share` of the runs), so the mirror reads as horizontal breaks, never
// vertical stripes. The core's breaks are a subset of the edges'.
function brokenRow(wx, row, r, every, share) {
    return r % every === every - 1 && hash2(wx >> 4, row, 7) < share;
}

function rippleEvery(shape) {
    return shape.tall >= 0.5 ? 3 : MIRROR_RIPPLE_EVERY;
}

// Whole-texel sideways shift (up to `amp`) of a three-row band.
function rippleShift(row, amp) {
    const h = hash2(Math.floor(row / 3), 0, 17);
    return h < 0.14 ? -amp : h > 0.86 ? amp : 0;
}

// The water smears a mirror sideways the further it lies from the
// waterline: course k samples one source texel per run of k + 1 world
// texels (the run start staggered per row), so the source's fine detail
// reads as horizontal streaks, never as noise. Returns the texel's offset
// into its run.
function streakOffset(wx, row, course) {
    if (course <= 0) return 0;
    const width = course + 1;
    return (((wx + Math.floor(hash2(row, 0, 23) * width)) % width) + width) % width;
}

// A lit accent on a source without an emissive sidecar: fire, a lamp.
function hotTexel(rgb) {
    return rgb[0] >= 220 && rgb[1] >= 90 && rgb[0] - rgb[2] >= 150;
}

function rgbLuma(rgb) {
    return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
}

const STOP_LUMA = COAST_WATER_STOPS.map(rgbLuma);
function stopLuma(k) {
    const last = STOP_LUMA.length - 1;
    return k <= last ? STOP_LUMA[k] : STOP_LUMA[last] * MIRROR_DEEP_STEP ** (k - last);
}

function staticMirrorRgb(base, src, alpha, lit) {
    const value = lit ? Math.min(1, MIRROR_VALUE * MIRROR_LIT_RATIO) : MIRROR_VALUE;
    return mixRgb(base, [src[0] * value, src[1] * value, src[2] * value], lit ? Math.max(alpha, MIRROR_LIT_ALPHA) : alpha);
}

// The value floor: where the course's darkest mirror (black at `alpha`)
// would sit more than `drop` stops below the texel's own stop, the mirror's
// value range is compressed into [that floor, the stop] on a square curve
// (the texel moves toward the stop, keeping its hue): the dark mass sits
// near the floor and the source's light details rise out of it, so a dark
// wall over a light shallow stop keeps its shape but stays water.
function mirrorFloor(rgb, base, stop, drop, alpha) {
    const floor = stopLuma(stop + drop);
    const lb = rgbLuma(base);
    const lowest = lb * (1 - alpha);
    const l = rgbLuma(rgb);
    if (lowest >= floor || l >= lb) return rgb;
    const share = Math.max(0, l - lowest) / Math.max(1e-6, lb - lowest);
    const target = floor + share * share * (lb - floor);
    if (l >= target) return rgb;
    return mixRgb(rgb, base, Math.min(1, (target - l) / (lb - l)));
}

// A building's waterline per sprite column (world y of the first row under
// it, or null): its lowest opaque texel, pushed down to the 2:1 line through
// any lower foot within MIRROR_ENVELOPE_PX, so the span between two posts
// (or under an arch) mirrors about the line the posts stand on. `grounded`
// is false where that line still sits more than MIRROR_GROUND_TOL above the
// 2:1 line through the source's lowest feet at any distance (an overhang).
export function waterlineProfile(pixels, y) {
    const { w, h, data } = pixels;
    const bottom = new Float64Array(w).fill(-Infinity);
    for (let sx = 0; sx < w; sx++) {
        for (let sy = h - 1; sy >= 0; sy--) {
            if (data[(sy * w + sx) * 4 + 3] < 128) continue;
            bottom[sx] = y + sy + 1;
            break;
        }
    }
    const axis = new Array(w).fill(null);
    const grounded = new Uint8Array(w);
    for (let sx = 0; sx < w; sx++) {
        if (bottom[sx] === -Infinity) continue;
        let best = bottom[sx];
        let ground = bottom[sx];
        for (let k = 1; k < w; k++) {
            const left = sx - k >= 0 ? bottom[sx - k] - k / 2 : -Infinity;
            const right = sx + k < w ? bottom[sx + k] - k / 2 : -Infinity;
            const reach = Math.max(left, right);
            if (k <= MIRROR_ENVELOPE_PX) best = Math.max(best, reach);
            ground = Math.max(ground, reach);
        }
        axis[sx] = Math.round(best);
        grounded[sx] = best >= ground - MIRROR_GROUND_TOL ? 1 : 0;
    }
    return { axis, grounded };
}

// A texel the terrain bake painted over baked water (timber, stone): not a
// water colour and clearly off the baked one.
function coveredBy(data, baked, o) {
    const r = data[o];
    const g = data[o + 1];
    const b = data[o + 2];
    if (Math.abs(r - baked[o]) + Math.abs(g - baked[o + 1]) + Math.abs(b - baked[o + 2]) < 24) return false;
    return !wateryPixel(r, g, b);
}

function imagePixels(source, cache) {
    if (!source) return null;
    if (cache.has(source)) return cache.get(source);
    let pixels = null;
    const width = source.naturalWidth || source.width;
    const height = source.naturalHeight || source.height;
    if (width && height) {
        try {
            let canvas = source;
            if (!canvas.getContext) {
                canvas = document.createElement('canvas');
                canvas.width = width;
                canvas.height = height;
                canvas.getContext('2d').drawImage(source, 0, 0);
            }
            pixels = { data: canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, width, height).data, w: width, h: height };
        } catch {
            pixels = null;
        }
    }
    cache.set(source, pixels);
    return pixels;
}

const ALWAYS_GROUNDED = () => true;

// A landmark's lamp: its static `fixture` manifest layers (the Pharos lamp,
// bottom-centre anchored in base-local px, as `partDrawsFor` draws it) laid
// over a copy of its sheet, and `lamp`, a mask of their opaque texels (null
// when it has none). The mirror shows the lamp by day and lights it as an
// accent (MIRROR_LAMP_GROUP) while the Lighthouse lamp burns.
function withLampLayers(sheet, entry, id, assets, cache) {
    let pixels = sheet;
    let lamp = null;
    for (const [name, layer] of Object.entries(entry?.layers || {})) {
        if (layer?.fixture !== true || layer.cycle || layer.frames !== undefined || !Array.isArray(layer.anchor)) continue;
        const art = imagePixels(assets?.get?.(`${id}.${name}`), cache);
        if (!art) continue;
        if (!lamp) {
            pixels = { data: sheet.data.slice(), w: sheet.w, h: sheet.h };
            lamp = new Uint8Array(sheet.w * sheet.h);
        }
        const left = Math.round(layer.anchor[0] - art.w / 2);
        const top = Math.round(layer.anchor[1] - art.h);
        for (let ay = 0; ay < art.h; ay++) {
            for (let ax = 0; ax < art.w; ax++) {
                const sx = left + ax;
                const sy = top + ay;
                const a = (ay * art.w + ax) * 4;
                if (sx < 0 || sy < 0 || sx >= sheet.w || sy >= sheet.h || art.data[a + 3] < 128) continue;
                const o = (sy * sheet.w + sx) * 4;
                pixels.data[o] = art.data[a];
                pixels.data[o + 1] = art.data[a + 1];
                pixels.data[o + 2] = art.data[a + 2];
                pixels.data[o + 3] = 255;
                lamp[sy * sheet.w + sx] = 1;
            }
        }
    }
    return { pixels, lamp };
}

// Sprite reflection sources: `{ pixels, glow, lamp, building, x, y, gap,
// shape, sortY, axisAt(sx), groundedAt(sx) }` in world px; `glow` is the
// emissive sidecar's pixels (or null), `lamp` the lamp mask
// (withLampLayers), `gap` how many land rows the mirror may skip below the
// waterline, `shape` its mirrorShape.
function reflectionSources(renderer, field) {
    const out = [];
    const cache = new Map();
    const near = (wx, wy, gap = REFLECTION_LAND_GAP) => field.signedDistanceAtWorld(wx, wy)
        > REFLECTION_BASE_SD - Math.max(0, gap - REFLECTION_LAND_GAP) / TILE_HEIGHT;
    const assets = renderer.assets;
    const buildings = renderer.buildingRenderer;
    for (const building of renderer.world?.buildings?.values?.() || []) {
        const entry = assets?.getEntry?.(`building.${building.type}`);
        const id = entry?.id || `building.${building.type}`;
        const image = assets?.get?.(id);
        const anchor = assets?.getAnchor?.(id);
        const center = buildings?._buildingScreenCenter?.(building);
        if (!image || !anchor || !center) continue;
        const x0 = building.position.tileX;
        const y0 = building.position.tileY;
        const w = building.width || 1;
        const h = building.height || 1;
        const frontX = (x0 + w - 1 - (y0 + h - 1)) * HALF_W;
        const frontY = (x0 + w - 1 + y0 + h - 1) * HALF_H + HALF_H;
        const leftX = (x0 - (y0 + h - 1)) * HALF_W - HALF_W;
        const rightX = (x0 + w - 1 - y0) * HALF_W + HALF_W;
        const edgeY = wx => Math.round(frontY - Math.abs(wx - frontX) / 2);
        const height = image.naturalHeight || image.height || 0;
        const gap = Math.max(REFLECTION_LAND_GAP, Math.min(REFLECTION_TALL_GAP, Math.round(height * REFLECTION_TALL_SHARE)));
        if (!near(frontX, frontY, gap) && !near(leftX + 4, edgeY(leftX + 4), gap) && !near(rightX - 4, edgeY(rightX - 4), gap)) continue;
        const sheet = imagePixels(image, cache);
        if (!sheet) continue;
        const { pixels, lamp } = withLampLayers(sheet, entry, id, assets, cache);
        const glow = imagePixels(emissiveSidecarFor(assets, id), cache);
        const x = Math.round(center.x - anchor[0]);
        const y = Math.round(center.y - anchor[1]);
        const { axis, grounded } = waterlineProfile(pixels, y);
        out.push({
            pixels,
            glow: glow && glow.w === pixels.w && glow.h === pixels.h ? glow : null,
            lamp,
            building,
            x,
            y,
            gap,
            shape: mirrorShape(pixels.h),
            sortY: frontY,
            axisAt: sx => axis[sx],
            groundedAt: sx => grounded[sx] === 1,
        });
    }
    const foliage = renderer.foliageRenderer;
    for (const sprite of renderer.treePropSprites || []) {
        if (!near(sprite.x, sprite.y)) continue;
        const frame = foliage?._frame?.(sprite.tree, 0);
        const pixels = imagePixels(frame?.canvas, cache);
        if (!pixels) continue;
        const baseY = Math.round(sprite.y);
        out.push({
            pixels,
            glow: null,
            x: Math.round(sprite.x) - frame.anchorX,
            y: baseY - frame.anchorY,
            shape: mirrorShape(frame.anchorY),
            sortY: baseY,
            axisAt: () => baseY,
            groundedAt: ALWAYS_GROUNDED,
        });
    }
    for (const sprite of [...(renderer.boulderPropSprites || []), ...(renderer.districtPropSprites || [])]) {
        // A bridge's near-rail slices redraw the bridge sprite, mirrored whole below.
        if (String(sprite.id || '').startsWith('bridge.rail.')) continue;
        if (!near(sprite.x, sprite.y)) continue;
        const cached = sprite._getCachedCanvas?.();
        const pixels = imagePixels(cached?.canvas, cache);
        if (!pixels) continue;
        const baseY = Math.round(sprite.y);
        out.push({
            pixels,
            glow: null,
            x: cached.x,
            y: cached.y,
            shape: mirrorShape(baseY - cached.y),
            sortY: baseY,
            axisAt: () => baseY,
            groundedAt: ALWAYS_GROUNDED,
        });
    }
    // Landmark bridges (painted into the terrain bake): the span's sprite,
    // each column about its own waterline, so the arch meets its mirror at
    // the water. `structure` marks its texels as covering the water.
    for (const span of renderer.bridgeSpans || []) {
        const placement = renderer._bridgeSpritePlacement?.(span);
        const pixels = imagePixels(placement?.img, cache);
        if (!pixels || pixels.w !== placement.dims?.w || pixels.h !== placement.dims?.h) continue;
        const { axis, grounded } = waterlineProfile(pixels, placement.y);
        out.push({
            pixels,
            glow: null,
            x: placement.x,
            y: placement.y,
            shape: mirrorShape(pixels.h),
            sortY: placement.y + pixels.h,
            structure: true,
            axisAt: sx => axis[sx],
            groundedAt: sx => grounded[sx] === 1,
        });
    }
    // Far first, so a nearer object's reflection overwrites a farther one's.
    return out.sort((a, b) => a.sortY - b.sortY);
}

function staticReflections(ctx, renderer) {
    const bake = renderer._coastBake;
    const coast = bake?.coast;
    const baked = coast?.baked;
    if (!baked) return;
    coast.baked = null;
    const transform = ctx.getTransform?.();
    if (!transform || transform.a !== 1 || transform.d !== 1 || !Number.isInteger(transform.e) || !Number.isInteger(transform.f)) return;
    const field = getCoastField(renderer);
    const { w, h, role } = baked;
    const px = coast.x + transform.e;
    const py = coast.y + transform.f;
    const image = ctx.getImageData(px, py, w, h);
    const data = image.data;
    // 3.1 palette truth: a translucent overlay the terrain bake laid over the
    // water after the coast stage (a building foundation's faint fill, a
    // threshold wash) tints a stop a few levels off the palette, so the
    // resident cycle never matches it and it reads as a static band (the
    // Forge front). Anything that light is no structure (coveredBy's rule):
    // the texel takes its exact baked colour back.
    const bakedData = baked.data;
    for (let at = 0; at < w * h; at++) {
        const kind = role[at];
        if (kind < CLASS_FOAM || kind >= TEXEL_OPEN) continue;
        const o = at * 4;
        const diff = Math.abs(data[o] - bakedData[o]) + Math.abs(data[o + 1] - bakedData[o + 1]) + Math.abs(data[o + 2] - bakedData[o + 2]);
        if (diff > 0 && diff < 24) {
            data[o] = bakedData[o];
            data[o + 1] = bakedData[o + 1];
            data[o + 2] = bakedData[o + 2];
        }
    }
    const buf = { data, w, h, x: coast.x, y: coast.y, role };
    // The coast pass's roles, before any mirror texel replaced them.
    const role0 = role.slice();
    const { cols, depth } = coast;
    const sources = reflectionSources(renderer, field);
    // The texels of the structure sprites the terrain bake painted (the
    // landmark bridges, arch shadows included), mirrored by the sprite pass.
    const structure = new Uint8Array(w * h);
    for (const source of sources) {
        if (!source.structure) continue;
        const { pixels } = source;
        for (let sy = 0; sy < pixels.h; sy++) {
            for (let sx = 0; sx < pixels.w; sx++) {
                if (pixels.data[(sy * pixels.w + sx) * 4 + 3] < 128) continue;
                const at = bufferIndex(buf, source.x + sx, source.y + sy);
                if (at >= 0) structure[at] = 1;
            }
        }
    }
    // Any water the coast pass painted (foam and surf included) or left to
    // the open sea.
    const waterKind = at => role0[at] === TEXEL_OPEN || (role0[at] >= CLASS_FOAM && role0[at] < TEXEL_OPEN);
    // A dock, pier, bridge or foundation the terrain bake painted over it.
    const covered = at => structure[at] === 1 || (role[at] !== TEXEL_MIRROR
        && (role0[at] === TEXEL_OPEN ? data[at * 4 + 3] !== 0 : coveredBy(data, bakedData, at * 4)));
    const surf = (at, x, y) => role0[at] === CLASS_FOAM
        || depth[((y - coast.y) >> 1) * cols + ((x - coast.x) >> 1)] < MIRROR_SURF_SD;
    // Lit accents: `accentAt[at]` is the index of the accent a texel holds
    // (-1 none), so a nearer mirror written over it retires it.
    const accents = [];
    const accentAt = new Int32Array(w * h).fill(-1);
    // Paint one mirror texel over its water stop (under the value floor).
    // Returns the stop's colour.
    const write = (x, y, at, src, glowing, course, alphaScale = 1, drop = MIRROR_STOP_DROP.far) => {
        const open = role0[at] === TEXEL_OPEN;
        const stop = open ? openSeaStopAt(openSeaDepthAt(x, y), bayer(x, y)) : Math.max(0, role0[at] - CLASS_WATER);
        const base = open ? COAST_WATER_STOPS[stop] : readRgb(bakedData, at * 4);
        const alpha = STATIC_REFLECTION_ALPHAS[course] * alphaScale;
        let rgb = staticMirrorRgb(base, src, alpha, glowing);
        if (!glowing) rgb = mirrorFloor(rgb, base, stop, drop, alpha);
        putRgb(data, at * 4, rgb);
        role[at] = TEXEL_MIRROR;
        accentAt[at] = -1;
        markCell(coast, x, y, { water: true, reflect: course + 1 });
        markMirrorBase(coast, w, at, stop);
        return base;
    };
    // Walk one world column down from its waterline row `base`: land and
    // surf before the water count against `gap`; a dock or pier over the
    // water and the surf after it are skipped (they stay on top); land after
    // the water began ends the mirror. Courses, reach and the tail fade count
    // from `base` (d), never from where the water begins, so two columns
    // with different beach widths meet on one course seam; the ripple rows
    // count from the water (`wet`). `sample(d, y, shift)` gives the source
    // texel `[rgb, lit, emitter]` mirrored into row `base + d`, `shift`
    // columns over (the ripple and the course's streak run), or null. Each
    // hit goes to `stage(x, y, at, hit, course, d, wet, keep, broken)`, `keep` false
    // on a broken ripple row or the tail's dither (`broken`: the ripple row
    // alone, which a tall mirror's core may keep).
    const walk = (wx, base, gap, shape, sample, stage) => {
        const { reach, tall } = shape;
        const every = rippleEvery(shape);
        const amp = tall >= 0.5 ? 2 : 1;
        let waterline = -1;
        for (let d = 0; d < reach; d++) {
            const y = base + d;
            const at = bufferIndex(buf, wx, y);
            if (at < 0) break;
            if (!waterKind(at)) {
                if (waterline >= 0 || d > gap) break;
                continue;
            }
            if (covered(at) || surf(at, wx, y)) {
                if (waterline < 0 && d > gap) break;
                continue;
            }
            if (waterline < 0) waterline = d;
            const wet = d - waterline;
            const course = mirrorCourse(d, reach);
            const shift = (wet >= MIRROR_CRISP_ROWS ? rippleShift(y, course > 0 ? amp : 1) : 0) - streakOffset(wx, y, course);
            const hit = sample(d, y, shift);
            if (!hit) continue;
            const fade = d - (reach - MIRROR_FADE_ROWS);
            const broken = brokenRow(wx, y, wet, every, MIRROR_BREAK_SHARE);
            const faded = fade > 0 && bayer(wx, y) < fade / MIRROR_FADE_ROWS;
            stage(wx, y, at, hit, course, d, wet, !broken && !faded, broken && !faded);
        }
    };
    // Other terrain-painted structures over water (docks, causeways,
    // foundations): each column's covered run mirrors about its foot into
    // the water under it.
    const dockShape = { reach: MIRROR_REACH_MIN, squash: 1, tall: 0 };
    const writeNow = (x, y, at, hit, course, d, wet, keep) => {
        if (keep) write(x, y, at, hit[0], hit[1], course, 1, wet < MIRROR_REACH_MIN * MIRROR_NEAR_SHARE ? MIRROR_STOP_DROP.near : MIRROR_STOP_DROP.far);
    };
    for (let i = 0; i < w; i++) {
        let run = 0;
        for (let j = 0; j < h; j++) {
            const at = j * w + i;
            if (structure[at]) {
                run = 0;
                continue;
            }
            if (waterKind(at) && role0[at] !== TEXEL_OPEN && covered(at)) {
                run += 1;
                continue;
            }
            if (run > 0) {
                const top = j - run;
                walk(coast.x + i, coast.y + j, REFLECTION_LAND_GAP, dockShape, (d, y, shift) => {
                    if (d >= run) return null;
                    const si = Math.max(0, Math.min(w - 1, i + shift));
                    const sj = j - 1 - d;
                    if (sj < top) return null;
                    const sat = sj * w + si;
                    if (!covered(sat)) return null;
                    const src = readRgb(data, sat * 4);
                    return [src, hotTexel(src), null];
                }, writeNow);
            }
            run = 0;
        }
    }
    // Sprites, each column about its own waterline, staged per source so
    // only the pieces joined to its grounded waterline land.
    const slot = new Int32Array(w * h).fill(-1);
    for (const source of sources) {
        const { pixels, glow, lamp, shape } = source;
        const gap = source.gap ?? REFLECTION_LAND_GAP;
        const every = rippleEvery(shape);
        const staged = [];
        const rows = new Map();
        // A tower mirrors its mass: each mirror row averages the source rows
        // it squashes (massRgb), so brick courses never alias into streaks.
        const tower = shape.tall >= MIRROR_CORE_TALL;
        const massRows = Math.max(1, Math.round(shape.squash));
        for (let sx = 0; sx < pixels.w; sx++) {
            const base = source.axisAt(sx);
            if (base == null || base <= source.y) continue;
            const grounded = source.groundedAt(sx);
            walk(source.x + sx, base, gap, shape, (d, y, shift) => {
                const sy = base - 1 - Math.round(d * shape.squash) - source.y;
                if (sy < 0 || sy >= pixels.h) return null;
                const tx = Math.max(0, Math.min(pixels.w - 1, sx + shift));
                const o = (sy * pixels.w + tx) * 4;
                if (pixels.data[o + 3] < 128) return null;
                // The Pharos lamp (a fixture layer): a lit accent at the lamp's gate.
                if (lamp?.[sy * pixels.w + tx]) return [readRgb(pixels.data, o), true, { lamp: true }];
                const src = tower ? massRgb(pixels, tx, sy, massRows) : readRgb(pixels.data, o);
                const emission = glow ? glow.data[o + 3] : 0;
                const lit = glow ? emission >= MIRROR_EMISSIVE_ALPHA : hotTexel(src);
                return [src, lit, lit && glow ? { sx: tx, sy, o, emission } : null];
            }, (x, y, at, hit, course, d, wet, keep, broken) => {
                slot[at] = staged.length;
                if (!rows.has(y)) rows.set(y, []);
                rows.get(y).push(staged.length);
                staged.push({ x, y, at, hit, course, d, wet, keep, broken, core: false, seed: grounded && wet < MIRROR_CRISP_ROWS });
            });
        }
        // The edge dither on every row run of this mirror (its columns come
        // in order): a run wider than MIRROR_EDGE_MIN_RUN dithers out its
        // last columns on the Bayer order, the run's end wandering a texel
        // per two-row band, and a tall mirror's taper eats further into its
        // edges with distance. Narrow runs (posts, piles) stay crisp. A tall
        // mirror's texels inside the edges are its core (see above).
        for (const list of rows.values()) {
            let start = 0;
            while (start < list.length) {
                let end = start;
                while (end + 1 < list.length && staged[list[end + 1]].x === staged[list[end]].x + 1) end += 1;
                const run = end - start + 1;
                const cols = Math.max(0, Math.min(MIRROR_EDGE_COLS, Math.floor((run - MIRROR_EDGE_MIN_RUN) / 4)));
                for (let n = start; n <= end; n++) {
                    const texel = staged[list[n]];
                    // A tower's narrow runs (its lantern posts, the finial) stay crisp.
                    const taper = tower && run < MIRROR_EDGE_MIN_RUN ? 0
                        : Math.min(Math.floor(texel.d * shape.tall * MIRROR_TAPER), Math.floor(run * MIRROR_TAPER_SHARE));
                    const span = Math.max(cols, taper > 0 ? MIRROR_EDGE_COLS : 0);
                    const inset = Math.min(n - start, end - n) - taper + Math.floor(hash2(texel.y >> 1, 0, 53) * 3) - 1;
                    if (!span || inset >= span) {
                        texel.core = tower;
                        continue;
                    }
                    if (inset < 0 || bayer(texel.x, texel.y) >= (inset + 1) / (span + 1)) texel.keep = false;
                }
                start = end + 1;
            }
        }
        for (const texel of staged) {
            if (texel.core && texel.broken && !brokenRow(texel.x, texel.y, texel.wet, every, MIRROR_CORE_BREAK_SHARE)) texel.keep = true;
        }
        // The pieces joined (8-connected, dropped texels included) to a
        // grounded waterline row.
        const joined = new Uint8Array(staged.length);
        const queue = [];
        for (let k = 0; k < staged.length; k++) {
            if (staged[k].seed) {
                joined[k] = 1;
                queue.push(k);
            }
        }
        while (queue.length) {
            const { x, y } = staged[queue.pop()];
            for (let dy = -1; dy <= 1; dy++) {
                for (let dx = -1; dx <= 1; dx++) {
                    const at = bufferIndex(buf, x + dx, y + dy);
                    const k = at >= 0 ? slot[at] : -1;
                    if (k < 0 || joined[k]) continue;
                    joined[k] = 1;
                    queue.push(k);
                }
            }
        }
        const alphaScale = 1 - MIRROR_TALL_LIGHTEN * shape.tall;
        const coreScale = 1 - MIRROR_CORE_LIGHTEN * shape.tall;
        for (let k = 0; k < staged.length; k++) {
            const { x, y, at, hit, course, wet, keep, core } = staged[k];
            slot[at] = -1;
            if (!keep || !joined[k]) continue;
            // The core keeps the middle course's alpha and the near value
            // range to the end of its reach (the shaft stays one mass).
            const drop = core || wet < shape.reach * MIRROR_NEAR_SHARE ? MIRROR_STOP_DROP.near : MIRROR_STOP_DROP.far;
            const base = write(x, y, at, hit[0], hit[1] && !glow && !lamp, core ? Math.min(course, MIRROR_CORE_COURSE) : course,
                core ? coreScale : alphaScale, drop);
            const emitter = hit[2];
            if (!emitter || !source.building) continue;
            // The lit lamp: its own flame colour. A lit window: its albedo
            // plus the scene pass's emission.
            const lit = emitter.lamp
                ? hit[0].map(c => c * MIRROR_ACCENT_VALUE)
                : [0, 1, 2].map(c => Math.min(255, (hit[0][c] + ((0.84 * emitter.emission) / 255) * glow.data[emitter.o + c]) * MIRROR_ACCENT_VALUE));
            accentAt[at] = accents.length;
            accents.push({ building: source.building, at, x, y, sx: emitter.sx, sy: emitter.sy, lamp: emitter.lamp === true, rgb: mixRgb(base, lit, MIRROR_LIT_ALPHA) });
        }
    }
    // The accents still standing, per landmark.
    const byBuilding = new Map();
    for (let k = 0; k < accents.length; k++) {
        const accent = accents[k];
        if (accentAt[accent.at] !== k) continue;
        let list = byBuilding.get(accent.building);
        if (!list) byBuilding.set(accent.building, list = []);
        list.push(accent);
    }
    coast.mirrorAccents = [...byBuilding].map(([building, texels]) => ({ building, type: building.type, texels }));
    // (For 2.9's ground casts) water cells a dock, pier deck, bridge span or
    // foundation covers.
    for (let at = 0; at < w * h; at++) {
        if (!(waterKind(at) && covered(at))) continue;
        const x = coast.x + (at % w);
        const y = coast.y + Math.floor(at / w);
        coast.covered ||= new Uint8Array(coast.classes.length);
        coast.covered[((y - coast.y) >> 1) * cols + ((x - coast.x) >> 1)] = 1;
    }
    ctx.putImageData(image, px, py);
}

// ---------------------------------------------------------------------------
// 3.7 lit mirror accents at runtime

const NO_ACCENT_LAYERS = Object.freeze([]);
// The accent group of a landmark's lamp (withLampLayers): the Pharos lamp.
const MIRROR_LAMP_GROUP = -2;

/**
 * The bake's lit mirror accents cut per landmark and 6.3 glass group:
 * `[{ building, type, group, canvas, emissive, x, y, w, h, key }]` (world px;
 * `canvas` the accents' lit colours, `emissive` an all-emitter sidecar with
 * no emission of its own). Group k >= 1 is room k - 1 (hall panes, group 0,
 * never light); -1 is off-glass (a lantern, the hearth); MIRROR_LAMP_GROUP
 * the Lighthouse lamp. Built once the landmarks' glass maps have loaded;
 * empty without accents.
 */
export function mirrorAccentLayers(renderer) {
    const accents = renderer?._coastBake?.coast?.mirrorAccents;
    if (!accents?.length || typeof document === 'undefined') return NO_ACCENT_LAYERS;
    const cached = renderer._mirrorAccentLayers;
    if (cached?.accents === accents && cached.complete) return cached.layers;
    const glass = renderer.buildingRenderer?.roomGlass || null;
    const layers = [];
    let complete = true;
    for (const { building, type, texels } of accents) {
        const map = glass?.map?.(type) || null;
        if (!map && glass && !glass.resolved(type)) {
            complete = false;
            continue;
        }
        const groups = new Map();
        for (const texel of texels) {
            const gx = texel.sx - (map?.left ?? 0);
            const gy = texel.sy - (map?.top ?? 0);
            const group = texel.lamp ? MIRROR_LAMP_GROUP
                : map && gx >= 0 && gy >= 0 && gx < map.w && gy < map.h ? map.group[gy * map.w + gx] : -1;
            if (group === 0) continue;
            if (!groups.has(group)) groups.set(group, []);
            groups.get(group).push(texel);
        }
        for (const [group, list] of groups) {
            let x0 = Infinity;
            let y0 = Infinity;
            let x1 = -Infinity;
            let y1 = -Infinity;
            for (const t of list) {
                x0 = Math.min(x0, t.x);
                y0 = Math.min(y0, t.y);
                x1 = Math.max(x1, t.x);
                y1 = Math.max(y1, t.y);
            }
            const lw = x1 - x0 + 1;
            const lh = y1 - y0 + 1;
            const canvas = document.createElement('canvas');
            const emissive = document.createElement('canvas');
            canvas.width = emissive.width = lw;
            canvas.height = emissive.height = lh;
            const albedo = new ImageData(lw, lh);
            const glow = new ImageData(lw, lh);
            for (const t of list) {
                const o = ((t.y - y0) * lw + t.x - x0) * 4;
                albedo.data[o] = t.rgb[0];
                albedo.data[o + 1] = t.rgb[1];
                albedo.data[o + 2] = t.rgb[2];
                albedo.data[o + 3] = 255;
                glow.data[o + 3] = 128;
            }
            canvas.getContext('2d').putImageData(albedo, 0, 0);
            emissive.getContext('2d').putImageData(glow, 0, 0);
            layers.push({ building, type, group, canvas, emissive, x: x0, y: y0, w: lw, h: lh, key: `mirror-accent:${type}:${group}` });
        }
    }
    renderer._mirrorAccentLayers = { accents, layers, complete };
    return layers;
}

/**
 * A mirror accent layer's lit share now: its room's gate (BuildingSprite
 * `roomGate`, a dark room lights nothing), off-glass the landmark's night
 * shift at night (as 2.4's aperture lights), the Lighthouse lamp exactly
 * while its water column burns (`lighthouseColumnSource`, the clock's lamp
 * course: a safety light, never work), 0 while the rain breaks the mirrors
 * (`mirrorStormDrop`).
 */
export function mirrorAccentGate(renderer, layer, atmosphere) {
    if (mirrorStormDrop(atmosphere?.weather) > 0) return 0;
    const buildings = renderer?.buildingRenderer;
    if (!buildings) return 0;
    const gate = layer.group === MIRROR_LAMP_GROUP
        ? (buildings.lighthouseColumnSource?.() ? 1 : 0)
        : layer.group > 0
            ? buildings.roomGate?.(layer.type, layer.group - 1)
            : (buildings._nightShiftLit?.(layer.type) || 0) * (buildings._nightWindowGate?.() || 0);
    return Math.max(0, Math.min(1, Number(gate) || 0));
}

/**
 * Register the coast bake on a renderer. The 'coast' pass paints wet sand,
 * foam and every water texel over the ground bake, then the shoreline mass;
 * the 'finish' pass (after bridges, foundations and ground props) bakes the
 * static reflections and the resident water fields.
 */
export function registerCoastBake(renderer) {
    const offCoast = renderer.registerTerrainBakePass({
        id: 'coast-field',
        stage: 'coast',
        revision: r => coastFieldKey(r),
        draw(ctx, r) {
            const started = performance.now();
            const field = getCoastField(r);
            const coast = classifyCoast(r, field);
            if (coast) paintCoast(ctx, coast, field, r);
            r._coastBake = {
                coast,
                fieldMs: field.buildMs,
                bakeMs: performance.now() - started,
                key: coastFieldKey(r),
                waterFields: null,
            };
            r._coastMoodLayer = null;
        },
    });
    const offReflections = renderer.registerTerrainBakePass({
        id: 'coast-reflections',
        stage: 'finish',
        // Tree frames and building sheets load after the first bake: the
        // reflections rebake once they can be read.
        revision: r => reflectionSourcesKey(r),
        draw(ctx, r) {
            const bake = r._coastBake;
            if (!bake?.coast) return;
            const started = performance.now();
            staticReflections(ctx, r);
            bake.reflectMs = performance.now() - started;
            // 3.1 + 3.6 — the resident water fields (units 7 and 8), after
            // every reflection and cliff decision.
            bake.waterFields = bakeWaterFields(r, bake.coast, getCoastField(r));
        },
    });
    return () => {
        offCoast();
        offReflections();
    };
}

function reflectionSourcesKey(renderer) {
    const trees = renderer.treePropSprites?.length && renderer.foliageRenderer?._frame?.(renderer.treePropSprites[0].tree, 0) ? 1 : 0;
    let buildings = 0;
    let glows = 0;
    let lamps = 0;
    for (const building of renderer.world?.buildings?.values?.() || []) {
        const entry = renderer.assets?.getEntry?.(`building.${building.type}`);
        const id = entry?.id || `building.${building.type}`;
        if (renderer.assets?.get?.(id)) buildings += 1;
        if (renderer.assets && emissiveSidecarFor(renderer.assets, id)) glows += 1;
        for (const [name, layer] of Object.entries(entry?.layers || {})) {
            if (layer?.fixture === true && !layer.cycle && renderer.assets.get(`${id}.${name}`)) lamps += 1;
        }
    }
    return `${trees}:${buildings}:${glows}:${lamps}`;
}

// ---------------------------------------------------------------------------
// Resident water fields (3.1 cycle offset, 3.6 coast field)
//
// Both live on the coast lattice (one texel per 2x2 world-px cell, origin
// `coast.x/y`) and upload once per coast bake through the V9 typed path.
//
// Cycle offset (R8, unit 7): 0..15 = shoreward swell band (the lit band
// marches one band toward the waterline per 250 ms step), 16..31 = river
// current band (marches downstream), 255 = no near-shore cycle (the deep-sea
// phase field takes over on deep stops).
//
// Coast field (RG8 on the CPU, `coastField`): R = signed distance,
// `round(sd * 64) + 128` clamped to a byte (tiles, > 0 water); G =
// COAST_FIELD_FLAGS bits. 3.7 — `mirrorStops` (two bytes a cell) holds the
// water stop each of the cell's four texels was painted over when a mirror
// replaced it (`coast.mirrorBase`), one nibble a texel (stop + 1, 0 none):
// byte 0 the cell's top row, byte 1 its bottom row, low nibble the left
// texel. Only an uncovered water cell's mirror texels carry one (the rain
// gives exactly those back to the water). The GPU uploads both as one RGBA8
// texture (`coastFieldTexels`, unit 8: RG the field, BA the mirror stops).

const CYCLE_NONE = 255;
const CYCLE_MIN_SD = FOAM_BAND;
const CYCLE_MAX_SD = 2.2;
const CYCLE_BANDS_PER_TILE = 9;
const CYCLE_JITTER = 1.2;
const CYCLE_CURRENT_GROUP = 16;
const COAST_SD_SCALE = 64;
const COAST_SD_BIAS = 128;
// The swash may draw from this far up the beach to this far out to sea.
const SWASH_LAND_SD = -0.35;
const SWASH_WATER_SD = 0.3;

export const COAST_FIELD_FLAGS = Object.freeze({
    reflection: 1,
    swash: 2,
    water: 4,
    wetSand: 8,
    // 3.3 (a) — the sea's own water (sea and Harbor bodies and the outer
    // shelf; never a lagoon, pond or river), where the swell caps may lie.
    sea: 16,
    // A water cell the terrain bake covered with a dock, pier deck, bridge
    // span or foundation (staticReflections' `covered`): land for 2.9 casts.
    covered: 64,
});

// Authored river axes (tile coords) with each segment's arc length from the
// river's source, chained across polylines that share an end point, so the
// current's offset never jumps where two strokes meet.
function riverAxes() {
    const segments = [];
    const ends = [];
    for (const line of WATER_POLYLINES) {
        if (line.region !== 'river' || !Array.isArray(line.points) || line.points.length < 2) continue;
        const [x0, y0] = line.points[0];
        let s = ends.find(end => end.x === x0 && end.y === y0)?.s ?? 0;
        for (let k = 1; k < line.points.length; k++) {
            const [ax, ay] = line.points[k - 1];
            const [bx, by] = line.points[k];
            const length = Math.hypot(bx - ax, by - ay);
            if (length > 0) segments.push({ ax, ay, dx: bx - ax, dy: by - ay, length, s, reach: line.width + 0.3 });
            s += length;
        }
        const [xe, ye] = line.points[line.points.length - 1];
        ends.push({ x: xe, y: ye, s });
    }
    return segments;
}

// Arc length along the nearest river axis within reach of (u, v), or null.
function riverArcAt(axes, u, v) {
    let best = null;
    let bestDistance = Infinity;
    for (const seg of axes) {
        const t = Math.max(0, Math.min(1, ((u - seg.ax) * seg.dx + (v - seg.ay) * seg.dy) / (seg.length * seg.length)));
        const distance = Math.hypot(u - seg.ax - seg.dx * t, v - seg.ay - seg.dy * t);
        if (distance > seg.reach || distance >= bestDistance) continue;
        bestDistance = distance;
        best = seg.s + t * seg.length;
    }
    return best;
}

function bakeWaterFields(renderer, coast, field) {
    const started = performance.now();
    const { cols, rows, classes, depth } = coast;
    const reflect = coast.reflect || null;
    const cycleOffset = new Uint8Array(cols * rows).fill(CYCLE_NONE);
    const coastField = new Uint8Array(cols * rows * 2);
    const mirrorStops = new Uint8Array(cols * rows * 2);
    const mirrorBase = coast.mirrorBase || null;
    const texelW = cols * 2;
    // Per-tile lookups, once: river channel tiles and tiles the swash never
    // touches (building footprints, bridges).
    const tileRiver = new Uint8Array(MAP_SIZE * MAP_SIZE);
    const tileBlocked = new Uint8Array(MAP_SIZE * MAP_SIZE);
    const footprints = buildingFootprintKeys(renderer);
    for (let ty = 0; ty < MAP_SIZE; ty++) {
        for (let tx = 0; tx < MAP_SIZE; tx++) {
            const key = `${tx},${ty}`;
            const index = ty * MAP_SIZE + tx;
            tileRiver[index] = isVisualWater(renderer, key) && regionAt(renderer, key) === 'river' ? 1 : 0;
            tileBlocked[index] = footprints.has(key) || renderer.bridgeTiles?.has?.(key) ? 1 : 0;
        }
    }
    const axes = riverAxes();
    const i0 = coast.x >> 1;
    const j0 = coast.y >> 1;
    for (let r = 0; r < rows; r++) {
        const wy = coast.y + r * 2 + 1;
        for (let c = 0; c < cols; c++) {
            const wx = coast.x + c * 2 + 1;
            const cell = r * cols + c;
            const u = wy / TILE_HEIGHT + wx / TILE_WIDTH;
            const v = wy / TILE_HEIGHT - wx / TILE_WIDTH;
            const cls = classes[cell];
            const sd = cls !== CLASS_NONE ? depth[cell] : field.signedDistance(u, v);
            let flags = 0;
            if (reflect?.[cell] > 0) flags |= COAST_FIELD_FLAGS.reflection;
            if (coast.covered?.[cell]) flags |= COAST_FIELD_FLAGS.covered;
            if (cls >= CLASS_FOAM) flags |= COAST_FIELD_FLAGS.water;
            if (cls === CLASS_WET) flags |= COAST_FIELD_FLAGS.wetSand;
            const inMap = u >= -0.5 && v >= -0.5 && u <= MAP_SIZE - 0.5 && v <= MAP_SIZE - 0.5;
            const tx = Math.min(MAP_SIZE - 1, Math.max(0, Math.floor(u + 0.5)));
            const ty = Math.min(MAP_SIZE - 1, Math.max(0, Math.floor(v + 0.5)));
            const tile = ty * MAP_SIZE + tx;
            // Breaker-eligible: sea, harbor and lagoon shores (a river keeps
            // its current, never surf; caps: river 2, lagoon 3, sea 4).
            if (inMap && sd > SWASH_LAND_SD && sd < SWASH_WATER_SD && !tileBlocked[tile]
                && field.caps[tile] > 2
                && (sd > 0 || !landPaved(renderer, wx, wy, tx, ty))) {
                flags |= COAST_FIELD_FLAGS.swash;
            }
            if (cls >= CLASS_WATER && (!inMap || field.caps[tile] > 3)) flags |= COAST_FIELD_FLAGS.sea;
            coastField[cell * 2] = Math.max(0, Math.min(255, Math.round(sd * COAST_SD_SCALE) + COAST_SD_BIAS));
            coastField[cell * 2 + 1] = flags;
            if (mirrorBase && reflect?.[cell] > 0 && cls >= CLASS_WATER && !coast.covered?.[cell]) {
                for (let oy = 0; oy < 2; oy++) {
                    const at = (r * 2 + oy) * texelW + c * 2;
                    mirrorStops[cell * 2 + oy] = Math.min(15, mirrorBase[at]) | (Math.min(15, mirrorBase[at + 1]) << 4);
                }
            }
            if (cls < CLASS_WATER || sd <= CYCLE_MIN_SD) continue;
            const jitter = hash2(i0 + c, j0 + r, 223) * CYCLE_JITTER;
            const arc = inMap && tileRiver[tile] ? riverArcAt(axes, u, v) : null;
            if (arc != null) {
                const band = Math.floor(-arc * CYCLE_BANDS_PER_TILE + jitter);
                cycleOffset[cell] = CYCLE_CURRENT_GROUP + (((band % 16) + 16) % 16);
            } else if (sd < CYCLE_MAX_SD) {
                cycleOffset[cell] = Math.floor(sd * CYCLE_BANDS_PER_TILE + jitter) % 16;
            }
        }
    }
    return {
        key: coastFieldKey(renderer),
        revision: `${coastFieldKey(renderer)}:${cols}x${rows}:${performance.now().toFixed(0)}`,
        x: coast.x,
        y: coast.y,
        cols,
        rows,
        cycleOffset,
        coastField,
        mirrorStops,
        bakeMs: performance.now() - started,
    };
}

/**
 * The resident coast field texture (unit 8, RGBA8, one texel a coast cell):
 * RG = `coastField`, BA = `mirrorStops`. Built once per water-field bake.
 */
export function coastFieldTexels(fields) {
    if (fields.texels) return fields.texels;
    const n = fields.cols * fields.rows;
    const out = new Uint8Array(n * 4);
    for (let k = 0; k < n; k++) {
        out[k * 4] = fields.coastField[k * 2];
        out[k * 4 + 1] = fields.coastField[k * 2 + 1];
        out[k * 4 + 2] = fields.mirrorStops[k * 2];
        out[k * 4 + 3] = fields.mirrorStops[k * 2 + 1];
    }
    fields.texels = out;
    return out;
}

// ---------------------------------------------------------------------------
// Water mood (night / storm) shared by the GPU shader, Canvas and the ocean

/**
 * `{ night, storm }` in 0..1, quantized to 1/8 so consumers can bucket. Night
 * pulls water below lit ground in value and toward a cool grey; storm reads
 * grey-green. Both are observed atmosphere state, never agent state.
 */
export function waterMoodFor(atmosphere) {
    const grade = atmosphere?.lightGrade || null;
    const weather = atmosphere?.weather || null;
    // The grade's night weight lingers at ~0.1 through sunrise (06:00) and
    // the morning; water leaves its night mood below this floor, so the
    // dawn sea takes the sunrise key instead of staying night-dark.
    const rawNight = Math.max(0, Math.min(1, Number(grade?.night) || 0));
    const night = Math.max(0, (rawNight - WATER_NIGHT_FLOOR) / (1 - WATER_NIGHT_FLOOR));
    const type = weather?.type || 'clear';
    const intensity = Math.max(0, Math.min(1, Number(weather?.intensity) || 0));
    const storm = type === 'storm' ? 0.6 + 0.4 * intensity : type === 'rain' ? 0.45 * intensity : 0;
    return {
        night: Math.round(night * 8) / 8,
        storm: Math.round(storm * 8) / 8,
    };
}

// CPU mirror of the GLSL `applyWaterMood` in GpuWorldRenderer (0..1 channels).
export function applyWaterMood(rgb, mood) {
    let [r, g, b] = rgb;
    const night = mood?.night || 0;
    const storm = mood?.storm || 0;
    if (storm > 0) {
        const l = r * 0.2126 + g * 0.7152 + b * 0.0722;
        const k = storm * 0.72;
        r += (l * 0.90 - r) * k;
        g += (l * 1.04 - g) * k;
        b += (l * 0.97 - b) * k;
    }
    if (night > 0) {
        const l = r * 0.2126 + g * 0.7152 + b * 0.0722;
        const k = night * 0.55;
        const scale = 1 - night * 0.2;
        r += (l * 0.78 - r) * k; r *= scale;
        g += (l * 0.94 - g) * k; g *= scale;
        b += (l * 1.10 - b) * k; b *= scale;
    }
    return [Math.max(0, Math.min(1, r)), Math.max(0, Math.min(1, g)), Math.max(0, Math.min(1, b))];
}

// The resident water surface after its mood (GLSL `WATER_CAST` and the sun
// band water takes in `applyAuthoredSunBand` / `shadeOpenSea`: x0.86 at full
// band), quantized to 1/16 of the band so the Canvas layers rebake rarely.
export const WATER_CAST = Object.freeze([0.94, 0.98, 1.03]);
export const WATER_SUN_BAND = 0.86;
export function waterSunBandFor(atmosphere) {
    return Math.round(Math.max(0, Math.min(1, Number(atmosphere?.lightGrade?.sunBand) || 0)) * 16) / 16;
}

/** Canvas: the resident water colour before the grade (mood, cast, band). */
export function waterSurfaceRgb(rgb, mood, sunBand = 0) {
    const moody = applyWaterMood(rgb, mood);
    const band = 1 + (WATER_SUN_BAND - 1) * sunBand;
    return moody.map((channel, index) => Math.max(0, Math.min(1, channel * WATER_CAST[index] * band)));
}

// A mood-layer colour flag (above the 24 RGB bits): a 3.7 mirror texel.
const MIRROR_UNCAPPED = 1 << 24;
// The water stops as 0xRRGGBB, to recognise a stop texel by its colour.
const STOP_INTS = COAST_WATER_STOPS.map(rgb => (rgb[0] << 16) | (rgb[1] << 8) | rgb[2]);
const STOP_COLOURS = new Set(STOP_INTS);

function wateryPixel(r, g, b) {
    // Water stops are all blue/teal-dominant; sand, foam, timber and stone
    // are not. Keeps docks, piers and shore props out of the mood recolour.
    return b >= r + 6 && g >= r;
}

/**
 * Canvas and hybrid PostFx: draw a recoloured copy of the baked water over
 * the terrain: the night/storm mood, the resident water cast and sun band
 * (`waterSurfaceRgb`), then V6's water saturation cap moved in front of the
 * grade that runs over the finished frame (CanvasGrade
 * `canvasWaterPreimage`). The 3.7 mirror texels (warm timber, roofs) take the
 * mood uncapped, as the resident pass does. Built lazily from the terrain
 * cache and rebuilt when the mood or band bucket changes, or the grade key
 * does (at most once per OCEAN_REBAKE_MIN_MS, like the outer ocean). The
 * water's motion, path and sheen follow (CanvasWaterState).
 */
export function drawCanvasWaterMood(ctx, renderer, atmosphere) {
    drawCanvasMoodLayer(ctx, renderer, atmosphere);
}

function drawCanvasMoodLayer(ctx, renderer, atmosphere) {
    const mood = waterMoodFor(atmosphere);
    const sunBand = waterSunBandFor(atmosphere);
    const grade = atmosphere?.lightGrade || null;
    const postFx = renderer?.postFx?.isActive?.() === true;
    const gradeKey = CanvasGrade.canvasGradeKey(grade, { postFx });
    const coast = renderer._coastBake?.coast;
    const cache = renderer.terrainCache;
    const bounds = renderer.terrainCacheBounds;
    if (!coast || !cache || !bounds) return;
    let layer = renderer._coastMoodLayer;
    if (!layer || layer.cacheKey !== renderer.terrainCacheKey) {
        const sx = coast.x - bounds.x;
        const sy = coast.y - bounds.y;
        const w = coast.cols * 2;
        const h = coast.rows * 2;
        const source = cache.getContext('2d').getImageData(sx, sy, w, h);
        const src = source.data;
        const pixels = [];
        const colours = [];
        // 3.7 — each mirror texel's water stop (-1: none, or a cell a dock
        // covers) and Bayer order, for the storm fade.
        const mirrorStops = [];
        const orders = [];
        // Mirror texels carry MIRROR_UNCAPPED: moody, never capped.
        const reflect = coast.reflect || null;
        for (let r = 0; r < coast.rows; r++) {
            for (let c = 0; c < coast.cols; c++) {
                const cell = r * coast.cols + c;
                // A handover cell the open sea claims can still paint some of
                // its texels with a stop (each texel decides on its own sd):
                // those take the mood and the cap too, or the map edge shows.
                const water = coast.classes[cell] >= CLASS_WATER;
                const mirror = water && reflect?.[cell] > 0;
                const stormable = mirror && !coast.covered?.[cell];
                for (let oy = 0; oy < 2; oy++) {
                    for (let ox = 0; ox < 2; ox++) {
                        const at = (r * 2 + oy) * w + c * 2 + ox;
                        const p = at * 4;
                        const colour = (src[p] << 16) | (src[p + 1] << 8) | src[p + 2];
                        const watery = water ? wateryPixel(src[p], src[p + 1], src[p + 2]) : src[p + 3] > 0 && STOP_COLOURS.has(colour);
                        if (!watery && !mirror) continue;
                        pixels.push(p);
                        colours.push(colour | (watery ? 0 : MIRROR_UNCAPPED));
                        const base = stormable ? (coast.mirrorBase?.[at] || 0) : 0;
                        mirrorStops.push(base - 1);
                        orders.push(Math.round(bayer(coast.x + c * 2 + ox, coast.y + r * 2 + oy) * 16));
                    }
                }
            }
        }
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        layer = renderer._coastMoodLayer = {
            cacheKey: renderer.terrainCacheKey,
            canvas,
            ctx: canvas.getContext('2d'),
            pixels: Int32Array.from(pixels),
            colours: Int32Array.from(colours),
            mirrorStops: Int8Array.from(mirrorStops),
            orders: Uint8Array.from(orders),
            moodKey: '',
            x: coast.x,
            y: coast.y,
            w,
            h,
        };
    }
    const drop = mirrorStormDrop(atmosphere?.weather);
    const moodKey = `${mood.night}:${mood.storm}:${sunBand}:${drop}`;
    const now = performance.now();
    const due = layer.moodKey !== moodKey || !(now - layer.bakedAt < OCEAN_REBAKE_MIN_MS);
    if (due && (layer.moodKey !== moodKey || layer.gradeKey !== gradeKey)) {
        const memo = new Map();
        let changed = false;
        // A texel the rain gives back to the water shows its stop.
        const colourAt = k => (drop > 0 && layer.mirrorStops[k] >= 0 && layer.orders[k] < drop * 16
            ? STOP_INTS[layer.mirrorStops[k]]
            : layer.colours[k]);
        for (let k = 0; k < layer.colours.length; k++) {
            const colour = colourAt(k);
            if (colour !== layer.colours[k]) changed = true;
            if (memo.has(colour)) continue;
            let rgb = waterSurfaceRgb([((colour >> 16) & 255) / 255, ((colour >> 8) & 255) / 255, (colour & 255) / 255], mood, sunBand);
            if (!(colour & MIRROR_UNCAPPED)) rgb = CanvasGrade.canvasWaterPreimage(rgb, grade, { postFx });
            const out = (Math.round(rgb[0] * 255) << 16) | (Math.round(rgb[1] * 255) << 8) | Math.round(rgb[2] * 255);
            memo.set(colour, out);
            if (out !== (colour & 0xffffff)) changed = true;
        }
        layer.identity = !changed;
        if (changed) {
            const image = new ImageData(layer.w, layer.h);
            const data = image.data;
            for (let k = 0; k < layer.pixels.length; k++) {
                const out = memo.get(colourAt(k));
                const p = layer.pixels[k];
                data[p] = out >> 16;
                data[p + 1] = (out >> 8) & 255;
                data[p + 2] = out & 255;
                data[p + 3] = 255;
            }
            layer.ctx.putImageData(image, 0, 0);
        }
        layer.moodKey = moodKey;
        layer.gradeKey = gradeKey;
        layer.bakedAt = now;
    }
    if (!layer.identity) ctx.drawImage(layer.canvas, layer.x, layer.y);
}

// ---------------------------------------------------------------------------
// GPU water material sidecar

/**
 * Repaint the water class of the quarter-res terrain material map from the
 * baked coast cells, so GPU water state (shimmer, night mood, reflections)
 * follows the organic shore and the outer shelf instead of the tile
 * diamonds. A block counts as water if any of its lattice cells is foam or
 * water; the shader's colour gate keeps wet-sand pixels inside such a block
 * out of the water response. Only blocks whose class is water or one of
 * `replaceableIds` (bare ground classes) change, so bridge timber and paved
 * classes keep theirs.
 */
export function paintCoastWaterMaterial(ctx, renderer, cached, scale, waterId, landId, replaceableIds = []) {
    const coast = renderer._coastBake?.coast;
    if (!coast || !cached?.bounds) return;
    const step = 1 / scale;
    const x0 = Math.max(0, Math.floor((coast.x - cached.bounds.x) * scale));
    const y0 = Math.max(0, Math.floor((coast.y - cached.bounds.y) * scale));
    const x1 = Math.min(ctx.canvas.width, Math.ceil((coast.x + coast.cols * 2 - cached.bounds.x) * scale));
    const y1 = Math.min(ctx.canvas.height, Math.ceil((coast.y + coast.rows * 2 - cached.bounds.y) * scale));
    if (x1 <= x0 || y1 <= y0) return;
    const image = ctx.getImageData(x0, y0, x1 - x0, y1 - y0);
    const data = image.data;
    const w = x1 - x0;
    const span = Math.max(1, Math.round(step / 2));
    for (let py = y0; py < y1; py++) {
        const r0 = Math.floor((cached.bounds.y + py * step - coast.y) / 2);
        for (let px = x0; px < x1; px++) {
            const o = ((py - y0) * w + (px - x0)) * 4;
            const current = data[o];
            // Unpainted blocks lie outside the map diamond: the outer shelf's
            // water claims them (so night/storm mood reach it too); anything
            // else there keeps the record's own material.
            const unpainted = data[o + 3] === 0;
            if (!unpainted && current !== waterId && !replaceableIds.includes(current)) continue;
            const c0 = Math.floor((cached.bounds.x + px * step - coast.x) / 2);
            let water = false;
            for (let dr = 0; dr < span && !water; dr++) {
                const r = r0 + dr;
                if (r < 0 || r >= coast.rows) continue;
                for (let dc = 0; dc < span; dc++) {
                    const c = c0 + dc;
                    if (c < 0 || c >= coast.cols) continue;
                    if (coast.classes[r * coast.cols + c] >= CLASS_FOAM) { water = true; break; }
                }
            }
            if (unpainted && !water) continue;
            data[o] = water ? waterId : (current === waterId ? landId : current);
            data[o + 3] = 255;
        }
    }
    ctx.putImageData(image, x0, y0);
}

// ---------------------------------------------------------------------------
// The open sea (3.3 / 3.4): the sea around the whole island, out to the horizon
//
// One grammar on both backends, on the 1-world-texel grid (C3 water addendum):
// below the horizon the sea lightens from its deepest stop (OPEN_SEA_DEEPEST,
// stop 5) to stop 2 over OPEN_SEA_LIGHT_REACH world px, every texel choosing
// its stop on a 4x4 Bayer (`openSeaStopAt`). Around the island the terrain
// bake's outer shelf deepens S2..S4 and leaves clear every texel that would be the deepest
// stop, so the handover is the same per-texel decision on both sides. The top
// rows take the sky: haze courses meeting the sky plate, then a four-course
// sky-reflection band (WS-11) whose first course continues under the haze and
// whose last dithers out into the sea; a swell mark in the band catches more
// of the sky (OPEN_SEA_BAND_MARK_LIFT). Below the band the sea body takes its
// static field (3.3 (a) `seaBodyStop`: sun-key courses and each swell set's
// lit slope and trough, down to SEA_TROUGH); swell caps, crest strokes and
// the sunlit course sit one or two stops lighter than it.
//  - WebGL: COMPOSITE_FRAGMENT shades every scene.a < 1 pixel below the
//    horizon with this grammar on the shader's clock (the body, caps,
//    crests, the sun/moon path, cloud courses, the sunlit course, cat's
//    paws, the squall), graded exactly like in-map water; the 2D backdrop
//    keeps only the sky.
//  - Canvas and hybrid PostFx: `drawOuterOcean` paints the preimage's stops,
//    haze and band with world-anchored fills; CanvasWaterState lays the body
//    field and the sunlit course per world chunk and every mark (caps,
//    crests, paws, the path) over it with `canvasSeaMarkRgb`.

const OCEAN_REBAKE_MIN_MS = 900;
// The horizon sits this many tiles above the island's north vertex, so the
// sea surrounds all four edges and no land ever stands against the sky.
const HORIZON_MARGIN_TILES = 4;

/**
 * The sea horizon in world px: four tiles above the island's north vertex.
 * SkyRenderer anchors its horizon haze band and the sun's lowest position on
 * the same line, so the sky plate only ever meets sea.
 */
export const OCEAN_HORIZON_WORLD_Y = -HALF_H - HORIZON_MARGIN_TILES * TILE_HEIGHT;

// World px below the horizon over which the open sea lightens from its
// deepest stop to stop 2 at the horizon (one stop per 90 px).
export const OPEN_SEA_LIGHT_REACH = 360;
export const OPEN_SEA_DEEPEST = OPEN_SEA_STOPS.length - 1;
// 3.3 (d) / WS-11 — the sky-reflection band under the haze courses: four
// courses mixing the sky's horizon colour into the graded sea, heavy enough
// that all four keep the golden-hour horizon's warmth (R-B > 0 over a sea
// at R-B -15) as they fade into the sea.
export const OPEN_SEA_BAND_DEPTH = 128;
export const OPEN_SEA_BAND_WEIGHTS = Object.freeze([0.60, 0.46, 0.34, 0.24]);
// The haze courses at the very top step from the sky plate's haze into the sea.
export const OPEN_SEA_HAZE_WEIGHTS = Object.freeze([1, 0.6, 0.28]);
// 3.3 (d) — the share of the band's last course over which it dithers out
// into the sea (a Bayer seam, not a hard edge), and how much more of the sky
// a swell mark (a cap, a crest) inside the band takes than its course, so the
// band carries the sea's texture as light flecks, never dark holes.
export const OPEN_SEA_BAND_TAIL = 0.45;
export const OPEN_SEA_BAND_MARK_LIFT = 0.16;
// Canvas: the band's course seams wander by up to this many whole world rows
// (the resident `seaContourRows` amplitude) on a contour periodic over the
// strip (SEA_SEAM_PERIOD), deepening from level at the haze over 96 rows.
const CANVAS_BAND_CONTOUR_ROWS = 14;
const CANVAS_BAND_CONTOUR_RAMP = 96;

function clamp01(value) {
    return Math.max(0, Math.min(1, Number(value) || 0));
}

/** Haze course depth (world px) at the horizon: 16, 20 or 24 with fog. */
export function openSeaHazeRows(fog) {
    return 16 + Math.round(clamp01(fog) * 2) * 4;
}

// 3.3 / N3 — the open sea's stop seams wander instead of running as ruled
// horizontal lines: each seam band (SEA_SEAM_BAND world rows, one stop seam
// in its middle) bends its seam by a 1-D contour of whole world rows
// (+-SEA_SEAM_ROWS, two octaves of value noise on an integer hash, periodic
// over SEA_SEAM_PERIOD world px so the Canvas strip tiles it). GLSL twin:
// SEA_SWELL_GLSL seaSeamRows (the same hash, the same float32 steps).
export const SEA_SEAM_PERIOD = 1280;
export const SEA_SEAM_BAND = (OPEN_SEA_LIGHT_REACH / (OPEN_SEA_DEEPEST - 2));
export const SEA_SEAM_OCTAVES = Object.freeze([320, 128]);
export const SEA_SEAM_ROWS = 14;

function seaSeamLattice(k, salt) {
    let h = (Math.imul(k, 1597334677) ^ Math.imul(salt + 4096, 3812015801)) >>> 0;
    h = Math.imul(h ^ (h >>> 16), 2246822519) >>> 0;
    h = (h ^ (h >>> 13)) >>> 0;
    return (h >>> 8) / 16777216;
}

function seaSeamOctave(x, lx, salt) {
    const f32 = Math.fround;
    const cells = SEA_SEAM_PERIOD / lx;
    const k = Math.floor(x / lx);
    const f = f32((x - k * lx) / lx);
    const s = f32(f32(f * f) * f32(3 - f32(2 * f)));
    const k0 = ((k % cells) + cells) % cells;
    const k1 = k0 + 1 < cells ? k0 + 1 : 0;
    const a = seaSeamLattice(k0, salt);
    const b = seaSeamLattice(k1, salt);
    return f32(a + f32(f32(b - a) * s));
}

const _seamTables = [];
function seamTable(band) {
    let table = _seamTables[band];
    if (table) return table;
    table = new Int8Array(SEA_SEAM_PERIOD);
    const f32 = Math.fround;
    for (let x = 0; x < SEA_SEAM_PERIOD; x++) {
        const n = f32(f32(seaSeamOctave(x, SEA_SEAM_OCTAVES[0], band * 2) * f32(0.7))
            + f32(seaSeamOctave(x, SEA_SEAM_OCTAVES[1], band * 2 + 1) * f32(0.3)));
        table[x] = Math.floor(f32(f32(f32(n - 0.5) * 2) * SEA_SEAM_ROWS) + 0.5);
    }
    _seamTables[band] = table;
    return table;
}

/** Whole world rows the open sea's stop seam near world texel (x, y) bends. */
export function seaSeamRowsAt(x, y) {
    const t = y - OCEAN_HORIZON_WORLD_Y;
    if (t < SEA_SEAM_BAND * 0.5 || t >= SEA_SEAM_BAND * 3.5) return 0;
    const band = Math.floor((t + SEA_SEAM_BAND * 0.5) / SEA_SEAM_BAND);
    return seamTable(band)[((Math.floor(x) % SEA_SEAM_PERIOD) + SEA_SEAM_PERIOD) % SEA_SEAM_PERIOD];
}

/**
 * Continuous open-sea depth at world texel (x, y): 2 at the horizon, the
 * deepest stop OPEN_SEA_LIGHT_REACH below it, its seams bent by
 * `seaSeamRowsAt`. GLSL twin: SEA_SWELL_GLSL openSeaDepth.
 */
export function openSeaDepthAt(x, y) {
    return 2 + (OPEN_SEA_DEEPEST - 2) * clamp01((y + 0.5 + seaSeamRowsAt(x, y) - OCEAN_HORIZON_WORLD_Y) / OPEN_SEA_LIGHT_REACH);
}

// The seam (in depth units) over which one open-sea stop dithers into the
// next deeper one: two world rows, so the stops read as solid bands.
export const OPEN_SEA_STOP_SEAM = 2 * (OPEN_SEA_DEEPEST - 2) / OPEN_SEA_LIGHT_REACH;

/**
 * The stop a continuous depth takes at one world texel: the lighter stop,
 * with the next deeper one dithered in over the last OPEN_SEA_STOP_SEAM on
 * the 4x4 Bayer `order` of that texel. GLSL twin: openSeaStop.
 */
export function openSeaStopAt(depth, order) {
    let stop = Math.floor(depth);
    const frac = depth - stop;
    const start = 1 - OPEN_SEA_STOP_SEAM;
    if (stop < OPEN_SEA_DEEPEST && frac > start && (frac - start) / OPEN_SEA_STOP_SEAM > order) stop += 1;
    return Math.min(OPEN_SEA_DEEPEST, stop);
}

function css255(rgb01) {
    return rgb01.map(channel => Math.round(Math.max(0, Math.min(1, channel)) * 255));
}

function hexTo01(hex) {
    return hexRgb(hex).map(channel => channel / 255);
}

function colourTo01(value) {
    if (Array.isArray(value) && value.length >= 3) {
        return value.slice(0, 3).map(channel => (channel > 1 ? channel / 255 : channel));
    }
    if (typeof value !== 'string') return null;
    if (/^#[0-9a-f]{6}$/i.test(value)) return hexTo01(value);
    const match = value.match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i);
    return match ? [Number(match[1]) / 255, Number(match[2]) / 255, Number(match[3]) / 255] : null;
}

/**
 * The sky colours the sea takes at the horizon, 0..1, as the sky plate paints
 * them on the resident path: `haze` (the plate's horizon course, which the
 * top haze courses meet) and `horizon` (the sky just above it, which the
 * reflection band mirrors). The band is the sky's reflection as the path is
 * the sun's (3.3 (d), orchestrator decision a): it keeps the horizon's own
 * colour, warm at golden hour, fading into the sea over four courses; V6's
 * cool rule holds the sea body below it.
 */
export function openSeaSky(atmosphere) {
    const palette = atmosphere?.sky?.palette;
    const haze = colourTo01(palette?.haze)
        || colourTo01(atmosphere?.lightGrade?.horizonHaze)
        || colourTo01(palette?.horizon)
        || hexTo01('#8fb9cf');
    return { haze, horizon: colourTo01(palette?.horizon) || haze };
}

/**
 * 3.4 — the forecast squall: while the timeline's next knot is rain or storm,
 * one dark course patch drifts in from the upwind sea over the SQUALL_WINDOW
 * of transition progress that ends as the first rain falls (WeatherRenderer
 * starts its streaks once precipitation passes RAIN_START_PRECIPITATION), so
 * it approaches first and its leading edge reaches the island's upwind
 * vertex as the rain begins. The timeline's own future, so it is truthful;
 * its streak columns fall on the motion clock (frozen under reduced motion).
 * Null when there is none.
 */
export const SQUALL_HALF_WIDTH = 640;
const SQUALL_TRAVEL = 2600;
const SQUALL_STREAK_STEP_MS = 125;
const SQUALL_WINDOW = 0.15;
/**
 * The precipitation at which rain starts to fall on screen (WeatherRenderer's
 * streaks and wash, whatever the weather type), shared so the squall always
 * arrives before it.
 */
export const RAIN_START_PRECIPITATION = 0.02;

// Transition progress at which the first rain falls. Precipitation rises
// linearly in the progress from the dry knot before it, so its rate is
// precipitation / progress.
function squallFlipProgress(progress, precipitation) {
    if (!(progress > 0) || !(precipitation > 0)) return 0.5;
    return Math.min(0.5, RAIN_START_PRECIPITATION * progress / precipitation);
}

export function openSeaSquall(weather, motionTimeMs = 0) {
    const type = weather?.type || 'clear';
    const next = weather?.nextType || type;
    const progress = Number(weather?.transitionProgress);
    if (type === 'rain' || type === 'storm' || (next !== 'rain' && next !== 'storm')) return null;
    const flip = squallFlipProgress(progress, Number(weather?.precipitation));
    // The approach may use the whole transition before the first rain.
    const span = Math.min(SQUALL_WINDOW, flip);
    if (!(progress >= flip - span && progress < flip)) return null;
    const s = (progress - (flip - span)) / span;
    const windX = Number(weather?.windX);
    const sign = Number.isFinite(windX) && windX < 0 ? -1 : 1;
    const islandHalf = MAP_SIZE * HALF_W;
    const reach = islandHalf + SQUALL_HALF_WIDTH + SQUALL_TRAVEL * (1 - s);
    return {
        x: -sign * reach,
        y: (MAP_SIZE - 1) * HALF_H + TILE_HEIGHT * 4,
        halfWidth: SQUALL_HALF_WIDTH,
        // Builds from a first thin course to its full two as it nears.
        strength: Math.min(1, 0.4 + s),
        fall: (Math.floor((Number(motionTimeMs) || 0) / SQUALL_STREAK_STEP_MS) * 3) % 48,
    };
}

// The Canvas palette: the preimage of what the frame grade turns into the
// capped graded water (the same surface + preimage as the Canvas water mood
// layer), and the sky colours' preimage; `graded` keeps the finished colours
// the band and haze courses mix, as the resident composite mixes them.
function oceanPalette(atmosphere, postFx) {
    const mood = waterMoodFor(atmosphere);
    const grade = atmosphere?.lightGrade || null;
    const sunBand = waterSunBandFor(atmosphere);
    const pre = [...OPEN_SEA_STOPS, SEA_TROUGH].map((rgb) => {
        const c = waterSurfaceRgb(rgb.map(channel => channel / 255), mood, sunBand);
        return grade ? CanvasGrade.canvasWaterPreimage(c, grade, { postFx }) : c;
    });
    const sky = openSeaSky(atmosphere);
    const preimage = rgb => (grade ? CanvasGrade.canvasFramePreimage(rgb, grade, { postFx }) : rgb);
    return {
        water: pre.map(css255),
        haze: css255(preimage(sky.haze)),
        horizon: css255(preimage(sky.horizon)),
        graded: {
            water: pre.map(c => (grade ? CanvasGrade.canvasFrameGradeRgb(c, grade, { postFx }) : c)),
            haze: sky.haze,
            horizon: sky.horizon,
        },
        preimage,
    };
}

// The Canvas path's kind and strength (the resident pass resolves its own
// `u_glint`): gold near golden hour, pale by day, silver under a moon at
// least half full in clear air; none under heavy cloud. CanvasWaterState
// lays the path on the in-map water and the open sea alike.
export function canvasGlint(atmosphere) {
    const sky = atmosphere?.sky;
    const weather = atmosphere?.weather || {};
    const cover = clamp01(weather.cloudCover);
    const raining = weather.type === 'rain' || weather.type === 'storm';
    if (sky?.sun?.visible && cover < 0.7) {
        const rake = clamp01(atmosphere?.lightGrade?.rake);
        return { kind: rake >= 0.4 ? 1 : 2, strength: 0.35 + 0.65 * rake, body: sky.sun };
    }
    const moonFill = clamp01(atmosphere?.lighting?.moonFill ?? sky?.moon?.fill);
    if (sky?.moon?.visible && moonFill >= 0.5 && cover < 0.5 && !raining) {
        return { kind: 3, strength: moonFill, body: sky.moon };
    }
    return null;
}

function oceanKey(atmosphere, postFx) {
    const palette = oceanPalette(atmosphere, postFx);
    const q = rgb => rgb.map(channel => channel >> 2).join('.');
    const hazeRows = openSeaHazeRows(atmosphere?.weather?.fog);
    return {
        palette,
        hazeRows,
        shades: new Map(),
        key: `${postFx ? 'p' : 'c'}|${palette.water.map(q).join(',')}|${q(palette.haze)}|${q(palette.horizon)}|${hazeRows}`,
    };
}

function putRgb(data, o, rgb) {
    data[o] = rgb[0];
    data[o + 1] = rgb[1];
    data[o + 2] = rgb[2];
    data[o + 3] = 255;
}

// Course of the sky-reflection band `band` rows under the haze: four solid
// courses (OPEN_SEA_BAND_WEIGHTS; 4 and past = the sea), each handing to the
// next in a 2-row ordered seam; the last dithers out into the sea over
// OPEN_SEA_BAND_TAIL of its depth.
function bandCourse(band, order) {
    const n = OPEN_SEA_BAND_WEIGHTS.length;
    if (band >= OPEN_SEA_BAND_DEPTH) return n;
    const p = (band / OPEN_SEA_BAND_DEPTH) * n;
    let k = Math.floor(p);
    const seam = k > n - 1.5 ? OPEN_SEA_BAND_TAIL : 2 * n / OPEN_SEA_BAND_DEPTH;
    if (p - k > 1 - seam && (p - k - (1 - seam)) / seam > order) k += 1;
    return Math.min(k, n);
}

// The haze courses (OPEN_SEA_HAZE_WEIGHTS; 3 = none): solid, with a 1-row
// seam into the next.
function hazeCourse(j, rows, order) {
    const n = OPEN_SEA_HAZE_WEIGHTS.length;
    if (j >= rows) return n;
    const p = (j / rows) * n;
    let k = Math.floor(p);
    const seam = Math.min(1, n / rows);
    if (p - k > 1 - seam && (p - k - (1 - seam)) / seam > order) k += 1;
    return Math.min(k, n);
}

// Whole rows the band's course seams bend at world column x (periodic over
// the strip), two octaves of the seam lattice on their own salts.
let _bandContour = null;
function bandContourAt(x) {
    if (!_bandContour) {
        _bandContour = new Int8Array(SEA_SEAM_PERIOD);
        for (let i = 0; i < SEA_SEAM_PERIOD; i++) {
            const n = seaSeamOctave(i, SEA_SEAM_OCTAVES[0], 40) * 0.7 + seaSeamOctave(i, SEA_SEAM_OCTAVES[1], 41) * 0.3;
            _bandContour[i] = Math.floor((n - 0.5) * 2 * CANVAS_BAND_CONTOUR_ROWS + 0.5);
        }
    }
    return _bandContour[((Math.floor(x) % SEA_SEAM_PERIOD) + SEA_SEAM_PERIOD) % SEA_SEAM_PERIOD];
}

// The band course at world column `x`, `j` rows below the horizon: its first
// course continues under the haze, its seams bend on the contour.
function bandCourseAt(spec, x, j, order) {
    const under = j - spec.hazeRows;
    const band = Math.max(0, under) + Math.floor(bandContourAt(x) * Math.max(0, Math.min(1, under / CANVAS_BAND_CONTOUR_RAMP)) + 0.5);
    return bandCourse(band, order);
}

// An open-sea texel of stop `stop` (already lightened) on band course `bk`
// and haze course `hk`, as the composite shades it on the graded sea: the
// band mixes the sky's horizon colour in (held at HSL L <= 0.70), a marked
// texel (a cap, a crest) taking OPEN_SEA_BAND_MARK_LIFT more of it, then the
// haze courses; painted as the frame preimage. Memoized per bake.
function seaShade(spec, stop, bk, hk, marked) {
    const s = Math.max(0, Math.min(OPEN_SEA_STOPS.length, stop));
    const key = ((s * 8 + bk) * 4 + hk) * 2 + (marked ? 1 : 0);
    let out = spec.shades.get(key);
    if (out) return out;
    const { graded, preimage, water } = spec.palette;
    let w = OPEN_SEA_BAND_WEIGHTS[bk] ?? 0;
    if (marked && w > 0) w += OPEN_SEA_BAND_MARK_LIFT;
    const h = OPEN_SEA_HAZE_WEIGHTS[hk] ?? 0;
    if (w > 0 || h > 0) {
        let c = graded.water[s];
        if (w > 0) {
            c = c.map((channel, index) => channel + (graded.horizon[index] - channel) * w);
            const l = 0.5 * (Math.max(...c) + Math.min(...c));
            if (l > 0.70) c = c.map(channel => channel * 0.70 / l);
        }
        if (h > 0) c = c.map((channel, index) => channel + (graded.haze[index] - channel) * h);
        out = css255(preimage(c));
    } else {
        out = water[s];
    }
    spec.shades.set(key, out);
    return out;
}

// One Canvas horizon-strip texel: `i` the world column (periodic over the
// strip, SEA_SEAM_PERIOD), `j` the row below the horizon. Mirrors the
// resident shader's stop (seams bent by `seaSeamRowsAt`), band and haze
// rules.
function canvasSeaTexel(i, j, spec) {
    const order = bayer(i, j);
    const stop = openSeaStopAt(openSeaDepthAt(i, OCEAN_HORIZON_WORLD_Y + j), order);
    return seaShade(spec, stop, bandCourseAt(spec, i, j, order), hazeCourse(j, spec.hazeRows, order), false);
}

function stripRowsFor(spec) {
    return Math.max(OPEN_SEA_LIGHT_REACH + SEA_SEAM_ROWS, spec.hazeRows + OPEN_SEA_BAND_DEPTH + CANVAS_BAND_CONTOUR_ROWS) + 4;
}

// The horizon strip: every row whose stop or sky mix still varies, one seam
// period wide (the stop seams wander over it); below it the deepest stop.
// CanvasWaterState lays the 3.3 (a) body field and 3.4's sunlit course over
// it per chunk.
function bakeCanvasSea(state, spec) {
    const rows = stripRowsFor(spec);
    const canvas = state.strip ||= document.createElement('canvas');
    canvas.width = SEA_SEAM_PERIOD;
    canvas.height = rows;
    const image = new ImageData(SEA_SEAM_PERIOD, rows);
    for (let j = 0; j < rows; j++) {
        for (let i = 0; i < SEA_SEAM_PERIOD; i++) putRgb(image.data, (j * SEA_SEAM_PERIOD + i) * 4, canvasSeaTexel(i, j, spec));
    }
    canvas.getContext('2d').putImageData(image, 0, 0);
    state.stripRows = rows;
    state.spec = spec;
}

// World rect under the current transform (camera applied, no rotation).
function visibleWorldRect(ctx) {
    const m = ctx.getTransform?.();
    const width = ctx.canvas?.width || 0;
    const height = ctx.canvas?.height || 0;
    if (!m || !(m.a > 0) || !(m.d > 0) || !width || !height) return null;
    return {
        x0: -m.e / m.a,
        x1: (width - m.e) / m.a,
        y0: -m.f / m.d,
        y1: (height - m.f) / m.d,
    };
}

function paintOcean(ctx, state, strip, deep, rect) {
    const top = OCEAN_HORIZON_WORLD_Y;
    const stripBottom = top + state.stripRows;
    const left = Math.floor(rect.x0) - 1;
    const right = Math.ceil(rect.x1) + 1;
    const bottom = Math.ceil(rect.y1) + 1;
    if (rect.y0 < stripBottom) {
        for (let x = Math.floor(left / SEA_SEAM_PERIOD) * SEA_SEAM_PERIOD; x < right; x += SEA_SEAM_PERIOD) {
            ctx.drawImage(strip, x, top);
        }
    }
    const deepTop = Math.max(stripBottom, Math.floor(rect.y0));
    if (bottom > deepTop) {
        ctx.fillStyle = `rgb(${deep[0]}, ${deep[1]}, ${deep[2]})`;
        ctx.fillRect(left, deepTop, right - left, bottom - deepTop);
    }
}

/**
 * The open sea on the 2D canvas (world space, camera transform applied) for
 * the Canvas and hybrid PostFx paths: the horizon strip (stops, haze courses,
 * the reflection band) and the deepest stop below it. Its marks (swell caps,
 * crests, cat's paws, the sunlit course, the sun/moon path) land over it with
 * the in-map water's (CanvasWaterState). Rebaked only when the quantized
 * palette or fog changes, at most about once a second outside weather flips.
 * On the resident path (`gpuGraded`) the composite paints the open sea, so
 * the backdrop keeps only the sky.
 */
export function drawOuterOcean(ctx, renderer, atmosphere, { gpuGraded = false } = {}) {
    if (gpuGraded) return;
    const view = visibleWorldRect(ctx);
    if (!view || view.y1 <= OCEAN_HORIZON_WORLD_Y) return;
    const state = renderer._outerOcean || (renderer._outerOcean = { key: '', bakedAt: -Infinity });
    const now = performance.now();
    const postFx = renderer?.postFx?.isActive?.() === true;
    const spec = oceanKey(atmosphere, postFx);
    const weatherKey = `${atmosphere?.weather?.type || 'clear'}|${postFx}`;
    const due = now - state.bakedAt >= OCEAN_REBAKE_MIN_MS || state.weatherKey !== weatherKey;
    if (!state.strip || (state.key !== spec.key && due)) {
        const started = performance.now();
        bakeCanvasSea(state, spec);
        state.key = spec.key;
        state.hazeRows = spec.hazeRows;
        state.weatherKey = weatherKey;
        state.bakedAt = now;
        state.bakeMs = performance.now() - started;
    }
    ctx.save();
    ctx.imageSmoothingEnabled = false;
    paintOcean(ctx, state, state.strip, state.spec.palette.water[OPEN_SEA_DEEPEST], view);
    ctx.restore();
}

/** The ocean bake's key (a mark colour cache follows it), or '' before it. */
export function canvasSeaKey(renderer) {
    return renderer?._outerOcean?.spec ? renderer._outerOcean.key : '';
}

/**
 * The colour (0xRRGGBB) of an open-sea texel at world (x, y) of stop `stop`
 * (after its marks' and the sunlit course's lightening), as the ocean bake
 * shades it: band and haze courses by row, a mark (`marked`) catching
 * OPEN_SEA_BAND_MARK_LIFT more of the sky. Memoized per bake; -1 before it.
 */
export function canvasSeaMarkRgb(renderer, stop, x, y, marked) {
    const state = renderer?._outerOcean;
    const spec = state?.spec;
    if (!spec) return -1;
    const j = y - OCEAN_HORIZON_WORLD_Y;
    let bk = OPEN_SEA_BAND_WEIGHTS.length;
    let hk = OPEN_SEA_HAZE_WEIGHTS.length;
    if (j < state.stripRows) {
        const order = bayer(x, j);
        bk = bandCourseAt(spec, x, j, order);
        hk = hazeCourse(j, spec.hazeRows, order);
    }
    const rgb = seaShade(spec, stop, bk, hk, marked);
    return (rgb[0] << 16) | (rgb[1] << 8) | rgb[2];
}
