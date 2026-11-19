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

// The caption band, in device pixels per whole `unit` (the backing scale,
// rounded): walnut under a 1 px brass rule, the caption in the World's body
// face. The band sits under the frame, so no world pixel is covered.
const BAND = Object.freeze({ height: 22, padX: 8, baseline: 15, font: 11 });
const BAND_INK = Object.freeze({ plate: '#1d1712', rule: '#b48a4a', text: '#eadfc8', mark: '#f6c85f' });

export function postcardBandHeight(unit = 1) {
    return BAND.height * Math.max(1, Math.round(unit));
}

/**
 * Composite `surfaces` (bottom first, each drawn 1:1 at the backing size) and
 * the caption band into one canvas `width` x (`height` + band). Integer
 * scale: no surface is resampled.
 */
export function composePostcard({ surfaces, width, height, caption, unit = 1, documentRef = globalThis.document }) {
    const k = Math.max(1, Math.round(unit));
    const band = postcardBandHeight(k);
    const canvas = documentRef.createElement('canvas');
    canvas.width = width;
    canvas.height = height + band;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    for (const surface of surfaces) {
        if (surface?.width && surface?.height) ctx.drawImage(surface, 0, 0, width, height, 0, 0, width, height);
    }
    ctx.fillStyle = BAND_INK.plate;
    ctx.fillRect(0, height, width, band);
    ctx.fillStyle = BAND_INK.rule;
    ctx.fillRect(0, height, width, k);
    ctx.fillStyle = BAND_INK.mark;
    ctx.fillRect(BAND.padX * k, height + 7 * k, 2 * k, 8 * k);
    ctx.font = `${BAND.font * k}px ${WORLD_BODY_FONT}`;
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';
    ctx.fillStyle = BAND_INK.text;
    ctx.fillText(caption, (BAND.padX + 6) * k, height + BAND.baseline * k);
    return canvas;
}

function saveCanvas(canvas, fileName, documentRef) {
    return new Promise((resolve) => {
        canvas.toBlob((blob) => {
            if (!blob) { resolve(false); return; }
            const url = URL.createObjectURL(blob);
            const link = documentRef.createElement('a');
            link.href = url;
            link.download = fileName;
            link.rel = 'noopener';
            link.style.display = 'none';
            documentRef.body.appendChild(link);
            link.click();
            link.remove();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
            resolve(true);
        }, 'image/png');
    });
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

/**
 * Strike a postcard of `renderer`'s current view. Draws the postcard frame
 * and snapshots the three World canvases in the same task, redraws the live
 * frame (still the same task: the screen only ever presents that one), then
 * composites, saves the PNG (unless `save` is false) and confirms once with
 * a static toast. Resolves `{ ok, reason?, canvas?, caption?, fileName?,
 * textCalls, textSites }`.
 */
export async function strikePostcard(renderer, { save = true, trace = false, documentRef = globalThis.document } = {}) {
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
        if (width && height) renderer.renderNow?.();
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
    if (!layers) {
        eventBus.emit('postcard:status', { ok: false, message: 'Postcard unavailable · the World is not drawing' });
        return { ok: false, reason: 'not-drawn', textCalls, textSites };
    }
    const caption = layers.caption;
    const unit = world._claudeVilleDpr || globalThis.devicePixelRatio || 1;
    const canvas = composePostcard({ surfaces: [layers.world, fx, layers.overlay], width, height, caption, unit, documentRef });
    if (textCalls > 0) console.warn(`[Postcard] ${textCalls} text call(s) reached the postcard frame and were dropped`);
    const fileName = postcardFileName(new Date());
    if (save && !(await saveCanvas(canvas, fileName, documentRef))) {
        eventBus.emit('postcard:status', { ok: false, message: 'Postcard unavailable · the image could not be encoded' });
        return { ok: false, reason: 'encode', textCalls, textSites };
    }
    if (save) eventBus.emit('postcard:status', { ok: true, message: `Postcard saved · ${fileName}` });
    return { ok: true, canvas, caption, fileName, textCalls, textSites };
}
