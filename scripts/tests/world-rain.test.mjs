// RN-1 (look `rn1`) — rain that falls in the world: the GPU field's resolver
// keeps the overlay's amount, motion contract and weather truth; the GLSL and
// WGSL programs are twins; the overlay hands over exactly the share drawn.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    createGpuRainField,
    gpuRainField,
    RAIN_FALL_HEIGHT,
    RAIN_GROUND_CELL,
    RAIN_LAYERS,
    rainSplashMask,
    SPLASH_FRAMES,
    WeatherRenderer,
    weatherPressureLevel,
} from '../../claudeville/src/presentation/character-mode/WeatherRenderer.js';
import { resetFramePressureState, sampleFramePressure } from '../../claudeville/src/presentation/character-mode/MarkGovernor.js';
import {
    RAIN_FRAGMENT,
    RAIN_SPLASH_BITS,
    RAIN_VERTEX,
} from '../../claudeville/src/presentation/character-mode/gpu/GpuWorldRenderer.js';
import { RAIN_WGSL } from '../../claudeville/src/presentation/character-mode/gpu/wgsl/rain.js';
import { EFFECT_BUDGET, effectBudgetMode } from '../../claudeville/src/presentation/character-mode/gpu/GpuWorldPolicy.js';
import { POST_FX_LEVELS } from '../../claudeville/src/presentation/character-mode/postfx/PostFxLadder.js';
import { resetLookStrengths, setLookStrength } from '../../claudeville/src/presentation/character-mode/LookStrengths.js';

const RAIN = { type: 'rain', intensity: 0.85, precipitation: 0.9, cloudCover: 0.92, fog: 0.1, windX: 0.35, seed: 4242 };
const atmosphereOf = (weather = RAIN, extra = {}) => ({
    weather,
    clock: { localDate: '2026-11-13' },
    lightGrade: { night: 0 },
    motion: { particleEnabled: true },
    ...extra,
});
const cameraOf = (zoom = 2, width = 1920, height = 1080) => ({
    zoom,
    _viewportWidth: () => width,
    _viewportHeight: () => height,
    screenToWorld: (x, y) => ({ x: x / zoom - 300, y: y / zoom + 200 }),
});
// Expected streaks in view from the field: candidates per cell over the
// visible world area.
const streaksInView = (field, camera) => field.uniforms[4] / (RAIN_GROUND_CELL ** 2)
    * (camera._viewportWidth() * camera._viewportHeight()) / (camera.zoom ** 2);

test('rn1 at 0 draws nothing on the GPU and the overlay keeps the whole field', () => {
    setLookStrength('rn1', 0);
    try {
        const field = gpuRainField(atmosphereOf(), cameraOf(), { timeMs: 1000, splashMask: true });
        assert.equal(field.share, 0);
        assert.equal(field.instances, 0);
    } finally {
        resetLookStrengths();
    }
});

test('the field rains only when the overlay would, never in winter, never at MINIMAL', () => {
    setLookStrength('rn1', 1);
    try {
        const camera = cameraOf();
        assert.equal(gpuRainField(atmosphereOf({ ...RAIN, type: 'clear', precipitation: 0 }), camera).instances, 0);
        assert.equal(gpuRainField(atmosphereOf(RAIN, { clock: { localDate: '2026-12-13' } }), camera).instances, 0, 'winter snow stays on the overlay');
        assert.equal(gpuRainField(atmosphereOf(), camera, { on: false }).instances, 0);
        assert.equal(effectBudgetMode('world-rain', POST_FX_LEVELS.FULL), 'on');
        assert.equal(effectBudgetMode('world-rain', POST_FX_LEVELS.REDUCED), 'on');
        assert.equal(effectBudgetMode('world-rain', POST_FX_LEVELS.MINIMAL), 'off');
        assert.equal(EFFECT_BUDGET['world-rain'].canvas, 'canvas-weather');
        const field = gpuRainField(atmosphereOf(), camera);
        assert.ok(field.instances > 0 && field.share === 1);
    } finally {
        resetLookStrengths();
    }
});

test('the amount of rain is the overlay\'s at every zoom, and the strength splits it', () => {
    setLookStrength('rn1', 1);
    try {
        for (const zoom of [0.5, 1, 1.5, 2, 2.5, 3]) {
            for (const weather of [RAIN, { ...RAIN, type: 'storm', intensity: 1, precipitation: 1, windX: 0.9 }]) {
                const camera = cameraOf(zoom);
                const field = gpuRainField(atmosphereOf(weather), camera);
                const counted = countOverlayStreaks(zoom, 0, { weather, intensity: field.intensity, embellish: field.embellish });
                const expected = streaksInView(field, camera);
                assert.ok(Math.abs(expected - counted) <= Math.max(3, counted * 0.02),
                    `${weather.type} zoom ${zoom}: field ${expected.toFixed(1)} vs overlay ${counted}`);
                assert.ok(field.uniforms[4] <= 1, `${weather.type} zoom ${zoom}: one candidate per cell is enough`);
            }
        }
        const full = gpuRainField(atmosphereOf(), cameraOf(2), {}, createGpuRainField()).uniforms[4];
        setLookStrength('rn1', 0.5);
        const half = gpuRainField(atmosphereOf(), cameraOf(2), {}, createGpuRainField()).uniforms[4];
        assert.ok(Math.abs(half - full / 2) < 1e-6, 'half the field moves into the world at 0.5');
    } finally {
        resetLookStrengths();
    }
});

// Streaks the overlay (WeatherRenderer._drawRain, 1920x1080) draws for this
// weather and gated intensity at the given GPU share.
function countOverlayStreaks(zoom, share, { weather = RAIN, intensity = 0.8, embellish = true } = {}) {
    const renderer = new WeatherRenderer();
    renderer.sceneContext = { camera: { zoom } };
    renderer._allowEmbellishment = embellish;
    const ctx = {
        save() {}, restore() {}, beginPath() {}, fill() {}, fillRect() {}, rect() {},
        set globalAlpha(_) {}, set fillStyle(_) {},
    };
    let streaks = 0;
    renderer._drawRainStreakLayer = (c, canvas, grid, options) => { streaks += options.count; };
    renderer._drawRainCurtains = () => {};
    renderer._drawRain(ctx, { width: 1920, height: 1080 }, { ...weather, intensity }, 0, 42, true, 0, share);
    return streaks;
}

test('the overlay draws exactly the share the GPU did not', () => {
    const all = countOverlayStreaks(2, 0);
    assert.ok(all > 0);
    assert.equal(countOverlayStreaks(2, 1), 0);
    const half = countOverlayStreaks(2, 0.5);
    assert.ok(Math.abs(half - all / 2) <= RAIN_LAYERS.length, `${half} vs ${all}`);
});

test('the fall phase integrates the motion clock, holds under reduced motion, and is seeded', () => {
    setLookStrength('rn1', 1);
    try {
        const camera = cameraOf();
        const field = createGpuRainField();
        gpuRainField(atmosphereOf(), camera, { timeMs: 10000 }, field);
        const first = field.phase.slice();
        gpuRainField(atmosphereOf(), camera, { timeMs: 10016 }, field);
        const speed = (0.42 + field.intensity * 0.34) * 0.75;
        for (let layer = 0; layer < 3; layer++) {
            const step = ((field.phase[layer] - first[layer]) + 1) % 1;
            assert.ok(Math.abs(step - 16 * speed * RAIN_LAYERS[layer].speedMul / RAIN_FALL_HEIGHT) < 1e-9);
        }
        // A frame gap past the overlay's MAX_FRAME_DT advances at most 80 ms.
        const before = field.phase[1];
        gpuRainField(atmosphereOf(), camera, { timeMs: 60000 }, field);
        assert.ok(Math.abs((((field.phase[1] - before) + 1) % 1) - 80 * speed / RAIN_FALL_HEIGHT) < 1e-9);
        // Reduced motion: a static, seeded frame (mid layer, half the streaks, splash rings).
        const reduced = atmosphereOf(RAIN, { motion: { particleEnabled: false } });
        const a = gpuRainField(reduced, camera, { timeMs: 1000, splashMask: true }, createGpuRainField());
        const b = gpuRainField(reduced, camera, { timeMs: 999999, splashMask: true }, createGpuRainField());
        assert.deepEqual(Array.from(a.uniforms), Array.from(b.uniforms));
        assert.equal(a.uniforms[15] & 1, 1, 'static flag');
        const live = gpuRainField(atmosphereOf(), camera, { timeMs: 1000 }, createGpuRainField());
        assert.ok(Math.abs(a.uniforms[4] - live.uniforms[4] / 2) < 1e-6, 'half the streaks, as the overlay');
    } finally {
        resetLookStrengths();
    }
});

test('weather truth: the field reads the weather, its seed, the clock and the camera only', () => {
    setLookStrength('rn1', 1);
    try {
        const camera = cameraOf();
        const base = gpuRainField(atmosphereOf(), camera, { timeMs: 5000 }, createGpuRainField());
        const busy = gpuRainField(atmosphereOf(RAIN, { agents: [{ status: 'working' }], director: { mood: 'tense' } }), camera, { timeMs: 5000 }, createGpuRainField());
        assert.deepEqual(Array.from(busy.uniforms), Array.from(base.uniforms));
        const reseeded = gpuRainField(atmosphereOf({ ...RAIN, seed: 7 }), camera, { timeMs: 5000 }, createGpuRainField());
        assert.notEqual(reseeded.uniforms[3], base.uniforms[3]);
    } finally {
        resetLookStrengths();
    }
});

test('the splash mask marks the overlay\'s open tiles and is cached per list', () => {
    const tiles = [{ tileX: 3, tileY: 4 }, { tileX: 39, tileY: 0 }];
    const mask = rainSplashMask(tiles);
    assert.equal(mask.format, 'r8');
    assert.equal(mask.data[4 * mask.width + 3], 255);
    assert.equal(mask.data[39], 255);
    assert.equal(mask.data.reduce((n, v) => n + (v ? 1 : 0), 0), 2);
    assert.equal(rainSplashMask(tiles), mask);
    assert.equal(rainSplashMask([]), null);
});

test('the splash bits are the overlay\'s three 7x4 frames', () => {
    for (let frame = 0; frame < SPLASH_FRAMES.length; frame++) {
        SPLASH_FRAMES[frame].forEach((line, row) => {
            for (let col = 0; col < line.length; col++) {
                const bit = 1 << (row * 7 + col);
                assert.equal((RAIN_SPLASH_BITS.light[frame] & bit) !== 0, line[col] === '#');
                assert.equal((RAIN_SPLASH_BITS.dim[frame] & bit) !== 0, line[col] === '+');
            }
        });
    }
});

// Twins: the same expressions, GLSL and WGSL, line for line where it matters.
test('the GLSL and WGSL rain programs are twins', () => {
    const pairs = [
        [/x \*= 0x7feb352du;/, /x \*= 0x7feb352du;/],
        [/x \*= 0x846ca68bu;/, /x \*= 0x846ca68bu;/],
        [/return float\(h >> 8u\) \/ 16777216\.0;/, /return f32\(h >> 8u\) \/ 16777216\.0;/],
        [/uint h = rainHash\(\(uint\(cx \+ 32768\) \* 0x8da6b343u\) \^ \(uint\(cy \+ 32768\) \* 0xd8163841u\) \^ uint\(u_rainView\.w\)\);/,
            /let h = rainHash\(\(u32\(cx \+ 32768\) \* 0x8da6b343u\) \^ \(u32\(cy \+ 32768\) \* 0xd8163841u\) \^ u32\(rain\.view\.w\)\);/],
        [/float pick = rainU01\(rainHash\(h \^ 0x68e31da4u\)\);/, /let pick = rainU01\(rainHash\(h \^ 0x68e31da4u\)\);/],
        [/\(pick < 0\.45000 \? 0 : \(pick < 0\.80000 \? 1 : 2\)\)/, /select\(select\(select\(2, 1, pick < 0\.80000\), 0, pick < 0\.45000\), 1, still\)/],
        [/float fall = fract\(phase \+ rainU01\(rainHash\(h \+ 3u\)\)\);/, /let fall = fract\(phase \+ rainU01\(rainHash\(h \+ 3u\)\)\);/],
        [/bool streak = rainU01\(h\) < u_rainFall\.x;/, /let streak = rainU01\(h\) < rain\.fall\.x;/],
        [/float lean = clamp\(u_rainFall\.w \* 0\.8 \* windMul, -1\.5, 1\.5\);/, /let lean = clamp\(rain\.fall\.w \* 0\.8 \* windMul, -1\.5, 1\.5\);/],
        [/float height = u_rainFall\.y \* \(1\.0 - fall\);/, /let height = rain\.fall\.y \* \(1\.0 - fall\);/],
        [/float bottomX = floor\(ground\.x - height \* u_rainFall\.z \* windMul \* 0\.34000\);/, /let bottomX = floor\(ground\.x - height \* rain\.fall\.z \* windMul \* 0\.34000\);/],
        [/float tail = floor\(float\(cells - 1\) \* lean \+ 0\.5\);/, /let tail = floor\(f32\(cells - 1\) \* lean \+ 0\.5\);/],
        [/origin = vec2\(bottomX - tail \+ left, bottomY - float\(cells - 1\)\);/, /origin = vec2f\(bottomX - tail \+ left, bottomY - f32\(cells - 1\)\);/],
        [/int frame = still \? 2 : int\(floor\(fall \/ max\(u_rainSplash\.y \* speedMul, 0\.000001\)\)\);/,
            /let frame = select\(i32\(floor\(fall \/ max\(rain\.splash\.y \* speedMul, 0\.000001\)\)\), 2, still\);/],
        [/origin = ground - vec2\(3\.0, 3\.0\);/, /origin = ground - vec2f\(3\.0, 3\.0\);/],
        [/float key = clamp\(floor\(\(ground\.y - \(-2048\.0\)\) \* 8\.0 \+ 0\.5\), 0\.0, 65535\.0\);/,
            /let key = clamp\(floor\(\(ground\.y - \(-2048\.0\)\) \* 8\.0 \+ 0\.5\), 0\.0, 65535\.0\);/],
    ];
    for (const [glsl, wgsl] of pairs) {
        assert.match(RAIN_VERTEX, glsl);
        assert.match(RAIN_WGSL, wgsl);
    }
    // The fragment: one texel per row on round(row x lean), the far layer
    // dashed, the splash crown from the shared bits; nothing feeds bloom.
    assert.match(RAIN_FRAGMENT, /if \(cell\.x != int\(floor\(float\(cell\.y\) \* v_lean \+ 0\.5\)\) - v_shape\.y\) discard;/);
    assert.match(RAIN_WGSL, /if \(cell\.x != i32\(floor\(f32\(cell\.y\) \* in\.lean \+ 0\.5\)\) - in\.shape\.y\) \{ discard; \}/);
    assert.match(RAIN_FRAGMENT, /if \(v_shape\.z != 0 && \(cell\.y & 1\) == 1\) discard;/);
    assert.match(RAIN_WGSL, /if \(in\.shape\.z != 0 && \(cell\.y & 1\) == 1\) \{ discard; \}/);
    for (const bits of [RAIN_SPLASH_BITS.light, RAIN_SPLASH_BITS.dim]) {
        for (const value of bits) {
            assert.ok(RAIN_FRAGMENT.includes(`${value}u`) && RAIN_WGSL.includes(`${value}u`));
        }
    }
    assert.match(RAIN_FRAGMENT, /outEmission = vec4\(0\.0\);/);
    assert.match(RAIN_WGSL, /out\.emission = vec4f\(0\.0\);/);
    // The depth: GL's (1 - key / 65535) * 2 - 1 lands at WebGPU's [0, 1].
    assert.match(RAIN_VERTEX, /gl_Position = vec4\(clip, \(1\.0 - key \/ 65535\.0\) \* 2\.0 - 1\.0, 1\.0\);/);
    assert.match(RAIN_WGSL, /out\.position = vec4f\(clip\.x, -clip\.y, 1\.0 - key \/ 65535\.0, 1\.0\);/);
    // Every layer constant reaches both.
    for (const layer of RAIN_LAYERS) {
        for (const value of [layer.windMul, layer.speedMul, layer.alpha]) {
            assert.ok(RAIN_VERTEX.includes(value.toFixed(5)) && RAIN_WGSL.includes(value.toFixed(5)));
        }
    }
});

// r4 / D4 — the reduced-motion pressure latch holds one key per static
// scene, size included. The field must key it with the overlay's own
// viewport, not the camera's size (which can differ: a backing-px canvas),
// or each frame re-keys the latch and the static field follows the live
// pressure (here: a shed embellishment would cut the density to 0.62x).
test('the static rain field shares the overlay\'s pressure latch key under load', () => {
    setLookStrength('rn1', 1);
    const perf = globalThis.__claudeVillePerf;
    try {
        resetFramePressureState();
        const viewport = { width: 1680, height: 1152 };
        const camera = { ...cameraOf(2, viewport.width * 2, viewport.height * 2) };
        const reduced = atmosphereOf(RAIN, { motion: { particleEnabled: false } });
        // A calm frame: the overlay latches level 0 for this static scene.
        assert.equal(weatherPressureLevel(reduced, true, { zoom: 2, width: viewport.width, height: viewport.height }), 0);
        // Load arrives: the live level sheds the weather embellishment.
        const heavy = { appUpdateP95: 60, appRenderP95: 60, rendererCostMs: 120 };
        for (let t = 500; t <= 200000; t += 500) sampleFramePressure(t, heavy);
        globalThis.__claudeVillePerf = { frameHealth: () => ({ p95AppUpdateMs: 60, p95AppRenderMs: 60, emaAppTotalMs: 120 }) };
        assert.ok(sampleFramePressure().level > 0, 'the live sample is under pressure');
        const field = gpuRainField(reduced, camera, { viewport }, createGpuRainField());
        assert.equal(field.embellish, true, 'the field read the latched calm level');
        assert.equal(weatherPressureLevel(reduced, true, { zoom: 2, width: viewport.width, height: viewport.height }), 0,
            'the overlay\'s next frame still reads the latch');
    } finally {
        if (perf === undefined) delete globalThis.__claudeVillePerf;
        else globalThis.__claudeVillePerf = perf;
        resetFramePressureState();
        resetLookStrengths();
    }
});
