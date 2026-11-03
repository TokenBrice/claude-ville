#!/usr/bin/env node
// Living Isle W8.5b (AD-P10): finish the non-semantic landmark props from
// their PixelLab candidates, and bake the windmill's sail strip.
//
// Inputs are the raw downloads cached under output/landmarks/ (the manifest
// `provenance` names each job). The windmill and the watermill
// (`create_map_object`, <id>.a.raw):
//   1. Strip the baked ground plate (docs/building-style-contract.md,
//      Grounding): below the plate's top row, every texel outside an authored
//      keep polygon (the structure's own footing, steps and the wheel) is
//      cleared, and grass inside it too. Islands under
//      6 texels go, and a column whose foot lost a plate texel under it takes
//      that texel two stops darker, so no wall ends in a raw cut.
//   2. Snap the warm cream/white masonry and the pale stone onto the landmark
//      family's `ashlar` ramp by luminance (the Command/Archive masonry).
//   3. Mirror: the candidates were keyed from the upper right; the family's
//      key light is upper-left.
// The wayside chapel (MB-6, 2026-11-03: a `create_image_pro` draft drawn with
// the Tavern as its style image, already keyed from the upper left and with
// no ground plate, prop.waysideChapel.mb6.raw) came back 1.22x too large for
// the chapel's footing, so it is shrunk onto it instead (CHAPEL, below):
//   1. Shrink by `scale`: each texel takes the colour that covers most of its
//      source window, except that a colour 18 luma darker than the window's
//      mean wins once it covers `lineShare` of it, so 1-texel outlines, joints
//      and tile courses survive; no colour is invented. Inside the `tidy`
//      rects a line that straddles two texels keeps one (`tidyShare`).
//   2. Seat it at `offset` in today's 112 x 144 canvas: its footing (46 x 42
//      px runs) is today's, so the anchor [53, 104] stays.
//   3. The draft's pure-black line becomes the family ink #060402; every
//      masonry texel (harmonize-roofs.mjs `isStone`) snaps onto the `ashlar`
//      ramp by luminance; the bell takes dull bronze (timber and the darkest
//      trim gold); the lantern's two panes become unlit slate glass, and the
//      same texels are written to prop.waysideChapel.emissive.png on the
//      `emissive` ramp, lit at night on the lamps clock (IsleLandmarks.js
//      CHAPEL_LANTERN is their light).
// The sails (prop.windmillSails, 8 frames of 112 x 112, hub at the frame
// centre) are rasterised texel by texel on the sail plane, which faces the
// lower-left like the windshaft: u = (0.8, 0.4) per plane unit (the iso
// ground axis), v = straight up. Frame k is the cross turned 11.25 deg * k, so
// the 8-frame loop is one 90-degree period of the four-fold sail cross (MB-7;
// the even frames are the old 4-frame strip's).
//
// Afterwards: harmonize-roofs.mjs (the roofs onto roofSlate), then
// outline-landmarks.mjs (MB-2 and MB-6: the 1px ink line).
//
// `--sails` bakes the sail strip alone and leaves the props as they are;
// `--id=<id>[,<id>…]` finishes only those props (no sails).
//
// Usage: node scripts/sprites/finish-isle-landmarks.mjs [--sails | --id=<ids>] [--preview=<dir>]

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { repoRoot } from './manifest-utils.mjs';
import { ART_RAMPS } from '../../claudeville/src/config/artPalette.js';

const args = process.argv.slice(2);
const previewArg = args.find((arg) => arg.startsWith('--preview='));
const previewDir = previewArg ? previewArg.slice('--preview='.length) : null;
const sailsOnly = args.includes('--sails');
const onlyIds = args.find((arg) => arg.startsWith('--id='))?.slice('--id='.length).split(',').filter(Boolean) || null;
const RAW = join(repoRoot, 'output', 'landmarks');
const PROPS = join(repoRoot, 'claudeville', 'assets', 'sprites', 'props');

const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const luma = ([r, g, b]) => 0.299 * r + 0.587 * g + 0.114 * b;
const ASHLAR = ART_RAMPS.ashlar.slice(3).map(hex);
const MASONRY = ART_RAMPS.ashlar.slice(1).map(hex); // every stop but the ink
const BRONZE = [ART_RAMPS.timber[1], ART_RAMPS.timber[2], ART_RAMPS.trimGold[0]].map(hex);
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

// harmonize-roofs.mjs `isStone` (HSV): masonry greys and the violet shade.
function isStone(r, g, b) {
    const max = Math.max(r, g, b);
    const d = max - Math.min(r, g, b);
    const s = max ? d / max : 0;
    let h = 0;
    if (d) {
        if (max === r) h = ((g - b) / d + 6) % 6;
        else if (max === g) h = (b - r) / d + 2;
        else h = (r - g) / d + 4;
    }
    return s <= 0.22 || (h * 60 >= 240 && h * 60 <= 300 && s <= 0.5);
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
    { id: 'prop.windmill', band: 152,
        keep: [[26, 140], [100, 140], [100, 178], [95, 186], [76, 188], [68, 181], [52, 180], [38, 176], [27, 170]] },
    { id: 'prop.watermill', band: 98,
        keep: [[30, 40], [30, 112], [46, 112], [46, 130], [60, 140], [90, 140], [100, 133], [112, 142], [134, 133], [162, 118], [162, 40]] },
];

// MB-6 — the chapel: create_image_pro job c34e8278-33f1-44b0-8119-1635dd85fcdf,
// candidate 3 (112 x 144). Rects are [x0, y0, x1, y1), in the seated canvas.
const CHAPEL = Object.freeze({
    id: 'prop.waysideChapel',
    raw: 'prop.waysideChapel.mb6.raw',
    size: [112, 144],
    scale: 0.821,     // its footing runs 56 x 51 px; today's are 46 x 42
    offset: [7, 6],   // the footing's centre onto today's (54, 100)
    lineShare: 0.35,
    tidyShare: 0.41,  // 0.5 / (1 / scale): exactly one texel per line
    tidy: [[29, 86, 33, 100], [85, 88, 88, 110]],   // the lancet's west jamb, the door's east reveal
    bell: [74, 36, 78, 42],
    lantern: [92, 86, 96, 88],  // the two panes either side of the mullion
});

function readRaw(id, name = `${id}.a.raw`) {
    return PNG.sync.read(readFileSync(join(RAW, name)));
}

function finish(asset) {
    const png = readRaw(asset.id);
    const { width: w, height: h, data } = png;
    const src = Buffer.from(data);
    const at = (x, y) => (y * w + x) * 4;
    // 1. plate strip
    for (let y = asset.band; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const p = at(x, y);
            if (data[p + 3] === 0) continue;
            const [hue, s] = hsl(data[p], data[p + 1], data[p + 2]);
            const green = hue >= 65 && hue <= 160 && s > 0.2;
            if (!inPolygon(x + 0.5, y + 0.5, asset.keep) || green) data[p + 3] = 0;
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
    // 2. ashlar snap
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const p = at(x, y);
            if (data[p + 3] === 0) continue;
            data[p + 3] = 255;
            const rgb = [data[p], data[p + 1], data[p + 2]];
            const [hue, s, l] = hsl(...rgb);
            if ((s < 0.18 && l > 0.38) || (s < 0.36 && l > 0.42 && hue >= 15 && hue <= 75)) {
                [data[p], data[p + 1], data[p + 2]] = snap(ASHLAR, rgb);
            }
        }
    }
    // 3. mirror
    const mirrored = new PNG({ width: w, height: h });
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) data.copy(mirrored.data, at(w - 1 - x, y), at(x, y), at(x, y) + 4);
    }
    writeFileSync(join(PROPS, `${asset.id}.png`), PNG.sync.write(mirrored));
    return mirrored;
}

// --- chapel (MB-6) -----------------------------------------------------------
// The colour covering most of each target texel's 1/scale source window; a
// colour 18 luma under the window's mean wins from `share` of it. Ties go to
// the higher colour value, so the result is reproducible.
function shrink(src, scale, share) {
    const w = Math.round(src.width * scale);
    const h = Math.round(src.height * scale);
    const out = new PNG({ width: w, height: h });
    for (let Y = 0; Y < h; Y++) {
        const y0 = Y / scale;
        const y1 = (Y + 1) / scale;
        for (let X = 0; X < w; X++) {
            const x0 = X / scale;
            const x1 = (X + 1) / scale;
            const weights = new Map();
            let total = 0;
            let cover = 0;
            let lumaSum = 0;
            for (let yy = Math.floor(y0); yy < Math.min(src.height, Math.ceil(y1)); yy++) {
                const wy = Math.min(y1, yy + 1) - Math.max(y0, yy);
                for (let xx = Math.floor(x0); xx < Math.min(src.width, Math.ceil(x1)); xx++) {
                    const wgt = (Math.min(x1, xx + 1) - Math.max(x0, xx)) * wy;
                    total += wgt;
                    const p = (yy * src.width + xx) * 4;
                    if (src.data[p + 3] < 128) continue;
                    const rgb = [src.data[p], src.data[p + 1], src.data[p + 2]];
                    cover += wgt;
                    lumaSum += wgt * luma(rgb);
                    const k = (rgb[0] << 16) | (rgb[1] << 8) | rgb[2];
                    weights.set(k, (weights.get(k) || 0) + wgt);
                }
            }
            if (cover < 0.5 * total || !weights.size) continue;
            const mean = lumaSum / cover;
            let best = null;
            let dark = null;
            const better = (a, wgt, k) => !a || wgt > a[0] || (wgt === a[0] && k > a[1]);
            for (const [k, wgt] of weights) {
                if (better(best, wgt, k)) best = [wgt, k];
                const isDark = luma([k >> 16, (k >> 8) & 255, k & 255]) < mean - 18 && wgt >= share * total;
                if (isDark && better(dark, wgt, k)) dark = [wgt, k];
            }
            const k = (dark || best)[1];
            const o = (Y * w + X) * 4;
            out.data[o] = k >> 16;
            out.data[o + 1] = (k >> 8) & 255;
            out.data[o + 2] = k & 255;
            out.data[o + 3] = 255;
        }
    }
    return out;
}

const inBox = (x, y, [x0, y0, x1, y1]) => x >= x0 && x < x1 && y >= y0 && y < y1;

function finishChapel() {
    const draft = readRaw(CHAPEL.id, CHAPEL.raw);
    const lines = shrink(draft, CHAPEL.scale, CHAPEL.lineShare);
    const tidy = shrink(draft, CHAPEL.scale, CHAPEL.tidyShare);
    const [w, h] = CHAPEL.size;
    const [ox, oy] = CHAPEL.offset;
    const png = new PNG({ width: w, height: h });
    const emissive = new PNG({ width: w, height: h });
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const sx = x - ox;
            const sy = y - oy;
            if (sx < 0 || sy < 0 || sx >= lines.width || sy >= lines.height) continue;
            const from = CHAPEL.tidy.some((box) => inBox(x, y, box)) ? tidy : lines;
            const s = (sy * from.width + sx) * 4;
            if (from.data[s + 3] === 0) continue;
            const p = (y * w + x) * 4;
            let rgb = [from.data[s], from.data[s + 1], from.data[s + 2]];
            if (luma(rgb) < 16) rgb = INK;
            else if (inBox(x, y, CHAPEL.lantern)) {
                const glow = hsl(...rgb)[2];
                emissive.data.set([...(glow > 0.72 ? EMISSIVE[2] : glow > 0.5 ? EMISSIVE[1] : EMISSIVE[0]), 255], p);
                rgb = snap(SLATE.slice(1, 3), rgb);
            } else if (inBox(x, y, CHAPEL.bell)) rgb = snap(BRONZE, rgb);
            else if (isStone(...rgb)) rgb = snap(MASONRY, rgb);
            png.data.set([...rgb, 255], p);
        }
    }
    writeFileSync(join(PROPS, `${CHAPEL.id}.png`), PNG.sync.write(png));
    writeFileSync(join(PROPS, `${CHAPEL.id}.emissive.png`), PNG.sync.write(emissive));
    return png;
}

// --- sails -----------------------------------------------------------------
const FRAME = 112;
const FRAMES = 8;
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
        const theta = Math.PI / 4 + (f * Math.PI) / (2 * FRAMES);
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
const props = [...ASSETS.map((asset) => [asset.id, () => finish(asset)]), [CHAPEL.id, finishChapel]];
const unknown = (onlyIds || []).filter((id) => !props.some(([pid]) => pid === id));
if (unknown.length) throw new Error(`[finish-isle-landmarks] unknown --id: ${unknown.join(', ')}`);
const outputs = sailsOnly ? [] : props.filter(([id]) => !onlyIds || onlyIds.includes(id)).map(([id, run]) => [id, run()]);
if (!onlyIds) outputs.push(['prop.windmillSails', bakeSails()]);
for (const [id, png] of outputs) console.log(`${id}: ${png.width}x${png.height}`);
if (previewDir) {
    mkdirSync(previewDir, { recursive: true });
    for (const [id, png] of outputs) writeFileSync(join(previewDir, `${id}.png`), PNG.sync.write(png));
}
