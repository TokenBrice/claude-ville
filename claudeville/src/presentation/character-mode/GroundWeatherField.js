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
//      7 cinder, 8 earth), ramp stop = R & 15 (0–4, the C1 ground ramp stop
//      the bake chose: 0 the darkest joint or crease, 4 the lit top). 255 =
//      no land here (water, off-map). Paving is surfaces 3–6.
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
const SURFACE_RAMPS = Object.freeze(['grass', 'sand', 'dirt', 'road', 'plaza', 'plaza', 'road', 'dirt', 'dirt']);
export const GROUND_WET_SURFACES = SURFACE_RAMPS.length;
export const GROUND_PAVING_SURFACES = Object.freeze([3, 4, 5, 6]);
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
