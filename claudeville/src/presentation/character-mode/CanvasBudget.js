// Pixel-art invariant: the browser may only ever scale a canvas backing store
// to the display by an exact integer factor. `image-rendering: pixelated`
// then replicates pixels instead of resampling them, so authored art and
// canvas text keep hard edges. Any fractional factor shreds the 1px strokes
// of a pixel font — that was the "blurry/unreadable on a big screen" report.
//
// So the backing DPR is always `deviceDpr / n` for an integer n: one backing
// pixel covers exactly n x n device pixels, whatever the device ratio is
// (2 on Retina, 2.5 at 125% browser zoom, 1 elsewhere). n only grows when the
// viewport would otherwise blow the per-surface pixel budget, and a coarser
// rung stays pixel-exact — it never resamples, it just gets chunkier.
const MIN_BACKING_DPR = 0.25;
// Screen-surface equivalents that scale with the backing DPR: the visible 2D
// canvas, the UI overlay, the WebGL drawing buffer, the two full-resolution
// GPU scene attachments, and headroom for the PostFX/atmosphere surfaces. The
// sky and trail caches are deliberately excluded — the sky cache is pinned at
// CSS resolution (SkyRenderer._skyCacheDpr) and the trail cache is world-space.
const SCREEN_SURFACE_COUNT = 7;
// Per screen-surface backing ceiling, the one knob that decides the rung.
// 7.5M backing px keeps native device resolution through ~1.87M CSS px, which
// covers every built-in MacBook display and the 1440p range; 5K/6K viewports
// drop to the next integer rung instead of quadrupling into ~350MB.
const MAX_MAIN_CANVAS_PIXELS = 7_500_000;
const WORLD_CACHE_PIXEL_RESERVE = 7_000_000;
const LIGHT_CACHE_PIXEL_RESERVE = 1_250_000;
const AUX_CACHE_PIXEL_RESERVE = 250_000;
const BYTES_PER_RGBA_PIXEL = 4;
const MAX_RENDERER_CANVAS_PIXELS = MAX_MAIN_CANVAS_PIXELS * SCREEN_SURFACE_COUNT
    + WORLD_CACHE_PIXEL_RESERVE + LIGHT_CACHE_PIXEL_RESERVE + AUX_CACHE_PIXEL_RESERVE;
// Native-Retina GPU cost measured at 1488x946 CSS: ~42.5MB of cached source
// textures plus ~54.5MB of full-resolution scene attachments.
const MAX_GPU_RESOURCE_BYTES = 128 * 1024 * 1024;

export const CANVAS_BUDGET = Object.freeze({
    maxRendererCanvasPixels: MAX_RENDERER_CANVAS_PIXELS,
    maxMainCanvasPixels: MAX_MAIN_CANVAS_PIXELS,
    maxScreenCachePixels: MAX_MAIN_CANVAS_PIXELS,
    maxWorldCachePixels: WORLD_CACHE_PIXEL_RESERVE,
    maxLightCachePixels: LIGHT_CACHE_PIXEL_RESERVE,
    // Persisted trails are cached once in world space. The current 40x40 map
    // projects to roughly 3.3M pixels, leaving margin without allowing a future
    // map expansion to create an unbounded backing store.
    maxTrailCachePixels: 4_000_000,
    maxGpuResourceBytes: MAX_GPU_RESOURCE_BYTES,
    // One accounting ceiling for Canvas backing stores plus GPU-owned textures,
    // attachments, and buffers. This is diagnostic policy, not an allocator.
    maxUnifiedRendererBytes: MAX_RENDERER_CANVAS_PIXELS * BYTES_PER_RGBA_PIXEL + MAX_GPU_RESOURCE_BYTES,
});

export const RENDERER_RESOURCE_BYTES_PER_PIXEL = BYTES_PER_RGBA_PIXEL;

// Largest `deviceDpr / n` rung whose backing store fits the per-surface budget.
// `requestedDpr` is never clamped from above: capping it would make the
// backing-to-display ratio fractional again on a hypothetical >4x display,
// which is exactly the artefact this ladder exists to prevent. Oversized
// viewports are handled by growing `n`, not by capping the device ratio.
//
// `MIN_BACKING_DPR` is a hard floor, not a budget rung: a viewport would need
// ~120M CSS pixels to reach it, and rendering the village below quarter
// resolution is worse than exceeding a diagnostic ceiling.
export function effectiveCanvasDpr(cssWidth, cssHeight, requestedDpr = 1) {
    const width = Math.max(1, Number(cssWidth) || 1);
    const height = Math.max(1, Number(cssHeight) || 1);
    const cssPixels = width * height;
    const reported = Number(requestedDpr);
    const device = Number.isFinite(reported) && reported > 0
        ? Math.max(MIN_BACKING_DPR, reported)
        : 1;
    const screenBudget = Math.max(
        1,
        CANVAS_BUDGET.maxRendererCanvasPixels -
            CANVAS_BUDGET.maxWorldCachePixels -
            CANVAS_BUDGET.maxLightCachePixels -
            AUX_CACHE_PIXEL_RESERVE,
    );
    const perSurfacePixels = Math.min(
        CANVAS_BUDGET.maxMainCanvasPixels,
        screenBudget / SCREEN_SURFACE_COUNT,
    );
    let dpr = device;
    for (let divisor = 1; ; divisor++) {
        const candidate = device / divisor;
        if (candidate < MIN_BACKING_DPR) break;
        dpr = candidate;
        if (cssPixels * candidate * candidate <= perSurfacePixels) break;
    }
    return dpr;
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
