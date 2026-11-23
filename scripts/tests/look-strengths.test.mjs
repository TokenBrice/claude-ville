import test from 'node:test';
import assert from 'node:assert/strict';
import {
    DEFAULT_LOOK_STRENGTHS,
    LOOK_IDS,
    lookStrength,
    lookStrengthsVersion,
    resetLookStrengths,
    setLookStrength,
} from '../../claudeville/src/presentation/character-mode/LookStrengths.js';

test('every look reads its default until overridden', () => {
    resetLookStrengths();
    for (const id of LOOK_IDS) assert.equal(lookStrength(id), DEFAULT_LOOK_STRENGTHS[id]);
});

test('overrides clamp to [0, 1], bump the version and reset', () => {
    resetLookStrengths();
    const before = lookStrengthsVersion();
    assert.equal(setLookStrength('la3', 0.5), 0.5);
    assert.equal(lookStrength('la3'), 0.5);
    assert.equal(setLookStrength('la5', 3), 1);
    assert.equal(setLookStrength('la7', -1), 0);
    assert.ok(lookStrengthsVersion() > before);
    resetLookStrengths();
    assert.equal(lookStrength('la3'), DEFAULT_LOOK_STRENGTHS.la3);
});

test('unknown ids and non-numbers are refused', () => {
    assert.throws(() => lookStrength('nope'), RangeError);
    assert.throws(() => setLookStrength('nope', 1), RangeError);
    assert.throws(() => setLookStrength('la3', 'bright'), RangeError);
});

function assertShipsAt(expected) {
    for (const [id, value] of Object.entries(expected)) {
        assert.ok(LOOK_IDS.includes(id), id);
        assert.equal(DEFAULT_LOOK_STRENGTHS[id], value, id);
    }
}

test('NL-1 landmark ramp, NL-2 firelight on people, NL-3 silhouettes and NL-4 carried lanterns ship at their reviewed strengths', () => {
    assertShipsAt({ nl1: 1, nl2: 0.5, nl3: 1, nl4: 1 });
});

test('GW-1 wet ground, GW-2 lamp mirrors and GW-3 frost patches ship at their reviewed strengths; WX-1 night rain ships on (operator-approved)', () => {
    assertShipsAt({ gw1: 1, gw2: 1, gw3: 1, wx1: 1 });
});

test('MS-1 low mist ships at its reviewed strength', () => {
    assertShipsAt({ ms1: 1 });
});

test('SD-1 sundial shade, its length cap and SD-2 receivers ship at their reviewed strengths', () => {
    assertShipsAt({ sd1: 1, sd1len: 0.5, sd2: 1 });
});

test('SD-3 the sun\'s lift ships at full strength for clearly sunny daylight', () => {
    assertShipsAt({ sd3: 1 });
});

test('SEA-1 sea light and shade ships at its reviewed strength', () => {
    // Relaxed 2026-11-23 (operator decision "clearly blue"): full 2-stop daytime sea lift.
    assertShipsAt({ sea1: 1 });
});

test('RN-1 rain in the world ships at its reviewed strength', () => {
    assertShipsAt({ rn1: 1 });
});

test('SEA-2 and SEA-3 ship at their reviewed strengths', () => {
    assertShipsAt({ sea2: 1, sea3: 1 });
});

test('MS-2 mist follow-ons ship at their reviewed strength', () => {
    assertShipsAt({ ms2: 1 });
});

test('EY-4 snowfall grade ships at its proposed strength', () => {
    assertShipsAt({ ey4: 1 });
});
