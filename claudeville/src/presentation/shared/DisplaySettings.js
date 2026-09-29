// 10.2 — the one persisted display preference: "HDR highlights". Pure and
// DOM-free like SoundSettings.js: the storage key, the vocabulary, the
// default (M1: subtle) and the reader/writer. SET writes it and emits
// `display:hdr-highlights`; the World reads it once at boot and on that event.
// What each mode does to a pixel is the renderer's policy (character-mode
// DisplayColor.js); this module only owns the choice.

export const HDR_HIGHLIGHTS_STORAGE_KEY = 'claudeville.display.hdrHighlights';
export const HDR_HIGHLIGHT_MODES = Object.freeze(['off', 'subtle', 'full']);
export const HDR_HIGHLIGHTS_DEFAULT = 'subtle';
export const HDR_HIGHLIGHTS_EVENT = 'display:hdr-highlights';
export const HDR_HIGHLIGHT_LABELS = Object.freeze({ off: 'Off', subtle: 'Subtle', full: 'Full' });

export function normalizeHdrHighlights(value) {
    return HDR_HIGHLIGHT_MODES.includes(value) ? value : HDR_HIGHLIGHTS_DEFAULT;
}

export function readHdrHighlights(storage = globalThis.window?.localStorage) {
    try {
        return normalizeHdrHighlights(storage?.getItem(HDR_HIGHLIGHTS_STORAGE_KEY) ?? null);
    } catch {
        return HDR_HIGHLIGHTS_DEFAULT;
    }
}

/** Persists `value` (an unknown value falls back to the default) and returns what was kept. */
export function writeHdrHighlights(value, storage = globalThis.window?.localStorage) {
    const mode = normalizeHdrHighlights(value);
    try { storage?.setItem(HDR_HIGHLIGHTS_STORAGE_KEY, mode); } catch { /* persistence is optional */ }
    return mode;
}

// 10.3 — the World overlay's 2D context attributes. Context attributes are
// fixed by the first getContext call, so every site that creates it (App's
// resize and the renderer) passes these: display-p3 on a P3 screen, where
// the overlay draws the reserved hues' P3 variants (DisplayColor).
export function overlayContextAttributes(root = globalThis.window) {
    let p3 = false;
    try { p3 = root?.matchMedia?.('(color-gamut: p3)')?.matches === true; } catch { p3 = false; }
    return p3 ? { alpha: true, colorSpace: 'display-p3' } : { alpha: true };
}


// What the World can do with the setting, published by the renderer once its
// backend is known, again on each media change and when a WebGPU canvas turns
// out not to tone-map: `{ backend, hdrMode, dynamicRangeHigh, colorGamutP3,
// toneMappingSupported }`. SET reads it to say whether HDR can show here and
// follows it (`onDisplayStatus`) while open.
let displayStatus = null;
const displayStatusListeners = new Set();

export function publishDisplayStatus(status) {
    displayStatus = status ? Object.freeze({ ...status }) : null;
    for (const listener of displayStatusListeners) listener(displayStatus);
}

export function readDisplayStatus() {
    return displayStatus;
}

/** Calls `listener(status)` on every publish; returns the unsubscribe. */
export function onDisplayStatus(listener) {
    displayStatusListeners.add(listener);
    return () => displayStatusListeners.delete(listener);
}