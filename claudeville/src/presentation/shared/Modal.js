export class Modal {
    constructor() {
        this.overlay = document.getElementById('modalOverlay');
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

    open(title, contentHTML) {
        this.titleEl.textContent = title;
        this.contentEl.innerHTML = contentHTML;
        this.overlay.style.display = 'flex';
        document.addEventListener('keydown', this._onKeydown);
    }

    close() {
        this.overlay.style.display = 'none';
        this.titleEl.textContent = '';
        this.contentEl.innerHTML = '';
        document.removeEventListener('keydown', this._onKeydown);
    }

    get isOpen() {
        return this.overlay.style.display !== 'none';
    }

    destroy() {
        this.close();
        this.closeBtn.removeEventListener('click', this._onClose);
    }
}
