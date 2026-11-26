import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
    EMPTY_COVERAGE_MASK,
    setCoverageQuarter,
} from '../../claudeville/src/infrastructure/ChronicleStore.js';
import { summarizeDay } from '../../claudeville/src/application/ChronicleLog.js';
import { ActivityPanel } from '../../claudeville/src/presentation/shared/ActivityPanel.js';
import {
    TAPESTRY_BANDS,
    decodeTapestryCoverage,
    decodeTapestryCoverageHours,
    extractTapestryStats,
    renderChronicleTapestry,
} from '../../claudeville/src/presentation/shared/ChronicleTapestry.js';
import {
    ChroniclePanel,
    SUN_ARC_DEFAULT_WIDTH,
    SUN_ARC_HEIGHT,
    decodeCoverageMask,
    encodeCoverageMask,
    sunArcBackingWidth,
} from '../../claudeville/src/presentation/shared/ChroniclePanel.js';
import {
    HOURS_PER_DAY,
    HOURS_STRIP_HEIGHT,
    HOURS_STRIP_WIDTH,
    HOUR_CELL_H,
    HOUR_CELL_PITCH,
    HOUR_CELL_W,
    ProjectHoursLedger,
    TAPE_INK,
    paintHoursStrip,
    paintHoursStripCanvas,
} from '../../claudeville/src/presentation/dashboard-mode/ObservedCallTape.js';
import { DashboardRenderer } from '../../claudeville/src/presentation/dashboard-mode/DashboardRenderer.js';

const activityCssUrl = new URL('../../claudeville/css/activity-panel.css', import.meta.url);
const dashboardCssUrl = new URL('../../claudeville/css/dashboard.css', import.meta.url);
const modalCssUrl = new URL('../../claudeville/css/modal.css', import.meta.url);

// ── Connected DOM harness (getElementById only finds connected descendants) ──

class MiniClassList {
    constructor(el) { this._el = el; }
    _set() { return new Set(String(this._el.className || '').split(/\s+/).filter(Boolean)); }
    _write(set) { this._el.className = [...set].join(' '); }
    add(...names) { const s = this._set(); for (const n of names) if (n) s.add(n); this._write(s); }
    remove(...names) { const s = this._set(); for (const n of names) s.delete(n); this._write(s); }
    contains(name) { return this._set().has(name); }
    toggle(name, force) {
        const s = this._set();
        const next = force === undefined ? !s.has(name) : Boolean(force);
        if (next) s.add(name); else s.delete(name);
        this._write(s);
        return next;
    }
}

class MiniStyle {
    constructor() {
        this._props = new Map();
        return new Proxy(this, {
            get(target, prop) {
                if (prop in target) return target[prop];
                return target._props.get(prop) ?? '';
            },
            set(target, prop, value) {
                if (prop in target) { target[prop] = value; return true; }
                target._props.set(prop, value == null ? '' : String(value));
                return true;
            },
        });
    }
    setProperty(name, value) { this._props.set(name, value == null ? '' : String(value)); }
    getPropertyValue(name) { return this._props.get(name) ?? ''; }
    removeProperty(name) { this._props.delete(name); }
}

function matchesSimple(el, selector) {
    if (!el || el.nodeType !== 1) return false;
    const trimmed = selector.trim();
    if (trimmed.includes(',')) return trimmed.split(',').some(part => matchesSimple(el, part));
    const attrMatch = /^\[([a-z0-9_-]+)(?:="([^"]*)")?\]$/i.exec(trimmed);
    if (attrMatch) {
        const [, attr, expected] = attrMatch;
        const val = attr.startsWith('data-')
            ? el.dataset[attr.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())]
            : el.getAttribute(attr);
        return expected === undefined ? val != null : String(val) === expected;
    }
    if (trimmed.startsWith('.')) return el.classList.contains(trimmed.slice(1));
    if (trimmed.startsWith('#')) return el.id === trimmed.slice(1);
    return el.tagName === trimmed.toUpperCase();
}

class MiniElement {
    constructor(tag = 'div') {
        this.nodeType = 1;
        this.tagName = String(tag).toUpperCase();
        this.id = '';
        this.className = '';
        this.classList = new MiniClassList(this);
        this.dataset = {};
        this.style = new MiniStyle();
        this.attributes = new Map();
        this.children = [];
        this.parentNode = null;
        this.hidden = false;
        this.open = false;
        this.tabIndex = 0;
        this.scrollTop = 0;
        this._textContent = '';
        this._listeners = new Map();
        this.rect = { left: 0, top: 0, right: 648, bottom: 36, width: 648, height: 36 };
    }
    get childNodes() { return this.children; }
    get parentElement() { return this.parentNode; }
    get firstChild() { return this.children[0] || null; }
    get clientWidth() { return this.rect.width; }
    get clientHeight() { return this.rect.height; }
    getBoundingClientRect() { return { ...this.rect }; }
    getClientRects() { return (this.hidden || this.style.display === 'none') ? [] : [{ ...this.rect }]; }
    get nextSibling() {
        if (!this.parentNode) return null;
        const idx = this.parentNode.children.indexOf(this);
        return idx >= 0 ? (this.parentNode.children[idx + 1] || null) : null;
    }
    get isConnected() {
        let cur = this;
        while (cur) {
            if (cur.tagName === 'BODY') return true;
            cur = cur.parentNode;
        }
        return false;
    }
    get textContent() {
        if (this.children.length === 0) return this._textContent;
        return this.children.map(child => child.textContent ?? '').join('');
    }
    set textContent(value) {
        this.children = [];
        this._textContent = value == null ? '' : String(value);
    }
    setAttribute(name, value) {
        this.attributes.set(name, String(value));
        if (name === 'class') this.className = String(value);
        if (name === 'id') this.id = String(value);
        if (name === 'hidden') this.hidden = true;
    }
    getAttribute(name) {
        if (name === 'id' && this.id) return this.id;
        return this.attributes.has(name) ? this.attributes.get(name) : null;
    }
    removeAttribute(name) {
        this.attributes.delete(name);
        if (name === 'hidden') this.hidden = false;
    }
    toggleAttribute(name, force) {
        const has = this.attributes.has(name);
        const next = force === undefined ? !has : Boolean(force);
        if (next) this.attributes.set(name, '');
        else this.attributes.delete(name);
    }
    appendChild(child) {
        if (!child) return child;
        if (child.parentNode && child.parentNode !== this) child.remove?.();
        const existing = this.children.indexOf(child);
        if (existing >= 0) this.children.splice(existing, 1);
        child.parentNode = this;
        this.children.push(child);
        return child;
    }
    insertBefore(node, ref) {
        if (!ref) return this.appendChild(node);
        if (node.parentNode && node.parentNode !== this) node.remove?.();
        const existing = this.children.indexOf(node);
        if (existing >= 0) this.children.splice(existing, 1);
        const idx = this.children.indexOf(ref);
        node.parentNode = this;
        if (idx < 0) this.children.push(node);
        else this.children.splice(idx, 0, node);
        return node;
    }
    append(...nodes) {
        for (const n of nodes) {
            if (typeof n === 'string') {
                this.appendChild({ nodeType: 3, textContent: n, parentNode: this, remove() {} });
            } else if (n) {
                this.appendChild(n);
            }
        }
    }
    after(...nodes) {
        const parent = this.parentNode;
        if (!parent) return;
        const ref = this.nextSibling;
        for (const n of nodes) parent.insertBefore(n, ref);
    }
    replaceChildren(...nodes) {
        for (const child of this.children) if (child) child.parentNode = null;
        this.children = [];
        this._textContent = '';
        this.append(...nodes);
    }
    remove() {
        if (!this.parentNode) return;
        const idx = this.parentNode.children.indexOf(this);
        if (idx >= 0) this.parentNode.children.splice(idx, 1);
        this.parentNode = null;
    }
    removeChild(child) {
        const idx = this.children.indexOf(child);
        if (idx >= 0) this.children.splice(idx, 1);
        if (child) child.parentNode = null;
        return child;
    }
    contains(node) {
        let cur = node;
        while (cur) {
            if (cur === this) return true;
            cur = cur.parentNode;
        }
        return false;
    }
    closest(selector) {
        let cur = this;
        while (cur) {
            if (matchesSimple(cur, selector)) return cur;
            cur = cur.parentNode;
        }
        return null;
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    querySelectorAll(selector) {
        const out = [];
        const walk = (node) => {
            for (const child of node.children || []) {
                if (child.nodeType !== 1) continue;
                if (matchesSimple(child, selector)) out.push(child);
                walk(child);
            }
        };
        walk(this);
        return out;
    }
    addEventListener(type, fn) {
        if (!this._listeners.has(type)) this._listeners.set(type, new Set());
        this._listeners.get(type).add(fn);
    }
    removeEventListener(type, fn) { this._listeners.get(type)?.delete(fn); }
    dispatchEvent(event) {
        for (const fn of this._listeners.get(event.type) || []) fn(event);
        return true;
    }
}

function raster(width, height) {
    const px = Array.from({ length: height }, () => new Array(width).fill(null));
    const ops = [];
    const noop = () => {};
    return {
        px,
        ops,
        ctx: {
            fillStyle: null,
            strokeStyle: null,
            globalAlpha: 1,
            lineWidth: 1,
            font: '',
            textAlign: 'left',
            textBaseline: 'alphabetic',
            imageSmoothingEnabled: false,
            clearRect(x, y, w, h) {
                for (let row = Math.max(0, y); row < Math.min(height, y + h); row++) {
                    for (let col = Math.max(0, x); col < Math.min(width, x + w); col++) {
                        px[row][col] = null;
                    }
                }
            },
            save: noop,
            restore: noop,
            translate: noop,
            scale: noop,
            rotate: noop,
            setTransform: noop,
            beginPath: noop,
            closePath: noop,
            moveTo: noop,
            lineTo: noop,
            arc: noop,
            ellipse: noop,
            roundRect: noop,
            rect: noop,
            fill: noop,
            stroke: noop,
            clip: noop,
            drawImage(...args) { ops.push(['drawImage', ...args]); },
            fillText(text, x, y) { ops.push(['fillText', text, x, y]); },
            strokeRect: noop,
            fillRect(x, y, w, h) {
                ops.push(['fillRect', x, y, w, h, this.fillStyle]);
                for (let row = y; row < y + h; row++) {
                    for (let col = x; col < x + w; col++) {
                        if (row >= 0 && row < height && col >= 0 && col < width) px[row][col] = this.fillStyle;
                    }
                }
            },
        },
    };
}

function buildActivityPanelShell() {
    const body = new MiniElement('body');
    const idOf = (el, id) => { el.id = id; return el; };

    const panelEl = idOf(new MiniElement('aside'), 'activityPanel');
    const header = new MiniElement('div');
    header.className = 'activity-panel__header';
    const agentInfo = new MiniElement('div');
    agentInfo.className = 'activity-panel__agent-info';
    const closeBtn = idOf(new MiniElement('button'), 'panelClose');
    const actions = new MiniElement('span');
    actions.appendChild(closeBtn);
    const statusLine = new MiniElement('div');
    statusLine.appendChild(idOf(new MiniElement('span'), 'panelAgentStatus'));
    agentInfo.append(
        idOf(new MiniElement('span'), 'panelAgentName'),
        actions,
        statusLine,
        idOf(new MiniElement('div'), 'panelProvenance'),
    );
    header.appendChild(agentInfo);

    const meta = new MiniElement('div');
    meta.className = 'activity-panel__meta';
    for (const [rowId, valId] of [
        ['panelLevelRow', 'panelLevel'],
        ['panelTeamRow', 'panelTeam'],
        ['panelMoodRow', 'panelMood'],
        ['panelLastActiveRow', 'panelLastActive'],
        ['panelModeRow', 'panelMode'],
    ]) {
        const row = idOf(new MiniElement('div'), rowId);
        row.appendChild(idOf(new MiniElement('span'), valId));
        meta.appendChild(row);
    }

    const costSec = new MiniElement('div');
    costSec.className = 'activity-panel__section';
    costSec.dataset.section = 'cost-tokens';
    const tokenUsage = idOf(new MiniElement('div'), 'panelTokenUsage');
    const barWrap = new MiniElement('div');
    barWrap.className = 'activity-panel__context-bar-wrap';
    barWrap.appendChild(idOf(new MiniElement('div'), 'panelContextBar'));
    const tokenGrid = idOf(new MiniElement('div'), 'panelTokenGrid');
    for (const id of ['panelInputTokens', 'panelOutputTokens', 'panelCacheRead', 'panelCacheCreate', 'panelCacheHit', 'panelTurnCount']) {
        tokenGrid.appendChild(idOf(new MiniElement('span'), id));
    }
    const statWrap = new MiniElement('div');
    statWrap.append(idOf(new MiniElement('span'), 'panelContextNumeral'), idOf(new MiniElement('span'), 'panelContextSize'));
    const costRow = idOf(new MiniElement('div'), 'panelCostRow');
    costRow.append(idOf(new MiniElement('span'), 'panelEstCost'), idOf(new MiniElement('span'), 'panelCostLabel'));
    tokenUsage.append(statWrap, costRow, barWrap, tokenGrid, idOf(new MiniElement('div'), 'panelNoUsage'));
    costSec.appendChild(tokenUsage);

    const curSec = new MiniElement('div');
    curSec.className = 'activity-panel__section';
    curSec.dataset.section = 'current-tool';
    const curTool = idOf(new MiniElement('div'), 'panelCurrentTool');
    for (const cls of ['activity-panel__tool-icon', 'activity-panel__tool-name', 'activity-panel__tool-input']) {
        const span = new MiniElement('span');
        span.className = cls;
        curTool.appendChild(span);
    }
    curSec.appendChild(curTool);

    const histSec = new MiniElement('div');
    histSec.className = 'activity-panel__section';
    histSec.dataset.section = 'tool-history';
    histSec.appendChild(idOf(new MiniElement('div'), 'panelToolHistory'));

    const msgSec = new MiniElement('div');
    msgSec.className = 'activity-panel__section';
    msgSec.dataset.section = 'messages';
    msgSec.appendChild(idOf(new MiniElement('div'), 'panelMessages'));

    panelEl.append(header, meta, costSec, curSec, histSec, msgSec);
    body.appendChild(panelEl);

    const findById = (root, targetId) => {
        if (!root || root.nodeType !== 1) return null;
        if (root.id === targetId) return root;
        for (const child of root.children || []) {
            const hit = findById(child, targetId);
            if (hit) return hit;
        }
        return null;
    };

    const doc = Object.assign(new EventTarget(), {
        body,
        activeElement: null,
        hidden: true,
        getElementById: (id) => findById(body, id),
        createElement: (tag) => {
            const el = new MiniElement(tag);
            if (tag === 'canvas') {
                const { ctx } = raster(64, 64);
                el.getContext = () => ctx;
            }
            return el;
        },
        createElementNS: (_ns, tag) => new MiniElement(tag),
        createTextNode: (textContent) => ({ nodeType: 3, textContent, remove() {} }),
        querySelectorAll: () => [],
    });

    return { body, doc, panelEl, header, meta, costSec, curSec, histSec, msgSec, tokenUsage, tokenGrid };
}

// ── Finding 1 & 2: ActivityPanel remount + freshness placement ───────────────

test('W4-Fix-C (P1): ActivityPanel.destroy() restores original shell sections and token grid so remounting succeeds cleanly', (t) => {
    const { doc, panelEl, header, meta, costSec, curSec, histSec, msgSec, tokenUsage, tokenGrid } = buildActivityPanelShell();
    globalThis.Node = MiniElement;
    globalThis.Image = class MockImage { set src(_) {} };
    globalThis.window = new EventTarget();
    globalThis.document = doc;
    t.after(() => {
        delete globalThis.document;
        delete globalThis.window;
        delete globalThis.Image;
        delete globalThis.Node;
    });

    const appearance = { pants: '#3b4252', shirt: '#5e81ac', skin: '#e8c4a0', hair: '#4c3a2d' };
    const agent = {
        id: 'agent-1',
        name: 'Ada',
        status: 'working',
        provider: 'claude',
        projectPath: '/repo/claude-ville',
        gitBranch: 'main',
        currentTool: 'Edit',
        currentToolInput: 'src/app.js',
        appearance,
    };

    const panel1 = new ActivityPanel({ toast: { show() {}, destroy() {} } });
    panel1.show(agent);
    assert.equal(panel1._bodyEl.contains(curSec), true);
    assert.equal(panel1._ledgerDetailsEl.contains(tokenGrid), true);

    panel1.destroy();

    // Every original shell section and panelTokenGrid must be connected back in original order.
    assert.deepEqual(
        panelEl.children,
        [header, meta, costSec, curSec, histSec, msgSec],
        'destroy() must restore the exact original shell children in order',
    );
    assert.equal(doc.getElementById('panelCurrentTool')?.isConnected, true);
    assert.equal(doc.getElementById('panelToolHistory')?.isConnected, true);
    assert.equal(doc.getElementById('panelMessages')?.isConnected, true);
    assert.equal(doc.getElementById('panelTokenGrid')?.parentNode, tokenUsage);
    assert.equal(panelEl.querySelector('.activity-panel__tabs'), null);
    assert.equal(panelEl.querySelector('.activity-panel__body'), null);
    assert.equal(panelEl.querySelector('.activity-panel__ledger-details'), null);
    assert.equal(panelEl.querySelector('.activity-panel__freshness'), null);
    assert.equal(panelEl.querySelector('.activity-panel__repo-line'), null);

    // Remounting a second ActivityPanel on the restored shell must succeed without throwing.
    const panel2 = new ActivityPanel({ toast: { show() {}, destroy() {} } });
    assert.ok(panel2._toolEls.name, 'remounted ActivityPanel finds panelCurrentTool children');
    panel2.show(agent);
    assert.equal(panel2._toolEls.name.textContent, 'Edit');
    assert.equal(panelEl.querySelectorAll('.activity-panel__ledger-details').length, 1);

    panel2.destroy();
    assert.deepEqual(panelEl.children, [header, meta, costSec, curSec, histSec, msgSec]);
});

test('W4-Fix-C (P2): Observation freshness sits inside .activity-panel__body below pinned tabs so tabs never jump', async (t) => {
    const { doc, header } = buildActivityPanelShell();
    globalThis.Node = MiniElement;
    globalThis.Image = class MockImage { set src(_) {} };
    globalThis.window = new EventTarget();
    globalThis.document = doc;

    const panel = new ActivityPanel({ toast: { show() {}, destroy() {} } });
    t.after(() => {
        panel.destroy();
        delete globalThis.document;
        delete globalThis.window;
        delete globalThis.Image;
        delete globalThis.Node;
    });

    assert.equal(header.contains(panel._detailFreshnessEl), false, 'freshness line must NOT live in pinned header above tabs');
    assert.equal(panel._bodyEl.contains(panel._detailFreshnessEl), true, 'freshness line sits inside scrollable body below pinned tabs');
    assert.equal(panel._bodyEl.firstChild, panel._detailFreshnessEl, 'freshness line leads the scrollable body');
    assert.equal(panel._detailFreshnessEl.hidden, true);

    // Toggling freshness never alters header or tab container structure.
    const headerChildCount = header.children.length;
    panel._detailFreshnessEl.textContent = 'Cached · updated 12s ago';
    panel._detailFreshnessEl.hidden = false;
    assert.equal(header.children.length, headerChildCount);

    // Switching to building view hides agent freshness banner.
    panel.showBuilding({ type: 'forge', label: 'Forge', district: 'craft' });
    assert.equal(panel._detailFreshnessEl.hidden, true);

    // Still ZERO nested vertical scrollbars in activity-panel.css.
    const css = await readFile(activityCssUrl, 'utf8');
    const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const scrollers = [];
    for (const match of stripped.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        if (/\boverflow(?:-y)?\s*:\s*(?:auto|scroll)\b/i.test(match[2])) {
            scrollers.push(match[1].trim().replace(/\s+/g, ' '));
        }
    }
    assert.deepEqual(scrollers, ['.activity-panel__body']);
});

// ── Finding 3: Tapestry coverage decoder ─────────────────────────────────────

test('W4-Fix-C (P1): Tapestry decodes 24-hex, 96-bitstring, { hours }, and typed coverage masks accurately in ledger and sun-arc', () => {
    const emptyHex = '0'.repeat(24);
    assert.equal(emptyHex, EMPTY_COVERAGE_MASK);
    const hour0Hex = setCoverageQuarter(EMPTY_COVERAGE_MASK, 0); // '0'.repeat(23) + '1'
    const hour23Hex = '1' + '0'.repeat(23); // quarter 92 -> hour 23
    const emptyBits = '0'.repeat(96);
    const hour0Bits = '1' + '0'.repeat(95);

    // Empty masks MUST report 0 covered hours (never 24!).
    assert.equal(extractTapestryStats({ events: [], coverage: emptyHex }).hours, 0);
    assert.equal(extractTapestryStats({ events: [], coverage: emptyBits }).hours, 0);
    assert.equal(extractTapestryStats({ events: [], coverage: { mask: emptyHex } }).hours, 0);
    assert.equal(extractTapestryStats({ events: [], coverage: { hours: new Array(24).fill(0) } }).hours, 0);
    assert.equal(extractTapestryStats({ events: [], coverage: new Uint8Array(24) }).hours, 0);
    assert.equal(extractTapestryStats({ events: [], coverage: new Uint8Array(96) }).hours, 0);

    // Single-hour masks MUST report exactly 1 covered hour on the exact expected hour.
    assert.equal(extractTapestryStats({ events: [], coverage: hour0Hex }).hours, 1);
    assert.equal(extractTapestryStats({ events: [], coverage: hour23Hex }).hours, 1);
    assert.equal(extractTapestryStats({ events: [], coverage: hour0Bits }).hours, 1);
    assert.equal(extractTapestryStats({ events: [], coverage: { hours: [1, ...new Array(23).fill(0)] } }).hours, 1);

    const hoursFromHour0 = decodeTapestryCoverageHours(hour0Hex);
    assert.equal(hoursFromHour0[0], 1);
    assert.equal([...hoursFromHour0].reduce((a, b) => a + b, 0), 1);

    const hoursFromHour23 = decodeTapestryCoverageHours(hour23Hex);
    assert.equal(hoursFromHour23[23], 1);
    assert.equal([...hoursFromHour23].reduce((a, b) => a + b, 0), 1);

    // Parity with ChroniclePanel.decodeCoverageMask across all formats.
    const packed = encodeCoverageMask([1, 0, 0, 0, ...new Array(92).fill(0)]);
    for (const sample of [emptyHex, hour0Hex, hour23Hex, emptyBits, hour0Bits, packed, new Uint8Array(24), { hours: [1, ...new Array(23).fill(0)] }]) {
        assert.deepEqual([...decodeTapestryCoverage(sample)], [...decodeCoverageMask(sample)]);
    }

    // Sun-arc ribbon inside renderChronicleTapestry MUST paint bare linen (no sky) for '0'.repeat(24).
    const emptySurface = raster(1200, 1600);
    const emptyRes = renderChronicleTapestry({
        dateKey: '2026-11-25',
        summary: summarizeDay([]),
        events: [],
        coverage: emptyHex,
        ctx: emptySurface.ctx,
    });
    assert.equal(emptyRes.stats.hours, 0);
    const sunBand = TAPESTRY_BANDS.sunArc;
    const sunRectsEmpty = emptySurface.ops.filter(
        op => op[0] === 'fillRect' && op[2] === sunBand.y + 4 && op[4] === sunBand.height - 8,
    );
    assert.equal(sunRectsEmpty.length, 24);
    assert.ok(sunRectsEmpty.every(op => op[5] === '#32261c'), 'all 24 columns stay bare linen warp for empty hex mask');

    // Sun-arc paints sky ONLY on hour 0 for hour0Hex, and bare linen on hours 1..23.
    const oneHourSurface = raster(1200, 1600);
    renderChronicleTapestry({
        dateKey: '2026-11-25',
        summary: summarizeDay([]),
        events: [],
        coverage: hour0Hex,
        ctx: oneHourSurface.ctx,
    });
    const sunRectsOne = oneHourSurface.ops.filter(
        op => op[0] === 'fillRect' && op[2] === sunBand.y + 4 && op[4] === sunBand.height - 8,
    );
    assert.notEqual(sunRectsOne[0][5], '#32261c', 'hour 0 renders sky color when covered');
    assert.ok(sunRectsOne.slice(1).every(op => op[5] === '#32261c'), 'hours 1..23 remain bare linen warp');
});

// ── Finding 4: Historical Tapestry villager isolation ────────────────────────

test('W4-Fix-C (P1): Historical Tapestry never attributes today live villagers to an empty or past day', async (t) => {
    globalThis.window = Object.assign(new EventTarget(), {
        location: { origin: 'http://fixture.invalid' },
        __claudeVillePerf: {},
    });
    globalThis.document = Object.assign(new EventTarget(), { getElementById: () => null });
    t.after(() => {
        delete globalThis.window;
        delete globalThis.document;
    });
    const { buildTapestryCast } = await import('../../claudeville/src/presentation/App.js');

    const liveSprites = new Map(
        Array.from({ length: 37 }, (_, i) => [
            `live-${i}`,
            {
                agent: { id: `live-${i}`, name: `LiveAgent${i}`, provider: 'claude' },
                _poseCell: { canvas: { width: 64, height: 64, tag: `pose-${i}` } },
            },
        ]),
    );

    // 1. Empty historical day -> cast MUST be empty even with 37 live agents today.
    const emptyPastCast = buildTapestryCast({
        dateKey: '2026-11-25',
        todayKey: '2026-11-26',
        events: [],
        summary: summarizeDay([]),
        agentSprites: liveSprites,
    });
    assert.deepEqual(emptyPastCast, []);

    // 2. Non-empty historical day -> cast strictly matches that day's recorded agents.
    const pastEvents = [
        { kind: 'commit', ts: new Date(2026, 10, 25, 10, 0).getTime(), agentId: 'hist-ada', agentName: 'Ada', provider: 'claude' },
        { kind: 'push', ts: new Date(2026, 10, 25, 11, 0).getTime(), agentId: 'hist-bram', agentName: 'Bram', provider: 'codex' },
    ];
    const pastCast = buildTapestryCast({
        dateKey: '2026-11-25',
        todayKey: '2026-11-26',
        events: pastEvents,
        summary: summarizeDay(pastEvents),
        agentSprites: liveSprites,
    });
    assert.equal(pastCast.length, 2);
    assert.ok(pastCast.every(entry => !entry.canvas), 'historical agents not live today never steal unrelated live sprite poses');

    // 3. Today with recorded events -> filters live sprite busts strictly to recorded agents.
    const todayEvents = [
        { kind: 'arrived', ts: new Date(2026, 10, 26, 9, 0).getTime(), agentId: 'live-0', agentName: 'LiveAgent0', provider: 'claude' },
        { kind: 'commit', ts: new Date(2026, 10, 26, 9, 30).getTime(), agentId: 'live-3', agentName: 'LiveAgent3', provider: 'claude' },
    ];
    const todayFilteredCast = buildTapestryCast({
        dateKey: '2026-11-26',
        todayKey: '2026-11-26',
        events: todayEvents,
        summary: summarizeDay(todayEvents),
        agentSprites: liveSprites,
    });
    assert.equal(todayFilteredCast.length, 2);
    assert.equal(todayFilteredCast[0].canvas.tag, 'pose-0');
    assert.equal(todayFilteredCast[1].canvas.tag, 'pose-3');

    // 4. Today with no recorded events yet -> allows today's live sprite busts.
    const todayLiveCast = buildTapestryCast({
        dateKey: '2026-11-26',
        todayKey: '2026-11-26',
        events: [],
        summary: null,
        agentSprites: liveSprites,
    });
    assert.equal(todayLiveCast.length, 37);

    // 5. extractTapestryStats & renderChronicleTapestry NEVER inflate villagers from stray cast.
    const strayCast = [...liveSprites.values()].map(s => s._poseCell);
    assert.equal(extractTapestryStats({ summary: summarizeDay([]), events: [], cast: strayCast }).villagers, 0);
    assert.equal(extractTapestryStats({ summary: { villagers: 0 }, cast: strayCast }).villagers, 0);
    assert.equal(extractTapestryStats({ events: [], cast: strayCast }).villagers, 0);
    assert.equal(extractTapestryStats({ roster: [], cast: strayCast }).villagers, 0);

    const surface = raster(1200, 1600);
    const rendered = renderChronicleTapestry({
        dateKey: '2026-11-25',
        summary: summarizeDay([]),
        events: [],
        cast: strayCast,
        coverage: EMPTY_COVERAGE_MASK,
        ctx: surface.ctx,
    });
    assert.equal(rendered.stats.villagers, 0);
    assert.equal(rendered.stats.hours, 0);
    const castDraws = surface.ops.filter(
        op => op[0] === 'drawImage' && op[7] >= TAPESTRY_BANDS.cast.y,
    );
    assert.equal(castDraws.length, 0, 'empty historical day draws zero cast busts');
});

// ── Finding 5 & 6: Dashboard LAST 5 MIN fit + LOCATE IN WORLD pixel chevron ──

test('W4-Fix-C (P1/P2): Dashboard LAST 5 MIN column removes letter-spacing and LOCATE IN WORLD renders pixel-art SVG chevron', async (t) => {
    const dashCss = await readFile(dashboardCssUrl, 'utf8');
    assert.match(dashCss, /\.dashboard__col--tape\s*\{[^}]*letter-spacing:\s*0\s*;/);
    assert.match(dashCss, /\.dash-card__call-locate-glyph\s*\{[^}]*display:\s*none\s*;/);
    assert.match(dashCss, /\.dash-card__call-locate-arrow\s*\{[^}]*shape-rendering:\s*crispEdges\s*;/);

    const gridEl = new MiniElement('div');
    globalThis.Node = MiniElement;
    globalThis.window = new EventTarget();
    globalThis.document = Object.assign(new EventTarget(), {
        body: new MiniElement('body'),
        activeElement: null,
        getElementById: (id) => (id === 'dashboardGrid' ? gridEl : null),
        createElement: (tag) => new MiniElement(tag),
        createElementNS: (_ns, tag) => new MiniElement(tag),
        createTextNode: (textContent) => ({ nodeType: 3, textContent, remove() {} }),
    });
    const dash = new DashboardRenderer({ agents: new Map() });
    t.after(() => {
        dash.destroy();
        delete globalThis.document;
        delete globalThis.window;
        delete globalThis.Node;
    });

    const card = new MiniElement('div');
    card.dataset.agentId = 'a1';
    const selectBtn = new MiniElement('button');
    card.appendChild(selectBtn);
    card._elements = { select: selectBtn, call: null };
    const refs = dash._ensureCallBlock(card);

    assert.equal(refs.locate.textContent, 'LOCATE IN WORLD ▸');
    const hiddenGlyph = refs.locate.querySelector('.dash-card__call-locate-glyph');
    assert.ok(hiddenGlyph);
    assert.equal(hiddenGlyph.getAttribute('aria-hidden'), 'true');
    const svgArrow = refs.locate.querySelector('.dash-card__call-locate-arrow');
    assert.ok(svgArrow, 'LOCATE IN WORLD includes crisp pixel-art inline SVG chevron');
    assert.equal(svgArrow.tagName, 'SVG');
    assert.equal(svgArrow.getAttribute('aria-hidden'), 'true');
    assert.equal(svgArrow.getAttribute('shape-rendering'), 'crispEdges');
    assert.ok(svgArrow.querySelector('path'), 'SVG chevron carries pixel triangle path');
});

// ── Finding 7: 24h Project Hours Strip full 24-cell baseline rule ────────────

test('W4-Fix-C (P2): 24h Hours Strip paints subtle 1 px bottom baseline across all 24 cells while keeping uncovered interiors blank', () => {
    const dayStart = new Date(2026, 10, 26, 9, 15, 0).getTime();
    const ledger = new ProjectHoursLedger({ now: () => dayStart });
    ledger.observeAgent('/repo/cv', { id: 'a1', currentTool: 'Edit', currentToolInput: 'a.js' }, dayStart);
    const hours = ledger.hoursFor('/repo/cv', dayStart + 1_000);

    const { px, ctx } = raster(HOURS_STRIP_WIDTH, HOURS_STRIP_HEIGHT);
    const canvas = { width: HOURS_STRIP_WIDTH, height: HOURS_STRIP_HEIGHT, getContext: () => ctx };
    paintHoursStripCanvas(canvas, hours);

    // Every one of the 24 cells gets a 1 px bottom baseline rule on row 7.
    for (let h = 0; h < HOURS_PER_DAY; h++) {
        const x = h * HOUR_CELL_PITCH;
        const expectedBottom = h === 9 ? TAPE_INK.hoursCovered : TAPE_INK.hoursRail;
        for (let col = x; col < x + HOUR_CELL_W; col++) {
            assert.equal(px[HOUR_CELL_H - 1][col], expectedBottom, `hour ${h} bottom baseline at col ${col}`);
        }
        // Uncovered hours keep rows 0..6 completely blank linen (zero false activity).
        if (h !== 9) {
            for (let row = 0; row < HOUR_CELL_H - 1; row++) {
                for (let col = x; col < x + HOUR_CELL_W; col++) {
                    assert.equal(px[row][col], null, `uncovered hour ${h} interior row ${row} stays blank`);
                }
            }
        }
    }

    // Legacy 2-arg paintHoursStrip(ctx, hours) remains compatible with strict blank uncovered cells.
    const legacy = raster(HOURS_STRIP_WIDTH, HOURS_STRIP_HEIGHT);
    paintHoursStrip(legacy.ctx, hours);
    assert.equal(legacy.px[HOUR_CELL_H - 1][8 * HOUR_CELL_PITCH], null);
    assert.equal(legacy.px[HOUR_CELL_H - 1][9 * HOUR_CELL_PITCH], TAPE_INK.baseline);
});

// ── Finding 8: Sun-arc 1:1 width & Postcard Studio hint line-height ──────────

test('W4-Fix-C (P2): Sun-arc canvas stays 1:1 with CSS width (648 px) and Postcard Studio hint has 14 px line-height', async (t) => {
    assert.equal(SUN_ARC_DEFAULT_WIDTH, 648);
    assert.equal(sunArcBackingWidth(656), 648, 'desktop 656 container snaps to 648 (24 x 27)');
    assert.equal(sunArcBackingWidth(648), 648);
    assert.equal(sunArcBackingWidth(350), 336, 'narrow container snaps to multiple of 24');
    assert.equal(sunArcBackingWidth(0), 648, 'unmounted 0 width falls back to 648');

    const { doc } = buildActivityPanelShell();
    globalThis.Node = MiniElement;
    globalThis.document = doc;
    t.after(() => {
        delete globalThis.document;
        delete globalThis.Node;
    });

    const contentEl = new MiniElement('div');
    const panel = new ChroniclePanel({
        modal: { contentEl, isRequestCurrent: () => true },
        chronicleLog: { retentionDays: 14 },
    });
    const nodes = panel._render([], summarizeDay([]), {
        dateKey: '2026-11-26',
        coverage: EMPTY_COVERAGE_MASK,
    });
    contentEl.replaceChildren(...nodes);
    const canvas = contentEl.querySelector('.chronicle__sun-arc-canvas');
    assert.ok(canvas);
    assert.equal(canvas.width, 648);
    assert.equal(canvas.height, SUN_ARC_HEIGHT);
    assert.equal(canvas.style.width, '648px', 'inline CSS width matches backing width 1:1');

    const modalCss = await readFile(modalCssUrl, 'utf8');
    assert.match(modalCss, /\.chronicle__sun-arc-canvas\s*\{[^}]*box-sizing:\s*content-box\s*;[^}]*width:\s*648px\s*;[^}]*height:\s*36px\s*;/s);
    assert.match(modalCss, /\.postcard-studio__hint\s*\{[^}]*font:\s*var\(--fs-label\)\/14px\s+var\(--font-display\)\s*;/s);
});
