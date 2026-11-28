import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPoolDodgeStamp, gradedPoolReceiver } from '../../claudeville/src/presentation/character-mode/CanvasGrade.js';
import { evaluateGrade } from '../../claudeville/src/presentation/character-mode/GradeEvaluator.js';
import { GRADE_CONSTANTS, LAND_FULL_STRENGTH } from '../../claudeville/src/presentation/character-mode/gpu/GpuWorldPolicy.js';
import { RECEIVER_LUMA_CEILING } from '../../claudeville/src/config/artPalette.js';
import { CANVAS_BUDGET, canvasMapPixelCount } from '../../claudeville/src/presentation/character-mode/CanvasBudget.js';
import {
    groundCourseHeight,
    lightSourceCacheKey,
    lightStampCacheKey,
    normalizeLightSource,
} from '../../claudeville/src/presentation/character-mode/LightSourceRegistry.js';
import { IsometricRenderer } from '../../claudeville/src/presentation/character-mode/IsometricRenderer.js';

const LUMA = [0.2126, 0.7152, 0.0722];
const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
const POOL_RIM = [1.484, 0.914, 0.430];
const POOL_MID = [1.208, 0.981, 0.577];
const POOL_CORE = [1.089, 0.995, 0.786];
const POOL_STOPS = GRADE_CONSTANTS.AMBIENT_POOL_STOPS.value;
const POOL_WEIGHTS = GRADE_CONSTANTS.AMBIENT_POOL_WEIGHTS.value;
const POOL_CHROMA = GRADE_CONSTANTS.AMBIENT_POOL_CHROMA.value;
const POOL_SHARE = GRADE_CONSTANTS.AMBIENT_POOL_SHARE.value;
const LAND_MID = [1.346, 0.948, 0.504];
const LAND_STOPS = [POOL_RIM, LAND_MID, POOL_MID];

function clamp(value, min = 0, max = 1) {
    return Math.max(min, Math.min(max, value));
}

function referenceReceiverScale(receiver, towards, gains) {
    if (!receiver) return 1;
    let base = 0;
    let lift = 0;
    for (let channel = 0; channel < 3; channel++) {
        base += LUMA[channel] * receiver[channel] * towards[channel];
        lift += LUMA[channel] * receiver[channel] * gains[channel];
    }
    const ceiling = Math.max(RECEIVER_LUMA_CEILING, LUMA[0] * receiver[0] + LUMA[1] * receiver[1] + LUMA[2] * receiver[2]);
    if (lift <= 0 || base + lift <= ceiling) return 1;
    return clamp((ceiling - base) / lift);
}

// Reference copy of the original per-pixel rasterizer before course precomputation.
function referenceBuildPoolDodgeStamp({
    rgb = [255, 200, 110],
    radius = 32,
    cell = 1,
    energy = 1,
    ambientTint = [0.4, 0.4, 0.4],
    poolGain = 1,
    receiver = null,
    height = 0,
    normal = null,
    attention = false,
} = {}) {
    const size = Math.max(2, Math.ceil(radius * 2));
    const cellPx = Math.max(1, Math.round(cell));
    const cells = Math.max(1, Math.ceil(size / cellPx));
    const rows = Math.max(1, Math.ceil(cells / 2));
    const color = [rgb[0] / 255, rgb[1] / 255, rgb[2] / 255];
    const colorLuma = Math.max(0.05, color[0] * LUMA[0] + color[1] * LUMA[1] + color[2] * LUMA[2]);
    const hue = color.map(channel => channel / colorLuma);
    const warm = clamp((hue[0] - hue[2]) * 1.25);
    const tintFor = ramp => hue.map((channel, index) => (1 + (channel - 1) * 0.7) * (1 - warm) + ramp[index] * warm);
    const stops = attention ? [0.12, 0.40, 0.75] : POOL_STOPS;
    const weights = attention ? [0.30, 0.54, 0.76] : POOL_WEIGHTS;
    const shares = attention ? [0.84, 0.88, 0.90] : POOL_SHARE;
    const tints = attention ? [POOL_RIM, POOL_MID, POOL_CORE].map(tintFor)
        : POOL_CHROMA.map((chroma, course) => tintFor(POOL_RIM.map((channel, i) =>
            channel + (POOL_CORE[i] - channel) * course / 5)).map(channel => 1 + (channel - 1) * chroma));
    const landTints = attention ? LAND_STOPS.map(tintFor)
        : POOL_CHROMA.map((chroma, course) => tintFor(POOL_RIM.map((channel, i) =>
            channel + (POOL_MID[i] - channel) * course / 5)).map(channel => 1 + (channel - 1) * chroma));
    const ambient = [0, 1, 2].map(index => Math.max(0.12, Number(ambientTint?.[index]) || 0.4));
    const ambientLuma = ambient[0] * LUMA[0] + ambient[1] * LUMA[1] + ambient[2] * LUMA[2];
    const adaptGain = warm * 0.85 * 0.6 * clamp((poolGain - 0.15) / 1.05);
    const shade = warm > 0.01;
    const canvas = document.createElement('canvas');
    canvas.width = shade ? cells * 2 : cells;
    canvas.height = rows;
    const ctx = canvas.getContext('2d');
    const image = ctx.createImageData(canvas.width, rows);
    const data = image.data;
    if (shade) {
        for (let y = 0; y < rows; y++) data.fill(255, (y * canvas.width + cells) * 4, (y * canvas.width + cells * 2) * 4);
    }
    const centreX = cells / 2;
    const centreY = rows / 2;
    const radiusCells = radius / cellPx;
    const heightCells = Math.max(0, Number(height) || 0) / cellPx;
    const reachCells = Math.max(1, Math.hypot(radiusCells, heightCells));
    const lobed = Array.isArray(normal) && normal.length >= 2;
    for (let y = 0; y < rows; y++) {
        for (let x = 0; x < cells; x++) {
            const gx = x + 0.5 - centreX;
            const gy = (y + 0.5 - centreY) * 2;
            const d = Math.hypot(gx, gy, heightCells);
            const t = d / reachCells;
            if (t >= 1) continue;
            const lobe = lobed ? clamp(0.30 + 1.4 * (normal[0] * gx + normal[1] * gy) / Math.max(Math.hypot(gx, gy), 1)) : 1;
            const falloff = (1 - t * t * (3 - 2 * t)) * lobe;
            const q = falloff + (BAYER4[(y % 4) * 4 + (x % 4)] / 16 - 0.5) * 0.08;
            let step = 0;
            for (const stop of stops) if (q >= stop) step++;
            if (step <= 0) continue;
            const strength = Math.min(1, weights[step - 1] * energy * colorLuma);
            const tint = tints[step - 1];
            const landTint = landTints[step - 1];
            const offset = (y * canvas.width + x) * 4;
            const lift = poolGain * strength / ambientLuma;
            const land = warm * shares[step - 1] * Math.max(Math.min(1, strength / LAND_FULL_STRENGTH), clamp(1.6 * lift / (1 + lift)));
            const adapt = shade ? Math.max(Math.min(1, strength * 1.5) * adaptGain, land) : 0;
            const towards = [0, 0, 0];
            const gains = [0, 0, 0];
            for (let channel = 0; channel < 3; channel++) {
                gains[channel] = poolGain * strength * tint[channel] / ambient[channel];
                towards[channel] = 1 + (landTint[channel] * ambientLuma / ambient[channel] - 1) * adapt;
            }
            const scale = referenceReceiverScale(receiver, towards, gains);
            for (let channel = 0; channel < 3; channel++) {
                const toward = towards[channel];
                const m = gains[channel] * scale;
                const multiply = Math.min(1, toward);
                const dodge = (toward + m) / multiply;
                data[offset + channel] = Math.round(clamp(1 - 1 / dodge, 0, 0.94) * 255);
                if (shade) data[offset + cells * 4 + channel] = Math.round(multiply * 255);
            }
            data[offset + 3] = 255;
        }
    }
    ctx.putImageData(image, 0, 0);
    canvas._poolCellPx = cellPx;
    canvas._poolCells = cells;
    canvas._poolRows = rows;
    canvas._poolShade = shade;
    return canvas;
}

function withMockDocument(fn) {
    const original = globalThis.document;
    let created = 0;
    globalThis.document = {
        createElement: () => {
            created++;
            const canvas = { width: 0, height: 0, _createdIndex: created };
            canvas.getContext = () => ({
                createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
                putImageData: (image) => { canvas.image = image; },
            });
            return canvas;
        },
    };
    try {
        return fn({ getCreatedCount: () => created });
    } finally {
        globalThis.document = original;
    }
}

function makeRenderer(zoom = 1) {
    const renderer = Object.create(IsometricRenderer.prototype);
    renderer.camera = { zoom };
    renderer.lightGradientCache = new Map();
    renderer.lightColorRgbCache = new Map();
    renderer._lightColorRgbCacheEvictions = 0;
    renderer._lightStampFrame = 0;
    return renderer;
}

function assertIdenticalStamps(actual, expected, label) {
    assert.equal(actual.width, expected.width, `${label}: width`);
    assert.equal(actual.height, expected.height, `${label}: height`);
    assert.equal(actual._poolCellPx, expected._poolCellPx, `${label}: _poolCellPx`);
    assert.equal(actual._poolCells, expected._poolCells, `${label}: _poolCells`);
    assert.equal(actual._poolRows, expected._poolRows, `${label}: _poolRows`);
    assert.equal(actual._poolShade, expected._poolShade, `${label}: _poolShade`);
    assert.deepEqual(actual.image.data, expected.image.data, `${label}: RGBA bytes`);
}

test('precomputed-course buildPoolDodgeStamp matches per-pixel reference byte-for-byte across 70+ cases', () => {
    withMockDocument(() => {
        const clear = { type: 'clear', intensity: 0, cloudCover: 0.08 };
        const nightGrade = evaluateGrade({ minuteOfDay: 22.78 * 60, weather: clear, moonFill: 0.5 });
        const duskGrade = evaluateGrade({ minuteOfDay: 19.75 * 60, weather: clear, moonFill: 0.5 });
        const noonGrade = evaluateGrade({ minuteOfDay: 12.5 * 60, weather: clear, moonFill: 0 });

        const cases = [];
        for (const radius of [14, 38.5, 66, 99.4]) {
            for (const cell of [1, 3]) {
                for (const attention of [false, true]) {
                    for (const rgb of [[255, 201, 94], [120, 190, 255]]) {
                        for (const normal of [null, [-Math.SQRT1_2, Math.SQRT1_2]]) {
                            const grade = cases.length % 2 === 0 ? nightGrade : duskGrade;
                            cases.push({
                                rgb,
                                radius,
                                cell,
                                energy: attention ? 0.59375 : 0.9375,
                                ambientTint: grade.ambientTint,
                                poolGain: grade.poolGain,
                                receiver: cases.length % 3 === 0 ? null : gradedPoolReceiver(grade),
                                height: normal ? 14.35 : 0,
                                normal,
                                attention,
                            });
                        }
                    }
                }
            }
        }
        // Edge cases: tiny radius, zero energy, clamped ambientTint, NaN normal, noon grade, oblique normal.
        cases.push(
            { rgb: [255, 200, 110], radius: 1, cell: 1, energy: 1, ambientTint: [0.05, 0.05, 0.05], poolGain: 1.2, receiver: gradedPoolReceiver(nightGrade), height: 0, normal: null, attention: false },
            { rgb: [255, 200, 110], radius: 42, cell: 2, energy: 0, ambientTint: nightGrade.ambientTint, poolGain: nightGrade.poolGain, receiver: gradedPoolReceiver(nightGrade), height: 20, normal: null, attention: false },
            { rgb: [255, 200, 110], radius: 55, cell: 1, energy: 0.75, ambientTint: noonGrade.ambientTint, poolGain: noonGrade.poolGain, receiver: gradedPoolReceiver(noonGrade), height: 35, normal: [0.6, 0.8], attention: false },
            { rgb: [160, 160, 160], radius: 40, cell: 1, energy: 0.5, ambientTint: nightGrade.ambientTint, poolGain: nightGrade.poolGain, receiver: null, height: 0, normal: [Math.SQRT1_2, Math.SQRT1_2], attention: true },
            { rgb: [255, 169, 74], radius: 32, cell: 1, energy: 1, ambientTint: nightGrade.ambientTint, poolGain: nightGrade.poolGain, receiver: null, height: 0, normal: [Number.NaN, Number.NaN], attention: false },
            { rgb: [255, 180, 90], radius: 72.865, cell: 1, energy: 0.5625, ambientTint: duskGrade.ambientTint, poolGain: duskGrade.poolGain, receiver: gradedPoolReceiver(duskGrade), height: 28.252, normal: [-Math.SQRT1_2, Math.SQRT1_2], attention: false },
        );

        assert.ok(cases.length >= 70);
        for (let i = 0; i < cases.length; i++) {
            assertIdenticalStamps(buildPoolDodgeStamp(cases[i]), referenceBuildPoolDodgeStamp(cases[i]), `case[${i}]`);
        }
    });
});

test('lightStampCacheKey separates placement from raster inputs and preserves legacy lightSourceCacheKey', () => {
    const lampA = normalizeLightSource({ id: 'village.lantern.1.2', x: 100, y: 200, radius: 66, color: '#ffc95e', role: 'fixture', height: 24 });
    const lampB = normalizeLightSource({ id: 'village.lantern.9.14', x: -450, y: 820, radius: 66, color: '#ffc95e', role: 'fixture', height: 24 });
    assert.notEqual(lightSourceCacheKey(lampA, 'pool'), lightSourceCacheKey(lampB, 'pool'));

    const baseArgs = {
        rgb: [255, 201, 94],
        radius: 66,
        cell: 1,
        energy: 1,
        ambientTint: [0.3, 0.32, 0.45],
        poolGain: 1.2,
        receiver: [0.31, 0.34, 0.42],
        height: 0,
        normal: null,
        attention: false,
    };
    const baseKey = lightStampCacheKey(baseArgs);
    assert.ok(baseKey.startsWith('pool|'));
    // Canonical equivalences that produce identical rasters share one key.
    assert.equal(lightStampCacheKey({ ...baseArgs, height: -0 }), baseKey);
    assert.equal(lightStampCacheKey({ ...baseArgs, ambientTint: [0.04, 0.08, 0.11] }), lightStampCacheKey({ ...baseArgs, ambientTint: [0.12, 0.12, 0.12] }));

    // Every raster-visible input changes the key.
    const variations = [
        { rgb: [255, 200, 94] },
        { radius: 66.05 },
        { cell: 2 },
        { energy: 0.96875 },
        { ambientTint: [0.31, 0.32, 0.45] },
        { poolGain: 1.19 },
        { receiver: [0.31, 0.34, 0.43] },
        { receiver: null },
        { height: 0.4 },
        { normal: [-Math.SQRT1_2, Math.SQRT1_2] },
        { attention: true },
    ];
    for (const patch of variations) {
        assert.notEqual(lightStampCacheKey({ ...baseArgs, ...patch }), baseKey, `expected distinct key for ${JSON.stringify(patch)}`);
    }
});

test('identical lamps at different positions/ids and equivalent colour formats share one cached stamp', () => {
    withMockDocument(({ getCreatedCount }) => {
        const renderer = makeRenderer(1);
        const nightGrade = evaluateGrade({ minuteOfDay: 22.78 * 60, weather: { type: 'clear', intensity: 0, cloudCover: 0.08 }, moonFill: 0.5 });
        const atmosphere = { lightGrade: nightGrade };
        renderer._lightStampFrame = 1;

        const lamps = [
            normalizeLightSource({ id: 'village.lantern.1.1', x: 10, y: 20, radius: 76, color: '#ffc95e', role: 'fixture', height: 24 }),
            normalizeLightSource({ id: 'village.lantern.8.15', x: 420, y: 610, radius: 76, color: '#FFC95E', role: 'fixture', height: 24 }),
            normalizeLightSource({ id: 'village.lantern.12.30', x: -300, y: 900, radius: 76, color: 'rgb(255, 201, 94)', role: 'fixture', height: 24 }),
            normalizeLightSource({ id: 'carried-lantern:walker', x: 111, y: 222, radius: 76, color: '#ffc95e', role: 'fixture', height: 14 }),
        ];

        const first = renderer._getLightGlowStamp(lamps[0], 114, 1, atmosphere);
        for (const lamp of lamps.slice(1)) {
            const got = renderer._getLightGlowStamp(lamp, 114, 1, atmosphere);
            assert.strictEqual(got, first, `expected ${lamp.id} to share cached stamp`);
        }
        assert.equal(getCreatedCount(), 1, 'built exactly one stamp canvas for all identical lamps');
        assert.equal(renderer.lightGradientCache.size, 1);

        // Moving a carried lantern across positions still hits the same stamp.
        const moved = normalizeLightSource({ id: 'carried-lantern:walker', x: 112, y: 223, radius: 76, color: '#ffc95e', role: 'fixture', height: 14 });
        assert.strictEqual(renderer._getLightGlowStamp(moved, 114, 1, atmosphere), first);
        assert.equal(getCreatedCount(), 1);
    });
});

test('bucket-boundary pairs match uncached reference byte-for-byte in both draw orders', () => {
    withMockDocument(() => {
        const clear = { type: 'clear', intensity: 0, cloudCover: 0.08 };
        const nightGrade = evaluateGrade({ minuteOfDay: 22.78 * 60, weather: clear, moonFill: 0.5 });
        const duskGrade = evaluateGrade({ minuteOfDay: 19.75 * 60, weather: clear, moonFill: 0.5 });

        const checkOrderInvariantPair = (label, callA, callB) => {
            const refA = referenceBuildPoolDodgeStamp(callA.ref);
            const refB = referenceBuildPoolDodgeStamp(callB.ref);

            // Order 1: A then B
            const r1 = makeRenderer(1);
            r1._lightStampFrame = 1;
            const a1 = r1._getLightGlowStamp(callA.light, callA.radius, callA.energy, callA.atmosphere);
            const b1 = r1._getLightGlowStamp(callB.light, callB.radius, callB.energy, callB.atmosphere);
            assertIdenticalStamps(a1, refA, `${label} (A-first -> A)`);
            assertIdenticalStamps(b1, refB, `${label} (A-first -> B)`);

            // Order 2: B then A
            const r2 = makeRenderer(1);
            r2._lightStampFrame = 1;
            const b2 = r2._getLightGlowStamp(callB.light, callB.radius, callB.energy, callB.atmosphere);
            const a2 = r2._getLightGlowStamp(callA.light, callA.radius, callA.energy, callA.atmosphere);
            assertIdenticalStamps(b2, refB, `${label} (B-first -> B)`);
            assertIdenticalStamps(a2, refA, `${label} (B-first -> A)`);
        };

        const baseLight = { id: 'a', kind: 'point', role: 'aperture', color: '#ffc95e', height: 24 + 12 / 0.35, normal: [-Math.SQRT1_2, Math.SQRT1_2] };
        const baseAtm = { lightGrade: nightGrade };
        const makeRef = (light, radius, energy, grade) => ({
            rgb: [255, 201, 94],
            radius,
            cell: 1,
            energy: Math.round(energy * 32) / 32,
            ambientTint: grade.ambientTint,
            poolGain: grade.poolGain,
            receiver: gradedPoolReceiver(grade),
            height: groundCourseHeight(light),
            normal: light.normal,
            attention: light.attention === true || light.role === 'attention',
        });

        // 1. Radius straddling Math.round(r)=66 (different canvas dimensions: 264x66 vs 266x67)
        checkOrderInvariantPair(
            'radius round boundary 65.51 vs 66.49',
            { light: { ...baseLight, id: 'r1' }, radius: 65.51, energy: 0.9375, atmosphere: baseAtm, ref: makeRef(baseLight, 65.51, 0.9375, nightGrade) },
            { light: { ...baseLight, id: 'r2' }, radius: 66.49, energy: 0.9375, atmosphere: baseAtm, ref: makeRef(baseLight, 66.49, 0.9375, nightGrade) },
        );

        // 2. Radius straddling ceil(2r) inside the same round bucket (65.51 vs 65.99)
        checkOrderInvariantPair(
            'radius same-size boundary 65.51 vs 65.99',
            { light: { ...baseLight, id: 'r3' }, radius: 65.51, energy: 0.9375, atmosphere: baseAtm, ref: makeRef(baseLight, 65.51, 0.9375, nightGrade) },
            { light: { ...baseLight, id: 'r4' }, radius: 65.99, energy: 0.9375, atmosphere: baseAtm, ref: makeRef(baseLight, 65.99, 0.9375, nightGrade) },
        );

        // 3. Height straddling Math.round(h)=12 (11.51 vs 12.49)
        const hLightA = { ...baseLight, id: 'h1', height: 24 + 11.51 / 0.35 };
        const hLightB = { ...baseLight, id: 'h2', height: 24 + 12.49 / 0.35 };
        checkOrderInvariantPair(
            'height round boundary 11.51 vs 12.49',
            { light: hLightA, radius: 66, energy: 0.9375, atmosphere: baseAtm, ref: makeRef(hLightA, 66, 0.9375, nightGrade) },
            { light: hLightB, radius: 66, energy: 0.9375, atmosphere: baseAtm, ref: makeRef(hLightB, 66, 0.9375, nightGrade) },
        );

        // 4. Normal straddling Math.round(n*8)=[-6,6]
        const nLightA = { ...baseLight, id: 'n1', normal: [-Math.SQRT1_2, Math.SQRT1_2] };
        const nLightB = { ...baseLight, id: 'n2', normal: [-0.6876, 0.7261] };
        checkOrderInvariantPair(
            'normal *8 bucket boundary',
            { light: nLightA, radius: 66, energy: 0.9375, atmosphere: baseAtm, ref: makeRef(nLightA, 66, 0.9375, nightGrade) },
            { light: nLightB, radius: 66, energy: 0.9375, atmosphere: baseAtm, ref: makeRef(nLightB, 66, 0.9375, nightGrade) },
        );

        // 5. ambientTint straddling *32 bucket (9.51/32 vs 10.49/32)
        const tintGradeA = { ...nightGrade, ambientTint: [9.51 / 32, 9.51 / 32, 13.51 / 32] };
        const tintGradeB = { ...nightGrade, ambientTint: [10.49 / 32, 10.49 / 32, 14.49 / 32] };
        checkOrderInvariantPair(
            'ambientTint *32 bucket boundary',
            { light: baseLight, radius: 66, energy: 0.9375, atmosphere: { lightGrade: tintGradeA }, ref: makeRef(baseLight, 66, 0.9375, tintGradeA) },
            { light: baseLight, radius: 66, energy: 0.9375, atmosphere: { lightGrade: tintGradeB }, ref: makeRef(baseLight, 66, 0.9375, tintGradeB) },
        );

        // 6. poolGain straddling *32 bucket at dusk (12.51/32 vs 13.49/32)
        const gainGradeA = { ...duskGrade, poolGain: 12.51 / 32 };
        const gainGradeB = { ...duskGrade, poolGain: 13.49 / 32 };
        checkOrderInvariantPair(
            'poolGain *32 bucket boundary',
            { light: baseLight, radius: 66, energy: 0.9375, atmosphere: { lightGrade: gainGradeA }, ref: makeRef(baseLight, 66, 0.9375, gainGradeA) },
            { light: baseLight, radius: 66, energy: 0.9375, atmosphere: { lightGrade: gainGradeB }, ref: makeRef(baseLight, 66, 0.9375, gainGradeB) },
        );

        // 7. Attention boolean consistency (non-true string on non-attention role must not poison true attention)
        const attLightFalse = { ...baseLight, id: 'att-str', role: 'point', attention: 'needsYou', height: 4, normal: null };
        const attLightTrue = { ...baseLight, id: 'att-role', role: 'attention', attention: 'needsYou', height: 4, normal: null };
        checkOrderInvariantPair(
            'attention key consistency',
            { light: attLightFalse, radius: 40, energy: 0.6, atmosphere: baseAtm, ref: makeRef(attLightFalse, 40, 0.6, nightGrade) },
            { light: attLightTrue, radius: 40, energy: 0.6, atmosphere: baseAtm, ref: makeRef(attLightTrue, 40, 0.6, nightGrade) },
        );
    });
});

test('lamp stamp cache enforces pixel and entry bounds and prevents single-frame scan thrashing', () => {
    withMockDocument(({ getCreatedCount }) => {
        const renderer = makeRenderer(1);
        const nightGrade = evaluateGrade({ minuteOfDay: 22.78 * 60, weather: { type: 'clear', intensity: 0, cloudCover: 0.08 }, moonFill: 0.5 });
        const atmosphere = { lightGrade: nightGrade };

        // 1. Entry cap (<= 240) and pixel cap (<= maxLightCachePixels) hold under standalone churn.
        const seenCanvases = [];
        for (let i = 0; i < 280; i++) {
            const light = { id: `tiny:${i}`, color: `rgb(255, ${100 + (i % 150)}, ${10 + Math.floor(i / 2)})`, role: 'fixture', height: 0 };
            const stamp = renderer._getLightGlowStamp(light, 10, 1, atmosphere);
            seenCanvases.push(stamp);
            assert.ok(renderer.lightGradientCache.size <= 240, `size ${renderer.lightGradientCache.size} <= 240`);
            assert.ok(
                canvasMapPixelCount(renderer.lightGradientCache) <= CANVAS_BUDGET.maxLightCachePixels,
                `pixels ${canvasMapPixelCount(renderer.lightGradientCache)} <= ${CANVAS_BUDGET.maxLightCachePixels}`,
            );
        }
        // Evicted canvases have their backing stores released (0x0).
        assert.equal(seenCanvases[0].width, 0);
        assert.equal(seenCanvases[0].height, 0);

        // 2. Oversized stamp (> maxLightCachePixels / 5) is returned usable and not cached.
        const sizeBeforeBig = renderer.lightGradientCache.size;
        const big = renderer._getLightGlowStamp({ id: 'giant', color: '#ffc95e', role: 'fixture', height: 0 }, 300, 1, atmosphere);
        assert.ok(big.width * big.height > Math.floor(CANVAS_BUDGET.maxLightCachePixels / 5));
        assert.equal(renderer.lightGradientCache.size, sizeBeforeBig);

        // 3. Anti-thrashing: 30 unique large stamps (~52k px each => ~1.56M px > 1.25M px cap)
        //    plus a trailing multi-use lamp (used 6x per frame).
        renderer.lightGradientCache.clear();
        const uniqueLights = Array.from({ length: 30 }, (_, i) => ({
            id: `aperture:${i}`,
            color: `rgb(255, ${140 + i * 3}, ${60 + i})`,
            role: 'fixture',
            height: 0,
        }));
        const hotLamp = { id: 'carried', color: '#ffc95e', role: 'fixture', height: 0 };

        // Frame 1: fill up to budget (~24 stamps), overflow single-use stamps don't thrash,
        // and hotLamp gets promoted on its 2nd hit by reclaiming a single-use stamp.
        renderer._lightStampFrame = 1;
        renderer._frameUncachedPoolKeys?.clear?.();
        for (const light of uniqueLights) renderer._getLightGlowStamp(light, 114, 1, atmosphere);
        for (let k = 0; k < 6; k++) renderer._getLightGlowStamp(hotLamp, 57, 1, atmosphere);
        assert.ok(canvasMapPixelCount(renderer.lightGradientCache) <= CANVAS_BUDGET.maxLightCachePixels);

        // Frame 2: repeating the exact same frame must hit the cached majority + all 6 hotLamp calls
        // instead of 0% hit-rate LRU thrashing (would have been 36 builds under plain LRU).
        const buildsBeforeFrame2 = getCreatedCount();
        renderer._lightStampFrame++;
        renderer._frameUncachedPoolKeys?.clear?.();
        const hotFirst = renderer._getLightGlowStamp(hotLamp, 57, 1, atmosphere);
        for (const light of uniqueLights) renderer._getLightGlowStamp(light, 114, 1, atmosphere);
        for (let k = 0; k < 5; k++) {
            assert.strictEqual(renderer._getLightGlowStamp(hotLamp, 57, 1, atmosphere), hotFirst);
        }
        const buildsInFrame2 = getCreatedCount() - buildsBeforeFrame2;
        assert.ok(buildsInFrame2 <= 8, `expected <= 8 overflow rebuilds in Frame 2 (anti-thrashing), got ${buildsInFrame2}`);
        assert.ok(canvasMapPixelCount(renderer.lightGradientCache) <= CANVAS_BUDGET.maxLightCachePixels);

        // Frame 3: switching grade evicts stale Frame 2 entries immediately.
        const duskAtm = { lightGrade: evaluateGrade({ minuteOfDay: 19.75 * 60, weather: { type: 'clear', intensity: 0, cloudCover: 0.08 }, moonFill: 0.5 }) };
        renderer._lightStampFrame++;
        renderer._frameUncachedPoolKeys?.clear?.();
        const duskStamp = renderer._getLightGlowStamp(hotLamp, 114, 1, duskAtm);
        assert.ok(renderer.lightGradientCache.size > 0);
        assert.ok(canvasMapPixelCount(renderer.lightGradientCache) <= CANVAS_BUDGET.maxLightCachePixels);
        assert.strictEqual(renderer._getLightGlowStamp(hotLamp, 114, 1, duskAtm), duskStamp);

        // Frame 4: switching zoom (including 1 -> 0.5 where cell stays 1) also
        // makes prior-frame entries immediately evictable and stays within budget.
        renderer.camera.zoom = 0.5;
        renderer._lightStampFrame++;
        renderer._frameUncachedPoolKeys?.clear?.();
        const surveyStamp = renderer._getLightGlowStamp(hotLamp, 57, 1, duskAtm);
        assert.strictEqual(renderer._getLightGlowStamp(hotLamp, 57, 1, duskAtm), surveyStamp);
        assert.ok(canvasMapPixelCount(renderer.lightGradientCache) <= CANVAS_BUDGET.maxLightCachePixels);

        // Wet-reflection entries in the shared lightGradientCache use a distinct
        // key namespace and release cleanly when evicted.
        const wetCanvas = { width: 40, height: 30 };
        renderer.lightGradientCache.set('#ffc95e|40x30|w2', wetCanvas);
        const poolKey = lightStampCacheKey({ rgb: [255, 201, 94], radius: 40, cell: 1, energy: 1 });
        assert.notEqual(poolKey, '#ffc95e|40x30|w2');
    });
});

test('_beginPoolLayer advances the pool frame clock and resets per-frame uncached tracking', () => {
    const original = globalThis.document;
    const makeLayerCanvas = () => {
        const ctx = {
            canvas: null,
            globalCompositeOperation: 'source-over',
            imageSmoothingEnabled: true,
            fillStyle: '',
            setTransform() {},
            getTransform() { return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }; },
            fillRect() {},
            clearRect() {},
        };
        const canvas = { width: 0, height: 0, getContext: () => ctx };
        ctx.canvas = canvas;
        return canvas;
    };
    globalThis.document = { createElement: makeLayerCanvas };
    try {
        const renderer = makeRenderer(1);
        renderer._frameUncachedPoolKeys = new Set(['stale-key']);
        renderer._poolFrameGrade = { marker: true };
        const mainCtx = { getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }) };
        const viewport = { width: 320, height: 180 };

        renderer._beginPoolLayer(mainCtx, viewport);
        assert.equal(renderer._lightStampFrame, 1);
        assert.equal(renderer._frameUncachedPoolKeys.size, 0);
        assert.equal(renderer._poolFrameGrade, null);

        renderer._frameUncachedPoolKeys.add('frame-1-miss');
        renderer._beginPoolLayer(mainCtx, viewport);
        assert.equal(renderer._lightStampFrame, 2);
        assert.equal(renderer._frameUncachedPoolKeys.size, 0);
    } finally {
        globalThis.document = original;
    }
});
