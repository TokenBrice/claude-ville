import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { RECEIVER_LUMA_CEILING } from '../../claudeville/src/config/artPalette.js';
import { evaluateGrade, applyGradeToRgb, gradeKeyMinute } from '../../claudeville/src/presentation/character-mode/GradeEvaluator.js';
import { COAST_FIELD_FLAGS } from '../../claudeville/src/presentation/character-mode/CoastBake.js';
import {
    GROUND_WEATHER_COLS,
    GROUND_WEATHER_ROWS,
    GROUND_WEATHER_X0,
    GROUND_WEATHER_Y0,
    extractPuddleSites,
    packGroundWeather,
    validGroundWeather,
} from '../../claudeville/src/presentation/character-mode/GroundWeatherField.js';
import { SkyRenderer } from '../../claudeville/src/presentation/character-mode/SkyRenderer.js';
import {
    FOG_WATER_DENSITY_BOOST,
    PUDDLE_RING_FRAMES,
    PUDDLE_RING_FRAME_MS,
    PUDDLE_RING_RATE_PER_10,
    WeatherRenderer,
    fogBankDensityAt,
    fogWaterDeltaTexels,
    fogCourseAtWorld,
    isCoastWaterAt,
    lightningSheenFor,
    puddleRingColor,
    stormStrikeAt,
} from '../../claudeville/src/presentation/character-mode/WeatherRenderer.js';

import { BENCH_WEATHER } from '../smoke/support/world-bench.mjs';
import {
    AUTHORED_DAY_SHIFT,
    CAPTURE_TIMEZONE,
    DEFAULT_SNOW_CAPTURE_DATE,
    captureInstant,
    definitiveBackendFailure,
    describeFenceState,
    evaluateCaptureFenceState,
    parseArgs as parseCaptureArgs,
    resolveCaptureDate,
    resolveCaptureWeather,
    snowBucketOf as captureSnowBucketOf,
} from '../visual/capture.mjs';
import { snowBucketOf } from '../../claudeville/src/presentation/character-mode/GroundState.js';
import { bloomPolicyFailures, livenessAgreement } from '../smoke/v3-environment-truth.mjs';

const readSource = name => readFileSync(
    new URL(`../../claudeville/src/presentation/character-mode/${name}`, import.meta.url),
    'utf8',
);

const luma = ([r, g, b]) => r * 0.2126 + g * 0.7152 + b * 0.0722;

function parseRgbCss(css) {
    const match = /^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/.exec(css);
    assert.ok(match, `expected rgb(...) string, got ${css}`);
    return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function createMockDocument() {
    const created = [];
    const doc = {
        createElement(tag) {
            assert.equal(tag, 'canvas');
            const fillRects = [];
            let imageData = null;
            const canvas = {
                width: 0,
                height: 0,
                fillRects,
                get imageData() { return imageData; },
                getContext() {
                    let fillStyle = '#000000';
                    let globalAlpha = 1;
                    return {
                        imageSmoothingEnabled: true,
                        get fillStyle() { return fillStyle; },
                        set fillStyle(v) { fillStyle = v; },
                        get globalAlpha() { return globalAlpha; },
                        set globalAlpha(v) { globalAlpha = v; },
                        createImageData(w, h) {
                            return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
                        },
                        putImageData(img) {
                            imageData = img;
                        },
                        fillRect(x, y, w, h) {
                            fillRects.push({ x, y, w, h, fillStyle, globalAlpha });
                        },
                        drawImage() {},
                        clearRect() {},
                        setTransform() {},
                    };
                },
            };
            created.push(canvas);
            return canvas;
        },
    };
    return { doc, created };
}

function createRecordingCtx() {
    const ops = {
        drawImages: [],
        rects: [],
        fillRects: [],
        fills: [],
        forbiddenCalls: [],
    };
    let currentRects = [];
    const state = { globalAlpha: 1, globalCompositeOperation: 'source-over', fillStyle: '', imageSmoothingEnabled: true };
    const stack = [];
    const ctx = {
        ops,
        save() { stack.push({ ...state }); },
        restore() { Object.assign(state, stack.pop() || {}); },
        get globalAlpha() { return state.globalAlpha; },
        set globalAlpha(v) { state.globalAlpha = v; },
        get globalCompositeOperation() { return state.globalCompositeOperation; },
        set globalCompositeOperation(v) { state.globalCompositeOperation = v; },
        get fillStyle() { return state.fillStyle; },
        set fillStyle(v) { state.fillStyle = v; },
        get imageSmoothingEnabled() { return state.imageSmoothingEnabled; },
        set imageSmoothingEnabled(v) { state.imageSmoothingEnabled = v; },
        beginPath() { currentRects = []; },
        rect(x, y, w, h) {
            const r = { x, y, w, h };
            currentRects.push(r);
            ops.rects.push(r);
        },
        clip() {},
        fill() {
            ops.fills.push({
                rects: currentRects.slice(),
                globalAlpha: state.globalAlpha,
                fillStyle: state.fillStyle,
                globalCompositeOperation: state.globalCompositeOperation,
            });
        },
        fillRect(x, y, w, h) {
            ops.fillRects.push({
                x, y, w, h,
                fillStyle: state.fillStyle,
                globalAlpha: state.globalAlpha,
            });
        },
        drawImage(img, x, y, w, h) {
            ops.drawImages.push({
                img, x, y, w, h,
                globalAlpha: state.globalAlpha,
                globalCompositeOperation: state.globalCompositeOperation,
                imageSmoothingEnabled: state.imageSmoothingEnabled,
            });
        },
        createPattern() { return { setTransform() {} }; },
        createLinearGradient() { ops.forbiddenCalls.push('createLinearGradient'); throw new Error('forbidden'); },
        createRadialGradient() { ops.forbiddenCalls.push('createRadialGradient'); throw new Error('forbidden'); },
        arc() { ops.forbiddenCalls.push('arc'); throw new Error('forbidden'); },
        ellipse() { ops.forbiddenCalls.push('ellipse'); throw new Error('forbidden'); },
        scale() { ops.forbiddenCalls.push('scale'); throw new Error('forbidden'); },
    };
    return ctx;
}

test('W2-B §4.14 grammar gate: zero smooth gradients/arcs/ellipses in SkyRenderer & WeatherRenderer and no full-height curtain fillRect', () => {
    const sky = readSource('SkyRenderer.js');
    const weather = readSource('WeatherRenderer.js');
    assert.equal(/createLinearGradient|createRadialGradient/.test(sky), false, 'SkyRenderer has zero smooth gradients');
    assert.equal(/createLinearGradient|createRadialGradient/.test(weather), false, 'WeatherRenderer has zero smooth gradients');
    assert.equal(/\.arc\(|\.ellipse\(/.test(sky), false, 'SkyRenderer has zero arc/ellipse calls');
    assert.equal(/\.arc\(|\.ellipse\(/.test(weather), false, 'WeatherRenderer has zero arc/ellipse calls');
    const curtainBlock = weather.slice(weather.indexOf('_drawRainCurtains('), weather.indexOf('_drawRainSplashes('));
    assert.equal(/fillRect\([^)]*canvas\.height/.test(curtainBlock), false, '_drawRainCurtains has zero full-height fillRect');
});

test('W2-B §4.12 _drawGodrays: cached 4-px cell stamp with 3 exact Bayer courses, screen blend, and cache release', (t) => {
    const prevDoc = globalThis.document;
    const { doc } = createMockDocument();
    globalThis.document = doc;
    t.after(() => {
        if (prevDoc === undefined) delete globalThis.document;
        else globalThis.document = prevDoc;
    });

    const sky = new SkyRenderer();
    const ctx = createRecordingCtx();
    const canvas = { width: 320, height: 200 };
    const atmosphere = {
        sky: { sun: { visible: true, xFrac: 0.5, yFrac: 0.15, alpha: 0.9 } },
        lighting: { sunWarmth: 0.75 },
        weather: { cloudCover: 0.1 },
    };

    sky._drawGodrays(ctx, null, canvas, atmosphere, { alphaMul: 1 });
    assert.equal(ctx.ops.forbiddenCalls.length, 0);
    assert.equal(ctx.ops.drawImages.length, 1);

    const draw = ctx.ops.drawImages[0];
    assert.equal(draw.globalCompositeOperation, 'screen');
    assert.equal(draw.imageSmoothingEnabled, false);
    assert.equal(draw.img.width, Math.ceil(canvas.width / 4));
    assert.equal(draw.img.height, Math.ceil(canvas.height / 4));
    assert.equal(draw.w, draw.img.width * 4);
    assert.equal(draw.h, draw.img.height * 4);
    assert.ok(Math.abs(draw.globalAlpha - 0.10 * 0.75 * 0.9) < 1e-6);

    const allowed = new Set([
        `255,198,124,${Math.round(0.35 * 255)}`,
        `255,206,138,${Math.round(0.65 * 255)}`,
        '255,226,168,255',
    ]);
    const seen = new Set();
    const data = draw.img.imageData.data;
    for (let i = 0; i < data.length; i += 4) {
        if (data[i + 3] === 0) continue;
        const tuple = `${data[i]},${data[i + 1]},${data[i + 2]},${data[i + 3]}`;
        assert.ok(allowed.has(tuple), `unexpected godray course pixel ${tuple}`);
        seen.add(tuple);
    }
    assert.equal(seen.size, 3, 'all 3 stepped godray courses are present');

    // Moving sun within 1 px (< 4-px cell boundary) reuses the cached stamp.
    const firstStamp = draw.img;
    sky._drawGodrays(ctx, null, canvas, {
        ...atmosphere,
        sky: { sun: { ...atmosphere.sky.sun, xFrac: (160 + 1) / canvas.width } },
    }, { alphaMul: 1 });
    assert.equal(ctx.ops.drawImages[1].img, firstStamp, 'cache hit inside 4-px cell');

    // Moving sun >= 4 px rebuilds and releases the previous backing store.
    sky._drawGodrays(ctx, null, canvas, {
        ...atmosphere,
        sky: { sun: { ...atmosphere.sky.sun, xFrac: (160 + 8) / canvas.width } },
    }, { alphaMul: 1 });
    assert.notEqual(ctx.ops.drawImages[2].img, firstStamp, 'rebuilt after >= 4-px move');
    assert.equal(firstStamp.width, 0, 'previous godray stamp backing store released');

    const activeStamp = ctx.ops.drawImages[2].img;
    sky.releaseCache();
    assert.equal(activeStamp.width, 0, 'releaseCache releases godray stamp');
});

test('W2-B §4.12 _drawCodeMoon: integer 2-px pixel disc with maria, limb, Bayer terminator, new moon, and squashY', (t) => {
    const prevDoc = globalThis.document;
    const { doc } = createMockDocument();
    globalThis.document = doc;
    t.after(() => {
        if (prevDoc === undefined) delete globalThis.document;
        else globalThis.document = prevDoc;
    });

    const sky = new SkyRenderer();
    const canvas = { width: 1280, height: 720 };

    // 1) Full moon: disc #cfe4ff, upper-left limb #e4efff, maria #a9bcd6, zero terminator shadow.
    const fullCtx = createRecordingCtx();
    sky._drawCodeMoon(fullCtx, canvas, {
        xFrac: 0.5, yFrac: 0.2, alpha: 1, squashY: 1,
        phase: { phaseName: 'full', illumination: 1, waxing: true },
    });
    assert.equal(fullCtx.ops.forbiddenCalls.length, 0);
    const fullStamp = fullCtx.ops.drawImages.at(-1).img;
    const fullStampHeight = fullStamp.height;
    assert.ok(fullStamp.fillRects.every(r => r.w === 2 && r.h === 2), 'all cells are square 2×2 blocks');
    const fullColors = new Set(fullStamp.fillRects.map(r => r.fillStyle));
    assert.ok(fullColors.has('#cfe4ff'), 'disc color');
    assert.ok(fullColors.has('#e4efff'), 'upper-left limb color');
    assert.ok(fullColors.has('#a9bcd6'), 'maria color');
    assert.equal(fullColors.has('rgba(20, 36, 58, 0.82)'), false, 'full moon has no dark terminator');

    // 2) Waxing vs waning crescent: shadows sit on opposite halves and mirror cleanly.
    const waxCtx = createRecordingCtx();
    sky._drawCodeMoon(waxCtx, canvas, {
        xFrac: 0.5, yFrac: 0.2, alpha: 1, squashY: 1,
        phase: { phaseName: 'crescent', illumination: 0.25, waxing: true },
    });
    const waxStamp = waxCtx.ops.drawImages.at(-1).img;
    const waxShadows = waxStamp.fillRects.filter(r => r.fillStyle === 'rgba(20, 36, 58, 0.82)');
    assert.ok(waxShadows.length > 20, 'crescent carries terminator shadow cells');
    const waxMeanX = waxShadows.reduce((s, r) => s + r.x, 0) / waxShadows.length;
    assert.ok(waxMeanX < waxStamp.width / 2, 'waxing crescent shadows the left half');

    const wanCtx = createRecordingCtx();
    sky._drawCodeMoon(wanCtx, canvas, {
        xFrac: 0.5, yFrac: 0.2, alpha: 1, squashY: 1,
        phase: { phaseName: 'crescent', illumination: 0.25, waxing: false },
    });
    const wanStamp = wanCtx.ops.drawImages.at(-1).img;
    const wanShadows = wanStamp.fillRects.filter(r => r.fillStyle === 'rgba(20, 36, 58, 0.82)');
    const wanMeanX = wanShadows.reduce((s, r) => s + r.x, 0) / wanShadows.length;
    assert.ok(wanMeanX > wanStamp.width / 2, 'waning crescent shadows the right half');

    // 3) New moon: #14243a α 0.76 + 1-cell #bed8ff α 0.36 rim.
    const newCtx = createRecordingCtx();
    sky._drawCodeMoon(newCtx, canvas, {
        xFrac: 0.5, yFrac: 0.2, alpha: 1, squashY: 1,
        phase: { phaseName: 'new', illumination: 0, waxing: false },
    });
    const newStamp = newCtx.ops.drawImages.at(-1).img;
    const newDisc = newStamp.fillRects.filter(r => r.fillStyle === 'rgba(20, 36, 58, 0.76)');
    const newLimb = newStamp.fillRects.filter(r => r.fillStyle === 'rgba(190, 216, 255, 0.36)');
    assert.ok(newDisc.length > newLimb.length && newLimb.length > 20, 'new moon has dark disc + 1-cell limb');

    // W2-Fix-B — `illumination` is the lit fraction itself: the terminator
    // ellipse x = (2·illum − 1)·chord leaves exactly illum of the disc lit
    // (the old −cos(π·illum) cosined it twice: 0.25 drew 14.6 %).
    const shadowStyle = 'rgba(20, 36, 58, 0.82)';
    const litFraction = (illumination, waxing) => {
        const ctx = createRecordingCtx();
        sky._drawCodeMoon(ctx, canvas, {
            xFrac: 0.5, yFrac: 0.2, alpha: 1, squashY: 1,
            phase: { phaseName: illumination >= 0.5 ? 'gibbous' : 'crescent', illumination, waxing },
        });
        const stamp = ctx.ops.drawImages.at(-1).img;
        const cells = new Map();
        for (const r of stamp.fillRects) {
            const k = `${r.x},${r.y}`;
            const cell = cells.get(k) || { shadow: false };
            if (r.fillStyle === shadowStyle) cell.shadow = true;
            cells.set(k, cell);
        }
        let shadow = 0;
        for (const cell of cells.values()) if (cell.shadow) shadow++;
        return 1 - shadow / cells.size;
    };
    for (const illumination of [0.25, 0.5, 0.75]) {
        for (const waxing of [true, false]) {
            const lit = litFraction(illumination, waxing);
            t.diagnostic(`code moon illum ${illumination} ${waxing ? 'waxing' : 'waning'}: ${(lit * 100).toFixed(1)} % lit`);
            assert.ok(Math.abs(lit - illumination) <= 0.03, `illumination ${illumination}: lit ${lit.toFixed(3)}`);
        }
    }
    assert.ok(litFraction(0.25, true) < litFraction(0.5, true) && litFraction(0.5, true) < litFraction(0.75, true), 'lit share grows with illumination');

    // 4) squashY applies to cell rows while cells remain square 2×2 blocks.
    const squashedCtx = createRecordingCtx();
    sky._drawCodeMoon(squashedCtx, canvas, {
        xFrac: 0.5, yFrac: 0.2, alpha: 1, squashY: 0.75,
        phase: { phaseName: 'full', illumination: 1, waxing: true },
    });
    const squashedStamp = squashedCtx.ops.drawImages.at(-1).img;
    assert.equal(fullStamp.height, 0, 'previous code moon stamp backing store was released on rebuild');
    assert.ok(squashedStamp.height < fullStampHeight, 'squashY compresses stamp height');
    assert.ok(squashedStamp.fillRects.every(r => r.w === 2 && r.h === 2), 'cells stay square under squashY');

    sky.releaseCache();
    assert.equal(squashedStamp.width, 0, 'releaseCache clears code moon stamp');
});

test('W2-B §4.12 _drawRainCurtains: wind-sheared Bayer parallelogram sheets with ragged top and misty 6-cell bottom', () => {
    const renderer = new WeatherRenderer();
    renderer.setSceneContext({ camera: { zoom: 2 } });
    const ctx = createRecordingCtx();
    const canvas = { width: 320, height: 120 };
    const cell = 2; // round(zoom)

    renderer._drawRainCurtains(ctx, canvas, {
        intensity: 0.92,
        windX: 1.0,
        lean: 1.0,
        phaseMs: 1200,
        seed: 77,
    });

    assert.equal(ctx.ops.fillRects.length, 0, 'no full-height fillRect calls');
    assert.equal(ctx.ops.fills.length, 6, '3 sheets × 2 flat courses at intensity 0.92');

    // Every emitted rect is strictly 1 art-pixel cell tall.
    assert.ok(ctx.ops.rects.length > 100);
    assert.ok(ctx.ops.rects.every(r => r.h === cell), 'every curtain strip has height === cell');

    // Verify wind shear on the first outer course: mid-sheet x shifts right as y increases.
    const firstCourse = ctx.ops.fills[0].rects;
    const rowBounds = new Map();
    for (const r of firstCourse) {
        const b = rowBounds.get(r.y) || { minX: Infinity, maxX: -Infinity, covered: 0 };
        b.minX = Math.min(b.minX, r.x);
        b.maxX = Math.max(b.maxX, r.x + r.w);
        b.covered += r.w;
        rowBounds.set(r.y, b);
    }
    const yTop = 10 * cell;
    const yBot = 30 * cell;
    const bTop = rowBounds.get(yTop);
    const bBot = rowBounds.get(yBot);
    assert.ok(bTop && bBot, 'sampled interior rows exist');
    assert.ok(bBot.minX > bTop.minX || bBot.maxX > bTop.maxX, 'positive wind shears sheet rightward down screen');

    // Ragged cloud base (row 0 has gaps relative to solid interior row 10).
    const topCovered = (rowBounds.get(0)?.covered || 0);
    assert.ok(topCovered < bTop.covered, `ragged cloud base row 0 (${topCovered}) < interior (${bTop.covered})`);

    // Bottom 6 rows apply 50% Bayer dither (~half the solid interior width).
    const lastRowY = (Math.ceil(canvas.height / cell) - 1) * cell;
    const bottomCovered = rowBounds.get(lastRowY)?.covered || 0;
    const midCovered = rowBounds.get(lastRowY - 8 * cell)?.covered || 0;
    assert.ok(midCovered > 0 && bottomCovered < midCovered * 0.7, `bottom misty row (${bottomCovered}) ~50% of interior (${midCovered})`);
});

test('W2-B §4.11 & §4.10 time-tinted fog preserves v0.67.1 night exact, tints day/dawn/golden at legacy luma, and adds dawn crest', (t) => {
    const prevDoc = globalThis.document;
    const { doc } = createMockDocument();
    globalThis.document = doc;
    t.after(() => {
        if (prevDoc === undefined) delete globalThis.document;
        else globalThis.document = prevDoc;
    });

    const FOG_WASH_RGB = [208, 222, 219];
    const renderer = new WeatherRenderer();

    // 1) Night (22:00 & 02:00): byte-identical to v0.67.1 legacy graded fog.
    for (const hour of [22, 2]) {
        const grade = evaluateGrade({ minuteOfDay: hour * 60, weather: { type: 'fog', intensity: 0.7, fog: 0.8 }, moonFill: 0.4 });
        assert.equal(grade.night, 1);
        renderer._lightGrade = { ...grade, cacheKey: `night-${hour}` };
        const colors = renderer._gradedWashColors();
        const legacy = applyGradeToRgb(FOG_WASH_RGB.map(c => c / 255), grade).map(c => Math.round(Math.max(0, Math.min(1, c)) * 255));
        assert.deepEqual(colors.fog, legacy, `night ${hour}:00 fog is byte-identical to v0.67.1`);
    }

    // 2) Dawn (06:00) & Golden (18:00): warmer R-B shift from skyHorizon/horizonHaze while preserving legacy luma.
    for (const [label, minute] of [['dawn', 6 * 60], ['golden', 18 * 60]]) {
        const grade = evaluateGrade({ minuteOfDay: minute, weather: { type: 'fog', intensity: 0.5, fog: 0.5 } });
        renderer._lightGrade = { ...grade, cacheKey: `${label}-${minute}` };
        const colors = renderer._gradedWashColors();
        const legacy = applyGradeToRgb(FOG_WASH_RGB.map(c => c / 255), grade);
        const fogLuma = luma(colors.fog.map(c => c / 255));
        assert.ok(Math.abs(fogLuma - luma(legacy)) <= 0.015, `${label} preserves legacy luma (${fogLuma.toFixed(3)} vs ${luma(legacy).toFixed(3)})`);
        assert.ok(colors.fog[0] > colors.fog[2], `${label} fog is warm-tinted (R=${colors.fog[0]} > B=${colors.fog[2]})`);
    }

    // 3) Dawn mist crest (§4.10): top course of groundFogLayer tints toward skyHorizon at sunrise, untouched at noon.
    // W2-Fix-B: the crest keys on the grade's own sunrise key (the day's
    // shifted 06:00), the minute GpuFrameState's u_dawnShare reads.
    const dawnGrade = evaluateGrade({ minuteOfDay: 6 * 60, weather: { type: 'fog', intensity: 0.7, fog: 0.7 } });
    const dawnLayer = renderer.groundFogLayer({
        atmosphere: {
            weather: { type: 'fog', intensity: 0.7, fog: 0.7 },
            clock: { minuteOfDay: 6 * 60 },
            solar: { sunriseMinute: 6 * 60 },
            lightGrade: dawnGrade,
        },
        viewport: { width: 1280, height: 720 },
    });
    assert.ok(dawnLayer && dawnLayer.dawnCrestRgb[0] > dawnLayer.dawnCrestRgb[2], 'dawn fog top course takes warm rose-gold crest');

    const noonLayer = renderer.groundFogLayer({
        atmosphere: {
            weather: { type: 'fog', intensity: 0.7, fog: 0.7 },
            clock: { minuteOfDay: 12 * 60 + 30 },
            solar: { sunriseMinute: 6 * 60 },
            lightGrade: evaluateGrade({ minuteOfDay: 12 * 60 + 30 }),
        },
        viewport: { width: 1280, height: 720 },
    });
    assert.deepEqual(noonLayer.dawnCrestRgb, [224, 231, 229], 'noon keeps neutral FOG_COLOR');
});

test('W2-B §4.11 fog by height: ×1.35 density over coast water flag, capped by FOG_BUCKETS, safe ×1.0 fallback', (t) => {
    const prevDoc = globalThis.document;
    const { doc } = createMockDocument();
    globalThis.document = doc;
    t.after(() => {
        if (prevDoc === undefined) delete globalThis.document;
        else globalThis.document = prevDoc;
    });

    assert.equal(FOG_WATER_DENSITY_BOOST, 1.35);
    assert.equal(fogBankDensityAt(0.5, false), 0.5);
    assert.equal(fogBankDensityAt(0.5, true), 5 / 8, '0.5 × 1.35 = 0.675 → 5/8 bucket');
    assert.equal(fogBankDensityAt(1.0, true), 1.0, 'capped by FOG_BUCKETS');
    assert.equal(fogBankDensityAt(0, true), 0);

    // Build a tiny 4×4 coastField: (1, 1) = water, (2, 1) = covered water, (0, 0) = land.
    const coastField = new Uint8Array(4 * 4 * 2);
    coastField[(1 * 4 + 1) * 2 + 1] = COAST_FIELD_FLAGS.water;
    coastField[(1 * 4 + 2) * 2 + 1] = COAST_FIELD_FLAGS.water | COAST_FIELD_FLAGS.covered;
    const waterFields = { x: 0, y: 0, cols: 4, rows: 4, coastField };

    assert.equal(isCoastWaterAt(null, 2, 2), false, 'safe fallback when coast field unbound');
    assert.equal(isCoastWaterAt(waterFields, 0.5, 0.5), false, 'land cell');
    assert.equal(isCoastWaterAt(waterFields, 2.5, 2.5), true, 'open canal/lagoon water cell');
    assert.equal(isCoastWaterAt(waterFields, 4.5, 2.5), false, 'covered bridge/dock cell counts as land');

    // Over water, fogCourseAtWorld is always >= land course for identical noise coordinates.
    let waterStrictlyHigher = 0;
    for (let dx = 0; dx < 200; dx += 4) {
        const landCourse = fogCourseAtWorld(2.5, 2.5, { strength: 0.5, driftX: dx, driftY: 0, waterFields: null });
        const waterCourse = fogCourseAtWorld(2.5, 2.5, { strength: 0.5, driftX: dx, driftY: 0, waterFields });
        assert.ok(waterCourse >= landCourse);
        if (waterCourse > landCourse) waterStrictlyHigher++;
    }
    assert.ok(waterStrictlyHigher > 0, 'water boost elevates fog course density');

    // groundFogLayer safely falls back to ×1.0 when unbound, and exposes boosted waterCanvas when bound.
    const renderer = new WeatherRenderer();
    const atm = { weather: { type: 'fog', intensity: 0.5, fog: 0.5 } };
    const unbound = renderer.groundFogLayer({ atmosphere: atm, viewport: { width: 1280, height: 720 } });
    assert.equal(unbound.waterStrength, unbound.landStrength, 'unbound coast falls back to ×1.0');
    assert.equal(unbound.waterCanvas, null, 'unbound: no water tile');

    const bound = renderer.groundFogLayer({ atmosphere: atm, viewport: { width: 1280, height: 720 }, waterFields });
    assert.ok(bound.waterStrength > bound.landStrength, 'bound coast boosts waterStrength');
    assert.notEqual(bound.waterCanvas, bound.canvas, 'waterCanvas baked at boosted bucket');
});

test('W2-Fix-B §4.11: the ×1.35 water banks are drawn as a delta over the banks, zero-cost unbound', (t) => {
    const prevDoc = globalThis.document;
    const { doc } = createMockDocument();
    globalThis.document = doc;
    t.after(() => {
        if (prevDoc === undefined) delete globalThis.document;
        else globalThis.document = prevDoc;
    });
    const coastField = new Uint8Array(4 * 4 * 2);
    coastField[(1 * 4 + 1) * 2 + 1] = COAST_FIELD_FLAGS.water;
    const waterFields = { x: 0, y: 0, cols: 4, rows: 4, coastField };
    const renderer = new WeatherRenderer();
    const atm = { weather: { type: 'fog', intensity: 0.5, fog: 0.5 } };

    // Unbound: no water tiles at all (the ground pass draws today's banks).
    const unbound = renderer.groundFogLayer({ atmosphere: atm, viewport: { width: 1280, height: 720 } });
    assert.equal(unbound.waterCanvas, null, 'unbound: no water tile');
    assert.equal(unbound.waterDeltaCanvas, null, 'unbound: no delta tile');
    assert.equal(unbound.waterKey, '');

    // Bound: the delta tile and its revision key.
    const bound = renderer.groundFogLayer({ atmosphere: atm, viewport: { width: 1280, height: 720 }, waterFields });
    assert.ok(bound.waterDeltaCanvas, 'bound: delta tile baked');
    assert.notEqual(bound.waterDeltaCanvas, bound.canvas);
    assert.match(bound.waterKey, /^ground-fog-\d+.*>ground-fog-\d+/);
    const again = renderer.groundFogLayer({ atmosphere: atm, viewport: { width: 1280, height: 720 }, waterFields });
    assert.equal(again.waterDeltaCanvas, bound.waterDeltaCanvas, 'delta tile cached per key');

    // Pure: delta over the land texel composites (source-over) to the water texel.
    const land = bound.landStrength;
    const water = bound.waterStrength;
    const size = bound.canvas.width * bound.canvas.height * 4;
    const delta = fogWaterDeltaTexels(new Uint8ClampedArray(size), land, water, [224, 231, 229]);
    const landTile = bound.canvas.imageData.data;
    const waterTile = bound.waterCanvas.imageData.data;
    let covered = 0;
    let maxAlphaErr = 0;
    let maxColourErr = 0;
    for (let o = 0; o < size; o += 4) {
        const al = landTile[o + 3] / 255;
        const ad = delta[o + 3] / 255;
        const aw = waterTile[o + 3] / 255;
        assert.ok(aw >= al, 'the boosted tile covers every land texel');
        const a = ad + (1 - ad) * al;
        maxAlphaErr = Math.max(maxAlphaErr, Math.abs(a - aw));
        if (aw > 0) {
            covered++;
            for (let k = 0; k < 3; k++) {
                const c = (ad * delta[o + k] + (1 - ad) * al * landTile[o + k]) / Math.max(1e-6, a);
                maxColourErr = Math.max(maxColourErr, Math.abs(c - waterTile[o + k]));
            }
        }
    }
    assert.ok(covered > 0);
    assert.ok(maxAlphaErr <= 1 / 255 + 1e-9, `delta-over-banks alpha matches the water banks (max err ${maxAlphaErr})`);
    assert.ok(maxColourErr <= 2, `delta-over-banks colour matches the water banks (max err ${maxColourErr})`);

    // Both ground passes lay the delta over water only.
    const frame = readSource('WorldFrameRenderer.js');
    assert.match(frame, /const delta = layer\.waterDeltaCanvas \|\| null;\n\s+if \(\(!cutLand && !delta\) \|\| !fields\?\.coastField/, 'Canvas: the delta needs the coast field');
    assert.match(frame, /fctx\.drawImage\(seaFretLandMask\(fields\), fields\.x, fields\.y, fields\.cols \* 2, fields\.rows \* 2\);\n\s+fctx\.globalCompositeOperation = 'destination-over';/, 'Canvas: delta cut off the land, banks laid under');
    assert.match(frame, /if \(layer\.waterDeltaCanvas && renderer\.gpuWorld\?\.waterFieldsActive === true\)/, 'GPU: delta records only with the coast field bound');
    assert.match(frame, /water\.landShare = 0;/, 'GPU: delta records at land share 0 (seaFret keeps water only)');
    assert.match(frame, /id: 'ground:fog-water', textureKey: 'ground-fog-water-tile'/);
});

test('W2-Fix-B §4.10: the dawn mist crest keys on the grade sunrise key (shifted 06:00), not the raw solar sunrise', (t) => {
    const prevDoc = globalThis.document;
    const { doc } = createMockDocument();
    globalThis.document = doc;
    t.after(() => {
        if (prevDoc === undefined) delete globalThis.document;
        else globalThis.document = prevDoc;
    });
    const renderer = new WeatherRenderer();
    const solar = { sunriseMinute: 7 * 60 + 40, sunriseShift: -40 };
    const key = gradeKeyMinute('sunrise', solar);
    assert.equal(key, 6 * 60 - 40);
    const layerAt = minute => renderer.groundFogLayer({
        atmosphere: {
            weather: { type: 'fog', intensity: 0.7, fog: 0.7 },
            clock: { minuteOfDay: minute },
            solar,
            lightGrade: evaluateGrade({ minuteOfDay: minute, sunriseShift: -40 }),
        },
        viewport: { width: 1280, height: 720 },
    });
    const atKey = layerAt(key);
    assert.ok(atKey.dawnCrestRgb[0] > atKey.dawnCrestRgb[2], 'crest at the grade sunrise key');
    const atRawSunrise = layerAt(solar.sunriseMinute);
    assert.deepEqual(atRawSunrise.dawnCrestRgb, [224, 231, 229], 'no crest 100 min after the key, at the raw solar sunrise');
    const source = readSource('WeatherRenderer.js');
    assert.match(source, /const sunrise = gradeKeyMinute\('sunrise', atmosphere\?\.solar \|\| undefined\);/);
    assert.match(readSource('gpu/GpuFrameState.js'), /const sunrise = gradeKeyMinute\('sunrise', feed\.atmosphere\?\.solar \|\| undefined\);/);
});

test('W2-B §4.11 lightningSheen: 1 during 83 ms peak with motion on, 0 otherwise / reduced motion, read-only getter', () => {
    const storm = {
        weather: { type: 'storm', intensity: 0.9, precipitation: 0.9, fog: 0.2, cloudCover: 1, seed: 11 },
        motion: { particleEnabled: true },
        lightGrade: evaluateGrade({ minuteOfDay: 22 * 60 }),
    };

    // Locate an exact peak (step 0) and decay (step 1) timestamp on the storm schedule.
    let peakMs = -1;
    let decayMs = -1;
    for (let t = 0; t < 200_000; t += 17) {
        const s = stormStrikeAt(t, storm, 1);
        if (s.active && s.step === 0 && peakMs < 0) peakMs = t;
        if (s.active && s.step === 1 && decayMs < 0) decayMs = t;
        if (peakMs >= 0 && decayMs >= 0) break;
    }
    assert.ok(peakMs >= 0 && decayMs >= 0, 'found storm peak and decay steps');

    const peakStrike = { ...stormStrikeAt(peakMs, storm, 1) };
    const decayStrike = { ...stormStrikeAt(decayMs, storm, 1) };
    assert.equal(peakStrike.sheen, 1);
    assert.equal(decayStrike.sheen, 0);
    assert.equal(lightningSheenFor(peakStrike, 1), 1);
    assert.equal(lightningSheenFor(peakStrike, 0), 0, 'reduced motion disables sheen');
    assert.equal(lightningSheenFor(decayStrike, 1), 0, 'only the 83 ms peak sets sheen');

    const renderer = new WeatherRenderer();
    assert.equal(renderer.lightningSheen, 0);
    assert.throws(() => { renderer.lightningSheen = 1; }, TypeError, 'lightningSheen is read-only');

    const ctx = createRecordingCtx();
    const canvas = { width: 320, height: 200 };
    renderer.drawForeground(ctx, { canvas, atmosphere: storm, dt: 16, timeMs: peakMs, strike: peakStrike });
    assert.equal(renderer.lightningSheen, 1, '1 during 83 ms flash peak');

    renderer.drawForeground(ctx, { canvas, atmosphere: storm, dt: 16, timeMs: decayMs, strike: decayStrike });
    assert.equal(renderer.lightningSheen, 0, '0 after 83 ms peak');

    renderer.drawForeground(ctx, {
        canvas,
        atmosphere: { ...storm, motion: { particleEnabled: false } },
        dt: 16,
        timeMs: peakMs,
        strike: peakStrike,
    });
    assert.equal(renderer.lightningSheen, 0, '0 under reduced motion');

    renderer.drawForeground(ctx, { canvas, atmosphere: storm, dt: 16, timeMs: peakMs, strike: peakStrike });
    assert.equal(renderer.lightningSheen, 1);
    renderer.dispose();
    assert.equal(renderer.lightningSheen, 0, 'reset on dispose');
});

test('W2-B §4.12 GroundWeatherField.extractPuddleSites & 2-frame concentric rain puddle rings', () => {
    // 1) Binary contract unchanged + extractPuddleSites on RGBA8 and R8 sources.
    const cols = GROUND_WEATHER_COLS;
    const rows = GROUND_WEATHER_ROWS;
    const total = cols * rows;
    const surfaces = new Uint8Array(total).fill(255);
    const stops = new Uint8Array(total);
    const shelter = new Float32Array(total);
    const order = new Float32Array(total);
    const puddleMask = new Uint8Array(total);

    // Paint two separate puddles into puddleMask: one at (col 100, row 200) peak 200,
    // and one at (col 140, row 220) peak 150.
    const paintBlob = (cc, rc, peak) => {
        for (let dr = -1; dr <= 1; dr++) {
            for (let dc = -1; dc <= 1; dc++) {
                const idx = (rc + dr) * cols + (cc + dc);
                surfaces[idx] = 4;
                puddleMask[idx] = dr === 0 && dc === 0 ? peak : Math.floor(peak * 0.7);
            }
        }
    };
    paintBlob(100, 200, 200);
    paintBlob(140, 220, 150);

    const field = packGroundWeather({ cols, rows, surfaces, stops, shelter, order, puddleMask });
    assert.equal(validGroundWeather(field), true, '1280×1280 RGBA8 contract intact');

    const sitesRgba = extractPuddleSites(field);
    assert.equal(sitesRgba.length, 2, 'two distinct puddle blobs extracted');
    assert.equal(extractPuddleSites(field), sitesRgba, 'cached per backing buffer');
    assert.deepEqual(
        sitesRgba.map(s => [s.x, s.y, s.maxByte, s.area]),
        [
            [GROUND_WEATHER_X0 + 100.5 * 2, GROUND_WEATHER_Y0 + 200.5, 200, 9],
            [GROUND_WEATHER_X0 + 140.5 * 2, GROUND_WEATHER_Y0 + 220.5, 150, 9],
        ],
    );

    const sitesR8 = extractPuddleSites({ data: puddleMask, cols, rows, x0: GROUND_WEATHER_X0, y0: GROUND_WEATHER_Y0, texelW: 2 });
    assert.deepEqual(sitesR8, sitesRgba, 'R8 puddleMask extraction matches RGBA8 field');

    // 2) Frame geometry: Frame A = 3×1 (3 px), Frame B = 5×3 ellipse outline (exact 8 px), 120 ms each.
    assert.equal(PUDDLE_RING_FRAME_MS, 120);
    assert.equal(PUDDLE_RING_RATE_PER_10, 1.5);
    assert.equal(PUDDLE_RING_FRAMES.length, 2);
    const countPx = frame => frame.join('').split('').filter(c => c === '#').length;
    assert.equal(countPx(PUDDLE_RING_FRAMES[0]), 3, 'Frame A is 3×1 (3 px)');
    assert.equal(countPx(PUDDLE_RING_FRAMES[1]), 8, 'Frame B is 5×3 hollow ellipse outline (8 px)');
    assert.equal(PUDDLE_RING_FRAMES[1][1][2], '.', 'Frame B centre is hollow');

    // 3) Colour: graded skyHorizon lifted 1 stop, strictly <= RECEIVER_LUMA_CEILING (0.74).
    for (const minute of [6 * 60, 12.5 * 60, 18 * 60, 19.75 * 60, 22 * 60, 2 * 60]) {
        const grade = evaluateGrade({ minuteOfDay: minute });
        const rgb = parseRgbCss(puddleRingColor(grade));
        const y = luma(rgb.map(c => c / 255));
        assert.ok(y <= RECEIVER_LUMA_CEILING + 1e-9, `minute ${minute}: luma ${y.toFixed(4)} <= ${RECEIVER_LUMA_CEILING}`);
    }
    const maxRgb = parseRgbCss(puddleRingColor({ skyHorizon: '#ffffff' }));
    assert.ok(luma(maxRgb.map(c => c / 255)) <= RECEIVER_LUMA_CEILING + 1e-9, 'pure white capped under RECEIVER_LUMA_CEILING');

    // 4) Runtime spawning: rate, <= 1 ring per site, 2 × 120 ms lifecycle, OFF under reduced motion & low precip.
    const sites = Array.from({ length: 10 }, (_, i) => ({ x: 50 + i * 20, y: 100, threshold: 0.2 }));
    const camera = {
        zoom: 2,
        _viewportWidth: () => 400,
        _viewportHeight: () => 300,
        screenToWorld: (x, y) => ({ x, y }),
        worldToScreen: (x, y) => ({ x, y }),
    };
    const renderer = new WeatherRenderer();
    renderer.setSceneContext({ camera, puddleSites: () => sites, puddleLevel: () => 0.8 });
    const grade = evaluateGrade({ minuteOfDay: 12.5 * 60 });
    const rainAtm = {
        weather: { type: 'rain', intensity: 0.8, precipitation: 0.8, cloudCover: 0.9, fog: 0.1, windX: 0.2, seed: 42 },
        clock: { localDate: '2026-06-15' },
        lightGrade: grade,
        motion: { particleEnabled: true },
    };

    // Step 1 second in 50 ms increments: expect ~1.5 * 0.8 * (10/10) = 1.2 spawns, <= 1 per site.
    let sawFrameA = false;
    let sawFrameB = false;
    for (let step = 0; step < 30; step++) {
        const ctx = createRecordingCtx();
        renderer.drawForeground(ctx, { canvas: { width: 400, height: 300 }, atmosphere: rainAtm, dt: 50, gpuRainShare: 1 });
        // At most 1 active ring per site.
        const occupied = new Set(renderer._puddleRings.map(r => r.site));
        assert.equal(occupied.size, renderer._puddleRings.length, 'at most 1 active ring per site');
        if (ctx.ops.fillRects.length === 3) sawFrameA = true;
        if (ctx.ops.fillRects.length === 8) sawFrameB = true;
    }
    assert.ok(sawFrameA, 'observed 3-px Frame A ring');
    assert.ok(sawFrameB, 'observed 8-px Frame B ellipse outline ring');

    // Reduced motion: zero puddle rings drawn and active rings cleared.
    const rmCtx = createRecordingCtx();
    renderer.drawForeground(rmCtx, {
        canvas: { width: 400, height: 300 },
        atmosphere: { ...rainAtm, motion: { particleEnabled: false } },
        dt: 50,
        gpuRainShare: 1,
    });
    assert.equal(renderer._puddleRings.length, 0, 'reduced motion clears puddle rings');
    assert.equal(rmCtx.ops.fillRects.length, 0, 'reduced motion draws zero puddle rings');

    // Low precipitation (<= 0.15): zero puddle rings.
    const dryCtx = createRecordingCtx();
    renderer.drawForeground(dryCtx, {
        canvas: { width: 400, height: 300 },
        atmosphere: { ...rainAtm, weather: { ...rainAtm.weather, precipitation: 0.12 } },
        dt: 80,
        gpuRainShare: 1,
    });
    assert.equal(renderer._puddleRings.length, 0, 'precipitation <= 0.15 spawns zero puddle rings');
});

test('W2-Fix-B §4.12: puddle rings follow the ground history — none on dry ground under the first drops', () => {
    // Production wiring: the renderer's scene context hands the weather
    // overlay the ground history's puddle level.
    const iso = readSource('IsometricRenderer.js');
    assert.match(iso, /puddleLevel: \(\) => this\._groundState\?\.puddles \?\? 0,/);

    const sites = Array.from({ length: 10 }, (_, i) => ({ x: 50 + i * 20, y: 100, threshold: i < 5 ? 0 : 0.4 }));
    const camera = {
        zoom: 2,
        _viewportWidth: () => 400,
        _viewportHeight: () => 300,
        screenToWorld: (x, y) => ({ x, y }),
        worldToScreen: (x, y) => ({ x, y }),
    };
    const rain = {
        weather: { type: 'rain', intensity: 0.8, precipitation: 0.8, cloudCover: 0.9, fog: 0.1, windX: 0.2, seed: 42 },
        clock: { localDate: '2026-06-15' },
        lightGrade: evaluateGrade({ minuteOfDay: 12.5 * 60 }),
        motion: { particleEnabled: true },
    };
    const run = (level, steps = 60) => {
        const renderer = new WeatherRenderer();
        const context = { camera, puddleSites: () => sites };
        if (level !== undefined) context.puddleLevel = () => level;
        renderer.setSceneContext(context);
        let spawned = 0;
        const seen = new Set();
        for (let step = 0; step < steps; step++) {
            renderer.drawForeground(createRecordingCtx(), { canvas: { width: 400, height: 300 }, atmosphere: rain, dt: 50, gpuRainShare: 1 });
            for (const ring of renderer._puddleRings) {
                if (seen.has(ring)) continue;
                seen.add(ring);
                spawned++;
                assert.ok(ring.site.threshold <= (level ?? 0), `ring on a site (threshold ${ring.site.threshold}) the level ${level} has not filled`);
            }
        }
        return spawned;
    };
    // Raining hard on dry ground (no standing water yet): zero rings, even on
    // the deepest (threshold 0) sites; a missing level reads as dry too.
    assert.equal(run(0), 0, 'puddleLevel 0: zero rings while raining');
    assert.equal(run(undefined), 0, 'no puddle level wired: zero rings');
    assert.equal(run(0.0005), 0, 'a level at the resident courses\' epsilon: zero rings');
    // Puddles accumulating: the deep sites first, then every site.
    const shallow = run(0.2);
    const full = run(0.9);
    assert.ok(shallow > 0, `puddles 0.2: rings on the deep sites (${shallow})`);
    assert.ok(full >= shallow, `puddles 0.9: rings on every site (${full} >= ${shallow})`);
});

test('W2-Fix-B harness: bench weather presets, strict capture weather, snow cover, authored solar and backend fail-fast', () => {
    assert.deepEqual(BENCH_WEATHER.overcast, { type: 'overcast', intensity: 0, precipitation: 0, fog: 0.08, cloudCover: 0.96, windX: -0.15 });
    assert.deepEqual(BENCH_WEATHER.fog, { type: 'fog', intensity: 0.85, precipitation: 0, fog: 0.82, cloudCover: 0.72, windX: -0.05 });
    assert.deepEqual(BENCH_WEATHER.snow, { type: 'snow', intensity: 0.78, precipitation: 0.85, fog: 0.14, cloudCover: 0.94, windX: -0.25, snowCover: 0.92 });
    for (const key of ['clear', 'rain', 'storm']) assert.ok(BENCH_WEATHER[key], `${key} kept`);

    // Unknown weather keys throw, at parse time and at resolve time.
    assert.throws(() => resolveCaptureWeather('blizzard'), /Unknown capture weather "blizzard"/);
    assert.throws(() => resolveCaptureWeather(undefined), /Unknown capture weather/);
    assert.throws(() => resolveCaptureWeather('toString'), /Unknown capture weather/, 'no prototype keys');
    assert.throws(() => parseCaptureArgs(['--case=readme-showcase:12:blizzard:1']), /Unknown capture weather/);
    assert.equal(resolveCaptureWeather('fog').profile, BENCH_WEATHER.fog);
    assert.equal(resolveCaptureWeather('clear').knots, null);

    // Snow: winter rain over a pinned frozen-rain timeline; bucket >= 3.
    const snow = resolveCaptureWeather('snow');
    assert.equal(snow.snow, true);
    assert.equal(snow.profile.type, 'rain', 'snow poses as winter precipitation (an atmosphere weather type)');
    assert.equal('snowCover' in snow.profile, false);
    assert.ok(snow.knots.length >= 2 && snow.knots.every(k => k.frozen === true && k.precipitation === 0.85));
    assert.equal(snow.minSnowCover, 0.92);
    assert.ok(snow.minSnowBucket >= 3);
    for (const cover of [0, 0.2, 0.5, 0.74, 0.76, 0.92, 1]) assert.equal(captureSnowBucketOf(cover), snowBucketOf(cover), `bucket of ${cover}`);
    assert.equal(resolveCaptureDate({ weather: snow }), DEFAULT_SNOW_CAPTURE_DATE);
    assert.equal(resolveCaptureDate({ itemDate: '2026-12-20', weather: snow }), '2026-12-20');
    assert.throws(() => resolveCaptureDate({ optionDate: '2026-07-15', weather: snow }), /winter date/);
    assert.equal(resolveCaptureDate({ weather: resolveCaptureWeather('clear') }), '2026-07-15');

    // The fence holds a snow case until the bucket is reached.
    const ready = {
        worldReadyAttr: true, worldStackOpacity: 1, firstFrameReason: null, revealSnapshotPending: false, assetsLoading: false,
        terrainRestaging: false, season: 'winter', terrainKey: 'k', presentGeneration: 9, activeBackend: 'webgpu', snowBucket: 2,
    };
    assert.equal(evaluateCaptureFenceState(ready, { minPresentGeneration: 4 }).ready, true, 'no snow requirement: unchanged');
    const held = evaluateCaptureFenceState(ready, { minPresentGeneration: 4, minSnowBucket: 3 });
    assert.equal(held.ready, false);
    assert.match(held.pendingReasons.join(';'), /snowBucket 2 < 3/);
    assert.equal(evaluateCaptureFenceState({ ...ready, snowBucket: 4 }, { minPresentGeneration: 4, minSnowBucket: 3 }).ready, true);

    // Pinned zone, authored diurnal keys, noon in the village's zone.
    assert.equal(CAPTURE_TIMEZONE, 'Europe/Belgrade');
    assert.deepEqual(AUTHORED_DAY_SHIFT, { sunriseShift: 0, sunsetShift: 0, goldenShift: 0 });
    assert.equal(parseCaptureArgs(['--authored-solar']).authoredSolar, true);
    assert.equal(parseCaptureArgs([]).authoredSolar, false);
    assert.equal(captureInstant('2026-01-15').toISOString(), '2026-01-15T11:00:00.000Z', 'CET noon');
    assert.equal(captureInstant('2026-07-15').toISOString(), '2026-07-15T10:00:00.000Z', 'CEST noon');
    const capture = readFileSync(new URL('../visual/capture.mjs', import.meta.url), 'utf8');
    assert.match(capture, /timezoneId: CAPTURE_TIMEZONE,/);
    assert.match(capture, /atmosphere\.setSolarSite\(\{ zone: authoredSolar\.zone, dayShift: \{ \.\.\.authoredSolar\.dayShift \} \}\);/);
    assert.equal(/BENCH_WEATHER\[item\.weather\] \|\| BENCH_WEATHER\.clear/.test(capture), false, 'no silent clear fallback');
    // Canvas captures yield real frames between settle attempts.
    assert.match(capture, /if \(attempt > 0\) await nextRaf\(\);\n\s+r\.renderNow\?\.\(\);/);

    // A forced WebGPU that reported no adapter / unavailable fails at once.
    assert.equal(definitiveBackendFailure('webgpu', '?renderer=webgpu · webgpu unavailable: no-adapter · webgl2 not probed'),
        '?renderer=webgpu · webgpu unavailable: no-adapter · webgl2 not probed');
    assert.ok(definitiveBackendFailure('webgpu', 'default · webgpu failed to start · webgl2 hardware'));
    assert.equal(definitiveBackendFailure('webgpu', 'default · webgpu ready · webgl2 hardware'), null);
    assert.equal(definitiveBackendFailure('webgpu', 'default · webgpu compiling (switches when ready) · webgl2 hardware'), null);
    assert.equal(definitiveBackendFailure('webgl', '?renderer=webgl · webgpu not requested · webgl2 not probed'), null);
    assert.equal(definitiveBackendFailure('webgpu', null), null);
    const described = describeFenceState({ grade: { key: 'golden-hour>blue-hour', afterglow: 0.6, rimStrength: 0.4 }, worldBackendReason: 'x', snowCover: 1, snowBucket: 4 });
    assert.match(described, /gradeKey=golden-hour>blue-hour afterglow=0\.6 rimStrength=0\.4 worldBackendReason="x" snowCover=1 snowBucket=4/);
});

test('W2-Fix-B v3 truth: presentation liveness agreement and the declared daytime work bloom policy', () => {
    // Liveness: a screenshot that shows the GPU frame agrees; a stale one does not.
    const png = { width: 4, height: 2, data: new Uint8Array(4 * 2 * 4) };
    const put = (x, y, rgb) => png.data.set([...rgb, 255], (y * 4 + x) * 4);
    const samples = [[0, 0, 200, 10, 10], [1, 0, 10, 200, 10], [2, 0, 10, 10, 200], [3, 0, 120, 120, 120], [0, 1, 60, 70, 80]];
    for (const [x, y, ...rgb] of samples) put(x, y, rgb);
    const live = livenessAgreement(png, samples);
    assert.equal(live.agreement, 1);
    assert.equal(live.distinct, 5);
    const stale = { width: 4, height: 2, data: new Uint8Array(4 * 2 * 4) };
    assert.equal(livenessAgreement(stale, samples).agreement, 0, 'a blank screenshot misses the GPU frame');
    assert.equal(livenessAgreement(png, samples, [[0, 0, 2, 1]]).compared, 3, 'DOM chrome excluded');

    const policy = (fields = {}) => ({
        daytimeWorkBloom: false, lightCount: 0, bucket: 'daylight', energyCore: 0.14, energyBloom: 0.5,
        bloomBase: 0.72, hdr: false, workCore: 0.36, workStrength: 0.22, ...fields,
    });
    const base = { bloomPolicy: policy(), frameState: { coreEnergy: 0.14, bloomStrength: 0 } };
    assert.deepEqual(bloomPolicyFailures(base), []);
    // An open work gate by day: the declared constants.
    const work = { bloomPolicy: policy({ daytimeWorkBloom: true }), frameState: { coreEnergy: 0.36, bloomStrength: 0.72 * 0.22 } };
    assert.deepEqual(bloomPolicyFailures(work, base), []);
    // Off-policy values fail, and so does a move without the switch.
    assert.match(bloomPolicyFailures({ ...work, frameState: { coreEnergy: 0.5, bloomStrength: 0.72 * 0.22 } }, base).join(';'), /coreEnergy 0\.5 != declared 0\.36/);
    assert.match(bloomPolicyFailures({ bloomPolicy: policy(), frameState: { coreEnergy: 0.2, bloomStrength: 0 } }, base).join(';'), /moved without the policy switch|!= declared/);
    assert.match(bloomPolicyFailures({ bloomPolicy: policy({ daytimeWorkBloom: true, bucket: 'night' }), frameState: { coreEnergy: 0.36, bloomStrength: 0.72 * 0.22 } }).join(';'), /outside daylight/);
    // HDR halves the strength; no frame state (Canvas, WebGL2) checks nothing.
    assert.deepEqual(bloomPolicyFailures({ bloomPolicy: policy({ daytimeWorkBloom: true, hdr: true }), frameState: { coreEnergy: 0.36, bloomStrength: 0.72 * 0.22 * 0.5 } }), []);
    assert.deepEqual(bloomPolicyFailures({ bloomPolicy: null, frameState: null }), []);
});
