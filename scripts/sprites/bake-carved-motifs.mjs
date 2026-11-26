#!/usr/bin/env node
// Wave 4 Pre-Production (Spec 03 §1.2 item 4.1 & Spec 04 §4.2) —
// Deterministic 0-gen baker for `prop.carvedMotifs.png` (144x16, 9 x 16x16
// horizontal frames, anchor [8, 14]).
//
// Each 16x16 cell depicts one landmark's carved oak door-bracket sign:
//   - 2-texel wrought-iron bracket arm & wall flange (ART_RAMPS.slate)
//   - 10x10 walnut-framed board (ART_RAMPS.timber) hung 2 texels below the arm
//   - 8x8 DISTRICT_MOTIFS emblem (EventShapes `district-<type>`) carved in
//     warm bas-relief brass (ART_RAMPS.trimGold[1..2] + clothOchre[0..1])
//   - Crisp 1px #060402 selective outer ink, ZERO semi-alpha, ZERO Tier-A,
//     ZERO off-ramp pixels.
//
// Usage:
//   node scripts/sprites/bake-carved-motifs.mjs            write prop.carvedMotifs.png
//   node scripts/sprites/bake-carved-motifs.mjs --check    exit 1 if PNG is stale/missing
//   node scripts/sprites/bake-carved-motifs.mjs --help     show help and exit 0

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { ART_RAMPS } from '../../claudeville/src/config/artPalette.js';
import { BUILDING_DEFS } from '../../claudeville/src/config/buildings.js';
import { EVENT_SHAPES } from '../../claudeville/src/presentation/shared/EventShapes.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../..');
export const CARVED_MOTIFS_PATH = join(repoRoot, 'claudeville', 'assets', 'sprites', 'props', 'prop.carvedMotifs.png');

export const CELL_SIZE = 16;
export const CARVED_MOTIF_ORDER = Object.freeze(BUILDING_DEFS.map((b) => b.type));
export const SHEET_WIDTH = CARVED_MOTIF_ORDER.length * CELL_SIZE; // 144
export const SHEET_HEIGHT = CELL_SIZE; // 16
export const CARVED_MOTIF_ANCHOR = Object.freeze([8, 14]);

const hex = (h) => [
    parseInt(h.slice(1, 3), 16),
    parseInt(h.slice(3, 5), 16),
    parseInt(h.slice(5, 7), 16),
];

// Strictly ART_RAMPS stops below Tier A (L <= 0.70 and !(S > 0.65 && V >= 0.50))
// plus #060402 selective ink (OKLab dE < 0.005 from ART_RAMPS.ashlar[0]).
const INK = [0x06, 0x04, 0x02];
const TIMBER = ART_RAMPS.timber.map(hex);
const SLATE = ART_RAMPS.slate.map(hex);
const OCHRE = ART_RAMPS.clothOchre.map(hex);
const GOLD_MID = hex(ART_RAMPS.trimGold[1]); // #d4984e (S 0.632, L 0.370)

function setPx(png, x, y, rgb, a = 255) {
    if (x < 0 || y < 0 || x >= png.width || y >= png.height) return;
    const i = (y * png.width + x) * 4;
    png.data[i] = rgb[0];
    png.data[i + 1] = rgb[1];
    png.data[i + 2] = rgb[2];
    png.data[i + 3] = a;
}

function alphaAt(png, x, y) {
    if (x < 0 || y < 0 || x >= png.width || y >= png.height) return 0;
    return png.data[(y * png.width + x) * 4 + 3];
}

function motifGrid8x8(buildingType) {
    const padded = EVENT_SHAPES[`district-${buildingType}`];
    if (!padded) throw new Error(`Missing EventShapes motif for district-${buildingType}`);
    return padded.slice(4, 12).map((row) => row.slice(4, 12));
}

function paintCell(cellPng, buildingType) {
    // 1. Wrought-iron wall flange (left) + 2-texel horizontal iron bracket arm
    //    at y = 1..2, x = 1..13, finial tip at x = 14, y = 1, and twin hanging
    //    iron links at x = 5 and x = 10 on y = 3 (sign hung 2 texels below
    //    the upper arm rail).
    for (let y = 1; y <= 6; y++) {
        setPx(cellPng, 1, y, y <= 3 ? SLATE[2] : SLATE[1]);
    }
    // 2-texel iron arm (top row lit slate, underside shaded slate)
    for (let x = 2; x <= 13; x++) {
        setPx(cellPng, x, 1, SLATE[2]);
        setPx(cellPng, x, 2, SLATE[1]);
    }
    // Forged scroll tip on arm end + diagonal iron knee brace under the flange
    setPx(cellPng, 14, 1, SLATE[1]);
    setPx(cellPng, 2, 3, SLATE[1]);
    // Hanging iron rings joining the arm to the 10x10 oak sign
    setPx(cellPng, 5, 3, SLATE[2]);
    setPx(cellPng, 10, 3, SLATE[2]);

    // 2. 10x10 walnut-framed oak sign board at x = 3..12, y = 4..13.
    const bx0 = 3;
    const by0 = 4;
    const bx1 = 12;
    const by1 = 13;
    for (let y = by0; y <= by1; y++) {
        for (let x = bx0; x <= bx1; x++) {
            const onTop = y === by0;
            const onBottom = y === by1;
            const onLeft = x === bx0;
            const onRight = x === bx1;
            if (onTop || onBottom || onLeft || onRight) {
                // Carved walnut frame bevel: upper-left lit, lower-right shaded.
                if (onTop || onLeft) setPx(cellPng, x, y, TIMBER[2]);
                else setPx(cellPng, x, y, TIMBER[0]);
            } else {
                // Recessed carved oak inner field (8x8 at x=4..11, y=5..12).
                setPx(cellPng, x, y, TIMBER[1]);
            }
        }
    }
    // Wrought-iron hanger staples biting into the top walnut rail
    setPx(cellPng, 5, by0, SLATE[1]);
    setPx(cellPng, 10, by0, SLATE[1]);

    // 3. 8x8 DISTRICT_MOTIFS carved emblem inside x = 4..11, y = 5..12.
    //    Carved bas-relief on warm oak-and-brass stops (ART_RAMPS.clothOchre
    //    + ART_RAMPS.trimGold[1..2]): crisp silhouette against TIMBER[1] while
    //    staying harmoniously inside the OA-M1 Tavern grain-density band.
    const grid = motifGrid8x8(buildingType);
    const bit = (gx, gy) => (gx >= 0 && gx < 8 && gy >= 0 && gy < 8 && grid[gy][gx] === '1');
    for (let gy = 0; gy < 8; gy++) {
        for (let gx = 0; gx < 8; gx++) {
            if (!bit(gx, gy)) continue;
            const litEdge = !bit(gx, gy - 1) || !bit(gx - 1, gy);
            const shadeEdge = !bit(gx, gy + 1) && !bit(gx + 1, gy);
            let tone = OCHRE[1];
            if (litEdge && gy <= 3) tone = GOLD_MID;
            else if (shadeEdge) tone = OCHRE[0];
            setPx(cellPng, 4 + gx, 5 + gy, tone);
        }
    }

    // 4. Crisp 1px #060402 selective outer outline strictly inside the 16x16 cell
    //    (4-connected exterior pixels adjacent to opaque mass, keeping each frame
    //    isolated from its neighbours in the 144x16 strip).
    const toInk = [];
    const dirs = [[-1, 0], [1, 0], [0, -1], [0, 1]];
    for (let y = 0; y < CELL_SIZE; y++) {
        for (let x = 0; x < CELL_SIZE; x++) {
            if (alphaAt(cellPng, x, y) > 0) continue;
            for (const [dx, dy] of dirs) {
                if (alphaAt(cellPng, x + dx, y + dy) > 0) {
                    toInk.push([x, y]);
                    break;
                }
            }
        }
    }
    for (const [x, y] of toInk) setPx(cellPng, x, y, INK);
}

export function bakeCarvedMotifsPng() {
    const sheet = new PNG({ width: SHEET_WIDTH, height: SHEET_HEIGHT, colorType: 6 });
    sheet.data.fill(0);
    CARVED_MOTIF_ORDER.forEach((buildingType, index) => {
        const cell = new PNG({ width: CELL_SIZE, height: CELL_SIZE, colorType: 6 });
        cell.data.fill(0);
        paintCell(cell, buildingType);
        const ox = index * CELL_SIZE;
        for (let y = 0; y < CELL_SIZE; y++) {
            for (let x = 0; x < CELL_SIZE; x++) {
                const si = (y * CELL_SIZE + x) * 4;
                if (cell.data[si + 3] === 0) continue;
                const di = (y * SHEET_WIDTH + ox + x) * 4;
                sheet.data[di] = cell.data[si];
                sheet.data[di + 1] = cell.data[si + 1];
                sheet.data[di + 2] = cell.data[si + 2];
                sheet.data[di + 3] = cell.data[si + 3];
            }
        }
    });
    return PNG.sync.write(sheet, { colorType: 6 });
}

function main(argv) {
    if (argv.includes('--help') || argv.includes('-h')) {
        console.log(`Usage: node scripts/sprites/bake-carved-motifs.mjs [--check | --help]

  (default)   Write claudeville/assets/sprites/props/prop.carvedMotifs.png (${SHEET_WIDTH}x${SHEET_HEIGHT}, ${CARVED_MOTIF_ORDER.length} frames)
  --check     Exit 1 if on-disk PNG is missing or differs from deterministic bake
  --help, -h  Show this help and exit 0

Frame order (${CARVED_MOTIF_ORDER.length} x ${CELL_SIZE}x${CELL_SIZE}, anchor [${CARVED_MOTIF_ANCHOR.join(', ')}]):
  ${CARVED_MOTIF_ORDER.map((id, i) => `${i}:${id}`).join('  ')}`);
        return;
    }

    const bytes = bakeCarvedMotifsPng();
    if (argv.includes('--check')) {
        if (!existsSync(CARVED_MOTIFS_PATH) || !readFileSync(CARVED_MOTIFS_PATH).equals(bytes)) {
            console.error('[bake-carved-motifs] stale or missing: prop.carvedMotifs.png');
            console.error('[bake-carved-motifs] run: node scripts/sprites/bake-carved-motifs.mjs');
            process.exit(1);
        }
        console.log(`[bake-carved-motifs] current: prop.carvedMotifs.png (${SHEET_WIDTH}x${SHEET_HEIGHT}, ${CARVED_MOTIF_ORDER.length} frames, anchor [${CARVED_MOTIF_ANCHOR}])`);
        return;
    }

    mkdirSync(dirname(CARVED_MOTIFS_PATH), { recursive: true });
    writeFileSync(CARVED_MOTIFS_PATH, bytes);
    console.log(`[bake-carved-motifs] wrote prop.carvedMotifs.png (${SHEET_WIDTH}x${SHEET_HEIGHT}, ${CARVED_MOTIF_ORDER.length} frames, anchor [${CARVED_MOTIF_ANCHOR}])`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
    main(process.argv.slice(2));
}
