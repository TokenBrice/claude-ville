// 1.3 (The Waking Isle) — emitters keep their own light, beyond the scene
// pass's own records.
//
// The resident scene pass exempts a lit authored-emitter pixel from the time
// grade (`emitterWeight` in SCENE_FRAGMENT). Two kinds of emitter never reach
// that path by themselves, and this module carries them:
//
// 1. Cache-layer props. The plaza rune braziers and the street and scenic
//    lanterns are baked into the terrain texture (IsometricRenderer
//    `_drawAmbientGroundProps`), which has no emissive map, so their flame
//    sidecars would never be read. `cacheEmitterRecords` adds one record per
//    such prop right after the terrain: the same atlas frame at the same
//    placement, with the world-pilot emissive page, so the flame becomes an
//    emitter and everything else draws the identical pixels it covers.
// 2. The Canvas and hybrid PostFx paths, which grade the whole finished 2D
//    frame. `drawCanvasEmitterCuts` draws one cached emitter cut per lit
//    building or emitter prop (CanvasGrade `buildEmitterCut`) on the ungraded
//    overlay, before weather and marks. A cut cannot know what the depth pass
//    later drew over it, so every villager, tree or prop in front whose drawn
//    pixels cross the cut is cut back out by its own drawn silhouette — an
//    approximation of the painter's order that errs on the graded side.
//
// Emitters follow the same gates as the scene pass: a building's cut takes
// its NightOccupancyGate emissive gate, every cut the source-energy envelope's
// core share. Nothing here reads mood or director state.

import { AMBIENT_GROUND_PROPS, DISTRICT_PROPS, SCENIC_POINT_PROPS } from '../../config/scenery.js';
import { atlasSourceRect } from './AssetManager.js';
import { sourceEnergyFor } from './AtmosphereState.js';
import { buildEmitterCut } from './CanvasGrade.js';
import { materialClassId } from './gpu/GpuWorldPolicy.js';
import { tileToWorld } from './Projection.js';

let cacheProps = null;

/** Cache-layer (terrain-baked) prop placements, in the bake's order. */
export function cacheLayerProps() {
    if (cacheProps) return cacheProps;
    const out = [];
    const push = (id, tileX, tileY) => {
        const world = tileToWorld(tileX, tileY);
        out.push({ id, tileX, tileY, x: world.x, y: world.y });
    };
    for (const prop of AMBIENT_GROUND_PROPS) push(`prop.${prop.type}`, prop.tileX, prop.tileY);
    for (const prop of DISTRICT_PROPS) if (prop.layer === 'cache') push(prop.id, prop.tileX, prop.tileY);
    for (const prop of SCENIC_POINT_PROPS) if (prop.layer === 'cache') push(prop.id, prop.tileX, prop.tileY);
    cacheProps = Object.freeze(out);
    return cacheProps;
}

function hasEmissiveSidecar(assets, id) {
    return assets?.getEntry?.(id)?.emissiveSidecar === true;
}

/**
 * GPU records for the terrain-baked emitter props. Plain records (the policy
 * normalizer fills the V9 fields): no painter depth, sequence between the
 * terrain and the drawables. Only while the world-pilot atlas is already
 * resident, so a lone prop never pulls the atlas pages in.
 * `channelRevision(assets, atlasId)` is GpuSceneBuilder's atlas channel
 * revision, so these records share the landmark batches' channel textures.
 */
export function cacheEmitterRecords(renderer, channelRevision) {
    const assets = renderer?.assets;
    if (!assets || !renderer._gpuAtlasResident) return [];
    const records = [];
    for (const prop of cacheLayerProps()) {
        if (!hasEmissiveSidecar(assets, prop.id)) continue;
        const frame = assets.getAtlasFrame?.(prop.id);
        const atlasId = frame?.atlas;
        const albedo = atlasId ? assets.getAtlas?.(atlasId, 'albedo') : null;
        const emissive = atlasId ? assets.getAtlas?.(atlasId, 'emissive') : null;
        if (!albedo || !emissive || !frame?.rect) continue;
        const { sx, sy, sw, sh } = atlasSourceRect(frame.rect);
        const [ax, ay] = assets.getAnchor(prop.id);
        const key = `cache-emitter:${prop.id}:${prop.tileX},${prop.tileY}`;
        records.push({
            id: key,
            stableKey: key,
            textureKey: atlasId,
            sidecarKey: `${atlasId}:channels`,
            source: albedo,
            materialSource: assets.getAtlas?.(atlasId, 'material') || null,
            emissiveSource: emissive,
            sourceWidth: albedo.width,
            sourceHeight: albedo.height,
            sx,
            sy,
            sw,
            sh,
            x: Math.round(prop.x - ax),
            y: Math.round(prop.y - ay),
            width: sw,
            height: sh,
            material: materialClassId(assets.getMaterialMetadata?.(prop.id)?.materialClass || 'default'),
            elevation: 0.34,
            emissive: 0,
            occluder: 0,
            textureRevision: assets.assetVersion || 0,
            sidecarRevision: channelRevision(assets, atlasId),
            sequence: -0.5,
            sourceKind: 'atlas',
        });
    }
    return records;
}

// ── Canvas / hybrid PostFx ────────────────────────────────────────────────

const cuts = new Map();
let occluderScratch = null;

function emissiveImageFor(assets, id, albedo, key) {
    const companion = assets.getCompanion?.(id, 'emissive');
    if (companion) return companion;
    // Canvas mode does not load material companions; fetch the sidecar beside
    // the versioned albedo once.
    const src = typeof albedo?.src === 'string' ? albedo.src : '';
    if (!src || typeof Image === 'undefined') {
        cuts.set(key, null);
        return null;
    }
    const image = new Image();
    cuts.set(key, 'loading');
    image.onload = () => {
        if (cuts.get(key) !== 'loading') return;
        cuts.set(key, buildEmitterCut(albedo, image));
    };
    image.onerror = () => cuts.set(key, null);
    image.src = src.replace(/\.png(?=([?#]|$))/, '.emissive.png');
    return null;
}

function cutFor(assets, id) {
    const key = `${assets.assetVersion || ''}|${id}`;
    const cached = cuts.get(key);
    if (cached !== undefined) return cached === 'loading' ? null : cached;
    const albedo = assets.get?.(id);
    if (!albedo) return null;
    const emissive = emissiveImageFor(assets, id, albedo, key);
    if (!emissive) return null;
    const cut = buildEmitterCut(albedo, emissive);
    cuts.set(key, cut);
    return cut;
}

function* emitterPlacements(renderer) {
    const assets = renderer.assets;
    const buildings = renderer.buildingRenderer;
    const seen = new Set();
    for (const drawable of buildings?.enumerateDrawables?.() || []) {
        const building = drawable.building;
        if (!building || seen.has(building) || !hasEmissiveSidecar(assets, drawable.entry?.id)) continue;
        seen.add(building);
        yield {
            id: drawable.entry.id,
            x: drawable.wx,
            y: drawable.wy,
            sortY: drawable.sortY,
            gate: buildings._emissiveGateFor?.(building) ?? 1,
        };
    }
    for (const sprite of renderer.districtPropSprites || []) {
        if (!sprite?.id || !hasEmissiveSidecar(assets, sprite.id)) continue;
        yield { id: sprite.id, x: sprite.x, y: sprite.y, sortY: sprite.sortY, gate: 1 };
    }
    for (const prop of cacheLayerProps()) {
        if (!hasEmissiveSidecar(assets, prop.id)) continue;
        // Baked into the terrain, so every villager and every static sprite
        // draws over it: static sprites carve by their own drawn silhouette
        // whatever their depth.
        yield { id: prop.id, x: prop.x, y: prop.y, sortY: -Infinity, staticSortY: -Infinity, gate: 1 };
    }
}

function overlaps(a, x, y, w, h) {
    return a.x < x + w && a.x + a.w > x && a.y < y + h && a.y + a.h > y;
}

// What the depth pass painted in front of `sortY` across the cut rect (world
// px), as the exact pixels the Canvas pass blitted: a villager's body cell
// (AgentSprite `currentPoseCell`, at its drawn placement) and a static
// sprite's cached drawn image. A loose rect would carve the flame away
// wherever the rect is transparent and leave the graded flame showing there
// as a grey-green ghost. The body rect stands in only where no 1:1 body cell
// was laid out this frame (the overview and crowd impostors).
function villagerOccluder(sprite) {
    const box = sprite._bodyBox;
    const cell = typeof sprite.currentPoseCell === 'function' ? sprite.currentPoseCell() : null;
    const placeX = sprite._placeX;
    const placeY = sprite._placeY;
    // The 1:1 body lays its box inside the cell it drew this frame; an
    // impostor frame leaves the last cell elsewhere or outside the box.
    if (cell?.canvas && Number.isFinite(placeX) && Number.isFinite(placeY)
        && placeX + box.left >= cell.dx && placeX + box.right <= cell.dx + cell.sw
        && placeY + box.top >= cell.dy && placeY + box.bottom <= cell.dy + cell.sh) {
        return { x: cell.dx, y: cell.dy, w: cell.sw, h: cell.sh, image: cell.canvas, sx: cell.sx, sy: cell.sy };
    }
    return { x: sprite.x + box.left, y: sprite.y + box.top, w: box.right - box.left, h: box.bottom - box.top };
}

function occludersFor(renderer, sortY, staticSortY, x, y, w, h) {
    const out = [];
    const agents = renderer.agentSprites instanceof Map ? renderer.agentSprites.values() : renderer.agentSprites || [];
    for (const sprite of agents) {
        // The painter key the depth pass sorted the body at this frame
        // (DrawablePass `agentSortY`: a body tucked behind a split building
        // sorts before its back half).
        const depth = Number.isFinite(sprite?._depthSortY) ? sprite._depthSortY : sprite?.y;
        if (!sprite?._bodyBox || !Number.isFinite(sprite.x) || !Number.isFinite(depth) || depth <= sortY) continue;
        const rect = villagerOccluder(sprite);
        if (overlaps(rect, x, y, w, h)) out.push(rect);
    }
    for (const sprite of renderer._staticPropSprites || []) {
        const bounds = sprite?.bounds;
        if (!bounds || !(sprite.sortY > staticSortY)) continue;
        const cached = sprite._cacheCanvas;
        const rect = cached?.canvas
            ? { x: cached.x, y: cached.y, w: cached.canvas.width, h: cached.canvas.height, image: cached.canvas }
            : { x: sprite.x + bounds.left, y: sprite.y + bounds.top, w: bounds.right - bounds.left, h: bounds.bottom - bounds.top };
        if (overlaps(rect, x, y, w, h)) out.push(rect);
    }
    return out;
}

// The carve runs at the overlay's device scale (`scale` device px per world
// px): a body placed on a sub-texel step at zoom or DPR > 1 is cut back out
// on the device pixels it covered, so no 1-px strip of graded flame is left
// along its silhouette.
function carvedCut(cut, x, y, occluders, scale) {
    const { width, height } = cut.canvas;
    const w = Math.ceil(width * scale);
    const h = Math.ceil(height * scale);
    if (!occluderScratch) occluderScratch = document.createElement('canvas');
    if (occluderScratch.width < w) occluderScratch.width = w;
    if (occluderScratch.height < h) occluderScratch.height = h;
    const ctx = occluderScratch.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.globalCompositeOperation = 'source-over';
    ctx.clearRect(0, 0, w, h);
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    ctx.drawImage(cut.canvas, 0, 0);
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fillStyle = '#000';
    for (const rect of occluders) {
        if (rect.sx !== undefined) {
            ctx.drawImage(rect.image, rect.sx, rect.sy, rect.w, rect.h, rect.x - x, rect.y - y, rect.w, rect.h);
        } else if (rect.image) {
            ctx.drawImage(rect.image, rect.x - x, rect.y - y);
        } else {
            ctx.fillRect(Math.floor(rect.x - x), Math.floor(rect.y - y), Math.ceil(rect.w) + 1, Math.ceil(rect.h) + 1);
        }
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    return { canvas: occluderScratch, w, h };
}

/**
 * Draws every lit emitter's cut on `ctx` (the world overlay) in world space.
 * Call only when the resident scene pass did not render the frame.
 */
export function drawCanvasEmitterCuts(ctx, renderer, atmosphere) {
    const assets = renderer?.assets;
    const camera = renderer?.camera;
    if (!ctx || !assets || !camera) return;
    const core = sourceEnergyFor(atmosphere?.lighting).core;
    if (!(core > 0.02)) return;
    const viewport = renderer._screenViewport?.() || null;
    const topLeft = viewport ? camera.screenToWorld(0, 0) : null;
    const bottomRight = viewport ? camera.screenToWorld(viewport.width, viewport.height) : null;
    ctx.save();
    camera.applyTransform(ctx);
    ctx.imageSmoothingEnabled = false;
    ctx.globalCompositeOperation = 'source-over';
    const transform = ctx.getTransform();
    const scale = Math.max(1, Math.hypot(transform.a, transform.b));
    for (const emitter of emitterPlacements(renderer)) {
        const alpha = Math.min(1, Math.max(0, emitter.gate) * core);
        if (alpha < 0.02) continue;
        const cut = cutFor(assets, emitter.id);
        if (!cut) continue;
        const [ax, ay] = assets.getAnchor(emitter.id);
        const x = Math.round(emitter.x - ax) + cut.x;
        const y = Math.round(emitter.y - ay) + cut.y;
        const { width, height } = cut.canvas;
        if (topLeft && (x > bottomRight.x || y > bottomRight.y || x + width < topLeft.x || y + height < topLeft.y)) continue;
        const occluders = occludersFor(renderer, emitter.sortY, emitter.staticSortY ?? emitter.sortY, x, y, width, height);
        ctx.globalAlpha = alpha;
        if (occluders.length) {
            const carved = carvedCut(cut, x, y, occluders, scale);
            ctx.drawImage(carved.canvas, 0, 0, carved.w, carved.h, x, y, carved.w / scale, carved.h / scale);
        } else {
            ctx.drawImage(cut.canvas, x, y);
        }
    }
    ctx.restore();
}
