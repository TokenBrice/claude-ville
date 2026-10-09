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
// seaPath and lampBeam stops, a column landed on the C1 emissive ramp), then
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
import { cloudCourseOffset, cloudSunlitTile, cloudTileSample } from './CloudShadowCourses.js';
import { drawCarvedTerrainLayer } from './EmitterCuts.js';
import { footprintFieldFor } from './FootprintField.js';
import {
    canvasGlint,
    canvasSeaKey,
    canvasSeaMarkRgb,
    COAST_FIELD_FLAGS,
    COAST_PALETTE,
    mirrorStormDrop,
    OCEAN_HORIZON_WORLD_Y,
    OPEN_SEA_DEEPEST,
    OPEN_SEA_LIGHT_REACH,
    openSeaDepthAt,
    openSeaHazeRows,
    openSeaStopAt,
    SEA_SEAM_ROWS,
    WATER_SUN_BAND,
    waterMoodFor,
    waterSunBandFor,
    waterSurfaceRgb,
} from './CoastBake.js';
import { BEAM_NEAR_HALF_WIDTH, FOOTPRINT_MARCH_STEPS, NOON_GLINT_GROW_GAIN } from './gpu/GpuFrameState.js';
import {
    DEEP_CREST_RUN,
    DEEP_DASH_DENSITY,
    GLINT_DASH_DENSITY,
    GLINT_NOON_BASE,
    MOON_DASH_HOLD,
    NEAR_SHORE_DASH_DENSITY,
    NOON_GLINT_FULL_TEXEL,
    GRASS_GUST_ORDER_BASE,
    GRASS_GUST_ORDER_CAP,
    GRASS_GUST_ORDER_GAIN,
    SEA_PAW_CAP_BASE,
    SEA_PAW_CAP_GAIN,
    SEA_PAW_THRESHOLD,
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
    SWELL_GAP_GAIN,
    SWELL_LIT_ROWS,
    SWELL_LONE_CAPS,
    SWELL_NEAR_FADE,
    SWELL_SET_GAIN,
    SWELL_SET_LEAD,
    SWELL_SET_NORMAL,
    SWELL_SET_PERIOD,
    SWELL_SET_SHARE,
    SWELL_SET_SHARE_OPEN,
    SWELL_SET_WARP,
    SWELL_SET_WARP_FINE,
    SWELL_SHORE_SD,
    SWELL_TROUGH_ROWS,
    SWELL_WARP_CELL,
    SWELL_WARP_FINE_CELL,
    WATER_COLUMN_GLINT,
    WATER_COLUMN_ROW_FAR,
    WATER_COLUMN_ROW_HOLD,
    WATER_COLUMN_ROW_NEAR,
} from './gpu/GpuWorldRenderer.js';
import { GPU_LANDMARK_IDS } from './gpu/GpuSceneBuilder.js';
import {
    cloudCoveredShare,
    effectBudgetMode,
    isAttentionLight,
    LIGHT_ROLE_CODES,
    lightLaysColumn,
    localLightPhaseForLighting,
    WATER_COLUMN_REACH,
} from './gpu/GpuWorldPolicy.js';
import { baseWindX, gustinessFor, windAt } from './Wind.js';
import { GRASS_GUST_STOPS } from './GroundBake.js';

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
// Chunk texel flags: bits 0-2 the stop (SEA_NONE: no caps here), then open
// water (the sunlit course and paws), a crest-line texel (its rise is the
// line's), the open sea (colour by band and haze); bits 4-5 the static rise.
const SEA_NONE = 7;
const SEA_OPEN = 8;
const SEA_RISE_SHIFT = 4;
const SEA_CREST_LINE = 64;
const SEA_OPEN_SEA = 128;
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

// LIGHTHOUSE_BEAM_GLSL beamBayer4 on a dash cell.
function beamBayer2(x, y) {
    const qx = ((Math.floor(x) % 2) + 2) % 2;
    const qy = ((Math.floor(y) % 2) + 2) % 2;
    if (qx === qy) return qx ? 0.25 : 0;
    return qx ? 0.5 : 0.75;
}
function beamBayer4(x, y) {
    return beamBayer2(x * 0.5, y * 0.5) * 0.25 + beamBayer2(x, y);
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
    const a = hash12(ix + 71, iy + 13);
    const b = hash12(ix + 72, iy + 13);
    const c = hash12(ix + 71, iy + 14);
    const d = hash12(ix + 72, iy + 14);
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
            a = hash12(jx + 71, jy + 13);
            b = hash12(jx + 72, jy + 13);
            c = hash12(jx + 71, jy + 14);
            d = hash12(jx + 72, jy + 14);
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
    if (tin >= 0 && tin < trough && (tin < trough * 0.5 || order >= (tin - trough * 0.5) / (trough * 0.5))) return 1;
    const lin = period - rowsIn;
    return lin < lit && (lin < lit * 0.5 || order >= (lin - lit * 0.5) / (lit * 0.5)) ? -1 : 0;
}

// 3.3 (a) — the resident sea body terms (SEA_SWELL_GLSL swellPhase,
// swellHeight, swellCrest, seaKeyReach, seaBodyStop) on one world texel,
// each noise field on its own cached lattice.
function seaField() {
    const warp = latticeNoise();
    const warpFine = latticeNoise();
    const height = latticeNoise();
    const crestHeight = latticeNoise();
    const key = latticeNoise();
    const chopWarp = latticeNoise();
    const chopHeight = latticeNoise();
    const normal = SWELL_SET_NORMAL[0];
    const swellHeight = (noise, along, set) => clamp01((noise(along / SWELL_AMP_RUN + 17, set * 7.3) - SWELL_AMP_FLOOR) / SWELL_AMP_SPAN);
    const field = {
        phase(x, y) {
            return (x * normal + y) / SWELL_SET_PERIOD
                + SWELL_SET_WARP * warp(x / SWELL_WARP_CELL[0] + 3, y / SWELL_WARP_CELL[1] + 11)
                + SWELL_SET_WARP_FINE * warpFine(x / SWELL_WARP_FINE_CELL[0] + 29, y / SWELL_WARP_FINE_CELL[1] + 5);
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
            if (dx >= halfLen || swellHeight(crestHeight, centre, set) <= SWELL_CREST_HEIGHT) return 0;
            const r = rowsIn - Math.floor(Math.max(0, dx - halfLen + 4) * 0.5);
            return r < 0 ? 0 : (r < 1 ? SWELL_CREST_RISE[0] : (r < SWELL_CREST_ROWS ? SWELL_CREST_RISE[1] : 0));
        },
        keyReach(x, y) {
            const dx = x + 0.5 - SEA_KEY_SHIFT[0];
            const dy = (y + 0.5 - (MAP_SIZE - 1) * TILE_HEIGHT * 0.5 - SEA_KEY_SHIFT[1]) * 2;
            return Math.sqrt(dx * dx + dy * dy) - SEA_KEY_REACH + (key(x / 700 + 5, y / 350 + 9) - 0.5) * 2 * SEA_KEY_WOBBLE;
        },
        body(x, y, s, stop, excess, order) {
            if (clamp01((y - OCEAN_HORIZON_WORLD_Y - SEA_BODY_ROWS[0]) / (SEA_BODY_ROWS[1] - SEA_BODY_ROWS[0])) <= order) return stop;
            const key = clamp01(0.5 - field.keyReach(x, y) / SEA_KEY_SPAN);
            const calm = clamp01((excess - SWELL_CALM_TILES[0]) / (SWELL_CALM_TILES[1] - SWELL_CALM_TILES[0]));
            const along = x - normal * y;
            const h = swellHeight(height, along, Math.floor(s));
            let form = swellForm(fract(s) * SWELL_SET_PERIOD, SWELL_SET_PERIOD, SWELL_CREST_ROWS,
                (SWELL_LIT_ROWS[0] + (SWELL_LIT_ROWS[1] - SWELL_LIT_ROWS[0]) * key) * h,
                (SWELL_TROUGH_ROWS[0] + (SWELL_TROUGH_ROWS[1] - SWELL_TROUGH_ROWS[0]) * key) * h * calm, order);
            if (form === 0) {
                const c = (x * normal + y) / SWELL_CHOP_PERIOD
                    + SWELL_CHOP_WARP * chopWarp(x / SWELL_CHOP_WARP_CELL[0] + 41, y / SWELL_CHOP_WARP_CELL[1] + 23);
                const ch = clamp01((chopHeight(along / SWELL_CHOP_RUN + 7, Math.floor(c) * 5.1) - SWELL_CHOP_FLOOR) / SWELL_AMP_SPAN);
                form = swellForm(fract(c) * SWELL_CHOP_PERIOD, SWELL_CHOP_PERIOD, 0,
                    (SWELL_CHOP_LIT_ROWS[0] + (SWELL_CHOP_LIT_ROWS[1] - SWELL_CHOP_LIT_ROWS[0]) * key) * ch,
                    (SWELL_CHOP_TROUGH_ROWS[0] + (SWELL_CHOP_TROUGH_ROWS[1] - SWELL_CHOP_TROUGH_ROWS[0]) * key) * ch * calm, order);
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

function layerCanvas(layer, w, h) {
    if (!layer.canvas || layer.canvas.width !== w || layer.canvas.height !== h) {
        layer.canvas ||= document.createElement('canvas');
        layer.canvas.width = w;
        layer.canvas.height = h;
        layer.ctx = layer.canvas.getContext('2d');
        layer.image = new ImageData(w, h);
        layer.u32 = new Uint32Array(layer.image.data.buffer);
    } else {
        layer.u32.fill(0);
    }
    return layer;
}

// ---------------------------------------------------------------------------
// The terrain base: texel classes and the per-bake lists, once per terrain
// cache and coast-field revision.

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
    const nearCells = [];
    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
            const offset = cycleOffset[r * cols + c];
            if (offset >= 32) continue;
            const X = fx + c * 2;
            const Y = fy + r * 2;
            for (let y = Y; y < Y + 2; y++) {
                for (let x = X; x < X + 2; x++) {
                    if (((x % 3) + 3) % 3 !== 0) continue;
                    const cx = x / 3;
                    const h = hash12(cx, y);
                    if (h >= STORM_DASH_DENSITY) continue;
                    nearCells.push([offset & 15, x, y, Math.floor(h * 256), hash12(cx + 17, y + 31) < 0.25 ? 1 : 0]);
                }
            }
        }
    }
    nearCells.sort((a, b) => a[0] - b[0]);
    const near = {
        start: new Int32Array(17),
        x: new Int16Array(nearCells.length),
        y: new Int16Array(nearCells.length),
        h: new Uint8Array(nearCells.length),
        cap: new Uint8Array(nearCells.length),
    };
    nearCells.forEach(([bucket, x, y, h, cap], i) => {
        near.start[bucket + 1] = i + 1;
        near.x[i] = x;
        near.y[i] = y;
        near.h[i] = h;
        near.cap[i] = cap;
    });
    for (let b = 1; b <= 16; b++) near.start[b] = Math.max(near.start[b], near.start[b - 1]);
    base.near = near;

    // 3.10 specks (static) and the caustic net's eight states on stops 0-1.
    const specks = [];
    const caustic = Array.from({ length: 8 }, () => []);
    for (let ty = 0; ty < th; ty++) {
        const y = by + ty;
        for (let tx = 0; tx < tw; tx++) {
            const i = ty * tw + tx;
            const k = cls[i];
            const x = bx + tx;
            if (k > 1) continue;
            if (hash12(Math.floor(x / 2) + 3, y + 71) < 0.04) specks.push(i);
            const a = (x * 0.5 + y) / 9 + 0.45 * Math.sin((x * 0.5 - y) * 0.13);
            const b = (y - x * 0.5) / 13 + 0.45 * Math.sin((x * 0.5 + y) * 0.09);
            for (let s = 0; s < 8; s++) {
                if (fract(a + s / 8) >= 0.92 || fract(b - s / 8) >= 0.92) caustic[s].push(i);
            }
        }
    }
    base.specks = Uint32Array.from(specks);
    base.caustic = caustic.map(list => Uint32Array.from(list));

    // 3.6 swash states (8 x 200 ms) and 3.7 ripple texels, off the coast field.
    const swash = Array.from({ length: 8 }, () => []);
    const ripple = [];
    const reflectionAt = (x, y) => {
        const c = Math.floor((x - fx) / 2);
        const r = Math.floor((y - fy) / 2);
        if (c < 0 || r < 0 || c >= cols || r >= rows || texelAt(x, y) < 0) return false;
        return (coastField[(r * cols + c) * 2 + 1] & COAST_FIELD_FLAGS.reflection) !== 0;
    };
    const colourAt = (i) => (src[i * 4] << 16) | (src[i * 4 + 1] << 8) | src[i * 4 + 2];
    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
            const cell = (r * cols + c) * 2;
            const flags = coastField[cell + 1];
            if (!(flags & (COAST_FIELD_FLAGS.swash | COAST_FIELD_FLAGS.reflection))) continue;
            const sd = (coastField[cell] - 128) / 64;
            for (let oy = 0; oy < 2; oy++) {
                for (let ox = 0; ox < 2; ox++) {
                    const x = fx + c * 2 + ox;
                    const y = fy + r * 2 + oy;
                    const i = texelAt(x, y);
                    if (i < 0) continue;
                    const k = cls[i];
                    if (flags & COAST_FIELD_FLAGS.swash) {
                        for (let cyc = 0; cyc < 8; cyc++) {
                            const code = swashCode(k, sd, cyc, x, y);
                            if (code) swash[cyc].push(i, code);
                        }
                    }
                    if (flags & COAST_FIELD_FLAGS.reflection) {
                        const own = colourAt(i);
                        const left = reflectionAt(x - 1, y) ? colourAt(i - 1) : own;
                        const right = reflectionAt(x + 1, y) ? colourAt(i + 1) : own;
                        if (left === own && right === own) continue;
                        ripple.push(i, Math.floor(hash12(y, 7) * 8), left, right);
                    }
                }
            }
        }
    }
    base.swash = swash.map(list => Uint32Array.from(list));
    base.ripple = Uint32Array.from(ripple);

    // 2.9 — the colour of every column-receiving texel (coast flag `water`,
    // not `covered`) that is no water class (a baked mirror, a dither
    // blend), by ascending texel index, for the column landing.
    const recvIdx = [];
    const recvRgb = [];
    for (let ty = 0; ty < th; ty++) {
        const r = Math.floor((by + ty - fy) / 2);
        if (r < 0 || r >= rows) continue;
        for (let tx = 0; tx < tw; tx++) {
            const i = ty * tw + tx;
            if (cls[i] <= CLS_CREST || cls[i] === CLS_EMPTY) continue;
            const c = Math.floor((bx + tx - fx) / 2);
            if (c < 0 || c >= cols) continue;
            const flags = coastField[(r * cols + c) * 2 + 1];
            if (!(flags & COAST_FIELD_FLAGS.water) || (flags & COAST_FIELD_FLAGS.covered)) continue;
            recvIdx.push(i);
            recvRgb.push(colourAt(i));
        }
    }
    base.recvIdx = Uint32Array.from(recvIdx);
    base.recvRgb = Uint32Array.from(recvRgb);
    base.buildMs = performance.now() - started;
    return base;
}

// 3.6 applyCoastSwash on one texel of class `k`: 0 unchanged, else the class
// it becomes (CLS_FOAM, CLS_CREST, CLS_WET, CLS_WET_DARK).
function swashCode(k, sd, cyc, x, y) {
    const reach = cyc < 4 ? cyc : (cyc < 7 ? 6 - cyc : 0);
    if (sd > 0) {
        if (k > 5 && k !== CLS_FOAM && k !== CLS_CREST) return 0;
        const front = 0.05 + reach * 0.035;
        let out = 0;
        if (sd < front - 0.035) out = CLS_FOAM;
        else if (sd < front) out = CLS_CREST;
        else if (sd < front + 0.06 && waterBayer4(x, y) < 0.5) out = CLS_FOAM;
        return out === k ? 0 : out;
    }
    const extent = cyc < 4 ? cyc : 3;
    const darker = cyc < 4.5 ? 2 : (cyc < 6.5 ? 1 : 0);
    if (darker < 0.5 || sd <= -0.02 - extent * 0.035) return 0;
    if (k === CLS_WET_DARK) return 0;
    if (k === CLS_WET) return CLS_WET_DARK;
    if (k === CLS_BEACH) return darker > 1.5 ? CLS_WET_DARK : CLS_WET;
    return 0;
}

// ---------------------------------------------------------------------------
// The deep swell field (3.1 deepSwellLit) per world chunk.

function buildChunk(cx, cy, storm) {
    const wavelength = storm ? 14 : 22;
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
            if (h >= STORM_DASH_DENSITY) continue;
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

function buildCapChunk(base, cx, cy) {
    const X0 = cx * CHUNK_W;
    const Y0 = cy * CHUNK_H;
    const info = new Uint8Array(CHUNK_W * CHUNK_H).fill(SEA_NONE);
    const { cls, fx: fieldX, fy: fieldY, cols, rows, coastField } = base;
    const field = seaField();
    const body = [];
    for (let ly = 0; ly < CHUNK_H; ly++) {
        const y = Y0 + ly;
        if (y < OCEAN_HORIZON_WORLD_Y) continue;
        const r = Math.floor((y - fieldY) / 2);
        for (let lx = 0; lx < CHUNK_W; lx++) {
            const x = X0 + lx;
            const i = base.texelAt(x, y);
            const k = i < 0 ? CLS_EMPTY : cls[i];
            let v = SEA_NONE;
            if (k === CLS_EMPTY) {
                v = seaStopAt(x, y) | SEA_OPEN | SEA_OPEN_SEA;
            } else if (k >= 2 && k <= 5) {
                if (k >= seaStopAt(x, y)) {
                    v = k | SEA_OPEN;
                } else {
                    const c = Math.floor((x - fieldX) / 2);
                    if (c >= 0 && r >= 0 && c < cols && r < rows) {
                        const cell = (r * cols + c) * 2;
                        if ((coastField[cell + 1] & COAST_FIELD_FLAGS.sea) && (coastField[cell] - 128) / 64 > SWELL_SHORE_SD) v = k;
                    }
                }
            }
            if (v !== SEA_NONE) {
                const idx = ly * CHUNK_W + lx;
                const s = field.phase(x, y);
                if (v & SEA_OPEN) {
                    const painted = v & 7;
                    const shown = field.body(x, y, s, painted, excessAt(x, y), waterBayer4(x, y));
                    if (shown !== painted) {
                        v = (v & ~7) | shown;
                        body.push(idx);
                    }
                }
                // Each set's crest strokes: a stroke texel keeps its rise.
                const crest = field.crest(x, y, s);
                if (crest) v |= SEA_CREST_LINE | (crest << SEA_RISE_SHIFT);
                info[idx] = v;
            }
        }
    }
    const cells = seaField();
    // The caps: one per half-staggered cap cell, gathered into clusters.
    const [cw, ch] = SWELL_CAP_CELL;
    const [kw, kh] = SWELL_CLUSTER_CELL;
    const pawIdx = [];
    const pawGust = [];
    const pawRise = [];
    for (let row = Math.floor(Y0 / ch); row * ch < Y0 + CHUNK_H; row++) {
        const shift = posMod(row, 2) * cw * 0.5;
        const kx1 = Math.floor((X0 + CHUNK_W + shift) / cw) + 1;
        for (let kx = Math.floor((X0 + shift) / cw) - 1; kx <= kx1; kx++) {
            const hp = hash12(kx + 211, row + 17);
            if (hp >= SWELL_CLUSTER_CAPS) continue;
            const centreX = kx * cw + cw * 0.5 - shift;
            const centreY = (row + 0.5) * ch;
            const inSet = fract(cells.phase(centreX, centreY) + SWELL_SET_LEAD) < SWELL_SET_SHARE_OPEN;
            const crow = Math.floor(centreY / kh);
            const clusterX = centreX + posMod(crow, 2) * kw * 0.5;
            const ckx = Math.floor(clusterX / kw);
            const hc = hash12(ckx + 101, crow + 7);
            const ex = (clusterX - (ckx + 0.35 + 0.3 * hash12(ckx + 103, crow + 9)) * kw) / (kw * 0.5);
            const ey = (centreY - (crow + 0.35 + 0.3 * hash12(ckx + 107, crow + 3)) * kh) / (kh * 0.5);
            const inEllipse = ex * ex + ey * ey < 1;
            const len = 3 + Math.floor(hash12(kx + 223, row + 5) * 5);
            const x0 = Math.floor(hash12(kx + 227, row + 41) * (cw - len));
            const y0 = Math.floor(hash12(kx + 229, row + 83) * (ch - 1));
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
                    // A paw lights this texel when its gust passes both the
                    // ruffled threshold (`seaPawAt`: the ruffle and order are
                    // static) and the cluster's headroom: one gust threshold.
                    if ((v & SEA_OPEN) && inEllipse && !inCluster && rise < clusterRise) {
                        const ruffle = cloudTileSample(fract((x + 517) / 768) * 256, fract((y + 229) / 256) * 256);
                        const bias = (ruffle - 0.5) * 0.36 + (waterBayer4(x, y) - 0.5) * 0.06;
                        const gust = Math.max(0, SEA_PAW_THRESHOLD - bias, (hc - clusters - SEA_PAW_CAP_BASE) / SEA_PAW_CAP_GAIN);
                        if (gust < 1) {
                            pawIdx.push(idx);
                            pawGust.push(gust);
                            pawRise.push(clusterRise);
                        }
                    }
                }
            }
        }
    }
    const lit = [];
    for (let idx = 0; idx < info.length; idx++) {
        if (info[idx] >> SEA_RISE_SHIFT & 3) lit.push(idx);
    }
    // W6.11 — the grass gust course's candidates (the resident
    // GRASS_GUST_GLSL): each grass pixel at a ramp's stop 3 (classified on
    // its own, as the resident test reads each fragment's albedo) whose 2x1
    // texel's static order can pass, with the gust it needs to lift.
    const grassIdx = [];
    const grassNeed = [];
    const grassK = [];
    for (let ly = 0; ly < CHUNK_H; ly++) {
        const y = Y0 + ly;
        let lastTx = NaN;
        let need = -1;
        for (let lx = 0; lx < CHUNK_W; lx++) {
            const i = base.texelAt(X0 + lx, y);
            const k = i < 0 ? -1 : cls[i] - CLS_GRASS;
            if (k < 0 || k >= GRASS_GUST_STOPS.length) continue;
            const tx = Math.floor((X0 + lx) / 2);
            if (tx !== lastTx) {
                lastTx = tx;
                const ruffle = cloudTileSample(fract((tx + 311) / 384) * 256, fract((y + 173) / 256) * 256);
                const order = ruffle * 0.5 + waterBayer4(tx, y) * 0.5;
                need = order >= GRASS_GUST_ORDER_CAP ? -1 : Math.max(0, (order - GRASS_GUST_ORDER_BASE) / GRASS_GUST_ORDER_GAIN);
            }
            if (need < 0) continue;
            grassIdx.push(ly * CHUNK_W + lx);
            grassNeed.push(need);
            grassK.push(k);
        }
    }
    return {
        info,
        lit: Int32Array.from(lit),
        body: Int32Array.from(body),
        pawIdx: Int32Array.from(pawIdx),
        pawGust: Float32Array.from(pawGust),
        pawRise: Uint8Array.from(pawRise),
        pawKey: '',
        pawLit: null,
        grassIdx: Int32Array.from(grassIdx),
        grassNeed: Float32Array.from(grassNeed),
        grassK: Uint8Array.from(grassK),
        grassKey: '',
        grassLit: null,
        // The chunk's body and sunlit canvases (`chunkSeaCanvas`), per palette.
        bodyCanvas: null,
        bodyKey: '',
        liftCanvas: null,
        liftKey: '',
    };
}

// ---------------------------------------------------------------------------
// Palette: every colour a layer writes, through the Canvas water transform.

function buildPalette(atmosphere, postFx, storm) {
    const mood = waterMoodFor(atmosphere);
    const sunBand = waterSunBandFor(atmosphere);
    const band = 1 + (WATER_SUN_BAND - 1) * sunBand;
    const grade = atmosphere?.lightGrade || null;
    const water = rgb01 => u32Of(CanvasGrade.canvasWaterPreimage(waterSurfaceRgb(rgb01, mood, sunBand), grade, { postFx }));
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
    const classes = [];
    classes[CLS_FOAM] = water(to01(COAST_PALETTE.foam));
    classes[CLS_CREST] = water(to01(COAST_PALETTE.foamCrest));
    classes[CLS_WET] = u32Of(to01(COAST_PALETTE.wetSand));
    classes[CLS_WET_DARK] = u32Of(to01(COAST_PALETTE.wetSandDark));
    // The path: graded, held at HSL L <= 0.70 (seaPathCap), painted as the
    // preimage of that; the beam keeps its lampBeam stop through the grade.
    const pathOut = (hex) => {
        const raw = hexRgb01(hex).map(v => v * band);
        if (!grade) return u32Of(raw);
        const graded = CanvasGrade.canvasFrameGradeRgb(raw, grade, { postFx });
        const l = 0.5 * (Math.max(...graded) + Math.min(...graded));
        return u32Of(l > 0.70 ? CanvasGrade.canvasFramePreimage(graded.map(v => v * 0.70 / l), grade, { postFx }) : raw);
    };
    const path = ART_RAMPS.seaPath.map(pathOut);
    const beamOut = hex => u32Of(CanvasGrade.canvasFramePreimage(hexRgb01(hex).map(v => v * band), grade, { postFx }));
    const beam = [beamOut(ART_RAMPS.lampBeam[0]), beamOut(ART_RAMPS.lampBeam[0]), beamOut(ART_RAMPS.lampBeam[1])];
    const mirrorMemo = new Map();
    const waterMemo = new Map();
    const convert = (memo, colour, capped) => {
        let out = memo.get(colour);
        if (out === undefined) {
            const c = [(colour >> 16) / 255, ((colour >> 8) & 255) / 255, (colour & 255) / 255];
            const moody = waterSurfaceRgb(c, mood, sunBand);
            out = u32Of(capped ? CanvasGrade.canvasWaterPreimage(moody, grade, { postFx }) : moody);
            memo.set(colour, out);
        }
        return out;
    };
    return {
        stops,
        staticDash,
        classes,
        specks: COAST_PALETTE.seabedSpecks.map(rgb => water(to01(rgb))),
        caustics: COAST_PALETTE.caustics.map(rgb => water(to01(rgb))),
        path,
        beam,
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
        storm: type === 'storm' ? 1 : 0,
        rain: raining && effectBudgetMode('rainRings', level) !== 'off'
            ? clamp01(weather.precipitation ?? weather.intensity)
            : 0,
        caustics: effectBudgetMode('shallowCaustics', level) === 'on'
            && !raining
            && (Number(grade.sunBand) || 0) > 0.3
            && clamp01(weather.cloudCover) < 0.5
            && (Number(grade.night) || 0) < 0.5
            && zoom >= 2,
        swash: effectBudgetMode('coastSwash', level) === 'on' && motion > 0,
        // 3.4 — the sunlit course and the cat's paws shed at MINIMAL.
        seaWeather: effectBudgetMode('sea-weather', level) === 'on',
        // W6.11 — the grass gust course: FULL only, never under reduced motion.
        grassGust: effectBudgetMode('grassGust', level) === 'on' && motion > 0,
        deepTick: Math.floor(t * 0.006 * clock),
        nearTick: Math.floor(t * 0.004 * clock),
        ringTick: Math.floor(t * 0.007 * clock),
        swashCyc: Math.floor(t * 0.005 * clock) % 8,
        rippleTick: Math.floor(t * 0.002 * clock),
        // 3.7 — heavy rain gives this share of the mirror texels back to
        // the water (the mood layer shows their stop); they no longer ripple.
        mirrorDrop: mirrorStormDrop(weather),
        columnTick: Math.floor(t * COLUMN_TICK_RATE * clock),
        // 2.2 — the column's footprint march (FULL 8, REDUCED 4, MINIMAL 0).
        march: FOOTPRINT_MARCH_STEPS[effectBudgetMode('footprint-occlusion', level)] ?? 0,
        horizonTop: OCEAN_HORIZON_WORLD_Y + openSeaHazeRows(weather.fog),
    };
}

// ---------------------------------------------------------------------------
// The step overlay.

// `sea`: the frame's cap chunks (`caps`), the sunlit tile and its offset
// (`sun`, null when off) and the gust field (`gust`, null in calm air).
function rebuildOverlay(state, base, fx, palette, rect, renderer, sea) {
    const { x0, y0, w, h } = rect;
    const layer = layerCanvas(state.overlay, w, h);
    const out = layer.u32;
    const mask = state.mask && state.mask.length === w * h ? state.mask.fill(0) : (state.mask = new Uint8Array(w * h));
    // The swell rise each texel holds (a cap, a paw cap), so a crest over it
    // takes whichever is lighter.
    const riseMap = state.rise && state.rise.length === w * h ? state.rise.fill(0) : (state.rise = new Uint8Array(w * h));
    const { tw, bx, by, cls, fx: fieldX, fy: fieldY, cols, rows, cycleOffset } = base;
    const x1 = x0 + w;
    const y1 = y0 + h;
    const at = (x, y) => (y - y0) * w + (x - x0);
    const inRect = (x, y) => x >= x0 && x < x1 && y >= y0 && y < y1;
    const clock = fx.clock;
    const storm = fx.storm;
    // Terrain lists hold texel indices; walk only the rows in the rect.
    const eachTexel = (list, stride, fn) => {
        for (let k = 0; k < list.length; k += stride) {
            const i = list[k];
            const y = by + ((i / tw) | 0);
            if (y < y0 || y >= y1) continue;
            const x = bx + (i - (y - by) * tw);
            if (x < x0 || x >= x1) continue;
            fn(i, x, y, k);
        }
    };
    // A texel's cap-chunk flags (SEA_NONE until its chunk is built).
    let lastId = -1;
    let lastChunk = null;
    const infoAt = (x, y) => {
        const cx = Math.floor(x / CHUNK_W);
        const cy = Math.floor(y / CHUNK_H);
        const id = chunkId(cx, cy);
        if (id !== lastId) {
            lastId = id;
            lastChunk = sea.caps.get(id) || null;
        }
        return lastChunk ? lastChunk.info[(y - cy * CHUNK_H) * CHUNK_W + (x - cx * CHUNK_W)] : SEA_NONE;
    };
    // 3.4 — one stop lighter on open water inside the sunlit course.
    const sun = sea.sun;
    const sunWrap = sun ? sun.size - 1 : 0;
    const sunAt = (v, x, y) => (sun && (v & SEA_OPEN) && sun.mask[((y + sun.oy) & sunWrap) * sun.size + ((x + sun.ox) & sunWrap)] ? 1 : 0);
    // The stop an in-map texel of class `k` shows: an open texel's body stop
    // (3.3 (a)), less the sunlit course.
    const shownStop = (k, x, y) => {
        const v = infoAt(x, y);
        return ((v & SEA_OPEN) ? (v & 7) : k) - sunAt(v, x, y);
    };
    // A marked sea texel `lighter` stops above its stop: the open sea's by its
    // band and haze course, the in-map water's stop.
    const markColour = (v, x, y, lighter) => {
        const s = Math.max(0, (v & 7) - lighter);
        if (v & SEA_OPEN_SEA) {
            const c = canvasSeaMarkRgb(renderer, s, x, y, true);
            if (c >= 0) return ((255 << 24) | ((c & 255) << 16) | (c & 0xff00) | (c >> 16)) >>> 0;
        }
        return palette.stops[s];
    };
    // 3.7 — the reflection row ripple (on the water clock only).
    if (clock > 0) {
        eachTexel(base.ripple, 4, (i, x, y, k) => {
            const phase = (base.ripple[k + 1] + fx.rippleTick) % 8;
            if (phase !== 0 && phase !== 4) return;
            if (fx.mirrorDrop > 0 && CB_BAYER4[((y & 3) << 2) | (x & 3)] < fx.mirrorDrop * 16) return;
            const colour = base.ripple[k + (phase === 0 ? 2 : 3)];
            out[at(x, y)] = palette.ripple(colour);
        });
    }
    // 3.3 (a) / 3.4 — the static swell caps and crest lines, then the caps a
    // cat's paw lays (open water, on the gust step), every level.
    const gust = sea.gust;
    for (let cy = Math.floor(y0 / CHUNK_H); cy * CHUNK_H < y1; cy++) {
        for (let cx = Math.floor(x0 / CHUNK_W); cx * CHUNK_W < x1; cx++) {
            const chunk = sea.caps.get(chunkId(cx, cy));
            if (!chunk) continue;
            const X0 = cx * CHUNK_W;
            const Y0 = cy * CHUNK_H;
            const lit = chunk.lit;
            for (let n = 0; n < lit.length; n++) {
                const idx = lit[n];
                const ly = (idx / CHUNK_W) | 0;
                const x = X0 + idx - ly * CHUNK_W;
                const y = Y0 + ly;
                if (!inRect(x, y)) continue;
                const v = chunk.info[idx];
                const rise = v >> SEA_RISE_SHIFT & 3;
                const p = at(x, y);
                riseMap[p] = rise;
                out[p] = markColour(v, x, y, rise + sunAt(v, x, y));
            }
            if (!gust) continue;
            // The chunk's paw caps for this gust step (static otherwise).
            if (chunk.pawKey !== gust.key) {
                const on = [];
                for (let n = 0; n < chunk.pawIdx.length; n++) {
                    const idx = chunk.pawIdx[n];
                    const ly = (idx / CHUNK_W) | 0;
                    if (gustAt(gust, X0 + idx - ly * CHUNK_W, Y0 + ly) > chunk.pawGust[n]) on.push(n);
                }
                chunk.pawLit = Int32Array.from(on);
                chunk.pawKey = gust.key;
            }
            for (const n of chunk.pawLit) {
                const idx = chunk.pawIdx[n];
                const ly = (idx / CHUNK_W) | 0;
                const x = X0 + idx - ly * CHUNK_W;
                const y = Y0 + ly;
                if (!inRect(x, y)) continue;
                const v = chunk.info[idx];
                const rise = chunk.pawRise[n];
                const p = at(x, y);
                riseMap[p] = rise;
                out[p] = markColour(v, x, y, rise + sunAt(v, x, y));
            }
            if (!fx.grassGust) continue;
            // W6.11 — the chunk's grass gust course for this gust step: the
            // gust is read at each 2x1 texel's left pixel (the resident
            // `seaGustAt(texel.x * 2)`), and each lifted stop-3 pixel takes
            // its own ramp's stop 4.
            if (chunk.grassKey !== gust.key) {
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
                chunk.grassLit = Int32Array.from(on);
                chunk.grassKey = gust.key;
            }
            for (const n of chunk.grassLit) {
                const idx = chunk.grassIdx[n];
                const ly = (idx / CHUNK_W) | 0;
                const x = X0 + idx - ly * CHUNK_W;
                const y = Y0 + ly;
                if (inRect(x, y)) out[at(x, y)] = GRASS_GUST_LIFT[chunk.grassK[n]];
            }
        }
    }
    // Static frame: today's static dashes under the phase-0 caustics (a cap
    // keeps its rise).
    if (clock <= 0) {
        const cw = storm ? 6 : 8;
        const ch = storm ? 3 : 4;
        const presence = storm ? 0.55 : 0.30;
        for (let cy = Math.floor(y0 / ch); cy * ch < y1; cy++) {
            for (let cx = Math.floor(x0 / cw); cx * cw < x1; cx++) {
                const seed = fract(Math.sin(cx * 12.9898 + cy * 78.233) * 43758.5453);
                if (fract(seed * 31.7) > presence || Math.floor(seed * 4) % 4 !== 0) continue;
                const dashX = cx * cw + Math.floor(seed * (cw - 2));
                const y = cy * ch + Math.floor(fract(seed * 7.13) * ch);
                for (let x = dashX; x <= dashX + 2; x++) {
                    if (!inRect(x, y) || riseMap[at(x, y)]) continue;
                    const i = base.texelAt(x, y);
                    const k = i < 0 ? CLS_EMPTY : cls[i];
                    if (k <= 5) out[at(x, y)] = palette.staticDash[shownStop(k, x, y)];
                }
            }
        }
    }
    if (fx.caustics) {
        const list = base.caustic[clock > 0 ? Math.floor(fx.t * 0.004 * clock) % 8 : 0];
        eachTexel(list, 1, (i, x, y) => { out[at(x, y)] = palette.caustics[cls[i]]; });
    }
    if (clock > 0) {
        // 3.1 — near shore and river current: entries 14 (the lead, the next
        // shallower colour) and 15 (one stop lighter, or a cap's rise).
        const near = base.near;
        const density = (storm ? STORM_DASH_DENSITY : NEAR_SHORE_DASH_DENSITY) * 256;
        for (const course of [1, 2]) {
            const bucket = (((course === 2 ? 14 : 15) - fx.nearTick) % 16 + 16) % 16;
            for (let n = near.start[bucket]; n < near.start[bucket + 1]; n++) {
                if (near.h[n] >= density) continue;
                const ox = near.x[n];
                const y = near.y[n];
                if (y < y0 || y >= y1 || ox + 3 <= x0 || ox >= x1) continue;
                const cap = storm && near.cap[n];
                for (let x = ox; x < ox + 3; x++) {
                    if (!inRect(x, y)) continue;
                    const i = base.texelAt(x, y);
                    if (i < 0) continue;
                    const k = cls[i];
                    if (k > 5) continue;
                    const p = at(x, y);
                    if (cap) {
                        out[p] = palette.classes[CLS_FOAM];
                        continue;
                    }
                    const b = shownStop(k, x, y);
                    out[p] = course === 2
                        ? (b <= 1 ? palette.classes[CLS_CREST] : palette.stops[b - 1])
                        : palette.stops[Math.max(b - Math.max(riseMap[p], 1), 0)];
                }
            }
        }
        // 3.1 — deep swell crests on the world phase field (in-map deep
        // stops outside the near-shore band, and the open sea): one stop
        // lighter, two where the swell shoals near the island, or a cap's
        // rise, whichever is lighter.
        const lead = ((-fx.deepTick % 16) + 16) % 16;
        const trail = (lead + 1) % 16;
        const inMapDensity = storm ? STORM_DASH_DENSITY : null;
        const seaDensity = (storm ? STORM_DASH_DENSITY : DEEP_DASH_DENSITY) * 256;
        const offsetAt = (x, y) => {
            const c = Math.floor((x - fieldX) / 2);
            const r = Math.floor((y - fieldY) / 2);
            return c < 0 || r < 0 || c >= cols || r >= rows ? 255 : cycleOffset[r * cols + c];
        };
        for (let cy = Math.floor(y0 / CHUNK_H); cy * CHUNK_H < y1; cy++) {
            for (let cx = Math.floor(x0 / CHUNK_W); cx * CHUNK_W < x1; cx++) {
                const chunk = state.chunks.get(`${cx},${cy},${storm}`);
                if (!chunk) continue;
                for (const bucket of [lead, trail]) {
                    const isLead = bucket === lead;
                    for (let n = chunk.start[bucket]; n < chunk.start[bucket + 1]; n++) {
                        const index = chunk.index[n];
                        const ly = (index / CHUNK_CELLS_X) | 0;
                        const y = cy * CHUNK_H + ly;
                        if (y < y0 || y >= y1) continue;
                        const cellX = cx * CHUNK_CELLS_X + (index - ly * CHUNK_CELLS_X);
                        const ox = cellX * 3;
                        if (ox + 3 <= x0 || ox >= x1) continue;
                        const hq = chunk.h[n];
                        const wave = Math.floor((chunk.B[n] + fx.deepTick) / 16);
                        if (hash12(wave + 59, Math.floor((ox - y * SWELL_SET_NORMAL[0]) / DEEP_CREST_RUN) + 11) >= SWELL_SET_SHARE) continue;
                        const cap = storm && hash12(cellX + 17, y + 31) < 0.25;
                        let origin = -1;
                        for (let x = ox; x < ox + 3; x++) {
                            if (!inRect(x, y)) continue;
                            if (!isLead && waterBayer4(x, y) < 0.5) continue;
                            const i = base.texelAt(x, y);
                            const k0 = i < 0 ? CLS_EMPTY : cls[i];
                            if (k0 === CLS_EMPTY) {
                                if (y < OCEAN_HORIZON_WORLD_Y || hq >= seaDensity) continue;
                            } else {
                                if (k0 > 5 || k0 < 2) continue;
                                if (origin < 0) origin = offsetAt(ox, y);
                                if (origin !== 255) continue;
                                const density = (inMapDensity ?? (k0 >= 3 ? DEEP_DASH_DENSITY : NEAR_SHORE_DASH_DENSITY)) * 256;
                                if (hq >= density) continue;
                            }
                            const p = at(x, y);
                            if (cap) {
                                out[p] = palette.classes[CLS_FOAM];
                                continue;
                            }
                            const v = infoAt(x, y);
                            if (k0 === CLS_EMPTY && v === SEA_NONE) continue;
                            const crest = (v & 7) !== SEA_NONE && seaNearAt(x, y) > 0.8 ? 2 : 1;
                            const lighter = Math.max(riseMap[p], crest);
                            out[p] = (v & 7) === SEA_NONE ? palette.stops[Math.max(k0 - lighter, 0)] : markColour(v, x, y, lighter + sunAt(v, x, y));
                        }
                    }
                }
            }
        }
    }
    // 3.10 — seabed specks, every level.
    eachTexel(base.specks, 1, (i, x, y) => { out[at(x, y)] = palette.specks[cls[i]]; });
    // 3.9 — rain rings, one stop lighter (FOAM on the shallowest stop).
    if (fx.rain > 0) {
        const sw = storm ? 8 : 12;
        const sh = storm ? 4 : 6;
        const rx = storm ? 2 : 4;
        const ry = storm ? 1 : 2;
        const live = 0.55 * fx.rain;
        for (let cy = Math.floor(y0 / sh); cy * sh < y1; cy++) {
            for (let cx = Math.floor(x0 / sw); cx * sw < x1; cx++) {
                const seed = hash12(cx + 41, cy + 7);
                let stage = 2;
                let life = 0;
                if (clock > 0) {
                    const s = fx.ringTick + Math.floor(seed * 5);
                    life = Math.floor(s / 5);
                    stage = s % 5;
                    if (hash12(cx + life * 1.7, cy + 3.1) >= live) continue;
                } else if (seed >= Math.min(0.20, live)) {
                    continue;
                }
                if (stage > 3 || (storm && stage > 2)) continue;
                const centreX = cx * sw + rx + Math.floor(hash12(cx + life, cy + 13) * (sw - rx * 2));
                const centreY = cy * sh + ry + Math.floor(hash12(cx + 29, cy + life) * (sh - ry * 2));
                for (const [dx, dy] of RING_STAGES[stage]) {
                    const x = centreX + dx;
                    const y = centreY + dy;
                    if (!inRect(x, y)) continue;
                    const i = base.texelAt(x, y);
                    const k = i < 0 ? CLS_EMPTY : cls[i];
                    if (k > 5) continue;
                    const b = shownStop(k, x, y);
                    out[at(x, y)] = b === 0 ? palette.classes[CLS_FOAM] : palette.stops[b - 1];
                }
            }
        }
    }
    // 3.6 — the swash runs before the water state on the resident terrain
    // batch: a texel it turns to foam or wet sand keeps that colour and never
    // takes the path or the beam.
    if (clock > 0 && fx.swash) {
        eachTexel(base.swash[fx.swashCyc], 2, (i, x, y, k) => {
            const p = at(x, y);
            out[p] = palette.classes[base.swash[fx.swashCyc][k + 1]];
            mask[p] = 1;
        });
    }
    layer.ctx.putImageData(layer.image, 0, 0);
    layer.x = x0;
    layer.y = y0;
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

// The sunlit course: the field's clearest share while the sun band is up
// and the cloud courses cast (the resident `u_seaSunlit` rule), offset by
// the courses' own drift; null when off.
function resolveSun(renderer, atmosphere, fx) {
    const grade = atmosphere?.lightGrade || {};
    const weather = atmosphere?.weather || {};
    const covered = cloudCoveredShare(clamp01(weather.cloudCover));
    if (!fx.seaWeather || clamp01(grade.cloudShadow) <= 0.02 || covered <= 0 || !(clamp01(grade.sunBand) > 0.3)) return null;
    const tile = cloudSunlitTile(covered);
    const offset = cloudCourseOffset(renderer.motionTimeMs, weather, !((renderer.motionScale ?? 1) > 0));
    return { tile, mask: tile.mask, size: tile.size, ox: offset.x, oy: offset.y, key: `${tile.key}|${offset.x},${offset.y}` };
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
    if ((lift ? chunk.liftKey : chunk.bodyKey) === key) return lift ? chunk.liftCanvas : chunk.bodyCanvas;
    const scratch = state.chunkScratch ||= (() => {
        const image = new ImageData(CHUNK_W, CHUNK_H);
        return { image, u32: new Uint32Array(image.data.buffer) };
    })();
    const { u32 } = scratch;
    u32.fill(0);
    const { info } = chunk;
    const X0 = cx * CHUNK_W;
    const Y0 = cy * CHUNK_H;
    const paint = (idx, stop) => {
        const v = info[idx];
        const ly = (idx / CHUNK_W) | 0;
        const y = Y0 + ly;
        if ((v & SEA_OPEN_SEA) && y - OCEAN_HORIZON_WORLD_Y < SEA_FLAT_ROWS + 8) {
            const c = canvasSeaMarkRgb(renderer, stop, X0 + idx - ly * CHUNK_W, y, false);
            if (c >= 0) {
                u32[idx] = ((255 << 24) | ((c & 255) << 16) | (c & 0xff00) | (c >> 16)) >>> 0;
                return;
            }
        }
        u32[idx] = palette.stops[stop];
    };
    if (lift) {
        for (let idx = 0; idx < info.length; idx++) {
            if (info[idx] & SEA_OPEN) paint(idx, Math.max((info[idx] & 7) - 1, 0));
        }
    } else {
        for (const idx of chunk.body) paint(idx, info[idx] & 7);
    }
    const name = lift ? 'liftCanvas' : 'bodyCanvas';
    if (!chunk[name]) {
        chunk[name] = document.createElement('canvas');
        chunk[name].width = CHUNK_W;
        chunk[name].height = CHUNK_H;
    }
    chunk[name].getContext('2d').putImageData(scratch.image, 0, 0);
    if (lift) chunk.liftKey = key;
    else chunk.bodyKey = key;
    state.seaCanvasChunks.add(chunk);
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
    for (let cy = Math.floor(y0 / CHUNK_H); cy * CHUNK_H < y0 + h; cy++) {
        for (let cx = Math.floor(x0 / CHUNK_W); cx * CHUNK_W < x0 + w; cx++) {
            const chunk = state.caps.get(chunkId(cx, cy));
            if (chunk) c.drawImage(chunkSeaCanvas(state, chunk, cx, cy, palette, key, renderer, true), cx * CHUNK_W, cy * CHUNK_H);
        }
    }
    const pattern = c.createPattern(sun.tile.canvas, 'repeat');
    pattern?.setTransform?.(new DOMMatrix([1, 0, 0, 1, -sun.ox, -sun.oy]));
    c.globalCompositeOperation = 'destination-in';
    c.fillStyle = pattern;
    c.fillRect(x0, y0, w, h);
    c.globalCompositeOperation = 'source-over';
    layer.x = x0;
    layer.y = y0;
}

// Only water texels take the path and the beam: an in-map stop, or the open
// sea below its haze; never a texel the swash turned.
function waterTexel(state, base, fx, x, y) {
    const i = base.texelAt(x, y);
    const k = i < 0 ? CLS_EMPTY : base.cls[i];
    if (k === CLS_EMPTY) return y >= fx.horizonTop;
    if (k > 5) return false;
    const o = state.overlay;
    if (state.mask && x >= o.x && y >= o.y && x < o.x + o.canvas.width && y < o.y + o.canvas.height) {
        return !state.mask[(y - o.y) * o.canvas.width + (x - o.x)];
    }
    return true;
}

// 3.2 — the sun/moon path (glintDash), screen-anchored: its x is the sky
// body's screen x, its half-width grows down the frame.
function rebuildPath(state, base, fx, palette, view, glint) {
    const moon = glint.kind === 3;
    const baseWidth = glint.kind === 2 ? GLINT_NOON_BASE : 5;
    const grow = glint.kind === 2 ? 0.12 * NOON_GLINT_GROW_GAIN : 0.12;
    const gx = view.x0 + clamp01(glint.body?.xFrac ?? 0.5) * (view.x1 - view.x0);
    const top = Math.max(Math.floor(view.y0), fx.horizonTop);
    const bottom = Math.ceil(view.y1);
    if (bottom <= top) return false;
    const maxHalf = (baseWidth + (bottom - view.y0) * grow) * (moon ? 0.7 : 1);
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
        ? GLINT_DASH_DENSITY * 0.5
        : GLINT_DASH_DENSITY * (glint.kind === 2 ? Math.min(1, NOON_GLINT_FULL_TEXEL / Math.max(view.texelPx, 1e-3)) : 1);
    for (let y = top; y < bottom; y++) {
        const half = (baseWidth + (y + 0.5 - view.y0) * grow) * (moon ? 0.7 : 1);
        const c0 = Math.floor((gx - half) / width);
        const c1 = Math.floor((gx + half) / width);
        for (let cx = c0; cx <= c1; cx++) {
            let life = 0;
            let rollSun = 0;
            if (moon) life = Math.floor((tick + Math.floor(hash12(cx + 37, y + 5) * MOON_DASH_HOLD)) / MOON_DASH_HOLD);
            else rollSun = hash12(cx + tick * 7, y + tick * 3);
            const rollMoon = moon ? hash12(cx + life * 5, y + life * 2) : 0;
            const tone = moon ? 0 : hash12(cx + 5, y + tick * 11);
            for (let x = cx * width; x < cx * width + width; x++) {
                const weight = 1 - Math.abs(x + 0.5 - gx) / half;
                if (weight <= 0) continue;
                let colour;
                if (moon) {
                    if (rollMoon >= density * glint.strength * weight * weight) continue;
                    colour = lo;
                } else {
                    if (rollSun >= density * glint.strength * weight) continue;
                    colour = tone < weight ? hi : lo;
                }
                if (!waterTexel(state, base, fx, x, y)) continue;
                out[(y - top) * pw + (x - px0)] = colour;
            }
        }
    }
    layer.ctx.putImageData(layer.image, 0, 0);
    layer.x = px0;
    layer.y = top;
    return true;
}

// 2.7 — the Lighthouse sheen (lighthouseSheen): both fans of the lens on the
// ground plane from the lamp's foot, its three courses as shares of 3x1
// dash cells with a Bayer edge, the sheen band stepping outward.
function rebuildBeam(state, base, fx, palette, view, beam) {
    const L = Number(beam.length) || 320;
    const near = BEAM_NEAR_HALF_WIDTH;
    const far = (Number(beam.farWidth) || 58) / 2;
    const courses = beam.courses || [];
    const ends = [courses[0]?.[1] ?? 0.34, courses[1]?.[1] ?? 0.68, courses[2]?.[1] ?? 1];
    const shares = [courses[0]?.[2] ?? 1, courses[1]?.[2] ?? 0.6, courses[2]?.[2] ?? 0.3];
    const reach = L * ends[2] + 14;
    const footX = beam.foot.x;
    const footY = beam.foot.y;
    const bx0 = Math.floor(footX - reach - far - 12);
    const by0 = Math.floor(footY - (reach + far) / 2 - 8);
    const bw = Math.ceil((reach + far) * 2) + 24;
    const bh = Math.ceil(reach + far) + 16;
    const layer = layerCanvas(state.beam, bw, bh);
    const out = layer.u32;
    const dirX = Math.cos(beam.angle);
    const dirY = Math.sin(beam.angle);
    const step = Number(beam.sheenStep) || 0;
    const top = Math.max(by0, Math.floor(view.y0), fx.horizonTop);
    const bottom = Math.min(by0 + bh, Math.ceil(view.y1));
    const left = Math.max(bx0, Math.floor(view.x0) - 3);
    const right = Math.min(bx0 + bw, Math.ceil(view.x1) + 3);
    const fan = (gx, gy, sx, sy, order, cellX, y) => {
        const along = gx * sx + gy * sy;
        const t = (along + order * 12) / L;
        if (t <= 0 || t >= ends[2]) return 0;
        const halfWidth = near + (far - near) * Math.max(0, Math.min(1, along / L));
        if (Math.abs(-gx * sy + gy * sx) + order * 6 >= halfWidth) return 0;
        const course = t < ends[0] ? 2 : t < ends[1] ? 1 : 0;
        const share = course === 2
            ? shares[0]
            : course === 1
                ? shares[1]
                : shares[2] * Math.max(0, Math.min(1, (ends[2] - t) / Math.max(0.01, ends[2] - ends[1])));
        if (hash12(cellX + 83, y + 19) >= share) return 0;
        const sheen = (((Math.floor(along / 16) - step) % 3) + 3) % 3 === 0 ? 1 : 0;
        return 1 + Math.min(2, course + sheen);
    };
    for (let y = top; y < bottom; y++) {
        for (let cellX = Math.floor(left / 3); cellX * 3 < right; cellX++) {
            const gx = cellX * 3 + 1.5 - footX;
            const gy = (y + 0.5 - footY) * 2;
            // Cheap reject: outside both fans' reach.
            if (gx * gx + gy * gy > (reach + 12) * (reach + 12)) continue;
            const order = beamBayer4(cellX, y) - 0.5;
            const lit = Math.max(fan(gx, gy, dirX, dirY, order, cellX, y), fan(gx, gy, -dirX, -dirY, order, cellX, y));
            if (lit < 0.5) continue;
            const colour = palette.beam[Math.max(0, Math.min(2, lit - 1))];
            for (let x = cellX * 3; x < cellX * 3 + 3; x++) {
                if (x < bx0 || x >= bx0 + bw || !waterTexel(state, base, fx, x, y)) continue;
                out[(y - by0) * bw + (x - bx0)] = colour;
            }
        }
    }
    layer.ctx.putImageData(layer.image, 0, 0);
    layer.x = bx0;
    layer.y = by0;
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
    const lanterns = renderer._lanternGlowSources?.() || [];
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
function columnBlocked(field, steps, rx, ry, light) {
    const { originX, originY, cell, width, height, data } = field;
    const at = (px, py) => {
        const cx = Math.floor((px - originX) / cell);
        const cy = Math.floor((py - originY) / cell);
        return cx < 0 || cy < 0 || cx >= width || cy >= height ? -1 : (cy * width + cx) * 2;
    };
    const home = at(light.x, light.footY);
    let housed = home >= 0 && data[home] > light.height + 2;
    for (let k = 0; k < steps; k++) {
        const t = (steps - k) / (steps + 1);
        const px = rx + (light.x - rx) * t;
        const py = ry + (light.footY - ry) * t;
        if (light.fixture && Math.hypot(px - light.x, py - light.footY) < 10) continue;
        const j = at(px, py);
        const landmark = j >= 0 ? data[j + 1] : 0;
        const occupied = j >= 0 && !(landmark !== 0 && landmark === light.landmark) && data[j] > light.height * t + 2;
        if (housed) {
            housed = occupied;
            continue;
        }
        if (occupied) return true;
    }
    return false;
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

// SCENE_FRAGMENT `columnLift`: the lift in water stops (0: no column texel)
// of one light's column at world texel (x, y), `along` world px below its
// start: hashed rows thinning with the reach and re-drawn every
// WATER_COLUMN_ROW_HOLD ticks on their own phase, dashes about the foot's
// texel shifted by the row wobble and tapering from `halfNear` to 1, a spark
// broken off long dashes, the course share falling from 0.8 to 0.3 of the
// energy (row-dithered) stepped to lifts 1-4, the dash ends one stop down,
// its middle one up and the near half's glint rows one more (at most 5).
function columnLift(x, y, footX, along, reach, energy, halfNear, tick) {
    if (along < 0 || along >= reach) return 0;
    const t = along / reach;
    const fx = Math.floor(footX);
    const life = Math.floor((tick + Math.floor(hash12f(y + 3, fx + 17) * WATER_COLUMN_ROW_HOLD)) / WATER_COLUMN_ROW_HOLD);
    const present = WATER_COLUMN_ROW_NEAR + (WATER_COLUMN_ROW_FAR - WATER_COLUMN_ROW_NEAR) * t;
    if (hash12f(y + life * 7 + 11, fx + life * 3 + 29) >= present) return 0;
    const dx = x - fx - Math.floor(1.5 * Math.sin(y * 0.7 + tick));
    const halfWidth = Math.floor(halfNear + (1 - halfNear) * t + 0.5);
    const lo = -Math.max(0, halfWidth + Math.floor(hash12f(y + life * 5 + 41, fx + 13) * 3) - 1);
    const hi = Math.max(0, halfWidth + Math.floor(hash12f(y + life * 13 + 47, fx + 19) * 3) - 1);
    if (dx < lo || dx > hi) return 0;
    const spark = hash12f(y + life * 17 + 61, fx + 23);
    if (hi - lo >= 4 && spark < 0.55 && dx === (spark < 0.275 ? lo + 1 : hi - 1)) return 0;
    const q = (0.8 - 0.5 * t) * energy + (hash12f(y + life * 19 + 71, fx + 31) - 0.5) * 0.3;
    let lift = q >= 0.12 ? 1 + (q >= 0.35) + (q >= 0.75) + (q >= 1.15) : 0;
    if (lift === 0) return 0;
    if (hi > lo && (dx === lo || dx === hi)) return lift - 1;
    if (Math.abs(dx - 0.5 * (lo + hi)) < 0.75) lift += 1;
    if (t < 0.5 && hash12f(y + life * 11 + 53, fx + 7) < WATER_COLUMN_GLINT) lift += 1;
    return Math.min(lift, 5);
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
    return (sd >= 0.30) + (sd >= 0.78) + (sd >= 1.38) + (sd >= 2.15);
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
    const { x0, y0, w, h } = rect;
    const acc = new Map();
    const tick = fx.columnTick;
    const steps = field ? fx.march : 0;
    const { cls, coastField, cols, rows, fx: fieldX, fy: fieldY } = base;
    for (const light of lights) {
        const footX = Math.floor(light.x);
        const yEnd = Math.min(y0 + h, Math.ceil(light.y - 0.5 + light.reach));
        const span = light.halfNear + 4;
        const from = Math.max(x0, footX - span);
        const to = Math.min(x0 + w - 1, footX + span);
        for (let y = Math.max(y0, Math.ceil(light.y - 0.5)); y < yEnd; y++) {
            const r = Math.floor((y - fieldY) / 2);
            if (r < 0 || r >= rows) continue;
            for (let x = from; x <= to; x++) {
                const i = base.texelAt(x, y);
                if (i < 0 || cls[i] === CLS_EMPTY) continue;
                const c = Math.floor((x - fieldX) / 2);
                if (c < 0 || c >= cols) continue;
                const cell = (r * cols + c) * 2;
                const flags = coastField[cell + 1];
                if (!(flags & COAST_FIELD_FLAGS.water) || (flags & COAST_FIELD_FLAGS.covered)) continue;
                const lift = columnLift(x, y, light.x, y + 0.5 - light.y, light.reach, light.energy, light.halfNear, tick);
                if (lift === 0) continue;
                if (steps > 0 && columnBlocked(field, steps, x + 0.5, y + 0.5, light)) continue;
                const p = (y - y0) * w + (x - x0);
                let a = acc.get(p);
                if (!a) acc.set(p, a = [0, 0, 0, 0, i, coastField[cell]]);
                a[0] += light.rgb[0];
                a[1] += light.rgb[1];
                a[2] += light.rgb[2];
                if (lift > a[3]) a[3] = lift;
            }
        }
    }
    if (!acc.size) return false;
    let bx0 = w;
    let by0 = h;
    let bx1 = -1;
    let by1 = -1;
    for (const p of acc.keys()) {
        const px = p % w;
        const py = (p - px) / w;
        if (px < bx0) bx0 = px;
        if (px > bx1) bx1 = px;
        if (py < by0) by0 = py;
        if (py > by1) by1 = py;
    }
    const bw = bx1 - bx0 + 1;
    const layer = layerCanvas(state.columns, bw, by1 - by0 + 1);
    const out = layer.u32;
    const memo = state.columnMemo;
    for (const [p, a] of acc) {
        const k = cls[a[4]];
        const stop = waterStopForSd((a[5] - 128) / 64);
        let u;
        if (k <= 5) u = palette.stops[k];
        else if (k === CLS_FOAM || k === CLS_CREST) u = palette.classes[k];
        else {
            const rgb = receiverRgb(base, a[4]);
            u = rgb < 0 ? palette.stops[stop] : palette.ripple(rgb);
        }
        const key = `${u}|${stop}|${a[3]}|${Math.round(a[0] * 512)},${Math.round(a[1] * 512)},${Math.round(a[2] * 512)}`;
        let colour = memo.get(key);
        if (colour === undefined) {
            const water = CanvasGrade.canvasFrameGradeRgb([(u & 255) / 255, ((u >> 8) & 255) / 255, ((u >> 16) & 255) / 255], grade, { postFx });
            colour = u32Of(CanvasGrade.landWaterColumn(water, [a[0], a[1], a[2]], a[3], columnRampLuma(stop, a[3])));
            memo.set(key, colour);
        }
        const px = p % w;
        out[((p - px) / w - by0) * bw + px - bx0] = colour;
    }
    layer.ctx.putImageData(layer.image, 0, 0);
    layer.x = x0 + bx0;
    layer.y = y0 + by0;
    return true;
}

/**
 * 2.9 — the lamp columns `drawCanvasWaterState` built this frame, laid on
 * the ungraded overlay after the frame grade (the resident pass lands them
 * after its grade too), carved by every sprite the depth pass drew over the
 * water (`drawCarvedTerrainLayer`). Call where the emitter cuts land, only
 * when the resident scene pass did not render the frame.
 */
export function drawCanvasWaterColumns(overlayCtx, renderer) {
    const state = renderer?._canvasWater;
    if (!state?.columnsLive) return;
    state.columnsLive = false;
    const layer = state.columns;
    if (!layer?.canvas || !renderer.camera) return;
    overlayCtx.save();
    renderer.camera.applyTransform(overlayCtx);
    overlayCtx.imageSmoothingEnabled = false;
    overlayCtx.globalCompositeOperation = 'source-over';
    overlayCtx.globalAlpha = 1;
    drawCarvedTerrainLayer(overlayCtx, renderer, layer);
    overlayCtx.restore();
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
        overlay: {},
        path: {},
        beam: {},
        sun: {},
        // 3.3 (a) — the cap chunks holding sea canvases (`chunkSeaCanvas`).
        seaCanvasChunks: new Set(),
        columns: {},
        columnMemo: new Map(),
        gust: null,
        mask: null,
        rise: null,
        overlayKey: '',
        pathKey: '',
        beamKey: '',
        sunKey: '',
        columnKey: '',
        paletteKey: '',
        palette: null,
        stats: { baseMs: 0, overlayMs: 0, overlayBuilds: 0, pathMs: 0, beamMs: 0, chunks: 0, caps: 0, capMs: 0, sunMs: 0, columnMs: 0, columns: 0 },
    };
    const fields = renderer._coastBake?.waterFields;
    const baseKey = `${renderer.terrainCacheKey}|${fields?.revision}`;
    if (!state.base || state.base.key !== baseKey) {
        state.base = buildBase(renderer);
        state.caps.clear();
        state.seaCanvasChunks.clear();
        state.overlayKey = '';
        state.pathKey = '';
        state.beamKey = '';
        state.sunKey = '';
        state.columnKey = '';
        if (state.base) state.stats.baseMs = state.base.buildMs;
    }
    const base = state.base;
    if (!base) return;
    const fx = resolveFx(renderer, atmosphere);
    const postFx = renderer.postFx?.isActive?.() === true;
    const mood = waterMoodFor(atmosphere);
    const cloudStep = Math.round(clamp01((clamp01(atmosphere?.weather?.cloudCover) - 0.7) / 0.2) * 8);
    const paletteKey = `${mood.night}:${mood.storm}:${waterSunBandFor(atmosphere)}|${CanvasGrade.canvasGradeKey(atmosphere?.lightGrade || null, { postFx })}|${fx.storm}|${cloudStep}`;
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
    // The deep field's chunks over the rect, a few built per frame.
    let pending = 0;
    if (fx.clock > 0) {
        let built = 0;
        let visible = 0;
        for (let cy = Math.floor(rect.y0 / CHUNK_H); cy * CHUNK_H < rect.y0 + rect.h; cy++) {
            if ((cy + 1) * CHUNK_H <= OCEAN_HORIZON_WORLD_Y) continue;
            for (let cx = Math.floor(rect.x0 / CHUNK_W); cx * CHUNK_W < rect.x0 + rect.w; cx++) {
                visible++;
                const key = `${cx},${cy},${fx.storm}`;
                const hit = state.chunks.get(key);
                if (hit) {
                    state.chunks.delete(key);
                    state.chunks.set(key, hit);
                } else if (built < CHUNK_BUILDS_PER_FRAME) {
                    state.chunks.set(key, buildChunk(cx, cy, fx.storm));
                    built++;
                } else {
                    pending++;
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
    // 3.3 (a) — the static cap chunks over the rect, built within a budget.
    {
        const started = performance.now();
        let visible = 0;
        for (let cy = Math.floor(rect.y0 / CHUNK_H); cy * CHUNK_H < rect.y0 + rect.h; cy++) {
            if ((cy + 1) * CHUNK_H <= OCEAN_HORIZON_WORLD_Y) continue;
            for (let cx = Math.floor(rect.x0 / CHUNK_W); cx * CHUNK_W < rect.x0 + rect.w; cx++) {
                visible++;
                const id = chunkId(cx, cy);
                const hit = state.caps.get(id);
                if (hit) {
                    state.caps.delete(id);
                    state.caps.set(id, hit);
                } else if (performance.now() - started < CAP_BUILD_BUDGET_MS) {
                    state.caps.set(id, buildCapChunk(base, cx, cy));
                } else {
                    pending++;
                }
            }
        }
        const cap = Math.max(CHUNK_CACHE_MIN, visible * 2);
        for (const id of state.caps.keys()) {
            if (state.caps.size <= cap) break;
            state.caps.delete(id);
        }
        state.stats.caps = state.caps.size;
        state.stats.capMs = performance.now() - started;
    }
    // 3.3 (a) — the sea body under every mark, from the visible chunks; a
    // chunk that leaves the view drops its canvases.
    const seaKey = canvasSeaKey(renderer);
    const seaCanvasKey = `${paletteKey}|${seaKey}`;
    const shown = new Set();
    ctx.save();
    ctx.imageSmoothingEnabled = false;
    for (let cy = Math.floor(rect.y0 / CHUNK_H); cy * CHUNK_H < rect.y0 + rect.h; cy++) {
        for (let cx = Math.floor(rect.x0 / CHUNK_W); cx * CHUNK_W < rect.x0 + rect.w; cx++) {
            const chunk = state.caps.get(chunkId(cx, cy));
            if (!chunk) continue;
            shown.add(chunk);
            const canvas = chunkSeaCanvas(state, chunk, cx, cy, palette, seaCanvasKey, renderer, false);
            if (canvas) ctx.drawImage(canvas, cx * CHUNK_W, cy * CHUNK_H);
        }
    }
    for (const chunk of state.seaCanvasChunks) {
        if (shown.has(chunk)) continue;
        chunk.bodyCanvas = null;
        chunk.bodyKey = '';
        chunk.liftCanvas = null;
        chunk.liftKey = '';
        state.seaCanvasChunks.delete(chunk);
    }
    const weather = atmosphere?.weather || {};
    const sun = resolveSun(renderer, atmosphere, fx);
    const gust = resolveGust(state, fx, rect, weather);
    const overlayKey = [
        base.key, paletteKey, rect.x0, rect.y0, rect.w, rect.h, fx.clock > 0 ? 1 : 0,
        fx.deepTick, fx.nearTick, fx.ringTick, fx.swashCyc, fx.rippleTick,
        fx.caustics ? Math.floor(fx.t * 0.004 * fx.clock) % 8 : -1,
        Math.round(fx.rain * 64), fx.swash ? 1 : 0, fx.grassGust ? 1 : 0, fx.horizonTop, pending,
        sun?.key ?? '', gust?.key ?? '', seaKey,
    ].join('|');
    // 3.4 — the sunlit course, under every mark.
    if (sun && seaKey) {
        const sunKey = `${base.key}|${seaCanvasKey}|${sun.key}|${rect.x0},${rect.y0},${rect.w},${rect.h}|${pending}`;
        if (state.sunKey !== sunKey) {
            const started = performance.now();
            rebuildSun(state, renderer, rect, sun, palette, seaCanvasKey);
            state.sunKey = sunKey;
            state.stats.sunMs = performance.now() - started;
        }
        ctx.drawImage(state.sun.canvas, state.sun.x, state.sun.y);
    }
    if (overlayKey !== state.overlayKey) {
        const started = performance.now();
        rebuildOverlay(state, base, fx, palette, rect, renderer, { caps: state.caps, sun, gust });
        state.overlayKey = overlayKey;
        state.pathKey = '';
        state.stats.overlayMs = performance.now() - started;
        state.stats.overlayBuilds++;
    }
    ctx.drawImage(state.overlay.canvas, state.overlay.x, state.overlay.y);
    // 2.7 — the sheen, under the path (the resident order).
    const beam = renderer.buildingRenderer?.lighthouseBeam?.(renderer.motionTimeMs) || null;
    if (beam) {
        const beamKey = `${beam.angle}|${beam.sheenStep}|${beam.foot.x},${beam.foot.y}|${state.overlayKey}|${Math.floor(view.x0)},${Math.floor(view.y0)},${Math.ceil(view.x1)},${Math.ceil(view.y1)}`;
        if (beamKey !== state.beamKey) {
            const started = performance.now();
            rebuildBeam(state, base, fx, palette, view, beam);
            state.beamKey = beamKey;
            state.stats.beamMs = performance.now() - started;
        }
        ctx.drawImage(state.beam.canvas, state.beam.x, state.beam.y);
    }
    // 3.2 — the path.
    const glint = canvasGlint(atmosphere);
    if (glint) {
        const pathKey = `${fx.deepTick}|${glint.kind}|${Math.round(glint.strength * 64)}|${Math.round((glint.body?.xFrac ?? 0.5) * 4096)}|${Math.round(view.x0)},${Math.round(view.y0)},${Math.round(view.x1)},${Math.round(view.y1)}|${view.texelPx}|${state.overlayKey}`;
        if (pathKey !== state.pathKey) {
            const started = performance.now();
            state.pathOn = rebuildPath(state, base, fx, palette, view, glint);
            state.pathKey = pathKey;
            state.stats.pathMs = performance.now() - started;
        }
        if (state.pathOn) ctx.drawImage(state.path.canvas, state.path.x, state.path.y);
    }
    // 2.9 — the lamp columns land last, over the water state and the path,
    // clipped by the 2.2 footprint march (the field the resident pass binds).
    const lights = columnLights(renderer, atmosphere);
    if (lights.length) {
        const grade = atmosphere?.lightGrade || null;
        const field = fx.march > 0 ? footprintFieldFor(renderer, GPU_LANDMARK_IDS) : null;
        const lightKey = lights.map(l => `${l.x.toFixed(1)},${l.y.toFixed(1)},${Math.round(l.height)},${Math.round(l.reach)},${Math.round(l.rgb[0] * 256)},${Math.round(l.rgb[1] * 256)},${Math.round(l.rgb[2] * 256)}`).join(';');
        const columnKey = `${base.key}|${paletteKey}|${rect.x0},${rect.y0},${rect.w},${rect.h}|${fx.columnTick}|${fx.march}:${field?.revision ?? 0}|${lightKey}`;
        if (columnKey !== state.columnKey) {
            const started = performance.now();
            state.columnsOn = rebuildColumns(state, base, fx, palette, rect, lights, grade, postFx, field);
            state.columnKey = columnKey;
            state.stats.columnMs = performance.now() - started;
            state.stats.columns = lights.length;
        }
        // Laid after the grade by `drawCanvasWaterColumns`.
        state.columnsLive = state.columnsOn === true;
    } else {
        state.columnKey = '';
        state.columnsLive = false;
    }
    ctx.restore();
}
