#!/usr/bin/env node
// The Village Gate's gatehouse and the east wall's sea tower, authored at art
// resolution (scale 1: one texel per world px) by an orthographic ray cast of
// a handful of solids in the town's own 2:1 projection.
//
// Every texel is a palette stop: the masonry is the landmarks' own ashlar
// (ART_RAMPS.ashlar, shared with the curtain wall), the roofs the Command
// dome's slate, the doors ART_RAMPS.timber and the sign's letters Press
// Start 2P (the chrome's display face) at 1 texel per font px. Light is the
// baked upper-left key: SW-facing faces lit, SE-facing faces in shade, tops
// lit, one ashlar stop per block (per-block jitter, a bevel row on each
// block's top, joints one stop down), hard cast shadows from the solids
// themselves, a 1-px ink outline on the outer silhouette and a crevice line
// wherever a nearer surface overlaps a farther one. No ground is baked: the
// ground bake owns yards and contact.
//
// Outputs (claudeville/assets/sprites/props/):
//   prop.villageGate.png            gatehouse: two round towers, the arch
//                                   block, its parapet and the CLAUDEVILLE sign
//   prop.villageGate.emissive.png   the towers' lamp-room glass (fixtures)
//   prop.villageGate.occluder.png   2.3 surface channel (R height, G strength,
//                                   B face*64 + min(63, round(h / 4)))
//   prop.villageGateDoors.png       2-frame strip: doors shut, doors open
//   prop.villageGateDoors.occluder.png
//   prop.villageWallSeaTower.png    (+ .emissive.png, .occluder.png)
//
// Usage:
//   node scripts/sprites/bake-village-gate.mjs            write the PNGs
//   node scripts/sprites/bake-village-gate.mjs --check    verify on-disk bytes
//   node scripts/sprites/bake-village-gate.mjs --preview <dir>   4x previews
// The printed geometry (width, height, anchor, frame size) is what
// manifest.yaml declares for each id.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { ART_RAMPS } from '../../claudeville/src/config/artPalette.js';
import { VILLAGE_GATE_GEOMETRY, SEA_TOWER_GEOMETRY } from '../../claudeville/src/config/townPlan.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../..');
const PROPS = join(repoRoot, 'claudeville/assets/sprites/props');

// ---------------------------------------------------------------- palette
const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const ASHLAR = ART_RAMPS.ashlar.map(hex);
const INK = ASHLAR[0];
const CREVICE = ASHLAR[1];
// The Command dome's slate, dark -> light (joint, shade, body, lit, glint).
const SLATE = ART_RAMPS.domeSlate.map(hex);
const TIMBER = ART_RAMPS.timber.map(hex);
const GOLD = ART_RAMPS.trimGold.map(hex);
const MOSS = [...ART_RAMPS.grass.slice(0, 3), ...ART_RAMPS.foliage.slice(1, 4)].map(hex);
const GLASS = [hex(ART_RAMPS.slate[1]), hex(ART_RAMPS.slate[3])];
const EMIT = ART_RAMPS.emissive.map(hex);
const IRON = [hex(ART_RAMPS.slate[0]), hex(ART_RAMPS.stone[1]), hex(ART_RAMPS.stone[2])];
const SEAWEED = [hex(ART_RAMPS.foliage[0]), hex(ART_RAMPS.foliage[1])];
const EMIT_ALPHA = 160;

// ------------------------------------------------------------- projection
// Tiles X, Y (tileX, tileY), Z world px up. Screen: sx = 32 (X - Y),
// sy = 16 (X + Y) - Z. The solids live in true units (a 2:1 dimetric camera
// at 30 degrees): a tile is 32 * sqrt(2) long, a Z px 2 / sqrt(3).
const TU = 32 * Math.SQRT2;
const ZU = 2 / Math.sqrt(3);
// Toward the camera per unit of s = X + Y along a pixel's ray.
const RAY = [TU / 2, TU / 2, 16 * ZU];
const RAY_LEN = Math.hypot(...RAY);
// Upper-left key: from screen-left (world -X +Y) and above.
const KEY = (() => { const v = [-0.55, 1, 1.05]; const l = Math.hypot(...v); return v.map((c) => c / l); })();

const hash = (a, b = 0, c = 0) => {
    let h = Math.imul(a | 0, 374761393) ^ Math.imul(b | 0, 668265263) ^ Math.imul(c | 0, 1274126177);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};

// ------------------------------------------------------------------- SDFs
// All in true units; p = [x, y, z].
const len2 = (x, y) => Math.hypot(x, y);
function sdBox(p, c, h) {
    const qx = Math.abs(p[0] - c[0]) - h[0];
    const qy = Math.abs(p[1] - c[1]) - h[1];
    const qz = Math.abs(p[2] - c[2]) - h[2];
    return Math.hypot(Math.max(qx, 0), Math.max(qy, 0), Math.max(qz, 0)) + Math.min(Math.max(qx, qy, qz), 0);
}
function sdCyl(p, cx, cy, r, z0, z1) {
    const d0 = len2(p[0] - cx, p[1] - cy) - r;
    const hz = (z1 - z0) / 2;
    const d1 = Math.abs(p[2] - (z0 + hz)) - hz;
    return Math.min(Math.max(d0, d1), 0) + Math.hypot(Math.max(d0, 0), Math.max(d1, 0));
}
// Capped cone: radius r0 at z0, r1 at z1 (iq's sdCappedCone).
function sdCone(p, cx, cy, r0, z0, z1, r1 = 0) {
    const h = (z1 - z0) / 2;
    const qx = len2(p[0] - cx, p[1] - cy);
    const qy = p[2] - (z0 + h);
    const k1x = r1; const k1y = h;
    const k2x = r1 - r0; const k2y = 2 * h;
    const cax = qx - Math.min(qx, qy < 0 ? r0 : r1);
    const cay = Math.abs(qy) - h;
    const t = Math.max(0, Math.min(1, ((k1x - qx) * k2x + (k1y - qy) * k2y) / (k2x * k2x + k2y * k2y)));
    const cbx = qx - k1x + k2x * t;
    const cby = qy - k1y + k2y * t;
    const s = cbx < 0 && cay < 0 ? -1 : 1;
    return s * Math.sqrt(Math.min(cax * cax + cay * cay, cbx * cbx + cby * cby));
}
function sdSphere(p, c, r) { return Math.hypot(p[0] - c[0], p[1] - c[1], p[2] - c[2]) - r; }
function sdEllipsoid(p, c, r) {
    const x = (p[0] - c[0]) / r[0]; const y = (p[1] - c[1]) / r[1]; const z = (p[2] - c[2]) / r[2];
    const k0 = Math.hypot(x, y, z);
    const k1 = Math.hypot(x / r[0], y / r[1], z / r[2]);
    return k1 > 0 ? (k0 * (k0 - 1)) / k1 : -Math.min(...r);
}
// Pointed arch opening in the wall plane (x along the wall, z up; true
// units), extruded through y in [y0, y1]: jambs at |x| = w below the spring,
// two arcs of radius R = rise * w meeting at the apex.
function sdArch2(x, z, w, spring, rise) {
    const R = rise * w;
    const rect = Math.max(Math.abs(x) - w, z - spring);
    const dl = Math.hypot(x - (R - w), z - spring) - R;
    const dr = Math.hypot(x + (R - w), z - spring) - R;
    // The arcs reach below the spring so the two parts overlap: a union's
    // min() reads 0 on a shared boundary, which the ray would stop at.
    const pointed = Math.max(Math.max(dl, dr), spring - 6 - z);
    return Math.min(rect, pointed);
}

// World (tiles, px) <-> true units.
const T = (X, Y, Z) => [X * TU, Y * TU, Z * ZU];

// ---------------------------------------------------------------- solids
// A solid: { id, kind, sdf(p), ...paint params }. The painter picks the
// solid nearest the hit and paints by its kind.
function gatehouseSolids(G, { doors = null } = {}) {
    const s = [];
    const Yf = G.blockHalfDepth;
    const [xw, xe] = G.towerX;
    const bx = (xw + xe) / 2;
    const bh = (xe - xw) / 2;
    const arch = (p) => sdArch2(p[0], p[2], G.archHalfWidth * TU, G.archSpring * ZU, G.archRise);
    const archCut = (p, d) => Math.max(d, -Math.max(arch(p), Math.abs(p[1]) - (Yf + 0.3) * TU));
    // The arch block, its battered plinth and the string course.
    s.push({ id: 'block', kind: 'ashlar', plane: true, z0: G.plinthTop, course: 6,
        sdf: (p) => archCut(p, sdBox(p, T(bx, 0, G.blockTop / 2), [bh * TU, Yf * TU, (G.blockTop / 2) * ZU])) });
    s.push({ id: 'plinth', kind: 'ashlar', plane: true, z0: 0, course: 5, plinth: true,
        sdf: (p) => archCut(p, sdBox(p, T(bx, 0, G.plinthTop / 2), [bh * TU, (Yf + G.plinthOut) * TU, (G.plinthTop / 2) * ZU])) });
    s.push({ id: 'string', kind: 'band', band: G.stringZ,
        sdf: (p) => sdBox(p, T(bx, 0, (G.stringZ[0] + G.stringZ[1]) / 2), [bh * TU, (Yf + G.stringOut) * TU, ((G.stringZ[1] - G.stringZ[0]) / 2) * ZU]) });
    // Parapet: merlons on the outer lip, a low rail on the inner one.
    const mw = G.merlon.width / 32;
    const cw = G.merlon.gap / 32;
    const md = G.merlon.depth / 32;
    const mz0 = G.blockTop;
    const mz1 = G.blockTop + G.merlon.height;
    const merlonAt = (x) => {
        const period = mw + cw;
        const k = Math.round(x / period);
        return { k, cx: k * period };
    };
    s.push({ id: 'merlons', kind: 'merlon',
        sdf: (p) => {
            const X = p[0] / TU;
            const { cx } = merlonAt(X);
            const box = sdBox(p, T(cx, Yf - md / 2, (mz0 + mz1) / 2), [(mw / 2) * TU, (md / 2) * TU, ((mz1 - mz0) / 2) * ZU]);
            return Math.max(box, Math.abs(p[0] - bx * TU) - (bh - 0.2) * TU);
        } });
    s.push({ id: 'rail', kind: 'merlon',
        sdf: (p) => sdBox(p, T(bx, -Yf + md / 2, mz0 + G.railHeight / 2), [(bh - 0.2) * TU, (md / 2) * TU, (G.railHeight / 2) * ZU]) });
    // Raised portcullis: its teeth hang in the arch head.
    s.push({ id: 'portcullis', kind: 'iron',
        sdf: (p) => {
            const inArch = arch(p);
            const slab = Math.abs(p[1] - (Yf - 0.08) * TU) - 0.02 * TU;
            const low = G.portcullisBottom * ZU - p[2];
            return Math.max(slab, Math.max(inArch, low));
        } });
    for (const [k, cx] of G.towerX.entries()) {
        const side = k ? 1 : -1;
        const r = G.towerR;
        s.push({ id: `tower${side}`, kind: 'ashlar', cyl: { cx, cy: 0, r }, z0: G.plinthTop, course: 6, windows: G.towerWindows,
            sdf: (p) => sdCyl(p, cx * TU, 0, r * TU, G.plinthTop * ZU, G.corbelZ[1] * ZU) });
        s.push({ id: `towerPlinth${side}`, kind: 'ashlar', cyl: { cx, cy: 0, r: r + G.plinthOut }, z0: 0, course: 5, plinth: true,
            sdf: (p) => Math.min(
                sdCyl(p, cx * TU, 0, (r + G.plinthOut) * TU, 0, (G.plinthTop / 2) * ZU),
                sdCyl(p, cx * TU, 0, (r + G.plinthOut / 2) * TU, 0, G.plinthTop * ZU)) });
        // Corbels under the machicolation ring.
        const corbels = G.corbels;
        s.push({ id: `corbels${side}`, kind: 'corbel', cyl: { cx, cy: 0, r: r + G.ringOut },
            sdf: (p) => {
                const ang = Math.atan2(p[1], p[0] - cx * TU);
                const per = (Math.PI * 2) / corbels;
                const a = ((ang % per) + per) % per - per / 2;
                const arc = Math.abs(a) * (r + G.ringOut) * TU - 0.045 * TU;
                const ring = sdCyl(p, cx * TU, 0, (r + G.ringOut) * TU, G.corbelZ[0] * ZU, G.corbelZ[1] * ZU);
                return Math.max(ring, arc);
            } });
        s.push({ id: `ring${side}`, kind: 'band', band: [G.corbelZ[1], G.ringTop], cyl: { cx, cy: 0, r: r + G.ringOut },
            sdf: (p) => sdCyl(p, cx * TU, 0, (r + G.ringOut) * TU, G.corbelZ[1] * ZU, G.ringTop * ZU) });
        s.push({ id: `roof${side}`, kind: 'roof', cone: { cx, cy: 0, r0: r + G.eaveOut, z0: G.ringTop, z1: G.roofApex },
            sdf: (p) => sdCone(p, cx * TU, 0, (r + G.eaveOut) * TU, G.ringTop * ZU, G.roofApex * ZU) });
        s.push({ id: `finial${side}`, kind: 'gold',
            sdf: (p) => Math.min(
                sdCyl(p, cx * TU, 0, 0.022 * TU, (G.roofApex - 6) * ZU, (G.roofApex + 9) * ZU),
                sdSphere(p, T(cx, 0, G.roofApex + 5), 0.055 * TU)) });
    }
    if (doors) {
        const w = G.archHalfWidth;
        const y = G.doorY;
        const th = 0.035;
        if (doors === 'shut') {
            s.push({ id: 'doors', kind: 'door', door: true,
                sdf: (p) => Math.max(sdBox(p, T(0, y, 40), [w * TU, th * TU, 40 * ZU]), arch(p)) });
        } else {
            for (const side of [-1, 1]) {
                const hx = side * (w - th);
                // Swung in and folded flat against the passage's side walls:
                // no leaf reaches past the block's back face, so the way
                // through stays open to the eye.
                const yf = G.blockHalfDepth - 0.02;
                s.push({ id: `door${side}`, kind: 'door', door: true, open: side,
                    sdf: (p) => Math.max(sdBox(p, T(hx, 0, 40), [th * TU, yf * TU, 40 * ZU]), arch(p)) });
            }
        }
    }
    return s;
}

function seaTowerSolids(S) {
    const s = [];
    const r = S.towerR;
    s.push({ id: 'tower', kind: 'ashlar', cyl: { cx: 0, cy: 0, r }, z0: S.plinthTop, course: 6, windows: S.windows,
        sdf: (p) => sdCyl(p, 0, 0, r * TU, S.plinthTop * ZU, S.corbelZ[1] * ZU) });
    s.push({ id: 'towerPlinth', kind: 'ashlar', cyl: { cx: 0, cy: 0, r: r + S.plinthOut }, z0: 0, course: 5, plinth: true,
        sdf: (p) => Math.min(
            sdCyl(p, 0, 0, (r + S.plinthOut) * TU, 0, (S.plinthTop / 2) * ZU),
            sdCyl(p, 0, 0, (r + S.plinthOut / 2) * TU, 0, S.plinthTop * ZU)) });
    s.push({ id: 'corbels', kind: 'corbel', cyl: { cx: 0, cy: 0, r: r + S.ringOut },
        sdf: (p) => {
            const ang = Math.atan2(p[1], p[0]);
            const per = (Math.PI * 2) / S.corbels;
            const a = ((ang % per) + per) % per - per / 2;
            const arc = Math.abs(a) * (r + S.ringOut) * TU - 0.045 * TU;
            return Math.max(sdCyl(p, 0, 0, (r + S.ringOut) * TU, S.corbelZ[0] * ZU, S.corbelZ[1] * ZU), arc);
        } });
    // The gallery: a crenellated ring round the lamp room.
    s.push({ id: 'gallery', kind: 'band', band: [S.corbelZ[1], S.galleryFloor], cyl: { cx: 0, cy: 0, r: r + S.ringOut },
        sdf: (p) => sdCyl(p, 0, 0, (r + S.ringOut) * TU, S.corbelZ[1] * ZU, S.galleryFloor * ZU) });
    s.push({ id: 'galleryMerlons', kind: 'merlon', cyl: { cx: 0, cy: 0, r: r + S.ringOut },
        sdf: (p) => {
            const ang = Math.atan2(p[1], p[0]);
            const per = (Math.PI * 2) / S.merlons;
            const a = ((ang % per) + per) % per - per / 2;
            const arc = Math.abs(a) * (r + S.ringOut) * TU - (S.merlonShare * per / 2) * (r + S.ringOut) * TU;
            const shell = Math.max(sdCyl(p, 0, 0, (r + S.ringOut) * TU, S.galleryFloor * ZU, (S.galleryFloor + S.merlonHeight) * ZU),
                -(len2(p[0], p[1]) - (r + S.ringOut - 0.07) * TU));
            return Math.max(shell, arc);
        } });
    // Lamp room: a narrower drum glazed all round.
    s.push({ id: 'lamproom', kind: 'ashlar', cyl: { cx: 0, cy: 0, r: S.lampR }, z0: S.galleryFloor, course: 6, lamp: S.lampWindows,
        sdf: (p) => sdCyl(p, 0, 0, S.lampR * TU, S.galleryFloor * ZU, S.eaveZ * ZU) });
    s.push({ id: 'roof', kind: 'roof', cone: { cx: 0, cy: 0, r0: S.lampR + S.eaveOut, z0: S.eaveZ, z1: S.roofApex },
        sdf: (p) => sdCone(p, 0, 0, (S.lampR + S.eaveOut) * TU, S.eaveZ * ZU, S.roofApex * ZU) });
    s.push({ id: 'finial', kind: 'gold',
        sdf: (p) => Math.min(
            sdCyl(p, 0, 0, 0.022 * TU, (S.roofApex - 6) * ZU, (S.roofApex + 10) * ZU),
            sdSphere(p, T(0, 0, S.roofApex + 6), 0.06 * TU)) });
    // The rock the tower stands on, half in the sea.
    for (const [i, rock] of S.rocks.entries()) {
        s.push({ id: `rock${i}`, kind: 'rock', rock: i,
            // A faceted boulder: its ellipsoid cut by seven planes (sky-facing
            // mostly), so the key lands on flat facets, not a smooth dome.
            sdf: (() => {
                const c = T(rock.x, rock.y, rock.z);
                const planes = Array.from({ length: 7 }, (_, k) => {
                    const az = hash(i, k, 3) * Math.PI * 2;
                    const el = 0.15 + hash(i, k, 5) * 1.1;
                    const nx = Math.cos(az) * Math.cos(el);
                    const ny = Math.sin(az) * Math.cos(el);
                    const nz = Math.sin(el);
                    // Offset: the ellipsoid's support along n, pulled in.
                    const sup = Math.hypot(nx * rock.rx * TU, ny * rock.ry * TU, nz * rock.rz * ZU);
                    return [nx, ny, nz, sup * (0.72 + hash(i, k, 7) * 0.18)];
                });
                return (p) => {
                    let d = sdEllipsoid(p, c, [rock.rx * TU, rock.ry * TU, rock.rz * ZU]);
                    for (const [nx, ny, nz, off] of planes) d = Math.max(d, (p[0] - c[0]) * nx + (p[1] - c[1]) * ny + (p[2] - c[2]) * nz - off);
                    return Math.max(d, -p[2]);
                };
            })() });
    }
    return s;
}

// ------------------------------------------------------------- ray cast
function sceneSdf(solids, p) {
    let d = Infinity;
    for (const solid of solids) d = Math.min(d, solid.sdf(p));
    return d;
}
function nearestSolid(solids, p) {
    let best = null;
    let bd = Infinity;
    for (const solid of solids) {
        const d = Math.abs(solid.sdf(p));
        if (d < bd) { bd = d; best = solid; }
    }
    return best;
}
function normalAt(solid, p) {
    const e = 0.05;
    const f = (dx, dy, dz) => solid.sdf([p[0] + dx, p[1] + dy, p[2] + dz]);
    const n = [f(e, 0, 0) - f(-e, 0, 0), f(0, e, 0) - f(0, -e, 0), f(0, 0, e) - f(0, 0, -e)];
    const l = Math.hypot(...n) || 1;
    return n.map((c) => c / l);
}
// First hit along the pixel's ray from the camera: s from high to low.
function castPixel(solids, sx, sy, zTop) {
    const a = sx / 32;
    let s = (zTop + sy) / 16;
    const sEnd = (sy - 12) / 16;
    for (let i = 0; i < 600 && s > sEnd; i++) {
        const X = (s + a) / 2;
        const Y = (s - a) / 2;
        const Z = 16 * s - sy;
        const p = [X * TU, Y * TU, Z * ZU];
        const d = sceneSdf(solids, p);
        if (d < 0.02) return { s, X, Y, Z, p };
        // 0.7: the rocks' lumps make their field steeper than a distance.
        s -= Math.max(0.004, (0.7 * d) / RAY_LEN);
    }
    return null;
}
function inShadow(solids, p, n) {
    let t = 0.8;
    for (let i = 0; i < 120 && t < 260; i++) {
        const q = [p[0] + n[0] * 0.35 + KEY[0] * t, p[1] + n[1] * 0.35 + KEY[1] * t, p[2] + n[2] * 0.35 + KEY[2] * t];
        if (q[2] > 400) return false;
        const d = sceneSdf(solids, q);
        if (d < 0.05) return true;
        t += Math.max(0.25, d);
    }
    return false;
}

// -------------------------------------------------------------- painting
const clampIdx = (i, lo, hi) => Math.max(lo, Math.min(hi, i));
function lambert(n) { return Math.max(0, n[0] * KEY[0] + n[1] * KEY[1] + n[2] * KEY[2]); }
// Ashlar stop for a wall normal, the curtain's mapping (VillageWall): the
// SW face 5, turning through 4 at the camera to 3 on the SE face and 2 on
// a drum's far edge.
function wallStop(n) {
    const b = Math.min(1, lambert(n) / 0.62);
    if (n[2] < 0.5 && (n[0] - n[1]) / Math.SQRT2 > 0.88) return 2;
    return 3 + Math.round(b * 2);
}

// Coursed blocks along u (px) and z (px). Returns { course, block, u0, u1, row, joint }.
function blockAt(u, z, z0, courseH, seed) {
    const course = Math.floor((z - z0) / courseH);
    const row = (z - z0) - course * courseH; // 0 = bottom row
    const cell = 13;
    const off = hash(course, seed, 11) * cell;
    let k = Math.floor((u - off) / cell);
    const edge = (j) => off + j * cell + Math.round((hash(course, j, seed) - 0.5) * 7);
    if (u < edge(k)) k -= 1;
    else if (u >= edge(k + 1)) k += 1;
    const u0 = edge(k);
    const u1 = edge(k + 1);
    return { course, block: k, u0, u1, row, joint: row < 1 || u - u0 < 1 };
}

function paintAshlar(solid, hit, n, sx, ctx) {
    const { Z } = hit;
    let u;
    let blockNormal = n;
    if (solid.cyl) {
        const ang = Math.atan2(hit.Y - solid.cyl.cy, hit.X - solid.cyl.cx);
        u = ang * solid.cyl.r * TU;
        const b = blockAt(u, Z, solid.z0, solid.course, solid.id.length * 7 + (solid.cyl.cx > 0 ? 3 : 0));
        const mid = ((b.u0 + b.u1) / 2) / (solid.cyl.r * TU);
        blockNormal = [Math.cos(mid), Math.sin(mid), 0];
    } else {
        u = sx + (n[0] > 0.5 ? 400 : 0);
    }
    const top = n[2] > 0.7;
    if (top) {
        // A plinth's ledge is the lit lip; a walk or merlon top lies in
        // flags lit by the key, joints every 9 px.
        if (solid.plinth) return ASHLAR[8];
        const f = blockAt(sx + 2 * (hit.X + hit.Y) * 16, hit.Y * 64, 0, 9, 5);
        let stop = 8 - (hash(f.course, f.block, 3) < 0.4 ? 1 : 0);
        if (f.joint) stop = 6;
        return mossy(ASHLAR[stop], hit, sx, 0.2);
    }
    const b = blockAt(u, Z, solid.z0, solid.course, solid.id.length * 7 + (solid.cyl?.cx > 0 ? 3 : 0));
    const base = wallStop(blockNormal);
    let stop = base;
    const j = hash(b.course, b.block, 29);
    if (j < 0.15) stop -= 1; else if (j > 0.85) stop += 1;
    stop = solid.plinth ? clampIdx(base - 1, 3, 4) : clampIdx(stop, 2, 6);
    let px;
    if (b.joint) px = ASHLAR[solid.plinth ? 2 : clampIdx(stop >= 4 ? stop - 2 : stop - 1, 1, 4)];
    else if (b.row >= solid.course - 1 && hash(b.course, b.block, 37) < 0.5) px = ASHLAR[stop + 1];
    else px = ASHLAR[stop];
    // Weathering: a few blocks carry a crevice speck.
    if (!b.joint && hash(b.course, b.block, 71) < 0.08 && hash(Math.floor(u), Math.floor(Z), 5) < 0.18) px = ASHLAR[clampIdx(stop - 2, 1, 4)];
    // Moss creeps up the plinth and the lowest courses' joints.
    const mossReach = solid.plinth ? 0.32 : Z < solid.z0 + 8 ? 0.12 : 0;
    if (mossReach) px = mossy(px, hit, sx, mossReach, b.joint);
    return px;
}

// Moss in clumps (4 x 3 px cells), lit on its upper rows.
function mossy(px, hit, sx, reach, joint = false) {
    const cx = Math.floor(sx / 4);
    const cz = Math.floor(hit.Z / 3);
    if (hash(cx, cz, 91) >= reach * (joint ? 1.3 : 1)) return px;
    const fx = Math.floor(sx);
    const fz = Math.floor(hit.Z);
    // Ragged clump edge.
    const edge = fx - cx * 4 === 0 || fx - cx * 4 === 3;
    if (edge && hash(fx, fz, 17) < 0.5) return px;
    const top = fz - cz * 3 === 2;
    return MOSS[top ? 2 : hash(fx, fz, 23) < 0.5 ? 1 : 0];
}

// A string course or ring: its top row the lit lip, its bottom row the
// shadow under the projection.
function paintBand(solid, hit, n) {
    if (n[2] > 0.7) return ASHLAR[8];
    const stop = wallStop(n);
    const [z0, z1] = solid.band;
    if (hit.Z >= z1 - 1) return ASHLAR[stop >= 4 ? 8 : stop + 2];
    if (hit.Z < z0 + 1) return ASHLAR[clampIdx(stop - 2, 1, 5)];
    return ASHLAR[clampIdx(stop + 1, 3, 8)];
}

function paintRoof(solid, hit, n) {
    const { cx, cy, r0, z0, z1 } = solid.cone;
    const ang = Math.atan2(hit.Y - cy, hit.X - cx);
    const t = (hit.Z - z0) / (z1 - z0); // 0 eave -> 1 apex
    const courseH = 4;
    const course = Math.floor((hit.Z - z0) / courseH);
    const row = (hit.Z - z0) - course * courseH;
    const radius = Math.max(0.05, r0 * (1 - t));
    const u = ang * radius * TU;
    const tile = 6;
    const off = (course % 2) * (tile / 2);
    const k = Math.floor((u + off) / tile);
    const du = (u + off) - k * tile;
    const l = lambert(n);
    let stop = clampIdx(1 + Math.round((l / 0.75) * 3.2), 1, 4);
    const j = hash(course, k, 41);
    if (j < 0.18) stop -= 1; else if (j > 0.88) stop += 1;
    stop = clampIdx(stop, 1, 4);
    // Scalloped lower lip of each course, a joint between slates.
    if (row < 1 || (du < 1 && row < courseH - 1)) return SLATE[clampIdx(stop - 2, 0, 2)];
    if (row >= courseH - 1 && stop >= 3) return SLATE[Math.min(5, stop + 1)];
    return SLATE[stop];
}

function paintGold(n) {
    const l = lambert(n);
    return GOLD[l > 0.55 ? 3 : l > 0.25 ? 2 : l > 0.05 ? 1 : 0];
}

// Sea rock: faceted by the key in 3-px cells (lit tops 6-7, flanks 3-5),
// a wet dark band and weed at the waterline, lichen on the lit tops.
function paintRock(solid, hit, n, sx) {
    const l = lambert(n);
    let stop = clampIdx(2 + Math.round((l / 0.7) * 4), 2, 6);
    const facet = hash(Math.floor(sx / 3), Math.floor(hit.Z / 3), 31 + solid.rock);
    if (facet < 0.2) stop -= 1; else if (facet > 0.85) stop += 1;
    stop = clampIdx(stop, 2, 7);
    if (hit.Z < 1.5) return hash(Math.floor(sx / 2), 7, solid.rock) < 0.5 ? SEAWEED[0] : ASHLAR[2];
    if (hit.Z < 3) return hash(Math.floor(sx / 3), 9, solid.rock) < 0.4 ? SEAWEED[1] : ASHLAR[clampIdx(stop - 2, 2, 4)];
    if (n[2] > 0.55 && hash(Math.floor(sx / 2), Math.floor(hit.Z / 2), 3 + solid.rock) < 0.18) return MOSS[4];
    return ASHLAR[stop];
}

function paintIron(hit, sx) {
    // A lattice: bars every 5 px, rails every 6 px; points at the bottom.
    const bar = ((Math.floor(sx) % 5) + 5) % 5 === 0;
    const rail = Math.floor(hit.Z) % 6 === 0;
    if (bar || rail) return IRON[bar && rail ? 2 : 1];
    return null; // open: see through
}

// Door leaves: vertical planks (4 px), two iron straps with studs, the
// meeting seam and a ring pull either side of it; an open leaf shows its
// edge-on face in shade.
function paintDoor(solid, hit, n, sx) {
    const l = lambert(n);
    let stop = clampIdx(1 + Math.round((l / 0.6) * 2), 1, 3);
    if (solid.open) stop = solid.open < 0 ? 2 : 1;
    const col = ((Math.floor(sx) % 4) + 4) % 4;
    const z = Math.floor(hit.Z);
    if (!solid.open && Math.abs(hit.X) < 0.025) return TIMBER[0];
    if (z === 11 || z === 35) return col === 2 ? IRON[2] : IRON[1];
    if (z === 10 || z === 34) return IRON[0];
    if (!solid.open && z === 23 && Math.abs(Math.abs(hit.X) - 0.07) < 0.03) return IRON[2];
    if (col === 0) return TIMBER[Math.max(0, stop - 1)];
    if (col === 1 && stop < 3) return TIMBER[stop + 1];
    return TIMBER[stop];
}

// Arch dressing on the block's face: voussoirs round the head, quoined
// jambs, the sign plaque. Returns a colour or null (plain ashlar).
function paintArchFace(G, hit, n, sx, sy, glyphs) {
    if (n[1] < 0.9) return null;
    const x = hit.X * TU;
    const z = hit.Z * ZU;
    const w = G.archHalfWidth * TU;
    const d = sdArch2(x, z, w, G.archSpring * ZU, G.archRise);
    const ring = G.voussoirDepth * ZU;
    const ref = wallStop(n);
    if (d > 0 && d < ring && hit.Z > G.archSpring - 1) {
        // Voussoirs: radial joints about the arch's centre line.
        const ang = Math.atan2(z - G.archSpring * ZU, x);
        const k = Math.round(ang / (Math.PI / G.voussoirs));
        const key = k === Math.round(G.voussoirs / 2);
        const dang = Math.abs(ang - k * (Math.PI / G.voussoirs)) * Math.hypot(x, z - G.archSpring * ZU);
        if (dang > (Math.PI / G.voussoirs) * Math.hypot(x, z - G.archSpring * ZU) / 2 - 1.1) return ASHLAR[ref - 2];
        if (d > ring - 1.2) return ASHLAR[ref - 2];
        if (d < 1.2) return ASHLAR[1];
        return ASHLAR[clampIdx(ref + (key ? 2 : 1), 2, 8)];
    }
    if (d > 0 && d < ring - 2 && hit.Z <= G.archSpring - 1) {
        // Quoins: long and short blocks up each jamb.
        const course = Math.floor((hit.Z - G.plinthTop) / 6);
        const reach = course % 2 ? ring - 2 : ring * 0.6;
        if (d > reach) return null;
        const row = (hit.Z - G.plinthTop) - course * 6;
        if (row < 1 || d > reach - 1.2) return ASHLAR[ref - 2];
        if (d < 1.2) return ASHLAR[1];
        return ASHLAR[clampIdx(ref + 1, 2, 8)];
    }
    // The sign plaque, centred on the block's face over the arch. Its frame
    // lies in the wall (it steps down the 2:1 slope); each letter stands
    // upright in its own 8-px cell, the cell dropping 4 px per letter with
    // the plaque, so no stroke of the chrome's face is ever sheared.
    const P = G.sign;
    const Yp = 32 * G.blockHalfDepth;
    const faceX = Math.floor(sx) + Math.round(Yp); // px from the arch's centre line
    const halfW = Math.ceil(glyphs.width / 2) + 2;
    if (faceX >= -halfW && faceX <= halfW && hit.Z >= P.z0 && hit.Z < P.z1) {
        const gx = faceX + halfW;
        const gz = Math.floor(P.z1 - hit.Z); // rows from the plaque top
        const W = halfW * 2;
        const H = P.z1 - P.z0;
        if (gz === 0 || gx === 0) return GOLD[3];
        if (gz === H - 1 || gx === W) return GOLD[0];
        const runLeft = -glyphs.inkLeft - Math.floor(glyphs.width / 2);
        const letterAt = (fx, py) => {
            const runCol = fx - runLeft;
            const k = Math.floor(runCol / 8);
            const rows = glyphs.letters[k];
            if (!rows) return false;
            const col = runCol - 8 * k;
            const centreSx = runLeft + 8 * k + 4 - Yp;
            const rowTop = Math.floor(centreSx / 2 + Yp - P.z1) + P.textTop;
            const row = py - rowTop;
            return row >= 0 && row < 7 && rows[row][col];
        };
        const py = Math.floor(sy);
        if (letterAt(faceX, py)) {
            if (!letterAt(faceX, py - 1)) return GOLD[3];
            if (!letterAt(faceX, py + 1)) return GOLD[1];
            return GOLD[2];
        }
        if (letterAt(faceX - 1, py - 1)) return hex(P.fieldShadow);
        return hex(P.field);
    }
    return null;
}

// Tower windows on a cylinder: returns { albedo, emit } or null.
function paintWindow(solid, hit, n) {
    const list = solid.windows || solid.lamp;
    if (!list || !solid.cyl) return null;
    const ang = Math.atan2(hit.Y - solid.cyl.cy, hit.X - solid.cyl.cx);
    const u = ang * solid.cyl.r * TU;
    for (const win of list) {
        const cu = win.angle * solid.cyl.r * TU;
        const du = u - cu;
        const half = win.width / 2;
        const top = win.z1 - (Math.abs(du) > half - 1.5 ? 0 : 0);
        // Pointed head: the top shrinks toward the edges.
        const headZ = win.z1 - Math.max(0, Math.abs(du)) * (win.pointed ? 1 : 0);
        if (Math.abs(du) > half + 1 || hit.Z < win.z0 - 1 || hit.Z > headZ + 1) continue;
        void top;
        const inside = Math.abs(du) <= half - 1 && hit.Z >= win.z0 && hit.Z <= headZ - 1;
        if (!inside) return { albedo: ASHLAR[1], emit: null, frame: true };
        if (!win.lit) return { albedo: ASHLAR[0], emit: null };
        const rim = Math.abs(du) > half - 2 || hit.Z < win.z0 + 1 || hit.Z > headZ - 2;
        const glint = du < -half + 2.5 && hit.Z > headZ - 3.5;
        const albedo = glint ? GLASS[1] : GLASS[0];
        const core = Math.abs(du) < 1 && hit.Z < win.z0 + 3;
        const emit = rim ? EMIT[0] : core ? EMIT[2] : EMIT[1];
        return { albedo, emit };
    }
    return null;
}

// ------------------------------------------------------------ rendering
function render(solids, { width, height, ax, ay, zTop, glyphs, gate, onlyDoors = false }) {
    const n = width * height;
    const albedo = new Uint8ClampedArray(n * 4);
    const emit = new Uint8ClampedArray(n * 4);
    const occ = new Uint8ClampedArray(n * 4);
    const depth = new Float32Array(n).fill(-Infinity);
    const ids = new Int16Array(n).fill(-1);
    const heights = new Float32Array(n);
    const covered = new Uint8Array(n);
    for (let py = 0; py < height; py++) {
        for (let px = 0; px < width; px++) {
            const sx = px - ax + 0.5;
            const sy = py - ay + 0.5;
            let hit = castPixel(solids, sx, sy, zTop);
            let solid = hit ? nearestSolid(solids, hit.p) : null;
            // The portcullis is a lattice: through its gaps, cast on.
            let guard = 0;
            while (hit && solid?.kind === 'iron' && paintIron(hit, sx) === null && guard++ < 4) {
                const rest = solids.filter((q) => q !== solid);
                hit = castPixel(rest, sx, sy, hit.Z - 0.01);
                solid = hit ? nearestSolid(rest, hit.p) : null;
            }
            if (!hit || !solid) continue;
            covered[py * width + px] = 1;
            if (onlyDoors && !solid.door) continue;
            if (!onlyDoors && solid.door) continue;
            const nrm = normalAt(solid, hit.p);
            let rgb;
            let emitRgb = null;
            switch (solid.kind) {
                case 'ashlar': {
                    const win = paintWindow(solid, hit, nrm);
                    const arch = gate && solid.id === 'block' ? paintArchFace(gate, hit, nrm, sx, sy, glyphs) : null;
                    if (win) { rgb = win.albedo; emitRgb = win.emit; } else rgb = arch || paintAshlar(solid, hit, nrm, sx);
                    break;
                }
                case 'plinth': rgb = paintAshlar(solid, hit, nrm, sx); break;
                case 'band': rgb = paintBand(solid, hit, nrm); break;
                case 'corbel': rgb = ASHLAR[clampIdx(wallStop(nrm) - (nrm[2] < -0.3 ? 2 : 0), 1, 7)]; break;
                case 'merlon': rgb = nrm[2] > 0.7 ? ASHLAR[8] : paintAshlar({ ...solid, z0: 0, course: 6 }, hit, nrm, sx); break;
                case 'roof': rgb = paintRoof(solid, hit, nrm); break;
                case 'gold': rgb = paintGold(nrm); break;
                case 'rock': rgb = paintRock(solid, hit, nrm, sx); break;
                case 'iron': rgb = paintIron(hit, sx) || IRON[0]; break;
                case 'door': rgb = paintDoor(solid, hit, nrm, sx); break;
                default: rgb = ASHLAR[5];
            }
            // Hard cast shadow from the structure itself (never on glass).
            if (!emitRgb && solid.kind !== 'gold' && inShadow(solids, hit.p, nrm)) rgb = shadowOf(rgb, solid.kind);
            const p = py * width + px;
            const i = p * 4;
            albedo.set(rgb, i); albedo[i + 3] = 255;
            if (emitRgb) { emit.set(emitRgb, i); emit[i + 3] = EMIT_ALPHA; }
            depth[p] = hit.s;
            ids[p] = solids.indexOf(solid);
            const h = Math.max(0, Math.min(255, Math.round(hit.Z)));
            heights[p] = hit.Z;
            let face;
            if (solid.kind === 'roof' || solid.kind === 'gold') face = 3;
            else if (nrm[2] > 0.7) face = 0;
            else face = nrm[1] >= nrm[0] ? 1 : 2;
            occ[i] = h; occ[i + 1] = 255; occ[i + 2] = face * 64 + Math.min(63, Math.round(h / 4)); occ[i + 3] = 255;
        }
    }
    // Outline: the outer silhouette in ink; a crevice line on a farther
    // surface wherever a nearer one overlaps it.
    const out = Uint8ClampedArray.from(albedo);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const p = y * width + x;
            if (ids[p] < 0) continue;
            const nb = [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]];
            let edge = false;
            let behind = false;
            for (const [qx, qy] of nb) {
                if (qx < 0 || qy < 0 || qx >= width || qy >= height) { edge = true; continue; }
                const q = qy * width + qx;
                if (!covered[q]) edge = true;
                else if (ids[q] < 0) continue;
                else if (depth[q] > depth[p] + 0.12 && Math.abs(heights[q] - heights[p]) > 2 && solids[ids[q]].kind !== 'iron') behind = true;
            }
            const i = p * 4;
            if (edge) { out.set(INK, i); emit[i + 3] = 0; }
            else if (behind && !emit[i + 3]) out.set(CREVICE, i);
        }
    }
    return { albedo: out, emit, occ, width, height };
}

function shadowOf(rgb, kind) {
    const ramp = kind === 'roof' ? SLATE : kind === 'door' ? TIMBER : ASHLAR;
    let best = 0;
    let bd = Infinity;
    for (let k = 0; k < ramp.length; k++) {
        const d = Math.abs(ramp[k][0] - rgb[0]) + Math.abs(ramp[k][1] - rgb[1]) + Math.abs(ramp[k][2] - rgb[2]);
        if (d < bd) { bd = d; best = k; }
    }
    if (bd > 30) return rgb; // moss, glass: keep
    const drop = kind === 'roof' ? 1 : 2;
    return ramp[Math.max(kind === 'roof' ? 0 : 1, best - drop)];
}

// A cone roof's silhouette in sprite px (for PropWinter's roof polygons):
// the apex, then the eave ellipse from its left tangent round the front to
// its right tangent, one px outside the eave.
function roofPolygon({ cx, cy = 0, r0, z0, z1 }, anchor) {
    const [ax, ay] = anchor;
    const at = (X, Y, Z) => [Math.round(32 * (X - Y) + ax), Math.round(16 * (X + Y) - Z + ay)];
    const out = [at(cx, cy, z1 + 1)];
    const r = r0 + 1.5 / TU;
    for (let k = 0; k <= 12; k++) {
        const a = (3 * Math.PI) / 4 - (k / 12) * Math.PI;
        out.push(at(cx + r * Math.cos(a), cy + r * Math.sin(a), z0 - 1));
    }
    return out;
}

// Crop to the content, keeping the anchor.
function crop(result, ax, ay, pad = 1) {
    const { width, height } = result;
    let x0 = width; let y0 = height; let x1 = -1; let y1 = -1;
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        if (result.albedo[(y * width + x) * 4 + 3]) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
    }
    x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad);
    x1 = Math.min(width - 1, x1 + pad); y1 = Math.min(height - 1, Math.max(y1 + pad, ay));
    const w = x1 - x0 + 1; const h = y1 - y0 + 1;
    const cut = (src) => {
        const d = new Uint8ClampedArray(w * h * 4);
        for (let y = 0; y < h; y++) d.set(src.subarray(((y + y0) * width + x0) * 4, ((y + y0) * width + x0 + w) * 4), y * w * 4);
        return d;
    };
    return { albedo: cut(result.albedo), emit: cut(result.emit), occ: cut(result.occ), width: w, height: h, anchor: [ax - x0, ay - y0] };
}

// Press Start 2P capitals (the chrome's display face, rasterised at its
// native 8 px): 8-px cells, the eighth column the face's own spacing.
const PS2P = Object.freeze({
    A: ['..###...', '.##.##..', '##...##.', '##...##.', '#######.', '##...##.', '##...##.'],
    C: ['..####..', '.##..##.', '##......', '##......', '##......', '.##..##.', '..####..'],
    D: ['#####...', '##..##..', '##...##.', '##...##.', '##...##.', '##..##..', '#####...'],
    E: ['#######.', '##......', '##......', '######..', '##......', '##......', '#######.'],
    I: ['.######.', '...##...', '...##...', '...##...', '...##...', '...##...', '.######.'],
    L: ['.##.....', '.##.....', '.##.....', '.##.....', '.##.....', '.##.....', '.######.'],
    U: ['##...##.', '##...##.', '##...##.', '##...##.', '##...##.', '##...##.', '.#####..'],
    V: ['##...##.', '##...##.', '##...##.', '###.###.', '.#####..', '..###...', '...#....'],
});
// The run's letters (7 rows x 8 cols each) and its inked extent in run
// columns (cell k starts at column 8k).
function glyphRun(text) {
    const letters = [...text].map((ch) => {
        const rows = PS2P[ch];
        if (!rows) throw new Error(`no PS2P glyph for ${ch}`);
        return rows.map((r) => [...r].map((c) => c === '#'));
    });
    let inkLeft = Infinity;
    let inkRight = -1;
    letters.forEach((rows, k) => rows.forEach((row) => row.forEach((on, x) => {
        if (on) { inkLeft = Math.min(inkLeft, 8 * k + x); inkRight = Math.max(inkRight, 8 * k + x); }
    })));
    return { letters, inkLeft, width: inkRight - inkLeft + 1 };
}

// ---------------------------------------------------------------- output
function png(data, w, h) {
    const img = new PNG({ width: w, height: h });
    img.data = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    return PNG.sync.write(img, { colorType: 6 });
}
function upscale(data, w, h, k) {
    const out = new Uint8ClampedArray(w * k * h * k * 4);
    for (let y = 0; y < h * k; y++) for (let x = 0; x < w * k; x++) {
        const s = (Math.floor(y / k) * w + Math.floor(x / k)) * 4;
        out.set(data.subarray(s, s + 4), (y * w * k + x) * 4);
    }
    return out;
}

function bakeGate() {
    const G = VILLAGE_GATE_GEOMETRY;
    const glyphs = glyphRun(G.sign.text);
    const W = 300; const H = 320; const ax = 150; const ay = 250;
    const zTop = G.roofApex + 20;
    const base = render(gatehouseSolids(G), { width: W, height: H, ax, ay, zTop, glyphs, gate: G });
    const gate = crop(base, ax, ay);
    const frames = ['shut', 'open'].map((state) => render(gatehouseSolids(G, { doors: state }), { width: W, height: H, ax, ay, zTop, glyphs, gate: G, onlyDoors: true }));
    // Door strip: both frames cropped to one shared box.
    let x0 = W; let y0 = H; let x1 = -1; let y1 = -1;
    for (const f of frames) for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        if (f.albedo[(y * W + x) * 4 + 3]) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
    }
    const fw = x1 - x0 + 1; const fh = y1 - y0 + 1;
    const strip = (key) => {
        const d = new Uint8ClampedArray(fw * 2 * fh * 4);
        frames.forEach((f, k) => {
            for (let y = 0; y < fh; y++) d.set(f[key].subarray(((y + y0) * W + x0) * 4, ((y + y0) * W + x0 + fw) * 4), (y * fw * 2 + k * fw) * 4);
        });
        return d;
    };
    return {
        gate,
        doors: { albedo: strip('albedo'), occ: strip('occ'), width: fw * 2, height: fh, frameWidth: fw, anchor: [ax - x0, ay - y0] },
    };
}

function bakeSeaTower() {
    const S = SEA_TOWER_GEOMETRY;
    const W = 200; const H = 280; const ax = 100; const ay = 230;
    const base = render(seaTowerSolids(S), { width: W, height: H, ax, ay, zTop: S.roofApex + 20 });
    return crop(base, ax, ay);
}

const args = process.argv.slice(2);
const check = args.includes('--check');
const previewAt = args.indexOf('--preview');
const previewDir = previewAt >= 0 ? args[previewAt + 1] : null;
const { gate, doors } = bakeGate();
const tower = bakeSeaTower();
const files = [
    ['prop.villageGate.png', png(gate.albedo, gate.width, gate.height)],
    ['prop.villageGate.emissive.png', png(gate.emit, gate.width, gate.height)],
    ['prop.villageGate.occluder.png', png(gate.occ, gate.width, gate.height)],
    ['prop.villageGateDoors.png', png(doors.albedo, doors.width, doors.height)],
    ['prop.villageGateDoors.occluder.png', png(doors.occ, doors.width, doors.height)],
    ['prop.villageWallSeaTower.png', png(tower.albedo, tower.width, tower.height)],
    ['prop.villageWallSeaTower.emissive.png', png(tower.emit, tower.width, tower.height)],
    ['prop.villageWallSeaTower.occluder.png', png(tower.occ, tower.width, tower.height)],
];
console.log(`prop.villageGate: width ${gate.width} height ${gate.height} anchor [${gate.anchor}]`);
{
    const G = VILLAGE_GATE_GEOMETRY;
    const polys = G.towerX.map((cx) => roofPolygon({ cx, r0: G.towerR + G.eaveOut, z0: G.ringTop, z1: G.roofApex }, gate.anchor));
    console.log(`  PropWinter roof polys: ${JSON.stringify(polys)}`);
}
console.log(`prop.villageGateDoors: width ${doors.frameWidth} (x2 frames) height ${doors.height} anchor [${doors.anchor}]`);
console.log(`prop.villageWallSeaTower: width ${tower.width} height ${tower.height} anchor [${tower.anchor}]`);
{
    const S = SEA_TOWER_GEOMETRY;
    console.log(`  PropWinter roof poly: ${JSON.stringify(roofPolygon({ cx: 0, r0: S.lampR + S.eaveOut, z0: S.eaveZ, z1: S.roofApex }, tower.anchor))}`);
}
if (previewDir) {
    mkdirSync(previewDir, { recursive: true });
    for (const [name, data, w, h] of [
        ['gate', gate.albedo, gate.width, gate.height], ['gate-emit', gate.emit, gate.width, gate.height],
        ['doors', doors.albedo, doors.width, doors.height], ['tower', tower.albedo, tower.width, tower.height],
        ['tower-emit', tower.emit, tower.width, tower.height]]) {
        writeFileSync(join(previewDir, `${name}-4x.png`), png(upscale(data, w, h, 4), w * 4, h * 4));
    }
} else if (check) {
    let stale = 0;
    for (const [name, bytes] of files) {
        const path = join(PROPS, name);
        if (!existsSync(path) || !readFileSync(path).equals(bytes)) { console.error(`stale: ${name}`); stale++; }
    }
    process.exit(stale ? 1 : 0);
} else {
    for (const [name, bytes] of files) writeFileSync(join(PROPS, name), bytes);
    console.log(`wrote ${files.length} files to ${PROPS}`);
}
