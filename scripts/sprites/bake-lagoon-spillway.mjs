#!/usr/bin/env node
// Wave 6-A (Spec 03 item 6.1) — Deterministic 0-gen baker for prop.lagoonSpillway:
//   - prop.lagoonSpillway.png  (256x96, 4 frames of 64x96, anchor [32, 82])
//
// Mossy coursed-ashlar sluice retaining cheeks matching VillageWall masonry
// (ART_RAMPS.ashlar[0..6], ART_RAMPS.tideline[0..2] wet waterline,
// ART_RAMPS.foliage[0..2] moss drapes) flanking a 4-frame stepped vertical
// pixel waterfall (ART_RAMPS.deepWater[0..2], ART_RAMPS.shallowWater[0..2],
// ART_RAMPS.snow[3..4] foam glints & bottom splash collar).
//
// Zero blur, zero semi-alpha, <= 32 colors, 100% strict ART_RAMPS colors,
// OA-M1 grain density calibrated to [0.70, 1.30] vs building.tavern.
//
// Usage:
//   node scripts/sprites/bake-lagoon-spillway.mjs            write PNG
//   node scripts/sprites/bake-lagoon-spillway.mjs --check    exit 1 if stale/missing
//   node scripts/sprites/bake-lagoon-spillway.mjs --help     print usage

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { ART_RAMPS } from '../../claudeville/src/config/artPalette.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../..');
const PROPS_DIR = join(repoRoot, 'claudeville', 'assets', 'sprites', 'props');
const OUT_FILE = 'prop.lagoonSpillway.png';

export const SPILLWAY_SPEC = Object.freeze({
    frames: 4,
    frameWidth: 64,
    frameHeight: 96,
    width: 256,
    height: 96,
    anchor: Object.freeze([32, 82]),
    fps: 6,
});

// ------------------------------------------------------------------ strict ART_RAMPS palette

const hex = (h) => [
    parseInt(h.slice(1, 3), 16),
    parseInt(h.slice(3, 5), 16),
    parseInt(h.slice(5, 7), 16),
];

const ASHLAR = ART_RAMPS.ashlar.slice(0, 7).map(hex);   // ashlar[0..6] (#050302 .. #a99f9a)
const TIDELINE = ART_RAMPS.tideline.slice(0, 3).map(hex); // wet dark waterline & algae
const FOLIAGE = ART_RAMPS.foliage.slice(0, 3).map(hex); // muted sage moss
const DEEP = ART_RAMPS.deepWater.map(hex);              // deep sluice water shadows
const SHALLOW = ART_RAMPS.shallowWater.map(hex);        // stepped waterfall ribbons
const SNOW = [hex(ART_RAMPS.snow[3]), hex(ART_RAMPS.snow[4])]; // crisp foam crests & droplets

const INK = ASHLAR[0]; // #050302 (strict ART_RAMPS.ashlar[0])

function hash(a, b = 0, c = 0) {
    let h = Math.imul(a | 0, 374761393) ^ Math.imul(b | 0, 668265263) ^ Math.imul(c | 0, 1103515245);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
}

class FrameCanvas {
    constructor(w, h) {
        this.w = w;
        this.h = h;
        this.rgb = new Uint8Array(w * h * 3);
        this.opaque = new Uint8Array(w * h);
        this.kind = new Uint8Array(w * h); // 1 = stone/moss, 2 = water/foam
        this.depth = new Float32Array(w * h).fill(-Infinity);
    }

    set(x, y, col, kind = 1, zDepth = 0) {
        if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
        const p = y * this.w + x;
        if (zDepth < this.depth[p]) return;
        this.depth[p] = zDepth;
        this.opaque[p] = 1;
        this.kind[p] = kind;
        const i = p * 3;
        this.rgb[i] = col[0];
        this.rgb[i + 1] = col[1];
        this.rgb[i + 2] = col[2];
    }

    paintForce(x, y, col, kind = 2) {
        if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
        const p = y * this.w + x;
        this.opaque[p] = 1;
        this.kind[p] = kind;
        const i = p * 3;
        this.rgb[i] = col[0];
        this.rgb[i + 1] = col[1];
        this.rgb[i + 2] = col[2];
    }
}

function paintStoneCheek(canvas, side) {
    const isLeft = side < 0;
    const uMin = isLeft ? -23 : 11;
    const uMax = isLeft ? -11 : 23;
    const innerU = isLeft ? uMax : uMin;
    const outerU = isLeft ? uMin : uMax;

    const paintBlockVolume = (u0, u1, d0, d1, h0, h1, isCoping = false, isPlinth = false) => {
        for (let d = d1; d >= d0; d--) {
            for (let h = h0; h <= h1; h++) {
                for (let u = u0; u <= u1; u++) {
                    const isTop = h === h1;
                    const isFront = d === d0;
                    const isInnerWall = u === innerU;
                    const isOuterWall = u === outerU;
                    if (!isTop && !isFront && !isInnerWall && !isOuterWall) continue;

                    const sx = 32 + u;
                    const sy = 78 - Math.floor(d / 2) - h;
                    const zDepth = -d * 4 + h * 0.25 + (isFront ? 0.5 : 0);

                    // Crisp 5px ashlar courses with VillageWall-style 1px block jitter
                    const courseH = 5;
                    const courseIdx = Math.floor(h / courseH);
                    const blockLen = isPlinth ? 6 : 5;
                    const stagger = (courseIdx % 2) * 2;
                    const localU = u - u0 + stagger + 32;
                    const blockId = Math.floor(localU / blockLen);
                    const inBlockU = localU % blockLen;
                    const jitter = (h > 5 && h < h1 - 3 && hash(side * 19 + courseIdx, blockId, 7) < 0.24) ? 1 : 0;
                    const courseRow = ((h + jitter) % courseH + courseH) % courseH;
                    const isBedJoint = courseRow === 0 && h > h0;
                    const isHeadJoint = inBlockU === 0 && u !== u0 && u !== u1;

                    let col;
                    if (isTop) {
                        // Coping cap top slabs with crisp mortar grooves & damp moss tufts
                        const slabJoint = (((u + (d > 7 ? 2 : 0) + 32) % 5) === 0) || d === 7;
                        if (slabJoint) {
                            col = ASHLAR[1];
                        } else if (isCoping && d === d0) {
                            col = ASHLAR[isLeft ? 6 : 5];
                        } else {
                            const r = hash(u >> 1, d >> 1, side + 41);
                            col = isLeft
                                ? ASHLAR[r < 0.35 ? 5 : 6]
                                : ASHLAR[r < 0.45 ? 4 : 5];
                        }
                        const nearSluice = Math.abs(u - innerU) <= 4;
                        const mossRoll = hash(u >> 1, d >> 1, side + 91);
                        if ((nearSluice && mossRoll > 0.46) || (d >= 8 && mossRoll > 0.66)) {
                            col = FOLIAGE[mossRoll > 0.78 ? 2 : 0];
                        }
                    } else if (isInnerWall && !isFront) {
                        const wet = h <= 16 || d <= 4;
                        col = wet
                            ? TIDELINE[isBedJoint ? 0 : 1]
                            : ASHLAR[isBedJoint ? 0 : 2];
                    } else if (isFront) {
                        // Front masonry face: crisp crevice joints (ashlar[1]) vs sunlit/shaded blocks
                        if (h <= 7) {
                            const wetAlgae = h >= 4 && h <= 6 && hash(u, h, side + 55) > 0.52;
                            if (isBedJoint || h === 0 || isHeadJoint) col = ASHLAR[0];
                            else if (wetAlgae) col = FOLIAGE[1];
                            else col = TIDELINE[isLeft && h >= 5 ? 1 : 0];
                        } else if (isBedJoint || isHeadJoint) {
                            // Deep recessed ashlar mortar shadow (matches VillageWall & Tavern grain)
                            col = ASHLAR[isLeft ? 1 : 0];
                        } else if (isCoping) {
                            col = ASHLAR[isLeft ? (h === h1 - 1 ? 6 : 4) : (h === h1 - 1 ? 4 : 2)];
                        } else if (h === 47) {
                            // Crisp under-coping drip shadow row
                            col = ASHLAR[1];
                        } else {
                            const r = hash(courseIdx * 13 + side, blockId, 19);
                            let stop = isLeft
                                ? (r < 0.25 ? 4 : r > 0.62 ? 6 : 5)
                                : (r < 0.28 ? 2 : r > 0.68 ? 4 : 3);
                            // Sunlit top bevel along each block's upper row
                            if (isLeft && courseRow === courseH - 1 && !isPlinth) stop = 6;
                            if (!isLeft && courseRow === courseH - 1 && !isPlinth) stop = Math.min(5, stop + 1);
                            // Subtle stone pit & damp darkening near base / sluice cheek
                            if (h < 13 || Math.abs(u - innerU) <= 1) stop = Math.max(2, stop - 1);
                            if (hash(u, h, side + 127) < 0.08) stop = Math.max(1, stop - 2);
                            col = ASHLAR[stop];

                            // Hanging moss drapes below the coping & damp crevice moss near splash
                            const mossDepth = Math.abs(u - innerU) <= 4 ? 9 : 5;
                            if (h >= 40 && h <= 46 && (46 - h) < mossDepth && hash(u, courseIdx, side + 77) > 0.50) {
                                col = FOLIAGE[h >= 45 ? 2 : h >= 43 ? 1 : 0];
                            } else if (h >= 9 && h <= 17 && Math.abs(u - innerU) <= 3 && hash(u >> 1, h, side + 83) > 0.62) {
                                col = FOLIAGE[h > 13 ? 2 : 0];
                            }
                        }
                    } else {
                        if (h <= 7) col = TIDELINE[isBedJoint ? 0 : 1];
                        else if (isBedJoint) col = ASHLAR[0];
                        else col = ASHLAR[isLeft ? 4 : 2];
                    }

                    canvas.set(sx, sy, col, 1, zDepth);
                }
            }
        }
    };

    paintBlockVolume(uMin, uMax, 0, 14, 0, 47, false, false);
    paintBlockVolume(uMin - (isLeft ? 1 : 0), uMax + (isLeft ? 0 : 1), -2, 12, 0, 9, false, true);
    paintBlockVolume(uMin - 1, uMax + 1, -1, 15, 48, 51, true, false);
}

function paintWeirArchAndLip(canvas) {
    for (let h = 0; h <= 43; h++) {
        for (let u = -10; u <= 10; u++) {
            const sx = 32 + u;
            const sy = 78 - 2 - h;
            const col = h <= 8 ? TIDELINE[0] : (h % 5 === 0 ? ASHLAR[0] : ASHLAR[2]);
            canvas.set(sx, sy, col, 1, -18);
        }
    }

    // Upper raised lagoon approach basin behind the notched stone weir
    for (let d = 14; d >= 5; d--) {
        for (let u = -10; u <= 10; u++) {
            const sx = 32 + u;
            const sy = 78 - Math.floor(d / 2) - 46;
            const edgeDark = Math.abs(u) >= 9;
            const ripple = ((u + d) % 4 === 0);
            const col = edgeDark
                ? DEEP[0]
                : (d <= 6 ? SHALLOW[2] : (ripple ? SHALLOW[1] : DEEP[2]));
            canvas.set(sx, sy, col, 2, -d * 4 + 11.5);
        }
    }

    // Wet chamfered weir corner stones
    for (const s of [-1, 1]) {
        const nu = s < 0 ? -10 : 10;
        for (let d = 5; d <= 12; d++) {
            const sx = 32 + nu;
            const sy = 78 - Math.floor(d / 2) - 47;
            canvas.set(sx, sy, ASHLAR[s < 0 ? 4 : 2], 1, -d * 4 + 12.5);
        }
    }
}

// Per-column waterfall ribbon definitions (strictly vertical streams — zero diagonal plaid!)
// Columns span dx = -10..+10 across the 21px spillway mouth.
const WATER_COLUMNS = [
    { kind: 'edge', offset: 0, speed: 3 },   // -10
    { kind: 'trough', offset: 5, speed: 3 }, // -9
    { kind: 'bright', offset: 2, speed: 4 }, // -8
    { kind: 'bright', offset: 2, speed: 4 }, // -7
    { kind: 'trough', offset: 9, speed: 3 }, // -6
    { kind: 'foam', offset: 1, speed: 4 },   // -5
    { kind: 'core', offset: 6, speed: 3 },   // -4
    { kind: 'trough', offset: 3, speed: 3 }, // -3
    { kind: 'bright', offset: 8, speed: 4 }, // -2
    { kind: 'foam', offset: 4, speed: 4 },   // -1
    { kind: 'bright', offset: 4, speed: 4 }, //  0
    { kind: 'trough', offset: 10, speed: 3 },// +1
    { kind: 'core', offset: 2, speed: 3 },   // +2
    { kind: 'foam', offset: 7, speed: 4 },   // +3
    { kind: 'bright', offset: 7, speed: 4 }, // +4
    { kind: 'trough', offset: 1, speed: 3 }, // +5
    { kind: 'foam', offset: 10, speed: 4 },  // +6
    { kind: 'core', offset: 5, speed: 3 },   // +7
    { kind: 'bright', offset: 0, speed: 4 }, // +8
    { kind: 'trough', offset: 6, speed: 3 }, // +9
    { kind: 'edge', offset: 3, speed: 3 },   // +10
];

function paintWaterfallFrame(canvas, frame) {
    const yTop = 30;
    const yLip = 33;
    const yPool = 79;

    // 1. Stepped vertical pixel waterfall sheet (vertical ribbons descending cleanly each frame)
    for (let y = yTop; y <= yPool; y++) {
        const halfW = y < yLip ? 9 : (y > yPool - 4 ? 11 : 10);
        for (let dx = -halfW; dx <= halfW; dx++) {
            const x = 32 + dx;
            const absDx = Math.abs(dx);
            const colSpec = WATER_COLUMNS[Math.max(0, Math.min(WATER_COLUMNS.length - 1, dx + 10))];
            const phase = ((y - yTop - frame * colSpec.speed + colSpec.offset) % 12 + 12) % 12;

            let col;
            if (y <= yLip) {
                // Curving upper weir lip break
                const crestTick = ((dx * 2 + frame * 3) % 6 + 6) % 6;
                if (y === yLip && absDx <= 7 && (colSpec.kind === 'foam' || crestTick === 0)) {
                    col = SNOW[0];
                } else if (absDx >= halfW - 1) {
                    col = DEEP[1];
                } else if (y === yLip) {
                    col = SHALLOW[2];
                } else if (colSpec.kind === 'trough') {
                    col = DEEP[2];
                } else {
                    col = SHALLOW[1];
                }
            } else if (absDx === halfW) {
                // Dark shaded water trough hugging the wet stone walls
                col = phase < 4 ? DEEP[2] : DEEP[1];
            } else if (colSpec.kind === 'edge') {
                col = phase < 3 ? SHALLOW[0] : phase < 7 ? DEEP[2] : DEEP[1];
            } else if (colSpec.kind === 'trough') {
                // Deep dark vertical channel separating bright foam ribbons
                col = phase < 2 ? SHALLOW[1] : phase < 6 ? DEEP[2] : DEEP[1];
            } else if (colSpec.kind === 'foam') {
                // Primary frothy falling vertical ribbon with crisp stepping foam beads
                if (phase === 0 && y > yLip + 3 && y < yPool - 4) col = SNOW[0];
                else if (phase <= 4) col = SHALLOW[2];
                else if (phase <= 8) col = SHALLOW[1];
                else col = DEEP[2];
            } else if (colSpec.kind === 'bright') {
                if (phase <= 3) col = SHALLOW[2];
                else if (phase <= 7) col = SHALLOW[1];
                else if (phase <= 9) col = SHALLOW[0];
                else col = DEEP[2];
            } else {
                // Core ribbon
                if (phase <= 2) col = SHALLOW[2];
                else if (phase <= 5) col = SHALLOW[0];
                else if (phase <= 8) col = DEEP[2];
                else col = DEEP[1];
            }

            canvas.paintForce(x, y, col, 2);
        }
    }

    // 2. 4-phase isometric splash collar & concentric pixel ripple basin around anchor (32, 82)
    const cx = 32;
    const cy = 82;
    const rxOuter = 17 + (frame % 2);
    const ryOuter = 6 + (frame === 1 || frame === 2 ? 1 : 0);

    for (let y = cy - 7; y <= cy + 8; y++) {
        for (let x = cx - 20; x <= cx + 20; x++) {
            const nx = (x - cx) / rxOuter;
            const ny = (y - cy) / ryOuter;
            const r2 = nx * nx + ny * ny;
            if (r2 > 1.0) continue;

            // Concentric stepped pixel rings expanding outward across the 4 frames
            const dist = Math.sqrt(r2);
            const ringWave = ((Math.floor(dist * 10) - frame) % 4 + 4) % 4;
            const seg = Math.floor((Math.atan2(ny, nx) + Math.PI) * 5) + frame;

            if (r2 > 0.76) {
                // Broken outer foam ring
                if ((seg & 1) === 1 && r2 > 0.85) continue;
                canvas.paintForce(x, y, ringWave === 0 ? SHALLOW[2] : (r2 > 0.88 ? DEEP[1] : DEEP[2]), 2);
            } else if (r2 > 0.42) {
                // Mid splash basin: alternating dark water trough & bright concentric foam arcs
                let col;
                if (ringWave === 0) col = SHALLOW[2];
                else if (ringWave === 1) col = SHALLOW[1];
                else if (ringWave === 2) col = DEEP[2];
                else col = DEEP[1];
                canvas.paintForce(x, y, col, 2);
            } else {
                // Impact boil directly under waterfall foot: clean frothy tufts, no checkerboard
                const lobe = Math.abs(((x - cx + frame * 2) % 6 + 6) % 6 - 3);
                let col;
                if (y <= cy && lobe === 0 && ((x + frame) & 1) === 0) col = SNOW[1];
                else if (lobe <= 1 && y <= cy + 2) col = SNOW[0];
                else if (lobe <= 2) col = SHALLOW[2];
                else col = SHALLOW[0];
                canvas.paintForce(x, y, col, 2);
            }
        }
    }

    // 3. Stepped jumping spray beads around impact collar (crisp 1px droplets)
    const droplets = [
        [cx - 12, cy - 5 - (frame % 2), SHALLOW[2]],
        [cx - 7, cy - 6 - ((frame + 1) % 3), SNOW[0]],
        [cx - 2, cy - 5 - ((frame + 2) % 3), SHALLOW[2]],
        [cx + 4, cy - 6 - ((frame + 3) % 3), SNOW[0]],
        [cx + 9, cy - 5 - ((frame + 1) % 2), SHALLOW[2]],
        [cx - 15 + frame, cy - 1, SHALLOW[2]],
        [cx + 15 - frame, cy - 1, SHALLOW[2]],
    ];
    for (const [dx, dy, col] of droplets) {
        canvas.paintForce(dx, dy, col, 2);
    }
}

function applyStoneSelectiveOutline(canvas) {
    const { w, h, opaque, kind } = canvas;
    const toInk = [];
    const dirs = [[-1, 0], [1, 0], [0, -1], [0, 1]];
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const p = y * w + x;
            if (opaque[p]) continue;
            let touchesStone = false;
            for (const [dx, dy] of dirs) {
                const nx = x + dx;
                const ny = y + dy;
                if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
                const np = ny * w + nx;
                if (opaque[np] && kind[np] === 1) {
                    touchesStone = true;
                    break;
                }
            }
            if (touchesStone) toInk.push([x, y]);
        }
    }
    for (const [x, y] of toInk) {
        canvas.paintForce(x, y, INK, 1);
    }
}

export function bakeLagoonSpillwayPng() {
    const { frames, frameWidth: FW, frameHeight: FH, width: W, height: H } = SPILLWAY_SPEC;
    const png = new PNG({ width: W, height: H, colorType: 6 });
    png.data.fill(0);

    for (let f = 0; f < frames; f++) {
        const fc = new FrameCanvas(FW, FH);
        paintWeirArchAndLip(fc);
        paintStoneCheek(fc, -1);
        paintStoneCheek(fc, 1);
        paintWaterfallFrame(fc, f);
        applyStoneSelectiveOutline(fc);

        for (let y = 0; y < FH; y++) {
            for (let x = 0; x < FW; x++) {
                const p = y * FW + x;
                if (!fc.opaque[p]) continue;
                const dst = (y * W + (f * FW + x)) * 4;
                png.data[dst] = fc.rgb[p * 3];
                png.data[dst + 1] = fc.rgb[p * 3 + 1];
                png.data[dst + 2] = fc.rgb[p * 3 + 2];
                png.data[dst + 3] = 255;
            }
        }
    }

    return png;
}

// ------------------------------------------------------------------ CLI

function usage() {
    console.log(`Usage: node scripts/sprites/bake-lagoon-spillway.mjs [--check | --help]

  (default)   Write ${OUT_FILE} (${SPILLWAY_SPEC.width}x${SPILLWAY_SPEC.height}, ${SPILLWAY_SPEC.frames} frames of ${SPILLWAY_SPEC.frameWidth}x${SPILLWAY_SPEC.frameHeight}, anchor [${SPILLWAY_SPEC.anchor}])
  --check     Exit 1 if on-disk PNG is missing or differs from deterministic baker output
  --help, -h  Show this help message and exit`);
}

function main() {
    const args = process.argv.slice(2);
    if (args.includes('--help') || args.includes('-h')) {
        usage();
        process.exit(0);
    }

    const check = args.includes('--check');
    const png = bakeLagoonSpillwayPng();
    const buf = PNG.sync.write(png, { colorType: 6 });
    const abs = join(PROPS_DIR, OUT_FILE);

    if (check) {
        if (!existsSync(abs)) {
            console.error(`[bake-lagoon-spillway] MISSING: ${OUT_FILE}`);
            process.exit(1);
        }
        const cur = readFileSync(abs);
        if (Buffer.compare(cur, buf) !== 0) {
            console.error(`[bake-lagoon-spillway] STALE: ${OUT_FILE} differs from baker output; run node scripts/sprites/bake-lagoon-spillway.mjs`);
            process.exit(1);
        }
        console.log(`[bake-lagoon-spillway] ok: ${OUT_FILE} (${png.width}x${png.height}, anchor [${SPILLWAY_SPEC.anchor}])`);
        return;
    }

    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, buf);
    console.log(`[bake-lagoon-spillway] wrote ${OUT_FILE} (${png.width}x${png.height}, anchor [${SPILLWAY_SPEC.anchor}])`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
    main();
}
