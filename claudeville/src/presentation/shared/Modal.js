export class Modal {
    constructor() {
        this.overlay = document.getElementById('modalOverlay');
        this.box = this.overlay.querySelector('.modal');
        this.titleEl = document.getElementById('modalTitle');
        this.contentEl = document.getElementById('modalContent');
        this.closeBtn = document.getElementById('modalClose');

        this._onClose = () => this.close();
        this._onKeydown = (e) => {
            if (e.key === 'Escape') this.close();
        };
        this._onOverlayClick = (e) => {
            if (e.target === this.overlay) this.close();
        };
        this._destroyed = false;
        // Element that had focus before the dialog opened; restored on close.
        this._previousFocus = null;

        this.closeBtn.addEventListener('click', this._onClose);
        this.overlay.addEventListener('click', this._onOverlayClick);
    }

    open(title, contentHTML, { wide = false } = {}) {
        if (this._destroyed) return;
        this.titleEl.textContent = title;
        this.contentEl.innerHTML = contentHTML;
        this.box.classList.toggle('modal--wide', wide);
        this._previousFocus = document.activeElement;
        this.overlay.style.display = 'flex';
        document.addEventListener('keydown', this._onKeydown);
        // Move focus inside the dialog (role="dialog" + aria-modal in markup).
        this.closeBtn.focus();
    }

    close() {
        if (!this.overlay) return;
        this.overlay.style.display = 'none';
        this.titleEl.textContent = '';
        this.contentEl.innerHTML = '';
        this.box.classList.remove('modal--wide');
        document.removeEventListener('keydown', this._onKeydown);
        const previous = this._previousFocus;
        this._previousFocus = null;
        if (previous && previous.isConnected && typeof previous.focus === 'function') {
            previous.focus();
        }
    }

    // Public lifecycle hook for callers that mount/unmount shared UI primitives.
    destroy() {
        if (this._destroyed) return;
        this._destroyed = true;
        this.close();
        this.closeBtn.removeEventListener('click', this._onClose);
        this.overlay.removeEventListener('click', this._onOverlayClick);
        this.overlay = null;
        this.box = null;
        this.titleEl = null;
        this.contentEl = null;
        this.closeBtn = null;
    }
}
