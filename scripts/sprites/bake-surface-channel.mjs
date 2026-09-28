#!/usr/bin/env node
// Plan 2.3 (LGI-3) — landmark surface channel.
//
// Writes each landmark's `base.occluder.png` companion:
//   R = true height above ground, world px (= sprite px at scale 1), clamped 255
//   G = occlusion strength (kept from an existing sidecar, else alpha x strength)
//   B = surface code  face * 64 + min(63, round(height / 4))
//       face 0 up/apron, 1 left wall (SW-facing, on the left->bottom footprint
//       edge), 2 right wall (SE-facing, on the bottom->right edge), 3 roof
//   A = albedo alpha
// `docs/material-channel-contract.md` (V9 one channel contract) is the reader
// contract; the GPU reads B only on records flagged `surfaceCode`.
//
// Geometry: every landmark has a visual base — the 2:1 diamond front edges
// where its art meets the ground, in sprite px. It defaults to the
// BUILDING_DEFS footprint projected through the sprite anchor (the sprite
// anchor sits on the footprint centre, `buildingCenterToWorld`). A wall pixel's
// foot is the base front edge under its column: height = footY(x) - y, face by
// the side of the front corner. Roof pixels are the landmark's roof colours
// (slate/bronze ramps, per spec). Pixels in front of the base edge are apron
// (up, height 0). Authored regions (polygons, first match wins) override this
// for decks, piers, stairs, daises and set-back masses; M5 approved hand
// authoring for the Harbor, Lighthouse, Observatory and Portal.
//
// Usage:
//   node scripts/sprites/bake-surface-channel.mjs            # write sidecars
//   node scripts/sprites/bake-surface-channel.mjs --check    # verify on-disk bytes
//   node scripts/sprites/bake-surface-channel.mjs --ids=harbor,portal
// After writing, rerun `npm run sprites:atlas-bake -- --atlas=world-pilot`.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { BUILDING_DEFS } from '../../claudeville/src/config/buildings.js';
import { buildingCenterToWorld, tileToWorld } from '../../claudeville/src/presentation/character-mode/Projection.js';
import { collectSpriteEntries, loadSpriteManifest, spritesRoot } from './manifest-utils.mjs';

export const SURFACE_FACE = Object.freeze({ up: 0, left: 1, right: 2, roof: 3 });
const APRON_TOLERANCE_PX = 2;

// Colour rules: HSV (hue in degrees) or `{ rgb: [[r, g, b], ...] }` exact
// colours. Slate roofs sit on a saturated blue/teal band that the cool-grey
// masonry never reaches.
const SLATE = { hue: [186, 242], minSat: 0.2, minValue: 0.12 };

// Every coordinate is a sprite px of the landmark's base.png. `base` is the
// visual base (where the art meets the ground); regions are first-match.
export const SURFACE_SPECS = Object.freeze({
    command: {
        base: { left: [58, 171], bottom: [213, 238], right: [343, 174] },
        roof: [SLATE],
        regions: [
            // Two broad stone steps climbing to the gate sill.
            { face: 'up', poly: [[96, 200], [118, 186], [153, 191], [153, 213], [124, 216], [96, 209]], height: { ramp: [[110, 213, 0], [134, 192, 8]] } },
            // Dome shell, gold ribs and finial, standing on the keep: the drum
            // rises from the keep roof, so its foot is the gate wall's foot.
            { face: 'roof', poly: [[124, 90], [126, 62], [140, 40], [160, 26], [168, 4], [176, -1], [184, 4], [192, 26], [212, 40], [225, 62], [226, 90], [175, 98]], base: { corner: [175, 214] } },
            // Dome drum (windowed ring) on the same centre.
            { face: 'auto', poly: [[126, 88], [226, 88], [226, 112], [126, 112]], base: { corner: [175, 214] } },
            // Left spire tower: its own front corner.
            { face: 'auto', poly: [[56, 10], [101, 10], [101, 172], [56, 172]], base: { corner: [78, 170] } },
            // Round crenellated tower behind the east wing.
            { face: 'auto', poly: [[231, 48], [279, 48], [279, 132], [231, 132]], base: { corner: [254, 185] } },
            // The keep turns at the gate pillar: its bannered upper wall right
            // of the pillar faces SE, above the east wing's gable.
            { face: 'auto', poly: [[163, 88], [232, 88], [232, 140], [180, 160], [163, 160]], base: { corner: [165, 213] } },
        ],
    },
    archive: {
        base: { left: [40, 172], bottom: [212, 230], right: [300, 190] },
        roof: [SLATE],
        regions: [
            // Portal steps under the SE gable door.
            { face: 'up', poly: [[222, 215], [262, 197], [284, 205], [284, 214], [248, 234], [222, 228]], height: { ramp: [[248, 232, 0], [250, 206, 8]] } },
        ],
    },
    forge: {
        base: { left: [28, 170], bottom: [120, 206], right: [228, 160] },
        roof: [SLATE],
        regions: [
            // Chimney stack above the roof: its own corner at the back right.
            { face: 'auto', poly: [[146, 6], [210, 6], [210, 120], [146, 120]], base: { corner: [178, 176] } },
        ],
    },
    taskboard: {
        // The slate plane faces the lower-left entrance along the post feet.
        base: { left: [55, 166], bottom: [172, 224], right: [260, 180] },
        roof: [SLATE],
        regions: [],
    },
    mine: {
        base: { left: [20, 188], bottom: [150, 224], right: [230, 206] },
        roof: [],
        regions: [],
    },
    harbor: {
        // Water line under the quay; decks and piers stand 8 px above it.
        base: { corner: [222, 208] },
        roof: [SLATE],
        regions: [
            // Deck and pier tops: the lit plank colour, seams closed.
            {
                face: 'up',
                height: 8,
                poly: [[38, 150], [110, 138], [160, 150], [200, 158], [292, 158], [292, 200], [240, 216], [200, 233], [118, 233], [38, 206]],
                match: [{ rgb: [[136, 104, 80], [164, 119, 82], [202, 148, 100]] }],
                close: true,
            },
            // East quay platform under the crane hall: darker planks.
            {
                face: 'up',
                height: 8,
                poly: [[212, 160], [268, 134], [282, 140], [282, 150], [228, 172], [212, 168]],
                match: [{ rgb: [[129, 88, 63], [109, 76, 57], [136, 104, 80], [88, 66, 48]] }],
                close: true,
            },
            // Stone arcade under the east hall, on the water.
            { face: 'auto', poly: [[148, 150], [282, 150], [282, 214], [148, 214]], base: { left: [60, 150], bottom: [158, 200], right: [282, 196] } },
            // West house on the upper deck.
            { face: 'auto', poly: [[70, 20], [152, 20], [152, 152], [70, 152]], base: { corner: [114, 152] }, lift: 8 },
            // Guildhall, east hall and crane on the quay.
            { face: 'auto', poly: [[150, 0], [312, 0], [312, 150], [150, 150]], base: { corner: [205, 172] }, lift: 8 },
        ],
    },
    watchtower: {
        base: { corner: [146, 334] },
        roof: [],
        regions: [
            // Quay stair up to the door landing.
            { face: 'up', poly: [[88, 318], [104, 309], [126, 309], [126, 322], [108, 333], [88, 331]], height: { ramp: [[95, 329, 0], [118, 311, 8]] } },
            // Bronze lantern cap and finial.
            { face: 'roof', poly: [[122, 58], [124, 42], [138, 28], [143, 3], [149, 3], [154, 28], [168, 42], [170, 58]] },
        ],
    },
    observatory: {
        base: { left: [50, 236], bottom: [148, 265], right: [205, 238] },
        roof: [SLATE],
        regions: [
            // Door steps under the porch gable.
            { face: 'up', poly: [[148, 262], [188, 243], [204, 250], [204, 258], [166, 274], [148, 268]], height: { ramp: [[168, 268, 0], [176, 250, 8]] } },
            // Dome shell with its brass ribs and lantern.
            { face: 'roof', poly: [[55, 118], [60, 90], [70, 70], [85, 55], [85, 35], [100, 10], [106, 0], [112, 10], [125, 35], [125, 55], [140, 70], [150, 90], [153, 118]], base: { corner: [104, 250] } },
            // Maroon eave boards and gable rakes belong to the roofs.
            { face: 'roof', poly: [[30, 0], [230, 0], [230, 200], [30, 200]], match: [{ hue: [340, 20], minSat: 0.3, minValue: 0.2, maxValue: 0.75 }] },
        ],
    },
    portal: {
        base: { left: [57, 146], bottom: [153, 194], right: [258, 141] },
        roof: [],
        regions: [
            // Stairs from the ground up to the dais.
            { face: 'up', poly: [[86, 152], [104, 142], [126, 152], [126, 172], [108, 182], [86, 172]], height: { ramp: [[96, 176, 0], [116, 150, 23]] } },
            // Dais flagstones.
            { face: 'up', height: 23, poly: [[57, 123], [88, 108], [100, 112], [118, 104], [135, 122], [165, 118], [178, 125], [192, 150], [153, 171]] },
            // Arch, crystals and rock slabs standing on the dais.
            { face: 'auto', lift: 23, base: { corner: [190, 152] }, poly: [[0, -1], [312, -1], [312, 121], [253, 124], [192, 150], [178, 125], [135, 122], [118, 104], [88, 108], [57, 123], [0, 123]] },
        ],
    },
});

const args = process.argv.slice(2);
const checkOnly = args.includes('--check');
const idsArg = args.find((arg) => arg.startsWith('--ids='));
const onlyIds = idsArg ? new Set(idsArg.slice('--ids='.length).split(',').filter(Boolean)) : null;
// --out=<dir> writes `<dir>/<type>.occluder.png` previews instead of the assets.
const outArg = args.find((arg) => arg.startsWith('--out='));
const previewDir = outArg ? outArg.slice('--out='.length) : null;

export function footprintBase(def, anchor) {
    const centre = buildingCenterToWorld({ position: { tileX: def.x, tileY: def.y }, width: def.width, height: def.height });
    const toSprite = (tx, ty) => {
        const world = tileToWorld(tx, ty);
        return [world.x - centre.x + anchor[0], world.y - centre.y + anchor[1]];
    };
    return {
        left: toSprite(def.x, def.y + def.height),
        bottom: toSprite(def.x + def.width, def.y + def.height),
        right: toSprite(def.x + def.width, def.y),
    };
}

// A base is the 2:1 front edges `{ left, bottom, right }`, or `{ corner }`,
// the front corner with the exact iso slopes (1 px down per 2 px across).
export function resolveBase(base) {
    if (!base?.corner) return base;
    const [cx, cy] = base.corner;
    return { left: [cx - 100, cy - 50], bottom: [cx, cy], right: [cx + 100, cy - 50] };
}

// Foot of column x on the base front edges (extended past the corners).
export function footY(base, x) {
    const [bx, by] = base.bottom;
    const [ax, ay] = x <= bx ? base.left : base.right;
    if (ax === bx) return by;
    return by + (x - bx) * (ay - by) / (ax - bx);
}

function pointInPolygon(poly, x, y) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const [xi, yi] = poly[i];
        const [xj, yj] = poly[j];
        if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
}

function rgbToHsv(r, g, b) {
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
    return { h, s: max === 0 ? 0 : d / max, v: max / 255 };
}

function matchesColourRule(rule, r, g, b) {
    const { h, s, v } = rgbToHsv(r, g, b);
    const [h0, h1] = rule.hue;
    const hueOk = h0 <= h1 ? h >= h0 && h <= h1 : h >= h0 || h <= h1;
    return hueOk && s >= (rule.minSat ?? 0) && s <= (rule.maxSat ?? 1)
        && v >= (rule.minValue ?? 0) && v <= (rule.maxValue ?? 1);
}

function rampHeight(ramp, x, y) {
    const [[x0, y0, h0], [x1, y1, h1]] = ramp;
    const dx = x1 - x0;
    const dy = y1 - y0;
    const len2 = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((x - x0) * dx + (y - y0) * dy) / len2));
    return h0 + (h1 - h0) * t;
}

function matchesAnyRule(rules, rgb) {
    return rules.some((rule) => (rule.rgb
        ? rule.rgb.some(([r, g, b]) => r === rgb[0] && g === rgb[1] && b === rgb[2])
        : matchesColourRule(rule, ...rgb)));
}

// Window glass (texels lit in the emissive sidecar) is wall even where the
// unlit slate glass shares the roof's blue.
function autoSurface(x, y, rgb, base, lift, roofRules, glass) {
    const h = footY(base, x) - y;
    const height = lift + Math.max(0, h);
    if (!glass && matchesAnyRule(roofRules, rgb)) return { face: SURFACE_FACE.roof, height };
    if (h < -APRON_TOLERANCE_PX) return { face: SURFACE_FACE.up, height: lift };
    return { face: x < base.bottom[0] ? SURFACE_FACE.left : SURFACE_FACE.right, height };
}

// One 3x3 closing (dilate then erode) bridges the 1-texel plank seams of a
// colour-matched deck without growing its outline.
function closeMask(mask, width, height) {
    const pass = (source, dilate) => {
        const out = new Uint8Array(width * height);
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                let any = false;
                let all = true;
                for (let dy = -1; dy <= 1; dy++) {
                    for (let dx = -1; dx <= 1; dx++) {
                        const nx = x + dx;
                        const ny = y + dy;
                        const on = nx >= 0 && ny >= 0 && nx < width && ny < height && source[ny * width + nx] === 1;
                        any ||= on;
                        all &&= on;
                    }
                }
                out[y * width + x] = (dilate ? any : all) ? 1 : 0;
            }
        }
        return out;
    };
    return pass(pass(mask, true), false);
}

// A region with `match` rules (HSV rules or `{ rgb: [...] }` exact colours)
// covers only its matching pixels inside the polygon (closed when `close`).
function regionMasks(spec, albedo) {
    const { width, height, data } = albedo;
    return (spec.regions || []).map((region) => {
        if (!region.match) return null;
        const mask = new Uint8Array(width * height);
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const i = (y * width + x) * 4;
                if (data[i + 3] && matchesAnyRule(region.match, [data[i], data[i + 1], data[i + 2]])) mask[y * width + x] = 1;
            }
        }
        return region.close ? closeMask(mask, width, height) : mask;
    });
}

export function classifySurfacePixel(spec, base, x, y, rgb, masks = [], width = 0, glass = false) {
    const px = x + 0.5;
    const py = y + 0.5;
    const roofRules = spec.roof || [];
    const regions = spec.regions || [];
    for (let index = 0; index < regions.length; index++) {
        const region = regions[index];
        if (!pointInPolygon(region.poly, px, py)) continue;
        if (masks[index] && !masks[index][y * width + x]) continue;
        const regionBase = resolveBase(region.base) || base;
        const lift = region.lift || 0;
        if (region.face === 'auto') return autoSurface(x, y, rgb, regionBase, lift, region.roof || roofRules, glass);
        const face = SURFACE_FACE[region.face];
        let height;
        if (typeof region.height === 'number') height = region.height;
        else if (region.height?.ramp) height = rampHeight(region.height.ramp, px, py);
        else height = lift + Math.max(0, footY(regionBase, x) - y);
        return { face, height };
    }
    return autoSurface(x, y, rgb, base, 0, roofRules, glass);
}

export function encodeSurface(face, height) {
    const h = Math.max(0, height);
    return {
        r: Math.min(255, Math.round(h)),
        b: face * 64 + Math.min(63, Math.round(h / 4)),
    };
}

export function decodeSurface(b) {
    return { face: b >> 6, height: (b & 63) * 4 };
}

// The 1-px selective outline and the deepest shadow texels (HSV value below
// INK_VALUE) carry no colour identity, so they take the surface of the
// non-ink texels around them: the modal face in a 5x5 window, at those
// texels' mean height. An outline therefore belongs to the roof, deck or wall
// it draws.
const INK_VALUE = 0.13;

export function bakeSurfaceChannel({ def, entry, albedo, emissive = null, spec }) {
    const { width, height: rows, data } = albedo;
    const base = resolveBase(spec.base) || footprintBase(def, entry.anchor);
    const strength = Number(entry.occluder?.strength ?? 1);
    const masks = regionMasks(spec, albedo);
    const faces = new Int8Array(width * rows).fill(-1);
    const heights = new Float32Array(width * rows);
    const ink = new Uint8Array(width * rows);
    for (let y = 0; y < rows; y++) {
        for (let x = 0; x < width; x++) {
            const p = y * width + x;
            const i = p * 4;
            if (data[i + 3] === 0) continue;
            const rgb = [data[i], data[i + 1], data[i + 2]];
            const glass = Boolean(emissive && emissive.data[i + 3] > 0);
            const surface = classifySurfacePixel(spec, base, x, y, rgb, masks, width, glass);
            faces[p] = surface.face;
            heights[p] = surface.height;
            ink[p] = Math.max(...rgb) / 255 < INK_VALUE ? 1 : 0;
        }
    }
    const out = new PNG({ width, height: rows, colorType: 6 });
    for (let y = 0; y < rows; y++) {
        for (let x = 0; x < width; x++) {
            const p = y * width + x;
            if (faces[p] < 0) continue;
            let face = faces[p];
            let height = heights[p];
            if (ink[p]) {
                const count = [0, 0, 0, 0];
                const sum = [0, 0, 0, 0];
                for (let dy = -2; dy <= 2; dy++) {
                    for (let dx = -2; dx <= 2; dx++) {
                        const nx = x + dx;
                        const ny = y + dy;
                        if (nx < 0 || ny < 0 || nx >= width || ny >= rows) continue;
                        const q = ny * width + nx;
                        if (faces[q] < 0 || ink[q]) continue;
                        count[faces[q]]++;
                        sum[faces[q]] += heights[q];
                    }
                }
                const best = count.indexOf(Math.max(...count));
                if (count[best] > 0) {
                    face = best;
                    height = sum[best] / count[best];
                }
            }
            const { r, b } = encodeSurface(face, height);
            const i = p * 4;
            out.data[i] = r;
            out.data[i + 1] = Math.round(data[i + 3] * strength);
            out.data[i + 2] = b;
            out.data[i + 3] = data[i + 3];
        }
    }
    return { png: out, base };
}

function main() {
    const manifest = loadSpriteManifest();
    const entries = new Map(collectSpriteEntries(manifest).map((entry) => [entry.id, entry]));
    let stale = 0;
    for (const def of BUILDING_DEFS) {
        const spec = SURFACE_SPECS[def.type];
        if (!spec || (onlyIds && !onlyIds.has(def.type))) continue;
        const entry = entries.get(`building.${def.type}`);
        if (!entry) throw new Error(`manifest has no building.${def.type}`);
        const dir = join(spritesRoot, 'buildings', `building.${def.type}`);
        const albedo = PNG.sync.read(readFileSync(join(dir, 'base.png')));
        const sidecarPath = join(dir, 'base.occluder.png');
        const previous = existsSync(sidecarPath) ? PNG.sync.read(readFileSync(sidecarPath)) : null;
        if (previous && (previous.width !== albedo.width || previous.height !== albedo.height)) {
            throw new Error(`${def.type}: occluder sidecar ${previous.width}x${previous.height} differs from albedo`);
        }
        const emissivePath = join(dir, 'base.emissive.png');
        const emissive = existsSync(emissivePath) ? PNG.sync.read(readFileSync(emissivePath)) : null;
        const { png } = bakeSurfaceChannel({ entry, def, albedo, emissive, spec });
        const bytes = PNG.sync.write(png, { colorType: 6 });
        if (checkOnly) {
            const same = previous && Buffer.compare(previous.data, png.data) === 0;
            if (!same) {
                stale++;
                console.error(`[surface] STALE ${def.type}: base.occluder.png differs from the bake`);
            }
            continue;
        }
        const target = previewDir ? join(previewDir, `${def.type}.occluder.png`) : sidecarPath;
        writeFileSync(target, bytes);
        console.log(`[surface] ${def.type}: wrote ${previewDir ? target : 'base.occluder.png'} (${bytes.length} bytes)`);
    }
    if (checkOnly) {
        console.log(stale ? `[surface] ${stale} stale sidecar(s)` : '[surface] all surface sidecars current');
        process.exit(stale ? 1 : 0);
    }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
