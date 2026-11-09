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
