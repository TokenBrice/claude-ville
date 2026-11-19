import test from 'node:test';
import assert from 'node:assert/strict';

import { BRIGHT_RISE, CANDLE, GLOW_BAND, liftVerdict, lumaAt } from '../smoke/support/sun-lift-check.mjs';

// SD-3 — smoke:sun-lift's verdict on one integer luma, in two bands.

test('a pixel under the glow band may not end above the candle', () => {
    assert.equal(CANDLE, 192);
    assert.equal(GLOW_BAND, 188);
    assert.deepEqual(liftVerdict(187, 193), { band: 'low', over: true, rise: 6 });
    assert.deepEqual(liftVerdict(187, 192), { band: 'low', over: false, rise: 5 });
    assert.deepEqual(liftVerdict(150, 160), { band: 'low', over: false, rise: 10 });
});

test('a pixel from the glow band up may rise by at most 5, and every rise is counted', () => {
    assert.equal(BRIGHT_RISE, 5);
    assert.deepEqual(liftVerdict(192, 193), { band: 'high', over: false, rise: 1 }, '192 -> 193: the known residual band');
    assert.deepEqual(liftVerdict(192, 196), { band: 'high', over: false, rise: 4 }, 'the bridge plank at the line');
    assert.deepEqual(liftVerdict(202, 207), { band: 'high', over: false, rise: 5 }, '202 -> 207 is within the bound');
    assert.deepEqual(liftVerdict(202, 203), { band: 'high', over: false, rise: 1 }, '202 -> 203 is counted');
    assert.deepEqual(liftVerdict(202, 208), { band: 'high', over: true, rise: 6 });
    assert.deepEqual(liftVerdict(202, 202), { band: 'high', over: false, rise: 0 });
});

test('both frames are read through one rounding', () => {
    const data = new Uint8Array([200, 200, 200, 255, 255, 255, 255, 255]);
    assert.equal(lumaAt(data, 0), 200);
    assert.equal(lumaAt(data, 4), 255);
    assert.ok(Number.isInteger(lumaAt(new Uint8Array([13, 77, 201, 255]), 0)));
});
