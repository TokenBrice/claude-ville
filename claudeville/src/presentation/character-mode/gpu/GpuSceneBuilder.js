import { materialClassId } from './GpuWorldPolicy.js';
import { tileToWorld, TILE_HALF_HEIGHT, TILE_HALF_WIDTH } from '../Projection.js';
import { landmarkFootprint } from '../FootprintField.js';
import { ownerSlotFor } from '../LightSourceRegistry.js';
import {
    atlasSourceRect,
    shouldUseAtlasForCategory,
} from '../AssetManager.js';
import { getBuildingVisual } from '../BuildingVisualRegistry.js';
import { paintCoastWaterMaterial } from '../CoastBake.js';
import { GROUND_CLASS, paintGroundMaterial } from '../GroundBake.js';
import { castLightingFor, structureCast, treeCast, TREE_CAST_ALPHA } from '../RakingLight.js';
import { cacheEmitterRecords } from '../EmitterCuts.js';
import { WALK_FRAMES } from '../SpriteSheet.js';

const PILOT_PROP_IDS = Object.freeze(['prop.lantern', 'prop.runeBrazier', 'prop.bridgeLanternPost']);
const TERRAIN_TILE_SOURCES = Object.freeze([
    Object.freeze({ tiles: 'deepWaterTiles', id: 'terrain.shallow-deep' }),
    Object.freeze({ tiles: 'waterTiles', id: 'terrain.shore-shallow' }),
    Object.freeze({ tiles: 'shoreTiles', id: 'terrain.grass-shore' }),
    Object.freeze({ tiles: 'townSquareTiles', id: 'terrain.cobble-square' }),
    Object.freeze({ tiles: 'mainAvenueTiles', id: 'terrain.grass-cobble' }),
    Object.freeze({ tiles: 'pathTiles', id: 'terrain.grass-dirt' }),
    Object.freeze({ tiles: 'dirtPathTiles', id: 'terrain.grass-dirt' }),
    Object.freeze({ tiles: 'bridgeTiles', id: null, materialClass: 'timber' }),
]);

const MATERIAL_BY_BUILDING = Object.freeze({
    command: 'stone',
    taskboard: 'timber',
    archive: 'stone',
    mine: 'stone',
    forge: 'stone',
    harbor: 'timber',
    watchtower: 'stone',
    observatory: 'stone',
    portal: 'rune',
});

// V9 `landmarkId` (instance loc5.y, uint16): 0 = not a landmark. A stable id
// per landmark type, never reordered; 2.2's RG8 footprint field writes the
// same id into G so a receiver can skip its own footprint.
export const GPU_LANDMARK_IDS = Object.freeze({
    command: 1,
    taskboard: 2,
    archive: 3,
    mine: 4,
    forge: 5,
    harbor: 6,
    watchtower: 7,
    observatory: 8,
    portal: 9,
});

// Provider identity is layered over authored sprite channels. These profiles
// are only deterministic defaults for agent records that do not name a
// material; authored record/atlas values remain authoritative. Unknown
// providers use the material contract's safe albedo-only fallback.
export const DEFAULT_PROVIDER_MATERIAL_CLASS = 'unlit';
export const PROVIDER_MATERIAL_PROFILES = Object.freeze({
    claude: Object.freeze({ defaultMaterialClass: 'fabric' }),
    codex: Object.freeze({ defaultMaterialClass: 'metal' }),
    gemini: Object.freeze({ defaultMaterialClass: 'glass-rune' }),
    git: Object.freeze({ defaultMaterialClass: 'unlit' }),
    grok: Object.freeze({ defaultMaterialClass: 'fabric' }),
    kimi: Object.freeze({ defaultMaterialClass: 'fabric' }),
    omp: Object.freeze({ defaultMaterialClass: 'fabric' }),
    opencode: Object.freeze({ defaultMaterialClass: 'fabric' }),
    deepseek: Object.freeze({ defaultMaterialClass: 'earth' }),
    zai: Object.freeze({ defaultMaterialClass: 'fabric' }),
});

export function gpuMaterialNameForProvider(provider) {
    const key = String(provider || '').trim().toLowerCase();
    return PROVIDER_MATERIAL_PROFILES[key]?.defaultMaterialClass
        || DEFAULT_PROVIDER_MATERIAL_CLASS;
}

function finite(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

function materialForProp(sprite = {}) {
    const id = String(sprite.id || '').toLowerCase();
    if (/tree|bush|flower|reed|lilypad|hedge|root|mangrove/.test(id)) return 'foliage';
    if (/ship|boat|crate|cart|stall|rack|gate|wall|bridge|dock|sign|board/.test(id)) return 'timber';
    // The harbor beacon buoy is a brass cage over an unlit float: it casts no
    // light and has no lit pixels, so it is metal, never a whole-sprite glow.
    if (/lantern|brazier|beacon|fire/.test(id)) return /buoy/.test(id) ? 'metal' : 'fire';
    if (/ore|metal|crane/.test(id)) return 'metal';
    if (/stone|boulder|monument|well|fountain|shrine|rune/.test(id)) return 'stone';
    return 'earth';
}

function sidecarFor(assets, id, kind = 'material') {
    if (!assets || !id) return null;
    return assets.getSidecar?.(id, kind)
        || assets.getMaterialSidecar?.(id, kind)
        || assets.get?.(`${id}.${kind}`)
        || null;
}

// B.2 / V9 — the packed geometry map (flag 32 `packedGeometry`) from straight
// RGBA material and occluder pixels: R material id (255 = no material), G
// occluder height, B occlusion strength (0 = no geometry; an authored 0
// packs as 1), A presence. It replaces the occluder companion, so it never
// carries 2.3 surface codes; emissive stays its own RGBA channel.
export function packGeometryPixels(material = null, occluder = null, pixelCount = null) {
    const requestedPixels = Number(pixelCount);
    const pixels = Number.isFinite(requestedPixels)
        ? Math.max(0, Math.floor(requestedPixels))
        : Math.ceil(Math.max(Number(material?.length) || 0, Number(occluder?.length) || 0) / 4);
    const packed = new Uint8ClampedArray(pixels * 4);
    for (let index = 0; index < packed.length; index += 4) {
        const materialPresent = (material?.[index + 3] || 0) > 0;
        const geometryPresent = (occluder?.[index + 3] || 0) > 0;
        if (!materialPresent && !geometryPresent) continue;
        packed[index] = materialPresent ? material[index] : 255;
        packed[index + 1] = geometryPresent ? occluder[index] : 0;
        packed[index + 2] = geometryPresent ? Math.max(1, occluder[index + 1]) : 0;
        packed[index + 3] = 255;
    }
    return packed;
}

function packedLandmarkChannels(renderer, id, { crop = false } = {}) {
    const assets = renderer?.assets;
    const resolved = assets?.resolveMaterialChannels?.(id, null, {
        crop,
        kind: 'landmark',
        onScreen: true,
    });
    if (resolved?.ready && resolved.origin !== 'fallback') {
        if (crop && resolved.layout === 'atlas-rect') return null;
        return {
            material: resolved.material,
            occluder: resolved.occluder,
            emissive: resolved.emissive,
            revision: resolved.revision,
            origin: resolved.origin,
            layout: resolved.layout,
            frame: resolved.frame,
        };
    }
    const material = sidecarFor(assets, id, 'material');
    const emissive = sidecarFor(assets, id, 'emissive');
    if (!material && !emissive) return null;
    return {
        material,
        emissive,
        occluder: sidecarFor(assets, id, 'occluder'),
        revision: `${assets?.assetVersion || ''}:${id}:sidecars`,
        origin: 'sidecar',
        layout: 'sidecar',
    };
}

// The material/emissive sidecar cache key is scoped to the atlas page, because
// one whole-page channel image is shared by every frame packed into that page.
// Its revision must be scoped identically: a per-record revision makes
// GpuWorldRenderer._textureFor see a mismatch on every batch that binds the
// page, which re-uploads the full 2048x2048 channel image several times per
// frame (~96 MB/frame measured, uploadMs ~50) and pins the GPU quality ladder
// at "disabled:uploadMs".
function atlasChannelRevision(assets, atlasId) {
    return `${assets?.assetVersion || ''}::${atlasId}::channels`;
}

export function terrainSourceHasAuthoredChannels(assets, source) {
    if (!source?.id || !assets) return false;
    if (typeof assets.resolveMaterialChannels === 'function') {
        const resolved = assets.resolveMaterialChannels(source.id);
        return resolved?.origin === 'sidecar' || resolved?.origin === 'atlas';
    }
    return Boolean(
        sidecarFor(assets, source.id, 'material')
        || sidecarFor(assets, source.id, 'emissive')
        || assets.getAtlasFrame?.(source.id),
    );
}

function paintTerrainClassMap(ctx, renderer, cached, scale, sources) {
    const colorFor = (name) => `rgba(${materialClassId(name)},0,0,1)`;
    ctx.fillStyle = colorFor('earth');
    ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    // Each tile diamond is filled as whole-pixel row spans, never an
    // anti-aliased path: an AA edge blends two class ids into a third one
    // (earth 6 over water 8 left cobble 7 along every water tile's rim,
    // which the coast pass keeps as paving, so the map-diamond edge lit a
    // dotted row of land-lit water, 3.3).
    const drawTiles = (tiles, material) => {
        ctx.fillStyle = colorFor(material);
        for (const key of tiles || []) {
            const [tileX, tileY] = String(key).split(',').map(Number);
            if (!Number.isFinite(tileX) || !Number.isFinite(tileY)) continue;
            const point = tileToWorld(tileX, tileY);
            const cx = (point.x - cached.bounds.x) * scale;
            const cy = (point.y - cached.bounds.y) * scale;
            const halfW = Math.max(1, TILE_HALF_WIDTH * scale + 0.5);
            const halfH = Math.max(1, TILE_HALF_HEIGHT * scale + 0.5);
            const x = Math.round(cx);
            const midY = Math.round(cy);
            const top = Math.round(cy - halfH);
            const bottom = Math.round(cy + halfH);
            const spanW = Math.round(cx + halfW) - x;
            const reachUp = Math.max(1, midY - top);
            const reachDown = Math.max(1, bottom - midY);
            for (let y = top; y < bottom; y++) {
                const centre = y + 0.5 - midY;
                const span = Math.round(spanW * (1 - Math.abs(centre) / (centre < 0 ? reachUp : reachDown)));
                if (span > 0) ctx.fillRect(x - span, y, span * 2, 1);
            }
        }
    };
    for (const source of sources) {
        const tiles = renderer[source.tiles];
        if (!tiles) continue;
        const materialName = source.materialClass
            || renderer.assets?.getMaterialMetadata?.(source.id)?.materialClass
            || 'earth';
        drawTiles(tiles, materialName);
    }
}

// 3.2 — land classes follow the ground bake's organic edges (paving →
// cobble, earth and grass → earth, sand keeps the shore sheet's class).
function paintGroundClass(ctx, renderer, cached, scale, sandMaterial) {
    const earth = materialClassId('earth');
    const cobble = materialClassId('cobble');
    const sand = materialClassId(sandMaterial);
    const idForClass = {
        [GROUND_CLASS.GRASS]: earth,
        [GROUND_CLASS.DIRT]: earth,
        [GROUND_CLASS.ROAD]: cobble,
        [GROUND_CLASS.PLAZA]: cobble,
        [GROUND_CLASS.SAND]: sand,
    };
    paintGroundMaterial(ctx, renderer, cached, scale, idForClass);
}

// 3.4 — the water class follows the coast field, not the tile diamonds, so
// GPU shimmer, night mood and reflections stop at the organic shoreline.
function paintCoastWaterClass(ctx, renderer, cached, scale) {
    const water = materialClassId('water');
    const earth = materialClassId('earth');
    paintCoastWaterMaterial(ctx, renderer, cached, scale, water, earth, [earth, materialClassId('foliage')]);
}

function composeProceduralTerrainMaterial(renderer, cached) {
    const scale = 0.25;
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.ceil(cached.canvas.width * scale));
    canvas.height = Math.max(1, Math.ceil(cached.canvas.height * scale));
    const ctx = canvas.getContext('2d', { alpha: true });
    ctx.imageSmoothingEnabled = false;
    paintTerrainClassMap(ctx, renderer, cached, scale, [
        { tiles: 'pathTiles', materialClass: 'cobble' },
        { tiles: 'dirtPathTiles', materialClass: 'earth' },
        { tiles: 'waterTiles', materialClass: 'water' },
        { tiles: 'bridgeTiles', materialClass: 'timber' },
    ]);
    paintGroundClass(ctx, renderer, cached, scale, 'earth');
    paintCoastWaterClass(ctx, renderer, cached, scale);
    return canvas;
}

function composeAuthoredTerrainMaterial(renderer, cached) {
    const scale = 0.25;
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.ceil(cached.canvas.width * scale));
    canvas.height = Math.max(1, Math.ceil(cached.canvas.height * scale));
    const ctx = canvas.getContext('2d', { alpha: true });
    ctx.imageSmoothingEnabled = false;
    paintTerrainClassMap(ctx, renderer, cached, scale, TERRAIN_TILE_SOURCES);
    paintGroundClass(ctx, renderer, cached, scale,
        renderer.assets?.getMaterialMetadata?.('terrain.grass-shore')?.materialClass || 'earth');
    paintCoastWaterClass(ctx, renderer, cached, scale);
    return canvas;
}

function terrainMaterialSidecar(renderer, cached) {
    if (!cached?.canvas || !cached?.bounds || typeof document === 'undefined') return null;
    const authored = TERRAIN_TILE_SOURCES.some((source) => (
        terrainSourceHasAuthoredChannels(renderer?.assets, source)
    ));
    const cacheToken = renderer.terrainCacheKey || '';
    const authoredRevision = `${cacheToken}:terrain-material:authored`;
    const proceduralRevision = `${cacheToken}:terrain-material:procedural`;
    if (authored && renderer._gpuTerrainAuthoredMaterial?.revision === authoredRevision) {
        renderer._gpuTerrainMaterialOrigin = 'authored';
        return renderer._gpuTerrainAuthoredMaterial.canvas;
    }
    if (authored && renderer.assets?.enqueueDerivedArt) {
        const generation = renderer.assets.derivedArtGeneration;
        renderer.assets.enqueueDerivedArt({
            key: authoredRevision,
            kind: 'landmark',
            onScreen: true,
            build: () => {
                if (generation !== renderer.assets?.derivedArtGeneration) return;
                if (typeof document === 'undefined') return;
                const canvas = composeAuthoredTerrainMaterial(renderer, cached);
                if (generation !== renderer.assets?.derivedArtGeneration) {
                    canvas.width = 0;
                    canvas.height = 0;
                    return;
                }
                renderer._gpuTerrainAuthoredMaterial = { canvas, revision: authoredRevision };
            },
        });
    }
    if (renderer._gpuTerrainMaterialSidecar?.revision === proceduralRevision) {
        renderer._gpuTerrainMaterialOrigin = authored ? 'authored-pending' : 'procedural';
        return renderer._gpuTerrainMaterialSidecar.canvas;
    }
    const canvas = composeProceduralTerrainMaterial(renderer, cached);
    renderer._gpuTerrainMaterialSidecar = { canvas, revision: proceduralRevision };
    renderer._gpuTerrainMaterialOrigin = authored ? 'authored-pending' : 'procedural';
    return canvas;
}

// B.2 — the resident path holds the terrain bake only as a texture: once the
// GPU reports this bake's upload, the CPU canvas is released and a same-size
// GPU-resident stand-in keys the record; if that texture is gone (context
// loss, eviction) the stand-in is dropped and the canvas re-bakes here.
function recordForTerrain(renderer) {
    let cached = renderer?._getTerrainCache?.({ allowResident: true });
    if (!cached?.canvas || !cached?.bounds) return null;
    const textureKey = `terrain:${renderer.terrainCacheKey || 'static'}`;
    const revision = renderer.terrainCacheKey || null;
    const uploaded = renderer.gpuWorld?.hasResidentTexture?.(textureKey, revision) === true;
    if (cached.resident && !uploaded) {
        renderer.dropTerrainResident?.();
        cached = renderer._getTerrainCache();
        if (!cached?.canvas) return null;
    } else if (!cached.resident && uploaded && renderer.releaseTerrainCanvas) {
        renderer.releaseTerrainCanvas();
        cached = renderer._getTerrainCache({ allowResident: true });
        if (!cached?.canvas) return null;
    }
    const { canvas, bounds } = cached;
    const materialSource = terrainMaterialSidecar(renderer, cached);
    return {
        id: 'terrain:static',
        stableKey: 'terrain:static',
        textureKey,
        source: canvas,
        materialSource,
        sidecarKey: 'terrain:material',
        sourceWidth: canvas.width,
        sourceHeight: canvas.height,
        sx: 0,
        sy: 0,
        sw: canvas.width,
        sh: canvas.height,
        x: bounds.x,
        y: bounds.y,
        width: bounds.w,
        height: bounds.h,
        material: materialClassId('earth'),
        elevation: 0,
        emissive: 0,
        occluder: 0,
        textureRevision: revision,
        sidecarRevision: renderer._gpuTerrainAuthoredMaterial?.revision
            || renderer._gpuTerrainMaterialSidecar?.revision
            || null,
        sequence: -1,
        sourceKind: 'individual',
    };
}

// 0.10 — the ground haze: the same world-locked stepped field the Canvas
// path draws (WorldFrameRenderer `ensureHazeField`), one record over its own
// world rect, laid source-over at the stepped strength. The texture uploads
// once per field bake (`textureRevision` is the bake key), never per pan.
function recordForHaze(renderer) {
    const field = renderer?._hazeField;
    const strength = finite(renderer?._gpuHazeStrength, 0);
    if (!field?.canvas || !(field.w > 0) || !(field.h > 0) || strength <= 0) return null;
    return {
        id: 'ground:haze',
        stableKey: 'ground:haze',
        textureKey: 'ground-haze-field',
        source: field.canvas,
        sourceWidth: field.canvas.width,
        sourceHeight: field.canvas.height,
        sx: 0,
        sy: 0,
        sw: field.canvas.width,
        sh: field.canvas.height,
        x: field.x,
        y: field.y,
        width: field.w,
        height: field.h,
        alpha: Math.min(1, strength),
        material: materialClassId('default'),
        elevation: 0,
        emissive: 0,
        occluder: 0,
        textureRevision: field.key || null,
        sequence: -0.9,
        sourceKind: 'individual',
    };
}

// 1.5 — building ground casts: one stepped stamp per building, baked by
// RakingLight per sun bucket (longer and violet at golden hour and sunrise)
// and shared with the Canvas fallback. `textureRevision` is the bucket key,
// so the texture uploads only when the sun moves a bucket.
function buildingShadowRecords(renderer, drawable, sequence) {
    if (drawable?.kind === 'building-front') return [];
    const building = drawable?.building;
    const grounding = getBuildingVisual(building?.type)?.grounding;
    const contact = grounding?.contact;
    if (grounding?.shadow === 'none' || !(contact?.width > 0) || !(contact?.depth > 0)) return [];
    const cast = castLightingFor(renderer?._lastAtmosphere);
    const buildingId = String(building?.type || drawable?.entry?.id || sequence).replace(/^building\./, '');
    const baked = structureCast(buildingId, grounding, contact, cast);
    if (!baked) return [];
    const source = baked.canvas;
    return [{
        id: `ground:building:${buildingId}`,
        stableKey: `ground:building:${buildingId}`,
        textureKey: `building-ground-shadow:${buildingId}`,
        source,
        sourceWidth: source.width,
        sourceHeight: source.height,
        sx: 0,
        sy: 0,
        sw: source.width,
        sh: source.height,
        x: Math.round(finite(drawable.wx) + finite(contact.offsetX) + baked.offsetX),
        y: Math.round(finite(drawable.wy) + finite(contact.offsetY) + baked.offsetY),
        width: source.width,
        height: source.height,
        alpha: cast.alpha * finite(contact.opacity, 0.75),
        material: materialClassId('default'),
        elevation: 0,
        occluder: 0,
        emissive: 0,
        sequence: sequence - 0.5,
        // 2.9 — held faint and broken by the ripple rows over painted water.
        groundCast: true,
        textureRevision: baked.key,
        sourceKind: 'individual',
    }];
}

// 1.5 — a tree's ground cast from its trunk base (RakingLight `treeCast`),
// emitted with the tree's back (or whole) record. Trees of one sprite size
// share a texture keyed by that size (not the canvas size: two tree sizes
// can rasterize to the same canvas and would ping-pong one texture every
// frame); it re-uploads only when the sun moves a bucket.

function treeCastRecords(renderer, sprite, part, sequence) {
    if (sprite?.id !== 'fantasy.tree' || part === 'front') return [];
    const bounds = sprite.bounds || {};
    const width = finite(bounds.right) - finite(bounds.left);
    const height = -finite(bounds.top);
    const cast = castLightingFor(renderer?._lastAtmosphere);
    const baked = treeCast(width, height, cast);
    if (!baked) return [];
    const source = baked.canvas;
    return [{
        id: `ground:tree:${sprite.tileX},${sprite.tileY}`,
        stableKey: `ground:tree:${sprite.tileX},${sprite.tileY}`,
        textureKey: `tree-ground-cast:${baked.sizeKey}`,
        source,
        sourceWidth: source.width,
        sourceHeight: source.height,
        sx: 0,
        sy: 0,
        sw: source.width,
        sh: source.height,
        x: Math.round(sprite.x) + baked.offsetX,
        y: Math.round(sprite.y) + baked.offsetY,
        width: source.width,
        height: source.height,
        alpha: cast.alpha * TREE_CAST_ALPHA,
        material: materialClassId('default'),
        elevation: 0,
        occluder: 0,
        emissive: 0,
        sequence: sequence - 0.5,
        groundCast: true,
        textureRevision: baked.key,
        sourceKind: 'individual',
    }];
}

function recordForBuilding(renderer, drawable, sequence) {
    const assets = renderer?.assets;
    const id = drawable?.entry?.id;
    if (!id) return null;
    const individual = assets?.get?.(id);
    const dims = assets?.getDims?.(id) || (individual ? { w: individual.width, h: individual.height } : null);
    if (!dims) return null;
    const [ax, ay] = assets.getAnchor(id) || [dims.w / 2, dims.h];
    const split = drawable.kind === 'building-back' || drawable.kind === 'building-front';
    const horizon = split
        ? Math.max(1, Math.min(finite(drawable.horizonY, dims.h / 2), dims.h - 1))
        : null;
    const front = drawable.kind === 'building-front';
    const atlasFrame = assets.getAtlasFrame?.(id);
    const atlasAlbedo = atlasFrame?.atlas ? assets.getAtlas?.(atlasFrame.atlas, 'albedo') : null;
    const useAtlas = Boolean(renderer._gpuAtlasDecision?.building && atlasAlbedo && atlasFrame?.rect);
    let source;
    let sourceWidth;
    let sourceHeight;
    let sx;
    let sy;
    let sw;
    let sh;
    let textureKey;
    if (useAtlas) {
        source = atlasAlbedo;
        sourceWidth = atlasAlbedo.width;
        sourceHeight = atlasAlbedo.height;
        const rect = atlasSourceRect(atlasFrame.rect, { split, front, horizonY: horizon });
        sx = rect.sx;
        sy = rect.sy;
        sw = rect.sw;
        sh = rect.sh;
        textureKey = atlasFrame.atlas;
    } else {
        source = individual;
        if (!source) return null;
        sourceWidth = dims.w;
        sourceHeight = dims.h;
        sx = 0;
        sy = split && front ? horizon : 0;
        sw = dims.w;
        sh = split ? (front ? dims.h - horizon : horizon) : dims.h;
        textureKey = id;
    }
    const buildingType = drawable.building?.type || id.replace(/^building\./, '');
    const materialMeta = drawable.entry?.material || drawable.entry?.gpuMaterial || {};
    const materialName = materialMeta.class || drawable.entry?.materialClass || MATERIAL_BY_BUILDING[buildingType] || 'stone';
    const footprint = drawable.building ? landmarkFootprint(drawable.building) : null;
    // V8 — landmark emission follows the work tier (isWorkingVisitor counts +
    // observed-tool recency), never idle, seated or passing bodies.
    const workTier = renderer?.buildingRenderer?._workTierFor?.(drawable.building);
    const active = Boolean(workTier) && workTier !== 'dormant';
    const emissiveGate = renderer?.buildingRenderer?._emissiveGateFor?.(drawable.building) ?? 1;
    // Material/emissive are sampled with the albedo's UVs (see the GL fragment
    // shaders), so a channel source must share the albedo's geometry. When the
    // albedo comes from an atlas page the channels must be that page's channel
    // pages; a per-landmark sidecar keyed under the shared `<atlas>:channels`
    // key sampled the wrong pixels and made every batch rebind the key with a
    // different source, re-uploading the full 2048x2048 page several times per
    // frame.
    const resolved = useAtlas ? null : packedLandmarkChannels(renderer, id, { crop: true });
    const materialSource = (useAtlas
        ? assets.getAtlas?.(atlasFrame.atlas, 'material')
        : resolved?.material) || null;
    const emissiveSource = (useAtlas
        ? assets.getAtlas?.(atlasFrame.atlas, 'emissive')
        : resolved?.emissive) || null;
    const sidecarKey = useAtlas
        ? `${atlasFrame.atlas}:channels`
        : `${id}:material`;
    const record = {
        id: `${id}:${drawable.kind}`,
        stableKey: `${id}:${drawable.kind}`,
        textureKey,
        sidecarKey,
        source,
        materialSource,
        emissiveSource,
        occluderSource: useAtlas ? assets.getAtlas?.(atlasFrame.atlas, 'occluder') : resolved?.occluder,
        sourceWidth,
        sourceHeight,
        sx,
        sy,
        sw,
        sh,
        x: Math.round(drawable.wx - ax),
        y: Math.round(drawable.wy - ay + (split && front ? horizon : 0)),
        width: useAtlas ? sw : dims.w,
        height: sh,
        material: materialClassId(materialName),
        elevation: finite(materialMeta.elevation, 0.82),
        // Never bloom an entire albedo sprite. Without an authored packed
        // material map, local semantic lights still illuminate the landmark;
        // emissive bloom begins only when the companion identifies its pixels.
        emissive: materialSource
            ? (active ? finite(materialMeta.activeEmissive, 0.12) : finite(materialMeta.emissive, 0.03))
            : 0,
        emissiveGate,
        // 3.5 pilot opt-in: only Command's authored material pixels quantize
        // admitted local light to the palette ramp. Every other landmark keeps
        // today's additive response, so the ramp cannot leak through a shared
        // atlas batch.
        paletteRamp: buildingType === 'command',
        occluder: finite(materialMeta.occluder, 0.86),
        // V5 / V9 — the landmark's analytic receiver geometry (2.1): its
        // footprint's front corner; a pixel above the front edges is a wall
        // facing its side's face, one in front of them an apron lit as ground.
        // `surfaceCode` (2.3) says the occluder companion carries true height
        // in R and the authored face/height code in B, which override it.
        footY: footprint ? Math.round(footprint.front.y) : undefined,
        frontCornerX: footprint ? Math.round(footprint.front.x) : undefined,
        frontCornerY: footprint ? Math.round(footprint.front.y) : undefined,
        surfaceCode: (drawable.entry || assets.getEntry?.(id))?.surfaceCode === true,
        landmarkId: GPU_LANDMARK_IDS[buildingType] || 0,
        textureRevision: assets.assetVersion || null,
        sidecarRevision: useAtlas && atlasFrame?.atlas
            ? atlasChannelRevision(assets, atlasFrame.atlas)
            : (resolved?.revision || `${assets.assetVersion || ''}:${id}`),
        sequence,
        sourceKind: useAtlas ? 'atlas' : 'individual',
    };
    const shadows = buildingShadowRecords(renderer, drawable, sequence);
    const glass = glassPatchRecord(renderer, drawable, record, split ? horizon : null, front);
    const roof = roofWeatherRecords(renderer, drawable, record, split ? horizon : null, front, sequence);
    const parts = buildingPartRecords(renderer, drawable, record, sequence);
    if (!shadows.length && !glass && !roof.length && !parts.length) return record;
    const out = glass ? [...shadows, record, glass] : [...shadows, record];
    for (let index = 0; index < roof.length; index++) out.push(roof[index]);
    for (let index = 0; index < parts.length; index++) out.push(parts[index]);
    return out;
}

// 6.1 / 6.2 — one small record per drawn manifest layer (static overlay such
// as the Pharos lamp or the Portal's rune brazier, active frame-strip part,
// door or cycled emitter), right after its building record (and its glass
// patch): the same painter depth and split half (stampPainterDepth gives
// every record of the drawable its sortY), the frame
// BuildingSprite.partDrawsFor picks for the Canvas blit, and channel strips
// cropped from the base's own sidecars so the part shades exactly like the
// texels it replaces (an overlay emits its own authored albedo instead). A
// gated-off restIsBase part emits nothing. A `fixture` layer (the Pharos
// lamp and lens, M22) emits through no occupancy gate.
const NO_PART_RECORDS = Object.freeze([]);

function buildingPartRecords(renderer, drawable, base, sequence) {
    const buildings = renderer?.buildingRenderer;
    if (!buildings?.partDrawsFor || !drawable?.entry?.layers) return NO_PART_RECORDS;
    const split = drawable.kind === 'building-back'
        ? 'back'
        : drawable.kind === 'building-front' ? 'front' : 'whole';
    const scratch = renderer._gpuPartDrawScratch || (renderer._gpuPartDrawScratch = []);
    const draws = buildings.partDrawsFor(drawable.entry, drawable.building, drawable.wx, drawable.wy,
        split, drawable.horizonY ?? null, scratch);
    if (!draws.length) return NO_PART_RECORDS;
    const out = [];
    for (let index = 0; index < draws.length; index++) {
        const d = draws[index];
        const channels = buildings.partChannelsFor?.(drawable.entry, d) || null;
        const id = `${base.id}:part:${d.name}`;
        out.push({
            id,
            stableKey: id,
            textureKey: d.textureKey,
            sidecarKey: `${d.textureKey}:channels`,
            source: d.image,
            materialSource: channels?.material || null,
            emissiveSource: channels?.emissive || null,
            occluderSource: channels?.occluder || null,
            sourceWidth: d.image.width,
            sourceHeight: d.image.height,
            sx: d.sx,
            sy: d.sy,
            sw: d.sw,
            sh: d.sh,
            x: d.x,
            y: d.y,
            width: d.sw,
            height: d.sh,
            material: d.materialClass ? materialClassId(d.materialClass) : base.material,
            elevation: base.elevation,
            emissive: channels?.material ? base.emissive : 0,
            emissiveGate: d.fixture ? 1 : base.emissiveGate,
            paletteRamp: base.paletteRamp,
            occluder: base.occluder,
            landmarkId: base.landmarkId,
            textureRevision: d.textureKey,
            sidecarRevision: channels?.key || d.textureKey,
            sequence: sequence + (index + 2) / 1000,
            sourceKind: 'individual',
        });
    }
    return out;
}

// 6.3 — the landmark's unlit panes (BuildingSprite.glassPatchFor, RoomGlass):
// each dark room's own unlit albedo drawn on the same texels right after the
// landmark, with no emissive channel, so an unoccupied room — and every pane
// by day (M15) — shows unlit slate glass instead of the lit sidecar.
function glassPatchRecord(renderer, drawable, record, horizon, front) {
    const patch = renderer?.buildingRenderer?.glassPatchFor?.(drawable.building);
    if (!patch) return null;
    let sy = 0;
    let sh = patch.h;
    if (horizon != null) {
        const cut = Math.max(0, Math.min(patch.h, horizon - patch.top));
        if (front) sy = cut;
        sh = front ? patch.h - cut : cut;
        if (sh <= 0) return null;
    }
    const spriteTop = record.y - (horizon != null && front ? horizon : 0);
    const id = drawable.entry.id;
    const version = renderer.assets?.assetVersion || '';
    return {
        ...record,
        id: `${record.id}:glass`,
        stableKey: `${record.stableKey}:glass`,
        textureKey: `${id}:glass`,
        sidecarKey: `${id}:glass`,
        source: patch.canvas,
        materialSource: patch.channels?.material || null,
        emissiveSource: null,
        occluderSource: patch.channels?.occluder || null,
        sourceWidth: patch.w,
        sourceHeight: patch.h,
        sx: 0,
        sy,
        sw: patch.w,
        sh,
        x: record.x + patch.left,
        y: spriteTop + patch.top + sy,
        width: patch.w,
        height: sh,
        emissive: 0,
        textureRevision: `${version}:${patch.revision}`,
        sidecarRevision: `${version}:glass`,
        sourceKind: 'individual',
    };
}

// 5.2 roofs / 6.6 — the roof weather (BuildingSprite.roofPatchFor /
// roofDripFor, RoofWeather): the snow / wet-course patch on the landmark's
// own roof texels, with the roof's own material and surface-code crops so it
// shades exactly like the slate under it (roofs stay unlit by lamps, 2.3),
// then the eave-drip strip frame while it rains. Both after the glass patch
// and before the parts, so doors, banners and pennants stay on top. Clear,
// dry weather emits nothing.
const NO_ROOF_RECORDS = Object.freeze([]);

function roofWeatherRecords(renderer, drawable, record, horizon, front, sequence) {
    const buildings = renderer?.buildingRenderer;
    if (!buildings?.roofPatchFor) return NO_ROOF_RECORDS;
    const patch = buildings.roofPatchFor(drawable.building);
    const drip = buildings.roofDripFor?.(drawable.building) || null;
    if (!patch && !drip) return NO_ROOF_RECORDS;
    const out = [];
    const spriteTop = record.y - (horizon != null && front ? horizon : 0);
    const id = drawable.entry.id;
    const version = renderer.assets?.assetVersion || '';
    const layer = (source, suffix, channels, revision, order) => {
        let sy = 0;
        let sh = source.h;
        if (horizon != null) {
            const cut = Math.max(0, Math.min(source.h, horizon - source.top));
            if (front) sy = cut;
            sh = front ? source.h - cut : cut;
            if (sh <= 0) return;
        }
        out.push({
            ...record,
            id: `${record.id}:${suffix}`,
            stableKey: `${record.stableKey}:${suffix}`,
            textureKey: `${id}:${suffix}`,
            sidecarKey: `${id}:${suffix}`,
            source: source.canvas,
            materialSource: channels?.material || null,
            emissiveSource: null,
            occluderSource: channels?.occluder || null,
            sourceWidth: source.canvas.width,
            sourceHeight: source.canvas.height,
            sx: source.sx || 0,
            sy,
            sw: source.w,
            sh,
            x: record.x + source.left,
            y: spriteTop + source.top + sy,
            width: source.w,
            height: sh,
            emissive: 0,
            textureRevision: `${version}:${revision}`,
            sidecarRevision: `${version}:${suffix}`,
            sequence: sequence + order / 1000,
            sourceKind: 'individual',
        });
    };
    if (patch) layer(patch, 'roof', patch.channels, patch.revision, 1);
    if (drip) layer(drip, 'roof-drip', null, 'drip', 1.5);
    return out;
}

// A prop's cached image: its own padded cache canvas, or for a tree the shared
// lean frame of the moment (FoliageRenderer), whose `textureKey`
// (`tree:${sprite}|${variant}|${season}|${frame}`) is shared by every tree
// showing that frame, so no texture exists per tree (plan 0.7).
function recordForProp(renderer, drawable, sequence) {
    const sprite = drawable?.payload?.sprite || drawable?.sprite;
    if (!sprite?._getCachedCanvas) return null;
    const cached = sprite._getCachedCanvas(renderer?.camera?.zoom || 1);
    if (!cached?.canvas) return null;
    const part = drawable?.payload?.part || 'whole';
    const cachedW = cached.canvas.width;
    const cachedH = cached.canvas.height;
    let destX = cached.x;
    let destY = cached.y;
    let destW = cachedW;
    let destH = cachedH;
    let splitLocalY = 0;
    const split = Boolean(sprite.splitForOcclusion && (part === 'back' || part === 'front'));
    if (split) {
        const splitWorldY = sprite.y + finite(sprite.bounds?.splitY, -18);
        splitLocalY = Math.max(1, Math.min(cachedH - 1, Math.round(splitWorldY - cached.y)));
        if (part === 'back') destH = splitLocalY;
        else {
            destY += splitLocalY;
            destH = cachedH - splitLocalY;
        }
    }
    // A depth column is a vertical slice of the same cached image.
    const column = part === 'column' ? drawable?.payload?.column : null;
    const columnSpan = column ? sprite.columnSourceSpan(column, cached) : null;
    if (columnSpan) {
        if (columnSpan.sw <= 0) return null;
        destX += columnSpan.sx;
        destW = columnSpan.sw;
    }
    const assets = renderer?.assets;
    const propId = sprite.id || '';
    const isPilot = PILOT_PROP_IDS.includes(propId);
    const atlasFrame = isPilot ? assets?.getAtlasFrame?.(propId) : null;
    const atlasAlbedo = atlasFrame?.atlas ? assets?.getAtlas?.(atlasFrame.atlas, 'albedo') : null;
    const useAtlas = Boolean(isPilot && renderer._gpuAtlasDecision?.prop && atlasAlbedo && atlasFrame?.rect);
    let source = cached.canvas;
    let sourceWidth = cachedW;
    let sourceHeight = cachedH;
    let sx = 0;
    let sy = 0;
    let sw = cachedW;
    let sh = cachedH;
    let textureKey = cached.textureKey || `prop-cache:${propId || 'procedural'}:${sprite.tileX},${sprite.tileY}`;
    let sourceKind = 'individual';
    if (useAtlas) {
        source = atlasAlbedo;
        sourceWidth = atlasAlbedo.width;
        sourceHeight = atlasAlbedo.height;
        const native = atlasSourceRect(atlasFrame.rect);
        sx = native.sx;
        sy = native.sy;
        sw = native.sw;
        sh = native.sh;
        textureKey = atlasFrame.atlas;
        sourceKind = 'atlas';
        if (split) {
            const splitSrc = Math.max(1, Math.min(native.sh - 1, Math.round(splitLocalY * native.sh / cachedH)));
            if (part === 'back') sh = splitSrc;
            else {
                sy += splitSrc;
                sh = native.sh - splitSrc;
            }
        }
        if (columnSpan) {
            const scale = native.sw / cachedW;
            sx += Math.round(columnSpan.sx * scale);
            sw = Math.max(1, Math.round(columnSpan.sw * scale));
        }
    } else {
        if (split) {
            if (part === 'back') sh = splitLocalY;
            else {
                sy = splitLocalY;
                sh = cachedH - splitLocalY;
            }
        }
        if (columnSpan) {
            sx = columnSpan.sx;
            sw = columnSpan.sw;
        }
    }
    // Same UV-space rule as landmarks: an atlas albedo takes the atlas channel
    // pages, never a per-prop sidecar.
    const resolved = isPilot && !useAtlas
        ? assets?.resolveMaterialChannels?.(propId, null, {
            crop: true,
            kind: 'prop',
            onScreen: true,
        })
        : null;
    const authoredClass = isPilot && (useAtlas || (resolved && resolved.origin !== 'fallback'))
        ? assets.getMaterialMetadata?.(propId)?.materialClass
        : null;
    const materialName = sprite.materialClass || authoredClass || materialForProp(sprite);
    const elevated = Math.max(0, finite(sprite.bounds?.bottom) - finite(sprite.bounds?.top));
    const materialSource = (useAtlas
        ? assets?.getAtlas?.(atlasFrame.atlas, 'material')
        : (isPilot && resolved?.origin !== 'fallback' ? resolved.material : null)) || null;
    const emissiveSource = (useAtlas
        ? assets?.getAtlas?.(atlasFrame.atlas, 'emissive')
        : (isPilot && resolved?.origin !== 'fallback' ? resolved.emissive : null)) || null;
    const record = {
        id: `prop:${propId || `${sprite.tileX},${sprite.tileY}`}:${part}${column ? `:${column.index}` : ''}`,
        stableKey: drawable.stableKey || propId || `${sprite.tileX},${sprite.tileY}`,
        textureKey,
        sidecarKey: materialSource
            ? (useAtlas && atlasFrame?.atlas ? `${atlasFrame.atlas}:channels` : `${propId}:channels`)
            : '',
        source,
        materialSource,
        emissiveSource,
        sourceWidth,
        sourceHeight,
        sx,
        sy,
        sw,
        sh,
        x: destX,
        y: destY,
        width: destW,
        height: destH,
        // V5 — a prop (split halves and columns alike) receives light at its
        // own ground line, not its painter sort.
        footY: Math.round(finite(sprite.y)),
        material: materialClassId(materialName),
        elevation: materialName === 'foliage' ? 0.64 : elevated > 70 ? 0.58 : 0.34,
        emissive: emissiveSource ? 0 : (materialName === 'fire' ? 0.35 : 0),
        occluder: elevated > 36 ? 0.58 : 0.2,
        textureRevision: useAtlas ? (assets.assetVersion || 0) : (sprite._gpuCacheRevision || 0),
        sidecarRevision: useAtlas && atlasFrame?.atlas
            ? atlasChannelRevision(assets, atlasFrame.atlas)
            : (resolved?.revision || null),
        sequence,
        sourceKind,
    };
    const casts = treeCastRecords(renderer, sprite, part, sequence);
    return casts.length ? [...casts, record] : record;
}

function recordsForAgent(drawable, sequence) {
    const sprite = drawable?.payload || drawable;
    if (!sprite) return [];
    const direct = sprite.getGpuWorldRecords?.() || sprite._gpuWorldRecords || sprite._gpuFrameRecord;
    const records = Array.isArray(direct) ? direct : direct ? [direct] : [];
    // V5 / V9 — a body receives light at its own foot (V7's placement value,
    // never a painter sort pinned behind a building) and carries its owner's
    // integer slot, so an attention light lights only its own body (2.5). A
    // body has no front corner (frontCornerY stays -1): its frontCornerX
    // carries its vertical axis, around which the loop wraps a lamp-side fill.
    const footY = Math.round(Number.isFinite(sprite._placeY) ? sprite._placeY : finite(sprite.y));
    const axisX = Math.round(Number.isFinite(sprite._placeX) ? sprite._placeX : finite(sprite.x));
    const ownerSlot = ownerSlotFor(sprite.agent?.id);
    const baseRecords = records.map((record, index) => ({
        ...record,
        id: record.id || `agent:${sprite.agent?.id || sequence}:${index}`,
        stableKey: record.stableKey || sprite.agent?.id || `agent:${sequence}`,
        textureKey: record.textureKey || `agent:${sprite._spriteProfileKey || sprite.agent?.id || sequence}`,
        material: record.material ?? materialClassId(gpuMaterialNameForProvider(sprite.agent?.provider)),
        elevation: record.elevation ?? 0.52,
        occluder: record.occluder ?? 0.58,
        footY: record.footY ?? footY,
        frontCornerX: record.frontCornerX ?? axisX,
        ownerSlot: record.ownerSlot ?? ownerSlot,
        sequence: sequence + index / 100,
    }));
    if (!baseRecords.length) return baseRecords;
    // Plan 2.3 — the sprite owns its ground marks (one baked contact shadow
    // plus a ring only for selection/hover/action-needed), shared pixel for
    // pixel with the Canvas fallback and painted just before the body.
    const ground = sprite.getGpuGroundRecords?.(sequence - 0.01) || [];
    return ground.length ? [...ground, ...baseRecords] : baseRecords;
}

// B.2 — the agent atlases are CPU-backed. Their sources (composed and LOD
// sheets, sidecars, strips) are CPU canvases or images, so a GPU-backed atlas
// made Chrome keep a GPU copy of every source it ever drew (~2.6 MB per
// composed sheet, 1.5 MB per LOD sheet in the GPU process), and its sub-rect
// texture patches read the GPU canvas back. The context is bound here, with
// the attribute, before any other getContext call can pick the backing.
function createAgentAtlasCanvas() {
    const atlas = document.createElement('canvas');
    atlas.getContext?.('2d', { alpha: true, willReadFrequently: true });
    return atlas;
}

function ensureAgentChannelAtlas(renderer, property, width, height, state) {
    let atlas = renderer[property];
    let resized = false;
    if (!atlas && typeof document !== 'undefined') {
        atlas = createAgentAtlasCanvas();
        renderer[property] = atlas;
        resized = true;
    }
    if (!atlas) {
        state.atlas = null;
        state.resized = false;
        return state;
    }
    if (atlas.width !== width || atlas.height !== height) {
        atlas.width = width;
        atlas.height = height;
        resized = true;
    }
    state.atlas = atlas;
    state.resized = resized;
    return state;
}

function drawAgentChannelFrame(ctx, record, channel, x, y) {
    const source = record[channel];
    if (!source) return;
    // B.2 — an equipped body's channel companions keep the unpadded sheet
    // layout: its cell lands at the pad offset inside the padded slot.
    const rect = record.channelRect;
    if (rect) {
        ctx.drawImage(source, rect.sx, rect.sy, rect.sw, rect.sh, x + rect.dx, y + rect.dy, rect.sw, rect.sh);
        return;
    }
    const srcW = source.width || 0;
    const srcH = source.height || 0;
    if (srcW === record.sw && srcH === record.sh) {
        ctx.drawImage(source, 0, 0, srcW, srcH, x, y, record.sw, record.sh);
        return;
    }
    if (srcW >= (record.sx || 0) + record.sw && srcH >= (record.sy || 0) + record.sh) {
        ctx.drawImage(
            source,
            record.sx,
            record.sy,
            record.sw,
            record.sh,
            x,
            y,
            record.sw,
            record.sh,
        );
        return;
    }
    const ox = Math.max(0, Math.floor((record.sw - srcW) / 2));
    const oy = Math.max(0, Math.floor((record.sh - srcH) / 2));
    ctx.drawImage(source, 0, 0, srcW, srcH, x + ox, y + oy, srcW, srcH);
}

function drawAgentChannelAtlas(atlas, records, slots, columns, cell, channel) {
    if (!atlas) return;
    const ctx = atlas.getContext('2d', { alpha: true });
    if (!ctx) return;
    ctx.imageSmoothingEnabled = false;
    for (const record of records) {
        const slot = slots.get(record.id) || 0;
        const slotX = (slot % columns) * cell;
        const slotY = Math.floor(slot / columns) * cell;
        ctx.clearRect(slotX, slotY, cell, cell);
        drawAgentChannelFrame(ctx, record, channel, slotX, slotY);
    }
}

// B.2 — a redrawn slot uploads straight from its atlas canvas as a sub-rect
// patch (`sx`/`sy`), so no per-agent copy canvas is kept per channel.
function buildAgentAtlasTextureUpdates(atlas, records, slots, columns, cell) {
    const updates = [];
    if (!atlas) return updates;
    for (const record of records) {
        const slot = slots.get(record.id) || 0;
        const x = (slot % columns) * cell;
        const y = Math.floor(slot / columns) * cell;
        updates.push({ x, y, sx: x, sy: y, width: cell, height: cell, source: atlas });
    }
    return updates;
}

// 4.7 — full-rate gait on the resident path. A walking, on-screen, non-LOD
// body (its record carries `walkStrip`, built by AgentGpuOverlayRenderer)
// holds a strip of WALK_FRAMES cells in a band below the slot grid, and each
// frame samples `stripX + frame * cell`. A strip cell is copied and uploaded
// the first time its frame shows, so a strip costs at most one cell upload
// per frame change and none once the stride has cycled; it refills only when
// its key (direction, tool, sheet, channels, pose) moves. Idle, posed and
// crowd-LOD bodies keep their single slot on the 125 ms cadence. The band
// grows in quanta, capped by count and by pixels per atlas (albedo and every
// channel atlas share the geometry), so the agent atlases stay a bounded
// share of the 160 MiB texture cache.
const WALK_STRIP_CAP = 24;
const WALK_STRIP_QUANTUM = 4;
const WALK_STRIP_BUDGET_PX = 2 * 1024 * 1024;

function walkStripEligible(record, cell) {
    const strip = record.walkStrip;
    if (!strip || strip.cells?.length !== WALK_FRAMES) return false;
    if (!Number.isInteger(strip.frame) || strip.frame < 0 || strip.frame >= WALK_FRAMES) return false;
    for (let frame = 0; frame < WALK_FRAMES; frame++) {
        const source = strip.cells[frame];
        if (!source?.source || !(source.sw <= cell) || !(source.sh <= cell)) return false;
    }
    return true;
}

function walkStripCapacity(renderer, eligibleCount, cell, rosterChanged) {
    const limit = Math.min(WALK_STRIP_CAP, Math.floor(WALK_STRIP_BUDGET_PX / (WALK_FRAMES * cell * cell)));
    const sameCell = renderer._gpuAgentStripCell === cell;
    let capacity = rosterChanged || !sameCell ? 0 : renderer._gpuAgentStripCapacity || 0;
    const needed = Math.min(limit, eligibleCount);
    if (needed > capacity) capacity = Math.min(limit, Math.ceil(needed / WALK_STRIP_QUANTUM) * WALK_STRIP_QUANTUM);
    if (capacity !== renderer._gpuAgentStripCapacity || !sameCell || !renderer._gpuAgentStrips) {
        renderer._gpuAgentStrips = Array.from({ length: capacity }, () => ({ owner: null, key: '', filled: 0, used: 0 }));
        renderer._gpuAgentStripOwners = new Map();
    }
    renderer._gpuAgentStripCapacity = capacity;
    renderer._gpuAgentStripCell = cell;
    return capacity;
}

// Holders keep their strip while they walk (a reassigned strip refills);
// newcomers take a never-used or least-recently-used free strip, and an
// action-needed, selected or hovered walker may displace an ambient one.
function assignWalkStrips(renderer, eligible) {
    const assigned = renderer._gpuAgentStripAssigned ||= new Map();
    assigned.clear();
    const strips = renderer._gpuAgentStrips || [];
    if (!strips.length || !eligible.length) return assigned;
    const owners = renderer._gpuAgentStripOwners ||= new Map();
    const tick = renderer._gpuAgentStripTick = (renderer._gpuAgentStripTick || 0) + 1;
    const taken = new Set();
    const wanting = [];
    for (const record of eligible) {
        const index = owners.get(record.id);
        if (index !== undefined && strips[index]?.owner === record.id) {
            assigned.set(record.id, index);
            taken.add(index);
        } else {
            wanting.push(record);
        }
    }
    if (wanting.length) {
        const free = [];
        for (let index = 0; index < strips.length; index++) if (!taken.has(index)) free.push(index);
        free.sort((a, b) => (strips[a].owner ? 1 : 0) - (strips[b].owner ? 1 : 0) || strips[a].used - strips[b].used);
        // Past capacity the walkers nearest the middle of the view win; the
        // rest keep the slot cadence.
        const camera = renderer.camera;
        const midX = (renderer._screenWidth?.() || 0) / 2;
        const midY = (renderer._screenHeight?.() || 0) / 2;
        const centreDistance = (record) => {
            const point = camera?.worldToScreen?.(finite(record.x) + finite(record.width) / 2, finite(record.y) + finite(record.height));
            return point ? Math.hypot(point.x - midX, point.y - midY) : 0;
        };
        if (wanting.length > free.length) {
            for (const record of wanting) record._stripDistance = centreDistance(record);
        }
        wanting.sort((a, b) => (b.urgentPose ? 1 : 0) - (a.urgentPose ? 1 : 0)
            || (a._stripDistance || 0) - (b._stripDistance || 0));
        for (const record of wanting) {
            let index = free.shift();
            if (index === undefined && record.urgentPose) {
                const ambient = eligible.find(other => !other.urgentPose && assigned.has(other.id));
                if (ambient) {
                    index = assigned.get(ambient.id);
                    assigned.delete(ambient.id);
                }
            }
            if (index === undefined) break;
            const strip = strips[index];
            if (strip.owner) owners.delete(strip.owner);
            strip.owner = record.id;
            strip.key = '';
            strip.filled = 0;
            owners.set(record.id, index);
            assigned.set(record.id, index);
        }
    }
    for (const index of assigned.values()) strips[index].used = tick;
    return assigned;
}

function walkStripOrigin(index, layout) {
    return {
        x: (index % layout.stripsPerRow) * WALK_FRAMES * layout.cell,
        y: (layout.slotRows + Math.floor(index / layout.stripsPerRow)) * layout.cell,
    };
}

// One freshly filled strip cell as a sub-rect patch read straight from its
// atlas canvas (GpuWorldRenderer._textureFor honours `sx/sy`).
function walkStripCellUpdate(atlas, x, y, cell) {
    return { x, y, sx: x, sy: y, width: cell, height: cell, source: atlas };
}

function fillWalkStrips(renderer, agentRecords, assigned, layout) {
    const strips = renderer._gpuAgentStrips || [];
    const { cell, atlas, resized, channels } = layout;
    // A new or cleared canvas empties every strip, held or waiting for its
    // walker to return; a holder's slot was not redrawn into it either, so
    // the slot repacks when the body returns to it.
    if (resized || channels.some(channel => channel.state.resized)) {
        for (const strip of strips) strip.filled = 0;
        for (const id of assigned.keys()) renderer._gpuAgentAtlasFrameKeys?.delete(id);
    }
    if (!assigned.size) return;
    const ctx = atlas.getContext('2d', { alpha: true });
    ctx.imageSmoothingEnabled = false;
    let fills = 0;
    let channelFills = 0;
    for (const record of agentRecords) {
        const index = assigned.get(record.id);
        if (index === undefined) continue;
        const strip = strips[index];
        // The walk-strip key moves whenever a probed cell's sheet or channel
        // source moves; a channel atlas that appears arrives as a resize.
        const key = [
            record.textureKey,
            record.textureRevision,
            record.walkStrip.key,
            record.poseKey || '',
        ].join(':');
        if (strip.key !== key) {
            strip.key = key;
            strip.filled = 0;
        }
        const frame = record.walkStrip.frame;
        const bit = 1 << frame;
        if (strip.filled & bit) continue;
        const source = record.walkStrip.cells[frame];
        const origin = walkStripOrigin(index, layout);
        const x = origin.x + frame * cell;
        ctx.clearRect(x, origin.y, cell, cell);
        ctx.drawImage(source.source, source.sx, source.sy, source.sw, source.sh, x, origin.y, source.sw, source.sh);
        if (!resized) {
            renderer._gpuAgentAlbedoTextureUpdates.push(walkStripCellUpdate(atlas, x, origin.y, cell));
        }
        for (const channel of channels) {
            const channelAtlas = channel.state.atlas;
            if (!channelAtlas) continue;
            const channelCtx = channelAtlas.getContext('2d', { alpha: true });
            channelCtx.imageSmoothingEnabled = false;
            channelCtx.clearRect(x, origin.y, cell, cell);
            drawAgentChannelFrame(channelCtx, source, channel.name, x, origin.y);
            if (!channel.state.resized) {
                renderer[channel.updates].push(walkStripCellUpdate(channelAtlas, x, origin.y, cell));
            }
            channelFills++;
        }
        strip.filled |= bit;
        fills++;
    }
    if (fills) renderer._gpuAgentFrameAtlasRevision++;
    if (channelFills) renderer._gpuAgentSidecarRevision = (renderer._gpuAgentSidecarRevision || 0) + 1;
}

// B.2 — agent material and occluder travel as one packed geometry channel
// (V9 flag 32: R material id, G height, B strength, A presence), so the atlas
// keeps two channel canvases (packed geometry, emissive) beside the albedo.
// The occluder channel's frame toggle gates the packed geometry in the shader
// (`u_packedGeometry`), so the channel never needs a skip/restore repack.
export function packGpuAgentFrameAtlas(renderer, records) {
    const agentRecords = records.filter(record => String(record.id || '').startsWith('agent:'));
    if (!agentRecords.length || typeof document === 'undefined') return records;
    let cell = 1;
    let hasMaterialSource = false;
    let hasEmissiveSource = false;
    for (const record of agentRecords) {
        cell = Math.max(cell, Math.ceil(Math.max(record.sw || 1, record.sh || 1)));
        hasMaterialSource ||= Boolean(record.materialSource);
        hasEmissiveSource ||= Boolean(record.emissiveSource);
    }
    const capacity = Math.max(agentRecords.length, renderer?.agentSprites?.size || 0, 1);
    const columns = Math.max(1, Math.ceil(Math.sqrt(capacity)));
    const rows = Math.max(1, Math.ceil(capacity / columns));
    const slots = renderer._gpuAgentAtlasSlots ||= new Map();
    const roster = [...(renderer?.agentSprites?.keys?.() || [])].sort();
    const rosterSignature = roster.join('|');
    let nextSlot = renderer._gpuAgentAtlasNextSlot || 0;
    let newSlot = false;
    const rosterChanged = rosterSignature !== renderer._gpuAgentAtlasRosterSignature;
    if (rosterChanged) {
        slots.clear();
        roster.forEach((id, index) => slots.set(`agent:${id}`, index));
        nextSlot = roster.length;
        renderer._gpuAgentAtlasRosterSignature = rosterSignature;
        renderer._gpuAgentAtlasFrameKeys?.clear?.();
        renderer._gpuAgentAtlasPoses?.clear?.();
        newSlot = true;
    }
    for (const record of agentRecords) {
        if (slots.has(record.id)) continue;
        slots.set(record.id, nextSlot++);
        newSlot = true;
    }
    renderer._gpuAgentAtlasNextSlot = nextSlot;
    // 4.7 — walk strips sit in a band below the slot grid, WALK_FRAMES cells
    // wide; the band exists only while someone walks on screen.
    const stripCandidates = agentRecords.filter(record => walkStripEligible(record, cell));
    const stripCapacity = walkStripCapacity(renderer, stripCandidates.length, cell, rosterChanged);
    const atlasColumns = stripCapacity ? Math.max(columns, WALK_FRAMES) : columns;
    const stripsPerRow = Math.max(1, Math.floor(atlasColumns / WALK_FRAMES));
    const stripRows = stripCapacity ? Math.ceil(stripCapacity / stripsPerRow) : 0;
    const width = atlasColumns * cell;
    const height = (rows + stripRows) * cell;
    const stripped = assignWalkStrips(renderer, stripCandidates);
    const stripLayout = { cell, slotRows: rows, stripsPerRow };
    let atlas = renderer._gpuAgentFrameAtlas;
    let resized = false;
    if (!atlas || atlas.width !== width || atlas.height !== height) {
        atlas = createAgentAtlasCanvas();
        atlas.width = width;
        atlas.height = height;
        renderer._gpuAgentFrameAtlas = atlas;
        renderer._gpuAgentFrameAtlasSignature = '';
        renderer._gpuAgentFrameAtlasRevision = 0;
        renderer._gpuAgentAtlasFrameKeys = new Map();
        resized = true;
    }
    const frameKeys = renderer._gpuAgentAtlasFrameKeys ||= new Map();
    const poses = renderer._gpuAgentAtlasPoses ||= new Map();
    const desiredKeys = renderer._gpuAgentAtlasDesiredKeys ||= [];
    desiredKeys.length = agentRecords.length;
    let changed = resized || newSlot;
    let missingFrame = false;
    const dirtyRecords = [];
    for (let index = 0; index < agentRecords.length; index++) {
        const record = agentRecords[index];
        if (stripped.has(record.id)) {
            // A strip holder skips the slot cadence; its slot is left as is.
            desiredKeys[index] = `strip:${record.id}`;
            continue;
        }
        const key = [
            record.id,
            record.textureKey,
            record.sx,
            record.sy,
            record.sw,
            record.sh,
            record.textureRevision,
            record.channelRevision ?? record.sidecarRevision,
            record.materialSource ? 'material' : '',
            record.emissiveSource ? 'emissive' : '',
            record.poseKey || '',
        ].join(':');
        desiredKeys[index] = key;
        if (frameKeys.get(record.id) !== key) {
            changed = true;
            dirtyRecords.push(record);
        }
        if (!frameKeys.has(record.id)) missingFrame = true;
    }
    const materialAtlasState = renderer._gpuAgentMaterialAtlasState ||= { atlas: null, resized: false };
    const emissiveAtlasState = renderer._gpuAgentEmissiveAtlasState ||= { atlas: null, resized: false };
    if (hasMaterialSource) {
        ensureAgentChannelAtlas(renderer, '_gpuAgentMaterialAtlas', width, height, materialAtlasState);
    } else {
        materialAtlasState.atlas = null;
        materialAtlasState.resized = false;
    }
    if (hasEmissiveSource) {
        ensureAgentChannelAtlas(renderer, '_gpuAgentEmissiveAtlas', width, height, emissiveAtlasState);
    } else {
        emissiveAtlasState.atlas = null;
        emissiveAtlasState.resized = false;
    }
    const channelsChanged = changed
        || materialAtlasState.resized
        || emissiveAtlasState.resized;
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const cadenceElapsed = now - (renderer._gpuAgentAtlasUpdatedAt || 0) >= 125;
    // Direction/tool changes and individually important actors must keep body
    // and attachment poses in the same frame. Ambient animation stays at 8 Hz.
    const immediate = new Set(dirtyRecords.filter(record => record.urgentPose
        || (poses.has(record.id) && poses.get(record.id) !== record.poseKey)));
    if (!resized && !newSlot && !missingFrame && !cadenceElapsed) {
        for (let index = dirtyRecords.length - 1; index >= 0; index--) {
            if (!immediate.has(dirtyRecords[index])) dirtyRecords.splice(index, 1);
        }
    }
    renderer._gpuAgentAlbedoTextureUpdates = [];
    renderer._gpuAgentMaterialTextureUpdates = [];
    renderer._gpuAgentEmissiveTextureUpdates = [];
    if (changed && (resized || newSlot || missingFrame || cadenceElapsed || immediate.size)) {
        const ctx = atlas.getContext('2d', { alpha: true });
        ctx.imageSmoothingEnabled = false;
        for (let index = 0; index < agentRecords.length; index++) {
            const record = agentRecords[index];
            if (stripped.has(record.id)) continue;
            if (!resized && frameKeys.get(record.id) === desiredKeys[index]) continue;
            if (!resized && !newSlot && !missingFrame && !cadenceElapsed && !immediate.has(record)) continue;
            const slot = slots.get(record.id) || 0;
            const slotX = (slot % columns) * cell;
            const slotY = Math.floor(slot / columns) * cell;
            ctx.clearRect(slotX, slotY, cell, cell);
            ctx.drawImage(
                record.source,
                record.sx,
                record.sy,
                record.sw,
                record.sh,
                slotX,
                slotY,
                record.sw,
                record.sh,
            );
            frameKeys.set(record.id, desiredKeys[index]);
            poses.set(record.id, record.poseKey);
        }
        renderer._gpuAgentFrameAtlasSignature = desiredKeys.slice().sort().join('|');
        renderer._gpuAgentFrameAtlasRevision++;
        if (cadenceElapsed || resized || newSlot || missingFrame) renderer._gpuAgentAtlasUpdatedAt = now;
        if (!resized) {
            renderer._gpuAgentAlbedoTextureUpdates = buildAgentAtlasTextureUpdates(atlas, dirtyRecords, slots, columns, cell);
        }
    }
    const packNow = resized
        || newSlot
        || missingFrame
        || cadenceElapsed
        || immediate.size > 0
        || materialAtlasState.resized
        || emissiveAtlasState.resized;
    if (channelsChanged && packNow) {
        const materialRecords = materialAtlasState.resized ? agentRecords : dirtyRecords;
        const emissiveRecords = emissiveAtlasState.resized ? agentRecords : dirtyRecords;
        drawAgentChannelAtlas(
            materialAtlasState.atlas,
            materialRecords,
            slots,
            columns,
            cell,
            'materialSource',
        );
        drawAgentChannelAtlas(
            emissiveAtlasState.atlas,
            emissiveRecords,
            slots,
            columns,
            cell,
            'emissiveSource',
        );
        renderer._gpuAgentSidecarRevision = (renderer._gpuAgentSidecarRevision || 0) + 1;
        if (!materialAtlasState.resized && materialAtlasState.atlas) {
            renderer._gpuAgentMaterialTextureUpdates = buildAgentAtlasTextureUpdates(
                materialAtlasState.atlas, materialRecords, slots, columns, cell);
        }
        if (!emissiveAtlasState.resized && emissiveAtlasState.atlas) {
            renderer._gpuAgentEmissiveTextureUpdates = buildAgentAtlasTextureUpdates(
                emissiveAtlasState.atlas, emissiveRecords, slots, columns, cell);
        }
    }
    fillWalkStrips(renderer, agentRecords, stripped, {
        ...stripLayout,
        atlas,
        resized,
        channels: [
            { name: 'materialSource', state: materialAtlasState, updates: '_gpuAgentMaterialTextureUpdates' },
            { name: 'emissiveSource', state: emissiveAtlasState, updates: '_gpuAgentEmissiveTextureUpdates' },
        ],
    });
    for (const record of agentRecords) {
        const slot = slots.get(record.id) || 0;
        const stripIndex = stripped.get(record.id);
        const stripOrigin = stripIndex === undefined ? null : walkStripOrigin(stripIndex, stripLayout);
        record.source = atlas;
        record.sourceWidth = width;
        record.sourceHeight = height;
        record.sx = stripOrigin ? stripOrigin.x + record.walkStrip.frame * cell : (slot % columns) * cell;
        record.sy = stripOrigin ? stripOrigin.y : Math.floor(slot / columns) * cell;
        record.textureKey = 'agent-frame-atlas';
        record.textureRevision = renderer._gpuAgentFrameAtlasRevision;
        record.textureUpdates = renderer._gpuAgentAlbedoTextureUpdates;
        // Pack the authored channels into the same slot geometry as albedo so
        // the GL batch can bind one frame-local material/emissive source for
        // every agent. Empty slots stay transparent and use the profile/default
        // record values without inferring emission from albedo.
        record.materialSource = materialAtlasState.atlas;
        record.emissiveSource = emissiveAtlasState.atlas;
        record.packedGeometry = Boolean(materialAtlasState.atlas);
        record.sidecarKey = materialAtlasState.atlas || emissiveAtlasState.atlas
            ? 'agent-frame-atlas:channels'
            : '';
        record.sidecarRevision = materialAtlasState.atlas || emissiveAtlasState.atlas
            ? renderer._gpuAgentSidecarRevision || 0
            : null;
        record.materialTextureUpdates = renderer._gpuAgentMaterialTextureUpdates;
        record.emissiveTextureUpdates = renderer._gpuAgentEmissiveTextureUpdates;
    }
    return records;
}

function uniqueAssetBytes(assets, id) {
    const dims = assets?.getDims?.(id);
    if (dims) return Math.max(0, dims.w) * Math.max(0, dims.h) * 4;
    const image = assets?.get?.(id);
    return Math.max(0, image?.width || 0) * Math.max(0, image?.height || 0) * 4;
}

function decideAtlasCategories(renderer, drawables = []) {
    const assets = renderer?.assets;
    const atlas = assets?.getAtlas?.('world-pilot', 'albedo');
    const atlasBytes = atlas ? atlas.width * atlas.height * 4 : 0;
    const buildings = new Map();
    const props = new Map();
    for (const drawable of drawables || []) {
        if (drawable.kind?.startsWith?.('building')) {
            const id = drawable.payload?.entry?.id || drawable.entry?.id;
            if (!id || buildings.has(id) || !assets?.getAtlasFrame?.(id)) continue;
            buildings.set(id, uniqueAssetBytes(assets, id));
        } else if (drawable.kind?.startsWith?.('prop')) {
            const sprite = drawable.payload?.sprite || drawable.sprite;
            const id = sprite?.id;
            if (!id || !PILOT_PROP_IDS.includes(id) || props.has(id) || !assets?.getAtlasFrame?.(id)) continue;
            props.set(id, uniqueAssetBytes(assets, id));
        }
    }
    const atlasResident = Boolean(renderer._gpuAtlasResident);
    const building = shouldUseAtlasForCategory({
        category: 'building',
        atlasBytes,
        individualBytes: [...buildings.values()].reduce((sum, bytes) => sum + bytes, 0),
        recordCount: buildings.size,
        atlasResident,
    });
    const prop = shouldUseAtlasForCategory({
        category: 'prop',
        atlasBytes,
        individualBytes: [...props.values()].reduce((sum, bytes) => sum + bytes, 0),
        recordCount: props.size,
        atlasResident: atlasResident || building,
    });
    if (building || prop) renderer._gpuAtlasResident = true;
    return {
        building,
        prop,
        atlasBytes,
        buildingIds: buildings.size,
        propIds: props.size,
        buildingBytes: [...buildings.values()].reduce((sum, bytes) => sum + bytes, 0),
        propBytes: [...props.values()].reduce((sum, bytes) => sum + bytes, 0),
    };
}

function sourceKindCensus(records = [], decision = {}) {
    let atlasRecords = 0;
    let individualRecords = 0;
    let uploadBytesEstimate = 0;
    const seenTextures = new Set();
    for (const record of records) {
        const kind = record.sourceKind
            || (String(record.textureKey || '').startsWith('world-pilot') || record.textureKey === 'world-pilot'
                ? 'atlas'
                : 'individual');
        if (kind === 'atlas') atlasRecords += 1;
        else individualRecords += 1;
        const key = record.textureKey || record.id;
        if (seenTextures.has(key)) continue;
        seenTextures.add(key);
        uploadBytesEstimate += Math.max(0, record.sourceWidth || 0) * Math.max(0, record.sourceHeight || 0) * 4;
        for (const channel of [record.materialSource, record.emissiveSource, record.occluderSource]) {
            if (channel && channel !== record.source) {
                uploadBytesEstimate += Math.max(0, channel.width || 0) * Math.max(0, channel.height || 0) * 4;
            }
        }
    }
    return {
        atlasRecords,
        individualRecords,
        uploadBytesEstimate,
        batchCount: seenTextures.size,
        categories: {
            building: decision.building ? 'atlas' : 'individual',
            prop: decision.prop ? 'atlas' : 'individual',
            terrain: 'cache',
            agent: 'frame-atlas',
        },
    };
}

// V9 / 0.6 — painter depth for the records one drawable produced. Opaque
// sprite kinds (buildings, props, bodies) opt in to writing the depth key of
// the drawable's painter sortY (the same sortY DrawablePass sorted them by);
// any other producer sets `writesDepth` itself. The drawable's ground-layer
// records (`ground:*` casts and marks) keep the far plane and never write.
const DEPTH_WRITING_KINDS = /^(?:building|prop|agent)/;

function stampPainterDepth(records, from, drawable) {
    const kindWrites = DEPTH_WRITING_KINDS.test(drawable?.kind || '');
    for (let index = from; index < records.length; index++) {
        const record = records[index];
        if (!record || String(record.id || '').startsWith('ground:')) continue;
        if (record.depthSortY == null) record.depthSortY = drawable.sortY;
        if (record.writesDepth == null) record.writesDepth = kindWrites;
    }
}

export function buildGpuWorldRecords(renderer, { drawables = [] } = {}) {
    const decision = decideAtlasCategories(renderer, drawables);
    if (renderer) renderer._gpuAtlasDecision = decision;
    const records = renderer?._gpuWorldRecordScratch || [];
    records.length = 0;
    const terrain = recordForTerrain(renderer);
    if (terrain) records.push(terrain);
    // 1.3 — terrain-baked emitter props (plaza braziers, street lanterns)
    // redraw over the terrain with their emissive sidecars.
    records.push(...cacheEmitterRecords(renderer, atlasChannelRevision));
    const haze = recordForHaze(renderer);
    if (haze) {
        // A baked field over its own world rect (world px, so not V9
        // screenSpace): kept off the albedo page; footY -1 keeps the world grid.
        haze.pageable = false;
        records.push(haze);
    }
    const cue = renderer?._semanticGroundCanvas;
    if (cue && renderer._semanticGroundActive) {
        const camera = renderer.camera;
        records.push({ id: 'ground:semantics', source: cue, textureKey: 'ground:semantics',
            x: -camera.renderOffsetX / camera.zoom, y: -camera.renderOffsetY / camera.zoom,
            width: renderer._semanticGroundViewport.width / camera.zoom, height: renderer._semanticGroundViewport.height / camera.zoom,
            textureRevision: renderer._semanticGroundRevision, elevation: 0, occluder: 0, pageable: false,
            // 4.6 — its texels are backing pixels drawn at the rounded offset:
            // nearest on flight frames too (V9 fatOptOut).
            fatOptOut: true,
            // B.2 — the redraw's dirty rect (null = full upload).
            textureUpdates: renderer._semanticGroundUpdates || null });
    }
    let sequence = 0;
    for (const drawable of drawables || []) {
        let next = null;
        const from = records.length;
        if (drawable.kind?.startsWith?.('building')) {
            next = recordForBuilding(renderer, drawable.payload || drawable, sequence);
        } else if (drawable.kind?.startsWith?.('prop')) {
            next = recordForProp(renderer, drawable, sequence);
        } else if (drawable.kind === 'agent') {
            const agentRecords = recordsForAgent(drawable, sequence);
            for (let index = 0; index < agentRecords.length; index++) records.push(agentRecords[index]);
        } else if (typeof drawable.buildGpuRecord === 'function') {
            next = drawable.buildGpuRecord({ renderer, sequence });
        } else if (typeof drawable.payload?.buildGpuRecord === 'function') {
            next = drawable.payload.buildGpuRecord({ renderer, drawable, sequence });
        }
        if (Array.isArray(next)) {
            for (let index = 0; index < next.length; index++) records.push(next[index]);
        }
        else if (next) records.push(next);
        stampPainterDepth(records, from, drawable);
        sequence++;
    }
    packGpuAgentFrameAtlas(renderer, records);
    const ordered = renderer?._gpuWorldOrderedRecords || [];
    ordered.length = 0;
    for (let index = 0; index < records.length; index++) {
        if (records[index].id === 'terrain:static') ordered.push(records[index]);
    }
    for (let index = 0; index < records.length; index++) {
        const record = records[index];
        if (record.id !== 'terrain:static' && String(record.id || '').startsWith('ground:')) ordered.push(record);
    }
    for (let index = 0; index < records.length; index++) {
        const record = records[index];
        if (record.id !== 'terrain:static' && !String(record.id || '').startsWith('ground:')) ordered.push(record);
    }
    if (renderer) {
        renderer._gpuWorldRecordScratch = records;
        renderer._gpuWorldOrderedRecords = ordered;
        renderer._gpuMaterialPacketDiagnostics = sourceKindCensus(ordered, decision);
        renderer._gpuMaterialPacketDiagnostics.terrainOrigin = renderer._gpuTerrainMaterialOrigin || 'procedural';
    }
    return ordered;
}

export function gpuMaterialNameForBuilding(type) {
    return MATERIAL_BY_BUILDING[type] || 'stone';
}

export function gpuMaterialNameForProp(sprite) {
    return materialForProp(sprite);
}
