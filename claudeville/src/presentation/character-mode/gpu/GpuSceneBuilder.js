import { agentPaletteLut, canvasOverflowRecord, finishAgentLayerFrame } from '../AgentLayerRecords.js';
import {
    DAYLIGHT_PASSIVE_CORE_SCALE,
    effectBudgetMode,
    isDaytimeHighEnergyBuilding,
    materialClassId,
} from './GpuWorldPolicy.js';
import { sourceEnergyFor } from '../AtmosphereState.js';
import { tileToWorld, TILE_HALF_HEIGHT, TILE_HALF_WIDTH } from '../Projection.js';
import { offshoreSceneryRecords } from '../OffshoreScenery.js';
import { landmarkFootprint } from '../FootprintField.js';
import { ownerSlotFor } from '../LightSourceRegistry.js';
import { lookStrength } from '../LookStrengths.js';
import { lampSilhouetteFor, setLampSilhouetteMode } from '../RakingLight.js';
import { lampSilhouetteRecords, releaseLampSilhouettes } from '../LampSilhouette.js';
import {
    atlasSourceRect,
    shouldUseAtlasForCategory,
} from '../AssetManager.js';
import { getBuildingVisual } from '../BuildingVisualRegistry.js';
import { paintCoastWaterMaterial } from '../CoastBake.js';
import { GROUND_CLASS, paintGroundMaterial } from '../GroundBake.js';
import { castLightingFor, frameShadeLayer, stampCastFor, structureCast, treeCast, TREE_CAST_ALPHA } from '../RakingLight.js';
import { shadeSelfProp } from '../ShadeField.js';
import { cacheEmitterRecords } from '../EmitterCuts.js';
import { IDLE_FRAMES, WALK_FRAMES } from '../SpriteSheet.js';

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
    tavern: 'stone',
    portal: 'stone',
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
    tavern: 8,
    portal: 9,
});

// Provider identity is layered over authored sprite channels. These profiles
// are only deterministic defaults for agent records that do not name a
// material; authored record/atlas values remain authoritative. Unknown
// providers use the material contract's safe albedo-only fallback.
// Look `nl1` — the landmarks that take the firelight ramp beyond Command, on
// the tuned landing (Firelight.js: ground texels to the pools, warm light
// only, a door lights its own reveal, its own fire's first course). Judged
// at 22:00, z2/z3, with workers (s4a-firelight boards). Off: the Harbor (a
// street lamp one tile from the quay lays a hard-edged ochre slab on the
// quay's stone face) and the Mine (its cave mouth's warm glow lands as a
// flat brown course, darker than today), the Portal (its own lilac wash is
// lost to the warm-only rule) and the Archive (its right door jamb becomes
// a flat orange post).
export const RAMP_LANDMARKS = new Set(['forge', 'tavern', 'taskboard', 'watchtower']);

export const DEFAULT_PROVIDER_MATERIAL_CLASS = 'unlit';
export const PROVIDER_MATERIAL_PROFILES = Object.freeze({
    antigravity: Object.freeze({ defaultMaterialClass: 'glass-rune' }),
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
export function packGeometryPixels(material = null, occluder = null, pixelCount = null, indexed = false) {
    const requestedPixels = pixelCount == null ? NaN : Number(pixelCount);
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
        packed[index + 2] = indexed
            ? (((materialPresent ? material[index+1] : 0) & 63) << 1) | Number(geometryPresent)
            : geometryPresent ? Math.max(1, occluder[index + 1]) : 0;
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
// A per-record revision would re-upload the whole channel page whenever
// the next batch binds a different record from that same atlas.
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
    const ctx = canvas.getContext('2d', { alpha: true, willReadFrequently: true });
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
    const ctx = canvas.getContext('2d', { alpha: true, willReadFrequently: true });
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

// LA-6a / LA-6b — the sky's rare phenomena on the far sea (SkyRenderer
// `farSeaLayers`, computed once per frame by the frame renderer): one ground
// record per world stamp, right after the terrain. A stamp's texture key is
// its own (the bow; a ribbon's phase), so a phase step swaps textures and
// each uploads once per bake (`textureRevision` is the bake key). Fog never
// lies with them (a bow needs a cleared sky, an aurora cover ≤ 0.35) and the
// ground cues are on land, so the later inserts may land either side.
function farSeaRecords(renderer, records) {
    const layers = renderer?._farSeaLayers;
    if (!layers?.length) return;
    const pool = renderer._farSeaRecordPool || (renderer._farSeaRecordPool = []);
    for (let index = 0; index < layers.length; index++) {
        const layer = layers[index];
        const record = pool[index] || (pool[index] = {
            material: materialClassId('default'),
            elevation: 0,
            emissive: 0,
            occluder: 0,
            sequence: -0.95,
            sourceKind: 'individual',
            sx: 0,
            sy: 0,
            // A world-px stamp (not V9 screenSpace): kept off the albedo page.
            pageable: false,
        });
        record.id = `ground:far-sea:${layer.id}`;
        record.stableKey = record.id;
        record.textureKey = record.id;
        record.source = layer.canvas;
        record.sourceWidth = layer.canvas.width;
        record.sourceHeight = layer.canvas.height;
        record.sw = layer.canvas.width;
        record.sh = layer.canvas.height;
        record.x = layer.x;
        record.y = layer.y;
        record.width = layer.width;
        record.height = layer.height;
        record.alpha = Math.min(1, Math.max(0, layer.alpha));
        record.textureRevision = layer.key;
        records.push(record);
    }
}

// 1.5 — building ground casts: one stepped stamp per building, baked by
// RakingLight per sun bucket (longer and violet at golden hour and sunrise)
// and shared with the Canvas fallback. `textureRevision` is the bucket key,
// so the texture uploads only when the sun moves a bucket.
function buildingShadowRecords(renderer, drawable, sequence) {
    if (drawable?.kind === 'building-front') return [];
    if (drawable?.kind === 'building-column' && (drawable.column?.index || 0) > 0) return [];
    const building = drawable?.building;
    const grounding = getBuildingVisual(building?.type)?.grounding;
    const contact = grounding?.contact;
    if (grounding?.shadow === 'none' || !(contact?.width > 0) || !(contact?.depth > 0)) return [];
    const cast = stampCastFor(castLightingFor(renderer?._lastAtmosphere));
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
    const cast = stampCastFor(castLightingFor(renderer?._lastAtmosphere));
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

// SD-1 — the sun's shade as ONE ground record: the world-locked shade field
// (ShadeField; RakingLight `frameShadeLayer`) over its own world rect, a texel
// per 2x1 field cell, in place of the per-building and per-tree sun trails
// (which then bake contact only, `stampCastFor`), so overlapping shadows
// never darken twice. It keeps the 2.9 over-water rule (`groundCast`) and
// uploads once per field build (`textureRevision`), never per pan.
function shadeFieldRecord(renderer) {
    const shade = castLightingFor(renderer?._lastAtmosphere).shade;
    const layer = shade ? frameShadeLayer() : null;
    if (!layer) return null;
    const { field, canvas } = layer;
    return {
        id: 'ground:shade',
        stableKey: 'ground:shade',
        textureKey: 'ground-shade-field',
        source: canvas,
        sourceWidth: canvas.width,
        sourceHeight: canvas.height,
        sx: 0,
        sy: 0,
        sw: canvas.width,
        sh: canvas.height,
        x: field.originX,
        y: field.originY,
        width: field.cols * field.cellW,
        height: field.rows * field.cellH,
        alpha: shade.alpha,
        material: materialClassId('default'),
        elevation: 0,
        occluder: 0,
        emissive: 0,
        sequence: -0.5,
        groundCast: true,
        // A world-px field (not V9 screenSpace): kept off the albedo page.
        pageable: false,
        textureRevision: layer.revision,
        sourceKind: 'individual',
    };
}

function recordForBuilding(renderer, drawable, sequence) {
    const assets = renderer?.assets;
    const id = drawable?.entry?.id;
    if (!id) return null;
    const individual = assets?.get?.(id);
    const dims = assets?.getDims?.(id) || (individual ? { w: individual.width, h: individual.height } : null);
    if (!dims) return null;
    const [ax, ay] = assets.getAnchor(id) || [dims.w / 2, dims.h];
    const col = drawable.kind === 'building-column' ? drawable.column : null;
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
        sx = col ? rect.sx + col.sx : rect.sx;
        sy = rect.sy;
        sw = col ? Math.min(col.sw, Math.max(0, rect.sw - col.sx)) : rect.sw;
        sh = rect.sh;
        textureKey = atlasFrame.atlas;
    } else {
        source = individual;
        if (!source) return null;
        sourceWidth = dims.w;
        sourceHeight = dims.h;
        sx = col ? col.sx : 0;
        sy = split && front ? horizon : 0;
        sw = col ? col.sw : dims.w;
        sh = split ? (front ? dims.h - horizon : horizon) : dims.h;
        textureKey = id;
    }
    if (sw <= 0 || sh <= 0) return null;
    const buildingType = drawable.building?.type || id.replace(/^building\./, '');
    const materialMeta = drawable.entry?.material || drawable.entry?.gpuMaterial || {};
    const materialName = materialMeta.class || drawable.entry?.materialClass || MATERIAL_BY_BUILDING[buildingType] || 'stone';
    const footprint = drawable.building ? landmarkFootprint(drawable.building) : null;
    // V8 — landmark emission follows the work tier (isWorkingVisitor counts +
    // observed-tool recency), never idle, seated or passing bodies.
    const workTier = renderer?.buildingRenderer?._workTierFor?.(drawable.building);
    const active = Boolean(workTier) && workTier !== 'dormant';
    const workOpen = renderer?.buildingRenderer?.partGates?.isOpen?.(`work.${buildingType}`) ?? active;
    const rawEmissiveGate = renderer?.buildingRenderer?._emissiveGateFor?.(drawable.building) ?? 1;
    const daytimeEmitter = isDaytimeHighEnergyBuilding(buildingType, workOpen, rawEmissiveGate);
    const emissiveGate = rawEmissiveGate;
    // Material/emissive are sampled with the albedo's UVs (see the GL fragment
    // shaders), so a channel source must share the albedo's geometry. When the
    // albedo comes from an atlas page the channels must be that page's channel
    // pages. A per-landmark source under the shared `<atlas>:channels` key
    // sampled the wrong pixels and triggered a full upload on every rebind.
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
    const spriteLeft = Math.round(drawable.wx - ax);
    const recordId = col ? `${id}:column:${col.index}` : `${id}:${drawable.kind}`;
    const record = {
        id: recordId,
        stableKey: recordId,
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
        x: spriteLeft + (col ? col.sx : 0),
        y: Math.round(drawable.wy - ay + (split && front ? horizon : 0)),
        width: col ? sw : (useAtlas ? sw : dims.w),
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
        daytimeEmitter,
        // 3.5 pilot opt-in: Command's authored material pixels quantize
        // admitted local light to the palette ramp. Look `nl1` (a switch: a
        // ramp is on or off per building) extends it to RAMP_LANDMARKS. A
        // landmark outside them keeps today's additive response, so the ramp
        // cannot leak through a shared atlas batch.
        paletteRamp: buildingType === 'command' || (RAMP_LANDMARKS.has(buildingType) && lookStrength('nl1') > 0),
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
    const glass = glassPatchRecord(renderer, drawable, record, spriteLeft, col, split ? horizon : null, front);
    const roof = roofWeatherRecords(renderer, drawable, record, spriteLeft, col, split ? horizon : null, front, sequence);
    const parts = buildingPartRecords(renderer, drawable, record, sequence);
    const forgeOverlay = forgeWorkloadRecord(renderer, drawable, record, spriteLeft, col, split ? horizon : null, front, sequence);
    if (!shadows.length && !glass && !roof.length && !parts.length && !forgeOverlay) return record;
    const out = glass ? [...shadows, record, glass] : [...shadows, record];
    for (let index = 0; index < roof.length; index++) out.push(roof[index]);
    for (let index = 0; index < parts.length; index++) out.push(parts[index]);
    if (forgeOverlay) out.push(forgeOverlay);
    return out;
}

// 6.1 / 6.2 — one small record per drawn manifest layer (static overlay such
// as the Pharos lamp or the Portal's vortex, active frame-strip part,
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
    const col = drawable.kind === 'building-column' ? drawable.column : null;
    const split = col
        ? 'column'
        : drawable.kind === 'building-back'
            ? 'back'
            : drawable.kind === 'building-front' ? 'front' : 'whole';
    const scratch = renderer._gpuPartDrawScratch || (renderer._gpuPartDrawScratch = []);
    const draws = buildings.partDrawsFor(drawable.entry, drawable.building, drawable.wx, drawable.wy,
        split, drawable.horizonY ?? null, scratch, col);
    if (!draws.length) return NO_PART_RECORDS;
    const out = [];
    for (let index = 0; index < draws.length; index++) {
        const d = draws[index];
        const channels = buildings.partChannelsFor?.(drawable.entry, d) || null;
        const id = `${base.id}:part:${d.name}`;
        const rawPartGate = d.emissiveGate ?? (d.fixture ? 1 : base.emissiveGate);
        const partDaytimeEmitter = Boolean(base.daytimeEmitter && !d.ember && rawPartGate > 0.01);
        const partGate = rawPartGate;
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
            // VQ-8 — a part with its own gate (the banked ember floor) keeps it.
            emissiveGate: partGate,
            daytimeEmitter: partDaytimeEmitter,
            paletteRamp: base.paletteRamp,
            occluder: base.occluder,
            landmarkId: base.landmarkId,
            textureRevision: d.textureRevision || d.textureKey,
            sidecarRevision: channels?.key || d.textureKey,
            sequence: sequence + (index + 2) / 1000,
            sourceKind: 'individual',
        });
    }
    return out;
}

// Forge anvil billets and result shelf tiles as a depth-sorted GPU record so
// foreground villagers always paint over them on WebGL2 and WebGPU.
function forgeWorkloadRecord(renderer, drawable, record, spriteLeft, col, horizon, front, sequence) {
    if (drawable.kind === 'building-back') return null;
    const layer = renderer?.buildingRenderer?.forgeWorkloadSpriteFor?.(drawable.building);
    if (!layer) return null;
    let cx0 = 0;
    let cw = layer.w;
    if (col) {
        const start = Math.max(0, col.sx - layer.left);
        const end = Math.min(layer.w, col.sx + col.sw - layer.left);
        if (end <= start) return null;
        cx0 = start;
        cw = end - start;
    }
    let sy = 0;
    let sh = layer.h;
    if (horizon != null) {
        const cut = Math.max(0, Math.min(layer.h, horizon - layer.top));
        if (front) sy = cut;
        sh = front ? layer.h - cut : cut;
        if (sh <= 0) return null;
    }
    const spriteTop = record.y - (horizon != null && front ? horizon : 0);
    return {
        ...record,
        id: `${record.id}:forge-workload`,
        stableKey: `${record.stableKey}:forge-workload`,
        textureKey: 'building.forge:workload',
        sidecarKey: '',
        source: layer.canvas,
        materialSource: null,
        emissiveSource: null,
        occluderSource: null,
        surfaceCode: false,
        sourceWidth: layer.w,
        sourceHeight: layer.h,
        sx: cx0,
        sy,
        sw: cw,
        sh,
        x: spriteLeft + layer.left + cx0,
        y: spriteTop + layer.top + sy,
        width: cw,
        height: sh,
        emissive: 0,
        textureRevision: layer.key,
        sidecarRevision: null,
        sequence: sequence + 0.05,
        sourceKind: 'individual',
    };
}

// 6.3 — the landmark's unlit panes (BuildingSprite.glassPatchFor, RoomGlass):
// each dark room's own unlit albedo drawn on the same texels right after the
// landmark, with no emissive channel, so an unoccupied room — and every pane
// by day (M15) — shows unlit slate glass instead of the lit sidecar.
function glassPatchRecord(renderer, drawable, record, spriteLeft, col, horizon, front) {
    const patch = renderer?.buildingRenderer?.glassPatchFor?.(drawable.building);
    if (!patch) return null;
    let cx0 = 0;
    let cw = patch.w;
    if (col) {
        const start = Math.max(0, col.sx - patch.left);
        const end = Math.min(patch.w, col.sx + col.sw - patch.left);
        if (end <= start) return null;
        cx0 = start;
        cw = end - start;
    }
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
        sx: cx0,
        sy,
        sw: cw,
        sh,
        x: spriteLeft + patch.left + cx0,
        y: spriteTop + patch.top + sy,
        width: cw,
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
// dry weather emits nothing but the EN-6 low-sun glint run.
const NO_ROOF_RECORDS = Object.freeze([]);

function roofWeatherRecords(renderer, drawable, record, spriteLeft, col, horizon, front, sequence) {
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
        let cx0 = 0;
        let cw = source.w;
        if (col) {
            const start = Math.max(0, col.sx - source.left);
            const end = Math.min(source.w, col.sx + col.sw - source.left);
            if (end <= start) return;
            cx0 = start;
            cw = end - start;
        }
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
            sx: (source.sx || 0) + cx0,
            sy,
            sw: cw,
            sh,
            x: spriteLeft + source.left + cx0,
            y: spriteTop + source.top + sy,
            width: cw,
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
    // A procedural prop's own channels, painted beside its cached albedo
    // (StaticPropSprite `channels`): an occluder canvas is a 2.3 surface
    // channel (the village wall), an emissive canvas its lit glass.
    const ownOccluder = useAtlas ? null : cached.occluder || null;
    const ownEmissive = useAtlas || emissiveSource ? null : cached.emissive || null;
    const ownChannels = Boolean(ownOccluder || ownEmissive);
    const record = {
        id: `prop:${propId || `${sprite.tileX},${sprite.tileY}`}:${part}${column ? `:${column.index}` : ''}`,
        stableKey: drawable.stableKey || propId || `${sprite.tileX},${sprite.tileY}`,
        textureKey,
        sidecarKey: materialSource
            ? (useAtlas && atlasFrame?.atlas ? `${atlasFrame.atlas}:channels` : `${propId}:channels`)
            : (ownChannels ? `${textureKey}:own` : ''),
        source,
        materialSource,
        emissiveSource: emissiveSource || ownEmissive,
        occluderSource: ownOccluder,
        surfaceCode: Boolean(ownOccluder),
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
        // SD-2 — a prop the shade field holds as a mass of its own.
        sunSelf: shadeSelfProp(propId),
        material: materialClassId(materialName),
        elevation: materialName === 'foliage' ? 0.64 : elevated > 70 ? 0.58 : 0.34,
        emissive: emissiveSource || ownEmissive ? 0 : (materialName === 'fire' ? 0.35 : 0),
        emissiveGate: typeof sprite.emitterGate === 'function' ? sprite.emitterGate() : 1,
        occluder: elevated > 36 ? 0.58 : 0.2,
        textureRevision: useAtlas ? (assets.assetVersion || 0) : (sprite._gpuCacheRevision || 0),
        sidecarRevision: useAtlas && atlasFrame?.atlas
            ? atlasChannelRevision(assets, atlasFrame.atlas)
            : (resolved?.revision || (ownChannels ? `own:${sprite._gpuCacheRevision || 0}` : null)),
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

function ensureAgentChannelAtlas(renderer, property, width, height, cell, state) {
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
    if (atlas.width !== width || atlas.height !== height || state.cell !== cell) {
        atlas.width = width;
        atlas.height = height;
        resized = true;
    }
    if (resized) state.occupied = new Map();
    state.cell = cell;
    state.atlas = atlas;
    state.resized = resized;
    return state;
}

function agentChannelRect(record, source) {
    // Equipped bodies use an unpadded channel sheet inside the padded slot.
    if (record.channelRect) return record.channelRect;
    const { width, height } = source;
    if (width === record.sw && height === record.sh) {
        return { sx: 0, sy: 0, sw: width, sh: height, dx: 0, dy: 0 };
    }
    if (width >= (record.sx || 0) + record.sw && height >= (record.sy || 0) + record.sh) {
        return { sx: record.sx, sy: record.sy, sw: record.sw, sh: record.sh, dx: 0, dy: 0 };
    }
    return {
        sx: 0, sy: 0, sw: width, sh: height,
        dx: Math.max(0, Math.floor((record.sw - width) / 2)),
        dy: Math.max(0, Math.floor((record.sh - height) / 2)),
    };
}

// 4.7 — full-rate gait on the resident path. A walking, on-screen, non-LOD
// body (its record carries `walkStrip`, built by AgentGpuOverlayRenderer)
// holds WALK_FRAMES consecutive cells after the pose bands, wrapping across
// rows just like a pose cell. A strip cell is copied and uploaded
// the first time its frame shows, so a strip costs at most one cell upload
// per frame change and none once the stride has cycled. Moving the strip or
// changing its key (direction, tool, sheet, channels, pose) refills it. Idle, posed and
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

function atlasCellUpdate(source, { x, y }, width, height) {
    return { x, y, sx: x, sy: y, width: Math.ceil(width), height: Math.ceil(height), source };
}

// Occupancy belongs to the physical cell. A replacement without a sidecar
// must erase the previous owner's pixels, even if its pose band was discarded.
function paintAgentChannels(channels, record, cellIndex, origin, cell) {
    for (const { name, state, updates } of channels) {
        if (!state.atlas) continue;
        const old = state.occupied.get(cellIndex);
        const source = record[name];
        if (!source && !old) continue;
        const ctx = state.atlas.getContext('2d', { alpha: true });
        ctx.imageSmoothingEnabled = false;
        if (old) ctx.clearRect(old.x, old.y, old.width, old.height);
        let painted;
        if (source) {
            const rect = agentChannelRect(record, source);
            const x = origin.x + rect.dx;
            const y = origin.y + rect.dy;
            const width = Math.min(rect.sw, cell - rect.dx);
            const height = Math.min(rect.sh, cell - rect.dy);
            ctx.drawImage(source, rect.sx, rect.sy, width, height, x, y, width, height);
            painted = { x, y, width: Math.ceil(width), height: Math.ceil(height) };
            state.occupied.set(cellIndex, painted);
        } else {
            state.occupied.delete(cellIndex);
        }
        if (!state.resized) {
            // Include the vacated border when a padded or clipped pose shrinks.
            const before = old || painted;
            const after = painted || old;
            const x = Math.min(before.x, after.x);
            const y = Math.min(before.y, after.y);
            const width = Math.max(before.x + before.width, after.x + after.width) - x;
            const height = Math.max(before.y + before.height, after.y + after.height) - y;
            updates.push(atlasCellUpdate(state.atlas, { x, y }, width, height));
        }
    }
}

function fillWalkStrips(renderer, agentRecords, assigned, layout) {
    const strips = renderer._gpuAgentStrips || [];
    const { cell, columns, stripBase, atlas, resized, stripsMoved, channels } = layout;
    // A moved base invalidates even the strips whose walkers are off screen.
    if (stripsMoved) {
        for (const strip of strips) strip.filled = 0;
        for (const id of assigned.keys()) renderer._gpuAgentAtlasFrameKeys?.delete(id);
    }
    if (!assigned.size) return;
    const ctx = atlas.getContext('2d', { alpha: true });
    ctx.imageSmoothingEnabled = false;
    let fills = 0;
    for (const record of agentRecords) {
        const index = assigned.get(record.id);
        if (index === undefined) continue;
        const strip = strips[index];
        // The walk-strip key moves whenever a probed cell's sheet or channel
        // source moves. A reactivated channel also invalidates the filled bits.
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
        const cellIndex = stripBase + index * WALK_FRAMES + frame;
        const origin = agentCellOrigin(cellIndex, columns, cell);
        ctx.clearRect(origin.x, origin.y, cell, cell);
        ctx.drawImage(source.source, source.sx, source.sy, source.sw, source.sh, origin.x, origin.y, source.sw, source.sh);
        if (!resized) renderer._gpuAgentAlbedoTextureUpdates.push(atlasCellUpdate(atlas, origin, source.sw, source.sh));
        paintAgentChannels(channels, source, cellIndex, origin, cell);
        strip.filled |= bit;
        fills++;
    }
    if (fills) renderer._gpuAgentFrameAtlasRevision++;
}

// FP-6 — resident idle and pose bands. A body cycles a few frames (four
// idle frames, a pose's beats); each body owns a band of up to IDLE_FRAMES
// cells, keyed like its slot key, so a frame it has already shown is
// re-sampled where it lies instead of redrawn and re-uploaded into all three
// atlases. A frame not in the band takes the least recently shown cell, so
// after one cycle an idle bob costs no upload. Bands shrink to fit
// AGENT_BAND_BUDGET_PX per atlas (down to one cell: the slot cadence as
// before), the walk-strip rule's bound. Channel cells of a profile without
// that sidecar stay transparent and are never patched again.
const AGENT_BAND_CELLS = IDLE_FRAMES;
const AGENT_BAND_BUDGET_PX = 2 * 1024 * 1024;
const AGENT_ATLAS_ROW_QUANTUM = 3;

function agentBandCells(capacity, cell) {
    const fit = Math.floor(AGENT_BAND_BUDGET_PX / Math.max(1, capacity * cell * cell));
    return Math.max(1, Math.min(AGENT_BAND_CELLS, fit));
}

function agentBandFor(bands, id, size) {
    let band = bands.get(id);
    if (!band) {
        band = {
            keys: new Array(size).fill(''),
            used: new Array(size).fill(0),
            shown: 0,
        };
        bands.set(id, band);
    }
    return band;
}

// The band's least recently shown cell (an empty one first).
function agentBandVictim(band) {
    let victim = 0;
    for (let index = 0; index < band.keys.length; index++) {
        if (!band.keys[index]) return index;
        if (band.used[index] < band.used[victim]) victim = index;
    }
    return victim;
}

function agentCellOrigin(cellIndex, columns, cell) {
    return { x: (cellIndex % columns) * cell, y: Math.floor(cellIndex / columns) * cell };
}

// B.2 — agent material and occluder travel as one packed geometry channel
// (V9 flag 32: R material id, G height, B strength, A presence), so the atlas
// keeps two channel canvases (packed geometry, emissive) beside the albedo.
// The occluder channel's frame toggle gates the packed geometry in the shader
// (`u_packedGeometry`), so the channel never needs a skip/restore repack.
export function packGpuAgentFrameAtlas(renderer, records) {
    finishAgentLayerFrame();
    agentPaletteLut.used.clear();
    for (const record of records) {
        if (!record.paletteIdentity) continue;
        record.recolorRow = agentPaletteLut.rowFor(record.paletteIdentity);
        record.recolorIndex = record.recolorRow !== 0;
        if (!record.recolorIndex) {
            // More than 252 distinct identities visible in this frame.
            canvasOverflowRecord(record);
        }
    }
    const agentRecords = records.filter(record => !record.sharedLayer && String(record.id || '').startsWith('agent:'));
    if (!agentRecords.length || typeof document === 'undefined') return records;
    let cell = 1;
    let hasMaterialSource = false;
    let hasEmissiveSource = false;
    for (const record of agentRecords) {
        cell = Math.max(cell, Math.ceil(Math.max(record.sw || 1, record.sh || 1)));
        hasMaterialSource ||= Boolean(record.materialSource);
        hasEmissiveSource ||= Boolean(record.emissiveSource);
    }
    let slots = renderer._gpuAgentAtlasSlots ||= new Map();
    const roster = [...(renderer?.agentSprites?.keys?.() || [])].sort();
    const rosterSignature = roster.join('|');
    let nextSlot = renderer._gpuAgentAtlasNextSlot || 0;
    let newSlot = false;
    const rosterChanged = rosterSignature !== renderer._gpuAgentAtlasRosterSignature;
    const oldSlots = slots;
    if (rosterChanged) {
        slots = renderer._gpuAgentAtlasSlots = new Map();
        roster.forEach((id, index) => slots.set(`agent:${id}`, index));
        nextSlot = roster.length;
        renderer._gpuAgentAtlasRosterSignature = rosterSignature;
        newSlot = true;
    }
    for (const record of agentRecords) {
        if (slots.has(record.id)) continue;
        slots.set(record.id, nextSlot++);
        newSlot = true;
    }
    if (rosterChanged) {
        for (const [id, index] of oldSlots) {
            if (slots.get(id) === index) continue;
            renderer._gpuAgentAtlasFrameKeys?.delete(id);
            renderer._gpuAgentAtlasBands?.delete(id);
            renderer._gpuAgentAtlasPoses?.delete(id);
        }
    }
    renderer._gpuAgentAtlasNextSlot = nextSlot;
    // The grid holds every assigned slot: an extra record id (a candle, a
    // tankard, a seat stone) keeps its slot until the roster changes, so the
    // records present can be fewer than the slots handed out.
    const capacity = Math.max(agentRecords.length, renderer?.agentSprites?.size || 0, nextSlot, 1);
    const bandCells = agentBandCells(capacity, cell);
    const stripBase = capacity * bandCells;
    const columns = Math.ceil(Math.sqrt(stripBase));
    const cellChanged = renderer._gpuAgentStripCell !== cell;
    const stripCandidates = agentRecords.filter(record => walkStripEligible(record, cell));
    const stripCapacity = walkStripCapacity(renderer, stripCandidates.length, cell, rosterChanged);
    const width = columns * cell;
    // A spare row lets arrivals move the strips without reallocating all three pages.
    const cells = stripBase + stripCapacity * WALK_FRAMES;
    const rowGroups = Math.ceil(cells / (columns * AGENT_ATLAS_ROW_QUANTUM));
    const height = rowGroups * AGENT_ATLAS_ROW_QUANTUM * cell;
    const stripped = assignWalkStrips(renderer, stripCandidates);
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
    const layoutChanged = cellChanged || renderer._gpuAgentAtlasBandCells !== bandCells;
    const channelAppeared = (hasMaterialSource && !materialAtlasState.atlas) || (hasEmissiveSource && !emissiveAtlasState.atlas);
    if (hasMaterialSource) {
        ensureAgentChannelAtlas(renderer, '_gpuAgentMaterialAtlas', width, height, cell, materialAtlasState);
    } else {
        materialAtlasState.atlas = null;
        materialAtlasState.resized = false;
    }
    if (hasEmissiveSource) {
        ensureAgentChannelAtlas(renderer, '_gpuAgentEmissiveAtlas', width, height, cell, emissiveAtlasState);
    } else {
        emissiveAtlasState.atlas = null;
        emissiveAtlasState.resized = false;
    }
    const rebuild = resized || layoutChanged || channelAppeared;
    const bands = renderer._gpuAgentAtlasBands ||= new Map();
    if (rebuild) {
        bands.clear();
        frameKeys.clear();
        changed = true;
    }
    const stripsMoved = rebuild || renderer._gpuAgentStripBase !== stripBase;
    renderer._gpuAgentAtlasBandCells = bandCells;
    renderer._gpuAgentStripBase = stripBase;
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const cadenceElapsed = now - (renderer._gpuAgentAtlasUpdatedAt || 0) >= 125;
    // Direction/tool changes and individually important actors must keep body
    // and attachment poses in the same frame. Ambient animation stays at 8 Hz.
    const immediate = new Set(dirtyRecords.filter(record => record.urgentPose
        || (poses.has(record.id) && poses.get(record.id) !== record.poseKey)));
    const force = rebuild || newSlot || missingFrame || !frameKeys.size;
    renderer._gpuAgentAlbedoTextureUpdates = [];
    renderer._gpuAgentMaterialTextureUpdates = [];
    renderer._gpuAgentEmissiveTextureUpdates = [];
    const tick = renderer._gpuAgentBandTick = (renderer._gpuAgentBandTick || 0) + 1;
    let drawnCells = 0;
    const channels = [
        { name: 'materialSource', state: materialAtlasState, updates: renderer._gpuAgentMaterialTextureUpdates },
        { name: 'emissiveSource', state: emissiveAtlasState, updates: renderer._gpuAgentEmissiveTextureUpdates },
    ];
    if (changed && (force || cadenceElapsed || immediate.size)) {
        const ctx = atlas.getContext('2d', { alpha: true });
        ctx.imageSmoothingEnabled = false;
        for (let index = 0; index < agentRecords.length; index++) {
            const record = agentRecords[index];
            if (stripped.has(record.id)) continue;
            const key = desiredKeys[index];
            if (frameKeys.get(record.id) === key) continue;
            if (!force && !cadenceElapsed && !immediate.has(record)) continue;
            const slot = slots.get(record.id) || 0;
            const band = agentBandFor(bands, record.id, bandCells);
            let bandIndex = band.keys.indexOf(key);
            if (bandIndex < 0) {
                bandIndex = agentBandVictim(band);
                const cellIndex = slot * bandCells + bandIndex;
                const origin = agentCellOrigin(cellIndex, columns, cell);
                ctx.clearRect(origin.x, origin.y, cell, cell);
                ctx.drawImage(record.source, record.sx, record.sy, record.sw, record.sh, origin.x, origin.y, record.sw, record.sh);
                if (!resized) renderer._gpuAgentAlbedoTextureUpdates.push(atlasCellUpdate(atlas, origin, record.sw, record.sh));
                paintAgentChannels(channels, record, cellIndex, origin, cell);
                band.keys[bandIndex] = key;
                drawnCells++;
            }
            band.shown = bandIndex;
            band.used[bandIndex] = tick;
            frameKeys.set(record.id, key);
            poses.set(record.id, record.poseKey);
        }
        renderer._gpuAgentFrameAtlasSignature = desiredKeys.slice().sort().join('|');
        // A frame re-sampled from its band changes no texel: the revision (and
        // with it an upload) moves only when a cell was drawn.
        if (drawnCells || resized) renderer._gpuAgentFrameAtlasRevision++;
        if (cadenceElapsed || force) renderer._gpuAgentAtlasUpdatedAt = now;
    }
    fillWalkStrips(renderer, agentRecords, stripped, {
        cell, columns, stripBase, atlas, resized, stripsMoved, channels,
    });
    if (channels.some(({ updates, state }) => updates.length || state.resized)) {
        renderer._gpuAgentSidecarRevision = (renderer._gpuAgentSidecarRevision || 0) + 1;
    }
    // FP-6 — each channel atlas has its own revision: a frame that patches
    // only the material atlas (a profile without an emissive sidecar) must not
    // re-upload the emissive one, which a revision without patches would.
    for (const { name: channel, state, updates } of channels) {
        const revisionKey = channel === 'materialSource' ? '_gpuAgentMaterialRevision' : '_gpuAgentEmissiveRevision';
        if (updates.length || state.resized) renderer[revisionKey] = (renderer[revisionKey] || 0) + 1;
    }
    for (const record of agentRecords) {
        const slot = slots.get(record.id) || 0;
        const stripIndex = stripped.get(record.id);
        const cellIndex = stripIndex === undefined
            ? slot * bandCells + (bands.get(record.id)?.shown || 0)
            : stripBase + stripIndex * WALK_FRAMES + record.walkStrip.frame;
        const origin = agentCellOrigin(cellIndex, columns, cell);
        record.source = atlas;
        record.sourceWidth = width;
        record.sourceHeight = height;
        record.sx = origin.x;
        record.sy = origin.y;
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
        record.materialRevision = materialAtlasState.atlas ? renderer._gpuAgentMaterialRevision || 0 : null;
        record.emissiveRevision = emissiveAtlasState.atlas ? renderer._gpuAgentEmissiveRevision || 0 : null;
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

// NL-3 (look `nl3`, LampSilhouette.js) — each body `pointCastFor` gave a lamp
// this frame lays its silhouette down, read from its own packed atlas cell
// (no slot of its own). Sets next frame's silhouette mode (RakingLight): on
// while `nl3` > 0 and EFFECT_BUDGET `lamp-silhouettes` keeps it.
// Close-up only: below the settled zoom tier 2 (where the silhouette stops
// reading) the mode stays off and the stepped trails stay, as at `nl3` 0;
// the gate changes only on a settled camera (no wheel step, snap or glide
// in flight), never mid-flight. This frame's casts were decided under last
// frame's mode, so they are always drawn: a hand-over frame never shows both
// or neither.
const LAMP_SILHOUETTE_MIN_ZOOM = 2;

function lampSilhouetteZoomGate(renderer) {
    const camera = renderer?.camera;
    const settled = camera && !camera._zoomAnimation && !camera._snapZoom && !camera._directorGlide;
    if (settled) renderer._lampSilhouetteGate = camera.zoom >= LAMP_SILHOUETTE_MIN_ZOOM - 1e-3;
    return renderer?._lampSilhouetteGate === true;
}

function insertLampSilhouetteRecords(renderer, records, at) {
    const strength = lookStrength('nl3');
    const level = renderer?.gpuWorld?._compositeQualityLevel ?? 0;
    setLampSilhouetteMode(strength > 0 && effectBudgetMode('lamp-silhouettes', level) === 'on'
        && lampSilhouetteZoomGate(renderer));
    if (!(strength > 0) || !renderer?.agentSprites?.size) {
        releaseLampSilhouettes();
        return;
    }
    const bodies = [];
    const frameKeys = renderer._gpuAgentAtlasFrameKeys;
    for (const [agentId, sprite] of renderer.agentSprites) {
        const cast = lampSilhouetteFor(sprite);
        if (!cast) continue;
        const id = `agent:${agentId}`;
        const record = records.find(r => r.id === id);
        if (!record?.source || !(record.width > 0) || !(record.height > 0)) continue;
        // The frame in the body's atlas cell: its walk-strip key and frame,
        // else the packer's frame key for the slot.
        const contentKey = record.walkStrip
            ? `w:${record.walkStrip.key}:${record.walkStrip.frame}:${record.sx},${record.sy}`
            : `f:${record.sharedLayer ? record.textureKey : frameKeys?.get(id) || ''}:${record.sx},${record.sy}`;
        bodies.push({ agentId, sprite, record, cast, contentKey });
    }
    const shadows = lampSilhouetteRecords(bodies, {
        strength,
        field: renderer._footprintField || null,
        coast: renderer._coastField || renderer.coastField || null,
    });
    if (shadows.length) records.splice(at, 0, ...shadows);
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
    // LA-6a / LA-6b — the far-sea phenomena, under the offshore backdrop.
    farSeaRecords(renderer, records);
    // W8.5a — the offshore backdrop (`ground:offshore:*`): the open sea's
    // stacks, wreck and islets, ordered with the ground records right after
    // the terrain, under the island's casts, haze, fog and every drawable.
    offshoreSceneryRecords(renderer, records);
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
    // SD-1 — the sun's shade: over the haze and the ground cues, under every
    // contact stamp and villager mark, where the sun trails lay before it.
    const shade = shadeFieldRecord(renderer);
    if (shade) records.push(shade);
    // NL-3 — the lamp silhouettes join the ground band here (under every
    // body's contact shadow, ring and candle), once the agent atlas is packed.
    const lampShadeAt = records.length;
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
    insertLampSilhouetteRecords(renderer, records, lampShadeAt);
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
    // When a daylight frame has an active work-gated emitter (awake Forge fire,
    // awake Portal, active Command braziers), the GPU renderer raises frame
    // coreEnergy to DAYTIME_WORK_BLOOM_CORE (0.36); scale all other emissive
    // records in that frame back by DAYLIGHT_PASSIVE_CORE_SCALE so passive
    // emitters keep the base 0.14 daylight core.
    if (sourceEnergyFor(renderer?._lastAtmosphere?.lighting).bucket === 'daylight') {
        let hasActiveWorkEmitter = false;
        for (let index = 0; index < ordered.length; index++) {
            const record = ordered[index];
            if (record.daytimeEmitter && record.emissiveSource && (record.emissiveGate ?? 1) > 0.01) {
                hasActiveWorkEmitter = true;
                break;
            }
        }
        if (hasActiveWorkEmitter) {
            for (let index = 0; index < ordered.length; index++) {
                const record = ordered[index];
                if (!record.daytimeEmitter && (record.emissiveSource || record.emissive > 0) && (record.emissiveGate ?? 1) > 0) {
                    ordered[index] = {
                        ...record,
                        emissiveGate: (record.emissiveGate ?? 1) * DAYLIGHT_PASSIVE_CORE_SCALE,
                    };
                }
            }
        }
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
