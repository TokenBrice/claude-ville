// Canvas-fallback half of C2 + 1.2 (the Opus 5.5 aesthetic plan).
//
// The resident renderer grades each albedo fragment with GRADE_GLSL and then
// adds stepped multiplicative light pools. Canvas cannot read the albedo back
// after drawing, so it reproduces the same grade with composite fills over the
// finished world layer:
//
//   1. `saturation` fill of grey at alpha (1 - saturation)  -> night desat
//   2. `multiply` by the cached overlay (exposure x gain x split-tone mid,
//      stepped vignette)                                    -> ambient
//   3. `screen` fill of the lift colour                     -> black floor
//   3b. `multiply` self-blit at `canvasGradeGammaAlpha`     -> mid gamma
//   4. `color-dodge` stepped pool stamps                    -> lights multiply
//      the graded surface (Cb / (1 - Cs) = Cb x (1 + m)), in three dithered
//      courses on the art-pixel grid, so texture shows through the light.
//   5. emitter cuts (1.3), drawn after the grade           -> authored emitters
//      keep their own light (`buildEmitterCut`).
//
// Everything here is cached by the caller; nothing runs a smooth gradient.

import { AFTERGLOW, SEA_FRESNEL_Y, SEA_FRESNEL_BANDS, SEA_FRESNEL_FAR, SEA_FRESNEL_WEIGHT, applyGradeToRgb, faceGuard, capSaturation, WATER_MAX_SATURATION, waterMaxSaturation } from './GradeEvaluator.js';
import { GRADE_CONSTANTS, LAND_FULL_STRENGTH } from './gpu/GpuWorldPolicy.js';
import { ART_RAMPS, RECEIVER_LUMA_CEILING } from '../../config/artPalette.js';

const LUMA = [0.2126, 0.7152, 0.0722];

function clamp(value, min = 0, max = 1) {
    return Math.max(min, Math.min(max, value));
}

function rgbCss(channels) {
    return `rgb(${channels.map(channel => Math.round(clamp(channel) * 255)).join(', ')})`;
}

// Step 1's alpha, quantised as the fill draws it (0 = no fill).
function canvasSaturationAlpha(grade) {
    const amount = clamp(1 - (grade?.saturation ?? 1));
    return amount < 0.02 ? 0 : Math.round(amount * 32) / 32;
}

/** Steps 1 and 3: the desaturation and lift fills around the multiply. */
export function drawCanvasGradeSaturation(ctx, width, height, grade) {
    const alpha = canvasSaturationAlpha(grade);
    if (!alpha) return;
    ctx.save();
    ctx.globalCompositeOperation = 'saturation';
    ctx.globalAlpha = alpha;
    ctx.fillStyle = '#808080';
    ctx.fillRect(0, 0, width, height);
    ctx.restore();
}

function canvasGradeFullChannel(grade, channel) {
    return grade.exposure * grade.gain[channel]
        * Math.sqrt(grade.shadowTint[channel] * grade.highlightTint[channel]);
}

/**
 * Step 2's centre colour: exposure x gain x the split tone's mid, clamped to
 * [0, 1] for the multiply overlay's inner course (the vignette courses darken
 * it toward `vignetteEdge`). When clear-day exposure exceeds 1, any channel
 * excess above 1 is carried by `canvasGradeGain` / `drawCanvasGradeGain`.
 */
export function canvasGradeMultiply(grade) {
    return [
        Math.min(1, canvasGradeFullChannel(grade, 0)),
        Math.min(1, canvasGradeFullChannel(grade, 1)),
        Math.min(1, canvasGradeFullChannel(grade, 2)),
    ];
}

/**
 * Step 2b's gain factor (> 1 only when clear-day exposure exceeds 1 so
 * `multiply` alone would clip channels; `[1, 1, 1]` whenever exposure <= 1).
 */
export function canvasGradeGain(grade) {
    if (!(grade?.exposure > 1.004)) return [1, 1, 1];
    return [
        Math.max(1, canvasGradeFullChannel(grade, 0)),
        Math.max(1, canvasGradeFullChannel(grade, 1)),
        Math.max(1, canvasGradeFullChannel(grade, 2)),
    ];
}

// Cached CSS string for `drawCanvasGradeGain` so clear-day frames allocate
// nothing per frame; returns null immediately when exposure <= 1.004.
let _gainCssKey = -1;
let _gainCssValue = '';

function canvasGradeGainBytes(grade) {
    if (!(grade?.exposure > 1.004)) return null;
    const g0 = Math.max(1, canvasGradeFullChannel(grade, 0));
    const g1 = Math.max(1, canvasGradeFullChannel(grade, 1));
    const g2 = Math.max(1, canvasGradeFullChannel(grade, 2));
    if (g0 <= 1.004 && g1 <= 1.004 && g2 <= 1.004) return null;
    // W3C color-dodge: Cb / (1 - Cs) = Cb * gain -> Cs = 1 - 1 / gain.
    const r = Math.round(clamp(1 - 1 / g0, 0, 0.94) * 255);
    const g = Math.round(clamp(1 - 1 / g1, 0, 0.94) * 255);
    const b = Math.round(clamp(1 - 1 / g2, 0, 0.94) * 255);
    return (r << 16) | (g << 8) | b;
}

/** Step 2b: a `color-dodge` gain pass only when clear-day exposure exceeds 1. */
export function drawCanvasGradeGain(ctx, width, height, grade) {
    const packed = canvasGradeGainBytes(grade);
    if (packed === null) return;
    if (packed !== _gainCssKey) {
        _gainCssKey = packed;
        _gainCssValue = `rgb(${(packed >> 16) & 255}, ${(packed >> 8) & 255}, ${packed & 255})`;
    }
    ctx.save();
    ctx.globalCompositeOperation = 'color-dodge';
    ctx.fillStyle = _gainCssValue;
    ctx.fillRect(0, 0, width, height);
    ctx.restore();
}

// The Canvas multiply carries one mid split tone, sqrt(shadowTint x
// highlightTint), so the shadow half of the split tone has no twin there: at
// golden hour its violet fill (shadowTint B 1.16 over a mid 0.93) was lost
// and the fill read R−B −6 against the resident −11. A `screen` lifts dark
// pixels most (s x (1 − backdrop)), so the shadow tint's excess over the mid
// rides the lift at SHADOW_SPLIT_SCREEN: golden's fill lands near −9; night,
// blue hour and sunrise, whose shadow tints sit near their mids, move < 1.
const SHADOW_SPLIT_SCREEN = 0.06;

function canvasGradeLift(grade) {
    const lift = grade?.lift;
    if (!lift) return null;
    const shadow = grade.shadowTint || [1, 1, 1];
    const highlight = grade.highlightTint || [1, 1, 1];
    return [0, 1, 2].map(channel => lift[channel]
        + SHADOW_SPLIT_SCREEN * Math.max(0, shadow[channel] - Math.sqrt(shadow[channel] * highlight[channel])));
}

export function drawCanvasGradeLift(ctx, width, height, grade) {
    const lift = canvasGradeLift(grade);
    if (!lift || Math.max(lift[0], lift[1], lift[2]) < 0.004) return;
    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    ctx.fillStyle = rgbCss(lift);
    ctx.fillRect(0, 0, width, height);
    ctx.restore();
}

// NE P2.5 — step 3b's alpha for the multiply self-blit that approximates
// `pow(c, gamma)` via `c' = (1 - a) * c + a * c^2`, quantised to 1/32 (0
// below 0.02 so noon 1.00 and blue hour 1.01 stay exact no-ops).
export function canvasGradeGammaAlpha(grade) {
    const raw = grade?.gamma;
    const gamma = Array.isArray(raw)
        ? ((Number.isFinite(raw[0]) ? raw[0] : 1)
            + (Number.isFinite(raw[1]) ? raw[1] : 1)
            + (Number.isFinite(raw[2]) ? raw[2] : 1)) / 3
        : (Number.isFinite(raw) ? raw : 1);
    const amount = clamp((gamma - 1) * 1.45, 0, 0.85);
    return amount < 0.02 ? 0 : Math.round(amount * 32) / 32;
}

/**
 * NE P2.5 — step 3b: one `multiply` self-blit at `canvasGradeGammaAlpha`,
 * computing `c' = (1 - a) * c + a * c^2` over the finished graded world layer
 * right after `drawCanvasGradeLift`. No-op at noon and blue hour.
 */
export function drawCanvasGradeGamma(ctx, width, height, grade) {
    const alpha = canvasGradeGammaAlpha(grade);
    if (!alpha || !ctx?.canvas || !(width > 0) || !(height > 0)) return;
    ctx.save();
    ctx.globalCompositeOperation = 'multiply';
    ctx.globalAlpha = alpha;
    if (typeof ctx.setTransform === 'function' && ctx.canvas.width > 0 && ctx.canvas.height > 0) {
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(ctx.canvas, 0, 0);
    } else {
        ctx.drawImage(ctx.canvas, 0, 0, width, height);
    }
    ctx.restore();
}

// W3C compositing `Lum`: the `saturation` blend with grey replaces the
// backdrop by this grey, so step 1 is a mix toward it.
const BLEND_LUM = [0.3, 0.59, 0.11];

function canvasGradeTerms(grade) {
    const lift = canvasGradeLift(grade);
    const packed = canvasGradeGainBytes(grade);
    const gain = packed !== null
        ? [
            1 / Math.max(1e-6, 1 - ((packed >> 16) & 255) / 255),
            1 / Math.max(1e-6, 1 - ((packed >> 8) & 255) / 255),
            1 / Math.max(1e-6, 1 - (packed & 255) / 255),
        ]
        : [1, 1, 1];
    return {
        alpha: canvasSaturationAlpha(grade),
        multiply: canvasGradeMultiply(grade),
        gain,
        lift: lift && Math.max(lift[0], lift[1], lift[2]) >= 0.004 ? lift : [0, 0, 0],
        gammaAlpha: canvasGradeGammaAlpha(grade),
    };
}

/**
 * V6 on Canvas — what steps 1–3b make of one ungraded colour (0..1 channels)
 * in the overlay's inner course. The Canvas fills are not the resident
 * `applyGradeToRgb` (a desaturation toward grey, a mid-only split tone, a
 * screened lift, a multiply-self-blit gamma), so a colour whose graded
 * saturation must be held on this path has to be predicted with this model,
 * not with the resident one.
 */
export function canvasGradeRgb(rgb, grade, terms = canvasGradeTerms(grade)) {
    const { alpha, multiply, gain, lift, gammaAlpha = 0 } = terms;
    const grey = rgb[0] * BLEND_LUM[0] + rgb[1] * BLEND_LUM[1] + rgb[2] * BLEND_LUM[2];
    return [0, 1, 2].map((channel) => {
        const desat = rgb[channel] + (grey - rgb[channel]) * alpha;
        const scaled = clamp(desat * multiply[channel] * gain[channel]);
        const lifted = 1 - (1 - scaled) * (1 - lift[channel]);
        return gammaAlpha > 0 ? lifted * (1 - gammaAlpha + gammaAlpha * lifted) : lifted;
    });
}

// The exact inverse of `canvasGradeRgb` (steps 3b, 3, 2b, 2, then 1: the
// gamma self-blit inverts via the positive quadratic root and the mix toward
// grey keeps `Lum`, so every step undoes in closed form). Out-of-gamut
// targets clamp.
function canvasUngradeRgb(target, terms) {
    const { alpha, multiply, gain, lift, gammaAlpha = 0 } = terms;
    const oneMinusA = 1 - gammaAlpha;
    const d = [0, 1, 2].map((channel) => {
        const t = target[channel];
        const unGamma = gammaAlpha > 0
            ? (-oneMinusA + Math.sqrt(Math.max(0, oneMinusA * oneMinusA + 4 * gammaAlpha * t))) / (2 * gammaAlpha)
            : t;
        return (1 - (1 - unGamma) / Math.max(1e-6, 1 - lift[channel]))
            / Math.max(1e-6, multiply[channel] * gain[channel]);
    });
    const grey = d[0] * BLEND_LUM[0] + d[1] * BLEND_LUM[1] + d[2] * BLEND_LUM[2];
    return d.map(channel => clamp((channel - alpha * grey) / Math.max(1e-6, 1 - alpha)));
}

/**
 * V6 off the resident path — the ungraded water colour whose frame grade is
 * the capped grade of `rgb`: the same `capSaturation` the resident scene
 * pass applies to graded water (hue and luma kept, R−B sign kept), moved in
 * front of the grade that runs over the finished 2D frame. That grade is the
 * hybrid PostFx pass (`postFx`: the resident formula, inverted by
 * `ungradeRgb`) or, without it, the Canvas fills (inverted in closed form).
 * Returns `rgb` itself when the cap does not bind. Used for the outer ocean
 * and the in-map water copy (CoastBake).
 */
export function canvasWaterPreimage(rgb, grade, { postFx = false, maxS = null, sky = null } = {}) {
    if (!grade) return rgb;
    const cap = maxS ?? (sky ? waterMaxSaturation(sky) : WATER_MAX_SATURATION);
    const finish = graded => capSaturation(sky?.skyWeight > 0 ? applyWaterSky(graded, sky) : graded, cap);
    if (postFx) {
        const graded = applyGradeToRgb(rgb, grade);
        const target = finish(graded);
        return target === graded ? rgb : ungradeRgb(target, grade);
    }
    const terms = canvasGradeTerms(grade);
    const graded = canvasGradeRgb(rgb, grade, terms);
    const target = finish(graded);
    return target === graded ? rgb : canvasUngradeRgb(target, terms);
}

/**
 * E2-01 — the sky on the sea, on graded (capped) water: at the working zoom
 * the sky is off-frame and the sea, half the frame, stands in for it, so the
 * water takes `mood.skyWeight` of the grade's own sky-horizon colour
 * (`mood.sky`, CoastBake.waterMoodFor) at its own value, lifted at most
 * WATER_SKY_LIFT and never darkened. The GLSL / WGSL `applyWaterSky` twins
 * run at the same point (after V6's cap; the caller caps again).
 */
export const WATER_SKY_LIFT = 1.3;
export function applyWaterSky(rgb, mood) {
    const w = mood?.skyWeight || 0;
    if (!(w > 0)) return rgb;
    const sky = mood.sky;
    const l = rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
    const ls = Math.max(1e-4, sky[0] * 0.2126 + sky[1] * 0.7152 + sky[2] * 0.0722);
    const k = Math.min(Math.max(ls, l), l * WATER_SKY_LIFT) / ls;
    return [0, 1, 2].map(i => Math.max(0, Math.min(1, rgb[i] + (sky[i] * k - rgb[i]) * w)));
}

/** World-pixel course for a Canvas sea bake. Pass CoastBake's seaBandBend. */
export function seaFresnelCourse(x, y, seaBandBend) {
    x = Math.floor(x);
    y = Math.floor(y);
    const order = BAYER4[(y & 3) * 4 + (x & 3)] / 16;
    for (let i = 0; i < SEA_FRESNEL_Y.length; i++) {
        const distance = y - SEA_FRESNEL_Y[i];
        if (distance < -16) return i;
        if (distance < 16 && (distance - seaBandBend(x, SEA_FRESNEL_BANDS[i]) + 2) / 4 <= order) return i;
    }
    return 3;
}

/** OA-W4 open-water landing on an already graded bed, before horizon haze. */
export function applySeaFresnel(rgb, mood, grade, course) {
    const gate = grade.seaFresnelGate;
    const limit = waterMaxSaturation(mood);
    if (!(gate > 0) || course === 3) return capSaturation(applyWaterSky(rgb, mood), limit);
    rgb = capSaturation(rgb, limit);
    const far = hexToRgb01(grade.seaFar);
    const sky = mood.sky.map((v, i) => v + (far[i] - v) * SEA_FRESNEL_FAR[course]);
    const weight = Math.round(Math.max(mood.skyWeight, SEA_FRESNEL_WEIGHT[course] * gate) * 256);
    const target = applyWaterSky(rgb, { sky, skyWeight: 1 });
    const linear16 = v => Math.round((v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4) * 65535);
    const mixed = rgb.map((v, i) => {
        const lin = Math.floor(((256 - weight) * linear16(v) + weight * linear16(target[i]) + 128) / 256) / 65535;
        return lin <= 0.0031308 ? 12.92 * lin : 1.055 * lin ** (1 / 2.4) - 0.055;
    });
    const y = mixed.reduce((value, c, i) => value + c * LUMA[i], 0);
    return capSaturation(mixed.map(c => c * Math.min(1, RECEIVER_LUMA_CEILING / Math.max(1e-4, y))), limit);
}

/**
 * 3.12 — the frame grade off the resident path (the hybrid PostFx pass with
 * `postFx`, else the Canvas fills) of one ungraded colour, and its inverse:
 * the colour to paint so the finished frame lands on `target`. For marks the
 * resident pass grades and then caps (the sea path) or leaves ungraded (the
 * Lighthouse sheen), which the 2D frame can only reach through a preimage.
 */
export function canvasFrameGradeRgb(rgb, grade, { postFx = false } = {}) {
    if (!grade) return rgb;
    return postFx ? applyGradeToRgb(rgb, grade) : canvasGradeRgb(rgb, grade);
}

export function canvasFramePreimage(target, grade, { postFx = false } = {}) {
    if (!grade) return target;
    return postFx ? ungradeRgb(target, grade) : canvasUngradeRgb(target, canvasGradeTerms(grade));
}

/**
 * G7-1 — a status cloth (the Command attention banner) keeps its own hue and
 * saturation through the night grade while its value follows the frame: the
 * colour to paint so the finished frame lands on the authored chroma at the
 * graded luma (the cloth is matter, not light, so it never brightens). By
 * day (grade night 0) the cloth grades like any texel; from the blue hour
 * (night 0.5) the hold is whole. Where the night's gain cannot lift a
 * channel to the authored chroma at that value (the yellow's red under the
 * cool night gain), the value steps down until it can, so the hue holds and
 * the cloth reads darker, never brighter. The grade's lift and desaturation
 * floor stay: a deep storm still mutes the cloth, only less. `postFx` picks the frame grade the texel will meet (the resident
 * and hybrid formula, else the Canvas fills), as `canvasFramePreimage` does.
 * RG-3 — the hold never lands greyer than no hold: where the preimage leaves
 * gamut (a storm night's cool gain and floor), the clamped texel can land
 * less saturated than the plain grade leaves it, and then the authored texel
 * grades plainly instead. Darker at a higher saturation is the hold working.
 */
export function statusClothPreimage(rgb, grade, { postFx = false } = {}) {
    const hold = clamp((Number(grade?.night) || 0) / 0.5);
    if (!grade || hold <= 0) return rgb;
    const graded = canvasFrameGradeRgb(rgb, grade, { postFx });
    const authored = rgb[0] * LUMA[0] + rgb[1] * LUMA[1] + rgb[2] * LUMA[2];
    if (authored <= 1e-4) return rgb;
    const full = (graded[0] * LUMA[0] + graded[1] * LUMA[1] + graded[2] * LUMA[2]) / authored;
    const saturation = (c) => {
        const peak = Math.max(c[0], c[1], c[2]);
        return peak > 1e-4 ? (peak - Math.min(c[0], c[1], c[2])) / peak : 0;
    };
    const plainSaturation = saturation(graded);
    // NE v0.67.1 B — cool night multiply can stretch HSV saturation past the
    // authored swatch while shifting hue; cap the RG-3 floor at authored sat.
    const minSaturation = Math.min(plainSaturation, saturation(rgb) - 0.02);
    const solve = (scale) => {
        const peak = Math.max(1, rgb[0] * scale, rgb[1] * scale, rgb[2] * scale);
        const target = [0, 1, 2].map(channel => graded[channel] + (rgb[channel] * scale / peak - graded[channel]) * hold);
        const preimage = canvasFramePreimage(target, grade, { postFx });
        const landed = canvasFrameGradeRgb(preimage, grade, { postFx });
        // A channel the grade's floor holds above its target only greys the
        // cloth a little; a channel that cannot rise to its target turns the
        // hue (yellow to sage), so only a shortfall counts as a miss.
        const short = Math.max(...[0, 1, 2].map(channel => target[channel] - landed[channel]));
        return { preimage, reached: short < 0.012, saturation: saturation(landed) };
    };
    const kept = (candidate) => (candidate.saturation >= minSaturation ? candidate.preimage : rgb);
    const first = solve(full);
    if (first.reached) return kept(first);
    // The largest value in [0.6, 1] x the graded value that lands on target.
    let lo = full * 0.6;
    let hi = full;
    let best = solve(lo);
    for (let step = 0; step < 7; step++) {
        const mid = (lo + hi) / 2;
        const trial = solve(mid);
        if (trial.reached) {
            best = trial;
            lo = mid;
        } else {
            hi = mid;
        }
    }
    return kept(best);
}

/**
 * A key that moves when `canvasWaterPreimage` can: every grade term either
 * frame grade reads, in 1/128 steps.
 */
export function canvasGradeKey(grade, { postFx = false } = {}) {
    if (!grade) return '';
    const terms = [
        grade.exposure, grade.saturation, ...grade.gain, ...grade.lift, ...grade.gamma,
        ...grade.shadowTint, ...grade.highlightTint, ...grade.purkinje,
    ];
    return `${postFx ? 'p' : 'c'}${terms.map(value => Math.round(value * 128)).join(',')}`;
}

/**
 * Post-grade RGBA stamp, drawn before emitter cuts. The sprite supplies full-size
 * albedo and optional surface-code geometry (RGBA8), a sprite-local alpenglowRow,
 * and an optional unlitEmitter mask (one byte per pixel, already room-gated).
 * Keep the sprite descriptor stable between draws and bump revision on mask edits.
 */
export function buildCanvasOverlayStamp(sprite, grade) {
    const rim = Math.round(16 * (grade.rimStrength || 0)) / 16;
    const glow = Math.round(16 * (grade.afterglow || 0)) / 16;
    const glint = Math.round(8 * (grade.windowGlint || 0)) / 8;
    const { width, height, albedo, geometry, alpenglowRow = 0, unlitEmitter } = sprite;
    if (!(rim && geometry || glow && alpenglowRow || glint && geometry && unlitEmitter)) return null;
    const normalized = rgb => {
        const y = rgb.reduce((value, c, i) => value + c * LUMA[i], 0);
        return rgb.map(c => c / y);
    };
    const high = normalized(grade.highlightTint);
    const alpine = normalized(AFTERGLOW.alpenglowTint);
    const horizon = hexToRgb01(grade.skyHorizon);
    const terms = canvasGradeTerms(grade);
    const rows = geometry && (rim || glint && unlitEmitter) ? height : Math.min(height, alpenglowRow);
    const data = new Uint8ClampedArray(width * rows * 4);
    for (let y = 0; y < rows; y++) {
        for (let x = 0; x < width; x++) {
            const pixel = y * width + x;
            const i = pixel * 4;
            if (!albedo[i + 3]) continue;
            const face = geometry?.[i + 3] ? geometry[i + 2] >> 6 : -1;
            const edge = rim && (face === 1 || face === 3) && albedo[i + 3] >= 128
                && (x === 0 || y === 0 || albedo[i - 1] < 128 || albedo[i - 4 * width + 3] < 128);
            const top = glow && y < alpenglowRow && face !== 2;
            const pane = glint && face === 1 && unlitEmitter?.[pixel];
            if (!edge && !top && !pane) continue;
            const rgb = [albedo[i] / 255, albedo[i + 1] / 255, albedo[i + 2] / 255];
            const ref = applyGradeToRgb(rgb, grade);
            let c = canvasGradeRgb(rgb, grade, terms);
            if (edge) c = faceGuard(c.map((v, j) => v * (1 + 0.30 * rim) * (1 + (high[j] - 1) * 0.5 * rim)), ref);
            if (top) c = faceGuard(c.map((v, j) => v * (1 + (alpine[j] * AFTERGLOW.alpenglowGain - 1) * glow * AFTERGLOW.alpenglowShare)), ref);
            if (pane) c = faceGuard(c.map((v, j) => v + (horizon[j] - v) * 0.42 * glint), ref);
            for (let j = 0; j < 3; j++) data[i + j] = c[j] * 255;
            data[i + 3] = albedo[i + 3];
        }
    }
    return { width, height: rows, data };
}

export class CanvasOverlayStampCache {
    constructor() { this.sprites = new WeakMap(); }

    get(sprite, grade) {
        if (!grade.rimStrength && !grade.afterglow && !grade.windowGlint) return null;
        const key = [canvasGradeKey(grade), grade.skyHorizon, Math.round(grade.rimStrength * 16),
            Math.round(grade.afterglow * 16), Math.round(grade.windowGlint * 8),
            sprite.alpenglowRow, sprite.revision].join('|');
        const cached = this.sprites.get(sprite);
        if (cached?.key === key) return cached.canvas;
        const stamp = buildCanvasOverlayStamp(sprite, grade);
        let canvas = null;
        if (stamp) {
            canvas = cached?.canvas || document.createElement('canvas');
            canvas.width = stamp.width;
            canvas.height = stamp.height;
            const ctx = canvas.getContext('2d');
            ctx.putImageData(new ImageData(stamp.data, stamp.width, stamp.height), 0, 0);
        }
        this.sprites.set(sprite, { key, canvas });
        return canvas;
    }
}

// 4x4 Bayer in [0, 1).
const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

// The C1 emissive ramp, luma-normalised (#ff9d4a rim, #ffcf7a mid, #ffe9b8
// core), and the course weights: the resident `stepPool`/`poolWeight`.
const POOL_RIM = [1.484, 0.914, 0.430];
const POOL_MID = [1.208, 0.981, 0.577];
const POOL_CORE = [1.089, 0.995, 0.786];
const POOL_STOPS = GRADE_CONSTANTS.AMBIENT_POOL_STOPS.value;
const POOL_WEIGHTS = GRADE_CONSTANTS.AMBIENT_POOL_WEIGHTS.value;
const POOL_CHROMA = GRADE_CONSTANTS.AMBIENT_POOL_CHROMA.value;
const POOL_SHARE = GRADE_CONSTANTS.AMBIENT_POOL_SHARE.value;
// 1.2 — the resident `stepPool` landing stops (rim #ff9d4a, mid half way,
// core #ffcf7a) and each course's share of the landing at full pool light.
const LAND_MID = [1.346, 0.948, 0.504];
const LAND_STOPS = [POOL_RIM, LAND_MID, POOL_MID];
// V5 — the brightest ground stop (dressed plaza) is the receiver the stamp
// clamps against.
const PLAZA_PEAK = ART_RAMPS.plaza[ART_RAMPS.plaza.length - 1];

function hexToRgb01(hex) {
    const value = Number.parseInt(String(hex).replace('#', ''), 16);
    return [((value >> 16) & 0xff) / 255, ((value >> 8) & 0xff) / 255, (value & 0xff) / 255];
}

/** The graded plaza receiver for one grade (0..1 channels). */
export function gradedPoolReceiver(grade) {
    return grade ? applyGradeToRgb(hexToRgb01(PLAZA_PEAK), grade) : null;
}

// V5 — the receiver okL ceiling (GpuWorldPolicy `onStop`, `okCeiling`),
// 0..1 channels.
const RECEIVER_OKL_CEILING = 0.836;

function lumaOf(rgb) {
    return rgb[0] * LUMA[0] + rgb[1] * LUMA[1] + rgb[2] * LUMA[2];
}

function onStop(stop, y) {
    const c = stop.map(channel => channel * y);
    const hi = Math.max(...c);
    return hi > 1 ? c.map(channel => y + (channel - y) * ((1 - y) / (hi - y))) : c;
}

const decodeSrgb = c => (c < 0.04045 ? Math.max(0, c) / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const encodeSrgb = l => (l < 0.0031308 ? Math.max(0, l) * 12.92 : 1.055 * l ** (1 / 2.4) - 0.055);

function okLightness(lin) {
    const l = Math.cbrt(Math.max(0, 0.4122214708 * lin[0] + 0.5363325363 * lin[1] + 0.0514459929 * lin[2]));
    const m = Math.cbrt(Math.max(0, 0.2119034982 * lin[0] + 0.6806995451 * lin[1] + 0.1073969566 * lin[2]));
    const s = Math.cbrt(Math.max(0, 0.0883024619 * lin[0] + 0.2817188376 * lin[1] + 0.6299787005 * lin[2]));
    return 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s;
}

function okCeiling(lit, floorColour, ceilL) {
    if (Math.max(...lit) <= 0.74) return lit;
    const lin = lit.map(decodeSrgb);
    const l = okLightness(lin);
    if (l <= ceilL) return lit;
    const floorL = Math.max(ceilL, okLightness(floorColour.map(decodeSrgb)));
    if (l <= floorL) return lit;
    const k = floorL / l;
    return lin.map(channel => encodeSrgb(channel * k * k * k));
}

/**
 * 2.9 — the resident water column landing (SCENE_FRAGMENT after the light
 * loop) on one graded water colour: the texel takes `rampY`, the luma `lift`
 * stops above its local water stop on the water ramp (never under the water
 * plus 0.03 a stop), in the light's hue (`light`, summed, any scale) on the
 * C1 emissive ramp by lift (#ff9d4a up to 3, half way at 4, the core stop at
 * 5; a cool light keeps 70 % of its hue), 12 % of the water kept, under the
 * receiver okL ceiling. Graded 0..1 channels in and out.
 */
export function landWaterColumn(water, light, lift, rampY) {
    const y = Math.max(rampY, lumaOf(water) + 0.03 * lift);
    const ly = Math.max(lumaOf(light), 0.001);
    const hue = light.map(channel => channel / ly);
    const warm = clamp((hue[0] - hue[2]) * 1.25);
    const land = LAND_STOPS[lift > 3.5 ? 2 : lift > 2.5 ? 1 : 0];
    const stop = hue.map((channel, index) => (1 + (channel - 1) * 0.7) * (1 - warm) + land[index] * warm);
    const on = onStop(stop, y);
    return okCeiling(water.map((channel, index) => channel + (on[index] - channel) * 0.88), water, RECEIVER_OKL_CEILING);
}

/**
 * One cached pool stamp whose cells are `cell` CSS px (one art pixel at the
 * current zoom): a 2:1 iso ground ellipse `2 * radius` CSS px wide and
 * `radius` tall, as the resident pool measures distance with screen y
 * doubled. As in the resident `ambientPoolSteps`, falloff picks one of six
 * held courses, with 4x4 ordered-dither seams. The faint outer courses keep
 * little chroma; the inner courses resolve to warm amber. Course weights
 * spend less energy than the old three-ring discs, never more.
 * The left `cells` columns are a `color-dodge` image: it multiplies the
 * graded backdrop per channel by (1 + poolGain x strength x tint / ambient),
 * dividing by the grade's ambient tint channel by channel, so a lantern on
 * graded grass lands amber (albedo x ramp) instead of amber x blue =
 * grey-green. A second block of `cells` columns is a `multiply` image
 * (`_poolShade`): with the dodge it trades the graded ambient's blue night
 * cast for the course's landing stop, as the resident `stepPool` does (a
 * dodge alone can only brighten, and blue + amber greys the pool into peach,
 * green + amber into lime). The trade is the larger of the resident adapt
 * (0.6 of the old share once the pools carry the frame) and its landing:
 * warm x the course's LAND_SHARE x the share of the lit value the pool
 * supplies, so grass and stone under a lantern land on the C1 stops.
 *
 * V5 parity note: the resident pass knees each lit pixel against
 * RECEIVER_LUMA_CEILING. A stamp cannot read the pixel it lands on, so each
 * course's multiplier is clamped instead so that the graded plaza — the
 * brightest ground stop, `receiver` (from `gradedPoolReceiver(grade)`) —
 * lands at or below the ceiling; darker receivers land proportionally lower.
 * This per-stamp clamp approximates the per-pixel knee: it is exact on the
 * plaza, conservative elsewhere, and keeps no quarter of the excess. The
 * resident pool's 55 % albedo chroma has no Canvas twin: the dodge multiplies
 * the already-graded surface, whose chroma the grade has set.
 *
 * V5 — `height` (px, the stamp's units: the light's ground-course height,
 * `LightSourceRegistry.groundCourseHeight`) raises the light above the
 * stamp's centre, the light's foot: the ground course is stepped on the 3D
 * distance `|(dx, 2dy, height)|` over the reach `sqrt(radius^2 + height^2)`,
 * and a facade aperture's `normal [nx, ng]` confines it to its face's
 * half-space (`0.30 + 1.4 n.g / |g|`, g the ground offset), exactly the
 * resident loop's ground receiver.
 */
export function buildPoolDodgeStamp({ rgb = [255, 200, 110], radius = 32, cell = 1, energy = 1, ambientTint = [0.4, 0.4, 0.4], poolGain = 1, receiver = null, height = 0, normal = null, attention = false } = {}) {
    const size = Math.max(2, Math.ceil(radius * 2));
    const cellPx = Math.max(1, Math.round(cell));
    const cells = Math.max(1, Math.ceil(size / cellPx));
    const rows = Math.max(1, Math.ceil(cells / 2));
    const color = [rgb[0] / 255, rgb[1] / 255, rgb[2] / 255];
    const colorLuma = Math.max(0.05, color[0] * LUMA[0] + color[1] * LUMA[1] + color[2] * LUMA[2]);
    const hue = color.map(channel => channel / colorLuma);
    const warm = clamp((hue[0] - hue[2]) * 1.25);
    const tintFor = ramp => hue.map((channel, index) => (1 + (channel - 1) * 0.7) * (1 - warm) + ramp[index] * warm);
    const stops = attention ? [0.12, 0.40, 0.75] : POOL_STOPS;
    const weights = attention ? [0.30, 0.54, 0.76] : POOL_WEIGHTS;
    const shares = attention ? [0.84, 0.88, 0.90] : POOL_SHARE;
    const tints = attention ? [POOL_RIM, POOL_MID, POOL_CORE].map(tintFor)
        : POOL_CHROMA.map((chroma, course) => tintFor(POOL_RIM.map((channel, i) =>
            channel + (POOL_CORE[i] - channel) * course / 5)).map(channel => 1 + (channel - 1) * chroma));
    const landTints = attention ? LAND_STOPS.map(tintFor)
        : POOL_CHROMA.map((chroma, course) => tintFor(POOL_RIM.map((channel, i) =>
            channel + (POOL_MID[i] - channel) * course / 5)).map(channel => 1 + (channel - 1) * chroma));
    const ambient = [0, 1, 2].map(index => Math.max(0.12, Number(ambientTint?.[index]) || 0.4));
    const ambientLuma = ambient[0] * LUMA[0] + ambient[1] * LUMA[1] + ambient[2] * LUMA[2];
    const adaptGain = warm * 0.85 * 0.6 * clamp((poolGain - 0.15) / 1.05);
    const shade = warm > 0.01;
    const canvas = document.createElement('canvas');
    canvas.width = shade ? cells * 2 : cells;
    canvas.height = rows;
    const ctx = canvas.getContext('2d');
    const image = ctx.createImageData(canvas.width, rows);
    const data = image.data;
    if (shade) {
        // The multiply half is white (no change) outside the pool.
        for (let y = 0; y < rows; y++) data.fill(255, (y * canvas.width + cells) * 4, (y * canvas.width + cells * 2) * 4);
    }
    const centreX = cells / 2;
    const centreY = rows / 2;
    const radiusCells = radius / cellPx;
    const heightCells = Math.max(0, Number(height) || 0) / cellPx;
    const reachCells = Math.max(1, Math.hypot(radiusCells, heightCells));
    const lobed = Array.isArray(normal) && normal.length >= 2;
    for (let y = 0; y < rows; y++) {
        for (let x = 0; x < cells; x++) {
            const gx = x + 0.5 - centreX;
            const gy = (y + 0.5 - centreY) * 2;
            const d = Math.hypot(gx, gy, heightCells);
            const t = d / reachCells;
            if (t >= 1) continue;
            const lobe = lobed ? clamp(0.30 + 1.4 * (normal[0] * gx + normal[1] * gy) / Math.max(Math.hypot(gx, gy), 1)) : 1;
            const falloff = (1 - t * t * (3 - 2 * t)) * lobe;
            const q = falloff + (BAYER4[(y % 4) * 4 + (x % 4)] / 16 - 0.5) * 0.08;
            let step = 0;
            for (const stop of stops) if (q >= stop) step++;
            if (step <= 0) continue;
            const strength = Math.min(1, weights[step - 1] * energy * colorLuma);
            const tint = tints[step - 1];
            const landTint = landTints[step - 1];
            const offset = (y * canvas.width + x) * 4;
            const lift = poolGain * strength / ambientLuma;
            const land = warm * shares[step - 1] * Math.max(Math.min(1, strength / LAND_FULL_STRENGTH), clamp(1.6 * lift / (1 + lift)));
            const adapt = shade ? Math.max(Math.min(1, strength * 1.5) * adaptGain, land) : 0;
            const towards = [0, 0, 0];
            const gains = [0, 0, 0];
            for (let channel = 0; channel < 3; channel++) {
                gains[channel] = poolGain * strength * tint[channel] / ambient[channel];
                // Ambient under the light: graded x (ambientLuma / ambient) x stop.
                towards[channel] = 1 + (landTint[channel] * ambientLuma / ambient[channel] - 1) * adapt;
            }
            const scale = receiverScale(receiver, towards, gains);
            for (let channel = 0; channel < 3; channel++) {
                const toward = towards[channel];
                const m = gains[channel] * scale;
                const multiply = Math.min(1, toward);
                const dodge = (toward + m) / multiply;
                data[offset + channel] = Math.round(clamp(1 - 1 / dodge, 0, 0.94) * 255);
                if (shade) data[offset + cells * 4 + channel] = Math.round(multiply * 255);
            }
            data[offset + 3] = 255;
        }
    }
    ctx.putImageData(image, 0, 0);
    canvas._poolCellPx = cellPx;
    canvas._poolCells = cells;
    canvas._poolRows = rows;
    canvas._poolShade = shade;
    return canvas;
}

// V5 — the share of a course's light multiplier `gains` that keeps the graded
// receiver x (toward + m) at or below RECEIVER_LUMA_CEILING (1 = unclamped).
// A receiver the grade already put above the ceiling is never darkened.
function receiverScale(receiver, towards, gains) {
    if (!receiver) return 1;
    let base = 0;
    let lift = 0;
    for (let channel = 0; channel < 3; channel++) {
        base += LUMA[channel] * receiver[channel] * towards[channel];
        lift += LUMA[channel] * receiver[channel] * gains[channel];
    }
    const ceiling = Math.max(RECEIVER_LUMA_CEILING, LUMA[0] * receiver[0] + LUMA[1] * receiver[1] + LUMA[2] * receiver[2]);
    if (lift <= 0 || base + lift <= ceiling) return 1;
    return clamp((ceiling - base) / lift);
}

/**
 * NE P1.3 — night emitter carry factor derived from `grade.poolGain`,
 * matching the scene shaders' `clamp((poolGain - 0.15) / 1.05, 0, 1)`.
 * Returns 0 at daytime `poolGain` (0.15) and 1 at night (1.2).
 */
export function emitterNightCarry(grade) {
    const poolGain = typeof grade === 'number' ? grade : (grade?.poolGain ?? 0.15);
    return clamp((poolGain - 0.15) / 1.05);
}

/**
 * 1.3 / NE P1.3 / NE P1.5 Canvas parity — one emitter cut per sprite, built
 * from its albedo, its emissive sidecar (same size), and the frame grade's
 * `poolGain`. The resident scene pass shows a lit emitter pixel as
 * `mix(graded, emitterBase, w) + (0.42 + 0.20 * nightCarry) * emission * 2a`,
 * with `a` the sidecar contribution, `w = min(1, 2a)` at full energy, and
 * `emitterBase = max(albedo, emission * clamp(0.5 + 0.5 * 2a, 0, 1) * nightCarry)`,
 * then divides by the brightest channel. Drawn `source-over` after the frame's
 * grade at alpha `w`, the cut reproduces that with `contribution = 2a` (NE P1.5:
 * matching the GPU's `emissive` factor without `max(1, contribution)`),
 * hue-protected the same way. The caller scales it by gate x core energy
 * through `globalAlpha`. `bloom` is the same texels' own emission, the
 * resident bloom source (sidecar rgb x 2a): stored at half (rgb x a, opaque)
 * so 8 bits hold it; the hybrid bloom doubles it back. Returns
 * `{ canvas, bloom, x, y }` trimmed to the emitter pixels (x, y the offset
 * inside the sprite), or null when the sidecar is empty.
 *
 * NE P3.4 — Canvas keeps its declared lower tier with no villager moonlight rim.
 */
export function buildEmitterCut(albedo, emissive, grade = null) {
    const width = albedo?.width | 0;
    const height = albedo?.height | 0;
    if (!width || !height || emissive?.width !== width || emissive?.height !== height) return null;
    const scratch = document.createElement('canvas');
    scratch.width = width;
    scratch.height = height;
    const scratchCtx = scratch.getContext('2d', { willReadFrequently: true });
    scratchCtx.drawImage(albedo, 0, 0);
    const base = scratchCtx.getImageData(0, 0, width, height).data;
    scratchCtx.clearRect(0, 0, width, height);
    scratchCtx.drawImage(emissive, 0, 0);
    const light = scratchCtx.getImageData(0, 0, width, height).data;
    let x0 = width;
    let y0 = height;
    let x1 = -1;
    let y1 = -1;
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const i = (y * width + x) * 4;
            if (light[i + 3] === 0 || base[i + 3] === 0) continue;
            if (x < x0) x0 = x;
            if (y < y0) y0 = y;
            if (x > x1) x1 = x;
            if (y > y1) y1 = y;
        }
    }
    releaseScratch(scratch);
    if (x1 < 0) return null;
    const cutWidth = x1 - x0 + 1;
    const cutHeight = y1 - y0 + 1;
    const canvas = document.createElement('canvas');
    canvas.width = cutWidth;
    canvas.height = cutHeight;
    const ctx = canvas.getContext('2d');
    const image = ctx.createImageData(cutWidth, cutHeight);
    const bloom = document.createElement('canvas');
    bloom.width = cutWidth;
    bloom.height = cutHeight;
    const bloomCtx = bloom.getContext('2d');
    const bloomImage = bloomCtx.createImageData(cutWidth, cutHeight);
    const nightCarry = emitterNightCarry(grade);
    const landingWeight = 0.42 + 0.20 * nightCarry;
    for (let y = 0; y < cutHeight; y++) {
        for (let x = 0; x < cutWidth; x++) {
            const i = ((y + y0) * width + x + x0) * 4;
            const o = (y * cutWidth + x) * 4;
            if (light[i + 3] === 0 || base[i + 3] === 0) continue;
            const contribution = 2 * light[i + 3] / 255;
            const emission = landingWeight * contribution;
            const liftScale = clamp(0.5 + 0.5 * contribution) * nightCarry;
            const er = light[i] / 255;
            const eg = light[i + 1] / 255;
            const eb = light[i + 2] / 255;
            const r = Math.max(base[i] / 255, er * liftScale) + emission * er;
            const g = Math.max(base[i + 1] / 255, eg * liftScale) + emission * eg;
            const b = Math.max(base[i + 2] / 255, eb * liftScale) + emission * eb;
            const peak = Math.max(1, r, g, b);
            image.data[o] = Math.round(r / peak * 255);
            image.data[o + 1] = Math.round(g / peak * 255);
            image.data[o + 2] = Math.round(b / peak * 255);
            image.data[o + 3] = Math.round(Math.min(1, contribution) * (base[i + 3] / 255) * 255);
            const share = light[i + 3] / 255;
            bloomImage.data[o] = Math.round(light[i] * share);
            bloomImage.data[o + 1] = Math.round(light[i + 1] * share);
            bloomImage.data[o + 2] = Math.round(light[i + 2] * share);
            bloomImage.data[o + 3] = 255;
        }
    }
    ctx.putImageData(image, 0, 0);
    bloomCtx.putImageData(bloomImage, 0, 0);
    return { canvas, bloom, x: x0, y: y0 };
}

function releaseScratch(canvas) {
    canvas.width = 0;
    canvas.height = 0;
}

/**
 * 1.3 — the albedo that grades to `target` (0..1 channels): the inverse of
 * `applyGradeToRgb`, solved per channel by a damped multiplicative fixed
 * point (the grade is monotone per channel; desaturation couples them only
 * weakly). The sky and the void carry final, already-graded C2 colours; on
 * the Canvas and PostFx paths the whole 2D frame is graded after it is
 * drawn, so the backdrop paints this preimage there and lands on the same
 * colour the resident path shows. Out-of-gamut targets clamp to [0, 1].
 */
export function ungradeRgb(target, grade) {
    if (!grade) return target.slice(0, 3);
    const x = [clamp(target[0]), clamp(target[1]), clamp(target[2])];
    for (let step = 0; step < 24; step++) {
        const y = applyGradeToRgb(x, grade);
        let error = 0;
        for (let channel = 0; channel < 3; channel++) {
            const want = clamp(target[channel]);
            const got = Math.max(1e-4, y[channel]);
            error = Math.max(error, Math.abs(want - y[channel]));
            // Damped ratio step; the additive floor lets a black start move.
            const ratio = (want + 0.002) / (got + 0.002);
            x[channel] = clamp(Math.max(x[channel], 0.002) * Math.pow(ratio, 0.8));
        }
        if (error < 0.002) break;
    }
    return x;
}

/**
 * 1.6 Canvas parity — the resident composite's screen-Y aerial perspective
 * as one cached strip: `haze = pow(clamp((0.55 - yTop) / 0.55), 1.4) x
 * strength`, stepped in 1/48 courses with a 4x4 ordered dither, drawn
 * `source-over` in the haze colour. The strip is 4 cells wide (one Bayer
 * period) and as tall as the haze reaches, so the caller tiles it across the
 * frame with a `repeat-x` pattern: one fill per frame, rebaked only when the
 * viewport height, the art-pixel cell, the strength or the colour bucket
 * changes. The resident path's 0.8x desaturation is folded into the colour.
 */
export function buildAerialHazeStrip({ height = 720, cell = 1, strength = 0.14, rgb = [0.6, 0.7, 0.78], start = 0.55 } = {}) {
    const cellPx = Math.max(1, Math.round(cell));
    const hazeStart = Math.max(0.05, Number(start) || 0.55);
    const reach = Math.max(1, Math.ceil((height * hazeStart) / cellPx));
    const canvas = document.createElement('canvas');
    canvas.width = 4;
    canvas.height = reach;
    const ctx = canvas.getContext('2d');
    const image = ctx.createImageData(4, reach);
    const r = Math.round(clamp(rgb[0]) * 255);
    const g = Math.round(clamp(rgb[1]) * 255);
    const b = Math.round(clamp(rgb[2]) * 255);
    for (let y = 0; y < reach; y++) {
        const yTop = ((y + 0.5) * cellPx) / Math.max(1, height);
        const base = Math.pow(clamp((hazeStart - yTop) / hazeStart), 1.4) * strength;
        for (let x = 0; x < 4; x++) {
            const order = BAYER4[(y % 4) * 4 + x] / 16;
            const haze = Math.floor(base * 48 + order) / 48;
            if (haze <= 0) continue;
            const offset = (y * 4 + x) * 4;
            image.data[offset] = r;
            image.data[offset + 1] = g;
            image.data[offset + 2] = b;
            image.data[offset + 3] = Math.round(clamp(haze) * 255);
        }
    }
    ctx.putImageData(image, 0, 0);
    canvas._hazeCellPx = cellPx;
    return canvas;
}
