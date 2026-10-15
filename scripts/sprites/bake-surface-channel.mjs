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
// authoring for the Harbor, Lighthouse, Observatory (retired) and Portal.
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
// Gold and brass trim (dome ribs, rings, finials): warm and saturated, never
// the warm-grey masonry (S <= 0.16).
const GOLD = { hue: [20, 60], minSat: 0.45, minValue: 0.2 };

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
            // Only the shell's slate and gold are roof; the stone drum wall
            // under the gold ring and the lantern's stone are walls on the
            // same centre (the next region), so roof weather never lies on them.
            { face: 'roof', poly: [[124, 90], [126, 62], [140, 40], [160, 26], [168, 4], [176, -1], [184, 4], [192, 26], [212, 40], [225, 62], [226, 90], [175, 98]], match: [SLATE, GOLD], base: { corner: [175, 214] } },
            { face: 'auto', poly: [[124, 90], [126, 62], [140, 40], [160, 26], [168, 4], [176, -1], [184, 4], [192, 26], [212, 40], [225, 62], [226, 90], [175, 98]], base: { corner: [175, 214] } },
            // Dome drum (windowed ring) on the same centre.
            { face: 'auto', poly: [[126, 88], [226, 88], [226, 112], [126, 112]], base: { corner: [175, 214] } },
            // Slate-glass panes the emissive sidecar leaves unlit (on the
            // spire, the round tower and the keep): wall, never roof, on their
            // own masses' corners.
            { face: 'auto', roof: [], poly: [[70, 98], [75, 98], [75, 106], [70, 106]], base: { corner: [78, 170] } },
            { face: 'auto', roof: [], poly: [[263, 96], [268, 96], [268, 105], [263, 105]], base: { corner: [254, 185] } },
            { face: 'auto', roof: [], poly: [[212, 128], [218, 128], [218, 138], [212, 138]], base: { corner: [165, 213] } },
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
        // 5.A — the water line under the quay's coursed face; the quay deck
        // stands 16 px above it, the pier decks 12 px.
        base: { left: [3, 187], bottom: [95, 226], right: [230, 154] },
        roof: [SLATE],
        regions: [
            // Quay lantern on its post, at the deck's west corner.
            { face: 'auto', poly: [[6, 138], [26, 138], [26, 176], [6, 176]], base: { corner: [12, 176] }, lift: 16 },
            // Jib crane on the deck's front: post and jib, then rope and crate.
            { face: 'auto', poly: [[44, 144], [92, 144], [92, 158], [63, 158], [63, 206], [46, 206], [46, 158], [44, 158]], base: { corner: [55, 203] }, lift: 16 },
            { face: 'auto', poly: [[83, 158], [90, 158], [90, 184], [94, 184], [94, 206], [75, 206], [75, 184], [83, 184]], base: { corner: [55, 203] }, lift: 16 },
            // The two bunting masts on the north pier.
            { face: 'auto', poly: [[260, 66], [270, 66], [270, 140], [260, 140]], base: { corner: [265, 139] }, lift: 12 },
            { face: 'auto', poly: [[337, 105], [346, 105], [346, 178], [337, 178]], base: { corner: [341, 177] }, lift: 12 },
            // Quay deck between the house's foot and the coping: the stone tops,
            // the house's shadow on them and the pier roots on the coping.
            {
                face: 'up',
                height: 16,
                poly: [[0, 168], [30, 158], [34, 163], [112, 172], [210, 124], [240, 128], [232, 140], [96, 214], [0, 172]],
                match: [{ rgb: [[169, 159, 154], [120, 98, 117], [140, 121, 130], [220, 209, 199], [108, 87, 106], [129, 108, 126], [241, 231, 215], [149, 129, 137], [90, 68, 84], [76, 58, 76], [62, 47, 66], [157, 122, 94], [155, 140, 130]] }],
                close: true,
            },
            // Pier decks east of the quay's SE face: the plank tops.
            {
                face: 'up',
                height: 12,
                poly: [[96, 214], [232, 138], [250, 128], [384, 128], [384, 284], [96, 284]],
                match: [{ rgb: [[157, 122, 94], [155, 140, 130], [162, 131, 107], [157, 110, 85]] }],
                close: true,
            },
            // The house, lean-to and clock turret on the quay: their own front corner.
            { face: 'auto', poly: [[20, 0], [270, 0], [270, 128], [210, 124], [112, 172], [34, 163], [20, 160]], base: { corner: [113, 170] }, lift: 16 },
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
    tavern: {
        // The 4x4 footprint's front edges, under the veranda's post feet.
        base: { left: [30, 218], bottom: [158, 282], right: [286, 218] },
        roof: [SLATE],
        regions: [
            // Below the eaves the slate-toned glass and ironwork is no roof.
            { face: 'auto', roof: [], poly: [[0, 70], [60, 92], [190, 158], [205, 150], [296, 150], [296, 288], [0, 288]] },
        ],
    },
    portal: {
        // The dais's front corner; its two coursed faces run off it.
        base: { corner: [178, 258] },
        roof: [],
        regions: [
            // Steps from the ground up to the dais, under the vortex.
            { face: 'up', poly: [[104, 184], [146, 205], [135, 214], [135, 240], [117, 248], [73, 225], [78, 214], [99, 191]], height: { ramp: [[96, 236, 0], [124, 195, 23]] } },
            // The two crystal braziers standing on the dais.
            { face: 'auto', lift: 23, base: { corner: [92, 179] }, poly: [[80, 152], [106, 152], [106, 180], [80, 180]] },
            { face: 'auto', lift: 23, base: { corner: [171, 216] }, poly: [[158, 188], [185, 188], [185, 217], [158, 217]] },
            // Dais flagstones, up to the feet of the towers, the arch and the vortex.
            { face: 'up', height: 23, poly: [[36, 171], [80, 149], [100, 152], [129, 163], [182, 190], [205, 203], [221, 209], [235, 203], [236, 163], [277, 183], [277, 188], [178, 237], [135, 214], [101, 187], [81, 195], [36, 172]] },
            // The left wing's faces stand 5 px proud of the right block's.
            { face: 'auto', base: { corner: [81, 217] }, poly: [[30, 166], [100, 166], [100, 232], [30, 232]] },
            // The two slate spires are roofs (snow, wet course); their gold
            // bands and finials stay walls.
            { face: 'roof', lift: 23, base: { corner: [96, 154] }, poly: [[83, 4], [109, 4], [111, 59], [81, 59]], match: [SLATE] },
            { face: 'roof', lift: 23, base: { corner: [221, 209] }, poly: [[207, 59], [237, 59], [238, 111], [206, 111]], match: [SLATE] },
            // The left tower on its own front corner; its slate-glass slits are walls.
            { face: 'auto', lift: 23, base: { corner: [96, 154] }, poly: [[78, -1], [111, -1], [111, 64], [102, 70], [101, 153], [80, 150], [78, 150]] },
            // The arch, the vortex and the right tower, on the right tower's front corner.
            { face: 'auto', lift: 23, base: { corner: [221, 209] }, poly: [[60, -1], [250, -1], [250, 163], [236, 163], [235, 203], [221, 210], [205, 204], [182, 191], [129, 164], [100, 153], [80, 150], [60, 150]] },
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
