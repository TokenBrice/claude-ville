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
const WEATHER_BLOCK_MINUTES = 3 * 60;

const PHASES = [
    { name: 'dawn', start: 5 * 60 + 30, end: 7 * 60 },
    { name: 'day', start: 7 * 60, end: 17 * 60 + 30 },
    { name: 'dusk', start: 17 * 60 + 30, end: 19 * 60 },
    { name: 'night', start: 19 * 60, end: 5 * 60 + 30 },
];

const WEATHER_TYPES = new Set(['clear', 'partly-cloudy', 'overcast', 'rain', 'fog']);

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

const WEATHER_PRESETS = {
    clear: {
        intensity: 0.18,
        cloudAlpha: 0.12,
        cloudDensity: 0.16,
        starOcclusion: 0,
        sunOcclusion: 0,
    },
    'partly-cloudy': {
        intensity: 0.48,
        cloudAlpha: 0.42,
        cloudDensity: 0.52,
        starOcclusion: 0.28,
        sunOcclusion: 0.12,
    },
    overcast: {
        intensity: 0.68,
        cloudAlpha: 0.70,
        cloudDensity: 0.88,
        starOcclusion: 0.94,
        sunOcclusion: 0.58,
    },
    rain: {
        intensity: 0.78,
        cloudAlpha: 0.76,
        cloudDensity: 0.96,
        starOcclusion: 0.98,
        sunOcclusion: 0.68,
    },
    fog: {
        intensity: 0.58,
        cloudAlpha: 0.38,
        cloudDensity: 0.62,
        starOcclusion: 0.72,
        sunOcclusion: 0.34,
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

function deterministicWeather(date) {
    const minute = minutesSinceMidnight(date);
    const block = Math.floor(minute / WEATHER_BLOCK_MINUTES);
    const random = seededRandom(hashString(`${localDateKey(date)}|weather|${block}`));
    const roll = random();
    let type = 'clear';
    if (roll >= 0.50 && roll < 0.78) type = 'partly-cloudy';
    else if (roll >= 0.78 && roll < 0.90) type = 'overcast';
    else if (roll >= 0.90 && roll < 0.97) type = 'fog';
    else if (roll >= 0.97) type = 'rain';

    const preset = WEATHER_PRESETS[type];
    const jitter = (random() - 0.5) * 0.18;
    return {
        type,
        intensity: clamp(preset.intensity + jitter, 0, 1),
        windX: random() < 0.16 ? -1 : 1,
    };
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

function resolveWeather(date, override) {
    if (!override) return deterministicWeather(date);
    const type = WEATHER_TYPES.has(override.type) ? override.type : 'clear';
    const base = WEATHER_PRESETS[type];
    return {
        type,
        intensity: Number.isFinite(override.intensity)
            ? clamp(override.intensity)
            : base.intensity,
        windX: Number.isFinite(override.windX) && override.windX < 0 ? -1 : 1,
    };
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
    const weatherWeight = weather.type === 'rain' || weather.type === 'overcast'
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
    const weatherDim = weather.type === 'rain' || weather.type === 'overcast'
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
} = {}) {
    const effectiveDate = applyHourOverride(normalizeDate(now), hourOverride);
    const minute = minutesSinceMidnight(effectiveDate);
    const { phase, phaseProgress } = resolvePhase(minute);
    const dayProgress = minute / DAY_MINUTES;
    const weather = resolveWeather(effectiveDate, weatherOverride);
    const preset = WEATHER_PRESETS[weather.type] || WEATHER_PRESETS.clear;
    const intensity = clamp(weather.intensity);
    const cloudAlpha = clamp(preset.cloudAlpha * (0.7 + intensity * 0.6));
    const cloudDensity = clamp(preset.cloudDensity * (0.72 + intensity * 0.5));
    const timeBucket = Math.floor(dayProgress * 96);
    const lightBucket = Math.round(phaseLight(phase, phaseProgress) * 100);
    const intensityBucket = Math.round(intensity * 10);
    const effectiveMotionScale = preferredMotionScale(motionScale);
    const driftEnabled = effectiveMotionScale > 0;
    const clockDriftPx = Math.round(dayProgress * 4096) * weather.windX;

    return {
        phase,
        phaseProgress,
        dayProgress,
        cacheKey: `${phase}|${weather.type}|i${intensityBucket}|b${timeBucket}|l${lightBucket}`,
        weather,
        sky: {
            palette: PALETTES[phase],
            assetIds: SKY_ASSETS[weather.type] || SKY_ASSETS.clear,
            sun: buildSun(minute, phase, phaseProgress, weather),
            moon: buildMoon(minute, phase, phaseProgress, weather),
            starsAlpha: starAlpha(phase, phaseProgress, weather),
            cloudAlpha,
            cloudDensity,
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
        });
        return this._lastSnapshot;
    }

    setHour(hourNumber) {
        const parsed = Number(hourNumber);
        if (!Number.isFinite(parsed)) return this.snapshot();
        this._hourOverride = parsed;
        return this.snapshot();
    }

    setWeather(type, intensity) {
        const weatherType = String(type || '').trim();
        if (!WEATHER_TYPES.has(weatherType)) return this.snapshot();
        this._weatherOverride = {
            type: weatherType,
            intensity: Number.isFinite(Number(intensity)) ? clamp(Number(intensity)) : undefined,
        };
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
            setWeather: (type, intensity) => this.setWeather(type, intensity),
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
