import test from 'node:test';
import assert from 'node:assert/strict';

import {
    DISTANT_SHORE_ASSET_ID,
    DISTANT_SHORE_PARALLAX,
    DISTANT_SHORE_TILE_HEIGHT,
    DISTANT_SHORE_TILE_WIDTH,
    SkyRenderer,
    distantShoreBandKey,
    distantShoreOffset,
    wrapTileOffset,
} from '../../claudeville/src/presentation/character-mode/SkyRenderer.js';

// The band is drawn as a source crop of a seamless strip, so the pixel that
// sits at source x lands on screen at `x - sourceOffset`: the on-screen shift
// is the negation of the offset the renderer computes.
function screenShift(cameraX) {
    const shift = -distantShoreOffset(cameraX, DISTANT_SHORE_TILE_WIDTH);
    return shift === 0 ? 0 : shift;
}

function shoreAssets({ assetVersion = 'shore-v1', available = true } = {}) {
    const image = { width: DISTANT_SHORE_TILE_WIDTH, height: DISTANT_SHORE_TILE_HEIGHT };
    return {
        assetVersion,
        has(id) { return available && id === DISTANT_SHORE_ASSET_ID; },
        get(id) { return id === DISTANT_SHORE_ASSET_ID ? image : null; },
        getDims(id) {
            return id === DISTANT_SHORE_ASSET_ID
                ? { w: DISTANT_SHORE_TILE_WIDTH, h: DISTANT_SHORE_TILE_HEIGHT }
                : null;
        },
    };
}

function countingDocument() {
    const state = { created: 0, strips: [] };
    state.document = {
        createElement() {
            state.created += 1;
            const strip = {
                width: 0,
                height: 0,
                tiles: 0,
                getContext() {
                    return {
                        imageSmoothingEnabled: true,
                        drawImage() { strip.tiles += 1; },
                    };
                },
            };
            state.strips.push(strip);
            return strip;
        },
    };
    return state;
}

function recordingCtx() {
    const calls = [];
    return {
        calls,
        globalAlpha: 0.5,
        globalCompositeOperation: 'screen',
        imageSmoothingEnabled: true,
        save() {},
        restore() {},
        drawImage(image, sx, sy, sw, sh, dx, dy, dw, dh) {
            calls.push({ image, sx, sy, sw, sh, dx, dy, dw, dh });
        },
    };
}


test('the shore band tracks the camera at 0.15 of its pan, in the same direction', () => {
    assert.equal(DISTANT_SHORE_PARALLAX, 0.15);
    // No wrap in this range: a 1000 px pan moves the coastline 150 px the same
    // way the world moves, which is what "distant but attached" looks like.
    assert.equal(screenShift(0), 0);
    assert.equal(screenShift(-1000), -150);
    assert.equal(screenShift(-2000), -300);
    assert.equal(screenShift(-100) - screenShift(-500), 60);
    // Motion is strictly a fraction of the pan, never a match for it.
    for (const cameraX of [-2600, -1300, -640, -12, 0, 12, 640, 1300, 2600]) {
        const shifted = screenShift(cameraX) - screenShift(cameraX + 200);
        assert.ok(
            Math.abs(shifted) <= 200 * DISTANT_SHORE_PARALLAX + 1e-9,
            `camera x=${cameraX} moved the band faster than the camera`,
        );
    }
});


test('every camera position crops inside one tile, so the tiling never seams', () => {
    const cameras = [-524288, -4001, -2666.6667, -400, -1, 0, 1, 400, 2666.6667, 4001, 524288];
    for (const cameraX of cameras) {
        const offset = distantShoreOffset(cameraX, DISTANT_SHORE_TILE_WIDTH);
        assert.ok(offset >= 0, `camera x=${cameraX} produced ${offset}`);
        assert.ok(offset < DISTANT_SHORE_TILE_WIDTH, `camera x=${cameraX} produced ${offset}`);
    }
    assert.equal(wrapTileOffset(-1, 400), 399);
    assert.equal(wrapTileOffset(400, 400), 0);
    assert.equal(wrapTileOffset(801, 400), 1);
    assert.equal(wrapTileOffset(-1601, 400), 399);
    // Degenerate inputs must not smear the crop off the strip.
    assert.equal(wrapTileOffset(Number.NaN, 400), 0);
    assert.equal(wrapTileOffset(10, 0), 0);
    assert.equal(distantShoreOffset(Number.POSITIVE_INFINITY, 400), 0);
});


test('the composed strip is reused until the viewport or the asset changes', () => {
    const assets = shoreAssets();
    const renderer = new SkyRenderer({ assets });
    const canvas = { width: 1280, height: 720, _claudeVilleDpr: 1 };
    let rebuilds = 0;
    renderer._buildDistantShoreBand = (surface, image, tileWidth, tileHeight) => {
        rebuilds += 1;
        return { canvas: {}, tileWidth, tileHeight, width: surface.width + tileWidth };
    };
    try {
        const first = renderer._getDistantShoreBand(canvas);
        assert.strictEqual(renderer._getDistantShoreBand(canvas), first);
        assert.strictEqual(renderer._getDistantShoreBand({ ...canvas }), first);
        assert.equal(rebuilds, 1);

        const wide = renderer._getDistantShoreBand({ ...canvas, width: 2560 });
        assert.notStrictEqual(wide, first);
        assert.equal(rebuilds, 2);

        assets.assetVersion = 'shore-v2';
        assert.notStrictEqual(renderer._getDistantShoreBand({ ...canvas, width: 2560 }), wide);
        assert.equal(rebuilds, 3);
    } finally {
        renderer.dispose();
    }
    assert.notEqual(
        distantShoreBandKey({ viewportWidth: 1280, assetVersion: 'a' }),
        distantShoreBandKey({ viewportWidth: 1280, assetVersion: 'b' }),
    );
});


test('a full pan draws one crop per frame from a strip that always covers the viewport', () => {
    const originalDocument = globalThis.document;
    const docState = countingDocument();
    globalThis.document = docState.document;
    const renderer = new SkyRenderer({ assets: shoreAssets() });
    const canvas = { width: 1280, height: 720, _claudeVilleDpr: 1 };
    const ctx = recordingCtx();
    try {
        for (let cameraX = -4000; cameraX <= 4000; cameraX += 37) {
            renderer._drawDistantShore(ctx, { x: cameraX }, canvas);
        }
        assert.equal(docState.created, 1, 'the strip must be composed once, not per frame');
        const strip = docState.strips[0];
        assert.equal(strip.width, canvas.width + DISTANT_SHORE_TILE_WIDTH);
        assert.equal(strip.height, DISTANT_SHORE_TILE_HEIGHT);
        assert.ok(strip.tiles >= Math.ceil(strip.width / DISTANT_SHORE_TILE_WIDTH));

        assert.equal(ctx.calls.length, 217);
        for (const call of ctx.calls) {
            assert.strictEqual(call.image, strip);
            assert.equal(call.sw, canvas.width);
            assert.equal(call.dw, canvas.width);
            assert.equal(call.sh, DISTANT_SHORE_TILE_HEIGHT);
            assert.equal(call.dh, DISTANT_SHORE_TILE_HEIGHT);
            assert.equal(call.dx, 0);
            assert.equal(Number.isInteger(call.sx), true);
            assert.equal(Number.isInteger(call.dy), true);
            // A crop that ran past the composed strip would expose a gap where
            // the last tile ends: the seam this band exists to avoid.
            assert.ok(call.sx >= 0 && call.sx + call.sw <= strip.width, `crop ${call.sx} escaped the strip`);
            // The coastline sits at the horizon, above the canvas midline.
            assert.ok(call.dy > 0 && call.dy + call.dh < canvas.height / 2);
        }
        assert.equal(ctx.imageSmoothingEnabled, false);
    } finally {
        renderer.dispose();
        globalThis.document = originalDocument;
    }
});


test('a missing shore asset draws nothing instead of a placeholder band', () => {
    const originalDocument = globalThis.document;
    const docState = countingDocument();
    globalThis.document = docState.document;
    const renderer = new SkyRenderer({ assets: shoreAssets({ available: false }) });
    const ctx = recordingCtx();
    try {
        renderer._drawDistantShore(ctx, { x: 0 }, { width: 1280, height: 720, _claudeVilleDpr: 1 });
        assert.equal(ctx.calls.length, 0);
        assert.equal(docState.created, 0);
        assert.equal(renderer.getCanvasBudget().volatilePixels, 0);
    } finally {
        renderer.dispose();
        globalThis.document = originalDocument;
    }
});
