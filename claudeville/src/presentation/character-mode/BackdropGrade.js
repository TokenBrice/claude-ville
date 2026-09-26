// 1.3 + 1.6 — the backdrop (sky/void plate and the outer ocean, both on the
// 2D canvas) graded exactly like the island around it.
//
// Resident WebGL: the island is graded in the scene pass (C2 grade plus the
// stepped vignette `applyGradeVignette`) and hazed in the composite (screen-Y
// aerial perspective). The backdrop under the GPU canvas already paints final
// C2 colours, but it would miss the two vignette courses and the haze, so at
// frame corners and along the top the island's sea would read darker or
// hazier than the ocean beside it. `drawResidentBackdropGrade` lays the same
// two courses and the same haze over the backdrop, as cached screen-space
// layers: one multiply blit and one pattern fill per frame, rebaked only when
// the viewport, the grade's vignette bucket, the art-pixel cell, the haze
// strength or the haze colour bucket changes.
//
// Canvas / PostFx: the frame grade already vignettes the whole 2D frame.
// `drawCanvasAerialHaze` stamps the same stepped haze over the finished world
// before that grade, in the preimage of the haze colour (CanvasGrade
// `ungradeRgb`), so after the grade it lands on the resident path's colour.

import { buildAerialHazeStrip, ungradeRgb } from './CanvasGrade.js';
import { releaseCanvasBackingStore } from './CanvasBudget.js';
import { aerialPerspectiveStrength, effectBudgetMode } from './gpu/GpuWorldPolicy.js';

// The vignette layer is baked at quarter resolution and blitted 4x nearest:
// its two course edges step on a 4 px grid (0.5 MB at 1080p).
const VIGNETTE_SCALE = 4;

let _vignette = null;
let _vignetteKey = '';
let _haze = null;
let _hazeKey = '';

function bucket(values, steps = 64) {
    return values.map(value => Math.round((Number(value) || 0) * steps)).join(',');
}

// Mirrors GpuWorldPolicy `applyGradeVignette`: centre (0.5, 0.46), inner
// 0.18 x min side, outer 0.72 x max side, courses at t >= 0.62 (0.4 of the
// edge alpha) and t >= 0.84 (all of it), multiplied toward `vignetteEdge`.
function vignetteLayer(width, height, grade) {
    const edge = grade?.vignetteEdge || [1, 1, 1];
    const alpha = Number(grade?.vignetteAlpha) || 0;
    const key = `${width}x${height}|${bucket(edge)}|${Math.round(alpha * 64)}`;
    if (_vignette && _vignetteKey === key) return _vignette;
    releaseCanvasBackingStore(_vignette);
    const w = Math.max(1, Math.ceil(width / VIGNETTE_SCALE));
    const h = Math.max(1, Math.ceil(height / VIGNETTE_SCALE));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    const image = ctx.createImageData(w, h);
    const cx = width * 0.5;
    const cy = height * 0.46;
    const inner = Math.min(width, height) * 0.18;
    const outer = Math.max(width, height) * 0.72;
    const courses = [0.4, 1].map(share => [0, 1, 2].map(channel => 1 + (edge[channel] - 1) * alpha * share));
    for (let y = 0; y < h; y++) {
        const py = (y + 0.5) * VIGNETTE_SCALE;
        for (let x = 0; x < w; x++) {
            const px = (x + 0.5) * VIGNETTE_SCALE;
            const t = (Math.hypot(px - cx, py - cy) - inner) / Math.max(1, outer - inner);
            const course = t >= 0.84 ? courses[1] : t >= 0.62 ? courses[0] : null;
            if (!course) continue;
            const offset = (y * w + x) * 4;
            image.data[offset] = Math.round(course[0] * 255);
            image.data[offset + 1] = Math.round(course[1] * 255);
            image.data[offset + 2] = Math.round(course[2] * 255);
            image.data[offset + 3] = 255;
        }
    }
    ctx.putImageData(image, 0, 0);
    _vignette = canvas;
    _vignetteKey = key;
    return canvas;
}

function hazeStrip(height, cell, strength, rgb) {
    const key = `${height}|${cell}|${Math.round(strength * 256)}|${bucket(rgb)}`;
    if (_haze && _hazeKey === key) return _haze;
    releaseCanvasBackingStore(_haze);
    const small = buildAerialHazeStrip({ height, cell, strength, rgb });
    let strip = small;
    if (cell > 1) {
        strip = document.createElement('canvas');
        strip.width = small.width * cell;
        strip.height = small.height * cell;
        const ctx = strip.getContext('2d');
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(small, 0, 0, strip.width, strip.height);
        releaseCanvasBackingStore(small);
    }
    _haze = strip;
    _hazeKey = key;
    return strip;
}

function fillHaze(ctx, viewport, strip) {
    const pattern = ctx.createPattern(strip, 'repeat-x');
    if (!pattern) return;
    ctx.save();
    ctx.imageSmoothingEnabled = false;
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = pattern;
    ctx.fillRect(0, 0, viewport.width, Math.min(viewport.height, strip.height));
    ctx.restore();
}

function artCell(zoom) {
    return Math.max(1, Math.round(Number(zoom) || 1));
}

/**
 * Resident path: vignette courses + aerial haze over the 2D backdrop, in
 * screen space (the caller has reset the transform). The haze strength is
 * the one the composite used last frame (0 when the budget sheds it).
 */
export function drawResidentBackdropGrade(ctx, { viewport, atmosphere, zoom = 1, hazeStrength = 0 } = {}) {
    const grade = atmosphere?.lightGrade;
    if (!grade || !viewport?.width || !viewport?.height || typeof document === 'undefined') return;
    if ((Number(grade.vignetteAlpha) || 0) > 0.004) {
        const layer = vignetteLayer(viewport.width, viewport.height, grade);
        ctx.save();
        ctx.imageSmoothingEnabled = false;
        ctx.globalCompositeOperation = 'multiply';
        ctx.drawImage(layer, 0, 0, layer.width * VIGNETTE_SCALE, layer.height * VIGNETTE_SCALE);
        ctx.restore();
    }
    if (hazeStrength > 0) {
        fillHaze(ctx, viewport, hazeStrip(viewport.height, artCell(zoom), hazeStrength, grade.fogColor || [0.6, 0.7, 0.78]));
    }
}

/**
 * Canvas / PostFx paths: the aerial haze over the finished world, before the
 * frame grade, in the haze colour's preimage. `qualityLevel` follows the
 * resident ladder's `aerial-perspective` row (off at MINIMAL).
 */
export function drawCanvasAerialHaze(ctx, { viewport, atmosphere, zoom = 1, qualityLevel = 0 } = {}) {
    const grade = atmosphere?.lightGrade;
    if (!grade || !viewport?.width || !viewport?.height || typeof document === 'undefined') return;
    if (effectBudgetMode('aerial-perspective', qualityLevel) === 'off') return;
    const fog = Math.max(0, Math.min(1, Number(atmosphere?.weather?.fog) || 0));
    const strength = aerialPerspectiveStrength(zoom, fog);
    if (strength <= 0) return;
    const rgb = ungradeRgb(grade.fogColor || [0.6, 0.7, 0.78], grade);
    fillHaze(ctx, viewport, hazeStrip(viewport.height, artCell(zoom), strength, rgb));
}
