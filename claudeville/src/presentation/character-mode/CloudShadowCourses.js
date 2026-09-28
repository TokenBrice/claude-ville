// 1.4 Canvas parity — world-locked cloud-shadow courses from the same baked
// noise field the resident composite samples (GpuWorldPolicy
// `buildCloudShadowTile`). The field is cut into three dithered courses into
// a cached multiply pattern (two world px per texel), laid over the terrain in
// world space and drifted by the one wind (Wind.js `cloudCourseDrift`, the
// integrator the composite reads too); reduced motion freezes the offset.
// Clear days cover ~15 % of the ground, partly cloudy ~35 %, overcast/rain
// none (the C2 grade flattens instead), and nothing at night.

import {
    buildCloudShadowTile,
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
    for (let y = 0; y < COURSE_SIZE; y++) {
        for (let x = 0; x < COURSE_SIZE; x++) {
            const n = sample(values, (x + 0.5) * texelsPerCourse, (y + 0.5) * texelsPerCourse)
                + (BAYER4[(y % 4) * 4 + (x % 4)] / 16 - 0.5) * 0.018;
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

/**
 * Draw the courses over the terrain. `ctx` carries the camera world
 * transform; `diamond` is the island's four world-space corner points.
 */
export function drawCloudShadowCourses(ctx, { atmosphere = null, diamond = null, timeMs = 0, reducedMotion = false } = {}) {
    const grade = atmosphere?.lightGrade;
    const strength = Math.max(0, Math.min(1, Number(grade?.cloudShadow) || 0));
    if (strength <= 0.02 || !diamond || diamond.length < 4 || typeof document === 'undefined') return false;
    const cover = Math.max(0, Math.min(1, Number(atmosphere?.weather?.cloudCover) || 0));
    const covered = Math.max(0, Math.min(0.45, 0.1 + cover * 0.62));
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
    ctx.moveTo(diamond[0].x, diamond[0].y);
    for (let index = 1; index < 4; index++) ctx.lineTo(diamond[index].x, diamond[index].y);
    ctx.closePath();
    ctx.globalCompositeOperation = 'multiply';
    ctx.fillStyle = pattern;
    ctx.fill();
    ctx.restore();
    return true;
}
