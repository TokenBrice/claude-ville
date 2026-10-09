#!/usr/bin/env node
// Foliage pass (Opus 5.5 aesthetic plan, item 2.2): strips the baked diamond
// plinths off the tree sprites so every trunk meets the terrain, and re-tones
// the canopies onto the C1 foliage (sage) ramp in
// `claudeville/src/config/artPalette.js`.
//
// Plinth strip: below `cutRow` only pixels inside the per-row trunk/root span
// survive, and only if they are wood (not grass green, not sand); dark outline
// pixels survive only when they touch surviving wood. Rows past `lastRow` are
// cleared. Nothing outside the base region is touched.
//
// Re-tone: foliage pixels (green hue band) move value and saturation by the
// per-sprite scales and pull their hue toward the ramp hue at the new value
// (the ramp runs cool 150° in shadow to warm 72° in highlight), so species keep
// their identity (pine cooler, willow olive) while sharing one family. Wood
// pixels only lose a little saturation. Alpha is never changed except where the
// plinth is cut (0 -> stays 0; cut pixels -> 0).
//
// The pass is not idempotent, so each target carries the sha256 of its
// original; a file whose hash does not match is skipped (already processed or
// edited since) unless --force is given.
//
// Usage:
//   node scripts/sprites/foliage-pass.mjs [--dry-run] [--force] [--preview=<dir>]

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { PNG } from 'pngjs';
import { ART_RAMPS } from '../../claudeville/src/config/artPalette.js';
import { TREE_SPRITES } from '../../claudeville/src/presentation/character-mode/FoliageRenderer.js';
import { repoRoot } from './manifest-utils.mjs';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const force = args.includes('--force');
const previewArg = args.find((arg) => arg.startsWith('--preview='));
const previewDir = previewArg ? previewArg.slice('--preview='.length) : null;

const VEG = join(repoRoot, 'claudeville', 'assets', 'sprites', 'vegetation');

// spans: [row, x0, x1] inclusive trunk/root spans kept below cutRow.
const TARGETS = [
    {
        file: 'veg.tree.oak.large.png',
        sha256: '9737d72e45526354365f6478f1cd9d5260c754caf8dd3a9b300e58f0381a2626',
        cutRow: 44,
        lastRow: 50,
        spans: [[44, 25, 40], [45, 23, 41], [46, 22, 42], [47, 21, 44], [48, 21, 44], [49, 22, 42], [50, 24, 40]],
        tone: { sat: 0.80, val: 0.86, hueBlend: 0.45, woodSat: 0.85 },
    },
    {
        file: 'veg.tree.oak.small.png',
        sha256: 'd7d02acf04b4b98c2137e21cdf7448cba5dd43ad1c9d633a36d849c82f4004ad',
        cutRow: 25,
        lastRow: 27,
        spans: [[25, 12, 18], [26, 11, 19], [27, 12, 18]],
        tone: { sat: 0.70, val: 0.82, hueBlend: 0.50, woodSat: 0.85 },
    },
    {
        file: 'veg.tree.pine.large.png',
        sha256: '097fd73d541c473cc30558d59d9c5ba62011f03ed70ce64d48de5a3190890129',
        cutRow: 42,
        lastRow: 51,
        spans: [[42, 29, 35], [43, 29, 35], [44, 29, 35], [45, 29, 35], [46, 29, 36], [47, 28, 36], [48, 28, 37], [49, 27, 38], [50, 27, 38], [51, 28, 37]],
        tone: { sat: 0.62, val: 0.84, hueBlend: 0.25, woodSat: 0.85 },
    },
    {
        file: 'veg.tree.willow.large.png',
        sha256: '99f576991c800db0b10c0028016a2dcb8e5135c6ca33f71b1db667814a680df5',
        cutRow: 47,
        lastRow: 52,
        spans: [[47, 26, 36], [48, 26, 36], [49, 25, 37], [50, 25, 37], [51, 26, 36], [52, 27, 35]],
        tone: { sat: 0.84, val: 0.80, hueBlend: 0.35, woodSat: 0.80 },
    },
    {
        file: 'veg.tree.willow.small.png',
        sha256: '4cf6f1dc55cb5e6270a88b30b762b388cdeda3b1bce0cebeed3875b6fe4315d8',
        cutRow: 26,
        lastRow: 26,
        spans: [[26, 13, 17]],
        tone: { sat: 0.80, val: 0.80, hueBlend: 0.35, woodSat: 0.80 },
    },
];

const RAMP = ART_RAMPS.foliage.map(hexToHsv); // dark -> light

let processed = 0;
for (const target of TARGETS) {
    const path = join(VEG, target.file);
    const bytes = readFileSync(path);
    const sha = createHash('sha256').update(bytes).digest('hex');
    if (sha !== target.sha256 && !force) {
        console.log(`[foliage-pass] skip ${target.file} (hash ${sha.slice(0, 12)} is not the original; --force to reprocess)`);
        continue;
    }
    const png = PNG.sync.read(bytes);
    const stats = processSprite(png, target);
    processed++;
    console.log(`[foliage-pass] ${target.file}: cut ${stats.cut} px, re-toned ${stats.foliage} foliage + ${stats.wood} wood px`);
    const out = PNG.sync.write(png);
    if (previewDir) {
        mkdirSync(previewDir, { recursive: true });
        writeFileSync(join(previewDir, basename(target.file)), out);
    } else if (!dryRun) {
        writeFileSync(path, out);
    }
}
console.log(`[foliage-pass] ${processed} sprite(s) ${previewDir ? `previewed to ${previewDir}` : dryRun ? 'checked (dry run)' : 'written'}`);

// Plan 5.5 sheets (tall woodland trees and the bare/snow winter states) and
// the world ash's sheets were authored palette-snapped and plinth-free, so the
// pass never re-tones them (a re-tone would move them off the C1 stops); it
// checks them instead: binary alpha, every pixel a stop of the
// leaf/wood/snow ramps, nothing below the trunk-base row, and each winter
// state on its leafy sheet's canvas and trunk base. Exits 1 on a failed check.
// W8.3d bark: the birch's white trunk sits on `ashlar`, the maple's and
// poplar's grey bark on `stone`.
const AUTHORED_RAMPS = ['foliage', 'foliageSun', 'foliageDeep', 'timber', 'snow', 'ashlar', 'stone'];
const authoredStops = new Set(AUTHORED_RAMPS.flatMap((key) => ART_RAMPS[key].map((hex) => hex.toLowerCase())));
const baseRow = (png) => {
    for (let y = png.height - 1; y >= 0; y--) {
        for (let x = 0; x < png.width; x++) if (png.data[(y * png.width + x) * 4 + 3]) return y;
    }
    return -1;
};
let failures = 0;
for (const [key, sprite] of Object.entries(TREE_SPRITES)) {
    const leafy = Object.entries(TREE_SPRITES).find(([, s]) => s.bare === key || s.snow === key);
    if (!/\.(tall|world)$/.test(key) && !leafy) continue;
    const png = PNG.sync.read(readFileSync(join(VEG, `${sprite.id}.png`)));
    const problems = [];
    const off = new Set();
    let semi = 0;
    for (let i = 0; i < png.data.length; i += 4) {
        const a = png.data[i + 3];
        if (!a) continue;
        if (a !== 255) semi++;
        const hex = `#${[0, 1, 2].map((k) => png.data[i + k].toString(16).padStart(2, '0')).join('')}`;
        if (!authoredStops.has(hex)) off.add(hex);
    }
    if (semi) problems.push(`${semi} semi-transparent px`);
    if (off.size) problems.push(`${off.size} colour(s) off the C1 ${AUTHORED_RAMPS.join('/')} stops (${[...off].slice(0, 4).join(' ')})`);
    if (baseRow(png) !== sprite.height - 1) problems.push(`trunk base row ${baseRow(png)}, expected ${sprite.height - 1}`);
    if (leafy) {
        const [leafyKey, leafySprite] = leafy;
        if (leafySprite.width !== sprite.width || leafySprite.height !== sprite.height) problems.push(`canvas differs from ${leafyKey}`);
    }
    if (problems.length) failures++;
    console.log(`[foliage-pass] 5.5 ${sprite.id}: ${problems.length ? `FAIL ${problems.join('; ')}` : 'ok'}`);
}
if (failures) process.exitCode = 1;

function processSprite(png, { cutRow, lastRow, spans, tone }) {
    const { width, height, data } = png;
    const spanByRow = new Map(spans.map(([row, x0, x1]) => [row, [x0, x1]]));
    const idx = (x, y) => (y * width + x) * 4;
    const stats = { cut: 0, foliage: 0, wood: 0 };
    const clear = (x, y) => {
        const p = idx(x, y);
        if (data[p + 3] === 0) return;
        data[p] = 0; data[p + 1] = 0; data[p + 2] = 0; data[p + 3] = 0;
        stats.cut++;
    };

    // 1. Plinth strip.
    const darkCandidates = [];
    for (let y = cutRow; y < height; y++) {
        const span = spanByRow.get(y);
        for (let x = 0; x < width; x++) {
            const p = idx(x, y);
            if (data[p + 3] === 0) continue;
            if (y > lastRow || !span || x < span[0] || x > span[1]) { clear(x, y); continue; }
            const kind = classify(data[p], data[p + 1], data[p + 2]);
            if (kind === 'wood') continue;
            if (kind === 'dark') { darkCandidates.push([x, y]); continue; }
            clear(x, y);
        }
    }
    // Dark outline pixels survive only when they touch surviving wood.
    const isWood = (x, y) => {
        if (x < 0 || y < 0 || x >= width || y >= height) return false;
        const p = idx(x, y);
        return data[p + 3] > 0 && (y < cutRow || classify(data[p], data[p + 1], data[p + 2]) === 'wood');
    };
    for (const [x, y] of darkCandidates) {
        if (!(isWood(x - 1, y) || isWood(x + 1, y) || isWood(x, y - 1) || isWood(x, y + 1))) clear(x, y);
    }

    // 2. Re-tone.
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const p = idx(x, y);
            if (data[p + 3] === 0) continue;
            const [h, s, v] = rgbToHsv(data[p], data[p + 1], data[p + 2]);
            let nh = h; let ns = s; let nv = v;
            if (isFoliageHue(h, s)) {
                nv = v * tone.val;
                ns = s * tone.sat;
                const ramp = rampAt(nv);
                nh = lerpHue(h, ramp.h, tone.hueBlend);
                ns = Math.min(ns, ramp.s + 0.14);
                stats.foliage++;
            } else if (s > 0.08) {
                ns = s * tone.woodSat;
                stats.wood++;
            } else {
                continue;
            }
            const [r, g, b] = hsvToRgb(nh, ns, nv);
            data[p] = r; data[p + 1] = g; data[p + 2] = b;
        }
    }
    return stats;
}

function classify(r, g, b) {
    const [h, s, v] = rgbToHsv(r, g, b);
    if (v < 0.2) return 'dark';
    if (isFoliageHue(h, s)) return 'grass';
    if (v > 0.66 && s < 0.4) return 'sand';
    return 'wood';
}

function isFoliageHue(h, s) {
    return s > 0.12 && h >= 50 && h <= 175;
}

// Ramp hue/sat at a given value, interpolated between the C1 foliage stops.
function rampAt(v) {
    if (v <= RAMP[0].v) return RAMP[0];
    for (let i = 1; i < RAMP.length; i++) {
        const a = RAMP[i - 1];
        const b = RAMP[i];
        if (v <= b.v) {
            const t = (v - a.v) / (b.v - a.v);
            return { h: lerpHue(a.h, b.h, t), s: a.s + (b.s - a.s) * t, v };
        }
    }
    return RAMP[RAMP.length - 1];
}

function lerpHue(a, b, t) {
    let d = b - a;
    if (d > 180) d -= 360;
    if (d < -180) d += 360;
    return (a + d * t + 360) % 360;
}

function hexToHsv(hex) {
    const n = Number.parseInt(hex.slice(1), 16);
    const [h, s, v] = rgbToHsv((n >> 16) & 255, (n >> 8) & 255, n & 255);
    return { h, s, v };
}

function rgbToHsv(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const d = max - min;
    let h = 0;
    if (d > 0) {
        if (max === r) h = ((g - b) / d) % 6;
        else if (max === g) h = (b - r) / d + 2;
        else h = (r - g) / d + 4;
        h *= 60;
        if (h < 0) h += 360;
    }
    return [h, max === 0 ? 0 : d / max, max];
}

function hsvToRgb(h, s, v) {
    const c = v * s;
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    const m = v - c;
    let r = 0; let g = 0; let b = 0;
    if (h < 60) { r = c; g = x; }
    else if (h < 120) { r = x; g = c; }
    else if (h < 180) { g = c; b = x; }
    else if (h < 240) { g = x; b = c; }
    else if (h < 300) { r = x; b = c; }
    else { r = c; b = x; }
    return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}
