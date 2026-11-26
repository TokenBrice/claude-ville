import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { eventBus } from '../../claudeville/src/domain/events/DomainEvent.js';
import {
    CELL_ACT,
    CELL_LOOK,
    HOURS_PER_DAY,
    HOURS_STRIP_HEIGHT,
    HOURS_STRIP_WIDTH,
    HOUR_CELL_PITCH,
    ObservedCallTapeStore,
    ProjectHoursLedger,
    TAPE_BUCKET_MS,
    TAPE_BUCKETS,
    TAPE_HEIGHT,
    TAPE_INK,
    TAPE_PITCH,
    TAPE_SHORT_BUCKETS,
    TAPE_SHORT_WIDTH,
    TAPE_SHORT_WINDOW_MS,
    TAPE_WIDTH,
    ghostTicksForTape,
    openedRuleColumn,
    paintHoursStrip,
    paintTapeCells,
    tapeSpanForAge,
} from '../../claudeville/src/presentation/dashboard-mode/ObservedCallTape.js';
import {
    DASHBOARD_LOCATE_IN_WORLD_EVENT,
    DISTRICT_BACKDROP_KEYS,
    DISTRICT_BACKDROP_SIZE,
    DashboardRenderer,
    OPTIONAL_COLUMN_THRESHOLD,
    annotateMendBrackets,
    districtKeyForAgent,
    findMendPairs,
    getDistrictBackdrop,
    shouldAllocateOptionalColumn,
} from '../../claudeville/src/presentation/dashboard-mode/DashboardRenderer.js';
import {
    ACTIVITY_PANEL_TABS,
    ACTIVITY_TAB_STORAGE_KEY,
    ActivityPanel,
    PANEL_DIRECTOR_FEED_VISIBLE,
    PANEL_MESSAGE_VISIBLE,
    PANEL_NARRATION_VISIBLE,
    PANEL_TOOL_VISIBLE,
    SECTION_ORDER,
    TAB_OF_SECTION,
    formatCompactionLabel,
    formatCompactionTokens,
} from '../../claudeville/src/presentation/shared/ActivityPanel.js';

const activityCssUrl = new URL('../../claudeville/css/activity-panel.css', import.meta.url);
const dashboardCssUrl = new URL('../../claudeville/css/dashboard.css', import.meta.url);

// Minimal in-memory DOM harness for headless Node tests of Dashboard and ActivityPanel.
class MiniClassList {
    constructor(el) {
        this._el = el;
    }
    _set() {
        return new Set(String(this._el.className || '').split(/\s+/).filter(Boolean));
    }
    _write(set) {
        this._el.className = [...set].join(' ');
    }
    add(...names) {
        const set = this._set();
        for (const n of names) if (n) set.add(n);
        this._write(set);
    }
    remove(...names) {
        const set = this._set();
        for (const n of names) set.delete(n);
        this._write(set);
    }
    contains(name) {
        return this._set().has(name);
    }
    toggle(name, force) {
        const set = this._set();
        const next = force === undefined ? !set.has(name) : Boolean(force);
        if (next) set.add(name);
        else set.delete(name);
        this._write(set);
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
    setProperty(name, value) {
        this._props.set(name, value == null ? '' : String(value));
    }
    getPropertyValue(name) {
        return this._props.get(name) ?? '';
    }
    removeProperty(name) {
        this._props.delete(name);
    }
}

function matchesSimpleSelector(el, selector) {
    if (!el || el.nodeType !== 1) return false;
    const trimmed = selector.trim();
    if (trimmed.includes(',')) {
        return trimmed.split(',').some(part => matchesSimpleSelector(el, part));
    }
    const attrMatch = /^\[([a-z0-9_-]+)(?:="([^"]*)")?\]$/i.exec(trimmed);
    if (attrMatch) {
        const [, attr, expected] = attrMatch;
        const val = attr.startsWith('data-')
            ? el.dataset[attr.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())]
            : el.getAttribute(attr);
        return expected === undefined ? val != null : String(val) === expected;
    }
    if (trimmed.startsWith('.')) {
        return el.classList.contains(trimmed.slice(1));
    }
    if (trimmed.startsWith('#')) {
        return el.id === trimmed.slice(1);
    }
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
    }
    get childNodes() { return this.children; }
    get parentElement() { return this.parentNode; }
    get firstChild() { return this.children[0] || null; }
    get nextSibling() {
        if (!this.parentNode) return null;
        const idx = this.parentNode.children.indexOf(this);
        return idx >= 0 ? (this.parentNode.children[idx + 1] || null) : null;
    }
    get isConnected() { return Boolean(this.parentNode) || this.tagName === 'BODY'; }
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
            if (matchesSimpleSelector(cur, selector)) return cur;
            cur = cur.parentNode;
        }
        return null;
    }
    querySelector(selector) {
        return this.querySelectorAll(selector)[0] || null;
    }
    querySelectorAll(selector) {
        const out = [];
        const walk = (node) => {
            for (const child of node.children || []) {
                if (child.nodeType !== 1) continue;
                if (matchesSimpleSelector(child, selector)) out.push(child);
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
    removeEventListener(type, fn) {
        this._listeners.get(type)?.delete(fn);
    }
    dispatchEvent(event) {
        for (const fn of this._listeners.get(event.type) || []) fn(event);
        return true;
    }
    click() {
        this.dispatchEvent({ type: 'click', target: this, stopPropagation() {}, preventDefault() {} });
    }
    focus() {
        if (globalThis.document) globalThis.document.activeElement = this;
    }
}

function raster(width, height) {
    const px = Array.from({ length: height }, () => new Array(width).fill(null));
    const noop = () => {};
    return {
        px,
        ctx: {
            fillStyle: null,
            strokeStyle: null,
            globalAlpha: 1,
            lineWidth: 1,
            font: '',
            textAlign: 'left',
            textBaseline: 'alphabetic',
            imageSmoothingEnabled: false,
            clearRect: noop,
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
            drawImage: noop,
            fillText: noop,
            strokeRect: noop,
            createLinearGradient: () => ({ addColorStop: noop }),
            createRadialGradient: () => ({ addColorStop: noop }),
            fillRect(x, y, w, h) {
                for (let row = y; row < y + h; row++) {
                    for (let col = x; col < x + w; col++) {
                        if (row >= 0 && row < height && col >= 0 && col < width) px[row][col] = this.fillStyle;
                    }
                }
            },
        },
    };
}

// ─── 1. Dashboard grid-level 30% column allocation & inline chips ────────────

test('W4-D: >= 30% grid-level column allocation hides tracks at 2/10 (20%) with inline chips and allocates at 3/10 (30%)', (t) => {
    assert.equal(OPTIONAL_COLUMN_THRESHOLD, 0.30);
    assert.equal(shouldAllocateOptionalColumn(2, 10), false);
    assert.equal(shouldAllocateOptionalColumn(3, 10), true);
    assert.equal(shouldAllocateOptionalColumn(0, 10), false);
    assert.equal(shouldAllocateOptionalColumn(0, 0), false);

    const grid = new MiniElement('div');
    globalThis.Node = MiniElement;
    globalThis.window = new EventTarget();
    globalThis.document = Object.assign(new EventTarget(), {
        body: new MiniElement('body'),
        activeElement: null,
        getElementById: (id) => (id === 'dashboardGrid' ? grid : null),
        createElement: (tag) => new MiniElement(tag),
        createElementNS: (_ns, tag) => new MiniElement(tag),
        createTextNode: (textContent) => ({ nodeType: 3, textContent, remove() {} }),
    });
    // 10 lead rows split across 2 projects (grid-level alignment decision!)
    const now = Date.now();
    const agents = Array.from({ length: 10 }, (_, idx) => ({
        id: `lead-${idx}`,
        name: `Agent ${idx}`,
        status: 'working',
        provider: 'claude',
        projectPath: idx < 5 ? '/repo/alpha' : '/repo/beta',
        workingSet: idx < 2 ? [{ path: `a-${idx}.js`, op: 'write', at: now }, { path: `b-${idx}.js`, op: 'read', at: now }] : [],
        taskProgress: idx < 2 ? { done: 0, total: 1, source: 'exact' } : null,
    }));
    const dash = new DashboardRenderer({ agents: new Map(agents.map(a => [a.id, a])) });
    t.after(() => {
        dash.destroy();
        delete globalThis.document;
        delete globalThis.window;
        delete globalThis.Node;
    });

    const makeCard = (agent) => {
        const card = new MiniElement('div');
        card.dataset.agentId = agent.id;
        card._elements = {
            workingSet: new MiniElement('div'),
            workSummary: new MiniElement('span'),
            children: new MiniElement('span'),
            childrenSource: new MiniElement('span'),
            kids: new MiniElement('div'),
            nowWorkChip: new MiniElement('span'),
            nowKidsChip: new MiniElement('span'),
        };
        dash.cards.set(agent.id, card);
        dash._renderWorkingSet(card, agent);
        dash._updateChildProgress(card, agent);
        return card;
    };
    agents.forEach(makeCard);

    // 2/10 = 20% -> wide tracks NOT allocated, inline chips `[2 files]` and `[▸ 1]` visible on those rows.
    dash._syncGridColumns(agents, now);
    assert.equal(grid.classList.contains('dashboard__grid--has-work'), false);
    assert.equal(grid.classList.contains('dashboard__grid--has-kids'), false);
    assert.equal(dash.cards.get('lead-0')._elements.nowWorkChip.hidden, false);
    assert.equal(dash.cards.get('lead-0')._elements.nowWorkChip.textContent, '2 files');
    assert.equal(dash.cards.get('lead-0')._elements.nowKidsChip.hidden, false);
    assert.equal(dash.cards.get('lead-0')._elements.nowKidsChip.textContent, '▸ 1');
    assert.equal(dash.cards.get('lead-5')._elements.nowWorkChip.hidden, true);
    assert.equal(dash.cards.get('lead-5')._elements.nowKidsChip.hidden, true);

    // 3/10 = 30% -> grid-level wide tracks allocate across both projects, inline chips hide.
    agents[2].workingSet = [{ path: 'c-2.js', op: 'read', at: now }];
    agents[2].taskProgress = { done: 1, total: 2, source: 'exact' };
    dash._renderWorkingSet(dash.cards.get('lead-2'), agents[2]);
    dash._updateChildProgress(dash.cards.get('lead-2'), agents[2]);
    dash._syncGridColumns(agents, now);
    assert.equal(grid.classList.contains('dashboard__grid--has-work'), true);
    assert.equal(grid.classList.contains('dashboard__grid--has-kids'), true);
    assert.equal(dash.cards.get('lead-0')._elements.nowWorkChip.hidden, true);
    assert.equal(dash.cards.get('lead-0')._elements.nowKidsChip.hidden, true);
});

// ─── 2. ObservedCallTape: 80px/160px, brass rule, blank unobserved, cached ghost ticks ─

test('W4-D: ObservedCallTape uses 80px (<5m, LAST 5 MIN) vs 160px (>=5m, LAST 10 MIN), brass rule & cached-only ghost ticks', () => {
    const T0 = 2_000_000 * TAPE_BUCKET_MS;
    const atBucket = (b, off = 0) => T0 + b * TAPE_BUCKET_MS + off;

    assert.equal(TAPE_PITCH, 4);
    assert.deepEqual(tapeSpanForAge(0), {
        buckets: TAPE_SHORT_BUCKETS,
        width: TAPE_SHORT_WIDTH,
        windowMs: TAPE_SHORT_WINDOW_MS,
        header: 'LAST 5 MIN',
        tier: '5m',
    });
    assert.deepEqual(tapeSpanForAge(TAPE_SHORT_WINDOW_MS - 1), {
        buckets: 20,
        width: 80,
        windowMs: 300_000,
        header: 'LAST 5 MIN',
        tier: '5m',
    });
    assert.deepEqual(tapeSpanForAge(TAPE_SHORT_WINDOW_MS), {
        buckets: TAPE_BUCKETS,
        width: TAPE_WIDTH,
        windowMs: 600_000,
        header: 'LAST 10 MIN',
        tier: '10m',
    });

    // Tab opens at bucket 20; at bucket 27 (age = 1m45s < 5m), span is 80px (20 buckets: [8..27]).
    // Buckets 8..19 (12 buckets) are unobserved; buckets 20..27 (8 buckets) are observed.
    const store = new ObservedCallTapeStore({ now: () => atBucket(20, 1_000) });
    store.observe({ id: 'a', status: 'working', currentTool: 'Edit', currentToolInput: 'a.js' }, atBucket(21, 500));
    const now5m = atBucket(27, 2_000);
    const span5m = store.span(now5m);
    assert.equal(span5m.width, 80);
    assert.equal(span5m.header, 'LAST 5 MIN');

    const cells5m = store.cells('a', now5m, { buckets: span5m.buckets });
    assert.equal(cells5m.length, 20);
    const ruleX5m = openedRuleColumn(cells5m, 1);
    assert.equal(ruleX5m, 12 * 4 - 1, 'brass rule sits 8 buckets from the right (x = 47)');

    // Cached transcript calls: one BEFORE openedAt (bucket 10), one AFTER openedAt (bucket 24).
    const cachedEntries = [
        { tool: 'Edit', ts: atBucket(10, 1_000) },
        { tool: 'Read', ts: atBucket(14, 1_000) },
        { tool: 'Bash', ts: atBucket(24, 1_000) }, // right of openedAt -> must NOT draw ghost tick
    ];
    const ghostTicks = ghostTicksForTape(cachedEntries, now5m, { buckets: span5m.buckets });
    const { px, ctx } = raster(80, TAPE_HEIGHT);
    paintTapeCells(ctx, cells5m, 1, { ghostTicks });

    // Brass rule fills column 47 across full tape height.
    assert.ok(px.every(row => row[ruleX5m] === TAPE_INK.brass));
    // Ghost tick for Edit at bucket 10 (index 2 -> x = 8) draws at 40% contrast act ink.
    assert.equal(px[11][8], TAPE_INK.ghostAct);
    // Ghost tick for Read at bucket 14 (index 6 -> x = 24) draws at 40% contrast look ink.
    assert.equal(px[11][24], TAPE_INK.ghostLook);
    // Unobserved empty columns (e.g. x = 0..7) stay completely blank linen (no zero dots on baseline row 12!).
    assert.ok(px.every(row => row.slice(0, 8).every(v => v === null)));
    // Right of brass rule, bucket 24 (index 16 -> x = 64) has NO ghost tick (only baseline row 12).
    assert.equal(px[11][64], null);
    assert.equal(px[12][64], TAPE_INK.baseline);

    // At tab age >= 5m (bucket 40, age = 5m): expands to 160px / LAST 10 MIN; at 10m (bucket 60), rule scrolls off.
    const now10m = atBucket(40, 2_000);
    assert.equal(store.span(now10m).width, 160);
    assert.equal(store.span(now10m).header, 'LAST 10 MIN');
    const cellsAfter10m = store.cells('a', atBucket(60, 2_000), { buckets: 40 });
    assert.equal(openedRuleColumn(cellsAfter10m, 1), null, 'brass rule scrolls off once full 10m window is observed');
});

// ─── 3. Dashboard Finishing Touches (9 backdrops, 24h hours strip, mend brackets, provider pips, locate) ─

test('W4-D: Portraits in situ cache all 9 44x40 district backdrops without per-frame allocation', (t) => {
    const originalDoc = globalThis.document;
    globalThis.document = {
        createElement() {
            const { ctx } = raster(44, 40);
            return {
                width: 0,
                height: 0,
                getContext: () => ctx,
                toDataURL: () => 'data:image/png;base64,stub',
            };
        },
    };
    t.after(() => {
        if (originalDoc === undefined) delete globalThis.document;
        else globalThis.document = originalDoc;
    });

    assert.equal(DISTRICT_BACKDROP_KEYS.length, 9);
    assert.deepEqual(DISTRICT_BACKDROP_SIZE, { width: 44, height: 40 });
    for (const key of DISTRICT_BACKDROP_KEYS) {
        const first = getDistrictBackdrop(key);
        const second = getDistrictBackdrop(key);
        assert.ok(first, `backdrop exists for ${key}`);
        assert.equal(first, second, `backdrop for ${key} is statically cached`);
        assert.equal(first.width, 44);
        assert.equal(first.height, 40);
    }
    assert.equal(districtKeyForAgent({ status: 'idle' }), 'tavern');
    assert.equal(districtKeyForAgent({ status: 'working', currentTool: 'Edit' }), 'forge');
    assert.equal(districtKeyForAgent({ status: 'working', targetBuildingType: 'lighthouse' }), 'watchtower');
});

test('W4-D: 24h Project Hours Strip paints ink, brass commit pip, push sail, and leaves uncovered hours blank', () => {
    const dayStart = new Date(2026, 10, 26, 9, 15, 0).getTime(); // 09:15 local
    const ledger = new ProjectHoursLedger({ now: () => dayStart });
    ledger.observeAgent('/repo/cv', { id: 'a1', currentTool: 'Edit', currentToolInput: 'a.js' }, dayStart);
    ledger.observeAgent('/repo/cv', { id: 'a1', currentTool: 'Read', currentToolInput: 'b.js' }, dayStart + 1_000);
    ledger.recordOutcome('/repo/cv', 'commit', dayStart + 2_000, 'c1');
    ledger.recordOutcome('/repo/cv', 'push', dayStart + 3_000, 'p1');

    const hours = ledger.hoursFor('/repo/cv', dayStart + 4_000);
    assert.equal(hours.length, HOURS_PER_DAY);
    assert.equal(hours[8].covered, false, 'uncovered earlier hour stays uncovered');
    assert.equal(hours[9].covered, true);
    assert.equal(hours[9].act, 1);
    assert.equal(hours[9].look, 1);
    assert.equal(hours[9].commits, 1);
    assert.equal(hours[9].pushes, 1);
    assert.equal(hours[10].covered, false, 'future hour stays uncovered');

    const { px, ctx } = raster(HOURS_STRIP_WIDTH, HOURS_STRIP_HEIGHT);
    paintHoursStrip(ctx, hours);
    // Uncovered hour 8 is completely blank.
    const x8 = 8 * HOUR_CELL_PITCH;
    assert.ok(px.every(row => row.slice(x8, x8 + 6).every(v => v === null)));
    // Covered hour 9 has baseline, act/look ink, brass commit pip (2x2 at x,1), and push sail at x+3..5.
    const x9 = 9 * HOUR_CELL_PITCH;
    assert.equal(px[7][x9], TAPE_INK.baseline);
    assert.equal(px[1][x9], TAPE_INK.brass, 'verified commit draws brass pip');
    assert.equal(px[0][x9 + 3], TAPE_INK.sail, 'verified push draws sail mast');
    assert.equal(px[2][x9 + 5], TAPE_INK.sail, 'verified push draws sail tip');
});

test('W4-D: Mend Brackets pair failed shell command with mending pass via MendLedger', () => {
    const t0 = 1_764_120_000_000;
    const tools = [
        { tool: 'Bash', detail: 'npm test', toolExitCode: 1, ts: t0 },
        { tool: 'Edit', detail: 'src/app.js', ts: t0 + 10_000 },
        { tool: 'Bash', detail: 'npm test', toolExitCode: 0, ts: t0 + 25_000 },
    ];
    const pairs = findMendPairs(tools, { agentId: 'a1', provider: 'claude' });
    assert.equal(pairs.length, 1);
    assert.equal(pairs[0].passDisplayIndex, 0, 'newest-first display index 0 is the passing run');
    assert.equal(pairs[0].failDisplayIndex, 2, 'newest-first display index 2 is the failed run');
    assert.equal(pairs[0].failedExit, 1);

    const listEl = new MiniElement('div');
    const rows = [new MiniElement('details'), new MiniElement('details'), new MiniElement('details')];
    annotateMendBrackets(listEl, rows, tools, { agentId: 'a1', provider: 'claude', classPrefix: 'dash-card__tool' });
    assert.equal(listEl.classList.contains('dash-card__tool-list--has-mend'), true);
    assert.equal(rows[0].dataset.mendRole, 'pass');
    assert.equal(rows[1].dataset.mendRole, 'span');
    assert.equal(rows[2].dataset.mendRole, 'fail');
});

test('W4-D: Provider pips render 2x6 color bars and Bell Lane LOCATE IN WORLD button emits & locates', (t) => {
    const attentionEl = new MiniElement('section');
    const gridEl = new MiniElement('div');
    const worldBtn = new MiniElement('button');
    let switchedToWorld = 0;
    worldBtn.addEventListener('click', () => { switchedToWorld++; });
    globalThis.Node = MiniElement;
    globalThis.window = new EventTarget();
    globalThis.document = Object.assign(new EventTarget(), {
        body: new MiniElement('body'),
        activeElement: null,
        getElementById: (id) => ({
            dashboardAttentionQueue: attentionEl,
            dashboardGrid: gridEl,
            btnModeCharacter: worldBtn,
        })[id] || null,
        createElement: (tag) => new MiniElement(tag),
        createElementNS: (_ns, tag) => new MiniElement(tag),
        createTextNode: (textContent) => ({ nodeType: 3, textContent, remove() {} }),
    });
    const agent = {
        id: 'moss',
        name: 'Moss',
        provider: 'claude',
        status: 'waiting_on_user',
        projectPath: '/repo/cv',
    };
    const located = [];
    const framed = [];
    const selected = [];
    const unsubLocate = eventBus.on(DASHBOARD_LOCATE_IN_WORLD_EVENT, (payload) => located.push(payload.agentId));
    const unsubSel = eventBus.on('agent:selected', (a) => selected.push(a?.id));
    const dash = new DashboardRenderer(
        { agents: new Map([[agent.id, agent]]) },
        { frameAttention: (a) => framed.push(a.id) },
    );
    t.after(() => {
        unsubLocate();
        unsubSel();
        dash.destroy();
        delete globalThis.document;
        delete globalThis.window;
        delete globalThis.Node;
    });

    // Provider pips in attention tally bar.
    dash._renderAttentionQueue([agent]);
    const pips = attentionEl.querySelectorAll('.dashboard-attention__provider-pip');
    assert.equal(pips.length, 1);
    assert.ok(pips[0].style.backgroundColor, 'provider pip carries guild-material color');

    // Bell Lane LOCATE IN WORLD footer action (sibling to select button, not nested!).
    const card = new MiniElement('div');
    card.dataset.agentId = agent.id;
    const selectBtn = new MiniElement('button');
    card.appendChild(selectBtn);
    card._elements = { select: selectBtn, call: null };
    const refs = dash._ensureCallBlock(card);
    assert.equal(refs.locate.textContent, 'LOCATE IN WORLD ▸');
    assert.equal(selectBtn.contains(refs.locate), false, 'locate button is never nested inside outer button');
    refs.locate.click();
    assert.deepEqual(located, ['moss']);
    assert.equal(switchedToWorld, 1);
    assert.deepEqual(framed, ['moss']);
    assert.deepEqual(selected, ['moss']);
});

// ─── 4. Activity Panel 3-Tab Keep Folio, Persistence & Compaction Ticks ──────

test('W4-D: TAB_OF_SECTION covers all 15 SECTION_ORDER keys (LIVE: 4, WORK: 5, LIFE: 6)', () => {
    assert.equal(SECTION_ORDER.length, 15);
    assert.deepEqual(Object.keys(TAB_OF_SECTION).sort(), [...SECTION_ORDER].sort());
    const counts = { live: 0, work: 0, life: 0 };
    for (const key of SECTION_ORDER) {
        const tab = TAB_OF_SECTION[key];
        assert.ok(ACTIVITY_PANEL_TABS.includes(tab), `invalid tab '${tab}' for ${key}`);
        counts[tab]++;
    }
    assert.deepEqual(counts, { live: 4, work: 5, life: 6 });
    assert.equal(TAB_OF_SECTION.village, 'life');
    assert.equal(TAB_OF_SECTION['harbor-log'], 'work');
    assert.equal(TAB_OF_SECTION['cost-tokens'], 'live');
    assert.equal(TAB_OF_SECTION.journey, 'life');
});

test('W4-D: ActivityPanel 3-tab folio persists claudeville.activityPanel.tab, supports keyboard nav, and keeps tab across agents', (t) => {
    const storageMap = new Map([['claudeville.activityPanel.villageOpen', 'true']]);
    const origStorage = globalThis.localStorage;
    globalThis.localStorage = {
        getItem: (k) => (storageMap.has(k) ? storageMap.get(k) : null),
        setItem: (k, v) => { storageMap.set(k, String(v)); },
    };

    const byId = new Map();
    const reg = (el, id) => { el.id = id; byId.set(id, el); return el; };
    const panelEl = reg(new MiniElement('aside'), 'activityPanel');
    const header = new MiniElement('div'); header.className = 'activity-panel__header';
    const agentInfo = new MiniElement('div'); agentInfo.className = 'activity-panel__agent-info';
    const closeBtn = reg(new MiniElement('button'), 'panelClose');
    const actions = new MiniElement('span'); actions.appendChild(closeBtn);
    const statusLine = new MiniElement('div');
    statusLine.appendChild(reg(new MiniElement('span'), 'panelAgentStatus'));
    agentInfo.append(reg(new MiniElement('span'), 'panelAgentName'), actions, statusLine, reg(new MiniElement('div'), 'panelProvenance'));
    header.appendChild(agentInfo);

    const meta = new MiniElement('div'); meta.className = 'activity-panel__meta';
    for (const [rowId, valId] of [
        ['panelLevelRow', 'panelLevel'],
        ['panelTeamRow', 'panelTeam'],
        ['panelMoodRow', 'panelMood'],
        ['panelLastActiveRow', 'panelLastActive'],
        ['panelModeRow', 'panelMode'],
    ]) {
        const row = reg(new MiniElement('div'), rowId);
        row.appendChild(reg(new MiniElement('span'), valId));
        meta.appendChild(row);
    }

    const costSec = new MiniElement('div'); costSec.className = 'activity-panel__section'; costSec.dataset.section = 'cost-tokens';
    const barWrap = new MiniElement('div'); barWrap.className = 'activity-panel__context-bar-wrap';
    barWrap.appendChild(reg(new MiniElement('div'), 'panelContextBar'));
    const tokenGrid = reg(new MiniElement('div'), 'panelTokenGrid');
    for (const id of ['panelInputTokens', 'panelOutputTokens', 'panelCacheRead', 'panelCacheCreate', 'panelCacheHit', 'panelTurnCount']) {
        tokenGrid.appendChild(reg(new MiniElement('span'), id));
    }
    const statWrap = new MiniElement('div');
    statWrap.append(reg(new MiniElement('span'), 'panelContextNumeral'), reg(new MiniElement('span'), 'panelContextSize'));
    const costRow = reg(new MiniElement('div'), 'panelCostRow');
    costRow.append(reg(new MiniElement('span'), 'panelEstCost'), reg(new MiniElement('span'), 'panelCostLabel'));
    costSec.append(statWrap, costRow, barWrap, tokenGrid, reg(new MiniElement('div'), 'panelNoUsage'));

    const curSec = new MiniElement('div'); curSec.className = 'activity-panel__section'; curSec.dataset.section = 'current-tool';
    const curTool = reg(new MiniElement('div'), 'panelCurrentTool');
    for (const cls of ['activity-panel__tool-icon', 'activity-panel__tool-name', 'activity-panel__tool-input']) {
        const span = new MiniElement('span'); span.className = cls; curTool.appendChild(span);
    }
    curSec.appendChild(curTool);

    const histSec = new MiniElement('div'); histSec.className = 'activity-panel__section'; histSec.dataset.section = 'tool-history';
    histSec.appendChild(reg(new MiniElement('div'), 'panelToolHistory'));

    const msgSec = new MiniElement('div'); msgSec.className = 'activity-panel__section'; msgSec.dataset.section = 'messages';
    msgSec.appendChild(reg(new MiniElement('div'), 'panelMessages'));

    panelEl.append(header, meta, costSec, curSec, histSec, msgSec);

    globalThis.Node = MiniElement;
    globalThis.Image = class MockImage { set src(_) {} };
    globalThis.window = new EventTarget();
    globalThis.document = Object.assign(new EventTarget(), {
        body: new MiniElement('body'),
        activeElement: null,
        hidden: true,
        getElementById: (id) => byId.get(id) || null,
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

    const panel = new ActivityPanel({ toast: { show() {}, destroy() {} } });
    t.after(() => {
        panel.destroy();
        if (origStorage === undefined) delete globalThis.localStorage;
        else globalThis.localStorage = origStorage;
        delete globalThis.document;
        delete globalThis.window;
        delete globalThis.Image;
        delete globalThis.Node;
    });

    // Default tab is 'live' (ignores legacy villageOpen key).
    assert.equal(panel._activeTab, 'live');
    assert.equal(panel._tabListEl.getAttribute('role'), 'tablist');
    assert.equal(panel._tabListEl.classList.contains('topbar__well'), true);
    assert.equal(panel._tabButtons.live.getAttribute('role'), 'tab');
    assert.equal(panel._tabButtons.live.getAttribute('aria-selected'), 'true');
    assert.equal(panel._tabButtons.live.tabIndex, 0);
    assert.equal(panel._tabButtons.work.tabIndex, -1);
    assert.equal(panel._tabButtons.life.tabIndex, -1);

    // Pinned header: Call card + Session meta live outside `.activity-panel__body` above tabs.
    assert.equal(panel._bodyEl.contains(panel._callCardEl), false);
    assert.equal(panel._bodyEl.contains(meta), false);
    // Token ledger is folded behind its disclosure inside LIVE.
    assert.equal(panel._ledgerDetailsEl.tagName, 'DETAILS');
    assert.equal(panel._ledgerDetailsEl.contains(tokenGrid), true);
    // No dissolved `.activity-panel__village` wrapper exists.
    assert.equal(panelEl.querySelector('.activity-panel__village'), null);

    // All mounted sections sit inside their mapped tabpanel in SECTION_ORDER order.
    for (const key of SECTION_ORDER) {
        if (key === 'village') continue;
        const tab = TAB_OF_SECTION[key];
        const mounted = panel._tabPanels[tab].querySelector(`[data-section="${key}"]`);
        assert.ok(mounted, `section '${key}' is mounted inside tab '${tab}'`);
    }

    // ArrowRight / ArrowLeft / Home / End navigation updates tab, roving tabindex & persistence.
    let prevented = 0;
    const keyEvent = (key) => ({ type: 'keydown', key, preventDefault() { prevented++; } });
    panel._tabListEl.dispatchEvent(keyEvent('ArrowRight'));
    assert.equal(panel._activeTab, 'work');
    assert.equal(storageMap.get(ACTIVITY_TAB_STORAGE_KEY), 'work');
    assert.equal(panel._tabButtons.work.tabIndex, 0);
    assert.equal(panel._tabButtons.live.tabIndex, -1);
    assert.equal(panel._tabPanels.work.hidden, false);
    assert.equal(panel._tabPanels.live.hidden, true);

    panel._tabListEl.dispatchEvent(keyEvent('End'));
    assert.equal(panel._activeTab, 'life');
    assert.equal(storageMap.get(ACTIVITY_TAB_STORAGE_KEY), 'life');

    panel._tabListEl.dispatchEvent(keyEvent('Home'));
    assert.equal(panel._activeTab, 'live');
    panel._tabListEl.dispatchEvent(keyEvent('ArrowLeft'));
    assert.equal(panel._activeTab, 'life', 'ArrowLeft wraps from LIVE to LIFE');
    assert.equal(prevented, 4);

    // Selecting a new agent preserves the operator's active tab ('life').
    const appearance = { pants: '#3b4252', shirt: '#5e81ac', skin: '#e8c4a0', hair: '#4c3a2d' };
    panel.show({
        id: 'agent-1',
        name: 'One',
        status: 'working',
        provider: 'claude',
        appearance,
        workingSet: [{ path: 'src/app.js', op: 'write', at: Date.now() }],
    });
    assert.equal(panel._activeTab, 'life');
    assert.equal(panel._tabButtons.work.dataset.empty, 'false', 'WORK tab un-dims when working-set has files');

    panel.show({ id: 'agent-2', name: 'Two', status: 'idle', provider: 'codex', appearance });
    assert.equal(panel._activeTab, 'life');

    // Empty tab stays in place dimmed (never removed or reordered).
    assert.equal(panel._tabListEl.children.map(btn => btn.dataset.tab).join(','), 'live,work,life');
    assert.equal(panel._tabButtons.work.dataset.empty, 'true', 'empty WORK tab dims in place without reordering');
    assert.equal(panel._tabButtons.work.classList.contains('activity-panel__tab--empty'), true);

    // Inner lists show newest N + disclosure instead of scrolling.
    const manyTools = Array.from({ length: PANEL_TOOL_VISIBLE + 4 }, (_, i) => ({
        tool: 'Read', detail: `file-${i}.js`, ts: 1_764_120_000_000 + i * 1_000,
    }));
    panel._renderToolHistory(manyTools);
    assert.equal(byId.get('panelToolHistory').children.length, PANEL_TOOL_VISIBLE + 1);
    assert.equal(byId.get('panelToolHistory').children.at(-1).classList.contains('activity-panel__list-more'), true);

    const manyMessages = Array.from({ length: PANEL_MESSAGE_VISIBLE + 2 }, (_, i) => ({
        role: i % 2 ? 'user' : 'assistant', text: `msg ${i}`, ts: 1_764_120_000_000 + i * 1_000,
    }));
    panel._renderMessages(manyMessages);
    assert.equal(byId.get('panelMessages').children.length, PANEL_MESSAGE_VISIBLE + 1);
    assert.equal(byId.get('panelMessages').children.at(-1).classList.contains('activity-panel__list-more'), true);
    assert.ok(byId.get('panelMessages').querySelector('.activity-panel__marginalia'), 'messages carry left-gutter marginalia glyph');

    // Narration & Scene Log disclosures also cap visible entries and fold older rows.
    const baseTs = Date.now();
    for (let i = 0; i < PANEL_NARRATION_VISIBLE + 2; i++) {
        panel._ingestNarration({
            id: 'agent-2',
            dialogue: { text: `Thought ${i}`, kind: i % 2 ? 'thinking' : 'assistant', source: 'transcript', observedAt: baseTs - i * 1_000, actionId: `act-${i}` },
        }, baseTs);
    }
    panel._renderNarration({ id: 'agent-2' }, baseTs);
    assert.equal(panel._narrationBodyEl.children.length, PANEL_NARRATION_VISIBLE + 1);
    assert.equal(panel._narrationBodyEl.children.at(-1).classList.contains('activity-panel__list-more'), true);

    panel._directorFeed = Array.from({ length: PANEL_DIRECTOR_FEED_VISIBLE + 3 }, (_, i) => ({
        id: `scene-${i}`, kind: 'handoff', label: `Scene ${i}`, ts: baseTs - i * 1_000,
    }));
    panel._renderSignatures.directorFeed = '';
    panel._renderDirectorFeed();
    assert.equal(panel._directorFeedBodyEl.children.length, PANEL_DIRECTOR_FEED_VISIBLE + 1);
    assert.equal(panel._directorFeedBodyEl.children.at(-1).classList.contains('activity-panel__list-more'), true);

    // Compaction ticks render on valid compactions[] and gracefully no-op on null/undefined/[].
    assert.equal(formatCompactionTokens(412_300), '412K');
    assert.equal(formatCompactionTokens(1_200_000), '1.2M');
    assert.equal(formatCompactionLabel({ preTokens: 412_300, postTokens: 38_100 }), '412K → 38K');
    assert.equal(formatCompactionLabel({ preTokens: 412_300, postTokens: null }), '412K');
    assert.equal(formatCompactionLabel(null), '');

    panel._renderCompactionTicks({ id: 'a', compactions: null }, 200_000);
    assert.equal(panel._contextTicksEl.hidden, true);
    assert.equal(panel._contextTicksEl.children.length, 0);

    panel._renderCompactionTicks({ id: 'a', compactions: [] }, 200_000);
    assert.equal(panel._contextTicksEl.hidden, true);
    assert.equal(panel._contextTicksEl.children.length, 0);

    panel._renderCompactionTicks({
        id: 'a',
        compactions: [
            { at: baseTs - 60_000, trigger: 'manual', preTokens: 412_300, postTokens: 38_100 },
            { at: baseTs - 10_000, trigger: 'unknown', preTokens: 412_300, postTokens: null },
        ],
    }, 500_000);
    assert.equal(panel._contextTicksEl.hidden, false);
    assert.equal(panel._contextTicksEl.children.length, 2);
    assert.equal(panel._contextTicksEl.children[0].title, '412K → 38K · manual');
    assert.equal(panel._contextTicksEl.children[1].title, '412K');
});

// ─── 5. Static CSS Assertions: ZERO nested scrollboxes in activity-panel.css ─

test('W4-D: activity-panel.css has ZERO nested overflow-y: auto/scroll except the single .activity-panel__body scroller', async () => {
    const css = await readFile(activityCssUrl, 'utf8');
    const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const scrollSelectors = [];
    for (const match of stripped.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        const selector = match[1].trim().replace(/\s+/g, ' ');
        const body = match[2];
        if (/\boverflow(?:-y)?\s*:\s*(?:auto|scroll)\b/i.test(body)) {
            scrollSelectors.push(selector);
        }
    }
    assert.deepEqual(scrollSelectors, ['.activity-panel__body'],
        `Expected .activity-panel__body to be the sole vertical scroller, found: ${scrollSelectors.join(', ')}`);

    // Ensure none of the four retired nested scrollbox containers carry max-height.
    for (const retired of [
        '.activity-panel__tool-history',
        '.activity-panel__messages',
        '.activity-panel__narration-list',
        '.activity-panel__director-feed',
    ]) {
        const block = new RegExp(`${retired.replace('.', '\\.')}\\s*\\{([^}]*)\\}`);
        const found = stripped.match(block);
        assert.ok(found, `expected rule for ${retired}`);
        assert.doesNotMatch(found[1], /\bmax-height\s*:/i, `${retired} must not cap max-height`);
    }

    // Verify dashboard.css keeps desktop-only policy (no shrinking media queries) and 80px 5m tape rule.
    const dashCss = await readFile(dashboardCssUrl, 'utf8');
    assert.match(dashCss, /\.dashboard__grid--has-tape\.dashboard__grid--tape-5m\s*\{\s*--dash-cols-tape:\s*80px;\s*\}/);
    assert.match(dashCss, /\.dashboard-attention__provider-pip\s*\{[^}]*width:\s*2px;[^}]*height:\s*6px;/s);
});
