// D4 — the Lamplighter's Round: the Pharos lights first, the lamps catch
// inland over ROUND_SPAN_MIN minutes at dusk and go out in reverse at dawn.
// Clock and fixed geography only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { lampCourseAt, lampSettlingWindows } from '../../claudeville/src/presentation/character-mode/GradeEvaluator.js';
import {
    LIGHTHOUSE_TILE,
    ROUND_SPAN_MIN,
    lampRoundFor,
    roundFraction,
    roundLampLit,
} from '../../claudeville/src/presentation/character-mode/LamplighterRound.js';
import { IsometricRenderer } from '../../claudeville/src/presentation/character-mode/IsometricRenderer.js';

const W = lampSettlingWindows();

// The minute a lamp at `fraction` changes state inside [from, to).
function stepMinute(fraction, from, to) {
    const initial = roundLampLit(from, fraction);
    for (let m = from; m < to; m += 1 / 60) {
        if (roundLampLit(m, fraction) !== initial) return m;
    }
    return null;
}

test('the settling windows are exactly where the lamp course says 1', () => {
    assert.equal(lampCourseAt(W.duskStart - 0.01), 0);
    assert.equal(lampCourseAt(W.duskStart), 1);
    assert.equal(lampCourseAt(W.duskEnd), 2);
    assert.equal(lampCourseAt(W.dawnStart), 1);
    assert.equal(lampCourseAt(W.dawnEnd - 0.01), 1);
    assert.equal(lampCourseAt(W.dawnEnd), 0);
});

test('dusk: the Pharos first, then inland, monotone and within the span', () => {
    const fractions = [0, 0.25, 0.5, 0.75, 1];
    const steps = fractions.map(f => stepMinute(f, W.duskStart - 1, W.duskEnd));
    assert.ok(Math.abs(steps[0] - W.duskStart) < 0.02, 'the Pharos lights with the lamp clock');
    for (let i = 1; i < steps.length; i++) assert.ok(steps[i] > steps[i - 1], 'farther lamps catch later');
    assert.ok(Math.abs(steps.at(-1) - (W.duskStart + ROUND_SPAN_MIN)) < 0.02);
    assert.ok(ROUND_SPAN_MIN >= 6 && ROUND_SPAN_MIN <= 8);
    // Each lamp changes once: lit through lamplight and deep night.
    for (const f of fractions) {
        assert.equal(roundLampLit(W.duskEnd + 1, f), true);
        assert.equal(roundLampLit(2 * 60, f), true);
        assert.equal(roundLampLit(12 * 60, f), false);
    }
});

test('dawn reverses the round: far lamps out first, the Pharos last', () => {
    const steps = [0, 0.5, 1].map(f => stepMinute(f, W.dawnStart, W.dawnEnd + 1));
    assert.ok(steps[2] < steps[1] && steps[1] < steps[0]);
    assert.ok(Math.abs(steps[0] - W.dawnEnd) < 0.02, 'the Pharos goes out with the lamp clock');
    assert.ok(Math.abs((W.dawnEnd - steps[2]) - ROUND_SPAN_MIN) < 0.02, 'symmetric with dusk');
});

test('a mid-dusk snapshot shows the partial round; reduced motion keeps the shared clock', () => {
    const atmosphere = { clock: { minuteOfDay: W.duskStart + ROUND_SPAN_MIN / 2, date: new Date(2026, 9, 24, 19) } };
    const lit = lampRoundFor(atmosphere);
    assert.equal(lit(LIGHTHOUSE_TILE.tileX, LIGHTHOUSE_TILE.tileY), true);
    assert.equal(lit(4, 31), false, 'the Portal side has not caught yet');
    const still = lampRoundFor(atmosphere, { motionScale: 0 });
    assert.equal(still(4, 31), true);
    assert.equal(lampRoundFor({ clock: { minuteOfDay: 12 * 60 } })(LIGHTHOUSE_TILE.tileX, LIGHTHOUSE_TILE.tileY), false);
    assert.equal(lampRoundFor(null)(1, 1), false);
});

test('the renderer lights only the caught lamps, hearths included', () => {
    const atmosphere = { clock: { minuteOfDay: W.duskStart + ROUND_SPAN_MIN / 2, date: new Date(2026, 9, 24, 19) } };
    const stub = Object.create(IsometricRenderer.prototype);
    stub._lastAtmosphere = atmosphere;
    stub.motionScale = 1;
    const all = stub._lanternGlowSources();
    const caught = stub._litLanternGlowSources();
    assert.ok(all.length > caught.length && caught.length > 0, `${caught.length} of ${all.length} caught`);
    for (const source of caught) assert.ok(roundFraction(source.tileX, source.tileY) <= 0.5 + 1e-9);
    // The round spreads over the real lamp chain, not one cluster.
    const fractions = all.map(source => roundFraction(source.tileX, source.tileY));
    assert.ok(Math.min(...fractions) < 0.35 && Math.max(...fractions) > 0.75);
    stub.motionScale = 0;
    assert.equal(stub._litLanternGlowSources().length, all.length);
});

test('the round reads no session state (V3)', () => {
    const source = readFileSync(new URL('../../claudeville/src/presentation/character-mode/LamplighterRound.js', import.meta.url), 'utf8');
    const imports = [...source.matchAll(/^import .* from '([^']+)';$/gm)].map(match => match[1]);
    assert.deepEqual(imports.sort(), [
        '../../config/buildings.js',
        './AtmosphereState.js',
        './GradeEvaluator.js',
        './SeasonalAmbience.js',
    ]);
    const code = source.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    assert.doesNotMatch(code, /agent|session|status|eventBus/i);
});
