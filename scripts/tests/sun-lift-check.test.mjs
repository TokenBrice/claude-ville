import test from 'node:test';
import assert from 'node:assert/strict';

import { BRIGHT_RISE, CANDLE, liftVerdict, lumaAt } from '../smoke/support/sun-lift-check.mjs';

// SD-3 — smoke:sun-lift's verdict on one integer luma.

test('a pixel at or under the candle may not end above it', () => {
    assert.equal(CANDLE, 192);
    assert.equal(liftVerdict(192, 193).over, true, '192 -> 193 crosses the candle');
    assert.equal(liftVerdict(192, 192).over, false);
    assert.equal(liftVerdict(150, 192).over, false);
});

test('a pixel above the candle may rise by at most 5, and every rise is counted', () => {
    assert.equal(BRIGHT_RISE, 5);
    assert.deepEqual(liftVerdict(202, 207), { over: false, brightRise: 5 }, '202 -> 207 is within the bound');
    assert.deepEqual(liftVerdict(202, 203), { over: false, brightRise: 1 }, '202 -> 203 is counted');
    assert.deepEqual(liftVerdict(202, 208), { over: true, brightRise: 6 });
    assert.deepEqual(liftVerdict(202, 202), { over: false, brightRise: 0 });
});

test('both frames are read through one rounding', () => {
    const data = new Uint8Array([200, 200, 200, 255, 255, 255, 255, 255]);
    assert.equal(lumaAt(data, 0), 200);
    assert.equal(lumaAt(data, 4), 255);
    assert.ok(Number.isInteger(lumaAt(new Uint8Array([13, 77, 201, 255]), 0)));
});
