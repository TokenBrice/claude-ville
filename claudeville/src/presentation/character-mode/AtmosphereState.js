// claudeville/src/presentation/character-mode/AtmosphereState.js
//
// Local-clock atmosphere snapshots for world rendering. This module is pure
// browser-local state: no geolocation, network weather, or render-loop time is
// used to decide semantic time of day.
//
// Snapshot field layout (top-level vs nested):
//   atmosphere.phase / phaseProgress / dayProgress  — semantic time-of-day
//                                                     (dawn/day/dusk/night)
//   atmosphere.clock.{hours,minutes,seconds,label,phase,phaseProgress}
//                                                   — wall-clock readout, with
//                                                     phase fields aliased onto
//                                                     the clock for ergonomic
//                                                     external consumers
//   atmosphere.weather                              — type + intensity + wind
//   atmosphere.sky / lighting / grade / motion      — render-time tints, tones,
//                                                     and motion budget
//   atmosphere.lightGrade                           — C2 world grade
//                                                     (GradeEvaluator)
//
// The semantic phase fields exist at both the top level (canonical) AND nested
// under `clock` (alias). Prefer the top-level fields inside this module's
// renderer consumers; the nested aliases are for downstream tooling (HUDs,
// debug overlays) that already destructure `atmosphere.clock`.

import { seasonTokenForMonth } from './SeasonalAmbience.js';
import { applyGradeToRgb, evaluateGrade, lampCourseAt } from './GradeEvaluator.js';
import { ART_RAMPS } from '../../config/artPalette.js';
import { WIND_MAX, baseWindX, windAt, windSpeedForType } from './Wind.js';

const DAY_MINUTES = 24 * 60;
const WEATHER_TIMELINE_KNOTS = 6;

const PHASES = [
    { name: 'dawn', start: 5 * 60 + 30, end: 7 * 60 },
    { name: 'day', start: 7 * 60, end: 17 * 60 + 30 },
    { name: 'dusk', start: 17 * 60 + 30, end: 20 * 60 },
    { name: 'night', start: 20 * 60, end: 5 * 60 + 30 },
];

// 5.4 — seasonal day-length modulation. PHASES is the equinox (spring/autumn)
// baseline; winter shifts sunrise later and sunset earlier, summer the
// reverse. The season comes from the shared month→season mapping in
// SeasonalAmbience so the sky clock stays in lockstep with seasonal terrain
// and drift particles. Offsets are minutes applied to the phase boundaries.
const SEASONAL_DAY_LENGTH_OFFSETS = {
    winter: { sunrise: 40, sunset: -55 },
    summer: { sunrise: -40, sunset: 55 },
};

const SOLAR_SHADOW_ANGLES = Object.freeze({
    dawnHorizon: -0.78,
    dawnMidpoint: -0.68,
    noon: 0.28,
    duskMidpoint: 0.72,
    duskHorizon: 0.82,
});

function phasesForSeason(seasonToken) {
    const offsets = SEASONAL_DAY_LENGTH_OFFSETS[seasonToken];
    if (!offsets) return PHASES;
    return PHASES.map((phase) => {
        let { start, end } = phase;
        if (phase.name === 'dawn') { start += offsets.sunrise; end += offsets.sunrise; }
        else if (phase.name === 'day') { start += offsets.sunrise; end += offsets.sunset; }
        else if (phase.name === 'dusk') { start += offsets.sunset; end += offsets.sunset; }
        else if (phase.name === 'night') { start += offsets.sunset; end += offsets.sunrise; }
        return { name: phase.name, start, end };
    });
}

// 1.8 — shared phase resolution for non-world surfaces (dashboard ambience
// sync): one canonical table + seasonal day-length logic, so the dashboard
// clock can never drift from the world sky. Returns the phase name only;
// render consumers keep using the full snapshot's phase/phaseProgress.
export function phaseNameForDate(date) {
    const minute = minutesSinceMidnight(date);
    const phases = phasesForSeason(seasonTokenForMonth(date.getMonth()));
    return resolvePhase(minute, phases).phase;
}

export const WEATHER_TYPES = ['clear', 'partly-cloudy', 'overcast', 'rain', 'fog', 'storm'];
const WEATHER_TYPE_SET = new Set(WEATHER_TYPES);

export const WEATHER_PRESETS = {
    clear: {
        intensity: 0.18,
        cloudCover: 0.10,
        precipitation: 0,
        fog: 0,
        starOcclusion: 0,
        sunOcclusion: 0,
    },
    'partly-cloudy': {
        intensity: 0.48,
        cloudCover: 0.42,
        precipitation: 0,
        fog: 0.02,
        starOcclusion: 0.28,
        sunOcclusion: 0.12,
    },
    overcast: {
        intensity: 0.68,
        cloudCover: 0.86,
        precipitation: 0.04,
        fog: 0.08,
        starOcclusion: 0.94,
        sunOcclusion: 0.58,
    },
    rain: {
        intensity: 0.78,
        cloudCover: 0.94,
        precipitation: 0.68,
        fog: 0.14,
        starOcclusion: 0.98,
        sunOcclusion: 0.68,
    },
    fog: {
        intensity: 0.58,
        cloudCover: 0.60,
        precipitation: 0,
        fog: 0.78,
        starOcclusion: 0.72,
        sunOcclusion: 0.34,
    },
    storm: {
        intensity: 0.88,
        cloudCover: 1,
        precipitation: 0.92,
        fog: 0.18,
        starOcclusion: 1,
        sunOcclusion: 0.82,
    },
};

// The sun has no asset: SkyRenderer bakes a flat-to-core stepped disc (0.10).
// The sky's clouds are SkyRenderer's baked horizon deck (5.7), not sprites.
const SKY_ASSETS = Object.freeze({ moon: 'atmosphere.moon.crescent.cool' });

function clamp(value, min = 0, max = 1) {
    return Math.max(min, Math.min(max, value));
}

function smoothstep(value) {
    const t = clamp(value);
    return t * t * (3 - 2 * t);
}

function minutesSinceMidnight(date) {
    return date.getHours() * 60
        + date.getMinutes()
        + date.getSeconds() / 60
        + date.getMilliseconds() / 60000;
}

function isWithinInterval(minute, start, end) {
    if (end >= start) return minute >= start && minute < end;
    return minute >= start || minute < end;
}

export function progressInInterval(minute, start, end) {
    let adjustedMinute = minute;
    let adjustedEnd = end;
    if (end < start) {
        adjustedEnd += DAY_MINUTES;
        if (adjustedMinute < start) adjustedMinute += DAY_MINUTES;
    }
    return clamp((adjustedMinute - start) / (adjustedEnd - start));
}

function easedSolarAngle(minute, start, end, fromAngle, toAngle) {
    return fromAngle + (toAngle - fromAngle) * smoothstep(progressInInterval(minute, start, end));
}

// One clock-derived solar pose for every directional-light consumer. The
// authored dawn, noon, and dusk angles remain calibration knots; smoothstep
// only eases travel between them, while elevation follows the sky's sine arc.
export function solarVectorForMinute(minuteOfDay, seasonToken = '') {
    const minuteValue = Number(minuteOfDay);
    const finiteMinute = Number.isFinite(minuteValue) ? minuteValue : 0;
    const minute = ((finiteMinute % DAY_MINUTES) + DAY_MINUTES) % DAY_MINUTES;
    const phases = phasesForSeason(seasonToken);
    const dawn = phases[0];
    const dusk = phases[2];
    const sunriseMinute = dawn.start;
    const dawnMidpointMinute = (dawn.start + dawn.end) / 2;
    const sunsetMinute = dusk.end;
    const duskMidpointMinute = (dusk.start + dusk.end) / 2;
    const solarNoonMinute = (sunriseMinute + sunsetMinute) / 2;
    const isDaylight = minute >= sunriseMinute && minute <= sunsetMinute;

    let shadowAngleRad;
    if (isDaylight) {
        if (minute <= dawnMidpointMinute) {
            shadowAngleRad = easedSolarAngle(
                minute,
                sunriseMinute,
                dawnMidpointMinute,
                SOLAR_SHADOW_ANGLES.dawnHorizon,
                SOLAR_SHADOW_ANGLES.dawnMidpoint,
            );
        } else if (minute <= solarNoonMinute) {
            shadowAngleRad = easedSolarAngle(
                minute,
                dawnMidpointMinute,
                solarNoonMinute,
                SOLAR_SHADOW_ANGLES.dawnMidpoint,
                SOLAR_SHADOW_ANGLES.noon,
            );
        } else if (minute <= duskMidpointMinute) {
            shadowAngleRad = easedSolarAngle(
                minute,
                solarNoonMinute,
                duskMidpointMinute,
                SOLAR_SHADOW_ANGLES.noon,
                SOLAR_SHADOW_ANGLES.duskMidpoint,
            );
        } else {
            shadowAngleRad = easedSolarAngle(
                minute,
                duskMidpointMinute,
                sunsetMinute,
                SOLAR_SHADOW_ANGLES.duskMidpoint,
                SOLAR_SHADOW_ANGLES.duskHorizon,
            );
        }
    } else {
        shadowAngleRad = easedSolarAngle(
            minute,
            sunsetMinute,
            sunriseMinute,
            SOLAR_SHADOW_ANGLES.duskHorizon,
            SOLAR_SHADOW_ANGLES.dawnHorizon,
        );
    }

    const daylightProgress = progressInInterval(minute, sunriseMinute, sunsetMinute);
    const elevation = isDaylight ? Math.sin(daylightProgress * Math.PI) : 0;
    return {
        sunDirIso: {
            x: Math.cos(shadowAngleRad + Math.PI),
            y: Math.sin(shadowAngleRad + Math.PI),
        },
        shadowAngleRad,
        elevation,
        sunriseMinute,
        solarNoonMinute,
        sunsetMinute,
    };
}

export function localDateKey(date) {
    const yyyy = date.getFullYear();
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    const dd = String(date.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
}

export function hashString(value) {
    let hash = 2166136261;
    for (let i = 0; i < value.length; i++) {
        hash ^= value.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
}

function seededRandom(seed) {
    let state = seed >>> 0;
    return () => {
        state = Math.imul(1664525, state) + 1013904223;
        return (state >>> 0) / 4294967296;
    };
}

function weatherTypeFromRoll(roll, minute) {
    const hour = minute / 60;
    const fogBias = hour < 7 || hour >= 21 ? 0.08 : 0;
    const stormBias = hour >= 13 && hour <= 20 ? 0.018 : 0.004;
    if (roll < 0.42 - fogBias * 0.4) return 'clear';
    if (roll < 0.72 - fogBias * 0.2) return 'partly-cloudy';
    if (roll < 0.86) return 'overcast';
    if (roll < 0.94 + fogBias) return 'fog';
    if (roll < 0.992 - stormBias) return 'rain';
    return 'storm';
}

// C-W3 — the knot wind is `sign × speed[type]`: still in fog, a light breeze
// on a clear day, a gale in a storm (Wind.js owns the table). The sign keeps
// the authored 18 % chance of an easterly.
function buildWeatherKnot(type, minute, random, seed) {
    const preset = WEATHER_PRESETS[type] || WEATHER_PRESETS.clear;
    const jitter = (random() - 0.5) * 0.18;
    const intensity = clamp(preset.intensity + jitter, 0, 1);
    return {
        minute,
        type,
        intensity,
        cloudCover: clamp(preset.cloudCover + jitter * 0.75, 0, 1),
        precipitation: clamp(preset.precipitation * (0.82 + random() * 0.36), 0, 1),
        fog: clamp(preset.fog * (0.78 + random() * 0.44), 0, 1),
        windX: (random() < 0.18 ? -1 : 1) * windSpeedForType(type),
        seed,
    };
}

// C-W1 — `null`/`undefined` (and anything non-numeric) never coerce to seed 0:
// `Number(null)` is 0 and finite, which once gave every date the same six
// knots. Only an explicit numeric seed overrides the date hash.
function resolveSeed(seedOverride, fallbackKey) {
    return seedOverride == null || !Number.isFinite(Number(seedOverride))
        ? hashString(fallbackKey)
        : Number(seedOverride) >>> 0;
}

export function buildWeatherTimeline(date, seedOverride = null) {
    const dateKey = localDateKey(date);
    const seed = resolveSeed(seedOverride, `${dateKey}|weather-timeline`);
    const random = seededRandom(seed);
    const knots = [];

    for (let i = 0; i < WEATHER_TIMELINE_KNOTS; i++) {
        const baseMinute = Math.round((DAY_MINUTES / WEATHER_TIMELINE_KNOTS) * i);
        const jitter = i === 0 ? 0 : Math.round((random() - 0.5) * 90);
        const minute = clamp(baseMinute + jitter, 0, DAY_MINUTES - 1);
        knots.push(buildWeatherKnot(weatherTypeFromRoll(random(), minute), minute, random, seed + i * 997));
    }

    knots.sort((a, b) => a.minute - b.minute);
    knots[0] = { ...knots[0], minute: 0 };
    return {
        seed,
        dateKey,
        knots,
    };
}

function interpolateNumber(from, to, weight) {
    return from + (to - from) * weight;
}

// The minute's weather between two knots, without wind: the smoothstepped
// blend and the type it resolves to (the nearer knot's, re-derived from the
// blended fog / precipitation / cloud), plus the nearer knot (its wind sign).
function timelineStateAt(minute, knots) {
    let previous = knots[knots.length - 1];
    let next = knots[0];
    let adjustedMinute = minute;

    for (let i = 0; i < knots.length; i++) {
        const current = knots[i];
        const candidate = knots[(i + 1) % knots.length];
        const candidateMinute = candidate.minute <= current.minute
            ? candidate.minute + DAY_MINUTES
            : candidate.minute;
        const localMinute = minute < current.minute ? minute + DAY_MINUTES : minute;
        if (localMinute >= current.minute && localMinute < candidateMinute) {
            previous = current;
            next = candidate;
            adjustedMinute = localMinute;
            break;
        }
    }

    const nextMinute = next.minute <= previous.minute ? next.minute + DAY_MINUTES : next.minute;
    const rawProgress = clamp((adjustedMinute - previous.minute) / Math.max(1, nextMinute - previous.minute));
    const transitionProgress = smoothstep(rawProgress);
    const intensity = clamp(interpolateNumber(previous.intensity, next.intensity, transitionProgress));
    const cloudCover = clamp(interpolateNumber(previous.cloudCover, next.cloudCover, transitionProgress));
    const precipitation = clamp(interpolateNumber(previous.precipitation, next.precipitation, transitionProgress));
    const fog = clamp(interpolateNumber(previous.fog, next.fog, transitionProgress));
    let type = transitionProgress < 0.5 ? previous.type : next.type;
    if (previous.type === 'storm' || next.type === 'storm') {
        if (precipitation > 0.34 && cloudCover > 0.78) type = 'storm';
    } else if (precipitation > 0.18) {
        type = 'rain';
    } else if (fog > 0.24) {
        type = 'fog';
    } else if (cloudCover > 0.74) {
        type = 'overcast';
    }
    return {
        previous,
        next,
        nearer: transitionProgress < 0.5 ? previous : next,
        transitionProgress,
        intensity,
        cloudCover,
        precipitation,
        fog,
        type,
    };
}

// C-W3 — the timeline wind follows the resolved type, never the knot alone:
// each stretch of the day blows at `sign × speed[type]` (the sign of the
// nearer knot), and where the type or sign changes the wind eases over at
// most WIND_EASE_MINUTES, always inside the windier stretch, so a fog minute
// is still (|windX| ≤ the fog speed) and the wind never jumps between frames.
const WIND_EASE_MINUTES = 12;
const WIND_SCAN_STEP_MINUTES = 0.25;
const WIND_EDGE_PRECISION_MINUTES = 1 / 600;
const _windPlans = new Map();

function windTargetAt(minute, knots) {
    const state = timelineStateAt(minute, knots);
    return (Number(state.nearer.windX) < 0 ? -1 : 1) * windSpeedForType(state.type);
}

function circularOffset(from, to) {
    const d = (to - from) % DAY_MINUTES;
    return d < 0 ? d + DAY_MINUTES : d;
}

// The day's wind stretches (circular): every edge where the target changes,
// found on a quarter-minute scan and bisected, with its ease window.
function timelineWindPlan(knots) {
    const key = knots.map(knot => `${knot.minute},${knot.type},${knot.windX},${knot.intensity},${knot.cloudCover},${knot.precipitation},${knot.fog}`).join('|');
    const cached = _windPlans.get(key);
    if (cached) return cached;
    const steps = Math.round(DAY_MINUTES / WIND_SCAN_STEP_MINUTES);
    const edges = [];
    let before = windTargetAt(DAY_MINUTES - WIND_SCAN_STEP_MINUTES, knots);
    for (let i = 0; i < steps; i++) {
        const at = i * WIND_SCAN_STEP_MINUTES;
        const target = windTargetAt(at, knots);
        if (target !== before) {
            let lo = at - WIND_SCAN_STEP_MINUTES;
            let hi = at;
            while (hi - lo > WIND_EDGE_PRECISION_MINUTES) {
                const mid = (lo + hi) / 2;
                if (windTargetAt(mid < 0 ? mid + DAY_MINUTES : mid, knots) === before) lo = mid;
                else hi = mid;
            }
            edges.push({ at: hi < 0 ? hi + DAY_MINUTES : hi, from: before, to: target, lead: 0, lag: 0 });
        }
        before = target;
    }
    edges.sort((a, b) => a.at - b.at);
    for (let i = 0; i < edges.length; i++) {
        const edge = edges[i];
        const prevSpan = edges.length === 1 ? DAY_MINUTES : circularOffset(edges[(i - 1 + edges.length) % edges.length].at, edge.at);
        const nextSpan = edges.length === 1 ? DAY_MINUTES : circularOffset(edge.at, edges[(i + 1) % edges.length].at);
        const calmer = Math.abs(edge.to) - Math.abs(edge.from);
        if (calmer < 0) edge.lead = Math.min(WIND_EASE_MINUTES, prevSpan / 2);
        else if (calmer > 0) edge.lag = Math.min(WIND_EASE_MINUTES, nextSpan / 2);
        else {
            edge.lead = Math.min(WIND_EASE_MINUTES / 2, prevSpan / 2);
            edge.lag = Math.min(WIND_EASE_MINUTES / 2, nextSpan / 2);
        }
    }
    const plan = { edges, constant: edges.length ? 0 : windTargetAt(0, knots) };
    if (_windPlans.size >= 8) _windPlans.delete(_windPlans.keys().next().value);
    _windPlans.set(key, plan);
    return plan;
}

function timelineWindAt(minute, knots) {
    const plan = timelineWindPlan(knots);
    if (!plan.edges.length) return plan.constant;
    const m = circularOffset(0, minute);
    let latest = null;
    let latestOffset = Infinity;
    for (const edge of plan.edges) {
        const after = circularOffset(edge.at, m);
        if (after <= edge.lag && edge.lag > 0) {
            return edge.from + (edge.to - edge.from) * smoothstep((edge.lead + after) / (edge.lead + edge.lag));
        }
        const ahead = circularOffset(m, edge.at);
        if (ahead > 0 && ahead <= edge.lead) {
            return edge.from + (edge.to - edge.from) * smoothstep((edge.lead - ahead) / (edge.lead + edge.lag));
        }
        if (after < latestOffset) {
            latestOffset = after;
            latest = edge;
        }
    }
    return latest.to;
}

export function resolveWeatherAt(minute, timeline) {
    const knots = timeline?.knots || [];
    if (!knots.length) return normalizeWeatherOverride({ type: 'clear' }, timeline?.seed);

    const state = timelineStateAt(minute, knots);
    return {
        type: state.type,
        previousType: state.previous.type,
        nextType: state.next.type,
        transitionProgress: state.transitionProgress,
        intensity: state.intensity,
        cloudCover: state.cloudCover,
        precipitation: state.precipitation,
        fog: state.fog,
        windX: timelineWindAt(minute, knots),
        seed: timeline.seed,
        cause: 'timeline',
        timelineMode: 'auto',
        timeline: knots.map(knot => ({
            minute: knot.minute,
            type: knot.type,
            intensity: Number(knot.intensity.toFixed(3)),
            windX: knot.windX,
        })),
    };
}

function deterministicWeather(date, seedOverride = null) {
    const minute = minutesSinceMidnight(date);
    const seed = resolveSeed(seedOverride, `${localDateKey(date)}|weather|fixed`);
    const random = seededRandom(seed);
    const roll = random();
    return normalizeWeatherOverride(buildWeatherKnot(weatherTypeFromRoll(roll, minute), minute, random, seed), seed);
}

function resolvePhase(minute, phases = PHASES) {
    for (const phase of phases) {
        if (isWithinInterval(minute, phase.start, phase.end)) {
            return {
                phase: phase.name,
                phaseProgress: progressInInterval(minute, phase.start, phase.end),
            };
        }
    }
    return { phase: 'day', phaseProgress: 0 };
}

function phaseTransition(phase, phaseProgress) {
    const index = PHASES.findIndex(item => item.name === phase);
    const previous = PHASES[(index - 1 + PHASES.length) % PHASES.length] || PHASES[PHASES.length - 1];
    const next = PHASES[(index + 1) % PHASES.length] || PHASES[0];
    const edgeWindow = phase === 'day' || phase === 'night' ? 0.08 : 0.22;
    if (phaseProgress < edgeWindow) {
        return {
            from: previous.name,
            to: phase,
            weight: smoothstep(phaseProgress / edgeWindow),
            edge: `enter-${phase}`,
        };
    }
    if (phaseProgress > 1 - edgeWindow) {
        return {
            from: phase,
            to: next.name,
            weight: smoothstep((phaseProgress - (1 - edgeWindow)) / edgeWindow),
            edge: `exit-${phase}`,
        };
    }
    return {
        from: phase,
        to: phase,
        weight: 1,
        edge: `in-${phase}`,
    };
}

function hexToRgb(hex) {
    const value = String(hex || '').replace('#', '').trim();
    if (value.length !== 6) return { r: 255, g: 255, b: 255 };
    return {
        r: parseInt(value.slice(0, 2), 16),
        g: parseInt(value.slice(2, 4), 16),
        b: parseInt(value.slice(4, 6), 16),
    };
}

function blendChannel(from, to, weight) {
    return Math.round(interpolateNumber(from, to, clamp(weight)));
}

function rgbToHex({ r, g, b }) {
    return `#${[r, g, b].map(channel => blendChannel(channel, channel, 0).toString(16).padStart(2, '0')).join('')}`;
}

function blendRgb(from, to, weight) {
    return {
        r: blendChannel(from.r, to.r, weight),
        g: blendChannel(from.g, to.g, weight),
        b: blendChannel(from.b, to.b, weight),
    };
}

// #29 — Weather-coupled world tint (the overlay-tint contract): under
// rain/storm the tint leans toward the storm cast, weighted by how much of the
// sky the storm actually covers. The sky itself is greyed by the C2 grade's
// weather row (skyPaletteFor).
const STORM_WORLD_TINT = 'rgba(60, 45, 80, 0.28)';
const STORM_BIAS = { rain: 0.42, storm: 0.62 };

function stormPaletteShift(weather) {
    const bias = STORM_BIAS[weather?.type];
    if (!bias) return 0;
    const cloudCover = clamp(Number(weather.cloudCover) || 0);
    return clamp(cloudCover * bias);
}

// Lerp two `rgba(...)` strings (including alpha) by weight, returning an
// `rgba(...)` string. Falls back to the source on unparseable input.
function lerpRgbaString(from, to, weight) {
    const a = parseRgbaString(from);
    const b = parseRgbaString(to);
    if (!a || !b) return from;
    const w = clamp(weight);
    const r = Math.round(interpolateNumber(a.r, b.r, w));
    const g = Math.round(interpolateNumber(a.g, b.g, w));
    const bl = Math.round(interpolateNumber(a.b, b.b, w));
    const al = Number(interpolateNumber(a.a, b.a, w).toFixed(3));
    return `rgba(${r}, ${g}, ${bl}, ${al})`;
}

// 1.3 — the sky palette is the C2 grade's own sky, void and haze, so the
// backdrop is graded with the island on every backend. These are final
// (already graded) colours: the resident path paints them as-is behind the
// GPU canvas, the Canvas/PostFx paths paint their preimage (CanvasGrade
// `ungradeRgb`) because the whole 2D frame is graded after it is drawn, and
// App writes the first four stops as the boot sky CSS vars so the boot fade
// meets the first frame. Salience (C1): the sky may not out-shout the island
// (HSV S <= 0.42); the void is a luma ramp in the C1 void ratios, tinted by
// the phase's voidColor and never lighter than the graded deep water.
const SKY_SATURATION_CAP = 0.42;
const VOID_LUMA_RATIOS = [1, 0.70, 0.53];
const STAR_COLORS = { starWarm: '#c9ddff', starHot: '#f2f7ff' };
const DEEP_WATER_ALBEDO = hexToRgb01(ART_RAMPS.deepWater[1]);

let _skyPaletteGrade = null;
let _skyPalette = null;

function hexToRgb01(hex) {
    const { r, g, b } = hexToRgb(hex);
    return [r / 255, g / 255, b / 255];
}

function rgb01ToHex(rgb) {
    return rgbToHex({ r: clamp(rgb[0]) * 255, g: clamp(rgb[1]) * 255, b: clamp(rgb[2]) * 255 });
}

function rgbLuma(rgb) {
    return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
}

function hsvSaturation(rgb) {
    const max = Math.max(rgb[0], rgb[1], rgb[2]);
    return max <= 0 ? 0 : (max - Math.min(rgb[0], rgb[1], rgb[2])) / max;
}

function capSaturation(rgb, cap = SKY_SATURATION_CAP) {
    if (hsvSaturation(rgb) <= cap) return rgb;
    const luma = rgbLuma(rgb);
    const toward = k => rgb.map(channel => luma + (channel - luma) * k);
    let lo = 0;
    let hi = 1;
    for (let step = 0; step < 10; step++) {
        const mid = (lo + hi) / 2;
        if (hsvSaturation(toward(mid)) > cap) hi = mid;
        else lo = mid;
    }
    return toward(lo);
}

function rgbToHsv(rgb) {
    const max = Math.max(rgb[0], rgb[1], rgb[2]);
    const min = Math.min(rgb[0], rgb[1], rgb[2]);
    const d = max - min;
    let h = 0;
    if (d > 1e-6) {
        if (max === rgb[0]) h = ((rgb[1] - rgb[2]) / d) % 6;
        else if (max === rgb[1]) h = (rgb[2] - rgb[0]) / d + 2;
        else h = (rgb[0] - rgb[1]) / d + 4;
        h = ((h * 60) + 360) % 360;
    }
    return [h, max <= 0 ? 0 : d / max, max];
}

function hsvToRgb([h, s, v]) {
    const c = v * s;
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    const m = v - c;
    const sector = Math.floor((((h % 360) + 360) % 360) / 60);
    const [r, g, b] = [[c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x]][sector];
    return [r + m, g + m, b + m];
}

/**
 * A colour at `t` (0..1) along a ladder of 0..1 RGB stops, interpolated in
 * HSV. A straight RGB mix of a blue zenith and a warm horizon falls through
 * grey; when the ends are far apart in hue the ramp goes the way that passes
 * through violet and rose (never through green), as a real dusk sky does.
 */
export function sampleSkyLadder(ladder, t) {
    const span = (ladder.length - 1) * clamp(t);
    const index = Math.min(ladder.length - 2, Math.floor(span));
    const local = span - index;
    const a = rgbToHsv(ladder[index]);
    const b = rgbToHsv(ladder[index + 1]);
    // A near-grey end has no hue of its own: borrow the other end's.
    if (a[1] < 0.04) a[0] = b[0];
    if (b[1] < 0.04) b[0] = a[0];
    let dh = ((b[0] - a[0] + 540) % 360) - 180;
    const long = Math.abs(dh) > 110;
    if (long) {
        const mid = (((a[0] + dh / 2) % 360) + 360) % 360;
        if (mid < 200 && mid > 60) dh = dh > 0 ? dh - 360 : dh + 360;
    }
    // The long way round stays dusty (lilac and rose, not neon violet).
    const dust = long ? 1 - 0.45 * Math.sin(Math.PI * local) : 1;
    return hsvToRgb([
        a[0] + dh * local,
        (a[1] + (b[1] - a[1]) * local) * dust,
        a[2] + (b[2] - a[2]) * local,
    ]).map(channel => clamp(channel));
}

export function skyPaletteFor(grade) {
    if (!grade) return null;
    if (grade === _skyPaletteGrade && _skyPalette) return _skyPalette;
    const top = capSaturation(hexToRgb01(grade.skyTop));
    const horizon = capSaturation(hexToRgb01(grade.skyHorizon));
    const haze = capSaturation(hexToRgb01(grade.horizonHaze));
    let voidNear = hexToRgb01(grade.voidColor);
    const deepLuma = rgbLuma(applyGradeToRgb(DEEP_WATER_ALBEDO, grade));
    const voidLuma = rgbLuma(voidNear);
    if (voidLuma > deepLuma * 0.92) voidNear = voidNear.map(channel => channel * (deepLuma * 0.92) / voidLuma);
    const voidStops = VOID_LUMA_RATIOS.map(ratio => rgb01ToHex(voidNear.map(channel => channel * ratio)));
    const hazeHex = rgb01ToHex(haze);
    const hazeRgb = hexToRgb(hazeHex);
    _skyPaletteGrade = grade;
    _skyPalette = Object.freeze({
        zenith: rgb01ToHex(top),
        upperBand: rgb01ToHex(sampleSkyLadder([top, horizon], 0.38)),
        midBand: rgb01ToHex(sampleSkyLadder([top, horizon], 0.72)),
        horizon: rgb01ToHex(horizon),
        haze: hazeHex,
        horizonGlow: `${hazeRgb.r}, ${hazeRgb.g}, ${hazeRgb.b}`,
        voidNear: voidStops[0],
        voidMid: voidStops[1],
        voidFar: voidStops[2],
        ...STAR_COLORS,
    });
    return _skyPalette;
}

function applyHourOverride(date, hourNumber) {
    if (!Number.isFinite(hourNumber)) return date;
    const normalized = ((hourNumber % 24) + 24) % 24;
    const wholeHour = Math.floor(normalized);
    const minuteFloat = (normalized - wholeHour) * 60;
    const wholeMinute = Math.floor(minuteFloat);
    const secondFloat = (minuteFloat - wholeMinute) * 60;
    const wholeSecond = Math.floor(secondFloat);
    const millisecond = Math.round((secondFloat - wholeSecond) * 1000);
    const copy = new Date(date.getTime());
    copy.setHours(wholeHour, wholeMinute, wholeSecond, millisecond);
    return copy;
}

function normalizeDate(value) {
    return value?.getTime ? new Date(value.getTime()) : new Date(value);
}

function preferredMotionScale(fallback) {
    if (Number.isFinite(fallback)) return fallback;
    if (typeof window === 'undefined') return 1;
    try {
        return window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ? 0 : 1;
    } catch {
        return 1;
    }
}

function normalizeWeatherType(type) {
    const value = String(type || 'clear').trim().toLowerCase().replace(/[\s_]+/g, '-');
    if (value === 'cloudy') return 'overcast';
    if (value === 'stormy' || value === 'thunderstorm') return 'storm';
    if (value === 'partlycloudy') return 'partly-cloudy';
    return WEATHER_TYPE_SET.has(value) ? value : 'clear';
}

function isKnownWeatherTypeInput(type) {
    const value = String(type || '').trim().toLowerCase().replace(/[\s_]+/g, '-');
    return WEATHER_TYPE_SET.has(value)
        || value === 'cloudy'
        || value === 'stormy'
        || value === 'thunderstorm'
        || value === 'partlycloudy';
}

function normalizeWeatherOverride(override, fallbackSeed = null) {
    const type = normalizeWeatherType(override?.type);
    const base = WEATHER_PRESETS[type];
    const intensity = Number.isFinite(Number(override?.intensity))
        ? clamp(Number(override.intensity))
        : base.intensity;
    // A missing wind (`null`/`undefined`, which `Number()` would coerce to a
    // calm 0) takes the type's own speed toward +x.
    const windValue = override?.windX == null ? NaN : Number(override.windX);
    return {
        type,
        previousType: normalizeWeatherType(override?.previousType || type),
        nextType: normalizeWeatherType(override?.nextType || type),
        transitionProgress: Number.isFinite(Number(override?.transitionProgress))
            ? clamp(Number(override.transitionProgress))
            : 1,
        intensity,
        cloudCover: Number.isFinite(Number(override?.cloudCover))
            ? clamp(Number(override.cloudCover))
            : clamp(base.cloudCover * (0.72 + intensity * 0.5)),
        precipitation: Number.isFinite(Number(override?.precipitation))
            ? clamp(Number(override.precipitation))
            : clamp(base.precipitation * (0.72 + intensity * 0.5)),
        fog: Number.isFinite(Number(override?.fog))
            ? clamp(Number(override.fog))
            : clamp(base.fog * (0.72 + intensity * 0.5)),
        windX: Number.isFinite(windValue) ? clamp(windValue, -WIND_MAX, WIND_MAX) : windSpeedForType(type),
        // C-W1 — `null`/`undefined` never coerce to seed 0 (`Number(null)`).
        seed: override?.seed != null && Number.isFinite(Number(override.seed))
            ? Number(override.seed) >>> 0
            : fallbackSeed != null && Number.isFinite(Number(fallbackSeed))
                ? Number(fallbackSeed) >>> 0
                : hashString(`weather-override|${type}`),
        cause: 'timeline',
        timelineMode: 'fixed',
    };
}

// C-W1 — the weather is a pure function of (local date, minute, optional
// explicit seed or debug override). Nothing about agents, moods, the
// director, pushes or the Chronicle can reach it.
export function resolveWeather(date, override = null, { seedOverride = null, timelineMode = 'auto', timelineKnots = null } = {}) {
    if (override) return normalizeWeatherOverride(override, seedOverride);
    // Pinned QA knots win in both modes: fixed mode only drops the date hash.
    if (timelineMode === 'fixed' && !timelineKnots) return deterministicWeather(date, seedOverride);
    return resolveWeatherAt(minutesSinceMidnight(date), timelineFor(date, seedOverride, timelineKnots));
}

// QA debug hook (5.2 acceptance): a pinned knot list replaces the date-hashed
// timeline on every date, so the live weather and `groundStateAt`'s history
// read the same knots. Reachable only from `window.__claudeVilleAtmosphere`
// (`setTimelineKnots`), never from agent, mood or director state (V3).
// Each knot is `{ minute, type }` plus optional `intensity`, `cloudCover`,
// `precipitation`, `fog`, `windX`; missing values take the type's preset.
export function normalizeTimelineKnots(knots) {
    if (!Array.isArray(knots) || knots.length === 0) return null;
    const out = [];
    for (const knot of knots) {
        const minute = Number(knot?.minute);
        if (!Number.isFinite(minute) || !isKnownWeatherTypeInput(knot?.type)) continue;
        const type = normalizeWeatherType(knot.type);
        const preset = WEATHER_PRESETS[type];
        const pick = (key, fallback) => (Number.isFinite(Number(knot[key])) ? clamp(Number(knot[key])) : fallback);
        const windX = Number(knot.windX);
        out.push({
            minute: clamp(Math.round(minute), 0, DAY_MINUTES - 1),
            type,
            intensity: pick('intensity', preset.intensity),
            cloudCover: pick('cloudCover', preset.cloudCover),
            precipitation: pick('precipitation', preset.precipitation),
            fog: pick('fog', preset.fog),
            windX: Number.isFinite(windX) ? clamp(windX, -WIND_MAX, WIND_MAX) : windSpeedForType(type),
            seed: 0,
        });
    }
    if (!out.length) return null;
    out.sort((a, b) => a.minute - b.minute);
    return Object.freeze(out.map(knot => Object.freeze(knot)));
}

function timelineFor(date, seedOverride, timelineKnots) {
    if (!timelineKnots) return buildWeatherTimeline(date, seedOverride);
    const dateKey = localDateKey(date);
    return { seed: resolveSeed(seedOverride, `${dateKey}|weather-timeline`), dateKey, knots: timelineKnots };
}

/**
 * C-W2 — the weather history reader for `GroundState.groundStateAt`: one
 * date's sampler `(minute) → { type, precipitation, cloudCover }` over the
 * same resolution the live snapshot uses (the date-hashed or pinned timeline,
 * or the fixed-mode deterministic weather). Debug weather overrides are a
 * live-only look and never enter the history.
 */
export function weatherHistorySampler(date, { seedOverride = null, timelineMode = 'auto', timelineKnots = null } = {}) {
    if (timelineMode === 'fixed' && !timelineKnots) {
        const at = new Date(date.getFullYear(), date.getMonth(), date.getDate());
        return (minute) => {
            at.setHours(0, Math.floor(minute), 0, 0);
            return deterministicWeather(at, seedOverride);
        };
    }
    const knots = timelineFor(date, seedOverride, timelineKnots).knots;
    return (minute) => timelineStateAt(minute, knots);
}

function phaseLight(phase, phaseProgress) {
    if (phase === 'day') return 1;
    if (phase === 'dawn') return smoothstep(phaseProgress);
    if (phase === 'dusk') return 1 - smoothstep(phaseProgress);
    return 0;
}

// 1.3 — stars only at real night: they follow the C2 grade's night weight
// (0 through golden and blue hour, full from ~21:30), not the phase name.
function starAlpha(lightGrade, weather) {
    const base = 0.9 * smoothstep(((lightGrade?.night ?? 0) - 0.6) / 0.35);
    const preset = WEATHER_PRESETS[weather.type] || WEATHER_PRESETS.clear;
    return clamp(base * (1 - preset.starOcclusion * clamp(weather.intensity + 0.22)));
}

function celestialHorizonState(yFrac, horizonFrac) {
    const proximity = smoothstep((yFrac - (horizonFrac - 0.085)) / 0.14);
    return {
        horizonOcclusion: clamp(proximity * 0.52),
        squashY: clamp(1 - proximity * 0.26, 0.72, 1),
        horizonFade: clamp(1 - proximity * 0.42, 0.58, 1),
    };
}

// 5.8 — the sun's noon elevation by season (northern hemisphere, M9): the
// rainbow needs the sun below 42 degrees.
const SUN_NOON_ELEVATION_DEG = Object.freeze({ winter: 26, spring: 48, summer: 62, autumn: 40 });

// 0.10 — a storm's cover hides the sun entirely (no pale disc showing
// through a thunderhead); other weather thins it by its occlusion.
function buildSun(minute, phase, phaseProgress, weather, phases = PHASES, seasonToken = '') {
    const progress = progressInInterval(minute, phases[0].start, phases[2].end);
    const light = phaseLight(phase, phaseProgress);
    const preset = WEATHER_PRESETS[weather.type] || WEATHER_PRESETS.clear;
    const alpha = weather.type === 'storm'
        ? 0
        : clamp(light * (1 - preset.sunOcclusion * clamp(weather.intensity + 0.16)));
    const yFrac = 0.50 - Math.sin(progress * Math.PI) * 0.38;
    const horizon = celestialHorizonState(yFrac, 0.49);
    return {
        visible: alpha > 0.02,
        alpha: alpha * horizon.horizonFade,
        xFrac: 0.08 + progress * 0.84,
        yFrac,
        elevationDeg: Math.sin(progress * Math.PI) * (SUN_NOON_ELEVATION_DEG[seasonToken] ?? 44),
        ...horizon,
    };
}

function moonPhaseForDate(date) {
    const synodicMonth = 29.530588853;
    const referenceNewMoon = Date.UTC(2000, 0, 6, 18, 14);
    const localNoon = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate(), 12, 0);
    const age = ((localNoon - referenceNewMoon) / 86400000 % synodicMonth + synodicMonth) % synodicMonth;
    const illumination = (1 - Math.cos((age / synodicMonth) * Math.PI * 2)) / 2;
    let phaseName = 'crescent';
    if (illumination < 0.08) phaseName = 'new';
    else if (illumination < 0.34) phaseName = 'crescent';
    else if (illumination < 0.66) phaseName = 'half';
    else phaseName = 'gibbous';
    const waxing = age < synodicMonth / 2;
    return {
        phaseName,
        illumination: clamp(illumination),
        waxing,
        age: Number(age.toFixed(2)),
    };
}

function buildMoon(minute, phase, phaseProgress, weather, date, phases = PHASES) {
    const progress = progressInInterval(minute, phases[3].start, phases[3].end);
    let base = phase === 'night' ? 0.92 : 0;
    if (phase === 'dusk') base = 0.34 * smoothstep(phaseProgress);
    if (phase === 'dawn') base = 0.34 * (1 - smoothstep(phaseProgress));
    const preset = WEATHER_PRESETS[weather.type] || WEATHER_PRESETS.clear;
    const phaseState = moonPhaseForDate(date);
    const moonBodyAlpha = 0.34 + phaseState.illumination * 0.66;
    const alpha = clamp(base * moonBodyAlpha * (1 - preset.sunOcclusion * clamp(weather.intensity)));
    const yFrac = 0.44 - Math.sin(progress * Math.PI) * 0.30;
    const horizon = celestialHorizonState(yFrac, 0.43);
    return {
        visible: alpha > 0.02,
        alpha: alpha * horizon.horizonFade,
        xFrac: 0.08 + progress * 0.84,
        yFrac,
        ...horizon,
        phase: phaseState,
    };
}

function parseRgbaString(value) {
    const match = String(value || '').match(/rgba?\(([^)]+)\)/i);
    if (!match) return null;
    const parts = match[1].split(',').map(part => Number(part.trim()));
    if (parts.length < 3) return null;
    return {
        r: clamp(parts[0] ?? 255, 0, 255),
        g: clamp(parts[1] ?? 255, 0, 255),
        b: clamp(parts[2] ?? 255, 0, 255),
        a: Number.isFinite(parts[3]) ? clamp(parts[3]) : 1,
    };
}

/**
 * #3 — Grade authority. Lerp a `#rrggbb` overlay color toward the active
 * `grade.worldTint` so halos, tethers, and harbor glows pick up the
 * time-of-day cast (golden dusk, cool night) instead of floating day-cold
 * above the scene. The tint's own alpha is the lerp strength, scaled by
 * `strength` for callers that want a gentler pull. Returns a `#rrggbb` hex;
 * non-hex inputs are returned unchanged so callers can pass through. This is a
 * pure color transform with no time component — identical under reduced motion.
 */
export function gradeColor(hex, grade, strength = 1) {
    const text = String(hex || '');
    if (!/^#[0-9a-f]{6}$/i.test(text)) return text;
    const tint = parseRgbaString(grade?.worldTint);
    if (!tint) return text;
    const weight = clamp(tint.a * clamp(strength, 0, 2), 0, 1);
    if (weight <= 0) return text;
    const blended = blendRgb(hexToRgb(text), { r: tint.r, g: tint.g, b: tint.b }, weight);
    return rgbToHex(blended);
}

function buildGrade(phase, phaseProgress, weather) {
    const light = phaseLight(phase, phaseProgress);
    const dark = 1 - light;
    const weatherWeight = weather.type === 'rain' || weather.type === 'overcast' || weather.type === 'storm'
        ? weather.intensity * 0.24
        : weather.type === 'fog'
            ? weather.intensity * 0.16
            : 0;

    const baseTint = phase === 'night'
        ? 'rgba(50, 92, 140, 0.22)'
        : phase === 'dawn'
            ? 'rgba(140, 175, 210, 0.10)'
            : phase === 'dusk'
                ? 'rgba(130, 116, 160, 0.13)'
                : 'rgba(160, 215, 245, 0.05)';
    // #29 — under rain/storm the world tint agrees with the bruised sky, pulled
    // toward the storm cast by how much of the sky the storm covers.
    const storm = stormPaletteShift(weather);
    const worldTint = storm > 0 ? lerpRgbaString(baseTint, STORM_WORLD_TINT, storm) : baseTint;

    return {
        overlayAlpha: clamp(dark * 0.30 + weatherWeight, 0, 0.46),
        vignetteAlpha: clamp(dark * 0.34 + weatherWeight * 0.6, 0.04, 0.52),
        worldTint,
        horizonWash: clamp((phase === 'day' ? 0.10 : 0.18) + weatherWeight, 0, 0.28),
        buildingGlowScale: clamp(0.55 + dark * 0.85 + weatherWeight, 0.45, 1.5),
    };
}

// 3.1 — the dusk exposure contract. One source-energy envelope is shared by
// every consumer of motivated light: the emissive core (authored emission),
// the near receiver (admitted local lights and their wet reflections), and the
// broad bloom halo. Before this table each of those read its own continuous
// boost (`lightBoost`, `emissivePhase`, `beaconIntensity`, `buildingGlowScale`)
// and the products stacked, so dusk brightened four times over and the
// Lighthouse/Harbor halos outgrew the work they were lighting.
//
// The envelope is a small set of reviewed buckets, never a continuous product:
// energy is allocated cores first, then spill/reflection, and bloom last
// (`core >= bloom` in every bucket). `halo` caps halo *area* together with the
// absolute cap in `BuildingSprite`; brightness never grows with a crowd count.
// Action-needed overlays are outside this budget: the renderer applies `spill`
// per admitted light and skips attention sources.
export const SOURCE_ENERGY_BUCKETS = Object.freeze({
    // Authored emitters stay identifiable in daylight without floodlighting.
    daylight: Object.freeze({ bucket: 'daylight', core: 0.14, spill: 0.06, bloom: 0.12, halo: 0.72 }),
    // The sky is going but the working windows have not taken over yet.
    settling: Object.freeze({ bucket: 'settling', core: 0.46, spill: 0.42, bloom: 0.22, halo: 0.84 }),
    // The night window gate is opening: cores read first, spill follows.
    lamplight: Object.freeze({ bucket: 'lamplight', core: 0.90, spill: 0.92, bloom: 0.34, halo: 0.96 }),
    // Full night: cores and near receivers at full energy, halo still small.
    'deep-night': Object.freeze({ bucket: 'deep-night', core: 1, spill: 1.15, bloom: 0.42, halo: 1 }),
});

// Feeds and fixtures authored before the envelope keep today's response.
export const NEUTRAL_SOURCE_ENERGY = Object.freeze({
    bucket: 'unreviewed', core: 1, spill: 1, bloom: 1, halo: 1,
});

const OVERCAST_WEATHER_TYPES = new Set(['rain', 'storm', 'overcast']);
const SOURCE_ENERGY_ORDER = ['daylight', 'settling', 'lamplight', 'deep-night'];

/**
 * Pick one reviewed exposure bucket. `nightWindowGate`'s dusk shoulder stays
 * the authority on *when* working windows light up; this only decides how much
 * energy each consumer may spend once they do. The bucket is keyed to the same
 * minutes as the C2 grade keys (`lampCourseAt`): at dusk the ambient falls
 * first and the lamps take over second. Heavy weather promotes the bucket by
 * exactly one step (never past `lamplight`) because the sky really is that
 * much darker — it is a step, not another multiplier.
 */
export function sourceEnergyEnvelope(minuteOfDay, weather = null, seasonShift = null) {
    let index = lampCourseAt(minuteOfDay, seasonShift || undefined);
    if (index < 2 && OVERCAST_WEATHER_TYPES.has(weather?.type) && clamp(weather?.intensity) >= 0.5) {
        index += 1;
    }
    return SOURCE_ENERGY_BUCKETS[SOURCE_ENERGY_ORDER[index]];
}

export function seasonShiftFor(seasonToken) {
    const offsets = SEASONAL_DAY_LENGTH_OFFSETS[seasonToken];
    return offsets
        ? { sunriseShift: offsets.sunrise, sunsetShift: offsets.sunset }
        : { sunriseShift: 0, sunsetShift: 0 };
}

// C2 — one evaluated grade per distinct (quarter-minute, weather, moon,
// season) state. Snapshots are rebuilt every frame; the grade only changes
// when one of its inputs moves a bucket.
let _lightGradeKey = '';
let _lightGrade = null;

function lightGradeFor(minute, weather, moonFill, seasonToken) {
    const key = [
        Math.round(minute * 4),
        weather.type,
        Math.round(clamp(weather.intensity ?? 0) * 20),
        Math.round(clamp(weather.cloudCover ?? 0) * 20),
        Math.round(clamp(weather.fog ?? 0) * 20),
        Math.round(moonFill * 20),
        seasonToken,
    ].join('|');
    if (_lightGrade && key === _lightGradeKey) return _lightGrade;
    _lightGradeKey = key;
    _lightGrade = Object.freeze({
        ...evaluateGrade({
            minuteOfDay: minute,
            weather,
            moonFill,
            ...seasonShiftFor(seasonToken),
        }),
        cacheKey: key,
    });
    return _lightGrade;
}

/** The envelope a lighting state carries, or today's neutral response. */
export function sourceEnergyFor(lighting) {
    const energy = lighting?.sourceEnergy;
    return energy && Number.isFinite(Number(energy.core)) ? energy : NEUTRAL_SOURCE_ENERGY;
}

/**
 * 3.4 — one `moonFill` scalar from the lunar illumination this module already
 * computes, the moon's own visibility alpha, and cloud transmission. Strictly
 * night-only: dusk and dawn shoulders keep their authored grade, and no
 * daylight surface is relit. Consumers turn this into one of three reviewed
 * night ambient courses through the shared grade table.
 */
export function moonFillFor(phase, moon, weather) {
    if (phase !== 'night' || !moon?.visible) return 0;
    const illumination = clamp(moon.phase?.illumination ?? 0);
    const transmission = clamp(1 - clamp(weather?.cloudCover ?? 0) * 0.85);
    return clamp(illumination * clamp(moon.alpha ?? 0) * transmission);
}

function buildLighting(minute, seasonToken, phase, phaseProgress, weather, moon = null) {
    const light = phaseLight(phase, phaseProgress);
    const dark = 1 - light;
    const dawnWarmth = phase === 'dawn' ? 1 - smoothstep(phaseProgress) : 0;
    const duskWarmth = phase === 'dusk' ? smoothstep(phaseProgress) : 0;
    const sunWarmth = clamp(Math.max(dawnWarmth * 0.75, duskWarmth));
    const weatherDim = weather.type === 'rain' || weather.type === 'overcast' || weather.type === 'storm'
        ? weather.intensity * 0.35
        : weather.type === 'fog'
            ? weather.intensity * 0.20
            : 0;
    const solar = solarVectorForMinute(minute, seasonToken);
    const shadowLength = clamp(0.72 + dark * 1.10 + sunWarmth * 0.72 + weatherDim * 0.28, 0.62, 2.35);

    return normalizeLightingState({
        sunDirIso: solar.sunDirIso,
        sunWarmth,
        ambientLight: clamp(light - weatherDim * 0.45),
        ambientTint: phase === 'night'
            ? '86, 139, 180'
            : phase === 'dusk'
                ? '215, 169, 142'
                : phase === 'dawn'
                    ? '234, 185, 159'
                    : '196, 235, 255',
        shadowAngleRad: solar.shadowAngleRad,
        shadowLength,
        shadowAlpha: clamp(0.18 + light * 0.10 + sunWarmth * 0.18 - weatherDim * 0.08, 0.12, 0.42),
        lightWarmth: clamp(0.72 + sunWarmth * 0.32),
        lightBoost: clamp(0.75 + dark * 0.85 + sunWarmth * 0.35 + weatherDim * 0.35, 0.65, 1.8),
        sunBloomScale: clamp(0.85 + sunWarmth * 0.95 - weatherDim * 0.35, 0.65, 1.85),
        beaconIntensity: clamp(dark * 0.9 + sunWarmth * 0.25 + weatherDim * 0.25, 0, 1),
        waterGlintScale: clamp(0.64 + light * 0.28 + sunWarmth * 0.48 - weatherDim * 0.22, 0.32, 1.42),
        sourceEnergy: sourceEnergyEnvelope(minute, weather, seasonShiftFor(seasonToken)),
        moonFill: moonFillFor(phase, moon, weather),
    });
}

export function normalizeLightingState(state = {}) {
    return {
        sunDirIso: state.sunDirIso || { x: -0.96, y: -0.28 },
        sunWarmth: clamp(state.sunWarmth ?? 0),
        ambientLight: clamp(state.ambientLight ?? 1),
        ambientTint: state.ambientTint || '196, 235, 255',
        shadowAngleRad: Number.isFinite(state.shadowAngleRad) ? state.shadowAngleRad : 0.28,
        shadowLength: Number.isFinite(state.shadowLength) ? state.shadowLength : 1,
        shadowAlpha: clamp(state.shadowAlpha ?? 0.22, 0, 1),
        lightWarmth: clamp(state.lightWarmth ?? 1, 0, 2),
        lightBoost: clamp(state.lightBoost ?? 1, 0, 2),
        sunBloomScale: clamp(state.sunBloomScale ?? 1, 0, 2),
        beaconIntensity: clamp(state.beaconIntensity ?? 0, 0, 1),
        waterGlintScale: clamp(state.waterGlintScale ?? 1, 0, 2),
        // Carried verbatim: the envelope is a reviewed bucket object, and a
        // feed authored without one keeps today's neutral response.
        sourceEnergy: state.sourceEnergy && Number.isFinite(Number(state.sourceEnergy.core))
            ? state.sourceEnergy
            : NEUTRAL_SOURCE_ENERGY,
        moonFill: clamp(state.moonFill ?? 0),
    };
}

// #33 / C-W3 — a rising smoke column's signed horizontal drift (world units /
// 16 ms frame), read from the one wind so chimney smoke, mine dust and the
// harbor cookfire lean together with the trees, rain and clouds. With a
// chimney position and the motion-clock time it is `windAt` there (gusts
// included), else the knot wind. Fog's 0.1 barely tilts a column; a storm's
// 1.3 lays it nearly flat. Returns 0 when particle motion is off (the
// snapshot's `motion.particleEnabled === false`) so the reduced-motion static
// wisp never inherits drift.
const SMOKE_WIND_DRIFT_SCALE = 0.5;
const _smokeWind = { x: 0, gust: 0 };
export function smokeWindDrift(atmosphere, worldX = null, worldY = null, tMs = 0) {
    if (!atmosphere?.weather || atmosphere.motion?.particleEnabled === false) return 0;
    const wind = Number.isFinite(worldX) && Number.isFinite(worldY)
        ? windAt(worldX, worldY, tMs, atmosphere.weather, _smokeWind).x
        : baseWindX(atmosphere.weather);
    return wind * SMOKE_WIND_DRIFT_SCALE;
}

function buildReactions(phase, phaseProgress, weather, lighting) {
    const precipitation = clamp(weather.precipitation ?? 0);
    const fog = clamp(weather.fog ?? 0);
    const cloudCover = clamp(weather.cloudCover ?? 0);
    const light = phaseLight(phase, phaseProgress);
    const dark = 1 - light;
    const warmEdge = phase === 'dawn'
        ? 1 - smoothstep(phaseProgress)
        : phase === 'dusk'
            ? smoothstep(phaseProgress)
            : 0;
    const storm = weather.type === 'storm' ? clamp(weather.intensity) : 0;
    const overcast = Math.max(0, cloudCover - 0.62) / 0.38;
    return {
        puddleAlpha: clamp(precipitation * 0.38),
        roofGlintAlpha: clamp((precipitation * 0.18 + warmEdge * 0.16) * (lighting.waterGlintScale ?? 1)),
        waterRippleScale: clamp(0.24 + precipitation * 0.72 + storm * 0.36, 0, 1.35),
        windowWarmth: clamp(dark * 0.82 + warmEdge * 0.22 + overcast * 0.26 + precipitation * 0.22),
        fogNearWaterAlpha: clamp(fog * 0.34 + precipitation * 0.06),
        waterFogAlpha: clamp(fog * 0.30),
        stormRoughness: clamp(storm * 0.9 + precipitation * 0.22),
        warmGlint: clamp(warmEdge * (1 - overcast * 0.52)),
        nightReflection: clamp(dark * 0.58 + (phase === 'night' ? 0.20 : 0)),
        // B3 — midday sun glitter on open water. `light*light` peaks at solar
        // noon and falls off through dawn/dusk to 0 at night; cloud cover and
        // fog dim the sparkle. Mirrors nightReflection so the sea-glitter pass
        // can cross-fade warm-white daytime specks into pale-blue moonlit ones.
        dayGlitter: clamp((light * light) * (1 - overcast * 0.55) * (1 - fog * 0.4)),
        distantContrast: clamp(1 - fog * 0.32 - overcast * 0.12, 0.55, 1),
    };
}

function buildClock(date, minute, phase, phaseProgress) {
    const hours = date.getHours();
    const minutes = date.getMinutes();
    const seconds = date.getSeconds();
    const label = `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
    return {
        date,
        localDate: localDateKey(date),
        hours,
        minutes,
        seconds,
        minuteOfDay: minute,
        label,
        // Aliases of the top-level semantic phase fields. Top-level
        // atmosphere.phase / phaseProgress remain the canonical source; these
        // exist so consumers that already destructure `atmosphere.clock` can
        // read time-of-day without reaching back to the parent snapshot.
        phase,
        phaseProgress,
    };
}

export function createAtmosphereSnapshot({
    now = new Date(),
    motionScale = null,
    weatherOverride = null,
    hourOverride = null,
    seedOverride = null,
    timelineMode = 'auto',
    timelineKnots = null,
} = {}) {
    const effectiveDate = applyHourOverride(normalizeDate(now), hourOverride);
    const minute = minutesSinceMidnight(effectiveDate);
    // 5.4 — season-modulated phase table (day length follows the month→season
    // mapping; equinox months keep the fixed PHASES baseline).
    const seasonToken = seasonTokenForMonth(effectiveDate.getMonth());
    const phases = phasesForSeason(seasonToken);
    const { phase, phaseProgress } = resolvePhase(minute, phases);
    const dayProgress = minute / DAY_MINUTES;
    const weather = resolveWeather(effectiveDate, weatherOverride, { seedOverride, timelineMode, timelineKnots });
    const preset = WEATHER_PRESETS[weather.type] || WEATHER_PRESETS.clear;
    const intensity = clamp(weather.intensity);
    const cloudCover = Number.isFinite(weather.cloudCover) ? weather.cloudCover : preset.cloudCover;
    const transition = phaseTransition(phase, phaseProgress);
    const moon = buildMoon(minute, phase, phaseProgress, weather, effectiveDate, phases);
    const lighting = buildLighting(minute, seasonToken, phase, phaseProgress, weather, moon);
    const timeBucket = Math.floor(dayProgress * 96);
    const lightBucket = Math.round(phaseLight(phase, phaseProgress) * 100);
    const intensityBucket = Math.round(intensity * 10);
    const cloudBucket = Math.round((weather.cloudCover || 0) * 10);
    const precipitationBucket = Math.round((weather.precipitation || 0) * 10);
    const fogBucket = Math.round((weather.fog || 0) * 10);
    const effectiveMotionScale = preferredMotionScale(motionScale);
    const driftEnabled = effectiveMotionScale > 0;
    const lightGrade = lightGradeFor(minute, weather, lighting.moonFill, seasonToken);

    return {
        phase,
        phaseProgress,
        dayProgress,
        transition,
        // 3.4 — `mN` is the reviewed night ambient course: the cached Canvas
        // grade overlay and baked plates must re-bake when the moon changes it.
        cacheKey: `${phase}|${weather.type}|i${intensityBucket}|c${cloudBucket}|p${precipitationBucket}|f${fogBucket}|b${timeBucket}|l${lightBucket}|m${Math.round(lighting.moonFill * 10)}`,
        weather,
        sky: {
            palette: skyPaletteFor(lightGrade),
            assetIds: SKY_ASSETS,
            sun: buildSun(minute, phase, phaseProgress, weather, phases, seasonToken),
            moon,
            starsAlpha: starAlpha(lightGrade, weather),
            cloudCover,
        },
        grade: buildGrade(phase, phaseProgress, weather),
        // C2 — the one world grade (time keys + weather + moon). Every backend
        // grades the island with it; `grade` above stays the overlay-tint
        // contract for marks and tethers.
        lightGrade,
        lighting,
        reactions: buildReactions(phase, phaseProgress, weather, lighting),
        motion: {
            driftEnabled,
            particleEnabled: effectiveMotionScale > 0,
            windX: weather.windX,
        },
        effectiveDate,
        clock: buildClock(new Date(effectiveDate.getTime()), minute, phase, phaseProgress),
    };
}

export class AtmosphereState {
    constructor({ nowProvider = () => new Date() } = {}) {
        this.nowProvider = nowProvider;
        this._ownerToken = Symbol('claude-ville-atmosphere');
        this._hourOverride = null;
        this._weatherOverride = null;
        this._seedOverride = null;
        this._timelineMode = 'auto';
        this._timelineKnots = null;
        this._frozenDate = null;
        this._lastSnapshot = null;
        this._previousHelper = null;
        this._debugHelperInstalled = false;
        this._installDebugHelper();
    }

    update({ now = null, motionScale = null } = {}) {
        const baseNow = now
            ? new Date(now.getTime ? now.getTime() : now)
            : this._frozenDate
                ? new Date(this._frozenDate.getTime())
                : this.nowProvider();
        this._lastSnapshot = createAtmosphereSnapshot({
            now: baseNow,
            motionScale,
            weatherOverride: this._weatherOverride,
            hourOverride: this._hourOverride,
            seedOverride: this._seedOverride,
            timelineMode: this._timelineMode,
            timelineKnots: this._timelineKnots,
        });
        // C-W2 — everything `groundStateAt` needs to integrate the same
        // history the live weather resolves from.
        this._lastSnapshot.timeline = {
            mode: this._timelineMode,
            hourOverride: this._hourOverride,
            frozen: this._frozenDate !== null,
            seedOverride: this._seedOverride,
            knots: this._timelineKnots,
        };
        return this._lastSnapshot;
    }

    setHour(hourNumber) {
        const parsed = Number(hourNumber);
        if (!Number.isFinite(parsed)) return this.snapshot();
        this._hourOverride = parsed;
        return this.snapshot();
    }

    setWeather(typeOrObject, intensity, windX) {
        const source = typeof typeOrObject === 'object' && typeOrObject
            ? typeOrObject
            : { type: typeOrObject, intensity, windX };
        if (!isKnownWeatherTypeInput(source.type)) return this.snapshot();
        const weatherType = normalizeWeatherType(source.type);
        this._weatherOverride = {
            type: weatherType,
            intensity: Number.isFinite(Number(source.intensity)) ? clamp(Number(source.intensity)) : undefined,
            windX: source.windX != null && Number.isFinite(Number(source.windX))
                ? clamp(Number(source.windX), -WIND_MAX, WIND_MAX)
                : undefined,
            seed: source.seed != null && Number.isFinite(Number(source.seed)) ? Number(source.seed) >>> 0 : undefined,
            cloudCover: Number.isFinite(Number(source.cloudCover)) ? clamp(Number(source.cloudCover)) : undefined,
            precipitation: Number.isFinite(Number(source.precipitation)) ? clamp(Number(source.precipitation)) : undefined,
            fog: Number.isFinite(Number(source.fog)) ? clamp(Number(source.fog)) : undefined,
            transitionProgress: Number.isFinite(Number(source.transitionProgress))
                ? clamp(Number(source.transitionProgress))
                : undefined,
            previousType: source.previousType,
            nextType: source.nextType,
        };
        return this.snapshot();
    }

    setSeed(seed) {
        const parsed = Number(seed);
        this._seedOverride = Number.isFinite(parsed) ? parsed >>> 0 : null;
        return this.snapshot();
    }

    setTimelineMode(mode) {
        this._timelineMode = mode === 'fixed' ? 'fixed' : 'auto';
        return this.snapshot();
    }

    // QA debug hook only (see normalizeTimelineKnots): pin one knot list for
    // every date, or `null` to return to the date-hashed timeline.
    setTimelineKnots(knots) {
        this._timelineKnots = normalizeTimelineKnots(knots);
        return this.snapshot();
    }

    freeze() {
        const snapshot = this.snapshot();
        this._frozenDate = new Date(snapshot.effectiveDate.getTime());
        return this.snapshot();
    }

    clear() {
        this._hourOverride = null;
        this._weatherOverride = null;
        this._seedOverride = null;
        this._timelineMode = 'auto';
        this._timelineKnots = null;
        this._frozenDate = null;
        return this.snapshot();
    }

    snapshot() {
        return this.update();
    }

    installDebugHelper() {
        this._installDebugHelper();
    }

    dispose() {
        if (typeof window === 'undefined') return;
        const helper = window.__claudeVilleAtmosphere;
        if (helper?.__ownerToken !== this._ownerToken) {
            this._debugHelperInstalled = false;
            return;
        }
        if (this._previousHelper) {
            window.__claudeVilleAtmosphere = this._previousHelper;
        } else {
            delete window.__claudeVilleAtmosphere;
        }
        this._previousHelper = null;
        this._debugHelperInstalled = false;
    }

    _installDebugHelper() {
        if (typeof window === 'undefined') return;
        if (this._debugHelperInstalled) return;
        if (window.__claudeVilleAtmosphere?.__ownerToken === this._ownerToken) {
            this._debugHelperInstalled = true;
            return;
        }
        this._previousHelper = window.__claudeVilleAtmosphere || null;
        const helper = {
            setHour: (hourNumber) => this.setHour(hourNumber),
            setWeather: (typeOrObject, intensity, windX) => this.setWeather(typeOrObject, intensity, windX),
            setSeed: (seed) => this.setSeed(seed),
            setTimelineMode: (mode) => this.setTimelineMode(mode),
            setTimelineKnots: (knots) => this.setTimelineKnots(knots),
            freeze: () => this.freeze(),
            clear: () => this.clear(),
            snapshot: () => this.snapshot(),
        };
        Object.defineProperty(helper, '__ownerToken', {
            value: this._ownerToken,
            enumerable: false,
            configurable: false,
        });
        window.__claudeVilleAtmosphere = helper;
        this._debugHelperInstalled = true;
    }
}
