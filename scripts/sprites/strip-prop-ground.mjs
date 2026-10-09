#!/usr/bin/env node
// Strip baked ground plates from scenery props (Living Isle W2.1, art report
// AD-P3). docs/building-style-contract.md (Grounding) forbids a land sprite
// from carrying its own ground tile, slab or water puddle: GroundBake owns
// grass, dirt and contact darkening, the terrain owns water, and CoastBake
// mirrors a prop about its own base row. A prop that brings its own teal
// puddle or lawn stamps a wrong-coloured diamond on the living ground.
//
// Per asset an authored mask (a colour class, limited to a region) erases the
// plate and keeps the object:
//   prop.driftwood.log     the water ring (cyan and its pale glints)
//   prop.mangroveRoot.arch the water pool and the root shadow cast on it
//   prop.netRack           the dirt diamond between the four posts
//   prop.signpost          the plank deck; post, arm and the two moss tufts
//                          drop 10 px so the post's foot lands on the anchor
//   veg.boulder.mossy.large  the grass blades and soil rim at the foot; the
//                          moss on the rock stays
//   veg.flower.a/b/c       the soil box and the flat turf corners: the
//                          clump keeps an organic ellipse round the anchor
//   veg.hedge              the hard V of the bottom cut becomes a ragged
//                          leafy edge (a fixed per-column notch pattern)
//   prop.lakeShrine        the baked mossy islet: its grass and flowers, the
//                          tan path (same palette as the shrine's own steps,
//                          so it is cut by an authored per-column foot line)
//                          and the earth cliff under it. The shrine, its
//                          steps and the two standing stones stay and drop
//                          16 px so the steps' foot lands on the anchor
// Then every asset loses stray specks (islands under 6 px) and its bottom
// silhouette is re-closed: a column whose lowest texel lost a plate texel
// under it takes that texel one shade darker (the contact row), so nothing
// ends in a raw cut. Canvas sizes and manifest anchors are unchanged.
//
// Idempotent: each target carries the sha256 of its original; a file whose
// hash differs is skipped (already processed) unless --force is given.
//
// Usage:
//   node scripts/sprites/strip-prop-ground.mjs [--dry-run] [--force] [--preview=<dir>]

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

const SPRITES = join(repoRoot, 'claudeville', 'assets', 'sprites');

const TARGETS = [
    { file: 'props/prop.driftwood.log.png', sha256: '9fd0757807ca12f1f16ae1927d5e51a8b864a9c4aadf7e00cd427f95c8748eb6', apply: driftwood },
    { file: 'props/prop.mangroveRoot.arch.png', sha256: '3e32697692c9709717e1f774e1ce9df79b1331f437fb0952bc6506cbf93928c6', apply: mangroveArch },
    { file: 'props/prop.netRack.png', sha256: 'e186a65bdcf3ef730977a926ee030326138137f5bc725122a89ecdd812052e7d', apply: netRack, diagonal: true },
    { file: 'props/prop.signpost.png', sha256: '096e499d752ddf08aafffb3de98149ab87cbfa8716e843cd9df7c7bd620ca9a0', apply: signpost },
    { file: 'vegetation/veg.boulder.mossy.large.png', sha256: 'de640a1ddd6997c5560f5bac2b2fb3aed419e9bdc878de4858cbd00282b7f8ee', apply: mossyBoulder },
    { file: 'vegetation/veg.flower.a.png', sha256: '5f5ea7a5c1e0a8f2079c230fe8a12a57c14cf18aef2d5dc7387b36f358baef74', apply: flowerClump },
    { file: 'vegetation/veg.flower.b.png', sha256: '12ae5a776cc9ff9a4096286ac17c55bce711924ced8be4a4d7df4e451d949b0b', apply: flowerClump },
    { file: 'vegetation/veg.flower.c.png', sha256: '0e3aaf6edc4431abae84092808ab6e442beb7a076d45c7ded454ce3ecea0cfe5', apply: flowerClump },
    { file: 'vegetation/veg.hedge.png', sha256: 'b1562a0aaef78e5fdcbd6cde20020360f0a7346d591fcb7af8e929e79b01943f', apply: hedge },
    { file: 'props/prop.lakeShrine.png', sha256: 'd38d046703e6f0420842dbbb9104ad75affef849a2d008f76a29dbc4de9a386c', apply: lakeShrine, drop: 16 },
];

for (const target of TARGETS) {
    const path = join(SPRITES, target.file);
    const bytes = readFileSync(path);
    const sha = createHash('sha256').update(bytes).digest('hex');
    if (sha !== target.sha256 && !force) {
        console.log(`[strip-prop-ground] skip ${target.file} (hash ${sha.slice(0, 12)} is not the original; --force to reprocess)`);
        continue;
    }
    const png = PNG.sync.read(bytes);
    const before = Buffer.from(png.data);
    const note = target.apply(png);
    const specks = dropSpecks(png, 6, target.diagonal);
    const closed = closeBottom(png, before);
    // A drop moves the cleaned object after the contact row is found, so
    // closeBottom still compares texels against the unshifted original.
    if (target.drop) shiftDown(png, target.drop);
    clearTransparentRgb(png);
    console.log(`[strip-prop-ground] ${target.file}: ${note}; ${specks} speck px; ${closed} contact px`);
    const out = PNG.sync.write(png);
    if (previewDir) {
        mkdirSync(previewDir, { recursive: true });
        writeFileSync(join(previewDir, target.file.split('/').pop()), out);
    } else if (!dryRun) {
        writeFileSync(path, out);
    }
}

// ── asset masks ─────────────────────────────────────────────────────────────

function driftwood(png) {
    // Water: cyan family, plus the pale near-neutral glints on it.
    const cut = eraseWhere(png, (c) => isWater(c) || (c.s < 0.2 && c.v > 0.55));
    return `water ring erased (${cut} px)`;
}

function mangroveArch(png) {
    let cut = eraseWhere(png, (c, x, y) => y >= 20 && isWater(c));
    // Near-black texels left on the pool are the roots' cast shadow, not
    // their outline: keep a dark texel only beside a root (warm) texel.
    const root = (x, y) => {
        const c = colourAt(png, x, y);
        return c && c.v >= 0.22 && c.h >= 5 && c.h <= 45 && c.s >= 0.25;
    };
    cut += eraseWhere(png, (c, x, y) => y >= 20 && c.v < 0.22
        && !(root(x - 1, y) || root(x + 1, y) || root(x, y - 1) || root(x, y + 1)));
    return `water pool and cast shadow erased (${cut} px)`;
}

function netRack(png) {
    // The dirt diamond spans rows 13-29. Inside it only the posts' own
    // columns (dark timber, V < 0.5) and the red rope swags survive; ropes
    // above row 13 are untouched, and so is the right swag's sag (x 19-23,
    // rows 13-14, outline included), which hangs clear of the diamond's
    // top edge. The swags are one-texel diagonal lines, so this target
    // drops specks by 8-connectivity or their rising ends are lost.
    const posts = [[4, 7], [14, 17], [24, 27]];
    const inPost = (x) => posts.some(([a, b]) => x >= a && x <= b);
    const rope = (c) => (c.h < 15 || c.h > 320) && c.s >= 0.4 && c.v >= 0.35;
    const swag = (x, y) => y <= 14 && x >= 19 && x <= 23;
    const cut = eraseWhere(png, (c, x, y) => y >= 13 && !(inPost(x) && c.v < 0.5) && !rope(c) && !swag(x, y));
    return `dirt diamond erased (${cut} px)`;
}

function signpost(png) {
    // Keep the post (x 16-19 down to its foot at row 18), the arm (rows 0-12
    // right of the post) and the two moss tufts (green); the deck goes.
    const keep = (c, x, y) => (x >= 16 && x <= 19 && y <= 18)
        || (x >= 16 && x <= 27 && y <= 12)
        || (c.h >= 60 && c.h <= 170 && c.s >= 0.2 && y >= 10 && y <= 21)
        || (c.v < 0.25 && y >= 10 && y <= 21 && x >= 9 && x <= 28 && greenNeighbour(png, x, y));
    const cut = eraseWhere(png, (c, x, y) => !keep(c, x, y));
    shiftDown(png, 10);
    return `plank deck erased (${cut} px), post dropped 10 px onto the anchor`;
}

function mossyBoulder(png) {
    // Foot (row >= 34): the soil rim (warm browns and tans, and its dark
    // outline) goes; below row 40 only the rock (low-saturation greys and
    // violet shade) stays, so the grass blades of the plate go with it.
    const rock = (c) => c.s < 0.28 || (c.h >= 200 && c.h <= 300);
    const soil = (c) => c.h >= 10 && c.h <= 55 && c.s >= 0.15;
    const cut = eraseWhere(png, (c, x, y) => (y >= 34 && soil(c)) || (y >= 40 && !rock(c)));
    return `grass and soil plate erased (${cut} px)`;
}

function flowerClump(png) {
    // The tile's top diamond centres on the anchor (16, 20). An ellipse
    // (rx 13, ry 6, with a fixed ±1 ragged edge) keeps the clump; the soil
    // faces below it and the turf corners outside it go.
    const jitter = [0, 1, 0, -1, 1, 0, -1, 0, 1, -1, 0, 1];
    const cut = eraseWhere(png, (c, x, y) => {
        const rx = 13 + jitter[x % jitter.length] * 0.6;
        const ry = 6 + jitter[(x * 7) % jitter.length] * 0.6;
        const dx = (x + 0.5 - 16) / rx;
        const dy = (y + 0.5 - 19.5) / ry;
        const soil = c.h >= 10 && c.h <= 45 && c.s >= 0.2 && c.v < 0.55 && y >= 22;
        return dx * dx + dy * dy > 1 || soil;
    });
    return `soil box and turf corners erased (${cut} px)`;
}

function hedge(png) {
    // The bottom cut is a straight V (rows 24-31). Notch each column's last
    // 0-2 texels by a fixed pattern so the foot reads as leaves, not a box.
    const notch = [1, 0, 2, 1, 0, 1, 2, 0, 1, 1, 0, 2, 0, 1, 2, 1];
    let cut = 0;
    for (let x = 0; x < png.width; x++) {
        const bottom = lowestOpaque(png, x);
        if (bottom < 22) continue;
        for (let k = 0; k < notch[x % notch.length]; k++) {
            const p = at(png, x, bottom - k);
            if (png.data[p + 3]) { png.data[p + 3] = 0; cut++; }
        }
    }
    return `bottom cut notched (${cut} px)`;
}

function lakeShrine(png) {
    // Foot line: the lowest kept row per column (the islet below it goes,
    // whatever its colour). Left standing stone x 10-16 stands at row 36,
    // the left buttress and the steps' side stones at 37-38, the bottom
    // step between the front blocks at 40, the front block and the right
    // pillar at 41, the right standing stone and its shade face at 43.
    const foot = (x) => (x <= 9 ? 34 : x <= 20 ? 36 : x <= 21 ? 37 : x <= 27 ? 38
        : x <= 32 ? 40 : x <= 43 ? 41 : x <= 51 ? 43 : 37);
    // Above the foot line the islet still shows between the stones: grass
    // and flowers (olive to yellow, saturated; the shrine's moss and stone
    // are grey-green at S <= 0.40, and the rune flame sits above row 26),
    // the tan path below the steps, and the reddish earth rim.
    const grass = (c, y) => y >= 26 && c.h >= 40 && c.h <= 110 && c.s >= 0.45;
    const path = (c, x, y) => c.h >= 15 && c.h <= 45 && c.s >= 0.3 && y >= (x >= 28 && x <= 32 ? 40 : 39);
    const rim = (c, y) => y >= 38 && (c.h >= 320 || c.h < 12);
    const cut = eraseWhere(png, (c, x, y) => y > foot(x) || grass(c, y) || path(c, x, y) || rim(c, y));
    return `mossy islet, path and earth rim erased (${cut} px), shrine dropped 16 px onto the anchor`;
}

// ── helpers ─────────────────────────────────────────────────────────────────

function at(png, x, y) { return (y * png.width + x) * 4; }

function colourAt(png, x, y) {
    if (x < 0 || y < 0 || x >= png.width || y >= png.height) return null;
    const p = at(png, x, y);
    if (png.data[p + 3] === 0) return null;
    return hsv(png.data[p], png.data[p + 1], png.data[p + 2]);
}

function isWater(c) { return c.h >= 165 && c.h <= 215 && c.s >= 0.2; }

function greenNeighbour(png, x, y) {
    for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
        const c = colourAt(png, x + dx, y + dy);
        if (c && c.h >= 60 && c.h <= 170 && c.s >= 0.2) return true;
    }
    return false;
}

function eraseWhere(png, predicate) {
    const doomed = [];
    for (let y = 0; y < png.height; y++) {
        for (let x = 0; x < png.width; x++) {
            const c = colourAt(png, x, y);
            if (c && predicate(c, x, y)) doomed.push(at(png, x, y));
        }
    }
    for (const p of doomed) png.data[p + 3] = 0;
    return doomed.length;
}

function lowestOpaque(png, x) {
    for (let y = png.height - 1; y >= 0; y--) if (png.data[at(png, x, y) + 3]) return y;
    return -1;
}

// Remove islands smaller than `min` texels (stray plate specks); 4-connected
// unless `diagonal`, which also joins corner neighbours.
function dropSpecks(png, min, diagonal = false) {
    const steps = diagonal
        ? [[-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [1, -1], [-1, 1], [1, 1]]
        : [[-1, 0], [1, 0], [0, -1], [0, 1]];
    const { width, height, data } = png;
    const seen = new Uint8Array(width * height);
    let dropped = 0;
    for (let i = 0; i < width * height; i++) {
        if (seen[i] || !data[i * 4 + 3]) continue;
        const island = [i];
        seen[i] = 1;
        for (let k = 0; k < island.length; k++) {
            const j = island[k];
            const x = j % width;
            const y = (j - x) / width;
            for (const [dx, dy] of steps) {
                const nx = x + dx;
                const ny = y + dy;
                if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
                const n = ny * width + nx;
                if (!seen[n] && data[n * 4 + 3]) { seen[n] = 1; island.push(n); }
            }
        }
        if (island.length < min) for (const j of island) { data[j * 4 + 3] = 0; dropped++; }
    }
    return dropped;
}

// The contact row: a column's lowest texel whose texel below was erased
// plate (opaque in `before`) is darkened one shade (x0.62), unless it is
// already ink-dark.
function closeBottom(png, before) {
    let closed = 0;
    for (let x = 0; x < png.width; x++) {
        const y = lowestOpaque(png, x);
        if (y < 0 || y + 1 >= png.height) continue;
        const below = at(png, x, y + 1);
        if (!before[below + 3]) continue;
        const p = at(png, x, y);
        const c = hsv(png.data[p], png.data[p + 1], png.data[p + 2]);
        if (c.v < 0.25) continue;
        for (let k = 0; k < 3; k++) png.data[p + k] = Math.round(png.data[p + k] * 0.62);
        closed++;
    }
    return closed;
}

function clearTransparentRgb(png) {
    for (let i = 0; i < png.width * png.height; i++) {
        if (png.data[i * 4 + 3] === 0) png.data.fill(0, i * 4, i * 4 + 3);
    }
}

function shiftDown(png, rows) {
    const { width, height, data } = png;
    const rowBytes = width * 4;
    const copy = Buffer.from(data);
    data.fill(0);
    for (let y = 0; y < height; y++) {
        const ny = y + rows;
        if (ny >= 0 && ny < height) copy.copy(data, ny * rowBytes, y * rowBytes, (y + 1) * rowBytes);
    }
}

function hsv(r, g, b) {
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
    return { h, s: max === 0 ? 0 : d / max, v: max };
}
