// GroundBake — the land surface as one art-directed bake (plan items 3.2,
// 3.3, 4.7 and the ground half of 4.2 in
// the Opus 5.5 aesthetic plan; W1.1 / W1.2 of the visual-ultimate plan).
//
// Replaces per-tile land stamping (square Wang cells stretched into the iso
// diamond, per-tile tone diamonds, 1×1 flecks, cube-shaped vegetation
// sprites) with a pixel bake at full world density (W1.1, X-5): every colour
// decision is made per world px (COLOR_TEXEL_W = 1) on the 2560 × 1280 ground
// canvas, while the published semantic fields (class field, puddle mask,
// ground weather field) keep their 2 × 1 grid (FIELD_TEXEL_W = 2), each
// coarse cell taking its right-hand fine sample (2c + 1, r) — the old texel
// centre's east side — with a material guard so a mixed land / water pair
// never wets the water. Per texel:
//   1. class field   grass / sand / dirt / yard / road / plaza from the tile
//                    sets, bilinear between tile centres, thresholded with an
//                    organic noise offset only where the ground is soft:
//                    earth shoulders and unpaved yards take 0.12–0.15 tiles
//                    of edge noise, laid stone (avenues 0.03, flag yards
//                    0.03, the plaza 0.02) runs true. Avenues carry no earth
//                    shoulder: they end at a kerb. Sand and the waterline
//                    come from Water's coast field (CoastBake.js); a coast
//                    `bankZone` (E0) suppresses sand where a bank face stands.
//   2. paving units  laid stone is individual stones on one 2:1 lattice
//                    (TerrainTileset `stoneAt`): each stone has its body stop,
//                    a lit NW lip, a shaded SE lip, 1 px mortar joints, its
//                    own macro drift, 6 % hairline cracks and moss in the
//                    4-way joints near turf. The Command Plaza is a running
//                    bond with a cool-limestone share, forecourt flags and the
//                    octagonal fountain compass medallion; avenues are setts
//                    laid along each route (segmental fan courses on the civic
//                    arms, a worn centre line) behind 3 px jointed kerbs; the
//                    flag yards are dressed flags, the Forge yard basalt
//                    cobbles, the Mine / Harbor / Watchtower yards faceted
//                    scree and the Task board yard rutted earth. No Bayer
//                    static on stone (dither only at the AO collar's outer
//                    seam, the grass tuck and the sand / marsh seams).
//   3. soft grounds  dirt, earth and sand read the land Wang sheets as
//                    luminance sources in true 2:1 iso orientation, switched
//                    between variants along noise contours.
//   4. meadow        calm 3–5 tile macro sweeps (one ramp step either side of
//                    the mean, dithered only at their seams) with district
//                    warmth drift (drier by the workshops, lusher under the
//                    canopy) and the forest floor half a step darker; then
//                    authored inline stamps: Poisson-disc tufts by mowing
//                    zone, bramble / fern / clover shrubs and the OA-T3 edge
//                    vocabulary (blades over the path above, a crease and
//                    pebbles over the path below, dune tufts and a wrack line
//                    on the beach).
//   5. contact AO    ramp-step darkening outside building footprints (including
//                    authored plinth front edges for Command, Tavern, Forge,
//                    Archive and Portal, moved down to the foot of an E1
//                    footing), under tree crowns/World Ash root buttresses
//                    and props; on paving up to PAVING_AO_CAP (0.68, ~2.15
//                    ramp steps close to masonry).
//   6. thresholds    authored worn-earth corridors from each door along its
//                    frontage spur, lighter along the trodden centre line.
//   7. living ground (plan 5.1 and 5.4 of the Waking Isle plan) a chamfer
//                    distance from grass to the paths (5-10-11 weights on the
//                    1×1 lattice) and a crown field pushed downwind under
//                    every tree place clustered micro-detail: an unmown verge
//                    along every path, twigs, moss and needle duff under
//                    crowns, weeds at wall bases, rare meadow pockets; by
//                    season, autumn litter, dry-grass patches, spring petals,
//                    winter leaf mould.
//   8. decals        sparse clusters: meadow flower pockets, tufts, shrubs,
//                    bank reeds, pebbles.
//   9. footings (E1) each landmark's `footing` profile (buildingGrounding.js)
//                    paints its dais, terrace riser or rock headland under the
//                    sprite's front edges, at most 10 rows tall.
//
// Registered as terrain bake pass 'ground-splat' (stage 'ground'). The result
// is cached here per season/ground stage/scenery/coast revision, so a terrain-cache rebake
// for any other reason reuses it. Zero per-frame cost; reduced-motion neutral
// (static); reads no phase, weather or camera — the grade owns time of day.
// The one exception is the winter ground (plan 5.2): the C-W2 ground
// history's snow bucket and frost re-tone a copy of the base bake (≤ 4 bakes
// a day), never the live weather.
//
// The bake runs in slices of at most GROUND_BAND_ROWS rows and
// GROUND_SLICE_MS of work, with quantized transient planes (Int16 coast
// distance, Uint8 chamfer and crown distance).
//
// Publishes `renderer.groundField` (class per 2×1 texel) for Water's coast
// pass and any later ground consumer, with `renderer.groundField.weather`
// (item 5: the RGBA8 ground weather field, layout in GroundWeatherField.js),
// and `renderer.groundPuddleMask` (5.2: the R8 puddle-site mask, one byte
// per 2×1 texel) for the puddle courses.

import { ART_RAMPS } from '../../config/artPalette.js';
import { MAP_SIZE, TILE_WIDTH, TILE_HEIGHT } from '../../config/constants.js';
import { DISTRICT_PROPS, FOREST_FLOOR_REGIONS, WORLD_TREE } from '../../config/scenery.js';
import { TOWN_ROAD_ROUTES, YARD_MATERIALS } from '../../config/townPlan.js';
import { BUILDING_GROUNDING_PROFILES, FOOTING_MAX_ROWS } from '../../config/buildingGrounding.js';
import {
    AXIS_FRAME, MEDALLION_RAMP, STONE_LATTICES, STONE_ROLE, latticeHash, lipOffset, medallionAt,
    readTerrainCellLuma, specularCorner, stoneAt, stoneFrame, stoneRole,
} from './TerrainTileset.js';
import { buildingCenterToWorld, tileToWorld } from './Projection.js';
import { getCoastField } from './CoastBake.js';
import { frostQuarterOf, frostRisingOf, snowBucketOf } from './GroundState.js';
import { frostHolds, frostShadeField, frostShadeKey } from './FrostMelt.js';
import { TREE_SPRITES, treeSpriteKey } from './FoliageRenderer.js';
import { releaseCanvasBackingStore } from './CanvasBudget.js';
import { lookStrength } from './LookStrengths.js';
import {
    BARE_CROWN_COVER, EAVE_REACH, GROUND_WEATHER_TEXEL_W, GROUND_WEATHER_X0, GROUND_WEATHER_Y0, packGroundWeather, validGroundWeather,
} from './GroundWeatherField.js';

export const GROUND_CLASS = Object.freeze({
    NONE: 0,
    GRASS: 1,
    DIRT: 2,
    ROAD: 3,
    PLAZA: 4,
    SAND: 5,
    WATER: 6,
});

// X-5 — the colour lattice is one decision per world px (the canvas was
// always 2560 px wide, so VRAM is unchanged); the published fields stay on
// the 2×1 grid every consumer (GroundWeatherField, FrostMelt's shade, the
// puddle courses, WorldFrameRenderer) reads.
export const GROUND_COLOR_TEXEL_W = 1;
export const GROUND_FIELD_TEXEL_W = 2;
const COLOR_TEXEL_W = GROUND_COLOR_TEXEL_W;
const FIELD_TEXEL_W = GROUND_FIELD_TEXEL_W;
const HALF_W = TILE_WIDTH / 2;
const HALF_H = TILE_HEIGHT / 2;

// Slicing: a yield at least every GROUND_BAND_ROWS rows and as soon as a
// slice has worked GROUND_SLICE_MS (the diamond's middle rows are the widest).
const GROUND_BAND_ROWS = 64;
const GROUND_SLICE_MS = 8;
// The transient working-set ceiling of one base bake (the large typed
// planes it holds at once, accounted in `stats.peakBytes`).
export const GROUND_BAKE_BUDGET = Object.freeze({ bandRows: GROUND_BAND_ROWS, sliceMs: GROUND_SLICE_MS, peakBytes: 56 * 1024 * 1024 });

// The coast's signed distance per texel, quantized to 1/256 tile (Int16);
// > 0 exactly where the distance is > 0 (written inline by the main loop).
// Texels outside the island diamond keep SD_UNVISITED.
const SD_SCALE = 256;
const SD_UNVISITED = -32768;

// The colour-lattice columns [SPAN[0], SPAN[1]] of row `row` that lie inside
// the island diamond (with a 2-texel margin; empty when SPAN[0] > SPAN[1]):
// every full-lattice pass skips the empty corners of the bounding box.
const SPAN = new Int32Array(2);
function diamondSpan(row, cols, texelW = COLOR_TEXEL_W) {
    const N = MAP_SIZE;
    const sy = -HALF_H + row + 0.5;
    const x0 = -N * HALF_W;
    const sxLo = Math.max(-HALF_W - 2 * sy, 2 * sy - TILE_WIDTH * (N - 0.5));
    const sxHi = Math.min(HALF_W + 2 * sy, TILE_WIDTH * (N - 0.5) - 2 * sy);
    SPAN[0] = Math.max(0, Math.floor((sxLo - x0) / texelW) - 2);
    SPAN[1] = Math.min(cols - 1, Math.ceil((sxHi - x0) / texelW) + 2);
    return SPAN;
}

// The stop plane carries the ramp stop (bits 0–2) and two flags: the kerb
// row + 1 (bits 3–4) and a bake-owned footing face (bit 6, never snowed).
const STOP_MASK = 7;
const KERB_SHIFT = 3;
const KERB_MASK = 3 << KERB_SHIFT;
const FOOTING_FLAG = 64;
export const GROUND_STOP_FLAGS = Object.freeze({ STOP_MASK, KERB_SHIFT, KERB_MASK, FOOTING: FOOTING_FLAG });

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
// The flag yards laid in the cool limestone sibling (the Tavern's is warm).
const COOL_FLAG_YARDS = new Set(['archive', 'portal']);

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
const PLAZA_COOL = ramp('plazaCool');
const CINDER = ramp('cinder');
const SAND = ramp('sand');
const STONE = ramp('stone');
const FOLIAGE = ramp('foliage');
const TIMBER = ramp('timber');
const OCHRE = ramp('clothOchre');
const LEAF = ramp('leafAutumn');
const BLOSSOM = ramp('blossom');
const ASHLAR = ramp('ashlar');
const CLIFF = ramp('cliff');
const TIDELINE = ramp('tideline');
// Grass drift ramps derived from C1 (same value ladder, shifted hue): dry
// grass leans toward the earth ramp, lush grass toward the sage foliage.
const GRASS_DRY = GRASS.map((c, i) => mixRgb(c, DIRT[Math.max(0, i - 1)], 0.18));
const GRASS_LUSH = GRASS.map((c, i) => mixRgb(c, FOLIAGE[Math.min(4, i + 1)], 0.18));
// The terrain cache's far-row haze (IsometricRenderer
// `_bakeAtmosphericPerspective`): six flat courses, far apex first, each
// multiplied over the baked ground (half-strength cool tint toward white),
// so no land texel keeps its raw ramp colour. Exported so the cache-matching
// palette steps below can name the colours the cache really holds.
const HAZE_PROFILE = [[0, [196, 214, 232]], [0.5, [232, 240, 248]], [1, [255, 255, 255]]];
export const TERRAIN_HAZE_COURSES = Object.freeze(Array.from({ length: 6 }, (_, course) => {
    const t = (course + 0.5) / 6;
    const k = t < 0.5 ? 0 : 1;
    const [t0, c0] = HAZE_PROFILE[k];
    const [t1, c1] = HAZE_PROFILE[k + 1];
    const f = (t - t0) / (t1 - t0);
    return Object.freeze(c0.map((c, i) => Math.round(255 - (255 - (c + (c1[i] - c) * f)) * 0.5)));
}));
// W6.11 — the grass gust course's palette step: [from, to] pairs, a grass
// ramp's stop 3 (the verge stems and the meadow's upper course) to its stop
// 4, under each haze course (the canvas multiply rounds a·h/255). The GPU
// scene and the Canvas overlay match `from` exactly on the terrain cache and
// write `to`, so a lifted texel keeps its row's haze.
const hazed = (rgb, h) => Object.freeze(rgb.map((c, i) => Math.round(c * h[i] / 255)));
export const GRASS_GUST_STOPS = Object.freeze([GRASS, GRASS_DRY, GRASS_LUSH].flatMap((r) => TERRAIN_HAZE_COURSES
    .map((h) => Object.freeze([hazed(r[3], h), hazed(r[4], h)])))
    .filter((pair, i, all) => all.findIndex(other => other[0].join() === pair[0].join()) === i));

// Every colour a texel can take is a stop of one of these ramps.
const R_GRASS = 0;
const R_GRASS_DRY = 1;
const R_GRASS_LUSH = 2;
const R_SAND = 3;
const R_DIRT = 4;
const R_ROAD = 5;
const R_PLAZA = 6;
const R_COOL = 7;
const R_CINDER = 8;
const RAMP_TABLE = [GRASS, GRASS_DRY, GRASS_LUSH, SAND, DIRT, ROAD, PLAZA, PLAZA_COOL, CINDER];

// Per surface: ramp, texture set (soft grounds only), ramp offset (steps),
// texture contrast, published class. W1.1 — grass no longer reads a drawing
// (its stop is the macro sweep's), and laid stone is built from units.
const SURFACES = [
    /* grass  */ { ramp: GRASS, tex: null, offset: 0, contrast: 0, cls: GROUND_CLASS.GRASS },
    /* sand   */ { ramp: SAND, tex: 'sand', offset: -0.2, contrast: 0.8, cls: GROUND_CLASS.SAND },
    /* dirt   */ { ramp: DIRT, tex: 'dirt', offset: 0, contrast: 1.0, cls: GROUND_CLASS.DIRT },
    /* road   */ { ramp: ROAD, tex: null, offset: 0, contrast: 0, cls: GROUND_CLASS.ROAD },
    /* plaza  */ { ramp: PLAZA, tex: null, offset: 0, contrast: 0, cls: GROUND_CLASS.PLAZA },
    /* flag   */ { ramp: PLAZA_COOL, tex: null, offset: 0, contrast: 0, cls: GROUND_CLASS.PLAZA },
    /* gravel */ { ramp: ROAD, tex: null, offset: 0, contrast: 0, cls: GROUND_CLASS.ROAD },
    /* cinder */ { ramp: CINDER, tex: null, offset: 0, contrast: 0, cls: GROUND_CLASS.DIRT },
    /* earth  */ { ramp: DIRT, tex: 'earth', offset: 0.3, contrast: 0.95, cls: GROUND_CLASS.DIRT },
];

// C-02 (2026-11-21) — varied paving: civic stone takes moderate macro value
// drift (now per stone, sampled at its centre) so laid paving holds natural
// weathering within one stone family, and a tighter plinth contact-AO collar
// up to PAVING_AO_CAP (× 3.2 ≈ 2.15 ramp steps within 6–10 world px of masonry).
const PAVING_DRIFT_SHARE = 0.32;
const PAVING_AO_CAP = 0.68;
const isPavingSurface = (s) => s === S_ROAD || s === S_PLAZA || s === S_FLAG || s === S_GRAVEL;
// Every non-turf land surface a blade can overhang.
const isPath = (s) => s !== 255 && s !== S_GRASS && s !== S_SAND;

// W1.1 — body-stop weights per stone family (b ∈ {1, 2, 3}), measured on
// the real village so each family's mean luma (lips, mortar, kerbs, the
// medallion and AO included) stays within ~4 of v0.67.2's surface and the
// land mean within ~1 (the golden-hours noon gate allows 2.5): the plaza and
// its forecourt one notch under the spec's {5, 45, 50} %, the flag yards
// (once −0.55 steps) and the avenue setts (once −0.45) lower still.
const BODY_WEIGHTS = Object.freeze({
    plaza: Object.freeze([0.1, 0.5, 0.4]),
    forecourt: Object.freeze([0.05, 0.45, 0.5]),
    flag: Object.freeze([0.35, 0.45, 0.2]),
    sett: Object.freeze([0.35, 0.55, 0.1]),
});
const PLAZA_COOL_SHARE = 0.3;
const STONE_CRACK_SHARE = 0.06;
const STONE_SPECULAR_SHARE = 0.25;
// Moss in the 4-way mortar joints: near turf, elsewhere, and the flag
// yards' doubled share (a quieter, older pavement).
const MOSS_NEAR = 0.22;
const MOSS_FAR = 0.05;
const MOSS_NEAR_ROWS = 6;
// The avenue's worn centre line (|t| rows from the route's axis).
const WORN_HALF_ROWS = 5.6;

// Texture sources: full-class cells of the land Wang sheets (cell 0 = all
// lower class, 15 = all upper class). Colours are discarded; only the
// luminance drawing is kept and re-toned onto the ramps. Only the soft
// grounds read a drawing since W1.1: dirt, the yard earth (the loam drawing
// mirrored, a period of its own beside the dirt paths), sand with a second
// period, and marsh reed in place of sand on freshwater (river and lagoon)
// banks. Trailing source fields are transforms, applied in order: 'mirror'
// flips the drawing, 'destripe' strips the full-length row and column lines
// the tileset model rolls into organic ground (a cell repeats every tile, so
// such a line draws the tile grid across a whole district).
const TEXTURE_SOURCES = Object.freeze({
    dirt: [['terrain.grass-dirt', 15]],
    earth: [['terrain.grass-dirt', 15, 'mirror']],
    sand: [['terrain.grass-shore', 15], ['terrain.sand-alt', 15, 'destripe']],
    marsh: [['terrain.marsh-reed', 15, 'destripe']],
});
// Marsh reed takes over sand where the bilinear freshwater share of the
// tile's depth caps (river 2, lagoon 3) does, its silt half a ramp step
// darker.
const FRESHWATER_CAP = 3;
const MARSH_OFFSET = -0.5;
const SURFACE_VARIANT_SCALE = 2.2;

// ---- tile codes and layer membership --------------------------------------

// Sand and water are not tile layers: both come from the coast field.
const T_GRASS = 0;
const T_DIRT = 1;
const T_ROAD = 2;
const T_PLAZA = 3;
const T_YARD = 4;
const T_YARD_PAVED = 5;
const T_AVENUE = 6;

const M_DIRT = 1;
const M_YARD = 2;
const M_ROAD = 4;
const M_PLAZA = 8;

// W1.1 — avenues and the plaza meet the grass at a kerb (no earth shoulder);
// lanes and docks keep theirs.
const TILE_MASK = [
    /* grass */ 0,
    /* dirt  */ M_DIRT,
    /* road (lane, dock) */ M_DIRT | M_ROAD,
    /* plaza */ M_ROAD | M_PLAZA,
    /* yard  */ M_YARD,
    /* paved yard */ M_ROAD | M_YARD,
    /* avenue */ M_ROAD,
];

// Ordered layers: later wins. `amp` is the organic edge offset (tiles of
// membership), `jitter` a per-texel offset, `thr` the threshold. Paved yards
// also count as road, so stone meets stone without an earth seam; a yard's
// own edge is laid true when it is paved (`pavedAmp`).
const LAYERS = [
    { bit: M_DIRT, thr: 0.47, amp: 0.15, jitter: 0.025, surface: S_DIRT },
    { bit: M_ROAD, thr: 0.48, amp: 0.03, jitter: 0, surface: S_ROAD },
    { bit: M_YARD, thr: 0.5, amp: 0.12, jitter: 0.025, pavedAmp: 0.03, surface: -1 },
    { bit: M_PLAZA, thr: 0.5, amp: 0.02, jitter: 0, surface: S_PLAZA },
];
const ROAD_THR = LAYERS[1].thr;
// Kerb depth (rows inward from the road layer's edge).
const KERB_ROWS = 3;

// District drift anchors (4.7/3.2): warmth > 0 dries the grass toward earth,
// < 0 cools it toward sage; value shifts ramp steps. Gaussian, ~6-tile reach.
const DISTRICT_DRIFT = Object.freeze({
    forge: { warm: 0.75, value: 0.1 },
    mine: { warm: 0.6, value: 0 },
    taskboard: { warm: 0.4, value: 0.1 },
    command: { warm: 0.15, value: 0.15 },
    harbor: { warm: 0.3, value: 0.1 },
    archive: { warm: -0.6, value: -0.1 },
    tavern: { warm: -0.35, value: 0 },
    portal: { warm: -0.5, value: -0.2 },
    watchtower: { warm: -0.3, value: -0.1 },
});

const BAYER = [0, 2, 3, 1].map(v => v / 4 - 0.375);
// 5.4 — grass inside the forest floors sits half a ramp step darker.
const FOREST_FLOOR_STEP = 0.5;
const FOREST_ZONE = 0.45;

// ---- noise ----------------------------------------------------------------

const hash2 = latticeHash;

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

// Smooth static fields sampled SUB_PER_TILE times per tile (from tile −1)
// and read bilinearly: the 1×1 lattice never pays a value noise per texel
// for a field that varies over tiles.
const SUB_PER_TILE = 4;
const SUB_N = (MAP_SIZE + 2) * SUB_PER_TILE + 1;
const subGrids = new Map();
function subGrid(id, fn) {
    let grid = subGrids.get(id);
    if (grid) return grid;
    grid = new Float32Array(SUB_N * SUB_N);
    for (let j = 0; j < SUB_N; j++) {
        const ty = -1 + j / SUB_PER_TILE;
        for (let i = 0; i < SUB_N; i++) grid[j * SUB_N + i] = fn(-1 + i / SUB_PER_TILE, ty);
    }
    subGrids.set(id, grid);
    return grid;
}
function subSample(grid, tx, ty) {
    let gx = (tx + 1) * SUB_PER_TILE;
    let gy = (ty + 1) * SUB_PER_TILE;
    if (gx < 0) gx = 0; else if (gx > SUB_N - 1.001) gx = SUB_N - 1.001;
    if (gy < 0) gy = 0; else if (gy > SUB_N - 1.001) gy = SUB_N - 1.001;
    const xi = gx | 0;
    const yi = gy | 0;
    const fx = gx - xi;
    const fy = gy - yi;
    const i = yi * SUB_N + xi;
    const top = grid[i] + (grid[i + 1] - grid[i]) * fx;
    const bottom = grid[i + SUB_N] + (grid[i + SUB_N + 1] - grid[i + SUB_N]) * fx;
    return top + (bottom - top) * fy;
}
// 2.6 — the meadow's macro sweeps: broad flat sun and shade patches of 3–5
// tiles (the drift's own 0.5 share is added per texel).
const sweepGrid = () => subGrid('sweep', (tx, ty) => 1.6 * (vnoise(tx / 4.2, ty / 4.2, 61) - 0.5)
    + 0.8 * (vnoise(tx / 1.9 + 11, ty / 1.9, 62) - 0.5));
const sandWidthGrid = () => subGrid('sand', (tx, ty) => vnoise(tx / 2.6, ty / 2.6, 21));
const seasonPatchGrid = (salt) => subGrid(`season${salt}`, (tx, ty) => vnoise(tx / 2.6, ty / 2.6, salt));

// 1D runs along screen x (row-independent, so a joint across a kerb is one
// vertical line): bit 0 marks a run's first px, bit 1 the run's parity.
const runCache = new Map();
function runs(id, min, max, salt) {
    let marks = runCache.get(id);
    if (marks) return marks;
    const cols = MAP_SIZE * TILE_WIDTH;
    marks = new Uint8Array(cols + 16);
    let x = Math.floor(hash2(salt, 3, 7) * max);
    for (let k = 0; x < marks.length; k++) {
        const len = min + Math.floor(hash2(k, salt, 11) * (max - min + 1));
        for (let j = 0; j < len && x + j < marks.length; j++) marks[x + j] = (j === 0 ? 1 : 0) | ((k & 1) << 1);
        x += len;
    }
    runCache.set(id, marks);
    return marks;
}
// Kerb blocks of 6 or 8 px; the turf crease breaks every 5–9 px; OA-T3
// blade anchors every 5–7 px; dune tufts every 7–11; path-crease pebbles
// every 9–15; wrack dashes every 7–15.
const kerbBlocks = () => runs('kerb', 6, 8, 1601);
const creaseBreaks = () => runs('crease', 5, 9, 1611);
const bladeAnchors = () => runs('blade', 5, 7, 1621);
const duneAnchors = () => runs('dune', 7, 11, 1631);
const pebbleRuns = () => runs('pebble', 9, 15, 1641);
// The wrack line's dashes: 2–4 px every 7–15 px, 1 drift timber, 2 weed.
let wrackCache = null;
function wrackDashes() {
    if (wrackCache) return wrackCache;
    const cols = MAP_SIZE * TILE_WIDTH;
    wrackCache = new Uint8Array(cols + 16);
    for (let k = 0, x = 0; x < wrackCache.length; k++) {
        const period = 7 + Math.floor(hash2(k, 0, 1651) * 9);
        const dash = 2 + Math.floor(hash2(k, 1, 1651) * 3);
        const tone = hash2(k, 2, 1651) < 0.5 ? 1 : 2;
        for (let j = 0; j < dash && x + j < wrackCache.length; j++) wrackCache[x + j] = tone;
        x += period;
    }
    return wrackCache;
}

// ---- inputs ---------------------------------------------------------------

function buildTileGrid(r) {
    const N = MAP_SIZE;
    const code = new Uint8Array(N * N);
    const yardSurface = new Uint8Array(N * N);
    const yardCool = new Uint8Array(N * N);
    // W1.1 — avenue tiles end at a kerb. `renderer.avenueTiles` when the
    // renderer publishes it; until then the paved set less the tiles whose
    // authored route material is a lane or a dock.
    const avenueSet = r.avenueTiles instanceof Set ? r.avenueTiles : null;
    const material = r.roadMaterialTiles instanceof Map ? r.roadMaterialTiles : null;
    const avenue = (key) => (avenueSet ? avenueSet.has(key)
        : !(material && (material.get(key) === 'lane' || material.get(key) === 'dock')));
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
            else if (r.mainAvenueTiles?.has(key) || bridge) c = avenue(key) ? T_AVENUE : T_ROAD;
            else if (r.dirtPathTiles?.has(key) || r.pathTiles?.has(key)) c = T_DIRT;
            code[i] = c;
            if (yard) {
                yardSurface[i] = YARD_SURFACE_IDS[yard.surface] ?? S_EARTH;
                yardCool[i] = COOL_FLAG_YARDS.has(yardType) ? 1 : 0;
            }
        }
    }
    return { code, yardSurface, yardCool };
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
            let v = (vnoise(x / 6.5, y / 6.5, 3) - 0.5) * 1.58 + (vnoise(x / 2.4 + 19, y / 2.4 + 7, 5) - 0.5) * 0.78;
            let w = (vnoise(x / 7.5 + 40, y / 7.5, 9) - 0.5) * 1.28;
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

// Bilinear read of a tile-centre grid at fractional tile (tx, ty).
function bilin(grid, tx, ty) {
    const N = MAP_SIZE;
    let ix = Math.floor(tx);
    let iy = Math.floor(ty);
    const fx = tx - ix;
    const fy = ty - iy;
    const x0 = ix < 0 ? 0 : ix >= N ? N - 1 : ix;
    const y0 = iy < 0 ? 0 : iy >= N ? N - 1 : iy;
    ix += 1;
    iy += 1;
    const x1 = ix < 0 ? 0 : ix >= N ? N - 1 : ix;
    const y1 = iy < 0 ? 0 : iy >= N ? N - 1 : iy;
    return (grid[y0 * N + x0] * (1 - fx) + grid[y0 * N + x1] * fx) * (1 - fy)
        + (grid[y1 * N + x0] * (1 - fx) + grid[y1 * N + x1] * fx) * fy;
}

function readTextures(r) {
    const out = {};
    const assets = r.assets;
    for (const [name, sources] of Object.entries(TEXTURE_SOURCES)) {
        const list = [];
        for (const [id, cell, ...transforms] of sources) {
            const image = assets?.get?.(id, { request: false }) ?? null;
            let luma = image ? readTerrainCellLuma(image, cell) : null;
            if (!luma) continue;
            for (const transform of transforms) luma = TEXTURE_TRANSFORMS[transform](luma);
            list.push(clipTexture(luma));
        }
        if (!list.length) list.push(proceduralTexture(name.length * 17));
        out[name] = list;
    }
    return out;
}

// Removes each column's and row's mean (the separable stripe component) and
// re-normalises to unit deviation: a line running the whole cell goes, the
// 2D grain around it stays.
function destripeTexture(t) {
    const colMean = new Float32Array(32);
    const rowMean = new Float32Array(32);
    for (let v = 0; v < 32; v++) {
        for (let u = 0; u < 32; u++) {
            colMean[u] += t[v * 32 + u] / 32;
            rowMean[v] += t[v * 32 + u] / 32;
        }
    }
    const out = new Float32Array(t.length);
    let variance = 0;
    for (let v = 0; v < 32; v++) {
        for (let u = 0; u < 32; u++) {
            const z = t[v * 32 + u] - colMean[u] - rowMean[v];
            out[v * 32 + u] = z;
            variance += z * z;
        }
    }
    const sd = Math.sqrt(Math.max(1e-6, variance / out.length));
    for (let i = 0; i < out.length; i++) out[i] /= sd;
    return out;
}

// Punch-through guard: a drawing's sparse highlights or joints past ±Z_CLIP
// deviations would land two ramp stops off the surface and sparkle; clip
// them so grain stays grain.
const Z_CLIP = 1.8;
function clipTexture(t) {
    return Float32Array.from(t, (z) => (z > Z_CLIP ? Z_CLIP : z < -Z_CLIP ? -Z_CLIP : z));
}

// Horizontal mirror of a 32x32 luminance texture: a new period from the same
// authored drawing.
function mirrorTexture(t) {
    const out = new Float32Array(t.length);
    for (let v = 0; v < 32; v++) {
        for (let u = 0; u < 32; u++) out[v * 32 + u] = t[v * 32 + (31 - u)];
    }
    return out;
}

const TEXTURE_TRANSFORMS = Object.freeze({ mirror: mirrorTexture, destripe: destripeTexture });

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

// ---- W1.1 avenue frames ----------------------------------------------------

// Every authored route segment as a lattice frame for its setts: tile-space
// start (on the route's true centre line: a 2-wide brush is centred half a
// tile off its polyline), unit direction, cumulative length (so courses run
// on across a bend), the lip faces, and whether it is an avenue (worn
// centre line) or a civic arm (segmental fan courses). Static.
const FAN_ROUTES = new Set(['civic-west-arm', 'civic-east-arm']);
const ROAD_FRAME_REACH = 1.6;
let roadFrames = null;
function getRoadFrames() {
    if (roadFrames) return roadFrames;
    const N = MAP_SIZE;
    const segs = [];
    for (const route of TOWN_ROAD_ROUTES) {
        const width = Math.max(1, route.width || 1);
        const off = (-Math.floor((width - 1) / 2) + Math.floor(width / 2)) / 2;
        const points = route.points || [];
        let s0 = 0;
        for (let i = 0; i < points.length - 1; i++) {
            const ax = points[i][0] + off;
            const ay = points[i][1] + off;
            const bx = points[i + 1][0] + off;
            const by = points[i + 1][1] + off;
            const len = Math.hypot(bx - ax, by - ay);
            if (len < 1e-6) continue;
            const du = (bx - ax) / len;
            const dv = (by - ay) / len;
            segs.push({ ax, ay, du, dv, len, s0, avenue: route.material === 'avenue', fan: FAN_ROUTES.has(route.id), frame: stoneFrame(du, dv) });
            s0 += len;
        }
    }
    // Up to three nearest segments per tile, refined per texel.
    const cand = new Int16Array(N * N * 3).fill(-1);
    const dist = [0, 0, 0];
    for (let y = 0; y < N; y++) {
        for (let x = 0; x < N; x++) {
            const base = (y * N + x) * 3;
            dist[0] = dist[1] = dist[2] = Infinity;
            segs.forEach((s, k) => {
                const d = segDistance(s, x, y);
                if (d > ROAD_FRAME_REACH + 0.75) return;
                for (let j = 0; j < 3; j++) {
                    if (d < dist[j]) {
                        for (let m = 2; m > j; m--) { dist[m] = dist[m - 1]; cand[base + m] = cand[base + m - 1]; }
                        dist[j] = d;
                        cand[base + j] = k;
                        break;
                    }
                }
            });
        }
    }
    roadFrames = { segs, cand };
    return roadFrames;
}

function segDistance(s, x, y) {
    const px = x - s.ax;
    const py = y - s.ay;
    let t = px * s.du + py * s.dv;
    t = t < 0 ? 0 : t > s.len ? s.len : t;
    return Math.hypot(px - s.du * t, py - s.dv * t);
}

// The Command Plaza's medallion centre: the civic fountain (scenery.js).
const CIVIC_FOUNTAIN = DISTRICT_PROPS.find(p => p.id === 'prop.runeFountain' && p.district === 'civic') || null;

// LANDMARK_PLINTH_FALLBACKS — authored painted-base plinth fallbacks
// (matching bake-surface-channel.mjs) for hero stone landmarks whose logical
// footprint sits behind their SW walls.
const LANDMARK_PLINTH_FALLBACKS = Object.freeze({
    archive: Object.freeze({ left: Object.freeze([40, 172]), bottom: Object.freeze([212, 230]), right: Object.freeze([300, 190]) }),
    portal: Object.freeze({ left: Object.freeze([36, 193]), bottom: Object.freeze([175, 258]), right: Object.freeze([275, 207]) }),
});

const _worldAshRootCache = new WeakMap();
const ASH_ROOT_ROWS = 72;

// Exact lower-72-row root-buttress distance & crevice field for `veg.tree.ash.world`
// (240x271, anchor [120, 270]). Returns null when assets or DOM canvas are absent.
function getWorldAshRootField(r, tree) {
    const sprite = TREE_SPRITES['ash.world'];
    const source = r.assets?.get?.(sprite.id, { request: false });
    if (!source || !source.width || typeof document === 'undefined') return null;
    let cached = _worldAshRootCache.get(source);
    if (!cached) {
        const w = sprite.width;
        const yStart = sprite.height - ASH_ROOT_ROWS;
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = ASH_ROOT_ROWS;
        const ctx = canvas.getContext?.('2d', { willReadFrequently: true });
        if (!ctx?.drawImage || !ctx?.getImageData) return null;
        ctx.drawImage(source, 0, yStart, w, ASH_ROOT_ROWS, 0, 0, w, ASH_ROOT_ROWS);
        const rgba = ctx.getImageData(0, 0, w, ASH_ROOT_ROWS).data;
        if (!rgba) return null;
        let opaqueCount = 0;
        const opaque = new Uint8Array(w * ASH_ROOT_ROWS);
        for (let i = 0; i < opaque.length; i++) {
            if (rgba[i * 4 + 3] > 128) { opaque[i] = 1; opaqueCount++; }
        }
        if (opaqueCount === 0) return null;
        // Exact min-distance in world px (clamped to 12) + concave root-bay score.
        const dist = new Float32Array(w * ASH_ROOT_ROWS).fill(12);
        const bay = new Uint8Array(w * ASH_ROOT_ROWS);
        const maxR = 10;
        for (let y = 0; y < ASH_ROOT_ROWS; y++) {
            for (let x = 0; x < w; x++) {
                const idx = y * w + x;
                if (opaque[idx]) { dist[idx] = 0; continue; }
                let best2 = 144;
                for (let dy = -maxR; dy <= maxR; dy++) {
                    const yy = y + dy;
                    if (yy < 0 || yy >= ASH_ROOT_ROWS) continue;
                    for (let dx = -maxR; dx <= maxR; dx++) {
                        const xx = x + dx;
                        if (xx < 0 || xx >= w || !opaque[yy * w + xx]) continue;
                        const d2 = dx * dx + dy * dy;
                        if (d2 < best2) best2 = d2;
                    }
                }
                dist[idx] = Math.sqrt(best2);
                // Check if nestled in a root crotch (opaque root within 16 px left & right, or above).
                let hitL = 0, hitR = 0, hitUp = 0;
                for (let k = 1; k <= 16; k++) {
                    if (x - k >= 0 && opaque[y * w + (x - k)]) hitL = 1;
                    if (x + k < w && opaque[y * w + (x + k)]) hitR = 1;
                    if (k <= 8 && y - k >= 0 && opaque[(y - k) * w + x]) hitUp = 1;
                }
                if ((hitL && hitR) || (hitUp && (hitL || hitR))) bay[idx] = 1;
            }
        }
        cached = { w, h: ASH_ROOT_ROWS, anchorX: w / 2, anchorY: ASH_ROOT_ROWS - 1, opaque, dist, bay };
        _worldAshRootCache.set(source, cached);
    }
    const world = tileToWorld(tree.tileX, tree.tileY);
    return {
        ...cached,
        leftX: Math.round(world.x) - cached.anchorX,
        topY: Math.round(world.y) - cached.anchorY,
    };
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
        const profile = BUILDING_GROUNDING_PROFILES[b.type];
        const minX = b.position.tileX - 0.5;
        const minY = b.position.tileY - 0.5;
        // EY-3 — `shelter`: the share of the snow its contact AO keeps off
        // (buildingGrounding.js; an open frame like the Task board spares little).
        const shelter = profile?.shelter ?? 1;
        // EN-3 — the painted plinth's front edges where the profile has them.
        const plinth = plinthOccluder(r, b, profile, minX, minY);
        if (plinth) add({ ...plinth, reach: 0.95, strength: 1, shelter }, 1.4);
        else add({ kind: 0, minX, minY, maxX: minX + b.width, maxY: minY + b.height, reach: 0.95, strength: 1, shelter }, 1.4);
    }
    const treeProps = r.scenery?.getTreeProps?.() || [];
    let hasWorldAsh = false;
    const addTreeOccluder = (t) => {
        if (t.species === 'ash' || t.size === 'world') {
            hasWorldAsh = true;
            const world = tileToWorld(t.tileX, t.tileY);
            const wx = world.x - 3;
            const wy = world.y - 28;
            const cx = (wx / HALF_W + wy / HALF_H) * 0.5;
            const cy = (wy / HALF_H - wx / HALF_W) * 0.5;
            const ashField = getWorldAshRootField(r, t);
            add({
                kind: 3, wx, wy, rx: 78, ry: 44, cx, cy,
                minX: cx - 1.7, maxX: cx + 1.7, minY: cy - 1.7, maxY: cy + 1.7,
                reach: 1.0, strength: ashField ? 0.62 : 0.92, shelter: 1, ashField,
            }, 1.3);
            return;
        }
        if (t.size === 'tall') {
            const world = tileToWorld(t.tileX, t.tileY);
            const wx = world.x;
            const wy = world.y - 6;
            const cx = (wx / HALF_W + wy / HALF_H) * 0.5;
            const cy = (wy / HALF_H - wx / HALF_W) * 0.5;
            add({
                kind: 3, wx, wy, rx: 28, ry: 15, cx, cy,
                minX: cx - 0.5, maxX: cx + 0.5, minY: cy - 0.5, maxY: cy + 0.5,
                reach: 1.0, strength: 0.90, shelter: 1,
            }, 0.7);
            return;
        }
        const small = t.size === 'small';
        const cx = t.tileX - 0.04;
        const cy = t.tileY - 0.04;
        const reach = small ? 0.36 : 0.48;
        add({ kind: 1, cx, cy, minX: cx, maxX: cx, minY: cy, maxY: cy, reach, strength: small ? 0.78 : 0.86, shelter: 1 }, reach + 0.1);
    };
    for (const t of treeProps) addTreeOccluder(t);
    if (!hasWorldAsh && r.scenery?.isWorldTreeIsletTile) {
        addTreeOccluder({ tileX: WORLD_TREE.tileX, tileY: WORLD_TREE.tileY, species: 'ash', size: 'world', variant: 0 });
    }
    for (const p of r._staticPropSprites || []) {
        if (p.id === 'fantasy.tree') continue;
        const cx = p.tileX;
        const cy = p.tileY;
        add({ kind: 1, cx, cy, minX: cx, maxX: cx, minY: cy, maxY: cy, reach: 0.34, strength: 0.55, shelter: 1 }, 0.4);
    }
    return buckets;
}

// Item 5 — building footprints bucketed for the weather field's eaves and
// long sun shade (SUN_SHADE_REACH tiles on the down-light sides, the contact
// AO's own asymmetry stretched).
const SUN_SHADE_REACH = 1.6;
function buildSunOccluders(r) {
    const N = MAP_SIZE;
    const buckets = new Array(N * N);
    for (const b of r.world?.buildings?.values?.() || []) {
        // The drawn base: sprites stand on [tileX, tileX + width] in the
        // bake's tile coordinates (Projection.buildingCenterToWorld), half a
        // tile down-screen of the contact AO's logical footprint.
        const minX = b.position.tileX;
        const minY = b.position.tileY;
        // EY-3 — the eaves spare the rain by the profile's shelter share too,
        // so the ground under the open Task board wets.
        const shelter = BUILDING_GROUNDING_PROFILES[b.type]?.shelter ?? 1;
        const occ = { minX, minY, maxX: minX + b.width, maxY: minY + b.height, shelter };
        const reach = SUN_SHADE_REACH * 1.4;
        for (let y = Math.max(0, Math.floor(minY - reach)); y <= Math.min(N - 1, Math.ceil(occ.maxY + reach)); y++) {
            for (let x = Math.max(0, Math.floor(minX - reach)); x <= Math.min(N - 1, Math.ceil(occ.maxX + reach)); x++) {
                (buckets[y * N + x] ||= []).push(occ);
            }
        }
    }
    return buckets;
}

// Eave cover (full within 60 % of EAVE_REACH of the wall, then fading) and
// sun shade (1 at the wall's foot, 0 at SUN_SHADE_REACH on the down-light
// sides, far shorter on the lit sides), 0–1 each, into `out`.
function sunShadeAt(bucket, tx, ty, out) {
    let eave = 0;
    let shade = 0;
    for (let i = 0; i < bucket.length; i++) {
        const o = bucket[i];
        const dx = tx < o.minX ? o.minX - tx : tx > o.maxX ? tx - o.maxX : 0;
        const dy = ty < o.minY ? o.minY - ty : ty > o.maxY ? ty - o.maxY : 0;
        const d = Math.hypot(dx, dy);
        const e = (d < EAVE_REACH * 0.6 ? 1 : d < EAVE_REACH ? (EAVE_REACH - d) / (EAVE_REACH * 0.4) : 0) * o.shelter;
        if (e > eave) eave = e;
        const ex = tx < o.minX ? dx / 0.35 : dx / 1.35;
        const ey = ty < o.minY ? dy / 0.6 : dy / 1.0;
        const s = 1 - Math.hypot(ex, ey) / SUN_SHADE_REACH;
        if (s > shade) shade = s;
    }
    out[0] = eave;
    out[1] = shade > 0 ? shade ** 0.7 : 0;
}

// EN-3 — a building's painted plinth front edges in world px: the profile's
// `plinth` points (sprite px of base.png, the surface channel's own anchors)
// or the landmark fallback, placed through the sprite anchor. Null without a
// plinth or the sprite anchor.
function plinthWorld(r, b, profile) {
    const base = profile?.plinth || LANDMARK_PLINTH_FALLBACKS[b.type];
    const anchor = base && r.assets?.getAnchor?.(`building.${b.type}`);
    if (!anchor || (!profile?.plinth && !anchor[0] && !anchor[1])) return null;
    const centre = buildingCenterToWorld(b);
    const at = ([px, py]) => ({ x: centre.x + px - anchor[0], y: centre.y + py - anchor[1] });
    return { left: at(base.left), bottom: at(base.bottom), right: at(base.right) };
}

// EN-3 — a building's contact occluder on its painted plinth, turned into
// the bake's tile coordinates. Its front sides are the two authored edges
// (left → bottom faces +ty, bottom → right faces +tx), each with its outward
// unit normal; the back sides stay the logical footprint's, under the
// sprite. E1 — an authored footing moves the front edges down by its
// `aoShiftRows`, so the ground's contact shadow starts at the footing's foot.
function plinthOccluder(r, b, profile, minX, minY) {
    const world = plinthWorld(r, b, profile);
    if (!world) return null;
    const shift = profile?.footing?.aoShiftRows || 0;
    const tile = ({ x, y }) => {
        const sy = y + shift;
        return { x: x / TILE_WIDTH + sy / TILE_HEIGHT, y: sy / TILE_HEIGHT - x / TILE_WIDTH };
    };
    const left = tile(world.left);
    const corner = tile(world.bottom);
    const right = tile(world.right);
    const normal = (a, c, axis) => {
        const dx = c.x - a.x;
        const dy = c.y - a.y;
        const len = Math.hypot(dx, dy) || 1;
        const n = { x: dy / len, y: -dx / len };
        return n[axis] >= 0 ? n : { x: -n.x, y: -n.y };
    };
    return {
        kind: 2, minX, minY, corner,
        maxX: Math.max(corner.x, right.x, left.x), maxY: Math.max(corner.y, left.y, right.y),
        ny: normal(left, corner, 'y'),
        nx: normal(corner, right, 'x'),
    };
}

// `sheltered`: each occluder weighted by its shelter share (EY-3: the snow
// the eaves keep off), instead of the contact AO itself.
function occlusionAt(bucket, tx, ty, sheltered = false) {
    let ao = 0;
    for (let i = 0; i < bucket.length; i++) {
        const o = bucket[i];
        let d;
        if (o.kind === 2) {
            // EN-3 — beyond the painted plinth's front edges, as kind 0.
            const ox = tx - o.corner.x;
            const oy = ty - o.corner.y;
            const beyondX = ox * o.nx.x + oy * o.nx.y;
            const beyondY = ox * o.ny.x + oy * o.ny.y;
            const ex = beyondX > 0 ? beyondX / 1.35 : tx < o.minX ? (o.minX - tx) / 0.65 : 0;
            const ey = beyondY > 0 ? beyondY / 1.0 : ty < o.minY ? (o.minY - ty) / 0.8 : 0;
            if (ex === 0 && ey === 0) {
                if (!sheltered) return 1;
                if (o.shelter > ao) ao = o.shelter;
                continue;
            }
            d = Math.sqrt(ex * ex + ey * ey);
        } else if (o.kind === 0) {
            // Down-light sides (+tx is screen lower-right, +ty lower-left)
            // take the longer contact shadow; the lit up-left side the least.
            const ex = tx < o.minX ? (o.minX - tx) / 0.65 : tx > o.maxX ? (tx - o.maxX) / 1.35 : 0;
            const ey = ty < o.minY ? (o.minY - ty) / 0.8 : ty > o.maxY ? (ty - o.maxY) / 1.0 : 0;
            if (ex === 0 && ey === 0) {
                if (!sheltered) return 1;
                if (o.shelter > ao) ao = o.shelter;
                continue;
            }
            d = Math.sqrt(ex * ex + ey * ey);
        } else if (o.kind === 3) {
            const sx = (tx - ty) * HALF_W;
            const sy = (tx + ty) * HALF_H;
            let baseAo = 0;
            const dEll = Math.hypot((sx - o.wx) / o.rx, (sy - o.wy) / o.ry);
            if (dEll < o.reach) {
                baseAo = (1 - dEll / o.reach) ** 1.5 * o.strength;
            }
            if (o.ashField) {
                const fx = Math.floor(sx - o.ashField.leftX);
                const fy = Math.floor(sy - o.ashField.topY);
                if (fx >= 0 && fy >= 0 && fx < o.ashField.w && fy < o.ashField.h) {
                    const idx = fy * o.ashField.w + fx;
                    const dp = o.ashField.dist[idx];
                    const reachPx = o.ashField.bay[idx] ? 9.5 : 6.5;
                    if (dp < reachPx) {
                        const rootAo = dp === 0 ? 1 : (1 - dp / reachPx) ** 1.35 * (o.ashField.bay[idx] ? 0.98 : 0.88);
                        if (rootAo > baseAo) baseAo = rootAo;
                    }
                }
            }
            const a = baseAo * (sheltered ? o.shelter : 1);
            if (a > ao) ao = a;
            continue;
        } else {
            d = Math.hypot(tx - o.cx, (ty - o.cy) * 1.15);
        }
        if (d >= o.reach) continue;
        const a = (1 - d / o.reach) ** 1.5 * o.strength * (sheltered ? o.shelter : 1);
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
            segs.push({ ax: a.x, ay: a.y, bx: end.x, by: end.y, paved: b.type === 'command', type: b.type });
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

// W1.1 — the district yards' own fixtures: the Command forecourt (Chebyshev
// FORECOURT_REACH tiles of the keep's footprint), the Forge door (rust dust
// on its cobbles), the Mine footprint (doubled scree), and the Task board's
// frontage spur (twin cart ruts).
const FORECOURT_REACH = 2;
function buildYardPlan(r) {
    const plan = { forecourt: null, forgeDoor: null, mine: null };
    for (const b of r.world?.buildings?.values?.() || []) {
        const rect = { minX: b.position.tileX - 0.5, minY: b.position.tileY - 0.5, maxX: b.position.tileX + b.width - 0.5, maxY: b.position.tileY + b.height - 0.5 };
        if (b.type === 'command') plan.forecourt = rect;
        else if (b.type === 'mine') plan.mine = rect;
        else if (b.type === 'forge' && b.entrance) plan.forgeDoor = { x: b.entrance.tileX, y: b.entrance.tileY };
    }
    const fountain = CIVIC_FOUNTAIN && r.townSquareTiles?.has?.(`${Math.round(CIVIC_FOUNTAIN.tileX)},${Math.round(CIVIC_FOUNTAIN.tileY)}`)
        ? { x: CIVIC_FOUNTAIN.tileX, y: CIVIC_FOUNTAIN.tileY } : null;
    plan.medallion = fountain;
    return plan;
}
const chebyshevOut = (rect, tx, ty) => Math.max(rect.minX - tx, tx - rect.maxX, rect.minY - ty, ty - rect.maxY, 0);

// The road layer's membership at fractional tile (tx, ty), with the same
// organic edge offset the main loop applies (the road layer reads 1 − fbm).
function roadMembership(mask, tx, ty) {
    const N = MAP_SIZE;
    const ix = Math.floor(tx);
    const iy = Math.floor(ty);
    const fx = tx - ix;
    const fy = ty - iy;
    const xa = ix < 0 ? 0 : ix > N - 1 ? N - 1 : ix;
    const xb = ix + 1 < 0 ? 0 : ix + 1 > N - 1 ? N - 1 : ix + 1;
    const ya = iy < 0 ? 0 : iy > N - 1 ? N - 1 : iy;
    const yb = iy + 1 < 0 ? 0 : iy + 1 > N - 1 ? N - 1 : iy + 1;
    const b00 = mask[ya * N + xa] & M_ROAD ? 1 : 0;
    const b10 = mask[ya * N + xb] & M_ROAD ? 1 : 0;
    const b01 = mask[yb * N + xa] & M_ROAD ? 1 : 0;
    const b11 = mask[yb * N + xb] & M_ROAD ? 1 : 0;
    const sum = b00 + b10 + b01 + b11;
    if (sum === 4) return 1;
    if (sum === 0) return 0;
    const v = b00 * (1 - fx) * (1 - fy) + b10 * fx * (1 - fy) + b01 * (1 - fx) * fy + b11 * fx * fy;
    return v + (0.5 - fbm(tx * 1.7, ty * 1.7, 11)) * 2 * LAYERS[1].amp;
}

// ---- W1.1 unit painters (scratch objects, no per-texel allocation) --------

const UNIT = { id: 0, lu: 0, lv: 0, col: 0, course: 0 };
// `lip`: 0 body, 1 lit lip, 2 shaded lip, 3 mortar (the debug stone map).
const PAVE = { ramp: 0, stop: 0, cross: false, lip: 0 };

function bodyStop(h, w) {
    return h < w[0] ? 1 : h < w[0] + w[1] ? 2 : 3;
}

// One stone texel on lattice L at row-unit point (s, t) in `frame`, written
// into PAVE: the stone's family ramp, its stop and whether the texel is a
// 4-way mortar cross. `drift` is the macro value at the stone's centre.
// Independent per-stone draws: h0 the body stop, h1 the worn lift and the
// crack's place, h2 crack / specular corner / crown speck, g the cool
// family and the glancing lips.
function stoneTexel(s, t, L, frame, salt, weights, ramp, coolShare, mortarRamp, drift, worn) {
    stoneAt(s, t, L, salt, UNIT);
    const role = stoneRole(UNIT.lu, UNIT.lv, L);
    PAVE.cross = role === STONE_ROLE.CROSS;
    if (role <= STONE_ROLE.CROSS) {
        PAVE.ramp = mortarRamp;
        PAVE.stop = worn ? 1 : 0;
        PAVE.lip = 3;
        return PAVE;
    }
    const id = UNIT.id;
    const h0 = (id & 0xffff) / 65536;
    const h1 = ((id >>> 16) & 0xff) / 256;
    const h2 = (id >>> 24) / 256;
    const g = latticeHash(UNIT.col, UNIT.course, salt + 7);
    const gBits = (g * 65536) | 0;
    let b = bodyStop(h0, weights) + Math.round(drift * PAVING_DRIFT_SHARE);
    if (worn && h1 < 0.6) b += 1;
    b = b < 1 ? 1 : b > 3 ? 3 : b;
    PAVE.ramp = coolShare > 0 && g < coolShare ? R_COOL : ramp;
    PAVE.lip = 0;
    // Hairline crack: a 3-texel mortar notch from the low-s corner along +s.
    if (h2 < STONE_CRACK_SHARE) {
        const cv = 2 + Math.floor(h1 * Math.max(1, L.sv - 4));
        if (UNIT.lv >= cv && UNIT.lv < cv + 1 && UNIT.lu < 4) {
            PAVE.ramp = mortarRamp;
            PAVE.stop = 0;
            PAVE.lip = 3;
            return PAVE;
        }
    }
    if (role === STONE_ROLE.BODY) {
        // A worn sett's crown speck: one lit texel at its centre.
        if (worn && h2 > 0.8 && UNIT.lu >= L.su / 2 && UNIT.lu < L.su / 2 + 1 && UNIT.lv >= L.sv / 2 && UNIT.lv < L.sv / 2 + 1) {
            PAVE.stop = 4;
            return PAVE;
        }
        PAVE.stop = b;
        return PAVE;
    }
    if (h2 >= 0.75 - STONE_SPECULAR_SHARE && h2 < 0.75 && specularCorner(UNIT.lu, UNIT.lv, L, frame)) {
        PAVE.stop = Math.min(4, b + 2);
        PAVE.lip = 1;
        return PAVE;
    }
    const offset = lipOffset(role, frame, (gBits & 1) !== 0, (gBits & 2) !== 0);
    PAVE.stop = b + offset;
    PAVE.lip = offset > 0 ? 1 : offset < 0 ? 2 : 0;
    return PAVE;
}

// The macro drift at the centre of the stone UNIT holds, for a lattice laid
// along the axes (frame null) or along route segment `seg`.
function stoneDrift(drift, L, seg) {
    const sc = (UNIT.col + 0.5) * L.su - (UNIT.course & 1) * L.bondU;
    const tc = (UNIT.course + 0.5) * L.sv;
    if (!seg) return bilin(drift, sc / 32, tc / 32);
    const along = sc / 32 - seg.s0;
    const across = tc / 32;
    return bilin(drift, seg.ax + along * seg.du - across * seg.dv, seg.ay + along * seg.dv + across * seg.du);
}

// Faceted scree (gravel yards): one chip per 8 × 3 px cell (two, all 3 × 2,
// by the Mine), its top row road[3], body road[2], the row under it road[0];
// the bed between chips road[1].
function screeStop(col, row, dense) {
    const cx = col >> 3;
    const cy = Math.floor(row / 3);
    let under = false;
    for (let dy = 0; dy >= -1; dy--) {
        const yy = cy + dy;
        const chips = dense ? 2 : 1;
        for (let j = 0; j < chips; j++) {
            const big = dense || hash2(cx, yy, 1801 + j * 7) < 0.4;
            const w = big ? 3 : 2;
            const h = big ? 2 : 1;
            const px = cx * 8 + Math.floor(hash2(cx, yy, 1803 + j * 7) * (9 - w));
            const py = yy * 3 + Math.floor(hash2(cx, yy, 1805 + j * 7) * (4 - h));
            if (col < px || col >= px + w) continue;
            if (row >= py && row < py + h) return row === py ? 3 : 2;
            if (row === py + h) under = true;
        }
    }
    return under ? 0 : 1;
}

// Basalt cobbles (the Forge yard): Voronoi cells on a jittered 7 × 5-row
// grid; a 1-row edge is mortar, the edge toward the key one stop lit, the
// far edge one stop shaded; 8 % soot pockets; rust dust by the Forge door.
const COBBLE = { id: 0, edge: 0, face: 0 };
function cobbleAt(U, V) {
    const cx = Math.floor(U / 7);
    const cy = Math.floor(V / 5);
    let d1 = Infinity;
    let d2 = Infinity;
    let p1x = 0, p1y = 0, p2x = 0, p2y = 0, g1x = 0, g1y = 0;
    for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
            const gx = cx + dx;
            const gy = cy + dy;
            const sx = gx * 7 + 3.5 + (hash2(gx, gy, 1901) - 0.5) * 5;
            const sy = gy * 5 + 2.5 + (hash2(gx, gy, 1903) - 0.5) * 5;
            const d = (U - sx) * (U - sx) + (V - sy) * (V - sy);
            if (d < d1) {
                d2 = d1; p2x = p1x; p2y = p1y;
                d1 = d; p1x = sx; p1y = sy; g1x = gx; g1y = gy;
            } else if (d < d2) {
                d2 = d; p2x = sx; p2y = sy;
            }
        }
    }
    const nx = p2x - p1x;
    const ny = p2y - p1y;
    const len = Math.hypot(nx, ny) || 1;
    COBBLE.edge = (d2 - d1) / (2 * len);
    COBBLE.id = Math.floor(hash2(g1x, g1y, 1907) * 4294967296) >>> 0;
    // The edge's outward normal (toward the neighbour) against the key.
    const f = (nx * -3 + ny * -1) / (len * Math.sqrt(10));
    COBBLE.face = f > 0.3 ? 1 : f < -0.3 ? -1 : 0;
    return COBBLE;
}

// Contact AO in whole ramp steps. Bayer only at the collar's outer seam
// (half a step either side of the first step), never across the collar.
const AO_SEAM_LO = 0.3;
const AO_SEAM_HI = 0.7;
function aoStepRound(aoSteps, dither) {
    return Math.round(aoSteps > AO_SEAM_LO && aoSteps < AO_SEAM_HI ? aoSteps + dither * 0.8 : aoSteps);
}

// ---- bake -----------------------------------------------------------------

function groundFieldFrom({ bounds, cols, rows, texelW, classes, weather }) {
    return {
        bounds,
        cols,
        rows,
        texelW,
        classes,
        // GroundWeatherField.js: the RGBA8 weather field on this grid.
        weather,
        CLASS: GROUND_CLASS,
        classAt(worldX, worldY) {
            const col = Math.floor((worldX - bounds.x) / texelW);
            const row = Math.floor(worldY - bounds.y);
            if (col < 0 || row < 0 || col >= cols || row >= rows) return GROUND_CLASS.NONE;
            return classes[row * cols + col];
        },
    };
}

// `withWeather`: build the ground weather field (GroundWeatherField.js) in
// the same pass. Only on first need (groundWeatherWanted): at looks 0 nothing
// of it is allocated, baked or saved. `options.debug` also returns the
// per-texel stone map (tests and tools only).
export function bakeGround(r, withWeather = false, options = {}) {
    const bands = groundBands(r, withWeather, options);
    let step = bands.next();
    while (!step.done) step = bands.next();
    return step.value;
}

// The same bake as a generator of labelled slices (each `next()` one slice;
// the value names the pass it paused in) — the off-frame path and its tests.
export function groundBakeSlices(r, withWeather = false, options = {}) {
    return groundBands(r, withWeather, options);
}

const CROWN_DIST_SCALE = 64;

// The base bake in slices: yields between row bands and inside its later
// passes, returns the bake. `ms` counts only the time spent baking.
function* groundBands(r, withWeather = false, options = {}) {
    let busy = 0;
    let started = performance.now();
    const clock = { start: started, slices: 1, maxMs: 0 };
    const pause = () => {
        const now = performance.now();
        busy += now - started;
        if (now - clock.start > clock.maxMs) clock.maxMs = now - clock.start;
    };
    const resume = () => { started = clock.start = performance.now(); clock.slices++; };
    const due = () => performance.now() - clock.start >= GROUND_SLICE_MS;
    // Drives an inner pass generator, pausing the busy clock at its yields.
    const run = function* (gen, label) {
        let step = gen.next();
        while (!step.done) { pause(); yield typeof step.value === 'string' ? `${label}:${step.value}` : label; resume(); step = gen.next(); }
        return step.value;
    };
    // The bake's large typed planes, accounted as they are held and let go.
    const mem = { live: 0, peak: 0 };
    const hold = (buf) => {
        mem.live += buf.byteLength;
        if (mem.live > mem.peak) mem.peak = mem.live;
        return buf;
    };
    const drop = (buf) => { if (buf) mem.live -= buf.byteLength; return null; };

    const N = MAP_SIZE;
    const x0 = -N * HALF_W;
    const y0 = -HALF_H;
    const w = N * TILE_WIDTH;
    const h = N * TILE_HEIGHT;
    const cols = w / COLOR_TEXEL_W;
    const rows = h;
    const fcols = w / FIELD_TEXEL_W;
    const coast = getCoastField(r);
    // E0 — the coast's bank zones (CoastBake, once it publishes them).
    const bankZone = coast.bankZone instanceof Uint8Array && coast.bankZone.length === N * N ? coast.bankZone : null;
    const { code, yardSurface, yardCool } = buildTileGrid(r);
    const mask = new Uint8Array(N * N);
    for (let i = 0; i < mask.length; i++) mask[i] = TILE_MASK[code[i]];
    const drift = buildDriftGrid(r);
    const textures = readTextures(r);
    const occluders = buildOccluders(r);
    const wear = buildWearSegments(r);
    const yardPlan = buildYardPlan(r);
    const frames = getRoadFrames();
    const sweep = sweepGrid();
    const sandGrid = sandWidthGrid();
    const kerbRuns = kerbBlocks();
    const season = r._terrainSeason || 'summer';
    const winter = season === 'winter';
    // 1 where the tile's depth cap is a river's or lagoon's (land inherits
    // the cap of water within a tile), sampled bilinearly for the marsh bank.
    const freshwater = new Float32Array(N * N);
    for (let i = 0; i < freshwater.length; i++) freshwater[i] = coast.caps?.[i] <= FRESHWATER_CAP ? 1 : 0;
    // The Task board's ruts run along its frontage spur.
    const rutSegs = [];
    for (const list of wear) for (const s of list || []) if (s.type === 'taskboard' && !rutSegs.includes(s)) rutSegs.push(s);

    let image = new ImageData(w, h);
    hold(image.data);
    const D = image.data;
    const surfaces = hold(new Uint8Array(cols * rows).fill(255));
    let sdBuf = hold(new Int16Array(cols * rows).fill(SD_UNVISITED));
    const aoBuf = hold(new Uint8Array(cols * rows));
    // Ramp stop index per texel (and the kerb / footing flags), so the
    // living-ground pass can re-tone grass on the same value ladder.
    const stepBuf = hold(new Uint8Array(cols * rows));
    const unitMap = options.debug ? new Uint32Array(cols * rows) : null;
    const moss = [];
    const mossScale = winter ? 0.5 : 1;

    for (let row = 0; row < rows; row++) {
        if (row > 0 && (row % GROUND_BAND_ROWS === 0 || due())) { pause(); yield 'base'; resume(); }
        const sy = y0 + row + 0.5;
        const sxLo = Math.max(-HALF_W - 2 * sy, 2 * sy - TILE_WIDTH * (N - 0.5));
        const sxHi = Math.min(HALF_W + 2 * sy, TILE_WIDTH * (N - 0.5) - 2 * sy);
        if (sxHi < sxLo) continue;
        const cLo = Math.max(0, Math.floor(sxLo - x0 - 0.5) - 1);
        const cHi = Math.min(cols - 1, Math.ceil(sxHi - x0 - 0.5) + 1);
        const rowBase = row * cols;
        for (let col = cLo; col <= cHi; col++) {
            const sx = x0 + col + 0.5;
            const tx = sx / TILE_WIDTH + sy / TILE_HEIGHT;
            const ty = sy / TILE_HEIGHT - sx / TILE_WIDTH;
            if (tx < -0.5 || ty < -0.5 || tx >= N - 0.5 || ty >= N - 0.5) continue;
            const ti = rowBase + col;

            // Waterline from Water's coast field. Water pixels belong to the
            // coast pass; the dry sand runs 0.3 tile under its waterline so
            // the two never gap.
            const sd = coast.signedDistance(tx, ty);
            const sq = Math.round(sd * SD_SCALE);
            sdBuf[ti] = sd > 0 ? (sq < 1 ? 1 : sq > 32767 ? 32767 : sq) : (sq < -32767 ? -32767 : sq > 0 ? 0 : sq);
            if (sd > 0.3) continue;

            const ix = Math.floor(tx);
            const iy = Math.floor(ty);
            const fx = tx - ix;
            const fy = ty - iy;
            const x0i = ix < 0 ? 0 : ix;
            const x1i = ix + 1 > N - 1 ? N - 1 : ix + 1;
            const y0i = iy < 0 ? 0 : iy;
            const y1i = iy + 1 > N - 1 ? N - 1 : iy + 1;
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
            let edgeNoise = -1;

            let surface = S_GRASS;
            let lip = 0;
            let tuck = 0;
            // E0 — no beach where a bank face stands.
            // Inside the diamond Math.round(tx | ty) is always a tile index.
            const tileI = Math.round(ty) * N + Math.round(tx);
            const banked = bankZone !== null && bankZone[tileI] !== 0 && sd > -1;
            if (!banked && sd > -0.85) {
                const sandWidth = 0.18 + 0.5 * subSample(sandGrid, tx, ty);
                const jitter = (hash2(col, row, 5) - 0.5) * 0.05;
                if (sd > 0 || sd > -sandWidth + jitter) surface = S_SAND;
                else if (sd > -sandWidth - 0.08) tuck = 1;
            }

            let vRoad = 2;
            let gRoadX = 0;
            let gRoadY = 0;
            let plazaShare = 0;
            let yardBest = -1;
            for (let li = 0; li < LAYERS.length; li++) {
                const L = LAYERS[li];
                if (!(any & L.bit)) continue;
                let amp = L.amp;
                let jit = L.jitter;
                if (L.surface < 0) {
                    // Yard: the material of the strongest yard corner.
                    let bestW = -1;
                    if ((m00 & M_YARD) && w00 > bestW) { yardBest = i00; bestW = w00; }
                    if ((m10 & M_YARD) && w10 > bestW) { yardBest = i10; bestW = w10; }
                    if ((m01 & M_YARD) && w01 > bestW) { yardBest = i01; bestW = w01; }
                    if ((m11 & M_YARD) && w11 > bestW) { yardBest = i11; bestW = w11; }
                    if (yardSurface[yardBest] === S_FLAG) { amp = L.pavedAmp; jit = 0; }
                }
                let v;
                if (all & L.bit) {
                    v = 1;
                } else {
                    const b00 = m00 & L.bit ? 1 : 0;
                    const b10 = m10 & L.bit ? 1 : 0;
                    const b01 = m01 & L.bit ? 1 : 0;
                    const b11 = m11 & L.bit ? 1 : 0;
                    v = b00 * w00 + b10 * w10 + b01 * w01 + b11 * w11;
                    if (L.bit === M_PLAZA) plazaShare = v;
                    if (edgeNoise < 0) edgeNoise = fbm(tx * 1.7, ty * 1.7, 11);
                    const n = li & 1 ? 1 - edgeNoise : edgeNoise;
                    v += (n - 0.5) * 2 * amp + (jit ? (hash2(col, row, 6) - 0.5) * 2 * jit : 0);
                    if (L.bit === M_ROAD) {
                        vRoad = v;
                        gRoadX = (b10 - b00) * (1 - fy) + (b11 - b01) * fy;
                        gRoadY = (b01 - b00) * (1 - fx) + (b11 - b10) * fx;
                    }
                }
                if (L.bit === M_PLAZA && all & L.bit) plazaShare = 1;
                if (v > L.thr) {
                    surface = L.surface < 0 ? yardSurface[yardBest] : L.surface;
                    lip = v - L.thr < 0.06 ? 1 : 0;
                    tuck = 0;
                } else if (L.thr - v < 0.07 && (surface === S_GRASS || surface === S_SAND)) {
                    tuck = 1;
                }
            }

            // Worn-to-the-door thresholds.
            let wearStep = 0;
            const wb = wear[tileI];
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
            const ob = occluders[tileI];
            const ao = ob ? occlusionAt(ob, tx, ty) : 0;
            aoBuf[ti] = Math.round(ao * 255);

            const macro = drift.value[i00] * w00 + drift.value[i10] * w10 + drift.value[i01] * w01 + drift.value[i11] * w11;
            const dither = BAYER[(row & 1) * 2 + (col & 1)];
            let rampId;
            let k;
            let flags = 0;

            if (surface === S_GRASS) {
                // 2.6 — calm macro sweeps: one step either side of the mean,
                // dithered only within 0.06 of a sweep seam.
                const forestW = drift.forest[i00] * w00 + drift.forest[i10] * w10 + drift.forest[i01] * w01 + drift.forest[i11] * w11;
                // The forest floor shifts the sweeps half a step darker.
                let q = subSample(sweep, tx, ty) + macro * 0.5 - FOREST_FLOOR_STEP * forestW;
                q = q < -1 ? -1 : q > 1 ? 1 : q;
                const aq = q < 0 ? -q : q;
                const qStep = Math.round(aq - 0.5 < 0.06 && aq - 0.5 > -0.06 ? q + dither * 0.16 : q);
                const aoSteps = ao * 3.2;
                const kRaw = 2 + qStep + wearStep - tuck * 0.8;
                k = Math.round(kRaw + (tuck ? dither : 0)) - aoStepRound(aoSteps, dither);
                k = k < 0 ? 0 : k > 4 ? 4 : k;
                const wRaw = drift.warm[i00] * w00 + drift.warm[i10] * w10 + drift.warm[i01] * w01 + drift.warm[i11] * w11;
                const warmth = wRaw + (Math.abs(Math.abs(wRaw) - 0.42) < 0.05 ? dither * 0.14 : 0);
                rampId = warmth > 0.42 ? R_GRASS_DRY : warmth < -0.42 ? R_GRASS_LUSH : R_GRASS;
            } else if (surface === S_ROAD || surface === S_PLAZA || surface === S_FLAG) {
                const U = sx / 2 + sy;
                const V = sy - sx / 2;
                let worn = false;
                let mossShare = 1;
                let medallion = -1;
                if (surface === S_PLAZA) {
                    if (yardPlan.medallion) medallion = medallionAt(tx - yardPlan.medallion.x, ty - yardPlan.medallion.y);
                    if (medallion >= 0) {
                        PAVE.ramp = (medallion >> 4) === MEDALLION_RAMP.COOL ? R_COOL : R_PLAZA;
                        PAVE.stop = medallion & 15;
                        PAVE.cross = false;
                    } else if (yardPlan.forecourt && chebyshevOut(yardPlan.forecourt, tx, ty) <= FORECOURT_REACH) {
                        const L = STONE_LATTICES.forecourt;
                        stoneAt(U, V, L, 2301, UNIT);
                        stoneTexel(U, V, L, AXIS_FRAME, 2301, BODY_WEIGHTS.forecourt, R_PLAZA, 0, R_PLAZA, stoneDrift(drift.value, L, null), false);
                    } else {
                        const L = STONE_LATTICES.plaza;
                        stoneAt(U, V, L, 2311, UNIT);
                        stoneTexel(U, V, L, AXIS_FRAME, 2311, BODY_WEIGHTS.plaza, R_PLAZA, PLAZA_COOL_SHARE, R_PLAZA, stoneDrift(drift.value, L, null), false);
                    }
                } else if (surface === S_FLAG) {
                    const L = STONE_LATTICES.flag;
                    const cool = yardBest >= 0 && yardCool[yardBest] ? R_COOL : R_PLAZA;
                    stoneAt(U, V, L, 2321, UNIT);
                    stoneTexel(U, V, L, AXIS_FRAME, 2321, BODY_WEIGHTS.flag, cool, 0, cool, stoneDrift(drift.value, L, null), false);
                    mossShare = 2;
                } else {
                    // Setts in the nearest route's own frame.
                    const L = STONE_LATTICES.sett;
                    const cb = tileI * 3;
                    let seg = null;
                    let best = ROAD_FRAME_REACH;
                    for (let c = 0; c < 3; c++) {
                        const si = frames.cand[cb + c];
                        if (si < 0) break;
                        const d = segDistance(frames.segs[si], tx, ty);
                        if (d < best) { best = d; seg = frames.segs[si]; }
                    }
                    if (seg) {
                        const px = tx - seg.ax;
                        const py = ty - seg.ay;
                        const s = (seg.s0 + px * seg.du + py * seg.dv) * 32;
                        let t = (py * seg.du - px * seg.dv) * 32;
                        worn = seg.avenue && (t < 0 ? -t : t) <= WORN_HALF_ROWS;
                        if (seg.fan) {
                            const m = ((s % 48) + 48) % 48 - 24;
                            t -= 0.08 * m * m / 24;
                        }
                        stoneAt(s, t, L, 2331, UNIT);
                        stoneTexel(s, t, L, seg.frame, 2331, BODY_WEIGHTS.sett, R_ROAD, 0, R_ROAD, stoneDrift(drift.value, L, seg), worn);
                    } else {
                        stoneAt(U, V, L, 2331, UNIT);
                        stoneTexel(U, V, L, AXIS_FRAME, 2331, BODY_WEIGHTS.sett, R_ROAD, 0, R_ROAD, stoneDrift(drift.value, L, null), false);
                    }
                }
                rampId = PAVE.ramp;
                k = PAVE.stop;
                const cross = PAVE.cross;
                if (unitMap && medallion < 0) unitMap[ti] = (((UNIT.id >>> 8) || 1) << 8 | PAVE.lip) >>> 0;

                // 2.4 — the 3 px jointed kerb inside the road layer's edge:
                // the texel's screen-px distance to the edge, walked along
                // the gradient's dominant screen axis on the true (noisy)
                // membership, so every kerb is exactly KERB_ROWS px deep.
                let nearEdge = false;
                if (vRoad < 2) {
                    const g = Math.hypot(gRoadX, gRoadY);
                    const kd = g > 0.05 ? 32 * (vRoad - ROAD_THR) / g : Infinity;
                    nearEdge = kd < MOSS_NEAR_ROWS;
                    let kerbRow = -1;
                    if (kd < KERB_ROWS + 1.5) {
                        const down = gRoadX + gRoadY;
                        const right = (gRoadX - gRoadY) / 2;
                        const vertical = Math.abs(down) >= Math.abs(right);
                        // One px toward the edge (where the membership falls).
                        const sxStep = vertical ? 0 : right > 0 ? -1 : 1;
                        const syStep = vertical ? (down > 0 ? -1 : 1) : 0;
                        for (let d = 1; d <= KERB_ROWS; d++) {
                            const px = sx + sxStep * d;
                            const py = sy + syStep * d;
                            if (roadMembership(mask, px / TILE_WIDTH + py / TILE_HEIGHT, py / TILE_HEIGHT - px / TILE_WIDTH) <= ROAD_THR) {
                                kerbRow = KERB_ROWS - d;
                                break;
                            }
                        }
                    }
                    if (kerbRow >= 0) {
                        // Facing from the outward normal n = −∇v/|∇v|:
                        // n·(−1,−1)/√2 lit, n·(1,1)/√2 shaded, else mid.
                        const nw = (gRoadX + gRoadY) * Math.SQRT1_2 / (g || 1);
                        const face = nw > 0.3 ? 1 : nw < -0.3 ? 2 : 0;
                        rampId = surface === S_PLAZA || (surface === S_ROAD && plazaShare > 0.35) ? R_PLAZA
                            : surface === S_FLAG ? rampId : R_ROAD;
                        if (kerbRow === 0) {
                            // The inner chamfer.
                            k = face === 1 ? 4 : face === 2 ? 2 : 3;
                        } else {
                            // Two body rows of 6 / 8 px blocks, jointed in R[0].
                            const block = kerbRuns[col];
                            const alt = (block >> 1) & 1;
                            k = block & 1 ? 0 : face === 2 ? (alt ? 1 : 2) : (alt ? 2 : 3);
                        }
                        flags = (kerbRow + 1) << KERB_SHIFT;
                        if (unitMap) unitMap[ti] = 0;
                    }
                }
                if (cross && !flags && hash2(col, row, 1701) < (nearEdge ? MOSS_NEAR : MOSS_FAR) * mossShare * mossScale) {
                    moss.push(ti, hash2(col, row, 1702) < 1 / 3 ? 1 : 0);
                }
                const aoSteps = Math.min(ao, PAVING_AO_CAP) * 3.2;
                k -= aoStepRound(aoSteps, dither);
                if (wearStep > 0.5) k += 1;
                k = k < 0 ? 0 : k > 4 ? 4 : k;
            } else if (surface === S_GRAVEL) {
                const dense = yardPlan.mine && chebyshevOut(yardPlan.mine, tx, ty) <= 1;
                k = screeStop(col, row, dense);
                const aoSteps = Math.min(ao, PAVING_AO_CAP) * 3.2;
                k -= aoStepRound(aoSteps, dither);
                k = k < 0 ? 0 : k > 4 ? 4 : k;
                rampId = R_ROAD;
            } else if (surface === S_CINDER) {
                const c = cobbleAt(sx / 2 + sy, sy - sx / 2);
                if (c.edge < 0.5) {
                    k = 0;
                } else {
                    const h0 = (c.id & 0xffff) / 65536;
                    if (h0 < 0.08) {
                        k = 0;
                    } else {
                        k = h0 < 0.33 ? 1 : h0 < 0.78 ? 2 : 3;
                        const door = yardPlan.forgeDoor;
                        if (door && Math.hypot(tx - door.x, ty - door.y) < 1.5 && ((c.id >>> 16) & 0xff) < 128) k += 1;
                        if (c.edge < 1.5) k += c.face;
                    }
                }
                const aoSteps = ao * 3.2;
                k -= aoStepRound(aoSteps, dither);
                k = k < 0 ? 0 : k > 4 ? 4 : k;
                rampId = R_CINDER;
            } else {
                // The soft grounds: dirt, yard earth and sand read their
                // drawing, switched between variants on noise contours;
                // marsh reed replaces sand by fresh water.
                const S = SURFACES[surface];
                let texList = textures[S.tex];
                let contextStep = 0;
                if (surface === S_SAND) {
                    const fresh = freshwater[i00] * w00 + freshwater[i10] * w10 + freshwater[i01] * w01 + freshwater[i11] * w11;
                    if (fresh > 0.5 + (vnoise(tx / 1.4, ty / 1.4, 53) - 0.5) * 0.4 + dither * 0.1) {
                        texList = textures.marsh;
                        contextStep = MARSH_OFFSET;
                    }
                }
                const variantField = vnoise(tx / SURFACE_VARIANT_SCALE, ty / SURFACE_VARIANT_SCALE, 41 + surface);
                const vi = Math.min(texList.length * 4 - 1, Math.floor(variantField * texList.length * 4));
                const tex = texList[vi >> 2];
                const shift = vi & 2 ? 16 : 0;
                let u = (Math.floor((tx + 0.5) * 32) + shift) & 31;
                const v = (Math.floor((ty + 0.5) * 32) + shift) & 31;
                if (vi & 1) u = 31 - u;
                const z = tex[v * 32 + u];
                let rut = 0;
                if (surface === S_EARTH && rutSegs.length) {
                    let dmin = 9;
                    for (let n = 0; n < rutSegs.length; n++) dmin = Math.min(dmin, segmentDistance(rutSegs[n], tx, ty));
                    const t = dmin * 32;
                    if (t >= 5 && t < 7) rut = -1;
                }
                const kRaw = 2 + S.offset + contextStep + z * S.contrast + macro + lip * 0.8 - tuck * 1.0 - ao * 3.2 + wearStep + rut;
                const kDither = Math.abs(kRaw - Math.round(kRaw)) > 0.43 ? dither * 0.19 : 0;
                k = Math.round(kRaw + kDither);
                k = k < 0 ? 0 : k > 4 ? 4 : k;
                rampId = surface === S_SAND ? R_SAND : R_DIRT;
            }

            const c = RAMP_TABLE[rampId][k];
            const o = ti * 4;
            D[o] = c[0]; D[o + 1] = c[1]; D[o + 2] = c[2]; D[o + 3] = 255;
            surfaces[ti] = surface;
            stepBuf[ti] = k | flags;
        }
    }

    // Marks land only: the coast pass owns water and off-map texels.
    const put = (col, row, c) => {
        if (col < 0 || row < 0 || col >= cols || row >= rows || surfaces[row * cols + col] === 255) return;
        const o = (row * cols + col) * 4;
        D[o] = c[0]; D[o + 1] = c[1]; D[o + 2] = c[2]; D[o + 3] = 255;
    };

    pause(); yield 'base'; resume();
    const pass = { cols, rows, x0, y0, surfaces, sdBuf, aoBuf, stepBuf, put, season, due, drift, bankZone, moss };
    yield* run(drawPavingDetails(pass), 'details');
    pause(); yield 'details'; resume();
    const crowns = buildCrownField(r, { cols, rows, x0, y0 });
    hold(crowns.dist); hold(crowns.owner);
    pause(); yield 'crowns'; resume();
    let edge = hold(yield* run(chamferToPaths(cols, rows, surfaces, due), 'chamfer'));
    pass.edge = edge;
    pass.crowns = crowns;
    pause(); yield 'chamfer'; resume();
    yield* run(drawLivingGround(r, pass), 'living');
    pause(); yield 'living'; resume();
    yield* run(drawDecals(r, pass), 'decals');
    pause(); yield 'decals'; resume();
    yield* run(drawTufts(r, pass), 'tufts');
    pause(); yield 'tufts'; resume();
    yield* run(drawTransitions(r, pass), 'transitions');
    pause(); yield 'transitions'; resume();
    const footings = drawFootings(r, pass);
    edge = drop(edge);
    pass.edge = null;

    pause(); yield 'footings'; resume();
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    canvas.getContext('2d').putImageData(image, 0, 0);
    drop(image.data);
    image = null;

    // The published 2×1 fields: each coarse cell takes its right-hand fine
    // sample (2c + 1), the old texel centre's east side.
    const n = fcols * rows;
    const classes = hold(new Uint8Array(n));
    const fieldSurfaces = hold(new Uint8Array(n).fill(255));
    const fieldAo = hold(new Uint8Array(n));
    for (let row = 0; row < rows; row += 16) {
        if (row > 0 && due()) { pause(); yield 'fields'; resume(); }
        downsampleFields(row, Math.min(rows, row + 16), cols, surfaces, sdBuf, aoBuf, classes, fieldSurfaces, fieldAo);
    }
    sdBuf = drop(sdBuf);
    pass.sdBuf = null;
    pause(); yield 'fields'; resume();
    const puddleMask = hold(yield* run(puddleSiteSlices({ cols: fcols, rows, surfaces: fieldSurfaces, aoBuf: fieldAo, due }), 'puddles'));
    pause(); yield 'puddles'; resume();
    guardPuddles(puddleMask, surfaces, aoBuf);
    pause(); yield 'puddles'; resume();
    let weather;
    if (withWeather) {
        const stops = hold(new Uint8Array(n));
        fieldStops(stops, stepBuf);
        pause(); yield 'weather'; resume();
        weather = yield* run(bakeGroundWeather(r, { cols: fcols, rows, x0, y0, fineCols: cols, fineSurfaces: surfaces, surfaces: fieldSurfaces, stops, crowns, puddleMask, season, phenology: r._terrainPhenology || null, hold, due }), 'weather');
        drop(stops);
    }
    const field = groundFieldFrom({ bounds: { x: x0, y: y0, w, h }, cols: fcols, rows, texelW: FIELD_TEXEL_W, classes, weather });
    const ms = busy + performance.now() - started;
    const tail = performance.now() - clock.start;
    if (tail > clock.maxMs) clock.maxMs = tail;
    return {
        canvas, field, ms, x0, y0, cols: fcols, rows, texelW: FIELD_TEXEL_W,
        surfaces: fieldSurfaces, aoBuf: fieldAo, puddleMask, weather,
        // The 1×1 colour lattice's planes, for the winter re-tone.
        color: { cols, rows, texelW: COLOR_TEXEL_W, surfaces, aoBuf, stepBuf },
        stats: { slices: clock.slices, maxSliceMs: clock.maxMs, peakBytes: mem.peak, footings, unitMap },
    };
}

// The published 2×1 fields of rows [r0, r1): each cell takes its right-hand
// fine sample (2c + 1). Plain functions, so the hot loops optimize outside
// the bake's generator.
function downsampleFields(r0, r1, cols, surfaces, sdBuf, aoBuf, classes, fieldSurfaces, fieldAo) {
    const fcols = cols / 2;
    for (let row = r0; row < r1; row++) {
        const fBase = row * cols;
        const cBase = row * fcols;
        for (let c = 0; c < fcols; c++) {
            const fi = fBase + 2 * c + 1;
            const s = surfaces[fi];
            const sq = sdBuf[fi];
            classes[cBase + c] = sq === SD_UNVISITED ? GROUND_CLASS.NONE
                : s === 255 || sq > 0 ? GROUND_CLASS.WATER : SURFACES[s].cls;
            fieldSurfaces[cBase + c] = s;
            fieldAo[cBase + c] = aoBuf[fi];
        }
    }
}

// Material guard: a pair whose other (left) fine texel cannot hold a puddle
// holds none, so a puddle never spills onto a water, sand or turf pixel.
function guardPuddles(mask, surfaces, aoBuf) {
    for (let i = 0, f = 0; i < mask.length; i++, f += 2) {
        if (mask[i] === 0) continue;
        const left = surfaces[f];
        if (!PUDDLE_SURFACES.has(left) || aoBuf[f] >= PUDDLE_WALL_AO) mask[i] = 0;
    }
}

function fieldStops(stops, stepBuf) {
    for (let i = 0, f = 1; i < stops.length; i++, f += 2) stops[i] = stepBuf[f] & STOP_MASK;
}

// ---- item 5: the ground weather field --------------------------------------

// Shelter = max(eave cover, crown cover); drying order = sun shade (walls and
// crowns), joints and hollows, puddle sites, and world-locked noise. Layout
// and scales: GroundWeatherField.js. Built on the 2×1 field grid at the old
// texel centre (x = x0 + 2c + 1), crown cover read at the right-hand fine
// texel.
const DRY_SHADE = 0.6;
const DRY_HOLLOW = 0.2;
const DRY_PUDDLE = 0.2;
const DRY_NOISE = 0.12;
const HOLLOW_BY_STOP_PAVED = Object.freeze([1, 0.55, 0, 0, 0]);
const HOLLOW_BY_STOP_SOFT = Object.freeze([0.8, 0.4, 0.1, 0, 0]);

// A crown's leaf share is the tree sprite's own leaf state
// (FoliageRenderer.treeStateKey): the BI-2 stage's shed share of its species,
// all shed by default in winter; evergreens keep theirs. A bare crown spares
// at most BARE_CROWN_COVER of the rain.
function crownCover(crowns, i, season, phenology) {
    const cd = crowns.dist[i] / CROWN_DIST_SCALE;
    if (!(cd < 1.15)) return 0;
    const tree = crowns.trees[crowns.owner[i]];
    const evergreen = tree?.species === 'pine' || tree?.species === 'ash';
    const shedShare = phenology?.shed?.[tree?.species];
    const shed = evergreen ? 0 : Number.isFinite(shedShare) ? shedShare : season === 'winter' ? 1 : 0;
    const leafy = Math.max(BARE_CROWN_COVER, 1 - shed);
    const c = cd < 0.7 ? 1 : (1.15 - cd) / 0.45;
    return c * leafy;
}

function* bakeGroundWeather(r, { cols, rows, x0, y0, fineCols, fineSurfaces, surfaces, stops, crowns, puddleMask, season, phenology, hold = (b) => b, due = () => false }) {
    const N = MAP_SIZE;
    const sunOccluders = buildSunOccluders(r);
    // The two planes: eave cover becomes shelter, sun shade the drying order.
    const shelter = hold(new Float32Array(cols * rows));
    yield 'shelter';
    const order = hold(new Float32Array(cols * rows));
    yield 'order';
    const sunOut = [0, 0];
    const clampI = (v) => (v < 0 ? 0 : v >= N ? N - 1 : v);
    for (let row = 0; row < rows; row++) {
        if ((row & 7) === 0 && due()) yield 'rows';
        const sy = y0 + row + 0.5;
        for (let col = 0; col < cols; col++) {
            const i = row * cols + col;
            const s = surfaces[i];
            if (s === 255) continue;
            const sx = x0 + col * FIELD_TEXEL_W + 1;
            const tx = sx / TILE_WIDTH + sy / TILE_HEIGHT;
            const ty = sy / TILE_HEIGHT - sx / TILE_WIDTH;
            let eave = 0;
            let sun = 0;
            const sb = sunOccluders[clampI(Math.round(ty)) * N + clampI(Math.round(tx))];
            if (sb) {
                sunShadeAt(sb, tx, ty, sunOut);
                eave = sunOut[0];
                sun = sunOut[1];
            }
            const crown = crownCover(crowns, row * fineCols + col * 2 + 1, season, phenology);
            shelter[i] = Math.max(eave, crown);
            const hollow = (isPavingSurface(s) ? HOLLOW_BY_STOP_PAVED : HOLLOW_BY_STOP_SOFT)[stops[i]] || 0;
            const shade = Math.max(sun, crown * 0.8);
            const noise = fbm(col / 9, row / 4.5, 1501) - 0.5;
            order[i] = 0.12 + DRY_SHADE * shade + DRY_HOLLOW * hollow + DRY_PUDDLE * (puddleMask[i] / 255) + DRY_NOISE * noise;
        }
    }
    // Packed in row bands (GroundWeatherField's own packer, per band), with
    // the material guard: a fine land / water pair reads as no land, so a
    // consumer never wets the water texel of a shore pair.
    const data = hold(new Uint8Array(cols * rows * 4));
    yield 'pack';
    const PACK_ROWS = GROUND_BAND_ROWS / 2;
    for (let r0 = 0; r0 < rows; r0 += PACK_ROWS) {
        if (due()) yield 'pack';
        const a = r0 * cols;
        const b = Math.min(rows, r0 + PACK_ROWS) * cols;
        const band = packGroundWeather({ cols, rows: (b - a) / cols, surfaces: surfaces.subarray(a, b), stops: stops.subarray(a, b),
            shelter: shelter.subarray(a, b), order: order.subarray(a, b), puddleMask: puddleMask.subarray(a, b) });
        data.set(band.data, a * 4);
        if (!fineSurfaces) continue;
        for (let i = a; i < b; i++) {
            const f = 2 * i + 1;
            if ((fineSurfaces[f - 1] === 255) === (fineSurfaces[f] === 255)) continue;
            const o = i * 4;
            data[o] = 255; data[o + 1] = 0; data[o + 2] = 128; data[o + 3] = 0;
        }
    }
    return { data, cols, rows, x0: GROUND_WEATHER_X0, y0: GROUND_WEATHER_Y0, texelW: GROUND_WEATHER_TEXEL_W };
}

// ---- W1.1 paving details ----------------------------------------------------

// The joints where the plaza meets other stone (the 1-row ROAD[0] joint
// where it runs over a road, a 1-stop darker course elsewhere), moss in the
// mortar crosses, slag pebbles on the cinder yard and pebbles in the earth.
function* drawPavingDetails({ cols, rows, surfaces, stepBuf, put, due, moss, season }) {
    const otherPaving = (s) => s !== S_PLAZA && isPavingSurface(s);
    for (let row = 1; row < rows - 1; row++) {
        if ((row & 7) === 0 && due()) yield;
        const span = diamondSpan(row, cols);
        const cEnd = Math.min(cols - 2, span[1]);
        for (let col = Math.max(1, span[0]); col <= cEnd; col++) {
            const i = row * cols + col;
            const s = surfaces[i];
            if (s === S_PLAZA) {
                if (stepBuf[i] & KERB_MASK) continue;
                const below = surfaces[i + cols];
                const roadBelow = otherPaving(below);
                if (roadBelow || otherPaving(surfaces[i - cols]) || otherPaving(surfaces[i - 1]) || otherPaving(surfaces[i + 1])) {
                    put(col, row, roadBelow ? ROAD[0] : PLAZA[Math.max(0, (stepBuf[i] & STOP_MASK) - 1)]);
                }
            } else if (s === S_CINDER) {
                if (hash2(col, row, 1951) < 1 / 40) {
                    put(col, row, CINDER[1]);
                    if (surfaces[i - cols] === S_CINDER) put(col, row - 1, CINDER[3]);
                }
            } else if (s === S_EARTH) {
                if (hash2(col, row, 1953) < 1 / 60) {
                    put(col, row, SAND[2]);
                    if (surfaces[i + cols] === S_EARTH) put(col, row + 1, DIRT[0]);
                }
            }
        }
    }
    const lichen = season === 'winter' ? [FOLIAGE[1], FOLIAGE[1]] : [FOLIAGE[1], FOLIAGE[2]];
    for (let m = 0; m < moss.length; m += 2) {
        const i = moss[m];
        const col = i % cols;
        const row = (i - col) / cols;
        put(col, row, lichen[0]);
        if (moss[m + 1] && isPavingSurface(surfaces[i + 1])) put(col + 1, row, lichen[1]);
    }
}

// ---- living ground (5.1 seasons, 5.4 micro-detail) ------------------------

// Two-pass 5-10-11 chamfer distance from every grass or sand texel to the
// nearest paved or trodden texel. A 1×1 texel is not square on the ground
// plane (it is ½ × 1 in row units), so a column step weighs CHAMFER_A_X = 5,
// a row step CHAMFER_A_Y = 10 and a diagonal CHAMFER_B = 11 (≈ Euclidean on
// the 2:1 lattice, in tenths of a row). Water and off-map texels are not
// sources. Uint8, saturating at 255 (no reader looks past MEADOW_OPEN).
const CHAMFER_A_X = 5;
const CHAMFER_A_Y = 10;
const CHAMFER_B = 11;
export const GROUND_CHAMFER = Object.freeze({ A_X: CHAMFER_A_X, A_Y: CHAMFER_A_Y, B: CHAMFER_B });
function* chamferToPaths(cols, rows, surfaces, due) {
    const far = 255;
    const d = new Uint8Array(cols * rows);
    for (let i = 0; i < d.length; i++) {
        const s = surfaces[i];
        d[i] = s === S_GRASS || s === S_SAND || s === 255 ? far : 0;
    }
    yield;
    for (let row = 0; row < rows; row++) {
        if ((row & 7) === 0 && due()) yield;
        const base = row * cols;
        const span = diamondSpan(row, cols);
        const cEnd = span[1];
        for (let col = span[0]; col <= cEnd; col++) {
            const i = base + col;
            let v = d[i];
            if (v === 0) continue;
            if (col > 0 && d[i - 1] + CHAMFER_A_X < v) v = d[i - 1] + CHAMFER_A_X;
            if (row > 0) {
                if (d[i - cols] + CHAMFER_A_Y < v) v = d[i - cols] + CHAMFER_A_Y;
                if (col > 0 && d[i - cols - 1] + CHAMFER_B < v) v = d[i - cols - 1] + CHAMFER_B;
                if (col < cols - 1 && d[i - cols + 1] + CHAMFER_B < v) v = d[i - cols + 1] + CHAMFER_B;
            }
            d[i] = v;
        }
    }
    for (let row = rows - 1; row >= 0; row--) {
        if ((row & 7) === 0 && due()) yield;
        const base = row * cols;
        const span = diamondSpan(row, cols);
        const cStart = span[0];
        for (let col = span[1]; col >= cStart; col--) {
            const i = base + col;
            let v = d[i];
            if (v === 0) continue;
            if (col < cols - 1 && d[i + 1] + CHAMFER_A_X < v) v = d[i + 1] + CHAMFER_A_X;
            if (row < rows - 1) {
                if (d[i + cols] + CHAMFER_A_Y < v) v = d[i + cols] + CHAMFER_A_Y;
                if (col < cols - 1 && d[i + cols + 1] + CHAMFER_B < v) v = d[i + cols + 1] + CHAMFER_B;
                if (col > 0 && d[i + cols - 1] + CHAMFER_B < v) v = d[i + cols - 1] + CHAMFER_B;
            }
            d[i] = v;
        }
    }
    return d;
}

// Crown half-widths (world px) of the tree sheets (FoliageRenderer's sprite
// keys); the ground under a crown is the iso ellipse of that half-width and
// half its height.
const CROWN_RADIUS = Object.freeze({
    'oak.large': 26, 'oak.small': 9, 'pine.large': 13, 'willow.large': 20, 'willow.small': 12,
    // 5.5 — the woodland-only tall sheets (≈ 1.85× the large crowns).
    'oak.tall': 48, 'pine.tall': 20, 'willow.tall': 34,
    // W8.3d species: the crown half-widths of their sheets.
    'birch.small': 6, 'birch.large': 18, 'birch.tall': 20,
    'maple.large': 26, 'maple.tall': 50, 'poplar.tall': 16,
    // The world ash (scenery.js WORLD_TREE): its crown shades its whole islet.
    'ash.world': 119,
});
// Leaves and needles fall around the trunk and drift downwind: the prevailing
// knot wind blows toward screen right, so the drop zone sits a fifth of a
// radius that way.
const DROP_DRIFT = 0.2;
const CROWN_REACH = 1.5;

// Per texel: distance to the nearest crown's drop zone in crown radii
// (`dist` byte = round(64 · radii), 255 when none within CROWN_REACH) and
// that tree's index (`owner`; 255 / −1 none).
function buildCrownField(r, { cols, rows, x0, y0, texelW = COLOR_TEXEL_W }) {
    const trees = r.scenery?.getTreeProps?.() || [];
    const dist = new Uint8Array(cols * rows).fill(255);
    const owner = trees.length < 255 ? new Uint8Array(cols * rows).fill(255) : new Int16Array(cols * rows).fill(-1);
    trees.forEach((tree, index) => {
        const rv = CROWN_RADIUS[treeSpriteKey(tree)] / 2;
        const rh = rv * 2 / texelW;
        const cc = ((tree.tileX - tree.tileY) * HALF_W - x0) / texelW + DROP_DRIFT * rh;
        const rc = (tree.tileX + tree.tileY) * HALF_H - y0;
        const c0 = Math.max(0, Math.floor(cc - rh * CROWN_REACH));
        const c1 = Math.min(cols - 1, Math.ceil(cc + rh * CROWN_REACH));
        const r0 = Math.max(0, Math.floor(rc - rv * CROWN_REACH));
        const r1 = Math.min(rows - 1, Math.ceil(rc + rv * CROWN_REACH));
        for (let row = r0; row <= r1; row++) {
            const dy = (row + 0.5 - rc) / rv;
            for (let col = c0; col <= c1; col++) {
                const d = Math.hypot((col + 0.5 - cc) / rh, dy);
                const q = d * CROWN_DIST_SCALE;
                if (q >= 255) continue;
                const i = row * cols + col;
                const b = Math.round(q);
                if (b < dist[i]) { dist[i] = b; owner[i] = index; }
            }
        }
    });
    return { trees, dist, owner };
}

// Litter colours (leafAutumn stops) by the crown above: russet oaks and
// scarlet maples drop russet, ochre oaks gold, turning oaks a mix, willows,
// birches and poplars straw gold.
const LITTER = Object.freeze({
    russet: [LEAF[0], LEAF[1], LEAF[2]],
    ochre: [LEAF[3], LEAF[4], LEAF[1]],
    turning: [LEAF[1], LEAF[3], LEAF[4], LEAF[2]],
    willow: [LEAF[3], LEAF[4]],
    mould: [DIRT[0], LEAF[0]],
});
const NEEDLES = [TIMBER[2], DIRT[1], DIRT[0]];
// The verge (plan 5.4): tufts rooted 2–6 rows from a path, blades 1–3
// texels above the root row. Distances keep their world meaning on the 1×1
// lattice through CHAMFER_A_Y (one row).
const VERGE_NEAR = 2 * CHAMFER_A_Y;
const VERGE_FAR = 6 * CHAMFER_A_Y;
const MEADOW_OPEN = 12 * CHAMFER_A_Y;
// W1.1 — the verge's blade share: the mown tufts (drawTufts) now share the
// verge, and a 1×1 blade is one px wide.
const VERGE_SHARE = 0.55;
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

// BI-2 — autumn litter deepens as the crowns empty: under a crown it lies at
// LITTER_FIRST of the full drop through the turning weeks, rising with the
// species' shed share (the BI-2 stage) to the full drop once it is bare.
const LITTER_FIRST = 0.25;
function litterShare(tree, phenology) {
    const shed = phenology?.shed?.[tree.species];
    return Number.isFinite(shed) ? LITTER_FIRST + (1 - LITTER_FIRST) * shed : 1;
}

function litterFor(tree, season) {
    if (season === 'winter') return LITTER.mould;
    if (tree.species === 'willow' || tree.species === 'birch' || tree.species === 'poplar') return LITTER.willow;
    if (tree.species === 'maple') return LITTER.russet;
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

function* drawLivingGround(r, { cols, rows, x0, y0, surfaces, aoBuf, stepBuf, put, season, crowns, edge, due }) {
    const winter = season === 'winter';
    const autumn = season === 'autumn';
    const spring = season === 'spring';
    const style = VERGE_STYLE[season] || VERGE_STYLE.summer;
    // BI-2 — the woods' weekly stage: the litter's shed shares, and whether
    // the spring blossom is out.
    const phenology = r._terrainPhenology || null;
    const blossom = phenology?.blossom ?? true;
    const patchGrid = season !== 'summer' ? seasonPatchGrid(spring ? 1310 : 1311) : null;
    const patchOn = autumn ? 0.7 : spring ? 0.66 : 0.8;
    const patchRamp = spring ? GRASS_FRESH : GRASS_DRY;

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
        if ((row & 7) === 0 && due()) yield;
        const sy = y0 + row + 0.5;
        const span = diamondSpan(row, cols);
        const cEnd = Math.min(cols - 2, span[1]);
        for (let col = Math.max(1, span[0]); col <= cEnd; col++) {
            const i = row * cols + col;
            if (surfaces[i] !== S_GRASS) continue;
            const sx = x0 + col + 0.5;
            const e = edge[i];
            const cd = crowns.dist[i] / CROWN_DIST_SCALE;
            const tree = cd < CROWN_REACH ? crowns.trees[crowns.owner[i]] : null;
            const ao = aoBuf[i];

            // Seasonal patches away from the crowns: autumn dry grass, a
            // sparser dormant set in winter, spring's fresh flush.
            if (patchGrid && cd > 1.2) {
                const n = subSample(patchGrid, sx / TILE_WIDTH + sy / TILE_HEIGHT, sy / TILE_HEIGHT - sx / TILE_WIDTH)
                    + BAYER[(row & 1) * 2 + (col & 1)] * 0.3;
                if (n > patchOn) put(col, row, patchRamp[stepBuf[i] & STOP_MASK]);
            }

            // The unmown verge along every path: blades densest at the path's
            // edge and thinning inward in longer and shorter stretches, each
            // a lit stroke over a dark root texel; seed heads only in seed
            // tufts, on a jittered 12×4 grid inside patches of the band. Under
            // a crown the verge keeps its blades in shade colours. A grass
            // sliver too narrow to reach the band carries blades along its
            // ridge (its texels farthest from paving).
            const inBand = e >= VERGE_NEAR && e <= VERGE_FAR;
            const ridge = !inBand && e >= CHAMFER_A_X && e < VERGE_NEAR
                && edge[i - 1] <= e && edge[i + 1] <= e && edge[i - cols] <= e && edge[i + cols] <= e;
            if (inBand || ridge) {
                const inward = ridge ? 0 : (e - VERGE_NEAR) / (VERGE_FAR - VERGE_NEAR);
                const shaded = Boolean(tree) && cd < 1;
                if (style.head && !shaded && cellCandidate(col, row, 12, 4, 1213)
                    && vnoise(sx / 40, sy / 20, 1218) > 0.45
                    && hash2(col, row, 1207) < style.seeds * (1 - inward * 0.5)) {
                    seedTuft(col, row, hash2(col, row, 1202));
                    continue;
                }
                const h = hash2(col, row, 1201);
                if (h < 0.36 * VERGE_SHARE) {
                    const band = vnoise(sx / 60, sy / 30, 1206);
                    if (h < (ridge ? 0.35 : (0.12 + band * 0.18) * (1 - inward * 0.5)) * VERGE_SHARE) {
                        const tall = 2 + Math.floor(hash2(col, row, 1202) * 3);
                        if (shaded) blade(col, row, tall, GRASS[2], GRASS[3]);
                        else blade(col, row, tall, style.stem, style.tip);
                        continue;
                    }
                }
            }

            if (tree && cd < 1) {
                // Under a crown: litter by season, then needles, twigs, moss.
                // The evergreen world ash sheds no seasonal litter: twigs and
                // moss all year.
                const h = hash2(col, row, 1201);
                const pick = hash2(col, row, 1202);
                const near = 1 - cd;
                const drift = 0.6 + 0.8 * vnoise(sx / 14, sy / 7, 1203);
                if (tree.species === 'pine') {
                    if (h < (near + 0.1) * 0.32 * drift) {
                        put(col, row, NEEDLES[Math.floor(pick * NEEDLES.length)]);
                        if (pick > 0.6) put(col + 1, row, NEEDLES[0]);
                    }
                    continue;
                }
                if ((autumn || winter) && tree.species !== 'ash' && cellCandidate(col, row, 6, 2, 1214)) {
                    if (h < near ** 1.2 * (autumn ? 1.1 * litterShare(tree, phenology) : 0.3) * drift) {
                        const litter = litterFor(tree, season);
                        const k = Math.floor(pick * litter.length);
                        clump(col, row, hash2(col, row, 1215), litter[k], litter[Math.max(0, k - 1)]);
                    }
                    continue;
                }
                if (spring && blossom && tree.species === 'oak' && tree.variant === 2 && cellCandidate(col, row, 6, 2, 1216)) {
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
            if (tree && autumn && tree.species !== 'pine' && tree.species !== 'ash' && cellCandidate(col, row, 6, 2, 1214)) {
                const h = hash2(col, row, 1201);
                if (h < (CROWN_REACH - cd) * 0.25 * litterShare(tree, phenology)) {
                    // A few leaves blown past the drop zone.
                    const litter = litterFor(tree, season);
                    const pick = hash2(col, row, 1202);
                    put(col, row, litter[Math.floor(pick * 2)]);
                    put(col + 1, row, litter[Math.floor(pick * 2)]);
                    continue;
                }
            }

            if (ao > 20 && ao < 110) {
                // Weeds at wall and prop bases, in clumps; in winter a dead
                // stalk pair, never a lone brown fleck.
                const h = hash2(col, row, 1201);
                if (h < 0.06 && h < (vnoise(sx / 40, sy / 20, 1212) > 0.45 ? 0.06 : 0.012)) {
                    put(col, row, FOLIAGE[1]);
                    put(col, row - 1, winter ? DIRT[2] : FOLIAGE[2]);
                    if (hash2(col, row, 1202) > 0.5 || winter) put(col + 1, row - 1, winter ? DIRT[3] : FOLIAGE[3]);
                }
            } else if (e > MEADOW_OPEN && ao === 0 && !tree && !winter) {
                // Rare meadow pockets: daisies (seed tufts in autumn) where a
                // low-frequency mask opens, clover drifts where it closes.
                // Spring opens more pockets.
                const h = hash2(col, row, 1201);
                if (h >= 0.085) continue;
                const pocket = vnoise(sx / 110, sy / 55, 1208);
                const open = spring ? 0.58 : 0.66;
                if (pocket > open && h < (pocket - open) * 0.2) {
                    const pick = hash2(col, row, 1202);
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

// X-6 / OA-T3 — the inline stamp tables (rows top → bottom, every row the
// stamp's width; the anchor is the bottom-left texel). Tufts: `.` none, `r`
// root R[k − 2], `m` R[k], `t` R[k + 1], `l` lit crescent R[k + 2], on the
// anchor's grass ramp and stop k.
export const TUFTS = Object.freeze({
    T5a: Object.freeze(['..t..', '.lm.t', 'rmmmr']),
    T6a: Object.freeze(['...t..', '.t.l..', '.mlm.t', 'rmmmmr']),
    T7a: Object.freeze(['..t..t.', '.tl.lm.', '.mmmmm.', 'rrmmmrr']),
    T7b: Object.freeze(['....t..', '.t..l..', '.l.mm.t', 'mmmmmlm', 'rrmmmrr']),
    T8a: Object.freeze(['...t....', '.t.l..t.', '.lmm.lm.', 'mmmmmmmt', 'rrrmmrrr']),
    T9a: Object.freeze(['..t...t..', '.tl..lm.t', '.mm.mmm.m', 'mmmmmmmmm', 'rrrmmmrrr']),
});
// Shrubs: `s` GRASS[0] contact, `1`..`4` FOLIAGE[n], `f` a bloom where the
// shrub stands by a flower bed (else FOLIAGE[3]).
export const SHRUBS = Object.freeze({
    bramble: Object.freeze(['...43.4..', '.3443343.', '2232f2322', '112121121', '.sssssss.']),
    fern: Object.freeze(['...4...', '.4.3.4.', '.32323.', '2122212', '.sssss.']),
    clover: Object.freeze(['.3f3..', '23432.', 's1121s']),
});
// OA-T3 grass → path blades: blade heights per column (0 = gap), each
// rising from the turf's first row onto the path above.
export const EDGE_BLADES = Object.freeze({
    G1: Object.freeze([1, 0, 2]),
    G2: Object.freeze([2, 1, 0, 1]),
    G3: Object.freeze([1, 3, 1, 0, 2]),
    G4: Object.freeze([0, 2, 0, 1, 3, 1]),
    G5: Object.freeze([2, 0, 1, 0, 2, 0, 1]),
    G6: Object.freeze([3, 1, 0]),
    G7: Object.freeze([1, 1, 2, 0, 1]),
    G8: Object.freeze([2, 3, 2, 1]),
    G9: Object.freeze([0, 1, 0, 2, 0, 3, 1]),
    G10: Object.freeze([1, 2, 1]),
});
const BLADES_SMALL = [EDGE_BLADES.G1, EDGE_BLADES.G2, EDGE_BLADES.G6, EDGE_BLADES.G10];
const BLADES_MID = [EDGE_BLADES.G3, EDGE_BLADES.G7];
const BLADES_LARGE = [EDGE_BLADES.G4, EDGE_BLADES.G5, EDGE_BLADES.G8, EDGE_BLADES.G9];

// Paints a tuft stamp with its bottom-left texel at (col, row) onto grass
// (and the strand, for a dune tuft).
function stampTuft(ctx, stamp, col, row, R, k, mirror, onSand = false) {
    const { cols, rows, surfaces, put } = ctx;
    const H = stamp.length;
    const W = stamp[0].length;
    const top = row - H + 1;
    for (let y = 0; y < H; y++) {
        const line = stamp[y];
        const rr = top + y;
        if (rr < 0 || rr >= rows) continue;
        for (let x = 0; x < W; x++) {
            const ch = line[mirror ? W - 1 - x : x];
            if (ch === '.') continue;
            const cc = col + x;
            if (cc < 0 || cc >= cols) continue;
            const under = surfaces[rr * cols + cc];
            if (under !== S_GRASS && !(onSand && under === S_SAND)) continue;
            const s = ch === 'r' ? Math.max(0, k - 2) : ch === 'm' ? k : ch === 't' ? Math.min(4, k + 1) : Math.min(4, k + 2);
            put(cc, rr, R[s]);
        }
    }
}

function grassRampAt(drift, tx, ty) {
    const warm = bilin(drift.warm, tx, ty);
    return warm > 0.42 ? GRASS_DRY : warm < -0.42 ? GRASS_LUSH : GRASS;
}

function* drawDecals(r, ctx) {
    const { cols, rows, x0, y0, surfaces, sdBuf, aoBuf, put, season, due } = ctx;
    const texelAt = (tx, ty) => {
        const sx = (tx - ty) * HALF_W;
        const sy = (tx + ty) * HALF_H;
        const col = Math.floor((sx - x0) / COLOR_TEXEL_W);
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
            list.push({ i, row: Math.floor(i / cols), draw: fn, pick: hash2(tileX, tileY, salt + 70 + n), group: hash2(tileX, tileY, salt + 99), key });
        }
    };

    // Meadow pockets: flower tiles and the flower feature bed become one
    // cluster of a single bloom colour each (redundant 50% cull dropped).
    const blooms = BLOOMS[season] || BLOOMS.summer;
    const flowerKeys = new Set([...(r.flowerTiles?.keys?.() || [])]);
    for (const [key, feature] of r.featureTiles || []) if (feature === 'flowers') flowerKeys.add(key);
    if (blooms.length) {
        const flower = (d) => {
            if (!onGrass(d.i)) return;
            const col = d.i % cols;
            const color = blooms[Math.floor(d.group * blooms.length)];
            put(col, d.row, GRASS[0]);
            put(col, d.row - 1, color);
            if (d.pick > 0.35) {
                put(col + 1, d.row, GRASS[0]);
                put(col + 1, d.row - 1, color);
            }
            if (d.pick > 0.65) put(col, d.row - 2, color);
        };
        for (const key of flowerKeys) {
            cluster(key, 100, 8, 0.36, flower);
        }
    }

    // Grass tufts on the scenery's tuft tiles: the small mown stamps.
    const tuft = (d) => {
        if (!onGrass(d.i)) return;
        const col = d.i % cols;
        const k = ctx.stepBuf[d.i] & STOP_MASK;
        const sx = x0 + col + 0.5;
        const sy = y0 + d.row + 0.5;
        const R = grassRampAt(ctx.drift, sx / TILE_WIDTH + sy / TILE_HEIGHT, sy / TILE_HEIGHT - sx / TILE_WIDTH);
        stampTuft(ctx, d.pick < 0.5 ? TUFTS.T5a : TUFTS.T6a, col - 2, d.row, R, k, d.pick > 0.7);
    };
    for (const key of r.grassTuftTiles?.keys?.() || []) {
        cluster(key, 200, 3, 0.32, tuft);
    }

    // Low shrubs (bramble, fern, clover) replace the cube-based bush
    // sprites, drawn on grass only; one standing by a flower bed carries
    // the bed's bloom.
    const shrub = (d) => {
        if (!onGrass(d.i)) return;
        const col = d.i % cols;
        const stamp = d.pick < 0.4 ? SHRUBS.bramble : d.pick < 0.75 ? SHRUBS.fern : SHRUBS.clover;
        const comma = d.key.indexOf(',');
        const tx = Number(d.key.slice(0, comma));
        const ty = Number(d.key.slice(comma + 1));
        const boosted = blooms.length && (flowerKeys.has(d.key) || flowerKeys.has(`${tx + 1},${ty}`) || flowerKeys.has(`${tx - 1},${ty}`)
            || flowerKeys.has(`${tx},${ty + 1}`) || flowerKeys.has(`${tx},${ty - 1}`));
        const bloom = boosted ? blooms[Math.floor(d.group * blooms.length)] : FOLIAGE[3];
        const H = stamp.length;
        const W = stamp[0].length;
        const left = col - (W >> 1);
        const top = d.row + 1 - H + 1;
        for (let y = 0; y < H; y++) {
            for (let x = 0; x < W; x++) {
                const ch = stamp[y][x];
                if (ch === '.') continue;
                const cc = left + x;
                const rr = top + y;
                if (cc < 0 || rr < 0 || cc >= cols || rr >= rows || surfaces[rr * cols + cc] === 255) continue;
                put(cc, rr, ch === 's' ? GRASS[0] : ch === 'f' ? bloom : FOLIAGE[ch.charCodeAt(0) - 48]);
            }
        }
    };
    for (const key of r.bushTiles?.keys?.() || []) {
        cluster(key, 300, 1, 0.12, shrub);
    }

    // Bank reeds: vertical stalks on the dry side of the waterline.
    const reed = (d) => {
        const sd = sdBuf[d.i] / SD_SCALE;
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

    yield;
    // Road-shoulder pebbles: only where a low-frequency mask allows, so they
    // gather in a few stretches rather than peppering every verge.
    for (let row = 4; row < rows - 1; row += 3) {
        if ((row & 63) === 1 && due()) yield;
        const span = diamondSpan(row, cols);
        const cEnd = Math.min(cols - 2, span[1]);
        for (let col = Math.max(1, span[0]); col <= cEnd; col++) {
            const i = row * cols + col;
            if (surfaces[i] !== S_DIRT) continue;
            if (surfaces[i + 1] !== S_GRASS && surfaces[i - 1] !== S_GRASS) continue;
            const h = hash2(col, row, 77);
            if (h > 0.03) continue;
            const sx = x0 + col;
            const sy = y0 + row;
            if (vnoise(sx / 180, sy / 90, 78) < 0.55) continue;
            list.push({ i, row, draw: pebble, pick: h * 32, group: 0 });
        }
    }

    // Back-shore shingle/pebble pockets along NW/NE beaches: C1 stone[1..4]
    // clusters gathered in low-frequency coastal pockets, never an even pepper.
    for (let row = 4; row < rows - 1; row += 2) {
        if ((row & 31) === 4 && due()) yield;
        const span = diamondSpan(row, cols);
        const cEnd = Math.min(cols - 2, span[1]);
        for (let col = Math.max(1, span[0]); col <= cEnd; col++) {
            const i = row * cols + col;
            if (surfaces[i] !== S_SAND || aoBuf[i] > 50) continue;
            const sx = x0 + col;
            const sy = y0 + row;
            const tx = sx / TILE_WIDTH + sy / TILE_HEIGHT;
            const ty = sy / TILE_HEIGHT - sx / TILE_WIDTH;
            if (tx > 2.2 && ty > 2.2) continue;
            const sd = sdBuf[i] / SD_SCALE;
            if (!(sd > -0.48 && sd < -0.04)) continue;
            const h = hash2(col, row, 813);
            if (h > 0.2) continue;
            const pocket = vnoise(sx / 84, sy / 42, 811);
            if (pocket < 0.44) continue;
            if (h > (pocket - 0.44) * 0.17) continue;
            list.push({
                i,
                row,
                pick: h * 32,
                group: hash2(col, row, 817),
                draw: (d) => {
                    if (surfaces[d.i] !== S_SAND) return;
                    const c = d.i % cols;
                    const topTone = d.group > 0.66 ? STONE[4] : d.group > 0.26 ? STONE[3] : STONE[2];
                    put(c, d.row - 1, topTone);
                    if (d.pick > 0.30) put(c + 1, d.row - 1, STONE[2]);
                    if (d.pick > 0.62) put(c + 1, d.row, STONE[1]);
                },
            });
        }
    }

    // Painter order: tall decals further down the screen draw last.
    list.sort((a, b) => a.row - b.row);
    yield;
    for (let k = 0; k < list.length; k++) {
        if ((k & 255) === 255 && due()) yield;
        list[k].draw(list[k]);
    }
}

// 2.6.3 — Poisson-disc tufts by mowing zone: one candidate per 2r × r cell
// (a ground-plane disc of radius r px), jittered inside the cell's middle.
// Mown within six rows of a path or in contact shade, meadow beyond, the
// forest floor its own sparse lush set.
const TUFT_ZONES = Object.freeze([
    Object.freeze({ zone: 0, cw: 18, ch: 9, stamps: [TUFTS.T5a, TUFTS.T6a], p: 0.75, salt: 2101 }),
    Object.freeze({ zone: 1, cw: 12, ch: 6, stamps: [TUFTS.T7a, TUFTS.T7b, TUFTS.T8a, TUFTS.T9a], p: 0.62, salt: 2111 }),
    Object.freeze({ zone: 2, cw: 22, ch: 11, stamps: [TUFTS.T5a], p: 0.7, salt: 2121 }),
]);
const MOWN_ROWS = 6 * CHAMFER_A_Y;

function* drawTufts(r, ctx) {
    const { cols, rows, x0, y0, surfaces, aoBuf, stepBuf, edge, drift, due } = ctx;
    for (const Z of TUFT_ZONES) {
        for (let cy = 0; cy * Z.ch < rows; cy++) {
            if (due()) yield;
            for (let cx = 0; cx * Z.cw < cols; cx++) {
                if (hash2(cx, cy, Z.salt) >= Z.p) continue;
                const col = cx * Z.cw + Math.floor((0.2 + 0.6 * hash2(cx, cy, Z.salt + 1)) * Z.cw);
                const row = cy * Z.ch + Math.floor((0.2 + 0.6 * hash2(cx, cy, Z.salt + 2)) * Z.ch);
                if (row < 6 || row >= rows - 1 || col < 1 || col >= cols - 10) continue;
                const i = row * cols + col;
                if (surfaces[i] !== S_GRASS) continue;
                const sx = x0 + col + 0.5;
                const sy = y0 + row + 0.5;
                const tx = sx / TILE_WIDTH + sy / TILE_HEIGHT;
                const ty = sy / TILE_HEIGHT - sx / TILE_WIDTH;
                const forest = bilin(drift.forest, tx, ty) > FOREST_ZONE;
                const zone = forest ? 2 : edge[i] < MOWN_ROWS || aoBuf[i] > 0 ? 0 : 1;
                if (zone !== Z.zone) continue;
                const pick = hash2(cx, cy, Z.salt + 3);
                const stamp = Z.stamps[Math.floor(pick * Z.stamps.length)];
                const R = forest ? GRASS_LUSH : grassRampAt(drift, tx, ty);
                stampTuft(ctx, stamp, col, row, R, stepBuf[i] & STOP_MASK, hash2(cx, cy, Z.salt + 4) < 0.3);
            }
        }
    }
}

// 2.7 — OA-T3 transitions along the first ring of turf (chamfer 5–19, the
// texels within two rows of a path): the kerb's grass-owned crease and its
// blades, blades over the path above, a crease with pebbles over the path
// below, dune tufts and the wrack line on the beach, and the earth bank's
// grass lip over an E0 face.
function* drawTransitions(r, ctx) {
    const { cols, rows, x0, y0, surfaces, stepBuf, sdBuf, edge, put, season, due, drift, bankZone } = ctx;
    const winter = season === 'winter';
    const breaks = creaseBreaks();
    const anchors = bladeAnchors();
    const dunes = duneAnchors();
    const pebbles = pebbleRuns();
    const wrack = wrackDashes();
    const breakLow = winter ? GRASS_DRY[2] : GRASS[2];
    const breakHigh = winter ? GRASS_DRY[3] : GRASS[3];
    const N = MAP_SIZE;
    const WRACK_LO = -0.1 * SD_SCALE;
    const WRACK_HI = -0.05 * SD_SCALE;
    const kerb = (j) => (stepBuf[j] & KERB_MASK) !== 0;
    const pathRamp = (s) => (s === S_CINDER ? CINDER : s === S_GRAVEL || s === S_ROAD ? ROAD : s === S_PLAZA ? PLAZA : s === S_FLAG ? PLAZA_COOL : DIRT);
    for (let row = 6; row < rows - 3; row++) {
        if ((row & 7) === 0 && due()) yield;
        const sy = y0 + row + 0.5;
        const span = diamondSpan(row, cols);
        const cEnd = Math.min(cols - 11, span[1]);
        for (let col = Math.max(2, span[0]); col <= cEnd; col++) {
            const i = row * cols + col;
            const s = surfaces[i];
            if (s === S_SAND) {
                // The wrack line: dashes of drift timber and weed along the
                // top row of the strand (sd −0.10 … −0.05), in patches.
                const tone = wrack[col];
                if (!tone) continue;
                const q = sdBuf[i];
                if (q < WRACK_LO || q > WRACK_HI) continue;
                const above = sdBuf[i - cols];
                if (above >= WRACK_LO && above <= WRACK_HI) continue;
                if (hash2(col >> 4, row >> 3, 1655) < 0.35) continue;
                put(col, row, tone === 1 ? TIMBER[1] : DIRT[0]);
                continue;
            }
            if (s !== S_GRASS) continue;
            if (bankZone && surfaces[i + cols] === 255 && sdBuf[i + cols] > 0) {
                // E0 — the earth bank's grass lip: the last land row above
                // the face is its row −1.
                const sx = x0 + col + 0.5;
                const ty = Math.max(0, Math.min(N - 1, Math.round(sy / TILE_HEIGHT - sx / TILE_WIDTH)));
                const tx = Math.max(0, Math.min(N - 1, Math.round(sx / TILE_WIDTH + sy / TILE_HEIGHT)));
                if (bankZone[ty * N + tx] === 1) put(col, row, GRASS[4]);
            }
            const up = surfaces[i - cols];
            if (up === S_SAND) {
                // Dune tufts at the turf's edge, over the strand (the strand
                // is not a chamfer source, so this edge is found here).
                if (dunes[col] & 1 && hash2(col, row, 2211) < 0.35) {
                    stampTuft(ctx, hash2(col, row, 2213) < 0.5 ? TUFTS.T5a : TUFTS.T6a,
                        col, row, GRASS_DRY, Math.min(3, stepBuf[i] & STOP_MASK), hash2(col, row, 2215) < 0.3, true);
                }
                continue;
            }
            const e = edge[i];
            if (e < CHAMFER_A_X || e >= 2 * CHAMFER_A_Y) continue;
            const kerbUp = kerb(i - cols);
            if (kerbUp || kerb(i - 1) || kerb(i + 1) || kerb(i + cols)) {
                // The kerb's crease, broken every 5–9 px by a blade over it.
                if (breaks[col] & 1) {
                    put(col, row, breakLow);
                    if (kerbUp) put(col, row - 1, breakHigh);
                } else {
                    put(col, row, GRASS[0]);
                }
            }
            if (isPath(up) && anchors[col] & 1 && hash2(col, row, 2201) < (kerbUp ? 0.27 : 0.55)) {
                // Blades over the path above: small where the verge is mown
                // (and always over a kerb), mid in unmown stretches, large
                // where deep turf stands behind.
                const sx = x0 + col + 0.5;
                const verge = vnoise(sx / 60, sy / 30, 1206);
                const deep = edge[i + 2 * cols] >= 2 * CHAMFER_A_Y;
                const set = kerbUp || verge < 0.55 ? BLADES_SMALL : deep && hash2(col, row, 2203) < 0.5 ? BLADES_LARGE : BLADES_MID;
                const heights = set[Math.floor(hash2(col, row, 2205) * set.length)];
                const R = grassRampAt(drift, sx / TILE_WIDTH + sy / TILE_HEIGHT, sy / TILE_HEIGHT - sx / TILE_WIDTH);
                for (let x = 0; x < heights.length; x++) {
                    const hgt = heights[x];
                    for (let k = 1; k <= hgt; k++) {
                        if (!isPath(surfaces[i + x - k * cols])) break;
                        put(col + x, row - k, hgt === 1 ? R[3] : k === hgt ? R[4] : k === 1 ? R[2] : R[3]);
                    }
                }
            }
            const down = surfaces[i + cols];
            if (isPath(down) && !kerb(i + cols)) {
                // The path below the turf: a 1 px crease, a pebble every
                // 9–15 px.
                put(col, row + 1, pathRamp(down)[0]);
                if (pebbles[col] & 1 && hash2(col, row, 2221) < 0.6) {
                    put(col, row + 1, ROAD[1]);
                    put(col, row, ROAD[3]);
                }
            }
        }
    }
}

// ---- E1 bake-owned footings -------------------------------------------------

// Paints every landmark's `footing` profile (buildingGrounding.js) under its
// front edges: each column from the first texel whose centre lies on or
// below the edge down, at most FOOTING_MAX_ROWS rows, onto land only; marks
// the texels as footing faces. Returns per-landmark stats.
function drawFootings(r, ctx) {
    const { cols, rows, x0, y0, surfaces, stepBuf, sdBuf, put } = ctx;
    const stats = {};
    for (const b of r.world?.buildings?.values?.() || []) {
        const profile = BUILDING_GROUNDING_PROFILES[b.type];
        const footing = profile?.footing;
        if (!footing) continue;
        let points;
        if (footing.kind === 'rock') {
            const p = b.position;
            const left = tileToWorld(p.tileX, p.tileY + b.height);
            const bottom = tileToWorld(p.tileX + b.width, p.tileY + b.height);
            const right = tileToWorld(p.tileX + b.width, p.tileY);
            points = { left, bottom, right };
        } else {
            points = plinthWorld(r, b, profile);
        }
        if (!points) continue;
        const st = { kind: footing.kind, texels: 0, maxRows: 0, minDy: Infinity, columns: 0 };
        stats[b.type] = st;
        const mark = (col, row, c, edgeY) => {
            if (col < 0 || row < 0 || col >= cols || row >= rows) return false;
            const i = row * cols + col;
            if (surfaces[i] === 255) return false;
            put(col, row, c);
            stepBuf[i] |= FOOTING_FLAG;
            st.texels++;
            const dy = y0 + row + 0.5 - edgeY;
            if (dy < st.minDy) st.minDy = dy;
            return true;
        };
        const segs = [];
        for (let k = 0; k < footing.edges.length - 1; k++) {
            segs.push({ a: points[footing.edges[k]], e: points[footing.edges[k + 1]], face: footing.edges[k] === 'left' ? 'sw' : 'se' });
        }
        const edgeAt = (x) => {
            for (const s of segs) {
                const lo = Math.min(s.a.x, s.e.x);
                const hi = Math.max(s.a.x, s.e.x);
                if (x >= lo && x <= hi) return { y: s.a.y + (s.e.y - s.a.y) * ((x - s.a.x) / ((s.e.x - s.a.x) || 1)), face: s.face, start: s.a.x };
            }
            // Past the corners (rock spread): the end segment's line.
            const s = x < segs[0].a.x ? segs[0] : segs[segs.length - 1];
            return { y: s.a.y + (s.e.y - s.a.y) * ((x - s.a.x) / ((s.e.x - s.a.x) || 1)), face: s.face, start: s.a.x };
        };
        const spread = footing.kind === 'rock' ? footing.spread || 0 : 0;
        const xLo = Math.ceil(segs[0].a.x - spread);
        const xHi = Math.floor(segs[segs.length - 1].e.x + spread);
        for (let x = xLo; x <= xHi; x++) {
            const col = Math.floor(x - x0);
            if (col < 0 || col >= cols) continue;
            const edge = edgeAt(x + 0.5);
            const row0 = Math.ceil(edge.y - y0 - 0.5);
            const sw = edge.face === 'sw';
            const local = x - Math.round(edge.start);
            let painted = 0;
            if (footing.kind === 'rock') {
                // Run from the base edge down to the first water texel.
                let run = -1;
                for (let k = 0; k <= footing.maxRun; k++) {
                    const rr = row0 + k;
                    if (rr >= rows) break;
                    if (sdBuf[rr * cols + col] > 0) { run = k; break; }
                }
                if (run < 1) continue;
                const H = Math.min(run, FOOTING_MAX_ROWS);
                const faceTop = run - H;
                const cell = footing.fracture?.[sw ? 0 : 1] || 13;
                const fk = Math.floor(x / cell);
                const fracAt = hash2(fk, b.position.tileX, 409) < 0.45 ? fk * cell + Math.floor(hash2(fk, 0, 401) * (cell - 1)) : null;
                for (let k = faceTop; k < run; k++) {
                    const rel = k - faceTop;
                    const fromBottom = run - 1 - k;
                    let c;
                    if (fromBottom < (footing.tide || 3)) c = TIDELINE[sw ? 1 : 0];
                    else if (fracAt !== null && rel >= 1 && (x === fracAt || x === fracAt + 1)) c = x === fracAt ? CLIFF[0] : CLIFF[3];
                    else {
                        const role = footing.rows[Math.min(rel, footing.rows.length - 1)];
                        c = CLIFF[sw ? role.sw : role.se];
                    }
                    if (mark(col, row0 + k, c, edge.y)) painted = Math.max(painted, rel + 1);
                }
                // The headland's top: the beach between the tower and the
                // face is rock.
                for (let k = 0; k < faceTop; k++) {
                    const i = (row0 + k) * cols + col;
                    if (surfaces[i] !== S_SAND) continue;
                    put(col, row0 + k, k === faceTop - 1 ? CLIFF[5] : hash2(x, row0 + k, 431) < 0.3 ? CLIFF[3] : CLIFF[4]);
                }
            } else {
                footing.rows.forEach((def, k) => {
                    let stop = sw ? def.sw : def.se;
                    if (def.joint) {
                        const m = ((local + (k > 4 ? 6 : 0)) % def.joint + def.joint) % def.joint;
                        if (m === 0) stop -= 1;
                        else if (m === 1 && sw) stop += 1;
                    }
                    if (def.relief && ((local % def.relief) + def.relief) % def.relief === 0) stop = 3;
                    if (mark(col, row0 + k, ASHLAR[Math.max(0, Math.min(ASHLAR.length - 1, stop))], edge.y)) painted = k + 1;
                });
            }
            if (painted) {
                st.columns++;
                if (painted > st.maxRows) st.maxRows = painted;
            }
        }
        // The dais stair: centred on the projection of tile `at` onto the
        // SW face, each step a tread row over a riser row, widening down.
        const stair = footing.stair;
        if (stair && segs[0]) {
            const s = segs[0];
            const p = tileToWorld(stair.at[0], stair.at[1]);
            const ex = s.e.x - s.a.x;
            const ey = s.e.y - s.a.y;
            const t = Math.max(0.1, Math.min(0.9, ((p.x - s.a.x) * ex + (p.y - s.a.y) * ey) / (ex * ex + ey * ey || 1)));
            const xc = s.a.x + ex * t;
            st.stair = { x: xc, steps: stair.steps };
            for (let i = 0; i < stair.steps; i++) {
                const half = (stair.width + stair.grow * i) / 2;
                for (let x = Math.ceil(xc - half); x < xc + half; x++) {
                    const col = Math.floor(x - x0);
                    const edge = edgeAt(x + 0.5);
                    const row0 = Math.ceil(edge.y - y0 - 0.5);
                    mark(col, row0 + 2 * i, ASHLAR[stair.tread], edge.y);
                    mark(col, row0 + 2 * i + 1, ASHLAR[stair.riser], edge.y);
                    st.maxRows = Math.max(st.maxRows, 2 * i + 2);
                }
            }
        }
        if (!Number.isFinite(st.minDy)) st.minDy = 0;
    }
    return stats;
}

// ---- 5.2 puddle sites ------------------------------------------------------

// Puddles gather only on trodden and paved ground (never grass or sand, never
// hard against a wall): organic 2:1 blobs, one candidate per PUDDLE_CELL.
// The R8 mask stores, per texel, 255·(1 − threshold): the texel holds water
// while the ground state's `puddles` ≥ threshold, with threshold = the site's
// dryness rank (0.6 of it) plus a quarter of the texel's squared distance
// from the site centre, so the last tenth of the puddle level still holds
// the cores of the deepest sites. As
// the ground dries, whole shallow sites vanish and deep ones shrink from the
// rim. 0 = never a puddle. Uploaded on scene unit 11 (V9) by the resident
// renderer; the Canvas path draws the same mask. Built on the 2×1 field grid.
const PUDDLE_SURFACES = new Set([S_DIRT, S_ROAD, S_PLAZA, S_FLAG, S_GRAVEL, S_CINDER, S_EARTH]);
const PUDDLE_CELL_COLS = 30;
const PUDDLE_CELL_ROWS = 22;
const PUDDLE_SITE_CHANCE = 0.34;
const PUDDLE_WALL_AO = 70;

function* puddleSiteSlices({ cols, rows, surfaces, aoBuf, due = () => false }) {
    const mask = new Uint8Array(cols * rows);
    const eligible = (i) => PUDDLE_SURFACES.has(surfaces[i]) && aoBuf[i] < PUDDLE_WALL_AO;
    for (let cy = 0; cy * PUDDLE_CELL_ROWS < rows; cy++) {
        if (due()) yield;
        for (let cx = 0; cx * PUDDLE_CELL_COLS < cols; cx++) {
            if (hash2(cx, cy, 901) > PUDDLE_SITE_CHANCE) continue;
            const cc = cx * PUDDLE_CELL_COLS + 4 + Math.floor(hash2(cx, cy, 902) * (PUDDLE_CELL_COLS - 8));
            const rc = cy * PUDDLE_CELL_ROWS + 3 + Math.floor(hash2(cx, cy, 903) * (PUDDLE_CELL_ROWS - 6));
            if (cc >= cols || rc >= rows || !eligible(rc * cols + cc)) continue;
            // Half-width in 2-px texels equals half-height in rows: a 2:1
            // ellipse on the ground plane (6–14 world px across).
            const rx = 3 + hash2(cx, cy, 904) * 4;
            const ry = rx * (0.72 + hash2(cx, cy, 905) * 0.2);
            const dryness = hash2(cx, cy, 907);
            const salt = 911 + cx * 131 + cy * 17;
            for (let row = Math.max(0, Math.floor(rc - ry - 2)); row <= Math.min(rows - 1, Math.ceil(rc + ry + 2)); row++) {
                for (let col = Math.max(0, Math.floor(cc - rx - 2)); col <= Math.min(cols - 1, Math.ceil(cc + rx + 2)); col++) {
                    const i = row * cols + col;
                    if (!eligible(i)) continue;
                    const dx = (col + 0.5 - cc) / rx;
                    const dy = (row + 0.5 - rc) / ry;
                    const radius = Math.hypot(dx, dy) + (vnoise(col / 2.5, row / 2, salt) - 0.5) * 0.55;
                    if (radius >= 1) continue;
                    const r = Math.max(0, radius);
                    const threshold = Math.max(0.02, dryness * 0.6 + r * r * 0.25);
                    const value = Math.max(1, Math.round(255 * (1 - threshold)));
                    if (value > mask[i]) mask[i] = value;
                }
            }
        }
    }
    return mask;
}

// ---- 5.2 winter ground -----------------------------------------------------

// Snow lies only after the village's own winter precipitation (C-W2
// `snowCover`, M9): the base bake is re-toned per quarter of snow cover (≤ 4
// bakes over a day's snowfall). World-anchored fbm + a 2×2 Bayer decide where
// snow lies; each snowy texel takes the `snow` ramp stop of its own luminance
// rank, so the ground's texture reads through the snow. Grass and sand take
// full courses; trodden earth turns to slush (grey snow over the dark ruts);
// paving is swept (whole drifts only where the snow lies deepest, elsewhere a
// dark seam in the deepest joints); cover thins under tree crowns and
// at the eaves (contact AO). Bake-owned footing faces (E1) are vertical
// stone and take none. Doors, banners and status marks are sprites and
// overlays drawn over the terrain, so snow never covers them. A clear night
// from November to February rimes the lawns white instead (`frost`, BI-5):
// the whole rime at quarter 4, and at 3–1 only what FrostMelt keeps (the
// shade of the raking casts and walls, and the open lawn far from the sun).
const SNOW = ramp('snow');
const lumaOf = (c) => c[0] * 0.2126 + c[1] * 0.7152 + c[2] * 0.0722;
const SNOW_RANK_LUMAS = SURFACES.map(s => s.ramp.map(lumaOf));
const SNOW_GRASS = new Set([S_GRASS, S_SAND]);
const SNOW_SLUSH = new Set([S_DIRT, S_CINDER, S_EARTH]);
// Five ground ranks map onto four snow stops ([1, 2, 3, 3, 4]) so hollows and
// contact AO read in cool snow shade while live SD-1 ShadeField owns cast shade.
const SNOW_TONE_BY_RANK = Object.freeze([1, 2, 3, 3, 4]);
// BI-5 — the share of the lit grass texels a frost rimes.
const FROST_DENSITY = 0.8;
// GW-3 (look `gw3`) — frost in patches: a texel rimes where a low-frequency
// world-locked field (FROST_PATCH_SCALE 2-px columns across, 2:1 on the
// ground) (the hollows and open ground where cold air pools) pushed up under
// shelter (no rime forms under eaves or crowns) stays under FROST_PATCH_ON.
// The strength s scales the per-texel grain (FROST_PATCH_GRAIN at 1, ragged
// at 0.5) and fills the dark creases (share s of them rime inside a patch,
// all at 1). The tone rides the frost quarter: the night's whole rime
// (quarter 4) is calm, one snow stop with a lit stop only on the brightest
// blades and a dithered rim; the melting dawn quarters are crisp, two stops
// and a hard dark wet edge where the rime has gone.
const FROST_PATCH_SCALE = 12;
const FROST_PATCH_ON = 0.5;
const FROST_PATCH_GRAIN = 0.05;
const FROST_PATCH_SHELTER = 0.5;
const FROST_PATCH_RIM = 0.035;
// EY-5 — the rising rime's patch threshold per quarter (1–3; 4 is
// FROST_PATCH_ON): each quarter's patches hold the last's, growing out from
// the coldest open ground.
const FROST_RISE_ON = Object.freeze([0, 0.32, 0.39, 0.45]);

// Whether a texel at world-px column `wx` (from x0) rimes at patch strength
// `s` (> 0) under threshold `on`; 2 = the rim course, 1 = inside, 0 = none.
// The shelter is read from the weather field's 2×1 cell.
function frostPatchAt(col, wx, row, rank, s, weather, on = FROST_PATCH_ON) {
    const o = (row * weather.cols + (wx >> 1)) * 4;
    const shelter = weather.data[o + 1] / 255;
    const field = fbm(wx / (FROST_PATCH_SCALE * 2), row / (FROST_PATCH_SCALE / 2), 1409)
        + (hash2(col, row, 1409) - 0.5) * (FROST_PATCH_GRAIN + (1 - s) * 0.5)
        + FROST_PATCH_SHELTER * shelter;
    if (field >= on) return 0;
    if (rank < 2 && hash2(col, row, 1411) >= s) return 0;
    return on - field < FROST_PATCH_RIM ? 2 : 1;
}

// EY-3 — the eave cover over the texel centred at world (sx, sy): the
// contact AO's occluders, each weighted by its shelter share.
function shelterAt(occluders, sx, sy) {
    const tx = sx / TILE_WIDTH + sy / TILE_HEIGHT;
    const ty = sy / TILE_HEIGHT - sx / TILE_WIDTH;
    const N = MAP_SIZE;
    const clampI = (v) => (v < 0 ? 0 : v >= N ? N - 1 : v);
    const bucket = occluders[clampI(Math.round(ty)) * N + clampI(Math.round(tx))];
    return bucket ? occlusionAt(bucket, tx, ty, true) : 0;
}

function rankOf(luma, lumas) {
    let best = 0;
    let bestD = Infinity;
    for (let k = 0; k < lumas.length; k++) {
        const d = Math.abs(lumas[k] - luma);
        if (d < bestD) { bestD = d; best = k; }
    }
    return best;
}

// `rising` (EY-5): a frost quarter of the night's rising rime (1–3), which
// grows on the patch field in the calm night tone instead of melting.
export function bakeWinterGround(r, base, snowBucket, frost, frostPatches = 0, rising = false) {
    const bands = winterGroundBands(r, base, snowBucket, frost, frostPatches, rising);
    let step = bands.next();
    while (!step.done) step = bands.next();
    return step.value;
}

// Rows of the winter bake per idle slice when a stage is prepared off the
// frame (`prepare` below).
const WINTER_BAND_ROWS = 64;

// The world-anchored fbm of one row, sampled every NOISE_STEP px and read
// linearly between (the fields vary over 26–30 px).
const NOISE_STEP = 4;
function rowNoise(out, row, sxScale, rowScale, salt) {
    for (let k = 0; k < out.length; k++) out[k] = fbm(k * NOISE_STEP / sxScale, row / rowScale, salt);
    return (wx) => {
        const g = wx / NOISE_STEP;
        const k = g | 0;
        const f = g - k;
        return out[k] + (out[k + 1] - out[k]) * f;
    };
}

// The winter bake in bands of WINTER_BAND_ROWS rows: yields between bands,
// returns the canvas. Re-tones the 1×1 colour lattice texel by texel.
function* winterGroundBands(r, base, snowBucket, frost, frostPatches = 0, rising = false) {
    const { rows, x0, y0, weather } = base;
    const grid = base.color || { cols: base.cols, texelW: base.texelW || FIELD_TEXEL_W, surfaces: base.surfaces, aoBuf: base.aoBuf, stepBuf: null };
    const { cols, texelW, surfaces, aoBuf, stepBuf } = grid;
    const patches = weather ? frostPatches : 0;
    const w = cols * texelW;
    const image = base.canvas.getContext('2d').getImageData(0, 0, w, rows);
    const D = image.data;
    const cover = Math.max(0, Math.min(4, snowBucket)) / 4;
    const crowns = cover > 0 ? buildCrownField(r, { cols, rows, x0, y0, texelW }) : null;
    // EY-3 — the eaves thin the snow by each occluder's shelter share, read
    // only where the contact AO is non-zero.
    const occluders = cover > 0 ? buildOccluders(r) : null;
    const rime = frostQuarterOf({ frost });
    const rise = rising && rime > 0 && rime < 4;
    const night = rime >= 4 || rise;
    const shade = rime > 0 && rime < 4 && !rise ? frostShadeField(r, { cols, rows, x0, y0, texelW, aoBuf }) : null;
    const write = texelW === 1
        ? (o, c) => { D[o] = c[0]; D[o + 1] = c[1]; D[o + 2] = c[2]; }
        : (o, c) => { D[o] = c[0]; D[o + 1] = c[1]; D[o + 2] = c[2]; D[o + 4] = c[0]; D[o + 5] = c[1]; D[o + 6] = c[2]; };
    const span = new Float32Array(Math.ceil(w / NOISE_STEP) + 2);
    const meltSpan = new Float32Array(span.length);
    for (let row = 0; row < rows; row++) {
        if (row > 0 && row % WINTER_BAND_ROWS === 0) yield;
        const snowNoise = rowNoise(span, row, 30, 15, 1401);
        const meltNoise = rime ? rowNoise(meltSpan, row, 26, 13, 1413) : null;
        const lattice = diamondSpan(row, cols, texelW);
        const cEnd = lattice[1];
        for (let col = lattice[0]; col <= cEnd; col++) {
            const i = row * cols + col;
            const s = surfaces[i];
            if (s === 255) continue;
            if (stepBuf && stepBuf[i] & FOOTING_FLAG) continue;
            const o = (row * w + col * texelW) * 4;
            const rank = rankOf(lumaOf([D[o], D[o + 1], D[o + 2]]), SNOW_RANK_LUMAS[s]);
            const sx = col * texelW;
            const noise = snowNoise(sx) + BAYER[(row & 1) * 2 + (col & 1)] * 0.1;
            let snowy = false;
            if (cover > 0) {
                const cd = crowns.dist[i] / CROWN_DIST_SCALE;
                const crownThin = cd < 1 ? 0.3 + 0.7 * cd : 1;
                const eave = aoBuf[i] ? shelterAt(occluders, x0 + sx + texelW / 2, y0 + row + 0.5) : 0;
                const eaveThin = 1 - Math.min(1, eave * 1.8) * 0.9;
                let local = cover * crownThin * eaveThin;
                if (s === S_SAND) local *= 0.6;
                const threshold = 0.1 + local * 0.88;
                if (SNOW_GRASS.has(s)) {
                    if (noise < threshold) {
                        snowy = true;
                        // A thin course one stop darker at each drift's rim.
                        const rim = threshold - noise < 0.05 ? 1 : 0;
                        write(o, SNOW[Math.max(0, SNOW_TONE_BY_RANK[rank] - rim)]);
                    }
                } else if (SNOW_SLUSH.has(s)) {
                    if (noise < threshold * 0.85) {
                        snowy = true;
                        // Slush: grey packed snow on the crowns of the ruts,
                        // the dark ruts themselves stay open.
                        if (rank >= 2) write(o, SNOW[rank >= 4 ? 1 : 0]);
                    }
                } else if (noise < threshold * 0.4) {
                    // Paving: a drift lies whole over the stones where the
                    // snow is deepest, one stop under a grass snowfield.
                    snowy = true;
                    write(o, SNOW[Math.max(0, SNOW_TONE_BY_RANK[rank] - 1)]);
                } else if (rank === 0 && noise < threshold * 0.8) {
                    // The swept rest keeps snow only in its deepest joints,
                    // in the darkest snow stop, so the joints read as a cool
                    // seam, not a light lattice over the stones.
                    snowy = true;
                    write(o, SNOW[0]);
                }
            }
            // BI-5 — the rime: most of the lit grass (ranks 2–4) a stop under
            // the snow, its dark creases left green so the lawn's texture
            // reads through; kept by quarter in shade and far from the sun.
            if (snowy || !rime || s !== S_GRASS) continue;
            if (patches > 0) {
                // GW-3 — frost in patches (see FROST_PATCH_ON).
                const patch = frostPatchAt(col, sx, row, rank, patches, weather, rise ? FROST_RISE_ON[rime] : FROST_PATCH_ON);
                if (!patch || !(night || frostHolds(rime, shade, col, row, meltNoise(sx)))) continue;
                if (night) {
                    if (patch === 2 && BAYER[(row & 1) * 2 + (col & 1)] > 0) continue;
                    write(o, SNOW[rank >= 4 ? 1 : 0]);
                } else {
                    write(o, patch === 2 ? GRASS[0] : SNOW[rank >= 3 ? 1 : 0]);
                }
                continue;
            }
            if (rank >= 2 && hash2(col, row, 1409) < FROST_DENSITY * (rise ? rime / 4 : 1)
                && (night || frostHolds(rime, shade, col, row, meltNoise(sx)))) {
                write(o, SNOW[rank >= 3 ? 1 : 0]);
            }
        }
    }
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = rows;
    canvas.getContext('2d').putImageData(image, 0, 0);
    return canvas;
}

// ---- install --------------------------------------------------------------

// Registers the bake on the renderer. The pass revision (read every frame
// as part of the terrain-cache key) tracks the land sheets loading (settling
// to a constant once they have) and the winter ground: the C-W2 snow bucket
// and frost quarter from `renderer._groundState`, so the terrain rebakes only
// when a quarter of snow cover or of the rime changes (at most eight frost
// bakes a frosty day: the rising quarters 1, 2, 3 and the whole rime, EY-5,
// then quarters 3, 2, 1 and none).
// Season, scenery and the coast field already key the terrain cache through
// their own entries. The cached
// image is re-keyed on all of them at bake time only. Weather and time of day
// never reach the base bake; the grade owns them.
const SHEET_IDS = [...new Set(Object.values(TEXTURE_SOURCES).flat().map(([id]) => id))];

function winterKeyOf(renderer) {
    const ground = renderer._groundState;
    const bucket = snowBucketOf(ground?.snowCover);
    const frost = frostQuarterOf(ground);
    // GW-3: the patch strength keys only a frosty bake, and only when on, so
    // the look at 0 keeps today's key.
    const patches = frost ? frostPatchStrength() : 0;
    // EY-5: the night's rising rime ('r') bakes apart from the dawn melt.
    const rising = frostRisingOf(ground);
    // SD-1: a melting frost lies in the sundial's shade while that look is on
    // (FrostMelt `frostShadeKey`, '' with it off).
    return bucket || frost ? `w${bucket}f${frost}${rising ? 'r' : ''}${patches ? `p${patches}` : ''}${rising ? '' : frostShadeKey(frost)}` : '';
}

export function frostPatchStrength() {
    return lookStrength('gw3');
}

// The looks that read the ground weather field: GW-3's frost patches (baked
// into the terrain, so every backend, and only while a frost lies) and
// GW-1 / GW-2 (the GPU scene only).
export function groundWeatherLooksOn(frost = 0) {
    return (frost > 0 && lookStrength('gw3') > 0) || lookStrength('gw1') > 0 || lookStrength('gw2') > 0;
}

// Whether this renderer's bake needs the field: never at looks 0, for GW-3
// only while a frost lies, and for GW-1 / GW-2 never on Canvas, which does
// not read it.
// `frost` defaults to the renderer's own ground state (the saved-bake key
// passes the quarter it keys on). The saved-bake key carries 'weather' on
// exactly this answer, so it says what the bake holds on every backend.
export function groundWeatherWanted(renderer, frost = frostQuarterOf(renderer?._groundState)) {
    return (lookStrength('gw3') > 0 && frost > 0)
        || ((lookStrength('gw1') > 0 || lookStrength('gw2') > 0) && renderer?.worldRendererMode !== 'canvas');
}

export function installGroundBake(renderer) {
    let cached = null;
    let winter = null;
    let sheetsReady = false;
    const sheetsKey = () => {
        if (sheetsReady) return 'sheets';
        const assets = renderer.assets;
        let loaded = 0;
        for (const id of SHEET_IDS) if (assets?.get?.(id, { request: false })) loaded++;
        // The World Ash's root AO reads its sprite (getWorldAshRootField), so
        // the bake waits on it like a sheet: a bake made before it loads keys
        // apart and rebakes once it arrives, never keeping the fallback blob.
        const ashLoaded = Boolean(assets?.get?.(TREE_SPRITES['ash.world'].id, { request: false }));
        sheetsReady = loaded === SHEET_IDS.length && ashLoaded;
        return sheetsReady ? 'sheets' : `sheets:${loaded}${ashLoaded ? '+ash' : ''}`;
    };
    // The base bake's key: what `bakeGround` reads.
    const baseKeyOf = (withWeather) => `${getCoastField(renderer).key}|${sheetsKey()}|${renderer._terrainSeason || 'summer'}|${renderer._terrainPhenology?.ground ?? ''}|${renderer._terrainSceneryRevision || 0}${withWeather ? '|weather' : ''}`;
    const adopt = (key, baked) => {
        const mask = {
            data: baked.puddleMask,
            cols: baked.cols,
            rows: baked.rows,
            x0: baked.x0,
            y0: baked.y0,
            texelW: FIELD_TEXEL_W,
            revision: key,
        };
        withWeatherField(mask, baked.weather);
        cached = { key, ...baked, mask };
    };
    // The renderer's ground fields follow the base the terrain was drawn
    // from (a restage publishes them with its canvas; a dropped one leaves
    // the next draw to publish them).
    const publish = () => {
        if (renderer.groundField === cached.field && renderer.groundPuddleMask === cached.mask) return;
        renderer.groundField = cached.field;
        renderer.groundBakeMs = Math.round(cached.ms);
        renderer.groundPuddleMask = cached.mask;
    };
    // One generator to completion, a step per call: true once done.
    const stepper = (bands, done) => {
        let ms = 0;
        return () => {
            const started = performance.now();
            const step = bands.next();
            ms += performance.now() - started;
            if (!step.done) return false;
            done(step.value, ms);
            return true;
        };
    };
    return renderer.registerTerrainBakePass({
        id: 'ground-splat',
        stage: 'ground',
        // GW: 'w' while the ground weather field is wanted ('' at looks 0).
        revision: () => `${sheetsKey()}${winterKeyOf(renderer)}${groundWeatherWanted(renderer) ? 'w' : ''}`,
        // EY-5 — the revision without the winter stage: a change of snow
        // bucket or frost quarter alone (and the ground weather field GW-3's
        // frost brings with it) is re-staged off the frame (IsometricRenderer
        // `_stageTerrainOffFrame`), the current terrain presenting until the
        // new one is complete.
        baseRevision: () => `${sheetsKey()}${groundWeatherWanted(renderer, 0) ? 'w' : ''}`,
        // EY-5 — the next winter stage in bands, one per idle slice: a
        // stepper that returns true once the stage is ready (null when there
        // is nothing to prepare): first the base with the weather field when
        // the stage brings it, then the winter canvas. `draw` then only
        // blits it.
        prepare() {
            const withWeather = groundWeatherWanted(renderer);
            const key = baseKeyOf(withWeather);
            const steps = [];
            if (!cached || cached.key !== key) {
                steps.push(stepper(groundBands(renderer, withWeather), (baked) => adopt(key, baked)));
            }
            steps.push(() => {
                const winterKey = winterKeyOf(renderer);
                if (!winterKey || winter?.key === `${key}|${winterKey}`) return true;
                const ground = renderer._groundState;
                const frost = frostQuarterOf(ground);
                steps.push(stepper(winterGroundBands(renderer, cached, snowBucketOf(ground?.snowCover), frost,
                    frost ? frostPatchStrength() : 0, frostRisingOf(ground)), (canvas, ms) => {
                    if (winter) releaseCanvasBackingStore(winter.canvas);
                    winter = { key: `${key}|${winterKey}`, canvas };
                    renderer.groundWinterBakeMs = Math.round(ms);
                }));
                return true;
            });
            if (cached?.key === key && winter?.key === `${key}|${winterKeyOf(renderer)}`) return null;
            return () => {
                if (steps[0]()) steps.shift();
                return steps.length === 0;
            };
        },
        draw(ctx) {
            const withWeather = groundWeatherWanted(renderer);
            const key = baseKeyOf(withWeather);
            if (!cached || cached.key !== key) adopt(key, bakeGround(renderer, withWeather));
            publish();
            const winterKey = winterKeyOf(renderer);
            if (!winterKey) {
                if (winter) releaseCanvasBackingStore(winter.canvas);
                winter = null;
                ctx.drawImage(cached.canvas, cached.x0, cached.y0);
                return;
            }
            if (!winter || winter.key !== `${key}|${winterKey}`) {
                if (winter) releaseCanvasBackingStore(winter.canvas);
                const ground = renderer._groundState;
                const started = performance.now();
                winter = {
                    key: `${key}|${winterKey}`,
                    canvas: bakeWinterGround(renderer, cached, snowBucketOf(ground?.snowCover), frostQuarterOf(ground),
                        frostQuarterOf(ground) ? frostPatchStrength() : 0, frostRisingOf(ground)),
                };
                renderer.groundWinterBakeMs = Math.round(performance.now() - started);
            }
            ctx.drawImage(winter.canvas, cached.x0, cached.y0);
        },
    });
}

// GW-1 / GW-2 — the puddle mask carries a reference to the ground weather
// field on its grid, so the GPU feed (which already forwards the mask) can
// bind the field to the puddle unit. Non-enumerable: the persisted artifact
// keeps the field once, in `field.weather`, and the mask's spread copy and
// digest stay as they were.
function withWeatherField(mask, weather) {
    if (mask && weather) Object.defineProperty(mask, 'weather', { value: weather, enumerable: false, configurable: true });
    return mask;
}

// Complete installed ground outputs. The base/winter canvases and their scratch
// surfaces/AO are private to the bake closure, not later-pass inputs; the final
// terrain RGBA carries their pixels. Keep the accessors on one implementation.
export function captureGroundArtifact(renderer) {
    const field = renderer.groundField;
    if (!field || !renderer.groundPuddleMask) return null;
    return {
        field: { bounds: { ...field.bounds }, cols: field.cols, rows: field.rows, texelW: field.texelW, classes: field.classes,
            // Saved only when baked (a look reads it; never at looks 0).
            ...(field.weather ? { weather: field.weather } : {}) },
        puddleMask: { ...renderer.groundPuddleMask },
        groundBakeMs: renderer.groundBakeMs,
        groundWinterBakeMs: renderer.groundWinterBakeMs,
    };
}

// The persisted ground fields live on the 2×1 field grid (FIELD_TEXEL_W);
// the 1×1 colour lattice persists only as the terrain's RGBA pixels.
export function validGroundArtifact(ground) {
    const field = ground?.field;
    const mask = ground?.puddleMask;
    const w = MAP_SIZE * TILE_WIDTH;
    const h = MAP_SIZE * TILE_HEIGHT;
    const cols = w / FIELD_TEXEL_W;
    return field?.cols === cols && field.rows === h && field.texelW === FIELD_TEXEL_W
        && field.bounds?.x === -MAP_SIZE * HALF_W && field.bounds.y === -HALF_H
        && field.bounds.w === w && field.bounds.h === h
        && field.classes instanceof Uint8Array && field.classes.length === cols * h
        && (field.weather === undefined || validGroundWeather(field.weather))
        && mask?.cols === cols && mask.rows === h && mask.texelW === FIELD_TEXEL_W
        && mask.x0 === field.bounds.x && mask.y0 === field.bounds.y
        && mask.data instanceof Uint8Array && mask.data.length === cols * h
        && typeof mask.revision === 'string'
        && (ground.groundBakeMs === undefined || Number.isFinite(ground.groundBakeMs))
        && (ground.groundWinterBakeMs === undefined || Number.isFinite(ground.groundWinterBakeMs));
}

export function restoreGroundArtifact(renderer, ground) {
    if (!validGroundArtifact(ground)) throw new Error('Invalid terrain ground artifact');
    renderer.groundField = groundFieldFrom(ground.field);
    renderer.groundPuddleMask = withWeatherField(ground.puddleMask, ground.field.weather);
    renderer.groundBakeMs = ground.groundBakeMs;
    renderer.groundWinterBakeMs = ground.groundWinterBakeMs;
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
