import { eventBus } from '../../domain/events/DomainEvent.js';
import { WORLD_BODY_FONT, WORLD_DISPLAY_FACE } from '../../config/theme.js';

// XP-5 — Postcards. `P` strikes one frame of the World as a PNG: the
// village with its weather, light and marks, and no chrome, speech, villager
// names, repo or project labels, or model words. Safe to share by
// construction, on two locks:
//   1. the postcard frame flag (`postcardFrame()`): WorldFrameRenderer drops
//      every label tier and each text-drawing site in the World stands down
//      (the per-site table and its static check: scripts/tests/postcard.test.mjs);
//   2. the text guard: while the frame draws, every 2D `fillText` /
//      `strokeText` is counted and dropped, so a text site the flag missed
//      paints nothing. The count is the test's evidence (it must stay 0).
// The frame is drawn and composited in one task (WebGL2 and WebGPU read back
// only inside the frame that drew them), then the live frame is drawn again
// in the same task, so the screen never shows the bare frame: no flash.

let active = false;

/** True only while a postcard frame draws. */
export function postcardFrame() {
    return active;
}

const TEXT_METHODS = ['fillText', 'strokeText'];

function textPrototypes() {
    return [globalThis.CanvasRenderingContext2D, globalThis.OffscreenCanvasRenderingContext2D]
        .map(type => type?.prototype)
        .filter(Boolean);
}

/**
 * Run `draw` as a postcard frame: the flag is up and every 2D text call is
 * dropped and counted. `trace` (tests) also keeps each dropped call's
 * caller frame. Returns `{ result, textCalls, textSites }`.
 */
export function withPostcardFrame(draw, { trace = false } = {}) {
    const restore = [];
    const guard = { textCalls: 0, textSites: trace ? [] : null };
    for (const proto of textPrototypes()) {
        for (const method of TEXT_METHODS) {
            const original = proto[method];
            restore.push(() => { proto[method] = original; });
            proto[method] = function postcardTextGuard() {
                guard.textCalls += 1;
                if (guard.textSites) guard.textSites.push(String(new Error().stack).split('\n')[2]?.trim() || '?');
            };
        }
    }
    active = true;
    try {
        const result = draw();
        return { result, textCalls: guard.textCalls, textSites: guard.textSites };
    } finally {
        active = false;
        for (const undo of restore) undo();
    }
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad2 = n => String(n).padStart(2, '0');

/** `ClaudeVille · 19 Nov · 15:25 dusk · 10 villagers` (local time). */
export function postcardCaption({ date, phase = null, villagers = 0 } = {}) {
    const parts = ['ClaudeVille'];
    if (date instanceof Date && !Number.isNaN(date.getTime())) {
        parts.push(`${date.getDate()} ${MONTHS[date.getMonth()]}`);
        parts.push(`${pad2(date.getHours())}:${pad2(date.getMinutes())}${phase ? ` ${phase}` : ''}`);
    }
    const count = Math.max(0, Math.floor(Number(villagers) || 0));
    parts.push(`${count} ${count === 1 ? 'villager' : 'villagers'}`);
    return parts.join(' · ');
}

/** `claudeville-2026-11-19-1525.png` (local time). */
export function postcardFileName(date = new Date()) {
    return `claudeville-${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}-${pad2(date.getHours())}${pad2(date.getMinutes())}.png`;
}

export const POSTCARD_ASPECTS = Object.freeze(['full', '16:9', '4:3', '1:1']);
export const POSTCARD_BORDERS = Object.freeze(['clean', 'woodcut']);
export const WOODCUT_MAT_PX = 8;
export const LIVING_POSTCARD_DURATION_MS = 6000;
export const LIVING_POSTCARD_FPS = 30;

const ASPECT_RATIO_PAIRS = Object.freeze({
    '16:9': Object.freeze([16, 9]),
    '4:3': Object.freeze([4, 3]),
    '1:1': Object.freeze([1, 1]),
});

const LIVING_MIME_CANDIDATES = Object.freeze([
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm',
    'video/mp4',
]);

/** `claudeville-2026-11-19-1525.webm` (local time). */
export function livingPostcardFileName(date = new Date(), mimeType = 'video/webm') {
    const ext = /mp4/i.test(String(mimeType || '')) ? 'mp4' : 'webm';
    return `claudeville-${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}-${pad2(date.getHours())}${pad2(date.getMinutes())}.${ext}`;
}

/**
 * Centered integer pixel-snapped crop rect inside `width` x `height` for
 * `FULL` ('full'), '16:9', '4:3', or '1:1'.
 */
export function computePostcardCropRect(width, height, aspect = 'full') {
    const w = Math.max(0, Math.floor(Number(width) || 0));
    const h = Math.max(0, Math.floor(Number(height) || 0));
    const normalized = POSTCARD_ASPECTS.includes(aspect) ? aspect : 'full';
    if (!w || !h || normalized === 'full') {
        return { x: 0, y: 0, width: w, height: h, aspect: 'full' };
    }
    const [rw, rh] = ASPECT_RATIO_PAIRS[normalized];
    let cropW;
    let cropH;
    if (w * rh >= h * rw) {
        cropH = h;
        cropW = Math.min(w, Math.max(1, Math.round((h * rw) / rh)));
    } else {
        cropW = w;
        cropH = Math.min(h, Math.max(1, Math.round((w * rh) / rw)));
    }
    const x = Math.floor((w - cropW) / 2);
    const y = Math.floor((h - cropH) / 2);
    return { x, y, width: cropW, height: cropH, aspect: normalized };
}

// The caption band, in device pixels per whole `unit` (the backing scale,
// rounded): walnut under a 1 px brass rule, the caption in the World's body
// face. The band sits under the frame, so no world pixel is covered.
const BAND = Object.freeze({ height: 22, padX: 8, baseline: 15, font: 11 });
const BAND_INK = Object.freeze({ plate: '#1d1712', rule: '#b48a4a', text: '#eadfc8', mark: '#f6c85f' });
const MAT_INK = Object.freeze({
    seam: '#0b0908',
    lit: '#6e533a',
    rail: '#3a291c',
    groove: '#2c1f15',
    shade: '#241911',
    innerLip: '#5a4330',
    nailWell: '#15100d',
    nailBody: '#b8893f',
    nailGlint: '#f2c75c',
});

export function postcardBandHeight(unit = 1) {
    return BAND.height * Math.max(1, Math.round(unit));
}

export function postcardMatThickness(unit = 1) {
    return WOODCUT_MAT_PX * Math.max(1, Math.round(unit));
}

// 8 px walnut 9-slice frame with upper-left lighting and pixel corner nails.
function drawWoodcutMat(ctx, totalW, totalH, k) {
    const mat = WOODCUT_MAT_PX * k;
    // Outer walnut body
    ctx.fillStyle = MAT_INK.rail;
    ctx.fillRect(0, 0, totalW, mat);
    ctx.fillRect(0, totalH - mat, totalW, mat);
    ctx.fillRect(0, mat, mat, totalH - mat * 2);
    ctx.fillRect(totalW - mat, mat, mat, totalH - mat * 2);

    // Outer 1px black seam
    ctx.fillStyle = MAT_INK.seam;
    ctx.fillRect(0, 0, totalW, k);
    ctx.fillRect(0, totalH - k, totalW, k);
    ctx.fillRect(0, 0, k, totalH);
    ctx.fillRect(totalW - k, 0, k, totalH);

    // Outer 1px lit bevel (top/left) and shade (bottom/right)
    ctx.fillStyle = MAT_INK.lit;
    ctx.fillRect(k, k, totalW - k * 2, k);
    ctx.fillRect(k, k, k, totalH - k * 2);
    ctx.fillStyle = MAT_INK.shade;
    ctx.fillRect(k, totalH - k * 2, totalW - k * 2, k);
    ctx.fillRect(totalW - k * 2, k, k, totalH - k * 2);

    // Recessed mid-rail groove (4 px in)
    ctx.fillStyle = MAT_INK.groove;
    ctx.fillRect(4 * k, 4 * k, totalW - 8 * k, k);
    ctx.fillRect(4 * k, totalH - 5 * k, totalW - 8 * k, k);
    ctx.fillRect(4 * k, 4 * k, k, totalH - 8 * k);
    ctx.fillRect(totalW - 5 * k, 4 * k, k, totalH - 8 * k);

    // Inner recessed bevel around the picture window
    ctx.fillStyle = MAT_INK.shade;
    ctx.fillRect(mat - 2 * k, mat - 2 * k, totalW - (mat - 2 * k) * 2, k);
    ctx.fillRect(mat - 2 * k, mat - 2 * k, k, totalH - (mat - 2 * k) * 2);
    ctx.fillStyle = MAT_INK.innerLip;
    ctx.fillRect(mat - 2 * k, totalH - mat + k, totalW - (mat - 2 * k) * 2, k);
    ctx.fillRect(totalW - mat + k, mat - 2 * k, k, totalH - (mat - 2 * k) * 2);

    // Inner 1px black seam framing the picture + caption window
    ctx.fillStyle = MAT_INK.seam;
    ctx.fillRect(mat - k, mat - k, totalW - (mat - k) * 2, k);
    ctx.fillRect(mat - k, totalH - mat, totalW - (mat - k) * 2, k);
    ctx.fillRect(mat - k, mat - k, k, totalH - (mat - k) * 2);
    ctx.fillRect(totalW - mat, mat - k, k, totalH - (mat - k) * 2);

    // Four pixel corner nails centered in each 8x8 corner block
    const corners = [
        [3 * k, 3 * k],
        [totalW - 5 * k, 3 * k],
        [3 * k, totalH - 5 * k],
        [totalW - 5 * k, totalH - 5 * k],
    ];
    for (const [nx, ny] of corners) {
        ctx.fillStyle = MAT_INK.nailWell;
        ctx.fillRect(nx - k, ny - k, 4 * k, 4 * k);
        ctx.fillStyle = MAT_INK.nailBody;
        ctx.fillRect(nx, ny, 2 * k, 2 * k);
        ctx.fillStyle = MAT_INK.nailGlint;
        ctx.fillRect(nx, ny, k, k);
    }
}

/**
 * Composite `surfaces` (bottom first, each drawn 1:1 at the backing size) and
 * the caption band into one canvas `width` x (`height` + band), optionally
 * cropped to `crop` ('full' | '16:9' | '4:3' | '1:1') and framed with
 * `border` ('clean' | 'woodcut'). Integer scale: no surface is resampled.
 */
export function composePostcard({
    surfaces,
    width,
    height,
    caption,
    unit = 1,
    crop = 'full',
    border = 'clean',
    targetCanvas = null,
    documentRef = globalThis.document,
}) {
    const k = Math.max(1, Math.round(unit));
    const band = postcardBandHeight(k);
    const cropRect = computePostcardCropRect(width, height, crop);
    const isWoodcut = border === 'woodcut';
    const mat = isWoodcut ? postcardMatThickness(k) : 0;
    const totalW = cropRect.width + mat * 2;
    const totalH = cropRect.height + band + mat * 2;
    const canvas = targetCanvas || documentRef.createElement('canvas');
    if (canvas.width !== totalW) canvas.width = totalW;
    if (canvas.height !== totalH) canvas.height = totalH;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect?.(0, 0, totalW, totalH);
    if (isWoodcut) {
        drawWoodcutMat(ctx, totalW, totalH, k);
    }
    for (const surface of surfaces) {
        if (surface?.width && surface?.height) {
            ctx.drawImage(
                surface,
                cropRect.x,
                cropRect.y,
                cropRect.width,
                cropRect.height,
                mat,
                mat,
                cropRect.width,
                cropRect.height,
            );
        }
    }
    const bandY = mat + cropRect.height;
    ctx.fillStyle = BAND_INK.plate;
    ctx.fillRect(mat, bandY, cropRect.width, band);
    ctx.fillStyle = BAND_INK.rule;
    ctx.fillRect(mat, bandY, cropRect.width, k);
    ctx.fillStyle = BAND_INK.mark;
    ctx.fillRect(mat + BAND.padX * k, bandY + 7 * k, 2 * k, 8 * k);
    ctx.font = `${BAND.font * k}px ${WORLD_BODY_FONT}`;
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';
    ctx.fillStyle = BAND_INK.text;
    ctx.fillText(caption, mat + (BAND.padX + 6) * k, bandY + BAND.baseline * k);
    return canvas;
}

function canvasToBlob(canvas, mimeType = 'image/png') {
    return new Promise((resolve) => {
        if (typeof canvas?.toBlob !== 'function') {
            resolve(null);
            return;
        }
        canvas.toBlob((blob) => resolve(blob || null), mimeType);
    });
}

function saveBlob(blob, fileName, documentRef) {
    if (!blob || !documentRef?.createElement) return false;
    const url = URL.createObjectURL(blob);
    const link = documentRef.createElement('a');
    link.href = url;
    link.download = fileName;
    link.rel = 'noopener';
    if (link.style) link.style.display = 'none';
    documentRef.body?.appendChild?.(link);
    link.click?.();
    link.remove?.();
    const timer = setTimeout(() => URL.revokeObjectURL(url), 1000);
    timer?.unref?.();
    return true;
}

function saveCanvas(canvas, fileName, documentRef) {
    return canvasToBlob(canvas, 'image/png').then(blob => saveBlob(blob, fileName, documentRef));
}

/**
 * Copy a composed postcard canvas to the system clipboard as `image/png`.
 * Automatically falls back to saving the PNG on clipboard refusal or absence.
 */
export async function copyPostcardToClipboard(canvas, {
    clipboardRef = globalThis.navigator?.clipboard,
    ClipboardItemCtor = globalThis.ClipboardItem,
    fileName = postcardFileName(new Date()),
    documentRef = globalThis.document,
} = {}) {
    const blob = await canvasToBlob(canvas, 'image/png');
    if (!blob) {
        return {
            ok: false,
            method: 'error',
            reason: 'encode',
            fileName,
            message: 'Postcard unavailable · the image could not be encoded',
        };
    }
    const canClipboard = typeof clipboardRef?.write === 'function' && typeof ClipboardItemCtor === 'function';
    if (canClipboard) {
        try {
            const item = new ClipboardItemCtor({ 'image/png': blob });
            await clipboardRef.write([item]);
            return {
                ok: true,
                method: 'clipboard',
                fileName,
                message: 'Postcard copied to clipboard',
            };
        } catch {
            // Fall through to PNG save fallback.
        }
    }
    const saved = saveBlob(blob, fileName, documentRef);
    if (!saved) {
        return {
            ok: false,
            method: 'save-fallback',
            reason: 'save-failed',
            fileName,
            message: 'Clipboard unavailable and PNG download failed',
        };
    }
    return {
        ok: true,
        method: 'save-fallback',
        reason: canClipboard ? 'clipboard-denied' : 'clipboard-unsupported',
        fileName,
        message: `Clipboard unavailable · saved ${fileName} instead`,
    };
}

/** Choose the first supported MediaRecorder MIME type for a 6s Living Postcard. */
export function selectLivingPostcardMimeType(MediaRecorderCtor = globalThis.MediaRecorder) {
    if (typeof MediaRecorderCtor !== 'function') return null;
    if (typeof MediaRecorderCtor.isTypeSupported !== 'function') return 'video/webm';
    for (const mime of LIVING_MIME_CANDIDATES) {
        try {
            if (MediaRecorderCtor.isTypeSupported(mime)) return mime;
        } catch { /* ignore probe failure */ }
    }
    return null;
}

function snapshotSurface(surface, width, height, documentRef) {
    const canvas = documentRef.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    canvas.getContext('2d').drawImage(surface, 0, 0, width, height, 0, 0, width, height);
    return canvas;
}

// The WebGPU world's presented texture as a canvas, from the RGBA texels
// `debugCaptureTargets` copied out in the frame's task (premultiplied, the
// canvas's alpha mode; an HDR target as floats, clamped to SDR as its
// readout surface is).
function canvasFromTexels(texels, width, height, colorSpace, documentRef) {
    const float = texels instanceof Float32Array;
    const data = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < data.length; i += 4) {
        const a = float ? Math.min(1, Math.max(0, texels[i + 3])) : texels[i + 3] / 255;
        if (!(a > 0)) continue;
        for (let c = 0; c < 3; c++) {
            const v = float ? texels[i + c] : texels[i + c] / 255;
            data[i + c] = Math.round(Math.min(1, Math.max(0, v / a)) * 255);
        }
        data[i + 3] = Math.round(a * 255);
    }
    const canvas = documentRef.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const space = colorSpace === 'display-p3' ? 'display-p3' : 'srgb';
    canvas.getContext('2d', { colorSpace: space }).putImageData(new ImageData(data, width, height, { colorSpace: space }), 0, 0);
    return canvas;
}

async function capturePostcardFrameLayers(renderer, { trace = false, restoreLive = true, documentRef = globalThis.document } = {}) {
    const world = renderer?.canvas;
    const width = world?.width || 0;
    const height = world?.height || 0;
    let layers = null;
    let textCalls = 0;
    let textSites = null;
    // Both same-task frames redraw the presented pose: a moving GPU view
    // keeps its latched offset instead of snapping to the rounded one.
    const camera = renderer?.camera || null;
    if (camera) camera.gpuLatchHeld = true;
    try {
        if (width && height && typeof renderer.renderNow === 'function') {
            ({ result: layers, textCalls, textSites } = withPostcardFrame(() => {
                if (!renderer.renderNow()) return null;
                // The caption reads the frame just drawn, before any await: a
                // replay tick or a session update may land before the readback.
                const atmosphere = renderer._lastAtmosphere || null;
                const caption = postcardCaption({
                    date: atmosphere?.effectiveDate || new Date(renderer._atmosphereClockMs ?? Date.now()),
                    phase: atmosphere?.phase || null,
                    villagers: renderer.agentSprites?.size || 0,
                });
                // In the frame's task: the WebGL2 drawing buffer is still
                // readable through drawImage; the WebGPU canvas texture is
                // copied out to a buffer here (a 2D drawImage of a WebGPU
                // canvas can read blank, headless always does) and mapped later.
                const gpu = renderer.gpuWorld;
                let fx = null;
                if (renderer.fxCanvas && renderer.fxCanvas.style?.display !== 'none') {
                    fx = gpu?.isActive?.() && typeof gpu.debugCaptureTargets === 'function'
                        ? gpu.debugCaptureTargets()
                        : snapshotSurface(renderer.fxCanvas, width, height, documentRef);
                }
                return {
                    world: snapshotSurface(world, width, height, documentRef),
                    fx,
                    overlay: renderer.overlayCanvas ? snapshotSurface(renderer.overlayCanvas, width, height, documentRef) : null,
                    colorSpace: gpu?.canvasColorSpace || 'srgb',
                    caption,
                };
            }, { trace }));
        }
        // The live frame, in the same task: labels and chrome are back before the
        // screen presents anything.
        if (restoreLive && width && height) renderer.renderNow?.();
    } finally {
        if (camera) camera.gpuLatchHeld = false;
    }
    let fx = layers?.fx || null;
    if (fx && typeof fx.then === 'function') {
        const targets = await fx.catch(() => null);
        fx = targets?.composite && targets.width === width && targets.height === height
            ? canvasFromTexels(targets.composite, width, height, layers.colorSpace, documentRef)
            : null;
        if (!fx) layers = null;
    }
    if (!layers) return { layers: null, width, height, textCalls, textSites };
    return {
        layers: { surfaces: [layers.world, fx, layers.overlay], caption: layers.caption },
        width,
        height,
        unit: world._claudeVilleDpr || globalThis.devicePixelRatio || 1,
        textCalls,
        textSites,
    };
}

/**
 * Strike a postcard of `renderer`'s current view. Draws the postcard frame
 * and snapshots the three World canvases in the same task, redraws the live
 * frame (still the same task: the screen only ever presents that one), then
 * composites, saves the PNG (unless `save` is false) and confirms once with
 * a static toast. Resolves `{ ok, reason?, canvas?, caption?, fileName?,
 * textCalls, textSites }`.
 */
export async function strikePostcard(renderer, {
    save = true,
    trace = false,
    crop = 'full',
    border = 'clean',
    documentRef = globalThis.document,
} = {}) {
    const captured = await capturePostcardFrameLayers(renderer, { trace, restoreLive: true, documentRef });
    const { layers, width, height, unit, textCalls, textSites } = captured;
    if (!layers) {
        eventBus.emit('postcard:status', { ok: false, message: 'Postcard unavailable · the World is not drawing' });
        return { ok: false, reason: 'not-drawn', textCalls, textSites };
    }
    const caption = layers.caption;
    const canvas = composePostcard({
        surfaces: layers.surfaces,
        width,
        height,
        caption,
        unit,
        crop,
        border,
        documentRef,
    });
    if (textCalls > 0) console.warn(`[Postcard] ${textCalls} text call(s) reached the postcard frame and were dropped`);
    const fileName = postcardFileName(new Date());
    if (save && !(await saveCanvas(canvas, fileName, documentRef))) {
        eventBus.emit('postcard:status', { ok: false, message: 'Postcard unavailable · the image could not be encoded' });
        return { ok: false, reason: 'encode', textCalls, textSites };
    }
    if (save) eventBus.emit('postcard:status', { ok: true, message: `Postcard saved · ${fileName}` });
    return { ok: true, canvas, caption, fileName, textCalls, textSites };
}

/**
 * Record a 6-second Living Postcard onto a dedicated compose canvas (never
 * capturing the live GPU canvas directly). Every frame draws inside
 * `withPostcardFrame` (asserting 0 text calls per frame), and the recording
 * aborts immediately if `hasActionNeeded?.()` returns true or an attention
 * event fires, cleaning up MediaRecorder and stream tracks.
 */
export async function recordLivingPostcard(renderer, {
    durationMs = LIVING_POSTCARD_DURATION_MS,
    fps = LIVING_POSTCARD_FPS,
    crop = 'full',
    border = 'clean',
    hasActionNeeded = null,
    onStatus = null,
    save = true,
    trace = false,
    documentRef = globalThis.document,
    MediaRecorderCtor = globalThis.MediaRecorder,
    eventTarget = eventBus,
    now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now()),
    scheduleFrame = null,
    cancelFrame = null,
    signal = null,
} = {}) {
    const targetDurationMs = Math.max(100, Number(durationMs) || LIVING_POSTCARD_DURATION_MS);
    const targetFps = Math.max(1, Math.min(60, Math.round(Number(fps) || LIVING_POSTCARD_FPS)));
    const frameIntervalMs = 1000 / targetFps;

    const emitStatus = (payload) => {
        try { onStatus?.(payload); } catch { /* status callback must not break cleanup */ }
    };

    if (hasActionNeeded?.()) {
        const message = 'Living postcard aborted · an agent needs attention';
        emitStatus({ state: 'aborted', reason: 'attention-needed', frames: 0, textCalls: 0, message });
        eventBus.emit('postcard:status', { ok: false, message });
        return { ok: false, aborted: true, reason: 'attention-needed', frames: 0, textCalls: 0, message };
    }

    if (signal?.aborted) {
        const message = 'Living postcard cancelled';
        emitStatus({ state: 'aborted', reason: 'cancelled', frames: 0, textCalls: 0, message });
        return { ok: false, aborted: true, reason: 'cancelled', frames: 0, textCalls: 0, message };
    }

    const mimeType = selectLivingPostcardMimeType(MediaRecorderCtor);
    if (!mimeType) {
        const message = 'Living postcard unavailable · MediaRecorder codec unsupported';
        emitStatus({ state: 'error', reason: 'unsupported-recorder', frames: 0, textCalls: 0, message });
        eventBus.emit('postcard:status', { ok: false, message });
        return { ok: false, aborted: false, reason: 'unsupported-recorder', frames: 0, textCalls: 0, message };
    }

    const first = await capturePostcardFrameLayers(renderer, { trace, restoreLive: false, documentRef });
    if (!first.layers) {
        renderer?.renderNow?.();
        const message = 'Living postcard unavailable · the World is not drawing';
        emitStatus({ state: 'error', reason: 'not-drawn', frames: 0, textCalls: first.textCalls, message });
        eventBus.emit('postcard:status', { ok: false, message });
        return { ok: false, aborted: false, reason: 'not-drawn', frames: 0, textCalls: first.textCalls, message };
    }

    // Dedicated compose canvas — NEVER the live GPU/world canvas.
    const composeCanvas = composePostcard({
        surfaces: first.layers.surfaces,
        width: first.width,
        height: first.height,
        caption: first.layers.caption,
        unit: first.unit,
        crop,
        border,
        documentRef,
    });

    if (typeof composeCanvas?.captureStream !== 'function') {
        renderer?.renderNow?.();
        const message = 'Living postcard unavailable · canvas captureStream unsupported';
        emitStatus({ state: 'error', reason: 'capture-stream-unsupported', frames: 1, textCalls: first.textCalls, message });
        eventBus.emit('postcard:status', { ok: false, message });
        return { ok: false, aborted: false, reason: 'capture-stream-unsupported', frames: 1, textCalls: first.textCalls, message };
    }

    let frames = 1;
    let totalTextCalls = first.textCalls;
    const perFrameTextCalls = [first.textCalls];
    let aborted = false;
    let abortReason = null;
    let finished = false;
    let pendingHandle = null;
    let recorder = null;
    let stream = null;
    const chunks = [];

    const stopTracks = () => {
        if (!stream) return;
        const activeStream = stream;
        stream = null;
        const tracks = typeof activeStream.getTracks === 'function' ? activeStream.getTracks() : [];
        for (const track of tracks) {
            try { track?.stop?.(); } catch { /* ignore */ }
        }
    };

    const scheduleNext = (cb) => {
        if (typeof scheduleFrame === 'function') return scheduleFrame(cb, frameIntervalMs);
        const id = setTimeout(cb, frameIntervalMs);
        id?.unref?.();
        return id;
    };

    const clearScheduled = (handle) => {
        if (handle === null || handle === undefined) return;
        if (typeof cancelFrame === 'function') {
            cancelFrame(handle);
        } else {
            clearTimeout(handle);
        }
    };

    let wakeStop = null;
    const stopRecorderSafely = () => {
        if (!recorder) return;
        try {
            if (recorder.state !== 'inactive') recorder.stop();
        } catch { /* ignore already-stopped recorder */ }
    };

    const triggerAbort = (reason) => {
        if (aborted || finished) return;
        aborted = true;
        abortReason = reason;
        clearScheduled(pendingHandle);
        pendingHandle = null;
        stopRecorderSafely();
        stopTracks();
        wakeStop?.();
    };

    const onAttentionEvent = () => triggerAbort('attention-needed');
    const onAbortSignal = () => triggerAbort('cancelled');

    const unsubAttention = typeof eventTarget?.on === 'function'
        ? eventTarget.on('attention:raised', onAttentionEvent)
        : null;
    const unsubDistress = typeof eventTarget?.on === 'function'
        ? eventTarget.on('distress:watchtower', onAttentionEvent)
        : null;
    signal?.addEventListener?.('abort', onAbortSignal, { once: true });

    const cleanupListeners = () => {
        if (typeof unsubAttention === 'function') unsubAttention();
        else eventTarget?.off?.('attention:raised', onAttentionEvent);
        if (typeof unsubDistress === 'function') unsubDistress();
        else eventTarget?.off?.('distress:watchtower', onAttentionEvent);
        signal?.removeEventListener?.('abort', onAbortSignal);
    };

    try {
        if (hasActionNeeded?.()) {
            triggerAbort('attention-needed');
        } else {
            stream = composeCanvas.captureStream(targetFps);
            recorder = new MediaRecorderCtor(stream, { mimeType });
            const stoppedPromise = new Promise((resolve) => {
                let settled = false;
                const finish = () => {
                    if (settled) return;
                    settled = true;
                    resolve();
                };
                wakeStop = finish;
                const handleData = (event) => {
                    if (event?.data && event.data.size !== 0) chunks.push(event.data);
                };
                if (typeof recorder.addEventListener === 'function') {
                    recorder.addEventListener('dataavailable', handleData);
                    recorder.addEventListener('stop', finish);
                    recorder.addEventListener('error', finish);
                } else {
                    recorder.ondataavailable = handleData;
                    recorder.onstop = finish;
                    recorder.onerror = finish;
                }
            });

            recorder.start?.();
            const startedAt = now();
            emitStatus({
                state: 'recording',
                elapsedMs: 0,
                durationMs: targetDurationMs,
                progress: 0,
                frames,
                message: `Recording living postcard… 0.0s / ${(targetDurationMs / 1000).toFixed(1)}s`,
            });

            await new Promise((resolveLoop) => {
                const tick = async () => {
                    pendingHandle = null;
                    if (aborted) {
                        resolveLoop();
                        return;
                    }
                    if (hasActionNeeded?.()) {
                        triggerAbort('attention-needed');
                        resolveLoop();
                        return;
                    }
                    const elapsedMs = Math.max(0, now() - startedAt);
                    if (elapsedMs >= targetDurationMs) {
                        resolveLoop();
                        return;
                    }
                    const frame = await capturePostcardFrameLayers(renderer, { trace, restoreLive: false, documentRef });
                    if (aborted || hasActionNeeded?.()) {
                        if (!aborted) triggerAbort('attention-needed');
                        resolveLoop();
                        return;
                    }
                    if (frame.layers) {
                        frames += 1;
                        totalTextCalls += frame.textCalls;
                        perFrameTextCalls.push(frame.textCalls);
                        composePostcard({
                            surfaces: frame.layers.surfaces,
                            width: frame.width,
                            height: frame.height,
                            caption: frame.layers.caption,
                            unit: frame.unit,
                            crop,
                            border,
                            targetCanvas: composeCanvas,
                            documentRef,
                        });
                    }
                    const afterElapsed = Math.max(0, now() - startedAt);
                    emitStatus({
                        state: 'recording',
                        elapsedMs: afterElapsed,
                        durationMs: targetDurationMs,
                        progress: Math.min(1, afterElapsed / targetDurationMs),
                        frames,
                        message: `Recording living postcard… ${(Math.min(afterElapsed, targetDurationMs) / 1000).toFixed(1)}s / ${(targetDurationMs / 1000).toFixed(1)}s`,
                    });
                    if (afterElapsed >= targetDurationMs) {
                        resolveLoop();
                        return;
                    }
                    pendingHandle = scheduleNext(tick);
                };
                pendingHandle = scheduleNext(tick);
            });

            if (!aborted && hasActionNeeded?.()) {
                triggerAbort('attention-needed');
            }

            if (!aborted) {
                finished = true;
                stopRecorderSafely();
                await stoppedPromise;
                stopTracks();
            }
        }
    } finally {
        clearScheduled(pendingHandle);
        pendingHandle = null;
        stopRecorderSafely();
        stopTracks();
        cleanupListeners();
        // Always restore the live view immediately after the loop ends or aborts.
        renderer?.renderNow?.();
    }

    if (aborted) {
        const message = abortReason === 'attention-needed'
            ? 'Living postcard aborted · an agent needs attention'
            : 'Living postcard cancelled';
        emitStatus({ state: 'aborted', reason: abortReason, frames, textCalls: totalTextCalls, message });
        eventBus.emit('postcard:status', { ok: false, message });
        return {
            ok: false,
            aborted: true,
            reason: abortReason,
            frames,
            textCalls: totalTextCalls,
            perFrameTextCalls,
            mimeType,
            fileName: null,
            message,
        };
    }

    if (totalTextCalls > 0) {
        console.warn(`[Postcard] ${totalTextCalls} text call(s) reached the living postcard frames and were dropped`);
    }
    const resolvedMime = recorder?.mimeType || mimeType;
    const blob = new Blob(chunks, { type: resolvedMime });
    const fileName = livingPostcardFileName(new Date(), resolvedMime);
    if (save && !saveBlob(blob, fileName, documentRef)) {
        const message = 'Living postcard unavailable · could not save video';
        emitStatus({ state: 'error', reason: 'save-failed', frames, textCalls: totalTextCalls, message });
        eventBus.emit('postcard:status', { ok: false, message });
        return {
            ok: false,
            aborted: false,
            reason: 'save-failed',
            frames,
            textCalls: totalTextCalls,
            perFrameTextCalls,
            mimeType: resolvedMime,
            fileName,
            message,
        };
    }
    const message = save ? `Living postcard saved · ${fileName}` : `Living postcard recorded · ${frames} frames`;
    emitStatus({ state: 'done', fileName, frames, textCalls: totalTextCalls, message });
    if (save) eventBus.emit('postcard:status', { ok: true, message });
    return {
        ok: true,
        aborted: false,
        blob,
        canvas: composeCanvas,
        mimeType: resolvedMime,
        fileName,
        frames,
        textCalls: totalTextCalls,
        perFrameTextCalls,
        durationMs: targetDurationMs,
        message,
    };
}
