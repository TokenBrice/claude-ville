#!/usr/bin/env node
// Living Isle W8.5b (AD-P10): finish the four non-semantic landmark props
// from their PixelLab `create_map_object` candidates, and bake the windmill's
// sail strip.
//
// Inputs are the raw downloads cached under output/landmarks/<id>.a.raw (the
// manifest `provenance.objectId` names each job). Per asset:
//   1. Strip the baked ground plate (docs/building-style-contract.md,
//      Grounding): below the plate's top row, every texel outside an authored
//      keep polygon (the structure's own footing, steps and the wheel) is
//      cleared, and grass inside it too (the ruin keeps its ivy). Islands under
//      6 texels go, and a column whose foot lost a plate texel under it takes
//      that texel two stops darker, so no wall ends in a raw cut.
//   2. Snap the warm cream/white masonry and the pale stone onto the landmark
//      family's `ashlar` ramp by luminance (the Command/Archive masonry).
//   3. Chapel only: the lit amber window and the blue lantern glass become
//      unlit slate glass in the albedo (glass is never lit in base art); the
//      lantern's glass texels are written to prop.waysideChapel.emissive.png
//      on the `emissive` ramp, lit at night on the lamps clock.
//   4. Mirror: the candidates were keyed from the upper right; the family's
//      key light is upper-left.
// The sails (prop.windmillSails, 4 frames of 112 x 112, hub at the frame
// centre) are rasterised texel by texel on the sail plane, which faces the
// lower-left like the windshaft: u = (0.8, 0.4) per plane unit (the iso
// ground axis), v = straight up. Frame k is the cross turned 22.5 deg * k, so
// the 4-frame loop is one 90-degree period of the four-fold sail cross.
//
// Usage: node scripts/sprites/finish-isle-landmarks.mjs [--preview=<dir>]

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { repoRoot } from './manifest-utils.mjs';
import { ART_RAMPS } from '../../claudeville/src/config/artPalette.js';

const args = process.argv.slice(2);
const previewArg = args.find((arg) => arg.startsWith('--preview='));
const previewDir = previewArg ? previewArg.slice('--preview='.length) : null;
const RAW = join(repoRoot, 'output', 'landmarks');
const PROPS = join(repoRoot, 'claudeville', 'assets', 'sprites', 'props');

const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const luma = ([r, g, b]) => 0.299 * r + 0.587 * g + 0.114 * b;
const ASHLAR = ART_RAMPS.ashlar.slice(3).map(hex);
const SLATE = ART_RAMPS.slate.map(hex);
const EMISSIVE = ART_RAMPS.emissive.map(hex);
const TIMBER = ART_RAMPS.timber.map(hex);
const GOLD = ART_RAMPS.trimGold.map(hex);
const INK = hex('#060402');

function hsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const l = (max + min) / 2;
    if (max === min) return [0, 0, l];
    const d = max - min;
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    let h;
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0));
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    return [h * 60, s, l];
}

// The stop of `ramp` whose luma is nearest the texel's.
function snap(ramp, rgb) {
    const y = luma(rgb);
    let best = ramp[0];
    for (const stop of ramp) if (Math.abs(luma(stop) - y) < Math.abs(luma(best) - y)) best = stop;
    return best;
}

function inPolygon(x, y, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const [xi, yi] = poly[i];
        const [xj, yj] = poly[j];
        if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
}

// Keep polygons and plate rows in the raw (unmirrored) candidate's texels.
const ASSETS = [
    { id: 'prop.windmill', band: 152, keepGreen: false,
        keep: [[26, 140], [100, 140], [100, 178], [95, 186], [76, 188], [68, 181], [52, 180], [38, 176], [27, 170]] },
    { id: 'prop.watermill', band: 98, keepGreen: false,
        keep: [[30, 40], [30, 112], [46, 112], [46, 130], [60, 140], [90, 140], [100, 133], [112, 142], [134, 133], [162, 118], [162, 40]] },
    { id: 'prop.waysideChapel', band: 100, keepGreen: false, chapel: true,
        keep: [[10, 30], [10, 104], [28, 112], [44, 120], [57, 128], [61, 119], [80, 108], [98, 99], [102, 97], [102, 30]] },
    { id: 'prop.ruinedTower', band: 120, keepGreen: true,
        keep: [[8, 40], [8, 128], [22, 138], [40, 147], [60, 154], [68, 150], [84, 142], [100, 135], [106, 130], [106, 40]] },
];
// Chapel glass rects (raw texels, inclusive): the lit window, the lantern.
const CHAPEL_WINDOW = { x0: 70, y0: 74, x1: 87, y1: 102 };
const CHAPEL_LANTERN = { x0: 12, y0: 74, x1: 22, y1: 93 };
const inRect = (x, y, r) => x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1;

function readRaw(id) {
    return PNG.sync.read(readFileSync(join(RAW, `${id}.a.raw`)));
}

function finish(asset) {
    const png = readRaw(asset.id);
    const { width: w, height: h, data } = png;
    const src = Buffer.from(data);
    const emissive = asset.chapel ? new PNG({ width: w, height: h }) : null;
    const at = (x, y) => (y * w + x) * 4;
    // 1. plate strip
    for (let y = asset.band; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const p = at(x, y);
            if (data[p + 3] === 0) continue;
            const [hue, s] = hsl(data[p], data[p + 1], data[p + 2]);
            const green = hue >= 65 && hue <= 160 && s > 0.2;
            if (!inPolygon(x + 0.5, y + 0.5, asset.keep) || (green && !asset.keepGreen)) data[p + 3] = 0;
        }
    }
    // islands under 6 texels
    const seen = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) {
        if (seen[i] || data[i * 4 + 3] === 0) continue;
        const stack = [i];
        const group = [];
        seen[i] = 1;
        while (stack.length) {
            const k = stack.pop();
            group.push(k);
            const x = k % w;
            const y = (k - x) / w;
            for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
                const nx = x + dx;
                const ny = y + dy;
                if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
                const n = ny * w + nx;
                if (seen[n] || data[n * 4 + 3] === 0) continue;
                seen[n] = 1;
                stack.push(n);
            }
        }
        if (group.length < 6) for (const k of group) data[k * 4 + 3] = 0;
    }
    // contact row
    for (let x = 0; x < w; x++) {
        for (let y = h - 2; y >= asset.band - 1; y--) {
            const p = at(x, y);
            if (data[p + 3] === 0) continue;
            if (src[at(x, y + 1) + 3] > 0 && data[at(x, y + 1) + 3] === 0) {
                for (let c = 0; c < 3; c++) data[p + c] = Math.round(data[p + c] * 0.5);
            }
            break;
        }
    }
    // 2. ashlar snap, 3. chapel glass
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const p = at(x, y);
            if (data[p + 3] === 0) continue;
            data[p + 3] = 255;
            const rgb = [data[p], data[p + 1], data[p + 2]];
            const [hue, s, l] = hsl(...rgb);
            let out = null;
            if (asset.chapel && inRect(x, y, CHAPEL_WINDOW) && hue >= 30 && hue <= 70 && s > 0.4 && l > 0.4) {
                out = snap(SLATE.slice(1), rgb);
            } else if (asset.chapel && inRect(x, y, CHAPEL_LANTERN) && hue >= 185 && hue <= 250 && s > 0.3 && l > 0.3) {
                out = snap(SLATE.slice(1, 3), rgb);
                const glow = l > 0.72 ? EMISSIVE[2] : l > 0.5 ? EMISSIVE[1] : EMISSIVE[0];
                const e = (y * w + (w - 1 - x)) * 4;
                emissive.data[e] = glow[0];
                emissive.data[e + 1] = glow[1];
                emissive.data[e + 2] = glow[2];
                emissive.data[e + 3] = 255;
            } else if ((s < 0.18 && l > 0.38) || (s < 0.36 && l > 0.42 && hue >= 15 && hue <= 75)) {
                out = snap(ASHLAR, rgb);
            }
            if (out) [data[p], data[p + 1], data[p + 2]] = out;
        }
    }
    // 4. mirror
    const mirrored = new PNG({ width: w, height: h });
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) data.copy(mirrored.data, at(w - 1 - x, y), at(x, y), at(x, y) + 4);
    }
    writeFileSync(join(PROPS, `${asset.id}.png`), PNG.sync.write(mirrored));
    if (emissive) writeFileSync(join(PROPS, `${asset.id}.emissive.png`), PNG.sync.write(emissive));
    return mirrored;
}

// --- sails -----------------------------------------------------------------
const FRAME = 112;
const FRAMES = 4;
const HUB = FRAME / 2;
const U = [0.8, 0.4];
const SPAR_R = 51;
const SAIL_IN = 13;
const SAIL_OUT = 49;
const SAIL_W = 11;

// One texel of the sail plane at (a, b) plane units: 0 empty, else a colour.
function sailTexel(a, b, theta) {
    const r = Math.hypot(a, b);
    if (r <= 4.6) return r <= 1.8 ? GOLD[2] : r <= 2.9 ? GOLD[1] : TIMBER[1];
    for (let k = 0; k < 4; k++) {
        const t = theta + (k * Math.PI) / 2;
        const along = a * Math.cos(t) + b * Math.sin(t);
        const across = -a * Math.sin(t) + b * Math.cos(t);
        if (along < 0 || along > SPAR_R) continue;
        if (Math.abs(across) <= 1.05) return across < 0 ? TIMBER[3] : TIMBER[2];
        if (along < SAIL_IN || along > SAIL_OUT || across < 1.05 || across > SAIL_W) continue;
        const edge = across > SAIL_W - 1.25 || along > SAIL_OUT - 1.25 || along < SAIL_IN + 1.1;
        const bar = ((along - SAIL_IN) % 6) < 1.15;
        if (edge || bar) return TIMBER[2];
        return across < 3.2 ? hex(ART_RAMPS.ashlar[5]) : hex(ART_RAMPS.ashlar[8]);
    }
    return null;
}

function bakeSails() {
    const png = new PNG({ width: FRAME * FRAMES, height: FRAME });
    for (let f = 0; f < FRAMES; f++) {
        const theta = Math.PI / 4 + (f * Math.PI) / 8;
        const cell = new Array(FRAME * FRAME).fill(null);
        for (let y = 0; y < FRAME; y++) {
            for (let x = 0; x < FRAME; x++) {
                const sx = x + 0.5 - HUB;
                const sy = y + 0.5 - HUB;
                const a = sx / U[0];
                const b = -(sy - a * U[1]);
                cell[y * FRAME + x] = sailTexel(a, b, theta);
            }
        }
        for (let y = 0; y < FRAME; y++) {
            for (let x = 0; x < FRAME; x++) {
                let rgb = cell[y * FRAME + x];
                if (!rgb) {
                    const touches = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => {
                        const nx = x + dx;
                        const ny = y + dy;
                        return nx >= 0 && ny >= 0 && nx < FRAME && ny < FRAME && cell[ny * FRAME + nx];
                    });
                    if (!touches) continue;
                    rgb = INK;
                }
                const p = (y * FRAME * FRAMES + f * FRAME + x) * 4;
                png.data[p] = rgb[0];
                png.data[p + 1] = rgb[1];
                png.data[p + 2] = rgb[2];
                png.data[p + 3] = 255;
            }
        }
    }
    writeFileSync(join(PROPS, 'prop.windmillSails.png'), PNG.sync.write(png));
    return png;
}

mkdirSync(PROPS, { recursive: true });
const outputs = ASSETS.map((asset) => [asset.id, finish(asset)]);
outputs.push(['prop.windmillSails', bakeSails()]);
for (const [id, png] of outputs) console.log(`${id}: ${png.width}x${png.height}`);
if (previewDir) {
    mkdirSync(previewDir, { recursive: true });
    for (const [id, png] of outputs) writeFileSync(join(previewDir, `${id}.png`), PNG.sync.write(png));
}
