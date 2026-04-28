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
//
// The semantic phase fields exist at both the top level (canonical) AND nested
// under `clock` (alias). Prefer the top-level fields inside this module's
// renderer consumers; the nested aliases are for downstream tooling (HUDs,
// widgets, debug overlays) that already destructure `atmosphere.clock`.

const DAY_MINUTES = 24 * 60;
const WEATHER_TIMELINE_KNOTS = 6;

const PHASES = [
    { name: 'dawn', start: 5 * 60 + 30, end: 7 * 60 },
    { name: 'day', start: 7 * 60, end: 17 * 60 + 30 },
    { name: 'dusk', start: 17 * 60 + 30, end: 19 * 60 },
    { name: 'night', start: 19 * 60, end: 5 * 60 + 30 },
];

export const WEATHER_TYPES = ['clear', 'partly-cloudy', 'overcast', 'rain', 'fog', 'storm'];
const WEATHER_TYPE_SET = new Set(WEATHER_TYPES);

export const WEATHER_PRESETS = {
    clear: {
        intensity: 0.18,
        cloudAlpha: 0.12,
        cloudDensity: 0.16,
        cloudCover: 0.10,
        precipitation: 0,
        fog: 0,
        starOcclusion: 0,
        sunOcclusion: 0,
    },
    'partly-cloudy': {
        intensity: 0.48,
        cloudAlpha: 0.42,
        cloudDensity: 0.52,
        cloudCover: 0.42,
        precipitation: 0,
        fog: 0.02,
        starOcclusion: 0.28,
        sunOcclusion: 0.12,
    },
    overcast: {
        intensity: 0.68,
        cloudAlpha: 0.70,
        cloudDensity: 0.88,
        cloudCover: 0.86,
        precipitation: 0.04,
        fog: 0.08,
        starOcclusion: 0.94,
        sunOcclusion: 0.58,
    },
    rain: {
        intensity: 0.78,
        cloudAlpha: 0.76,
        cloudDensity: 0.96,
        cloudCover: 0.94,
        precipitation: 0.68,
        fog: 0.14,
        starOcclusion: 0.98,
        sunOcclusion: 0.68,
    },
    fog: {
        intensity: 0.58,
        cloudAlpha: 0.38,
        cloudDensity: 0.62,
        cloudCover: 0.60,
        precipitation: 0,
        fog: 0.78,
        starOcclusion: 0.72,
        sunOcclusion: 0.34,
    },
    storm: {
        intensity: 0.88,
        cloudAlpha: 0.84,
        cloudDensity: 1,
        cloudCover: 1,
        precipitation: 0.92,
        fog: 0.18,
        starOcclusion: 1,
        sunOcclusion: 0.82,
    },
};

const PALETTES = {
    dawn: {
        zenith: '#203c66',
        upperBand: '#537aa4',
        midBand: '#9eb7cf',
        horizon: '#e8b99f',
        horizonGlow: '234, 185, 159',
        starWarm: '#eaf3ff',
        starHot: '#b9d8ff',
    },
    day: {
        zenith: '#236eb8',
        upperBand: '#4aa0dd',
        midBand: '#86cdf0',
        horizon: '#d5f3ff',
        horizonGlow: '196, 235, 255',
        starWarm: '#eaf3ff',
        starHot: '#ffffff',
    },
    dusk: {
        zenith: '#1d325a',
        upperBand: '#566487',
        midBand: '#9b8199',
        horizon: '#d7a98e',
        horizonGlow: '215, 169, 142',
        starWarm: '#dbeaff',
        starHot: '#a9c7ff',
    },
    night: {
        zenith: '#040913',
        upperBand: '#08162d',
        midBand: '#102642',
        horizon: '#1d3f60',
        horizonGlow: '86, 139, 180',
        starWarm: '#c9ddff',
        starHot: '#f2f7ff',
    },
};

const SKY_ASSETS = {
    clear: {
        clouds: ['atmosphere.cloud.wisp.day'],
        moon: 'atmosphere.moon.crescent.cool',
    },
    'partly-cloudy': {
        clouds: ['atmosphere.cloud.cumulus.day', 'atmosphere.cloud.wisp.day'],
        moon: 'atmosphere.moon.crescent.cool',
    },
    overcast: {
        clouds: ['atmosphere.cloud.overcast-bank', 'atmosphere.cloud.cumulus.day'],
        moon: 'atmosphere.moon.crescent.cool',
    },
    rain: {
        clouds: ['atmosphere.cloud.overcast-bank', 'atmosphere.cloud.cumulus.day'],
        moon: 'atmosphere.moon.crescent.cool',
    },
    storm: {
        clouds: ['atmosphere.cloud.overcast-bank', 'atmosphere.cloud.cumulus.day'],
        moon: 'atmosphere.moon.crescent.cool',
    },
    fog: {
        clouds: ['atmosphere.cloud.overcast-bank', 'atmosphere.cloud.wisp.day'],
        moon: 'atmosphere.moon.crescent.cool',
    },
};

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

function localDateKey(date) {
    const yyyy = date.getFullYear();
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    const dd = String(date.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
}

function hashString(value) {
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
        windX: random() < 0.18 ? -1 : 1,
        seed,
    };
}

export function buildWeatherTimeline(date, seedOverride = null) {
    const dateKey = localDateKey(date);
    const seed = Number.isFinite(Number(seedOverride))
        ? Number(seedOverride) >>> 0
        : hashString(`${dateKey}|weather-timeline`);
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

export function resolveWeatherAt(minute, timeline) {
    const knots = timeline?.knots || [];
    if (!knots.length) return normalizeWeatherOverride({ type: 'clear' }, timeline?.seed);

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
    const windX = transitionProgress < 0.5 ? previous.windX : next.windX;

    return {
        type,
        previousType: previous.type,
        nextType: next.type,
        transitionProgress,
        intensity,
        cloudCover,
        precipitation,
        fog,
        windX,
        seed: timeline.seed,
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
    const seed = Number.isFinite(Number(seedOverride))
        ? Number(seedOverride) >>> 0
        : hashString(`${localDateKey(date)}|weather|fixed`);
    const random = seededRandom(seed);
    const roll = random();
    return normalizeWeatherOverride(buildWeatherKnot(weatherTypeFromRoll(roll, minute), minute, random, seed), seed);
}

function resolvePhase(minute) {
    for (const phase of PHASES) {
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

function rgbStringToRgb(value) {
    const parts = String(value || '').split(',').map(part => Number(part.trim()));
    return {
        r: Number.isFinite(parts[0]) ? parts[0] : 255,
        g: Number.isFinite(parts[1]) ? parts[1] : 255,
        b: Number.isFinite(parts[2]) ? parts[2] : 255,
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

function blendPalette(phase, phaseProgress) {
    const transition = phaseTransition(phase, phaseProgress);
    const from = PALETTES[transition.from] || PALETTES[phase] || PALETTES.day;
    const to = PALETTES[transition.to] || PALETTES[phase] || PALETTES.day;
    const weight = transition.weight;
    return {
        zenith: rgbToHex(blendRgb(hexToRgb(from.zenith), hexToRgb(to.zenith), weight)),
        upperBand: rgbToHex(blendRgb(hexToRgb(from.upperBand), hexToRgb(to.upperBand), weight)),
        midBand: rgbToHex(blendRgb(hexToRgb(from.midBand), hexToRgb(to.midBand), weight)),
        horizon: rgbToHex(blendRgb(hexToRgb(from.horizon), hexToRgb(to.horizon), weight)),
        horizonGlow: Object.values(blendRgb(rgbStringToRgb(from.horizonGlow), rgbStringToRgb(to.horizonGlow), weight)).join(', '),
        starWarm: rgbToHex(blendRgb(hexToRgb(from.starWarm), hexToRgb(to.starWarm), weight)),
        starHot: rgbToHex(blendRgb(hexToRgb(from.starHot), hexToRgb(to.starHot), weight)),
    };
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
    const windValue = Number(override?.windX);
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
        windX: Number.isFinite(windValue) ? clamp(windValue, -1.4, 1.4) : 1,
        seed: Number.isFinite(Number(override?.seed))
            ? Number(override.seed) >>> 0
            : Number.isFinite(Number(fallbackSeed))
                ? Number(fallbackSeed) >>> 0
                : hashString(`weather-override|${type}`),
        timelineMode: 'fixed',
    };
}

function resolveWeather(date, override, { seedOverride = null, timelineMode = 'auto' } = {}) {
    if (override) return normalizeWeatherOverride(override, seedOverride);
    if (timelineMode === 'fixed') return deterministicWeather(date, seedOverride);
    return resolveWeatherAt(minutesSinceMidnight(date), buildWeatherTimeline(date, seedOverride));
}

function phaseLight(phase, phaseProgress) {
    if (phase === 'day') return 1;
    if (phase === 'dawn') return smoothstep(phaseProgress);
    if (phase === 'dusk') return 1 - smoothstep(phaseProgress);
    return 0;
}

function starAlpha(phase, phaseProgress, weather) {
    let base = 0;
    if (phase === 'night') base = 0.92;
    else if (phase === 'dawn') base = 0.78 * (1 - smoothstep(phaseProgress));
    else if (phase === 'dusk') base = 0.78 * smoothstep(phaseProgress);
    const preset = WEATHER_PRESETS[weather.type] || WEATHER_PRESETS.clear;
    return clamp(base * (1 - preset.starOcclusion * clamp(weather.intensity + 0.22)));
}

function buildSun(minute, phase, phaseProgress, weather) {
    const progress = progressInInterval(minute, PHASES[0].start, PHASES[2].end);
    const light = phaseLight(phase, phaseProgress);
    const preset = WEATHER_PRESETS[weather.type] || WEATHER_PRESETS.clear;
    const alpha = clamp(light * (1 - preset.sunOcclusion * clamp(weather.intensity + 0.16)));
    return {
        visible: alpha > 0.02,
        alpha,
        xFrac: 0.08 + progress * 0.84,
        yFrac: 0.50 - Math.sin(progress * Math.PI) * 0.38,
    };
}

function buildMoon(minute, phase, phaseProgress, weather) {
    const progress = progressInInterval(minute, PHASES[3].start, PHASES[3].end);
    let base = phase === 'night' ? 0.92 : 0;
    if (phase === 'dusk') base = 0.34 * smoothstep(phaseProgress);
    if (phase === 'dawn') base = 0.34 * (1 - smoothstep(phaseProgress));
    const preset = WEATHER_PRESETS[weather.type] || WEATHER_PRESETS.clear;
    const alpha = clamp(base * (1 - preset.sunOcclusion * clamp(weather.intensity)));
    return {
        visible: alpha > 0.02,
        alpha,
        xFrac: 0.08 + progress * 0.84,
        yFrac: 0.44 - Math.sin(progress * Math.PI) * 0.30,
    };
}

function buildGrade(phase, phaseProgress, weather) {
    const light = phaseLight(phase, phaseProgress);
    const dark = 1 - light;
    const weatherWeight = weather.type === 'rain' || weather.type === 'overcast' || weather.type === 'storm'
        ? weather.intensity * 0.24
        : weather.type === 'fog'
            ? weather.intensity * 0.16
            : 0;

    return {
        overlayAlpha: clamp(dark * 0.30 + weatherWeight, 0, 0.46),
        vignetteAlpha: clamp(dark * 0.34 + weatherWeight * 0.6, 0.04, 0.52),
        worldTint: phase === 'night'
            ? 'rgba(50, 92, 140, 0.22)'
            : phase === 'dawn'
                ? 'rgba(140, 175, 210, 0.10)'
                : phase === 'dusk'
                    ? 'rgba(130, 116, 160, 0.13)'
                    : 'rgba(160, 215, 245, 0.05)',
        horizonWash: clamp((phase === 'day' ? 0.10 : 0.18) + weatherWeight, 0, 0.28),
        buildingGlowScale: clamp(0.55 + dark * 0.85 + weatherWeight, 0.45, 1.5),
    };
}

function buildLighting(phase, phaseProgress, weather) {
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
    const shadowAngleRad = (phase === 'dawn' ? -0.68 : phase === 'dusk' ? 0.72 : 0.28);
    const shadowLength = clamp(0.72 + dark * 1.10 + sunWarmth * 0.72 + weatherDim * 0.28, 0.62, 2.35);

    return normalizeLightingState({
        sunDirIso: {
            x: Math.cos(shadowAngleRad + Math.PI),
            y: Math.sin(shadowAngleRad + Math.PI),
        },
        sunWarmth,
        ambientLight: clamp(light - weatherDim * 0.45),
        ambientTint: phase === 'night'
            ? '86, 139, 180'
            : phase === 'dusk'
                ? '215, 169, 142'
                : phase === 'dawn'
                    ? '234, 185, 159'
                    : '196, 235, 255',
        shadowAngleRad,
        shadowLength,
        shadowAlpha: clamp(0.18 + light * 0.10 + sunWarmth * 0.18 - weatherDim * 0.08, 0.12, 0.42),
        lightWarmth: clamp(0.72 + sunWarmth * 0.32),
        lightBoost: clamp(0.75 + dark * 0.85 + sunWarmth * 0.35 + weatherDim * 0.35, 0.65, 1.8),
        sunBloomScale: clamp(0.85 + sunWarmth * 0.95 - weatherDim * 0.35, 0.65, 1.85),
        beaconIntensity: clamp(dark * 0.9 + sunWarmth * 0.25 + weatherDim * 0.25, 0, 1),
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
} = {}) {
    const effectiveDate = applyHourOverride(normalizeDate(now), hourOverride);
    const minute = minutesSinceMidnight(effectiveDate);
    const { phase, phaseProgress } = resolvePhase(minute);
    const dayProgress = minute / DAY_MINUTES;
    const weather = resolveWeather(effectiveDate, weatherOverride, { seedOverride, timelineMode });
    const preset = WEATHER_PRESETS[weather.type] || WEATHER_PRESETS.clear;
    const intensity = clamp(weather.intensity);
    const cloudCover = Number.isFinite(weather.cloudCover) ? weather.cloudCover : preset.cloudCover;
    const cloudAlpha = clamp(preset.cloudAlpha * (0.54 + intensity * 0.32 + cloudCover * 0.42));
    const cloudDensity = clamp(preset.cloudDensity * (0.58 + intensity * 0.28 + cloudCover * 0.52));
    const transition = phaseTransition(phase, phaseProgress);
    const timeBucket = Math.floor(dayProgress * 96);
    const lightBucket = Math.round(phaseLight(phase, phaseProgress) * 100);
    const intensityBucket = Math.round(intensity * 10);
    const cloudBucket = Math.round((weather.cloudCover || 0) * 10);
    const precipitationBucket = Math.round((weather.precipitation || 0) * 10);
    const fogBucket = Math.round((weather.fog || 0) * 10);
    const effectiveMotionScale = preferredMotionScale(motionScale);
    const driftEnabled = effectiveMotionScale > 0;
    const clockDriftPx = Math.round(dayProgress * 4096) * weather.windX;

    return {
        phase,
        phaseProgress,
        dayProgress,
        transition,
        cacheKey: `${phase}|${weather.type}|i${intensityBucket}|c${cloudBucket}|p${precipitationBucket}|f${fogBucket}|b${timeBucket}|l${lightBucket}`,
        weather,
        sky: {
            palette: blendPalette(phase, phaseProgress),
            assetIds: SKY_ASSETS[weather.type] || SKY_ASSETS.clear,
            sun: buildSun(minute, phase, phaseProgress, weather),
            moon: buildMoon(minute, phase, phaseProgress, weather),
            starsAlpha: starAlpha(phase, phaseProgress, weather),
            cloudAlpha,
            cloudDensity,
            cloudCover,
        },
        grade: buildGrade(phase, phaseProgress, weather),
        lighting: buildLighting(phase, phaseProgress, weather),
        motion: {
            driftEnabled,
            particleEnabled: effectiveMotionScale > 0,
            clockDriftPx,
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
        });
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
            windX: Number.isFinite(Number(source.windX)) ? clamp(Number(source.windX), -1.4, 1.4) : undefined,
            seed: Number.isFinite(Number(source.seed)) ? Number(source.seed) >>> 0 : undefined,
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
