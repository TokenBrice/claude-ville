// claudeville/src/presentation/character-mode/GroundState.js
//
// C-W2 — the ground remembers the weather (plan 5.2 of
// agents/plans/claudeville-opus55-xhigh-visual-plan.md). One pure function of
// (local date, minute, timeline inputs):
//
//   groundStateAt(date, options) → { wetness, puddles, snowCover, frost }
//
// integrated only from the village's own timeline history, read through
// AtmosphereState.weatherHistorySampler, so it survives reloads and reduced
// motion and never reads agent, mood or director state (V3). Memoized per
// 10-minute bucket: the state steps at most six times an hour and a reload at
// the same minute returns the same values.
//
//   wetness    a capped reservoir over the last six hours, stepped every
//              5 minutes: rain above PRECIPITATING fills it by
//              precip·dt / WET_GAIN_MINUTES (an hour of 0.68 rain fills it),
//              it drains WET_DRAIN_PER_MINUTE every step and holds at most
//              WET_CAP, clamped to 1. Draining is linear and the cap is
//              small, so however long it rained a road is puddled half an
//              hour after the rain stops, down to its deepest puddle cores
//              at 75 minutes and dry about two hours after. Winter
//              precipitation falls as snow and feeds snowCover instead.
//   puddles    smoothstep(0.35, 0.7, wetness).
//   snowCover  one continuous path since 00:00 on 1 December (M9 winter
//              opens with bare ground), stepped every 10 minutes: real
//              winter snowfall (precipitation above SNOWFALL_ON; overcast
//              drizzle flurries do not settle) adds
//              SNOW_GAIN_PER_HOUR·precip; it melts SNOW_MELT_PER_HOUR in
//              every non-winter hour and SNOW_SUN_MELT_PER_HOUR on winter
//              afternoons 11:00–16:00 that are dry and not overcast, so a
//              snowfall thaws through the quarters over a few days; clamped to
//              [0, 1]. The cover at each midnight is memoized per date, so
//              a day integrates once and the cover changes only by snowfall
//              or melt (never at a window edge). Snow lies only after it
//              snowed.
//   frost      1 on a clear, dry winter night (22:00–09:30) that has been
//              clear for the last two hours, else 0.
//
// `rainClearedMinutesAgo` reads the same history for the after-rain rainbow
// (5.8): minutes since the timeline went from rain to clearing, or null.

import { weatherHistorySampler } from './AtmosphereState.js';

export const GROUND_BUCKET_MINUTES = 10;
export const WET_GAIN_MINUTES = 30;
export const WET_DRAIN_PER_MINUTE = 0.008;
export const WET_CAP = 1.1;
export const PUDDLE_ON = 0.35;
export const PUDDLE_FULL = 0.7;
export const SNOW_GAIN_PER_HOUR = 0.5;
export const SNOW_MELT_PER_HOUR = 0.02;
// A dry, not overcast winter afternoon (11:00–16:00) thaws faster in the sun:
// a full cover lasts about three such afternoons.
export const SNOW_SUN_MELT_PER_HOUR = 0.06;
// Precipitation that settles as snow: rain- and storm-strength winter
// weather, not the 0.04 drizzle of an overcast day.
export const SNOWFALL_ON = 0.18;
// The weather layer's own threshold: above it WeatherRenderer draws rain (or
// snow in winter).
export const PRECIPITATING = 0.02;
// Minimum precipitation that counts as rain for the rainbow.
const RAIN_ON = SNOWFALL_ON;
export const RAINBOW_WINDOW_MINUTES = 20;

const DAY_MINUTES = 24 * 60;
const WET_STEP_MINUTES = 5;
const WET_HISTORY_MINUTES = 6 * 60;
const SNOW_STEP_MINUTES = 10;
const FROST_START = 22 * 60;
const FROST_END = 9 * 60 + 30;
const MELT_START = 11 * 60;
const MELT_END = 16 * 60;
const MEMO_MAX = 8;
const SNOW_DAY_MEMO_MAX = 512;

const _groundMemo = new Map();
const _rainbowMemo = new Map();
const _snowDayMemo = new Map();

function clamp01(value) {
    return value <= 0 ? 0 : value >= 1 ? 1 : value;
}

function smoothstep(edge0, edge1, value) {
    const t = clamp01((value - edge0) / (edge1 - edge0));
    return t * t * (3 - 2 * t);
}

export function isWinterMonth(monthIndex) {
    return monthIndex === 11 || monthIndex === 0 || monthIndex === 1;
}

function minuteOfDay(date) {
    return date.getHours() * 60 + date.getMinutes() + date.getSeconds() / 60;
}

function dateKey(date) {
    return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
}

function remember(memo, key, value) {
    memo.set(key, value);
    if (memo.size > MEMO_MAX) memo.delete(memo.keys().next().value);
    return value;
}

function timelineKey(options) {
    const knots = options.timelineKnots
        ? options.timelineKnots.map(k => `${k.minute}:${k.type}:${k.precipitation}:${k.cloudCover}`).join(',')
        : '';
    return `${options.timelineMode || 'auto'}|${options.seedOverride ?? ''}|${knots}`;
}

function historyKey(date, minute, options) {
    return `${dateKey(date)}|${minute}|${timelineKey(options)}`;
}

// History reader over [00:00 two days ago, today]: `at(t)` takes absolute
// minutes from that midnight, so today's minute m is t = 2·1440 + m.
function historyReader(date, options) {
    const days = [];
    for (let back = 2; back >= 0; back--) {
        const day = new Date(date.getFullYear(), date.getMonth(), date.getDate() - back);
        days.push({ month: day.getMonth(), sample: weatherHistorySampler(day, options) });
    }
    return {
        at(t) {
            const index = Math.max(0, Math.min(2, Math.floor(t / DAY_MINUTES)));
            const day = days[index];
            return { month: day.month, minute: t - index * DAY_MINUTES, weather: day.sample(t - index * DAY_MINUTES) };
        },
    };
}

function aboveFreezing(month, minute, weather) {
    if (!isWinterMonth(month)) return true;
    return minute >= MELT_START && minute < MELT_END
        && (Number(weather.precipitation) || 0) <= PRECIPITATING
        && (Number(weather.cloudCover) || 0) < 0.8;
}

function clearNight(weather) {
    return (Number(weather.precipitation) || 0) <= PRECIPITATING && (Number(weather.cloudCover) || 0) < 0.4;
}

function inFrostHours(minute) {
    return minute >= FROST_START || minute < FROST_END;
}

// One day of the snow path from `snow` at its 00:00, stepping t = 0, 10, …
// up to and including `untilMinute`.
function stepSnowDay(snow, day, sample, untilMinute) {
    const month = day.getMonth();
    for (let t = 0; t <= untilMinute; t += SNOW_STEP_MINUTES) {
        const weather = sample(t);
        const precip = Number(weather.precipitation) || 0;
        if (isWinterMonth(month) && precip > SNOWFALL_ON) {
            snow = Math.min(1, snow + precip * SNOW_GAIN_PER_HOUR * (SNOW_STEP_MINUTES / 60));
        } else if (snow > 0 && aboveFreezing(month, t, weather)) {
            const melt = isWinterMonth(month) ? SNOW_SUN_MELT_PER_HOUR : SNOW_MELT_PER_HOUR;
            snow = Math.max(0, snow - melt * (SNOW_STEP_MINUTES / 60));
        }
    }
    return snow;
}

// Snow cover at 00:00 of `date`. The path starts bare on 1 December; from
// April to November it is bare (March melts any February cover within
// 50 hours). Each midnight is memoized per timeline, so the walk back stops
// at the latest known day and a new day integrates once.
function snowAtMidnight(date, options) {
    const month = date.getMonth();
    if (month >= 3 && month <= 10) return 0;
    const tkey = timelineKey(options);
    const pending = [];
    let day = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    let snow = 0;
    while (!(day.getMonth() === 11 && day.getDate() === 1)) {
        const known = _snowDayMemo.get(`${tkey}|${dateKey(day)}`);
        if (known !== undefined) {
            snow = known;
            break;
        }
        pending.push(day);
        day = new Date(day.getFullYear(), day.getMonth(), day.getDate() - 1);
    }
    for (let i = pending.length - 1; i >= 0; i--) {
        snow = stepSnowDay(snow, day, weatherHistorySampler(day, options), DAY_MINUTES - SNOW_STEP_MINUTES);
        day = pending[i];
        _snowDayMemo.set(`${tkey}|${dateKey(day)}`, snow);
        if (_snowDayMemo.size > SNOW_DAY_MEMO_MAX) _snowDayMemo.delete(_snowDayMemo.keys().next().value);
    }
    return snow;
}

function snowCoverAt(date, bucket, options) {
    const start = snowAtMidnight(date, options);
    const month = date.getMonth();
    if (start <= 0 && !isWinterMonth(month)) return 0;
    return stepSnowDay(start, date, weatherHistorySampler(date, options), bucket);
}

/**
 * The timeline inputs of an atmosphere snapshot (`atmosphere.timeline`: seed
 * override, fixed/auto mode, pinned QA knots), so history readers integrate
 * exactly what the live weather resolved from.
 */
export function groundOptionsFor(atmosphere) {
    const timeline = atmosphere?.timeline || null;
    return {
        seedOverride: timeline?.seedOverride ?? null,
        timelineMode: timeline?.mode || 'auto',
        timelineKnots: timeline?.knots || null,
    };
}

/**
 * C-W2 ground state for `date` (its local minute, or `options.minute`).
 * `options`: `{ seedOverride, timelineMode, timelineKnots }` — the same
 * timeline inputs as the live snapshot (`atmosphere.timeline`).
 */
export function groundStateAt(date, options = {}) {
    const minute = Number.isFinite(options.minute) ? options.minute : minuteOfDay(date);
    const bucket = Math.floor(minute / GROUND_BUCKET_MINUTES) * GROUND_BUCKET_MINUTES;
    const key = historyKey(date, bucket, options);
    const cached = _groundMemo.get(key);
    if (cached) return cached;

    const history = historyReader(date, options);
    const now = 2 * DAY_MINUTES + bucket;

    let wet = 0;
    for (let t = now - WET_HISTORY_MINUTES; t <= now; t += WET_STEP_MINUTES) {
        const { month, weather } = history.at(t);
        const precip = Number(weather.precipitation) || 0;
        const fill = precip > PRECIPITATING && !isWinterMonth(month)
            ? precip * (WET_STEP_MINUTES / WET_GAIN_MINUTES)
            : 0;
        wet = Math.max(0, Math.min(WET_CAP, wet + fill - WET_DRAIN_PER_MINUTE * WET_STEP_MINUTES));
    }
    const wetness = clamp01(wet);

    const snow = snowCoverAt(date, bucket, options);

    const today = history.at(now);
    const earlier = history.at(now - 120);
    const frost = isWinterMonth(today.month) && inFrostHours(bucket)
        && clearNight(today.weather) && clearNight(earlier.weather) ? 1 : 0;

    return remember(_groundMemo, key, Object.freeze({
        wetness,
        puddles: smoothstep(PUDDLE_ON, PUDDLE_FULL, wetness),
        snowCover: snow,
        frost,
        bucketMinute: bucket,
    }));
}

/**
 * The snow-bake bucket (0 = bare, 1–4 = quarters): a bake happens only when
 * this changes, at most four times over a day's snowfall.
 */
export function snowBucketOf(snowCover) {
    const cover = Number(snowCover) || 0;
    return cover <= 0 ? 0 : Math.min(4, Math.ceil(cover * 4 - 1e-9));
}

/**
 * 5.8 — minutes (0–20) since the timeline went from rain to clearing at
 * `date`'s minute, or null (still raining, never rained, snow, or longer ago).
 */
export function rainClearedMinutesAgo(date, options = {}) {
    const minute = Math.floor(Number.isFinite(options.minute) ? options.minute : minuteOfDay(date));
    const key = historyKey(date, minute, options);
    if (_rainbowMemo.has(key)) return _rainbowMemo.get(key);
    const history = historyReader(date, options);
    const now = 2 * DAY_MINUTES + minute;
    let result = null;
    const current = history.at(now);
    if (!isWinterMonth(current.month) && (Number(current.weather.precipitation) || 0) <= PRECIPITATING) {
        for (let t = now - 1; t >= now - RAINBOW_WINDOW_MINUTES; t--) {
            if ((Number(history.at(t).weather.precipitation) || 0) <= PRECIPITATING) continue;
            // It precipitated at t: a rainbow only after real rain.
            for (let back = t; back >= t - 60; back -= 5) {
                if ((Number(history.at(back).weather.precipitation) || 0) > RAIN_ON) {
                    result = now - t;
                    break;
                }
            }
            break;
        }
    }
    return remember(_rainbowMemo, key, result);
}
