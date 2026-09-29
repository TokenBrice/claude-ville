import test from 'node:test';
import assert from 'node:assert/strict';

import { bakeEmitterCycle } from '../../claudeville/src/presentation/character-mode/EmitterCycle.js';

// A painted fire 12 × 16: a dark crown (rows 0-5), orange tongues licking up
// into it at varying heights, a light-orange course, a yellow bed (rows 13-14)
// on a darker threshold edge (row 15).
const W = 12;
const H = 16;
const CROWN = [0x40, 0x10, 0x08];
const ORANGE = [0xe0, 0x50, 0x10];
const LIGHT = [0xf0, 0x90, 0x20];
const BED = [0xff, 0xd0, 0x70];
const EDGE = [0xe8, 0x80, 0x30];
const TIPS = [8, 7, 6, 7, 9, 8, 6, 7, 8, 10, 7, 6]; // first orange row per column

function paintedFire() {
    const data = new Uint8ClampedArray(W * H * 4);
    const mask = new Uint8ClampedArray(W * H * 4);
    for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
            const colour = y === 15 ? EDGE : y >= 13 ? BED : y >= TIPS[x] + 3 ? LIGHT : y >= TIPS[x] ? ORANGE : CROWN;
            const i = (y * W + x) * 4;
            data.set([...colour, 255], i);
            mask.set([255, 255, 255, 255], i);
        }
    }
    return { base: { width: W, height: H, data }, mask: { width: W, height: H, data: mask } };
}

const texel = (strip, phase, x, y) => {
    const o = (y * strip.width + phase * strip.frameW + x) * 4;
    return [strip.data[o], strip.data[o + 1], strip.data[o + 2]];
};
const same = (a, b) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
const tipOf = (strip, phase, x) => {
    for (let y = 0; y < H; y++) if (!same(texel(strip, phase, x, y), CROWN)) return y;
    return H;
};

test('tongue climb bakes 8 phases of authored texels from each texel\'s own column', () => {
    const { base, mask } = paintedFire();
    const strip = bakeEmitterCycle(base, mask, { mode: 'tongues', lanePx: 3, keepPx: 3, frames: 5 });
    assert.equal(strip.frames, 8);
    assert.equal(strip.width, W * 8);
    for (let phase = 0; phase < 8; phase++) {
        for (let x = 0; x < W; x++) {
            const column = Array.from({ length: H }, (_, y) => {
                const i = (y * W + x) * 4;
                return [base.data[i], base.data[i + 1], base.data[i + 2]];
            });
            for (let y = 0; y < H; y++) {
                const out = texel(strip, phase, x, y);
                assert.ok(column.some((c) => same(c, out)), `phase ${phase} (${x}, ${y}) is not an authored texel of column ${x}`);
            }
        }
    }
});

test('tongue climb keeps the bed and the crown above the reach, and only lifts tongues up to 4 texels', () => {
    const { base, mask } = paintedFire();
    const strip = bakeEmitterCycle(base, mask, { mode: 'tongues', lanePx: 3, keepPx: 3 });
    let lifted = 0;
    for (let phase = 0; phase < 8; phase++) {
        for (let x = 0; x < W; x++) {
            for (let y = 13; y < H; y++) assert.deepEqual(texel(strip, phase, x, y), y === 15 ? EDGE : BED, `bed moved at phase ${phase} (${x}, ${y})`);
            for (let y = 0; y < 2; y++) assert.deepEqual(texel(strip, phase, x, y), CROWN, `crown moved at phase ${phase} (${x}, ${y})`);
            const rise = TIPS[x] - tipOf(strip, phase, x);
            assert.ok(rise >= 0 && rise <= 4, `column ${x} tip moved ${rise} at phase ${phase}`);
            if (rise > 0) lifted++;
        }
    }
    assert.ok(lifted >= 8 * W / 3, 'the tongues should climb in most phases');
});
