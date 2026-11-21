#!/usr/bin/env node
// MB-2 (2026-11-03) + C-05 — 1px warm ink outline (#060402) on external
// silhouettes of landmarks, isle landmarks, and bridges
// (docs/building-style-contract.md: "1px selective outline in warm near-black
// … external silhouette").
//
// Rule: every transparent texel outside the silhouette (4-connected to the
// canvas border, never an enclosed hole) that is 4-adjacent to an opaque
// texel which is not already outline ink (Rec. 601 luma < OUTLINE_LUMA) — and
// does not lie inside an authored open threshold (`SKIP_BOXES`, such as the
// Forge's glowing hearth mouth) — becomes OUTLINE_INK. Opaque art is never
// touched, so lit edges keep their highlight inside the line; 4-adjacency
// keeps corners clean; an edge the art already inked keeps its own 1px line.
// A second run adds nothing: the ring it drew is ink.
//
// `--check` fails when any target's silhouette edge is below its minimum ink
// share (95 % for the nine buildings, 97 % for Forge, 90 % for isle landmarks
// and bridges) or a run on an active target would still add ink.
//
// Usage:
//   node scripts/sprites/outline-landmarks.mjs [--id=<sprite id>[,<id>…]] [--dry-run]
//   node scripts/sprites/outline-landmarks.mjs --check [--id=…]

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { pathForEntry, spritesRoot } from './manifest-utils.mjs';

const TARGETS = Object.freeze([
    'prop.hourglassBelfry',
    'prop.windmill',
    'building.forge',
    'bridge.landmark.rustic.ns',
    'bridge.landmark.civic.ns',
    'bridge.ew',
]);

const CHECK_EXTRA = Object.freeze([
    'building.command',
    'building.tavern',
    'building.taskboard',
    'building.watchtower',
    'building.harbor',
    'building.archive',
    'building.mine',
    'building.portal',
]);

// Open glowing thresholds where the interior floor intentionally meets the
// yard without a black bar across the opening.
const SKIP_BOXES = Object.freeze({
    'building.forge': Object.freeze([[58, 192, 88, 214]]),
});

const OUTLINE_INK = Object.freeze([0x06, 0x04, 0x02]);
const OUTLINE_LUMA = 8;      // #060402–#040404: already the outline
const CHECK_INK_LUMA = 24;   // harmonize-roofs' --check ink
const INK_SHARE_MIN = 0.9;

function minInkFor(id) {
    if (id === 'building.forge') return 0.97;
    if (id.startsWith('building.')) return 0.95;
    return INK_SHARE_MIN;
}

function inSkipBox(id, width, i) {
    const boxes = SKIP_BOXES[id];
    if (!boxes) return false;
    const x = i % width;
    const y = (i - x) / width;
    return boxes.some(([x0, y0, x1, y1]) => x >= x0 && x <= x1 && y >= y0 && y <= y1);
}

const luma = (data, i) => 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
const opaqueAt = (png, i) => png.data[i * 4 + 3] > 127;

// Transparent texels reachable from the canvas border, 4-connected.
function outsideMask(png) {
    const { width: w, height: h } = png;
    const outside = new Uint8Array(w * h);
    const stack = [];
    for (let x = 0; x < w; x++) stack.push(x, (h - 1) * w + x);
    for (let y = 0; y < h; y++) stack.push(y * w, y * w + w - 1);
    while (stack.length) {
        const i = stack.pop();
        if (outside[i] || opaqueAt(png, i)) continue;
        outside[i] = 1;
        const x = i % w;
        if (x > 0) stack.push(i - 1);
        if (x < w - 1) stack.push(i + 1);
        if (i >= w) stack.push(i - w);
        if (i < (h - 1) * w) stack.push(i + w);
    }
    return outside;
}

function neighbours(png, i) {
    const { width: w, height: h } = png;
    const x = i % w;
    const out = [];
    if (x > 0) out.push(i - 1);
    if (x < w - 1) out.push(i + 1);
    if (i >= w) out.push(i - w);
    if (i < (h - 1) * w) out.push(i + w);
    return out;
}

/** The outside texels a pass inks (indices), without writing them. */
function outlineRing(png, id = '') {
    const outside = outsideMask(png);
    const ring = [];
    for (let i = 0; i < outside.length; i++) {
        if (!outside[i] || inSkipBox(id, png.width, i)) continue;
        if (neighbours(png, i).some((n) => opaqueAt(png, n) && !inSkipBox(id, png.width, n) && luma(png.data, n * 4) >= OUTLINE_LUMA)) {
            ring.push(i);
        }
    }
    return ring;
}

/** Ink the ring in place; returns how many texels it added. */
function outlinePng(png, id = '') {
    const ring = outlineRing(png, id);
    for (const i of ring) {
        png.data.set(OUTLINE_INK, i * 4);
        png.data[i * 4 + 3] = 255;
    }
    // For sprites touching the canvas border (such as 64x64 bridge.ew), ensure
    // shaded lower/side border-touching texels carry warm outline ink in place.
    if (id === 'bridge.ew') {
        const { width: w, height: h } = png;
        let borderInked = 0;
        for (let i = 0; i < w * h; i++) {
            if (!opaqueAt(png, i)) continue;
            const x = i % w;
            const y = (i - x) / w;
            if (!(x === 0 || x === w - 1 || y === h - 1)) continue;
            if (luma(png.data, i * 4) < OUTLINE_LUMA) continue;
            png.data.set(OUTLINE_INK, i * 4);
            borderInked++;
        }
        return ring.length + borderInked;
    }
    return ring.length;
}

/** The share of the silhouette edge (opaque, 4-adjacent to outside or the border) that is ink. */
function edgeInkShare(png, id = '') {
    const { width: w, height: h } = png;
    const outside = outsideMask(png);
    let edge = 0;
    let ink = 0;
    for (let i = 0; i < w * h; i++) {
        if (!opaqueAt(png, i) || inSkipBox(id, w, i)) continue;
        const x = i % w;
        const border = x === 0 || x === w - 1 || i < w || i >= (h - 1) * w;
        if (!border && !neighbours(png, i).some((n) => outside[n])) continue;
        edge++;
        if (luma(png.data, i * 4) < CHECK_INK_LUMA) ink++;
    }
    return edge ? ink / edge : 1;
}

const args = process.argv.slice(2);
const check = args.includes('--check');
const dryRun = args.includes('--dry-run');
const idArg = args.find((arg) => arg.startsWith('--id='))?.slice('--id='.length);
const activeSet = new Set(TARGETS);
const ids = idArg ? idArg.split(',').filter(Boolean) : (check ? [...TARGETS, ...CHECK_EXTRA] : TARGETS);
let bad = 0;
for (const id of ids) {
    const rel = pathForEntry(id);
    if (!rel) throw new Error(`[outline-landmarks] ${id}: no sprite path`);
    const path = join(spritesRoot, rel);
    const png = PNG.sync.read(readFileSync(path));
    if (check) {
        const share = edgeInkShare(png, id);
        const minShare = minInkFor(id);
        const pending = activeSet.has(id) ? outlineRing(png, id).length : 0;
        const ok = share >= minShare && pending === 0;
        if (!ok) bad++;
        const line = `[outline-landmarks] ${id}: edge ink ${(share * 100).toFixed(1)} % (min ${(minShare * 100).toFixed(0)} %), ${pending} texel(s) a run would add`;
        if (ok) console.log(`${line}: ok`);
        else console.error(line);
        continue;
    }
    const added = outlinePng(png, id);
    console.log(`[outline-landmarks] ${id}: ${added} ink texel(s) added, edge ink ${(edgeInkShare(png, id) * 100).toFixed(1)} %`);
    if (!dryRun && added) writeFileSync(path, PNG.sync.write(png));
}
if (dryRun && !check) console.log('[outline-landmarks] dry run: nothing written');
process.exit(bad ? 1 : 0);
