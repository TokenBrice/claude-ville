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

function overlaps(a, b) {
    return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

// Where a w x h plate goes in a W x H host: beside `target` (the inspected
// thing's screen rect) when given, else off the pointer; the first spot that
// fits the host and clears every reserved rect wins, else the first, clamped.
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
    for (const [x, y] of candidates) {
        const rect = { left: x, top: y, right: x + width, bottom: y + height };
        const inside = x >= EDGE && y >= EDGE && rect.right <= hostWidth - EDGE && rect.bottom <= hostHeight - EDGE;
        if (inside && !reserved.some((r) => overlaps(rect, r))
            && !(target && overlaps(rect, target))) return clamp([x, y]);
    }
    return clamp(candidates[0]);
}

export class WorldHoverPlate {
    constructor({ host, reservedRects = () => [] } = {}) {
        this.host = host;
        this.reservedRects = reservedRects;
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

    // Pointer hover: `text` is the lore for what is under the pointer ('' for
    // nothing), `point` the pointer in host pixels, `target` the inspected
    // thing's host rect when known.
    update(text, point, target = null) {
        this._point = point;
        this._target = target;
        if (!text) {
            clearTimeout(this._showTimer);
            this._pending = null;
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
        if (this._pending === text) return;
        clearTimeout(this._showTimer);
        this._pending = text;
        this._showTimer = setTimeout(() => {
            const pending = this._pending;
            this._pending = null;
            if (pending) this._show(pending);
        }, HOVER_PLATE_DELAY_MS);
    }

    // A held finger: at once, then gone after `holdMs`.
    showNow(text, point, { target = null, holdMs = 4000 } = {}) {
        this.hide();
        if (!text) return false;
        this._point = point;
        this._target = target;
        this._show(text);
        this._holdTimer = setTimeout(() => this.hide(), holdMs);
        return true;
    }

    hide() {
        clearTimeout(this._showTimer);
        clearTimeout(this._hideTimer);
        clearTimeout(this._holdTimer);
        this._showTimer = this._hideTimer = this._holdTimer = 0;
        this._pending = null;
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
