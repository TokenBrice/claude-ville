// claudeville/src/presentation/character-mode/Wind.js
//
// C-W3 — the one wind. Every consumer that leans, drifts or sways (tree lean
// frames, chimney smoke, rain lean, cloud-shadow courses, the sky's icon
// clouds; flags and the sea's cat's paws later) reads it here, so they agree
// in direction and scale with the same weather.
//
// Truth (V3): the wind is a pure function of the village's own weather
// (`atmosphere.weather`, itself a pure function of the local date and minute),
// world position and the one motion clock. It never reads agent, mood or
// director state.
//
// - `weather.windX` is the knot wind: `sign × WIND_SPEED_BY_TYPE[type]`
//   (AtmosphereState builds it; a debug override may pin any value in
//   ±WIND_MAX). Positive blows toward screen right.
// - `windAt()` adds a gust field: world-locked patches that travel downwind,
//   stepped in thirds (never a smooth ramp), scaled by how windy the weather
//   is — still fog has no gusts, a storm gusts hard.
// - Reduced motion: callers pass the MotionClock time, which stops advancing
//   under reduced motion, so the gust field holds one static frame.

export const WIND_MAX = 1.4;

// Knot wind speed by weather type (plan 0.7 (1)).
export const WIND_SPEED_BY_TYPE = Object.freeze({
    fog: 0.1,
    clear: 0.35,
    'partly-cloudy': 0.55,
    overcast: 0.7,
    rain: 0.9,
    storm: 1.3,
});

// A full gust adds this share of the knot wind: `x = windX · (1 + 0.6·gust)`.
export const GUST_GAIN = 0.6;
// Gusts start above a light breeze and reach full strength in a storm.
const GUST_ONSET = 0.15;
const GUST_FULL = 1.3;
// Gust patches: world px per noise cell along / across the wind, and how fast
// the fronts travel downwind (world px/s) at a given knot speed.
const GUST_CELL_ALONG = 176;
const GUST_CELL_ACROSS = 88;
const GUST_TRAVEL_BASE = 20;
const GUST_TRAVEL_PER_WIND = 50;
// Share of the field that is gusting at all, and the ramp into a full gust.
const GUST_THRESHOLD = 0.5;
const GUST_RAMP = 0.26;
const GUST_STEPS = 3;

// Cloud-shadow courses drift at `3 + 7·|windX|` world px/s along the wind and
// a third of that down-screen (plan 0.7 (1)); a storm moves them ~2.2× faster
// than a clear day.
export const CLOUD_DRIFT_BASE = 3;
export const CLOUD_DRIFT_PER_WIND = 7;
// A single long frame (tab return) never teleports the clouds.
const CLOUD_DRIFT_MAX_STEP_S = 1;

function clamp(value, min = 0, max = 1) {
    return value < min ? min : value > max ? max : value;
}

export function windSpeedForType(type) {
    return WIND_SPEED_BY_TYPE[type] ?? WIND_SPEED_BY_TYPE.clear;
}

// Accepts `atmosphere.weather` (or a whole snapshot, for convenience).
function weatherOf(weather) {
    return weather?.weather && typeof weather.weather === 'object' ? weather.weather : weather;
}

/**
 * The knot wind: signed, world-uniform, no gust. `weather.windX` when the
 * weather carries one (every AtmosphereState snapshot does), else the type's
 * speed blowing toward +x.
 */
export function baseWindX(weather) {
    const source = weatherOf(weather);
    const raw = source?.windX;
    if (raw != null && raw !== '' && Number.isFinite(Number(raw))) {
        return clamp(Number(raw), -WIND_MAX, WIND_MAX);
    }
    return windSpeedForType(source?.type);
}

/** 0 (fog, calm) → 1 (storm): how strongly the gust field modulates the wind. */
export function gustinessFor(windX) {
    return clamp((Math.abs(Number(windX) || 0) - GUST_ONSET) / (GUST_FULL - GUST_ONSET));
}

function hash2(ix, iy, salt) {
    let h = Math.imul(ix, 374761393) ^ Math.imul(iy, 668265263) ^ Math.imul(salt, 2246822519);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
}

function valueNoise(x, y, salt) {
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const fx = x - x0;
    const fy = y - y0;
    const sx = fx * fx * (3 - 2 * fx);
    const sy = fy * fy * (3 - 2 * fy);
    const a = hash2(x0, y0, salt);
    const b = hash2(x0 + 1, y0, salt);
    const c = hash2(x0, y0 + 1, salt);
    const d = hash2(x0 + 1, y0 + 1, salt);
    const top = a + (b - a) * sx;
    const bottom = c + (d - c) * sx;
    return top + (bottom - top) * sy;
}

/**
 * The wind at a world point and motion-clock time.
 *
 * @param {number} worldX world px
 * @param {number} worldY world px
 * @param {number} tMs    MotionClock ms (`renderer.motionTimeMs`; frozen under
 *                        reduced motion, which freezes the gusts too)
 * @param {object} weather `atmosphere.weather`
 * @param {{x:number, gust:number}} [out] optional result object to reuse
 * @returns {{x:number, gust:number}} `x`: local signed wind including the gust
 *   (`windX · (1 + GUST_GAIN · gust)`, so |x| ≥ |windX|); `gust`: 0..1 in
 *   stepped thirds of the weather's gustiness (0 in fog).
 */
export function windAt(worldX, worldY, tMs, weather, out = { x: 0, gust: 0 }) {
    const source = weatherOf(weather);
    const base = baseWindX(source);
    const gustiness = gustinessFor(base);
    let gust = 0;
    if (gustiness > 0) {
        const sign = base < 0 ? -1 : 1;
        const seconds = (Number(tMs) || 0) / 1000;
        const travel = (GUST_TRAVEL_BASE + GUST_TRAVEL_PER_WIND * Math.abs(base)) * seconds;
        const salt = (Number(source?.seed) >>> 0) & 1023;
        const along = ((Number(worldX) || 0) - sign * travel) / GUST_CELL_ALONG;
        const across = (Number(worldY) || 0) / GUST_CELL_ACROSS;
        const n = 0.65 * valueNoise(along, across, salt)
            + 0.35 * valueNoise(along * 2.1 + 17.3, across * 2.1 + 5.1, salt + 1);
        const raw = clamp((n - GUST_THRESHOLD) / GUST_RAMP);
        gust = (Math.round(raw * GUST_STEPS) / GUST_STEPS) * gustiness;
    }
    out.x = base * (1 + GUST_GAIN * gust);
    out.gust = gust;
    return out;
}

/** World px/s the cloud-shadow courses travel at this knot wind. */
export function cloudDriftSpeed(windX) {
    return CLOUD_DRIFT_BASE + CLOUD_DRIFT_PER_WIND * Math.abs(Number(windX) || 0);
}

const _cloudDrift = { t: null, x: 0, y: 0 };

/**
 * The cloud-shadow course offset (world px, unwrapped), integrated over the
 * motion clock so a change of wind speed or sign changes the drift rate
 * without moving the clouds. Both backends read this one integrator, so the
 * resident composite and the Canvas `CloudShadowCourses` agree. Pass
 * `tMs = null` to hold (reduced motion): the offset is returned unchanged.
 */
export function cloudCourseDrift(tMs, weather) {
    const t = tMs == null ? NaN : Number(tMs);
    if (!Number.isFinite(t)) return _cloudDrift;
    if (_cloudDrift.t !== null && t > _cloudDrift.t) {
        const dt = Math.min(CLOUD_DRIFT_MAX_STEP_S, (t - _cloudDrift.t) / 1000);
        const base = baseWindX(weather);
        const speed = cloudDriftSpeed(base);
        _cloudDrift.x += (base < 0 ? -1 : 1) * speed * dt;
        _cloudDrift.y += (speed / 3) * dt;
    }
    _cloudDrift.t = t;
    return _cloudDrift;
}
