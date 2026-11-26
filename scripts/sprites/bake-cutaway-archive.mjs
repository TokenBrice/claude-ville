#!/usr/bin/env node
// Wave 5-B (Spec 03 §1.2 item 5.3, Spec 04 §5.2, D6) — Archive lifted-roof
// cutaway baker: the five Repo Directory Bays and the Compaction Shelf.
//
// Writes four 336 x 240 layers beside `building.archive/base.png` (anchor
// [167, 182]), pixel-registered with the base and confined to the long lancet
// wall's cut parallelogram (`x 88..200`, slope +0.5,
// `BUILDING_VISUAL_REGISTRY.archive.aperture`):
//
//   roof.png        base.png's own nave wall, aisle roof and clerestory texels
//                   over the cut, byte-exact (lifted on a 4 x 4 Bayer order).
//   aperture.png    the nave's back wall (coursed ashlar, pilasters between the
//                   bays, three far lancets, the Loom of Days hooks), five oak
//                   Repo Directory Bay bookcases against it, the Compaction
//                   Shelf cabinet on the floor before bay 0 (sheared on the
//                   wall's +0.5 slope, inside the cut), and the flagstone
//                   floor every bay slot stands on.
//   interior.png    the five oak lecterns (cross foot, slender post, sloped
//                   book-rest with an open folio), one per bay at the slot 12
//                   texels toward the viewer from its ground lancet, drawn
//                   after the readers so each lectern occludes their legs.
//   foreground.png  the sawn sill along the wall's base line, the buttress
//                   stubs and feet framing the bays, and the end jambs.
//
// Runtime layering (BuildingSprite): aperture -> drawArchiveCutaway (Loom
// frame, shelf spines, numeral) -> readers -> interior -> foreground -> roof.
// The bookcases live in `aperture` so the live spines and the Loom hang over
// them and every reader stands in front of them.
//
// Usage:
//   node scripts/sprites/bake-cutaway-archive.mjs           # write the 4 layers
//   node scripts/sprites/bake-cutaway-archive.mjs --check   # verify on-disk bytes + invariants
//   node scripts/sprites/bake-cutaway-archive.mjs --help

import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeApertureLayers } from '../../claudeville/src/presentation/character-mode/BuildingApertureModel.js';
import { ARCHIVE_CUTAWAY_PROFILE, archiveShelfGeometry } from '../../claudeville/src/presentation/character-mode/BuildingCutaways.js';
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
    paintCoursedWall,
    paintFlagstones,
    readPng,
    runCutawayBakerCli,
} from './bake-cutaway-command.mjs';

export const ARCHIVE_DIR = join(BUILDINGS_DIR, 'building.archive');

// The wall's own base line (the plinth foot between the buttresses), measured
// on base.png: y = 176 at x 88, rising with the wall at +0.5.
export const ARCHIVE_WALL_BASE = Object.freeze({ at: Object.freeze([88, 176]), slope: 0.5 });
// Bookcase heights per bay: bays 1, 2 and 3 stand under the Loom of Days.
export const ARCHIVE_BOOKCASE_HEIGHTS = Object.freeze([16, 12, 12, 12, 16]);
// Far-wall lancets (sprite x), clear of the Loom space and the bookcases.
export const ARCHIVE_FAR_LANCETS = Object.freeze([95, 110, 182]);

const SPINES = Object.freeze([
    R.clothCrimson[0], R.clothCrimson[1], R.clothOchre[0], R.slate[2],
    R.timber[3], R.sand[1], R.grass[1], R.roofSlate[4], R.clothOchre[1],
]);

function wallBaseY(x) {
    return ARCHIVE_WALL_BASE.at[1] + ARCHIVE_WALL_BASE.slope * (x - ARCHIVE_WALL_BASE.at[0]);
}

export function bayCentre(bay) {
    return [Math.round(bay.at[0]), Math.round(bay.at[1])];
}

/** Bookcase box per bay: columns, and per column its bottom/top rows. */
export function archiveBookcases(aperture) {
    return ARCHIVE_CUTAWAY_PROFILE.bays.map((bay, index) => {
        const [cx] = bayCentre(bay);
        const h = ARCHIVE_BOOKCASE_HEIGHTS[index];
        const columns = [];
        for (let x = cx - 6; x <= cx + 6; x++) {
            const bottom = Math.ceil(apertureFloorY(aperture, x)) + 1;
            columns.push({ x, bottom, top: bottom - h + 1 });
        }
        return { index, cx, h, columns };
    });
}

function paintBookcase(layer, bookcase) {
    const body = new PixelLayer(layer.width, layer.height, layer.clip);
    const first = bookcase.columns[0].x;
    const last = bookcase.columns[bookcase.columns.length - 1].x;
    for (const { x, top, bottom } of bookcase.columns) {
        const side = x === first || x === last;
        for (let y = top; y <= bottom; y++) {
            const rel = y - top;
            let color;
            if (side) color = x === first ? R.timber[2] : R.timber[1];
            else if (rel === 0) color = R.timber[3];
            else if (y === bottom) color = R.timber[1];
            else if (rel % 4 === 0) color = R.timber[2];
            else {
                const shelf = Math.floor(rel / 4);
                const pick = hash2(x, shelf, 40 + bookcase.index);
                // Book tops leave a dark gap above some spines.
                color = (rel % 4 === 1 && pick % 3 === 0) ? R.timber[0] : SPINES[pick % SPINES.length];
            }
            body.set(x, y, color);
        }
    }
    layer.outline(body, INK);
    layer.stamp(body);
}

function paintFarLancet(layer, x, bottom) {
    const top = bottom - 15;
    const glass = new PixelLayer(layer.width, layer.height, layer.clip);
    for (let y = top; y <= bottom; y++) {
        for (let dx = -1; dx <= 1; dx++) {
            // Pointed head: the outer columns start two rows lower.
            if (dx !== 0 && y < top + 2) continue;
            const color = y < top + 4 ? R.slate[3] : (dx === 0 ? R.slate[2] : R.slate[1]);
            glass.set(x + dx, y, color);
        }
    }
    layer.outline(glass, INK);
    layer.stamp(glass);
    layer.hline(bottom + 2, x - 2, x + 2, R.ashlar[5]);
}

function paintArchiveAperture(layer, aperture, mask, base) {
    const { width, height } = base;
    const { minX, maxX } = maskBounds(mask, width, height);
    const span = (x) => cutColumn(mask, width, height, x);
    const floorRow = (x) => Math.ceil(apertureFloorY(aperture, x));

    paintCoursedWall(layer, {
        x0: minX,
        x1: maxX,
        top: (x) => span(x).top,
        bottom: (x) => floorRow(x) - 1,
        slope: aperture.cut.slope,
        originX: aperture.cut.x0,
        originY: aperture.cut.top,
        rows: 6,
        joint: 10,
        base: R.ashlar[3],
        mortar: R.ashlar[2],
        lit: R.ashlar[4],
        seed: 21,
    });
    paintFlagstones(layer, {
        x0: minX,
        x1: maxX,
        top: (x) => floorRow(x),
        bottom: (x) => span(x).bottom,
        slope: aperture.cut.slope,
        crossSlope: -0.5,
        originX: aperture.cut.x0,
        originY: aperture.floor.at[1],
        rows: 5,
        joint: 12,
        base: R.plaza[1],
        mortar: R.plaza[0],
        lit: R.plaza[2],
        seed: 23,
    });
    for (let x = minX; x <= maxX; x++) {
        const col = span(x);
        // The nave roof's wall plate and rafter feet seen from inside.
        layer.set(x, col.top, R.timber[0]);
        layer.set(x, col.top + 1, R.timber[0]);
        layer.set(x, col.top + 2, R.timber[1]);
        // Shadowed base course where the back wall meets the floor.
        layer.set(x, floorRow(x) - 1, R.ashlar[1]);
    }
    // Pilasters between the five bays.
    const bays = ARCHIVE_CUTAWAY_PROFILE.bays.map(bayCentre);
    const pilasters = [];
    for (let i = 0; i < bays.length; i++) {
        const next = i + 1 < bays.length ? bays[i + 1][0] : bays[i][0] + 22;
        pilasters.push(Math.round((bays[i][0] + next) / 2));
    }
    for (const px of pilasters) {
        for (let x = px; x <= px + 1; x++) {
            const col = span(x);
            if (!col) continue;
            for (let y = col.top + 3; y < floorRow(x) - 1; y++) layer.set(x, y, x === px ? R.ashlar[4] : R.ashlar[2]);
        }
    }
    // The Loom of Days wall space: two iron hooks above its (sheared) frame.
    const loomWall = ARCHIVE_CUTAWAY_PROFILE.loomWall;
    const loom = loomWall.destRect;
    for (const hx of [loom.x + 3, loom.x + loom.width - 4]) {
        const hy = loom.y + Math.round((loomWall.slope || 0) * (hx - loom.x));
        layer.set(hx, hy - 3, INK);
        layer.set(hx, hy - 2, R.timber[0]);
    }
    // Five oak Repo Directory Bays against the back wall.
    const bookcases = archiveBookcases(aperture);
    // Far-wall lancets above the bookcases, clear of the Loom space.
    for (const lx of ARCHIVE_FAR_LANCETS) {
        let bottom = floorRow(lx) - 3;
        for (const bookcase of bookcases) {
            for (const column of bookcase.columns) {
                if (Math.abs(column.x - lx) <= 2) bottom = Math.min(bottom, column.top - 4);
            }
        }
        paintFarLancet(layer, lx, bottom);
    }
    for (const bookcase of bookcases) paintBookcase(layer, bookcase);
    // The Compaction Shelf's cabinet on the floor in front of bay 0, sheared
    // on the nave wall's +0.5 slope like the live spines it holds: a dark
    // back panel behind the spines, the shelf board, then a drawer front.
    const shelf = ARCHIVE_CUTAWAY_PROFILE.compactionShelf;
    const shelfGeometry = archiveShelfGeometry(shelf);
    const cabinet = new PixelLayer(layer.width, layer.height, layer.clip);
    for (let x = shelfGeometry.boardX0; x <= shelfGeometry.boardX1; x++) {
        const y0 = shelf.at[1] + shelfGeometry.rise(x);
        for (let rel = -1; rel <= shelf.spineHeight + 8; rel++) {
            let color;
            if (rel < shelf.spineHeight) color = R.timber[0];
            else if (rel < shelf.spineHeight + 3) color = R.timber[2];
            else if (rel === shelf.spineHeight + 5) color = R.timber[1];
            else color = (x === shelfGeometry.boardX0 ? R.timber[3] : R.timber[2]);
            cabinet.set(x, y0 + rel, color);
        }
    }
    for (let x = shelfGeometry.boardX0 + 5; x <= shelfGeometry.boardX1; x += 10) {
        cabinet.set(x, shelf.at[1] + shelfGeometry.rise(x) + shelf.spineHeight + 7, R.trimGold[0]);
    }
    layer.outline(cabinet, INK);
    layer.stamp(cabinet);
    return { bookcases, pilasters };
}

// A reading lectern (W5 Fix-B, Fable P2): a cross foot, a slender oak post,
// and a sloped book-rest (higher at the back) carrying an open parchment
// folio with a crimson ribbon — a stand, not a stool.
function paintLectern(layer, cx, cy) {
    const body = new PixelLayer(layer.width, layer.height, layer.clip);
    // Cross foot.
    for (let x = cx - 3; x <= cx + 3; x++) body.set(x, cy, x === cx - 3 ? R.timber[2] : R.timber[1]);
    body.set(cx - 1, cy - 1, R.timber[1]);
    body.set(cx, cy - 1, R.timber[0]);
    // Slender post.
    for (let y = cy - 7; y <= cy - 2; y++) {
        body.set(cx - 1, y, R.timber[2]);
        body.set(cx, y, R.timber[1]);
    }
    // Sloped book-rest: its back edge one row higher than its front lip.
    for (let x = cx - 4; x <= cx + 3; x++) {
        const back = x <= cx - 1 ? cy - 10 : cy - 9;
        body.set(x, back, R.timber[3]);
        body.set(x, back + 1, R.timber[2]);
        if (back + 2 <= cy - 8) body.set(x, back + 2, R.timber[1]);
    }
    // Open folio: two parchment pages, a dark gutter, a ribbon over the lip.
    for (let x = cx - 3; x <= cx + 2; x++) {
        if (x === cx) continue;
        const top = x <= cx - 1 ? cy - 12 : cy - 11;
        body.set(x, top, x < cx ? R.sand[4] : R.sand[3]);
        body.set(x, top + 1, x < cx ? R.sand[3] : R.sand[2]);
    }
    body.set(cx, cy - 11, R.timber[0]);
    body.set(cx, cy - 10, R.clothCrimson[1]);
    body.set(cx, cy - 9, R.clothCrimson[0]);
    layer.outline(body, INK);
    layer.stamp(body);
}

function paintArchiveInterior(layer) {
    for (const bay of ARCHIVE_CUTAWAY_PROFILE.bays) {
        const [cx, cy] = bayCentre({ at: bay.lecternAt });
        paintLectern(layer, cx, cy);
    }
}

function paintArchiveForeground(layer, aperture, mask, base) {
    const { width, height } = base;
    const { minX, maxX } = maskBounds(mask, width, height);
    for (let x = minX; x <= maxX; x++) {
        const col = cutColumn(mask, width, height, x);
        const sill = Math.min(col.bottom, Math.round(wallBaseY(x)));
        // Buttress foot below the wall's base line.
        for (let y = sill + 1; y <= col.bottom; y++) layer.set(x, y, y === col.bottom ? INK : R.ashlar[4]);
        // The sawn sill.
        layer.set(x, sill, col.bottom > sill ? R.ashlar[5] : INK);
        layer.set(x, sill - 1, R.ashlar[5]);
        layer.set(x, sill - 2, R.ashlar[7]);
    }
    // Buttress stubs over each foot: the near nave wall framing the bays.
    const feet = [];
    for (let x = minX; x <= maxX; x++) {
        const col = cutColumn(mask, width, height, x);
        if (col.bottom - Math.round(wallBaseY(x)) >= 3) feet.push(x);
    }
    const runs = [];
    for (const x of feet) {
        const run = runs[runs.length - 1];
        if (run && x === run[1] + 1) run[1] = x;
        else runs.push([x, x]);
    }
    for (const [x0, x1] of runs) {
        if (x1 - x0 < 2) continue;
        const stub = new PixelLayer(layer.width, layer.height, layer.clip);
        for (let x = x0 + 1; x <= x1 - 1; x++) {
            const sill = Math.round(wallBaseY(x));
            for (let y = sill - 9; y <= sill - 3; y++) {
                stub.set(x, y, y === sill - 9 ? R.ashlar[7] : (x === x0 + 1 ? R.ashlar[6] : R.ashlar[5]));
            }
        }
        layer.outline(stub, INK);
        layer.stamp(stub);
    }
    // End jambs: the wall's sawn thickness at both ends of the cut.
    for (const [x, color] of [[minX, INK], [minX + 1, R.ashlar[6]], [maxX - 1, R.ashlar[6]], [maxX, INK]]) {
        const col = cutColumn(mask, width, height, x);
        for (let y = col.top; y <= col.bottom; y++) layer.set(x, y, color);
    }
    return runs;
}

export function bakeArchiveCutaway({ base = readPng(join(ARCHIVE_DIR, 'base.png')) } = {}) {
    const aperture = getBuildingApertureProfile('archive');
    if (!aperture) return { errors: ['registry: archive has no aperture profile'], layers: {} };
    const errors = [];
    const notes = [];
    const stack = normalizeApertureLayers(aperture.layers);
    if (!stack?.hasRoof) errors.push('registry: archive aperture must be a 4-layer lifted-roof cutaway');
    const mask = cutawayMask(aperture.cut, base);

    const roof = cropRoof(base, mask);
    const ap = new PixelLayer(base.width, base.height, mask);
    const { bookcases } = paintArchiveAperture(ap, aperture, mask, base);
    const interior = new PixelLayer(base.width, base.height, mask);
    paintArchiveInterior(interior);
    const foreground = new PixelLayer(base.width, base.height, mask);
    const buttresses = paintArchiveForeground(foreground, aperture, mask, base);

    let uncovered = 0;
    for (let i = 0; i < mask.length; i++) if (mask[i] && ap.data[i * 4 + 3] === 0) uncovered++;
    if (uncovered) errors.push(`aperture: ${uncovered} cut texel(s) left uncovered`);
    const dims = { width: base.width, height: base.height, mask };
    errors.push(...inspectRoofLayer(roof, base, mask));
    errors.push(...inspectAuthoredLayer('aperture', ap, dims));
    errors.push(...inspectAuthoredLayer('interior', interior, dims));
    errors.push(...inspectAuthoredLayer('foreground', foreground, dims));
    // Every bay slot (and its lectern) inside the cut and on the floor.
    errors.push(...inspectSlots(aperture, ap, aperture.slots));
    errors.push(...inspectSlots(aperture, ap, ARCHIVE_CUTAWAY_PROFILE.bays.map((bay) => ({ id: `lectern-${bay.index}`, at: bay.lecternAt }))));
    // Readers (24 texels tall) stand clear of their bookcase.
    for (const bookcase of bookcases) {
        const bay = ARCHIVE_CUTAWAY_PROFILE.bays[bookcase.index];
        const head = bay.at[1] - aperture.occupant.h;
        const column = bookcase.columns.find((c) => c.x === Math.round(bay.at[0]));
        if (!(column.bottom < head)) errors.push(`bay ${bookcase.index}: bookcase bottom ${column.bottom} meets the reader's head (${head})`);
    }
    notes.push(`cut texels ${mask.reduce((sum, v) => sum + v, 0)}, 5 bays, ${buttresses.length} buttress feet`);
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
    'Usage: node scripts/sprites/bake-cutaway-archive.mjs [--check] [--out=<dir>] [--help]',
    '',
    'Bakes building.archive/{roof,aperture,interior,foreground}.png (336x240, anchor [167,182]):',
    'the Spec 04 §5.2 Repo Directory Bays lifted-roof cutaway. 0 PixelLab generations.',
    '',
    '  --check      Verify the on-disk layers match the deterministic bake and its invariants.',
    '  --out=<dir>  Write (or check) the layers in <dir> instead of the sprite folder.',
].join('\n');

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
    process.exit(runCutawayBakerCli({ label: 'cutaway:archive', dir: ARCHIVE_DIR, bake: bakeArchiveCutaway, usage: USAGE }));
}
