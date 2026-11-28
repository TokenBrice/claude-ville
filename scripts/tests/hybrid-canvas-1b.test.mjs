import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { COAST_FIELD_FLAGS } from '../../claudeville/src/presentation/character-mode/CoastBake.js';
import { poolMaskDiagnostics, poolMaskRect, poolReceiverMask, poolReceiverMaskPixels, releasePoolReceiverMask } from '../../claudeville/src/presentation/character-mode/CanvasPoolMask.js';
import {
    drawCanvasEmitterCuts,
    drawCarvedBuildingLayer,
    drawCarvedTerrainLayer,
    emitterCutsDiagnostics,
    emitterCutsVolatilePixels,
    partCutFor,
    releaseEmitterCutsBacking,
    scratchCanvasFor,
} from '../../claudeville/src/presentation/character-mode/EmitterCuts.js';
import { createPostFx } from '../../claudeville/src/presentation/character-mode/postfx/PostFx.js';

// Real RGBA software 2D canvas mock so pixel-correctness assertions test
// actual compositing (`source-over`, `destination-out`, `lighter`), clipping,
// sub-rect sourcing, transforms, and `clearRect` without needing a browser.
function createPixelDocument() {
    class MockCanvas {
        constructor(width = 0, height = 0) {
            this._width = width;
            this._height = height;
            this._data = new Uint8ClampedArray(width * height * 4);
            this._ctx = null;
            this.style = {};
        }
        get width() { return this._width; }
        set width(v) {
            const n = Math.max(0, Math.floor(Number(v) || 0));
            this._width = n;
            this._data = new Uint8ClampedArray(this._width * this._height * 4);
            if (this._ctx) this._ctx._resetState();
        }
        get height() { return this._height; }
        set height(v) {
            const n = Math.max(0, Math.floor(Number(v) || 0));
            this._height = n;
            this._data = new Uint8ClampedArray(this._width * this._height * 4);
            if (this._ctx) this._ctx._resetState();
        }
        getContext(type) {
            if (type !== '2d') return null;
            if (!this._ctx) this._ctx = new MockContext2D(this);
            return this._ctx;
        }
    }

    class MockContext2D {
        constructor(canvas) {
            this.canvas = canvas;
            this._stack = [];
            this._resetState();
        }
        _resetState() {
            this.globalCompositeOperation = 'source-over';
            this.globalAlpha = 1;
            this.imageSmoothingEnabled = true;
            this.fillStyle = '#000';
            this._tx = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
            this._clip = null;
            this._pathRect = null;
        }
        save() {
            this._stack.push({
                globalCompositeOperation: this.globalCompositeOperation,
                globalAlpha: this.globalAlpha,
                imageSmoothingEnabled: this.imageSmoothingEnabled,
                fillStyle: this.fillStyle,
                tx: { ...this._tx },
                clip: this._clip ? { ...this._clip } : null,
            });
        }
        restore() {
            const s = this._stack.pop();
            if (!s) return;
            this.globalCompositeOperation = s.globalCompositeOperation;
            this.globalAlpha = s.globalAlpha;
            this.imageSmoothingEnabled = s.imageSmoothingEnabled;
            this.fillStyle = s.fillStyle;
            this._tx = s.tx;
            this._clip = s.clip;
        }
        setTransform(a, b, c, d, e, f) {
            this._tx = { a, b, c, d, e, f };
        }
        getTransform() {
            return { ...this._tx };
        }
        translate(x, y) {
            this._tx.e += x * this._tx.a;
            this._tx.f += y * this._tx.d;
        }
        scale(sx, sy) {
            this._tx.a *= sx;
            this._tx.d *= sy;
        }
        beginPath() {
            this._pathRect = null;
        }
        rect(x, y, w, h) {
            const x0 = Math.round(x * this._tx.a + this._tx.e);
            const y0 = Math.round(y * this._tx.d + this._tx.f);
            const x1 = Math.round((x + w) * this._tx.a + this._tx.e);
            const y1 = Math.round((y + h) * this._tx.d + this._tx.f);
            this._pathRect = {
                x0: Math.min(x0, x1),
                y0: Math.min(y0, y1),
                x1: Math.max(x0, x1),
                y1: Math.max(y0, y1),
            };
        }
        clip() {
            if (!this._pathRect) return;
            if (!this._clip) {
                this._clip = { ...this._pathRect };
            } else {
                this._clip = {
                    x0: Math.max(this._clip.x0, this._pathRect.x0),
                    y0: Math.max(this._clip.y0, this._pathRect.y0),
                    x1: Math.min(this._clip.x1, this._pathRect.x1),
                    y1: Math.min(this._clip.y1, this._pathRect.y1),
                };
            }
        }
        createImageData(w, h) {
            return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
        }
        getImageData(x, y, w, h) {
            const out = new Uint8ClampedArray(w * h * 4);
            const cw = this.canvas._width;
            const ch = this.canvas._height;
            const src = this.canvas._data;
            for (let row = 0; row < h; row++) {
                const sy = y + row;
                if (sy < 0 || sy >= ch) continue;
                for (let col = 0; col < w; col++) {
                    const sx = x + col;
                    if (sx < 0 || sx >= cw) continue;
                    const si = (sy * cw + sx) * 4;
                    const di = (row * w + col) * 4;
                    out[di] = src[si];
                    out[di + 1] = src[si + 1];
                    out[di + 2] = src[si + 2];
                    out[di + 3] = src[si + 3];
                }
            }
            return { width: w, height: h, data: out };
        }
        putImageData(image, dx, dy) {
            const cw = this.canvas._width;
            const ch = this.canvas._height;
            const dst = this.canvas._data;
            const src = image.data;
            for (let row = 0; row < image.height; row++) {
                const ty = dy + row;
                if (ty < 0 || ty >= ch) continue;
                for (let col = 0; col < image.width; col++) {
                    const tx = dx + col;
                    if (tx < 0 || tx >= cw) continue;
                    const si = (row * image.width + col) * 4;
                    const di = (ty * cw + tx) * 4;
                    dst[di] = src[si];
                    dst[di + 1] = src[si + 1];
                    dst[di + 2] = src[si + 2];
                    dst[di + 3] = src[si + 3];
                }
            }
        }
        _bounds(x, y, w, h) {
            const x0 = Math.floor(x * this._tx.a + this._tx.e);
            const y0 = Math.floor(y * this._tx.d + this._tx.f);
            const x1 = Math.ceil((x + w) * this._tx.a + this._tx.e);
            const y1 = Math.ceil((y + h) * this._tx.d + this._tx.f);
            let bx0 = Math.max(0, Math.min(x0, x1));
            let by0 = Math.max(0, Math.min(y0, y1));
            let bx1 = Math.min(this.canvas._width, Math.max(x0, x1));
            let by1 = Math.min(this.canvas._height, Math.max(y0, y1));
            if (this._clip) {
                bx0 = Math.max(bx0, this._clip.x0);
                by0 = Math.max(by0, this._clip.y0);
                bx1 = Math.min(bx1, this._clip.x1);
                by1 = Math.min(by1, this._clip.y1);
            }
            return { bx0, by0, bx1, by1 };
        }
        clearRect(x, y, w, h) {
            const { bx0, by0, bx1, by1 } = this._bounds(x, y, w, h);
            const cw = this.canvas._width;
            const dst = this.canvas._data;
            for (let py = by0; py < by1; py++) {
                for (let px = bx0; px < bx1; px++) {
                    const di = (py * cw + px) * 4;
                    dst[di] = 0;
                    dst[di + 1] = 0;
                    dst[di + 2] = 0;
                    dst[di + 3] = 0;
                }
            }
        }
        fillRect(x, y, w, h) {
            const { bx0, by0, bx1, by1 } = this._bounds(x, y, w, h);
            const cw = this.canvas._width;
            const dst = this.canvas._data;
            const op = this.globalCompositeOperation;
            const alpha = Math.max(0, Math.min(1, this.globalAlpha));
            for (let py = by0; py < by1; py++) {
                for (let px = bx0; px < bx1; px++) {
                    const di = (py * cw + px) * 4;
                    if (op === 'destination-out') {
                        dst[di + 3] = Math.round(dst[di + 3] * (1 - alpha));
                        if (dst[di + 3] === 0) dst[di] = dst[di + 1] = dst[di + 2] = 0;
                    } else {
                        dst[di] = 0;
                        dst[di + 1] = 0;
                        dst[di + 2] = 0;
                        dst[di + 3] = Math.round(255 * alpha);
                    }
                }
            }
        }
        drawImage(img, ...args) {
            if (!img || !img._data || !img._width || !img._height) return;
            let sx = 0, sy = 0, sw = img._width, sh = img._height;
            let dx = 0, dy = 0, dw = sw, dh = sh;
            if (args.length === 2) {
                [dx, dy] = args;
            } else if (args.length === 4) {
                [dx, dy, dw, dh] = args;
            } else if (args.length === 8) {
                [sx, sy, sw, sh, dx, dy, dw, dh] = args;
            }
            if (!(sw > 0) || !(sh > 0) || !(dw > 0) || !(dh > 0)) return;
            const dstX0 = dx * this._tx.a + this._tx.e;
            const dstY0 = dy * this._tx.d + this._tx.f;
            const dstW = dw * this._tx.a;
            const dstH = dh * this._tx.d;
            let bx0 = Math.max(0, Math.floor(dstX0));
            let by0 = Math.max(0, Math.floor(dstY0));
            let bx1 = Math.min(this.canvas._width, Math.ceil(dstX0 + dstW));
            let by1 = Math.min(this.canvas._height, Math.ceil(dstY0 + dstH));
            if (this._clip) {
                bx0 = Math.max(bx0, this._clip.x0);
                by0 = Math.max(by0, this._clip.y0);
                bx1 = Math.min(bx1, this._clip.x1);
                by1 = Math.min(by1, this._clip.y1);
            }
            const cw = this.canvas._width;
            const dst = this.canvas._data;
            const src = img._data;
            const op = this.globalCompositeOperation;
            const gAlpha = Math.max(0, Math.min(1, this.globalAlpha));
            for (let py = by0; py < by1; py++) {
                const uY = (py + 0.5 - dstY0) / dstH;
                if (uY < 0 || uY >= 1) continue;
                const srcY = Math.floor(sy + uY * sh);
                if (srcY < 0 || srcY >= img._height) continue;
                for (let px = bx0; px < bx1; px++) {
                    const uX = (px + 0.5 - dstX0) / dstW;
                    if (uX < 0 || uX >= 1) continue;
                    const srcX = Math.floor(sx + uX * sw);
                    if (srcX < 0 || srcX >= img._width) continue;
                    const si = (srcY * img._width + srcX) * 4;
                    const sa = (src[si + 3] / 255) * gAlpha;
                    if (sa <= 0) continue;
                    const di = (py * cw + px) * 4;
                    if (op === 'destination-out') {
                        const remain = 1 - sa;
                        dst[di + 3] = Math.round(dst[di + 3] * remain);
                        if (dst[di + 3] === 0) dst[di] = dst[di + 1] = dst[di + 2] = 0;
                    } else if (op === 'destination-in') {
                        dst[di + 3] = Math.round(dst[di + 3] * sa);
                        if (dst[di + 3] === 0) dst[di] = dst[di + 1] = dst[di + 2] = 0;
                    } else if (op === 'lighter') {
                        dst[di] = Math.min(255, Math.round(dst[di] + src[si] * sa));
                        dst[di + 1] = Math.min(255, Math.round(dst[di + 1] + src[si + 1] * sa));
                        dst[di + 2] = Math.min(255, Math.round(dst[di + 2] + src[si + 2] * sa));
                        dst[di + 3] = Math.min(255, Math.round(dst[di + 3] + 255 * sa));
                    } else {
                        const da = dst[di + 3] / 255;
                        const outA = sa + da * (1 - sa);
                        if (outA <= 0) {
                            dst[di] = dst[di + 1] = dst[di + 2] = dst[di + 3] = 0;
                        } else {
                            dst[di] = Math.round((src[si] * sa + dst[di] * da * (1 - sa)) / outA);
                            dst[di + 1] = Math.round((src[si + 1] * sa + dst[di + 1] * da * (1 - sa)) / outA);
                            dst[di + 2] = Math.round((src[si + 2] * sa + dst[di + 2] * da * (1 - sa)) / outA);
                            dst[di + 3] = Math.round(outA * 255);
                        }
                    }
                }
            }
        }
    }

    return {
        createElement(tag) {
            if (tag === 'canvas') return new MockCanvas(0, 0);
            return {};
        },
        makeSprite(w, h, paintFn) {
            const c = new MockCanvas(w, h);
            const img = c.getContext('2d').createImageData(w, h);
            paintFn(img.data, w, h);
            c.getContext('2d').putImageData(img, 0, 0);
            return c;
        },
    };
}

function withPixelDocument(fn) {
    const prevDoc = globalThis.document;
    const doc = createPixelDocument();
    globalThis.document = doc;
    try {
        return fn(doc);
    } finally {
        if (prevDoc === undefined) delete globalThis.document;
        else globalThis.document = prevDoc;
    }
}

function readRgba(canvas, x, y) {
    const i = (y * canvas.width + x) * 4;
    return [canvas._data[i], canvas._data[i + 1], canvas._data[i + 2], canvas._data[i + 3]];
}

function snapshotBytes(canvas) {
    return new Uint8ClampedArray(canvas._data);
}

// ── 1. CanvasPoolMask tests ───────────────────────────────────────────────

test('CanvasPoolMask reuses revision when bodies are unchanged, patches dirty rects on movement without ghost footprints, and preserves overlapping stationary bodies', () => {
    withPixelDocument((doc) => {
        // 128x128 coast cells -> 256x256 world px: left half water (unmasked), right half ground (alpha 255).
        const cols = 128;
        const rows = 128;
        const coastField = new Uint8Array(cols * rows * 2);
        for (let cy = 0; cy < rows; cy++) {
            for (let cx = 0; cx < cols; cx++) {
                const idx = (cy * cols + cx) * 2;
                coastField[idx + 1] = cx < 64 ? COAST_FIELD_FLAGS.water : 0;
            }
        }
        const fields = { cols, rows, x: 0, y: 0, coastField, revision: 1 };

        // Two distinct body sprites (both solid 12x16 squares with distinct RGB so order is observable).
        const bodySpriteA = doc.makeSprite(24, 16, (data, w, h) => {
            for (let y = 0; y < h; y++) {
                for (let x = 0; x < w; x++) {
                    const i = (y * w + x) * 4;
                    data[i] = x < 12 ? 200 : 120;
                    data[i + 1] = 40;
                    data[i + 2] = 40;
                    data[i + 3] = 255;
                }
            }
        });
        const bodySpriteB = doc.makeSprite(12, 16, (data, w, h) => {
            for (let i = 0; i < data.length; i += 4) {
                data[i] = 40;
                data[i + 1] = 220;
                data[i + 2] = 60;
                data[i + 3] = 255;
            }
        });

        const makeAgent = (id, x, y, sprite, sx = 0) => ({
            id,
            x,
            y,
            _placeX: x,
            _placeY: y,
            _bodyBox: { left: 0, top: 0, right: 12, bottom: 16 },
            _cell: { canvas: sprite, dx: x, dy: y, sx, sy: 0, sw: 12, sh: 16 },
            currentPoseCell() { return this._cell; },
        });

        // Place agent A over water (x=20, y=30) so moving away MUST restore alpha=0 (no ghost-lit footprint!).
        // Place agent B overlapping A at (x=26, y=30) so moving A away MUST preserve B intact!
        const agentA = makeAgent('a', 20, 30, bodySpriteA, 0);
        const agentB = makeAgent('b', 26, 30, bodySpriteB, 0);
        const propCanvas = doc.makeSprite(16, 16, (data) => {
            for (let i = 0; i < data.length; i += 4) {
                data[i] = 255; data[i + 1] = 255; data[i + 2] = 255; data[i + 3] = 255;
            }
        });
        const staticProp = {
            id: 'prop.gate',
            x: 160,
            y: 40,
            sortY: 40,
            _gpuCacheRevision: 1,
            _cacheCanvas: { canvas: propCanvas, x: 160, y: 40 },
        };

        const renderer = {
            _coastBake: { waterFields: fields },
            terrainCacheKey: 't1',
            _sceneryRevision: 1,
            assets: { assetVersion: 'v1', get: () => null, getAnchor: () => null, getEntry: () => null },
            buildingRenderer: { enumerateDrawables: () => [] },
            _staticPropSprites: [staticProp],
            agentSprites: new Map([['a', agentA], ['b', agentB]]),
        };
        const worldRect = { x0: 0, y0: 0, x1: 200, y1: 200 };

        // Frame 1: initial full build
        const m1 = poolReceiverMask(renderer, worldRect);
        assert.equal(m1.fullRefresh, true);
        assert.equal(m1.dirtyRects, null);
        assert.equal(readRgba(m1.canvas, 22, 34)[3], 255, 'agent A paints onto water receiver');
        assert.equal(readRgba(m1.canvas, 28, 34)[1], 220, 'agent B painted over A');
        assert.equal(readRgba(m1.canvas, 164, 44)[3], 0, 'static prop cuts out ground receiver');
        assert.equal(readRgba(m1.canvas, 190, 44)[3], 255, 'ground receiver outside prop stays lit');

        // Frame 2: unchanged -> exact reuse, same revision, empty dirtyRects
        const m2 = poolReceiverMask(renderer, worldRect);
        assert.equal(m2.revision, m1.revision);
        assert.equal(m2.fullRefresh, false);
        assert.equal(m2.dirtyRects.length, 0);

        // Frame 3: move agent A to (60, 80) over water
        agentA.x = agentA._placeX = agentA._cell.dx = 60;
        agentA.y = agentA._placeY = agentA._cell.dy = 80;
        const m3 = poolReceiverMask(renderer, worldRect);
        assert.equal(m3.fullRefresh, false);
        assert.equal(m3.prevRevision, m2.revision);
        assert.equal(m3.revision, m2.revision + 1);
        assert.ok(m3.dirtyRects.length >= 1, 'emits dirty rects for old and new footprints');
        assert.equal(readRgba(m3.canvas, 22, 34)[3], 0, 'old footprint over water restored to 0 (no ghost-lit trail)');
        assert.equal(readRgba(m3.canvas, 28, 34)[3], 255, 'overlapping stationary agent B preserved intact');
        assert.equal(readRgba(m3.canvas, 28, 34)[1], 220, 'stationary agent B RGB intact');
        assert.equal(readRgba(m3.canvas, 64, 84)[3], 255, 'new footprint painted');

        // Frame 4: crop change (sx 0 -> 12) on same canvas invalidates and repaints
        agentA._cell.sx = 12;
        const m4 = poolReceiverMask(renderer, worldRect);
        assert.equal(m4.fullRefresh, false);
        assert.equal(m4.revision, m3.revision + 1);
        assert.equal(readRgba(m4.canvas, 64, 84)[0], 120, 'crop change repaints new frame pixels');

        // Frame 5: painter order swap between overlapping bodies invalidates
        agentA.x = agentA._placeX = agentA._cell.dx = 26;
        agentA.y = agentA._placeY = agentA._cell.dy = 30;
        const m5a = poolReceiverMask(renderer, worldRect);
        assert.equal(readRgba(m5a.canvas, 28, 34)[1], 220, 'B on top of A initially');
        renderer.agentSprites = new Map([['b', agentB], ['a', agentA]]);
        const m5b = poolReceiverMask(renderer, worldRect);
        assert.equal(m5b.revision, m5a.revision + 1);
        assert.equal(readRgba(m5b.canvas, 28, 34)[0], 120, 'order swap repaints A on top of B');

        // Frame 6: static prop in-place _gpuCacheRevision bump triggers fullRefresh
        staticProp._gpuCacheRevision++;
        staticProp._cacheCanvas.x = 180;
        const m6 = poolReceiverMask(renderer, worldRect);
        assert.equal(m6.fullRefresh, true);
        assert.equal(readRgba(m6.canvas, 164, 44)[3], 255, 'old static prop location restored');
        assert.equal(readRgba(m6.canvas, 184, 44)[3], 0, 'new static prop location cut out');

        // Frame 7: in-place canvas _revision bump without _gpuCacheRevision bump triggers fullRefresh
        propCanvas._revision = 7;
        const m7 = poolReceiverMask(renderer, worldRect);
        assert.equal(m7.fullRefresh, true);
        const pixelsWithBodies = poolReceiverMaskPixels(renderer);
        assert.ok(pixelsWithBodies > m7.w * m7.h, 'counts both the receiver mask and the compact body backup');
        assert.ok(pixelsWithBodies < 2 * m7.w * m7.h, 'eliminates the second full-size static mask canvas');

        // Frame 8: pan into new snapped rect with no visible bodies triggers fullRefresh and releases backup
        const m8 = poolReceiverMask(renderer, { x0: 260, y0: 0, x1: 400, y1: 200 });
        assert.equal(m8.fullRefresh, true);
        assert.equal(m8.x, 256);

        const diag = poolMaskDiagnostics();
        assert.ok(diag.bodyReuses >= 1);
        assert.ok(diag.bodyUpdates >= 3);
        assert.ok(diag.staticRebuilds >= 4);
        assert.equal(poolReceiverMaskPixels(renderer), m8.w * m8.h, 'single mask canvas with zero backup pixels when no bodies are visible');
        releasePoolReceiverMask({});
        assert.ok(m8.canvas.width > 0, 'another renderer cannot release this mask');
        releasePoolReceiverMask(renderer);
        assert.equal(m8.canvas.width, 0);
        assert.equal(poolReceiverMaskPixels(renderer), 0);
        assert.ok(poolReceiverMask(renderer, worldRect).fullRefresh, 'resume rebuilds all receivers');
    });
});

// ── 2. PostFx upload & sub-rect tests ─────────────────────────────────────

function createMockWebGL2Canvas() {
    const calls = {
        pixelStore: [],
        texImage2D: [],
        texSubImage2D: [],
        shaders: [],
    };
    const listeners = new Map();
    const gl = {
        VERTEX_SHADER: 0x8B31,
        FRAGMENT_SHADER: 0x8B30,
        COMPILE_STATUS: 0x8B81,
        LINK_STATUS: 0x8B82,
        TEXTURE_2D: 0x0DE1,
        TEXTURE0: 0x84C0,
        TEXTURE1: 0x84C1,
        TEXTURE2: 0x84C2,
        TEXTURE_MIN_FILTER: 0x2801,
        TEXTURE_MAG_FILTER: 0x2800,
        TEXTURE_WRAP_S: 0x2802,
        TEXTURE_WRAP_T: 0x2803,
        NEAREST: 0x2600,
        CLAMP_TO_EDGE: 0x812F,
        RGBA: 0x1908,
        UNSIGNED_BYTE: 0x1401,
        FRAMEBUFFER: 0x8D40,
        COLOR_ATTACHMENT0: 0x8CE0,
        FRAMEBUFFER_COMPLETE: 0x8CD5,
        DEPTH_TEST: 0x0B71,
        CULL_FACE: 0x0B44,
        BLEND: 0x0BE2,
        TRIANGLES: 0x0004,
        UNPACK_ALIGNMENT: 0x0CF5,
        UNPACK_FLIP_Y_WEBGL: 0x9240,
        UNPACK_ROW_LENGTH: 0x0CF2,
        UNPACK_SKIP_PIXELS: 0x0CF4,
        UNPACK_SKIP_ROWS: 0x0CF3,
        _lost: false,
        isContextLost() { return this._lost; },
        getExtension() { return null; },
        createVertexArray() { return {}; },
        bindVertexArray() {},
        deleteVertexArray() {},
        createShader(type) { return { type }; },
        shaderSource(s, src) { s.src = src; calls.shaders.push(src); },
        compileShader() {},
        getShaderParameter() { return true; },
        deleteShader() {},
        createProgram() { return {}; },
        attachShader() {},
        linkProgram() {},
        getProgramParameter() { return true; },
        deleteProgram() {},
        useProgram() {},
        getUniformLocation(_p, name) { return { name }; },
        uniform1i() {},
        uniform1f() {},
        uniform2f() {},
        uniform3f() {},
        uniform3fv() {},
        uniform4f() {},
        uniform4fv() {},
        createTexture() { return { id: Math.random() }; },
        bindTexture() {},
        deleteTexture() {},
        texParameteri() {},
        createFramebuffer() { return {}; },
        bindFramebuffer() {},
        framebufferTexture2D() {},
        checkFramebufferStatus() { return this.FRAMEBUFFER_COMPLETE; },
        deleteFramebuffer() {},
        activeTexture() {},
        viewport() {},
        disable() {},
        drawArrays() {},
        pixelStorei(pname, val) { calls.pixelStore.push([pname, val]); },
        texImage2D(...args) { calls.texImage2D.push(args); },
        texSubImage2D(...args) { calls.texSubImage2D.push(args); },
    };
    const canvas = {
        width: 512,
        height: 512,
        style: {},
        getContext(kind) { return kind === 'webgl2' ? gl : null; },
        addEventListener(type, fn) { listeners.set(type, fn); },
        removeEventListener(type) { listeners.delete(type); },
        dispatch(type) {
            const fn = listeners.get(type);
            if (fn) fn({ preventDefault() {} });
        },
    };
    return { canvas, gl, calls };
}

test('PostFx skips unchanged poolMask/emission revisions, patches dirty sub-rects with UNPACK_FLIP_Y=false, collapses scattered rects to union, and forces full upload on context restore/suspend', () => {
    const { canvas, gl, calls } = createMockWebGL2Canvas();
    const pfx = createPostFx({ canvas, enabled: true });
    assert.ok(pfx);
    pfx.setLevelOverride(0);

    // Every pixelStorei UNPACK_FLIP_Y_WEBGL call must be false.
    const flipCalls = calls.pixelStore.filter(([p]) => p === gl.UNPACK_FLIP_Y_WEBGL);
    assert.ok(flipCalls.every(([, v]) => v === false));
    // Fragment shaders must read top-down source/water/emission with (1.0 - c.y) and poolMask with local.y.
    const mainFrag = calls.shaders.find(s => s.includes('poolReceiver'));
    assert.match(mainFrag, /texture\(u_source,\s*vec2\(c\.x,\s*1\.0\s*-\s*c\.y\)\)/);
    assert.match(mainFrag, /texture\(u_poolMask,\s*local\)\.a/);

    const src = { width: 512, height: 512 };
    const pmCanvas = { width: 512, height: 512 };
    const emCanvas = { width: 256, height: 256 };

    const feedBase = () => ({
        viewport: { zoom: 1, dpr: 1, offsetX: 0, offsetY: 0 },
        lighting: { ambientLight: 0.2, beaconIntensity: 1 },
        lights: [],
        haze: [],
    });

    // Frame 1: initial storage creation -> full texImage2D for both poolMask & emission
    emCanvas._cvEmissionMeta = { revision: 1, prevRevision: 0, dirtyRect: { x: 0, y: 0, w: 256, h: 256 }, fullRefresh: true };
    pfx.render(src, {
        ...feedBase(),
        poolMask: { canvas: pmCanvas, x: 0, y: 0, w: 512, h: 512, revision: 1, prevRevision: 0, dirtyRects: null, fullRefresh: true },
        emission: emCanvas,
    });
    let diag = pfx.getDiagnostics();
    assert.equal(diag.uploadCounters.poolMaskFull, 1);
    assert.equal(diag.uploadCounters.emissionFull, 1);
    assert.equal(typeof diag.poolMaskUploadMs, 'number');
    assert.equal(typeof diag.emissionUploadMs, 'number');
    assert.equal(typeof diag.waterMaskUploadMs, 'number');

    // Frame 2: unchanged revisions -> both skipped
    calls.texSubImage2D.length = 0;
    emCanvas._cvEmissionMeta = { revision: 1, prevRevision: 1, dirtyRect: null, fullRefresh: false };
    pfx.render(src, {
        ...feedBase(),
        poolMask: { canvas: pmCanvas, x: 0, y: 0, w: 512, h: 512, revision: 1, prevRevision: 1, dirtyRects: [], fullRefresh: false },
        emission: emCanvas,
    });
    diag = pfx.getDiagnostics();
    assert.equal(diag.uploadCounters.poolMaskSkipped, 1);
    assert.equal(diag.uploadCounters.emissionSkipped, 1);
    // Only source texture should have uploaded
    assert.equal(calls.texSubImage2D.length, 1);

    // Frame 3: single dirty sub-rect -> partial upload using UNPACK_ROW_LENGTH/SKIP_PIXELS/SKIP_ROWS
    calls.texSubImage2D.length = 0;
    calls.pixelStore.length = 0;
    emCanvas._cvEmissionMeta = { revision: 2, prevRevision: 1, dirtyRect: { x: 10, y: 20, w: 40, h: 30 }, fullRefresh: false };
    pfx.render(src, {
        ...feedBase(),
        poolMask: { canvas: pmCanvas, x: 0, y: 0, w: 512, h: 512, revision: 2, prevRevision: 1, dirtyRects: [{ x: 32, y: 48, w: 64, h: 48 }], fullRefresh: false },
        emission: emCanvas,
    });
    diag = pfx.getDiagnostics();
    assert.equal(diag.uploadCounters.poolMaskPartial, 1);
    assert.equal(diag.uploadCounters.emissionPartial, 1);
    assert.ok(calls.pixelStore.some(([p, v]) => p === gl.UNPACK_ROW_LENGTH && v === 512));
    assert.ok(calls.pixelStore.some(([p, v]) => p === gl.UNPACK_SKIP_PIXELS && v === 32));
    assert.ok(calls.pixelStore.some(([p, v]) => p === gl.UNPACK_SKIP_ROWS && v === 48));
    // Sub-rect texSubImage2D uses 9-argument overload with x,y,w,h
    const pmSub = calls.texSubImage2D.find(a => a.length === 9 && a[2] === 32 && a[3] === 48 && a[4] === 64 && a[5] === 48);
    assert.ok(pmSub, 'poolMask partial upload used exact dirty rect');

    // Frame 4: >6 scattered dirty rects collapse into 1 union rect call when union < 50% area
    calls.texSubImage2D.length = 0;
    const manyRects = Array.from({ length: 10 }, (_, idx) => ({ x: 10 + idx * 12, y: 10 + idx * 8, w: 8, h: 8 }));
    pfx.render(src, {
        ...feedBase(),
        poolMask: { canvas: pmCanvas, x: 0, y: 0, w: 512, h: 512, revision: 3, prevRevision: 2, dirtyRects: manyRects, fullRefresh: false },
        emission: emCanvas,
    });
    // 1 source + 1 collapsed union call = 2 texSubImage2D calls (NOT 11!)
    assert.equal(calls.texSubImage2D.length, 2, '10 scattered dirty rects collapsed into 1 union texSubImage2D');
    assert.equal(pfx.getDiagnostics().uploadCounters.poolMaskPartial, 2);

    // Frame 5: skipped revision (prevRevision != GPU revision) forces full upload
    pfx.render(src, {
        ...feedBase(),
        poolMask: { canvas: pmCanvas, x: 0, y: 0, w: 512, h: 512, revision: 6, prevRevision: 5, dirtyRects: [{ x: 0, y: 0, w: 16, h: 16 }], fullRefresh: false },
        emission: emCanvas,
    });
    assert.equal(pfx.getDiagnostics().uploadCounters.poolMaskFull, 2);

    // Frame 6: WebGL context loss + restore resets cached revisions and forces full re-upload
    gl._lost = true;
    canvas.dispatch('webglcontextlost');
    assert.equal(pfx.isActive(), false);
    gl._lost = false;
    canvas.dispatch('webglcontextrestored');
    assert.equal(pfx.isActive(), true);
    pfx.render(src, {
        ...feedBase(),
        poolMask: { canvas: pmCanvas, x: 0, y: 0, w: 512, h: 512, revision: 6, prevRevision: 6, dirtyRects: [], fullRefresh: false },
        emission: emCanvas,
    });
    diag = pfx.getDiagnostics();
    assert.equal(diag.uploadCounters.poolMaskFull, 3, 'context restore forced full poolMask upload');
    assert.equal(diag.uploadCounters.emissionFull, 2, 'context restore forced full emission upload');

    // Suspend + resume also forces full re-upload
    pfx.suspend();
    assert.equal(pfx.resume(), true);
    pfx.render(src, {
        ...feedBase(),
        poolMask: { canvas: pmCanvas, x: 0, y: 0, w: 512, h: 512, revision: 6, prevRevision: 6, dirtyRects: [], fullRefresh: false },
        emission: emCanvas,
    });
    assert.equal(pfx.getDiagnostics().uploadCounters.poolMaskFull, 4);
    pfx.dispose();
});

// ── 3. EmitterCuts tests (scratch pool hysteresis, carving parity, bloom reuse) ──

test('EmitterCuts scratchCanvasFor handles alternating 2496x1404 and 600x600 without resize thrashing and applies oversize shrink hysteresis', () => {
    withPixelDocument(() => {
        const before = emitterCutsDiagnostics();
        const cLarge0 = scratchCanvasFor(2496, 1404);
        const cMed0 = scratchCanvasFor(600, 600);
        const cSmall0 = scratchCanvasFor(32, 32);
        assert.ok(cLarge0 !== cMed0, 'large and medium requests use separate buckets');
        assert.ok(cMed0 !== cSmall0, 'medium and small requests use separate buckets');

        const afterWarm = emitterCutsDiagnostics();
        // Alternate 2496x1404 and 600x600 across 60 frames (240 requests)
        for (let i = 0; i < 120; i++) {
            assert.ok(scratchCanvasFor(2496, 1404) === cLarge0, 'reuse the large canvas');
            assert.ok(scratchCanvasFor(600, 600) === cMed0, 'reuse the medium canvas');
            assert.ok(scratchCanvasFor(24, 24) === cSmall0, 'reuse the small canvas');
        }
        const afterLoop = emitterCutsDiagnostics();
        assert.equal(afterLoop.scratchResizes, afterWarm.scratchResizes, '0 resizes across 60 alternating frames');
        assert.equal(afterLoop.scratchCreates, afterWarm.scratchCreates, '0 allocations across 60 alternating frames');
        assert.ok(afterLoop.buckets.length <= 16, 'bucket count stays bounded');
        assert.ok(afterLoop.scratchBucketBytes <= afterLoop.scratchMaxBytes, 'pooled scratch stays within RGBA byte budget');

        // Many distinct large buckets must evict LRU entries to stay within SCRATCH_MAX_BYTES (not just entry limit)
        const largeSizes = [[2496, 1404], [2000, 1500], [1500, 1500], [2048, 2048], [2500, 1000], [1024, 1536]];
        for (const [w, h] of largeSizes) {
            scratchCanvasFor(w, h);
            const d = emitterCutsDiagnostics();
            assert.ok(d.scratchBucketBytes <= d.scratchMaxBytes, `byte budget held after ${w}x${h} (${d.scratchBucketBytes} <= ${d.scratchMaxBytes})`);
        }
        assert.ok(emitterCutsDiagnostics().scratchEvictions >= 1, 'byte budget evicted older large buckets');

        // Oversize (>3072) does not immediately shrink on one smaller oversize request,
        // and only shrinks after 120 consecutive smaller oversize calls.
        const overBig = scratchCanvasFor(4096, 2048);
        assert.equal(overBig.width, 4096);
        const beforeHyst = emitterCutsDiagnostics().scratchResizes;
        for (let i = 0; i < 60; i++) {
            const c = scratchCanvasFor(3200, 512);
            assert.equal(c.width, 4096, 'hysteresis holds oversize canvas steady');
        }
        assert.equal(emitterCutsDiagnostics().scratchResizes, beforeHyst);
        for (let i = 0; i < 65; i++) scratchCanvasFor(3200, 512);
        assert.ok(emitterCutsDiagnostics().scratchResizes >= beforeHyst + 1, 'shrinks once hysteresis threshold is met');
        assert.ok(before.buckets !== undefined);
    });
});

test('EmitterCuts clipped carving, integer 1x carve fast-path, fractional carve fallback, and harbor/bridge/facade occluders preserve exact RGBA pixels', () => {
    withPixelDocument((doc) => {
        // Build a 120x80 terrain/moon-path layer with glowing pixels only in a 40x30 inner sub-rect.
        const layerCanvas = doc.makeSprite(120, 80, (data, w, h) => {
            for (let y = 20; y < 50; y++) {
                for (let x = 30; x < 70; x++) {
                    const i = (y * w + x) * 4;
                    data[i] = 250;
                    data[i + 1] = 220;
                    data[i + 2] = 140;
                    data[i + 3] = 255;
                }
            }
        });
        const landmarkImg = doc.makeSprite(14, 14, (data) => {
            for (let i = 0; i < data.length; i += 4) {
                data[i] = 100; data[i + 1] = 100; data[i + 2] = 120; data[i + 3] = 255;
            }
        });
        const hullImg = doc.makeSprite(20, 10, (data) => {
            for (let i = 0; i < data.length; i += 4) {
                data[i] = 90; data[i + 1] = 70; data[i + 2] = 60; data[i + 3] = 255;
            }
        });
        const villagerImg = doc.makeSprite(8, 12, (data) => {
            for (let i = 0; i < data.length; i += 4) {
                data[i] = 255; data[i + 1] = 0; data[i + 2] = 0; data[i + 3] = 255;
            }
        });

        const villager = {
            x: 50,
            y: 30,
            _depthSortY: 500,
            _placeX: 50,
            _placeY: 30,
            _bodyBox: { left: 0, top: 0, right: 8, bottom: 12 },
            _cell: { canvas: villagerImg, dx: 50, dy: 30, sx: 0, sy: 0, sw: 8, sh: 12 },
            currentPoseCell() { return this._cell; },
        };
        const landmarkBuilding = { type: 'harbor' };
        const renderer = {
            assets: {
                assetVersion: 'v1',
                get: (id) => (id === 'building.harbor' ? landmarkImg : null),
                getAnchor: (id) => (id === 'building.harbor' ? [0, 0] : null),
            },
            buildingRenderer: {
                enumerateDrawables: () => [{ building: landmarkBuilding, entry: { id: 'building.harbor' }, wx: 35, wy: 24, sortY: 100 }],
            },
            _staticPropSprites: [],
            agentSprites: new Map([['v1', villager]]),
            _drawables: [{ payload: { pose: { strip: { image: hullImg, frameWidth: 20, frameHeight: 10, anchor: [0, 0] }, x: 40, y: 38, frame: 0, facing: 1 } } }],
        };

        // Compare full unclipped layer draw vs contentBounds clipped draw at integer scale 3 (triggers 1x carve fast-path)
        const fullOut = doc.createElement('canvas');
        fullOut.width = 240; fullOut.height = 180;
        const fullCtx = fullOut.getContext('2d');
        fullCtx.setTransform(3, 0, 0, 3, -60, -30);
        fullCtx.imageSmoothingEnabled = false;
        drawCarvedTerrainLayer(fullCtx, renderer, { canvas: layerCanvas, x: 0, y: 0 });

        const clippedOut = doc.createElement('canvas');
        clippedOut.width = 240; clippedOut.height = 180;
        const clipCtx = clippedOut.getContext('2d');
        clipCtx.setTransform(3, 0, 0, 3, -60, -30);
        clipCtx.imageSmoothingEnabled = false;
        drawCarvedTerrainLayer(clipCtx, renderer, {
            canvas: layerCanvas,
            x: 0,
            y: 0,
            contentBounds: { sx: 30, sy: 20, sw: 40, sh: 30 },
        });
        assert.deepEqual(snapshotBytes(clippedOut), snapshotBytes(fullOut), 'clipped + 1x-carve output is bit-identical to full layer');

        // Verify landmark, harbor hull, and moving villager all carved their exact silhouettes out
        // World (38, 28) inside landmark [35..49, 24..38] -> screen ((38*3 - 60)=54, (28*3 - 30)=54)
        assert.equal(readRgba(clippedOut, 54, 54)[3], 0, 'landmark carved out of harbor moon-path layer');
        // World (52, 34) inside villager [50..58, 30..42] -> screen (96, 72)
        assert.equal(readRgba(clippedOut, 96, 72)[3], 0, 'villager carved out of harbor moon-path layer');
        // World (65, 25) unoccluded glow -> screen (135, 45)
        assert.equal(readRgba(clippedOut, 135, 45)[3], 255, 'unoccluded glow survives intact');

        // Move villager to a fractional sub-texel position (50.5, 30) and verify live painter carve updates
        villager.x = villager._placeX = villager._cell.dx = 50.5;
        const movedOut = doc.createElement('canvas');
        movedOut.width = 240; movedOut.height = 180;
        const movedCtx = movedOut.getContext('2d');
        movedCtx.setTransform(3, 0, 0, 3, -60, -30);
        movedCtx.imageSmoothingEnabled = false;
        drawCarvedTerrainLayer(movedCtx, renderer, {
            canvas: layerCanvas,
            x: 0,
            y: 0,
            contentBounds: { sx: 30, sy: 20, sw: 40, sh: 30 },
        });
        // Fractional world 50.5*3 - 60 = 91.5 -> px 90 (world 50.0) stays lit while px 93 (world 51.0) is carved
        assert.equal(readRgba(movedOut, 90, 72)[3], 255, 'sub-texel carve preserves unoccluded half-texel');
        assert.equal(readRgba(movedOut, 93, 72)[3], 0, 'sub-texel carve cuts moved villager');

        // Verify drawCarvedBuildingLayer excludes its owner while carving later buildings
        const bLayer = doc.makeSprite(20, 20, (data) => {
            for (let i = 0; i < data.length; i += 4) {
                data[i] = 100; data[i + 1] = 240; data[i + 2] = 240; data[i + 3] = 255;
            }
        });
        const bOut = doc.createElement('canvas');
        bOut.width = 64; bOut.height = 64;
        const bCtx = bOut.getContext('2d');
        bCtx.imageSmoothingEnabled = false;
        drawCarvedBuildingLayer(bCtx, renderer, { canvas: bLayer, x: 32, y: 20 }, landmarkBuilding, 50);
        assert.equal(readRgba(bOut, 38, 28)[3], 255, 'owner building never self-carves');
    });
});

test('EmitterCuts bloom emission layer reuses when unchanged, returns null on empty reuse, preserves bridge skipPropPrefix and cropped facade glass cuts', () => {
    withPixelDocument((doc) => {
        const makeSolid = (w, h, r, g, b, a = 255) => doc.makeSprite(w, h, (data) => {
            for (let i = 0; i < data.length; i += 4) {
                data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = a;
            }
        });
        const bridgeAlbedo = makeSolid(16, 12, 255, 190, 80, 255);
        const bridgeEmissive = makeSolid(16, 12, 255, 190, 80, 255);
        const railCache = makeSolid(16, 12, 50, 50, 50, 255);
        const villagerImg = makeSolid(6, 12, 20, 20, 20, 255);
        const bldAlbedo = makeSolid(24, 24, 255, 170, 60, 255);
        const bldEmissive = makeSolid(24, 24, 255, 170, 60, 255);
        const glassCanvas = makeSolid(10, 24, 10, 10, 20, 255);
        glassCanvas._revision = 1;
        const partStrip = makeSolid(16, 8, 255, 220, 120, 255);
        const partEmissive = makeSolid(16, 8, 255, 220, 120, 255);

        const bridgeRailProp = {
            id: 'bridge.rail.south.near',
            x: 100,
            y: 100,
            sortY: 200,
            bounds: { left: 0, top: 0, right: 16, bottom: 12 },
            _gpuCacheRevision: 1,
            _cacheCanvas: { canvas: railCache, x: 100, y: 100 },
        };
        const villager = {
            x: 108,
            y: 100,
            _depthSortY: 250,
            _placeX: 108,
            _placeY: 100,
            _bodyBox: { left: 0, top: 0, right: 6, bottom: 12 },
            _cell: { canvas: villagerImg, dx: 108, dy: 100, sx: 0, sy: 0, sw: 6, sh: 12 },
            currentPoseCell() { return this._cell; },
        };
        const building = { type: 'tavern' };
        const glassPatch = { canvas: glassCanvas, left: 0, top: 0, w: 10, h: 24, revision: 1 };
        let partTexRev = 1;

        const entries = {
            'bridge.south': { id: 'bridge.south', emissiveSidecar: true },
            'building.tavern': { id: 'building.tavern', emissiveSidecar: true, layers: [{ name: 'lantern' }] },
        };
        const albedos = { 'bridge.south': bridgeAlbedo, 'building.tavern': bldAlbedo };
        const emissives = { 'bridge.south': bridgeEmissive, 'building.tavern': bldEmissive };

        let camOffsetX = 0;
        const renderer = {
            assets: {
                assetVersion: 'test-1b-v1',
                getEntry: (id) => entries[id] || null,
                get: (id) => albedos[id] || null,
                getCompanion: (id, kind) => (kind === 'emissive' ? emissives[id] || null : null),
                getAnchor: () => [0, 0],
            },
            camera: {
                zoom: 1,
                screenToWorld: (sx, sy) => ({ x: sx - camOffsetX, y: sy }),
                applyTransform: (ctx) => ctx.setTransform(1, 0, 0, 1, camOffsetX, 0),
            },
            _screenViewport: () => ({ width: 256, height: 256 }),
            bridgeSpans: [{ id: 'south', start: { x: 100, y: 100 }, end: { x: 100, y: 100 } }],
            _bridgeSpriteId: () => 'bridge.south',
            bridgeLightsLit: () => true,
            _staticPropSprites: [bridgeRailProp],
            agentSprites: new Map([['v', villager]]),
            buildingRenderer: {
                enumerateDrawables: () => [{ building, entry: entries['building.tavern'], wx: 20, wy: 20, sortY: 80 }],
                _emissiveGateFor: () => 1,
                glassPatchFor: () => glassPatch,
                partDrawsFor: (_entry, _b, wx, wy, _half, _ctx, out) => {
                    out.length = 0;
                    out.push({
                        id: 'tavern.lantern.crop',
                        name: 'lantern',
                        image: partStrip,
                        textureRevision: partTexRev,
                        sx: 8,
                        sy: 0,
                        sw: 8,
                        sh: 8,
                        x: wx + 12,
                        y: wy + 4,
                        fixture: true,
                    });
                    return out;
                },
                partChannelsFor: () => ({ key: `ch-${partTexRev}`, emissive: partEmissive }),
            },
        };
        const nightAtm = { lighting: { ambientLight: 0.15, beaconIntensity: 1 }, lightGrade: { poolGain: 1.2 } };

        const overlay = doc.createElement('canvas');
        overlay.width = 256;
        overlay.height = 256;

        // Frame 1: draws bridge (skipping own rail, keeping villager carved) + building (dark glass carved) + cropped facade part
        const em1 = drawCanvasEmitterCuts(overlay.getContext('2d'), renderer, nightAtm, 0.5);
        assert.ok(em1, 'returns bloom emission layer');
        const rev1 = em1._cvEmissionMeta.revision;
        // Bridge left half (x=102, y=104) is NOT carved by own bridge.rail.south.near
        assert.equal(readRgba(overlay, 102, 104)[3], 255, 'bridge own rail skipped via skipPropPrefix');
        // Bridge right half (x=110, y=104) IS carved by crossing villager
        assert.equal(readRgba(overlay, 110, 104)[3], 0, 'crossing villager carves bridge flame');
        // Tavern left half (x=24, y=24) IS carved by dark RoomGlass patch
        assert.equal(readRgba(overlay, 24, 24)[3], 0, 'dark RoomGlass carves unlit building pane');
        // Tavern right half + cropped part (x=34, y=26) stays lit
        assert.equal(readRgba(overlay, 34, 26)[3], 255, 'lit cropped facade part draws cleanly');

        // Frame 2: identical state -> bloom reused with same revision and null dirtyRect
        const em2 = drawCanvasEmitterCuts(overlay.getContext('2d'), renderer, nightAtm, 0.5);
        assert.ok(em2 === em1, 'unchanged emitters reuse the same bloom canvas');
        assert.equal(em2._cvEmissionMeta.revision, rev1);
        assert.equal(em2._cvEmissionMeta.dirtyRect, null);

        // Frame 3: RoomGlass revision bump invalidates bloom
        glassPatch.revision = 2;
        const em3 = drawCanvasEmitterCuts(overlay.getContext('2d'), renderer, nightAtm, 0.5);
        assert.equal(em3._cvEmissionMeta.revision, rev1 + 1);
        assert.ok(em3._cvEmissionMeta.dirtyRect, 'emits dirtyRect on bloom redraw');

        // Frame 4: partCutFor in-place rebuild bumps cut._revision and invalidates bloom
        partTexRev = 2;
        const partCut = partCutFor(renderer.assets, renderer.buildingRenderer, entries['building.tavern'], {
            id: 'tavern.lantern.crop', name: 'lantern', image: partStrip, textureRevision: 2,
        }, nightAtm.lightGrade);
        assert.ok(partCut._revision > 0);
        const em4 = drawCanvasEmitterCuts(overlay.getContext('2d'), renderer, nightAtm, 0.5);
        assert.equal(em4._cvEmissionMeta.revision, rev1 + 2);

        // Frame 5: pan camera so all emitters clip completely offscreen -> returns null on BOTH draw AND reuse!
        camOffsetX = -5000;
        const emOff1 = drawCanvasEmitterCuts(overlay.getContext('2d'), renderer, nightAtm, 0.5);
        assert.ok(emOff1 === null, 'offscreen bloom returns null');
        const emOff2 = drawCanvasEmitterCuts(overlay.getContext('2d'), renderer, nightAtm, 0.5);
        assert.ok(emOff2 === null, 'offscreen bloom reuse ALSO returns null (never returns stale empty targetCanvas)');

        // Frame 6: nonempty -> null -> disjoint emitter transition MUST clear
        // old pixels on 2D bloom canvas AND force PostFx full upload so GPU
        // emission texture never retains stale pixels outside the new rect!
        camOffsetX = 0;
        const emBeforeGap = drawCanvasEmitterCuts(overlay.getContext('2d'), renderer, nightAtm, 0.5);
        assert.ok(emBeforeGap, 'nonempty emission before null gap');
        assert.equal(emBeforeGap._cvEmissionMeta.fullRefresh, true, 'first emission after offscreen gap requests fullRefresh');
        // Verify pixel in rect A (bridge at world 102,104 -> bloom 51,52) is non-zero
        assert.ok(readRgba(emBeforeGap, 51, 52)[3] > 0, 'bridge emission painted in rect A');

        const { canvas: glCanvas, calls: glCalls } = createMockWebGL2Canvas();
        const pfx = createPostFx({ canvas: glCanvas, enabled: true });
        pfx.setLevelOverride(0);
        const srcStub = { width: 256, height: 256 };
        const baseFeed = {
            viewport: { zoom: 1, dpr: 1, offsetX: 0, offsetY: 0 },
            lighting: nightAtm.lighting,
            lights: [],
            haze: [],
        };
        // Upload rect A to GPU
        pfx.render(srcStub, { ...baseFeed, emission: emBeforeGap });
        const fullBeforeGap = pfx.getDiagnostics().uploadCounters.emissionFull;
        const partialBeforeGap = pfx.getDiagnostics().uploadCounters.emissionPartial;

        const unlit = { lighting: { sourceEnergy: { core: 0, bucket: 'daylight' } } };
        const emGap = drawCanvasEmitterCuts(overlay.getContext('2d'), renderer, unlit, 0.5);
        assert.ok(emGap === null, 'an unlit frame returns null emission');
        pfx.render(srcStub, { ...baseFeed, emission: null });
        assert.equal(pfx.emissionRevision, null, 'PostFx invalidates stored GPU emissionRevision when consuming null emission');
        // 2D bloom canvas must already be cleared at old rect A
        assert.equal(readRgba(emBeforeGap, 51, 52)[3], 0, '2D bloom canvas cleared at rect A during null gap');

        // Re-appear with a disjoint emitter in rect B (panned +80px in X so rect A is outside rect B)
        camOffsetX = 80;
        glCalls.texSubImage2D.length = 0;
        const emDisjoint = drawCanvasEmitterCuts(overlay.getContext('2d'), renderer, nightAtm, 0.5);
        assert.ok(emDisjoint, 'disjoint emitter returns bloom canvas');
        assert.equal(emDisjoint._cvEmissionMeta.fullRefresh, true, 'disjoint emitter after null gap sets fullRefresh=true');
        assert.equal(readRgba(emDisjoint, 51, 52)[3], 0, 'pixels outside new disjoint rect B remain transparent on 2D bloom canvas');
        assert.ok(readRgba(emDisjoint, 91, 52)[3] > 0, 'new disjoint rect B contains lit emission');

        pfx.render(srcStub, { ...baseFeed, emission: emDisjoint });
        const postDiag = pfx.getDiagnostics();
        assert.equal(postDiag.uploadCounters.emissionFull, fullBeforeGap + 1, 'PostFx performed FULL upload after null discontinuity (wiping stale GPU rect A)');
        assert.equal(postDiag.uploadCounters.emissionPartial, partialBeforeGap, 'PostFx did NOT use partial sub-rect upload across null discontinuity');
        // Verify a 7-arg full texSubImage2D (not a clipped 9-arg subrect) ran for emission
        const fullEmissionUpload = glCalls.texSubImage2D.find(a => a.length === 7 && a[6] === emDisjoint);
        assert.ok(fullEmissionUpload, 'full texSubImage2D uploaded entire emission canvas including cleared rect A');

        // Lifecycle & accounting: volatile pixels report retained scratch + bloom,
        // releaseEmitterCutsBacking zeros both stores, and subsequent draw forces full refresh.
        const beforeRelease = emitterCutsVolatilePixels(renderer);
        assert.ok(beforeRelease.bloom > 0, 'accounts for retained bloom backing pixels');
        assert.ok(beforeRelease.scratch > 0, 'accounts for retained carve scratch pixels');
        assert.equal(beforeRelease.total, beforeRelease.scratch + beforeRelease.bloom);
        assert.deepEqual(emitterCutsVolatilePixels({ other: true }), { scratch: 0, bloom: 0, total: 0 }, 'non-owning renderer reports 0 shared backing pixels');

        releaseEmitterCutsBacking({ other: true });
        assert.equal(emitterCutsVolatilePixels(renderer).total, beforeRelease.total, 'non-owning renderer release does not drop active owner backing');

        releaseEmitterCutsBacking(renderer);
        assert.deepEqual(emitterCutsVolatilePixels(renderer), { scratch: 0, bloom: 0, total: 0 }, 'owner release drops scratch and bloom backing to 0 pixels');
        assert.equal(emDisjoint.width, 0, 'released bloom canvas backing zeroed');
        assert.equal(emDisjoint.height, 0, 'released bloom canvas height zeroed');

        const emAfterRelease = drawCanvasEmitterCuts(overlay.getContext('2d'), renderer, nightAtm, 0.5);
        assert.ok(emAfterRelease && emAfterRelease !== emDisjoint, 're-allocates fresh bloom canvas after release');
        assert.equal(emAfterRelease._cvEmissionMeta.fullRefresh, true, 'first bloom draw after release requests fullRefresh');
        assert.ok(emitterCutsVolatilePixels(renderer).bloom > 0, 're-accounts bloom backing after resume');
        releaseEmitterCutsBacking(renderer);
        pfx.dispose();
    });
});

test('EmitterCuts preserves uncropped drawCarvedBuildingLayer staticSortY center and staticPropOccludersFor late-bound / NaN-sortY / in-place cache updates', () => {
    withPixelDocument((doc) => {
        const makeSolid = (w, h, r, g, b, a = 255) => doc.makeSprite(w, h, (data) => {
            for (let i = 0; i < data.length; i += 4) {
                data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = a;
            }
        });
        const glowLayer = doc.makeSprite(100, 40, (data, w) => {
            for (let y = 10; y < 20; y++) {
                for (let x = 70; x < 90; x++) {
                    const i = (y * w + x) * 4;
                    data[i] = 100; data[i + 1] = 230; data[i + 2] = 240; data[i + 3] = 255;
                }
            }
        });
        const propImg = makeSolid(10, 10, 40, 40, 40, 255);
        const propFront = {
            id: 'prop.testFront',
            x: 75,
            y: 12,
            sortY: 120,
            bounds: { left: 0, top: 0, right: 10, bottom: 10 },
            _gpuCacheRevision: 1,
            _cacheCanvas: { canvas: propImg, x: 75, y: 12 },
        };
        const propNaN = {
            id: 'prop.nan',
            x: 75,
            y: 12,
            sortY: Number.NaN,
            bounds: { left: 0, top: 0, right: 10, bottom: 10 },
            _gpuCacheRevision: 1,
            _cacheCanvas: { canvas: propImg, x: 75, y: 12 },
        };
        const propLate = {
            id: 'prop.late',
            x: 82,
            y: 12,
            sortY: 200,
            bounds: null,
            _gpuCacheRevision: 1,
            _cacheCanvas: null,
        };
        const owner = { type: 'mine' };
        const renderer = {
            assets: { assetVersion: 'v-reg', get: () => null, getAnchor: () => null },
            buildingRenderer: { enumerateDrawables: () => [] },
            _staticPropSprites: [propNaN, propFront, propLate],
            agentSprites: new Map(),
        };
        // Column sortY returns 150 at the full-layer center x=50 (so propFront sortY=120 does NOT carve),
        // but returns 50 at cropped sub-rect center x=80 (which would wrongly carve propFront if shifted).
        const sortYAtX = (wx) => (wx < 65 ? 150 : 50);

        const fullOut = doc.createElement('canvas');
        fullOut.width = 120; fullOut.height = 60;
        const fullCtx = fullOut.getContext('2d');
        fullCtx.imageSmoothingEnabled = false;
        drawCarvedBuildingLayer(fullCtx, renderer, { canvas: glowLayer, x: 0, y: 0 }, owner, sortYAtX);

        const croppedOut = doc.createElement('canvas');
        croppedOut.width = 120; croppedOut.height = 60;
        const croppedCtx = croppedOut.getContext('2d');
        croppedCtx.imageSmoothingEnabled = false;
        drawCarvedBuildingLayer(croppedCtx, renderer, {
            canvas: glowLayer,
            x: 0,
            y: 0,
            contentBounds: { sx: 70, sy: 10, sw: 20, sh: 10 },
        }, owner, sortYAtX);
        assert.deepEqual(snapshotBytes(croppedOut), snapshotBytes(fullOut), 'contentBounds crop evaluates staticSortY at uncropped layer center');
        assert.equal(readRgba(croppedOut, 77, 15)[3], 255, 'propFront stays behind building center sortY');

        // Late-populated bounds on a previously skipped static prop must trigger cache rebuild and carve.
        propLate.bounds = { left: 0, top: 0, right: 6, bottom: 10 };
        propLate._cacheCanvas = { canvas: makeSolid(6, 10, 40, 40, 40, 255), x: 82, y: 12 };
        const lateOut = doc.createElement('canvas');
        lateOut.width = 120; lateOut.height = 60;
        const lateCtx = lateOut.getContext('2d');
        lateCtx.imageSmoothingEnabled = false;
        drawCarvedBuildingLayer(lateCtx, renderer, {
            canvas: glowLayer,
            x: 0,
            y: 0,
            contentBounds: { sx: 70, sy: 10, sw: 20, sh: 10 },
        }, owner, sortYAtX);
        assert.equal(readRgba(lateOut, 84, 15)[3], 0, 'late-loaded static prop bounds rebuilt and carved despite NaN sibling');

        // In-place _cacheCanvas coordinate mutation without revision bump must also sync.
        propLate._cacheCanvas.x = 72;
        const movedOut = doc.createElement('canvas');
        movedOut.width = 120; movedOut.height = 60;
        const movedCtx = movedOut.getContext('2d');
        movedCtx.imageSmoothingEnabled = false;
        drawCarvedBuildingLayer(movedCtx, renderer, {
            canvas: glowLayer,
            x: 0,
            y: 0,
            contentBounds: { sx: 70, sy: 10, sw: 20, sh: 10 },
        }, owner, sortYAtX);
        assert.equal(readRgba(movedOut, 74, 15)[3], 0, 'in-place cached prop move reflected immediately');
        assert.equal(readRgba(movedOut, 84, 15)[3], 255, 'previous prop location uncarved after move');
        releaseEmitterCutsBacking(renderer);
    });
});

// ── 4. WorldFrameRenderer hybrid timing instrumentation contract ──────────

test('WorldFrameRenderer instruments hybrid PostFx stages separately from pure Canvas path', () => {
    const src = readFileSync(
        new URL('../../claudeville/src/presentation/character-mode/WorldFrameRenderer.js', import.meta.url),
        'utf8',
    );
    for (const mark of ['hybrid-feed', 'hybrid-pool-mask', 'hybrid-water-columns', 'hybrid-emitter-cuts', 'postfx']) {
        assert.ok(src.includes(`'${mark}'`), `WorldFrameRenderer hybrid branch marks '${mark}'`);
    }
});
