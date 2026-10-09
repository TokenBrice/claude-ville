import test from 'node:test';
import assert from 'node:assert/strict';

import { AgentStatus } from '../../claudeville/src/domain/value-objects/AgentStatus.js';
import { GPU_RECORD_FLAGS } from '../../claudeville/src/presentation/character-mode/gpu/GpuWorldPolicy.js';
import {
    attentionMarkRecords,
    drawAttentionPlates,
    inkMarkRecords,
    layoutAttentionPlates,
} from '../../claudeville/src/presentation/character-mode/AttentionPlates.js';
import { LABEL_INK } from '../../claudeville/src/presentation/character-mode/WorldLabelKit.js';
import { PEAK, armPeakMarks, crown, takePeakMarks } from '../../claudeville/src/presentation/character-mode/EffectStamps.js';

// T1 (plan 5.1): action-needed agents stay unmissable. Layout is pure given a
// measuring context and a camera, so it runs in plain Node.
const ctx = { font: '', measureText: text => ({ width: String(text).length * 7 }) };
const camera = { worldToScreen: (x, y) => ({ x, y: y + 300 }) };
const viewport = { width: 1600, height: 900 };

function sprite(id, status, x, since = null) {
    return { x, y: 0, agent: { id, name: id, status, statusSince: since } };
}

test('every action-needed agent gets a beacon and a plate; quiet agents get neither', () => {
    const now = 100_000;
    const layout = layoutAttentionPlates(ctx, {
        sprites: [
            sprite('w', AgentStatus.WAITING_ON_USER, 100, now - 13_000),
            sprite('e', AgentStatus.ERRORED, 600),
            sprite('q', AgentStatus.RATE_LIMITED, 1100, now - 5_000),
            sprite('k', AgentStatus.WORKING, 1400),
            sprite('i', AgentStatus.IDLE, 1500),
        ],
        camera, viewport, now,
    });
    assert.equal(layout.count, 3);
    assert.equal(layout.beacons.length, 3);
    const byName = Object.fromEntries(layout.plates.map(plate => [plate.text, plate]));
    assert.equal(byName.w.word, 'NEEDS YOU');
    assert.equal(byName.w.age, '13s');
    assert.equal(byName.e.word, 'ERROR');
    assert.equal(byName.q.word, 'LIMIT');
    // Rate limit shows its age.
    assert.equal(byName.q.age, '5s');
});

test('three or more colliding plates collapse to one exact group plate; each body keeps its beacon', () => {
    const now = 100_000;
    const sprites = Array.from({ length: 9 }, (_, index) =>
        sprite(`Wait ${index + 1}`, AgentStatus.WAITING_ON_USER, 400 + index * 6, now - (20_000 - index * 1000)));
    const layout = layoutAttentionPlates(ctx, { sprites, camera, viewport, now });
    assert.equal(layout.beacons.length, 9);
    assert.equal(layout.plates.length, 1);
    assert.equal(layout.plates[0].members, 9);
    assert.equal(layout.plates[0].text, '9 · oldest Wait 1');
    assert.equal(layout.plates[0].age, '20s');
});

test('stacked plates never overlap, and an arriving agent has no plate yet', () => {
    const sprites = [
        sprite('a', AgentStatus.ERRORED, 400),
        sprite('b', AgentStatus.ERRORED, 430),
        { ...sprite('c', AgentStatus.ERRORED, 900), isArrivalPending: () => true },
    ];
    const layout = layoutAttentionPlates(ctx, { sprites, camera, viewport });
    assert.equal(layout.plates.length, 2);
    const [a, b] = layout.plates.map(plate => plate.rect);
    const overlap = a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
    assert.equal(overlap, false);
});

// A tiny 2D raster: integer-scale transforms, opaque fills, clears, stamp
// blits (source-over or destination-out) and recorded text. Pixels hold the
// ink string ('' = transparent), so two paths compare exactly.
class RasterCanvas {
    constructor(width = 0, height = 0) {
        this._w = width;
        this._h = height;
        this.px = new Array(width * height).fill('');
    }
    get width() { return this._w; }
    set width(value) { this._w = value; this.px = new Array(this._w * this._h).fill(''); }
    get height() { return this._h; }
    set height(value) { this._h = value; this.px = new Array(this._w * this._h).fill(''); }
    at(x, y) { return x >= 0 && y >= 0 && x < this._w && y < this._h ? this.px[y * this._w + x] : ''; }
    getContext() { return this.ctx || (this.ctx = new RasterContext(this)); }
}

class RasterContext {
    constructor(canvas) {
        this.canvas = canvas;
        this.fillStyle = '';
        this.font = '';
        this.globalCompositeOperation = 'source-over';
        this.globalAlpha = 1;
        this.m = [1, 0, 0, 1, 0, 0];
        this.stack = [];
        this.texts = [];
    }
    save() { this.stack.push({ m: [...this.m], op: this.globalCompositeOperation, fill: this.fillStyle }); }
    restore() {
        const state = this.stack.pop();
        this.m = state.m;
        this.globalCompositeOperation = state.op;
        this.fillStyle = state.fill;
    }
    setTransform(a, b, c, d, e, f) { this.m = [a, b, c, d, e, f]; }
    getTransform() { const [a, b, c, d, e, f] = this.m; return { a, b, c, d, e, f }; }
    measureText(text) { return { width: String(text).length * 7 }; }
    fillText(text, x, y) { this.texts.push(text); }
    _rect(x, y, w, h, value) {
        const [a, , , d, e, f] = this.m;
        for (let py = y * d + f; py < (y + h) * d + f; py++) {
            for (let px = x * a + e; px < (x + w) * a + e; px++) {
                if (px >= 0 && py >= 0 && px < this.canvas.width && py < this.canvas.height) this.canvas.px[py * this.canvas.width + px] = value;
            }
        }
    }
    // A 'transparent' fill paints nothing, as on a real canvas.
    fillRect(x, y, w, h) { if (this.fillStyle !== 'transparent') this._rect(x, y, w, h, this.fillStyle); }
    clearRect(x, y, w, h) { this._rect(x, y, w, h, ''); }
    drawImage(source, dx, dy) {
        for (let y = 0; y < source.height; y++) {
            for (let x = 0; x < source.width; x++) {
                const ink = source.at(x, y);
                if (!ink) continue;
                const tx = dx + x;
                const ty = dy + y;
                if (tx < 0 || ty < 0 || tx >= this.canvas.width || ty >= this.canvas.height) continue;
                this.canvas.px[ty * this.canvas.width + tx] = this.globalCompositeOperation === 'destination-out' ? '' : ink;
            }
        }
    }
}

// The mark pass as the WebGL2 shader runs it: each record's backing-pixel
// rect, nearest-sampled from its source at pixel centres, source-over.
function rasterRecords(records, width, height) {
    const out = new RasterCanvas(width, height);
    for (const record of records) {
        for (let py = record.y; py < record.y + record.height; py++) {
            for (let px = record.x; px < record.x + record.width; px++) {
                const sx = record.sx + Math.floor(((px + 0.5 - record.x) / record.width) * record.sw);
                const sy = record.sy + Math.floor(((py + 0.5 - record.y) / record.height) * record.sh);
                const ink = record.source.at(sx, sy);
                if (ink && px >= 0 && py >= 0 && px < width && py < height) out.px[py * width + px] = ink;
            }
        }
    }
    return out;
}

test('resident mark records paint exactly the overlay plate pixels, and the ink-only overlay clears exactly them', () => {
    const previousDocument = globalThis.document;
    globalThis.document = { createElement: () => new RasterCanvas() };
    try {
        const now = 2_000_000;
        const layout = layoutAttentionPlates(ctx, {
            sprites: [
                // A stacked pair (the second keeps a leader), a lone plate,
                // and two agents beyond the frame (top and right edge plates).
                // Ages cover every wait-age rung: the ringed medallion (6 min),
                // the 3× beacon (16 min), a fresh wait, one notch (90 s) and
                // an unknown age.
                sprite('a', AgentStatus.ERRORED, 400, now - 360_000),
                sprite('b', AgentStatus.ERRORED, 440, now - 960_000),
                sprite('w', AgentStatus.WAITING_ON_USER, 900, now - 20_000),
                sprite('far', AgentStatus.RATE_LIMITED, 2400),
                { ...sprite('up', AgentStatus.WAITING_ON_USER, 700, now - 90_000), y: -900 },
            ],
            camera, viewport, now,
        });
        assert.ok(layout.plates.some(plate => plate.side) && layout.plates.some(plate => !plate.side && plate.tip - plate.rect.bottom > 3));
        assert.deepEqual(layout.beacons.map(beacon => [beacon.step, beacon.ring]).sort(), [[2, false], [2, true], [3, false]]);
        for (const scale of [1, 2]) {
            const width = viewport.width * scale;
            const height = viewport.height * scale;
            const overlay = new RasterCanvas(width, height);
            const overlayCtx = overlay.getContext('2d');
            overlayCtx.setTransform(scale, 0, 0, scale, 0, 0);
            drawAttentionPlates(overlayCtx, layout);

            const records = attentionMarkRecords(layout, { scale, out: [] });
            assert.ok(records.length > 0);
            for (const record of records) assert.ok(record.flags & GPU_RECORD_FLAGS.screenSpace);
            const gpu = rasterRecords(records, width, height);
            assert.deepEqual(gpu.px, overlay.px, `mark records match the overlay at scale ${scale}`);

            // Role 2 (10.2's mark gain) lands only on status-colour pixels:
            // no role-2 record carries the outline or the plate ink, so the
            // gain never lifts a dark ink.
            for (const record of records) {
                if (!(record.flags & GPU_RECORD_FLAGS.actionMark)) continue;
                for (let sy = record.sy; sy < record.sy + record.sh; sy++) {
                    for (let sx = record.sx; sx < record.sx + record.sw; sx++) {
                        const ink = record.source.at(sx, sy);
                        assert.ok(ink !== LABEL_INK.plateOutline && ink !== LABEL_INK.plate, `role-2 record samples ${ink}`);
                    }
                }
            }

            // Ink only: over a fully painted overlay, the plates clear exactly
            // the mark pixels and still print every text run.
            const inked = new RasterCanvas(width, height);
            inked.px.fill('under');
            const inkedCtx = inked.getContext('2d');
            inkedCtx.setTransform(scale, 0, 0, scale, 0, 0);
            drawAttentionPlates(inkedCtx, layout, { inkOnly: true });
            assert.deepEqual(inked.px.map(ink => ink === ''), gpu.px.map(ink => ink !== ''));
            assert.deepEqual(inkedCtx.texts, overlayCtx.texts);
        }
    } finally {
        globalThis.document = previousDocument;
    }
});

// 10.2 — the C4 verified-success peak frame (the release crown's cream
// frame) at the mark gain: on an armed whole-pixel overlay its cream texels
// become role-2 GPU records and leave the overlay, so overlay-over-GPU is the
// overlay-only picture exactly; off the pixel grid it stays on the overlay.
test('a verified-success peak frame hands exactly its cream texels to role-2 records on a whole-pixel overlay', () => {
    const previousDocument = globalThis.document;
    globalThis.document = { createElement: () => new RasterCanvas() };
    const stamp = overlayCtx => crown(overlayCtx, 30, 24, { radius: 9, ramp: [PEAK, PEAK, PEAK], jewel: PEAK, core: PEAK, outline: LABEL_INK.plateOutline, peakMark: true });
    const paint = (transform, armed) => {
        const overlay = new RasterCanvas(160, 120);
        overlay.px.fill('under');
        const overlayCtx = overlay.getContext('2d');
        overlayCtx.setTransform(...transform);
        armPeakMarks(armed ? overlayCtx : null);
        stamp(overlayCtx);
        const records = inkMarkRecords(takePeakMarks(), PEAK, { out: [], pool: [] });
        armPeakMarks(null);
        return { overlay, records };
    };
    try {
        for (const transform of [[1, 0, 0, 1, 0, 0], [2, 0, 0, 2, 17, -6]]) {
            const shipped = paint(transform, false);
            assert.equal(shipped.records.length, 0, 'an unarmed overlay keeps the whole peak');
            const armed = paint(transform, true);
            assert.ok(armed.records.length > 0);
            for (const record of armed.records) {
                assert.ok(record.flags & GPU_RECORD_FLAGS.screenSpace);
                assert.ok(record.flags & GPU_RECORD_FLAGS.actionMark, 'the peak cream is role 2');
            }
            const gpu = rasterRecords(armed.records, 160, 120);
            assert.ok(gpu.px.every(ink => ink === '' || ink === PEAK), 'only cream goes to the GPU; the crown ink stays on the overlay');
            const composited = armed.overlay.px.map((ink, index) => ink || gpu.px[index]);
            assert.deepEqual(composited, shipped.overlay.px, `overlay over GPU marks is the overlay-only peak at ${transform}`);
        }
        // A sub-pixel camera offset puts no texel on whole pixels: the peak
        // stays on the overlay.
        const offGrid = paint([2, 0, 0, 2, 16.5, 0], true);
        assert.equal(offGrid.records.length, 0);
    } finally {
        armPeakMarks(null);
        globalThis.document = previousDocument;
    }
});
