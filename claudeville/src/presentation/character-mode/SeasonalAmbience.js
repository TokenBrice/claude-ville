// claudeville/src/presentation/character-mode/SeasonalAmbience.js
//
// Seasonal ambient particles for World mode. Maps the current month from the
// atmosphere snapshot's local-date string to a season and feeds drift particles
// into the shared ParticleSystem at a capped rate. Reduced-motion: emits a
// deterministic, static set of placeholder particles once and then idles.
//
// Wiring is intentionally minimal so IsometricRenderer can construct and call
// update(dt) with no other coupling:
//   this.seasonalAmbience = new SeasonalAmbience({
//       particleSystem: this.particleSystem,
//       atmosphereStateGetter: () => this._currentAtmosphereSnapshot,
//       motionScaleGetter: () => this.motionScale,
//       viewportProvider: () => ({ x: ..., y: ..., width: ..., height: ... }),
//   });
//   this.seasonalAmbience.update(dt);
//
// `viewportProvider` is optional. When omitted, spawn coordinates fall back to
// (0, 0) and the consumer is expected to translate the canvas before drawing
// particles. ParticleSystem treats the supplied (x, y) as canvas-space pixels.
//
// Particle types per season:
//   winter (Dec–Feb): 'firefly' (white-leaning proxy for snow)
//   spring (Mar–May): 'leaf'    (proxy for cherry petals; no color override)
//   summer (Jun–Aug): 'firefly'
//   autumn (Sep–Nov): 'leaf'
//
// We pass `type: 'leaf'` / `'firefly'` directly because the current
// ParticleSystem.spawn(type, x, y, count) signature does not accept color or
// other per-spawn overrides. The visual compromise is documented in the
// world-enhancement plan; bumping ParticleSystem.spawn later to take an
// options object would let us tighten the snow / cherry palette.

const SPAWNS_PER_SECOND = 4;
const STATIC_FALLBACK_COUNT = 14;
const FALLBACK_SCATTER_W = 1280;
const FALLBACK_SCATTER_H = 720;

const SEASONS = {
    winter: { type: 'firefly', label: 'snow' },
    spring: { type: 'leaf',    label: 'cherryPetal' },
    summer: { type: 'firefly', label: 'firefly' },
    autumn: { type: 'leaf',    label: 'leaf' },
};

export class SeasonalAmbience {
    constructor({
        particleSystem = null,
        atmosphereStateGetter = null,
        motionScaleGetter = null,
        viewportProvider = null,
    } = {}) {
        this.particleSystem = particleSystem;
        this.atmosphereStateGetter = typeof atmosphereStateGetter === 'function'
            ? atmosphereStateGetter
            : () => null;
        this.motionScaleGetter = typeof motionScaleGetter === 'function'
            ? motionScaleGetter
            : () => 1;
        this.viewportProvider = typeof viewportProvider === 'function'
            ? viewportProvider
            : null;
        this.enabled = true;
        this._spawnAccumulator = 0;
        this._lastSeasonKey = '';
        this._staticFallbackSeeded = false;
        this._staticFallbackSeasonKey = '';
    }

    setEnabled(flag) {
        this.enabled = Boolean(flag);
        if (!this.enabled) {
            this._spawnAccumulator = 0;
            this._staticFallbackSeeded = false;
        }
    }

    update(dt = 16) {
        if (!this.enabled || !this.particleSystem) return;

        const atmosphere = this.atmosphereStateGetter() || null;
        const month = monthFromAtmosphere(atmosphere);
        const season = seasonForMonth(month);
        if (!season) return;

        const seasonKey = `${season.type}|${season.label}`;
        if (seasonKey !== this._lastSeasonKey) {
            this._lastSeasonKey = seasonKey;
            this._staticFallbackSeeded = false;
        }

        const motionScale = clamp01(Number(this.motionScaleGetter()) || 0);

        if (motionScale === 0) {
            this._seedStaticFallback(season, seasonKey);
            return;
        }

        const frameDt = Math.max(0, Math.min(120, Number(dt) || 0));
        const seconds = frameDt / 1000;
        this._spawnAccumulator += SPAWNS_PER_SECOND * motionScale * seconds;

        while (this._spawnAccumulator >= 1) {
            this._spawnAccumulator -= 1;
            this._spawnDriftParticle(season);
        }
    }

    _spawnDriftParticle(season) {
        const { x, y } = this._sampleViewport();
        this.particleSystem.spawn(season.type, x, y, 1);
    }

    _seedStaticFallback(season, seasonKey) {
        if (this._staticFallbackSeeded && this._staticFallbackSeasonKey === seasonKey) return;

        const viewport = this._viewport();
        const width = viewport.width || FALLBACK_SCATTER_W;
        const height = viewport.height || FALLBACK_SCATTER_H;
        const seedBase = hashString(seasonKey);

        for (let i = 0; i < STATIC_FALLBACK_COUNT; i++) {
            const u = random01(seedBase, i * 2 + 1);
            const v = random01(seedBase, i * 2 + 2);
            const px = viewport.x + Math.round(u * width);
            const py = viewport.y + Math.round(v * height);
            this.particleSystem.spawn(season.type, px, py, 1);
        }

        this._staticFallbackSeeded = true;
        this._staticFallbackSeasonKey = seasonKey;
    }

    _sampleViewport() {
        const viewport = this._viewport();
        const u = Math.random();
        const v = Math.random();
        return {
            x: viewport.x + Math.round(u * viewport.width),
            y: viewport.y + Math.round(v * viewport.height),
        };
    }

    _viewport() {
        if (this.viewportProvider) {
            const v = this.viewportProvider();
            if (v && Number.isFinite(v.width) && Number.isFinite(v.height)) {
                return {
                    x: Number.isFinite(v.x) ? v.x : 0,
                    y: Number.isFinite(v.y) ? v.y : 0,
                    width: Math.max(0, v.width),
                    height: Math.max(0, v.height),
                };
            }
        }
        return { x: 0, y: 0, width: FALLBACK_SCATTER_W, height: FALLBACK_SCATTER_H };
    }
}

function monthFromAtmosphere(atmosphere) {
    if (!atmosphere) return null;
    const clock = atmosphere.clock || null;
    const date = clock?.date;
    if (date instanceof Date && !Number.isNaN(date.getTime())) {
        return date.getMonth();
    }
    const localDate = clock?.localDate || atmosphere?.effectiveDate;
    if (typeof localDate === 'string') {
        const parts = localDate.split('-');
        if (parts.length >= 2) {
            const m = Number(parts[1]);
            if (Number.isFinite(m) && m >= 1 && m <= 12) return m - 1;
        }
    }
    if (atmosphere.effectiveDate instanceof Date && !Number.isNaN(atmosphere.effectiveDate.getTime())) {
        return atmosphere.effectiveDate.getMonth();
    }
    return null;
}

function seasonForMonth(monthIndex) {
    if (monthIndex === null || monthIndex === undefined) return null;
    if (monthIndex === 11 || monthIndex === 0 || monthIndex === 1) return SEASONS.winter;
    if (monthIndex >= 2 && monthIndex <= 4) return SEASONS.spring;
    if (monthIndex >= 5 && monthIndex <= 7) return SEASONS.summer;
    if (monthIndex >= 8 && monthIndex <= 10) return SEASONS.autumn;
    return null;
}

function hashString(value) {
    let hash = 2166136261;
    const text = String(value || '');
    for (let i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
}

function random01(seed, salt) {
    let value = (seed + Math.imul(salt + 1, 0x9e3779b1)) >>> 0;
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    return (value >>> 0) / 4294967296;
}

function clamp01(value) {
    if (!Number.isFinite(value)) return 0;
    if (value < 0) return 0;
    if (value > 1) return 1;
    return value;
}
