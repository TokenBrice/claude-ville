const MIN_BACKING_DPR = 0.25;
const MAX_DEVICE_DPR = 1;
// Plan 1.9 — pixel-uniform scaling, revised: snapping the backing DPR to an
// integer 1/dpr step only happens when it is nearly free. The original
// floor-only snap made every viewport above the main-canvas budget drop from
// near-native resolution to 0.5, and the browser then upscaled the canvas 2x
// with nearest-neighbor. Users read that as "pixelated". So: snap only when
// the step keeps at least KEEP_RATIO of the budget-capped resolution;
// otherwise keep the fractional capped value.
const DPR_STEPS = Object.freeze([MAX_DEVICE_DPR, 0.5, MIN_BACKING_DPR]);
const QUANTIZE_KEEP_RATIO = 0.85;
// Visible scene, PostFX, UI overlay, sky cache, trail cache, atmosphere cache.
const SCREEN_SURFACE_COUNT = 6;
const WORLD_CACHE_PIXEL_RESERVE = 7_000_000;
const LIGHT_CACHE_PIXEL_RESERVE = 1_250_000;
const AUX_CACHE_PIXEL_RESERVE = 250_000;
const BYTES_PER_RGBA_PIXEL = 4;
const MAX_GPU_RESOURCE_BYTES = 64 * 1024 * 1024;

export const CANVAS_BUDGET = Object.freeze({
    maxRendererCanvasPixels: 25_000_000,
    // Keep the visible world at native resolution through the common 1080p
    // desktop range. Above this, the aggregate cache budget still scales the
    // renderer down progressively instead of risking an abrupt memory spike.
    maxMainCanvasPixels: 2_000_000,
    maxScreenCachePixels: 8_500_000,
    maxWorldCachePixels: WORLD_CACHE_PIXEL_RESERVE,
    maxLightCachePixels: LIGHT_CACHE_PIXEL_RESERVE,
    // Persisted trails are cached once in world space. The current 40x40 map
    // projects to roughly 3.3M pixels, leaving margin without allowing a future
    // map expansion to create an unbounded backing store.
    maxTrailCachePixels: 4_000_000,
    maxGpuResourceBytes: MAX_GPU_RESOURCE_BYTES,
    // One accounting ceiling for Canvas backing stores plus GPU-owned textures,
    // attachments, and buffers. This is diagnostic policy, not an allocator.
    maxUnifiedRendererBytes: 25_000_000 * BYTES_PER_RGBA_PIXEL + MAX_GPU_RESOURCE_BYTES,
});

export const RENDERER_RESOURCE_BYTES_PER_PIXEL = BYTES_PER_RGBA_PIXEL;

export function effectiveCanvasDpr(cssWidth, cssHeight, requestedDpr = 1) {
    const width = Math.max(1, Number(cssWidth) || 1);
    const height = Math.max(1, Number(cssHeight) || 1);
    const cssPixels = width * height;
    const requested = Math.max(MIN_BACKING_DPR, Math.min(Number(requestedDpr) || 1, MAX_DEVICE_DPR));
    const mainCapDpr = Math.sqrt(CANVAS_BUDGET.maxMainCanvasPixels / cssPixels);
    const screenBudget = Math.max(
        1,
        CANVAS_BUDGET.maxRendererCanvasPixels -
            CANVAS_BUDGET.maxWorldCachePixels -
            CANVAS_BUDGET.maxLightCachePixels -
            AUX_CACHE_PIXEL_RESERVE,
    );
    const combinedCapDpr = Math.sqrt(screenBudget / (cssPixels * SCREEN_SURFACE_COUNT));
    const capped = Math.max(MIN_BACKING_DPR, Math.min(requested, mainCapDpr, combinedCapDpr));
    return quantizeDpr(capped);
}

// Snap to the largest DPR step not above `dpr`, but only when that step keeps
// at least QUANTIZE_KEEP_RATIO of the capped resolution (a hair of float
// tolerance for exact-boundary viewports). Otherwise return the capped value
// unchanged — sharpness beats uniformity once the upscale factor is small.
function quantizeDpr(dpr) {
    for (const step of DPR_STEPS) {
        if (dpr >= step - 1e-6) {
            return step >= dpr * QUANTIZE_KEEP_RATIO ? step : dpr;
        }
    }
    return MIN_BACKING_DPR;
}

export function releaseCanvasBackingStore(canvas) {
    if (!canvas) return;
    const backingCanvas = canvas.canvas || canvas;
    try {
        backingCanvas.width = 0;
        backingCanvas.height = 0;
    } catch {
        // Some browser-owned canvases may reject resizing during teardown.
    }
}

export function canvasPixelCount(canvas) {
    if (!canvas) return 0;
    const backingCanvas = canvas.canvas || canvas;
    const width = Number(backingCanvas.width) || 0;
    const height = Number(backingCanvas.height) || 0;
    return Math.max(0, width * height);
}

export function canvasByteCount(canvas, bytesPerPixel = BYTES_PER_RGBA_PIXEL) {
    return canvasPixelCount(canvas) * Math.max(0, Number(bytesPerPixel) || 0);
}

function normalizedResourceGroup(group = {}) {
    const out = {};
    if (!group || typeof group !== 'object') return out;
    for (const [name, value] of Object.entries(group)) {
        const bytes = Number(value);
        out[name] = Number.isFinite(bytes) && bytes > 0 ? Math.round(bytes) : 0;
    }
    return out;
}

/**
 * Build one byte ledger for renderer-owned GPU resources. Callers keep named
 * leaves (rather than an opaque total) so future attachments cannot silently
 * escape diagnostics or be double-counted.
 */
export function gpuResourceAccounting({ textures = {}, attachments = {}, buffers = {} } = {}) {
    const groups = {
        textures: normalizedResourceGroup(textures),
        attachments: normalizedResourceGroup(attachments),
        buffers: normalizedResourceGroup(buffers),
    };
    const groupTotals = Object.fromEntries(Object.entries(groups).map(([name, values]) => [
        name,
        Object.values(values).reduce((sum, bytes) => sum + bytes, 0),
    ]));
    return {
        ...groups,
        groupTotals,
        totalBytes: Object.values(groupTotals).reduce((sum, bytes) => sum + bytes, 0),
    };
}

/**
 * Combine Canvas pixels and the GPU byte ledger without assuming every future
 * resource is RGBA8. The returned breakdown is suitable for perf captures.
 */
export function unifiedRendererResourceAccounting({
    visibleCanvasPixels = 0,
    volatileCanvasPixels = 0,
    retainedCanvasPixels = 0,
    gpu = null,
} = {}) {
    const canvas = {
        visible: Math.max(0, Math.round(Number(visibleCanvasPixels) || 0)) * BYTES_PER_RGBA_PIXEL,
        volatile: Math.max(0, Math.round(Number(volatileCanvasPixels) || 0)) * BYTES_PER_RGBA_PIXEL,
        retained: Math.max(0, Math.round(Number(retainedCanvasPixels) || 0)) * BYTES_PER_RGBA_PIXEL,
    };
    const canvasBytes = Object.values(canvas).reduce((sum, bytes) => sum + bytes, 0);
    const gpuBytes = Math.max(0, Number(gpu?.totalBytes) || 0);
    return {
        canvas,
        canvasBytes,
        gpu: gpu || gpuResourceAccounting(),
        gpuBytes,
        totalBytes: canvasBytes + gpuBytes,
        budgetBytes: CANVAS_BUDGET.maxUnifiedRendererBytes,
    };
}

export function canvasMapPixelCount(map) {
    if (!map || typeof map.values !== 'function') return 0;
    let pixels = 0;
    for (const canvas of map.values()) pixels += canvasPixelCount(canvas);
    return pixels;
}

export function releaseCanvasMap(map) {
    if (!map || typeof map.values !== 'function') return;
    for (const canvas of map.values()) releaseCanvasBackingStore(canvas);
    map.clear();
}
