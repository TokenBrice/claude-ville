#!/usr/bin/env node
// B3-06 — slate tile courses on the Command's flat wing roofs (no generation).
//
// The Command's wing, porch and back roofs were painted as flat slate planes,
// while every other landmark roof carries tile courses. This paints courses
// onto them in the family's own grammar (the Tavern's: stepped 2:1 joint lines
// one course apart, short staggered vertical joints between slates):
//
// - Where: the 2.3 surface channel's roof face (occluder B >> 6 == 3) on the
//   two flat body colours, minus the gilt dome (D1) and the flag-tower spire,
//   and only on interior texels (all four neighbours the same body colour),
//   so ridges, hips, verges and eaves keep their authored lines.
// - Orientation per pitch: the shaded pitch (body roofSlate stop 3, facing
//   the lower right) runs its courses parallel to an eave rising to the
//   right; the lit pitch (stop 6, facing the lower left) parallel to an eave
//   falling to the right.
// - Courses every `COURSE` rows, slates `SLATE` texels wide, alternate courses
//   staggered half a slate. Joints sit two roofSlate stops under the body;
//   each slate's upper-left texel under the joint takes one stop up (the
//   upper-left key catching its lip).
//
// Every art layer that restates base pixels (the restIsBase banners and gate)
// takes the same change wherever it still shows the base's original texel,
// so frame 0 stays equal to the base crop.
//
// The roof weather (RoofWeather.js) reads face 3 plus slate albedo, and the
// joints stay one texel thick on roofSlate, so snow fills the courses and wet
// slate edges the roof as before. `harmonize-roofs.mjs --check` still holds.
//
// Usage:
//   node scripts/sprites/paint-roof-courses.mjs           # write
//   node scripts/sprites/paint-roof-courses.mjs --check   # fail if a re-run would change a byte
// Idempotent: painted texels are no longer interior body texels.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { ART_RAMPS } from '../../claudeville/src/config/artPalette.js';
import { loadSpriteManifest, spritesRoot } from './manifest-utils.mjs';

const ID = 'building.command';
const COURSE = 5;
const SLATE = 8;
const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const ROOF = ART_RAMPS.roofSlate.map(hex);
// body stop -> [joint stop, lip stop, eave direction (+1 rises to the right)]
const PITCHES = [
    { body: 3, joint: 1, lip: 4, rise: 1 },
    { body: 6, joint: 4, lip: 7, rise: -1 },
];
const insideDome = (x, y) => ((x - 175) / 52) ** 2 + ((y - 58) / 37) ** 2 <= 1;
const insideSpire = (x, y) => x >= 55 && x < 105 && y < 70;

const same = (data, i, rgb) => data[i] === rgb[0] && data[i + 1] === rgb[1] && data[i + 2] === rgb[2] && data[i + 3] === 255;

// Returns Map<pixel index, [r, g, b]> of the base texels to repaint.
export function courseEdits(base, occ) {
    const { width: W, height: H } = base;
    const edits = new Map();
    for (const pitch of PITCHES) {
        const body = ROOF[pitch.body];
        const isBody = (x, y) => {
            if (x < 0 || y < 0 || x >= W || y >= H) return false;
            const i = (y * W + x) * 4;
            return same(base.data, i, body) && occ.data[i + 3] > 0 && occ.data[i + 2] >> 6 === 3;
        };
        for (let y = 0; y < H; y++) {
            for (let x = 0; x < W; x++) {
                if (insideDome(x, y) || insideSpire(x, y)) continue;
                if (!isBody(x, y) || !isBody(x - 1, y) || !isBody(x + 1, y) || !isBody(x, y - 1) || !isBody(x, y + 1)) continue;
                // Distance along the slope normal: a 2:1 stepped line per course.
                const s = y + pitch.rise * Math.floor(x / 2) + 4096;
                const row = s % COURSE;
                const course = Math.floor(s / COURSE);
                const col = (x + (course % 2) * (SLATE / 2)) % SLATE;
                let stop = null;
                if (row === 0 || col === 0) stop = pitch.joint;
                else if (row === 1 && col === 1) stop = pitch.lip;
                if (stop !== null) edits.set(y * W + x, ROOF[stop]);
            }
        }
    }
    return edits;
}

function layerFrames(entry, layer) {
    if (layer.cycle) return null;
    const frameW = layer.frameW ?? layer.width;
    const frameH = layer.frameH ?? layer.height;
    const frames = layer.frames ?? 1;
    const full = frameW === entry.width && frameH === entry.height;
    const [ax, ay] = layer.anchor ?? entry.anchor;
    return { frameW, frameH, frames, x0: full ? 0 : ax - Math.floor(frameW / 2), y0: full ? 0 : ay - frameH };
}

function main() {
    const check = process.argv.includes('--check');
    const dir = join(spritesRoot, 'buildings', ID);
    const entry = (loadSpriteManifest().buildings || []).find((item) => item.id === ID);
    const basePath = join(dir, 'base.png');
    const base = PNG.sync.read(readFileSync(basePath));
    const occ = PNG.sync.read(readFileSync(join(dir, 'base.occluder.png')));
    const original = Buffer.from(base.data);
    const edits = courseEdits(base, occ);
    for (const [p, rgb] of edits) base.data.set(rgb, p * 4);

    const outputs = [{ path: basePath, png: base, changed: edits.size }];
    for (const [name, layer] of Object.entries(entry?.layers || {})) {
        const f = layerFrames(entry, layer);
        const path = join(dir, `${name}.png`);
        if (!f || !existsSync(path)) continue;
        const png = PNG.sync.read(readFileSync(path));
        let changed = 0;
        for (let k = 0; k < f.frames; k++) {
            for (let y = 0; y < f.frameH; y++) {
                for (let x = 0; x < f.frameW; x++) {
                    const bx = f.x0 + x;
                    const by = f.y0 + y;
                    if (bx < 0 || by < 0 || bx >= base.width || by >= base.height) continue;
                    const rgb = edits.get(by * base.width + bx);
                    if (!rgb) continue;
                    const i = (y * png.width + k * f.frameW + x) * 4;
                    const b = (by * base.width + bx) * 4;
                    if (png.data[i + 3] !== 255 || !same(png.data, i, [original[b], original[b + 1], original[b + 2]])) continue;
                    png.data.set(rgb, i);
                    changed++;
                }
            }
        }
        if (changed) outputs.push({ path, png, changed });
    }

    if (check) {
        const stale = outputs.filter((out) => out.changed > 0);
        for (const out of stale) console.error(`[roof-courses] STALE ${out.path}: ${out.changed} texel(s) would change`);
        console.log(stale.length ? `[roof-courses] ${stale.length} file(s) stale` : '[roof-courses] Command roof courses current');
        process.exit(stale.length ? 1 : 0);
    }
    for (const out of outputs) {
        if (!out.changed) continue;
        writeFileSync(out.path, PNG.sync.write(out.png));
        console.log(`[roof-courses] ${out.path}: ${out.changed} texel(s)`);
    }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
