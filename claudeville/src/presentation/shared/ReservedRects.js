// V8 — screen rects the chrome reserves over the World. An owner publishes a
// DOM element under a name; the registry keeps its box in integer CSS px
// relative to a frame element (the World viewport, `#characterMode`, whose
// box is the world canvas), refreshed by a ResizeObserver on both, so
// per-frame readers (T1 plates, moment staging, director framing) never read
// layout. A hidden element (`display: none`, e.g. in Dashboard) publishes no
// rect. A painter with no DOM element (the lower-third caption band) publishes
// its box directly with `publishReservedBox`. Consumers treat every rect as
// occluded screen.

const entries = new Map();
const listeners = new Set();
let snapshot = Object.freeze([]);

function rebuildSnapshot() {
    snapshot = Object.freeze([...entries.values()].map(entry => entry.rect).filter(Boolean));
    for (const listener of listeners) listener(snapshot);
}

function measure(element, frame) {
    if (!element.isConnected || !element.getClientRects().length) return null;
    const box = element.getBoundingClientRect();
    const origin = frame?.getBoundingClientRect?.() || { left: 0, top: 0 };
    if (box.width <= 0 || box.height <= 0) return null;
    const left = Math.round(box.left - origin.left);
    const top = Math.round(box.top - origin.top);
    const right = Math.round(box.right - origin.left);
    const bottom = Math.round(box.bottom - origin.top);
    return { left, top, right, bottom, width: right - left, height: bottom - top };
}

/**
 * Publish `element`'s box as the reserved rect `name`, relative to `frame`.
 * Returns an unpublish function. Re-publishing a name replaces it.
 */
export function publishReservedRect(name, element, { frame = null } = {}) {
    if (!name || !element) return () => {};
    unpublishReservedRect(name);
    const entry = { name, element, frame, rect: null, observer: null };
    const refresh = () => {
        const next = measure(element, frame);
        const rect = next ? Object.freeze({ name, ...next }) : null;
        const prev = entry.rect;
        if (prev === rect || (prev && rect && prev.left === rect.left && prev.top === rect.top
            && prev.right === rect.right && prev.bottom === rect.bottom)) return;
        entry.rect = rect;
        rebuildSnapshot();
    };
    entries.set(name, entry);
    if (typeof ResizeObserver === 'function') {
        entry.observer = new ResizeObserver(refresh);
        entry.observer.observe(element);
        if (frame) entry.observer.observe(frame);
    }
    refresh();
    return () => {
        if (entries.get(name) === entry) unpublishReservedRect(name);
    };
}

export function unpublishReservedRect(name) {
    const entry = entries.get(name);
    if (!entry) return;
    entry.observer?.disconnect();
    entries.delete(name);
    if (entry.rect) rebuildSnapshot();
}

/**
 * Publish a rect a canvas painter reserves (e.g. the lower-third caption
 * band, drawn on the world overlay rather than as a DOM element): integer CSS
 * px in the frame's space. `null` clears it. Cheap to call every frame: the
 * snapshot only changes when the box does.
 */
export function publishReservedBox(name, rect) {
    if (!name) return;
    const entry = entries.get(name);
    if (entry?.element) return;
    const next = rect && rect.right > rect.left && rect.bottom > rect.top
        ? {
            left: Math.floor(rect.left),
            top: Math.floor(rect.top),
            right: Math.ceil(rect.right),
            bottom: Math.ceil(rect.bottom),
        }
        : null;
    const prev = entry?.rect || null;
    if (!next) {
        if (!entry) return;
        entries.delete(name);
        if (prev) rebuildSnapshot();
        return;
    }
    if (prev && prev.left === next.left && prev.top === next.top
        && prev.right === next.right && prev.bottom === next.bottom) return;
    const frozen = Object.freeze({ name, ...next, width: next.right - next.left, height: next.bottom - next.top });
    entries.set(name, { name, element: null, frame: null, rect: frozen, observer: null });
    rebuildSnapshot();
}

// Every published rect: a frozen array, identical until something changes.
export function getReservedRects() {
    return snapshot;
}

export function getReservedRect(name) {
    return entries.get(name)?.rect || null;
}

// `listener(rects)` runs after every change; returns an unsubscribe.
export function subscribeReservedRects(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
}
