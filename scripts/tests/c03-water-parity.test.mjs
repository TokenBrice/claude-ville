import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PNG } from 'pngjs';
import {
    CLOUD_PLANE,
    CLOUD_SECOND_OCTAVE,
    CLOUD_TILE_SIZE,
    SEA_STATE,
    buildCloudShadowTile,
    cloudFieldAt,
    cloudNoiseIntAt,
    CLOUD_INT_CONSTANTS,
} from '../../claudeville/src/presentation/character-mode/gpu/GpuWorldPolicy.js';
import { createSeaState, resolveSeaState } from '../../claudeville/src/presentation/character-mode/gpu/GpuFrameState.js';
import { POST_FX_LEVELS } from '../../claudeville/src/presentation/character-mode/postfx/PostFxLadder.js';
import { resetLookStrengths, setLookStrength } from '../../claudeville/src/presentation/character-mode/LookStrengths.js';
import { MAP_SIZE } from '../../claudeville/src/config/constants.js';
import {
    COAST_FIELD_FLAGS,
    COAST_PALETTE,
    COAST_WATER_STOPS,
    detectPilingTips,
    drawCanvasWaterMood,
    getCoastField,
    staticMirrorRgb,
} from '../../claudeville/src/presentation/character-mode/CoastBake.js';
import { drawCanvasWaterState } from '../../claudeville/src/presentation/character-mode/CanvasWaterState.js';
import { evaluateGrade } from '../../claudeville/src/presentation/character-mode/GradeEvaluator.js';

const ASSET_ROOT = new URL('../../claudeville/assets/sprites/', import.meta.url);

// C-03 / PERF-01 — integer bilinear cloud noise must match the JS float
// reference `cloudFieldAt` across positive and negative coordinates, with
// `CLOUD_PLANE` both off and on, and must derive its constants from
// `CLOUD_PLANE` and `CLOUD_SECOND_OCTAVE` (not hardcoded [1, 2] or 0.72).
test('C-03: integer bilinear cloudNoiseIntAt matches cloudFieldAt with plane off and on', () => {
    const tile = buildCloudShadowTile(CLOUD_TILE_SIZE);
    // Constants derived from CLOUD_PLANE and CLOUD_SECOND_OCTAVE.
    assert.equal(CLOUD_INT_CONSTANTS.planeScale100[0], Math.round(CLOUD_PLANE[0] * CLOUD_INT_CONSTANTS.u16PerPx * 100));
    assert.equal(CLOUD_INT_CONSTANTS.planeScale100[1], Math.round(CLOUD_PLANE[1] * CLOUD_INT_CONSTANTS.u16PerPx * 100));
    assert.equal(CLOUD_INT_CONSTANTS.oct2WeightMilli, Math.round(CLOUD_SECOND_OCTAVE.weight * 1000));

    const drifts = [
        [0, 0],
        [137.5, 42.25],
        [3511.75, 6820.5],
        [7160.125, 19.875],
    ];
    const coords = [-4200, -1793, -513, -17, -1, 0, 1, 37, 512, 1791, 4880, 11200];

    for (const planeOn of [false, true]) {
        const sx = planeOn ? CLOUD_PLANE[0] : 1;
        const sy = planeOn ? CLOUD_PLANE[1] : 1;
        let maxDiff = 0;
        let samples = 0;
        for (const [dx, dy] of drifts) {
            for (const icy of coords) {
                for (const icx of coords) {
                    const ref = cloudFieldAt(tile, (icx + 0.5) * sx + dx, (icy + 0.5) * sy + dy, CLOUD_TILE_SIZE);
                    const got = cloudNoiseIntAt(tile, icx, icy, dx, dy, planeOn) / 16711680;
                    const diff = Math.abs(got - ref);
                    if (diff > maxDiff) maxDiff = diff;
                    samples++;
                }
            }
        }
        assert.ok(samples > 500);
        // 1/256 texel quantization + rounding of plane coordinates stays well under 0.005.
        assert.ok(maxDiff < 0.005, `planeOn=${planeOn}: maxDiff=${maxDiff} exceeded 0.005`);
    }
});

// C-03 / PERF-02 — single whitecap streak counter in GpuFrameState: wraps at
// SEA_STATE.streakWrap (98304, never 96), uses baseWindX(weather), and
// reproduces identical shift across fresh and warmed renderers when replaying
// a latched feed.
test('C-03: resolveSeaState wraps at SEA_STATE.streakWrap, reads baseWindX, and matches on frozen replay', () => {
    try {
        setLookStrength('sea3', 1);
        const state = createSeaState();
        // Weather omits explicit windX -> baseWindX uses WIND_SPEED_BY_TYPE.rain (+0.9 -> fresh, eastward).
        const weather = { type: 'rain' };
        let t = 0;
        resolveSeaState({ timeMs: t, atmosphere: { weather } }, POST_FX_LEVELS.FULL, 0, state);
        // Advance > 100 steps (past the buggy 96 wrap) in valid 8-step hops.
        for (let step = 0; step < 30; step++) {
            t += 2000; // 12 ticks = 6 streak steps per call
            resolveSeaState({ timeMs: t, atmosphere: { weather } }, POST_FX_LEVELS.FULL, 0, state);
        }
        assert.equal(state.uniform[1], 2, 'rain without windX is fresh sea');
        assert.equal(state.uniform[2], 180, 'accumulates past 96 without premature wrap');
        assert.ok(state.uniform[2] < SEA_STATE.streakWrap);

        // Frozen replay: latching the resolved shift onto the feed makes a fresh
        // renderer and the warmed app renderer emit the exact same uniform[2].
        const frozenFeed = { timeMs: t, atmosphere: { weather }, seaStreakShift: state.shift };
        const fresh = createSeaState();
        resolveSeaState(frozenFeed, POST_FX_LEVELS.FULL, 0, fresh);
        resolveSeaState(frozenFeed, POST_FX_LEVELS.FULL, 0, state);
        assert.equal(fresh.uniform[2], state.uniform[2]);
        assert.equal(fresh.uniform[2], 180);
    } finally {
        resetLookStrengths();
    }
});

// C-03 — staticMirrorRgb shifts warm building tones toward local water hue
// instead of creating muddy brown smears, and detectPilingTips finds the 14
// Harbor water pilings without false positives on the landmark bridges.
test('C-03: staticMirrorRgb retains cool water hue and detectPilingTips finds Harbor pilings cleanly', () => {
    const shallow = COAST_WATER_STOPS[1];
    const warmTimber = [176, 118, 64];
    const mirrored = staticMirrorRgb(shallow, warmTimber, 0.68, false);
    // Cool shallow water has B > R; water-tinted mirror must stay cool (B >= R - 6), not brown.
    assert.ok(mirrored[2] >= mirrored[0] - 6, `expected cool water-tinted mirror, got rgb(${mirrored.join(',')})`);
    // Lit reflections preserve warm lamp colour.
    const lit = staticMirrorRgb(shallow, [255, 192, 96], 0.68, true);
    assert.ok(lit[0] > lit[2] + 30, `expected warm lit reflection, got rgb(${lit.join(',')})`);

    const loadPng = (rel) => {
        const png = PNG.sync.read(readFileSync(new URL(rel, ASSET_ROOT)));
        return { w: png.width, h: png.height, data: png.data };
    };
    const harborTips = detectPilingTips(loadPng('buildings/building.harbor/base.png'));
    // 14 water-standing pier pilings + 1 dry quay lamp post (filtered by onWater in CoastBake).
    assert.equal(harborTips.length, 15, `expected 15 candidate tips on harbor, got ${harborTips.length}`);
    assert.equal(detectPilingTips(loadPng('bridges/bridge.landmark.civic.ns.png')).length, 0);
    assert.equal(detectPilingTips(loadPng('bridges/bridge.landmark.rustic.ns.png')).length, 0);
});

// C-03 — NW/NE back-shore ocean seeding must extend past MAP_SIZE in the
// padded coast field so no fake land edge shoots NW out of the SW bastion
// corner or NE out of the SE cliff.
test('C-03: coast field stays deep open water past SW bastion and SE corners', () => {
    const field = getCoastField({ world: { buildings: new Map() }, waterTiles: new Set() });
    // 2.5 tiles NW of the SW corner (v around MAP_SIZE - 0.5): must stay > 1.8 tiles from land.
    for (const v of [MAP_SIZE - 2, MAP_SIZE - 1, MAP_SIZE - 0.5, MAP_SIZE, MAP_SIZE + 1]) {
        const sd = field.signedDistance(-2.5, v);
        assert.ok(sd > 1.8, `expected open water off SW corner at (-2.5, ${v}), got sd=${sd}`);
    }
    // Symmetric check off the SE corner along v = -2.5.
    for (const u of [MAP_SIZE - 2, MAP_SIZE - 1, MAP_SIZE - 0.5, MAP_SIZE, MAP_SIZE + 1]) {
        const sd = field.signedDistance(u, -2.5);
        assert.ok(sd > 1.8, `expected open water off SE corner at (${u}, -2.5), got sd=${sd}`);
    }
});

function createFakeCanvas(width = 0, height = 0) {
    const canvas = {
        width,
        height,
        data: new Uint8ClampedArray(width * height * 4),
    };
    const ensure = () => {
        const need = canvas.width * canvas.height * 4;
        if (canvas.data.length !== need) canvas.data = new Uint8ClampedArray(need);
    };
    const ctx = {
        canvas,
        imageSmoothingEnabled: false,
        save() {},
        restore() {},
        drawImage() {},
        getTransform() { return { a: 2, d: 2, e: 0, f: 0 }; },
        createImageData(iw, ih) { return { width: iw, height: ih, data: new Uint8ClampedArray(iw * ih * 4) }; },
        getImageData(sx = 0, sy = 0, sw = canvas.width, sh = canvas.height) {
            ensure();
            const out = new Uint8ClampedArray(sw * sh * 4);
            for (let y = 0; y < sh; y++) {
                const row = (sy + y) * canvas.width;
                for (let x = 0; x < sw; x++) {
                    const si = (row + sx + x) * 4;
                    const di = (y * sw + x) * 4;
                    out[di] = canvas.data[si];
                    out[di + 1] = canvas.data[si + 1];
                    out[di + 2] = canvas.data[si + 2];
                    out[di + 3] = canvas.data[si + 3];
                }
            }
            return { width: sw, height: sh, data: out };
        },
        putImageData(img) {
            ensure();
            canvas.data = new Uint8ClampedArray(img.data);
        },
    };
    canvas.getContext = () => ctx;
    return canvas;
}

test('Canvas caustics read _shadeFieldState.ready.field without throwing and mask shaded stop-2 river texels', () => {
    const origDoc = globalThis.document;
    const origImageData = globalThis.ImageData;
    globalThis.document = { createElement: () => createFakeCanvas(0, 0) };
    globalThis.ImageData = class FakeImageData {
        constructor(w, h) { this.width = w; this.height = h; this.data = new Uint8ClampedArray(w * h * 4); }
    };
    try {
        const tw = 32;
        const th = 32;
        const terrain = createFakeCanvas(tw, th);
        const stop2 = COAST_PALETTE.stops[2];
        for (let i = 0; i < tw * th; i++) {
            terrain.data[i * 4] = stop2[0];
            terrain.data[i * 4 + 1] = stop2[1];
            terrain.data[i * 4 + 2] = stop2[2];
            terrain.data[i * 4 + 3] = 255;
        }
        const cols = tw / 2;
        const rows = th / 2;
        const coastField = new Uint8Array(cols * rows * 2);
        for (let cell = 0; cell < cols * rows; cell++) {
            coastField[cell * 2] = 128 + 32;
            // Non-sea water (river/lagoon) so stop-2 texels enter the caustic list.
            coastField[cell * 2 + 1] = COAST_FIELD_FLAGS.water;
        }
        // Shade the left half (x < 16) and leave the right half (x >= 16) sunlit.
        const shadeCols = tw / 2;
        const shadeRows = th;
        const shadeData = new Uint8Array(shadeCols * shadeRows * 2);
        for (let r = 0; r < shadeRows; r++) {
            for (let c = 0; c < shadeCols / 2; c++) {
                shadeData[(r * shadeCols + c) * 2 + 1] = 255;
            }
        }
        const renderer = {
            terrainCache: terrain,
            terrainCacheBounds: { x: 0, y: 0 },
            terrainCacheKey: 'canvas-caustic-test',
            _coastBake: {
                waterFields: {
                    revision: 1,
                    x: 0,
                    y: 0,
                    cols,
                    rows,
                    cycleOffset: new Uint8Array(cols * rows).fill(255),
                    coastField,
                },
            },
            _shadeFieldState: {
                ready: {
                    key: 's1',
                    fieldKey: 'f1',
                    revision: 1,
                    canvas: {},
                    field: { originX: 0, originY: 0, cellW: 2, cellH: 1, cols: shadeCols, rows: shadeRows, data: shadeData },
                },
            },
            camera: { zoom: 2 },
            motionScale: 1,
            motionTimeMs: 0,
            postFx: { isActive: () => false },
        };
        const clear = { type: 'clear', cloudCover: 0.08, fog: 0, intensity: 0.18 };
        const grade = evaluateGrade({ minuteOfDay: 12 * 60, weather: clear, moonFill: 0.5 });
        const atmosphere = { weather: clear, lightGrade: grade };
        const target = createFakeCanvas(tw * 2, th * 2);

        assert.doesNotThrow(() => drawCanvasWaterState(target.getContext('2d'), renderer, atmosphere));

        const state = renderer._canvasWater;
        const overlay = state.overlay;
        const list = state.base.caustic[0];
        assert.ok(list.length > 0, 'stop-2 river caustic texels exist');
        let shadedHidden = 0;
        let sunlitPainted = 0;
        const caustic2 = state.palette.caustics[2];
        for (const i of list) {
            const x = i % tw;
            const y = (i / tw) | 0;
            const p = (y - overlay.y) * overlay.canvas.width + (x - overlay.x);
            const px = overlay.u32[p];
            if (x < 16) {
                assert.notEqual(px, caustic2, `shaded stop-2 texel (${x},${y}) should not draw caustic`);
                shadedHidden++;
            } else {
                assert.equal(px, caustic2, `sunlit stop-2 texel (${x},${y}) should draw caustic`);
                sunlitPainted++;
            }
        }
        assert.ok(shadedHidden > 0 && sunlitPainted > 0, `expected both shaded (${shadedHidden}) and sunlit (${sunlitPainted}) caustic texels`);
    } finally {
        globalThis.document = origDoc;
        globalThis.ImageData = origImageData;
    }
});

test('Canvas water mood reads _coastBake.waterFields so sea-shelf mirrors lift with seaLift', () => {
    const origDoc = globalThis.document;
    const origImageData = globalThis.ImageData;
    globalThis.document = { createElement: () => createFakeCanvas(0, 0) };
    globalThis.ImageData = class FakeImageData {
        constructor(w, h) { this.width = w; this.height = h; this.data = new Uint8ClampedArray(w * h * 4); }
    };
    try {
        const makeRenderer = () => {
            const terrain = createFakeCanvas(2, 2);
            // Warm timber mirror colour (not watery) over a sea-shelf water cell (sd = 1.5 > 0.8).
            for (let i = 0; i < 4; i++) {
                terrain.data[i * 4] = 96;
                terrain.data[i * 4 + 1] = 84;
                terrain.data[i * 4 + 2] = 74;
                terrain.data[i * 4 + 3] = 255;
            }
            const coastField = new Uint8Array(2);
            coastField[0] = Math.round(1.5 * 64) + 128;
            coastField[1] = COAST_FIELD_FLAGS.water | COAST_FIELD_FLAGS.sea;
            return {
                terrainCache: terrain,
                terrainCacheBounds: { x: 0, y: 0 },
                terrainCacheKey: 'mirror-shelf-test',
                // Deliberately omit renderer.waterFields; only _coastBake.waterFields exists at runtime.
                _coastBake: {
                    coast: {
                        x: 0,
                        y: 0,
                        cols: 1,
                        rows: 1,
                        classes: new Uint8Array([4]),
                        reflect: new Uint8Array([1]),
                        covered: new Uint8Array([0]),
                        // mirrorBase stores stop + 1; stop 4 (deepWater[1]) is below open-sea stop 5
                        // at (0,0) so lifting relies on the sea-shelf path (mirrorSea === 1).
                        mirrorBase: new Uint8Array([5, 5, 5, 5]),
                    },
                    waterFields: { revision: 1, x: 0, y: 0, cols: 1, rows: 1, coastField },
                },
                postFx: { isActive: () => false },
            };
        };
        const clear = { type: 'clear', cloudCover: 0.08, fog: 0, intensity: 0.18 };
        const grade = evaluateGrade({ minuteOfDay: 12 * 60, weather: clear, moonFill: 0.5 });
        const target = createFakeCanvas(4, 4);

        const rLit = makeRenderer();
        drawCanvasWaterMood(target.getContext('2d'), rLit, { weather: clear, lightGrade: grade, sky: { sun: { elevationDeg: 60 } } });
        assert.equal(rLit._coastMoodLayer.mirrorSea[0], 1, 'shelf mirror cell flagged from _coastBake.waterFields');

        const rNoLift = makeRenderer();
        drawCanvasWaterMood(target.getContext('2d'), rNoLift, { weather: clear, lightGrade: grade, sky: { sun: { elevationDeg: 0 } } });
        assert.ok(rLit._coastMoodLayer.canvas.data[0] > rNoLift._coastMoodLayer.canvas.data[0],
            `expected sea-shelf mirror R to lift under noon seaLift (${rNoLift._coastMoodLayer.canvas.data[0]} -> ${rLit._coastMoodLayer.canvas.data[0]})`);
    } finally {
        globalThis.document = origDoc;
        globalThis.ImageData = origImageData;
    }
});
