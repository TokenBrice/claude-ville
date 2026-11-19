import test from 'node:test';
import assert from 'node:assert/strict';

import {
    AtmosphereState,
    buildWeatherTimeline,
    createAtmosphereSnapshot,
    resolveWeather,
    resolveWeatherAt,
    weatherTypeFromRoll,
} from '../../claudeville/src/presentation/character-mode/AtmosphereState.js';
import { groundOptionsFor, groundStateAt, liquidPrecipitation } from '../../claudeville/src/presentation/character-mode/GroundState.js';
import { resolveWaterFx, resolveWeatherUniform } from '../../claudeville/src/presentation/character-mode/gpu/GpuFrameState.js';
import { mirrorStormDrop } from '../../claudeville/src/presentation/character-mode/CoastBake.js';
import { resetLookStrengths, setLookStrength } from '../../claudeville/src/presentation/character-mode/LookStrengths.js';
import { SeasonalAmbience } from '../../claudeville/src/presentation/character-mode/SeasonalAmbience.js';
import { WIND_SPEED_BY_TYPE, baseWindX, windAt } from '../../claudeville/src/presentation/character-mode/Wind.js';
import { gpuRainField, stormStrikeAt } from '../../claudeville/src/presentation/character-mode/WeatherRenderer.js';
import { PARITY_SCENARIOS, WEATHER } from '../smoke/webgpu-parity.mjs';

const knotsOf = timeline => timeline.knots.map(knot => [knot.minute, knot.type, knot.windX]);

test('QA freeze keeps the painted date and weather when the frame clock crosses midnight', () => {
    const before = new Date(2026, 10, 19, 23, 59, 50);
    const after = new Date(+before + 30_000);
    const state = new AtmosphereState({ nowProvider: () => after });
    state.update({ now: before });
    const frozen = state.freeze();
    assert.equal(+frozen.effectiveDate, +before);
    const frame = state.update({ now: after, motionScale: 0 });
    assert.equal(frame.timeline.frozen, true);
    assert.equal(+frame.effectiveDate, +before);
    assert.deepEqual(frame.weather, frozen.weather);
    assert.equal(frame.motion.particleEnabled, false);
    assert.equal(+state.clear().effectiveDate, +after);
});

test('the weather parity fixtures activate rain and wet ground with a winter host date', () => {
    for (const id of ['rain-noon', 'wet-night']) {
        const item = PARITY_SCENARIOS.find(candidate => candidate.id === id);
        const preset = WEATHER[item.weather];
        const state = new AtmosphereState({
            nowProvider: () => item.date ? new Date(`${item.date}T12:00:00`) : new Date(2026, 0, 15, 12),
        });
        state.setTimelineMode('fixed');
        state.setHour(item.hour);
        if (preset.knots) state.setTimelineKnots(preset.knots);
        const frame = state.setWeather(preset);
        if (id === 'rain-noon') {
            const camera = { zoom: item.zoom, screenToWorld: (x, y) => ({ x: x / item.zoom, y: y / item.zoom }) };
            assert.ok(gpuRainField(frame, camera, { viewport: { width: 1920, height: 1080 } }).instances > 0);
        } else {
            const ground = groundStateAt(frame.effectiveDate, groundOptionsFor(frame));
            assert.ok(ground.wetness > 0 && ground.puddles > 0);
        }
    }
});

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
    // A pinned override with no seed of its own takes the type hash, not 0.
    const date = new Date(2026, 8, 27, 12);
    for (const seedOverride of [null, undefined]) {
        assert.notEqual(resolveWeather(date, { type: 'rain' }, { seedOverride }).seed, 0);
        assert.notEqual(resolveWeather(date, { type: 'rain', seed: null }, { seedOverride }).seed, 0);
    }
    assert.equal(resolveWeather(date, { type: 'rain' }, { seedOverride: 7 }).seed, 7);
});

// WX-1 (look `wx1`, on by default since the operator approved it): night
// takes its extra fog from overcast, so rain and storm keep their daytime
// bands at night. The off figures are the pre-WX-1 model's 2026 census.
const AUTHORED_ODDS = {
    on: { clear: 38.4, 'partly-cloudy': 29.7, overcast: 11.2, fog: 12.9, rain: 6.0, storm: 1.8 },
    off: { clear: 38.6, 'partly-cloudy': 29.8, overcast: 13.3, fog: 13.7, rain: 3.4, storm: 1.2 },
};

for (const [label, wx1] of [['on', 1], ['off', 0]]) test(`a year of village weather covers every type near the authored odds (night rain ${label})`, () => {
    resetLookStrengths();
    setLookStrength('wx1', wx1);
    const expected = AUTHORED_ODDS[label];
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
    resetLookStrengths();
});

test('WX-1: rain and storm can start at night only with the switch on; the day is untouched', () => {
    const night = [0, 60, 200, 330, 400, 21 * 60, 23 * 60 + 59];
    const day = [7 * 60, 9 * 60, 13 * 60, 18 * 60, 20 * 60 + 59];
    const rolls = Array.from({ length: 1000 }, (_, i) => i / 1000);
    for (const minute of night) {
        const off = rolls.map(roll => weatherTypeFromRoll(roll, minute, false));
        const on = rolls.map(roll => weatherTypeFromRoll(roll, minute, true));
        assert.ok(!off.includes('rain') && !off.includes('storm'), 'off: the fog ceiling swallows rain at night');
        assert.ok(on.includes('rain') && on.includes('storm'), 'on: rain and storm keep their bands');
        // Off, fog is [0.86, 1.02) clipped to 0.14 of the rolls; on, the
        // night fog band is [0.78, 0.94), 0.16 wide, cut from overcast.
        assert.equal(off.filter(t => t === 'fog').length, 140);
        assert.equal(on.filter(t => t === 'fog').length, 160);
        assert.equal(on.filter(t => t === 'rain' || t === 'storm').length, 60);
        assert.equal(on.filter(t => t === 'clear').length, off.filter(t => t === 'clear').length);
        assert.equal(on.filter(t => t === 'partly-cloudy').length, off.filter(t => t === 'partly-cloudy').length);
    }
    for (const minute of day) {
        assert.deepEqual(rolls.map(roll => weatherTypeFromRoll(roll, minute, true)), rolls.map(roll => weatherTypeFromRoll(roll, minute, false)));
    }
    // The look reaches the date-seeded timeline, and only through the switch.
    resetLookStrengths();
    const date = new Date(2026, 10, 13, 12);
    setLookStrength('wx1', 0);
    const off = knotsOf(buildWeatherTimeline(date));
    setLookStrength('wx1', 0.49);
    assert.deepEqual(knotsOf(buildWeatherTimeline(date)), off);
    setLookStrength('wx1', 0.5);
    const on = knotsOf(buildWeatherTimeline(date));
    setLookStrength('wx1', 1);
    assert.deepEqual(knotsOf(buildWeatherTimeline(date)), on);
    resetLookStrengths();
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

test('EN-4: a winter knot falls as snow, so the water takes no rain rings, wet sheen or rain mirror break', () => {
    const knot = { type: 'rain', precipitation: 0.7, intensity: 0.7, cloudCover: 0.85, fog: 0.18, windX: 0.12, minute: 0 };
    const camera = { zoom: 1, _dpr: () => 1, screenToWorld: (x, y) => ({ x, y }) };
    const at = (date, reducedMotion) => {
        const state = new AtmosphereState({ nowProvider: () => date });
        state.setTimelineKnots([knot]);
        const snap = state.update();
        const feed = { atmosphere: snap, weather: snap.weather, motionScale: reducedMotion ? 0 : 1, reducedMotion };
        return {
            liquid: liquidPrecipitation(snap),
            rings: resolveWaterFx(feed, camera, 0, snap.lightGrade, snap.lighting.moonFill, 2268).fx[1],
            weather: resolveWeatherUniform(feed),
            mirror: mirrorStormDrop(snap.weather, snap),
            precipitation: snap.weather.precipitation,
        };
    };
    for (const reducedMotion of [false, true]) {
        const winter = at(new Date(2027, 0, 12, 15), reducedMotion);
        const spring = at(new Date(2027, 4, 12, 15), reducedMotion);
        assert.deepEqual([winter.liquid, winter.rings, winter.weather[0], winter.mirror], [0, 0, 0, 0]);
        assert.ok(spring.precipitation > 0.6 && winter.precipitation === spring.precipitation);
        for (const value of [spring.liquid, spring.rings, spring.weather[0]]) assert.ok(Math.abs(value - spring.precipitation) < 1e-6);
        assert.ok(spring.mirror > 0.5);
        // Fog, storm and intensity still follow the weather.
        assert.deepEqual(winter.weather.slice(1), spring.weather.slice(1));
    }
    // The season boundary: February snows, March rains.
    assert.equal(at(new Date(2027, 1, 28, 15)).liquid, 0);
    assert.ok(at(new Date(2027, 2, 1, 15)).liquid > 0.6);
});
