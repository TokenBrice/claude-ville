import test from 'node:test';
import assert from 'node:assert/strict';

import {
    buildWeatherTimeline,
    createAtmosphereSnapshot,
    resolveWeather,
    resolveWeatherAt,
} from '../../claudeville/src/presentation/character-mode/AtmosphereState.js';
import { SeasonalAmbience } from '../../claudeville/src/presentation/character-mode/SeasonalAmbience.js';
import { WIND_SPEED_BY_TYPE, baseWindX, windAt } from '../../claudeville/src/presentation/character-mode/Wind.js';
import { stormStrikeAt } from '../../claudeville/src/presentation/character-mode/WeatherRenderer.js';

const knotsOf = timeline => timeline.knots.map(knot => [knot.minute, knot.type, knot.windX]);

test('two dates yield different weather timelines (no null seed coerces to 0)', () => {
    const a = buildWeatherTimeline(new Date(2026, 8, 27, 12));
    const b = buildWeatherTimeline(new Date(2026, 8, 28, 12));
    assert.notDeepEqual(knotsOf(a), knotsOf(b));
    assert.notEqual(a.seed, 0);
    assert.deepEqual(knotsOf(buildWeatherTimeline(new Date(2026, 8, 27, 12), null)), knotsOf(a));
    assert.deepEqual(knotsOf(buildWeatherTimeline(new Date(2026, 8, 27, 12), undefined)), knotsOf(a));
    // An explicit numeric seed still pins the timeline.
    assert.deepEqual(
        knotsOf(buildWeatherTimeline(new Date(2026, 8, 27, 12), 7)),
        knotsOf(buildWeatherTimeline(new Date(2026, 8, 28, 12), 7)),
    );
});

test('a year of village weather covers every type near the authored odds', () => {
    const expected = { clear: 38.6, 'partly-cloudy': 29.8, overcast: 13.3, fog: 13.7, rain: 3.4, storm: 1.2 };
    const counts = {};
    let total = 0;
    for (let day = 0; day < 365; day++) {
        const timeline = buildWeatherTimeline(new Date(2026, 0, 1 + day, 12));
        for (let minute = 0; minute < 1440; minute += 10) {
            const { type } = resolveWeatherAt(minute, timeline);
            counts[type] = (counts[type] || 0) + 1;
            total++;
        }
    }
    for (const [type, share] of Object.entries(expected)) {
        const actual = (100 * (counts[type] || 0)) / total;
        assert.ok(Math.abs(actual - share) <= 2, `${type}: ${actual.toFixed(1)} % vs ${share} %`);
    }
});

test('resolveWeather ignores any agent input: the weather is the timeline', () => {
    const date = new Date(2026, 8, 28, 14, 0);
    const plain = resolveWeather(date);
    const pressured = resolveWeather(date, null, {
        eventInfluence: { storminess: 1, clearing: 0, districts: [{ project: '/repo', storminess: 1 }] },
        storminess: 1,
    });
    assert.deepEqual(pressured, plain);
    assert.equal(plain.cause, 'timeline');
    const snapshot = createAtmosphereSnapshot({ now: date, eventInfluence: { storminess: 1 } });
    assert.equal(snapshot.weather.type, plain.type);
    assert.equal(snapshot.weather.cause, 'timeline');
    assert.equal('districtAtmosphere' in snapshot, false);
});

test('knot wind is sign × speed by type and the gusts hold still in fog', () => {
    for (const [type, speed] of Object.entries(WIND_SPEED_BY_TYPE)) {
        const weather = resolveWeather(new Date(2026, 8, 28, 12), { type });
        assert.equal(Math.abs(weather.windX), speed, type);
        assert.equal(baseWindX(weather), weather.windX);
    }
    const fog = { type: 'fog', windX: -0.1 };
    for (let t = 0; t < 60000; t += 997) assert.equal(windAt(t, t / 3, t, fog).gust, 0);
    const storm = { type: 'storm', windX: 1.3 };
    let gusted = false;
    for (let t = 0; t < 60000; t += 997) {
        const wind = windAt(400, 300, t, storm);
        assert.ok(wind.x >= 1.3 && wind.gust >= 0 && wind.gust <= 1);
        if (wind.gust > 0) gusted = true;
    }
    assert.ok(gusted, 'a storm gusts somewhere in a minute');
});

test('no snow particle spawns on a dry winter minute', () => {
    const spawned = [];
    const particleSystem = { countTagged: () => 0, spawn: (type) => spawned.push(type) };
    const winterDay = (weather) => ({
        phase: 'day',
        clock: { date: new Date(2026, 0, 15, 12) },
        weather,
    });
    let atmosphere = winterDay({ type: 'clear', precipitation: 0 });
    const ambience = new SeasonalAmbience({
        particleSystem,
        atmosphereStateGetter: () => atmosphere,
        motionScaleGetter: () => 1,
        viewportProvider: () => ({ x: 0, y: 0, width: 800, height: 600 }),
        cameraGetter: () => ({ zoom: 2, screenToWorld: (x, y) => ({ x, y }) }),
    });
    for (let i = 0; i < 120; i++) ambience.update(50);
    assert.equal(spawned.length, 0);
    atmosphere = winterDay({ type: 'rain', precipitation: 0.7 });
    for (let i = 0; i < 120; i++) ambience.update(50);
    assert.ok(spawned.length > 0 && spawned.every(type => type === 'snow'));
});

test('lightning strikes only in a storm, in C4 quanta, and never under reduced motion', () => {
    const storm = { weather: { type: 'storm', intensity: 0.9, seed: 11 }, motion: { particleEnabled: true }, lightGrade: { night: 1 } };
    const scalars = new Set();
    let reduced = 0;
    for (let t = 0; t < 600000; t += 17) {
        const strike = stormStrikeAt(t, storm, 1);
        if (strike.active) scalars.add(strike.scalar);
        if (stormStrikeAt(t, storm, 0).active) reduced++;
        assert.equal(stormStrikeAt(t, { ...storm, weather: { ...storm.weather, type: 'rain' } }, 1).active, false);
    }
    assert.equal(reduced, 0);
    for (const scalar of scalars) assert.ok([0.30, 0.18, 0.12, 0.07, 0.035, 0.16].includes(scalar), String(scalar));
    assert.ok(scalars.has(0.30) && scalars.has(0.16));
});
