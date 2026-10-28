#!/usr/bin/env node
// The Hourglass Belfry, the north shore's account instrument (IsleLandmarks.js,
// BelfryQuota.js): finish its PixelLab `create_map_object` candidate into
// prop.hourglassBelfry.png and bake the glass strip prop.hourglassBelfryGlass.png.
//
// Input: the raw download cached at output/landmarks/prop.hourglassBelfry.a.raw
// (the manifest `provenance.objectId` names the job). The candidate is keyed
// from the upper left already and stands on no ground plate, so it is neither
// mirrored nor plate-stripped. Steps:
//   1. See-through texels inside the open stage (transparent and unreachable
//      from the canvas edge: beside each glass's neck) take the stage's dark
//      interior, so the loggia reads deep, never hollow. The candidate's teal
//      wash on the arch floors under the glasses takes the dark ashlar, a
//      shadowed stone sill rather than water.
//   2. Each glass's interior is found 4-connected from a seed in each bulb,
//      bounded by its ink outline (Rec. 601 luma < 52). The base paints it as
//      empty glass, so the art claims no quota of its own.
//   3. Masonry outside the glasses snaps onto ART_RAMPS.ashlar by luminance
//      (the finish-isle-landmarks rule).
//   4. The strip: one `BELFRY_GLASS_FRAME` cell per state per glass, in
//      `BELFRY_GLASS_STATES` order, Claude's glass (west arch, lit) first,
//      then Codex's (east arch, shade); a cell lies on its glass at
//      `BELFRY_GLASS_ORIGINS` (base-local texels).
//      - `l0`–`l5`: the upper bulb holds the sand left, by whole rows up from
//        the neck; what ran out lies as a mound below; a one-texel stream
//        falls while sand remains. Claude's sand is the trim gold, Codex's
//        the dome slate.
//      - `limit`: the spent glass with a cord knotted at its neck, in the
//        house lavender (`--cv-purple` #b79ae6, the calm account hue of Q3).
//      - `unknown`: a canvas shroud over the glass: no reading, no claim.
//      - `peak`: the interior in C4 cream, the reset moment's one cream frame.
// The roof is harmonized afterwards, like every isle landmark's:
//   node scripts/sprites/harmonize-roofs.mjs --building=prop.hourglassBelfry
//
// Usage: node scripts/sprites/bake-hourglass-belfry.mjs [--preview=<dir>]

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { repoRoot } from './manifest-utils.mjs';
import { ART_RAMPS, EFFECT_COLORS } from '../../claudeville/src/config/artPalette.js';
import { BELFRY_LEVELS } from '../../claudeville/src/presentation/character-mode/BelfryQuota.js';
import {
    BELFRY_GLASS_FRAME,
    BELFRY_GLASS_ORIGINS,
    BELFRY_GLASS_STATES,
} from '../../claudeville/src/presentation/character-mode/IsleLandmarks.js';

const args = process.argv.slice(2);
const previewArg = args.find((arg) => arg.startsWith('--preview='));
const previewDir = previewArg ? previewArg.slice('--preview='.length) : null;
const RAW = join(repoRoot, 'output', 'landmarks', 'prop.hourglassBelfry.a.raw');
const PROPS = join(repoRoot, 'claudeville', 'assets', 'sprites', 'props');

const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const luma = ([r, g, b]) => 0.299 * r + 0.587 * g + 0.114 * b;
const ASHLAR = ART_RAMPS.ashlar.slice(3).map(hex);
const STAGE_DARK = hex(ART_RAMPS.ashlar[1]);
const OUTLINE = hex(ART_RAMPS.ashlar[1]);
const PEAK = hex(EFFECT_COLORS.peak);
const SNOW = ART_RAMPS.snow.map(hex);
const GOLD = ART_RAMPS.trimGold.map(hex);
const DOME = ART_RAMPS.domeSlate.map(hex);
const CLOTH = ART_RAMPS.sand.map(hex);
const CORD = { shade: hex('#7d64b0'), body: hex('#b79ae6'), glint: hex('#dccff5') };
const INK_LUMA = 52;
// The open stage, where enclosed see-through texels are filled; its floor
// rows start at `floorY`.
const STAGE = { x0: 30, y0: 80, x1: 100, y1: 140, floorY: 130 };
const SILL = ART_RAMPS.ashlar.slice(1, 5).map(hex);
// What ran out piles to this share of the lower bulb when the glass is spent.
const PILE_FILL = 0.85;

// Per glass: a seed in each bulb (raw texels), its glass tones (base, shade
// edge, highlight streak) and its sand (shadow, body, light, glint). The
// shaded east arch takes its glass a stop down the snow ramp.
const GLASSES = [
    {
        account: 'claude',
        seeds: [[48, 101], [48, 125]],
        glass: { base: SNOW[3], shade: SNOW[1], light: SNOW[4] },
        sand: { shadow: GOLD[0], body: GOLD[1], light: GOLD[2], glint: GOLD[3] },
        cloth: { shadow: CLOTH[0], body: CLOTH[2], light: CLOTH[3] },
    },
    {
        account: 'codex',
        seeds: [[78, 103], [80, 124]],
        glass: { base: SNOW[2], shade: SNOW[0], light: SNOW[3] },
        sand: { shadow: DOME[3], body: DOME[4], light: DOME[5], glint: hex(ART_RAMPS.seaPath[5]) },
        cloth: { shadow: CLOTH[0], body: CLOTH[1], light: CLOTH[2] },
    },
];

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

function rgbAt(png, x, y) {
    const p = (y * png.width + x) * 4;
    return [png.data[p], png.data[p + 1], png.data[p + 2], png.data[p + 3]];
}

function setRgb(png, x, y, rgb) {
    const p = (y * png.width + x) * 4;
    png.data[p] = rgb[0];
    png.data[p + 1] = rgb[1];
    png.data[p + 2] = rgb[2];
    png.data[p + 3] = 255;
}

// 1. Transparent texels the canvas edge cannot reach, inside the stage.
function fillEnclosed(png) {
    const { width: w, height: h } = png;
    const outside = new Uint8Array(w * h);
    const stack = [];
    for (let x = 0; x < w; x++) stack.push([x, 0], [x, h - 1]);
    for (let y = 0; y < h; y++) stack.push([0, y], [w - 1, y]);
    while (stack.length) {
        const [x, y] = stack.pop();
        if (x < 0 || y < 0 || x >= w || y >= h || outside[y * w + x] || rgbAt(png, x, y)[3] > 0) continue;
        outside[y * w + x] = 1;
        stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
    }
    let filled = 0;
    for (let y = STAGE.y0; y <= STAGE.y1; y++) {
        for (let x = STAGE.x0; x <= STAGE.x1; x++) {
            const [r, g, b, a] = rgbAt(png, x, y);
            if (a === 0 && !outside[y * w + x]) {
                setRgb(png, x, y, STAGE_DARK);
                filled++;
            } else if (a > 0 && y >= STAGE.floorY) {
                const [hue, s] = hsl(r, g, b);
                if (hue >= 170 && hue <= 260 && s >= 0.25) setRgb(png, x, y, snap(SILL, [r, g, b]));
            }
        }
    }
    return filled;
}

// 2. A glass: its interior rows, neck and bulbs.
function measureGlass(png, spec) {
    const { width: w, height: h } = png;
    const wall = (x, y) => {
        const [r, g, b, a] = rgbAt(png, x, y);
        return a === 0 || luma([r, g, b]) < INK_LUMA;
    };
    const interior = new Set();
    const stack = spec.seeds.map((seed) => [...seed]);
    while (stack.length) {
        const [x, y] = stack.pop();
        if (x < 0 || y < 0 || x >= w || y >= h) continue;
        const key = y * w + x;
        if (interior.has(key) || wall(x, y)) continue;
        interior.add(key);
        if (interior.size > 600) throw new Error(`${spec.account}: the glass interior leaks past its outline`);
        stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
    }
    const rows = new Map();
    for (const key of interior) {
        const x = key % w;
        const y = (key - x) / w;
        const row = rows.get(y) || { x0: Infinity, x1: -Infinity, n: 0 };
        row.x0 = Math.min(row.x0, x);
        row.x1 = Math.max(row.x1, x);
        row.n++;
        rows.set(y, row);
    }
    const ys = [...rows.keys()].sort((a, b) => a - b);
    for (const y of ys) {
        const row = rows.get(y);
        if (row.n !== row.x1 - row.x0 + 1) throw new Error(`${spec.account}: interior row ${y} is not one span`);
    }
    const third = Math.floor(ys.length / 3);
    const neck = ys.slice(third, ys.length - third).filter((y) => rows.get(y).x1 - rows.get(y).x0 + 1 <= 3);
    if (!neck.length) throw new Error(`${spec.account}: no neck found`);
    const neckRow = rows.get(neck[0]);
    return {
        ...spec,
        rows,
        ys,
        neck,
        neckX: Math.round((neckRow.x0 + neckRow.x1) / 2),
        top: ys.filter((y) => y < neck[0]),
        bottom: ys.filter((y) => y > neck.at(-1)),
        x0: Math.min(...ys.map((y) => rows.get(y).x0)),
        x1: Math.max(...ys.map((y) => rows.get(y).x1)),
    };
}

// The highlight streak runs down the upper two thirds of each bulb, one texel
// in from the lit edge.
function streak(glass, x, y) {
    const row = glass.rows.get(y);
    if (x !== row.x0 + 1) return false;
    for (const bulb of [glass.top, glass.bottom]) {
        const i = bulb.indexOf(y);
        if (i >= 0) return i < Math.ceil(bulb.length * 2 / 3);
    }
    return false;
}

function emptyGlass(glass, x, y) {
    const row = glass.rows.get(y);
    if (x === row.x1) return glass.glass.shade;
    return streak(glass, x, y) ? glass.glass.light : glass.glass.base;
}

function sandTone(glass, x, y, surface) {
    const row = glass.rows.get(y);
    if (streak(glass, x, y)) return glass.sand.glint;
    if (x === row.x1) return glass.sand.shadow;
    if (surface || x === row.x0) return glass.sand.light;
    return glass.sand.body;
}

// One state's texels for a glass: Map(`x,y` base-local) -> rgb.
function glassState(glass, state) {
    const out = new Map();
    const put = (x, y, rgb) => out.set(`${x},${y}`, rgb);
    for (const y of glass.ys) {
        const row = glass.rows.get(y);
        for (let x = row.x0; x <= row.x1; x++) put(x, y, state === 'peak' ? PEAK : emptyGlass(glass, x, y));
    }
    if (state === 'peak') return out;
    if (state === 'unknown') return shroud(glass);
    const level = state === 'limit' ? 0 : Number(state.slice(1));
    // The sand left: whole rows up from the neck.
    const topRows = Math.round((level / BELFRY_LEVELS) * glass.top.length);
    for (let i = 0; i < topRows; i++) {
        const y = glass.top[glass.top.length - 1 - i];
        const row = glass.rows.get(y);
        for (let x = row.x0; x <= row.x1; x++) put(x, y, sandTone(glass, x, y, i === topRows - 1));
    }
    // What ran out: a mound on the floor of the lower bulb (a pinch while the
    // glass is still brimming), its crown the middle half of its row.
    const pileRows = level >= BELFRY_LEVELS ? 1 : Math.round(((BELFRY_LEVELS - level) / BELFRY_LEVELS) * glass.bottom.length * PILE_FILL);
    for (let i = 0; i < pileRows; i++) {
        const y = glass.bottom[glass.bottom.length - 1 - i];
        const row = glass.rows.get(y);
        const crown = i === pileRows - 1;
        const half = Math.max(1, Math.floor((row.x1 - row.x0 + 1) / 4));
        const from = crown ? Math.max(row.x0, glass.neckX - half) : row.x0;
        const to = crown ? Math.min(row.x1, glass.neckX + half) : row.x1;
        for (let x = from; x <= to; x++) put(x, y, sandTone(glass, x, y, crown));
    }
    // The stream: through the neck down to the mound while sand remains.
    if (level > 0) {
        const pileTop = glass.bottom[glass.bottom.length - pileRows] ?? glass.ys.at(-1) + 1;
        for (let y = glass.neck[0]; y < pileTop; y++) put(glass.neckX, y, glass.sand.light);
    }
    if (state === 'limit') cord(glass, put);
    return out;
}

// The lavender cord, two courses across the glass just above the neck, a
// knot on the neck and two tails over the lower bulb.
function cord(glass, put) {
    const y = glass.neck[0] - 1;
    for (let x = glass.x0 - 1; x <= glass.x1; x++) {
        put(x, y - 1, CORD.body);
        put(x, y, CORD.shade);
    }
    const cx = glass.neckX;
    for (let dx = -1; dx <= 1; dx++) {
        put(cx + dx, y - 1, dx === -1 ? CORD.glint : CORD.body);
        put(cx + dx, y, CORD.body);
        put(cx + dx, y + 1, CORD.shade);
    }
    for (let i = 0; i < 4; i++) {
        put(cx - 1 - Math.floor(i / 2), y + 2 + i, CORD.shade);
        put(cx + 1 + Math.floor(i / 2), y + 2 + i, CORD.shade);
    }
}

// The shroud: a canvas sack over the whole glass, gathered at the top plate
// and cinched at the neck, folds every third column.
function shroud(glass) {
    const out = new Map();
    const y0 = glass.ys[0] - 1;
    const y1 = glass.ys.at(-1) + 1;
    const cinch = glass.neck[1] ?? glass.neck[0];
    const spanAt = (y) => {
        const gather = Math.max(0, 3 - (y - y0));
        const pinch = Math.abs(y - cinch) <= 1 ? 2 : 0;
        return [glass.x0 - 1 + Math.max(gather, pinch), glass.x1 + 1 - Math.max(gather, pinch)];
    };
    for (let y = y0; y <= y1; y++) {
        const [from, to] = spanAt(y);
        for (let x = from; x <= to; x++) {
            const [upFrom, upTo] = y > y0 ? spanAt(y - 1) : [Infinity, -Infinity];
            const [downFrom, downTo] = y < y1 ? spanAt(y + 1) : [Infinity, -Infinity];
            const edge = x === from || x === to || y === y0 || y === y1
                || x < upFrom || x > upTo || x < downFrom || x > downTo;
            let rgb = glass.cloth.body;
            if (edge) rgb = OUTLINE;
            else if (y === cinch) rgb = glass.cloth.shadow;
            else if (x === from + 1) rgb = glass.cloth.light;
            else if ((x - glass.x0) % 3 === 2 || x === to - 1) rgb = glass.cloth.shadow;
            out.set(`${x},${y}`, rgb);
        }
    }
    return out;
}

function finish() {
    const png = PNG.sync.read(readFileSync(RAW));
    const filled = fillEnclosed(png);
    const glasses = GLASSES.map((spec) => measureGlass(png, spec));
    const interior = new Set();
    for (const glass of glasses) {
        for (const y of glass.ys) {
            const row = glass.rows.get(y);
            for (let x = row.x0; x <= row.x1; x++) {
                interior.add(`${x},${y}`);
                setRgb(png, x, y, emptyGlass(glass, x, y));
            }
        }
    }
    // 3. ashlar snap
    for (let y = 0; y < png.height; y++) {
        for (let x = 0; x < png.width; x++) {
            const [r, g, b, a] = rgbAt(png, x, y);
            if (a === 0 || interior.has(`${x},${y}`)) continue;
            const [hue, s, l] = hsl(r, g, b);
            if ((s < 0.18 && l > 0.38) || (s < 0.36 && l > 0.42 && hue >= 15 && hue <= 75)) setRgb(png, x, y, snap(ASHLAR, [r, g, b]));
        }
    }
    writeFileSync(join(PROPS, 'prop.hourglassBelfry.png'), PNG.sync.write(png));
    return { png, glasses, filled };
}

function bakeStrip(glasses) {
    const [fw, fh] = BELFRY_GLASS_FRAME;
    const strip = new PNG({ width: fw * BELFRY_GLASS_STATES.length * glasses.length, height: fh });
    glasses.forEach((glass, g) => {
        const [ox, oy] = BELFRY_GLASS_ORIGINS[glass.account];
        BELFRY_GLASS_STATES.forEach((state, s) => {
            const cell = (g * BELFRY_GLASS_STATES.length + s) * fw;
            for (const [key, rgb] of glassState(glass, state)) {
                const [x, y] = key.split(',').map(Number);
                const lx = x - ox;
                const ly = y - oy;
                if (lx < 0 || ly < 0 || lx >= fw || ly >= fh) throw new Error(`${glass.account} ${state}: texel ${x},${y} falls outside its cell`);
                setRgb(strip, cell + lx, ly, rgb);
            }
        });
    });
    writeFileSync(join(PROPS, 'prop.hourglassBelfryGlass.png'), PNG.sync.write(strip));
    return strip;
}

mkdirSync(PROPS, { recursive: true });
const { png, glasses, filled } = finish();
const strip = bakeStrip(glasses);
console.log(`prop.hourglassBelfry: ${png.width}x${png.height}, ${filled} stage texels filled`);
for (const glass of glasses) {
    console.log(`  ${glass.account}: rows ${glass.ys[0]}-${glass.ys.at(-1)}, neck ${glass.neck.join('/')} at x ${glass.neckX}, bulbs ${glass.top.length}+${glass.bottom.length} rows, x ${glass.x0}-${glass.x1}`);
}
console.log(`prop.hourglassBelfryGlass: ${strip.width}x${strip.height} (${BELFRY_GLASS_STATES.length} states x ${glasses.length} glasses)`);
if (previewDir) {
    mkdirSync(previewDir, { recursive: true });
    writeFileSync(join(previewDir, 'prop.hourglassBelfry.png'), PNG.sync.write(png));
    writeFileSync(join(previewDir, 'prop.hourglassBelfryGlass.png'), PNG.sync.write(strip));
}
