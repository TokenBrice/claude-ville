#!/usr/bin/env node
// One candidate round of a single-direction PixelLab object (REST
// /create-1-direction-object, the MCP create_1_direction_object), staged for
// review: raw candidates, a palette-true remap onto C1 ramps, and 1× / 2×
// review sheets. Nothing here writes the manifest or claudeville/assets; a
// chosen candidate is promoted by hand (plan 5.5: veg.tree.*.tall).
//
// Style references are existing sprites placed bottom-centre on a square
// canvas of the requested size (the endpoint takes the output size from the
// largest style image), so the model sees the family's pixel density,
// outline and key light at native 1×. Candidates stay in PixelLab review
// (select-frames is never called, so nothing extra is charged or kept).
//
// Palette pass (`--leaf=foliage,foliageSun:6-6 --wood=timber
// --outline=foliageDeep:0,timber:0`): every opaque pixel is classed as
// outline (OKLab L < 0.2), leaf (hue 42–200°, S > 0.15) or wood, and snapped
// to the nearest OKLab stop of its class's C1 ramps; outline pixels take the
// leaf or wood outline stop by their 5×5 neighbourhood's majority, so the
// 1-px selective outline stays on-ramp. The default leaf ladder stops at
// foliageSun[6]: its yellow top stop fails FoliageRenderer.isCanopyPixel
// (g > r + 4), so it would escape the seasonal canopy remap. The raw
// candidate is kept beside it, so the pass re-runs for free with --object-id.
//
// Usage:
//   node scripts/sprites/generate-object-candidates.mjs --name=veg.tree.oak.tall --size=112 \
//       --style=vegetation/veg.tree.oak.large.png,vegetation/veg.tree.willow.large.png \
//       --description="…" --items="…|…|…|…" --floor=1172 --item=5.5 [--plan] [--object-id=<id>]

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { blitPng, fetchPng, readPixellabToken, repoRoot, sleep } from './pixellab-rest.mjs';
import { ART_RAMPS } from '../../claudeville/src/config/artPalette.js';
import { api, createSpend } from './pixellab-spend.mjs';
import { spritesRoot } from './manifest-utils.mjs';

const args = process.argv.slice(2);
const option = (name, fallback = null) => {
    const hit = args.find((arg) => arg.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : fallback;
};
const flag = (name) => args.includes(`--${name}`);
const list = (value, sep = ',') => (value || '').split(sep).map((part) => part.trim()).filter(Boolean);

const name = option('name');
const size = Number(option('size', '112'));
const description = option('description');
const items = list(option('items'), '|');
const styles = list(option('style'));
const view = option('view', 'top-down');
const floor = Number(option('floor', '272'));
const item = option('item', 'object');
const agent = option('agent', 'AssetsA');
const objectIdOption = option('object-id');
const leafSpec = option('leaf', 'foliage,foliageSun:6-6');
const woodSpec = option('wood', 'timber');
const outlineSpec = option('outline', 'foliageDeep:0,timber:0');
const outDir = join(repoRoot, option('out', join('output', 'object-candidates', name || '_')));

if (!name) fail('--name=<sprite id> is required');
if (!objectIdOption && !description) fail('--description is required for a new round');
if (!Number.isInteger(size) || size < 16 || size > 256) fail('--size must be an integer 16–256');
const candidatesFor = (s) => (s <= 42 ? 64 : s <= 85 ? 16 : s <= 170 ? 4 : 1);
if (items.length > candidatesFor(size)) fail(`--items has ${items.length} entries; size ${size} yields ${candidatesFor(size)} candidates`);

const token = readPixellabToken();
const spend = createSpend({ token, agent, floor });
mkdirSync(outDir, { recursive: true });

const styleImages = styles.map((relative) => {
    const png = PNG.sync.read(readFileSync(join(spritesRoot, relative)));
    if (png.width > size || png.height > size) fail(`style ${relative} is larger than --size ${size}`);
    const canvas = new PNG({ width: size, height: size });
    const dx = Math.floor((size - png.width) / 2);
    const dy = size - png.height;
    blitPng(png, canvas, dx, dy);
    const bytes = PNG.sync.write(canvas);
    writeFileSync(join(outDir, `style-${relative.split('/').pop()}`), bytes);
    return { type: 'base64', base64: bytes.toString('base64'), format: 'png' };
});

console.log(`[object] ${name}: size ${size} → ${candidatesFor(size)} candidate(s), ${styleImages.length} style image(s), view ${view}; cost 20–40 generations (Pro); balance ${await spend.balance()}, floor ${spend.floor}`);
if (flag('plan')) process.exit(0);

let objectId = objectIdOption;
if (!objectId) {
    const queued = await spend.job({
        item,
        endpoint: '/create-1-direction-object',
        target: `${name} size ${size} ×${candidatesFor(size)}`,
        maxCost: 40,
        run: async () => {
            const body = { description, view, ...(styleImages.length ? { style_images: styleImages } : { size }) };
            if (items.length) body.item_descriptions = items;
            const response = await api(token, '/create-1-direction-object', { method: 'POST', body, label: name });
            const id = response?.object_id || response?.data?.object_id;
            if (!id) throw new Error(`no object_id in ${JSON.stringify(response).slice(0, 300)}`);
            const detail = await waitForObject(id);
            return { objectId: id, usage: response?.usage || null, status: detail.status, ledgerDetail: { objectId: id } };
        },
    });
    objectId = queued.objectId;
    writeFileSync(join(outDir, 'object.json'), JSON.stringify({ objectId, usage: queued.usage, description, items, size, view, styles }, null, 2));
}

const detail = await waitForObject(objectId);
const urls = detail.frame_urls?.length ? detail.frame_urls
    : Object.values(detail.rotation_urls || {}).filter((url) => typeof url === 'string');
if (!urls.length) fail(`object ${objectId} (${detail.status}) has no candidate frames`);
const ramps = { leaf: rampStops(leafSpec), wood: rampStops(woodSpec), outline: rampStops(outlineSpec) };
if (ramps.outline.length !== 2) fail('--outline needs exactly two stops: leaf outline, wood outline');
const raws = [];
const snapped = [];
for (let index = 0; index < urls.length; index++) {
    const raw = await fetchPng(urls[index], { label: `${name} candidate ${index}` });
    writeFileSync(join(outDir, `candidate-${index}.raw.png`), PNG.sync.write(raw));
    const remapped = paletteSnap(raw, ramps);
    writeFileSync(join(outDir, `candidate-${index}.c1.png`), PNG.sync.write(remapped));
    raws.push(raw);
    snapped.push(remapped);
    const bounds = alphaBounds(remapped);
    console.log(`[object] candidate ${index}: ${raw.width}×${raw.height}, content ${bounds ? `${bounds.w}×${bounds.h}` : 'empty'}`);
}
writeFileSync(join(outDir, 'review-2x.png'), PNG.sync.write(reviewSheet([raws, snapped], 2)));
console.log(`[object] ${objectId}: ${urls.length} candidate(s) in ${outDir.slice(repoRoot.length).replace(/^\//, '')} (status ${detail.status}; select-frames not called)`);

// ─── helpers ──────────────────────────────────────────────────────────────────

async function waitForObject(id, { pollMs = 8000, maxWaitMs = 15 * 60 * 1000 } = {}) {
    const deadline = Date.now() + maxWaitMs;
    for (;;) {
        const detail = await api(token, `/objects/${id}`, { label: `object ${id}` });
        const status = detail?.status || detail?.data?.status;
        if (status === 'completed' || status === 'review') return detail?.data || detail;
        if (status === 'failed') throw new Error(`object ${id} failed`);
        if (Date.now() > deadline) throw new Error(`object ${id} still ${status} after ${maxWaitMs / 60000} min`);
        await sleep(pollMs);
    }
}

// "ramp[:from-to],…" → the listed C1 stops, in order.
function rampStops(spec) {
    return list(spec).flatMap((part) => {
        const [rampName, range] = part.split(':');
        const ramp = ART_RAMPS[rampName];
        if (!ramp) fail(`unknown ramp ${rampName}`);
        const [from, to] = range ? range.split('-').map(Number) : [0, ramp.length - 1];
        return ramp.slice(from, (Number.isFinite(to) ? to : from) + 1).map(hexToRgb);
    });
}

function paletteSnap(src, stops) {
    const out = new PNG({ width: src.width, height: src.height });
    const labOf = (stopList) => stopList.map((rgb) => ({ rgb, lab: oklab(rgb) }));
    const leafStops = labOf(stops.leaf);
    const woodStops = labOf(stops.wood);
    const kind = new Uint8Array(src.width * src.height); // 0 clear, 1 outline, 2 leaf, 3 wood
    const labs = new Array(src.width * src.height);
    for (let p = 0; p < kind.length; p++) {
        const i = p * 4;
        if (src.data[i + 3] < 128) continue;
        const rgb = [src.data[i], src.data[i + 1], src.data[i + 2]];
        const lab = oklab(rgb);
        const [h, s] = hueSat(rgb);
        labs[p] = lab;
        kind[p] = lab[0] < 0.2 ? 1 : h >= 42 && h <= 200 && s > 0.15 ? 2 : 3;
    }
    const nearest = (lab, candidates) => candidates.reduce((best, stop) => {
        const d = (stop.lab[0] - lab[0]) ** 2 + (stop.lab[1] - lab[1]) ** 2 + (stop.lab[2] - lab[2]) ** 2;
        return d < best.d ? { d, rgb: stop.rgb } : best;
    }, { d: Infinity, rgb: null }).rgb;
    for (let p = 0; p < kind.length; p++) {
        if (!kind[p]) continue;
        let rgb;
        if (kind[p] === 1) {
            let leaves = 0, wood = 0;
            const x = p % src.width, y = Math.floor(p / src.width);
            for (let dy = -2; dy <= 2; dy++) {
                for (let dx = -2; dx <= 2; dx++) {
                    const xx = x + dx, yy = y + dy;
                    if (xx < 0 || yy < 0 || xx >= src.width || yy >= src.height) continue;
                    const k = kind[yy * src.width + xx];
                    if (k === 2) leaves++;
                    else if (k === 3) wood++;
                }
            }
            rgb = leaves >= wood ? stops.outline[0] : stops.outline[1];
        } else {
            rgb = nearest(labs[p], kind[p] === 2 ? leafStops : woodStops);
        }
        out.data.set([rgb[0], rgb[1], rgb[2], 255], p * 4);
    }
    return out;
}

function oklab([r, g, b]) {
    const lin = (v) => {
        const c = v / 255;
        return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    const [lr, lg, lb] = [lin(r), lin(g), lin(b)];
    const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
    const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
    const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
    return [
        0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
        1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
        0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
    ];
}

function reviewSheet(rows, scale) {
    const cellW = Math.max(...rows.flat().map((png) => png.width)) * scale + 8;
    const cellH = Math.max(...rows.flat().map((png) => png.height)) * scale + 8;
    const cols = Math.max(...rows.map((row) => row.length));
    const sheet = new PNG({ width: cols * cellW, height: rows.length * cellH });
    const grass = hexToRgb(ART_RAMPS.grass[2]);
    for (let i = 0; i < sheet.data.length; i += 4) {
        sheet.data[i] = grass[0];
        sheet.data[i + 1] = grass[1];
        sheet.data[i + 2] = grass[2];
        sheet.data[i + 3] = 255;
    }
    rows.forEach((row, r) => row.forEach((png, c) => {
        for (let y = 0; y < png.height; y++) {
            for (let x = 0; x < png.width; x++) {
                const si = (y * png.width + x) * 4;
                if (png.data[si + 3] < 128) continue;
                for (let sy = 0; sy < scale; sy++) {
                    for (let sx = 0; sx < scale; sx++) {
                        const di = ((r * cellH + 4 + y * scale + sy) * sheet.width + c * cellW + 4 + x * scale + sx) * 4;
                        sheet.data[di] = png.data[si];
                        sheet.data[di + 1] = png.data[si + 1];
                        sheet.data[di + 2] = png.data[si + 2];
                        sheet.data[di + 3] = 255;
                    }
                }
            }
        }
    }));
    return sheet;
}

function alphaBounds(png) {
    let minX = png.width, minY = png.height, maxX = -1, maxY = -1;
    for (let y = 0; y < png.height; y++) {
        for (let x = 0; x < png.width; x++) {
            if (png.data[(y * png.width + x) * 4 + 3] < 128) continue;
            minX = Math.min(minX, x); maxX = Math.max(maxX, x);
            minY = Math.min(minY, y); maxY = Math.max(maxY, y);
        }
    }
    return maxX < 0 ? null : { minX, minY, maxX, maxY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

function hexToRgb(hex) {
    const value = parseInt(hex.slice(1), 16);
    return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

function hueSat([r, g, b]) {
    const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
    if (d === 0) return [0, 0];
    let h;
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    return [(h * 60 + 360) % 360, max ? d / max : 0];
}

function fail(message) {
    console.error(`[object] ${message}`);
    process.exit(2);
}
