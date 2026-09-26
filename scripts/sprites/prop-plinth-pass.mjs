#!/usr/bin/env node
// Prop plinth pass (Opus 5.5 aesthetic plan, item 4.1). Props stand on the
// terrain, not on baked iso-diamond plinths (the rule
// docs/building-style-contract.md:12 sets for landmarks): a slab on a stepped
// plinth reads as a grave marker, and a crate on a stone plinth as a museum
// piece.
//
// prop.runestone:  strips the plinth, closes the slab's foot with a dark
//                  outline and two moss tufts, drops the slab so its foot sits
//                  on the manifest anchor (y 42), and recolours the glowing
//                  cyan inscription panel to a recessed stone panel with moss
//                  in the carved runes. Cyan belongs to Mine ore only
//                  (building-style-contract.md:26).
// prop.scrollCrates: strips the grey stone plinth under the crate; the crate's
//                  own outline and its bottom vertex stay on the anchor.
//
// Each target carries the sha256 of its original; a file whose hash differs is
// skipped (already processed) unless --force is given.
//
// Usage:
//   node scripts/sprites/prop-plinth-pass.mjs [--dry-run] [--force] [--preview=<dir>]

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { repoRoot } from './manifest-utils.mjs';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const force = args.includes('--force');
const previewArg = args.find((arg) => arg.startsWith('--preview='));
const previewDir = previewArg ? previewArg.slice('--preview='.length) : null;

const PROPS = join(repoRoot, 'claudeville', 'assets', 'sprites', 'props');

// Stone ramp (C1 `stone`) and moss for the runestone engraving.
const RUNE = Object.freeze({
    panelShadow: [0x25, 0x26, 0x2d],
    panel: [0x4d, 0x4f, 0x5a],
    panelLit: [0x5c, 0x5e, 0x69],
    glyph: [0x6d, 0x80, 0x44],
    glyphLit: [0x8a, 0x9a, 0x58],
    outline: [0x16, 0x16, 0x1c],
});

const TARGETS = [
    {
        file: 'prop.runestone.png',
        sha256: 'c9bb9b5ec14b0887cff8b91f60858083f267ed5cbcfcb3e8d1662771aedfab9d',
        apply: runestone,
    },
    {
        file: 'prop.scrollCrates.png',
        sha256: '28e5a953bf3fdb9d5c7bddf026c57d3aedd735b23687664d6f14b33243336d0a',
        apply: scrollCrates,
    },
];

for (const target of TARGETS) {
    const path = join(PROPS, target.file);
    const bytes = readFileSync(path);
    const sha = createHash('sha256').update(bytes).digest('hex');
    if (sha !== target.sha256 && !force) {
        console.log(`[prop-plinth-pass] skip ${target.file} (hash ${sha.slice(0, 12)} is not the original; --force to reprocess)`);
        continue;
    }
    const png = PNG.sync.read(bytes);
    const note = target.apply(png);
    console.log(`[prop-plinth-pass] ${target.file}: ${note}`);
    const out = PNG.sync.write(png);
    if (previewDir) {
        mkdirSync(previewDir, { recursive: true });
        writeFileSync(join(previewDir, target.file), out);
    } else if (!dryRun) {
        writeFileSync(path, out);
    }
}

function runestone(png) {
    const { width, height, data } = png;
    const at = (x, y) => (y * width + x) * 4;
    const SLAB_X0 = 14;
    const SLAB_X1 = 34;
    const FOOT_ROW = 30; // last slab row kept; the plinth starts below
    const PANEL = { x0: 21, y0: 6, x1: 31, y1: 29 };
    let recoloured = 0;

    // 1. Inscription panel: cyan family -> recessed stone; bright glyph
    //    strokes -> moss in the carving.
    for (let y = PANEL.y0; y <= PANEL.y1; y++) {
        for (let x = PANEL.x0; x <= PANEL.x1; x++) {
            const p = at(x, y);
            if (data[p + 3] === 0) continue;
            const [h, s, v] = rgbToHsv(data[p], data[p + 1], data[p + 2]);
            const cyan = h >= 150 && h <= 200 && s > 0.2;
            const glyph = v > 0.8 && s < 0.3 && data[p + 2] >= data[p] && data[p + 1] >= data[p];
            let rgb = null;
            if (glyph) rgb = v > 0.93 ? RUNE.glyphLit : RUNE.glyph;
            else if (cyan) rgb = v < 0.5 ? RUNE.panelShadow : v < 0.72 ? RUNE.panel : RUNE.panelLit;
            if (!rgb) continue;
            data[p] = rgb[0]; data[p + 1] = rgb[1]; data[p + 2] = rgb[2];
            recoloured++;
        }
    }

    // 2. Strip the plinth: keep only the slab above its foot.
    const src = Buffer.from(data);
    data.fill(0);
    const moss = [];
    for (let y = 0; y <= FOOT_ROW; y++) {
        for (let x = SLAB_X0; x <= SLAB_X1; x++) {
            const p = at(x, y);
            if (src[p + 3] === 0) continue;
            const [h, s] = rgbToHsv(src[p], src[p + 1], src[p + 2]);
            // Plinth-top grass that pokes above the foot row stays as moss
            // only when it touches the slab's lower edge.
            if (h >= 60 && h <= 110 && s > 0.3) { moss.push([x, y]); continue; }
            data.set(src.subarray(p, p + 4), p);
        }
    }
    // 3. Close the foot: an outline pixel under every slab column.
    for (let x = SLAB_X0; x <= SLAB_X1; x++) {
        let bottom = -1;
        for (let y = FOOT_ROW; y >= 0; y--) {
            if (data[at(x, y) + 3] > 0) { bottom = y; break; }
        }
        if (bottom < 0 || bottom === FOOT_ROW) continue;
        const p = at(x, bottom + 1);
        data[p] = RUNE.outline[0]; data[p + 1] = RUNE.outline[1]; data[p + 2] = RUNE.outline[2]; data[p + 3] = 255;
    }
    for (let x = SLAB_X0; x <= SLAB_X1; x++) {
        const p = at(x, FOOT_ROW);
        if (data[p + 3] === 0) continue;
        const q = at(x, FOOT_ROW + 1);
        data[q] = RUNE.outline[0]; data[q + 1] = RUNE.outline[1]; data[q + 2] = RUNE.outline[2]; data[q + 3] = 255;
    }
    // 4. Moss tufts at the foot, from the sprite's own moss.
    for (const [x, y] of moss) {
        const p = at(x, y);
        data.set(src.subarray(p, p + 4), p);
    }
    // 5. Drop the slab so its foot lands on the anchor row (manifest y 42).
    let foot = 0;
    for (let y = height - 1; y >= 0 && !foot; y--) {
        for (let x = 0; x < width; x++) if (data[at(x, y) + 3] > 0) { foot = y; break; }
    }
    const shift = 42 - foot;
    shiftDown(png, shift);
    return `recoloured ${recoloured} inscription px, plinth stripped, slab dropped ${shift} px`;
}

function scrollCrates(png) {
    const { width, height, data } = png;
    const at = (x, y) => (y * width + x) * 4;
    const PLINTH_ROW = 28;
    let cut = 0;
    const crate = (x, y) => {
        if (x < 0 || y < 0 || x >= width || y >= height) return false;
        const p = at(x, y);
        if (data[p + 3] === 0) return false;
        const [, s, v] = rgbToHsv(data[p], data[p + 1], data[p + 2]);
        return s >= 0.18 && v > 0.12;
    };
    // Lit plinth stone: low-saturation greys below the crate's lower edge.
    const greys = [];
    const darks = [];
    for (let y = PLINTH_ROW; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const p = at(x, y);
            if (data[p + 3] === 0) continue;
            const [, s, v] = rgbToHsv(data[p], data[p + 1], data[p + 2]);
            if (s < 0.18 && v > 0.22) greys.push(p);
            else if (s < 0.18 || v <= 0.12) darks.push([x, y]);
        }
    }
    for (const p of greys) { data[p + 3] = 0; cut++; }
    // Plinth shadow: dark pixels that do not outline the crate.
    const drop = darks.filter(([x, y]) => !(crate(x - 1, y) || crate(x + 1, y) || crate(x, y - 1) || crate(x, y + 1)));
    for (const [x, y] of drop) { data[at(x, y) + 3] = 0; cut++; }
    for (let i = 0; i < width * height; i++) {
        if (data[i * 4 + 3] === 0) { data[i * 4] = 0; data[i * 4 + 1] = 0; data[i * 4 + 2] = 0; }
    }
    return `plinth stripped (${cut} px)`;
}

function shiftDown(png, rows) {
    if (!rows) return;
    const { width, height, data } = png;
    const rowBytes = width * 4;
    const copy = Buffer.from(data);
    data.fill(0);
    for (let y = 0; y < height; y++) {
        const ny = y + rows;
        if (ny < 0 || ny >= height) continue;
        copy.copy(data, ny * rowBytes, y * rowBytes, (y + 1) * rowBytes);
    }
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
