#!/usr/bin/env node
// Wave 6-A (Spec 03 item 6.2) — Deterministic 0-gen baker for the E2 Terrace
// Stair Flights & Retaining Wall Corner Kit:
//   - prop.terraceStair.ne.png    (64x48, anchor [32, 36], 8px rise = 4x 2px risers/treads)
//   - prop.terraceStair.nw.png    (64x48, anchor [32, 36])
//   - prop.terraceStair.se.png    (64x48, anchor [32, 36])
//   - prop.terraceStair.sw.png    (64x48, anchor [32, 36])
//   - prop.terraceCorner.inner.png (32x32, anchor [16, 24])
//   - prop.terraceCorner.outer.png (32x32, anchor [16, 24])
//
// Adheres strictly to the Triangle Strategy face-value ladder (top k, sun k-1,
// shade k-2, joint k-3) on ART_RAMPS.ashlar, worn ART_RAMPS.plaza[2..4] tread
// nosings, subtle ART_RAMPS.foliage[0..1] crevice moss, and 1px #060402
// selective outline. Zero semi-alpha, <= 24 colors, strict ART_RAMPS,
// OA-M1 grain density calibrated to [0.70, 1.30] vs building.tavern.
//
// Usage:
//   node scripts/sprites/bake-terrace-kit.mjs            write all 6 PNGs
//   node scripts/sprites/bake-terrace-kit.mjs --check    exit 1 if any PNG is stale/missing
//   node scripts/sprites/bake-terrace-kit.mjs --help     print usage

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { ART_RAMPS } from '../../claudeville/src/config/artPalette.js';
import { faceStopIndex } from '../../claudeville/src/presentation/character-mode/SurfaceProjection.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../..');
const PROPS_DIR = join(repoRoot, 'claudeville', 'assets', 'sprites', 'props');

export const TERRACE_KIT_SPEC = Object.freeze({
    stair: Object.freeze({
        width: 64,
        height: 48,
        anchor: Object.freeze([32, 36]),
        risePx: 8,
        steps: 4,
        riserPx: 2,
        directions: Object.freeze(['ne', 'nw', 'se', 'sw']),
    }),
    corner: Object.freeze({
        width: 32,
        height: 32,
        anchor: Object.freeze([16, 24]),
        wallHeightPx: 8,
        variants: Object.freeze(['inner', 'outer']),
    }),
});

// ------------------------------------------------------------------ strict ART_RAMPS palette

const hex = (h) => [
    parseInt(h.slice(1, 3), 16),
    parseInt(h.slice(3, 5), 16),
    parseInt(h.slice(5, 7), 16),
];

const ASHLAR = ART_RAMPS.ashlar.map(hex);          // stops 0..8
const PLAZA = ART_RAMPS.plaza.map(hex);            // worn tread nosings use stops 2..4
const FOLIAGE = ART_RAMPS.foliage.slice(0, 2).map(hex); // crevice moss stops 0..1
const OUTLINE_INK = [0x06, 0x04, 0x02];            // #060402 selective outline

// Triangle Strategy face-value ladder via SurfaceProjection.faceStopIndex:
//   top = k, sun = k-1, shade = k-2, joint = k-3 (clamped to ART_RAMPS.ashlar)
const ashlarFace = (baseStop, face) => ASHLAR[faceStopIndex(baseStop, face, ASHLAR.length)];

function hash(a, b = 0, c = 0) {
    let h = Math.imul(a | 0, 374761393) ^ Math.imul(b | 0, 668265263) ^ Math.imul(c | 0, 1103515245);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
}

// ------------------------------------------------------------------ orthographic 2:1 iso voxel canvas

class IsoVoxelBuffer {
    constructor(width, height, originX, originY) {
        this.w = width;
        this.h = height;
        this.originX = originX;
        this.originY = originY;
        this.rgb = new Uint8Array(width * height * 3);
        this.opaque = new Uint8Array(width * height);
        this.depth = new Float32Array(width * height).fill(-Infinity);
    }

    plot(u, v, h, col, tieBias = 0) {
        const sx = this.originX + (u - v);
        const sy = this.originY + Math.floor((u + v) / 2) - h;
        if (sx < 0 || sy < 0 || sx >= this.w || sy >= this.h) return;
        const d = (u + v) + h * 0.5 + tieBias;
        const p = sy * this.w + sx;
        if (d < this.depth[p]) return;
        this.depth[p] = d;
        this.opaque[p] = 1;
        const i = p * 3;
        this.rgb[i] = col[0];
        this.rgb[i + 1] = col[1];
        this.rgb[i + 2] = col[2];
    }

    paintBox({ u0, u1, v0, v1, h0, h1 }, shadeFn) {
        // 1. Top face (+H at h = h1)
        for (let u = u0; u <= u1; u++) {
            for (let v = v0; v <= v1; v++) {
                const col = shadeFn('top', u, v, h1);
                if (col) this.plot(u, v, h1, col, 0.08);
            }
        }
        // 2. SE face (+U at u = u1, shaded side)
        for (let v = v0; v <= v1; v++) {
            for (let h = h0; h < h1; h++) {
                const col = shadeFn('se', u1, v, h);
                if (col) this.plot(u1, v, h, col, 0.02);
            }
        }
        // 3. SW face (+V at v = v1, sunlit side)
        for (let u = u0; u <= u1; u++) {
            for (let h = h0; h < h1; h++) {
                const col = shadeFn('sw', u, v1, h);
                if (col) this.plot(u, v1, h, col, 0.04);
            }
        }
    }

    toPngWithSelectiveOutline() {
        const { w, h, rgb, opaque } = this;
        const png = new PNG({ width: w, height: h, colorType: 6 });
        png.data.fill(0);

        for (let p = 0; p < w * h; p++) {
            if (!opaque[p]) continue;
            const d = p * 4;
            png.data[d] = rgb[p * 3];
            png.data[d + 1] = rgb[p * 3 + 1];
            png.data[d + 2] = rgb[p * 3 + 2];
            png.data[d + 3] = 255;
        }

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
            if (outside[idx] || opaque[idx]) continue;
            outside[idx] = 1;
            const x = idx % w;
            const y = (idx - x) / w;
            if (x > 0) stack.push(idx - 1);
            if (x < w - 1) stack.push(idx + 1);
            if (y > 0) stack.push(idx - w);
            if (y < h - 1) stack.push(idx + w);
        }

        const dirs = [[-1, 0], [1, 0], [0, -1], [0, 1]];
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                const p = y * w + x;
                if (!outside[p]) continue;
                let adjacent = false;
                for (const [dx, dy] of dirs) {
                    const nx = x + dx;
                    const ny = y + dy;
                    if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
                    if (opaque[ny * w + nx]) {
                        adjacent = true;
                        break;
                    }
                }
                if (adjacent) {
                    const d = p * 4;
                    png.data[d] = OUTLINE_INK[0];
                    png.data[d + 1] = OUTLINE_INK[1];
                    png.data[d + 2] = OUTLINE_INK[2];
                    png.data[d + 3] = 255;
                }
            }
        }
        return png;
    }
}

// ------------------------------------------------------------------ shared ashlar wall shader

function shadeRetainingWall(face, coordAlong, h, hMax, seed, allowMoss = true) {
    // 4px ashlar courses with VillageWall block stagger, 1px course jitter,
    // and crisp dark crevice joints (ashlar[2] on SW, ashlar[1] on SE).
    const courseH = 4;
    const course = Math.floor(h / courseH);
    const blockLen = 5;
    const stagger = (course % 2) * 2;
    const shifted = coordAlong + stagger + 64;
    const blockId = Math.floor(shifted / blockLen);
    const inBlock = shifted % blockLen;
    const jitter = (h > 0 && h < hMax - 1 && hash(seed + course, blockId, 3) < 0.22) ? 1 : 0;
    const row = ((h + jitter) % courseH + courseH) % courseH;
    const isBedJoint = row === 0 && h > 0;
    const isHeadJoint = inBlock === 0;

    // Crevice moss at footing mortar intersections
    if (allowMoss && h <= 2 && (isBedJoint || isHeadJoint) && hash(coordAlong, h, seed + 41) < 0.34) {
        return FOLIAGE[face === 'sw' ? 1 : 0];
    }

    if (face === 'sw') {
        // Sunlit SW face: block body ashlar[6..7] (`sun`), mortar joints ashlar[3] (`joint` of stop 6)
        if (isBedJoint) return ashlarFace(5, 'joint');               // ashlar[2] crisp horizontal course bed
        if (isHeadJoint) return ashlarFace(6, 'joint');              // ashlar[3] vertical block seam
        if (h === hMax - 1) return ashlarFace(8, 'sun');             // ashlar[7] upper bevel under coping
        const r = hash(seed + course * 7, blockId, 11);
        return r < 0.35 ? ashlarFace(6, 'sun') : ashlarFace(7, 'sun'); // ashlar[5..6]
    }

    // Shaded SE face: block body ashlar[3..4] (`shade`), joints ashlar[1..2] (`joint`)
    if (isBedJoint) return ashlarFace(4, 'joint');               // ashlar[1] deep horizontal bed
    if (isHeadJoint) return ashlarFace(5, 'joint');              // ashlar[2] vertical block seam
    if (h === hMax - 1) return ashlarFace(6, 'shade');           // ashlar[4]
    const r = hash(seed + course * 11, blockId, 17);
    return r < 0.45 ? ashlarFace(5, 'shade') : ashlarFace(6, 'shade'); // ashlar[3..4]
}

// ------------------------------------------------------------------ 1. 4-direction Terrace Stairs (64x48)

export function bakeTerraceStairPng(direction) {
    const { width: W, height: H, steps, riserPx } = TERRACE_KIT_SPEC.stair;
    const buf = new IsoVoxelBuffer(W, H, 32, 31);
    const HALF = 12;
    const CHEEK = 3;
    const STEP_RUN = 6;
    const seed = direction.charCodeAt(0) * 31 + direction.charCodeAt(1) * 17;

    const toUV = (climb, across) => {
        if (direction === 'ne') return { u: across, v: HALF - climb };
        if (direction === 'sw') return { u: across, v: -HALF + climb };
        if (direction === 'nw') return { u: HALF - climb, v: across };
        return { u: -HALF + climb, v: across }; // 'se'
    };

    const boxFromClimbAcross = (c0, c1, a0, a1, h0, h1) => {
        const p0 = toUV(c0, a0);
        const p1 = toUV(c1, a1);
        return {
            u0: Math.min(p0.u, p1.u),
            u1: Math.max(p0.u, p1.u),
            v0: Math.min(p0.v, p1.v),
            v1: Math.max(p0.v, p1.v),
            h0,
            h1,
        };
    };

    // A. Solid coursed-stone under-carriage + 4 stepped treads (h = 2, 4, 6, 8)
    for (let s = 0; s < steps; s++) {
        const c0 = s * STEP_RUN;
        const c1 = (s === steps - 1) ? (steps * STEP_RUN) : ((s + 1) * STEP_RUN);
        const stepTop = (s + 1) * riserPx;
        const treadBox = boxFromClimbAcross(c0, c1, -HALF + CHEEK, HALF - CHEEK, 0, stepTop);

        buf.paintBox(treadBox, (face, u, v, h) => {
            if (face === 'top') {
                const climb = direction === 'ne' ? (HALF - v)
                    : direction === 'sw' ? (v + HALF)
                        : direction === 'nw' ? (HALF - u)
                            : (u + HALF);
                const across = (direction === 'ne' || direction === 'sw') ? u : v;
                const localRun = climb - c0;

                // Crevice moss where tread meets cheek wall
                if (Math.abs(across) >= HALF - CHEEK - 1 && localRun >= STEP_RUN - 2 && hash(s, across, seed + 13) < 0.42) {
                    return FOLIAGE[localRun === STEP_RUN - 1 ? 0 : 1];
                }
                // Crisp recessed stone slab seams across each tread (2-3 paving stones per step)
                const slabOff = (s % 2) * 3;
                const slabSeam = (((across + 16 + slabOff) % 6) === 0);
                if (slabSeam && localRun > 0) {
                    return ashlarFace(6, 'joint'); // ashlar[3] flagstone joint
                }
                // Back tread crevice sitting immediately beneath the next step riser
                if (localRun === STEP_RUN - 1 && s < steps - 1) {
                    return ashlarFace(5, 'joint'); // ashlar[2] crisp step undercut shadow
                }
                // Worn front tread nosing catches bright warm plaza[4] highlight
                if (localRun === 0) {
                    return Math.abs(across) <= 6 ? PLAZA[4] : PLAZA[3];
                }
                if (localRun === 1) {
                    return Math.abs(across) <= 5 ? PLAZA[3] : PLAZA[2];
                }
                return hash(u >> 1, v >> 1, seed + s) < 0.4 ? PLAZA[2] : PLAZA[3];
            }

            // Crisp 2px step risers on front-facing NE / NW ascents
            const isRiser = (direction === 'ne' && face === 'sw')
                || (direction === 'nw' && face === 'se');
            if (isRiser) {
                const isBottomRow = (h === stepTop - riserPx);
                const along = face === 'sw' ? u : v;
                const riserJoint = (((along + s * 2 + 16) % 6) === 0);
                if (face === 'sw') {
                    if (isBottomRow || riserJoint) return ashlarFace(6, 'joint'); // ashlar[3]
                    return ashlarFace(7, 'sun');                                  // ashlar[6]
                }
                if (isBottomRow || riserJoint) return ashlarFace(5, 'joint');     // ashlar[2]
                return ashlarFace(6, 'shade');                                    // ashlar[4]
            }

            const along = face === 'sw' ? u : v;
            return shadeRetainingWall(face, along, h, stepTop, seed + s * 5, true);
        });
    }

    // B. Stepped ashlar stringer cheek walls (+2px coping parapet above each step)
    for (const side of [-1, 1]) {
        const a0 = side < 0 ? -HALF : (HALF - CHEEK);
        const a1 = side < 0 ? (-HALF + CHEEK) : HALF;

        for (let s = 0; s < steps; s++) {
            const c0 = s * STEP_RUN;
            const c1 = (s === steps - 1) ? (steps * STEP_RUN) : ((s + 1) * STEP_RUN);
            const cheekTop = (s + 1) * riserPx + 2;
            const cheekBox = boxFromClimbAcross(c0, c1, a0, a1, 0, cheekTop);

            buf.paintBox(cheekBox, (face, u, v, h) => {
                if (face === 'top') {
                    const along = (direction === 'ne' || direction === 'sw') ? v : u;
                    const isEndJoint = (((along + 24) % STEP_RUN) === 0);
                    if (isEndJoint) return ashlarFace(5, 'joint');
                    const isSunEdge = (u === cheekBox.u0 || v === cheekBox.v0);
                    if (isSunEdge) return ASHLAR[8];
                    if (s <= 1 && hash(u, v, seed + side * 29) < 0.16) return FOLIAGE[0];
                    return ashlarFace(7, 'top');
                }
                const along = face === 'sw' ? u : v;
                return shadeRetainingWall(face, along, h, cheekTop, seed + side * 53 + s * 7, true);
            });
        }
    }

    return buf.toPngWithSelectiveOutline();
}

// ------------------------------------------------------------------ 2. Terrace Retaining Wall Corners (32x32)

export function bakeTerraceCornerPng(variant) {
    const { width: W, height: H, wallHeightPx } = TERRACE_KIT_SPEC.corner;
    // R = 8 at origin (16, 20):
    //   x spans [16 - 16 .. 16 + 16]? Max |u - v| = 16 -> wait: u in [-7..7], v in [-7..7] -> |u-v| <= 14!
    //   sx in [2..30] (outline at [1..31], zero clipping on left/right!)
    //   sy bottom = 20 + 7 = 27 (outline at 28), sy top = 20 - 7 - 9 = 4 (outline at 3)!
    const buf = new IsoVoxelBuffer(W, H, 16, 20);
    const R = 7;
    const TOP_H = wallHeightPx;      // 8 px retaining wall height
    const CAP_H = wallHeightPx + 1;  // 9 px coping lip
    const seed = variant === 'outer' ? 101 : 211;

    if (variant === 'outer') {
        // Convex outer retaining wall prow: dressed long-and-short quoins on the prow arris
        buf.paintBox({ u0: -R + 1, u1: R - 1, v0: -R + 1, v1: R - 1, h0: 0, h1: TOP_H }, (face, u, v, h) => {
            if (face === 'top') return null;
            const along = face === 'sw' ? u : v;
            const distFromProw = face === 'sw' ? (R - 1 - u) : (R - 1 - v);
            const quoinCourse = Math.floor(h / 4);
            const quoinLen = (quoinCourse % 2 === 0) ? 4 : 2;
            if (distFromProw < quoinLen) {
                if ((h % 4 === 0 && h > 0) || distFromProw === quoinLen - 1) {
                    return face === 'sw' ? ashlarFace(5, 'joint') : ashlarFace(4, 'joint');
                }
                return face === 'sw' ? ASHLAR[7] : ashlarFace(6, 'shade');
            }
            return shadeRetainingWall(face, along, h, TOP_H, seed, true);
        });

        // Overhanging coping cap framing worn terrace flagstones
        buf.paintBox({ u0: -R, u1: R, v0: -R, v1: R, h0: TOP_H, h1: CAP_H }, (face, u, v, h) => {
            if (face === 'top') {
                const onCoping = (u >= R - 2 || v >= R - 2);
                if (onCoping) {
                    const isCopingSeam = (u === R - 2 && v <= R - 2) || (v === R - 2 && u <= R - 2)
                        || ((u + 16) % 5 === 0 && v > R - 2) || ((v + 16) % 5 === 0 && u > R - 2);
                    if (isCopingSeam) return ashlarFace(6, 'joint');
                    if (u === R || v === R) return ashlarFace(7, 'top');
                    return ASHLAR[8];
                }
                const flagSeam = ((u + 16) % 5 === 0) || ((v + 16) % 5 === 0);
                if (flagSeam) return ashlarFace(6, 'joint');
                if (u === -R + 1 && v === -R + 1) return FOLIAGE[1];
                return hash(u >> 1, v >> 1, seed + 7) < 0.4 ? PLAZA[4] : PLAZA[3];
            }
            if (face === 'sw') return h === CAP_H - 1 ? ASHLAR[7] : ashlarFace(6, 'joint');
            return h === CAP_H - 1 ? ashlarFace(6, 'shade') : ashlarFace(5, 'joint');
        });
    } else {
        // Concave inner L-corner with lower flagstone courtyard pocket & mossy inside crease
        buf.paintBox({ u0: -1, u1: R - 1, v0: -1, v1: R - 1, h0: 0, h1: 1 }, (face, u, v) => {
            if (face !== 'top') return face === 'sw' ? ashlarFace(6, 'sun') : ashlarFace(5, 'shade');
            if (u <= 2 && v <= 2 && hash(u, v, seed + 19) < 0.65) {
                return FOLIAGE[(u + v) & 1];
            }
            if (u === 0 || v === 0) return ashlarFace(5, 'joint'); // base crevice along retaining walls
            const seam = ((u + 8) % 4 === 0) || ((v + 8) % 4 === 0);
            if (seam) return ashlarFace(6, 'joint');
            return hash(u, v, seed + 23) < 0.4 ? PLAZA[4] : PLAZA[3];
        });

        // NW-to-NE arm exposing sunlit SW wall
        buf.paintBox({ u0: -R, u1: R - 1, v0: -R, v1: -1, h0: 0, h1: TOP_H }, (face, u, v, h) => {
            if (face === 'top') return null;
            const along = face === 'sw' ? u : v;
            return shadeRetainingWall(face, along, h, TOP_H, seed + 1, true);
        });

        // NW-to-SW arm exposing shaded SE wall
        buf.paintBox({ u0: -R, u1: -1, v0: -1, v1: R - 1, h0: 0, h1: TOP_H }, (face, u, v, h) => {
            if (face === 'top') return null;
            const along = face === 'sw' ? u : v;
            return shadeRetainingWall(face, along, h, TOP_H, seed + 2, true);
        });

        // L-shaped overhanging coping cap at h = 8..9
        const paintCap = (box) => {
            buf.paintBox(box, (face, u, v) => {
                if (face === 'top') {
                    const isBackRim = (u === -R || v === -R);
                    const isJoint = (((u + 16) % 5 === 0) && v <= 0) || (((v + 16) % 5 === 0) && u <= 0);
                    const isInnerLip = (v === 0 && u >= 0) || (u === 0 && v >= 0);
                    if (isJoint) return ashlarFace(6, 'joint');
                    if (u >= -2 && u <= 0 && v >= -2 && v <= 0 && hash(u, v, seed + 61) < 0.35) {
                        return FOLIAGE[0];
                    }
                    if (isBackRim || isInnerLip) return ASHLAR[8];
                    return ashlarFace(7, 'top');
                }
                return face === 'sw' ? ASHLAR[7] : ashlarFace(6, 'shade');
            });
        };
        paintCap({ u0: -R, u1: R, v0: -R, v1: 0, h0: TOP_H, h1: CAP_H });
        paintCap({ u0: -R, u1: 0, v0: 0, v1: R, h0: TOP_H, h1: CAP_H });
    }

    return buf.toPngWithSelectiveOutline();
}

export function buildAllTerraceKitPngs() {
    const outputs = [];
    for (const dir of TERRACE_KIT_SPEC.stair.directions) {
        outputs.push({
            rel: `prop.terraceStair.${dir}.png`,
            png: bakeTerraceStairPng(dir),
            anchor: TERRACE_KIT_SPEC.stair.anchor,
        });
    }
    for (const variant of TERRACE_KIT_SPEC.corner.variants) {
        outputs.push({
            rel: `prop.terraceCorner.${variant}.png`,
            png: bakeTerraceCornerPng(variant),
            anchor: TERRACE_KIT_SPEC.corner.anchor,
        });
    }
    return outputs;
}

// ------------------------------------------------------------------ CLI

function usage() {
    console.log(`Usage: node scripts/sprites/bake-terrace-kit.mjs [--check | --help]

  (default)   Write the 6 E2 terrace kit PNGs:
                prop.terraceStair.{ne,nw,se,sw}.png  (64x48, anchor [32, 36])
                prop.terraceCorner.{inner,outer}.png (32x32, anchor [16, 24])
  --check     Exit 1 if any on-disk PNG is missing or differs from deterministic baker output
  --help, -h  Show this help message and exit`);
}

function main() {
    const args = process.argv.slice(2);
    if (args.includes('--help') || args.includes('-h')) {
        usage();
        process.exit(0);
    }

    const check = args.includes('--check');
    const outputs = buildAllTerraceKitPngs();
    let mismatches = 0;

    for (const { rel, png, anchor } of outputs) {
        const abs = join(PROPS_DIR, rel);
        const buf = PNG.sync.write(png, { colorType: 6 });
        if (check) {
            if (!existsSync(abs)) {
                console.error(`[bake-terrace-kit] MISSING: ${rel}`);
                mismatches++;
                continue;
            }
            const cur = readFileSync(abs);
            if (Buffer.compare(cur, buf) !== 0) {
                console.error(`[bake-terrace-kit] STALE: ${rel} differs from baker output`);
                mismatches++;
            } else {
                console.log(`[bake-terrace-kit] ok: ${rel} (${png.width}x${png.height}, anchor [${anchor}])`);
            }
        } else {
            mkdirSync(dirname(abs), { recursive: true });
            writeFileSync(abs, buf);
            console.log(`[bake-terrace-kit] wrote ${rel} (${png.width}x${png.height}, anchor [${anchor}])`);
        }
    }

    if (check && mismatches > 0) {
        console.error(`[bake-terrace-kit] FAIL: ${mismatches} PNG(s) stale; run node scripts/sprites/bake-terrace-kit.mjs`);
        process.exit(1);
    }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
    main();
}
