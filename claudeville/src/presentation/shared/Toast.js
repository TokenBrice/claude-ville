const MAX_TOASTS = 5;
const AUTO_DISMISS_MS = 3000;

export class Toast {
    constructor() {
        this.container = document.getElementById('toastContainer');
        this.toasts = [];
        this._destroyed = false;
    }

    show(message, type = 'info') {
        if (this._destroyed || !this.container) return;

        // Remove the oldest item when the max count is exceeded
        while (this.toasts.length >= MAX_TOASTS) {
            this._remove(this.toasts[0]);
        }

        const el = document.createElement('div');
        el.className = `toast toast--${type}`;
        el.textContent = message;
        this.container.appendChild(el);

        const entry = { el, dismissTimer: null, removalTimer: null };
        this.toasts.push(entry);

        entry.dismissTimer = setTimeout(() => {
            entry.dismissTimer = null;
            this._fadeOut(entry);
        }, AUTO_DISMISS_MS);
    }

    _fadeOut(entry) {
        if (this._destroyed || entry.removalTimer || !this.toasts.includes(entry)) return;
        entry.el.classList.add('toast--fadeout');
        entry.removalTimer = setTimeout(() => {
            entry.removalTimer = null;
            this._remove(entry);
        }, 300);
    }

    _remove(entry) {
        if (!entry) return;
        if (entry.dismissTimer) clearTimeout(entry.dismissTimer);
        if (entry.removalTimer) clearTimeout(entry.removalTimer);
        entry.dismissTimer = null;
        entry.removalTimer = null;
        if (entry.el.parentNode) {
            entry.el.parentNode.removeChild(entry.el);
        }
        const idx = this.toasts.indexOf(entry);
        if (idx !== -1) this.toasts.splice(idx, 1);
    }

    destroy() {
        if (this._destroyed) return;
        this._destroyed = true;
        for (const entry of [...this.toasts]) this._remove(entry);
        this.container = null;
    }
}
