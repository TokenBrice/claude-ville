import {
    MATERIAL_CLASS_IDS,
    materialClassId as registryMaterialClassId,
} from '../MaterialRegistry.js';

export const GPU_WORLD_RENDERER_MODES = Object.freeze({
    WEBGL: 'webgl',
    CANVAS: 'canvas',
});

// One authored grade contract for the direct GPU world, hybrid PostFx, and
// Canvas fallback. Normalized channels can be uploaded as uniforms directly;
// the Canvas path converts the same values to byte-space CSS colors.
export const WORLD_PHASE_GRADES = Object.freeze({
    day: Object.freeze({
        base: Object.freeze([1, 0.996, 0.98]),
        edge: Object.freeze([0.84, 0.88, 0.91]),
        edgeAlpha: 0.28,
        fog: Object.freeze([0.55, 0.68, 0.74]),
    }),
    night: Object.freeze({
        base: Object.freeze([0.50, 0.59, 0.77]),
        edge: Object.freeze([0.32, 0.42, 0.60]),
        edgeAlpha: 0.46,
        fog: Object.freeze([0.08, 0.12, 0.22]),
    }),
    dusk: Object.freeze({
        base: Object.freeze([0.93, 0.75, 0.62]),
        edge: Object.freeze([0.59, 0.38, 0.38]),
        edgeAlpha: 0.42,
        fog: Object.freeze([0.38, 0.29, 0.34]),
    }),
    dawn: Object.freeze({
        base: Object.freeze([0.89, 0.79, 0.78]),
        edge: Object.freeze([0.49, 0.46, 0.59]),
        edgeAlpha: 0.40,
        fog: Object.freeze([0.44, 0.46, 0.58]),
    }),
});

// Ambient sources currently use the registry default (0). Keeping attention
// in an explicit high band makes the operator signal stable if ambient source
// priorities grow later.
export const GPU_ATTENTION_LIGHT_PRIORITY = 1_000_000;

// Compatibility aliases stay public for focused renderer tests, while the
// manifest/tooling registry is the single numeric authority.
export const GPU_MATERIAL_CLASSES = Object.freeze({
    ...MATERIAL_CLASS_IDS,
    default: MATERIAL_CLASS_IDS.unlit,
    rune: MATERIAL_CLASS_IDS['glass-rune'],
});

const VALID_MODES = new Set(Object.values(GPU_WORLD_RENDERER_MODES));

// PostFxFeed and the direct GPU renderer share this slot shape. Colors stay in
// 0-255 byte space until the renderer stages normalized uniforms; keeping the
// conversion here prevents a string-vs-channel contract drift from silently
// replacing authored light colors with a fallback.
export const GPU_LIGHT_COLOR_ENCODING = 'rgb-255';

export function setGpuLightColor(slot, rgb = []) {
    if (!slot || !Array.isArray(rgb) || rgb.length < 3) return slot;
    slot.r = Math.max(0, Math.min(255, finite(rgb[0], 255)));
    slot.g = Math.max(0, Math.min(255, finite(rgb[1], 255)));
    slot.b = Math.max(0, Math.min(255, finite(rgb[2], 255)));
    return slot;
}

export function gpuLightColorForShader(light = {}, fallback = [1, 0.78, 0.42], target = null) {
    const output = target || new Array(3);
    const r = Number(light?.r);
    const g = Number(light?.g);
    const b = Number(light?.b);
    if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) {
        output[0] = fallback[0];
        output[1] = fallback[1];
        output[2] = fallback[2];
        return output;
    }
    output[0] = Math.max(0, Math.min(1, r / 255));
    output[1] = Math.max(0, Math.min(1, g / 255));
    output[2] = Math.max(0, Math.min(1, b / 255));
    return output;
}

export function createGpuTimingMetricsScratch() {
    return {
        cpu: {
            source: 'cpu-fallback',
            metrics: { uploadMs: 0, frameGapMs: 0, shaderCpuMs: 0 },
        },
        gpu: {
            source: 'gpu-timer',
            metrics: { uploadMs: 0, frameGapMs: 0, gpuMs: 0 },
        },
    };
}

export function selectGpuTimingMetrics({
    uploadMs = 0,
    shaderCpuMs = 0,
    gpuMs = null,
    gpuTimerSupported = false,
    frameGapMs = 0,
} = {}, scratch = null) {
    const useGpu = Boolean(
        gpuTimerSupported
        && gpuMs !== null
        && gpuMs !== undefined
        && Number.isFinite(Number(gpuMs)),
    );
    const result = scratch?.cpu && scratch?.gpu
        ? (useGpu ? scratch.gpu : scratch.cpu)
        : scratch || null;
    if (!result) {
        return {
            source: useGpu ? 'gpu-timer' : 'cpu-fallback',
            metrics: {
                uploadMs: Math.max(0, finite(uploadMs)),
                frameGapMs: Math.max(0, finite(frameGapMs)),
                ...(useGpu
                    ? { gpuMs: Math.max(0, finite(gpuMs)) }
                    : { shaderCpuMs: Math.max(0, finite(shaderCpuMs)) }),
            },
        };
    }
    const metrics = result.metrics ||= {};
    metrics.uploadMs = Math.max(0, finite(uploadMs));
    metrics.frameGapMs = Math.max(0, finite(frameGapMs));
    if (useGpu) {
        metrics.gpuMs = Math.max(0, finite(gpuMs));
        delete metrics.shaderCpuMs;
    } else {
        metrics.shaderCpuMs = Math.max(0, finite(shaderCpuMs));
        delete metrics.gpuMs;
    }
    result.source = useGpu ? 'gpu-timer' : 'cpu-fallback';
    return result;
}

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

export function normalizeGpuRecord(record = {}, sequence = 0, target = null) {
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
    const normalized = target || { ...record };
    if (target) Object.assign(normalized, record);
    normalized.source = source;
    normalized.materialSource = record.materialSource || record.sidecar || null;
    normalized.emissiveSource = record.emissiveSource || null;
    normalized.occluderSource = record.occluderSource || null;
    normalized.occluderTextureUpdates = record.occluderTextureUpdates || null;
    normalized.textureKey = textureKey;
    normalized.sidecarKey = sidecarKey;
    normalized.sourceWidth = sourceWidth;
    normalized.sourceHeight = sourceHeight;
    normalized.sx = sx;
    normalized.sy = sy;
    normalized.sw = sw;
    normalized.sh = sh;
    normalized.x = finite(record.x);
    normalized.y = finite(record.y);
    normalized.width = width;
    normalized.height = height;
    normalized.alpha = alpha;
    normalized.elevation = elevation;
    normalized.emissive = emissive;
    normalized.emissiveGate = Math.max(0, Math.min(1, finite(record.emissiveGate, 1)));
    normalized.occluder = occluder;
    normalized.material = materialClassId(record.material ?? record.materialId);
    normalized.blend = blend;
    normalized.sequence = finite(record.sequence, sequence);
    normalized.textureRevision = record.textureRevision ?? null;
    normalized.sidecarRevision = record.sidecarRevision ?? null;
    normalized.textureUpdates = record.textureUpdates ?? null;
    normalized.materialTextureUpdates = record.materialTextureUpdates ?? null;
    normalized.emissiveTextureUpdates = record.emissiveTextureUpdates ?? null;
    return normalized;
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

export function buildStableGpuBatches(records = [], batches = [], normalizedRecords = []) {
    let batchCount = 0;
    let current = null;
    for (let index = 0; index < records.length; index++) {
        const normalized = normalizedRecords[index] || (normalizedRecords[index] = {});
        const record = normalizeGpuRecord(records[index], index, normalized);
        if (!validGpuRecord(record)) continue;
        if (!current || current.textureKey !== record.textureKey
            || current.sidecarKey !== record.sidecarKey
            || current.blend !== record.blend
            || current.source !== record.source
            || current.materialSource !== record.materialSource
            || current.emissiveSource !== record.emissiveSource
            || current.occluderSource !== record.occluderSource) {
            current = batches[batchCount];
            if (!current) {
                current = { records: [] };
                batches[batchCount] = current;
            }
            if (current.textureKey !== record.textureKey
                || current.sidecarKey !== record.sidecarKey
                || current.blend !== record.blend) {
                current.key = `${record.textureKey}|${record.sidecarKey}|${record.blend}`;
            }
            current.source = record.source;
            current.materialSource = record.materialSource;
            current.emissiveSource = record.emissiveSource;
            current.occluderSource = record.occluderSource;
            current.textureKey = record.textureKey;
            current.sidecarKey = record.sidecarKey;
            current.blend = record.blend;
            current.records.length = 0;
            current.first = 0;
            current.count = 0;
            current.occlusionFirst = 0;
            current.occlusionCount = 0;
            current.occluderMax = 0;
            batchCount++;
        }
        current.records.push(record);
    }
    batches.length = batchCount;
    normalizedRecords.length = records.length;
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

function isAttentionLight(light) {
    return Boolean(light?.attention) || String(light?.id || '').startsWith('attention:');
}

export function clampGpuLights(lights = [], limit = 16, hardLimit = limit, cache = null) {
    const cap = Math.max(0, Math.floor(finite(limit, 16)));
    const hardCap = Math.max(cap, Math.floor(finite(hardLimit, cap)));
    const source = lights || [];
    const ranked = cache?.ranked || [];
    let unchanged = Boolean(cache && cache.source === source && cache.sourceLength === source.length);
    if (unchanged) {
        for (let index = 0; index < source.length; index++) {
            const light = source[index];
            const snapshot = cache.snapshots[index];
            if (!snapshot || snapshot.light !== light
                || snapshot.x !== light?.x || snapshot.y !== light?.y
                || snapshot.priority !== light?.priority || snapshot.intensity !== light?.intensity
                || snapshot.id !== light?.id || snapshot.attention !== light?.attention) {
                unchanged = false;
                break;
            }
        }
    }
    if (!unchanged) {
        ranked.length = 0;
        if (cache) cache.snapshots.length = source.length;
        for (let index = 0; index < source.length; index++) {
            const light = source[index];
            if (Number.isFinite(Number(light?.x)) && Number.isFinite(Number(light?.y))) ranked.push(light);
            if (cache) {
                const snapshot = cache.snapshots[index] || (cache.snapshots[index] = {});
                snapshot.light = light;
                snapshot.x = light?.x;
                snapshot.y = light?.y;
                snapshot.priority = light?.priority;
                snapshot.intensity = light?.intensity;
                snapshot.id = light?.id;
                snapshot.attention = light?.attention;
            }
        }
        ranked.sort((a, b) => (
            Number(isAttentionLight(b)) - Number(isAttentionLight(a))
            || finite(b.priority, 0) - finite(a.priority, 0)
            || finite(b.intensity, 1) - finite(a.intensity, 1)
            || String(a.id || '').localeCompare(String(b.id || ''))
        ));
        if (cache) {
            cache.source = source;
            cache.sourceLength = source.length;
        }
    }
    let protectedCount = 0;
    while (protectedCount < ranked.length && isAttentionLight(ranked[protectedCount])) protectedCount++;
    const admittedCount = Math.min(ranked.length, hardCap, Math.max(cap, protectedCount));
    if (!cache) return ranked.slice(0, admittedCount);
    const admitted = cache.admitted;
    admitted.length = admittedCount;
    for (let index = 0; index < admittedCount; index++) admitted[index] = ranked[index];
    return admitted;
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
