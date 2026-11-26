import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { ART_RAMPS } from '../../claudeville/src/config/artPalette.js';
import { MAP_SIZE, TILE_WIDTH, TILE_HEIGHT } from '../../claudeville/src/config/constants.js';
import {
    BUILDING_FOOTING_KINDS, BUILDING_GROUNDING_PROFILES, FOOTING_MAX_ROWS, footingHeight,
} from '../../claudeville/src/config/buildingGrounding.js';
import { buildingCenterToWorld, tileToWorld } from '../../claudeville/src/presentation/character-mode/Projection.js';
import {
    AXIS_FRAME, MEDALLION_RINGS, STONE_FACE, STONE_LATTICES, STONE_ROLE, lipOffset, medallionAt, medallionSteepSide, stoneAt, stoneFrame,
    stoneRole,
} from '../../claudeville/src/presentation/character-mode/TerrainTileset.js';
import {
    EDGE_BLADES, GROUND_BAKE_BUDGET, GROUND_CHAMFER, GROUND_CLASS, GROUND_COLOR_TEXEL_W, GROUND_FIELD_TEXEL_W, GROUND_STOP_FLAGS,
    SHRUBS, TUFTS, bakeGround, bakeWinterGround, groundBakeSlices, validGroundArtifact,
} from '../../claudeville/src/presentation/character-mode/GroundBake.js';

// W1-A — the 1×1 artisanal ground bake (spec 02 §2.1–2.9, X-5, X-6).

const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const rgbKey = (d, o) => (d[o] << 16) | (d[o + 1] << 8) | d[o + 2];
const keyOf = (h) => { const [r, g, b] = hex(h); return (r << 16) | (g << 8) | b; };
const S = Object.freeze({ GRASS: 0, SAND: 1, DIRT: 2, ROAD: 3, PLAZA: 4, FLAG: 5, GRAVEL: 6, CINDER: 7, EARTH: 8 });
const CLS_OF = [GROUND_CLASS.GRASS, GROUND_CLASS.SAND, GROUND_CLASS.DIRT, GROUND_CLASS.ROAD, GROUND_CLASS.PLAZA,
    GROUND_CLASS.PLAZA, GROUND_CLASS.ROAD, GROUND_CLASS.DIRT, GROUND_CLASS.DIRT];
const N = MAP_SIZE;
const X0 = -N * TILE_WIDTH / 2;
const Y0 = -TILE_HEIGHT / 2;

function fixture(t, overrides = {}) {
    let last = null;
    globalThis.ImageData = class {
        constructor(width, height) { this.width = width; this.height = height; this.data = new Uint8ClampedArray(width * height * 4); }
    };
    globalThis.document = {
        createElement: () => {
            let own = null;
            return {
                width: 0,
                height: 0,
                getContext: () => ({
                    putImageData(img) { own = img; last = img; },
                    getImageData() {
                        const copy = new globalThis.ImageData(own.width, own.height);
                        copy.data.set(own.data);
                        return copy;
                    },
                }),
            };
        },
    };
    t.after(() => { delete globalThis.ImageData; delete globalThis.document; });
    const renderer = {
        _coastField: { key: '0:0:0:0:0:0', signedDistance: () => -9 },
        townSquareTiles: new Set(),
        world: { buildings: new Map() },
        scenery: { getTreeProps: () => [] },
        ...overrides,
    };
    return { renderer, image: () => last };
}

const tiles = (x0, x1, y0, y1) => {
    const out = new Set();
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) out.add(`${x},${y}`);
    return out;
};
const insideDiamond = (sx, sy) => {
    const tx = sx / TILE_WIDTH + sy / TILE_HEIGHT;
    const ty = sy / TILE_HEIGHT - sx / TILE_WIDTH;
    return tx >= -0.5 && ty >= -0.5 && tx < N - 0.5 && ty < N - 0.5;
};

test('X-5: one colour decision per world px on the 2560 x 1280 canvas, published fields on the 2x1 grid', t => {
    const { renderer, image } = fixture(t, { townSquareTiles: tiles(18, 20, 19, 21), mainAvenueTiles: tiles(21, 26, 19, 20) });
    const base = bakeGround(renderer, true);
    const img = image();
    assert.equal(GROUND_COLOR_TEXEL_W, 1);
    assert.equal(GROUND_FIELD_TEXEL_W, 2);
    assert.equal(img.width, N * TILE_WIDTH);
    assert.equal(base.color.cols, N * TILE_WIDTH, 'the colour lattice is one texel per world px');
    assert.equal(base.cols, N * TILE_WIDTH / 2, 'the published fields keep 1280 columns');
    assert.equal(base.field.texelW, 2);
    assert.equal(base.field.weather.cols, 1280);
    assert.equal(base.puddleMask.length, 1280 * 1280);
    assert.equal(validGroundArtifact({ field: base.field, puddleMask: { data: base.puddleMask, cols: base.cols, rows: base.rows, x0: base.x0, y0: base.y0, texelW: 2, revision: 'r' } }), true);
    // Every pixel whose centre lies in the island diamond is painted (one
    // write each, no 2-px doubling spilling past a row's last column) and
    // nothing outside it is.
    let wrong = 0;
    for (let row = 0; row < base.rows; row++) {
        for (let col = 0; col < img.width; col++) {
            const painted = img.data[(row * img.width + col) * 4 + 3] === 255;
            if (painted !== insideDiamond(X0 + col + 0.5, Y0 + row + 0.5)) wrong++;
        }
    }
    assert.equal(wrong, 0, `${wrong} pixels painted outside, or missing inside, the diamond`);
    // 1×1 decisions: stone joints and lips split the old 2-px texel pairs.
    let pairs = 0;
    let split = 0;
    const { surfaces } = base.color;
    for (let i = 0; i < surfaces.length; i += 2) {
        const s = surfaces[i];
        if (s !== S.PLAZA && s !== S.ROAD) continue;
        pairs++;
        if (rgbKey(img.data, i * 4) !== rgbKey(img.data, i * 4 + 4)) split++;
    }
    assert.ok(pairs > 5000);
    assert.ok(split / pairs > 0.15, `only ${(100 * split / pairs).toFixed(1)} % of paving pairs differ`);
});

test('X-5: each published cell takes its right-hand fine sample (2c + 1)', t => {
    const { renderer } = fixture(t, { townSquareTiles: tiles(18, 20, 19, 21), mainAvenueTiles: tiles(21, 26, 19, 20) });
    const base = bakeGround(renderer);
    const { surfaces: fine, aoBuf: fineAo } = base.color;
    let checked = 0;
    let mixed = 0;
    for (let i = 0; i < base.surfaces.length; i++) {
        const f = 2 * i + 1;
        assert.equal(base.surfaces[i], fine[f]);
        assert.equal(base.aoBuf[i], fineAo[f]);
        if (fine[f] !== 255) {
            assert.equal(base.field.classes[i], CLS_OF[fine[f]]);
            checked++;
            if (fine[f - 1] !== fine[f]) mixed++;
        }
    }
    assert.ok(checked > 800_000 && mixed > 100, `${checked} land cells, ${mixed} mixed pairs`);
    // classAt reads the cell (right-hand sample) at both of its world px.
    const { x, y } = tileToWorld(19, 20);
    const col = Math.floor((x - base.x0) / 2);
    const row = Math.floor(y - base.y0);
    assert.equal(base.field.classAt(base.x0 + col * 2 + 0.25, y), base.field.classes[row * base.cols + col]);
    assert.equal(base.field.classAt(base.x0 + col * 2 + 1.75, y), base.field.classes[row * base.cols + col]);
});

test('X-5: a fine land / water pair never wets the water (weather neutral, no puddle)', t => {
    const { renderer } = fixture(t, {
        _coastField: { key: '0:0:0:0:0:0', signedDistance: (x, y) => Math.hypot(x - 20, y - 20) - 3.2 },
        townSquareTiles: tiles(18, 22, 18, 22),
    });
    const base = bakeGround(renderer, true);
    const fine = base.color.surfaces;
    const data = base.field.weather.data;
    let mixed = 0;
    for (let i = 0; i < base.surfaces.length; i++) {
        const a = fine[2 * i];
        const b = fine[2 * i + 1];
        if ((a === 255) === (b === 255)) continue;
        mixed++;
        assert.deepEqual([...data.subarray(i * 4, i * 4 + 4)], [255, 0, 128, 0], `cell ${i}`);
        assert.equal(base.puddleMask[i], 0);
    }
    assert.ok(mixed > 20, `the shore has ${mixed} mixed pairs`);
    // And no puddle lies over a fine pixel that cannot hold one.
    for (let i = 0; i < base.puddleMask.length; i++) {
        if (!base.puddleMask[i]) continue;
        for (const f of [2 * i, 2 * i + 1]) assert.ok([S.DIRT, S.ROAD, S.PLAZA, S.FLAG, S.GRAVEL, S.CINDER, S.EARTH].includes(fine[f]));
    }
});

test('X-5: sliced into labelled passes within the transient budget; stepping equals the one-shot bake', t => {
    const { renderer, image } = fixture(t, { townSquareTiles: tiles(18, 20, 19, 21), mainAvenueTiles: tiles(21, 26, 19, 20) });
    const once = bakeGround(renderer, true);
    const hashOnce = createHash('sha256').update(image().data).digest('hex');
    const gen = groundBakeSlices(renderer, true);
    const labels = new Map();
    let step = gen.next();
    while (!step.done) {
        labels.set(step.value, (labels.get(step.value) || 0) + 1);
        step = gen.next();
    }
    const hashSliced = createHash('sha256').update(image().data).digest('hex');
    assert.equal(hashSliced, hashOnce, 'slicing never changes a pixel');
    assert.ok(labels.get('base') >= N * TILE_HEIGHT / GROUND_BAKE_BUDGET.bandRows - 1, `base slices ${labels.get('base')}`);
    for (const pass of ['details', 'crowns', 'chamfer', 'living', 'decals', 'tufts', 'transitions', 'footings', 'upload', 'fields', 'puddles']) {
        assert.ok(labels.has(pass), `a slice boundary after ${pass}`);
    }
    // The one-off setup steps each end a slice of their own.
    for (const step of ['coast', 'tiles', 'drift', 'textures', 'occluders', 'routes', 'noise', 'planes']) {
        assert.ok(labels.has(`setup:${step}`), `a slice boundary after setup ${step}`);
    }
    assert.equal(GROUND_BAKE_BUDGET.bandRows, 64);
    assert.ok(GROUND_BAKE_BUDGET.sliceMs <= 9);
    assert.equal(GROUND_BAKE_BUDGET.sliceCapMs, 9);
    assert.ok(once.stats.peakBytes <= GROUND_BAKE_BUDGET.peakBytes, `weather bake peak ${once.stats.peakBytes}`);
    assert.ok(bakeGround(renderer).stats.peakBytes <= GROUND_BAKE_BUDGET.peakBytes);
    assert.deepEqual(GROUND_CHAMFER, { A_X: 5, A_Y: 10, B: 11 });
});

test('X-5: the measured longest slice stays within the 9 ms cap, stepping off the frame', t => {
    // A heavier island than the other fixtures: a plaza, an avenue, a crowd
    // of trees (with the World Ash's wide crown) and a landmark, so the crown
    // field, the occluders and every pass have real work to slice.
    const trees = [{ species: 'ash', size: 'world', variant: 0, tileX: 8, tileY: 30 }];
    for (let k = 0; k < 120; k++) trees.push({ species: k % 3 ? 'oak' : 'pine', size: k % 4 ? 'large' : 'tall', variant: 0, tileX: 4 + (k * 7) % 32, tileY: 3 + (k * 11) % 33 });
    const { renderer } = fixture(t, {
        townSquareTiles: tiles(18, 20, 19, 21),
        mainAvenueTiles: tiles(21, 26, 19, 20),
        world: { buildings: new Map([['archive', { type: 'archive', position: { tileX: 3, tileY: 15 }, width: 5, height: 3 }]]) },
        scenery: { getTreeProps: () => trees },
    });
    // The wall-clock length of each `next()` (what an idle slot pays),
    // not just the bake's own accounting; the best of five runs, so a
    // stray collector pause or parallel test-worker preemption on a busy
    // host does not count as a slice.
    let best = Infinity;
    let accounted = Infinity;
    for (let run = 0; run < 5 && (best > GROUND_BAKE_BUDGET.sliceCapMs || accounted > GROUND_BAKE_BUDGET.sliceCapMs); run++) {
        const gen = groundBakeSlices(renderer, true);
        let worst = 0;
        let step;
        do {
            const started = performance.now();
            step = gen.next();
            worst = Math.max(worst, performance.now() - started);
        } while (!step.done);
        best = Math.min(best, worst);
        accounted = Math.min(accounted, step.value.stats.maxSliceMs);
    }
    assert.ok(best <= GROUND_BAKE_BUDGET.sliceCapMs, `longest measured slice ${best.toFixed(2)} ms`);
    assert.ok(accounted <= GROUND_BAKE_BUDGET.sliceCapMs, `longest accounted slice ${accounted.toFixed(2)} ms`);
});

test('2.2: the stone lattice, its roles and its key-light faces', () => {
    assert.deepEqual(STONE_LATTICES.plaza, { su: 16, sv: 11, bondU: 8 });
    assert.deepEqual(STONE_LATTICES.forecourt, { su: 24, sv: 16, bondU: 12 });
    assert.deepEqual(STONE_LATTICES.sett, { su: 8, sv: 6, bondU: 4 });
    assert.deepEqual(STONE_LATTICES.flag, { su: 20, sv: 14, bondU: 7 });
    const L = STONE_LATTICES.plaza;
    const unit = {};
    stoneAt(0.5, 0.5, L, 1, unit);
    assert.equal(stoneRole(unit.lu, unit.lv, L), STONE_ROLE.CROSS);
    stoneAt(0.5, 5, L, 1, unit);
    assert.equal(stoneRole(unit.lu, unit.lv, L), STONE_ROLE.MORTAR);
    stoneAt(1.5, 5, L, 1, unit);
    assert.equal(stoneRole(unit.lu, unit.lv, L), STONE_ROLE.LOW_S);
    stoneAt(15.5, 5, L, 1, unit);
    assert.equal(stoneRole(unit.lu, unit.lv, L), STONE_ROLE.HIGH_S);
    // Running bond: the next course is offset by bondU.
    const a = stoneAt(4, 5, L, 1, {});
    const b = stoneAt(4, 16, L, 1, {});
    assert.equal(a.lu, 4);
    assert.equal(b.lu, 12);
    // Axis frame: NW lit, SE shaded, the glancing NE / SW edges on half the stones.
    assert.equal(AXIS_FRAME.lowS, STONE_FACE.LIT);
    assert.equal(AXIS_FRAME.highS, STONE_FACE.SHADE);
    assert.equal(AXIS_FRAME.lowT, STONE_FACE.LIT_HALF);
    assert.equal(AXIS_FRAME.highT, STONE_FACE.SHADE_HALF);
    assert.equal(lipOffset(STONE_ROLE.LOW_S, AXIS_FRAME, false, false), 1);
    assert.equal(lipOffset(STONE_ROLE.HIGH_S, AXIS_FRAME, false, false), -1);
    assert.equal(lipOffset(STONE_ROLE.LOW_T, AXIS_FRAME, true, false), 1);
    assert.equal(lipOffset(STONE_ROLE.LOW_T, AXIS_FRAME, false, false), 0);
    // A sett frame laid along +v puts the full key on its high-t edge.
    const alongV = stoneFrame(0, 1);
    assert.equal(alongV.highT, STONE_FACE.LIT);
    assert.equal(alongV.lowT, STONE_FACE.SHADE);
});

test('2.3: the octagonal fountain compass medallion', () => {
    const R = MEDALLION_RINGS;
    assert.deepEqual([R.fountain, R.kerb, R.bandA, R.bandB, R.border], [28.8, 33.6, 44.8, 57.6, 60.2]);
    assert.equal(medallionAt(0, 0), 2, 'flat plaza[2] under the fountain');
    assert.equal(medallionAt(0.95, 0), 3, 'basin kerb body');
    assert.equal(medallionAt(1.03, 0), 1, 'the kerb lip on the SE half is shaded');
    assert.equal(medallionAt(-1.03, 0), 4, 'the kerb lip on the NW half is lit');
    assert.equal(medallionAt(1.3, 0), (1 << 4) | 2, 'a compass ray along an avenue is cool limestone');
    assert.equal(medallionAt(1.22, 0), 0, 'the mid-course joint');
    assert.equal(medallionAt(1.82, 0), 1, 'the dark border course');
    assert.equal(medallionAt(1.3, 1.3), 1, 'an octagon, not a circle: the diagonal reaches the border sooner');
    assert.equal(medallionAt(1.95, 0), -1);
    assert.equal(medallionAt(0, 2), -1);
    let rings = 0;
    for (let r = 0.9; r < 1.88; r += 0.01) if (medallionAt(r, 0) === 0) rings++;
    assert.ok(rings >= 4, 'one-row mortar seams between the courses');
    // W1 council fix — carved flat, never a picket fence. The two sides that
    // stand vertical on screen (du · dv < 0, the diagonal term ruling) take
    // no lit or shaded lip and only soft (stop 1) seams; the outer band beds
    // in soft mortar; band B drops its radial joints steeper than 2:1.
    assert.equal(medallionSteepSide(0.7, -0.7), true);
    assert.equal(medallionSteepSide(-0.7, 0.7), true);
    assert.equal(medallionSteepSide(0.7, 0.7), false, 'the screen-horizontal sides');
    assert.equal(medallionSteepSide(1.2, 0.1), false, 'the 2:1 sides');
    const along = (r) => [r * Math.SQRT1_2, -r * Math.SQRT1_2];
    const steep = new Map();
    for (let r = 0.9; r < 1.88; r += 0.002) {
        const v = medallionAt(...along(r));
        steep.set(v, (steep.get(v) || 0) + 1);
    }
    assert.ok(!steep.has(0), 'no stop-0 seam on a steep side');
    assert.ok(!steep.has(4) && !steep.has((1 << 4) | 3) && !steep.has((1 << 4) | 1), 'no lip on a steep side');
    assert.equal(medallionAt(...along(1.03)), 3, 'the kerb keeps its body tone on a steep side');
    assert.equal(medallionAt(-1.03, 0), 4, 'the 2:1 sides keep their lips');
    // The outer band's course mortar and the border's outer seam are stop 1.
    assert.equal(medallionAt(1.41, 0), 1);
    assert.equal(medallionAt(1.87, 0), 1);
    // Band B: no radial joint where du · dv > 0 (screen-steep), soft ones elsewhere.
    let steepJoints = 0;
    let softJoints = 0;
    let joints = 0;
    for (const ring of [1.5, 1.7]) {
        for (let a = 0; a < Math.PI * 2; a += Math.PI / 720) {
            // On the octagon ring (both courses of band B).
            const c = Math.cos(a);
            const sn = Math.sin(a);
            const norm = Math.max(Math.abs(c), Math.abs(sn), (Math.abs(c) + Math.abs(sn)) * Math.SQRT1_2);
            const du = ring * c / norm;
            const dv = ring * sn / norm;
            const v = medallionAt(du, dv);
            if (v === 0) {
                if (du * dv > 0) steepJoints++;
                else softJoints++;
            }
            if (v === 1 && du * dv < 0 && !medallionSteepSide(du, dv)) joints++;
        }
    }
    assert.ok(joints > 0, 'the shallow radial joints stay, softened to stop 1');
    assert.equal(steepJoints, 0, 'band B keeps no steep radial joint');
    assert.equal(softJoints, 0, 'band B joints are soft');
});

test('2.2–2.4: plaza and avenue stones read as units with NW / SE lips, setts end at a 3 px jointed kerb', t => {
    // An avenue strip running along +tx, framed by grass, beside a plaza.
    const avenue = tiles(8, 30, 20, 20);
    const { renderer, image } = fixture(t, { townSquareTiles: tiles(31, 33, 19, 21), mainAvenueTiles: avenue });
    const base = bakeGround(renderer, false, { debug: true });
    const img = image().data;
    const { cols, surfaces, aoBuf, stepBuf } = base.color;
    const unit = base.stats.unitMap;
    const stones = new Map();
    for (let i = 0; i < unit.length; i++) {
        if (!unit[i]) continue;
        const id = unit[i] >>> 8;
        const lip = unit[i] & 255;
        let st = stones.get(id);
        if (!st) stones.set(id, st = { n: 0, lit: 0, shade: 0, colors: new Set() });
        st.n++;
        if (lip === 1) st.lit++;
        else if (lip === 2) st.shade++;
        else if (lip === 0 && aoBuf[i] === 0) st.colors.add(rgbKey(img, i * 4));
    }
    let whole = 0;
    let lipped = 0;
    let bodies = 0;
    let flat = 0;
    for (const st of stones.values()) {
        if (st.n < 12) continue;
        whole++;
        if (st.lit && st.shade) lipped++;
        if (st.colors.size) { bodies++; if (st.colors.size === 1) flat++; }
    }
    assert.ok(whole > 200, `${whole} whole stones`);
    assert.ok(lipped / whole >= 0.85, `${(100 * lipped / whole).toFixed(1)} % of stones show both lips`);
    assert.ok(flat / bodies >= 0.9, `no Bayer static inside stones: ${(100 * flat / bodies).toFixed(1)} % flat bodies`);
    // Horizontal runs on paving: the 1 px grain shows (spec 02 §2.12).
    const hist = new Map();
    let runs = 0;
    for (let row = 0; row < base.rows; row++) {
        let start = 0;
        let colour = -1;
        for (let col = 0; col <= cols; col++) {
            const i = row * cols + col;
            const s = col < cols ? surfaces[i] : 255;
            const c = s === S.ROAD || s === S.PLAZA ? rgbKey(img, i * 4) : -1;
            if (c === colour) continue;
            if (colour >= 0) { hist.set(col - start, (hist.get(col - start) || 0) + 1); runs++; }
            start = col;
            colour = c;
        }
    }
    let mode = 0;
    for (const [len, n] of hist) if (n > (hist.get(mode) || 0)) mode = len;
    assert.ok((hist.get(1) || 0) / runs >= 0.1, `1 px runs ${(100 * (hist.get(1) || 0) / runs).toFixed(1)} %`);
    assert.ok(mode <= 2, `run mode ${mode} px`);
    // The kerb: the avenue's NE edge (ty = 19.5) runs straight (no earth
    // shoulder, no noisy edge) and every column carries exactly 3 kerb rows.
    const { KERB_MASK } = GROUND_STOP_FLAGS;
    let columns = 0;
    let threeRows = 0;
    let worst = 0;
    for (let tx = 12; tx <= 26; tx += 0.25) {
        const p = tileToWorld(tx, 19.5);
        const col = Math.floor(p.x - X0);
        let row = Math.floor(p.y - Y0) - 8;
        while (row < base.rows && surfaces[row * cols + col] === S.GRASS) row++;
        worst = Math.max(worst, Math.abs(Y0 + row + 0.5 - p.y));
        let k = 0;
        while (stepBuf[(row + k) * cols + col] & KERB_MASK) k++;
        columns++;
        if (k === 3) threeRows++;
        // The grass-owned crease just outside the kerb.
        const crease = rgbKey(img, ((row - 1) * cols + col) * 4);
        assert.ok([keyOf(ART_RAMPS.grass[0]), keyOf(ART_RAMPS.grass[2])].includes(crease), `crease at ${tx}`);
    }
    assert.ok(threeRows / columns >= 0.9, `${threeRows}/${columns} columns with a 3-row kerb`);
    assert.ok(worst <= 2.5, `the avenue's edge strays ${worst.toFixed(1)} rows from the tile edge`);
    let dirt = 0;
    for (let i = 0; i < surfaces.length; i++) if (surfaces[i] === S.DIRT) dirt++;
    assert.equal(dirt, 0, 'an avenue carries no earth shoulder');
    // Kerb blocks are jointed in road[0].
    let joints = 0;
    for (let i = 0; i < stepBuf.length; i++) {
        if (((stepBuf[i] & KERB_MASK) >> GROUND_STOP_FLAGS.KERB_SHIFT) >= 2 && rgbKey(img, i * 4) === keyOf(ART_RAMPS.road[0])) joints++;
    }
    assert.ok(joints > 30, `${joints} kerb joint texels`);
});

test('2.6–2.7: calm sweeps, inline stamp tables and the OA-T3 edge vocabulary', t => {
    for (const [name, rows] of Object.entries(TUFTS)) {
        assert.ok(rows.every(r => r.length === rows[0].length && /^[.rmtl]+$/.test(r)), name);
    }
    assert.deepEqual(Object.keys(TUFTS), ['T5a', 'T6a', 'T7a', 'T7b', 'T8a', 'T9a']);
    for (const [name, rows] of Object.entries(SHRUBS)) {
        assert.ok(rows.every(r => r.length === rows[0].length && /^[.s1234f]+$/.test(r)), name);
    }
    assert.deepEqual(Object.keys(EDGE_BLADES), ['G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7', 'G8', 'G9', 'G10']);
    assert.ok(Object.values(EDGE_BLADES).every(h => h.every(v => Number.isInteger(v) && v >= 0 && v <= 3)));
    // A dirt lane through the meadow between a back shore (water above the
    // turf on screen) and a front beach: blades over the lane, its crease,
    // dune tufts over the back shore's strand.
    const { renderer, image } = fixture(t, {
        _coastField: { key: '0:0:0:0:0:0', signedDistance: (x, y) => Math.max(14 - (x + y), x + y - 66) },
        dirtPathTiles: tiles(6, 24, 14, 14),
    });
    const base = bakeGround(renderer);
    const img = image().data;
    const { cols, surfaces, aoBuf, stepBuf } = base.color;
    // Open meadow keeps the sweep's three stops, ±1 around the mean.
    const stops = new Set();
    for (let i = 0; i < surfaces.length; i++) {
        if (surfaces[i] === S.GRASS && aoBuf[i] === 0) stops.add(stepBuf[i] & GROUND_STOP_FLAGS.STOP_MASK);
    }
    assert.ok([...stops].every(k => k >= 0 && k <= 3), `meadow stops ${[...stops]}`);
    const grassColours = new Set([...ART_RAMPS.grass].map(keyOf));
    let overhang = 0;
    let creased = 0;
    let under = 0;
    for (let i = cols; i < surfaces.length - cols; i++) {
        if (surfaces[i] === S.DIRT && grassColours.has(rgbKey(img, i * 4))) overhang++;
        if (surfaces[i] === S.DIRT && surfaces[i - cols] === S.GRASS) {
            under++;
            const c = rgbKey(img, i * 4);
            if (c === keyOf(ART_RAMPS.dirt[0]) || c === keyOf(ART_RAMPS.road[1])) creased++;
        }
    }
    assert.ok(overhang > 20, `${overhang} grass blades over the lane`);
    assert.ok(creased / under > 0.6, `the lane's crease under the turf: ${creased}/${under}`);
    let dune = 0;
    for (let i = 0; i < surfaces.length; i++) {
        if (surfaces[i] !== S.SAND) continue;
        const c = img.subarray(i * 4, i * 4 + 3);
        if (c[1] > c[0] && c[1] > c[2]) dune++; // a green texel on the strand
    }
    assert.ok(dune > 10, `${dune} dune-tuft texels on the strand`);
});

test('E0: a coast bank zone takes no beach and paints the earth bank lip', t => {
    const bankZone = new Uint8Array(N * N).fill(1);
    const sd = (x, y) => x + y - 66;
    const banked = fixture(t, { _coastField: { key: '0:0:0:0:0:0', signedDistance: sd, bankZone } });
    const a = bakeGround(banked.renderer);
    const imgA = banked.image().data;
    const plain = fixture(t, { _coastField: { key: '0:0:0:0:0:0', signedDistance: sd } });
    const b = bakeGround(plain.renderer);
    const count = (base, s) => base.color.surfaces.reduce((n, v) => n + (v === s), 0);
    assert.ok(count(b, S.SAND) > 1000, 'a beach without bank zones');
    assert.equal(count(a, S.SAND), 0, 'no sand where a bank face stands');
    const { cols, surfaces } = a.color;
    const lip = keyOf(ART_RAMPS.grass[4]);
    let lips = 0;
    let edges = 0;
    for (let i = 0; i < surfaces.length - cols; i++) {
        if (surfaces[i] !== S.GRASS || surfaces[i + cols] !== 255) continue;
        const below = i + cols;
        if (!insideDiamond(X0 + (below % cols) + 0.5, Y0 + Math.floor(below / cols) + 0.5)) continue; // the map's edge, not water
        edges++;
        if (rgbKey(imgA, i * 4) === lip) lips++;
    }
    assert.ok(edges > 100 && lips / edges > 0.9, `${lips}/${edges} bank lips`);
});

test('E0: the strand reads its nearest shore: no sand on a bank face half a tile inland, beaches elsewhere', t => {
    // A diagonal shore whose bank zone marks only the tiles the contour
    // crosses (as CoastBake's classifier does: x + y of 66 and 67), banked on
    // the west half: a strand texel half a tile inland rounds to an unmarked
    // tile, so the bank must be read at its nearest shore contact.
    const sd = (x, y) => (x + y - 66.2) / Math.SQRT2;
    const bankZone = new Uint8Array(N * N);
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
        if (Math.abs(sd(x, y)) < Math.SQRT1_2 && x - y < 0) bankZone[y * N + x] = 2;
    }
    const { renderer } = fixture(t, { _coastField: { key: '0:0:0:0:0:0', signedDistance: sd, bankZone } });
    const base = bakeGround(renderer);
    const { cols, surfaces } = base.color;
    let bankedSand = 0;
    let beach = 0;
    for (let i = 0; i < surfaces.length; i++) {
        if (surfaces[i] !== S.SAND) continue;
        const sx = X0 + (i % cols) + 0.5;
        const sy = Y0 + Math.floor(i / cols) + 0.5;
        const tx = sx / TILE_WIDTH + sy / TILE_HEIGHT;
        const ty = sy / TILE_HEIGHT - sx / TILE_WIDTH;
        if (sd(tx, ty) < -2) continue; // the far edges' back-shore strand, not this shore
        if (tx < 1 || ty < 1 || tx > N - 2 || ty > N - 2) continue; // where the shore runs off the map
        if (tx - ty < -1.5) bankedSand++;
        else if (tx - ty > 1.5) beach++;
    }
    assert.equal(bankedSand, 0, 'no sand on the banked stretch');
    assert.ok(beach > 1000, `the open beach keeps its strand (${beach})`);
});

test('E1: footing profiles stay within 10 rows, run along front edges and are bake-owned', () => {
    const withFooting = Object.entries(BUILDING_GROUNDING_PROFILES).filter(([, p]) => p.footing);
    assert.deepEqual(withFooting.map(([k, p]) => [k, p.footing.kind]), [['command', 'dais'], ['archive', 'terrace'], ['watchtower', 'rock']]);
    for (const [type, { footing }] of withFooting) {
        assert.ok(BUILDING_FOOTING_KINDS.includes(footing.kind), type);
        assert.ok(footingHeight(footing) <= FOOTING_MAX_ROWS, `${type} ${footingHeight(footing)} rows`);
        assert.ok(footing.edges.length >= 2 && footing.edges.every(e => ['left', 'bottom', 'right'].includes(e)), type);
        assert.ok(footing.rows.every(r => Number.isInteger(r.sw) && Number.isInteger(r.se)), type);
    }
    const dais = BUILDING_GROUNDING_PROFILES.command.footing;
    assert.equal(dais.rows.length, 7);
    // W1 council fix — three painted steps (two-row treads) hung from the
    // art's own two gate steps: a five-step flight, nine rows painted.
    assert.deepEqual([dais.stair.at, dais.stair.width, dais.stair.steps, dais.stair.grow, dais.stair.treadRows], [[15.2, 18.3], 34, 3, 3, 2]);
    assert.equal(dais.stair.foot.length, 2);
    assert.equal(footingHeight(dais), 9);
    assert.equal(dais.aoShiftRows, 7);
    // Two legible courses on both faces: a dark drip under the coping and a
    // dark bed joint between the courses, the SE face never one dark band.
    for (const face of ['sw', 'se']) {
        const tones = dais.rows.map(r => r[face]);
        assert.ok(tones[1] < tones[0] - 2 && tones[1] < tones[2] - 1, `${face} drip ${tones}`);
        assert.ok(tones[4] < tones[3] - 1 && tones[4] < tones[5] - 1, `${face} bed ${tones}`);
        assert.ok(new Set(tones).size >= 4, `${face} tones ${tones}`);
    }
    assert.equal(BUILDING_GROUNDING_PROFILES.archive.footing.rows.length, 4);
    assert.ok(BUILDING_GROUNDING_PROFILES.archive.footing.rows.some(r => r.relief), 'a relief balustrade');
    const rock = BUILDING_GROUNDING_PROFILES.watchtower.footing;
    assert.equal(rock.tide, 3);
    assert.ok(rock.foot.length >= 3 && rock.foot.every(([x, y]) => Number.isFinite(x) && Number.isFinite(y)), 'the drawn foot polyline');
    assert.ok(rock.foot.every((p, k) => k === 0 || p[0] > rock.foot[k - 1][0]), 'left to right');
    // The Forge's coast quay reaches under its plinth edges.
    const quay = BUILDING_GROUNDING_PROFILES.forge.quay;
    assert.ok(quay && quay.rows >= 8 && quay.drop >= 0 && quay.edges.includes('bottom'));
});

test('E1: footings paint in front of their edges, carry the AO shift and never take snow', t => {
    const anchors = { command: [199, 164], archive: [167, 182], watchtower: [144, 320] };
    const buildings = new Map([
        ['command', { type: 'command', position: { tileX: 13, tileY: 14 }, width: 5, height: 4 }],
        ['archive', { type: 'archive', position: { tileX: 3, tileY: 15 }, width: 5, height: 3 }],
        ['watchtower', { type: 'watchtower', position: { tileX: 27, tileY: 8 }, width: 3, height: 5 }],
    ]);
    const { renderer, image } = fixture(t, {
        // Water a little in front of the watchtower's SW face.
        _coastField: { key: '0:0:0:0:0:0', signedDistance: (x, y) => (x > 24 && x < 32 && y > 5 ? y - 13.8 : -9) },
        assets: { getAnchor: (id) => anchors[id.replace('building.', '')] || null },
        townSquareTiles: tiles(12, 18, 13, 22),
        world: { buildings },
    });
    const base = bakeGround(renderer);
    const { footings } = base.stats;
    for (const type of ['command', 'archive', 'watchtower']) {
        const st = footings[type];
        assert.ok(st && st.texels > 100, `${type} footing painted`);
        assert.ok(st.maxRows <= FOOTING_MAX_ROWS, `${type} ${st.maxRows} rows`);
        assert.ok(st.minDy >= 0, `${type} paints only on or below its front edge (${st.minDy})`);
    }
    assert.equal(footings.command.maxRows, 9, 'the three painted steps under the art\'s two');
    assert.equal(footings.archive.maxRows, 4);
    // The flight hangs from the art's own gate steps: centred on their front
    // edge (base.png px through the anchor), below it.
    const cmd = buildings.get('command');
    const cmdCentre = buildingCenterToWorld(cmd);
    const [fa, fb] = BUILDING_GROUNDING_PROFILES.command.footing.stair.foot;
    assert.ok(Math.abs(footings.command.stair.x - (cmdCentre.x + (fa[0] + fb[0]) / 2 - anchors.command[0])) < 1e-6);
    // The headland hangs from the drawn foot polyline, not the footprint's
    // seaward corners: every painted column lies within it plus its spread.
    const tower = buildingCenterToWorld(buildings.get('watchtower'));
    const foot = BUILDING_GROUNDING_PROFILES.watchtower.footing.foot;
    const [spreadL, spreadR] = BUILDING_GROUNDING_PROFILES.watchtower.footing.spread;
    const xLo = tower.x + foot[0][0] - anchors.watchtower[0] - spreadL;
    const xHi = tower.x + foot[foot.length - 1][0] - anchors.watchtower[0] + spreadR;
    assert.ok(footings.watchtower.columns > 0 && footings.watchtower.columns <= xHi - xLo + 1, `${footings.watchtower.columns} columns`);
    // The Command's contact collar starts at the dais foot.
    const centre = buildingCenterToWorld(buildings.get('command'));
    const [ax, ay] = anchors.command;
    const plinth = BUILDING_GROUNDING_PROFILES.command.plinth;
    for (const share of [0.3, 0.7]) {
        const x = centre.x + plinth.left[0] + (plinth.bottom[0] - plinth.left[0]) * share - ax;
        const y = centre.y + plinth.left[1] + (plinth.bottom[1] - plinth.left[1]) * share - ay;
        const at = Math.floor(y + 6 - base.y0) * base.cols + Math.floor((x - base.x0) / 2);
        assert.equal(base.aoBuf[at], 255, `inside the shifted collar at ${share}`);
    }
    // Footing faces are flagged and a full snowfall leaves them bare.
    const { stepBuf, cols } = base.color;
    const faces = [];
    for (let i = 0; i < stepBuf.length; i++) if (stepBuf[i] & GROUND_STOP_FLAGS.FOOTING) faces.push(i);
    // (The stair repaints dais texels, which the stats count twice.)
    const painted = footings.command.texels + footings.archive.texels + footings.watchtower.texels;
    assert.ok(faces.length > 0.8 * painted && faces.length <= painted, `${faces.length} flagged of ${painted} painted`);
    const before = new Uint8ClampedArray(image().data);
    bakeWinterGround(renderer, base, 4, 0);
    const after = image().data;
    let snowed = 0;
    for (const i of faces) if (rgbKey(after, i * 4) !== rgbKey(before, i * 4)) snowed++;
    assert.equal(snowed, 0);
    let snowedElsewhere = 0;
    for (let i = 0; i < cols * base.rows; i++) if (rgbKey(after, i * 4) !== rgbKey(before, i * 4)) snowedElsewhere++;
    assert.ok(snowedElsewhere > 10000, 'the ground around them does take snow');
});
