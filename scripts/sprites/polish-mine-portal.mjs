#!/usr/bin/env node
// W1-D 1.11 — craft polish for the Mine and the Portal, hand-pixel post-
// processing over their shipped `base.png` (and the Portal's
// `base.emissive.png`). Deterministic and idempotent: every rule selects its
// texels from data the polish never changes (alpha, the material and surface
// sidecars, the Portal's vortex mask `slumber.png`, geometry and seeded
// hashes), or from a colour test its own output fails, and it only ever sets
// a fixed palette stop. So a second run writes nothing, and `--check` fails
// only when a run would change a texel.
//
// Never touched: transparency (silhouette and anchor stay), ink and the
// deepest shadow (HSV value < 0.13, which the surface bake and the outline
// pass read), any texel 4-adjacent to a transparent one, the crystals and
// the vortex themselves, and the sheave / portalGlow / runes / slumber parts.
//
// Mine (`building.mine/base.png`):
//   - granite striations: 1-px broken bedding lines across the lit rock
//     faces, on ART_RAMPS.stone (stone[3] on the palest rock, stone[2] on mid
//     rock), each line on its own seeded slope offset;
//   - crystal sockets: the rock texels under each crystal (2 rows) go to the
//     dark socket #1b242e;
//   - aqua bounce: the lit lip stone 2 px under a cyan crystal's socket takes
//     the muted bounce #4f7b82 (never Tier A).
// Portal (`building.portal/base.png`, `base.emissive.png`):
//   - distressed dais: worn flags (the lightest stop a step down in seeded
//     cells), hairline cracks (ashlar[3]);
//   - an inlaid dark-slate rune ring on the dais top round the arch
//     (ART_RAMPS.slate[0] inlay with slate[2] rune ticks), under the arch,
//     towers and braziers (it lies on the dais flags only);
//   - chipped step corners: the outer end of seeded tread nosings a stop or
//     two down;
//   - violet bounce in `base.emissive.png`: the jamb and threshold stone
//     within 2 px of the vortex, #9b6bff at alpha <= 80 (night only: the
//     Portal's emissive gate, `work.portal`).
//
// Re-run after: bake-portal-slumber --check, bake-surface-channel --check,
// bake-room-masks --check, outline-landmarks --check, harmonize-roofs --check.
//
// Usage:
//   node scripts/sprites/polish-mine-portal.mjs            write
//   node scripts/sprites/polish-mine-portal.mjs --check    exit 1 if a run would change a texel

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { ART_RAMPS } from '../../claudeville/src/config/artPalette.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../..');
const BUILDINGS = join(repoRoot, 'claudeville/assets/sprites/buildings');
const check = process.argv.includes('--check');

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const STONE = ART_RAMPS.stone.map(hex);
const ASHLAR = ART_RAMPS.ashlar.map(hex);
const SLATE = ART_RAMPS.slate.map(hex);
const SOCKET = hex('#1b242e');
const AQUA_BOUNCE = hex('#4f7b82');
const VIOLET_BOUNCE = hex('#9b6bff');
const INK_VALUE = 0.13;

// Material sidecar classes (R channel) the polish reads.
const MAT_STONE = 1;
const MAT_RUNE = 9;

function hash(a, b = 0, c = 0) {
    let h = Math.imul(a | 0, 374761393) ^ Math.imul(b | 0, 668265263) ^ Math.imul(c | 0, 1274126177);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const read = (path) => PNG.sync.read(readFileSync(path));

// Rec. 709 luma (0..1) and HSV value of an RGB triple.
const luma = ([r, g, b]) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
const value = ([r, g, b]) => Math.max(r, g, b) / 255;

class Sprite {
    constructor(png) {
        this.png = png;
        this.w = png.width;
        this.h = png.height;
    }
    i(x, y) { return (y * this.w + x) * 4; }
    inside(x, y) { return x >= 0 && y >= 0 && x < this.w && y < this.h; }
    alpha(x, y) { return this.inside(x, y) ? this.png.data[this.i(x, y) + 3] : 0; }
    rgb(x, y) { const i = this.i(x, y); return [this.png.data[i], this.png.data[i + 1], this.png.data[i + 2]]; }
    set(x, y, [r, g, b], a = 255) {
        const i = this.i(x, y);
        this.png.data[i] = r;
        this.png.data[i + 1] = g;
        this.png.data[i + 2] = b;
        this.png.data[i + 3] = a;
    }
    // Opaque, off the silhouette edge, and no ink: a texel the polish may recolour.
    paintable(x, y) {
        if (this.alpha(x, y) !== 255) return false;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) if (this.alpha(x + dx, y + dy) === 0) return false;
        return value(this.rgb(x, y)) >= INK_VALUE;
    }
}

function clone(png) {
    const out = new PNG({ width: png.width, height: png.height, colorType: 6 });
    png.data.copy(out.data);
    return out;
}

function samePixels(a, b) {
    return a.width === b.width && a.height === b.height && Buffer.compare(a.data, b.data) === 0;
}

// ─── the Mine ────────────────────────────────────────────────────────────────

// The sheave strip's frame rect on the base (paint-facade-materials
// FACADE_REGIONS.mine.strips: `restIsBase`, its rest frame restates the
// base): [left, top, width, height]. Never polished.
const MINE_SHEAVE_RECT = Object.freeze([76, 34, 22, 32]);

function polishMine() {
    const dir = join(BUILDINGS, 'building.mine');
    const source = read(join(dir, 'base.png'));
    const material = read(join(dir, 'base.material.png'));
    const emissive = read(join(dir, 'base.emissive.png'));
    const snap = new Sprite(source);
    const base = new Sprite(clone(source));
    const { w, h } = base;
    const matAt = (x, y) => material.data[(y * w + x) * 4];
    // The crystals: lit glass-rune texels, plus every crystal-coloured texel
    // (mint, cyan or amber; the material sidecar marks some inner facets as
    // stone), so no facet ever reads as rock.
    const lit = new Uint8Array(w * h);
    const cyanLit = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const i = (y * w + x) * 4;
            if (!emissive.data[i + 3] || matAt(x, y) !== MAT_RUNE) continue;
            lit[y * w + x] = 1;
            const [r, g, b] = [emissive.data[i], emissive.data[i + 1], emissive.data[i + 2]];
            if (b > r + 20 && g > r + 20) cyanLit[y * w + x] = 1;
        }
    }
    // A crystal-coloured texel counts only beside a lit one (a pale rock
    // highlight far from any crystal stays rock).
    const nearLit = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        if (!lit[y * w + x]) continue;
        for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
            const qx = x + dx;
            const qy = y + dy;
            if (qx >= 0 && qy >= 0 && qx < w && qy < h) nearLit[qy * w + qx] = 1;
        }
    }
    const crystalAt = (x, y) => base.inside(x, y)
        && (lit[y * w + x] === 1 || (nearLit[y * w + x] === 1 && crystalColour(snap.rgb(x, y))));
    const cyanAt = (x, y) => base.inside(x, y)
        && (cyanLit[y * w + x] === 1 || (nearLit[y * w + x] === 1 && mintColour(snap.rgb(x, y))));
    // Rock: stone material in the mine's blue-teal rock family, paintable,
    // read from the pass's snapshot (what a run changes is no longer rock),
    // outside the sheave's rest frame (its strip restates those texels).
    const [sx, sy, sw, sh] = MINE_SHEAVE_RECT;
    const inSheave = (x, y) => x >= sx - 1 && y >= sy - 1 && x <= sx + sw && y <= sy + sh;
    const rock = (x, y) => base.inside(x, y) && !inSheave(x, y) && matAt(x, y) === MAT_STONE && !crystalAt(x, y)
        && snap.paintable(x, y) && rockColour(snap.rgb(x, y));
    const ink = (x, y) => base.inside(x, y) && snap.alpha(x, y) === 255 && value(snap.rgb(x, y)) < INK_VALUE;
    // Rows (1..4) up to the crystal straight above, through rock and its ink.
    const underCrystal = (x, y) => {
        for (let k = 1; k <= 4; k++) {
            if (y - k < 0) break;
            if (crystalAt(x, y - k)) return { k, cyan: cyanAt(x, y - k) };
            if (!rock(x, y - k) && !ink(x, y - k)) break;
        }
        return null;
    };
    // Below a cluster, never between its prisms: no crystal within 3 px
    // either side on the texel's own row.
    const betweenPrisms = (x, y) => {
        let left = false;
        let right = false;
        for (let d = 1; d <= 3; d++) {
            if (crystalAt(x - d, y)) left = true;
            if (crystalAt(x + d, y)) right = true;
        }
        return left && right;
    };
    const nearCrystal = (x, y, r) => {
        for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) if (crystalAt(x + dx, y + dy)) return true;
        return false;
    };
    const census = { striation: 0, socket: 0, bounce: 0 };
    const edits = [];
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            if (!rock(x, y)) continue;
            const under = underCrystal(x, y);
            if (under && !betweenPrisms(x, y)) {
                // Sockets (2 rows) and the aqua lip under cyan crystals.
                if (under.k <= 2) {
                    edits.push([x, y, SOCKET]);
                    census.socket++;
                } else if (under.cyan && luma(snap.rgb(x, y)) > 0.36) {
                    edits.push([x, y, AQUA_BOUNCE]);
                    census.bounce++;
                }
                continue;
            }
            if (nearCrystal(x, y, 3)) continue;
            // Granite striations: broken 1-px bedding lines rising 1 px per
            // 3 across, each 23-px band on its own seeded offset.
            const band = Math.floor((x - 3 * y + 4096) / 23);
            const phase = (x - 3 * y + 4096) - band * 23;
            if (phase !== Math.floor(hash(band, 11, 3) * 23)) continue;
            if (hash(Math.floor(x / 5), band, 7) < 0.45) continue;
            const l = luma(snap.rgb(x, y));
            if (l > 0.55) edits.push([x, y, STONE[3]]);
            else if (l > 0.42) edits.push([x, y, STONE[2]]);
            else continue;
            census.striation++;
        }
    }
    for (const [x, y, colour] of edits) base.set(x, y, colour);
    return { name: 'building.mine', changes: [[join(dir, 'base.png'), source, base.png]], census };
}

// The mine's rock family: blue-teal greys (HSV hue 175-245, S 0.08-0.5).
function rockColour(rgb) {
    const { h, s } = hsvOf(rgb);
    return h >= 175 && h <= 245 && s >= 0.08 && s <= 0.5;
}
// Mint / cyan crystal (hue 120-175, lit) and amber crystal (hue 20-55, lit).
function mintColour(rgb) {
    const { h, s, v } = hsvOf(rgb);
    return h >= 120 && h < 175 && s >= 0.08 && v >= 0.55;
}
function crystalColour(rgb) {
    const { h, s, v } = hsvOf(rgb);
    return mintColour(rgb) || (h >= 20 && h <= 55 && s >= 0.4 && v >= 0.6);
}
function hsvOf([r8, g8, b8]) {
    const r = r8 / 255;
    const g = g8 / 255;
    const b = b8 / 255;
    const max = Math.max(r, g, b);
    const d = max - Math.min(r, g, b);
    let hue = 0;
    if (d > 0) {
        if (max === r) hue = ((g - b) / d) % 6;
        else if (max === g) hue = (b - r) / d + 2;
        else hue = (r - g) / d + 4;
        hue *= 60;
        if (hue < 0) hue += 360;
    }
    return { h: hue, s: max > 0 ? d / max : 0, v: max };
}

// ─── the Portal ──────────────────────────────────────────────────────────────

// The dais top's flagstones carry the surface bake's `up` face at the
// dais's height (bake-surface-channel SURFACE_SPECS.portal); the rune
// ring is an iso ellipse (sprite px) round the vortex's foot, inlaid in
// every dais flag it crosses (the arch, the braziers and the stair hide
// the rest of it), a rune notch inside it every RING_RUNES-th of a turn.
const PORTAL_DAIS_HEIGHT = [20, 26];
const PORTAL_RING = Object.freeze({ cx: 156, cy: 192, rx: 44, ry: 22 });
const RING_RUNES = 28;
const PORTAL_STEPS = Object.freeze({ x0: 72, y0: 184, x1: 147, y1: 249 });

function polishPortal() {
    const dir = join(BUILDINGS, 'building.portal');
    const source = read(join(dir, 'base.png'));
    const sourceGlow = read(join(dir, 'base.emissive.png'));
    const material = read(join(dir, 'base.material.png'));
    const occluder = read(join(dir, 'base.occluder.png'));
    const slumber = read(join(dir, 'slumber.png'));
    const base = new Sprite(clone(source));
    const glow = new Sprite(clone(sourceGlow));
    const { w, h } = base;
    const k = (x, y) => (y * w + x) * 4;
    const stone = (x, y) => base.inside(x, y) && material.data[k(x, y)] === MAT_STONE && base.paintable(x, y);
    const vortex = (x, y) => base.inside(x, y) && slumber.data[k(x, y) + 3] > 0;
    const daisTop = (x, y) => {
        const i = k(x, y);
        const face = occluder.data[i + 2] >> 6;
        const height = occluder.data[i];
        return face === 0 && height >= PORTAL_DAIS_HEIGHT[0] && height <= PORTAL_DAIS_HEIGHT[1];
    };
    const census = { worn: 0, crack: 0, ring: 0, rune: 0, chip: 0, bounce: 0 };
    const LIGHT = 0.6;
    // Worn flags: in seeded 9x5 cells, the lightest flag stop a step down.
    const top = hex(ART_RAMPS.ashlar[8]);
    const worn = hex(ART_RAMPS.ashlar[7]);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            if (!stone(x, y) || !daisTop(x, y)) continue;
            const c = base.rgb(x, y);
            if (c[0] !== top[0] || c[1] !== top[1] || c[2] !== top[2]) continue;
            if (hash(Math.floor((x + 2 * y) / 9), Math.floor((2 * y - x + 512) / 9), 31) < 0.22) {
                base.set(x, y, worn);
                census.worn++;
            }
        }
    }
    // Hairline cracks: short seeded zigzags across the flags.
    for (let n = 0; n < 14; n++) {
        let x = 60 + Math.floor(hash(n, 1, 41) * 200);
        let y = 150 + Math.floor(hash(n, 2, 41) * 80);
        const len = 4 + Math.floor(hash(n, 3, 41) * 4);
        const dir = hash(n, 4, 41) < 0.5 ? 1 : -1;
        for (let s = 0; s < len; s++) {
            if (base.inside(x, y) && stone(x, y) && daisTop(x, y) && luma(base.rgb(x, y)) > LIGHT) {
                base.set(x, y, ASHLAR[3]);
                census.crack++;
            }
            x += dir;
            if (hash(n, s, 43) < 0.5) y += 1;
        }
    }
    // The inlaid rune ring: an iso ellipse on the dais top, slate[0] inlay,
    // a slate[2] rune tick outside it every ~11 px of arc.
    // Two inlaid lines (slate[0] outside, slate[1] inside, 3 px apart on
    // the long axis) with a rune mark between them every 1/RING_RUNES turn.
    const { cx, cy, rx, ry } = PORTAL_RING;
    const ellipse = (ex, ey) => {
        const out = new Set();
        for (let n = 0; n < 900; n++) {
            const t = (n / 900) * Math.PI * 2;
            out.add(`${Math.round(cx + ex * Math.cos(t))},${Math.round(cy + ey * Math.sin(t))}`);
        }
        return out;
    };
    const outer = ellipse(rx, ry);
    const inner = ellipse(rx - 3, ry - 1.5);
    const inlay = (cells, colour) => {
        for (const key of cells) {
            const [x, y] = key.split(',').map(Number);
            if (!stone(x, y) || !daisTop(x, y)) continue;
            base.set(x, y, colour);
            census.ring++;
        }
    };
    inlay(outer, SLATE[0]);
    inlay(inner, SLATE[1]);
    for (let n = 0; n < RING_RUNES; n++) {
        const t = ((n + 0.5) / RING_RUNES) * Math.PI * 2;
        const x = Math.round(cx + (rx - 1.5) * Math.cos(t));
        const y = Math.round(cy + (ry - 0.75) * Math.sin(t));
        for (const [qx, qy] of [[x, y], [x + (n % 2 ? 1 : -1), y]]) {
            const key = `${qx},${qy}`;
            if (!base.inside(qx, qy) || outer.has(key) || inner.has(key) || !stone(qx, qy) || !daisTop(qx, qy)) continue;
            base.set(qx, qy, SLATE[2]);
            census.rune++;
        }
    }
    // Chipped step corners: the outer end of a seeded tread nosing (the
    // first lit texel inside the stair's inked left edge) a stop or two down.
    const steps0 = PORTAL_STEPS;
    for (let y = steps0.y0; y <= steps0.y1; y++) {
        for (let x = steps0.x0; x <= steps0.x1; x++) {
            if (!stone(x, y) || luma(base.rgb(x, y)) <= LIGHT) continue;
            if (value(base.rgb(x - 1, y)) >= INK_VALUE || base.alpha(x - 1, y) === 0) continue;
            if (hash(x, y, 53) >= 0.55) continue;
            base.set(x, y, ASHLAR[4]);
            if (stone(x + 1, y) && luma(base.rgb(x + 1, y)) > LIGHT) base.set(x + 1, y, ASHLAR[6]);
            census.chip++;
        }
    }
    // Violet bounce on the jambs and the threshold (emissive only).
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            if (!stone(x, y) || vortex(x, y) || glow.alpha(x, y) > 0) continue;
            let d = 0;
            for (let r = 1; r <= 2 && !d; r++) {
                for (let dy = -r; dy <= r && !d; dy++) for (let dx = -r; dx <= r && !d; dx++) if (vortex(x + dx, y + dy)) d = r;
            }
            // The threshold: the flags straight below the vortex's foot.
            let below = 0;
            if (!d && daisTop(x, y)) {
                for (let r = 1; r <= 6; r++) if (vortex(x, y - r) || vortex(x - 1, y - r)) { below = r; break; }
            }
            const alpha = d === 1 ? 72 : d === 2 ? 48 : below ? Math.max(16, 64 - below * 8) : 0;
            if (!alpha) continue;
            glow.set(x, y, VIOLET_BOUNCE, alpha);
            census.bounce++;
        }
    }
    return {
        name: 'building.portal',
        changes: [[join(dir, 'base.png'), source, base.png], [join(dir, 'base.emissive.png'), sourceGlow, glow.png]],
        census,
    };
}

function run() {
    const results = [polishMine(), polishPortal()];
    const pending = [];
    for (const { name, changes, census } of results) {
        const changed = changes.filter(([, before, after]) => !samePixels(before, after));
        console.log(`[polish-mine-portal] ${name}: ${Object.entries(census).map(([key, n]) => `${key} ${n}`).join(', ')}${changed.length ? '' : ' — current'}`);
        pending.push(...changed);
    }
    if (check) {
        if (pending.length) {
            for (const [path] of pending) console.error(`[polish-mine-portal] stale: ${path.slice(repoRoot.length + 1)}`);
            process.exit(1);
        }
        return;
    }
    for (const [path, , png] of pending) {
        writeFileSync(path, PNG.sync.write(png, { colorType: 6 }));
        console.log(`[polish-mine-portal] wrote ${path.slice(repoRoot.length + 1)}`);
    }
}

run();
