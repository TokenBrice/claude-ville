// 1.3 (The Waking Isle) — emitters keep their own light, beyond the scene
// pass's own records.
//
// The resident scene pass exempts a lit authored-emitter pixel from the time
// grade (`emitterWeight` in SCENE_FRAGMENT). Two kinds of emitter never reach
// that path by themselves, and this module carries them:
//
// 1. Cache-layer props. The plaza braziers (prop.plazaBrazier) and the street and scenic
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
import { canvasPixelCount, releaseCanvasBackingStore } from './CanvasBudget.js';
import { buildEmitterCut, CanvasOverlayStampCache, emitterNightCarry } from './CanvasGrade.js';
import { mirrorAccentGate, mirrorAccentLayers, mirrorAccentRainCut, mirrorStormDrop } from './CoastBake.js';
import {
    DAYTIME_WORK_BLOOM_CORE,
    isDaytimeHighEnergyBuilding,
    materialClassId,
} from './gpu/GpuWorldPolicy.js';
import { roomGlintMask } from './RoomGlass.js';
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

// D4 — a street lantern's glass lights when the Lamplighter's Round reaches
// its tile (the shared lamp clock where the renderer has no round).
function lanternGate(renderer, prop) {
    if (renderer.villageLampsLit?.() !== true) return 0;
    const lit = renderer.lampRoundLit?.();
    return typeof lit === 'function' ? Number(lit(prop.tileX, prop.tileY) === true) : 1;
}

function hasEmissiveSidecar(assets, id) {
    return assets?.getEntry?.(id)?.emissiveSidecar === true;
}

/**
 * GPU records for the terrain-baked emitter props. Plain records (the policy
 * normalizer fills the V9 fields): no painter depth, sequence between the
 * terrain and the drawables. Atlas-backed props use already resident pages.
 * `channelRevision(assets, atlasId)` is GpuSceneBuilder's atlas channel
 * revision, so these records share the landmark batches' channel textures.
 */
export function cacheEmitterRecords(renderer, channelRevision) {
    const assets = renderer?.assets;
    if (!assets) return [];
    const records = cacheWaterRecords(renderer);
    mirrorAccentRecords(renderer, records);
    bridgeEmitterRecords(renderer, records);
    for (const prop of cacheLayerProps()) {
        // W1-C 1.3 — plaza braziers bake cold charcoal/ash by day and swap to
        // the lit flame sheet (`prop.plazaBrazier.lit`) only once the
        // Lamplighter's Round reaches them at night.
        const isPlazaBrazier = prop.id === 'prop.plazaBrazier';
        const resolvedId = isPlazaBrazier ? 'prop.plazaBrazier.lit' : prop.id;
        if (!hasEmissiveSidecar(assets, resolvedId)) continue;
        const nightGated = isPlazaBrazier || prop.id === 'prop.lantern' || prop.id === 'prop.archiveCistern';
        const gate = nightGated ? lanternGate(renderer, prop) : 1;
        if (isPlazaBrazier && !(gate > 0)) continue;
        const frame = assets.getAtlasFrame?.(resolvedId);
        const atlasId = frame?.atlas;
        if (atlasId) {
            if (!renderer._gpuAtlasResident) continue;
            const albedo = assets.getAtlas?.(atlasId, 'albedo') || null;
            const emissive = assets.getAtlas?.(atlasId, 'emissive') || null;
            if (!albedo || !emissive || !frame?.rect) continue;
            const { sx, sy, sw, sh } = atlasSourceRect(frame.rect);
            const [ax, ay] = assets.getAnchor(resolvedId);
            const key = `cache-emitter:${resolvedId}:${prop.tileX},${prop.tileY}`;
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
                material: materialClassId(assets.getMaterialMetadata?.(resolvedId)?.materialClass || 'default'),
                elevation: 0.34,
                emissive: 0,
                emissiveGate: gate,
                occluder: 0,
                textureRevision: assets.assetVersion || 0,
                sidecarRevision: channelRevision(assets, atlasId),
                sequence: -0.5,
                sourceKind: 'atlas',
            });
            continue;
        }
        // Individual cache emissive props (e.g., prop.archiveCistern's cool
        // night-only rune rim): redraw only their emissive texels when lit.
        if (!(gate > 0) || typeof document === 'undefined') continue;
        const sidecar = assets.getCompanion?.(resolvedId, 'emissive') || null;
        const albedo = renderer.propWinter?.image?.(resolvedId) || assets.get?.(resolvedId) || null;
        if (!sidecar || !albedo?.width) continue;
        const [ax, ay] = assets.getAnchor(resolvedId);
        const key = `cache-emitter:${resolvedId}:${prop.tileX},${prop.tileY}`;
        const textureKey = `${key}:${assets.assetVersion || 0}`;
        records.push({
            id: key,
            stableKey: key,
            textureKey,
            sidecarKey: `${textureKey}:channels`,
            source: maskedSource(albedo, sidecar, key, textureKey),
            materialSource: assets.getCompanion?.(resolvedId, 'material') || null,
            emissiveSource: sidecar,
            occluderSource: null,
            sourceWidth: albedo.width,
            sourceHeight: albedo.height,
            sx: 0,
            sy: 0,
            sw: albedo.width,
            sh: albedo.height,
            x: Math.round(prop.x - ax),
            y: Math.round(prop.y - ay),
            width: albedo.width,
            height: albedo.height,
            material: materialClassId(assets.getMaterialMetadata?.(resolvedId)?.materialClass || 'stone'),
            elevation: 0.34,
            emissive: 0,
            emissiveGate: gate,
            occluder: 0,
            textureRevision: textureKey,
            sidecarRevision: textureKey,
            sequence: -0.5,
            sourceKind: 'individual',
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
    const atmosphere = renderer._lastAtmosphere;
    // EN-7 — the rain breaks an accent where it breaks its mirror (the
    // shaders' `u_mirrorBreak`, the same value at every ladder level).
    const drop = mirrorStormDrop(atmosphere?.weather, atmosphere);
    for (const whole of mirrorAccentLayers(renderer)) {
        const gate = mirrorAccentGate(renderer, whole, atmosphere);
        if (!(gate > 0.02)) continue;
        const layer = mirrorAccentRainCut(whole, drop);
        if (!layer) continue;
        records.push({
            id: whole.key,
            stableKey: whole.key,
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
const CACHE_WATER_PROPS = new Set(['prop.runeFountain', 'prop.plazaFountain', 'prop.archiveCistern', 'prop.well']);
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
// to a mask's texels (the water map, or a bridge's flame sidecar), one
// canvas per record, rebuilt when its texture key changes.
const maskedSources = new Map();

function maskedSource(source, mask, recordKey, textureKey) {
    const cached = maskedSources.get(recordKey);
    if (cached?.textureKey === textureKey) return cached.canvas;
    const canvas = document.createElement('canvas');
    canvas.width = mask.width;
    canvas.height = mask.height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(source, 0, 0);
    ctx.globalCompositeOperation = 'destination-in';
    ctx.drawImage(mask, 0, 0);
    maskedSources.set(recordKey, { textureKey, canvas });
    return canvas;
}

// BR-6 — the landmark bridges are baked into the terrain too. A bridge sprite
// with an emissive sidecar (the south bridge's candle flames, derived over
// its declared light points) redraws only its sidecar's texels, from the
// drawn sprite (authored or winter), right after the terrain: the flames
// become emitters on their own material whatever the terrain class under
// them (part of the bridge stands over water-class texels), and everything
// drawn later (villagers, the near-rail slices) still covers them. Only
// while IsometricRenderer `bridgeLightsLit` (the step its light points
// share): unlit, there is no record and the terrain's own texels stand, so
// the day frame is untouched. GPU material companions only (Canvas takes
// `drawCanvasEmitterCuts`).
const BRIDGE_FLAME_MATERIAL = materialClassId('fire');

function bridgeEmitterRecords(renderer, records) {
    if (typeof document === 'undefined') return;
    for (const { key, textureKey, source, sidecar, x, y, w, h } of bridgeFlames(renderer)) {
        records.push({
            id: key,
            stableKey: key,
            textureKey,
            sidecarKey: `${textureKey}:channels`,
            source,
            materialSource: null,
            emissiveSource: sidecar,
            occluderSource: null,
            sourceWidth: w,
            sourceHeight: h,
            sx: 0,
            sy: 0,
            sw: w,
            sh: h,
            x,
            y,
            width: w,
            height: h,
            material: BRIDGE_FLAME_MATERIAL,
            elevation: 0,
            emissive: 0,
            emissiveGate: 1,
            occluder: 0,
            textureRevision: textureKey,
            sidecarRevision: textureKey,
            sequence: -0.5,
            sourceKind: 'individual',
        });
    }
}

function* bridgeFlames(renderer) {
    const assets = renderer.assets;
    for (const span of renderer.bridgeSpans || []) {
        const id = renderer._bridgeSpriteId?.(span);
        if (!id || !hasEmissiveSidecar(assets, id) || renderer.bridgeLightsLit?.(span) !== true) continue;
        const sidecar = assets.getCompanion?.(id, 'emissive');
        const placement = sidecar ? renderer._bridgeSpritePlacement?.(span) : null;
        if (!placement) continue;
        const { w, h } = placement.dims;
        const winter = placement.img !== assets.get?.(id);
        const textureKey = `bridge-emitter:${id}:${assets.assetVersion || 0}${winter ? `:${renderer.propWinter?.key}` : ''}`;
        const key = `bridge-emitter:${span.id || id}`;
        yield { key, textureKey, source: maskedSource(placement.img, sidecar, key, textureKey), sidecar,
            x: placement.x, y: placement.y, w, h };
    }
    const farm = farmBridgeFlames(renderer);
    if (farm) yield farm;
}

// The Canvas cut and both resident backends use the same flipped mask and world origin.
function farmBridgeFlames(renderer) {
    const placement = renderer._litFarmBridgePlacement?.();
    if (!placement) return null;
    const { id, img, dims: { w, h }, x, y } = placement;
    const assets = renderer.assets;
    if (!hasEmissiveSidecar(assets, id)) return null;
    const sidecar = emissiveSidecarFor(assets, id);
    if (!sidecar) return null;
    const winter = img !== assets.get(id);
    const key = 'bridge-emitter:north-farm-bridge';
    const textureKey = `bridge-emitter:${id}:mirror:${assets.assetVersion || 0}${winter ? `:${renderer.propWinter?.key}` : ''}`;
    const flipped = mirroredBridgeFlames(img, sidecar, w, h, key, textureKey);
    return { key, textureKey, source: flipped.albedo, sidecar: flipped.emissive, x, y, w, h };
}

const mirroredBridgeCache = new Map();
function mirroredBridgeFlames(source, sidecar, w, h, key, textureKey) {
    const cached = mirroredBridgeCache.get(key);
    if (cached?.textureKey === textureKey) return cached;
    const flip = (img) => {
        const c = document.createElement('canvas');
        c.width = w;
        c.height = h;
        const ctx = c.getContext('2d', { willReadFrequently: true });
        ctx.translate(w, 0);
        ctx.scale(-1, 1);
        ctx.drawImage(img, 0, 0);
        return c;
    };
    const emissive = flip(sidecar);
    const albedo = flip(source);
    const aCtx = albedo.getContext('2d', { willReadFrequently: true });
    aCtx.setTransform(1, 0, 0, 1, 0, 0);
    aCtx.globalCompositeOperation = 'destination-in';
    aCtx.drawImage(emissive, 0, 0);
    const entry = { textureKey, albedo, emissive };
    mirroredBridgeCache.set(key, entry);
    return entry;
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
        const source = maskedSource(winter || image, materialSource, key, textureKey);
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
const cutImages = new Map();
let cutRevisionCounter = 0;

// Bounded tiered scratch canvas pool so small/medium emitter cuts never share
// a viewport-sized scratch canvas with full-harbor water columns or moon path
// layers, and alternating large/medium requests (e.g. 2496x1404 and 600x600)
// hit distinct buckets with zero resize thrashing while respecting both entry
// and RGBA byte budgets.
const SCRATCH_TIERS = Object.freeze([32, 64, 128, 256, 512, 768, 1024, 1536, 2048, 2560, 3072]);
const SCRATCH_BUCKET_LIMIT = 16;
const SCRATCH_MAX_BYTES = 28 * 1024 * 1024;
const SCRATCH_LARGE_STEP = 256;
const SCRATCH_OVERSIZE_SHRINK_HYSTERESIS = 120;
let scratchDocument = null;
let scratchBuckets = new Map();
let scratchBucketBytes = 0;
let scratchOversize = null;
let scratchOversizeSmallStreak = 0;
let backingOwner = null;

function ensureScratchDocument() {
    if (typeof document === 'undefined') return;
    if (scratchDocument !== document) {
        releaseScratchPool();
        scratchDocument = document;
    }
}

function releaseScratchPool() {
    for (const canvas of scratchBuckets.values()) {
        releaseCanvasBackingStore(canvas);
    }
    scratchBuckets.clear();
    scratchBucketBytes = 0;
    if (scratchOversize) {
        releaseCanvasBackingStore(scratchOversize);
        scratchOversize = null;
    }
    scratchOversizeSmallStreak = 0;
}

function nextScratchTier(n) {
    for (let i = 0; i < SCRATCH_TIERS.length; i++) {
        if (SCRATCH_TIERS[i] >= n) return SCRATCH_TIERS[i];
    }
    return 0;
}

function ceilStep(n, step) {
    return Math.max(step, Math.ceil(n / step) * step);
}

function evictOldestScratchBucket() {
    const oldest = scratchBuckets.entries().next();
    if (oldest.done) return false;
    const [oldestKey, oldestCanvas] = oldest.value;
    scratchBuckets.delete(oldestKey);
    scratchBucketBytes = Math.max(0, scratchBucketBytes - canvasPixelCount(oldestCanvas) * 4);
    releaseCanvasBackingStore(oldestCanvas);
    emitterPerfStats.scratchEvictions++;
    return true;
}

export function scratchCanvasFor(w, h) {
    ensureScratchDocument();
    const bw = nextScratchTier(w);
    const bh = nextScratchTier(h);
    const bucketBytes = bw && bh ? bw * bh * 4 : 0;
    if (bw && bh && bucketBytes <= SCRATCH_MAX_BYTES) {
        const key = (bw << 12) | bh;
        let canvas = scratchBuckets.get(key);
        if (canvas) {
            // Refresh LRU recency.
            scratchBuckets.delete(key);
            scratchBuckets.set(key, canvas);
            return canvas;
        }
        while (scratchBuckets.size >= SCRATCH_BUCKET_LIMIT
            || (scratchBuckets.size > 0 && scratchBucketBytes + bucketBytes > SCRATCH_MAX_BYTES)) {
            if (!evictOldestScratchBucket()) break;
        }
        canvas = document.createElement('canvas');
        canvas.width = bw;
        canvas.height = bh;
        scratchBuckets.set(key, canvas);
        scratchBucketBytes += bucketBytes;
        emitterPerfStats.scratchCreates++;
        return canvas;
    }
    const targetW = bw || ceilStep(w, SCRATCH_LARGE_STEP);
    const targetH = bh || ceilStep(h, SCRATCH_LARGE_STEP);
    if (!scratchOversize) {
        scratchOversize = document.createElement('canvas');
        scratchOversize.width = targetW;
        scratchOversize.height = targetH;
        scratchOversizeSmallStreak = 0;
        emitterPerfStats.scratchCreates++;
        return scratchOversize;
    }
    if (scratchOversize.width < w || scratchOversize.height < h) {
        scratchOversize.width = Math.max(scratchOversize.width, targetW);
        scratchOversize.height = Math.max(scratchOversize.height, targetH);
        scratchOversizeSmallStreak = 0;
        emitterPerfStats.scratchResizes++;
        return scratchOversize;
    }
    if (scratchOversize.width * scratchOversize.height > targetW * targetH * 2.5) {
        scratchOversizeSmallStreak++;
        if (scratchOversizeSmallStreak >= SCRATCH_OVERSIZE_SHRINK_HYSTERESIS) {
            scratchOversize.width = targetW;
            scratchOversize.height = targetH;
            scratchOversizeSmallStreak = 0;
            emitterPerfStats.scratchResizes++;
        }
    } else {
        scratchOversizeSmallStreak = 0;
    }
    return scratchOversize;
}

// NE P1.3 — quantise nightCarry to 1/16 steps so Canvas emitter cuts track
// dusk/night transitions without rebuilding every frame or growing the cache.
function nightCarryStepFor(grade) {
    return Math.round(emitterNightCarry(grade) * 16);
}

function quantisedGradeForStep(step) {
    return step > 0 ? { poolGain: 0.15 + 1.05 * (step / 16) } : null;
}

function emissiveImageFor(assets, id, albedo, key) {
    const companion = assets.getCompanion?.(id, 'emissive');
    if (companion) return companion;
    const cached = cutImages.get(key);
    if (cached !== undefined) return cached === 'loading' ? null : cached;
    // Canvas mode does not load material companions; fetch the sidecar beside
    // the versioned albedo once.
    const src = typeof albedo?.src === 'string' ? albedo.src : '';
    if (!src || typeof Image === 'undefined') {
        cutImages.set(key, null);
        return null;
    }
    const image = new Image();
    cutImages.set(key, 'loading');
    image.onload = () => {
        if (cutImages.get(key) !== 'loading') return;
        cutImages.set(key, image);
    };
    image.onerror = () => cutImages.set(key, null);
    image.src = src.replace(/\.png(?=([?#]|$))/, '.emissive.png');
    return null;
}

function cutFor(assets, id, grade = null, placement = null) {
    const key = placement?.textureKey || `${assets.assetVersion || ''}|${id}`;
    const carryStep = nightCarryStepFor(grade);
    const cached = cuts.get(key);
    if (cached && cached.carryStep === carryStep) return cached.cut;
    const albedo = placement?.source || assets.get?.(id);
    if (!albedo) return null;
    const emissive = placement?.sidecar || emissiveImageFor(assets, id, albedo, key);
    if (!emissive) return null;
    const cut = buildEmitterCut(albedo, emissive, quantisedGradeForStep(carryStep));
    if (cut) cut._revision = ++cutRevisionCounter;
    cuts.set(key, { carryStep, cut });
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
export function partCutFor(assets, buildings, entry, draw, grade = null) {
    const channels = buildings.partChannelsFor?.(entry, draw);
    const key = `part|${draw.id || `${entry.id}.${draw.name}`}`;
    const revision = `${draw.textureRevision ?? draw.textureKey}|${channels?.key || ''}`;
    const carryStep = nightCarryStepFor(grade);
    const cached = cuts.get(key);
    if (cached?.revision === revision && cached.carryStep === carryStep) return cached.cut;
    const emissive = channels?.emissive || overBaseEmissiveStrip(assets, entry, draw);
    if (!emissive) return null;
    const backing = cached?.backing || {};
    const cut = buildEmitterCut(draw.image, emissive, quantisedGradeForStep(carryStep), backing);
    if (cut) cut._revision = ++cutRevisionCounter;
    cuts.set(key, { revision, carryStep, backing, cut });
    return cut;
}

let partScratch = null;

// Draws the lit emitter texels of the frame each part shows now, carved by
// whatever the depth pass drew in front of the building, after the
// building's own cut (a part covers the base texels under it).
function drawPartCuts(ctx, renderer, emitter, core, scale, topLeft, bottomRight, bloomOps, isDaylight = false, baseCore = core, grade = null, frameOccluders = null, viewBounds = null) {
    const buildings = renderer.buildingRenderer;
    if (!buildings?.partDrawsFor || !emitter.entry?.layers) return;
    partScratch ||= [];
    const draws = buildings.partDrawsFor(emitter.entry, emitter.building, emitter.x, emitter.y, 'whole', null, partScratch);
    for (let index = 0; index < draws.length; index++) {
        const d = draws[index];
        // VQ-8 — a part with its own gate (the banked ember floor) keeps it.
        const gate = d.emissiveGate ?? (d.fixture ? 1 : Math.max(0, emitter.gate));
        const partCore = isDaylight && d.ember ? baseCore : core;
        const alpha = Math.min(1, gate * partCore);
        if (alpha < 0.02) continue;
        const cut = partCutFor(renderer.assets, buildings, emitter.entry, d, grade);
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
        const sx = left - cut.x;
        const sy = top - cut.y;
        const occluders = occludersFor(renderer, emitter.sortY, emitter.sortY, x, y, w, h, null, frameOccluders);
        ctx.globalAlpha = alpha;
        drawCarvedSubRect(ctx, cut.canvas, sx, sy, w, h, x, y, occluders, scale, viewBounds);
        if (bloomOps) {
            pushBloomOp(bloomOps, cut.bloom, cut._revision || 0, sx, sy, w, h, x, y, alpha, occluders);
        }
    }
}

function buildingColumnSortY(drawables, building, worldX, fallbackSortY) {
    let best = null;
    let nearestDist = Infinity;
    for (const d of drawables || []) {
        if (d.building !== building) continue;
        if (d.kind === 'building-column' && d.column) {
            if (worldX >= d.column.worldLeft && worldX <= d.column.worldRight) return d.sortY;
            const center = (d.column.worldLeft + d.column.worldRight) / 2;
            const dist = Math.abs(worldX - center);
            if (dist < nearestDist) {
                nearestDist = dist;
                best = d.sortY;
            }
        } else if (d.kind !== 'building-back') {
            best = d.sortY;
        }
    }
    return best ?? fallbackSortY;
}

function buildingEntriesColumnSortY(entries, worldX, fallbackSortY) {
    let best = null;
    let nearestDist = Infinity;
    for (let i = 0; i < entries.length; i++) {
        const d = entries[i];
        if (d.kind === 'building-column' && d.column) {
            if (worldX >= d.column.worldLeft && worldX <= d.column.worldRight) return d.sortY;
            const center = (d.column.worldLeft + d.column.worldRight) / 2;
            const dist = Math.abs(worldX - center);
            if (dist < nearestDist) {
                nearestDist = dist;
                best = d.sortY;
            }
        } else if (d.kind !== 'building-back') {
            best = d.sortY;
        }
    }
    return best ?? fallbackSortY;
}

function* emitterPlacements(renderer, buildingCache = null) {
    const assets = renderer.assets;
    const buildings = renderer.buildingRenderer;
    const cache = buildingCache || buildingDrawablesCacheFor(renderer);
    const buildingDrawables = cache.drawables;
    const seen = new Set();
    for (const drawable of buildingDrawables) {
        const building = drawable.building;
        if (!building || seen.has(building) || !hasEmissiveSidecar(assets, drawable.entry?.id)) continue;
        seen.add(building);
        const group = cache.byBuilding.get(building);
        const sortYAtX = group
            ? (worldX) => buildingEntriesColumnSortY(group.entries, worldX, drawable.sortY)
            : (worldX) => buildingColumnSortY(buildingDrawables, building, worldX, drawable.sortY);
        const frontSortY = group ? group.frontSortY : drawable.sortY;
        const workTier = buildings._workTierFor?.(building);
        const active = buildings.partGates?.isOpen?.(`work.${building.type}`) ?? (Boolean(workTier) && workTier !== 'dormant');
        const gate = buildings._emissiveGateFor?.(building) ?? 1;
        const daytimeEmitter = isDaytimeHighEnergyBuilding(building.type, active, gate);
        yield {
            id: drawable.entry.id,
            x: drawable.wx,
            y: drawable.wy,
            sortY: sortYAtX,
            staticSortY: frontSortY,
            gate,
            daytimeEmitter,
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
        const isPlazaBrazier = prop.id === 'prop.plazaBrazier';
        const resolvedId = isPlazaBrazier ? 'prop.plazaBrazier.lit' : prop.id;
        if (!hasEmissiveSidecar(assets, resolvedId)) continue;
        // Baked into the terrain, so every villager and every static sprite
        // draws over it: static sprites carve by their own drawn silhouette
        // whatever their depth.
        const nightGated = isPlazaBrazier || prop.id === 'prop.lantern' || prop.id === 'prop.archiveCistern';
        const gate = nightGated ? lanternGate(renderer, prop) : 1;
        if (!(gate > 0)) continue;
        yield { id: resolvedId, x: prop.x, y: prop.y, sortY: -Infinity, staticSortY: -Infinity, gate };
    }
    // BR-6 — a terrain-baked bridge's flames, anchored at the span middle
    // as `_bridgeSpritePlacement` draws the sprite. Skip its own near-parapet
    // occluder prop so the parapet never self-carves the bridge's near flames.
    for (const span of renderer.bridgeSpans || []) {
        const id = renderer._bridgeSpriteId?.(span);
        if (!id || !hasEmissiveSidecar(assets, id) || renderer.bridgeLightsLit?.(span) !== true) continue;
        const x = (span.start.x + span.end.x) / 2;
        const y = (span.start.y + span.end.y) / 2;
        yield { id, x, y, sortY: -Infinity, staticSortY: -Infinity, gate: 1, skipPropPrefix: 'bridge.rail.' + span.id };
    }
    const farm = farmBridgeFlames(renderer);
    if (farm) yield { placement: farm, x: farm.x, y: farm.y, sortY: -Infinity, gate: 1 };
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

// Per-renderer static occluder caches, refreshed on prop/drawable/asset
// revisions while moving villagers and hulls are read live in painter order.
const staticPropCacheMap = new WeakMap();
const buildingCacheMap = new WeakMap();
const emitterPerfStats = {
    staticPropSyncs: 0,
    staticPropRebuilds: 0,
    landmarkCacheHits: 0,
    landmarkCacheRebuilds: 0,
    carvedDraws: 0,
    uncarvedDraws: 0,
    bloomReuses: 0,
    bloomRedraws: 0,
    bloomEmptySkips: 0,
    scratchCreates: 0,
    scratchResizes: 0,
    scratchEvictions: 0,
};

function staticPropOccludersFor(renderer) {
    const props = renderer?._staticPropSprites;
    if (!props?.length) return EMPTY_ARRAY;
    emitterPerfStats.staticPropSyncs++;
    let cache = staticPropCacheMap.get(renderer);
    let needsRebuild = !cache || cache.props !== props || cache.count !== props.length;
    if (!needsRebuild) {
        const skipped = cache.skipped;
        for (let i = 0; i < skipped.length; i++) {
            const idx = skipped[i];
            const sprite = props[idx];
            if (sprite?.bounds && typeof sprite.sortY === 'number' && !Number.isNaN(sprite.sortY)) {
                needsRebuild = true;
                break;
            }
        }
    }
    if (!needsRebuild) {
        const entries = cache.entries;
        let sortChanged = false;
        for (let i = 0; i < entries.length; i++) {
            const e = entries[i];
            const sprite = props[e.index];
            const bounds = sprite?.bounds;
            if (sprite !== e.sprite || !bounds || typeof sprite.sortY !== 'number' || Number.isNaN(sprite.sortY)) {
                needsRebuild = true;
                break;
            }
            const cached = sprite._cacheCanvas;
            const cachedCanvas = cached?.canvas || null;
            const gpuRev = sprite._gpuCacheRevision || 0;
            if (e.sortY !== sprite.sortY) {
                e.sortY = sprite.sortY;
                sortChanged = true;
            }
            if (e.cached !== cached || e.gpuRev !== gpuRev || e.bounds !== bounds || e.image !== cachedCanvas
                || (cachedCanvas
                    ? (e.x !== cached.x || e.y !== cached.y || e.w !== cachedCanvas.width || e.h !== cachedCanvas.height)
                    : (e.spriteX !== sprite.x || e.spriteY !== sprite.y))) {
                e.cached = cached;
                e.gpuRev = gpuRev;
                e.bounds = bounds;
                e.spriteX = sprite.x;
                e.spriteY = sprite.y;
                if (cachedCanvas) {
                    e.x = cached.x;
                    e.y = cached.y;
                    e.w = cachedCanvas.width;
                    e.h = cachedCanvas.height;
                    e.image = cachedCanvas;
                    e.rev = gpuRev;
                } else {
                    e.x = sprite.x + bounds.left;
                    e.y = sprite.y + bounds.top;
                    e.w = bounds.right - bounds.left;
                    e.h = bounds.bottom - bounds.top;
                    e.image = null;
                    e.rev = gpuRev;
                }
            }
        }
        if (!needsRebuild) {
            if (sortChanged) entries.sort((a, b) => b.sortY - a.sortY);
            return entries;
        }
    }
    emitterPerfStats.staticPropRebuilds++;
    const entries = [];
    const skipped = [];
    for (let i = 0; i < props.length; i++) {
        const sprite = props[i];
        const bounds = sprite?.bounds;
        if (!bounds || typeof sprite.sortY !== 'number' || Number.isNaN(sprite.sortY)) {
            skipped.push(i);
            continue;
        }
        const cached = sprite._cacheCanvas;
        const cachedCanvas = cached?.canvas || null;
        const gpuRev = sprite._gpuCacheRevision || 0;
        entries.push(cachedCanvas
            ? {
                index: i,
                sprite,
                id: sprite.id || null,
                sortY: sprite.sortY,
                cached,
                gpuRev,
                bounds,
                spriteX: sprite.x,
                spriteY: sprite.y,
                x: cached.x,
                y: cached.y,
                w: cachedCanvas.width,
                h: cachedCanvas.height,
                image: cachedCanvas,
                rev: gpuRev,
            }
            : {
                index: i,
                sprite,
                id: sprite.id || null,
                sortY: sprite.sortY,
                cached: null,
                gpuRev,
                bounds,
                spriteX: sprite.x,
                spriteY: sprite.y,
                x: sprite.x + bounds.left,
                y: sprite.y + bounds.top,
                w: bounds.right - bounds.left,
                h: bounds.bottom - bounds.top,
                image: null,
                rev: gpuRev,
            });
    }
    // Descending sortY lets occluder queries break as soon as sortY <= threshold.
    entries.sort((a, b) => b.sortY - a.sortY);
    staticPropCacheMap.set(renderer, { props, count: props.length, entries, skipped });
    return entries;
}

const EMPTY_ARRAY = Object.freeze([]);

function buildingDrawablesCacheFor(renderer) {
    const drawables = renderer?.buildingRenderer?.enumerateDrawables?.() || EMPTY_ARRAY;
    const assetVersion = renderer?.assets?.assetVersion || '';
    let cache = buildingCacheMap.get(renderer);
    if (cache && cache.drawables === drawables && cache.length === drawables.length && cache.assetVersion === assetVersion) {
        return cache;
    }
    const byBuilding = new Map();
    for (let i = 0; i < drawables.length; i++) {
        const d = drawables[i];
        if (!d?.building) continue;
        let group = byBuilding.get(d.building);
        if (!group) {
            group = { entries: [], frontSortY: d.sortY };
            byBuilding.set(d.building, group);
        }
        group.entries.push(d);
        if (d.sortY > group.frontSortY) group.frontSortY = d.sortY;
    }
    cache = {
        drawables,
        length: drawables.length,
        assetVersion,
        byBuilding,
        landmarks: null,
        landmarkPendingIds: null,
        landmarkImages: null,
        resolvedDrawables: new Map(),
    };
    buildingCacheMap.set(renderer, cache);
    return cache;
}

function collectVillagerOccluders(renderer) {
    const out = [];
    const agents = renderer.agentSprites instanceof Map ? renderer.agentSprites.values() : renderer.agentSprites || [];
    for (const sprite of agents) {
        const depth = Number.isFinite(sprite?._depthSortY) ? sprite._depthSortY : sprite?.y;
        if (!sprite?._bodyBox || !Number.isFinite(sprite.x) || !Number.isFinite(depth)) continue;
        const rect = villagerOccluder(sprite);
        out.push({ x: sprite.x, depth, rect });
    }
    return out;
}

function buildFrameOccluders(renderer) {
    return {
        villagers: collectVillagerOccluders(renderer),
        staticProps: staticPropOccludersFor(renderer),
        buildings: buildingDrawablesCacheFor(renderer),
    };
}

function occludersFor(renderer, sortY, staticSortY, x, y, w, h, skipPropId = null, frameOccluders = null) {
    const out = [];
    const resolveDepth = typeof sortY === 'function' ? sortY : null;
    if (frameOccluders) {
        const villagers = frameOccluders.villagers;
        for (let i = 0; i < villagers.length; i++) {
            const v = villagers[i];
            const threshold = resolveDepth ? resolveDepth(v.x) : sortY;
            if (v.depth <= threshold) continue;
            if (overlaps(v.rect, x, y, w, h)) out.push(v.rect);
        }
    } else {
        const agents = renderer.agentSprites instanceof Map ? renderer.agentSprites.values() : renderer.agentSprites || [];
        for (const sprite of agents) {
            // The painter key the depth pass sorted the body at this frame
            // (DrawablePass `agentSortY`: a body tucked behind a split building
            // sorts before its back half).
            const depth = Number.isFinite(sprite?._depthSortY) ? sprite._depthSortY : sprite?.y;
            const threshold = resolveDepth ? resolveDepth(sprite.x) : sortY;
            if (!sprite?._bodyBox || !Number.isFinite(sprite.x) || !Number.isFinite(depth) || depth <= threshold) continue;
            const rect = villagerOccluder(sprite);
            if (overlaps(rect, x, y, w, h)) out.push(rect);
        }
    }
    const staticThreshold = typeof staticSortY === 'function' ? staticSortY(x + w / 2) : staticSortY;
    const staticProps = frameOccluders ? frameOccluders.staticProps : staticPropOccludersFor(renderer);
    for (let i = 0; i < staticProps.length; i++) {
        const entry = staticProps[i];
        if (!(entry.sortY > staticThreshold)) break;
        if (skipPropId && (entry.id === skipPropId || entry.id?.startsWith?.(skipPropId + '.'))) continue;
        if (overlaps(entry, x, y, w, h)) out.push(entry);
    }
    return out;
}

function visibleWorldBoundsFor(ctx, pad = 1) {
    const canvas = ctx?.canvas;
    if (!canvas || !(canvas.width > 0) || !(canvas.height > 0)) return null;
    const t = ctx.getTransform?.();
    if (!t || !(t.a > 0) || !(t.d > 0) || t.b || t.c) return null;
    return {
        x0: Math.floor(-t.e / t.a) - pad,
        y0: Math.floor(-t.f / t.d) - pad,
        x1: Math.ceil((canvas.width - t.e) / t.a) + pad,
        y1: Math.ceil((canvas.height - t.f) / t.d) + pad,
    };
}

// When carving for a nearest-neighbor overlay at integer device scale where
// source and every active occluder land on whole world texels, carving at 1x
// and scaling on blit is bit-identical to carving at `scale` while touching
// `scale^2` fewer scratch pixels. Any fractional scale, fractional occluder
// placement (sub-texel moving bodies), fallback fillRect occluder, or smoothed
// target (bloom) stays on full `scale`.
function resolveCarveScale(ctx, x, y, occluders, scale) {
    if (!(scale > 1) || ctx.imageSmoothingEnabled !== false) return scale;
    if (!Number.isInteger(scale) || !Number.isInteger(x) || !Number.isInteger(y)) return scale;
    for (let i = 0; i < occluders.length; i++) {
        const rect = occluders[i];
        if (!rect.image || !Number.isInteger(rect.x) || !Number.isInteger(rect.y)) return scale;
        if (rect.sx !== undefined && (!Number.isInteger(rect.sx) || !Number.isInteger(rect.sy)
            || !Number.isInteger(rect.w) || !Number.isInteger(rect.h))) {
            return scale;
        }
    }
    return 1;
}

// The carve runs at the overlay's device scale (`scale` device px per world
// px): a body placed on a sub-texel step at zoom or DPR > 1 is cut back out
// on the device pixels it covered, so no 1-px strip of graded flame is left
// along its silhouette. Clips to the caller's source sub-rect while preserving
// sub-pixel alignment (ox, oy) on fractional scales, and clears a 2-px apron
// past (w, h) so bilinear bloom draws never sample stale texels from earlier
// draws in the same scratch bucket.
function carvedSubRect(source, sx, sy, sw, sh, x, y, occluders, scale, clipOffsetX = 0, clipOffsetY = 0) {
    const dx0 = Math.floor(clipOffsetX * scale);
    const dy0 = Math.floor(clipOffsetY * scale);
    const ox = clipOffsetX * scale - dx0;
    const oy = clipOffsetY * scale - dy0;
    const w = Math.max(1, Math.ceil(sw * scale + ox));
    const h = Math.max(1, Math.ceil(sh * scale + oy));
    const scratch = scratchCanvasFor(w + 1, h + 1);
    const ctx = scratch.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.globalCompositeOperation = 'source-over';
    ctx.clearRect(0, 0, Math.min(scratch.width, w + 2), Math.min(scratch.height, h + 2));
    ctx.setTransform(scale, 0, 0, scale, ox, oy);
    if (sx === 0 && sy === 0 && sw === source.width && sh === source.height) {
        ctx.drawImage(source, 0, 0);
    } else {
        ctx.drawImage(source, sx, sy, sw, sh, 0, 0, sw, sh);
    }
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fillStyle = '#000';
    for (let i = 0; i < occluders.length; i++) {
        const rect = occluders[i];
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
    return { canvas: scratch, w, h, ox, oy };
}

function drawCarvedSubRect(ctx, source, sx, sy, sw, sh, x, y, occluders, scale, viewBounds = null, fullSource = false) {
    let csx = sx;
    let csy = sy;
    let cw = sw;
    let ch = sh;
    let cx = x;
    let cy = y;
    let clipOffsetX = 0;
    let clipOffsetY = 0;
    if (viewBounds) {
        const left = Math.max(0, Math.floor(viewBounds.x0 - x));
        const top = Math.max(0, Math.floor(viewBounds.y0 - y));
        const right = Math.min(sw, Math.ceil(viewBounds.x1 - x));
        const bottom = Math.min(sh, Math.ceil(viewBounds.y1 - y));
        if (right <= left || bottom <= top) return false;
        if (left > 0 || top > 0 || right < sw || bottom < sh) {
            csx = sx + left;
            csy = sy + top;
            cw = right - left;
            ch = bottom - top;
            cx = x + left;
            cy = y + top;
            clipOffsetX = left;
            clipOffsetY = top;
        }
    }
    let activeOccluders = occluders;
    if (occluders.length && (cw !== sw || ch !== sh || cx !== x || cy !== y)) {
        const filtered = [];
        for (let i = 0; i < occluders.length; i++) {
            if (overlaps(occluders[i], cx, cy, cw, ch)) filtered.push(occluders[i]);
        }
        activeOccluders = filtered;
    }
    if (!activeOccluders.length) {
        emitterPerfStats.uncarvedDraws++;
        if (fullSource && csx === 0 && csy === 0 && cw === source.width && ch === source.height) {
            ctx.drawImage(source, cx, cy);
        } else {
            ctx.drawImage(source, csx, csy, cw, ch, cx, cy, cw, ch);
        }
        return true;
    }
    emitterPerfStats.carvedDraws++;
    const carveScale = resolveCarveScale(ctx, cx, cy, activeOccluders, scale);
    const carved = carvedSubRect(source, csx, csy, cw, ch, cx, cy, activeOccluders, carveScale, clipOffsetX, clipOffsetY);
    ctx.drawImage(carved.canvas, 0, 0, carved.w, carved.h, cx - carved.ox / carveScale, cy - carved.oy / carveScale, carved.w / carveScale, carved.h / carveScale);
    return true;
}

const bloomOps = [];
const bloomOpPool = [];
function pushBloomOp(list, source, sourceRev, sx, sy, sw, sh, x, y, alpha, occluders) {
    const idx = list.length;
    let op = bloomOpPool[idx];
    if (!op) {
        op = { source: null, sourceRev: 0, sx: 0, sy: 0, sw: 0, sh: 0, x: 0, y: 0, alpha: 1, occluders: null };
        bloomOpPool[idx] = op;
    }
    op.source = source;
    op.sourceRev = sourceRev;
    op.sx = sx;
    op.sy = sy;
    op.sw = sw;
    op.sh = sh;
    op.x = x;
    op.y = y;
    op.alpha = alpha;
    op.occluders = occluders;
    list.push(op);
}

let bloomLayer = null;
let bloomDocument = null;
let bloomRevision = 0;
let bloomPrevBounds = null;
let bloomForceFullRefresh = true;
let bloomPrevSig = [];
let bloomCurrSig = [];

function resetBloomLayer() {
    if (bloomLayer && bloomPrevBounds) {
        const bCtx = bloomLayer.getContext('2d');
        bCtx.setTransform(1, 0, 0, 1, 0, 0);
        bCtx.globalAlpha = 1;
        bCtx.globalCompositeOperation = 'source-over';
        bCtx.clearRect(
            bloomPrevBounds.x0,
            bloomPrevBounds.y0,
            bloomPrevBounds.x1 - bloomPrevBounds.x0,
            bloomPrevBounds.y1 - bloomPrevBounds.y0,
        );
        bloomPrevBounds = null;
        bloomRevision++;
    }
    bloomForceFullRefresh = true;
    bloomPrevSig.length = 0;
}

function ensureBloomCanvas(width, height) {
    if (typeof document === 'undefined') return { canvas: null, resized: false };
    let resized = false;
    if (!bloomLayer || bloomDocument !== document) {
        bloomDocument = document;
        bloomLayer = document.createElement('canvas');
        bloomLayer.width = width;
        bloomLayer.height = height;
        bloomPrevBounds = null;
        bloomForceFullRefresh = true;
        bloomPrevSig.length = 0;
        resized = true;
    } else if (bloomLayer.width !== width || bloomLayer.height !== height) {
        bloomLayer.width = width;
        bloomLayer.height = height;
        bloomPrevBounds = null;
        bloomForceFullRefresh = true;
        bloomPrevSig.length = 0;
        resized = true;
    }
    return { canvas: bloomLayer, resized };
}

function projectBoundsToBloom(bounds, x, y, w, h, ba, bb, bc, bd, be, bf, maxW, maxH) {
    const x0 = x * ba + y * bc + be;
    const y0 = x * bb + y * bd + bf;
    const x1 = (x + w) * ba + (y + h) * bc + be;
    const y1 = (x + w) * bb + (y + h) * bd + bf;
    const px0 = Math.max(0, Math.floor(Math.min(x0, x1)) - 2);
    const py0 = Math.max(0, Math.floor(Math.min(y0, y1)) - 2);
    const px1 = Math.min(maxW, Math.ceil(Math.max(x0, x1)) + 2);
    const py1 = Math.min(maxH, Math.ceil(Math.max(y0, y1)) + 2);
    if (px1 <= px0 || py1 <= py0) return bounds;
    if (!bounds) return { x0: px0, y0: py0, x1: px1, y1: py1 };
    if (px0 < bounds.x0) bounds.x0 = px0;
    if (py0 < bounds.y0) bounds.y0 = py0;
    if (px1 > bounds.x1) bounds.x1 = px1;
    if (py1 > bounds.y1) bounds.y1 = py1;
    return bounds;
}

function unionBloomRects(a, b, maxW, maxH) {
    if (!a && !b) return null;
    if (!a) return { x: b.x0, y: b.y0, w: b.x1 - b.x0, h: b.y1 - b.y0 };
    if (!b) return { x: a.x0, y: a.y0, w: a.x1 - a.x0, h: a.y1 - a.y0 };
    const x0 = Math.max(0, Math.min(a.x0, b.x0));
    const y0 = Math.max(0, Math.min(a.y0, b.y0));
    const x1 = Math.min(maxW, Math.max(a.x1, b.x1));
    const y1 = Math.min(maxH, Math.max(a.y1, b.y1));
    if (x1 <= x0 || y1 <= y0) return null;
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

function signaturesEqual(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) return false;
    }
    return true;
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
    backingOwner = renderer;
    const energy = sourceEnergyFor(atmosphere?.lighting);
    const core = energy.core;
    const isDaylight = energy.bucket === 'daylight';
    if (!(core > 0.02)) {
        resetBloomLayer();
        return null;
    }
    const viewport = renderer._screenViewport?.() || null;
    const topLeft = viewport ? camera.screenToWorld(0, 0) : null;
    const bottomRight = viewport ? camera.screenToWorld(viewport.width, viewport.height) : null;
    ctx.save();
    camera.applyTransform(ctx);
    ctx.imageSmoothingEnabled = false;
    ctx.globalCompositeOperation = 'source-over';
    const transform = ctx.getTransform();
    const scale = Math.max(1, Math.hypot(transform.a, transform.b));
    const viewBounds = visibleWorldBoundsFor(ctx, 1);
    const frameOccluders = buildFrameOccluders(renderer);
    const wantBloom = bloomScale > 0 && Boolean(ctx.canvas);
    bloomOps.length = 0;
    ctx.globalAlpha = 1;
    const grade = atmosphere?.lightGrade || null;
    drawMirrorAccentCuts(ctx, renderer, atmosphere, core, topLeft, bottomRight, frameOccluders, viewBounds);
    for (const emitter of emitterPlacements(renderer, frameOccluders.buildings)) {
        const emitterCore = isDaylight && emitter.daytimeEmitter ? DAYTIME_WORK_BLOOM_CORE : core;
        drawSpriteCut(ctx, renderer, emitter, emitterCore, scale, topLeft, bottomRight, wantBloom ? bloomOps : null, grade, frameOccluders, viewBounds);
        if (emitter.building) drawPartCuts(ctx, renderer, emitter, emitterCore, scale, topLeft, bottomRight, wantBloom ? bloomOps : null, isDaylight, core, grade, frameOccluders, viewBounds);
    }

    let returnedBloom = null;
    if (wantBloom) {
        const bloomWidth = Math.max(1, Math.ceil(ctx.canvas.width * bloomScale));
        const bloomHeight = Math.max(1, Math.ceil(ctx.canvas.height * bloomScale));
        const ba = transform.a * bloomScale;
        const bb = transform.b * bloomScale;
        const bc = transform.c * bloomScale;
        const bd = transform.d * bloomScale;
        const be = transform.e * bloomScale;
        const bf = transform.f * bloomScale;
        const { canvas: targetCanvas, resized } = ensureBloomCanvas(bloomWidth, bloomHeight);

        // Inspect harbor ship lamps so we know if they emit into bloomCtx and
        // whether any ship pose changed since last frame.
        const harbor = renderer.harborTraffic;
        const hasLampMethod = typeof harbor?.drawLampCuts === 'function';
        let shipLampsOpaque = false;
        let hasShipLamps = false;
        const sig = bloomCurrSig;
        sig.length = 0;
        sig.push(bloomWidth, bloomHeight, ba, bb, bc, bd, be, bf, bloomOps.length);
        for (let i = 0; i < bloomOps.length; i++) {
            const op = bloomOps[i];
            const occ = op.occluders;
            sig.push(op.source, op.sourceRev, op.sx, op.sy, op.sw, op.sh, op.x, op.y, op.alpha, occ.length);
            for (let j = 0; j < occ.length; j++) {
                const o = occ[j];
                sig.push(o.image ?? null, o.rev ?? 0, o.sx ?? -1, o.sy ?? -1, o.x, o.y, o.w, o.h);
            }
        }
        let shipBounds = null;
        if (hasLampMethod) {
            if (harbor._lampsLit === false) {
                sig.push(0);
            } else if (harbor._lampsLit === true && Array.isArray(harbor._hullItems)) {
                const items = harbor._hullItems;
                let shipCount = 0;
                const countPos = sig.length;
                sig.push(0);
                for (let i = 0; i < items.length; i++) {
                    const item = items[i];
                    const pose = item?.pose;
                    const lampAlpha = pose ? pose.alpha * core : 0;
                    if (!pose?.lamps || item.behindBuilding || !(lampAlpha > 0.02)) continue;
                    shipCount++;
                    hasShipLamps = true;
                    const g = hullGeometry(pose);
                    sig.push(pose.lamps, pose.lamps.image ?? null, g.x, g.y, g.sx, g.width, g.height, Math.min(1, lampAlpha));
                    shipBounds = projectBoundsToBloom(shipBounds, g.x, g.y, g.width, g.height, ba, bb, bc, bd, be, bf, bloomWidth, bloomHeight);
                }
                sig[countPos] = shipCount;
            } else {
                shipLampsOpaque = true;
                hasShipLamps = true;
            }
        }

        if (!bloomOps.length && !hasShipLamps && !shipLampsOpaque) {
            harbor?.drawLampCuts?.(ctx, core, null);
            resetBloomLayer();
            emitterPerfStats.bloomEmptySkips++;
            returnedBloom = null;
        } else if (targetCanvas && !resized && !bloomForceFullRefresh && !shipLampsOpaque && signaturesEqual(sig, bloomPrevSig)) {
            harbor?.drawLampCuts?.(ctx, core, null);
            targetCanvas._cvEmissionMeta = {
                revision: bloomRevision,
                prevRevision: bloomRevision,
                dirtyRect: null,
                fullRefresh: false,
            };
            emitterPerfStats.bloomReuses++;
            returnedBloom = bloomPrevBounds ? targetCanvas : null;
        } else if (targetCanvas) {
            const fullRefresh = resized || bloomForceFullRefresh || !bloomPrevBounds;
            const bCtx = targetCanvas.getContext('2d');
            bCtx.setTransform(1, 0, 0, 1, 0, 0);
            bCtx.globalAlpha = 1;
            bCtx.globalCompositeOperation = 'source-over';
            if (fullRefresh) {
                bCtx.clearRect(0, 0, bloomWidth, bloomHeight);
            } else {
                bCtx.clearRect(
                    bloomPrevBounds.x0,
                    bloomPrevBounds.y0,
                    bloomPrevBounds.x1 - bloomPrevBounds.x0,
                    bloomPrevBounds.y1 - bloomPrevBounds.y0,
                );
            }
            bCtx.setTransform(ba, bb, bc, bd, be, bf);
            bCtx.imageSmoothingEnabled = true;
            bCtx.globalCompositeOperation = 'lighter';
            let currBounds = shipLampsOpaque ? { x0: 0, y0: 0, x1: bloomWidth, y1: bloomHeight } : shipBounds;
            for (let i = 0; i < bloomOps.length; i++) {
                const op = bloomOps[i];
                const projected = projectBoundsToBloom(null, op.x, op.y, op.sw, op.sh, ba, bb, bc, bd, be, bf, bloomWidth, bloomHeight);
                if (!projected) continue;
                bCtx.globalAlpha = op.alpha;
                // Do not sub-rect crop smoothed bilinear bloom emitters mid-sprite.
                const drawn = drawCarvedSubRect(
                    bCtx,
                    op.source,
                    op.sx,
                    op.sy,
                    op.sw,
                    op.sh,
                    op.x,
                    op.y,
                    op.occluders,
                    scale,
                    null,
                    op.sx === 0 && op.sy === 0 && op.sw === op.source.width && op.sh === op.source.height,
                );
                if (drawn && !shipLampsOpaque) {
                    currBounds = projectBoundsToBloom(currBounds, op.x, op.y, op.sw, op.sh, ba, bb, bc, bd, be, bf, bloomWidth, bloomHeight);
                }
            }
            harbor?.drawLampCuts?.(ctx, core, bCtx);
            const dirtyRect = fullRefresh
                ? { x: 0, y: 0, w: bloomWidth, h: bloomHeight }
                : unionBloomRects(bloomPrevBounds, currBounds, bloomWidth, bloomHeight);
            const prevRevision = bloomRevision;
            bloomRevision++;
            bloomPrevBounds = currBounds;
            // Discontinuity guard: if nothing landed in bloom, force a full
            // upload once emitters return so GPU never retains stale texels.
            bloomForceFullRefresh = !currBounds;
            // Swap signature arrays without reallocating.
            const swap = bloomPrevSig;
            bloomPrevSig = bloomCurrSig;
            bloomCurrSig = swap;
            if (shipLampsOpaque || !currBounds) bloomPrevSig.length = 0;
            targetCanvas._cvEmissionMeta = {
                revision: bloomRevision,
                prevRevision,
                dirtyRect,
                fullRefresh,
            };
            emitterPerfStats.bloomRedraws++;
            returnedBloom = currBounds ? targetCanvas : null;
        }
    } else {
        // 5.3 — lit ship lamps (masthead and stern lanterns), cut like panes.
        renderer.harborTraffic?.drawLampCuts?.(ctx, core, null);
    }

    // 2.7 — the Lighthouse lamp's own light (halo, lens flash, fans).
    ctx.globalAlpha = 1;
    renderer.buildingRenderer?.drawLanternLight?.(ctx);
    ctx.restore();
    return returnedBloom;
}

// W2 (spec 02 §4.3/§4.5/§4.7/§4.8) — Canvas fallback overlays: cached golden
// silhouette rim, Afterglow top-20 % alpenglow, and west-window apricot glint,
// drawn after the frame grade and right under `drawCanvasEmitterCuts`.
const overlayAssets = new WeakMap();
const canvasGradeOverlayCache = new CanvasOverlayStampCache();

function occluderSidecarFor(assets, id, occluderSidecars) {
    const companion = assets.getCompanion?.(id, 'occluder');
    if (companion) return companion;
    const key = `${assets.assetVersion || ''}|${id}`;
    const cached = occluderSidecars.get(key);
    if (cached !== undefined) return cached === 'loading' ? null : cached;
    const albedo = assets.get?.(id);
    const src = typeof albedo?.src === 'string' ? albedo.src : '';
    if (assets.getEntry && !assets.getEntry(id)?.occluderSidecar) {
        occluderSidecars.set(key, null);
        return null;
    }
    if (!src || typeof Image === 'undefined') {
        occluderSidecars.set(key, null);
        return null;
    }
    const image = new Image();
    occluderSidecars.set(key, 'loading');
    image.onload = () => occluderSidecars.set(key, image);
    image.onerror = () => occluderSidecars.set(key, null);
    image.src = src.replace(/\.png(?=([?#]|$))/, '.occluder.png');
    return null;
}

function readImageRgba(image, width, height) {
    if (!image || !width || !height) return null;
    const scratch = document.createElement('canvas');
    scratch.width = width;
    scratch.height = height;
    const sctx = scratch.getContext('2d', { willReadFrequently: true });
    sctx.drawImage(image, 0, 0, width, height);
    const data = sctx.getImageData(0, 0, width, height).data;
    scratch.width = 0;
    scratch.height = 0;
    return data;
}

function gradeOverlayDescriptorFor(assets, id, entry, gate, glass, panes) {
    let cache = overlayAssets.get(assets);
    if (!cache || cache.version !== assets.assetVersion) {
        cache = { version: assets.assetVersion, occluders: new Map(), descriptors: new Map() };
        overlayAssets.set(assets, cache);
    }
    const albedoImg = assets.get?.(id);
    const width = albedoImg?.naturalWidth || albedoImg?.width || 0;
    const height = albedoImg?.naturalHeight || albedoImg?.height || 0;
    if (!width || !height) return null;
    const alpenglowRow = Number(entry?.alpenglowRow) || 0;
    const surfaceCoded = entry?.surfaceCode === true;
    const occluderImg = surfaceCoded ? occluderSidecarFor(assets, id, cache.occluders) : null;
    const emissiveImg = surfaceCoded && entry?.emissiveSidecar === true ? emissiveSidecarFor(assets, id) : null;
    if (!alpenglowRow && !occluderImg) return null;
    const key = `${assets.assetVersion || ''}|${id}`;
    let entryState = cache.descriptors.get(key);
    if (!entryState || entryState.albedoImg !== albedoImg || entryState.occluderImg !== occluderImg || entryState.emissiveImg !== emissiveImg) {
        const albedo = readImageRgba(albedoImg, width, height);
        const geometry = occluderImg ? readImageRgba(occluderImg, width, height) : null;
        const emissiveRgba = emissiveImg ? readImageRgba(emissiveImg, width, height) : null;
        entryState = {
            albedoImg,
            occluderImg,
            emissiveImg,
            emissiveRgba,
            unlitKey: '',
            descriptor: {
                width,
                height,
                albedo,
                geometry,
                alpenglowRow,
                unlitEmitter: null,
                revision: 1,
            },
        };
        cache.descriptors.set(key, entryState);
    }
    const gx0 = Math.round(glass?.left ?? glass?.x ?? 0);
    const gy0 = Math.round(glass?.top ?? glass?.y ?? 0);
    const unlitKey = `${gate === 0}|${gx0},${gy0}`;
    if ((panes || entryState.emissiveRgba) && (entryState.unlitKey !== unlitKey || entryState.panes !== panes)) {
        entryState.unlitKey = unlitKey;
        entryState.panes = panes;
        const mask = new Uint8Array(width * height);
        if (panes) {
            const { w, h } = panes.map;
            for (let y = 0; y < h; y++) {
                const sy = gy0 + y;
                if (sy < 0 || sy >= height) continue;
                const start = Math.max(0, -gx0);
                const end = Math.min(w, width - gx0);
                if (start < end) mask.set(panes.data.subarray(y * w + start, y * w + end), sy * width + gx0 + start);
            }
        } else if (gate === 0 && !glass && entryState.emissiveRgba) {
            for (let p = 0; p < mask.length; p++) mask[p] = entryState.emissiveRgba[p * 4 + 3];
        }
        entryState.descriptor.unlitEmitter = mask;
        entryState.descriptor.revision += 1;
    }
    return entryState.descriptor;
}

export function drawCanvasGradeOverlays(ctx, renderer, atmosphere) {
    const assets = renderer?.assets;
    const camera = renderer?.camera;
    const grade = atmosphere?.lightGrade || null;
    if (!ctx || !assets || !camera || !grade) return;
    if (!(grade.rimStrength > 0) && !(grade.afterglow > 0) && !(grade.windowGlint > 0)) return;
    const viewport = renderer._screenViewport?.() || null;
    const topLeft = viewport ? camera.screenToWorld(0, 0) : null;
    const bottomRight = viewport ? camera.screenToWorld(viewport.width, viewport.height) : null;
    ctx.save();
    camera.applyTransform(ctx);
    ctx.imageSmoothingEnabled = false;
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    const transform = ctx.getTransform();
    const scale = Math.max(1, Math.hypot(transform.a, transform.b));
    const buildings = renderer.buildingRenderer;
    const buildingDrawables = buildings?.enumerateDrawables?.() || [];
    const seen = new Set();
    for (const drawable of buildingDrawables) {
        const building = drawable.building;
        const id = drawable.entry?.id;
        if (!building || !id || seen.has(building)) continue;
        seen.add(building);
        const entry = assets.getEntry?.(id) || drawable.entry;
        if (!entry?.surfaceCode && !(Number(entry?.alpenglowRow) > 0)) continue;
        const gate = buildings._emissiveGateFor?.(building) ?? 1;
        const glass = buildings.glassPatchFor?.(building) || null;
        const panes = grade.windowGlint > 0 ? roomGlintMask(buildings, building.type, glass) : null;
        const desc = gradeOverlayDescriptorFor(assets, id, entry, gate, glass, panes);
        if (!desc) continue;
        const stamp = canvasGradeOverlayCache.get(desc, grade);
        if (!stamp) continue;
        const [ax, ay] = assets.getAnchor(id);
        const x = Math.round(drawable.wx - ax);
        const y = Math.round(drawable.wy - ay);
        if (topLeft && (x > bottomRight.x || y > bottomRight.y || x + stamp.width < topLeft.x || y + stamp.height < topLeft.y)) continue;
        const sortYAtX = (worldX) => buildingColumnSortY(buildingDrawables, building, worldX, drawable.sortY);
        drawCarvedBuildingLayer(ctx, renderer, { canvas: stamp, x, y }, building, sortYAtX);
    }
    if (grade.afterglow > 0) {
        const viewBounds = visibleWorldBoundsFor(ctx, 1);
        const frameOccluders = buildFrameOccluders(renderer);
        for (const sprite of renderer.districtPropSprites || []) {
            const id = sprite?.id;
            const entry = id ? assets.getEntry?.(id) : null;
            if (!entry || !(Number(entry.alpenglowRow) > 0)) continue;
            const desc = gradeOverlayDescriptorFor(assets, id, entry, 0, null);
            if (!desc) continue;
            const stamp = canvasGradeOverlayCache.get(desc, grade);
            if (!stamp) continue;
            const [ax, ay] = assets.getAnchor(id);
            const x = Math.round(sprite.x - ax);
            const y = Math.round(sprite.y - ay);
            if (topLeft && (x > bottomRight.x || y > bottomRight.y || x + stamp.width < topLeft.x || y + stamp.height < topLeft.y)) continue;
            const occluders = occludersFor(renderer, sprite.sortY, sprite.sortY, x, y, stamp.width, stamp.height, id, frameOccluders);
            drawCarvedSubRect(ctx, stamp, 0, 0, stamp.width, stamp.height, x, y, occluders, scale, viewBounds, true);
        }
    }
    ctx.restore();
}

// 3.7 — the Canvas twin of the lit mirror accent records: each lit glass
// group's accents at its gate, under every building cut. The gate is an
// ordered 4x4 Bayer share of the accent texels the rain left (world-locked,
// `mirrorAccentRainCut`: EN-7, a fading room thins the survivors), never a
// partial alpha: a half-alpha amber over the graded teal water mixes to
// lime, so every drawn accent texel stays its own palette colour.
function drawMirrorAccentCuts(ctx, renderer, atmosphere, core, topLeft, bottomRight, frameOccluders = null, viewBounds = null) {
    // EN-7 — the frame's one mirror break (the mood layer's too).
    const drop = mirrorStormDrop(atmosphere?.weather, atmosphere);
    for (const whole of mirrorAccentLayers(renderer)) {
        const share = Math.min(1, mirrorAccentGate(renderer, whole, atmosphere) * core);
        if (share < 0.02) continue;
        const { x, y, w, h } = whole;
        if (topLeft && (x > bottomRight.x || y > bottomRight.y || x + w < topLeft.x || y + h < topLeft.y)) continue;
        const gated = mirrorAccentRainCut(whole, drop, share);
        if (gated) drawCarvedTerrainLayer(ctx, renderer, { canvas: gated.canvas, x, y, w, h }, frameOccluders, viewBounds);
    }
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

function alphaBoundsFromRgba(data, width, height) {
    let x0 = width;
    let y0 = height;
    let x1 = -1;
    let y1 = -1;
    for (let y = 0; y < height; y++) {
        const row = y * width * 4;
        for (let x = 0; x < width; x++) {
            if (data[row + x * 4 + 3] === 0) continue;
            if (x < x0) x0 = x;
            if (y < y0) y0 = y;
            if (x > x1) x1 = x;
            if (y > y1) y1 = y;
        }
    }
    if (x1 < 0) return null;
    return { sx: x0, sy: y0, sw: x1 - x0 + 1, sh: y1 - y0 + 1 };
}

function layerSubRect(layer, viewBounds) {
    const canvas = layer.canvas;
    const fullW = canvas.width;
    const fullH = canvas.height;
    let sx = 0;
    let sy = 0;
    let sw = fullW;
    let sh = fullH;
    const cb = layer.contentBounds;
    if (cb) {
        if (cb.sw <= 0 || cb.sh <= 0) return null;
        sx = cb.sx;
        sy = cb.sy;
        sw = cb.sw;
        sh = cb.sh;
    } else if (layer.sw !== undefined && layer.sh !== undefined) {
        sx = layer.sx || 0;
        sy = layer.sy || 0;
        sw = layer.sw;
        sh = layer.sh;
    }
    let x = layer.x + sx;
    let y = layer.y + sy;
    let clipOffsetX = 0;
    let clipOffsetY = 0;
    if (viewBounds) {
        const left = Math.max(0, Math.floor(viewBounds.x0 - x));
        const top = Math.max(0, Math.floor(viewBounds.y0 - y));
        const right = Math.min(sw, Math.ceil(viewBounds.x1 - x));
        const bottom = Math.min(sh, Math.ceil(viewBounds.y1 - y));
        if (right <= left || bottom <= top) return null;
        if (left > 0 || top > 0 || right < sw || bottom < sh) {
            sx += left;
            sy += top;
            sw = right - left;
            sh = bottom - top;
            x += left;
            y += top;
            clipOffsetX = left;
            clipOffsetY = top;
        }
    }
    return {
        sx,
        sy,
        sw,
        sh,
        x,
        y,
        clipOffsetX,
        clipOffsetY,
        fullSource: sx === 0 && sy === 0 && sw === fullW && sh === fullH,
    };
}

/**
 * Draws a world-space layer that lies on the terrain (`{ canvas, x, y }`,
 * world px) on the ungraded overlay `ctx` (camera transform applied), carved
 * by every villager, static sprite, landmark and harbour hull the depth pass
 * drew over it, by their own drawn pixels. Used by the 3.7 mirror accents
 * and the 2.9 water columns (CanvasWaterState `drawCanvasWaterColumns`).
 */
export function drawCarvedTerrainLayer(ctx, renderer, layer, frameOccluders = null, viewBounds = null) {
    if (renderer) backingOwner = renderer;
    const transform = ctx.getTransform();
    const scale = Math.max(1, Math.hypot(transform.a, transform.b));
    const bounds = viewBounds ?? visibleWorldBoundsFor(ctx, 1);
    const sub = layerSubRect(layer, bounds);
    if (!sub) return;
    const occluders = occludersFor(renderer, -Infinity, -Infinity, sub.x, sub.y, sub.sw, sub.sh, null, frameOccluders);
    const landmarks = landmarkOccluders(renderer, frameOccluders?.buildings || null);
    for (let i = 0; i < landmarks.length; i++) {
        const rect = landmarks[i];
        if (overlaps(rect, sub.x, sub.y, sub.sw, sub.sh)) occluders.push(rect);
    }
    hullOccluders(renderer, sub.x, sub.y, sub.sw, sub.sh, occluders);
    if (!occluders.length) {
        emitterPerfStats.uncarvedDraws++;
        if (sub.fullSource) ctx.drawImage(layer.canvas, sub.x, sub.y);
        else ctx.drawImage(layer.canvas, sub.sx, sub.sy, sub.sw, sub.sh, sub.x, sub.y, sub.sw, sub.sh);
        return;
    }
    emitterPerfStats.carvedDraws++;
    const carveScale = resolveCarveScale(ctx, sub.x, sub.y, occluders, scale);
    const carved = carvedSubRect(
        layer.canvas,
        sub.sx,
        sub.sy,
        sub.sw,
        sub.sh,
        sub.x,
        sub.y,
        occluders,
        carveScale,
        sub.clipOffsetX,
        sub.clipOffsetY,
    );
    ctx.drawImage(carved.canvas, 0, 0, carved.w, carved.h, sub.x - carved.ox / carveScale, sub.y - carved.oy / carveScale, carved.w / carveScale, carved.h / carveScale);
}

// Static rock crystals only: existing authored cool emission, not reserve,
// cargo or assay art. Restore their own cyan/mint palette faintly after C2.
export function drawMineCrystalGlow(ctx, renderer) {
    if (renderer.villageLampsLit?.() !== true) return;
    const buildings = renderer.buildingRenderer;
    const cache = buildingDrawablesCacheFor(renderer);
    const buildingDrawables = cache.drawables;
    const drawable = buildingDrawables.find(d => d.building?.type === 'mine');
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
        const canvasBounds = alphaBoundsFromRgba(art.data, w, h);
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
        const haloBounds = alphaBoundsFromRgba(haloArt.data, w, h);
        cut = buildings._mineCrystalCut = { image, mask, version, canvas, halo, canvasBounds, haloBounds };
    }
    const [ax, ay] = assets.getAnchor(id);
    const group = cache.byBuilding.get(drawable.building);
    const mineDepth = group
        ? (worldX) => buildingEntriesColumnSortY(group.entries, worldX, drawable.sortY)
        : (worldX) => buildingColumnSortY(buildingDrawables, drawable.building, worldX, drawable.sortY);
    const baseX = Math.round(drawable.wx - ax);
    const baseY = Math.round(drawable.wy - ay);
    ctx.save();
    ctx.globalAlpha = 0.65;
    if (cut.haloBounds) {
        drawCarvedBuildingLayer(ctx, renderer, {
            canvas: cut.halo, x: baseX, y: baseY, contentBounds: cut.haloBounds,
        }, drawable.building, mineDepth);
    }
    if (cut.canvasBounds) {
        drawCarvedBuildingLayer(ctx, renderer, {
            canvas: cut.canvas, x: baseX, y: baseY, contentBounds: cut.canvasBounds,
        }, drawable.building, mineDepth);
    }
    ctx.restore();
}

/**
 * A building-local emitter layer, carved at its owner's painter depth on
 * every backend. Unlike terrain light, the owner's own rock must not erase
 * the cut; later landmarks, props and body silhouettes still cover it.
 */
export function drawCarvedBuildingLayer(ctx, renderer, layer, owner, sortY) {
    if (renderer) backingOwner = renderer;
    const transform = ctx.getTransform();
    const scale = Math.max(1, Math.hypot(transform.a, transform.b));
    const viewBounds = visibleWorldBoundsFor(ctx, 1);
    const sub = layerSubRect(layer, viewBounds);
    if (!sub) return;
    // Evaluate column sortY at the uncropped layer center so contentBounds or
    // viewport clipping never shifts the static-prop depth threshold.
    const staticSortY = typeof sortY === 'function'
        ? sortY(layer.x + layer.canvas.width / 2)
        : sortY;
    const occluders = occludersFor(renderer, sortY, staticSortY, sub.x, sub.y, sub.sw, sub.sh);
    const assets = renderer.assets;
    const cache = buildingDrawablesCacheFor(renderer);
    const drawables = cache.drawables;
    const resolvedMap = cache.resolvedDrawables;
    for (let i = 0; i < drawables.length; i++) {
        const drawable = drawables[i];
        if (!drawable.building || drawable.building === owner) continue;
        const threshold = typeof sortY === 'function'
            ? sortY(drawable.column ? (drawable.column.worldLeft + drawable.column.worldRight) / 2 : drawable.wx)
            : sortY;
        if (!(drawable.sortY > threshold)) continue;
        const id = drawable.entry?.id;
        const image = assets.get?.(id);
        const anchor = assets.getAnchor?.(id);
        if (!image || !anchor) continue;
        let rect = resolvedMap.get(drawable);
        const imgW = image.naturalWidth || image.width;
        const imgH = image.naturalHeight || image.height;
        const originX = Math.round(drawable.wx - anchor[0]);
        const originY = Math.round(drawable.wy - anchor[1]);
        if (!rect || rect.image !== image || rect.originX !== originX || rect.originY !== originY
            || rect.imgW !== imgW || rect.imgH !== imgH) {
            rect = drawable.kind === 'building-column' && drawable.column
                ? {
                    originX,
                    originY,
                    imgW,
                    imgH,
                    x: originX + drawable.column.sx,
                    y: originY,
                    w: drawable.column.sw,
                    h: imgH,
                    image,
                    sx: drawable.column.sx,
                    sy: 0,
                }
                : { originX, originY, imgW, imgH, x: originX, y: originY, w: imgW, h: imgH, image };
            resolvedMap.set(drawable, rect);
        }
        if (overlaps(rect, sub.x, sub.y, sub.sw, sub.sh)) occluders.push(rect);
    }
    if (!occluders.length) {
        emitterPerfStats.uncarvedDraws++;
        if (sub.fullSource) ctx.drawImage(layer.canvas, sub.x, sub.y);
        else ctx.drawImage(layer.canvas, sub.sx, sub.sy, sub.sw, sub.sh, sub.x, sub.y, sub.sw, sub.sh);
        return;
    }
    emitterPerfStats.carvedDraws++;
    const carveScale = resolveCarveScale(ctx, sub.x, sub.y, occluders, scale);
    const carved = carvedSubRect(
        layer.canvas,
        sub.sx,
        sub.sy,
        sub.sw,
        sub.sh,
        sub.x,
        sub.y,
        occluders,
        carveScale,
        sub.clipOffsetX,
        sub.clipOffsetY,
    );
    ctx.drawImage(carved.canvas, 0, 0, carved.w, carved.h, sub.x - carved.ox / carveScale, sub.y - carved.oy / carveScale, carved.w / carveScale, carved.h / carveScale);
}

// Each landmark's drawn base image at its placement, cached per drawable revision.
function landmarkOccluders(renderer, buildingCache = null) {
    const assets = renderer.assets;
    const cache = buildingCache || buildingDrawablesCacheFor(renderer);
    if (cache.landmarks) {
        let valid = true;
        if (cache.landmarkPendingIds?.length) {
            for (let i = 0; i < cache.landmarkPendingIds.length; i++) {
                if (assets.get?.(cache.landmarkPendingIds[i])) {
                    valid = false;
                    break;
                }
            }
        }
        if (valid && cache.landmarkImages) {
            for (let i = 0; i < cache.landmarkImages.length; i++) {
                const item = cache.landmarkImages[i];
                if (assets.get?.(item.id) !== item.image) {
                    valid = false;
                    break;
                }
            }
        }
        if (valid) {
            emitterPerfStats.landmarkCacheHits++;
            return cache.landmarks;
        }
    }
    emitterPerfStats.landmarkCacheRebuilds++;
    const out = [];
    const pendingIds = [];
    const images = [];
    const seen = new Set();
    for (let i = 0; i < cache.drawables.length; i++) {
        const drawable = cache.drawables[i];
        if (!drawable.building || seen.has(drawable.building)) continue;
        seen.add(drawable.building);
        const id = drawable.entry?.id;
        const image = id ? assets.get?.(id) : null;
        const anchor = id ? assets.getAnchor?.(id) : null;
        if (!image || !anchor) {
            if (id && !image) pendingIds.push(id);
            continue;
        }
        const w = image.naturalWidth || image.width;
        const h = image.naturalHeight || image.height;
        images.push({ id, image });
        out.push({ x: Math.round(drawable.wx - anchor[0]), y: Math.round(drawable.wy - anchor[1]), w, h, image });
    }
    cache.landmarks = out;
    cache.landmarkPendingIds = pendingIds;
    cache.landmarkImages = images;
    return out;
}

function drawSpriteCut(ctx, renderer, emitter, core, scale, topLeft, bottomRight, bloomOpsList, grade = null, frameOccluders = null, viewBounds = null) {
    const assets = renderer.assets;
    const alpha = Math.min(1, Math.max(0, emitter.gate) * core);
    if (alpha < 0.02) return;
    const cut = cutFor(assets, emitter.id, grade, emitter.placement);
    if (!cut) return;
    const [ax, ay] = emitter.placement ? [0, 0] : assets.getAnchor(emitter.id);
    const x = Math.round(emitter.x - ax) + cut.x;
    const y = Math.round(emitter.y - ay) + cut.y;
    const { width, height } = cut.canvas;
    if (topLeft && (x > bottomRight.x || y > bottomRight.y || x + width < topLeft.x || y + height < topLeft.y)) return;
    const occluders = occludersFor(renderer, emitter.sortY, emitter.staticSortY ?? emitter.sortY, x, y, width, height, emitter.skipPropPrefix || null, frameOccluders);
    if (emitter.glass) {
        const glass = emitter.glass;
        const gw = glass.w ?? glass.canvas?.width ?? 0;
        const gh = glass.h ?? glass.canvas?.height ?? 0;
        occluders.push({ x: x - cut.x + glass.left, y: y - cut.y + glass.top, w: gw, h: gh, image: glass.canvas, rev: glass.revision ?? 0 });
    }
    ctx.globalAlpha = alpha;
    drawCarvedSubRect(ctx, cut.canvas, 0, 0, width, height, x, y, occluders, scale, viewBounds, true);
    if (bloomOpsList) {
        pushBloomOp(bloomOpsList, cut.bloom, cut._revision || 0, 0, 0, width, height, x, y, alpha, occluders);
    }
}

/**
 * Lightweight O(1) accounting for persistent volatile canvas backing retained
 * by EmitterCuts (pooled carve scratch canvases + cached hybrid bloom layer).
 * Safe for periodic budget telemetry without enumerating scratch buckets.
 * Pass `renderer` to attribute shared module backing only to its current owner.
 */
export function emitterCutsVolatilePixels(renderer = null) {
    if (renderer && backingOwner && backingOwner !== renderer) {
        return { scratch: 0, bloom: 0, total: 0 };
    }
    const scratch = Math.round(scratchBucketBytes / 4) + canvasPixelCount(scratchOversize);
    const bloom = canvasPixelCount(bloomLayer);
    return {
        scratch,
        bloom,
        total: scratch + bloom,
    };
}

/**
 * Releases persistent carve scratch canvases and the cached hybrid bloom
 * backing store (for Dashboard suspend, renderer dispose, or WebGL context
 * restore). Subsequent draws allocate fresh backing stores and emit a full
 * bloom refresh.
 */
export function releaseEmitterCutsBacking(renderer = null) {
    if (renderer) {
        staticPropCacheMap.delete(renderer);
        buildingCacheMap.delete(renderer);
        if (backingOwner && backingOwner !== renderer) return;
    }
    releaseScratchPool();
    if (bloomLayer) {
        releaseCanvasBackingStore(bloomLayer);
        bloomLayer = null;
    }
    bloomDocument = null;
    bloomPrevBounds = null;
    bloomForceFullRefresh = true;
    bloomPrevSig.length = 0;
    bloomCurrSig.length = 0;
    bloomOps.length = 0;
    for (let i = 0; i < bloomOpPool.length; i++) {
        const op = bloomOpPool[i];
        op.source = null;
        op.occluders = null;
    }
    backingOwner = null;
    bloomRevision++;
}

export function emitterCutsDiagnostics() {
    const buckets = [];
    for (const [key, canvas] of scratchBuckets) {
        buckets.push({ w: canvas.width, h: canvas.height, key });
    }
    return {
        ...emitterPerfStats,
        buckets,
        scratchBucketBytes,
        scratchMaxBytes: SCRATCH_MAX_BYTES,
        oversizeScratch: scratchOversize ? { w: scratchOversize.width, h: scratchOversize.height } : null,
        bloomRevision,
        bloomBounds: bloomPrevBounds ? {
            x: bloomPrevBounds.x0,
            y: bloomPrevBounds.y0,
            w: bloomPrevBounds.x1 - bloomPrevBounds.x0,
            h: bloomPrevBounds.y1 - bloomPrevBounds.y0,
        } : null,
    };
}
