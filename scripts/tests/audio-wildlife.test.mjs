import test from 'node:test';
import assert from 'node:assert/strict';

import {
    BIRD_SPECIES,
    SPECIES,
    normalizeCast,
    phraseSyllables,
    pickSpecies,
} from '../../claudeville/src/presentation/shared/audio/layers/BirdsLayer.js';
import {
    chirpPulses,
    dolbearChirpsPerSec,
    singersAt,
} from '../../claudeville/src/presentation/shared/audio/layers/CricketsLayer.js';
import { murmurDensity, murmurShape } from '../../claudeville/src/presentation/shared/audio/layers/VillageHumLayer.js';
import { rngStream, setRngSeed } from '../../claudeville/src/presentation/shared/audio/Rng.js';

const toDb = ratio => 20 * Math.log10(ratio);

function phrases(species, count = 300) {
    setRngSeed(4242);
    const rng = rngStream(`test.birds.${species}`);
    return Array.from({ length: count }, () => phraseSyllables(species, rng));
}

test('every bird carrier is harmonic, never a pure sine', () => {
    for (const name of BIRD_SPECIES) {
        assert.ok(SPECIES[name].harmonics.filter(a => a > 0).length >= 2, name);
    }
});

test('no bird holds a steady tone above 2 kHz for more than 150 ms', () => {
    for (const species of BIRD_SPECIES) {
        for (const phrase of phrases(species)) {
            for (const { dur, pts } of phrase) {
                if (dur <= 0.15 || Math.max(...pts) <= 2000) continue;
                // A longer syllable up there must glide by at least 10 %.
                assert.ok(Math.max(...pts) / Math.min(...pts) >= 1.1, `${species} ${dur}s at ${pts}`);
            }
        }
    }
});

test('no bird sustains a fundamental in the needs-you register (500–700 Hz)', () => {
    for (const species of BIRD_SPECIES) {
        for (const phrase of phrases(species)) {
            for (const { dur, pts } of phrase) {
                if (dur <= 0.15) continue;
                const inside = Math.max(...pts) >= 500 && Math.min(...pts) <= 700;
                assert.ok(!inside, `${species} ${dur}s at ${pts.map(Math.round)}`);
            }
        }
    }
});

test('a phrase is a sequence of non-overlapping syllables on one perch', () => {
    for (const species of BIRD_SPECIES) {
        for (const phrase of phrases(species)) {
            assert.ok(phrase.length > 0, species);
            for (let i = 1; i < phrase.length; i++) {
                assert.ok(phrase[i].at >= phrase[i - 1].at + phrase[i - 1].dur, `${species} syllable ${i} overlaps`);
            }
            for (const syl of phrase) assert.ok(syl.pts.length >= 2 && syl.pts.every(f => f > 0), species);
        }
    }
});

test('the cast picks only species that sing, in proportion to their rates', () => {
    const rates = normalizeCast({ blackbird: 3, robin: 1, owl: 0, dove: -2, wren: Number.NaN });
    assert.deepEqual(rates, { blackbird: 3, robin: 1, sparrow: 0, wren: 0, dove: 0, owl: 0 });
    const counts = {};
    for (let i = 0; i < 1000; i++) {
        const name = pickSpecies(rates, i / 1000);
        counts[name] = (counts[name] ?? 0) + 1;
    }
    assert.deepEqual(Object.keys(counts).sort(), ['blackbird', 'robin']);
    assert.equal(counts.blackbird, 750);
    assert.equal(pickSpecies(rates, 0.999999), 'robin');
    assert.equal(pickSpecies(normalizeCast({}), 0.5), null);
});

test('crickets chirp faster on warm nights, never below 0.5 per second', () => {
    let last = 0;
    for (let c = 0; c <= 30; c += 2) {
        const rate = dolbearChirpsPerSec(c);
        assert.ok(rate >= last && rate >= 0.5);
        last = rate;
    }
    assert.ok(Math.abs(dolbearChirpsPerSec(21) - 2.655) < 1e-9);
    assert.equal(dolbearChirpsPerSec(-20), 0.5);
});

test('a chirp is its pulses on the 33 ms grid; the chorus counts who sings', () => {
    assert.deepEqual(chirpPulses(4).map(t => Math.round(t * 1000)), [0, 33, 66, 99]);
    const bouts = [[0, 10], [5, 20], [9, 12]];
    assert.equal(singersAt(bouts, 9.5), 3);
    assert.equal(singersAt(bouts, 10), 2);
    assert.equal(singersAt(bouts, 20), 0);
});

test('the murmur climbs one audible step per doubling of working agents', () => {
    assert.equal(murmurDensity(0), 0);
    assert.equal(murmurDensity(16), 1);
    assert.equal(murmurDensity(40), 1);
    for (const [w, b] of [[1, 0.24], [3, 0.49], [7, 0.73], [15, 0.98]]) {
        assert.ok(Math.abs(murmurDensity(w) - b) < 0.01, `B(${w})`);
    }
    const steps = [1, 3, 7, 15].map(w => murmurShape({ working: w }));
    for (let i = 1; i < steps.length; i++) {
        assert.ok(toDb(steps[i].gain / steps[i - 1].gain) >= 2.5, `gain step to W index ${i}`);
        assert.ok(steps[i].width > steps[i - 1].width);
        assert.ok(steps[i].centreHz > steps[i - 1].centreHz);
    }
    assert.equal(murmurShape({ working: 0 }).gain, 0);
});

test('night darkens the murmur without cutting its level', () => {
    for (const working of [1, 6, 15]) {
        const day = murmurShape({ working, dark: 0 });
        const night = murmurShape({ working, dark: 1 });
        assert.equal(night.gain, day.gain);
        assert.ok(Math.abs(night.centreHz / day.centreHz - 0.7) < 1e-9);
        assert.ok(Math.abs(night.lowpassHz - 900) < 1e-9);
        assert.ok(day.lowpassHz > night.lowpassHz);
    }
});
