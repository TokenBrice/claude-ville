import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
    createLightFrameState,
    createSeaWeather,
    resolveAtmosphereCourses,
    resolveBeam,
    resolveCamera,
    resolveFatPixels,
    resolveFrameGrade,
    resolveLights,
    resolvePaletteLut,
    resolvePuddles,
    resolveSeaWeather,
    resolveWaterFx,
    resolveWeatherUniform,
} from '../../claudeville/src/presentation/character-mode/gpu/GpuFrameState.js';

// Wave 10 S0a: every resolver must reproduce the value the WebGL2 renderer
// computed inline before the extraction (GOLDEN: 6559335's GpuWorldRenderer
// methods run on these fixtures), so both world backends upload one truth.

const W = 1680;
const H = 1032;

function camera({ zoom = 2, dpr = 1, x = -600.4, y = -233.7, gpu = null } = {}) {
    const rounded = (v) => Math.round(v * zoom * dpr) / dpr;
    return {
        zoom,
        x,
        y,
        renderOffsetX: rounded(x),
        renderOffsetY: rounded(y),
        renderOffsetGpuX: gpu ? gpu[0] : rounded(x),
        renderOffsetGpuY: gpu ? gpu[1] : rounded(y),
        _dpr: () => dpr,
    };
}

const CAMERAS = {
    z1: camera({ zoom: 1 }),
    z2: camera({ zoom: 2 }),
    z3dpr2: camera({ zoom: 1.5, dpr: 2, x: -1400.25, y: -310.5 }),
    // A flight frame: fractional k and an unrounded GPU offset.
    flight: camera({ zoom: 2.37, dpr: 1, x: -600.4, y: -233.7, gpu: [-1423.3, -553.8] }),
};

const GRADE_DAY = { key: 'day', exposure: 1, sunBand: 0.8, rake: 0.2, night: 0, cloudShadow: 0.7, fogColor: [0.62, 0.7, 0.78] };
const GRADE_GOLD = { key: 'gold', exposure: 1, sunBand: 0.6, rake: 0.7, night: 0.1, cloudShadow: 0.5, fogColor: [0.8, 0.6, 0.5] };
const GRADE_NIGHT = { key: 'night', exposure: 0.6, sunBand: 0, rake: 0, night: 1, cloudShadow: 0, fogColor: [0.2, 0.25, 0.35] };

function lights() {
    return [
        { id: 'l812', x: 812, y: 390, footX: 812, footY: 410, radiusWorld: 96, intensity: 1.2, height: 18, nx: 0.7, ng: 0.3, role: 1, r: 255, g: 190, b: 120, ownerSlot: 0, landmarkId: 3, columnReach: 1.5, night: true, priority: 3 },
        { id: 'l900', x: 900, y: 440, footX: 900, footY: 460, radiusWorld: 64, intensity: 0.9, height: 0, role: 2, r: 240, g: 200, b: 140, landmarkId: 4, night: true, priority: 2 },
        { id: 'l700', x: 700, y: 360, footX: 700, footY: 380, radiusWorld: 48, intensity: 2, role: 3, attention: true, ownerSlot: 5, r: 255, g: 80, b: 60, priority: 9 },
        { id: 'l1020', x: 1020, y: 500, footX: 1020, footY: 520, radiusWorld: 140, intensity: 0.7, height: 40, waterOnly: true, role: 2, r: 250, g: 240, b: 200, night: true, columnReach: 3 },
        { id: 'l640', x: 640, y: 280, footX: 640, footY: 300, radiusWorld: 30, intensity: 5, role: 0, r: 255, g: 255, b: 255 },
    ];
}

function feeds() {
    const puddleData = new Uint8Array(64).map((_, i) => (i * 37) % 256);
    const footData = new Uint8Array(2 * 8 * 4).map((_, i) => (i * 11) % 256);
    return {
        noon: {
            timeMs: 123456.5,
            motionScale: 1,
            atmosphere: {
                lightGrade: GRADE_DAY,
                weather: { type: 'partly', intensity: 0.2, precipitation: 0, fog: 0.05, cloudCover: 0.4, windX: 0.9, seed: 7 },
                sky: { sun: { visible: true, xFrac: 0.62 }, moon: { visible: false } },
            },
            lighting: { ambientLight: 1, beaconIntensity: 0, sunDirIso: { x: -0.6, y: -0.8 }, sunWarmth: 0.3, moonFill: 0 },
            lights: lights(),
            wetness: 0,
            paletteLut: { width: 11, height: 3 },
            paletteLutRevision: 2,
        },
        golden: {
            timeMs: 987654.25,
            motionScale: 1,
            atmosphere: {
                lightGrade: GRADE_GOLD,
                weather: { type: 'clear', intensity: 0, precipitation: 0, fog: 0, cloudCover: 0.1, windX: 0 },
                sky: { sun: { visible: true, xFrac: 0.2 }, moon: { visible: true, xFrac: 0.8 } },
            },
            lighting: { ambientLight: 0.7, beaconIntensity: 0.2, sunDirIso: { x: -0.9, y: -0.3 }, sunWarmth: 0.9, moonFill: 0.4 },
            lights: lights(),
            wetness: 0.3,
            footprint: { data: footData, width: 8, height: 4, originX: -200, originY: 100, cell: 4, revision: 3 },
            beam: { foot: { x: 1500, y: 700 }, angle: 1.2, length: 280, farWidth: 64, sheenStep: 2, courses: [[0, 0.3, 1], [0, 0.7, 0.5], [0, 1, 0.25]] },
            paletteLut: { width: 11, height: 3 },
        },
        moonStorm: {
            timeMs: 45000,
            reducedMotion: false,
            motionScale: 1,
            weather: { type: 'storm', intensity: 1, precipitation: 1, fog: 0.34, cloudCover: 1, windX: -0.78, seed: 11 },
            atmosphere: {
                lightGrade: GRADE_NIGHT,
                weather: { type: 'storm', intensity: 1, precipitation: 1, fog: 0.34, cloudCover: 1, windX: -0.78, seed: 11 },
                sky: { sun: { visible: false }, moon: { visible: true, xFrac: 0.4 } },
            },
            lighting: {
                ambientLight: 0.15, beaconIntensity: 0.85, moonFill: 0.9, sunDirIso: { x: -0.7, y: -0.7 }, sunWarmth: 0,
                sourceEnergy: { core: 1.2, spill: 0.8, bloom: 0.6, bucket: 'night' },
            },
            lights: lights(),
            wetness: 0.8,
            puddles: 0.6,
            puddleMask: { data: puddleData, cols: 8, rows: 8, x0: -64, y0: 32, revision: 4 },
            skyPalette: { upperBand: '#335577', horizon: '#8899aa' },
            footprint: { data: footData, width: 8, height: 4, originX: -200, originY: 100, cell: 4, revision: 3 },
            beam: { foot: { x: 1500, y: 700 }, angle: 2.4, length: 320, farWidth: 58, sheenStep: 1 },
        },
        clearMoon: {
            timeMs: 3000,
            reducedMotion: true,
            atmosphere: {
                lightGrade: GRADE_NIGHT,
                weather: { type: 'clear', intensity: 0, precipitation: 0, fog: 0, cloudCover: 0.2, windX: 0.3 },
                sky: { sun: { visible: false }, moon: { visible: true, xFrac: 0.3 } },
            },
            lighting: { ambientLight: 0.2, beaconIntensity: 0.6, moonFill: 0.8 },
            lights: lights().slice(0, 3),
            wetness: 0.005,
            puddles: 0.0005,
            puddleMask: { data: puddleData, cols: 8, rows: 8, x0: -64, y0: 32, revision: 4 },
            paletteLut: { width: 12, height: 3 },
        },
    };
}

// [feed, camera, ladder level]: golden hour, a partly cloudy noon, a REDUCED
// moonlit storm, a reduced-motion clear moon, a MINIMAL flight frame and a
// MINIMAL clear night.
const CASES = [
    ['golden', 'z1', 0], ['noon', 'z2', 0], ['moonStorm', 'z1', 1],
    ['clearMoon', 'z3dpr2', 0], ['noon', 'flight', 2], ['clearMoon', 'z1', 2],
];

const GOLDEN = {
    camera: {
        z1: [-600, -234, 1],
        z2: [-600.5, -233.5, 2],
        z3dpr2: [-1400.3333333333333, -310.3333333333333, 3],
        flight: [-600.548523206751, -233.67088607594934, 2.37],
    },
    fat: { z1: false, z2: false, z3dpr2: false, flight: true },
    water: {
        'golden/z1/0': { fx: [1, 0, 0, 1], glint: [336, 0.8050000071525574, 1, 0.11999999731779099], stops: [0.9254902005195618, 0.6901960968971252, 0.40784314274787903, 0.7686274647712708, 0.501960813999176, 0.3294117748737335] },
        'noon/z2/0': { fx: [1, 0, 1, 1], glint: [1041.5999755859375, 0.47999998927116394, 2, 0.15000000596046448], stops: [0.7529411911964417, 0.7450980544090271, 0.6431372761726379, 0.5882353186607361, 0.615686297416687, 0.5607843399047852] },
        'moonStorm/z1/1': { fx: [1, 1, 0, 1], glint: [0, 0, 0, 0], stops: [0, 0, 0, 0, 0, 0] },
        'clearMoon/z3dpr2/0': { fx: [0, 0, 0, 0], glint: [504, 0.800000011920929, 3, 0.03999999910593033], stops: [0.7686274647712708, 0.8392156958580017, 0.886274516582489, 0.5176470875740051, 0.6039215922355652, 0.6901960968971252] },
        'noon/flight/2': { fx: [0, 0, 0, 0], glint: [1041.5999755859375, 0.47999998927116394, 2, 0.1265822798013687], stops: [0.7529411911964417, 0.7450980544090271, 0.6431372761726379, 0.5882353186607361, 0.615686297416687, 0.5607843399047852] },
        'clearMoon/z1/2': { fx: [0, 0, 0, 0], glint: [504, 0.800000011920929, 3, 0.11999999731779099], stops: [0.7686274647712708, 0.8392156958580017, 0.886274516582489, 0.5176470875740051, 0.6039215922355652, 0.6901960968971252] },
    },
    atmosphere: {
        'golden/z1/0': { cloud: [0, 0, 0, 0], thresholds: [2, 2, 2], haze: [0.800000011920929, 0.6000000238418579, 0.5, 0.14000000059604645], sunlit: 0, courses: 0, aerialHaze: 0.14 },
        'noon/z2/0': { cloud: [0, 0, 0.05950000137090683, 0], thresholds: [0.6153594851493835, 0.6838235259056091, 0.7637255191802979], haze: [0.6200000047683716, 0.699999988079071, 0.7799999713897705, 0.08399999886751175], sunlit: 0.4353676438331604, courses: 3, aerialHaze: 0.084 },
        'moonStorm/z1/1': { cloud: [0, 0, 0, 0], thresholds: [2, 2, 2], haze: [0.20000000298023224, 0.25, 0.3499999940395355, 0.1876000016927719], sunlit: 0, courses: 0, aerialHaze: 0.18760000000000002 },
        'clearMoon/z3dpr2/0': { cloud: [0, 0, 0, 0], thresholds: [2, 2, 2], haze: [0.20000000298023224, 0.25, 0.3499999940395355, 0.10999999940395355], sunlit: 0, courses: 0, aerialHaze: 0.11000000000000001 },
        'noon/flight/2': { cloud: [0, 0, 0, 0], thresholds: [2, 2, 2], haze: [0.6200000047683716, 0.699999988079071, 0.7799999713897705, 0], sunlit: 0, courses: 0, aerialHaze: 0 },
        'clearMoon/z1/2': { cloud: [0, 0, 0, 0], thresholds: [2, 2, 2], haze: [0.20000000298023224, 0.25, 0.3499999940395355, 0], sunlit: 0, courses: 0, aerialHaze: 0 },
    },
    sea: {
        'golden/z1/0': { sunlit: 0, gust: null },
        'noon/z2/0': { sunlit: 0.4353676438331604, gust: { rect: [528, 200, 16, 8], revision: 1, data: '71f5fa03fd88e0c8' } },
        'moonStorm/z1/1': { sunlit: 0, gust: { rect: [528, 180, 16, 12], revision: 1, data: '70993f31d978ba5d' } },
        'clearMoon/z3dpr2/0': { sunlit: 0, gust: { rect: [1328, 272, 16, 8], revision: 1, data: '643d5dfc7b623d85' } },
        'noon/flight/2': { sunlit: 0, gust: null },
        'clearMoon/z1/2': { sunlit: 0, gust: null },
    },
    lights: {
        'golden/z1/0': {
            admission: { cap: 128, admitted: 5, offered: 5, culled: 0, overCap: 0, tileFull: 0, maxPerTile: 3, clusters: true, tiles: 459, daylight: false },
            lanes: [
                [700, 380, 48, 2, 812, 410, 96, 1.2000000476837158, 900, 460, 64, 0.8999999761581421, 1020, 520, 140, 0.699999988079071, 640, 300, 30, 3],
                [0, 0, 0, 3, 18, 0.699999988079071, 0.30000001192092896, 1, 0, 0, 0, 2, 40, 0, 0, 2, 0, 0, 0, 0],
                [1, 0.3137255012989044, 0.23529411852359772, 1, 1, 0.7450980544090271, 0.47058823704719543, 0.20000000298023224, 0.9411764740943909, 0.7843137383460999, 0.5490196347236633, 0.20000000298023224, 0.9803921580314636, 0.9411764740943909, 0.7843137383460999, 0.20000000298023224, 1, 1, 1, 1],
                [5, 0, 0, 1, 0, 3, 3, 1.5, 0, 4, 3, 1, 0, 0, 7, 3, 0, 0, 1, 1],
            ],
            wetReflectionCount: 8, marchSteps: 8, tiles: '05bbe9ade20df1c3', localLightPhase: 0.30000000000000004,
        },
        'noon/z2/0': {
            admission: { cap: 0, admitted: 0, offered: 0, culled: 0, overCap: 0, tileFull: 0, maxPerTile: 0, clusters: false, tiles: 459, daylight: true },
            lanes: [[], [], [], []], wetReflectionCount: 0, marchSteps: 0, tiles: null, localLightPhase: 0,
        },
        'moonStorm/z1/1': {
            admission: { cap: 64, admitted: 5, offered: 5, culled: 0, overCap: 0, tileFull: 0, maxPerTile: 3, clusters: true, tiles: 459, daylight: false },
            lanes: [
                [700, 380, 48, 2, 812, 410, 96, 1.2000000476837158, 900, 460, 64, 0.8999999761581421, 1020, 520, 140, 0.699999988079071, 640, 300, 30, 3],
                [0, 0, 0, 3, 18, 0.699999988079071, 0.30000001192092896, 1, 0, 0, 0, 2, 40, 0, 0, 2, 0, 0, 0, 0],
                [1, 0.3137255012989044, 0.23529411852359772, 1, 1, 0.7450980544090271, 0.47058823704719543, 0.6800000071525574, 0.9411764740943909, 0.7843137383460999, 0.5490196347236633, 0.6800000071525574, 0.9803921580314636, 0.9411764740943909, 0.7843137383460999, 0.6800000071525574, 1, 1, 1, 0.800000011920929],
                [5, 0, 0, 1, 0, 3, 3, 1.5, 0, 4, 3, 1, 0, 0, 7, 3, 0, 0, 1, 1],
            ],
            wetReflectionCount: 4, marchSteps: 4, tiles: '05bbe9ade20df1c3', localLightPhase: 0.85,
        },
        'clearMoon/z3dpr2/0': {
            admission: { cap: 128, admitted: 0, offered: 0, culled: 3, overCap: 0, tileFull: 0, maxPerTile: 0, clusters: false, tiles: 459, daylight: false },
            lanes: [[], [], [], []], wetReflectionCount: 0, marchSteps: 0, tiles: null, localLightPhase: 0.8,
        },
        'noon/flight/2': {
            admission: { cap: 0, admitted: 0, offered: 0, culled: 0, overCap: 0, tileFull: 0, maxPerTile: 0, clusters: false, tiles: 459, daylight: true },
            lanes: [[], [], [], []], wetReflectionCount: 0, marchSteps: 0, tiles: null, localLightPhase: 0,
        },
        'clearMoon/z1/2': {
            admission: { cap: 24, admitted: 3, offered: 3, culled: 0, overCap: 0, tileFull: 0, maxPerTile: 2, clusters: false, tiles: 459, daylight: false },
            lanes: [
                [700, 380, 48, 2, 812, 410, 96, 1.2000000476837158, 900, 460, 64, 0.8999999761581421],
                [0, 0, 0, 3, 18, 0.699999988079071, 0.30000001192092896, 1, 0, 0, 0, 2],
                [1, 0.3137255012989044, 0.23529411852359772, 1, 1, 0.7450980544090271, 0.47058823704719543, 0.6000000238418579, 0.9411764740943909, 0.7843137383460999, 0.5490196347236633, 0.6000000238418579],
                [5, 0, 0, 1, 0, 3, 2, 1.5, 0, 4, 2, 1],
            ],
            wetReflectionCount: 0, marchSteps: 0, tiles: null, localLightPhase: 0.8,
        },
    },
    beam: {
        'golden/z1/0': { ground: [1500, 700, 1.2, 1], shape: [280, 6, 32, 2], courseEnds: [0.3, 0.7, 1], courseShares: [1, 0.5, 0.25] },
        'moonStorm/z1/1': { ground: [1500, 700, 2.4, 1], shape: [320, 6, 29, 1], courseEnds: [0.34, 0.68, 1], courseShares: [1, 0.6, 0.3] },
    },
    puddles: {
        'moonStorm/z1/1': { puddles: 0.6, rect: [-64, 32, 8, 8], sky: [0.20000000298023224, 0.3333333432674408, 0.46666666865348816, 0.5333333611488342, 0.6000000238418579, 0.6666666865348816] },
    },
    lut: { 'golden/z1/0': true, 'noon/z2/0': true, 'moonStorm/z1/1': false, 'clearMoon/z3dpr2/0': false, 'noon/flight/2': false, 'clearMoon/z1/2': false },
    weather: {
        'golden/z1/0': [0, 0, 0, 0],
        'noon/z2/0': [0, 0.05, 0, 0.2],
        'moonStorm/z1/1': [0.72, 0.34, 1, 0.72],
        'clearMoon/z3dpr2/0': [0, 0, 0, 0],
        'noon/flight/2': [0, 0.05, 0, 0],
        'clearMoon/z1/2': [0, 0, 0, 0],
    },
};

const f32 = (values) => values.map(Math.fround);
const digest = (data) => createHash('sha256').update(Buffer.from(data.buffer, data.byteOffset, data.byteLength)).digest('hex').slice(0, 16);

function eachCase(fn) {
    const all = feeds();
    for (const [feedName, cameraName, level] of CASES) {
        const feed = all[feedName];
        fn({ key: `${feedName}/${cameraName}/${level}`, feed, camera: CAMERAS[cameraName], level, grade: resolveFrameGrade(feed) });
    }
}

test('resolveCamera and resolveFatPixels keep the resting, DPR-2 and flight-frame camera and fat gate', () => {
    for (const [name, cam] of Object.entries(CAMERAS)) {
        const view = resolveCamera(cam);
        assert.deepEqual([...view.xy, view.scale], GOLDEN.camera[name], name);
        assert.equal(resolveFatPixels(cam), GOLDEN.fat[name], name);
        assert.equal(resolveFatPixels(cam, !GOLDEN.fat[name]), !GOLDEN.fat[name], `${name} override`);
    }
});

test('resolveWaterFx keeps the water clock, rings, caustics, swash and the sun/moon path', () => {
    eachCase(({ key, feed, camera, level, grade }) => {
        const water = resolveWaterFx(feed, camera, level, grade, feed.lighting?.moonFill ?? 0, W);
        assert.deepEqual({ fx: Array.from(water.fx), glint: Array.from(water.glint), stops: Array.from(water.stops) }, GOLDEN.water[key], key);
    });
});

test('resolveAtmosphereCourses keeps the cloud courses, thresholds, aerial haze and the sea sunlit ceiling', () => {
    eachCase(({ key, feed, camera, level, grade }) => {
        const c = resolveAtmosphereCourses(level, camera, feed, grade);
        assert.deepEqual({
            cloud: Array.from(c.cloud), thresholds: Array.from(c.thresholds), haze: Array.from(c.haze),
            sunlit: c.sunlit, courses: c.courses, aerialHaze: c.aerialHaze,
        }, GOLDEN.atmosphere[key], key);
    });
});

test('resolveSeaWeather keeps the sunlit course and the gust field, re-baked only when its step moves', () => {
    eachCase(({ key, feed, camera, level, grade }) => {
        const courses = resolveAtmosphereCourses(level, camera, feed, grade);
        const sea = resolveSeaWeather(level, camera, feed, { courses, width: W, height: H });
        const gust = sea.gust && { rect: Array.from(sea.gust.rect), revision: sea.gust.revision, data: digest(sea.gust.data) };
        assert.deepEqual({ sunlit: sea.sunlit, gust }, GOLDEN.sea[key], key);
    });
    const feed = feeds().noon;
    const out = createSeaWeather();
    const opts = { courses: null, width: W, height: H };
    resolveSeaWeather(0, CAMERAS.z2, feed, opts, out);
    resolveSeaWeather(0, CAMERAS.z2, { ...feed, timeMs: feed.timeMs + 20 }, opts, out);
    assert.equal(out.gust.revision, 1, 'the same 125 ms step keeps the field');
    resolveSeaWeather(0, CAMERAS.z2, { ...feed, timeMs: feed.timeMs + 125 }, opts, out);
    assert.equal(out.gust.revision, 2, 'the next step re-bakes it');
});

test('resolveLights keeps admission, the light records, the tile index, wet slots and the footprint march', () => {
    eachCase(({ key, feed, camera, level }) => {
        const lights = resolveLights(feed, camera, level, { width: W, height: H });
        const golden = GOLDEN.lights[key];
        const lanes = [0, 1, 2, 3].map(row => Array.from(lights.records.subarray(row * 1024, row * 1024 + lights.count * 4)));
        assert.deepEqual(lights.admission, golden.admission, key);
        assert.equal(lights.count, golden.admission.admitted, key);
        assert.deepEqual(lanes, golden.lanes, key);
        assert.equal(lights.wetReflectionCount, golden.wetReflectionCount, key);
        assert.equal(lights.marchSteps, golden.marchSteps, key);
        assert.equal(lights.tiles ? digest(lights.tiles) : null, golden.tiles, key);
        assert.equal(lights.localLightPhase, golden.localLightPhase, key);
    });
});

test('resolveLights moves the record revision only when a light changes', () => {
    const feed = feeds().moonStorm;
    const state = createLightFrameState();
    const opts = { width: W, height: H, state };
    resolveLights(feed, CAMERAS.z1, 0, opts);
    assert.deepEqual([state.recordsRevision, state.tilesRevision], [1, 1]);
    resolveLights(feed, CAMERAS.z1, 0, opts);
    assert.deepEqual([state.recordsRevision, state.tilesRevision], [1, 1]);
    const dimmed = { ...feed, lights: feed.lights.map((light, i) => (i === 0 ? { ...light, intensity: 0.5 } : light)) };
    resolveLights(dimmed, CAMERAS.z1, 0, opts);
    assert.deepEqual([state.recordsRevision, state.tilesRevision], [2, 1]);
});

test('resolveBeam, resolvePuddles, resolvePaletteLut and resolveWeatherUniform keep their gates and values', () => {
    eachCase(({ key, feed, level }) => {
        const beam = resolveBeam(feed);
        const goldenBeam = GOLDEN.beam[key];
        assert.equal(beam.active, Boolean(goldenBeam), key);
        assert.deepEqual(Array.from(beam.ground), goldenBeam ? f32(goldenBeam.ground) : [0, 0, 0, 0], key);
        if (goldenBeam) {
            assert.deepEqual(Array.from(beam.shape), f32(goldenBeam.shape), key);
            assert.deepEqual(Array.from(beam.courseEnds), f32(goldenBeam.courseEnds), key);
            assert.deepEqual(Array.from(beam.courseShares), f32(goldenBeam.courseShares), key);
        }
        const puddles = resolvePuddles(feed);
        const goldenPuddles = GOLDEN.puddles[key];
        assert.equal(puddles.ground, Boolean(goldenPuddles), key);
        assert.equal(puddles.mask, goldenPuddles ? feed.puddleMask : null, key);
        assert.equal(puddles.puddles, goldenPuddles ? goldenPuddles.puddles : 0, key);
        if (goldenPuddles) {
            assert.deepEqual(Array.from(puddles.rect), f32(goldenPuddles.rect), key);
            assert.deepEqual(Array.from(puddles.sky), goldenPuddles.sky, key);
        }
        const lut = resolvePaletteLut(level, feed);
        assert.equal(lut, GOLDEN.lut[key] ? feed.paletteLut : null, key);
        assert.deepEqual(resolveWeatherUniform(feed, level), GOLDEN.weather[key], key);
    });
});
