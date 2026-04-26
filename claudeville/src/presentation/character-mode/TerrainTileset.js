// TerrainTileset maps a (tileX, tileY, classId) + neighbor mask to a Wang tile cell.

import { TILE_WIDTH, TILE_HEIGHT } from '../../config/constants.js';

// Wang 4-bit edge mask: bit 0 = N same, 1 = E same, 2 = S same, 3 = W same.
// Index 0..15 maps to a 4x4 grid of 32x32 cells in a 128x128 tileset PNG.

const TILESET_GRID_COLS = 4;          // 4x4 grid of 16 Wang variants
const TILESET_CELL = 32;              // each variant is 32x32

export class TerrainTileset {
    constructor(assets) {
        this.assets = assets;
        this.cell = TILESET_CELL;
    }

    // isClass(tx, ty) → boolean: tile belongs to upper class.
    drawTile(ctx, sheetId, tileX, tileY, isClass) {
        const sheet = this.assets.get(sheetId);
        if (!sheet) return;
        const mask = (isClass(tileX, tileY - 1) ? 1 : 0)
                   | (isClass(tileX + 1, tileY) ? 2 : 0)
                   | (isClass(tileX, tileY + 1) ? 4 : 0)
                   | (isClass(tileX - 1, tileY) ? 8 : 0);
        const sx = (mask % TILESET_GRID_COLS) * this.cell;
        const sy = Math.floor(mask / TILESET_GRID_COLS) * this.cell;
        const screenX = (tileX - tileY) * (TILE_WIDTH / 2);
        const screenY = (tileX + tileY) * (TILE_HEIGHT / 2);
        // Stretch the 32x32 source cell into the 64x32 iso slot, anchored on
        // the diamond center, then clip to the diamond so corners don't bleed
        // into neighbours and create a patchwork seam.
        const dx = Math.round(screenX - TILE_WIDTH / 2);
        const dy = Math.round(screenY - TILE_HEIGHT / 2);
        ctx.save();
        ctx.beginPath();
        ctx.moveTo(screenX, screenY - TILE_HEIGHT / 2);
        ctx.lineTo(screenX + TILE_WIDTH / 2, screenY);
        ctx.lineTo(screenX, screenY + TILE_HEIGHT / 2);
        ctx.lineTo(screenX - TILE_WIDTH / 2, screenY);
        ctx.closePath();
        ctx.clip();
        ctx.drawImage(sheet, sx, sy, this.cell, this.cell, dx, dy, TILE_WIDTH, TILE_HEIGHT);
        ctx.restore();
    }
}
