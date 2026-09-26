import test from 'node:test';
import assert from 'node:assert/strict';

import { marginAt, wallTimeline } from '../audio/lib/timeline.mjs';

const SR = 48000;
const CHUNK = 4096;
const CHUNK_SEC = CHUNK / SR;

// A tapped capture: `segments` of constant-value chunks with contiguous
// audio-clock frames (a suspended context resumes on the next frame), each
// segment starting at its own wall time; `delay(k)` adds main-thread message
// latency to chunk k.
function capture(segments, delay = () => 0) {
    const chunkTimes = [];
    const values = [];
    let frame = 0;
    let k = 0;
    for (const { wallSec, seconds, value } of segments) {
        const frame0 = frame;
        for (let i = 0; i < Math.round(seconds / CHUNK_SEC); i++, k++) {
            const arrival = wallSec + (frame - frame0 + CHUNK) / SR + 0.004 + delay(k);
            chunkTimes.push([frame, CHUNK, arrival * 1000]);
            values.push(value);
            frame += CHUNK;
        }
    }
    const L = new Float32Array(values.length * CHUNK);
    values.forEach((v, i) => L.fill(v, i * CHUNK, (i + 1) * CHUNK));
    return { tap: { sampleRate: SR, chunkTimes }, pcm: { L, R: L } };
}

function firstIndex(buf, from, predicate) {
    for (let i = from; i < buf.length; i++) if (predicate(buf[i])) return i;
    return -1;
}

test('a suspended stretch of wall time becomes silence of the same length', () => {
    const { tap, pcm } = capture([
        { wallSec: 10, seconds: 4, value: 0.1 },
        { wallSec: 20, seconds: 2, value: 0.5 },
    ]);
    const tl = wallTimeline(tap, pcm);
    const resumeAt = firstIndex(tl.L, 0, v => v === 0.5) / SR;
    assert.ok(Math.abs(resumeAt - (20 - tl.wall0)) < 0.01, `resume lands at ${resumeAt}`);
    const lastBed = firstIndex(tl.L, 0, v => v === 0) / SR;
    assert.ok(Math.abs(lastBed - 4) < CHUNK_SEC + 0.01, `bed ends at ${lastBed}`);
    assert.equal(tl.L[Math.round((resumeAt - 3) * SR)], 0);
});

test('a late message does not move its audio', () => {
    const late = new Set([20, 21, 22]);
    const { tap, pcm } = capture([{ wallSec: 5, seconds: 6, value: 0.2 }], k => (late.has(k) ? 0.4 : 0));
    const tl = wallTimeline(tap, pcm);
    assert.equal(firstIndex(tl.L, 0, v => v === 0), -1, 'no hole opened by the delay');
    assert.equal(tl.L.length, pcm.L.length, 'no stretch or overlap');
});

test('a cue over silence is scored against the floor, not -Infinity', () => {
    const momentary = [];
    for (let end = 0.4; end <= 10; end += 0.1) momentary.push([end, end > 6.2 && end < 7.5 ? -50 : -Infinity]);
    const m = marginAt(momentary, 6, { bedWindowSec: 3, cueWindowSec: 2.5, silenceFloorLufs: -80 });
    assert.equal(m.bed, -Infinity);
    assert.equal(m.cueMax, -50);
    assert.equal(m.margin, 30);
});

test('silence inside the bed window pulls the bed level down by its share', () => {
    const momentary = [];
    for (let end = 0.4; end <= 10; end += 0.1) {
        const t = Number(end.toFixed(1));
        momentary.push([t, t <= 4.5 ? -40 : t < 6.2 ? -Infinity : -38]);
    }
    const m = marginAt(momentary, 6, { bedWindowSec: 3, cueWindowSec: 2.5, silenceFloorLufs: -80 });
    // Blocks ending in (3, 6]: 15 at -40 LUFS, 15 silent → half the energy, -3 dB.
    assert.ok(Math.abs(m.bed - (-43.01)) < 0.05, `bed ${m.bed}`);
    assert.ok(Math.abs(m.margin - (m.cueMax - m.bed)) < 1e-9);
});
