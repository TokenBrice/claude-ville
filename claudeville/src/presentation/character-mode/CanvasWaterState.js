// 3.12 — Canvas water parity: the resident water grammar on the 2D canvas.
//
// The resident scene pass (`applyWaterState`, `applyCoastSwash`,
// `reflectionRippleUv`, the 2.9 column landing in SCENE_FRAGMENT) and the
// composite's open sea (`shadeOpenSea`) shade the water per world texel on
// the one motion clock. Canvas cannot run a fragment program over its
// terrain cache, so it lands the same rules on the same world texels from
// the same bakes, as cached layers drawn in world space over the terrain
// (after the mood copy), in the resident priority order:
//
//  - the sea body (3.3 (a) `seaBodyStop`): open water (in-map texels as deep
//    as the open sea on their row, and the open sea) at its static body stop
//    (the sun-key courses, each swell set's lit slope and trough), one
//    canvas per world chunk holding only the texels it moves, drawn per
//    frame and rebuilt only with the palette or the ocean bake;
//  - the sunlit course (3.4): where the cloud field is clearest, open water
//    one stop lighter than its body stop (each chunk's lift canvas) masked by
//    the drifting sunlit tile, recomposited only when the drift crosses a
//    world texel or the view moves;
//  - the step overlay (view-sized, one texel per world px), rebuilt only when
//    a water step or the viewed rect changes: 3.7's reflection row ripple,
//    the static swell caps and crest strokes (3.3 (a) `swellCap`, cached per
//    world chunk: in-map open water, the sea's shelf and the open sea) with
//    C-W3 cat's paws adding caps on the 125 ms gust steps, 3.10's caustic net
//    (or, on the static frame, today's static dashes), 3.1's near-shore /
//    river current course (the baked cycle-offset field) and deep swell
//    crests (the world phase field; two stops lighter where the swell shoals
//    near the island), 3.10's seabed specks, 3.9's rain rings and 3.6's swash
//    and wet band; an open-sea mark takes its band and haze course
//    (`canvasSeaMarkRgb`), catching more of the sky inside the band;
//  - the Lighthouse sheen (2.7), rebuilt when the fan turns;
//  - the sun/moon path (3.2), screen-anchored like the resident path, the
//    pale day path thinning past NOON_GLINT_FULL_TEXEL backing px a texel,
//    rebuilt on the 6 Hz water step or a pan;
//  - the lamp columns (2.9), rebuilt on the 4 Hz ripple step or when a light
//    changes.
//
// Every lit texel takes an authored palette entry (the next shallower
// COAST_WATER_STOPS colour, FOAM_CREST, FOAM, a seabed speck, a caustic, the
// seaPath and beaconFire stops, a column landed on the C1 emissive ramp), then
// the Canvas water transform (the night / storm mood and V6's saturation cap
// moved before the frame grade, as the mood copy does), so it lands within
// palette tolerance of the resident frame. Reads no agent state; reduced
// motion and MINIMAL show the resident static frame (caps, static dashes,
// specks, the phase-0 caustics, a fixed 20 % ring set, the frozen path and
// columns).

import { ART_RAMPS } from '../../config/artPalette.js';
import { MAP_SIZE, TILE_HEIGHT, TILE_WIDTH } from '../../config/constants.js';
import { sourceEnergyFor } from './AtmosphereState.js';
import * as CanvasGrade from './CanvasGrade.js';
import { cloudCourseOffset, cloudPlane, cloudSunlitTile, cloudTileSample } from './CloudShadowCourses.js';
import { drawCarvedTerrainLayer } from './EmitterCuts.js';
import { footprintFieldFor } from './FootprintField.js';
import { waterMaxSaturation } from './GradeEvaluator.js';
import {
    canvasGlint,
    canvasSeaKey,
    canvasSeaMarkRgb,
    COAST_FIELD_FLAGS,
    RIVER_THREAD_AXES,
    seaBandBend,
    COAST_PALETTE,
    DEPTH_BOUNDS,
    foamNightScale,
    mirrorStormDrop,
    OCEAN_HORIZON_WORLD_Y,
    OPEN_SEA_BAND_DEPTH,
    OPEN_SEA_DEEPEST,
    OPEN_SEA_LIGHT_REACH,
    openSeaDepthAt,
    openSeaHazeRows,
    openSeaStopAt,
    SEA_FRESNEL_BANDS,
    SEA_FRESNEL_Y,
    SEA_SEAM_ROWS,
    WATER_SUN_BAND,
    waterMoodFor,
    waterMoodKey,
    waterSunBandFor,
    waterSurfaceRgb,
} from './CoastBake.js';
import { DEEP_DASH_DENSITY, FOOTPRINT_MARCH_STEPS, NOON_GLINT_GROW_GAIN, resolveStarlight, resolveSurfGlow, seaSunLift, stillWaterWindShare, swellDriftRows } from './gpu/GpuFrameState.js';
import {
    DEEP_CREST_RUN,
    GLINT_DASH_DENSITY,
    GLINT_NOON_BASE,
    liftMoonPathRgb,
    MOON_DASH_HOLD,
    NEAR_SHORE_DASH_DENSITY,
    NOON_DASH_HOLD,
    NOON_GLINT_FULL_TEXEL,
    GRASS_GUST_ORDER_BASE,
    GRASS_GUST_ORDER_CAP,
    GRASS_GUST_ORDER_GAIN,
    SUN_SPARK_SHARE,
    SEA_PAW_CAP_BASE,
    SEA_PAW_CAP_GAIN,
    SEA_PAW_THRESHOLD,
    STARLIGHT_DENSITY,
    STARLIGHT_HOLD,
    STILL_MIRROR_BREAK,
    STILL_PAW_ORDER,
    STILL_PAW_RIPPLE,
    SURF_GLOW_RGB,
    SWASH_PEEL_ROWS,
    SWASH_STEP_RATE,
    SWASH_STEP_TILES,
    SEA_BODY_ROWS,
    SEA_KEY_REACH,
    SEA_KEY_SHIFT,
    SEA_KEY_SPAN,
    SEA_KEY_WOBBLE,
    SWELL_AMP_FLOOR,
    SWELL_AMP_RUN,
    SWELL_AMP_SPAN,
    SWELL_CALM_TILES,
    SWELL_CAP_CELL,
    SWELL_CLUSTER_CAPS,
    SWELL_CHOP_FLOOR,
    SWELL_CHOP_LIT_ROWS,
    SWELL_CHOP_PERIOD,
    SWELL_CHOP_RUN,
    SWELL_CHOP_TROUGH_ROWS,
    SWELL_CHOP_WARP,
    SWELL_CHOP_WARP_CELL,
    SWELL_CLUSTER_CELL,
    SWELL_CREST_GAPS,
    SWELL_CREST_HEIGHT,
    SWELL_CREST_RISE,
    SWELL_CREST_ROWS,
    SWELL_CREST_RUN,
    SWELL_FAR_CALM_TILES,
    SWELL_GAP_GAIN,
    SWELL_LIT_FLOOR,
    SWELL_LIT_ROWS,
    SWELL_LIT_STEPS,
    SWELL_LONE_CAPS,
    SWELL_NEAR_FADE,
    SWELL_PACKET_FLOOR,
    SWELL_PACKET_RUN,
    SWELL_PACKET_SPAN,
    SWELL_SET_GAIN,
    SWELL_SET_LEAD,
    SWELL_SET_NORMAL,
    SWELL_SET_PERIOD,
    SWELL_SET_SHARE,
    SWELL_SET_SHARE_OPEN,
    SWELL_SET_WARP,
    SWELL_SET_WARP_FINE,
    SWELL_SET_WARP_MID,
    SWELL_SHORE_SD,
    SWELL_TROUGH_ROWS,
    SWELL_TURN_ROWS,
    SWELL_WARP_CELL,
    SWELL_WARP_FINE_CELL,
    SWELL_WARP_MID_CELL,
    WATER_COLUMN_GLINT,
    WATER_COLUMN_ROW_FAR,
    WATER_COLUMN_ROW_HOLD,
    WATER_COLUMN_ROW_NEAR,
} from './gpu/GpuWorldRenderer.js';
import { GPU_LANDMARK_IDS } from './gpu/GpuSceneBuilder.js';
import {
    cloudCoveredShare,
    effectBudgetMode,
    SEA_SUN_LIFT_FLOOR,
    isAttentionLight,
    LIGHT_ROLE_CODES,
    lightLaysColumn,
    localLightPhaseForLighting,
    WATER_COLUMN_REACH,
} from './gpu/GpuWorldPolicy.js';
import { baseWindX, gustinessFor, windAt } from './Wind.js';
import { GRASS_GUST_STOPS } from './GroundBake.js';
import { liquidPrecipitation } from './GroundState.js';
import { shadeGroundAt } from './ShadeField.js';

// Texel classes of the terrain bake (one byte per world texel).
const CLS_FOAM = 6;
const CLS_CREST = 7;
const CLS_WET = 8;
const CLS_WET_DARK = 9;
const CLS_BEACH = 10;
const CLS_OTHER = 11;
// W6.11 — a grass gust stop's `from` (GRASS_GUST_STOPS[k][0]) is CLS_GRASS + k.
const CLS_GRASS = 12;
const CLS_EMPTY = 255;
// BI-3 — a swash code's class is its low nibble; SWASH_GLOW marks the sea's
// crest front on the in-steps (BI-8's summer surf glow rides it).
const SWASH_CLASS = 15;
const SWASH_GLOW = 16;
// BI-3 — the swash's global steps: a 12-step wave, every fourth wave of a
// set (48 steps) reaching one lattice step further at its peak.
const SWASH_WAVE = 12;
const SWASH_SET = 48;
// BI-1 — still-water paw candidates are grouped in blocks of this many world
// px, so a rebuild skips a block the gust field cannot reach.
const STILL_BLOCK_W = 16;
const STILL_BLOCK_H = 8;
// BI-1 — a coast cell of still water: painted water by a lagoon.
const STILL_FLAGS = COAST_FIELD_FLAGS.water | COAST_FIELD_FLAGS.lagoon;
// BI-1 — a still-paw candidate's colour code above the stops: FOAM_CREST.
const STILL_CREST = 7;
// BI-8 — the summer surf glow's crest stop, opaque (laid after the grade at
// the glow's strength).
const SURF_GLOW_U32 = ((255 << 24) | (SURF_GLOW_RGB[2] << 16) | (SURF_GLOW_RGB[1] << 8) | SURF_GLOW_RGB[0]) >>> 0;
// W6.11 — the grass gust course's lifted colour per stop (hazed cache albedo,
// like the terrain cache it lands on; the frame's grade applies to both).
const GRASS_GUST_LIFT = GRASS_GUST_STOPS.map(pair => u32Of(to01(pair[1])));

// The step overlay covers the view snapped out to this grid (world px), so a
// slow pan or the continuous dolly reuses it until a water step comes due.
const OVERLAY_SNAP = 64;
// World chunks of the deep swell field (3.1): each lists its present 3x1
// dash cells by the 16 phase buckets of the lead band.
const CHUNK_W = 384;
const CHUNK_H = 192;
const CHUNK_CELLS_X = CHUNK_W / 3;
const CHUNK_BUILDS_PER_FRAME = 16;
const CHUNK_CACHE_MIN = 96;
// A cell is stored when its presence hash can pass in a storm (0.7).
const STORM_DASH_DENSITY = 0.7;
// 3.3 (a) — the static swell caps share the chunk grid; building them costs
// about a millisecond a chunk, so a frame builds until this budget is spent.
const CAP_BUILD_BUDGET_MS = 8;
// Resumable row slice for `buildCapChunk` so no single chunk overruns the budget.
const CAP_ROW_SLICE = 16;
// Maximum idle recycled 384x192 sea canvases kept across zoom/pan/drift swaps
// (24 × ~288 KiB <= ~6.75 MiB; overflow backing stores are explicitly released).
const SEA_CANVAS_POOL_MAX = 24;
// Maximum entries retained in `state.columnMemo` per palette.
const COLUMN_MEMO_MAX = 4096;
// Dirty upload tile size (world px) for sparse column canvas updates.
const COL_TILE = 128;
// Coarse presence grid cell size (world px) for dry-land rejection of rain
// rings and column lights.
const COARSE_GRID_W = 16;
const COARSE_GRID_H = 8;
// Free bits 4..6 of `chunk.classes` carry drift-invariant body/chop state:
// 0 = body disabled, 1 = chop 0, 2 = chop +1, 3 = chop -1; bit 6 = litSteps 2.
const CLS_BODY_SHIFT = 4;
const CLS_LIT_TWO = 64;
const EMPTY_I32 = new Int32Array(0);
const MAX_SWELL_TROUGH = Math.max(SWELL_TROUGH_ROWS[0], SWELL_TROUGH_ROWS[1]);
const MAX_SWELL_LIT = Math.max(SWELL_LIT_ROWS[0], SWELL_LIT_ROWS[1]);
const MAX_CHOP_TROUGH = Math.max(SWELL_CHOP_TROUGH_ROWS[0], SWELL_CHOP_TROUGH_ROWS[1]);
const MAX_CHOP_LIT = Math.max(SWELL_CHOP_LIT_ROWS[0], SWELL_CHOP_LIT_ROWS[1]);
const SEA_NEAR_LO_SQ = 0.75 * 0.75;
const SEA_NEAR_HI_SQ = (1.5 + 0.2 * SWELL_NEAR_FADE) ** 2;
const KEY_ZERO_SQ = (SEA_KEY_REACH + SEA_KEY_WOBBLE + SEA_KEY_SPAN * 0.5 + 1) ** 2;
const KEY_ONE_R = SEA_KEY_REACH - SEA_KEY_WOBBLE - SEA_KEY_SPAN * 0.5 - 1;
const KEY_ONE_SQ = KEY_ONE_R > 0 ? KEY_ONE_R * KEY_ONE_R : -1;
const CALM_ZERO_SQ = SWELL_CALM_TILES[0] * SWELL_CALM_TILES[0];
const FAR_CALM_ONE_SQ = SWELL_FAR_CALM_TILES[1] * SWELL_FAR_CALM_TILES[1];
// Chunk texel flags: bits 0-2 the stop (SEA_NONE: no caps here), then open
// water (the sunlit course and paws), a crest-line texel (its rise is the
// line's), the open sea (colour by band and haze); bits 4-5 the static rise.
const SEA_NONE = 7;
const SEA_OPEN = 8;
const SEA_RISE_SHIFT = 4;
const SEA_CREST_LINE = 64;
const SEA_OPEN_SEA = 128;
const CLS_RAW_MASK = 7 | SEA_OPEN | SEA_OPEN_SEA;
// Past this many rows below the horizon every open-sea texel is the deepest
// stop (the seam contours included).
const SEA_FLAT_ROWS = OPEN_SEA_LIGHT_REACH + SEA_SEAM_ROWS + 2;
// 3.4 — the gust field: GRID x GRID texels over the view (at least 16 x 8
// world px), refilled from `Wind.windAt` on 125 ms steps of the motion clock.
const GUST_GRID = 128;
const GUST_STEP_MS = 125;
// 2.9 — the columns' ripple step (the 4 Hz reflection-ripple step).
const COLUMN_TICK_RATE = 0.004;
const LANTERN_COLUMN_RGB = [1, 0xd5 / 255, 0x6a / 255];
// 3.9 — the ring stamps per life stage, offsets from the ring centre.
const RING_STAGES = Object.freeze([
    [[0, 0]],
    [[-1, 0], [1, 0]],
    [[-1, -1], [0, -1], [1, -1], [-1, 1], [0, 1], [1, 1], [-2, 0], [2, 0]],
    [[-2, -2], [-1, -2], [0, -2], [1, -2], [2, -2], [-2, 2], [-1, 2], [0, 2], [1, 2], [2, 2],
        [-3, -1], [3, -1], [-3, 1], [3, 1], [-4, 0], [4, 0]],
]);

function fract(x) {
    return x - Math.floor(x);
}

function clamp01(value) {
    const n = Number(value);
    return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0;
}

// Fast clamp for known-finite floating-point expressions in hot loops.
function clamp01f(v) {
    return v <= 0 ? 0 : (v >= 1 ? 1 : v);
}

// SEA_SWELL_GLSL waterHash12.
function hash12(x, y) {
    let px = fract(x * 0.1031);
    let py = fract(y * 0.1031);
    let pz = px;
    const d = px * (py + 33.33) + py * (pz + 33.33) + pz * (px + 33.33);
    px += d;
    py += d;
    pz += d;
    return fract((px + py) * pz);
}

// SEA_SWELL_GLSL waterLatticeHash: integer arithmetic on an integer lattice
// point, bit-exact with both shader dialects (seaNoise, the static swell
// caps, the rain rings).
function latticeHash12(x, y) {
    let h = (Math.imul(x, 1597334677) ^ Math.imul(y, 3812015801)) >>> 0;
    h = Math.imul(h ^ (h >>> 16), 2246822519) >>> 0;
    h = (h ^ (h >>> 13)) >>> 0;
    return (h >>> 8) / 16777216;
}

// The same hash in the GPU's float32 arithmetic, every step rounded as the
// shader rounds it: at the column's row and life inputs (hundreds to
// thousands) float32 and double `waterHash12` part ways, and the 2.9
// columns must hash the rows the resident `columnLift` hashes.
const f32 = Math.fround;
const HASH_SCALE_F32 = f32(0.1031);
const HASH_BIAS_F32 = f32(33.33);
function fract32(value) {
    return f32(value - Math.floor(value));
}
function hash12f(x, y) {
    let px = fract32(f32(f32(x) * HASH_SCALE_F32));
    let py = fract32(f32(f32(y) * HASH_SCALE_F32));
    let pz = px;
    const d = f32(f32(f32(px * f32(py + HASH_BIAS_F32)) + f32(py * f32(pz + HASH_BIAS_F32))) + f32(pz * f32(px + HASH_BIAS_F32)));
    px = f32(px + d);
    py = f32(py + d);
    pz = f32(pz + d);
    return fract32(f32(f32(px + py) * pz));
}

// SEA_SWELL_GLSL waterBayer4 on a world texel.
function bayer2(x, y) {
    const ax = Math.floor(x);
    const ay = Math.floor(y);
    return fract(ax * 0.5 + ay * ay * 0.75);
}
function waterBayer4(x, y) {
    return bayer2(x * 0.5, y * 0.5) * 0.25 + bayer2(x, y);
}
// Integer world coordinates repeat `waterBayer4` every 4x4 texels (exact IEEE-754).
const WATER_BAYER4 = new Float64Array(16);
for (let by = 0; by < 4; by++) {
    for (let bx = 0; bx < 4; bx++) WATER_BAYER4[(by << 2) | bx] = waterBayer4(bx, by);
}

const CB_BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
function openSeaStop(x, y) {
    return openSeaStopAt(openSeaDepthAt(x, y), CB_BAYER4[((y & 3) << 2) | (x & 3)] / 16);
}

// SEA_SWELL_GLSL seaNoise: bilinear value noise on smoothstep weights.
function seaNoise(qx, qy) {
    const ix = Math.floor(qx);
    const iy = Math.floor(qy);
    let fx = qx - ix;
    let fy = qy - iy;
    fx = fx * fx * (3 - 2 * fx);
    fy = fy * fy * (3 - 2 * fy);
    const a = latticeHash12(ix + 71, iy + 13);
    const b = latticeHash12(ix + 72, iy + 13);
    const c = latticeHash12(ix + 71, iy + 14);
    const d = latticeHash12(ix + 72, iy + 14);
    const top = a + (b - a) * fx;
    return top + (c + (d - c) * fx - top) * fy;
}

// SEA_SWELL_GLSL islandExcess / seaNear at a world texel's centre: tiles
// past the island diamond, and how near the swell shoals (0.6 in the map, 1
// on the outer shelf, 0 past SWELL_NEAR_FADE tiles).
const MAP_LAST = MAP_SIZE - 0.56;
function excessAt(x, y) {
    const u = (y + 0.5) / TILE_HEIGHT + (x + 0.5) / TILE_WIDTH;
    const v = (y + 0.5) / TILE_HEIGHT - (x + 0.5) / TILE_WIDTH;
    const du = u - Math.max(-0.44, Math.min(MAP_LAST, u));
    const dv = v - Math.max(-0.44, Math.min(MAP_LAST, v));
    return Math.sqrt(du * du + dv * dv);
}
function seaNearOf(excess) {
    return excess < 1.5 ? 0.6 + 0.4 * (excess / 1.5) : clamp01(1 - (excess - 1.5) / SWELL_NEAR_FADE);
}
function seaNearAt(x, y) {
    return seaNearOf(excessAt(x, y));
}

// Fast exact `seaNearAt(x, y) > 0.8`: inside the island diamond excess is 0
// (seaNear = 0.6 <= 0.8), outside check squared bounds without Math.sqrt
// unless within 1e-9 of either threshold.
function isSeaNearCrest(x, y) {
    const u = (y + 0.5) / TILE_HEIGHT + (x + 0.5) / TILE_WIDTH;
    const v = (y + 0.5) / TILE_HEIGHT - (x + 0.5) / TILE_WIDTH;
    const du = u < -0.44 ? u + 0.44 : (u > MAP_LAST ? u - MAP_LAST : 0);
    const dv = v < -0.44 ? v + 0.44 : (v > MAP_LAST ? v - MAP_LAST : 0);
    if (du === 0 && dv === 0) return false;
    const sq = du * du + dv * dv;
    if (sq > SEA_NEAR_LO_SQ + 1e-9 && sq < SEA_NEAR_HI_SQ - 1e-9) return true;
    if (sq < SEA_NEAR_LO_SQ - 1e-9 || sq > SEA_NEAR_HI_SQ + 1e-9) return false;
    return seaNearOf(Math.sqrt(sq)) > 0.8;
}

// Two-slot lattice noise cache for swell height / packet / chop-height fields:
// `set` alternates between 2 adjacent integers across warped rows, so 2 slots
// avoid thrashing while staying O(1) and preserving exact `seaNoise` math.
function createNoise2() {
    return {
        ix0: 0x7fffffff, iy0: 0x7fffffff, a0: 0, b0: 0, c0: 0, d0: 0,
        ix1: 0x7fffffff, iy1: 0x7fffffff, a1: 0, b1: 0, c1: 0, d1: 0,
        next: 0,
    };
}
function sampleNoise2(s, qx, qy) {
    const jx = Math.floor(qx);
    const jy = Math.floor(qy);
    let a, b, c, d;
    if (jx === s.ix0 && jy === s.iy0) {
        a = s.a0; b = s.b0; c = s.c0; d = s.d0;
    } else if (jx === s.ix1 && jy === s.iy1) {
        a = s.a1; b = s.b1; c = s.c1; d = s.d1;
    } else {
        a = latticeHash12(jx + 71, jy + 13);
        b = latticeHash12(jx + 72, jy + 13);
        c = latticeHash12(jx + 71, jy + 14);
        d = latticeHash12(jx + 72, jy + 14);
        if (s.next === 0) {
            s.ix0 = jx; s.iy0 = jy; s.a0 = a; s.b0 = b; s.c0 = c; s.d0 = d;
            s.next = 1;
        } else {
            s.ix1 = jx; s.iy1 = jy; s.a1 = a; s.b1 = b; s.c1 = c; s.d1 = d;
            s.next = 0;
        }
    }
    let fx = qx - jx;
    let fy = qy - jy;
    fx = fx * fx * (3 - 2 * fx);
    fy = fy * fy * (3 - 2 * fy);
    const top = a + (b - a) * fx;
    return top + (c + (d - c) * fx - top) * fy;
}

// Reusable module-level scratch for column-cached `seaBandBend`, Fresnel seams,
// and row-hoisted separable bilinear warp/key tables inside `stepCapDriftRows`
// (~32 KiB static total, 0 bytes per chunk, bit-identical IEEE-754 evaluation).
const _chunkBend7 = new Int8Array(CHUNK_W);
const _chunkBend8 = new Int8Array(CHUNK_W);
const _chunkFresnelBend = new Int8Array(CHUNK_W);
const _rowLiftLut = new Uint32Array(16);
const _rowStopsLiftLut = new Uint32Array(16);
let _warpChunkX0 = 0x7fffffff;
let _warpJyW = 0x7fffffff;
let _warpJyF = 0x7fffffff;
let _warpJyM = 0x7fffffff;
let _warpJyK = 0x7fffffff;
const _xNormal = new Float64Array(CHUNK_W);
const _xOverTw = new Float64Array(CHUNK_W);
const _dxkSq = new Float64Array(CHUNK_W);
const _jxW = new Int32Array(CHUNK_W);
const _fxW = new Float64Array(CHUNK_W);
const _topW = new Float64Array(CHUNK_W);
const _diffW = new Float64Array(CHUNK_W);
const _jxF = new Int32Array(CHUNK_W);
const _fxF = new Float64Array(CHUNK_W);
const _topF = new Float64Array(CHUNK_W);
const _diffF = new Float64Array(CHUNK_W);
const _jxM = new Int32Array(CHUNK_W);
const _fxM = new Float64Array(CHUNK_W);
const _topM = new Float64Array(CHUNK_W);
const _diffM = new Float64Array(CHUNK_W);
const _jxK = new Int32Array(CHUNK_W);
const _fxK = new Float64Array(CHUNK_W);
const _topK = new Float64Array(CHUNK_W);
const _diffK = new Float64Array(CHUNK_W);

function prepareWarpColumns(X0) {
    if (_warpChunkX0 === X0) return;
    _warpChunkX0 = X0;
    _warpJyW = _warpJyF = _warpJyM = _warpJyK = 0x7fffffff;
    const normal = SWELL_SET_NORMAL[0];
    const keyShiftX = SEA_KEY_SHIFT[0];
    const warpW0 = SWELL_WARP_CELL[0];
    const warpFineW0 = SWELL_WARP_FINE_CELL[0];
    const warpMidW0 = SWELL_WARP_MID_CELL[0];
    for (let lx = 0; lx < CHUNK_W; lx++) {
        const x = X0 + lx;
        _xNormal[lx] = x * normal;
        _xOverTw[lx] = (x + 0.5) / TILE_WIDTH;
        const dxk = x + 0.5 - keyShiftX;
        _dxkSq[lx] = dxk * dxk;

        const qxW = x / warpW0 + 3, jxW = Math.floor(qxW);
        let fxW = qxW - jxW; fxW = fxW * fxW * (3 - 2 * fxW);
        _jxW[lx] = jxW; _fxW[lx] = fxW;

        const qxF = x / warpFineW0 + 29, jxF = Math.floor(qxF);
        let fxF = qxF - jxF; fxF = fxF * fxF * (3 - 2 * fxF);
        _jxF[lx] = jxF; _fxF[lx] = fxF;

        const qxM = x / warpMidW0 + 61, jxM = Math.floor(qxM);
        let fxM = qxM - jxM; fxM = fxM * fxM * (3 - 2 * fxM);
        _jxM[lx] = jxM; _fxM[lx] = fxM;

        const qxK = x / 700 + 5, jxK = Math.floor(qxK);
        let fxK = qxK - jxK; fxK = fxK * fxK * (3 - 2 * fxK);
        _jxK[lx] = jxK; _fxK[lx] = fxK;
    }
}

function fillWarpBand(jxArr, fxArr, topArr, diffArr, jy) {
    let ix = 0x7fffffff, a = 0, b = 0, c = 0, d = 0;
    const jy13 = jy + 13;
    const jy14 = jy + 14;
    for (let lx = 0; lx < CHUNK_W; lx++) {
        const jx = jxArr[lx];
        if (jx !== ix) {
            ix = jx;
            a = latticeHash12(jx + 71, jy13);
            b = latticeHash12(jx + 72, jy13);
            c = latticeHash12(jx + 71, jy14);
            d = latticeHash12(jx + 72, jy14);
        }
        const fx = fxArr[lx];
        const top = a + (b - a) * fx;
        topArr[lx] = top;
        diffArr[lx] = (c + (d - c) * fx) - top;
    }
}

// Conservative O(1) proof that no texel in chunk `[X0..X0+CHUNK_W-1] x [Y0..Y0+CHUNK_H-1]`
// can pass `isSeaNearCrest` (either wholly inside island diamond or past outer near-fade).
function chunkHasNoNearCrest(X0, Y0) {
    const xMax = X0 + CHUNK_W - 1;
    const yMax = Y0 + CHUNK_H - 1;
    const uMin = (Y0 + 0.5) / TILE_HEIGHT + (X0 + 0.5) / TILE_WIDTH;
    const uMax = (yMax + 0.5) / TILE_HEIGHT + (xMax + 0.5) / TILE_WIDTH;
    const vMin = (Y0 + 0.5) / TILE_HEIGHT - (xMax + 0.5) / TILE_WIDTH;
    const vMax = (yMax + 0.5) / TILE_HEIGHT - (X0 + 0.5) / TILE_WIDTH;
    if (uMin >= -0.44 && uMax <= MAP_LAST && vMin >= -0.44 && vMax <= MAP_LAST) return true;
    const minDu = uMin > MAP_LAST ? uMin - MAP_LAST : (uMax < -0.44 ? -0.44 - uMax : 0);
    const minDv = vMin > MAP_LAST ? vMin - MAP_LAST : (vMax < -0.44 ? -0.44 - vMax : 0);
    return minDu * minDu + minDv * minDv > SEA_NEAR_HI_SQ + 1e-6;
}

function createBounds() {
    return { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
}
function expandBounds(b, x, y, w = 1, h = 1) {
    if (x < b.x0) b.x0 = x;
    if (y < b.y0) b.y0 = y;
    if (x + w > b.x1) b.x1 = x + w;
    if (y + h > b.y1) b.y1 = y + h;
}
function hasBounds(b) {
    return b && b.x0 < b.x1 && b.y0 < b.y1;
}
function boundsIntersect(a, x0, y0, x1, y1) {
    return a && a.x0 < x1 && a.x1 > x0 && a.y0 < y1 && a.y1 > y0;
}

// First index `k` (multiple of `stride`) in row-sorted `list` with `list[k] >= target`.
function lowerBoundTexel(list, stride, target) {
    let lo = 0;
    let hi = list.length / stride;
    while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (list[mid * stride] < target) lo = mid + 1;
        else hi = mid;
    }
    return lo * stride;
}

function lowerBoundRange(arr, lo, hi, target) {
    while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (arr[mid] < target) lo = mid + 1;
        else hi = mid;
    }
    return lo;
}

// World-aligned coarse presence bitset (16x8 world px cells): storm 8x4 rain
// cells and 8-row column bands map to single aligned coarse cells.
function createCoarseGrid(bx, by, tw, th) {
    const gx0 = Math.floor(bx / COARSE_GRID_W) * COARSE_GRID_W;
    const gy0 = Math.floor(by / COARSE_GRID_H) * COARSE_GRID_H;
    const cols = Math.ceil((bx + tw - gx0) / COARSE_GRID_W);
    const rows = Math.ceil((by + th - gy0) / COARSE_GRID_H);
    return { gx0, gy0, cols, rows, bits: new Uint8Array(Math.ceil((cols * rows) / 8)) };
}
function coarseGridIntersects(grid, x0, y0, x1, y1) {
    const c0 = Math.max(0, Math.floor((x0 - grid.gx0) / COARSE_GRID_W));
    const c1 = Math.min(grid.cols - 1, Math.floor((x1 - 1 - grid.gx0) / COARSE_GRID_W));
    if (c0 > c1) return false;
    const r0 = Math.max(0, Math.floor((y0 - grid.gy0) / COARSE_GRID_H));
    const r1 = Math.min(grid.rows - 1, Math.floor((y1 - 1 - grid.gy0) / COARSE_GRID_H));
    if (r0 > r1) return false;
    const { cols, bits } = grid;
    for (let r = r0; r <= r1; r++) {
        const row = r * cols;
        for (let c = c0; c <= c1; c++) {
            const bit = row + c;
            if (bits[bit >> 3] & (1 << (bit & 7))) return true;
        }
    }
    return false;
}

function sameInt32Array(a, b) {
    if (a === b) return true;
    const la = a ? a.length : 0;
    const lb = b ? b.length : 0;
    if (la !== lb) return false;
    for (let i = 0; i < la; i++) if (a[i] !== b[i]) return false;
    return true;
}

// A seaNoise field whose lattice corners are cached between calls: a chunk
// walks it texel by texel, so the corners change only across a cell.
function latticeNoise() {
    let ix = NaN;
    let iy = NaN;
    let a = 0;
    let b = 0;
    let c = 0;
    let d = 0;
    return (qx, qy) => {
        const jx = Math.floor(qx);
        const jy = Math.floor(qy);
        if (jx !== ix || jy !== iy) {
            ix = jx;
            iy = jy;
            a = latticeHash12(jx + 71, jy + 13);
            b = latticeHash12(jx + 72, jy + 13);
            c = latticeHash12(jx + 71, jy + 14);
            d = latticeHash12(jx + 72, jy + 14);
        }
        let fx = qx - jx;
        let fy = qy - jy;
        fx = fx * fx * (3 - 2 * fx);
        fy = fy * fy * (3 - 2 * fy);
        const top = a + (b - a) * fx;
        return top + (c + (d - c) * fx - top) * fy;
    };
}

// SEA_SWELL_GLSL swellForm: +1 in the trough, -1 on the lit slope, else 0.
function swellForm(rowsIn, period, crestRows, lit, trough, order) {
    const tin = rowsIn - crestRows;
    const turnT = Math.max(Math.min(SWELL_TURN_ROWS, trough * 0.45), 1e-4);
    if (tin >= 0 && tin < trough && (tin >= turnT || order < tin / turnT)
        && (tin < trough * 0.55 || order >= (tin - trough * 0.55) / Math.max(trough * 0.45, 1e-4))) return 1;
    const lin = period - rowsIn;
    const linBody = lin - Math.min(1, lit * 0.25);
    const turnL = Math.max(Math.min(SWELL_TURN_ROWS, lit * 0.45), 1e-4);
    return linBody > 0 && lin < lit && (linBody >= turnL || order < linBody / turnL)
        && (lin < lit * 0.55 || order >= (lin - lit * 0.55) / Math.max(lit * 0.45, 1e-4)) ? -1 : 0;
}

// 3.3 (a) — the resident sea body terms (SEA_SWELL_GLSL swellPhase,
// swellHeight, swellCrest, seaKeyReach, seaBodyStop) on one world texel,
// each noise field on its own cached lattice. `drift` is E2-03's swell drift
// in rows (GpuFrameState.swellDriftRows), as the resident `swellPhase` adds.
function seaField(drift = 0) {
    const warp = latticeNoise();
    const warpFine = latticeNoise();
    const warpMid = latticeNoise();
    const height = latticeNoise();
    const packet = latticeNoise();
    const crestHeight = latticeNoise();
    const crestPacket = latticeNoise();
    const key = latticeNoise();
    const chopWarp = latticeNoise();
    const chopHeight = latticeNoise();
    const normal = SWELL_SET_NORMAL[0];
    const swellHeight = (noise, pktNoise, along, set) => (
        clamp01((noise(along / SWELL_AMP_RUN + 17, set * 7.3) - SWELL_AMP_FLOOR) / SWELL_AMP_SPAN)
        * clamp01((pktNoise(along / SWELL_PACKET_RUN + set * 3.7 + 53, set * 2.9 + 11) - SWELL_PACKET_FLOOR) / SWELL_PACKET_SPAN)
    );
    const field = {
        phase(x, y) {
            return (x * normal + y + drift) / SWELL_SET_PERIOD
                + SWELL_SET_WARP * warp(x / SWELL_WARP_CELL[0] + 3, y / SWELL_WARP_CELL[1] + 11)
                + SWELL_SET_WARP_FINE * warpFine(x / SWELL_WARP_FINE_CELL[0] + 29, y / SWELL_WARP_FINE_CELL[1] + 5)
                + SWELL_SET_WARP_MID * warpMid(x / SWELL_WARP_MID_CELL[0] + 61, y / SWELL_WARP_MID_CELL[1] + 19);
        },
        // 0 none, 1 the underline, 2 the lead row.
        crest(x, y, s) {
            const rowsIn = fract(s) * SWELL_SET_PERIOD;
            if (rowsIn >= SWELL_CREST_ROWS + 2) return 0;
            const set = Math.floor(s);
            const along = x - normal * y;
            const jit = hash12(set, 5);
            const k = Math.floor(along / SWELL_CREST_RUN + jit);
            if (hash12(k + 13, set * 7 + 3) < SWELL_CREST_GAPS) return 0;
            const centre = (k - jit + 0.5) * SWELL_CREST_RUN;
            const halfLen = SWELL_CREST_RUN * 0.5 * (0.55 + 0.45 * hash12(k + 5, set + 1));
            const dx = Math.abs(along - centre);
            if (dx >= halfLen || swellHeight(crestHeight, crestPacket, centre, set) <= SWELL_CREST_HEIGHT) return 0;
            const r = rowsIn - Math.floor(Math.max(0, dx - halfLen + 4) * 0.5);
            return r < 0 ? 0 : (r < 1 ? SWELL_CREST_RISE[0] : (r < SWELL_CREST_ROWS ? SWELL_CREST_RISE[1] : 0));
        },
        keyReach(x, y) {
            const dx = x + 0.5 - SEA_KEY_SHIFT[0];
            const dy = (y + 0.5 - (MAP_SIZE - 1) * TILE_HEIGHT * 0.5 - SEA_KEY_SHIFT[1]) * 2;
            return Math.sqrt(dx * dx + dy * dy) - SEA_KEY_REACH + (key(x / 700 + 5, y / 350 + 9) - 0.5) * 2 * SEA_KEY_WOBBLE;
        },
        body(x, y, s, stop, excess, order) {
            const start = SEA_BODY_ROWS[0] - seaBandBend(x, 7);
            const end = SEA_BODY_ROWS[1] - seaBandBend(x, 8);
            if (clamp01((y - OCEAN_HORIZON_WORLD_Y - start) / (end - start)) <= order) return stop;
            const key = clamp01(0.5 - field.keyReach(x, y) / SEA_KEY_SPAN);
            const calm = clamp01((excess - SWELL_CALM_TILES[0]) / (SWELL_CALM_TILES[1] - SWELL_CALM_TILES[0]));
            const farCalm = clamp01((excess - SWELL_FAR_CALM_TILES[0]) / (SWELL_FAR_CALM_TILES[1] - SWELL_FAR_CALM_TILES[0]));
            const troughCalm = calm * (1 - 0.35 * farCalm);
            const along = x - normal * y;
            const h = swellHeight(height, packet, along, Math.floor(s));
            let form = swellForm(fract(s) * SWELL_SET_PERIOD, SWELL_SET_PERIOD, SWELL_CREST_ROWS,
                (SWELL_LIT_ROWS[0] + (SWELL_LIT_ROWS[1] - SWELL_LIT_ROWS[0]) * key) * h,
                (SWELL_TROUGH_ROWS[0] + (SWELL_TROUGH_ROWS[1] - SWELL_TROUGH_ROWS[0]) * key) * h * troughCalm, order);
            if (form === 0) {
                const c = (x * normal + y) / SWELL_CHOP_PERIOD
                    + SWELL_CHOP_WARP * chopWarp(x / SWELL_CHOP_WARP_CELL[0] + 41, y / SWELL_CHOP_WARP_CELL[1] + 23);
                const ch = clamp01((chopHeight(along / SWELL_CHOP_RUN + 7, Math.floor(c) * 5.1) - SWELL_CHOP_FLOOR) / SWELL_AMP_SPAN) * (1 - 0.30 * farCalm);
                form = swellForm(fract(c) * SWELL_CHOP_PERIOD, SWELL_CHOP_PERIOD, 0,
                    (SWELL_CHOP_LIT_ROWS[0] + (SWELL_CHOP_LIT_ROWS[1] - SWELL_CHOP_LIT_ROWS[0]) * key) * ch,
                    (SWELL_CHOP_TROUGH_ROWS[0] + (SWELL_CHOP_TROUGH_ROWS[1] - SWELL_CHOP_TROUGH_ROWS[0]) * key) * ch * troughCalm, order);
            }
            if (form < 0) {
                const litSteps = order >= farCalm ? SWELL_LIT_STEPS : 1;
                return Math.max(stop - litSteps, Math.min(stop, SWELL_LIT_FLOOR));
            }
            return Math.max(0, Math.min(6, stop + form));
        },
    };
    return field;
}

// The open sea's stop at a world texel (the resident `openSeaStop`).
function seaStopAt(x, y) {
    return y - OCEAN_HORIZON_WORLD_Y >= SEA_FLAT_ROWS ? OPEN_SEA_DEEPEST : openSeaStop(x, y);
}

const posMod = (a, n) => ((a % n) + n) % n;
const chunkId = (cx, cy) => (cx + 32768) * 65536 + (cy + 32768);

function rgbKey(rgb) {
    return (rgb[0] << 16) | (rgb[1] << 8) | rgb[2];
}

function u32Of(rgb01) {
    const r = Math.round(clamp01(rgb01[0]) * 255);
    const g = Math.round(clamp01(rgb01[1]) * 255);
    const b = Math.round(clamp01(rgb01[2]) * 255);
    return ((255 << 24) | (b << 16) | (g << 8) | r) >>> 0;
}

function hexRgb01(hex) {
    const v = parseInt(String(hex).slice(1), 16);
    return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
}

function to01(rgb) {
    return [rgb[0] / 255, rgb[1] / 255, rgb[2] / 255];
}

// World rect under the current transform (camera applied, no rotation).
function visibleWorldRect(ctx) {
    const m = ctx.getTransform?.();
    const width = ctx.canvas?.width || 0;
    const height = ctx.canvas?.height || 0;
    if (!m || !(m.a > 0) || !(m.d > 0) || !width || !height) return null;
    return { x0: -m.e / m.a, x1: (width - m.e) / m.a, y0: -m.f / m.d, y1: (height - m.f) / m.d, texelPx: m.a };
}

function layerCanvas(layer, w, h, clear = true) {
    if (!layer.canvas || layer.canvas.width !== w || layer.canvas.height !== h) {
        layer.canvas ||= document.createElement('canvas');
        layer.canvas.width = w;
        layer.canvas.height = h;
        layer.ctx = layer.canvas.getContext('2d');
        layer.image = new ImageData(w, h);
        layer.u32 = new Uint32Array(layer.image.data.buffer);
        layer.resized = true;
    } else {
        layer.resized = false;
        if (clear) layer.u32.fill(0);
    }
    return layer;
}

// ---------------------------------------------------------------------------
// The terrain base: texel classes and the per-bake lists, once per terrain
// cache and coast-field revision.

export function sunSparkAt(x, y, step) {
    if (posMod(y, 3) !== 1) return false;
    const h = latticeHash12(Math.floor(x / 6) + step * 17, Math.floor(y / 3) + 3);
    const sx = 1 + Math.floor(fract(h * 7.31) * 3), lx = posMod(x, 6);
    return h < SUN_SPARK_SHARE && (lx === sx || (fract(h * 13.7) < 0.35 && lx === sx + 1));
}

function buildBase(renderer) {
    const cache = renderer.terrainCache;
    const bounds = renderer.terrainCacheBounds;
    const fields = renderer._coastBake?.waterFields;
    if (!cache || !bounds || !fields?.cols) return null;
    const started = performance.now();
    const tw = cache.width;
    const th = cache.height;
    const src = cache.getContext('2d').getImageData(0, 0, tw, th).data;
    const bx = Math.round(bounds.x);
    const by = Math.round(bounds.y);
    const n = tw * th;
    const cls = new Uint8Array(n);
    const keys = new Map(COAST_PALETTE.stops.map((rgb, k) => [rgbKey(rgb), k]));
    keys.set(rgbKey(COAST_PALETTE.foam), CLS_FOAM);
    keys.set(rgbKey(COAST_PALETTE.foamCrest), CLS_CREST);
    keys.set(rgbKey(COAST_PALETTE.wetSand), CLS_WET);
    keys.set(rgbKey(COAST_PALETTE.wetSandDark), CLS_WET_DARK);
    GRASS_GUST_STOPS.forEach((pair, k) => keys.set(rgbKey(pair[0]), CLS_GRASS + k));
    for (let i = 0, p = 0; i < n; i++, p += 4) {
        if (src[p + 3] === 0) { cls[i] = CLS_EMPTY; continue; }
        const r = src[p];
        const g = src[p + 1];
        const b = src[p + 2];
        const k = keys.get((r << 16) | (g << 8) | b);
        if (k !== undefined) { cls[i] = k; continue; }
        // The resident swash's beach test: any warm, light ground texel.
        cls[i] = r > b + 30.6 && r >= g && (r * 0.2126 + g * 0.7152 + b * 0.0722) > 114.75 ? CLS_BEACH : CLS_OTHER;
    }
    const { x: fx, y: fy, cols, rows, cycleOffset, coastField } = fields;
    const base = { key: `${renderer.terrainCacheKey}|${fields.revision}`, tw, th, bx, by, cls, fx, fy, cols, rows, cycleOffset, coastField };
    const texelAt = (x, y) => {
        const tx = x - bx;
        const ty = y - by;
        return tx < 0 || ty < 0 || tx >= tw || ty >= th ? -1 : ty * tw + tx;
    };
    base.texelAt = texelAt;

    // 3.1 near-shore and river dashes by their course bucket (offset & 15).
    // BI-1 — `still`: the dash's origin is on still water (a lagoon's
    // shoreward band), whose density the knot wind sets.
    // Iterating `oy` outside `c` builds `threads`, `collars` and `eddies` in
    // strictly ascending texel index (`i = ty * tw + tx`) order for row slicing.
    const nearCells = [];
    const threads = [], collars = [[], [], []], eddies = [[], []];
    const nearBounds = createBounds();
    const threadsBounds = createBounds();
    const collarBounds = createBounds();
    const eddyBounds = createBounds();
    for (let r = 0; r < rows; r++) {
        for (let oy = 0; oy < 2; oy++) {
            const y = fy + 2 * r + oy;
            for (let c = 0; c < cols; c++) {
                const cell = r * cols + c;
                const offset = cycleOffset[cell];
                if (offset >= 16) {
                    if (offset === 255) continue;
                    for (let ox = 0; ox < 2; ox++) {
                        const x = fx + 2 * c + ox, i = texelAt(x, y);
                        if (i < 0) continue;
                        const lane = oy * 2 + ox;
                        if (offset === 113) {
                            for (let f = 0; f < 2; f++) if (coastField[cell * 2] & (1 << (lane + 4 * f))) {
                                eddies[f].push(i);
                                expandBounds(eddyBounds, x, y);
                            }
                        } else if (offset >= 32) {
                            const digit = Math.floor((offset - 32) / 3 ** lane) % 3;
                            if (digit === 1) {
                                collars[0].push(i);
                                if (posMod(x, 4)) collars[1].push(i);
                                collars[2].push(i);
                                expandBounds(collarBounds, x, y);
                            } else if (digit === 2 && posMod(x, 6) < 2) {
                                collars[2].push(i);
                                expandBounds(collarBounds, x, y);
                            }
                        } else if (cls[i] <= 5) {
                            const axis = RIVER_THREAD_AXES[offset - 16];
                            if (!axis) continue;
                            const t = y - Math.floor(axis[0] * x + axis[1]);
                            if (posMod(t, 7) === 3) {
                                threads.push(i, Math.floor(t / 7));
                                expandBounds(threadsBounds, x, y);
                            }
                        }
                    }
                    continue;
                }
                const still = offset < 16 && (coastField[cell * 2 + 1] & STILL_FLAGS) === STILL_FLAGS ? 1 : 0;
                const X = fx + c * 2;
                for (let x = X; x < X + 2; x++) {
                    if (((x % 3) + 3) % 3 !== 0) continue;
                    const cx = x / 3;
                    const h = hash12(cx, y);
                    if (h >= STORM_DASH_DENSITY) continue;
                    nearCells.push([offset & 15, x, y, Math.floor(h * 256), hash12(cx + 17, y + 31) < 0.25 ? 1 : 0, still]);
                    expandBounds(nearBounds, x, y, 3, 1);
                }
            }
        }
    }
    nearCells.sort((a, b) => (a[0] - b[0]) || (a[2] - b[2]) || (a[1] - b[1]));
    const near = {
        start: new Int32Array(17),
        x: new Int16Array(nearCells.length),
        y: new Int16Array(nearCells.length),
        h: new Uint8Array(nearCells.length),
        cap: new Uint8Array(nearCells.length),
        still: new Uint8Array(nearCells.length),
    };
    nearCells.forEach(([bucket, x, y, h, cap, still], i) => {
        near.start[bucket + 1] = i + 1;
        near.x[i] = x;
        near.y[i] = y;
        near.h[i] = h;
        near.cap[i] = cap;
        near.still[i] = still;
    });
    for (let b = 1; b <= 16; b++) near.start[b] = Math.max(near.start[b], near.start[b - 1]);
    base.near = near;
    base.threads = Int32Array.from(threads);
    base.collars = collars.map(list => Uint32Array.from(list));
    base.eddies = eddies.map(list => Uint32Array.from(list));
    base.nearBounds = nearBounds;
    base.threadsBounds = threadsBounds;
    base.collarBounds = collarBounds;
    base.eddyBounds = eddyBounds;

    // 3.10 specks (static, stops 0-1) and the caustic net's eight states on
    // stops 0-1 plus sunlit river and lagoon stop 2 (shade checked per frame).
    // Also record the world-aligned coarse water presence grid for fast rain culling.
    const specks = [];
    const caustic = Array.from({ length: 8 }, () => []);
    const specksBounds = createBounds();
    const causticBounds = createBounds();
    let wx0 = Infinity, wy0 = Infinity, wx1 = -Infinity, wy1 = -Infinity;
    const waterGrid = createCoarseGrid(bx, by, tw, th);
    const wBits = waterGrid.bits;
    const wCols = waterGrid.cols;
    const wGx0 = waterGrid.gx0;
    const wGy0 = waterGrid.gy0;
    for (let ty = 0; ty < th; ty++) {
        const y = by + ty;
        const wRowBit = ((y - wGy0) >> 3) * wCols;
        const tRow = ty * tw;
        const yMod3 = posMod(y, 3) === 1;
        let rowHasWater = false;
        for (let tx = 0; tx < tw; tx++) {
            const i = tRow + tx;
            const k = cls[i];
            if (k > 5) continue;
            const x = bx + tx;
            if (!rowHasWater) {
                rowHasWater = true;
                if (y < wy0) wy0 = y;
                if (y + 1 > wy1) wy1 = y + 1;
            }
            if (x < wx0) wx0 = x;
            if (x + 1 > wx1) wx1 = x + 1;
            const wBit = wRowBit + ((x - wGx0) >> 4);
            wBits[wBit >> 3] |= 1 << (wBit & 7);
            if (k > 2) continue;
            if (k === 2) {
                const c = Math.floor((x - fx) / 2);
                const r = Math.floor((y - fy) / 2);
                if (c < 0 || r < 0 || c >= cols || r >= rows) continue;
                const flags = coastField[(r * cols + c) * 2 + 1];
                if (!(flags & COAST_FIELD_FLAGS.water) || (flags & COAST_FIELD_FLAGS.sea)) continue;
            } else if (hash12(Math.floor(x / 2) + 3, y + 71) < 0.04) {
                specks.push(i);
                expandBounds(specksBounds, x, y);
            }
            if (!yMod3) continue;
            for (let step = 0; step < 8; step++) {
                if (sunSparkAt(x, y, step)) {
                    caustic[step].push(i);
                    expandBounds(causticBounds, x, y);
                }
            }
        }
    }
    base.specks = Uint32Array.from(specks);
    base.caustic = caustic.map(list => Uint32Array.from(list));
    base.specksBounds = specksBounds;
    base.causticBounds = causticBounds;
    base.waterBounds = { x0: wx0, y0: wy0, x1: wx1, y1: wy1 };
    base.waterGrid = waterGrid;

    // 3.6 swash states and 3.7 ripple texels, off the coast field. BI-3: one
    // list per global step of the 12-step wave, each texel at its own band's
    // step of it, and the texels a set's big wave turns at its peak, by the
    // global step of the 48-step set their band meets it (`swashBig`).
    // Built in row-major order (`oy` outside `c`) so every list is sorted by `i`.
    const swash = Array.from({ length: SWASH_WAVE }, () => []);
    const swashBig = Array.from({ length: SWASH_SET }, () => []);
    const ripple = [];
    const swashBounds = createBounds();
    const rippleBounds = createBounds();
    const reflectionAt = (x, y) => {
        const c = Math.floor((x - fx) / 2);
        const r = Math.floor((y - fy) / 2);
        if (c < 0 || r < 0 || c >= cols || r >= rows || texelAt(x, y) < 0) return false;
        return (coastField[(r * cols + c) * 2 + 1] & COAST_FIELD_FLAGS.reflection) !== 0;
    };
    const colourAt = (i) => (src[i * 4] << 16) | (src[i * 4 + 1] << 8) | src[i * 4 + 2];
    for (let r = 0; r < rows; r++) {
        for (let oy = 0; oy < 2; oy++) {
            const y = fy + r * 2 + oy;
            for (let c = 0; c < cols; c++) {
                const cell = (r * cols + c) * 2;
                const flags = coastField[cell + 1];
                if (!(flags & (COAST_FIELD_FLAGS.swash | COAST_FIELD_FLAGS.reflection))) continue;
                const sd = (coastField[cell] - 128) / 64;
                for (let ox = 0; ox < 2; ox++) {
                    const x = fx + c * 2 + ox;
                    const i = texelAt(x, y);
                    if (i < 0) continue;
                    const k = cls[i];
                    if (flags & COAST_FIELD_FLAGS.swash) {
                        const cliff = (flags & COAST_FIELD_FLAGS.cliffSurf) !== 0;
                        const lagoon = (flags & COAST_FIELD_FLAGS.lagoon) !== 0;
                        const band = Math.floor(y / SWASH_PEEL_ROWS);
                        let touched = false;
                        for (let step = 0; step < SWASH_WAVE; step++) {
                            const code = swashCode(k, sd, posMod(step + band, SWASH_WAVE), x, y, cliff, lagoon);
                            if (code) { swash[step].push(i, code); touched = true; }
                        }
                        const peak = lagoon ? 0 : swashCode(k, sd, 3, x, y, cliff, false, true);
                        if (!lagoon && peak !== swashCode(k, sd, 3, x, y, cliff)) {
                            swashBig[posMod(3 - band, SWASH_SET)].push(i, peak);
                            touched = true;
                        }
                        if (touched) expandBounds(swashBounds, x, y);
                    }
                    if (flags & COAST_FIELD_FLAGS.reflection) {
                        const own = colourAt(i);
                        const left = reflectionAt(x - 1, y) ? colourAt(i - 1) : own;
                        const right = reflectionAt(x + 1, y) ? colourAt(i + 1) : own;
                        if (left === own && right === own) continue;
                        ripple.push(i, Math.floor(hash12(y, 7) * 8), left, right);
                        expandBounds(rippleBounds, x, y);
                    }
                }
            }
        }
    }
    base.swash = swash.map(list => Uint32Array.from(list));
    base.swashBig = swashBig.map(list => Uint32Array.from(list));
    base.ripple = Uint32Array.from(ripple);
    base.swashBounds = swashBounds;
    base.rippleBounds = rippleBounds;
    base.still = buildStillPaws(base, fields.mirrorStops);

    // 2.9 — the colour of every column-receiving texel (coast flag `water`,
    // not `covered`) that is no water class (a baked mirror, a dither
    // blend), by ascending texel index, for the column landing, plus a coarse
    // receiver grid to skip dry-land lights and rows before scanning.
    const recvIdx = [];
    const recvRgb = [];
    const recvGrid = createCoarseGrid(bx, by, tw, th);
    const rBits = recvGrid.bits;
    const rCols = recvGrid.cols;
    const rGx0 = recvGrid.gx0;
    const rGy0 = recvGrid.gy0;
    let rx0 = Infinity, ry0 = Infinity, rx1 = -Infinity, ry1 = -Infinity;
    let sx0 = Infinity, sy0 = Infinity, sx1 = -Infinity, sy1 = -Infinity;
    for (let ty = 0; ty < th; ty++) {
        const y = by + ty;
        const r = Math.floor((y - fy) / 2);
        if (r < 0 || r >= rows) continue;
        const tRow = ty * tw;
        const fRow = r * cols;
        const rRowBit = ((y - rGy0) >> 3) * rCols;
        for (let tx = 0; tx < tw; tx++) {
            const i = tRow + tx;
            const k = cls[i];
            if (k === CLS_EMPTY) continue;
            const x = bx + tx;
            const c = Math.floor((x - fx) / 2);
            if (c < 0 || c >= cols) continue;
            const flags = coastField[(fRow + c) * 2 + 1];
            if ((flags & STILL_FLAGS) === STILL_FLAGS) {
                if (x < sx0) sx0 = x;
                if (x + 1 > sx1) sx1 = x + 1;
                if (y < sy0) sy0 = y;
                if (y + 1 > sy1) sy1 = y + 1;
            }
            if (!(flags & COAST_FIELD_FLAGS.water) || (flags & COAST_FIELD_FLAGS.covered)) continue;
            const rBit = rRowBit + ((x - rGx0) >> 4);
            rBits[rBit >> 3] |= 1 << (rBit & 7);
            if (x < rx0) rx0 = x;
            if (x + 1 > rx1) rx1 = x + 1;
            if (y < ry0) ry0 = y;
            if (y + 1 > ry1) ry1 = y + 1;
            if (k <= CLS_CREST) continue;
            recvIdx.push(i);
            recvRgb.push(colourAt(i));
        }
    }
    base.recvIdx = Uint32Array.from(recvIdx);
    base.recvRgb = Uint32Array.from(recvRgb);
    base.recvGrid = recvGrid;
    base.recvBounds = { x0: rx0, y0: ry0, x1: rx1, y1: ry1 };
    base.stillWaterBounds = { x0: sx0, y0: sy0, x1: sx1, y1: sy1 };
    base.buildMs = performance.now() - started;
    return base;
}

// 3.6 applyCoastSwash on one texel of class `k` at its band's wave step
// `cyc`: 0 unchanged, else the class it becomes (CLS_FOAM, CLS_CREST, CLS_WET,
// CLS_WET_DARK) in the low nibble, with SWASH_GLOW on the sea's crest front
// during the in-steps (BI-8; such a code keeps CLS_CREST even over a baked
// crest). E2-05: at the cliff's foot (`cliff`) the front breaks over the
// mirror texels too. QW-4: a lagoon bank laps at half reach; BI-3: a set's
// big wave (`big`) reaches one lattice step further at its peak.
function swashCode(k, sd, cyc, x, y, cliff = false, lagoon = false, big = false) {
    let reach = cyc < 4 ? cyc : (cyc < 7 ? 6 - cyc : 0);
    let extent = cyc < 4 ? cyc : 3;
    if (lagoon) {
        reach *= 0.5;
        extent *= 0.5;
    } else if (big && reach > 2.5) {
        reach += 1;
    }
    if (sd > 0) {
        if (k === CLS_EMPTY || (!cliff && k > 5 && k !== CLS_FOAM && k !== CLS_CREST)) return 0;
        const front = 0.05 + reach * SWASH_STEP_TILES;
        let out = 0;
        if (sd < front - SWASH_STEP_TILES) out = CLS_FOAM;
        else if (sd < front) {
            if (cyc < 4 && !lagoon) return CLS_CREST | SWASH_GLOW;
            out = CLS_CREST;
        } else if (sd < front + 0.06 && waterBayer4(x, y) < 0.5) out = CLS_FOAM;
        return out === k ? 0 : out;
    }
    const darker = cyc < 4.5 ? 2 : (cyc < 6.5 ? 1 : 0);
    if (darker < 0.5 || sd <= -0.02 - extent * SWASH_STEP_TILES) return 0;
    if (k === CLS_WET_DARK) return 0;
    if (k === CLS_WET) return CLS_WET_DARK;
    if (k === CLS_BEACH) return darker > 1.5 ? CLS_WET_DARK : CLS_WET;
    return 0;
}

// BI-1 — still water's cat's paw candidates (the resident `stillPawAt`,
// `mirrorStormColour` and still block of `applyWaterState`): every texel on
// lagoon water a paw can turn, with the gust it must pass (`need`: the C-W3
// paw rule's static ruffle and order, then the stop's deeper share or a
// mirror's Bayer share) and the colour it takes (`colour`: a stop index,
// STILL_CREST for FOAM_CREST). A water stop steps one deeper, or one lighter
// on the static ripple set; a baked mirror gives way to the stop it was
// painted over (that stop's own paw step listed after it, so it wins when
// the gust passes both). Grouped by STILL_BLOCK_W x STILL_BLOCK_H world block
// with the block's lowest need, so a rebuild skips a block the gust field
// cannot reach.
function buildStillPaws(base, mirrorStops) {
    const { bx, by, cls, fx, fy, cols, rows, cycleOffset, coastField, texelAt } = base;
    const stillAt = (x, y) => {
        const c = Math.floor((Math.floor(x / 3) * 3 - fx) / 2);
        const r = Math.floor((y - fy) / 2);
        if (c < 0 || r < 0 || c >= cols || r >= rows) return false;
        const offset = cycleOffset[r * cols + c];
        return (offset < 16 || offset > 31) && (coastField[(r * cols + c) * 2 + 1] & STILL_FLAGS) === STILL_FLAGS;
    };
    const { base: deepBase, gain: deepGain, cap: deepCap } = STILL_PAW_ORDER;
    const list = [];
    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
            const cell = r * cols + c;
            const flags = coastField[cell * 2 + 1];
            if ((flags & STILL_FLAGS) !== STILL_FLAGS) continue;
            const mirror = (flags & COAST_FIELD_FLAGS.reflection) !== 0;
            for (let oy = 0; oy < 2; oy++) {
                for (let ox = 0; ox < 2; ox++) {
                    const x = fx + c * 2 + ox;
                    const y = fy + r * 2 + oy;
                    const i = texelAt(x, y);
                    if (i < 0) continue;
                    const k = cls[i];
                    const stop = mirror && mirrorStops ? ((mirrorStops[cell * 2 + oy] >> (ox ? 4 : 0)) & 15) - 1 : -1;
                    if (k > 5 && stop < 0) continue;
                    const bayer = waterBayer4(x, y);
                    const ruffle = cloudTileSample(fract((x + 517) / 768) * 256, fract((y + 229) / 256) * 256);
                    const pawNeed = Math.max(0, SEA_PAW_THRESHOLD - (ruffle - 0.5) * 0.36 - (bayer - 0.5) * 0.06);
                    const block = Math.floor((y - by) / STILL_BLOCK_H) * 65536 + Math.floor((x - bx) / STILL_BLOCK_W);
                    let need = pawNeed;
                    let shown = k;
                    if (k > 5) {
                        if (bayer >= STILL_MIRROR_BREAK.cap) continue;
                        need = Math.max(pawNeed, (bayer - STILL_MIRROR_BREAK.base) / STILL_MIRROR_BREAK.gain);
                        shown = stop;
                        if (need < 1) list.push([block, i, x, y, need, stop]);
                    }
                    if (!stillAt(x, y)) continue;
                    const order = 0.55 * cloudTileSample(fract((x + 211) / 144) * 256, fract((y + 91) / 48) * 256) + 0.45 * bayer;
                    if (hash12(x + 131, y + 57) < STILL_PAW_RIPPLE && order > 0.5) {
                        if (need < 1) list.push([block, i, x, y, need, shown === 0 ? STILL_CREST : shown - 1]);
                    } else if (order < deepCap) {
                        const deep = Math.max(need, (order - deepBase) / deepGain);
                        if (deep < 1) list.push([block, i, x, y, deep, Math.min(shown + 1, 4)]);
                    }
                }
            }
        }
    }
    list.sort((a, b) => a[0] - b[0]);
    const n = list.length;
    const out = {
        x: new Int16Array(n),
        y: new Int16Array(n),
        need: new Float32Array(n),
        colour: new Uint8Array(n),
        start: [],
        blockX: [],
        blockY: [],
        blockNeed: [],
    };
    let last = null;
    list.forEach(([block, , x, y, need, colour], at) => {
        if (block !== last) {
            last = block;
            out.start.push(at);
            out.blockX.push(bx + (block % 65536) * STILL_BLOCK_W);
            out.blockY.push(by + Math.floor(block / 65536) * STILL_BLOCK_H);
            out.blockNeed.push(need);
        }
        const b = out.blockNeed.length - 1;
        if (need < out.blockNeed[b]) out.blockNeed[b] = need;
        out.x[at] = x;
        out.y[at] = y;
        out.need[at] = need;
        out.colour[at] = colour;
    });
    out.start.push(n);
    out.blocks = out.blockNeed.length;
    return out;
}

// ---------------------------------------------------------------------------
// The deep swell field (3.1 deepSwellLit) per world chunk.

function buildChunk(cx, cy, storm) {
    const wavelength = storm ? 14 : 22;
    // Non-storm chunks are cached under `storm = 0` and never query densities
    // above `DEEP_DASH_DENSITY` (`NEAR_SHORE_DASH_DENSITY <= DEEP_DASH_DENSITY`).
    const maxDensity = storm ? STORM_DASH_DENSITY : Math.max(DEEP_DASH_DENSITY, NEAR_SHORE_DASH_DENSITY);
    const count = new Int32Array(16);
    const cells = CHUNK_CELLS_X * CHUNK_H;
    const bucketOf = new Int8Array(cells).fill(-1);
    const phases = new Int16Array(cells);
    const hashes = new Uint8Array(cells);
    for (let ly = 0; ly < CHUNK_H; ly++) {
        const y = cy * CHUNK_H + ly;
        for (let lc = 0; lc < CHUNK_CELLS_X; lc++) {
            const cellX = cx * CHUNK_CELLS_X + lc;
            const h = hash12(cellX, y);
            if (h >= maxDensity) continue;
            const x = cellX * 3;
            const phase = (x * SWELL_SET_NORMAL[0] + y) / wavelength + 0.35 * Math.sin(x * 0.031) + 0.2 * Math.sin(y * 0.07 + x * 0.013);
            const B = Math.floor(phase * 16);
            const index = ly * CHUNK_CELLS_X + lc;
            const bucket = ((B % 16) + 16) % 16;
            bucketOf[index] = bucket;
            phases[index] = B;
            hashes[index] = Math.floor(h * 256);
            count[bucket]++;
        }
    }
    const start = new Int32Array(17);
    for (let b = 0; b < 16; b++) start[b + 1] = start[b] + count[b];
    const fill = start.slice(0, 16);
    const total = start[16];
    const index = new Uint16Array(total);
    const B = new Int16Array(total);
    const h = new Uint8Array(total);
    for (let i = 0; i < cells; i++) {
        const bucket = bucketOf[i];
        if (bucket < 0) continue;
        const at = fill[bucket]++;
        index[at] = i;
        B[at] = phases[i];
        h[at] = hashes[i];
    }
    return { start, index, B, h };
}

// ---------------------------------------------------------------------------
// 3.3 (a) — the static sea body and swell caps (SEA_SWELL_GLSL `seaBodyStop`
// and `swellCap` with no paw) per world chunk, on the texels that take them:
// the open sea, in-map open water and the sea's shelf (coast flag `sea`, past
// SWELL_SHORE_SD off the beach). `info` holds each texel's shown stop (an
// open texel's body stop, 0..6), flags and static rise, `lit` the texels with
// a rise, `body` the open texels whose body stop differs from the stop the
// terrain or the ocean strip painted; the paw lists hold the cap texels a
// cat's paw can light (open water inside a cluster's ellipse whose cluster
// is off without the paw): the paw's presence must exceed `need`, and the
// texel then rises `rise`.
//
// FP-10 — only the sea texels depend on the swell drift. A chunk with none
// (`driftFree`) carries over unchanged when the drift steps, and a drift
// rebuild (`prev`: the same chunk at the previous drift, on the same base)
// takes the previous chunk's texel classes (`classes`: each texel's sea
// class before the body and crest terms) and grass candidates instead of
// reclassifying them.

function createCapChunkBuilder(base, cx, cy, drift = 0, prev = null) {
    const X0 = cx * CHUNK_W;
    const Y0 = cy * CHUNK_H;
    const known = prev?.classes || null;
    const [cw, ch] = SWELL_CAP_CELL;
    return {
        base, cx, cy, id: chunkId(cx, cy), drift, prev, X0, Y0,
        info: new Uint8Array(CHUNK_W * CHUNK_H).fill(SEA_NONE),
        classes: known || new Uint8Array(CHUNK_W * CHUNK_H).fill(SEA_NONE),
        known,
        body: [],
        seaTexels: 0,
        phase: 0, // 0 = sea rows, 1 = caps, 2 = grass/finalize
        ly: 0,
        capRow: Math.floor(Y0 / ch),
        capRowEnd: Y0 + CHUNK_H,
        capCells: null,
        pawIdx: [],
        pawGust: [],
        pawRise: [],
        minPawGust: Infinity,
        height: createNoise2(),
        packet: createNoise2(),
        crestHeight: createNoise2(),
        crestPacket: createNoise2(),
        chopHeight: createNoise2(),
        elapsedMs: 0,
        resumes: 0,
    };
}

// Cold cap-chunk row slice (`!known`): classifies terrain/open sea, packs
// drift-invariant body/chop/litSteps bits into `classes`, and evaluates drift.
function stepCapColdRows(b, lyStart, lyEnd) {
    const { base, X0, Y0, drift, info, classes, body, height, packet, crestHeight, crestPacket, chopHeight } = b;
    const { cls, fx: fieldX, fy: fieldY, cols, rows, coastField, tw, th, bx, by } = base;
    const normal = SWELL_SET_NORMAL[0];
    const keyBaseY = (MAP_SIZE - 1) * TILE_HEIGHT * 0.5 + SEA_KEY_SHIFT[1];
    const warpW0 = SWELL_WARP_CELL[0], warpH0 = SWELL_WARP_CELL[1];
    const warpFineW0 = SWELL_WARP_FINE_CELL[0], warpFineH0 = SWELL_WARP_FINE_CELL[1];
    const warpMidW0 = SWELL_WARP_MID_CELL[0], warpMidH0 = SWELL_WARP_MID_CELL[1];
    const chopWarpW0 = SWELL_CHOP_WARP_CELL[0], chopWarpH0 = SWELL_CHOP_WARP_CELL[1];
    const litDelta = SWELL_LIT_ROWS[1] - SWELL_LIT_ROWS[0];
    const troughDelta = SWELL_TROUGH_ROWS[1] - SWELL_TROUGH_ROWS[0];
    const chopLitDelta = SWELL_CHOP_LIT_ROWS[1] - SWELL_CHOP_LIT_ROWS[0];
    const chopTroughDelta = SWELL_CHOP_TROUGH_ROWS[1] - SWELL_CHOP_TROUGH_ROWS[0];
    const calmSpan = SWELL_CALM_TILES[1] - SWELL_CALM_TILES[0];
    const farCalmSpan = SWELL_FAR_CALM_TILES[1] - SWELL_FAR_CALM_TILES[0];
    const chunkOutOfTerrainX = X0 + CHUNK_W <= bx || X0 >= bx + tw;

    for (let lx = 0; lx < CHUNK_W; lx++) {
        const x = X0 + lx;
        _chunkBend7[lx] = seaBandBend(x, 7);
        _chunkBend8[lx] = seaBandBend(x, 8);
    }

    for (let ly = lyStart; ly < lyEnd; ly++) {
        const y = Y0 + ly;
        if (y < OCEAN_HORIZON_WORLD_Y) continue;
        const qyW = y / warpH0 + 11, jyW = Math.floor(qyW); let fyW = qyW - jyW; fyW = fyW * fyW * (3 - 2 * fyW);
        const qyF = y / warpFineH0 + 5, jyF = Math.floor(qyF); let fyF = qyF - jyF; fyF = fyF * fyF * (3 - 2 * fyF);
        const qyM = y / warpMidH0 + 19, jyM = Math.floor(qyM); let fyM = qyM - jyM; fyM = fyM * fyM * (3 - 2 * fyM);
        const qyK = y / 350 + 9, jyK = Math.floor(qyK); let fyK = qyK - jyK; fyK = fyK * fyK * (3 - 2 * fyK);
        const qyC = y / chopWarpH0 + 23, jyC = Math.floor(qyC); let fyC = qyC - jyC; fyC = fyC * fyC * (3 - 2 * fyC);

        let ixW = 0x7fffffff, aW = 0, bW = 0, cW = 0, dW = 0;
        let ixF = 0x7fffffff, aF = 0, bF = 0, cF = 0, dF = 0;
        let ixM = 0x7fffffff, aM = 0, bM = 0, cM = 0, dM = 0;
        let ixK = 0x7fffffff, aK = 0, bK = 0, cK = 0, dK = 0;
        let ixC = 0x7fffffff, aC = 0, bC = 0, cC = 0, dC = 0;

        const rowOff = ly * CHUNK_W;
        const ty = y - by;
        const inTerrainY = !chunkOutOfTerrainX && ty >= 0 && ty < th;
        const terrainRow = ty * tw;
        const r = Math.floor((y - fieldY) / 2);
        const inFieldY = r >= 0 && r < rows;
        const yOverTh = (y + 0.5) / TILE_HEIGHT;
        const keyDy = (y + 0.5 - keyBaseY) * 2;
        const keyDy2 = keyDy * keyDy;
        const bayerRow = (y & 3) << 2;
        const relHorizon = y - OCEAN_HORIZON_WORLD_Y;
        const flatOpenSea = relHorizon >= SEA_FLAT_ROWS;
        const normalY = normal * y;

        for (let lx = 0; lx < CHUNK_W; lx++) {
            const idx = rowOff + lx;
            const x = X0 + lx;
            const tx = x - bx;
            const i = inTerrainY && tx >= 0 && tx < tw ? terrainRow + tx : -1;
            const k = i < 0 ? CLS_EMPTY : cls[i];
            let v = SEA_NONE;
            if (k === CLS_EMPTY) {
                v = (flatOpenSea ? OPEN_SEA_DEEPEST : openSeaStop(x, y)) | SEA_OPEN | SEA_OPEN_SEA;
            } else if (k >= 2 && k <= 5) {
                const seaS = flatOpenSea ? OPEN_SEA_DEEPEST : openSeaStop(x, y);
                if (k >= seaS) {
                    v = k | SEA_OPEN;
                } else if (inFieldY) {
                    const c = Math.floor((x - fieldX) / 2);
                    if (c >= 0 && c < cols) {
                        const cell = (r * cols + c) * 2;
                        if ((coastField[cell + 1] & COAST_FIELD_FLAGS.sea) && (coastField[cell] - 128) / 64 > SWELL_SHORE_SD) v = k;
                    }
                }
            }
            if (v === SEA_NONE) {
                classes[idx] = SEA_NONE;
                continue;
            }

            let bodyCode = 0;
            let litTwo = 0;
            let keyVal = 0;
            let tCalm = 0;
            const order = WATER_BAYER4[bayerRow | (x & 3)];

            if (v & SEA_OPEN) {
                const start = SEA_BODY_ROWS[0] - _chunkBend7[lx];
                const end = SEA_BODY_ROWS[1] - _chunkBend8[lx];
                if (clamp01f((relHorizon - start) / (end - start)) > order) {
                    const qxK = x / 700 + 5, jxK = Math.floor(qxK);
                    if (jxK !== ixK) {
                        ixK = jxK;
                        aK = latticeHash12(jxK + 71, jyK + 13); bK = latticeHash12(jxK + 72, jyK + 13);
                        cK = latticeHash12(jxK + 71, jyK + 14); dK = latticeHash12(jxK + 72, jyK + 14);
                    }
                    let fxK = qxK - jxK; fxK = fxK * fxK * (3 - 2 * fxK);
                    const topK = aK + (bK - aK) * fxK;
                    const nK = topK + (cK + (dK - cK) * fxK - topK) * fyK;
                    const dxk = x + 0.5 - SEA_KEY_SHIFT[0];
                    const keyReach = Math.sqrt(dxk * dxk + keyDy2) - SEA_KEY_REACH + (nK - 0.5) * 2 * SEA_KEY_WOBBLE;
                    keyVal = clamp01f(0.5 - keyReach / SEA_KEY_SPAN);

                    const xOverTw = (x + 0.5) / TILE_WIDTH;
                    const u = yOverTh + xOverTw;
                    const vv = yOverTh - xOverTw;
                    const du = u < -0.44 ? u + 0.44 : (u > MAP_LAST ? u - MAP_LAST : 0);
                    const dv = vv < -0.44 ? vv + 0.44 : (vv > MAP_LAST ? vv - MAP_LAST : 0);
                    const excess = du === 0 ? Math.abs(dv) : (dv === 0 ? Math.abs(du) : Math.sqrt(du * du + dv * dv));
                    const calm = clamp01f((excess - SWELL_CALM_TILES[0]) / calmSpan);
                    const farCalm = clamp01f((excess - SWELL_FAR_CALM_TILES[0]) / farCalmSpan);
                    tCalm = calm * (1 - 0.35 * farCalm);
                    litTwo = order >= farCalm ? 1 : 0;

                    const qxC = x / chopWarpW0 + 41, jxC = Math.floor(qxC);
                    if (jxC !== ixC) {
                        ixC = jxC;
                        aC = latticeHash12(jxC + 71, jyC + 13); bC = latticeHash12(jxC + 72, jyC + 13);
                        cC = latticeHash12(jxC + 71, jyC + 14); dC = latticeHash12(jxC + 72, jyC + 14);
                    }
                    let fxC = qxC - jxC; fxC = fxC * fxC * (3 - 2 * fxC);
                    const topC = aC + (bC - aC) * fxC;
                    const nC = topC + (cC + (dC - cC) * fxC - topC) * fyC;
                    const c = (x * normal + y) / SWELL_CHOP_PERIOD + SWELL_CHOP_WARP * nC;
                    const cFloor = Math.floor(c);
                    const cRowsIn = (c - cFloor) * SWELL_CHOP_PERIOD;
                    let chopForm = 0;
                    if (cRowsIn < MAX_CHOP_TROUGH || SWELL_CHOP_PERIOD - cRowsIn < MAX_CHOP_LIT) {
                        const along = x - normalY;
                        const ch = clamp01f((sampleNoise2(chopHeight, along / SWELL_CHOP_RUN + 7, cFloor * 5.1) - SWELL_CHOP_FLOOR) / SWELL_AMP_SPAN) * (1 - 0.30 * farCalm);
                        chopForm = swellForm(cRowsIn, SWELL_CHOP_PERIOD, 0,
                            (SWELL_CHOP_LIT_ROWS[0] + chopLitDelta * keyVal) * ch,
                            (SWELL_CHOP_TROUGH_ROWS[0] + chopTroughDelta * keyVal) * ch * tCalm, order);
                    }
                    bodyCode = chopForm === 0 ? 1 : (chopForm > 0 ? 2 : 3);
                }
            }
            classes[idx] = v | (bodyCode << CLS_BODY_SHIFT) | (litTwo ? CLS_LIT_TWO : 0);

            b.seaTexels++;
            const qxW = x / warpW0 + 3, jxW = Math.floor(qxW);
            if (jxW !== ixW) {
                ixW = jxW;
                aW = latticeHash12(jxW + 71, jyW + 13); bW = latticeHash12(jxW + 72, jyW + 13);
                cW = latticeHash12(jxW + 71, jyW + 14); dW = latticeHash12(jxW + 72, jyW + 14);
            }
            let fxW = qxW - jxW; fxW = fxW * fxW * (3 - 2 * fxW);
            const topW = aW + (bW - aW) * fxW;
            const nW = topW + (cW + (dW - cW) * fxW - topW) * fyW;

            const qxF = x / warpFineW0 + 29, jxF = Math.floor(qxF);
            if (jxF !== ixF) {
                ixF = jxF;
                aF = latticeHash12(jxF + 71, jyF + 13); bF = latticeHash12(jxF + 72, jyF + 13);
                cF = latticeHash12(jxF + 71, jyF + 14); dF = latticeHash12(jxF + 72, jyF + 14);
            }
            let fxF = qxF - jxF; fxF = fxF * fxF * (3 - 2 * fxF);
            const topF = aF + (bF - aF) * fxF;
            const nF = topF + (cF + (dF - cF) * fxF - topF) * fyF;

            const qxM = x / warpMidW0 + 61, jxM = Math.floor(qxM);
            if (jxM !== ixM) {
                ixM = jxM;
                aM = latticeHash12(jxM + 71, jyM + 13); bM = latticeHash12(jxM + 72, jyM + 13);
                cM = latticeHash12(jxM + 71, jyM + 14); dM = latticeHash12(jxM + 72, jyM + 14);
            }
            let fxM = qxM - jxM; fxM = fxM * fxM * (3 - 2 * fxM);
            const topM = aM + (bM - aM) * fxM;
            const nM = topM + (cM + (dM - cM) * fxM - topM) * fyM;

            const s = (x * normal + y + drift) / SWELL_SET_PERIOD
                + SWELL_SET_WARP * nW
                + SWELL_SET_WARP_FINE * nF
                + SWELL_SET_WARP_MID * nM;
            const sFloor = Math.floor(s);
            const rowsIn = (s - sFloor) * SWELL_SET_PERIOD;

            if (bodyCode !== 0) {
                const painted = v & 7;
                let form = 0;
                const inTroughBand = rowsIn >= SWELL_CREST_ROWS && (rowsIn - SWELL_CREST_ROWS) < MAX_SWELL_TROUGH;
                const inLitBand = (SWELL_SET_PERIOD - rowsIn) < MAX_SWELL_LIT;
                if (inTroughBand || inLitBand) {
                    const along = x - normalY;
                    const h = clamp01f((sampleNoise2(height, along / SWELL_AMP_RUN + 17, sFloor * 7.3) - SWELL_AMP_FLOOR) / SWELL_AMP_SPAN)
                        * clamp01f((sampleNoise2(packet, along / SWELL_PACKET_RUN + sFloor * 3.7 + 53, sFloor * 2.9 + 11) - SWELL_PACKET_FLOOR) / SWELL_PACKET_SPAN);
                    form = swellForm(rowsIn, SWELL_SET_PERIOD, SWELL_CREST_ROWS,
                        (SWELL_LIT_ROWS[0] + litDelta * keyVal) * h,
                        inTroughBand ? (SWELL_TROUGH_ROWS[0] + troughDelta * keyVal) * h * tCalm : 0, order);
                }
                if (form === 0 && bodyCode !== 1) form = bodyCode === 2 ? 1 : -1;
                let shown;
                if (form < 0) {
                    const litSteps = litTwo ? SWELL_LIT_STEPS : 1;
                    shown = Math.max(painted - litSteps, Math.min(painted, SWELL_LIT_FLOOR));
                } else {
                    shown = Math.max(0, Math.min(6, painted + form));
                }
                if (shown !== painted) {
                    v = (v & ~7) | shown;
                    body.push(idx);
                }
            }

            if (rowsIn < SWELL_CREST_ROWS + 2) {
                const along = x - normalY;
                const jit = hash12(sFloor, 5);
                const ck = Math.floor(along / SWELL_CREST_RUN + jit);
                if (hash12(ck + 13, sFloor * 7 + 3) >= SWELL_CREST_GAPS) {
                    const centre = (ck - jit + 0.5) * SWELL_CREST_RUN;
                    const halfLen = SWELL_CREST_RUN * 0.5 * (0.55 + 0.45 * hash12(ck + 5, sFloor + 1));
                    const dx = Math.abs(along - centre);
                    if (dx < halfLen) {
                        const ch = clamp01f((sampleNoise2(crestHeight, centre / SWELL_AMP_RUN + 17, sFloor * 7.3) - SWELL_AMP_FLOOR) / SWELL_AMP_SPAN)
                            * clamp01f((sampleNoise2(crestPacket, centre / SWELL_PACKET_RUN + sFloor * 3.7 + 53, sFloor * 2.9 + 11) - SWELL_PACKET_FLOOR) / SWELL_PACKET_SPAN);
                        if (ch > SWELL_CREST_HEIGHT) {
                            const cr = rowsIn - Math.floor(Math.max(0, dx - halfLen + 4) * 0.5);
                            const crest = cr < 0 ? 0 : (cr < 1 ? SWELL_CREST_RISE[0] : (cr < SWELL_CREST_ROWS ? SWELL_CREST_RISE[1] : 0));
                            if (crest) v |= SEA_CREST_LINE | (crest << SEA_RISE_SHIFT);
                        }
                    }
                }
            }
            info[idx] = v;
        }
    }
}

// Drift cap-chunk row slice (`known !== null`): reuses drift-invariant terrain
// class, chop form, body mask and lit-steps bits from `known` (0 extra bytes),
// and hoists separable bilinear warp/key bands across rows (0 ULP change).
function stepCapDriftRows(b, lyStart, lyEnd) {
    const { X0, Y0, drift, info, known, body, height, packet, crestHeight, crestPacket } = b;
    const normal = SWELL_SET_NORMAL[0];
    const keyBaseY = (MAP_SIZE - 1) * TILE_HEIGHT * 0.5 + SEA_KEY_SHIFT[1];
    const warpH0 = SWELL_WARP_CELL[1];
    const warpFineH0 = SWELL_WARP_FINE_CELL[1];
    const warpMidH0 = SWELL_WARP_MID_CELL[1];
    const litBase = SWELL_LIT_ROWS[0];
    const litDelta = SWELL_LIT_ROWS[1] - litBase;
    const troughBase = SWELL_TROUGH_ROWS[0];
    const troughDelta = SWELL_TROUGH_ROWS[1] - troughBase;
    const calmSpan = SWELL_CALM_TILES[1] - SWELL_CALM_TILES[0];
    const farCalmSpan = SWELL_FAR_CALM_TILES[1] - SWELL_FAR_CALM_TILES[0];

    prepareWarpColumns(X0);

    // O(1) chunk-level bounds for `tCalm === 0.65` and `keyVal === 0` (exact IEEE-754).
    const cXMax = X0 + CHUNK_W - 1;
    const cYMax = Y0 + CHUNK_H - 1;
    const cKeyDy0 = (Y0 + 0.5 - keyBaseY) * 2;
    const cKeyDy1 = (cYMax + 0.5 - keyBaseY) * 2;
    const minKeyDy = (cKeyDy0 <= 0 && cKeyDy1 >= 0) ? 0 : Math.min(Math.abs(cKeyDy0), Math.abs(cKeyDy1));
    const cDx0 = X0 + 0.5 - SEA_KEY_SHIFT[0];
    const cDx1 = cXMax + 0.5 - SEA_KEY_SHIFT[0];
    const minKeyDx = (cDx0 <= 0 && cDx1 >= 0) ? 0 : Math.min(Math.abs(cDx0), Math.abs(cDx1));
    const chunkKeyZero = (minKeyDx * minKeyDx + minKeyDy * minKeyDy) >= KEY_ZERO_SQ;

    const uMin = (Y0 + 0.5) / TILE_HEIGHT + (X0 + 0.5) / TILE_WIDTH;
    const uMax = (cYMax + 0.5) / TILE_HEIGHT + (cXMax + 0.5) / TILE_WIDTH;
    const vMin = (Y0 + 0.5) / TILE_HEIGHT - (cXMax + 0.5) / TILE_WIDTH;
    const vMax = (cYMax + 0.5) / TILE_HEIGHT - (X0 + 0.5) / TILE_WIDTH;
    const minDu = uMax < -0.44 ? (-0.44 - uMax) : (uMin > MAP_LAST ? (uMin - MAP_LAST) : 0);
    const minDv = vMax < -0.44 ? (-0.44 - vMax) : (vMin > MAP_LAST ? (vMin - MAP_LAST) : 0);
    const chunkFarCalm = (minDu * minDu + minDv * minDv) >= FAR_CALM_ONE_SQ + 1e-9;

    // Register-local 2-slot fast caches for height/packet noise (avoids `sampleNoise2`
    // call overhead when `sFloor` alternates between 2 adjacent integers across rows).
    let hIx0 = height.ix0, hIy0 = height.iy0, hA0 = height.a0, hB0 = height.b0, hC0 = height.c0, hD0 = height.d0;
    let hIx1 = height.ix1, hIy1 = height.iy1, hA1 = height.a1, hB1 = height.b1, hC1 = height.c1, hD1 = height.d1;
    let pIx0 = packet.ix0, pIy0 = packet.iy0, pA0 = packet.a0, pB0 = packet.b0, pC0 = packet.c0, pD0 = packet.d0;
    let pIx1 = packet.ix1, pIy1 = packet.iy1, pA1 = packet.a1, pB1 = packet.b1, pC1 = packet.c1, pD1 = packet.d1;
    // Register-local caches for sFloor-invariant vertical noise weights & crest runs (bit-identical).
    let bSFloor = 0x7fffffff, bJyH = 0, bFyH = 0, bJyP = 0, bFyP = 0, bPShift = 0;
    let cSFloor = 0x7fffffff, cJit = 0, cCk = 0x7fffffff, cPass = false, cCentre = 0, cHalfLen = 0, cHeightOk = false;

    for (let ly = lyStart; ly < lyEnd; ly++) {
        const y = Y0 + ly;
        if (y < OCEAN_HORIZON_WORLD_Y) continue;
        const qyW = y / warpH0 + 11, jyW = Math.floor(qyW); let fyW = qyW - jyW; fyW = fyW * fyW * (3 - 2 * fyW);
        const qyF = y / warpFineH0 + 5, jyF = Math.floor(qyF); let fyF = qyF - jyF; fyF = fyF * fyF * (3 - 2 * fyF);
        const qyM = y / warpMidH0 + 19, jyM = Math.floor(qyM); let fyM = qyM - jyM; fyM = fyM * fyM * (3 - 2 * fyM);
        const qyK = chunkKeyZero ? 0 : y / 350 + 9;
        const jyK = chunkKeyZero ? 0 : Math.floor(qyK);
        let fyK = chunkKeyZero ? 0 : qyK - jyK;
        if (!chunkKeyZero) fyK = fyK * fyK * (3 - 2 * fyK);

        if (jyW !== _warpJyW) { _warpJyW = jyW; fillWarpBand(_jxW, _fxW, _topW, _diffW, jyW); }
        if (jyF !== _warpJyF) { _warpJyF = jyF; fillWarpBand(_jxF, _fxF, _topF, _diffF, jyF); }
        if (jyM !== _warpJyM) { _warpJyM = jyM; fillWarpBand(_jxM, _fxM, _topM, _diffM, jyM); }

        const rowOff = ly * CHUNK_W;
        const yOverTh = (y + 0.5) / TILE_HEIGHT;
        const keyDy = (y + 0.5 - keyBaseY) * 2;
        const keyDy2 = keyDy * keyDy;
        const bayerRow = (y & 3) << 2;
        const normalY = normal * y;
        const yPlusDrift = y + drift;

        for (let lx = 0; lx < CHUNK_W; lx++) {
            const idx = rowOff + lx;
            const cByte = known[idx];
            let v = cByte & CLS_RAW_MASK;
            if (v === SEA_NONE) continue;

            b.seaTexels++;
            const s = (_xNormal[lx] + yPlusDrift) / SWELL_SET_PERIOD
                + SWELL_SET_WARP * (_topW[lx] + _diffW[lx] * fyW)
                + SWELL_SET_WARP_FINE * (_topF[lx] + _diffF[lx] * fyF)
                + SWELL_SET_WARP_MID * (_topM[lx] + _diffM[lx] * fyM);
            const sFloor = Math.floor(s);
            const rowsIn = (s - sFloor) * SWELL_SET_PERIOD;

            const bodyCode = (cByte >> CLS_BODY_SHIFT) & 3;
            if (bodyCode !== 0) {
                const painted = v & 7;
                let form = 0;
                const tin = rowsIn - SWELL_CREST_ROWS;
                const inTroughBand = tin >= 0 && tin < MAX_SWELL_TROUGH;
                const lin = SWELL_SET_PERIOD - rowsIn;
                const inLitBand = !inTroughBand && lin < MAX_SWELL_LIT;
                if (inTroughBand || inLitBand) {
                    if (sFloor !== bSFloor) {
                        bSFloor = sFloor;
                        const qyH = sFloor * 7.3;
                        bJyH = Math.floor(qyH);
                        const tH = qyH - bJyH;
                        bFyH = tH * tH * (3 - 2 * tH);
                        const qyP = sFloor * 2.9 + 11;
                        bJyP = Math.floor(qyP);
                        const tP = qyP - bJyP;
                        bFyP = tP * tP * (3 - 2 * tP);
                        bPShift = sFloor * 3.7 + 53;
                    }
                    const along = (X0 + lx) - normalY;
                    const qxH = along / SWELL_AMP_RUN + 17;
                    const jxH = Math.floor(qxH);
                    let nh;
                    if (jxH === hIx0 && bJyH === hIy0) {
                        let fx = qxH - jxH; fx = fx * fx * (3 - 2 * fx);
                        const top = hA0 + (hB0 - hA0) * fx;
                        nh = top + (hC0 + (hD0 - hC0) * fx - top) * bFyH;
                    } else if (jxH === hIx1 && bJyH === hIy1) {
                        let fx = qxH - jxH; fx = fx * fx * (3 - 2 * fx);
                        const top = hA1 + (hB1 - hA1) * fx;
                        nh = top + (hC1 + (hD1 - hC1) * fx - top) * bFyH;
                    } else {
                        nh = sampleNoise2(height, qxH, sFloor * 7.3);
                        hIx0 = height.ix0; hIy0 = height.iy0; hA0 = height.a0; hB0 = height.b0; hC0 = height.c0; hD0 = height.d0;
                        hIx1 = height.ix1; hIy1 = height.iy1; hA1 = height.a1; hB1 = height.b1; hC1 = height.c1; hD1 = height.d1;
                    }
                    const h1 = clamp01f((nh - SWELL_AMP_FLOOR) / SWELL_AMP_SPAN);
                    if (h1 > 0) {
                        const qxP = along / SWELL_PACKET_RUN + bPShift;
                        const jxP = Math.floor(qxP);
                        let np;
                        if (jxP === pIx0 && bJyP === pIy0) {
                            let fx = qxP - jxP; fx = fx * fx * (3 - 2 * fx);
                            const top = pA0 + (pB0 - pA0) * fx;
                            np = top + (pC0 + (pD0 - pC0) * fx - top) * bFyP;
                        } else if (jxP === pIx1 && bJyP === pIy1) {
                            let fx = qxP - jxP; fx = fx * fx * (3 - 2 * fx);
                            const top = pA1 + (pB1 - pA1) * fx;
                            np = top + (pC1 + (pD1 - pC1) * fx - top) * bFyP;
                        } else {
                            np = sampleNoise2(packet, qxP, sFloor * 2.9 + 11);
                            pIx0 = packet.ix0; pIy0 = packet.iy0; pA0 = packet.a0; pB0 = packet.b0; pC0 = packet.c0; pD0 = packet.d0;
                            pIx1 = packet.ix1; pIy1 = packet.iy1; pA1 = packet.a1; pB1 = packet.b1; pC1 = packet.c1; pD1 = packet.d1;
                        }
                        const h = h1 * clamp01f((np - SWELL_PACKET_FLOOR) / SWELL_PACKET_SPAN);
                        if (h > 0) {
                            if (inTroughBand) {
                                if (tin < MAX_SWELL_TROUGH * h) {
                                    let tCalm;
                                    if (chunkFarCalm) {
                                        tCalm = 0.65;
                                    } else {
                                        const xOverTw = _xOverTw[lx];
                                        const u = yOverTh + xOverTw;
                                        const vv = yOverTh - xOverTw;
                                        const du = u < -0.44 ? u + 0.44 : (u > MAP_LAST ? u - MAP_LAST : 0);
                                        const dv = vv < -0.44 ? vv + 0.44 : (vv > MAP_LAST ? vv - MAP_LAST : 0);
                                        if (du === 0 && dv === 0) {
                                            tCalm = 0;
                                        } else {
                                            const eSq = du * du + dv * dv;
                                            if (eSq <= CALM_ZERO_SQ - 1e-9) {
                                                tCalm = 0;
                                            } else if (eSq >= FAR_CALM_ONE_SQ + 1e-9) {
                                                tCalm = 0.65;
                                            } else {
                                                const excess = du === 0 ? Math.abs(dv) : (dv === 0 ? Math.abs(du) : Math.sqrt(eSq));
                                                const calm = clamp01f((excess - SWELL_CALM_TILES[0]) / calmSpan);
                                                const farCalm = clamp01f((excess - SWELL_FAR_CALM_TILES[0]) / farCalmSpan);
                                                tCalm = calm * (1 - 0.35 * farCalm);
                                            }
                                        }
                                    }
                                    if (tCalm > 0 && tin < MAX_SWELL_TROUGH * h * tCalm) {
                                        let keyVal;
                                        if (chunkKeyZero) {
                                            keyVal = 0;
                                        } else {
                                            const rSq = _dxkSq[lx] + keyDy2;
                                            if (rSq >= KEY_ZERO_SQ) {
                                                keyVal = 0;
                                            } else if (rSq <= KEY_ONE_SQ) {
                                                keyVal = 1;
                                            } else {
                                                if (jyK !== _warpJyK) { _warpJyK = jyK; fillWarpBand(_jxK, _fxK, _topK, _diffK, jyK); }
                                                const nK = _topK[lx] + _diffK[lx] * fyK;
                                                keyVal = clamp01f(0.5 - (Math.sqrt(rSq) - SEA_KEY_REACH + (nK - 0.5) * 2 * SEA_KEY_WOBBLE) / SEA_KEY_SPAN);
                                            }
                                        }
                                        const trough = (troughBase + troughDelta * keyVal) * h * tCalm;
                                        if (tin < trough) {
                                            const order = WATER_BAYER4[bayerRow | ((X0 + lx) & 3)];
                                            const turnT = Math.max(Math.min(SWELL_TURN_ROWS, trough * 0.45), 1e-4);
                                            if ((tin >= turnT || order < tin / turnT)
                                                && (tin < trough * 0.55 || order >= (tin - trough * 0.55) / Math.max(trough * 0.45, 1e-4))) {
                                                form = 1;
                                            }
                                        }
                                    }
                                }
                            } else if (lin < MAX_SWELL_LIT * h) {
                                let keyVal;
                                if (chunkKeyZero) {
                                    keyVal = 0;
                                } else {
                                    const rSq = _dxkSq[lx] + keyDy2;
                                    if (rSq >= KEY_ZERO_SQ) {
                                        keyVal = 0;
                                    } else if (rSq <= KEY_ONE_SQ) {
                                        keyVal = 1;
                                    } else {
                                        if (jyK !== _warpJyK) { _warpJyK = jyK; fillWarpBand(_jxK, _fxK, _topK, _diffK, jyK); }
                                        const nK = _topK[lx] + _diffK[lx] * fyK;
                                        keyVal = clamp01f(0.5 - (Math.sqrt(rSq) - SEA_KEY_REACH + (nK - 0.5) * 2 * SEA_KEY_WOBBLE) / SEA_KEY_SPAN);
                                    }
                                }
                                const lit = (litBase + litDelta * keyVal) * h;
                                const linBody = lin - Math.min(1, lit * 0.25);
                                if (linBody > 0 && lin < lit) {
                                    const order = WATER_BAYER4[bayerRow | ((X0 + lx) & 3)];
                                    const turnL = Math.max(Math.min(SWELL_TURN_ROWS, lit * 0.45), 1e-4);
                                    if ((linBody >= turnL || order < linBody / turnL)
                                        && (lin < lit * 0.55 || order >= (lin - lit * 0.55) / Math.max(lit * 0.45, 1e-4))) {
                                        form = -1;
                                    }
                                }
                            }
                        }
                    }
                }
                if (form === 0 && bodyCode !== 1) form = bodyCode === 2 ? 1 : -1;
                let shown;
                if (form < 0) {
                    const litSteps = (cByte & CLS_LIT_TWO) !== 0 ? SWELL_LIT_STEPS : 1;
                    shown = Math.max(painted - litSteps, Math.min(painted, SWELL_LIT_FLOOR));
                } else {
                    shown = Math.max(0, Math.min(6, painted + form));
                }
                if (shown !== painted) {
                    v = (v & ~7) | shown;
                    body.push(idx);
                }
            }

            if (rowsIn < SWELL_CREST_ROWS + 2) {
                const along = (X0 + lx) - normalY;
                if (sFloor !== cSFloor) {
                    cSFloor = sFloor;
                    cJit = hash12(sFloor, 5);
                    cCk = 0x7fffffff;
                }
                const ck = Math.floor(along / SWELL_CREST_RUN + cJit);
                if (ck !== cCk) {
                    cCk = ck;
                    cPass = hash12(ck + 13, sFloor * 7 + 3) >= SWELL_CREST_GAPS;
                    if (cPass) {
                        cCentre = (ck - cJit + 0.5) * SWELL_CREST_RUN;
                        cHalfLen = SWELL_CREST_RUN * 0.5 * (0.55 + 0.45 * hash12(ck + 5, sFloor + 1));
                        const ch = clamp01f((sampleNoise2(crestHeight, cCentre / SWELL_AMP_RUN + 17, sFloor * 7.3) - SWELL_AMP_FLOOR) / SWELL_AMP_SPAN)
                            * clamp01f((sampleNoise2(crestPacket, cCentre / SWELL_PACKET_RUN + sFloor * 3.7 + 53, sFloor * 2.9 + 11) - SWELL_PACKET_FLOOR) / SWELL_PACKET_SPAN);
                        cHeightOk = ch > SWELL_CREST_HEIGHT;
                    } else {
                        cHeightOk = false;
                    }
                }
                if (cHeightOk) {
                    const dx = Math.abs(along - cCentre);
                    if (dx < cHalfLen) {
                        const cr = rowsIn - Math.floor(Math.max(0, dx - cHalfLen + 4) * 0.5);
                        const crest = cr < 0 ? 0 : (cr < 1 ? SWELL_CREST_RISE[0] : (cr < SWELL_CREST_ROWS ? SWELL_CREST_RISE[1] : 0));
                        if (crest) v |= SEA_CREST_LINE | (crest << SEA_RISE_SHIFT);
                    }
                }
            }
            info[idx] = v;
        }
    }
}

function stepCapCells(b, started, budgetMs) {
    const { X0, Y0, info, pawIdx, pawGust, pawRise } = b;
    const cells = b.capCells;
    const [cw, ch] = SWELL_CAP_CELL;
    const [kw, kh] = SWELL_CLUSTER_CELL;
    let row = b.capRow;
    let steps = 0;
    for (; row * ch < b.capRowEnd; row++) {
        const shift = posMod(row, 2) * cw * 0.5;
        const kx1 = Math.floor((X0 + CHUNK_W + shift) / cw) + 1;
        for (let kx = Math.floor((X0 + shift) / cw) - 1; kx <= kx1; kx++) {
            const hp = latticeHash12(kx + 211, row + 17);
            if (hp >= SWELL_CLUSTER_CAPS) continue;
            const centreX = kx * cw + cw * 0.5 - shift;
            const centreY = (row + 0.5) * ch;
            const inSet = fract(cells.phase(centreX, centreY) + SWELL_SET_LEAD) < SWELL_SET_SHARE_OPEN;
            const crow = Math.floor(centreY / kh);
            const clusterX = centreX + posMod(crow, 2) * kw * 0.5;
            const ckx = Math.floor(clusterX / kw);
            const hc = latticeHash12(ckx + 101, crow + 7);
            const ex = (clusterX - (ckx + 0.35 + 0.3 * latticeHash12(ckx + 103, crow + 9)) * kw) / (kw * 0.5);
            const ey = (centreY - (crow + 0.35 + 0.3 * latticeHash12(ckx + 107, crow + 3)) * kh) / (kh * 0.5);
            const inEllipse = ex * ex + ey * ey < 1;
            const len = 3 + Math.floor(latticeHash12(kx + 223, row + 5) * 5);
            const x0 = Math.floor(latticeHash12(kx + 227, row + 41) * (cw - len));
            const y0 = Math.floor(latticeHash12(kx + 229, row + 83) * (ch - 1));
            for (let trail = 0; trail < 2; trail++) {
                const ly = row * ch + y0 + trail - Y0;
                if (ly < 0 || ly >= CHUNK_H) continue;
                const y = Y0 + ly;
                const end = trail ? x0 + len - 1 : x0 + len;
                for (let at = trail ? x0 + 1 : x0; at < end; at++) {
                    const x = kx * cw + at - shift;
                    const lx = x - X0;
                    if (lx < 0 || lx >= CHUNK_W) continue;
                    const idx = ly * CHUNK_W + lx;
                    const v = info[idx];
                    if ((v & 7) === SEA_NONE || (v & SEA_CREST_LINE)) continue;
                    const near = seaNearAt(x, y);
                    const clusters = (0.10 + 0.35 * near) * (inSet ? SWELL_SET_GAIN : SWELL_GAP_GAIN + (1 - SWELL_GAP_GAIN) * near * near);
                    const inCluster = inEllipse && hc < clusters;
                    const presence = inCluster ? SWELL_CLUSTER_CAPS : SWELL_LONE_CAPS[0] + (SWELL_LONE_CAPS[1] - SWELL_LONE_CAPS[0]) * near;
                    const clusterRise = trail ? 1 : 2;
                    let rise = 0;
                    if (hp < presence) rise = trail || !(inCluster || near > 0.8) ? 1 : 2;
                    if (rise) info[idx] = (v & ~(3 << SEA_RISE_SHIFT)) | (rise << SEA_RISE_SHIFT);
                    if ((v & SEA_OPEN) && inEllipse && !inCluster && rise < clusterRise) {
                        const ruffle = cloudTileSample(fract((x + 517) / 768) * 256, fract((y + 229) / 256) * 256);
                        const bias = (ruffle - 0.5) * 0.36 + (WATER_BAYER4[((y & 3) << 2) | (x & 3)] - 0.5) * 0.06;
                        const gust = Math.max(0, SEA_PAW_THRESHOLD - bias, (hc - clusters - SEA_PAW_CAP_BASE) / SEA_PAW_CAP_GAIN);
                        if (gust < 1) {
                            pawIdx.push(idx);
                            pawGust.push(gust);
                            pawRise.push(clusterRise);
                            if (gust < b.minPawGust) b.minPawGust = gust;
                        }
                    }
                }
            }
        }
        if (++steps >= 8 && (row + 1) * ch < b.capRowEnd && performance.now() - started >= budgetMs) {
            b.capRow = row + 1;
            return false;
        }
    }
    return true;
}

function finalizeCapChunk(b) {
    const { base, X0, Y0, prev, info, classes, body } = b;
    const { cls, tw, th, bx, by } = base;
    const lit = [];
    if (b.seaTexels > 0) {
        for (let idx = 0; idx < info.length; idx++) {
            if ((info[idx] >> SEA_RISE_SHIFT) & 3) lit.push(idx);
        }
    }
    let grassIdx, grassNeed, grassK, minGrassNeed;
    if (prev) {
        grassIdx = prev.grassIdx;
        grassNeed = prev.grassNeed;
        grassK = prev.grassK;
        minGrassNeed = prev.minGrassNeed;
    } else {
        const gIdx = [];
        const gNeed = [];
        const gK = [];
        minGrassNeed = Infinity;
        if (X0 + CHUNK_W > bx && X0 < bx + tw && Y0 + CHUNK_H > by && Y0 < by + th) {
            for (let ly = 0; ly < CHUNK_H; ly++) {
                const y = Y0 + ly;
                const ty = y - by;
                if (ty < 0 || ty >= th) continue;
                const tRow = ty * tw;
                let lastTx = 0x7fffffff;
                let need = -1;
                const lx0 = Math.max(0, bx - X0);
                const lx1 = Math.min(CHUNK_W, bx + tw - X0);
                for (let lx = lx0; lx < lx1; lx++) {
                    const k = cls[tRow + (X0 + lx - bx)] - CLS_GRASS;
                    if (k < 0 || k >= GRASS_GUST_STOPS.length) continue;
                    const tx = Math.floor((X0 + lx) / 2);
                    if (tx !== lastTx) {
                        lastTx = tx;
                        const ruffle = cloudTileSample(fract((tx + 311) / 384) * 256, fract((y + 173) / 256) * 256);
                        const order = ruffle * 0.5 + WATER_BAYER4[((y & 3) << 2) | (tx & 3)] * 0.5;
                        need = order >= GRASS_GUST_ORDER_CAP ? -1 : Math.max(0, (order - GRASS_GUST_ORDER_BASE) / GRASS_GUST_ORDER_GAIN);
                    }
                    if (need < 0) continue;
                    gIdx.push(ly * CHUNK_W + lx);
                    gNeed.push(need);
                    gK.push(k);
                    if (need < minGrassNeed) minGrassNeed = need;
                }
            }
        }
        grassIdx = gIdx.length ? new Int32Array(gIdx) : EMPTY_I32;
        grassNeed = new Float32Array(gNeed);
        grassK = new Uint8Array(gK);
    }
    return {
        info,
        lit: lit.length ? new Int32Array(lit) : EMPTY_I32,
        body: body.length ? new Int32Array(body) : EMPTY_I32,
        pawIdx: b.pawIdx.length ? new Int32Array(b.pawIdx) : EMPTY_I32,
        pawGust: new Float32Array(b.pawGust),
        pawRise: new Uint8Array(b.pawRise),
        minPawGust: b.minPawGust,
        pawKey: '',
        pawLit: EMPTY_I32,
        grassIdx,
        grassNeed,
        grassK,
        minGrassNeed,
        driftFree: b.seaTexels === 0,
        classes,
        grassKey: '',
        grassLit: EMPTY_I32,
        buildMs: b.elapsedMs,
        resumes: b.resumes,
        bodyCanvas: null,
        bodyKey: '',
        liftCanvas: null,
        liftKey: '',
        shadeCanvas: null,
        shadeKey: '',
    };
}

// Advance a cap chunk builder in resumable row slices until either it completes
// (returns the finished chunk) or `performance.now() - started >= budgetMs`
// (returns null; caller retains the builder for next frame).
function stepCapChunkBuilder(b, started, budgetMs) {
    const sliceStart = performance.now();
    if (b.phase === 0) {
        const isDrift = b.known !== null;
        while (b.ly < CHUNK_H) {
            const lyEnd = Math.min(CHUNK_H, b.ly + CAP_ROW_SLICE);
            if (isDrift) stepCapDriftRows(b, b.ly, lyEnd);
            else stepCapColdRows(b, b.ly, lyEnd);
            b.ly = lyEnd;
            if (b.ly < CHUNK_H && performance.now() - started >= budgetMs) {
                b.elapsedMs += performance.now() - sliceStart;
                b.resumes++;
                return null;
            }
        }
        b.phase = 1;
        b.capCells = b.seaTexels > 0 ? seaField(b.drift) : null;
        if (b.seaTexels > 0 && performance.now() - started >= budgetMs) {
            b.elapsedMs += performance.now() - sliceStart;
            b.resumes++;
            return null;
        }
    }
    if (b.phase === 1) {
        if (b.seaTexels > 0 && !stepCapCells(b, started, budgetMs)) {
            b.elapsedMs += performance.now() - sliceStart;
            b.resumes++;
            return null;
        }
        b.phase = 2;
    }
    const chunk = finalizeCapChunk(b);
    b.elapsedMs += performance.now() - sliceStart;
    chunk.buildMs = b.elapsedMs;
    return chunk;
}

// ---------------------------------------------------------------------------
// Palette: every colour a layer writes, through the Canvas water transform.

function buildPalette(atmosphere, postFx, storm) {
    const mood = waterMoodFor(atmosphere);
    const sunBand = waterSunBandFor(atmosphere);
    const band = 1 + (WATER_SUN_BAND - 1) * sunBand;
    const grade = atmosphere?.lightGrade || null;
    const water = rgb01 => u32Of(CanvasGrade.canvasWaterPreimage(waterSurfaceRgb(rgb01, mood, sunBand), grade, { postFx, sky: mood }));
    // The depth stops, then the 3.3 (a) trough one stop below the deepest
    // (index 6: an open texel's body stop reaches it).
    const seaStops = [...COAST_PALETTE.stops, COAST_PALETTE.trough];
    const stops = seaStops.map(rgb => water(to01(rgb)));
    const cloudCover = clamp01(atmosphere?.weather?.cloudCover);
    const overcast = clamp01((cloudCover - 0.7) / 0.2);
    // Today's static dashes (the resident reduced-motion / MINIMAL frame).
    const staticDash = seaStops.map((rgb) => {
        const c = to01(rgb);
        const luma = c[0] * 0.2126 + c[1] * 0.7152 + c[2] * 0.0722;
        let contrast = storm ? 0.16 : 0.10;
        contrast = contrast + (Math.min(contrast, 0.06) - contrast) * overcast * (1 - storm);
        contrast *= Math.max(storm ? 0.35 : 0.15, Math.min(1, (luma - 0.27) / 0.15));
        return water(c.map(v => v * (1 + contrast)));
    });
    // NE v0.67.1 F — dim shoreline foam at night; starlight stays un-dimmed.
    const fScale = foamNightScale(mood);
    const classes = [];
    classes[CLS_FOAM] = water(to01(COAST_PALETTE.foam).map(v => v * fScale));
    classes[CLS_CREST] = water(to01(COAST_PALETTE.foamCrest).map(v => v * fScale));
    classes[CLS_WET] = u32Of(to01(COAST_PALETTE.wetSand));
    classes[CLS_WET_DARK] = u32Of(to01(COAST_PALETTE.wetSandDark));
    const starlight = water(to01(COAST_PALETTE.foamCrest));
    // The path: graded, held at HSL L <= 0.70 (seaPathCap), painted as the
    // preimage of that; fire glints preserve their warm receiver stops.
    // NE P3.3b — at night, lit moon-path stops (indices 4..5, kind 3) escape
    // the night grade like emitters: the ungraded stop is a named seaPath
    // colour lifted toward cool silver under the V6 cap and seaPathCap, laid
    // post-grade in drawCanvasWaterColumns because the night grade clips its
    // preimage. Sun stops (indices 0..3) and daytime frames stay unchanged.
    const pathOut = (hex, index) => {
        const raw = hexRgb01(hex).map(v => v * band);
        if (!grade) return u32Of(raw);
        const graded = CanvasGrade.canvasFrameGradeRgb(raw, grade, { postFx });
        if (index >= 4 && mood.night > 0) {
            const lifted = liftMoonPathRgb(graded, raw, mood.night, waterMaxSaturation(mood));
            const l = 0.5 * (Math.max(...lifted) + Math.min(...lifted));
            return u32Of(l > 0.70 ? lifted.map(v => v * 0.70 / l) : lifted);
        }
        const l = 0.5 * (Math.max(...graded) + Math.min(...graded));
        return u32Of(l > 0.70 ? CanvasGrade.canvasFramePreimage(graded.map(v => v * 0.70 / l), grade, { postFx }) : raw);
    };
    const path = ART_RAMPS.seaPath.map(pathOut);
    const mirrorMemo = new Map();
    const waterMemo = new Map();
    const convert = (memo, colour, capped) => {
        let out = memo.get(colour);
        if (out === undefined) {
            const c = [(colour >> 16) / 255, ((colour >> 8) & 255) / 255, (colour & 255) / 255];
            const moody = waterSurfaceRgb(c, mood, sunBand);
            out = u32Of(capped ? CanvasGrade.canvasWaterPreimage(moody, grade, { postFx, sky: mood }) : moody);
            memo.set(colour, out);
        }
        return out;
    };
    return {
        stops,
        staticDash,
        classes,
        starlight,
        specks: COAST_PALETTE.seabedSpecks.map(rgb => water(to01(rgb))),
        caustics: COAST_PALETTE.caustics.map(rgb => water(to01(rgb))),
        path,
        // A rippled reflection texel: water colours as water, anything else
        // (a mirrored roof, timber) moody but uncapped, as the resident pass.
        ripple: (colour) => {
            const b = colour & 255;
            const g = (colour >> 8) & 255;
            const r = colour >> 16;
            return b >= r + 6 && g >= r ? convert(waterMemo, colour, true) : convert(mirrorMemo, colour, false);
        },
    };
}

// ---------------------------------------------------------------------------
// The frame's water state (the resident GpuFrameState `resolveWaterFx` for this canvas).

function resolveFx(renderer, atmosphere) {
    const level = renderer.postFx?.isActive?.() === true ? (renderer.postFx?.ladder?.effectiveLevel ?? 0) : 0;
    const motion = Math.max(0, Math.min(2, Number(renderer.motionScale ?? 1) || 0));
    const clock = effectBudgetMode('waterCrests', level) === 'on' ? motion : 0;
    const t = (((Number(renderer.motionTimeMs) || 0) % 1000000) + 1000000) % 1000000;
    const weather = atmosphere?.weather || {};
    const type = String(weather.type || 'clear');
    const raining = type === 'rain' || type === 'storm';
    const grade = atmosphere?.lightGrade || {};
    const zoom = Number(renderer.camera?.zoom) || 1;
    return {
        clock,
        t,
        starlight: resolveStarlight(atmosphere, weather, grade, atmosphere?.lighting?.moonFill ?? atmosphere?.sky?.moon?.fill, level),
        storm: type === 'storm' ? 1 : 0,
        // EN-4 — rings only where rain falls as rain (snow leaves none).
        rain: raining && effectBudgetMode('rainRings', level) !== 'off'
            ? liquidPrecipitation(atmosphere, weather)
            : 0,
        caustics: effectBudgetMode('shallowCaustics', level) === 'on'
            && !raining && (grade.daylight ?? 1 - (grade.night || 0)) > 0.5
            && (Number(grade.sunBand) || 0) > 0.3
            && clamp01(weather.cloudCover) < 0.5
            && (Number(grade.night) || 0) < 0.5
            && zoom >= 1.2,
        swash: effectBudgetMode('coastSwash', level) === 'on' && motion > 0,
        // 3.4 — the sunlit course and the cat's paws shed at MINIMAL.
        seaWeather: effectBudgetMode('sea-weather', level) === 'on',
        // W6.11 — the grass gust course: FULL only, never under reduced motion.
        grassGust: effectBudgetMode('grassGust', level) === 'on' && motion > 0,
        // BI-1 — still water's paws (FULL and REDUCED, never under reduced
        // motion) and the knot wind's share of its crests.
        stillPaws: effectBudgetMode('stillPaws', level) === 'on' && motion > 0,
        stillShare: stillWaterWindShare(weather),
        // BI-8 — the summer surf glow on the swash's crest front.
        surfGlow: resolveSurfGlow(atmosphere, weather, grade, atmosphere?.lighting?.moonFill ?? 0,
            effectBudgetMode('coastSwash', level) === 'on' && motion > 0),
        // E2-03 — the swell sets' drift, on the unwrapped motion clock.
        swellDrift: swellDriftRows(renderer.motionTimeMs),
        deepTick: Math.floor(t * 0.006 * clock),
        nearTick: Math.floor(t * 0.004 * clock),
        ringTick: Math.floor(t * 0.007 * clock),
        swashStep: Math.floor(t * SWASH_STEP_RATE * clock),
        rippleTick: Math.floor(t * 0.002 * clock),
        // 3.7 — heavy rain gives this share of the mirror texels back to
        // the water (the mood layer shows their stop); they no longer ripple.
        mirrorDrop: mirrorStormDrop(weather, atmosphere),
        columnTick: Math.floor(t * COLUMN_TICK_RATE * clock),
        // 2.2 — the column's footprint march (FULL 8, REDUCED 4, MINIMAL 0).
        march: FOOTPRINT_MARCH_STEPS[effectBudgetMode('footprint-occlusion', level)] ?? 0,
        horizonTop: OCEAN_HORIZON_WORLD_Y + openSeaHazeRows(weather.fog),
    };
}

// ---------------------------------------------------------------------------
// The step overlay.

// The lift, swell body and crest must land on the same course as the bed they replace.
function swellColour(renderer, base, palette, flags, stop, x, y, marked) {
    const ocean = renderer._outerOcean;
    const outside = (flags & SEA_OPEN_SEA) !== 0;
    if (!ocean || y - OCEAN_HORIZON_WORLD_Y >= ocean.stripRows) return palette.stops[stop];
    if (!outside) {
        if (!ocean.spec?.fresnel) return palette.stops[stop];
        const c = Math.floor((x - base.fx) / 2);
        const r = Math.floor((y - base.fy) / 2);
        if (c < 0 || r < 0 || c >= base.cols || r >= base.rows
            || !(base.coastField[(r * base.cols + c) * 2 + 1] & COAST_FIELD_FLAGS.sea)) return palette.stops[stop];
    }
    const rgb = canvasSeaMarkRgb(renderer, stop, x, y, marked, outside);
    return rgb < 0 ? palette.stops[stop] : (0xff000000 | ((rgb & 255) << 16) | (rgb & 0xff00) | (rgb >> 16)) >>> 0;
}

// Below the horizon reflection/haze band (`y >= bandEnd`) and for all in-map
// Fresnel sea pixels (`!outside`), `canvasSeaMarkRgb` depends solely on the
// Fresnel course (0..3) and water stop (0..6) — 28 entries total (112 bytes).
const FRESNEL_Y0 = SEA_FRESNEL_Y[0];
const FRESNEL_Y1 = SEA_FRESNEL_Y[1];
const FRESNEL_Y2 = SEA_FRESNEL_Y[2];
const FRESNEL_SAFE_Y = [
    FRESNEL_Y0 - 32,
    (FRESNEL_Y0 + FRESNEL_Y1) >> 1,
    (FRESNEL_Y1 + FRESNEL_Y2) >> 1,
    FRESNEL_Y2 + 32,
];

function resolveSeaColorLut(state, renderer, palette, seaCanvasKey) {
    const ocean = renderer._outerOcean;
    const spec = ocean?.spec || null;
    if (state.seaLutKey === seaCanvasKey && state.seaLutSpec === spec) return;
    state.seaLutKey = seaCanvasKey;
    state.seaLutSpec = spec;
    const lut = state.seaLut;
    if (!ocean || !spec) {
        state.seaLutActive = false;
        state.seaLutFresnel = false;
        state.seaLutStripEnd = -Infinity;
        state.seaLutBandEnd = -Infinity;
        for (let c = 0; c < 4; c++) {
            for (let s = 0; s < 7; s++) lut[c * 7 + s] = palette.stops[s];
        }
        return;
    }
    state.seaLutActive = true;
    state.seaLutFresnel = Boolean(spec.fresnel);
    state.seaLutStripEnd = OCEAN_HORIZON_WORLD_Y + ocean.stripRows;
    // `CANVAS_BAND_CONTOUR_ROWS` is 14 in CoastBake; +16 guarantees `band >= OPEN_SEA_BAND_DEPTH` and `j >= hazeRows`.
    state.seaLutBandEnd = OCEAN_HORIZON_WORLD_Y + (spec.hazeRows || 0) + OPEN_SEA_BAND_DEPTH + 16;
    for (let c = 0; c < 4; c++) {
        const sy = FRESNEL_SAFE_Y[c];
        const baseOff = c * 7;
        for (let s = 0; s < 7; s++) {
            const rgb = canvasSeaMarkRgb(renderer, s, 0, sy, false, false);
            lut[baseOff + s] = rgb < 0 ? palette.stops[s] : (0xff000000 | ((rgb & 255) << 16) | (rgb & 0xff00) | (rgb >> 16)) >>> 0;
        }
    }
}

// Constant Fresnel course `0..3` for row `y`, or `-1/-2/-3` if `y` falls inside
// one of the three 32-row Fresnel seam bands `[SEA_FRESNEL_Y[i]-16, +16)`.
function fresnelRowKind(y) {
    if (y < FRESNEL_Y0 - 16) return 0;
    if (y < FRESNEL_Y0 + 16) return -1;
    if (y < FRESNEL_Y1 - 16) return 1;
    if (y < FRESNEL_Y1 + 16) return -2;
    if (y < FRESNEL_Y2 - 16) return 2;
    if (y < FRESNEL_Y2 + 16) return -3;
    return 3;
}

function fresnelCourseAtPoint(x, y, rk) {
    if (rk >= 0) return rk;
    const bandIdx = -rk - 1;
    const dist = y - SEA_FRESNEL_Y[bandIdx];
    const bend = seaBandBend(x, SEA_FRESNEL_BANDS[bandIdx]);
    return ((dist - bend + 2) << 2) <= CB_BAYER4[((y & 3) << 2) | (x & 3)] ? bandIdx : bandIdx + 1;
}

function markColourLut(state, renderer, base, palette, v, x, y, lighter) {
    const s = (v & 7) > lighter ? (v & 7) - lighter : 0;
    if (y >= state.seaLutStripEnd) return palette.stops[s];
    const outside = (v & SEA_OPEN_SEA) !== 0;
    if (!outside) {
        if (!state.seaLutFresnel) return palette.stops[s];
        const c = Math.floor((x - base.fx) / 2);
        const r = Math.floor((y - base.fy) / 2);
        if (c < 0 || r < 0 || c >= base.cols || r >= base.rows
            || !(base.coastField[(r * base.cols + c) * 2 + 1] & COAST_FIELD_FLAGS.sea)) return palette.stops[s];
        const course = fresnelCourseAtPoint(x, y, fresnelRowKind(y));
        return state.seaLut[course * 7 + s];
    }
    if (y >= state.seaLutBandEnd) {
        const course = state.seaLutFresnel ? fresnelCourseAtPoint(x, y, fresnelRowKind(y)) : 3;
        return state.seaLut[course * 7 + s];
    }
    return swellColour(renderer, base, palette, v, s, x, y, true);
}

function capInfoAt(caps, cursor, x, y) {
    const cx = Math.floor(x / CHUNK_W);
    const cy = Math.floor(y / CHUNK_H);
    const id = chunkId(cx, cy);
    if (id !== cursor.id) {
        cursor.id = id;
        cursor.chunk = caps.get(id) || null;
    }
    return cursor.chunk ? cursor.chunk.info[(y - cy * CHUNK_H) * CHUNK_W + (x - cx * CHUNK_W)] : SEA_NONE;
}

function sunDropAt(sun, v, x, y) {
    const s = v & 7;
    if (s === SEA_NONE) return 0;
    let raw;
    if (sun.uniform1) {
        raw = sun.lift;
    } else {
        const t = sun.texel || 1;
        const lit = sun.mask[posMod(Math.floor((y + sun.oy) / t), sun.height) * sun.width + posMod(Math.floor((x + sun.ox) / t), sun.width)];
        raw = lit ? sun.lift : sun.shadeLift;
    }
    const lift = (v & SEA_OPEN) ? raw : (raw > 1 ? raw - 1 : 0);
    if (!lift || sun.floor == null) return lift;
    return s - Math.max(s - lift, Math.min(s, sun.floor));
}

function shownStopAt(caps, cursor, sun, k, x, y) {
    const v = capInfoAt(caps, cursor, x, y);
    const stop = (v & SEA_OPEN) ? (v & 7) : k;
    if (!sun || (v & 7) === SEA_NONE) return stop;
    let raw;
    if (sun.uniform1) {
        raw = sun.lift;
    } else {
        const t = sun.texel || 1;
        const lit = sun.mask[posMod(Math.floor((y + sun.oy) / t), sun.height) * sun.width + posMod(Math.floor((x + sun.ox) / t), sun.width)];
        raw = lit ? sun.lift : sun.shadeLift;
    }
    const lift = (v & SEA_OPEN) ? raw : (raw > 1 ? raw - 1 : 0);
    if (!lift) return stop;
    return sun.floor != null ? Math.max(stop - lift, Math.min(stop, sun.floor)) : stop - lift;
}

function createOverlayReasons() {
    return {
        glint: 0, base: 0, palette: 0, rect: 0, clock: 0, collar: 0, eddy: 0,
        starlight: 0, deep: 0, near: 0, ring: 0, swash: 0, ripple: 0, still: 0,
        surfGlow: 0, caustics: 0, shade: 0, rain: 0, grass: 0, horizon: 0,
        pending: 0, sun: 0, gust: 0, sea: 0, drift: 0,
    };
}

const OVERLAY_REASON_NAMES = Object.freeze([
    'glint', 'glint', 'base', 'palette', 'rect', 'rect', 'rect', 'rect', 'clock',
    'collar', 'eddy', 'starlight', 'deep', 'near', 'ring', 'swash', 'ripple',
    'still', 'still', 'surfGlow', 'caustics', 'shade', 'rain', 'swash', 'grass',
    'horizon', 'pending', 'sun', 'gust', 'sea', 'drift',
]);

// Update a cap chunk's gust-lit paw and grass lists for `gust`, returning
// whether either list changed relative to what was previously drawn.
function syncChunkGust(chunk, cx, cy, gust, grassOn) {
    const X0 = cx * CHUNK_W;
    const Y0 = cy * CHUNK_H;
    let changed = false;
    if (!gust) {
        if (chunk.pawLit && chunk.pawLit.length > 0) changed = true;
        chunk.pawLit = EMPTY_I32;
        chunk.pawKey = '';
        if (chunk.grassLit && chunk.grassLit.length > 0) changed = true;
        chunk.grassLit = EMPTY_I32;
        chunk.grassKey = '';
        return changed;
    }
    if (chunk.pawKey !== gust.key) {
        const prev = chunk.pawLit;
        let next = EMPTY_I32;
        if (chunk.pawIdx.length > 0 && gustBound(gust, X0, Y0, CHUNK_W, CHUNK_H) > chunk.minPawGust) {
            const on = [];
            for (let n = 0; n < chunk.pawIdx.length; n++) {
                const idx = chunk.pawIdx[n];
                const ly = (idx / CHUNK_W) | 0;
                if (gustAt(gust, X0 + idx - ly * CHUNK_W, Y0 + ly) > chunk.pawGust[n]) on.push(n);
            }
            if (on.length) next = Int32Array.from(on);
        }
        if (!sameInt32Array(prev, next)) changed = true;
        chunk.pawLit = next;
        chunk.pawKey = gust.key;
    }
    if (!grassOn) {
        if (chunk.grassLit && chunk.grassLit.length > 0) changed = true;
        chunk.grassLit = EMPTY_I32;
        chunk.grassKey = '';
    } else if (chunk.grassKey !== gust.key) {
        const prev = chunk.grassLit;
        let next = EMPTY_I32;
        if (chunk.grassIdx.length > 0 && gustBound(gust, X0, Y0, CHUNK_W, CHUNK_H) > chunk.minGrassNeed) {
            const on = [];
            let lastLeft = -1;
            let g = 0;
            for (let n = 0; n < chunk.grassIdx.length; n++) {
                const idx = chunk.grassIdx[n];
                const left = idx & ~1;
                if (left !== lastLeft) {
                    lastLeft = left;
                    const ly = (left / CHUNK_W) | 0;
                    g = gustAt(gust, X0 + left - ly * CHUNK_W, Y0 + ly);
                }
                if (g > 0 && g > chunk.grassNeed[n]) on.push(n);
            }
            if (on.length) next = Int32Array.from(on);
        }
        if (!sameInt32Array(prev, next)) changed = true;
        chunk.grassLit = next;
        chunk.grassKey = gust.key;
    }
    return changed;
}

// Clear a sub-rectangle `(rx0..rx1, ry0..ry1)` (world coords) in the overlay buffers.
function clearSubRect(buf, w, x0, y0, rx0, ry0, rx1, ry1) {
    const lx0 = rx0 - x0;
    const lx1 = rx1 - x0;
    const ly0 = ry0 - y0;
    const ly1 = ry1 - y0;
    if (lx0 === 0 && lx1 === w) {
        buf.fill(0, ly0 * w, ly1 * w);
        return;
    }
    for (let ly = ly0; ly < ly1; ly++) {
        const base = ly * w;
        buf.fill(0, base + lx0, base + lx1);
    }
}

// Dedicated monomorphic overlay pass helpers (avoids megamorphic callbacks and
// keeps every hot loop within TurboFan's inlining budget).

function drawOverlayRipple(base, fx, palette, out, x0, y0, w, rx0, ry0, rx1, ry1) {
    const ripple = base.ripple;
    if (!ripple.length || !boundsIntersect(base.rippleBounds, rx0, ry0, rx1, ry1)) return;
    const { tw, th, bx, by } = base;
    const ty0 = Math.max(0, ry0 - by);
    const ty1 = Math.min(th, ry1 - by);
    if (ty0 >= ty1) return;
    const rTick = fx.rippleTick;
    const mDrop = fx.mirrorDrop;
    const mDrop16 = mDrop * 16;
    const start = lowerBoundTexel(ripple, 4, ty0 * tw);
    const endIdx = ty1 * tw;
    for (let k = start; k < ripple.length; k += 4) {
        const i = ripple[k];
        if (i >= endIdx) break;
        const phase = (ripple[k + 1] + rTick) & 7;
        if (phase !== 0 && phase !== 4) continue;
        const ty = (i / tw) | 0;
        const x = bx + (i - ty * tw);
        if (x < rx0 || x >= rx1) continue;
        const y = by + ty;
        if (mDrop > 0 && CB_BAYER4[((y & 3) << 2) | (x & 3)] < mDrop16) continue;
        out[(y - y0) * w + (x - x0)] = palette.ripple(ripple[k + (phase === 0 ? 2 : 3)]);
    }
}

function drawOverlayCaps(state, renderer, base, fx, palette, sea, out, riseMap, x0, y0, w, rx0, ry0, rx1, ry1) {
    const caps = sea.caps;
    const sun = sea.sun;
    const gust = sea.gust;
    const grassGust = fx.grassGust;
    const stops = palette.stops;
    const stripEnd = state.seaLutStripEnd;
    for (let cy = Math.floor(ry0 / CHUNK_H); cy * CHUNK_H < ry1; cy++) {
        const Y0 = cy * CHUNK_H;
        const ly0 = Math.max(0, ry0 - Y0);
        const ly1 = Math.min(CHUNK_H, ry1 - Y0);
        const idxLo = ly0 * CHUNK_W;
        const idxHi = ly1 * CHUNK_W;
        const chunkBelowStrip = Y0 >= stripEnd;
        for (let cx = Math.floor(rx0 / CHUNK_W); cx * CHUNK_W < rx1; cx++) {
            const chunk = caps.get(chunkId(cx, cy));
            if (!chunk) continue;
            const X0 = cx * CHUNK_W;
            const wholeX = X0 >= rx0 && X0 + CHUNK_W <= rx1;
            const info = chunk.info;
            const lit = chunk.lit;
            if (lit.length) {
                const start = ly0 > 0 ? lowerBoundRange(lit, 0, lit.length, idxLo) : 0;
                if (chunkBelowStrip && !sun) {
                    for (let n = start; n < lit.length; n++) {
                        const idx = lit[n];
                        if (idx >= idxHi) break;
                        const ly = (idx / CHUNK_W) | 0;
                        const x = X0 + idx - ly * CHUNK_W;
                        if (!wholeX && (x < rx0 || x >= rx1)) continue;
                        const v = info[idx];
                        const rise = (v >> SEA_RISE_SHIFT) & 3;
                        const p = (Y0 + ly - y0) * w + (x - x0);
                        riseMap[p] = rise;
                        const s = (v & 7) > rise ? (v & 7) - rise : 0;
                        out[p] = stops[s];
                    }
                } else {
                    for (let n = start; n < lit.length; n++) {
                        const idx = lit[n];
                        if (idx >= idxHi) break;
                        const ly = (idx / CHUNK_W) | 0;
                        const x = X0 + idx - ly * CHUNK_W;
                        if (!wholeX && (x < rx0 || x >= rx1)) continue;
                        const y = Y0 + ly;
                        const v = info[idx];
                        const rise = (v >> SEA_RISE_SHIFT) & 3;
                        const p = (y - y0) * w + (x - x0);
                        riseMap[p] = rise;
                        out[p] = markColourLut(state, renderer, base, palette, v, x, y, rise + (sun ? sunDropAt(sun, v, x, y) : 0));
                    }
                }
            }
            if (!gust) continue;
            syncChunkGust(chunk, cx, cy, gust, grassGust);
            const pawLit = chunk.pawLit;
            if (pawLit && pawLit.length) {
                const pawIdx = chunk.pawIdx;
                const pawRise = chunk.pawRise;
                for (let k = 0; k < pawLit.length; k++) {
                    const n = pawLit[k];
                    const idx = pawIdx[n];
                    if (idx < idxLo || idx >= idxHi) continue;
                    const ly = (idx / CHUNK_W) | 0;
                    const x = X0 + idx - ly * CHUNK_W;
                    if (!wholeX && (x < rx0 || x >= rx1)) continue;
                    const y = Y0 + ly;
                    const v = info[idx];
                    const rise = pawRise[n];
                    const p = (y - y0) * w + (x - x0);
                    riseMap[p] = rise;
                    out[p] = markColourLut(state, renderer, base, palette, v, x, y, rise + (sun ? sunDropAt(sun, v, x, y) : 0));
                }
            }
            if (!grassGust) continue;
            const grassLit = chunk.grassLit;
            if (grassLit && grassLit.length) {
                const grassIdx = chunk.grassIdx;
                const grassK = chunk.grassK;
                for (let k = 0; k < grassLit.length; k++) {
                    const n = grassLit[k];
                    const idx = grassIdx[n];
                    if (idx < idxLo || idx >= idxHi) continue;
                    const ly = (idx / CHUNK_W) | 0;
                    const x = X0 + idx - ly * CHUNK_W;
                    if (!wholeX && (x < rx0 || x >= rx1)) continue;
                    out[(Y0 + ly - y0) * w + (x - x0)] = GRASS_GUST_LIFT[grassK[n]];
                }
            }
        }
    }
}

function drawOverlayStaticDash(base, fx, palette, sea, cursor, out, riseMap, x0, y0, w, rx0, ry0, rx1, ry1) {
    if (!boundsIntersect(base.waterBounds, rx0, ry0, rx1, ry1)) return;
    const { cls, bx, by, tw, th } = base;
    const storm = fx.storm;
    const cw = storm ? 6 : 8;
    const ch = storm ? 3 : 4;
    const presence = storm ? 0.55 : 0.30;
    const cy0 = Math.floor(Math.max(ry0, base.waterBounds.y0) / ch);
    const cyEnd = Math.min(ry1, base.waterBounds.y1);
    const cx0 = Math.floor(Math.max(rx0, base.waterBounds.x0) / cw);
    const cxEnd = Math.min(rx1, base.waterBounds.x1);
    const caps = sea.caps;
    const sun = sea.sun;
    const staticDash = palette.staticDash;
    for (let cy = cy0; cy * ch < cyEnd; cy++) {
        for (let cx = cx0; cx * cw < cxEnd; cx++) {
            const seed = fract(Math.sin(cx * 12.9898 + cy * 78.233) * 43758.5453);
            if (fract(seed * 31.7) > presence || Math.floor(seed * 4) % 4 !== 0) continue;
            const dashX = cx * cw + Math.floor(seed * (cw - 2));
            const y = cy * ch + Math.floor(fract(seed * 7.13) * ch);
            if (y < ry0 || y >= ry1) continue;
            const ty = y - by;
            if (ty < 0 || ty >= th) continue;
            const tRow = ty * tw;
            const oRow = (y - y0) * w - x0;
            for (let x = dashX; x <= dashX + 2; x++) {
                if (x < rx0 || x >= rx1) continue;
                const p = oRow + x;
                if (riseMap[p]) continue;
                const tx = x - bx;
                if (tx < 0 || tx >= tw) continue;
                const k = cls[tRow + tx];
                if (k <= 5) out[p] = staticDash[shownStopAt(caps, cursor, sun, k, x, y)];
            }
        }
    }
}

function drawOverlayCaustics(base, causticList, shade, palette, out, x0, y0, w, rx0, ry0, rx1, ry1) {
    if (!causticList || !causticList.length || !boundsIntersect(base.causticBounds, rx0, ry0, rx1, ry1)) return;
    const { tw, th, bx, by, cls } = base;
    const ty0 = Math.max(0, ry0 - by);
    const ty1 = Math.min(th, ry1 - by);
    if (ty0 >= ty1) return;
    const start = lowerBoundTexel(causticList, 1, ty0 * tw);
    const endIdx = ty1 * tw;
    const caustics = palette.caustics;
    for (let n = start; n < causticList.length; n++) {
        const i = causticList[n];
        if (i >= endIdx) break;
        const ty = (i / tw) | 0;
        const x = bx + (i - ty * tw);
        if (x < rx0 || x >= rx1) continue;
        const y = by + ty;
        const k = cls[i];
        if (k === 2 && shade && shadeGroundAt(shade, x, y)) continue;
        out[(y - y0) * w + (x - x0)] = caustics[k];
    }
}

function drawOverlayNear(base, fx, palette, sea, cursor, out, riseMap, x0, y0, w, rx0, ry0, rx1, ry1) {
    if (!boundsIntersect(base.nearBounds, rx0, ry0, rx1, ry1)) return;
    const { tw, th, bx, by, cls, near } = base;
    const storm = fx.storm;
    const density = (storm ? STORM_DASH_DENSITY : NEAR_SHORE_DASH_DENSITY) * 256;
    const stillDensity = storm ? density : NEAR_SHORE_DASH_DENSITY * fx.stillShare * 256;
    const foamCol = palette.classes[CLS_FOAM];
    const crestCol = palette.classes[CLS_CREST];
    const stops = palette.stops;
    const caps = sea.caps;
    const sun = sea.sun;
    const nX = near.x;
    const nY = near.y;
    const nH = near.h;
    const nCap = near.cap;
    const nStill = near.still;
    for (let ci = 0; ci < 2; ci++) {
        const course = ci === 0 ? 1 : 2;
        const bucket = (((course === 2 ? 14 : 15) - fx.nearTick) % 16 + 16) % 16;
        const bStart = near.start[bucket];
        const bEnd = near.start[bucket + 1];
        const nStart = lowerBoundRange(nY, bStart, bEnd, ry0);
        for (let n = nStart; n < bEnd; n++) {
            const y = nY[n];
            if (y >= ry1) break;
            if (nH[n] >= (nStill[n] ? stillDensity : density)) continue;
            const ox = nX[n];
            if (ox + 3 <= rx0 || ox >= rx1) continue;
            const ty = y - by;
            if (ty < 0 || ty >= th) continue;
            const cap = storm && nCap[n];
            const xStart = ox > rx0 ? ox : rx0;
            const xEnd = ox + 3 < rx1 ? ox + 3 : rx1;
            const tRow = ty * tw;
            const oRow = (y - y0) * w - x0;
            for (let x = xStart; x < xEnd; x++) {
                const tx = x - bx;
                if (tx < 0 || tx >= tw) continue;
                const k = cls[tRow + tx];
                if (k > 5) continue;
                const p = oRow + x;
                if (cap) {
                    out[p] = foamCol;
                    continue;
                }
                const b = shownStopAt(caps, cursor, sun, k, x, y);
                if (course === 2) {
                    out[p] = b <= 1 ? crestCol : stops[b - 1];
                } else {
                    const r = riseMap[p] > 1 ? riseMap[p] : 1;
                    out[p] = stops[b > r ? b - r : 0];
                }
            }
        }
    }
}

function drawOverlayDeep(state, renderer, base, fx, palette, sea, out, riseMap, x0, y0, w, rx0, ry0, rx1, ry1) {
    const { tw, th, bx, by, cls, fx: fieldX, fy: fieldY, cols, rows, cycleOffset, coastField } = base;
    const storm = fx.storm;
    const lead = ((-fx.deepTick % 16) + 16) % 16;
    const trail = (lead + 1) % 16;
    const inMapDensity = storm ? STORM_DASH_DENSITY : null;
    const seaDensity = (storm ? STORM_DASH_DENSITY : DEEP_DASH_DENSITY) * 256;
    const deepTick = fx.deepTick;
    const normal0 = SWELL_SET_NORMAL[0];
    const foamCol = palette.classes[CLS_FOAM];
    const stops = palette.stops;
    const stillShare = fx.stillShare;
    const caps = sea.caps;
    const sun = sea.sun;
    const stripEnd = state.seaLutStripEnd;
    for (let cy = Math.floor(ry0 / CHUNK_H); cy * CHUNK_H < ry1; cy++) {
        const Y0 = cy * CHUNK_H;
        if (Y0 + CHUNK_H <= OCEAN_HORIZON_WORLD_Y) continue;
        const ly0 = Math.max(0, ry0 - Y0);
        const ly1 = Math.min(CHUNK_H, ry1 - Y0);
        const cellLo = ly0 * CHUNK_CELLS_X;
        const cellHi = ly1 * CHUNK_CELLS_X;
        const yOutOfTerrain = Y0 + CHUNK_H <= by || Y0 >= by + th;
        const chunkBelowStrip = Y0 >= stripEnd;
        for (let cx = Math.floor(rx0 / CHUNK_W); cx * CHUNK_W < rx1; cx++) {
            const chunk = state.chunks.get(`${cx},${cy},${storm}`);
            if (!chunk) continue;
            const capChunk = caps.get(chunkId(cx, cy)) || null;
            const capInfo = capChunk ? capChunk.info : null;
            const X0 = cx * CHUNK_W;
            const chunkOutsideTerrain = yOutOfTerrain || X0 + CHUNK_W <= bx || X0 >= bx + tw;
            if (chunkOutsideTerrain && !capInfo) continue;
            const wholeX = X0 >= rx0 && X0 + CHUNK_W <= rx1;
            const noNearCrest = chunkHasNoNearCrest(X0, Y0);
            const cIndex = chunk.index;
            const cB = chunk.B;
            const cH = chunk.h;
            const baseCellX = cx * CHUNK_CELLS_X;

            for (let bi = 0; bi < 2; bi++) {
                const bucket = bi === 0 ? lead : trail;
                const isLead = bi === 0;
                const bStart = chunk.start[bucket];
                const bEnd = chunk.start[bucket + 1];
                const nStart = ly0 > 0 ? lowerBoundRange(cIndex, bStart, bEnd, cellLo) : bStart;
                let lastWave = 0x7fffffff;
                let lastRun = 0x7fffffff;
                let lastPass = false;
                if (chunkOutsideTerrain) {
                    const fastStops = chunkBelowStrip && !sun;
                    if (fastStops && !storm && noNearCrest && wholeX && isLead) {
                        for (let n = nStart; n < bEnd; n++) {
                            const index = cIndex[n];
                            if (index >= cellHi) break;
                            const ly = index >> 7;
                            const y = Y0 + ly;
                            if (y < OCEAN_HORIZON_WORLD_Y) continue;
                            const ox = X0 + (index & 127) * 3;
                            const wave = (cB[n] + deepTick) >> 4;
                            const run = Math.floor((ox - y * normal0) / DEEP_CREST_RUN);
                            if (wave !== lastWave || run !== lastRun) {
                                lastWave = wave;
                                lastRun = run;
                                lastPass = hash12(wave + 59, run + 11) < SWELL_SET_SHARE;
                            }
                            if (!lastPass) continue;
                            const p0 = (y - y0) * w + (ox - x0);
                            const c0 = ly * CHUNK_W + (ox - X0);
                            const v0 = capInfo[c0];
                            if (v0 !== SEA_NONE) {
                                const r0 = riseMap[p0];
                                const l0 = r0 > 1 ? r0 : 1;
                                const s0 = v0 & 7;
                                out[p0] = stops[s0 > l0 ? s0 - l0 : 0];
                            }
                            const v1 = capInfo[c0 + 1];
                            if (v1 !== SEA_NONE) {
                                const r1 = riseMap[p0 + 1];
                                const l1 = r1 > 1 ? r1 : 1;
                                const s1 = v1 & 7;
                                out[p0 + 1] = stops[s1 > l1 ? s1 - l1 : 0];
                            }
                            const v2 = capInfo[c0 + 2];
                            if (v2 !== SEA_NONE) {
                                const r2 = riseMap[p0 + 2];
                                const l2 = r2 > 1 ? r2 : 1;
                                const s2 = v2 & 7;
                                out[p0 + 2] = stops[s2 > l2 ? s2 - l2 : 0];
                            }
                        }
                    } else {
                        for (let n = nStart; n < bEnd; n++) {
                            const index = cIndex[n];
                            if (index >= cellHi) break;
                            const ly = index >> 7;
                            const y = Y0 + ly;
                            if (y < OCEAN_HORIZON_WORLD_Y) continue;
                            const lc = index & 127;
                            const ox = X0 + lc * 3;
                            if (!wholeX && (ox + 3 <= rx0 || ox >= rx1)) continue;
                            const wave = (cB[n] + deepTick) >> 4;
                            const run = Math.floor((ox - y * normal0) / DEEP_CREST_RUN);
                            if (wave !== lastWave || run !== lastRun) {
                                lastWave = wave;
                                lastRun = run;
                                lastPass = hash12(wave + 59, run + 11) < SWELL_SET_SHARE;
                            }
                            if (!lastPass) continue;
                            const cap = storm && hash12(baseCellX + lc + 17, y + 31) < 0.25;
                            const bayerRow = (y & 3) << 2;
                            const oRow = (y - y0) * w - x0;
                            const capRow = ly * CHUNK_W - X0;
                            const xStart = ox > rx0 ? ox : rx0;
                            const xEnd = ox + 3 < rx1 ? ox + 3 : rx1;
                            for (let x = xStart; x < xEnd; x++) {
                                if (!isLead && WATER_BAYER4[bayerRow | (x & 3)] < 0.5) continue;
                                const p = oRow + x;
                                if (cap) { out[p] = foamCol; continue; }
                                const v = capInfo[capRow + x];
                                if (v === SEA_NONE) continue;
                                const rOld = riseMap[p];
                                const crest = noNearCrest || rOld >= 2 ? 1 : (isSeaNearCrest(x, y) ? 2 : 1);
                                const lighter = rOld > crest ? rOld : crest;
                                if (fastStops) {
                                    const s = (v & 7) > lighter ? (v & 7) - lighter : 0;
                                    out[p] = stops[s];
                                } else {
                                    out[p] = markColourLut(state, renderer, base, palette, v, x, y, lighter + (sun ? sunDropAt(sun, v, x, y) : 0));
                                }
                            }
                        }
                    }
                } else {
                    for (let n = nStart; n < bEnd; n++) {
                        const index = cIndex[n];
                        if (index >= cellHi) break;
                        const ly = index >> 7;
                        const y = Y0 + ly;
                        const lc = index & 127;
                        const ox = X0 + lc * 3;
                        if (!wholeX && (ox + 3 <= rx0 || ox >= rx1)) continue;
                        const ty = y - by;
                        const inTy = ty >= 0 && ty < th;
                        const tRow = ty * tw;
                        // Reject dry-land / shallow-stop cells before hashing.
                        if (inTy) {
                            const tx0 = ox - bx;
                            if (tx0 >= 0 && tx0 + 2 < tw) {
                                const p0 = tRow + tx0;
                                const kA = cls[p0], kB = cls[p0 + 1], kC = cls[p0 + 2];
                                if ((kA < 2 || (kA > 5 && kA !== CLS_EMPTY))
                                    && (kB < 2 || (kB > 5 && kB !== CLS_EMPTY))
                                    && (kC < 2 || (kC > 5 && kC !== CLS_EMPTY))) continue;
                            }
                        } else if (y < OCEAN_HORIZON_WORLD_Y) {
                            continue;
                        }
                        const wave = (cB[n] + deepTick) >> 4;
                        const run = Math.floor((ox - y * normal0) / DEEP_CREST_RUN);
                        if (wave !== lastWave || run !== lastRun) {
                            lastWave = wave;
                            lastRun = run;
                            lastPass = hash12(wave + 59, run + 11) < SWELL_SET_SHARE;
                        }
                        if (!lastPass) continue;
                        const hq = cH[n];
                        const cap = storm && hash12(baseCellX + lc + 17, y + 31) < 0.25;
                        const bayerRow = (y & 3) << 2;
                        const oRow = (y - y0) * w - x0;
                        const capRow = ly * CHUNK_W - X0;
                        const xStart = ox > rx0 ? ox : rx0;
                        const xEnd = ox + 3 < rx1 ? ox + 3 : rx1;
                        let origin = -1;
                        let calm = 1;
                        for (let x = xStart; x < xEnd; x++) {
                            if (!isLead && WATER_BAYER4[bayerRow | (x & 3)] < 0.5) continue;
                            const tx = x - bx;
                            const k0 = inTy && tx >= 0 && tx < tw ? cls[tRow + tx] : CLS_EMPTY;
                            if (k0 === CLS_EMPTY) {
                                if (y < OCEAN_HORIZON_WORLD_Y || hq >= seaDensity) continue;
                            } else {
                                if (k0 > 5 || k0 < 2) continue;
                                if (origin < 0) {
                                    const fc = Math.floor((ox - fieldX) / 2);
                                    const fr = Math.floor((y - fieldY) / 2);
                                    if (fc < 0 || fr < 0 || fc >= cols || fr >= rows) {
                                        origin = 255;
                                    } else {
                                        const fCell = fr * cols + fc;
                                        origin = cycleOffset[fCell];
                                        if (origin === 255 && (coastField[fCell * 2 + 1] & STILL_FLAGS) === STILL_FLAGS) calm = stillShare;
                                    }
                                }
                                if (origin !== 255) continue;
                                const density = (inMapDensity ?? (k0 >= 3 ? DEEP_DASH_DENSITY : NEAR_SHORE_DASH_DENSITY) * calm) * 256;
                                if (hq >= density) continue;
                            }
                            const p = oRow + x;
                            if (cap) { out[p] = foamCol; continue; }
                            const v = capInfo ? capInfo[capRow + x] : SEA_NONE;
                            if (k0 === CLS_EMPTY && v === SEA_NONE) continue;
                            const rOld = riseMap[p];
                            const crest = !noNearCrest && (v & 7) !== SEA_NONE && rOld < 2 && isSeaNearCrest(x, y) ? 2 : 1;
                            const lighter = rOld > crest ? rOld : crest;
                            out[p] = (v & 7) === SEA_NONE
                                ? stops[k0 > lighter ? k0 - lighter : 0]
                                : markColourLut(state, renderer, base, palette, v, x, y, lighter + (sun ? sunDropAt(sun, v, x, y) : 0));
                        }
                    }
                }
            }
        }
    }
}

function drawOverlayStarlight(renderer, fx, palette, sea, cursor, out, riseMap, x0, y0, w, rx0, ry0, rx1, ry1) {
    if (!(fx.starlight > 0) || sea.road?.kind !== 3) return;
    const view = sea.view;
    const gx = view.x0 + (sea.road.body?.xFrac ?? 0.5) * (view.x1 - view.x0);
    const grow = 0.12 * (sea.road.growScale ?? 1);
    const yStart = Math.max(ry0, fx.horizonTop);
    const caps = sea.caps;
    for (let y = yStart; y < ry1; y++) {
        const roadHalf = 0.95 * (5 + (y + 0.5 - view.y0) * grow);
        if (roadHalf <= 0) continue;
        const rowX0 = Math.max(rx0, Math.floor(gx - roadHalf) - 1);
        const rowX1 = Math.min(rx1, Math.ceil(gx + roadHalf) + 1);
        if (rowX0 >= rowX1) continue;
        const oRow = (y - y0) * w - x0;
        const cxEnd = Math.floor((rowX1 - 1) / 3);
        for (let cx = Math.floor(rowX0 / 3); cx <= cxEnd; cx++) {
            const xA = cx * 3 > rowX0 ? cx * 3 : rowX0;
            const xB = cx * 3 + 2 < rowX1 ? cx * 3 + 2 : rowX1;
            if (xA >= xB) continue;
            if (riseMap[oRow + xA] <= 0 && (xA + 1 >= xB || riseMap[oRow + xA + 1] <= 0)) continue;
            const seed = hash12(cx + 307, y + 43);
            const life = Math.floor((fx.deepTick + Math.floor(seed * STARLIGHT_HOLD)) / STARLIGHT_HOLD);
            if (hash12(cx + 311 + life * 7, y + 47 + life * 3) >= STARLIGHT_DENSITY * fx.starlight) continue;
            for (let x = xA; x < xB; x++) {
                const p = oRow + x;
                if (riseMap[p] <= 0) continue;
                if (Math.abs(x + 0.5 - gx) >= roadHalf) continue;
                let colour = palette.starlight;
                if (capInfoAt(caps, cursor, x, y) & SEA_OPEN_SEA) {
                    const c = canvasSeaMarkRgb(renderer, 'crest', x, y, true);
                    if (c >= 0) colour = ((255 << 24) | ((c & 255) << 16) | (c & 0xff00) | (c >> 16)) >>> 0;
                }
                out[p] = colour;
            }
        }
    }
}

function drawOverlayStill(base, gust, palette, out, x0, y0, w, rx0, ry0, rx1, ry1) {
    const still = base.still;
    if (!gust || !still || still.blocks <= 0) return;
    const stops = palette.stops;
    const crestCol = palette.classes[CLS_CREST];
    const bStart = lowerBoundRange(still.blockY, 0, still.blocks, ry0 - STILL_BLOCK_H + 1);
    for (let b = bStart; b < still.blocks; b++) {
        const by0 = still.blockY[b];
        if (by0 >= ry1) break;
        const bx0 = still.blockX[b];
        if (bx0 + STILL_BLOCK_W <= rx0 || bx0 >= rx1) continue;
        if (gustBound(gust, bx0, by0, STILL_BLOCK_W, STILL_BLOCK_H) <= still.blockNeed[b]) continue;
        const nEnd = still.start[b + 1];
        for (let n = still.start[b]; n < nEnd; n++) {
            const x = still.x[n];
            const y = still.y[n];
            if (x < rx0 || x >= rx1 || y < ry0 || y >= ry1 || gustAt(gust, x, y) <= still.need[n]) continue;
            const c = still.colour[n];
            out[(y - y0) * w + (x - x0)] = c === STILL_CREST ? crestCol : stops[c];
        }
    }
}

function drawOverlaySpecks(base, palette, out, x0, y0, w, rx0, ry0, rx1, ry1) {
    const specks = base.specks;
    if (!specks.length || !boundsIntersect(base.specksBounds, rx0, ry0, rx1, ry1)) return;
    const { tw, th, bx, by, cls } = base;
    const ty0 = Math.max(0, ry0 - by);
    const ty1 = Math.min(th, ry1 - by);
    if (ty0 >= ty1) return;
    const start = lowerBoundTexel(specks, 1, ty0 * tw);
    const endIdx = ty1 * tw;
    const specCols = palette.specks;
    for (let n = start; n < specks.length; n++) {
        const i = specks[n];
        if (i >= endIdx) break;
        const ty = (i / tw) | 0;
        const x = bx + (i - ty * tw);
        if (x < rx0 || x >= rx1) continue;
        out[(by + ty - y0) * w + (x - x0)] = specCols[cls[i]];
    }
}

function drawOverlayRain(base, fx, palette, sea, cursor, out, x0, y0, w, rx0, ry0, rx1, ry1) {
    if (!(fx.rain > 0) || !boundsIntersect(base.waterBounds, rx0, ry0, rx1, ry1)) return;
    const { tw, th, bx, by, cls, waterGrid } = base;
    const storm = fx.storm;
    const clock = fx.clock;
    const sw = storm ? 8 : 12;
    const sh = storm ? 4 : 6;
    const rx = storm ? 2 : 4;
    const ry = storm ? 1 : 2;
    const live = 0.55 * fx.rain;
    const rCy0 = Math.floor(Math.max(ry0, base.waterBounds.y0) / sh);
    const rCyEnd = Math.min(ry1, base.waterBounds.y1);
    const rCx0 = Math.floor(Math.max(rx0, base.waterBounds.x0) / sw);
    const rCxEnd = Math.min(rx1, base.waterBounds.x1);
    const wBits = waterGrid.bits;
    const wCols = waterGrid.cols;
    const wRows = waterGrid.rows;
    const wGx0 = waterGrid.gx0;
    const wGy0 = waterGrid.gy0;
    const foamCol = palette.classes[CLS_FOAM];
    const stops = palette.stops;
    const caps = sea.caps;
    const sun = sea.sun;
    const ringTick = fx.ringTick;
    for (let cy = rCy0; cy * sh < rCyEnd; cy++) {
        const cellY0 = cy * sh;
        const gr0 = (cellY0 - wGy0) >> 3;
        if (storm) {
            if (gr0 < 0 || gr0 >= wRows) continue;
            const wRowOff = gr0 * wCols;
            for (let cx = rCx0; cx * sw < rCxEnd; cx++) {
                const cellX0 = cx * sw;
                const gc = (cellX0 - wGx0) >> 4;
                if (gc < 0 || gc >= wCols) continue;
                const bit = wRowOff + gc;
                if (!(wBits[bit >> 3] & (1 << (bit & 7)))) continue;
                const seed = latticeHash12(cx + 41, cy + 7);
                let stage = 2;
                let life = 0;
                if (clock > 0) {
                    const s = ringTick + Math.floor(seed * 5);
                    life = Math.floor(s / 5);
                    stage = s % 5;
                    if (stage > 2 || latticeHash12(cx + 43, cy + 11 + life * 4096) >= live) continue;
                } else if (seed >= Math.min(0.20, live)) {
                    continue;
                }
                const centreX = cellX0 + rx + Math.floor(latticeHash12(cx + 47, cy + 13 + life * 4096) * (sw - rx * 2));
                const centreY = cellY0 + ry + Math.floor(latticeHash12(cx + 29, cy + 17 + life * 4096) * (sh - ry * 2));
                const offsets = RING_STAGES[stage];
                for (let oi = 0; oi < offsets.length; oi++) {
                    const x = centreX + offsets[oi][0];
                    const y = centreY + offsets[oi][1];
                    if (x < rx0 || x >= rx1 || y < ry0 || y >= ry1) continue;
                    const tx = x - bx;
                    const ty = y - by;
                    if (tx < 0 || ty < 0 || tx >= tw || ty >= th) continue;
                    const k = cls[ty * tw + tx];
                    if (k > 5) continue;
                    const b = shownStopAt(caps, cursor, sun, k, x, y);
                    out[(y - y0) * w + (x - x0)] = b === 0 ? foamCol : stops[b - 1];
                }
            }
        } else {
            const gr1 = (cellY0 + sh - 1 - wGy0) >> 3;
            const rA = gr0 < 0 ? 0 : gr0;
            const rB = gr1 >= wRows ? wRows - 1 : gr1;
            if (rA > rB) continue;
            for (let cx = rCx0; cx * sw < rCxEnd; cx++) {
                const cellX0 = cx * sw;
                const gc0 = (cellX0 - wGx0) >> 4;
                const gc1 = (cellX0 + sw - 1 - wGx0) >> 4;
                const cA = gc0 < 0 ? 0 : gc0;
                const cB = gc1 >= wCols ? wCols - 1 : gc1;
                if (cA > cB) continue;
                let hasW = false;
                for (let r = rA; r <= rB && !hasW; r++) {
                    const rowBit = r * wCols;
                    for (let c = cA; c <= cB; c++) {
                        const bit = rowBit + c;
                        if (wBits[bit >> 3] & (1 << (bit & 7))) { hasW = true; break; }
                    }
                }
                if (!hasW) continue;
                const seed = latticeHash12(cx + 41, cy + 7);
                let stage = 2;
                let life = 0;
                if (clock > 0) {
                    const s = ringTick + Math.floor(seed * 5);
                    life = Math.floor(s / 5);
                    stage = s % 5;
                    if (stage > 3 || latticeHash12(cx + 43, cy + 11 + life * 4096) >= live) continue;
                } else if (seed >= Math.min(0.20, live)) {
                    continue;
                }
                const centreX = cellX0 + rx + Math.floor(latticeHash12(cx + 47, cy + 13 + life * 4096) * (sw - rx * 2));
                const centreY = cellY0 + ry + Math.floor(latticeHash12(cx + 29, cy + 17 + life * 4096) * (sh - ry * 2));
                const offsets = RING_STAGES[stage];
                for (let oi = 0; oi < offsets.length; oi++) {
                    const x = centreX + offsets[oi][0];
                    const y = centreY + offsets[oi][1];
                    if (x < rx0 || x >= rx1 || y < ry0 || y >= ry1) continue;
                    const tx = x - bx;
                    const ty = y - by;
                    if (tx < 0 || ty < 0 || tx >= tw || ty >= th) continue;
                    const k = cls[ty * tw + tx];
                    if (k > 5) continue;
                    const b = shownStopAt(caps, cursor, sun, k, x, y);
                    out[(y - y0) * w + (x - x0)] = b === 0 ? foamCol : stops[b - 1];
                }
            }
        }
    }
}

function drawOverlaySwash(base, palette, collarList, eddyList, swashList, swashBigList, shift, out, mask, glowOut, x0, y0, w, rx0, ry0, rx1, ry1) {
    const { tw, th, bx, by, cls } = base;
    const ty0 = Math.max(0, ry0 - by);
    const ty1 = Math.min(th, ry1 - by);
    if (ty0 >= ty1) return;
    const startIdx = ty0 * tw;
    const endIdx = ty1 * tw;
    const stops = palette.stops;
    const foamCol = palette.classes[CLS_FOAM];
    const pClasses = palette.classes;

    const threads = base.threads;
    if (threads.length && boundsIntersect(base.threadsBounds, rx0, ry0, rx1, ry1)) {
        for (let n = lowerBoundTexel(threads, 2, startIdx); n < threads.length; n += 2) {
            const i = threads[n];
            if (i >= endIdx) break;
            const ty = (i / tw) | 0;
            const x = bx + (i - ty * tw);
            if (x < rx0 || x >= rx1) continue;
            const s = x - shift;
            const h = latticeHash12(Math.floor(s / 20), threads[n + 1]);
            if (h < 0.45 && posMod(s, 20) < 4 + Math.floor(fract(h * 11.3) * 6)) {
                const k = cls[i];
                out[(by + ty - y0) * w + (x - x0)] = stops[k > 0 ? k - 1 : 0];
            }
        }
    }
    if (collarList.length && boundsIntersect(base.collarBounds, rx0, ry0, rx1, ry1)) {
        for (let n = lowerBoundTexel(collarList, 1, startIdx); n < collarList.length; n++) {
            const i = collarList[n];
            if (i >= endIdx) break;
            const ty = (i / tw) | 0;
            const x = bx + (i - ty * tw);
            if (x < rx0 || x >= rx1) continue;
            const p = (by + ty - y0) * w + (x - x0);
            out[p] = foamCol;
            mask[p] = 1;
        }
    }
    if (eddyList.length && boundsIntersect(base.eddyBounds, rx0, ry0, rx1, ry1)) {
        for (let n = lowerBoundTexel(eddyList, 1, startIdx); n < eddyList.length; n++) {
            const i = eddyList[n];
            if (i >= endIdx) break;
            const ty = (i / tw) | 0;
            const x = bx + (i - ty * tw);
            if (x < rx0 || x >= rx1) continue;
            const p = (by + ty - y0) * w + (x - x0);
            out[p] = foamCol;
            mask[p] = 1;
        }
    }
    if (swashList && boundsIntersect(base.swashBounds, rx0, ry0, rx1, ry1)) {
        if (swashList.length) {
            for (let k = lowerBoundTexel(swashList, 2, startIdx); k < swashList.length; k += 2) {
                const i = swashList[k];
                if (i >= endIdx) break;
                const ty = (i / tw) | 0;
                const x = bx + (i - ty * tw);
                if (x < rx0 || x >= rx1) continue;
                const p = (by + ty - y0) * w + (x - x0);
                const code = swashList[k + 1];
                const c = code & SWASH_CLASS;
                if (c !== cls[i]) {
                    out[p] = pClasses[c];
                    mask[p] = 1;
                }
                if (glowOut && (code & SWASH_GLOW)) glowOut[p] = SURF_GLOW_U32;
            }
        }
        if (swashBigList.length) {
            for (let k = lowerBoundTexel(swashBigList, 2, startIdx); k < swashBigList.length; k += 2) {
                const i = swashBigList[k];
                if (i >= endIdx) break;
                const ty = (i / tw) | 0;
                const x = bx + (i - ty * tw);
                if (x < rx0 || x >= rx1) continue;
                const p = (by + ty - y0) * w + (x - x0);
                const code = swashBigList[k + 1];
                const c = code & SWASH_CLASS;
                out[p] = c && c !== cls[i] ? pClasses[c] : 0;
                mask[p] = 1;
                if (glowOut) glowOut[p] = code & SWASH_GLOW ? SURF_GLOW_U32 : 0;
            }
        }
    }
}

// `sea`: the frame's cap chunks (`caps`), the sunlit tile and its offset
// (`sun`, null when off) and the gust field (`gust`, null in calm air).
// `plan`: `{ full, dirtyRects, updateGlow }` — when `!full`, clears, draws and
// uploads only the dirty chunk/row rectangles (including newly transparent pixels).
function rebuildOverlay(state, base, fx, palette, rect, renderer, sea, plan) {
    const parts = state.stats.overlayParts;
    parts.clearMs = 0;
    parts.rippleMs = 0;
    parts.capsMs = 0;
    parts.staticDashMs = 0;
    parts.causticsMs = 0;
    parts.nearMs = 0;
    parts.deepMs = 0;
    parts.starlightMs = 0;
    parts.stillMs = 0;
    parts.specksMs = 0;
    parts.rainMs = 0;
    parts.swashMs = 0;
    parts.uploadMs = 0;

    let t0 = performance.now();
    const { x0, y0, w, h } = rect;
    const full = Boolean(plan?.full);
    const layer = layerCanvas(state.overlay, w, h, false);
    const needFull = full || layer.resized;
    const out = layer.u32;
    const cells = w * h;
    let mask = state.mask;
    let riseMap = state.rise;
    const allocMask = !mask || mask.length !== cells;
    if (allocMask) {
        mask = state.mask = new Uint8Array(cells);
        riseMap = state.rise = new Uint8Array(cells);
    } else if (!riseMap || riseMap.length !== cells) {
        riseMap = state.rise = new Uint8Array(cells);
    }
    const dirtyRects = needFull || allocMask ? [{ x0, y0, x1: x0 + w, y1: y0 + h }] : plan.dirtyRects;
    if (needFull || allocMask) {
        if (!layer.resized) out.fill(0);
        if (!allocMask) {
            mask.fill(0);
            riseMap.fill(0);
        }
    } else {
        for (let d = 0; d < dirtyRects.length; d++) {
            const dr = dirtyRects[d];
            clearSubRect(out, w, x0, y0, dr.x0, dr.y0, dr.x1, dr.y1);
            clearSubRect(mask, w, x0, y0, dr.x0, dr.y0, dr.x1, dr.y1);
            clearSubRect(riseMap, w, x0, y0, dr.x0, dr.y0, dr.x1, dr.y1);
        }
    }
    let t1 = performance.now();
    parts.clearMs = t1 - t0;

    const clock = fx.clock;
    const shade = fx.caustics ? (renderer._shadeFieldState?.ready?.field || null) : null;
    const causticList = fx.caustics ? base.caustic[clock > 0 ? Math.floor(fx.t * 0.004 * clock) % 8 : 0] : null;
    const collarList = base.collars[Math.floor(fx.t * clock / 300) % 3];
    const eddyList = base.eddies[Math.floor(fx.t * 0.003 * clock) % 2];
    const swashList = clock > 0 && fx.swash ? base.swash[posMod(fx.swashStep, SWASH_WAVE)] : null;
    const swashBigList = clock > 0 && fx.swash ? base.swashBig[posMod(fx.swashStep, SWASH_SET)] : null;
    const shift = Math.floor(fx.t * 0.006 * clock);
    const capCursor = { id: -1, chunk: null };

    // Update glow layer only when needed (swash/surfGlow/rect changed).
    const wantGlow = clock > 0 && fx.swash && fx.surfGlow > 0;
    const doGlow = wantGlow && (needFull || plan.updateGlow || !state.glowValid);
    let glow = null;
    let glowOut = null;
    let glowFull = false;
    if (doGlow) {
        glow = layerCanvas(state.glow, w, h, false);
        glowOut = glow.u32;
        glowFull = needFull || glow.resized || !state.glowValid;
        if (glowFull) {
            if (!glow.resized) glowOut.fill(0);
        } else {
            for (let d = 0; d < dirtyRects.length; d++) {
                const dr = dirtyRects[d];
                clearSubRect(glowOut, w, x0, y0, dr.x0, dr.y0, dr.x1, dr.y1);
            }
        }
    } else if (!wantGlow) {
        state.glowLive = false;
        state.glowValid = false;
    }

    let dirtyArea = 0;
    for (let d = 0; d < dirtyRects.length; d++) {
        const dr = dirtyRects[d];
        const rx0 = dr.x0;
        const ry0 = dr.y0;
        const rx1 = dr.x1;
        const ry1 = dr.y1;
        if (rx0 >= rx1 || ry0 >= ry1) continue;
        dirtyArea += (rx1 - rx0) * (ry1 - ry0);

        t0 = performance.now();
        if (clock > 0) drawOverlayRipple(base, fx, palette, out, x0, y0, w, rx0, ry0, rx1, ry1);
        t1 = performance.now(); parts.rippleMs += t1 - t0; t0 = t1;

        drawOverlayCaps(state, renderer, base, fx, palette, sea, out, riseMap, x0, y0, w, rx0, ry0, rx1, ry1);
        t1 = performance.now(); parts.capsMs += t1 - t0; t0 = t1;

        if (clock <= 0) drawOverlayStaticDash(base, fx, palette, sea, capCursor, out, riseMap, x0, y0, w, rx0, ry0, rx1, ry1);
        t1 = performance.now(); parts.staticDashMs += t1 - t0; t0 = t1;

        if (causticList) drawOverlayCaustics(base, causticList, shade, palette, out, x0, y0, w, rx0, ry0, rx1, ry1);
        t1 = performance.now(); parts.causticsMs += t1 - t0; t0 = t1;

        if (clock > 0) {
            drawOverlayNear(base, fx, palette, sea, capCursor, out, riseMap, x0, y0, w, rx0, ry0, rx1, ry1);
            t1 = performance.now(); parts.nearMs += t1 - t0; t0 = t1;

            drawOverlayDeep(state, renderer, base, fx, palette, sea, out, riseMap, x0, y0, w, rx0, ry0, rx1, ry1);
            t1 = performance.now(); parts.deepMs += t1 - t0; t0 = t1;
        }

        drawOverlayStarlight(renderer, fx, palette, sea, capCursor, out, riseMap, x0, y0, w, rx0, ry0, rx1, ry1);
        t1 = performance.now(); parts.starlightMs += t1 - t0; t0 = t1;

        if (clock > 0 && fx.stillPaws && sea.gust) drawOverlayStill(base, sea.gust, palette, out, x0, y0, w, rx0, ry0, rx1, ry1);
        t1 = performance.now(); parts.stillMs += t1 - t0; t0 = t1;

        drawOverlaySpecks(base, palette, out, x0, y0, w, rx0, ry0, rx1, ry1);
        t1 = performance.now(); parts.specksMs += t1 - t0; t0 = t1;

        if (fx.rain > 0) drawOverlayRain(base, fx, palette, sea, capCursor, out, x0, y0, w, rx0, ry0, rx1, ry1);
        t1 = performance.now(); parts.rainMs += t1 - t0; t0 = t1;

        drawOverlaySwash(base, palette, collarList, eddyList, swashList, swashBigList, shift, out, mask, glowOut, x0, y0, w, rx0, ry0, rx1, ry1);
        t1 = performance.now(); parts.swashMs += t1 - t0;
    }

    // Upload dirty region(s): coalesce scattered dirty rects into a single
    // upload when >2 rects or union overhead is small to avoid per-call Skia barriers.
    const uploadDirty = (targetLayer, isFull) => {
        if (isFull) {
            targetLayer.ctx.putImageData(targetLayer.image, 0, 0);
            return;
        }
        if (dirtyRects.length === 1) {
            const dr = dirtyRects[0];
            if (dr.x0 < dr.x1 && dr.y0 < dr.y1) {
                if (dr.x0 === x0 && dr.y0 === y0 && dr.x1 === x0 + w && dr.y1 === y0 + h) {
                    targetLayer.ctx.putImageData(targetLayer.image, 0, 0);
                } else {
                    targetLayer.ctx.putImageData(targetLayer.image, 0, 0, dr.x0 - x0, dr.y0 - y0, dr.x1 - dr.x0, dr.y1 - dr.y0);
                }
            }
            return;
        }
        let ux0 = x0 + w, uy0 = y0 + h, ux1 = x0, uy1 = y0;
        for (let d = 0; d < dirtyRects.length; d++) {
            const dr = dirtyRects[d];
            if (dr.x0 >= dr.x1 || dr.y0 >= dr.y1) continue;
            if (dr.x0 < ux0) ux0 = dr.x0;
            if (dr.y0 < uy0) uy0 = dr.y0;
            if (dr.x1 > ux1) ux1 = dr.x1;
            if (dr.y1 > uy1) uy1 = dr.y1;
        }
        if (ux0 >= ux1 || uy0 >= uy1) return;
        const unionArea = (ux1 - ux0) * (uy1 - uy0);
        if (dirtyRects.length > 2 || unionArea <= dirtyArea * 1.6) {
            if (ux0 === x0 && uy0 === y0 && ux1 === x0 + w && uy1 === y0 + h) {
                targetLayer.ctx.putImageData(targetLayer.image, 0, 0);
            } else {
                targetLayer.ctx.putImageData(targetLayer.image, 0, 0, ux0 - x0, uy0 - y0, ux1 - ux0, uy1 - uy0);
            }
            return;
        }
        for (let d = 0; d < dirtyRects.length; d++) {
            const dr = dirtyRects[d];
            if (dr.x0 < dr.x1 && dr.y0 < dr.y1) {
                targetLayer.ctx.putImageData(targetLayer.image, 0, 0, dr.x0 - x0, dr.y0 - y0, dr.x1 - dr.x0, dr.y1 - dr.y0);
            }
        }
    };
    t0 = performance.now();
    if (doGlow) {
        let glowing = false;
        if (boundsIntersect(base.swashBounds, x0, y0, x0 + w, y0 + h)) {
            const gy0 = Math.max(0, base.swashBounds.y0 - y0);
            const gy1 = Math.min(h, base.swashBounds.y1 - y0);
            const gx0 = Math.max(0, base.swashBounds.x0 - x0);
            const gx1 = Math.min(w, base.swashBounds.x1 - x0);
            for (let ly = gy0; ly < gy1 && !glowing; ly++) {
                const row = ly * w;
                for (let lx = gx0; lx < gx1; lx++) {
                    if (glowOut[row + lx]) { glowing = true; break; }
                }
            }
        }
        if (glowing) {
            uploadDirty(glow, glowFull);
            glow.x = x0;
            glow.y = y0;
            state.glowLive = true;
            state.glowValid = true;
        } else {
            state.glowLive = false;
            state.glowValid = false;
        }
    }
    uploadDirty(layer, needFull || allocMask);
    parts.uploadMs = performance.now() - t0;
    layer.x = x0;
    layer.y = y0;
    return dirtyArea;
}

// BI-1 — the most a rect of world px can read from the gust field: the
// largest grid sample its bilinear fetch (`gustAt`) can weigh there.
function gustBound(gust, x, y, w, h) {
    const last = GUST_GRID - 1;
    const i0 = Math.max(0, Math.floor((x + 0.5 - gust.x0) / gust.cellX - 0.5));
    const i1 = Math.min(last, Math.floor((x + w - 0.5 - gust.x0) / gust.cellX - 0.5) + 1);
    const j0 = Math.max(0, Math.floor((y + 0.5 - gust.y0) / gust.cellY - 0.5));
    const j1 = Math.min(last, Math.floor((y + h - 0.5 - gust.y0) / gust.cellY - 0.5) + 1);
    let most = 0;
    for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
            if (gust.data[j * GUST_GRID + i] > most) most = gust.data[j * GUST_GRID + i];
        }
    }
    return most;
}

// ---------------------------------------------------------------------------
// 3.4 — the sea's weather: the gust field (cat's paws) and the sunlit course.

// `Wind.windAt` gusts on a world-locked GUST_GRID^2 grid over the rect
// (texels 2:1, at least 16 x 8 world px), refilled on GUST_STEP_MS steps of
// the motion clock or when the grid moves; null in calm air.
function resolveGust(state, fx, rect, weather) {
    if (!fx.seaWeather || gustinessFor(baseWindX(weather)) <= 0) return null;
    const cellX = Math.max(16, Math.ceil(rect.w / (GUST_GRID - 8) / 8) * 8);
    const cellY = Math.max(cellX / 2, Math.ceil(rect.h / (GUST_GRID - 8) / 4) * 4);
    const gx0 = Math.floor(rect.x0 / cellX) * cellX - cellX * 4;
    const gy0 = Math.floor(rect.y0 / cellY) * cellY - cellY * 4;
    const t = Math.floor(fx.t / GUST_STEP_MS) * GUST_STEP_MS;
    const key = `${gx0},${gy0},${cellX},${cellY},${t},${weather?.windX},${weather?.type},${weather?.seed}`;
    const gust = state.gust ||= { data: new Float32Array(GUST_GRID * GUST_GRID), wind: { x: 0, gust: 0 }, key: '' };
    if (gust.key !== key) {
        for (let j = 0; j < GUST_GRID; j++) {
            const wy = gy0 + (j + 0.5) * cellY;
            for (let i = 0; i < GUST_GRID; i++) {
                gust.data[j * GUST_GRID + i] = Math.round(windAt(gx0 + (i + 0.5) * cellX, wy, t, weather, gust.wind).gust * 255) / 255;
            }
        }
        Object.assign(gust, { key, x0: gx0, y0: gy0, cellX, cellY });
    }
    return gust;
}

// The gust at a world texel: the resident LINEAR fetch (clamped at the
// grid's edge, 0 outside it).
function gustAt(gust, x, y) {
    const u = (x + 0.5 - gust.x0) / gust.cellX;
    const v = (y + 0.5 - gust.y0) / gust.cellY;
    if (u < 0 || v < 0 || u >= GUST_GRID || v >= GUST_GRID) return 0;
    const fu = u - 0.5;
    const fv = v - 0.5;
    const i0 = Math.floor(fu);
    const j0 = Math.floor(fv);
    const tu = fu - i0;
    const tv = fv - j0;
    const last = GUST_GRID - 1;
    const ia = Math.max(0, Math.min(last, i0));
    const ib = Math.max(0, Math.min(last, i0 + 1));
    const ja = Math.max(0, Math.min(last, j0)) * GUST_GRID;
    const jb = Math.max(0, Math.min(last, j0 + 1)) * GUST_GRID;
    const d = gust.data;
    const top = d[ja + ia] + (d[ja + ib] - d[ja + ia]) * tu;
    return top + (d[jb + ia] + (d[jb + ib] - d[jb + ia]) * tu - top) * tv;
}

// Memoize whether a sunlit tile mask is uniformly 1 (e.g., plane clear sky):
// drifting a uniform mask changes no pixel and `destination-in` is a no-op.
const _sunMaskUniform = new WeakMap();
function isUniformOneMask(tile) {
    if (!tile?.mask) return false;
    let cached = _sunMaskUniform.get(tile);
    if (cached !== undefined) return cached;
    const m = tile.mask;
    cached = true;
    for (let i = 0; i < m.length; i++) {
        if (!m[i]) { cached = false; break; }
    }
    _sunMaskUniform.set(tile, cached);
    return cached;
}

// The sunlit course: the field's clearest share while the sun band is up
// and the cloud courses cast (the resident `u_seaSunlit` rule), offset by
// the courses' own drift; null when off.
function resolveSun(renderer, atmosphere, fx) {
    const grade = atmosphere?.lightGrade || {};
    const weather = atmosphere?.weather || {};
    const covered = cloudCoveredShare(clamp01(weather.cloudCover));
    // SEA-1 (look `sea1` > 0) — sunlit water lifts by seaSunLiftStops (never
    // past SEA_SUN_LIFT_FLOOR) everywhere outside the cloud shade, also under
    // a clear sky; the lone cloud casts no gap in it (Canvas lower tier).
    const plane = cloudPlane();
    if (plane.on) {
        // r2 — whole stops on Canvas (its lift layers are cached per stop;
        // the GPU paths dither the fraction in): a declared lower tier.
        const lift = Math.round(seaSunLift(plane.strength, grade, weather, atmosphere?.solar?.elevationDeg));
        if (!fx.seaWeather || lift <= 0) return null;
        const shade = clamp01(grade.cloudShadow) > 0.02 ? covered : 0;
        const tile = cloudSunlitTile(shade);
        const uniform1 = isUniformOneMask(tile);
        const offset = uniform1 ? { x: 0, y: 0 } : cloudCourseOffset(renderer.motionTimeMs, weather, !((renderer.motionScale ?? 1) > 0));
        // The cloud shade sits one stop below the lit water (seaLiftedStop).
        const shadeLift = shade > 0 ? lift - 1 : lift;
        return {
            tile, mask: tile.mask, width: tile.width, height: tile.height, texel: tile.texel, ox: offset.x, oy: offset.y,
            lift, shadeLift, floor: SEA_SUN_LIFT_FLOOR, uniform1,
            key: uniform1 ? `${tile.key}|${lift}|u1` : `${tile.key}|${lift}|${shadeLift}|${offset.x},${offset.y}`,
        };
    }
    if (!fx.seaWeather || clamp01(grade.cloudShadow) <= 0.02 || covered <= 0 || !(clamp01(grade.sunBand) > 0.3)) return null;
    const tile = cloudSunlitTile(covered);
    const uniform1 = isUniformOneMask(tile);
    const offset = uniform1 ? { x: 0, y: 0 } : cloudCourseOffset(renderer.motionTimeMs, weather, !((renderer.motionScale ?? 1) > 0));
    return {
        tile, mask: tile.mask, width: tile.width, height: tile.height, ox: offset.x, oy: offset.y,
        lift: 1, floor: null, uniform1,
        key: uniform1 ? `${tile.key}|u1` : `${tile.key}|${offset.x},${offset.y}`,
    };
}

function releaseChunkCanvas(canvas) {
    if (!canvas) return;
    canvas.width = 0;
    canvas.height = 0;
}

function trimCanvasPool(state, maxPool = SEA_CANVAS_POOL_MAX) {
    const pool = state.canvasPool;
    while (pool && pool.length > maxPool) {
        releaseChunkCanvas(pool.pop());
    }
}

function acquireChunkCanvas(state) {
    const pool = state.canvasPool;
    if (pool && pool.length) {
        const canvas = pool.pop();
        if (canvas.width !== CHUNK_W || canvas.height !== CHUNK_H) {
            canvas.width = CHUNK_W;
            canvas.height = CHUNK_H;
        }
        return canvas;
    }
    const canvas = document.createElement('canvas');
    canvas.width = CHUNK_W;
    canvas.height = CHUNK_H;
    return canvas;
}

function recycleChunkCanvases(state, chunk, maxPool = SEA_CANVAS_POOL_MAX) {
    const pool = state.canvasPool;
    for (const name of ['bodyCanvas', 'liftCanvas', 'shadeCanvas']) {
        const c = chunk[name];
        if (c) {
            chunk[name] = null;
            if (pool && pool.length < maxPool) pool.push(c);
            else releaseChunkCanvas(c);
        }
    }
    chunk.bodyKey = '';
    chunk.liftKey = '';
    chunk.shadeKey = '';
}

function fillLiftLut(outLut, colorTable, baseOff, steps, floor) {
    outLut.fill(0);
    const nonOpenEff = floor != null ? Math.max(0, steps - 1) : 0;
    for (let s = 0; s < 7; s++) {
        if (nonOpenEff > 0) {
            const stop = floor != null ? Math.max(s - nonOpenEff, Math.min(s, floor)) : (s > 0 ? s - 1 : 0);
            outLut[s] = colorTable[baseOff + stop];
        }
        if (steps > 0) {
            const stop = floor != null ? Math.max(s - steps, Math.min(s, floor)) : (s > 0 ? s - 1 : 0);
            outLut[s | SEA_OPEN] = colorTable[baseOff + stop];
        }
    }
}

// 3.3 (a) / 3.4 — a cap chunk's sea layer, cached per palette and ocean
// bake (`key`): `body` paints the open texels the body field moves off the
// stop the terrain or the ocean strip painted, at their body stop; `lift`
// paints every open texel one stop lighter than its body stop (the sunlit
// course's colours). An open-sea texel in the horizon strip takes its band
// and haze course (`canvasSeaMarkRgb`). Null when the chunk has nothing to
// paint.
function chunkSeaCanvas(state, chunk, cx, cy, palette, key, renderer, lift) {
    if (!lift && !chunk.body.length) return null;
    // SEA-1 — the cloud shade's lift (one stop below the lit water) keeps its
    // own cached layer beside the lit one (`lift.slot`).
    const name = lift ? (lift.slot === 'shade' ? 'shadeCanvas' : 'liftCanvas') : 'bodyCanvas';
    const keyName = lift ? (lift.slot === 'shade' ? 'shadeKey' : 'liftKey') : 'bodyKey';
    if (chunk[keyName] === key) return chunk[name];
    const started = performance.now();
    const scratch = state.chunkScratch ||= (() => {
        const image = new ImageData(CHUNK_W, CHUNK_H);
        return { image, u32: new Uint32Array(image.data.buffer) };
    })();
    const { u32 } = scratch;
    u32.fill(0);
    const { info } = chunk;
    const X0 = cx * CHUNK_W;
    const Y0 = cy * CHUNK_H;
    const stripEnd = state.seaLutStripEnd;
    const bandEnd = state.seaLutBandEnd;
    const hasFresnel = state.seaLutFresnel;
    const lut = state.seaLut;
    const stops = palette.stops;
    const base = state.base;
    const belowStrip = Y0 >= stripEnd;

    if (lift) {
        const steps = lift.lift ?? 1;
        const floor = lift.floor ?? null;
        fillLiftLut(_rowStopsLiftLut, stops, 0, steps, floor);
        if (belowStrip) {
            for (let idx = 0; idx < info.length; idx++) {
                u32[idx] = _rowStopsLiftLut[info[idx] & 15];
            }
        } else {
            const { bx, by, tw, th, fx: fieldX, fy: fieldY, cols, rows, coastField } = base;
            const chunkOutOfTerrainX = X0 + CHUNK_W <= bx || X0 >= bx + tw;
            let loadedCourse = -2;
            let loadedSeamBand = -1;
            const nonOpenEff = floor != null ? Math.max(0, steps - 1) : 0;
            for (let ly = 0; ly < CHUNK_H; ly++) {
                const y = Y0 + ly;
                const rowOff = ly * CHUNK_W;
                if (y >= stripEnd) {
                    for (let lx = 0; lx < CHUNK_W; lx++) u32[rowOff + lx] = _rowStopsLiftLut[info[rowOff + lx] & 15];
                    continue;
                }
                const rowOutOfTerrain = chunkOutOfTerrainX || y < by || y >= by + th;
                const inBand = y < bandEnd;
                const rk = hasFresnel ? fresnelRowKind(y) : 3;
                if (!inBand && rk >= 0) {
                    if (loadedCourse !== rk) {
                        fillLiftLut(_rowLiftLut, lut, rk * 7, steps, floor);
                        loadedCourse = rk;
                    }
                    if (rowOutOfTerrain) {
                        for (let lx = 0; lx < CHUNK_W; lx++) u32[rowOff + lx] = _rowLiftLut[info[rowOff + lx] & 15];
                    } else if (!hasFresnel) {
                        for (let lx = 0; lx < CHUNK_W; lx++) {
                            const v = info[rowOff + lx];
                            u32[rowOff + lx] = (v & SEA_OPEN_SEA) ? _rowLiftLut[v & 15] : _rowStopsLiftLut[v & 15];
                        }
                    } else {
                        const fr = Math.floor((y - fieldY) / 2);
                        const inFr = fr >= 0 && fr < rows;
                        const fRow = fr * cols;
                        for (let lx = 0; lx < CHUNK_W; lx++) {
                            const v = info[rowOff + lx];
                            const v15 = v & 15;
                            if (v & SEA_OPEN_SEA) {
                                u32[rowOff + lx] = _rowLiftLut[v15];
                            } else if (_rowStopsLiftLut[v15]) {
                                const fc = Math.floor((X0 + lx - fieldX) / 2);
                                const isSea = inFr && fc >= 0 && fc < cols && (coastField[(fRow + fc) * 2 + 1] & COAST_FIELD_FLAGS.sea) !== 0;
                                u32[rowOff + lx] = isSea ? _rowLiftLut[v15] : _rowStopsLiftLut[v15];
                            }
                        }
                    }
                    continue;
                }
                if (!inBand && rk < 0) {
                    const bandIdx = -rk - 1;
                    if (loadedSeamBand !== bandIdx) {
                        const seamBand = SEA_FRESNEL_BANDS[bandIdx];
                        for (let lx = 0; lx < CHUNK_W; lx++) _chunkFresnelBend[lx] = seaBandBend(X0 + lx, seamBand);
                        loadedSeamBand = bandIdx;
                    }
                    const dist = y - SEA_FRESNEL_Y[bandIdx];
                    const bayerRow = (y & 3) << 2;
                    const c0Base = bandIdx * 7;
                    const c1Base = (bandIdx + 1) * 7;
                    const fr = Math.floor((y - fieldY) / 2);
                    const inFr = !rowOutOfTerrain && fr >= 0 && fr < rows;
                    const fRow = fr * cols;
                    for (let lx = 0; lx < CHUNK_W; lx++) {
                        const v = info[rowOff + lx];
                        const s = v & 7;
                        if (s === SEA_NONE) continue;
                        const eff = (v & SEA_OPEN) ? steps : nonOpenEff;
                        if (eff <= 0) continue;
                        const stop = floor != null ? Math.max(s - eff, Math.min(s, floor)) : (s > 0 ? s - 1 : 0);
                        const outside = (v & SEA_OPEN_SEA) !== 0;
                        if (!outside) {
                            const fc = Math.floor((X0 + lx - fieldX) / 2);
                            if (!inFr || fc < 0 || fc >= cols || !(coastField[(fRow + fc) * 2 + 1] & COAST_FIELD_FLAGS.sea)) {
                                u32[rowOff + lx] = stops[stop];
                                continue;
                            }
                        }
                        const courseBase = ((dist - _chunkFresnelBend[lx] + 2) << 2) <= CB_BAYER4[bayerRow | ((X0 + lx) & 3)] ? c0Base : c1Base;
                        u32[rowOff + lx] = lut[courseBase + stop];
                    }
                    continue;
                }
                // Horizon band (`y < bandEnd`, top ~160 rows): full `swellColour` for outside texels.
                const fr = Math.floor((y - fieldY) / 2);
                const inFr = hasFresnel && !rowOutOfTerrain && fr >= 0 && fr < rows;
                const fRow = fr * cols;
                for (let lx = 0; lx < CHUNK_W; lx++) {
                    const v = info[rowOff + lx];
                    const s = v & 7;
                    if (s === SEA_NONE) continue;
                    const eff = (v & SEA_OPEN) ? steps : nonOpenEff;
                    if (eff <= 0) continue;
                    const stop = floor != null ? Math.max(s - eff, Math.min(s, floor)) : (s > 0 ? s - 1 : 0);
                    if (v & SEA_OPEN_SEA) {
                        u32[rowOff + lx] = swellColour(renderer, base, palette, v, stop, X0 + lx, y, false);
                    } else if (!hasFresnel) {
                        u32[rowOff + lx] = stops[stop];
                    } else {
                        const fc = Math.floor((X0 + lx - fieldX) / 2);
                        if (inFr && fc >= 0 && fc < cols && (coastField[(fRow + fc) * 2 + 1] & COAST_FIELD_FLAGS.sea)) {
                            const course = fresnelCourseAtPoint(X0 + lx, y, rk);
                            u32[rowOff + lx] = lut[course * 7 + stop];
                        } else {
                            u32[rowOff + lx] = stops[stop];
                        }
                    }
                }
            }
        }
    } else if (belowStrip) {
        const body = chunk.body;
        for (let k = 0; k < body.length; k++) {
            const idx = body[k];
            u32[idx] = stops[info[idx] & 7];
        }
    } else {
        const body = chunk.body;
        const { fx: fieldX, fy: fieldY, cols, rows, coastField } = base;
        for (let k = 0; k < body.length; k++) {
            const idx = body[k];
            const v = info[idx];
            const stop = v & 7;
            const ly = (idx / CHUNK_W) | 0;
            const y = Y0 + ly;
            if (y >= stripEnd) {
                u32[idx] = stops[stop];
            } else if (!(v & SEA_OPEN_SEA)) {
                if (!hasFresnel) {
                    u32[idx] = stops[stop];
                } else {
                    const x = X0 + idx - ly * CHUNK_W;
                    const fc = Math.floor((x - fieldX) / 2);
                    const fr = Math.floor((y - fieldY) / 2);
                    if (fc >= 0 && fr >= 0 && fc < cols && fr < rows && (coastField[(fr * cols + fc) * 2 + 1] & COAST_FIELD_FLAGS.sea)) {
                        u32[idx] = lut[fresnelCourseAtPoint(x, y, fresnelRowKind(y)) * 7 + stop];
                    } else {
                        u32[idx] = stops[stop];
                    }
                }
            } else if (y >= bandEnd) {
                const course = hasFresnel ? fresnelCourseAtPoint(X0 + idx - ly * CHUNK_W, y, fresnelRowKind(y)) : 3;
                u32[idx] = lut[course * 7 + stop];
            } else {
                u32[idx] = swellColour(renderer, base, palette, v, stop, X0 + idx - ly * CHUNK_W, y, false);
            }
        }
    }
    if (!chunk[name]) chunk[name] = acquireChunkCanvas(state);
    chunk[name].getContext('2d').putImageData(scratch.image, 0, 0);
    chunk[keyName] = key;
    state.seaCanvasChunks.add(chunk);
    state.stats.seaCanvasMs = performance.now() - started;
    state.stats.seaCanvasBuilds++;
    return chunk[name];
}

// The sunlit course over the rect: every visible chunk's open texels one
// stop lighter (`chunkSeaCanvas` lift), masked by the drifting sunlit tile.
function rebuildSun(state, renderer, rect, sun, palette, key) {
    const { x0, y0, w, h } = rect;
    const layer = state.sun;
    if (!layer.canvas || layer.canvas.width !== w || layer.canvas.height !== h) {
        layer.canvas ||= document.createElement('canvas');
        layer.canvas.width = w;
        layer.canvas.height = h;
        layer.ctx = layer.canvas.getContext('2d');
    }
    const c = layer.ctx;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.globalCompositeOperation = 'source-over';
    c.clearRect(0, 0, w, h);
    c.imageSmoothingEnabled = false;
    c.setTransform(1, 0, 0, 1, -x0, -y0);
    const liftKey = sun.floor != null ? `${key}|lift${sun.lift}` : key;
    for (let cy = Math.floor(y0 / CHUNK_H); cy * CHUNK_H < y0 + h; cy++) {
        for (let cx = Math.floor(x0 / CHUNK_W); cx * CHUNK_W < x0 + w; cx++) {
            const chunk = state.caps.get(chunkId(cx, cy));
            if (chunk && !chunk.driftFree) c.drawImage(chunkSeaCanvas(state, chunk, cx, cy, palette, liftKey, renderer, sun), cx * CHUNK_W, cy * CHUNK_H);
        }
    }
    if (!sun.uniform1) {
        const t = sun.texel || 1;
        const pattern = c.createPattern(sun.tile.canvas, 'repeat');
        pattern?.setTransform?.(new DOMMatrix([t, 0, 0, t, -sun.ox, -sun.oy]));
        c.globalCompositeOperation = 'destination-in';
        c.fillStyle = pattern;
        c.fillRect(x0, y0, w, h);
        // SEA-1 — under the lit layer, the shade's own lift (one stop less).
        if (sun.shadeLift > 0) {
            c.globalCompositeOperation = 'destination-over';
            const shade = { lift: sun.shadeLift, floor: sun.floor, slot: 'shade' };
            const shadeKey = `${key}|lift${sun.shadeLift}`;
            for (let cy = Math.floor(y0 / CHUNK_H); cy * CHUNK_H < y0 + h; cy++) {
                for (let cx = Math.floor(x0 / CHUNK_W); cx * CHUNK_W < x0 + w; cx++) {
                    const chunk = state.caps.get(chunkId(cx, cy));
                    if (chunk && !chunk.driftFree) c.drawImage(chunkSeaCanvas(state, chunk, cx, cy, palette, shadeKey, renderer, shade), cx * CHUNK_W, cy * CHUNK_H);
                }
            }
        }
    }
    c.globalCompositeOperation = 'source-over';
    layer.x = x0;
    layer.y = y0;
}

// 3.2 — the sun/moon path (glintDash), screen-anchored: its x is the sky
// body's screen x, its half-width grows down the frame. Only water texels
// (in-map stop <= 5 not masked by swash/foam, or open sea below horizonTop) take it.
function rebuildPath(state, base, fx, palette, view, glint) {
    const moon = glint.kind === 3;
    const baseWidth = glint.kind === 2 ? GLINT_NOON_BASE : 5;
    const grow = (glint.kind === 2 ? 0.12 * NOON_GLINT_GROW_GAIN : 0.12) * (glint.growScale ?? 1);
    const gx = view.x0 + clamp01(glint.body?.xFrac ?? 0.5) * (view.x1 - view.x0);
    const top = Math.max(Math.floor(view.y0), fx.horizonTop);
    const bottom = Math.ceil(view.y1);
    if (bottom <= top) return false;
    // NE P3.3 — wider moon road, denser dashes, and bright silver stop.
    const maxHalf = (baseWidth + (bottom - view.y0) * grow) * (moon ? 0.95 : 1);
    const px0 = Math.floor(gx - maxHalf) - 6;
    const pw = Math.ceil(maxHalf * 2) + 12;
    const layer = layerCanvas(state.path, pw, bottom - top);
    const out = layer.u32;
    const lo = palette.path[(glint.kind - 1) * 2];
    const hi = palette.path[(glint.kind - 1) * 2 + 1];
    const tick = fx.deepTick;
    const width = moon ? 6 : 3;
    // The pale day path thins past NOON_GLINT_FULL_TEXEL backing px a texel,
    // so a close zoom shows single glints, not a field of dashes.
    const density = moon
        ? 0.28
        : GLINT_DASH_DENSITY * (glint.kind === 2 ? Math.min(1, NOON_GLINT_FULL_TEXEL / Math.max(view.texelPx, 1e-3)) : 1);
    const thresh = density * glint.strength;
    const pale = glint.kind === 2;
    const { bx, by, tw, th, cls } = base;
    const mask = state.mask;
    const o = state.overlay;
    const ox = o?.x ?? 0;
    const oy = o?.y ?? 0;
    const ow = o?.canvas?.width || 0;
    const oh = o?.canvas?.height || 0;
    for (let y = top; y < bottom; y++) {
        const half = (baseWidth + (y + 0.5 - view.y0) * grow) * (moon ? 0.95 : 1);
        const c0 = Math.floor((gx - half) / width);
        const c1 = Math.floor((gx + half) / width);
        const ty = y - by;
        const inTerrainY = ty >= 0 && ty < th;
        const tRow = ty * tw;
        const inOverlayY = Boolean(mask && y >= oy && y < oy + oh);
        const mRow = (y - oy) * ow - ox;
        const outRow = (y - top) * pw - px0;
        for (let cx = c0; cx <= c1; cx++) {
            const xStart = cx * width;
            // Exact upper bound on `weight` across `[xStart, xStart + width - 1]`.
            let maxW = 1;
            if (xStart + width - 0.5 < gx) maxW = 1 - (gx - (xStart + width - 0.5)) / half;
            else if (xStart + 0.5 > gx) maxW = 1 - (xStart + 0.5 - gx) / half;
            if (maxW <= 0) continue;
            let life = 0;
            let glintTick = tick;
            let rollSun = 0;
            let rollMoon = 0;
            if (moon) {
                life = Math.floor((tick + Math.floor(hash12(cx + 37, y + 5) * MOON_DASH_HOLD)) / MOON_DASH_HOLD);
                rollMoon = hash12(cx + life * 5, y + life * 2);
                if (rollMoon >= thresh * maxW) continue;
            } else {
                glintTick = pale
                    ? Math.floor((tick + Math.floor(hash12(cx + 37, y + 5) * NOON_DASH_HOLD)) / NOON_DASH_HOLD)
                    : tick;
                rollSun = hash12(cx + glintTick * 7, y + glintTick * 3);
                if (rollSun >= thresh * maxW) continue;
            }
            const tone = moon ? hash12(cx + 5, y + life * 11) : hash12(cx + 5, y + glintTick * 11);
            for (let x = xStart; x < xStart + width; x++) {
                const weight = 1 - Math.abs(x + 0.5 - gx) / half;
                if (weight <= 0) continue;
                let colour;
                if (moon) {
                    if (rollMoon >= density * glint.strength * Math.pow(weight, 1.25)) continue;
                    colour = tone < weight * 0.85 ? hi : lo;
                } else {
                    if (rollSun >= density * glint.strength * weight) continue;
                    colour = tone < weight ? hi : lo;
                }
                if (inTerrainY) {
                    const tx = x - bx;
                    if (tx >= 0 && tx < tw) {
                        const k = cls[tRow + tx];
                        if (k !== CLS_EMPTY) {
                            if (k > 5) continue;
                            if (inOverlayY && x >= ox && x < ox + ow && mask[mRow + x]) continue;
                        }
                    }
                }
                out[outRow + x] = colour;
            }
        }
    }
    layer.ctx.putImageData(layer.image, 0, 0);
    layer.x = px0;
    layer.y = top;
    return true;
}

// ---------------------------------------------------------------------------
// 2.9 — the lamp columns on the water (the resident light loop's column).

const DEFAULT_COLUMN_RGB = [1, 0.78, 0.42];
const _rgbCache = new Map();
function lightRgb01(color) {
    const key = String(color || '');
    let rgb = _rgbCache.get(key);
    if (rgb) return rgb;
    rgb = DEFAULT_COLUMN_RGB;
    if (/^#[0-9a-f]{6}$/i.test(key)) {
        rgb = hexRgb01(key);
    } else {
        const match = key.match(/(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)/);
        if (match) rgb = [clamp01(match[1] / 255), clamp01(match[2] / 255), clamp01(match[3] / 255)];
    }
    if (_rgbCache.size >= 128) _rgbCache.clear();
    _rgbCache.set(key, rgb);
    return rgb;
}

// The frame's column-laying lights, as the resident feed admits them: every
// aperture and fixture (never an attention or omni light) by its foot, the
// Lighthouse lamp's water-only column from its mirror point (its height
// below the foot) at its reach, and the prop lanterns (fixtures on their
// tile, lit by the beacon); none while daylight suppresses the lamps. Each
// carries its energy (intensity x envelope share, the resident record's
// w x colour alpha), its hue weighted by that energy and what the footprint
// march reads (its foot, height, landmark id and whether it is a fixture).
function columnLights(renderer, atmosphere) {
    const lighting = atmosphere?.lighting || null;
    if (localLightPhaseForLighting(lighting) <= 0.04) return [];
    const spill = Math.max(0, Math.min(2, Number(sourceEnergyFor(lighting).spill ?? 1) || 0));
    const beacon = clamp01(lighting?.beaconIntensity);
    const out = [];
    const add = (footX, footY, height, waterOnly, radius, columnReach, rgb, intensity, share, landmark, fixture) => {
        const energy = Math.max(0, Math.min(3, intensity)) * share;
        if (!Number.isFinite(footX) || !Number.isFinite(footY) || !(energy > 0)) return;
        const r = Math.max(1, radius);
        out.push({
            x: footX,
            y: footY + (waterOnly ? height : 0),
            footY,
            height,
            landmark,
            fixture,
            reach: r * WATER_COLUMN_REACH * Math.max(1, columnReach),
            halfNear: 2 + Math.floor(r / 32),
            energy,
            rgb: [rgb[0] * energy, rgb[1] * energy, rgb[2] * energy],
        });
    };
    const sources = renderer._frameLightSources?.ambient || renderer._frameLightSources?.building || [];
    const lamp = renderer.buildingRenderer?.lighthouseColumnSource?.() || null;
    for (const src of lamp ? [...sources, lamp] : sources) {
        if (!src) continue;
        const role = LIGHT_ROLE_CODES[src.role] ?? (src.attention ? LIGHT_ROLE_CODES.attention : LIGHT_ROLE_CODES.point);
        if (src.waterOnly !== true && !lightLaysColumn({ id: src.id, attention: src.attention, role })) continue;
        if (isAttentionLight(src)) continue;
        const wx = Number(src.x ?? src.origin?.x);
        const wy = Number(src.y ?? src.origin?.y);
        add(Number(src.ground?.x ?? wx), Number(src.ground?.y ?? wy), Math.max(0, Number(src.height) || 0),
            src.waterOnly === true, Number(src.radius ?? 64) || 0, Number(src.columnReach) || 1,
            lightRgb01(src.color), Number(src.intensity ?? 1) || 0, spill,
            Math.max(0, Math.round(Number(src.landmarkId) || 0)), role === LIGHT_ROLE_CODES.fixture);
    }
    // D4 — only the lamps already caught on the Lamplighter's Round.
    const lanterns = (renderer._litLanternGlowSources || renderer._lanternGlowSources)?.call(renderer) || [];
    const zoom = Math.max(1e-6, Number(renderer.camera?.zoom) || 1);
    const lanternRadius = Math.max(9, Math.round(14 * zoom)) / zoom;
    for (const src of lanterns) {
        if (!src) continue;
        add(Number(src.x), Number(src.y) + 10, src.fixture === 'brazier' ? 16 : 24, false, lanternRadius, 1,
            LANTERN_COLUMN_RGB, 1, beacon * spill, 0, true);
    }
    return out;
}

// SCENE_FRAGMENT `footprintBlocked` for a column texel (ground point rx, ry,
// height 0; never its own landmark): the segment to the light's foot marched
// in `steps` samples through the 2.2 footprint field while the ray rises to
// the light's height; a sample on the light's landmark or within 10 px of a
// fixture's foot never blocks, and the samples still inside a housing the
// foot stands in are skipped.
function columnBlocked(field, steps, rx, ry, light, homeHoused) {
    const { originX, originY, cell, width, height, data } = field;
    const lx = light.x;
    const lfy = light.footY;
    const lh = light.height;
    const lmk = light.landmark;
    const isFix = light.fixture;
    const dxr = lx - rx;
    const dyr = lfy - ry;
    let housed = homeHoused;
    const denominator = steps + 1;
    for (let k = 0; k < steps; k++) {
        const t = (steps - k) / denominator;
        const px = rx + dxr * t;
        const py = ry + dyr * t;
        if (isFix) {
            const dx = px - lx;
            const dy = py - lfy;
            const sq = dx * dx + dy * dy;
            if (sq < 100 - 1e-9 || (sq <= 100 + 1e-9 && Math.hypot(dx, dy) < 10)) continue;
        }
        const cx = Math.floor((px - originX) / cell);
        const cy = Math.floor((py - originY) / cell);
        const j = cx < 0 || cy < 0 || cx >= width || cy >= height ? -1 : (cy * width + cx) * 2;
        const landmark = j >= 0 ? data[j + 1] : 0;
        const occupied = j >= 0 && !(landmark !== 0 && landmark === lmk) && data[j] > lh * t + 2;
        if (housed) {
            housed = occupied;
            continue;
        }
        if (occupied) return true;
    }
    return false;
}

function columnLightEligible(base, rect, light) {
    const footX = Math.floor(light.x);
    const span = light.halfNear + 4;
    const xStart = Math.max(rect.x0, footX - span);
    const xEnd = Math.min(rect.x0 + rect.w, footX + span + 1);
    if (xStart >= xEnd) return false;
    const yStart = Math.max(rect.y0, Math.ceil(light.y - 0.5));
    const yEnd = Math.min(rect.y0 + rect.h, Math.ceil(light.y - 0.5 + light.reach));
    if (yStart >= yEnd) return false;
    if (!boundsIntersect(base.recvBounds, xStart, yStart, xEnd, yEnd)) return false;
    return coarseGridIntersects(base.recvGrid, xStart, yStart, xEnd, yEnd);
}

// The terrain colour (0xRRGGBB) of a column-receiving texel that is no
// water class (base.recvIdx / recvRgb), or -1.
function receiverRgb(base, i) {
    const idx = base.recvIdx;
    let lo = 0;
    let hi = idx.length - 1;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (idx[mid] === i) return base.recvRgb[mid];
        if (idx[mid] < i) lo = mid + 1;
        else hi = mid - 1;
    }
    return -1;
}

// SCENE_FRAGMENT `columnRampLuma`: the luma `lift` stops above water stop
// `stop` on the water ramp (the depth stops, then foam and its crest).
const COLUMN_RAMP = [COAST_PALETTE.foamCrest, COAST_PALETTE.foam, ...COAST_PALETTE.stops]
    .map(rgb => (rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722) / 255);
function columnRampLuma(stop, lift) {
    return COLUMN_RAMP[Math.max(0, stop + 2 - lift)];
}

// SCENE_FRAGMENT `waterStopForSd`: the stop a signed distance (tiles) bakes
// to, ignoring the river/lagoon caps and the boundary dither.
function waterStopForSd(sd) {
    return (sd >= DEPTH_BOUNDS[0]) + (sd >= DEPTH_BOUNDS[1]) + (sd >= DEPTH_BOUNDS[2]) + (sd >= DEPTH_BOUNDS[3]);
}

function columnHash(pixel) {
    const hash = Math.imul(pixel, 2654435761);
    return (hash >>> 16) | (hash << 16);
}

// Each light lays its broken column (columnLift) from its start toward the
// camera on column-receiving terrain texels, as the resident `columnReceiver`
// (coast flag `water` and not `covered`: baked mirrors included, never a
// dock, deck, bridge span or foundation over the water), clipped by the
// footprint march (`field`, `fx.march` steps) so it never crosses a
// building. A texel keeps its strongest lift and the lights' energy-weighted
// hue, and lands once on its graded colour (`landWaterColumn`, its local
// stop from the coast field's signed distance). The layer holds that graded
// landing itself, cropped to the lit texels: the frame grade cannot reach a
// night amber from any ungraded colour (its preimage clips and turns lime),
// so `drawCanvasWaterColumns` lays it after the grade, on the ungraded
// overlay.
function rebuildColumns(state, base, fx, palette, rect, lights, grade, postFx, field) {
    const rb = base.recvBounds;
    if (!hasBounds(rb)) {
        state.columnForceFull = true;
        state.columnPixels.length = 0;
        state.columns.contentBounds = null;
        return false;
    }
    const colX0 = Math.max(rect.x0, rb.x0);
    const colY0 = Math.max(rect.y0, rb.y0);
    const colX1 = Math.min(rect.x0 + rect.w, rb.x1);
    const colY1 = Math.min(rect.y0 + rect.h, rb.y1);
    if (colX0 >= colX1 || colY0 >= colY1) {
        state.columnForceFull = true;
        state.columnPixels.length = 0;
        state.columns.contentBounds = null;
        return false;
    }
    const colW = colX1 - colX0;
    const colH = colY1 - colY0;

    // Reusable open-addressed generational hash table for lit column texels
    // (O(1) clear per build, ~8x faster than JS Map for 10k-30k integer keys).
    let htCap = state.columnHtCap || 32768;
    let htMask = htCap - 1;
    let htKey = state.columnHtKey || (state.columnHtKey = new Int32Array(htCap));
    let htVal = state.columnHtVal || (state.columnHtVal = new Int32Array(htCap));
    let htGen = state.columnHtGen || (state.columnHtGen = new Uint32Array(htCap));
    state.columnHtCap = htCap;
    let gen = ((state.columnHtGenId || 0) + 1) >>> 0;
    if (gen === 0) {
        htGen.fill(0);
        gen = 1;
    }
    state.columnHtGenId = gen;
    const accP = state.columnAccP;
    const accR = state.columnAccR;
    const accG = state.columnAccG;
    const accB = state.columnAccB;
    const accLift = state.columnAccLift;
    const accBaseI = state.columnAccBaseI;
    const accSd = state.columnAccSd;
    let accCount = 0;

    const growHt = () => {
        const nextCap = htCap << 1;
        const nextMask = nextCap - 1;
        const nextKey = new Int32Array(nextCap);
        const nextVal = new Int32Array(nextCap);
        const nextGen = new Uint32Array(nextCap);
        for (let i = 0; i < accCount; i++) {
            const k = accP[i];
            let h = columnHash(k) & nextMask;
            while (nextGen[h] === gen) h = (h + 1) & nextMask;
            nextGen[h] = gen;
            nextKey[h] = k;
            nextVal[h] = i;
        }
        htCap = state.columnHtCap = nextCap;
        htMask = nextMask;
        htKey = state.columnHtKey = nextKey;
        htVal = state.columnHtVal = nextVal;
        htGen = state.columnHtGen = nextGen;
    };

    const tick = fx.columnTick;
    const steps = field ? fx.march : 0;
    const { cls, coastField, cols, rows, fx: fieldX, fy: fieldY, bx, by, tw, th, recvGrid } = base;
    const rBits = recvGrid.bits;
    const rCols = recvGrid.cols;
    const rRows = recvGrid.rows;
    const rGx0 = recvGrid.gx0;
    const rGy0 = recvGrid.gy0;

    // Flickering lamps can change between the water's 4 Hz ticks. Reuse the
    // other lamps' footprints while the terrain, shadow field and view match.
    const lightCacheScope = `${base.key}|${tick}|${steps}:${field?.revision ?? 0}|${colX0},${colY0},${colW},${colH}`;
    let lightCache = state.columnLightCache;
    if (!lightCache || state.columnLightCacheScope !== lightCacheScope) {
        if (!lightCache) lightCache = state.columnLightCache = new Map();
        else lightCache.clear();
        state.columnLightCacheScope = lightCacheScope;
    }

    for (let li = 0; li < lights.length; li++) {
        const light = lights[li];
        const lrgb0 = light.rgb[0];
        const lrgb1 = light.rgb[1];
        const lrgb2 = light.rgb[2];
        const lk = `${light.x},${light.y},${light.footY},${light.height},${light.reach},${light.halfNear},${light.energy},${light.landmark},${light.fixture ? 1 : 0}`;
        const cached = lightCache.get(lk);
        if (cached) {
            const cp = cached.p;
            const cl = cached.lift;
            const cb = cached.baseI;
            const cs = cached.sd;
            for (let k = 0; k < cp.length; k++) {
                const p = cp[k];
                const lift = cl[k];
                if ((accCount << 1) >= htCap) growHt();
                let h = columnHash(p) & htMask;
                while (htGen[h] === gen && htKey[h] !== p) h = (h + 1) & htMask;
                if (htGen[h] !== gen) {
                    const slot = accCount++;
                    htGen[h] = gen;
                    htKey[h] = p;
                    htVal[h] = slot;
                    accP[slot] = p;
                    accR[slot] = lrgb0;
                    accG[slot] = lrgb1;
                    accB[slot] = lrgb2;
                    accLift[slot] = lift;
                    accBaseI[slot] = cb[k];
                    accSd[slot] = cs[k];
                } else {
                    const slot = htVal[h];
                    accR[slot] += lrgb0;
                    accG[slot] += lrgb1;
                    accB[slot] += lrgb2;
                    if (lift > accLift[slot]) accLift[slot] = lift;
                }
            }
            continue;
        }
        const footX = Math.floor(light.x);
        const yEnd = Math.min(colY1, Math.ceil(light.y - 0.5 + light.reach));
        const span = light.halfNear + 4;
        const from = Math.max(colX0, footX - span);
        const to = Math.min(colX1 - 1, footX + span);
        if (from > to) continue;
        const yStart = Math.max(colY0, Math.ceil(light.y - 0.5));
        if (yStart >= yEnd) continue;
        const reach = light.reach;
        const energy = light.energy;
        const halfNear = light.halfNear;
        const oneMinusHalfNear = 1 - halfNear;
        let homeHoused = false;
        if (steps > 0) {
            const hcx = Math.floor((light.x - field.originX) / field.cell);
            const hcy = Math.floor((light.footY - field.originY) / field.cell);
            if (hcx >= 0 && hcy >= 0 && hcx < field.width && hcy < field.height) {
                homeHoused = field.data[(hcy * field.width + hcx) * 2] > light.height + 2;
            }
        }
        const gc0 = Math.max(0, (from - rGx0) >> 4);
        const gc1 = Math.min(rCols - 1, (to - rGx0) >> 4);
        if (gc0 > gc1) continue;
        const capP = [];
        const capL = [];
        const capB = [];
        const capS = [];
        let lastGr = -1;
        let bandHasRecv = false;
        for (let y = yStart; y < yEnd; y++) {
            const gr = (y - rGy0) >> 3;
            if (gr !== lastGr) {
                lastGr = gr;
                bandHasRecv = false;
                if (gr >= 0 && gr < rRows) {
                    const rowBit = gr * rCols;
                    for (let c = gc0; c <= gc1; c++) {
                        const bit = rowBit + c;
                        if (rBits[bit >> 3] & (1 << (bit & 7))) { bandHasRecv = true; break; }
                    }
                }
            }
            if (!bandHasRecv) {
                // Skip all remaining rows in this dry 8-row coarse band.
                y = rGy0 + ((gr + 1) << 3) - 1;
                continue;
            }
            const r = Math.floor((y - fieldY) / 2);
            if (r < 0 || r >= rows) continue;
            const ty = y - by;
            if (ty < 0 || ty >= th) continue;
            const along = y + 0.5 - light.y;
            if (along < 0 || along >= reach) continue;
            // Hoist all row-invariant `columnLift` hashes & bounds out of the x loop.
            const t = along / reach;
            const life = Math.floor((tick + Math.floor(hash12f(y + 3, footX + 17) * WATER_COLUMN_ROW_HOLD)) / WATER_COLUMN_ROW_HOLD);
            const present = WATER_COLUMN_ROW_NEAR + (WATER_COLUMN_ROW_FAR - WATER_COLUMN_ROW_NEAR) * t;
            if (hash12f(y + life * 7 + 11, footX + life * 3 + 29) >= present) continue;
            const q = (0.8 - 0.5 * t) * energy + (hash12f(y + life * 19 + 71, footX + 31) - 0.5) * 0.3;
            const baseLift = q >= 0.12 ? 1 + (q >= 0.35) + (q >= 0.75) + (q >= 1.15) : 0;
            if (baseLift === 0) continue;
            const wobble = Math.floor(1.5 * Math.sin(y * 0.7 + tick));
            const halfWidth = Math.floor(halfNear + oneMinusHalfNear * t + 0.5);
            const lo = -Math.max(0, halfWidth + Math.floor(hash12f(y + life * 5 + 41, footX + 13) * 3) - 1);
            const hi = Math.max(0, halfWidth + Math.floor(hash12f(y + life * 13 + 47, footX + 19) * 3) - 1);
            const xFrom = Math.max(from, footX + wobble + lo);
            const xTo = Math.min(to, footX + wobble + hi);
            if (xFrom > xTo) continue;
            const spark = hash12f(y + life * 17 + 61, footX + 23);
            const sparkSkip = hi - lo >= 4 && spark < 0.55 ? (spark < 0.275 ? lo + 1 : hi - 1) : 1e9;
            const mid = 0.5 * (lo + hi);
            const glintAdd = t < 0.5 && hash12f(y + life * 11 + 53, footX + 7) < WATER_COLUMN_GLINT ? 1 : 0;
            const tRow = ty * tw;
            const fRow = r * cols;
            const pRow = (y - colY0) * colW - colX0;
            for (let x = xFrom; x <= xTo; x++) {
                const dx = x - footX - wobble;
                if (dx === sparkSkip) continue;
                let lift;
                if (hi > lo && (dx === lo || dx === hi)) {
                    lift = baseLift - 1;
                    if (lift === 0) continue;
                } else {
                    lift = baseLift + (Math.abs(dx - mid) < 0.75 ? 1 : 0) + glintAdd;
                    if (lift > 5) lift = 5;
                }
                const tx = x - bx;
                if (tx < 0 || tx >= tw) continue;
                const i = tRow + tx;
                if (cls[i] === CLS_EMPTY) continue;
                const c = Math.floor((x - fieldX) / 2);
                if (c < 0 || c >= cols) continue;
                const cell = (fRow + c) * 2;
                const flags = coastField[cell + 1];
                if (!(flags & COAST_FIELD_FLAGS.water) || (flags & COAST_FIELD_FLAGS.covered)) continue;
                if (steps > 0 && columnBlocked(field, steps, x + 0.5, y + 0.5, light, homeHoused)) continue;
                const p = pRow + x;
                const sd = coastField[cell];
                capP.push(p);
                capL.push(lift);
                capB.push(i);
                capS.push(sd);
                if ((accCount << 1) >= htCap) growHt();
                let h = columnHash(p) & htMask;
                while (htGen[h] === gen && htKey[h] !== p) h = (h + 1) & htMask;
                if (htGen[h] !== gen) {
                    const slot = accCount++;
                    htGen[h] = gen;
                    htKey[h] = p;
                    htVal[h] = slot;
                    accP[slot] = p;
                    accR[slot] = lrgb0;
                    accG[slot] = lrgb1;
                    accB[slot] = lrgb2;
                    accLift[slot] = lift;
                    accBaseI[slot] = i;
                    accSd[slot] = sd;
                } else {
                    const slot = htVal[h];
                    accR[slot] += lrgb0;
                    accG[slot] += lrgb1;
                    accB[slot] += lrgb2;
                    if (lift > accLift[slot]) accLift[slot] = lift;
                }
            }
        }
        if (lightCache.size < 128) {
            lightCache.set(lk, {
                p: capP.length ? new Int32Array(capP) : EMPTY_I32,
                lift: new Uint8Array(capL),
                baseI: capB.length ? new Int32Array(capB) : EMPTY_I32,
                sd: new Uint8Array(capS),
            });
        }
    }
    if (!accCount) {
        state.columnForceFull = true;
        state.columnPixels.length = 0;
        state.columns.contentBounds = null;
        return false;
    }

    const layer = layerCanvas(state.columns, colW, colH, false);
    const moved = layer.x !== colX0 || layer.y !== colY0;
    const fullUpload = layer.resized || moved || state.columnForceFull === true;
    const out = layer.u32;
    const prevPixels = state.columnPixels;
    const nextPixels = state.columnNextPixels;
    nextPixels.length = 0;

    const tilesX = Math.ceil(colW / COL_TILE);
    const tilesY = Math.ceil(colH / COL_TILE);
    let dirtyTiles = null;
    if (fullUpload) {
        if (!layer.resized) out.fill(0);
    } else {
        const tileCount = tilesX * tilesY;
        dirtyTiles = state.columnDirtyTiles;
        if (!dirtyTiles || dirtyTiles.length !== tileCount) {
            dirtyTiles = state.columnDirtyTiles = new Uint8Array(tileCount);
        } else {
            dirtyTiles.fill(0);
        }
        for (let k = 0; k < prevPixels.length; k++) {
            const p = prevPixels[k];
            out[p] = 0;
            const px = p % colW;
            const py = (p - px) / colW;
            dirtyTiles[(py >> 7) * tilesX + (px >> 7)] = 1;
        }
    }

    let bx0 = colW;
    let by0 = colH;
    let bx1 = -1;
    let by1 = -1;
    const memo = state.columnMemo;
    let prevU = -1, prevStop = -1, prevLift = -1, prevQR = -1, prevQG = -1, prevQB = -1, prevColour = 0;
    for (let s = 0; s < accCount; s++) {
        const p = accP[s];
        const px = p % colW;
        const py = (p - px) / colW;
        if (px < bx0) bx0 = px;
        if (px > bx1) bx1 = px;
        if (py < by0) by0 = py;
        if (py > by1) by1 = py;

        const baseI = accBaseI[s];
        const k = cls[baseI];
        const stop = waterStopForSd((accSd[s] - 128) / 64);
        let u;
        if (k <= 5) u = palette.stops[k];
        else if (k === CLS_FOAM || k === CLS_CREST) u = palette.classes[k];
        else {
            const rgb = receiverRgb(base, baseI);
            u = rgb < 0 ? palette.stops[stop] : palette.ripple(rgb);
        }
        const ar = accR[s];
        const ag = accG[s];
        const ab = accB[s];
        const lift = accLift[s];
        const qR = Math.round(ar * 512);
        const qG = Math.round(ag * 512);
        const qB = Math.round(ab * 512);
        let colour;
        if (u === prevU && stop === prevStop && lift === prevLift && qR === prevQR && qG === prevQG && qB === prevQB) {
            colour = prevColour;
        } else {
            const key = `${u}|${stop}|${lift}|${qR},${qG},${qB}`;
            colour = memo.get(key);
            if (colour === undefined) {
                if (memo.size >= COLUMN_MEMO_MAX) memo.clear();
                const water = CanvasGrade.canvasFrameGradeRgb([(u & 255) / 255, ((u >> 8) & 255) / 255, ((u >> 16) & 255) / 255], grade, { postFx });
                colour = u32Of(CanvasGrade.landWaterColumn(water, [ar, ag, ab], lift, columnRampLuma(stop, lift)));
                memo.set(key, colour);
            }
            prevU = u; prevStop = stop; prevLift = lift; prevQR = qR; prevQG = qG; prevQB = qB; prevColour = colour;
        }
        out[p] = colour;
        nextPixels.push(p);
        if (dirtyTiles) dirtyTiles[(py >> 7) * tilesX + (px >> 7)] = 1;
    }

    if (fullUpload) {
        layer.ctx.putImageData(layer.image, 0, 0);
        state.columnForceFull = false;
    } else {
        // Vertically merge horizontally adjacent dirty 64x64 tiles to minimize upload calls.
        const rects = [];
        let prevStrips = [];
        for (let ty = 0; ty < tilesY; ty++) {
            const ry0 = ty * COL_TILE;
            const ry1 = Math.min(colH, ry0 + COL_TILE);
            const curStrips = [];
            let tx = 0;
            const rowOff = ty * tilesX;
            while (tx < tilesX) {
                while (tx < tilesX && !dirtyTiles[rowOff + tx]) tx++;
                if (tx >= tilesX) break;
                const tx0 = tx;
                while (tx < tilesX && dirtyTiles[rowOff + tx]) tx++;
                const rx0 = tx0 * COL_TILE;
                const rx1 = Math.min(colW, tx * COL_TILE);
                let merged = null;
                for (let pi = 0; pi < prevStrips.length; pi++) {
                    const ps = prevStrips[pi];
                    if (ps.x0 === rx0 && ps.x1 === rx1 && ps.y1 === ry0) {
                        ps.y1 = ry1;
                        merged = ps;
                        break;
                    }
                }
                if (merged) {
                    curStrips.push(merged);
                } else {
                    const strip = { x0: rx0, y0: ry0, x1: rx1, y1: ry1 };
                    rects.push(strip);
                    curStrips.push(strip);
                }
            }
            prevStrips = curStrips;
        }
        for (let i = 0; i < rects.length; i++) {
            const dr = rects[i];
            layer.ctx.putImageData(layer.image, 0, 0, dr.x0, dr.y0, dr.x1 - dr.x0, dr.y1 - dr.y0);
        }
    }

    prevPixels.length = 0;
    state.columnPixels = nextPixels;
    state.columnNextPixels = prevPixels;
    if (accP.length > 16384 && accCount < 4096) {
        accP.length = accR.length = accG.length = accB.length = accLift.length = accBaseI.length = accSd.length = 0;
    }
    layer.x = colX0;
    layer.y = colY0;
    layer.contentBounds = { sx: bx0, sy: by0, sw: bx1 - bx0 + 1, sh: by1 - by0 + 1 };
    return true;
}

/**
 * 2.7 / 2.9 — warm beacon glints and lamp columns built this frame land on
 * the ungraded overlay after the frame grade (the resident pass does too),
 * carved by every sprite the depth pass drew over the
 * water (`drawCarvedTerrainLayer`). Call where the emitter cuts land, only
 * when the resident scene pass did not render the frame.
 */
export function drawCanvasWaterColumns(overlayCtx, renderer) {
    const state = renderer?._canvasWater;
    const glow = state?.glowDraw === true;
    const moonPath = state?.pathPostGrade === true;
    if (!state || (!state.columnsLive && !glow && !moonPath) || !renderer.camera) return;
    overlayCtx.save();
    renderer.camera.applyTransform(overlayCtx);
    overlayCtx.imageSmoothingEnabled = false;
    overlayCtx.globalCompositeOperation = 'source-over';
    // BI-8 — the summer surf glow over the graded crest, at its strength
    // (the resident `mix(graded, SURF_GLOW, u_surfGlow)`).
    if (glow) {
        state.glowDraw = false;
        overlayCtx.globalAlpha = Math.min(1, state.glowAlpha);
        drawCarvedTerrainLayer(overlayCtx, renderer, state.glow);
    }
    overlayCtx.globalAlpha = 1;
    // NE P3.3b — night moon-path glints land post-grade under the lamp columns.
    if (moonPath) {
        state.pathPostGrade = false;
        drawCarvedTerrainLayer(overlayCtx, renderer, state.path);
    }
    if (state.columnsLive) {
        state.columnsLive = false;
        drawCarvedTerrainLayer(overlayCtx, renderer, state.columns);
    }
    overlayCtx.restore();
}

// Plan dirty chunk/row rectangles for a warm overlay rebuild, keeping the
// resulting pixels identical to a full rebuild while skipping untouched areas.
function planOverlayDirty(state, base, fx, rect, view, glint, sun, gust, tokens, newDeepChunks, newCapChunks, capsSwapped) {
    const prev = state.overlayTokens;
    const { x0, y0, w, h } = rect;
    const x1 = x0 + w;
    const y1 = y0 + h;
    const reasons = [];
    const changed = new Set();
    if (!prev || !state.overlayValid) {
        return { full: true, dirtyRects: [{ x0, y0, x1, y1 }], reasons: ['init'], updateGlow: true, maskChangedBounds: { x0, y0, x1, y1 } };
    }
    for (let idx = 0; idx < tokens.length; idx++) {
        if (tokens[idx] !== prev[idx]) {
            const name = OVERLAY_REASON_NAMES[idx];
            if (name && !changed.has(name)) {
                changed.add(name);
                reasons.push(name);
                state.stats.overlayReasons[name]++;
            }
        }
    }
    if ((newDeepChunks.length || newCapChunks.length) && !changed.has('pending')) {
        changed.add('pending');
        reasons.push('pending');
        state.stats.overlayReasons.pending++;
    }
    if (!changed.size) return null;

    // Structural / global changes force a clean full-overlay rebuild.
    if (changed.has('base') || changed.has('palette') || changed.has('rect')
        || changed.has('clock') || changed.has('sea') || changed.has('horizon') || changed.has('sun')) {
        return { full: true, dirtyRects: [{ x0, y0, x1, y1 }], reasons, updateGlow: true, maskChangedBounds: { x0, y0, x1, y1 } };
    }

    const cX0 = Math.floor(x0 / CHUNK_W);
    const cY0 = Math.floor(y0 / CHUNK_H);
    const cX1 = Math.floor((x1 - 1) / CHUNK_W);
    const cY1 = Math.floor((y1 - 1) / CHUNK_H);
    const gridW = cX1 - cX0 + 1;
    const gridH = cY1 - cY0 + 1;
    const dirtyGrid = new Uint8Array(gridW * gridH);
    const extraRects = [];
    let anyDirty = false;
    const markChunk = (cx, cy) => {
        if (cx < cX0 || cx > cX1 || cy < cY0 || cy > cY1) return;
        dirtyGrid[(cy - cY0) * gridW + (cx - cX0)] = 1;
        anyDirty = true;
    };
    const markBounds = (b) => {
        if (!hasBounds(b)) return;
        const bx0 = Math.max(x0, b.x0);
        const by0 = Math.max(y0, b.y0);
        const bx1 = Math.min(x1, b.x1);
        const by1 = Math.min(y1, b.y1);
        if (bx0 >= bx1 || by0 >= by1) return;
        extraRects.push({ x0: bx0, y0: by0, x1: bx1, y1: by1 });
        anyDirty = true;
    };

    // Track exact union bounds of any mask-writing feature that changed (for path reuse).
    const maskBounds = createBounds();
    const expandMaskBounds = (b) => {
        if (!hasBounds(b)) return;
        expandBounds(maskBounds, b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0);
    };

    if (changed.has('drift') || capsSwapped) {
        for (let cy = cY0; cy <= cY1; cy++) {
            for (let cx = cX0; cx <= cX1; cx++) {
                const chunk = state.caps.get(chunkId(cx, cy));
                if (chunk && !chunk.driftFree) markChunk(cx, cy);
            }
        }
    }
    for (let i = 0; i < newDeepChunks.length; i++) markChunk(newDeepChunks[i][0], newDeepChunks[i][1]);
    for (let i = 0; i < newCapChunks.length; i++) markChunk(newCapChunks[i][0], newCapChunks[i][1]);

    if (changed.has('deep')) {
        const storm = fx.storm;
        for (let cy = cY0; cy <= cY1; cy++) {
            if ((cy + 1) * CHUNK_H <= OCEAN_HORIZON_WORLD_Y) continue;
            for (let cx = cX0; cx <= cX1; cx++) {
                if (state.chunks.has(`${cx},${cy},${storm}`)) markChunk(cx, cy);
            }
        }
        markBounds(base.threadsBounds);
        if (fx.starlight > 0 && glint?.kind === 3) {
            const gx = view.x0 + (glint.body?.xFrac ?? 0.5) * (view.x1 - view.x0);
            const grow = 0.12 * (glint.growScale ?? 1);
            const maxHalf = 0.95 * (5 + (y1 + 0.5 - view.y0) * grow);
            markBounds({ x0: Math.floor(gx - maxHalf) - 3, y0: fx.horizonTop, x1: Math.ceil(gx + maxHalf) + 3, y1 });
        }
    }
    if (changed.has('starlight') || changed.has('glint')) {
        const prevStar = state.prevStarlightBounds;
        if (prevStar) markBounds(prevStar);
        if (fx.starlight > 0 && glint?.kind === 3) {
            const gx = view.x0 + (glint.body?.xFrac ?? 0.5) * (view.x1 - view.x0);
            const grow = 0.12 * (glint.growScale ?? 1);
            const maxHalf = 0.95 * (5 + (y1 + 0.5 - view.y0) * grow);
            const cur = { x0: Math.floor(gx - maxHalf) - 3, y0: fx.horizonTop, x1: Math.ceil(gx + maxHalf) + 3, y1 };
            markBounds(cur);
            state.prevStarlightBounds = cur;
        } else {
            state.prevStarlightBounds = null;
        }
    }
    if (changed.has('near')) markBounds(base.nearBounds);
    if (changed.has('still')) {
        markBounds(base.nearBounds);
        markBounds(base.stillWaterBounds);
    }
    if (changed.has('ripple')) markBounds(base.rippleBounds);
    if (changed.has('caustics') || changed.has('shade')) markBounds(base.causticBounds);
    if (changed.has('rain') || changed.has('ring')) markBounds(base.waterBounds);
    if (changed.has('collar')) { markBounds(base.collarBounds); expandMaskBounds(base.collarBounds); }
    if (changed.has('eddy')) { markBounds(base.eddyBounds); expandMaskBounds(base.eddyBounds); }
    const updateGlow = changed.has('swash') || changed.has('surfGlow');
    if (changed.has('swash')) {
        markBounds(base.swashBounds);
        expandMaskBounds(base.swashBounds);
    } else if (changed.has('surfGlow') && fx.clock > 0 && fx.swash && fx.surfGlow > 0) {
        // Glow toggled on without a swash step: repaint all visible swashBounds.
        markBounds(base.swashBounds);
    }

    if (changed.has('gust') || changed.has('grass') || changed.has('still')) {
        for (let cy = cY0; cy <= cY1; cy++) {
            for (let cx = cX0; cx <= cX1; cx++) {
                const chunk = state.caps.get(chunkId(cx, cy));
                if (!chunk) continue;
                if (syncChunkGust(chunk, cx, cy, gust, fx.grassGust)) markChunk(cx, cy);
            }
        }
        const still = base.still;
        if (still && still.blocks > 0) {
            if (!state.stillWasActive || state.stillWasActive.length !== still.blocks) {
                state.stillWasActive = new Uint8Array(still.blocks);
            }
            const wasActive = state.stillWasActive;
            const activeNow = fx.clock > 0 && fx.stillPaws && gust != null;
            const bStart = lowerBoundRange(still.blockY, 0, still.blocks, y0 - STILL_BLOCK_H + 1);
            const stillDirty = createBounds();
            for (let b = bStart; b < still.blocks; b++) {
                const by0 = still.blockY[b];
                if (by0 >= y1) break;
                const bx0 = still.blockX[b];
                if (bx0 + STILL_BLOCK_W <= x0 || bx0 >= x1) continue;
                const nowOn = activeNow && gustBound(gust, bx0, by0, STILL_BLOCK_W, STILL_BLOCK_H) > still.blockNeed[b] ? 1 : 0;
                if (nowOn || wasActive[b]) expandBounds(stillDirty, bx0, by0, STILL_BLOCK_W, STILL_BLOCK_H);
                wasActive[b] = nowOn;
            }
            if (hasBounds(stillDirty)) markBounds(stillDirty);
        }
    }

    if (!anyDirty) {
        // Every changed input (e.g. light gust step) produced zero actual pixel deltas.
        return { full: false, dirtyRects: [], reasons, updateGlow, maskChangedBounds: hasBounds(maskBounds) ? maskBounds : null };
    }

    // Fold any extraRects into the chunk grid unless the entire dirty set is a
    // single small sub-chunk rect with no dirty chunks (e.g. collar/eddy step).
    let chunkDirtyCount = 0;
    for (let i = 0; i < dirtyGrid.length; i++) if (dirtyGrid[i]) chunkDirtyCount++;

    const dirtyRects = [];
    if (chunkDirtyCount === 0 && extraRects.length) {
        // Merge extraRects into one tight union rect clipped to `rect` — handles
        // tiny shore-only updates (swash, collar, eddy, ripple, near) without
        // expanding out to 384x192 chunk boundaries over open sea.
        let ux0 = x1, uy0 = y1, ux1 = x0, uy1 = y0;
        for (let i = 0; i < extraRects.length; i++) {
            const er = extraRects[i];
            if (er.x0 < ux0) ux0 = er.x0;
            if (er.y0 < uy0) uy0 = er.y0;
            if (er.x1 > ux1) ux1 = er.x1;
            if (er.y1 > uy1) uy1 = er.y1;
        }
        if (ux0 < ux1 && uy0 < uy1) dirtyRects.push({ x0: ux0, y0: uy0, x1: ux1, y1: uy1 });
    } else {
        for (let i = 0; i < extraRects.length; i++) {
            const er = extraRects[i];
            const ex0 = Math.floor(er.x0 / CHUNK_W);
            const ey0 = Math.floor(er.y0 / CHUNK_H);
            const ex1 = Math.floor((er.x1 - 1) / CHUNK_W);
            const ey1 = Math.floor((er.y1 - 1) / CHUNK_H);
            for (let cy = ey0; cy <= ey1; cy++) {
                for (let cx = ex0; cx <= ex1; cx++) markChunk(cx, cy);
            }
        }
        // Merge horizontally adjacent dirty chunks on each chunk row, then merge
        // vertically adjacent strips sharing `(x0, x1)` so multi-row dirty bands
        // (e.g. every `deep` tick below horizon) clear, draw, and upload once.
        let totalDirtyChunks = 0;
        for (let i = 0; i < dirtyGrid.length; i++) if (dirtyGrid[i]) totalDirtyChunks++;
        if (totalDirtyChunks === dirtyGrid.length) {
            return { full: true, dirtyRects: [{ x0, y0, x1, y1 }], reasons, updateGlow, maskChangedBounds: hasBounds(maskBounds) ? maskBounds : null };
        }
        let prevStrips = [];
        for (let gy = 0; gy < gridH; gy++) {
            const ry0 = Math.max(y0, (cY0 + gy) * CHUNK_H);
            const ry1 = Math.min(y1, (cY0 + gy + 1) * CHUNK_H);
            const curStrips = [];
            let gx = 0;
            while (gx < gridW) {
                while (gx < gridW && !dirtyGrid[gy * gridW + gx]) gx++;
                if (gx >= gridW) break;
                const startGx = gx;
                while (gx < gridW && dirtyGrid[gy * gridW + gx]) gx++;
                const rx0 = Math.max(x0, (cX0 + startGx) * CHUNK_W);
                const rx1 = Math.min(x1, (cX0 + gx) * CHUNK_W);
                if (rx0 >= rx1 || ry0 >= ry1) continue;
                let merged = null;
                for (let pi = 0; pi < prevStrips.length; pi++) {
                    const ps = prevStrips[pi];
                    if (ps.x0 === rx0 && ps.x1 === rx1 && ps.y1 === ry0) {
                        ps.y1 = ry1;
                        merged = ps;
                        break;
                    }
                }
                if (merged) {
                    curStrips.push(merged);
                } else {
                    const strip = { x0: rx0, y0: ry0, x1: rx1, y1: ry1 };
                    dirtyRects.push(strip);
                    curStrips.push(strip);
                }
            }
            prevStrips = curStrips;
        }
    }

    return {
        full: false,
        dirtyRects,
        reasons,
        updateGlow,
        maskChangedBounds: hasBounds(maskBounds) ? maskBounds : null,
    };
}

/**
 * Draw the frame's water state over the terrain cache (after the mood copy),
 * in world space under the camera transform. Returns nothing; diagnostics
 * land on `renderer._canvasWater.stats`.
 */
export function drawCanvasWaterState(ctx, renderer, atmosphere) {
    const view = visibleWorldRect(ctx);
    if (!view) return;
    const state = renderer._canvasWater ||= {
        base: null,
        chunks: new Map(),
        caps: new Map(),
        capWork: null,
        nextCaps: null,
        nextCapWork: null,
        canvasPool: [],
        overlay: {},
        overlayValid: false,
        path: {},
        pathMaskEpoch: 0,
        sun: {},
        // BI-8 — the swash's glowing crest front, laid after the grade.
        glow: {},
        glowLive: false,
        glowValid: false,
        glowDraw: false,
        glowAlpha: 0,
        // 3.3 (a) — the cap chunks holding sea canvases (`chunkSeaCanvas`).
        seaCanvasChunks: new Set(),
        seaLutKey: '',
        seaLutSpec: null,
        seaLutActive: false,
        seaLutFresnel: false,
        seaLutStripEnd: -Infinity,
        seaLutBandEnd: -Infinity,
        seaLut: new Uint32Array(28),
        columns: {},
        columnMemo: new Map(),
        columnPixels: [],
        columnNextPixels: [],
        columnDirtyTiles: null,
        columnForceFull: true,
        columnAccP: [],
        columnAccR: [],
        columnAccG: [],
        columnAccB: [],
        columnAccLift: [],
        columnAccBaseI: [],
        columnAccSd: [],
        gust: null,
        mask: null,
        maskEpoch: 0,
        rise: null,
        stillWasActive: null,
        prevStarlightBounds: null,
        overlayKey: '',
        overlayTokens: null,
        pathKey: '',
        sunKey: '',
        columnKey: '',
        paletteKey: '',
        palette: null,
        stats: {
            baseMs: 0,
            overlayMs: 0,
            overlayBuilds: 0,
            overlayArea: 0,
            overlayDirtyArea: 0,
            overlayReasons: createOverlayReasons(),
            overlayLastReasons: [],
            overlayParts: {
                clearMs: 0, rippleMs: 0, capsMs: 0, staticDashMs: 0, causticsMs: 0,
                nearMs: 0, deepMs: 0, starlightMs: 0, stillMs: 0, specksMs: 0,
                rainMs: 0, swashMs: 0, uploadMs: 0,
            },
            pathMs: 0,
            pathBuilds: 0,
            pathSkips: 0,
            pathArea: 0,
            chunks: 0,
            chunksPending: 0,
            caps: 0,
            capsPending: 0,
            nextCapsPending: 0,
            capMs: 0,
            capBuilds: 0,
            capChunkMs: 0,
            capMaxChunkMs: 0,
            capColdBuilds: 0,
            capDriftBuilds: 0,
            capResumes: 0,
            capSwaps: 0,
            sunMs: 0,
            sunBuilds: 0,
            seaCanvasMs: 0,
            seaCanvasBuilds: 0,
            columnMs: 0,
            columnBuilds: 0,
            columns: 0,
            activeColumns: 0,
        },
    };
    const fields = renderer._coastBake?.waterFields;
    const baseKey = `${renderer.terrainCacheKey}|${fields?.revision}`;
    if (!state.base || state.base.key !== baseKey) {
        state.base = buildBase(renderer);
        state.caps.clear();
        state.capWork = null;
        state.nextCaps = null;
        state.nextCapWork = null;
        for (const chunk of state.seaCanvasChunks) recycleChunkCanvases(state, chunk, 0);
        state.seaCanvasChunks.clear();
        trimCanvasPool(state, 0);
        state.overlayKey = '';
        state.overlayTokens = null;
        state.overlayValid = false;
        state.glowValid = false;
        state.stillWasActive = null;
        state.prevStarlightBounds = null;
        state.pathKey = '';
        state.sunKey = '';
        state.columnKey = '';
        state.columnForceFull = true;
        state.columnPixels.length = 0;
        state.columns.contentBounds = null;
        state.maskEpoch++;
        if (state.base) state.stats.baseMs = state.base.buildMs;
    }
    const base = state.base;
    if (!base) return;
    const fx = resolveFx(renderer, atmosphere);
    const postFx = renderer.postFx?.isActive?.() === true;
    const mood = waterMoodFor(atmosphere);
    const cloudStep = Math.round(clamp01((clamp01(atmosphere?.weather?.cloudCover) - 0.7) / 0.2) * 8);
    const paletteKey = `${waterMoodKey(mood)}:${waterSunBandFor(atmosphere)}|${CanvasGrade.canvasGradeKey(atmosphere?.lightGrade || null, { postFx })}|${fx.storm}|${cloudStep}`;
    if (state.paletteKey !== paletteKey) {
        state.palette = buildPalette(atmosphere, postFx, fx.storm);
        state.paletteKey = paletteKey;
        state.columnMemo.clear();
    }
    const palette = state.palette;
    const rect = {
        x0: Math.floor((view.x0 - 8) / OVERLAY_SNAP) * OVERLAY_SNAP,
        y0: Math.floor((view.y0 - 8) / OVERLAY_SNAP) * OVERLAY_SNAP,
    };
    rect.w = Math.ceil((view.x1 + 8) / OVERLAY_SNAP) * OVERLAY_SNAP - rect.x0;
    rect.h = Math.ceil((view.y1 + 8) / OVERLAY_SNAP) * OVERLAY_SNAP - rect.y0;
    const cX0 = Math.floor(rect.x0 / CHUNK_W);
    const cY0 = Math.floor(rect.y0 / CHUNK_H);
    const cX1 = Math.floor((rect.x0 + rect.w - 1) / CHUNK_W);
    const cY1 = Math.floor((rect.y0 + rect.h - 1) / CHUNK_H);

    // The deep field's chunks over the rect, a few built per frame.
    const newDeepChunks = [];
    let chunksPending = 0;
    if (fx.clock > 0) {
        let built = 0;
        let visible = 0;
        for (let cy = cY0; cy <= cY1; cy++) {
            if ((cy + 1) * CHUNK_H <= OCEAN_HORIZON_WORLD_Y) continue;
            for (let cx = cX0; cx <= cX1; cx++) {
                visible++;
                const key = `${cx},${cy},${fx.storm}`;
                const hit = state.chunks.get(key);
                if (hit) {
                    state.chunks.delete(key);
                    state.chunks.set(key, hit);
                } else if (built < CHUNK_BUILDS_PER_FRAME) {
                    state.chunks.set(key, buildChunk(cx, cy, fx.storm));
                    newDeepChunks.push([cx, cy]);
                    built++;
                } else {
                    chunksPending++;
                }
            }
        }
        const cap = Math.max(CHUNK_CACHE_MIN, visible * 2);
        for (const key of state.chunks.keys()) {
            if (state.chunks.size <= cap) break;
            state.chunks.delete(key);
        }
        state.stats.chunks = state.chunks.size;
    }
    state.stats.chunksPending = chunksPending;

    // 3.3 (a) — the cap chunks over the rect, built in resumable row slices
    // within `CAP_BUILD_BUDGET_MS`. E2-03: when the swell drift steps, visible
    // chunks rebuild for `nextDrift` into `nextCaps` while the current
    // generation keeps drawing, and swap in atomically once every visible chunk
    // is complete.
    const newCapChunks = [];
    let capsPending = 0;
    let nextPending = 0;
    let capsSwapped = false;
    {
        const started = performance.now();
        let visible = 0;
        if (!state.caps.size && !state.capWork) state.capsDrift = fx.swellDrift;
        if (fx.swellDrift !== state.capsDrift && !state.nextCaps) {
            state.nextCaps = new Map();
            state.nextDrift = fx.swellDrift;
            state.nextCapWork = null;
        }
        // Drop any paused partial chunk that scrolled off-screen (bounded O(1)).
        const workInView = (w) => w && w.cx >= cX0 && w.cx <= cX1 && w.cy >= cY0 && w.cy <= cY1 && (w.cy + 1) * CHUNK_H > OCEAN_HORIZON_WORLD_Y;
        if (state.capWork && (!workInView(state.capWork) || state.caps.has(state.capWork.id))) state.capWork = null;
        if (state.nextCapWork && (!state.nextCaps || !workInView(state.nextCapWork) || state.nextCaps.has(state.nextCapWork.id))) state.nextCapWork = null;

        // First resume any in-progress cold cap chunk before starting new ones.
        if (state.capWork && performance.now() - started < CAP_BUILD_BUDGET_MS) {
            const w = state.capWork;
            const prevResumes = w.resumes;
            const done = stepCapChunkBuilder(w, started, CAP_BUILD_BUDGET_MS);
            if (w.resumes > prevResumes) state.stats.capResumes++;
            if (done) {
                state.caps.set(w.id, done);
                newCapChunks.push([w.cx, w.cy]);
                state.capWork = null;
                state.stats.capBuilds++;
                state.stats.capColdBuilds++;
                state.stats.capChunkMs = done.buildMs;
                if (done.buildMs > state.stats.capMaxChunkMs) state.stats.capMaxChunkMs = done.buildMs;
            }
        }
        // Resume any in-progress next-generation drift chunk.
        if (state.nextCapWork && !state.capWork && performance.now() - started < CAP_BUILD_BUDGET_MS) {
            const w = state.nextCapWork;
            const prevResumes = w.resumes;
            const done = stepCapChunkBuilder(w, started, CAP_BUILD_BUDGET_MS);
            if (w.resumes > prevResumes) state.stats.capResumes++;
            if (done) {
                state.nextCaps.set(w.id, done);
                state.nextCapWork = null;
                state.stats.capBuilds++;
                state.stats.capDriftBuilds++;
                state.stats.capChunkMs = done.buildMs;
                if (done.buildMs > state.stats.capMaxChunkMs) state.stats.capMaxChunkMs = done.buildMs;
            }
        }

        for (let cy = cY0; cy <= cY1; cy++) {
            if ((cy + 1) * CHUNK_H <= OCEAN_HORIZON_WORLD_Y) continue;
            for (let cx = cX0; cx <= cX1; cx++) {
                visible++;
                const id = chunkId(cx, cy);
                const hit = state.caps.get(id);
                if (hit) {
                    state.caps.delete(id);
                    state.caps.set(id, hit);
                } else if (!state.capWork && performance.now() - started < CAP_BUILD_BUDGET_MS) {
                    const builder = createCapChunkBuilder(base, cx, cy, state.capsDrift);
                    const done = stepCapChunkBuilder(builder, started, CAP_BUILD_BUDGET_MS);
                    if (done) {
                        state.caps.set(id, done);
                        newCapChunks.push([cx, cy]);
                        state.stats.capBuilds++;
                        state.stats.capColdBuilds++;
                        state.stats.capChunkMs = done.buildMs;
                        if (done.buildMs > state.stats.capMaxChunkMs) state.stats.capMaxChunkMs = done.buildMs;
                    } else {
                        state.capWork = builder;
                        state.stats.capResumes++;
                        capsPending++;
                    }
                } else {
                    capsPending++;
                }
                if (state.nextCaps && !state.nextCaps.has(id)) {
                    const current = state.caps.get(id) || null;
                    if (current?.driftFree) {
                        state.nextCaps.set(id, current);
                    } else if (!state.nextCapWork && performance.now() - started < CAP_BUILD_BUDGET_MS) {
                        const builder = createCapChunkBuilder(base, cx, cy, state.nextDrift, current);
                        const done = stepCapChunkBuilder(builder, started, CAP_BUILD_BUDGET_MS);
                        if (done) {
                            state.nextCaps.set(id, done);
                            state.stats.capBuilds++;
                            state.stats.capDriftBuilds++;
                            state.stats.capChunkMs = done.buildMs;
                            if (done.buildMs > state.stats.capMaxChunkMs) state.stats.capMaxChunkMs = done.buildMs;
                        } else {
                            state.nextCapWork = builder;
                            state.stats.capResumes++;
                            nextPending++;
                        }
                    } else {
                        nextPending++;
                    }
                }
            }
        }
        if (state.nextCaps && !nextPending && !state.nextCapWork) {
            state.caps = state.nextCaps;
            state.capsDrift = state.nextDrift;
            state.nextCaps = null;
            state.nextCapWork = null;
            state.capWork = null;
            capsPending = 0;
            capsSwapped = true;
            state.stats.capSwaps++;
        }
        const cap = Math.max(CHUNK_CACHE_MIN, visible * 2);
        for (const id of state.caps.keys()) {
            if (state.caps.size <= cap) break;
            const evicted = state.caps.get(id);
            if (evicted && state.seaCanvasChunks.has(evicted)) {
                recycleChunkCanvases(state, evicted);
                state.seaCanvasChunks.delete(evicted);
            }
            state.caps.delete(id);
        }
        state.stats.caps = state.caps.size;
        state.stats.capsPending = capsPending;
        state.stats.nextCapsPending = nextPending;
        state.stats.capMs = performance.now() - started;
    }

    // 3.3 (a) — the sea body under every mark, from the visible chunks; recycle
    // off-screen/replaced chunk canvases BEFORE acquiring new ones so warm pools
    // stay small (`poolCap <= SEA_CANVAS_POOL_MAX`) and overflow backing releases.
    const seaKey = canvasSeaKey(renderer);
    const seaCanvasKey = `${paletteKey}|${seaKey}`;
    resolveSeaColorLut(state, renderer, palette, seaCanvasKey);
    const shown = new Set();
    const visibleChunks = [];
    for (let cy = cY0; cy <= cY1; cy++) {
        for (let cx = cX0; cx <= cX1; cx++) {
            const chunk = state.caps.get(chunkId(cx, cy));
            if (!chunk) continue;
            shown.add(chunk);
            visibleChunks.push([chunk, cx, cy]);
        }
    }
    const poolCap = Math.min(SEA_CANVAS_POOL_MAX, Math.max(8, shown.size));
    for (const chunk of state.seaCanvasChunks) {
        if (shown.has(chunk)) continue;
        recycleChunkCanvases(state, chunk, poolCap);
        state.seaCanvasChunks.delete(chunk);
    }
    trimCanvasPool(state, poolCap);
    ctx.save();
    ctx.imageSmoothingEnabled = false;
    for (let i = 0; i < visibleChunks.length; i++) {
        const [chunk, cx, cy] = visibleChunks[i];
        const canvas = chunkSeaCanvas(state, chunk, cx, cy, palette, seaCanvasKey, renderer, false);
        if (canvas) ctx.drawImage(canvas, cx * CHUNK_W, cy * CHUNK_H);
    }
    const weather = atmosphere?.weather || {};
    const sun = resolveSun(renderer, atmosphere, fx);
    const gust = resolveGust(state, fx, rect, weather);
    const glint = canvasGlint(atmosphere);

    // Exact inputs consumed by the overlay: gate inactive clocks/features so
    // unused ticks (e.g. rain rings in clear air, sun xFrac by day) never
    // trigger rebuilds.
    const starlightOn = fx.starlight > 0 && glint?.kind === 3;
    const overlayTokens = [
        starlightOn ? glint.kind : 0,
        starlightOn ? `${glint.body?.xFrac ?? 0.5}:${glint.growScale ?? 1}` : '',
        base.key, paletteKey, rect.x0, rect.y0, rect.w, rect.h, fx.clock > 0 ? 1 : 0,
        Math.floor(fx.t * fx.clock / 300) % 3,
        Math.floor(fx.t * 0.003 * fx.clock) % 2,
        fx.starlight,
        fx.clock > 0 ? fx.deepTick : 0,
        fx.clock > 0 ? fx.nearTick : 0,
        fx.rain > 0 && fx.clock > 0 ? fx.ringTick : 0,
        fx.clock > 0 && fx.swash ? posMod(fx.swashStep, SWASH_SET) : -1,
        fx.clock > 0 ? fx.rippleTick : 0,
        fx.clock > 0 && fx.stillPaws ? 1 : 0,
        fx.clock > 0 ? Math.round(fx.stillShare * 256) : 0,
        fx.clock > 0 && fx.swash && fx.surfGlow > 0 ? 1 : 0,
        fx.caustics ? (fx.clock > 0 ? Math.floor(fx.t * 0.004 * fx.clock) % 8 : 0) : -1,
        fx.caustics ? (renderer._shadeFieldState?.ready?.revision ?? 0) : 0,
        Math.round(fx.rain * 64),
        fx.swash ? 1 : 0,
        fx.grassGust ? 1 : 0,
        fx.horizonTop,
        0,
        sun?.key ?? '',
        gust?.key ?? '',
        seaKey,
        state.capsDrift,
    ];

    // 3.4 — the sunlit course, under every mark. Depends only on caps, never on deep chunks.
    if (sun && seaKey) {
        const sunKey = `${base.key}|${seaCanvasKey}|${sun.key}|${rect.x0},${rect.y0},${rect.w},${rect.h}|${capsPending}|${state.capsDrift}`;
        if (state.sunKey !== sunKey) {
            const started = performance.now();
            rebuildSun(state, renderer, rect, sun, palette, seaCanvasKey);
            state.sunKey = sunKey;
            state.stats.sunMs = performance.now() - started;
            state.stats.sunBuilds++;
        }
        ctx.drawImage(state.sun.canvas, state.sun.x, state.sun.y);
    }

    const plan = planOverlayDirty(state, base, fx, rect, view, glint, sun, gust, overlayTokens, newDeepChunks, newCapChunks, capsSwapped);
    let maskChangedBounds = null;
    if (plan) {
        state.overlayTokens = overlayTokens;
        state.stats.overlayLastReasons = plan.reasons;
        if (plan.full || plan.dirtyRects.length) {
            const started = performance.now();
            const dirtyArea = rebuildOverlay(state, base, fx, palette, rect, renderer, { caps: state.caps, sun, gust, view, road: glint }, plan);
            state.overlayValid = true;
            state.overlayKey = overlayTokens.join('|');
            state.stats.overlayMs = performance.now() - started;
            state.stats.overlayArea = rect.w * rect.h;
            state.stats.overlayDirtyArea = dirtyArea;
            state.stats.overlayBuilds++;
            if (plan.maskChangedBounds) {
                maskChangedBounds = plan.maskChangedBounds;
                state.maskEpoch++;
            }
        }
    }
    // BI-8 — this frame's glow, consumed by `drawCanvasWaterColumns`.
    if (!(fx.clock > 0 && fx.swash && fx.surfGlow > 0)) {
        state.glowLive = false;
        state.glowValid = false;
    }
    state.glowAlpha = fx.surfGlow;
    state.glowDraw = state.glowLive && fx.surfGlow > 0;
    ctx.drawImage(state.overlay.canvas, state.overlay.x, state.overlay.y);

    // 3.2 — the path. Depends only on its own parameters, its two palette stops,
    // `base.key`, `fx.horizonTop`, and `state.mask` over the path's own rect.
    const moonPostGrade = Boolean(glint && glint.kind === 3 && mood.night > 0 && atmosphere?.lightGrade);
    if (glint) {
        const loCol = palette.path[(glint.kind - 1) * 2];
        const hiCol = palette.path[(glint.kind - 1) * 2 + 1];
        const texelKey = glint.kind === 2 ? view.texelPx : 0;
        const pathInputKey = `${base.key}|${loCol},${hiCol}|${fx.horizonTop}|${fx.deepTick}|${glint.kind}|${Math.round(glint.strength * 64)}|${Math.round((glint.growScale ?? 1) * 64)}|${Math.round((glint.body?.xFrac ?? 0.5) * 4096)}|${Math.round(view.x0)},${Math.round(view.y0)},${Math.round(view.x1)},${Math.round(view.y1)}|${texelKey}`;
        let maskOverlap = false;
        if (state.pathKey === pathInputKey && state.pathMaskEpoch !== state.maskEpoch) {
            if (!state.pathOn || !state.path.canvas) {
                maskOverlap = true;
            } else if (maskChangedBounds) {
                maskOverlap = boundsIntersect(
                    maskChangedBounds,
                    state.path.x,
                    state.path.y,
                    state.path.x + state.path.canvas.width,
                    state.path.y + state.path.canvas.height,
                );
            } else {
                maskOverlap = true;
            }
        }
        if (pathInputKey !== state.pathKey || maskOverlap) {
            const started = performance.now();
            state.pathOn = rebuildPath(state, base, fx, palette, view, glint);
            state.pathKey = pathInputKey;
            state.pathMaskEpoch = state.maskEpoch;
            state.stats.pathMs = performance.now() - started;
            state.stats.pathBuilds++;
            state.stats.pathArea = state.pathOn && state.path.canvas ? state.path.canvas.width * state.path.canvas.height : 0;
        } else {
            state.pathMaskEpoch = state.maskEpoch;
            state.stats.pathSkips++;
        }
        if (state.pathOn && !moonPostGrade) ctx.drawImage(state.path.canvas, state.path.x, state.path.y);
    }
    state.pathLive = Boolean(glint && state.pathOn);
    state.pathPostGrade = Boolean(moonPostGrade && state.pathOn);

    // 2.9 — the lamp columns land last, over the water state and the path,
    // clipped by the 2.2 footprint march (the field the resident pass binds).
    const lights = columnLights(renderer, atmosphere);
    const eligibleLights = lights.length ? lights.filter(l => columnLightEligible(base, rect, l)) : lights;
    state.stats.columns = lights.length;
    state.stats.activeColumns = eligibleLights.length;
    if (eligibleLights.length) {
        const grade = atmosphere?.lightGrade || null;
        const field = fx.march > 0 ? footprintFieldFor(renderer, GPU_LANDMARK_IDS) : null;
        const lightKey = eligibleLights.map(l => `${l.x.toFixed(1)},${l.y.toFixed(1)},${Math.round(l.height)},${Math.round(l.reach)},${Math.round(l.rgb[0] * 256)},${Math.round(l.rgb[1] * 256)},${Math.round(l.rgb[2] * 256)}`).join(';');
        const columnKey = `${base.key}|${paletteKey}|${rect.x0},${rect.y0},${rect.w},${rect.h}|${fx.columnTick}|${fx.march}:${field?.revision ?? 0}|${lightKey}`;
        if (columnKey !== state.columnKey) {
            const started = performance.now();
            state.columnsOn = rebuildColumns(state, base, fx, palette, rect, eligibleLights, grade, postFx, field);
            state.columnKey = columnKey;
            state.stats.columnMs = performance.now() - started;
            state.stats.columnBuilds++;
        }
        // Laid after the grade by `drawCanvasWaterColumns`.
        state.columnsLive = state.columnsOn === true;
    } else {
        state.columnKey = '';
        state.columnForceFull = true;
        state.columnPixels.length = 0;
        state.columns.contentBounds = null;
        state.columnsLive = false;
    }
    ctx.restore();
}
