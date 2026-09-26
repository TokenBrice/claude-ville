// 1.5 — golden-hour and sunrise raking shadows, without normals.
//
// The low sun reads through the C2 grade: its split tone already warms the
// baked upper-left highlights; here the cast shadows lengthen and turn violet.
// `rake` comes from the same grade — the evaluator's authored per-key rake,
// gated here by how much direct sun is left — so it peaks at golden hour and
// at sunrise, sits at 0 through the middle of the day and at night, and
// flattens under overcast (the weather rows scale it down with the split).
//
// Every cast is a stepped stamp baked once per sun bucket (rake in eighths,
// shadow angle in 1/16 rad): flat alpha courses on the world texel grid,
// 2-texel rows, no gradients. Buildings, trees and villagers share the same
// cast language, and both backends blit the same canvases (the resident path
// uploads a stamp only when its bucket key changes). No per-frame shadow
// work beyond placing the cached stamps.

import { releaseCanvasBackingStore } from './CanvasBudget.js';

const COLD = [15, 22, 30];      // #0f161e — the midday contact shadow
const VIOLET = [42, 35, 70];    // #2a2346 — the golden-hour shadow
const ROW = 2;                  // stepped ellipse rows, in texels

let _castGrade = null;
let _castLighting = null;
let _cast = null;
let _frameCast = null;

function clamp(value, min = 0, max = 1) {
    return Math.max(min, Math.min(max, value));
}

function finite(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

/** 0..1 in eighths: how raking the sun is under this grade. */
export function rakeForGrade(grade) {
    const direct = clamp(finite(grade?.daylight, 1) / 0.5);
    // The power keeps the long light to the last hours around the keys.
    return Math.round(Math.pow(clamp(finite(grade?.rake, 0)) * direct, 1.5) * 8) / 8;
}

/**
 * The cast state for one atmosphere snapshot, memoized on its grade and
 * lighting objects. `length` scales cast distance (0.72 at midday as before,
 * up to 2.3 at golden hour); at night the moon keeps the lighting model's
 * own length. `key` changes only when a baked stamp would change.
 */
export function castLightingFor(atmosphere) {
    const grade = atmosphere?.lightGrade || null;
    const lighting = atmosphere?.lighting || null;
    if (_cast && grade === _castGrade && lighting === _castLighting) return _cast;
    const rake = rakeForGrade(grade);
    const night = finite(grade?.night, 0) >= 0.5;
    const rawAngle = Number.isFinite(lighting?.shadowAngleRad) ? lighting.shadowAngleRad : 0.28;
    const angle = Math.round(rawAngle * 16) / 16;
    const length = night ? clamp(finite(lighting?.shadowLength, 1), 0.45, 2.4) : 0.72 + 1.6 * rake;
    const lengthBucket = Math.round(length * 8) / 8;
    const color = COLD.map((channel, index) => Math.round(channel + (VIOLET[index] - channel) * rake));
    // A thrown canopy shadow needs a visible sun: the grade's sun band is 0
    // at night and under rain/storm/overcast, which leave contact only.
    const sun = finite(grade?.sunBand, 1) >= 0.5;
    _castGrade = grade;
    _castLighting = lighting;
    _cast = Object.freeze({
        rake,
        angle,
        length: lengthBucket,
        sun,
        // The low sun throws a denser cast: the lighting model's contact
        // alpha (0.12–0.42) gains up to 0.44 at full rake, so the long violet
        // courses still read on dark grass after the golden-hour grade.
        alpha: Math.min(0.74, finite(lighting?.shadowAlpha, 0.22) + 0.44 * rake),
        color,
        key: `${rake}|${angle}|${lengthBucket}|${sun ? 's' : 'o'}`,
    });
    return _cast;
}

/** Called once per frame by the frame renderer; read by the villager marks. */
export function setFrameCastLighting(cast) {
    _frameCast = cast || null;
}

export function frameCastLighting() {
    return _frameCast;
}

function makeCanvas(width, height) {
    if (typeof document === 'undefined') return null;
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, width);
    canvas.height = Math.max(1, height);
    return canvas;
}

/**
 * Rasterise stepped ellipses `{ x, y, rx, ry, alpha }` (texel coordinates
 * relative to the anchor) into one canvas. Where stamps overlap the pixel
 * takes the strongest course instead of summing, so the cast reads as flat
 * courses. Returns `{ canvas, offsetX, offsetY }` — the canvas' top-left
 * relative to the anchor.
 */
export function rasterizeCourses(stamps, rgb) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const s of stamps) {
        minX = Math.min(minX, Math.floor(s.x - s.rx));
        maxX = Math.max(maxX, Math.ceil(s.x + s.rx));
        minY = Math.min(minY, Math.floor((s.y - s.ry) / ROW) * ROW - ROW);
        maxY = Math.max(maxY, Math.ceil((s.y + s.ry) / ROW) * ROW + ROW);
    }
    if (!Number.isFinite(minX)) return null;
    const width = maxX - minX;
    const height = maxY - minY;
    const canvas = makeCanvas(width, height);
    if (!canvas) return null;
    const alpha = new Uint8Array(width * height);
    for (const s of stamps) {
        const a = Math.round(clamp(s.alpha) * 255);
        const ry = Math.max(1, s.ry);
        for (let row = -Math.ceil(ry / ROW) * ROW; row <= ry; row += ROW) {
            const normalized = (row + ROW / 2) / ry;
            if (Math.abs(normalized) >= 1) continue;
            const half = s.rx * Math.sqrt(1 - normalized * normalized);
            const x0 = Math.round(s.x - half) - minX;
            const x1 = Math.round(s.x + half) - minX;
            // Rows share one even grid across stamps, so courses stack cleanly.
            const y0 = Math.round((s.y + row) / ROW) * ROW - minY;
            for (let y = y0; y < y0 + ROW; y++) {
                if (y < 0 || y >= height) continue;
                for (let x = Math.max(0, x0); x < Math.min(width, x1); x++) {
                    const index = y * width + x;
                    if (alpha[index] < a) alpha[index] = a;
                }
            }
        }
    }
    const ctx = canvas.getContext('2d');
    const image = ctx.createImageData(width, height);
    for (let index = 0; index < alpha.length; index++) {
        if (!alpha[index]) continue;
        const offset = index * 4;
        image.data[offset] = rgb[0];
        image.data[offset + 1] = rgb[1];
        image.data[offset + 2] = rgb[2];
        image.data[offset + 3] = alpha[index];
    }
    ctx.putImageData(image, 0, 0);
    return { canvas, offsetX: minX, offsetY: minY };
}

// A trail of shrinking stepped ellipses from (0, 0) along the shadow angle.
// Iso ground: the y reach is squashed to 0.55 of the x reach.
function castTrail(cast, reach, rx, ry, count, alphaFrom, alphaTo, shrinkX = 0.6, shrinkY = 0.7) {
    const stamps = [];
    const dx = Math.cos(cast.angle);
    const dy = Math.sin(cast.angle) * 0.55;
    for (let index = 1; index <= count; index++) {
        const t = index / count;
        stamps.push({
            x: dx * reach * t,
            y: dy * reach * t,
            rx: Math.max(2, rx * (1 - t * shrinkX)),
            ry: Math.max(2, ry * (1 - t * shrinkY)),
            // Stepped courses: quantized to eighths so neighbours share values.
            alpha: Math.round((alphaFrom + (alphaTo - alphaFrom) * t) * 8) / 8,
        });
    }
    return stamps;
}

const _structureCasts = new Map();

/**
 * One building's ground cast: the structural contact ellipse, shifted along
 * the sun as before (0.3 → 0.3 + 0.9 x rake of the cast offset), plus a
 * raking trail — 0–3 extra courses for low buildings, 4–6 for tower casts
 * (towers throw theirs only under a visible sun). Anchored at the building's
 * contact centre (drawable world position + contact offset). Cached per
 * building and cast key.
 */
export function structureCast(buildingId, grounding, contact, cast) {
    if (!contact || !(contact.width > 0) || !(contact.depth > 0) || !cast) return null;
    const tower = grounding?.shadow === 'tower-cast' && contact.castLength > 0 && cast.sun;
    const key = `${cast.key}|${contact.width}|${contact.depth}|${contact.castLength || 0}|${tower ? 't' : 's'}`;
    const cached = _structureCasts.get(buildingId);
    if (cached?.key === key) return cached;
    const offsetScale = (tower ? 0.72 : 0.3) + 0.9 * cast.rake;
    const baseX = Math.cos(cast.angle) * 12 * cast.length * offsetScale;
    const baseY = Math.sin(cast.angle) * 7 * cast.length * offsetScale;
    const rx = contact.width / 2;
    const ry = contact.depth / 2;
    const stamps = [{ x: baseX, y: baseY, rx, ry, alpha: 1 }];
    if (tower) {
        const reach = contact.castLength * Math.max(0.45, cast.length);
        const count = 4 + Math.round(cast.rake * 2);
        for (const s of castTrail(cast, reach, rx, ry, count, 0.62, 0.18, 0.68, 0.76)) {
            stamps.push({ ...s, x: s.x + baseX, y: s.y + baseY });
        }
    } else if (cast.rake > 0) {
        const reach = Math.max(40, contact.depth * 2.4) * cast.rake * 1.4;
        const count = Math.max(1, Math.round(cast.rake * 3));
        for (const s of castTrail(cast, reach, rx, ry, count, 0.62, 0.3, 0.3, 0.35)) {
            stamps.push({ ...s, x: s.x + baseX, y: s.y + baseY });
        }
    }
    const raster = rasterizeCourses(stamps, cast.color);
    if (!raster) return null;
    const entry = { ...raster, key };
    if (cached) releaseCanvasBackingStore(cached.canvas);
    _structureCasts.set(buildingId, entry);
    return entry;
}

const _treeCasts = new Map();
// Tree casts sit a touch lighter than structural contact.
export const TREE_CAST_ALPHA = 0.85;

/**
 * A tree's ground cast from its trunk base: a dense contact under the roots,
 * then — only under a visible sun — a trunk trail and the canopy's shadow
 * thrown along the sun as two flat courses (a denser core inside a lighter
 * rim): a short pool beside the tree at midday, a long violet cast of ~1.7x
 * the tree height at golden hour, contact only at night and under overcast.
 * `width` and `height` are the tree sprite's extent in texels. Cached per
 * size and cast key; the cache holds only the current key. `sizeKey` names
 * the stamp's tree size alone, so a GPU texture keyed by it re-uploads only
 * when the sun bucket changes (two sizes can share a canvas size).
 */
export function treeCast(width, height, cast) {
    if (!cast) return null;
    const w = Math.max(8, Math.round(width));
    const h = Math.max(8, Math.round(height));
    const key = `${cast.key}|${w}|${h}`;
    const hit = _treeCasts.get(key);
    if (hit) return hit;
    for (const [oldKey, entry] of _treeCasts) {
        if (oldKey.startsWith(`${cast.key}|`)) continue;
        releaseCanvasBackingStore(entry.canvas);
        _treeCasts.delete(oldKey);
    }
    const stamps = [{ x: 0, y: 0, rx: Math.max(3, w * 0.22), ry: Math.max(2, w * 0.09), alpha: 1 }];
    if (cast.sun) {
        const reach = h * (0.16 + 1.5 * cast.rake);
        const dx = Math.cos(cast.angle);
        const dy = Math.sin(cast.angle) * 0.55;
        // Trunk: a narrow band from the roots to where the canopy's shadow starts.
        const trunkEnd = reach * 0.45;
        const trunkSteps = Math.max(1, Math.round(trunkEnd / 4));
        for (let index = 1; index <= trunkSteps; index++) {
            const t = index / trunkSteps;
            stamps.push({ x: dx * trunkEnd * t, y: dy * trunkEnd * t, rx: Math.max(2, w * 0.06), ry: 2, alpha: 1 });
        }
        // Canopy: overlapping ellipses along the sun from 0.45 to 1.0 of the
        // reach, stretched with the rake; each lays a rim course and a core.
        const canopyRx = Math.max(4, w * 0.3);
        const canopyRy = Math.max(3, w * 0.14);
        const canopySteps = 1 + Math.round(cast.rake * 4);
        for (let index = 0; index < canopySteps; index++) {
            const t = canopySteps === 1 ? 1 : 0.45 + 0.55 * (index / (canopySteps - 1));
            const taper = 1 - 0.25 * (canopySteps === 1 ? 0 : index / (canopySteps - 1));
            const x = dx * reach * t;
            const y = dy * reach * t;
            stamps.push({ x, y, rx: canopyRx * taper, ry: canopyRy * taper, alpha: 0.75 });
            stamps.push({ x, y, rx: Math.max(2, canopyRx * taper - 4), ry: Math.max(2, canopyRy * taper - 2), alpha: 1 });
        }
    }
    const raster = rasterizeCourses(stamps, cast.color);
    if (!raster) return null;
    const entry = { ...raster, key, sizeKey: `${w}x${h}` };
    _treeCasts.set(key, entry);
    return entry;
}

/**
 * Canvas fallback: blit the cached tree casts for the trees on screen, in
 * world space (the caller holds the camera transform), on the ground layer.
 */
export function drawTreeCasts(ctx, trees, cast, camera, viewport) {
    if (!ctx || !trees?.length || !cast || !camera?.worldToScreen) return;
    const margin = 160;
    ctx.save();
    ctx.imageSmoothingEnabled = false;
    ctx.globalAlpha = cast.alpha * TREE_CAST_ALPHA;
    for (const tree of trees) {
        const p = camera.worldToScreen(tree.x, tree.y);
        if (p.x < -margin || p.y < -margin || p.x > viewport.width + margin || p.y > viewport.height + margin) continue;
        const bounds = tree.bounds || {};
        const baked = treeCast(finite(bounds.right) - finite(bounds.left), -finite(bounds.top), cast);
        if (baked) ctx.drawImage(baked.canvas, Math.round(tree.x) + baked.offsetX, Math.round(tree.y) + baked.offsetY);
    }
    ctx.restore();
}

/**
 * The villager's raking trail (the contact shadow itself stays in
 * AgentGroundMarks): 0 below golden light, else a violet trail from the feet
 * along the sun, as long as ~1.2x the body at full rake. Its courses sit at
 * the contact core's density near the feet and step down to the outer one.
 */
export function villagerCastStamps(contactWidth, cast) {
    if (!cast || cast.rake <= 0) return [];
    const bodyHeight = Math.max(24, contactWidth * 2.1);
    const reach = bodyHeight * 1.2 * cast.rake;
    const count = Math.max(2, Math.round(reach / 6));
    return castTrail(cast, reach, contactWidth * 0.36, Math.max(2, contactWidth * 0.13), count, 0.25 + 0.3 * cast.rake, 0.3, 0.3, 0.2);
}
