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
import { ART_RAMPS } from '../../claudeville/src/config/artPalette.js';
import { roofWeatherMap } from '../../claudeville/src/presentation/character-mode/RoofWeather.js';

const STONE = materialClassId('stone');
const TIMBER = materialClassId('timber');
const METAL = materialClassId('metal');
const FABRIC = materialClassId('fabric');

// Restrained albedo ramp edits (EN-2), so the oak and iron read without the
// material channel (Canvas, MINIMAL): reviewed source colour -> an existing
// palette stop, applied only to texels this script classes timber (OAK) or
// metal (IRON). The plum-shaded oak (hue 330-360 / a red 3) goes onto the
// `timber` ramp; the warm oak is already oak and keeps its colour. The
// gate's iron straps, rings and the braziers, painted in the ashlar mauve
// and warm greys, go onto the `slate` ramp (wall and gate ironwork) by
// value; the gilt and the ink keep theirs.
const T = ART_RAMPS.timber;
const S = ART_RAMPS.slate;
export const OAK_FROM = Object.freeze({
    '#20171a': T[0], '#311e26': T[0], '#432527': T[1], '#3f1c1a': T[1], '#532d36': T[1], '#5d3239': T[2],
});
// The pale strap and ring highlights keep a highlight: the slate family's
// lit wet stop (wetSlate[2]), the colour slate already takes when it shines.
const LIT = ART_RAMPS.wetSlate[2];
export const IRON_FROM = Object.freeze({
    '#231821': S[0], '#4c3a4c': S[1], '#5a4454': S[1], '#645663': S[2], '#685c67': S[2], '#746c68': S[2],
    '#7f767f': S[2], '#7d6c6d': S[3], '#867e80': S[3], '#8a8487': S[3], '#857a77': S[3],
    '#9b8c82': LIT, '#a2968f': LIT, '#a99f9a': LIT, '#afa39c': LIT, '#b4aaa6': LIT,
});

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
        // The four crimson wall banners: their cloth and gilt emblem.
        fabric: [[93, 131, 7, 25], [190, 179, 7, 25], [203, 120, 7, 25], [224, 111, 6, 25]],
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

// Banner cloth: the crimson and its gilt emblem.
function isCloth(r, g, b) {
    const { h, s, v } = hsv(r, g, b);
    return ((h >= 335 || h <= 12) && s >= 0.45 && v >= 0.25) || (h >= 25 && h <= 60 && s >= 0.4 && v > 0.45);
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

const hexOf = (r, g, b) => `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
const SLATE_IRON = new Set([...S, LIT]);

function isFitting(r, g, b) {
    if (SLATE_IRON.has(hexOf(r, g, b))) return true;
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
            if (regions.fabric && inside(regions.fabric, x, y) && isCloth(r, g, b)) cls[y * width + x] = FABRIC;
            else if (inside(regions.metal, x, y) && isFitting(r, g, b) && !isInk(r, g, b)) cls[y * width + x] = METAL;
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

// The ramp edits on `albedo` (a copy) for the classes in `material` (R).
// `roof` ({ occluder, emissive }, the landmark's companions) guards roof
// weather: an edit that would change the roof class, trim or snow-cap mask
// of the roof map (RoofWeather.roofWeatherMap reads colour: a plum fascia is
// vivid and takes no cap, the darker oak stop would) is undone, until the
// edited map's masks equal the input's exactly.
export function facadeAlbedo(albedo, material, roof = null) {
    const out = new PNG({ width: albedo.width, height: albedo.height, colorType: 6 });
    albedo.data.copy(out.data);
    const edited = [];
    for (let p = 0; p < albedo.width * albedo.height; p++) {
        const i = p * 4;
        if (!albedo.data[i + 3]) continue;
        const table = material.data[i] === TIMBER ? OAK_FROM : material.data[i] === METAL ? IRON_FROM : null;
        const to = table?.[hexOf(albedo.data[i], albedo.data[i + 1], albedo.data[i + 2])];
        if (!to) continue;
        out.data[i] = parseInt(to.slice(1, 3), 16);
        out.data[i + 1] = parseInt(to.slice(3, 5), 16);
        out.data[i + 2] = parseInt(to.slice(5, 7), 16);
        edited.push(p);
    }
    let kept = edited.length;
    if (roof?.occluder && edited.length) {
        const mapOf = (data) => roofWeatherMap({ width: albedo.width, height: albedo.height, albedo: data, occluder: roof.occluder.data, material: material.data, emissive: roof.emissive?.data || null });
        const base = mapOf(albedo.data);
        const live = new Set(edited);
        for (let pass = 0; pass < 8; pass++) {
            const now = mapOf(out.data);
            const moved = roofMaskDiff(base, now);
            const undo = moved.filter((p) => live.has(p));
            if (!moved.length) break;
            if (!undo.length) throw new Error('facade ramp edits moved the roof masks off the edited texels');
            for (const p of undo) {
                for (let k = 0; k < 3; k++) out.data[p * 4 + k] = albedo.data[p * 4 + k];
                live.delete(p);
            }
        }
        kept = live.size;
    }
    return { png: out, changed: kept };
}

// Texels whose roof class, trim or cap differs between two roof maps.
function roofMaskDiff(a, b) {
    if (!a || !b) return a === b ? [] : [-1];
    const out = [];
    for (let p = 0; p < a.cls.length; p++) {
        if (a.cls[p] !== b.cls[p] || a.cap[p] !== b.cap[p] || a.trimmed[p] !== b.trimmed[p]) out.push(p);
    }
    return out;
}

// Command's gate strip (manifest layers.gate: 3 frames of 40x80, bottom-centre
// at base [131, 198], so frame-local (x, y) is base (x + 111, y + 118)).
// Frame 0 restates the base crop (restIsBase); the ajar and open frames take
// the same ramp edits on the leaf's own texels: inside the door's arch, the
// table colours only.
const GATE = Object.freeze({ frames: 3, w: 40, h: 80, left: 111, top: 118 });
export function facadeGate(gate, base) {
    const out = new PNG({ width: gate.width, height: gate.height, colorType: 6 });
    gate.data.copy(out.data);
    const leaf = FACADE_REGIONS.command.leaf;
    for (let f = 0; f < GATE.frames; f++) {
        for (let y = 0; y < GATE.h; y++) {
            for (let x = 0; x < GATE.w; x++) {
                const o = (y * gate.width + f * GATE.w + x) * 4;
                const bx = x + GATE.left;
                const by = y + GATE.top;
                if (f === 0) {
                    const b = (by * base.width + bx) * 4;
                    if (out.data[o + 3] && base.data[b + 3]) for (let k = 0; k < 3; k++) out.data[o + k] = base.data[b + k];
                    continue;
                }
                if (!out.data[o + 3] || !inLeaf(leaf, bx, by)) continue;
                const key = hexOf(out.data[o], out.data[o + 1], out.data[o + 2]);
                const to = OAK_FROM[key] || IRON_FROM[key];
                if (!to) continue;
                for (let k = 0; k < 3; k++) out.data[o + k] = parseInt(to.slice(1 + 2 * k, 3 + 2 * k), 16);
            }
        }
    }
    return out;
}

const same = (a, b) => a.width === b.width && a.height === b.height && Buffer.compare(a.data, b.data) === 0;

function main() {
    const check = process.argv.includes('--check');
    let stale = 0;
    for (const type of Object.keys(FACADE_REGIONS)) {
        const dir = `buildings/building.${type}`;
        const albedo = read(`${dir}/base.png`);
        const emissive = existsSync(join(spritesRoot, dir, 'base.emissive.png')) ? read(`${dir}/base.emissive.png`) : null;
        const first = facadeMaterial(type, albedo, emissive);
        const occluder = existsSync(join(spritesRoot, dir, 'base.occluder.png')) ? read(`${dir}/base.occluder.png`) : null;
        const { png: edited, changed } = facadeAlbedo(albedo, first, { occluder, emissive });
        const png = facadeMaterial(type, edited, emissive);
        const target = join(spritesRoot, dir, 'base.material.png');
        const counts = {};
        for (let p = 0; p < png.width * png.height; p++) if (png.data[p * 4 + 3]) counts[png.data[p * 4]] = (counts[png.data[p * 4]] || 0) + 1;
        const drift = Buffer.compare(first.data, png.data) !== 0;
        const gatePath = type === 'command' ? `${dir}/gate.png` : null;
        const gate = gatePath ? read(gatePath) : null;
        const gateOut = gate ? facadeGate(gate, edited) : null;
        if (check) {
            const ok = !changed && !drift && existsSync(target) && same(read(`${dir}/base.material.png`), png) && (!gate || same(gate, gateOut));
            if (!ok) stale++;
            console.log(`[facade-materials] ${type} ${ok ? 'ok' : `STALE (${changed} albedo texels to edit)`} ${JSON.stringify(counts)}`);
        } else {
            if (drift) throw new Error(`${type}: the ramp edits moved the classification; review the tables`);
            if (changed) writeFileSync(join(spritesRoot, dir, 'base.png'), PNG.sync.write(edited));
            if (gate && !same(gate, gateOut)) writeFileSync(join(spritesRoot, gatePath), PNG.sync.write(gateOut));
            writeFileSync(target, PNG.sync.write(png));
            console.log(`[facade-materials] ${type} -> ${dir}/base.material.png ${JSON.stringify(counts)}; ${changed} albedo texels ramp-edited`);
        }
    }
    if (stale) process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
