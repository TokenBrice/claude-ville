#!/usr/bin/env node
// Wave 5 Fix-B (Spec 03 §1.2 item 5.1, D6, Fable P0-5) — the open-front Forge.
//
// The shipped Forge (`building.forge/base.png`, 256 x 232, anchor [128, 169])
// kept its furnace in a narrow round mouth on the SW gable: a smith in it put
// his head into the voussoirs, and no tile of the walk grid stood inside it.
// This baker opens that gable's lower wall into a two-arch smithy arcade and
// re-derives every channel from the result, deterministically and with zero
// PixelLab generations:
//
//   base.png           Between the gable's oak tie beam (kept: it is the
//                      arcade's lintel) and the ground, sprite x 36..93: a
//                      stone centre pier and jambs, oak knee braces under the
//                      beam (the Tavern veranda's arched hand), and behind the
//                      two arches a shaded flagstone smithy floor two tiles
//                      deep, the gable's inner wall with a recessed glowing
//                      hearth under a stone hood, an oak-mounted anvil and a
//                      tool rail. The slate roof, chimney, timber gable,
//                      windows, billet rack, quench trough, yard anvil and the
//                      alpha silhouette are untouched; the trough's and the
//                      yard anvil's old fire-lit texels are relit as stone.
//                      Every new texel is an ART_RAMPS stop or the #060402
//                      selective ink, opaque.
//   base.material.png  Stone / timber / metal / fire classes of the new
//                      texels, then `paint-facade-materials.mjs`'s own forge
//                      pass (its fixed point, so `--check` there stays green).
//   base.emissive.png  The old mouth's fire leaves; the hearth's flames and
//                      coal bed emit on ART_RAMPS.emissive ∪ EFFECT_COLORS.work
//                      stops (`emissive-sidecars.mjs` keeps them as authored).
//   base.occluder.png  Authored surface codes for the new texels: the floor
//                      and threshold face up at height 0, the inner wall and
//                      hearth face SE above the floor, the piers and braces
//                      stand on the front plane. Every other texel is kept.
//   base.surface.png   `bake-depth-channels.mjs`'s surface-v1 page of the
//                      result (byte-identical to its `--check`).
//   banked.png         The rest mask: the hearth's fire restated as stepped
//                      charcoal over one ember course, and its warm spill on
//                      the floor and wall restated unlit.
//   hearth.png         The EmitterCycle `tongues` mask: the firebox only.
//   bellows.png        A floor bellows inside the left arch (4 frames, the
//                      upper board pumping about the nozzle hinge).
//
// The arcade's measured open-front profile (front arch runs, bays, floor
// rect, post line) is written into OpenFront.js as `FORGE_OPEN_FRONT_PROFILE`
// (between `// <forge-open-front>` markers): the one authoritative Forge
// profile. Both bays stand on tile row 29 inside the arches (buildings.js
// `openFloor`), 4 texels behind the front plane, heads clear of the lintel.
//
// The edit is idempotent: inside the arcade every texel is painted from
// geometry alone and outside it every texel is kept, so a second run (and
// `--check`) reproduces the shipped files byte-for-byte.
//
// Usage:
//   node scripts/sprites/bake-forge-openfront.mjs           # write base.png, sidecars, layers, profile
//   node scripts/sprites/bake-forge-openfront.mjs --check   # verify every file and the profile block
//   node scripts/sprites/bake-forge-openfront.mjs --help

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ART_RAMPS } from '../../claudeville/src/config/artPalette.js';
import { BUILDING_DEFS } from '../../claudeville/src/config/buildings.js';
import { materialClassId } from '../../claudeville/src/presentation/character-mode/MaterialRegistry.js';
import {
    BUILDING_VISUAL_REGISTRY,
    getBuildingSurfaceAoPairs,
    signBoxFor,
} from '../../claudeville/src/presentation/character-mode/BuildingVisualRegistry.js';
import { OPEN_FRONT_PROFILES, splitOpenFrontMask } from '../../claudeville/src/presentation/character-mode/OpenFront.js';
import { bakeBuildingSurfaceV1, checkAoMonotonicity, validateSurfaceV1Buffer } from './bake-depth-channels.mjs';
import { BUILDINGS_DIR, CUTAWAY_PALETTE_KEYS, REPO_ROOT, encodePng, hexToRgb, hash2, readPng } from './bake-cutaway-command.mjs';
import { nearestRampStop } from './emissive-sidecars.mjs';
import { loadSpriteManifest } from './manifest-utils.mjs';
import { facadeMaterial } from './paint-facade-materials.mjs';

export const FORGE_DIR = join(BUILDINGS_DIR, 'building.forge');
export const OPEN_FRONT_PATH = join(REPO_ROOT, 'claudeville/src/presentation/character-mode/OpenFront.js');
export const BLOCK_OPEN = '// <forge-open-front>';
export const BLOCK_CLOSE = '// </forge-open-front>';

export const FORGE_NATIVE = Object.freeze({ width: 256, height: 232, anchor: Object.freeze([128, 169]) });
// Registered layers this bake must leave exactly where they are.
export const FORGE_REGISTERED_LAYERS = Object.freeze({
    hearth: Object.freeze({ anchor: [128, 169], width: 256, height: 232 }),
    banked: Object.freeze({ anchor: [128, 169], width: 256, height: 232 }),
    bellows: Object.freeze({ anchor: [57, 197], frameW: 28, frameH: 22, frames: 4 }),
    billetRack: Object.freeze({ anchor: [211, 191], frameW: 18, frameH: 26, frames: 3 }),
});
export const FORGE_SIGN_AT = Object.freeze([73, 107]);

const A = ART_RAMPS.ashlar;
const T = ART_RAMPS.timber;
const ST = ART_RAMPS.stone;
const BF = ART_RAMPS.beaconFire;
const EM = ART_RAMPS.emissive;
const SCARLET = ART_RAMPS.canopyScarlet;
// Firelight on stone: the warm earth ramp (receivers, never emitters).
const LIT = ART_RAMPS.dirt;
export const INK = '#060402';

const STONE = materialClassId('stone');
const TIMBER = materialClassId('timber');
const METAL = materialClassId('metal');
const FIRE = materialClassId('fire');

// ─── Arcade geometry (sprite px of base.png) ─────────────────────────────────
//
// The front plane meets the ground on `frontY` (4 texels in front of the
// footprint's SW edge, where the gable's corner stones stand). The gable's
// inner wall (the bay's left side) is the plane 31 texels from the sprite's
// left at the front, receding up-right at the 2:1 slope; the floor runs two
// tiles deep behind the arches, so the bay's back corner (x 95) hides behind
// the right jamb. `LINTEL_TOP[x]` is the first texel under the kept oak tie
// beam's ink (measured once on the shipped gable): the arcade owns every
// texel from there down.
export const FORGE_ARCADE = Object.freeze({
    x0: 36,
    x1: 101,
    frontY: (x) => 157 + 0.5 * x,
    wallBaseY: (x) => 172.5 - 0.5 * (x - 31),
    floorDepthTiles: 2,
    leftJamb: Object.freeze([36, 37]),
    pier: Object.freeze([60, 68]),
    // The right jamb is a stone pilaster up to the S corner's coursing.
    rightJamb: Object.freeze([91, 101]),
    openings: Object.freeze([
        Object.freeze({ id: 'left', x0: 38, x1: 59 }),
        Object.freeze({ id: 'right', x0: 69, x1: 90 }),
    ]),
    braceRadius: 10,
    revealPx: 3,
    // Kept around the arcade: the quench trough (x <= 47 from its rim down)
    // and the yard anvil on its stone block; both stand in front of the
    // arches and draw over a smith in the bay.
    keepTrough: (x, y) => x <= 47 && y >= 173,
    keepAnvil: (x, y) => (x >= 86 && y >= 193) || (x >= 84 && y >= 194) || (x >= 81 && y >= 209),
    // The recessed hearth on the inner wall (right arch), its stone hood up
    // to the beam, and the oak-mounted anvil on the floor (left arch).
    hearth: Object.freeze({ x0: 70, x1: 81, raise: 3, height: 11 }),
    anvil: Object.freeze({ cx: 52, baseY: 168, stumpHalf: 4, stumpH: 6 }),
    rail: Object.freeze({ x0: 40, x1: 57, lift: 25 }),
});

export const LINTEL_TOP = Object.freeze({
    36: 110, 37: 110, 38: 110, 39: 110, 40: 112, 41: 112, 42: 112, 43: 112, 44: 114, 45: 114,
    46: 114, 47: 114, 48: 116, 49: 116, 50: 116, 51: 116, 52: 118, 53: 118, 54: 118, 55: 118,
    56: 118, 57: 119, 58: 120, 59: 120, 60: 120, 61: 121, 62: 123, 63: 123, 64: 122, 65: 122,
    66: 122, 67: 121, 68: 121, 69: 121, 70: 121, 71: 121, 72: 122, 73: 121, 74: 123, 75: 123,
    76: 123, 77: 123, 78: 126, 79: 126, 80: 127, 81: 127, 82: 127, 83: 127, 84: 129, 85: 129,
    86: 131, 87: 131, 88: 133, 89: 133, 90: 136, 91: 136, 92: 135, 93: 137, 94: 137, 95: 137,
    96: 137, 97: 138, 98: 139, 99: 139, 100: 139, 101: 139,
});

// The old furnace's warm spill on the kept trough and yard anvil, relit as
// the stone it lies on (outputs are never inputs: the pass is idempotent).
export const FIRELIT_RELIGHT = Object.freeze({
    '#7c563d': '#74646d',
    '#946a4b': '#96847b',
    '#b4835f': '#a39892',
    '#d1a46c': '#9e8f85',
    '#e3cba9': '#d5c5ae',
});
const RELIGHT_X = Object.freeze([36, 99]);

// Bays: the two work tiles of buildings.js on row 29 (`openFloor`), each
// centred in its arch, feet 4 texels behind the front plane.
export const FORGE_BAY_TILES = Object.freeze([
    Object.freeze({ id: 'forge-hearth', tileX: 28, tileY: 29, pose: 'tinker', facing: 'north-east' }),
    Object.freeze({ id: 'forge-anvil', tileX: 27, tileY: 29, pose: 'hammer', facing: 'north-east' }),
]);
export const FORGE_POST_LINE_INSET = -0.25;
export const FORGE_REAR_WALL_INSET = 2.5;
// Building-local floor rect a body counts as "in the bay" over (row 29 under
// both arches, half a tile either side of the two tiles).
export const FORGE_BAY_RECT = Object.freeze({ dx: 0.5, dy: 2.5, width: 2, height: 0.75 });
// A character reads ~58 texels from feet to crown.
export const SMITH_HEIGHT_PX = 58;

const ROUND = 1000;
const r3 = (value) => Math.round(value * ROUND) / ROUND;

function forgeDef() {
    return BUILDING_DEFS.find((def) => def.type === 'forge');
}

/** Sprite px of an absolute tile point on the Forge (anchor = footprint centre). */
export function forgeTileToSprite(tileX, tileY, def = forgeDef()) {
    const cx = def.x + def.width / 2;
    const cy = def.y + def.height / 2;
    return {
        x: FORGE_NATIVE.anchor[0] + ((tileX - cx) - (tileY - cy)) * 32,
        y: FORGE_NATIVE.anchor[1] + ((tileX - cx) + (tileY - cy)) * 16,
    };
}

// ─── Pixel helpers ───────────────────────────────────────────────────────────

const keyOf = (hex) => {
    const [r, g, b] = hexToRgb(hex);
    return (r << 16) | (g << 8) | b;
};

function hexAt(data, i) {
    return `#${[data[i], data[i + 1], data[i + 2]].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

function cloneRaster(raster) {
    return { width: raster.width, height: raster.height, data: new Uint8Array(raster.data) };
}

function blankRaster(width, height) {
    return { width, height, data: new Uint8Array(width * height * 4) };
}

function setHex(raster, x, y, hex, alpha = 255) {
    const o = (y * raster.width + x) * 4;
    const [r, g, b] = hexToRgb(hex);
    raster.data[o] = r;
    raster.data[o + 1] = g;
    raster.data[o + 2] = b;
    raster.data[o + 3] = alpha;
}

// Transparent texels reachable from the canvas border (4-connected).
function outsideMask(raster) {
    const { width: w, height: h, data } = raster;
    const out = new Uint8Array(w * h);
    const stack = [];
    const push = (i) => {
        if (out[i] || data[i * 4 + 3] > 0) return;
        out[i] = 1;
        stack.push(i);
    };
    for (let x = 0; x < w; x++) {
        push(x);
        push((h - 1) * w + x);
    }
    for (let y = 0; y < h; y++) {
        push(y * w);
        push(y * w + w - 1);
    }
    while (stack.length) {
        const i = stack.pop();
        const x = i % w;
        if (x > 0) push(i - 1);
        if (x < w - 1) push(i + 1);
        if (i >= w) push(i - w);
        if (i < (h - 1) * w) push(i + w);
    }
    return out;
}

// ─── The arcade painter ──────────────────────────────────────────────────────

/**
 * The texels the arcade owns: opaque base.png texels at x0..x1 from the
 * lintel line down, minus the kept trough and yard anvil. Depends on alpha
 * only, which the bake never changes, so it is stable across runs.
 */
export function arcadeRegion(base) {
    const g = FORGE_ARCADE;
    const region = new Uint8Array(base.width * base.height);
    for (let x = g.x0; x <= g.x1; x++) {
        for (let y = LINTEL_TOP[x]; y < base.height; y++) {
            if (base.data[(y * base.width + x) * 4 + 3] === 0) continue;
            if (g.keepTrough(x, y) || g.keepAnvil(x, y)) continue;
            region[y * base.width + x] = 1;
        }
    }
    return region;
}

function braceDepth(offset, radius) {
    // Quarter circle of `radius` in the opening's top corner: rows below the
    // lintel the knee brace fills at column `offset` (0 = against the jamb).
    if (offset >= radius) return 0;
    const c = radius - offset - 0.5;
    return Math.max(0, Math.round(radius - Math.sqrt(Math.max(0, radius * radius - c * c))));
}

function openingAt(x) {
    return FORGE_ARCADE.openings.find((opening) => x >= opening.x0 && x <= opening.x1) || null;
}

/** Hearth firebox rows at column x (inclusive), or null. */
export function hearthRows(x) {
    const h = FORGE_ARCADE.hearth;
    if (x < h.x0 || x > h.x1) return null;
    const bottom = Math.floor(FORGE_ARCADE.wallBaseY(x)) - h.raise;
    return { top: bottom - h.height + 1, bottom };
}

// Deterministic flame height per firebox column: tongues of 4..8 texels.
function flameHeight(x) {
    const pattern = [5, 7, 8, 6, 8, 7, 5, 7, 8, 6, 7, 5];
    return pattern[(x - FORGE_ARCADE.hearth.x0) % pattern.length];
}

/**
 * Paint the arcade. Returns the new base raster plus the per-texel facts the
 * sidecars are derived from: material class, role (`front` | `interior`),
 * occluder face and height, and the hearth's fire / glow texels.
 */
export function paintForgeArcade(sourceBase) {
    const g = FORGE_ARCADE;
    const base = cloneRaster(sourceBase);
    const { width, height } = base;
    const region = arcadeRegion(sourceBase);
    const n = width * height;
    const cls = new Uint8Array(n);
    const role = new Uint8Array(n); // 1 front, 2 interior
    const face = new Int8Array(n).fill(-1);
    const heightPx = new Float32Array(n);
    const fire = new Uint8Array(n); // 1 coal bed, 2 flame, 3 soot (firebox)
    const glow = new Uint8Array(n); // 1 warm-lit receiver (restated unlit when banked)
    const unlit = new Map(); // index -> unlit hex for glow texels

    // Every paint call resets the texel's fire / glow bookkeeping; the hearth
    // pass marks its own texels after painting them.
    const put = (x, y, hex, { mat = STONE, front = true, f = 1, h = 0 } = {}) => {
        const i = y * width + x;
        if (!region[i]) return false;
        setHex(base, x, y, hex);
        cls[i] = mat;
        role[i] = front ? 1 : 2;
        face[i] = f;
        heightPx[i] = Math.max(0, h);
        fire[i] = 0;
        glow[i] = 0;
        unlit.delete(i);
        return true;
    };

    const frontY = g.frontY;
    const wallBaseY = g.wallBaseY;

    // Pass 1 — every owned texel gets its structural paint.
    for (let x = g.x0; x <= g.x1; x++) {
        const top = LINTEL_TOP[x];
        const fy = frontY(x);
        const opening = openingAt(x);
        for (let y = top; y < height; y++) {
            const i = y * width + x;
            if (!region[i]) continue;
            const below = y - fy; // > 0: in front of the front plane
            if (below > 1) {
                // The stone step the arches stand on (front face, in shadow).
                put(x, y, below < 3 ? A[4] : A[3], { f: 0, h: 0 });
                continue;
            }
            if (below > -2) {
                // Threshold sill under the arches and the piers' plinth.
                put(x, y, below <= -1 ? A[6] : (below <= 0 ? A[5] : A[3]), { f: 0, h: 0 });
                continue;
            }
            if (!opening) {
                paintPierTexel(put, x, y, top, fy);
                continue;
            }
            const fromLeft = x - opening.x0;
            const fromRight = opening.x1 - x;
            const knee = Math.max(braceDepth(fromLeft, g.braceRadius), braceDepth(fromRight, g.braceRadius));
            if (y < top + knee) {
                // Oak knee brace: a 2-texel curved band along the arc, the
                // stone spandrel behind it toward the corner.
                const fromArc = top + knee - 1 - y; // 0 = the band's lowest row
                if (fromArc <= 1) {
                    put(x, y, fromArc === 0 ? T[2] : T[3], { mat: TIMBER, f: 1, h: fy - y });
                } else {
                    put(x, y, fromArc === 2 ? T[1] : A[4], { mat: fromArc === 2 ? TIMBER : STONE, f: 1, h: fy - y });
                }
                continue;
            }
            // Pier reveal: the left pier's SE-facing side, receding up-right.
            if (fromLeft < g.revealPx) {
                const revealFoot = frontY(opening.x0) - 0.5 * fromLeft;
                if (y <= revealFoot) {
                    const coursed = ((Math.floor(y + 0.5 * x) % 4) + 4) % 4 === 0;
                    put(x, y, fromLeft === 0 ? A[2] : (coursed ? A[2] : A[3]), { front: false, f: 2, h: revealFoot - y });
                    continue;
                }
            }
            const wy = wallBaseY(x);
            if (y < wy) paintInnerWallTexel(put, x, y, top, wy);
            else paintFloorTexel(put, x, y, wy, fy);
        }
    }

    // Pass 2 — the recessed hearth on the inner wall (right arch).
    paintHearth({ put, base, width, region, fire, glow, unlit });
    // Pass 3 — the oak-mounted anvil and the tool rail (left arch).
    paintInteriorAnvil(put);
    paintToolRail(put);
    // Pass 4 — knee-brace and pier outlines (selective ink on the opening side).
    paintArcadeInk({ put, region, width, base });

    // Relight the kept trough's and yard anvil's old fire spill.
    for (let y = 150; y < height; y++) {
        for (let x = RELIGHT_X[0]; x <= RELIGHT_X[1]; x++) {
            const i = y * width + x;
            if (region[i] || base.data[i * 4 + 3] === 0) continue;
            const to = FIRELIT_RELIGHT[hexAt(base.data, i * 4)];
            if (to) setHex(base, x, y, to, base.data[i * 4 + 3]);
        }
    }

    // Silhouette: every owned texel on the outside edge is selective ink.
    const outside = outsideMask(base);
    for (let i = 0; i < n; i++) {
        if (!region[i]) continue;
        const x = i % width;
        const edge = (x > 0 && outside[i - 1]) || (x < width - 1 && outside[i + 1])
            || (i >= width && outside[i - width]) || (i < (height - 1) * width && outside[i + width]);
        if (edge) {
            setHex(base, x, (i - x) / width, INK);
            glow[i] = 0;
            fire[i] = 0;
        }
    }
    return { base, region, cls, role, face, heightPx, fire, glow, unlit };
}

function paintPierTexel(put, x, y, top, fy) {
    const g = FORGE_ARCADE;
    // Coursed ashlar on the front plane: 5-row courses along the 2:1 wall
    // line, joints every 9 texels staggered half a stone, lit top-left.
    const rel = y - 0.5 * x;
    const course = Math.floor(rel / 5);
    const inCourse = ((Math.floor(rel) % 5) + 5) % 5;
    const stagger = (course & 1) ? 4 : 0;
    const joint = ((x + stagger) % 9 + 9) % 9;
    const stone = hash2(Math.floor((x + stagger) / 9), course, 31) % 5;
    let color = stone === 0 ? A[6] : (stone === 1 ? A[4] : A[5]);
    if (inCourse === 1 && joint !== 0) color = stone === 1 ? A[5] : A[7];
    if (inCourse === 0 || joint === 0) color = A[3];
    // The pier's impost under the lintel: a pale block with a shadowed foot.
    const impost = y - top;
    if (impost <= 2) color = impost === 2 ? A[3] : (impost === 0 ? A[5] : A[7]);
    // Plinth course above the sill.
    if (fy - y < 4 && fy - y >= 2) color = fy - y < 3 ? A[3] : A[6];
    // The pilaster's own right edge against the S corner's coursing.
    if (x === g.rightJamb[1]) color = color === A[7] ? A[5] : A[3];
    put(x, y, color, { f: 1, h: fy - y });
}

function paintInnerWallTexel(put, x, y, top, wy) {
    // The gable's inner face (SE-facing, in the bay's shade): 4-row rubble
    // courses rising up-right, darker under the ceiling.
    const rel = y + 0.5 * x;
    const course = Math.floor(rel / 4);
    const inCourse = ((Math.floor(rel) % 4) + 4) % 4;
    const stagger = (course & 1) ? 3 : 0;
    const joint = ((x + stagger) % 7 + 7) % 7;
    const stone = hash2(Math.floor((x + stagger) / 7), course, 17) % 5;
    let color = stone === 0 ? A[4] : A[3];
    if (inCourse === 0 || joint === 0) color = A[2];
    if (y - top < 4) color = y - top < 2 ? A[1] : A[2];
    if (wy - y < 1) color = A[1]; // contact shadow where wall meets floor
    put(x, y, color, { front: false, f: 2, h: wy - y });
}

function paintFloorTexel(put, x, y, wy, fy) {
    // Flagstones on the floor plane: a 2:1 diamond grid three stones a tile,
    // staggered by half a stone each course; daylit at the threshold, deep
    // shade toward the back of the bay.
    const u = (x / 32 + y / 16) / 2; // along +tileX
    const v = (y / 16 - x / 32) / 2; // along +tileY
    const row = Math.floor(v * 3);
    const along = u * 3 + ((row & 1) ? 0.5 : 0);
    const fu = along - Math.floor(along);
    const fv = v * 3 - row;
    const joint = fu < 0.11 || fv < 0.2;
    const depth = (fy - y) / 32; // tiles behind the front plane at this column
    const stone = hash2(Math.floor(along), row, 23) % 4;
    let color;
    if (depth < 0.3) color = joint ? A[3] : (stone === 0 ? A[5] : A[4]);
    else if (depth < 0.9) color = joint ? A[2] : (stone === 0 ? A[4] : A[3]);
    else color = joint ? A[1] : (stone === 0 ? A[3] : A[2]);
    if (y - wy < 1) color = A[1];
    put(x, y, color, { front: false, f: 0, h: 0 });
}

function paintHearth({ put, base, region, width, fire, glow, unlit }) {
    const g = FORGE_ARCADE;
    const h = g.hearth;
    const fireAt = (x, y, hex, kind) => {
        if (!put(x, y, hex, { mat: FIRE, front: false, f: 2, h: g.wallBaseY(x) - y })) return;
        fire[y * width + x] = kind;
    };
    // Warm spill on the inner wall and the floor in front of the firebox.
    const cx = (h.x0 + h.x1) / 2;
    const cy = g.wallBaseY(cx) - h.raise;
    for (let y = Math.floor(cy - 20); y <= Math.ceil(cy + 20); y++) {
        for (let x = h.x0 - 4; x <= h.x1 + 8; x++) {
            const i = y * width + x;
            if (!region[i] || x < g.openings[1].x0 + g.revealPx || x > g.openings[1].x1) continue;
            const dx = (x - cx) / 10;
            const dy = (y - cy) / 7.5;
            const dist = dx * dx + dy * dy;
            if (dist > 1) continue;
            const wy = g.wallBaseY(x);
            const onFloor = y >= wy;
            if (!onFloor && y < LINTEL_TOP[x] + 3) continue;
            const near = dist < 0.3;
            const joint = hexAt(base.data, i * 4) === A[1] || hexAt(base.data, i * 4) === A[2];
            const hex = joint ? (near ? LIT[1] : LIT[0]) : (near ? LIT[3] : LIT[2]);
            const before = hexAt(base.data, i * 4);
            put(x, y, hex, { front: false, f: onFloor ? 0 : 2, h: onFloor ? 0 : wy - y });
            glow[i] = 1;
            unlit.set(i, before);
        }
    }
    // Hood: a stone header over the firebox (firelit underside) and a
    // shadowed chimney breast up to the beam, ink at its sides.
    for (let x = h.x0 - 1; x <= h.x1 + 1; x++) {
        const rows = hearthRows(Math.min(h.x1, Math.max(h.x0, x)));
        const top = LINTEL_TOP[x];
        for (let y = top; y < rows.top - 1; y++) {
            const edge = x === h.x0 - 1 || x === h.x1 + 1;
            const rel = y + 0.5 * x;
            const seam = ((Math.floor(rel) % 5) + 5) % 5 === 0;
            const header = y >= rows.top - 3;
            let hex = seam ? A[2] : A[3];
            if (y - top < 3) hex = A[2];
            if (header) hex = y === rows.top - 2 ? LIT[3] : A[5];
            if (edge) hex = INK;
            put(x, y, hex, { front: false, f: 2, h: g.wallBaseY(x) - y });
            if (header && !edge && y === rows.top - 2) {
                glow[y * width + x] = 1;
                unlit.set(y * width + x, A[4]);
            }
        }
    }
    // Firebox: ink frame, soot crown, tongues, coal bed; a stone sill under it.
    for (let x = h.x0 - 1; x <= h.x1 + 1; x++) {
        const rows = hearthRows(Math.min(h.x1, Math.max(h.x0, x)));
        if (x === h.x0 - 1 || x === h.x1 + 1) {
            for (let y = rows.top - 1; y <= rows.bottom + 1; y++) put(x, y, INK, { front: false, f: 2, h: g.wallBaseY(x) - y });
            continue;
        }
        put(x, rows.top - 1, INK, { front: false, f: 2, h: g.wallBaseY(x) - rows.top + 1 });
        const flame = flameHeight(x);
        for (let y = rows.top; y <= rows.bottom; y++) {
            const fromBed = rows.bottom - y; // 0 = lowest row
            if (fromBed <= 1) {
                const ember = hash2(x, y, 5) % 3;
                fireAt(x, y, ember === 0 ? EM[0] : (ember === 1 ? BF[3] : SCARLET[3]), 1);
            } else if (fromBed - 2 < flame) {
                const t = (fromBed - 2) / Math.max(1, flame);
                const tip = fromBed - 2 === flame - 1;
                let hex = t < 0.3 ? EM[1] : (t < 0.6 ? BF[4] : EM[0]);
                if (t < 0.15 && x > h.x0 + 1 && x < h.x1 - 1) hex = EM[2];
                if (tip) hex = BF[3];
                fireAt(x, y, hex, 2);
            } else {
                fireAt(x, y, fromBed - 2 === flame ? SCARLET[3] : ST[0], 3);
            }
        }
        // Sill: the hearth's stone lip, firelit on its top (plain stone banked).
        if (put(x, rows.bottom + 1, LIT[4], { front: false, f: 0, h: 3 })) {
            glow[(rows.bottom + 1) * width + x] = 1;
            unlit.set((rows.bottom + 1) * width + x, A[4]);
        }
        put(x, rows.bottom + 2, A[3], { front: false, f: 2, h: 2 });
        put(x, rows.bottom + 3, A[2], { front: false, f: 2, h: 1 });
    }
}

function paintInteriorAnvil(put) {
    const a = FORGE_ARCADE.anvil;
    const stumpTop = a.baseY - a.stumpH;
    // Oak stump: lit left, shaded right, a pale sawn top, ink outline.
    for (let x = a.cx - a.stumpHalf; x <= a.cx + a.stumpHalf; x++) {
        for (let y = stumpTop; y <= a.baseY; y++) {
            const edge = x === a.cx - a.stumpHalf || x === a.cx + a.stumpHalf || y === a.baseY;
            const rel = x - (a.cx - a.stumpHalf);
            const hex = edge ? INK : (y === stumpTop ? T[3] : (rel <= 2 ? T[3] : (rel >= 2 * a.stumpHalf - 2 ? T[1] : T[2])));
            put(x, y, hex, { mat: TIMBER, front: false, f: 1, h: a.baseY - y });
        }
    }
    // Iron anvil on the stump: horn to the left, heel to the right.
    const top = stumpTop - 5;
    const rows = [
        { y: top, x0: a.cx - 6, x1: a.cx + 5, hex: ST[3] },
        { y: top + 1, x0: a.cx - 5, x1: a.cx + 5, hex: ST[2] },
        { y: top + 2, x0: a.cx - 2, x1: a.cx + 4, hex: ST[1] },
        { y: top + 3, x0: a.cx - 1, x1: a.cx + 3, hex: ST[1] },
        { y: top + 4, x0: a.cx - 3, x1: a.cx + 4, hex: ST[2] },
    ];
    for (const row of rows) {
        for (let x = row.x0; x <= row.x1; x++) {
            const hex = row.y === top && x <= a.cx + 1 ? ST[4] : row.hex;
            put(x, row.y, hex, { mat: METAL, front: false, f: 1, h: a.baseY - row.y });
        }
        put(row.x0 - 1, row.y, INK, { mat: METAL, front: false, f: 1, h: a.baseY - row.y });
        put(row.x1 + 1, row.y, INK, { mat: METAL, front: false, f: 1, h: a.baseY - row.y });
    }
    for (let x = a.cx - 6; x <= a.cx + 5; x++) put(x, top - 1, INK, { mat: METAL, front: false, f: 1, h: a.baseY - top + 1 });
}

function paintToolRail(put) {
    const g = FORGE_ARCADE;
    const r = g.rail;
    // An oak rail on the inner wall with tongs and two hammers hanging.
    for (let x = r.x0; x <= r.x1; x++) {
        const y = Math.round(g.wallBaseY(x) - r.lift);
        put(x, y - 1, INK, { front: false, f: 2, h: r.lift + 1 });
        put(x, y, T[2], { mat: TIMBER, front: false, f: 2, h: r.lift });
        put(x, y + 1, T[1], { mat: TIMBER, front: false, f: 2, h: r.lift - 1 });
    }
    const tools = [
        { x: r.x0 + 3, len: 9, head: 'tongs' },
        { x: r.x0 + 8, len: 7, head: 'hammer' },
        { x: r.x0 + 13, len: 8, head: 'hammer' },
    ];
    for (const tool of tools) {
        const y0 = Math.round(g.wallBaseY(tool.x) - r.lift) + 2;
        for (let k = 0; k < tool.len; k++) {
            const y = y0 + k;
            const metal = tool.head === 'tongs' || k >= tool.len - 2;
            put(tool.x, y, metal ? ST[2] : T[2], { mat: metal ? METAL : TIMBER, front: false, f: 2, h: r.lift - 2 - k });
            if (tool.head === 'tongs' && k >= tool.len - 4) put(tool.x + 1, y, ST[1], { mat: METAL, front: false, f: 2, h: r.lift - 2 - k });
        }
        if (tool.head === 'hammer') {
            const y = y0 + tool.len - 2;
            put(tool.x - 1, y, ST[3], { mat: METAL, front: false, f: 2, h: r.lift - tool.len });
            put(tool.x + 1, y, ST[2], { mat: METAL, front: false, f: 2, h: r.lift - tool.len });
        }
    }
}

function paintArcadeInk({ put, region, width, base }) {
    const g = FORGE_ARCADE;
    // Knee braces: ink along the arc's inner edge.
    for (const opening of g.openings) {
        for (let x = opening.x0; x <= opening.x1; x++) {
            const knee = Math.max(braceDepth(x - opening.x0, g.braceRadius), braceDepth(opening.x1 - x, g.braceRadius));
            if (!knee) continue;
            const y = LINTEL_TOP[x] + knee;
            const i = y * width + x;
            if (region[i] && base.data[i * 4 + 3]) put(x, y, INK, { mat: TIMBER, front: true, f: 1, h: g.frontY(x) - y });
        }
    }
    // Pier and jamb edges facing the openings.
    const inkColumn = (x) => {
        for (let y = LINTEL_TOP[x]; y < Math.floor(g.frontY(x)) - 1; y++) {
            put(x, y, INK, { front: true, f: 1, h: g.frontY(x) - y });
        }
    };
    inkColumn(g.leftJamb[1]);
    inkColumn(g.pier[0]);
    inkColumn(g.pier[1]);
    inkColumn(g.rightJamb[0]);
}

// ─── Layers derived from the arcade ──────────────────────────────────────────

/** hearth.png: the EmitterCycle tongues mask — the firebox, white. */
export function bakeHearthMask(painted) {
    const { width, height } = painted.base;
    const mask = blankRaster(width, height);
    for (let i = 0; i < width * height; i++) {
        if (!painted.fire[i]) continue;
        mask.data[i * 4] = 255;
        mask.data[i * 4 + 1] = 255;
        mask.data[i * 4 + 2] = 255;
        mask.data[i * 4 + 3] = 255;
    }
    return mask;
}

// The ember course keeps the village's VQ-8 ember-floor pair, shared with
// the Tavern's banked hearth (registry `rest.ember.colors`): these exact
// texels emit at the rest strength while the lamps burn.
export const BANKED_EMBERS = Object.freeze(['#d67634', '#803e22']);

/** banked.png: the fire as stepped charcoal over one ember course; the spill unlit. */
export function bakeBankedMask(painted) {
    const { base, fire, glow, unlit } = painted;
    const { width, height } = base;
    const out = blankRaster(width, height);
    for (let x = 0; x < width; x++) {
        const rows = hearthRows(x);
        for (let y = 0; y < height; y++) {
            const i = y * width + x;
            if (fire[i]) {
                const fromBed = rows ? rows.bottom - y : 0;
                let hex;
                if (fromBed === 0) hex = (x & 1) ? BANKED_EMBERS[1] : BANKED_EMBERS[0];
                else if (fromBed === 1) hex = A[2];
                else hex = fromBed % 3 === 0 ? A[2] : A[1];
                setHex(out, x, y, hex);
            } else if (glow[i] && unlit.has(i)) {
                setHex(out, x, y, unlit.get(i));
            }
        }
    }
    return out;
}

/**
 * bellows.png (4 x 28 x 22, anchor [57, 197]): a floor bellows inside the
 * left arch, nozzle toward the hearth. Only texels on the arch's interior
 * floor are drawn, so the front arch never overlays it.
 */
export function bakeBellowsStrip(painted) {
    const layer = FORGE_REGISTERED_LAYERS.bellows;
    const { frameW, frameH, frames } = layer;
    const left = Math.round(layer.anchor[0] - frameW / 2);
    const top = Math.round(layer.anchor[1] - frameH);
    const strip = blankRaster(frameW * frames, frameH);
    const { base, role } = painted;
    const lifts = [1, 2, 3, 2];
    const hingeX = 58;
    const rearX = 50;
    // The bottom board lies on the flagstones along the front (2:1).
    const boardAt = (x) => Math.round(178 + 0.5 * (x - rearX));
    for (let f = 0; f < frames; f++) {
        const rise = lifts[f];
        const pix = new Map();
        const set = (x, y, hex) => pix.set(`${x},${y}`, hex);
        for (let x = rearX; x <= hingeX; x++) {
            const bottom = boardAt(x);
            set(x, bottom, T[1]);
            // Upper board, hinged at the nozzle; its rear end rises 1..3.
            const t = (hingeX - x) / (hingeX - rearX);
            const y = Math.round(bottom - 1 - rise * t);
            set(x, y, x === rearX ? T[2] : T[3]);
            // Leather pleats between the boards.
            for (let yy = y + 1; yy < bottom; yy++) set(x, yy, ((yy + x) & 1) ? T[1] : T[0]);
        }
        // Iron nozzle toward the hearth.
        set(hingeX + 1, boardAt(hingeX) - 1, ST[3]);
        set(hingeX + 1, boardAt(hingeX), ST[2]);
        // Ink outline (4-connected) around the shape.
        const shape = new Set(pix.keys());
        for (const key of shape) {
            const [x, y] = key.split(',').map(Number);
            for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
                const nk = `${x + dx},${y + dy}`;
                if (!shape.has(nk) && !pix.has(nk)) pix.set(nk, INK);
            }
        }
        for (const [key, hex] of pix) {
            const [x, y] = key.split(',').map(Number);
            const lx = x - left;
            const ly = y - top;
            if (lx < 0 || ly < 0 || lx >= frameW || ly >= frameH) continue;
            if (x < 0 || y < 0 || x >= base.width || y >= base.height) continue;
            if (role[y * base.width + x] !== 2) continue; // interior floor only
            setHex(strip, f * frameW + lx, ly, hex);
        }
    }
    return strip;
}

// ─── Sidecars ────────────────────────────────────────────────────────────────

/** base.material.png: painted classes over the kept page, then the facade pass's fixed point. */
export function deriveMaterial(painted, currentMaterial, emissive) {
    const { base, region, cls } = painted;
    const seed = cloneRaster(currentMaterial);
    for (let i = 0; i < region.length; i++) {
        if (!region[i]) continue;
        seed.data[i * 4] = cls[i] || STONE;
        seed.data[i * 4 + 1] = 0;
        seed.data[i * 4 + 2] = 0;
        seed.data[i * 4 + 3] = base.data[i * 4 + 3];
    }
    const asPng = (raster) => ({ width: raster.width, height: raster.height, data: Buffer.from(raster.data) });
    let current = facadeMaterial('forge', asPng(base), asPng(emissive), asPng(seed));
    for (let pass = 0; pass < 4; pass++) {
        const next = facadeMaterial('forge', asPng(base), asPng(emissive), current);
        if (Buffer.compare(next.data, current.data) === 0) break;
        current = next;
    }
    return { width: current.width, height: current.height, data: new Uint8Array(current.data) };
}

/** base.emissive.png: the old mouth's fire cleared; the hearth's fire on light-ramp stops. */
export function deriveEmissive(painted, currentEmissive) {
    const { base, fire } = painted;
    const out = cloneRaster(currentEmissive);
    const { width, height } = out;
    for (let y = 0; y < height; y++) {
        for (let x = RELIGHT_X[0]; x <= RELIGHT_X[1]; x++) out.data.fill(0, (y * width + x) * 4, (y * width + x) * 4 + 4);
    }
    for (let i = 0; i < width * height; i++) {
        if (fire[i] !== 1 && fire[i] !== 2) continue;
        const o = i * 4;
        const stop = nearestRampStop([base.data[o], base.data[o + 1], base.data[o + 2]]).rgb;
        out.data[o] = stop[0];
        out.data[o + 1] = stop[1];
        out.data[o + 2] = stop[2];
        out.data[o + 3] = fire[i] === 2 ? 210 : 175;
    }
    return out;
}

/** base.occluder.png: authored R height / B surface code over the arcade; G kept. */
export function deriveOccluder(painted, currentOccluder) {
    const { region, face, heightPx } = painted;
    const out = cloneRaster(currentOccluder);
    for (let i = 0; i < region.length; i++) {
        if (!region[i]) continue;
        const o = i * 4;
        const f = face[i] < 0 ? 1 : face[i];
        const h = Math.max(0, Math.min(255, Math.round(heightPx[i])));
        out.data[o] = h;
        if (!out.data[o + 3]) out.data[o + 1] = 255;
        out.data[o + 2] = f * 64 + Math.min(63, Math.round(h / 4));
        out.data[o + 3] = painted.base.data[o + 3];
    }
    return out;
}

export function deriveSurface(base, occluder, material) {
    const baked = bakeBuildingSurfaceV1({ albedo: base, occluder, material });
    return { width: baked.width, height: baked.height, data: new Uint8Array(baked.surfaceData), validation: baked.validation };
}

// ─── The open-front profile measured on the arcade ───────────────────────────

function encodeRuns(mask, width, height) {
    const rows = [];
    for (let y = 0; y < height; y++) {
        const spans = [];
        let start = -1;
        for (let x = 0; x <= width; x++) {
            const on = x < width && mask[y * width + x] === 1;
            if (on && start < 0) start = x;
            if (!on && start >= 0) {
                spans.push(`${start}+${x - start}`);
                start = -1;
            }
        }
        if (spans.length) rows.push(`${y}:${spans.join(',')};`);
    }
    return rows;
}

// The arch window the front arch is measured in: from the gable's half-timber
// (above any smith's crown or raised tool) to the ground, the trough's rim to
// the S corner's wall.
export const FORGE_ARCH_WINDOW = Object.freeze({ left: 10, right: 112, top: 90, bottom: 231 });

/** Derive the open-front profile from the painted arcade. Pure. */
export function calibrateForgeOpenFront(painted) {
    const { base, role } = painted;
    const { width, height } = base;
    const win = FORGE_ARCH_WINDOW;
    const front = new Uint8Array(width * height);
    for (let y = win.top; y <= win.bottom; y++) {
        for (let x = win.left; x <= win.right; x++) {
            const i = y * width + x;
            if (base.data[i * 4 + 3] === 0 || role[i] === 2) continue;
            front[i] = 1;
        }
    }
    const rows = encodeRuns(front, width, height);
    const def = forgeDef();
    const bays = FORGE_BAY_TILES.map((bay) => {
        const at = forgeTileToSprite(bay.tileX, bay.tileY, def);
        return {
            id: bay.id,
            at: [Math.round(at.x), Math.round(at.y)],
            tile: { tileX: bay.tileX, tileY: bay.tileY },
            relTile: { dx: r3(bay.tileX - def.x), dy: r3(bay.tileY - def.y) },
            pose: bay.pose,
            facing: bay.facing,
            anchorOffset: [0, 0],
        };
    });
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < role.length; i++) {
        if (role[i] !== 2) continue;
        const x = i % width;
        const y = (i - x) / width;
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
    }
    return {
        width,
        height,
        front,
        rows,
        bays,
        def,
        rect: { ...FORGE_BAY_RECT },
        postLineInset: FORGE_POST_LINE_INSET,
        rearWallInset: FORGE_REAR_WALL_INSET,
        interiorBounds: { left: minX, right: maxX, top: minY, bottom: maxY },
    };
}

/** The generated OpenFront.js block (deterministic). */
export function renderOpenFrontBlock(calibration, fingerprints) {
    const { rows, bays, rect, postLineInset, rearWallInset, interiorBounds: b } = calibration;
    const rowLines = [];
    for (let i = 0; i < rows.length; i += 3) rowLines.push(`        '${rows.slice(i, i + 3).join('')}',`);
    const bayLines = bays.map((bay) => [
        '        freezeBay({',
        `            id: '${bay.id}',`,
        `            at: [${bay.at[0]}, ${bay.at[1]}],`,
        `            tile: { tileX: ${bay.tile.tileX}, tileY: ${bay.tile.tileY} },`,
        `            relTile: { dx: ${bay.relTile.dx}, dy: ${bay.relTile.dy} },`,
        `            pose: '${bay.pose}',`,
        `            facing: '${bay.facing}',`,
        '            anchorOffset: [0, 0],',
        '        }),',
    ].join('\n'));
    const win = FORGE_ARCH_WINDOW;
    return [
        `${BLOCK_OPEN} — generated by scripts/sprites/bake-forge-openfront.mjs; do not hand-edit.`,
        '// The one authoritative Forge open-front profile, measured on the two-arch',
        '// smithy arcade of building.forge/base.png: `frontArchRows` is every opaque',
        '// texel of the arch window outside the arcade\'s interior (piers, knee braces,',
        '// tie beam and gable, sill, trough and yard anvil); the bays are the two work',
        '// tiles on row 29 (buildings.js `openFloor`), 4 texels behind the front plane.',
        'export const FORGE_OPEN_FRONT_PROFILE = Object.freeze({',
        "    id: 'forge',",
        "    spriteId: 'building.forge',",
        "    propId: 'forge-open-front',",
        '    nativeSize: Object.freeze({ width: 256, height: 232 }),',
        '    anchor: Object.freeze([128, 169]),',
        '    footprint: Object.freeze({ width: 4, height: 3 }),',
        `    source: Object.freeze({ base: '${fingerprints.base}', hearth: '${fingerprints.hearth}', banked: '${fingerprints.banked}' }),`,
        `    archWindow: Object.freeze({ left: ${win.left}, right: ${win.right}, top: ${win.top}, bottom: ${win.bottom} }),`,
        `    postLineInset: ${postLineInset},`,
        '    postLineSlope: TILE_HEIGHT / TILE_WIDTH,',
        '    columnPx: DEFAULT_COLUMN_PX,',
        '    lintelDepthBias: 0,',
        `    rearWallInset: ${rearWallInset},`,
        '    interiorFloorBounds: Object.freeze({',
        `        tileRects: Object.freeze([freezeRect({ dx: ${rect.dx}, dy: ${rect.dy}, width: ${rect.width}, height: ${rect.height} })]),`,
        `        spriteBounds: Object.freeze({ left: ${b.left}, right: ${b.right}, top: ${b.top}, bottom: ${b.bottom} }),`,
        '    }),',
        '    bays: Object.freeze([',
        bayLines.join('\n'),
        '    ]),',
        '    frontArchRows: [',
        ...rowLines,
        "    ].join(''),",
        '});',
        BLOCK_CLOSE,
    ].join('\n');
}

// SHA-256 of the raw RGBA texels (not the PNG bytes), so the fingerprint
// names the art whatever encoder wrote it.
function rasterSha12(raster) {
    return createHash('sha256').update(Buffer.from(raster.data)).digest('hex').slice(0, 12);
}

function fingerprintsOf(files) {
    return { base: rasterSha12(files.base), hearth: rasterSha12(files.hearth), banked: rasterSha12(files.banked) };
}

// ─── Whole bake ──────────────────────────────────────────────────────────────

const FILES = Object.freeze({
    base: 'base.png',
    material: 'base.material.png',
    emissive: 'base.emissive.png',
    occluder: 'base.occluder.png',
    surface: 'base.surface.png',
    banked: 'banked.png',
    hearth: 'hearth.png',
    bellows: 'bellows.png',
});

export function readForgeFiles(dir = FORGE_DIR) {
    const out = {};
    for (const [key, name] of Object.entries(FILES)) {
        const path = join(dir, name);
        out[key] = existsSync(path) ? readPng(path) : null;
    }
    return out;
}

/** Bake every Forge file from the current ones. Pure; no writes. */
export function bakeForgeOpenFront(current = readForgeFiles()) {
    if (!current.base) throw new Error('building.forge/base.png is missing');
    const painted = paintForgeArcade(current.base);
    const emissive = deriveEmissive(painted, current.emissive);
    const material = deriveMaterial(painted, current.material, emissive);
    const occluder = deriveOccluder(painted, current.occluder);
    const surface = deriveSurface(painted.base, occluder, material);
    const files = {
        base: painted.base,
        material,
        emissive,
        occluder,
        surface,
        banked: bakeBankedMask(painted),
        hearth: bakeHearthMask(painted),
        bellows: bakeBellowsStrip(painted),
    };
    const calibration = calibrateForgeOpenFront(painted);
    return { painted, files, calibration, block: renderOpenFrontBlock(calibration, fingerprintsOf(files)) };
}

// ─── Invariants ──────────────────────────────────────────────────────────────

function frontEdgeSpriteY(x) {
    // Footprint SW edge (tileY = y + height) at sprite x.
    return 153 + 0.5 * x;
}

/** Invariants of a bake against the art, the manifest, the walk config and OpenFront. */
export function verifyForgeBake(bake, { original = null, manifest = loadSpriteManifest() } = {}) {
    const errors = [];
    const { files, painted, calibration } = bake;
    const { base } = files;
    if (base.width !== FORGE_NATIVE.width || base.height !== FORGE_NATIVE.height) errors.push(`base.png is ${base.width}x${base.height}, expected 256x232`);

    // Manifest: anchors and registered layers untouched.
    const entry = (manifest.buildings || []).find((candidate) => candidate.id === 'building.forge');
    if (!entry) errors.push('manifest: building.forge missing');
    else {
        if (String(entry.anchor) !== String(FORGE_NATIVE.anchor)) errors.push(`manifest: building.forge anchor ${entry.anchor} != [128,169]`);
        for (const [name, expected] of Object.entries(FORGE_REGISTERED_LAYERS)) {
            const layer = entry.layers?.[name];
            if (!layer) errors.push(`manifest: building.forge.${name} missing`);
            else if (String(layer.anchor) !== String(expected.anchor)) errors.push(`manifest: building.forge.${name} anchor moved to [${layer.anchor}]`);
        }
    }
    if (String(BUILDING_VISUAL_REGISTRY.forge?.sign?.at) !== String(FORGE_SIGN_AT)) errors.push('registry: forge sign.at moved');

    // Palette: every arcade texel is an ART_RAMPS stop or #060402, opaque.
    let offPalette = 0;
    let semi = 0;
    for (let i = 0; i < painted.region.length; i++) {
        if (!painted.region[i]) continue;
        const o = i * 4;
        if (base.data[o + 3] !== 255) semi++;
        const key = (base.data[o] << 16) | (base.data[o + 1] << 8) | base.data[o + 2];
        if (!CUTAWAY_PALETTE_KEYS.has(key)) offPalette++;
    }
    if (offPalette) errors.push(`arcade: ${offPalette} texel(s) off ART_RAMPS / #060402`);
    if (semi) errors.push(`arcade: ${semi} semi-transparent texel(s)`);
    // Silhouette preserved: alpha identical to the input everywhere.
    if (original) {
        let moved = 0;
        for (let i = 3; i < base.data.length; i += 4) if (base.data[i] !== original.data[i]) moved++;
        if (moved) errors.push(`silhouette: ${moved} texel(s) changed alpha`);
        // Outside the arcade and the relit spill, base.png is byte-identical.
        let touched = 0;
        for (let i = 0; i < painted.region.length; i++) {
            if (painted.region[i]) continue;
            const o = i * 4;
            const x = i % base.width;
            const relit = x >= RELIGHT_X[0] && x <= RELIGHT_X[1] && FIRELIT_RELIGHT[hexAt(original.data, o)];
            if (relit) continue;
            for (let c = 0; c < 4; c++) if (base.data[o + c] !== original.data[o + c]) { touched++; break; }
        }
        if (touched) errors.push(`arcade: ${touched} texel(s) outside the arcade changed`);
    }
    for (const [name, raster] of Object.entries(files)) {
        if (name === 'bellows') continue;
        if (raster.width !== base.width || raster.height !== base.height) errors.push(`${name} is ${raster.width}x${raster.height}, not registered to base.png`);
    }
    const bellows = FORGE_REGISTERED_LAYERS.bellows;
    if (files.bellows.width !== bellows.frameW * bellows.frames || files.bellows.height !== bellows.frameH) errors.push('bellows.png is not a 4 x 28 x 22 strip');

    // Exact zero-loss split through OpenFront.
    const rows = calibration.rows.join('');
    const split = splitOpenFrontMask(base.width, base.height, rows, base.data);
    if (split.frontArchCount + split.rearInteriorCount !== base.width * base.height) errors.push('split does not partition the sprite');
    for (let i = 0; i < calibration.front.length; i++) {
        if (calibration.front[i] !== split.frontArchMask[i]) {
            errors.push('encoded rows do not round-trip the front mask');
            break;
        }
    }
    // Layers drawn with the building stay on the arcade's interior, so the
    // front arch never covers them when a smith stands in the bay.
    const onInterior = (raster, offsetX = 0, offsetY = 0, frameW = raster.width, frames = 1) => {
        let off = 0;
        for (let f = 0; f < frames; f++) {
            for (let y = 0; y < raster.height; y++) {
                for (let x = 0; x < frameW; x++) {
                    if (!raster.data[(y * raster.width + f * frameW + x) * 4 + 3]) continue;
                    const sx = x + offsetX;
                    const sy = y + offsetY;
                    if (split.frontArchMask[sy * base.width + sx]) off++;
                }
            }
        }
        return off;
    };
    if (onInterior(files.hearth)) errors.push('hearth.png reaches the front arch');
    if (onInterior(files.banked)) errors.push('banked.png reaches the front arch');
    const bl = Math.round(bellows.anchor[0] - bellows.frameW / 2);
    const bt = Math.round(bellows.anchor[1] - bellows.frameH);
    if (onInterior(files.bellows, bl, bt, bellows.frameW, bellows.frames)) errors.push('bellows.png reaches the front arch');
    let hearthTexels = 0;
    for (let i = 3; i < files.hearth.data.length; i += 4) if (files.hearth.data[i]) hearthTexels++;
    if (hearthTexels < 60) errors.push(`hearth.png covers only ${hearthTexels} texels`);

    // Bays: inside an arch, on the interior floor, heads clear of the lintel,
    // between the building's column sort line and the arch's post line.
    const def = calibration.def;
    for (const bay of calibration.bays) {
        const [sx, sy] = bay.at;
        if (base.data[(sy * base.width + sx) * 4 + 3] === 0) errors.push(`${bay.id} [${sx},${sy}] stands on a transparent texel`);
        if (split.frontArchMask[sy * base.width + sx]) errors.push(`${bay.id} feet fall on the front arch`);
        const opening = openingAt(sx);
        if (!opening) errors.push(`${bay.id} [${sx},${sy}] is not inside an arch`);
        const crown = sy - SMITH_HEIGHT_PX;
        if (!(crown >= (LINTEL_TOP[sx] ?? Infinity))) errors.push(`${bay.id} crown y ${crown} reaches the lintel (y ${LINTEL_TOP[sx]})`);
        const { dx, dy } = bay.relTile;
        const rect = calibration.rect;
        if (!(dx >= rect.dx && dx < rect.dx + rect.width && dy >= rect.dy && dy < rect.dy + rect.height)) errors.push(`${bay.id} relTile (${dx}, ${dy}) is outside the bay rect`);
        const columnLine = frontEdgeSpriteY(sx) - 16.5;
        if (!(sy > columnLine)) errors.push(`${bay.id} would sort behind the Forge's own columns`);
        const archLine = frontEdgeSpriteY(sx) - calibration.postLineInset * 32;
        if (!(archLine - sy >= 4)) errors.push(`${bay.id} is within ${(archLine - sy).toFixed(1)} texels of the arch sort line`);
        if (!(FORGE_ARCADE.frontY(sx) - sy >= 3)) errors.push(`${bay.id} stands on the front plane`);
        // The walk config: a reachable work tile on the open floor.
        const visit = (def.visitTiles || []).find((tile) => tile.tileX === bay.tile.tileX && tile.tileY === bay.tile.tileY);
        if (!visit || visit.role !== 'work') errors.push(`${bay.id} tile (${bay.tile.tileX},${bay.tile.tileY}) is not a buildings.js work slot`);
        const open = (def.openFloor || []).some((r) => bay.tile.tileX >= def.x + r.dx && bay.tile.tileX < def.x + r.dx + r.width
            && bay.tile.tileY >= def.y + r.dy && bay.tile.tileY < def.y + r.dy + r.height);
        if (!open) errors.push(`${bay.id} tile is not on the Forge's openFloor`);
    }
    // The yard stays in front of the arch: yard visit tiles sort after it.
    for (const visit of def.visitTiles || []) {
        if (visit.tileY < def.y + def.height) continue;
        if (calibration.bays.some((bay) => bay.tile.tileX === visit.tileX && bay.tile.tileY === visit.tileY)) continue;
        if (!(visit.tileY > def.y + def.height - calibration.postLineInset)) errors.push(`visit tile (${visit.tileX},${visit.tileY}) would sort behind the arch line`);
    }
    return errors;
}

/** Verify a building's surface-v1 page: H16/B/valid contract + AO pairs. */
export function verifySurfacePage(type, pairs = getBuildingSurfaceAoPairs(type)) {
    const dir = join(BUILDINGS_DIR, `building.${type}`);
    const surfacePath = join(dir, 'base.surface.png');
    if (!existsSync(surfacePath)) return [`${type}: base.surface.png missing (run bake-depth-channels.mjs --id=building.${type})`];
    const surface = readPng(surfacePath);
    const albedo = readPng(join(dir, 'base.png'));
    const errors = [];
    if (surface.width !== albedo.width || surface.height !== albedo.height) {
        return [`${type}: base.surface.png ${surface.width}x${surface.height} != base.png ${albedo.width}x${albedo.height}`];
    }
    const validation = validateSurfaceV1Buffer(surface.data, albedo.data, surface.width, surface.height);
    if (!validation.ok) errors.push(...validation.errors.slice(0, 4).map((error) => `${type}: ${error}`));
    const mono = checkAoMonotonicity({ rgba: surface.data, width: surface.width, height: surface.height, pairs });
    if (!pairs.length) errors.push(`${type}: registry has no surfaceAoPairs to check AO monotonicity`);
    if (!mono.ok) errors.push(`${type}: AO not monotonic at ${JSON.stringify(mono.violations)}`);
    return errors;
}

function readBlock(source) {
    const start = source.indexOf(BLOCK_OPEN);
    const end = source.indexOf(BLOCK_CLOSE);
    if (start < 0 || end < start) return null;
    return { start, end: end + BLOCK_CLOSE.length, text: source.slice(start, end + BLOCK_CLOSE.length) };
}

function sameRaster(a, b) {
    return Boolean(a && b && a.width === b.width && a.height === b.height && Buffer.compare(Buffer.from(a.data), Buffer.from(b.data)) === 0);
}

export function forgeFingerprints(dir = FORGE_DIR) {
    return {
        base: rasterSha12(readPng(join(dir, 'base.png'))),
        hearth: rasterSha12(readPng(join(dir, 'hearth.png'))),
        banked: rasterSha12(readPng(join(dir, 'banked.png'))),
    };
}

function printHelp() {
    console.log([
        'Usage: node scripts/sprites/bake-forge-openfront.mjs [--check] [--help]',
        '',
        'Opens building.forge/base.png into the two-arch smithy arcade and re-derives',
        'base.{material,emissive,occluder,surface}.png, banked.png, hearth.png and bellows.png,',
        'then writes FORGE_OPEN_FRONT_PROFILE into OpenFront.js. 0 PixelLab generations;',
        'deterministic and idempotent.',
        '',
        '  --check   Verify every file, the profile block, the bake invariants and the',
        '            Forge/Command base.surface.png pages (H16 = 0 outside alpha, B <= 63, AO pairs).',
    ].join('\n'));
}

function main(argv = process.argv.slice(2)) {
    if (argv.includes('--help') || argv.includes('-h')) {
        printHelp();
        return 0;
    }
    const checkOnly = argv.includes('--check');
    const current = readForgeFiles();
    const bake = bakeForgeOpenFront(current);
    const errors = verifyForgeBake(bake, { original: current.base });
    const source = readFileSync(OPEN_FRONT_PATH, 'utf8');
    const block = readBlock(source);
    if (!block) errors.push(`OpenFront.js has no ${BLOCK_OPEN} … ${BLOCK_CLOSE} block`);
    if (!bake.files.surface.validation?.ok) errors.push(`surface-v1: ${bake.files.surface.validation.errors.slice(0, 3).join('; ')}`);

    if (checkOnly) {
        for (const [key, name] of Object.entries(FILES)) {
            if (!sameRaster(current[key], bake.files[key])) errors.push(`${name} is stale (run without --check)`);
        }
        if (block && block.text !== bake.block) errors.push('OpenFront.js FORGE_OPEN_FRONT_PROFILE is stale (run without --check)');
        if (OPEN_FRONT_PROFILES.forge?.frontArchRows !== bake.calibration.rows.join('')) errors.push('OPEN_FRONT_PROFILES.forge is not the measured arcade profile');
        errors.push(...verifySurfacePage('forge'));
        errors.push(...verifySurfacePage('command'));
    }
    if (errors.length) {
        for (const error of errors) console.error(`[forge:open-front] INVALID ${error}`);
        return 1;
    }
    const front = bake.calibration.front.reduce((sum, v) => sum + v, 0);
    const summary = `front arch ${front} texels in ${bake.calibration.rows.length} rows, bays ${bake.calibration.bays.map((b) => `${b.id}@[${b.at}]`).join(' ')}, postLineInset ${bake.calibration.postLineInset}`;
    if (checkOnly) {
        console.log(`[forge:open-front] OK every Forge file matches the deterministic arcade bake (${summary})`);
        console.log('[forge:open-front] OK base.surface.png pages: forge, command');
        return 0;
    }
    for (const [key, name] of Object.entries(FILES)) {
        if (sameRaster(current[key], bake.files[key])) continue;
        writeFileSync(join(FORGE_DIR, name), encodePng(bake.files[key]));
        console.log(`[forge:open-front] WROTE building.forge/${name}`);
    }
    writeFileSync(OPEN_FRONT_PATH, `${source.slice(0, block.start)}${bake.block}${source.slice(block.end)}`);
    console.log(`[forge:open-front] WROTE FORGE_OPEN_FRONT_PROFILE (${summary})`);
    return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
    process.exit(main());
}
