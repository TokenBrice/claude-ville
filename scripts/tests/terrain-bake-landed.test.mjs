import test from 'node:test';
import assert from 'node:assert/strict';
import { IsometricRenderer } from '../../claudeville/src/presentation/character-mode/IsometricRenderer.js';

// A pixel canvas: drawImage copies a source's opaque pixels at the current
// translation and getImageData reads a rectangle, enough for the bake probes.
function pixelCanvas() {
    const canvas = { width: 0, height: 0, pixels: null };
    let tx = 0;
    let ty = 0;
    const pixels = () => {
        if (canvas.pixels?.length !== canvas.width * canvas.height * 4) canvas.pixels = new Uint8ClampedArray(canvas.width * canvas.height * 4);
        return canvas.pixels;
    };
    canvas.getContext = () => ({
        setTransform(a, b, c, d, e, f) { tx = e; ty = f; },
        drawImage(source, dx, dy) {
            const out = pixels();
            for (let y = 0; y < source.height; y++) {
                for (let x = 0; x < source.width; x++) {
                    const s = (y * source.width + x) * 4;
                    const cx = x + dx + tx;
                    const cy = y + dy + ty;
                    if (!source.pixels[s + 3] || cx < 0 || cy < 0 || cx >= canvas.width || cy >= canvas.height) continue;
                    out.set(source.pixels.subarray(s, s + 4), (cy * canvas.width + cx) * 4);
                }
            }
        },
        getImageData(x, y, w, h) {
            const out = pixels();
            const data = new Uint8ClampedArray(w * h * 4);
            for (let j = 0; j < h; j++) {
                const at = ((y + j) * canvas.width + x) * 4;
                data.set(out.subarray(at, at + w * 4), j * w * 4);
            }
            return { data };
        },
    });
    return canvas;
}

// A renderer that bakes one bridge sprite into an 8x8 terrain, or loses it
// (the Chrome failure CoastBake `paintCoast` settles) when `lands` is false.
function bakingRenderer(t, { lands }) {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'document');
    globalThis.document = { createElement: pixelCanvas };
    t.after(() => {
        if (original) Object.defineProperty(globalThis, 'document', original);
        else delete globalThis.document;
    });
    t.mock.method(console, 'warn', () => {});
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const sprite = { width: 4, height: 4, pixels: new Uint8ClampedArray(64).map((_, i) => [200, 100, 50, 255][i % 4]) };
    const bounds = { x: 0, y: 0, w: 8, h: 8 };
    const written = [];
    let invalidated = 0;
    const renderer = Object.assign(Object.create(IsometricRenderer.prototype), {
        assets: { assetVersion: 'v1', getAnchor: () => [0, 0] },
        foliageRenderer: { setSeason() {} },
        bridgeSpans: [{ id: 'central-river-bridge' }],
        _terrainBakePasses: [],
        _terrainArtifactStats: { reads: 0, hits: 0, misses: 0, bakes: 0, writes: 0, state: 'idle' },
        _terrainCacheBounds: () => bounds,
        _getTerrainCacheMeta: () => ({ singleSurfaceWithinBudget: true }),
        _currentSeasonToken: () => 'summer',
        _bridgeSpritePlacement: () => ({ img: sprite, x: 2, y: 2 }),
        _drawStaticTerrainSurface(ctx) { if (lands) ctx.drawImage(sprite, 2, 2); },
        _queueTerrainArtifactWrite(canvas) { written.push(canvas); },
        _invalidateIdleFrame() { invalidated++; },
    });
    return { renderer, written, invalidated: () => invalidated };
}

test('a terrain bake whose sprites landed is stored', t => {
    const f = bakingRenderer(t, { lands: true });
    const { canvas } = f.renderer._getTerrainCache();
    assert.equal(f.written.length, 1);
    assert.equal(f.written[0], canvas);
    assert.equal(f.renderer._terrainArtifactStats.state, 'baked');
    assert.equal(f.renderer._terrainBakeRetryTimer, undefined);
});

test('a terrain bake that lost its sprites is shown, never stored, and rebakes after 30 s', t => {
    const f = bakingRenderer(t, { lands: false });
    const first = f.renderer._getTerrainCache();
    assert.ok(first.canvas, 'the bake still shows its ground');
    assert.equal(f.written.length, 0);
    assert.equal(f.renderer._terrainArtifactStats.state, 'unlanded');
    const key = f.renderer.terrainCacheKey;
    assert.equal(f.renderer._getTerrainCache().canvas, first.canvas, 'no rebake before the retry');
    t.mock.timers.tick(29999);
    assert.equal(f.invalidated(), 0);
    t.mock.timers.tick(1);
    assert.equal(f.invalidated(), 1);
    f.renderer._getTerrainCache();
    assert.notEqual(f.renderer.terrainCacheKey, key);
    assert.equal(f.renderer._terrainArtifactStats.bakes, 2);
});

test('EY-5: a winter stage change re-stages the terrain in idle slices, never in the frame', t => {
    const f = bakingRenderer(t, { lands: true });
    const r = f.renderer;
    let stage = 'f1r';
    let frameBakes = 0;
    let bands = 0;
    r._drawStaticTerrainSurface = () => { frameBakes++; };
    r._terrainSurfaceSteps = (ctx) => [() => ctx.drawImage({ width: 4, height: 4, pixels: new Uint8ClampedArray(64).fill(255) }, 2, 2)];
    r._terrainBakePasses.push({
        id: 'ground-splat', stage: 'ground', draw() {},
        revision: () => `sheets${stage}`, baseRevision: () => 'sheets',
        prepare: () => { let left = 3; return () => { bands++; return --left === 0; }; },
    });
    const first = r._getTerrainCache().canvas;
    assert.equal(frameBakes, 1, 'the first surface bakes in its frame');
    r._worldFramePresented = true;
    stage = 'f2r';
    for (let frame = 0; frame < 3; frame++) {
        assert.equal(r._getTerrainCache().canvas, first, 'the current terrain keeps presenting');
    }
    assert.equal(frameBakes, 1, 'no bake inside a frame');
    assert.equal(bands, 0, 'nothing prepared inside a frame');
    for (let slice = 0; slice < 8 && r._terrainRestage; slice++) t.mock.timers.tick(1);
    assert.equal(bands, 3, 'one band per idle slice');
    assert.equal(r._terrainRestage, null);
    const next = r._getTerrainCache().canvas;
    assert.notEqual(next, first, 'the prepared stage swaps in whole');
    assert.equal(frameBakes, 1);
    assert.match(r.terrainCacheKey, /ground-splat:sheetsf2r/);
    // A change outside the winter stage still bakes in the frame.
    r._terrainSceneryRevision = 1;
    r._getTerrainCache();
    assert.equal(frameBakes, 2);
});

// A restaging renderer whose ground stage is `state.stage`: its surface
// paints one texel the stage's colour, its coast and finish steps write the
// renderer's water fields as CoastBake does.
function stagingRenderer(t) {
    const f = bakingRenderer(t, { lands: true });
    const r = f.renderer;
    const state = { stage: 'f1r', slices: 0 };
    const colour = (stage) => ({ width: 1, height: 1, pixels: new Uint8ClampedArray([stage === 'f1r' ? 10 : 20, 0, 0, 255]) });
    const bridge = r._bridgeSpritePlacement();
    r._drawStaticTerrainSurface = (ctx) => { ctx.drawImage(bridge.img, 2, 2); ctx.drawImage(colour(state.stage), 1, 1); };
    r._terrainSurfaceSteps = (ctx) => [
        () => { ctx.drawImage(bridge.img, 2, 2); ctx.drawImage(colour(state.stage), 1, 1); },
        () => { r._coastBake = { stage: state.stage, waterFields: null }; },
        () => { r._coastBake.waterFields = `water-${r._coastBake.stage}`; },
    ];
    r._terrainBakePasses.push({
        id: 'ground-splat', stage: 'ground', draw() {},
        revision: () => `sheets${state.stage}`, baseRevision: () => 'sheets',
        prepare: () => () => true,
    });
    r._coastBake = { stage: 'f1r', waterFields: 'water-f1r' };
    r._getTerrainCache();
    r._worldFramePresented = true;
    // One idle slice per tick.
    const queue = [];
    globalThis.requestIdleCallback = (callback) => queue.push(callback);
    t.after(() => { delete globalThis.requestIdleCallback; });
    const tick = () => { state.slices++; queue.shift()?.(); };
    const texel = () => r.terrainCache.pixels[(1 * 8 + 1) * 4];
    return { r, state, tick, texel };
}

test('EY-5: a clock scrub back to the shown stage drops the pending restage', t => {
    const { r, state, tick, texel } = stagingRenderer(t);
    state.stage = 'f2r';
    r._getTerrainCache();
    tick();
    state.stage = 'f1r';
    r._getTerrainCache();
    assert.equal(r._terrainRestage, null, 'the return to the shown stage cancels the job');
    for (let i = 0; i < 4; i++) tick();
    state.stage = 'f2r';
    r._getTerrainCache();
    for (let i = 0; i < 12 && r._terrainRestage; i++) tick();
    r._getTerrainCache();
    assert.match(r.terrainCacheKey, /sheetsf2r/);
    assert.equal(texel(), 20, 'the quarter-2 key holds quarter-2 pixels');
    // A slice whose stage moved on under it stops at once.
    state.stage = 'f1r';
    r._getTerrainCache();
    const job = r._terrainRestage;
    assert.ok(job);
    state.stage = 'f2r';
    tick();
    assert.equal(r._terrainRestage, null, 'a slice validates the key first');
});

test('EY-5: a restage keeps its water fields private and publishes them with its canvas', t => {
    const { r, state, tick, texel } = stagingRenderer(t);
    const shown = r._coastBake;
    state.stage = 'f2r';
    r._getTerrainCache();
    let slices = 0;
    while (r._terrainRestage) {
        slices++;
        tick();
        if (r._terrainRestage) {
            assert.equal(r._coastBake, shown, 'frames in between keep the shown water fields');
            assert.equal(r._coastBake.waterFields, 'water-f1r');
        }
    }
    assert.ok(slices >= 5, `one step per slice: ${slices}`);
    assert.equal(r._coastBake.stage, 'f2r');
    assert.equal(r._coastBake.waterFields, 'water-f2r', 'published together with the canvas');
    assert.equal(texel(), 20);
    assert.match(r.terrainCacheKey, /sheetsf2r/);
});
