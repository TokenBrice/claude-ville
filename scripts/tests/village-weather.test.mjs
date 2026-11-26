import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import villageWeather from '../../claudeville/services/villageWeather.js';
import {
    AtmosphereState, WEATHER_TYPES, localDateKey, weatherHistorySampler,
} from '../../claudeville/src/presentation/character-mode/AtmosphereState.js';
import { groundOptionsFor, groundStateAt, liquidPrecipitation, snowfallOn } from '../../claudeville/src/presentation/character-mode/GroundState.js';
import { SeasonalAmbience } from '../../claudeville/src/presentation/character-mode/SeasonalAmbience.js';
import { RoofWeather } from '../../claudeville/src/presentation/character-mode/RoofWeather.js';
import { gpuRainField } from '../../claudeville/src/presentation/character-mode/WeatherRenderer.js';
import { resetLookStrengths, setLookStrength } from '../../claudeville/src/presentation/character-mode/LookStrengths.js';
import { forecastKnot, forecastKnotsByDate } from '../../claudeville/src/presentation/character-mode/VillageWeather.js';
import {
    VILLAGE_WEATHER_KEY,
    VILLAGE_WEATHER_MODES,
    readVillageForecast,
    readVillageWeatherMode,
    setVillageForecast,
    setVillageWeatherMode,
    watchVillageWeather,
    weatherMode,
} from '../../claudeville/src/presentation/shared/VillageWeatherSettings.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/open-meteo-london.json', import.meta.url)));
const HOUR = 3_600_000;
const observed = Date.parse('2026-11-19T16:00:00Z');

test('Open-Meteo WMO codes map to the six village weather types', () => {
    const codes = {
        clear: [0],
        'partly-cloudy': [1, 2],
        overcast: [3],
        rain: [51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 71, 73, 75, 77, 80, 81, 82, 85, 86],
        fog: [45, 48],
        storm: [95, 96, 97, 99],
    };
    assert.deepEqual(Object.keys(codes), WEATHER_TYPES);
    for (const [type, values] of Object.entries(codes)) {
        for (const code of values) assert.equal(forecastKnot({ code }).type, type, String(code));
    }
    assert.equal(forecastKnot({ code: 4 }), null);
    assert.equal(forecastKnot({ code: null }), null);
    const mist = forecastKnot({ code: 1, visibility: 800, cloud: 32 });
    assert.equal(mist.type, 'fog');
    assert.equal(mist.cloudCover, 0.32);
    assert.ok(mist.fog > 0.7);

    const rain = forecastKnot({ code: 61, cloud: 90, mm: 1, windSpeed: 30, windDirection: 90 });
    const storm = forecastKnot({ code: 97, cloud: 110, mm: 20, windSpeed: 75, windDirection: 270 });
    assert.equal(storm.cloudCover, 1);
    assert.equal(storm.precipitation, 1);
    assert.ok(rain.precipitation > 0.2 && rain.precipitation < storm.precipitation);
    assert.equal(rain.windX, -0.7);
    assert.equal(storm.windX, 1.4);
    assert.equal(rain.frozen, false);
    assert.equal(forecastKnot({ code: 86 }).frozen, true);
    assert.equal(forecastKnot({ code: 95, snowfall: 0.2 }).frozen, true);
    assert.equal(forecastKnot({ code: 0, snowfall: 0.2 }).frozen, false);
});

test('recorded UTC forecast normalizes to complete local days with bounded knots', () => {
    const originalZone = process.env.TZ;
    try {
        process.env.TZ = 'Asia/Kathmandu';
        const days = forecastKnotsByDate(fixture.hourly);
        assert.deepEqual(Object.keys(days), ['2026-11-17', '2026-11-18', '2026-11-19', '2026-11-20']);
        const day = days['2026-11-19'];
        assert.equal(day.length, 24);
        assert.ok(Object.isFrozen(day));
        const index = fixture.hourly.time.indexOf(Date.parse('2026-11-19T00:00:00Z') / 1000);
        const knot = day.find(knot => knot.minute === 345);
        assert.equal(knot.type, 'rain');
        assert.equal(knot.frozen, false);
        assert.equal(knot.cloudCover, fixture.hourly.cloud_cover[index] / 100);
        assert.ok(knot.precipitation > 0.5);
        assert.ok(knot.windX < 0);

        process.env.TZ = 'America/New_York';
        const midnight = Date.parse('2026-11-01T04:00:00Z') / 1000;
        const time = Array.from({ length: 25 }, (_, i) => midnight + i * 3600);
        const weather_code = time.map((_, i) => i === 2 ? 61 : 0);
        const fold = forecastKnotsByDate({ time, weather_code })['2026-11-01'];
        assert.equal(fold.length, 24);
        assert.equal(fold[1].minute, 60);
        assert.equal(fold[1].type, 'rain');

        process.env.TZ = 'America/Santiago';
        const firstHour = new Date(2026, 8, 6);
        assert.equal(firstHour.getHours(), 1);
        const skippedMidnight = Array.from({ length: 23 }, (_, i) => (firstHour.getTime() + i * HOUR) / 1000);
        const shortDay = forecastKnotsByDate({ time: skippedMidnight, weather_code: skippedMidnight.map(() => 0) });
        assert.equal(shortDay['2026-09-06'].length, 23);
        assert.equal(shortDay['2026-09-06'][0].minute, 60);
        assert.equal(forecastKnotsByDate({
            time: skippedMidnight.slice(1), weather_code: skippedMidnight.slice(1).map(() => 0),
        }), null, 'a forecast missing the first valid hour is still incomplete');
    } finally {
        if (originalZone === undefined) delete process.env.TZ;
        else process.env.TZ = originalZone;
    }
});

test('forecast phase controls wet ground, snow cover, rain rendering and grade outside the modeled season', (t) => {
    t.after(() => {
        setVillageForecast(null);
        resetLookStrengths();
    });
    setLookStrength('rn1', 1);
    setLookStrength('ey4', 1);
    const state = new AtmosphereState();
    const camera = { zoom: 2, screenToWorld: (x, y) => ({ x, y }) };
    const roof = new RoofWeather();
    let snapshot;
    const ambience = new SeasonalAmbience({ cameraGetter: () => camera, atmosphereStateGetter: () => snapshot });
    function at(month, code, snowfall) {
        const now = new Date(2026, month, 1, 12);
        const time = Array.from({ length: 72 }, (_, i) => (now.getTime() + (i - 36) * HOUR) / 1000);
        const days = forecastKnotsByDate({
            time, weather_code: time.map(() => code), precipitation: time.map(() => 2),
            cloud_cover: time.map(() => 90), snowfall: time.map(() => snowfall),
        });
        setVillageForecast({ days, fetchedAt: now.getTime() + snowfall });
        snapshot = state.update({ now });
        return groundStateAt(now, groundOptionsFor(snapshot));
    }

    const winterRain = at(11, 61, 0);
    const winterRainGrade = snapshot.lightGrade.skyTop;
    assert.equal(snapshot.weather.frozen, false);
    assert.ok(liquidPrecipitation(snapshot) > 0);
    assert.equal(snowfallOn(11, snapshot.weather), false);
    assert.equal(winterRain.snowCover, 0);
    assert.ok(winterRain.wetness > 0.5);
    assert.equal(ambience._driftSeason(), null);
    assert.ok(gpuRainField(snapshot, camera, { viewport: { width: 1440, height: 900 } }).instances > 0);
    roof.sync(snapshot, winterRain);
    assert.equal(roof.raining, true);

    at(11, 61, 0.6);
    assert.equal(snapshot.weather.frozen, true);
    assert.notDeepEqual(snapshot.lightGrade.skyTop, winterRainGrade);

    const novemberSnow = at(10, 73, 0.6);
    assert.equal(liquidPrecipitation(snapshot), 0);
    assert.equal(snowfallOn(10, snapshot.weather), true);
    assert.ok(novemberSnow.snowCover > 0.5);
    assert.equal(novemberSnow.wetness, 0);
    assert.equal(ambience._driftSeason()?.type, 'snow');
    assert.equal(gpuRainField(snapshot, camera, { viewport: { width: 1440, height: 900 } }).instances, 0);
    roof.sync(snapshot, novemberSnow);
    assert.equal(roof.raining, false);
    assert.ok(roof.bucket > 0);

    const afterMidnight = new Date(2026, 10, 2);
    setVillageForecast({ ...readVillageForecast(), fetchedAt: afterMidnight.getTime() });
    const next = state.update({ now: afterMidnight });
    assert.ok(groundStateAt(afterMidnight, groundOptionsFor(next)).snowCover > 0.5);
});

test('live weather and ground share date-keyed hours until the forecast expires', (t) => {
    t.after(() => setVillageForecast(null));
    const midnight = new Date(2026, 10, 19);
    const yesterday = new Date(2026, 10, 18);
    const hourAt = midnight.getTime() - 24 * HOUR;
    const time = Array.from({ length: 72 }, (_, i) => (hourAt + i * HOUR) / 1000);
    const hours = {
        time,
        weather_code: time.map((_, i) => i < 24 ? 61 : 0),
        precipitation: time.map((_, i) => i < 24 ? 2 : 0),
        wind_speed_10m: time.map(() => 30),
        wind_direction_10m: time.map(() => 90),
    };
    const forecast = { fetchedAt: midnight.getTime(), days: forecastKnotsByDate(hours) };
    setVillageForecast(forecast);
    const atmosphere = new AtmosphereState({ nowProvider: () => midnight });
    const live = atmosphere.snapshot();
    assert.deepEqual(live.weatherSource, { kind: 'forecast', ageMinutes: 0 });
    assert.equal(live.weather.type, 'clear');
    assert.equal(live.weather.windX, -0.7, 'the live wind retains forecast speed and direction');
    const options = groundOptionsFor(live);
    assert.equal(weatherHistorySampler(yesterday, options)(22 * 60).type, 'rain');
    assert.equal(weatherHistorySampler(midnight, options)(22 * 60).type, 'clear');
    const wetGround = groundStateAt(midnight, options);
    assert.ok(wetGround.wetness > 0.5, 'yesterday wets the ground after midnight');
    assert.equal(wetGround.frost, 0);
    setVillageForecast({
        fetchedAt: forecast.fetchedAt - 1,
        days: forecastKnotsByDate({ time, weather_code: time.map(() => 0) }),
    });
    const clearGround = groundStateAt(midnight, groundOptionsFor(atmosphere.snapshot()));
    assert.equal(clearGround.frost, 3, 'yesterday’s clear hours allow the midnight frost quarter');
    setVillageForecast(forecast);
    const beforeMidnight = atmosphere.update({ now: new Date(midnight.getTime() - 1) });
    assert.ok(Math.abs(beforeMidnight.weather.precipitation - live.weather.precipitation) < 1e-6);

    assert.equal(atmosphere.update({ now: new Date(midnight.getTime() + 3 * HOUR) }).weatherSource.kind, 'forecast');
    const expiredAt = new Date(midnight.getTime() + 3 * HOUR + 1);
    const fallback = atmosphere.update({ now: expiredAt });
    assert.deepEqual(fallback.weatherSource, { kind: 'stale', ageMinutes: 180 });
    assert.equal(groundOptionsFor(fallback).forecast, null);
    assert.equal(atmosphere.setWeather('fog').weatherSource, null, 'pinned QA weather has priority');
    setVillageForecast(null);
    assert.deepEqual(atmosphere.clear().weatherSource, null);
    assert.deepEqual(fallback.weather, atmosphere.update({ now: expiredAt }).weather);
    assert.equal(Object.keys(forecast.days).length, 3);
    assert.equal(forecast.days[localDateKey(yesterday)].length, 24);
});

test('server shares hourly attempts, retains good data on failure and expires it', async () => {
    let now = observed;
    let attempts = 0;
    const getForecast = villageWeather.createVillageWeather({
        now: () => now,
        getZone: () => 'Europe/Belgrade',
        fetchImpl: async (url, options) => {
            attempts++;
            assert.equal(url.origin, 'https://api.open-meteo.com');
            assert.equal(url.pathname, '/v1/forecast');
            assert.equal(url.searchParams.get('latitude'), '44.8');
            assert.equal(url.searchParams.get('longitude'), '20.5');
            assert.ok(url.searchParams.get('hourly').split(',').includes('snowfall'));
            assert.ok(url.searchParams.get('hourly').split(',').includes('temperature_2m'));
            assert.deepEqual([...url.searchParams.keys()],
                ['latitude', 'longitude', 'hourly', 'timeformat', 'past_hours', 'forecast_hours']);
            assert.equal(options.redirect, 'error');
            assert.ok(options.signal instanceof AbortSignal);
            if (attempts === 2) return new Response(new Uint8Array(65_537));
            if (attempts === 3) return new Response('not json');
            if (attempts > 3) throw new Error('offline');
            return Response.json(fixture);
        },
    });
    const [first, joined] = await Promise.all([getForecast(), getForecast()]);
    assert.deepEqual(first, joined);
    assert.equal(attempts, 1);
    assert.deepEqual(first, { hourly: { ...fixture.hourly, temperature_2m: null }, fetchedAt: observed, refreshAt: observed + HOUR });
    now += HOUR - 1;
    assert.deepEqual(await getForecast(), first);
    assert.equal(attempts, 1);
    for (let hour = 1; hour <= 3; hour++) {
        now = observed + hour * HOUR;
        assert.deepEqual(await getForecast(), { ...first, refreshAt: now + HOUR });
        assert.equal(attempts, hour + 1);
    }
    now++;
    assert.deepEqual(await getForecast(), { hourly: null, fetchedAt: observed, refreshAt: observed + 4 * HOUR });
    assert.equal(attempts, 4);

    let noCityRequests = 0;
    const noCity = villageWeather.createVillageWeather({
        getZone: () => 'UTC',
        fetchImpl: () => { noCityRequests++; },
    });
    assert.equal((await noCity()).hourly, null);
    assert.equal(noCityRequests, 0, 'a timezone without a city must stay local');
});

test('client stays offline by default and discards a response after opting out', async () => {
    let calls = 0;
    let networkSignal;
    let respond;
    const root = {
        localStorage: { getItem: () => null },
        addEventListener() {},
        removeEventListener() {},
        setTimeout: () => assert.fail('disabled weather must not schedule another poll'),
        clearTimeout() {},
        fetch: (url, { headers, signal }) => {
            assert.equal(url, '/api/weather');
            assert.equal(headers['X-ClaudeVille-Weather'], 'real-sky');
            calls++;
            networkSignal = signal;
            return new Promise(resolve => { respond = resolve; });
        },
    };
    const watcher = watchVillageWeather({ root });
    const atmosphere = new AtmosphereState({ nowProvider: () => new Date(observed) });
    try {
        assert.equal(calls, 0);
        watcher.setMode('real-sky');
        assert.equal(calls, 1);
        assert.equal(atmosphere.snapshot().weatherSource.kind, 'unavailable');
        watcher.setMode('modeled');
        assert.equal(networkSignal.aborted, true);
        respond(Response.json({ fetchedAt: observed, hourly: fixture.hourly }));
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(atmosphere.snapshot().weatherSource, null);
        assert.equal(calls, 1);
    } finally {
        watcher.destroy();
    }
    root.localStorage.getItem = key => key === VILLAGE_WEATHER_KEY ? 'real-sky' : null;
    watchVillageWeather({ root, simulation: true }).destroy();
    assert.equal(calls, 1);
});

test('idyllic weather mode stays offline, fires onChange against modeled, and keeps winter dry and unfrozen', (t) => {
    t.after(() => {
        setVillageWeatherMode('modeled');
        setVillageForecast(null);
    });
    assert.deepEqual(VILLAGE_WEATHER_MODES, ['modeled', 'real-sky', 'idyllic']);
    assert.equal(weatherMode('idyllic'), 'idyllic');
    assert.equal(weatherMode('unknown'), 'modeled');

    let calls = 0;
    let changes = 0;
    const root = {
        localStorage: { getItem: () => null },
        addEventListener() {},
        removeEventListener() {},
        setTimeout: () => assert.fail('idyllic weather must not schedule polls'),
        clearTimeout() {},
        fetch: () => { calls++; return new Promise(() => {}); },
    };
    const watcher = watchVillageWeather({ root, onChange: () => { changes++; } });
    try {
        const before = changes;
        watcher.setMode('idyllic');
        assert.equal(readVillageWeatherMode(), 'idyllic');
        assert.equal(calls, 0);
        assert.equal(changes, before + 1);
        const winterNight = new Date(2026, 0, 15, 2, 0);
        const atmosphere = new AtmosphereState({ nowProvider: () => winterNight });
        const snap = atmosphere.snapshot();
        assert.deepEqual(snap.weatherSource, { kind: 'idyllic', ageMinutes: null });
        assert.equal(snap.timeline.idyllic, true);
        assert.equal(snap.weather.type, 'clear');
        assert.equal(snap.weather.cloudCover, 0.10);
        assert.equal(snap.weather.precipitation, 0);
        assert.equal(snap.weather.fog, 0);
        assert.equal(snap.weather.freezing, false);
        const ground = groundStateAt(winterNight, groundOptionsFor(snap));
        assert.equal(ground.frost, 0);
        assert.equal(ground.snowCover, 0);
        assert.equal(ground.wetness, 0);
        watcher.setMode('modeled');
        assert.equal(readVillageWeatherMode(), 'modeled');
        assert.equal(changes, before + 2);
    } finally {
        watcher.destroy();
    }
});
