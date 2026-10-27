// UI-11 — the one guard for the global single-key shortcuts (`A`, `M`, `/`
// and Ctrl/Cmd+K). A shortcut never fires while the operator types (an
// input, a textarea, a select or an editable element), under the modal or
// an open auto popover (they own the keyboard), or on a held key's repeats.

export function isEditTarget(target) {
    const tag = String(target?.tagName || '').toUpperCase();
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || Boolean(target?.isContentEditable);
}

// The shared Modal (Settings, Chronicle, changelog) marks its overlay
// `aria-hidden="false"` while open; the World controls are an auto popover.
function overlayOpen(doc) {
    if (doc?.getElementById?.('modalOverlay')?.getAttribute?.('aria-hidden') === 'false') return true;
    try {
        return Boolean(doc?.querySelector?.('[popover]:not([popover="manual"]):popover-open'));
    } catch {
        return false;
    }
}

/** True when a global shortcut must not act on this keydown. */
export function shortcutBlocked(event, { doc = globalThis.document } = {}) {
    if (!event || event.repeat) return true;
    return isEditTarget(event.target) || overlayOpen(doc);
}
