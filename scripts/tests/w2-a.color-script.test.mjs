import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { ART_RAMPS, GROUND_RAMP_KEYS, RECEIVER_LUMA_CEILING } from '../../claudeville/src/config/artPalette.js';
import { THEME } from '../../claudeville/src/config/theme.js';
import { solarStateForDate } from '../../claudeville/src/presentation/character-mode/AtmosphereState.js';
import { applySeaFresnel, applyWaterSky, buildCanvasOverlayStamp, canvasFrameGradeRgb, canvasWaterPreimage, seaFresnelCourse } from '../../claudeville/src/presentation/character-mode/CanvasGrade.js';
import { drawCanvasWaterState } from '../../claudeville/src/presentation/character-mode/CanvasWaterState.js';
import { drawCanvasGradeOverlays } from '../../claudeville/src/presentation/character-mode/EmitterCuts.js';
import { GroundCueRecorder, SWATCH_X } from '../../claudeville/src/presentation/character-mode/GroundCueRecords.js';
import { DEW_GLINT_COLOR } from '../../claudeville/src/presentation/character-mode/SeasonalAmbience.js';
import { COAST_FIELD_FLAGS, OCEAN_HORIZON_WORLD_Y, OPEN_SEA_DEEPEST, OPEN_SEA_STOPS, SEA_TROUGH,
    canvasSeaMarkRgb, drawCanvasWaterMood, drawOuterOcean, openSeaDepthAt, openSeaStopAt, seaBandBend,
    seaFresnelCourseAt, waterMoodFor, waterSurfaceRgb, waterSunBandFor } from '../../claudeville/src/presentation/character-mode/CoastBake.js';
import {
    AFTERGLOW, GRADE_KEYFRAMES, SEA_FRESNEL_Y, afterglowWeight, applyGradeToRgb, applyGradeToRgbFaced,
    capSaturation, evaluateGrade, gradeKeyMinute, lampSettlingWindows, waterMaxSaturation,
} from '../../claudeville/src/presentation/character-mode/GradeEvaluator.js';
import { arrangementKeyframeAt } from '../../claudeville/src/presentation/shared/audio/DayArc.js';
import { buildGpuWorldRecords } from '../../claudeville/src/presentation/character-mode/gpu/GpuSceneBuilder.js';
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
        const sunrise = gradeKeyMinute('sunrise', shift);
        assert.equal(resolveDiurnalFrame({ atmosphere: { solar: shift, clock: { minuteOfDay: sunrise } } }).dawnShare, 1);
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
    const views = createUniformViews(FRAME_UNIFORM_LAYOUT.size);
    writeFrameUniforms(views, state);
    assert.equal(FRAME_UNIFORM_LAYOUT.size, 960);
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

function installPixelCanvas(t) {
    const { document, ImageData } = globalThis;
    t.after(() => Object.assign(globalThis, { document, ImageData }));
    globalThis.ImageData = class {
        constructor(data, width, height) {
            this.data = typeof data === 'number' ? new Uint8ClampedArray(data * width * 4) : data;
            this.width = typeof data === 'number' ? data : width;
            this.height = typeof data === 'number' ? width : height;
        }
    };
    const canvas = (width = 0, height = 0) => {
        const c = { width, height, data: new Uint8ClampedArray(width * height * 4) };
        const ctx = {
            canvas: c, save() {}, restore() {}, clearRect() {}, setTransform() {},
            createImageData: (w, h) => new globalThis.ImageData(w, h), createPattern: () => null,
            getTransform: () => ({ a: 1, b: 0, d: 1, e: 0, f: 0 }),
            drawImage(source) { c.data = source.data; },
            getImageData: () => ({ data: c.data }),
            putImageData(image) { c.data = image.data.slice(); },
            fillRect(x, y) {
                if (x !== SWATCH_X || y !== 0) return;
                if (!c.data.length) c.data = new Uint8ClampedArray(c.width * c.height * 4);
                c.data.set([...this.fillStyle.slice(1).match(/../g).map(v => parseInt(v, 16)), 255], x * 4);
            },
        };
        c.getContext = () => ctx;
        return c;
    };
    globalThis.document = { createElement: () => canvas() };
    return canvas;
}

test('dawn dew paints the exact 8-bit cue-atlas swatch', t => {
    installPixelCanvas(t);
    const recorder = new GroundCueRecorder().begin();
    recorder.fillStyle = DEW_GLINT_COLOR;
    recorder.fillRect(4, 6, 1, 1);
    const atlas = recorder.end()[0].source;
    assert.deepEqual([...atlas.data.slice(SWATCH_X * 4, SWATCH_X * 4 + 4)], [0xd8, 0xd1, 0xbb, 0xff]);
});

test('occupied cropped room glass glints only on unlit, emissive west panes', t => {
    const canvas = installPixelCanvas(t);
    const width = 8, height = 5, left = 2, top = 3;
    const albedo = canvas(width, height), occluder = canvas(width, height), emissive = canvas(width, height);
    const first = width * top + left;
    for (let i = 0; i < width * height; i++) {
        albedo.data.set([64, 73, 86, 255], i * 4);
        occluder.data.set([85, 0, i === first + 2 ? 128 : 64, 255], i * 4);
    }
    for (let p = first; p < first + 3; p++) emissive.data[p * 4 + 3] = 255;
    const map = { left, top, w: 4, h: 1, rooms: 2, group: [1, 2, 0, 0], spriteWidth: width, emissive: emissive.data };
    const material = canvas(4, 1);
    map.materialPixels = new ImageData(Uint8ClampedArray.from([1, 0, 0, 255, 3, 0, 0, 255, 5, 0, 0, 255, 7, 0, 0, 255]), 4, 1);
    const glass = { canvas: canvas(4, 1), left, top, w: 4, h: 1, revision: 1,
        key: 'same painted step', channels: { material, occluder: canvas(4, 1) } };
    const entry = { id: 'building.test', surfaceCode: true, emissiveSidecar: true };
    let firstGate = 0.01;
    const renderer = {
        assets: { assetVersion: 1, get: id => id === entry.id ? albedo : null, getEntry: () => entry, getAnchor: () => [0, 0],
            getCompanion: (_, kind) => ({ emissive, occluder })[kind] },
        camera: { applyTransform() {} },
        buildingRenderer: { enumerateDrawables: () => [{ entry, building: { type: 'test' }, wx: 0, wy: 0 }],
            glassPatchFor: () => glass, roomGlass: { map: () => map },
            roomGlassGate: (_, room) => room === 0 ? firstGate : 0, _emissiveGateFor: () => 1 },
    };
    const grade = { ...gradeAt(1080), rimStrength: 0 };
    const target = canvas(width, height);
    const check = (...eligible) => {
        drawCanvasGradeOverlays(target.getContext(), renderer, { lightGrade: grade });
        const mask = new Uint8Array(width * height);
        for (const p of eligible) mask[p] = 255;
        const expected = buildCanvasOverlayStamp({ width, height, albedo: albedo.data,
            geometry: occluder.data, unlitEmitter: mask }, grade);
        assert.deepEqual(target.data, expected.data);
        assert.equal(target.data[(first + 1) * 4 + 3], 255);
    };
    const gpuGlass = glint => {
        renderer.buildingRenderer.atmosphereState = { lightGrade: { windowGlint: glint } };
        const records = buildGpuWorldRecords(renderer, { drawables: [
            { ...renderer.buildingRenderer.enumerateDrawables()[0], kind: 'building' },
        ] });
        const record = records.find(r => r.id.endsWith(':glass'));
        assert.equal(record.materialSource, material);
        assert.equal(record.occluderSource, glass.channels.occluder);
        assert.equal(record.emissiveSource, null);
        return record;
    };
    const flat = gpuGlass(0);
    const active = gpuGlass(1);
    assert.equal(active.sidecarKey, flat.sidecarKey);
    assert.equal(active.sidecarRevision, flat.sidecarRevision);
    assert.deepEqual([...material.data], [1, 0, 0, 255, 3, 0, 255, 255, 5, 0, 255, 255, 7, 0, 0, 255]);
    check(first + 1);
    firstGate = 0;
    assert.notEqual(gpuGlass(1).materialRevision, active.materialRevision);
    assert.equal(material.data[2], 255);
    check(first, first + 1);
    // Same image identity, new asset version. Re-read its changed face bytes.
    occluder.data[first * 4 + 2] = 128;
    renderer.assets.assetVersion++;
    check(first + 1);
});

test('Canvas coast, tiled ocean and water marks agree across every Fresnel boundary', t => {
    const canvas = installPixelCanvas(t);
    const atmosphere = { lightGrade: gradeAt(1110) };
    const target = canvas(20, 800).getContext();
    const renderer = {};
    drawOuterOcean(target, renderer, atmosphere);
    const { strip, stripRows } = renderer._outerOcean;
    assert.ok(stripRows >= SEA_FRESNEL_Y[2] + 16 - OCEAN_HORIZON_WORLD_Y);
    // Independent expression from waterBayer2 / waterBayer4 in both shaders.
    function bayer2(x, y) {
        const v = Math.floor(x) * 0.5 + Math.floor(y) ** 2 * 0.75;
        return v - Math.floor(v);
    }
    for (const [i, boundary] of SEA_FRESNEL_Y.entries()) {
        for (let x = 0; x < 1280; x++) {
            const bend = seaBandBend(x, i + 4);
            for (let dy = -16; dy <= 16; dy++) {
                const y = boundary + dy;
                const order = bayer2(x / 2, y / 2) * 0.25 + bayer2(x, y);
                const course = (dy - bend + 2) / 4 <= order ? i : i + 1;
                assert.equal(seaFresnelCourseAt(x - 1280, y), course);
                if (y >= OCEAN_HORIZON_WORLD_Y + stripRows) continue;
                const stop = openSeaStopAt(openSeaDepthAt(x, y), order);
                const offset = ((y - OCEAN_HORIZON_WORLD_Y) * strip.width + x) * 4;
                const [r, g, b] = strip.data.subarray(offset, offset + 3);
                assert.equal(canvasSeaMarkRgb(renderer, stop, x - 1280, y, false), r * 65536 + g * 256 + b);
            }
        }
    }
    const terrain = canvas(2, 800);
    const stop = OPEN_SEA_STOPS[OPEN_SEA_DEEPEST];
    for (let p = 0; p < terrain.data.length; p += 4) terrain.data.set([...stop, 255], p);
    Object.assign(renderer, { terrainCache: terrain, terrainCacheKey: 'sea', terrainCacheBounds: { x: 0, y: 0 },
        _coastBake: { coast: { x: 0, y: 0, cols: 1, rows: 400, classes: new Uint8Array(400).fill(3 + OPEN_SEA_DEEPEST) },
            waterFields: { coastField: new Uint8Array(800).fill(COAST_FIELD_FLAGS.sea) } } });
    drawCanvasWaterMood(target, renderer, atmosphere);
    for (let y = 0; y < 800; y++) {
        const [r, g, b] = renderer._coastMoodLayer.canvas.data.subarray(y * 8, y * 8 + 3);
        // Below the horizon reflection band only the graded bed contributes.
        if (y >= 80) assert.equal(canvasSeaMarkRgb(renderer, OPEN_SEA_DEEPEST, 0, y, true), r * 65536 + g * 256 + b);
    }

    // A swell chunk between the old flat-strip cutoff and the last Fresnel seam.
    const overlay = canvas(64, 64).getContext();
    overlay.getTransform = () => ({ a: 1, d: 1, e: -2400, f: -450 });
    renderer.motionScale = 0;
    Object.assign(renderer._coastBake.waterFields, { x: 0, y: 0, cols: 1, rows: 400, cycleOffset: new Uint8Array(400) });
    drawCanvasWaterState(overlay, renderer, atmosphere);
    let painted = 0;
    for (const [id, chunk] of renderer._canvasWater.caps) {
        if (!chunk.bodyCanvas) continue;
        const { width, height, data } = chunk.bodyCanvas;
        const x0 = (Math.floor(id / 65536) - 32768) * width;
        const y0 = ((id % 65536) - 32768) * height;
        for (const i of chunk.body) {
            const x = x0 + i % width, y = y0 + Math.floor(i / width);
            if (y < 400 || y > 600) continue;
            const [r, g, b] = data.subarray(i * 4, i * 4 + 3);
            assert.equal(r * 65536 + g * 256 + b, canvasSeaMarkRgb(renderer, chunk.info[i] & 7, x, y, false));
            painted++;
        }
    }
    assert.ok(painted > 0);
});

test('all seven peak Afterglow sea beds land at 316–323 degrees', () => {
    const { shift } = solarStateForDate(new Date(2026, 6, 15, 12));
    const weather = { type: 'clear', cloudCover: 0.08 };
    const grade = evaluateGrade({ minuteOfDay: gradeKeyMinute('golden-hour', shift) + 30, weather, ...shift });
    const mood = waterMoodFor({ lightGrade: grade, weather });
    assert.equal(grade.afterglow, 1);
    const hue = ([r, g, b]) => 360 + 60 * (g - b) / (r - g);
    for (const stop of [...OPEN_SEA_STOPS, SEA_TROUGH]) {
        const bed = waterSurfaceRgb(stop.map(v => v / 255), mood);
        const far = applySeaFresnel(applyGradeToRgb(bed, grade), mood, grade, 0);
        assert.ok(far[0] > far[2] && far[2] > far[1]);
        assert.ok(hue(far) >= 316 && hue(far) <= 323);
        for (const postFx of [false, true]) {
            const pre = canvasWaterPreimage(bed, grade, { sky: mood, course: 0, postFx });
            const painted = canvasFrameGradeRgb(pre.map(v => Math.round(v * 255) / 255), grade, { postFx });
            assert.deepEqual(painted.map(v => Math.round(v * 255)), far.map(v => Math.round(v * 255)));
        }
    }
});
