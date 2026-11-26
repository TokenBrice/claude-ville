#!/usr/bin/env node
// Wave 4 Pre-Production (Spec 03 §1.2 item 4.2 & Spec 04 §4.7) —
// Deterministic 0-gen baker for `overlay.inspectionGlass.rim.png` (228x228,
// anchor [114, 114]).
//
// Geometry:
//   - Inner aperture: exact 220 px diameter disc from `GLASS_ROW_SPANS`,
//     100% transparent (alpha = 0).
//   - Outer bezel: exact 228 px diameter disc from `GLASS_OUTER_ROW_SPANS`,
//     forming a 4 px stepped brass ring with:
//       * 1 px #060402 outer ink ring
//       * 1 px #060402 inner ink ring
//       * 3 crisp bevelled brass courses on ART_RAMPS.trimGold[1..2] and
//         ART_RAMPS.clothOchre[0..1] (upper-left lit bevel, mid brass,
//         lower-right shaded bevel) plus 4 cardinal rivets.
//   - ZERO anti-aliasing (alpha strictly 0 or 255), ZERO smooth gradients,
//     ZERO Tier-A pixels, ZERO off-ramp pixels, ZERO canvas arc primitives.
//
// Usage:
//   node scripts/sprites/bake-inspection-glass.mjs            write overlay.inspectionGlass.rim.png
//   node scripts/sprites/bake-inspection-glass.mjs --check    exit 1 if PNG is stale/missing
//   node scripts/sprites/bake-inspection-glass.mjs --help     show help and exit 0

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { ART_RAMPS } from '../../claudeville/src/config/artPalette.js';
import {
    GLASS_OUTER_ROW_SPANS,
    GLASS_RADIUS,
    GLASS_RIM_ANCHOR,
    GLASS_RIM_SIZE,
    GLASS_ROW_SPANS,
} from '../../claudeville/src/presentation/character-mode/InspectionGlass.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../..');
export const INSPECTION_GLASS_RIM_PATH = join(
    repoRoot,
    'claudeville',
    'assets',
    'sprites',
    'overlays',
    'overlay.inspectionGlass.rim.png',
);

const hex = (h) => [
    parseInt(h.slice(1, 3), 16),
    parseInt(h.slice(3, 5), 16),
    parseInt(h.slice(5, 7), 16),
];

// Strictly ART_RAMPS stops below Tier A plus #060402 selective ink.
const INK = [0x06, 0x04, 0x02];
const BRASS_LIT = hex(ART_RAMPS.trimGold[2]);   // #ebb754 (S 0.643, L 0.522)
const BRASS_MID = hex(ART_RAMPS.trimGold[1]);   // #d4984e (S 0.632, L 0.370)
const BRASS_WARM = hex(ART_RAMPS.clothOchre[1]); // #c9a04a (S 0.632, L 0.369)
const BRASS_SHADE = hex(ART_RAMPS.clothOchre[0]); // #987638 (S 0.632, L 0.194)

function buildDiscMask(size, center, spans, radiusOffset) {
    const mask = new Uint8Array(size * size);
    for (let i = 0; i < spans.length; i++) {
        const span = spans[i];
        const y = center + span.y;
        if (y < 0 || y >= size) continue;
        const xStart = center + span.x0;
        const xEnd = xStart + span.width;
        const row = y * size;
        for (let x = xStart; x < xEnd; x++) {
            if (x >= 0 && x < size) mask[row + x] = 1;
        }
    }
    return mask;
}

export function bakeInspectionGlassRimPng() {
    const size = GLASS_RIM_SIZE; // 228
    const cx = GLASS_RIM_ANCHOR[0]; // 114
    const cy = GLASS_RIM_ANCHOR[1]; // 114
    const innerMask = buildDiscMask(size, cx, GLASS_ROW_SPANS, GLASS_RADIUS);
    const outerMask = buildDiscMask(size, cx, GLASS_OUTER_ROW_SPANS, cx);

    const png = new PNG({ width: size, height: size, colorType: 6 });
    png.data.fill(0);

    const inOuter = (x, y) => x >= 0 && x < size && y >= 0 && y < size && outerMask[y * size + x] === 1;
    const inInner = (x, y) => x >= 0 && x < size && y >= 0 && y < size && innerMask[y * size + x] === 1;
    const dirs = [[-1, 0], [1, 0], [0, -1], [0, 1]];

    for (let y = 0; y < size; y++) {
        const dy = y - cy;
        const py = dy + 0.5;
        for (let x = 0; x < size; x++) {
            const idx = y * size + x;
            // Inner 220 px aperture MUST be 100% transparent; outside 228 px disc is transparent.
            if (!outerMask[idx] || innerMask[idx]) continue;

            // 1 px outer ink ring (touches outside) and 1 px inner ink ring (touches aperture).
            let touchesOutside = false;
            let touchesInner = false;
            for (const [ox, oy] of dirs) {
                if (!inOuter(x + ox, y + oy)) touchesOutside = true;
                if (inInner(x + ox, y + oy)) touchesInner = true;
            }

            let rgb;
            if (touchesOutside || touchesInner) {
                rgb = INK;
            } else {
                const dx = x - cx;
                const px = dx + 0.5;
                const r = Math.hypot(px, py);
                // Upper-left key light projection in [-1, +1] (+1 at NW, -1 at SE).
                const keyDot = (-px - py) / (r * Math.SQRT2);
                const outerCourse = r >= GLASS_RADIUS + 2.0;

                // 3 crisp stepped brass courses: upper-left lit bevel, mid brass,
                // lower-right shaded bevel. The outer chamfer faces outward (lit
                // at NW, shaded at SE); the inner chamfer faces into the aperture
                // (catches subtle return glint on SE, shaded under the NW lip).
                if (outerCourse) {
                    if (keyDot > 0.25) rgb = BRASS_LIT;
                    else if (keyDot > -0.25) rgb = BRASS_MID;
                    else rgb = BRASS_SHADE;
                } else {
                    if (keyDot > 0.45) rgb = BRASS_WARM;
                    else if (keyDot > -0.35) rgb = BRASS_MID;
                    else rgb = BRASS_SHADE;
                }

                // 4 subtle cardinal brass rivets at N, S, E, W inside the 2 px brass core.
                const atNS = (dx === -1 || dx === 0) && (Math.abs(dy) >= GLASS_RADIUS + 1);
                const atEW = (dy === -1 || dy === 0) && (Math.abs(dx) >= GLASS_RADIUS + 1);
                if (atNS || atEW) {
                    rgb = (dx === -1 || dy === -1) ? BRASS_LIT : BRASS_SHADE;
                }
            }

            const p = idx * 4;
            png.data[p] = rgb[0];
            png.data[p + 1] = rgb[1];
            png.data[p + 2] = rgb[2];
            png.data[p + 3] = 255;
        }
    }

    return PNG.sync.write(png, { colorType: 6 });
}

function main(argv) {
    if (argv.includes('--help') || argv.includes('-h')) {
        console.log(`Usage: node scripts/sprites/bake-inspection-glass.mjs [--check | --help]

  (default)   Write claudeville/assets/sprites/overlays/overlay.inspectionGlass.rim.png (${GLASS_RIM_SIZE}x${GLASS_RIM_SIZE}, anchor [${GLASS_RIM_ANCHOR.join(', ')}])
  --check     Exit 1 if on-disk PNG is missing or differs from deterministic bake
  --help, -h  Show this help and exit 0`);
        return;
    }

    const bytes = bakeInspectionGlassRimPng();
    if (argv.includes('--check')) {
        if (!existsSync(INSPECTION_GLASS_RIM_PATH) || !readFileSync(INSPECTION_GLASS_RIM_PATH).equals(bytes)) {
            console.error('[bake-inspection-glass] stale or missing: overlay.inspectionGlass.rim.png');
            console.error('[bake-inspection-glass] run: node scripts/sprites/bake-inspection-glass.mjs');
            process.exit(1);
        }
        console.log(`[bake-inspection-glass] current: overlay.inspectionGlass.rim.png (${GLASS_RIM_SIZE}x${GLASS_RIM_SIZE}, anchor [${GLASS_RIM_ANCHOR}])`);
        return;
    }

    mkdirSync(dirname(INSPECTION_GLASS_RIM_PATH), { recursive: true });
    writeFileSync(INSPECTION_GLASS_RIM_PATH, bytes);
    console.log(`[bake-inspection-glass] wrote overlay.inspectionGlass.rim.png (${GLASS_RIM_SIZE}x${GLASS_RIM_SIZE}, anchor [${GLASS_RIM_ANCHOR}])`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
    main(process.argv.slice(2));
}
