#!/usr/bin/env node
// Harmonize landmark roofs (and the Forge's stone) onto the family palette.
//
// The Tavern and the Harbor are the family reference: their slate tile is
// `ART_RAMPS.roofSlate`. Older landmarks drifted (a teal Task Board and
// Archive, a near-black indigo Forge, a cyan-leaning Command), so this remaps
// each roof onto that ramp by lightness ratio: the roof's most common tile
// colour lands on the reference body stop, and every other shade keeps its
// lightness relative to it, so the courses, joints and glints survive. The
// geometry never changes, so the occluder, rooms, material and emissive
// sidecars stay valid.
//
// Roof texels: the 2.3 surface channel's roof face (occluder B >> 6 == 3)
// where the albedo is slate-ish (HSV hue 170-260, S >= 0.08), grown one ring
// onto the same colours where the surface bake tagged a tile edge as wall.
// Ink (Rec. 601 luma < 16) is never touched. Per-building `keep` regions hold
// art that the channel tags as roof but is no tile (the Task Board's slate
// shadow band) or a deliberate signature (the Command's gilt dome).
//
// `stone` (the Forge): masonry texels (faces 0-2, `isStone`) remap onto the
// family masonry (`ART_RAMPS.ashlar` plus the Command's own wall colours) by
// percentile against the Command's walls; iron (chimney cap, anvil, tool
// rack) is kept.
//
// Every art layer that restates base pixels (restIsBase strips, the Forge's
// banked hearth) is remapped at the same base coordinates, so frame 0 stays
// equal to the base crop. Cycle masks are left alone.
//
// Usage:
//   node scripts/sprites/harmonize-roofs.mjs [--building=<id>] [--dry-run] [--out=<dir>]
//   node scripts/sprites/harmonize-roofs.mjs --check
// Apply is idempotent: texels already on the target ramp are never remapped.
// `--check` fails when a landmark's roof (or the Forge's or the chapel's stone) has a texel
// off its ramp; run it after any regeneration so the family cannot drift.
// `PROP_TARGETS` (B3-05) brings the isle landmark props under the same rule.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { PNG } from 'pngjs';
import { ART_RAMPS } from '../../claudeville/src/config/artPalette.js';
import { loadSpriteManifest, spritesRoot } from './manifest-utils.mjs';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const check = args.includes('--check');
const outDir = args.find((arg) => arg.startsWith('--out='))?.slice('--out='.length);
const only = args.find((arg) => arg.startsWith('--building='))?.slice('--building='.length);

const INK_LUMA = 16;       // never remapped
const CHECK_INK_LUMA = 24; // --check: the warm outline inks (#16131f) pass

const TARGETS = {
    // bodyStop: the roofSlate stop the roof's most common tile lands on. The
    // Tavern's main tile is stop 6; the Command keeps its own value (stop 3,
    // a hue-only shift) and the smithy sits one stop darker.
    'building.taskboard': {
        bodyStop: 6,
        // The slate board's shadow band under the eave is tagged roof.
        keep: [{ poly: [[76, 54], [176, 104], [176, 122], [76, 72]] }],
    },
    'building.archive': { bodyStop: 6 },
    'building.command': {
        bodyStop: 3,
        // D1: the gilt dome keeps its own domeSlate and gold.
        keep: [{ ellipse: [175, 58, 52, 37] }],
    },
    // The Pharos cone and the keeper's cottage roof (2026-10-15 re-author).
    'building.watchtower': { bodyStop: 6 },
    'building.forge': {
        bodyStop: 5,
        // The walls take the Command's masonry value balance (percentile
        // match), snapped onto the family masonry: the ashlar ramp plus the
        // Command's own wall colours, so the block texture keeps its
        // in-between steps and every source step its order. Iron (hooks,
        // window bars) is slate-hued, so no stone. `banked` restates the
        // hearth jamb's stone where the base is fire-lit, so it is remapped
        // by colour, not by the base mask.
        stone: {
            reference: 'building.command',
            byColour: ['banked'],
            keep: [
                { rect: [154, 0, 216, 33] },   // iron chimney cap
                { poly: [[86, 190], [104, 186], [127, 197], [127, 207], [106, 216], [86, 208]] }, // iron anvil (its stump is stone)
                { rect: [134, 148, 182, 206] }, // tool rack
            ],
        },
    },
};

// B3-05 — the W8.5b isle landmarks (`props/<id>.png`). They carry no
// occluder sidecar, so their roof is the same slate-hue test inside an
// authored `region` (the whole sprite when omitted) and the one-ring growth
// is skipped; their stone is every masonry texel off that roof.
const PROP_TARGETS = {
    // The near-black indigo roof lands on the ramp's dark half (its shadowed
    // slope is the body, the lit slope two stops up); the violet-shaded walls
    // take the Command's masonry by percentile, as the Forge's did. The
    // window and lantern glass are kept.
    'prop.waysideChapel': {
        bodyStop: 2,
        keep: [{ rect: [23, 77, 41, 101] }, { rect: [89, 75, 100, 93] }],
        stone: {
            reference: 'building.command',
            keep: [{ rect: [23, 77, 41, 101] }, { rect: [89, 75, 100, 93] }],
        },
    },
    // The cap only: the tower's cool mortar is slate-hued too.
    'prop.windmill': {
        bodyStop: 4,
        region: [{ poly: [[63, 24], [33, 60], [34, 69], [64, 78], [95, 69], [96, 60]] }],
    },
    // Roofless: checked so a regeneration that adds a roof cannot drift.
    'prop.ruinedTower': { region: [] },
};

// Landmarks whose roofs --check holds to the family ramps.
const CHECKED = ['building.tavern', 'building.harbor', ...Object.keys(TARGETS), ...Object.keys(PROP_TARGETS)];

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const key = (r, g, b) => (r << 16) | (g << 8) | b;
const toHex = (k) => `#${k.toString(16).padStart(6, '0')}`;
const luma = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;

const ROOF = ART_RAMPS.roofSlate.map(hex);
const ROOF_OK = new Set([...ART_RAMPS.roofSlate, ...ART_RAMPS.slate, ...ART_RAMPS.wetSlate].map((h) => key(...hex(h))));

function hsv(r, g, b) {
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const d = max - min;
    let h = 0;
    if (d) {
        if (max === r) h = ((g - b) / d + 6) % 6;
        else if (max === g) h = (b - r) / d + 2;
        else h = (r - g) / d + 4;
    }
    return { h: h * 60, s: max ? d / max : 0, v: max / 255 };
}

function inside(regions = [], x, y) {
    return regions.some((reg) => {
        if (reg.rect) {
            const [x0, y0, x1, y1] = reg.rect;
            return x >= x0 && x < x1 && y >= y0 && y < y1;
        }
        if (reg.ellipse) {
            const [cx, cy, rx, ry] = reg.ellipse;
            return ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1;
        }
        let hit = false;
        const p = reg.poly;
        for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
            const [xi, yi] = p[i];
            const [xj, yj] = p[j];
            if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
        }
        return hit;
    });
}

const readPng = (path) => PNG.sync.read(readFileSync(path));

function texel(png, x, y) {
    const i = (y * png.width + x) * 4;
    return [png.data[i], png.data[i + 1], png.data[i + 2], png.data[i + 3]];
}

// `occ` null (an isle prop): the roof is the slate-hue test inside `region`.
function roofMask(base, occ, keep, region = null) {
    const { width: W, height: H } = base;
    const mask = new Uint8Array(W * H);
    const counts = new Map();
    const eligible = (x, y) => {
        const [r, g, b, a] = texel(base, x, y);
        if (a < 128 || luma(r, g, b) < INK_LUMA || inside(keep, x, y)) return false;
        const { h, s } = hsv(r, g, b);
        return h >= 170 && h <= 260 && s >= 0.08;
    };
    const onRoof = occ
        ? (x, y) => texel(occ, x, y)[2] >> 6 === 3
        : (x, y) => (region ? inside(region, x, y) : true);
    for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
            if (!onRoof(x, y) || !eligible(x, y)) continue;
            mask[y * W + x] = 1;
            const k = key(...texel(base, x, y));
            counts.set(k, (counts.get(k) || 0) + 1);
        }
    }
    if (!occ) return mask;
    // One ring onto the roof's own colours: tile edges the bake tagged as wall.
    const colours = new Set([...counts].filter(([, n]) => n >= 3).map(([k]) => k));
    const ring = [];
    for (let y = 1; y < H - 1; y++) {
        for (let x = 1; x < W - 1; x++) {
            if (mask[y * W + x] || !eligible(x, y) || !colours.has(key(...texel(base, x, y)))) continue;
            let near = false;
            for (let dy = -1; dy <= 1 && !near; dy++) for (let dx = -1; dx <= 1; dx++) if (mask[(y + dy) * W + x + dx]) { near = true; break; }
            if (near) ring.push(y * W + x);
        }
    }
    for (const i of ring) mask[i] = 1;
    return mask;
}

// Masonry greys, including the violet shade the Forge's stone is painted in
// (hue 240-300); slate-blue iron and glass (~220) and fire stay out.
function isStone(r, g, b) {
    const { h, s } = hsv(r, g, b);
    return s <= 0.22 || (h >= 240 && h <= 300 && s <= 0.5);
}

// `occ` null (an isle prop): `roof` (its roofMask) is what is not stone.
function stoneMask(base, occ, keep, roof = null) {
    const { width: W, height: H } = base;
    const mask = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
            const [r, g, b, a] = texel(base, x, y);
            // A prop's near-black outline (luma < 24, the --check ink) stays.
            if (a < 128 || luma(r, g, b) < (occ ? INK_LUMA : CHECK_INK_LUMA) || inside(keep, x, y)) continue;
            if (occ ? texel(occ, x, y)[2] >> 6 === 3 : roof?.[y * W + x]) continue;
            if (!isStone(r, g, b)) continue;
            mask[y * W + x] = 1;
        }
    }
    return mask;
}

// Lightness-ratio LUT: the most common masked colour lands on ramp[bodyStop].
function ratioLut(base, mask, ramp, bodyStop, done) {
    const counts = new Map();
    for (let i = 0; i < mask.length; i++) {
        if (!mask[i]) continue;
        const k = key(base.data[i * 4], base.data[i * 4 + 1], base.data[i * 4 + 2]);
        if (!done.has(k)) counts.set(k, (counts.get(k) || 0) + 1);
    }
    if (!counts.size) return new Map();
    const body = [...counts].sort((a, b) => b[1] - a[1])[0][0];
    const bodyLuma = luma(body >> 16, (body >> 8) & 255, body & 255);
    const anchor = luma(...ramp[bodyStop]);
    const rampLuma = ramp.map((c) => luma(...c));
    const lut = new Map();
    for (const k of counts.keys()) {
        const want = (luma(k >> 16, (k >> 8) & 255, k & 255) / bodyLuma) * anchor;
        let best = 0;
        for (let s = 1; s < ramp.length; s++) if (Math.abs(rampLuma[s] - want) < Math.abs(rampLuma[best] - want)) best = s;
        lut.set(k, ramp[best]);
    }
    return lut;
}

// Percentile LUT: each colour's mid-percentile among the masked texels takes
// the reference texels' lightness at that percentile, snapped to the nearest
// ramp colour, so a dark-heavy wall takes the reference's value balance while
// every source step keeps its order.
function percentileLut(base, mask, ramp, referenceLumas, done) {
    const counts = new Map();
    for (let i = 0; i < mask.length; i++) {
        if (!mask[i]) continue;
        const k = key(base.data[i * 4], base.data[i * 4 + 1], base.data[i * 4 + 2]);
        if (!done.has(k)) counts.set(k, (counts.get(k) || 0) + 1);
    }
    const lumaOf = (k) => luma(k >> 16, (k >> 8) & 255, k & 255);
    const sorted = [...counts].sort((a, b) => lumaOf(a[0]) - lumaOf(b[0]));
    const total = sorted.reduce((a, [, n]) => a + n, 0);
    const ref = [...referenceLumas].sort((a, b) => a - b);
    const rampLuma = ramp.map((c) => luma(...c));
    const lut = new Map();
    let seen = 0;
    for (const [k, n] of sorted) {
        const q = (seen + n / 2) / total;
        seen += n;
        const want = ref[Math.min(ref.length - 1, Math.floor(q * ref.length))];
        let best = 0;
        for (let st = 1; st < ramp.length; st++) if (Math.abs(rampLuma[st] - want) < Math.abs(rampLuma[best] - want)) best = st;
        lut.set(k, ramp[best]);
    }
    return lut;
}

// The reference landmark's masonry texels (faces 1/2, `isStone`).
function wallTexels(referenceId) {
    const base = readPng(join(dir(referenceId), 'base.png'));
    const occ = readPng(join(dir(referenceId), 'base.occluder.png'));
    const out = [];
    for (let y = 0; y < base.height; y++) {
        for (let x = 0; x < base.width; x++) {
            const [r, g, b, a] = texel(base, x, y);
            const face = texel(occ, x, y)[2] >> 6;
            if (a < 128 || (face !== 1 && face !== 2) || luma(r, g, b) < INK_LUMA || !isStone(r, g, b)) continue;
            out.push([r, g, b]);
        }
    }
    return out;
}

// The family masonry: the ashlar ramp (ink excluded) plus every masonry
// colour covering >= 0.4% of the reference landmark's walls, by lightness.
function familyMasonry(referenceId) {
    const counts = new Map();
    const texels = wallTexels(referenceId);
    for (const c of texels) counts.set(key(...c), (counts.get(key(...c)) || 0) + 1);
    const total = texels.length;
    const colours = new Set(ART_RAMPS.ashlar.slice(1).map((h) => key(...hex(h))));
    for (const [k, n] of counts) if (n >= 0.004 * total) colours.add(k);
    return [...colours].map((k) => [k >> 16, (k >> 8) & 255, k & 255]).sort((a, b) => luma(...a) - luma(...b));
}

// For a layer remapped by colour: a grey the base never used takes the
// target of the base colour nearest it in lightness.
function nearestGrey(lut) {
    const from = [...lut.keys()].map((k) => [luma(k >> 16, (k >> 8) & 255, k & 255), lut.get(k)]);
    if (!from.length) return () => null;
    return (r, g, b) => {
        if (luma(r, g, b) < INK_LUMA || !isStone(r, g, b)) return null;
        const l = luma(r, g, b);
        return from.reduce((best, c) => (Math.abs(c[0] - l) < Math.abs(best[0] - l) ? c : best))[1];
    };
}

function applyLut(png, mask, lut, offsetX = 0, offsetY = 0, baseW = png.width, baseH = png.height, fallback = null) {
    let changed = 0;
    for (let y = 0; y < png.height; y++) {
        for (let x = 0; x < png.width; x++) {
            const bx = x + offsetX;
            const by = y + offsetY;
            if (mask && (bx < 0 || by < 0 || bx >= baseW || by >= baseH || !mask[by * baseW + bx])) continue;
            const i = (y * png.width + x) * 4;
            if (png.data[i + 3] === 0) continue;
            const to = lut.get(key(png.data[i], png.data[i + 1], png.data[i + 2])) ?? fallback?.(png.data[i], png.data[i + 1], png.data[i + 2]);
            if (!to) continue;
            [png.data[i], png.data[i + 1], png.data[i + 2]] = to;
            changed++;
        }
    }
    return changed;
}

// Base-local top-left of each frame of an art layer, or null for a mask.
function layerFrames(entry, layer) {
    if (layer.cycle) return null;
    const frameW = layer.frameW ?? layer.width;
    const frameH = layer.frameH ?? layer.height;
    const frames = layer.frames ?? 1;
    const full = frameW === entry.width && frameH === entry.height;
    const [ax, ay] = layer.anchor ?? entry.anchor;
    const x0 = full ? 0 : ax - Math.floor(frameW / 2);
    const y0 = full ? 0 : ay - frameH;
    return { frameW, frameH, frames, x0, y0 };
}

function cropFrame(png, f, k) {
    const out = new PNG({ width: f.frameW, height: f.frameH });
    PNG.bitblt(png, out, k * f.frameW, 0, f.frameW, f.frameH, 0, 0);
    return out;
}

const manifest = loadSpriteManifest();
const entries = new Map((manifest.buildings || []).map((e) => [e.id, e]));
const dir = (id) => join(spritesRoot, 'buildings', id);
const isProp = (id) => Object.hasOwn(PROP_TARGETS, id);
const basePathOf = (id) => (isProp(id) ? join(spritesRoot, 'props', `${id}.png`) : join(dir(id), 'base.png'));
const occluderOf = (id) => (isProp(id) ? null : readPng(join(dir(id), 'base.occluder.png')));

if (check) {
    let bad = 0;
    for (const id of CHECKED) {
        const base = readPng(basePathOf(id));
        const occ = occluderOf(id);
        const spec = TARGETS[id] || PROP_TARGETS[id] || {};
        const off = new Map();
        const tally = (mask, ok) => {
            for (let i = 0; i < mask.length; i++) {
                if (!mask[i]) continue;
                const k = key(base.data[i * 4], base.data[i * 4 + 1], base.data[i * 4 + 2]);
                if (!ok.has(k) && luma(k >> 16, (k >> 8) & 255, k & 255) >= CHECK_INK_LUMA) off.set(k, (off.get(k) || 0) + 1);
            }
        };
        const roof = roofMask(base, occ, spec.keep, spec.region);
        tally(roof, ROOF_OK);
        if (spec.stone) tally(stoneMask(base, occ, spec.stone.keep, roof), new Set(familyMasonry(spec.stone.reference).map((c) => key(...c))));
        const n = [...off.values()].reduce((a, b) => a + b, 0);
        const total = roof.reduce((a, b) => a + b, 0);
        if (n) {
            bad++;
            const top = [...off].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, c]) => `${toHex(k)}×${c}`).join(' ');
            console.error(`[harmonize-roofs] ${id}: ${n} texel(s) off the family ramps (roof ${total} px): ${top}`);
        } else {
            console.log(`[harmonize-roofs] ${id}: ok (roof ${total} px)`);
        }
    }
    process.exit(bad ? 1 : 0);
}

for (const [id, spec] of [...Object.entries(TARGETS), ...Object.entries(PROP_TARGETS)]) {
    if ((only && only !== id) || !Number.isInteger(spec.bodyStop)) continue;
    const entry = entries.get(id);
    const basePath = basePathOf(id);
    const base = readPng(basePath);
    const occ = occluderOf(id);
    const passes = [];
    const roof = roofMask(base, occ, spec.keep, spec.region);
    passes.push({ name: 'roof', mask: roof, lut: ratioLut(base, roof, ROOF, spec.bodyStop, ROOF_OK) });
    if (spec.stone) {
        const stone = stoneMask(base, occ, spec.stone.keep, roof);
        const masonry = familyMasonry(spec.stone.reference);
        const reference = wallTexels(spec.stone.reference).map((c) => luma(...c));
        const ok = new Set(masonry.map((c) => key(...c)));
        passes.push({ name: 'stone', mask: stone, byColour: spec.stone.byColour, lut: percentileLut(base, stone, masonry, reference, ok) });
    }

    // Layers first: they read the base's original colours through the LUT keys.
    const layerOut = [];
    for (const [name, layer] of Object.entries(entry?.layers || {})) {
        const f = layerFrames(entry, layer);
        const path = join(dir(id), `${name}.png`);
        if (!f || !existsSync(path)) continue;
        const png = readPng(path);
        let changed = 0;
        for (let k = 0; k < f.frames; k++) {
            const frame = cropFrame(png, f, k);
            for (const pass of passes) {
                const byColour = pass.byColour?.includes(name);
                changed += byColour
                    ? applyLut(frame, null, pass.lut, f.x0, f.y0, base.width, base.height, nearestGrey(pass.lut))
                    : applyLut(frame, pass.mask, pass.lut, f.x0, f.y0, base.width, base.height);
            }
            PNG.bitblt(frame, png, 0, 0, f.frameW, f.frameH, k * f.frameW, 0);
        }
        if (changed) layerOut.push({ name, path, png, changed });
    }

    for (const pass of passes) {
        const changed = applyLut(base, pass.mask, pass.lut);
        const lut = [...pass.lut].sort((a, b) => luma(a[0] >> 16, (a[0] >> 8) & 255, a[0] & 255) - luma(b[0] >> 16, (b[0] >> 8) & 255, b[0] & 255))
            .map(([from, to]) => `${toHex(from)}→${toHex(key(...to))}`).join(' ');
        console.log(`[harmonize-roofs] ${id} ${pass.name}: ${changed} px  ${lut || '(already on ramp)'}`);
    }
    for (const l of layerOut) console.log(`[harmonize-roofs] ${id} layer ${l.name}: ${l.changed} px`);
    if (dryRun) continue;
    // --out=<dir>: write a preview tree (<dir>/<id>/<file>) instead of the assets.
    const target = (path) => (outDir ? join(outDir, id, basename(path)) : path);
    if (outDir) mkdirSync(join(outDir, id), { recursive: true });
    writeFileSync(target(basePath), PNG.sync.write(base));
    for (const l of layerOut) writeFileSync(target(l.path), PNG.sync.write(l.png));
}
if (dryRun) console.log('[harmonize-roofs] dry run: nothing written');
