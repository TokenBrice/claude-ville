import test from 'node:test';
import assert from 'node:assert/strict';
import { MAP_SIZE, TILE_WIDTH, TILE_HEIGHT } from '../../claudeville/src/config/constants.js';
import { ART_RAMPS } from '../../claudeville/src/config/artPalette.js';
import {
    bathyOffset, COAST_FIELD_FLAGS, COAST_WATER_STOPS, MAX_CONTACT_GAP, registerCoastBake,
    seaBandBend, waterlineProfile,
} from '../../claudeville/src/presentation/character-mode/CoastBake.js';
import { sunSparkAt } from '../../claudeville/src/presentation/character-mode/CanvasWaterState.js';
import { buildCloudShadowTile, CUMULUS_STAMPS, cumulusCount } from '../../claudeville/src/presentation/character-mode/gpu/GpuWorldPolicy.js';

test('authored bathymetry dredges the channel and shoals the bar and the stack reefs', () => {
    assert.equal(bathyOffset(33.5, 22), 1.2);
    assert.equal(bathyOffset(-1.4, 31), -0.9);
    assert.equal(bathyOffset(35, 0.5), -1);
    assert.ok(bathyOffset(35, -0.3) > -1);
    assert.equal(bathyOffset(15, 20), 0);
});

test('cloud atlas admits the six lobe groups in order, with a rim around each core', () => {
    const size = 256, data = buildCloudShadowTile(size);
    const read = (x, y, channel) => data[4 * ((Math.floor(y * size / 1280) & 255) * size + (Math.floor(x * size / 3200) & 255)) + channel];
    for (const [k, [x, y, lobes]] of CUMULUS_STAMPS.entries()) {
        assert.equal(cumulusCount((k + 1) * 0.38 / 6), k + 1);
        for (const [dx, dy] of lobes) {
            assert.equal(read(x + dx, y + dy, 1), k + 1);
            assert.ok(read(x + dx, y + dy, 2) < 0.55 * 128);
        }
        let rim = 0;
        for (let i = 0; i < data.length; i += 4) {
            if (data[i + 1] === k + 1 && data[i + 2] > 0.55 * 128 && data[i + 2] <= 128) rim++;
        }
        assert.ok(rim > 0);
    }
    assert.equal(cumulusCount(0), 0);
    assert.equal(cumulusCount(1), 6);
});

test('eight spark frames stay sparse, with one or two adjacent pixels wholly inside a 6×3 cell', () => {
    for (let step = 0; step < 8; step++) {
        let count = 0;
        for (let y = -48; y < 48; y += 3) for (let x = -120; x < 120; x += 6) {
            const hits = [];
            for (let j = 0; j < 3; j++) for (let i = 0; i < 6; i++) {
                if (!sunSparkAt(x + i, y + j, step)) continue;
                assert.equal(j, 1);
                assert.ok(i > 0 && i < 5);
                hits.push(i);
            }
            assert.ok(hits.length <= 2);
            if (hits.length === 2) assert.equal(hits[1] - hits[0], 1);
            count += hits.length;
        }
        const share = count / (240 * 96);
        assert.ok(share > 0.002 && share < 0.008, String(share));
    }
});

test('pier columns stay independent and arch shadow fill does not lower the contact', () => {
    const w = 32, h = 20, data = new Uint8Array(w * h * 4);
    const pixel = (x, y, value) => data.set([value, value, value, 255], 4 * (y * w + x));
    for (let x = 0; x < w; x++) pixel(x, 12, 100);
    for (let y = 13; y < h; y++) { pixel(5, y, 100); pixel(12, y, 12); }
    const sheet = { w, h, data };
    assert.equal(waterlineProfile(sheet, 100).axis[6], 120);
    assert.equal(waterlineProfile(sheet, 100, { pierColumn: () => true }).axis[6], 113);
    assert.equal(waterlineProfile(sheet, 100, { bridge: true }).axis[12], 117);
    assert.equal(MAX_CONTACT_GAP, 10);
});

test('the baked river has four stops, independent bank materials and no beach swash', () => {
    const renderer = { waterTiles: new Set(), waterMeta: new Map(), pathTiles: new Set(), bridgeTiles: new Set() };
    for (let u = 3; u <= 33; u++) for (let v = 25; v <= 28; v++) {
        const key = `${u},${v}`;
        renderer.waterTiles.add(key);
        renderer.waterMeta.set(key, { region: 'river' });
    }
    const passes = [];
    renderer.registerTerrainBakePass = p => { passes.push(p); return () => {}; };
    registerCoastBake(renderer);
    let image;
    const ctx = {
        getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }),
        getImageData(x, y, w, h) {
            if (w === 1) return { data: new Uint8ClampedArray(4) };
            return image || { data: new Uint8ClampedArray(w * h * 4) };
        },
        putImageData(value) { image = value; },
    };
    passes[0].draw(ctx, renderer);
    const coast = renderer._coastBake.coast;
    const { role, w } = coast.baked;
    assert.equal(coast.bankZone.length, MAP_SIZE ** 2);
    assert.ok(coast.bankZone.includes(1) && coast.bankZone.includes(2) && coast.bankZone.includes(4));
    assert.equal(coast.bankZone, renderer.coastField.bankZone);
    const stops = new Set();
    let faces = 0, wetRows = 0;
    const tide = new Set(ART_RAMPS.tideline.map(hex => parseInt(hex.slice(1), 16)));
    for (const [x, feet] of coast.contactFoot) for (const y of feet) {
        const u = y / TILE_HEIGHT + x / TILE_WIDTH, v = y / TILE_HEIGHT - x / TILE_WIDTH;
        if (u < 6 || u > 32 || v < 24 || v > 30) continue;
        const at = (y - coast.y) * w + x - coast.x;
        const o = (at - w) * 4;
        if (role[at - w] === 250) {
            faces++;
            if (tide.has((image.data[o] << 16) | (image.data[o + 1] << 8) | image.data[o + 2])) wetRows++;
        }
        for (let k = 0; k < 85; k++) {
            const stop = role[at + k * w] - 3;
            if (stop >= 0 && stop < COAST_WATER_STOPS.length) stops.add(stop);
        }
    }
    assert.ok(faces > 300 && wetRows > faces * 0.7);
    assert.deepEqual([...stops].sort(), [0, 1, 2, 3]);
    passes[1].draw(ctx, renderer);
    const f = renderer._coastBake.waterFields;
    let threads = 0, collars = 0;
    for (let i = 0; i < f.cycleOffset.length; i++) {
        const x = f.x + (i % f.cols) * 2 + 1, y = f.y + Math.floor(i / f.cols) * 2 + 1;
        const u = y / TILE_HEIGHT + x / TILE_WIDTH, v = y / TILE_HEIGHT - x / TILE_WIDTH;
        if (u < 6 || u > 32 || v < 24 || v > 29) continue;
        const flags = f.coastField[2 * i + 1];
        assert.equal(flags & (COAST_FIELD_FLAGS.sea | COAST_FIELD_FLAGS.lagoon | COAST_FIELD_FLAGS.swash), 0);
        if (f.cycleOffset[i] >= 16 && f.cycleOffset[i] < 32) threads++;
        if (flags & COAST_FIELD_FLAGS.cliffSurf) collars++;
    }
    assert.ok(threads > 100 && collars > 100);
});

test('outer body and shelf contours bend in all three authored seam bands', () => {
    for (const band of [7, 8, 9]) {
        let run = 0, previous;
        for (let x = -1280; x < 1280; x++) {
            const bend = seaBandBend(x, band);
            assert.equal(bend, seaBandBend(x + 1280, band));
            run = bend === previous ? run + 1 : 1;
            previous = bend;
            assert.ok(run <= 200, `band ${band}, x ${x}`);
        }
    }
});
