#!/usr/bin/env node
// MB-2 (2026-11-03) — the isle landmarks' 1px warm ink outline
// (docs/building-style-contract.md, Craft rules: "1px selective outline in
// warm near-black … external silhouette"). The `create_map_object`
// candidates (the windmill, W8.5b; the Hourglass Belfry, 2026-10-28) came
// back soft-edged: 8–34 % of their silhouette edge was ink, against
// 94–100 % for the nine buildings.
//
// Rule: every transparent texel outside the silhouette (4-connected to the
// canvas border, never an enclosed hole) that is 4-adjacent to an opaque
// texel which is not already outline ink (Rec. 601 luma < OUTLINE_LUMA)
// becomes OUTLINE_INK. Opaque art is never touched, so lit edges keep their
// highlight inside the line; 4-adjacency keeps corners clean (no blobby
// diagonal stair); an edge the art already inked keeps its own 1px line. A
// second run adds nothing: the ring it drew is ink.
//
// `--check` fails when a target's silhouette edge (its opaque texels
// 4-adjacent to the outside) is less than INK_SHARE_MIN ink (luma <
// CHECK_INK_LUMA, so the family's warm inks such as #16131f count) or a run
// would still add ink. `npm run world:validate-buildings` runs it.
//
// Run it after anything that rebuilds a target from its raw candidate
// (finish-isle-landmarks.mjs, bake-hourglass-belfry.mjs), after
// harmonize-roofs.mjs. A new target joins TARGETS once it is outlined (the
// wayside chapel with its MB-6 redraw).
//
// Usage:
//   node scripts/sprites/outline-landmarks.mjs [--id=<sprite id>[,<id>…]] [--dry-run]
//   node scripts/sprites/outline-landmarks.mjs --check [--id=…]

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { pathForEntry, spritesRoot } from './manifest-utils.mjs';

const TARGETS = Object.freeze(['prop.hourglassBelfry', 'prop.windmill']);
const OUTLINE_INK = Object.freeze([0x06, 0x04, 0x02]);
const OUTLINE_LUMA = 8;      // #060402–#040404: already the outline
const CHECK_INK_LUMA = 24;   // harmonize-roofs' --check ink
const INK_SHARE_MIN = 0.9;

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
function outlineRing(png) {
    const outside = outsideMask(png);
    const ring = [];
    for (let i = 0; i < outside.length; i++) {
        if (!outside[i]) continue;
        if (neighbours(png, i).some((n) => opaqueAt(png, n) && luma(png.data, n * 4) >= OUTLINE_LUMA)) ring.push(i);
    }
    return ring;
}

/** Ink the ring in place; returns how many texels it added. */
function outlinePng(png) {
    const ring = outlineRing(png);
    for (const i of ring) {
        png.data.set(OUTLINE_INK, i * 4);
        png.data[i * 4 + 3] = 255;
    }
    return ring.length;
}

/** The share of the silhouette edge (opaque, 4-adjacent to outside or the border) that is ink. */
function edgeInkShare(png) {
    const { width: w, height: h } = png;
    const outside = outsideMask(png);
    let edge = 0;
    let ink = 0;
    for (let i = 0; i < w * h; i++) {
        if (!opaqueAt(png, i)) continue;
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
const ids = idArg ? idArg.split(',').filter(Boolean) : TARGETS;
let bad = 0;
for (const id of ids) {
    const rel = pathForEntry(id);
    if (!rel) throw new Error(`[outline-landmarks] ${id}: no sprite path`);
    const path = join(spritesRoot, rel);
    const png = PNG.sync.read(readFileSync(path));
    if (check) {
        const share = edgeInkShare(png);
        const pending = outlineRing(png).length;
        const ok = share >= INK_SHARE_MIN && pending === 0;
        if (!ok) bad++;
        const line = `[outline-landmarks] ${id}: edge ink ${(share * 100).toFixed(1)} % (min ${INK_SHARE_MIN * 100} %), ${pending} texel(s) a run would add`;
        if (ok) console.log(`${line}: ok`);
        else console.error(line);
        continue;
    }
    const added = outlinePng(png);
    console.log(`[outline-landmarks] ${id}: ${added} ink texel(s) added, edge ink ${(edgeInkShare(png) * 100).toFixed(1)} %`);
    if (!dryRun && added) writeFileSync(path, PNG.sync.write(png));
}
if (dryRun && !check) console.log('[outline-landmarks] dry run: nothing written');
process.exit(bad ? 1 : 0);
