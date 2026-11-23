#!/usr/bin/env node

// EN-2 + C-05 — facade materials & C1 warm-oak harmonization across
// Command, Tavern, Harbor, Watchtower, Forge, and Mine.
//
// Authors `base.material.png` from reviewed architectural regions and colour
// rules for Command, Tavern, Harbor (stone quay/ashlar + timber upper frame,
// crane, doors & 3 piers + metal lantern/hook/rings/clock bezel + fabric
// awning), and Watchtower (stone tower + timber cottage eaves/half-timbering/
// door + metal gallery rail/cupola/finial + fabric curtain), and upgrades
// plum-shaded timber beams onto `timber (2)` on Forge and Mine while keeping
// their authored `fire`, `glass-rune`, and `metal` masks intact. Retones cold
// AI plum-mauve wood pixels (`OAK_FROM`) onto C1 `ART_RAMPS.timber` across the
// base sprites and their strip layers (`command/gate`, `harbor/{crane,door}`,
// `forge/{bellows,billetRack}`, `mine/sheave`), guarded by `RoofWeather`.
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

const T = ART_RAMPS.timber;
const S = ART_RAMPS.slate;
// Reviewed plum-mauve wood shadow hexes across Command, Tavern, Harbor,
// Watchtower, Forge, and Mine -> C1 `ART_RAMPS.timber` by value step.
export const OAK_FROM = Object.freeze({
    '#1d1117': T[0],
    '#20171a': T[0],
    '#2a181a': T[0],
    '#2f1a1d': T[0],
    '#311e26': T[0],
    '#322024': T[0],
    '#3e2c2e': T[1],
    '#3f1c1a': T[1],
    '#432527': T[1],
    '#4a2a30': T[1],
    '#532d36': T[1],
    '#573335': T[1],
    '#5d3239': T[2],
    '#5d3f40': T[2],
    '#663a3f': T[2],
});

const LIT = ART_RAMPS.wetSlate[2];
export const IRON_FROM = Object.freeze({
    '#231821': S[0], '#4c3a4c': S[1], '#5a4454': S[1], '#645663': S[2], '#685c67': S[2], '#746c68': S[2],
    '#7f767f': S[2], '#7d6c6d': S[3], '#867e80': S[3], '#8a8487': S[3], '#857a77': S[3],
    '#9b8c82': LIT, '#a2968f': LIT, '#a99f9a': LIT, '#afa39c': LIT, '#b4aaa6': LIT,
});

// Reviewed regions, sprite px [x, y, w, h].
//   mode:   'author' (builds material sidecar from regions) or 'upgrade'
//           (preserves existing authored fire/glass-rune/metal/timber sidecar
//           and upgrades plum-shaded wood inside `timber` to TIMBER + modal
//           ink sync).
export const FACADE_REGIONS = Object.freeze({
    command: {
        mode: 'author',
        timber: [],
        leaf: [[119, 113, 32, 84]],
        metal: [[127, 106, 11, 13], [88, 175, 15, 23], [136, 199, 18, 24]],
        fabric: [[93, 131, 7, 25], [190, 179, 7, 25], [203, 120, 7, 25], [224, 111, 6, 25]],
        strips: [
            { file: 'gate.png', frames: 3, w: 40, h: 80, left: 111, top: 118, restIsBase: true, leafOnly: true, iron: true },
        ],
    },
    tavern: {
        mode: 'author',
        timber: [[0, 0, 296, 288]],
        leaf: [],
        metal: [],
        ashlar: [202, 198],
        strips: [],
    },
    harbor: {
        mode: 'author',
        timber: [
            [24, 0, 206, 146],
            [68, 144, 22, 34],
            [128, 134, 18, 28],
            [42, 142, 54, 66],
            [232, 64, 152, 220],
            [92, 140, 142, 144],
        ],
        stoneKeep: [
            [131, 14, 18, 28],
        ],
        quayStonePoly: [
            [0, 166], [42, 154], [42, 206], [94, 206], [96, 226], [3, 187],
        ],
        leaf: [[130, 136, 14, 25]],
        metal: [
            [6, 138, 22, 38],
            [80, 176, 12, 12],
            [48, 194, 12, 14],
            [124, 178, 12, 14],
            [180, 146, 12, 14],
            [202, 136, 12, 14],
            [172, 2, 26, 60],
        ],
        fabric: [[48, 52, 18, 24]],
        retoneIron: false,
        strips: [
            { file: 'crane.png', frames: 6, w: 22, h: 56, left: 74, top: 150, restIsBase: true },
            { file: 'door.png', frames: 3, w: 12, h: 24, left: 131, top: 137, restIsBase: true },
        ],
    },
    watchtower: {
        mode: 'author',
        timber: [[68, 236, 98, 110]],
        stoneKeep: [[98, 236, 18, 22]],
        leaf: [[85, 297, 16, 31]],
        metal: [
            [126, 80, 74, 44],
            [156, 38, 18, 20],
        ],
        fabric: [[102, 268, 20, 22]],
        retoneIron: false,
        strips: [],
    },
    forge: {
        mode: 'upgrade',
        timber: [[16, 12, 198, 220]],
        stoneKeep: [[158, 6, 58, 122]],
        retoneIron: false,
        strips: [
            { file: 'bellows.png', frames: 4, w: 28, h: 22, left: 43, top: 175, restIsBase: false },
            { file: 'billetRack.png', frames: 3, w: 18, h: 26, left: 202, top: 165, restIsBase: false },
        ],
    },
    mine: {
        mode: 'upgrade',
        timber: [[36, 16, 128, 212]],
        stoneKeep: [],
        retoneIron: false,
        strips: [
            { file: 'sheave.png', frames: 4, w: 22, h: 32, left: 76, top: 34, restIsBase: true },
        ],
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

export function isBrown(r, g, b) {
    if (OAK_FROM[hexOf(r, g, b)]) return true;
    const { h, s, v } = hsv(r, g, b);
    if (h >= 330) return s >= 0.26 && s <= 0.55 && v <= 0.6;
    return h <= 42 && s >= 0.26 && v <= 0.88 && !isFlame(r, g, b);
}

function isCloth(r, g, b) {
    const { h, s, v } = hsv(r, g, b);
    return ((h >= 335 || h <= 16) && s >= 0.42 && v >= 0.25)
        || (h >= 25 && h <= 60 && s >= 0.4 && v > 0.45)
        || (s <= 0.14 && v >= 0.82);
}

function isFlame(r, g, b) {
    const { h, s, v } = hsv(r, g, b);
    return h <= 50 && s >= 0.55 && v > 0.9;
}

const isInk = (r, g, b) => Math.max(r, g, b) < 24;

const inside = (rects = [], x, y) => rects.some(([rx, ry, rw, rh]) => x >= rx && y >= ry && x < rx + rw && y < ry + rh);

function inPoly(poly, x, y) {
    if (!poly) return false;
    let hit = false;
    const px = x + 0.5;
    const py = y + 0.5;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const [xi, yi] = poly[i];
        const [xj, yj] = poly[j];
        if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) hit = !hit;
    }
    return hit;
}

// Inside an arched leaf: its rectangle, cut by a semicircular head.
function inLeaf(leaves = [], x, y) {
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

function assignOutlineModalClass(cls, data, width, height, keepFallback = false) {
    const out = cls.slice();
    const at = (x, y) => (y * width + x) * 4;
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
            let best = keepFallback ? (cls[y * width + x] || STONE) : STONE;
            let most = 0;
            for (const [c, n] of votes) if (n > most || (n === most && c === STONE)) { best = c; most = n; }
            out[y * width + x] = best;
        }
    }
    return out;
}

export function facadeMaterial(type, albedo, emissive, existingMaterial = null) {
    const regions = FACADE_REGIONS[type];
    const { width, height, data } = albedo;
    const at = (x, y) => (y * width + x) * 4;
    const lit = (x, y) => emissive && emissive.data[at(x, y) + 3] > 0;

    if (regions.mode === 'upgrade') {
        const cls = new Uint8Array(width * height).fill(STONE);
        if (existingMaterial) {
            for (let p = 0; p < width * height; p++) {
                if (existingMaterial.data[p * 4 + 3]) cls[p] = existingMaterial.data[p * 4];
            }
        }
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const p = y * width + x;
                const i = p * 4;
                if (!data[i + 3] || lit(x, y)) continue;
                if (cls[p] !== STONE) continue;
                if (inside(regions.stoneKeep, x, y)) continue;
                const [r, g, b] = [data[i], data[i + 1], data[i + 2]];
                if (inside(regions.timber, x, y) && isBrown(r, g, b) && !isInk(r, g, b)) {
                    cls[p] = TIMBER;
                }
            }
        }
        const out = assignOutlineModalClass(cls, data, width, height, true);
        const png = new PNG({ width, height, colorType: 6 });
        for (let p = 0; p < width * height; p++) {
            const a = data[p * 4 + 3];
            png.data[p * 4] = a ? out[p] : 0;
            png.data[p * 4 + 3] = a;
        }
        return png;
    }

    const cls = new Uint8Array(width * height).fill(STONE);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const i = at(x, y);
            if (!data[i + 3] || lit(x, y)) continue;
            if (regions.ashlar && x >= regions.ashlar[0] && y >= regions.ashlar[1] - (x - regions.ashlar[0]) / 2) continue;
            if (inside(regions.stoneKeep, x, y)) continue;
            const [r, g, b] = [data[i], data[i + 1], data[i + 2]];
            if (regions.fabric && inside(regions.fabric, x, y) && isCloth(r, g, b)) {
                cls[y * width + x] = FABRIC;
            } else if (inside(regions.metal, x, y) && isFitting(r, g, b) && !isInk(r, g, b)) {
                cls[y * width + x] = METAL;
            } else if (!inPoly(regions.quayStonePoly, x, y)
                && (inside(regions.timber, x, y) || inLeaf(regions.leaf, x, y))
                && isBrown(r, g, b)) {
                cls[y * width + x] = TIMBER;
            }
        }
    }
    for (const [rx, ry, rw, rh] of (regions.leaf || [])) {
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
    const out = assignOutlineModalClass(cls, data, width, height);
    const png = new PNG({ width, height, colorType: 6 });
    for (let p = 0; p < width * height; p++) {
        const a = data[p * 4 + 3];
        png.data[p * 4] = a ? out[p] : 0;
        png.data[p * 4 + 3] = a;
    }
    return png;
}

const read = (rel) => PNG.sync.read(readFileSync(join(spritesRoot, rel)));

export function facadeAlbedo(albedo, material, roof = null, { retoneIron = true } = {}) {
    const out = new PNG({ width: albedo.width, height: albedo.height, colorType: 6 });
    albedo.data.copy(out.data);
    const edited = [];
    for (let p = 0; p < albedo.width * albedo.height; p++) {
        const i = p * 4;
        if (!albedo.data[i + 3]) continue;
        const table = material.data[i] === TIMBER
            ? OAK_FROM
            : (retoneIron && material.data[i] === METAL ? IRON_FROM : null);
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

function roofMaskDiff(a, b) {
    if (!a || !b) return a === b ? [] : [-1];
    const out = [];
    for (let p = 0; p < a.cls.length; p++) {
        if (a.cls[p] !== b.cls[p] || a.cap[p] !== b.cap[p] || a.trimmed[p] !== b.trimmed[p]) out.push(p);
    }
    return out;
}

export function facadeStrip(strip, base, spec, leafRects = []) {
    const out = new PNG({ width: strip.width, height: strip.height, colorType: 6 });
    strip.data.copy(out.data);
    for (let f = 0; f < spec.frames; f++) {
        for (let y = 0; y < spec.h; y++) {
            for (let x = 0; x < spec.w; x++) {
                const o = (y * strip.width + f * spec.w + x) * 4;
                const bx = x + spec.left;
                const by = y + spec.top;
                if (f === 0 && spec.restIsBase && bx >= 0 && by >= 0 && bx < base.width && by < base.height) {
                    const b = (by * base.width + bx) * 4;
                    if (out.data[o + 3] && base.data[b + 3]) {
                        for (let k = 0; k < 3; k++) out.data[o + k] = base.data[b + k];
                    }
                    continue;
                }
                if (!out.data[o + 3]) continue;
                if (spec.leafOnly && !inLeaf(leafRects, bx, by)) continue;
                const key = hexOf(out.data[o], out.data[o + 1], out.data[o + 2]);
                const to = OAK_FROM[key] || (spec.iron ? IRON_FROM[key] : null);
                if (!to) continue;
                for (let k = 0; k < 3; k++) out.data[o + k] = parseInt(to.slice(1 + 2 * k, 3 + 2 * k), 16);
            }
        }
    }
    return out;
}

export function facadeGate(gate, base) {
    return facadeStrip(gate, base, FACADE_REGIONS.command.strips[0], FACADE_REGIONS.command.leaf);
}

const same = (a, b) => a.width === b.width && a.height === b.height && Buffer.compare(a.data, b.data) === 0;

function main() {
    const check = process.argv.includes('--check');
    let stale = 0;
    for (const [type, cfg] of Object.entries(FACADE_REGIONS)) {
        const dir = `buildings/building.${type}`;
        const albedo = read(`${dir}/base.png`);
        const emissive = existsSync(join(spritesRoot, dir, 'base.emissive.png')) ? read(`${dir}/base.emissive.png`) : null;
        const target = join(spritesRoot, dir, 'base.material.png');
        const existingMat = existsSync(target) ? read(`${dir}/base.material.png`) : null;
        const first = facadeMaterial(type, albedo, emissive, existingMat);
        const occluder = existsSync(join(spritesRoot, dir, 'base.occluder.png')) ? read(`${dir}/base.occluder.png`) : null;
        const retoneIron = cfg.retoneIron !== false;
        const { png: edited, changed } = facadeAlbedo(albedo, first, { occluder, emissive }, { retoneIron });
        const png = facadeMaterial(type, edited, emissive, cfg.mode === 'upgrade' ? first : null);
        const counts = {};
        for (let p = 0; p < png.width * png.height; p++) if (png.data[p * 4 + 3]) counts[png.data[p * 4]] = (counts[png.data[p * 4]] || 0) + 1;
        const drift = Buffer.compare(first.data, png.data) !== 0;

        const stripUpdates = [];
        for (const s of (cfg.strips || [])) {
            const rel = `${dir}/${s.file}`;
            if (!existsSync(join(spritesRoot, rel))) continue;
            const src = read(rel);
            const next = facadeStrip(src, edited, s, cfg.leaf || []);
            stripUpdates.push({ rel, same: same(src, next), next });
        }
        const stripsOk = stripUpdates.every((u) => u.same);

        if (check) {
            const ok = !changed && !drift && existsSync(target) && same(read(`${dir}/base.material.png`), png) && stripsOk;
            if (!ok) stale++;
            console.log(`[facade-materials] ${type} ${ok ? 'ok' : `STALE (${changed} albedo texels to edit)`} ${JSON.stringify(counts)}`);
        } else {
            if (drift) throw new Error(`${type}: the ramp edits moved the classification; review the tables`);
            if (changed) writeFileSync(join(spritesRoot, dir, 'base.png'), PNG.sync.write(edited));
            for (const u of stripUpdates) {
                if (!u.same) writeFileSync(join(spritesRoot, u.rel), PNG.sync.write(u.next));
            }
            writeFileSync(target, PNG.sync.write(png));
            console.log(`[facade-materials] ${type} -> ${dir}/base.material.png ${JSON.stringify(counts)}; ${changed} albedo texels ramp-edited`);
        }
    }
    if (stale) process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
