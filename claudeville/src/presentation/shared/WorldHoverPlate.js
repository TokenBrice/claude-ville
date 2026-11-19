// XP-4 — the World's own hover plate. World hover text (buildings, ships,
// lanterns, token items, repo stones, the belfry, a villager) shows on a
// walnut `cv-frame--bg2` plate beside the pointer instead of the OS `title`
// bubble: 250 ms after the pointer settles on something, at once while
// another plate closed less than 300 ms ago, two lines at most, no
// transition (it steps in like the chrome tooltip, so reduced motion has
// nothing to drop). Leaving a target keeps the plate for one short grace so
// a sweep across neighbouring targets swaps text instead of blinking.
// `villagerHoverLine` and `hoverPlateLines` are pure (node-tested).

import { BUILDING_DEFS } from '../../config/buildings.js';
import { formatElapsed } from './Formatters.js';
import { currentToolPresentation } from './AgentPresentation.js';

export const HOVER_PLATE_DELAY_MS = 250;
const WARM_WINDOW_MS = 300;
const HIDE_GRACE_MS = 120;
const POINTER_GAP = 16;
const TARGET_GAP = 8;
const EDGE = 8;

const BUILDING_NAMES = new Map(BUILDING_DEFS.map((def) => {
    const label = String(def.shortLabel || def.label || def.type);
    return [def.type, label.charAt(0) + label.slice(1).toLowerCase()];
}));

// Lore text as at most two plate lines: the first line stays the head, any
// further lines fold into the second, joined by ' · '.
export function hoverPlateLines(text) {
    const lines = String(text || '').split('\n').map((line) => line.trim()).filter(Boolean);
    return lines.length > 2 ? [lines[0], lines.slice(1).join(' · ')] : lines;
}

// A villager's line, from fields the sidebar and panel already show:
// `name · building · tool · age`. Never speech. Absent fields drop out.
export function villagerHoverLine(agent, { buildingType = null, now = Date.now() } = {}) {
    if (!agent) return '';
    const since = Number(agent.statusSince);
    const parts = [
        agent.name || '',
        BUILDING_NAMES.get(buildingType) || '',
        currentToolPresentation(agent)?.name || '',
        Number.isFinite(since) && since > 0 ? formatElapsed(Math.max(0, now - since)) : '',
    ];
    return parts.filter(Boolean).join(' · ');
}

function overlapArea(a, b) {
    return Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left))
        * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
}

// Where a w x h plate goes in a W x H host: beside `target` (the inspected
// thing's screen rect) when given, else off the pointer. The first spot that
// fits the host and clears the target and every reserved rect wins; else each
// spot is clamped into the host and judged again, and the one covering the
// least of the target (then of the chrome) wins.
export function placeHoverPlate({ point, target = null, width, height, hostWidth, hostHeight, reserved = [] }) {
    const candidates = target
        ? [
            [target.right + TARGET_GAP, point.y - height / 2],
            [target.left - TARGET_GAP - width, point.y - height / 2],
            [point.x - width / 2, target.bottom + TARGET_GAP],
            [point.x - width / 2, target.top - TARGET_GAP - height],
        ]
        : [
            [point.x + POINTER_GAP, point.y + POINTER_GAP],
            [point.x - POINTER_GAP - width, point.y + POINTER_GAP],
            [point.x + POINTER_GAP, point.y - POINTER_GAP - height],
            [point.x - POINTER_GAP - width, point.y - POINTER_GAP - height],
        ];
    const clamp = ([x, y]) => ({
        x: Math.round(Math.max(EDGE, Math.min(hostWidth - width - EDGE, x))),
        y: Math.round(Math.max(EDGE, Math.min(hostHeight - height - EDGE, y))),
    });
    // With no bounds, the pointer itself is what the plate must not cover.
    const avoid = target || { left: point.x - 4, top: point.y - 4, right: point.x + 4, bottom: point.y + 4 };
    // First a spot that fits as it is (a flip), then the clamped spots.
    for (const [x, y] of candidates) {
        const rect = { left: x, top: y, right: x + width, bottom: y + height };
        const inside = x >= EDGE && y >= EDGE && rect.right <= hostWidth - EDGE && rect.bottom <= hostHeight - EDGE;
        if (inside && overlapArea(rect, avoid) === 0 && !reserved.some((r) => overlapArea(rect, r) > 0)) {
            return { x: Math.round(x), y: Math.round(y) };
        }
    }
    let best = null;
    for (const candidate of candidates) {
        const spot = clamp(candidate);
        const rect = { left: spot.x, top: spot.y, right: spot.x + width, bottom: spot.y + height };
        const covered = overlapArea(rect, avoid);
        const chrome = reserved.reduce((sum, r) => sum + overlapArea(rect, r), 0);
        if (covered === 0 && chrome === 0) return spot;
        if (!best || covered < best.covered || (covered === best.covered && chrome < best.chrome)) {
            best = { spot, covered, chrome };
        }
    }
    return best.spot;
}

export class WorldHoverPlate {
    // `resample()` returns what is under the pointer now (`{ text, target }`),
    // read again when a delayed plate reveals.
    constructor({ host, reservedRects = () => [], resample = null } = {}) {
        this.host = host;
        this.reservedRects = reservedRects;
        this.resample = resample;
        this._held = false;
        this.el = null;
        this.text = '';
        this._pending = null;
        this._showTimer = 0;
        this._hideTimer = 0;
        this._holdTimer = 0;
        this._closedAt = -Infinity;
        this._point = null;
        this._target = null;
    }

    get visible() {
        return Boolean(this.el && !this.el.hidden);
    }

    // A pointer plate, shown or about to be, that follows the scene; a held
    // finger's plate stays put.
    get tracking() {
        return Boolean(this._pending) || (this.visible && !this._held);
    }

    // Pointer hover: `text` is the lore for what is under the pointer ('' for
    // nothing), `point` the pointer in host pixels, `target` the inspected
    // thing's host rect when known, `key` its identity. The dwell belongs to
    // the identity: new text for the same thing (a ticking age) keeps it, a
    // different thing starts it again.
    update(text, point, target = null, key = text) {
        this._point = point;
        this._target = target;
        if (!text) {
            clearTimeout(this._showTimer);
            this._pending = null;
            this._pendingKey = null;
            if (this.visible && !this._hideTimer) {
                this._hideTimer = setTimeout(() => this.hide(), HIDE_GRACE_MS);
            }
            return;
        }
        clearTimeout(this._hideTimer);
        this._hideTimer = 0;
        if (this.visible) {
            if (text !== this.text) this._render(text);
            this._place();
            return;
        }
        if (performance.now() - this._closedAt < WARM_WINDOW_MS) {
            this._show(text);
            return;
        }
        if (this._pending && this._pendingKey === key) {
            this._pending = text;
            return;
        }
        clearTimeout(this._showTimer);
        this._pending = text;
        this._pendingKey = key;
        this._showTimer = setTimeout(() => this._reveal(), HOVER_PLATE_DELAY_MS);
    }

    // The dwell ran out: re-read the pointer. The same thing shows; a
    // replacement starts its own dwell; nothing shows nothing.
    _reveal() {
        const key = this._pendingKey;
        let text = this._pending;
        this._pending = null;
        this._pendingKey = null;
        if (text && this.resample) {
            const now = this.resample();
            if (!now?.text) return;
            const nowKey = now.key ?? now.text;
            if (nowKey !== key) {
                this.update(now.text, this._point, now.target || null, nowKey);
                return;
            }
            text = now.text;
            this._target = now.target || null;
        }
        if (text) this._show(text);
    }

    // A held finger: at once, then gone after `holdMs`.
    showNow(text, point, { target = null, holdMs = 4000 } = {}) {
        this.hide();
        if (!text) return false;
        this._point = point;
        this._target = target;
        this._show(text);
        this._held = true;
        this._holdTimer = setTimeout(() => this.hide(), holdMs);
        return true;
    }

    hide() {
        clearTimeout(this._showTimer);
        clearTimeout(this._hideTimer);
        clearTimeout(this._holdTimer);
        this._showTimer = this._hideTimer = this._holdTimer = 0;
        this._pending = null;
        this._pendingKey = null;
        this._held = false;
        if (!this.visible) return;
        this.el.hidden = true;
        this.text = '';
        this._closedAt = performance.now();
    }

    dispose() {
        this.hide();
        this.el?.remove();
        this.el = null;
    }

    _show(text) {
        if (!this.host) return;
        if (!this.el) {
            this.el = document.createElement('div');
            this.el.className = 'world-hover-plate cv-frame cv-frame--bg2';
            this.el.setAttribute('role', 'tooltip');
            this.host.append(this.el);
        }
        this._render(text);
        this.el.hidden = false;
        this._place();
    }

    _render(text) {
        this.text = text;
        this.el.replaceChildren(...hoverPlateLines(text).map((line) => {
            const row = document.createElement('span');
            row.className = 'world-hover-plate__line';
            row.textContent = line;
            return row;
        }));
    }

    _place() {
        if (!this.visible || !this._point) return;
        const { x, y } = placeHoverPlate({
            point: this._point,
            target: this._target,
            width: this.el.offsetWidth,
            height: this.el.offsetHeight,
            hostWidth: this.host.clientWidth,
            hostHeight: this.host.clientHeight,
            reserved: this.reservedRects(),
        });
        this.el.style.left = `${x}px`;
        this.el.style.top = `${y}px`;
    }
}
