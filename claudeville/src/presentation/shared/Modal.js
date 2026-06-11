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

        this.closeBtn.addEventListener('click', this._onClose);
        this.overlay.addEventListener('click', (e) => {
            if (e.target === this.overlay) this.close();
        });
    }

    open(title, contentHTML, { wide = false } = {}) {
        this.titleEl.textContent = title;
        this.contentEl.innerHTML = contentHTML;
        this.box.classList.toggle('modal--wide', wide);
        this.overlay.style.display = 'flex';
        document.addEventListener('keydown', this._onKeydown);
    }

    close() {
        this.overlay.style.display = 'none';
        this.titleEl.textContent = '';
        this.contentEl.innerHTML = '';
        this.box.classList.remove('modal--wide');
        document.removeEventListener('keydown', this._onKeydown);
    }

    // Public lifecycle hook for callers that mount/unmount shared UI primitives.
    destroy() {
        this.close();
        this.closeBtn.removeEventListener('click', this._onClose);
    }
}
