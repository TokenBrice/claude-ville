#!/usr/bin/env node
// Wave 5-B (Spec 03 §1.2 item 5.4, Spec 04 §5.3, D6) — Harbor lifted-roof
// cutaway baker: the Chart Loft.
//
// Writes four 384 x 284 layers beside `building.harbor/base.png` (anchor
// [131, 154]), pixel-registered with the base and confined to the upper
// storey under the slate hood (`x 138..168, y 92..118`,
// `BUILDING_VISUAL_REGISTRY.harbor.aperture`):
//
//   roof.png        base.png's own slate hood, bay window and timbering over
//                   the cut, byte-exact (lifted on a 4 x 4 Bayer order).
//   aperture.png    the counting-house wall (plaster between oak studs and a
//                   brace, a small leaded window, the signal-rack bracket and
//                   a brass barometer) over a planked loft floor.
//   interior.png    the drafting chart table's trestles, the ledger desk's
//                   legs and a chart crate of rolled maps, drawn after the
//                   occupants (the live table and desk tops sit on them).
//   foreground.png  the near corner posts, the hood's tie beam and the sill
//                   plate.
//
// The loft adds no text: the signal rack's lanterns and their overflow
// numeral are drawn live by `drawHarborCutaway` (pixel stamps only).
//
// Usage:
//   node scripts/sprites/bake-cutaway-harbor.mjs           # write the 4 layers
//   node scripts/sprites/bake-cutaway-harbor.mjs --check   # verify on-disk bytes + invariants
//   node scripts/sprites/bake-cutaway-harbor.mjs --help

import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeApertureLayers } from '../../claudeville/src/presentation/character-mode/BuildingApertureModel.js';
import { HARBOR_CUTAWAY_PROFILE } from '../../claudeville/src/presentation/character-mode/BuildingCutaways.js';
import {
    apertureFloorY,
    getBuildingApertureProfile,
} from '../../claudeville/src/presentation/character-mode/BuildingVisualRegistry.js';
import {
    BUILDINGS_DIR,
    OUTLINE_INK as INK,
    PixelLayer,
    R,
    cropRoof,
    cutColumn,
    cutawayMask,
    hash2,
    inspectAuthoredLayer,
    inspectRoofLayer,
    inspectSlots,
    maskBounds,
    readPng,
    runCutawayBakerCli,
} from './bake-cutaway-command.mjs';

export const HARBOR_DIR = join(BUILDINGS_DIR, 'building.harbor');
// Oak studs of the counting-house wall (sprite x).
export const HARBOR_STUDS = Object.freeze([141, 148, 156, 163]);

function paintHarborAperture(layer, aperture, mask, base) {
    const { width, height } = base;
    const { minX, maxX } = maskBounds(mask, width, height);
    const span = (x) => cutColumn(mask, width, height, x);
    const floorRow = Math.ceil(apertureFloorY(aperture, minX));

    for (let x = minX; x <= maxX; x++) {
        const col = span(x);
        for (let y = col.top; y <= col.bottom; y++) {
            let color;
            if (y <= col.top + 1) color = R.timber[0];
            else if (y === col.top + 2) color = R.timber[1];
            else if (y < floorRow - 1) {
                // Lime plaster, faintly mottled.
                color = hash2(x, y, 7) % 9 === 0 ? R.ashlar[6] : R.ashlar[5];
            } else if (y === floorRow - 1) color = R.timber[0];
            else {
                // Planks run along the wall; seams every three rows, staggered butt joints.
                const rel = y - floorRow;
                const plank = Math.floor(rel / 3);
                const seam = rel % 3 === 2;
                const butt = ((x - minX + plank * 7) % 13) === 0;
                color = seam || butt ? R.timber[1] : (hash2(plank, Math.floor((x - minX + plank * 7) / 13), 9) % 4 === 0 ? R.timber[3] : R.timber[2]);
            }
            layer.set(x, y, color);
        }
    }
    // Oak studs and one brace: the inside of the half-timbered wall.
    for (const sx of HARBOR_STUDS) {
        for (let y = span(sx).top + 3; y < floorRow - 1; y++) {
            layer.set(sx, y, R.timber[1]);
            layer.set(sx + 1, y, R.timber[0]);
        }
    }
    for (let i = 0; i <= 6; i++) {
        const x = HARBOR_STUDS[1] + 2 + i;
        const y = floorRow - 3 - i;
        layer.set(x, y, R.timber[1]);
    }
    // A small leaded window between the first two studs.
    const window = new PixelLayer(layer.width, layer.height, layer.clip);
    for (let y = 96; y <= 100; y++) {
        for (let x = 143; x <= 146; x++) window.set(x, y, (x === 144 || y === 98) ? R.slate[3] : R.slate[1]);
    }
    layer.outline(window, INK);
    layer.stamp(window);
    // Signal-rack bracket on the wall (the live beam hangs from it).
    const rack = HARBOR_CUTAWAY_PROFILE.signalRack.at;
    layer.set(rack[0] - 1, rack[1] - 2, INK);
    layer.set(rack[0] - 1, rack[1] - 1, R.timber[0]);
    layer.set(rack[0] - 2, rack[1] - 1, R.timber[0]);
    // A brass barometer on the wall beside the chart table.
    const baro = new PixelLayer(layer.width, layer.height, layer.clip);
    baro.set(152, 96, R.trimGold[2]);
    baro.set(152, 97, R.trimGold[1]);
    baro.set(153, 96, R.trimGold[1]);
    baro.set(153, 97, R.trimGold[0]);
    layer.outline(baro, INK);
    layer.stamp(baro);
}

function paintHarborInterior(layer) {
    // Chart table trestles under the live 10 x 6 top at the chart slot.
    const chart = HARBOR_CUTAWAY_PROFILE.slots.find((slot) => slot.id === 'chartTable').at;
    const legs = new PixelLayer(layer.width, layer.height, layer.clip);
    for (const lx of [chart[0] - 4, chart[0] + 3]) {
        for (let y = chart[1] + 3; y <= chart[1] + 5; y++) legs.set(lx, y, R.timber[0]);
    }
    for (let x = chart[0] - 4; x <= chart[0] + 3; x++) legs.set(x, chart[1] + 4, R.timber[1]);
    // Ledger desk legs under the live desk top.
    const ledger = HARBOR_CUTAWAY_PROFILE.slots.find((slot) => slot.id === 'ledgerDesk').at;
    for (const lx of [ledger[0] - 3, ledger[0] + 2]) {
        for (let y = ledger[1] + 3; y <= ledger[1] + 4; y++) legs.set(lx, y, R.timber[0]);
    }
    layer.outline(legs, INK);
    layer.stamp(legs);
    // A chart crate of rolled maps against the right wall.
    const crate = new PixelLayer(layer.width, layer.height, layer.clip);
    for (let y = 107; y <= 114; y++) {
        for (let x = 159; x <= 165; x++) {
            const plank = (y - 107) % 3 === 2;
            crate.set(x, y, x === 159 ? R.timber[3] : (plank ? R.timber[1] : R.timber[2]));
        }
    }
    for (const [x, top] of [[160, 104], [162, 103], [164, 105]]) {
        for (let y = top; y < 107; y++) crate.set(x, y, y === top ? R.sand[4] : R.sand[3]);
    }
    crate.set(161, 105, R.shallowWater[1]);
    layer.outline(crate, INK);
    layer.stamp(crate);
}

function paintHarborForeground(layer, aperture, mask, base) {
    const { width, height } = base;
    const { minX, maxX } = maskBounds(mask, width, height);
    for (let x = minX; x <= maxX; x++) {
        const col = cutColumn(mask, width, height, x);
        // The hood's tie beam overhead.
        layer.set(x, col.top, INK);
        layer.set(x, col.top + 1, R.timber[1]);
        // The sill plate the loft floor rests on.
        layer.set(x, col.bottom - 2, R.timber[3]);
        layer.set(x, col.bottom - 1, R.timber[1]);
        layer.set(x, col.bottom, INK);
    }
    // Near corner posts.
    for (const [x, color] of [[minX, INK], [minX + 1, R.timber[1]], [minX + 2, R.timber[2]], [maxX - 1, R.timber[1]], [maxX, INK]]) {
        const col = cutColumn(mask, width, height, x);
        for (let y = col.top; y <= col.bottom; y++) layer.set(x, y, color);
    }
}

export function bakeHarborCutaway({ base = readPng(join(HARBOR_DIR, 'base.png')) } = {}) {
    const aperture = getBuildingApertureProfile('harbor');
    if (!aperture) return { errors: ['registry: harbor has no aperture profile'], layers: {} };
    const errors = [];
    const notes = [];
    const stack = normalizeApertureLayers(aperture.layers);
    if (!stack?.hasRoof) errors.push('registry: harbor aperture must be a 4-layer lifted-roof cutaway');
    const mask = cutawayMask(aperture.cut, base);

    const roof = cropRoof(base, mask);
    const ap = new PixelLayer(base.width, base.height, mask);
    paintHarborAperture(ap, aperture, mask, base);
    const interior = new PixelLayer(base.width, base.height, mask);
    paintHarborInterior(interior);
    const foreground = new PixelLayer(base.width, base.height, mask);
    paintHarborForeground(foreground, aperture, mask, base);

    let uncovered = 0;
    for (let i = 0; i < mask.length; i++) if (mask[i] && ap.data[i * 4 + 3] === 0) uncovered++;
    if (uncovered) errors.push(`aperture: ${uncovered} cut texel(s) left uncovered`);
    const dims = { width: base.width, height: base.height, mask };
    errors.push(...inspectRoofLayer(roof, base, mask));
    errors.push(...inspectAuthoredLayer('aperture', ap, dims));
    errors.push(...inspectAuthoredLayer('interior', interior, dims));
    errors.push(...inspectAuthoredLayer('foreground', foreground, dims));
    errors.push(...inspectSlots(aperture, ap, aperture.slots));
    notes.push(`cut texels ${mask.reduce((sum, v) => sum + v, 0)}, 2 slots, signal rack at [${HARBOR_CUTAWAY_PROFILE.signalRack.at}]`);
    return {
        errors,
        notes,
        mask,
        layers: {
            [stack?.roof || 'roof']: roof,
            [stack?.aperture || 'aperture']: ap,
            [stack?.interior || 'interior']: interior,
            [stack?.foreground || 'foreground']: foreground,
        },
    };
}

const USAGE = [
    'Usage: node scripts/sprites/bake-cutaway-harbor.mjs [--check] [--out=<dir>] [--help]',
    '',
    'Bakes building.harbor/{roof,aperture,interior,foreground}.png (384x284, anchor [131,154]):',
    'the Spec 04 §5.3 Chart Loft lifted-roof cutaway. 0 PixelLab generations.',
    '',
    '  --check      Verify the on-disk layers match the deterministic bake and its invariants.',
    '  --out=<dir>  Write (or check) the layers in <dir> instead of the sprite folder.',
].join('\n');

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
    process.exit(runCutawayBakerCli({ label: 'cutaway:harbor', dir: HARBOR_DIR, bake: bakeHarborCutaway, usage: USAGE }));
}
