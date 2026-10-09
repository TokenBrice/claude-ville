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
//    approximation of the painter's order that errs on the graded side. On
//    the hybrid path the same carved texels' own emission is also the PostFx
//    bloom's source, as authored emission is the resident bloom's.
//
// Emitters follow the same gates as the scene pass: a building's cut takes
// its NightOccupancyGate emissive gate, every cut the source-energy envelope's
// core share. Nothing here reads mood or director state.

import { AMBIENT_GROUND_PROPS, DISTRICT_PROPS, SCENIC_POINT_PROPS } from '../../config/scenery.js';
import { atlasSourceRect } from './AssetManager.js';
import { sourceEnergyFor } from './AtmosphereState.js';
import { buildEmitterCut } from './CanvasGrade.js';
import { mirrorAccentGate, mirrorAccentLayers } from './CoastBake.js';
import { materialClassId } from './gpu/GpuWorldPolicy.js';
import { hullGeometry } from './HarborHulls.js';
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
    if (!assets) return [];
    const records = cacheWaterRecords(renderer);
    mirrorAccentRecords(renderer, records);
    if (!renderer._gpuAtlasResident) return records;
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
            emissiveGate: prop.id === 'prop.lantern' ? Number(renderer.villageLampsLit?.() === true) : 1,
            occluder: 0,
            textureRevision: assets.assetVersion || 0,
            sidecarRevision: channelRevision(assets, atlasId),
            sequence: -0.5,
            sourceKind: 'atlas',
        });
    }
    return records;
}

// 3.7 — the lit mirror accents (CoastBake `mirrorAccentLayers`): one record
// per landmark glass group right after the terrain, on the accent texels
// only, with an all-emitter sidecar that carries no emission of its own, so
// a lit room's mirrored window skips the grade at its room's gate (the
// scene pass's emitter rule) and a dark room's stays the baked, graded pane.
// Water material: no pool, bounce or wet weather lands on it.
const MIRROR_ACCENT_MATERIAL = materialClassId('water');

function mirrorAccentRecords(renderer, records) {
    for (const layer of mirrorAccentLayers(renderer)) {
        const gate = mirrorAccentGate(renderer, layer, renderer._lastAtmosphere);
        if (!(gate > 0.02)) continue;
        records.push({
            id: layer.key,
            stableKey: layer.key,
            textureKey: layer.key,
            sidecarKey: `${layer.key}:channels`,
            source: layer.canvas,
            materialSource: null,
            emissiveSource: layer.emissive,
            occluderSource: null,
            sourceWidth: layer.w,
            sourceHeight: layer.h,
            sx: 0,
            sy: 0,
            sw: layer.w,
            sh: layer.h,
            x: layer.x,
            y: layer.y,
            width: layer.w,
            height: layer.h,
            material: MIRROR_ACCENT_MATERIAL,
            elevation: 0,
            emissive: 0,
            emissiveGate: gate,
            occluder: 0,
            textureRevision: layer.key,
            sidecarRevision: layer.key,
            sequence: -0.55,
            sourceKind: 'individual',
        });
    }
}

// 2.1 / V5 — terrain-baked props that hold water (the rune fountain on the
// Archive lawn, the well): the terrain's quarter-resolution class map paints
// their basin as the ground under them, so a brazier pool would lay its
// ground tint on the water. One record per prop redraws its water texels only
// (blue-dominant on the authored sprite) right after the terrain, with a
// material sidecar marking them as water, which the light loop keeps out of
// every diffuse pool. Everything else stays the terrain bake's own pixels
// and class, so a cache prop baked in front of the basin is never covered.
const CACHE_WATER_PROPS = new Set(['prop.runeFountain', 'prop.well']);
const CACHE_WATER_GROUND_CLASS = 7;
const waterMaps = new Map();

function waterMaterialMap(image, key) {
    const cached = waterMaps.get(key);
    if (cached !== undefined) return cached;
    if (typeof document === 'undefined' || !image?.width) return null;
    const canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(image, 0, 0);
    const px = ctx.getImageData(0, 0, canvas.width, canvas.height);
    let water = 0;
    for (let i = 0; i < px.data.length; i += 4) {
        const [r, g, b, a] = [px.data[i], px.data[i + 1], px.data[i + 2], px.data[i + 3]];
        const isWater = a > 0 && b > r + 30 && b >= g;
        px.data[i] = isWater ? 8 : 0;
        px.data[i + 1] = 0;
        px.data[i + 2] = 0;
        px.data[i + 3] = isWater ? 255 : 0;
        if (isWater) water++;
    }
    ctx.putImageData(px, 0, 0);
    const map = water ? canvas : null;
    waterMaps.set(key, map);
    return map;
}

// The record's source: the drawn sprite (authored or its winter state) cut
// to the water texels, one canvas per prop, rebuilt when its texture key
// changes.
const waterSources = new Map();

function waterOnlySource(source, materialSource, propKey, textureKey) {
    const cached = waterSources.get(propKey);
    if (cached?.textureKey === textureKey) return cached.canvas;
    const canvas = document.createElement('canvas');
    canvas.width = materialSource.width;
    canvas.height = materialSource.height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(source, 0, 0);
    ctx.globalCompositeOperation = 'destination-in';
    ctx.drawImage(materialSource, 0, 0);
    waterSources.set(propKey, { textureKey, canvas });
    return canvas;
}

function cacheWaterRecords(renderer) {
    const assets = renderer.assets;
    const records = [];
    for (const prop of cacheLayerProps()) {
        if (!CACHE_WATER_PROPS.has(prop.id)) continue;
        const image = assets.get?.(prop.id);
        if (!image?.width) continue;
        const version = assets.assetVersion || 0;
        const waterKey = `cache-water:${prop.id}:${version}`;
        const materialSource = waterMaterialMap(image, waterKey);
        if (!materialSource) continue;
        // 5.2 — the terrain bakes the prop's winter state (PropWinter: the
        // well's roof snow): its water texels come from that one, found on
        // the authored sprite.
        const winter = renderer.propWinter?.image?.(prop.id) || null;
        const textureKey = winter ? `${waterKey}:${renderer.propWinter.key}` : waterKey;
        const [ax, ay] = assets.getAnchor(prop.id);
        const key = `cache-water:${prop.id}:${prop.tileX},${prop.tileY}`;
        const source = waterOnlySource(winter || image, materialSource, key, textureKey);
        records.push({
            id: key,
            stableKey: key,
            textureKey,
            sidecarKey: `${textureKey}:channels`,
            source,
            materialSource,
            emissiveSource: null,
            occluderSource: null,
            sourceWidth: image.width,
            sourceHeight: image.height,
            sx: 0,
            sy: 0,
            sw: image.width,
            sh: image.height,
            x: Math.round(prop.x - ax),
            y: Math.round(prop.y - ay),
            width: image.width,
            height: image.height,
            material: CACHE_WATER_GROUND_CLASS,
            elevation: 0,
            emissive: 0,
            occluder: 0,
            textureRevision: textureKey,
            sidecarRevision: textureKey,
            sequence: -0.6,
            sourceKind: 'individual',
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

// Canvas mode loads no material companions, so an over-base part (a cycle or
// rest frame drawn over its building's own texels: the Task board lanterns)
// has no channel strip there: its emissive strip is cropped from the
// building's `.emissive.png` sidecar, fetched once beside the albedo (also
// CoastBake's 3.7 lit mirror accents, identical on both backends).
const sidecars = new Map();
export function emissiveSidecarFor(assets, id) {
    const companion = assets.getCompanion?.(id, 'emissive');
    if (companion) return companion;
    const key = `${assets.assetVersion || ''}|${id}`;
    const cached = sidecars.get(key);
    if (cached !== undefined) return cached === 'loading' ? null : cached;
    const albedo = assets.get?.(id);
    const src = typeof albedo?.src === 'string' ? albedo.src : '';
    // A sprite without an authored sidecar (manifest `emissiveSidecar` absent)
    // must never trigger a request (MaterialRegistry.companionPathFor).
    if (assets.getEntry && !assets.getEntry(id)?.emissiveSidecar) {
        sidecars.set(key, null);
        return null;
    }
    if (!src || typeof Image === 'undefined') {
        sidecars.set(key, null);
        return null;
    }
    const image = new Image();
    sidecars.set(key, 'loading');
    image.onload = () => sidecars.set(key, image);
    image.onerror = () => sidecars.set(key, null);
    image.src = src.replace(/\.png(?=([?#]|$))/, '.emissive.png');
    return null;
}

function overBaseEmissiveStrip(assets, entry, draw) {
    const overBase = draw.layer?.restIsBase === true || Boolean(draw.layer?.cycle && !draw.layer.cycle.art);
    if (!overBase) return null;
    const sidecar = emissiveSidecarFor(assets, entry.id);
    if (!sidecar) return null;
    const frames = Math.max(1, Math.round(draw.image.width / draw.frameW));
    const canvas = document.createElement('canvas');
    canvas.width = draw.frameW * frames;
    canvas.height = draw.frameH;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    for (let f = 0; f < frames; f++) {
        context.drawImage(sidecar, draw.localLeft, draw.localTop, draw.frameW, draw.frameH,
            f * draw.frameW, 0, draw.frameW, draw.frameH);
    }
    return canvas;
}

// 6.1 — a manifest part's cut (the Pharos lamp and lens, portal runes, the
// Task board lanterns, every cycled emitter), from the draw's own image and
// the channel strip the GPU part record emits through, cached per strip.
function partCutFor(assets, buildings, entry, draw) {
    const channels = buildings.partChannelsFor?.(entry, draw);
    const key = `part|${draw.textureKey}|${channels?.key || ''}`;
    const cached = cuts.get(key);
    if (cached !== undefined) return cached;
    const emissive = channels?.emissive || overBaseEmissiveStrip(assets, entry, draw);
    if (!emissive) return null;
    const cut = buildEmitterCut(draw.image, emissive);
    cuts.set(key, cut);
    return cut;
}

let partScratch = null;

// Draws the lit emitter texels of the frame each part shows now, carved by
// whatever the depth pass drew in front of the building, after the
// building's own cut (a part covers the base texels under it).
function drawPartCuts(ctx, renderer, emitter, core, scale, bloomCtx) {
    const buildings = renderer.buildingRenderer;
    if (!buildings?.partDrawsFor || !emitter.entry?.layers) return;
    partScratch ||= [];
    const draws = buildings.partDrawsFor(emitter.entry, emitter.building, emitter.x, emitter.y, 'whole', null, partScratch);
    for (let index = 0; index < draws.length; index++) {
        const d = draws[index];
        const alpha = Math.min(1, (d.fixture ? 1 : Math.max(0, emitter.gate)) * core);
        if (alpha < 0.02) continue;
        const cut = partCutFor(renderer.assets, buildings, emitter.entry, d);
        if (!cut) continue;
        // The frame's rect inside the strip, clipped to the cut.
        const left = Math.max(d.sx, cut.x);
        const top = Math.max(d.sy, cut.y);
        const right = Math.min(d.sx + d.sw, cut.x + cut.canvas.width);
        const bottom = Math.min(d.sy + d.sh, cut.y + cut.canvas.height);
        if (right <= left || bottom <= top) continue;
        const x = d.x + (left - d.sx);
        const y = d.y + (top - d.sy);
        const w = right - left;
        const h = bottom - top;
        const occluders = occludersFor(renderer, emitter.sortY, emitter.sortY, x, y, w, h);
        ctx.globalAlpha = alpha;
        drawPartFrame(ctx, cut.canvas, left - cut.x, top - cut.y, w, h, x, y, occluders, scale);
        if (bloomCtx) {
            bloomCtx.globalAlpha = alpha;
            drawPartFrame(bloomCtx, cut.bloom, left - cut.x, top - cut.y, w, h, x, y, occluders, scale);
        }
    }
}

// The (sx, sy, w, h) frame of a part strip at world (x, y), carved.
function drawPartFrame(ctx, source, sx, sy, w, h, x, y, occluders, scale) {
    if (occluders.length) drawCarved(ctx, partFrameCanvas(source, sx, sy, w, h), x, y, occluders, scale);
    else ctx.drawImage(source, sx, sy, w, h, x, y, w, h);
}

let partFrame = null;
function partFrameCanvas(source, sx, sy, w, h) {
    if (!partFrame) partFrame = document.createElement('canvas');
    partFrame.width = w;
    partFrame.height = h;
    const ctx = partFrame.getContext('2d');
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(source, sx, sy, w, h, 0, 0, w, h);
    return partFrame;
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
            // 6.3 — dark rooms (and every pane by day) carved back to glass.
            glass: buildings.glassPatchFor?.(building) || null,
            entry: drawable.entry,
            building,
        };
    }
    for (const sprite of renderer.districtPropSprites || []) {
        if (!sprite?.id || !hasEmissiveSidecar(assets, sprite.id)) continue;
        // A fixture's glass (the gatehouse and sea tower lamps) says when it
        // is lit (`emitterGate`: the village's lamplight); others always are.
        const gate = typeof sprite.emitterGate === 'function' ? sprite.emitterGate() : 1;
        if (!(gate > 0)) continue;
        yield { id: sprite.id, x: sprite.x, y: sprite.y, sortY: sprite.sortY, gate };
    }
    for (const prop of cacheLayerProps()) {
        if (!hasEmissiveSidecar(assets, prop.id)) continue;
        // Baked into the terrain, so every villager and every static sprite
        // draws over it: static sprites carve by their own drawn silhouette
        // whatever their depth.
        const gate = prop.id === 'prop.lantern' ? Number(renderer.villageLampsLit?.() === true) : 1;
        if (!(gate > 0)) continue;
        yield { id: prop.id, x: prop.x, y: prop.y, sortY: -Infinity, staticSortY: -Infinity, gate };
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
export function villagerOccluder(sprite) {
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
 * Call only when the resident scene pass did not render the frame. With
 * `bloomScale` > 0 (the hybrid PostFx path) the same carved texels' own
 * emission (each cut's `bloom` half, at gate x core) is also summed onto one
 * transparent layer at `bloomScale` of the overlay's backing store and
 * returned: the hybrid bloom's source, as authored emission is the resident
 * bloom's. Returns null when nothing emits.
 */
export function drawCanvasEmitterCuts(ctx, renderer, atmosphere, bloomScale = 0) {
    const assets = renderer?.assets;
    const camera = renderer?.camera;
    if (!ctx || !assets || !camera) return null;
    const core = sourceEnergyFor(atmosphere?.lighting).core;
    if (!(core > 0.02)) return null;
    const viewport = renderer._screenViewport?.() || null;
    const topLeft = viewport ? camera.screenToWorld(0, 0) : null;
    const bottomRight = viewport ? camera.screenToWorld(viewport.width, viewport.height) : null;
    ctx.save();
    camera.applyTransform(ctx);
    ctx.imageSmoothingEnabled = false;
    ctx.globalCompositeOperation = 'source-over';
    const transform = ctx.getTransform();
    const scale = Math.max(1, Math.hypot(transform.a, transform.b));
    const bloomCtx = bloomScale > 0 && ctx.canvas ? bloomTarget(ctx.canvas, transform, bloomScale) : null;
    ctx.globalAlpha = 1;
    drawMirrorAccentCuts(ctx, renderer, atmosphere, core, topLeft, bottomRight);
    for (const emitter of emitterPlacements(renderer)) {
        drawSpriteCut(ctx, renderer, emitter, core, scale, topLeft, bottomRight, bloomCtx);
        if (emitter.building) drawPartCuts(ctx, renderer, emitter, core, scale, bloomCtx);
    }
    // 2.7 — the Lighthouse lamp's own light (halo, lens flash, fans).
    ctx.globalAlpha = 1;
    renderer.buildingRenderer?.drawLanternLight?.(ctx);
    ctx.restore();
    return bloomCtx ? bloomLayer : null;
}

let bloomLayer = null;

// The hybrid bloom source, cleared, sized `scale` x the overlay's backing
// store and carrying the overlay's world transform at that scale. Cuts sum
// on it (`lighter`, smoothed: the bloom blurs it anyway).
function bloomTarget(overlay, transform, scale) {
    bloomLayer ||= document.createElement('canvas');
    const width = Math.max(1, Math.ceil(overlay.width * scale));
    const height = Math.max(1, Math.ceil(overlay.height * scale));
    if (bloomLayer.width !== width) bloomLayer.width = width;
    if (bloomLayer.height !== height) bloomLayer.height = height;
    const context = bloomLayer.getContext('2d');
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.globalAlpha = 1;
    context.globalCompositeOperation = 'source-over';
    context.clearRect(0, 0, width, height);
    context.setTransform(transform.a * scale, transform.b * scale, transform.c * scale,
        transform.d * scale, transform.e * scale, transform.f * scale);
    context.imageSmoothingEnabled = true;
    context.globalCompositeOperation = 'lighter';
    return context;
}

// 3.7 — the Canvas twin of the lit mirror accent records: each lit glass
// group's accents at its gate, under every building cut. The gate is an
// ordered 4x4 Bayer share of the accent texels (world-locked), never a
// partial alpha: a half-alpha amber over the graded teal water mixes to
// lime, so every drawn accent texel stays its own palette colour.
function drawMirrorAccentCuts(ctx, renderer, atmosphere, core, topLeft, bottomRight) {
    for (const layer of mirrorAccentLayers(renderer)) {
        const share = Math.min(1, mirrorAccentGate(renderer, layer, atmosphere) * core);
        if (share < 0.02) continue;
        const { x, y, w, h } = layer;
        if (topLeft && (x > bottomRight.x || y > bottomRight.y || x + w < topLeft.x || y + h < topLeft.y)) continue;
        const gated = bayerGated(layer, share);
        if (gated) drawCarvedTerrainLayer(ctx, renderer, { canvas: gated, x, y, w, h });
    }
}

const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
const bayerCopies = new WeakMap();

// `layer.canvas` keeping the texels whose world-locked 4x4 Bayer rank is
// under `share` (16 steps, cached per layer and step; null when none is).
function bayerGated(layer, share) {
    const step = Math.min(16, Math.round(share * 16));
    if (step <= 0) return null;
    if (step >= 16) return layer.canvas;
    let copies = bayerCopies.get(layer.canvas);
    if (!copies) bayerCopies.set(layer.canvas, copies = new Map());
    let copy = copies.get(step);
    if (copy) return copy;
    const { width, height } = layer.canvas;
    copy = document.createElement('canvas');
    copy.width = width;
    copy.height = height;
    const copyCtx = copy.getContext('2d');
    copyCtx.drawImage(layer.canvas, 0, 0);
    const image = copyCtx.getImageData(0, 0, width, height);
    const data = image.data;
    const ox = Math.round(layer.x);
    const oy = Math.round(layer.y);
    for (let j = 0; j < height; j++) {
        const row = ((oy + j) & 3) * 4;
        for (let i = 0; i < width; i++) {
            if (BAYER4[row + ((ox + i) & 3)] >= step) data[(j * width + i) * 4 + 3] = 0;
        }
    }
    copyCtx.putImageData(image, 0, 0);
    copies.set(step, copy);
    return copy;
}

// Every harbour hull the Canvas depth pass drew this frame, as its drawn
// frame (HarborHulls `drawHullFallback`): hulls float on the water, so each
// covers whatever lies on the water under it.
function hullOccluders(renderer, x, y, w, h, out) {
    for (const drawable of renderer._drawables || []) {
        const pose = drawable?.payload?.pose;
        if (!pose?.strip?.image) continue;
        const g = hullGeometry(pose);
        const rect = { x: g.x, y: g.y, w: g.width, h: g.height, image: pose.strip.image, sx: g.sx, sy: 0 };
        if (overlaps(rect, x, y, w, h)) out.push(rect);
    }
}

/**
 * Draws a world-space layer that lies on the terrain (`{ canvas, x, y }`,
 * world px) on the ungraded overlay `ctx` (camera transform applied), carved
 * by every villager, static sprite, landmark and harbour hull the depth pass
 * drew over it, by their own drawn pixels. Used by the 3.7 mirror accents
 * and the 2.9 water columns (CanvasWaterState `drawCanvasWaterColumns`).
 */
export function drawCarvedTerrainLayer(ctx, renderer, layer) {
    const x = layer.x;
    const y = layer.y;
    const w = layer.canvas.width;
    const h = layer.canvas.height;
    const transform = ctx.getTransform();
    const scale = Math.max(1, Math.hypot(transform.a, transform.b));
    const occluders = occludersFor(renderer, -Infinity, -Infinity, x, y, w, h);
    for (const rect of landmarkOccluders(renderer)) {
        if (overlaps(rect, x, y, w, h)) occluders.push(rect);
    }
    hullOccluders(renderer, x, y, w, h, occluders);
    drawCarved(ctx, layer.canvas, x, y, occluders, scale);
}

// Static rock crystals only: existing authored cool emission, not reserve,
// cargo or assay art. Restore their own cyan/mint palette faintly after C2.
export function drawMineCrystalGlow(ctx, renderer) {
    if (renderer.villageLampsLit?.() !== true) return;
    const buildings = renderer.buildingRenderer;
    const drawable = buildings?.enumerateDrawables?.().find(d => d.building?.type === 'mine');
    if (!drawable) return;
    const assets = renderer.assets;
    const id = 'building.mine';
    const image = assets.get(id);
    const mask = emissiveSidecarFor(assets, id);
    if (!image || !mask) return;
    const version = assets.assetVersion || '';
    let cut = buildings._mineCrystalCut;
    if (!cut || cut.image !== image || cut.mask !== mask || cut.version !== version) {
        const w = image.naturalWidth || image.width;
        const h = image.naturalHeight || image.height;
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const c = canvas.getContext('2d', { willReadFrequently: true });
        c.drawImage(mask, 0, 0, w, h);
        const emission = c.getImageData(0, 0, w, h).data;
        c.clearRect(0, 0, w, h);
        c.drawImage(image, 0, 0);
        const art = c.getImageData(0, 0, w, h);
        for (let i = 0; i < art.data.length; i += 4) {
            // Warm cave/lantern texels remain occupancy-gated; slate rock is
            // not emissive. Only sidecar-authored cyan/mint survives.
            if (!emission[i + 3] || emission[i + 1] < emission[i] * 1.15 || emission[i + 2] < emission[i] * 1.15) art.data[i + 3] = 0;
        }
        c.putImageData(art, 0, 0);
        // Two small cyan dilation courses outside the authored crystal
        // texels, checker-dithered at the rim. No radial blur, no data art:
        // the mask only lives high on the static rock, above the carts and
        // reserve. Warm cave/lantern emission is explicitly excluded.
        const haloArt = c.getImageData(0, 0, w, h);
        haloArt.data.fill(0);
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                const index = (y * w + x) * 4;
                if (emission[index + 3]) continue;
                let distance = 5;
                for (let dy = -4; dy <= 4; dy++) {
                    const row = y + dy;
                    if (row < 0 || row >= h) continue;
                    for (let dx = -4; dx <= 4; dx++) {
                        const column = x + dx;
                        const d = Math.abs(dx) + Math.abs(dy);
                        if (column < 0 || column >= w || d >= distance) continue;
                        if (art.data[(row * w + column) * 4 + 3]) distance = d;
                    }
                }
                if (distance > 4 || (distance > 2 && ((x + y) & 1))) continue;
                haloArt.data[index] = 103;
                haloArt.data[index + 1] = 190;
                haloArt.data[index + 2] = 191;
                haloArt.data[index + 3] = distance <= 2 ? 76 : 32;
            }
        }
        const halo = document.createElement('canvas');
        halo.width = w;
        halo.height = h;
        halo.getContext('2d').putImageData(haloArt, 0, 0);
        cut = buildings._mineCrystalCut = { image, mask, version, canvas, halo };
    }
    const [ax, ay] = assets.getAnchor(id);
    ctx.save();
    ctx.globalAlpha = 0.65;
    drawCarvedBuildingLayer(ctx, renderer, {
        canvas: cut.halo, x: Math.round(drawable.wx - ax), y: Math.round(drawable.wy - ay),
    }, drawable.building, drawable.sortY);
    drawCarvedBuildingLayer(ctx, renderer, {
        canvas: cut.canvas, x: Math.round(drawable.wx - ax), y: Math.round(drawable.wy - ay),
    }, drawable.building, drawable.sortY);
    ctx.restore();
}

/**
 * A building-local emitter layer, carved at its owner's painter depth on
 * every backend. Unlike terrain light, the owner's own rock must not erase
 * the cut; later landmarks, props and body silhouettes still cover it.
 */
export function drawCarvedBuildingLayer(ctx, renderer, layer, owner, sortY) {
    const { canvas, x, y } = layer;
    const w = canvas.width;
    const h = canvas.height;
    const transform = ctx.getTransform();
    const scale = Math.max(1, Math.hypot(transform.a, transform.b));
    const occluders = occludersFor(renderer, sortY, sortY, x, y, w, h);
    const assets = renderer.assets;
    for (const drawable of renderer.buildingRenderer?.enumerateDrawables?.() || []) {
        if (!drawable.building || drawable.building === owner || !(drawable.sortY > sortY)) continue;
        const image = assets.get?.(drawable.entry?.id);
        const anchor = assets.getAnchor?.(drawable.entry?.id);
        if (!image || !anchor) continue;
        const rect = {
            x: Math.round(drawable.wx - anchor[0]), y: Math.round(drawable.wy - anchor[1]),
            w: image.naturalWidth || image.width, h: image.naturalHeight || image.height, image,
        };
        if (overlaps(rect, x, y, w, h)) occluders.push(rect);
    }
    drawCarved(ctx, canvas, x, y, occluders, scale);
}

// Each landmark's drawn base image at its placement.
function landmarkOccluders(renderer) {
    const assets = renderer.assets;
    const out = [];
    const seen = new Set();
    for (const drawable of renderer.buildingRenderer?.enumerateDrawables?.() || []) {
        if (!drawable.building || seen.has(drawable.building)) continue;
        seen.add(drawable.building);
        const id = drawable.entry?.id;
        const image = id ? assets.get?.(id) : null;
        const anchor = id ? assets.getAnchor?.(id) : null;
        if (!image || !anchor) continue;
        const w = image.naturalWidth || image.width;
        const h = image.naturalHeight || image.height;
        out.push({ x: Math.round(drawable.wx - anchor[0]), y: Math.round(drawable.wy - anchor[1]), w, h, image });
    }
    return out;
}

function drawSpriteCut(ctx, renderer, emitter, core, scale, topLeft, bottomRight, bloomCtx) {
    const assets = renderer.assets;
    const alpha = Math.min(1, Math.max(0, emitter.gate) * core);
    if (alpha < 0.02) return;
    const cut = cutFor(assets, emitter.id);
    if (!cut) return;
    const [ax, ay] = assets.getAnchor(emitter.id);
    const x = Math.round(emitter.x - ax) + cut.x;
    const y = Math.round(emitter.y - ay) + cut.y;
    const { width, height } = cut.canvas;
    if (topLeft && (x > bottomRight.x || y > bottomRight.y || x + width < topLeft.x || y + height < topLeft.y)) return;
    const occluders = occludersFor(renderer, emitter.sortY, emitter.staticSortY ?? emitter.sortY, x, y, width, height);
    if (emitter.glass) {
        const glass = emitter.glass;
        occluders.push({ x: x - cut.x + glass.left, y: y - cut.y + glass.top, w: glass.w, h: glass.h, image: glass.canvas });
    }
    ctx.globalAlpha = alpha;
    drawCarved(ctx, cut.canvas, x, y, occluders, scale);
    if (bloomCtx) {
        bloomCtx.globalAlpha = alpha;
        drawCarved(bloomCtx, cut.bloom, x, y, occluders, scale);
    }
}

// `canvas` at world (x, y) on `ctx`, minus the occluders' drawn pixels.
function drawCarved(ctx, canvas, x, y, occluders, scale) {
    if (!occluders.length) {
        ctx.drawImage(canvas, x, y);
        return;
    }
    const carved = carvedCut({ canvas }, x, y, occluders, scale);
    ctx.drawImage(carved.canvas, 0, 0, carved.w, carved.h, x, y, carved.w / scale, carved.h / scale);
}
