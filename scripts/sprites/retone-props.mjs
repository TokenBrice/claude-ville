#!/usr/bin/env node
// Re-tone the off-palette props onto the C1 ramps (Living Isle W2.2, art
// report AD-P4 / AD-Q4). Same OKLab method as the F18 bridge plank re-tone
// (manifest `bridge.ew` note): a texel keeps its OKLab lightness and takes
// the ramp's hue and chroma at that lightness (piecewise linear between the
// ramp's stops, clamped at its ends).
//
// prop.marketStall (and its two colourways): the hot magenta awning stripes
//   and the plum timber were nowhere near the village cloth. Classes by HSV:
//   red-magenta at V >= 0.45 = stripe A, gold-yellow at S >= 0.35 = stripe B,
//   red-magenta below V 0.45 = the frame's timber. Cloth stripes are rank
//   remapped (each class's own lightness range onto the target ramp's range,
//   widened 0.08 either side) so a stripe swap keeps its shading steps and
//   the dark->light stripe contrast stays >= 0.35 L. The frame snaps to
//   `timber` with its lightness kept. The result is quantised to <= 40
//   colours by merging the closest OKLab pair into the more common colour,
//   so every output colour is one the recolour produced.
//     prop.marketStall          A clothCrimson, B clothOchre
//     prop.marketStall.ochre    A clothOchre,   B clothCrimson (swap)
//     prop.marketStall.canvas   A clothCrimson, B undyed canvas (ashlar's
//                               three lit stops)
// monument.minor/medium/major/founding: the cool violet-grey stone snaps to
//   `ashlar` (the landmarks' coursed masonry) and the gold accents to
//   `trimGold`, lightness kept; moss, grass and soil are untouched.
//   MonumentRules tiers are not touched.
//
// Idempotent: the stall colourways are always derived from the original
// stall bytes (sha256-pinned); a monument whose hash differs from its
// original is skipped unless --force is given.
//
// Usage:
//   node scripts/sprites/retone-props.mjs [--dry-run] [--force] [--preview=<dir>]

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { ART_RAMPS } from '../../claudeville/src/config/artPalette.js';
import { repoRoot } from './manifest-utils.mjs';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const force = args.includes('--force');
const previewArg = args.find((arg) => arg.startsWith('--preview='));
const previewDir = previewArg ? previewArg.slice('--preview='.length) : null;

const PROPS = join(repoRoot, 'claudeville', 'assets', 'sprites', 'props');
const STALL = { file: 'prop.marketStall.png', sha256: '1b11858c65e596d30627054f6277907b17cab34330ca656f42523a906fb3c7c2' };
const STALL_COLOURWAYS = [
    { file: 'prop.marketStall.png', a: ART_RAMPS.clothCrimson, b: ART_RAMPS.clothOchre },
    { file: 'prop.marketStall.ochre.png', a: ART_RAMPS.clothOchre, b: ART_RAMPS.clothCrimson },
    { file: 'prop.marketStall.canvas.png', a: ART_RAMPS.clothCrimson, b: ART_RAMPS.ashlar.slice(6) },
];
const MONUMENTS = [
    { file: 'monument.minor.png', sha256: '0c131d2bd0c248cb7971be2ea5dcc17b1cec5de0be1418378b54618692e7d1dd' },
    { file: 'monument.medium.png', sha256: 'c2afed8e05aa76e84d37d7a965c6e8bfae1c84495ef607da960e1c1cc7522106' },
    { file: 'monument.major.png', sha256: '7fcfb4967b0e97b0a6a391d695196095fce7b17790207551b9b587a4e5d13b80' },
    { file: 'monument.founding.png', sha256: '613415360d825aedd466f64bed3ee830c3454d1df02760777f675b351dcf2c9d' },
];
const STALL_MAX_COLOURS = 40;
const CLOTH_WIDEN = 0.08;
// The awning in sprite px: PropWinter's roof polygon for prop.marketStall.
const STALL_AWNING = [[30, 5], [62, 20], [60, 26], [33, 38], [5, 19]];

// ── market stall ────────────────────────────────────────────────────────────
// All three colourways derive from the original stall bytes in one pass; once
// the base file is re-toned the pass is skipped (restore the original to
// rebuild), so a re-run never compounds a re-tone.
{
    const stallBytes = readFileSync(join(PROPS, STALL.file));
    const sha = sha256(stallBytes);
    if (sha !== STALL.sha256) {
        console.log(`[retone-props] skip stall (hash ${sha.slice(0, 12)} is not the original; restore it to rebuild the colourways)`);
    } else {
        for (const way of STALL_COLOURWAYS) {
            const png = PNG.sync.read(stallBytes);
            const counts = retoneStall(png, way);
            const colours = quantise(png, STALL_MAX_COLOURS);
            emit(way.file, png, `stripe A ${counts.a} px, stripe B ${counts.b} px, frame ${counts.frame} px; ${colours} colours`);
        }
    }
}

// ── monuments ───────────────────────────────────────────────────────────────
for (const target of MONUMENTS) {
    const bytes = readFileSync(join(PROPS, target.file));
    const sha = sha256(bytes);
    if (sha !== target.sha256 && !force) {
        console.log(`[retone-props] skip ${target.file} (hash ${sha.slice(0, 12)} is not the original; --force to reprocess)`);
        continue;
    }
    const png = PNG.sync.read(bytes);
    let stone = 0;
    let gold = 0;
    forEachTexel(png, (p, rgb) => {
        const c = hsv(rgb);
        const isGold = c.h >= 30 && c.h <= 65 && c.s >= 0.35 && c.v >= 0.45;
        const isStone = !isGold && (c.s < 0.32 || (c.h >= 190 && c.h <= 300));
        if (!isGold && !isStone) return;
        const out = snapKeepLightness(rgb, isGold ? ART_RAMPS.trimGold : ART_RAMPS.ashlar);
        png.data.set(out, p);
        if (isGold) gold++; else stone++;
    });
    emit(target.file, png, `stone ${stone} px -> ashlar, gold ${gold} px -> trimGold`);
}

// ── recolour ────────────────────────────────────────────────────────────────

function inPolygon(x, y, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const [xi, yi] = poly[i];
        const [xj, yj] = poly[j];
        if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
}

function retoneStall(png, way) {
    // Stripes only inside the awning (the roof polygon PropWinter snows);
    // red goods outside it snap to clothCrimson, the lantern stays lit.
    const classes = { a: [], b: [], frame: [], goods: [] };
    forEachTexel(png, (p, rgb) => {
        const c = hsv(rgb);
        const x = (p / 4) % png.width;
        const y = Math.floor(p / 4 / png.width);
        const awning = inPolygon(x + 0.5, y + 0.5, STALL_AWNING);
        const red = (c.h >= 290 || c.h <= 12) && c.s >= 0.3;
        if (red && c.v < 0.45) classes.frame.push(p);
        else if (red) (awning ? classes.a : classes.goods).push(p);
        else if (awning && c.h >= 28 && c.h <= 62 && c.s >= 0.35 && c.v >= 0.5) classes.b.push(p);
    });
    rankRemap(png, classes.a, way.a);
    rankRemap(png, classes.b, way.b);
    for (const p of classes.goods) png.data.set(snapKeepLightness(rgbAt(png, p), ART_RAMPS.clothCrimson), p);
    for (const p of classes.frame) png.data.set(snapKeepLightness(rgbAt(png, p), ART_RAMPS.timber), p);
    return { a: classes.a.length, b: classes.b.length, frame: classes.frame.length };
}

// The class's own lightness range maps linearly onto the ramp's (widened),
// hue and chroma from the ramp at the new lightness.
function rankRemap(png, texels, ramp) {
    if (!texels.length) return;
    const labs = texels.map((p) => oklab(rgbAt(png, p)));
    const lo = Math.min(...labs.map((lab) => lab[0]));
    const hi = Math.max(...labs.map((lab) => lab[0]));
    const stops = rampStops(ramp);
    const tLo = stops[0][0] - CLOTH_WIDEN;
    const tHi = stops[stops.length - 1][0] + CLOTH_WIDEN;
    texels.forEach((p, i) => {
        const t = hi > lo ? (labs[i][0] - lo) / (hi - lo) : 0.5;
        const L = tLo + t * (tHi - tLo);
        png.data.set(toRgb(rampAt(stops, L)), p);
    });
}

function snapKeepLightness(rgb, ramp) {
    return toRgb(rampAt(rampStops(ramp), oklab(rgb)[0]));
}

function rampStops(ramp) {
    return ramp.map((hex) => oklab(hexToRgb(hex))).sort((u, v) => u[0] - v[0]);
}

// [L, a, b] at lightness L: a/b interpolated between the bracketing stops.
function rampAt(stops, L) {
    if (L <= stops[0][0]) return [L, stops[0][1], stops[0][2]];
    for (let i = 1; i < stops.length; i++) {
        if (L <= stops[i][0]) {
            const [l0, a0, b0] = stops[i - 1];
            const [l1, a1, b1] = stops[i];
            const t = (L - l0) / (l1 - l0 || 1);
            return [L, a0 + t * (a1 - a0), b0 + t * (b1 - b0)];
        }
    }
    const last = stops[stops.length - 1];
    return [L, last[1], last[2]];
}

// Merge the closest OKLab pair (into the more common colour) until at most
// `max` colours remain. Returns the final colour count.
function quantise(png, max) {
    const counts = new Map();
    forEachTexel(png, (p, rgb) => {
        const key = rgb.join(',');
        counts.set(key, (counts.get(key) || 0) + 1);
    });
    const colours = [...counts].map(([key, n]) => ({ key, rgb: key.split(',').map(Number), n, alias: null }));
    for (const c of colours) c.lab = oklab(c.rgb);
    let live = colours.slice();
    while (live.length > max) {
        let best = null;
        for (let i = 0; i < live.length; i++) {
            for (let j = i + 1; j < live.length; j++) {
                const d = Math.hypot(live[i].lab[0] - live[j].lab[0], live[i].lab[1] - live[j].lab[1], live[i].lab[2] - live[j].lab[2]);
                if (!best || d < best.d) best = { d, i, j };
            }
        }
        const [keep, drop] = live[best.i].n >= live[best.j].n ? [live[best.i], live[best.j]] : [live[best.j], live[best.i]];
        keep.n += drop.n;
        drop.alias = keep;
        live = live.filter((c) => c !== drop);
    }
    const resolve = (c) => { while (c.alias) c = c.alias; return c; };
    const byKey = new Map(colours.map((c) => [c.key, c]));
    forEachTexel(png, (p, rgb) => png.data.set(resolve(byKey.get(rgb.join(','))).rgb, p));
    return live.length;
}

// ── io + colour helpers ─────────────────────────────────────────────────────

function emit(file, png, note) {
    console.log(`[retone-props] ${file}: ${note}`);
    const out = PNG.sync.write(png);
    if (previewDir) {
        mkdirSync(previewDir, { recursive: true });
        writeFileSync(join(previewDir, file), out);
    } else if (!dryRun) {
        writeFileSync(join(PROPS, file), out);
    }
}

function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }

function forEachTexel(png, fn) {
    for (let p = 0; p < png.data.length; p += 4) {
        if (png.data[p + 3] === 0) continue;
        fn(p, [png.data[p], png.data[p + 1], png.data[p + 2]]);
    }
}

function rgbAt(png, p) { return [png.data[p], png.data[p + 1], png.data[p + 2]]; }

function hexToRgb(hex) {
    const text = String(hex).replace('#', '');
    return [0, 2, 4].map((o) => parseInt(text.slice(o, o + 2), 16));
}

function hsv([r8, g8, b8]) {
    const r = r8 / 255; const g = g8 / 255; const b = b8 / 255;
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
    return { h, s: max ? d / max : 0, v: max };
}

function oklab([r8, g8, b8]) {
    const lin = (v) => { const c = v / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
    const r = lin(r8); const g = lin(g8); const b = lin(b8);
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
    const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
    const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
    return [
        0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
        1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
        0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
    ];
}

function toRgb([L, A, B]) {
    const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
    const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
    const s = (L - 0.0894841775 * A - 1.2914855480 * B) ** 3;
    const lin = [
        4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
        -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
        -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
    ];
    return lin.map((v) => {
        const c = Math.min(1, Math.max(0, v));
        return Math.round(255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055));
    });
}
