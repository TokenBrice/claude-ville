#!/usr/bin/env node
// Deterministic value lift for a character whose garments sink into the
// grass (model sprites pass 2: the DeepSeek Flash rungs, mean luminance ~40).
// Every opaque pixel whose HLS hue lies in the green-to-teal band [95°, 185°]
// and whose lightness is above the outline floor (L > 0.055) is remapped
//   L' = min(0.85, 0.055 + (L − 0.055) · k)    S' = min(1, S · 1.25)
// with hue and alpha kept. Outlines, skin, leather browns and metals are out
// of band and stay byte-identical. HLS and rounding follow Python's colorsys
// and round() (half to even), so the result matches the reviewed prototype.
//
// Run it once per sheet, after every strip is assembled (generation routes
// snap to the unlifted palette). Re-running lifts again: it is not idempotent.
// Re-sample `paletteSource` and the emissive PROFILES colours afterwards.
//
// Usage:
//   node scripts/sprites/value-lift.mjs --id=agent.deepseek.flash [--k=1.6] [--dry-run]
//       lifts characters/<id>/sheet.png and actions.png in place, saving the
//       unlifted copies to output/value-lift/<id>/ first
//   … --check   compares the shipped PNGs with the lift of those saved
//               unlifted copies (exit 1 on any difference)
//   node scripts/sprites/value-lift.mjs --in=<stage.png> --out=<lifted.png> [--k=1.6]
//       lifts one staged strip (e.g. PixMiniMax frames, which animate the
//       unlifted PixelLab rig) before assembly onto an already-lifted sheet.
//       Skeleton stages snap to the lifted sheet and must not be lifted again.

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { repoRoot, spritesRoot } from './manifest-utils.mjs';

const HUE_MIN = 95;
const HUE_MAX = 185;
const L_FLOOR = 0.055;
const L_CAP = 0.85;
const S_GAIN = 1.25;

const args = process.argv.slice(2);
const option = (name, fallback = null) => {
    const hit = args.find((arg) => arg.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : fallback;
};
const flag = (name) => args.includes(`--${name}`);
const fail = (message) => { console.error(`[value-lift] ${message}`); process.exit(1); };

const k = Number(option('k', '1.6'));
if (!Number.isFinite(k) || k <= 0) fail(`bad --k ${option('k')}`);
const inPath = option('in');
const outPath = option('out');
const id = option('id');
if (!inPath && (!id || !id.startsWith('agent.'))) fail('usage: --id=<agent sprite id> [--k=1.6] [--dry-run | --check] | --in=<png> --out=<png>');
if (inPath && !outPath) fail('--in needs --out');
const files = inPath ? [] : ['sheet.png', 'actions.png'].filter((name) => existsSync(join(spritesRoot, 'characters', id, name)));
if (!inPath && !files.length) fail(`${id} has no sheet.png or actions.png`);
const backupDir = inPath ? null : join(repoRoot, 'output', 'value-lift', id);

// Python round(): half to even.
function pyRound(x) {
    const floor = Math.floor(x);
    const diff = x - floor;
    if (diff > 0.5) return floor + 1;
    if (diff < 0.5) return floor;
    return floor % 2 === 0 ? floor : floor + 1;
}

// colorsys.rgb_to_hls / hls_to_rgb, channel values 0..1.
function rgbToHls(r, g, b) {
    const maxc = Math.max(r, g, b);
    const minc = Math.min(r, g, b);
    const sumc = maxc + minc;
    const rangec = maxc - minc;
    const l = sumc / 2;
    if (minc === maxc) return [0, l, 0];
    const s = l <= 0.5 ? rangec / sumc : rangec / (2 - maxc - minc);
    const rc = (maxc - r) / rangec;
    const gc = (maxc - g) / rangec;
    const bc = (maxc - b) / rangec;
    let h;
    if (r === maxc) h = bc - gc;
    else if (g === maxc) h = 2 + rc - bc;
    else h = 4 + gc - rc;
    h = ((h / 6) % 1 + 1) % 1;
    return [h, l, s];
}

function hueChannel(m1, m2, hue) {
    hue = ((hue % 1) + 1) % 1;
    if (hue < 1 / 6) return m1 + (m2 - m1) * hue * 6;
    if (hue < 0.5) return m2;
    if (hue < 2 / 3) return m1 + (m2 - m1) * (2 / 3 - hue) * 6;
    return m1;
}

function hlsToRgb(h, l, s) {
    if (s === 0) return [l, l, l];
    const m2 = l <= 0.5 ? l * (1 + s) : l + s - l * s;
    const m1 = 2 * l - m2;
    return [hueChannel(m1, m2, h + 1 / 3), hueChannel(m1, m2, h), hueChannel(m1, m2, h - 1 / 3)];
}

function liftColor(r, g, b) {
    const [h, l, s] = rgbToHls(r / 255, g / 255, b / 255);
    const degrees = h * 360;
    if (l < L_FLOOR || degrees < HUE_MIN || degrees > HUE_MAX) return null;
    const lifted = hlsToRgb(h, Math.min(L_CAP, L_FLOOR + (l - L_FLOOR) * k), Math.min(1, s * S_GAIN));
    return lifted.map((channel) => pyRound(channel * 255));
}

function lift(png) {
    const cache = new Map();
    const colors = new Set();
    let pixels = 0;
    for (let i = 0; i < png.data.length; i += 4) {
        if (png.data[i + 3] === 0) continue;
        const key = (png.data[i] << 16) | (png.data[i + 1] << 8) | png.data[i + 2];
        if (!cache.has(key)) cache.set(key, liftColor(png.data[i], png.data[i + 1], png.data[i + 2]));
        const next = cache.get(key);
        if (!next || (next[0] === png.data[i] && next[1] === png.data[i + 1] && next[2] === png.data[i + 2])) continue;
        png.data[i] = next[0];
        png.data[i + 1] = next[1];
        png.data[i + 2] = next[2];
        colors.add(key);
        pixels += 1;
    }
    return { colors: colors.size, pixels };
}

if (inPath) {
    const png = PNG.sync.read(readFileSync(inPath));
    const { colors, pixels } = lift(png);
    writeFileSync(outPath, PNG.sync.write(png));
    console.log(`[value-lift] ${inPath} -> ${outPath}: ${colors} colours, ${pixels} px lifted (k=${k})`);
    process.exit(0);
}

let mismatches = 0;
for (const name of files) {
    const target = join(spritesRoot, 'characters', id, name);
    const backup = join(backupDir, name);
    if (flag('check')) {
        if (!existsSync(backup)) fail(`${backup} is missing: nothing to check against`);
        const expected = PNG.sync.read(readFileSync(backup));
        lift(expected);
        const actual = PNG.sync.read(readFileSync(target));
        const same = expected.width === actual.width && expected.height === actual.height && expected.data.equals(actual.data);
        console.log(`[value-lift] ${id}/${name}: ${same ? 'matches' : 'DIFFERS from'} the k=${k} lift of ${backup.slice(repoRoot.length)}`);
        if (!same) mismatches += 1;
        continue;
    }
    const png = PNG.sync.read(readFileSync(target));
    const { colors, pixels } = lift(png);
    console.log(`[value-lift] ${id}/${name}: ${colors} colours, ${pixels} px ${flag('dry-run') ? 'would change' : 'lifted'} (k=${k})`);
    if (flag('dry-run')) continue;
    if (existsSync(backup)) fail(`${backup} exists: ${id} looks lifted already (the lift is not idempotent)`);
    mkdirSync(backupDir, { recursive: true });
    copyFileSync(target, backup);
    writeFileSync(target, PNG.sync.write(png));
}
if (mismatches) process.exit(1);
