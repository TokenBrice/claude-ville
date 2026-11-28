import test from 'node:test';
import assert from 'node:assert/strict';
import { IsometricRenderer } from '../../claudeville/src/presentation/character-mode/IsometricRenderer.js';
import { buildPoolDodgeStamp, gradedPoolReceiver } from '../../claudeville/src/presentation/character-mode/CanvasGrade.js';
import { evaluateGrade } from '../../claudeville/src/presentation/character-mode/GradeEvaluator.js';
import { COAST_FIELD_FLAGS } from '../../claudeville/src/presentation/character-mode/CoastBake.js';

// Minimal exact integer-pixel Canvas 2D rasterizer supporting the exact subset
// of operations used by `_poolLayerCanvas`, `_beginPoolLayer`, `_stampPool`,
// `_maskPoolLayers`, and `_landPoolLayer`, so we can compare RGBA bytes
// directly in pure Node across consecutive frames, overlaps, masks and motion.
function createSoftwareDocument() {
    const parseHex = (style) => {
        if (style === '#ffffff' || style === '#fff') return [255, 255, 255, 255];
        const m = /^#([0-9a-f]{6})$/i.exec(String(style || ''));
        if (!m) return [0, 0, 0, 255];
        const n = parseInt(m[1], 16);
        return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 255];
    };

    const blendChannel = (op, cb, cs) => {
        if (op === 'lighten') return Math.max(cb, cs);
        if (op === 'darken') return Math.min(cb, cs);
        if (op === 'multiply') return cb * cs;
        if (op === 'color-dodge') {
            if (cb <= 0) return 0;
            if (cs >= 1) return 1;
            return Math.min(1, cb / (1 - cs));
        }
        return cs;
    };

    const makeCanvas = () => {
        const opsLog = [];
        let _w = 0;
        let _h = 0;
        let pixels = new Uint8ClampedArray(0);
        const resize = (w, h) => {
            _w = Math.max(0, w | 0);
            _h = Math.max(0, h | 0);
            pixels = new Uint8ClampedArray(_w * _h * 4);
        };

        const state = () => ({
            a: 1, b: 0, c: 0, d: 1, e: 0, f: 0,
            op: 'source-over',
            fillStyle: '#000000',
            smoothing: true,
            clip: null,
        });
        let cur = state();
        const stack = [];
        let pathRects = [];

        const insideClip = (x, y) => {
            if (!cur.clip) return true;
            for (const r of cur.clip) {
                if (x >= r.x0 && x < r.x1 && y >= r.y0 && y < r.y1) return true;
            }
            return false;
        };

        const compositePixel = (idx, sr, sg, sb, sa, op) => {
            const br = pixels[idx] / 255;
            const bg = pixels[idx + 1] / 255;
            const bb = pixels[idx + 2] / 255;
            const ba = pixels[idx + 3] / 255;
            const aS = sa / 255;
            const rS = sr / 255;
            const gS = sg / 255;
            const bS = sb / 255;
            if (op === 'destination-in') {
                const ao = ba * aS;
                pixels[idx + 3] = Math.round(ao * 255);
                if (ao === 0) {
                    pixels[idx] = 0;
                    pixels[idx + 1] = 0;
                    pixels[idx + 2] = 0;
                }
                return;
            }
            if (op === 'source-out') return;
            if (op === 'source-over') {
                const ao = aS + ba * (1 - aS);
                if (ao <= 0) {
                    pixels[idx] = pixels[idx + 1] = pixels[idx + 2] = pixels[idx + 3] = 0;
                    return;
                }
                pixels[idx] = Math.round(((aS * rS + ba * (1 - aS) * br) / ao) * 255);
                pixels[idx + 1] = Math.round(((aS * gS + ba * (1 - aS) * bg) / ao) * 255);
                pixels[idx + 2] = Math.round(((aS * bS + ba * (1 - aS) * bb) / ao) * 255);
                pixels[idx + 3] = Math.round(ao * 255);
                return;
            }
            // Separable blend modes (lighten, darken, multiply, color-dodge)
            const ao = aS + ba * (1 - aS);
            if (ao <= 0) {
                pixels[idx] = pixels[idx + 1] = pixels[idx + 2] = pixels[idx + 3] = 0;
                return;
            }
            const outR = ((1 - aS) * ba * br + (1 - ba) * aS * rS + aS * ba * blendChannel(op, br, rS)) / ao;
            const outG = ((1 - aS) * ba * bg + (1 - ba) * aS * gS + aS * ba * blendChannel(op, bg, gS)) / ao;
            const outB = ((1 - aS) * ba * bb + (1 - ba) * aS * bS + aS * ba * blendChannel(op, bb, bS)) / ao;
            pixels[idx] = Math.round(Math.max(0, Math.min(1, outR)) * 255);
            pixels[idx + 1] = Math.round(Math.max(0, Math.min(1, outG)) * 255);
            pixels[idx + 2] = Math.round(Math.max(0, Math.min(1, outB)) * 255);
            pixels[idx + 3] = Math.round(ao * 255);
        };

        const ctx = {
            canvas: null,
            get globalCompositeOperation() { return cur.op; },
            set globalCompositeOperation(v) { cur.op = v; },
            get fillStyle() { return cur.fillStyle; },
            set fillStyle(v) { cur.fillStyle = v; },
            get imageSmoothingEnabled() { return cur.smoothing; },
            set imageSmoothingEnabled(v) { cur.smoothing = Boolean(v); },
            save() { stack.push({ ...cur, clip: cur.clip ? cur.clip.map(r => ({ ...r })) : null }); },
            restore() { if (stack.length) cur = stack.pop(); },
            setTransform(a, b, c, d, e, f) {
                if (a && typeof a === 'object') {
                    cur.a = a.a; cur.b = a.b || 0; cur.c = a.c || 0;
                    cur.d = a.d; cur.e = a.e || 0; cur.f = a.f || 0;
                } else {
                    cur.a = a; cur.b = b; cur.c = c; cur.d = d; cur.e = e; cur.f = f;
                }
            },
            getTransform() { return { a: cur.a, b: cur.b, c: cur.c, d: cur.d, e: cur.e, f: cur.f }; },
            beginPath() { pathRects = []; },
            rect(x, y, w, h) {
                const x0 = Math.round(x * cur.a + cur.e);
                const y0 = Math.round(y * cur.d + cur.f);
                const x1 = Math.round((x + w) * cur.a + cur.e);
                const y1 = Math.round((y + h) * cur.d + cur.f);
                pathRects.push({ x0: Math.min(x0, x1), y0: Math.min(y0, y1), x1: Math.max(x0, x1), y1: Math.max(y0, y1) });
            },
            clip() {
                if (!pathRects.length) {
                    cur.clip = [];
                    return;
                }
                if (!cur.clip) {
                    cur.clip = pathRects.map(r => ({ ...r }));
                } else {
                    const next = [];
                    for (const a of cur.clip) {
                        for (const b of pathRects) {
                            const x0 = Math.max(a.x0, b.x0);
                            const y0 = Math.max(a.y0, b.y0);
                            const x1 = Math.min(a.x1, b.x1);
                            const y1 = Math.min(a.y1, b.y1);
                            if (x1 > x0 && y1 > y0) next.push({ x0, y0, x1, y1 });
                        }
                    }
                    cur.clip = next;
                }
                opsLog.push({ kind: 'clip', rects: cur.clip.map(r => ({ ...r })) });
            },
            createImageData(w, h) { return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }; },
            putImageData(img, dx = 0, dy = 0) {
                for (let y = 0; y < img.height; y++) {
                    const py = dy + y;
                    if (py < 0 || py >= _h) continue;
                    for (let x = 0; x < img.width; x++) {
                        const px = dx + x;
                        if (px < 0 || px >= _w) continue;
                        const s = (y * img.width + x) * 4;
                        const d = (py * _w + px) * 4;
                        pixels[d] = img.data[s];
                        pixels[d + 1] = img.data[s + 1];
                        pixels[d + 2] = img.data[s + 2];
                        pixels[d + 3] = img.data[s + 3];
                    }
                }
            },
            getImageData(sx, sy, sw, sh) {
                const out = new Uint8ClampedArray(sw * sh * 4);
                for (let y = 0; y < sh; y++) {
                    const py = sy + y;
                    if (py < 0 || py >= _h) continue;
                    for (let x = 0; x < sw; x++) {
                        const px = sx + x;
                        if (px < 0 || px >= _w) continue;
                        const s = (py * _w + px) * 4;
                        const d = (y * sw + x) * 4;
                        out[d] = pixels[s];
                        out[d + 1] = pixels[s + 1];
                        out[d + 2] = pixels[s + 2];
                        out[d + 3] = pixels[s + 3];
                    }
                }
                return { width: sw, height: sh, data: out };
            },
            clearRect(x, y, w, h) {
                const x0 = Math.max(0, Math.floor(x * cur.a + cur.e));
                const y0 = Math.max(0, Math.floor(y * cur.d + cur.f));
                const x1 = Math.min(_w, Math.ceil((x + w) * cur.a + cur.e));
                const y1 = Math.min(_h, Math.ceil((y + h) * cur.d + cur.f));
                opsLog.push({ kind: 'clearRect', x0, y0, x1, y1 });
                for (let py = y0; py < y1; py++) {
                    for (let px = x0; px < x1; px++) {
                        if (!insideClip(px, py)) continue;
                        const d = (py * _w + px) * 4;
                        pixels[d] = pixels[d + 1] = pixels[d + 2] = pixels[d + 3] = 0;
                    }
                }
            },
            fillRect(x, y, w, h) {
                const [r, g, b, a] = parseHex(cur.fillStyle);
                const x0 = Math.max(0, Math.floor(x * cur.a + cur.e));
                const y0 = Math.max(0, Math.floor(y * cur.d + cur.f));
                const x1 = Math.min(_w, Math.ceil((x + w) * cur.a + cur.e));
                const y1 = Math.min(_h, Math.ceil((y + h) * cur.d + cur.f));
                opsLog.push({ kind: 'fillRect', x0, y0, x1, y1, fillStyle: cur.fillStyle });
                for (let py = y0; py < y1; py++) {
                    for (let px = x0; px < x1; px++) {
                        if (!insideClip(px, py)) continue;
                        compositePixel((py * _w + px) * 4, r, g, b, a, cur.op);
                    }
                }
            },
            drawImage(src, ...args) {
                let sx = 0, sy = 0, sw = src.width, sh = src.height;
                let dx, dy, dw, dh;
                if (args.length === 2) {
                    [dx, dy] = args; dw = sw; dh = sh;
                } else if (args.length === 4) {
                    [dx, dy, dw, dh] = args;
                } else {
                    [sx, sy, sw, sh, dx, dy, dw, dh] = args;
                }
                const dstX0 = dx * cur.a + cur.e;
                const dstY0 = dy * cur.d + cur.f;
                const dstX1 = (dx + dw) * cur.a + cur.e;
                const dstY1 = (dy + dh) * cur.d + cur.f;
                const px0 = Math.max(0, Math.floor(dstX0));
                const py0 = Math.max(0, Math.floor(dstY0));
                const px1 = Math.min(_w, Math.ceil(dstX1));
                const py1 = Math.min(_h, Math.ceil(dstY1));
                opsLog.push({
                    kind: 'drawImage',
                    op: cur.op,
                    src,
                    sx, sy, sw, sh,
                    dx, dy, dw, dh,
                    clip: cur.clip ? cur.clip.map(r => ({ ...r })) : null,
                });

                const srcPixels = src._pixels;
                const srcW = src.width;
                const srcH = src.height;

                // Non-source-bounded `destination-in` clears pixels inside clip
                // that fall outside the source image bounds (per Canvas 2D spec).
                if (cur.op === 'destination-in') {
                    let loopX0 = 0, loopY0 = 0, loopX1 = _w, loopY1 = _h;
                    if (cur.clip && cur.clip.length === 1) {
                        loopX0 = Math.max(0, cur.clip[0].x0);
                        loopY0 = Math.max(0, cur.clip[0].y0);
                        loopX1 = Math.min(_w, cur.clip[0].x1);
                        loopY1 = Math.min(_h, cur.clip[0].y1);
                    }
                    for (let py = loopY0; py < loopY1; py++) {
                        for (let px = loopX0; px < loopX1; px++) {
                            if (!insideClip(px, py)) continue;
                            const ux = (px + 0.5 - dstX0) / (dstX1 - dstX0);
                            const uy = (py + 0.5 - dstY0) / (dstY1 - dstY0);
                            let sa = 0;
                            if (ux >= 0 && ux < 1 && uy >= 0 && uy < 1) {
                                const ix = Math.min(srcW - 1, Math.max(0, Math.floor(sx + ux * sw)));
                                const iy = Math.min(srcH - 1, Math.max(0, Math.floor(sy + uy * sh)));
                                sa = srcPixels[(iy * srcW + ix) * 4 + 3];
                            }
                            compositePixel((py * _w + px) * 4, 255, 255, 255, sa, 'destination-in');
                        }
                    }
                    return;
                }

                for (let py = py0; py < py1; py++) {
                    const uy = (py + 0.5 - dstY0) / (dstY1 - dstY0);
                    if (uy < 0 || uy >= 1) continue;
                    const iy = Math.min(srcH - 1, Math.max(0, Math.floor(sy + uy * sh)));
                    for (let px = px0; px < px1; px++) {
                        if (!insideClip(px, py)) continue;
                        const ux = (px + 0.5 - dstX0) / (dstX1 - dstX0);
                        if (ux < 0 || ux >= 1) continue;
                        const ix = Math.min(srcW - 1, Math.max(0, Math.floor(sx + ux * sw)));
                        const sIdx = (iy * srcW + ix) * 4;
                        compositePixel(
                            (py * _w + px) * 4,
                            srcPixels[sIdx],
                            srcPixels[sIdx + 1],
                            srcPixels[sIdx + 2],
                            srcPixels[sIdx + 3],
                            cur.op,
                        );
                    }
                }
            },
        };

        const canvas = {
            get width() { return _w; },
            set width(v) { resize(v, _h); },
            get height() { return _h; },
            set height(v) { resize(_w, v); },
            get _pixels() { return pixels; },
            _opsLog: opsLog,
            getContext: () => ctx,
        };
        ctx.canvas = canvas;
        return canvas;
    };

    const created = [];
    const doc = {
        createElement: () => {
            const c = makeCanvas();
            created.push(c);
            return c;
        },
    };
    return { doc, created, makeCanvas };
}

// Reference copy of the pre-optimization full-bbox pool layer methods, used as
// an oracle to assert byte-for-byte parity across multi-frame sequences.
function installReferencePoolMethods(renderer) {
    renderer._poolLayerCanvas = function(key, canvas, fill) {
        let layer = this[key];
        if (layer && layer.width === canvas.width && layer.height === canvas.height) return layer;
        if (layer) { layer.width = 0; layer.height = 0; }
        layer = document.createElement('canvas');
        layer.width = canvas.width;
        layer.height = canvas.height;
        if (fill) {
            const layerCtx = layer.getContext('2d');
            layerCtx.fillStyle = fill;
            layerCtx.fillRect(0, 0, layer.width, layer.height);
        }
        this[key] = layer;
        this._poolLayerRect = null;
        return layer;
    };
    renderer._beginPoolLayer = function(ctx, canvas) {
        const dodge = this._poolLayerCanvas('_poolLayer', canvas, null).getContext('2d');
        const shade = this._poolLayerCanvas('_poolShadeLayer', canvas, '#ffffff').getContext('2d');
        const stale = this._poolLayerRect;
        const transform = ctx.getTransform();
        for (const layerCtx of [dodge, shade]) {
            layerCtx.setTransform(1, 0, 0, 1, 0, 0);
            layerCtx.globalCompositeOperation = 'source-over';
            if (stale) {
                if (layerCtx === shade) {
                    layerCtx.fillStyle = '#ffffff';
                    layerCtx.fillRect(stale.x0, stale.y0, stale.x1 - stale.x0, stale.y1 - stale.y0);
                } else {
                    layerCtx.clearRect(stale.x0, stale.y0, stale.x1 - stale.x0, stale.y1 - stale.y0);
                }
            }
            layerCtx.setTransform(transform);
            layerCtx.imageSmoothingEnabled = false;
        }
        dodge.globalCompositeOperation = 'lighten';
        shade.globalCompositeOperation = 'darken';
        this._poolLayerRect = null;
        this._poolShadeUsed = false;
        const pools = this._poolLayerContexts || (this._poolLayerContexts = {});
        pools.dodge = dodge;
        pools.shade = shade;
        return pools;
    };
    renderer._stampPool = function(pools, stamp, x, y) {
        const cells = stamp._poolCells || stamp.width;
        const rows = stamp._poolRows || stamp.height;
        const width = cells * stamp._poolCellPx;
        const height = rows * stamp._poolCellPx;
        const left = Math.round(x - width / 2);
        const top = Math.round(y - height / 2);
        pools.dodge.drawImage(stamp, 0, 0, cells, rows, left, top, width, height);
        if (stamp._poolShade) {
            pools.shade.drawImage(stamp, cells, 0, cells, rows, left, top, width, height);
            this._poolShadeUsed = true;
        }
        const m = pools.dodge.getTransform();
        const x0 = Math.max(0, Math.floor(left * m.a + m.e));
        const y0 = Math.max(0, Math.floor(top * m.d + m.f));
        const x1 = Math.min(pools.dodge.canvas.width, Math.ceil((left + width) * m.a + m.e));
        const y1 = Math.min(pools.dodge.canvas.height, Math.ceil((top + height) * m.d + m.f));
        if (x1 <= x0 || y1 <= y0) return;
        const rect = this._poolLayerRect;
        this._poolLayerRect = rect
            ? { x0: Math.min(rect.x0, x0), y0: Math.min(rect.y0, y0), x1: Math.max(rect.x1, x1), y1: Math.max(rect.y1, y1) }
            : { x0, y0, x1, y1 };
    };
    renderer._landPoolLayer = function(ctx) {
        const rect = this._poolLayerRect;
        if (!rect || !this._poolLayer) return;
        const w = rect.x1 - rect.x0;
        const h = rect.y1 - rect.y0;
        this._maskPoolLayers(rect);
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.imageSmoothingEnabled = false;
        if (this._poolShadeUsed) {
            ctx.globalCompositeOperation = 'multiply';
            ctx.drawImage(this._poolShadeLayer, rect.x0, rect.y0, w, h, rect.x0, rect.y0, w, h);
        }
        ctx.globalCompositeOperation = 'color-dodge';
        ctx.drawImage(this._poolLayer, rect.x0, rect.y0, w, h, rect.x0, rect.y0, w, h);
        ctx.restore();
    };
    const origMask = IsometricRenderer.prototype._maskPoolLayers;
    renderer._maskPoolLayers = function(rect) {
        // Call the unclipped single-pass reference mask behavior
        const pools = this._poolLayerContexts;
        if (!pools?.dodge) return;
        const mask = this._testMask;
        if (!mask) return origMask.call(this, rect);
        for (const layerCtx of [pools.dodge, pools.shade]) {
            if (!layerCtx) continue;
            layerCtx.save();
            layerCtx.setTransform(1, 0, 0, 1, 0, 0);
            layerCtx.imageSmoothingEnabled = false;
            layerCtx.globalCompositeOperation = 'destination-in';
            this.camera.applyTransform(layerCtx);
            layerCtx.drawImage(mask.canvas, mask.x, mask.y);
            layerCtx.restore();
        }
    };
}

function makeBackdrop(makeCanvas, width, height) {
    const canvas = makeCanvas();
    canvas.width = width;
    canvas.height = height;
    const pixels = canvas._pixels;
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const i = (y * width + x) * 4;
            pixels[i] = 28 + ((x * 7 + y * 3) & 63);
            pixels[i + 1] = 36 + ((x * 5 + y * 11) & 63);
            pixels[i + 2] = 62 + ((x * 3 + y * 13) & 63);
            pixels[i + 3] = 255;
        }
    }
    return canvas;
}

function makeCoastBakeWithHoles(width, height) {
    const cols = Math.ceil(width / 2);
    const rows = Math.ceil(height / 2);
    const coastField = new Uint8Array(cols * rows * 2);
    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
            // Carve an open-water channel and an island pond so mask has both 0 and 255 cells.
            const isWater = (c >= 20 && c < 34) || (r >= 24 && r < 34 && c >= 40 && c < 70);
            coastField[(r * cols + c) * 2 + 1] = isWater ? COAST_FIELD_FLAGS.water : 0;
        }
    }
    return { waterFields: { x: 0, y: 0, cols, rows, coastField, revision: 1 } };
}

function makeRenderer({ width, height, zoom = 1, dpr = 1, offsetX = 0, offsetY = 0, coastBake = null }) {
    const renderer = Object.create(IsometricRenderer.prototype);
    renderer._poolLayer = null;
    renderer._poolShadeLayer = null;
    renderer._poolLayerRect = null;
    renderer._coastBake = coastBake;
    renderer._screenDpr = () => dpr;
    renderer.camera = {
        zoom,
        renderOffsetX: offsetX,
        renderOffsetY: offsetY,
        screenToWorld(sx, sy) {
            return { x: (sx - this.renderOffsetX) / this.zoom, y: (sy - this.renderOffsetY) / this.zoom };
        },
        applyTransform(ctx) {
            ctx.setTransform(this.zoom * dpr, 0, 0, this.zoom * dpr, this.renderOffsetX * dpr, this.renderOffsetY * dpr);
        },
    };
    renderer.terrainCacheKey = 'test-terrain';
    renderer.assets = { assetVersion: '1', get: () => null };
    return renderer;
}

function assertDisjointIntegerRectsCoverExactUnion(disjointRects, inputRects, label) {
    for (const r of disjointRects) {
        assert.ok(Number.isInteger(r.x0) && Number.isInteger(r.y0) && Number.isInteger(r.x1) && Number.isInteger(r.y1),
            `${label}: integer bounds ${JSON.stringify(r)}`);
        assert.ok(r.x1 > r.x0 && r.y1 > r.y0, `${label}: non-empty rect ${JSON.stringify(r)}`);
    }
    for (let i = 0; i < disjointRects.length; i++) {
        for (let j = i + 1; j < disjointRects.length; j++) {
            const a = disjointRects[i];
            const b = disjointRects[j];
            const overlaps = a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;
            assert.equal(overlaps, false, `${label}: rects ${i} and ${j} overlap: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
        }
    }
    // Verify pixel-for-pixel union identity across the bounding box of inputs.
    if (!inputRects.length) {
        assert.equal(disjointRects.length, 0);
        return;
    }
    const minX = Math.min(...inputRects.map(r => r.x0));
    const minY = Math.min(...inputRects.map(r => r.y0));
    const maxX = Math.max(...inputRects.map(r => r.x1));
    const maxY = Math.max(...inputRects.map(r => r.y1));
    for (let y = minY; y < maxY; y++) {
        for (let x = minX; x < maxX; x++) {
            const inInput = inputRects.some(r => x >= r.x0 && x < r.x1 && y >= r.y0 && y < r.y1);
            const inOut = disjointRects.filter(r => x >= r.x0 && x < r.x1 && y >= r.y0 && y < r.y1).length;
            assert.equal(inOut, inInput ? 1 : 0, `${label}: pixel (${x},${y}) coverage mismatch`);
        }
    }
}

test('sparse disjoint pool layer matches reference byte-for-byte across consecutive frames, motion, overlaps, masks, DPR and resizes', () => {
    const originalDocument = globalThis.document;
    const { doc, makeCanvas } = createSoftwareDocument();
    globalThis.document = doc;
    try {
        const clear = { type: 'clear', intensity: 0, cloudCover: 0.08 };
        const nightGrade = evaluateGrade({ minuteOfDay: 23.88 * 60, weather: clear, moonFill: 0.5 });
        const receiver = gradedPoolReceiver(nightGrade);

        const warmLarge = buildPoolDodgeStamp({
            rgb: [255, 201, 94], radius: 22, cell: 1, energy: 0.9375,
            ambientTint: nightGrade.ambientTint, poolGain: nightGrade.poolGain, receiver,
        });
        const warmSmall = buildPoolDodgeStamp({
            rgb: [255, 168, 72], radius: 14, cell: 1, energy: 0.75,
            ambientTint: nightGrade.ambientTint, poolGain: nightGrade.poolGain, receiver,
            height: 8, normal: [-Math.SQRT1_2, Math.SQRT1_2],
        });
        const coolLamp = buildPoolDodgeStamp({
            rgb: [120, 195, 255], radius: 18, cell: 1, energy: 0.875,
            ambientTint: nightGrade.ambientTint, poolGain: nightGrade.poolGain, receiver,
        });
        assert.equal(warmLarge._poolShade, true);
        assert.equal(coolLamp._poolShade, false);

        const coastBake = makeCoastBakeWithHoles(200, 140);
        const opt = makeRenderer({ width: 180, height: 120, zoom: 1, dpr: 1, coastBake });
        const ref = makeRenderer({ width: 180, height: 120, zoom: 1, dpr: 1, coastBake });
        installReferencePoolMethods(ref);
        // Share the exact same receiver mask canvas on ref as opt gets from poolReceiverMask
        const origOptMask = IsometricRenderer.prototype._maskPoolLayers;
        ref._maskPoolLayers = function(rect) {
            // Invoke real poolReceiverMask with ref, then apply full-canvas destination-in (exact original)
            const pools = this._poolLayerContexts;
            if (!pools?.dodge) return;
            origOptMask.call({
                ...this,
                _poolShadeUsed: true,
                _poolLayerContexts: {
                    dodge: {
                        save() {}, restore() {}, setTransform() {}, beginPath() {}, rect() {}, clip() {},
                        drawImage: (canvas, x, y) => { this._testMask = { canvas, x, y }; },
                    },
                    shade: null,
                },
            }, rect);
            const mask = this._testMask;
            if (!mask) return;
            for (const layerCtx of [pools.dodge, pools.shade]) {
                if (!layerCtx) continue;
                layerCtx.save();
                layerCtx.setTransform(1, 0, 0, 1, 0, 0);
                layerCtx.imageSmoothingEnabled = false;
                layerCtx.globalCompositeOperation = 'destination-in';
                this.camera.applyTransform(layerCtx);
                layerCtx.drawImage(mask.canvas, mask.x, mask.y);
                layerCtx.restore();
            }
        };

        const frames = [
            {
                name: 'frame 1: overlapping + isolated warm & cool lamps with water mask holes',
                width: 180, height: 120, dpr: 1, zoom: 1, offsetX: 0, offsetY: 0,
                stamps: [
                    { stamp: warmLarge, x: 32, y: 30 },
                    { stamp: warmSmall, x: 46, y: 36 }, // overlaps warmLarge
                    { stamp: warmLarge, x: 135, y: 26 }, // isolated top-right
                    { stamp: coolLamp, x: 145, y: 92 }, // isolated bottom-right cool-only
                    { stamp: warmSmall, x: 24, y: 95 }, // bottom-left (leaves hollow center!)
                    { stamp: warmSmall, x: -50, y: -50 }, // completely off-screen
                ],
            },
            {
                name: 'frame 2: moving lamps (tests stale dirty rect clearing, no ghosting)',
                width: 180, height: 120, dpr: 1, zoom: 1, offsetX: 6, offsetY: -4,
                stamps: [
                    { stamp: warmLarge, x: 75, y: 60 },
                    { stamp: warmSmall, x: 88, y: 64 },
                    { stamp: coolLamp, x: 22, y: 22 },
                ],
            },
            {
                name: 'frame 3: cool-only lamps (tests clearing prior shade rects + skipping shade pass)',
                width: 180, height: 120, dpr: 1, zoom: 1, offsetX: 6, offsetY: -4,
                stamps: [
                    { stamp: coolLamp, x: 60, y: 45 },
                    { stamp: coolLamp, x: 120, y: 80 },
                ],
            },
            {
                name: 'frame 4: empty frame (no lamps stamped)',
                width: 180, height: 120, dpr: 1, zoom: 1, offsetX: 6, offsetY: -4,
                stamps: [],
            },
            {
                name: 'frame 5: fractional transform + edge clipping + hollow ring of 4 lamps',
                width: 180, height: 120, dpr: 1.5, zoom: 1.5, offsetX: 3.25, offsetY: 1.5,
                stamps: [
                    { stamp: warmLarge, x: 50, y: 20 },
                    { stamp: warmLarge, x: 50, y: 62 },
                    { stamp: warmSmall, x: 24, y: 41 },
                    { stamp: warmSmall, x: 76, y: 41 },
                    { stamp: coolLamp, x: 118, y: 78 }, // clips right/bottom edge
                ],
            },
            {
                name: 'frame 6: viewport resize + warm lamps',
                width: 140, height: 96, dpr: 1, zoom: 1, offsetX: 0, offsetY: 0,
                stamps: [
                    { stamp: warmLarge, x: 40, y: 44 },
                    { stamp: warmSmall, x: 100, y: 48 },
                ],
            },
        ];

        for (const frame of frames) {
            const base = makeBackdrop(makeCanvas, frame.width, frame.height);
            const runOn = (renderer) => {
                renderer._screenDpr = () => frame.dpr;
                renderer.camera.zoom = frame.zoom;
                renderer.camera.renderOffsetX = frame.offsetX;
                renderer.camera.renderOffsetY = frame.offsetY;
                const target = makeCanvas();
                target.width = frame.width;
                target.height = frame.height;
                target._pixels.set(base._pixels);
                const ctx = target.getContext('2d');
                ctx.setTransform(frame.dpr, 0, 0, frame.dpr, 0, 0);
                const viewport = { width: frame.width, height: frame.height };
                const pools = renderer._beginPoolLayer(ctx, viewport);
                for (const s of frame.stamps) renderer._stampPool(pools, s.stamp, s.x, s.y);
                renderer._landPoolLayer(ctx);
                return target;
            };

            const optOut = runOn(opt);
            const refOut = runOn(ref);
            assert.deepEqual(optOut._pixels, refOut._pixels, `${frame.name}: RGBA bytes must match reference`);

            if (frame.stamps.length > 0 && opt._poolDirtyDodgeRects) {
                assertDisjointIntegerRectsCoverExactUnion(opt._poolDirtyDodgeRects, opt._poolDodgeStamps, `${frame.name} dodge`);
                if (opt._poolShadeUsed) {
                    assertDisjointIntegerRectsCoverExactUnion(opt._poolDirtyShadeRects, opt._poolShadeStamps, `${frame.name} shade`);
                }
            }
        }
    } finally {
        globalThis.document = originalDocument;
    }
});

test('avoids shade layer allocation, masking, clearing, and multiply compositing when no stamp uses shade', () => {
    const originalDocument = globalThis.document;
    const { doc, makeCanvas } = createSoftwareDocument();
    globalThis.document = doc;
    try {
        const coolStamp = makeCanvas();
        coolStamp.width = 16;
        coolStamp.height = 8;
        coolStamp._poolCells = 16;
        coolStamp._poolRows = 8;
        coolStamp._poolCellPx = 1;
        coolStamp._poolShade = false;
        coolStamp._pixels.fill(180);

        const warmStamp = makeCanvas();
        warmStamp.width = 32;
        warmStamp.height = 8;
        warmStamp._poolCells = 16;
        warmStamp._poolRows = 8;
        warmStamp._poolCellPx = 1;
        warmStamp._poolShade = true;
        warmStamp._pixels.fill(200);

        const coastBake = makeCoastBakeWithHoles(200, 120);
        const renderer = makeRenderer({ width: 200, height: 120, coastBake });
        const target = makeCanvas();
        target.width = 200;
        target.height = 120;
        const ctx = target.getContext('2d');
        const viewport = { width: 200, height: 120 };

        // Frame 1: cool-only stamps -> _poolShadeLayer is never allocated and multiply is never drawn.
        let pools = renderer._beginPoolLayer(ctx, viewport);
        renderer._stampPool(pools, coolStamp, 30, 30);
        renderer._stampPool(pools, coolStamp, 160, 80);
        renderer._landPoolLayer(ctx);

        assert.equal(renderer._poolShadeLayer, null, 'shade canvas must stay unallocated for cool-only frames');
        assert.equal(renderer._poolShadeUsed, false);
        const multiplyOps1 = target._opsLog.filter(o => o.kind === 'drawImage' && o.op === 'multiply');
        const dodgeOps1 = target._opsLog.filter(o => o.kind === 'drawImage' && o.op === 'color-dodge');
        assert.equal(multiplyOps1.length, 0, 'no multiply draw when shade is unused');
        assert.equal(dodgeOps1.length, 2, 'two disjoint sparse color-dodge blits instead of one full union bbox');

        // Frame 2: one warm + one isolated cool stamp -> shade only masks/lands the warm stamp rect.
        target._opsLog.length = 0;
        pools = renderer._beginPoolLayer(ctx, viewport);
        renderer._stampPool(pools, warmStamp, 30, 30);
        renderer._stampPool(pools, coolStamp, 160, 80);
        renderer._landPoolLayer(ctx);

        assert.ok(renderer._poolShadeLayer, 'shade canvas allocated lazily on first warm stamp');
        const shadeMaskOps2 = renderer._poolShadeLayer._opsLog.filter(o => o.kind === 'drawImage' && o.op === 'destination-in');
        const multiplyOps2 = target._opsLog.filter(o => o.kind === 'drawImage' && o.op === 'multiply');
        assert.equal(shadeMaskOps2.length, 1, 'shade masked only on the warm stamp rect');
        assert.equal(multiplyOps2.length, 1, 'multiply landed only on the warm stamp rect');
        assert.equal(multiplyOps2[0].sw, 16);
        assert.equal(multiplyOps2[0].sh, 8);

        // Frame 3: back to cool-only -> previous warm shade rect is refilled once, then shade is not masked or landed.
        target._opsLog.length = 0;
        renderer._poolShadeLayer._opsLog.length = 0;
        pools = renderer._beginPoolLayer(ctx, viewport);
        renderer._stampPool(pools, coolStamp, 100, 60);
        renderer._landPoolLayer(ctx);

        const shadeRefills3 = renderer._poolShadeLayer._opsLog.filter(o => o.kind === 'fillRect');
        const shadeMaskOps3 = renderer._poolShadeLayer._opsLog.filter(o => o.kind === 'drawImage' && o.op === 'destination-in');
        const multiplyOps3 = target._opsLog.filter(o => o.kind === 'drawImage' && o.op === 'multiply');
        assert.equal(shadeRefills3.length, 1, 'prior dirty shade rect restored to white');
        assert.equal(shadeMaskOps3.length, 0, 'shade not masked on cool-only frame');
        assert.equal(multiplyOps3.length, 0, 'multiply not landed on cool-only frame');

        // Frame 4: cool-only again -> shade layer is already clean, zero shade ops at all.
        renderer._poolShadeLayer._opsLog.length = 0;
        pools = renderer._beginPoolLayer(ctx, viewport);
        renderer._stampPool(pools, coolStamp, 120, 60);
        renderer._landPoolLayer(ctx);
        assert.equal(renderer._poolShadeLayer._opsLog.length, 0, 'clean shade layer untouched on subsequent cool-only frame');
    } finally {
        globalThis.document = originalDocument;
    }
});

test('uses source-over for non-overlapping stamps, switches to lighten/darken on overlap, and recovers cleanly if _landPoolLayer is skipped', () => {
    const originalDocument = globalThis.document;
    const { doc, makeCanvas } = createSoftwareDocument();
    globalThis.document = doc;
    try {
        const stamp = makeCanvas();
        stamp.width = 40;
        stamp.height = 10;
        stamp._poolCells = 20;
        stamp._poolRows = 10;
        stamp._poolCellPx = 1;
        stamp._poolShade = true;
        stamp._pixels.fill(160);

        const renderer = makeRenderer({ width: 200, height: 100 });
        const target = makeCanvas();
        target.width = 200;
        target.height = 100;
        const ctx = target.getContext('2d');
        const viewport = { width: 200, height: 100 };

        const pools = renderer._beginPoolLayer(ctx, viewport);
        renderer._stampPool(pools, stamp, 30, 30); // isolated -> source-over
        renderer._stampPool(pools, stamp, 36, 32); // overlaps first -> lighten / darken
        renderer._stampPool(pools, stamp, 150, 70); // isolated -> source-over

        const dodgeDraws = renderer._poolLayer._opsLog.filter(o => o.kind === 'drawImage');
        const shadeDraws = renderer._poolShadeLayer._opsLog.filter(o => o.kind === 'drawImage');
        assert.deepEqual(dodgeDraws.map(o => o.op), ['source-over', 'lighten', 'source-over']);
        assert.deepEqual(shadeDraws.map(o => o.op), ['source-over', 'darken', 'source-over']);

        // Skip _landPoolLayer intentionally, then begin the next frame: fallback bbox reset must clear both layers cleanly.
        renderer._beginPoolLayer(ctx, viewport);
        for (let i = 3; i < renderer._poolLayer._pixels.length; i += 4) {
            assert.equal(renderer._poolLayer._pixels[i], 0, 'dodge canvas fully cleared after skipped land');
        }
        for (let i = 0; i < renderer._poolShadeLayer._pixels.length; i += 4) {
            assert.equal(renderer._poolShadeLayer._pixels[i], 255, 'shade canvas fully restored to white after skipped land');
            assert.equal(renderer._poolShadeLayer._pixels[i + 1], 255);
            assert.equal(renderer._poolShadeLayer._pixels[i + 2], 255);
            assert.equal(renderer._poolShadeLayer._pixels[i + 3], 255);
        }

        // Simulate dispose()/invalidateViewportCaches() clearing the canvases externally.
        renderer._poolLayer = null;
        renderer._poolShadeLayer = null;
        renderer._poolLayerRect = null;
        const poolsAfterDispose = renderer._beginPoolLayer(ctx, viewport);
        renderer._stampPool(poolsAfterDispose, stamp, 50, 50);
        renderer._landPoolLayer(ctx);
        assert.ok(renderer._poolLayer && renderer._poolShadeLayer);
        assert.equal(renderer._poolDirtyDodgeRects.length, 1);
    } finally {
        globalThis.document = originalDocument;
    }
});
