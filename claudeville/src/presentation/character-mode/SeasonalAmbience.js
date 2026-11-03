// claudeville/src/presentation/character-mode/SeasonalAmbience.js
//
// Seasonal drift for World mode: the current month (from the atmosphere
// snapshot's local date) picks a season and a drift type, spawned into the
// shared ParticleSystem in WORLD space on the open-air layer, so the drift is
// on the art-pixel grid, pans with the world, and replays above the resident
// WebGL island like chimney smoke.
//
// Drift per season:
//   winter (Dec–Feb): 'snow'       flakes anywhere in view, only while the
//                                  village's own timeline precipitates (M9,
//                                  northern hemisphere): no snow on a dry day
//   spring (Mar–May): 'petal'      pink cherry petals from tree canopies
//   summer (Jun–Aug): 'butterfly'  by day, rising from flower tiles
//   autumn (Sep–Nov): 'leaf'       rust and gold leaves from tree canopies
// Summer nights carry fireflies instead (fauna; WildlifeRenderer's own budget).
//
// 6.7 / W6.1 ambient budget: none below zoom 0.9, at most 3 live below z2
// (the wide shot, the user's resting zoom), 6 at z >= 2, none at night, no petals, butterflies or leaves in
// rain or storm, and none under reduced motion — the season already lives in
// the terrain rebake, so the honest static fallback is nothing (no
// screen-locked specks). The drift reads only the calendar and the weather,
// never agent or event state (V3).
//
// BI-4 — the fallers (leaves, petals, snow) ride the one wind (`Wind.windAt`
// at the spawn point, scaled like the chimney smoke), and petals fall only
// once the blossom is out (`phenologyAt`). A leaf whose fall ends on the
// river's current (`riverCurrentAt`, the renderer's coast field) falls the
// whole way and floats downstream, held flat, fading over its last seconds.
//
// BI-2 — the Turning Year: `phenologyAt(date)` is the woods' weekly calendar
// (PHENOLOGY_STAGES), read by FoliageRenderer (turned and shed crowns) and
// GroundBake (leaf litter, spring petals).

import { windAt } from './Wind.js';

const SPAWNS_PER_SECOND = 2;
const SEASONAL_TAG = 'seasonal-drift';
export const SEASONAL_DRIFT_CAP = 6;
export const SEASONAL_DRIFT_WIDE_CAP = 3;
export const SEASONAL_DRIFT_MIN_ZOOM = 0.9;

/** W6.1 — the live drift cap at a camera zoom: 6 from z2, 3 at the wide shot, 0 below 0.9. */
export function seasonalDriftCap(zoom) {
    const z = Number(zoom) || 0;
    if (z >= 2) return SEASONAL_DRIFT_CAP;
    return z >= SEASONAL_DRIFT_MIN_ZOOM ? SEASONAL_DRIFT_WIDE_CAP : 0;
}
// The weather layer's own precipitation threshold (WeatherRenderer draws
// rain, or snow in winter, above it).
const PRECIPITATING = 0.02;
// BI-4a — a faller's drift per knot of local wind, world px per 16 ms frame
// (AtmosphereState's SMOKE_WIND_DRIFT_SCALE: leaves ride the air the smoke
// shows).
const DRIFT_WIND_SCALE = 0.5;
// BI-4b — a river leaf falls at the leaf preset's fastest rate (world px per
// 16 ms frame), then floats at about half the current course's march
// (16 px/s), so it steps a texel every 125 ms or slower, for 4–6 s.
const RIVER_LEAF_FALL = 0.09;
const RIVER_LEAF_FLOAT = 0.13;
const RIVER_LEAF_FLOAT_FRAMES = [240, 360];

const SEASONS = {
    winter: { type: 'snow', token: 'winter' },
    spring: { type: 'petal', token: 'spring' },
    summer: { type: 'butterfly', token: 'summer' },
    autumn: { type: 'leaf', token: 'autumn' },
};

// BI-2 — the Turning Year: the woods keep the real calendar in weekly stages
// (northern hemisphere, about 45° N). Each row holds from its month (0–11)
// and day until the next row:
//   turned      the autumn turn's share of the crowns, 0 → 1 through
//               September and October (1 = today's peak plans);
//   shed        per deciduous species, the share of crown clumps fallen to
//               the species' authored bare sheet: birches and poplars first,
//               oaks last, from mid-October through November; 1 is the bare
//               sheet. Spring mirrors it as leaf-out from the bare sheet;
//   blossom     the spring blossom is out (sunlit oaks, petal drift and
//               litter);
//   marcescent  young oaks keep a few russet clumps (December);
//   ground      what the terrain bake keys on: the litter's shed shares in
//               autumn, 'bud' for a spring before the blossom, else '' (the
//               season's own ground), so the ground rebakes about ten times
//               a year and the canopy images once a row.
const SPECIES_SHED = (oak, willow, birch, maple, poplar) => Object.freeze({ oak, willow, birch, maple, poplar });
const SHED_NONE = SPECIES_SHED(0, 0, 0, 0, 0);
const SHED_ALL = SPECIES_SHED(1, 1, 1, 1, 1);

function phenologyStage(id, month, day, fields = {}) {
    const season = seasonForMonth(month).token;
    const row = { id, month, day, season, turned: season === 'autumn' ? 1 : 0, shed: SHED_NONE, blossom: false, marcescent: false, ...fields };
    const s = row.shed;
    row.ground = row.season === 'autumn' ? `shed:${s.oak}/${s.willow}/${s.birch}/${s.maple}/${s.poplar}`
        : row.season === 'spring' && !row.blossom ? 'bud' : '';
    return Object.freeze(row);
}

export const PHENOLOGY_STAGES = Object.freeze([
    phenologyStage('winter', 0, 1, { shed: SHED_ALL }),
    phenologyStage('spring-bare', 2, 1, { shed: SHED_ALL }),
    phenologyStage('leaf-out-1', 2, 22, { shed: SPECIES_SHED(1, 0.6, 0.7, 0.85, 0.8) }),
    phenologyStage('leaf-out-2', 3, 5, { shed: SPECIES_SHED(0.8, 0.25, 0.35, 0.5, 0.45), blossom: true }),
    phenologyStage('leaf-out-3', 3, 19, { shed: SPECIES_SHED(0.4, 0, 0, 0.15, 0.1), blossom: true }),
    phenologyStage('spring', 4, 3, { blossom: true }),
    phenologyStage('summer', 5, 1),
    phenologyStage('turning-1', 8, 1, { turned: 0.25 }),
    phenologyStage('turning-2', 8, 15, { turned: 0.5 }),
    phenologyStage('turning-3', 9, 1, { turned: 0.75 }),
    // Peak colour: today's autumn crowns, whole.
    phenologyStage('peak', 9, 13),
    phenologyStage('fall-1', 9, 20, { shed: SPECIES_SHED(0.05, 0.1, 0.25, 0.2, 0.25) }),
    phenologyStage('fall-2', 9, 27, { shed: SPECIES_SHED(0.15, 0.2, 0.45, 0.4, 0.45) }),
    phenologyStage('fall-3', 10, 3, { shed: SPECIES_SHED(0.3, 0.35, 0.7, 0.6, 0.7) }),
    phenologyStage('fall-4', 10, 10, { shed: SPECIES_SHED(0.5, 0.55, 0.85, 0.8, 0.85) }),
    phenologyStage('fall-5', 10, 17, { shed: SPECIES_SHED(0.7, 0.75, 0.95, 0.9, 0.95) }),
    phenologyStage('fall-6', 10, 24, { shed: SPECIES_SHED(0.85, 0.9, 1, 1, 1) }),
    phenologyStage('winter-marcescent', 11, 1, { shed: SHED_ALL, marcescent: true }),
]);
const SUMMER_STAGE = PHENOLOGY_STAGES.find((row) => row.id === 'summer');

function stageForDay(month, day) {
    let stage = PHENOLOGY_STAGES[0];
    for (const row of PHENOLOGY_STAGES) {
        if (row.month > month || (row.month === month && row.day > day)) break;
        stage = row;
    }
    return stage;
}

/**
 * BI-2 — the woods' weekly stage (a PHENOLOGY_STAGES row) for a local Date.
 * A missing or invalid date reads as summer, like the renderer's season.
 */
export function phenologyAt(date) {
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) return SUMMER_STAGE;
    return stageForDay(date.getMonth(), date.getDate());
}

/**
 * The stage for the atmosphere snapshot's local date (summer without one).
 * The renderer asks every frame: a repeat of the last `clock.localDate` is a
 * string compare.
 */
let _lastLocalDate = null;
let _lastStage = SUMMER_STAGE;
export function phenologyForAtmosphere(atmosphere) {
    const localDate = atmosphere?.clock?.localDate;
    if (localDate && localDate === _lastLocalDate) return _lastStage;
    const day = calendarDayOf(atmosphere);
    const stage = day ? stageForDay(day.month, day.day) : SUMMER_STAGE;
    if (localDate) {
        _lastLocalDate = localDate;
        _lastStage = stage;
    }
    return stage;
}

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
        anchorsProvider = null,
        cameraGetter = null,
        motionTimeGetter = null,
        riverCurrentAt = null,
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
        // BI-4 — the MotionClock time the gust field is read at, and the
        // river's downstream direction (unit, world px) at a world point on
        // its current, or null.
        this.motionTimeGetter = typeof motionTimeGetter === 'function'
            ? motionTimeGetter
            : () => 0;
        this.riverCurrentAt = typeof riverCurrentAt === 'function'
            ? riverCurrentAt
            : null;
        this.enabled = true;
        this._spawnAccumulator = 0;
        this._wind = { x: 0, gust: 0 };
    }

    setEnabled(flag) {
        this.enabled = Boolean(flag);
        if (!this.enabled) this._spawnAccumulator = 0;
    }

    update(dt = 16) {
        if (!this.enabled || !this.particleSystem) return;
        const season = this._driftSeason();
        const motionScale = clamp01(Number(this.motionScaleGetter()) || 0);
        if (!season || motionScale === 0) {
            this._spawnAccumulator = 0;
            return;
        }

        const frameDt = Math.max(0, Math.min(120, Number(dt) || 0));
        this._spawnAccumulator += SPAWNS_PER_SECOND * motionScale * (frameDt / 1000);
        while (this._spawnAccumulator >= 1) {
            this._spawnAccumulator -= 1;
            if (this.particleSystem.countTagged(SEASONAL_TAG) >= seasonalDriftCap(this.cameraGetter()?.zoom)) continue;
            this._spawnDriftParticle(season);
        }
    }

    // The season whose drift may fall this frame, or null when the budget
    // says none: wide zoom, night, rain or storm for the fair-weather drifts,
    // a dry minute for winter snow, and a spring before the blossom (BI-2).
    _driftSeason() {
        const camera = this.cameraGetter();
        if (!camera || !(Number(camera.zoom) >= SEASONAL_DRIFT_MIN_ZOOM)) return null;
        const atmosphere = this.atmosphereStateGetter() || null;
        const day = calendarDayOf(atmosphere);
        const season = seasonForMonth(day?.month);
        if (!season) return null;
        if (season.type === 'petal' && !stageForDay(day.month, day.day).blossom) return null;
        const phase = atmosphere?.phase || atmosphere?.clock?.phase || 'day';
        if (phase === 'night') return null;
        const weather = atmosphere?.weather;
        const precipitating = weather?.type === 'rain'
            || weather?.type === 'storm'
            || (Number(weather?.precipitation) || 0) > PRECIPITATING;
        if (season.type === 'snow') return precipitating ? season : null;
        return precipitating ? null : season;
    }

    _spawnDriftParticle(season) {
        const camera = this.cameraGetter();
        const anchor = this._sampleAnchor(season.type);
        const screen = anchor || this._sampleViewport();
        const world = camera.screenToWorld(screen.x, screen.y);
        const x = Math.round(world.x);
        const y = Math.round(world.y);
        // BI-4a — leaves, petals and snow lean downwind with the local wind,
        // gusts included; butterflies fly their own way.
        const windX = season.type === 'butterfly' ? 0
            : windAt(x, y, this.motionTimeGetter(), this.atmosphereStateGetter()?.weather, this._wind).x * DRIFT_WIND_SCALE;
        if (season.type === 'leaf' && anchor?.lift > 0 && this._spawnRiverLeaf(x, y, anchor.lift, windX)) return;
        this.particleSystem.spawn(season.type, x, y, 1, {
            tag: SEASONAL_TAG,
            spread: 2,
            windX,
        });
    }

    // BI-4b — a leaf from a canopy `lift` world px above its tree's ground
    // line, drifting `windX` a frame: when its fall would end on the river's
    // current it falls the whole way (straight, no jitter, so the landing is
    // known at spawn), then floats downstream held flat, fading only on the
    // water. True when it spawned one.
    _spawnRiverLeaf(x, y, lift, windX) {
        if (!this.riverCurrentAt) return false;
        const fall = lift / RIVER_LEAF_FALL;
        const landY = y + lift;
        const current = this.riverCurrentAt(x + windX * fall, landY);
        if (!current) return false;
        const float = RIVER_LEAF_FLOAT_FRAMES[0] + Math.random() * (RIVER_LEAF_FLOAT_FRAMES[1] - RIVER_LEAF_FLOAT_FRAMES[0]);
        this.particleSystem.spawn('leaf', x, y, 1, {
            tag: SEASONAL_TAG,
            spread: 0,
            speed: 0,
            lateral: 0,
            windX,
            driftY: RIVER_LEAF_FALL,
            life: fall + float,
            landY,
            afloat: { x: current.x * RIVER_LEAF_FLOAT, y: current.y * RIVER_LEAF_FLOAT },
            fadeLife: float,
            sortY: landY,
        });
        return true;
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
        // A canopy anchor's `lift`: world px down to its tree's ground line.
        return { x: p.x, y: p.y, lift: Number.isFinite(p.lift) ? p.lift : 0 };
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
    return calendarDayOf(atmosphere)?.month ?? null;
}

// The atmosphere's local calendar day `{ month (0–11), day (1–31) }`, or null.
function calendarDayOf(atmosphere) {
    if (!atmosphere) return null;
    const clock = atmosphere.clock || null;
    const date = clock?.date;
    if (date instanceof Date && !Number.isNaN(date.getTime())) {
        return { month: date.getMonth(), day: date.getDate() };
    }
    const localDate = clock?.localDate || atmosphere?.effectiveDate;
    if (typeof localDate === 'string') {
        const parts = localDate.split('-');
        if (parts.length >= 2) {
            const m = Number(parts[1]);
            const d = Number(parts[2]);
            if (Number.isFinite(m) && m >= 1 && m <= 12) return { month: m - 1, day: Number.isFinite(d) && d >= 1 ? d : 1 };
        }
    }
    if (atmosphere.effectiveDate instanceof Date && !Number.isNaN(atmosphere.effectiveDate.getTime())) {
        return { month: atmosphere.effectiveDate.getMonth(), day: atmosphere.effectiveDate.getDate() };
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
