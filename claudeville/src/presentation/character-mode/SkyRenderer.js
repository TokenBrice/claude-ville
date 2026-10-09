// claudeville/src/presentation/character-mode/SkyRenderer.js
//
// Drawn first thing in IsometricRenderer._render() before the camera
// transform — viewport-fixed.

import { AtmosphereState, sampleSkyLadder } from './AtmosphereState.js';
import { canvasPixelCount, releaseCanvasBackingStore } from './CanvasBudget.js';
import { ungradeRgb } from './CanvasGrade.js';
import { applyGradeToRgb } from './GradeEvaluator.js';
import { OCEAN_HORIZON_WORLD_Y } from './CoastBake.js';
import { cloudCourseDrift } from './Wind.js';
import { groundOptionsFor, rainClearedMinutesAgo } from './GroundState.js';
import {
    ornamentPlan,
    resolveCalmGate,
    setCalmSceneHints,
} from './MarkGovernor.js';

// 1.3 — star density scales with viewport area but stays sparse: a few
// pixel stars, not a field. The baked starfield and the live twinkle walk
// the same deterministic PRNG sequence, so both derive the count from the
// canvas via starCountForCanvas() below.
const STAR_BASE_COUNT = 64;
const STAR_BASE_AREA = 1280 * 720;
const STAR_MIN_COUNT = 40;
const STAR_MAX_COUNT = 140;
// 1.3 — the sea horizon in world px: the outer ocean's top edge
// (CoastBake.OCEAN_HORIZON_WORLD_Y, four tiles above the island's north
// vertex). The plate's haze band straddles it.
const SKY_HORIZON_WORLD_Y = OCEAN_HORIZON_WORLD_Y;
// 4x4 Bayer in [0, 16).
const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
// Sky courses above the horizon, zenith to haze.
const SKY_COURSES = 11;
const STAR_CEILING_FRAC = 0.60;
// Live twinkle: this many hot stars are redrawn per frame over the cached
// (static) night sky with staggered sinusoidal alpha. Positions come from the
// same deterministic PRNG walk as _drawStars, so they land on baked hot stars.
const LIVE_TWINKLE_STARS = 12;
// 5.2 — rare ambient meteors on clear nights (no event needed): one every
// ~90–180s while the sky is clear enough to read as a starfield; 5.8 drops
// the interval to 20–70 s within a day of a meteor-shower peak.
const AMBIENT_METEOR_MIN_MS = 90000;
const AMBIENT_METEOR_SPAN_MS = 90000;
const SHOWER_METEOR_MIN_MS = 20000;
const SHOWER_METEOR_SPAN_MS = 50000;
const AMBIENT_METEOR_MIN_STARS_ALPHA = 0.45;
const AMBIENT_METEOR_MAX_CLOUD_COVER = 0.35;
const FALLBACK_MOON_ID = 'atmosphere.moon.crescent';
// 0.10 — the sun is a flat-to-core stepped disc baked on a 2 px cell: a flat
// body, a lighter mid course and a pale core, no outline ring and no
// specular dot (a light source, not a glossy ball). Every course out-values
// the dusk horizon (≈ #e2a98a at 18:00), so it reads as the brightest thing
// in the sky.
const SUN_STAMP_CELL_PX = 2;
const SUN_COURSES = Object.freeze({
    day: Object.freeze(['#ffdf86', '#ffe992', '#fff0a0']),
    warm: Object.freeze(['#ffcf7c', '#ffe08e', '#fff0a0']),
});
const MOON_PHASE_ASSETS = {
    crescent: 'atmosphere.moon.crescent.cool',
    half: 'atmosphere.moon.half.cool',
    gibbous: 'atmosphere.moon.gibbous.cool',
};
// 5.8 — a meteor is rasterized on this cell: a bright head cell and a trail
// of whole cells in three stepped courses, never an anti-aliased stroke.
const METEOR_CELL_PX = 2;
const METEOR_COURSES = Object.freeze([
    Object.freeze({ rgb: '#fffbe8', alpha: 1 }),
    Object.freeze({ rgb: '#ffe2a8', alpha: 0.62 }),
    Object.freeze({ rgb: '#e9a878', alpha: 0.3 }),
]);
const CANOPY_HEIGHT_FRAC = 0.52;
const CANOPY_MIN_HEIGHT = 240;
const CANOPY_MAX_HEIGHT = 520;
// The sun's disc centre stays this many radii above the sea horizon, so it
// always sits in the sky plate, never on the sea or the island. The moon
// (64 px authored discs) holds the same way.
const SUN_HORIZON_CLEARANCE_RADIUS = 1.3;
const MOON_DISC_RADIUS = 32;
const SHOOTING_STAR_DURATION_MS = 1200;
// Slow sky layers (stars, sun, moon) are composed into one cached frame and
// refreshed at this cadence instead of repainting several full-screen
// gradients every animation frame. The horizon deck and the rainbow draw
// from their own baked strips over it.
const SKY_FRAME_REFRESH_MS = 200;
const FAST_SKY_CSS_PIXELS = 800_000;
const FAST_SKY_FRAME_REFRESH_MS = 1000;
const FAST_SKY_CAMERA_QUANT_PX = 64;
const SHOOTING_STAR_MAX = 3;
const SHOOTING_STAR_NIGHT_PHASES = new Set(['night', 'dusk']);
// Below this cloud cover the sky is clear enough for god-rays to break
// through; above it the overcast plate swallows them.
const GODRAY_CLOUD_COVER_MAX = 0.74;

const CONSTELLATIONS = [
    {
        anchor: [0.15, 0.20],
        points: [[0, 0], [0.035, -0.030], [0.072, -0.018], [0.104, -0.055], [0.137, -0.024]],
    },
    {
        anchor: [0.53, 0.16],
        points: [[0, 0], [0.028, 0.026], [0.057, 0.006], [0.090, 0.034], [0.119, 0.016]],
    },
    {
        anchor: [0.74, 0.29],
        points: [[0, 0], [0.026, -0.034], [0.052, -0.003], [0.079, -0.034]],
    },
    {
        anchor: [0.33, 0.38],
        points: [[0, 0], [0.024, -0.024], [0.054, -0.016], [0.081, -0.045], [0.112, -0.038]],
    },
];

// 5.8 — IMO 2026 meteor-shower calendar (northern hemisphere, M9): each
// shower's local peak days (month 0–11, first and last) and its radiant on
// the sky plate (fractions of the frame; above the frame when y < 0). Within
// a day of a peak, on a clear night, meteors come every 20–70 s and every
// one streaks away from the radiant; otherwise a sporadic one every
// 90–180 s in a random direction.
export const METEOR_SHOWERS = Object.freeze([
    { name: 'Quadrantids', month: 0, days: [3, 4], radiant: [0.46, -0.04] },
    { name: 'Lyrids', month: 3, days: [22, 22], radiant: [0.64, 0.02] },
    { name: 'eta Aquariids', month: 4, days: [6, 6], radiant: [0.86, 0.30] },
    { name: 'Southern delta Aquariids', month: 6, days: [30, 30], radiant: [0.84, 0.34] },
    { name: 'Perseids', month: 7, days: [12, 13], radiant: [0.30, 0.04] },
    { name: 'Draconids', month: 9, days: [8, 8], radiant: [0.52, -0.06] },
    { name: 'Orionids', month: 9, days: [21, 21], radiant: [0.18, 0.22] },
    { name: 'Leonids', month: 10, days: [17, 17], radiant: [0.24, 0.16] },
    { name: 'Geminids', month: 11, days: [14, 14], radiant: [0.36, 0.08] },
    { name: 'Ursids', month: 11, days: [22, 22], radiant: [0.56, -0.08] },
].map(shower => Object.freeze(shower)));

const DAY_MS = 24 * 60 * 60 * 1000;

/** The shower whose peak is within a day of `date`'s local date, or null. */
export function meteorShowerFor(date) {
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) return null;
    const year = date.getFullYear();
    const today = Date.UTC(year, date.getMonth(), date.getDate());
    for (const shower of METEOR_SHOWERS) {
        const first = Date.UTC(year, shower.month, shower.days[0]) - DAY_MS;
        const last = Date.UTC(year, shower.month, shower.days[1]) + DAY_MS;
        if (today >= first && today <= last) return shower;
    }
    return null;
}

// 5.7 — the horizon cloud deck: three baked strips of stepped-noise cumulus
// silhouettes on the plate's round(zoom) cell, far to near. Sizes are shares
// of the sky band B = horizonY − top (bucketed): `f` lifts a strip's base
// above the sea horizon (y = horizonY − f·B), `height` is the strip's
// height and `puff` the cloud radii range. Nearer strips are taller,
// puffier and pan faster. Nothing is drawn below SKY_HORIZON_WORLD_Y.
const DECK_STRIPS = Object.freeze([
    Object.freeze({ f: 0, parallax: 0.02, height: 0.1, puff: [0.035, 0.08], salt: 11 }),
    Object.freeze({ f: 0.12, parallax: 0.05, height: 0.15, puff: [0.05, 0.12], salt: 23 }),
    Object.freeze({ f: 0.3, parallax: 0.09, height: 0.22, puff: [0.07, 0.17], salt: 37 }),
]);
// One strip repeats every DECK_PERIOD_PX screen px (> a 2560 view, and the
// three strips' periods drift apart under parallax).
const DECK_PERIOD_PX = 3072;
const DECK_BAND_BUCKET_PX = 48;
// [sun-side rim, body, underside] in final (graded) colour.
// Noon: a white crown, a body a step above the horizon sky, a blue-grey base.
const DECK_NOON = Object.freeze(['#f4f7fa', '#dce5ee', '#a9bacb']);
const DECK_DUSK = Object.freeze(['#f6be96', '#a07492', '#74536e']);
const DECK_HEAVY_WEATHER = new Set(['overcast', 'rain', 'storm']);

// 5.8 — the after-rain rainbow: six stepped bands (outer red to inner
// violet) on 2 px cells with a Bayer edge at the outer and inner rims, at
// most 0.35 alpha, fading in and out in three quanta.
const RAINBOW_CELL_PX = 2;
const RAINBOW_BANDS = Object.freeze(['#c46a5e', '#d4955c', '#d9c878', '#86ad7c', '#6f90c0', '#8676b4']);
const RAINBOW_MAX_ALPHA = 0.35;
const RAINBOW_MAX_SUN_ELEVATION_DEG = 42;
const LIVE_TWINKLE_STARS_CALM = 3;
const LIVE_TWINKLE_RATE_SCALE_CALM = 0.28;
// W8.8 (AD-P14) — aurora nights: three baked ribbon phases (A → B → C,
// pixflux on one forced 5-colour palette, per-course alpha baked in) drawn
// as three ribbons in the sky band above the sea horizon. Gate: the meteor
// gate (night phases, stars ≥ 0.45, cover ≤ 0.35) in Nov–Feb, read off the
// village clock and weather only, never agent state (V3). Each ribbon steps
// to its next phase every AURORA_STEP_MS on the slow band, the three offset
// by a third of a step so only one changes at a time (one swap every 2.4 s:
// a phase is a whole new curtain silhouette, so a faster swap reads as
// flicker from the corner of the eye); reduced motion holds each on its own
// fixed phase. The ribbons lay over the sky at AURORA_ALPHA, emitted light
// the stars and the moon show through rather than a painted hedge, and only
// where the sky band holds a whole ribbon: a lower edge cut by the frame top
// reads as debris, not sky. Unlit sky art: no glow, no HDR role.
const AURORA_IDS = Object.freeze(['atmosphere.aurora.a', 'atmosphere.aurora.b', 'atmosphere.aurora.c']);
// The sprites' courses (edge, body, teal, violet, fringe) and the final
// colour each is painted as: the authored hues pulled down to OKLab L 0.54 /
// 0.50 / 0.46 / 0.42 / 0.38, so the brightest course stays under 0.55 and
// far under every attention plate, and the fringe still sits above the
// night zenith (an aurora never darkens the sky).
const AURORA_SOURCE = Object.freeze(['#86d8a2', '#4fb08a', '#2f8280', '#455c96', '#4c3d7c']);
export const AURORA_COURSES = Object.freeze(['#2d8150', '#037554', '#006664', '#344a82', '#453574']);
export const AURORA_MONTHS = Object.freeze([10, 11, 0, 1]);
export const AURORA_STEP_MS = 7200;
export const AURORA_ALPHA = 0.7;
// Ribbon placement on the sky band B = horizonY: centre x as a share of the
// frame, and the lift of the ribbon's lower edge above the sea horizon.
const AURORA_RIBBONS = Object.freeze([
    Object.freeze({ xFrac: 0.17, lift: 0.30 }),
    Object.freeze({ xFrac: 0.48, lift: 0.44 }),
    Object.freeze({ xFrac: 0.77, lift: 0.24 }),
]);
const AURORA_MAX_CELL = 2;
const AURORA_BAND_SHARE = 0.8;

export function liveTwinkleBudget({ calm = false, motionScale = 1 } = {}) {
    const plan = ornamentPlan({ calm, motionScale, level: 0 });
    if (plan.liveTwinkle === 'off') return { count: 0, rateScale: 0 };
    if (plan.liveTwinkle === 'sparse') {
        return { count: LIVE_TWINKLE_STARS_CALM, rateScale: LIVE_TWINKLE_RATE_SCALE_CALM };
    }
    return { count: LIVE_TWINKLE_STARS, rateScale: 1 };
}

// 5.8 — meteors are the sky's own calendar events, already rare, and they
// only come on clear nights — exactly when the scene's calm gate is closed
// (calm = clear weather, no attention, no recent event). So the calm gate
// never silences them; reduced motion still does.
export function allowAmbientMeteor({ motionScale = 1 } = {}) {
    return ornamentPlan({ calm: false, motionScale, level: 0 }).ambientMeteors === 'on';
}

// W8.8 — the aurora shares the meteor gate, in the winter months only. It
// reads the atmosphere snapshot's phase, stars, cloud cover and effective
// date and nothing else: no agent, roster, mood or director input (V3).
export function auroraGateOpen(atmosphere) {
    if (!SHOOTING_STAR_NIGHT_PHASES.has(atmosphere?.phase)) return false;
    if ((atmosphere.sky?.starsAlpha ?? 0) < AMBIENT_METEOR_MIN_STARS_ALPHA) return false;
    if (clamp(atmosphere.weather?.cloudCover ?? 0) > AMBIENT_METEOR_MAX_CLOUD_COVER) return false;
    const date = atmosphere.effectiveDate;
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) return false;
    return AURORA_MONTHS.includes(date.getMonth());
}

// W8.8 — ribbon `ribbon`'s phase (0 A, 1 B, 2 C) at motion time `timeMs`:
// one step per AURORA_STEP_MS, each ribbon a third of a step after the one
// before and a phase ahead of it. Without motion (reduced motion, a held
// clock) each ribbon holds its own fixed phase.
export function auroraPhaseIndex(ribbon, timeMs, motionScale = 1) {
    const phases = AURORA_IDS.length;
    if (!(motionScale > 0) || !Number.isFinite(timeMs)) return ribbon % phases;
    const step = Math.floor((timeMs + (ribbon * AURORA_STEP_MS) / phases) / AURORA_STEP_MS);
    return (((step + ribbon) % phases) + phases) % phases;
}

// Weather plate is a vertical, canvas-wide sky condition. Spatial ground
// haze lives in WorldFrameRenderer (ground-atmosphere stage).
export const SKY_WEATHER_PLATE_SPACE = 'vertical-canvas';

export class SkyRenderer {
    constructor({ assets } = {}) {
        this.assets = assets || null;
        this.cache = null;
        this.cacheKey = '';
        this._frameCache = null;
        this._frameCacheKey = '';
        this._deck = null;
        this._deckKey = '';
        this._rainbowStamp = null;
        this._aurora = null;
        this.deckBakes = 0;
        this._fallbackAtmosphere = null;
        this._shootingStars = [];
        this._nextAmbientMeteorAt = 0;
        this._sunStamp = null;
        this._currentPhase = null;
        this._currentCloudCover = 0;
        this._currentMotionScale = 1;
        this._backdropGraded = false;
        this._frameHasContent = false;
        this.plateBakes = 0;
    }

    // `backdropGraded`: true when nothing grades the 2D frame after this
    // draw (the resident GPU world sits over it), so the plate, the deck and
    // the rainbow paint the C2 sky colours as-is; false on the Canvas/PostFx
    // paths, which grade the finished frame, so they paint the preimage of
    // the same colours instead. `timeMs` is the motion clock (the deck's
    // drift integrator); reduced motion holds it.
    draw(ctx, arg1 = {}, arg2 = null, arg3 = 16, arg4 = 1) {
        const { canvas, camera, atmosphere, motionScale, backdropGraded, timeMs } = this._normalizeDrawArgs(arg1, arg2, arg3, arg4);
        if (!canvas) return;
        const snapshot = atmosphere || this._getFallbackAtmosphere(motionScale);
        this._currentPhase = snapshot.phase || null;
        this._currentMotionScale = motionScale;
        this._currentCloudCover = clamp(snapshot.weather?.cloudCover ?? 0, 0, 1);
        this._backdropGraded = backdropGraded;

        this._horizonY = this._horizonScreenY(camera, canvas);
        this._drawPlate(ctx, canvas, camera, snapshot);
        const frame = this._getComposedSkyFrame(canvas, camera, snapshot);
        if (this._frameHasContent) ctx.drawImage(frame, 0, 0, canvas.width, canvas.height);
        // The star twinkle stays live over the cached layer; ambient meteors
        // ride the canopy pass (drawCanopy) so they draw over terrain.
        this._publishCalmSceneHints(snapshot);
        this._drawLiveStarTwinkle(ctx, canvas, snapshot, motionScale);
        // 5.8 then 5.7 — the rainbow sits behind the horizon deck, and the
        // deck in front of the low sun and moon.
        this._drawRainbow(ctx, canvas, snapshot, motionScale);
        // W8.8 — the aurora sits behind the horizon deck too.
        this._drawAurora(ctx, canvas, snapshot, motionScale, motionScale > 0 ? timeMs : null);
        this._drawHorizonDeck(ctx, camera, canvas, snapshot, motionScale > 0 ? timeMs : null);
        this._maybeTriggerAmbientMeteor(snapshot);
    }

    // The calm gate reads the sky's own state only: the weather and an
    // ambient meteor in flight. No agent, mood or director input (V3).
    _publishCalmSceneHints(atmosphere) {
        setCalmSceneHints({
            weatherType: atmosphere?.weather?.type || null,
            recentEvent: this._shootingStars.length > 0,
        });
    }

    // Compose the slow celestial layers (stars, sun, moon) into one
    // transparent offscreen frame over the plate. Refreshes on atmosphere
    // bucket change, viewport resize, camera movement (the sun clamp reads
    // the camera), or every SKY_FRAME_REFRESH_MS.
    _getComposedSkyFrame(canvas, camera, atmosphere) {
        const dpr = this._skyCacheDpr(canvas);
        const fast = this._useFastSkyCache(canvas);
        const cameraQuant = fast ? FAST_SKY_CAMERA_QUANT_PX : 4;
        const refreshMs = fast ? FAST_SKY_FRAME_REFRESH_MS : SKY_FRAME_REFRESH_MS;
        const quantX = Math.round((camera?.x || 0) / cameraQuant);
        const quantY = Math.round((camera?.y || 0) / cameraQuant);
        const zoom = camera?.zoom || 1;
        const timeBucket = Math.floor(performance.now() / refreshMs);
        const graded = this._backdropGraded ? `g${atmosphere.lightGrade?.cacheKey || ''}` : 'f';
        const key = `${canvas.width}x${canvas.height}@${dpr}|${atmosphere.cacheKey}|${graded}|${quantX},${quantY},${zoom}|${timeBucket}`;
        if (this._frameCache && this._frameCacheKey === key) return this._frameCache;

        const width = Math.max(1, Math.round(canvas.width * dpr));
        const height = Math.max(1, Math.round(canvas.height * dpr));
        let frame = this._frameCache;
        if (!frame || frame.width !== width || frame.height !== height) {
            releaseCanvasBackingStore(frame);
            frame = document.createElement('canvas');
            frame.width = width;
            frame.height = height;
            this._frameCache = frame;
        }
        const fctx = frame.getContext('2d');
        fctx.setTransform(1, 0, 0, 1, 0, 0);
        fctx.clearRect(0, 0, width, height);
        fctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        fctx.globalAlpha = 1;
        fctx.globalCompositeOperation = 'source-over';
        fctx.imageSmoothingEnabled = false;
        this._frameHasContent = false;
        this._frameHasContent = this._drawStars(fctx, canvas, atmosphere) || this._frameHasContent;
        this._frameHasContent = this._drawSun(fctx, camera, canvas, atmosphere) || this._frameHasContent;
        this._frameHasContent = this._drawMoon(fctx, canvas, atmosphere) || this._frameHasContent;
        this._frameCacheKey = key;
        return frame;
    }

    // Reduced motion is honored at draw time (a fixed-pose streak on a 3-step
    // envelope) so RM sessions still see the ambient meteor. A shower meteor
    // (5.8) carries its radiant and streaks directly away from it.
    triggerShootingStar({ angle = null, length = null, radiant = null } = {}) {
        if (!SHOOTING_STAR_NIGHT_PHASES.has(this._currentPhase)) return false;
        if (this._shootingStars.length >= SHOOTING_STAR_MAX) return false;
        const resolvedAngle = Number.isFinite(angle)
            ? angle
            : Math.PI / 3 + Math.random() * (Math.PI / 6);
        const resolvedLength = Number.isFinite(length) ? length : 0.18;
        const startXFrac = 0.05 + Math.random() * 0.75;
        // A share of the visible sky band (top of canvas to the sea horizon
        // or the star ceiling, whichever is higher), resolved at draw time,
        // so a meteor always starts in open sky.
        const startSkyFrac = 0.08 + Math.random() * 0.5;
        this._shootingStars.push({
            angle: resolvedAngle,
            lengthFrac: resolvedLength,
            startXFrac,
            startSkyFrac,
            radiant: Array.isArray(radiant) ? radiant : null,
            elapsed: 0,
        });
        return true;
    }

    drawCanopy(ctx, { canvas, camera = null, dt = 16, atmosphere = null, motionScale = null } = {}) {
        if (!canvas) return;
        // motionScale arrives from the frame renderer; fall back to the value
        // tracked by draw(), which runs earlier in the same frame.
        const resolvedMotionScale = Number.isFinite(motionScale) ? motionScale : this._currentMotionScale;
        const source = atmosphere || this._getFallbackAtmosphere(resolvedMotionScale);
        this._currentPhase = source.phase || this._currentPhase;
        this._currentMotionScale = resolvedMotionScale;
        const canopy = this._buildCanopySnapshot(source);
        const height = Math.max(
            CANOPY_MIN_HEIGHT,
            Math.min(CANOPY_MAX_HEIGHT, canvas.height * CANOPY_HEIGHT_FRAC),
        );

        ctx.save();
        ctx.beginPath();
        ctx.rect(0, 0, canvas.width, height);
        ctx.clip();
        ctx.globalCompositeOperation = 'screen';
        // Stars, the sun's glare, the moon and the god rays sit behind the
        // sea: over terrain they keep to the sky above the horizon line.
        this._horizonY = this._horizonScreenY(camera, canvas);
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, 0, canvas.width, Math.max(0, Math.min(height, this._horizonY)));
        ctx.clip();
        this._drawStars(ctx, canvas, canopy);
        this._drawSun(ctx, camera, canvas, canopy, { ensureVisible: true, glowOnly: true });
        this._drawMoon(ctx, canvas, canopy);
        this._drawGodrays(ctx, camera, canvas, canopy, { alphaMul: 0.4 });
        ctx.restore();
        // Ambient meteors ride this canopy pass (which runs after
        // _drawTerrain) so they composite over terrain, clipped to the sky.
        this._drawShootingStars(ctx, canvas, dt, resolvedMotionScale);
        ctx.restore();
    }

    _buildCanopySnapshot(atmosphere) {
        const sky = atmosphere.sky || {};
        const canopy = {
            ...atmosphere,
            sky: {
                ...sky,
                starsAlpha: (sky.starsAlpha || 0) * 0.72,
                sun: sky.sun ? {
                    ...sky.sun,
                    alpha: sky.sun.alpha * 0.34,
                    canopyRescueAlpha: sky.sun.alpha * 0.9,
                } : sky.sun,
                moon: sky.moon ? { ...sky.moon, alpha: sky.moon.alpha * 0.62 } : sky.moon,
            },
        };
        if (canopy.sky.sun) {
            const horizonCut = canopy.sky.sun.yFrac > 0.42 ? 0.58 : 1;
            canopy.sky.sun.alpha *= 0.54 * horizonCut;
        }
        return canopy;
    }

    _normalizeDrawArgs(arg1, arg2, arg3, arg4) {
        if (arg1 && typeof arg1 === 'object' && arg1.canvas) {
            return {
                canvas: arg1.canvas,
                camera: arg1.camera || null,
                dt: Number.isFinite(arg1.dt) ? arg1.dt : 16,
                atmosphere: arg1.atmosphere || null,
                motionScale: Number.isFinite(arg1.motionScale) ? arg1.motionScale : 1,
                backdropGraded: arg1.backdropGraded === true,
                timeMs: Number.isFinite(arg1.timeMs) ? arg1.timeMs : null,
            };
        }
        return {
            camera: arg1 || null,
            canvas: arg2 || null,
            dt: Number.isFinite(arg3) ? arg3 : 16,
            atmosphere: null,
            motionScale: Number.isFinite(arg4) ? arg4 : 1,
            backdropGraded: false,
            timeMs: null,
        };
    }

    _getFallbackAtmosphere(motionScale) {
        if (!this._fallbackAtmosphere) {
            this._fallbackAtmosphere = new AtmosphereState();
        }
        return this._fallbackAtmosphere.update({ motionScale });
    }

    // 1.3 — the sky and void plate. One horizontal band ladder anchored to
    // the sea horizon (the outer ocean's top edge, four tiles above the
    // island's north vertex): zenith → upper → mid → horizon → the C2
    // horizon haze straddling the line, then the void ramp below it (under
    // the outer ocean). Bands step on the art-pixel grid with an ordered dither at
    // each edge. The ladder is baked into a strip 4 cells wide (one Bayer
    // period) and tiled with a `repeat-x` pattern translated to the live
    // horizon, so horizontal pans never rebake it. The ladder spans from the
    // horizon to the top of the frame (bucketed to 32 px, so a vertical pan
    // rebakes at most once per 32 px); it also rebakes when the graded
    // colours, the cell or the viewport height change. A bake is a few
    // thousand texels. Per frame: one zenith fill, one pattern fill, one
    // void fill, together one screen of fill — the same as the old blit.
    _drawPlate(ctx, canvas, camera, atmosphere) {
        const palette = atmosphere.sky?.palette;
        if (!palette) return;
        const zoom = camera?.zoom || 1;
        const cell = Math.max(1, Math.round(zoom));
        const horizonY = this._horizonScreenY(camera, canvas);
        const abovePx = Math.min(8192, Math.max(240, Math.ceil(horizonY / 32) * 32));
        const strip = this._getPlateStrip(canvas, atmosphere, palette, cell, abovePx);
        const stripTop = horizonY - strip._aboveCells * cell;
        const stripBottom = stripTop + strip.height;
        ctx.save();
        ctx.imageSmoothingEnabled = false;
        if (stripTop > 0) {
            ctx.fillStyle = strip._zenith;
            ctx.fillRect(0, 0, canvas.width, Math.min(canvas.height, stripTop));
        }
        const top = Math.max(0, stripTop);
        const bottom = Math.min(canvas.height, stripBottom);
        if (bottom > top) {
            const pattern = ctx.createPattern(strip, 'repeat-x');
            pattern.setTransform?.(new DOMMatrix([1, 0, 0, 1, 0, stripTop]));
            ctx.fillStyle = pattern;
            ctx.fillRect(0, top, canvas.width, bottom - top);
        }
        if (stripBottom < canvas.height) {
            ctx.fillStyle = strip._voidFar;
            ctx.fillRect(0, Math.max(0, stripBottom), canvas.width, canvas.height - Math.max(0, stripBottom));
        }
        ctx.restore();
    }

    _horizonScreenY(camera, canvas) {
        if (!camera?.worldToScreen) return Math.round(canvas.height * 0.62);
        const y = camera.worldToScreen(0, SKY_HORIZON_WORLD_Y).y;
        return Number.isFinite(y) ? Math.round(y) : Math.round(canvas.height * 0.62);
    }

    _getPlateStrip(canvas, atmosphere, palette, cell, abovePx) {
        const graded = this._backdropGraded === true;
        const grade = atmosphere.lightGrade || null;
        const aboveCells = Math.ceil(abovePx / cell);
        const belowCells = Math.ceil(Math.max(240, canvas.height * 0.5) / cell);
        const stops = [
            palette.zenith, palette.upperBand, palette.midBand, palette.horizon,
            palette.haze, palette.voidNear, palette.voidMid, palette.voidFar,
        ];
        const key = `${stops.join(',')}|${graded ? 'g' : `f${grade?.cacheKey || ''}`}|${cell}|${aboveCells}|${belowCells}`;
        if (this.cache && this.cacheKey === key) return this.cache;
        releaseCanvasBackingStore(this.cache);
        // Courses are built in final (graded) colour; each is then painted
        // as-is on the resident path, or as its preimage where the frame is
        // graded afterwards.
        const [zenith, upper, mid, horizon, haze, voidNear, voidMid, voidFar] = stops.map(hexToRgb01);
        // Courses from the top of the strip down. Above the horizon the edges
        // crowd toward the line (perspective); the haze straddles it.
        const ladder = [zenith, upper, mid, horizon, haze];
        const courses = [];
        for (let k = 0; k < SKY_COURSES; k++) {
            const from = Math.pow(1 - k / SKY_COURSES, 1.35);
            const to = Math.pow(1 - (k + 1) / SKY_COURSES, 1.35);
            courses.push({
                rgb: sampleSkyLadder(ladder, k / (SKY_COURSES - 1)),
                start: Math.round(aboveCells * (1 - from)),
                end: Math.round(aboveCells * (1 - to)),
            });
        }
        const hazeBelow = Math.max(3, Math.round(10 / cell));
        const voidNearEnd = aboveCells + hazeBelow + Math.round(belowCells * 0.28);
        const voidMidEnd = aboveCells + hazeBelow + Math.round(belowCells * 0.62);
        courses.push({ rgb: haze, start: courses.at(-1).end, end: aboveCells + hazeBelow });
        courses.push({ rgb: voidNear, start: aboveCells + hazeBelow, end: voidNearEnd });
        courses.push({ rgb: voidMid, start: voidNearEnd, end: voidMidEnd });
        courses.push({ rgb: voidFar, start: voidMidEnd, end: aboveCells + belowCells });
        for (const entry of courses) {
            entry.rgb = graded || !grade ? entry.rgb : ungradeRgb(entry.rgb, grade);
        }
        // Each edge dithers over up to 3 rows either side, fewer where a
        // course near the horizon is thinner than that.
        for (let index = 0; index < courses.length - 1; index++) {
            const a = courses[index];
            const b = courses[index + 1];
            a.edgeHalf = Math.min(3, Math.floor((a.end - a.start) / 2), Math.floor((b.end - b.start) / 2));
        }
        const rows = aboveCells + belowCells;
        const small = document.createElement('canvas');
        small.width = 4;
        small.height = rows;
        const sctx = small.getContext('2d');
        const image = sctx.createImageData(4, rows);
        let course = 0;
        for (let y = 0; y < rows; y++) {
            while (course < courses.length - 1 && y >= courses[course].end) course++;
            const current = courses[course];
            const next = courses[course + 1];
            const previous = courses[course - 1];
            for (let x = 0; x < 4; x++) {
                const order = BAYER4[(y % 4) * 4 + x] / 16;
                let rgb = current.rgb;
                // Ordered dither across each course edge.
                const below = next ? current.edgeHalf : 0;
                const above = previous ? previous.edgeHalf : 0;
                if (below > 0 && y >= current.end - below) {
                    const share = (y - (current.end - below) + 0.5) / (below * 2);
                    if (order < share) rgb = next.rgb;
                } else if (above > 0 && y < current.start + above) {
                    const share = (current.start + above - y - 0.5) / (above * 2);
                    if (order < share) rgb = previous.rgb;
                }
                const offset = (y * 4 + x) * 4;
                image.data[offset] = Math.round(clamp(rgb[0]) * 255);
                image.data[offset + 1] = Math.round(clamp(rgb[1]) * 255);
                image.data[offset + 2] = Math.round(clamp(rgb[2]) * 255);
                image.data[offset + 3] = 255;
            }
        }
        sctx.putImageData(image, 0, 0);
        let strip = small;
        if (cell > 1) {
            strip = document.createElement('canvas');
            strip.width = 4 * cell;
            strip.height = rows * cell;
            const tctx = strip.getContext('2d');
            tctx.imageSmoothingEnabled = false;
            tctx.drawImage(small, 0, 0, strip.width, strip.height);
            releaseCanvasBackingStore(small);
        }
        strip._aboveCells = aboveCells;
        strip._zenith = rgb01Css(courses[0].rgb);
        strip._voidFar = rgb01Css(courses.at(-1).rgb);
        this.cache = strip;
        this.cacheKey = key;
        this.plateBakes = (this.plateBakes || 0) + 1;
        return strip;
    }

    _useFastSkyCache(canvas) {
        const cssPixels = Math.max(1, Number(canvas?.width) || 1) * Math.max(1, Number(canvas?.height) || 1);
        return cssPixels >= FAST_SKY_CSS_PIXELS;
    }

    // The celestial frame is sparse pixel stars, discs and cloud sprites:
    // nothing there has 1px detail worth a 4x backing store. Past
    // FAST_SKY_CSS_PIXELS it stays at CSS resolution and the screen blit
    // stretches it by an integer DPR; below it follows the backing DPR.
    _skyCacheDpr(canvas) {
        const dpr = canvas?._claudeVilleDpr || 1;
        return this._useFastSkyCache(canvas) ? Math.min(dpr, 1) : dpr;
    }

    // 1.3 — pixel-true stars: single CSS pixels on the integer grid, a few
    // hot ones as a four-armed plus; no strokes. Sparse, and only at real
    // night (AtmosphereState keys starsAlpha to the C2 night weight).
    _drawStars(ctx, canvas, atmosphere) {
        const alpha = atmosphere.sky?.starsAlpha ?? 0;
        if (alpha <= 0.01) return false;
        const palette = atmosphere.sky?.palette || {};
        const ceilingY = canvas.height * STAR_CEILING_FRAC;
        const timeOffset = (atmosphere.dayProgress || 0) * canvas.width;
        let seed = 12345;
        const next = () => {
            seed = (seed * 9301 + 49297) % 233280;
            return seed / 233280;
        };

        const starCount = starCountForCanvas(canvas);
        ctx.save();
        for (let i = 0; i < starCount; i++) {
            const xBase = next() * canvas.width;
            const y = Math.round(next() * ceilingY);
            const hot = next() < 0.18;
            const drift = timeOffset * (0.12 + (i % 5) * 0.018);
            const x = Math.round(((xBase + drift) % canvas.width + canvas.width) % canvas.width);
            ctx.globalAlpha = alpha * (hot ? 1 : 0.62);
            ctx.fillStyle = hot ? (palette.starHot || '#f2f7ff') : (palette.starWarm || '#c9ddff');
            ctx.fillRect(x, y, 1, 1);
            if (hot && i % 7 === 0) {
                ctx.globalAlpha = alpha * 0.42;
                ctx.fillRect(x - 1, y, 1, 1);
                ctx.fillRect(x + 1, y, 1, 1);
                ctx.fillRect(x, y - 1, 1, 1);
                ctx.fillRect(x, y + 1, 1, 1);
            }
        }
        this._drawConstellations(ctx, canvas, atmosphere, alpha, palette);
        ctx.restore();
        return true;
    }

    _drawConstellations(ctx, canvas, atmosphere, alpha, palette) {
        const drift = ((atmosphere.dayProgress || 0) * 0.16) % 1;
        ctx.save();
        ctx.globalAlpha = Math.min(0.9, alpha);
        ctx.fillStyle = palette.starHot || '#f2f7ff';
        for (const constellation of CONSTELLATIONS) {
            for (const [px, py] of constellation.points) {
                const x = wrap((constellation.anchor[0] + px + drift) * canvas.width, -24, canvas.width + 24);
                const y = Math.max(4, Math.min(canvas.height * STAR_CEILING_FRAC, (constellation.anchor[1] + py) * canvas.height));
                ctx.fillRect(Math.round(x), Math.round(y), 1, 1);
            }
        }
        ctx.restore();
    }

    _drawSun(ctx, camera, canvas, atmosphere, options = {}) {
        const sun = atmosphere.sky?.sun;
        if (!sun?.visible || sun.alpha <= 0.01) return false;
        const radius = Math.max(22, Math.min(canvas.width, canvas.height) * 0.042);
        const position = this._resolveSunPosition(camera, canvas, sun, radius);
        const { x, y } = position;
        const visibleSun = options.ensureVisible && position.clamped && Number.isFinite(sun.canopyRescueAlpha)
            ? { ...sun, alpha: Math.max(sun.alpha, sun.canopyRescueAlpha) }
            : sun;
        const lighting = atmosphere.lighting || {};
        const warmth = lighting.sunWarmth ?? 0;
        const bloomScale = lighting.sunBloomScale ?? 1;
        const glowRadius = radius * (3.2 + warmth * 2.2) * bloomScale;
        const glowRgb = warmth > 0.05
            ? [255, Math.round(214 - warmth * 50), Math.round(150 - warmth * 60)]
            : [255, 236, 160];

        ctx.save();
        // 1.3 — the glow is a stepped halo (three dithered courses on a 2 px
        // cell), not a smooth radial gradient; the old AA ray strokes are
        // gone.
        ctx.globalCompositeOperation = 'screen';
        ctx.globalAlpha = 1;
        const halo = this._getSteppedGlowStamp(glowRadius, glowRgb, visibleSun.alpha * 0.34);
        ctx.drawImage(halo, Math.round(x - halo.width / 2), Math.round(y - halo.height / 2));

        // The canopy pass composites over the terrain so the sky's glare
        // lands on top of the village. The sun's glow belongs there — it is
        // additive light and reads as glare. Its body does not: it is an
        // opaque `source-over` disc, so drawing it in that pass plants a
        // solid ball on whatever happens to be underneath, which at close zoom
        // reads as a sticker lying on the ocean. The backdrop pass still draws
        // the full disc behind the world, so the sun is crisp wherever sky is
        // actually visible.
        if (options.glowOnly) {
            ctx.restore();
            return true;
        }

        // 0.10 — the body is the baked flat-to-core stepped disc (no outline,
        // no specular dot); the horizon squash is baked into its rows, so it
        // is never scaled off the pixel grid.
        ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = visibleSun.alpha;
        ctx.imageSmoothingEnabled = false;
        const stamp = this._getSunStamp(radius, warmth, visibleSun.squashY ?? 1);
        ctx.drawImage(stamp, Math.round(x - stamp.width / 2), Math.round(y - stamp.height / 2));
        ctx.restore();
        return true;
    }

    // 1.3 — a stepped halo for the sun and moon: three flat courses (alpha
    // 1, 0.5, 0.2 of `alpha`) on a 2 px cell with a 4x4 ordered dither only in
    // a two-cell band at each seam (a wider dither reads as a smooth radial
    // glow at 1:1), cached per (radius, colour, alpha) bucket. Replaces the
    // smooth full-screen radial gradients.
    _getSteppedGlowStamp(radius, rgb, alpha) {
        const cell = SUN_STAMP_CELL_PX;
        const r = Math.max(cell * 4, Math.round(radius / cell) * cell);
        const alphaBucket = Math.round(clamp(alpha) * 32);
        const key = `${r}|${rgb.join(',')}|${alphaBucket}`;
        const cache = (this._glowStamps ||= new Map());
        const hit = cache.get(key);
        if (hit) return hit;
        if (cache.size >= 6) {
            const [oldKey, oldCanvas] = cache.entries().next().value;
            releaseCanvasBackingStore(oldCanvas);
            cache.delete(oldKey);
        }
        const cells = Math.ceil((r * 2) / cell);
        const small = document.createElement('canvas');
        small.width = cells;
        small.height = cells;
        const sctx = small.getContext('2d');
        const image = sctx.createImageData(cells, cells);
        const centre = cells / 2;
        const base = alphaBucket / 32;
        // Course index per cell is 3 / centre: two cells of seam.
        const seam = Math.min(0.6, 6 / centre);
        for (let y = 0; y < cells; y++) {
            for (let x = 0; x < cells; x++) {
                const d = Math.hypot(x + 0.5 - centre, y + 0.5 - centre) / centre;
                if (d >= 1) continue;
                const q = (1 - d) * 3 + (BAYER4[(y % 4) * 4 + (x % 4)] / 16 - 0.5) * seam;
                const course = q >= 2 ? 1 : q >= 1 ? 0.5 : q >= 0.1 ? 0.2 : 0;
                if (course <= 0) continue;
                const offset = (y * cells + x) * 4;
                image.data[offset] = rgb[0];
                image.data[offset + 1] = rgb[1];
                image.data[offset + 2] = rgb[2];
                image.data[offset + 3] = Math.round(clamp(base * course) * 255);
            }
        }
        sctx.putImageData(image, 0, 0);
        const stamp = document.createElement('canvas');
        stamp.width = cells * cell;
        stamp.height = cells * cell;
        const tctx = stamp.getContext('2d');
        tctx.imageSmoothingEnabled = false;
        tctx.drawImage(small, 0, 0, stamp.width, stamp.height);
        releaseCanvasBackingStore(small);
        cache.set(key, stamp);
        return stamp;
    }

    // 0.10 — the sun body: three flat courses on a 2 px cell (body, a lighter
    // mid course inside 0.66 r, a pale core inside 0.34 r) with a 4x4 ordered
    // dither only in a narrow band at each seam, a stair-stepped edge and no
    // outline. The horizon squash sets the baked row radius. Single-slot
    // cache; radius, warmth and squash move slowly, so rebuilds are rare.
    _getSunStamp(radius, warmth = 0, squash = 1) {
        const cell = SUN_STAMP_CELL_PX;
        const r = Math.max(8, Math.round(radius / cell) * cell);
        const courses = warmth > 0.05 ? SUN_COURSES.warm : SUN_COURSES.day;
        const squashCells = Math.max(0.5, Math.round(clamp(squash, 0.5, 1) * 16) / 16);
        const key = `${r}|${courses === SUN_COURSES.warm ? 'w' : 'd'}|${squashCells}`;
        if (this._sunStamp?.key === key) return this._sunStamp.canvas;
        releaseCanvasBackingStore(this._sunStamp?.canvas);
        const cellsX = Math.ceil((r * 2) / cell) + 2;
        const cellsY = Math.ceil((r * 2 * squashCells) / cell) + 2;
        const off = document.createElement('canvas');
        off.width = cellsX * cell;
        off.height = cellsY * cell;
        const o = off.getContext('2d');
        const cx0 = cellsX / 2;
        const cy0 = cellsY / 2;
        const rc = r / cell;
        for (let gy = 0; gy < cellsY; gy++) {
            for (let gx = 0; gx < cellsX; gx++) {
                const dx = (gx + 0.5 - cx0) / rc;
                const dy = (gy + 0.5 - cy0) / (rc * squashCells);
                const d = Math.hypot(dx, dy);
                if (d > 1) continue;
                const order = (BAYER4[(gy % 4) * 4 + (gx % 4)] / 16 - 0.5) * 0.08;
                const q = d + order;
                o.fillStyle = q < 0.34 ? courses[2] : q < 0.66 ? courses[1] : courses[0];
                o.fillRect(gx * cell, gy * cell, cell, cell);
            }
        }
        this._sunStamp = { key, canvas: off };
        return off;
    }

    _drawGodrays(ctx, camera, canvas, atmosphere, options = {}) {
        const sun = atmosphere.sky?.sun;
        const lighting = atmosphere.lighting || {};
        const warmth = lighting.sunWarmth ?? 0;
        if (!sun?.visible) return;
        // Loosened from 0.18 so rays break through on a clearing transition
        // (the warm-up before dawn/after dusk), but only under clear-enough sky.
        const cloudCover = clamp(atmosphere.weather?.cloudCover ?? 0, 0, 1);
        const warmthGate = cloudCover > GODRAY_CLOUD_COVER_MAX ? 0.18 : 0.08;
        if (warmth <= warmthGate) return;
        if ((sun.alpha ?? 0) <= 0.04) return;

        const radius = Math.max(22, Math.min(canvas.width, canvas.height) * 0.042);
        const position = this._resolveSunPosition(camera, canvas, sun, radius);
        if (!Number.isFinite(position.x) || !Number.isFinite(position.y)) return;
        const { x, y } = position;

        const alphaMul = Number.isFinite(options.alphaMul) ? options.alphaMul : 1;
        const baseAlpha = 0.10 * warmth * (sun.alpha ?? 0) * alphaMul;
        if (baseAlpha <= 0.002) return;

        const rayCount = 7;
        const spreadRad = 25 * Math.PI / 180;
        const length = Math.hypot(canvas.width, canvas.height) * 1.1;
        const halfWidth = Math.max(8, radius * 0.42);

        ctx.save();
        ctx.globalCompositeOperation = 'screen';
        for (let i = 0; i < rayCount; i++) {
            const t = rayCount === 1 ? 0 : (i / (rayCount - 1)) * 2 - 1;
            const angle = Math.PI / 2 + t * spreadRad;
            const dx = Math.cos(angle);
            const dy = Math.sin(angle);
            const fx = x + dx * length;
            const fy = y + dy * length;
            const px = -dy * halfWidth;
            const py = dx * halfWidth;
            const widthBoost = 1 + (1 - Math.abs(t)) * 0.35;
            const rayAlpha = baseAlpha * (0.78 + (1 - Math.abs(t)) * 0.22);

            const grad = ctx.createLinearGradient(x, y, fx, fy);
            grad.addColorStop(0, `rgba(255, 226, 168, ${rayAlpha})`);
            grad.addColorStop(0.45, `rgba(255, 206, 138, ${rayAlpha * 0.45})`);
            grad.addColorStop(1, 'rgba(255, 198, 124, 0)');

            ctx.fillStyle = grad;
            ctx.beginPath();
            ctx.moveTo(x - px * 0.45 * widthBoost, y - py * 0.45 * widthBoost);
            ctx.lineTo(x + px * 0.45 * widthBoost, y + py * 0.45 * widthBoost);
            ctx.lineTo(fx + px * widthBoost, fy + py * widthBoost);
            ctx.lineTo(fx - px * widthBoost, fy - py * widthBoost);
            ctx.closePath();
            ctx.fill();
        }
        ctx.restore();
    }

    // Where the day path would carry the sun below the sea horizon (or the
    // horizon is above the frame), it holds its disc above the horizon line;
    // off the top of the frame it simply is not in view.
    _resolveSunPosition(camera, canvas, sun, radius) {
        const x = canvas.width * sun.xFrac;
        const skyY = canvas.height * sun.yFrac;
        const limit = this._horizonScreenY(camera, canvas) - radius * SUN_HORIZON_CLEARANCE_RADIUS;
        return {
            x,
            y: Math.min(skyY, limit),
            clamped: skyY > limit,
        };
    }

    // `body` with its yFrac lifted so a disc of `radius` sits above the
    // horizon recorded for this pass (unchanged when none is known).
    _holdAboveHorizon(canvas, body, radius) {
        if (!Number.isFinite(this._horizonY) || !(canvas.height > 0)) return body;
        const limit = this._horizonY - radius * SUN_HORIZON_CLEARANCE_RADIUS;
        return canvas.height * body.yFrac > limit ? { ...body, yFrac: limit / canvas.height } : body;
    }

    _drawMoon(ctx, canvas, atmosphere) {
        const skyMoon = atmosphere.sky?.moon;
        if (!skyMoon?.visible || skyMoon.alpha <= 0.01) return false;
        // Like the sun, the moon holds its disc above the sea horizon.
        const moon = this._holdAboveHorizon(canvas, skyMoon, Math.max(MOON_DISC_RADIUS, Math.min(canvas.width, canvas.height) * 0.026));
        const phaseName = moon.phase?.phaseName || 'crescent';
        const illumination = clamp(moon.phase?.illumination ?? 0.24, 0, 1);
        const authoredPhase = phaseName === 'first-quarter' || phaseName === 'last-quarter'
            ? 'half'
            : phaseName === 'waxing-gibbous' || phaseName === 'waning-gibbous' || phaseName === 'full'
                ? 'gibbous'
                : phaseName;
        const authoredPhaseId = MOON_PHASE_ASSETS[authoredPhase];
        const id = this._firstAvailable([
            authoredPhaseId,
            phaseName === 'crescent' ? atmosphere.sky?.assetIds?.moon : null,
            authoredPhase === 'crescent' ? FALLBACK_MOON_ID : null,
        ]);
        const shouldUseAuthoredMoon = id
            && (
                (authoredPhase === 'crescent' && illumination > 0.10 && illumination < 0.31)
                || ((authoredPhase === 'half' || authoredPhase === 'gibbous') && id === authoredPhaseId)
            );
        if (shouldUseAuthoredMoon) {
            const img = this.assets.get(id);
            const dims = this.assets.getDims(id);
            const x = canvas.width * moon.xFrac - dims.w / 2;
            const y = canvas.height * moon.yFrac - dims.h / 2;
            ctx.save();
            ctx.globalAlpha = moon.alpha;
            this._drawMoonGlow(ctx, canvas, moon, atmosphere);
            const squashY = moon.squashY ?? 1;
            if (squashY < 0.99) {
                ctx.translate(canvas.width * moon.xFrac, canvas.height * moon.yFrac);
                ctx.scale(1, squashY);
                ctx.drawImage(img, Math.round(-dims.w / 2), Math.round(-dims.h / 2));
            } else {
                ctx.drawImage(img, Math.round(x), Math.round(y));
            }
            ctx.restore();
            return true;
        }
        this._drawCodeMoon(ctx, canvas, moon, atmosphere);
        return true;
    }

    // Drawn under the caller's moon alpha: a stepped halo, not a gradient.
    _drawMoonGlow(ctx, canvas, moon, atmosphere = null) {
        const x = canvas.width * moon.xFrac;
        const y = canvas.height * moon.yFrac;
        const radius = Math.max(42, Math.min(canvas.width, canvas.height) * 0.10);
        const corona = clamp(atmosphere?.lighting?.beaconIntensity ?? 0.5, 0, 1);
        const halo = this._getSteppedGlowStamp(radius, [176, 208, 255], 0.12 + corona * 0.06);
        ctx.save();
        ctx.globalCompositeOperation = 'screen';
        ctx.drawImage(halo, Math.round(x - halo.width / 2), Math.round(y - halo.height / 2));
        ctx.restore();
    }

    _drawCodeMoon(ctx, canvas, moon, atmosphere = null) {
        const x = canvas.width * moon.xFrac;
        const y = canvas.height * moon.yFrac;
        const r = Math.max(14, Math.min(canvas.width, canvas.height) * 0.026);
        const squashY = moon.squashY ?? 1;
        const phase = moon.phase || { phaseName: 'crescent', illumination: 0.24, waxing: false };
        const illumination = clamp(phase.illumination ?? 0.24, 0, 1);
        const litWidth = r * (0.22 + illumination * 1.46);
        const shadowOffset = phase.phaseName === 'new'
            ? 0
            : (phase.waxing ? -1 : 1) * r * (0.92 - illumination * 0.84);
        ctx.save();
        ctx.globalAlpha = moon.alpha;
        this._drawMoonGlow(ctx, canvas, { ...moon, alpha: moon.alpha * (0.25 + illumination * 0.75) }, atmosphere);
        ctx.translate(x, y);
        ctx.scale(1, squashY);
        ctx.fillStyle = '#cfe4ff';
        ctx.beginPath();
        ctx.arc(0, 0, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.clip();
        if (phase.phaseName === 'new') {
            ctx.fillStyle = 'rgba(8, 18, 34, 0.76)';
            ctx.fillRect(-r - 2, -r - 2, r * 2 + 4, r * 2 + 4);
            ctx.strokeStyle = 'rgba(190, 216, 255, 0.36)';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.arc(0, 0, r - 1, 0, Math.PI * 2);
            ctx.stroke();
        } else {
            ctx.globalCompositeOperation = 'source-atop';
            const shadow = ctx.createRadialGradient(shadowOffset, -r * 0.08, r * 0.12, shadowOffset, 0, r * 1.34);
            shadow.addColorStop(0, 'rgba(20, 36, 58, 0.05)');
            shadow.addColorStop(0.52, 'rgba(14, 26, 44, 0.28)');
            shadow.addColorStop(1, 'rgba(4, 12, 24, 0.82)');
            ctx.fillStyle = shadow;
            const shadowX = phase.waxing ? -r - litWidth * 0.38 : litWidth * 0.38;
            ctx.fillRect(shadowX, -r - 2, r * 2.4, r * 2 + 4);
            ctx.globalCompositeOperation = 'screen';
            ctx.fillStyle = `rgba(238, 247, 255, ${0.06 + illumination * 0.08})`;
            ctx.beginPath();
            ctx.ellipse((phase.waxing ? 1 : -1) * r * 0.12, -r * 0.18, litWidth * 0.32, r * 0.22, -0.24, 0, Math.PI * 2);
            ctx.fill();
        }
        ctx.restore();
    }

    // 5.7 — the horizon cloud deck. Three strips baked once per bucket (cell,
    // cloud-cover tenth, sun side, the day's seed and the stepped colour
    // set) and drawn every frame as whole-cell offsets: parallax 0.02 /
    // 0.05 / 0.09 of the camera pan plus the same C-W3 drift integrator the
    // cloud-shadow courses ride (`cloudCourseDrift`), which holds under
    // reduced motion so the deck moves only when the operator pans. Clipped
    // to the sky above the sea horizon.
    _drawHorizonDeck(ctx, camera, canvas, atmosphere, timeMs) {
        const horizonY = this._horizonY;
        if (!(horizonY > 0)) return false;
        const coverage = clamp(atmosphere.weather?.cloudCover ?? 0);
        if (coverage < 0.04) return false;
        const zoom = camera?.zoom || 1;
        const cell = Math.max(1, Math.round(zoom));
        const band = Math.max(96, Math.round(horizonY / DECK_BAND_BUCKET_PX) * DECK_BAND_BUCKET_PX);
        const colors = this._deckColors(atmosphere);
        const sun = atmosphere.sky?.sun;
        const rimSide = sun?.visible ? (sun.xFrac < 0.4 ? -1 : sun.xFrac > 0.6 ? 1 : 0) : 0;
        const seed = hashString(`${atmosphere.clock?.localDate || ''}|deck`);
        const coverBucket = Math.round(coverage * 10);
        const key = `${cell}|${band}|${coverBucket}|${rimSide}|${seed}|${colors.map(rgb01Css).join(',')}`;
        if (!this._deck || this._deckKey !== key) {
            for (const strip of this._deck || []) releaseCanvasBackingStore(strip);
            this._deck = DECK_STRIPS.map(strip => bakeDeckStrip(strip, {
                coverage: coverBucket / 10,
                seed,
                colors,
                cell,
                band,
                rimSide,
            }));
            this._deckKey = key;
            this.deckBakes += 1;
        }
        const drift = cloudCourseDrift(timeMs, atmosphere.weather).x;
        const camX = camera?.x || 0;
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, 0, canvas.width, horizonY);
        ctx.clip();
        ctx.imageSmoothingEnabled = false;
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = 'source-over';
        DECK_STRIPS.forEach((strip, index) => {
            const baked = this._deck[index];
            const lift = Math.round((strip.f * horizonY) / cell) * cell;
            const y = horizonY - lift - baked.height;
            const shift = Math.round(((drift - camX) * strip.parallax * zoom) / cell) * cell;
            const period = baked.width;
            for (let x = ((shift % period) + period) % period - period; x < canvas.width; x += period) {
                ctx.drawImage(baked, x, y);
            }
        });
        ctx.restore();
        return true;
    }

    // The deck's [rim, body, underside] in final colour: the dusk set while
    // the sun is warm, else the noon set, one tone down under a heavy sky,
    // moonlit through the C2 grade at night and never brighter than a step
    // above the plate's horizon band (blue hour keeps dim silhouettes).
    // Painted as the preimage where the frame is graded afterwards.
    _deckColors(atmosphere) {
        const grade = atmosphere.lightGrade || null;
        const warmth = clamp(atmosphere.lighting?.sunWarmth ?? 0);
        const lowSun = atmosphere.phase === 'dawn' || atmosphere.phase === 'dusk' || warmth >= 0.3;
        let set = (lowSun ? DECK_DUSK : DECK_NOON).map(hexToRgb01);
        if (DECK_HEAVY_WEATHER.has(atmosphere.weather?.type)) {
            set = [set[1], set[2], set[2].map(channel => channel * 0.8)];
        }
        // Never brighter than a step above the plate's horizon band (at night
        // a dim moonlit silhouette, in blue hour a dim one; a noon sky lets
        // the full set through).
        const night = grade ? clamp(grade.night ?? 0) : 0;
        if (night >= 0.5) set = set.map(rgb => applyGradeToRgb(rgb, grade).map(channel => clamp(channel)));
        const horizon = hexToRgb01(atmosphere.sky?.palette?.horizon || '#c8d4dc');
        const ceiling = lumaOf(horizon) + (night >= 0.5 ? 0.07 : 0.2);
        const k = Math.min(1, ceiling / Math.max(1e-3, lumaOf(set[0])));
        if (k < 1) set = set.map(rgb => rgb.map(channel => channel * k));
        const quantize = (rgb) => rgb.map(channel => Math.round(clamp(channel) * 255) / 255);
        if (!this._backdropGraded && grade) set = set.map(rgb => ungradeRgb(rgb, grade));
        return set.map(quantize);
    }

    // 5.8 — a stepped rainbow opposite the sun for the 20 minutes after the
    // village's own timeline goes from rain to clearing, while the sun is
    // up and below 42°. The arc's centre is the antisolar point (below the
    // horizon by the sun's elevation) and only the part above the sea
    // horizon is drawn. It fades in and out in three alpha quanta; reduced
    // motion holds the middle quantum for the whole window.
    _drawRainbow(ctx, canvas, atmosphere, motionScale) {
        const horizonY = this._horizonY;
        const sun = atmosphere.sky?.sun;
        if (!(horizonY > 0) || !sun?.visible) return false;
        const elevation = Number(sun.elevationDeg);
        if (!(elevation >= 0 && elevation < RAINBOW_MAX_SUN_ELEVATION_DEG)) return false;
        const date = atmosphere.effectiveDate;
        if (!(date instanceof Date)) return false;
        const since = rainClearedMinutesAgo(date, groundOptionsFor(atmosphere));
        if (since == null) return false;
        const quanta = motionScale === 0
            ? 2
            : since < 2 || since >= 18 ? 1 : since < 4 || since >= 16 ? 2 : 3;
        const cell = RAINBOW_CELL_PX;
        const radius = Math.round(clamp(canvas.width * 0.2, 160, 520) / cell) * cell;
        const grade = atmosphere.lightGrade || null;
        const colors = RAINBOW_BANDS.map(hexToRgb01)
            .map(rgb => (!this._backdropGraded && grade ? ungradeRgb(rgb, grade) : rgb));
        const key = `${radius}|${colors.map(rgb01Css).join(',')}`;
        if (!this._rainbowStamp || this._rainbowStamp.key !== key) {
            releaseCanvasBackingStore(this._rainbowStamp?.canvas);
            this._rainbowStamp = { key, canvas: bakeRainbowStamp(radius, cell, colors) };
        }
        const pxPerDegree = radius / 42;
        const cx = Math.round(((1 - sun.xFrac) * canvas.width) / cell) * cell;
        const cy = horizonY + Math.round((elevation * pxPerDegree) / cell) * cell;
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, 0, canvas.width, horizonY);
        ctx.clip();
        ctx.imageSmoothingEnabled = false;
        ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = RAINBOW_MAX_ALPHA * quanta / 3;
        ctx.drawImage(this._rainbowStamp.canvas, cx - radius, cy - radius);
        ctx.restore();
        return true;
    }

    // W8.8 — three aurora ribbons in the sky band above the sea horizon, on
    // a whole cell (the largest of 1–2 that keeps a ribbon inside 80 % of
    // the band) at whole-cell positions, clipped to the sky; nothing when
    // even a 1-cell ribbon overflows that share. The phase strips are
    // recoloured to the capped courses (the preimage where the frame is
    // graded afterwards) and held until the colour set changes.
    _drawAurora(ctx, canvas, atmosphere, motionScale, timeMs) {
        const horizonY = this._horizonY;
        if (!(horizonY > 0) || !this.assets || !auroraGateOpen(atmosphere)) return false;
        const stamps = this._auroraStamps(atmosphere);
        if (!stamps) return false;
        const { width, height } = stamps[0];
        const fit = Math.floor((horizonY * AURORA_BAND_SHARE) / height);
        if (fit < 1) return false;
        const cell = Math.min(AURORA_MAX_CELL, fit);
        const drawWidth = width * cell;
        const drawHeight = height * cell;
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, 0, canvas.width, horizonY);
        ctx.clip();
        ctx.imageSmoothingEnabled = false;
        ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = AURORA_ALPHA;
        AURORA_RIBBONS.forEach((ribbon, index) => {
            const stamp = stamps[auroraPhaseIndex(index, timeMs, motionScale)];
            const x = Math.round((ribbon.xFrac * canvas.width - drawWidth / 2) / cell) * cell;
            const y = Math.round((horizonY - ribbon.lift * horizonY - drawHeight) / cell) * cell;
            ctx.drawImage(stamp, x, y, drawWidth, drawHeight);
        });
        ctx.restore();
        return true;
    }

    _auroraStamps(atmosphere) {
        if (!AURORA_IDS.every(id => this.assets.has(id))) return null;
        const grade = atmosphere.lightGrade || null;
        const colors = AURORA_COURSES.map(hexToRgb01)
            .map(rgb => (!this._backdropGraded && grade ? ungradeRgb(rgb, grade) : rgb))
            .map(rgb => rgb.map(channel => Math.round(clamp(channel) * 255)));
        const key = colors.map(rgb => rgb.join(',')).join('|');
        if (this._aurora?.key === key) return this._aurora.stamps;
        const images = AURORA_IDS.map(id => this.assets.get(id));
        if (!images.every(img => img?.width > 0 && img?.height > 0)) return null;
        this._releaseAurora();
        const lookup = new Map(AURORA_SOURCE.map((hex, index) => [
            hexToRgb01(hex).map(channel => Math.round(channel * 255)).join(','),
            colors[index],
        ]));
        const stamps = images.map((img) => {
            const stamp = document.createElement('canvas');
            stamp.width = img.width;
            stamp.height = img.height;
            const sctx = stamp.getContext('2d', { willReadFrequently: true });
            sctx.drawImage(img, 0, 0);
            const pixels = sctx.getImageData(0, 0, stamp.width, stamp.height);
            const data = pixels.data;
            for (let i = 0; i < data.length; i += 4) {
                if (data[i + 3] === 0) continue;
                const rgb = lookup.get(`${data[i]},${data[i + 1]},${data[i + 2]}`);
                if (!rgb) continue;
                data[i] = rgb[0];
                data[i + 1] = rgb[1];
                data[i + 2] = rgb[2];
            }
            sctx.putImageData(pixels, 0, 0);
            return stamp;
        });
        this._aurora = { key, stamps };
        return stamps;
    }

    _releaseAurora() {
        for (const stamp of this._aurora?.stamps || []) releaseCanvasBackingStore(stamp);
        this._aurora = null;
    }

    // Live star twinkle over the cached night sky. Walks the same deterministic
    // PRNG as _drawStars (same seed / next() sequence / hot test / drift) so the
    // first LIVE_TWINKLE_STARS hot stars land exactly on their baked positions,
    // then overdraws them with a staggered sinusoidal alpha. Pulse cadence is a
    // local sine, matching the ambient meteor's live layer (no shared
    // PulsePolicy). Skipped under reduced motion or when the sky has no stars.
    _drawLiveStarTwinkle(ctx, canvas, atmosphere, motionScale = 1) {
        if (motionScale === 0) return;
        const twinkle = liveTwinkleBudget({
            calm: resolveCalmGate(),
            motionScale,
        });
        if (twinkle.count <= 0) return;
        const starsAlpha = atmosphere.sky?.starsAlpha ?? 0;
        if (starsAlpha <= 0.01) return;
        const palette = atmosphere.sky?.palette || {};
        const ceilingY = canvas.height * STAR_CEILING_FRAC;
        const timeOffset = (atmosphere.dayProgress || 0) * canvas.width;
        const time = performance.now() * 0.001;
        let seed = 12345;
        const next = () => {
            seed = (seed * 9301 + 49297) % 233280;
            return seed / 233280;
        };

        const starCount = starCountForCanvas(canvas);
        ctx.save();
        ctx.fillStyle = palette.starHot || '#f2f7ff';
        let drawn = 0;
        for (let i = 0; i < starCount && drawn < twinkle.count; i++) {
            const xBase = next() * canvas.width;
            const y = Math.round(next() * ceilingY);
            const hot = next() < 0.18;
            if (!hot) continue;
            const drift = timeOffset * (0.12 + (i % 5) * 0.018);
            const x = Math.round(((xBase + drift) % canvas.width + canvas.width) % canvas.width);
            const rate = (1.6 + (i % 4) * 0.55) * twinkle.rateScale;
            const phase = i * 1.7;
            const pulse = 0.4 + 0.6 * Math.sin(time * rate + phase);
            ctx.globalAlpha = clamp(starsAlpha * pulse, 0, 1);
            ctx.fillRect(x, y, 1, 1);
            drawn++;
        }
        ctx.restore();
    }

    // 5.8 — meteors on the cell grid: the streak is walked in whole
    // METEOR_CELL_PX cells from the head back along its path, the head cell
    // brightest and the trail in two dimmer courses; the life envelope steps
    // in thirds. A shower meteor's direction points away from its radiant.
    _drawShootingStars(ctx, canvas, dt, motionScale) {
        if (!this._shootingStars.length) return;
        // The sky band a meteor lives in: above the sea horizon and the star
        // ceiling; cells below it are never drawn.
        const horizonY = Number.isFinite(this._horizonY) ? this._horizonY : Infinity;
        const skyBottom = Math.max(0, Math.min(canvas.height * STAR_CEILING_FRAC, horizonY));
        if (!(skyBottom > METEOR_CELL_PX * 4)) {
            this._shootingStars = this._shootingStars.filter((star) => (star.elapsed += dt) < SHOOTING_STAR_DURATION_MS);
            return;
        }
        const cell = METEOR_CELL_PX;
        const next = [];
        ctx.save();
        ctx.globalCompositeOperation = 'screen';
        for (const star of this._shootingStars) {
            star.elapsed += dt;
            const t = star.elapsed / SHOOTING_STAR_DURATION_MS;
            if (t >= 1) continue;
            // Reduced motion: the streak holds a fixed mid-flight pose and
            // steps its alpha (3-step envelope) instead of traveling.
            const envelope = motionScale === 0
                ? rmThreeStepEnvelope(t) * 0.9
                : t < 0.18 ? t / 0.18 : 1 - (t - 0.18) / 0.82;
            const alpha = Math.ceil(clamp(envelope) * 3) / 3;
            if (alpha <= 0) {
                next.push(star);
                continue;
            }
            const length = canvas.width * star.lengthFrac;
            const x0 = canvas.width * star.startXFrac;
            const y0 = skyBottom * star.startSkyFrac;
            let dx = Math.cos(star.angle);
            let dy = Math.sin(star.angle);
            if (star.radiant) {
                const rx = x0 - canvas.width * star.radiant[0];
                const ry = y0 - canvas.height * star.radiant[1];
                const norm = Math.hypot(rx, ry) || 1;
                dx = rx / norm;
                dy = ry / norm;
            }
            const headProgress = motionScale === 0 ? 0.62 : 0.2 + t * 0.8;
            const hx = x0 + dx * length * headProgress;
            const hy = y0 + dy * length * headProgress;
            const trailCells = Math.max(3, Math.round((length * 0.55) / cell));
            let lastX = NaN;
            let lastY = NaN;
            for (let i = trailCells; i >= 0; i--) {
                const gx = Math.floor((hx - dx * i * cell) / cell) * cell;
                const gy = Math.floor((hy - dy * i * cell) / cell) * cell;
                if (gx === lastX && gy === lastY) continue;
                if (gy + cell > skyBottom) continue;
                lastX = gx;
                lastY = gy;
                const course = METEOR_COURSES[i === 0 ? 0 : i <= trailCells / 3 ? 1 : 2];
                ctx.globalAlpha = alpha * course.alpha;
                ctx.fillStyle = course.rgb;
                ctx.fillRect(gx, gy, cell, cell);
            }
            next.push(star);
        }
        ctx.restore();
        this._shootingStars = next;
    }

    // 5.2 / 5.8 — ambient clear-night meteors: one every ~90–180 s while the
    // starfield is actually visible (at most SHOOTING_STAR_MAX in flight),
    // every 20–70 s within a day of a meteor-shower peak (IMO calendar),
    // then from the shower's radiant. The first eligible clear night only
    // arms the timer — no boot-time meteor. The sky answers to no agent
    // event (V3).
    _maybeTriggerAmbientMeteor(atmosphere) {
        if (!allowAmbientMeteor({ motionScale: this._currentMotionScale })) return;
        if (!SHOOTING_STAR_NIGHT_PHASES.has(this._currentPhase)) return;
        if ((atmosphere.sky?.starsAlpha ?? 0) < AMBIENT_METEOR_MIN_STARS_ALPHA) return;
        if (this._currentCloudCover > AMBIENT_METEOR_MAX_CLOUD_COVER) return;
        const shower = meteorShowerFor(atmosphere.effectiveDate);
        const minMs = shower ? SHOWER_METEOR_MIN_MS : AMBIENT_METEOR_MIN_MS;
        const spanMs = shower ? SHOWER_METEOR_SPAN_MS : AMBIENT_METEOR_SPAN_MS;
        const now = Date.now();
        if (!this._nextAmbientMeteorAt || this._nextAmbientMeteorAt - now > minMs + spanMs) {
            this._nextAmbientMeteorAt = now + minMs + Math.random() * spanMs;
            return;
        }
        if (now < this._nextAmbientMeteorAt) return;
        this._nextAmbientMeteorAt = now + minMs + Math.random() * spanMs;
        const angle = Math.PI / 3 + Math.random() * (Math.PI / 6);
        const length = 0.12 + Math.random() * 0.10;
        this.triggerShootingStar({ angle, length, radiant: shower ? shower.radiant : null });
    }

    _firstAvailable(ids) {
        if (!this.assets) return null;
        for (const id of ids) {
            if (id && this.assets.has(id)) return id;
        }
        return null;
    }

    // Drop the cached plate strip, celestial frame and stamps. Used by
    // viewport/resize cache invalidation paths; ambient meteors in flight
    // survive it.
    releaseCache() {
        releaseCanvasBackingStore(this.cache);
        this.cache = null;
        this.cacheKey = '';
        releaseCanvasBackingStore(this._frameCache);
        this._frameCache = null;
        this._frameCacheKey = '';
        releaseCanvasBackingStore(this._sunStamp?.canvas);
        this._sunStamp = null;
        for (const stamp of this._glowStamps?.values() || []) releaseCanvasBackingStore(stamp);
        this._glowStamps?.clear();
        for (const strip of this._deck || []) releaseCanvasBackingStore(strip);
        this._deck = null;
        this._deckKey = '';
        releaseCanvasBackingStore(this._rainbowStamp?.canvas);
        this._rainbowStamp = null;
        this._releaseAurora();
    }

    dispose() {
        this.releaseCache();
        this._shootingStars.length = 0;
        this._nextAmbientMeteorAt = 0;
        this._fallbackAtmosphere?.dispose?.();
        this._fallbackAtmosphere = null;
    }

    getCanvasBudget() {
        return {
            volatilePixels: canvasPixelCount(this.cache) + canvasPixelCount(this._frameCache),
            cacheKey: this.cacheKey,
        };
    }
}

function clamp(value, min = 0, max = 1) {
    return Math.max(min, Math.min(max, value));
}

function hexToRgb01(hex) {
    const value = String(hex || '#000000').replace('#', '').padEnd(6, '0').slice(0, 6);
    return [0, 2, 4].map(index => parseInt(value.slice(index, index + 2), 16) / 255);
}

function rgb01Css(rgb) {
    return `rgb(${rgb.map(channel => Math.round(clamp(channel) * 255)).join(', ')})`;
}

// 1.3 — sparse: 48 stars per 1280×720 of sky, clamped to 40–140.
// Used by both _drawStars (baked) and _drawLiveStarTwinkle (live) so the two
// PRNG walks stay in lockstep on any viewport.
function starCountForCanvas(canvas) {
    const area = Math.max(1, (Number(canvas?.width) || 0) * (Number(canvas?.height) || 0));
    return Math.max(
        STAR_MIN_COUNT,
        Math.min(STAR_MAX_COUNT, Math.round((STAR_BASE_COUNT * area) / STAR_BASE_AREA)),
    );
}

// 5.6 — reduced-motion envelope for an ambient meteor: three static alpha
// steps (step-in → hold → step-out) across its normal duration, so RM
// sessions still see it without continuous per-frame interpolation.
// t is normalized 0..1.
function rmThreeStepEnvelope(t) {
    if (t < 0.25) return 0.55;
    if (t < 0.75) return 1;
    return 0.4;
}

function wrap(value, min, max) {
    const range = max - min;
    if (!Number.isFinite(range) || range <= 0) return min;
    return ((value - min) % range + range) % range + min;
}

function lumaOf(rgb) {
    return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
}

// 5.7 — one deck strip: a periodic row of cumulus clouds, one texel per
// cell, then scaled to the cell with nearest sampling. Each cloud is a
// cluster of 2–4 stepped half-ellipse puffs (the tallest in the middle) on a
// flat base; clouds gather where a periodic clump field allows, so a partly
// cloudy sky keeps open gaps, and a covered sky adds a continuous stratus
// floor. Colours per cell: the top of each column and any edge facing the
// sun take the rim, edges facing away and the bottom rows the underside (a
// 4x4 Bayer seam between body and underside), everything else the body.
// `rimSide`: −1 sun left, 1 right, 0 high or absent (every top rims).
function bakeDeckStrip(strip, { coverage, seed, colors, cell, band, rimSide }) {
    const W = Math.round(DECK_PERIOD_PX / cell);
    const H = Math.max(4, Math.round((strip.height * band) / cell));
    const radiusMin = Math.max(2, (strip.puff[0] * band) / cell);
    const radiusMax = Math.max(radiusMin + 1, (strip.puff[1] * band) / cell);
    const top = new Int16Array(W).fill(H);
    const cover = clamp(coverage);
    // Periodic clump field: 7 control values around the period.
    const knots = Array.from({ length: 7 }, (_, k) => random01(seed, strip.salt * 17 + k));
    const clump = (x) => {
        const t = (x / W) * knots.length;
        const i = Math.floor(t);
        const f = t - i;
        const s = f * f * (3 - 2 * f);
        return knots[i % knots.length] * (1 - s) + knots[(i + 1) % knots.length] * s;
    };
    const puff = (cx, radius, rise) => {
        const reach = Math.ceil(radius);
        for (let dx = -reach; dx <= reach; dx++) {
            const k = 1 - (dx / radius) ** 2;
            if (k <= 0) continue;
            const height = Math.min(H, Math.floor(rise * Math.sqrt(k)) + 1);
            const col = (((cx + dx) % W) + W) % W;
            top[col] = Math.min(top[col], H - height);
        }
    };
    const averageWidth = (radiusMin + radiusMax) * 1.6;
    const clouds = Math.round((cover * W) / averageWidth * 1.4);
    for (let i = 0, placed = 0; i < clouds * 4 && placed < clouds; i++) {
        const salt = strip.salt * 131 + i * 11;
        const cx = Math.floor(random01(seed, salt) * W);
        if (clump(cx) > cover + 0.35) continue;
        placed++;
        const radius = radiusMin + random01(seed, salt + 1) * (radiusMax - radiusMin);
        const rise = Math.min(H - 1, radius * (0.32 + random01(seed, salt + 2) * 0.55));
        puff(cx, radius, rise);
        const lobes = 1 + Math.floor(random01(seed, salt + 3) * 4);
        for (let lobe = 0; lobe < lobes; lobe++) {
            const side = lobe % 2 === 0 ? 1 : -1;
            const offset = side * radius * (0.55 + random01(seed, salt + 4 + lobe) * 0.5);
            const size = radius * (0.45 + random01(seed, salt + 8 + lobe) * 0.3);
            puff(Math.round(cx + offset), size, rise * (0.45 + random01(seed, salt + 12 + lobe) * 0.3));
        }
    }
    // Stepped noise on the silhouettes: a 1-cell rise or fall per 3-cell run
    // along each top so the domes break into billows.
    for (let col = 0; col < W; col++) {
        if (top[col] >= H - 2) continue;
        const n = random01(seed, strip.salt * 97 + Math.floor(col / 3));
        top[col] = Math.max(0, Math.min(H - 2, top[col] + (n > 0.72 ? -1 : n < 0.28 ? 1 : 0)));
    }
    // A covered sky lays a continuous stratus floor along the far strip only,
    // so the nearer strips never read as stacked bands.
    if (cover > 0.72 && strip.f === 0) {
        const floor = Math.max(2, Math.round(H * (cover > 0.9 ? 0.4 : 0.25)));
        for (let col = 0; col < W; col++) top[col] = Math.min(top[col], H - floor);
    }
    const underRows = Math.max(1, Math.round(H * 0.18));
    const bytes = colors.map(rgb => rgb.map(channel => Math.round(clamp(channel) * 255)));
    const small = document.createElement('canvas');
    small.width = W;
    small.height = H;
    const sctx = small.getContext('2d');
    const image = sctx.createImageData(W, H);
    const data = image.data;
    for (let col = 0; col < W; col++) {
        const left = top[(col - 1 + W) % W];
        const right = top[(col + 1) % W];
        // A high sun (rimSide 0) lights only the tops: no side reaches in.
        const sunward = rimSide < 0 ? left : rimSide > 0 ? right : -1;
        const leeward = rimSide < 0 ? right : rimSide > 0 ? left : -1;
        // Each cloud's own height sets its courses, so a low cloud keeps a
        // lit top and a thin base instead of turning all underside.
        const h = H - top[col];
        const under = Math.min(underRows, Math.max(1, Math.round(h * 0.3)));
        const crown = Math.max(1, Math.round(h * 0.3));
        for (let row = top[col]; row < H; row++) {
            const depth = row - top[col];
            const seam = BAYER4[(row % 4) * 4 + (col % 4)] < 8;
            let tone = 1;
            if (row >= H - under) tone = 2;
            else if (row === H - under - 1 && seam) tone = 2;
            else if (rimSide === 0) {
                // A high sun lights the upper third of every dome, a Bayer
                // seam stepping it into the body.
                if (depth < crown || (depth === crown && seam)) tone = 0;
            } else if (row === top[col] ? sunward >= row : row < sunward) tone = 0;
            else if (row < leeward && row !== top[col]) tone = 2;
            const c = bytes[tone];
            const o = (row * W + col) * 4;
            data[o] = c[0];
            data[o + 1] = c[1];
            data[o + 2] = c[2];
            data[o + 3] = 255;
        }
    }
    sctx.putImageData(image, 0, 0);
    if (cell === 1) return small;
    const scaled = document.createElement('canvas');
    scaled.width = W * cell;
    scaled.height = H * cell;
    const tctx = scaled.getContext('2d');
    tctx.imageSmoothingEnabled = false;
    tctx.drawImage(small, 0, 0, scaled.width, scaled.height);
    releaseCanvasBackingStore(small);
    return scaled;
}

// 5.8 — the upper half of a six-band ring (outer red → inner violet) on
// `cell` px cells, each band one or more whole cells wide, the outer and
// inner rims broken by a 4x4 Bayer threshold instead of a soft fade.
function bakeRainbowStamp(radius, cell, colors) {
    const cols = Math.ceil((radius * 2) / cell);
    const rows = Math.ceil(radius / cell);
    const bandWidth = Math.max(cell, Math.round((radius * 0.012) / cell) * cell);
    const bytes = colors.map(rgb => rgb.map(channel => Math.round(clamp(channel) * 255)));
    const small = document.createElement('canvas');
    small.width = cols;
    small.height = rows;
    const sctx = small.getContext('2d');
    const image = sctx.createImageData(cols, rows);
    const data = image.data;
    const last = bytes.length - 1;
    for (let j = 0; j < rows; j++) {
        for (let i = 0; i < cols; i++) {
            const px = (i + 0.5) * cell - radius;
            const py = (j + 0.5) * cell - radius;
            const u = (radius - Math.hypot(px, py)) / bandWidth;
            const order = BAYER4[(j % 4) * 4 + (i % 4)] / 16;
            let band = Math.floor(u);
            if (band < 0) {
                if (u > -0.75 && order < 0.5 * (1 + u / 0.75)) band = 0;
                else continue;
            } else if (band > last) {
                if (u < last + 1.75 && order < 0.5 * (1 - (u - last - 1) / 0.75)) band = last;
                else continue;
            }
            const c = bytes[band];
            const o = (j * cols + i) * 4;
            data[o] = c[0];
            data[o + 1] = c[1];
            data[o + 2] = c[2];
            data[o + 3] = 255;
        }
    }
    sctx.putImageData(image, 0, 0);
    const scaled = document.createElement('canvas');
    scaled.width = cols * cell;
    scaled.height = rows * cell;
    const tctx = scaled.getContext('2d');
    tctx.imageSmoothingEnabled = false;
    tctx.drawImage(small, 0, 0, scaled.width, scaled.height);
    releaseCanvasBackingStore(small);
    return scaled;
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
