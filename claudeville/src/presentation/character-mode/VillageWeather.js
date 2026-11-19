import { localDateKey, normalizeTimelineKnots, WEATHER_PRESETS } from './AtmosphereState.js';
import { WIND_MAX } from './Wind.js';

// Open-Meteo WMO codes (including 97). The seasonal engine still chooses
// how the rain family, including snow and freezing rain, lands in the village.
const TYPE_BY_CODE = new Map([
    [0, 'clear'], [1, 'partly-cloudy'], [2, 'partly-cloudy'], [3, 'overcast'],
    [45, 'fog'], [48, 'fog'],
    ...[51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 71, 73, 75, 77, 80, 81, 82, 85, 86].map(code => [code, 'rain']),
    ...[95, 96, 97, 99].map(code => [code, 'storm']),
]);

const clamp01 = value => Math.max(0, Math.min(1, value));

export function forecastKnot({ minute, code, cloud, mm, visibility, windSpeed, windDirection }) {
    let type = TYPE_BY_CODE.get(code);
    if (!type) return null;
    const wet = type === 'rain' || type === 'storm';
    const fog = Number.isFinite(visibility) ? clamp01(1 - visibility / 3000) : 0;
    if (!wet && fog >= 2 / 3) type = 'fog';
    const preset = WEATHER_PRESETS[type];
    const cloudCover = Number.isFinite(cloud) ? clamp01(cloud / 100) : preset.cloudCover;
    const amount = Number.isFinite(mm) ? Math.max(0, mm) : 0;
    const precipitation = wet ? clamp01(0.2 + Math.sqrt(amount) / 3.5) : 0;
    // A wind from the east blows toward screen left.
    const windX = Number.isFinite(windSpeed) && Number.isFinite(windDirection)
        ? -Math.sin(windDirection * Math.PI / 180) * WIND_MAX * clamp01(windSpeed / 60)
        : 0;
    return {
        minute,
        type,
        intensity: Math.max(preset.intensity * 0.5, cloudCover * 0.7, precipitation, fog),
        cloudCover,
        precipitation,
        fog: type === 'fog' ? Math.max(0.55, fog) : fog,
        windX,
    };
}

export function forecastKnotsByDate(hourly) {
    if (!Array.isArray(hourly?.time)) return null;
    const rows = new Map();
    for (const [i, at] of hourly.time.entries()) {
        if (!Number.isSafeInteger(at) || at <= 0 || at >= 8.64e12) continue;
        const date = new Date(at * 1000);
        const minute = date.getHours() * 60 + date.getMinutes();
        const knot = forecastKnot({
            minute,
            code: hourly.weather_code?.[i],
            cloud: hourly.cloud_cover?.[i],
            mm: hourly.precipitation?.[i],
            visibility: hourly.visibility?.[i],
            windSpeed: hourly.wind_speed_10m?.[i],
            windDirection: hourly.wind_direction_10m?.[i],
        });
        if (!knot) continue;
        const key = localDateKey(date);
        if (!rows.has(key)) rows.set(key, new Map());
        // shortcut: repeated DST minutes use the later reading, upgrade if the engine tracks both offsets.
        rows.get(key).set(minute, knot);
    }
    const days = Object.create(null);
    for (const [key, knots] of rows) {
        const day = normalizeTimelineKnots([...knots.values()]);
        // Skip partial horizon dates. Leave room for the missing DST hour.
        if (day[0].minute >= 60 || day.at(-1).minute < 1380
            || day.some((knot, i) => i > 0 && knot.minute - day[i - 1].minute > 120)) continue;
        days[key] = day;
    }
    return Object.keys(days).length ? Object.freeze(days) : null;
}
