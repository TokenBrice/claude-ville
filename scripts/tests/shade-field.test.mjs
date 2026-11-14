import test from 'node:test';
import assert from 'node:assert/strict';

import {
    SHADE_CEILING_STEP,
    SHADE_CELL_H,
    SHADE_CELL_W,
    SHADE_TIP_MIN_PX,
    SHADE_TIP_SHARE,
    buildShadeField,
    convexHull,
    createShadeFieldBuild,
    facet,
    latheProfile,
    latheStamp,
    masonryFacets,
    massingFacets,
    paintShadeCells,
    shadeBayer,
    shadeCeilingAt,
    shadeCoverageAt,
    shadeFieldRect,
    shadeFieldTexture,
    shadeGroundAt,
    shadeLitShareAt,
    shadePointAt,
    solidFacets,
} from '../../claudeville/src/presentation/character-mode/ShadeField.js';
import { BUILDING_DEFS } from '../../claudeville/src/config/buildings.js';
import { LANDMARK_MASSING } from '../../claudeville/src/config/landmarkMassing.js';
import { VILLAGE_WALL_ROUTES } from '../../claudeville/src/config/townPlan.js';
import { footprintFieldRect } from '../../claudeville/src/presentation/character-mode/FootprintField.js';
import { buildingCenterToWorld } from '../../claudeville/src/presentation/character-mode/Projection.js';

// A small field in plain world px: 2x1 cells from (0, 0).
const RECT = Object.freeze({ originX: 0, originY: 0, cellW: SHADE_CELL_W, cellH: SHADE_CELL_H, cols: 200, rows: 200 });
const plain = (tx, ty) => [tx, ty];
const box = (x0, y0, x1, y1, top) => solidFacets({ kind: 'box', at: [x0, y0, x1, y1], top }, plain);

test('the field covers the footprint rect in 2x1 world-px cells', () => {
    const rect = shadeFieldRect();
    const footprint = footprintFieldRect();
    assert.equal(rect.originX, footprint.originX);
    assert.equal(rect.originY, footprint.originY);
    assert.equal(rect.cols * rect.cellW, footprint.width * footprint.cell);
    assert.equal(rect.rows * rect.cellH, footprint.height * footprint.cell);
    assert.deepEqual([rect.cellW, rect.cellH], [2, 1]);
});

test('a box holds its own top under itself and a ceiling falling one px per px of sweep', () => {
    // 40 px tall, shadow 2 world px per px of height, straight along +x.
    const field = buildShadeField({ rect: RECT, sweep: { sx: 2, sy: 0 }, facets: box(20, 40, 60, 80, 40) });
    assert.equal(shadeCeilingAt(field, 40, 60), 40, 'under the box');
    // 21 px past the far wall (x = 60): the ray climbs 21 / 2 px before it meets the box.
    assert.equal(shadeCeilingAt(field, 81, 60), Math.round(40 - 21 / 2));
    assert.equal(shadeCeilingAt(field, 60 + 40 * 2 + 3, 60), 0, 'past the tip');
    assert.equal(shadeCeilingAt(field, 15, 60), 0, 'up-sun of the box');
    assert.equal(shadeCeilingAt(field, 81, 30), 0, 'beside the shadow');
    // The receiver test: a point 10 px up is shaded while the ceiling clears it.
    assert.equal(shadePointAt(field, 81, 60, 10), true);
    assert.equal(shadePointAt(field, 81, 60, 35), false);
    assert.equal(shadeLitShareAt(field, 40, 60, 80), 0.5, 'half of an 80-px air column stands in the sun');
    assert.equal(shadeLitShareAt(field, 15, 60, 80), 1);
});

test('the ceiling byte counts 2 px, so a mass up to 510 px keeps its top', () => {
    const field = buildShadeField({ rect: RECT, sweep: { sx: 0.1, sy: 0 }, facets: box(20, 40, 60, 80, 320) });
    assert.equal(shadeCeilingAt(field, 40, 60), 320);
    assert.equal(field.data[(60 * RECT.cols + 20) * 2], 320 / SHADE_CEILING_STEP);
    assert.equal(shadeFieldTexture(field).ceilingStep, SHADE_CEILING_STEP);
    assert.equal(shadeCoverageAt(field, 60 + 20, 60), 1, 'the ground rule never saturates with height');
});

test('the sweep takes the shadow with it in both axes', () => {
    const field = buildShadeField({ rect: RECT, sweep: { sx: 1, sy: 0.5 }, facets: box(40, 40, 60, 60, 30) });
    // The far corner (60, 60) throws its top 30 px along the sweep.
    assert.ok(shadeCeilingAt(field, 60 + 20, 60 + 10) >= 9);
    assert.equal(shadeCeilingAt(field, 60 + 33, 60 + 16), 0);
    assert.equal(shadeCeilingAt(field, 60 + 20, 40 - 4), 0, 'no shadow up-sweep in y');
});

test('a gable is exact: the ridge height under the ridge, the eave at the eave', () => {
    const facets = solidFacets({ kind: 'gable', at: [20, 20, 80, 60], eave: 20, ridge: 40, axis: 'x' }, plain);
    assert.equal(facets.length, 2);
    const field = buildShadeField({ rect: RECT, sweep: { sx: 0, sy: 0 }, facets });
    assert.equal(shadeCeilingAt(field, 50, 40.5), 40, 'ridge');
    assert.ok(Math.abs(shadeCeilingAt(field, 50, 30.5) - 30) <= 1, 'half way up the pitch');
    assert.ok(shadeCeilingAt(field, 50, 20.5) <= 21, 'eave');
    // Swept across the ridge, the ceiling behind it is the ridge's, falling with distance.
    const swept = buildShadeField({ rect: RECT, sweep: { sx: 0, sy: 1 }, facets });
    assert.ok(Math.abs(shadeCeilingAt(swept, 50, 50.5) - 30) <= 1, 'the lee pitch lies in the ridge shadow');
    assert.ok(Math.abs(shadeCeilingAt(swept, 50, 70.5) - 10) <= 1, 'past the lee eave the ridge still shades');
});

test('overlapping shadows take the maximum, never a sum', () => {
    const tall = box(20, 40, 40, 80, 60);
    const low = box(60, 40, 80, 80, 20);
    const both = buildShadeField({ rect: RECT, sweep: { sx: 2, sy: 0 }, facets: [...tall, ...low] });
    const tallOnly = buildShadeField({ rect: RECT, sweep: { sx: 2, sy: 0 }, facets: tall });
    const lowOnly = buildShadeField({ rect: RECT, sweep: { sx: 2, sy: 0 }, facets: low });
    for (const x of [45, 70, 90, 110, 150]) {
        const expected = Math.max(shadeCeilingAt(tallOnly, x, 60), shadeCeilingAt(lowOnly, x, 60));
        assert.equal(shadeCeilingAt(both, x, 60), expected, `ceiling at x ${x}`);
        assert.equal(shadeCoverageAt(both, x, 60), Math.max(shadeCoverageAt(tallOnly, x, 60), shadeCoverageAt(lowOnly, x, 60)));
    }
    assert.equal(shadeCoverageAt(both, 70, 60), 1, 'solid where either is solid');
});

test('ground coverage is solid in the shadow and dissolves over its tip', () => {
    const top = 80;
    const field = buildShadeField({ rect: RECT, sweep: { sx: 1, sy: 0 }, facets: box(20, 40, 40, 80, top) });
    const tip = Math.max(SHADE_TIP_MIN_PX, SHADE_TIP_SHARE * top);
    assert.equal(shadeCoverageAt(field, 41 + 10, 60), 1);
    // Ceiling `tip / 2` px: half coverage, drawn as an ordered dither.
    const half = shadeCoverageAt(field, 40 + top - tip / 2 + 1, 60);
    assert.ok(half > 0.35 && half < 0.65, `half coverage in the tip, got ${half}`);
    assert.equal(shadeCoverageAt(field, 40 + top + 4, 60), 0);
    let shaded = 0;
    let cells = 0;
    for (let x = 40 + top - tip; x < 40 + top; x += SHADE_CELL_W) {
        for (let y = 44; y < 76; y++) {
            cells++;
            if (shadeGroundAt(field, x, y)) shaded++;
        }
    }
    assert.ok(shaded > cells * 0.3 && shaded < cells * 0.7, 'the tip is a broken course, neither solid nor empty');
    // The rule itself: coverage against the cell's Bayer threshold.
    const col = Math.floor(100 / SHADE_CELL_W);
    assert.equal(shadeGroundAt(field, 100, 60), field.data[(60 * RECT.cols + col) * 2 + 1] > shadeBayer(col, 60) * 255);
    assert.ok(shadeBayer(0, 0) > 0 && shadeBayer(3, 3) < 1);
});

test('a build spread over slices is the build run at once', () => {
    const facets = [
        ...box(20, 40, 60, 80, 50),
        ...solidFacets({ kind: 'cone', centre: [120, 100], radius: 20, eave: 30, apex: 70 }, plain),
        ...solidFacets({ kind: 'dome', centre: [60, 150], radius: 24, eave: 20, apex: 44 }, plain),
    ];
    const profile = latheProfile(new Uint8Array(16 * 40).fill(255), 16, 40, 39);
    const lathes = [{ x: 150, y: 60, profile, key: 'post' }, { x: 100, y: 30, profile, key: 'post' }];
    const options = { rect: RECT, sweep: { sx: 1.5, sy: 0.4 }, facets, lathes };
    const whole = buildShadeField(options);
    const job = createShadeFieldBuild(options);
    let steps = 0;
    while (!job.step(0)) steps++;
    assert.ok(steps > 3, 'a zero budget yields between rows');
    assert.equal(job.done, true);
    assert.deepEqual(job.field.data, whole.data);
    assert.deepEqual(job.field.bounds, whole.bounds);
    // A reused buffer is cleared first.
    const reused = buildShadeField({ ...options, facets: [], lathes: [], data: whole.data });
    assert.equal(reused.bounds, null);
    assert.ok(reused.data.every(value => value === 0));
});

test('round solids keep the circle\'s width on both screen axes', () => {
    const [disc] = solidFacets({ kind: 'cylinder', centre: [0, 0], radius: 10, top: 30 }, plain);
    const reach = (ax, ay) => Math.max(...Array.from(disc.x, (x, i) => x * ax + disc.y[i] * ay));
    // The screen axes are the tile diagonals.
    for (const [ax, ay] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
        assert.ok(Math.abs(reach(ax, ay) / Math.SQRT2 - 10) < 1e-9);
    }
    const dome = solidFacets({ kind: 'dome', centre: [0, 0], radius: 10, eave: 20, apex: 40 }, plain);
    assert.ok(dome.every(f => f.height === 40 && f.top <= 40));
    assert.equal(Math.max(...dome.map(f => f.top)), 40);
    assert.throws(() => solidFacets({ kind: 'spire' }, plain), RangeError);
});

test('a lathe profile reads a silhouette as stacked discs; a thin crown is porous', () => {
    const width = 20;
    const height = 12;
    const alpha = new Uint8Array(width * height);
    // Rows 0-5: a full crown 12 wide. Rows 6-11: a 2-px trunk.
    for (let row = 0; row < 6; row++) for (let col = 4; col < 16; col++) alpha[row * width + col] = 255;
    for (let row = 6; row < 12; row++) for (let col = 9; col < 11; col++) alpha[row * width + col] = 255;
    const profile = latheProfile(alpha, width, height, 11, { axis: 10, footCol: 10 });
    assert.equal(profile.height, 12);
    assert.equal(profile.slabs.length, 6);
    const trunk = profile.slabs[0];
    const crown = profile.slabs[profile.slabs.length - 1];
    assert.deepEqual([trunk.z0, trunk.z1], [0, 2]);
    assert.ok(trunk.r < 2 && crown.r === 6);
    assert.equal(crown.cov, 1);
    assert.equal(crown.cx, 0, 'slabs sit on the given axis');
    // The same crown with three texels in four gone: bare twigs.
    for (let row = 0; row < 6; row++) for (let col = 4; col < 16; col++) if ((row + col) % 4) alpha[row * width + col] = 0;
    const bare = latheProfile(alpha, width, height, 11, { axis: 10, footCol: 10 });
    const twigs = bare.slabs[bare.slabs.length - 1];
    assert.ok(twigs.cov > 0.2 && twigs.cov < 0.5, `a bare crown thins, got ${twigs.cov}`);
});

test('lathes write coverage only, along the sweep, and share one stamp per shape', () => {
    const profile = latheProfile(new Uint8Array(10 * 60).fill(255), 10, 60, 59);
    const stamp = latheStamp(profile, { sx: 2, sy: 0 });
    assert.ok(stamp.cols >= (60 * 2) / SHADE_CELL_W, 'the stamp spans the swept length');
    assert.equal(latheStamp({ slabs: [], height: 0 }, { sx: 1, sy: 0 }), null);
    const field = buildShadeField({ rect: RECT, sweep: { sx: 2, sy: 0 }, lathes: [{ x: 30, y: 100, profile, key: 'pole' }] });
    assert.equal(shadeCoverageAt(field, 30 + 40, 100), 1);
    assert.equal(shadeCeilingAt(field, 30 + 40, 100), 0, 'a prop never raises the receiver ceiling');
    assert.equal(shadeCoverageAt(field, 30 + 40, 100 + 12), 0);
    assert.ok(shadeCoverageAt(field, 30 + 118, 100) < 1, 'the tip thins');
    assert.equal(shadeCoverageAt(field, 30 + 130, 100), 0);
});

test('every landmark massing compiles, and the village masonry stands where the plan puts it', () => {
    for (const def of BUILDING_DEFS) {
        const massing = LANDMARK_MASSING[def.type];
        assert.ok(massing, `no massing entry for ${def.type}`);
        const facets = massingFacets(massing, def, buildingCenterToWorld(def));
        assert.equal(facets.length > 0, massing.solids.length > 0);
        // How many solids a fit takes is the validator's business (massing.mjs).
        if (massing.fitted) assert.ok(massing.solids.length >= 1, `${def.type} is marked fitted`);
        for (const f of facets) assert.ok(f.n >= 3 && f.top > 0 && Number.isFinite(f.gx + f.gy));
    }
    assert.equal(LANDMARK_MASSING.command.fitted && LANDMARK_MASSING.tavern.fitted, true);
    const runs = VILLAGE_WALL_ROUTES.flatMap(route => route.points.slice(0, -1).map((from, i) => ({ from, to: route.points[i + 1] })));
    const masonry = masonryFacets({ runs, gate: true });
    assert.ok(masonry.length > runs.length + 4);
    const field = buildShadeField({ sweep: { sx: 0, sy: 0 }, facets: masonry });
    const run = runs[0];
    const mid = { tileX: (run.from.tileX + run.to.tileX) / 2, tileY: run.from.tileY };
    const world = { x: (mid.tileX - mid.tileY) * 32, y: (mid.tileX + mid.tileY) * 16 };
    assert.ok(shadeCeilingAt(field, world.x, world.y) >= 50, 'the curtain wall stands on its own line');
    assert.equal(shadeCeilingAt(field, world.x, world.y - 40), 0);
});

test('the texture view and the painted ground rule', () => {
    const field = buildShadeField({ rect: RECT, sweep: { sx: 1, sy: 0 }, facets: box(20, 40, 40, 80, 40) });
    field.revision = 7;
    const texture = shadeFieldTexture(field);
    assert.deepEqual(
        { width: texture.width, height: texture.height, format: texture.format, revision: texture.revision, origin: texture.origin, cell: texture.cell },
        { width: 200, height: 200, format: 'rg8', revision: 7, origin: [0, 0], cell: [2, 1] },
    );
    assert.equal(texture.data, field.data);
    assert.equal(shadeFieldTexture(null), null);
    const rgba = new Uint8Array(RECT.cols * 20 * 4).fill(9);
    paintShadeCells(field, rgba, [10, 20, 30], 50, 70);
    const at = (x, row) => Array.from(rgba.subarray(((row - 50) * RECT.cols + Math.floor(x / 2)) * 4, ((row - 50) * RECT.cols + Math.floor(x / 2)) * 4 + 4));
    assert.deepEqual(at(30, 60), [10, 20, 30, 255], 'shaded cells take the cast colour, opaque');
    assert.equal(at(150, 60)[3], 0, 'open ground is clear');
    // Canvas: over painted open water a shaded cell keeps its share and loses every third row.
    const lattice = { x: 0, y: 0, cols: 200, rows: 100, coastField: new Uint8Array(200 * 100 * 2) };
    for (let i = 1; i < lattice.coastField.length; i += 2) lattice.coastField[i] = 4;
    paintShadeCells(field, rgba, [10, 20, 30], 50, 70, { fields: lattice, waterBit: 4, coveredBit: 8, share: 0.35 });
    assert.equal(at(30, 60)[3], Math.round(255 * 0.35));
    assert.equal(at(30, 62)[3], 0, 'row 62 is a dropped ripple row');
    for (let i = 1; i < lattice.coastField.length; i += 2) lattice.coastField[i] = 4 | 8;
    paintShadeCells(field, rgba, [10, 20, 30], 50, 70, { fields: lattice, waterBit: 4, coveredBit: 8, share: 0.35 });
    assert.equal(at(30, 62)[3], 255, 'a deck over the water keeps the land shade');
});

test('convexHull drops interior points', () => {
    const hull = convexHull([[0, 0], [4, 0], [4, 4], [0, 4], [2, 2], [1, 3]]);
    assert.equal(hull.length, 4);
    assert.deepEqual(new Set(hull.map(p => p.join())), new Set(['0,0', '4,0', '4,4', '0,4']));
    assert.equal(facet([[0, 0, 5], [4, 0, 5], [4, 4, 5]]).top, 5);
});
