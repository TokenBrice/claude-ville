import test from 'node:test';
import assert from 'node:assert/strict';

import {
    BASELINE_DAY_SHIFT,
    DAY_SHIFT_LIMITS,
    solarStateForDate,
    solarVectorForMinute,
} from '../../claudeville/src/presentation/character-mode/AtmosphereState.js';

// LA-2: the day shift is the real sun's. Belgrade's solstices on its own
// clock (CET in December, CEST in June), the authored day, and the corners
// of the shift limits.
const BELGRADE = { zone: 'Europe/Belgrade', lat: 44.8, lon: 20.5, offsetMinutes: date => (date.getMonth() === 5 ? 120 : 60) };
const SHIFTS = {
    authored: BASELINE_DAY_SHIFT,
    'belgrade-december': solarStateForDate(new Date(2026, 11, 21, 12), BELGRADE).shift,
    'belgrade-june': solarStateForDate(new Date(2026, 5, 21, 12), BELGRADE).shift,
    'late-short-day': { sunriseShift: DAY_SHIFT_LIMITS.sunrise[1], sunsetShift: DAY_SHIFT_LIMITS.sunset[0] },
    'early-long-day': { sunriseShift: DAY_SHIFT_LIMITS.sunrise[0], sunsetShift: DAY_SHIFT_LIMITS.sunset[1] },
};
const SEASONS = Object.keys(SHIFTS);
// Day starts at 07:00 + sunrise shift, dusk at 17:30 + sunset shift.
const PHASE_BOUNDARIES = Object.fromEntries(SEASONS.map(name => [name, [
    7 * 60 + SHIFTS[name].sunriseShift,
    17 * 60 + 30 + SHIFTS[name].sunsetShift,
]]));

function angularDistance(a, b) {
    return Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
}

test('solar shadow direction stays continuous across dawn/day and day/dusk boundaries', () => {
    const epsilon = 0.02;
    for (const season of SEASONS) {
        for (const boundary of PHASE_BOUNDARIES[season]) {
            for (let minute = boundary - 2; minute <= boundary + 2; minute++) {
                const current = solarVectorForMinute(minute, SHIFTS[season]);
                const next = solarVectorForMinute(minute + 1, SHIFTS[season]);
                assert.ok(
                    angularDistance(current.shadowAngleRad, next.shadowAngleRad) < epsilon,
                    `${season} jumps at minute ${minute}`,
                );
            }
        }
    }
});

test('solar angles and vectors are finite for every minute and season', () => {
    for (const season of SEASONS) {
        for (let minute = 0; minute < 24 * 60; minute++) {
            const solar = solarVectorForMinute(minute, SHIFTS[season]);
            assert.ok(Number.isFinite(solar.shadowAngleRad), `${season} angle at ${minute}`);
            assert.ok(Number.isFinite(solar.sunDirIso.x), `${season} vector x at ${minute}`);
            assert.ok(Number.isFinite(solar.sunDirIso.y), `${season} vector y at ${minute}`);
            const oppositeAngle = Math.atan2(-solar.sunDirIso.y, -solar.sunDirIso.x);
            assert.ok(angularDistance(oppositeAngle, solar.shadowAngleRad) < 1e-12);
        }
    }
});

test('daylight elevation rises to solar noon and falls toward sunset', () => {
    const epsilon = 1e-12;
    for (const season of SEASONS) {
        const reference = solarVectorForMinute(12 * 60, SHIFTS[season]);
        let previous = solarVectorForMinute(reference.sunriseMinute, SHIFTS[season]).elevation;
        assert.ok(Math.abs(previous) < epsilon, `${season} sunrise elevation`);
        for (let minute = reference.sunriseMinute + 1; minute <= Math.floor(reference.solarNoonMinute); minute++) {
            const elevation = solarVectorForMinute(minute, SHIFTS[season]).elevation;
            assert.ok(elevation + epsilon >= previous, `${season} elevation fell before noon at ${minute}`);
            previous = elevation;
        }

        previous = solarVectorForMinute(Math.ceil(reference.solarNoonMinute), SHIFTS[season]).elevation;
        for (let minute = Math.ceil(reference.solarNoonMinute) + 1; minute <= reference.sunsetMinute; minute++) {
            const elevation = solarVectorForMinute(minute, SHIFTS[season]).elevation;
            assert.ok(elevation <= previous + epsilon, `${season} elevation rose after noon at ${minute}`);
            previous = elevation;
        }
        assert.ok(
            Math.abs(solarVectorForMinute(reference.sunsetMinute, SHIFTS[season]).elevation) < epsilon,
            `${season} sunset elevation`,
        );
        assert.ok(
            Math.abs(solarVectorForMinute(reference.solarNoonMinute, SHIFTS[season]).elevation - 1) < epsilon,
            `${season} noon elevation`,
        );
    }
});

test('the real sun places the December and June sunrise differently', () => {
    const winter = solarVectorForMinute(12 * 60, SHIFTS['belgrade-december']);
    const summer = solarVectorForMinute(12 * 60, SHIFTS['belgrade-june']);
    assert.ok(winter.sunriseMinute > summer.sunriseMinute);
    assert.notEqual(winter.sunriseMinute, summer.sunriseMinute);
});

test('solar noon preserves the authored upper-left shadow convention', () => {
    const tolerance = 1e-9;
    for (const season of SEASONS) {
        const reference = solarVectorForMinute(12 * 60, SHIFTS[season]);
        const noon = solarVectorForMinute(reference.solarNoonMinute, SHIFTS[season]);
        assert.ok(Math.abs(noon.shadowAngleRad - 0.28) < tolerance, season);
        assert.ok(noon.sunDirIso.x < 0 && noon.sunDirIso.y < 0, `${season} noon sun must remain upper-left`);
    }
});
