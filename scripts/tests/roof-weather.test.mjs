import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PNG } from 'pngjs';

import {
    ROOF_GLINT_BOX,
    roofGlintBox,
    roofSunVerdict,
    ROOF_GLINT_TEXELS,
    paintRoofWeather,
    roofGlintRun,
    roofGlintSide,
    roofSnowPixels,
    roofWeatherMap,
    roofWetQuantum,
} from '../../claudeville/src/presentation/character-mode/RoofWeather.js';
import { createAtmosphereSnapshot } from '../../claudeville/src/presentation/character-mode/AtmosphereState.js';
import { BuildingSprite } from '../../claudeville/src/presentation/character-mode/BuildingSprite.js';
import { ART_RAMPS } from '../../claudeville/src/config/artPalette.js';
import { castLightingFor, sunSweepFor } from '../../claudeville/src/presentation/character-mode/RakingLight.js';
import { collectSpriteEntries, loadSpriteManifest } from '../sprites/manifest-utils.mjs';
import {
    SHADE_SURFACE,
    buildShadeField,
    createShadeViewBuild,
    massingFacets,
    shadeFieldRect,
    shadeSurfaceAt,
} from '../../claudeville/src/presentation/character-mode/ShadeField.js';
import { BUILDING_DEFS } from '../../claudeville/src/config/buildings.js';
import { LANDMARK_MASSING } from '../../claudeville/src/config/landmarkMassing.js';
import { buildingCenterToWorld } from '../../claudeville/src/presentation/character-mode/Projection.js';
import { WINTER_PROPS } from '../../claudeville/src/presentation/character-mode/PropWinter.js';

// A baked scenery prop and its roof polygons (PropWinter's spec, without caps).
function sceneryRoof(id) {
    const png = PNG.sync.read(readFileSync(new URL(`../../claudeville/assets/sprites/props/${id}.png`, import.meta.url)));
    const { poly, polys } = WINTER_PROPS[id].roof;
    return { png, roof: polys ? { polys } : { poly } };
}

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
    for (const type of ['command', 'archive', 'forge', 'tavern', 'taskboard']) {
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
    const sprite = landmark('mine');
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
    for (const type of ['tavern', 'forge', 'watchtower', 'archive']) {
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
        for (const bucket of [1, 2, 3, 4]) {
            for (const p of paint(sprite, { bucket, wetQ: 0 }).texels) assert.equal(opening[p], 0, `${type} b${bucket}: opening texel ${p} stays bare`);
        }
    }
});

test('a full cover keeps the lit pitch lighter than the shaded one', () => {
    // The Tavern's dormer: its upper-left pitch left of the ridge is lit, the
    // right one shaded; under snow the shaded pitch stays darker.
    const sprite = landmark('tavern');
    const { data } = sprite.albedo;
    const { map } = sprite;
    const out = new Uint8ClampedArray(map.w * map.h * 4);
    paintRoofWeather(map, data, out, { bucket: 4 });
    const mean = [[0, 0], [0, 0]];
    for (let y = 50; y < 80; y++) {
        for (let x = map.left; x < map.left + map.w; x++) {
            const o = ((y - map.top) * map.w + x - map.left) * 4;
            if (!out[o + 3] || x < 115 || x > 160) continue;
            const side = x < 135 ? 0 : 1;
            mean[side][0] += 0.2126 * out[o] + 0.7152 * out[o + 1] + 0.0722 * out[o + 2];
            mean[side][1]++;
        }
    }
    const lit = mean[0][0] / mean[0][1];
    const shade = mean[1][0] / mean[1][1];
    assert.ok(lit - shade > 10, `lit ${lit.toFixed(1)} vs shade ${shade.toFixed(1)}`);
});

test('a scenery roof takes snow only inside its roof polygons', () => {
    // The gatehouse's glass and portcullis share the slate's blue and its
    // sign is gilt on crimson: only the two cones snow as roof.
    const { png, roof } = sceneryRoof('prop.villageGate');
    const data = Uint8ClampedArray.from(png.data);
    assert.ok(roofSnowPixels(data, png.width, png.height, 4, roof) > 500);
    const lowest = Math.max(...roof.polys.flat().map(([, y]) => y));
    const westEdge = Math.max(...roof.polys[0].map(([x]) => x));
    const eastEdge = Math.min(...roof.polys[1].map(([x]) => x));
    for (let y = 0; y < png.height; y++) {
        for (let x = 0; x < png.width; x++) {
            // Below the lower cone, and the arch block between the cones.
            if (!(y > lowest || (x > westEdge && x < eastEdge))) continue;
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
    for (const type of ['command', 'forge', 'archive', 'harbor', 'tavern', 'taskboard']) {
        const sprite = landmark(type);
        const painted = new Uint8Array(sprite.albedo.width * sprite.albedo.height);
        for (const p of paint(sprite, { bucket: 4, wetQ: 0 }).texels) painted[p] = 1;
        const { width } = sprite.albedo;
        const outline = (p) => [p - 1, p + 1, p - width, p + width].some((q) => face(sprite, q) !== 3);
        assert.equal(specks(width, sprite.albedo.height, painted, outline), 0, type);
    }
    for (const id of ['prop.villageGate', 'prop.villageWallSeaTower']) {
        const { png, roof } = sceneryRoof(id);
        const data = Uint8ClampedArray.from(png.data);
        roofSnowPixels(data, png.width, png.height, 4, roof);
        const painted = new Uint8Array(png.width * png.height);
        for (let p = 0; p < painted.length; p++) if (data[p * 4] !== png.data[p * 4] || data[p * 4 + 2] !== png.data[p * 4 + 2]) painted[p] = 1;
        assert.equal(specks(png.width, png.height, painted), 0, id);
    }
});

// Warm saturated trim (gilt and brass): HSV hue 20-60, S >= 0.45.
function brass(sprite, p) {
    const [r, g, b] = sprite.albedo.data.subarray(p * 4, p * 4 + 3);
    const max = Math.max(r, g, b);
    const d = max - Math.min(r, g, b);
    if (!d || d / max < 0.45) return false;
    const h = max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return h * 60 >= 20 && h * 60 <= 60;
}

test('the Lighthouse finial stays brass under any cover', () => {
    const sprite = landmark('watchtower');
    const { width } = sprite.albedo;
    // The cap (the crown's roof, in the sprite's top third, above the keeper's
    // cottage roof): its widest roof row; the finial: the roof-face texels
    // above the first row a third that wide (the ridge).
    const crown = Math.floor(sprite.albedo.height / 3);
    const rows = new Map();
    for (let p = 0; p < width * crown; p++) {
        if (sprite.albedo.data[p * 4 + 3] >= 128 && face(sprite, p) === 3) rows.set(Math.floor(p / width), (rows.get(Math.floor(p / width)) || 0) + 1);
    }
    const widest = Math.max(...rows.values());
    const ridge = Math.min(...[...rows].filter(([, count]) => count >= widest / 3).map(([y]) => y));
    for (const bucket of [1, 2, 3, 4]) {
        const { texels } = paint(sprite, { bucket, wetQ: 0 });
        // The cone's slate tip above the ridge row may snow; its brass may not.
        const finial = texels.filter((p) => Math.floor(p / width) < ridge && brass(sprite, p));
        assert.equal(finial.length, 0, `b${bucket}: ${finial.length} snow texels on the finial`);
    }
});

// EN-6 — the low sun on an actual roof edge.
const LANDMARKS = ['archive', 'command', 'forge', 'harbor', 'mine', 'portal', 'taskboard', 'tavern', 'watchtower'];
// Pinned to Belgrade in September (CEST, UTC+2), so the sun is the same
// under any host timezone (CI runs UTC).
const BELGRADE = Object.freeze({ zone: 'Europe/Belgrade', lat: 44.8, lon: 20.5, offsetMinutes: () => 120 });
const equinox = (hour, minute, type = 'clear') => createAtmosphereSnapshot({
    now: new Date(2026, 8, 22, hour, minute),
    weatherOverride: { type },
    motionScale: 0,
    solarSite: BELGRADE,
});

test('the low-sun glint side opens only for a low, unclouded sun and no snow', () => {
    assert.equal(roofGlintSide(equinox(18, 30)), '-1,-1', 'dusk: the sun stands upper-left');
    assert.equal(roofGlintSide(equinox(17, 30)), '-1,-1');
    assert.equal(roofGlintSide(equinox(7, 0)), '-1,1', 'dawn: the sun stands lower-left');
    assert.equal(roofGlintSide(equinox(12, 0)), '', 'no glint at noon');
    assert.equal(roofGlintSide(equinox(19, 30)), '', 'none once the sun is down');
    assert.equal(roofGlintSide(equinox(18, 30, 'rain')), '', 'none in live rain');
    assert.equal(roofGlintSide(equinox(18, 30, 'overcast')), '', 'none under overcast (deep shade)');
    assert.equal(roofGlintSide(equinox(18, 30), 1), '', 'none under snow');
});

test('the low-sun glint is a short run on real roof slate, one palette step up', () => {
    const stops = new Set([...ART_RAMPS.roofSlate, ...ART_RAMPS.domeSlate, ART_RAMPS.wetSlate[3]]);
    const hex = (d, o) => `#${[d[o], d[o + 1], d[o + 2]].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
    let glinting = 0;
    for (const type of LANDMARKS) {
        const sprite = landmark(type);
        const run = roofGlintRun(sprite.map, '-1,-1');
        assert.ok(run.length <= ROOF_GLINT_TEXELS, type);
        if (!run.length) continue;
        glinting++;
        const xs = run.map((p) => p % sprite.albedo.width);
        const ys = run.map((p) => Math.floor(p / sprite.albedo.width));
        assert.ok(Math.max(...xs) - Math.min(...xs) < ROOF_GLINT_BOX[0], `${type} run width`);
        assert.ok(Math.max(...ys) - Math.min(...ys) < ROOF_GLINT_BOX[1], `${type} run height`);
        for (const p of run) {
            assert.ok(sprite.albedo.data[p * 4 + 3] >= 128, `${type}: the glint lands on opaque art`);
            assert.equal(face(sprite, p), 3, `${type}: the glint lands on roof`);
        }
        const { map, albedo } = sprite;
        const out = new Uint8ClampedArray(map.w * map.h * 4);
        assert.equal(paintRoofWeather(map, albedo.data, out, { glint: '-1,-1' }), run.length);
        for (const p of run) {
            const x = p % albedo.width;
            const o = ((Math.floor(p / albedo.width) - map.top) * map.w + x - map.left) * 4;
            assert.ok(stops.has(hex(out, o)), `${type}: ${hex(out, o)} is a roof ramp stop`);
            assert.notEqual(hex(out, o), hex(albedo.data, p * 4), `${type}: the glint steps the slate`);
        }
    }
    assert.ok(glinting >= 7, `most landmark roofs glint (${glinting})`);
});

test('snow buries the low-sun glint', () => {
    const { map, albedo } = landmark('tavern');
    const plain = new Uint8ClampedArray(map.w * map.h * 4);
    const lit = new Uint8ClampedArray(map.w * map.h * 4);
    paintRoofWeather(map, albedo.data, plain, { bucket: 2 });
    paintRoofWeather(map, albedo.data, lit, { bucket: 2, glint: '-1,-1' });
    assert.deepEqual(lit, plain);
});

test('the seeded Canvas roof stroke is gone: the building reaction paints no glint', () => {
    const atmosphere = equinox(18, 30);
    const fills = [];
    const ctx = { save() {}, restore() {}, fillRect(...args) { fills.push(args); }, set fillStyle(v) {}, set globalCompositeOperation(v) {}, set globalAlpha(v) {} };
    BuildingSprite.prototype._drawAtmosphereBuildingReactions.call({
        atmosphereState: { reactions: { ...atmosphere.reactions, windowWarmth: 0 } },
        lightingState: atmosphere.lighting,
        assets: { getAnchor: () => [100, 100], getDims: () => ({ w: 200, h: 200 }) },
        _clipToSplitPass() {},
        motionScale: 0,
        frame: 0,
    }, ctx, { type: 'tavern', position: { tileX: 21, tileY: 14 } }, { id: 'building.tavern' }, 300, 300);
    assert.equal(fills.length, 0);
});

// The village's massing, its view planes and the frame's receiver texels at
// a September dusk pose, as the resident path builds them (texel A).
const MASSING_FACETS = BUILDING_DEFS.flatMap((def) => (LANDMARK_MASSING[def.type]?.solids?.length
    ? massingFacets(LANDMARK_MASSING[def.type], def, buildingCenterToWorld(def)) : []));
let massingView = null;
function receiverField(atmosphere) {
    const rect = shadeFieldRect();
    if (!massingView) {
        const build = createShadeViewBuild({ rect, facets: MASSING_FACETS });
        while (!build.step(Infinity));
        massingView = build.view;
    }
    const sweep = castLightingFor(atmosphere).shade;
    assert.ok(sweep, 'the dusk pose casts');
    return buildShadeField({ rect, sweep, facets: MASSING_FACETS, texels: new Uint8Array(rect.cols * rect.rows * 4), view: massingView });
}
const SHADED = new Set([SHADE_SURFACE.wallCast, SHADE_SURFACE.wallTurned, SHADE_SURFACE.topCast, SHADE_SURFACE.topTurned, SHADE_SURFACE.flatTurned]);
const ATLAS = JSON.parse(readFileSync(new URL('../../claudeville/assets/sprites/atlases/world-pilot.json', import.meta.url)));

test('the glint lies only where the sun reaches, judged from the massing on every path and tier', () => {
    for (const [hour, minute] of [[17, 30], [18, 30]]) {
        const atmosphere = equinox(hour, minute);
        const field = receiverField(atmosphere);
        const sweep = sunSweepFor(atmosphere);
        assert.ok(sweep, 'the sun is up');
        // The tier-free sweep is the frame field's own (same buckets).
        assert.equal(sweep.key, castLightingFor(atmosphere).shade.key);
        const side = roofGlintSide(atmosphere);
        for (const def of BUILDING_DEFS) {
            const sprite = landmark(def.type);
            if (!sprite.map) continue;
            const anchor = ATLAS.frames[`building.${def.type}`].anchor;
            const centre = buildingCenterToWorld(def);
            const ox = Math.round(centre.x - anchor[0]);
            const oy = Math.round(centre.y - anchor[1]);
            const code = (x, y) => shadeSurfaceAt(field, ox + x + 0.5, oy + y + 0.5);
            const lit = roofSunVerdict(sprite.map, { ox, oy, sweep, facets: MASSING_FACETS });
            const unfiltered = roofGlintRun(sprite.map, side);
            const run = roofGlintRun(sprite.map, side, lit, `verdict-${hour}`);
            for (const p of run) {
                const x = p % sprite.albedo.width;
                const y = Math.floor(p / sprite.albedo.width);
                assert.ok(!SHADED.has(code(x, y)), `${def.type} ${hour}:${minute}: a glint texel the village field shades`);
            }
            if (def.type === 'forge') {
                assert.ok(unfiltered.length && unfiltered.every((p) => code(p % sprite.albedo.width, Math.floor(p / sprite.albedo.width)) === SHADE_SURFACE.topTurned),
                    'without the verdict the Forge run lies on its turned pitch');
                assert.ok(run.every((p) => !unfiltered.includes(p)), 'the Forge glint leaves its turned pitch');
            }
        }
    }
});

test('after rain the glint steps up from the wet course, never below it, and the top stop holds', () => {
    const { map, albedo } = landmark('tavern');
    const lum = (d, o) => 0.2126 * d[o] + 0.7152 * d[o + 1] + 0.0722 * d[o + 2];
    const run = roofGlintRun(map, '-1,-1');
    for (let q = 1; q <= 4; q++) {
        const wet = new Uint8ClampedArray(map.w * map.h * 4);
        const lit = new Uint8ClampedArray(map.w * map.h * 4);
        paintRoofWeather(map, albedo.data, wet, { wetQ: q });
        paintRoofWeather(map, albedo.data, lit, { wetQ: q, glint: '-1,-1' });
        for (const p of run) {
            const x = p % albedo.width;
            const o = ((Math.floor(p / albedo.width) - map.top) * map.w + x - map.left) * 4;
            const under = wet[o + 3] ? lum(wet, o) : lum(albedo.data, p * 4);
            assert.ok(lum(lit, o) >= under, `wet quantum ${q}: the glint never darkens the course`);
            if (q === 4 && wet[o + 3]) assert.deepEqual([...lit.slice(o, o + 3)], [...wet.slice(o, o + 3)], 'the top wet stop holds');
        }
    }
});

const MANIFEST = new Map(collectSpriteEntries(loadSpriteManifest()).map((entry) => [entry.id, entry]));

test('a glint-only patch is its run box, at most 16x4, inside one split half', () => {
    let split = 0;
    for (const type of LANDMARKS) {
        const sprite = landmark(type);
        if (!sprite.map) continue;
        const entry = MANIFEST.get(`building.${type}`);
        sprite.map.horizonY = entry?.splitForOcclusion && Number.isFinite(Number(entry.horizonY)) ? Number(entry.horizonY) : null;
        const run = roofGlintRun(sprite.map, '-1,-1', null, 'split');
        const box = roofGlintBox(sprite.map, run);
        if (!box) continue;
        assert.ok(box.w <= ROOF_GLINT_BOX[0] && box.h <= ROOF_GLINT_BOX[1], `${type} box ${box.w}x${box.h}`);
        if (sprite.map.horizonY != null) {
            split++;
            assert.ok(box.top + box.h <= sprite.map.horizonY || box.top >= sprite.map.horizonY, `${type}: one split half`);
        }
        const out = new Uint8ClampedArray(box.w * box.h * 4);
        assert.equal(paintRoofWeather(sprite.map, sprite.albedo.data, out, { glint: '-1,-1', box }), run.length);
    }
    assert.ok(split >= 2, `the manifest horizons reach the split landmarks (${split})`);
});

test('a run that would straddle the split horizon keeps to its seed half', () => {
    const sprite = landmark('tavern');
    sprite.map.horizonY = null;
    const whole = roofGlintRun(sprite.map, '-1,-1', null, 'whole');
    const box = roofGlintBox(sprite.map, whole);
    assert.ok(box.h >= 2, 'the free run spans rows');
    // A horizon through the middle of the free run.
    sprite.map.horizonY = box.top + 1;
    const cut = roofGlintRun(sprite.map, '-1,-1', null, 'cut');
    const rows = cut.map((p) => Math.floor(p / sprite.albedo.width));
    assert.ok(cut.length > 0 && cut.length < whole.length, 'the cut run is shorter');
    const back = rows[0] < sprite.map.horizonY;
    assert.ok(rows.every((y) => (y < sprite.map.horizonY) === back), 'one half only');
});

// EN-2 — the facade recolour leaves roof weather exactly as it was: the
// counts below are the snow-cap mask and the full-cover paint of the art
// before the ramp edits (integration 4e601945).
test('the facade ramp edits keep the roof class and snow-cap masks', () => {
    for (const [type, caps, cover] of [['tavern', 174, 10985], ['command', 203, 8824]]) {
        const { map, albedo } = landmark(type);
        let capped = 0;
        for (let p = 0; p < map.cap.length; p++) if (map.cap[p] >= 0) capped++;
        assert.equal(capped, caps, `${type} cap mask`);
        const out = new Uint8ClampedArray(map.w * map.h * 4);
        assert.equal(paintRoofWeather(map, albedo.data, out, { bucket: 4 }), cover, `${type} full cover`);
    }
});
