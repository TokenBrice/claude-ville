#!/usr/bin/env node
// Living Isle W8.1 — offline post-pass for the Command attention banner and
// the repo standing stones. Reads the reviewed PixelLab pixflux raws (cached
// under output/living-isle-assets/raw/, provenance in manifest.yaml) and
// writes the shipped PNGs. No generations are spent here; re-running is free.
//
//   banner  building.command/banner{,Error,Limit}.png — 5-frame strips: frame
//           0 is empty (restIsBase), frames 1–4 hang the cloth at the four
//           wait-age drops (BANNER_DROPS). The cloth is the one generated
//           banner, shortened by cutting body rows (rod, head and swallowtail
//           are kept whole), so every drop is the same cloth. The lead
//           bucket's EventShapes motif is baked into the head in iron ink.
//           Error / limit are offline hue re-tones of the same cloth onto
//           the errored / rate-limited status hues (theme.js).
//   stones  props/prop.repoStone.{cairn,stone,pillar,obelisk}.png — trimmed
//           to content, greys snapped (OKLab nearest) onto building.archive's
//           ashlar greys, moss onto veg.standingStone.mossy's greens.
//
// Usage: node scripts/sprites/bake-banner-stones.mjs [--only=banner|stones]

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { repoRoot } from './pixellab-rest.mjs';
import { EVENT_SHAPES } from '../../claudeville/src/presentation/shared/EventShapes.js';

const RAW = join(repoRoot, 'output/living-isle-assets/raw');
const SPRITES = join(repoRoot, 'claudeville/assets/sprites');
const only = (process.argv.find(a => a.startsWith('--only=')) || '').slice(7);

// Cloth rows below the rod for SignalLedger.waitAgeTier 0..3 (< 1, 1–5,
// 5–15, >= 15 min): 20-row steps up to the whole generated cloth, which is
// as long as the Command's flag tower face allows (rod under the tower
// cornice, full drop ending above the plinth).
export const BANNER_DROPS = [25, 45, 65, 85];
const BANNER_RAW = 'banner-s11-i120.png';
// Base-local bottom-centre of one frame (manifest `building.command.layers.banner.anchor`).
const BANNER_ANCHOR = [89, 155];
const STONE_RAWS = {
    cairn: 'cairn-s17-i0.png',
    stone: 'stone-s17-i0.png',
    pillar: 'pillar-s17-i0.png',
    obelisk: 'obelisk-s11-i0.png',
};
const HUES = {
    banner: { hex: '#e8d44d', motif: 'needs-you' },
    bannerError: { hex: '#e06c5b', motif: 'alert' },
    bannerLimit: { hex: '#f06ae0', motif: 'limit-gate' },
};
const INK = [0x2b, 0x2a, 0x33];

const read = (path) => PNG.sync.read(readFileSync(path));
const at = (p, x, y) => { const i = (y * p.width + x) * 4; return [p.data[i], p.data[i + 1], p.data[i + 2], p.data[i + 3]]; };
const put = (p, x, y, c) => { const i = (y * p.width + x) * 4; p.data[i] = c[0]; p.data[i + 1] = c[1]; p.data[i + 2] = c[2]; p.data[i + 3] = c[3] ?? 255; };
const hex = (h) => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));

function bounds(p) {
    let x0 = p.width, y0 = p.height, x1 = -1, y1 = -1;
    for (let y = 0; y < p.height; y++) for (let x = 0; x < p.width; x++) {
        if (at(p, x, y)[3] < 128) continue;
        x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
    }
    return { x0, y0, x1, y1, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}
// Hard alpha: pixel art never ships half-transparent edge texels.
function crop(p, b) {
    const out = new PNG({ width: b.w, height: b.h });
    for (let y = 0; y < b.h; y++) for (let x = 0; x < b.w; x++) {
        const c = at(p, b.x0 + x, b.y0 + y);
        if (c[3] >= 128) put(out, x, y, [c[0], c[1], c[2], 255]);
    }
    return out;
}

function rgbToHsl([r, g, b]) {
    r /= 255; g /= 255; b /= 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2;
    if (mx === mn) return [0, 0, l];
    const d = mx - mn, s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
    const h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return [h * 60, s, l];
}
function hslToRgb([h, s, l]) {
    h = ((h % 360) + 360) % 360 / 360;
    if (!s) return [l, l, l].map(v => Math.round(v * 255));
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
    const f = (t) => { t = (t + 1) % 1; return t < 1 / 6 ? p + (q - p) * 6 * t : t < 1 / 2 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p; };
    return [f(h + 1 / 3), f(h), f(h - 1 / 3)].map(v => Math.round(Math.max(0, Math.min(1, v)) * 255));
}
function oklab([r, g, b]) {
    const lin = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
    const [R, G, B] = [lin(r), lin(g), lin(b)];
    const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
    const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
    const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
    return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}
const nearest = (c, palette) => {
    const k = oklab(c);
    let best = palette[0], bestD = Infinity;
    for (const p of palette) { const q = p.lab; const d = (k[0] - q[0]) ** 2 + (k[1] - q[1]) ** 2 + (k[2] - q[2]) ** 2; if (d < bestD) { bestD = d; best = p; } }
    return best.rgb;
};
function paletteOf(path, keep, limit) {
    const p = read(path), freq = new Map();
    for (let i = 0; i < p.data.length; i += 4) {
        if (p.data[i + 3] < 255) continue;
        const c = [p.data[i], p.data[i + 1], p.data[i + 2]];
        if (!keep(c)) continue;
        const k = c.join(',');
        freq.set(k, (freq.get(k) || 0) + 1);
    }
    return [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit)
        .map(([k]) => { const rgb = k.split(',').map(Number); return { rgb, lab: oklab(rgb) }; });
}

// ─── banner ──────────────────────────────────────────────────────────────────

const isCloth = (c) => { const [h, s, l] = rgbToHsl(c); return s > 0.25 && h >= 25 && h <= 75 && l > 0.18 && l < 0.92; };

function bakeBanner() {
    const raw = crop(read(join(RAW, BANNER_RAW)), bounds(read(join(RAW, BANNER_RAW))));
    // The rod is the run of rows wider than the cloth at the top.
    const rowSpan = (y) => { let a = -1, b = -1; for (let x = 0; x < raw.width; x++) if (at(raw, x, y)[3]) { if (a < 0) a = x; b = x; } return a < 0 ? 0 : b - a + 1; };
    const clothW = rowSpan(Math.floor(raw.height / 2));
    let rod = 0;
    while (rod < raw.height && rowSpan(rod) > clothW) rod++;
    const clothRows = raw.height - rod;
    const head = 8, tail = 14;
    const body = clothRows - head - tail;
    const longest = BANNER_DROPS.at(-1);
    if (longest > clothRows) throw new Error(`banner cloth is ${clothRows} rows; the longest drop wants ${longest}`);
    const frameW = raw.width + (raw.width % 2);
    const frameH = rod + longest;
    // Dominant cloth colour → each status hue (hue swap, saturation ratio,
    // lightness offset), so all three banners share one shading.
    const counts = new Map();
    for (let y = 0; y < raw.height; y++) for (let x = 0; x < raw.width; x++) {
        const c = at(raw, x, y);
        if (c[3] && isCloth(c)) { const k = c.slice(0, 3).join(','); counts.set(k, (counts.get(k) || 0) + 1); }
    }
    const dominant = rgbToHsl([...counts.entries()].sort((a, b) => b[1] - a[1])[0][0].split(',').map(Number));
    const sourceRow = (drop, row) => {
        // Rows of a `drop`-row cloth map back onto the raw cloth: the head and
        // swallowtail stay whole, the body loses its lower rows.
        if (row < head) return rod + row;
        if (row >= drop - tail) return rod + clothRows - (drop - row);
        return rod + row;
    };
    for (const [name, { hex: target, motif }] of Object.entries(HUES)) {
        const goal = rgbToHsl(hex(target));
        const strip = new PNG({ width: frameW * (BANNER_DROPS.length + 1), height: frameH });
        // Frame 0 is the live base crop under the frame (restIsBase): an idle
        // Command is its base.png exactly, and the part draws nothing.
        const base = read(join(SPRITES, 'buildings/building.command/base.png'));
        const baseLeft = Math.round(BANNER_ANCHOR[0] - frameW / 2);
        const baseTop = Math.round(BANNER_ANCHOR[1] - frameH);
        for (let y = 0; y < frameH; y++) for (let x = 0; x < frameW; x++) {
            const c = at(base, baseLeft + x, baseTop + y);
            if (c[3]) put(strip, x, y, c);
        }
        BANNER_DROPS.forEach((drop, index) => {
            const ox = frameW * (index + 1) + Math.floor((frameW - raw.width) / 2);
            const rows = [...Array(rod).keys()].concat([...Array(drop).keys()].map(r => sourceRow(drop, r)));
            rows.forEach((sy, dy) => {
                for (let x = 0; x < raw.width; x++) {
                    const c = at(raw, x, sy);
                    if (!c[3]) continue;
                    let rgb = c.slice(0, 3);
                    // The rod and its gold caps stay iron and gold on every hue.
                    if (dy >= rod && isCloth(rgb)) {
                        const [h, s, l] = rgbToHsl(rgb);
                        rgb = hslToRgb([h + goal[0] - dominant[0], Math.min(1, s * goal[1] / dominant[1]), Math.max(0, Math.min(1, l + goal[2] - dominant[2]))]);
                    }
                    put(strip, ox + x, dy, [...rgb, 255]);
                }
            });
            // The motif in iron ink on the cloth head, centred.
            const shape = EVENT_SHAPES[motif].slice(4, 12).map(row => row.slice(4, 12));
            const mx = ox + Math.floor((raw.width - 8) / 2);
            const my = rod + 5;
            shape.forEach((row, y) => [...row].forEach((bit, x) => { if (bit === '1') put(strip, mx + x, my + y, [...INK, 255]); }));
        });
        writeFileSync(join(SPRITES, 'buildings/building.command', `${name}.png`), PNG.sync.write(strip));
        console.log(`[banner] ${name}.png ${strip.width}x${strip.height} (frame ${frameW}x${frameH}, rod ${rod}, cloth ${clothRows})`);
    }
}

// ─── stones ──────────────────────────────────────────────────────────────────

function bakeStones() {
    const grey = (c) => { const [, s] = rgbToHsl(c); return s < 0.22; };
    const green = (c) => { const [h, s] = rgbToHsl(c); return s >= 0.22 && h > 60 && h < 170; };
    const ashlar = paletteOf(join(SPRITES, 'buildings/building.archive/base.png'), grey, 18);
    const moss = paletteOf(join(SPRITES, 'vegetation/veg.standingStone.mossy.png'), green, 6);
    for (const [tier, file] of Object.entries(STONE_RAWS)) {
        const src = read(join(RAW, file));
        const out = crop(src, bounds(src));
        for (let y = 0; y < out.height; y++) for (let x = 0; x < out.width; x++) {
            const c = at(out, x, y);
            if (!c[3]) continue;
            const rgb = c.slice(0, 3);
            put(out, x, y, [...nearest(rgb, green(rgb) && moss.length ? moss : ashlar), 255]);
        }
        // Even width keeps the bottom-centre anchor on a whole texel.
        const even = new PNG({ width: out.width + (out.width % 2), height: out.height });
        out.bitblt(even, 0, 0, out.width, out.height, 0, 0);
        writeFileSync(join(SPRITES, 'props', `prop.repoStone.${tier}.png`), PNG.sync.write(even));
        console.log(`[stones] prop.repoStone.${tier}.png ${even.width}x${even.height}`);
    }
}

if (!only || only === 'banner') bakeBanner();
if (!only || only === 'stones') bakeStones();
