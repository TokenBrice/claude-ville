import { materialClassId } from './GpuWorldPolicy.js';
import { tileToWorld, TILE_HALF_HEIGHT, TILE_HALF_WIDTH } from '../Projection.js';

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
    if (/lantern|brazier|beacon|fire/.test(id)) return 'fire';
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

// The material/occluder map has four packed bytes. Authored emissive RGB does
// not fit beside material id, strength, and occluder height, so it remains a
// separate frame-local RGBA channel while the existing packed map stays stable.
export function packGpuSidecarPixels({ material = null, emissive = null, occluder = null, pixelCount = null } = {}) {
    const largestChannel = Math.max(
        Number(material?.length) || 0,
        Number(emissive?.length) || 0,
        Number(occluder?.length) || 0,
    );
    const requestedPixels = Number(pixelCount);
    const pixels = Number.isFinite(requestedPixels)
        ? Math.max(0, Math.floor(requestedPixels))
        : Math.ceil(largestChannel / 4);
    const packed = new Uint8ClampedArray(pixels * 4);
    const authoredEmissive = emissive ? new Uint8ClampedArray(pixels * 4) : null;
    for (let index = 0; index < packed.length; index += 4) {
        packed[index] = material?.[index] || 0;
        packed[index + 1] = emissive?.[index + 3] || 0;
        // The packed map keeps material in R and emissive contribution in G;
        // preserve the authored occluder R/G pair in B/A instead of reducing
        // all four source bytes to one mask value.
        packed[index + 2] = occluder?.[index] || 0;
        packed[index + 3] = occluder?.[index + 1] || 0;
        if (authoredEmissive) {
            authoredEmissive[index] = emissive[index] || 0;
            authoredEmissive[index + 1] = emissive[index + 1] || 0;
            authoredEmissive[index + 2] = emissive[index + 2] || 0;
            authoredEmissive[index + 3] = emissive[index + 3] || 0;
        }
    }
    return { packed, emissive: authoredEmissive };
}

function canvasFromPixels(pixels, width, height) {
    if (!pixels || typeof document === 'undefined') return null;
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, width);
    canvas.height = Math.max(1, height);
    const ctx = canvas.getContext('2d', { alpha: true });
    const image = ctx.createImageData(width, height);
    image.data.set(pixels);
    ctx.putImageData(image, 0, 0);
    return canvas;
}

function packedLandmarkChannels(renderer, id) {
    const assets = renderer?.assets;
    const frame = assets?.getAtlasFrame?.(id);
    if (!frame?.atlas || !frame?.rect || typeof document === 'undefined') {
        const material = sidecarFor(assets, id, 'material');
        const emissive = sidecarFor(assets, id, 'emissive');
        if (!material && !emissive) return null;
        return {
            material,
            emissive,
            revision: `${assets?.assetVersion || ''}:${id}:sidecars`,
        };
    }
    const materialAtlas = assets.getAtlas?.(frame.atlas, 'material');
    const emissiveAtlas = assets.getAtlas?.(frame.atlas, 'emissive');
    const occluderAtlas = assets.getAtlas?.(frame.atlas, 'occluder');
    if (!materialAtlas && !emissiveAtlas && !occluderAtlas) return null;
    const revision = `${assets.assetVersion || ''}:${frame.atlas}:${frame.key}`;
    const cache = renderer._gpuPackedMaterialSidecars ||= new Map();
    const cached = cache.get(id);
    if (cached?.revision === revision) return cached;

    const { x, y, w, h } = frame.rect;
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, w);
    canvas.height = Math.max(1, h);
    const ctx = canvas.getContext('2d', { alpha: true, willReadFrequently: true });
    const sample = (atlas) => {
        if (!atlas) return null;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(atlas, x, y, w, h, 0, 0, w, h);
        return ctx.getImageData(0, 0, w, h).data;
    };
    const material = sample(materialAtlas);
    const emissive = sample(emissiveAtlas);
    const occluder = sample(occluderAtlas);
    const channels = packGpuSidecarPixels({
        material,
        emissive,
        occluder,
        pixelCount: w * h,
    });
    const packed = ctx.createImageData(w, h);
    packed.data.set(channels.packed);
    ctx.putImageData(packed, 0, 0);
    const result = {
        material: canvas,
        emissive: canvasFromPixels(channels.emissive, w, h),
        revision,
    };
    cache.set(id, result);
    return result;
}

function terrainMaterialSidecar(renderer, cached) {
    if (!cached?.canvas || !cached?.bounds || typeof document === 'undefined') return null;
    const revision = `${renderer.terrainCacheKey || ''}:terrain-material-v1`;
    if (renderer._gpuTerrainMaterialSidecar?.revision === revision) {
        return renderer._gpuTerrainMaterialSidecar.canvas;
    }
    const scale = 0.25;
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.ceil(cached.canvas.width * scale));
    canvas.height = Math.max(1, Math.ceil(cached.canvas.height * scale));
    const ctx = canvas.getContext('2d', { alpha: true });
    ctx.imageSmoothingEnabled = false;
    const colorFor = (name) => `rgba(${materialClassId(name)},0,0,1)`;
    ctx.fillStyle = colorFor('earth');
    ctx.fillRect(0, 0, canvas.width, canvas.height);
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
            ctx.beginPath();
            ctx.moveTo(Math.round(cx), Math.round(cy - halfH));
            ctx.lineTo(Math.round(cx + halfW), Math.round(cy));
            ctx.lineTo(Math.round(cx), Math.round(cy + halfH));
            ctx.lineTo(Math.round(cx - halfW), Math.round(cy));
            ctx.closePath();
            ctx.fill();
        }
    };
    drawTiles(renderer.pathTiles, 'cobble');
    drawTiles(renderer.dirtPathTiles, 'earth');
    drawTiles(renderer.waterTiles, 'water');
    drawTiles(renderer.bridgeTiles, 'timber');
    renderer._gpuTerrainMaterialSidecar = { canvas, revision };
    return canvas;
}

function recordForTerrain(renderer) {
    const cached = renderer?._getTerrainCache?.();
    if (!cached?.canvas || !cached?.bounds) return null;
    const { canvas, bounds } = cached;
    const materialSource = terrainMaterialSidecar(renderer, cached);
    return {
        id: 'terrain:static',
        stableKey: 'terrain:static',
        textureKey: `terrain:${renderer.terrainCacheKey || 'static'}`,
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
        textureRevision: renderer.terrainCacheKey || null,
        sidecarRevision: renderer._gpuTerrainMaterialSidecar?.revision || null,
        sequence: -1,
    };
}

function recordForBuilding(renderer, drawable, sequence) {
    const assets = renderer?.assets;
    const id = drawable?.entry?.id;
    const source = assets?.get?.(id);
    if (!source || !id) return null;
    const dims = assets.getDims(id) || { w: source.width, h: source.height };
    const [ax, ay] = assets.getAnchor(id) || [dims.w / 2, dims.h];
    const split = drawable.kind === 'building-back' || drawable.kind === 'building-front';
    const horizon = split
        ? Math.max(1, Math.min(finite(drawable.horizonY, dims.h / 2), dims.h - 1))
        : null;
    const front = drawable.kind === 'building-front';
    const sy = split && front ? horizon : 0;
    const sh = split ? (front ? dims.h - horizon : horizon) : dims.h;
    const buildingType = drawable.building?.type || id.replace(/^building\./, '');
    const materialMeta = drawable.entry?.material || drawable.entry?.gpuMaterial || {};
    const materialName = materialMeta.class || drawable.entry?.materialClass || MATERIAL_BY_BUILDING[buildingType] || 'stone';
    const occupied = renderer?.buildingRenderer?._buildingOccupancyInfo?.(drawable.building)?.state;
    const active = occupied && occupied !== 'idle';
    const packedChannels = packedLandmarkChannels(renderer, id);
    const materialSource = packedChannels?.material || null;
    const emissiveSource = packedChannels?.emissive || null;
    return {
        id: `${id}:${drawable.kind}`,
        stableKey: `${id}:${drawable.kind}`,
        textureKey: id,
        sidecarKey: `${id}:material`,
        source,
        materialSource,
        emissiveSource,
        sourceWidth: dims.w,
        sourceHeight: dims.h,
        sx: 0,
        sy,
        sw: dims.w,
        sh,
        x: Math.round(drawable.wx - ax),
        y: Math.round(drawable.wy - ay + sy),
        width: dims.w,
        height: sh,
        material: materialClassId(materialName),
        elevation: finite(materialMeta.elevation, 0.82),
        // Never bloom an entire albedo sprite. Without an authored packed
        // material map, local semantic lights still illuminate the landmark;
        // emissive bloom begins only when the companion identifies its pixels.
        emissive: materialSource
            ? (active ? finite(materialMeta.activeEmissive, 0.12) : finite(materialMeta.emissive, 0.03))
            : 0,
        occluder: finite(materialMeta.occluder, 0.86),
        textureRevision: assets.assetVersion || null,
        sidecarRevision: packedChannels?.revision || `${assets.assetVersion || ''}:${id}`,
        sequence,
    };
}

function recordForProp(renderer, drawable, sequence) {
    const sprite = drawable?.payload?.sprite || drawable?.sprite;
    if (!sprite?._getCachedCanvas) return null;
    const cached = sprite._getCachedCanvas(renderer?.camera?.zoom || 1);
    if (!cached?.canvas) return null;
    const source = cached.canvas;
    const part = drawable?.payload?.part || 'whole';
    let sx = 0;
    let sy = 0;
    let sw = source.width;
    let sh = source.height;
    let y = cached.y;
    if (sprite.splitForOcclusion && part !== 'whole') {
        const splitWorldY = sprite.y + finite(sprite.bounds?.splitY, -18);
        const splitLocalY = Math.max(1, Math.min(source.height - 1, Math.round(splitWorldY - cached.y)));
        if (part === 'back') {
            sh = splitLocalY;
        } else {
            sy = splitLocalY;
            sh = source.height - splitLocalY;
            y += splitLocalY;
        }
    }
    const materialName = sprite.materialClass || materialForProp(sprite);
    const elevated = Math.max(0, finite(sprite.bounds?.bottom) - finite(sprite.bounds?.top));
    return {
        id: `prop:${sprite.id || `${sprite.tileX},${sprite.tileY}`}:${part}`,
        stableKey: drawable.stableKey || sprite.id || `${sprite.tileX},${sprite.tileY}`,
        textureKey: `prop-cache:${sprite.id || 'procedural'}:${sprite.tileX},${sprite.tileY}`,
        source,
        sourceWidth: source.width,
        sourceHeight: source.height,
        sx,
        sy,
        sw,
        sh,
        x: cached.x,
        y,
        width: sw,
        height: sh,
        material: materialClassId(materialName),
        elevation: materialName === 'foliage' ? 0.64 : elevated > 70 ? 0.58 : 0.34,
        emissive: materialName === 'fire' ? 0.35 : 0,
        occluder: elevated > 36 ? 0.58 : 0.2,
        textureRevision: sprite._gpuCacheRevision || 0,
        sequence,
    };
}

function recordsForAgent(drawable, sequence) {
    const sprite = drawable?.payload || drawable;
    if (!sprite) return [];
    const direct = sprite.getGpuWorldRecords?.() || sprite._gpuWorldRecords || sprite._gpuFrameRecord;
    const records = Array.isArray(direct) ? direct : direct ? [direct] : [];
    const baseRecords = records.map((record, index) => ({
        ...record,
        id: record.id || `agent:${sprite.agent?.id || sequence}:${index}`,
        stableKey: record.stableKey || sprite.agent?.id || `agent:${sequence}`,
        textureKey: record.textureKey || `agent:${sprite._spriteProfileKey || sprite.agent?.id || sequence}`,
        material: record.material ?? materialClassId(gpuMaterialNameForProvider(sprite.agent?.provider)),
        elevation: record.elevation ?? 0.52,
        occluder: record.occluder ?? 0.58,
        sequence: sequence + index / 100,
    }));
    if (!baseRecords.length) return baseRecords;
    const shadow = groundShadowRecord(sprite, sequence - 0.01);
    return shadow ? [shadow, ...baseRecords] : baseRecords;
}

let sharedGroundShadow = null;

function groundShadowRecord(sprite, sequence) {
    if (typeof document === 'undefined') return null;
    if (!sharedGroundShadow) {
        const canvas = document.createElement('canvas');
        canvas.width = 64;
        canvas.height = 24;
        const ctx = canvas.getContext('2d', { alpha: true });
        ctx.imageSmoothingEnabled = false;
        // Stepped, contact-heavy shadow: dense core at the feet and two
        // quantized falloff courses. It belongs to the GPU scene so the body
        // no longer reads as a sticker floating over the terrain.
        ctx.fillStyle = 'rgba(9, 8, 7, 0.14)';
        ctx.fillRect(8, 7, 48, 10);
        ctx.fillRect(13, 4, 38, 16);
        ctx.fillStyle = 'rgba(8, 7, 6, 0.24)';
        ctx.fillRect(15, 7, 34, 10);
        ctx.fillRect(20, 5, 24, 14);
        ctx.fillStyle = 'rgba(6, 5, 4, 0.32)';
        ctx.fillRect(22, 8, 20, 8);
        sharedGroundShadow = canvas;
    }
    const status = sprite.agent?.status;
    const primary = status === 'waiting_on_user' || status === 'errored' || sprite.selected;
    return {
        id: `ground:${sprite.agent?.id || sequence}`,
        stableKey: `ground:${sprite.agent?.id || sequence}`,
        textureKey: 'agent-ground-shadow',
        source: sharedGroundShadow,
        sourceWidth: sharedGroundShadow.width,
        sourceHeight: sharedGroundShadow.height,
        sx: 0,
        sy: 0,
        sw: sharedGroundShadow.width,
        sh: sharedGroundShadow.height,
        x: Math.round(sprite.x - sharedGroundShadow.width / 2),
        y: Math.round(sprite.y - sharedGroundShadow.height / 2 + 2),
        width: sharedGroundShadow.width,
        height: sharedGroundShadow.height,
        alpha: primary ? 1 : 0.82,
        material: materialClassId('default'),
        elevation: 0,
        occluder: 0,
        emissive: 0,
        sequence,
    };
}

function packAgentFrameAtlas(renderer, records) {
    const agentRecords = records.filter(record => String(record.id || '').startsWith('agent:'));
    if (!agentRecords.length || typeof document === 'undefined') return records;
    const cell = Math.max(1, ...agentRecords.map(record => Math.ceil(Math.max(record.sw || 1, record.sh || 1))));
    const capacity = Math.max(agentRecords.length, renderer?.agentSprites?.size || 0, 1);
    const columns = Math.max(1, Math.ceil(Math.sqrt(capacity)));
    const rows = Math.max(1, Math.ceil(capacity / columns));
    const width = columns * cell;
    const height = rows * cell;
    const slots = renderer._gpuAgentAtlasSlots ||= new Map();
    const roster = [...(renderer?.agentSprites?.keys?.() || [])].sort();
    const rosterSignature = roster.join('|');
    let nextSlot = renderer._gpuAgentAtlasNextSlot || 0;
    let newSlot = false;
    if (rosterSignature !== renderer._gpuAgentAtlasRosterSignature) {
        slots.clear();
        roster.forEach((id, index) => slots.set(`agent:${id}`, index));
        nextSlot = roster.length;
        renderer._gpuAgentAtlasRosterSignature = rosterSignature;
        renderer._gpuAgentAtlasFrameKeys?.clear?.();
        newSlot = true;
    }
    for (const record of agentRecords) {
        if (slots.has(record.id)) continue;
        slots.set(record.id, nextSlot++);
        newSlot = true;
    }
    renderer._gpuAgentAtlasNextSlot = nextSlot;
    let atlas = renderer._gpuAgentFrameAtlas;
    let resized = false;
    if (!atlas || atlas.width !== width || atlas.height !== height) {
        atlas = document.createElement('canvas');
        atlas.width = width;
        atlas.height = height;
        renderer._gpuAgentFrameAtlas = atlas;
        renderer._gpuAgentFrameAtlasSignature = '';
        renderer._gpuAgentFrameAtlasRevision = 0;
        renderer._gpuAgentAtlasFrameKeys = new Map();
        resized = true;
    }
    const frameKeys = renderer._gpuAgentAtlasFrameKeys ||= new Map();
    const desiredKeys = agentRecords.map(record => [
        record.id,
        record.textureKey,
        record.sx,
        record.sy,
        record.sw,
        record.sh,
        record.textureRevision,
    ].join(':'));
    const changed = resized || newSlot || agentRecords.some((record, index) => (
        frameKeys.get(record.id) !== desiredKeys[index]
    ));
    const missingFrame = agentRecords.some(record => !frameKeys.has(record.id));
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const cadenceElapsed = now - (renderer._gpuAgentAtlasUpdatedAt || 0) >= 125;
    if (changed && (resized || newSlot || missingFrame || cadenceElapsed)) {
        const ctx = atlas.getContext('2d', { alpha: true });
        ctx.imageSmoothingEnabled = false;
        for (let index = 0; index < agentRecords.length; index++) {
            const record = agentRecords[index];
            if (!resized && frameKeys.get(record.id) === desiredKeys[index]) continue;
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
        }
        renderer._gpuAgentFrameAtlasSignature = desiredKeys.slice().sort().join('|');
        renderer._gpuAgentFrameAtlasRevision++;
        renderer._gpuAgentAtlasUpdatedAt = now;
    }
    for (const record of agentRecords) {
        const slot = slots.get(record.id) || 0;
        record.source = atlas;
        record.sourceWidth = width;
        record.sourceHeight = height;
        record.sx = (slot % columns) * cell;
        record.sy = Math.floor(slot / columns) * cell;
        record.textureKey = 'agent-frame-atlas';
        record.textureRevision = renderer._gpuAgentFrameAtlasRevision;
        // Per-agent sidecars cannot be sampled after frame packing; semantic
        // material/elevation/emissive defaults stay on the record itself.
        record.materialSource = null;
        record.emissiveSource = null;
        record.sidecarKey = '';
    }
    return records;
}

export function buildGpuWorldRecords(renderer, { drawables = [] } = {}) {
    const records = [];
    const terrain = recordForTerrain(renderer);
    if (terrain) records.push(terrain);
    let sequence = 0;
    for (const drawable of drawables || []) {
        let next = null;
        if (drawable.kind?.startsWith?.('building')) {
            next = recordForBuilding(renderer, drawable.payload || drawable, sequence);
        } else if (drawable.kind?.startsWith?.('prop')) {
            next = recordForProp(renderer, drawable, sequence);
        } else if (drawable.kind === 'agent') {
            records.push(...recordsForAgent(drawable, sequence));
        } else if (typeof drawable.buildGpuRecord === 'function') {
            next = drawable.buildGpuRecord({ renderer, sequence });
        } else if (typeof drawable.payload?.buildGpuRecord === 'function') {
            next = drawable.payload.buildGpuRecord({ renderer, drawable, sequence });
        }
        if (Array.isArray(next)) records.push(...next);
        else if (next) records.push(next);
        sequence++;
    }
    packAgentFrameAtlas(renderer, records);
    const terrainRecords = records.filter(record => record.id === 'terrain:static');
    const groundRecords = records.filter(record => String(record.id || '').startsWith('ground:'));
    const sceneRecords = records.filter(record => (
        record.id !== 'terrain:static' && !String(record.id || '').startsWith('ground:')
    ));
    return [...terrainRecords, ...groundRecords, ...sceneRecords];
}

export function gpuMaterialNameForBuilding(type) {
    return MATERIAL_BY_BUILDING[type] || 'stone';
}

export function gpuMaterialNameForProp(sprite) {
    return materialForProp(sprite);
}
