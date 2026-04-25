const MAX_TOASTS = 5;
const AUTO_DISMISS_MS = 3000;

export class Toast {
    constructor() {
        this.container = document.getElementById('toastContainer');
        this.toasts = [];
    }

    show(message, type = 'info') {
        // Remove the oldest item when the max count is exceeded
        while (this.toasts.length >= MAX_TOASTS) {
            this._remove(this.toasts[0]);
        }

        const el = document.createElement('div');
        el.className = `toast toast--${type}`;
        el.textContent = message;
        this.container.appendChild(el);

        const entry = { el, timer: null };
        this.toasts.push(entry);

        entry.timer = setTimeout(() => {
            this._fadeOut(entry);
        }, AUTO_DISMISS_MS);
    }

    _fadeOut(entry) {
        entry.el.classList.add('toast--fadeout');
        setTimeout(() => this._remove(entry), 300);
    }

    _remove(entry) {
        if (entry.timer) clearTimeout(entry.timer);
        if (entry.el.parentNode) {
            entry.el.parentNode.removeChild(entry.el);
        }
        const idx = this.toasts.indexOf(entry);
        if (idx !== -1) this.toasts.splice(idx, 1);
    }

    destroy() {
        for (const entry of this.toasts) {
            if (entry.timer) clearTimeout(entry.timer);
            if (entry.el.parentNode) entry.el.parentNode.removeChild(entry.el);
        }
        this.toasts = [];
    }
}
