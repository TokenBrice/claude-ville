// Wave 6-A (E2) — Multi-surface isometric elevation, ray-plane picking,
// surface registry validation, sculpted site table, and E2 pilot terrain.
//
// Implements specs/01-gpu-terrain-contract.md §4 & §5:
//   - Projection:  x = 32 * (u - v),  y = 16 * (u + v) - h
//   - Near-order:  d = 32 * (u + v) + h / 2
//   - Tile index:  40 * ty + tx  in [0, 1599]
//   - Local tile:  (a, b) = (u - tx + 0.5, v - ty + 0.5)  in [0, 1)
//   - Plane H:     (plane16[0] + plane16[1] * a + plane16[2] * b) / 16
//   - Exact ray-plane intersection with projected triangle/edge top-left fill
//     fallback when denom === 0 (parallel/coplanar case, zero division-by-zero).
//   - Strict D5 enforcement: 9 semantic landmarks + Belfry + Windmill ONLY;
//     zero decorative cottages, sheds, or dwellings permitted anywhere.
//
// Pure vanilla ES module: imports cleanly in both browser and Node.

import { TILE_WIDTH, TILE_HEIGHT, MAP_SIZE } from '../../config/constants.js';
import { ART_RAMPS } from '../../config/artPalette.js';

export { TILE_WIDTH, TILE_HEIGHT, MAP_SIZE };

export const TILE_HALF_WIDTH = TILE_WIDTH / 2;   // 32
export const TILE_HALF_HEIGHT = TILE_HEIGHT / 2; // 16
export const MAX_TILE_INDEX = MAP_SIZE * MAP_SIZE - 1; // 1599

export const HEIGHT_SCALE = 16;
export const POLY_SCALE = 256;
export const FLAT_GROUND_ID = 0;
export const DEFAULT_WATER_ID = 1;
export const MAX_SURFACE_ID = 65535;
export const MIN_HEIGHT16 = -32768;
export const MAX_HEIGHT16 = 32767;

export const DEPTH_MIN = -2048;
export const DEPTH_MAX = 6144;
export const DEPTH_SPAN = 8192;

export const FULL_TILE_POLY = Object.freeze([
    Object.freeze([0, 0]),
    Object.freeze([256, 0]),
    Object.freeze([256, 256]),
    Object.freeze([0, 256]),
]);

// Triangle Strategy face-value ladder (specs/01 §4):
// top k, sun k-1, shade k-2, joint k-3 with clamped ramp indices.
export const FACE_VALUE_DELTAS = Object.freeze({
    top: 0,
    sun: -1,
    shade: -2,
    joint: -3,
});

// Strict D5 semantic landmark allowlist: 9 semantic buildings (+ lighthouse alias)
// plus Belfry and Windmill. Zero cottages, sheds, or decorative dwellings.
export const ALLOWED_SEMANTIC_LANDMARKS = Object.freeze(new Set([
    'command',
    'taskboard',
    'forge',
    'mine',
    'archive',
    'tavern',
    'portal',
    'watchtower',
    'lighthouse',
    'harbor',
    'belfry',
    'hourglassBelfry',
    'windmill',
]));

const FORBIDDEN_D5_PATTERN = /(cottage|shed|hut|cabin|shack|house|dwelling|hamlet|villa|barn)/i;
const REGISTERED_MATERIALS = Object.freeze(new Set(Object.keys(ART_RAMPS)));
const SURFACE_KINDS = Object.freeze(new Set(['floor', 'water', 'stair']));
const EDGE_EPS = 1e-9;

// ------------------------------------------------------------------ E2 sculpted sites

export const E2_SCULPTED_SITES = Object.freeze({
    commandKeepRise: Object.freeze({
        id: 'commandKeepRise',
        name: 'Command Keep Rise',
        landmark: 'command',
        elevationPx: 8,
        elevation16: 128,
        walkable: true,
        stairFlights: 1,
        bounds: Object.freeze({ x0: 12, y0: 13, x1: 18, y1: 18 }),
    }),
    windmillKnoll: Object.freeze({
        id: 'windmillKnoll',
        name: 'Windmill Knoll',
        landmark: 'windmill',
        elevationPx: 8,
        elevation16: 128,
        walkable: true,
        stairFlights: 1,
        bounds: Object.freeze({ x0: 8, y0: 0, x1: 11, y1: 3 }),
    }),
    lighthouseHeadland: Object.freeze({
        id: 'lighthouseHeadland',
        name: 'Lighthouse Headland',
        landmark: 'watchtower',
        elevationPx: 8,
        elevation16: 128,
        walkable: true,
        stairFlights: 1,
        bounds: Object.freeze({ x0: 26, y0: 7, x1: 30, y1: 13 }),
    }),
    archiveTerrace: Object.freeze({
        id: 'archiveTerrace',
        name: 'Archive Terrace',
        landmark: 'archive',
        elevationPx: 16,
        elevation16: 256,
        walkable: true,
        stairFlights: 2,
        bounds: Object.freeze({ x0: 2, y0: 14, x1: 8, y1: 19 }),
    }),
    westSeaCliffs: Object.freeze({
        id: 'westSeaCliffs',
        name: 'West Sea Cliffs',
        landmark: null,
        elevationPx: 24,
        elevation16: 384,
        walkable: false,
        stairFlights: 0,
        bounds: Object.freeze({ x0: 0, y0: 12, x1: 1, y1: 27 }),
    }),
});

// ------------------------------------------------------------------ projection & coordinates

/**
 * Project tile-center coordinates (u, v) at elevation h (art px) to pre-camera
 * screen art (x, y) and near-order depth d.
 *
 * Exact specs/01 §4 contract:
 *   x = 32 * (u - v)
 *   y = 16 * (u + v) - h
 *   d = 32 * (u + v) + h / 2
 */
export function projectSurface(u, v, h = 0) {
    return {
        x: TILE_HALF_WIDTH * (u - v),
        y: TILE_HALF_HEIGHT * (u + v) - h,
        d: TILE_HALF_WIDTH * (u + v) + h / 2,
    };
}

/** Convert near-order D into WebGPU Depth32Float normalized depth (clear=1, compare=less). */
export function depthToNormalized(d) {
    return (DEPTH_MAX - d) / DEPTH_SPAN;
}

/** Linear tile index in [0, 1599] for integer tile (tx, ty) in [0, 39]. */
export function tileIndex(tx, ty) {
    if (!Number.isInteger(tx) || !Number.isInteger(ty) || tx < 0 || ty < 0 || tx >= MAP_SIZE || ty >= MAP_SIZE) {
        throw new RangeError(`Tile coordinates out of range: (${tx}, ${ty})`);
    }
    return MAP_SIZE * ty + tx;
}

/** Inverse of tileIndex(tx, ty). */
export function tileCoords(index) {
    if (!Number.isInteger(index) || index < 0 || index > MAX_TILE_INDEX) {
        throw new RangeError(`Tile index out of range: ${index}`);
    }
    const tx = index % MAP_SIZE;
    const ty = (index - tx) / MAP_SIZE;
    return { tx, ty };
}

/** Canonical tile integer address and local (a, b) in [0, 1) for continuous (u, v). */
export function canonicalTile(u, v) {
    const tx = Math.floor(u + 0.5);
    const ty = Math.floor(v + 0.5);
    return {
        tx,
        ty,
        tile: (tx >= 0 && ty >= 0 && tx < MAP_SIZE && ty < MAP_SIZE) ? MAP_SIZE * ty + tx : -1,
        a: u - tx + 0.5,
        b: v - ty + 0.5,
    };
}

/** Local (a, b) coordinates relative to tile (tx, ty). */
export function localTileCoords(u, v, tx, ty) {
    return {
        a: u - tx + 0.5,
        b: v - ty + 0.5,
    };
}

/** Inverse of projectSurface at fixed elevation h (art px): screen art (sx, sy) -> (u, v). */
export function screenRayToTile(sx, sy, h = 0) {
    const X = sx;
    const Y = 2 * (sy + h);
    return {
        u: (X + Y) / TILE_WIDTH,
        v: (Y - X) / TILE_WIDTH,
    };
}

/** Exact per-surface plane elevation in art px at local (a, b) in [0, 1). */
export function planeHeight(plane16, a = 0.5, b = 0.5) {
    return (plane16[0] + plane16[1] * a + plane16[2] * b) / HEIGHT_SCALE;
}

/** Exact per-surface plane elevation in 1/16 art px at local (a, b). */
export function planeHeight16(plane16, a = 0.5, b = 0.5) {
    return plane16[0] + plane16[1] * a + plane16[2] * b;
}

/** Exact integer numerator (256 * h16) at 1/256-tile polygon vertex (pa, pb) for lossless edge comparisons. */
function vertexHeight16x256(plane16, pa, pb) {
    return plane16[0] * POLY_SCALE + plane16[1] * pa + plane16[2] * pb;
}

/** Clamped Triangle Strategy face-value ramp stop index (`top k`, `sun k-1`, `shade k-2`, `joint k-3`). */
export function faceStopIndex(baseStop, face, rampLength) {
    const delta = FACE_VALUE_DELTAS[face] ?? 0;
    return Math.max(0, Math.min(rampLength - 1, baseStop + delta));
}

// ------------------------------------------------------------------ polygon & top-left fill geometry

/** Signed double area of a 2D polygon `[[x0,y0], ...]`. Positive for CCW in (a, b). */
export function polygonSignedArea2(poly) {
    if (!Array.isArray(poly) || poly.length < 3) return 0;
    let sum = 0;
    for (let i = 0; i < poly.length; i++) {
        const p = poly[i];
        const q = poly[(i + 1) % poly.length];
        sum += p[0] * q[1] - q[0] * p[1];
    }
    return sum;
}

function cross2(ax, ay, bx, by, cx, cy) {
    return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
}

function pointInTriangleClosed(px, py, ax, ay, bx, by, cx, cy) {
    const c1 = cross2(ax, ay, bx, by, px, py);
    const c2 = cross2(bx, by, cx, cy, px, py);
    const c3 = cross2(cx, cy, ax, ay, px, py);
    return c1 >= 0 && c2 >= 0 && c3 >= 0;
}

function segmentsProperlyIntersect(a, b, c, d) {
    const o1 = cross2(a[0], a[1], b[0], b[1], c[0], c[1]);
    const o2 = cross2(a[0], a[1], b[0], b[1], d[0], d[1]);
    const o3 = cross2(c[0], c[1], d[0], d[1], a[0], a[1]);
    const o4 = cross2(c[0], c[1], d[0], d[1], b[0], b[1]);
    return ((o1 > 0 && o2 < 0) || (o1 < 0 && o2 > 0))
        && ((o3 > 0 && o4 < 0) || (o3 < 0 && o4 > 0));
}

function hasSelfIntersection(poly) {
    const n = poly.length;
    if (n < 4) return false;
    for (let i = 0; i < n; i++) {
        const a = poly[i];
        const b = poly[(i + 1) % n];
        for (let j = i + 2; j < n; j++) {
            if (i === 0 && j === n - 1) continue;
            const c = poly[j];
            const d = poly[(j + 1) % n];
            if (segmentsProperlyIntersect(a, b, c, d)) return true;
        }
    }
    return false;
}

/**
 * Ear-clipping triangulation of a simple CCW polygon.
 * Returns an array of index triples `[i0, i1, i2]`.
 */
export function triangulatePolygon(poly) {
    if (!Array.isArray(poly) || poly.length < 3) return [];
    if (poly.length === 3) return [[0, 1, 2]];
    const idx = poly.map((_, i) => i);
    const tris = [];
    let guard = poly.length * poly.length + 8;

    while (idx.length > 3 && guard-- > 0) {
        let clipped = false;
        for (let k = 0; k < idx.length; k++) {
            const prev = idx[(k - 1 + idx.length) % idx.length];
            const curr = idx[k];
            const next = idx[(k + 1) % idx.length];
            const a = poly[prev];
            const b = poly[curr];
            const c = poly[next];
            if (cross2(a[0], a[1], b[0], b[1], c[0], c[1]) <= 0) continue;

            let containsOther = false;
            for (let m = 0; m < idx.length; m++) {
                const candidate = idx[m];
                if (candidate === prev || candidate === curr || candidate === next) continue;
                const p = poly[candidate];
                if (pointInTriangleClosed(p[0], p[1], a[0], a[1], b[0], b[1], c[0], c[1])) {
                    containsOther = true;
                    break;
                }
            }
            if (containsOther) continue;

            tris.push([prev, curr, next]);
            idx.splice(k, 1);
            clipped = true;
            break;
        }
        if (!clipped) break;
    }

    if (idx.length === 3) {
        tris.push([idx[0], idx[1], idx[2]]);
    }
    return tris;
}

/**
 * Top-left edge predicate for a directed edge P -> Q on a triangle oriented with
 * positive cross product in y-down coordinates (top edge runs left-to-right,
 * left edge runs upward).
 */
function isTopLeftEdge(px, py, qx, qy) {
    return (qy === py && qx > px) || qy < py;
}

/**
 * Test point (sx, sy) against projected 3D triangles using the exact top-left
 * fill rule. Degenerate zero-area projected triangles cannot own a pixel and
 * are safely skipped without division by zero.
 *
 * Each triangle is `[v0, v1, v2]` where each vertex has `{ x, y, d, h, a?, b?, u?, v? }`.
 * Returns the topmost (greatest near-order `d`, tie-broken by higher `h`) hit,
 * or `null`.
 */
export function pickProjectedTriangles(sx, sy, triangles) {
    let best = null;
    for (let i = 0; i < triangles.length; i++) {
        let [v0, v1, v2] = triangles[i];
        let area2 = cross2(v0.x, v0.y, v1.x, v1.y, v2.x, v2.y);
        if (Math.abs(area2) <= EDGE_EPS) {
            // Degenerate zero-area face cannot own a pixel (specs/01 §4).
            continue;
        }
        if (area2 < 0) {
            const tmp = v1;
            v1 = v2;
            v2 = tmp;
            area2 = -area2;
        }

        const e0 = cross2(v1.x, v1.y, v2.x, v2.y, sx, sy);
        const e1 = cross2(v2.x, v2.y, v0.x, v0.y, sx, sy);
        const e2 = cross2(v0.x, v0.y, v1.x, v1.y, sx, sy);

        const in0 = e0 > 0 || (e0 === 0 && isTopLeftEdge(v1.x, v1.y, v2.x, v2.y));
        const in1 = e1 > 0 || (e1 === 0 && isTopLeftEdge(v2.x, v2.y, v0.x, v0.y));
        const in2 = e2 > 0 || (e2 === 0 && isTopLeftEdge(v0.x, v0.y, v1.x, v1.y));
        if (!in0 || !in1 || !in2) continue;

        const w0 = e0 / area2;
        const w1 = e1 / area2;
        const w2 = e2 / area2;

        const h = w0 * v0.h + w1 * v1.h + w2 * v2.h;
        const d = w0 * v0.d + w1 * v1.d + w2 * v2.d;
        const a = (v0.a !== undefined) ? (w0 * v0.a + w1 * v1.a + w2 * v2.a) : undefined;
        const b = (v0.b !== undefined) ? (w0 * v0.b + w1 * v1.b + w2 * v2.b) : undefined;
        const u = (v0.u !== undefined) ? (w0 * v0.u + w1 * v1.u + w2 * v2.u) : undefined;
        const v = (v0.v !== undefined) ? (w0 * v0.v + w1 * v1.v + w2 * v2.v) : undefined;

        if (!best || d > best.d || (d === best.d && h > best.h)) {
            best = { h, d, a, b, u, v, x: sx, y: sy, parallel: true };
        }
    }
    return best;
}

/**
 * Project a surface's local polygon vertices through `projectSurface` and test
 * `(sx, sy)` with `pickProjectedTriangles` under the top-left fill rule.
 */
export function pickProjectedPolygon(sx, sy, tx, ty, plane16, poly = FULL_TILE_POLY) {
    const triIndices = triangulatePolygon(poly);
    if (!triIndices.length) return null;
    const verts = poly.map(([pa, pb]) => {
        const a = pa / POLY_SCALE;
        const b = pb / POLY_SCALE;
        const u = tx - 0.5 + a;
        const v = ty - 0.5 + b;
        const h = planeHeight(plane16, a, b);
        const proj = projectSurface(u, v, h);
        return { x: proj.x, y: proj.y, d: proj.d, h, a, b, u, v };
    });
    const tris = triIndices.map(([i0, i1, i2]) => [verts[i0], verts[i1], verts[i2]]);
    return pickProjectedTriangles(sx, sy, tris);
}

/**
 * Test local polygon point (pa, pb) in [0, 256) against a CCW polygon using
 * the exact top-left fill rule. On FULL_TILE_POLY this is identical to
 * `pa >= 0 && pa < 256 && pb >= 0 && pb < 256`.
 */
export function pointInPolygonTopLeft(pa, pb, poly) {
    if (isFullTilePoly(poly)) {
        return pa >= 0 && pa < POLY_SCALE && pb >= 0 && pb < POLY_SCALE;
    }
    const tris = triangulatePolygon(poly);
    for (let i = 0; i < tris.length; i++) {
        const [i0, i1, i2] = tris[i];
        const v0 = poly[i0];
        const v1 = poly[i1];
        const v2 = poly[i2];
        const area2 = cross2(v0[0], v0[1], v1[0], v1[1], v2[0], v2[1]);
        if (area2 <= EDGE_EPS) continue;
        const e0 = cross2(v1[0], v1[1], v2[0], v2[1], pa, pb);
        const e1 = cross2(v2[0], v2[1], v0[0], v0[1], pa, pb);
        const e2 = cross2(v0[0], v0[1], v1[0], v1[1], pa, pb);
        const in0 = e0 > 0 || (e0 === 0 && isTopLeftEdge(v1[0], v1[1], v2[0], v2[1]));
        const in1 = e1 > 0 || (e1 === 0 && isTopLeftEdge(v2[0], v2[1], v0[0], v0[1]));
        const in2 = e2 > 0 || (e2 === 0 && isTopLeftEdge(v0[0], v0[1], v1[0], v1[1]));
        if (in0 && in1 && in2) return true;
    }
    return false;
}

function isFullTilePoly(poly) {
    if (poly === FULL_TILE_POLY) return true;
    if (!Array.isArray(poly) || poly.length !== 4) return false;
    return poly[0][0] === 0 && poly[0][1] === 0
        && poly[1][0] === 256 && poly[1][1] === 0
        && poly[2][0] === 256 && poly[2][1] === 256
        && poly[3][0] === 0 && poly[3][1] === 256;
}

// ------------------------------------------------------------------ exact ray-plane picker

/**
 * Full ray-plane intersection result for screen art (sx, sy) against a tile
 * surface plane `plane16 = [h0, ha, hb]` clipped to `poly`.
 *
 * When `denom = 16 - (ha + hb) / 32 === 0` (parallel/coplanar viewing ray),
 * dispatches to the projected triangle/edge top-left fill fallback with zero
 * division by zero.
 */
export function pickSurfaceIntersection(sx, sy, tx, ty, plane16, poly = FULL_TILE_POLY) {
    const h0 = plane16[0];
    const ha = plane16[1];
    const hb = plane16[2];
    const a0 = (sx + 2 * sy) / TILE_WIDTH - tx + 0.5;
    const b0 = (2 * sy - sx) / TILE_WIDTH - ty + 0.5;
    const denom = HEIGHT_SCALE - (ha + hb) / TILE_HALF_WIDTH;

    if (denom === 0) {
        return pickProjectedPolygon(sx, sy, tx, ty, plane16, poly);
    }

    const h = (h0 + ha * a0 + hb * b0) / denom;
    const a = a0 + h / TILE_HALF_WIDTH;
    const b = b0 + h / TILE_HALF_WIDTH;
    if (a < 0 || a >= 1 || b < 0 || b >= 1) return null;
    if (!isFullTilePoly(poly) && !pointInPolygonTopLeft(a * POLY_SCALE, b * POLY_SCALE, poly)) {
        return null;
    }

    const u = tx - 0.5 + a;
    const v = ty - 0.5 + b;
    const proj = projectSurface(u, v, h);
    return {
        h,
        a,
        b,
        u,
        v,
        x: proj.x,
        y: proj.y,
        d: proj.d,
        parallel: false,
    };
}

/**
 * Exact ray-plane height picker matching specs/01 §4 & §5 oracle.
 * Returns the intersected elevation `h` (art px) or `null`.
 */
export function pickSurfaceHeight(sx, sy, tx, ty, plane16, poly = FULL_TILE_POLY) {
    const hit = pickSurfaceIntersection(sx, sy, tx, ty, plane16, poly);
    return hit ? hit.h : null;
}

// ------------------------------------------------------------------ D5 guard & validation

/** Returns true iff `landmark` is one of the 9 semantic landmarks + Belfry + Windmill. */
export function isSemanticLandmark(landmark) {
    if (typeof landmark !== 'string' || !landmark.trim()) return false;
    if (FORBIDDEN_D5_PATTERN.test(landmark)) return false;
    return ALLOWED_SEMANTIC_LANDMARKS.has(landmark);
}

/** Throws if `landmark` violates D5 (cottages/sheds/dwellings or non-semantic ID). */
export function assertSemanticLandmark(landmark, context = 'landmark') {
    if (typeof landmark !== 'string' || !landmark.trim()) {
        throw new Error(`Invalid ${context}: expected non-empty semantic landmark id`);
    }
    if (FORBIDDEN_D5_PATTERN.test(landmark)) {
        throw new Error(`D5 violation (${context}): decorative cottage/shed/dwelling "${landmark}" is forbidden`);
    }
    if (!ALLOWED_SEMANTIC_LANDMARKS.has(landmark)) {
        throw new Error(`D5 violation (${context}): non-semantic landmark "${landmark}" is not in the 9 landmarks + Belfry + Windmill roster`);
    }
}

function isBoundedInt(value, min, max) {
    return Number.isInteger(value) && value >= min && value <= max;
}

function surfaceKeyString(tile, id) {
    return `${tile}:${id}`;
}

function parseSurfaceRef(ref, label, errors) {
    if (!Array.isArray(ref) || ref.length !== 2 || !isBoundedInt(ref[0], 0, MAX_TILE_INDEX) || !isBoundedInt(ref[1], 0, MAX_SURFACE_ID)) {
        errors.push(`${label} must be [tileIndex(0..${MAX_TILE_INDEX}), surfaceId(0..${MAX_SURFACE_ID})]`);
        return null;
    }
    return ref;
}

function validatePoly(poly, label, errors) {
    if (!Array.isArray(poly) || poly.length < 3) {
        errors.push(`${label} must be a polygon with at least 3 vertices`);
        return false;
    }
    for (let i = 0; i < poly.length; i++) {
        const pt = poly[i];
        if (!Array.isArray(pt) || pt.length !== 2 || !isBoundedInt(pt[0], 0, POLY_SCALE) || !isBoundedInt(pt[1], 0, POLY_SCALE)) {
            errors.push(`${label}[${i}] must be integer [a, b] in [0, ${POLY_SCALE}]`);
            return false;
        }
        const next = poly[(i + 1) % poly.length];
        if (Array.isArray(next) && pt[0] === next[0] && pt[1] === next[1]) {
            errors.push(`${label}[${i}] duplicates adjacent vertex`);
            return false;
        }
    }
    const area2 = polygonSignedArea2(poly);
    if (area2 === 0) {
        errors.push(`${label} has zero area`);
        return false;
    }
    if (area2 < 0) {
        errors.push(`${label} must wind counterclockwise in (a, b)`);
        return false;
    }
    if (hasSelfIntersection(poly)) {
        errors.push(`${label} is self-intersecting`);
        return false;
    }
    return true;
}

function validateEdgeSegment(edge, label, errors) {
    if (!Array.isArray(edge) || edge.length !== 2) {
        errors.push(`${label} must be [[a0, b0], [a1, b1]]`);
        return false;
    }
    for (let i = 0; i < 2; i++) {
        const pt = edge[i];
        if (!Array.isArray(pt) || pt.length !== 2 || !isBoundedInt(pt[0], 0, POLY_SCALE) || !isBoundedInt(pt[1], 0, POLY_SCALE)) {
            errors.push(`${label}[${i}] must be integer [a, b] in [0, ${POLY_SCALE}]`);
            return false;
        }
    }
    if (edge[0][0] === edge[1][0] && edge[0][1] === edge[1][1]) {
        errors.push(`${label} has zero length`);
        return false;
    }
    return true;
}

/**
 * Validate a serialized terrain definition against specs/01 §4 and D5.
 * Returns `{ ok: boolean, errors: string[] }`.
 */
export function validateTerrainDef(terrainDef) {
    const errors = [];
    if (!terrainDef || typeof terrainDef !== 'object' || Array.isArray(terrainDef)) {
        return { ok: false, errors: ['terrainDef must be an object'] };
    }
    if (!Number.isInteger(terrainDef.version) || terrainDef.version < 1) {
        errors.push('terrainDef.version must be a positive integer');
    }
    if (typeof terrainDef.revision !== 'string' || !terrainDef.revision.trim()) {
        errors.push('terrainDef.revision must be a non-empty string');
    }

    // D5 guard: reject any top-level cottage/shed collections or forbidden keys.
    for (const key of Object.keys(terrainDef)) {
        if (FORBIDDEN_D5_PATTERN.test(key)) {
            errors.push(`D5 violation: forbidden terrainDef key "${key}"`);
        }
    }
    for (const listKey of ['landmarks', 'structures', 'sites']) {
        if (Array.isArray(terrainDef[listKey])) {
            for (let i = 0; i < terrainDef[listKey].length; i++) {
                const entry = terrainDef[listKey][i];
                const candidate = typeof entry === 'string'
                    ? entry
                    : (entry?.landmark ?? entry?.type ?? entry?.id ?? entry?.name);
                if (candidate !== null && candidate !== undefined) {
                    if (FORBIDDEN_D5_PATTERN.test(String(candidate)) || (listKey !== 'sites' && !ALLOWED_SEMANTIC_LANDMARKS.has(String(candidate)))) {
                        errors.push(`D5 violation: ${listKey}[${i}] "${candidate}" is forbidden`);
                    }
                }
            }
        }
    }

    // 1. Validate pools
    const poolMap = new Map();
    const levelHeights = new Map();
    const pools = terrainDef.pools ?? [];
    if (!Array.isArray(pools)) {
        errors.push('terrainDef.pools must be an array');
    } else {
        for (let i = 0; i < pools.length; i++) {
            const pool = pools[i];
            if (!pool || typeof pool !== 'object') {
                errors.push(`pools[${i}] must be an object`);
                continue;
            }
            if (!isBoundedInt(pool.id, 1, MAX_SURFACE_ID)) {
                errors.push(`pools[${i}].id must be an integer in [1, ${MAX_SURFACE_ID}]`);
                continue;
            }
            if (poolMap.has(pool.id)) {
                errors.push(`duplicate pool id ${pool.id}`);
                continue;
            }
            if (!isBoundedInt(pool.h16, MIN_HEIGHT16, MAX_HEIGHT16)) {
                errors.push(`pools[${i}].h16 must be a finite bounded integer in [${MIN_HEIGHT16}, ${MAX_HEIGHT16}]`);
                continue;
            }
            if (pool.flow !== undefined) {
                if (!Array.isArray(pool.flow) || pool.flow.length !== 2 || !Number.isFinite(pool.flow[0]) || !Number.isFinite(pool.flow[1])) {
                    errors.push(`pools[${i}].flow must be [fx, fy] finite numbers`);
                }
            }
            if (pool.level !== undefined && pool.level !== null) {
                if (levelHeights.has(pool.level) && levelHeights.get(pool.level) !== pool.h16) {
                    errors.push(`pools[${i}] conflicts with pool level "${pool.level}" height (${pool.h16} !== ${levelHeights.get(pool.level)})`);
                } else {
                    levelHeights.set(pool.level, pool.h16);
                }
            }
            poolMap.set(pool.id, pool);
        }
    }

    // 2. Validate tiles & surfaces
    const tileMap = new Map();
    const surfaceMap = new Map();
    const waterTileSurfaces = new Map();
    const tiles = terrainDef.tiles ?? [];
    if (!Array.isArray(tiles)) {
        errors.push('terrainDef.tiles must be an array');
    } else {
        for (let i = 0; i < tiles.length; i++) {
            const tileEntry = tiles[i];
            if (!tileEntry || typeof tileEntry !== 'object') {
                errors.push(`tiles[${i}] must be an object`);
                continue;
            }
            if (!isBoundedInt(tileEntry.tile, 0, MAX_TILE_INDEX)) {
                errors.push(`tiles[${i}].tile must be an integer in [0, ${MAX_TILE_INDEX}]`);
                continue;
            }
            if (tileMap.has(tileEntry.tile)) {
                errors.push(`duplicate tile entry ${tileEntry.tile}`);
                continue;
            }
            if (!Array.isArray(tileEntry.surfaces) || tileEntry.surfaces.length === 0) {
                errors.push(`tiles[${i}].surfaces must be a non-empty array`);
                continue;
            }

            const tileIds = new Set();
            const validSurfaces = [];
            for (let j = 0; j < tileEntry.surfaces.length; j++) {
                const surf = tileEntry.surfaces[j];
                const tag = `tiles[${i}].surfaces[${j}]`;
                if (!surf || typeof surf !== 'object') {
                    errors.push(`${tag} must be an object`);
                    continue;
                }
                if (!isBoundedInt(surf.id, 0, MAX_SURFACE_ID)) {
                    errors.push(`${tag}.id must be an integer in [0, ${MAX_SURFACE_ID}]`);
                    continue;
                }
                if (tileIds.has(surf.id)) {
                    errors.push(`duplicate surface id ${surf.id} on tile ${tileEntry.tile}`);
                    continue;
                }
                tileIds.add(surf.id);

                if (!SURFACE_KINDS.has(surf.kind)) {
                    errors.push(`${tag}.kind "${surf.kind}" must be floor, water, or stair`);
                }
                const polyOk = validatePoly(surf.poly, `${tag}.poly`, errors);

                let planeOk = false;
                if (!Array.isArray(surf.plane16) || surf.plane16.length !== 3
                    || !surf.plane16.every((n) => isBoundedInt(n, MIN_HEIGHT16, MAX_HEIGHT16))) {
                    errors.push(`${tag}.plane16 must be 3 bounded integers in [${MIN_HEIGHT16}, ${MAX_HEIGHT16}]`);
                } else {
                    planeOk = true;
                }

                if (surf.underside16 !== null && surf.underside16 !== undefined) {
                    if (!isBoundedInt(surf.underside16, MIN_HEIGHT16, MAX_HEIGHT16)) {
                        errors.push(`${tag}.underside16 must be null or a bounded integer in [${MIN_HEIGHT16}, ${MAX_HEIGHT16}]`);
                    } else if (planeOk && polyOk) {
                        for (const [pa, pb] of surf.poly) {
                            const topScaled = vertexHeight16x256(surf.plane16, pa, pb);
                            if (surf.underside16 * POLY_SCALE >= topScaled) {
                                errors.push(`${tag}.underside16 (${surf.underside16}) must be strictly below top plane`);
                                break;
                            }
                        }
                    }
                }

                if (typeof surf.material !== 'string' || !REGISTERED_MATERIALS.has(surf.material)) {
                    errors.push(`${tag}.material "${surf.material}" is not in ART_RAMPS`);
                }
                if (typeof surf.walk !== 'boolean') {
                    errors.push(`${tag}.walk must be a boolean`);
                }
                if (surf.sublayer !== undefined && !isBoundedInt(surf.sublayer, 0, 7)) {
                    errors.push(`${tag}.sublayer must be an integer in [0, 7]`);
                }
                if (surf.landmark !== undefined && surf.landmark !== null) {
                    if (!isSemanticLandmark(surf.landmark)) {
                        errors.push(`D5 violation: ${tag}.landmark "${surf.landmark}" is forbidden`);
                    }
                }

                if (surf.kind === 'water') {
                    if (surf.walk === true) {
                        errors.push(`${tag}: water surface cannot be walkable`);
                    }
                    const pool = poolMap.get(surf.basin);
                    if (!pool) {
                        errors.push(`${tag}.basin (${surf.basin}) does not reference a valid pool`);
                    } else if (planeOk && (surf.plane16[0] !== pool.h16 || surf.plane16[1] !== 0 || surf.plane16[2] !== 0)) {
                        errors.push(`${tag}.plane16 [${surf.plane16}] must equal pool ${pool.id} plane [${pool.h16}, 0, 0]`);
                    }
                } else if (surf.basin !== null && surf.basin !== undefined) {
                    errors.push(`${tag}.basin must be null for non-water surface kind "${surf.kind}"`);
                }

                const record = { tile: tileEntry.tile, surface: surf };
                surfaceMap.set(surfaceKeyString(tileEntry.tile, surf.id), record);
                validSurfaces.push(surf);
                if (surf.kind === 'water') {
                    if (!waterTileSurfaces.has(tileEntry.tile)) waterTileSurfaces.set(tileEntry.tile, []);
                    waterTileSurfaces.get(tileEntry.tile).push(surf);
                }
            }
            tileMap.set(tileEntry.tile, validSurfaces);
        }
    }

    // 3. Validate banks
    const banks = terrainDef.banks ?? [];
    if (!Array.isArray(banks)) {
        errors.push('terrainDef.banks must be an array');
    } else {
        for (let i = 0; i < banks.length; i++) {
            const bank = banks[i];
            const tag = `banks[${i}]`;
            if (!bank || typeof bank !== 'object') {
                errors.push(`${tag} must be an object`);
                continue;
            }
            const topRef = parseSurfaceRef(bank.top, `${tag}.top`, errors);
            const waterRef = parseSurfaceRef(bank.water, `${tag}.water`, errors);
            validateEdgeSegment(bank.edge, `${tag}.edge`, errors);
            if (!isBoundedInt(bank.lip16, MIN_HEIGHT16, MAX_HEIGHT16)) {
                errors.push(`${tag}.lip16 must be a bounded integer`);
            }
            if (typeof bank.material !== 'string' || !REGISTERED_MATERIALS.has(bank.material)) {
                errors.push(`${tag}.material "${bank.material}" is not in ART_RAMPS`);
            }
            if (topRef) {
                const topRec = surfaceMap.get(surfaceKeyString(topRef[0], topRef[1]));
                if (!topRec) errors.push(`${tag}.top [${topRef}] does not reference an existing surface`);
                else if (topRec.surface.kind === 'water') errors.push(`${tag}.top [${topRef}] cannot reference a water surface`);
            }
            if (waterRef) {
                const waterRec = surfaceMap.get(surfaceKeyString(waterRef[0], waterRef[1]));
                if (!waterRec) errors.push(`${tag}.water [${waterRef}] does not reference an existing surface`);
                else if (waterRec.surface.kind !== 'water') errors.push(`${tag}.water [${waterRef}] must reference a water surface`);
                else if (isBoundedInt(bank.lip16, MIN_HEIGHT16, MAX_HEIGHT16) && bank.lip16 < waterRec.surface.plane16[0]) {
                    errors.push(`${tag}.lip16 (${bank.lip16}) lies below waterline (${waterRec.surface.plane16[0]})`);
                }
            }
        }
    }

    // 4. Validate footings (including strict D5 landmark guard)
    const footings = terrainDef.footings ?? [];
    if (!Array.isArray(footings)) {
        errors.push('terrainDef.footings must be an array');
    } else {
        for (let i = 0; i < footings.length; i++) {
            const footing = footings[i];
            const tag = `footings[${i}]`;
            if (!footing || typeof footing !== 'object') {
                errors.push(`${tag} must be an object`);
                continue;
            }
            if (!isSemanticLandmark(footing.landmark)) {
                errors.push(`D5 violation: ${tag}.landmark "${footing.landmark}" is not an allowed semantic landmark`);
            }
            const supRef = parseSurfaceRef(footing.support, `${tag}.support`, errors);
            if (supRef && !surfaceMap.has(surfaceKeyString(supRef[0], supRef[1]))) {
                errors.push(`${tag}.support [${supRef}] does not reference an existing surface`);
            }
            validatePoly(footing.poly, `${tag}.poly`, errors);
            if (!Array.isArray(footing.courses16) || footing.courses16.length === 0) {
                errors.push(`${tag}.courses16 must be a non-empty array of positive integers`);
            } else {
                let prev = 0;
                for (let c = 0; c < footing.courses16.length; c++) {
                    const course = footing.courses16[c];
                    if (!isBoundedInt(course, 1, MAX_HEIGHT16) || course <= prev) {
                        errors.push(`${tag}.courses16[${c}] must be strictly increasing positive integers`);
                        break;
                    }
                    prev = course;
                }
            }
            if (typeof footing.material !== 'string' || !REGISTERED_MATERIALS.has(footing.material)) {
                errors.push(`${tag}.material "${footing.material}" is not in ART_RAMPS`);
            }
        }
    }

    // 5. Validate links: shared edge (opposite CCW ordering), no diagonal cuts, exact endpoint heights
    const links = terrainDef.links ?? [];
    if (!Array.isArray(links)) {
        errors.push('terrainDef.links must be an array');
    } else {
        for (let i = 0; i < links.length; i++) {
            const link = links[i];
            const tag = `links[${i}]`;
            if (!link || typeof link !== 'object') {
                errors.push(`${tag} must be an object`);
                continue;
            }
            const fromRef = parseSurfaceRef(link.from, `${tag}.from`, errors);
            const toRef = parseSurfaceRef(link.to, `${tag}.to`, errors);
            if (!fromRef || !toRef) continue;
            if (fromRef[0] === toRef[0] && fromRef[1] === toRef[1]) {
                errors.push(`${tag} cannot self-link [${fromRef}]`);
                continue;
            }
            const fromRec = surfaceMap.get(surfaceKeyString(fromRef[0], fromRef[1]));
            const toRec = surfaceMap.get(surfaceKeyString(toRef[0], toRef[1]));
            if (!fromRec) {
                errors.push(`${tag}.from [${fromRef}] does not reference an existing surface`);
                continue;
            }
            if (!toRec) {
                errors.push(`${tag}.to [${toRef}] does not reference an existing surface`);
                continue;
            }
            if (!fromRec.surface.walk || !toRec.surface.walk) {
                errors.push(`${tag} must connect walkable surfaces`);
            }
            const fromCoords = tileCoords(fromRef[0]);
            const toCoords = tileCoords(toRef[0]);
            const manhattan = Math.abs(fromCoords.tx - toCoords.tx) + Math.abs(fromCoords.ty - toCoords.ty);
            if (manhattan > 1) {
                errors.push(`${tag} rejects diagonal corner cut or non-adjacent tiles (${fromCoords.tx},${fromCoords.ty}) -> (${toCoords.tx},${toCoords.ty})`);
                continue;
            }

            const fromPoly = fromRec.surface.poly;
            const toPoly = toRec.surface.poly;
            if (!isBoundedInt(link.fromEdge, 0, fromPoly.length - 1)) {
                errors.push(`${tag}.fromEdge (${link.fromEdge}) out of range 0..${fromPoly.length - 1}`);
                continue;
            }
            if (!isBoundedInt(link.toEdge, 0, toPoly.length - 1)) {
                errors.push(`${tag}.toEdge (${link.toEdge}) out of range 0..${toPoly.length - 1}`);
                continue;
            }

            const fA = fromPoly[link.fromEdge];
            const fB = fromPoly[(link.fromEdge + 1) % fromPoly.length];
            const tA = toPoly[link.toEdge];
            const tB = toPoly[(link.toEdge + 1) % toPoly.length];

            // Transform both edges into global 1/256 tile space.
            // Two CCW polygons sharing an edge traverse it in opposite order:
            //   world(fA) === world(tB)  AND  world(fB) === world(tA).
            const fwAx = fromCoords.tx * POLY_SCALE + fA[0];
            const fwAy = fromCoords.ty * POLY_SCALE + fA[1];
            const fwBx = fromCoords.tx * POLY_SCALE + fB[0];
            const fwBy = fromCoords.ty * POLY_SCALE + fB[1];

            const twAx = toCoords.tx * POLY_SCALE + tA[0];
            const twAy = toCoords.ty * POLY_SCALE + tA[1];
            const twBx = toCoords.tx * POLY_SCALE + tB[0];
            const twBy = toCoords.ty * POLY_SCALE + tB[1];

            const exactOpposite = (fwAx === twBx && fwAy === twBy && fwBx === twAx && fwBy === twAy);
            if (!exactOpposite) {
                errors.push(`${tag} edges do not match in opposite CCW order across shared border`);
                continue;
            }

            // Exact endpoint height comparison (no tolerance: 1/16 px mismatch fails!).
            const hfA = vertexHeight16x256(fromRec.surface.plane16, fA[0], fA[1]);
            const hfB = vertexHeight16x256(fromRec.surface.plane16, fB[0], fB[1]);
            const htB = vertexHeight16x256(toRec.surface.plane16, tB[0], tB[1]);
            const htA = vertexHeight16x256(toRec.surface.plane16, tA[0], tA[1]);

            if (hfA !== htB || hfB !== htA) {
                errors.push(
                    `${tag} endpoint height mismatch across shared edge: `
                    + `from [${hfA / POLY_SCALE}, ${hfB / POLY_SCALE}] vs to [${htB / POLY_SCALE}, ${htA / POLY_SCALE}] (in 1/16 px)`,
                );
            }
        }
    }

    // 6. Validate spills: distinct pools, upper H > lower H
    const spillIds = new Set();
    const spillTilePairs = new Set();
    const spills = terrainDef.spills ?? [];
    if (!Array.isArray(spills)) {
        errors.push('terrainDef.spills must be an array');
    } else {
        for (let i = 0; i < spills.length; i++) {
            const spill = spills[i];
            const tag = `spills[${i}]`;
            if (!spill || typeof spill !== 'object') {
                errors.push(`${tag} must be an object`);
                continue;
            }
            if ((typeof spill.id !== 'string' || !spill.id.trim()) && !Number.isInteger(spill.id)) {
                errors.push(`${tag}.id must be a non-empty string or integer`);
            } else if (spillIds.has(spill.id)) {
                errors.push(`duplicate spill id "${spill.id}"`);
            } else {
                spillIds.add(spill.id);
            }
            const upRef = parseSurfaceRef(spill.upper, `${tag}.upper`, errors);
            const loRef = parseSurfaceRef(spill.lower, `${tag}.lower`, errors);
            validateEdgeSegment(spill.edge, `${tag}.edge`, errors);
            if (!isBoundedInt(spill.frames, 1, 64)) {
                errors.push(`${tag}.frames must be a positive integer`);
            }
            if (!upRef || !loRef) continue;
            const upRec = surfaceMap.get(surfaceKeyString(upRef[0], upRef[1]));
            const loRec = surfaceMap.get(surfaceKeyString(loRef[0], loRef[1]));
            if (!upRec || upRec.surface.kind !== 'water') {
                errors.push(`${tag}.upper [${upRef}] must reference an existing water surface`);
                continue;
            }
            if (!loRec || loRec.surface.kind !== 'water') {
                errors.push(`${tag}.lower [${loRef}] must reference an existing water surface`);
                continue;
            }
            const upPool = poolMap.get(upRec.surface.basin);
            const loPool = poolMap.get(loRec.surface.basin);
            if (!upPool || !loPool) continue;
            if (upPool.id === loPool.id) {
                errors.push(`${tag} must reference distinct pools (both belong to pool ${upPool.id})`);
            }
            if (upPool.h16 <= loPool.h16) {
                errors.push(`${tag} requires upper pool H (${upPool.h16}) > lower pool H (${loPool.h16})`);
            }
            const aKey = Math.min(upRef[0], loRef[0]);
            const bKey = Math.max(upRef[0], loRef[0]);
            spillTilePairs.add(`${aKey}:${bKey}`);
        }
    }

    // 7. Connected water level check: orthogonally adjacent water tiles without an
    //    intervening spill must share a unique pool height.
    for (const [tIdx, surfs] of waterTileSurfaces.entries()) {
        const { tx, ty } = tileCoords(tIdx);
        for (const [dx, dy] of [[1, 0], [0, 1]]) {
            const nx = tx + dx;
            const ny = ty + dy;
            if (nx >= MAP_SIZE || ny >= MAP_SIZE) continue;
            const nIdx = tileIndex(nx, ny);
            const nSurfs = waterTileSurfaces.get(nIdx);
            if (!nSurfs) continue;
            const pairKey = `${Math.min(tIdx, nIdx)}:${Math.max(tIdx, nIdx)}`;
            if (spillTilePairs.has(pairKey)) continue;
            for (const sA of surfs) {
                const pA = poolMap.get(sA.basin);
                if (!pA) continue;
                for (const sB of nSurfs) {
                    const pB = poolMap.get(sB.basin);
                    if (!pB) continue;
                    if (pA.h16 !== pB.h16) {
                        errors.push(
                            `connected water tiles (${tx},${ty}) [pool ${pA.id}, h16=${pA.h16}] and `
                            + `(${nx},${ny}) [pool ${pB.id}, h16=${pB.h16}] have conflicting heights without a spill`,
                        );
                    }
                }
            }
        }
    }

    return { ok: errors.length === 0, errors };
}

// ------------------------------------------------------------------ SurfaceRegistry

function deepFreezeSurface(tile, surf) {
    return Object.freeze({
        tile,
        id: surf.id,
        kind: surf.kind,
        poly: Object.freeze(surf.poly.map((pt) => Object.freeze([pt[0], pt[1]]))),
        plane16: Object.freeze([surf.plane16[0], surf.plane16[1], surf.plane16[2]]),
        underside16: surf.underside16 ?? null,
        material: surf.material,
        walk: surf.walk,
        basin: surf.basin ?? null,
        sublayer: surf.sublayer ?? 0,
        selectable: surf.selectable !== false,
        route: surf.route ?? null,
        legacy: Boolean(surf.legacy),
    });
}

function normalizeCandidateTiles(candidateTiles, tileMap) {
    if (candidateTiles === undefined || candidateTiles === null) {
        return Array.from(tileMap.keys());
    }
    const out = [];
    const seen = new Set();
    for (const item of candidateTiles) {
        let idx = -1;
        if (typeof item === 'number') {
            if (Number.isInteger(item) && item >= 0 && item <= MAX_TILE_INDEX) idx = item;
        } else if (Array.isArray(item) && item.length >= 2) {
            const [tx, ty] = item;
            if (Number.isInteger(tx) && Number.isInteger(ty) && tx >= 0 && ty >= 0 && tx < MAP_SIZE && ty < MAP_SIZE) {
                idx = MAP_SIZE * ty + tx;
            }
        } else if (item && typeof item === 'object') {
            const tx = item.tx ?? item.tileX ?? item.x;
            const ty = item.ty ?? item.tileY ?? item.y;
            if (Number.isInteger(tx) && Number.isInteger(ty) && tx >= 0 && ty >= 0 && tx < MAP_SIZE && ty < MAP_SIZE) {
                idx = MAP_SIZE * ty + tx;
            }
        }
        if (idx >= 0 && !seen.has(idx)) {
            seen.add(idx);
            out.push(idx);
        }
    }
    return out;
}

function comparePickHits(a, b) {
    if (a.d !== b.d) return a.d - b.d;
    if (a.sublayer !== b.sublayer) return a.sublayer - b.sublayer;
    if (a.h !== b.h) return a.h - b.h;
    if (a.surfaceId !== b.surfaceId) return a.surfaceId - b.surfaceId;
    return a.tile - b.tile;
}

/**
 * Validate `terrainDef` and construct an immutable `SurfaceRegistry`.
 * Throws a descriptive `Error` if any contract invariant fails.
 */
export function createSurfaceRegistry(terrainDef) {
    const check = validateTerrainDef(terrainDef);
    if (!check.ok) {
        throw new Error(`Invalid terrainDef: ${check.errors.join('; ')}`);
    }

    const poolsById = new Map();
    for (const p of terrainDef.pools ?? []) {
        poolsById.set(p.id, Object.freeze({
            id: p.id,
            h16: p.h16,
            height: p.h16 / HEIGHT_SCALE,
            flow: Object.freeze(p.flow ? [p.flow[0], p.flow[1]] : [0, 0]),
            level: p.level ?? null,
        }));
    }

    const surfacesByTile = new Map();
    const surfacesByKey = new Map();
    for (const tileEntry of terrainDef.tiles ?? []) {
        const frozenList = Object.freeze(tileEntry.surfaces.map((s) => {
            const rec = deepFreezeSurface(tileEntry.tile, s);
            surfacesByKey.set(surfaceKeyString(tileEntry.tile, s.id), rec);
            return rec;
        }));
        surfacesByTile.set(tileEntry.tile, frozenList);
    }

    const adjacency = new Map();
    const frozenLinks = Object.freeze((terrainDef.links ?? []).map((link) => {
        const item = Object.freeze({
            from: Object.freeze([link.from[0], link.from[1]]),
            to: Object.freeze([link.to[0], link.to[1]]),
            fromEdge: link.fromEdge,
            toEdge: link.toEdge,
            bidirectional: link.bidirectional !== false,
        });
        const fromKey = surfaceKeyString(item.from[0], item.from[1]);
        const toKey = surfaceKeyString(item.to[0], item.to[1]);
        if (!adjacency.has(fromKey)) adjacency.set(fromKey, []);
        adjacency.get(fromKey).push(Object.freeze({
            to: item.to,
            fromEdge: item.fromEdge,
            toEdge: item.toEdge,
            link: item,
        }));
        if (item.bidirectional) {
            if (!adjacency.has(toKey)) adjacency.set(toKey, []);
            adjacency.get(toKey).push(Object.freeze({
                to: item.from,
                fromEdge: item.toEdge,
                toEdge: item.fromEdge,
                link: item,
            }));
        }
        return item;
    }));

    const frozenBanks = Object.freeze((terrainDef.banks ?? []).map((b) => Object.freeze({
        top: Object.freeze([b.top[0], b.top[1]]),
        water: Object.freeze([b.water[0], b.water[1]]),
        edge: Object.freeze([Object.freeze([...b.edge[0]]), Object.freeze([...b.edge[1]])]),
        lip16: b.lip16,
        material: b.material,
        style: b.style ?? null,
        foam: Boolean(b.foam),
    })));

    const frozenFootings = Object.freeze((terrainDef.footings ?? []).map((f) => Object.freeze({
        landmark: f.landmark,
        support: Object.freeze([f.support[0], f.support[1]]),
        poly: Object.freeze(f.poly.map((pt) => Object.freeze([pt[0], pt[1]]))),
        courses16: Object.freeze([...f.courses16]),
        material: f.material,
        orientation: f.orientation ?? null,
    })));

    const frozenSpills = Object.freeze((terrainDef.spills ?? []).map((s) => Object.freeze({
        id: s.id,
        upper: Object.freeze([s.upper[0], s.upper[1]]),
        lower: Object.freeze([s.lower[0], s.lower[1]]),
        edge: Object.freeze([Object.freeze([...s.edge[0]]), Object.freeze([...s.edge[1]])]),
        frames: s.frames,
    })));

    function getSurfaceByKey(key) {
        if (!Array.isArray(key) || key.length !== 2) return null;
        return surfacesByKey.get(surfaceKeyString(key[0], key[1])) ?? null;
    }

    function getTileSurfacesByIndex(idx) {
        return surfacesByTile.get(idx) ?? EMPTY_SURFACES;
    }

    function getTileSurfaces(tx, ty) {
        return getTileSurfacesByIndex(tileIndex(tx, ty));
    }

    function getSurface(tx, ty, surfaceId) {
        const idx = tileIndex(tx, ty);
        return surfacesByKey.get(surfaceKeyString(idx, surfaceId)) ?? null;
    }

    // BFS reachable set from a collection of seed surface keys (`"tile:id"`).
    function reachableKeysFrom(seedKeys) {
        const visited = new Set();
        const queue = [];
        for (const key of seedKeys) {
            if (surfacesByKey.has(key) && !visited.has(key)) {
                visited.add(key);
                queue.push(key);
            }
        }
        let head = 0;
        while (head < queue.length) {
            const cur = queue[head++];
            const edges = adjacency.get(cur);
            if (!edges) continue;
            for (let i = 0; i < edges.length; i++) {
                const nextKey = surfaceKeyString(edges[i].to[0], edges[i].to[1]);
                if (!visited.has(nextKey)) {
                    visited.add(nextKey);
                    queue.push(nextKey);
                }
            }
        }
        return visited;
    }

    // Precompute legacy-ground seed keys (`id === 0` walkable floors, or explicit `legacy: true`).
    const legacyGroundSeeds = [];
    for (const [key, surf] of surfacesByKey.entries()) {
        if (surf.walk && (surf.id === FLAT_GROUND_ID || surf.legacy)) {
            legacyGroundSeeds.push(key);
        }
    }
    const legacyGroundReachable = reachableKeysFrom(legacyGroundSeeds);

    /**
     * Exact per-surface elevation query at tile (tx, ty) and local (a, b).
     * Requires explicit `surfaceId` on overlapping tiles (more than one surface).
     */
    function heightAt(tx, ty, surfaceId = undefined, a = 0.5, b = 0.5) {
        const idx = tileIndex(tx, ty);
        const list = surfacesByTile.get(idx);

        if (surfaceId === undefined || surfaceId === null) {
            if (!list || list.length === 0) return 0;
            if (list.length > 1) {
                throw new RangeError(
                    `heightAt(${tx}, ${ty}) requires explicit surfaceId on overlapping tile ${idx} `
                    + `(surfaces: ${list.map((s) => s.id).join(', ')})`,
                );
            }
            return planeHeight(list[0].plane16, a, b);
        }

        if (!list || list.length === 0) {
            return surfaceId === FLAT_GROUND_ID ? 0 : null;
        }
        const surf = surfacesByKey.get(surfaceKeyString(idx, surfaceId));
        if (!surf) return null;
        return planeHeight(surf.plane16, a, b);
    }

    /** Legacy planar caller helper: always reads default route id=0 (or implicit 0). */
    function aggregateHeightAt(tx, ty, a = 0.5, b = 0.5) {
        const idx = tileIndex(tx, ty);
        const ground = surfacesByKey.get(surfaceKeyString(idx, FLAT_GROUND_ID));
        if (ground) return planeHeight(ground.plane16, a, b);
        const list = surfacesByTile.get(idx);
        if (!list || list.length === 0) return 0;
        const firstWalk = list.find((s) => s.walk && s.underside16 === null);
        return firstWalk ? planeHeight(firstWalk.plane16, a, b) : planeHeight(list[0].plane16, a, b);
    }

    /** Vertical slab interval `[underside, top]` (in art px & 1/16 px) for overlap/ORCA checks. */
    function slabBoundsAt(tx, ty, surfaceId, a = 0.5, b = 0.5) {
        const surf = getSurface(tx, ty, surfaceId);
        if (!surf) return null;
        const top16 = planeHeight16(surf.plane16, a, b);
        return {
            top16,
            underside16: surf.underside16,
            top: top16 / HEIGHT_SCALE,
            underside: surf.underside16 !== null ? surf.underside16 / HEIGHT_SCALE : null,
        };
    }

    /**
     * Pick the topmost valid intersected surface across `candidateTiles` at
     * pre-camera art coordinates `(sx, sy)`.
     *
     * Chooses greatest near-order `d = 32*(u+v) + h/2`; ties break deterministically
     * by higher `sublayer`, higher `h`, higher `surfaceId`, then higher `tile`.
     * If the topmost intersected surface is opaque and nonselectable (`selectable: false`),
     * it blocks picks behind it and returns `null`.
     */
    function pickTopSurface(sx, sy, candidateTiles = null, options = {}) {
        const includeImplicitGround = Boolean(options?.includeImplicitGround);
        const indices = normalizeCandidateTiles(candidateTiles, surfacesByTile);
        let best = null;

        for (let i = 0; i < indices.length; i++) {
            const idx = indices[i];
            const { tx, ty } = tileCoords(idx);
            const list = surfacesByTile.get(idx);

            if (!list || list.length === 0) {
                if (!includeImplicitGround) continue;
                const hit = pickSurfaceIntersection(sx, sy, tx, ty, ZERO_PLANE16, FULL_TILE_POLY);
                if (!hit) continue;
                const cand = {
                    tile: idx,
                    tx,
                    ty,
                    surfaceId: FLAT_GROUND_ID,
                    surface: null,
                    sublayer: 0,
                    selectable: true,
                    ...hit,
                };
                if (!best || comparePickHits(cand, best) > 0) best = cand;
                continue;
            }

            for (let j = 0; j < list.length; j++) {
                const surf = list[j];
                const hit = pickSurfaceIntersection(sx, sy, tx, ty, surf.plane16, surf.poly);
                if (!hit) continue;
                const cand = {
                    tile: idx,
                    tx,
                    ty,
                    surfaceId: surf.id,
                    surface: surf,
                    sublayer: surf.sublayer,
                    selectable: surf.selectable,
                    ...hit,
                };
                if (!best || comparePickHits(cand, best) > 0) best = cand;
            }
        }

        if (!best || !best.selectable) return null;
        return best;
    }

    function linksFrom(tx, ty, surfaceId) {
        const idx = tileIndex(tx, ty);
        return Object.freeze([...(adjacency.get(surfaceKeyString(idx, surfaceId)) ?? [])]);
    }

    function areLinked(fromKey, toKey) {
        const edges = adjacency.get(surfaceKeyString(fromKey[0], fromKey[1]));
        if (!edges) return false;
        return edges.some((e) => e.to[0] === toKey[0] && e.to[1] === toKey[1]);
    }

    /** 3D segment length between linked surface centers (in art px: 1 tile = 32 iso px horiz, h in art px). */
    function linkCost3D(link) {
        const fromRec = getSurfaceByKey(link.from);
        const toRec = getSurfaceByKey(link.to);
        if (!fromRec || !toRec) return Infinity;
        const fc = tileCoords(link.from[0]);
        const tc = tileCoords(link.to[0]);
        const fh = planeHeight(fromRec.plane16, 0.5, 0.5);
        const th = planeHeight(toRec.plane16, 0.5, 0.5);
        const du = (tc.tx - fc.tx) * TILE_HALF_WIDTH;
        const dv = (tc.ty - fc.ty) * TILE_HALF_WIDTH;
        const dh = th - fh;
        return Math.hypot(du, dv, dh);
    }

    /**
     * Resolve a legacy save position `(tx, ty)` lacking an explicit `surfaceId`
     * onto its known route (bridge span if `onBridge`, else explicit `knownRoute`,
     * else legacy flat ground route, else nearest reachable landing).
     *
     * Strictly guarantees a legacy actor can NEVER teleport onto an elevated
     * disconnected terrace by height proximity!
     */
    function resolveLegacySurface(tx, ty, { onBridge = false, knownRoute = null } = {}) {
        const cx = Math.floor(tx + 0.5);
        const cy = Math.floor(ty + 0.5);
        if (cx < 0 || cy < 0 || cx >= MAP_SIZE || cy >= MAP_SIZE) return null;
        const idx = tileIndex(cx, cy);
        const list = surfacesByTile.get(idx);

        const formatResult = (surf, tileIdx, reason, fallback) => {
            const coords = tileCoords(tileIdx);
            return {
                tile: tileIdx,
                tx: coords.tx,
                ty: coords.ty,
                surfaceId: surf ? surf.id : FLAT_GROUND_ID,
                surface: surf,
                height: surf ? planeHeight(surf.plane16, 0.5, 0.5) : 0,
                reason,
                fallback,
            };
        };

        // 1. Known bridge route takes raised bridge/slab surface on this tile.
        if (onBridge) {
            if (list && list.length > 0) {
                const bridgeSurf = list.find((s) => s.walk && (s.route === 'bridge' || s.underside16 !== null))
                    ?? list.find((s) => s.walk && s.id !== FLAT_GROUND_ID);
                if (bridgeSurf) {
                    return formatResult(bridgeSurf, idx, 'bridge-span', false);
                }
            }
        }

        // 2. Explicit knownRoute (route name string, starting key `[tile, id]`, or list of keys).
        if (knownRoute !== null && knownRoute !== undefined) {
            if (typeof knownRoute === 'string') {
                if (list && list.length > 0) {
                    const tagged = list.find((s) => s.walk && s.route === knownRoute);
                    if (tagged) return formatResult(tagged, idx, 'known-route', false);
                }
                // Nearest walkable surface belonging to that named route.
                const nearestTagged = findNearestSurface(cx, cy, (s) => s.walk && s.route === knownRoute);
                if (nearestTagged) return formatResult(nearestTagged, nearestTagged.tile, 'nearest-route-landing', true);
            } else if (Array.isArray(knownRoute) && knownRoute.length === 2 && typeof knownRoute[0] === 'number') {
                // Single seed `[tile, id]`: restrict strictly to surfaces reachable via links.
                const seedKey = surfaceKeyString(knownRoute[0], knownRoute[1]);
                const reachable = reachableKeysFrom([seedKey]);
                if (list && list.length > 0) {
                    const localReach = list.find((s) => s.walk && reachable.has(surfaceKeyString(idx, s.id)));
                    if (localReach) return formatResult(localReach, idx, 'known-route-reachable', false);
                }
                const nearestReach = findNearestSurface(cx, cy, (s) => s.walk && reachable.has(surfaceKeyString(s.tile, s.id)));
                if (nearestReach) return formatResult(nearestReach, nearestReach.tile, 'nearest-reachable-landing', true);
                return null;
            } else if (Array.isArray(knownRoute)) {
                const allowed = new Set(knownRoute.map((k) => surfaceKeyString(k[0], k[1])));
                if (list && list.length > 0) {
                    const match = list.find((s) => s.walk && allowed.has(surfaceKeyString(idx, s.id)));
                    if (match) return formatResult(match, idx, 'known-route-set', false);
                }
                const nearestInSet = findNearestSurface(cx, cy, (s) => s.walk && allowed.has(surfaceKeyString(s.tile, s.id)));
                if (nearestInSet) return formatResult(nearestInSet, nearestInSet.tile, 'nearest-route-landing', true);
                return null;
            }
        }

        // 3. Unauthored tile: implicit legacy flat ground at id = 0, H = 0.
        if (!list || list.length === 0) {
            return formatResult(null, idx, 'implicit-ground', false);
        }

        // 4. Authored tile: prefer legacy ground (id === 0 or explicit `legacy: true`).
        const ground = list.find((s) => s.walk && (s.id === FLAT_GROUND_ID || s.legacy));
        if (ground) {
            return formatResult(ground, idx, 'legacy-ground', false);
        }

        // 5. Never teleport onto a disconnected elevated terrace!
        //    Only accept a non-ground surface on this tile if it is link-reachable
        //    from the legacy ground network AND at ground level (or connected stair).
        const connectedLocal = list.find((s) => (
            s.walk
            && legacyGroundReachable.has(surfaceKeyString(idx, s.id))
            && (s.kind === 'stair' || planeHeight16(s.plane16, 0.5, 0.5) === 0)
        ));
        if (connectedLocal) {
            return formatResult(connectedLocal, idx, 'connected-legacy-route', false);
        }

        // 6. Otherwise fall back to the nearest reachable legacy ground landing.
        const nearestLanding = findNearestSurface(
            cx,
            cy,
            (s) => s.walk && (s.id === FLAT_GROUND_ID || s.legacy || (legacyGroundReachable.has(surfaceKeyString(s.tile, s.id)) && planeHeight16(s.plane16, 0.5, 0.5) === 0)),
        );
        if (nearestLanding) {
            return formatResult(nearestLanding, nearestLanding.tile, 'nearest-reachable-landing', true);
        }

        return null;
    }

    function findNearestSurface(cx, cy, predicate) {
        let best = null;
        let bestDistSq = Infinity;
        for (const surf of surfacesByKey.values()) {
            if (!predicate(surf)) continue;
            const coords = tileCoords(surf.tile);
            const dx = coords.tx - cx;
            const dy = coords.ty - cy;
            const distSq = dx * dx + dy * dy;
            if (distSq < bestDistSq
                || (distSq === bestDistSq && (!best || surf.tile < best.tile || (surf.tile === best.tile && surf.id < best.id)))) {
                bestDistSq = distSq;
                best = surf;
            }
        }
        return best;
    }

    function spillsForPool(poolId) {
        return frozenSpills.filter((s) => {
            const up = getSurfaceByKey(s.upper);
            const lo = getSurfaceByKey(s.lower);
            return up?.basin === poolId || lo?.basin === poolId;
        });
    }

    function banksForTile(tileIdx) {
        return frozenBanks.filter((b) => b.top[0] === tileIdx || b.water[0] === tileIdx);
    }

    function footingsForLandmark(landmark) {
        return frozenFootings.filter((f) => f.landmark === landmark);
    }

    return Object.freeze({
        version: terrainDef.version,
        revision: terrainDef.revision,
        pools: Object.freeze(Array.from(poolsById.values())),
        banks: frozenBanks,
        footings: frozenFootings,
        links: frozenLinks,
        spills: frozenSpills,
        getPool: (poolId) => poolsById.get(poolId) ?? null,
        getTileSurfaces,
        getTileSurfacesByIndex,
        getSurface,
        getSurfaceByKey,
        heightAt,
        aggregateHeightAt,
        slabBoundsAt,
        pickTopSurface,
        linksFrom,
        areLinked,
        linkCost3D,
        resolveLegacySurface,
        spillsForPool,
        banksForTile,
        footingsForLandmark,
    });
}

const EMPTY_SURFACES = Object.freeze([]);
const ZERO_PLANE16 = Object.freeze([0, 0, 0]);

// ------------------------------------------------------------------ E2 pilot preset

/**
 * Single-terrace (+8 px) + 8px stair flight + overlapping deck slab +
 * raised lagoon (+7 px) to lower canal (-1 px) spillway pilot terrain preset.
 *
 * Strictly valid under `createSurfaceRegistry()` and D5.
 */
export function createE2PilotTerrain() {
    const full = FULL_TILE_POLY.map((pt) => [...pt]);
    const tApproach = tileIndex(9, 10);  // 409: flat approach road
    const tStair = tileIndex(10, 10);    // 410: +0 -> +8 px stair climbing east (+a)
    const tTerraceW = tileIndex(11, 10); // 411: +8 px terrace landing
    const tTerraceE = tileIndex(12, 10); // 412: +8 px terrace keep pad (Command footing)
    const tOverlap = tileIndex(9, 11);   // 449: ground [0] + raised slab [96..128]
    const tQuay = tileIndex(10, 12);     // 490: lower quay lip beside canal
    const tLagoon = tileIndex(11, 11);   // 451: raised lagoon (+7 px, h16 = +112)
    const tCanal = tileIndex(11, 12);    // 491: lower canal (-1 px, h16 = -16, 8 px head drop)

    return {
        version: 1,
        revision: 'e2-pilot-terrace-stair-spillway-1',
        pools: [
            { id: 1, h16: -16, flow: [0, 1] },
            { id: 2, h16: 112, flow: [0, 1] },
        ],
        tiles: [
            {
                tile: tApproach,
                surfaces: [
                    {
                        id: 0,
                        kind: 'floor',
                        poly: full,
                        plane16: [0, 0, 0],
                        underside16: null,
                        material: 'road',
                        walk: true,
                        basin: null,
                        route: 'ground',
                        legacy: true,
                    },
                ],
            },
            {
                tile: tStair,
                surfaces: [
                    {
                        id: 3,
                        kind: 'stair',
                        poly: full,
                        plane16: [0, 128, 0],
                        underside16: null,
                        material: 'ashlar',
                        walk: true,
                        basin: null,
                        route: 'terrace-stair',
                    },
                ],
            },
            {
                tile: tTerraceW,
                surfaces: [
                    {
                        id: 2,
                        kind: 'floor',
                        poly: full,
                        plane16: [128, 0, 0],
                        underside16: null,
                        material: 'plaza',
                        walk: true,
                        basin: null,
                        route: 'terrace',
                    },
                ],
            },
            {
                tile: tTerraceE,
                surfaces: [
                    {
                        id: 2,
                        kind: 'floor',
                        poly: full,
                        plane16: [128, 0, 0],
                        underside16: null,
                        material: 'plaza',
                        walk: true,
                        basin: null,
                        route: 'terrace',
                    },
                ],
            },
            {
                tile: tOverlap,
                surfaces: [
                    {
                        id: 0,
                        kind: 'floor',
                        poly: full,
                        plane16: [0, 0, 0],
                        underside16: null,
                        material: 'road',
                        walk: true,
                        basin: null,
                        route: 'ground',
                        legacy: true,
                    },
                    {
                        id: 2,
                        kind: 'floor',
                        poly: full,
                        plane16: [128, 0, 0],
                        underside16: 96,
                        material: 'timber',
                        walk: true,
                        basin: null,
                        route: 'bridge',
                    },
                ],
            },
            {
                tile: tQuay,
                surfaces: [
                    {
                        id: 0,
                        kind: 'floor',
                        poly: full,
                        plane16: [0, 0, 0],
                        underside16: null,
                        material: 'ashlar',
                        walk: true,
                        basin: null,
                        route: 'ground',
                        legacy: true,
                    },
                ],
            },
            {
                tile: tLagoon,
                surfaces: [
                    {
                        id: 1,
                        kind: 'water',
                        poly: full,
                        plane16: [112, 0, 0],
                        underside16: null,
                        material: 'shallowWater',
                        walk: false,
                        basin: 2,
                    },
                ],
            },
            {
                tile: tCanal,
                surfaces: [
                    {
                        id: 1,
                        kind: 'water',
                        poly: full,
                        plane16: [-16, 0, 0],
                        underside16: null,
                        material: 'shallowWater',
                        walk: false,
                        basin: 1,
                    },
                ],
            },
        ],
        banks: [
            {
                top: [tTerraceW, 2],
                water: [tLagoon, 1],
                edge: [[0, 256], [256, 256]],
                lip16: 128,
                material: 'ashlar',
                style: 'terrace-sluice',
                foam: false,
            },
            {
                top: [tQuay, 0],
                water: [tCanal, 1],
                edge: [[256, 0], [256, 256]],
                lip16: 64,
                material: 'ashlar',
                style: 'forge-moss',
                foam: true,
            },
        ],
        footings: [
            {
                landmark: 'command',
                support: [tTerraceE, 2],
                poly: [[0, 0], [192, 0], [192, 128], [0, 128]],
                courses16: [16, 32],
                material: 'ashlar',
                orientation: 'SE',
            },
        ],
        links: [
            // Approach road (9,10) edge 1 (east) <-> stair (10,10) edge 3 (west), both H=0
            { from: [tApproach, 0], to: [tStair, 3], fromEdge: 1, toEdge: 3, bidirectional: true },
            // Stair (10,10) edge 1 (east) <-> terrace landing (11,10) edge 3 (west), both H=+8
            { from: [tStair, 3], to: [tTerraceW, 2], fromEdge: 1, toEdge: 3, bidirectional: true },
            // Terrace landing (11,10) edge 1 <-> keep pad (12,10) edge 3, both H=+8
            { from: [tTerraceW, 2], to: [tTerraceE, 2], fromEdge: 1, toEdge: 3, bidirectional: true },
            // Approach road (9,10) edge 2 (south) <-> underpass ground (9,11) edge 0 (north), both H=0
            { from: [tApproach, 0], to: [tOverlap, 0], fromEdge: 2, toEdge: 0, bidirectional: true },
        ],
        spills: [
            {
                id: 'lagoon-canal-spillway',
                upper: [tLagoon, 1],
                lower: [tCanal, 1],
                edge: [[0, 256], [256, 256]],
                frames: 4,
            },
        ],
    };
}
