// claudeville/src/presentation/character-mode/SeasonalAmbience.js
//
// Seasonal drift for World mode: the current month (from the atmosphere
// snapshot's local date) picks a season and a drift type, spawned into the
// shared ParticleSystem in WORLD space on the open-air layer, so the drift is
// on the art-pixel grid, pans with the world, and replays above the resident
// WebGL island like chimney smoke.
//
// Drift per season:
//   winter (Dec–Feb): 'snow'       flurries anywhere in view
//   spring (Mar–May): 'petal'      pink cherry petals from tree canopies
//   summer (Jun–Aug): 'butterfly'  by day, rising from flower tiles
//   autumn (Sep–Nov): 'leaf'       rust and gold leaves from tree canopies
// Summer nights carry fireflies instead (fauna; WildlifeRenderer's own budget).
//
// 6.7 ambient budget: none at z < 2 (the wide shot keeps its silhouette), at
// most 6 live at z >= 2, none at night, none in rain or storm, and none under
// reduced motion — the season already lives in the terrain rebake, so the
// honest static fallback is nothing (no screen-locked specks).

const SPAWNS_PER_SECOND = 2;
const SEASONAL_TAG = 'seasonal-drift';
export const SEASONAL_DRIFT_CAP = 6;
export const SEASONAL_DRIFT_MIN_ZOOM = 2;

const SEASONS = {
    winter: { type: 'snow', token: 'winter' },
    spring: { type: 'petal', token: 'spring' },
    summer: { type: 'butterfly', token: 'summer' },
    autumn: { type: 'leaf', token: 'autumn' },
};

// Season token for the current atmosphere, sharing this module's month→season
// mapping so the renderer's seasonal terrain rebake stays in lockstep with the
// drift particles. Returns 'winter' | 'spring' | 'summer' | 'autumn' or '' when
// the atmosphere carries no usable date.
export function seasonTokenForAtmosphere(atmosphere) {
    const season = seasonForMonth(monthFromAtmosphere(atmosphere));
    return season ? season.token : '';
}

// 5.4 — month index (0–11) → season token, exported so AtmosphereState can
// modulate day length off the same month→season mapping (one source of truth
// for sky clock, seasonal terrain, and drift particles). '' when unknown.
export function seasonTokenForMonth(monthIndex) {
    return seasonForMonth(monthIndex)?.token || '';
}

// 6.7 — month index (0–11) of the atmosphere's local date, or null.
export function monthIndexForAtmosphere(atmosphere) {
    return monthFromAtmosphere(atmosphere);
}

export class SeasonalAmbience {
    constructor({
        particleSystem = null,
        atmosphereStateGetter = null,
        motionScaleGetter = null,
        viewportProvider = null,
        suppressGetter = null,
        anchorsProvider = null,
        cameraGetter = null,
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
        // #39 — when this returns true (a real git event / gull scatter is on
        // screen), decorative drift spawning is suppressed so the ambient layer
        // yields to the live event.
        this.suppressGetter = typeof suppressGetter === 'function'
            ? suppressGetter
            : () => false;
        // C2 — world-anchored drift. Given a kind ('canopy' | 'flower'), returns
        // screen-space candidate points (tree canopies / flower tiles). Petals
        // and leaves fall from canopies, butterflies rise from flowers; snow
        // (and any type with no visible anchor) falls anywhere in view.
        this.anchorsProvider = typeof anchorsProvider === 'function'
            ? anchorsProvider
            : null;
        // The camera maps those screen points (and the viewport) into world
        // space, and its zoom gates the budget.
        this.cameraGetter = typeof cameraGetter === 'function'
            ? cameraGetter
            : () => null;
        this.enabled = true;
        this._spawnAccumulator = 0;
    }

    setEnabled(flag) {
        this.enabled = Boolean(flag);
        if (!this.enabled) this._spawnAccumulator = 0;
    }

    update(dt = 16) {
        if (!this.enabled || !this.particleSystem) return;
        const season = this._driftSeason();
        const motionScale = clamp01(Number(this.motionScaleGetter()) || 0);
        // suppressDuringEvents — a live git reward (the celebratory gull
        // scatter) is on screen; hold off decorative spawns and drain the
        // accumulator so nothing bursts when suppression lifts.
        if (!season || motionScale === 0 || this.suppressGetter()) {
            this._spawnAccumulator = 0;
            return;
        }

        const frameDt = Math.max(0, Math.min(120, Number(dt) || 0));
        this._spawnAccumulator += SPAWNS_PER_SECOND * motionScale * (frameDt / 1000);
        while (this._spawnAccumulator >= 1) {
            this._spawnAccumulator -= 1;
            if (this.particleSystem.countTagged(SEASONAL_TAG) >= SEASONAL_DRIFT_CAP) continue;
            this._spawnDriftParticle(season);
        }
    }

    // The season whose drift may fall this frame, or null when the budget
    // says none: wide zoom, night, rain or storm.
    _driftSeason() {
        const camera = this.cameraGetter();
        if (!camera || !(Number(camera.zoom) >= SEASONAL_DRIFT_MIN_ZOOM)) return null;
        const atmosphere = this.atmosphereStateGetter() || null;
        const season = seasonForMonth(monthFromAtmosphere(atmosphere));
        if (!season) return null;
        const phase = atmosphere?.phase || atmosphere?.clock?.phase || 'day';
        if (phase === 'night') return null;
        const weather = atmosphere?.weather?.type;
        if (weather === 'rain' || weather === 'storm') return null;
        return season;
    }

    _spawnDriftParticle(season) {
        const camera = this.cameraGetter();
        const screen = this._sampleAnchor(season.type) || this._sampleViewport();
        const world = camera.screenToWorld(screen.x, screen.y);
        this.particleSystem.spawn(season.type, Math.round(world.x), Math.round(world.y), 1, {
            tag: SEASONAL_TAG,
            spread: 2,
        });
    }

    // Pick a screen-space anchor for types that read as coming from the
    // scenery: petals/leaves from tree canopies, butterflies from flower tiles.
    // Returns null (→ anywhere in view) for snow or when no anchor of the
    // requested kind is currently visible.
    _sampleAnchor(type) {
        if (!this.anchorsProvider) return null;
        let kind = null;
        if (type === 'leaf' || type === 'petal') kind = 'canopy';
        else if (type === 'butterfly') kind = 'flower';
        else return null;

        let points = null;
        try {
            points = this.anchorsProvider(kind);
        } catch (_err) {
            points = null;
        }
        if (!Array.isArray(points) || points.length === 0) return null;

        const p = points[Math.floor(Math.random() * points.length)];
        if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return null;
        return { x: p.x, y: p.y };
    }

    _sampleViewport() {
        const viewport = this._viewport();
        return {
            x: viewport.x + Math.random() * viewport.width,
            y: viewport.y + Math.random() * viewport.height,
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
        return { x: 0, y: 0, width: 0, height: 0 };
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

function clamp01(value) {
    if (!Number.isFinite(value)) return 0;
    if (value < 0) return 0;
    if (value > 1) return 1;
    return value;
}
