import {
    MATERIAL_CLASS_IDS,
    materialClassId as registryMaterialClassId,
} from '../MaterialRegistry.js';

export const GPU_WORLD_RENDERER_MODES = Object.freeze({
    WEBGL: 'webgl',
    CANVAS: 'canvas',
});

// Compatibility aliases stay public for focused renderer tests, while the
// manifest/tooling registry is the single numeric authority.
export const GPU_MATERIAL_CLASSES = Object.freeze({
    ...MATERIAL_CLASS_IDS,
    default: MATERIAL_CLASS_IDS.unlit,
    rune: MATERIAL_CLASS_IDS['glass-rune'],
});

const VALID_MODES = new Set(Object.values(GPU_WORLD_RENDERER_MODES));

function finite(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

export function resolveGpuWorldRendererMode(search = '', { webgl2 = true } = {}) {
    const params = search instanceof URLSearchParams
        ? search
        : new URLSearchParams(String(search || '').replace(/^\?/, ''));
    const requested = String(params.get('renderer') || '').trim().toLowerCase();
    if (requested === GPU_WORLD_RENDERER_MODES.CANVAS) return GPU_WORLD_RENDERER_MODES.CANVAS;
    if (requested === GPU_WORLD_RENDERER_MODES.WEBGL) {
        return webgl2 ? GPU_WORLD_RENDERER_MODES.WEBGL : GPU_WORLD_RENDERER_MODES.CANVAS;
    }
    return webgl2 ? GPU_WORLD_RENDERER_MODES.WEBGL : GPU_WORLD_RENDERER_MODES.CANVAS;
}

export function materialClassId(value) {
    if (Number.isFinite(Number(value))) {
        return Math.max(0, Math.min(255, Math.round(Number(value))));
    }
    return registryMaterialClassId(value);
}

export function normalizeGpuRecord(record = {}, sequence = 0) {
    const source = record.source || record.image || null;
    const sourceWidth = Math.max(1, finite(record.sourceWidth, source?.width || 1));
    const sourceHeight = Math.max(1, finite(record.sourceHeight, source?.height || 1));
    const sx = finite(record.sx, 0);
    const sy = finite(record.sy, 0);
    const sw = Math.max(0, finite(record.sw, sourceWidth));
    const sh = Math.max(0, finite(record.sh, sourceHeight));
    const width = Math.max(0, finite(record.width ?? record.w, sw));
    const height = Math.max(0, finite(record.height ?? record.h, sh));
    const alpha = Math.max(0, Math.min(1, finite(record.alpha, 1)));
    const elevation = Math.max(0, Math.min(1, finite(record.elevation, 0)));
    const emissive = Math.max(0, Math.min(2, finite(record.emissive, 0)));
    const occluder = Math.max(0, Math.min(1, finite(record.occluder, 0)));
    const blend = record.blend === 'add' ? 'add' : 'normal';
    const textureKey = String(record.textureKey || record.stableKey || record.id || `texture:${sequence}`);
    const sidecarKey = String(record.sidecarKey || record.materialSidecarKey || '');
    return {
        ...record,
        source,
        materialSource: record.materialSource || record.sidecar || null,
        textureKey,
        sidecarKey,
        sourceWidth,
        sourceHeight,
        sx,
        sy,
        sw,
        sh,
        x: finite(record.x),
        y: finite(record.y),
        width,
        height,
        alpha,
        elevation,
        emissive,
        occluder,
        material: materialClassId(record.material ?? record.materialId),
        blend,
        sequence: finite(record.sequence, sequence),
        textureRevision: record.textureRevision ?? null,
        sidecarRevision: record.sidecarRevision ?? null,
    };
}

export function validGpuRecord(record) {
    return Boolean(
        record?.source
        && record.sw > 0
        && record.sh > 0
        && record.width > 0
        && record.height > 0
        && Number.isFinite(record.x)
        && Number.isFinite(record.y),
    );
}

export function buildStableGpuBatches(records = []) {
    const normalized = records
        .map((record, index) => normalizeGpuRecord(record, index))
        .filter(validGpuRecord);
    const batches = [];
    let current = null;
    for (const record of normalized) {
        const batchKey = [
            record.textureKey,
            record.sidecarKey,
            record.blend,
        ].join('|');
        if (!current || current.key !== batchKey || current.source !== record.source
            || current.materialSource !== record.materialSource) {
            current = {
                key: batchKey,
                source: record.source,
                materialSource: record.materialSource,
                textureKey: record.textureKey,
                sidecarKey: record.sidecarKey,
                blend: record.blend,
                records: [],
            };
            batches.push(current);
        }
        current.records.push(record);
    }
    return batches;
}

export function estimateGpuWorldTextureBytes({
    width = 0,
    height = 0,
    bloomScale = 0.5,
    occlusionScale = 0.5,
    cachedTextures = [],
} = {}) {
    const w = Math.max(0, Math.floor(finite(width)));
    const h = Math.max(0, Math.floor(finite(height)));
    const bloomW = Math.max(0, Math.floor(w * Math.max(0, finite(bloomScale, 0.5))));
    const bloomH = Math.max(0, Math.floor(h * Math.max(0, finite(bloomScale, 0.5))));
    const occW = Math.max(0, Math.floor(w * Math.max(0, finite(occlusionScale, 0.5))));
    const occH = Math.max(0, Math.floor(h * Math.max(0, finite(occlusionScale, 0.5))));
    const targets = (w * h + bloomW * bloomH * 2 + occW * occH) * 4;
    let textures = 0;
    for (const texture of cachedTextures || []) {
        const tw = Math.max(0, Math.floor(finite(texture?.width)));
        const th = Math.max(0, Math.floor(finite(texture?.height)));
        const copies = Math.max(1, Math.floor(finite(texture?.copies, 1)));
        textures += tw * th * 4 * copies;
    }
    return { targets, textures, total: targets + textures };
}

export function clampGpuLights(lights = [], limit = 16) {
    const cap = Math.max(0, Math.floor(finite(limit, 16)));
    return (lights || [])
        .filter(light => Number.isFinite(Number(light?.x)) && Number.isFinite(Number(light?.y)))
        .sort((a, b) => (
            finite(b.priority, 0) - finite(a.priority, 0)
            || finite(b.intensity, 1) - finite(a.intensity, 1)
            || String(a.id || '').localeCompare(String(b.id || ''))
        ))
        .slice(0, cap);
}

export function emissivePhaseForAmbientLight(ambientLight = 1) {
    const ambient = Math.max(0, Math.min(1, finite(ambientLight, 1)));
    return 0.12 + 0.88 * (1 - ambient);
}

/**
 * Local point lights are a darkness response, not a second daytime sun.
 * Beacon intensity already folds in dusk warmth and weather dimming, while
 * inverse ambient light is the stable fallback for older atmosphere feeds.
 */
export function localLightPhaseForLighting(lighting = {}) {
    const ambient = Math.max(0, Math.min(1, finite(lighting?.ambientLight, 1)));
    const beacon = Math.max(0, Math.min(1, finite(lighting?.beaconIntensity, 0)));
    return Math.max(1 - ambient, beacon);
}
