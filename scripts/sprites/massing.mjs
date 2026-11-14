#!/usr/bin/env node
// SD-1 (the Sundial) — landmark massing: preview and validator.
//
// `claudeville/src/config/landmarkMassing.js` stands a few solids for each
// landmark (the shade field sweeps them along the sun). This tool projects
// them into the landmark's `base.png` the way the engine draws it (the sprite
// anchor sits on the footprint centre; a point `z` px high draws `z` px up)
// and compares their silhouette with the sprite's alpha, so a badly fitted
// mass is caught by a check, not by eye:
//
//   cover      share of the sprite's opaque texels inside the solids
//   overhang   share of the solids' silhouette outside the sprite
//   skyline    per column, |top of the solids - top of the sprite| (mean and
//              90th percentile, px): the heights, which set shadow length
//   base       per column, |bottom of the solids - bottom of the sprite|
//              (75th percentile, px): where the masses meet the ground. A
//              percentile, because a roof solid is the column under its roof
//              and so stands on the ground under an overhanging eave.
//   spill      how far (px) any solid reaches past the sprite's canvas, where
//              the numbers above cannot see it (a box drifted off the edge)
//
// A landmark marked `fitted: true` must pass MASSING_LIMITS (calibrated on the
// two reference fits, Command and Tavern, with room to spare; a coarse box
// fails every one of them). An entry may loosen a limit for itself with
// `limits: { cover: 0.85 }` and a comment saying what its solids leave out
// on purpose (a mast, a crane arm, an open arch).
//
// Usage:
//   node scripts/sprites/massing.mjs                    print every landmark's numbers
//   node scripts/sprites/massing.mjs --check            exit 1 if a fitted landmark fails
//   node scripts/sprites/massing.mjs --preview <dir>    write <dir>/<type>.massing.png (3x)
//   node scripts/sprites/massing.mjs --ids=command,tavern
//   node scripts/sprites/massing.mjs --ids=tavern --rows=0,295,0,100,4
//                                    per row of the window x0,x1,y0,y1[,step]:
//                                    the art's and the solids' opaque runs
//
// The preview is two panels: the sprite under the solids' wireframe (plan
// edges dark, top edges bright, one colour per solid), and the difference map
// (sprite texels the solids miss in blue, solid texels outside the sprite in
// red, agreement in grey).

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { BUILDING_DEFS } from '../../claudeville/src/config/buildings.js';
import { LANDMARK_MASSING, PROP_MASSING } from '../../claudeville/src/config/landmarkMassing.js';
import { convexHull, solidFacets } from '../../claudeville/src/presentation/character-mode/ShadeField.js';
import { tileToWorld } from '../../claudeville/src/presentation/character-mode/Projection.js';
import { collectSpriteEntries, loadSpriteManifest, spritesRoot } from './manifest-utils.mjs';

export const MASSING_LIMITS = Object.freeze({
    cover: 0.92,
    overhang: 0.1,
    skylineMean: 4,
    skylineP90: 10,
    baseP75: 6,
    spill: 4,
});

const ALPHA_MIN = 128;
const SOLID_COLOURS = [
    [255, 96, 96], [96, 200, 255], [255, 208, 80], [140, 255, 140], [255, 140, 240],
    [255, 160, 64], [120, 160, 255], [200, 255, 96], [255, 255, 255], [160, 255, 230],
];

function fillConvex(mask, width, height, polygon) {
    if (polygon.length < 3) return;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const [, y] of polygon) {
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
    }
    for (let row = Math.max(0, Math.floor(minY)); row <= Math.min(height - 1, Math.ceil(maxY)); row++) {
        const y = row + 0.5;
        let x0 = Infinity;
        let x1 = -Infinity;
        for (let i = 0; i < polygon.length; i++) {
            const a = polygon[i];
            const b = polygon[(i + 1) % polygon.length];
            if ((a[1] <= y) === (b[1] <= y)) continue;
            const x = a[0] + (y - a[1]) * (b[0] - a[0]) / (b[1] - a[1]);
            x0 = Math.min(x0, x);
            x1 = Math.max(x1, x);
        }
        if (x1 < x0) continue;
        for (let col = Math.max(0, Math.round(x0)); col < Math.min(width, Math.round(x1)); col++) mask[row * width + col] = 1;
    }
}

function quantile(values, share) {
    if (!values.length) return 0;
    const sorted = values.slice().sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * share))];
}

// A landmark's entry by its type, or a standing prop's by its sprite id.
const massingOf = type => PROP_MASSING[type] || LANDMARK_MASSING[type];

/**
 * A landmark's (or prop's) solids as sprite-px columns: per facet its top and
 * plan corners. A prop's plan is in tiles from its foot, the sprite anchor.
 */
export function projectMassing(type, entry) {
    const def = PROP_MASSING[type] ? { width: 0, height: 0 } : BUILDING_DEFS.find(row => row.type === type);
    const massing = massingOf(type);
    if (!def || !massing) return [];
    const [ax, ay] = entry.anchor;
    const toWorld = (tx, ty) => {
        const local = tileToWorld(tx - def.width / 2, ty - def.height / 2);
        return [ax + local.x, ay + local.y];
    };
    return (massing.solids || []).map((solid, index) => ({
        solid,
        index,
        columns: solidFacets(solid, toWorld).map((f) => {
            const top = [];
            const plan = [];
            for (let i = 0; i < f.n; i++) {
                top.push([f.x[i], f.y[i] - f.z[i]]);
                // A raised solid (`base`) draws from its underside up.
                plan.push([f.x[i], f.y[i] - f.base]);
            }
            return { top, plan };
        }),
    }));
}

/** The validator's numbers for one landmark against its `base.png`. */
export function massingReport(type, { manifest = loadSpriteManifest() } = {}) {
    const prop = Boolean(PROP_MASSING[type]);
    const id = prop ? type : `building.${type}`;
    const entry = collectSpriteEntries(manifest).find(row => row.id === id);
    if (!entry) throw new Error(`manifest has no ${id}`);
    const sprite = PNG.sync.read(readFileSync(prop
        ? join(spritesRoot, 'props', `${type}.png`)
        : join(spritesRoot, 'buildings', id, 'base.png')));
    const { width, height } = sprite;
    const art = new Uint8Array(width * height);
    for (let i = 0; i < art.length; i++) art[i] = sprite.data[i * 4 + 3] >= ALPHA_MIN ? 1 : 0;
    const solids = projectMassing(type, entry);
    const mass = new Uint8Array(width * height);
    // How far (px) any solid reaches past the sprite's own canvas, where the
    // silhouette numbers cannot see it.
    let spill = 0;
    for (const { columns } of solids) {
        for (const column of columns) {
            fillConvex(mass, width, height, convexHull([...column.top, ...column.plan]));
            for (const [x, y] of [...column.top, ...column.plan]) spill = Math.max(spill, -x, x - width, -y, y - height);
        }
    }
    let artCount = 0;
    let massCount = 0;
    let both = 0;
    for (let i = 0; i < art.length; i++) {
        artCount += art[i];
        massCount += mass[i];
        both += art[i] & mass[i];
    }
    const skyline = [];
    const base = [];
    for (let col = 0; col < width; col++) {
        let artTop = -1;
        let artBottom = -1;
        let massTop = -1;
        let massBottom = -1;
        for (let row = 0; row < height; row++) {
            if (art[row * width + col]) {
                if (artTop < 0) artTop = row;
                artBottom = row;
            }
            if (mass[row * width + col]) {
                if (massTop < 0) massTop = row;
                massBottom = row;
            }
        }
        if (artTop < 0 || massTop < 0) continue;
        skyline.push(Math.abs(artTop - massTop));
        base.push(Math.abs(artBottom - massBottom));
    }
    const mean = values => (values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0);
    const numbers = {
        cover: artCount ? both / artCount : 0,
        overhang: massCount ? (massCount - both) / massCount : 0,
        skylineMean: mean(skyline),
        skylineP90: quantile(skyline, 0.9),
        baseP75: quantile(base, 0.75),
        spill,
    };
    const limits = { ...MASSING_LIMITS, ...massingOf(type)?.limits };
    const failures = [];
    if (!solids.length) failures.push('no solids');
    if (numbers.cover < limits.cover) failures.push(`cover ${numbers.cover.toFixed(3)} < ${limits.cover}`);
    for (const name of ['overhang', 'skylineMean', 'skylineP90', 'baseP75', 'spill']) {
        if (numbers[name] > limits[name]) failures.push(`${name} ${numbers[name].toFixed(2)} > ${limits[name]}`);
    }
    return {
        type,
        fitted: massingOf(type)?.fitted === true,
        solids: solids.length,
        numbers,
        failures,
        pass: failures.length === 0,
        sprite,
        art,
        mass,
        projected: solids,
    };
}

function previewPng(report, scale = 3) {
    const { sprite, art, mass, projected } = report;
    const { width, height } = sprite;
    const out = new PNG({ width: width * scale * 2, height: height * scale, colorType: 6 });
    const put = (x, y, rgb, alpha = 255) => {
        if (x < 0 || y < 0 || x >= out.width || y >= out.height) return;
        const o = (y * out.width + x) * 4;
        out.data[o] = rgb[0];
        out.data[o + 1] = rgb[1];
        out.data[o + 2] = rgb[2];
        out.data[o + 3] = alpha;
    };
    for (let y = 0; y < height * scale; y++) {
        for (let x = 0; x < width * scale; x++) {
            const sx = Math.floor(x / scale);
            const sy = Math.floor(y / scale);
            const i = sy * width + sx;
            const s = i * 4;
            const backdrop = ((sx >> 3) + (sy >> 3)) & 1 ? 30 : 40;
            const a = sprite.data[s + 3] / 255;
            const rgb = [0, 1, 2].map(c => Math.round(sprite.data[s + c] * a + backdrop * (1 - a)));
            put(x, y, rgb);
            // Panel 2: agreement grey, art the solids miss blue, solids past the art red.
            const diff = art[i] && mass[i] ? rgb.map(c => Math.round(c * 0.5 + 60))
                : art[i] ? [50, 110, 255]
                    : mass[i] ? [255, 60, 60] : [backdrop, backdrop, backdrop];
            put(width * scale + x, y, diff);
        }
    }
    const line = (a, b, rgb) => {
        let x0 = Math.round(a[0] * scale);
        let y0 = Math.round(a[1] * scale);
        const x1 = Math.round(b[0] * scale);
        const y1 = Math.round(b[1] * scale);
        const dx = Math.abs(x1 - x0);
        const dy = -Math.abs(y1 - y0);
        const stepX = x0 < x1 ? 1 : -1;
        const stepY = y0 < y1 ? 1 : -1;
        let error = dx + dy;
        for (;;) {
            if (x0 >= 0 && x0 < width * scale) put(x0, y0, rgb);
            if (x0 === x1 && y0 === y1) break;
            const twice = 2 * error;
            if (twice >= dy) { error += dy; x0 += stepX; }
            if (twice <= dx) { error += dx; y0 += stepY; }
        }
    };
    for (const { index, columns } of projected) {
        const bright = SOLID_COLOURS[index % SOLID_COLOURS.length];
        const dark = bright.map(c => Math.round(c * 0.45));
        for (const { top, plan } of columns) {
            for (let i = 0; i < plan.length; i++) line(plan[i], plan[(i + 1) % plan.length], dark);
            for (let i = 0; i < top.length; i++) line(top[i], plan[i], dark);
            for (let i = 0; i < top.length; i++) line(top[i], top[(i + 1) % top.length], bright);
        }
    }
    return PNG.sync.write(out);
}

// The measuring tape: per sprite row of a window, the opaque runs of the art
// and of the solids (sprite px, inclusive), to read a ridge end, an eave
// corner or a tower's width off the art instead of guessing it.
function printRows(report, x0 = 0, x1 = report.sprite.width - 1, y0 = 0, y1 = report.sprite.height - 1, step = 2) {
    const { width } = report.sprite;
    const runs = (mask, row) => {
        const out = [];
        let start = -1;
        for (let col = x0; col <= x1 + 1; col++) {
            const on = col <= x1 && mask[row * width + col];
            if (on && start < 0) start = col;
            if (!on && start >= 0) {
                out.push(`${start}-${col - 1}`);
                start = -1;
            }
        }
        return out.join(' ') || '.';
    };
    for (let row = y0; row <= y1; row += step) {
        console.log(`${String(row).padStart(4)}  art ${runs(report.art, row).padEnd(30)} solids ${runs(report.mass, row)}`);
    }
}

function main() {
    const args = process.argv.slice(2);
    const check = args.includes('--check');
    const previewAt = args.indexOf('--preview');
    const previewDir = previewAt >= 0 ? args[previewAt + 1] : null;
    const idsArg = args.find(arg => arg.startsWith('--ids='));
    const only = idsArg ? new Set(idsArg.slice('--ids='.length).split(',').filter(Boolean)) : null;
    const rowsArg = args.find(arg => arg.startsWith('--rows='));
    const rows = rowsArg ? rowsArg.slice('--rows='.length).split(',').map(Number) : null;
    const manifest = loadSpriteManifest();
    if (previewDir) mkdirSync(previewDir, { recursive: true });
    let failed = 0;
    for (const def of [...BUILDING_DEFS, ...Object.keys(PROP_MASSING).map(type => ({ type }))]) {
        if (only && !only.has(def.type)) continue;
        if (!massingOf(def.type)) {
            console.log(`[massing] ${def.type}: no entry`);
            continue;
        }
        const report = massingReport(def.type, { manifest });
        const n = report.numbers;
        const line = `cover ${n.cover.toFixed(3)}  overhang ${n.overhang.toFixed(3)}  skyline ${n.skylineMean.toFixed(1)} / p90 ${n.skylineP90}  base p75 ${n.baseP75}  spill ${n.spill.toFixed(1)}`;
        const state = report.fitted ? (report.pass ? 'fitted, ok' : `fitted, FAILS: ${report.failures.join('; ')}`) : `not fitted (${report.solids} solid${report.solids === 1 ? '' : 's'})`;
        console.log(`[massing] ${def.type.padEnd(10)} ${line}  ${state}`);
        if (report.fitted && !report.pass) failed++;
        if (previewDir) {
            const path = join(previewDir, `${def.type}.massing.png`);
            writeFileSync(path, previewPng(report));
            console.log(`[massing] wrote ${path}`);
        }
        if (rows) printRows(report, ...rows);
    }
    if (check) {
        console.log(failed ? `[massing] ${failed} fitted landmark(s) fail` : '[massing] every fitted landmark passes');
        process.exit(failed ? 1 : 0);
    }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
