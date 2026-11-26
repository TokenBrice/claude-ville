import { AUTHORED_DIURNAL_BANDS } from '../../application/ChronicleScenario.js';
import { el } from './DomSafe.js';

// W4-E — Retold Scrubber (`?retold=YYYY-MM-DD`).
// A walnut bottom-centre playback bar over the World: Space or button toggles
// playback, speed cycles/selects 1x · 2x · 4x · 8x, a 24-hour track carries
// clickable diurnal chapter and notable-event pins plus a scrub handle,
// Theatre mode hides the bar until the pointer nears the bottom edge, and
// `onReserveRect(rect | null)` feeds bottom-edge stacking (`publishReservedBox`).

export const RETOLD_SPEEDS = Object.freeze([1, 2, 4, 8]);
export const THEATRE_REVEAL_BOTTOM_PX = 72;

const DAY_MINUTES = 24 * 60;
const DEFAULT_DAY_MS = 24 * 60 * 60 * 1000;

export function clampScrubProgress(value) {
    const num = Number(value);
    if (!Number.isFinite(num)) return 0;
    return Math.max(0, Math.min(1, num));
}

export function nextRetoldSpeed(current = 1) {
    const numeric = Number(current);
    const index = RETOLD_SPEEDS.indexOf(numeric);
    if (index === -1) return RETOLD_SPEEDS[0];
    return RETOLD_SPEEDS[(index + 1) % RETOLD_SPEEDS.length];
}

export function formatRetoldClock(clockMs, { lower = null, upper = null, progress = 0 } = {}) {
    let ts = Number(clockMs);
    if (!Number.isFinite(ts)) {
        const start = Number(lower);
        const end = Number(upper);
        if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
            ts = start + Math.round((end - start) * clampScrubProgress(progress));
        }
    }
    if (Number.isFinite(ts)) {
        const date = new Date(ts);
        if (!Number.isNaN(date.getTime())) {
            return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
        }
    }
    const minutes = Math.round(clampScrubProgress(progress) * (DAY_MINUTES - 1));
    const hh = Math.floor(minutes / 60);
    const mm = minutes % 60;
    return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

export function shouldRevealInTheatre({
    pointerY = null,
    bottomEdge = null,
    threshold = THEATRE_REVEAL_BOTTOM_PX,
    focused = false,
    dragging = false,
} = {}) {
    if (focused || dragging) return true;
    const y = Number(pointerY);
    const bottom = Number(bottomEdge);
    const limit = Math.max(0, Number(threshold) || 0);
    if (!Number.isFinite(y) || !Number.isFinite(bottom) || bottom <= 0) return false;
    return (bottom - y) <= limit && y <= bottom + 8;
}

function defaultBandsForTrack() {
    const b = AUTHORED_DIURNAL_BANDS;
    return [
        { band: 'night', start: 0, end: b.dawnStart / DAY_MINUTES },
        { band: 'dawn', start: b.dawnStart / DAY_MINUTES, end: b.dayStart / DAY_MINUTES },
        { band: 'day', start: b.dayStart / DAY_MINUTES, end: b.duskStart / DAY_MINUTES },
        { band: 'dusk', start: b.duskStart / DAY_MINUTES, end: b.nightStart / DAY_MINUTES },
        { band: 'night', start: b.nightStart / DAY_MINUTES, end: 1 },
    ];
}

function isEditableTarget(node) {
    if (!node || typeof node !== 'object') return false;
    const tag = String(node.tagName || '').toUpperCase();
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (node.isContentEditable) return true;
    if (typeof node.closest === 'function' && node.closest('[contenteditable="true"], input, textarea, select')) {
        return true;
    }
    return false;
}

function hasOpenModal(documentRef) {
    const overlay = documentRef?.querySelector?.('.modal-overlay[aria-hidden="false"]');
    return Boolean(overlay);
}

export class RetoldScrubber {
    constructor({
        container = null,
        frame = null,
        dateKey = '',
        lower = null,
        upper = null,
        chapters = [],
        pins = [],
        speed = 1,
        paused = false,
        progress = 0,
        theatreMode = false,
        revealThresholdPx = THEATRE_REVEAL_BOTTOM_PX,
        onTogglePlay = null,
        onSpeedChange = null,
        onSeek = null,
        onReserveRect = null,
        isShortcutBlocked = null,
        documentRef = globalThis.document,
        windowRef = globalThis.window,
    } = {}) {
        this.container = container;
        this.frame = frame || container;
        this.documentRef = documentRef;
        this.windowRef = windowRef;
        this.dateKey = String(dateKey || '');
        this.lower = Number.isFinite(Number(lower)) ? Number(lower) : null;
        this.upper = Number.isFinite(Number(upper)) ? Number(upper) : null;
        this.chapters = Array.isArray(chapters) ? chapters : [];
        this.pins = Array.isArray(pins) ? pins : [];
        this.speed = RETOLD_SPEEDS.includes(Number(speed)) ? Number(speed) : RETOLD_SPEEDS[0];
        this.paused = Boolean(paused);
        this.progress = clampScrubProgress(progress);
        this.clockMs = this._clockMsForProgress(this.progress);
        this.theatreMode = Boolean(theatreMode);
        this.revealThresholdPx = Math.max(16, Number(revealThresholdPx) || THEATRE_REVEAL_BOTTOM_PX);

        this.onTogglePlay = typeof onTogglePlay === 'function' ? onTogglePlay : null;
        this.onSpeedChange = typeof onSpeedChange === 'function' ? onSpeedChange : null;
        this.onSeek = typeof onSeek === 'function' ? onSeek : null;
        this.onReserveRect = typeof onReserveRect === 'function' ? onReserveRect : null;
        this.isShortcutBlocked = typeof isShortcutBlocked === 'function' ? isShortcutBlocked : null;

        this._dragging = false;
        this._hasFocus = false;
        this._pointerY = null;
        this._hiddenInTheatre = this.theatreMode;
        this._lastReservedKey = null;
        this._resizeObserver = null;
        this._destroyed = false;

        this._onKeyDown = event => this._handleKeyDown(event);
        this._onPointerMoveGlobal = event => this._handleGlobalPointerMove(event);
        this._onPointerUpGlobal = () => this._endDrag();
        this._onWindowResize = () => this.reportReservedRect();

        this._buildDom();
        this._attachListeners();
        if (this.container && typeof this.container.append === 'function') {
            this.container.append(this.element);
        }
        this._syncState();
        this.reportReservedRect();
    }

    _clockMsForProgress(progress) {
        const p = clampScrubProgress(progress);
        if (this.lower !== null && this.upper !== null && this.upper > this.lower) {
            return this.lower + Math.round((this.upper - this.lower) * p);
        }
        return null;
    }

    _offsetMsForProgress(progress) {
        const p = clampScrubProgress(progress);
        const span = (this.lower !== null && this.upper !== null && this.upper > this.lower)
            ? (this.upper - this.lower)
            : DEFAULT_DAY_MS;
        return Math.round(span * p);
    }

    _buildDom() {
        const doc = this.documentRef;
        const make = (tag, opts, children) => {
            if (doc && doc !== globalThis.document) {
                const node = doc.createElement(tag);
                if (opts?.className) {
                    const names = Array.isArray(opts.className) ? opts.className : String(opts.className).split(/\s+/);
                    node.classList?.add?.(...names.filter(Boolean));
                }
                if (opts?.text !== undefined && opts?.text !== null) node.textContent = String(opts.text);
                if (opts?.title) node.title = String(opts.title);
                if (opts?.ariaLabel) node.setAttribute?.('aria-label', String(opts.ariaLabel));
                if (opts?.dataset && node.dataset) {
                    for (const [k, v] of Object.entries(opts.dataset)) {
                        if (v !== undefined && v !== null) node.dataset[k] = String(v);
                    }
                }
                if (children) {
                    for (const child of (Array.isArray(children) ? children : [children])) {
                        if (child != null) node.append?.(child);
                    }
                }
                return node;
            }
            return el(tag, opts, children);
        };

        this._playButton = make('button', {
            className: 'retold-scrubber__play',
            text: this.paused ? 'PLAY' : 'PAUSE',
            title: 'Toggle Retold playback (Space)',
            ariaLabel: this.paused ? 'Play recorded day' : 'Pause recorded day',
        });
        this._playButton.type = 'button';
        this._playButton.setAttribute?.('aria-pressed', String(!this.paused));
        this._playButton.addEventListener?.('click', () => this.togglePlay());

        this._clockEl = make('span', {
            className: 'retold-scrubber__clock',
            text: formatRetoldClock(this.clockMs, { lower: this.lower, upper: this.upper, progress: this.progress }),
        });

        this._dateEl = make('span', {
            className: 'retold-scrubber__date',
            text: this.dateKey ? `RETOLD · ${this.dateKey}` : 'RETOLD',
        });

        this._bandsEl = make('div', { className: 'retold-scrubber__bands' });
        this._fillEl = make('div', { className: 'retold-scrubber__fill' });
        this._pinsEl = make('div', { className: 'retold-scrubber__pins' });

        this._handleEl = make('div', {
            className: 'retold-scrubber__handle',
            ariaLabel: 'Retold 24-hour playhead',
        });
        this._handleEl.setAttribute?.('role', 'slider');
        this._handleEl.setAttribute?.('tabindex', '0');
        this._handleEl.setAttribute?.('aria-valuemin', '0');
        this._handleEl.setAttribute?.('aria-valuemax', String(DAY_MINUTES));
        this._handleEl.addEventListener?.('keydown', event => this._handleHandleKeyDown(event));

        this._trackEl = make('div', { className: 'retold-scrubber__track' }, [
            this._bandsEl,
            this._fillEl,
            this._pinsEl,
            this._handleEl,
        ]);
        this._trackEl.addEventListener?.('pointerdown', event => this._handleTrackPointerDown(event));

        this._scaleEl = make('div', { className: 'retold-scrubber__scale' }, [
            make('span', { text: '00' }),
            make('span', { text: '06' }),
            make('span', { text: '12' }),
            make('span', { text: '18' }),
            make('span', { text: '24' }),
        ]);

        this._speedButtons = new Map();
        const speedNodes = RETOLD_SPEEDS.map(multiplier => {
            const btn = make('button', {
                className: 'retold-scrubber__speed',
                text: `${multiplier}×`,
                title: `Set replay speed to ${multiplier}×`,
                ariaLabel: `Replay speed ${multiplier}x`,
                dataset: { speed: multiplier },
            });
            btn.type = 'button';
            btn.setAttribute?.('aria-pressed', String(multiplier === this.speed));
            btn.addEventListener?.('click', () => this.setSpeed(multiplier));
            this._speedButtons.set(multiplier, btn);
            return btn;
        });
        this._speedsEl = make('div', {
            className: ['retold-scrubber__speeds', 'cv-frame', 'cv-frame--well'],
            ariaLabel: 'Replay speed',
        }, speedNodes);

        this._trackColumnEl = make('div', { className: 'retold-scrubber__timeline' }, [
            make('div', { className: 'retold-scrubber__meta' }, [this._dateEl, this._clockEl]),
            this._trackEl,
            this._scaleEl,
        ]);

        this.element = make('aside', {
            className: ['retold-scrubber', 'cv-frame', 'cv-frame--walnut'],
            ariaLabel: 'Day Retold playback controls',
        }, [
            this._playButton,
            this._trackColumnEl,
            this._speedsEl,
        ]);
        this.element.addEventListener?.('focusin', () => {
            this._hasFocus = true;
            this._syncTheatreVisibility();
        });
        this.element.addEventListener?.('focusout', event => {
            const next = event?.relatedTarget;
            this._hasFocus = Boolean(next && this.element.contains?.(next));
            this._syncTheatreVisibility();
        });

        this._renderBands();
        this._renderPins();
    }

    _attachListeners() {
        this.windowRef?.addEventListener?.('keydown', this._onKeyDown);
        this.windowRef?.addEventListener?.('pointermove', this._onPointerMoveGlobal);
        this.windowRef?.addEventListener?.('pointerup', this._onPointerUpGlobal);
        this.windowRef?.addEventListener?.('pointercancel', this._onPointerUpGlobal);
        this.windowRef?.addEventListener?.('resize', this._onWindowResize);

        if (typeof globalThis.ResizeObserver === 'function' && this.element) {
            this._resizeObserver = new globalThis.ResizeObserver(() => this.reportReservedRect());
            this._resizeObserver.observe(this.element);
            if (this.frame && this.frame !== this.element) {
                this._resizeObserver.observe(this.frame);
            }
        }
    }

    _renderBands() {
        if (!this._bandsEl) return;
        const span = (this.lower !== null && this.upper !== null && this.upper > this.lower)
            ? (this.upper - this.lower)
            : DEFAULT_DAY_MS;
        const segments = this.chapters.length
            ? this.chapters.map(chapter => ({
                band: chapter.band || 'night',
                start: clampScrubProgress(chapter.startMs / span),
                end: clampScrubProgress(chapter.endMs / span),
            }))
            : defaultBandsForTrack();
        const children = segments.map(segment => {
            const node = this.documentRef.createElement('span');
            node.classList?.add?.('retold-scrubber__band', `retold-scrubber__band--${segment.band}`);
            if (node.style) {
                node.style.left = `${(segment.start * 100).toFixed(3)}%`;
                node.style.width = `${(Math.max(0, segment.end - segment.start) * 100).toFixed(3)}%`;
            }
            return node;
        });
        if (typeof this._bandsEl.replaceChildren === 'function') {
            this._bandsEl.replaceChildren(...children);
        } else {
            this._bandsEl.children = children;
        }
    }

    _renderPins() {
        if (!this._pinsEl) return;
        const children = this.pins.map(pin => {
            const p = clampScrubProgress(pin.progress);
            const button = this.documentRef.createElement('button');
            button.type = 'button';
            button.classList?.add?.(
                'retold-scrubber__pin',
                `retold-scrubber__pin--${pin.type || 'event'}`,
                `retold-scrubber__pin--${pin.kind || 'chapter'}`,
            );
            if (button.dataset) {
                button.dataset.pinId = String(pin.id || '');
                button.dataset.pinKind = String(pin.kind || 'chapter');
                button.dataset.pinType = String(pin.type || 'event');
            }
            button.title = String(pin.label || pin.shortLabel || 'Jump to chapter');
            button.setAttribute?.('aria-label', `Jump to ${pin.label || pin.shortLabel || 'chapter'}`);
            if (button.style) button.style.left = `${(p * 100).toFixed(3)}%`;
            button.addEventListener?.('pointerdown', event => event.stopPropagation?.());
            button.addEventListener?.('click', event => {
                event.stopPropagation?.();
                this.seekToPin(pin);
            });
            return button;
        });
        if (typeof this._pinsEl.replaceChildren === 'function') {
            this._pinsEl.replaceChildren(...children);
        } else {
            this._pinsEl.children = children;
        }
    }

    _handleKeyDown(event) {
        if (this._destroyed || !event) return;
        const isSpace = event.code === 'Space' || event.key === ' ';
        if (!isSpace || event.repeat || event.ctrlKey || event.metaKey || event.altKey) return;
        if (this.isShortcutBlocked?.(event)) return;
        if (hasOpenModal(this.documentRef)) return;
        const target = event.target || this.documentRef?.activeElement;
        if (isEditableTarget(target)) return;
        // Let native Space activation handle focused buttons without double-toggling.
        if (String(target?.tagName || '').toUpperCase() === 'BUTTON') return;
        event.preventDefault?.();
        this.togglePlay();
    }

    _handleHandleKeyDown(event) {
        if (this._destroyed || !event) return;
        const step = event.shiftKey ? (60 / DAY_MINUTES) : (15 / DAY_MINUTES);
        if (event.key === 'ArrowLeft') {
            event.preventDefault?.();
            this.seekToProgress(this.progress - step);
        } else if (event.key === 'ArrowRight') {
            event.preventDefault?.();
            this.seekToProgress(this.progress + step);
        } else if (event.key === 'Home') {
            event.preventDefault?.();
            this.seekToProgress(0);
        } else if (event.key === 'End') {
            event.preventDefault?.();
            this.seekToProgress(1);
        }
    }

    _progressFromPointer(event) {
        const rect = this._trackEl?.getBoundingClientRect?.();
        if (!rect || !(rect.width > 0)) return this.progress;
        return clampScrubProgress(((Number(event?.clientX) || 0) - rect.left) / rect.width);
    }

    _handleTrackPointerDown(event) {
        if (this._destroyed) return;
        if (event?.button !== undefined && event.button !== 0) return;
        this._dragging = true;
        this._trackEl?.setPointerCapture?.(event.pointerId);
        this.seekToProgress(this._progressFromPointer(event));
        this._syncTheatreVisibility();
    }

    _handleGlobalPointerMove(event) {
        if (this._destroyed || !event) return;
        if (Number.isFinite(Number(event.clientY))) {
            this._pointerY = Number(event.clientY);
        }
        if (this._dragging) {
            this.seekToProgress(this._progressFromPointer(event));
        }
        if (this.theatreMode) {
            this._syncTheatreVisibility();
        }
    }

    _endDrag() {
        if (!this._dragging) return;
        this._dragging = false;
        this._syncTheatreVisibility();
    }

    _bottomEdgePx() {
        const frameRect = this.frame?.getBoundingClientRect?.();
        if (frameRect && Number.isFinite(frameRect.bottom) && frameRect.bottom > 0) {
            return frameRect.bottom;
        }
        const innerHeight = Number(this.windowRef?.innerHeight);
        return Number.isFinite(innerHeight) && innerHeight > 0 ? innerHeight : null;
    }

    _syncTheatreVisibility() {
        const shouldHide = this.theatreMode && !shouldRevealInTheatre({
            pointerY: this._pointerY,
            bottomEdge: this._bottomEdgePx(),
            threshold: this.revealThresholdPx,
            focused: this._hasFocus,
            dragging: this._dragging,
        });
        this._hiddenInTheatre = shouldHide;
        this.element?.classList?.toggle?.('retold-scrubber--theatre', this.theatreMode);
        this.element?.classList?.toggle?.('retold-scrubber--hidden', shouldHide);
        this.element?.setAttribute?.('aria-hidden', String(shouldHide));
        this.reportReservedRect();
    }

    _syncState() {
        const pct = `${(this.progress * 100).toFixed(3)}%`;
        if (this._fillEl?.style) this._fillEl.style.width = pct;
        if (this._handleEl?.style) this._handleEl.style.left = pct;
        const clockText = formatRetoldClock(this.clockMs, {
            lower: this.lower,
            upper: this.upper,
            progress: this.progress,
        });
        if (this._clockEl) this._clockEl.textContent = clockText;
        if (this._handleEl) {
            this._handleEl.setAttribute?.('aria-valuenow', String(Math.round(this.progress * DAY_MINUTES)));
            this._handleEl.setAttribute?.('aria-valuetext', clockText);
        }
        if (this._playButton) {
            this._playButton.textContent = this.paused ? 'PLAY' : 'PAUSE';
            this._playButton.setAttribute?.('aria-pressed', String(!this.paused));
            this._playButton.setAttribute?.('aria-label', this.paused ? 'Play recorded day' : 'Pause recorded day');
            this._playButton.classList?.toggle?.('retold-scrubber__play--paused', this.paused);
        }
        for (const [multiplier, btn] of this._speedButtons.entries()) {
            const active = multiplier === this.speed;
            btn.setAttribute?.('aria-pressed', String(active));
            btn.classList?.toggle?.('retold-scrubber__speed--active', active);
        }
        this._syncTheatreVisibility();
    }

    togglePlay() {
        return this.setPaused(!this.paused);
    }

    setPaused(paused, { notify = true } = {}) {
        if (this._destroyed) return this.paused;
        const next = Boolean(paused);
        this.paused = next;
        this._syncState();
        if (notify) this.onTogglePlay?.(next);
        return next;
    }

    setSpeed(multiplier, { notify = true } = {}) {
        if (this._destroyed) return this.speed;
        const value = Number(multiplier);
        if (!RETOLD_SPEEDS.includes(value)) return this.speed;
        this.speed = value;
        this._syncState();
        if (notify) this.onSpeedChange?.(value);
        return value;
    }

    cycleSpeed() {
        return this.setSpeed(nextRetoldSpeed(this.speed));
    }

    seekToProgress(progress, { pin = null, notify = true } = {}) {
        if (this._destroyed) return this.progress;
        const next = clampScrubProgress(progress);
        this.progress = next;
        this.clockMs = pin && Number.isFinite(Number(pin.clockMs))
            ? Number(pin.clockMs)
            : this._clockMsForProgress(next);
        const ts = pin && Number.isFinite(Number(pin.ts))
            ? Number(pin.ts)
            : this._offsetMsForProgress(next);
        this._syncState();
        if (notify) {
            this.onSeek?.({
                progress: this.progress,
                ts,
                clockMs: this.clockMs,
                pin,
            });
        }
        return this.progress;
    }

    seekToPin(pin) {
        if (!pin || this._destroyed) return this.progress;
        const progress = Number.isFinite(Number(pin.progress))
            ? Number(pin.progress)
            : (this.lower !== null && this.upper !== null && this.upper > this.lower && Number.isFinite(Number(pin.ts))
                ? pin.ts / (this.upper - this.lower)
                : 0);
        return this.seekToProgress(progress, { pin, notify: true });
    }

    setPins(pins = []) {
        this.pins = Array.isArray(pins) ? pins : [];
        this._renderPins();
    }

    setChapters(chapters = []) {
        this.chapters = Array.isArray(chapters) ? chapters : [];
        this._renderBands();
    }

    setTheatreMode(active) {
        if (this._destroyed) return;
        this.theatreMode = Boolean(active);
        this._syncTheatreVisibility();
    }

    update({ progress, clockMs, paused, speed } = {}) {
        if (this._destroyed) return;
        if (progress !== undefined && !this._dragging) this.progress = clampScrubProgress(progress);
        if (clockMs !== undefined && Number.isFinite(Number(clockMs)) && !this._dragging) {
            this.clockMs = Number(clockMs);
        } else if (progress !== undefined && !this._dragging) {
            this.clockMs = this._clockMsForProgress(this.progress);
        }
        if (paused !== undefined) this.paused = Boolean(paused);
        if (speed !== undefined && RETOLD_SPEEDS.includes(Number(speed))) this.speed = Number(speed);
        this._syncState();
    }

    isHiddenInTheatre() {
        return this._hiddenInTheatre;
    }

    reportReservedRect() {
        if (!this.onReserveRect) return null;
        let rect = null;
        if (!this._destroyed && !this._hiddenInTheatre && this.element) {
            const box = this.element.getBoundingClientRect?.();
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
        this._destroyed = true;
        this._dragging = false;
        this.windowRef?.removeEventListener?.('keydown', this._onKeyDown);
        this.windowRef?.removeEventListener?.('pointermove', this._onPointerMoveGlobal);
        this.windowRef?.removeEventListener?.('pointerup', this._onPointerUpGlobal);
        this.windowRef?.removeEventListener?.('pointercancel', this._onPointerUpGlobal);
        this.windowRef?.removeEventListener?.('resize', this._onWindowResize);
        this._resizeObserver?.disconnect?.();
        this._resizeObserver = null;
        if (this._lastReservedKey !== 'null') {
            this._lastReservedKey = 'null';
            this.onReserveRect?.(null);
        }
        this.element?.remove?.();
        this.element = null;
        this.onTogglePlay = null;
        this.onSpeedChange = null;
        this.onSeek = null;
        this.onReserveRect = null;
    }
}
