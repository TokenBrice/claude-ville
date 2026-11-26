#!/usr/bin/env node
// Wave 5-B (Spec 03 §1.2 item 5.4, Spec 04 §5.3, D6) — Harbor lifted-roof
// cutaway baker: the Chart Loft.
//
// Writes four 384 x 284 layers beside `building.harbor/base.png` (anchor
// [131, 154]), pixel-registered with the base and confined to the oriel's
// upper storey: a parallelogram sheared on the oriel wall's own slope (-0.5)
// that holds the whole slate hood (`x 133..167`, wall rows 90..122,
// `BUILDING_VISUAL_REGISTRY.harbor.aperture`):
//
//   roof.png        base.png's own slate hood, bay window and timbering over
//                   the cut, byte-exact (lifted on a 4 x 4 Bayer order).
//   aperture.png    the counting-house wall (plaster between oak studs and a
//                   brace, a small leaded window and the signal-rack bracket)
//                   over a planked loft floor, every course on the slope.
//   interior.png    the drafting chart table's trestles, the ledger desk's
//                   legs and a bin of rolled charts, drawn after the
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
import { getBuildingApertureProfile } from '../../claudeville/src/presentation/character-mode/BuildingVisualRegistry.js';
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
// Oak studs of the counting-house wall (sprite x; vertical on the sheared wall).
export const HARBOR_STUDS = Object.freeze([139, 150, 161]);

// W5 Fix-B (Fable P1-1) — the loft is sheared on the oriel's wall slope:
// a texel's wall row is `y - slope * (x - x0)` (constant along the wall).
const CUT = HARBOR_CUTAWAY_PROFILE.cut;
export const wallRow = (x, y) => y - CUT.slope * (x - CUT.x0);
export const rowY = (x, row) => Math.round(row + CUT.slope * (x - CUT.x0));
export const HARBOR_ROWS = Object.freeze({
    plate: CUT.top + 1,
    floor: HARBOR_CUTAWAY_PROFILE.floor.at[1],
    sill: CUT.bottom - 2,
});

function paintHarborAperture(layer, aperture, mask, base) {
    const { width, height } = base;
    const { minX, maxX } = maskBounds(mask, width, height);
    const floorRow = HARBOR_ROWS.floor;
    for (let x = minX; x <= maxX; x++) {
        const col = cutColumn(mask, width, height, x);
        if (!col) continue;
        for (let y = col.top; y <= col.bottom; y++) {
            const r = wallRow(x, y);
            let color;
            if (r < HARBOR_ROWS.plate + 0.5) color = R.timber[0];
            else if (r < HARBOR_ROWS.plate + 1.5) color = R.timber[1];
            else if (r < floorRow - 1) {
                // Lime plaster, faintly mottled.
                color = hash2(x, Math.floor(r), 7) % 9 === 0 ? R.ashlar[6] : R.ashlar[5];
            } else if (r < floorRow) color = R.timber[0];
            else {
                // Planks run along the wall; seams every three rows, staggered butt joints.
                const rel = Math.floor(r - floorRow);
                const plank = Math.floor(rel / 3);
                const seam = rel % 3 === 2;
                const butt = ((x - minX + plank * 7) % 13) === 0;
                color = seam || butt ? R.timber[1] : (hash2(plank, Math.floor((x - minX + plank * 7) / 13), 9) % 4 === 0 ? R.timber[3] : R.timber[2]);
            }
            layer.set(x, y, color);
        }
    }
    // Oak studs (vertical) and one brace climbing the wall between the first two.
    for (const sx of HARBOR_STUDS) {
        for (let y = rowY(sx, HARBOR_ROWS.plate + 2); y < rowY(sx, floorRow - 1); y++) {
            layer.set(sx, y, R.timber[1]);
            layer.set(sx + 1, y, R.timber[0]);
        }
    }
    for (let i = 0; i <= 8; i++) {
        const x = HARBOR_STUDS[0] + 2 + i;
        layer.set(x, rowY(x, floorRow - 3) - i, R.timber[1]);
    }
    // A small leaded window between the second and third studs, below the rack's stamp.
    const window = new PixelLayer(layer.width, layer.height, layer.clip);
    for (let x = 153; x <= 157; x++) {
        for (let r = 104; r <= 108; r++) window.set(x, rowY(x, r), (x === 155 || r === 106) ? R.slate[3] : R.slate[1]);
    }
    layer.outline(window, INK);
    layer.stamp(window);
    // Signal-rack bracket on the wall (the live beam hangs from it).
    const rack = HARBOR_CUTAWAY_PROFILE.signalRack.at;
    layer.set(rack[0] - 1, rack[1] - 2, INK);
    layer.set(rack[0] - 1, rack[1] - 1, R.timber[0]);
    layer.set(rack[0] - 2, rack[1], R.timber[0]);
}

function paintHarborInterior(layer) {
    const floorRow = HARBOR_ROWS.floor;
    const legs = new PixelLayer(layer.width, layer.height, layer.clip);
    // Chart table trestles under the live sheared top.
    const chart = HARBOR_CUTAWAY_PROFILE.chartTable;
    const chartTopRow = wallRow(chart.at[0], chart.at[1]);
    for (const lx of [chart.at[0] - Math.floor(chart.width / 2) + 1, chart.at[0] + Math.ceil(chart.width / 2) - 2]) {
        for (let r = chartTopRow + chart.depth; r <= chartTopRow + chart.depth + 4; r++) legs.set(lx, rowY(lx, r), R.timber[0]);
    }
    // Ledger desk legs under the live slant top.
    const ledger = HARBOR_CUTAWAY_PROFILE.ledgerDesk;
    const ledgerRow = wallRow(ledger.at[0], ledger.at[1]);
    for (const lx of [ledger.at[0] - 2, ledger.at[0] + 2]) {
        for (let r = ledgerRow + ledger.depth; r <= floorRow + 3; r++) legs.set(lx, rowY(lx, r), R.timber[0]);
    }
    layer.outline(legs, INK);
    layer.stamp(legs);
    // Rolled charts standing in a bin against the right end of the wall.
    const bin = new PixelLayer(layer.width, layer.height, layer.clip);
    for (let x = 163; x <= 165; x++) {
        for (let r = floorRow - 2; r <= floorRow + 2; r++) bin.set(x, rowY(x, r), r === floorRow - 2 ? R.timber[3] : R.timber[2]);
    }
    for (const [x, tall] of [[163, 4], [165, 3]]) {
        for (let r = floorRow - 2 - tall; r < floorRow - 2; r++) bin.set(x, rowY(x, r), r === floorRow - 2 - tall ? R.sand[4] : R.sand[3]);
    }
    layer.outline(bin, INK);
    layer.stamp(bin);
}

function paintHarborForeground(layer, aperture, mask, base) {
    const { width, height } = base;
    const { minX, maxX } = maskBounds(mask, width, height);
    for (let x = minX; x <= maxX; x++) {
        const col = cutColumn(mask, width, height, x);
        if (!col) continue;
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
        if (!col) continue;
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
    notes.push(`cut texels ${mask.reduce((sum, v) => sum + v, 0)} (sheared ${CUT.slope}), 2 slots, signal rack at [${HARBOR_CUTAWAY_PROFILE.signalRack.at}]`);
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
