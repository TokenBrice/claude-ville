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
//
// bridge.ew (the pond plank, bridges BR-1): F18 kept the plum original's
//   dark lightness, so the plank was the darkest wood in the village. This
//   pass lifts it: L <= 0.16 is kept (ink, plank gaps), above it
//   L' = 0.16 + (L - 0.16) * 1.89 (capped at 0.80), which puts the deck top's
//   L50 at 0.58 (strength S2). Hue and chroma come from `timber` plus one
//   oak-light stop sampled from the landmark deck's lit boards; HSV
//   saturation is capped at 0.62 where V >= 0.5 (art:analyze Tier A). Then
//   the back-rail posts and rope, all the plank shows from behind the
//   landmark's far handrail, are erased.
//
// Idempotent: the stall colourways are always derived from the original
// stall bytes, and the plank from its plum original read from git (both
// sha256-pinned).
//
// Usage:
//   node scripts/sprites/retone-props.mjs [--dry-run] [--preview=<dir>]

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { ART_RAMPS } from '../../claudeville/src/config/artPalette.js';
import { repoRoot } from './manifest-utils.mjs';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const previewArg = args.find((arg) => arg.startsWith('--preview='));
const previewDir = previewArg ? previewArg.slice('--preview='.length) : null;

const PROPS = join(repoRoot, 'claudeville', 'assets', 'sprites', 'props');
const STALL = { file: 'prop.marketStall.png', sha256: '1b11858c65e596d30627054f6277907b17cab34330ca656f42523a906fb3c7c2' };
const STALL_COLOURWAYS = [
    { file: 'prop.marketStall.png', a: ART_RAMPS.clothCrimson, b: ART_RAMPS.clothOchre },
    { file: 'prop.marketStall.ochre.png', a: ART_RAMPS.clothOchre, b: ART_RAMPS.clothCrimson },
    { file: 'prop.marketStall.canvas.png', a: ART_RAMPS.clothCrimson, b: ART_RAMPS.ashlar.slice(6) },
];
const STALL_MAX_COLOURS = 40;
const CLOTH_WIDEN = 0.08;
// The awning in sprite px: PropWinter's roof polygon for prop.marketStall.
const STALL_AWNING = [[30, 5], [62, 20], [60, 26], [33, 38], [5, 19]];

const BRIDGES = join(repoRoot, 'claudeville', 'assets', 'sprites', 'bridges');
const PLANK = {
    file: 'bridge.ew.png',
    source: '006e50a2:claudeville/assets/sprites/bridges/bridge.ew.png',
    sha256: 'b61ff19ad68c1ed3fa0cb66e3f09739c795e7cc91e1a0ce435ee4329beef1651',
};
const PLANK_KNEE = 0.16;
const PLANK_GAIN = 1.89;
const PLANK_L_MAX = 0.80;
const PLANK_S_CAP = 0.62;
const OAK_LIGHT = '#d1874e';
// The back rail in sprite px: every texel above the deck's top edge in
// columns 2..29 is post or rope. The posts stand on the deck at the left and
// top vertices; `deckTop` is the deck's first row under each post column,
// and their feet (down to `foot`) are refilled from the deck one post-width
// along the same edge (`from`), so the edge highlight runs on unbroken.
const PLANK_RAIL = { x0: 2, x1: 29 };
const PLANK_POSTS = [
    { x0: 2, deckTop: [36, 36, 35, 35], foot: 37, from: [4, -2] },
    { x0: 26, deckTop: [24, 23, 23, 22], foot: 26, from: [-4, 2] },
];

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

// ── pond plank ──────────────────────────────────────────────────────────────
{
    let bytes = null;
    try {
        bytes = execFileSync('git', ['show', PLANK.source], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
        console.log(`[retone-props] skip ${PLANK.file} (git cannot read ${PLANK.source}; a full clone is needed)`);
    }
    if (bytes && sha256(bytes) !== PLANK.sha256) {
        console.log(`[retone-props] skip ${PLANK.file} (hash ${sha256(bytes).slice(0, 12)} is not the plum original)`);
    } else if (bytes) {
        const png = PNG.sync.read(bytes);
        liftPlank(png);
        const cleared = eraseBackRail(png);
        emit(PLANK.file, png, `lightness lift x${PLANK_GAIN} above L ${PLANK_KNEE}; back rail erased (${cleared} px cleared)`, BRIDGES);
    }
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

function liftPlank(png) {
    const stops = rampStops([...ART_RAMPS.timber, OAK_LIGHT]);
    forEachTexel(png, (p, rgb) => {
        const L = oklab(rgb)[0];
        const lifted = L <= PLANK_KNEE ? L : Math.min(PLANK_L_MAX, PLANK_KNEE + (L - PLANK_KNEE) * PLANK_GAIN);
        png.data.set(capSaturation(rampAt(stops, lifted)), p);
    });
}

// Scale chroma down until HSV S <= PLANK_S_CAP (only where V >= 0.5).
function capSaturation([L, A, B]) {
    let rgb = toRgb([L, A, B]);
    for (let i = 0; i < 12; i++) {
        const { s, v } = hsv(rgb);
        if (s <= PLANK_S_CAP || v < 0.5) break;
        A *= 0.93;
        B *= 0.93;
        rgb = toRgb([L, A, B]);
    }
    return rgb;
}

function eraseBackRail(png) {
    const at = (x, y) => (y * png.width + x) * 4;
    const deckTop = new Map();
    for (const post of PLANK_POSTS) post.deckTop.forEach((y, i) => deckTop.set(post.x0 + i, y));
    let cleared = 0;
    for (let x = PLANK_RAIL.x0; x <= PLANK_RAIL.x1; x++) {
        // Off the posts, the deck is the column's lowest opaque run.
        let top = deckTop.get(x);
        if (top === undefined) {
            top = png.height - 1;
            while (top > 0 && png.data[at(x, top) + 3] === 0) top--;
            while (top > 0 && png.data[at(x, top - 1) + 3] !== 0) top--;
        }
        for (let y = 0; y < top; y++) {
            if (png.data[at(x, y) + 3] === 0) continue;
            png.data.fill(0, at(x, y), at(x, y) + 4);
            cleared++;
        }
    }
    for (const { x0, deckTop: tops, foot, from: [dx, dy] } of PLANK_POSTS) {
        tops.forEach((top, i) => {
            for (let y = top; y <= foot; y++) png.data.copyWithin(at(x0 + i, y), at(x0 + i + dx, y + dy), at(x0 + i + dx, y + dy) + 4);
        });
    }
    return cleared;
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

function emit(file, png, note, dir = PROPS) {
    console.log(`[retone-props] ${file}: ${note}`);
    const out = PNG.sync.write(png);
    if (previewDir) {
        mkdirSync(previewDir, { recursive: true });
        writeFileSync(join(previewDir, file), out);
    } else if (!dryRun) {
        writeFileSync(join(dir, file), out);
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
