// LA-2 (D1, the real sun) and LA-4a (the moon keeps its hours). Every site
// here carries its own zone's UTC-offset rule, read from ICU, so the results
// are the same on any host timezone (CI runs in UTC).
import test from 'node:test';
import assert from 'node:assert/strict';

import {
    siteForZone,
    solarDay,
    standardOffsetMinutes,
    sunElevationAt,
} from '../../claudeville/src/presentation/character-mode/SolarClock.js';
import { zoneCoordinates } from '../../claudeville/src/config/zoneCoordinates.js';
import {
    AUTHORED_DAY_SITE,
    BASELINE_DAY_SHIFT,
    DAY_SHIFT_LIMITS,
    VILLAGE_MAX_LATITUDE_DEG,
    createAtmosphereSnapshot,
    dayShiftFor,
    solarStateForDate,
} from '../../claudeville/src/presentation/character-mode/AtmosphereState.js';
import {
    GRADE_KEYFRAMES,
    gradeKeysAt,
    lampCourseAt,
    lampSettlingWindows,
} from '../../claudeville/src/presentation/character-mode/GradeEvaluator.js';
import { lampRoundFor } from '../../claudeville/src/presentation/character-mode/LamplighterRound.js';

const DAY_MS = 86400000;

function offsetAtInstant(format, utcMs) {
    const parts = Object.fromEntries(format.formatToParts(new Date(utcMs)).map(part => [part.type, part.value]));
    const wall = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute));
    return Math.round((wall - utcMs) / 60000);
}

// `date`'s local fields are read as the zone's wall time.
function zoneOffsetRule(zone) {
    const format = new Intl.DateTimeFormat('en-US', {
        timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric',
    });
    const seen = new Map();
    return (date) => {
        const wall = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate(), date.getHours(), date.getMinutes());
        let offset = seen.get(wall);
        if (offset === undefined) {
            offset = offsetAtInstant(format, wall - offsetAtInstant(format, wall) * 60000);
            seen.set(wall, offset);
        }
        return offset;
    };
}

function zoneSite(zone) {
    const rule = zoneOffsetRule(zone);
    return { ...siteForZone(zone, { standardOffset: standardOffsetMinutes(2026, rule) }), offsetMinutes: rule };
}

const BELGRADE = zoneSite('Europe/Belgrade');
const near = (actual, expected, tolerance, label) => assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${label}: ${actual.toFixed(2)} not within ${tolerance} of ${expected}`,
);
const hm = (h, m) => h * 60 + m;
const dayOf = (index, year = 2026) => new Date(year, 0, 1 + index, 12);

// The 8 key minutes the grade uses for a shift, in key order.
function keyMinutesFor(shift) {
    return Object.fromEntries(GRADE_KEYFRAMES.map(key => [key.name,
        key.minute + (key.side === 'dawn' ? shift.sunriseShift : key.side === 'dusk' ? shift.sunsetShift : 0)]));
}

test('Belgrade keeps its real sun within 3 minutes, on its own clock', () => {
    const at = (month, day) => solarStateForDate(new Date(2026, month, day, 12), BELGRADE).day;
    near(at(10, 3).sunsetMinute, hm(16, 24), 3, '3 Nov sunset');
    near(at(10, 3).civilDuskMinute, hm(16, 55), 3, '3 Nov civil dusk');
    near(at(11, 21).sunsetMinute, hm(15, 59), 3, '21 Dec sunset');
    near(at(5, 21).sunsetMinute, hm(20, 27), 3, '21 Jun sunset (CEST)');
    near(at(10, 3).sunriseMinute, hm(6, 18), 3, '3 Nov sunrise');
    near(at(10, 3).noonElevationDeg, 30.1, 0.3, '3 Nov noon elevation');
    const nov = at(10, 3);
    near(sunElevationAt(nov, nov.sunsetMinute), -0.833, 0.15, 'elevation at sunset');
    near(sunElevationAt(nov, nov.civilDuskMinute), -6, 0.15, 'elevation at civil dusk');
});

test('the zone table finds the city, its aliases, and falls back to the offset meridian at 45 N', () => {
    assert.deepEqual(zoneCoordinates('Europe/Belgrade'), { lat: 44.8, lon: 20.5 });
    assert.deepEqual(zoneCoordinates('Asia/Calcutta'), zoneCoordinates('Asia/Kolkata'), 'ICU alias, same city');
    assert.notDeepEqual(zoneCoordinates('Europe/Zagreb'), zoneCoordinates('Europe/Belgrade'), 'a linked zone keeps its own city');
    assert.equal(siteForZone('Europe/Belgrade').source, 'zone');
    for (const [zone, standardOffset, lon] of [['UTC', 0, 0], ['Etc/UTC', 0, 0], ['Etc/GMT-2', 120, 30], ['Mars/Olympus_Mons', -300, -75], ['', 60, 15]]) {
        const site = siteForZone(zone, { standardOffset });
        assert.equal(site.source, 'offset', zone);
        assert.equal(site.lat, 45, `${zone} latitude`);
        assert.equal(site.lon, lon, `${zone} central meridian`);
    }
    // The standard offset is the zone's non-DST one in either hemisphere.
    assert.equal(standardOffsetMinutes(2026, zoneOffsetRule('Europe/Belgrade')), 60);
    assert.equal(standardOffsetMinutes(2026, zoneOffsetRule('Australia/Sydney')), 600);
    assert.equal(standardOffsetMinutes(2026, zoneOffsetRule('America/New_York')), -300);
});

test('a UTC host falls back to the Greenwich meridian: dusk follows the real UTC sun', () => {
    const fallback = { ...siteForZone('UTC', { standardOffset: 0 }), offsetMinutes: () => 0 };
    const equinox = solarStateForDate(new Date(2026, 2, 20, 12), fallback).day;
    near(equinox.solarNoonMinute, hm(12, 7), 3, 'equinox noon at 0 E');
    near(equinox.civilDuskMinute - equinox.sunsetMinute, 31, 4, 'civil twilight at 45 N');
});

test('the 8 keys, the lamp windows and the phases keep their order on every day of the year, in every zone', () => {
    const zones = ['Europe/Belgrade', 'Asia/Calcutta', 'Europe/Madrid', 'Arctic/Longyearbyen', 'Antarctica/McMurdo',
        'Pacific/Kiritimati', 'America/Anchorage', 'Atlantic/Reykjavik', 'Asia/Shanghai', 'UTC'];
    const sites = zones.map(zone => [zone, zone === 'UTC' ? { ...siteForZone('UTC'), offsetMinutes: () => 0 } : zoneSite(zone)]);
    const order = ['deep-night', 'pre-dawn', 'sunrise', 'morning', 'noon', 'golden-hour', 'blue-hour', 'night'];
    for (const [zone, site] of sites) {
        for (let index = 0; index < 366; index++) {
            const { shift } = solarStateForDate(dayOf(index), site);
            const label = `${zone} day ${index}`;
            assert.ok(shift.sunriseShift >= DAY_SHIFT_LIMITS.sunrise[0] && shift.sunriseShift <= DAY_SHIFT_LIMITS.sunrise[1], `${label} sunrise shift`);
            assert.ok(shift.sunsetShift >= DAY_SHIFT_LIMITS.sunset[0] && shift.sunsetShift <= DAY_SHIFT_LIMITS.sunset[1], `${label} sunset shift`);
            const keys = keyMinutesFor(shift);
            const minutes = order.map(name => keys[name]);
            for (let i = 1; i < minutes.length; i++) {
                assert.ok(minutes[i] - minutes[i - 1] >= 15, `${label}: ${order[i - 1]} -> ${order[i]} ${minutes[i] - minutes[i - 1]}`);
            }
            assert.ok(keys['deep-night'] + 1440 - keys.night >= 60, `${label}: night -> deep-night`);
            assert.ok(keys.night - keys['blue-hour'] >= 90, `${label}: night at least 90 min after blue hour`);
            const w = lampSettlingWindows(shift);
            assert.ok(keys['pre-dawn'] < w.dawnStart && w.dawnStart < w.dawnEnd && w.dawnEnd < w.duskStart, `${label}: dawn lamps`);
            assert.ok(w.duskStart < w.duskEnd && w.duskEnd < keys['blue-hour'] && keys['blue-hour'] + 60 < 1440, `${label}: dusk lamps`);
            // Each key is the one the grade passes at its own minute.
            for (const name of order) {
                const m = ((keys[name] % 1440) + 1440) % 1440;
                assert.equal(gradeKeysAt(m + 0.01, shift).from.name, name, `${label}: ${name} at its minute`);
            }
        }
    }
});

test('every zone ICU can report finds its city, and keeps the key order and the 3 min a day', () => {
    const zones = Intl.supportedValuesOf('timeZone');
    const fallbacks = [];
    for (const zone of zones) {
        const site = zoneSite(zone);
        if (site.source !== 'zone') fallbacks.push(zone);
        let previous = null;
        for (let index = 0; index < 366; index += 3) {
            const date = dayOf(index);
            const { shift } = solarStateForDate(date, site);
            const keys = keyMinutesFor(shift);
            assert.ok(keys.morning < keys.noon && keys.noon < keys['golden-hour'], `${zone} day ${index}: midday keys`);
            assert.ok(keys['pre-dawn'] - keys['deep-night'] >= 15 && keys['deep-night'] + 1440 - keys.night >= 60, `${zone} day ${index}: night keys`);
            if (previous) {
                const clockStep = site.offsetMinutes(date) - site.offsetMinutes(dayOf(index - 3));
                for (const [key, limits] of [['sunriseShift', DAY_SHIFT_LIMITS.sunrise], ['sunsetShift', DAY_SHIFT_LIMITS.sunset]]) {
                    // A shift held at its limit stands still (far from its meridian, or far north).
                    if ([shift[key], previous[key]].some(value => limits.some(limit => Math.abs(value - limit) < 1e-9))) continue;
                    const move = shift[key] - previous[key] - clockStep;
                    assert.ok(Math.abs(move) <= 9, `${zone} day ${index}: ${key} moved ${move.toFixed(2)} min in 3 days`);
                }
            }
            previous = shift;
        }
    }
    assert.ok(fallbacks.length <= zones.length * 0.05, `zones without a city: ${fallbacks.join(', ')}`);
});

test('the shifts move at most 3 min a day, and step only with the clock at DST', () => {
    const zones = ['Europe/Belgrade', 'Europe/Helsinki', 'Atlantic/Reykjavik', 'America/Sao_Paulo', 'Australia/Sydney', 'Asia/Kolkata', 'Europe/Madrid'];
    for (const zone of zones) {
        const site = zoneSite(zone);
        let previous = solarStateForDate(dayOf(0), site);
        for (let index = 1; index < 400; index++) {
            const date = dayOf(index);
            const current = solarStateForDate(date, site);
            const clockStep = site.offsetMinutes(date) - site.offsetMinutes(dayOf(index - 1));
            for (const key of ['sunriseShift', 'sunsetShift']) {
                const move = current.shift[key] - previous.shift[key] - clockStep;
                assert.ok(Math.abs(move) <= 3, `${zone} ${date.toDateString()} ${key} moved ${move.toFixed(2)} min (clock ${clockStep})`);
            }
            previous = current;
        }
    }
});

test('the DST step equals the clock step (Belgrade, October and March)', () => {
    const shift = (month, day) => solarStateForDate(new Date(2026, month, day, 12), BELGRADE).shift;
    for (const [before, after, clock] of [[[9, 24], [9, 25], -60], [[2, 28], [2, 29], 60]]) {
        for (const key of ['sunriseShift', 'sunsetShift']) {
            near(shift(...after)[key] - shift(...before)[key], clock, 3, `${key} ${after.join('-')}`);
        }
    }
});

test('the village keeps the day within 58 degrees of latitude', () => {
    for (const zone of ['Arctic/Longyearbyen', 'Antarctica/McMurdo', 'Europe/Helsinki']) {
        const site = zoneSite(zone);
        const state = solarStateForDate(new Date(2026, 11, 21, 12), site);
        assert.ok(Math.abs(state.site.lat) <= VILLAGE_MAX_LATITUDE_DEG, zone);
        assert.ok(Number.isFinite(state.day.sunriseMinute) && Number.isFinite(state.day.civilDuskMinute), `${zone} finite`);
    }
    // The pure solar day itself is not bounded: a polar night clamps to noon.
    const polar = solarDay({ year: 2026, month: 11, day: 21, lat: 78, lon: 16, offsetMinutes: 60 });
    assert.equal(polar.polar, 'night');
    near(polar.sunriseMinute, polar.solarNoonMinute, 0.01, 'polar night sunrise at noon');
});

test('a pinned day is the same on any host timezone', () => {
    const original = process.env.TZ;
    const sample = () => {
        const state = solarStateForDate(new Date(2026, 10, 3, 12), BELGRADE);
        const snapshot = createAtmosphereSnapshot({ now: new Date(2026, 10, 3, 17, 0), weatherOverride: 'clear', solarSite: BELGRADE });
        return [state.shift.sunriseShift, state.shift.sunsetShift, snapshot.phase, snapshot.lightGrade.key].join('|');
    };
    try {
        const seen = new Set();
        for (const zone of ['UTC', 'Europe/Belgrade', 'Pacific/Auckland', 'America/Los_Angeles']) {
            process.env.TZ = zone;
            seen.add(sample());
        }
        assert.equal(seen.size, 1, [...seen].join(' / '));
    } finally {
        if (original === undefined) delete process.env.TZ;
        else process.env.TZ = original;
    }
});

test('Belgrade, 3 November: the lamps and the night come with the real dusk', () => {
    const at = (h, m) => createAtmosphereSnapshot({ now: new Date(2026, 10, 3, 12), hourOverride: h + m / 60, weatherOverride: 'clear', solarSite: BELGRADE });
    const shift = dayShiftFor(at(12, 0));
    assert.equal(at(12, 0).phase, 'day');
    assert.equal(at(15, 30).lightGrade.key, 'golden-hour>blue-hour', 'gold slants across the mid-afternoon');
    assert.equal(at(16, 24).phase, 'dusk', 'the real sunset is the village dusk');
    assert.ok(lampCourseAt(hm(16, 24), shift) >= 1, 'the lamps are catching at sunset');
    assert.equal(at(17, 0).lightGrade.key, 'blue-hour>night', 'the blue hour at civil dusk (16:55)');
    assert.equal(at(17, 15).phase, 'night');
    assert.equal(at(17, 0).lighting.sourceEnergy.bucket, 'lamplight');
    assert.equal(at(18, 0).lighting.sourceEnergy.bucket, 'deep-night');
    // The round has lit every lamp by the lamplight course.
    assert.equal(lampRoundFor(at(16, 45))(4, 31), true);
    assert.equal(lampRoundFor(at(15, 0))(4, 31), false);
    // The disc rides the real sun: low and fading at 16:00, gone at the
    // 16:24 sunset, while the sky keeps its golden-then-blue keys.
    assert.ok(at(16, 0).sky.sun.visible && at(16, 0).sky.sun.alpha < at(15, 0).sky.sun.alpha);
    assert.equal(at(16, 25).sky.sun.visible, false);
    assert.ok(at(16, 24).solar.elevationDeg < 0 && at(16, 10).solar.elevationDeg > 0);
    assert.ok(at(6, 10).sky.sun.visible === false && at(6, 45).sky.sun.visible, 'and rises at the 06:18 sunrise');
});

test('Belgrade, 21 June: the evening stays gold past 19:30 and night keeps its distance', () => {
    const site = BELGRADE;
    const at = (h, m) => createAtmosphereSnapshot({ now: new Date(2026, 5, 21, 12), hourOverride: h + m / 60, weatherOverride: 'clear', solarSite: site });
    const keys = keyMinutesFor(dayShiftFor(at(12, 0)));
    assert.ok(keys['golden-hour'] > hm(19, 0), 'golden hour after 19:00');
    assert.ok(keys.night - keys['blue-hour'] >= 90);
    assert.equal(at(20, 0).phase, 'dusk');
    assert.equal(at(4, 50).phase, 'dawn', 'dawn before the 04:52 sunrise');
});

test('the authored day site and fixtures without a snapshot keep the authored keys', () => {
    assert.deepEqual(solarStateForDate(new Date(2026, 10, 3, 12), AUTHORED_DAY_SITE).shift, BASELINE_DAY_SHIFT);
    assert.equal(dayShiftFor(null), BASELINE_DAY_SHIFT);
    assert.equal(dayShiftFor({ clock: { minuteOfDay: 600 } }), BASELINE_DAY_SHIFT);
    const snapshot = createAtmosphereSnapshot({ now: new Date(2026, 10, 3, 19, 0), weatherOverride: 'clear', solarSite: AUTHORED_DAY_SITE });
    assert.equal(snapshot.lightGrade.key, 'golden-hour>blue-hour', '19:00 on the authored day');
    for (const field of ['civilDawnMinute', 'sunriseMinute', 'solarNoonMinute', 'sunsetMinute', 'civilDuskMinute', 'noonElevationDeg', 'elevationDeg']) {
        assert.ok(Number.isFinite(snapshot.solar[field]), field);
    }
});

// LA-4a.
function moonAt(date, hourOverride, site = BELGRADE) {
    return createAtmosphereSnapshot({ now: date, hourOverride, weatherOverride: { type: 'clear', intensity: 0, cloudCover: 0 }, solarSite: site });
}

function dateWithAge(target, from = new Date(2026, 10, 1, 12)) {
    for (let i = 0; i < 40; i++) {
        const date = new Date(from.getTime() + i * DAY_MS);
        const age = moonAt(date, 12).sky.moon.phase.age;
        if (Math.abs(age - target) < 0.6) return date;
    }
    throw new Error(`no date with moon age ${target}`);
}

test('the moon keeps its hours: the full moon rises at dusk, the last quarter near midnight', () => {
    const full = dateWithAge(14.8);
    assert.equal(moonAt(full, 21).sky.moon.visible, true, 'full moon up in the evening');
    assert.equal(moonAt(full, 0).sky.moon.visible, true, 'full moon up at midnight');
    assert.ok(moonAt(full, 0).lighting.moonFill > 0.5, 'and it fills the night');
    const quarter = dateWithAge(22.1);
    assert.equal(moonAt(quarter, 20).sky.moon.visible, false, 'the last quarter is not up at 20:00');
    assert.equal(moonAt(quarter, 20).lighting.moonFill, 0, 'so the evening is starlit');
    assert.equal(moonAt(quarter, 4).sky.moon.visible, true, 'it is up before dawn');
    const fresh = dateWithAge(0.6);
    for (const hour of [21, 0, 3]) assert.equal(moonAt(fresh, hour).sky.moon.visible, false, `no new moon at ${hour}`);
    // Rising in the east, setting in the west.
    assert.ok(moonAt(quarter, 1).sky.moon.xFrac < moonAt(quarter, 5).sky.moon.xFrac);
});

test('the moon never jumps: its place moves smoothly through midnight and the DST night', () => {
    // Real instants on a Belgrade wall clock (the host Date's own offset,
    // so 03:00 CEST really turns back to 02:00 CET on 25 October).
    const original = process.env.TZ;
    process.env.TZ = 'Europe/Belgrade';
    try {
        const site = { zone: 'Europe/Belgrade', lat: 44.8, lon: 20.5 };
        for (const evening of [new Date(2026, 10, 24, 18), new Date(2026, 9, 24, 18)]) {
            let previous = null;
            for (let step = 0; step <= 13 * 12; step++) {
                const now = new Date(evening.getTime() + step * 5 * 60000);
                const snapshot = createAtmosphereSnapshot({ now, weatherOverride: { type: 'clear', intensity: 0, cloudCover: 0 }, solarSite: site });
                const moon = snapshot.sky.moon;
                const label = `${now.toString().slice(4, 21)}`;
                if (previous) {
                    assert.ok(Math.abs(moon.xFrac - previous.xFrac) < 0.02, `${label}: x ${previous.xFrac.toFixed(3)} -> ${moon.xFrac.toFixed(3)}`);
                    assert.ok(Math.abs(moon.alpha - previous.alpha) < 0.2, `${label}: alpha step`);
                }
                if (!moon.visible) assert.equal(snapshot.lighting.moonFill, 0, `${label}: no fill from a moon that is down`);
                previous = moon;
            }
        }
    } finally {
        if (original === undefined) delete process.env.TZ;
        else process.env.TZ = original;
    }
});
