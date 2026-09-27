import test from 'node:test';
import assert from 'node:assert/strict';

import {
    AIR_MOODS,
    AIR_RETURN_GAIN,
    airCrossfadeGains,
    airReturnColour,
    decayGain,
    irSeconds,
    lowBandGain,
    tailCutoffHz,
    unitEnergyScale,
    velvetImpulses,
} from '../../claudeville/src/presentation/shared/audio/IslandAir.js';
import { MEMORY_BUDGET } from '../../claudeville/src/presentation/shared/audio/Loudness.js';
import { rngStream } from '../../claudeville/src/presentation/shared/audio/Rng.js';

const SR = 48000;

// Schroeder backward integration, T20 fit (−5…−25 dB) × 3.
function schroederT60(ir, sampleRate) {
    const e = new Float64Array(ir.length);
    let s = 0;
    for (let i = ir.length - 1; i >= 0; i--) { s += ir[i] * ir[i]; e[i] = s; }
    const db = i => 10 * Math.log10(e[i] / e[0]);
    let i5 = 0;
    while (db(i5) > -5) i5++;
    let i25 = i5;
    while (db(i25) > -25) i25++;
    let sx = 0, sy = 0, sxx = 0, sxy = 0, k = 0;
    for (let i = i5; i < i25; i += 8) { const x = i / sampleRate; const y = db(i); sx += x; sy += y; sxx += x * x; sxy += x * y; k++; }
    return -60 / ((k * sxy - sx * sy) / (k * sxx - sx * sx));
}

test('the decay envelope falls exactly 60 dB in T60, and a velvet tail under it measures that T60', () => {
    assert.ok(Math.abs(20 * Math.log10(decayGain(1.3, 1.3)) + 60) < 1e-9);
    assert.equal(decayGain(-1, 1.3), 1, 'no gain before the tail starts');
    const t60 = AIR_MOODS.day.t60;
    const length = Math.ceil(irSeconds(t60) * SR);
    const ir = new Float32Array(length);
    velvetImpulses(rngStream('test.air'), length, SR, (i, sign) => { ir[i] = sign * decayGain(i / SR, t60); });
    assert.ok(Math.abs(schroederT60(ir, SR) - t60) < 0.05);
});

test('velvet noise puts one ±1 impulse in every grid cell', () => {
    const cells = new Map();
    const cell = SR / 2400;
    velvetImpulses(rngStream('test.velvet'), SR, SR, (i, sign) => {
        assert.ok(sign === 1 || sign === -1);
        const k = Math.floor(i / cell);
        cells.set(k, (cells.get(k) ?? 0) + 1);
    });
    assert.equal(cells.size, 2400);
    assert.ok([...cells.values()].every(n => n === 1));
});

test('highs die first: the tail low-pass falls from 10 kHz toward 1 kHz, the low band decays slower', () => {
    const t60 = AIR_MOODS.night.t60;
    assert.equal(tailCutoffHz(0, t60), 10000);
    assert.ok(tailCutoffHz(t60, t60) < 1100);
    assert.ok(tailCutoffHz(0.2, t60) > tailCutoffHz(0.4, t60));
    assert.equal(lowBandGain(0, t60), 0);
    // mid + low band together decay as the 1.15× longer envelope.
    const t = 0.8;
    assert.ok(Math.abs(decayGain(t, t60) + lowBandGain(t, t60) - decayGain(t, t60 * 1.15)) < 1e-12);
    assert.ok(lowBandGain(t, t60) > 0);
});

test('both IRs fit the air budget at 48 kHz, stereo', () => {
    const bytes = ['day', 'night'].reduce((sum, mood) => sum + Math.ceil(irSeconds(AIR_MOODS[mood].t60) * SR) * 2 * 4, 0);
    assert.ok(bytes <= MEMORY_BUDGET.air, `${bytes} > ${MEMORY_BUDGET.air}`);
});

test('unit energy normalisation gives a mean channel energy of 1', () => {
    const channels = [new Float32Array([3, 4]), new Float32Array([0, 0])];
    const k = unitEnergyScale(channels);
    const energy = channels.reduce((sum, ch) => sum + ch.reduce((s, v) => s + (v * k) ** 2, 0), 0) / channels.length;
    assert.ok(Math.abs(energy - 1) < 1e-9);
    assert.equal(unitEnergyScale([new Float32Array(4)]), 1, 'silence is left alone');
});

test('the day/night crossfade is equal-power at every point', () => {
    for (const night of [0, 0.25, 0.5, 0.9, 1]) {
        const { day, night: n } = airCrossfadeGains(night);
        assert.ok(Math.abs(day * day + n * n - 1) < 1e-12);
    }
    assert.deepEqual(airCrossfadeGains(0), { day: 1, night: 0 });
    assert.equal(airCrossfadeGains(1).day < 1e-12, true);
});

test('night darkens the return; its level stays put', () => {
    assert.deepEqual(airReturnColour(), { lowpassHz: 7000, gain: AIR_RETURN_GAIN });
    assert.deepEqual(airReturnColour({ night: 1 }), { lowpassHz: 5000, gain: AIR_RETURN_GAIN });
});
