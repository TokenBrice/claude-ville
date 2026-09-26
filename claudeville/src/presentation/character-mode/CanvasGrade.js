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
//
// Everything here is cached by the caller; nothing runs a smooth gradient.

import { applyGradeToRgb } from './GradeEvaluator.js';

const LUMA = [0.2126, 0.7152, 0.0722];

function clamp(value, min = 0, max = 1) {
    return Math.max(min, Math.min(max, value));
}

function rgbCss(channels) {
    return `rgb(${channels.map(channel => Math.round(clamp(channel) * 255)).join(', ')})`;
}

/** Steps 1 and 3: the desaturation and lift fills around the multiply. */
export function drawCanvasGradeSaturation(ctx, width, height, grade) {
    const amount = clamp(1 - (grade?.saturation ?? 1));
    if (amount < 0.02) return;
    ctx.save();
    ctx.globalCompositeOperation = 'saturation';
    ctx.globalAlpha = Math.round(amount * 32) / 32;
    ctx.fillStyle = '#808080';
    ctx.fillRect(0, 0, width, height);
    ctx.restore();
}

export function drawCanvasGradeLift(ctx, width, height, grade) {
    const lift = grade?.lift;
    if (!lift || Math.max(lift[0], lift[1], lift[2]) < 0.004) return;
    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    ctx.fillStyle = rgbCss(lift);
    ctx.fillRect(0, 0, width, height);
    ctx.restore();
}

// 4x4 Bayer in [0, 1).
const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

// The C1 emissive ramp, luma-normalised (#ff9d4a rim, #ffcf7a mid, #ffe9b8
// core), and the course weights: the resident `stepPool`/`poolWeight`.
const POOL_RIM = [1.484, 0.914, 0.430];
const POOL_MID = [1.208, 0.981, 0.577];
const POOL_CORE = [1.089, 0.995, 0.786];
const POOL_WEIGHTS = [0.30, 0.54, 0.76];

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
 * grey-green. When the pools carry the frame (`_poolShade`), a second block
 * of `cells` columns is a `multiply` image: with the dodge it trades the
 * graded ambient's blue night cast for the course's own hue, as the resident
 * `stepPool` does (a dodge alone can only brighten, and blue + amber greys
 * the pool into peach).
 */
export function buildPoolDodgeStamp({ rgb = [255, 200, 110], radius = 32, cell = 1, energy = 1, ambientTint = [0.4, 0.4, 0.4], poolGain = 1 } = {}) {
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
    const ambient = [0, 1, 2].map(index => Math.max(0.12, Number(ambientTint?.[index]) || 0.4));
    const ambientLuma = ambient[0] * LUMA[0] + ambient[1] * LUMA[1] + ambient[2] * LUMA[2];
    const adaptGain = warm * 0.85 * clamp((poolGain - 0.15) / 1.05);
    const shade = adaptGain > 0.01;
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
    for (let y = 0; y < rows; y++) {
        for (let x = 0; x < cells; x++) {
            const distance = Math.hypot(x + 0.5 - centreX, (y + 0.5 - centreY) * 2) / Math.max(1, radiusCells);
            if (distance >= 1) continue;
            const t = distance;
            const falloff = 1 - t * t * (3 - 2 * t);
            const q = falloff + (BAYER4[(y % 4) * 4 + (x % 4)] / 16 - 0.5) * 0.08;
            const step = (q >= 0.12 ? 1 : 0) + (q >= 0.40 ? 1 : 0) + (q >= 0.75 ? 1 : 0);
            if (step <= 0) continue;
            const strength = Math.min(1, POOL_WEIGHTS[step - 1] * energy * colorLuma);
            const tint = tints[step - 1];
            const offset = (y * canvas.width + x) * 4;
            const adapt = shade ? Math.min(1, strength * 1.5) * adaptGain : 0;
            for (let channel = 0; channel < 3; channel++) {
                const m = poolGain * strength * tint[channel] / ambient[channel];
                // Ambient under the light: graded x (ambientLuma / ambient) x tint.
                const toward = 1 + (tint[channel] * ambientLuma / ambient[channel] - 1) * adapt;
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
