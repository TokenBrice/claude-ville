#!/usr/bin/env node
// Wave 1 (W1-C) — Deterministic 0-gen baker for plaza street furniture & water:
//   - prop.plazaBrazier      (48x48, anchor [24, 38], cold charcoal/ash, NO emissive)
//   - prop.plazaBrazier.lit  (48x48, anchor [24, 38], stepped 3-course pixel flame + emissive)
//   - prop.lantern           (32x44, anchor [16, 40], ashlar plinth + 3px iron post + gallows hex hood + 6x8 emissive)
//   - prop.plazaFountainWater (320x88, 4 frames of 80x88, anchor [40, 68], optional animated spout/ripple strip)
//
// Strictly 1x1 world-pixel orthographic art on ART_RAMPS & EFFECT_COLORS,
// zero semi-transparent anti-aliasing, crisp 1px #060402 selective outline.
//
// Usage:
//   node scripts/sprites/bake-plaza-props.mjs            write all PNGs + sidecars
//   node scripts/sprites/bake-plaza-props.mjs --check    fail if any on-disk PNG differs

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { ART_RAMPS, EFFECT_COLORS } from '../../claudeville/src/config/artPalette.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../..');
const PROPS_DIR = join(repoRoot, 'claudeville', 'assets', 'sprites', 'props');

const CHECK = process.argv.includes('--check');

// ------------------------------------------------------------------ palette

const hex = (h) => [
    parseInt(h.slice(1, 3), 16),
    parseInt(h.slice(3, 5), 16),
    parseInt(h.slice(5, 7), 16),
];

const INK = [0x06, 0x04, 0x02];
const ASHLAR = ART_RAMPS.ashlar.map(hex);
const SLATE = ART_RAMPS.slate.map(hex);
const STONE = ART_RAMPS.stone.map(hex);
const EMISSIVE = ART_RAMPS.emissive.map(hex);
const WORK = EFFECT_COLORS.work.map(hex);
const SHALLOW = ART_RAMPS.shallowWater.map(hex);
const FOAM = hex(ART_RAMPS.snow[3]); // #d9dfe1 crisp seafoam glint (exempt snow stop)

// Material class indices (docs/material-channel-contract.md)
const MAT = Object.freeze({
    unlit: 0,
    stone: 1,
    timber: 2,
    metal: 3,
    foliage: 4,
    water: 8,
    glassRune: 9,
    fire: 10,
});

// ------------------------------------------------------------------ helpers

function blankPng(w, h) {
    const png = new PNG({ width: w, height: h, colorType: 6 });
    png.data.fill(0);
    return png;
}

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

function rgbAt(png, x, y) {
    const i = (y * png.width + x) * 4;
    return [png.data[i], png.data[i + 1], png.data[i + 2]];
}

function lumaRgb(rgb) {
    return 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2];
}

// Crisp 1px external #060402 selective outline (4-connected outside silhouette).
// Updates material map to match nearest opaque neighbor's material class.
function applySelectiveOutline(albedo, matMap, skipFn = null) {
    const { width: w, height: h } = albedo;
    const outside = new Uint8Array(w * h);
    const stack = [];
    for (let x = 0; x < w; x++) {
        stack.push(x, (h - 1) * w + x);
    }
    for (let y = 0; y < h; y++) {
        stack.push(y * w, y * w + w - 1);
    }
    while (stack.length) {
        const idx = stack.pop();
        if (outside[idx] || albedo.data[idx * 4 + 3] > 127) continue;
        outside[idx] = 1;
        const x = idx % w;
        const y = (idx - x) / w;
        if (x > 0) stack.push(idx - 1);
        if (x < w - 1) stack.push(idx + 1);
        if (y > 0) stack.push(idx - w);
        if (y < h - 1) stack.push(idx + w);
    }
    const toInk = [];
    const dirs = [[-1, 0], [1, 0], [0, -1], [0, 1]];
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const idx = y * w + x;
            if (!outside[idx]) continue;
            if (skipFn && skipFn(x, y)) continue;
            let mat = null;
            let needInk = false;
            for (const [dx, dy] of dirs) {
                const nx = x + dx;
                const ny = y + dy;
                if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
                const ni = (ny * w + nx) * 4;
                if (albedo.data[ni + 3] <= 127) continue;
                if (lumaRgb([albedo.data[ni], albedo.data[ni + 1], albedo.data[ni + 2]]) >= 8) {
                    needInk = true;
                    if (mat === null) mat = matMap.data[ni];
                }
            }
            if (needInk) toInk.push([x, y, mat ?? MAT.stone]);
        }
    }
    for (const [x, y, mat] of toInk) {
        setPx(albedo, x, y, INK, 255);
        setPx(matMap, x, y, [mat, 0, 0], 255);
    }
}

function buildOccluderFromAlbedo(albedo, anchorY, strength = 255) {
    const occ = blankPng(albedo.width, albedo.height);
    for (let y = 0; y < albedo.height; y++) {
        const h = Math.max(0, Math.min(255, Math.round(anchorY - y)));
        for (let x = 0; x < albedo.width; x++) {
            const a = alphaAt(albedo, x, y);
            if (!a) continue;
            setPx(occ, x, y, [h, strength, 0], a);
        }
    }
    return occ;
}

// ------------------------------------------------------------------ 1. prop.plazaBrazier & .lit (48x48, anchor [24, 38])
// Orthographic 2:1 isometric octagonal ashlar plinth + splayed wrought-iron
// tripod + riveted iron fire bowl matching VillageWall / prop.wallBrazier.

function bakePlazaBrazier({ lit }) {
    const W = 48;
    const H = 48;
    const CX = 24;
    const ANCHOR_Y = 38;
    const albedo = blankPng(W, H);
    const matMap = blankPng(W, H);
    const emissive = lit ? blankPng(W, H) : null;

    const paint = (x, y, rgb, matClass, emRgb = null, emAlpha = 144) => {
        setPx(albedo, x, y, rgb, 255);
        setPx(matMap, x, y, [matClass, 0, 0], 255);
        if (emissive && emRgb) {
            setPx(emissive, x, y, emRgb, emAlpha);
        }
    };

    // Helper: octagonal 2:1 iso footprint test at center (CX, cy) with radius rx, ry
    // Octagon in iso plane: |dx|/rx <= 1, |dy|/ry <= 1, |dx|/rx + |dy|/ry <= 1.46
    const inOctagon = (x, y, cy, rx, ry) => {
        const dx = Math.abs(x - CX) / rx;
        const dy = Math.abs(y - cy) / ry;
        return dx <= 1.001 && dy <= 1.001 && (dx + dy) <= 1.44;
    };

    // --- A. Stepped octagonal ashlar stone plinth ---
    // Lower proud base step: z = 0..3 (center y = 37 down to 34, rx = 12, ry = 6)
    for (let z = 0; z <= 3; z++) {
        const cy = 37 - z;
        for (let y = cy - 6; y <= cy + 6; y++) {
            for (let x = CX - 12; x <= CX + 12; x++) {
                if (!inOctagon(x, y, cy, 11.6, 5.8)) continue;
                const dx = x - CX;
                const dy = y - cy;
                const isTop = z === 3;
                let stop;
                if (isTop) {
                    // Lit top chamfer bevel of lower step
                    stop = dx < -2 ? 7 : dx > 3 ? 5 : 6;
                    if (Math.abs(dy) >= 4 && dy > 0 && dx > 1) stop = 4;
                } else {
                    // Front faces of lower step: SW lit (left), front mid, SE shade (right)
                    if (dx <= -4) stop = z === 2 ? 6 : 5;
                    else if (dx <= 3) stop = z === 2 ? 5 : 4;
                    else stop = z === 2 ? 3 : 2;
                    // Vertical ashlar block joints on step
                    if ((x === CX - 4 || x === CX + 4) && z <= 2) stop = Math.max(1, stop - 2);
                    if (z === 0 && dy > 2) stop = Math.max(1, stop - 1);
                }
                paint(x, y, ASHLAR[stop], MAT.stone);
            }
        }
    }

    // Upper octagonal stone drum: z = 4..10 (center y = 33 down to 27, rx = 9.5, ry = 4.75)
    for (let z = 4; z <= 10; z++) {
        const cy = 37 - z;
        for (let y = cy - 5; y <= cy + 5; y++) {
            for (let x = CX - 10; x <= CX + 10; x++) {
                if (!inOctagon(x, y, cy, 9.4, 4.7)) continue;
                const dx = x - CX;
                const dy = y - cy;
                const isTop = z === 10;
                if (isTop) {
                    // Beveled ashlar cap stone
                    let stop = dx < -2 ? 8 : dx > 3 ? 5 : 7;
                    // Dark recessed iron-foot socket shadow in center
                    if (inOctagon(x, y, cy, 6.8, 3.3)) {
                        stop = dx < 0 ? 4 : 3;
                    } else if (dy > 2 && dx > 0) {
                        stop = 5;
                    }
                    paint(x, y, ASHLAR[stop], MAT.stone);
                } else {
                    // 2 stone courses (z=4..6 lower course, z=7..9 upper course)
                    const course = z >= 7 ? 1 : 0;
                    const isMortarRow = z === 6;
                    let stop;
                    if (dx <= -3) stop = course ? 6 : 5;       // SW sunlit face
                    else if (dx <= 3) stop = course ? 5 : 4;   // S front face
                    else stop = course ? 3 : 2;                // SE shaded face
                    // Ashlar block joint lines (staggered per course)
                    const jointA = course ? (x === CX - 3 || x === CX + 3) : (x === CX - 6 || x === CX || x === CX + 6);
                    if (isMortarRow) stop = Math.max(1, stop - 2);
                    else if (jointA && dy >= 0) stop = Math.max(1, stop - 2);
                    else if (z === 9 && dy > 1) stop = Math.min(7, stop + 1); // lip bevel under cap
                    paint(x, y, ASHLAR[stop], MAT.stone);
                }
            }
        }
    }

    // Internal crease line between drum base and lower step top
    for (let x = CX - 9; x <= CX + 9; x++) {
        const dy = Math.round(4.7 - Math.max(0, (Math.abs(x - CX) - 4) * 0.5));
        const y = 33 + dy;
        if (alphaAt(albedo, x, y)) {
            paint(x, y, ASHLAR[1], MAT.stone);
        }
    }

    // --- B. Wrought-iron tripod legs & collar gripping the stone top ---
    // Three splayed legs at left (-6, 28), center-front (0, 30), right (+6, 28)
    const legSpecs = [
        { x0: CX - 7, y0: 27, x1: CX - 5, y1: 23, lit: true },
        { x0: CX,     y0: 30, x1: CX,     y1: 24, lit: true },
        { x0: CX + 7, y0: 27, x1: CX + 5, y1: 23, lit: false },
    ];
    for (const leg of legSpecs) {
        const steps = 6;
        for (let s = 0; s <= steps; s++) {
            const t = s / steps;
            const lx = Math.round(leg.x0 + (leg.x1 - leg.x0) * t);
            const ly = Math.round(leg.y0 + (leg.y1 - leg.y0) * t);
            paint(lx - 1, ly, leg.lit ? SLATE[2] : SLATE[0], MAT.metal);
            paint(lx, ly, leg.lit ? SLATE[1] : SLATE[0], MAT.metal);
            paint(lx + 1, ly, INK, MAT.metal);
        }
        // Claw foot on stone cap
        paint(leg.x0 - 1, leg.y0 + 1, INK, MAT.metal);
        paint(leg.x0, leg.y0 + 1, leg.lit ? SLATE[2] : SLATE[1], MAT.metal);
        paint(leg.x0 + 1, leg.y0 + 1, INK, MAT.metal);
    }

    // --- C. Riveted wrought-iron fire bowl (z = 13..20, y = 25..17) ---
    // Flaring bowl radius increases upward: y=25 rx=6 -> y=19 rx=10
    for (let y = 25; y >= 18; y--) {
        const t = (25 - y) / 7; // 0 bottom .. 1 rim
        const rx = 6.0 + t * 4.4;
        const ry = rx * 0.5;
        for (let x = CX - 11; x <= CX + 11; x++) {
            const dx = (x - CX) / rx;
            if (Math.abs(dx) > 1.0) continue;
            // Draw front curved wall of the bowl
            const frontY = Math.round(y + Math.sqrt(Math.max(0, 1 - dx * dx)) * ry * 0.55);
            const band = (y === 22 || y === 19); // raised riveted iron bands
            let stop;
            if (dx < -0.35) stop = band ? 3 : 2;
            else if (dx < 0.25) stop = band ? 2 : 1;
            else stop = band ? 1 : 0;
            // Rivet highlights on raised bands
            if (band && (Math.abs(x - CX) === 2 || Math.abs(x - CX) === 6)) {
                stop = Math.min(3, stop + 1);
            }
            for (let fy = y; fy <= frontY; fy++) {
                // Dark crevice between iron bands
                const cStop = (fy === y + 1 && !band) ? Math.max(0, stop - 1) : stop;
                paint(x, fy, SLATE[cStop], MAT.metal);
            }
        }
    }

    // Back and front rim of iron fire bowl (ellipse at y = 18, rx = 10.4, ry = 5.0)
    const BOWL_CY = 18;
    const BOWL_RX = 10.4;
    const BOWL_RY = 5.0;
    for (let y = BOWL_CY - 6; y <= BOWL_CY + 6; y++) {
        for (let x = CX - 11; x <= CX + 11; x++) {
            const nx = (x - CX) / BOWL_RX;
            const ny = (y - BOWL_CY) / BOWL_RY;
            const d2 = nx * nx + ny * ny;
            if (d2 > 1.02) continue;
            if (d2 >= 0.62) {
                // Rim thickness (crenellated iron teeth around rim)
                const tooth = ((x + y) & 1) === 0;
                let stop;
                if (ny < 0) {
                    // Back rim
                    stop = nx < 0 ? 2 : 1;
                } else {
                    // Front rim
                    stop = nx < -0.25 ? 3 : nx < 0.3 ? 2 : 1;
                }
                if (tooth && d2 > 0.86) stop = Math.min(3, stop + 1);
                paint(x, y, SLATE[stop], MAT.metal);
            } else {
                // Inner bowl bed
                if (!lit) {
                    // Cold dark charcoal & pale grey ash heap (ZERO fire by day!)
                    const h = ((x * 73 ^ y * 139) & 15);
                    let col;
                    if (d2 < 0.25 && h < 7) col = STONE[2];      // pale grey ash crest
                    else if (h < 5) col = STONE[1];              // charcoal mid
                    else if (h < 10) col = STONE[0];             // dark charcoal
                    else if (d2 < 0.35 && h < 13) col = ASHLAR[4]; // ash dust highlight
                    else col = INK;                              // coal crevice
                    paint(x, y, col, MAT.stone);
                } else {
                    // Glowing ember coal bed (strictly on EFFECT_COLORS.work + ART_RAMPS.emissive)
                    const h = ((x * 53 ^ y * 97) & 7);
                    const core = d2 < 0.28;
                    let col;
                    if (core) col = h < 3 ? EMISSIVE[1] : EMISSIVE[0];
                    else if (d2 < 0.48) col = h < 4 ? WORK[1] : EMISSIVE[0];
                    else col = h < 3 ? WORK[0] : WORK[1];
                    paint(x, y, col, MAT.fire, col, 144);
                }
            }
        }
    }

    // Crenellated iron corner lugs on the bowl rim (echoes prop.wallBrazier)
    const lugs = [
        [CX - 10, BOWL_CY - 1, 2],
        [CX - 7,  BOWL_CY - 4, 3],
        [CX + 7,  BOWL_CY - 4, 2],
        [CX + 10, BOWL_CY - 1, 1],
        [CX - 7,  BOWL_CY + 4, 3],
        [CX + 7,  BOWL_CY + 4, 1],
    ];
    for (const [lx, ly, st] of lugs) {
        paint(lx, ly - 1, SLATE[st], MAT.metal);
        paint(lx, ly, SLATE[Math.max(0, st - 1)], MAT.metal);
    }

    // --- D. Cold charcoal mound OR Lit stepped 3-course pixel flame ---
    if (!lit) {
        // Low heaped cold charcoal & ash dome peaking 2px above rim
        const ashDome = [
            '....1221....',
            '..0123210...',
            '.010121010..',
        ];
        for (let r = 0; r < ashDome.length; r++) {
            const row = ashDome[r];
            for (let c = 0; c < row.length; c++) {
                const ch = row[c];
                if (ch === '.') continue;
                const col = ch === '0' ? STONE[0] : ch === '1' ? STONE[1] : ch === '2' ? STONE[2] : ASHLAR[4];
                paint(CX - 6 + c, BOWL_CY - 3 + r, col, MAT.stone);
            }
        }
    } else {
        // Stepped 3-course pixel flame (strictly on ART_RAMPS.emissive U EFFECT_COLORS.work)
        // '0'=WORK[0] #7a2e12, '1'=WORK[1] #e8762b, '2'=EMISSIVE[0] #ff9d4a,
        // '3'=EMISSIVE[1] #ffcf7a, '4'=EMISSIVE[2] #ffe9b8
        const flameGrid = [
            '.......0........',
            '......01........',
            '......12...0....',
            '.....0231..1....',
            '....01332.02....',
            '..0.12432021....',
            '..1023443120....',
            '..1234443210....',
            '.01234443210....',
            '.01244444210....',
            '..012444210.....',
            '...01232100.....',
        ];
        const flamePalette = {
            '0': WORK[0],
            '1': WORK[1],
            '2': EMISSIVE[0],
            '3': EMISSIVE[1],
            '4': EMISSIVE[2],
        };
        const fx0 = CX - 7;
        const fy0 = BOWL_CY - 11;
        for (let r = 0; r < flameGrid.length; r++) {
            const row = flameGrid[r];
            for (let c = 0; c < row.length; c++) {
                const ch = row[c];
                if (ch === '.') continue;
                const col = flamePalette[ch];
                paint(fx0 + c, fy0 + r, col, MAT.fire, col, 144);
            }
        }
        // Subtle warm bounce on inner bowl lip (albedo-only metal highlights, never emissive)
        for (let x = CX - 8; x <= CX + 8; x++) {
            const nx = (x - CX) / BOWL_RX;
            const frontLipY = BOWL_CY + Math.round(Math.sqrt(Math.max(0, 1 - nx * nx)) * BOWL_RY);
            if (Math.abs(nx) < 0.72) {
                paint(x, frontLipY - 1, SLATE[3], MAT.metal);
            }
        }
    }

    // Crisp 1px selective warm-black outline on outer silhouette
    // Leave flame tips softly outlined in dark ember/ink? No, OA-M1 requires selective outline on solid structure;
    // keep flame tips un-boxed (dark ember WORK[0] or crisp flame edge, matching prop.wallBrazier.lit!)
    applySelectiveOutline(albedo, matMap, lit ? (x, y) => y < BOWL_CY - 3 : null);

    const occluder = buildOccluderFromAlbedo(albedo, ANCHOR_Y, 255);
    return { albedo, material: matMap, occluder, emissive };
}

// ------------------------------------------------------------------ 2. prop.lantern (32x44, anchor [16, 40])
// Extending VillageWall.js `drawWallLantern` ironwork grammar to a freestanding
// 32x44 streetlamp:
//   - Stepped square 2:1 ashlar[1..6] base plinth at [16, 40]
//   - Tapered 3px-wide wrought-iron post (slate[0..3], OA-M1 min 3px mass!)
//   - Curled gallows bracket + gabled hexagonal lantern hood
//   - Dark slate glass unlit by day (slate[0..3] with upper-left cool glint)
//   - 6x8 hexagonal glass pane in .emissive.png (ART_RAMPS.emissive, alpha 200)

function bakeLantern() {
    const W = 32;
    const H = 44;
    const CX = 16;
    const ANCHOR_Y = 40;
    const albedo = blankPng(W, H);
    const matMap = blankPng(W, H);
    const emissive = blankPng(W, H);

    const paint = (x, y, rgb, matClass, emRgb = null, emAlpha = 200) => {
        setPx(albedo, x, y, rgb, 255);
        setPx(matMap, x, y, [matClass, 0, 0], 255);
        if (emRgb) setPx(emissive, x, y, emRgb, emAlpha);
    };

    // --- A. Stepped square 2:1 iso ashlar base plinth centered at [16, 40] ---
    // Lower tier: 11x6 diamond centered at (16, 39), height 2px (y=37..41)
    for (let z = 0; z <= 2; z++) {
        const cy = 39 - z;
        for (let dy = -3; dy <= 3; dy++) {
            for (let dx = -5; dx <= 5; dx++) {
                if (Math.abs(dx) / 5.2 + Math.abs(dy) / 2.7 > 1.0) continue;
                const x = CX + dx;
                const y = cy + dy;
                let stop;
                if (z === 2) {
                    stop = dx < -1 ? 8 : dx <= 1 ? 6 : 4;
                } else {
                    stop = dx < -1 ? 6 : dx <= 1 ? 4 : 2;
                    if (z === 0 && dy > 0) stop = Math.max(1, stop - 1);
                    if ((dx === -2 || dx === 2) && z === 1) stop = 1; // crisp ashlar joint
                }
                paint(x, y, ASHLAR[stop], MAT.stone);
            }
        }
    }
    // Upper stepped pedestal block: 7x4 diamond centered at (16, 36..35)
    for (let z = 0; z <= 2; z++) {
        const cy = 36 - z;
        for (let dy = -2; dy <= 2; dy++) {
            for (let dx = -3; dx <= 3; dx++) {
                if (Math.abs(dx) / 3.3 + Math.abs(dy) / 1.8 > 1.0) continue;
                const x = CX + dx;
                const y = cy + dy;
                let stop;
                if (z === 2) stop = dx <= 0 ? 8 : 5;
                else stop = dx < 0 ? 6 : dx === 0 ? 1 : 2; // sharp front-corner crease
                paint(x, y, ASHLAR[stop], MAT.stone);
            }
        }
    }

    // --- B. Tapered 3px wrought-iron post + classic curled gallows bracket ---
    // Base iron collar (y = 33..34)
    paint(14, 34, SLATE[3], MAT.metal);
    paint(15, 34, SLATE[2], MAT.metal);
    paint(16, 34, INK,      MAT.metal);
    paint(17, 34, SLATE[1], MAT.metal);
    paint(18, 34, SLATE[0], MAT.metal);
    paint(15, 33, SLATE[3], MAT.metal);
    paint(16, 33, SLATE[1], MAT.metal);
    paint(17, 33, SLATE[0], MAT.metal);

    // Tapered 3px solid wrought-iron post (x = 15..17, y = 32 down to y = 18)
    // Obeys OA-M1 >= 3px mass rule! Crisp upper-left hammered iron specular + dark core.
    for (let y = 32; y >= 18; y--) {
        const collar = y === 28 || y === 21;
        if (collar) {
            paint(14, y, SLATE[3], MAT.metal);
            paint(15, y, ASHLAR[7], MAT.metal);
            paint(16, y, SLATE[1], MAT.metal);
            paint(17, y, SLATE[1], MAT.metal);
            paint(18, y, SLATE[0], MAT.metal);
        } else {
            paint(15, y, (y % 3 === 0) ? SLATE[3] : SLATE[2], MAT.metal);
            paint(16, y, SLATE[1], MAT.metal);
            paint(17, y, SLATE[0], MAT.metal);
        }
    }

    // Twin open forged-iron scroll brackets flaring from the post head (y = 18..21)
    // plus a classic medieval lamplighter cross-bar at y = 21!
    const bracketPixels = [
        // Classic horizontal lamplighter cross-bar with finial knobs (y = 21)
        [11, 21, 3], [12, 21, 2], [13, 21, 3], [14, 21, 2],
        [18, 21, 1], [19, 21, 2], [20, 21, 1], [21, 21, 0],
        // Left open S-scroll gallows bracket supporting lantern base (clean air gap at x=12,y=18)
        [14, 20, 2], [13, 19, 3], [12, 18, 3], [11, 17, 3], [11, 16, 2], [12, 15, 3], [13, 16, 2], [14, 17, 1],
        // Right open S-scroll counter-bracket
        [18, 20, 1], [19, 19, 2], [20, 18, 2], [21, 17, 2], [21, 16, 1], [20, 15, 1], [19, 16, 1], [18, 17, 0],
    ];
    for (const [bx, by, st] of bracketPixels) {
        paint(bx, by, SLATE[st], MAT.metal);
    }

    // --- C. Gabled hexagonal lantern hood & 6x8 glass pane (VillageWall grammar) ---
    // Centered cleanly at x = 13..20, y = 2..17
    // Finial spire & stepped gabled hexagonal iron hood (y = 2..6)
    const hood = [
        // y, x0, row chars: '.' skip, 'i' ink, '0..3' SLATE[0..3], 'h' ASHLAR[7] bright iron specular
        [2, 16, 'h'],
        [3, 15, 'h31'],
        [4, 14, 'h3210'],
        [5, 13, 'h32i210i'],
        [6, 11, 'ih32i210100i'],
    ];
    for (const [hy, hx0, str] of hood) {
        for (let c = 0; c < str.length; c++) {
            const ch = str[c];
            if (ch === '.') continue;
            const col = ch === 'i' ? INK : ch === 'h' ? ASHLAR[7] : SLATE[Number(ch)];
            paint(hx0 + c, hy, col, MAT.metal);
        }
    }

    // 6x8 hexagonal glass chamber (x = 14..19, y = 7..14) framed by iron mullions (x = 13 & x = 20)
    // Unlit by day: dark slate glass with crisp central iron rib & bright upper-left sky glint (ZERO amber!)
    // Emissive sidecar: crisp 6x8 hexagonal glass pane on ART_RAMPS.emissive[0..2] at alpha 200!
    const EM_MAP = [
        [0, 1, 1, 1, 1, 0], // y = 7
        [1, 1, 2, 2, 1, 1], // y = 8
        [1, 2, 2, 2, 2, 1], // y = 9
        [1, 2, 2, 2, 2, 1], // y = 10
        [1, 1, 2, 2, 1, 1], // y = 11
        [0, 1, 2, 1, 1, 0], // y = 12
        [0, 1, 1, 1, 0, 0], // y = 13
        [0, 0, 1, 1, 0, 0], // y = 14
    ];
    for (let r = 0; r < 8; r++) {
        const y = 7 + r;
        // Left & right hexagonal wrought-iron corner bars
        paint(13, y, (r & 1) ? SLATE[3] : SLATE[2], MAT.metal);
        paint(20, y, (r & 1) ? SLATE[1] : SLATE[0], MAT.metal);
        for (let c = 0; c < 6; c++) {
            const x = 14 + c;
            let glassRgb;
            if (r === 0 || r === 7) {
                glassRgb = INK; // crisp dark frame shadow under eave & above sill
            } else if (c === 3 && (r === 2 || r === 3 || r === 4 || r === 5)) {
                glassRgb = INK; // central dark iron mullion dividing left/right hex panes (VillageWall grammar!)
            } else if ((r === 1 || r === 2) && (c === 1 || c === 2)) {
                glassRgb = ASHLAR[7]; // crisp upper-left cool sky reflection glint
            } else if (r === 3 && c === 1) {
                glassRgb = SLATE[3];
            } else if ((r === 1 || r === 2) && c === 4) {
                glassRgb = SLATE[3]; // secondary right pane glint
            } else if (c === 0 || c === 5) {
                glassRgb = SLATE[0];
            } else {
                glassRgb = SLATE[1]; // calm dark slate unlit glass
            }
            const emStop = EM_MAP[r][c];
            paint(x, y, glassRgb, MAT.glassRune, EMISSIVE[emStop], 200);
        }
    }

    // Tapered hexagonal iron sill & cradle base (y = 15..17)
    const sill = [
        [15, 13, 'h32i100i'],
        [16, 14, '321i00'],
        [17, 15, '3i0'],
    ];
    for (const [sy, sx0, str] of sill) {
        for (let c = 0; c < str.length; c++) {
            const ch = str[c];
            const col = ch === 'i' ? INK : ch === 'h' ? ASHLAR[7] : SLATE[Number(ch)];
            paint(sx0 + c, sy, col, MAT.metal);
        }
    }

    // Crisp 1px external #060402 selective outline
    applySelectiveOutline(albedo, matMap);

    const occluder = buildOccluderFromAlbedo(albedo, ANCHOR_Y, 217);
    return { albedo, material: matMap, occluder, emissive };
}

// ------------------------------------------------------------------ 3. prop.plazaFountainWater (320x88, 4 frames of 80x88)
// Animated 4-frame spout stream & concentric basin ripple overlay registered
// cleanly to prop.plazaFountain.png (80x88, anchor [40, 68]).
// Strictly on ART_RAMPS.shallowWater[0..2] + crisp snow[3] foam glint (ZERO #1be7ff!).

export function bakePlazaFountainWater(fountainPath = join(PROPS_DIR, 'prop.plazaFountain.png')) {
    const FW = 80;
    const FH = 88;
    const FRAMES = 4;
    const strip = blankPng(FW * FRAMES, FH);

    // Locked to prop.plazaFountain.png twin verdigris bronze spout mouths & basin pool:
    //   Left spout stream:  x = 30..31, y = 34..56 -> splashes into basin at (30, 56)
    //   Right spout stream: x = 50,     y = 31..49 -> splashes into basin at (50, 50)
    //   Basin water center: (40, 55), rx = 18, ry = 7
    const spouts = [
        { x: 30, y0: 34, y1: 56, width: 2 },
        { x: 50, y0: 31, y1: 50, width: 1 },
    ];
    const basinCx = 40;
    const basinCy = 55;

    const putFramePx = (frame, x, y, rgb) => {
        if (x < 0 || y < 0 || x >= FW || y >= FH) return;
        setPx(strip, frame * FW + x, y, rgb, 255);
    };

    for (let f = 0; f < FRAMES; f++) {
        // 1. Stepped falling pixel water bands along both bronze spout streams
        for (const sp of spouts) {
            for (let y = sp.y0; y <= sp.y1; y++) {
                const phase = ((y - sp.y0 - f) % 4 + 4) % 4;
                if (phase === 3) continue;
                const col = phase === 0 ? FOAM : phase === 1 ? SHALLOW[2] : SHALLOW[1];
                putFramePx(f, sp.x, y, col);
                if (sp.width > 1 && phase <= 1) {
                    putFramePx(f, sp.x + 1, y, phase === 0 ? SHALLOW[2] : SHALLOW[1]);
                }
            }
            // Expanding foam splash ring where each stream strikes the basin water
            const r = 1 + (f % 3);
            const sx = sp.x;
            const sy = sp.y1;
            putFramePx(f, sx - r, sy, SHALLOW[2]);
            putFramePx(f, sx + r, sy, SHALLOW[2]);
            putFramePx(f, sx, sy - Math.max(1, r - 1), f % 2 === 0 ? FOAM : SHALLOW[2]);
            putFramePx(f, sx, sy + 1, SHALLOW[2]);
        }

        // 2. Gentle basin shimmer glints inside the water ring (never overlapping the stone rim!)
        const shimmerSets = [
            [[25, 53, SHALLOW[2]], [36, 59, FOAM], [48, 56, SHALLOW[2]], [54, 52, SHALLOW[1]]],
            [[26, 54, FOAM], [38, 58, SHALLOW[2]], [46, 57, SHALLOW[2]], [52, 53, SHALLOW[2]]],
            [[24, 55, SHALLOW[2]], [34, 58, SHALLOW[2]], [49, 55, FOAM], [55, 51, SHALLOW[1]]],
            [[27, 52, SHALLOW[2]], [35, 60, SHALLOW[2]], [47, 58, SHALLOW[1]], [53, 54, FOAM]],
        ];
        for (const [gx, gy, col] of shimmerSets[f]) {
            putFramePx(f, gx, gy, col);
            if (col === FOAM) putFramePx(f, gx + 1, gy, SHALLOW[2]);
        }
        // Subtle 2px ripple around central column base
        putFramePx(f, basinCx - 5 + (f % 2), basinCy + 4, SHALLOW[2]);
        putFramePx(f, basinCx + 4 - (f % 2), basinCy + 3, SHALLOW[2]);
    }

    return strip;
}

// ------------------------------------------------------------------ write / check

function writeOrCheck(outputs) {
    let mismatches = 0;
    for (const { rel, png } of outputs) {
        const abs = join(PROPS_DIR, rel);
        const buf = PNG.sync.write(png, { colorType: 6 });
        if (CHECK) {
            if (!existsSync(abs)) {
                console.error(`[bake-plaza-props] MISSING: ${rel}`);
                mismatches++;
                continue;
            }
            const cur = readFileSync(abs);
            if (Buffer.compare(cur, buf) !== 0) {
                console.error(`[bake-plaza-props] STALE: ${rel} differs from baker output`);
                mismatches++;
            } else {
                console.log(`[bake-plaza-props] ok: ${rel} (${png.width}x${png.height})`);
            }
        } else {
            mkdirSync(dirname(abs), { recursive: true });
            writeFileSync(abs, buf);
            console.log(`[bake-plaza-props] wrote ${rel} (${png.width}x${png.height})`);
        }
    }
    if (CHECK && mismatches > 0) {
        console.error(`[bake-plaza-props] FAIL: ${mismatches} file(s) out of date; run node scripts/sprites/bake-plaza-props.mjs`);
        process.exit(1);
    }
}

function main() {
    const coldBrazier = bakePlazaBrazier({ lit: false });
    const litBrazier = bakePlazaBrazier({ lit: true });
    const lantern = bakeLantern();

    const outputs = [
        { rel: 'prop.plazaBrazier.png', png: coldBrazier.albedo },
        { rel: 'prop.plazaBrazier.material.png', png: coldBrazier.material },
        { rel: 'prop.plazaBrazier.occluder.png', png: coldBrazier.occluder },

        { rel: 'prop.plazaBrazier.lit.png', png: litBrazier.albedo },
        { rel: 'prop.plazaBrazier.lit.material.png', png: litBrazier.material },
        { rel: 'prop.plazaBrazier.lit.occluder.png', png: litBrazier.occluder },
        { rel: 'prop.plazaBrazier.lit.emissive.png', png: litBrazier.emissive },

        { rel: 'prop.lantern.png', png: lantern.albedo },
        { rel: 'prop.lantern.material.png', png: lantern.material },
        { rel: 'prop.lantern.occluder.png', png: lantern.occluder },
        { rel: 'prop.lantern.emissive.png', png: lantern.emissive },
    ];

    if (existsSync(join(PROPS_DIR, 'prop.plazaFountain.png'))) {
        outputs.push({
            rel: 'prop.plazaFountainWater.png',
            png: bakePlazaFountainWater(),
        });
    }

    writeOrCheck(outputs);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
    main();
}
