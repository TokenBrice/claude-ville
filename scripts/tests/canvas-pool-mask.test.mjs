import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PNG } from 'pngjs';
import { COAST_FIELD_FLAGS } from '../../claudeville/src/presentation/character-mode/CoastBake.js';
import {
    poolMaskDiagnostics,
    poolReceiverMask,
    poolReceiverMaskPixels,
    releasePoolReceiverMask,
} from '../../claudeville/src/presentation/character-mode/CanvasPoolMask.js';

// Exact software 2D RGBA rasterizer honoring `fillStyle`, `globalAlpha`,
// `source-over`, `destination-out`, `clearRect`, `putImageData`, `getImageData`,
// and sub-rect `drawImage` so we can verify bit-for-bit parity against a
// full-rebuild reference across overlapping bodies, partial alpha, landmarks,
// props, hulls, body removal, reordering, and owner isolation.
function createExactSoftwareDocument() {
    const parseColor = (style) => {
        if (style === '#ffffff' || style === '#fff') return [255, 255, 255, 255];
        const m = /^#([0-9a-f]{6})$/i.exec(String(style || ''));
        if (!m) return [0, 0, 0, 255];
        const n = parseInt(m[1], 16);
        return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 255];
    };

    class SoftwareCanvas {
        constructor(width = 0, height = 0) {
            this._width = width;
            this._height = height;
            this._data = new Uint8ClampedArray(width * height * 4);
            this._ctx = null;
        }
        get width() { return this._width; }
        set width(v) {
            this._width = Math.max(0, Math.floor(Number(v) || 0));
            this._data = new Uint8ClampedArray(this._width * this._height * 4);
            if (this._ctx) this._ctx._resetState();
        }
        get height() { return this._height; }
        set height(v) {
            this._height = Math.max(0, Math.floor(Number(v) || 0));
            this._data = new Uint8ClampedArray(this._width * this._height * 4);
            if (this._ctx) this._ctx._resetState();
        }
        getContext(type) {
            if (type !== '2d') return null;
            if (!this._ctx) this._ctx = new SoftwareContext2D(this);
            return this._ctx;
        }
    }

    class SoftwareContext2D {
        constructor(canvas) {
            this.canvas = canvas;
            this._resetState();
        }
        _resetState() {
            this.globalCompositeOperation = 'source-over';
            this.globalAlpha = 1;
            this.imageSmoothingEnabled = true;
            this.fillStyle = '#000000';
            this._tx = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
        }
        setTransform(a, b, c, d, e, f) {
            this._tx = { a, b, c, d, e, f };
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
        clearRect(x, y, w, h) {
            const bx0 = Math.max(0, Math.floor(x * this._tx.a + this._tx.e));
            const by0 = Math.max(0, Math.floor(y * this._tx.d + this._tx.f));
            const bx1 = Math.min(this.canvas._width, Math.ceil((x + w) * this._tx.a + this._tx.e));
            const by1 = Math.min(this.canvas._height, Math.ceil((y + h) * this._tx.d + this._tx.f));
            const cw = this.canvas._width;
            const dst = this.canvas._data;
            for (let py = by0; py < by1; py++) {
                for (let px = bx0; px < bx1; px++) {
                    const di = (py * cw + px) * 4;
                    dst[di] = dst[di + 1] = dst[di + 2] = dst[di + 3] = 0;
                }
            }
        }
        fillRect(x, y, w, h) {
            const [r, g, b, a] = parseColor(this.fillStyle);
            const bx0 = Math.max(0, Math.floor(x * this._tx.a + this._tx.e));
            const by0 = Math.max(0, Math.floor(y * this._tx.d + this._tx.f));
            const bx1 = Math.min(this.canvas._width, Math.ceil((x + w) * this._tx.a + this._tx.e));
            const by1 = Math.min(this.canvas._height, Math.ceil((y + h) * this._tx.d + this._tx.f));
            const cw = this.canvas._width;
            const dst = this.canvas._data;
            const sa = (a / 255) * Math.max(0, Math.min(1, this.globalAlpha));
            for (let py = by0; py < by1; py++) {
                for (let px = bx0; px < bx1; px++) {
                    const di = (py * cw + px) * 4;
                    if (this.globalCompositeOperation === 'destination-out') {
                        dst[di + 3] = Math.round(dst[di + 3] * (1 - sa));
                        if (dst[di + 3] === 0) dst[di] = dst[di + 1] = dst[di + 2] = 0;
                    } else {
                        const da = dst[di + 3] / 255;
                        const outA = sa + da * (1 - sa);
                        if (outA <= 0) {
                            dst[di] = dst[di + 1] = dst[di + 2] = dst[di + 3] = 0;
                        } else {
                            dst[di] = Math.round((r * sa + dst[di] * da * (1 - sa)) / outA);
                            dst[di + 1] = Math.round((g * sa + dst[di + 1] * da * (1 - sa)) / outA);
                            dst[di + 2] = Math.round((b * sa + dst[di + 2] * da * (1 - sa)) / outA);
                            dst[di + 3] = Math.round(outA * 255);
                        }
                    }
                }
            }
        }
        drawImage(img, ...args) {
            if (!img || !img._data || !img._width || !img._height) return;
            let sx = 0, sy = 0, sw = img._width, sh = img._height;
            let dx = 0, dy = 0, dw = sw, dh = sh;
            if (args.length === 2) [dx, dy] = args;
            else if (args.length === 4) [dx, dy, dw, dh] = args;
            else if (args.length === 8) [sx, sy, sw, sh, dx, dy, dw, dh] = args;
            if (!(sw > 0) || !(sh > 0) || !(dw > 0) || !(dh > 0)) return;
            const dstX0 = dx * this._tx.a + this._tx.e;
            const dstY0 = dy * this._tx.d + this._tx.f;
            const dstW = dw * this._tx.a;
            const dstH = dh * this._tx.d;
            const bx0 = Math.max(0, Math.floor(dstX0));
            const by0 = Math.max(0, Math.floor(dstY0));
            const bx1 = Math.min(this.canvas._width, Math.ceil(dstX0 + dstW));
            const by1 = Math.min(this.canvas._height, Math.ceil(dstY0 + dstH));
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
                        dst[di + 3] = Math.round(dst[di + 3] * (1 - sa));
                        if (dst[di + 3] === 0) dst[di] = dst[di + 1] = dst[di + 2] = 0;
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
            return tag === 'canvas' ? new SoftwareCanvas(0, 0) : {};
        },
        makeSprite(w, h, paintFn) {
            const c = new SoftwareCanvas(w, h);
            const img = c.getContext('2d').createImageData(w, h);
            paintFn(img.data, w, h);
            c.getContext('2d').putImageData(img, 0, 0);
            return c;
        },
    };
}

function withSoftwareDocument(fn) {
    const prevDoc = globalThis.document;
    const doc = createExactSoftwareDocument();
    globalThis.document = doc;
    try {
        return fn(doc);
    } finally {
        if (prevDoc === undefined) delete globalThis.document;
        else globalThis.document = prevDoc;
    }
}

// Reference two-canvas full-rebuild oracle: builds ground via a full coast-field
// canvas, draws uncropped landmark cut/floor masks and static props, then draws
// current bodies in painter order from scratch.
function buildReferenceMask(doc, renderer, worldRect) {
    const snap = 256;
    const x0 = Math.floor(worldRect.x0 / snap) * snap;
    const y0 = Math.floor(worldRect.y0 / snap) * snap;
    const x1 = Math.ceil(worldRect.x1 / snap) * snap;
    const y1 = Math.ceil(worldRect.y1 / snap) * snap;
    const w = x1 - x0;
    const h = y1 - y0;
    const out = doc.createElement('canvas');
    out.width = w;
    out.height = h;
    const ctx = out.getContext('2d');

    const fields = renderer._coastBake.waterFields;
    const ground = doc.createElement('canvas');
    ground.width = fields.cols;
    ground.height = fields.rows;
    const gctx = ground.getContext('2d');
    const gimg = gctx.createImageData(fields.cols, fields.rows);
    for (let i = 0; i < fields.cols * fields.rows; i++) {
        const flags = fields.coastField[i * 2 + 1];
        if ((flags & COAST_FIELD_FLAGS.water) && !(flags & COAST_FIELD_FLAGS.covered)) continue;
        gimg.data[i * 4] = 255;
        gimg.data[i * 4 + 1] = 255;
        gimg.data[i * 4 + 2] = 255;
        gimg.data[i * 4 + 3] = 255;
    }
    gctx.putImageData(gimg, 0, 0);

    ctx.setTransform(1, 0, 0, 1, -x0, -y0);
    ctx.drawImage(ground, fields.x, fields.y, fields.cols * 2, fields.rows * 2);

    const ops = [];
    for (const d of renderer.buildingRenderer.enumerateDrawables()) {
        const albedo = renderer.assets.get(d.entry.id);
        const occ = renderer.assets.getCompanion(d.entry.id, 'occluder');
        const anchor = renderer.assets.getAnchor(d.entry.id);
        const bw = albedo.width;
        const bh = albedo.height;
        const cut = doc.createElement('canvas');
        cut.width = bw;
        cut.height = bh;
        const floor = doc.createElement('canvas');
        floor.width = bw;
        floor.height = bh;
        const cimg = cut.getContext('2d').createImageData(bw, bh);
        const fimg = floor.getContext('2d').createImageData(bw, bh);
        for (let i = 0; i < bw * bh; i++) {
            const a = albedo._data[i * 4 + 3];
            if (a === 0) continue;
            const face = occ && occ._data[i * 4 + 3] > 0 ? (occ._data[i * 4 + 2] >> 6) : (occ ? 0 : 1);
            const target = face === 0 ? fimg.data : cimg.data;
            target[i * 4] = 255;
            target[i * 4 + 1] = 255;
            target[i * 4 + 2] = 255;
            target[i * 4 + 3] = a;
        }
        cut.getContext('2d').putImageData(cimg, 0, 0);
        floor.getContext('2d').putImageData(fimg, 0, 0);
        ops.push({ sortY: d.sortY, kind: 'landmark', cut, floor, x: Math.round(d.wx - anchor[0]), y: Math.round(d.wy - anchor[1]) });
    }
    for (const prop of renderer._staticPropSprites) {
        ops.push({ sortY: prop.sortY, kind: 'prop', canvas: prop._cacheCanvas.canvas, x: prop._cacheCanvas.x, y: prop._cacheCanvas.y });
    }
    ops.sort((a, b) => a.sortY - b.sortY);
    for (const op of ops) {
        if (op.kind === 'landmark') {
            ctx.globalCompositeOperation = 'destination-out';
            ctx.drawImage(op.cut, op.x, op.y);
            ctx.globalCompositeOperation = 'source-over';
            ctx.drawImage(op.floor, op.x, op.y);
        } else {
            ctx.globalCompositeOperation = 'destination-out';
            ctx.drawImage(op.canvas, op.x, op.y);
        }
    }
    ctx.globalCompositeOperation = 'source-over';
    for (const sprite of renderer.agentSprites.values()) {
        const c = sprite.currentPoseCell();
        ctx.drawImage(c.canvas, c.sx, c.sy, c.sw, c.sh, c.dx, c.dy, c.sw, c.sh);
    }
    return out._data;
}

test('CanvasPoolMask single-mask + packed backup matches full two-canvas reference bit-for-bit across partial alpha, overlapping moving/stationary bodies, cropped landmarks, reordering, and body removal', () => {
    withSoftwareDocument((doc) => {
        // Coast field with water, covered dock over water, and land, offset from (0,0).
        const cols = 140;
        const rows = 140;
        const coastField = new Uint8Array(cols * rows * 2);
        for (let cy = 0; cy < rows; cy++) {
            for (let cx = 0; cx < cols; cx++) {
                const idx = (cy * cols + cx) * 2;
                let flags = 0;
                if (cx < 60 || (cx > 95 && cx < 110 && cy > 40 && cy < 95)) {
                    flags = COAST_FIELD_FLAGS.water;
                    if (cx >= 30 && cx < 46 && cy >= 24 && cy < 36) {
                        flags |= COAST_FIELD_FLAGS.covered;
                    }
                }
                coastField[idx + 1] = flags;
            }
        }
        const fields = { cols, rows, x: -16, y: -8, coastField, revision: 1 };

        // Landmark with large transparent margin, semi-transparent wall edges (face 1),
        // and a thin bottom apron (face 0), plus a second landmark with zero floor texels.
        const lmAlbedo = doc.makeSprite(96, 96, (data, w, h) => {
            for (let y = 20; y < 74; y++) {
                for (let x = 24; x < 68; x++) {
                    const i = (y * w + x) * 4;
                    const edge = x === 24 || x === 67 || y === 20;
                    data[i] = 180;
                    data[i + 1] = 160;
                    data[i + 2] = 140;
                    data[i + 3] = edge ? 128 : 255;
                }
            }
        });
        const lmOccluder = doc.makeSprite(96, 96, (data, w, h) => {
            for (let y = 20; y < 74; y++) {
                for (let x = 24; x < 68; x++) {
                    const i = (y * w + x) * 4;
                    const face = y >= 66 ? 0 : 1; // bottom 8px is ground apron, rest is wall
                    data[i + 2] = face << 6;
                    data[i + 3] = 255;
                }
            }
        });
        const towerAlbedo = doc.makeSprite(80, 100, (data, w, h) => {
            for (let y = 10; y < 70; y++) {
                for (let x = 20; x < 50; x++) {
                    const i = (y * w + x) * 4;
                    data[i] = 200;
                    data[i + 1] = 200;
                    data[i + 2] = 200;
                    data[i + 3] = 255;
                }
            }
        });
        const towerOccluder = doc.makeSprite(80, 100, (data, w, h) => {
            for (let y = 10; y < 70; y++) {
                for (let x = 20; x < 50; x++) {
                    const i = (y * w + x) * 4;
                    data[i + 2] = 2 << 6; // roof only, zero floor texels
                    data[i + 3] = 255;
                }
            }
        });

        // Static prop with partial alpha rim (leaves semi-transparent static mask pixels!)
        const propCanvas = doc.makeSprite(24, 24, (data, w, h) => {
            for (let y = 2; y < 22; y++) {
                for (let x = 2; x < 22; x++) {
                    const i = (y * w + x) * 4;
                    const rim = x === 2 || x === 21 || y === 2 || y === 21;
                    data[i] = 255;
                    data[i + 1] = 255;
                    data[i + 2] = 255;
                    data[i + 3] = rim ? 140 : 255;
                }
            }
        });

        // Body sprites with holes (alpha 0), semi-transparent borders (alpha 110/180), and opaque core
        const makeBodySprite = (r, g, b, borderAlpha) => doc.makeSprite(16, 20, (data, w, h) => {
            for (let y = 1; y < h - 1; y++) {
                for (let x = 1; x < w - 1; x++) {
                    if (x >= 6 && x <= 9 && y >= 8 && y <= 11) continue; // transparent hole inside body!
                    const i = (y * w + x) * 4;
                    const edge = x === 1 || x === w - 2 || y === 1 || y === h - 2;
                    data[i] = r;
                    data[i + 1] = g;
                    data[i + 2] = b;
                    data[i + 3] = edge ? borderAlpha : 255;
                }
            }
        });
        const spriteA = makeBodySprite(220, 60, 50, 110);
        const spriteB = makeBodySprite(40, 210, 90, 180);
        const spriteC = makeBodySprite(70, 120, 240, 150);

        const makeAgent = (id, x, y, sprite) => ({
            id,
            x,
            y,
            _placeX: x,
            _placeY: y,
            _bodyBox: { left: 0, top: 0, right: sprite.width, bottom: sprite.height },
            _cell: { canvas: sprite, dx: x, dy: y, sx: 0, sy: 0, sw: sprite.width, sh: sprite.height },
            currentPoseCell() { return this._cell; },
            moveTo(nx, ny) {
                this.x = this._placeX = this._cell.dx = nx;
                this.y = this._placeY = this._cell.dy = ny;
            },
        });

        // Position agents overlapping semi-transparent landmark edges, semi-transparent prop rim,
        // water, dock, and each other!
        const agentA = makeAgent('a', 142, 76, spriteA);
        const agentB = makeAgent('b', 148, 80, spriteB);
        const agentC = makeAgent('c', 60, 50, spriteC);

        const renderer = {
            _coastBake: { waterFields: fields },
            terrainCacheKey: 't-exact',
            assets: {
                assetVersion: 'v1',
                get: (id) => (id === 'lm.hall' ? lmAlbedo : id === 'lm.tower' ? towerAlbedo : null),
                getEntry: (id) => (id === 'lm.hall' || id === 'lm.tower' ? { surfaceCode: true } : null),
                getCompanion: (id, kind) => {
                    if (kind !== 'occluder') return null;
                    return id === 'lm.hall' ? lmOccluder : id === 'lm.tower' ? towerOccluder : null;
                },
                getAnchor: () => [0, 0],
            },
            buildingRenderer: {
                enumerateDrawables: () => [
                    { building: { id: 'b1' }, entry: { id: 'lm.hall' }, wx: 120, wy: 60, sortY: 130 },
                    { building: { id: 'b2' }, entry: { id: 'lm.tower' }, wx: 10, wy: 120, sortY: 180 },
                ],
            },
            _staticPropSprites: [
                { id: 'p1', x: 145, y: 82, sortY: 100, _gpuCacheRevision: 1, _cacheCanvas: { canvas: propCanvas, x: 145, y: 82 } },
            ],
            agentSprites: new Map([['a', agentA], ['b', agentB], ['c', agentC]]),
        };
        const worldRect = { x0: 0, y0: 0, x1: 240, y1: 240 };

        const assertExact = (label) => {
            const actual = poolReceiverMask(renderer, worldRect);
            const expected = buildReferenceMask(doc, renderer, worldRect);
            assert.deepEqual(actual.canvas._data, expected, `${label}: RGBA mask bytes must match reference bit-for-bit`);
            return actual;
        };

        // 1. Initial full build
        const m1 = assertExact('frame 1 initial build');
        assert.equal(m1.fullRefresh, true);
        const diag1 = poolMaskDiagnostics();
        const hallDiag = diag1.masks.find(m => m.key.endsWith('|lm.hall'));
        const towerDiag = diag1.masks.find(m => m.key.endsWith('|lm.tower'));
        assert.equal(hallDiag.w, 96);
        assert.equal(hallDiag.h, 96);
        assert.ok(hallDiag.cut > 0 && hallDiag.floor > 0);
        assert.equal(towerDiag.floor, 0);
        // Cropped landmarks + compact backup must stay far below uncropped + 2 full canvases.
        const uncroppedLandmarks = 2 * (96 * 96 + 80 * 100);
        const pixels1 = poolReceiverMaskPixels(renderer);
        assert.ok(pixels1 < m1.w * m1.h + uncroppedLandmarks, 'cropped landmark masks + backup save pixels vs uncropped');
        assert.ok(diag1.backupPixels > 0 && diag1.backupPixels < m1.w * m1.h / 4, 'backup canvas stays compact');

        // 2. Identical frame reuse
        const m2 = assertExact('frame 2 identical reuse');
        assert.equal(m2.revision, m1.revision);
        assert.equal(m2.dirtyRects.length, 0);

        // 3. Move A off overlapping semi-transparent prop rim + stationary B into water
        agentA.moveTo(20, 20);
        const m3 = assertExact('frame 3 move A away from B and semi-transparent prop rim');
        assert.equal(m3.fullRefresh, false);
        assert.equal(m3.revision, m2.revision + 1);
        assert.ok(m3.dirtyRects.length >= 1);

        // 4. Move C to overlap stationary B over semi-transparent landmark wall edge
        agentC.moveTo(142, 78);
        const m4 = assertExact('frame 4 move C onto stationary B and semi-transparent wall edge');
        assert.equal(m4.fullRefresh, false);
        assert.equal(m4.revision, m3.revision + 1);

        // 5. Reorder overlapping B and C
        renderer.agentSprites = new Map([['a', agentA], ['c', agentC], ['b', agentB]]);
        const m5 = assertExact('frame 5 reorder overlapping B and C');
        assert.equal(m5.revision, m4.revision + 1);

        // 6. Move A partially outside the mask rect edge (clipped backup slot)
        agentA.moveTo(-6, 248);
        const m6 = assertExact('frame 6 body straddling mask edge');
        assert.equal(m6.revision, m5.revision + 1);

        // 7. Remove all bodies -> restores all clean static pixels and releases backup canvas
        renderer.agentSprites = new Map();
        const m7 = assertExact('frame 7 remove all bodies');
        assert.equal(m7.fullRefresh, false);
        assert.equal(m7.revision, m6.revision + 1);
        assert.equal(poolMaskDiagnostics().backupPixels, 0, 'backup canvas backing store released at zero bodies');

        // 8. Re-add bodies after zero-body release
        agentA.moveTo(50, 50);
        renderer.agentSprites = new Map([['a', agentA], ['b', agentB]]);
        const m8 = assertExact('frame 8 re-add bodies after zero-body release');
        assert.equal(m8.fullRefresh, false);
        assert.ok(poolMaskDiagnostics().backupPixels > 0);

        const prop = renderer._staticPropSprites[0];
        prop._cacheCanvas.canvas = doc.makeSprite(24, 24, () => {});
        assert.equal(assertExact('replacement prop canvas of equal dimensions').fullRefresh, true);

        // 9. Owner isolation & full release
        const otherRenderer = {
            ...renderer,
            agentSprites: new Map([['a', agentA]]),
        };
        assert.equal(poolReceiverMaskPixels(otherRenderer), 0, 'non-owner reads 0 pixels');
        releasePoolReceiverMask(otherRenderer);
        assert.ok(poolReceiverMaskPixels(renderer) > 0, 'non-owner cannot release active owner');
        // Switching to another renderer releases previous owner's backing store cleanly.
        const otherMask = poolReceiverMask(otherRenderer, worldRect);
        assert.equal(otherMask.fullRefresh, true);
        assert.equal(poolReceiverMaskPixels(renderer), 0, 'previous owner pixel count is 0 after handoff');
        assert.ok(poolReceiverMaskPixels(otherRenderer) > 0, 'new owner accounts for live canvases');

        releasePoolReceiverMask(otherRenderer);
        assert.equal(poolReceiverMaskPixels(otherRenderer), 0);
        assert.equal(poolMaskDiagnostics().backupPixels, 0);
    });
});

test('CanvasPoolMask backup canvas stays bounded under many scattered bodies and shrinks after burst subsides', () => {
    withSoftwareDocument((doc) => {
        const cols = 512;
        const rows = 512;
        const coastField = new Uint8Array(cols * rows * 2);
        const fields = { cols, rows, x: 0, y: 0, coastField, revision: 1 };
        const bodySprite = doc.makeSprite(32, 44, (data) => {
            for (let i = 0; i < data.length; i += 4) {
                data[i] = 255; data[i + 1] = 255; data[i + 2] = 255; data[i + 3] = 255;
            }
        });
        const makeAgents = (count) => {
            const map = new Map();
            for (let i = 0; i < count; i++) {
                // Place agents in a diagonal chain so AABB merging would blow up,
                // verifying per-body shelf packing stays tightly bounded.
                const x = 16 + (i * 22) % 920;
                const y = 16 + (i * 22) % 920;
                map.set(`a${i}`, {
                    id: `a${i}`,
                    x,
                    y,
                    _placeX: x,
                    _placeY: y,
                    _bodyBox: { left: 0, top: 0, right: 32, bottom: 44 },
                    _cell: { canvas: bodySprite, dx: x, dy: y, sx: 0, sy: 0, sw: 32, sh: 44 },
                    currentPoseCell() { return this._cell; },
                });
            }
            return map;
        };

        const renderer = {
            _coastBake: { waterFields: fields },
            terrainCacheKey: 't-burst',
            assets: { assetVersion: 'v1', get: () => null, getAnchor: () => null, getEntry: () => null },
            buildingRenderer: { enumerateDrawables: () => [] },
            _staticPropSprites: [],
            agentSprites: makeAgents(40),
        };
        const worldRect = { x0: 0, y0: 0, x1: 1000, y1: 1000 }; // 1024x1024 = 1,048,576 px

        const mBurst = poolReceiverMask(renderer, worldRect);
        const burstBackup = poolMaskDiagnostics().backupPixels;
        const burstTotal = poolReceiverMaskPixels(renderer);
        assert.ok(burstBackup > 0 && burstBackup < mBurst.w * mBurst.h * 0.25,
            `40 diagonal bodies backup (${burstBackup} px) must stay far below mask (${mBurst.w * mBurst.h} px)`);
        assert.equal(burstTotal, mBurst.w * mBurst.h + burstBackup);

        // Burst subsides from 40 bodies down to 2 bodies -> backup shrinks cleanly.
        renderer.agentSprites = makeAgents(2);
        const mCalm = poolReceiverMask(renderer, worldRect);
        assert.equal(mCalm.fullRefresh, false);
        const calmBackup = poolMaskDiagnostics().backupPixels;
        assert.ok(calmBackup > 0 && calmBackup < burstBackup,
            `backup should shrink after burst (${calmBackup} < ${burstBackup})`);

        releasePoolReceiverMask(renderer);
        assert.equal(poolReceiverMaskPixels(renderer), 0);
    });
});

test('authored prop.plazaFountainWater 4-frame strip alpha lies strictly inside opaque prop.plazaFountain with matching anchor', () => {
    const basePng = PNG.sync.read(readFileSync('claudeville/assets/sprites/props/prop.plazaFountain.png'));
    const waterPng = PNG.sync.read(readFileSync('claudeville/assets/sprites/props/prop.plazaFountainWater.png'));
    const manifest = readFileSync('claudeville/assets/sprites/manifest.yaml', 'utf8');
    const anchorOf = (id) => {
        const match = /anchor:\s*\[\s*(\d+)\s*,\s*(\d+)\s*\]/.exec(manifest.slice(manifest.indexOf(`id: ${id}`), manifest.indexOf(`id: ${id}`) + 800));
        assert.ok(match, `anchor missing for ${id}`);
        return [Number(match[1]), Number(match[2])];
    };
    assert.deepEqual(anchorOf('prop.plazaFountainWater'), anchorOf('prop.plazaFountain'));
    assert.equal(waterPng.height, basePng.height);
    assert.equal(waterPng.width, basePng.width * 4);

    const signatures = new Set();
    for (let f = 0; f < 4; f++) {
        let nonTransparent = 0;
        const coords = [];
        for (let y = 0; y < basePng.height; y++) {
            for (let x = 0; x < basePng.width; x++) {
                const wa = waterPng.data[(y * waterPng.width + f * basePng.width + x) * 4 + 3];
                if (wa === 0) continue;
                nonTransparent++;
                coords.push(`${x},${y}:${wa}`);
                assert.equal(
                    basePng.data[(y * basePng.width + x) * 4 + 3],
                    255,
                    `frame ${f} pixel (${x},${y}) must lie inside fully opaque prop.plazaFountain`,
                );
            }
        }
        assert.ok(nonTransparent > 0);
        signatures.add(coords.join(';'));
    }
    assert.ok(signatures.size > 1, 'authored water frames have distinct alpha silhouettes');
});

test('CanvasPoolMask keeps static revision stable across FountainWaterSprite frame group and invalidates on missing base or replacement', () => {
    withSoftwareDocument((doc) => {
        const fields = { cols: 64, rows: 64, x: 0, y: 0, coastField: new Uint8Array(64 * 64 * 2), revision: 1 };
        const solid = (w, h) => doc.makeSprite(w, h, (d) => { d.fill(255); });
        const fx = 40;
        const fy = 40;
        const baseProp = { id: 'prop.plazaFountain', x: 80, y: 100, sortY: 100, _gpuCacheRevision: 0, _cacheCanvas: { canvas: solid(32, 32), x: fx, y: fy } };
        const frames = [0, 1, 2, 3].map(() => ({ canvas: solid(32, 32), x: fx, y: fy }));
        const waterProp = {
            id: 'prop.plazaFountainWater',
            x: 80,
            y: 100,
            sortY: 100.5,
            _gpuCacheRevision: 0,
            _frames: frames,
            _cacheCanvas: frames[0],
            poolMaskStaticBaseId: 'prop.plazaFountain',
            poolMaskFrameGroup(c) { return this._frames.length === 4 && this._frames.includes(c) ? this._frames : null; },
        };
        const otherProp = { id: 'prop.bench', x: 140, y: 120, sortY: 120, _gpuCacheRevision: 0, _cacheCanvas: { canvas: solid(16, 16), x: 132, y: 112 } };
        const renderer = {
            _coastBake: { waterFields: fields },
            terrainCacheKey: 't-fountain',
            assets: { assetVersion: 'v1', get: () => null, getAnchor: () => null, getEntry: () => null },
            buildingRenderer: { enumerateDrawables: () => [] },
            _staticPropSprites: [baseProp, waterProp, otherProp],
            agentSprites: new Map(),
        };
        const worldRect = { x0: 0, y0: 0, x1: 200, y1: 200 };

        const m0 = poolReceiverMask(renderer, worldRect);
        assert.equal(m0.fullRefresh, true);
        const rebuilds0 = poolMaskDiagnostics().staticRebuilds;

        // Cycling own 4 generated frames over resident co-located base keeps revision stable.
        for (const f of [1, 2, 3, 0]) {
            waterProp._cacheCanvas = frames[f];
            const m = poolReceiverMask(renderer, worldRect);
            assert.equal(m.fullRefresh, false);
            assert.equal(m.revision, m0.revision);
            assert.equal(poolMaskDiagnostics().staticRebuilds, rebuilds0);
        }

        // Unknown/external frame outside the sprite's 4-frame group invalidates.
        waterProp._cacheCanvas = { canvas: solid(32, 32), x: fx, y: fy };
        assert.equal(poolReceiverMask(renderer, worldRect).fullRefresh, true);
        waterProp._cacheCanvas = frames[0];
        assert.equal(poolReceiverMask(renderer, worldRect).fullRefresh, true);

        // Unrelated static prop canvas replacement, position, size, and sortY changes invalidate.
        otherProp._cacheCanvas = { canvas: solid(16, 16), x: 132, y: 112 };
        assert.equal(poolReceiverMask(renderer, worldRect).fullRefresh, true);
        waterProp._cacheCanvas = { canvas: frames[1].canvas, x: fx + 1, y: fy };
        assert.equal(poolReceiverMask(renderer, worldRect).fullRefresh, true);
        waterProp._cacheCanvas = frames[0];
        poolReceiverMask(renderer, worldRect);
        waterProp.sortY = 104;
        assert.equal(poolReceiverMask(renderer, worldRect).fullRefresh, true);

        // Missing or inverted-order base invalidates when water cycles frames.
        renderer._staticPropSprites = [waterProp, otherProp];
        waterProp._cacheCanvas = frames[0];
        assert.equal(poolReceiverMask(renderer, worldRect).fullRefresh, true);
        waterProp._cacheCanvas = frames[1];
        assert.equal(poolReceiverMask(renderer, worldRect).fullRefresh, true);

        baseProp.sortY = 110;
        renderer._staticPropSprites = [baseProp, waterProp, otherProp];
        waterProp._cacheCanvas = frames[0];
        assert.equal(poolReceiverMask(renderer, worldRect).fullRefresh, true);
        waterProp._cacheCanvas = frames[1];
        assert.equal(poolReceiverMask(renderer, worldRect).fullRefresh, true);

        releasePoolReceiverMask(renderer);
        assert.equal(poolReceiverMaskPixels(renderer), 0);
    });
});
