import test from 'node:test';
import assert from 'node:assert/strict';
import { ART_RAMPS } from '../../claudeville/src/config/artPalette.js';
import { BUILDING_DEFS } from '../../claudeville/src/config/buildings.js';
import { WORLD_TREE } from '../../claudeville/src/config/scenery.js';
import { TILE_WIDTH, TILE_HEIGHT } from '../../claudeville/src/config/constants.js';
import { buildingCenterToWorld, tileToWorld } from '../../claudeville/src/presentation/character-mode/Projection.js';
import { evaluateGrade, applyGradeToRgb } from '../../claudeville/src/presentation/character-mode/GradeEvaluator.js';
import { bakeGround, bakeWinterGround } from '../../claudeville/src/presentation/character-mode/GroundBake.js';

const hexToRgb = (hex) => [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
];
const rgb01 = (hex) => hexToRgb(hex).map(v => v / 255);
const luma255 = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
const hsvS = ([r, g, b]) => {
    const mx = Math.max(r, g, b);
    return mx > 0 ? (mx - Math.min(r, g, b)) / mx : 0;
};

function makeBakeFixture(t, overrides = {}) {
    let lastImageData = null;
    globalThis.ImageData = class {
        constructor(width, height) {
            this.width = width;
            this.height = height;
            this.data = new Uint8ClampedArray(width * height * 4);
        }
    };
    globalThis.document = {
        createElement: () => {
            let ownImageData = null;
            return {
                width: 0,
                height: 0,
                getContext: () => ({
                    putImageData(img) { ownImageData = img; lastImageData = img; },
                    getImageData() {
                        const copy = new globalThis.ImageData(ownImageData.width, ownImageData.height);
                        copy.data.set(ownImageData.data);
                        return copy;
                    },
                }),
            };
        },
    };
    t.after(() => {
        delete globalThis.ImageData;
        delete globalThis.document;
    });
    const renderer = {
        _coastField: { key: 'land', signedDistance: () => -9 },
        townSquareTiles: new Set(),
        roadTiles: new Set(),
        world: { buildings: new Map() },
        scenery: { getTreeProps: () => [] },
        ...overrides,
    };
    return { renderer, getImage: () => lastImageData };
}

function worldToTexel(base, wx, wy) {
    const col = Math.floor((wx - base.x0) / 2);
    const row = Math.floor(wy - base.y0);
    return { col, row, idx: row * base.cols + col };
}

test('C-02 ramps: road[2] stays lighter than grass[2] in raw luma and under every diurnal/night grade', () => {
    const grass2 = ART_RAMPS.grass[2];
    const road2 = ART_RAMPS.road[2];
    const plaza2 = ART_RAMPS.plaza[2];
    const ashlar5 = ART_RAMPS.ashlar[5];

    assert.ok(luma255(hexToRgb(road2)) > luma255(hexToRgb(grass2)),
        `road[2] ${road2} (${luma255(hexToRgb(road2)).toFixed(2)}) must exceed grass[2] ${grass2} (${luma255(hexToRgb(grass2)).toFixed(2)})`);
    for (const hex of ART_RAMPS.road) {
        assert.ok(hsvS(hexToRgb(hex)) <= 0.11, `road stop ${hex} saturation ${hsvS(hexToRgb(hex)).toFixed(3)} exceeds 0.11`);
    }
    assert.ok(luma255(hexToRgb(plaza2)) > luma255(hexToRgb(road2)) + 10,
        `plaza[2] ${plaza2} must sit distinctly lighter than road[2] ${road2}`);
    assert.ok(luma255(hexToRgb(plaza2)) < luma255(hexToRgb(ashlar5)) - 6,
        `plaza[2] ${plaza2} (${luma255(hexToRgb(plaza2)).toFixed(1)}) must step clearly below sunlit ashlar[5] ${ashlar5} (${luma255(hexToRgb(ashlar5)).toFixed(1)})`);

    const CLEAR = { type: 'clear', cloudCover: 0.08 };
    const STORM = { type: 'storm', cloudCover: 0.95, precipitation: 0.9, intensity: 0.9 };
    const cases = [
        ['noon 12:30', evaluateGrade({ minuteOfDay: 12 * 60 + 30, weather: CLEAR, moonFill: 0 })],
        ['dusk 18:00', evaluateGrade({ minuteOfDay: 18 * 60, weather: CLEAR, moonFill: 0 })],
        ['blue-hour 19:45', evaluateGrade({ minuteOfDay: 19 * 60 + 45, weather: CLEAR, moonFill: 0 })],
        ['night 22:30 full moon', evaluateGrade({ minuteOfDay: 22 * 60 + 30, weather: CLEAR, moonFill: 1 })],
        ['night 22:30 new moon', evaluateGrade({ minuteOfDay: 22 * 60 + 30, weather: CLEAR, moonFill: 0 })],
        ['storm 02:00', evaluateGrade({ minuteOfDay: 2 * 60, weather: STORM, moonFill: 0 })],
        ['deeper night exp 0.65', { ...evaluateGrade({ minuteOfDay: 22 * 60 + 30, weather: CLEAR, moonFill: 1 }), exposure: 0.65 }],
    ];
    for (const [label, grade] of cases) {
        const gL = luma255(applyGradeToRgb(rgb01(grass2), grade)) * 255;
        const rL = luma255(applyGradeToRgb(rgb01(road2), grade)) * 255;
        assert.ok(rL > gL, `${label}: road[2] (${rL.toFixed(2)}) must stay lighter than grass[2] (${gL.toFixed(2)})`);
    }
});

test('C-02 turf: seam-only dithering calms open meadow texel-to-texel luminance chatter', t => {
    const { renderer, getImage } = makeBakeFixture(t);
    const base = bakeGround(renderer);
    const img = getImage();
    const w = base.cols * 2;
    const center = tileToWorld(20, 20);
    const { col: c0, row: r0 } = worldToTexel(base, center.x - 160, center.y - 80);
    let pairs = 0;
    let sumDiff = 0;
    let flat = 0;
    for (let row = r0; row < r0 + 140; row++) {
        for (let col = c0; col < c0 + 140; col++) {
            const o1 = (row * w + col * 2) * 4;
            const o2 = (row * w + (col + 1) * 2) * 4;
            const l1 = luma255([img.data[o1], img.data[o1 + 1], img.data[o1 + 2]]);
            const l2 = luma255([img.data[o2], img.data[o2 + 1], img.data[o2 + 2]]);
            const d = Math.abs(l1 - l2);
            sumDiff += d;
            if (d <= 1.5) flat++;
            pairs++;
        }
    }
    const meanAdj = sumDiff / pairs;
    const flatShare = flat / pairs;
    assert.ok(meanAdj < 9.5, `meadow mean adjacent luma step ${meanAdj.toFixed(2)} should be < 9.5`);
    assert.ok(flatShare > 0.55, `meadow flat adjacent share ${(flatShare * 100).toFixed(1)}% should exceed 55%`);
});

test('C-02 paving: Archive painted-plinth AO, >1-step paving AO collar, and recessed plaza-to-road kerb', t => {
    const archiveDef = BUILDING_DEFS.find(d => d.type === 'archive');
    const townSquareTiles = new Set();
    const roadTiles = new Set();
    for (let ty = 19; ty <= 21; ty++) {
        for (let tx = 18; tx <= 20; tx++) townSquareTiles.add(`${tx},${ty}`);
        for (let tx = 21; tx <= 23; tx++) roadTiles.add(`${tx},${ty}`);
    }
    const { renderer, getImage } = makeBakeFixture(t, {
        townSquareTiles,
        roadTiles,
        assets: { getAnchor: (id) => (id === 'building.archive' ? [167, 182] : [0, 0]) },
        world: {
            buildings: new Map([
                ['archive', {
                    type: 'archive',
                    position: { tileX: archiveDef.x, tileY: archiveDef.y },
                    width: archiveDef.width,
                    height: archiveDef.height,
                }],
                // A solid building right next to the test plaza so paving contact AO can be measured directly.
                ['command', {
                    type: 'command',
                    position: { tileX: 18, tileY: 18 },
                    width: 2,
                    height: 2,
                }],
            ]),
        },
    });
    const base = bakeGround(renderer);
    const img = getImage();
    const w = base.cols * 2;

    // 1. Archive painted SW plinth ([40,172] -> [212,230]) carries full contact AO at midpoint.
    const centre = buildingCenterToWorld(renderer.world.buildings.get('archive'));
    const midX = centre.x + (40 + 212) / 2 - 167;
    const midY = centre.y + (172 + 230) / 2 - 182;
    const foot = worldToTexel(base, midX, midY - 2);
    const near = worldToTexel(base, midX, midY + 3);
    assert.equal(base.aoBuf[foot.idx], 255, 'Archive SW plinth foot must have full contact AO');
    assert.ok(base.aoBuf[near.idx] >= 160, `Archive SW plinth near contact AO (${base.aoBuf[near.idx]}) must be >= 160`);

    // 2. Plaza texels right under Command's south edge darken past old PAVING_AO_CAP (0.32 -> ~1 stop),
    // reaching PLAZA[0] (#6a6155 or ramp stop 0).
    const plazaStop0 = hexToRgb(ART_RAMPS.plaza[0]);
    let plazaDarkCount = 0;
    let plazaRoadKerbMatches = 0;
    const roadStop0 = hexToRgb(ART_RAMPS.road[0]);
    for (let row = 1; row < base.rows - 1; row++) {
        for (let col = 1; col < base.cols - 1; col++) {
            const idx = row * base.cols + col;
            if (base.surfaces[idx] !== 4) continue; // S_PLAZA
            const o = (row * w + col * 2) * 4;
            const r = img.data[o], g = img.data[o + 1], b = img.data[o + 2];
            if (base.aoBuf[idx] > 180 && r === plazaStop0[0] && g === plazaStop0[1] && b === plazaStop0[2]) {
                plazaDarkCount++;
            }
            const below = base.surfaces[(row + 1) * base.cols + col];
            if (below === 3 && r === roadStop0[0] && g === roadStop0[1] && b === roadStop0[2]) {
                plazaRoadKerbMatches++;
            }
        }
    }
    assert.ok(plazaDarkCount > 10, `expected >10 plaza texels reaching PLAZA[0] in plinth AO collar, got ${plazaDarkCount}`);
    assert.ok(plazaRoadKerbMatches >= 5, `expected recessed ROAD[0] kerb where S_PLAZA meets S_ROAD below, got ${plazaRoadKerbMatches}`);
});

test('C-02 trees: World Ash gets wide root contact AO without a painted dark root-moss ring', t => {
    const ash = { tileX: WORLD_TREE.tileX, tileY: WORLD_TREE.tileY, species: 'ash', size: 'world', variant: 0 };
    const oak = { tileX: 20, tileY: 20, species: 'oak', size: 'tall', variant: 0 };
    const { renderer, getImage } = makeBakeFixture(t, {
        scenery: { getTreeProps: () => [ash, oak] },
    });
    const base = bakeGround(renderer);
    const img = getImage();
    const w = base.cols * 2;

    // World Ash elliptical root contact AO extends well past the old 0.55-tile circle (~17px).
    const ashWorld = tileToWorld(ash.tileX, ash.tileY);
    const probe = worldToTexel(base, ashWorld.x - 3 + 42, ashWorld.y - 28);
    assert.ok(base.aoBuf[probe.idx] > 40, `World Ash root AO at +42px should exceed 40, got ${base.aoBuf[probe.idx]}`);

    // Neither the World Ash nor the tall oak paints dark FOLIAGE[0] root-moss ring pixels onto open grass.
    const foliage0 = hexToRgb(ART_RAMPS.foliage[0]);
    const countFoliage0Around = (wx, wy, rx, ry) => {
        let hits = 0;
        const { col: c0, row: r0 } = worldToTexel(base, wx - rx, wy - ry);
        const { col: c1, row: r1 } = worldToTexel(base, wx + rx, wy + ry);
        for (let row = Math.max(0, r0); row <= Math.min(base.rows - 1, r1); row++) {
            for (let col = Math.max(0, c0); col <= Math.min(base.cols - 1, c1); col++) {
                const o = (row * w + col * 2) * 4;
                if (img.data[o] === foliage0[0] && img.data[o + 1] === foliage0[1] && img.data[o + 2] === foliage0[2]) {
                    hits++;
                }
            }
        }
        return hits;
    };
    const oakWorld = tileToWorld(oak.tileX, oak.tileY);
    assert.equal(countFoliage0Around(ashWorld.x, ashWorld.y - 24, 90, 60), 0,
        'World Ash must not paint a dark FOLIAGE[0] root-moss ring on top of contact AO');
    assert.equal(countFoliage0Around(oakWorld.x, oakWorld.y - 6, 36, 24), 0,
        'Tall oak must not paint a dark FOLIAGE[0] root-moss ring inside contact AO');
});

test('C-02 winter snow: 4-stop SNOW_TONE_BY_RANK without baked cast-shadow double-darkening', t => {
    const { renderer, getImage } = makeBakeFixture(t, {
        world: {
            buildings: new Map([
                ['command', { type: 'command', position: { tileX: 20, tileY: 20 }, width: 2, height: 2 }],
            ]),
        },
    });
    const base = bakeGround(renderer, true);

    // Run bakeWinterGround with weather cast-shade channel forced to 0 vs 230.
    const origWeather = new Uint8Array(base.weather.data);
    for (let i = 0; i < base.weather.data.length; i += 4) base.weather.data[i + 2] = 0;
    bakeWinterGround(renderer, base, 4, 0, 0, false);
    const unshaded = new Uint8ClampedArray(getImage().data);

    for (let i = 0; i < base.weather.data.length; i += 4) base.weather.data[i + 2] = 230;
    bakeWinterGround(renderer, base, 4, 0, 0, false);
    const shaded = new Uint8ClampedArray(getImage().data);
    base.weather.data.set(origWeather);

    // 1. Cast sunShade byte in weather.data[i*4+2] must NOT double-darken snow (SD-1 ShadeField owns cast shade).
    let diffBytes = 0;
    for (let i = 0; i < unshaded.length; i++) {
        if (unshaded[i] !== shaded[i]) diffBytes++;
    }
    assert.equal(diffBytes, 0, `snow bake must not bake cast shadow a second time (found ${diffBytes} differing bytes)`);

    // 2. Four sunlit snow stops (including SNOW[1] on rank-0 snowy grass) are active in full snow cover.
    const snow1 = hexToRgb(ART_RAMPS.snow[1]);
    const w = base.cols * 2;
    let snow1OnGrass = 0;
    for (let row = 0; row < base.rows; row++) {
        for (let col = 0; col < base.cols; col++) {
            const idx = row * base.cols + col;
            if (base.surfaces[idx] !== 0) continue; // S_GRASS
            const o = (row * w + col * 2) * 4;
            if (unshaded[o] === snow1[0] && unshaded[o + 1] === snow1[1] && unshaded[o + 2] === snow1[2]) {
                snow1OnGrass++;
            }
        }
    }
    assert.ok(snow1OnGrass > 500, `expected >500 grass texels reaching SNOW[1] under 4-stop snow, got ${snow1OnGrass}`);
});
