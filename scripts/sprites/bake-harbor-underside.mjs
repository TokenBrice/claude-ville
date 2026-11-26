#!/usr/bin/env node
// Wave 5-A (Spec 03 §1.2 item 5.5) — Deterministic Harbor Pier Underside Proxy Baker.
//
// Authors `claudeville/assets/sprites/buildings/building.harbor/underside.png`
// (384 x 284 RGBA8, anchor [131, 154]) aligned pixel-exact with the Harbor
// piers and stone quay in `building.harbor/base.png` + `SURFACE_SPECS.harbor`.
//
// Loaded ONLY by WebGPU `PlanarWaterPass` when rendering the reflected camera
// (`H' = 2*Z - H`, `sy' = sy + 2*(H - Z)`), supplying dark timber joists,
// X-braced crossbeams, shaded underside plank soffits, shaded pilings, and
// shaded stone quay undersides so top-view deck art never leaks into upside-
// down pier reflections.
//
// Strict ART_RAMPS palette (6 exact colors, <= 16, zero semi-alpha, zero bright
// top-deck highlights):
//   - Contact ink  : #060402
//   - Timber joists: ART_RAMPS.timber[0..1] (#2a1c14, #45301f)
//   - Quay soffit  : ART_RAMPS.ashlar[1..3] (#231821, #4c3a4c, #685c67)
//
// Usage:
//   node scripts/sprites/bake-harbor-underside.mjs           # write underside.png
//   node scripts/sprites/bake-harbor-underside.mjs --check   # verify on-disk bytes
//   node scripts/sprites/bake-harbor-underside.mjs --help    # show help

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { ART_RAMPS } from '../../claudeville/src/config/artPalette.js';
import { SURFACE_SPECS, footY, resolveBase } from './bake-surface-channel.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
export const HARBOR_DIR = join(REPO_ROOT, 'claudeville/assets/sprites/buildings/building.harbor');
export const HARBOR_BASE_PATH = join(HARBOR_DIR, 'base.png');
export const HARBOR_OCCLUDER_PATH = join(HARBOR_DIR, 'base.occluder.png');
export const HARBOR_MATERIAL_PATH = join(HARBOR_DIR, 'base.material.png');
export const HARBOR_UNDERSIDE_PATH = join(HARBOR_DIR, 'underside.png');

export const HARBOR_UNDERSIDE_META = Object.freeze({
    id: 'building.harbor',
    width: 384,
    height: 284,
    anchor: Object.freeze([131, 154]),
});

const parseHex = (hex) => Object.freeze([
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
]);

// Strict ART_RAMPS subset for Harbor underside proxy (6 colors total).
export const HARBOR_UNDERSIDE_PALETTE = Object.freeze({
    ink: parseHex('#060402'),
    timberDark: parseHex(ART_RAMPS.timber[0]),   // #2a1c14
    timberJoist: parseHex(ART_RAMPS.timber[1]),  // #45301f
    ashlarDeep: parseHex(ART_RAMPS.ashlar[1]),   // #231821
    ashlarMid: parseHex(ART_RAMPS.ashlar[2]),    // #4c3a4c
    ashlarSoft: parseHex(ART_RAMPS.ashlar[3]),   // #685c67
});

const ALLOWED_COLOR_KEYS = new Set(
    Object.values(HARBOR_UNDERSIDE_PALETTE).map(([r, g, b]) => (r << 16) | (g << 8) | b),
);

function pointInPolygon(poly, x, y) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const [xi, yi] = poly[i];
        const [xj, yj] = poly[j];
        if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
}

// 3x3 morphological closing (dilate then erode), clipped to opaque silhouette.
function closeWithinOpaque(mask, opaque, width, height, radius = 1) {
    const dilate = new Uint8Array(width * height);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const p = y * width + x;
            if (!opaque[p]) continue;
            let hit = false;
            for (let dy = -radius; !hit && dy <= radius; dy++) {
                const ny = y + dy;
                if (ny < 0 || ny >= height) continue;
                for (let dx = -radius; dx <= radius; dx++) {
                    const nx = x + dx;
                    if (nx >= 0 && nx < width && mask[ny * width + nx]) {
                        hit = true;
                        break;
                    }
                }
            }
            dilate[p] = hit ? 1 : 0;
        }
    }
    const eroded = new Uint8Array(width * height);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const p = y * width + x;
            if (!dilate[p]) continue;
            let all = true;
            for (let dy = -radius; all && dy <= radius; dy++) {
                const ny = y + dy;
                if (ny < 0 || ny >= height) { all = false; break; }
                for (let dx = -radius; dx <= radius; dx++) {
                    const nx = x + dx;
                    if (nx < 0 || nx >= width || !dilate[ny * width + nx]) {
                        all = false;
                        break;
                    }
                }
            }
            eroded[p] = all ? 1 : 0;
        }
    }
    return eroded;
}

// Connected-component extraction returning per-pixel component IDs (1..N) and
// tight isometric (along = x + 2*y, across = 2*y - x) extents for each pier deck.
function extractPierComponents(pierMask, width, height) {
    const compId = new Uint8Array(width * height);
    const piers = [];
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const start = y * width + x;
            if (!pierMask[start] || compId[start]) continue;
            const id = piers.length + 1;
            const stack = [start];
            compId[start] = id;
            const alongs = [];
            const acrosses = [];
            const pixels = [];
            while (stack.length) {
                const p = stack.pop();
                const cx = p % width;
                const cy = (p - cx) / width;
                pixels.push(p);
                alongs.push(cx + 2 * cy);
                acrosses.push(2 * cy - cx);
                if (cx > 0 && pierMask[p - 1] && !compId[p - 1]) { compId[p - 1] = id; stack.push(p - 1); }
                if (cx + 1 < width && pierMask[p + 1] && !compId[p + 1]) { compId[p + 1] = id; stack.push(p + 1); }
                if (cy > 0 && pierMask[p - width] && !compId[p - width]) { compId[p - width] = id; stack.push(p - width); }
                if (cy + 1 < height && pierMask[p + width] && !compId[p + width]) { compId[p + width] = id; stack.push(p + width); }
            }
            if (pixels.length < 120) {
                for (const p of pixels) compId[p] = 0;
                continue;
            }
            alongs.sort((a, b) => a - b);
            acrosses.sort((a, b) => a - b);
            // Robust 1%-99% isometric parallelogram bounds strip stray top-deck
            // bollard nubs while staying pixel-exact on every pier deck plank edge.
            const loIdx = Math.floor(alongs.length * 0.005);
            const hiIdx = Math.min(alongs.length - 1, Math.ceil(alongs.length * 0.995));
            const aLo = Math.floor(acrosses.length * 0.015);
            const aHi = Math.min(acrosses.length - 1, Math.ceil(acrosses.length * 0.985));
            piers.push({
                id,
                count: pixels.length,
                minAlong: alongs[loIdx],
                maxAlong: alongs[hiIdx],
                minAcross: acrosses[aLo],
                maxAcross: acrosses[aHi],
            });
        }
    }
    return { compId, piers };
}

function setPixel(data, width, x, y, rgb) {
    const o = (y * width + x) * 4;
    data[o] = rgb[0];
    data[o + 1] = rgb[1];
    data[o + 2] = rgb[2];
    data[o + 3] = 255;
}

/**
 * Deterministic Harbor underside proxy rasterizer.
 * Reads `base.png`, `base.occluder.png`, and `base.material.png` together with
 * `SURFACE_SPECS.harbor` geometry so every pier joist, X-braced crossbeam,
 * underside soffit plank, piling, and stone quay underside aligns pixel-exact.
 */
export function bakeHarborUnderside({ basePng, occluderPng, materialPng }) {
    const width = basePng.width;
    const height = basePng.height;
    if (width !== HARBOR_UNDERSIDE_META.width || height !== HARBOR_UNDERSIDE_META.height) {
        throw new Error(`Expected ${HARBOR_UNDERSIDE_META.width}x${HARBOR_UNDERSIDE_META.height} harbor base, got ${width}x${height}`);
    }

    const spec = SURFACE_SPECS.harbor;
    const quayBase = resolveBase(spec.base);
    // Region indices in SURFACE_SPECS.harbor:
    //   0: lantern, 1-2: jib crane, 3-4: bunting masts, 5: quay deck (h=16),
    //   6: pier decks (h=12), 7: house on quay.
    const lanternPoly = spec.regions[0].poly;
    const mastPolys = [spec.regions[3].poly, spec.regions[4].poly];
    const quayDeckPoly = spec.regions[5].poly;
    const pierZonePoly = spec.regions[6].poly;
    const housePoly = spec.regions[7].poly;

    const total = width * height;
    const opaque = new Uint8Array(total);
    const rawPierDeck = new Uint8Array(total);
    const rawQuayDeck = new Uint8Array(total);

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const p = y * width + x;
            const i = p * 4;
            if (basePng.data[i + 3] < 128) continue;
            opaque[p] = 1;
            const face = occluderPng.data[i + 2] >> 6;
            const h = occluderPng.data[i];
            if (face === 0 && h === 12 && pointInPolygon(pierZonePoly, x + 0.5, y + 0.5)) {
                rawPierDeck[p] = 1;
            } else if (face === 0 && h === 16 && pointInPolygon(quayDeckPoly, x + 0.5, y + 0.5)) {
                rawQuayDeck[p] = 1;
            }
        }
    }

    // Close 1-2px bollard/post gaps inside the pier deck silhouette so top-view
    // plank/bollard highlights never poke holes through the underside soffit.
    const pierDeck = closeWithinOpaque(rawPierDeck, opaque, width, height, 2);
    for (let p = 0; p < total; p++) {
        if (rawPierDeck[p]) pierDeck[p] = 1;
    }

    const { compId, piers } = extractPierComponents(pierDeck, width, height);

    // Heal any mast-base / bollard holes inside each pier's exact isometric
    // parallelogram (stays strictly inside base.png opaque silhouette & pier zone)
    // and trim top-side bollard nubs protruding above each pier's upper rim.
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const p = y * width + x;
            if (!opaque[p]) continue;
            if (!pointInPolygon(pierZonePoly, x + 0.5, y + 0.5)) continue;
            const along = x + 2 * y;
            const across = 2 * y - x;
            let matchedId = 0;
            for (const pier of piers) {
                if (
                    along >= pier.minAlong && along <= pier.maxAlong
                    && across >= pier.minAcross && across <= pier.maxAcross
                ) {
                    matchedId = pier.id;
                    break;
                }
            }
            if (matchedId > 0) compId[p] = matchedId;
        }
    }

    // Build pier substructure mask (pier fascia beams & vertical oak pilings
    // directly beneath each pier deck, excluding the tall bunting masts above
    // and top-side bollards sitting on the upper deck).
    const pierSub = new Uint8Array(total);
    // For every pier, track per-column bottommost deck row so substructure only
    // attaches cleanly beneath each pier's underside (never above its top rim).
    const pierBottomByCol = piers.map(() => new Int16Array(width).fill(-1));
    const pierTopByCol = piers.map(() => new Int16Array(width).fill(9999));
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const id = compId[y * width + x];
            if (id > 0) {
                const idx = id - 1;
                if (y < pierTopByCol[idx][x]) pierTopByCol[idx][x] = y;
                if (y > pierBottomByCol[idx][x]) pierBottomByCol[idx][x] = y;
            }
        }
    }

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const p = y * width + x;
            if (!opaque[p] || compId[p] > 0) continue;
            const px = x + 0.5;
            const py = y + 0.5;
            if (!pointInPolygon(pierZonePoly, px, py)) continue;
            const inMast = mastPolys.some(poly => pointInPolygon(poly, px, py));
            if (inMast) continue;
            // Must sit strictly beneath one of the three pier decks in this column
            // (fascia + hanging pilings), never above a deck or on the stone quay.
            let underPier = false;
            for (let idx = 0; idx < piers.length; idx++) {
                const bot = pierBottomByCol[idx][x];
                if (bot >= 0 && y > bot && y <= bot + 28) {
                    underPier = true;
                    break;
                }
            }
            if (!underPier) continue;
            const matId = materialPng.data[p * 4];
            if (matId === 1 && x < 236) continue;
            pierSub[p] = 1;
        }
    }

    // Build solid stone quay underside mask (no crane/lantern holes: looking up
    // from below, the stone quay slab & masonry wall are continuous solid stone):
    //   1. Quay coping/apron soffit: every opaque pixel inside `quayDeckPoly`.
    //   2. Coursed stone quay wall face: every opaque pixel below the quay deck
    //      down to the waterline `footY(quayBase, x) + 2` (outside pier masks).
    const quaySoffit = new Uint8Array(total);
    const quayWall = new Uint8Array(total);
    const colQuayDeckBottom = new Int16Array(width).fill(-1);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const p = y * width + x;
            if (!opaque[p] || compId[p] > 0 || pierSub[p]) continue;
            const px = x + 0.5;
            const py = y + 0.5;
            if (pointInPolygon(quayDeckPoly, px, py)) {
                // Exclude only the thin vertical lantern post top above the deck corner.
                if (pointInPolygon(lanternPoly, px, py) && y < 164) continue;
                quaySoffit[p] = 1;
                if (y > colQuayDeckBottom[x]) colQuayDeckBottom[x] = y;
            }
        }
    }
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const p = y * width + x;
            if (!opaque[p] || compId[p] > 0 || pierSub[p] || quaySoffit[p]) continue;
            const px = x + 0.5;
            const py = y + 0.5;
            if (pointInPolygon(housePoly, px, py)) continue;
            const fY = footY(quayBase, x);
            const deckBot = colQuayDeckBottom[x];
            if (x <= 236 && deckBot >= 0 && y > deckBot && y <= fY + 3) {
                quayWall[p] = 1;
            }
        }
    }

    const quaySoffitClosed = quaySoffit;

    const out = new PNG({ width, height, colorType: 6 });
    const { ink, timberDark, timberJoist, ashlarDeep, ashlarMid, ashlarSoft } = HARBOR_UNDERSIDE_PALETTE;

    // --------------------------------------------------------- Paint pier decks
    // Underside soffit seen from below (`H' = 2Z - H`):
    //   - Shaded transverse plank soffits (`timberDark` + 1px `ink` plank seams)
    //   - Two heavy longitudinal edge stringer joists + center spine joist (`timberJoist` + `ink`)
    //   - Periodic transverse piling-bent crossbeams (`timberJoist` + `ink`)
    //   - Diagonal X-braced crossbeams spanning between adjacent bents (`timberJoist` + `ink`)
    const BENT_SPACING = 60; // isometric `along` units (~24 horizontal px per bay)
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const p = y * width + x;
            const id = compId[p];
            if (id === 0) continue;
            const pier = piers[id - 1];
            const along = (x + 2 * y) - pier.minAlong;
            const spanAcross = Math.max(1, pier.maxAcross - pier.minAcross);
            const across = (2 * y - x) - pier.minAcross;

            // 1. Base shaded plank soffit (crosswise planks every 10 along-units)
            const plankMod = ((along % 10) + 10) % 10;
            let color = plankMod === 0 ? ink : timberDark;

            // 2. X-braced diagonal crossbeams between consecutive bent bays
            const bayAlong = ((along % BENT_SPACING) + BENT_SPACING) % BENT_SPACING;
            const bayT = bayAlong / BENT_SPACING; // 0..1 along bay
            const crossT = across / spanAcross;   // 0..1 across pier width
            const diagA = Math.abs(crossT - bayT);
            const diagB = Math.abs(crossT - (1 - bayT));
            const diagDist = Math.min(diagA, diagB);
            if (diagDist < 0.055) {
                color = timberJoist;
            } else if (diagDist < 0.095) {
                color = ink;
            }

            // 3. Longitudinal stringer joists (outer twin girders + center spine)
            const edgeLeft = across <= 7;
            const edgeRight = across >= spanAcross - 7;
            const centerDist = Math.abs(across - spanAcross * 0.5);
            if (
                (across >= 3 && across <= 6)
                || (across >= spanAcross - 6 && across <= spanAcross - 3)
                || centerDist <= 2.2
            ) {
                color = timberJoist;
            } else if (edgeLeft || edgeRight || centerDist <= 3.6) {
                color = ink;
            }

            // 4. Transverse piling-bent bearer crossbeams (over-ride planks/bracing)
            if (bayAlong <= 4 || bayAlong >= BENT_SPACING - 2) {
                color = (bayAlong === 0 || bayAlong === 4 || bayAlong === BENT_SPACING - 2) ? ink : timberJoist;
            }

            setPixel(out.data, width, x, y, color);
        }
    }

    // ----------------------------------------- Paint pier fascias and pilings
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const p = y * width + x;
            if (!pierSub[p]) continue;
            // Check distance to left/right edge of piling/fascia for crisp rib shading.
            const leftOn = x > 0 && (pierSub[p - 1] || compId[p - 1] > 0);
            const rightOn = x + 1 < width && (pierSub[p + 1] || compId[p + 1] > 0);
            const downOn = y + 1 < height && pierSub[p + width];
            const upDeck = y > 0 && compId[p - width] > 0;
            let color = timberDark;
            if (!leftOn || !rightOn || !downOn) {
                color = ink; // 1px underside contact ink & dark piling waterline foot
            } else if (upDeck) {
                color = ink; // deep soffit shadow right beneath pier deck overhang
            } else if ((x & 3) === 1 && downOn) {
                color = timberJoist; // subtle shaded grain rib along timber beam/piling
            }
            setPixel(out.data, width, x, y, color);
        }
    }

    // ----------------------------------------- Paint shaded stone quay soffit
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const p = y * width + x;
            if (!quaySoffitClosed[p]) continue;
            const along = x + 2 * y;
            const across = 2 * y - x;
            const row = Math.floor(across / 12);
            const col = Math.floor((along + (row & 1) * 10) / 20);
            const isMortar = ((across % 12) + 12) % 12 === 0 || (((along + (row & 1) * 10) % 20) + 20) % 20 === 0;
            // Subtle stone variation strictly within ashlar[1..3] — zero highlights.
            const hash = ((row * 37 + col * 17) & 3);
            let color = isMortar ? ashlarDeep : (hash === 0 ? ashlarSoft : ashlarMid);
            // Contact ink along the front coping lip bordering quay wall or water.
            const nearLip = (y + 1 < height && !quaySoffitClosed[p + width])
                || (x > 0 && !quaySoffitClosed[p - 1] && !opaque[p - 1]);
            if (nearLip) color = ashlarDeep;
            setPixel(out.data, width, x, y, color);
        }
    }

    // ------------------------------------------- Paint shaded stone quay wall
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const p = y * width + x;
            if (!quayWall[p]) continue;
            const fY = footY(quayBase, x);
            const distFromWater = Math.max(0, fY - y);
            const course = Math.floor(distFromWater / 5);
            const seamH = Math.floor(distFromWater) % 5 === 0;
            const blockX = Math.floor((x + (course & 1) * 5) / 10);
            const seamV = ((x + (course & 1) * 5) % 10) === 0;
            let color;
            if (distFromWater <= 2.5) {
                color = ink; // deep wet waterline contact ink
            } else if (seamH || seamV) {
                color = ashlarDeep;
            } else if (distFromWater <= 6) {
                color = ashlarDeep; // wet lower stone course
            } else {
                const faceSe = x >= quayBase.bottom[0];
                color = faceSe
                    ? (((course + blockX) & 1) === 0 ? ashlarDeep : ashlarMid)
                    : (((course + blockX) & 3) === 0 ? ashlarSoft : ashlarMid);
            }
            setPixel(out.data, width, x, y, color);
        }
    }

    // ------------------------------------ Crisp 1px #060402 outer silhouette ink
    const filled = new Uint8Array(total);
    for (let p = 0; p < total; p++) {
        if (out.data[p * 4 + 3] === 255) filled[p] = 1;
    }
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const p = y * width + x;
            if (!filled[p]) continue;
            const border = (
                x === 0 || y === 0 || x === width - 1 || y === height - 1
                || !filled[p - 1] || !filled[p + 1]
                || !filled[p - width] || !filled[p + width]
            );
            if (border) setPixel(out.data, width, x, y, ink);
        }
    }

    return {
        png: out,
        stats: inspectUndersidePng(out),
        pierCount: piers.length,
    };
}

/**
 * Inspects an underside proxy PNG for palette compliance, alpha crispness, and
 * dark luminance bounds (zero bright top-deck highlights).
 */
export function inspectUndersidePng(png) {
    const { width, height, data } = png;
    const colors = new Set();
    let opaquePixels = 0;
    let semiAlphaPixels = 0;
    let maxLinearLuma = 0;
    let maxEncodedLuma = 0;
    let offPalettePixels = 0;
    for (let i = 0; i < data.length; i += 4) {
        const a = data[i + 3];
        if (a === 0) continue;
        if (a !== 255) {
            semiAlphaPixels++;
            continue;
        }
        opaquePixels++;
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];
        const key = (r << 16) | (g << 8) | b;
        colors.add(key);
        if (!ALLOWED_COLOR_KEYS.has(key)) offPalettePixels++;
        const toLin = (c) => {
            const u = c / 255;
            return u <= 0.04045 ? u / 12.92 : ((u + 0.055) / 1.055) ** 2.4;
        };
        const yLin = 0.2126 * toLin(r) + 0.7152 * toLin(g) + 0.0722 * toLin(b);
        const yEnc = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
        if (yLin > maxLinearLuma) maxLinearLuma = yLin;
        if (yEnc > maxEncodedLuma) maxEncodedLuma = yEnc;
    }
    return {
        width,
        height,
        opaquePixels,
        semiAlphaPixels,
        uniqueColors: colors.size,
        offPalettePixels,
        maxLinearLuma,
        maxEncodedLuma,
    };
}

function printHelp() {
    console.log([
        'Usage: node scripts/sprites/bake-harbor-underside.mjs [--check] [--help]',
        '',
        'Deterministically bakes claudeville/assets/sprites/buildings/building.harbor/underside.png',
        '(384x284 RGBA8, anchor [131, 154]) aligned pixel-exact with building.harbor/base.png.',
        '',
        'Options:',
        '  --check   Verify on-disk underside.png matches the deterministic bake byte-for-byte.',
        '  --help    Show this usage text and exit 0.',
    ].join('\n'));
}

function main() {
    const args = process.argv.slice(2);
    if (args.includes('--help') || args.includes('-h')) {
        printHelp();
        return;
    }
    const checkOnly = args.includes('--check');
    const basePng = PNG.sync.read(readFileSync(HARBOR_BASE_PATH));
    const occluderPng = PNG.sync.read(readFileSync(HARBOR_OCCLUDER_PATH));
    const materialPng = PNG.sync.read(readFileSync(HARBOR_MATERIAL_PATH));
    const { png, stats, pierCount } = bakeHarborUnderside({ basePng, occluderPng, materialPng });

    if (stats.semiAlphaPixels !== 0) {
        throw new Error(`underside bake produced ${stats.semiAlphaPixels} semi-alpha pixels (expected 0)`);
    }
    if (stats.offPalettePixels !== 0) {
        throw new Error(`underside bake produced ${stats.offPalettePixels} off-palette pixels`);
    }
    if (stats.uniqueColors > 16) {
        throw new Error(`underside bake produced ${stats.uniqueColors} colors (max 16)`);
    }

    const bytes = PNG.sync.write(png, { colorType: 6 });
    if (checkOnly) {
        if (!existsSync(HARBOR_UNDERSIDE_PATH)) {
            console.error('[harbor-underside] MISSING claudeville/assets/sprites/buildings/building.harbor/underside.png');
            process.exit(1);
        }
        const existing = PNG.sync.read(readFileSync(HARBOR_UNDERSIDE_PATH));
        const same = existing.width === png.width
            && existing.height === png.height
            && Buffer.compare(existing.data, png.data) === 0;
        if (!same) {
            console.error('[harbor-underside] STALE underside.png differs from deterministic bake');
            process.exit(1);
        }
        console.log(
            `[harbor-underside] OK ${stats.width}x${stats.height}, piers=${pierCount}, `
            + `opaque=${stats.opaquePixels}, colors=${stats.uniqueColors}, `
            + `semiAlpha=${stats.semiAlphaPixels}, maxLinLuma=${stats.maxLinearLuma.toFixed(4)}`,
        );
        return;
    }

    writeFileSync(HARBOR_UNDERSIDE_PATH, bytes);
    console.log(
        `[harbor-underside] WROTE ${HARBOR_UNDERSIDE_PATH} (${bytes.length} B) — `
        + `${stats.width}x${stats.height}, piers=${pierCount}, opaque=${stats.opaquePixels}, `
        + `colors=${stats.uniqueColors}, semiAlpha=${stats.semiAlphaPixels}, maxLinLuma=${stats.maxLinearLuma.toFixed(4)}`,
    );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
    main();
}
