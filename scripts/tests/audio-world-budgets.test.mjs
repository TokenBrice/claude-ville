import test from 'node:test';
import assert from 'node:assert/strict';

import {
    RAIN_WIND_CAP,
    RESTING_SEA_SCALE,
    WEATHER_CEILING_DB,
    applyWorldBudgets,
    drawnDownbeats,
    thunderLeadMs,
} from '../../claudeville/src/presentation/shared/audio/AudioDirector.js';
import { RITUAL_GESTURE_PERIOD_MS, ritualDownbeat } from '../../claudeville/src/presentation/character-mode/RitualConductor.js';

const waking = (overrides = {}) => ({
    sea: 0.5, wind: 0.05, rain: 0, storm: 0, birds: 0.3, crickets: 0, hum: 1, workshops: 1, music: 0.75, ...overrides,
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
    assert.deepEqual([calm.birds, calm.crickets, calm.hum, calm.workshops, calm.music], [0, 0, 0, 0, 0]);

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

// A forge ritual on screen since beat 1000 (hammer: 460 ms per gesture).
const HAMMER = RITUAL_GESTURE_PERIOD_MS.hammer;
const forgeRitual = (overrides = {}) => ({
    agentId: 'ada', pose: 'hammer', phase: 'playing', beatOrigin: 1000, motionEnabled: true, remainingMs: 60_000,
    ...overrides,
});

test('workshop accents land on the strike frames the forge ritual draws, every third gesture', () => {
    const from = 999 * HAMMER;
    const strikes = drawnDownbeats([forgeRitual()], from, from + 20 * HAMMER);
    assert.deepEqual(strikes.map(s => s.atMs / HAMMER), [1000, 1003, 1006, 1009, 1012, 1015, 1018]);
    for (const { atMs, agentId } of strikes) {
        assert.equal(ritualDownbeat(forgeRitual(), atMs)?.phase, 'peak', 'the drawn cream frame');
        assert.equal(agentId, 'ada');
    }
    // [from, to): a beat exactly at the window's end belongs to the next window.
    assert.deepEqual(drawnDownbeats([forgeRitual()], 1000 * HAMMER, 1003 * HAMMER).map(s => s.atMs / HAMMER), [1000]);
});

test('no drawn downbeat past the ritual, before it plays, or without motion', () => {
    const from = 1000 * HAMMER;
    const now = from;
    // Ends 4 gestures in: beats 1000 and 1003 only.
    const ending = forgeRitual({ remainingMs: 4 * HAMMER });
    assert.deepEqual(drawnDownbeats([ending], from, from + 20 * HAMMER, now).map(s => s.atMs / HAMMER), [1000, 1003]);
    assert.deepEqual(drawnDownbeats([forgeRitual({ phase: 'pending', beatOrigin: undefined })], from, from + 5000, now), []);
    assert.deepEqual(drawnDownbeats([forgeRitual({ motionEnabled: false })], from, from + 5000, now), []);
    assert.deepEqual(drawnDownbeats(null, from, from + 5000, now), []);
});

test('two smiths at one forge interleave their downbeats in time order', () => {
    const from = 1000 * HAMMER;
    const strikes = drawnDownbeats([
        forgeRitual({ agentId: 'bo', beatOrigin: 1001 }),
        forgeRitual(),
    ], from, from + 6 * HAMMER);
    assert.deepEqual(strikes.map(s => `${s.agentId}@${s.atMs / HAMMER}`), ['ada@1000', 'bo@1001', 'ada@1003', 'bo@1004']);
});
