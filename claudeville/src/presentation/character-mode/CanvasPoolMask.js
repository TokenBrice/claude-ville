// V5 / 1.2 Canvas parity — where the Canvas and hybrid PostFx light pools
// may land. The resident light loop lays a ground pool only on its ground
// receivers: never on open water (3.6 coast flag `water` and not `covered`:
// water takes only the 2.9 column), never on a landmark's walls or roofs
// (2.3 surface code faces 1-3; roofs take no local light) and never under a
// body's silhouette that a nearer building hides. The Canvas stamps and the
// hybrid `applyPools` pass run over the finished, flattened frame, so without
// a mask a lantern by the Harbor washed its facade, arches and the water
// under them orange, and a lamp by the gate smeared over its snowed tower
// roof.
//
// `poolReceiverMask` returns, per frame, a world-space alpha mask (1 texel
// per world px, the pools' own grid) over a snapped rect: alpha 255 where a
// pool may land. It is the parallel of the emitter cuts' occluder carve, in
// the other direction: ground receivers are kept, sprites are cut out.
//
// The static half (terrain receivers, landmark faces, static props) is built
// by replaying the depth pass's painter order with silhouettes only, and is
// cached until the camera gate or the bake changes; the moving half
// (villagers) is redrawn per frame over the previous frame's body rects, so
// the frame cost scales with the bodies on screen, not with the rect.
//
// Nothing here reads agent status, mood or director state: bodies are
// silhouettes only.

import { COAST_FIELD_FLAGS } from './CoastBake.js';
import { villagerOccluder } from './EmitterCuts.js';
import { hullGeometry } from './HarborHulls.js';

// The mask rect snaps to this grid (world px), so a pan inside one cell
// reuses the built static half.
const MASK_SNAP = 256;

// The world rect the frame's pools can reach: the union of every laying
// light's ground reach (its foot, its radius and the height above it that
// still reaches the ground) plus the prop lanterns, clamped to the visible
// rect. Null while no light lays a pool (the layer is empty anyway).
export function poolMaskRect(renderer, viewport) {
    const camera = renderer?.camera;
    if (!camera || !viewport?.width || !viewport?.height) return null;
    const a = camera.screenToWorld?.(0, 0);
    const b = camera.screenToWorld?.(viewport.width, viewport.height);
    if (!a || !b) return null;
    const view = {
        x0: Math.min(a.x, b.x),
        y0: Math.min(a.y, b.y),
        x1: Math.max(a.x, b.x),
        y1: Math.max(a.y, b.y),
    };
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    const add = (x, y, reach) => {
        if (!Number.isFinite(x) || !Number.isFinite(y)) return;
        const xa = Math.max(view.x0, x - reach);
        const xb = Math.min(view.x1, x + reach);
        const ya = Math.max(view.y0, y - reach);
        const yb = Math.min(view.y1, y + reach);
        if (xb <= xa || yb <= ya) return;
        if (xa < x0) x0 = xa;
        if (ya < y0) y0 = ya;
        if (xb > x1) x1 = xb;
        if (yb > y1) y1 = yb;
    };
    for (const light of renderer._frameLightSources?.ambient || []) {
        const foot = light?.ground || light;
        const radius = Math.max(1, Number(light?.radius) || 0);
        const height = Math.max(0, Number(light?.height) || 0);
        add(Number(foot?.x), Number(foot?.y), radius + height + 48);
    }
    const zoom = Math.max(1e-6, Number(camera.zoom) || 1);
    const lanternReach = Math.max(9, Math.round(14 * zoom)) / zoom + 48;
    for (const lantern of renderer._lanternGlowSources?.() || []) {
        add(Number(lantern?.x), Number(lantern?.y), lanternReach);
    }
    if (x1 <= x0 || y1 <= y0) return null;
    return { x0, y0, x1, y1 };
}

let groundFields = null;
let groundCanvas = null;

// The terrain's ground receivers at the coast field's 2-px cells: every cell
// but open water (a covered cell — dock, deck, bridge span, foundation — is
// ground). Outside the field lies the outer sea.
function groundMaskFor(fields) {
    if (groundFields === fields && groundCanvas) return groundCanvas;
    const { cols, rows, coastField } = fields;
    const canvas = groundCanvas || document.createElement('canvas');
    canvas.width = cols;
    canvas.height = rows;
    const ctx = canvas.getContext('2d');
    const image = ctx.createImageData(cols, rows);
    const data = image.data;
    for (let cell = 0; cell < cols * rows; cell++) {
        const flags = coastField[cell * 2 + 1];
        if ((flags & COAST_FIELD_FLAGS.water) && !(flags & COAST_FIELD_FLAGS.covered)) continue;
        data[cell * 4] = 255;
        data[cell * 4 + 1] = 255;
        data[cell * 4 + 2] = 255;
        data[cell * 4 + 3] = 255;
    }
    ctx.putImageData(image, 0, 0);
    groundFields = fields;
    groundCanvas = canvas;
    return canvas;
}

// Per landmark sprite: `{ cut, floor }`, its surface code's wall and roof
// texels (faces 1-3) and its up-facing ground texels (face 0), white where
// set. A landmark with no 2.3 channel cuts its whole opaque silhouette.
const landmarkMasks = new Map();
// Bumped when a landmark's 2.3 sidecar lands and its mask is rebuilt, so the
// cached static half rebuilds with it.
let maskRevision = 0;

function maskCanvasOf(w, h, data, keep) {
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    const image = ctx.createImageData(w, h);
    const out = image.data;
    for (let i = 0; i < w * h; i++) {
        if (!keep(i)) continue;
        out[i * 4] = 255;
        out[i * 4 + 1] = 255;
        out[i * 4 + 2] = 255;
        out[i * 4 + 3] = data[i * 4 + 3];
    }
    ctx.putImageData(image, 0, 0);
    return canvas;
}

function readPixels(image, w, h) {
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(image, 0, 0);
    const data = ctx.getImageData(0, 0, w, h).data;
    canvas.width = 0;
    canvas.height = 0;
    return data;
}

function buildLandmarkMask(albedo, occluder) {
    const w = albedo.naturalWidth || albedo.width;
    const h = albedo.naturalHeight || albedo.height;
    const pixels = readPixels(albedo, w, h);
    const sized = occluder
        && (occluder.naturalWidth || occluder.width) === w
        && (occluder.naturalHeight || occluder.height) === h;
    if (!sized) return { cut: maskCanvasOf(w, h, pixels, i => pixels[i * 4 + 3] > 0), floor: null };
    const code = readPixels(occluder, w, h);
    const face = i => (code[i * 4 + 3] > 0 ? code[i * 4 + 2] >> 6 : 0);
    return {
        cut: maskCanvasOf(w, h, pixels, i => pixels[i * 4 + 3] > 0 && face(i) !== 0),
        floor: maskCanvasOf(w, h, pixels, i => pixels[i * 4 + 3] > 0 && face(i) === 0),
    };
}

function landmarkMaskFor(assets, id) {
    const key = `${assets.assetVersion || ''}|${id}`;
    const cached = landmarkMasks.get(key);
    if (cached !== undefined) return cached;
    const albedo = assets.get?.(id);
    if (!albedo) return null;
    const entry = assets.getEntry?.(id);
    const companion = assets.getCompanion?.(id, 'occluder');
    const src = typeof albedo.src === 'string' ? albedo.src : '';
    // Until the 2.3 sidecar is read, the whole opaque silhouette cuts (a wall
    // or a roof kept lit is the defect this mask exists to fix); the floor
    // comes back when the sidecar lands.
    const mask = buildLandmarkMask(albedo, entry?.surfaceCode === true ? companion : null);
    landmarkMasks.set(key, mask);
    if (entry?.surfaceCode === true && !companion && src && typeof Image !== 'undefined') {
        // Canvas mode loads no channel companions: fetch the 2.3 sidecar
        // once beside the versioned albedo (as RoofWeather does) and rebuild.
        const image = new Image();
        image.onload = () => {
            landmarkMasks.set(key, buildLandmarkMask(albedo, image));
            maskRevision++;
        };
        image.src = src.replace(/\.png(?=([?#]|$))/, '.occluder.png');
    }
    return mask;
}

const ops = [];
const opPool = [];
let staticCanvas = null;
let staticCtx = null;
let maskCanvas = null;
let maskCtx = null;
let staticKey = '';
let rect = { x0: 0, y0: 0, x1: 0, y1: 0 };
let bodyRects = [];
let revision = 0;

function pushOp(sortY, kind, image, x, y, sx, sy, w, h) {
    const op = opPool[ops.length] || (opPool[ops.length] = {});
    op.sortY = sortY;
    op.kind = kind;
    op.image = image;
    op.x = x;
    op.y = y;
    op.sx = sx;
    op.sy = sy;
    op.w = w;
    op.h = h;
    ops.push(op);
}

function inRect(x, y, w, h) {
    return x < rect.x1 && x + w > rect.x0 && y < rect.y1 && y + h > rect.y0;
}

// Ground receivers, then every landmark (its wall and roof texels cut, its
// apron, deck and step texels laid back), every static prop's drawn
// silhouette cut, in the depth pass's painter order.
function rebuildStatic(renderer, assets) {
    const ctx = staticCtx;
    const w = rect.x1 - rect.x0;
    const h = rect.y1 - rect.y0;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, w, h);
    ctx.setTransform(1, 0, 0, 1, -rect.x0, -rect.y0);
    const fields = renderer._coastBake.waterFields;
    ctx.drawImage(groundMaskFor(fields), fields.x, fields.y, fields.cols * 2, fields.rows * 2);

    ops.length = 0;
    const seen = new Map();
    for (const drawable of renderer.buildingRenderer?.enumerateDrawables?.() || []) {
        const building = drawable.building;
        const id = drawable.entry?.id;
        if (!building || !id) continue;
        const prior = seen.get(building);
        if (prior) {
            // A split landmark's back and front halves share one sprite: the
            // later half's depth is where the whole sprite sits.
            prior.sortY = Math.max(prior.sortY, drawable.sortY);
            continue;
        }
        const mask = landmarkMaskFor(assets, id);
        const anchor = assets.getAnchor?.(id);
        if (!mask || !anchor) continue;
        const x = Math.round(drawable.wx - anchor[0]);
        const y = Math.round(drawable.wy - anchor[1]);
        if (!inRect(x, y, mask.cut.width, mask.cut.height)) continue;
        pushOp(drawable.sortY, 'landmark', mask, x, y, 0, 0, mask.cut.width, mask.cut.height);
        seen.set(building, ops[ops.length - 1]);
    }
    for (const sprite of renderer._staticPropSprites || []) {
        const cached = sprite?._cacheCanvas;
        if (!cached?.canvas || !inRect(cached.x, cached.y, cached.canvas.width, cached.canvas.height)) continue;
        pushOp(sprite.sortY ?? sprite.y, 'cut', cached.canvas, cached.x, cached.y, 0, 0, cached.canvas.width, cached.canvas.height);
    }
    // 3.8 — harbour hulls float on the water and take no ground pool on the
    // resident path (water takes none), so their drawn frame cuts like a prop.
    for (const item of renderer.harborTraffic?.enumerateHullDrawables?.() || []) {
        const pose = item?.pose;
        const strip = pose?.strip;
        if (!strip?.image) continue;
        const geometry = hullGeometry(pose);
        if (!inRect(geometry.x, geometry.y, geometry.width, geometry.height)) continue;
        pushOp(geometry.y + geometry.height, 'hull', strip.image, geometry.x, geometry.y, geometry.sx, 0, geometry.width, geometry.height);
    }
    ops.sort((a, b) => a.sortY - b.sortY);
    for (const op of ops) {
        if (op.kind === 'landmark') {
            ctx.globalCompositeOperation = 'destination-out';
            ctx.drawImage(op.image.cut, op.x, op.y);
            if (op.image.floor) {
                ctx.globalCompositeOperation = 'source-over';
                ctx.drawImage(op.image.floor, op.x, op.y);
            }
        } else {
            ctx.globalCompositeOperation = 'destination-out';
            if (op.sx || op.sy) ctx.drawImage(op.image, op.sx, op.sy, op.w, op.h, op.x, op.y, op.w, op.h);
            else ctx.drawImage(op.image, op.x, op.y);
        }
    }
    ctx.globalCompositeOperation = 'source-over';
    ctx.setTransform(1, 0, 0, 1, 0, 0);
}

function eachVillager(renderer, visit) {
    const agents = renderer.agentSprites instanceof Map ? renderer.agentSprites.values() : renderer.agentSprites || [];
    for (const sprite of agents) {
        if (!sprite?._bodyBox || !Number.isFinite(sprite.x)) continue;
        const body = villagerOccluder(sprite);
        if (body.image) visit(body);
    }
}

/**
 * QA diagnostics (Canvas has no debug channel): the built landmark masks —
 * their key, size and the texel counts of their cut and floor halves — and
 * the cache key of the static half currently in use.
 */
export function poolMaskDiagnostics() {
    const masks = [];
    for (const [key, value] of landmarkMasks) {
        if (!value) continue;
        const count = (canvas) => {
            if (!canvas) return 0;
            const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
            let n = 0;
            for (let i = 3; i < data.length; i += 4) if (data[i] > 0) n++;
            return n;
        };
        masks.push({ key, w: value.cut.width, h: value.cut.height, cut: count(value.cut), floor: count(value.floor) });
    }
    return { masks, staticKey, revision, snap: MASK_SNAP };
}

/**
 * The frame's pool receiver mask over the world rect `{ x0, y0, x1, y1 }`:
 * `{ canvas, x, y, w, h, revision }` (1 texel per world px; alpha 255 where a
 * pool may land), or null when the coast bake has not produced its fields yet
 * (then pools land everywhere, as before this mask existed). The canvas is
 * reused; draw or upload it before the next call.
 */
export function poolReceiverMask(renderer, worldRect) {
    const fields = renderer?._coastBake?.waterFields;
    if (!fields?.coastField || typeof document === 'undefined') return null;
    rect = {
        x0: Math.floor(worldRect.x0 / MASK_SNAP) * MASK_SNAP,
        y0: Math.floor(worldRect.y0 / MASK_SNAP) * MASK_SNAP,
    };
    rect.x1 = Math.ceil(worldRect.x1 / MASK_SNAP) * MASK_SNAP;
    rect.y1 = Math.ceil(worldRect.y1 / MASK_SNAP) * MASK_SNAP;
    const w = rect.x1 - rect.x0;
    const h = rect.y1 - rect.y0;
    const assets = renderer.assets;
    if (!staticCanvas) {
        staticCanvas = document.createElement('canvas');
        staticCtx = staticCanvas.getContext('2d');
        maskCanvas = document.createElement('canvas');
        maskCtx = maskCanvas.getContext('2d');
    }
    if (staticCanvas.width !== w || staticCanvas.height !== h) {
        staticCanvas.width = w;
        staticCanvas.height = h;
        maskCanvas.width = w;
        maskCanvas.height = h;
        staticKey = '';
        bodyRects = [];
    }
    const key = `${rect.x0},${rect.y0},${w}x${h}|${fields.revision ?? ''}|${renderer.terrainCacheKey || ''}|${assets?.assetVersion || ''}|${maskRevision}`;
    if (key !== staticKey) {
        rebuildStatic(renderer, assets || { get: () => null });
        staticKey = key;
        maskCtx.setTransform(1, 0, 0, 1, 0, 0);
        maskCtx.globalCompositeOperation = 'source-over';
        maskCtx.imageSmoothingEnabled = false;
        maskCtx.clearRect(0, 0, w, h);
        maskCtx.drawImage(staticCanvas, 0, 0);
        bodyRects = [];
    }
    const ctx = maskCtx;
    const next = [];
    eachVillager(renderer, (body) => {
        if (!inRect(body.x, body.y, body.w, body.h)) return;
        next.push({ x: body.x, y: body.y, w: body.w, h: body.h });
    });
    // Restore last frame's body texels from the static half first, so a body
    // that moved leaves no lit trail.
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    for (const r of bodyRects) {
        ctx.clearRect(r.x - rect.x0 - 1, r.y - rect.y0 - 1, r.w + 2, r.h + 2);
        ctx.drawImage(staticCanvas, r.x - rect.x0 - 1, r.y - rect.y0 - 1, r.w + 2, r.h + 2,
            r.x - rect.x0 - 1, r.y - rect.y0 - 1, r.w + 2, r.h + 2);
    }
    if (next.length) {
        ctx.setTransform(1, 0, 0, 1, -rect.x0, -rect.y0);
        eachVillager(renderer, (body) => {
            if (!inRect(body.x, body.y, body.w, body.h)) return;
            ctx.drawImage(body.image, body.sx, body.sy, body.w, body.h, body.x, body.y, body.w, body.h);
        });
        ctx.setTransform(1, 0, 0, 1, 0, 0);
    }
    bodyRects = next;
    revision++;
    return { canvas: maskCanvas, x: rect.x0, y: rect.y0, w, h, revision };
}
