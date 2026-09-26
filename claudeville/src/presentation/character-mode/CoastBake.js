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
// water-material fragments, the Canvas fallback draws a mood-recoloured copy
// of the baked water (rebuilt per mood bucket), and the cached outer ocean
// bakes it into its palette.

import { MAP_SIZE, TILE_HEIGHT, TILE_WIDTH } from '../../config/constants.js';
import { ART_RAMPS } from '../../config/artPalette.js';
import { applyGradeToRgb } from './GradeEvaluator.js';
import * as CanvasGrade from './CanvasGrade.js';

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
const DEPTH_BOUNDS = Object.freeze([0.30, 0.78, 1.38, 2.15]);
const DEPTH_DITHER_HALF = 0.13;
const RIPPLE_SEED_DENSITY = 0.011;
// How far (tiles) the shelf may continue past the map edges into the ocean;
// its deepening (0.8 per tile, minus wobble) always ends before this.
const OUTER_SHELF_TILES = 4;
// Far-edge land (NW/NE, whose cliff faces away from the camera) is treated as
// shore this far inland (tiles of signed distance), with a value-noise wobble,
// so it ends in wet sand and foam lace on the outer ocean.
const BACK_SHORE_SD = 0.3;
const BACK_SHORE_WOBBLE = 0.1;
// Value-noise wobble (tiles of signed distance) on the outer shelf contours.
const SHELF_WOBBLE = 0.4;
// Grade night weight below which water keeps its day mood (see waterMoodFor).
const WATER_NIGHT_FLOOR = 0.15;

// Cliff (3.5) geometry in world px.
const CLIFF_FACE = 34;
const CLIFF_REFLECTION_ROWS = 18;
// Landmark reflections (3.7).
const REFLECTION_TYPES = Object.freeze(['watchtower', 'harbor', 'observatory']);
const REFLECTION_REACH_TILES = 1.5;
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

function rgbCss([r, g, b], alpha = 1) {
    return alpha >= 1 ? `rgb(${r},${g},${b})` : `rgba(${r},${g},${b},${alpha})`;
}

const SHALLOW = ART_RAMPS.shallowWater.map(hexRgb);
const DEEP = ART_RAMPS.deepWater.map(hexRgb);
const SAND = ART_RAMPS.sand.map(hexRgb);
const DIRT = ART_RAMPS.dirt.map(hexRgb);
const TIMBER = ART_RAMPS.timber.map(hexRgb);
const VOID = ART_RAMPS.void.map(hexRgb);

// The five depth stops, shallow -> deep, all on the C1 water ramps (S <= 0.40).
export const COAST_WATER_STOPS = Object.freeze([
    SHALLOW[1],
    mixRgb(SHALLOW[0], SHALLOW[1], 0.45),
    SHALLOW[0],
    DEEP[2],
    mixRgb(DEEP[1], DEEP[2], 0.45),
].map(Object.freeze));
const FOAM = Object.freeze(SHALLOW[2]);
const FOAM_CREST = Object.freeze(mixRgb(SHALLOW[2], [226, 232, 220], 0.45));
const WET_SAND = Object.freeze(mixRgb(SAND[1], SHALLOW[0], 0.34));
const WET_SAND_DARK = Object.freeze(mixRgb(SAND[0], DEEP[2], 0.5));

// Cliff strata (3.5): root shadow under the turf, warm sandstone with a
// one-pixel highlight course, a darker lower stratum and a wet foot. The SW
// face takes the upper-left key; the SE face sits one ramp step darker.
const CLIFF_STRATA = Object.freeze({
    sw: Object.freeze({
        root: TIMBER[0], highlight: SAND[3], upper: SAND[0], speck: DIRT[2], seam: TIMBER[1],
        lower: DIRT[1], foot: TIMBER[2], wet: TIMBER[0],
    }),
    se: Object.freeze({
        root: TIMBER[0], highlight: SAND[0], upper: DIRT[3], speck: DIRT[1], seam: TIMBER[0],
        lower: DIRT[0], foot: TIMBER[1], wet: TIMBER[0],
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

// Deepest stop a water body may reach: rivers stay light, lagoons stop one
// short of the open sea.
function depthCapFor(region) {
    if (region === 'river') return 2;
    if (region === 'lagoon') return 3;
    return 4;
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
            caps[ty * MAP_SIZE + tx] = cap || 4;
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
    for (let k = 0; k < list.length; k += 2) {
        const tx = list[k];
        const ty = list[k + 1];
        const cap = field.caps[ty * MAP_SIZE + tx] || 4;
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
                const i = (minX >> 1) + c;
                const j = (minY >> 1) + r;
                depth[cell] = sd;
                const cls = waterClass(sd, cap, i, j);
                if (cls === CLASS_WET && landPaved(renderer, wx, wy, tx, ty)) continue;
                classes[cell] = cls;
            }
        }
    }
    // Outer shelf: cells beyond the map edges take the signed distance at the
    // nearest in-map point plus how far past the edge they sit, so the shelf
    // deepens steadily into the ocean. Land on the lower (SE/SW) edges keeps
    // its cliff. Land on the far edges, whose cliff faces away, is held
    // BACK_SHORE_SD inland so it grows a wobbling wet-sand and foam beach.
    // Cells as deep as the ocean beside them (its deepest stop, or a lighter
    // one toward the horizon) stay clear, so the shelf hands over to it.
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
            if (classes[cell] !== CLASS_NONE) continue;
            const uc = Math.min(Math.max(u, first), last);
            const vc = Math.min(Math.max(v, first), last);
            const excess = Math.abs(u - uc) + Math.abs(v - vc);
            if (excess > OUTER_SHELF_TILES) continue;
            const edgeSd = field.signedDistance(uc, vc);
            if (edgeSd <= 0 && lower) continue;
            const landShare = Math.min(1, Math.max(0, -edgeSd / BACK_SHORE_SD));
            // Past the edge the depth contours wobble on value noise (growing
            // with distance, zero at the edge), so the shelf's outer contour
            // never runs parallel to the map edge as a straight 2:1 line.
            const sd = Math.max(edgeSd, -BACK_SHORE_SD) + excess * 0.8
                + (valueNoise(uc, vc) - 0.5) * 2 * BACK_SHORE_WOBBLE * landShare
                + (valueNoise(u + 17, v - 11) - 0.5) * 2 * SHELF_WOBBLE * Math.min(1, excess);
            if (sd >= DEPTH_BOUNDS[3] + DEPTH_DITHER_HALF) continue;
            const i = (minX >> 1) + c;
            const j = (minY >> 1) + r;
            const cls = waterClass(sd, 4, i, j);
            if (cls >= CLASS_WATER + Math.max(2, 4 - Math.floor(oceanIndexAt(wy)))) continue;
            depth[cell] = sd;
            classes[cell] = cls;
        }
    }
    // Sparse 2:1 ripple dashes: three cells, one stop lighter, only in the
    // middle stops where the ramp is broad enough to carry them.
    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
            const cell = r * cols + c;
            const cls = classes[cell];
            if (cls < CLASS_WATER + 2 || cls > CLASS_WATER + 3) continue;
            const i = (minX >> 1) + c;
            const j = (minY >> 1) + r;
            if (isRippleSeed(i, j) || isRippleSeed(i - 1, j) || isRippleSeed(i - 2, j)) {
                classes[cell] = cls - 1;
            }
        }
    }
    return { x: minX, y: minY, cols, rows, classes, depth };
}

function colourForClass(cls, sd) {
    if (cls === CLASS_WET) return sd > WET_SAND_EDGE ? WET_SAND_DARK : WET_SAND;
    if (cls === CLASS_FOAM) return sd < FOAM_BAND * 0.5 ? FOAM_CREST : FOAM;
    return COAST_WATER_STOPS[cls - CLASS_WATER];
}

// ---------------------------------------------------------------------------
// Landmark reflections (3.7)

function landmarkReflections(renderer, coast) {
    const buildingRenderer = renderer.buildingRenderer;
    const assets = renderer.assets;
    if (!buildingRenderer || !assets?.get) return;
    for (const building of renderer.world?.buildings?.values?.() || []) {
        if (!REFLECTION_TYPES.includes(building.type)) continue;
        const entry = assets.getEntry?.(`building.${building.type}`);
        const id = entry?.id || `building.${building.type}`;
        const image = assets.get(id);
        const anchor = assets.getAnchor?.(id);
        if (!image || !anchor) continue;
        const center = buildingRenderer._buildingScreenCenter?.(building);
        if (!center) continue;
        const width = image.naturalWidth || image.width;
        const height = image.naturalHeight || image.height;
        if (!width || !height) continue;
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const sctx = canvas.getContext('2d', { willReadFrequently: true });
        sctx.drawImage(image, 0, 0);
        let alpha;
        try {
            alpha = sctx.getImageData(0, 0, width, height).data;
        } catch {
            continue;
        }
        const dx = Math.round(center.x - anchor[0]);
        const dy = Math.round(center.y - anchor[1]);
        // Mirror axis per column: the lower edges of the footprint diamond,
        // where the building meets the water plane nearest the viewer.
        const x0 = building.position.tileX;
        const y0 = building.position.tileY;
        const w = building.width || 1;
        const h = building.height || 1;
        const frontX = (x0 + w - 1 - (y0 + h - 1)) * HALF_W;
        const frontY = (x0 + w - 1 + y0 + h - 1) * HALF_H + HALF_H;
        const leftX = (x0 - (y0 + h - 1)) * HALF_W - HALF_W;
        const rightX = (x0 + w - 1 - y0) * HALF_W + HALF_W;
        const reachPx = REFLECTION_REACH_TILES * TILE_HEIGHT * 1.5;
        const cStart = Math.max(0, Math.floor((Math.max(dx, leftX) - coast.x) / 2));
        const cEnd = Math.min(coast.cols, Math.ceil((Math.min(dx + width, rightX) - coast.x) / 2));
        const rStart = Math.max(0, Math.floor((frontY - (frontX - leftX) / 2 - coast.y) / 2));
        const rEnd = Math.min(coast.rows, Math.ceil((frontY + reachPx - coast.y) / 2));
        for (let r = rStart; r < rEnd; r++) {
            const wy = coast.y + r * 2 + 1;
            // Static 2 px row jitter on a hash of the row: -2, 0 or +2.
            const jitter = (Math.floor(hash2(r, x0, 53) * 3) - 1) * 2;
            for (let c = cStart; c < cEnd; c++) {
                const cell = r * coast.cols + c;
                const cls = coast.classes[cell];
                if (cls < CLASS_WATER) continue;
                const wx = coast.x + c * 2 + 1;
                const baseY = frontY - Math.abs(wx - frontX) / 2;
                const drop = wy - baseY;
                if (drop < 0 || drop >= reachPx) continue;
                const sx = wx - dx + jitter;
                const sy = Math.round(baseY - drop) - dy;
                if (sx < 0 || sx >= width || sy < 0 || sy >= height) continue;
                if (alpha[(sy * width + sx) * 4 + 3] < 128) continue;
                // Unlit silhouette at one of three alpha steps by distance
                // from the waterline (stored as a reflection tag per cell).
                const band = Math.min(REFLECTION_ALPHAS.length - 1, Math.floor(drop / (reachPx / REFLECTION_ALPHAS.length)));
                coast.reflect ||= new Uint8Array(coast.classes.length);
                coast.reflect[cell] = band + 1;
            }
        }
    }
}

function reflectedColour(base, band) {
    const alpha = REFLECTION_ALPHAS[band - 1] ?? 0;
    return mixRgb(base, DEEP[0], alpha);
}

// ---------------------------------------------------------------------------
// The bake pass (stage 'coast')

function paintCoast(ctx, coast) {
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
    const data = image.data;
    for (let r = 0; r < coast.rows; r++) {
        for (let c = 0; c < coast.cols; c++) {
            const cell = r * coast.cols + c;
            const cls = coast.classes[cell];
            if (cls === CLASS_NONE) continue;
            let rgb = colourForClass(cls, coast.depth[cell]);
            const band = coast.reflect?.[cell];
            if (band) rgb = reflectedColour(rgb, band);
            for (let oy = 0; oy < 2; oy++) {
                let o = ((r * 2 + oy) * w + c * 2) * 4;
                for (let ox = 0; ox < 2; ox++, o += 4) {
                    data[o] = rgb[0];
                    data[o + 1] = rgb[1];
                    data[o + 2] = rgb[2];
                    data[o + 3] = 255;
                }
            }
        }
    }
    if (pure) {
        ctx.putImageData(image, px, py);
        return;
    }
    // Uncached fallback (terrain over the surface budget): stamp through a
    // layer so the camera transform applies.
    coast.layer ||= (() => {
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        canvas.getContext('2d').putImageData(image, 0, 0);
        return canvas;
    })();
    ctx.drawImage(coast.layer, coast.x, coast.y);
}

function edgeSides() {
    const last = MAP_SIZE - 1;
    const east = { x: last * HALF_W + HALF_W, y: last * HALF_H };
    const south = { x: 0, y: last * TILE_HEIGHT + HALF_H };
    const west = { x: -last * HALF_W - HALF_W, y: last * HALF_H };
    return [
        // SE face: tileX = MAP-1 edge, faces down-right, in key shadow.
        { a: east, b: south, face: 'se', edgeU: true },
        // SW face: tileY = MAP-1 edge, faces down-left, takes the key.
        { a: south, b: west, face: 'sw', edgeU: false },
    ];
}

/**
 * 3.5 — the island's land edge: a 2:1 stepped top, three strata with a
 * highlight course, a wet foot and a dithered surf lace at the waterline,
 * over a stepped reflection. Only where the edge tile is land: where the sea
 * reaches the map edge it simply meets the outer ocean.
 */
function drawStratifiedCliff(ctx, field) {
    const edgeLimit = MAP_SIZE - 0.5 - 0.06;
    for (const side of edgeSides()) {
        const strata = CLIFF_STRATA[side.face];
        const x0 = Math.min(side.a.x, side.b.x);
        const x1 = Math.max(side.a.x, side.b.x);
        for (let x = Math.ceil(x0 / 2) * 2; x < x1; x += 2) {
            const cx = x + 1;
            // The diamond edge line at this column (2:1), snapped to the
            // lattice so the top steps 2 across, 1 down.
            const t = (cx - side.a.x) / (side.b.x - side.a.x);
            const edgeY = Math.floor(side.a.y + (side.b.y - side.a.y) * t);
            const wy = edgeY - 1;
            const u = wy / TILE_HEIGHT + cx / TILE_WIDTH;
            const v = wy / TILE_HEIGHT - cx / TILE_WIDTH;
            const su = side.edgeU ? Math.min(u, edgeLimit) : u;
            const sv = side.edgeU ? v : Math.min(v, edgeLimit);
            const sd = field.signedDistance(su, sv);
            if (sd > 0) continue;
            const tileAlong = Math.floor(side.edgeU ? v : u);
            // Per-tile geology: the seam wobbles one pixel, the highlight
            // course breaks now and then, the lip drops 0-2 px.
            const wobble = Math.floor(hash2(tileAlong, side.face === 'se' ? 1 : 2, 71) * 3) - 1;
            const lip = Math.floor(hash2(x >> 3, side.face === 'se' ? 3 : 4, 17) * 2);
            let y = edgeY;
            const run = (height, rgb) => {
                if (height <= 0) return;
                ctx.fillStyle = rgbCss(rgb);
                ctx.fillRect(x, y, 2, height);
                y += height;
            };
            run(2 + lip, strata.root);
            if (hash2(x >> 2, tileAlong, 29) > 0.2) run(1, strata.highlight);
            else run(1, strata.upper);
            const upperTop = y;
            run(12 + wobble, strata.upper);
            // Sparse 2x1 grit in the sandstone so the course is not a flat band.
            if (hash2(x >> 1, tileAlong, 43) < 0.16) {
                ctx.fillStyle = rgbCss(strata.speck);
                ctx.fillRect(x, upperTop + 2 + Math.floor(hash2(x, 5, 61) * 8), 2, 1);
            }
            run(1, strata.seam);
            run(11 - wobble - lip, strata.lower);
            run(4, strata.foot);
            const used = y - edgeY;
            run(Math.max(1, CLIFF_FACE - used - 1), strata.wet);
            const waterline = y;
            // Surf lace at the foot: clustered runs of 2 px foam blocks (a
            // coarse and a fine hash, so breaks are irregular, never a
            // metronome dot line), two foam buckets, a sparse half course.
            const lace = hash2(x >> 3, side.face === 'se' ? 5 : 6, 37) * 0.6 + hash2(x >> 1, 1, 41) * 0.4;
            if (lace < 0.52) {
                ctx.fillStyle = rgbCss(lace < 0.22 ? FOAM_CREST : FOAM);
                ctx.fillRect(x, waterline, 2, 2);
                if (hash2(x >> 1, waterline, 83) < 0.35) {
                    ctx.fillStyle = rgbCss(FOAM, 0.5);
                    ctx.fillRect(x, waterline + 2, 2, 2);
                }
            }
            // Stepped reflection of the face: strata colours reversed, three
            // alpha steps, a static row jitter so the edge reads as water.
            const reflection = [strata.wet, strata.foot, strata.lower, strata.lower, strata.upper, strata.upper];
            for (let k = 0; k < CLIFF_REFLECTION_ROWS; k += 2) {
                const jitter = hash2(x >> 1, k, 97) < 0.22 ? 2 : 0;
                const rgb = reflection[Math.min(reflection.length - 1, (k / 3) | 0)];
                const alpha = k < 6 ? 0.1875 : k < 12 ? 0.125 : 0.0625;
                ctx.fillStyle = rgbCss(rgb, alpha);
                ctx.fillRect(x + jitter, waterline + 2 + k, 2, 2);
            }
        }
    }
}

/**
 * Register the coast bake on a renderer. The pass paints wet sand, foam and
 * all water pixels over the ground bake, then the land-only cliff.
 */
export function registerCoastBake(renderer) {
    return renderer.registerTerrainBakePass({
        id: 'coast-field',
        stage: 'coast',
        revision: r => coastFieldKey(r),
        draw(ctx, r) {
            const started = performance.now();
            const field = getCoastField(r);
            const coast = classifyCoast(r, field);
            if (coast) {
                landmarkReflections(r, coast);
                paintCoast(ctx, coast);
            }
            drawStratifiedCliff(ctx, field);
            r._coastBake = {
                coast,
                fieldMs: field.buildMs,
                bakeMs: performance.now() - started,
                key: coastFieldKey(r),
            };
            r._coastMoodLayer = null;
        },
    });
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

function moodIsIdentity(mood) {
    return !(mood?.night > 0) && !(mood?.storm > 0);
}

function wateryPixel(r, g, b) {
    // Water stops are all blue/teal-dominant; sand, foam, timber and stone
    // are not. Keeps docks, piers and shore props out of the mood recolour.
    return b >= r + 6 && g >= r;
}

/**
 * Canvas fallback: draw a mood-recoloured copy of the baked water over the
 * terrain. Built lazily from the terrain cache on the first non-day frame and
 * rebuilt only when the mood bucket changes; day frames draw nothing.
 */
export function drawCanvasWaterMood(ctx, renderer, atmosphere) {
    const mood = waterMoodFor(atmosphere);
    if (moodIsIdentity(mood)) return;
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
        for (let r = 0; r < coast.rows; r++) {
            for (let c = 0; c < coast.cols; c++) {
                if (coast.classes[r * coast.cols + c] < CLASS_WATER) continue;
                for (let oy = 0; oy < 2; oy++) {
                    for (let ox = 0; ox < 2; ox++) {
                        const p = ((r * 2 + oy) * w + c * 2 + ox) * 4;
                        if (!wateryPixel(src[p], src[p + 1], src[p + 2])) continue;
                        pixels.push(p);
                        colours.push((src[p] << 16) | (src[p + 1] << 8) | src[p + 2]);
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
            moodKey: '',
            x: coast.x,
            y: coast.y,
            w,
            h,
        };
    }
    const moodKey = `${mood.night}:${mood.storm}`;
    if (layer.moodKey !== moodKey) {
        const image = new ImageData(layer.w, layer.h);
        const data = image.data;
        const memo = new Map();
        for (let k = 0; k < layer.pixels.length; k++) {
            const colour = layer.colours[k];
            let out = memo.get(colour);
            if (out === undefined) {
                const rgb = applyWaterMood([(colour >> 16) / 255, ((colour >> 8) & 255) / 255, (colour & 255) / 255], mood);
                out = (Math.round(rgb[0] * 255) << 16) | (Math.round(rgb[1] * 255) << 8) | Math.round(rgb[2] * 255);
                memo.set(colour, out);
            }
            const p = layer.pixels[k];
            data[p] = out >> 16;
            data[p + 1] = (out >> 8) & 255;
            data[p + 2] = out & 255;
            data[p + 3] = 255;
        }
        layer.ctx.putImageData(image, 0, 0);
        layer.moodKey = moodKey;
    }
    ctx.drawImage(layer.canvas, layer.x, layer.y);
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
// Outer ocean (3.4): the sea around the whole island, out to the horizon

const OCEAN_TEXEL = 4;
// World px below the horizon over which the sea lightens toward it. Below
// this band it has settled on the deepest stop, one flat fill.
const OCEAN_LIGHT_REACH = 300;
const OCEAN_BAND_ROWS = Math.ceil(OCEAN_LIGHT_REACH / OCEAN_TEXEL);
// The band repeats sideways with this period (texels): its dither and swell
// hashes read the world texel column modulo the period, so one strip tiles
// seamlessly across any view.
const OCEAN_PERIOD = 256;
const OCEAN_GLINT_ROWS = 70;
const OCEAN_GLINT_HALF = 5;
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

// The cool cast the resident scene pass gives water albedo (GpuWorldRenderer
// `applyWaterState`); the ocean mirrors it so the two meet without a seam.
const WATER_CAST = Object.freeze([0.94, 0.98, 1.03]);

// Continuous ocean stop index at world y: 0 (the deepest stop) .. 3 (the
// lightest, at the horizon). Distance alone lightens the sea; the outer
// shelf stops where it reaches this stop, so no dark ring rims the island.
function oceanIndexAt(wy) {
    const toward = Math.max(0, 1 - (wy - OCEAN_HORIZON_WORLD_Y) / OCEAN_LIGHT_REACH);
    return Math.min(3, toward * 3.6);
}

function css255(rgb01) {
    return rgb01.map(channel => Math.round(Math.max(0, Math.min(1, channel)) * 255));
}

function hexTo01(hex) {
    return hexRgb(hex).map(channel => channel / 255);
}

// The ocean palette: the deepest stop, three lighter stops toward the
// horizon, then two haze courses meeting the sky's horizon colour.
function oceanPalette(atmosphere, gpuGraded) {
    const mood = waterMoodFor(atmosphere);
    const grade = atmosphere?.lightGrade || null;
    const stops = [
        COAST_WATER_STOPS[4],
        COAST_WATER_STOPS[3],
        COAST_WATER_STOPS[2],
        mixRgb(COAST_WATER_STOPS[2], COAST_WATER_STOPS[1], 0.5),
    ];
    const sunBand = Math.max(0, Math.min(1, Number(grade?.sunBand) || 0));
    const water = stops.map((rgb) => {
        let c = applyWaterMood(rgb.map(channel => channel / 255), mood);
        if (gpuGraded && grade) {
            // Mirror what the resident scene pass does to island water
            // albedo (cool cast, water sun band, then the C2 grade), so the
            // ocean meets the island's own deepest stop without a seam.
            const band = 1 + (0.86 - 1) * sunBand;
            c = c.map((channel, k) => Math.min(1, channel * WATER_CAST[k] * band));
            c = applyGradeToRgb(c, grade);
        }
        return css255(c);
    });
    // The sky plate's own final horizon colour (SkyRenderer), so the top
    // courses meet it exactly; the grade's horizon haze is the fallback.
    let haze = colourTo01(atmosphere?.sky?.palette?.haze)
        || colourTo01(grade?.horizonHaze)
        || colourTo01(atmosphere?.sky?.palette?.horizon)
        || hexTo01('#8fb9cf');
    if (!gpuGraded && grade && typeof CanvasGrade.ungradeRgb === 'function') {
        // Canvas grades the whole frame afterwards: paint the preimage so the
        // haze lands on the sky's own horizon course.
        haze = CanvasGrade.ungradeRgb(haze, grade);
    }
    const hazeRgb = css255(haze);
    return {
        water,
        // Horizon -> sea: haze, then two courses stepping into the lightest stop.
        haze: [hazeRgb, mixRgb(water[3], hazeRgb, 0.6), mixRgb(water[3], hazeRgb, 0.28)],
    };
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

function oceanKey(atmosphere, gpuGraded) {
    const palette = oceanPalette(atmosphere, gpuGraded);
    const q = rgb => rgb.map(channel => channel >> 2).join('.');
    const fog = Math.round(Math.max(0, Math.min(1, atmosphere?.weather?.fog ?? 0)) * 4);
    return {
        palette,
        fog,
        key: `${gpuGraded ? 'g' : 'c'}|${palette.water.map(q).join(',')}|${palette.haze.map(q).join(',')}|${fog}`,
    };
}

// One band texel: `i` the world texel column, `j` the texel row below the
// horizon.
function oceanTexel(i, j, spec, hazeRows) {
    const { water, haze } = spec.palette;
    const im = ((i % OCEAN_PERIOD) + OCEAN_PERIOD) % OCEAN_PERIOD;
    const index = oceanIndexAt(OCEAN_HORIZON_WORLD_Y + (j + 0.5) * OCEAN_TEXEL);
    let stop = Math.floor(index);
    const frac = index - stop;
    if (stop < 3 && frac > 0.62 && (frac - 0.62) / 0.38 > bayer(im, j)) stop += 1;
    let rgb = water[stop];
    // Three static swell rows toward the horizon (no animation): broken,
    // gently undulating crests, runs of 2-5 texels, the row stepping up or
    // down one texel every 16.
    for (const swell of [12, 30, 52]) {
        const row = swell + Math.floor(hash2(im >> 4, swell, 3) * 3) - 1;
        if (j === row && hash2(im >> 2, swell, 11) < 0.3 && hash2(im, swell, 13) < 0.8) {
            rgb = water[Math.min(3, stop + 1)];
        }
    }
    // Haze courses at the very top meet the sky's horizon colour: haze ->
    // two mixed courses -> the sea, ordered dither between.
    if (j < hazeRows) {
        const p = (j / hazeRows) * haze.length;
        const k = Math.floor(p);
        const next = k + 1 < haze.length ? haze[k + 1] : rgb;
        rgb = p - k > bayer(im, j) ? next : haze[k];
    }
    return rgb;
}

function bakeOcean(state, spec) {
    const hazeRows = 4 + spec.fog * 2;
    const { water } = spec.palette;
    // The horizon band, one period wide, tiled sideways at draw time.
    const strip = state.strip ||= document.createElement('canvas');
    strip.width = OCEAN_PERIOD;
    strip.height = OCEAN_BAND_ROWS;
    const band = new ImageData(OCEAN_PERIOD, OCEAN_BAND_ROWS);
    for (let j = 0; j < OCEAN_BAND_ROWS; j++) {
        for (let i = 0; i < OCEAN_PERIOD; i++) {
            const rgb = oceanTexel(i, j, spec, hazeRows);
            const o = (j * OCEAN_PERIOD + i) * 4;
            band.data[o] = rgb[0];
            band.data[o + 1] = rgb[1];
            band.data[o + 2] = rgb[2];
            band.data[o + 3] = 255;
        }
    }
    strip.getContext('2d').putImageData(band, 0, 0);
    // Sun/moon glitter column: sparse specks one stop lighter than the sea
    // around them, drawn under the body's screen x each frame.
    const glint = state.glint ||= document.createElement('canvas');
    const cols = OCEAN_GLINT_HALF * 2 + 1;
    glint.width = cols;
    glint.height = OCEAN_GLINT_ROWS;
    const image = new ImageData(cols, OCEAN_GLINT_ROWS);
    for (let j = hazeRows + 1; j < OCEAN_GLINT_ROWS; j++) {
        const stop = Math.floor(oceanIndexAt(OCEAN_HORIZON_WORLD_Y + (j + 0.5) * OCEAN_TEXEL));
        const rgb = water[Math.min(3, stop + 1)];
        const reach = OCEAN_GLINT_HALF - Math.min(4, j >> 4);
        for (let d = -reach; d <= reach; d++) {
            if (hash2(d, j, 5) >= 0.18 * (1 - j / OCEAN_GLINT_ROWS)) continue;
            const o = (j * cols + d + OCEAN_GLINT_HALF) * 4;
            image.data[o] = rgb[0];
            image.data[o + 1] = rgb[1];
            image.data[o + 2] = rgb[2];
            image.data[o + 3] = 255;
        }
    }
    glint.getContext('2d').putImageData(image, 0, 0);
    state.deep = rgbCss(water[0]);
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

/**
 * Draw the outer ocean (world space, camera transform applied) over every
 * visible pixel below the horizon: the horizon band (one period strip tiled
 * sideways, the glint under the sun or moon), then the deepest stop as one
 * flat fill. The band canvases are quarter resolution, scaled
 * nearest-neighbour, and rebaked only when the quantized palette
 * (grade/mood/haze) or fog changes, at most about once a second outside
 * weather flips.
 */
export function drawOuterOcean(ctx, renderer, atmosphere, { gpuGraded = false } = {}) {
    const view = visibleWorldRect(ctx);
    if (!view || view.y1 <= OCEAN_HORIZON_WORLD_Y) return;
    const state = renderer._outerOcean || (renderer._outerOcean = { key: '', bakedAt: -Infinity });
    const now = performance.now();
    const spec = oceanKey(atmosphere, gpuGraded);
    const weatherKey = `${atmosphere?.weather?.type || 'clear'}|${gpuGraded}`;
    const due = now - state.bakedAt >= OCEAN_REBAKE_MIN_MS || state.weatherKey !== weatherKey;
    if (!state.strip || (state.key !== spec.key && due)) {
        const started = performance.now();
        bakeOcean(state, spec);
        state.key = spec.key;
        state.weatherKey = weatherKey;
        state.bakedAt = now;
        state.bakeMs = performance.now() - started;
    }
    const top = OCEAN_HORIZON_WORLD_Y;
    const bandH = OCEAN_BAND_ROWS * OCEAN_TEXEL;
    const period = OCEAN_PERIOD * OCEAN_TEXEL;
    const left = Math.floor(view.x0 / OCEAN_TEXEL) * OCEAN_TEXEL - OCEAN_TEXEL;
    const right = Math.ceil(view.x1 / OCEAN_TEXEL) * OCEAN_TEXEL + OCEAN_TEXEL;
    ctx.save();
    ctx.imageSmoothingEnabled = false;
    if (view.y0 < top + bandH) {
        for (let x = Math.floor(left / period) * period; x < right; x += period) {
            ctx.drawImage(state.strip, x, top, period, bandH);
        }
        const sky = atmosphere?.sky;
        const body = sky?.sun?.visible ? sky.sun : sky?.moon?.visible ? sky.moon : null;
        if (body) {
            const wx = view.x0 + (body.xFrac ?? 0.5) * (view.x1 - view.x0);
            const gx = Math.round(wx / OCEAN_TEXEL) * OCEAN_TEXEL - OCEAN_GLINT_HALF * OCEAN_TEXEL;
            ctx.drawImage(state.glint, gx, top, state.glint.width * OCEAN_TEXEL, OCEAN_GLINT_ROWS * OCEAN_TEXEL);
        }
    }
    const deepTop = Math.max(top + bandH, Math.floor(view.y0 / OCEAN_TEXEL) * OCEAN_TEXEL);
    if (view.y1 > deepTop) {
        ctx.fillStyle = state.deep;
        ctx.fillRect(left, deepTop, right - left, Math.ceil(view.y1 - deepTop) + OCEAN_TEXEL);
    }
    ctx.restore();
}
