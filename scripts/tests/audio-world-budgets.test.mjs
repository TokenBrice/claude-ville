import test from 'node:test';
import assert from 'node:assert/strict';

import {
    RAIN_WIND_CAP,
    RESTING_SEA_SCALE,
    WEATHER_CEILING_DB,
    applyWorldBudgets,
    thunderLeadMs,
} from '../../claudeville/src/presentation/shared/audio/AudioDirector.js';

const waking = (overrides = {}) => ({
    sea: 0.5, wind: 0.05, rain: 0, storm: 0, birds: 0.3, crickets: 0, hum: 1, music: 0.75, ...overrides,
});

test('clear weather leaves the world bus at unity and wind uncapped', () => {
    const levels = waking({ wind: 0.55 });
    assert.equal(applyWorldBudgets(levels, { precipitation: 0, storm: 0 }), 0);
    assert.equal(levels.wind, 0.55);
    assert.equal(levels.sea, 0.5);
});

test('wind yields to rain, and the ceiling deepens with the weather up to its limit', () => {
    const light = waking({ wind: 0.4, rain: 0.25 });
    const heavy = waking({ wind: 0.55, rain: 1 });
    const lightDb = applyWorldBudgets(light, { precipitation: 0.25 });
    const heavyDb = applyWorldBudgets(heavy, { precipitation: 1 });
    assert.ok(light.wind <= RAIN_WIND_CAP && heavy.wind <= RAIN_WIND_CAP);
    assert.ok(lightDb < 0 && heavyDb < lightDb);
    assert.equal(heavyDb, WEATHER_CEILING_DB);
    // A dry storm still takes the ceiling; nothing ever goes past it.
    assert.equal(applyWorldBudgets(waking(), { precipitation: 0, storm: 1 }), WEATHER_CEILING_DB);
    assert.equal(applyWorldBudgets(waking(), { precipitation: 3, storm: 3 }), WEATHER_CEILING_DB);
});

test('resting keeps only the world stratum, with the sea as the pilot light', () => {
    const calm = waking();
    applyWorldBudgets(calm, { resting: true });
    assert.equal(calm.sea, 0.5 * RESTING_SEA_SCALE);
    assert.ok(calm.sea > 0 && calm.wind < 0.05);
    assert.deepEqual([calm.birds, calm.crickets, calm.hum, calm.music], [0, 0, 0, 0]);

    // Weather still reads through a resting village, scaled down.
    const storm = waking({ wind: 0.55, rain: 1, storm: 0.9 });
    applyWorldBudgets(storm, { precipitation: 1, storm: 0.9, resting: true });
    assert.ok(storm.wind > 0 && storm.wind < RAIN_WIND_CAP);
    assert.ok(storm.rain > 0 && storm.rain < 1);
    assert.ok(storm.storm > 0 && storm.storm < 0.9);
});

test('thunder trails its flash by distance: near strikes sooner, from 0.4 s to 4.9 s', () => {
    assert.equal(thunderLeadMs(1), 400);
    assert.equal(thunderLeadMs(0), 4900);
    const leads = [0, 0.25, 0.5, 0.75, 1].map(thunderLeadMs);
    for (let i = 1; i < leads.length; i++) assert.ok(leads[i] < leads[i - 1]);
    // Out-of-range intensity never leaves the window.
    assert.equal(thunderLeadMs(3), 400);
    assert.equal(thunderLeadMs(-1), 4900);
});
