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
// directly into the single receiver mask canvas by replaying the depth pass's
// painter order with silhouettes only, and is cached until the camera gate or
// the bake changes. Clean static pixels beneath visible moving bodies
// (villagers) are saved into a compact shelf-packed backup canvas before bodies
// are composited; on body changes, only those backed-up body footprints are
// restored and re-saved, so memory stays at one mask canvas plus a small
// body-footprint backup while frame cost scales with visible bodies.
//
// Nothing here reads agent status, mood or director state: bodies are
// silhouettes only.

import { COAST_FIELD_FLAGS } from './CoastBake.js';
import { canvasPixelCount, releaseCanvasBackingStore } from './CanvasBudget.js';
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

// Paint the terrain's ground receivers at the coast field's 2-px cells
// directly into the receiver mask over `bounds`: every cell but open water
// (a covered cell — dock, deck, bridge span, foundation — is ground). Outside
// the field lies the outer sea. Drawing horizontal runs straight into the
// target canvas avoids retaining a persistent full-world ground mask canvas.
function drawGroundMask(ctx, fields, bounds) {
    const { cols, rows, coastField, x: fx, y: fy } = fields;
    if (!cols || !rows || !coastField) return;
    const cx0 = Math.max(0, Math.floor((bounds.x0 - fx) / 2));
    const cx1 = Math.min(cols, Math.ceil((bounds.x1 - fx) / 2));
    const cy0 = Math.max(0, Math.floor((bounds.y0 - fy) / 2));
    const cy1 = Math.min(rows, Math.ceil((bounds.y1 - fy) / 2));
    if (cx1 <= cx0 || cy1 <= cy0) return;
    const WATER = COAST_FIELD_FLAGS.water;
    const COVERED = COAST_FIELD_FLAGS.covered;
    ctx.fillStyle = '#ffffff';
    for (let cy = cy0; cy < cy1; cy++) {
        const rowBase = cy * cols;
        const wy = fy + cy * 2;
        let runStart = -1;
        for (let cx = cx0; cx < cx1; cx++) {
            const flags = coastField[(rowBase + cx) * 2 + 1];
            const isGround = !((flags & WATER) && !(flags & COVERED));
            if (isGround) {
                if (runStart < 0) runStart = cx;
            } else if (runStart >= 0) {
                ctx.fillRect(fx + runStart * 2, wy, (cx - runStart) * 2, 2);
                runStart = -1;
            }
        }
        if (runStart >= 0) {
            ctx.fillRect(fx + runStart * 2, wy, (cx1 - runStart) * 2, 2);
        }
    }
}

// Per landmark sprite: `{ w, h, cut, floor }`, where `cut` and `floor` are
// tightly cropped `{ canvas, ox, oy }` masks (or null when empty) for its
// surface code's wall/roof texels (faces 1-3) and up-facing ground texels
// (face 0), white where set. A landmark with no 2.3 channel cuts its whole
// opaque silhouette.
const landmarkMasks = new Map();
// Bumped when a landmark's 2.3 sidecar lands and its mask is rebuilt, so the
// cached static half rebuilds with it.
let maskRevision = 0;

function releaseLandmarkMask(mask) {
    if (!mask) return;
    releaseCanvasBackingStore(mask.cut);
    releaseCanvasBackingStore(mask.floor);
}

function maskCanvasOf(w, h, data, keep) {
    let minX = w;
    let minY = h;
    let maxX = -1;
    let maxY = -1;
    for (let y = 0; y < h; y++) {
        const row = y * w;
        for (let x = 0; x < w; x++) {
            if (!keep(row + x)) continue;
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
        }
    }
    if (maxX < minX) return null;
    const cw = maxX - minX + 1;
    const ch = maxY - minY + 1;
    const canvas = document.createElement('canvas');
    canvas.width = cw;
    canvas.height = ch;
    const ctx = canvas.getContext('2d');
    const image = ctx.createImageData(cw, ch);
    const out = image.data;
    for (let y = 0; y < ch; y++) {
        const srcRow = (minY + y) * w + minX;
        const dstRow = y * cw;
        for (let x = 0; x < cw; x++) {
            const si = srcRow + x;
            if (!keep(si)) continue;
            const di = (dstRow + x) * 4;
            out[di] = 255;
            out[di + 1] = 255;
            out[di + 2] = 255;
            out[di + 3] = data[si * 4 + 3];
        }
    }
    ctx.putImageData(image, 0, 0);
    return { canvas, ox: minX, oy: minY };
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
    if (!sized) return { w, h, cut: maskCanvasOf(w, h, pixels, i => pixels[i * 4 + 3] > 0), floor: null };
    const code = readPixels(occluder, w, h);
    const face = i => (code[i * 4 + 3] > 0 ? code[i * 4 + 2] >> 6 : 0);
    return {
        w,
        h,
        cut: maskCanvasOf(w, h, pixels, i => pixels[i * 4 + 3] > 0 && face(i) !== 0),
        floor: maskCanvasOf(w, h, pixels, i => pixels[i * 4 + 3] > 0 && face(i) === 0),
    };
}

function landmarkMaskFor(assets, id) {
    const albedo = assets.get?.(id);
    if (!albedo) return null;
    const entry = assets.getEntry?.(id);
    const companion = entry?.surfaceCode === true ? (assets.getCompanion?.(id, 'occluder') || null) : null;
    const key = `${assets.assetVersion || ''}|${id}`;
    const cached = landmarkMasks.get(key);
    if (cached && cached.albedo === albedo
        && (cached.companion === companion || (!companion && cached.sidecarLoaded))) {
        return cached.mask;
    }
    const src = typeof albedo.src === 'string' ? albedo.src : '';
    // Until the 2.3 sidecar is read, the whole opaque silhouette cuts (a wall
    // or a roof kept lit is the defect this mask exists to fix); the floor
    // comes back when the sidecar lands.
    const mask = buildLandmarkMask(albedo, companion);
    const record = { albedo, companion, sidecarLoaded: false, mask };
    landmarkMasks.set(key, record);
    if (cached) {
        releaseLandmarkMask(cached.mask);
        maskRevision++;
    }
    if (entry?.surfaceCode === true && !companion && src && typeof Image !== 'undefined') {
        // Canvas mode loads no channel companions: fetch the 2.3 sidecar
        // once beside the versioned albedo (as RoofWeather does) and rebuild.
        const image = new Image();
        image.onload = () => {
            if (landmarkMasks.get(key) !== record) return;
            const prevMask = record.mask;
            record.mask = buildLandmarkMask(albedo, image);
            releaseLandmarkMask(prevMask);
            record.sidecarLoaded = true;
            maskRevision++;
        };
        image.src = src.replace(/\.png(?=([?#]|$))/, '.occluder.png');
    }
    return mask;
}

const EMPTY_DIRTY_RECTS = Object.freeze([]);
const DIRTY_MERGE_PAD = 4;
const BACKUP_QUANT = 64;
const BACKUP_MIN_SHRINK_PIXELS = 256 * 256;

const ops = [];
const opPool = [];
let maskCanvas = null;
let maskCtx = null;
let backupCanvas = null;
let backupCtx = null;
let staticDocument = null;
let staticKey = '';
let staticRenderer = null;
let staticFields = null;
let staticLandmarkEntries = [];
let staticPendingLandmarkIds = [];
let staticPropArray = null;
let staticPropCount = 0;
let staticPropState = [];
let rect = { x0: 0, y0: 0, x1: 0, y1: 0 };
let prevBodies = [];
let prevSavedSlots = [];
let revision = 0;
let staticRebuilds = 0;
let bodyUpdates = 0;
let bodyReuses = 0;
let lastDirtyRects = 0;
let lastDirtyPixels = 0;

export function poolReceiverMaskPixels(renderer) {
    if (staticRenderer !== renderer) return 0;
    let pixels = canvasPixelCount(maskCanvas) + canvasPixelCount(backupCanvas);
    for (const { mask } of landmarkMasks.values()) {
        pixels += canvasPixelCount(mask.cut) + canvasPixelCount(mask.floor);
    }
    return pixels;
}

export function releasePoolReceiverMask(renderer) {
    if (!staticRenderer || staticRenderer !== renderer) return;
    for (const canvas of [maskCanvas, backupCanvas]) releaseCanvasBackingStore(canvas);
    for (const { mask } of landmarkMasks.values()) releaseLandmarkMask(mask);
    landmarkMasks.clear();
    maskCanvas = backupCanvas = null;
    staticDocument = null;
    maskCtx = backupCtx = null;
    staticRenderer = staticFields = staticPropArray = null;
    staticKey = '';
    staticLandmarkEntries.length = staticPendingLandmarkIds.length = staticPropState.length = 0;
    ops.length = opPool.length = prevBodies.length = prevSavedSlots.length = 0;
}

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
// silhouette cut, in the depth pass's painter order — painted directly into
// the single receiver mask canvas.
function rebuildStatic(renderer, assets) {
    const ctx = maskCtx;
    const w = rect.x1 - rect.x0;
    const h = rect.y1 - rect.y0;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, w, h);
    ctx.setTransform(1, 0, 0, 1, -rect.x0, -rect.y0);
    const fields = renderer._coastBake.waterFields;
    drawGroundMask(ctx, fields, rect);

    ops.length = 0;
    staticLandmarkEntries = [];
    staticPendingLandmarkIds = [];
    const seen = new Map();
    const seenIds = new Set();
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
        const albedo = assets.get?.(id) || null;
        if (!albedo) {
            if (!seenIds.has(id)) {
                seenIds.add(id);
                staticPendingLandmarkIds.push(id);
            }
            continue;
        }
        const mask = landmarkMaskFor(assets, id);
        const anchor = assets.getAnchor?.(id);
        if (!mask || !anchor) continue;
        const x = Math.round(drawable.wx - anchor[0]);
        const y = Math.round(drawable.wy - anchor[1]);
        if (!seenIds.has(id)) {
            seenIds.add(id);
            const entry = assets.getEntry?.(id);
            const companion = entry?.surfaceCode === true ? (assets.getCompanion?.(id, 'occluder') || null) : null;
            staticLandmarkEntries.push({ id, albedo, companion });
        }
        if (!inRect(x, y, mask.w, mask.h)) continue;
        pushOp(drawable.sortY, 'landmark', mask, x, y, 0, 0, mask.w, mask.h);
        seen.set(building, ops[ops.length - 1]);
    }
    const props = renderer._staticPropSprites || [];
    staticPropArray = props;
    staticPropCount = props.length;
    staticPropState = new Array(props.length);
    for (let i = 0; i < props.length; i++) {
        const sprite = props[i];
        const cached = sprite?._cacheCanvas;
        const hasCache = Boolean(cached?.canvas);
        staticPropState[i] = {
            sprite,
            canvas: cached?.canvas,
            sortY: sprite?.sortY ?? sprite?.y,
            gpuRev: sprite?._gpuCacheRevision || 0,
            canvasRev: hasCache ? (cached.canvas._revision ?? cached.canvas.revision ?? 0) : 0,
            x: hasCache ? cached.x : 0,
            y: hasCache ? cached.y : 0,
            w: hasCache ? cached.canvas.width : 0,
            h: hasCache ? cached.canvas.height : 0,
            frameGroup: null,
            baseIndex: -1,
        };
        if (!hasCache || !inRect(cached.x, cached.y, cached.canvas.width, cached.canvas.height)) continue;
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
    // An authored fixed-frame overlay (FountainWaterSprite) whose texels are
    // covered by a co-located resident opaque base prop at <= sortY keeps the
    // static mask stable while cycling its own generated frame group.
    for (let i = 0; i < props.length; i++) {
        const sprite = props[i];
        const baseId = sprite?.poolMaskStaticBaseId;
        const group = baseId ? sprite.poolMaskFrameGroup?.(sprite._cacheCanvas) : null;
        const cur = staticPropState[i];
        if (!cur.canvas || !group) continue;
        const baseIndex = props.findIndex((p, j) => {
            if (j === i || p?.id !== baseId) return false;
            const b = staticPropState[j];
            return Boolean(b.canvas) && b.x === cur.x && b.y === cur.y && b.w === cur.w && b.h === cur.h
                && b.sortY <= cur.sortY;
        });
        if (baseIndex < 0) continue;
        const baseSortY = staticPropState[baseIndex].sortY;
        const blockedByFloor = ops.some((op) => {
            if (op.kind !== 'landmark' || !op.image.floor || op.sortY < baseSortY || op.sortY > cur.sortY) return false;
            const fx = op.x + op.image.floor.ox;
            const fy = op.y + op.image.floor.oy;
            return fx < cur.x + cur.w && fx + op.image.floor.canvas.width > cur.x
                && fy < cur.y + cur.h && fy + op.image.floor.canvas.height > cur.y;
        });
        if (!blockedByFloor) {
            cur.frameGroup = group;
            cur.baseIndex = baseIndex;
        }
    }
    for (const op of ops) {
        if (op.kind === 'landmark') {
            if (op.image.cut) {
                ctx.globalCompositeOperation = 'destination-out';
                ctx.drawImage(op.image.cut.canvas, op.x + op.image.cut.ox, op.y + op.image.cut.oy);
            }
            if (op.image.floor) {
                ctx.globalCompositeOperation = 'source-over';
                ctx.drawImage(op.image.floor.canvas, op.x + op.image.floor.ox, op.y + op.image.floor.oy);
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

function staticSourcesChanged(renderer, assets) {
    for (let i = 0; i < staticPendingLandmarkIds.length; i++) {
        if (assets.get?.(staticPendingLandmarkIds[i])) return true;
    }
    for (let i = 0; i < staticLandmarkEntries.length; i++) {
        const item = staticLandmarkEntries[i];
        const albedo = assets.get?.(item.id) || null;
        if (albedo !== item.albedo) return true;
        const entry = assets.getEntry?.(item.id);
        const companion = entry?.surfaceCode === true ? (assets.getCompanion?.(item.id, 'occluder') || null) : null;
        if (companion !== item.companion) return true;
    }
    const props = renderer._staticPropSprites || [];
    if (props !== staticPropArray || props.length !== staticPropCount) return true;
    for (let i = 0; i < props.length; i++) {
        const sprite = props[i];
        const prev = staticPropState[i];
        const cached = sprite?._cacheCanvas;
        const hasCache = Boolean(cached?.canvas);
        if (sprite !== prev.sprite || (sprite?._gpuCacheRevision || 0) !== prev.gpuRev) return true;
        if (hasCache && (sprite.sortY ?? sprite.y) !== prev.sortY) return true;
        if (hasCache && ((cached.canvas._revision ?? cached.canvas.revision ?? 0) !== prev.canvasRev
            || cached.x !== prev.x || cached.y !== prev.y
            || cached.canvas.width !== prev.w || cached.canvas.height !== prev.h)) {
            return true;
        }
        if (cached?.canvas !== prev.canvas) {
            const basePrev = prev.baseIndex >= 0 ? staticPropState[prev.baseIndex] : null;
            if (!hasCache || !prev.frameGroup || sprite.poolMaskFrameGroup?.(cached) !== prev.frameGroup
                || !basePrev?.canvas || props[prev.baseIndex] !== basePrev.sprite
                || props[prev.baseIndex]?._cacheCanvas?.canvas !== basePrev.canvas) {
                return true;
            }
        }
    }
    return false;
}

function collectVisibleBodies(renderer) {
    const out = [];
    const agents = renderer.agentSprites instanceof Map ? renderer.agentSprites.values() : renderer.agentSprites || [];
    for (const sprite of agents) {
        if (!sprite?._bodyBox || !Number.isFinite(sprite.x)) continue;
        const body = villagerOccluder(sprite);
        if (!body.image || !inRect(body.x, body.y, body.w, body.h)) continue;
        const image = body.image;
        out.push({
            image,
            imgW: image.naturalWidth || image.width || 0,
            imgH: image.naturalHeight || image.height || 0,
            imgSrc: typeof image.src === 'string' ? image.src : '',
            imgRev: image._revision ?? image.revision ?? 0,
            sx: body.sx ?? 0,
            sy: body.sy ?? 0,
            w: body.w,
            h: body.h,
            x: body.x,
            y: body.y,
        });
    }
    return out;
}

function sameBody(a, b) {
    return a.image === b.image
        && a.imgW === b.imgW
        && a.imgH === b.imgH
        && a.imgSrc === b.imgSrc
        && a.imgRev === b.imgRev
        && a.sx === b.sx
        && a.sy === b.sy
        && a.w === b.w
        && a.h === b.h
        && a.x === b.x
        && a.y === b.y;
}

function bodiesIdentical(prev, next) {
    if (prev.length !== next.length) return false;
    for (let i = 0; i < prev.length; i++) {
        if (!sameBody(prev[i], next[i])) return false;
    }
    return true;
}

function bodyToLocalRect(body, x0, y0, maskW, maskH) {
    const rx0 = Math.max(0, Math.floor(body.x - x0) - 1);
    const ry0 = Math.max(0, Math.floor(body.y - y0) - 1);
    const rx1 = Math.min(maskW, Math.ceil(body.x + body.w - x0) + 1);
    const ry1 = Math.min(maskH, Math.ceil(body.y + body.h - y0) + 1);
    if (rx1 <= rx0 || ry1 <= ry0) return null;
    return { x0: rx0, y0: ry0, x1: rx1, y1: ry1 };
}

function coalesceRects(raw) {
    if (!raw.length) return [];
    const list = raw.slice();
    let merged = true;
    while (merged && list.length > 1) {
        merged = false;
        for (let i = 0; i < list.length; i++) {
            const a = list[i];
            for (let j = i + 1; j < list.length; j++) {
                const b = list[j];
                if (a.x0 <= b.x1 + DIRTY_MERGE_PAD && a.x1 + DIRTY_MERGE_PAD >= b.x0
                    && a.y0 <= b.y1 + DIRTY_MERGE_PAD && a.y1 + DIRTY_MERGE_PAD >= b.y0) {
                    a.x0 = Math.min(a.x0, b.x0);
                    a.y0 = Math.min(a.y0, b.y0);
                    a.x1 = Math.max(a.x1, b.x1);
                    a.y1 = Math.max(a.y1, b.y1);
                    list.splice(j, 1);
                    merged = true;
                    break;
                }
            }
            if (merged) break;
        }
    }
    return list.map(r => ({ x: r.x0, y: r.y0, w: r.x1 - r.x0, h: r.y1 - r.y0 }));
}

function dirtyRectsForBodyChange(prev, next, x0, y0, maskW, maskH) {
    const raw = [];
    const add = (body) => {
        const local = bodyToLocalRect(body, x0, y0, maskW, maskH);
        if (local) raw.push(local);
    };
    const nextMatched = new Uint8Array(next.length);
    const matchedNextIndex = new Int32Array(prev.length).fill(-1);
    for (let i = 0; i < prev.length; i++) {
        let found = -1;
        for (let j = 0; j < next.length; j++) {
            if (!nextMatched[j] && sameBody(prev[i], next[j])) {
                found = j;
                break;
            }
        }
        if (found >= 0) {
            nextMatched[found] = 1;
            matchedNextIndex[i] = found;
        } else {
            add(prev[i]);
        }
    }
    for (let j = 0; j < next.length; j++) {
        if (!nextMatched[j]) add(next[j]);
    }
    // Order change between matched bodies: if matched indices are not strictly
    // increasing, any body whose relative order flipped must be repainted too.
    let maxNext = -1;
    for (let i = 0; i < prev.length; i++) {
        const idx = matchedNextIndex[i];
        if (idx < 0) continue;
        if (idx < maxNext) {
            add(prev[i]);
            for (let k = 0; k < i; k++) {
                if (matchedNextIndex[k] > idx) add(prev[k]);
            }
        } else {
            maxNext = idx;
        }
    }
    return coalesceRects(raw);
}

function unionDirtyRects(rects) {
    if (!rects.length) return null;
    let x0 = rects[0].x;
    let y0 = rects[0].y;
    let x1 = rects[0].x + rects[0].w;
    let y1 = rects[0].y + rects[0].h;
    for (let i = 1; i < rects.length; i++) {
        const r = rects[i];
        if (r.x < x0) x0 = r.x;
        if (r.y < y0) y0 = r.y;
        if (r.x + r.w > x1) x1 = r.x + r.w;
        if (r.y + r.h > y1) y1 = r.y + r.h;
    }
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

function drawBodyList(ctx, bodies, x0, y0) {
    if (!bodies.length) return;
    ctx.setTransform(1, 0, 0, 1, -x0, -y0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.imageSmoothingEnabled = false;
    for (let i = 0; i < bodies.length; i++) {
        const body = bodies[i];
        ctx.drawImage(body.image, body.sx, body.sy, body.w, body.h, body.x, body.y, body.w, body.h);
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
}

function ceilQuant(n, q) {
    return Math.ceil(Math.max(1, n) / q) * q;
}

function collectBackupRects(bodies, x0, y0, maskW, maskH) {
    const raw = [];
    for (let i = 0; i < bodies.length; i++) {
        const local = bodyToLocalRect(bodies[i], x0, y0, maskW, maskH);
        if (!local) continue;
        let covered = false;
        for (let j = 0; j < raw.length; j++) {
            const r = raw[j];
            if (local.x0 >= r.x0 && local.y0 >= r.y0 && local.x1 <= r.x1 && local.y1 <= r.y1) {
                covered = true;
                break;
            }
        }
        if (!covered) raw.push(local);
    }
    return raw;
}

function packBackupSlots(raw, maskW, maskH) {
    if (!raw.length) return { slots: [], width: 0, height: 0, usedW: 0, usedH: 0 };
    const items = raw.map(r => ({
        x: r.x0,
        y: r.y0,
        w: r.x1 - r.x0,
        h: r.y1 - r.y0,
    }));
    items.sort((a, b) => (b.h - a.h) || (b.w - a.w));
    let maxW = 0;
    let totalArea = 0;
    for (let i = 0; i < items.length; i++) {
        if (items[i].w > maxW) maxW = items[i].w;
        totalArea += items[i].w * items[i].h;
    }
    const targetW = Math.max(
        maxW,
        Math.min(1024, ceilQuant(Math.ceil(Math.sqrt(totalArea * 1.5)), BACKUP_QUANT)),
    );
    const packW = ceilQuant(targetW, BACKUP_QUANT);
    let cursorX = 0;
    let cursorY = 0;
    let shelfH = 0;
    let usedW = 0;
    const slots = new Array(items.length);
    for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (cursorX > 0 && cursorX + item.w > packW) {
            cursorX = 0;
            cursorY += shelfH;
            shelfH = 0;
        }
        slots[i] = { x: item.x, y: item.y, w: item.w, h: item.h, sx: cursorX, sy: cursorY };
        cursorX += item.w;
        if (cursorX > usedW) usedW = cursorX;
        if (item.h > shelfH) shelfH = item.h;
    }
    const usedH = cursorY + shelfH;
    const width = ceilQuant(usedW, BACKUP_QUANT);
    const height = ceilQuant(usedH, BACKUP_QUANT);
    // Hard cap: the packed backup never exceeds the full mask canvas itself.
    if (width * height >= maskW * maskH) {
        return {
            slots: [{ x: 0, y: 0, w: maskW, h: maskH, sx: 0, sy: 0 }],
            width: maskW,
            height: maskH,
            usedW: maskW,
            usedH: maskH,
        };
    }
    return { slots, width, height, usedW, usedH };
}

// Save the clean static pixels under every visible body BEFORE any body is
// drawn onto `maskCanvas`, so every slot captures uncontaminated static ground
// even when bodies overlap.
function saveStaticUnderBodies(bodies, x0, y0, maskW, maskH) {
    const raw = collectBackupRects(bodies, x0, y0, maskW, maskH);
    if (!raw.length) {
        if (backupCanvas && (backupCanvas.width || backupCanvas.height)) {
            releaseCanvasBackingStore(backupCanvas);
        }
        return [];
    }
    const { slots, width, height, usedW, usedH } = packBackupSlots(raw, maskW, maskH);
    if (!backupCanvas) {
        backupCanvas = document.createElement('canvas');
        backupCtx = backupCanvas.getContext('2d');
    }
    const curPixels = backupCanvas.width * backupCanvas.height;
    const needPixels = width * height;
    const needsResize = backupCanvas.width < width
        || backupCanvas.height < height
        || curPixels > maskW * maskH
        || (curPixels > BACKUP_MIN_SHRINK_PIXELS && curPixels > needPixels * 2);
    if (needsResize) {
        backupCanvas.width = width;
        backupCanvas.height = height;
    }
    const bctx = backupCtx;
    bctx.setTransform(1, 0, 0, 1, 0, 0);
    bctx.globalCompositeOperation = 'source-over';
    bctx.globalAlpha = 1;
    bctx.imageSmoothingEnabled = false;
    if (!needsResize) {
        bctx.clearRect(0, 0, usedW, usedH);
    }
    for (let i = 0; i < slots.length; i++) {
        const s = slots[i];
        bctx.drawImage(maskCanvas, s.x, s.y, s.w, s.h, s.sx, s.sy, s.w, s.h);
    }
    return slots;
}

// Restore every backed-up body footprint back to the exact clean static pixels.
// Each slot clears its own integer rect before blitting from the clean backup,
// so overlapping slots still leave the exact clean static pixel (including
// partial alpha or transparent pixels) without double-compositing.
function restoreStaticFromBackup(ctx, slots) {
    if (!slots.length || !backupCanvas || !backupCanvas.width || !backupCanvas.height) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.imageSmoothingEnabled = false;
    for (let i = 0; i < slots.length; i++) {
        const s = slots[i];
        ctx.clearRect(s.x, s.y, s.w, s.h);
        ctx.drawImage(backupCanvas, s.sx, s.sy, s.w, s.h, s.x, s.y, s.w, s.h);
    }
}

/**
 * QA diagnostics (Canvas has no debug channel): the built landmark masks —
 * their key, size and the texel counts of their cut and floor halves — and
 * the cache key of the static half currently in use.
 */
export function poolMaskDiagnostics() {
    const masks = [];
    for (const [key, entry] of landmarkMasks) {
        const value = entry?.mask;
        if (!value) continue;
        const count = (part) => {
            const canvas = part?.canvas || part;
            if (!canvas || !canvas.width || !canvas.height) return 0;
            const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
            let n = 0;
            for (let i = 3; i < data.length; i += 4) if (data[i] > 0) n++;
            return n;
        };
        masks.push({ key, w: value.w, h: value.h, cut: count(value.cut), floor: count(value.floor) });
    }
    return {
        masks,
        staticKey,
        revision,
        snap: MASK_SNAP,
        staticRebuilds,
        bodyUpdates,
        bodyReuses,
        lastDirtyRects,
        lastDirtyPixels,
        backupPixels: canvasPixelCount(backupCanvas),
        backupSlots: prevSavedSlots.length,
    };
}

/**
 * The frame's pool receiver mask over the world rect `{ x0, y0, x1, y1 }`:
 * `{ canvas, x, y, w, h, revision, prevRevision, dirtyRects, dirtyBounds,
 * fullRefresh }` (1 texel per world px; alpha 255 where a pool may land), or
 * null when the coast bake has not produced its fields yet (then pools land
 * everywhere, as before this mask existed). The canvas is reused; draw or
 * upload it before the next call.
 */
export function poolReceiverMask(renderer, worldRect) {
    const fields = renderer?._coastBake?.waterFields;
    if (!fields?.coastField || typeof document === 'undefined') return null;
    if (staticRenderer && (staticRenderer !== renderer || staticDocument !== document)) {
        releasePoolReceiverMask(staticRenderer);
    }
    rect = {
        x0: Math.floor(worldRect.x0 / MASK_SNAP) * MASK_SNAP,
        y0: Math.floor(worldRect.y0 / MASK_SNAP) * MASK_SNAP,
    };
    rect.x1 = Math.ceil(worldRect.x1 / MASK_SNAP) * MASK_SNAP;
    rect.y1 = Math.ceil(worldRect.y1 / MASK_SNAP) * MASK_SNAP;
    const w = rect.x1 - rect.x0;
    const h = rect.y1 - rect.y0;
    const assets = renderer.assets || { get: () => null };
    let resized = false;
    if (!maskCanvas || staticDocument !== document) {
        if (staticDocument && staticDocument !== document) {
            for (const { mask } of landmarkMasks.values()) releaseLandmarkMask(mask);
            landmarkMasks.clear();
            releaseCanvasBackingStore(backupCanvas);
            backupCanvas = backupCtx = null;
        }
        staticDocument = document;
        maskCanvas = document.createElement('canvas');
        maskCtx = maskCanvas.getContext('2d');
        staticKey = '';
        prevBodies = [];
        prevSavedSlots = [];
        resized = true;
    }
    if (maskCanvas.width !== w || maskCanvas.height !== h) {
        maskCanvas.width = w;
        maskCanvas.height = h;
        staticKey = '';
        prevBodies = [];
        prevSavedSlots = [];
        resized = true;
    }
    const key = `${rect.x0},${rect.y0},${w}x${h}|${fields.revision ?? ''}|${renderer.terrainCacheKey || ''}|${assets?.assetVersion || ''}|${maskRevision}`;
    const needsStaticRebuild = resized
        || key !== staticKey
        || renderer !== staticRenderer
        || fields !== staticFields
        || staticSourcesChanged(renderer, assets);
    const nextBodies = collectVisibleBodies(renderer);
    const ctx = maskCtx;

    if (needsStaticRebuild) {
        rebuildStatic(renderer, assets);
        staticKey = key;
        staticRenderer = renderer;
        staticFields = fields;
        staticRebuilds++;
        prevSavedSlots = saveStaticUnderBodies(nextBodies, rect.x0, rect.y0, w, h);
        drawBodyList(ctx, nextBodies, rect.x0, rect.y0);
        prevBodies = nextBodies;
        const prevRevision = revision;
        revision++;
        lastDirtyRects = 0;
        lastDirtyPixels = w * h;
        return {
            canvas: maskCanvas,
            x: rect.x0,
            y: rect.y0,
            w,
            h,
            revision,
            prevRevision,
            dirtyRects: null,
            dirtyBounds: { x: 0, y: 0, w, h },
            fullRefresh: true,
        };
    }

    if (bodiesIdentical(prevBodies, nextBodies)) {
        bodyReuses++;
        lastDirtyRects = 0;
        lastDirtyPixels = 0;
        return {
            canvas: maskCanvas,
            x: rect.x0,
            y: rect.y0,
            w,
            h,
            revision,
            prevRevision: revision,
            dirtyRects: EMPTY_DIRTY_RECTS,
            dirtyBounds: null,
            fullRefresh: false,
        };
    }

    const dirtyRects = dirtyRectsForBodyChange(prevBodies, nextBodies, rect.x0, rect.y0, w, h);
    if (!dirtyRects.length) {
        prevBodies = nextBodies;
        bodyReuses++;
        lastDirtyRects = 0;
        lastDirtyPixels = 0;
        return {
            canvas: maskCanvas,
            x: rect.x0,
            y: rect.y0,
            w,
            h,
            revision,
            prevRevision: revision,
            dirtyRects: EMPTY_DIRTY_RECTS,
            dirtyBounds: null,
            fullRefresh: false,
        };
    }

    // Restore clean static pixels under every prior body footprint from the
    // compact backup, save clean static pixels under the new body footprints
    // before drawing any body, then composite current bodies in exact painter
    // order. Pixels outside `dirtyRects` return identically to their prior
    // values, and moving bodies never leave ghost footprints or corrupt
    // overlapping stationary bodies.
    let dirtyPixels = 0;
    for (let i = 0; i < dirtyRects.length; i++) {
        dirtyPixels += dirtyRects[i].w * dirtyRects[i].h;
    }
    restoreStaticFromBackup(ctx, prevSavedSlots);
    prevSavedSlots = saveStaticUnderBodies(nextBodies, rect.x0, rect.y0, w, h);
    drawBodyList(ctx, nextBodies, rect.x0, rect.y0);

    prevBodies = nextBodies;
    const prevRevision = revision;
    revision++;
    bodyUpdates++;
    lastDirtyRects = dirtyRects.length;
    lastDirtyPixels = dirtyPixels;
    return {
        canvas: maskCanvas,
        x: rect.x0,
        y: rect.y0,
        w,
        h,
        revision,
        prevRevision,
        dirtyRects,
        dirtyBounds: unionDirtyRects(dirtyRects),
        fullRefresh: false,
    };
}
