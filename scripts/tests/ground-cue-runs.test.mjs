import assert from 'node:assert/strict';
import test from 'node:test';
import { CUE_RUN_DOTS, GroundCueRecorder } from '../../claudeville/src/presentation/character-mode/GroundCueRecords.js';
import { dottedCurve, ellipseArcDots } from '../../claudeville/src/presentation/character-mode/EffectStamps.js';
import { GPU_RECORD_FLAGS } from '../../claudeville/src/presentation/character-mode/gpu/GpuWorldPolicy.js';

// The record list a cue run stands for: the vertex stage's decode
// (GroundCueRecords.CUE_RUN_GLSL), one [x, y, w, h, alpha] per dot.
function expand(records) {
    const dots = [];
    for (const record of records) {
        if (!(record.flags & GPU_RECORD_FLAGS.cueRun)) {
            dots.push([record.x, record.y, record.width, record.height, record.alpha]);
            continue;
        }
        const words = [record.sx, record.sy, record.sx + record.sw, record.sy + record.sh];
        assert.ok(words.every(word => Number.isInteger(word) && word >= 0 && word < 2 ** 24), 'payload words are exact in float32');
        const head = words[0];
        const count = ((head >> 10) & 15) + 1;
        const baseX = ((head >> 14) & 15) - 8;
        const baseY = ((head >> 18) & 15) - 8;
        let x = words[1] & 255;
        let y = (words[1] >> 8) & 255;
        for (let k = 0; k < count; k++) {
            if (k > 0) {
                const j = k - 1;
                const word = j < 2 ? words[1] : j < 8 ? words[2] : words[3];
                const bits = (word >> (j < 2 ? 16 + 4 * j : 4 * (j < 8 ? j - 2 : j - 8))) & 15;
                x += baseX + (bits & 3);
                y += baseY + (bits >> 2);
            }
            const dot = [record.x + x, record.y + y, ((head >> 6) & 3) + 1, ((head >> 8) & 3) + 1, record.alpha];
            assert.ok(dot[0] + dot[2] <= record.x + record.width && dot[1] + dot[3] <= record.y + record.height, 'dots stay inside the run rect');
            dots.push(dot);
        }
    }
    return dots;
}

// Paint the same cue calls into the recorder and into a plain fillRect log.
function paintBoth(paint) {
    const rects = [];
    const log = {
        fillStyle: '#000', globalAlpha: 1,
        fillRect(x, y, w, h) { rects.push([x, y, w, h, this.globalAlpha]); },
        save() {}, restore() {},
    };
    const recorder = new GroundCueRecorder().begin(null);
    paint(log);
    paint(recorder);
    return { rects, records: recorder.end() };
}

test('texel-dot cues become dot runs that expand to exactly the per-dot records, in order', () => {
    const previousDocument = globalThis.document;
    const atlasCtx = { fillRect() {}, clearRect() {}, fillStyle: '' };
    globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: () => atlasCtx }) };
    try {
        const { rects, records } = paintBoth(ctx => {
            // A council loop: step-2 dots between 12 members, closing on itself
            // (each curve's end dot repeats the next curve's start).
            const members = Array.from({ length: 12 }, (_, i) => ({
                x: 400 + Math.cos(i / 12 * Math.PI * 2) * 180 + (i % 3) * 7.3,
                y: 300 + Math.sin(i / 12 * Math.PI * 2) * 90 - (i % 2) * 5.6,
            }));
            ctx.globalAlpha = 0.25;
            for (let i = 0; i < members.length; i++) {
                const a = members[i];
                const b = members[(i + 1) % members.length];
                dottedCurve(ctx, a.x, a.y, (a.x + b.x) / 2 + 9, (a.y + b.y) / 2 - 8, b.x, b.y, { step: 2, color: '#d9a441' });
            }
            // A marching family tether, a 2x2 trail with its terminal, a dot arc.
            ctx.globalAlpha = 0.5625;
            dottedCurve(ctx, 100.4, 80.2, 160, 20, 260.7, 90.1, { step: 4, phase: 3, color: '#8fb3d9' });
            ctx.globalAlpha = 1;
            dottedCurve(ctx, 20, 500, 60, 420, 150, 470, { step: 5, dot: 2, color: '#ffffff', end: true });
            ellipseArcDots(ctx, 600, 500, 40, 20, { step: 4, dot: 2, color: '#c04040' });
            // Scattered dots: steps far outside a run's window.
            ctx.fillStyle = '#40c040';
            for (let i = 0; i < 6; i++) ctx.fillRect(i * 37 % 200, i * 53 % 150, 1, 1);
        });
        assert.deepEqual(expand(records), rects);
        assert.ok(records.some(record => record.flags & GPU_RECORD_FLAGS.cueRun));
        assert.ok(records.length * 4 < rects.length, `${records.length} records for ${rects.length} dots`);
        assert.ok(records.every(record => !(record.flags & GPU_RECORD_FLAGS.cueRun)
            || (((record.sx >> 10) & 15) + 1) <= CUE_RUN_DOTS));
    } finally { globalThis.document = previousDocument; }
});

test('a stroke or fill between dots closes the open run, so records keep call order', () => {
    const previousDocument = globalThis.document;
    const atlasCtx = { fillRect() {}, clearRect() {}, fillStyle: '' };
    globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: () => atlasCtx }) };
    try {
        const recorder = new GroundCueRecorder().begin(null);
        recorder.fillStyle = '#ffffff';
        for (let i = 0; i < 4; i++) recorder.fillRect(10 + i * 2, 10, 1, 1);
        recorder.strokeStyle = '#ff0000';
        recorder.beginPath();
        recorder.moveTo(0.5, 40.5);
        recorder.lineTo(40.5, 40.5);
        recorder.stroke();
        for (let i = 0; i < 4; i++) recorder.fillRect(10 + i * 2, 12, 1, 1);
        const records = recorder.end();
        const firstRun = records.findIndex(record => record.flags & GPU_RECORD_FLAGS.cueRun);
        const lastRun = records.findLastIndex(record => record.flags & GPU_RECORD_FLAGS.cueRun);
        assert.equal(firstRun, 0);
        assert.equal(lastRun, records.length - 1);
        assert.ok(records.slice(1, -1).every(record => record.y === 40), 'the stroke sits between the two runs');
        assert.deepEqual(expand([records[0]]).map(dot => dot[0]), [10, 12, 14, 16]);
    } finally { globalThis.document = previousDocument; }
});
