#!/usr/bin/env node
// 3.8 (PT-6) — Harbor hulls at art resolution.
//
// Every hull class is authored at its on-screen size (scale 1, one output
// pixel per texel) and ships as a 5-frame roll strip: -3°, -1.5°, 0, +1.5°,
// +3°, left to right. The centre frame IS the authored sprite; the other four
// are rotated about the waterline pivot at bake time with torcado's cleanEdge
// (MIT, 2022; ported from the GLSL in the PixelTechnique prototype), so the
// runtime picks `clamp(round(roll / 1.5°), -2, 2)` and never rotates or
// scales. Every frame carries a 1-px waterline lip on the hull's contact row.
//
// Usage:
//   node scripts/sprites/bake-harbor-hulls.mjs legacy <key|all>
//       Free route: resample the legacy (pre-3.8) hull art to its display
//       size, quantize onto the hull palette, bake the lip and the roll strip.
//   node scripts/sprites/bake-harbor-hulls.mjs generate <key> [--seed N] [--strength S]
//       PixelLab REST pixflux at the display size, init image = the legacy
//       art at display size, colour image = the hull palette. Guarded spend
//       (balance before/after, ledger line, the lane's 40-generation cap).
//       Writes the raw candidate to output/pixellab-cache/hulls/.
//   node scripts/sprites/bake-harbor-hulls.mjs author <key> <source.png>
//       Quantize a reviewed candidate, bake the lip and the roll strip into
//       claudeville/assets/sprites/props/prop.harborShip.<key>.png.
//   node scripts/sprites/bake-harbor-hulls.mjs rebake <key|all>
//       Re-derive the four rolled frames from each strip's own centre frame.
//   node scripts/sprites/bake-harbor-hulls.mjs normalize <key|all> [--target L]
//       Re-quantize each strip's interior wood texels along the timber ladder
//       so the upright frame's timber mean lands on the Harbor's (3.8 luma);
//       prints the manifest `masthead` (flag hoist, frame-local).
//   node scripts/sprites/bake-harbor-hulls.mjs sheet [out.png]
//       Contact sheet of every strip at 2x (review evidence).
//   node scripts/sprites/bake-harbor-hulls.mjs flowercart
//       prop.flowerCart re-authored at its 32 px display size (1x).
//
// The strip geometry (frame width, waterline, anchor) is printed for
// manifest.yaml: `width`, `height`, `frames`, `anchor` (frame-local).

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { PNG } from 'pngjs';
import { ART_RAMPS } from '../../claudeville/src/config/artPalette.js';
import { resampleCleanEdge } from '../../claudeville/src/presentation/character-mode/CleanEdge.js';
import { readPixellabToken, repoRoot } from './pixellab-rest.mjs';
import { api, createSpend, DEFAULT_LEDGER } from './pixellab-spend.mjs';

const LEGACY = join(repoRoot, 'output/waking-isle/Ships/legacy');
const CACHE = join(repoRoot, 'output/pixellab-cache/hulls');
// HULL_OUT redirects strip writes/reads (review scratch) away from the live props.
const PROPS = process.env.HULL_OUT || join(repoRoot, 'claudeville/assets/sprites/props');
const AGENT = 'Ships';
const ITEM = '3.8';
const LANE_CAP = 40;

export const ROLL_DEGREES = Object.freeze([-3, -1.5, 0, 1.5, 3]);
export const ROLL_CENTRE = 2;

// Display sizes are the legacy canvas x legacy class scale (the size the
// operator already saw), rounded. stack20 had borrowed stack30's art at 0.76;
// it gets its own 128 px hull so the tier ladder keeps its step.
export const HULLS = Object.freeze([
    { key: 'skiff', size: 52, legacy: 'skiff', legacySize: 64, legacyAnchor: [32, 50], prompt: 'tiny fantasy harbor skiff, one cream triangular sail, dark oak hull' },
    { key: 'cutter', size: 63, legacy: 'cutter', legacySize: 72, legacyAnchor: [36, 56], prompt: 'small fantasy cutter sailboat, single mast, cream sail, dark oak hull' },
    { key: 'sloop', size: 67, legacy: 'sloop', legacySize: 84, legacyAnchor: [42, 66], prompt: 'fantasy sailing sloop, two cream sails, oak hull with ochre trim' },
    { key: 'brigantine', size: 72, legacy: 'brigantine', legacySize: 96, legacyAnchor: [48, 74], prompt: 'fantasy merchant brigantine, two masts of cream square sails, stern cabin, oak hull' },
    { key: 'galleon', size: 77, legacy: 'galleon', legacySize: 112, legacyAnchor: [56, 86], prompt: 'fantasy galleon, three masts of cream sails, ornate oak hull with gold trim, stern lanterns' },
    { key: 'dreadnought', size: 84, legacy: 'dreadnought', legacySize: 128, legacyAnchor: [64, 98], prompt: 'fantasy dreadnought warship, dark oak hull, four masts of cream sails, crimson pennants' },
    { key: 'flagship', size: 92, legacy: 'flagship', legacySize: 144, legacyAnchor: [72, 110], prompt: 'mythic fantasy flagship galleon, five masts of cream sails, ornate gilded prow, stern lanterns' },
    { key: 'stack5', size: 83, legacy: 'stack5', legacySize: 104, legacyAnchor: [52, 80], prompt: 'compact flotilla of five small fantasy cargo boats lashed together, oak hulls, cream sails' },
    { key: 'stack10', size: 106, legacy: 'stack10', legacySize: 132, legacyAnchor: [66, 102], prompt: 'flotilla of ten fantasy cargo boats around a galleon, oak hulls, cream sails' },
    { key: 'stack20', size: 128, legacy: 'stack30', legacySize: 168, legacyAnchor: [84, 130], prompt: 'fleet of twenty fantasy cargo boats around a flagship galleon, oak hulls, cream sails' },
    { key: 'stack30', size: 144, legacy: 'stack30', legacySize: 168, legacyAnchor: [84, 130], prompt: 'fleet of thirty fantasy cargo boats around a flagship galleon, oak hulls, cream sails' },
    { key: 'stack40', size: 162, legacy: 'stack40', legacySize: 184, legacyAnchor: [92, 142], prompt: 'titan treasure galleon with tall cream sails and a ring of small cargo boats' },
    { key: 'stack50', size: 180, legacy: 'stack50', legacySize: 200, legacyAnchor: [100, 156], prompt: 'mythic leviathan ark with five masts of cream sails and a ring of small cargo boats' },
]);

// ≤ 24 colours on the C1 ramps: timber for hulls, the cloth ramps and the
// plaza/sand stops for sail cloth, stone for iron and shadowed canvas.
const HULL_POOL = Object.freeze([
    ART_RAMPS.void[0],
    ...ART_RAMPS.timber,
    ...ART_RAMPS.dirt.slice(1, 4),
    ...ART_RAMPS.stone.slice(1, 5),
    ART_RAMPS.plaza[0], ART_RAMPS.plaza[2], ART_RAMPS.plaza[4],
    ART_RAMPS.sand[2], ART_RAMPS.sand[4],
    ART_RAMPS.snow[4],
    ...ART_RAMPS.clothCrimson,
    ...ART_RAMPS.clothOchre,
    ART_RAMPS.emissive[1],
].map(hexToRgb));
const MAX_COLOURS = 24;
// The waterline lip: the pale shallow-water stop the lapping foam uses.
const LIP = hexToRgb(ART_RAMPS.shallowWater[2]);

function hexToRgb(hex) {
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// ─── PNG helpers ─────────────────────────────────────────────────────────────

function readPng(path) { return PNG.sync.read(readFileSync(path)); }
function writePng(path, png) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, PNG.sync.write(png)); }
function blank(w, h) { const p = new PNG({ width: w, height: h }); p.data.fill(0); return p; }
function px(png, x, y) {
    if (x < 0 || y < 0 || x >= png.width || y >= png.height) return [0, 0, 0, 0];
    const i = (png.width * y + x) << 2;
    return [png.data[i], png.data[i + 1], png.data[i + 2], png.data[i + 3]];
}
function put(png, x, y, c) {
    const i = (png.width * y + x) << 2;
    png.data[i] = c[0]; png.data[i + 1] = c[1]; png.data[i + 2] = c[2]; png.data[i + 3] = c[3];
}
function opaqueBounds(png, x0 = 0, x1 = png.width) {
    let minX = Infinity; let minY = Infinity; let maxX = -1; let maxY = -1;
    for (let y = 0; y < png.height; y++) for (let x = x0; x < x1; x++) {
        if (png.data[((png.width * y + x) << 2) + 3] < 128) continue;
        minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    }
    return maxX < 0 ? null : { minX, minY, maxX, maxY };
}

// ─── Palette ─────────────────────────────────────────────────────────────────

// Perceptual-ish nearest (redmean). Alpha is binary: pixel art has no partial
// coverage, so the fringe either becomes a pool colour or transparency.
function colourDistance(a, b) {
    const rm = (a[0] + b[0]) / 2;
    const dr = a[0] - b[0]; const dg = a[1] - b[1]; const db = a[2] - b[2];
    return (2 + rm / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rm) / 256) * db * db;
}
function nearest(c, pool) {
    let best = pool[0]; let bestD = Infinity;
    for (const p of pool) { const d = colourDistance(c, p); if (d < bestD) { bestD = d; best = p; } }
    return best;
}
export function quantizeToHullPalette(src) {
    const out = blank(src.width, src.height);
    const counts = new Map();
    for (let y = 0; y < src.height; y++) for (let x = 0; x < src.width; x++) {
        const c = px(src, x, y);
        if (c[3] < 128) continue;
        const q = nearest(c, HULL_POOL);
        put(out, x, y, [...q, 255]);
        const k = q.join(',');
        counts.set(k, (counts.get(k) || 0) + 1);
    }
    // Keep the most used ≤ 24 pool colours; fold the rest into their nearest kept.
    const kept = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_COLOURS).map(([k]) => k.split(',').map(Number));
    for (let y = 0; y < out.height; y++) for (let x = 0; x < out.width; x++) {
        const c = px(out, x, y);
        if (!c[3]) continue;
        put(out, x, y, [...nearest(c, kept), 255]);
    }
    return out;
}

function colourCount(png) {
    const set = new Set();
    for (let i = 0; i < png.data.length; i += 4) if (png.data[i + 3]) set.add(`${png.data[i]},${png.data[i + 1]},${png.data[i + 2]}`);
    return set.size;
}

// Area-majority resample of legacy art to its display size: each output texel
// takes the most frequent opaque source colour under its footprint (never an
// average), so outlines and sail seams stay palette-true.
function majorityResample(src, w, h, { outlineBias = 0.6 } = {}) {
    const out = blank(w, h);
    const sx = src.width / w; const sy = src.height / h;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const tally = new Map(); let opaque = 0; let total = 0;
        for (let yy = Math.floor(y * sy); yy < Math.ceil((y + 1) * sy); yy++) {
            for (let xx = Math.floor(x * sx); xx < Math.ceil((x + 1) * sx); xx++) {
                const c = px(src, xx, yy); total++;
                if (c[3] < 128) continue;
                opaque++;
                // Dark outline texels win ties so 1-px contours survive the shrink.
                const lum = c[0] * 0.2126 + c[1] * 0.7152 + c[2] * 0.0722;
                const key = `${c[0]},${c[1]},${c[2]}`;
                tally.set(key, (tally.get(key) || 0) + 1 + (lum < 60 ? outlineBias : 0));
            }
        }
        if (opaque * 2 < total) continue;
        let bestKey = null; let best = -1;
        for (const [k, n] of tally) if (n > best) { best = n; bestKey = k; }
        put(out, x, y, [...bestKey.split(',').map(Number), 255]);
    }
    return out;
}

// ─── Waterline lip ───────────────────────────────────────────────────────────

// The hull's contact row: per column, the lowest opaque texel of the lower
// hull. The lip is one pale-water texel under it, only across the columns
// whose lowest texel lies within 3 rows of the waterline (the keel's belly,
// not a bowsprit or an oar).
function bakeLip(src, waterline) {
    const out = blank(src.width, src.height + 1);
    src.data.copy(out.data, 0, 0, src.data.length);
    for (let x = 0; x < src.width; x++) {
        let lowest = -1;
        for (let y = src.height - 1; y >= 0; y--) if (px(src, x, y)[3] >= 128) { lowest = y; break; }
        if (lowest < 0 || lowest < waterline - 3) continue;
        put(out, x, lowest + 1, [...LIP, 255]);
    }
    return out;
}

// Rotate `src` by `deg` (clockwise on screen, the canvas `rotate` sense)
// about `pivot`, one output pixel per texel, sampled with cleanEdge.
function rotateCleanEdge(src, deg, pivot) {
    const out = blank(src.width, src.height);
    if (deg === 0) { src.data.copy(out.data); return out; }
    const a = -deg * Math.PI / 180;
    const cs = Math.cos(a); const sn = Math.sin(a);
    resampleCleanEdge(src, out.width, out.height, (x, y) => {
        const dx = x - pivot[0]; const dy = y - pivot[1];
        return [cs * dx - sn * dy + pivot[0], sn * dx + cs * dy + pivot[1]];
    }, out.data);
    return out;
}

// ─── Strip bake ──────────────────────────────────────────────────────────────

// `authored` is the lip-baked frame-0 sprite; `anchor` is its waterline pivot
// (frame-local, the lip row). Pads the frame so a ±3° roll never clips, bakes
// the four rolled frames, then crops every frame to the union bounds.
export function bakeRollStrip(authored, anchor) {
    const padX = Math.ceil(authored.height * Math.sin(3 * Math.PI / 180)) + 2;
    const padY = Math.ceil(authored.width * 0.5 * Math.sin(3 * Math.PI / 180)) + 2;
    const w = authored.width + padX * 2;
    const h = authored.height + padY * 2;
    const base = blank(w, h);
    for (let y = 0; y < authored.height; y++) for (let x = 0; x < authored.width; x++) {
        const c = px(authored, x, y);
        if (c[3]) put(base, x + padX, y + padY, c);
    }
    const pivot = [anchor[0] + padX + 0.5, anchor[1] + padY + 0.5];
    const frames = ROLL_DEGREES.map(deg => rotateCleanEdge(base, deg, pivot));
    let minX = Infinity; let minY = Infinity; let maxX = -1; let maxY = -1;
    for (const f of frames) {
        const b = opaqueBounds(f);
        if (!b) continue;
        minX = Math.min(minX, b.minX); minY = Math.min(minY, b.minY); maxX = Math.max(maxX, b.maxX); maxY = Math.max(maxY, b.maxY);
    }
    // One transparent texel of gutter on every side (sampling clamp margin).
    minX -= 1; minY -= 1; maxX += 1; maxY += 1;
    const fw = maxX - minX + 1; const fh = maxY - minY + 1;
    const strip = blank(fw * frames.length, fh);
    frames.forEach((f, i) => {
        for (let y = 0; y < fh; y++) for (let x = 0; x < fw; x++) {
            const c = px(f, x + minX, y + minY);
            if (c[3]) put(strip, i * fw + x, y, c);
        }
    });
    return { strip, frameWidth: fw, frameHeight: fh, anchor: [anchor[0] + padX - minX, anchor[1] + padY - minY] };
}

export function centreFrame(strip, frameWidth) {
    const out = blank(frameWidth, strip.height);
    for (let y = 0; y < strip.height; y++) for (let x = 0; x < frameWidth; x++) {
        const c = px(strip, ROLL_CENTRE * frameWidth + x, y);
        if (c[3]) put(out, x, y, c);
    }
    return out;
}

function hullByKey(key) {
    const hull = HULLS.find(h => h.key === key);
    if (!hull) throw new Error(`unknown hull ${key}; one of ${HULLS.map(h => h.key).join(', ')}`);
    return hull;
}

// Legacy art (the pre-3.8 PNGs are kept under output/ for re-authoring).
function legacyPng(hull) {
    const cached = join(LEGACY, `prop.harborShip.${hull.legacy}.png`);
    if (!existsSync(cached)) throw new Error(`missing legacy art ${cached}`);
    return readPng(cached);
}

// Display-size frame of the legacy art plus its waterline anchor, both at the
// old on-screen scale (legacy anchor × display/legacy size).
function legacyAtDisplay(hull) {
    const src = legacyPng(hull);
    const scale = hull.size / hull.legacySize;
    return {
        png: majorityResample(src, hull.size, hull.size),
        anchorX: Math.round(hull.legacyAnchor[0] * scale),
    };
}

// The waterline sits at the lowest opaque row of the hull's middle third.
function waterlineOf(png) {
    const third = Math.floor(png.width / 3);
    const b = opaqueBounds(png, third, png.width - third) || opaqueBounds(png);
    return b.maxY;
}

// Generated hulls sometimes carry a baked water shadow under the keel: cool
// (blue-dominant) texels at or below the lowest warm (timber) rows go.
function dropBakedWater(src) {
    const out = blank(src.width, src.height);
    src.data.copy(out.data);
    let warmBottom = -1;
    for (let y = 0; y < src.height; y++) for (let x = 0; x < src.width; x++) {
        const c = px(src, x, y);
        if (c[3] >= 128 && c[0] > c[2] + 6) warmBottom = Math.max(warmBottom, y);
    }
    for (let y = Math.max(0, warmBottom - 3); y < src.height; y++) for (let x = 0; x < src.width; x++) {
        const c = px(src, x, y);
        if (c[3] && (c[2] >= c[0] || y > warmBottom)) put(out, x, y, [0, 0, 0, 0]);
    }
    return out;
}

function author(hull, source, anchorX = null) {
    const quantized = quantizeToHullPalette(dropBakedWater(source));
    const bounds = opaqueBounds(quantized);
    const waterline = waterlineOf(quantized);
    const lipped = bakeLip(quantized, waterline);
    const ax = anchorX ?? Math.round((bounds.minX + bounds.maxX) / 2);
    const baked = bakeRollStrip(lipped, [ax, waterline + 1]);
    const out = join(PROPS, `prop.harborShip.${hull.key}.png`);
    writePng(out, baked.strip);
    console.log(`${hull.key}: ${baked.frameWidth}x${baked.frameHeight} x5 → ${baked.strip.width}x${baked.strip.height}, anchor [${baked.anchor.join(', ')}], colours ${colourCount(baked.strip)}`);
    return baked;
}

function rebake(hull) {
    const path = join(PROPS, `prop.harborShip.${hull.key}.png`);
    const strip = readPng(path);
    const fw = strip.width / ROLL_DEGREES.length;
    if (!Number.isInteger(fw)) throw new Error(`${path} is not a ${ROLL_DEGREES.length}-frame strip`);
    const frame = centreFrame(strip, fw);
    const waterline = waterlineOf(frame);
    const bounds = opaqueBounds(frame);
    const trimmed = blank(bounds.maxX - bounds.minX + 1, waterline + 1);
    for (let y = 0; y <= waterline; y++) for (let x = bounds.minX; x <= bounds.maxX; x++) {
        const c = px(frame, x, y);
        if (c[3]) put(trimmed, x - bounds.minX, y, c);
    }
    const ax = Math.round((bounds.maxX - bounds.minX) / 2);
    const baked = bakeRollStrip(trimmed, [ax, waterline]);
    writePng(path, baked.strip);
    console.log(`${hull.key}: rebaked ${baked.frameWidth}x${baked.frameHeight}, anchor [${baked.anchor.join(', ')}]`);
}

// ─── Timber value (3.8 luma) ─────────────────────────────────────────────────

// Hull timber shares the Harbor's value: the mean luma of the warm texels of
// the upright frame (the timber-hued mask the 3.8 luma audit reads) lands on
// the Harbor's own unlit timber at noon, so one scene grade leaves hull and
// pier at the same night value. Measured from the Harbor sprite in the
// git-harbor scene (68.6k timber texels, 12:00: 60.2).
export const HARBOR_TIMBER_LUMA = 60;
// One course darker / lighter along the warm wood the hull pool carries
// (timber ramp, and the dirt stops the quantizer lands plank highlights on),
// by value level, keeping each texel in its own family where a stop exists.
// Cloth (ochre, sand, crimson), stone and void never move.
const T = ART_RAMPS.timber; const D = ART_RAMPS.dirt;
const COURSE_DOWN = new Map([[D[3], D[2]], [D[2], D[1]], [D[1], T[2]], [T[3], T[2]], [T[2], T[1]], [T[1], T[0]]]);
const COURSE_UP = new Map([[T[0], T[1]], [T[1], T[2]], [T[2], T[3]], [T[3], D[2]], [D[1], D[2]], [D[2], D[3]]]);
// The sun key (upper left): the form-shadow terminator runs across the frame
// perpendicular to this (x, y) direction, frame-normalised.
const SUN_AWAY = [0.45, 0.9];
// A second course one further step past the first terminator.
const SECOND_COURSE = 0.6;

function luma(c) { return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; }
function timberHued(c) {
    const [r, g, b] = c;
    const mx = Math.max(r, g, b); const mn = Math.min(r, g, b);
    const sat = (mx - mn) / Math.max(mx, 1);
    const hue = ((Math.atan2(Math.sqrt(3) * (g - b), 2 * r - g - b) * 180 / Math.PI) + 360) % 360;
    return r > g && g >= b && hue > 8 && hue < 45 && sat > 0.3 && mx > 25 && mx < 200;
}
function hexOf(c) { return `#${((1 << 24) | (c[0] << 16) | (c[1] << 8) | c[2]).toString(16).slice(1)}`; }
// The selective outline: the darkest timber stop on the silhouette never moves.
function onSilhouette(png, x, y) {
    return px(png, x - 1, y)[3] < 128 || px(png, x + 1, y)[3] < 128 || px(png, x, y - 1)[3] < 128 || px(png, x, y + 1)[3] < 128;
}

function timberMean(strip, frameWidth) {
    let sum = 0; let n = 0;
    for (let y = 0; y < strip.height; y++) for (let x = ROLL_CENTRE * frameWidth; x < (ROLL_CENTRE + 1) * frameWidth; x++) {
        const c = px(strip, x, y);
        if (c[3] < 128 || !timberHued(c)) continue;
        sum += luma(c); n++;
    }
    return n ? sum / n : 0;
}

// Wood texels past a straight terminator (away from the sun) step one
// course darker, and past a second parallel one a second course; a too-dark
// hull instead steps its sun side lighter. Whole ramp stops only, so the
// plank drawing and its shading order survive and the change reads as a
// baked form shadow under the upper-left key, not a flattened palette.
function shadeCourses(strip, frameWidth, threshold, lighten) {
    const out = blank(strip.width, strip.height);
    strip.data.copy(out.data);
    const courses = lighten ? COURSE_UP : COURSE_DOWN;
    for (let y = 0; y < strip.height; y++) for (let x = 0; x < strip.width; x++) {
        const c = px(strip, x, y);
        if (c[3] < 128) continue;
        let hex = hexOf(c);
        if (!courses.has(hex) || (hex === T[0] && onSilhouette(strip, x, y))) continue;
        const s = SUN_AWAY[0] * (x % frameWidth) / frameWidth + SUN_AWAY[1] * y / strip.height;
        const steps = lighten
            ? (s < threshold) + (s < threshold - SECOND_COURSE)
            : (s > threshold) + (s > threshold + SECOND_COURSE);
        for (let k = 0; k < steps && courses.has(hex); k++) hex = courses.get(hex);
        if (hex !== hexOf(c)) put(out, x, y, [...hexToRgb(hex), 255]);
    }
    return out;
}

// Lands the upright frame's timber mean on `target` (within about a luma):
// the terminator slides until the mean matches. A hull already within a luma
// is left alone, so the command is idempotent.
export function normalizeTimber(strip, frameWidth, target = HARBOR_TIMBER_LUMA) {
    const before = timberMean(strip, frameWidth);
    if (!before || Math.abs(before - target) <= 1) return { strip, before, after: before, threshold: null };
    const lighten = before < target;
    let best = null;
    for (let threshold = -1.5; threshold <= 2; threshold += 0.02) {
        const shaded = shadeCourses(strip, frameWidth, threshold, lighten);
        const mean = timberMean(shaded, frameWidth);
        if (!best || Math.abs(mean - target) < Math.abs(best.after - target)) best = { strip: shaded, before, after: mean, threshold };
    }
    return best;
}

// The masthead: the top of the tallest mast in the upright frame
// (frame-local), where the repo flag hoists. Manifest `masthead`.
export function mastheadOf(strip, frameWidth) {
    const frame = centreFrame(strip, frameWidth);
    const b = opaqueBounds(frame);
    const xs = [];
    for (let x = 0; x < frame.width; x++) if (px(frame, x, b.minY)[3] >= 128) xs.push(x);
    return [xs[Math.floor((xs.length - 1) / 2)], b.minY];
}

function normalize(hull, target) {
    const path = join(PROPS, `prop.harborShip.${hull.key}.png`);
    const strip = readPng(path);
    const fw = strip.width / ROLL_DEGREES.length;
    const result = normalizeTimber(strip, fw, target);
    writePng(path, result.strip);
    console.log(`${hull.key}: timber ${result.before.toFixed(1)} → ${result.after.toFixed(1)}${result.threshold == null ? ' (unchanged)' : ` (terminator ${result.threshold.toFixed(2)})`}, masthead [${mastheadOf(result.strip, fw).join(', ')}]`);
}

// ─── PixelLab (guarded) ──────────────────────────────────────────────────────

function laneSpent(ledgerPath = DEFAULT_LEDGER) {
    if (!existsSync(ledgerPath)) return 0;
    let spent = 0;
    for (const line of readFileSync(ledgerPath, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
            const row = JSON.parse(line);
            if (row.agent !== AGENT) continue;
            // The endpoint's own usage is the per-job truth; the balance delta
            // also carries concurrent lanes' charges.
            spent += row.charged != null ? Number(row.charged) || 0 : Number(row.spent) || 0;
        } catch { /* skip */ }
    }
    return spent;
}

function paletteSwatch() {
    const png = blank(HULL_POOL.length * 4, 4);
    HULL_POOL.forEach((c, i) => { for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) put(png, i * 4 + x, y, [...c, 255]); });
    return png;
}
function b64(png) { return { type: 'base64', base64: PNG.sync.write(png).toString('base64') }; }

async function generate(hull, { seed, strength }) {
    const spentSoFar = laneSpent();
    if (spentSoFar + 1 > LANE_CAP) throw new Error(`lane cap: ${spentSoFar} of ${LANE_CAP} generations spent`);
    const token = readPixellabToken();
    const spend = createSpend({ token, agent: AGENT });
    // pixflux wants even canvas sides; an odd display size generates one
    // texel larger and the author step keeps the content, not the canvas.
    const side = hull.size + (hull.size % 2);
    const legacy = legacyAtDisplay(hull).png;
    const init = blank(side, side);
    legacy.data.copy(init.data, 0, 0, 0);
    for (let y = 0; y < legacy.height; y++) for (let x = 0; x < legacy.width; x++) {
        const c = px(legacy, x, y);
        if (c[3]) put(init, x, y, c);
    }
    const body = {
        description: `${hull.prompt}, isometric three-quarter view, pixel art, transparent background`,
        image_size: { width: side, height: side },
        text_guidance_scale: 8,
        outline: 'selective outline',
        shading: 'medium shading',
        detail: 'highly detailed',
        view: 'low top-down',
        isometric: true,
        no_background: true,
        ...(strength > 0 ? { init_image: b64(init), init_image_strength: strength } : {}),
        color_image: b64(paletteSwatch()),
        seed,
    };
    const result = await spend.job({
        item: ITEM,
        endpoint: '/create-image-pixflux',
        target: `prop.harborShip.${hull.key} ${hull.size}px seed ${seed} init ${strength}`,
        maxCost: 1,
        run: async () => {
            const json = await api(token, '/create-image-pixflux', { method: 'POST', body, label: `hull ${hull.key}` });
            const image = json?.image || json?.data?.image || json?.images?.[0] || json?.data?.images?.[0];
            if (!image?.base64) throw new Error('no image in response');
            return { png: PNG.sync.read(Buffer.from(image.base64, 'base64')), usage: json?.usage || null, ledgerDetail: { seed, strength } };
        },
    });
    const out = join(CACHE, `${hull.key}-s${seed}-i${strength}.png`);
    writePng(out, result.png);
    console.log(`candidate → ${out} (lane total ${laneSpent()} / ${LANE_CAP})`);
}

// ─── Review sheet ────────────────────────────────────────────────────────────

function sheet(outPath) {
    const k = 2; const gap = 6;
    const strips = HULLS.map(h => join(PROPS, `prop.harborShip.${h.key}.png`)).filter(existsSync).map(readPng);
    const cart = existsSync(join(PROPS, 'prop.flowerCart.png')) ? [readPng(join(PROPS, 'prop.flowerCart.png'))] : [];
    const rows = [...strips, ...cart];
    const W = Math.max(...rows.map(s => s.width)) * k + gap * 2;
    const H = rows.reduce((sum, s) => sum + s.height * k + gap, gap);
    const out = new PNG({ width: W, height: H });
    for (let i = 0; i < out.data.length; i += 4) { out.data[i] = 0x31; out.data[i + 1] = 0x42; out.data[i + 2] = 0x4a; out.data[i + 3] = 255; }
    let oy = gap;
    for (const s of rows) {
        for (let y = 0; y < s.height * k; y++) for (let x = 0; x < s.width * k; x++) {
            const c = px(s, Math.floor(x / k), Math.floor(y / k));
            if (c[3]) put(out, gap + x, oy + y, [c[0], c[1], c[2], 255]);
        }
        oy += s.height * k + gap;
    }
    writePng(outPath, out);
    console.log(`sheet → ${outPath}`);
}

// ─── Flower cart at 1x ───────────────────────────────────────────────────────

function flowerCart() {
    const path = join(PROPS, 'prop.flowerCart.png');
    const legacyCopy = join(LEGACY, 'prop.flowerCart.png');
    if (!existsSync(legacyCopy)) writePng(legacyCopy, readPng(path));
    const src = readPng(legacyCopy);
    // Onto a small C1 set (timber planks, foliage, ochre/crimson blooms) so the noisy 64 px source reads as a cart at 1x.
    const pool = [
        ...ART_RAMPS.timber, ART_RAMPS.dirt[2],
        ...ART_RAMPS.foliage.slice(1),
        ...ART_RAMPS.clothOchre, ...ART_RAMPS.clothCrimson,
        ART_RAMPS.dirt[4], ART_RAMPS.sand[4],
    ].map(hexToRgb);
    const resampled = majorityResample(src, 32, 32, { outlineBias: 0 });
    const out = blank(32, 32);
    for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) {
        const c = px(resampled, x, y);
        if (c[3]) put(out, x, y, [...nearest(c, pool), 255]);
    }
    writePng(path, out);
    console.log(`prop.flowerCart: ${src.width} → 32 px, colours ${colourCount(out)}`);
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

function argValue(args, name, fallback) {
    const i = args.indexOf(name);
    return i >= 0 ? Number(args[i + 1]) : fallback;
}

async function main() {
    const [cmd, target, extra, ...rest] = process.argv.slice(2);
    const args = process.argv.slice(2);
    const targets = () => (target === 'all' || !target ? HULLS : [hullByKey(target)]);
    if (cmd === 'legacy') {
        for (const hull of targets()) {
            const { png, anchorX } = legacyAtDisplay(hull);
            author(hull, png, anchorX);
        }
    } else if (cmd === 'generate') {
        await generate(hullByKey(target), { seed: argValue(args, '--seed', 1), strength: argValue(args, '--strength', 350) });
    } else if (cmd === 'author') {
        if (!extra) throw new Error('author <key> <source.png>');
        author(hullByKey(target), readPng(extra));
    } else if (cmd === 'rebake') {
        for (const hull of targets()) rebake(hull);
    } else if (cmd === 'normalize') {
        for (const hull of targets()) normalize(hull, argValue(args, '--target', HARBOR_TIMBER_LUMA));
    } else if (cmd === 'sheet') {
        sheet(target || join(repoRoot, 'output/waking-isle/Ships/hull-contact-2x.png'));
    } else if (cmd === 'flowercart') {
        flowerCart();
    } else if (cmd === 'spent') {
        console.log(`${AGENT} lane: ${laneSpent()} of ${LANE_CAP} generations`);
    } else {
        console.log('usage: legacy|generate|author|rebake|normalize|sheet|flowercart|spent (see header)');
        void rest; void readdirSync;
    }
}

main().catch(err => { console.error(err.message); process.exit(1); });
