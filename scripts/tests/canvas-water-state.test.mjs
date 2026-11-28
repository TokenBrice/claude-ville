import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
    COAST_FIELD_FLAGS,
    COAST_PALETTE,
    OCEAN_HORIZON_WORLD_Y,
    SEA_FRESNEL_Y,
    drawOuterOcean,
} from '../../claudeville/src/presentation/character-mode/CoastBake.js';
import { drawCanvasWaterState } from '../../claudeville/src/presentation/character-mode/CanvasWaterState.js';
import { evaluateGrade } from '../../claudeville/src/presentation/character-mode/GradeEvaluator.js';
import { surfGlowBloomNight } from '../../claudeville/src/presentation/character-mode/gpu/GpuFrameState.js';
import { resetLookStrengths, setLookStrength } from '../../claudeville/src/presentation/character-mode/LookStrengths.js';

function sha256(bytes) {
    return crypto.createHash('sha256').update(bytes).digest('hex');
}

// Faithful 2D canvas stub supporting 7-arg `putImageData` dirty sub-rect uploads
// so incremental dirty-rect rebuilds can be compared byte-for-byte against fresh builds.
function createFakeCanvas(width = 0, height = 0) {
    let w = width;
    let h = height;
    const canvas = {
        get width() { return w; },
        set width(v) {
            w = Math.max(0, v | 0);
            canvas.data = new Uint8ClampedArray(w * h * 4);
            canvas.resizes++;
        },
        get height() { return h; },
        set height(v) {
            h = Math.max(0, v | 0);
            canvas.data = new Uint8ClampedArray(w * h * 4);
            canvas.resizes++;
        },
        data: new Uint8ClampedArray(width * height * 4),
        resizes: 0,
        putCalls: 0,
        putPixels: 0,
    };
    let transform = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
    const stack = [];
    const ctx = {
        canvas,
        imageSmoothingEnabled: false,
        globalCompositeOperation: 'source-over',
        globalAlpha: 1,
        fillStyle: '#000',
        save() { stack.push({ ...transform, op: ctx.globalCompositeOperation, alpha: ctx.globalAlpha }); },
        restore() {
            const s = stack.pop();
            if (s) {
                transform = { a: s.a, b: s.b, c: s.c, d: s.d, e: s.e, f: s.f };
                ctx.globalCompositeOperation = s.op;
                ctx.globalAlpha = s.alpha;
            }
        },
        setTransform(a, b, c, d, e, f) { transform = { a, b, c, d, e, f }; },
        getTransform() { return { ...transform }; },
        clearRect(x, y, rw, rh) {
            const x0 = Math.max(0, Math.floor(x));
            const y0 = Math.max(0, Math.floor(y));
            const x1 = Math.min(w, Math.ceil(x + rw));
            const y1 = Math.min(h, Math.ceil(y + rh));
            for (let py = y0; py < y1; py++) {
                canvas.data.fill(0, (py * w + x0) * 4, (py * w + x1) * 4);
            }
        },
        fillRect() {},
        createImageData(iw, ih) { return new ImageData(iw, ih); },
        createPattern() { return { setTransform() {} }; },
        drawImage() {},
        getImageData(sx = 0, sy = 0, sw = w, sh = h) {
            const out = new Uint8ClampedArray(sw * sh * 4);
            for (let row = 0; row < sh; row++) {
                const srcY = sy + row;
                if (srcY < 0 || srcY >= h) continue;
                const srcStart = (srcY * w + sx) * 4;
                out.set(canvas.data.subarray(srcStart, srcStart + sw * 4), row * sw * 4);
            }
            return { width: sw, height: sh, data: out };
        },
        putImageData(image, dx = 0, dy = 0, dirtyX, dirtyY, dirtyW, dirtyH) {
            const iw = image.width;
            const ih = image.height;
            const sx0 = dirtyX !== undefined ? Math.max(0, dirtyX | 0) : 0;
            const sy0 = dirtyY !== undefined ? Math.max(0, dirtyY | 0) : 0;
            const sx1 = dirtyW !== undefined ? Math.min(iw, sx0 + (dirtyW | 0)) : iw;
            const sy1 = dirtyH !== undefined ? Math.min(ih, sy0 + (dirtyH | 0)) : ih;
            canvas.putCalls++;
            canvas.putPixels += Math.max(0, sx1 - sx0) * Math.max(0, sy1 - sy0);
            for (let sy = sy0; sy < sy1; sy++) {
                const ty = (dy | 0) + sy;
                if (ty < 0 || ty >= h) continue;
                const tx0 = (dx | 0) + sx0;
                const tx1 = (dx | 0) + sx1;
                const cl0 = Math.max(0, tx0);
                const cl1 = Math.min(w, tx1);
                if (cl0 >= cl1) continue;
                const srcOff = (sy * iw + (cl0 - (dx | 0))) * 4;
                const dstOff = (ty * w + cl0) * 4;
                canvas.data.set(image.data.subarray(srcOff, srcOff + (cl1 - cl0) * 4), dstOff);
            }
        },
    };
    canvas.getContext = () => ctx;
    return canvas;
}

function withFakeDom(fn) {
    const origDoc = globalThis.document;
    const origImg = globalThis.ImageData;
    const origMat = globalThis.DOMMatrix;
    globalThis.document = { createElement: () => createFakeCanvas(0, 0) };
    globalThis.ImageData = class FakeImageData {
        constructor(w, h) {
            this.width = w;
            this.height = h;
            this.data = new Uint8ClampedArray(w * h * 4);
        }
    };
    globalThis.DOMMatrix = class FakeDOMMatrix { constructor(init) { this.init = init; } };
    try {
        return fn();
    } finally {
        globalThis.document = origDoc;
        globalThis.ImageData = origImg;
        globalThis.DOMMatrix = origMat;
    }
}

// Synthetic terrain fixture covering dry land, beach, shallow/deep water,
// lagoon still water, river threads, collars, eddies, reflection ripples,
// swash bands, and surrounding open sea.
function makeWaterFixture({
    bx = 0,
    by = 0,
    tw = 192,
    th = 160,
    motionTimeMs = 0,
    motionScale = 1,
    zoom = 1,
    lights = [],
} = {}) {
    const terrain = createFakeCanvas(tw, th);
    const cols = tw >> 1;
    const rows = th >> 1;
    const cycleOffset = new Uint8Array(cols * rows).fill(255);
    const coastField = new Uint8Array(cols * rows * 2);

    const paint = (tx, ty, rgb) => {
        const p = (ty * tw + tx) * 4;
        terrain.data[p] = rgb[0];
        terrain.data[p + 1] = rgb[1];
        terrain.data[p + 2] = rgb[2];
        terrain.data[p + 3] = 255;
    };

    for (let ty = 0; ty < th; ty++) {
        for (let tx = 0; tx < tw; tx++) {
            if (tx < 36) {
                // Dry dark land (non-beach) on the far west.
                paint(tx, ty, [60, 74, 52]);
            } else if (tx < 48) {
                // Warm beach sand strip.
                paint(tx, ty, [206, 182, 134]);
            } else if (tx < 64) {
                // Shallow stop 0-1 + swash band.
                paint(tx, ty, COAST_PALETTE.stops[tx < 56 ? 0 : 1]);
            } else if (tx < 112) {
                // Mid stops 2-3 (near shore + lagoon in north half + reflection mirror band).
                if (ty >= 24 && ty < 48 && tx >= 76 && tx < 96) {
                    // Mirrored timber/water alternating strips so reflection ripples fire.
                    paint(tx, ty, (tx & 1) ? [140, 108, 72] : COAST_PALETTE.stops[2]);
                } else {
                    paint(tx, ty, COAST_PALETTE.stops[tx < 88 ? 2 : 3]);
                }
            } else if (tx < 160) {
                // Deep sea stops 4-5.
                paint(tx, ty, COAST_PALETTE.stops[tx < 136 ? 4 : 5]);
            }
            // tx >= 160 left transparent -> open sea!
        }
    }

    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
            const cell = r * cols + c;
            const tx = c * 2;
            const ty = r * 2;
            let flags = 0;
            let sd = -1.5;
            if (tx >= 44 && tx < 68) {
                flags |= COAST_FIELD_FLAGS.swash;
                sd = (tx - 48) / 32;
            }
            if (tx >= 48 && tx < 160) {
                flags |= COAST_FIELD_FLAGS.water;
                if (tx >= 104) {
                    flags |= COAST_FIELD_FLAGS.sea;
                    sd = Math.max(sd, 1.5);
                } else if (ty < 40 && tx >= 64) {
                    flags |= COAST_FIELD_FLAGS.lagoon;
                    sd = Math.max(sd, 0.8);
                } else if (tx >= 68) {
                    sd = Math.max(sd, 0.5);
                }
            }
            if (ty >= 24 && ty < 48 && tx >= 76 && tx < 96) {
                flags |= COAST_FIELD_FLAGS.reflection;
            }
            coastField[cell * 2] = Math.max(0, Math.min(255, Math.round(sd * 64) + 128));
            coastField[cell * 2 + 1] = flags;

            if (tx >= 64 && tx < 84 && ty >= 56 && ty < 96) {
                // Near-shore course bucket
                cycleOffset[cell] = (c + r) & 15;
            } else if (tx >= 84 && tx < 92 && ty >= 60 && ty < 84) {
                // Collar cells (digit 1 in lanes -> offset 32 + 1 + 3 + 9 + 27 = 72)
                cycleOffset[cell] = 72;
            } else if (tx >= 92 && tx < 100 && ty >= 60 && ty < 84) {
                // Eddy cells
                cycleOffset[cell] = 113;
                coastField[cell * 2] = 0xff;
            } else if (tx >= 100 && tx < 108 && ty >= 60 && ty < 84) {
                // River thread
                cycleOffset[cell] = 16;
            }
        }
    }

    return {
        terrainCache: terrain,
        terrainCacheBounds: { x: bx, y: by },
        terrainCacheKey: `fixture:${bx},${by},${tw}x${th}`,
        _coastBake: {
            waterFields: {
                revision: 1,
                x: bx,
                y: by,
                cols,
                rows,
                cycleOffset,
                coastField,
            },
        },
        _frameLightSources: { ambient: lights },
        camera: { zoom },
        motionScale,
        motionTimeMs,
        postFx: { isActive: () => false },
    };
}

function makeAtmosphere({ minuteOfDay = 23.5 * 60, weather = { type: 'clear', cloudCover: 0.05, fog: 0, windX: 0.35, seed: 42 }, moonFill = 0.85, glint = null } = {}) {
    const grade = evaluateGrade({ minuteOfDay, weather, moonFill });
    const atm = {
        weather,
        lightGrade: grade,
        lighting: {
            moonFill,
            beaconIntensity: minuteOfDay > 19 * 60 || minuteOfDay < 6 * 60 ? 1 : 0,
            localLightPhase: minuteOfDay > 19 * 60 || minuteOfDay < 6 * 60 ? 1 : 0,
        },
        solar: { elevationDeg: minuteOfDay > 8 * 60 && minuteOfDay < 16 * 60 ? 45 : -25 },
        sky: {
            moon: { visible: minuteOfDay > 19 * 60 || minuteOfDay < 6 * 60, fill: moonFill, xFrac: 0.55, yFrac: 0.25 },
            sun: { visible: minuteOfDay > 8 * 60 && minuteOfDay < 16 * 60, xFrac: 0.45, yFrac: 0.25 },
        },
    };
    if (glint) atm._glintOverride = glint;
    return atm;
}

function settleState(ctx, renderer, atmosphere, viewOrigin = [0, 0], maxSteps = 60) {
    // Freeze wall-clock budget checks during deterministic test settling so
    // parallel CI load never truncates cold/swap completion (the dedicated
    // slicing test drives a synthetic advancing clock directly).
    const origNow = performance.now;
    performance.now = () => 0;
    try {
        for (let i = 0; i < maxSteps; i++) {
            ctx.setTransform(1, 0, 0, 1, -viewOrigin[0], -viewOrigin[1]);
            drawCanvasWaterState(ctx, renderer, atmosphere);
            const w = renderer._canvasWater;
            if (w && !w.capWork && !w.nextCaps && !w.nextCapWork && w.stats.capsPending === 0 && w.stats.chunksPending === 0) {
                return i + 1;
            }
        }
        return maxSteps;
    } finally {
        performance.now = origNow;
    }
}

test('CanvasWaterState 1A: instrumentation populates and exact-input gating skips unused clocks', () => withFakeDom(() => {
    const renderer = makeWaterFixture({ motionTimeMs: 0 });
    const target = createFakeCanvas(320, 224);
    const ctx = target.getContext('2d');
    const clearNight = makeAtmosphere({ minuteOfDay: 23.5 * 60, weather: { type: 'clear', cloudCover: 0.02, fog: 0, windX: 0, seed: 1 } });

    settleState(ctx, renderer, clearNight);
    const w = renderer._canvasWater;
    assert.ok(w.stats.overlayArea > 0);
    assert.ok(w.stats.overlayDirtyArea > 0);
    assert.ok(w.stats.overlayParts && typeof w.stats.overlayParts.deepMs === 'number');
    assert.ok(w.stats.overlayReasons && typeof w.stats.overlayReasons.deep === 'number');
    assert.equal(w.stats.capsPending, 0);
    assert.equal(w.stats.chunksPending, 0);

    // Advance from t=140ms to t=145ms: ringTick steps (Math.floor(140*0.007)=0 -> Math.floor(145*0.007)=1),
    // while deepTick (0.006 -> 0), nearTick (0.004 -> 0), rippleTick (0.002 -> 0),
    // collar (t/300 -> 0), eddy (0.003 -> 0), swashStep (0.005 -> 0), gust (125ms -> 1) stay unchanged.
    renderer.motionTimeMs = 140;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    drawCanvasWaterState(ctx, renderer, clearNight);
    const buildsBefore = w.stats.overlayBuilds;
    const ringReasonsBefore = w.stats.overlayReasons.ring;

    renderer.motionTimeMs = 145;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    drawCanvasWaterState(ctx, renderer, clearNight);
    assert.equal(w.stats.overlayBuilds, buildsBefore, 'clear weather ringTick must not rebuild overlay');
    assert.equal(w.stats.overlayReasons.ring, ringReasonsBefore, 'clear weather must record zero ring rebuild reasons');

    // Daytime glint xFrac shift must NOT rebuild overlay (starlight is off by day).
    const clearDay = makeAtmosphere({ minuteOfDay: 12 * 60, weather: { type: 'clear', cloudCover: 0.05, fog: 0, windX: 0, seed: 1 } });
    renderer.motionTimeMs = 140;
    settleState(ctx, renderer, clearDay);
    const dayBuilds = w.stats.overlayBuilds;
    clearDay.sky.sun.xFrac = 0.62;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    drawCanvasWaterState(ctx, renderer, clearDay);
    assert.equal(w.stats.overlayBuilds, dayBuilds, 'daytime sun xFrac move must not rebuild overlay');
}));

test('CanvasWaterState 1A: moon path skips rebuild when overlay mask over path is unchanged, rebuilds on overlap', () => withFakeDom(() => {
    const renderer = makeWaterFixture({ bx: 0, by: 0, tw: 256, th: 192, motionTimeMs: 0 });
    const target = createFakeCanvas(384, 256);
    const ctx = target.getContext('2d');
    const night = makeAtmosphere({ minuteOfDay: 23.5 * 60, weather: { type: 'clear', cloudCover: 0.02, fog: 0, windX: 0, seed: 1 }, moonFill: 0.9 });
    // Put moon road far east over open sea (xFrac = 0.85 -> x ≈ 326), away from west shore collar/swash (x < 100).
    night.sky.moon.xFrac = 0.85;

    settleState(ctx, renderer, night);
    const w = renderer._canvasWater;
    assert.ok(w.pathLive, 'moon path should be active at clear night');
    const pathX = w.path.x;
    assert.ok(pathX > 150, `expected moon path over eastern open sea, got x=${pathX}`);

    // Step across swash/collar/eddy without changing deepTick:
    // t=200ms -> t=310ms: deepTick stays floor(200*0.006)=1 and floor(310*0.006)=1,
    // while collar (floor(t/300): 0 -> 1) and swashStep (floor(t*0.005): 1 -> 1) trigger mask change ONLY in collarBounds (x in 84..92).
    renderer.motionTimeMs = 200;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    drawCanvasWaterState(ctx, renderer, night);
    const pathBuildsAfter200 = w.stats.pathBuilds;
    const pathSkipsAfter200 = w.stats.pathSkips;
    const ovBuildsAfter200 = w.stats.overlayBuilds;

    renderer.motionTimeMs = 310;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    drawCanvasWaterState(ctx, renderer, night);
    assert.ok(w.stats.overlayBuilds > ovBuildsAfter200, 'collar step should rebuild overlay');
    assert.equal(w.stats.pathBuilds, pathBuildsAfter200, 'non-overlapping collar mask change must skip path rebuild');
    assert.ok(w.stats.pathSkips > pathSkipsAfter200, 'pathSkips should increment');

    // Now move moon road directly over the collar/swash zone (xFrac = 0.22 -> x ≈ 84).
    night.sky.moon.xFrac = 0.22;
    renderer.motionTimeMs = 200;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    drawCanvasWaterState(ctx, renderer, night);
    const overlapBuildsBefore = w.stats.pathBuilds;

    // Step t=200ms -> t=310ms again (deepTick still 1, collar flips 0 -> 1 directly inside path rect!).
    renderer.motionTimeMs = 310;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    drawCanvasWaterState(ctx, renderer, night);
    assert.equal(w.stats.pathBuilds, overlapBuildsBefore + 1, 'overlapping collar mask change must rebuild path');

    // Verify exact byte parity against a completely fresh renderer at t=310ms.
    const fresh = makeWaterFixture({ bx: 0, by: 0, tw: 256, th: 192, motionTimeMs: 310 });
    const freshTarget = createFakeCanvas(384, 256);
    settleState(freshTarget.getContext('2d'), fresh, night);
    assert.equal(sha256(w.path.canvas.data), sha256(fresh._canvasWater.path.canvas.data), 'moon path pixels must match fresh rebuild');
}));

test('CanvasWaterState 1A: incremental dirty-rect overlay rebuilds (incl. transparent clears) match fresh full rebuilds byte-for-byte', () => withFakeDom(() => {
    const scenarios = [
        {
            name: 'night-clear',
            atm: makeAtmosphere({ minuteOfDay: 23.5 * 60, weather: { type: 'clear', cloudCover: 0.04, fog: 0, windX: 0.35, seed: 42 }, moonFill: 0.9 }),
            times: [0, 125, 167, 250, 300, 334, 420, 500, 625, 950],
        },
        {
            name: 'storm-rain',
            atm: makeAtmosphere({ minuteOfDay: 15.0 * 60, weather: { type: 'storm', cloudCover: 0.92, fog: 0.2, windX: -0.6, intensity: 0.85, seed: 77 }, moonFill: 0.1 }),
            times: [0, 125, 143, 167, 250, 300, 500, 750],
        },
    ];

    for (const sc of scenarios) {
        const inc = makeWaterFixture({ bx: 0, by: 0, tw: 192, th: 160, motionTimeMs: 0 });
        const incCanvas = createFakeCanvas(512, 320);
        const incCtx = incCanvas.getContext('2d');
        settleState(incCtx, inc, sc.atm);

        let sawPartialDirty = false;
        for (const tMs of sc.times) {
            inc.motionTimeMs = tMs;
            settleState(incCtx, inc, sc.atm);
            const iw = inc._canvasWater;
            if (iw.stats.overlayDirtyArea > 0 && iw.stats.overlayDirtyArea < iw.stats.overlayArea) {
                sawPartialDirty = true;
            }

            const fresh = makeWaterFixture({ bx: 0, by: 0, tw: 192, th: 160, motionTimeMs: tMs });
            const freshCanvas = createFakeCanvas(512, 320);
            settleState(freshCanvas.getContext('2d'), fresh, sc.atm);
            const fw = fresh._canvasWater;

            assert.equal(iw.overlay.canvas.width, fw.overlay.canvas.width, `${sc.name}@${tMs} overlay width`);
            assert.equal(iw.overlay.canvas.height, fw.overlay.canvas.height, `${sc.name}@${tMs} overlay height`);
            assert.equal(
                sha256(iw.overlay.canvas.data),
                sha256(fw.overlay.canvas.data),
                `${sc.name}@${tMs} overlay canvas pixels must match fresh full rebuild`,
            );
            assert.equal(
                sha256(iw.mask),
                sha256(fw.mask),
                `${sc.name}@${tMs} overlay mask must match fresh full rebuild`,
            );
            assert.equal(
                sha256(iw.rise),
                sha256(fw.rise),
                `${sc.name}@${tMs} overlay rise map must match fresh full rebuild`,
            );
            assert.equal(iw.capsDrift, fw.capsDrift, `${sc.name}@${tMs} capsDrift parity`);
        }
        assert.ok(sawPartialDirty, `${sc.name}: expected at least one partial dirty overlay rebuild (< full area)`);
    }
}));

test('CanvasWaterState 1A: resumable cap-chunk row slicing respects budget and swaps swell generations atomically', () => withFakeDom(() => {
    const origNow = performance.now;
    let fakeNow = 0;
    // Advance clock by 3 ms per call so `stepCapChunkBuilder` hits the 8 ms budget mid-chunk.
    performance.now = () => { fakeNow += 3; return fakeNow; };
    try {
        const renderer = makeWaterFixture({ bx: 0, by: 0, tw: 192, th: 160, motionTimeMs: 0 });
        const target = createFakeCanvas(512, 320);
        const ctx = target.getContext('2d');
        const atm = makeAtmosphere({ minuteOfDay: 23.5 * 60 });

        // First call should pause mid-chunk with capsPending > 0.
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        drawCanvasWaterState(ctx, renderer, atm);
        const w = renderer._canvasWater;
        assert.ok(w.capWork !== null || w.stats.capsPending > 0, 'budget-constrained first call should leave cap work pending');
        assert.ok(w.stats.capsPending > 0, 'capsPending must be published > 0 while cold chunks remain');

        // Drive cold chunks to completion under a finite bound.
        let steps = 0;
        while ((w.capWork || w.stats.capsPending > 0 || w.stats.chunksPending > 0) && steps < 200) {
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            drawCanvasWaterState(ctx, renderer, atm);
            steps++;
        }
        assert.ok(steps < 200, 'sliced cold cap build must finish within finite steps');
        assert.equal(w.capWork, null);
        assert.equal(w.stats.capsPending, 0);
        assert.ok(w.stats.capResumes > 0, 'expected at least one mid-chunk resume');

        const initialDrift = w.capsDrift;
        const initialCapsRef = w.caps;

        // Advance motionTimeMs past one swell-drift step (500ms per row -> 600ms advances drift by 1).
        renderer.motionTimeMs = 600;
        let sawMidSwap = false;
        let swapSteps = 0;
        while (w.capsDrift === initialDrift && swapSteps < 200) {
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            drawCanvasWaterState(ctx, renderer, atm);
            swapSteps++;
            if (w.nextCaps) {
                sawMidSwap = true;
                // While next generation is building, live `state.caps` stays strictly at `initialDrift`.
                assert.equal(w.caps, initialCapsRef, 'live caps Map must not be mutated/replaced before atomic swap');
                assert.equal(w.capsDrift, initialDrift);
                assert.ok(w.stats.nextCapsPending > 0 || w.nextCapWork !== null);
            }
        }
        assert.ok(sawMidSwap, 'expected multi-frame background build of nextCaps');
        assert.notEqual(w.capsDrift, initialDrift, 'swell generation must swap once complete');
        assert.equal(w.nextCaps, null);
        assert.equal(w.nextCapWork, null);
        assert.equal(w.capWork, null);
        assert.equal(w.stats.capsPending, 0);
        assert.equal(w.stats.nextCapsPending, 0);
        assert.ok(w.stats.capSwaps >= 1);

        // Compare final swapped overlay against an unsliced fresh build at t=600ms.
        performance.now = origNow;
        const fresh = makeWaterFixture({ bx: 0, by: 0, tw: 192, th: 160, motionTimeMs: 600 });
        const freshCanvas = createFakeCanvas(512, 320);
        settleState(freshCanvas.getContext('2d'), fresh, atm);
        assert.equal(sha256(w.overlay.canvas.data), sha256(fresh._canvasWater.overlay.canvas.data), 'atomic swapped overlay must match fresh unsliced build');
    } finally {
        performance.now = origNow;
    }
}));

test('CanvasWaterState 1A: lamp columns cull dry-land lights, reuse stable backing with sparse uploads, and match fresh pixels', () => withFakeDom(() => {
    const dryLight = { id: 'dry-1', role: 'fixture', x: 14, y: 20, height: 18, radius: 24, intensity: 1, color: '#ffbe66' };
    const waterLightA = { id: 'shore-a', role: 'fixture', x: 72, y: 20, height: 20, radius: 56, intensity: 1.2, color: '#ffbe66' };
    const waterLightB = { id: 'shore-b', role: 'fixture', x: 118, y: 36, height: 22, radius: 60, intensity: 1.1, color: '#ffd580' };

    const renderer = makeWaterFixture({ bx: 0, by: 0, tw: 192, th: 160, motionTimeMs: 0, lights: [dryLight, waterLightA, waterLightB] });
    const target = createFakeCanvas(320, 224);
    const ctx = target.getContext('2d');
    const night = makeAtmosphere({ minuteOfDay: 23.5 * 60 });

    settleState(ctx, renderer, night);
    const w = renderer._canvasWater;
    assert.equal(w.stats.columns, 3);
    assert.equal(w.stats.activeColumns, 2, 'dry-land light must be culled by recvGrid');
    assert.ok(w.columnsLive && w.columns.canvas && w.columns.contentBounds);

    // Mutating ONLY the dry-land light must NOT trigger a column rebuild.
    const colBuilds0 = w.stats.columnBuilds;
    dryLight.intensity = 2.5;
    dryLight.x = 12;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    drawCanvasWaterState(ctx, renderer, night);
    assert.equal(w.stats.columnBuilds, colBuilds0, 'dry-land light change must not rebuild columns');

    // Step across multiple 4 Hz column ticks (250ms each) and confirm:
    // (a) stable column canvas never resizes, (b) sparse dirty upload matches fresh full build byte-for-byte.
    const resizesBefore = w.columns.canvas.resizes;
    for (const tMs of [250, 500, 750, 1000]) {
        renderer.motionTimeMs = tMs;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        drawCanvasWaterState(ctx, renderer, night);
        assert.equal(w.columns.canvas.resizes, resizesBefore, `columns canvas must not resize on 4 Hz tick t=${tMs}`);

        const fresh = makeWaterFixture({ bx: 0, by: 0, tw: 192, th: 160, motionTimeMs: tMs, lights: [dryLight, waterLightA, waterLightB] });
        const freshTarget = createFakeCanvas(320, 224);
        settleState(freshTarget.getContext('2d'), fresh, night);
        const fw = fresh._canvasWater;

        assert.equal(w.columnsLive, fw.columnsLive, `columnsLive parity at t=${tMs}`);
        if (w.columnsLive) {
            assert.deepEqual(w.columns.contentBounds, fw.columns.contentBounds, `contentBounds parity at t=${tMs}`);
            assert.equal(w.columns.x, fw.columns.x);
            assert.equal(w.columns.y, fw.columns.y);
            assert.equal(
                sha256(w.columns.canvas.data),
                sha256(fw.columns.canvas.data),
                `sparse column canvas pixels must match fresh rebuild at t=${tMs}`,
            );
        }
    }
}));

test('CanvasWaterState 1A: caches remain bounded across repeated camera pans and paused off-screen work is dropped', () => withFakeDom(() => {
    const renderer = makeWaterFixture({ bx: 0, by: 0, tw: 192, th: 160, motionTimeMs: 0 });
    const target = createFakeCanvas(384, 192);
    const ctx = target.getContext('2d');
    const atm = makeAtmosphere({ minuteOfDay: 23.5 * 60 });

    // Pan across 24 distinct chunk windows (spanning far more than CHUNK_CACHE_MIN = 96 chunks).
    for (let step = 0; step < 30; step++) {
        const vx = step * 768;
        const vy = 0;
        renderer.motionTimeMs = step * 600;
        settleState(ctx, renderer, atm, [vx, vy], 20);
        const w = renderer._canvasWater;
        assert.ok(w.chunks.size <= 128, `deep chunks cache exceeded bound: ${w.chunks.size}`);
        assert.ok(w.caps.size <= 128, `cap chunks cache exceeded bound: ${w.caps.size}`);
        assert.ok(w.canvasPool.length <= 24, `sea canvas pool exceeded bound: ${w.canvasPool.length}`);
        assert.ok(w.columnMemo.size <= 4096, `column memo exceeded bound: ${w.columnMemo.size}`);
    }

    // Verify off-screen paused `capWork` is dropped immediately on pan.
    const origNow = performance.now;
    let fakeNow = 0;
    performance.now = () => { fakeNow += 5; return fakeNow; };
    try {
        renderer.motionTimeMs = 99900;
        ctx.setTransform(1, 0, 0, 1, -40000, 0);
        drawCanvasWaterState(ctx, renderer, atm);
        const w = renderer._canvasWater;
        const pausedId = w.capWork?.id ?? null;
        if (pausedId !== null) {
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            drawCanvasWaterState(ctx, renderer, atm);
            assert.notEqual(w.capWork?.id, pausedId, 'off-screen paused capWork must be dropped on pan');
        }
    } finally {
        performance.now = origNow;
    }
}));

test('CanvasWaterState 1A: daytime Fresnel sea LUT and uniform-1 sunlit mask stay exact across horizon and Fresnel seams', () => withFakeDom(() => {
    try {
        setLookStrength('sea1', 1);
        const renderer = makeWaterFixture({ bx: 0, by: 0, tw: 192, th: 160, motionTimeMs: 0 });
        const target = createFakeCanvas(384, 1024);
        const ctx = target.getContext('2d');
        const clearDay = makeAtmosphere({
            minuteOfDay: 12 * 60,
            weather: { type: 'clear', cloudCover: 0.0, fog: 0, windX: 0.2, seed: 11 },
            moonFill: 0,
        });

        // View spans from above horizon through all three SEA_FRESNEL_Y seams (96, 352, 640) and below.
        const viewTop = Math.floor(OCEAN_HORIZON_WORLD_Y) - 16;
        assert.ok(viewTop < OCEAN_HORIZON_WORLD_Y && viewTop + 1024 > SEA_FRESNEL_Y[2] + 32);

        ctx.setTransform(1, 0, 0, 1, 0, -viewTop);
        drawOuterOcean(ctx, renderer, clearDay);
        assert.ok(renderer._outerOcean?.spec?.fresnel, 'expected daytime Fresnel spec active');

        settleState(ctx, renderer, clearDay, [0, viewTop], 80);
        const w = renderer._canvasWater;
        assert.ok(w.seaLutActive && w.seaLutFresnel, 'sea Fresnel LUT should be active in daytime');
        assert.ok(w.sun.canvas, 'daytime sunlit course should be built');

        // Advancing time without stepping swellDrift must NOT rebuild uniform-1 sun layer.
        const sunBuilds0 = w.stats.sunBuilds;
        renderer.motionTimeMs = 150;
        ctx.setTransform(1, 0, 0, 1, 0, -viewTop);
        drawCanvasWaterState(ctx, renderer, clearDay);
        assert.equal(w.stats.sunBuilds, sunBuilds0, 'uniform-1 clear sunlit mask drift must not rebuild sun layer');
    } finally {
        resetLookStrengths();
    }
}));

test('CanvasWaterState 1A: sea canvas pool caps near 24, reuses warm canvases, and releases overflow backing on zoom/pan', () => withFakeDom(() => {
    const createdCanvases = [];
    const origCreate = globalThis.document.createElement;
    globalThis.document.createElement = (tag) => {
        const c = origCreate(tag);
        createdCanvases.push(c);
        return c;
    };
    try {
        // Wide view covering ~7x6 = 42 open-sea chunks (well above SEA_CANVAS_POOL_MAX = 24).
        const renderer = makeWaterFixture({ bx: 0, by: 0, tw: 192, th: 160, motionTimeMs: 0 });
        const wide = createFakeCanvas(2496, 1152);
        const wideCtx = wide.getContext('2d');
        const night = makeAtmosphere({ minuteOfDay: 23.5 * 60, weather: { type: 'clear', cloudCover: 0.02, fog: 0, windX: 0.2, seed: 5 } });

        // Cold build: allocates backing canvases for visible body-bearing chunks; pool stays empty.
        settleState(wideCtx, renderer, night, [0, 0], 120);
        const w = renderer._canvasWater;
        const wideLiveCount = w.seaCanvasChunks.size;
        assert.ok(wideLiveCount >= 30, `expected >= 30 wide sea canvas chunks, got ${wideLiveCount}`);
        assert.equal(w.canvasPool.length, 0, 'cold frame must leave zero idle pooled canvases');

        // Snapshot all currently active chunk body canvases.
        const wideBodyCanvases = [];
        for (const chunk of w.seaCanvasChunks) {
            if (chunk.bodyCanvas) wideBodyCanvases.push(chunk.bodyCanvas);
        }
        assert.ok(wideBodyCanvases.length >= 30, `expected >= 30 live bodyCanvas backings, got ${wideBodyCanvases.length}`);

        // Warm drift swap at wide view: stale generation recycles up to 24 into pool and reuses them
        // immediately on the new generation, releasing overflow backing stores (`width === 0 && height === 0`).
        const initialDrift = w.capsDrift;
        const createdBeforeSwap = createdCanvases.length;
        renderer.motionTimeMs = 600;
        settleState(wideCtx, renderer, night, [0, 0], 120);
        assert.notEqual(w.capsDrift, initialDrift, 'wide drift swap must complete');
        assert.ok(w.canvasPool.length <= 24, `pool must stay <= 24 after wide drift swap, got ${w.canvasPool.length}`);
        const reusedCount = wideBodyCanvases.filter(c => {
            for (const chunk of w.seaCanvasChunks) if (chunk.bodyCanvas === c) return true;
            return false;
        }).length;
        const releasedOnSwap = wideBodyCanvases.filter(c => c.width === 0 && c.height === 0).length;
        assert.ok(reusedCount >= 16, `warm swap should reuse pooled canvases, got ${reusedCount}`);
        assert.ok(releasedOnSwap > 0, `overflow canvases past pool cap must release backing, got ${releasedOnSwap}`);
        assert.ok(
            createdCanvases.length - createdBeforeSwap < wideBodyCanvases.length,
            'warm swap must allocate fewer canvases than a cold build thanks to pooling',
        );

        // Zoom in / shrink view to close viewport (snapped 512x384 -> <= 9 visible chunks):
        // pool shrinks to visible budget (<= 12, well below 24) and releases overflow backing stores immediately.
        const preZoomCanvases = [];
        for (const chunk of w.seaCanvasChunks) {
            if (chunk.bodyCanvas) preZoomCanvases.push(chunk.bodyCanvas);
        }
        const close = createFakeCanvas(384, 256);
        const closeCtx = close.getContext('2d');
        renderer.camera.zoom = 3;
        settleState(closeCtx, renderer, night, [0, 0], 40);
        assert.ok(w.canvasPool.length <= 12,
            `close-view pool should trim to small visible budget (<= 12), got ${w.canvasPool.length} (live=${w.seaCanvasChunks.size})`);
        const releasedAfterZoom = preZoomCanvases.filter(c => c.width === 0 && c.height === 0).length;
        assert.ok(releasedAfterZoom >= preZoomCanvases.length - w.seaCanvasChunks.size - w.canvasPool.length,
            `all overflow canvases after zoom-in must have released backing (${releasedAfterZoom})`);

        // Panning to a nearby close-view window reuses warm pooled canvases instead of allocating new ones.
        const poolBeforePan = w.canvasPool.length;
        const createdBeforePan = createdCanvases.length;
        assert.ok(poolBeforePan > 0, 'zoom-in should keep a small warm pool for immediate pan reuse');
        settleState(closeCtx, renderer, night, [768, 0], 40);
        assert.ok(w.canvasPool.length <= 24);
        assert.equal(createdCanvases.length, createdBeforePan, 'close-view pan should reuse warm pooled canvases without fresh allocation');
    } finally {
        globalThis.document.createElement = origCreate;
    }
}));

test('CanvasWaterState 1A: surfGlow toggling on (isolated and alongside unrelated dirty) repaints all swashBounds cleanly', () => withFakeDom(() => {
    // Pick a deterministic summer night where `surfGlowBloomNight(date)` is true.
    let bloomDate = null;
    for (let day = 1; day <= 31; day++) {
        const d = new Date(2026, 6, day, 23, 30);
        if (surfGlowBloomNight(d)) { bloomDate = d; break; }
    }
    assert.ok(bloomDate, 'expected at least one summer surf-glow bloom night in July');

    const makeGlowAtm = () => {
        const weather = { type: 'clear', cloudCover: 0.02, fog: 0, windX: 0, seed: 9 };
        const atm = makeAtmosphere({ minuteOfDay: 23.5 * 60, weather, moonFill: 0 });
        atm.effectiveDate = bloomDate;
        atm.sky.starsAlpha = 0;
        atm.sky.moon.visible = false;
        return atm;
    };

    const countLitGlow = (canvas) => {
        if (!canvas?.data) return 0;
        let n = 0;
        for (let i = 3; i < canvas.data.length; i += 4) if (canvas.data[i] > 0) n++;
        return n;
    };

    try {
        // Case 1: surfGlow toggles OFF -> ON with NO other dirty reason.
        setLookStrength('bi8', 0);
        const atm = makeGlowAtm();
        const r1 = makeWaterFixture({ bx: 0, by: 0, tw: 192, th: 160, motionTimeMs: 200 });
        const t1 = createFakeCanvas(320, 224);
        const ctx1 = t1.getContext('2d');
        settleState(ctx1, r1, atm);
        const w1 = r1._canvasWater;
        assert.equal(w1.glowLive, false);
        assert.equal(w1.glowDraw, false);

        // Toggle bi8 ON at exact same motionTimeMs (zero other overlay tokens change).
        setLookStrength('bi8', 1);
        ctx1.setTransform(1, 0, 0, 1, 0, 0);
        drawCanvasWaterState(ctx1, r1, atm);
        assert.deepEqual(w1.stats.overlayLastReasons, ['surfGlow'], 'only surfGlow reason should fire');
        assert.equal(w1.glowLive, true, 'isolated surfGlow toggle-on must activate glowLive');
        assert.equal(w1.glowDraw, true, 'isolated surfGlow toggle-on must activate glowDraw');
        const lit1 = countLitGlow(w1.glow.canvas);
        assert.ok(lit1 > 0, `expected > 0 glowing swash pixels after isolated toggle-on, got ${lit1}`);

        const fresh1 = makeWaterFixture({ bx: 0, by: 0, tw: 192, th: 160, motionTimeMs: 200 });
        settleState(createFakeCanvas(320, 224).getContext('2d'), fresh1, atm);
        assert.equal(
            sha256(w1.glow.canvas.data),
            sha256(fresh1._canvasWater.glow.canvas.data),
            'isolated surfGlow toggle-on glow canvas must match fresh full rebuild byte-for-byte',
        );

        // Case 2: surfGlow toggles OFF -> ON alongside ONLY a small disjoint dirty rect (collar step).
        // Fixture swashBounds is x in [44..68), y in [0..160); collarBounds is x in [84..92), y in [60..84) (disjoint).
        setLookStrength('bi8', 0);
        const r2 = makeWaterFixture({ bx: 0, by: 0, tw: 192, th: 160, motionTimeMs: 250 });
        const t2 = createFakeCanvas(320, 224);
        const ctx2 = t2.getContext('2d');
        settleState(ctx2, r2, atm);
        const w2 = r2._canvasWater;
        assert.equal(w2.glowLive, false);

        // Advance 250ms -> 310ms: collar flips (0 -> 1), while swashStep (floor(t*0.0048)=1),
        // deepTick (1), nearTick (1), rippleTick (0), eddy (0) remain constant.
        setLookStrength('bi8', 1);
        r2.motionTimeMs = 310;
        ctx2.setTransform(1, 0, 0, 1, 0, 0);
        drawCanvasWaterState(ctx2, r2, atm);
        assert.ok(w2.stats.overlayLastReasons.includes('collar'), 'collar should be dirty');
        assert.ok(w2.stats.overlayLastReasons.includes('surfGlow'), 'surfGlow should be dirty');
        assert.ok(!w2.stats.overlayLastReasons.includes('swash'), 'swashStep itself did not change');
        assert.equal(w2.glowLive, true);
        assert.equal(w2.glowDraw, true);

        const fresh2 = makeWaterFixture({ bx: 0, by: 0, tw: 192, th: 160, motionTimeMs: 310 });
        settleState(createFakeCanvas(320, 224).getContext('2d'), fresh2, atm);
        assert.equal(
            sha256(w2.glow.canvas.data),
            sha256(fresh2._canvasWater.glow.canvas.data),
            'surfGlow toggle-on with disjoint collar dirty rect must repaint ALL of swashBounds identically to fresh build',
        );
        assert.equal(
            sha256(w2.overlay.canvas.data),
            sha256(fresh2._canvasWater.overlay.canvas.data),
            'overlay must also match fresh rebuild byte-for-byte',
        );

        // Case 3: surfGlow ON -> OFF -> ON cycle cleanly invalidates and repaints without stale pixels.
        setLookStrength('bi8', 0);
        ctx2.setTransform(1, 0, 0, 1, 0, 0);
        drawCanvasWaterState(ctx2, r2, atm);
        assert.equal(w2.glowLive, false);
        assert.equal(w2.glowValid, false);
        assert.equal(w2.glowDraw, false);

        setLookStrength('bi8', 1);
        ctx2.setTransform(1, 0, 0, 1, 0, 0);
        drawCanvasWaterState(ctx2, r2, atm);
        assert.equal(w2.glowLive, true);
        assert.equal(w2.glowDraw, true);
        assert.equal(
            sha256(w2.glow.canvas.data),
            sha256(fresh2._canvasWater.glow.canvas.data),
            're-enabling surfGlow after off transition must match fresh rebuild byte-for-byte',
        );
    } finally {
        resetLookStrengths();
    }
}));
