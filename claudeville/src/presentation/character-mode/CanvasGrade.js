// Canvas-fallback half of C2 + 1.2 (agents/plans/claudeville-opus55-aesthetic-plan.md).
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
//   4. `color-dodge` stepped pool stamps                    -> lights multiply
//      the graded surface (Cb / (1 - Cs) = Cb x (1 + m)), in three dithered
//      courses on the art-pixel grid, so texture shows through the light.
//   5. emitter cuts (1.3), drawn after the grade           -> authored emitters
//      keep their own light (`buildEmitterCut`).
//
// Everything here is cached by the caller; nothing runs a smooth gradient.

import { applyGradeToRgb, capSaturation, WATER_MAX_SATURATION } from './GradeEvaluator.js';
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

/**
 * Step 2's centre colour: exposure x gain x the split tone's mid, the
 * multiply overlay's inner course (the vignette courses darken it toward
 * `vignetteEdge`).
 */
export function canvasGradeMultiply(grade) {
    return [0, 1, 2].map(channel => Math.min(1, grade.exposure * grade.gain[channel]
        * Math.sqrt(grade.shadowTint[channel] * grade.highlightTint[channel])));
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

// W3C compositing `Lum`: the `saturation` blend with grey replaces the
// backdrop by this grey, so step 1 is a mix toward it.
const BLEND_LUM = [0.3, 0.59, 0.11];

function canvasGradeTerms(grade) {
    const lift = canvasGradeLift(grade);
    return {
        alpha: canvasSaturationAlpha(grade),
        multiply: canvasGradeMultiply(grade),
        lift: lift && Math.max(lift[0], lift[1], lift[2]) >= 0.004 ? lift : [0, 0, 0],
    };
}

/**
 * V6 on Canvas — what steps 1–3 make of one ungraded colour (0..1 channels)
 * in the overlay's inner course. The Canvas fills are not the resident
 * `applyGradeToRgb` (a desaturation toward grey, a mid-only split tone, a
 * screened lift), so a colour whose graded saturation must be held on this
 * path has to be predicted with this model, not with the resident one.
 */
export function canvasGradeRgb(rgb, grade, terms = canvasGradeTerms(grade)) {
    const { alpha, multiply, lift } = terms;
    const grey = rgb[0] * BLEND_LUM[0] + rgb[1] * BLEND_LUM[1] + rgb[2] * BLEND_LUM[2];
    return [0, 1, 2].map((channel) => {
        const desat = rgb[channel] + (grey - rgb[channel]) * alpha;
        return 1 - (1 - desat * multiply[channel]) * (1 - lift[channel]);
    });
}

// The exact inverse of `canvasGradeRgb` (steps 3, 2, then 1: the mix toward
// grey keeps `Lum`, so it undoes in closed form). Out-of-gamut targets clamp.
function canvasUngradeRgb(target, terms) {
    const { alpha, multiply, lift } = terms;
    const d = [0, 1, 2].map(channel => (1 - (1 - target[channel]) / Math.max(1e-6, 1 - lift[channel]))
        / Math.max(1e-6, multiply[channel]));
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
export function canvasWaterPreimage(rgb, grade, { postFx = false, maxS = WATER_MAX_SATURATION } = {}) {
    if (!grade) return rgb;
    if (postFx) {
        const graded = applyGradeToRgb(rgb, grade);
        const capped = capSaturation(graded, maxS);
        return capped === graded ? rgb : ungradeRgb(capped, grade);
    }
    const terms = canvasGradeTerms(grade);
    const graded = canvasGradeRgb(rgb, grade, terms);
    const capped = capSaturation(graded, maxS);
    return capped === graded ? rgb : canvasUngradeRgb(capped, terms);
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

// 4x4 Bayer in [0, 1).
const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

// The C1 emissive ramp, luma-normalised (#ff9d4a rim, #ffcf7a mid, #ffe9b8
// core), and the course weights: the resident `stepPool`/`poolWeight`.
const POOL_RIM = [1.484, 0.914, 0.430];
const POOL_MID = [1.208, 0.981, 0.577];
const POOL_CORE = [1.089, 0.995, 0.786];
const POOL_WEIGHTS = [0.30, 0.54, 0.76];
// 1.2 — the resident `stepPool` landing stops (rim #ff9d4a, mid half way,
// core #ffcf7a) and each course's share of the landing at full pool light.
const LAND_MID = [1.346, 0.948, 0.504];
const LAND_STOPS = [POOL_RIM, LAND_MID, POOL_MID];
const LAND_SHARE = [0.84, 0.88, 0.90];
// The least share each course lands with (GPU LAND_FLOOR): the thin outer
// course on night grass lands in full, warm instead of khaki-olive.
const LAND_FLOOR = [1, 0, 0];
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

/**
 * One cached pool stamp whose cells are `cell` CSS px (one art pixel at the
 * current zoom): a 2:1 iso ground ellipse `2 * radius` CSS px wide and
 * `radius` tall, as the resident pool measures distance with screen y
 * doubled. As in the resident `poolSteps`, the light's falloff shape alone
 * picks the course (0.12 / 0.40 / 0.75, 4x4 ordered dither), so every pool
 * has a rim, a mid ring and a core; energy sets how bright they are. Warm
 * lights take the C1 ramp per course, cool lights 70 % of their own hue.
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
 * V5 — `height` (px, the stamp's units) raises the light above the stamp's
 * centre, the light's foot: the ground course is stepped on the 3D distance
 * `|(dx, 2dy, height)|` over the reach `sqrt(radius^2 + height^2)`, and a facade
 * aperture's `normal [nx, ng]` confines it to its face's half-space
 * (`0.30 + 1.4 n.d / |d|`), exactly the resident loop's ground receiver.
 */
export function buildPoolDodgeStamp({ rgb = [255, 200, 110], radius = 32, cell = 1, energy = 1, ambientTint = [0.4, 0.4, 0.4], poolGain = 1, receiver = null, height = 0, normal = null } = {}) {
    const size = Math.max(2, Math.ceil(radius * 2));
    const cellPx = Math.max(1, Math.round(cell));
    const cells = Math.max(1, Math.ceil(size / cellPx));
    const rows = Math.max(1, Math.ceil(cells / 2));
    const color = [rgb[0] / 255, rgb[1] / 255, rgb[2] / 255];
    const colorLuma = Math.max(0.05, color[0] * LUMA[0] + color[1] * LUMA[1] + color[2] * LUMA[2]);
    const hue = color.map(channel => channel / colorLuma);
    const warm = clamp((hue[0] - hue[2]) * 1.25);
    const tintFor = ramp => hue.map((channel, index) => (1 + (channel - 1) * 0.7) * (1 - warm) + ramp[index] * warm);
    const tints = [tintFor(POOL_RIM), tintFor(POOL_MID), tintFor(POOL_CORE)];
    const landTints = LAND_STOPS.map(tintFor);
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
            const lobe = lobed ? clamp(0.30 + 1.4 * (normal[0] * gx + normal[1] * gy) / Math.max(d, 1)) : 1;
            const falloff = (1 - t * t * (3 - 2 * t)) * lobe;
            const q = falloff + (BAYER4[(y % 4) * 4 + (x % 4)] / 16 - 0.5) * 0.08;
            const step = (q >= 0.12 ? 1 : 0) + (q >= 0.40 ? 1 : 0) + (q >= 0.75 ? 1 : 0);
            if (step <= 0) continue;
            const strength = Math.min(1, POOL_WEIGHTS[step - 1] * energy * colorLuma);
            const tint = tints[step - 1];
            const landTint = landTints[step - 1];
            const offset = (y * canvas.width + x) * 4;
            const lift = poolGain * strength / ambientLuma;
            const land = warm * LAND_SHARE[step - 1] * Math.max(LAND_FLOOR[step - 1], clamp(1.6 * lift / (1 + lift)));
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
 * 1.3 Canvas parity — one emitter cut per sprite, built once from its albedo
 * and its emissive sidecar (same size). The resident scene pass shows a lit
 * emitter pixel as mix(graded, albedo, w) + 0.42 x emission x 2a, with a the
 * sidecar contribution and w = min(1, 2a) at full energy, then divides by the
 * brightest channel. Drawn `source-over` after the frame's grade at alpha w,
 * the cut reproduces that: colour albedo + 0.42 x emission x max(1, 2a),
 * hue-protected the same way. The caller scales it by gate x core energy
 * through `globalAlpha`. Returns `{ canvas, x, y }` trimmed to the emitter
 * pixels (x, y the offset inside the sprite), or null when the sidecar is
 * empty.
 */
export function buildEmitterCut(albedo, emissive) {
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
    for (let y = 0; y < cutHeight; y++) {
        for (let x = 0; x < cutWidth; x++) {
            const i = ((y + y0) * width + x + x0) * 4;
            const o = (y * cutWidth + x) * 4;
            if (light[i + 3] === 0 || base[i + 3] === 0) continue;
            const contribution = 2 * light[i + 3] / 255;
            const emission = 0.42 * Math.max(1, contribution);
            const r = base[i] / 255 + emission * light[i] / 255;
            const g = base[i + 1] / 255 + emission * light[i + 1] / 255;
            const b = base[i + 2] / 255 + emission * light[i + 2] / 255;
            const peak = Math.max(1, r, g, b);
            image.data[o] = Math.round(r / peak * 255);
            image.data[o + 1] = Math.round(g / peak * 255);
            image.data[o + 2] = Math.round(b / peak * 255);
            image.data[o + 3] = Math.round(Math.min(1, contribution) * (base[i + 3] / 255) * 255);
        }
    }
    ctx.putImageData(image, 0, 0);
    return { canvas, x: x0, y: y0 };
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
export function buildAerialHazeStrip({ height = 720, cell = 1, strength = 0.14, rgb = [0.6, 0.7, 0.78] } = {}) {
    const cellPx = Math.max(1, Math.round(cell));
    const reach = Math.max(1, Math.ceil((height * 0.55) / cellPx));
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
        const base = Math.pow(clamp((0.55 - yTop) / 0.55), 1.4) * strength;
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
