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
