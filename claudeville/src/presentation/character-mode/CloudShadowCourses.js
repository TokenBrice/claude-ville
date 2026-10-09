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
    cloudFieldAt,
    CLOUD_FIELD_PERIOD,
    CLOUD_TILE_SIZE,
    CLOUD_TILE_WORLD_SCALE,
    LONE_CLOUD_MIX,
    LONE_CLOUD_THRESHOLDS,
} from './gpu/GpuWorldPolicy.js';
import { baseWindX, cloudCourseDrift, cloudDriftSpeed } from './Wind.js';
import { TILE_HEIGHT, TILE_WIDTH } from '../../config/constants.js';

// W6.3 — the lone fair-weather cumulus. On a fair sky (the field casts no
// courses) an AmbientEvents `lone-cloud` slot sends one soft patch across
// the island and its sea at the knot wind's cloud speed (clear: ~5.5 world
// px/s), from a seeded point over the island. It forms and dissolves in
// three held radius steps (0.55, 0.8, 1 of LONE_CLOUD_RADIUS, 8 s each) and
// is nothing outside its slot; the event holds under reduced motion, so the
// static frame is a clear island.
export const LONE_CLOUD_RADIUS = 440;
const LONE_CLOUD_STEP_MS = 8000;

function fract(value) {
    return value - Math.floor(value);
}

export function createLoneCloudPose() {
    return { active: false, x: 0, y: 0, fieldX: 0, fieldY: 0, radius: 0 };
}

/** The lone cloud's pose at `nowMs` (the event's own wall clock), or inactive. */
export function loneCloudPose(event, nowMs, weather, out = createLoneCloudPose()) {
    out.active = false;
    if (!event || event.kind !== 'lone-cloud') return out;
    const span = event.endMs - event.startMs;
    const elapsed = Number(nowMs) - event.startMs;
    if (!(span > 0) || !(elapsed >= 0) || elapsed >= span) return out;
    const base = baseWindX(weather);
    const speed = cloudDriftSpeed(base);
    const seed = Number(event.seed) || 0;
    const tileX = 10 + 20 * seed;
    const tileY = 10 + 20 * fract(seed * 7.31);
    const t = (elapsed - span / 2) / 1000;
    out.x = (tileX - tileY) * TILE_WIDTH / 2 + (base < 0 ? -1 : 1) * speed * t;
    out.y = (tileX + tileY) * TILE_HEIGHT / 2 + (speed / 3) * t;
    const edge = Math.min(elapsed, span - elapsed);
    out.radius = Math.round(LONE_CLOUD_RADIUS * (edge < LONE_CLOUD_STEP_MS ? 0.55 : edge < LONE_CLOUD_STEP_MS * 2 ? 0.8 : 1));
    out.fieldX = Math.floor(fract(seed * 13.7) * CLOUD_FIELD_PERIOD);
    out.fieldY = Math.floor(fract(seed * 29.3) * CLOUD_FIELD_PERIOD);
    out.active = true;
    return out;
}

let _loneTile = null;
let _loneCanvas = null;
let _loneKey = '';

// The lone patch on Canvas: the shaders' exact field (cloudFieldAt) leaned on
// the same dome, cut at the same two thresholds on 2 world px texels, with
// the courses' ordered seam.
function loneCanvas(pose, darkening) {
    const key = `${pose.fieldX},${pose.fieldY},${pose.radius},${Math.round(darkening * 200)}`;
    if (_loneCanvas && key === _loneKey) return _loneCanvas;
    _loneTile ||= buildCloudShadowTile(CLOUD_TILE_SIZE);
    const half = Math.ceil((pose.radius * 0.72) / WORLD_PX_PER_TEXEL);
    const size = half * 2;
    const canvas = _loneCanvas || document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    const image = ctx.createImageData(size, size);
    const [t1, t2] = LONE_CLOUD_THRESHOLDS;
    const value = (dx, dy) => {
        const n = cloudFieldAt(_loneTile, pose.fieldX + dx, pose.fieldY + dy);
        return n + ((1 - Math.hypot(dx, dy) / pose.radius) - n) * LONE_CLOUD_MIX;
    };
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const dx = (x - half + 0.5) * WORLD_PX_PER_TEXEL;
            const dy = (y - half + 0.5) * WORLD_PX_PER_TEXEL;
            let v = value(dx, dy);
            if (Math.min(Math.abs(v - t1), Math.abs(v - t2)) < 0.03) {
                const slope = Math.max(Math.abs(value(dx + WORLD_PX_PER_TEXEL, dy) - v), Math.abs(value(dx, dy + WORLD_PX_PER_TEXEL) - v));
                v += (BAYER4[(y % 4) * 4 + (x % 4)] / 16 - 0.5) * 2 * slope;
            }
            const course = (v >= t1 ? 1 : 0) + (v >= t2 ? 1 : 0);
            const offset = (y * size + x) * 4;
            image.data[offset] = Math.round(255 * (1 - course * darkening));
            image.data[offset + 1] = Math.round(255 * (1 - course * darkening * 0.96));
            image.data[offset + 2] = Math.round(255 * (1 - course * darkening * 0.84));
            image.data[offset + 3] = 255;
        }
    }
    ctx.putImageData(image, 0, 0);
    _loneCanvas = canvas;
    _loneKey = key;
    return canvas;
}

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
export function drawCloudShadowCourses(ctx, { atmosphere = null, region = null, timeMs = 0, reducedMotion = false, lone = null } = {}) {
    const grade = atmosphere?.lightGrade;
    const strength = Math.max(0, Math.min(1, Number(grade?.cloudShadow) || 0));
    if (strength <= 0.02 || !region || region.length < 3 || typeof document === 'undefined') return false;
    const cover = Math.max(0, Math.min(1, Number(atmosphere?.weather?.cloudCover) || 0));
    const covered = cloudCoveredShare(cover);
    if (covered <= 0) return reducedMotion ? false : drawLoneCloud(ctx, region, lone, 0.085 * strength);
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

function drawLoneCloud(ctx, region, lone, darkening) {
    if (!lone?.active || !(lone.radius > 0)) return false;
    const tile = loneCanvas(lone, darkening);
    const extent = tile.width * WORLD_PX_PER_TEXEL;
    ctx.save();
    ctx.imageSmoothingEnabled = false;
    ctx.beginPath();
    ctx.moveTo(region[0].x, region[0].y);
    for (let index = 1; index < region.length; index++) ctx.lineTo(region[index].x, region[index].y);
    ctx.closePath();
    ctx.clip();
    ctx.globalCompositeOperation = 'multiply';
    ctx.drawImage(tile, Math.round(lone.x - extent / 2), Math.round(lone.y - extent / 2), extent, extent);
    ctx.restore();
    return true;
}
