// The resident world's per-frame state, resolved once from the frame feed,
// the camera and the ladder level: pure (no GL, no DOM), so every world
// backend uploads the same values (docs/material-channel-contract.md,
// "Frame state"). A resolver that runs every frame fills a caller-owned
// scratch (`out` / `state`) instead of allocating; the scratch factories
// below build one per backend.
import {
    aerialPerspectiveStrength,
    binGpuLights,
    buildCloudShadowTile,
    clampGpuLights,
    CLOUD_FIELD_PERIOD,
    CLOUD_TILE_SIZE,
    cloudCoveredShare,
    createLightBinScratch,
    effectBudgetMode,
    gpuLightColorForShader,
    isAttentionLight,
    LIGHT_RECORD_FLAGS,
    LIGHT_RECORD_ROWS,
    LIGHT_ROLE_CODES,
    lightLaysColumn,
    localLightPhaseForLighting,
    MAX_LIGHT_RECORDS,
    sortedCloudField,
} from './GpuWorldPolicy.js';
import { NEUTRAL_GRADE } from '../GradeEvaluator.js';
import { ART_RAMPS } from '../../../config/artPalette.js';
import { POST_FX_LEVELS } from '../postfx/PostFxLadder.js';
import { sourceEnergyFor } from '../AtmosphereState.js';
import { baseWindX, cloudCourseDrift, gustinessFor, windAt } from '../Wind.js';

// Local lights (and the occluder companions) come up past this phase.
export const LOCAL_LIGHT_VISIBILITY_FLOOR = 0.04;
// 2.2 — the footprint march step count per ladder mode (the Canvas column
// march in CanvasWaterState reads it too).
export const FOOTPRINT_MARCH_STEPS = Object.freeze({ on: 8, 'four-steps': 4, off: 0 });
// 3.2 — the pale day path (kind 2) grows NOON_GLINT_GROW_GAIN x faster down
// the frame than the gold and silver paths.
export const NOON_GLINT_GROW_GAIN = 2.5;
// 2.7 — the Lighthouse fan's half-width at the lamp's foot (ground px); the
// rest of its shape, sweep and sheen step come from lighthouseBeam.
export const BEAM_NEAR_HALF_WIDTH = 6;
// 3.5 — the authored ramp table: 11 material classes x 3 courses.
export const PALETTE_LUT_WIDTH = 11;
export const PALETTE_LUT_HEIGHT = 3;
// 3.4 — the open sea's C-W3 gust field (R8, SEA_GUST_SIZE^2 over the view),
// refreshed on SEA_GUST_STEP_MS steps of the motion clock (an 8 Hz band).
export const SEA_GUST_SIZE = 128;
const SEA_GUST_STEP_MS = 125;

const LIGHT_ROLE_POINT = LIGHT_ROLE_CODES.point;
const LIGHT_ROLE_ATTENTION = LIGHT_ROLE_CODES.attention;
const DEFAULT_LIGHT_COLOR = Object.freeze([1, 0.78, 0.42]);
const NO_LIGHTS = Object.freeze([]);

// 3.2 — the C1 `seaPath` ramp as (hi, lo) pairs per glint kind, 0..1:
// 1 gold (sunrise / golden hour), 2 pale (day), 3 silver (moon).
function seaPathPair(lo, hi) {
    return [hi, lo].flatMap(hex => [1, 3, 5].map(at => parseInt(hex.slice(at, at + 2), 16) / 255));
}
const SEA_PATH_STOPS = Object.freeze({
    1: Object.freeze(seaPathPair(ART_RAMPS.seaPath[0], ART_RAMPS.seaPath[1])),
    2: Object.freeze(seaPathPair(ART_RAMPS.seaPath[2], ART_RAMPS.seaPath[3])),
    3: Object.freeze(seaPathPair(ART_RAMPS.seaPath[4], ART_RAMPS.seaPath[5])),
});

function finite(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

// `#rrggbb` → [r, g, b] in 0..1, or `fallback` for anything else.
function hexRgb01(hex, fallback) {
    const text = String(hex || '');
    if (!/^#[0-9a-f]{6}$/i.test(text)) return fallback;
    return [1, 3, 5].map(index => parseInt(text.slice(index, index + 2), 16) / 255);
}

// The baked tile plus the combined field's sorted values (3.4: two octaves
// of the tile, CLOUD_SECOND_OCTAVE), so a cover fraction maps to an exact
// noise threshold (the covered share of the ground equals the cover).
let _cloudTile = null;
export function cloudTile() {
    if (_cloudTile) return _cloudTile;
    const data = buildCloudShadowTile(CLOUD_TILE_SIZE);
    _cloudTile = { data, sorted: sortedCloudField(data, CLOUD_TILE_SIZE) };
    return _cloudTile;
}

function cloudThreshold(coveredShare) {
    const { sorted } = cloudTile();
    const index = Math.round(clamp(1 - coveredShare, 0, 1) * (sorted.length - 1));
    return sorted[index];
}

/** The frame's light grade (C2), or the neutral grade. */
export function resolveFrameGrade(feed = {}) {
    return feed.atmosphere?.lightGrade || feed.lightGrade || NEUTRAL_GRADE;
}

/**
 * `u_weather`: (rain, fog, storm, intensity), sheared by the ladder's
 * `weather-amplitude` (REDUCED x0.72 rain and intensity, MINIMAL no rain,
 * storm or intensity). A fresh array per call.
 */
export function resolveWeatherUniform(feed = {}, level = POST_FX_LEVELS.FULL) {
    const weather = feed.weather || feed.atmosphere?.weather || {};
    const type = String(weather.type || 'clear');
    const rainy = type === 'rain' || type === 'storm' || type === 'overcast';
    const uniform = [
        rainy ? clamp(finite(weather.precipitation, weather.intensity), 0, 1) : 0,
        clamp(finite(weather.fog, type === 'storm' ? 0.35 : 0), 0, 1),
        type === 'storm' ? 1 : 0,
        clamp(finite(weather.intensity), 0, 1),
    ];
    const mode = effectBudgetMode('weather-amplitude', level);
    if (mode === 'reduced') {
        uniform[0] *= 0.72;
        uniform[3] *= 0.72;
    } else if (mode === 'off') {
        uniform[0] = 0;
        uniform[2] = 0;
        uniform[3] = 0;
    }
    return uniform;
}

/**
 * 2.2 — the occluder companions (2.3's surface code, fog elevation) upload
 * whenever the local-light phase is up, at every ladder level (MINIMAL still
 * ships its lights), or while fog reads their height; never on a clear day.
 */
export function resolveOccluderChannel(feed = {}) {
    return localLightPhaseForLighting(feed.lighting) > LOCAL_LIGHT_VISIBILITY_FLOOR
        || resolveWeatherUniform(feed)[1] !== 0;
}

/**
 * 4.6 (PT-5) — the world layer's camera: Camera.renderOffsetGpuX/Y (the
 * unrounded offset on a flight frame at k >= 2, else the rounded one), in
 * world px, and the backing scale (backing px = (world + xy) x scale).
 * `xy` stays in doubles: CPU consumers (2.4's light tiles) bin on it.
 */
export function resolveCamera(camera, scale = 1, out = { xy: [0, 0], scale: 0 }) {
    const dpr = Math.max(0.25, finite(camera?._dpr?.(), 1));
    const zoom = Math.max(0.01, finite(camera?.zoom, 1));
    const roundedX = Math.round(finite(camera?.x) * zoom * dpr) / dpr;
    const roundedY = Math.round(finite(camera?.y) * zoom * dpr) / dpr;
    out.xy[0] = finite(camera?.renderOffsetGpuX, finite(camera?.renderOffsetX, roundedX)) / zoom;
    out.xy[1] = finite(camera?.renderOffsetGpuY, finite(camera?.renderOffsetY, roundedY)) / zoom;
    out.scale = zoom * dpr * scale;
    return out;
}

/**
 * 4.6 (PT-2) — a flight frame samples fat pixels: exactly when the backing
 * scale k = zoom × dpr or the camera offset (in backing px) is fractional.
 * A boolean `override` forces the gate (the byte-identity A/B).
 */
export function resolveFatPixels(camera, override = null) {
    if (typeof override === 'boolean') return override;
    const dpr = Math.max(0.25, finite(camera?._dpr?.(), 1));
    const zoom = Math.max(0.01, finite(camera?.zoom, 1));
    const fractional = (value) => Math.abs(value - Math.round(value)) > 1e-4;
    const offsetX = finite(camera?.renderOffsetGpuX, finite(camera?.renderOffsetX, 0)) * dpr;
    const offsetY = finite(camera?.renderOffsetGpuY, finite(camera?.renderOffsetY, 0)) * dpr;
    return fractional(zoom * dpr) || fractional(offsetX) || fractional(offsetY);
}

export function createWaterFx() {
    return { fx: new Float32Array(4), glint: new Float32Array(4), stops: new Float32Array(6) };
}

/**
 * 3.1 / 3.2 / 3.6 / 3.9 / 3.10 — the water state from the clock, the
 * village's own weather and sky, and the ladder (EFFECT_BUDGET `waterCrests`,
 * `glitterPath`, `rainRings`, `coastSwash`, `shallowCaustics`):
 * `fx` = (water clock, rain rings, caustics, swash), `glint` = (screen x in
 * backing px of a `width`-wide frame, strength, kind 0 off / 1 gold / 2 pale
 * / 3 silver, grow), `stops` = the kind's two seaPath stops (hi, lo). The
 * scene pass and the composite's open sea read the same values.
 */
export function resolveWaterFx(feed, camera, level, grade, moonFill, width, out = createWaterFx()) {
    const { fx, glint, stops } = out;
    const motion = feed.reducedMotion ? 0 : clamp(finite(feed.motionScale, 1), 0, 2);
    // One water clock: every cycle freezes on its static frame under
    // reduced motion and at MINIMAL.
    fx[0] = effectBudgetMode('waterCrests', level) === 'on' ? motion : 0;
    const weather = feed.weather || feed.atmosphere?.weather || {};
    const type = String(weather.type || 'clear');
    const raining = type === 'rain' || type === 'storm';
    fx[1] = raining && effectBudgetMode('rainRings', level) !== 'off'
        ? clamp(finite(weather.precipitation, weather.intensity), 0, 1)
        : 0;
    const cloudCover = clamp(finite(weather.cloudCover, 0), 0, 1);
    const zoom = finite(camera?.zoom, 1);
    fx[2] = effectBudgetMode('shallowCaustics', level) === 'on'
        && !raining
        && finite(grade.sunBand, 0) > 0.3
        && cloudCover < 0.5
        && finite(grade.night, 0) < 0.5
        && zoom >= 2
        ? 1 : 0;
    fx[3] = effectBudgetMode('coastSwash', level) === 'on' && motion > 0 ? 1 : 0;
    // 3.2 — the sky body's screen x (the sky spans the canvas), gold near
    // sunrise and golden hour (the grade's rake) at full strength, pale
    // and sparse (0.35) toward noon, silver under a moon at least half
    // full in clear air; none under heavy cloud or when the body is hidden.
    glint.fill(0);
    stops.fill(0);
    if (effectBudgetMode('glitterPath', level) === 'off') return out;
    const sun = feed.atmosphere?.sky?.sun;
    const moon = feed.atmosphere?.sky?.moon;
    let kind = 0;
    let strength = 0;
    let xFrac = 0;
    if (sun?.visible && cloudCover < 0.7) {
        const rake = clamp(finite(grade.rake, 0), 0, 1);
        kind = rake >= 0.4 ? 1 : 2;
        strength = 0.35 + 0.65 * rake;
        xFrac = finite(sun.xFrac, 0.5);
    } else if (moon?.visible && moonFill >= 0.5 && cloudCover < 0.5 && !raining) {
        kind = 3;
        strength = moonFill;
        xFrac = finite(moon.xFrac, 0.5);
    }
    if (!kind) return out;
    const texelPx = Math.max(0.01, zoom * Math.max(0.25, finite(camera?._dpr?.(), 1)));
    glint[0] = xFrac * width;
    glint[1] = strength;
    glint[2] = kind;
    // The pale day path spreads into a broad sparse sparkle under a high sun.
    glint[3] = (kind === 2 ? 0.12 * NOON_GLINT_GROW_GAIN : 0.12) / texelPx;
    stops.set(SEA_PATH_STOPS[kind]);
    return out;
}

export function createAtmosphereCourses() {
    return {
        cloud: new Float32Array(4),
        thresholds: new Float32Array(3),
        haze: new Float32Array(4),
        // 3.4 — noise ceiling of the open sea's sunlit course (0 = off).
        sunlit: 0,
        // Diagnostics: courses drawn (0 or 3) and the aerial haze strength.
        courses: 0,
        aerialHaze: 0,
    };
}

/**
 * 1.4 + 1.6 — the frame's world-locked cloud-shadow courses and screen-Y
 * aerial perspective: `cloud` = (drift x, drift y wrapped to
 * CLOUD_FIELD_PERIOD, darkening per course, 0), `thresholds` = the three
 * courses' noise thresholds (2 = none), `haze` = (fog rgb, strength), and
 * `sunlit` the open sea's sunlit-course ceiling.
 */
export function resolveAtmosphereCourses(level, camera, feed, grade, out = createAtmosphereCourses()) {
    // Cover sets the covered share (`cloudCoveredShare`: none below cover
    // 0.15, so a fair-weather sky casts no blobs; partly cloudy ~38 %);
    // overcast/rain get none (the grade flattens instead) and the night
    // has no sun to cast them. Darkening per course is 8.5 %: three
    // courses reach ~25 % at the thickest core (course 1 ~0.92).
    const cover = clamp(finite(feed.atmosphere?.weather?.cloudCover, 0), 0, 1);
    const cloudMode = effectBudgetMode('cloud-courses', level);
    const cloudStrength = cloudMode === 'off' ? 0 : clamp(finite(grade.cloudShadow, 0), 0, 1);
    const covered = cloudCoveredShare(cover);
    // C-W3 — the one wind: the courses drift at 3 + 7·|windX| world px/s
    // along it (a third of that down-screen), integrated over the motion
    // clock in Wind.js so both backends agree and a wind change never
    // jumps them; frozen under reduced motion.
    const moving = !feed.reducedMotion && finite(feed.motionScale, 1) > 0;
    const drift = cloudCourseDrift(moving ? finite(feed.timeMs, 0) : null, feed.atmosphere?.weather);
    out.courses = cloudStrength > 0.02 && covered > 0 ? 3 : 0;
    if (out.courses) {
        // Wrapped to the combined field's period for float precision.
        const period = CLOUD_FIELD_PERIOD;
        out.cloud[0] = ((-drift.x % period) + period) % period;
        out.cloud[1] = ((-drift.y % period) + period) % period;
        out.cloud[2] = 0.085 * cloudStrength;
        out.thresholds[0] = cloudThreshold(covered);
        out.thresholds[1] = cloudThreshold(covered * 0.55);
        out.thresholds[2] = cloudThreshold(covered * 0.22);
        // 3.4 — sun on water: the sea's clearest share, 0.8 of the
        // covered share (where the field is lowest), takes one stop
        // lighter while the sun band is up; no clouds, no course (the
        // sea keeps its own stops, uniform).
        out.sunlit = clamp(finite(grade.sunBand, 0), 0, 1) > 0.3 ? cloudThreshold(1 - covered * 0.8) : 0;
    } else {
        out.cloud.fill(0);
        out.thresholds.fill(2);
        out.sunlit = 0;
    }

    const hazeMode = effectBudgetMode('aerial-perspective', level);
    const fog = clamp(finite(feed.atmosphere?.weather?.fog, 0), 0, 1);
    const haze = hazeMode === 'off' ? 0 : aerialPerspectiveStrength(finite(camera?.zoom, 1), fog);
    out.aerialHaze = haze;
    const hazeColor = grade.fogColor || [0.6, 0.7, 0.78];
    out.haze[0] = hazeColor[0];
    out.haze[1] = hazeColor[1];
    out.haze[2] = hazeColor[2];
    out.haze[3] = haze;
    return out;
}

export function createSeaGustState() {
    return {
        data: new Uint8Array(SEA_GUST_SIZE * SEA_GUST_SIZE),
        width: SEA_GUST_SIZE,
        height: SEA_GUST_SIZE,
        rect: new Float32Array(4),
        key: '',
        revision: 0,
        wind: { x: 0, gust: 0 },
    };
}

/**
 * 3.4 — C-W3 cat's paws: `Wind.windAt` gusts on a world-locked 128 x 128
 * grid over a `width` x `height` backing-px view (texels 2:1, at least
 * 16 x 8 world px), refreshed on 125 ms steps of the motion clock (frozen
 * under reduced motion) or when the grid moves: `state` ({ data (R8),
 * width, height, rect = (x0, y0, cell x, cell y), revision }), or null in
 * calm air.
 */
export function resolveSeaGustRect(camera, feed, weather, width, height, state = createSeaGustState()) {
    if (gustinessFor(baseWindX(weather)) <= 0) return null;
    const dpr = Math.max(0.25, finite(camera?._dpr?.(), 1));
    const zoom = Math.max(0.01, finite(camera?.zoom, 1));
    const originX = -finite(camera?.renderOffsetX, Math.round(finite(camera?.x) * zoom * dpr) / dpr) / zoom;
    const originY = -finite(camera?.renderOffsetY, Math.round(finite(camera?.y) * zoom * dpr) / dpr) / zoom;
    const viewW = width / (zoom * dpr);
    const viewH = height / (zoom * dpr);
    const cellX = Math.max(16, Math.ceil(viewW / (SEA_GUST_SIZE - 8) / 8) * 8);
    const cellY = Math.max(cellX / 2, Math.ceil(viewH / (SEA_GUST_SIZE - 8) / 4) * 4);
    const x0 = Math.floor(originX / cellX) * cellX - cellX * 4;
    const y0 = Math.floor(originY / cellY) * cellY - cellY * 4;
    const t = Math.floor(finite(feed.timeMs, 0) / SEA_GUST_STEP_MS) * SEA_GUST_STEP_MS;
    const key = `${x0},${y0},${cellX},${cellY},${t},${weather?.windX},${weather?.type},${weather?.seed}`;
    if (key !== state.key) {
        for (let j = 0; j < SEA_GUST_SIZE; j++) {
            const wy = y0 + (j + 0.5) * cellY;
            for (let i = 0; i < SEA_GUST_SIZE; i++) {
                state.data[j * SEA_GUST_SIZE + i] = Math.round(windAt(x0 + (i + 0.5) * cellX, wy, t, weather, state.wind).gust * 255);
            }
        }
        state.key = key;
        state.revision += 1;
        state.rect[0] = x0;
        state.rect[1] = y0;
        state.rect[2] = cellX;
        state.rect[3] = cellY;
    }
    return state;
}

export function createSeaWeather() {
    return { sunlit: 0, gust: null, gustState: createSeaGustState() };
}

/**
 * 3.3 / 3.4 — the frame's sea weather (SEA_WEATHER_GLSL) for both the
 * scene's in-map open water and the composite's open sea: `sunlit` (the
 * atmosphere courses' sunlit ceiling) and `gust` (the gust field, see
 * `resolveSeaGustRect`, or null). `sea-weather` sheds both at MINIMAL.
 */
export function resolveSeaWeather(level, camera, feed, { courses = null, width = 0, height = 0 } = {}, out = createSeaWeather()) {
    const seaWeather = effectBudgetMode('sea-weather', level) === 'on';
    const weather = feed.weather || feed.atmosphere?.weather || null;
    out.sunlit = seaWeather ? finite(courses?.sunlit, 0) : 0;
    out.gust = seaWeather ? resolveSeaGustRect(camera, feed, weather, width, height, out.gustState) : null;
    return out;
}

export function createLightFrameState() {
    const floats = MAX_LIGHT_RECORDS * LIGHT_RECORD_ROWS * 4;
    return {
        // Results.
        records: new Float32Array(floats),
        recordsRevision: 0,
        count: 0,
        tiles: null,
        tilesRevision: 0,
        tilesX: 1,
        tilesY: 1,
        clusters: false,
        admission: {
            cap: 0, admitted: 0, offered: 0, culled: 0, overCap: 0, tileFull: 0, maxPerTile: 0,
            clusters: false, tiles: 0, daylight: true,
        },
        wetReflectionCount: 0,
        marchSteps: 0,
        footprint: null,
        localLightPhase: 0,
        energy: null,
        // Scratch carried frame to frame.
        admissionCache: { source: null, sourceLength: 0, ranked: [], admitted: [], snapshots: [] },
        bins: createLightBinScratch(),
        colorScratch: [0, 0, 0],
        recordsPrev: new Float32Array(floats),
        recordsCount: -1,
        tileIndex: new Uint16Array(0),
    };
}

// 2.4 — the light records and tile index move their revision only on change.
function sameLightRecords(next, prev, count, rowStride, prevCount) {
    if (count !== prevCount) return false;
    for (let row = 0; row < 4; row++) {
        const start = row * rowStride;
        for (let i = start; i < start + count * 4; i++) if (next[i] !== prev[i]) return false;
    }
    return true;
}

function sameTypedArray(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
}

/**
 * 0.1 / 2.2 / 2.4 / 3.2 — light admission for a `width` x `height` backing-px
 * frame seen through `view` (resolveCamera's result for this frame; resolved
 * from `camera` when absent). `clampGpuLights` ranks the feed (attention >
 * aperture > fixture > point), `binGpuLights` admits in that order up to the
 * declared `light-admission` count (FULL 128, REDUCED 64, MINIMAL 24;
 * attention past it) while every 64x64 backing-px tile a light reaches has
 * one of its 16 slots free; daylight admits none. Fills `state`
 * (createLightFrameState) and returns it:
 *   records             RGBA32F, LIGHT_RECORD_ROWS rows x MAX_LIGHT_RECORDS:
 *                       row 0 (foot x, foot y, ground radius, intensity),
 *                       row 1 (height, nx, ng, role), row 2 (rgb, envelope
 *                       share), row 3 (owner slot, landmark id, flags,
 *                       column reach); `recordsRevision` moves on change
 *   count               admitted lights
 *   tiles               the R16UI tile index (tilesX * LIGHT_TILE_STRIDE x
 *                       tilesY) while `clusters`, else null; `tilesRevision`
 *   admission           the diagnostics block (getDiagnostics().lightAdmission)
 *   wetReflectionCount  3.2 — FULL 8, REDUCED 4, MINIMAL or dry 0
 *   footprint, marchSteps  2.2 — the footprint field (null when no light
 *                       is admitted) and this level's march length when it
 *                       carries data
 * `clusterOverride` true / false forces the tiled walk; null follows
 * EFFECT_BUDGET `light-clusters`.
 */
export function resolveLights(feed, camera, level, {
    width = 0,
    height = 0,
    view = null,
    clusterOverride = null,
    state = createLightFrameState(),
} = {}) {
    const wetness = clamp(finite(feed.wetness, 0), 0, 1);
    state.wetReflectionCount = wetness <= 0.01 || level >= POST_FX_LEVELS.MINIMAL
        ? 0
        : level >= POST_FX_LEVELS.REDUCED ? 4 : 8;
    const energy = sourceEnergyFor(feed.lighting);
    state.energy = energy;
    state.localLightPhase = localLightPhaseForLighting(feed.lighting);
    const daylightSuppressesLights = state.localLightPhase <= LOCAL_LIGHT_VISIBILITY_FLOOR;
    const lightLimit = daylightSuppressesLights
        ? 0
        : Math.min(MAX_LIGHT_RECORDS, effectBudgetMode('light-admission', level));
    const ranked = daylightSuppressesLights
        ? NO_LIGHTS
        : clampGpuLights(feed.lights, MAX_LIGHT_RECORDS, MAX_LIGHT_RECORDS, state.admissionCache);
    // The scene pass's own camera (backing px = (world + xy) x scale), so a
    // tile holds exactly the lights that can reach its fragments.
    const frameView = view || resolveCamera(camera);
    const bins = binGpuLights(ranked, {
        cap: lightLimit,
        cameraX: frameView.xy[0],
        cameraY: frameView.xy[1],
        scale: frameView.scale,
        width,
        height,
        wet: state.wetReflectionCount > 0,
    }, state.bins);
    const lights = bins.admitted;
    const clusters = lights.length > 0 && (clusterOverride == null
        ? effectBudgetMode('light-clusters', level) === 'on'
        : Boolean(clusterOverride));
    const admission = state.admission;
    admission.cap = lightLimit;
    admission.admitted = lights.length;
    admission.offered = bins.visible;
    admission.culled = bins.culled;
    admission.overCap = bins.overCap;
    admission.tileFull = bins.tileFull;
    admission.maxPerTile = bins.maxPerTile;
    admission.clusters = clusters;
    admission.tiles = bins.tilesX * bins.tilesY;
    admission.daylight = daylightSuppressesLights;
    // V5 / 2.4 — each admitted light's record: foot, ground radius,
    // intensity; emitter height, face normal, role; colour and envelope
    // share; owner slot, landmark id, flags, column reach. PostFxFeed
    // supplies every light's world geometry.
    const records = state.records;
    const rowStride = MAX_LIGHT_RECORDS * 4;
    let wetSlots = state.wetReflectionCount;
    for (let index = 0; index < lights.length; index++) {
        const light = lights[index];
        const color = gpuLightColorForShader(light, DEFAULT_LIGHT_COLOR, state.colorScratch);
        const offset = index * 4;
        const attention = isAttentionLight(light);
        records[offset] = finite(light.footX);
        records[offset + 1] = finite(light.footY);
        records[offset + 2] = Math.max(1, finite(light.radiusWorld, 64));
        records[offset + 3] = clamp(finite(light.intensity, 1), 0, 3);
        records[rowStride + offset] = Math.max(0, finite(light.height, 0));
        records[rowStride + offset + 1] = finite(light.nx, 0);
        records[rowStride + offset + 2] = finite(light.ng, 0);
        records[rowStride + offset + 3] = attention ? LIGHT_ROLE_ATTENTION : finite(light.role, LIGHT_ROLE_POINT);
        records[2 * rowStride + offset] = color[0];
        records[2 * rowStride + offset + 1] = color[1];
        records[2 * rowStride + offset + 2] = color[2];
        // The spill share of the envelope rides here, so an action-needed
        // overlay light keeps its full read outside the exposure budget.
        records[2 * rowStride + offset + 3] = (light.night
            ? clamp(finite(feed.lighting?.beaconIntensity, 0), 0, 1)
            : 1) * (attention ? 1 : clamp(finite(energy.spill, 1), 0, 2));
        let flags = 0;
        if (!attention && wetSlots > 0) {
            flags |= LIGHT_RECORD_FLAGS.wetReflection;
            wetSlots--;
        }
        if (light.waterOnly === true) flags |= LIGHT_RECORD_FLAGS.waterOnly | LIGHT_RECORD_FLAGS.waterColumn;
        else if (lightLaysColumn(light)) flags |= LIGHT_RECORD_FLAGS.waterColumn;
        records[3 * rowStride + offset] = Math.max(0, Math.round(finite(light.ownerSlot, 0)));
        records[3 * rowStride + offset + 1] = Math.max(0, Math.round(finite(light.landmarkId, 0)));
        records[3 * rowStride + offset + 2] = flags;
        records[3 * rowStride + offset + 3] = Math.max(1, finite(light.columnReach, 1));
    }
    if (!sameLightRecords(records, state.recordsPrev, lights.length, rowStride, state.recordsCount)) {
        state.recordsPrev.set(records);
        state.recordsRevision++;
    }
    state.recordsCount = lights.length;
    state.count = lights.length;
    state.clusters = clusters;
    state.tilesX = bins.tilesX;
    state.tilesY = bins.tilesY;
    if (clusters) {
        const index = bins.index;
        if (state.tileIndex.length !== index.length) {
            state.tileIndex = new Uint16Array(index.length);
            state.tilesRevision++;
            state.tileIndex.set(index);
        } else if (!sameTypedArray(index, state.tileIndex)) {
            state.tileIndex.set(index);
            state.tilesRevision++;
        }
        state.tiles = state.tileIndex;
    } else {
        state.tiles = null;
    }
    // 2.2 — the footprint field and this level's march length (FULL 8,
    // REDUCED 4, MINIMAL 0; 0 in daylight or before a field exists).
    const field = lights.length > 0 ? feed.footprint : null;
    state.footprint = field || null;
    state.marchSteps = field?.data
        ? FOOTPRINT_MARCH_STEPS[effectBudgetMode('footprint-occlusion', level)] ?? 0
        : 0;
    return state;
}

export function createBeamUniforms() {
    return {
        active: false,
        ground: new Float32Array(4),
        shape: new Float32Array(4),
        courseEnds: new Float32Array(3),
        courseShares: new Float32Array(3),
    };
}

/**
 * 2.7 — the Lighthouse fan (LIGHTHOUSE_BEAM_GLSL) the in-map water and the
 * open sea share: `ground` = (foot x, foot y, angle, on), `shape` = (length,
 * near half-width, far half-width, sheen step), the three courses' ends and
 * shares. `active` false (day, dusk settling, dawn, or no Lighthouse)
 * zeroes `ground` and leaves the rest as they were.
 */
export function resolveBeam(feed, out = createBeamUniforms()) {
    const beam = feed.beam || null;
    out.active = Boolean(beam);
    out.ground[0] = finite(beam?.foot?.x, 0);
    out.ground[1] = finite(beam?.foot?.y, 0);
    out.ground[2] = finite(beam?.angle, 0);
    out.ground[3] = beam ? 1 : 0;
    if (!beam) return out;
    out.shape[0] = finite(beam.length, 320);
    out.shape[1] = BEAM_NEAR_HALF_WIDTH;
    out.shape[2] = finite(beam.farWidth, 58) / 2;
    out.shape[3] = finite(beam.sheenStep, 0);
    const courses = beam.courses || [];
    out.courseEnds[0] = finite(courses[0]?.[1], 0.34);
    out.courseEnds[1] = finite(courses[1]?.[1], 0.68);
    out.courseEnds[2] = finite(courses[2]?.[1], 1);
    out.courseShares[0] = finite(courses[0]?.[2], 1);
    out.courseShares[1] = finite(courses[1]?.[2], 0.6);
    out.courseShares[2] = finite(courses[2]?.[2], 0.3);
    return out;
}

export function createPuddleUniforms() {
    return {
        mask: null,
        rect: new Float32Array(4),
        puddles: 0,
        sky: new Float32Array(6),
        ground: false,
        palette: undefined,
    };
}

/**
 * 5.2 — the puddle courses: GroundBake's R8 site `mask` ({ data, cols,
 * rows, x0, y0, revision }, present only while the C-W2 ground history
 * holds puddles), `rect` = (origin x, origin y, cols, rows), the puddle
 * level `puddles` (0 without a mask), and `sky` = the graded sky palette's
 * [upper band, horizon] the water reflects. `ground`: the terrain record
 * takes puddles this frame.
 */
export function resolvePuddles(feed, out = createPuddleUniforms()) {
    const puddles = clamp(finite(feed.puddles, 0), 0, 1);
    const mask = puddles > 0.001 && feed.puddleMask?.data ? feed.puddleMask : null;
    out.mask = mask;
    out.ground = Boolean(mask);
    out.puddles = mask ? puddles : 0;
    if (!mask) return out;
    out.rect[0] = finite(mask.x0, 0);
    out.rect[1] = finite(mask.y0, 0);
    out.rect[2] = mask.cols;
    out.rect[3] = mask.rows;
    const palette = feed.skyPalette;
    if (palette !== out.palette) {
        out.palette = palette;
        out.sky.set([
            ...hexRgb01(palette?.upperBand, [0.62, 0.72, 0.80]),
            ...hexRgb01(palette?.horizon, [0.80, 0.84, 0.86]),
        ]);
    }
    return out;
}

/**
 * 3.5 — the authored ramp table's source (PALETTE_LUT_WIDTH x
 * PALETTE_LUT_HEIGHT), or null when absent, wrong-sized or shed (MINIMAL):
 * the pilot then keeps today's additive response.
 */
export function resolvePaletteLut(level, feed) {
    const source = level >= POST_FX_LEVELS.MINIMAL ? null : feed.paletteLut || null;
    return source
        && source.width === PALETTE_LUT_WIDTH
        && source.height === PALETTE_LUT_HEIGHT
        ? source
        : null;
}
