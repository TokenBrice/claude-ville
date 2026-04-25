// TerrainTileset maps a (tileX, tileY, classId) + neighbor mask to a Wang tile cell.

import { TILE_WIDTH, TILE_HEIGHT } from '../../config/constants.js';

// Wang 4-bit edge mask: bit 0 = N same, 1 = E same, 2 = S same, 3 = W same.
// Index 0..15 maps to a cell column in a 16-cell-wide tileset PNG.

export class TerrainTileset {
    constructor(assets) {
        this.assets = assets;
        this.cellW = 64;
        this.cellH = 32;
    }

    // isClass(tx, ty) → boolean: tile belongs to upper class.
    drawTile(ctx, sheetId, tileX, tileY, isClass) {
        const sheet = this.assets.get(sheetId);
        if (!sheet) return;
        const mask = (isClass(tileX, tileY - 1) ? 1 : 0)
                   | (isClass(tileX + 1, tileY) ? 2 : 0)
                   | (isClass(tileX, tileY + 1) ? 4 : 0)
                   | (isClass(tileX - 1, tileY) ? 8 : 0);
        const screenX = (tileX - tileY) * (TILE_WIDTH / 2);
        const screenY = (tileX + tileY) * (TILE_HEIGHT / 2);
        const dx = Math.round(screenX - this.cellW / 2);
        const dy = Math.round(screenY - this.cellH / 2);
        ctx.drawImage(
            sheet,
            mask * this.cellW, 0, this.cellW, this.cellH,
            dx, dy, this.cellW, this.cellH
        );
    }
}
