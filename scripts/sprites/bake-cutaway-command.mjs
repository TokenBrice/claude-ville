#!/usr/bin/env node
// Wave 5-B (Spec 03 §1.2 item 5.2, Spec 04 §5.1, D6) — Command lifted-roof
// cutaway baker: the Miniature War Table.
//
// Writes four 360 x 240 layers beside `building.command/base.png` (anchor
// [199, 164]), every one pixel-registered with the base and confined to the
// east wing's cut parallelogram (`BUILDING_VISUAL_REGISTRY.command.aperture`):
//
//   roof.png        base.png's own wall/roof texels over the cut, byte-exact,
//                   so a closed cutaway is the shipped exterior. BuildingSprite
//                   lifts it on a 4 x 4 Bayer order in four 150 ms steps.
//   aperture.png    the hall's back wall (coursed ashlar, two sconces, a
//                   crimson standard) and flagstone floor.
//   interior.png    the 26 x 10 oak war table body centred on [270, 184]
//                   (the same sheared top `drawCommandWarTable` repaints live,
//                   plus its apron and legs) and the front and rear desks
//                   that occlude their occupants' legs.
//   foreground.png  the sawn floor-slab sill and the wall-thickness jambs.
//
// Zero PixelLab generations: every texel is either a base.png crop (`roof`)
// or an ART_RAMPS stop / the #060402 selective ink, with zero semi-alpha.
// This module also exports the shared cutaway kit used by
// bake-cutaway-archive.mjs and bake-cutaway-harbor.mjs.
//
// Usage:
//   node scripts/sprites/bake-cutaway-command.mjs           # write the 4 layers
//   node scripts/sprites/bake-cutaway-command.mjs --check   # verify on-disk bytes + invariants
//   node scripts/sprites/bake-cutaway-command.mjs --help

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { ART_RAMPS } from '../../claudeville/src/config/artPalette.js';
import { apertureCutContains, normalizeApertureLayers } from '../../claudeville/src/presentation/character-mode/BuildingApertureModel.js';
import { COMMAND_CUTAWAY_PROFILE } from '../../claudeville/src/presentation/character-mode/BuildingCutaways.js';
import {
    apertureFloorY,
    getBuildingApertureProfile,
} from '../../claudeville/src/presentation/character-mode/BuildingVisualRegistry.js';

// ─── Shared cutaway kit ──────────────────────────────────────────────────────

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
export const BUILDINGS_DIR = join(REPO_ROOT, 'claudeville/assets/sprites/buildings');
export const OUTLINE_INK = '#060402';
export const R = ART_RAMPS;

function normHex(hex) {
    const text = String(hex || '').trim().toLowerCase();
    if (!/^#[0-9a-f]{6}$/.test(text)) throw new RangeError(`not a #rrggbb colour: ${hex}`);
    return text;
}

export function hexToRgb(hex) {
    const text = normHex(hex);
    return [parseInt(text.slice(1, 3), 16), parseInt(text.slice(3, 5), 16), parseInt(text.slice(5, 7), 16)];
}

function rgbKey(r, g, b) {
    return (r << 16) | (g << 8) | b;
}

// Every authored texel is an ART_RAMPS stop or the selective outline ink.
export const CUTAWAY_PALETTE_KEYS = new Set(
    [...Object.values(ART_RAMPS).flat(), OUTLINE_INK].map((hex) => rgbKey(...hexToRgb(hex))),
);

export function readPng(path) {
    const png = PNG.sync.read(readFileSync(path));
    return { width: png.width, height: png.height, data: new Uint8Array(png.data) };
}

export function encodePng(raster) {
    const png = new PNG({ width: raster.width, height: raster.height, colorType: 6 });
    png.data = Buffer.from(raster.data);
    return PNG.sync.write(png, { colorType: 6 });
}

/**
 * The texels a cutaway owns: pixel centres inside the cut parallelogram
 * (`apertureCutContains(cut, x + 0.5, y + 0.5)`, the sign-box convention) on
 * base.png's opaque silhouette.
 */
export function cutawayMask(cut, base) {
    const mask = new Uint8Array(base.width * base.height);
    for (let y = 0; y < base.height; y++) {
        for (let x = 0; x < base.width; x++) {
            const i = y * base.width + x;
            if (base.data[i * 4 + 3] > 0 && apertureCutContains(cut, x + 0.5, y + 0.5)) mask[i] = 1;
        }
    }
    return mask;
}

/** Inclusive integer row span of one cut column (pixel centres), or null. */
export function cutColumn(mask, width, height, x) {
    let top = -1;
    let bottom = -1;
    for (let y = 0; y < height; y++) {
        if (!mask[y * width + x]) continue;
        if (top < 0) top = y;
        bottom = y;
    }
    return top < 0 ? null : { top, bottom };
}

export function maskBounds(mask, width, height) {
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            if (!mask[y * width + x]) continue;
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
        }
    }
    return { minX, maxX, minY, maxY };
}

/** A clipped RGBA8 paint target: writes outside `clip` (or the canvas) drop. */
export class PixelLayer {
    constructor(width, height, clip = null) {
        this.width = width;
        this.height = height;
        this.clip = clip;
        this.data = new Uint8Array(width * height * 4);
    }

    inside(x, y) {
        if (!Number.isInteger(x) || !Number.isInteger(y)) return false;
        if (x < 0 || y < 0 || x >= this.width || y >= this.height) return false;
        return !this.clip || this.clip[y * this.width + x] === 1;
    }

    set(x, y, hex) {
        const ix = Math.round(x);
        const iy = Math.round(y);
        if (!this.inside(ix, iy)) return;
        const [r, g, b] = hexToRgb(hex);
        const o = (iy * this.width + ix) * 4;
        this.data[o] = r;
        this.data[o + 1] = g;
        this.data[o + 2] = b;
        this.data[o + 3] = 255;
    }

    opaque(x, y) {
        if (x < 0 || y < 0 || x >= this.width || y >= this.height) return false;
        return this.data[(y * this.width + x) * 4 + 3] > 0;
    }

    rect(x, y, w, h, hex) {
        for (let yy = y; yy < y + h; yy++) {
            for (let xx = x; xx < x + w; xx++) this.set(xx, yy, hex);
        }
    }

    vline(x, y0, y1, hex) {
        for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++) this.set(x, y, hex);
    }

    hline(y, x0, x1, hex) {
        for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) this.set(x, y, hex);
    }

    /** 1px outline in `hex` around every opaque texel of `inner` (4-connected). */
    outline(inner, hex) {
        const marks = [];
        for (let y = 0; y < this.height; y++) {
            for (let x = 0; x < this.width; x++) {
                if (inner.opaque(x, y)) continue;
                if (inner.opaque(x - 1, y) || inner.opaque(x + 1, y) || inner.opaque(x, y - 1) || inner.opaque(x, y + 1)) {
                    marks.push([x, y]);
                }
            }
        }
        for (const [x, y] of marks) this.set(x, y, hex);
    }

    /** Copy every opaque texel of `other` over this layer (respecting the clip). */
    stamp(other) {
        for (let y = 0; y < this.height; y++) {
            for (let x = 0; x < this.width; x++) {
                const o = (y * this.width + x) * 4;
                if (other.data[o + 3] === 0 || !this.inside(x, y)) continue;
                this.data[o] = other.data[o];
                this.data[o + 1] = other.data[o + 1];
                this.data[o + 2] = other.data[o + 2];
                this.data[o + 3] = 255;
            }
        }
    }
}

/** Stable integer hash for deterministic texture variation. */
export function hash2(x, y, seed = 0) {
    let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(seed | 0, 2246822519)) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0);
}

/** base.png's own texels over the cutaway mask: the lifted roof/wall layer. */
export function cropRoof(base, mask) {
    const out = new PixelLayer(base.width, base.height);
    for (let i = 0; i < mask.length; i++) {
        if (!mask[i]) continue;
        const o = i * 4;
        out.data[o] = base.data[o];
        out.data[o + 1] = base.data[o + 1];
        out.data[o + 2] = base.data[o + 2];
        out.data[o + 3] = base.data[o + 3];
    }
    return out;
}

/**
 * Coursed ashlar wall fill along a wall slope: `rows` per course, joints every
 * `joint` columns staggered by half a stone each course. `courseOrigin(x)` is
 * the row a course boundary passes through in that column.
 */
export function paintCoursedWall(layer, { x0, x1, top, bottom, slope, originX, originY, rows = 5, joint = 10, base, mortar, lit = null, dark = null, seed = 1 }) {
    for (let x = x0; x <= x1; x++) {
        const lineY = originY + slope * (x - originX);
        for (let y = top(x); y <= bottom(x); y++) {
            const rel = y - lineY;
            const course = Math.floor(rel / rows);
            const inCourse = ((rel % rows) + rows) % rows;
            const stagger = (course & 1) ? Math.floor(joint / 2) : 0;
            const col = ((x - originX + stagger) % joint + joint) % joint;
            let color = base;
            const stone = Math.floor((x - originX + stagger) / joint);
            const variant = hash2(stone, course, seed) % 7;
            if (lit && variant === 0) color = lit;
            if (dark && variant === 1) color = dark;
            if (inCourse === 0 || col === 0) color = mortar;
            layer.set(x, y, color);
        }
    }
}

/** Flagstone floor between two slope lines with cross joints at `crossSlope`. */
export function paintFlagstones(layer, { x0, x1, top, bottom, slope, crossSlope, originX, originY, rows = 5, joint = 12, base, mortar, lit = null, seed = 3 }) {
    for (let x = x0; x <= x1; x++) {
        const lineY = originY + slope * (x - originX);
        for (let y = top(x); y <= bottom(x); y++) {
            const rel = Math.floor(y - lineY);
            const course = Math.floor(rel / rows);
            const inCourse = ((rel % rows) + rows) % rows;
            // Cross joints run along `crossSlope`: project the texel onto the
            // wall axis through the cross direction.
            const along = crossSlope === slope ? x : x - (y - lineY) / (crossSlope - slope);
            const stagger = (course & 1) ? joint / 2 : 0;
            const u = along - originX + stagger;
            const col = ((Math.floor(u) % joint) + joint) % joint;
            const stone = Math.floor(u / joint);
            let color = base;
            if (lit && hash2(stone, course, seed) % 5 === 0) color = lit;
            if (inCourse === 0 || col === 0) color = mortar;
            layer.set(x, y, color);
        }
    }
}

/** A wall sconce: iron bracket, two-texel flame (no glow: zero semi-alpha). */
export function paintSconce(layer, x, y) {
    layer.set(x, y + 2, OUTLINE_INK);
    layer.set(x, y + 1, R.timber[0]);
    layer.set(x - 1, y + 1, R.timber[0]);
    layer.set(x + 1, y + 1, R.timber[0]);
    layer.set(x, y, R.emissive[0]);
    layer.set(x, y - 1, R.emissive[1]);
}

/**
 * Validate one authored layer: dimensions, zero semi-alpha, every texel inside
 * `mask` and on the cutaway palette (ART_RAMPS + #060402).
 */
export function inspectAuthoredLayer(name, raster, { width, height, mask }) {
    const errors = [];
    if (raster.width !== width || raster.height !== height) {
        errors.push(`${name}: ${raster.width}x${raster.height}, expected ${width}x${height}`);
        return errors;
    }
    let semi = 0;
    let offPalette = 0;
    let outside = 0;
    let opaque = 0;
    for (let i = 0; i < width * height; i++) {
        const o = i * 4;
        const a = raster.data[o + 3];
        if (a === 0) continue;
        opaque++;
        if (a !== 255) semi++;
        if (!CUTAWAY_PALETTE_KEYS.has(rgbKey(raster.data[o], raster.data[o + 1], raster.data[o + 2]))) offPalette++;
        if (mask && !mask[i]) outside++;
    }
    if (!opaque) errors.push(`${name}: no opaque texels`);
    if (semi) errors.push(`${name}: ${semi} semi-transparent texel(s)`);
    if (offPalette) errors.push(`${name}: ${offPalette} texel(s) off ART_RAMPS / #060402`);
    if (outside) errors.push(`${name}: ${outside} texel(s) outside the cut on base.png's silhouette`);
    return errors;
}

/** The roof layer must be base.png's own texels over the mask, byte-exact. */
export function inspectRoofLayer(raster, base, mask) {
    const errors = [];
    if (raster.width !== base.width || raster.height !== base.height) {
        return [`roof: ${raster.width}x${raster.height}, expected ${base.width}x${base.height}`];
    }
    let mismatched = 0;
    for (let i = 0; i < mask.length; i++) {
        const o = i * 4;
        for (let c = 0; c < 4; c++) {
            const expected = mask[i] ? base.data[o + c] : 0;
            if (raster.data[o + c] !== expected) {
                mismatched++;
                break;
            }
        }
    }
    if (mismatched) errors.push(`roof: ${mismatched} texel(s) differ from base.png's crop over the cut`);
    return errors;
}

/**
 * Every slot inside the cut, below the back-wall floor line and on an opaque
 * floor texel of the aperture layer (the floor it stands on).
 */
export function inspectSlots(aperture, apertureLayer, slots) {
    const errors = [];
    for (const slot of slots) {
        const [x, y] = slot.at;
        const label = `slot ${slot.id ?? slot.bay ?? slot.index} [${x}, ${y}]`;
        if (!apertureCutContains(aperture.cut, x, y)) errors.push(`${label} lies outside the cut`);
        const floorY = apertureFloorY(aperture, x);
        if (Number.isFinite(floorY) && !(y > floorY)) errors.push(`${label} stands above the floor line (y ${floorY.toFixed(2)})`);
        const px = Math.floor(x);
        const py = Math.floor(y);
        if (!apertureLayer.opaque(px, py)) errors.push(`${label} is not on an opaque aperture floor texel`);
    }
    return errors;
}

function bytesEqual(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
}

/**
 * Shared CLI: bake in memory, validate, then write or `--check` the on-disk
 * PNGs (decoded RGBA must match byte-for-byte).
 */
export function runCutawayBakerCli({ label, dir, bake, argv = process.argv.slice(2), usage }) {
    if (argv.includes('--help') || argv.includes('-h')) {
        console.log(usage);
        return 0;
    }
    const checkOnly = argv.includes('--check');
    const outArg = argv.find((arg) => arg.startsWith('--out='));
    const outDir = outArg ? outArg.slice('--out='.length) : null;
    const result = bake();
    if (result.errors.length) {
        for (const error of result.errors) console.error(`[${label}] INVALID ${error}`);
        return 1;
    }
    let failures = 0;
    for (const [name, raster] of Object.entries(result.layers)) {
        const path = join(outDir || dir, `${name}.png`);
        if (checkOnly) {
            if (!existsSync(path)) {
                console.error(`[${label}] MISSING ${name}.png (run without --check to bake it)`);
                failures++;
                continue;
            }
            const disk = readPng(path);
            if (disk.width !== raster.width || disk.height !== raster.height || !bytesEqual(disk.data, raster.data)) {
                console.error(`[${label}] STALE ${name}.png differs from the deterministic bake`);
                failures++;
                continue;
            }
            console.log(`[${label}] OK ${name}.png matches the deterministic bake (${raster.width}x${raster.height})`);
        } else {
            writeFileSync(path, encodePng(raster));
            console.log(`[${label}] WROTE ${name}.png (${raster.width}x${raster.height})`);
        }
    }
    for (const note of result.notes || []) console.log(`[${label}] ${note}`);
    return failures ? 1 : 0;
}

// ─── Command — the Miniature War Table ───────────────────────────────────────

export const COMMAND_DIR = join(BUILDINGS_DIR, 'building.command');
const WAR_TABLE = COMMAND_CUTAWAY_PROFILE.table;
const INK = OUTLINE_INK;

/** Column-by-column top rows of the sheared war table, as drawCommandWarTable paints it. */
export function warTableColumns(table = WAR_TABLE) {
    const halfW = (table.width - 1) / 2;
    const halfH = (table.height - 1) / 2;
    const cols = [];
    for (let col = 0; col < table.width; col++) {
        const dx = col - halfW;
        cols.push({
            col,
            x: Math.round(table.center[0] + dx),
            top: Math.round(table.center[1] - halfH + dx * table.slope),
        });
    }
    return cols;
}

function paintCommandAperture(layer, aperture, mask, base) {
    const { width, height } = base;
    const floorY = (x) => apertureFloorY(aperture, x);
    const { minX, maxX } = maskBounds(mask, width, height);
    const span = (x) => cutColumn(mask, width, height, x);

    // Back wall: coursed ashlar, ceiling beam above, shadowed base course.
    paintCoursedWall(layer, {
        x0: minX,
        x1: maxX,
        top: (x) => span(x).top,
        bottom: (x) => Math.ceil(floorY(x)) - 1,
        slope: aperture.cut.slope,
        originX: aperture.cut.x0,
        originY: aperture.cut.top,
        rows: 5,
        joint: 11,
        base: R.ashlar[2],
        mortar: R.ashlar[1],
        lit: R.ashlar[3],
        seed: 11,
    });
    // Floor: cool flagstones, warm lit flags around the table.
    paintFlagstones(layer, {
        x0: minX,
        x1: maxX,
        top: (x) => Math.ceil(floorY(x)),
        bottom: (x) => span(x).bottom,
        slope: aperture.cut.slope,
        crossSlope: 0.5,
        originX: aperture.cut.x0,
        originY: aperture.floor.at[1],
        rows: 4,
        joint: 9,
        base: R.ashlar[4],
        mortar: R.ashlar[3],
        lit: R.ashlar[5],
        seed: 5,
    });
    for (let x = minX; x <= maxX; x++) {
        const col = span(x);
        // Ceiling: the wing's roof timbers seen from below.
        layer.set(x, col.top, R.timber[0]);
        layer.set(x, col.top + 1, R.timber[0]);
        layer.set(x, col.top + 2, R.timber[1]);
        if ((x - minX) % 12 === 5) {
            // Joist ends along the wall plate.
            layer.set(x, col.top + 2, R.timber[2]);
            layer.set(x + 1, col.top + 2, R.timber[2]);
            layer.set(x, col.top + 3, R.timber[0]);
            layer.set(x + 1, col.top + 3, R.timber[0]);
        }
        // Shadowed skirting where the back wall meets the floor.
        const fy = Math.ceil(floorY(x));
        layer.set(x, fy - 1, R.ashlar[1]);
        layer.set(x, fy, R.ashlar[3]);
    }
    // Two wall sconces flanking the table and a crimson standard between.
    for (const sx of [252, 300]) {
        const sy = Math.ceil(floorY(sx)) - 11;
        paintSconce(layer, sx, sy);
    }
    const bannerX = 282;
    const bannerTop = span(bannerX).top + 5;
    for (let dx = -2; dx <= 2; dx++) {
        const x = bannerX + dx;
        const top = bannerTop + Math.round(dx * aperture.cut.slope);
        layer.set(x, top - 1, R.timber[1]);
        const length = 8 - Math.abs(dx === 0 ? -1 : 0);
        for (let r = 0; r < length; r++) {
            const edge = dx === -2 || dx === 2;
            layer.set(x, top + r, edge ? R.clothCrimson[0] : R.clothCrimson[1]);
        }
        layer.set(x, top + length, dx === 0 ? R.clothCrimson[0] : INK);
    }
    layer.set(bannerX, bannerTop + 3, R.trimGold[2]);
    layer.set(bannerX, bannerTop + 2, R.trimGold[1]);
    layer.set(bannerX - 1, bannerTop + 3, R.trimGold[1]);
    layer.set(bannerX + 1, bannerTop + 2, R.trimGold[1]);
}

// A small iso desk: top surface sheared along the wall, front face below.
function paintDesk(layer, { cx, foot, w = 13, slope, topH = 3, faceH = 4, top = R.timber[3], face = R.timber[1], dark = R.timber[0] }) {
    const half = Math.floor(w / 2);
    const body = new PixelLayer(layer.width, layer.height, layer.clip);
    for (let dx = -half; dx <= half; dx++) {
        const x = cx + dx;
        const shear = Math.round(dx * slope);
        const yFaceBottom = foot - 1 + shear;
        const yFaceTop = yFaceBottom - faceH + 1;
        const yTopTop = yFaceTop - topH;
        for (let y = yTopTop; y < yFaceTop; y++) body.set(x, y, y === yTopTop ? R.timber[3] : top);
        for (let y = yFaceTop; y <= yFaceBottom; y++) {
            const edge = dx === -half || dx === half;
            body.set(x, y, edge ? dark : (y === yFaceTop ? R.timber[2] : face));
        }
    }
    layer.outline(body, INK);
    layer.stamp(body);
    return { half };
}

function paintCommandInterior(layer, aperture) {
    const slope = aperture.cut.slope;
    // The war table body: the same sheared top drawCommandWarTable repaints
    // every frame, then its apron and four legs down to the floor.
    const table = new PixelLayer(layer.width, layer.height, layer.clip);
    const cols = warTableColumns();
    for (const { col, x, top } of cols) {
        const edge = col === 0 || col === WAR_TABLE.width - 1;
        for (let r = 0; r < WAR_TABLE.height; r++) {
            const inner = !edge && r >= 1 && r <= WAR_TABLE.height - 2;
            table.set(x, top + r, inner ? R.plaza[1] : (edge ? R.timber[1] : R.timber[2]));
        }
        // Apron: the table's near face.
        const apron = top + WAR_TABLE.height;
        table.set(x, apron, R.timber[2]);
        table.set(x, apron + 1, R.timber[1]);
        const leg = col === 1 || col === 2 || col === WAR_TABLE.width - 3 || col === WAR_TABLE.width - 2;
        if (leg) {
            table.set(x, apron + 2, R.timber[0]);
            table.set(x, apron + 3, R.timber[0]);
        }
    }
    // Carved relief on the tabletop's rim (overpainted live by the table top).
    for (const { col, x, top } of cols) {
        if (col % 5 === 2) table.set(x, top + 1, R.plaza[2]);
    }
    layer.outline(table, INK);
    layer.stamp(table);

    // Front desk (`tinker`): a writing desk with an open ledger and a candle.
    const front = COMMAND_CUTAWAY_PROFILE.slots.find((slot) => slot.bay === 'front-desk').at;
    paintDesk(layer, { cx: front[0], foot: front[1] + 2, slope });
    const fx = front[0];
    const fTop = front[1] + 2 - 1 - 4 - 3;
    layer.set(fx - 2, fTop + 1, R.sand[4]);
    layer.set(fx - 1, fTop + 1, R.sand[3]);
    layer.set(fx, fTop, R.sand[4]);
    layer.set(fx + 1, fTop, R.sand[3]);
    layer.set(fx + 4, fTop - 1, R.sand[4]);
    layer.set(fx + 4, fTop - 2, R.emissive[1]);

    // Rear desk (`gaze`): an instrument desk with a brass astrolabe.
    const rear = COMMAND_CUTAWAY_PROFILE.slots.find((slot) => slot.bay === 'rear-desk').at;
    paintDesk(layer, { cx: rear[0], foot: rear[1] + 2, slope });
    const ax = rear[0] + 1;
    const ay = rear[1] + 2 - 1 - 4 - 3 + Math.round(1 * slope) - 3;
    const ring = new PixelLayer(layer.width, layer.height, layer.clip);
    for (const [dx, dy, c] of [
        [0, -2, R.trimGold[2]], [-1, -1, R.trimGold[1]], [1, -1, R.trimGold[2]],
        [-1, 0, R.trimGold[1]], [1, 0, R.trimGold[2]], [0, 1, R.trimGold[0]],
        [0, -1, R.trimGold[3]], [0, 2, R.timber[0]], [0, 0, R.trimGold[0]],
    ]) ring.set(ax + dx, ay + dy, c);
    layer.outline(ring, INK);
    layer.stamp(ring);
}

function paintCommandForeground(layer, aperture, mask, base) {
    const { width, height } = base;
    const { minX, maxX } = maskBounds(mask, width, height);
    for (let x = minX; x <= maxX; x++) {
        const col = cutColumn(mask, width, height, x);
        // The sawn floor-slab sill.
        layer.set(x, col.bottom, INK);
        layer.set(x, col.bottom - 1, R.ashlar[5]);
        layer.set(x, col.bottom - 2, R.ashlar[7]);
    }
    // Far jamb: the wall edge the cut leaves at the corner pillar.
    const left = cutColumn(mask, width, height, minX);
    for (let y = left.top; y <= left.bottom; y++) layer.set(minX, y, INK);
    // Near jamb: the wall's sawn thickness against the right pilaster.
    for (let x = maxX - 2; x <= maxX; x++) {
        const col = cutColumn(mask, width, height, x);
        const color = x === maxX ? INK : (x === maxX - 1 ? R.ashlar[5] : R.ashlar[6]);
        for (let y = col.top; y <= col.bottom; y++) layer.set(x, y, color);
    }
}

export function bakeCommandCutaway({ base = readPng(join(COMMAND_DIR, 'base.png')) } = {}) {
    const aperture = getBuildingApertureProfile('command');
    const errors = [];
    const notes = [];
    if (!aperture) return { errors: ['registry: command has no aperture profile'], layers: {} };
    const stack = normalizeApertureLayers(aperture.layers);
    if (!stack?.hasRoof) errors.push('registry: command aperture must be a 4-layer lifted-roof cutaway');
    const mask = cutawayMask(aperture.cut, base);

    const roof = cropRoof(base, mask);
    const ap = new PixelLayer(base.width, base.height, mask);
    paintCommandAperture(ap, aperture, mask, base);
    const interior = new PixelLayer(base.width, base.height, mask);
    paintCommandInterior(interior, aperture);
    const foreground = new PixelLayer(base.width, base.height, mask);
    paintCommandForeground(foreground, aperture, mask, base);

    // The aperture covers the whole cut, so no exterior texel peeks through.
    let uncovered = 0;
    for (let i = 0; i < mask.length; i++) if (mask[i] && ap.data[i * 4 + 3] === 0) uncovered++;
    if (uncovered) errors.push(`aperture: ${uncovered} cut texel(s) left uncovered`);
    const dims = { width: base.width, height: base.height, mask };
    errors.push(...inspectRoofLayer(roof, base, mask));
    errors.push(...inspectAuthoredLayer('aperture', ap, dims));
    errors.push(...inspectAuthoredLayer('interior', interior, dims));
    errors.push(...inspectAuthoredLayer('foreground', foreground, dims));
    errors.push(...inspectSlots(aperture, ap, aperture.slots));
    // The war table sits on the floor, inside the cut.
    for (const { x, top } of warTableColumns()) {
        if (!(top > apertureFloorY(aperture, x))) errors.push(`war table column x ${x} rises above the floor line`);
        if (!mask[top * base.width + x]) errors.push(`war table column x ${x} leaves the cut`);
    }
    notes.push(`cut texels ${mask.reduce((sum, v) => sum + v, 0)}, war table ${WAR_TABLE.width}x${WAR_TABLE.height} at [${WAR_TABLE.center}]`);
    return {
        errors,
        notes,
        mask,
        layers: {
            [stack?.roof || 'roof']: roof,
            [stack?.aperture || 'aperture']: ap,
            [stack?.interior || 'interior']: interior,
            [stack?.foreground || 'foreground']: foreground,
        },
    };
}

const USAGE = [
    'Usage: node scripts/sprites/bake-cutaway-command.mjs [--check] [--help]',
    '',
    'Bakes building.command/{roof,aperture,interior,foreground}.png (360x240, anchor [199,164]):',
    'the Spec 04 §5.1 Miniature War Table lifted-roof cutaway. 0 PixelLab generations.',
    '',
    '  --check      Verify the on-disk layers match the deterministic bake and its invariants.',
    '  --out=<dir>  Write (or check) the layers in <dir> instead of the sprite folder.',
].join('\n');

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
    process.exit(runCutawayBakerCli({ label: 'cutaway:command', dir: COMMAND_DIR, bake: bakeCommandCutaway, usage: USAGE }));
}
