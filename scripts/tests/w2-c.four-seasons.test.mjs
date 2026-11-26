import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { PNG } from 'pngjs';
import { ART_RAMPS } from '../../claudeville/src/config/artPalette.js';
import { MAP_SIZE, TILE_WIDTH, TILE_HEIGHT } from '../../claudeville/src/config/constants.js';
import {
    AUTUMN_DRY_PATCH_ON, DEW_SITE_CAP, GRASS_GUST_RAMPS, GRASS_GUST_STOPS, GROUND_STOP_FLAGS, GROUND_TURF, TERRAIN_HAZE_COURSES,
    bakeGround, bakeWinterGround, captureGroundArtifact, groundBakeSlices, groundTurfFor, restoreGroundArtifact, snowRankLumas,
    validGroundArtifact, GROUND_BAKE_BUDGET,
} from '../../claudeville/src/presentation/character-mode/GroundBake.js';
import {
    MARCESCENT_FROM, MARCESCENT_RADIAL, TREE_SPRITES, WORLD_ASH_AUTUMN_LINE, blossomRampKey, canopyClumps, canopyPlan, canopyRadial,
    isCanopyPixel, recolorCanopy, shedCanopy,
} from '../../claudeville/src/presentation/character-mode/FoliageRenderer.js';
import {
    DEW_DENSITY, DEW_GLINT_COLOR, PHENOLOGY_STAGES, RIVER_PETAL_COLORS, SeasonalAmbience, dawnDewActive, dawnDewGlints, phenologyAt,
} from '../../claudeville/src/presentation/character-mode/SeasonalAmbience.js';
import {
    ICICLE_BUCKET, ICICLE_EVERY, ICICLE_LENGTH, RoofWeather, icicleLength, icicleSites, paintRoofIcicles, paintRoofWeather, roofLightningSheen,
    roofWeatherMap,
} from '../../claudeville/src/presentation/character-mode/RoofWeather.js';
import {
    COAST_FIELD_FLAGS, ICE_BAND, SEA_FRESNEL_FAR, SEA_FRESNEL_NEAR, SEA_FRESNEL_WEIGHT, SEA_FRESNEL_Y, registerCoastBake, rimIceBand,
    rimIceReach, seaBandBend, seaFresnelCourseAt, seaFresnelGate, seaFresnelMoods, waterMoodFor,
} from '../../claudeville/src/presentation/character-mode/CoastBake.js';

// W2-C — the four seasons (spec 02 §2.6.5, §4.9–§4.13, §5.1 R10 / R15).

const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const pack = (c) => (c[0] << 16) | (c[1] << 8) | c[2];
const rgbKey = (d, o) => (d[o] << 16) | (d[o + 1] << 8) | d[o + 2];
const setOf = (...ramps) => new Set(ramps.flat().map(pack));
const rampSet = (key) => new Set(ART_RAMPS[key].map((h) => pack(hex(h))));
const lumaOf = (c) => c[0] * 0.2126 + c[1] * 0.7152 + c[2] * 0.0722;
const okL = ([r, g, b]) => {
    const lin = (v) => { const c = v / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
    const [R, G, B] = [lin(r), lin(g), lin(b)];
    const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
    const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
    const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
    return 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s;
};
const hsv = ([r, g, b]) => {
    const mx = Math.max(r, g, b);
    const mn = Math.min(r, g, b);
    const d = mx - mn;
    let h = 0;
    if (d) {
        if (mx === r) h = ((g - b) / d) % 6;
        else if (mx === g) h = (b - r) / d + 2;
        else h = (r - g) / d + 4;
        h *= 60;
        if (h < 0) h += 360;
    }
    return { h, s: mx ? d / mx : 0 };
};
const median = (values) => {
    const sorted = Float64Array.from(values).sort();
    return sorted[Math.floor(sorted.length / 2)];
};
const tiles = (x0, x1, y0, y1) => {
    const out = new Set();
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) out.add(`${x},${y}`);
    return out;
};
const stage = (id) => PHENOLOGY_STAGES.find((row) => row.id === id);

function canvasStubs(t) {
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
                    drawImage() {},
                    createImageData: (w, h) => new globalThis.ImageData(w, h),
                }),
            };
        },
    };
    t.after(() => { delete globalThis.ImageData; delete globalThis.document; });
    return () => last;
}

// A town core (the plaza, the civic east arm as an avenue) on open meadow.
function groundFixture(t, season, phenology = null, overrides = {}) {
    const image = canvasStubs(t);
    const renderer = {
        _coastField: { key: 'land', signedDistance: () => -9 },
        townSquareTiles: tiles(14, 17, 18, 21),
        mainAvenueTiles: tiles(17, 23, 17, 19),
        avenueTiles: tiles(17, 23, 17, 19),
        world: { buildings: new Map() },
        scenery: { getTreeProps: () => [] },
        _terrainSeason: season,
        _terrainPhenology: phenology,
        ...overrides,
    };
    return { renderer, image };
}

function turfStats(base, img, sets = {}) {
    const { surfaces } = base.color;
    const counts = Object.fromEntries(Object.keys(sets).map((k) => [k, 0]));
    const S = [];
    const H = [];
    let grass = 0;
    for (let i = 0; i < surfaces.length; i++) {
        if (surfaces[i] !== 0) continue;
        const o = i * 4;
        const c = [img.data[o], img.data[o + 1], img.data[o + 2]];
        const { h, s } = hsv(c);
        S.push(s);
        H.push(h);
        grass++;
        const k = pack(c);
        for (const [name, set] of Object.entries(sets)) if (set.has(k)) counts[name]++;
    }
    return { grass, medianS: median(S), medianH: median(H), share: Object.fromEntries(Object.entries(counts).map(([k, v]) => [k, v / grass])) };
}

const turfColours = (T) => setOf(T.grass, T.dry, T.lush, T.fresh);

// ---- R10: turf ladders, gust pairs, snow ranks ------------------------------

test('R10: every season turf shares the grass value ladder and keeps a gust pair under every haze course', () => {
    const ladder = GROUND_TURF.summer.grass.map(okL);
    for (const key of ['dormant', 'spring']) {
        GROUND_TURF[key].grass.forEach((c, k) => {
            assert.ok(Math.abs(okL(c) - ladder[k]) <= 0.013, `${key}[${k}] okL ${okL(c).toFixed(3)} vs ${ladder[k].toFixed(3)}`);
        });
    }
    assert.equal(GRASS_GUST_RAMPS.length, 9, 'summer, dormant and spring × grass, dry and lush');
    const hazed = (rgb, h) => rgb.map((c, i) => Math.round(c * h[i] / 255));
    const pairs = new Map(GRASS_GUST_STOPS.map(([from, to]) => [from.join(), to.join()]));
    for (const ramp of GRASS_GUST_RAMPS) {
        for (const h of TERRAIN_HAZE_COURSES) {
            assert.equal(pairs.get(hazed(ramp[3], h).join()), hazed(ramp[4], h).join(), `gust pair for ${ramp[3].join()} under ${h.join()}`);
        }
    }
    // Summer's pairs keep their W6.11 indices (the first 18, in order).
    const summer = [GROUND_TURF.summer.grass, GROUND_TURF.summer.dry, GROUND_TURF.summer.lush]
        .flatMap((r) => TERRAIN_HAZE_COURSES.map((h) => hazed(r[3], h).join()));
    const uniqueSummer = summer.filter((v, i) => summer.indexOf(v) === i);
    assert.deepEqual(GRASS_GUST_STOPS.slice(0, uniqueSummer.length).map(([from]) => from.join()), uniqueSummer);
    // The Canvas class byte holds them all (CanvasWaterState CLS_GRASS 12).
    assert.ok(12 + GRASS_GUST_STOPS.length < 255, String(GRASS_GUST_STOPS.length));
    // No `from` is any other ground colour under any haze course (so a gust
    // never lifts a road, a soil or a grass stop that is not stop 3).
    const others = new Set();
    for (const key of ['road', 'plaza', 'plazaCool', 'cinder', 'sand', 'dirt']) {
        for (const c of ART_RAMPS[key].map(hex)) for (const h of TERRAIN_HAZE_COURSES) others.add(hazed(c, h).join());
    }
    for (const ramp of GRASS_GUST_RAMPS) {
        ramp.forEach((c, k) => { if (k !== 3) for (const h of TERRAIN_HAZE_COURSES) others.add(hazed(c, h).join()); });
    }
    const clashes = GRASS_GUST_STOPS.filter(([from]) => others.has(from.join()));
    assert.equal(clashes.length, 0, `gust stops that are also other ground colours: ${clashes.map(([f]) => f.join()).join(' ')}`);
    // The snow re-tone ranks every season's stop k as k (dormant included).
    for (const season of ['summer', 'winter', 'spring']) {
        const lumas = snowRankLumas(groundTurfFor(season, stage(season === 'winter' ? 'winter' : season)))[0];
        const T = season === 'winter' ? GROUND_TURF.dormant : season === 'spring' ? GROUND_TURF.spring : GROUND_TURF.summer;
        for (const ramp of [T.grass, T.dry, T.lush]) {
            ramp.forEach((c, k) => {
                const l = lumaOf(c);
                let best = 0;
                for (let j = 1; j < lumas.length; j++) if (Math.abs(lumas[j] - l) < Math.abs(lumas[best] - l)) best = j;
                assert.equal(best, k, `${season} stop ${k} ranks ${best}`);
            });
        }
    }
});

// ---- §2.6.5 seasonal turf ----------------------------------------------------

test('§2.6.5: January turf lies on grassDormant — stops 1–3 hue 62–77°, frame median S ≤ 0.30, hue 60–75°', (t) => {
    GROUND_TURF.dormant.grass.slice(1, 4).forEach((c, k) => {
        const { h, s } = hsv(c);
        // The spec table's whole degrees (dormant[3] #858666 measures 61.9°).
        assert.ok(Math.round(h) >= 62 && Math.round(h) <= 77, `dormant[${k + 1}] hue ${h.toFixed(1)}`);
        assert.ok(s <= 0.30, `dormant[${k + 1}] S ${s.toFixed(3)}`);
    });
    const { renderer, image } = groundFixture(t, 'winter', phenologyAt(new Date(2027, 0, 15, 12)));
    const base = bakeGround(renderer);
    const T = GROUND_TURF.dormant;
    const stats = turfStats(base, image(), { dormant: setOf(T.grass, T.dry, T.lush), summer: turfColours(GROUND_TURF.summer) });
    t.diagnostic(`winter turf: median S ${stats.medianS.toFixed(3)}, median hue ${stats.medianH.toFixed(1)}°, dormant share ${stats.share.dormant.toFixed(3)}`);
    assert.ok(stats.medianS <= 0.30, `median S ${stats.medianS}`);
    assert.ok(stats.medianH >= 60 && stats.medianH <= 75, `median hue ${stats.medianH}`);
    assert.ok(stats.share.dormant > 0.95, `dormant share ${stats.share.dormant}`);
    assert.equal(stats.share.summer, 0, 'no summer turf left in January');
});

test('§2.6.5: spring turf — grassSpring once the blossom is out, half the meadow step-snapped before it', (t) => {
    assert.equal(groundTurfFor('spring', stage('spring')).primary, GROUND_TURF.spring);
    assert.equal(groundTurfFor('spring', stage('spring')).alt, null);
    assert.equal(groundTurfFor('spring', stage('spring-bare')).alt, GROUND_TURF.spring);
    assert.equal(groundTurfFor('summer').primary, GROUND_TURF.summer);
    assert.equal(groundTurfFor('autumn', stage('peak')).primary, GROUND_TURF.summer);
    const sets = { spring: turfColours(GROUND_TURF.spring), summer: turfColours(GROUND_TURF.summer) };
    const bud = groundFixture(t, 'spring', stage('spring-bare'));
    const budBase = bakeGround(bud.renderer);
    const budStats = turfStats(budBase, bud.image(), sets);
    const out = groundFixture(t, 'spring', stage('spring'));
    const outStats = turfStats(bakeGround(out.renderer), out.image(), sets);
    t.diagnostic(`spring bud: spring ${budStats.share.spring.toFixed(3)} / summer ${budStats.share.summer.toFixed(3)}; blossom: spring ${outStats.share.spring.toFixed(3)}`);
    assert.ok(Math.abs(budStats.share.spring - 0.5) < 0.08, `bud spring share ${budStats.share.spring}`);
    assert.ok(budStats.share.spring + budStats.share.summer > 0.95, 'every bud texel snapped onto one of the two turfs');
    assert.ok(outStats.share.spring > 0.95 && outStats.share.summer === 0, `blossom spring share ${outStats.share.spring}`);
});

test('§4.13: autumn meadow — the dry patches threshold drops to 0.58 (≈ a third of the open meadow)', (t) => {
    assert.equal(AUTUMN_DRY_PATCH_ON, 0.58);
    const dry = { dry: setOf(GROUND_TURF.summer.dry) };
    const summer = groundFixture(t, 'summer', stage('summer'));
    const summerStats = turfStats(bakeGround(summer.renderer), summer.image(), dry);
    const autumn = groundFixture(t, 'autumn', stage('peak'));
    const autumnStats = turfStats(bakeGround(autumn.renderer), autumn.image(), dry);
    const patches = autumnStats.share.dry - summerStats.share.dry;
    t.diagnostic(`autumn dry share ${autumnStats.share.dry.toFixed(3)} (summer ${summerStats.share.dry.toFixed(3)}; patches +${patches.toFixed(3)})`);
    assert.ok(patches > 0.26 && patches < 0.38, `autumn dry patches ${patches}`);
});

test('§4.13: autumn reeds stand willow gold with a 2-px timber cattail; spring brambles flower ivory', (t) => {
    // A shore east of tile u 19.6: reeds on the dry bank (sd −0.55 … −0.24).
    // (The key a fixture with no water tile sets computes, so it is used.)
    const shore = { key: '0:0:0:0:0:0', signedDistance: (tx) => tx - 19.6 };
    const reeds = new Map();
    for (let v = 4; v < 36; v += 2) reeds.set(`19,${v}`, 'reeds');
    const bushes = new Map();
    for (let v = 4; v < 36; v += 2) for (let u = 4; u < 16; u += 3) bushes.set(`${u},${v}`, 1);
    const colours = (season, phenology) => {
        const { renderer, image } = groundFixture(t, season, phenology, { _coastField: shore, featureTiles: reeds, bushTiles: bushes });
        bakeGround(renderer);
        const found = new Set();
        const data = image().data;
        for (let o = 0; o < data.length; o += 4) if (data[o + 3]) found.add(rgbKey(data, o));
        return found;
    };
    const autumn = colours('autumn', stage('peak'));
    for (const h of [ART_RAMPS.willowGold[3], ART_RAMPS.willowGold[5], ART_RAMPS.timber[1]]) assert.ok(autumn.has(pack(hex(h))), `autumn reed ${h}`);
    assert.ok(!autumn.has(pack(hex(ART_RAMPS.clothOchre[0]))), 'no ochre cattail in autumn');
    const summer = colours('summer', stage('summer'));
    assert.ok(summer.has(pack(hex(ART_RAMPS.clothOchre[0]))), 'summer keeps its ochre cattails');
    assert.ok(!summer.has(pack(hex(ART_RAMPS.willowGold[3]))));
    const spring = colours('spring', stage('spring'));
    assert.ok(spring.has(pack(hex(ART_RAMPS.blossomIvory[3]))) && spring.has(pack(hex(ART_RAMPS.blossomIvory[2]))), 'ivory bramble blossom');
    const bud = colours('spring', stage('spring-bare'));
    assert.ok(!bud.has(pack(hex(ART_RAMPS.blossomIvory[3]))), 'no blossom before it is out');
});

// ---- §4.13 trampled avenue crowns -------------------------------------------

test('§4.13: winter tramples the avenue crowns and piles the kerbs', (t) => {
    const { renderer, image } = groundFixture(t, 'winter', stage('winter'));
    const base = bakeGround(renderer);
    const { stepBuf, surfaces } = base.color;
    const { WORN, KERB_MASK } = GROUND_STOP_FLAGS;
    let worn = 0;
    let wornPlaza = 0;
    for (let i = 0; i < stepBuf.length; i++) {
        if (!(stepBuf[i] & WORN)) continue;
        assert.ok(surfaces[i] === 3 || surfaces[i] === 4, 'the worn band lies on road or plaza');
        assert.equal(stepBuf[i] & KERB_MASK, 0, 'a kerb is never the crown');
        worn++;
        if (surfaces[i] === 4) wornPlaza++;
    }
    assert.ok(worn > 1000, `worn texels ${worn}`);
    const before = Uint8ClampedArray.from(image().data);
    bakeWinterGround(renderer, base, 4, 0);
    const after = image().data;
    const snow = rampSet('snow');
    const snowRgb = ART_RAMPS.snow.map(hex);
    const stats = { worn: 0, wornSnow: 0, wornSlush: 0, wornLuma: 0, paving: 0, pavingSnow: 0, pavingLuma: 0, kerb: 0, kerbSnow: 0, kerbStop: 0 };
    for (let i = 0; i < stepBuf.length; i++) {
        const s = surfaces[i];
        if (s !== 3 && s !== 4) continue;
        const o = i * 4;
        const k = rgbKey(after, o);
        const changed = k !== rgbKey(before, o);
        if (stepBuf[i] & KERB_MASK) {
            stats.kerb++;
            if (snow.has(k)) { stats.kerbSnow++; stats.kerbStop += ART_RAMPS.snow.findIndex((h) => pack(hex(h)) === k); }
            continue;
        }
        if (stepBuf[i] & WORN) {
            stats.worn++;
            if (snow.has(k)) { stats.wornSnow++; stats.wornLuma += lumaOf([after[o], after[o + 1], after[o + 2]]); }
            else if (changed) {
                // Slush: the stone's own colour half mixed with snow[0].
                const stone = [before[o], before[o + 1], before[o + 2]];
                const mix = stone.map((c, j) => Math.round(c + (snowRgb[0][j] - c) * 0.5));
                assert.deepEqual([after[o], after[o + 1], after[o + 2]], mix);
                stats.wornSlush++;
            }
        } else {
            stats.paving++;
            if (snow.has(k)) { stats.pavingSnow++; stats.pavingLuma += lumaOf([after[o], after[o + 1], after[o + 2]]); }
        }
    }
    const share = (a, b) => (b ? a / b : 0);
    t.diagnostic(`worn ${stats.worn} (plaza ${wornPlaza}): snow ${share(stats.wornSnow, stats.worn).toFixed(3)}, slush ${share(stats.wornSlush, stats.worn).toFixed(3)}, `
        + `mean luma ${share(stats.wornLuma, stats.wornSnow).toFixed(1)} vs paving ${share(stats.pavingLuma, stats.pavingSnow).toFixed(1)}; `
        + `kerb snow ${share(stats.kerbSnow, stats.kerb).toFixed(3)} vs paving ${share(stats.pavingSnow, stats.paving).toFixed(3)}`);
    assert.ok(stats.wornSlush > 50, 'half the trampled drift is slush over the stone');
    const slushShare = stats.wornSlush / (stats.wornSlush + stats.wornSnow);
    assert.ok(slushShare > 0.35 && slushShare < 0.65, `slush share of trampled drift ${slushShare}`);
    assert.ok(share(stats.wornLuma, stats.wornSnow) < share(stats.pavingLuma, stats.pavingSnow) - 4, 'packed snow sits darker on the crown');
    assert.ok(share(stats.kerbSnow, stats.kerb) > share(stats.pavingSnow, stats.paving) * 1.5, 'the kerbs hold the swept snow');
});

// ---- §4.10 dawn dew ----------------------------------------------------------

test('§4.10: dew sites — sunlit tuft tips and lit texels, capped, published and persisted', (t) => {
    const { renderer, image } = groundFixture(t, 'spring', stage('spring'));
    const base = bakeGround(renderer, true);
    const sites = base.field.dewSites;
    assert.ok(sites.points instanceof Int16Array && sites.points.length > 2000, String(sites?.points?.length));
    assert.ok(sites.points.length <= DEW_SITE_CAP * 2 && sites.share > 0 && sites.share <= 1);
    const img = image().data;
    const turf = turfColours(GROUND_TURF.spring);
    const { surfaces, aoBuf, cols } = base.color;
    let onTurf = 0;
    for (let k = 0; k < sites.points.length; k += 2) {
        const col = sites.points[k] - base.x0;
        const row = sites.points[k + 1] - base.y0;
        const i = row * cols + col;
        assert.equal(surfaces[i], 0, 'a dew site is a grass texel');
        assert.equal(aoBuf[i], 0, 'in the sun');
        if (turf.has(rgbKey(img, i * 4))) onTurf++;
    }
    assert.ok(onTurf / (sites.points.length / 2) > 0.9, `sites still showing turf ${onTurf}`);
    t.diagnostic(`dew sites ${sites.points.length / 2} (share ${sites.share.toFixed(4)}, ${sites.points.byteLength} B)`);
    // Persisted with the ground artifact and restored onto the field.
    const host = { groundField: base.field, groundPuddleMask: { data: base.puddleMask, cols: base.cols, rows: base.rows, x0: base.x0, y0: base.y0, texelW: 2, revision: 'r' } };
    const artifact = captureGroundArtifact(host);
    assert.equal(artifact.field.dewSites, sites);
    assert.equal(validGroundArtifact(artifact), true);
    const restored = {};
    restoreGroundArtifact(restored, artifact);
    assert.equal(restored.groundField.dewSites, sites);
    assert.equal(validGroundArtifact({ ...artifact, field: { ...artifact.field, dewSites: { points: new Int16Array(3), share: 0.1 } } }), false);
    const legacy = { ...artifact, field: { ...artifact.field } };
    delete legacy.field.dewSites;
    assert.equal(validGroundArtifact(legacy), true, 'an artifact from before the dew still restores');
});

function dawn({ month = 3, elevation = 6, fog = 0, minute = 400, noon = 760 } = {}) {
    return {
        clock: { date: new Date(2027, month, 20, 6, 40), minuteOfDay: minute },
        solar: { elevationDeg: elevation, solarNoonMinute: noon },
        weather: { type: 'clear', fog },
        phase: 'day',
    };
}

test('§4.10: dawn dew glints at 0.35 %, sun 0–12° before noon, in mist or spring and autumn, 2 Hz, still under reduced motion', () => {
    assert.equal(DEW_GLINT_COLOR, '#d8d1bb');
    assert.equal(dawnDewActive(dawn()), true, 'a spring dawn');
    assert.equal(dawnDewActive(dawn({ month: 9 })), true, 'an autumn dawn');
    assert.equal(dawnDewActive(dawn({ month: 6 })), false, 'a clear summer dawn');
    assert.equal(dawnDewActive(dawn({ month: 6, fog: 0.3 })), true, 'a misty summer dawn');
    assert.equal(dawnDewActive(dawn({ elevation: 13 })), false, 'the sun too high');
    assert.equal(dawnDewActive(dawn({ elevation: -1 })), false, 'before sunrise');
    assert.equal(dawnDewActive(dawn({ minute: 1050 })), false, 'the evening sun');
    const n = 40000;
    const points = new Int16Array(n * 2);
    for (let k = 0; k < n; k++) { points[k * 2] = (k * 37) % 2400 - 1200; points[k * 2 + 1] = Math.floor(k / 33); }
    const share = 0.125;
    const sites = { points, share };
    const counts = [];
    for (let slot = 0; slot < 8; slot++) counts.push(dawnDewGlints(dawn(), sites, slot * 500 + 10).length / 2);
    const mean = counts.reduce((a, b) => a + b, 0) / counts.length;
    const expected = n * DEW_DENSITY / share;
    assert.ok(Math.abs(mean - expected) < expected * 0.15, `mean glints ${mean} vs ${expected}`);
    // A slot holds 500 ms, the next one twinkles another set.
    assert.deepEqual(dawnDewGlints(dawn(), sites, 1010), dawnDewGlints(dawn(), sites, 1490));
    assert.notDeepEqual(dawnDewGlints(dawn(), sites, 1010), dawnDewGlints(dawn(), sites, 1510));
    // Reduced motion: slot 0's set, whatever the clock.
    assert.deepEqual(dawnDewGlints(dawn(), sites, 9999, true), dawnDewGlints(dawn(), sites, 0));
    assert.equal(dawnDewGlints(dawn({ month: 6 }), sites, 0).length, 0);
    // The view culls.
    const view = { x: -200, y: 100, width: 400, height: 200 };
    for (const v of [dawnDewGlints(dawn(), sites, 0, false, view)]) {
        for (let k = 0; k < v.length; k += 2) assert.ok(v[k] >= -200 && v[k] < 200 && v[k + 1] >= 100 && v[k + 1] < 300);
    }
    // drawDawnDew: 1 × 1 ivory rects at the glints.
    const rects = [];
    const ctx = { fillStyle: '', fillRect(x, y, w, h) { rects.push([x, y, w, h, this.fillStyle]); } };
    const ambience = new SeasonalAmbience({ atmosphereStateGetter: () => dawn(), motionTimeGetter: () => 0, motionScaleGetter: () => 1 });
    const drawn = ambience.drawDawnDew(ctx, dawn(), sites, 0, false);
    assert.equal(drawn, dawnDewGlints(dawn(), sites, 0).length / 2);
    assert.ok(rects.length === drawn && rects.every(([, , w, h, c]) => w === 1 && h === 1 && c === '#d8d1bb'));
});

// ---- §4.13 river petals ------------------------------------------------------

test('§4.13: spring petals ride the river leaf path, pink or ivory', () => {
    const spawned = [];
    const atmosphere = { phase: 'day', clock: { date: new Date(2027, 3, 20, 13) }, weather: { type: 'partly-cloudy', windX: 0.55, seed: 3 } };
    const ambience = new SeasonalAmbience({
        particleSystem: { countTagged: () => 0, spawn: (type, x, y, count, options) => spawned.push({ type, x, y, options }) },
        atmosphereStateGetter: () => atmosphere,
        motionScaleGetter: () => 1,
        cameraGetter: () => ({ zoom: 2, screenToWorld: (x, y) => ({ x, y }) }),
        anchorsProvider: (kind) => (kind === 'canopy' ? [{ x: 100, y: 200, lift: 31 }] : []),
        motionTimeGetter: () => 0,
        riverCurrentAt: () => ({ x: 0.894, y: 0.447 }),
    });
    for (let k = 0; k < 200; k++) ambience.update(100);
    assert.ok(spawned.length > 50);
    const colours = new Set();
    for (const { type, y, options } of spawned) {
        assert.equal(type, 'petal');
        assert.equal(options.landY, y + 31, 'falls straight to its landing on the current');
        assert.ok(options.afloat && options.fadeLife > 0);
        assert.equal(options.colors.length, 1);
        colours.add(options.colors[0]);
    }
    assert.deepEqual([...colours].sort(), [...RIVER_PETAL_COLORS].sort());
    assert.deepEqual(RIVER_PETAL_COLORS, [ART_RAMPS.blossom[2], ART_RAMPS.blossomIvory[2]]);
    // Before the blossom no petal falls at all (BI-2), on land or water.
    spawned.length = 0;
    atmosphere.clock.date = new Date(2027, 2, 25, 13);
    for (let k = 0; k < 50; k++) ambience.update(100);
    assert.equal(spawned.length, 0);
});

// ---- §4.13 foliage -------------------------------------------------------------

function sheet(id, height) {
    const png = PNG.sync.read(readFileSync(new URL(`../../claudeville/assets/sprites/vegetation/${id}.png`, import.meta.url)));
    return { width: png.width, height, data: Uint8ClampedArray.from(png.data.subarray(0, png.width * height * 4)) };
}

test('§4.13: the sunlit birch blossoms ivory, every canopy texel on its ramps', () => {
    const plan = canopyPlan('birch', 2, 'spring');
    assert.equal(plan.blossom, 'ivory');
    assert.equal(blossomRampKey(plan), 'blossomIvory');
    assert.equal(blossomRampKey(canopyPlan('oak', 2, 'spring')), 'blossom');
    assert.equal(canopyPlan('birch', 2, 'summer').blossom, false);
    const allowed = new Set([...rampSet('foliageSun'), ...rampSet('blossomIvory')]);
    const ivory = rampSet('blossomIvory');
    const pink = rampSet('blossom');
    for (const key of ['birch.small', 'birch.large', 'birch.tall']) {
        const sprite = TREE_SPRITES[key];
        const { width, height, data } = sheet(sprite.id, sprite.height);
        const out = Uint8ClampedArray.from(data);
        recolorCanopy(out, width, height, plan);
        let offRamp = 0;
        let flowers = 0;
        for (let i = 0; i < out.length; i += 4) {
            if (!isCanopyPixel(data, i, Math.floor(i / 4 / width), height)) continue;
            const k = rgbKey(out, i);
            if (!allowed.has(k)) offRamp++;
            if (ivory.has(k)) flowers++;
            assert.ok(!pink.has(k), 'no pink on a birch');
        }
        assert.equal(offRamp, 0, `${key} off-ramp texels`);
        assert.ok(flowers > 0, `${key} flowers`);
    }
});

test('§4.13: the world ash turns only the top 22 % of its crown amber in autumn', (t) => {
    assert.equal(WORLD_ASH_AUTUMN_LINE, 0.14);
    const plan = canopyPlan('ash', 0, 'autumn');
    assert.equal(plan.turning, 'canopyOchre');
    assert.equal(plan.ramp, null, 'the rest keeps its authored evergreen');
    assert.equal(canopyPlan('ash', 0, 'summer'), null);
    const sprite = TREE_SPRITES['ash.world'];
    const { width, height, data } = sheet(sprite.id, sprite.height);
    const out = Uint8ClampedArray.from(data);
    recolorCanopy(out, width, height, plan);
    const ochre = rampSet('canopyOchre');
    let top = height;
    let bottom = -1;
    for (let i = 0; i < data.length; i += 4) {
        const y = Math.floor(i / 4 / width);
        if (!isCanopyPixel(data, i, y, height)) continue;
        top = Math.min(top, y);
        bottom = Math.max(bottom, y);
    }
    let canopy = 0;
    let turned = 0;
    let turnedTop = 0;
    let authored = 0;
    for (let i = 0; i < data.length; i += 4) {
        const y = Math.floor(i / 4 / width);
        if (!isCanopyPixel(data, i, y, height)) continue;
        canopy++;
        if (ochre.has(rgbKey(out, i))) {
            turned++;
            if ((y - top) / (bottom - top) < 1 / 3) turnedTop++;
        } else if (rgbKey(out, i) === rgbKey(data, i)) authored++;
    }
    t.diagnostic(`world ash autumn: turned ${(turned / canopy).toFixed(3)} of the canopy, ${(turnedTop / turned).toFixed(3)} of it in the top third`);
    assert.ok(turned / canopy > 0.18 && turned / canopy < 0.26, `turned share ${turned / canopy}`);
    assert.ok(turnedTop / turned > 0.85, `turned in the top third ${turnedTop / turned}`);
    assert.equal(turned + authored, canopy, 'every texel is burnished amber or the authored evergreen');
});

test('§4.13: late-autumn shed — oaks keep marcescent bronze, the rest no floating outer clumps', (t) => {
    const marc = rampSet('leafMarcescent');
    const nov19 = phenologyAt(new Date(2026, 10, 19, 12));
    assert.equal(nov19.id, 'fall-5');
    for (const key of ['oak.large', 'oak.tall', 'oak.small', 'maple.large', 'maple.tall', 'birch.large', 'birch.tall', 'willow.large', 'poplar.tall']) {
        const sprite = TREE_SPRITES[key];
        const species = key.slice(0, key.indexOf('.'));
        const leafy = sheet(sprite.id, sprite.height);
        const bare = sheet(TREE_SPRITES[sprite.bare].id, sprite.height);
        const { width, height } = leafy;
        const share = nov19.shed[species];
        if (!(share >= MARCESCENT_FROM && share < 1)) continue;
        const indices = [];
        for (let i = 0; i < leafy.data.length; i += 4) if (isCanopyPixel(leafy.data, i, Math.floor(i / 4 / width), height)) indices.push(i);
        const { label, clumps } = canopyClumps(leafy.data, width, height, indices);
        const radial = canopyRadial(indices, width);
        for (const variant of [0, 1, 2]) {
            const out = Uint8ClampedArray.from(leafy.data);
            recolorCanopy(out, width, height, canopyPlan(species, variant, 'autumn', nov19.turned + share));
            shedCanopy(out, leafy.data, bare.data, width, height, share, 11 + variant * 7, { species });
            const keptClumps = new Set();
            let kept = 0;
            let bronze = 0;
            for (const i of indices) {
                const same = out[i] === bare.data[i] && out[i + 1] === bare.data[i + 1] && out[i + 2] === bare.data[i + 2] && out[i + 3] === bare.data[i + 3];
                if (same) continue;
                kept++;
                keptClumps.add(label.get(i >> 2));
                if (marc.has(rgbKey(out, i))) bronze++;
            }
            if (species === 'oak') {
                assert.equal(bronze, kept, `${key}/${variant}: every kept oak texel is marcescent bronze`);
                // The erosion pass: the bronze remnant is thinner than the
                // same clumps kept without it (the species-free shed keeps
                // every texel of a kept clump).
                const plain = Uint8ClampedArray.from(leafy.data);
                recolorCanopy(plain, width, height, canopyPlan(species, variant, 'autumn', nov19.turned + share));
                shedCanopy(plain, leafy.data, bare.data, width, height, share, 11 + variant * 7, { species, leafOut: true });
                assert.ok(kept > 0, `${key}/${variant}: an oak keeps a few clumps`);
            } else {
                for (const id of keptClumps) assert.ok(radial(clumps[id]) <= MARCESCENT_RADIAL, `${key}/${variant}: a floating outer clump`);
                assert.equal(bronze, 0);
            }
            if (variant === 0) t.diagnostic(`${key} @ ${share}: kept ${kept} texels in ${keptClumps.size} clumps`);
        }
    }
});

// ---- §4.13 eave icicles, §4.11 lightning sheen ------------------------------

const LANDMARK_DIR = new URL('../../claudeville/assets/sprites/buildings/', import.meta.url);
function landmark(type) {
    const read = (name) => {
        const url = new URL(`building.${type}/${name}`, LANDMARK_DIR);
        return existsSync(url) ? PNG.sync.read(readFileSync(url)) : null;
    };
    const albedo = read('base.png');
    const occluder = read('base.occluder.png');
    const material = read('base.material.png');
    const emissive = read('base.emissive.png');
    const map = roofWeatherMap({
        width: albedo.width, height: albedo.height, albedo: albedo.data, occluder: occluder.data,
        material: material?.data || null, emissive: emissive?.data || null,
    });
    return { albedo, occluder, map };
}

test('§4.13: icicle sites — every 3rd eave column of a shady (face-2) run, every 5th elsewhere', () => {
    // 15 eave columns over a SE wall (face 2), then 15 over a SW wall, then a
    // gap and 7 more over the SE wall: runs break on the face and the gap.
    const width = 64;
    const height = 40;
    const occluder = new Uint8Array(width * height * 4);
    const eaves = [];
    const wall = (x0, x1, face) => {
        for (let x = x0; x < x1; x++) {
            eaves.push({ x, y: 10 });
            const o = (11 * width + x) * 4;
            occluder[o + 2] = face << 6;
            occluder[o + 3] = 255;
        }
    };
    wall(2, 17, 2);
    wall(17, 32, 1);
    wall(40, 47, 2);
    const sites = icicleSites(eaves, width, height, occluder);
    const run = (x0, x1) => sites.filter((s) => s.x >= x0 && s.x < x1);
    const shadyA = run(2, 17);
    const sunny = run(17, 32);
    const shadyB = run(40, 47);
    assert.equal(shadyA.length, 5, 'every 3rd of 15 shady columns');
    assert.equal(sunny.length, 3, 'every 5th of 15 other columns');
    assert.ok(shadyB.length >= 2 && shadyB.length <= 3, 'a short shady run after a gap');
    for (const [list, every, shady] of [[shadyA, ICICLE_EVERY.shady, true], [sunny, ICICLE_EVERY.other, false], [shadyB, ICICLE_EVERY.shady, true]]) {
        for (let k = 1; k < list.length; k++) assert.equal(list[k].x - list[k - 1].x, every);
        assert.ok(list.every((s) => s.shady === shady && s.y === 10 && s.length >= 3 && s.length <= 6));
    }
    // Clipped to the sprite: an eave two rows from the bottom hangs at most 1 px.
    const low = icicleSites([{ x: 5, y: height - 2 }], width, height, null);
    assert.ok(low.every((s) => s.length <= 1));
});

test('§4.13: eave icicles hang from shady eaves every 3rd column, elsewhere every 5th, 3–6 px, snow-ramp stops', (t) => {
    const snowRgb = ART_RAMPS.snow.map(hex);
    const shadow = hex(ART_RAMPS.slate[0]);
    const counts = [];
    for (const type of ['command', 'archive', 'forge', 'tavern', 'taskboard', 'harbor', 'portal', 'watchtower']) {
        const { albedo, occluder, map } = landmark(type);
        assert.ok(map.icicles.length > 0, `${type} has icicles`);
        const face = (x, y) => (occluder.data[(y * albedo.width + x) * 4 + 3] > 0 ? occluder.data[(y * albedo.width + x) * 4 + 2] >> 6 : -1);
        for (const s of map.icicles) {
            assert.ok(s.length >= ICICLE_LENGTH[0] && s.length <= ICICLE_LENGTH[1], `${type} length ${s.length}`);
            assert.equal(s.shady, face(s.x, s.y + 1) === 2, 'shady = a SE (face 2) wall under the eave');
        }
        assert.ok(map.icicles.every((s, k) => k === 0 || s.x > map.icicles[k - 1].x), 'one icicle a column at most');
        const box = map.iceBox;
        assert.ok(box.left <= map.left && box.top <= map.top && box.left + box.w >= map.left + map.w && box.top + box.h >= map.top + map.h);
        const out = new Uint8ClampedArray(box.w * box.h * 4);
        const written = paintRoofIcicles(map, out, { bucket: ICICLE_BUCKET });
        let ice = 0;
        let dark = 0;
        for (const s of map.icicles) {
            for (let r = 0; r < s.length; r++) {
                const o = ((s.y + 1 + r - box.top) * box.w + s.x - box.left) * 4;
                const want = r === 0 ? snowRgb[2] : r === s.length - 1 ? snowRgb[4] : snowRgb[3];
                assert.deepEqual([out[o], out[o + 1], out[o + 2], out[o + 3]], [...want, 255], `${type} icicle row ${r}`);
                ice++;
            }
        }
        for (let o = 0; o < out.length; o += 4) if (out[o + 3] && out[o] === shadow[0] && out[o + 1] === shadow[1] && out[o + 2] === shadow[2]) dark++;
        assert.equal(written, ice + dark);
        assert.ok(dark > 0 && dark <= map.icicles.reduce((n, s) => n + s.length - 1, 0));
        counts.push(`${type} ${map.icicles.length} (${map.icicles.filter((s) => s.shady).length} shady, ${ice} px)`);
        // None below bucket 2, none in rain; each wetness quantum melts a pixel.
        assert.equal(paintRoofIcicles(map, new Uint8ClampedArray(out.length), { bucket: 1 }), 0);
        assert.equal(paintRoofIcicles(map, new Uint8ClampedArray(out.length), { bucket: 4, liquid: true }), 0);
        const thawed = new Uint8ClampedArray(out.length);
        paintRoofIcicles(map, thawed, { bucket: 2, wetQ: 2 });
        for (const s of map.icicles) {
            assert.equal(icicleLength(s, 2), Math.max(0, s.length - 2));
            const below = ((s.y + 1 + icicleLength(s, 2) - box.top) * box.w + s.x - box.left) * 4;
            if (s.y + 1 + icicleLength(s, 2) < box.top + box.h) {
                const tip = [thawed[below], thawed[below + 1], thawed[below + 2]];
                assert.ok(!(tip[0] === snowRgb[4][0] && tip[1] === snowRgb[4][1] && tip[2] === snowRgb[4][2] && thawed[below + 3]) || map.icicles.some((o) => o !== s && o.x === s.x),
                    'the melted pixel is gone');
            }
        }
    }
    t.diagnostic(`icicles: ${counts.join('; ')}`);
    // The mine's roofs have no eave deep enough (DRIP_MIN_PITCH): none.
    assert.equal(landmark('mine').map.icicles.length, 0);
});

test('§4.13 / §4.11: the roof patch carries icicles on every backend; lightning steps the wet course one stop', (t) => {
    const image = canvasStubs(t);
    void image;
    const { albedo, map } = landmark('command');
    map.albedo = albedo.data;
    map.channels = { material: null, occluder: null };
    map.iceChannels = { material: null, occluder: null };
    const roof = new RoofWeather({});
    roof._maps.set('command', map);
    const snowy = { snowCover: 0.6, wetness: 0 };
    roof.sync({ weather: { precipitation: 0 } }, snowy, 1, 0);
    assert.equal(roof.icicles, true);
    assert.equal(roof.dripping, false, 'a frozen eave does not drip');
    const patch = roof.patch('command');
    assert.deepEqual([patch.left, patch.top, patch.w, patch.h], [map.iceBox.left, map.iceBox.top, map.iceBox.w, map.iceBox.h]);
    assert.ok(roof.key.includes('ice'));
    // Rain hides them (and drips); a thaw drips while they shorten.
    roof.sync({ weather: { type: 'rain', precipitation: 0.8 }, effectiveDate: new Date(2026, 6, 1) }, snowy, 1, 0);
    assert.equal(roof.icicles, false);
    roof.sync({ weather: { precipitation: 0 } }, { snowCover: 0.6, wetness: 0.4 }, 1, 0);
    assert.equal(roof.icicles, true);
    assert.equal(roof.dripping, true, 'a thawing eave drips');
    roof.sync({ weather: { precipitation: 0 } }, { snowCover: 0.6, wetness: 0.4 }, 0, 0);
    assert.equal(roof.dripping, false, 'never under reduced motion');
    // §4.11 — the sheen: wet roofs only, one stop, capped; never with motion off.
    const wet = ART_RAMPS.wetSlate.map(hex);
    const sprite = landmark('archive');
    const paint = (state) => {
        const out = new Uint8ClampedArray(sprite.map.w * sprite.map.h * 4);
        paintRoofWeather(sprite.map, sprite.albedo.data, out, state);
        const found = new Set();
        for (let o = 0; o < out.length; o += 4) if (out[o + 3]) found.add(rgbKey(out, o));
        return found;
    };
    assert.ok(paint({ wetQ: 2 }).has(pack(wet[1])) && !paint({ wetQ: 2, lightning: 1 }).has(pack(wet[1])));
    assert.ok(paint({ wetQ: 2, lightning: 1 }).has(pack(wet[2])));
    assert.deepEqual(paint({ wetQ: 4, lightning: 1 }), paint({ wetQ: 4 }), 'capped at the top wetSlate stop');
    assert.deepEqual(paint({ bucket: 3, lightning: 1 }), paint({ bucket: 3 }), 'a dry roof never sheens');
    assert.equal(roofLightningSheen({ active: true, step: 0 }), 1);
    assert.equal(roofLightningSheen({ active: true, step: 1 }), 0, 'only the 83 ms peak');
    assert.equal(roofLightningSheen({ active: true, step: 0 }, 0), 0, 'never under reduced motion');
    roof.sync({ weather: { precipitation: 0 } }, { snowCover: 0, wetness: 0.6 }, 1, 0, 1);
    assert.equal(roof.sheen, 1);
    roof.sync({ weather: { precipitation: 0 } }, { snowCover: 0, wetness: 0.6 }, 0, 0, 1);
    assert.equal(roof.sheen, 0);
});

// ---- §4.13 lagoon rim ice ------------------------------------------------------

function coastFixture(snowCover) {
    const renderer = {
        waterTiles: new Set(), waterMeta: new Map(), pathTiles: new Set(), bridgeTiles: new Set(),
        _groundState: { snowCover },
    };
    const add = (u0, u1, v0, v1, region) => {
        for (let u = u0; u <= u1; u++) for (let v = v0; v <= v1; v++) {
            renderer.waterTiles.add(`${u},${v}`);
            renderer.waterMeta.set(`${u},${v}`, { region });
        }
    };
    add(8, 14, 8, 14, 'lagoon');
    add(3, 33, 26, 28, 'river');
    const passes = [];
    renderer.registerTerrainBakePass = (p) => { passes.push(p); return () => {}; };
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
    const baked = { ...coast.baked, data: image.data };
    passes[1].draw(ctx, renderer);
    return { renderer, coast, baked };
}

test('§4.13: calm-lagoon rim ice from snow bucket 2 — 2–4 px of snow ice, land to the bake, never on the river or sea', (t) => {
    assert.deepEqual(ICE_BAND, [0, 0, 0.07, 0.10, 0.13]);
    assert.equal(rimIceBand(1), 0);
    assert.equal(rimIceBand(3), 0.10);
    for (let x = -40; x < 40; x++) {
        const r = rimIceReach(0.10, x, 7);
        assert.ok(r >= 0.075 && r <= 0.125);
    }
    const snow = rampSet('snow');
    const ice = new Set([pack(hex(ART_RAMPS.snow[0])), pack(hex(ART_RAMPS.snow[1]))]);
    const results = [];
    for (const [cover, bucket] of [[0.25, 1], [0.5, 2], [1, 4]]) {
        const { coast, baked, renderer } = coastFixture(cover);
        const { w, role, data } = baked;
        let lagoonIce = 0;
        let riverIce = 0;
        let lagoonRim = 0;
        const columns = new Map();
        for (let at = 0; at < role.length; at++) {
            const x = coast.x + (at % w);
            const y = coast.y + Math.floor(at / w);
            const u = (y + 0.5) / TILE_HEIGHT + (x + 0.5) / TILE_WIDTH;
            const v = (y + 0.5) / TILE_HEIGHT - (x + 0.5) / TILE_WIDTH;
            const k = rgbKey(data, at * 4);
            const inLagoon = u > 7 && u < 15 && v > 7 && v < 15;
            const inRiver = v > 25.5 && v < 28.5 && u > 4 && u < 32;
            const cell = Math.floor(at / w / 2) * coast.cols + Math.floor((at % w) / 2);
            if (inLagoon && coast.caps[cell] === 3 && role[at] >= 2 && role[at] < 249) lagoonRim++;
            if (!ice.has(k) || role[at] !== 250) continue;
            if (inLagoon) {
                lagoonIce++;
                columns.set(x, (columns.get(x) || 0) + 1);
            } else if (inRiver) riverIce++;
        }
        assert.equal(riverIce, 0, 'a river never freezes');
        if (bucket < 2) {
            assert.equal(lagoonIce, 0, `no ice at bucket ${bucket}`);
        } else {
            assert.ok(lagoonIce > 200, `lagoon ice ${lagoonIce} at bucket ${bucket}`);
            assert.equal(coast.iceBand, ICE_BAND[bucket]);
            // No swash on the frozen rim; the lagoon flag stays.
            const f = renderer._coastBake.waterFields;
            for (let cell = 0; cell < coast.ice.length; cell++) {
                if (!coast.ice[cell]) continue;
                assert.equal(f.coastField[cell * 2 + 1] & COAST_FIELD_FLAGS.swash, 0, 'ice never laps');
            }
        }
        results.push(`bucket ${bucket}: ${lagoonIce} ice px (open water ${lagoonRim} px)`);
        void snow;
    }
    t.diagnostic(`lagoon rim ice: ${results.join('; ')}`);
    const two = coastFixture(0.5);
    const four = coastFixture(1);
    const count = ({ baked }) => {
        let n = 0;
        for (let at = 0; at < baked.role.length; at++) if (baked.role[at] === 250 && ice.has(rgbKey(baked.data, at * 4))) n++;
        return n;
    };
    assert.ok(count(four) > count(two) * 1.3, 'the band widens with the snow');
});

// ---- §4.9 Canvas sky-in-water Fresnel ---------------------------------------

test('§4.9: world-anchored sea Fresnel courses — bent seams, Bayer crossings, night bit-exact', () => {
    assert.deepEqual(SEA_FRESNEL_Y, [96, 352, 640]);
    assert.deepEqual(SEA_FRESNEL_WEIGHT, [0.62, 0.46, 0.30, 0.0]);
    assert.deepEqual(SEA_FRESNEL_FAR, [1.0, 0.75, 0.40, 0.0]);
    assert.equal(seaFresnelGate(0), 1);
    assert.equal(seaFresnelGate(0.5), 1);
    assert.equal(seaFresnelGate(1), 0);
    assert.ok(Math.abs(seaFresnelGate(0.675) - 0.5) < 1e-9);
    // Courses: far to near down the world, each boundary bent by its band.
    for (let x = -1200; x < 1200; x += 17) {
        const bends = [4, 5, 6].map((band) => seaBandBend(x, band));
        assert.ok(bends.every((b) => Math.abs(b) <= 14));
        assert.equal(seaFresnelCourseAt(x, SEA_FRESNEL_Y[0] + bends[0] - 3), 0);
        assert.equal(seaFresnelCourseAt(x, SEA_FRESNEL_Y[0] + bends[0] + 2), 1);
        assert.equal(seaFresnelCourseAt(x, SEA_FRESNEL_Y[2] + bends[2] + 2), SEA_FRESNEL_NEAR);
        assert.equal(seaFresnelCourseAt(x, -100), 0);
        assert.equal(seaFresnelCourseAt(x, 1000), SEA_FRESNEL_NEAR);
    }
    // A boundary is crossed on the Bayer order within ±2 rows, never ruled.
    let mixed = 0;
    for (let x = 0; x < 64; x++) {
        const row = SEA_FRESNEL_Y[1] + seaBandBend(x, 5);
        const seen = new Set();
        for (let dy = -2; dy <= 1; dy++) seen.add(seaFresnelCourseAt(x, row + dy));
        if (seen.size === 2) mixed++;
        assert.equal(seaFresnelCourseAt(x, row - 3), 1);
        assert.equal(seaFresnelCourseAt(x, row + 2), 2);
    }
    assert.ok(mixed > 40, `dithered crossings ${mixed}`);
    // Moods: the far course takes the far sky, the near three the mood's.
    const day = { night: 0, skyHorizon: '#b8d6e6', shadowTint: [0.9, 0.95, 1.08], skyTop: '#4a86c0' };
    const mood = waterMoodFor({ lightGrade: day, weather: { type: 'clear' } });
    const fresnel = seaFresnelMoods(mood, { ...day, seaFar: '#f0b27a' });
    assert.equal(fresnel.moods.length, 3);
    const far = [0xf0, 0xb2, 0x7a].map((c) => Math.round(c / 255 * 32) / 32);
    assert.deepEqual(fresnel.moods[0].sky, far, 'course 0 is the far sky');
    assert.equal(fresnel.moods[0].skyWeight, Math.max(mood.skyWeight, Math.round(0.62 * 32) / 32));
    assert.ok(fresnel.moods[2].skyWeight >= mood.skyWeight && fresnel.moods[2].skyWeight <= fresnel.moods[1].skyWeight);
    for (const m of fresnel.moods) {
        assert.equal(m.night, mood.night);
        for (const v of [...m.sky, m.skyWeight]) assert.equal(v * 32, Math.round(v * 32), 'on the 1/32 buckets');
    }
    // `seaFar` falls back to the horizon; the night shuts the courses.
    assert.deepEqual(seaFresnelMoods(mood, day).moods[0].sky, [0xb8, 0xd6, 0xe6].map((c) => Math.round(c / 255 * 32) / 32));
    assert.equal(seaFresnelMoods(mood, { ...day, night: 1 }), null);
    assert.equal(seaFresnelMoods(mood, { ...day, seaFresnelGate: 0 }), null);
    assert.equal(seaFresnelMoods(mood, null), null);
});

function fakeCanvas(width = 0, height = 0) {
    const canvas = { width, height, data: new Uint8ClampedArray(width * height * 4) };
    canvas.getContext = () => ({
        canvas,
        drawImage() {},
        getImageData(sx, sy, sw, sh) {
            const out = new Uint8ClampedArray(sw * sh * 4);
            for (let y = 0; y < sh; y++) out.set(canvas.data.subarray(((sy + y) * canvas.width + sx) * 4, ((sy + y) * canvas.width + sx + sw) * 4), y * sw * 4);
            return { width: sw, height: sh, data: out };
        },
        putImageData(image) { canvas.width = image.width; canvas.height = image.height; canvas.data = Uint8ClampedArray.from(image.data); },
    });
    return canvas;
}

test('§4.9: the Canvas mood layer bakes the far-sea courses on sea texels only, and stays bit-exact at night', async (t) => {
    const { drawCanvasWaterMood, COAST_WATER_STOPS } = await import('../../claudeville/src/presentation/character-mode/CoastBake.js');
    const { evaluateGrade } = await import('../../claudeville/src/presentation/character-mode/GradeEvaluator.js');
    const origDoc = globalThis.document;
    const origImageData = globalThis.ImageData;
    globalThis.document = { createElement: () => fakeCanvas() };
    globalThis.ImageData = class { constructor(w, h) { this.width = w; this.height = h; this.data = new Uint8ClampedArray(w * h * 4); } };
    t.after(() => { globalThis.document = origDoc; globalThis.ImageData = origImageData; });
    // Two columns of lattice cells down world y 0..800: column 0 the sea,
    // column 1 a lagoon, every texel the same water stop.
    const rows = 400;
    const stop = COAST_WATER_STOPS[3];
    const make = (sea) => {
        const terrain = fakeCanvas(4, rows * 2);
        for (let i = 0; i < 4 * rows * 2; i++) terrain.data.set([...stop, 255], i * 4);
        const coastField = new Uint8Array(2 * rows * 2);
        for (let r = 0; r < rows; r++) {
            coastField[(r * 2) * 2] = 128 + 96;
            coastField[(r * 2) * 2 + 1] = COAST_FIELD_FLAGS.water | (sea ? COAST_FIELD_FLAGS.sea : 0);
            coastField[(r * 2 + 1) * 2] = 128 + 96;
            coastField[(r * 2 + 1) * 2 + 1] = COAST_FIELD_FLAGS.water | COAST_FIELD_FLAGS.lagoon;
        }
        return {
            terrainCache: terrain,
            terrainCacheBounds: { x: 0, y: 0 },
            terrainCacheKey: `fresnel-${sea}`,
            _coastBake: {
                coast: { x: 0, y: 0, cols: 2, rows, classes: new Uint8Array(2 * rows).fill(3 + 3), outer: new Uint8Array(2 * rows) },
                waterFields: { revision: 1, x: 0, y: 0, cols: 2, rows, coastField },
            },
            postFx: { isActive: () => false },
        };
    };
    const clear = { type: 'clear', cloudCover: 0.08, fog: 0, intensity: 0.18 };
    const at = (minute) => ({ weather: clear, lightGrade: evaluateGrade({ minuteOfDay: minute, weather: clear, moonFill: 0.5 }), sky: { sun: { elevationDeg: 10 } } });
    const px = (renderer, x, y) => {
        const layer = renderer._coastMoodLayer;
        const o = (y * layer.canvas.width + x) * 4;
        return [layer.canvas.data[o], layer.canvas.data[o + 1], layer.canvas.data[o + 2]];
    };
    const target = fakeCanvas(4, 4).getContext();
    // Golden hour: the far sea takes the warm far sky, the near sea and the
    // lagoon keep today's water.
    const golden = at(18 * 60);
    assert.ok(golden.lightGrade.night < 0.85);
    const withSea = make(true);
    const flat = make(false);
    drawCanvasWaterMood(target, withSea, golden);
    drawCanvasWaterMood(target, flat, golden);
    const layer = withSea._coastMoodLayer;
    assert.equal(layer.courses.length, layer.pixels.length);
    const far = px(withSea, 0, 20);
    const near = px(withSea, 0, 760);
    assert.notDeepEqual(far, near, 'the far course takes the sky');
    assert.ok(far[0] - far[2] > near[0] - near[2], `the far sea is warmer (${far} vs ${near})`);
    assert.deepEqual(near, px(flat, 0, 760), 'course 3 is today\'s water exactly');
    for (const y of [20, 200, 500, 760]) assert.deepEqual(px(withSea, 2, y), px(flat, 2, y), 'a lagoon keeps the flat sky');
    let warmer = 0;
    for (let y = 0; y < 800; y += 8) if (px(withSea, 0, y)[0] !== near[0]) warmer++;
    t.diagnostic(`golden far ${far.join(',')} vs near ${near.join(',')}; ${warmer} of 100 sampled sea rows on a far course`);
    // Night (22:00, gate 0): bit-exact, the sea flag changes nothing.
    const night = at(22 * 60);
    assert.ok(night.lightGrade.night >= 0.85);
    const seaNight = make(true);
    const flatNight = make(false);
    seaNight.terrainCacheKey = 'n1';
    flatNight.terrainCacheKey = 'n2';
    drawCanvasWaterMood(target, seaNight, night);
    drawCanvasWaterMood(target, flatNight, night);
    assert.deepEqual(seaNight._coastMoodLayer.canvas.data, flatNight._coastMoodLayer.canvas.data);
});

// ---- slicing ------------------------------------------------------------------

test('W1 bake slices stay within the 9 ms cap in every season', (t) => {
    const trees = [{ species: 'ash', size: 'world', variant: 0, tileX: 8, tileY: 30 }];
    for (let k = 0; k < 120; k++) trees.push({ species: k % 3 ? 'oak' : 'pine', size: k % 4 ? 'large' : 'tall', variant: 0, tileX: 4 + (k * 7) % 32, tileY: 3 + (k * 11) % 33 });
    const report = [];
    for (const [season, id] of [['winter', 'winter'], ['spring', 'spring-bare'], ['spring', 'spring'], ['autumn', 'fall-5']]) {
        const { renderer } = groundFixture(t, season, stage(id), {
            world: { buildings: new Map([['archive', { type: 'archive', position: { tileX: 3, tileY: 15 }, width: 5, height: 3 }]]) },
            scenery: { getTreeProps: () => trees },
        });
        let best = Infinity;
        let accounted = Infinity;
        for (let run = 0; run < 3 && best > GROUND_BAKE_BUDGET.sliceCapMs; run++) {
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
        report.push(`${id} ${best.toFixed(2)} ms`);
        assert.ok(best <= GROUND_BAKE_BUDGET.sliceCapMs, `${id}: longest measured slice ${best.toFixed(2)} ms`);
        assert.ok(accounted <= GROUND_BAKE_BUDGET.sliceCapMs, `${id}: longest accounted slice ${accounted.toFixed(2)} ms`);
    }
    t.diagnostic(`longest slice: ${report.join(', ')}`);
    void MAP_SIZE;
});
