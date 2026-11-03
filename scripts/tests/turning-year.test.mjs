import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PNG } from 'pngjs';
import { TILE_HEIGHT, TILE_WIDTH } from '../../claudeville/src/config/constants.js';
import { PHENOLOGY_STAGES, SeasonalAmbience, phenologyAt, phenologyForAtmosphere }
    from '../../claudeville/src/presentation/character-mode/SeasonalAmbience.js';
import { TREE_SPRITES, canopyPlan, isCanopyPixel, recolorCanopy, shedCanopy, treeStateKey }
    from '../../claudeville/src/presentation/character-mode/FoliageRenderer.js';
import { COAST_FIELD_FLAGS, riverCurrentAt } from '../../claudeville/src/presentation/character-mode/CoastBake.js';
import { ParticleSystem } from '../../claudeville/src/presentation/character-mode/ParticleSystem.js';
import { windAt } from '../../claudeville/src/presentation/character-mode/Wind.js';

// BI-2, BI-4: the Turning Year (the woods keep the real calendar in weekly
// stages) and the leaves that ride the wind and float down the river.

const SPECIES = ['oak', 'willow', 'birch', 'maple', 'poplar'];
const at = (iso) => phenologyAt(new Date(`${iso}T13:00`));

function sheet(id, height) {
    const png = PNG.sync.read(readFileSync(new URL(`../../claudeville/assets/sprites/vegetation/${id}.png`, import.meta.url)));
    return { width: png.width, height, data: Uint8ClampedArray.from(png.data.subarray(0, png.width * height * 4)) };
}

test('the Turning Year keeps the date table', () => {
    assert.deepEqual([at('2026-09-10'), at('2026-10-15'), at('2026-11-03'), at('2026-11-25'), at('2026-12-15')].map((s) => s.id),
        ['turning-1', 'peak', 'fall-3', 'fall-6', 'winter-marcescent']);
    assert.equal(at('2026-09-10').turned, 0.25);
    assert.equal(at('2026-09-20').turned, 0.5);
    assert.equal(at('2026-10-05').turned, 0.75);
    // Peak colour holds today's crowns whole; early November sheds the
    // birches and poplars first and the oaks last.
    assert.deepEqual({ turned: at('2026-10-15').turned, ...at('2026-10-15').shed }, { turned: 1, oak: 0, willow: 0, birch: 0, maple: 0, poplar: 0 });
    assert.deepEqual({ ...at('2026-11-03').shed }, { oak: 0.3, willow: 0.35, birch: 0.7, maple: 0.6, poplar: 0.7 });
    assert.ok(at('2026-12-15').marcescent && !at('2027-01-10').marcescent);
    for (const species of SPECIES) {
        assert.equal(at('2026-12-15').shed[species], 1);
        assert.equal(at('2027-02-20').shed[species], 1);
        assert.equal(at('2027-06-10').shed[species], 0);
    }
    // Spring mirrors it: leaf-out from the bare sheet (willows and birches
    // first, oaks last), then the blossom.
    assert.equal(at('2027-03-05').id, 'spring-bare');
    assert.ok(at('2027-03-25').shed.willow < at('2027-03-25').shed.oak);
    assert.equal(at('2027-03-25').blossom, false);
    assert.equal(at('2027-04-10').blossom, true);
    assert.equal(at('2027-05-20').id, 'spring');
    // No date reads as summer, like the renderer's season.
    assert.equal(phenologyAt(null).id, 'summer');
    assert.equal(phenologyForAtmosphere(null).id, 'summer');
    assert.equal(phenologyForAtmosphere({ clock: { localDate: '2026-11-03' } }).id, 'fall-3');
    for (const row of PHENOLOGY_STAGES) {
        assert.equal(row.season, ['winter', 'winter', 'spring', 'spring', 'spring', 'summer', 'summer', 'summer', 'autumn', 'autumn', 'autumn', 'winter'][row.month], row.id);
    }
});

test('phenology stages nest monotonically through the year', () => {
    let previous = null;
    let changes = 0;
    let groundChanges = 0;
    const day = new Date(2026, 0, 1, 13);
    for (let n = 0; n < 365; n++, day.setDate(day.getDate() + 1)) {
        const stage = phenologyAt(day);
        if (previous && stage !== previous) {
            changes++;
            if (stage.ground !== previous.ground && stage.season === previous.season) groundChanges++;
            const month = day.getMonth();
            for (const species of SPECIES) {
                const was = previous.shed[species];
                const now = stage.shed[species];
                // A fallen clump never returns until spring; leaf-out never
                // drops a clump again before summer.
                if (month >= 8 || month <= 1) assert.ok(now >= was, `${species} ${stage.id}: ${was} -> ${now}`);
                if (month >= 2 && month <= 5) assert.ok(now <= was, `${species} ${stage.id}: ${was} -> ${now}`);
            }
            if (month >= 8 && month <= 10) assert.ok(stage.turned >= previous.turned, stage.id);
            if (month >= 2 && month <= 4) assert.ok(stage.blossom >= previous.blossom, stage.id);
        }
        previous = stage;
    }
    // Weekly stages, but few of them: each costs one canopy rebuild, and only
    // a ground change outside a season change costs an extra terrain rebake.
    assert.ok(changes <= PHENOLOGY_STAGES.length, String(changes));
    assert.ok(groundChanges <= 10, String(groundChanges));
});

test('canopyPlan reproduces the peak plans at turn 1 and turns crowns from the top', () => {
    for (const species of SPECIES) {
        for (const variant of [0, 1, 2]) {
            assert.equal(canopyPlan(species, variant, 'autumn', 1), canopyPlan(species, variant, 'autumn'));
            assert.equal(canopyPlan(species, variant, 'autumn', 0.5), canopyPlan(species, variant, 'autumn', 0.5), 'memoized');
        }
    }
    const { width, height, data } = sheet('veg.tree.oak.large', TREE_SPRITES['oak.large'].height);
    const indices = [];
    for (let i = 0; i < width * height * 4; i += 4) if (isCanopyPixel(data, i, Math.floor(i / 4 / width), height)) indices.push(i);
    const turnedShare = (variant, turn) => {
        const plan = canopyPlan('oak', variant, 'autumn', turn);
        const out = Uint8ClampedArray.from(data);
        recolorCanopy(out, width, height, plan);
        const peak = Uint8ClampedArray.from(data);
        recolorCanopy(peak, width, height, canopyPlan('oak', variant, 'autumn'));
        return indices.filter((i) => out[i] === peak[i] && out[i + 1] === peak[i + 1] && out[i + 2] === peak[i + 2]).length / indices.length;
    };
    // A fully recoloured crown (the russet oak) turns over its summer
    // colours toward the whole crown; the crown-only oak reaches its line at
    // peak and the whole crown by the end of the shed.
    const russet = [0.25, 0.5, 0.75, 1].map((turn) => turnedShare(1, turn));
    assert.ok(russet.every((share, k) => k === 0 || share >= russet[k - 1]), russet.join());
    assert.ok(russet[0] < 0.5 && russet[3] === 1, russet.join());
    const crown = canopyPlan('oak', 0, 'autumn', 2);
    assert.ok(crown.line > canopyPlan('oak', 0, 'autumn', 1.3).line && canopyPlan('oak', 0, 'autumn', 1.3).line > canopyPlan('oak', 0, 'autumn').line);
});

test('a fallen clump never returns: shedCanopy nests on the authored sheets', () => {
    for (const key of ['birch.large', 'poplar.tall', 'oak.small']) {
        const sprite = TREE_SPRITES[key];
        const leafy = sheet(sprite.id, sprite.height);
        const bare = sheet(TREE_SPRITES[sprite.bare].id, sprite.height);
        const { width, height } = leafy;
        const recoloured = Uint8ClampedArray.from(leafy.data);
        recolorCanopy(recoloured, width, height, canopyPlan(key.slice(0, key.indexOf('.')), 2, 'autumn'));
        const palette = new Set();
        for (let i = 0; i < recoloured.length; i += 4) {
            if (isCanopyPixel(leafy.data, i, Math.floor(i / 4 / width), height)) palette.add(recoloured[i] << 16 | recoloured[i + 1] << 8 | recoloured[i + 2]);
        }
        const same = (a, b, i) => a[i] === b[i] && a[i + 1] === b[i + 1] && a[i + 2] === b[i + 2] && a[i + 3] === b[i + 3];
        let fallen = null;
        for (const share of [0, 0.15, 0.35, 0.6, 0.85, 0.99]) {
            const out = Uint8ClampedArray.from(recoloured);
            shedCanopy(out, leafy.data, bare.data, width, height, share, 18);
            const now = new Set();
            for (let i = 0; i < out.length; i += 4) {
                if (same(out, recoloured, i)) continue;
                if (same(out, bare.data, i)) { now.add(i); continue; }
                // A kept texel that changed is a new crown edge: its clump's
                // own colour, still on the canopy ramp.
                assert.ok(palette.has(out[i] << 16 | out[i + 1] << 8 | out[i + 2]), `${key} ${share}: off-ramp edge at ${i}`);
            }
            if (share === 0) assert.equal(now.size, 0);
            if (fallen) for (const i of fallen) assert.ok(now.has(i), `${key}: texel ${i} came back at ${share}`);
            fallen = now;
        }
        assert.ok(fallen.size > 0, key);
        const whole = Uint8ClampedArray.from(recoloured);
        shedCanopy(whole, leafy.data, bare.data, width, height, 1, 18);
        assert.deepEqual(whole, bare.data);
    }
    // The bare sheet is shown once a crown has fully shed (in any season).
    assert.equal(treeStateKey('birch.large', 'autumn', 0, 1), 'birch.large.bare');
    assert.equal(treeStateKey('birch.large', 'autumn', 0, 0.7), 'birch.large');
    assert.equal(treeStateKey('birch.large', 'winter', 0), 'birch.large.bare');
    assert.equal(treeStateKey('pine.large', 'autumn', 0, 1), 'pine.large');
});

// A coast lattice with one river current cell (and one swell cell, one
// covered current cell) around the river's first reach, at tile (5, 25).
function riverFixture() {
    const wx = (5 - 25) * TILE_WIDTH / 2;
    const wy = (5 + 25) * TILE_HEIGHT / 2;
    const fields = { x: wx - 4, y: wy - 4, cols: 4, rows: 4, cycleOffset: new Uint8Array(16).fill(255), coastField: new Uint8Array(32) };
    fields.cycleOffset[2 * 4 + 2] = 16 + 7;
    fields.cycleOffset[2 * 4 + 1] = 7;
    fields.cycleOffset[1 * 4 + 2] = 16 + 3;
    fields.coastField[(1 * 4 + 2) * 2 + 1] = COAST_FIELD_FLAGS.covered | COAST_FIELD_FLAGS.water;
    return { renderer: { _coastBake: { waterFields: fields } }, wx, wy };
}

test('riverCurrentAt runs downstream along the river axis, on its current course only', () => {
    const { renderer, wx, wy } = riverFixture();
    const current = riverCurrentAt(renderer, wx + 1, wy + 1);
    // The first reach runs +x in tiles: down-right on screen, toward the harbor.
    const length = Math.hypot(TILE_WIDTH / 2, TILE_HEIGHT / 2);
    assert.ok(Math.abs(current.x - TILE_WIDTH / 2 / length) < 1e-9 && Math.abs(current.y - TILE_HEIGHT / 2 / length) < 1e-9, JSON.stringify(current));
    assert.equal(riverCurrentAt(renderer, wx - 1, wy + 1), null, 'a swell cell is no current');
    assert.equal(riverCurrentAt(renderer, wx + 1, wy - 1), null, 'never under a bridge or pier');
    assert.equal(riverCurrentAt(renderer, wx + 100, wy), null);
    assert.equal(riverCurrentAt({}, wx, wy), null);
});

function driftFixture({ riverAt = null, weather = { type: 'partly-cloudy', windX: 0.55, seed: 3 } } = {}) {
    const spawned = [];
    const atmosphere = { phase: 'day', clock: { date: new Date(2026, 10, 3, 13) }, weather };
    const ambience = new SeasonalAmbience({
        particleSystem: { countTagged: () => 0, spawn: (type, x, y, count, options) => spawned.push({ type, x, y, options }) },
        atmosphereStateGetter: () => atmosphere,
        motionScaleGetter: () => 1,
        cameraGetter: () => ({ zoom: 2, screenToWorld: (x, y) => ({ x, y }) }),
        anchorsProvider: (kind) => (kind === 'canopy' ? [{ x: 100, y: 200, lift: 31 }] : []),
        motionTimeGetter: () => 0,
        riverCurrentAt: riverAt,
    });
    return { ambience, spawned, atmosphere };
}

test('autumn leaves lean downwind with the one wind', () => {
    const { ambience, spawned, atmosphere } = driftFixture();
    for (let k = 0; k < 20; k++) ambience.update(100);
    assert.ok(spawned.length > 0 && spawned.every((s) => s.type === 'leaf'));
    const expected = windAt(100, 200, 0, atmosphere.weather).x * 0.5;
    for (const { options } of spawned) {
        assert.equal(options.windX, expected);
        assert.ok(options.windX > 0, 'downwind of a +x knot wind');
        assert.equal(options.landY, undefined, 'a leaf over land fades in the air as before');
    }
});

test('petals wait for the blossom', () => {
    const { ambience, spawned, atmosphere } = driftFixture();
    atmosphere.clock.date = new Date(2027, 2, 25, 13);
    for (let k = 0; k < 20; k++) ambience.update(100);
    assert.equal(spawned.length, 0, 'no petals from bare crowns');
    atmosphere.clock.date = new Date(2027, 3, 20, 13);
    for (let k = 0; k < 20; k++) ambience.update(100);
    assert.ok(spawned.length > 0 && spawned.every((s) => s.type === 'petal'));
});

test('a leaf whose fall ends on the river floats downstream, held flat', () => {
    const lands = [];
    const { ambience, spawned } = driftFixture({ riverAt: (x, y) => { lands.push({ x, y }); return { x: 0.894, y: 0.447 }; } });
    for (let k = 0; k < 20; k++) ambience.update(100);
    assert.ok(spawned.length > 0);
    const { options, x, y } = spawned[0];
    // It falls straight from the canopy to its ground line, drifting with
    // the wind, so the landing is known at spawn.
    assert.equal(options.landY, y + 31);
    assert.equal(lands[0].y, y + 31);
    assert.ok(Math.abs(lands[0].x - (x + options.windX * 31 / 0.09)) < 1e-9);
    assert.deepEqual([options.lateral, options.spread, options.speed], [0, 0, 0]);
    // A real particle: it lands, stops falling, floats along the current
    // without tumbling and fades only on the water.
    const particles = new ParticleSystem();
    particles.spawn('leaf', x, y, 1, { ...options, calm: false, pressureLevel: 0 });
    const leaf = particles.particles[0];
    assert.ok(leaf, 'spawned');
    const views = { f32: new Float32Array(16), u8: new Uint8Array(64), u16: new Uint16Array(32), capacity: 1 };
    const fallFrames = Math.ceil(31 / 0.09);
    for (let k = 0; k < fallFrames - 2; k++) particles.update(16);
    assert.equal(leaf.floating, false, 'still falling');
    assert.equal(particles.packGpuInstances(views), 1);
    assert.equal(views.u8[19], 255, 'solid while it falls');
    for (let k = 0; k < 4; k++) particles.update(16);
    assert.equal(leaf.floating, true);
    // Landed on its ground line, then carried only by the current.
    assert.ok(leaf.y >= options.landY && leaf.y - options.landY <= 4 * 0.447 * 0.13 + 1e-9, String(leaf.y - options.landY));
    const before = { x: leaf.x, y: leaf.y };
    particles.update(16);
    assert.ok(leaf.x > before.x && leaf.y > before.y, 'downstream');
    assert.ok(Math.hypot(leaf.x - before.x, leaf.y - before.y) <= 0.2, 'no faster than a texel per 80 ms');
    assert.equal(particles.packGpuInstances(views), 1);
    assert.deepEqual([views.f32[2], views.f32[3]], [2, 1], 'held flat on the water');
    assert.ok(views.u8[19] < 255 && views.u8[19] > 0, 'fading on the water');
    // A leaf over land still spawns as before (no landing).
    const { ambience: dry, spawned: drySpawned } = driftFixture({ riverAt: () => null });
    for (let k = 0; k < 20; k++) dry.update(100);
    assert.ok(drySpawned.length > 0 && drySpawned.every((s) => s.options.landY === undefined && s.options.spread === 2));
});
