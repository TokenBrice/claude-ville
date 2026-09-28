// claudeville/src/presentation/character-mode/WeatherRenderer.js
//
// Screen-space foreground weather. Intended to run after world sprites and
// particles, before labels and status badges, with the canvas transform reset.
//
// 0.10 — every layer here is on the pixel grammar: stepped courses with 4x4
// ordered-dither seams on the world's art-pixel grid, no gradients and no
// anti-aliased strokes. The weather is the village's own (AtmosphereState's
// timeline); nothing here reads agent, mood or director state (V3).

import { WEATHER_PRESETS, WEATHER_TYPES } from './AtmosphereState.js';
import { TILE_HEIGHT, TILE_WIDTH } from '../../config/constants.js';
import { ornamentPlan, sampleFramePressure } from './MarkGovernor.js';
import { baseWindX, cloudCourseDrift, windAt } from './Wind.js';
import { applyGradeToRgb } from './GradeEvaluator.js';
import { OCEAN_HORIZON_WORLD_Y, RAIN_START_PRECIPITATION } from './CoastBake.js';

export function weatherEmbellishmentAllowed(level = 0) {
    return ornamentPlan({ level, motionScale: 1 }).ambientWeatherEmbellishment !== 'off';
}

export function weatherPassKeepsPrecipitation(level = 0) {
    const moving = ornamentPlan({ level, motionScale: 1 });
    const reduced = ornamentPlan({ level, motionScale: 0 });
    return moving.weather === 'on' && reduced.weather === 'static';
}

// Reduced motion shows one static weather frame, so the governor's level is
// latched per static scene (the weather's type and buckets, the zoom and the
// viewport) instead of read each frame: a level crossing on a busy host would
// otherwise pop the fog banks, the rain density and the ground haze between
// otherwise identical frames. With motion on the live level is returned.
const _staticPressure = { key: null, level: 0 };
export function weatherPressureLevel(atmosphere, reduced, { zoom = 1, width = 0, height = 0 } = {}) {
    const level = sampleFramePressure().level;
    if (!reduced) {
        _staticPressure.key = null;
        return level;
    }
    const weather = atmosphere?.weather || {};
    const bucket = value => Math.round((Number(value) || 0) * 8);
    const key = `${weather.type}|${bucket(weather.intensity)}|${bucket(weather.fog)}|${bucket(weather.precipitation)}|${atmosphere?.phase}|${zoom}|${width}x${height}`;
    if (_staticPressure.key !== key) {
        _staticPressure.key = key;
        _staticPressure.level = level;
    }
    return _staticPressure.level;
}

const CLEAR_TYPES = new Set(['clear', 'partly-cloudy']);
const RAIN_TYPES = new Set(['rain', 'storm']);
const WEATHER_TYPE_SET = new Set(WEATHER_TYPES);

const LOOP_MS = 60000;
const MAX_FRAME_DT = 80;
// 6.7 — rain streak budget at a 1920×1080 view (scaled by area): the grade
// carries the weather's mood, so a legible field of pixel streaks is enough.
const RAIN_REFERENCE_AREA = 1920 * 1080;
const RAIN_STREAKS = 100;
const STORM_STREAKS = 150;
const RAIN_WIDE_STREAKS = 64;
const RAIN_WIDE_ZOOM = 1.5;
const SNOW_AREA_DENSITY = 3200;
const SNOW_MAX_FLAKES = 420;
const SNOW_MIN_FLAKES = 24;

const SPLASH_PRECIP_THRESHOLD = 0.15;
const SPLASH_STAMP_INTERVAL_MS = 120;
const SPLASH_STAMP_MIN_COUNT = 4;
const SPLASH_STAMP_MAX_COUNT = 10;
const SPLASH_FRAME_MS = 90;
// Reduced motion keeps this share of the visible open-ground tiles as static,
// world-anchored splash rings.
const SPLASH_STATIC_SHARE = 0.05;
// 6.7 — a splash is a 7×4 art-pixel crown in three frames (impact, crown,
// ring), anchored bottom-centre on the tile's ground point. `#` light, `+`
// dim rain tone.
const SPLASH_FRAMES = Object.freeze([
    Object.freeze(['.......', '.......', '...#...', '..+++..']),
    Object.freeze(['.#...#.', '.......', '.......', '.+...+.']),
    Object.freeze(['.......', '.......', '.......', '+.....+']),
]);
const RAIN_LIGHT = '#c4d6e2';
const RAIN_DIM = '#96aabb';

const DEFAULT_INTENSITY = {
    overcast: 0.38,
    rain: 0.64,
    fog: 0.58,
    storm: 0.82,
};

// Parallax rain on the art-pixel grid: three depth layers, each a field of
// streaks built from whole art-pixel cells (cell = round(zoom) CSS px) that
// step sideways with the wind. Far streaks are short, dim and dashed; near
// ones long, light and solid. saltOffset keeps each layer's streak positions
// disjoint.
const RAIN_LAYERS = [
    { frac: 0.45, speedMul: 0.72, cells: [5, 7], color: RAIN_DIM, alpha: 0.5, dashed: true, windMul: 0.82, saltOffset: 0 },
    { frac: 0.35, speedMul: 1.0, cells: [6, 8], color: '#aebfcc', alpha: 0.62, dashed: false, windMul: 1.0, saltOffset: 1300 },
    { frac: 0.2, speedMul: 1.4, cells: [8, 11], color: RAIN_LIGHT, alpha: 0.78, dashed: false, windMul: 1.18, saltOffset: 2600 },
];

// 4x4 Bayer in [0, 16).
const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

// 0.10 — the screen washes (overcast darkening, fog lightening) are a
// vertical profile cut into flat courses of WASH_COURSE_ALPHA with ordered
// dither at each seam, cached as a narrow pattern tile on the art-pixel grid.
const WASH_COURSE_ALPHA = 1 / 48;
// Share of a course over which the seam dithers (the rest is flat).
const WASH_SEAM = 0.35;
const WASH_BUCKETS = 32;
// [screen-height fraction, share of the wash alpha] and one flat colour per
// wash: the overcast darkens toward the bottom of the frame, the fog wash
// lifts it (the old gradients' shapes, now in courses).
const OVERCAST_WASH = Object.freeze([[0, 0.70], [0.45, 0.42], [1, 1]]);
const FOG_WASH = Object.freeze([[0, 0], [0.36, 0.28], [1, 1]]);
const OVERCAST_WASH_RGB = Object.freeze([48, 58, 64]);
const FOG_WASH_RGB = Object.freeze([208, 222, 219]);

// 0.10 — fog banks: world-locked courses cut from a tileable value-noise
// field (period FOG_TILE_W × FOG_TILE_H world px at FOG_TEXEL world px per
// texel; octave cells ~5:1 along the iso horizontal, so the courses lie as
// long banks rather than blobs), drifting with the one wind (the cloud-course
// drift, Wind.js). Three flat courses with solid interiors; the ordered
// dither is held to FOG_SEAM_TEXELS either side of each seam (scaled by the
// field's local slope), so a bank reads calm at 1:1, not as checker mottle.
// The banks lie on the ground plane: both backends lay them in the ground
// pass (`groundFogLayer`), under every body, building and tree, so a
// villager standing in fog stays legible; only the screen wash veils them.
const FOG_TEXEL = 2;
const FOG_TILE_W = 1536;
const FOG_TILE_H = 768;
const FOG_COLOR = Object.freeze([224, 231, 229]);
const FOG_COURSE_ALPHA = Object.freeze([0.11, 0.2, 0.31]);
// Two octaves: the small third octave broke the courses into busy cells.
const FOG_OCTAVES = Object.freeze([[3, 8, 0.62], [6, 16, 0.38]]);
const FOG_SEAM_TEXELS = 1;
const FOG_BUCKETS = 8;

// 0.10 — lightning. One schedule on the one motion clock drives the bolt
// here and the flash exposure both backends apply (C4 stepped quanta: a
// peak, four decaying steps, a re-strike at 470 ms). `stage` 1 shows the
// first bolt, 2 the re-strike; 0 is afterglow only.
const STRIKE_CYCLE_MS = 7200;
export const FLASH_STEPS = Object.freeze([
    Object.freeze({ at: 0, scalar: 0.30, stage: 1 }),
    Object.freeze({ at: 83, scalar: 0.18, stage: 1 }),
    Object.freeze({ at: 166, scalar: 0.12, stage: 1 }),
    Object.freeze({ at: 250, scalar: 0.07, stage: 0 }),
    Object.freeze({ at: 333, scalar: 0.035, stage: 0 }),
    Object.freeze({ at: 470, scalar: 0.16, stage: 2 }),
    Object.freeze({ at: 553, scalar: 0.07, stage: 0 }),
    Object.freeze({ at: 636, scalar: 0.035, stage: 0 }),
    Object.freeze({ at: 720, scalar: 0, stage: 0 }),
]);
// The flash is an exposure step: every world and backdrop pixel is multiplied
// by (1 + scalar × gain × tint); the tint is a cool, slightly blue white.
// Gains are capped by 0.10's "peak luma ≤ the old flash" (the HEAD source-over
// diagonal veil, alpha 0.18 × intensity × legibility): a multiply lifts the
// brightest pixels most, and at night those are the lamp pools, so the night
// gain sits below the day one (measured at storm peaks at 5120×1440,
// 2560×1440 and 1512×982 DPR 2, both backends: frame mean and p99 luma stay
// under the old flash's; p99 at DPR 2 is the binding case).
const FLASH_GAIN_DAY = 0.27;
const FLASH_GAIN_NIGHT = 0.18;
const FLASH_TINT = Object.freeze([0.9, 0.97, 1.12]);
const BOLT_CORE = '#f4f8ff';
const BOLT_HALO = '#9fb8ff';
const BOLT_SPLASH = '#dfe9ff';
// Endpoint candidates tried per strike; a bolt that finds no open sea (or
// sky) is not drawn: the flash still lights the frame.
const BOLT_CANDIDATES = 24;
// The water mask is sampled at quarter resolution around each candidate: the
// endpoint and its splash ring must all be open sea.
const BOLT_MASK_STEP = 4;

export class WeatherRenderer {
    constructor({ assets = null } = {}) {
        this.assets = assets;
        this.sceneContext = null;
        this.elapsedMs = 0;
        this._lastSplashStamp = 0;
        this._splashStampSeed = 0;
        this._splashes = [];
        this._lightGrade = null;
        this._washTile = null;
        this._washPattern = null;
        this._washKey = '';
        this._washColors = null;
        this._fogVariants = null;
        this._bolt = null;
        this._allowEmbellishment = true;
    }

    setAssets(assets) {
        this.assets = assets || null;
    }

    // `{ camera, openGroundTiles }` — the camera phases every cell to the
    // world's art-pixel grid and anchors the world-locked layers (fog banks,
    // splashes, the lightning endpoint); `openGroundTiles()` lists the open
    // ground rain may splash on.
    setSceneContext(context) {
        this.sceneContext = context || null;
    }

    // `timeMs`: the MotionClock time (frozen under reduced motion). `strike`:
    // this frame's `stormStrikeAt` result (the same one the flash exposure
    // used). `seaAt(worldX, worldY)`: true on open sea, where a bolt may land.
    drawForeground(ctx, {
        canvas = ctx?.canvas,
        atmosphere = null,
        dt = 16,
        timeMs = 0,
        strike = null,
        seaAt = null,
        profileMark = null,
    } = {}) {
        if (!ctx || !canvas || !canvas.width || !canvas.height) return;

        const weather = normalizeWeather(atmosphere);
        if (!weather) return;
        this._lightGrade = atmosphere?.lightGrade || null;

        const precipitation = clamp(weather.precipitation, 0, 1);
        const fog = clamp(weather.fog, 0, 1);
        const cloudCover = clamp(weather.cloudCover, 0, 1);
        const legibility = weatherLegibilityGate(weather, atmosphere);
        const hasForegroundWeather = weather.intensity > 0
            && (!CLEAR_TYPES.has(weather.type) || precipitation > RAIN_START_PRECIPITATION || fog > 0.04 || cloudCover > 0.72);
        if (!hasForegroundWeather) return;

        const particleEnabled = atmosphere?.motion?.particleEnabled !== false;
        const level = weatherPressureLevel(atmosphere, !particleEnabled, {
            zoom: this.sceneContext?.camera?.zoom,
            width: canvas.width,
            height: canvas.height,
        });
        this._allowEmbellishment = weatherEmbellishmentAllowed(level);
        if (particleEnabled) {
            const frameDt = Math.max(0, Math.min(MAX_FRAME_DT, Number(dt) || 0));
            this.elapsedMs = (this.elapsedMs + frameDt) % LOOP_MS;
        }

        const seed = seedFromAtmosphere(atmosphere, weather);
        const phaseMs = particleEnabled
            ? this.elapsedMs
            : Math.floor(random01(seed, 401) * LOOP_MS);

        ctx.save();
        ctx.globalCompositeOperation = 'source-over';
        const washBudget = Math.min(1, 0.72 + (1 - fog) * 0.18) * legibility.wash;

        const overcastIntensity = weather.type === 'overcast' || cloudCover > 0.72
            ? Math.max(weather.intensity * 0.72, cloudCover * 0.54) * washBudget
            : 0;
        const fogIntensity = fogWashIntensity(weather, legibility);
        // The first rain falls here; the sea's forecast squall (CoastBake
        // openSeaSquall) arrives before this same threshold.
        const rainActive = RAIN_TYPES.has(weather.type) || precipitation > RAIN_START_PRECIPITATION;
        const rainOvercastIntensity = rainActive
            ? Math.min(
                1,
                Math.max(cloudCover, weather.intensity)
                    * (weather.type === 'storm' ? 0.56 : 0.42),
            ) * washBudget
            : 0;
        this._drawWeatherWash(
            ctx,
            canvas,
            overcastIntensity,
            fogIntensity * washBudget,
            rainOvercastIntensity,
        );
        profileMark?.('weather-wash');

        // The fog banks themselves lie on the ground plane, under the bodies
        // (`groundFogLayer`, drawn by the frame's ground pass).

        if (rainActive) {
            const storm = weather.type === 'storm';
            const rainIntensity = Math.max(precipitation, weather.intensity * (storm ? 0.86 : 0.72)) * legibility.rain;
            // Winter (Dec–Feb) precipitation falls as drifting snow; the storm's
            // lightning below still strikes.
            if (isWinterMonth(atmosphere)) {
                this._drawSnow(ctx, canvas, { ...weather, intensity: rainIntensity }, phaseMs, seed, particleEnabled);
            } else {
                this._drawRain(ctx, canvas, { ...weather, intensity: rainIntensity }, phaseMs, seed, particleEnabled, timeMs);
            }
        }
        // Reduced motion: `stormStrikeAt` never strikes, so no bolt and no flash.
        if (strike?.active && strike.stage > 0) this._drawLightningBolt(ctx, canvas, strike, seaAt);
        profileMark?.('weather-precipitation');

        ctx.restore();
    }

    draw(ctx, options = {}) {
        this.drawForeground(ctx, options);
    }

    dispose() {
        this.elapsedMs = 0;
        this._lastSplashStamp = 0;
        this._splashStampSeed = 0;
        this._splashes.length = 0;
        this.sceneContext = null;
        const fogTiles = Object.values(this._fogVariants || {}).map(variant => variant.canvas);
        for (const tile of [this._washTile, ...fogTiles]) {
            if (!tile) continue;
            tile.width = 0;
            tile.height = 0;
        }
        this._washTile = null;
        this._washPattern = null;
        this._washKey = '';
        this._washColors = null;
        this._fogVariants = null;
        this._bolt = null;
    }

    // 0.10 — the overcast darkening and fog lightening washes vary only with
    // screen height. Each is cut into flat courses of WASH_COURSE_ALPHA with a
    // 4x4 ordered dither at the seams, composited once into a 4-cell-wide
    // tile (one texel per art pixel) and laid over the frame as a pattern on
    // the art-pixel grid: one fill, rebaked only when a bucketed intensity,
    // the cell, the height or the grade course changes. No gradient anywhere.
    _drawWeatherWash(ctx, canvas, overcastIntensity, fogIntensity, rainOvercastIntensity = 0) {
        const overcast = washBucket(overcastIntensity);
        const fog = washBucket(fogIntensity);
        const rain = washBucket(rainOvercastIntensity);
        if (!overcast && !fog && !rain) return;
        if (typeof document === 'undefined') return;
        const { cell, ox, oy } = this._artGrid();
        const rows = Math.ceil(canvas.height / cell) + 2;
        const graded = this._gradedWashColors();
        const key = `${rows}|${overcast}|${fog}|${rain}|${graded.key}`;
        if (key !== this._washKey || !this._washPattern) {
            const tile = this._washTile || document.createElement('canvas');
            tile.width = 4;
            tile.height = rows;
            const tctx = tile.getContext('2d');
            const image = tctx.createImageData(4, rows);
            const layers = [];
            if (overcast) layers.push({ stops: OVERCAST_WASH, alpha: (overcast / WASH_BUCKETS) * 0.14, rgb: graded.overcast });
            if (fog) layers.push({ stops: FOG_WASH, alpha: (fog / WASH_BUCKETS) * 0.12, rgb: graded.fog });
            if (rain) layers.push({ stops: OVERCAST_WASH, alpha: (rain / WASH_BUCKETS) * 0.14, rgb: graded.overcast });
            for (let y = 0; y < rows; y++) {
                const t = rows > 1 ? y / (rows - 1) : 1;
                for (let x = 0; x < 4; x++) {
                    const order = BAYER4[(y % 4) * 4 + x] / 16;
                    let r = 0;
                    let g = 0;
                    let b = 0;
                    let a = 0;
                    for (const layer of layers) {
                        // Flat courses; the ordered dither only mixes two
                        // neighbouring courses in a narrow band at each seam.
                        const raw = layer.alpha * washProfile(layer.stops, t);
                        const la = Math.floor(raw / WASH_COURSE_ALPHA + (order - 0.5) * WASH_SEAM + 0.5) * WASH_COURSE_ALPHA;
                        if (la <= 0) continue;
                        // Premultiplied source-over.
                        r = layer.rgb[0] * la + r * (1 - la);
                        g = layer.rgb[1] * la + g * (1 - la);
                        b = layer.rgb[2] * la + b * (1 - la);
                        a = la + a * (1 - la);
                    }
                    if (a <= 0) continue;
                    const offset = (y * 4 + x) * 4;
                    image.data[offset] = Math.round(r / a);
                    image.data[offset + 1] = Math.round(g / a);
                    image.data[offset + 2] = Math.round(b / a);
                    image.data[offset + 3] = Math.round(a * 255);
                }
            }
            tctx.putImageData(image, 0, 0);
            this._washTile = tile;
            this._washPattern = ctx.createPattern(tile, 'repeat-x');
            this._washKey = key;
        }
        const pattern = this._washPattern;
        if (!pattern) return;
        pattern.setTransform?.(new DOMMatrix([cell, 0, 0, cell, ox - cell, oy - cell]));
        ctx.save();
        ctx.imageSmoothingEnabled = false;
        ctx.fillStyle = pattern;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.restore();
    }

    // The overlay is ungraded on both backends, so the wash and fog colours
    // take the C2 grade here (a fog at night is a dim blue-grey, not white).
    _gradedWashColors() {
        const grade = this._lightGrade;
        const key = grade?.cacheKey || 'neutral';
        if (this._washColors?.key === key) return this._washColors;
        const toGraded = rgb => (grade
            ? applyGradeToRgb(rgb.map(channel => channel / 255), grade).map(channel => Math.round(clamp(channel, 0, 1) * 255))
            : rgb.slice());
        this._washColors = {
            key,
            overcast: toGraded(OVERCAST_WASH_RGB),
            fog: toGraded(FOG_WASH_RGB),
        };
        return this._washColors;
    }

    // 0.10 — this frame's fog banks for the ground pass, or null: the baked
    // three-course tile and the world origin of its lattice (period `width` ×
    // `height` world px, `texel` world px per texel), drifting with the
    // cloud-course drift (the one wind; fog blows at 0.1, so the banks barely
    // creep; reduced motion holds them). The frame renderer lays it on the
    // ground below the sea horizon, under every body, building and tree. The
    // tile is FOG_COLOR as-is (both backends grade the world downstream);
    // `graded` bakes it through the C2 grade for the resident path's 2D
    // backdrop (the outer ocean, which nothing grades after it is drawn).
    groundFogLayer({ atmosphere = null, viewport = null, timeMs = null, graded = false } = {}) {
        const weather = normalizeWeather(atmosphere);
        if (!weather || !(weather.intensity > 0) || typeof document === 'undefined') return null;
        const reduced = atmosphere?.motion?.particleEnabled === false;
        const level = weatherPressureLevel(atmosphere, reduced, {
            zoom: this.sceneContext?.camera?.zoom,
            width: viewport?.width,
            height: viewport?.height,
        });
        if (!weatherEmbellishmentAllowed(level)) return null;
        const legibility = weatherLegibilityGate(weather, atmosphere);
        const strength = Math.round(clamp(fogBankIntensity(weather, legibility), 0, 1) * FOG_BUCKETS);
        if (strength <= 0) return null;
        const grade = graded ? atmosphere?.lightGrade || null : null;
        const key = `ground-fog-${strength}${grade ? `-${grade.cacheKey || 'g'}` : ''}`;
        const variants = this._fogVariants ||= {};
        const variant = variants[graded ? 'graded' : 'plain'] ||= {
            canvas: null,
            layer: { canvas: null, key: '', x: 0, y: 0, width: FOG_TILE_W, height: FOG_TILE_H, texel: FOG_TEXEL, top: OCEAN_HORIZON_WORLD_Y },
        };
        if (variant.layer.key !== key || !variant.canvas) {
            const rgb = grade
                ? applyGradeToRgb(FOG_COLOR.map(channel => channel / 255), grade).map(channel => Math.round(clamp(channel, 0, 1) * 255))
                : FOG_COLOR;
            variant.canvas = bakeFogBankTile(variant.canvas, strength / FOG_BUCKETS, rgb);
        }
        const drift = cloudCourseDrift(reduced ? null : timeMs, weather);
        const layer = variant.layer;
        layer.canvas = variant.canvas;
        layer.key = key;
        layer.x = Math.round(drift.x);
        layer.y = Math.round(drift.y);
        return layer;
    }

    _drawRain(ctx, canvas, weather, phaseMs, seed, particleEnabled, timeMs = 0) {
        const intensity = clamp(weather.intensity, 0, 1);
        const storm = weather.type === 'storm';
        const grid = this._artGrid();
        const areaScale = (canvas.width * canvas.height) / RAIN_REFERENCE_AREA;
        let count = Math.round((storm ? STORM_STREAKS : RAIN_STREAKS) * areaScale * (0.45 + intensity * 0.55));
        if (grid.zoom <= RAIN_WIDE_ZOOM) count = Math.min(count, RAIN_WIDE_STREAKS);
        if (!particleEnabled) count = Math.round(count * 0.5);
        if (!this._allowEmbellishment) count = Math.round(count * 0.62);

        // C-W3 — the rain leans with the one wind: the streak slope reads the
        // gust at the view centre (stepped, so the whole field leans harder
        // while a gust passes), the sideways drift the knot wind (a drift
        // that followed the gust would jump the streaks).
        const drift = baseWindX(weather);
        // Reduced motion holds one lean (the gust field at time 0), so the
        // static streak frame never shifts as gusts pass.
        const lean = this._viewWind(canvas, particleEnabled ? timeMs : 0, weather);
        const pad = 48;
        const travel = canvas.height + pad * 2;
        const speed = particleEnabled ? (0.42 + intensity * 0.34) : 0;
        // The overlay is ungraded: rain at night keeps the hue and gives up
        // some value so it never outshines the lamps.
        const night = clamp(Number(this._lightGrade?.night) || 0, 0, 1);
        const alphaScale = (0.8 + intensity * 0.2) * (1 - night * 0.4);

        ctx.save();
        const layers = particleEnabled ? RAIN_LAYERS : RAIN_LAYERS.slice(1, 2);
        for (const layer of layers) {
            const layerCount = particleEnabled ? Math.round(count * layer.frac) : count;
            if (layerCount <= 0) continue;
            this._drawRainStreakLayer(ctx, canvas, grid, {
                count: layerCount,
                seed,
                drift: drift * layer.windMul,
                lean: lean * layer.windMul,
                pad,
                travel,
                fall: (phaseMs * speed * layer.speedMul) % travel,
                layer,
                alpha: layer.alpha * alphaScale,
            });
        }
        ctx.restore();

        // Storm fronts: a few darker sheets of heavier air drifting on the
        // wind, only in heavy storms and only with motion (the caller gates
        // the flash the same way). `intensity` is already legibility-gated, so
        // a pressured scene drops below the threshold and keeps its labels.
        if (this._allowEmbellishment && storm && intensity > 0.7 && particleEnabled) {
            this._drawRainCurtains(ctx, canvas, { intensity, windX: drift, phaseMs, seed });
        }

        if (this._allowEmbellishment && (weather.precipitation > SPLASH_PRECIP_THRESHOLD || intensity > SPLASH_PRECIP_THRESHOLD)) {
            this._drawRainSplashes(ctx, grid, {
                intensity,
                precipitation: clamp(weather.precipitation, 0, 1),
                particleEnabled,
                seed,
                alphaScale,
            });
        }
    }

    // The world's art-pixel grid on screen (CSS px): one cell per art pixel,
    // phased to the camera so weather cells line up with the world's texels.
    _artGrid() {
        const camera = this.sceneContext?.camera || null;
        const zoom = Math.max(0.1, Number(camera?.zoom) || 1);
        const cell = Math.max(1, Math.round(zoom));
        const ox = mod(Number(camera?.renderOffsetX) || 0, cell);
        const oy = mod(Number(camera?.renderOffsetY) || 0, cell);
        return { camera, zoom, cell, ox, oy };
    }

    // `windAt` under the middle of the view (screen-space layers lean as one).
    _viewWind(canvas, timeMs, weather) {
        const camera = this.sceneContext?.camera;
        if (!camera?.screenToWorld) return baseWindX(weather);
        const centre = camera.screenToWorld(canvas.width / 2, canvas.height / 2);
        return windAt(centre.x, centre.y, timeMs, weather, (this._windScratch ||= { x: 0, gust: 0 })).x;
    }

    // One parallax layer: seeded streaks falling on the layer's own offset,
    // each a run of whole cells that steps one cell sideways per 1/|lean|
    // cells down. All cells go into one path, filled once.
    _drawRainStreakLayer(ctx, canvas, grid, { count, seed, drift, lean: wind, pad, travel, fall, layer, alpha }) {
        const { cell, ox, oy } = grid;
        const xSpan = canvas.width + pad * 2;
        const [minCells, maxCells] = layer.cells;
        const lean = clamp(wind * 0.8, -1.5, 1.5);
        ctx.globalAlpha = clamp(alpha, 0, 1);
        ctx.fillStyle = layer.color;
        ctx.beginPath();
        for (let i = 0; i < count; i++) {
            const s = i + layer.saltOffset;
            const cells = minCells + Math.floor(random01(seed, s + 17) * (maxCells - minCells + 1));
            const y = ((random01(seed, s + 211) * travel + fall) % travel) - pad;
            const rawX = random01(seed, s + 101) * xSpan - pad + fall * drift * 0.34;
            const x = wrap(rawX, -pad, canvas.width + pad);
            const headX = ox + Math.floor((x - ox) / cell) * cell;
            const headY = oy + Math.floor((y - oy) / cell) * cell;
            for (let k = 0; k < cells; k++) {
                if (layer.dashed && k % 2 === 1) continue;
                ctx.rect(headX + Math.round(k * lean) * cell, headY + k * cell, cell, cell);
            }
        }
        ctx.fill();
        ctx.globalAlpha = 1;
    }

    // Winter precipitation: deterministic drifting flakes with a per-flake
    // sinusoidal x-sway and slow fall. No splash stamps, no rain curtains.
    // Reduced motion (particleEnabled false) snaps to a frozen flake field
    // (fall/sway zeroed) mirroring the static rain path.
    _drawSnow(ctx, canvas, weather, phaseMs, seed, particleEnabled) {
        const intensity = clamp(weather.intensity, 0, 1);
        const area = canvas.width * canvas.height;
        const density = weather.type === 'storm' ? 1.18 : 1;
        const animatedScale = particleEnabled ? 1 : 0.5;
        const count = Math.min(
            SNOW_MAX_FLAKES,
            Math.max(
                SNOW_MIN_FLAKES,
                Math.floor((area / (SNOW_AREA_DENSITY * 1.4)) * (0.35 + intensity * 0.85) * density * animatedScale),
            ),
        );

        const windX = baseWindX(weather);
        const pad = 24;
        const travel = canvas.height + pad * 2;
        const alpha = Math.min(0.7, (particleEnabled ? 0.42 : 0.3) + intensity * 0.28);
        const xSpan = canvas.width + pad * 2;

        ctx.save();
        ctx.fillStyle = `rgba(238, 246, 255, ${alpha})`;
        // 6.7 — flakes are one or two whole art-pixel cells.
        const { cell, ox, oy } = this._artGrid();
        for (let i = 0; i < count; i++) {
            const xRand = random01(seed, i + 101);
            const yRand = random01(seed, i + 211);
            const fallSpeed = 0.08 + random01(seed, i + 331) * 0.08; // 0.08–0.16 px/ms
            const size = random01(seed, i + 419) < 0.3 ? 1 : 2;
            const fall = particleEnabled ? phaseMs * fallSpeed : 0;
            const y = ((yRand * travel + fall) % travel) - pad;
            const swayPhase = random01(seed, i + 521) * Math.PI * 2;
            const swayAmp = 4 + random01(seed, i + 617) * 6;
            const sway = particleEnabled ? Math.sin(phaseMs * 0.0016 + swayPhase) * swayAmp : 0;
            const drift = fall * windX * 0.06;
            const rawX = xRand * xSpan - pad + sway + drift;
            const x = wrap(rawX, -pad, canvas.width + pad);
            ctx.fillRect(ox + Math.round((x - ox) / cell) * cell, oy + Math.round((y - oy) / cell) * cell, size * cell, size * cell);
        }
        ctx.restore();
    }

    // 2–3 sheets of heavier air drifting on the wind, each phase-offset, so a
    // storm reads as weather fronts crossing the view. Each sheet is two
    // stepped courses (a dense core inside a thinner band) of source-over
    // darkening: storm air gets heavier, never milkier. Storm-only,
    // animated-only; the courses' alpha stays under the labels' contrast.
    _drawRainCurtains(ctx, canvas, { intensity, windX, phaseMs, seed }) {
        const count = intensity > 0.86 ? 3 : 2;
        const baseAlpha = Math.min(0.1, 0.04 + (intensity - 0.7) * 0.2);
        if (baseAlpha <= 0.005) return;
        const span = canvas.width + canvas.width * 0.6;
        const drift = clamp(Number(windX) || 0, -1.4, 1.4);
        const { cell } = this._artGrid();

        ctx.save();
        ctx.fillStyle = 'rgb(18, 26, 38)';
        for (let i = 0; i < count; i++) {
            const curtainSeed = i * 311;
            const width = canvas.width * (0.32 + random01(seed, curtainSeed + 7) * 0.22);
            const speed = 0.018 + random01(seed, curtainSeed + 13) * 0.014;
            const phase = random01(seed, curtainSeed + 19);
            // Move with the wind; wrap across an extended span so a curtain
            // re-enters from the upwind edge.
            const travel = (phaseMs * speed * drift) + phase * span;
            const left = Math.round((wrap(travel, -width, span) - width * 0.5) / cell) * cell;
            const alpha = baseAlpha * (0.7 + random01(seed, curtainSeed + 29) * 0.5);
            const outer = Math.round(width / cell) * cell;
            const inner = Math.round(width * 0.5 / cell) * cell;
            ctx.globalAlpha = alpha * 0.5;
            ctx.fillRect(left, 0, outer, canvas.height);
            ctx.fillRect(left + Math.round((outer - inner) / 2 / cell) * cell, 0, inner, canvas.height);
        }
        ctx.restore();
    }

    // 6.7 — splashes land on open ground the viewer can see: tiles that are
    // walkable, dry, and not behind a building's opaque art (the overlay has
    // no depth). Each is a three-frame pixel crown in world-anchored cells, so
    // it pans with the ground. Water keeps its own rain ripples.
    _drawRainSplashes(ctx, grid, { intensity, precipitation, particleEnabled, seed, alphaScale }) {
        const camera = grid.camera;
        const tiles = this.sceneContext?.openGroundTiles?.() || null;
        if (!camera?.worldToScreen || !camera?.screenToWorld || !tiles?.length) return;
        const view = this._visibleWorldRect(camera);
        const driveT = Math.min(1, Math.max(intensity, precipitation));
        const alpha = clamp((0.35 + driveT * 0.3) * alphaScale, 0, 1);

        if (!particleEnabled) {
            // Reduced motion: a static ring on a fixed share of the visible
            // open tiles, chosen by each tile's own hash so it never re-rolls.
            for (const tile of tiles) {
                if (tile.seed >= SPLASH_STATIC_SHARE || !inRect(tile, view)) continue;
                this._stampSplash(ctx, grid, tile.x, tile.y, 2, alpha);
            }
            return;
        }

        const now = this.elapsedMs;
        if (now < this._lastSplashStamp) this._lastSplashStamp = now;
        if (now - this._lastSplashStamp >= SPLASH_STAMP_INTERVAL_MS) {
            this._lastSplashStamp = now;
            this._splashStampSeed = (this._splashStampSeed + 1) >>> 0;
            const visible = [];
            for (const tile of tiles) if (inRect(tile, view)) visible.push(tile);
            if (visible.length) {
                const count = Math.round(SPLASH_STAMP_MIN_COUNT + (SPLASH_STAMP_MAX_COUNT - SPLASH_STAMP_MIN_COUNT) * driveT);
                const stampSeed = (seed + Math.imul(this._splashStampSeed + 1, 0x85ebca6b)) >>> 0;
                for (let i = 0; i < count; i++) {
                    const tile = visible[Math.floor(random01(stampSeed, i + 11) * visible.length)];
                    // Anywhere near the middle of the tile's diamond.
                    const u = random01(stampSeed, i + 29) - 0.5;
                    const v = random01(stampSeed, i + 53) - 0.5;
                    this._splashes.push({
                        x: Math.round(tile.x + (u - v) * TILE_WIDTH / 2 * 0.6),
                        y: Math.round(tile.y + (u + v) * TILE_HEIGHT / 2 * 0.6),
                        born: now,
                    });
                }
            }
        }
        let next = 0;
        for (const splash of this._splashes) {
            const frame = Math.floor((now - splash.born) / SPLASH_FRAME_MS);
            if (frame < 0 || frame >= SPLASH_FRAMES.length) continue;
            this._splashes[next++] = splash;
            this._stampSplash(ctx, grid, splash.x, splash.y, frame, alpha);
        }
        this._splashes.length = next;
    }

    _stampSplash(ctx, grid, worldX, worldY, frame, alpha) {
        const { camera, cell, zoom } = grid;
        const p = camera.worldToScreen(worldX - 3, worldY - 3);
        const rows = SPLASH_FRAMES[frame];
        ctx.save();
        ctx.globalAlpha = alpha;
        for (let row = 0; row < rows.length; row++) {
            const line = rows[row];
            for (let col = 0; col < line.length; col++) {
                const mark = line[col];
                if (mark === '.') continue;
                ctx.fillStyle = mark === '#' ? RAIN_LIGHT : RAIN_DIM;
                ctx.fillRect(Math.round(p.x + col * zoom), Math.round(p.y + row * zoom), cell, cell);
            }
        }
        ctx.restore();
    }

    _visibleWorldRect(camera) {
        const width = camera._viewportWidth?.() || 0;
        const height = camera._viewportHeight?.() || 0;
        const a = camera.screenToWorld(0, 0);
        const b = camera.screenToWorld(width, height);
        return { left: a.x - 8, top: a.y - 8, right: b.x + 8, bottom: b.y + 8 };
    }

    // 0.10 — the lightning bolt: midpoint displacement planned once per strike
    // in world space, rasterized every frame on the art-pixel grid
    // (`round(zoom)` px cells): a cream core (one cell, two side by side at
    // zoom ≤ 1 so it reads at the wide shots), a checkerboard `#9fb8ff` halo
    // beside it, 0–2 forks, and a stepped 2:1 splash ring where it meets the
    // sea. It lands only on open sea (a quarter-res sample of the water mask
    // around the endpoint and its ring) or ends in the sky above the horizon,
    // and its forks run only over open sea or sky; it never strikes the
    // island. The re-strike (stage 2) redraws the same channel without its
    // forks.
    _drawLightningBolt(ctx, canvas, strike, seaAt) {
        const grid = this._artGrid();
        const camera = grid.camera;
        if (!camera?.worldToScreen || !camera?.screenToWorld) return;
        if (!this._bolt || this._bolt.id !== strike.id || this._bolt.seed !== strike.seed) {
            this._bolt = planBolt(strike, canvas, camera, seaAt);
        }
        const bolt = this._bolt;
        if (!bolt.points) return;
        const { cell, ox, oy, zoom } = grid;
        const core = zoom <= 1 ? 2 : 1;
        const cellsOf = points => points.map((point) => {
            const screen = camera.worldToScreen(point.x, point.y);
            return { x: Math.floor((screen.x - ox) / cell), y: Math.floor((screen.y - oy) / cell) };
        });
        const main = rasterizeCells(cellsOf(bolt.points));
        ctx.save();
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = 'source-over';
        // Halo: every other cell beside the core, a checkerboard, never a blur.
        ctx.fillStyle = BOLT_HALO;
        ctx.beginPath();
        for (const c of main) {
            if (((c.x + c.y) & 1) === 0) continue;
            ctx.rect(ox + (c.x - 1) * cell, oy + c.y * cell, cell, cell);
            ctx.rect(ox + (c.x + core) * cell, oy + c.y * cell, cell, cell);
        }
        ctx.fill();
        if (strike.stage === 1) {
            // Forks: halo-coloured single cells, their last third broken.
            ctx.beginPath();
            for (const fork of bolt.forks) {
                const cells = rasterizeCells(cellsOf(fork));
                const taper = Math.floor(cells.length * 2 / 3);
                for (let i = 0; i < cells.length; i++) {
                    if (i >= taper && (i & 1)) continue;
                    ctx.rect(ox + cells[i].x * cell, oy + cells[i].y * cell, cell, cell);
                }
            }
            ctx.fill();
        }
        ctx.fillStyle = BOLT_CORE;
        ctx.beginPath();
        for (const c of main) ctx.rect(ox + c.x * cell, oy + c.y * cell, cell * core, cell);
        ctx.fill();
        if (bolt.sea) {
            // The splash grows over the strike's steps (4, 8, 12 art px, the
            // last broken); the re-strike throws one mid ring.
            const rx = strike.stage === 2 ? 6 : [4, 8, 12][Math.min(2, Math.max(0, strike.step))];
            const broken = strike.stage === 1 && strike.step >= 2;
            const count = Math.max(8, Math.round(rx * 1.6));
            ctx.fillStyle = BOLT_SPLASH;
            ctx.beginPath();
            for (let i = 0; i < count; i++) {
                if (broken && (i & 1)) continue;
                const angle = (i / count) * Math.PI * 2;
                const screen = camera.worldToScreen(
                    bolt.end.x + Math.cos(angle) * rx,
                    bolt.end.y + Math.sin(angle) * rx * 0.5,
                );
                ctx.rect(
                    ox + Math.floor((screen.x - ox) / cell) * cell,
                    oy + Math.floor((screen.y - oy) / cell) * cell,
                    cell,
                    cell,
                );
            }
            ctx.fill();
        }
        ctx.restore();
    }
}

/**
 * 0.10 — this frame's lightning, a pure function of the motion-clock time and
 * the village's own storm (never agent state). Returns a reused object:
 * `active`, the C4 `scalar` (0.30 → 0.035, re-strike 0.16), the per-channel
 * `exposure` both backends multiply the frame by (1 + exposure), the bolt
 * `stage` (1 strike, 2 re-strike, 0 afterglow), the `step` index, and the
 * strike `id`/`seed` that key the bolt's shape. Reduced motion (or particle
 * motion off) never strikes: no bolt and no flash.
 */
const _strike = { active: false, scalar: 0, exposure: [0, 0, 0], stage: 0, step: -1, id: -1, seed: 0 };
export function stormStrikeAt(tMs, atmosphere, motionScale = 1) {
    const strike = _strike;
    strike.active = false;
    strike.scalar = 0;
    strike.stage = 0;
    strike.step = -1;
    strike.exposure[0] = 0;
    strike.exposure[1] = 0;
    strike.exposure[2] = 0;
    const weather = atmosphere?.weather;
    if (weather?.type !== 'storm') return strike;
    if (!(Number(motionScale) > 0) || atmosphere?.motion?.particleEnabled === false) return strike;
    const t = Math.max(0, Number(tMs) || 0);
    const seed = Number.isFinite(Number(weather.seed)) ? Number(weather.seed) >>> 0 : 0;
    const intensity = clamp(Number(weather.intensity) || 0, 0, 1);
    const cycle = Math.floor(t / STRIKE_CYCLE_MS);
    if (random01(seed, cycle + 701) > 0.18 + intensity * 0.10) return strike;
    const offset = 900 + random01(seed, cycle + 809) * 4700;
    const age = t - cycle * STRIKE_CYCLE_MS - offset;
    if (age < 0) return strike;
    let index = -1;
    for (let i = 0; i < FLASH_STEPS.length; i++) if (age >= FLASH_STEPS[i].at) index = i;
    const step = FLASH_STEPS[index];
    if (!step || step.scalar <= 0) return strike;
    const night = clamp(Number(atmosphere.lightGrade?.night) || 0, 0, 1);
    const gain = step.scalar * (FLASH_GAIN_DAY + (FLASH_GAIN_NIGHT - FLASH_GAIN_DAY) * night);
    strike.active = true;
    strike.scalar = step.scalar;
    strike.stage = step.stage;
    strike.step = index;
    strike.id = cycle;
    strike.seed = (seed + Math.imul(cycle + 1, 0x27d4eb2f)) >>> 0;
    for (let channel = 0; channel < 3; channel++) strike.exposure[channel] = gain * FLASH_TINT[channel];
    return strike;
}

/**
 * The flash as an exposure step on a finished 2D frame: a flat `color-dodge`
 * fill of `e / (1 + e)` multiplies every pixel by `1 + e` per channel, the
 * same scale the resident composite applies to the island (`u_flash`). One
 * fillRect; no gradient, no veil.
 */
export function drawFlashExposure(ctx, width, height, strike) {
    if (!ctx || !strike?.active || !(width > 0) || !(height > 0)) return false;
    const e = strike.exposure;
    const channel = index => Math.round((255 * e[index]) / (1 + e[index]));
    ctx.save();
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'color-dodge';
    ctx.fillStyle = `rgb(${channel(0)}, ${channel(1)}, ${channel(2)})`;
    ctx.fillRect(0, 0, width, height);
    ctx.restore();
    return true;
}

// Endpoint first: open sea below the horizon, tried at hashed candidates,
// else a point in the sky band when the sky is in view, else no bolt. The
// channel runs from above the top of the view to it.
function planBolt(strike, canvas, camera, seaAt) {
    const seed = strike.seed;
    const width = canvas.width;
    const height = canvas.height;
    const horizon = camera.worldToScreen(0, OCEAN_HORIZON_WORLD_Y).y;
    const zoom = Math.max(0.1, Number(camera.zoom) || 1);
    let end = null;
    let sea = false;
    if (typeof seaAt === 'function') {
        const top = Math.max(horizon + 24, height * 0.3);
        for (let i = 0; i < BOLT_CANDIDATES && !end; i++) {
            const sx = width * (0.06 + random01(seed, 31 + i * 7) * 0.88);
            const sy = top + random01(seed, 37 + i * 7) * (height * 0.94 - top);
            if (!(sy < height * 0.94)) break;
            if (!openSeaAround(camera, seaAt, sx, sy, zoom)) continue;
            end = camera.screenToWorld(sx, sy);
            sea = true;
        }
    }
    // `seaAt(x, y, true)` also admits the sky band: fork channels and a sky
    // endpoint must be open (never over island art) too.
    const openAt = typeof seaAt === 'function' ? (point) => seaAt(point.x, point.y, true) : () => true;
    for (let i = 0; !end && i < 4 && horizon > height * 0.18; i++) {
        const sx = width * (0.15 + random01(seed, 211 + i * 5) * 0.7);
        const sy = Math.min(horizon, height) * (0.45 + random01(seed, 223 + i * 5) * 0.3);
        const candidate = camera.screenToWorld(sx, sy);
        if (openAt(candidate)) end = candidate;
    }
    if (!end) return { id: strike.id, seed, points: null, forks: [], end: null, sea: false };
    const endScreen = camera.worldToScreen(end.x, end.y);
    const start = camera.screenToWorld(endScreen.x + (random01(seed, 239) - 0.5) * width * 0.18, -8);
    const length = Math.hypot(end.x - start.x, end.y - start.y) || 1;
    const points = displaceBolt(start, end, seed, 6, length * 0.14);
    const forks = [];
    const forkCount = Math.min(2, Math.floor(random01(seed, 251) * 3));
    for (let f = 0; f < forkCount; f++) {
        const anchor = points[Math.floor(points.length * (0.25 + 0.4 * random01(seed, 263 + f)))];
        const side = random01(seed, 271 + f) < 0.5 ? -1 : 1;
        const baseReach = length * (0.12 + random01(seed, 281 + f) * 0.1);
        const spread = 0.4 + random01(seed, 293 + f) * 0.5;
        // The authored fork first, then the other side, then shorter; a fork
        // that would cross island art in every try is dropped.
        for (const [turn, share] of [[side, 1], [-side, 1], [side, 0.55], [-side, 0.55]]) {
            const reach = baseReach * share;
            const angle = Math.PI / 2 + turn * spread;
            const tip = { x: anchor.x + Math.cos(angle) * reach, y: anchor.y + Math.sin(angle) * reach };
            const fork = displaceBolt(anchor, tip, (seed + (f + 1) * 131) >>> 0, 4, reach * 0.2);
            if (!polylineOpen(fork, openAt)) continue;
            forks.push(fork);
            break;
        }
    }
    return { id: strike.id, seed, points, forks, end, sea };
}

// Every point along the polyline, sampled at least every BOLT_MASK_STEP
// world px, is open.
function polylineOpen(points, openAt) {
    const probe = { x: 0, y: 0 };
    for (let i = 1; i < points.length; i++) {
        const a = points[i - 1];
        const b = points[i];
        const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / BOLT_MASK_STEP));
        for (let s = i === 1 ? 0 : 1; s <= steps; s++) {
            probe.x = a.x + ((b.x - a.x) * s) / steps;
            probe.y = a.y + ((b.y - a.y) * s) / steps;
            if (!openAt(probe)) return false;
        }
    }
    return true;
}

// The water mask at quarter resolution: the endpoint and the extremes of its
// splash ring, each snapped to a 4 px sample, must all be open sea.
function openSeaAround(camera, seaAt, sx, sy, zoom) {
    const rx = 14 * zoom;
    const ry = 7 * zoom;
    const samples = [[0, 0], [-rx, 0], [rx, 0], [0, -ry], [0, ry], [-rx * 0.7, -ry * 0.7], [rx * 0.7, ry * 0.7]];
    for (const [dx, dy] of samples) {
        const qx = Math.floor((sx + dx) / BOLT_MASK_STEP) * BOLT_MASK_STEP + BOLT_MASK_STEP / 2;
        const qy = Math.floor((sy + dy) / BOLT_MASK_STEP) * BOLT_MASK_STEP + BOLT_MASK_STEP / 2;
        const world = camera.screenToWorld(qx, qy);
        if (!seaAt(world.x, world.y)) return false;
    }
    return true;
}

// Recursive midpoint displacement between two world points.
function displaceBolt(a, b, seed, depth, jitter) {
    let segments = [a, b];
    let amplitude = jitter;
    for (let d = 0; d < depth; d++) {
        const next = [segments[0]];
        for (let i = 0; i < segments.length - 1; i++) {
            const p = segments[i];
            const q = segments[i + 1];
            const off = (random01(seed, d * 211 + i * 17 + 3) - 0.5) * amplitude;
            const dx = q.x - p.x;
            const dy = q.y - p.y;
            const len = Math.hypot(dx, dy) || 1;
            next.push({ x: (p.x + q.x) / 2 + (-dy / len) * off, y: (p.y + q.y) / 2 + (dx / len) * off }, q);
        }
        segments = next;
        amplitude *= 0.5;
    }
    return segments;
}

// Bresenham through cell-space points: one cell per step, no gaps, no AA.
function rasterizeCells(points) {
    const cells = [];
    for (let i = 1; i < points.length; i++) {
        let x0 = points[i - 1].x;
        let y0 = points[i - 1].y;
        const x1 = points[i].x;
        const y1 = points[i].y;
        const dx = Math.abs(x1 - x0);
        const dy = -Math.abs(y1 - y0);
        const sx = x0 < x1 ? 1 : -1;
        const sy = y0 < y1 ? 1 : -1;
        let err = dx + dy;
        for (;;) {
            if (i === 1 || x0 !== points[i - 1].x || y0 !== points[i - 1].y) cells.push({ x: x0, y: y0 });
            if (x0 === x1 && y0 === y1) break;
            const e2 = 2 * err;
            if (e2 >= dy) { err += dy; x0 += sx; }
            if (e2 <= dx) { err += dx; y0 += sy; }
        }
    }
    return cells;
}

function washBucket(intensity) {
    return Math.round(clamp(Number(intensity) || 0, 0, 1) * WASH_BUCKETS);
}

// Piecewise-linear alpha profile down the screen, `stops` = [[t, share]].
function washProfile(stops, t) {
    if (t <= stops[0][0]) return stops[0][1];
    for (let i = 1; i < stops.length; i++) {
        const [t1, v1] = stops[i];
        if (t <= t1) {
            const [t0, v0] = stops[i - 1];
            return v0 + (v1 - v0) * ((t - t0) / Math.max(1e-6, t1 - t0));
        }
    }
    return stops[stops.length - 1][1];
}

// A periodic value-noise field (fBm, two octaves) over the fog tile's
// texel grid, cut into three flat courses by covered share. The field keeps
// its local slope (per texel) so the ordered dither at each seam spans a
// fixed FOG_SEAM_TEXELS either side, whatever the gradient. The field is
// built once; the tile is rebaked (into the reused canvas) per strength
// bucket.
let _fogField = null;
function fogField() {
    if (_fogField) return _fogField;
    const w = FOG_TILE_W / FOG_TEXEL;
    const h = FOG_TILE_H / FOG_TEXEL;
    const values = new Float32Array(w * h);
    for (const [px, py, amp] of FOG_OCTAVES) {
        const at = (ix, iy) => random01(0x5f0c + px, (iy % py) * 131 + (ix % px));
        for (let y = 0; y < h; y++) {
            const gy = (y / h) * py;
            const y0 = Math.floor(gy);
            const fy = gy - y0;
            const sy = fy * fy * (3 - 2 * fy);
            for (let x = 0; x < w; x++) {
                const gx = (x / w) * px;
                const x0 = Math.floor(gx);
                const fx = gx - x0;
                const sx = fx * fx * (3 - 2 * fx);
                const top = at(x0, y0) + (at(x0 + 1, y0) - at(x0, y0)) * sx;
                const bottom = at(x0, y0 + 1) + (at(x0 + 1, y0 + 1) - at(x0, y0 + 1)) * sx;
                values[y * w + x] += amp * (top + (bottom - top) * sy);
            }
        }
    }
    // Largest per-texel change (wrapped central differences).
    const slope = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
        const up = ((y + h - 1) % h) * w;
        const down = ((y + 1) % h) * w;
        for (let x = 0; x < w; x++) {
            const left = (x + w - 1) % w;
            const right = (x + 1) % w;
            slope[y * w + x] = Math.max(
                Math.abs(values[y * w + right] - values[y * w + left]),
                Math.abs(values[down + x] - values[up + x]),
            ) / 2;
        }
    }
    const sorted = Float32Array.from(values).sort();
    _fogField = { w, h, values, slope, sorted };
    return _fogField;
}

function bakeFogBankTile(canvas, strength, rgb) {
    const { w, h, values, slope, sorted } = fogField();
    const tile = canvas || document.createElement('canvas');
    tile.width = w;
    tile.height = h;
    const tctx = tile.getContext('2d');
    const image = tctx.createImageData(w, h);
    const share = 0.3 + 0.34 * strength;
    const threshold = s => sorted[Math.round((1 - clamp(s, 0, 1)) * (sorted.length - 1))];
    const t1 = threshold(share);
    const t2 = threshold(share * 0.55);
    const t3 = threshold(share * 0.25);
    const alphaScale = 0.5 + 0.5 * strength;
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const index = y * w + x;
            const n = values[index] + (BAYER4[(y % 4) * 4 + (x % 4)] / 16 - 0.5) * 2 * FOG_SEAM_TEXELS * slope[index];
            const course = (n >= t1 ? 1 : 0) + (n >= t2 ? 1 : 0) + (n >= t3 ? 1 : 0);
            if (!course) continue;
            const offset = (y * w + x) * 4;
            image.data[offset] = rgb[0];
            image.data[offset + 1] = rgb[1];
            image.data[offset + 2] = rgb[2];
            image.data[offset + 3] = Math.round(FOG_COURSE_ALPHA[course - 1] * alphaScale * 255);
        }
    }
    tctx.putImageData(image, 0, 0);
    return tile;
}

function normalizeWeather(atmosphere) {
    const raw = atmosphere?.weather;
    const rawType = typeof raw === 'string'
        ? raw
        : raw?.type || atmosphere?.weatherType || atmosphere?.type || 'clear';
    const type = normalizeType(rawType);
    const rawIntensity = typeof raw === 'object' && raw
        ? raw.intensity
        : atmosphere?.intensity;
    const intensity = clamp(
        Number.isFinite(Number(rawIntensity))
            ? Number(rawIntensity)
            : DEFAULT_INTENSITY[type] || 0,
        0,
        1,
    );
    const preset = WEATHER_PRESETS[type] || WEATHER_PRESETS.clear;
    const windX = typeof raw === 'object' && raw ? raw.windX : atmosphere?.windX;
    const cloudCover = typeof raw === 'object' && raw && Number.isFinite(Number(raw.cloudCover))
        ? Number(raw.cloudCover)
        : preset.cloudCover;
    const precipitation = typeof raw === 'object' && raw && Number.isFinite(Number(raw.precipitation))
        ? Number(raw.precipitation)
        : preset.precipitation;
    const fog = typeof raw === 'object' && raw && Number.isFinite(Number(raw.fog))
        ? Number(raw.fog)
        : preset.fog;
    const seed = typeof raw === 'object' && raw ? raw.seed : null;

    return {
        type,
        intensity,
        windX,
        cloudCover: clamp(cloudCover, 0, 1),
        precipitation: clamp(precipitation, 0, 1),
        fog: clamp(fog, 0, 1),
        seed,
    };
}

// The fog's own strength (fog weather, or any weather carrying fog),
// legibility-gated: the screen wash and the ground banks both follow it.
function fogWashIntensity(weather, legibility) {
    const fogActive = weather.fog > 0.04 || weather.type === 'fog';
    return fogActive
        ? Math.max(weather.fog, weather.type === 'fog' ? weather.intensity : 0) * legibility.fog
        : 0;
}

// The ground banks: the fog's strength, else a thin mist on a dry overcast.
function fogBankIntensity(weather, legibility) {
    const fog = fogWashIntensity(weather, legibility);
    if (fog > 0 || weather.fog > 0.04 || weather.type === 'fog') return fog;
    const rainActive = RAIN_TYPES.has(weather.type) || weather.precipitation > RAIN_START_PRECIPITATION;
    return !rainActive && weather.type === 'overcast' ? weather.intensity * 0.34 : 0;
}

function weatherLegibilityGate(weather, atmosphere) {
    const weatherIntensity = clamp(Number(weather?.intensity) || 0, 0, 1);
    const fog = clamp(Number(weather?.fog) || 0, 0, 1);
    const precipitation = clamp(Number(weather?.precipitation) || 0, 0, 1);
    const pressure = Math.max(fog * 0.95, precipitation * 0.62, weatherIntensity * (weather?.type === 'storm' ? 0.7 : 0.42));
    const configured = Number(atmosphere?.weatherLegibilityScale ?? atmosphere?.legibility?.weatherScale);
    const explicitScale = Number.isFinite(configured) ? clamp(configured, 0.45, 1.15) : null;
    const base = explicitScale ?? clamp(1 - pressure * 0.28, 0.68, 1);
    return {
        wash: base,
        fog: clamp(base + 0.06, 0.72, 1),
        rain: clamp(base + 0.08, 0.74, 1),
        flash: clamp(base + 0.16, 0.78, 1),
    };
}

function isWinterMonth(atmosphere) {
    const localDate = atmosphere?.clock?.localDate;
    let month = NaN;
    if (typeof localDate === 'string' && localDate.length >= 7) {
        month = Number(localDate.slice(5, 7));
    }
    if (!Number.isFinite(month) || month < 1 || month > 12) {
        const date = atmosphere?.effectiveDate;
        if (date instanceof Date) month = date.getMonth() + 1;
    }
    return month === 12 || month === 1 || month === 2;
}

function normalizeType(type) {
    const value = String(type || 'clear').trim().toLowerCase().replace(/[\s_]+/g, '-');
    if (value === 'cloudy') return 'overcast';
    if (value === 'stormy' || value === 'thunderstorm') return 'storm';
    if (value === 'partlycloudy') return 'partly-cloudy';
    if (WEATHER_TYPE_SET.has(value)) {
        return value;
    }
    return 'clear';
}

function seedFromAtmosphere(atmosphere, weather) {
    if (Number.isFinite(Number(weather?.seed))) return Number(weather.seed) >>> 0;
    const key = [
        atmosphere?.cacheKey || '',
        atmosphere?.phase || '',
        weather.type,
    ].join('|');
    return hashString(key || weather.type);
}

function hashString(value) {
    let hash = 2166136261;
    for (let i = 0; i < value.length; i++) {
        hash ^= value.charCodeAt(i);
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

function wrap(value, min, max) {
    const size = max - min;
    if (size <= 0) return min;
    return ((((value - min) % size) + size) % size) + min;
}

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function mod(value, size) {
    return ((value % size) + size) % size;
}

function inRect(point, rect) {
    return point.x >= rect.left && point.x <= rect.right && point.y >= rect.top && point.y <= rect.bottom;
}
