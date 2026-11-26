// Wave 4 (Spec 04 §4.7) — The Glass: an opt-in 220 px circular inspection lens
// clipped by 220 one-pixel-high integer row spans (hard-stepped, zero
// anti-aliasing, zero canvas circular-path primitives).
//
// Pointer contract (repo generic-input rule: mouse unchanged):
//   - Setting gated (`claudeville.world.glass`, default `'off'`). When off,
//     `KeyG` is a no-op and touch/pen arming stays off. `KeyL` is never bound.
//   - Mouse: hold `G` (`KeyG`); lens tracks pointermove on the overlay canvas
//     without intercepting clicks, drags, wheel, or hover. Releases on keyup
//     or window blur.
//   - Touch/pen: armed via a dock button (`setArmed(true)`). One-finger drag
//     positions the lens centre 134 px above the finger (`y - 134`); taps still
//     select at contact and multi-touch gestures pan/zoom unchanged.
//   - Cutaway dwell: resting the lens centre over a building at `z >= 2` opens
//     its cutaway (`source: 'glass'`) after 300 ms continuous dwell and closes
//     it 400 ms after leaving, one building at a time, yielding immediately to
//     any selection-opened cutaway.

import { ART_RAMPS } from '../../config/artPalette.js';
import { postcardFrame } from './Postcard.js';

export const GLASS_STORAGE_KEY = 'claudeville.world.glass';
export const GLASS_MODES = Object.freeze(['off', 'on']);
export const GLASS_DEFAULT_MODE = 'off';
export const GLASS_EVENT = 'world:glass-setting';

export const GLASS_DIAMETER = 220;
export const GLASS_RADIUS = 110;
export const GLASS_RIM_THICKNESS = 4;
export const GLASS_RIM_SIZE = 228;
export const GLASS_RIM_ANCHOR = Object.freeze([114, 114]);
export const GLASS_DWELL_MS = 300;
export const GLASS_EXIT_MS = 400;
export const GLASS_TOUCH_OFFSET_Y = 134;
export const GLASS_TOUCH_DRAG_THRESHOLD_PX = 6;
export const GLASS_CUTAWAY_MIN_ZOOM = 2;

export const GLASS_RIM_ASSET_ID = 'overlay.inspectionGlass.rim';

const RIM_INK = '#060402';
const RIM_LIT = ART_RAMPS.trimGold[2];
const RIM_MID = ART_RAMPS.trimGold[1];
const RIM_SHADE = ART_RAMPS.clothOchre[0];

export function normalizeGlassSetting(value) {
    return value === 'on' ? 'on' : GLASS_DEFAULT_MODE;
}

export function readGlassSetting(storage = globalThis.window?.localStorage) {
    try {
        return normalizeGlassSetting(storage?.getItem(GLASS_STORAGE_KEY) ?? null);
    } catch {
        return GLASS_DEFAULT_MODE;
    }
}

export function writeGlassSetting(value, storage = globalThis.window?.localStorage) {
    const mode = normalizeGlassSetting(value);
    try {
        storage?.setItem(GLASS_STORAGE_KEY, mode);
    } catch {
        /* storage is optional */
    }
    return mode;
}

/**
 * Compute an exact 4-way symmetric integer row-span table for an even-diameter
 * (`2 * radius`) pixel disc using exact half-integer pixel centres:
 *   (2 * dx + 1)^2 + (2 * dy + 1)^2 <= (2 * radius)^2.
 * Returns `2 * radius` frozen `{ y, x0, width }` entries for `y` in
 * `[-radius .. radius - 1]`. Zero floating-point trig or smooth curves.
 */
export function computeSteppedDiscSpans(radius) {
    const r = Math.max(1, Math.floor(Number(radius) || 0));
    const limitSq = (2 * r) * (2 * r);
    const spans = new Array(2 * r);
    for (let i = 0; i < 2 * r; i++) {
        const y = i - r;
        const py2 = (2 * y + 1) * (2 * y + 1);
        const rem = limitSq - py2;
        let half = 0;
        if (rem >= 1) {
            // Largest integer `half` such that (2 * (half - 1) + 1)^2 <= rem.
            let maxOdd = Math.floor(Math.sqrt(rem));
            while ((maxOdd + 1) * (maxOdd + 1) <= rem) maxOdd++;
            while (maxOdd * maxOdd > rem) maxOdd--;
            if ((maxOdd & 1) === 0) maxOdd--;
            half = maxOdd >= 1 ? ((maxOdd + 1) >> 1) : 0;
        }
        spans[i] = Object.freeze({ y, x0: -half, width: half * 2 });
    }
    return Object.freeze(spans);
}

/** Precomputed 220-entry integer row-span table for the 220 px hard-stepped disc. */
export const GLASS_ROW_SPANS = computeSteppedDiscSpans(GLASS_RADIUS);

/** Precomputed 228-entry outer disc span table used by the procedural rim fallback and baker. */
export const GLASS_OUTER_ROW_SPANS = computeSteppedDiscSpans(GLASS_RADIUS + GLASS_RIM_THICKNESS);

/**
 * Clip `ctx` to the exact union of the 220 one-pixel-high stepped rectangles
 * centred on `(Math.round(cx), Math.round(cy))`. Hard pixel steps at integer DPR.
 */
export function applyGlassClip(ctx, cx, cy) {
    const ix = Math.round(cx);
    const iy = Math.round(cy);
    ctx.beginPath();
    for (let i = 0; i < GLASS_ROW_SPANS.length; i++) {
        const span = GLASS_ROW_SPANS[i];
        ctx.rect(ix + span.x0, iy + span.y, span.width, 1);
    }
    ctx.clip();
}

/**
 * Exact point-in-disc predicate matching `GLASS_ROW_SPANS` and `applyGlassClip`.
 */
export function inGlass(cx, cy, x, y) {
    if (!Number.isFinite(cx) || !Number.isFinite(cy) || !Number.isFinite(x) || !Number.isFinite(y)) {
        return false;
    }
    const row = Math.floor(y) - Math.round(cy);
    const idx = row + GLASS_RADIUS;
    if (idx < 0 || idx >= GLASS_ROW_SPANS.length) return false;
    const span = GLASS_ROW_SPANS[idx];
    const col = Math.floor(x) - Math.round(cx);
    return col >= span.x0 && col < span.x0 + span.width;
}

/**
 * Procedural 1 px pixel-art fallback rim drawn purely with `fillRect` from
 * `GLASS_OUTER_ROW_SPANS` minus `GLASS_ROW_SPANS` when the rim PNG is not yet
 * loaded. Never touches a smooth circle path.
 */
function drawProceduralRim(ctx, cx, cy) {
    const ix = Math.round(cx);
    const iy = Math.round(cy);
    const outerRadius = GLASS_RADIUS + GLASS_RIM_THICKNESS;
    for (let i = 0; i < GLASS_OUTER_ROW_SPANS.length; i++) {
        const outer = GLASS_OUTER_ROW_SPANS[i];
        const y = outer.y;
        const innerIdx = y + GLASS_RADIUS;
        const inner = (innerIdx >= 0 && innerIdx < GLASS_ROW_SPANS.length)
            ? GLASS_ROW_SPANS[innerIdx]
            : null;
        const outerLeft = outer.x0;
        const outerRight = outer.x0 + outer.width;
        const py = iy + y;
        if (!inner) {
            // Top / bottom 4-row brass caps: outer ink row, 2 brass rows, inner ink row.
            const edge = y === -outerRadius || y === outerRadius - 1;
            const innerEdge = y === -GLASS_RADIUS - 1 || y === GLASS_RADIUS;
            ctx.fillStyle = (edge || innerEdge) ? RIM_INK : (y < 0 ? RIM_LIT : RIM_SHADE);
            ctx.fillRect(ix + outerLeft, py, outer.width, 1);
            ctx.fillStyle = RIM_INK;
            ctx.fillRect(ix + outerLeft, py, 1, 1);
            ctx.fillRect(ix + outerRight - 1, py, 1, 1);
            continue;
        }
        const innerLeft = inner.x0;
        const innerRight = inner.x0 + inner.width;
        const leftW = innerLeft - outerLeft;
        const rightW = outerRight - innerRight;
        if (leftW > 0) {
            ctx.fillStyle = RIM_INK;
            ctx.fillRect(ix + outerLeft, py, 1, 1);
            if (leftW > 2) {
                ctx.fillStyle = y < 0 ? RIM_LIT : RIM_MID;
                ctx.fillRect(ix + outerLeft + 1, py, leftW - 2, 1);
            }
            if (leftW > 1) {
                ctx.fillStyle = RIM_INK;
                ctx.fillRect(ix + innerLeft - 1, py, 1, 1);
            }
        }
        if (rightW > 0) {
            ctx.fillStyle = RIM_INK;
            ctx.fillRect(ix + innerRight, py, 1, 1);
            if (rightW > 2) {
                ctx.fillStyle = y < 0 ? RIM_MID : RIM_SHADE;
                ctx.fillRect(ix + innerRight + 1, py, rightW - 2, 1);
            }
            if (rightW > 1) {
                ctx.fillStyle = RIM_INK;
                ctx.fillRect(ix + outerRight - 1, py, 1, 1);
            }
        }
    }
}

export class InspectionGlass {
    constructor({ enabled = null, storage = null } = {}) {
        if (typeof enabled === 'boolean') {
            this._enabled = enabled;
        } else if (storage) {
            this._enabled = readGlassSetting(storage) === 'on';
        } else {
            this._enabled = false;
        }
        this._keyHeld = false;
        this._armed = false;
        this._touchActive = false;
        this._activePointerId = null;
        this._activePointers = new Set();
        this._touchStart = null;
        this._pointerX = null;
        this._pointerY = null;
        this._cx = null;
        this._cy = null;

        this._cutawayBuildingId = null;
        this._dwellBuildingId = null;
        this._dwellSinceMs = null;
        this._exitSinceMs = null;
    }

    get enabled() {
        return this._enabled;
    }

    get armed() {
        return this._armed;
    }

    get active() {
        return this.isActive();
    }

    get center() {
        return this.getCenter();
    }

    get cutawayBuildingId() {
        return this._cutawayBuildingId;
    }

    setEnabled(flag) {
        const next = Boolean(flag);
        if (this._enabled === next) return this._enabled;
        this._enabled = next;
        if (!next) {
            this._keyHeld = false;
            this._armed = false;
            this._clearTouchState();
            this._cx = null;
            this._cy = null;
            this._resetCutaway();
        }
        return this._enabled;
    }

    setArmed(flag) {
        if (!this._enabled) {
            this._armed = false;
            this._clearTouchState();
            return false;
        }
        const next = Boolean(flag);
        this._armed = next;
        if (!next) {
            this._clearTouchState();
            if (!this._keyHeld) {
                this._cx = null;
                this._cy = null;
            }
        }
        return this._armed;
    }

    toggleArmed() {
        return this.setArmed(!this._armed);
    }

    isActive() {
        if (!this._enabled) return false;
        const showing = this._keyHeld || (this._armed && this._touchActive);
        return showing && Number.isFinite(this._cx) && Number.isFinite(this._cy);
    }

    getCenter() {
        if (!this.isActive()) return null;
        return { x: this._cx, y: this._cy };
    }

    inLens(x, y) {
        if (!this.isActive()) return false;
        return inGlass(this._cx, this._cy, x, y);
    }

    applyClip(ctx) {
        if (!this.isActive()) return false;
        applyGlassClip(ctx, this._cx, this._cy);
        return true;
    }

    /**
     * Handle keyboard press. Setting-gated; binds `KeyG` only (`KeyL` is never
     * bound). Returns true only when `KeyG` was accepted.
     */
    onKeyDown(eventOrCode, { blocked = false } = {}) {
        if (!this._enabled || blocked) return false;
        const isObj = eventOrCode && typeof eventOrCode === 'object';
        const code = isObj ? eventOrCode.code : eventOrCode;
        if (code !== 'KeyG') return false;
        if (isObj && (eventOrCode.ctrlKey || eventOrCode.metaKey || eventOrCode.altKey)) return false;
        this._keyHeld = true;
        if (Number.isFinite(this._pointerX) && Number.isFinite(this._pointerY)) {
            this._cx = Math.round(this._pointerX);
            this._cy = Math.round(this._pointerY);
        }
        return true;
    }

    onKeyUp(eventOrCode) {
        const code = (eventOrCode && typeof eventOrCode === 'object') ? eventOrCode.code : eventOrCode;
        if (code !== 'KeyG') return false;
        const wasHeld = this._keyHeld;
        this._keyHeld = false;
        if (!this._touchActive) {
            this._cx = null;
            this._cy = null;
        }
        return wasHeld;
    }

    onBlur() {
        this._keyHeld = false;
        this._clearTouchState();
        this._cx = null;
        this._cy = null;
        this._resetCutaway();
    }

    /**
     * Generic pointer-down handler. Mouse returns false untouched; armed
     * touch/pen tracks single-finger contact without blocking tap selection or
     * two-finger pan/zoom.
     */
    onPointerDown(x, y, { pointerType = 'mouse', pointerId = 0 } = {}) {
        if (pointerType === 'mouse') {
            this._recordMouse(x, y);
            return false;
        }
        if (pointerType !== 'touch' && pointerType !== 'pen') return false;
        if (!this._enabled || !this._armed) return false;
        this._activePointers.add(pointerId);
        if (this._activePointers.size > 1) {
            // Multi-touch pan/zoom takes over cleanly.
            this._touchActive = false;
            this._activePointerId = null;
            this._touchStart = null;
            if (!this._keyHeld) {
                this._cx = null;
                this._cy = null;
            }
            return false;
        }
        this._activePointerId = pointerId;
        this._touchStart = { x, y };
        this._touchActive = false;
        return false;
    }

    /**
     * Generic pointer-move handler. Mouse tracks cursor passively (returns
     * false so clicks, drags, wheel and hover are unchanged). Armed single-
     * finger touch/pen drag positions the lens 134 px above contact and returns
     * true so pan is suppressed during the Glass drag.
     */
    onPointerMove(x, y, { pointerType = 'mouse', pointerId = 0 } = {}) {
        if (pointerType === 'mouse') {
            this._recordMouse(x, y);
            return false;
        }
        if (pointerType !== 'touch' && pointerType !== 'pen') return false;
        if (!this._enabled || !this._armed) return false;
        if (this._activePointers.size !== 1 || this._activePointerId !== pointerId) return false;
        if (!this._touchActive && this._touchStart) {
            const dist = Math.hypot(x - this._touchStart.x, y - this._touchStart.y);
            if (dist < GLASS_TOUCH_DRAG_THRESHOLD_PX) return false;
            this._touchActive = true;
        }
        if (this._touchActive) {
            this._cx = Math.round(x);
            this._cy = Math.round(y - GLASS_TOUCH_OFFSET_Y);
            return true;
        }
        return false;
    }

    /**
     * Generic pointer-up / cancel handler. Returns true if a touch/pen Glass
     * drag was consumed (so the caller skips tap selection), false for taps
     * and mouse events (preserving tap selection and mouse behavior).
     */
    onPointerUp(x, y, { pointerType = 'mouse', pointerId = 0 } = {}) {
        if (pointerType === 'mouse') {
            this._recordMouse(x, y);
            return false;
        }
        if (pointerType !== 'touch' && pointerType !== 'pen') return false;
        this._activePointers.delete(pointerId);
        const consumedDrag = this._touchActive && this._activePointerId === pointerId;
        if (this._activePointerId === pointerId) {
            this._touchActive = false;
            this._activePointerId = null;
            this._touchStart = null;
            if (!this._keyHeld) {
                this._cx = null;
                this._cy = null;
            }
        }
        return consumedDrag;
    }

    onPointerCancel(pointerId = 0, { pointerType = 'touch' } = {}) {
        return this.onPointerUp(0, 0, { pointerType, pointerId });
    }

    /**
     * Advance the 300 ms dwell / 400 ms exit cutaway state machine.
     * Selection-opened cutaways always take priority; at most one building is
     * opened at a time, and only at `zoom >= 2`.
     */
    updateCutaway({
        buildingId = null,
        zoom = 1,
        selectionCutawayActive = false,
        nowMs = Date.now(),
    } = {}) {
        const prev = this._cutawayBuildingId;
        if (selectionCutawayActive) {
            this._resetCutaway();
            return {
                buildingId: null,
                source: null,
                changed: prev !== null,
            };
        }

        const target = (this.isActive() && Number(zoom) >= GLASS_CUTAWAY_MIN_ZOOM && buildingId)
            ? String(buildingId)
            : null;

        if (this._cutawayBuildingId) {
            if (target === this._cutawayBuildingId) {
                this._exitSinceMs = null;
                this._dwellBuildingId = null;
                this._dwellSinceMs = null;
            } else {
                if (this._exitSinceMs === null) this._exitSinceMs = nowMs;
                if (target) {
                    if (this._dwellBuildingId !== target) {
                        this._dwellBuildingId = target;
                        this._dwellSinceMs = nowMs;
                    } else if (nowMs - this._dwellSinceMs >= GLASS_DWELL_MS) {
                        this._cutawayBuildingId = target;
                        this._exitSinceMs = null;
                        this._dwellBuildingId = null;
                        this._dwellSinceMs = null;
                    }
                } else {
                    this._dwellBuildingId = null;
                    this._dwellSinceMs = null;
                }
                if (this._cutawayBuildingId === prev && this._exitSinceMs !== null
                    && nowMs - this._exitSinceMs >= GLASS_EXIT_MS) {
                    this._cutawayBuildingId = null;
                    this._exitSinceMs = null;
                }
            }
        } else {
            this._exitSinceMs = null;
            if (target) {
                if (this._dwellBuildingId !== target) {
                    this._dwellBuildingId = target;
                    this._dwellSinceMs = nowMs;
                } else if (nowMs - this._dwellSinceMs >= GLASS_DWELL_MS) {
                    this._cutawayBuildingId = target;
                    this._dwellBuildingId = null;
                    this._dwellSinceMs = null;
                }
            } else {
                this._dwellBuildingId = null;
                this._dwellSinceMs = null;
            }
        }

        return {
            buildingId: this._cutawayBuildingId,
            source: this._cutawayBuildingId ? 'glass' : null,
            changed: prev !== this._cutawayBuildingId,
        };
    }

    /**
     * Draw the 228x228 brass bezel stamp (or procedural 1 px fallback) centred
     * at `(Math.round(cx - 114), Math.round(cy - 114))`. Skipped during
     * `postcardFrame()`.
     */
    drawRim(ctx, assets = null) {
        if (!ctx || !this.isActive() || postcardFrame()) return false;
        const left = Math.round(this._cx - GLASS_RIM_ANCHOR[0]);
        const top = Math.round(this._cy - GLASS_RIM_ANCHOR[1]);
        const rimImage = assets?.get?.(GLASS_RIM_ASSET_ID)
            || (assets && typeof assets === 'object' ? assets[GLASS_RIM_ASSET_ID] : null)
            || null;
        ctx.save();
        ctx.imageSmoothingEnabled = false;
        if (rimImage) {
            ctx.drawImage(rimImage, left, top, GLASS_RIM_SIZE, GLASS_RIM_SIZE);
        } else {
            drawProceduralRim(ctx, this._cx, this._cy);
        }
        ctx.restore();
        return true;
    }

    _recordMouse(x, y) {
        if (!Number.isFinite(x) || !Number.isFinite(y)) return;
        this._pointerX = x;
        this._pointerY = y;
        if (this._enabled && this._keyHeld) {
            this._cx = Math.round(x);
            this._cy = Math.round(y);
        }
    }

    _clearTouchState() {
        this._touchActive = false;
        this._activePointerId = null;
        this._activePointers.clear();
        this._touchStart = null;
    }

    _resetCutaway() {
        this._cutawayBuildingId = null;
        this._dwellBuildingId = null;
        this._dwellSinceMs = null;
        this._exitSinceMs = null;
    }
}
