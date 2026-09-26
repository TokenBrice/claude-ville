// Land Wang sheets as texture sources for the ground bake (GroundBake.js).
//
// Each sheet is a 4×4 grid of 32×32 cells indexed by the 4-bit edge mask
// (bit 0 = N, 1 = E, 2 = S, 3 = W); cell 0 is all lower class, cell 15 all
// upper class. The bake no longer stamps cells per tile (a square top-down
// cell stretched unrotated into the 64×32 diamond put its transition art on
// the diamond's vertices). It reads a full-class cell's luminance drawing
// and samples it in true 2:1 axonometric orientation: cell (u, v) maps to
// tile coordinates (tileX − 0.5 + u/32, tileY − 0.5 + v/32), so the cell's
// NW corner sits on the tile's top vertex and one cell texel is a 2×1 rhombus.

const TILESET_GRID_COLS = 4;
const TILESET_CELL = 32;

const cache = new WeakMap();

// Luminance of one cell as z-scores (mean 0, unit deviation), row-major
// 32×32. Colour is discarded: the bake re-tones the drawing onto the C1
// ground ramps. Cached per image.
export function readTerrainCellLuma(image, cell) {
    let perImage = cache.get(image);
    if (!perImage) {
        perImage = new Map();
        cache.set(image, perImage);
    }
    if (perImage.has(cell)) return perImage.get(cell);
    const canvas = document.createElement('canvas');
    canvas.width = TILESET_CELL;
    canvas.height = TILESET_CELL;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(
        image,
        (cell % TILESET_GRID_COLS) * TILESET_CELL,
        Math.floor(cell / TILESET_GRID_COLS) * TILESET_CELL,
        TILESET_CELL, TILESET_CELL,
        0, 0, TILESET_CELL, TILESET_CELL,
    );
    const data = ctx.getImageData(0, 0, TILESET_CELL, TILESET_CELL).data;
    const n = TILESET_CELL * TILESET_CELL;
    const luma = new Float32Array(n);
    let sum = 0;
    for (let i = 0; i < n; i++) {
        const l = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
        luma[i] = l;
        sum += l;
    }
    const mean = sum / n;
    let variance = 0;
    for (let i = 0; i < n; i++) variance += (luma[i] - mean) ** 2;
    const sd = Math.sqrt(Math.max(1, variance / n));
    for (let i = 0; i < n; i++) luma[i] = (luma[i] - mean) / sd;
    perImage.set(cell, luma);
    return luma;
}
