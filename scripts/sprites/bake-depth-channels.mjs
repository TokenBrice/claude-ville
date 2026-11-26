#!/usr/bin/env node
// Wave 5-B — WebGPU `surface-v1` height + oct64 normal & relief-material baker
// (Spec 01 §1: `01-gpu-terrain-contract.md` lines 47-65).
//
// Format contracts:
//   1. Shared versioned 64x3 octahedral normal table (`OCT_64_NORMALS`):
//      Seeded by inverse-octahedral decoding at grid points u,v = 2*q/7 - 1
//      for q = 0..7, id = (v3 << 3) | u3, normalized to unit length.
//      Offline encoding uses nearest dot product with `OCT_64_NORMALS`,
//      strictly selecting the lowest ID on tie.
//   2. WebGPU `surface-v1` RGBA8 raw integer texel:
//        H16 = Math.round(16 * heightPx) in [0, 65535] (overflow throws)
//        R = H16 & 255
//        G = (H16 >> 8) & 255
//        B = normalId & 63  (upper 2 bits strictly zero)
//        A = (valid ? 128 : 0) | (protectInk ? 64 : 0) | ((curvature & 3) << 4) | (ao & 15)
//   3. Sprite relief material G/B channels (flag bit 17 = 131072):
//        G = normalId & 63  (upper 2 bits strictly zero)
//        B = ((slope & 15) << 4) | (ao & 15)  (slope in 6-degree steps 0..90 deg)
//
// CLI usage:
//   node scripts/sprites/bake-depth-channels.mjs --help
//   node scripts/sprites/bake-depth-channels.mjs --check --id=building.forge
//   node scripts/sprites/bake-depth-channels.mjs --id=building.forge --out=/tmp/preview

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const SURFACE_V1_VERSION = 1;
export const OCT_64_TABLE_VERSION = 1;
export const SURFACE_V1_HEIGHT_SCALE = 16;
export const SURFACE_V1_MAX_H16 = 65535;
export const RELIEF_SLOPE_STEP_DEG = 6;

export const CURVATURE_CLASS = Object.freeze({
    flat: 0,
    convex: 1,
    concave: 2,
    crease: 3,
});

// Flag bits from Spec 01 §1 for asset validation.
export const SURFACE_FLAGS = Object.freeze({
    coded: 16,
    packed: 32,
    relief: 131072,
    surfaceV1: 262144,
    reservedMask: (~((1 << 22) - 1)) >>> 0,
});

function signNonZero(value) {
    return value >= 0 ? 1 : -1;
}

function normalize3(x, y, z) {
    const len = Math.hypot(x, y, z);
    if (!(len > 0)) return [0, 0, 1];
    return [x / len, y / len, z / len];
}

// Inverse octahedral projection from grid point (u, v) in [-1, 1]^2 to unit 3D normal.
function inverseOctahedral(u, v) {
    let x = u;
    let y = v;
    const z = 1 - Math.abs(u) - Math.abs(v);
    if (z < 0) {
        const ox = x;
        const oy = y;
        x = (1 - Math.abs(oy)) * signNonZero(ox);
        y = (1 - Math.abs(ox)) * signNonZero(oy);
    }
    return normalize3(x, y, z);
}

function buildOct64Table() {
    const table = [];
    for (let v3 = 0; v3 < 8; v3++) {
        const v = (2 * v3) / 7 - 1;
        for (let u3 = 0; u3 < 8; u3++) {
            const u = (2 * u3) / 7 - 1;
            const [nx, ny, nz] = inverseOctahedral(u, v);
            table.push(Object.freeze([nx, ny, nz]));
        }
    }
    return Object.freeze(table);
}

/**
 * Shared versioned 64x3 unit normal lookup table seeded by the 8x8
 * inverse-octahedral grid `2*q/7 - 1`, `q = 0..7`, `id = (v3 << 3) | u3`.
 */
export const OCT_64_NORMALS = buildOct64Table();

/**
 * Closed-form forward octahedral seed ID (Spec 01 §1):
 * projects unit normal by L1 norm, folds lower hemisphere via signNonZero,
 * quantizes each component with `clamp(round((p+1)*3.5), 0, 7)`.
 */
export function seedOctNormalId(nx, ny, nz) {
    const [x, y, z] = normalize3(Number(nx) || 0, Number(ny) || 0, Number(nz) || 0);
    const l1 = Math.abs(x) + Math.abs(y) + Math.abs(z) || 1;
    let px = x / l1;
    let py = y / l1;
    if (z < 0) {
        const ox = px;
        const oy = py;
        px = (1 - Math.abs(oy)) * signNonZero(ox);
        py = (1 - Math.abs(ox)) * signNonZero(oy);
    }
    const u3 = Math.max(0, Math.min(7, Math.round((px + 1) * 3.5)));
    const v3 = Math.max(0, Math.min(7, Math.round((py + 1) * 3.5)));
    return (v3 << 3) | u3;
}

/**
 * Encode a 3D normal into an `oct64` ID (0..63) by exact nearest dot product
 * against `OCT_64_NORMALS`, strictly breaking ties in favor of the lowest ID.
 */
export function encodeOctNormalId(nx, ny, nz) {
    const [x, y, z] = normalize3(Number(nx) || 0, Number(ny) || 0, Number(nz) || 0);
    let bestId = 0;
    let bestDot = -Infinity;
    // Tie epsilon keeps floating-point dot equality exact in favor of lowest ID.
    const TIE_EPS = 1e-12;
    for (let id = 0; id < OCT_64_NORMALS.length; id++) {
        const n = OCT_64_NORMALS[id];
        const dot = x * n[0] + y * n[1] + z * n[2];
        if (dot > bestDot + TIE_EPS) {
            bestDot = dot;
            bestId = id;
        }
    }
    return bestId;
}

/**
 * Decode an `oct64` ID (0..63) into its unit normal `[nx, ny, nz]`.
 */
export function decodeOctNormal(id) {
    const idx = Number(id);
    if (!Number.isInteger(idx) || idx < 0 || idx > 63) {
        throw new RangeError(`oct64 normal ID must be an integer in [0, 63], got ${id}`);
    }
    const [nx, ny, nz] = OCT_64_NORMALS[idx];
    return [nx, ny, nz];
}

/**
 * Mirror an `oct64` normal ID across the X axis (`flipX = true` negates the
 * decoded normal's X component and re-encodes against `OCT_64_NORMALS`).
 */
export function mirrorOctNormalId(id, flipX = false) {
    const idx = Number(id);
    if (!Number.isInteger(idx) || idx < 0 || idx > 63) {
        throw new RangeError(`oct64 normal ID must be an integer in [0, 63], got ${id}`);
    }
    if (!flipX) return idx;
    const [nx, ny, nz] = OCT_64_NORMALS[idx];
    return encodeOctNormalId(-nx, ny, nz);
}

/**
 * Pack one WebGPU `surface-v1` RGBA8 texel (Spec 01 §1).
 * Throws `RangeError` on `H16` overflow or out-of-range fields.
 */
export function packSurfaceV1Texel({
    heightPx = 0,
    normalId = 0,
    valid = true,
    protectInk = false,
    curvature = 0,
    ao = 0,
} = {}) {
    const numericHeight = Number(heightPx);
    if (!Number.isFinite(numericHeight)) {
        throw new RangeError(`surface-v1 heightPx must be finite, got ${heightPx}`);
    }
    const h16 = Math.round(SURFACE_V1_HEIGHT_SCALE * numericHeight);
    if (h16 < 0 || h16 > SURFACE_V1_MAX_H16) {
        throw new RangeError(`surface-v1 H16 overflow: heightPx=${heightPx} -> H16=${h16} outside [0, ${SURFACE_V1_MAX_H16}]`);
    }
    if (!Number.isInteger(normalId) || normalId < 0 || normalId > 63) {
        throw new RangeError(`surface-v1 normalId must be an integer in [0, 63], got ${normalId}`);
    }
    if (!Number.isInteger(curvature) || curvature < 0 || curvature > 3) {
        throw new RangeError(`surface-v1 curvature must be an integer in [0, 3], got ${curvature}`);
    }
    if (!Number.isInteger(ao) || ao < 0 || ao > 15) {
        throw new RangeError(`surface-v1 ao must be an integer in [0, 15], got ${ao}`);
    }

    const r = h16 & 255;
    const g = (h16 >> 8) & 255;
    const b = normalId & 63;
    const a = (valid ? 128 : 0) | (protectInk ? 64 : 0) | ((curvature & 3) << 4) | (ao & 15);
    return { r, g, b, a };
}

/**
 * Unpack one WebGPU `surface-v1` RGBA8 texel.
 */
export function unpackSurfaceV1Texel(r, g, b, a) {
    let rb = r;
    let gb = g;
    let bb = b;
    let ab = a;
    if (r && typeof r === 'object') {
        if (Array.isArray(r) || ArrayBuffer.isView(r)) {
            [rb, gb, bb, ab] = r;
        } else {
            ({ r: rb, g: gb, b: bb, a: ab } = r);
        }
    }
    const h16 = (rb & 255) | ((gb & 255) << 8);
    return {
        h16,
        heightPx: h16 / SURFACE_V1_HEIGHT_SCALE,
        normalId: bb & 63,
        reservedNormalBits: (bb >> 6) & 3,
        valid: Boolean(ab & 128),
        protectInk: Boolean(ab & 64),
        curvature: (ab >> 4) & 3,
        ao: ab & 15,
    };
}

/**
 * Pack sprite relief material G and B bytes (Spec 01 §1, flag 131072):
 *   G low 6 = oct64 normal ID (high 2 strictly zero)
 *   B low 4 = AO occlusion (0 unoccluded .. 15 darkest)
 *   B high 4 = slope (0..15, 6-degree steps from horizontal)
 */
export function packReliefMaterialGB({ normalId = 0, ao = 0, slope = 0 } = {}) {
    if (!Number.isInteger(normalId) || normalId < 0 || normalId > 63) {
        throw new RangeError(`relief normalId must be an integer in [0, 63], got ${normalId}`);
    }
    if (!Number.isInteger(ao) || ao < 0 || ao > 15) {
        throw new RangeError(`relief ao must be an integer in [0, 15], got ${ao}`);
    }
    if (!Number.isInteger(slope) || slope < 0 || slope > 15) {
        throw new RangeError(`relief slope must be an integer in [0, 15], got ${slope}`);
    }
    return {
        g: normalId & 63,
        b: ((slope & 15) << 4) | (ao & 15),
    };
}

/**
 * Unpack sprite relief material G and B bytes.
 */
export function unpackReliefMaterialGB(g, b) {
    const gb = g & 255;
    const bb = b & 255;
    const slope = (bb >> 4) & 15;
    return {
        normalId: gb & 63,
        reservedG: (gb >> 6) & 3,
        ao: bb & 15,
        slope,
        slopeDeg: slope * RELIEF_SLOPE_STEP_DEG,
    };
}

/**
 * Validate forbidden flag combinations from Spec 01 §1:
 * reject relief+32, coded+32, terrain+relief, or reserved bits 22..31 set.
 */
export function validateMaterialFlags(flags, { isTerrain = false } = {}) {
    const f = Number(flags) >>> 0;
    const errors = [];
    const hasCoded = Boolean(f & SURFACE_FLAGS.coded);
    const hasPacked = Boolean(f & SURFACE_FLAGS.packed);
    const hasRelief = Boolean(f & SURFACE_FLAGS.relief);
    if (hasRelief && hasPacked) errors.push('forbidden flag combination: relief + packed (32)');
    if (hasCoded && hasPacked) errors.push('forbidden flag combination: coded (16) + packed (32)');
    if (isTerrain && hasRelief) errors.push('forbidden flag combination: terrain + relief');
    if (f & SURFACE_FLAGS.reservedMask) errors.push('reserved flag bits 22..31 must be zero');
    return { ok: errors.length === 0, errors };
}

/**
 * AO monotonicity check helper: verifies that AO values increase monotonically
 * (0 unoccluded -> 15 darkest) either along a sequence of ordered samples or
 * across `{ open: [x, y], crevice: [x, y] }` probe pairs in a `surface-v1` RGBA buffer.
 */
export function checkAoMonotonicity(input) {
    const violations = [];
    if (Array.isArray(input)) {
        for (let i = 1; i < input.length; i++) {
            const prev = typeof input[i - 1] === 'object' ? Number(input[i - 1]?.ao) : Number(input[i - 1]);
            const curr = typeof input[i] === 'object' ? Number(input[i]?.ao) : Number(input[i]);
            if (!(curr >= prev)) {
                violations.push({ index: i, prev, curr });
            }
        }
        return { ok: violations.length === 0, violations };
    }
    if (input && typeof input === 'object' && input.rgba && Array.isArray(input.pairs)) {
        const { rgba, width, height, pairs } = input;
        const aoAt = (x, y) => {
            if (x < 0 || y < 0 || x >= width || y >= height) return NaN;
            return rgba[(y * width + x) * 4 + 3] & 15;
        };
        for (let i = 0; i < pairs.length; i++) {
            const pair = pairs[i];
            const openAo = aoAt(pair.open[0], pair.open[1]);
            const creviceAo = aoAt(pair.crevice[0], pair.crevice[1]);
            if (!(creviceAo >= openAo)) {
                violations.push({ index: i, open: pair.open, crevice: pair.crevice, openAo, creviceAo });
            }
        }
        return { ok: violations.length === 0, violations };
    }
    throw new TypeError('checkAoMonotonicity expects an array of AO samples or { rgba, width, height, pairs }');
}

/**
 * Validate a `surface-v1` RGBA8 buffer against its paired albedo RGBA8 buffer:
 *   - Outside alpha (`albedo.A === 0`): `H16 === 0 && A === 0` (and `B === 0`).
 *   - Everywhere: `B <= 63` (upper 2 bits strictly zero).
 *   - Covered texels (`albedo.A > 0`): valid bit (`A & 128`) set.
 */
export function validateSurfaceV1Buffer(rgba, albedoRgba, width, height) {
    const w = Math.trunc(Number(width));
    const h = Math.trunc(Number(height));
    const expectedBytes = w * h * 4;
    const errors = [];
    if (!rgba || rgba.length !== expectedBytes) {
        errors.push(`surface buffer length ${rgba?.length ?? 0} !== expected ${expectedBytes}`);
    }
    if (!albedoRgba || albedoRgba.length !== expectedBytes) {
        errors.push(`albedo buffer length ${albedoRgba?.length ?? 0} !== expected ${expectedBytes}`);
    }
    if (errors.length) {
        return { ok: false, errors, stats: null };
    }

    let opaquePixels = 0;
    let transparentPixels = 0;
    let maxH16 = 0;
    let minAo = 15;
    let maxAo = 0;
    let inkProtectedPixels = 0;
    const MAX_ERRORS = 32;

    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const o = (y * w + x) * 4;
            const r = rgba[o];
            const g = rgba[o + 1];
            const b = rgba[o + 2];
            const a = rgba[o + 3];
            const h16 = r | (g << 8);
            const alpha = albedoRgba[o + 3];

            if (b > 63 && errors.length < MAX_ERRORS) {
                errors.push(`(${x},${y}): B=${b} has reserved upper bits set (>63)`);
            }

            if (alpha === 0) {
                transparentPixels++;
                if ((h16 !== 0 || a !== 0 || b !== 0) && errors.length < MAX_ERRORS) {
                    errors.push(`(${x},${y}): non-zero surface outside albedo alpha (H16=${h16}, B=${b}, A=${a})`);
                }
            } else {
                opaquePixels++;
                if ((a & 128) === 0 && errors.length < MAX_ERRORS) {
                    errors.push(`(${x},${y}): opaque texel missing valid bit (A=${a})`);
                }
                if (h16 > maxH16) maxH16 = h16;
                const ao = a & 15;
                if (ao < minAo) minAo = ao;
                if (ao > maxAo) maxAo = ao;
                if (a & 64) inkProtectedPixels++;
            }
        }
    }

    return {
        ok: errors.length === 0,
        errors,
        stats: {
            width: w,
            height: h,
            totalPixels: w * h,
            opaquePixels,
            transparentPixels,
            maxH16,
            maxHeightPx: maxH16 / SURFACE_V1_HEIGHT_SCALE,
            minAo: opaquePixels ? minAo : 0,
            maxAo: opaquePixels ? maxAo : 0,
            inkProtectedPixels,
        },
    };
}

// ─── Deterministic Building `surface-v1` + Relief Material Baker ─────────────

const INK_LUMA_THRESHOLD = 0.13; // Matches `bake-surface-channel.mjs` INK_VALUE

// Nominal face unit normals in isometric world coordinates (+X right, +Y south, +Z up).
const FACE_BASE_NORMALS = Object.freeze([
    Object.freeze([0, 0, 1]),                   // 0: up / deck / apron
    Object.freeze([-0.70710678, 0.70710678, 0]), // 1: SW wall (left face)
    Object.freeze([0.70710678, 0.70710678, 0]),  // 2: SE wall (right face)
    Object.freeze([0, 0.4472136, 0.89442719]),   // 3: pitched roof
]);

/**
 * Deterministically bake `surface-v1` RGBA8 + relief-material RGBA8 buffers
 * from existing building `base.png` (`albedo`), `base.occluder.png` (`occluder`),
 * and optional `base.material.png` (`material`).
 */
export function bakeBuildingSurfaceV1({ albedo, occluder, material = null }) {
    const width = albedo.width;
    const height = albedo.height;
    const albedoData = albedo.data;
    const occData = occluder.data;
    const matData = material?.data || null;
    const total = width * height;

    const heights = new Float32Array(total);
    const faces = new Int8Array(total).fill(-1);
    const inkMask = new Uint8Array(total);

    for (let p = 0; p < total; p++) {
        const o = p * 4;
        if (albedoData[o + 3] === 0) continue;
        heights[p] = occData[o]; // True height in sprite px (0..255)
        faces[p] = (occData[o + 2] >> 6) & 3;
        const maxCh = Math.max(albedoData[o], albedoData[o + 1], albedoData[o + 2]) / 255;
        inkMask[p] = maxCh < INK_LUMA_THRESHOLD ? 1 : 0;
    }

    const surfaceData = new Uint8ClampedArray(total * 4);
    const reliefMaterialData = new Uint8ClampedArray(total * 4);

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const p = y * width + x;
            const o = p * 4;
            const alpha = albedoData[o + 3];
            if (alpha === 0) continue;

            const face = faces[p];
            const hC = heights[p];
            const protectInk = inkMask[p] === 1;

            // Local 4-neighbor gradient & Laplacian within opaque coverage.
            const sampleH = (nx, ny) => {
                if (nx < 0 || ny < 0 || nx >= width || ny >= height) return hC;
                const q = ny * width + nx;
                return faces[q] >= 0 ? heights[q] : hC;
            };
            const sampleFace = (nx, ny) => {
                if (nx < 0 || ny < 0 || nx >= width || ny >= height) return face;
                const q = ny * width + nx;
                return faces[q] >= 0 ? faces[q] : face;
            };

            const hL = sampleH(x - 1, y);
            const hR = sampleH(x + 1, y);
            const hU = sampleH(x, y - 1);
            const hD = sampleH(x, y + 1);
            const dhdx = (hR - hL) * 0.5;
            const dhdy = (hD - hU) * 0.5;
            const lap = (hL + hR + hU + hD) * 0.25 - hC;

            const seamNeighbor = (
                sampleFace(x - 1, y) !== face ||
                sampleFace(x + 1, y) !== face ||
                sampleFace(x, y - 1) !== face ||
                sampleFace(x, y + 1) !== face
            );

            // Surface normal derived from authored face class + bounded roof/deck slope.
            const baseN = FACE_BASE_NORMALS[face] || FACE_BASE_NORMALS[0];
            let nx = baseN[0];
            let ny = baseN[1];
            let nz = baseN[2];
            if (face === 3) {
                const gx = Math.max(-1.5, Math.min(1.5, dhdx * 0.25));
                const gy = Math.max(-1.5, Math.min(1.5, dhdy * 0.25));
                [nx, ny, nz] = normalize3(-gx, 0.45 - gy * 0.35, 0.9);
            } else if (face === 0) {
                const gx = Math.max(-0.5, Math.min(0.5, dhdx * 0.2));
                const gy = Math.max(-0.5, Math.min(0.5, dhdy * 0.2));
                [nx, ny, nz] = normalize3(-gx, -gy, 1);
            }
            const normalId = encodeOctNormalId(nx, ny, nz);

            // Curvature class: 0 flat, 1 convex, 2 concave, 3 crease.
            let curvature = CURVATURE_CLASS.flat;
            if (seamNeighbor && (lap > 1.5 || protectInk)) curvature = CURVATURE_CLASS.crease;
            else if (lap > 1.5) curvature = CURVATURE_CLASS.concave;
            else if (lap < -1.5) curvature = CURVATURE_CLASS.convex;

            // Deterministic local horizon AO (0 unoccluded .. 15 darkest).
            let occluders = 0;
            let samples = 0;
            for (let dy = -2; dy <= 2; dy++) {
                for (let dx = -2; dx <= 2; dx++) {
                    if (dx === 0 && dy === 0) continue;
                    const qx = x + dx;
                    const qy = y + dy;
                    if (qx < 0 || qy < 0 || qx >= width || qy >= height) continue;
                    const q = qy * width + qx;
                    if (faces[q] < 0) continue;
                    samples++;
                    const delta = heights[q] - hC;
                    if (delta > 1.5) occluders += Math.min(1, delta / 12);
                }
            }
            let aoNorm = samples > 0 ? occluders / samples : 0;
            if (seamNeighbor) aoNorm += 0.2;
            if (hC <= 4) aoNorm += 0.18;
            if (protectInk) aoNorm += 0.12;
            const ao = Math.max(0, Math.min(15, Math.round(Math.min(1, aoNorm) * 15)));

            const packed = packSurfaceV1Texel({
                heightPx: hC,
                normalId,
                valid: true,
                protectInk,
                curvature,
                ao,
            });
            surfaceData[o] = packed.r;
            surfaceData[o + 1] = packed.g;
            surfaceData[o + 2] = packed.b;
            surfaceData[o + 3] = packed.a;

            // Relief material G/B channels (preserving material class R and alpha A).
            const decodedN = OCT_64_NORMALS[normalId];
            const slopeDeg = Math.acos(Math.max(0, Math.min(1, Math.abs(decodedN[2])))) * (180 / Math.PI);
            const slopeStep = Math.max(0, Math.min(15, Math.round(slopeDeg / RELIEF_SLOPE_STEP_DEG)));
            const reliefGB = packReliefMaterialGB({ normalId, ao, slope: slopeStep });
            reliefMaterialData[o] = matData ? matData[o] : 0;
            reliefMaterialData[o + 1] = reliefGB.g;
            reliefMaterialData[o + 2] = reliefGB.b;
            reliefMaterialData[o + 3] = alpha;
        }
    }

    const validation = validateSurfaceV1Buffer(surfaceData, albedoData, width, height);
    return {
        width,
        height,
        surfaceData,
        reliefMaterialData,
        validation,
    };
}

// ─── CLI Driver ──────────────────────────────────────────────────────────────

function printHelp() {
    console.log([
        'Usage: node scripts/sprites/bake-depth-channels.mjs [options]',
        '',
        'Bakes WebGPU surface-v1 RGBA8 (16-bit height + oct64 normal + curvature/AO)',
        'from a building\'s base.png, base.occluder.png, and base.material.png.',
        '',
        'Options:',
        '  --help, -h           Show this help message',
        '  --id=<buildingId>    Building ID (e.g. building.forge or forge); default all',
        '  --check              Bake in memory, validate surface-v1 contract, and compare',
        '                       against any existing base.surface.png on disk (no writes)',
        '  --out=<dir>          Write baked PNGs to <dir> instead of assets/sprites',
    ].join('\n'));
}

async function runCli(argv = process.argv.slice(2)) {
    if (argv.includes('--help') || argv.includes('-h')) {
        printHelp();
        return 0;
    }

    const checkOnly = argv.includes('--check');
    const idArg = argv.find((arg) => arg.startsWith('--id='));
    const requestedId = idArg ? idArg.slice('--id='.length).trim() : null;
    const outArg = argv.find((arg) => arg.startsWith('--out='));
    const outDir = outArg ? outArg.slice('--out='.length).trim() : null;

    const { PNG } = await import('pngjs');
    const { collectSpriteEntries, loadSpriteManifest, spritesRoot } = await import('./manifest-utils.mjs');

    const manifest = loadSpriteManifest();
    const buildings = collectSpriteEntries(manifest, ['buildings']);
    const normalizedFilter = requestedId
        ? (requestedId.startsWith('building.') ? requestedId : `building.${requestedId}`)
        : null;
    const targets = normalizedFilter
        ? buildings.filter((entry) => entry.id === normalizedFilter)
        : buildings;

    if (!targets.length) {
        console.error(`[depth] no building matched --id=${requestedId}`);
        return 1;
    }

    let failures = 0;
    for (const entry of targets) {
        const dir = join(spritesRoot, 'buildings', entry.id);
        const albedoPath = join(dir, 'base.png');
        const occPath = join(dir, 'base.occluder.png');
        const matPath = join(dir, 'base.material.png');
        if (!existsSync(albedoPath) || !existsSync(occPath)) {
            console.error(`[depth] MISSING inputs for ${entry.id}`);
            failures++;
            continue;
        }
        const albedo = PNG.sync.read(readFileSync(albedoPath));
        const occluder = PNG.sync.read(readFileSync(occPath));
        const material = existsSync(matPath) ? PNG.sync.read(readFileSync(matPath)) : null;

        const baked = bakeBuildingSurfaceV1({ albedo, occluder, material });
        if (!baked.validation.ok) {
            console.error(`[depth] INVALID ${entry.id}: ${baked.validation.errors.join('; ')}`);
            failures++;
            continue;
        }

        const outPng = new PNG({ width: baked.width, height: baked.height, colorType: 6 });
        outPng.data = Buffer.from(baked.surfaceData);
        const bytes = PNG.sync.write(outPng, { colorType: 6 });

        const diskSurfacePath = join(dir, 'base.surface.png');
        if (checkOnly) {
            if (existsSync(diskSurfacePath)) {
                const previous = PNG.sync.read(readFileSync(diskSurfacePath));
                if (Buffer.compare(previous.data, outPng.data) !== 0) {
                    console.error(`[depth] STALE ${entry.id}: base.surface.png differs from deterministic bake`);
                    failures++;
                    continue;
                }
                console.log(`[depth] OK ${entry.id}: matches on-disk base.surface.png (${baked.width}x${baked.height}, opaque=${baked.validation.stats.opaquePixels})`);
            } else {
                console.log(`[depth] OK ${entry.id}: validated in memory (${baked.width}x${baked.height}, opaque=${baked.validation.stats.opaquePixels}, maxH=${baked.validation.stats.maxHeightPx}px, on-disk=absent)`);
            }
            continue;
        }

        const targetPath = outDir ? join(outDir, `${entry.id}.surface.png`) : diskSurfacePath;
        if (outDir) mkdirSync(outDir, { recursive: true });
        writeFileSync(targetPath, bytes);
        console.log(`[depth] WROTE ${targetPath} (${bytes.length} bytes)`);
    }

    return failures ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
    runCli().then((code) => process.exit(code));
}
