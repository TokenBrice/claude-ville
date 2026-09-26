import test from 'node:test';
import assert from 'node:assert/strict';

import {
    RAIN_WIND_CAP,
    RESTING_PILOT_WIND,
    WEATHER_CEILING_DB,
    applyWorldBudgets,
} from '../../claudeville/src/presentation/shared/audio/AudioDirector.js';

const waking = (overrides = {}) => ({
    wind: 0.05, rain: 0, birds: 0.3, crickets: 0, hum: 0.5, music: 0.75, ...overrides,
});

test('clear weather leaves the world bus at unity and wind uncapped', () => {
    const levels = waking({ wind: 0.55 });
    assert.equal(applyWorldBudgets(levels, { precipitation: 0, storm: 0 }), 0);
    assert.equal(levels.wind, 0.55);
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

test('resting keeps only the world stratum, never below the pilot light', () => {
    const calm = waking();
    applyWorldBudgets(calm, { resting: true });
    assert.equal(calm.wind, RESTING_PILOT_WIND);
    assert.deepEqual([calm.birds, calm.crickets, calm.hum, calm.music], [0, 0, 0, 0]);

    // Weather still reads through a resting village, scaled down.
    const storm = waking({ wind: 0.55, rain: 1 });
    applyWorldBudgets(storm, { precipitation: 1, storm: 0.9, resting: true });
    assert.ok(storm.wind >= RESTING_PILOT_WIND && storm.wind < RAIN_WIND_CAP);
    assert.ok(storm.rain > 0 && storm.rain < 1);
});
