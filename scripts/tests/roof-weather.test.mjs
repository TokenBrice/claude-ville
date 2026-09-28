import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PNG } from 'pngjs';

import {
    paintRoofWeather,
    roofSnowPixels,
    roofWeatherMap,
    roofWetQuantum,
} from '../../claudeville/src/presentation/character-mode/RoofWeather.js';

const DIR = new URL('../../claudeville/assets/sprites/buildings/', import.meta.url);
const FABRIC = 5;

function landmark(type) {
    const read = (name) => {
        try {
            return PNG.sync.read(readFileSync(new URL(`building.${type}/${name}`, DIR)));
        } catch {
            return null;
        }
    };
    const albedo = read('base.png');
    const occluder = read('base.occluder.png');
    const material = read('base.material.png');
    const emissive = read('base.emissive.png');
    const map = roofWeatherMap({
        width: albedo.width,
        height: albedo.height,
        albedo: albedo.data,
        occluder: occluder.data,
        material: material?.data || null,
        emissive: emissive?.data || null,
    });
    return { albedo, occluder, material, emissive, map };
}

function paint(sprite, state) {
    const { map, albedo } = sprite;
    const out = new Uint8ClampedArray(map.w * map.h * 4);
    const written = paintRoofWeather(map, albedo.data, out, state);
    const texels = [];
    for (let y = 0; y < map.h; y++) {
        for (let x = 0; x < map.w; x++) {
            if (out[(y * map.w + x) * 4 + 3]) texels.push((y + map.top) * albedo.width + x + map.left);
        }
    }
    return { written, texels };
}
// The 2.3 surface channel's face class (occluder B >> 6; 3 = roof).
function face(sprite, p) {
    const { data } = sprite.occluder;
    return data[p * 4 + 3] > 0 ? data[p * 4 + 2] >> 6 : -1;
}
// Roof: face 3, or a face-tag speck inside the roof (a 4-connected knot of
// at most 8 opaque texels tagged otherwise, bordered by face 3 all round).
function onRoof(sprite, p) {
    if (face(sprite, p) === 3) return true;
    const { width, height, data } = sprite.albedo;
    const knot = [p];
    const seen = new Set(knot);
    for (let k = 0; k < knot.length; k++) {
        const q0 = knot[k];
        const x = q0 % width;
        for (const [q, inside] of [[q0 - 1, x > 0], [q0 + 1, x + 1 < width], [q0 - width, q0 >= width], [q0 + width, q0 + width < width * height]]) {
            if (!inside || data[q * 4 + 3] < 128) return false;
            if (face(sprite, q) === 3 || seen.has(q)) continue;
            seen.add(q);
            knot.push(q);
            if (knot.length > 8) return false;
        }
    }
    return true;
}
// Open sky within four rows above (an ink outline plus a three-row cap): a
// silhouette-cap texel.
function underSky(sprite, p) {
    const { width } = sprite.albedo;
    for (let d = 1; d <= 4; d++) {
        const q = p - d * width;
        if (q < 0 || sprite.albedo.data[q * 4 + 3] < 128) return true;
    }
    return false;
}

test('clear, dry weather paints nothing on any landmark roof', () => {
    for (const type of ['command', 'archive', 'forge', 'harbor', 'mine']) {
        const sprite = landmark(type);
        assert.equal(paint(sprite, { bucket: 0, wetQ: 0 }).written, 0, type);
    }
});

test('snow lies only on roof texels and silhouette tops, never on glass, fabric or gold trim', () => {
    for (const type of ['command', 'archive', 'forge', 'observatory', 'taskboard']) {
        const sprite = landmark(type);
        const { texels } = paint(sprite, { bucket: 4, wetQ: 0 });
        assert.ok(texels.length > 500, `${type} takes snow`);
        for (const p of texels) {
            assert.ok(onRoof(sprite, p) || underSky(sprite, p), `${type} texel ${p} is roof or a silhouette top`);
            if (sprite.emissive) assert.ok(sprite.emissive.data[p * 4 + 3] <= 25, `${type} glass texel ${p} stays bare`);
            if (sprite.material?.data[p * 4 + 3] > 0) assert.notEqual(sprite.material.data[p * 4], FABRIC, `${type} fabric texel ${p} stays bare`);
        }
    }
    // The Command dome's gold ribs, ring and finial stay gold under a full cover.
    const command = landmark('command');
    const { texels } = paint(command, { bucket: 4, wetQ: 0 });
    const gold = texels.filter((p) => {
        const [r, g, b] = command.albedo.data.subarray(p * 4, p * 4 + 3);
        return r > 150 && g > 100 && b < 80 && r - b > 100;
    });
    assert.equal(gold.length, 0);
});

test('snow cover grows with every quarter', () => {
    const sprite = landmark('archive');
    const counts = [1, 2, 3, 4].map((bucket) => paint(sprite, { bucket, wetQ: 0 }).written);
    for (let i = 1; i < counts.length; i++) assert.ok(counts[i] > counts[i - 1], `bucket ${i + 1} > bucket ${i}`);
});

test('the wet course follows the roof edges, a small share of the roof, stepping by wetness quanta', () => {
    const sprite = landmark('archive');
    const wet = paint(sprite, { bucket: 0, wetQ: 4 });
    assert.ok(wet.texels.length > 50);
    for (const p of wet.texels) assert.ok(onRoof(sprite, p));
    // A course, not a recolour: a small share of the roof.
    let roof = 0;
    for (let p = 0; p < sprite.albedo.width * sprite.albedo.height; p++) {
        if (sprite.albedo.data[p * 4 + 3] >= 128 && face(sprite, p) === 3) roof++;
    }
    assert.ok(wet.texels.length < roof * 0.1);
    assert.deepEqual([0, 0.01, 0.2, 0.3, 0.6, 0.9, 1].map(roofWetQuantum), [0, 0, 1, 2, 3, 4, 4]);
});

test('a landmark without roof faces still takes silhouette caps but no wet course', () => {
    const sprite = landmark('portal');
    assert.ok(paint(sprite, { bucket: 4, wetQ: 0 }).written > 0);
    assert.equal(paint(sprite, { bucket: 0, wetQ: 4 }).written, 0);
    assert.equal(sprite.map.drips.length, 0);
});

test('snow never lies on the Command drum wall under the gold ring', () => {
    // Independent of the face class and the colour gate: in each drum column
    // the lowest warm-metal texel (the ring) ends the dome; the stone band
    // below it down to the keep roof is wall at every bucket.
    const sprite = landmark('command');
    const { width } = sprite.albedo;
    const metal = (p) => {
        const [r, g, b] = sprite.albedo.data.subarray(p * 4, p * 4 + 3);
        return r > g && g > b && r - b > 60;
    };
    for (const bucket of [1, 2, 3, 4]) {
        const painted = new Set(paint(sprite, { bucket, wetQ: 0 }).texels);
        let columns = 0;
        for (let x = 140; x <= 210; x++) {
            let ring = -1;
            for (let y = 60; y < 100; y++) if (metal(y * width + x)) ring = y;
            if (ring < 0) continue;
            columns++;
            for (let y = ring + 1; y < 112; y++) assert.ok(!painted.has(y * width + x), `bucket ${bucket}: drum texel ${x},${y} stays bare`);
        }
        assert.ok(columns > 50);
    }
});

test('portholes, cupola openings and other dark glass stay bare under any cover', () => {
    // Openings by shape, not by the emissive sidecar: texels inside a 3x3
    // block of near-black albedo.
    for (const type of ['observatory', 'forge', 'watchtower', 'archive']) {
        const sprite = landmark(type);
        const { width, height, data } = sprite.albedo;
        const dark = (x, y) => data[(y * width + x) * 4 + 3] >= 128 && Math.max(data[(y * width + x) * 4], data[(y * width + x) * 4 + 1], data[(y * width + x) * 4 + 2]) < 32;
        const opening = new Uint8Array(width * height);
        for (let y = 0; y + 2 < height; y++) {
            for (let x = 0; x + 2 < width; x++) {
                let all = true;
                for (let k = 0; k < 9 && all; k++) all = dark(x + (k % 3), y + Math.floor(k / 3));
                if (all) for (let k = 0; k < 9; k++) opening[(y + Math.floor(k / 3)) * width + x + (k % 3)] = 1;
            }
        }
        if (type === 'observatory') assert.ok(opening.reduce((s, v) => s + v, 0) > 500, 'the portholes are found');
        for (const bucket of [1, 2, 3, 4]) {
            for (const p of paint(sprite, { bucket, wetQ: 0 }).texels) assert.equal(opening[p], 0, `${type} b${bucket}: opening texel ${p} stays bare`);
        }
    }
});

test('a full cover keeps the lit pitch lighter than the shaded one', () => {
    // The Observatory dome: its upper-left pitch left of the central rib is
    // lit, the right one shaded; under snow the shaded pitch stays darker.
    const sprite = landmark('observatory');
    const { data } = sprite.albedo;
    const { map } = sprite;
    const out = new Uint8ClampedArray(map.w * map.h * 4);
    paintRoofWeather(map, data, out, { bucket: 4 });
    const mean = [[0, 0], [0, 0]];
    for (let y = 60; y < 118; y++) {
        for (let x = map.left; x < map.left + map.w; x++) {
            const o = ((y - map.top) * map.w + x - map.left) * 4;
            if (!out[o + 3] || x < 60 || x > 150) continue;
            const side = x < 104 ? 0 : 1;
            mean[side][0] += 0.2126 * out[o] + 0.7152 * out[o + 1] + 0.0722 * out[o + 2];
            mean[side][1]++;
        }
    }
    const lit = mean[0][0] / mean[0][1];
    const shade = mean[1][0] / mean[1][1];
    assert.ok(lit - shade > 10, `lit ${lit.toFixed(1)} vs shade ${shade.toFixed(1)}`);
});

test('a scenery roof takes snow only inside its roof polygon', () => {
    // The gate tower's stone shares the slate's blue: only the roof snows.
    const png = PNG.sync.read(readFileSync(new URL('../../claudeville/assets/sprites/props/prop.villageGateTower.png', import.meta.url)));
    const poly = [[60, 18], [112, 30], [112, 50], [96, 100], [38, 78]];
    const data = Uint8ClampedArray.from(png.data);
    assert.ok(roofSnowPixels(data, png.width, png.height, 4, { poly }) > 500);
    for (let y = 101; y < png.height; y++) {
        for (let x = 0; x < png.width; x++) {
            const i = (y * png.width + x) * 4;
            assert.deepEqual([...data.subarray(i, i + 4)], [...png.data.subarray(i, i + 4)], `stone texel ${x},${y} stays bare`);
        }
    }
});

// Texels left as authored with snow painted on all eight sides: a dark dot
// in a full cover (`keep`: texels allowed to stay, the roof's own outline
// against a capped wall or parapet).
function specks(width, height, painted, keep = () => false) {
    let n = 0;
    for (let y = 1; y + 1 < height; y++) {
        for (let x = 1; x + 1 < width; x++) {
            if (painted[y * width + x] || keep(y * width + x)) continue;
            let all = true;
            for (let k = 0; k < 9 && all; k++) all = k === 4 || painted[(y + Math.floor(k / 3) - 1) * width + x + (k % 3) - 1] === 1;
            if (all) n++;
        }
    }
    return n;
}

test('a full cover leaves no dark specks where joints cross', () => {
    for (const type of ['command', 'forge', 'archive', 'harbor', 'observatory', 'taskboard']) {
        const sprite = landmark(type);
        const painted = new Uint8Array(sprite.albedo.width * sprite.albedo.height);
        for (const p of paint(sprite, { bucket: 4, wetQ: 0 }).texels) painted[p] = 1;
        const { width } = sprite.albedo;
        const outline = (p) => [p - 1, p + 1, p - width, p + width].some((q) => face(sprite, q) !== 3);
        assert.equal(specks(width, sprite.albedo.height, painted, outline), 0, type);
    }
    for (const [id, poly, pitch] of [
        ['prop.villageGateTower', [[60, 18], [112, 30], [112, 50], [96, 100], [38, 78]], true],
        ['prop.villageWallSeaTower', [[96, 28], [154, 58], [152, 64], [96, 90], [38, 58], [40, 52]], false],
    ]) {
        const png = PNG.sync.read(readFileSync(new URL(`../../claudeville/assets/sprites/props/${id}.png`, import.meta.url)));
        const data = Uint8ClampedArray.from(png.data);
        roofSnowPixels(data, png.width, png.height, 4, { poly, pitch });
        const painted = new Uint8Array(png.width * png.height);
        for (let p = 0; p < painted.length; p++) if (data[p * 4] !== png.data[p * 4] || data[p * 4 + 2] !== png.data[p * 4 + 2]) painted[p] = 1;
        assert.equal(specks(png.width, png.height, painted), 0, id);
    }
});

test('a gate tower roof snows as one cap down from its top, never in streaks', () => {
    // Drawn at 0.72, its 1-row course lips would resample to static: each
    // column's snow is one run from the column's top roof texel.
    const png = PNG.sync.read(readFileSync(new URL('../../claudeville/assets/sprites/props/prop.villageGateTower.png', import.meta.url)));
    const poly = [[60, 18], [112, 30], [112, 50], [96, 100], [38, 78]];
    for (const bucket of [1, 2, 3]) {
        const data = Uint8ClampedArray.from(png.data);
        roofSnowPixels(data, png.width, png.height, bucket, { poly, pitch: true });
        // Columns whose snow breaks into several runs (a gap of 2+ bare
        // texels; a single one is the cap's dithered edge).
        let broken = 0;
        let columns = 0;
        for (let x = 0; x < png.width; x++) {
            let runs = 0;
            let gap = 2;
            for (let y = 0; y < png.height; y++) {
                const i = (y * png.width + x) * 4;
                if (data[i] !== png.data[i] || data[i + 2] !== png.data[i + 2]) {
                    if (gap >= 2) runs++;
                    gap = 0;
                } else {
                    gap++;
                }
            }
            if (runs) columns++;
            if (runs > 1) broken++;
        }
        assert.ok(columns > 40, `b${bucket}: the cap spans the roof`);
        assert.ok(broken <= columns * 0.2, `b${bucket}: ${broken} of ${columns} columns break into several runs`);
    }
});

test('the Lighthouse finial stays brass under any cover', () => {
    const sprite = landmark('watchtower');
    const { width } = sprite.albedo;
    // The cap: its widest roof row; the finial: the roof-face texels above
    // the first row a third that wide (the ridge).
    const rows = new Map();
    for (let p = 0; p < width * sprite.albedo.height; p++) {
        if (sprite.albedo.data[p * 4 + 3] >= 128 && face(sprite, p) === 3) rows.set(Math.floor(p / width), (rows.get(Math.floor(p / width)) || 0) + 1);
    }
    const widest = Math.max(...rows.values());
    const ridge = Math.min(...[...rows].filter(([, count]) => count >= widest / 3).map(([y]) => y));
    for (const bucket of [1, 2, 3, 4]) {
        const { texels } = paint(sprite, { bucket, wetQ: 0 });
        const finial = texels.filter((p) => Math.floor(p / width) < ridge);
        assert.equal(finial.length, 0, `b${bucket}: ${finial.length} snow texels on the finial`);
    }
});
