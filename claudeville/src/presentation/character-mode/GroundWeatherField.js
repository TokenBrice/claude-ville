// GroundWeatherField — what the ground bake knows about weather, published as
// one world-space RGBA8 field (item 5, "weather you can read on the ground";
// data only: nothing here draws, uploads or claims a texture unit).
//
// GRID. The ground bake's own texel grid: COLS × ROWS = (MAP_SIZE·TILE_WIDTH/2)
// × (MAP_SIZE·TILE_HEIGHT) = 1280 × 1280 texels at MAP_SIZE 40, one texel =
// 2 world px across × 1 world px down (square on the ground plane in 2:1 iso).
// The field spans world x ∈ [X0, X0 + COLS·2), y ∈ [Y0, Y0 + ROWS) with
// X0 = −MAP_SIZE·TILE_WIDTH/2 = −1280 and Y0 = −TILE_HEIGHT/2 = −16, i.e. the
// whole island diamond's bounding box (`renderer.groundField.bounds`).
// Row-major, row 0 at the top (smallest world y), 4 bytes per texel.
//
// WORLD → TEXEL (what a consumer does; `groundWeatherTexel` below):
//   col = floor((worldX − X0) / 2),  row = floor(worldY − Y0)
//   outside [0, COLS) × [0, ROWS): no ground, read the neutral texel.
//   As a texture coordinate: u = (worldX − X0) / (2·COLS), v = (worldY − Y0) / ROWS,
//   sampled NEAREST (the channels are codes and thresholds, never filtered).
//
// CHANNELS (bytes 0–255):
//   R  surface · 16 + ramp stop. Surface id = R >> 4 (GroundBake's surfaces:
//      0 grass, 1 sand, 2 dirt, 3 road, 4 plaza, 5 flagstone, 6 gravel,
//      7 cinder, 8 earth, and 9 cool limestone: a plaza or flag stone the
//      bake laid on the `plazaCool` ramp), ramp stop = R & 15 (0–4, the C1
//      ground ramp stop the bake chose: 0 the darkest joint or crease, 4 the
//      lit top). 255 = no land here (water, off-map). Paving is surfaces 3–6
//      and 9. Surface 15 (GROUND_WEATHER_MIXED_SURFACE) marks a mixed cell:
//      its two fine texels lie on different wet ramps (plaza beside road,
//      grass beside sand, …), so no one material step fits both and the
//      consumer keeps the uniform wet darkening instead, as on a shore pair.
//   G  shelter: how much of the rain this texel is spared, 0 = open sky, 255
//      = fully under cover. Eaves (a band hugging every building footprint,
//      `EAVE_REACH` tiles wide, full at the wall) and tree crowns (full under
//      the crown's drop zone, fading to its rim; a bare deciduous crown in
//      winter spares at most `BARE_CROWN_COVER`). Rain reaching the texel =
//      1 − G/255.
//   B  drying order: 0 dries first, 255 last. Sun exposure on the bake's
//      light convention (light from screen up-left, as the contact AO and the
//      RakingLight casts draw it: the long shade lies on each building's
//      +tileX and +tileY sides and under crowns), raised in joints and
//      hollows (low ramp stops) and around puddle sites, plus a little
//      world-locked noise so a drying street breaks into patches. A consumer
//      keeps a texel wet while `wetness ≥ 1 − B/255` (so ground dries in
//      ascending B as wetness drains), unless G says it never got wet.
//   A  puddle threshold, identical to `renderer.groundPuddleMask` (which is
//      still published and still drives today's puddles): 255·(1 − t), the
//      texel holds water while the ground state's `puddles` ≥ t; 0 = never a
//      puddle.
//
// NEUTRAL TEXEL (no ground / nothing known): R 255, G 0, B 128, A 0.
// Store and upload as raw bytes (a Uint8Array to texImage2D / writeTexture),
// never through a canvas: A is data, not opacity, and premultiplication
// would erase RGB wherever A is 0.
//
// Built on first need only (GroundBake.groundWeatherWanted: GW-3 on any
// backend, GW-1 / GW-2 on the GPU paths; at looks 0 nothing is allocated,
// baked or saved), in the same pass as the ground bake (`bakeGround`), cached
// with it, published as `renderer.groundField.weather` and persisted inside
// the terrain artifact's ground field (TerrainArtifactStore schema 3, keyed
// 'weather').

import { MAP_SIZE, TILE_WIDTH, TILE_HEIGHT } from '../../config/constants.js';
import { ART_RAMPS } from '../../config/artPalette.js';

export const GROUND_WEATHER_TEXEL_W = 2;
export const GROUND_WEATHER_COLS = MAP_SIZE * TILE_WIDTH / GROUND_WEATHER_TEXEL_W;
export const GROUND_WEATHER_ROWS = MAP_SIZE * TILE_HEIGHT;
export const GROUND_WEATHER_X0 = -MAP_SIZE * TILE_WIDTH / 2;
export const GROUND_WEATHER_Y0 = -TILE_HEIGHT / 2;
export const GROUND_WEATHER_NEUTRAL = Object.freeze([255, 0, 128, 0]);
export const GROUND_WEATHER_NO_SURFACE = 255;

// Eave band width (tiles) and the cover a leafless deciduous crown keeps.
export const EAVE_REACH = 0.65;
export const BARE_CROWN_COVER = 0.35;

// GW-1 — a wet ground texel steps one stop down its own C1 ramp, paving
// like every other surface: the per-channel ratio ramp[stop − 1] /
// ramp[stop] (stop 0 takes the 1 → 0 ratio), indexed surface · 5 + stop.
// Multiplying a baked ramp colour by it lands exactly on the next darker stop
// (the terrain cache's haze multiply commutes), so wet ground stays on the
// palette.
const SURFACE_RAMPS = Object.freeze(['grass', 'sand', 'dirt', 'road', 'plaza', 'plaza', 'road', 'cinder', 'dirt', 'plazaCool']);
export const GROUND_WET_SURFACES = SURFACE_RAMPS.length;
export const GROUND_PAVING_SURFACES = Object.freeze([3, 4, 5, 6, 9]);
export const GROUND_WEATHER_COOL_SURFACE = 9;
export const GROUND_WEATHER_MIXED_SURFACE = 15;
/** The C1 ramp a field surface id steps down when wet (null: no step). */
export const groundWetRamp = (surface) => SURFACE_RAMPS[surface] ?? null;
const hex = (h) => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
export const GROUND_WET_STEPS = Object.freeze(SURFACE_RAMPS.flatMap((key) => {
    const ramp = ART_RAMPS[key].map(hex);
    return ramp.map((c, k) => {
        const from = k === 0 ? ramp[1] : c;
        const to = k === 0 ? ramp[0] : ramp[k - 1];
        return Object.freeze(from.map((v, i) => Number((to[i] / Math.max(1, v)).toFixed(4))));
    });
}));

const clampByte = (v) => (v <= 0 ? 0 : v >= 1 ? 255 : Math.round(v * 255));

/**
 * Packs the bake's per-texel arrays into the RGBA8 field. `surfaces`,
 * `stops`, `puddleMask`: Uint8Array per texel (surface 255 = no land);
 * `shelter`, `order`: Float32Array 0–1 per texel.
 */
export function packGroundWeather({ cols, rows, surfaces, stops, shelter, order, puddleMask }) {
    const data = new Uint8Array(cols * rows * 4);
    for (let i = 0; i < cols * rows; i++) {
        const o = i * 4;
        const s = surfaces[i];
        if (s === GROUND_WEATHER_NO_SURFACE) {
            data[o] = 255; data[o + 1] = 0; data[o + 2] = 128; data[o + 3] = 0;
            continue;
        }
        data[o] = (s << 4) | (stops[i] & 15);
        data[o + 1] = clampByte(shelter[i]);
        data[o + 2] = clampByte(order[i]);
        data[o + 3] = puddleMask[i];
    }
    return { data, cols, rows, x0: GROUND_WEATHER_X0, y0: GROUND_WEATHER_Y0, texelW: GROUND_WEATHER_TEXEL_W };
}

/** The four bytes at a world position (the neutral texel off the grid). */
export function groundWeatherTexel(field, worldX, worldY) {
    const col = Math.floor((worldX - field.x0) / field.texelW);
    const row = Math.floor(worldY - field.y0);
    if (col < 0 || row < 0 || col >= field.cols || row >= field.rows) return [...GROUND_WEATHER_NEUTRAL];
    const o = (row * field.cols + col) * 4;
    return [field.data[o], field.data[o + 1], field.data[o + 2], field.data[o + 3]];
}

/** Decodes one texel's bytes. */
export function decodeGroundWeather([r, g, b, a]) {
    const land = r !== GROUND_WEATHER_NO_SURFACE;
    return {
        land,
        surface: land ? r >> 4 : null,
        stop: land ? r & 15 : null,
        shelter: g / 255,
        dryingOrder: b / 255,
        puddleThreshold: a ? 1 - a / 255 : null,
    };
}

export function validGroundWeather(field) {
    return field?.cols === GROUND_WEATHER_COLS && field.rows === GROUND_WEATHER_ROWS
        && field.texelW === GROUND_WEATHER_TEXEL_W && field.x0 === GROUND_WEATHER_X0 && field.y0 === GROUND_WEATHER_Y0
        && field.data instanceof Uint8Array && field.data.length === GROUND_WEATHER_COLS * GROUND_WEATHER_ROWS * 4;
}

const _puddleSiteCache = new WeakMap();

/**
 * W2-B (§4.12) — extracts distinct puddle sites (world centre + threshold)
 * from a packed RGBA8 GroundWeatherField (channel A) or an R8 puddleMask
 * without altering the 1280×1280 binary layout. Cached per backing Uint8Array.
 * Each site sits at the peak-depth texel of its connected puddle component so
 * it stays strictly inside the puddle as long as `puddles >= site.threshold`.
 */
export function extractPuddleSites(source) {
    const data = source?.data;
    const cols = Number(source?.cols) || 0;
    const rows = Number(source?.rows) || 0;
    if (!(data instanceof Uint8Array) || !(cols > 0) || !(rows > 0)) return Object.freeze([]);
    const cached = _puddleSiteCache.get(data);
    if (cached) return cached;

    const total = cols * rows;
    const isRgba = data.length === total * 4;
    const isR8 = data.length === total;
    if (!isRgba && !isR8) return Object.freeze([]);

    const stride = isRgba ? 4 : 1;
    const alphaOffset = isRgba ? 3 : 0;
    const x0 = Number.isFinite(source.x0) ? source.x0 : GROUND_WEATHER_X0;
    const y0 = Number.isFinite(source.y0) ? source.y0 : GROUND_WEATHER_Y0;
    const texelW = Number.isFinite(source.texelW) && source.texelW > 0 ? source.texelW : GROUND_WEATHER_TEXEL_W;

    const visited = new Uint8Array(total);
    const stack = [];
    const sites = [];

    for (let start = 0; start < total; start++) {
        if (visited[start]) continue;
        const firstByte = data[start * stride + alphaOffset];
        if (firstByte === 0) continue;

        visited[start] = 1;
        stack.push(start);
        let maxByte = firstByte;
        let peakColSum = 0;
        let peakRowSum = 0;
        let peakCount = 0;
        let area = 0;

        while (stack.length > 0) {
            const idx = stack.pop();
            const byte = data[idx * stride + alphaOffset];
            const row = Math.floor(idx / cols);
            const col = idx - row * cols;
            area++;

            if (byte > maxByte) {
                maxByte = byte;
                peakColSum = col;
                peakRowSum = row;
                peakCount = 1;
            } else if (byte === maxByte) {
                peakColSum += col;
                peakRowSum += row;
                peakCount++;
            }

            // 8-connected flood-fill groups organic elliptical puddles into one site.
            const rMin = row > 0 ? row - 1 : 0;
            const rMax = row + 1 < rows ? row + 1 : rows - 1;
            const cMin = col > 0 ? col - 1 : 0;
            const cMax = col + 1 < cols ? col + 1 : cols - 1;
            for (let nr = rMin; nr <= rMax; nr++) {
                const rowBase = nr * cols;
                for (let nc = cMin; nc <= cMax; nc++) {
                    const nIdx = rowBase + nc;
                    if (visited[nIdx]) continue;
                    if (data[nIdx * stride + alphaOffset] === 0) continue;
                    visited[nIdx] = 1;
                    stack.push(nIdx);
                }
            }
        }

        const peakCol = peakColSum / peakCount;
        const peakRow = peakRowSum / peakCount;
        sites.push(Object.freeze({
            x: x0 + (peakCol + 0.5) * texelW,
            y: y0 + peakRow + 0.5,
            threshold: 1 - maxByte / 255,
            maxByte,
            area,
        }));
    }

    const result = Object.freeze(sites);
    _puddleSiteCache.set(data, result);
    return result;
}
