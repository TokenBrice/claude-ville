// claudeville/src/presentation/character-mode/SolarClock.js
//
// LA-2 (D1, the real sun): pure solar arithmetic for one local date at one
// site. There is no DOM, network or geolocation. The site is the system
// timezone's principal city (`config/zoneCoordinates.js`, derived from the
// tz database). A zone with no city (UTC, Etc/*) falls back to its standard
// UTC offset's central meridian at 45 degrees north.
//
// The clock is the Date's own UTC offset, so a DST change moves every event
// with the wall clock. Every input is injectable: a site may carry its own
// `offsetMinutes(date)` rule, so tests pin the zone, the coordinates and the
// offset and stay deterministic on any host (CI runs in UTC).
//
// Accuracy: the Astronomical Almanac's low-precision solar coordinates
// (declination to about 0.01 degree, equation of time to about 0.1 min, for
// 1950-2050), re-evaluated at each event. That is within a minute of NOAA's
// sunrise and sunset at mid latitudes. Polar days and nights clamp the hour
// angle (0 or 180 degrees), so every field stays finite.

import { zoneCoordinates } from '../../config/zoneCoordinates.js';

const RAD = Math.PI / 180;
const DAY_MS = 86400000;
const J2000_MS = Date.UTC(2000, 0, 1, 12);

// The upper limb at the horizon (34' of refraction plus the 16' semi-diameter).
export const SUNRISE_ALTITUDE_DEG = -0.833;
// Civil twilight: the sun 6 degrees below the horizon.
export const CIVIL_ALTITUDE_DEG = -6;
export const FALLBACK_LATITUDE_DEG = 45;

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function wrap180(degrees) {
    return ((((degrees + 180) % 360) + 360) % 360) - 180;
}

/** The sun's declination (degrees) and the equation of time (minutes) at a UTC instant. */
export function sunCoordinates(utcMs) {
    const n = (utcMs - J2000_MS) / DAY_MS;
    const meanLongitude = 280.460 + 0.9856474 * n;
    const anomaly = (357.528 + 0.9856003 * n) * RAD;
    const longitude = (meanLongitude + 1.915 * Math.sin(anomaly) + 0.020 * Math.sin(2 * anomaly)) * RAD;
    const obliquity = (23.439 - 0.0000004 * n) * RAD;
    const rightAscension = Math.atan2(Math.cos(obliquity) * Math.sin(longitude), Math.cos(longitude)) / RAD;
    return {
        declinationDeg: Math.asin(Math.sin(obliquity) * Math.sin(longitude)) / RAD,
        equationOfTimeMin: 4 * wrap180(meanLongitude - rightAscension),
    };
}

// The hour angle (degrees) at which the sun crosses `altitude`, clamped in a
// polar day (180: never sets) or polar night (0: never rises).
function hourAngle(latDeg, declinationDeg, altitudeDeg) {
    const lat = latDeg * RAD;
    const dec = declinationDeg * RAD;
    const cos = (Math.sin(altitudeDeg * RAD) - Math.sin(lat) * Math.sin(dec)) / (Math.cos(lat) * Math.cos(dec));
    return {
        degrees: Math.acos(clamp(cos, -1, 1)) / RAD,
        polar: cos > 1 ? 'night' : cos < -1 ? 'day' : null,
    };
}

/**
 * The real sun's day at `lat`/`lon` (degrees, north and east positive) for
 * the local calendar date `year`/`month` (0-11)/`day`, whose UTC offset at
 * local noon is `offsetMinutes` (east positive: +60 for CET, +120 for CEST).
 * Event times are local minutes of that day, fractional; a polar day or
 * night clamps them (`polar` names which).
 */
export function solarDay({ year, month, day, lat, lon, offsetMinutes = 0 }) {
    const latitude = clamp(Number(lat) || 0, -89.9, 89.9);
    const longitude = Number(lon) || 0;
    const offset = Number(offsetMinutes) || 0;
    const midnightUtc = Date.UTC(year, month, day) - offset * 60000;
    const at = minute => midnightUtc + minute * 60000;
    // Solar noon before the equation of time, kept within half a day of
    // clock noon (a zone far from its meridian, like Kiribati at +14).
    let mean = 720 - 4 * longitude + offset;
    mean -= 1440 * Math.round((mean - 720) / 1440);
    let noon = mean;
    for (let i = 0; i < 2; i++) noon = mean - sunCoordinates(at(noon)).equationOfTimeMin;

    const event = (altitude, sign) => {
        let minute = noon + sign * 360;
        let polar = null;
        for (let i = 0; i < 3; i++) {
            const sun = sunCoordinates(at(minute));
            const angle = hourAngle(latitude, sun.declinationDeg, altitude);
            polar = angle.polar;
            minute = mean - sun.equationOfTimeMin + sign * 4 * angle.degrees;
        }
        return { minute, polar };
    };
    const sunrise = event(SUNRISE_ALTITUDE_DEG, -1);
    const sunset = event(SUNRISE_ALTITUDE_DEG, 1);
    const civilDawn = event(CIVIL_ALTITUDE_DEG, -1);
    const civilDusk = event(CIVIL_ALTITUDE_DEG, 1);
    const declinationDeg = sunCoordinates(at(noon)).declinationDeg;
    return {
        lat: latitude,
        lon: longitude,
        offsetMinutes: offset,
        solarNoonMinute: noon,
        sunriseMinute: sunrise.minute,
        sunsetMinute: sunset.minute,
        civilDawnMinute: civilDawn.minute,
        civilDuskMinute: civilDusk.minute,
        declinationDeg,
        noonElevationDeg: 90 - Math.abs(latitude - declinationDeg),
        polar: sunrise.polar || sunset.polar,
        civilPolar: civilDawn.polar || civilDusk.polar,
    };
}

/** The real sun's elevation (degrees, negative below the horizon) at a local minute of `solar`'s day. */
export function sunElevationAt(solar, minuteOfDay) {
    const lat = solar.lat * RAD;
    const dec = solar.declinationDeg * RAD;
    const h = ((Number(minuteOfDay) - solar.solarNoonMinute) / 4) * RAD;
    return Math.asin(clamp(Math.sin(lat) * Math.sin(dec) + Math.cos(lat) * Math.cos(dec) * Math.cos(h), -1, 1)) / RAD;
}

/** The host's UTC offset (minutes, east positive) at `date`: the Date's own, DST included. */
export function hostOffsetMinutes(date) {
    return -date.getTimezoneOffset();
}

/**
 * A zone's standard (non-DST) offset in `year`: the smaller of its January
 * and July offsets (east positive), in either hemisphere.
 */
export function standardOffsetMinutes(year, offsetOf = hostOffsetMinutes) {
    return Math.min(offsetOf(new Date(year, 0, 1, 12)), offsetOf(new Date(year, 6, 1, 12)));
}

/**
 * The site for an IANA zone: its city from the tz table, or (a zone with no
 * city) the standard offset's central meridian at 45 degrees north.
 */
export function siteForZone(zone, { standardOffset = 0 } = {}) {
    const city = zoneCoordinates(zone);
    if (city) return Object.freeze({ zone: String(zone), lat: city.lat, lon: city.lon, source: 'zone' });
    return Object.freeze({ zone: String(zone || ''), lat: FALLBACK_LATITUDE_DEG, lon: (Number(standardOffset) || 0) / 4, source: 'offset' });
}

export function runtimeZone() {
    try {
        return Intl.DateTimeFormat().resolvedOptions().timeZone || '';
    } catch {
        return '';
    }
}

let _runtime = null;

/**
 * The system timezone's site. The zone is read once per local date (an OS
 * timezone change lands by the next day), and the site object stays the
 * same within a zone and year, so `solarDayFor`'s cache holds across frames.
 */
export function runtimeSite(date = new Date()) {
    const year = date.getFullYear();
    const month = date.getMonth();
    const day = date.getDate();
    const last = _runtime;
    if (last && last.year === year && last.month === month && last.day === day) return last.site;
    const zone = runtimeZone();
    const site = last && last.zone === zone && last.year === year
        ? last.site
        : siteForZone(zone, { standardOffset: standardOffsetMinutes(year) });
    _runtime = { year, month, day, zone, site };
    return site;
}

let _lastDay = null;

/**
 * `solarDay` for the local date of `date` at `site` (default: the system
 * timezone's). The UTC offset is the site's `offsetMinutes(date)` rule when
 * it has one (tests), else the host Date's own at local noon. The last
 * (site, date) is cached, so a frame's snapshots compute the day once.
 */
export function solarDayFor(date, site = runtimeSite(date)) {
    const year = date.getFullYear();
    const month = date.getMonth();
    const day = date.getDate();
    const last = _lastDay;
    if (last && last.site === site && last.year === year && last.month === month && last.day === day) return last.solar;
    const offsetOf = typeof site.offsetMinutes === 'function' ? site.offsetMinutes : hostOffsetMinutes;
    const offsetMinutes = offsetOf(new Date(year, month, day, 12));
    const solar = Object.freeze(solarDay({ year, month, day, lat: site.lat, lon: site.lon, offsetMinutes }));
    _lastDay = { site, year, month, day, solar };
    return solar;
}

/** The site's UTC offset (minutes) at the instant `date` names: its rule, or the host Date's. */
export function siteOffsetAt(date, site) {
    return typeof site?.offsetMinutes === 'function' ? site.offsetMinutes(date) : hostOffsetMinutes(date);
}
