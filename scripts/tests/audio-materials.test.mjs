import test from 'node:test';
import assert from 'node:assert/strict';

import {
    ALLOYS,
    MATERIALS,
    RECIPES,
    alloyForProvider,
    chimeForProvider,
    material,
    strikePlan,
} from '../../claudeville/src/presentation/shared/audio/cues/Materials.js';

const cents = (a, b) => 1200 * Math.log2(a / b);
const ratiosOf = recipe => recipe.partials.map(([ratio]) => ratio);

test('every struck partial sits within ±5 cents of its recipe row; a crack splits by Hz', () => {
    const f0 = 330;
    for (const name of MATERIALS) {
        for (const phase of ['day', 'night']) {
            const recipe = material(name, phase);
            const plan = strikePlan(recipe, f0);
            assert.equal(plan.partials.length, recipe.partials.length, `${name}: every row sounds at E4`);
            plan.partials.forEach(({ ratio, freqs }, i) => {
                const splitHz = recipe.doubletHz?.[i];
                if (splitHz) {
                    assert.equal(freqs.length, 2);
                    assert.ok(Math.abs(freqs[1] - freqs[0] - 2 * splitHz) < 1e-9, `${name} row ${i} beats at ${2 * splitHz} Hz`);
                    return;
                }
                for (const hz of freqs) {
                    assert.ok(Math.abs(cents(hz, f0 * ratio)) <= 5, `${name} row ${i}: ${hz} Hz vs ${f0 * ratio} Hz`);
                }
            });
        }
    }
});

test('the cracked bell beats at 7 Hz on its prime; the healed bell has no crack', () => {
    const cracked = strikePlan(RECIPES.cracked, 220);
    const prime = cracked.partials.find(p => p.ratio === 1);
    assert.equal(Math.round(prime.freqs[1] - prime.freqs[0]), 7);
    assert.equal(RECIPES.healedDay.doubletHz, null);
    assert.equal(RECIPES.healedDay.strike.dur < RECIPES.cracked.strike.dur, true, 'no fracture');
});

test('civic bells follow campanology: a major-third tower by day, a minor-third tower at night', () => {
    const tierce = recipe => recipe.partials.find(([ratio]) => ratio > 1 && ratio < 1.3)[0];
    assert.equal(tierce(material('tower', 'day')), 1.25);
    assert.equal(tierce(material('tower', 'night')), 1.2);
    assert.equal(tierce(material('healed', 'day')), 1.25);
    assert.equal(tierce(material('healed', 'night')), 1.2);
    for (const phase of ['day', 'night']) {
        const ratios = ratiosOf(material('tower', phase));
        for (const mode of [0.5, 1, 1.5, 2]) assert.ok(ratios.includes(mode), `tower ${phase}: hum, prime, quint, nominal`);
    }
    // Signal bells are the same by day and night.
    assert.equal(material('handbell', 'day'), material('handbell', 'night'));
    assert.equal(material('cracked', 'day'), material('cracked', 'night'));
});

test('routine chimes: four alloys, the prime on the written pitch, none with the handbell\'s bronze partials', () => {
    const providers = ['claude', 'anthropic', 'codex', 'openai', 'gpt-5', 'opencode', 'zai', 'glm', 'deepseek', 'gemini', 'kimi', 'grok', 'omp', null, 'unknown'];
    assert.deepEqual(new Set(providers.map(alloyForProvider)), new Set(ALLOYS));
    assert.equal(alloyForProvider('claude'), 'clay');
    const bronze = ratiosOf(RECIPES.handbell).filter(ratio => !Number.isInteger(ratio));
    for (const provider of providers) {
        for (const phase of ['day', 'night']) {
            const chime = chimeForProvider(provider, phase);
            const ratios = ratiosOf(chime);
            assert.ok(ratios.includes(1), `${provider}: the prime rings the cue's pitch`);
            for (const ratio of bronze) assert.ok(!ratios.includes(ratio), `${provider}: no bronze ${ratio} partial`);
        }
    }
});

test('a strike ends only after its longest partial is 66 dB down, and never above the band edge', () => {
    const plan = strikePlan(RECIPES.handbell, 659.26, { Dmul: 1.4 });
    const longest = Math.max(...plan.partials.map(p => p.t60));
    assert.ok(plan.endSec >= plan.attack + 1.1 * longest - 1e-12);
    const high = strikePlan(RECIPES.handbell, 4000, { sampleRate: 48000 });
    for (const partial of high.partials) {
        for (const hz of partial.freqs) assert.ok(hz < 48000 / 2.2);
    }
    assert.ok(high.partials.length < RECIPES.handbell.partials.length);
});
