#!/usr/bin/env node

// EN-2 — facade materials for Command and Tavern. The two landmarks shipped
// one material class (stone) on every texel although their art paints oak
// doors, iron straps and braziers (Command) and an oak arcade, bar, kegs and
// half-timbering (Tavern). This writes their material sidecars from reviewed
// regions plus a colour rule inside them: warm brown texels are timber, the
// non-brown fittings inside a door leaf or a named iron region are metal.
// Everything else keeps the stone the building declares; lit glass (emissive
// sidecar) and flame keep their class. The rule reads hue and saturation, not
// luminance, and only inside the regions below.
//
//   node scripts/sprites/paint-facade-materials.mjs          # write
//   node scripts/sprites/paint-facade-materials.mjs --check  # fail if stale

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { spritesRoot } from './manifest-utils.mjs';
import { materialClassId } from '../../claudeville/src/presentation/character-mode/MaterialRegistry.js';

const STONE = materialClassId('stone');
const TIMBER = materialClassId('timber');
const METAL = materialClassId('metal');

// Reviewed regions, sprite px [x, y, w, h].
//   timber: brown texels become timber.
//   leaf:   an arched door leaf [x, y, w, h] (semicircular head); per row,
//           the non-brown texels between its first and last brown texel are
//           its iron straps, ring pulls and nails.
//   metal:  gilt (a saturated gold) and dark iron (grey, V < 0.45) texels.
//   ashlar: a right-facing ashlar wall [x0, y0], every texel right of x0 and
//           below the 2:1 line rising right from (x0, y0) stays stone (its
//           plum mortar joints share the shaded oak's hue).
export const FACADE_REGIONS = Object.freeze({
    command: {
        timber: [],
        leaf: [[119, 113, 32, 84]],
        // The gilt crest over the gate and the two iron braziers.
        metal: [[127, 106, 11, 13], [88, 175, 15, 23], [136, 199, 18, 24]],
    },
    tavern: {
        timber: [[0, 0, 296, 288]],
        leaf: [],
        metal: [],
        ashlar: [202, 198],
    },
});

function hsv(r, g, b) {
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const d = max - min;
    let h = 0;
    if (d) {
        if (max === r) h = ((g - b) / d) % 6;
        else if (max === g) h = (b - r) / d + 2;
        else h = (r - g) / d + 4;
        h *= 60;
        if (h < 0) h += 360;
    }
    return { h, s: max ? d / max : 0, v: max / 255 };
}

// Oak: a warm hue, clearly saturated, never the cream plaster or a flame.
// The shaded oak leans plum (hue 330-360); the mauve stone shade is greyer
// (S < 0.25) and the flower-box crimson more saturated (S > 0.55).
export function isBrown(r, g, b) {
    const { h, s, v } = hsv(r, g, b);
    if (h >= 330) return s >= 0.26 && s <= 0.55 && v <= 0.6;
    return h <= 42 && s >= 0.26 && v <= 0.88 && !isFlame(r, g, b);
}

function isFlame(r, g, b) {
    const { h, s, v } = hsv(r, g, b);
    return h <= 50 && s >= 0.55 && v > 0.9;
}

const isInk = (r, g, b) => Math.max(r, g, b) < 24;

const inside = (rects, x, y) => rects.some(([rx, ry, rw, rh]) => x >= rx && y >= ry && x < rx + rw && y < ry + rh);

// Inside an arched leaf: its rectangle, cut by a semicircular head.
function inLeaf(leaves, x, y) {
    return leaves.some(([rx, ry, rw, rh]) => {
        if (x < rx || y < ry || x >= rx + rw || y >= ry + rh) return false;
        const r = rw / 2;
        const cy = ry + r;
        if (y >= cy) return true;
        const dx = x + 0.5 - (rx + r);
        const dy = y + 0.5 - cy;
        return dx * dx + dy * dy <= r * r;
    });
}

function isFitting(r, g, b) {
    const { h, s, v } = hsv(r, g, b);
    const gilt = h >= 25 && h <= 60 && s >= 0.4 && v > 0.45;
    const iron = s < 0.3 && v < 0.45;
    return (gilt || iron) && !isFlame(r, g, b);
}

export function facadeMaterial(type, albedo, emissive) {
    const regions = FACADE_REGIONS[type];
    const { width, height, data } = albedo;
    const cls = new Uint8Array(width * height).fill(STONE);
    const at = (x, y) => (y * width + x) * 4;
    const lit = (x, y) => emissive && emissive.data[at(x, y) + 3] > 0;
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const i = at(x, y);
            if (!data[i + 3] || lit(x, y)) continue;
            if (regions.ashlar && x >= regions.ashlar[0] && y >= regions.ashlar[1] - (x - regions.ashlar[0]) / 2) continue;
            const [r, g, b] = [data[i], data[i + 1], data[i + 2]];
            if (inside(regions.metal, x, y) && isFitting(r, g, b) && !isInk(r, g, b)) cls[y * width + x] = METAL;
            else if ((inside(regions.timber, x, y) || inLeaf(regions.leaf, x, y)) && isBrown(r, g, b)) cls[y * width + x] = TIMBER;
        }
    }
    for (const [rx, ry, rw, rh] of regions.leaf) {
        for (let y = ry; y < ry + rh; y++) {
            let first = -1;
            let last = -1;
            for (let x = rx; x < rx + rw; x++) {
                if (cls[y * width + x] === TIMBER) {
                    if (first < 0) first = x;
                    last = x;
                }
            }
            for (let x = first + 1; first >= 0 && x < last; x++) {
                const i = at(x, y);
                if (!inLeaf(regions.leaf, x, y)) continue;
                if (cls[y * width + x] === STONE && !isInk(data[i], data[i + 1], data[i + 2])) cls[y * width + x] = METAL;
            }
        }
    }
    // An outline belongs to the surface it draws: ink takes the modal class
    // of its non-ink 3x3 neighbours.
    const out = cls.slice();
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const i = at(x, y);
            if (!data[i + 3] || !isInk(data[i], data[i + 1], data[i + 2])) continue;
            const votes = new Map();
            for (let dy = -1; dy <= 1; dy++) {
                for (let dx = -1; dx <= 1; dx++) {
                    const qx = x + dx;
                    const qy = y + dy;
                    if (qx < 0 || qy < 0 || qx >= width || qy >= height) continue;
                    const q = at(qx, qy);
                    if (!data[q + 3] || isInk(data[q], data[q + 1], data[q + 2])) continue;
                    const c = cls[qy * width + qx];
                    votes.set(c, (votes.get(c) || 0) + 1);
                }
            }
            let best = STONE;
            let most = 0;
            for (const [c, n] of votes) if (n > most || (n === most && c === STONE)) { best = c; most = n; }
            out[y * width + x] = best;
        }
    }
    const png = new PNG({ width, height, colorType: 6 });
    for (let p = 0; p < width * height; p++) {
        const a = data[p * 4 + 3];
        png.data[p * 4] = a ? out[p] : 0;
        png.data[p * 4 + 3] = a;
    }
    return png;
}

const read = (rel) => PNG.sync.read(readFileSync(join(spritesRoot, rel)));

function main() {
    const check = process.argv.includes('--check');
    let stale = 0;
    for (const type of Object.keys(FACADE_REGIONS)) {
        const dir = `buildings/building.${type}`;
        const albedo = read(`${dir}/base.png`);
        const emissive = existsSync(join(spritesRoot, dir, 'base.emissive.png')) ? read(`${dir}/base.emissive.png`) : null;
        const png = facadeMaterial(type, albedo, emissive);
        const target = join(spritesRoot, dir, 'base.material.png');
        const counts = {};
        for (let p = 0; p < png.width * png.height; p++) if (png.data[p * 4 + 3]) counts[png.data[p * 4]] = (counts[png.data[p * 4]] || 0) + 1;
        if (check) {
            const same = existsSync(target) && Buffer.compare(read(`${dir}/base.material.png`).data, png.data) === 0;
            if (!same) stale++;
            console.log(`[facade-materials] ${type} ${same ? 'ok' : 'STALE'} ${JSON.stringify(counts)}`);
        } else {
            writeFileSync(target, PNG.sync.write(png));
            console.log(`[facade-materials] ${type} -> ${dir}/base.material.png ${JSON.stringify(counts)}`);
        }
    }
    if (stale) process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
