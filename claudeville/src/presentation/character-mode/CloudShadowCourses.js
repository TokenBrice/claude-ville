// 1.4 Canvas parity — world-locked cloud-shadow courses from the same baked
// noise field the resident composite samples (GpuWorldPolicy
// `buildCloudShadowTile`). The field is cut into three dithered courses into
// a cached multiply pattern (two world px per texel), laid over the terrain in
// world space and drifted by the one wind (Wind.js `cloudCourseDrift`, the
// integrator the composite reads too); reduced motion freezes the offset.
// A fair-weather sky (cover < 0.15) casts none, partly cloudy covers ~38 %,
// overcast/rain none (the C2 grade flattens instead), and nothing at night
// (`cloudCoveredShare`, the rule the resident path uses). Course edges are
// solid with a 1-2 texel ordered seam (its width from the field's slope).

import {
    buildCloudShadowTile,
    cloudCoveredShare,
    CLOUD_TILE_SIZE,
    CLOUD_TILE_WORLD_SCALE,
} from './gpu/GpuWorldPolicy.js';
import { cloudCourseDrift } from './Wind.js';

const WORLD_PX_PER_TEXEL = 2;
const PERIOD = CLOUD_TILE_SIZE * CLOUD_TILE_WORLD_SCALE;
const COURSE_SIZE = PERIOD / WORLD_PX_PER_TEXEL;
const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

let _field = null;
function field() {
    if (_field) return _field;
    const data = buildCloudShadowTile(CLOUD_TILE_SIZE);
    const values = new Float32Array(CLOUD_TILE_SIZE * CLOUD_TILE_SIZE);
    for (let index = 0; index < values.length; index++) values[index] = data[index * 4] / 255;
    const sorted = Float32Array.from(values).sort();
    _field = { values, sorted };
    return _field;
}

function threshold(coveredShare) {
    const { sorted } = field();
    const share = Math.max(0, Math.min(1, coveredShare));
    return sorted[Math.round((1 - share) * (sorted.length - 1))];
}

function sample(values, u, v) {
    const size = CLOUD_TILE_SIZE;
    const x = u - 0.5;
    const y = v - 0.5;
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const tx = x - x0;
    const ty = y - y0;
    const at = (xi, yi) => values[(((yi % size) + size) % size) * size + (((xi % size) + size) % size)];
    const top = at(x0, y0) + (at(x0 + 1, y0) - at(x0, y0)) * tx;
    const bottom = at(x0, y0 + 1) + (at(x0 + 1, y0 + 1) - at(x0, y0 + 1)) * tx;
    return top + (bottom - top) * ty;
}

let _courseCanvas = null;
let _courseKey = '';

function courseCanvas(covered, darkening) {
    const key = `${Math.round(covered * 40)}|${Math.round(darkening * 200)}`;
    if (_courseCanvas && key === _courseKey) return _courseCanvas;
    const canvas = _courseCanvas || document.createElement('canvas');
    canvas.width = COURSE_SIZE;
    canvas.height = COURSE_SIZE;
    const ctx = canvas.getContext('2d');
    const image = ctx.createImageData(COURSE_SIZE, COURSE_SIZE);
    const { values } = field();
    const t1 = threshold(covered);
    const t2 = threshold(covered * 0.55);
    const t3 = threshold(covered * 0.22);
    const texelsPerCourse = WORLD_PX_PER_TEXEL / CLOUD_TILE_WORLD_SCALE;
    const near = n => Math.min(Math.abs(n - t1), Math.abs(n - t2), Math.abs(n - t3));
    for (let y = 0; y < COURSE_SIZE; y++) {
        for (let x = 0; x < COURSE_SIZE; x++) {
            const u = (x + 0.5) * texelsPerCourse;
            const v = (y + 0.5) * texelsPerCourse;
            let n = sample(values, u, v);
            if (near(n) < 0.03) {
                const slope = Math.max(Math.abs(sample(values, u + texelsPerCourse, v) - n), Math.abs(sample(values, u, v + texelsPerCourse) - n));
                n += (BAYER4[(y % 4) * 4 + (x % 4)] / 16 - 0.5) * 2 * slope;
            }
            const course = (n >= t1 ? 1 : 0) + (n >= t2 ? 1 : 0) + (n >= t3 ? 1 : 0);
            const offset = (y * COURSE_SIZE + x) * 4;
            image.data[offset] = Math.round(255 * (1 - course * darkening));
            image.data[offset + 1] = Math.round(255 * (1 - course * darkening * 0.96));
            image.data[offset + 2] = Math.round(255 * (1 - course * darkening * 0.84));
            image.data[offset + 3] = 255;
        }
    }
    ctx.putImageData(image, 0, 0);
    _courseCanvas = canvas;
    _courseKey = key;
    return canvas;
}

/** The course field's world offset (whole world px) at `timeMs`: the pattern
 * shift the courses draw with (frozen under reduced motion). */
export function cloudCourseOffset(timeMs, weather, reducedMotion = false) {
    const drift = cloudCourseDrift(reducedMotion ? null : (Number(timeMs) || 0), weather);
    return {
        x: Math.round(((-drift.x % PERIOD) + PERIOD) % PERIOD) % PERIOD,
        y: Math.round(((-drift.y % PERIOD) + PERIOD) % PERIOD) % PERIOD,
    };
}

/** The cloud tile at tile-texel coords (u, v), bilinear with wrap: the
 * resident LINEAR sampler on `u_cloudTile` (3.4's paw ruffle reads it). */
export function cloudTileSample(u, v) {
    return sample(field().values, u, v);
}

let _sunlit = null;
/**
 * 3.4 — the sea's sunlit course on Canvas: the field's clearest share (0.8 of
 * the covered share, the resident `u_seaSunlit` rule) as a world-locked tile
 * of PERIOD world px, one world texel per mask texel, its edge solid with the
 * courses' 1-2 texel ordered seam. `mask` is 1 where the sea takes one stop
 * lighter; `canvas` the same as an alpha mask. Offset it by
 * `cloudCourseOffset`, as the courses are.
 */
export function cloudSunlitTile(covered) {
    const key = Math.round(Math.max(0, Math.min(1, covered)) * 40);
    if (_sunlit?.key === key) return _sunlit;
    const { values } = field();
    const t = threshold(1 - (key / 40) * 0.8);
    const size = PERIOD;
    const mask = new Uint8Array(size * size);
    const canvas = _sunlit?.canvas || document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    const image = ctx.createImageData(size, size);
    const step = 1 / CLOUD_TILE_WORLD_SCALE;
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const u = (x + 0.5) * step;
            const v = (y + 0.5) * step;
            let n = sample(values, u, v);
            if (Math.abs(n - t) < 0.03) {
                const slope = Math.max(Math.abs(sample(values, u + step, v) - n), Math.abs(sample(values, u, v + step) - n));
                n += (BAYER4[(y % 4) * 4 + (x % 4)] / 16 - 0.5) * 2 * slope;
            }
            if (n >= t) continue;
            const i = y * size + x;
            mask[i] = 1;
            image.data[i * 4 + 3] = 255;
        }
    }
    ctx.putImageData(image, 0, 0);
    _sunlit = { key, mask, canvas, size };
    return _sunlit;
}

/**
 * Draw the courses over the terrain and the sea. `ctx` carries the camera
 * world transform; `region` is the world-space polygon to shade (3.4: the
 * visible rect below the sea horizon, so the sea takes the island's shadows).
 */
export function drawCloudShadowCourses(ctx, { atmosphere = null, region = null, timeMs = 0, reducedMotion = false } = {}) {
    const grade = atmosphere?.lightGrade;
    const strength = Math.max(0, Math.min(1, Number(grade?.cloudShadow) || 0));
    if (strength <= 0.02 || !region || region.length < 3 || typeof document === 'undefined') return false;
    const cover = Math.max(0, Math.min(1, Number(atmosphere?.weather?.cloudCover) || 0));
    const covered = cloudCoveredShare(cover);
    if (covered <= 0) return false;
    const tile = courseCanvas(covered, 0.085 * strength);
    const pattern = ctx.createPattern(tile, 'repeat');
    if (!pattern) return false;
    const drift = cloudCourseDrift(reducedMotion ? null : (Number(timeMs) || 0), atmosphere?.weather);
    const driftX = ((-drift.x % PERIOD) + PERIOD) % PERIOD;
    const driftY = ((-drift.y % PERIOD) + PERIOD) % PERIOD;
    pattern.setTransform?.(new DOMMatrix([
        WORLD_PX_PER_TEXEL, 0, 0, WORLD_PX_PER_TEXEL,
        -Math.round(driftX), -Math.round(driftY),
    ]));
    ctx.save();
    ctx.imageSmoothingEnabled = false;
    ctx.beginPath();
    ctx.moveTo(region[0].x, region[0].y);
    for (let index = 1; index < region.length; index++) ctx.lineTo(region[index].x, region[index].y);
    ctx.closePath();
    ctx.globalCompositeOperation = 'multiply';
    ctx.fillStyle = pattern;
    ctx.fill();
    ctx.restore();
    return true;
}
