const MIN_BACKING_DPR = 0.25;
const MAX_DEVICE_DPR = 2;
const SCREEN_SURFACE_COUNT = 4; // visible canvas, sky cache, trail cache, atmosphere cache
const WORLD_CACHE_PIXEL_RESERVE = 7_000_000;
const LIGHT_CACHE_PIXEL_RESERVE = 1_250_000;
const AUX_CACHE_PIXEL_RESERVE = 250_000;

export const CANVAS_BUDGET = Object.freeze({
    maxRendererCanvasPixels: 25_000_000,
    maxMainCanvasPixels: 8_500_000,
    maxScreenCachePixels: 8_500_000,
    maxWorldCachePixels: WORLD_CACHE_PIXEL_RESERVE,
    maxLightCachePixels: LIGHT_CACHE_PIXEL_RESERVE,
});

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
    return Math.max(MIN_BACKING_DPR, Math.min(requested, mainCapDpr, combinedCapDpr));
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
