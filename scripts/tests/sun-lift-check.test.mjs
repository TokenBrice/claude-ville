import test from 'node:test';
import assert from 'node:assert/strict';

import { BRIGHT_RISE, CANDLE, GLOW_BAND, liftVerdict, lumaAt } from '../smoke/support/sun-lift-check.mjs';

// SD-3 — smoke:sun-lift's verdict on one integer luma, in two bands.

test('a pixel under the glow band may not end above the open-sun lift ceiling', () => {
    assert.equal(CANDLE, 210);
    assert.equal(GLOW_BAND, 205);
    assert.deepEqual(liftVerdict(204, 211), { band: 'low', over: true, rise: 7 });
    assert.deepEqual(liftVerdict(204, 210), { band: 'low', over: false, rise: 6 });
    assert.deepEqual(liftVerdict(150, 168), { band: 'low', over: false, rise: 18 });
});

test('a pixel from the glow band up may rise by at most 5, and every rise is counted', () => {
    assert.equal(BRIGHT_RISE, 5);
    assert.deepEqual(liftVerdict(205, 206), { band: 'high', over: false, rise: 1 }, '205 -> 206: the known residual band');
    assert.deepEqual(liftVerdict(205, 209), { band: 'high', over: false, rise: 4 }, 'a highlight near the line');
    assert.deepEqual(liftVerdict(212, 217), { band: 'high', over: false, rise: 5 }, '212 -> 217 is within the bound');
    assert.deepEqual(liftVerdict(212, 213), { band: 'high', over: false, rise: 1 }, '212 -> 213 is counted');
    assert.deepEqual(liftVerdict(212, 218), { band: 'high', over: true, rise: 6 });
    assert.deepEqual(liftVerdict(212, 212), { band: 'high', over: false, rise: 0 });
});

test('both frames are read through one rounding', () => {
    const data = new Uint8Array([200, 200, 200, 255, 255, 255, 255, 255]);
    assert.equal(lumaAt(data, 0), 200);
    assert.equal(lumaAt(data, 4), 255);
    assert.ok(Number.isInteger(lumaAt(new Uint8Array([13, 77, 201, 255]), 0)));
});
