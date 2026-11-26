import {
    LIVING_POSTCARD_DURATION_MS,
    LIVING_POSTCARD_FPS,
    POSTCARD_ASPECTS,
    POSTCARD_BORDERS,
    computePostcardCropRect,
    copyPostcardToClipboard,
    recordLivingPostcard,
    strikePostcard,
} from '../character-mode/Postcard.js';
import { el } from './DomSafe.js';

// W4-E — Postcard Studio (`Shift+P`): a walnut framing sheet over the World
// with pixel-snapped aspect crops (FULL · 16:9 · 4:3 · 1:1), border styles
// (CLEAN CAPTION · WOODCUT MAT), live crop overlay preview, SAVE PNG,
// COPY PNG (with automatic save fallback), and 6s LIVING POSTCARD recording.

export const POSTCARD_ASPECT_LABELS = Object.freeze({
    full: 'FULL',
    '16:9': '16:9',
    '4:3': '4:3',
    '1:1': '1:1',
});

export const POSTCARD_BORDER_LABELS = Object.freeze({
    clean: 'CLEAN CAPTION',
    woodcut: 'WOODCUT MAT',
});

export class PostcardStudio {
    constructor({
        container = null,
        frame = null,
        getRenderer = null,
        hasActionNeeded = null,
        onClose = null,
        onReserveRect = null,
        strike = strikePostcard,
        copyToClipboard = copyPostcardToClipboard,
        recordLiving = recordLivingPostcard,
        documentRef = globalThis.document,
        windowRef = globalThis.window,
    } = {}) {
        this.container = container;
        this.frame = frame || container;
        this.getRenderer = typeof getRenderer === 'function' ? getRenderer : () => null;
        this.hasActionNeeded = typeof hasActionNeeded === 'function' ? hasActionNeeded : null;
        this.onClose = typeof onClose === 'function' ? onClose : null;
        this.onReserveRect = typeof onReserveRect === 'function' ? onReserveRect : null;
        this._strike = strike;
        this._copyToClipboard = copyToClipboard;
        this._recordLiving = recordLiving;
        this.documentRef = documentRef;
        this.windowRef = windowRef;

        this.crop = 'full';
        this.border = 'clean';
        this._open = false;
        this._busy = false;
        this._recording = false;
        this._recordAbort = null;
        this._statusMessage = 'Choose a crop and border, then save, copy, or record 6s.';
        this._statusTone = 'idle';
        this._cropRect = { x: 0, y: 0, width: 0, height: 0, aspect: 'full' };
        this._lastReservedKey = null;
        this._resizeObserver = null;
        this._destroyed = false;

        this._onKeyDown = event => this._handleKeyDown(event);
        this._onResize = () => {
            this.updateCropOverlay();
            this.reportReservedRect();
        };

        this._buildDom();
    }

    _make(tag, opts = {}, children = []) {
        const doc = this.documentRef;
        if (doc && doc !== globalThis.document) {
            const node = doc.createElement(tag);
            if (opts.className) {
                const classes = Array.isArray(opts.className) ? opts.className : String(opts.className).split(/\s+/);
                node.classList?.add?.(...classes.filter(Boolean));
            }
            if (opts.text !== undefined && opts.text !== null) node.textContent = String(opts.text);
            if (opts.title) node.title = String(opts.title);
            if (opts.ariaLabel) node.setAttribute?.('aria-label', String(opts.ariaLabel));
            if (opts.dataset && node.dataset) {
                for (const [k, v] of Object.entries(opts.dataset)) {
                    if (v !== undefined && v !== null) node.dataset[k] = String(v);
                }
            }
            for (const child of (Array.isArray(children) ? children : [children])) {
                if (child != null) node.append?.(child);
            }
            return node;
        }
        return el(tag, opts, children);
    }

    _buildDom() {
        this._maskTop = this._make('div', { className: 'postcard-studio__mask postcard-studio__mask--top' });
        this._maskBottom = this._make('div', { className: 'postcard-studio__mask postcard-studio__mask--bottom' });
        this._maskLeft = this._make('div', { className: 'postcard-studio__mask postcard-studio__mask--left' });
        this._maskRight = this._make('div', { className: 'postcard-studio__mask postcard-studio__mask--right' });
        this._apertureLabel = this._make('span', { className: 'postcard-studio__aperture-label', text: 'FULL' });
        this._aperture = this._make('div', { className: 'postcard-studio__aperture' }, [this._apertureLabel]);
        this._cropOverlay = this._make('div', { className: 'postcard-studio__crop-overlay' }, [
            this._maskTop,
            this._maskBottom,
            this._maskLeft,
            this._maskRight,
            this._aperture,
        ]);

        this._closeBtn = this._make('button', {
            className: 'postcard-studio__close',
            text: '×',
            title: 'Close Postcard Studio (Esc)',
            ariaLabel: 'Close Postcard Studio',
        });
        this._closeBtn.type = 'button';
        this._closeBtn.addEventListener?.('click', () => this.close());

        this._cropButtons = new Map();
        const cropNodes = POSTCARD_ASPECTS.map(aspect => {
            const btn = this._make('button', {
                className: 'postcard-studio__option',
                text: POSTCARD_ASPECT_LABELS[aspect],
                dataset: { crop: aspect },
                ariaLabel: `Crop ${POSTCARD_ASPECT_LABELS[aspect]}`,
            });
            btn.type = 'button';
            btn.addEventListener?.('click', () => this.setCrop(aspect));
            this._cropButtons.set(aspect, btn);
            return btn;
        });

        this._borderButtons = new Map();
        const borderNodes = POSTCARD_BORDERS.map(border => {
            const btn = this._make('button', {
                className: 'postcard-studio__option',
                text: POSTCARD_BORDER_LABELS[border],
                dataset: { border },
                ariaLabel: `Border ${POSTCARD_BORDER_LABELS[border]}`,
            });
            btn.type = 'button';
            btn.addEventListener?.('click', () => this.setBorder(border));
            this._borderButtons.set(border, btn);
            return btn;
        });

        this._saveBtn = this._make('button', {
            className: ['postcard-studio__action', 'postcard-studio__action--primary'],
            text: 'SAVE PNG',
            ariaLabel: 'Save framed postcard as PNG',
        });
        this._saveBtn.type = 'button';
        this._saveBtn.addEventListener?.('click', () => { void this.savePng(); });

        this._copyBtn = this._make('button', {
            className: 'postcard-studio__action',
            text: 'COPY PNG',
            ariaLabel: 'Copy framed postcard PNG to clipboard',
        });
        this._copyBtn.type = 'button';
        this._copyBtn.addEventListener?.('click', () => { void this.copyPng(); });

        this._livingBtn = this._make('button', {
            className: ['postcard-studio__action', 'postcard-studio__action--living'],
            text: 'LIVING 6S',
            ariaLabel: 'Record a 6-second living postcard',
        });
        this._livingBtn.type = 'button';
        this._livingBtn.addEventListener?.('click', () => {
            if (this._recording) this.cancelRecording();
            else void this.recordLiving();
        });

        this._progressFill = this._make('div', { className: 'postcard-studio__progress-fill' });
        this._progressTrack = this._make('div', { className: 'postcard-studio__progress' }, [this._progressFill]);
        this._progressTrack.hidden = true;

        this._statusEl = this._make('p', {
            className: 'postcard-studio__status',
            text: this._statusMessage,
        });
        this._statusEl.setAttribute?.('role', 'status');
        this._statusEl.setAttribute?.('aria-live', 'polite');

        this._sheet = this._make('section', {
            className: ['postcard-studio__sheet', 'cv-frame', 'cv-frame--walnut'],
            ariaLabel: 'Postcard Studio',
        }, [
            this._make('header', { className: 'postcard-studio__header' }, [
                this._make('div', { className: 'postcard-studio__title-group' }, [
                    this._make('span', { className: 'postcard-studio__title', text: 'POSTCARD STUDIO' }),
                    this._make('span', { className: 'postcard-studio__hint', text: 'P INSTANT · SHIFT+P STUDIO · ESC CLOSE' }),
                ]),
                this._closeBtn,
            ]),
            this._make('div', { className: 'postcard-studio__group' }, [
                this._make('span', { className: 'postcard-studio__label', text: 'CROP' }),
                this._make('div', { className: ['postcard-studio__options', 'cv-frame', 'cv-frame--well'] }, cropNodes),
            ]),
            this._make('div', { className: 'postcard-studio__group' }, [
                this._make('span', { className: 'postcard-studio__label', text: 'BORDER' }),
                this._make('div', { className: ['postcard-studio__options', 'cv-frame', 'cv-frame--well'] }, borderNodes),
            ]),
            this._make('div', { className: 'postcard-studio__actions' }, [
                this._saveBtn,
                this._copyBtn,
                this._livingBtn,
            ]),
            this._progressTrack,
            this._statusEl,
        ]);

        this.element = this._make('div', {
            className: 'postcard-studio',
            ariaLabel: 'Postcard Studio framing overlay',
        }, [
            this._cropOverlay,
            this._sheet,
        ]);
        this.element.setAttribute?.('aria-hidden', 'true');
        this.element.hidden = true;
        this._syncControls();
    }

    _handleKeyDown(event) {
        if (this._destroyed || !this._open || !event) return;
        if (event.key === 'Escape' || event.code === 'Escape') {
            event.preventDefault?.();
            event.stopPropagation?.();
            this.close();
        }
    }

    _viewportSize() {
        const frameRect = this.frame?.getBoundingClientRect?.();
        if (frameRect && frameRect.width > 0 && frameRect.height > 0) {
            return { width: Math.round(frameRect.width), height: Math.round(frameRect.height) };
        }
        const renderer = this.getRenderer();
        const canvas = renderer?.canvas;
        if (canvas) {
            const width = Math.round(canvas._claudeVilleCssWidth || canvas.clientWidth || canvas.width || 0);
            const height = Math.round(canvas._claudeVilleCssHeight || canvas.clientHeight || canvas.height || 0);
            if (width > 0 && height > 0) return { width, height };
        }
        const winW = Math.round(Number(this.windowRef?.innerWidth) || 0);
        const winH = Math.round(Number(this.windowRef?.innerHeight) || 0);
        return { width: winW, height: winH };
    }

    _setStatus(message, tone = 'idle') {
        this._statusMessage = String(message || '');
        this._statusTone = tone;
        if (this._statusEl) {
            this._statusEl.textContent = this._statusMessage;
            this._statusEl.classList?.toggle?.('postcard-studio__status--warn', tone === 'warn');
            this._statusEl.classList?.toggle?.('postcard-studio__status--ok', tone === 'ok');
        }
    }

    _syncControls() {
        for (const [aspect, btn] of this._cropButtons.entries()) {
            const active = aspect === this.crop;
            btn.setAttribute?.('aria-pressed', String(active));
            btn.classList?.toggle?.('postcard-studio__option--active', active);
            btn.disabled = this._recording;
        }
        for (const [border, btn] of this._borderButtons.entries()) {
            const active = border === this.border;
            btn.setAttribute?.('aria-pressed', String(active));
            btn.classList?.toggle?.('postcard-studio__option--active', active);
            btn.disabled = this._recording;
        }
        if (this._saveBtn) this._saveBtn.disabled = this._busy || this._recording;
        if (this._copyBtn) this._copyBtn.disabled = this._busy || this._recording;
        if (this._livingBtn) {
            this._livingBtn.disabled = this._busy && !this._recording;
            this._livingBtn.textContent = this._recording ? 'STOP 6S' : 'LIVING 6S';
            this._livingBtn.classList?.toggle?.('postcard-studio__action--recording', this._recording);
        }
        if (this._progressTrack) this._progressTrack.hidden = !this._recording;
        this._aperture?.classList?.toggle?.('postcard-studio__aperture--woodcut', this.border === 'woodcut');
    }

    updateCropOverlay() {
        const { width, height } = this._viewportSize();
        const rect = computePostcardCropRect(width, height, this.crop);
        this._cropRect = rect;
        const setBox = (node, left, top, w, h) => {
            if (!node?.style) return;
            node.style.left = `${left}px`;
            node.style.top = `${top}px`;
            node.style.width = `${Math.max(0, w)}px`;
            node.style.height = `${Math.max(0, h)}px`;
        };
        setBox(this._maskTop, 0, 0, width, rect.y);
        setBox(this._maskBottom, 0, rect.y + rect.height, width, height - (rect.y + rect.height));
        setBox(this._maskLeft, 0, rect.y, rect.x, rect.height);
        setBox(this._maskRight, rect.x + rect.width, rect.y, width - (rect.x + rect.width), rect.height);
        setBox(this._aperture, rect.x, rect.y, rect.width, rect.height);
        if (this._apertureLabel) {
            const dims = rect.width > 0 && rect.height > 0 ? ` · ${rect.width}×${rect.height}` : '';
            const matSuffix = this.border === 'woodcut' ? ' · WOODCUT MAT' : '';
            this._apertureLabel.textContent = `${POSTCARD_ASPECT_LABELS[this.crop]}${dims}${matSuffix}`;
        }
        return rect;
    }

    isOpen() {
        return this._open;
    }

    getState() {
        return {
            open: this._open,
            crop: this.crop,
            border: this.border,
            busy: this._busy,
            recording: this._recording,
            statusMessage: this._statusMessage,
            statusTone: this._statusTone,
            cropRect: { ...this._cropRect },
        };
    }

    open() {
        if (this._destroyed || this._open) return false;
        this._open = true;
        if (this.container && !this.element.isConnected && typeof this.container.append === 'function') {
            this.container.append(this.element);
        }
        this.element.hidden = false;
        this.element.setAttribute?.('aria-hidden', 'false');
        this.element.classList?.add?.('postcard-studio--open');
        this.windowRef?.addEventListener?.('keydown', this._onKeyDown, true);
        this.windowRef?.addEventListener?.('resize', this._onResize);
        if (typeof globalThis.ResizeObserver === 'function' && this.frame && !this._resizeObserver) {
            this._resizeObserver = new globalThis.ResizeObserver(this._onResize);
            this._resizeObserver.observe(this.frame);
            if (this._sheet) this._resizeObserver.observe(this._sheet);
        }
        this._syncControls();
        this.updateCropOverlay();
        this.reportReservedRect();
        this._closeBtn?.focus?.();
        return true;
    }

    close() {
        if (this._destroyed || !this._open) return false;
        if (this._recording) this.cancelRecording();
        this._open = false;
        this.element.hidden = true;
        this.element.setAttribute?.('aria-hidden', 'true');
        this.element.classList?.remove?.('postcard-studio--open');
        this.windowRef?.removeEventListener?.('keydown', this._onKeyDown, true);
        this.windowRef?.removeEventListener?.('resize', this._onResize);
        this._resizeObserver?.disconnect?.();
        this._resizeObserver = null;
        this.reportReservedRect();
        this.onClose?.();
        return true;
    }

    toggle() {
        return this._open ? this.close() : this.open();
    }

    setCrop(aspect) {
        if (!POSTCARD_ASPECTS.includes(aspect) || this._recording) return this.crop;
        this.crop = aspect;
        this._syncControls();
        this.updateCropOverlay();
        return this.crop;
    }

    setBorder(border) {
        if (!POSTCARD_BORDERS.includes(border) || this._recording) return this.border;
        this.border = border;
        this._syncControls();
        this.updateCropOverlay();
        return this.border;
    }

    async savePng() {
        if (this._destroyed || this._busy || this._recording) return null;
        const renderer = this.getRenderer();
        if (!renderer) {
            this._setStatus('Postcard unavailable · the World is not active', 'warn');
            return { ok: false, reason: 'no-renderer' };
        }
        this._busy = true;
        this._syncControls();
        this._setStatus('Framing PNG postcard…');
        try {
            const result = await this._strike(renderer, {
                save: true,
                crop: this.crop,
                border: this.border,
                documentRef: this.documentRef,
            });
            if (result?.ok) {
                this._setStatus(`Saved ${result.fileName}`, 'ok');
            } else {
                this._setStatus('Postcard unavailable · could not save PNG', 'warn');
            }
            return result;
        } finally {
            this._busy = false;
            this._syncControls();
        }
    }

    async copyPng({ clipboardRef, ClipboardItemCtor } = {}) {
        if (this._destroyed || this._busy || this._recording) return null;
        const renderer = this.getRenderer();
        if (!renderer) {
            this._setStatus('Postcard unavailable · the World is not active', 'warn');
            return { ok: false, reason: 'no-renderer' };
        }
        this._busy = true;
        this._syncControls();
        this._setStatus('Framing PNG for clipboard…');
        try {
            const struck = await this._strike(renderer, {
                save: false,
                crop: this.crop,
                border: this.border,
                documentRef: this.documentRef,
            });
            if (!struck?.ok || !struck.canvas) {
                this._setStatus('Postcard unavailable · the World is not drawing', 'warn');
                return { ok: false, reason: struck?.reason || 'not-drawn' };
            }
            const copied = await this._copyToClipboard(struck.canvas, {
                clipboardRef,
                ClipboardItemCtor,
                fileName: struck.fileName,
                documentRef: this.documentRef,
            });
            if (copied.ok && copied.method === 'clipboard') {
                this._setStatus(copied.message || 'Postcard copied to clipboard', 'ok');
            } else if (copied.ok && copied.method === 'save-fallback') {
                this._setStatus(copied.message || `Clipboard unavailable · saved ${copied.fileName} instead`, 'warn');
            } else {
                this._setStatus(copied.message || 'Could not copy or save PNG', 'warn');
            }
            return copied;
        } finally {
            this._busy = false;
            this._syncControls();
        }
    }

    cancelRecording() {
        if (!this._recording) return false;
        this._recordAbort?.abort?.();
        return true;
    }

    async recordLiving({ durationMs = LIVING_POSTCARD_DURATION_MS, fps = LIVING_POSTCARD_FPS, ...extra } = {}) {
        if (this._destroyed || this._busy || this._recording) return null;
        const renderer = this.getRenderer();
        if (!renderer) {
            this._setStatus('Living postcard unavailable · the World is not active', 'warn');
            return { ok: false, aborted: false, reason: 'no-renderer' };
        }
        this._busy = true;
        this._recording = true;
        const controller = typeof AbortController === 'function' ? new AbortController() : null;
        this._recordAbort = controller;
        if (this._progressFill?.style) this._progressFill.style.width = '0%';
        this._syncControls();
        this._setStatus('Recording 6s living postcard…');
        try {
            const result = await this._recordLiving(renderer, {
                durationMs,
                fps,
                crop: this.crop,
                border: this.border,
                hasActionNeeded: this.hasActionNeeded,
                documentRef: this.documentRef,
                signal: controller?.signal,
                onStatus: (update) => {
                    if (update?.message) {
                        const tone = update.state === 'done' ? 'ok'
                            : (update.state === 'aborted' || update.state === 'error') ? 'warn'
                                : 'idle';
                        this._setStatus(update.message, tone);
                    }
                    if (Number.isFinite(update?.progress) && this._progressFill?.style) {
                        this._progressFill.style.width = `${Math.round(update.progress * 100)}%`;
                    }
                },
                ...extra,
            });
            if (result?.ok) {
                this._setStatus(result.message || `Saved ${result.fileName}`, 'ok');
            } else if (result?.aborted) {
                this._setStatus(result.message || 'Living postcard aborted · an agent needs attention', 'warn');
            } else {
                this._setStatus(result?.message || 'Living postcard unavailable', 'warn');
            }
            return result;
        } finally {
            this._recording = false;
            this._busy = false;
            this._recordAbort = null;
            this._syncControls();
        }
    }

    reportReservedRect() {
        if (!this.onReserveRect) return null;
        let rect = null;
        if (!this._destroyed && this._open && this._sheet) {
            const box = this._sheet.getBoundingClientRect?.();
            if (box && box.width > 0 && box.height > 0) {
                const origin = this.frame?.getBoundingClientRect?.() || { left: 0, top: 0 };
                const left = Math.round(box.left - origin.left);
                const top = Math.round(box.top - origin.top);
                const right = Math.round(box.right - origin.left);
                const bottom = Math.round(box.bottom - origin.top);
                if (right > left && bottom > top) {
                    rect = { left, top, right, bottom, width: right - left, height: bottom - top };
                }
            }
        }
        const key = rect ? `${rect.left},${rect.top},${rect.right},${rect.bottom}` : 'null';
        if (key === this._lastReservedKey) return rect;
        this._lastReservedKey = key;
        this.onReserveRect(rect);
        return rect;
    }

    destroy() {
        if (this._destroyed) return;
        if (this._open) this.close();
        this._destroyed = true;
        if (this._lastReservedKey !== 'null') {
            this._lastReservedKey = 'null';
            this.onReserveRect?.(null);
        }
        this.element?.remove?.();
        this.element = null;
        this.onClose = null;
        this.onReserveRect = null;
    }
}
