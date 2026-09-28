// 3.8 / PT-6 — held Codex equipment at the world texel, with no runtime
// rotate or scale. A weapon (asset PNG or procedural painter) is rasterized
// once, unrotated, at one pixel per source texel with binary alpha; the pose
// (flip, scale, lean angle) is then applied by cleanEdge resampling into a
// frame of one output pixel per world texel, and the frame is blitted at a
// whole-pixel offset from the grip. Canvas bodies and the resident equipped
// sheet draw the same frames, so both backends show k x k weapon texels.

import { resampleCleanEdge } from './CleanEdge.js';

// Scratch surface for unrotated sources: the grip sits at its centre, so a
// painter may reach SOURCE_HALF texels in every direction (the longest shaft,
// the greatsword, reaches 54; assets are at most 112 px).
const SOURCE_HALF = 128;
let scratch = null;

function scratchContext() {
    if (!scratch) {
        const canvas = document.createElement('canvas');
        canvas.width = SOURCE_HALF * 2;
        canvas.height = SOURCE_HALF * 2;
        scratch = canvas.getContext('2d', { willReadFrequently: true });
    }
    return scratch;
}

// Paint `paint(ctx)` with the grip at the origin and return the trimmed
// binary-alpha source: { data, width, height, originX, originY } where
// origin is the grip in source texels, or null when nothing was painted.
export function rasterWeaponSource(paint) {
    const ctx = scratchContext();
    const side = SOURCE_HALF * 2;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, side, side);
    ctx.imageSmoothingEnabled = false;
    ctx.setTransform(1, 0, 0, 1, SOURCE_HALF, SOURCE_HALF);
    ctx.save();
    paint(ctx);
    ctx.restore();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const image = ctx.getImageData(0, 0, side, side);
    const src = image.data;
    let minX = side; let minY = side; let maxX = -1; let maxY = -1;
    for (let y = 0; y < side; y++) {
        for (let x = 0; x < side; x++) {
            const i = (y * side + x) << 2;
            // Painters stroke with anti-aliased paths: snap coverage to the
            // binary alpha the art uses so cleanEdge compares true colours.
            if (src[i + 3] < 128) { src[i + 3] = 0; continue; }
            src[i + 3] = 255;
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
        }
    }
    if (maxX < 0) return null;
    const width = maxX - minX + 1;
    const height = maxY - minY + 1;
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) {
        const from = ((minY + y) * side + minX) << 2;
        data.set(src.subarray(from, from + (width << 2)), (y * width) << 2);
    }
    return { data, width, height, originX: SOURCE_HALF - minX, originY: SOURCE_HALF - minY };
}

// Resample `source` through the pose: world = flipX(scale * R(angle) * local).
// Returns { canvas, offsetX, offsetY }: draw the canvas 1:1 in world px at
// (round(grip.x) + offsetX, round(grip.y) + offsetY).
export function bakeWeaponFrame(source, { angle = 0, scale = 1, flipX = false } = {}) {
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const toWorld = (lx, ly) => {
        const x = (cos * lx - sin * ly) * scale;
        const y = (sin * lx + cos * ly) * scale;
        return [flipX ? -x : x, y];
    };
    const corners = [
        toWorld(-source.originX, -source.originY),
        toWorld(source.width - source.originX, -source.originY),
        toWorld(source.width - source.originX, source.height - source.originY),
        toWorld(-source.originX, source.height - source.originY),
    ];
    const offsetX = Math.floor(Math.min(...corners.map(c => c[0]))) - 1;
    const offsetY = Math.floor(Math.min(...corners.map(c => c[1]))) - 1;
    const width = Math.max(1, Math.ceil(Math.max(...corners.map(c => c[0]))) + 1 - offsetX);
    const height = Math.max(1, Math.ceil(Math.max(...corners.map(c => c[1]))) + 1 - offsetY);
    const inverse = (ox, oy) => {
        const wx = (ox + offsetX) * (flipX ? -1 : 1) / scale;
        const wy = (oy + offsetY) / scale;
        return [cos * wx + sin * wy + source.originX, -sin * wx + cos * wy + source.originY];
    };
    const pixels = resampleCleanEdge(source, width, height, inverse);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    canvas.getContext('2d').putImageData(new ImageData(pixels, width, height), 0, 0);
    return { canvas, offsetX, offsetY };
}
