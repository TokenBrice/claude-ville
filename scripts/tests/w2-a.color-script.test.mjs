import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { ART_RAMPS, GROUND_RAMP_KEYS, RECEIVER_LUMA_CEILING } from '../../claudeville/src/config/artPalette.js';
import { THEME } from '../../claudeville/src/config/theme.js';
import { solarStateForDate } from '../../claudeville/src/presentation/character-mode/AtmosphereState.js';
import { applySeaFresnel, applyWaterSky, buildCanvasOverlayStamp, seaFresnelCourse } from '../../claudeville/src/presentation/character-mode/CanvasGrade.js';
import { seaBandBend, waterMoodFor, waterSurfaceRgb, waterSunBandFor } from '../../claudeville/src/presentation/character-mode/CoastBake.js';
import {
    AFTERGLOW, GRADE_KEYFRAMES, SEA_FRESNEL_Y, afterglowWeight, applyGradeToRgb, applyGradeToRgbFaced,
    capSaturation, evaluateGrade, gradeKeyMinute, lampSettlingWindows, waterMaxSaturation,
} from '../../claudeville/src/presentation/character-mode/GradeEvaluator.js';
import { arrangementKeyframeAt } from '../../claudeville/src/presentation/shared/audio/DayArc.js';
import { resolveDiurnalFrame } from '../../claudeville/src/presentation/character-mode/gpu/GpuFrameState.js';
import { GPU_RECORD_FLAGS, normalizeGpuRecord } from '../../claudeville/src/presentation/character-mode/gpu/GpuWorldPolicy.js';
import { createUniformViews, FRAME_UNIFORM_LAYOUT, writeFrameUniforms } from '../../claudeville/src/presentation/character-mode/gpu/wgsl/common.js';
import { rgbToOklab } from '../visual/compare.mjs';

const rgb = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255);
const luma = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
const gradeAt = minuteOfDay => evaluateGrade({ minuteOfDay });

// SHA-256 over all original fields, generated from the evaluator at tag v0.67.1.
const nightHashes = {
    "1320-clear": "0ddb18729506ebaa521c81927c1bb238742a55de7e25999d1d000b8285d4859d",
    "1320-rain": "37feab56a51529619d9777b0aaf66ad63faeb411b285efbbee6c5418d7c32a9c",
    "1320-storm": "ddac4374c731c9e82cf7d742ae1feaa1a51b728df266d86f0539f8b6cf5ada6e",
    "1320-snow": "c3291594609e0dfc493b8ae6dd6b4c05bbef4f8f06baa08d8c0ee3857a8ce9ee",
    "1320-fog": "7b3651bfd5e8f871930ffca15cf9b8f4e638911db6390c2a159e6ee7cf075652",
    "1320-overcast": "4368d7cc42fa28b08b1fd1acd6b609377f9dee243bcf1fe6f9fff5ec26f63011",
    "120-clear": "9311a702923704dbac7fc4775de0307b13de48e51d1366c4a3d01e272fc0aa92",
    "120-rain": "5db61939a5ff022c4bcf2fa4d0918dafd2f60c36ccfa111b67521297dcdac84e",
    "120-storm": "9c04d4f850409d6d17971b22f43f050e07174002b2cabfdae0c0c81471f8f512",
    "120-snow": "b2a9d76499e705c9d3d4ae40849e96588ed01bc014acb5540fdd786f0b720307",
    "120-fog": "2dc2bb59a51424eee9fa1cba5fd4c4a64d8a9875f74de941eb2d40c3e21ce8fb",
    "120-overcast": "367c18ffb29f22651a44b07596a87bc474729e20ea750b9e54343ac69173a73b"
};

test('all legacy night fields match v0.67.1 across weather rows', () => {
    for (const [label, expected] of Object.entries(nightHashes)) {
        const [minute, kind] = label.split('-');
        const weather = { type: kind === 'snow' ? 'rain' : kind, intensity: 0.84, cloudCover: kind === 'clear' ? 0.08 : 0.94 };
        const { cacheKey, faceMix, faceKey, faceShade, rimStrength, afterglow, alpenglow, windowGlint,
            seaFar, seaFresnelGate, ...legacy } = evaluateGrade({
            minuteOfDay: Number(minute), weather, snowfall: kind === 'snow' ? 1 : 0, moonFill: 0.37,
        });
        assert.equal(createHash('sha256').update(JSON.stringify(legacy)).digest('hex'), expected, label);
        assert.deepEqual([faceMix, rimStrength, afterglow, windowGlint, seaFresnelGate], [0, 0, 0, 0, 0]);
    }
});

test('Paris winter and summer sunset windows preserve the band and admit the lamplighter', () => {
    for (const [month, date, offset] of [[10, 26, 60], [6, 2, 120]]) {
        const { shift } = solarStateForDate(new Date(2026, month, date, 12), {
            lat: 48.86, lon: 2.35, offsetMinutes: () => offset,
        });
        const golden = gradeKeyMinute('golden-hour', shift);
        const sunset = golden + AFTERGLOW.startAfterGolden;
        const dusk = lampSettlingWindows(shift).duskStart;
        assert.ok(dusk >= sunset && dusk <= sunset + 20);
        assert.equal(arrangementKeyframeAt({ minuteOfDay: sunset + 10, shift }), 'golden-hour');
        assert.equal(afterglowWeight(sunset, shift), 0);
        assert.equal(afterglowWeight(sunset + 10, shift), 1);
        assert.equal(afterglowWeight(sunset + 20, shift), 0);
        const at = minuteOfDay => evaluateGrade({ minuteOfDay, ...shift });
        assert.equal(at(golden - 45).windowGlint, 0);
        assert.equal(at(golden).windowGlint, 1);
        assert.equal(at(dusk).windowGlint, 0);
        for (let m = golden - 45; m < dusk + 20; m += 0.25) {
            const grade = at(m);
            assert.ok(Number.isInteger(grade.afterglow * 16));
            assert.ok(Number.isInteger(grade.windowGlint * 8));
        }
    }
    assert.equal(afterglowWeight(1110, { sunsetShift: -80 }), 0, 'short twilight respects the blue guard');
});

test('each golden and afterglow face stays within its saturation and reference luma limits', () => {
    for (const grade of [gradeAt(1080), gradeAt(1110)]) {
        for (const ramp of [...GROUND_RAMP_KEYS, 'ashlar', 'timber', 'roofSlate']) {
            for (const hex of ART_RAMPS[ramp]) {
                const albedo = rgb(hex);
                const ref = applyGradeToRgb(albedo, grade);
                assert.deepEqual(applyGradeToRgbFaced(albedo, grade, 9), ref);
                for (const k of grade.faceKey) {
                    const c = applyGradeToRgbFaced(albedo, grade, k);
                    const [r, g, b] = c;
                    const warm = r >= g && g >= b && g - b >= 0.25 * (r - b) && r > b && luma(c) > 0.5;
                    assert.ok(1 - Math.min(...c) / Math.max(...c) <= (warm ? 0.50 : 0.56) + 1e-12);
                    assert.ok(luma(c) <= Math.min(RECEIVER_LUMA_CEILING, luma(ref) * 1.12) + 1e-12);
                }
            }
        }
    }
    assert.equal(gradeAt(1110).rimStrength, 0);
    assert.ok(Math.abs(gradeAt(1080).rimStrength - 0.85) < 1e-12);
    const grade = gradeAt(1080);
    const stone = rgb(ART_RAMPS.ashlar[5]);
    assert.ok(applyGradeToRgbFaced(stone, grade, grade.faceKey[1])[0] > applyGradeToRgbFaced(stone, grade, grade.faceKey[2])[0]);
});

test('clear island noon, low sun, blue hour and deep night retain their value ordering', () => {
    const shares = { grass: 30, dirt: 8, road: 6, plaza: 6, sand: 4, foliage: 12,
        stone: 10, timber: 5, slate: 6, deepWater: 8, shallowWater: 5 };
    const mean = minute => {
        const grade = gradeAt(minute);
        return Object.entries(shares).reduce((sum, [ramp, share]) => sum + share * 2.55
            * ART_RAMPS[ramp].reduce((y, hex) => y + luma(applyGradeToRgb(rgb(hex), grade)), 0) / ART_RAMPS[ramp].length, 0);
    };
    const blue = mean(1185), noon = mean(750), night = mean(1320);
    for (const lowSun of [mean(360), mean(1080)]) assert.ok(noon > lowSun && lowSun > blue + 10);
    assert.ok(blue > night && night > mean(120));
});

test('far sea keeps its distance from status colours, near and deep-night water keep the flat sky', () => {
    const lab = channels => rgbToOklab(...channels.map(v => Math.round(v * 255)));
    const status = ['working', 'idle', 'waiting', 'error', 'rateLimited', 'waitingOnUser'].map(id => lab(rgb(THEME[id])));
    for (const minute of [...GRADE_KEYFRAMES.map(key => key.minute), 1110]) {
        const grade = gradeAt(minute);
        const atmosphere = { lightGrade: grade };
        const mood = waterMoodFor(atmosphere);
        const bed = applyGradeToRgb(waterSurfaceRgb(rgb(ART_RAMPS.deepWater[2]), mood, waterSunBandFor(atmosphere)), grade);
        const far = applySeaFresnel(bed, mood, grade, 0);
        const flat = capSaturation(applyWaterSky(bed, mood), waterMaxSaturation(mood));
        assert.deepEqual(applySeaFresnel(bed, mood, grade, 3), flat);
        if (grade.seaFresnelGate === 0) assert.deepEqual(far, flat);
        const swatch = lab(far);
        for (const other of status) assert.ok(Math.hypot(...swatch.map((v, i) => v - other[i])) >= 0.15, String(minute));
        if (minute === 1110) {
            const [r, g, b] = far.map(v => Math.round(v * 255));
            assert.ok(r >= b && b > g, `afterglow far water in the 300–360° band: ${[r, g, b]}`);
        }
    }
});

test('Fresnel seams wrap at 1280 world pixels and use the three authored bend bands', () => {
    for (const [i, y] of SEA_FRESNEL_Y.entries()) {
        let min = Infinity;
        let max = -Infinity;
        let previous;
        let straight = 0;
        for (let x = 0; x < 2560; x++) {
            const boundary = y + seaBandBend(x, i + 4);
            assert.equal(seaFresnelCourse(x, boundary - 3, seaBandBend), i);
            assert.equal(seaFresnelCourse(x, boundary + 3, seaBandBend), i + 1);
            assert.equal(seaFresnelCourse(x - 1280, y, seaBandBend), seaFresnelCourse(x, y, seaBandBend));
            straight = boundary === previous ? straight + 1 : 1;
            assert.ok(straight <= 200, `straight horizon at band ${i}, world x ${x}`);
            previous = boundary;
            min = Math.min(min, boundary);
            max = Math.max(max, boundary);
        }
        assert.ok(max - min > 5);
    }
});

test('both record halves and all four diurnal vectors fit the published ABI', () => {
    const state = resolveDiurnalFrame({}, gradeAt(1080));
    const views = createUniformViews(896);
    writeFrameUniforms(views, state);
    assert.equal(FRAME_UNIFORM_LAYOUT.size, 896);
    for (const [i, name] of ['skyFar', 'skyNear', 'faceKey', 'faceExtra'].entries()) {
        const offset = 832 + i * 16;
        assert.equal(FRAME_UNIFORM_LAYOUT.byName[name].offset, offset);
        assert.deepEqual(views.f32.slice(offset / 4, offset / 4 + 4), Float32Array.from(state[name]));
    }
    assert.equal(GPU_RECORD_FLAGS.faceGrade, 1 << 15);
    assert.equal(GPU_RECORD_FLAGS.goldenRim, 1 << 16);
    const record = normalizeGpuRecord({ surfaceCode: true, faceGrade: true, goldenRim: true, alpenglowRow: 102 });
    assert.equal(record.flags, 16 | 32768 | 65536);
    assert.equal(record.meta, 102);
    assert.equal(normalizeGpuRecord({ recolorIndex: true, variant: 7, alpenglowRow: 102 }).meta, 7);
    const feed = { atmosphere: { clock: { minuteOfDay: 361 }, solar: { sunriseShift: 1 } }, flash: [0, 0, 0.07] };
    assert.equal(resolveDiurnalFrame(feed).dawnShare, 1);
    assert.equal(resolveDiurnalFrame(feed).crestFlash, 1);
    assert.equal(resolveDiurnalFrame({ ...feed, reducedMotion: true }).crestFlash, 0);
    assert.equal(resolveDiurnalFrame({ ...feed, flash: [0, 0, 0.054] }).crestFlash, 0);
});

test('Canvas stamps select only top rows, one-pixel edges and unlit west panes', () => {
    const width = 5, height = 4;
    const albedo = Uint8Array.from({ length: width * height * 4 }, (_, i) => i % 4 === 3 ? 255 : 95);
    const geometry = albedo.slice();
    for (let i = 0; i < width * height; i++) geometry[i * 4 + 2] = i % width === 2 ? 128 : 64;
    const unlitEmitter = new Uint8Array(width * height);
    unlitEmitter[6] = 255;
    const sprite = { width, height, albedo, geometry, unlitEmitter, alpenglowRow: 2 };
    const stamp = buildCanvasOverlayStamp({ ...sprite, unlitEmitter: null }, gradeAt(1110));
    assert.equal(stamp.height, 2);
    assert.equal(stamp.data[3], 255);
    assert.equal(stamp.data[2 * 4 + 3], 0);
    const golden = buildCanvasOverlayStamp(sprite, gradeAt(1080));
    const painted = i => golden.data[i * 4 + 3] > 0;
    assert.ok(painted(5) && painted(6));
    assert.ok(!painted(7) && !painted(8) && !painted(11));
    assert.equal(buildCanvasOverlayStamp(sprite, gradeAt(1320)), null);
});
