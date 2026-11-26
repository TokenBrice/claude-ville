// Canvas reads the same authored cumulus lobes and wind drift as the resident
// shaders. The coast mask keeps both the field and the lone cloud off the sea.

import {
    buildCloudShadowTile,
    cloudCoveredShare,
    cumulusCount,
    CLOUD_FIELD_PERIOD,
    cloudPlaneScale,
    CLOUD_TILE_SIZE,
    CLOUD_TILE_WORLD_SCALE,
} from './gpu/GpuWorldPolicy.js';
import { baseWindX, cloudCourseDrift, cloudDriftSpeed } from './Wind.js';
import { MAP_SIZE, TILE_HEIGHT, TILE_WIDTH } from '../../config/constants.js';
import { lookStrength } from './LookStrengths.js';

// SEA-1 (look `sea1` > 0) — the Canvas field on the ground plane, as the
// shaders read it (GpuWorldPolicy CLOUD_PLANE): a world point reads the tile
// at (x × sx, y × sy), so the course tile spans PERIOD / sx × PERIOD / sy
// world px (3200 × 1280, whole 2-px texels) and the drift moves in plane
// units. Off: sx = sy = 1, today's 1024 px square tile.
export function cloudPlane() {
    const strength = Math.max(0, Math.min(1, Number(lookStrength('sea1')) || 0));
    const [sx, sy] = cloudPlaneScale(strength);
    return { on: strength > 0, strength, sx, sy, width: Math.round(PERIOD / sx), height: Math.round(PERIOD / sy) };
}

// W6.3 — the lone fair-weather cumulus. On a fair sky (the field casts no
// courses) an AmbientEvents `lone-cloud` slot sends one soft patch across
// the island at the knot wind's cloud speed (clear: ~5.5 world
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

let _loneCanvas = null;
let _loneKey = '';

function loneCanvas(pose, darkening) {
    const key = `${pose.radius},${Math.round(darkening * 200)}`;
    if (_loneCanvas && key === _loneKey) return _loneCanvas;
    const scale = pose.radius / 120;
    const halfX = Math.ceil(175 * scale / WORLD_PX_PER_TEXEL);
    const halfY = Math.ceil(60 * scale / WORLD_PX_PER_TEXEL);
    _loneCanvas = stampCanvas(_loneCanvas, halfX * 2, halfY * 2, darkening, (x, y) =>
        stampCourse(2100 + (x - halfX) * 2 / scale, 1000 + (y - halfY) * 2 / scale, 4, true, x, y));
    _loneKey = key;
    return _loneCanvas;
}

const WORLD_PX_PER_TEXEL = 2;
const PERIOD = CLOUD_TILE_SIZE * CLOUD_TILE_WORLD_SCALE;
const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

let _field = null;
function field() {
    if (_field) return _field;
    const data = buildCloudShadowTile(CLOUD_TILE_SIZE);
    const values = new Float32Array(CLOUD_TILE_SIZE * CLOUD_TILE_SIZE);
    for (let index = 0; index < values.length; index++) values[index] = data[index * 4] / 255;
    const sorted = Float32Array.from(values).sort();
    _field = { values, sorted, data };
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

function stampCourse(x, y, count, lone, bx, by) {
    const data = field().data;
    const u = fract(x / 3200) * CLOUD_TILE_SIZE, v = fract(y / 1280) * CLOUD_TILE_SIZE;
    const index = (cx, cy) => 4 * ((cy & 255) * 256 + (cx & 255));
    const id = data[index(Math.floor(u), Math.floor(v)) + 1];
    if (!id || (lone ? id !== 4 : id > count)) return 0;
    const x0 = Math.floor(u - 0.5), y0 = Math.floor(v - 0.5);
    const dx = u - 0.5 - x0, dy = v - 0.5 - y0;
    const top = data[index(x0, y0) + 2] * (1 - dx) + data[index(x0 + 1, y0) + 2] * dx;
    const bottom = data[index(x0, y0 + 1) + 2] * (1 - dx) + data[index(x0 + 1, y0 + 1) + 2] * dx;
    const dist = (top + (bottom - top) * dy) / 128 + (BAYER4[(by & 3) * 4 + (bx & 3)] / 16 - 0.5) * 0.08;
    return dist <= 0.55 ? 2 : dist <= 1 ? 1 : 0;
}

function stampCanvas(previous, w, h, darkening, sample) {
    const canvas = previous || document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d'), image = ctx.createImageData(w, h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4, value = Math.round(255 * (1 - darkening * sample(x, y)));
        image.data[i] = image.data[i + 1] = image.data[i + 2] = value;
        image.data[i + 3] = 255;
    }
    ctx.putImageData(image, 0, 0);
    return canvas;
}

function courseCanvas(covered, darkening) {
    const n = cumulusCount(covered), key = `${n}|${Math.round(darkening * 200)}`;
    if (_courseCanvas && key === _courseKey) return _courseCanvas;
    _courseCanvas = stampCanvas(_courseCanvas, 1600, 640, darkening, (x, y) =>
        stampCourse(x * 2 + 1, y * 2 + 1, n, false, x, y));
    _courseKey = key;
    return _courseCanvas;
}

const coastClips = new WeakMap();
function cloudLandClip(bake) {
    const fields = bake?.waterFields;
    if (!fields) return null;
    if (coastClips.has(fields)) return coastClips.get(fields);
    const path = new Path2D();
    for (let r = 0; r < fields.rows; r++) {
        const y = fields.y + r * 2;
        let start = null;
        for (let c = 0; c <= fields.cols; c++) {
            const x = fields.x + c * 2, cell = r * fields.cols + c;
            const u = (y + 1) / TILE_HEIGHT + (x + 1) / TILE_WIDTH, v = (y + 1) / TILE_HEIGHT - (x + 1) / TILE_WIDTH;
            const flags = fields.coastField[cell * 2 + 1];
            const inside = c < fields.cols && !(flags & 16) && (u >= -0.5 && v >= -0.5 && Math.max(u,v) < MAP_SIZE - 0.5
                || bake.coast.outer[cell] && bake.coast.depth[cell] <= 0);
            if (inside && start === null) start = x;
            if (!inside && start !== null) { path.rect(start, y, x - start, 2); start = null; }
        }
    }
    coastClips.set(fields, path);
    return path;
}

/** The course field's world offset (whole world px) at `timeMs`: the pattern
 * shift the courses draw with (frozen under reduced motion). */
export function cloudCourseOffset(timeMs, weather, reducedMotion = false) {
    const plane = cloudPlane();
    const { x, y } = planeDriftOffset(reducedMotion ? null : (Number(timeMs) || 0), weather, plane);
    return { x: Math.round(x) % plane.width, y: Math.round(y) % plane.height };
}

// The drift as a world offset into the plane tile (unrounded): wrapped in
// plane units on PERIOD, as the shaders' u_cloud.xy, then back to world px.
function planeDriftOffset(timeMs, weather, plane) {
    const drift = cloudCourseDrift(timeMs, weather);
    if (!plane.on) {
        return { x: ((-drift.x % PERIOD) + PERIOD) % PERIOD, y: ((-drift.y % PERIOD) + PERIOD) % PERIOD };
    }
    return {
        x: (((-drift.x * plane.sx) % PERIOD) + PERIOD) % PERIOD / plane.sx,
        y: (((-drift.y * plane.sy) % PERIOD) + PERIOD) % PERIOD / plane.sy,
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
// SEA-1 (plane on) — the mask is instead every texel outside the shade (the
// field under the rim's threshold; all of it with no courses), on the plane
// tile (`width` × `height`), and the sea there lifts by the lift's stops.
export function cloudSunlitTile(covered) {
    const plane = cloudPlane();
    const share = Math.round(Math.max(0, Math.min(1, covered)) * 40);
    const key = plane.on ? `plane:${share}:${plane.width}x${plane.height}` : share;
    if (_sunlit?.key === key) return _sunlit;
    const { values } = field();
    const t = plane.on ? Infinity : threshold(1 - (share / 40) * 0.8);
    // On the plane the mask holds whole 2-px texels (the course tile's grid),
    // so its 3200 × 1280 world px stay a 1600 × 640 mask.
    const texel = plane.on ? WORLD_PX_PER_TEXEL : 1;
    const width = plane.width / texel;
    const height = plane.height / texel;
    const mask = new Uint8Array(width * height);
    const canvas = _sunlit?.canvas || document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    const image = ctx.createImageData(width, height);
    const stepU = (plane.sx * texel) / CLOUD_TILE_WORLD_SCALE;
    const stepV = (plane.sy * texel) / CLOUD_TILE_WORLD_SCALE;
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const u = (x + 0.5) * stepU;
            const v = (y + 0.5) * stepV;
            let n = sample(values, u, v);
            if (Math.abs(n - t) < 0.03) {
                const slope = Math.max(Math.abs(sample(values, u + stepU, v) - n), Math.abs(sample(values, u, v + stepV) - n));
                n += (BAYER4[(y % 4) * 4 + (x % 4)] / 16 - 0.5) * 2 * slope;
            }
            if (n >= t) continue;
            const i = y * width + x;
            mask[i] = 1;
            image.data[i * 4 + 3] = 255;
        }
    }
    ctx.putImageData(image, 0, 0);
    _sunlit = { key, mask, canvas, size: width, width, height, texel };
    return _sunlit;
}

/** Draw the authored courses inside the visible land and inland-water mask. */
export function drawCloudShadowCourses(ctx, { atmosphere = null, region = null, coast = null, timeMs = 0, reducedMotion = false, lone = null } = {}) {
    const grade = atmosphere?.lightGrade;
    const strength = Math.max(0, Math.min(1, Number(grade?.cloudShadow) || 0));
    if (strength <= 0.02 || !region || region.length < 3 || typeof document === 'undefined') return false;
    const cover = Math.max(0, Math.min(1, Number(atmosphere?.weather?.cloudCover) || 0));
    const covered = cloudCoveredShare(cover);
    const mask = cloudLandClip(coast);
    if (!mask) return false;
    if (covered <= 0) {
        if (reducedMotion) return false;
        ctx.save();
        ctx.clip(mask);
        const drawn = drawLoneCloud(ctx, region, lone, 0.08 * strength);
        ctx.restore();
        return drawn;
    }
    const tile = courseCanvas(covered, 0.08 * strength);
    const pattern = ctx.createPattern(tile, 'repeat');
    if (!pattern) return false;
    const drift = cloudCourseDrift(reducedMotion ? null : timeMs, atmosphere?.weather);
    pattern.setTransform?.(new DOMMatrix([
        WORLD_PX_PER_TEXEL, 0, 0, WORLD_PX_PER_TEXEL,
        Math.round(drift.x), Math.round(drift.y),
    ]));
    ctx.save();
    ctx.clip(mask);
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
    const extentY = tile.height * WORLD_PX_PER_TEXEL;
    ctx.save();
    ctx.imageSmoothingEnabled = false;
    ctx.beginPath();
    ctx.moveTo(region[0].x, region[0].y);
    for (let index = 1; index < region.length; index++) ctx.lineTo(region[index].x, region[index].y);
    ctx.closePath();
    ctx.clip();
    ctx.globalCompositeOperation = 'multiply';
    ctx.drawImage(tile, Math.round(lone.x - extent / 2), Math.round(lone.y - extentY / 2), extent, extentY);
    ctx.restore();
    return true;
}
