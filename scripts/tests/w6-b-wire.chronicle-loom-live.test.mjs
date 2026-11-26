// Wave 6-B-Wire (Moonshot M1 — The Loom of Days Live Integration) verification suite.
//
// Proves end-to-end live integration of ChronicleLoom.js across:
//   1. `coverage:<dateKey>` & `sky:<dateKey>` persistence in ChronicleStore `meta` (DB_VERSION = 7)
//   2. ChroniclePanel horizontal Bayeux Loom frieze strip + zero-PII Scroll PNG export under `withPostcardFrame`
//   3. ChronicleTapestry live 1152x216 Loom band (y = 1124..1340, 12x2 panels, 0 fillText, zero historical leak)
//   4. App + BuildingSprite + BuildingCutaways live Archive rear-wall Loom panel + `audio:evensong` close
//   5. Performance budget: full-day weave & render <= 50 ms/day

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

import {
    ChronicleStore,
    DB_VERSION,
    EMPTY_COVERAGE_MASK,
    coverageMetaKey,
    hasCoverageQuarter,
    quarterIndexForTime,
    setCoverageQuarter,
    skyMetaKey,
} from '../../claudeville/src/infrastructure/ChronicleStore.js';
import {
    ChronicleEventKind,
    ChronicleLog,
    chronicleDateKey,
    summarizeDay,
} from '../../claudeville/src/application/ChronicleLog.js';
import { eventBus } from '../../claudeville/src/domain/events/DomainEvent.js';
import { createAtmosphereSnapshot } from '../../claudeville/src/presentation/character-mode/AtmosphereState.js';
import { withPostcardFrame } from '../../claudeville/src/presentation/character-mode/Postcard.js';
import { apertureCutContains } from '../../claudeville/src/presentation/character-mode/BuildingApertureModel.js';
import {
    ARCHIVE_CUTAWAY_PROFILE,
    CutawayPeelController,
    buildArchiveCutawayState,
    downsampleLoomPanel2x,
    drawArchiveCutaway,
} from '../../claudeville/src/presentation/character-mode/BuildingCutaways.js';
import { BuildingSprite } from '../../claudeville/src/presentation/character-mode/BuildingSprite.js';
import { getBuildingApertureProfile } from '../../claudeville/src/presentation/character-mode/BuildingVisualRegistry.js';
import {
    LOOM_BANDS,
    LOOM_HOURS_PER_DAY,
    LOOM_PANEL_HEIGHT,
    LOOM_PANEL_WIDTH,
    LOOM_TAPESTRY_BAND,
    createCoverageMask,
    normalizeSkyEntry,
    renderLoomFrieze,
    renderLoomPanel,
    renderLoomTapestryGrid,
    selectArchiveLoomPanel,
    weaveDay,
} from '../../claudeville/src/presentation/shared/ChronicleLoom.js';
import {
    ChroniclePanel,
    LOOM_STRIP_HEIGHT,
    LOOM_STRIP_WIDTH,
    exportLoomScrollPng,
    formatLoomReadout,
    loomHourFromOffset,
    loomInitialScrollLeft,
    loomScrollFileName,
} from '../../claudeville/src/presentation/shared/ChroniclePanel.js';
import {
    TAPESTRY_ALLOWED_LABELS,
    TAPESTRY_BANDS,
    TAPESTRY_DATE_RE,
    TAPESTRY_HEIGHT,
    TAPESTRY_INT_RE,
    TAPESTRY_MASTHEAD_RE,
    TAPESTRY_WIDTH,
    renderChronicleTapestry,
} from '../../claudeville/src/presentation/shared/ChronicleTapestry.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MODAL_CSS_PATH = path.join(ROOT, 'claudeville/css/modal.css');

// ── Shared Test Harnesses ────────────────────────────────────────────────────

function setGlobal(t, key, value) {
    const had = Object.prototype.hasOwnProperty.call(globalThis, key);
    const prev = globalThis[key];
    globalThis[key] = value;
    t.after(() => {
        if (had) globalThis[key] = prev;
        else delete globalThis[key];
    });
}

function localTs(year, month, day, hour, minute = 0) {
    return new Date(year, month - 1, day, hour, minute, 0, 0).getTime();
}

function createMetaDatabase() {
    const rows = new Map();
    return {
        rows,
        transaction() {
            const pending = [];
            const store = {
                get(key) {
                    const req = {};
                    pending.push(() => {
                        req.result = rows.get(key);
                        req.onsuccess?.();
                    });
                    return req;
                },
                put(record) {
                    rows.set(record.key, structuredClone(record));
                    return {};
                },
                delete(key) {
                    rows.delete(key);
                    return {};
                },
            };
            const tx = { objectStore: () => store };
            setImmediate(() => {
                for (let i = 0; i < pending.length; i++) pending[i]();
                tx.oncomplete?.();
            });
            return tx;
        },
    };
}

class FakeClassList {
    constructor(owner) {
        this.owner = owner;
        this.set = new Set();
    }
    add(...names) {
        for (const n of names) if (n) this.set.add(n);
        this.owner.className = [...this.set].join(' ');
    }
    remove(...names) {
        for (const n of names) this.set.delete(n);
        this.owner.className = [...this.set].join(' ');
    }
    toggle(name, force) {
        const next = force === undefined ? !this.set.has(name) : Boolean(force);
        if (next) this.set.add(name);
        else this.set.delete(name);
        this.owner.className = [...this.set].join(' ');
        return next;
    }
    contains(name) {
        return this.set.has(name);
    }
}

function matchSimpleSelector(node, selector) {
    const trimmed = selector.trim();
    const classMatches = [...trimmed.matchAll(/\.([a-zA-Z0-9_-]+)/g)].map(m => m[1]);
    for (const cls of classMatches) {
        if (!node.classList.contains(cls)) return false;
    }
    const attrMatches = [...trimmed.matchAll(/\[([a-zA-Z0-9_-]+)="([^"]*)"\]/g)];
    for (const [, attr, expected] of attrMatches) {
        if (attr.startsWith('data-')) {
            const key = attr.slice(5).replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
            if (String(node.dataset[key] ?? '') !== expected) return false;
        } else if (node.getAttribute(attr) !== expected) {
            return false;
        }
    }
    return classMatches.length > 0 || attrMatches.length > 0;
}

class FakeElement {
    constructor(tagName) {
        this.tagName = String(tagName || 'div').toUpperCase();
        this.children = [];
        this.parentNode = null;
        this.className = '';
        this.classList = new FakeClassList(this);
        this.dataset = {};
        this.style = { setProperty() {}, removeProperty() {} };
        this.attributes = new Map();
        this.listeners = new Map();
        this.textContent = '';
        this.hidden = false;
        this.disabled = false;
        this.scrollLeft = 0;
        this.scrolled = 0;
        this.rect = { left: 0, top: 0, right: 648, bottom: 72, width: 648, height: 72 };
        if (this.tagName === 'CANVAS') {
            this.width = 0;
            this.height = 0;
            this.ops = [];
            this.fillTextCalls = [];
            this.strokeTextCalls = [];
        }
    }
    get clientWidth() { return this.rect.width; }
    get clientHeight() { return this.rect.height; }
    append(...nodes) {
        for (const child of nodes) {
            if (child == null) continue;
            if (child instanceof FakeElement) child.parentNode = this;
            this.children.push(child);
        }
    }
    appendChild(child) { this.append(child); return child; }
    replaceChildren(...nodes) {
        for (const child of this.children) if (child instanceof FakeElement) child.parentNode = null;
        this.children = [];
        this.append(...nodes);
    }
    remove() {
        if (this.parentNode) {
            const idx = this.parentNode.children.indexOf(this);
            if (idx >= 0) this.parentNode.children.splice(idx, 1);
        }
        this.parentNode = null;
    }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    removeAttribute(name) { this.attributes.delete(name); }
    addEventListener(type, fn) {
        const list = this.listeners.get(type) || [];
        list.push(fn);
        this.listeners.set(type, list);
    }
    dispatch(type, event = {}) {
        for (const fn of [...(this.listeners.get(type) || [])]) fn(event);
    }
    click() {
        if (this.disabled) return;
        this.dispatch('click', { preventDefault() {}, stopPropagation() {}, target: this });
    }
    scrollIntoView() { this.scrolled += 1; }
    getBoundingClientRect() { return { ...this.rect }; }
    getContext(kind) {
        if (this.tagName !== 'CANVAS' || kind !== '2d') return null;
        if (this._ctx) return this._ctx;
        const canvas = this;
        this._ctx = {
            imageSmoothingEnabled: true,
            fillStyle: '',
            font: '',
            textAlign: 'left',
            textBaseline: 'alphabetic',
            save() { canvas.ops.push(['save']); },
            restore() { canvas.ops.push(['restore']); },
            fillRect(x, y, w, h) { canvas.ops.push(['fillRect', x, y, w, h, this.fillStyle]); },
            clearRect(x, y, w, h) { canvas.ops.push(['clearRect', x, y, w, h]); },
            drawImage(...args) { canvas.ops.push(['drawImage', ...args]); },
            fillText(text, x, y) {
                canvas.fillTextCalls.push({ text, x, y });
                canvas.ops.push(['fillText', text, x, y]);
            },
            strokeText(text, x, y) {
                canvas.strokeTextCalls.push({ text, x, y });
                canvas.ops.push(['strokeText', text, x, y]);
            },
        };
        return this._ctx;
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    querySelectorAll(selector) {
        const out = [];
        const walk = (node) => {
            if (!(node instanceof FakeElement)) return;
            if (matchSimpleSelector(node, selector)) out.push(node);
            for (const child of node.children) walk(child);
        };
        for (const child of this.children) walk(child);
        return out;
    }
}

function createFakeDom(t) {
    const body = new FakeElement('body');
    const downloads = [];
    const doc = {
        body,
        createElement(tag) {
            const el = new FakeElement(tag);
            if (String(tag).toLowerCase() === 'a') {
                const origClick = el.click.bind(el);
                el.click = () => {
                    downloads.push({ download: el.download, href: el.href });
                    origClick();
                };
            }
            return el;
        },
        createTextNode(text) { return String(text); },
        getElementById: () => null,
        querySelectorAll: () => [],
    };
    const origCreateObjectURL = URL.createObjectURL;
    const origRevokeObjectURL = URL.revokeObjectURL;
    const blobs = [];
    URL.createObjectURL = (blob) => {
        blobs.push(blob);
        return `blob:mock-${blobs.length}`;
    };
    URL.revokeObjectURL = () => {};
    setGlobal(t, 'document', doc);
    setGlobal(t, 'Node', FakeElement);
    t.after(() => {
        URL.createObjectURL = origCreateObjectURL;
        URL.revokeObjectURL = origRevokeObjectURL;
    });
    return { doc, body, downloads, blobs };
}

function createPixelCanvas(width, height) {
    const rgba = new Uint8ClampedArray(width * height * 4);
    const fillTextCalls = [];
    const strokeTextCalls = [];
    const drawImageCalls = [];
    const fillRectCalls = [];
    const parseHex = (hex) => {
        const clean = String(hex || '#000000').replace('#', '').trim();
        const full = clean.length === 3
            ? clean[0] + clean[0] + clean[1] + clean[1] + clean[2] + clean[2]
            : clean.slice(0, 6);
        const v = Number.parseInt(full, 16);
        return Number.isFinite(v) ? [(v >> 16) & 255, (v >> 8) & 255, v & 255, 255] : [0, 0, 0, 255];
    };
    const ctx = {
        font: '',
        fillStyle: '#000000',
        strokeStyle: '#000000',
        textAlign: 'left',
        textBaseline: 'alphabetic',
        imageSmoothingEnabled: true,
        globalAlpha: 1,
        save() {},
        restore() {},
        clearRect() {},
        fillRect(x, y, w, h) {
            fillRectCalls.push({ x, y, w, h, fill: this.fillStyle });
            const [r, g, b, a] = parseHex(this.fillStyle);
            const x0 = Math.max(0, Math.floor(x));
            const y0 = Math.max(0, Math.floor(y));
            const x1 = Math.min(width, Math.ceil(x + w));
            const y1 = Math.min(height, Math.ceil(y + h));
            for (let py = y0; py < y1; py++) {
                for (let px = x0; px < x1; px++) {
                    const o = (py * width + px) * 4;
                    rgba[o] = r;
                    rgba[o + 1] = g;
                    rgba[o + 2] = b;
                    rgba[o + 3] = a;
                }
            }
        },
        drawImage(...args) { drawImageCalls.push(args); },
        fillText(text, x, y) { fillTextCalls.push({ text, x, y }); },
        strokeText(text, x, y) { strokeTextCalls.push({ text, x, y }); },
    };
    return {
        canvas: { width, height, getContext: () => ctx },
        ctx,
        rgba,
        fillTextCalls,
        strokeTextCalls,
        drawImageCalls,
        fillRectCalls,
        pixelAt(x, y) {
            const o = (y * width + x) * 4;
            return [rgba[o], rgba[o + 1], rgba[o + 2], rgba[o + 3]];
        },
    };
}

// ── 1. Live `coverage:<dateKey>` & `sky:<dateKey>` Meta Persistence ──────────

test('W6-B-Wire (1): coverage:<dateKey> & sky:<dateKey> meta round-trip in DB_VERSION=7 and compact sky decoding', async (t) => {
    assert.equal(DB_VERSION, 7, 'meta store keys require zero IndexedDB schema bump (DB_VERSION stays 7)');
    assert.equal(coverageMetaKey('2026-11-26'), 'coverage:2026-11-26');
    assert.equal(skyMetaKey('2026-11-26'), 'sky:2026-11-26');

    setGlobal(t, 'window', Object.assign(new EventTarget(), { location: { origin: 'http://localhost' } }));
    setGlobal(t, 'document', { getElementById: () => null });
    const { App, chronicleSkyCode } = await import('../../claudeville/src/presentation/App.js');

    // Boot-time App._currentChronicleSkyCode works even before IsometricRenderer mounts,
    // and prefers renderer._lastAtmosphere once mounted.
    const app = new App();
    const bootSky = app._currentChronicleSkyCode();
    assert.equal(typeof bootSky.cloud, 'number');
    assert.equal(typeof bootSky.rain, 'number');
    assert.equal(typeof bootSky.snow, 'number');
    assert.equal(typeof bootSky.moon, 'number');

    const stormSnap = createAtmosphereSnapshot({
        now: new Date(2026, 6, 15, 22, 10),
        weatherOverride: { type: 'storm' },
    });
    app.renderer = { _lastAtmosphere: stormSnap };
    const liveStormSky = app._currentChronicleSkyCode();
    assert.deepEqual(liveStormSky, chronicleSkyCode(stormSnap));
    assert.equal(liveStormSky.rain, 2, 'storm encodes as rain=2');

    // Round-trip through ChronicleStore meta store with lease guard.
    const db = createMetaDatabase();
    const storeA = new ChronicleStore();
    const storeB = new ChronicleStore();
    t.after(() => { storeA.close(); storeB.close(); });
    storeA.db = db;
    storeB.db = db;

    const dateKey = '2026-11-26';
    const ts09 = localTs(2026, 11, 26, 9, 20);  // quarter 37
    const ts14 = localTs(2026, 11, 26, 14, 45); // quarter 59
    const ts22 = localTs(2026, 11, 26, 22, 10); // quarter 88

    const logA = new ChronicleLog({ store: storeA });
    const logB = new ChronicleLog({ store: storeB });

    const mask1 = await logA.recordCoverageQuarter(ts09);
    assert.equal(hasCoverageQuarter(mask1, quarterIndexForTime(ts09)), true);
    assert.equal(hasCoverageQuarter(mask1, quarterIndexForTime(ts14)), false);
    // Competing tab cannot write while storeA holds the meta lease.
    assert.equal(await logB.recordCoverageQuarter(ts14), null);
    await logA.recordCoverageQuarter(ts14);
    await logA.recordCoverageQuarter(ts22);

    // Record compact sky codes across clear, cloudy, rain, storm, winter snow, and full moon.
    await logA.recordSkyHour({ cloud: 0, rain: 0, snow: 0, moon: 0 }, ts09);
    await logA.recordSkyHour({ cloud: 1, rain: 0, snow: 0, moon: 1 }, localTs(2026, 11, 26, 11, 0));
    await logA.recordSkyHour({ cloud: 3, rain: 1, snow: 0, moon: 2 }, ts14);
    await logA.recordSkyHour({ cloud: 2, rain: 1, snow: 1, moon: 2 }, localTs(2026, 11, 26, 16, 0));
    await logA.recordSkyHour({ cloud: 3, rain: 2, snow: 0, moon: 3 }, ts22);

    const persistedCoverage = await logA.readDayCoverage(dateKey);
    const persistedSky = await logA.readDaySky(dateKey);
    assert.equal(typeof persistedCoverage, 'string');
    assert.equal(persistedCoverage.length, 24);
    assert.equal(Array.isArray(persistedSky), true);
    assert.equal(persistedSky.length, 24);

    // Verify ChronicleLoom decodes persisted ChronicleStore records faithfully!
    const day = weaveDay(
        [{ ts: ts14, localDate: dateKey, kind: 'commit', agentId: 'ada', project: 'claude-ville' }],
        persistedCoverage,
        persistedSky,
        { dateKey },
    );
    assert.equal(day.stats.coveredQuarters, 3);
    assert.equal(day.panels[9].sky.known, true);
    assert.equal(day.panels[9].sky.weather, 'clear');
    assert.equal(day.panels[9].sky.cloud, 0);
    assert.equal(day.panels[9].sky.moonOctant, 0);

    assert.equal(day.panels[11].sky.known, true);
    assert.equal(day.panels[11].sky.weather, 'cloud');
    assert.equal(day.panels[11].sky.cloud, 1);
    assert.equal(day.panels[11].sky.moonOctant, 1, 'compact moon=1 maps to crescent octant 1');

    assert.equal(day.panels[14].sky.known, true);
    assert.equal(day.panels[14].sky.weather, 'rain');
    assert.equal(day.panels[14].sky.cloud, 3);
    assert.equal(day.panels[14].sky.moonOctant, 2);

    assert.equal(day.panels[16].sky.known, true);
    assert.equal(day.panels[16].sky.weather, 'snow');

    assert.equal(day.panels[22].sky.known, true);
    assert.equal(day.panels[22].sky.weather, 'storm', 'compact rain=2 maps to storm');
    assert.equal(day.panels[22].sky.moonOctant, 4, 'compact moon=3 maps to full moon octant 4');

    // Missing hour & all-null compact object MUST remain honestly unknown (undyed border).
    assert.equal(day.panels[3].sky.known, false);
    assert.equal(day.panels[3].fullyUncovered, true);
    assert.equal(normalizeSkyEntry({ cloud: null, rain: null, snow: null, moon: null }, 10).known, false);

    // Releasing meta lease lets the second tab take over cleanly.
    await storeA.releaseMetaLease();
    const maskAfterHandover = await logB.recordCoverageQuarter(localTs(2026, 11, 26, 18, 0));
    assert.equal(hasCoverageQuarter(maskAfterHandover, quarterIndexForTime(localTs(2026, 11, 26, 18, 0))), true);
});

// ── 2. ChroniclePanel Loom Strip & Zero-PII Scroll PNG Export ────────────────

test('W6-B-Wire (2): ChroniclePanel renders 24h Bayeux Loom strip, syncs with Sun-Arc, and exports byte-identical 0-text Scroll PNG', async (t) => {
    const { downloads, blobs } = createFakeDom(t);
    const dateKey = '2026-11-26';
    const events = [
        { ts: localTs(2026, 11, 26, 8, 10), localDate: dateKey, kind: ChronicleEventKind.ARRIVED, agentId: 'a-secret', agentName: 'SecretAgentAlice', project: 'acme/private-ledger' },
        { ts: localTs(2026, 11, 26, 10, 15), localDate: dateKey, kind: ChronicleEventKind.COMMIT, agentId: 'a-secret', agentName: 'SecretAgentAlice', project: 'acme/private-ledger', label: 'rotate AWS_SECRET_KEY' },
        { ts: localTs(2026, 11, 26, 14, 25), localDate: dateKey, kind: ChronicleEventKind.PUSH, agentId: 'b-secret', agentName: 'BillingBotBob', project: 'corp/payroll', label: 'origin feature/secret-branch' },
        { ts: localTs(2026, 11, 26, 14, 40), localDate: dateKey, kind: ChronicleEventKind.RELEASE, agentId: 'a-secret', agentName: 'SecretAgentAlice', project: 'acme/private-ledger', label: 'v0.68.0' },
    ];
    let coverage = EMPTY_COVERAGE_MASK;
    for (const h of [8, 10, 14]) {
        for (let q = 0; q < 4; q++) coverage = setCoverageQuarter(coverage, h * 4 + q);
    }
    const sky = Array(24).fill(null);
    sky[8] = { cloud: 0, rain: 0, snow: 0, moon: 0 };
    sky[10] = { cloud: 1, rain: 0, snow: 0, moon: 0 };
    sky[14] = { cloud: 3, rain: 1, snow: 0, moon: 2 };

    const contentEl = new FakeElement('div');
    const modal = {
        contentEl,
        beginRequest: () => 1,
        isRequestCurrent: req => req === 1,
        open: () => true,
        invalidateRequest: () => {},
    };
    const log = {
        retentionDays: 14,
        async readDay() { return events; },
        async readDayPage() { return { events: [...events].reverse(), summary: summarizeDay(events), totalCount: events.length }; },
        async readDayCoverage(key) { return key === dateKey ? coverage : null; },
        async readDaySky(key) { return key === dateKey ? sky : null; },
    };

    const panel = new ChroniclePanel({ modal, chronicleLog: log, solarProvider: () => null });
    panel._request = 1;
    panel._selectedDateKey = dateKey;
    const page = await panel._readPage(dateKey);
    panel._renderPage(page, dateKey, 1);

    // 1. Loom frieze section sits cleanly beneath Sun-Arc and above Ledger.
    const sunArcIdx = contentEl.children.findIndex(n => n.classList?.contains('chronicle__sun-arc'));
    const loomIdx = contentEl.children.findIndex(n => n.classList?.contains('chronicle__loom'));
    const ledgerIdx = contentEl.children.findIndex(n => n.classList?.contains('chronicle__ledger'));
    assert.ok(sunArcIdx > 0 && loomIdx === sunArcIdx + 1 && ledgerIdx > loomIdx, 'order: Sun-Arc -> Loom -> Ledger');

    const loomCanvas = contentEl.querySelector('.chronicle__loom-canvas');
    assert.ok(loomCanvas);
    assert.equal(loomCanvas.width, LOOM_STRIP_WIDTH);
    assert.equal(loomCanvas.height, LOOM_STRIP_HEIGHT);
    assert.equal(loomCanvas.fillTextCalls.length, 0, 'Loom canvas paints 0 fillText calls');
    assert.equal(loomCanvas.strokeTextCalls.length, 0, 'Loom canvas paints 0 strokeText calls');
    assert.ok(loomCanvas.ops.some(op => op[0] === 'fillRect'), 'Loom canvas painted woven pixels');

    const hourButtons = contentEl.querySelectorAll('.chronicle__loom-hour');
    assert.equal(hourButtons.length, 24);

    // Clicking hour 14 on the Loom canvas selects hour 14, highlights Sun-Arc, and scrolls Day Book.
    assert.equal(loomHourFromOffset(0, 2304), 0);
    assert.equal(loomHourFromOffset(14 * 96 + 10, 2304), 14);
    assert.equal(loomHourFromOffset(2303.9, 2304), 23);
    loomCanvas.rect = { left: 0, top: 0, right: 2304, bottom: 72, width: 2304, height: 72 };
    loomCanvas.dispatch('click', { clientX: 14 * 96 + 12 });
    assert.equal(loomCanvas.dataset.selectedHour, '14');
    const sunCanvas = contentEl.querySelector('.chronicle__sun-arc-canvas');
    assert.equal(sunCanvas.dataset.selectedHour, '14', 'Loom click synchronizes Sun-Arc selection');
    const hour14Entry = contentEl.querySelector('.chronicle__entry[data-chronicle-hour="14"]');
    assert.ok(hour14Entry);
    assert.equal(hour14Entry.scrolled, 1, 'Loom click scrolls Day Book to that hour');

    // Clicking Sun-Arc synchronizes Loom selection back to hour 10.
    sunCanvas.rect = { left: 0, top: 0, right: 240, bottom: 36, width: 240, height: 36 };
    sunCanvas.dispatch('click', { clientX: 105 }); // hour 10
    assert.equal(loomCanvas.dataset.selectedHour, '10', 'Sun-Arc click synchronizes Loom selection');

    // 2. Export Loom Scroll PNG button produces byte-identical deterministic 0-text PNG under withPostcardFrame.
    const exportBtn = contentEl.querySelector('.chronicle__loom-export-button');
    assert.ok(exportBtn);
    assert.match(exportBtn.textContent, /Export Loom Scroll PNG/i);

    const run1 = await panel._exportLoomScroll();
    const run2 = await panel._exportLoomScroll();
    assert.ok(run1 && run2);
    assert.equal(run1.textCalls, 0);
    assert.deepEqual(run1.textSites, []);
    assert.equal(run1.fileName, 'claudeville-loom-2026-11-26.png');
    assert.equal(loomScrollFileName(dateKey), 'claudeville-loom-2026-11-26.png');
    assert.equal(run1.width, 2304);
    assert.equal(run1.height, 72);
    assert.equal(Buffer.compare(Buffer.from(run1.pngBytes), Buffer.from(run2.pngBytes)), 0, 'scroll PNG export is byte-identical');
    assert.deepEqual([...run1.pngBytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], 'valid PNG header');
    assert.equal(downloads.length, 2);
    assert.equal(downloads[0].download, 'claudeville-loom-2026-11-26.png');
    assert.equal(blobs[0].type, 'image/png');

    // Zero PII: none of the secret names/repos/branches appear in filename or raw PNG chunks.
    const rawLatin1 = Buffer.from(run1.pngBytes).toString('latin1');
    for (const secret of ['SecretAgentAlice', 'BillingBotBob', 'private-ledger', 'payroll', 'AWS_SECRET_KEY', 'secret-branch']) {
        assert.equal(run1.fileName.includes(secret), false);
        assert.equal(rawLatin1.includes(secret), false);
    }

    // Direct pure helper determinism check with reversed event order.
    const directA = exportLoomScrollPng({ dateKey, events, coverage, sky });
    const directB = exportLoomScrollPng({ dateKey, events: [...events].reverse(), coverage, sky });
    assert.equal(Buffer.compare(Buffer.from(directA.pngBytes), Buffer.from(directB.pngBytes)), 0);

    // 3. Keep-at-Night CSS chrome compliance in modal.css.
    const modalCss = fs.readFileSync(MODAL_CSS_PATH, 'utf8');
    const loomStart = modalCss.indexOf('.chronicle__loom {');
    assert.ok(loomStart > 0, 'modal.css defines .chronicle__loom rules');
    const loomSection = modalCss.slice(loomStart, modalCss.indexOf('.chronicle__chapters {', loomStart));
    assert.match(loomSection, /image-rendering:\s*pixelated\s*;/);
    assert.equal(/border-radius\s*:/i.test(loomSection), false, 'Loom chrome uses zero border-radius');
    assert.equal(/gradient\s*\(/i.test(loomSection), false, 'Loom chrome uses zero CSS gradients');
    assert.equal(/font-style\s*:\s*italic/i.test(loomSection), false, 'Loom chrome uses zero italics');
    assert.equal(/position\s*:\s*fixed/i.test(loomSection), false, 'Loom chrome uses zero position: fixed');
});

// ── 3. ChronicleTapestry Live 1152x216 Loom Band ─────────────────────────────

test('W6-B-Wire (3): ChronicleTapestry populates live 1152x216 12x2 Loom band from ChronicleLoom with 0 text and zero historical leak', () => {
    const dateKey = '2026-11-19';
    assert.equal(TAPESTRY_BANDS.loom.y, LOOM_TAPESTRY_BAND.y);
    assert.equal(TAPESTRY_BANDS.loom.width, LOOM_TAPESTRY_BAND.width);
    assert.equal(TAPESTRY_BANDS.loom.height, LOOM_TAPESTRY_BAND.height);

    const events = [
        { ts: localTs(2026, 11, 19, 9, 10), localDate: dateKey, kind: 'commit', agentId: 'a1', agentName: 'SecretAda', project: 'acme/secret-repo' },
        { ts: localTs(2026, 11, 19, 14, 20), localDate: dateKey, kind: 'push', agentId: 'a2', agentName: 'SecretBram', project: 'acme/secret-repo' },
        { ts: localTs(2026, 11, 19, 14, 35), localDate: dateKey, kind: 'release', agentId: 'a1', agentName: 'SecretAda', project: 'acme/secret-repo' },
    ];
    let coverage = EMPTY_COVERAGE_MASK;
    for (const h of [9, 14]) {
        for (let q = 0; q < 4; q++) coverage = setCoverageQuarter(coverage, h * 4 + q);
    }
    const sky = Array(24).fill(null);
    sky[9] = { cloud: 0, rain: 0, snow: 0, moon: 0 };
    sky[14] = { cloud: 3, rain: 2, snow: 0, moon: 3 };

    const activeSurface = createPixelCanvas(TAPESTRY_WIDTH, TAPESTRY_HEIGHT);
    const activeResult = renderChronicleTapestry({
        dateKey,
        summary: summarizeDay(events),
        events,
        coverage,
        sky,
        canvas: activeSurface.canvas,
    });

    // Zero text inside the Loom band, exact 13 allowlisted text calls total.
    assert.equal(activeSurface.strokeTextCalls.length, 0);
    assert.equal(activeSurface.fillTextCalls.length, 13);
    for (const call of activeSurface.fillTextCalls) {
        assert.equal(
            call.y >= TAPESTRY_BANDS.loom.y && call.y <= TAPESTRY_BANDS.loom.y + TAPESTRY_BANDS.loom.height,
            false,
            'zero fillText inside Loom band',
        );
        const s = String(call.text);
        assert.ok(
            TAPESTRY_ALLOWED_LABELS.has(s) || TAPESTRY_DATE_RE.test(s) || TAPESTRY_MASTHEAD_RE.test(s) || TAPESTRY_INT_RE.test(s),
            `allowed zero-PII text only: ${s}`,
        );
    }

    // Pixel-exact comparison against ChronicleLoom.renderLoomTapestryGrid inside band y=1124..1340
    // (skipping the 2px top/bottom brass divider bars drawn at band.y and band.y+band.height-2).
    const expectedRgba = renderLoomTapestryGrid(weaveDay(events, coverage, sky, { dateKey }));
    assert.equal(expectedRgba.width, 1152);
    assert.equal(expectedRgba.height, 216);
    for (const [sampleX, sampleY] of [
        [9 * 96 + 20, 24 + 16],       // hour 9 covered field (row 0, col 9)
        [2 * 96 + 20, 24 + 72 + 24 + 16], // hour 14 covered field (row 1, col 2)
        [2 * 96 + 20, 24 + 72 + 24 + 5],  // hour 14 storm sky border
        [0 * 96 + 4, 24 + 20],        // hour 0 uncovered bare warp thread
        [0 * 96 + 5, 24 + 20],        // hour 0 uncovered bare warp gap
    ]) {
        const expOffset = (sampleY * expectedRgba.width + sampleX) * 4;
        const expectedPx = [
            expectedRgba.data[expOffset],
            expectedRgba.data[expOffset + 1],
            expectedRgba.data[expOffset + 2],
            expectedRgba.data[expOffset + 3],
        ];
        const actualPx = activeSurface.pixelAt(TAPESTRY_BANDS.loom.x + sampleX, TAPESTRY_BANDS.loom.y + sampleY);
        assert.deepEqual(actualPx, expectedPx, `Tapestry Loom pixel (${sampleX},${sampleY}) matches ChronicleLoom exactly`);
    }

    // Empty historical day renders pure bare warp (zero leak of live agents / events).
    const emptySurface = createPixelCanvas(TAPESTRY_WIDTH, TAPESTRY_HEIGHT);
    const emptyResult = renderChronicleTapestry({
        dateKey: '2026-11-18',
        summary: summarizeDay([]),
        events: [],
        coverage: null,
        sky: null,
        cast: [{ trimColor: '#79d975', canvas: { width: 64, height: 64 } }],
        canvas: emptySurface.canvas,
    });
    assert.equal(emptyResult.stats.villagers, 0);
    assert.equal(emptyResult.loom.stats.coveredQuarters, 0);
    // Hour 14 on empty day differs from hour 14 on active day (pure bare warp vs woven cell).
    const activeH14 = activeSurface.pixelAt(TAPESTRY_BANDS.loom.x + 2 * 96 + 20, TAPESTRY_BANDS.loom.y + 24 + 72 + 24 + 20);
    const emptyH14 = emptySurface.pixelAt(TAPESTRY_BANDS.loom.x + 2 * 96 + 20, TAPESTRY_BANDS.loom.y + 24 + 72 + 24 + 20);
    assert.notDeepEqual(activeH14, emptyH14, 'live woven Tapestry Loom band differs from empty bare-warp day');
    assert.equal(activeResult.loom.panels[14].eventCells.length, 2);
});

// ── 4. Live Archive Rear-Wall Loom Panel (App + BuildingSprite + Cutaways) ──

test('W6-B-Wire (4): App weaves live Archive rear-wall panel, closes it on audio:evensong, and BuildingCutaways shears it strictly inside the cut', async (t) => {
    createFakeDom(t);
    setGlobal(t, 'window', Object.assign(new EventTarget(), {
        location: { origin: 'http://localhost' },
        __claudeVillePerf: {},
        setInterval,
        clearInterval,
    }));
    const { App, buildArchiveLoomPanelCanvas } = await import('../../claudeville/src/presentation/App.js');

    const dateKey = chronicleDateKey();
    const today = new Date();
    const y = today.getFullYear();
    const m = today.getMonth() + 1;
    const d = today.getDate();

    // 1. Empty day (no coverage, no events) -> null panel (V8 honesty: zero placeholder).
    const emptyBuilt = buildArchiveLoomPanelCanvas({ events: [], coverage: null, sky: null, dateKey });
    assert.equal(emptyBuilt.canvas, null);
    assert.equal(emptyBuilt.panel, null);
    assert.equal(selectArchiveLoomPanel(emptyBuilt.dayModel), null);

    // 2. Active day -> selects latest active hour, 96x72, 0 text calls, and closed=true adds closing hem.
    const events = [
        { ts: localTs(y, m, d, 10, 5), localDate: dateKey, kind: 'commit', agentId: 'a1', project: 'claude-ville' },
        { ts: localTs(y, m, d, 15, 20), localDate: dateKey, kind: 'push', agentId: 'a2', project: 'claude-ville' },
    ];
    let coverage = EMPTY_COVERAGE_MASK;
    for (const h of [10, 15]) {
        for (let q = 0; q < 4; q++) coverage = setCoverageQuarter(coverage, h * 4 + q);
    }
    const sky = Array(24).fill(null);
    sky[15] = { cloud: 1, rain: 0, snow: 0, moon: 0 };

    const openBuilt = buildArchiveLoomPanelCanvas({ events, coverage, sky, dateKey, closed: false });
    const closedBuilt = buildArchiveLoomPanelCanvas({ events, coverage, sky, dateKey, closed: true });
    assert.equal(openBuilt.hour, 15, 'selects latest active hour');
    assert.equal(openBuilt.textCalls, 0);
    assert.equal(openBuilt.canvas.width, LOOM_PANEL_WIDTH);
    assert.equal(openBuilt.canvas.height, LOOM_PANEL_HEIGHT);
    assert.equal(closedBuilt.hour, 15);
    assert.equal(closedBuilt.closed, true);
    assert.equal(closedBuilt.textCalls, 0);
    assert.notDeepEqual(openBuilt.rgba.data, closedBuilt.rgba.data, 'Evensong close stitches the right-edge closing hem');
    // Closing hem is deterministic byte-for-byte.
    assert.deepEqual(
        renderLoomPanel(openBuilt.panel, { closed: true }).data,
        closedBuilt.rgba.data,
    );

    // 3. BuildingSprite.setArchiveLoomPanel + drawArchiveCutaway containment & silence on null.
    const mockArchiveBuilding = { type: 'archive' };
    const dims = { 'building.archive': { w: 336, h: 240 } };
    const renderer = Object.assign(Object.create(BuildingSprite.prototype), {
        assets: {
            get: (id) => ({ width: 1, height: 1, id }),
            getDims: (id) => dims[id] || null,
            getAnchor: () => [167, 182],
        },
        sprites: { drawSprite: () => ({ dx: 0, dy: 0 }) },
        agentSprites: [],
        buildings: [mockArchiveBuilding],
        _zoom: 2,
        _restZoom: 2,
        _selectedBuildingType: 'archive',
        _deskAssignments: new Map(),
        _roomSlotsByType: new Map(),
        _apertureModel: null,
        _apertureProfile: null,
        _apertureSessions: [],
        _glassCutawayTarget: null,
        _cutawayPeel: new CutawayPeelController(),
        _cutawayPeelSnap: null,
        _cutawayPeelSerial: null,
        _cutawayRoofCache: new Map(),
        _cutawayLiving: null,
        _harborPendingRepos: [],
        _compactionRecords: [],
        _archiveLoomPanel: null,
        _partPassSerial: 1,
        motionScale: 1,
    });
    renderer._updateInspection();
    const open = renderer._openApertureFor(mockArchiveBuilding);
    assert.ok(open);

    // Null panel -> ZERO Loom outline or placeholder drawn.
    const nullState = buildArchiveCutawayState({ agents: [], compactions: [], loomPanel: null });
    const nullRects = [];
    const nullDraws = [];
    const nullCtx = {
        fillStyle: '',
        fillRect(x, y0, w, h) { nullRects.push({ x, y: y0, w, h }); },
        drawImage(...args) { nullDraws.push(args); },
    };
    const nullRes = drawArchiveCutaway(nullCtx, nullState, { showBayNames: false });
    assert.equal(nullRes.loomDrawn, false);
    assert.equal(nullDraws.length, 0, 'null loom.panel emits zero drawImage calls');
    // Only compaction shelf board rects appear; zero rects inside loomWall destRect.
    const loomRect = ARCHIVE_CUTAWAY_PROFILE.loomWall.destRect;
    assert.equal(
        nullRects.some(r => r.x >= loomRect.x - 1 && r.x <= loomRect.x + loomRect.width && r.y <= loomRect.y + loomRect.height),
        false,
        'null loom.panel draws zero placeholder box on rear wall',
    );

    // Live panel via BuildingSprite.setArchiveLoomPanel invalidates cache immediately and draws sheared along +0.5 strictly inside cut!
    const beforeLiving = renderer._cutawayLivingState('archive', open.model, open.profile);
    assert.equal(beforeLiving.archive.loomWall.panel, null);
    renderer.setArchiveLoomPanel(openBuilt.canvas);
    const afterLiving = renderer._cutawayLivingState('archive', open.model, open.profile);
    assert.equal(afterLiving.archive.loomWall.panel, openBuilt.canvas, 'setArchiveLoomPanel invalidates Archive living cache');

    const loomRects = [];
    const loomDraws = [];
    const checkCtx = {
        fillStyle: '',
        imageSmoothingEnabled: true,
        fillRect(x, y0, w, h) { loomRects.push({ x, y: y0, w, h }); },
        drawImage(...args) { loomDraws.push(args); },
    };
    const drawRes = drawArchiveCutaway(checkCtx, afterLiving.archive, { showBayNames: false });
    assert.equal(drawRes.loomDrawn, true);
    assert.equal(checkCtx.imageSmoothingEnabled, false);
    assert.equal(loomDraws.length, loomRect.width, 'one 1-texel sheared column draw per destRect width');

    const archiveCut = getBuildingApertureProfile('archive').cut;
    const mountOffset = ARCHIVE_CUTAWAY_PROFILE.loomWall.mountOffset || { x: 0, y: 0 };
    assert.equal(mountOffset.y >= 2, true, 'Archive Loom panel clears the top-right wall-plate beam');
    for (let col = 0; col < loomDraws.length; col++) {
        const [img, sx, sy, sw, sh, dx, dy, dw, dh] = loomDraws[col];
        assert.ok(img && img !== openBuilt.canvas, 'draws crisply downsampled 48x36 surface, not raw 2:1 point decimation');
        assert.equal(img.width, loomRect.width);
        assert.equal(img.height, loomRect.height);
        assert.equal(sx, col);
        assert.equal(sy, 0);
        assert.equal(sw, 1);
        assert.equal(sh, loomRect.height);
        assert.equal(dx, loomRect.x + mountOffset.x + col);
        assert.equal(dy, loomRect.y + mountOffset.y + Math.round(0.5 * col), 'sheared along Archive nave +0.5 rear wall slope');
        assert.equal(dw, 1);
        assert.equal(dh, loomRect.height);
        for (let py = dy; py < dy + dh; py++) {
            assert.equal(
                apertureCutContains(archiveCut, dx + 0.5, py + 0.5),
                true,
                `sheared Loom texel (${dx},${py}) must lie strictly inside Archive cutaway mask`,
            );
        }
    }
    for (const r of loomRects) {
        for (let py = Math.floor(r.y); py < Math.floor(r.y) + Math.ceil(r.h); py++) {
            for (let px = Math.floor(r.x); px < Math.floor(r.x) + Math.ceil(r.w); px++) {
                assert.equal(
                    apertureCutContains(archiveCut, px + 0.5, py + 0.5),
                    true,
                    `Archive cutaway fill texel (${px},${py}) strictly inside cut`,
                );
            }
        }
    }

    // 4. App live wiring: refreshArchiveLoomPanel + `audio:evensong` active guard & close.
    const receivedPanels = [];
    const app = new App();
    app.chronicleLog = {
        flush: async () => {},
        readDay: async () => events,
        readDayCoverage: async () => coverage,
        readDaySky: async () => sky,
        recordCoverageQuarter: async () => coverage,
        recordSkyHour: async () => sky,
    };
    app.renderer = {
        buildingRenderer: {
            setArchiveLoomPanel(p) {
                receivedPanels.push(p);
                renderer.setArchiveLoomPanel(p);
            },
        },
    };
    app._bindChronicleSignals();
    try {
        const liveState = await app.refreshArchiveLoomPanel({ dateKey });
        assert.equal(liveState.hour, 15);
        assert.equal(liveState.closed, false);
        assert.equal(receivedPanels.length, 1);
        assert.ok(renderer._archiveLoomPanel === liveState.canvas);

        // Night C2 overlay grading routes `archive.loomPanel` through `_gradedCutawayImage`.
        const gradedKeys = [];
        renderer._gradedCutawayImage = (key, image) => {
            gradedKeys.push({ key, image });
            return image;
        };
        renderer._ungradedOverlay = true;
        renderer.atmosphereState = {
            lightGrade: {
                exposure: 0.45, saturation: 0.7, gain: [0.6, 0.65, 0.9], lift: [0, 0, 0.02],
                gamma: [1, 1, 1], shadowTint: [0.1, 0.12, 0.2], highlightTint: [1, 1, 1], purkinje: [0, 0, 0], night: 1,
            },
        };
        const nightCtx = {
            fillStyle: '', font: '', globalAlpha: 1, imageSmoothingEnabled: true,
            save() {}, restore() {}, translate() {}, scale() {},
            getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }), setTransform() {},
            measureText: (s) => ({ width: String(s).length * 7 }),
            fillRect() {}, drawImage() {}, fillText() {}, strokeText() {},
        };
        renderer._drawInspectionAperture(nightCtx, mockArchiveBuilding, { id: 'building.archive' }, 167, 182, open);
        renderer._ungradedOverlay = false;
        assert.ok(
            gradedKeys.some(entry => entry.key === 'archive.loomPanel' && entry.image === liveState.canvas),
            'Archive rear-wall Loom panel takes C2 night grading on the ungraded overlay',
        );

        // Cancelled / ending `audio:evensong` (`active: false` or omitted) MUST NOT close the Loom!
        eventBus.emit('audio:evensong', { day: dateKey, active: false, reason: 'cancelled', ts: localTs(y, m, d, 21, 0) });
        eventBus.emit('audio:evensong', { dateKey, ts: localTs(y, m, d, 21, 0) });
        await Promise.allSettled([...app._chronicleTasks]);
        assert.equal(app._archiveLoomClosedDate, null, 'cancelled/inactive audio:evensong does not close Loom');
        assert.equal(app._archiveLoomPanelState.closed, false);
        assert.equal(receivedPanels.length, 1, 'cancelled/inactive audio:evensong triggers zero extra refreshes');

        // Active `audio:evensong` (`active: true`, `day`) closes today's last panel cleanly!
        eventBus.emit('audio:evensong', { day: dateKey, active: true, ts: localTs(y, m, d, 21, 0) });
        await Promise.allSettled([...app._chronicleTasks]);
        assert.equal(app._archiveLoomClosedDate, dateKey);
        assert.equal(app._archiveLoomPanelState.closed, true);
        assert.equal(receivedPanels.length, 2, 'active audio:evensong pushes closed Loom panel to Archive renderer');
        assert.ok(receivedPanels[1] !== receivedPanels[0], 'closed Evensong panel replaces open panel surface');
    } finally {
        await app.destroy();
    }
});

// ── 5. Performance Budget (<= 50 ms / day) ───────────────────────────────────

test('W6-B-Wire (5): live day weave + frieze + tapestry grid + Archive panel stays well within <= 50 ms/day budget', () => {
    const dateKey = '2026-11-26';
    const events = [];
    for (let h = 0; h < 24; h++) {
        for (let k = 0; k < 10; k++) {
            events.push({
                id: `perf-${h}-${k}`,
                ts: localTs(2026, 11, 26, h, k * 5),
                localDate: dateKey,
                kind: ['commit', 'push', 'mended', 'errored', 'completed', 'compacted', 'rate_limited', 'release', 'arrived', 'departed'][k],
                agentId: `agent-${k}`,
                project: `repo-${(h + k) % 6}`,
            });
        }
    }
    const coverage = createCoverageMask({ all: true });
    const sky = Array.from({ length: 24 }, (_, h) => ({
        cloud: h % 4,
        rain: h % 7 === 0 ? 2 : h % 5 === 0 ? 1 : 0,
        snow: h === 3 ? 1 : 0,
        moon: h % 4,
    }));

    // Warm up JIT.
    const warm = weaveDay(events, coverage, sky, { dateKey });
    renderLoomFrieze(warm);
    renderLoomTapestryGrid(warm);
    renderLoomPanel(warm);

    const timings = [];
    for (let i = 0; i < 5; i++) {
        const t0 = performance.now();
        const day = weaveDay(events, coverage, sky, { dateKey });
        const strip = renderLoomFrieze(day);
        const grid = renderLoomTapestryGrid(day);
        const panel = renderLoomPanel(day);
        const elapsed = performance.now() - t0;
        assert.equal(strip.width, 2304);
        assert.equal(grid.width, 1152);
        assert.equal(panel.width, 96);
        timings.push(elapsed);
    }
    timings.sort((a, b) => a - b);
    const medianMs = timings[Math.floor(timings.length / 2)];
    assert.ok(medianMs <= 50, `expected full live weave+render <= 50 ms/day, got median ${medianMs.toFixed(2)} ms`);
});

// ── 6. Wave 6 Council Fix-B Integration Tests ────────────────────────────────

test('W6-B-Wire (6): cached 14x16 miniature resolver across all 4 call sites, post-mount scrollLeft, readout honesty, flush before Evensong read, and 2x2 Archive downsampling', async (t) => {
    createFakeDom(t);
    const rafQueue = [];
    setGlobal(t, 'requestAnimationFrame', (fn) => {
        rafQueue.push(fn);
        return rafQueue.length;
    });
    setGlobal(t, 'cancelAnimationFrame', () => {});
    setGlobal(t, 'window', Object.assign(new EventTarget(), {
        location: { origin: 'http://localhost' },
        __claudeVillePerf: {},
        setInterval,
        clearInterval,
    }));

    const { App, createLoomMiniatureResolver, buildArchiveLoomPanelCanvas } = await import('../../claudeville/src/presentation/App.js');

    // Build two distinct synthetic idle sprite sheets (RGBA buffers) with robe colors to exercise palette swap.
    const makeSheet = (r, g, b) => {
        const w = 16;
        const h = 16;
        const data = new Uint8ClampedArray(w * h * 4);
        for (let y = 2; y < 15; y++) {
            for (let x = 4; x < 12; x++) {
                const o = (y * w + x) * 4;
                data[o] = r;
                data[o + 1] = g;
                data[o + 2] = b;
                data[o + 3] = 255;
            }
        }
        return { width: w, height: h, data };
    };
    const claudeSheet = makeSheet(200, 90, 60);
    const codexSheet = makeSheet(60, 140, 210);
    const fakeAssets = {
        missing: new Set(),
        palettes: {
            claude: { trim: ['#d97757', '#e5a34b', '#79d975'] },
            codex: { trim: ['#4fa3e3', '#79d975', '#d97757'] },
        },
        get(id) {
            if (id && id.includes('codex')) return codexSheet;
            if (id && id.includes('claude')) return claudeSheet;
            return null;
        },
        getEntry(id) {
            if (id && id.includes('codex')) return { paletteSource: { robe: ['#3c8cd2'], trim: [] } };
            if (id && id.includes('claude')) return { paletteSource: { robe: ['#c85a3c'], trim: [] } };
            return null;
        },
    };

    const resolver = createLoomMiniatureResolver({
        getAssets: () => fakeAssets,
        getCompositor: () => null,
        getWorld: () => null,
    });
    const mClaudeA = resolver({ provider: 'claude', model: 'claude-opus-4-6', agentId: 'a-1' });
    const mClaudeB = resolver({ provider: 'claude', model: 'claude-opus-4-6', agentId: 'a-2' });
    const mCodex = resolver({ provider: 'codex', model: 'gpt-5.4-codex', agentId: 'b-1' });
    const mMissing = resolver({ provider: 'unknown-provider', model: 'missing-model', agentId: 'x-1', spriteId: 'agent.none' });

    assert.ok(mClaudeA && mClaudeA.width === 14 && mClaudeA.height === 16);
    assert.ok(mCodex && mCodex.width === 14 && mCodex.height === 16);
    assert.equal(mMissing, null, 'missing sheet returns null so ChronicleLoom falls back to slate pawn');
    assert.notDeepEqual(mClaudeA.data, mCodex.data, 'distinct provider/model sheets resolve to distinct miniatures');
    assert.ok(resolver.cacheSize() >= 2, 'miniature resolver caches extracted 14x16 RGBA tiles');
    // Cached repeat call returns the exact frozen object reference.
    assert.equal(resolver({ provider: 'claude', model: 'claude-opus-4-6', agentId: 'a-1' }), mClaudeA);
    assert.ok(mClaudeB && mClaudeB.width === 14 && mClaudeB.height === 16);

    // Confirm resolver flows through modal frieze, Scroll PNG, Tapestry, and Archive panel (distinct from pawn fallback).
    const dateKey = '2026-11-26';
    const events = [
        { ts: localTs(2026, 11, 26, 18, 10), localDate: dateKey, kind: 'commit', provider: 'claude', model: 'claude-opus-4-6', agentId: 'a-1', project: 'claude-ville' },
        { ts: localTs(2026, 11, 26, 18, 25), localDate: dateKey, kind: 'push', provider: 'codex', model: 'gpt-5.4-codex', agentId: 'b-1', project: 'claude-ville' },
    ];
    let coverage = EMPTY_COVERAGE_MASK;
    for (let q = 0; q < 4; q++) coverage = setCoverageQuarter(coverage, 18 * 4 + q);

    const scrollWithResolver = exportLoomScrollPng({ dateKey, events, coverage, resolveMiniature: resolver });
    const scrollFallback = exportLoomScrollPng({ dateKey, events, coverage, resolveMiniature: null });
    assert.notEqual(
        Buffer.compare(Buffer.from(scrollWithResolver.pngBytes), Buffer.from(scrollFallback.pngBytes)),
        0,
        'Scroll PNG uses real miniatures rather than fallback slate pawns',
    );

    const tapWithResolver = createPixelCanvas(TAPESTRY_WIDTH, TAPESTRY_HEIGHT);
    const tapFallback = createPixelCanvas(TAPESTRY_WIDTH, TAPESTRY_HEIGHT);
    renderChronicleTapestry({ dateKey, summary: summarizeDay(events), events, coverage, resolveMiniature: resolver, canvas: tapWithResolver.canvas });
    renderChronicleTapestry({ dateKey, summary: summarizeDay(events), events, coverage, resolveMiniature: null, canvas: tapFallback.canvas });
    assert.notDeepEqual(tapWithResolver.rgba, tapFallback.rgba, 'Tapestry export uses real miniatures');

    const archWithResolver = buildArchiveLoomPanelCanvas({ dateKey, events, coverage, resolveMiniature: resolver });
    const archFallback = buildArchiveLoomPanelCanvas({ dateKey, events, coverage, resolveMiniature: null });
    assert.notDeepEqual(archWithResolver.rgba.data, archFallback.rgba.data, 'Archive rear-wall panel uses real miniatures');

    // Post-mount scrollLeft brings latest woven hour (18:00) cleanly into view instead of staying at 00:00.
    const contentEl = new FakeElement('div');
    const modal = {
        contentEl,
        beginRequest: () => 1,
        isRequestCurrent: req => req === 1,
        open: () => true,
        invalidateRequest: () => {},
    };
    const log = {
        retentionDays: 14,
        async readDay() { return events; },
        async readDayPage() { return { events: [...events].reverse(), summary: summarizeDay(events), totalCount: events.length }; },
        async readDayCoverage() { return coverage; },
        async readDaySky() { return null; },
    };
    const panel = new ChroniclePanel({
        modal,
        chronicleLog: log,
        solarProvider: () => null,
        loomMiniatureResolver: resolver,
    });
    panel._request = 1;
    panel._selectedDateKey = dateKey;
    const page = await panel._readPage(dateKey);
    panel._renderPage(page, dateKey, 1);
    const viewport = contentEl.querySelector('.chronicle__loom-viewport');
    assert.ok(viewport);
    const expectedScroll = loomInitialScrollLeft(18, viewport.clientWidth, LOOM_STRIP_WIDTH);
    assert.ok(expectedScroll > 800, 'hour 18 scroll target shifts viewport well past 00:00');
    assert.equal(viewport.scrollLeft, expectedScroll, 'post-mount flush sets scrollLeft after attachment');
    assert.ok(rafQueue.length >= 1, 'schedules requestAnimationFrame post-layout scroll');
    // Reset and fire rAF to verify post-paint alignment also applies cleanly.
    viewport.scrollLeft = 0;
    rafQueue.shift()();
    assert.equal(viewport.scrollLeft, expectedScroll, 'requestAnimationFrame aligns scrollLeft to latest woven hour');

    // formatLoomReadout distinguishes work cells from selvedge arrival/departure events.
    const readout = formatLoomReadout({ coveredHours: 1, coalescedCells: 0, totalEvents: 40 });
    assert.equal(readout, '1h woven · 0 work cells · 40 events');

    // 2x2 Archive downsampler preserves single-pixel high-contrast ink/stamp details on odd coordinates that 2:1 point decimation drops!
    const test96 = new Uint8ClampedArray(96 * 72 * 4);
    for (let i = 0; i < test96.length; i += 4) {
        test96[i] = 220; test96[i + 1] = 210; test96[i + 2] = 190; test96[i + 3] = 255;
    }
    // Place a vivid dark-red stamp pixel at odd (x=11, y=21), which 2:1 point sampling at (10,20) misses completely.
    const oddOff = (21 * 96 + 11) * 4;
    test96[oddOff] = 160; test96[oddOff + 1] = 24; test96[oddOff + 2] = 24; test96[oddOff + 3] = 255;
    const ds48 = downsampleLoomPanel2x(test96, 96, 72, 48, 36);
    const dstOff = (10 * 48 + 5) * 4;
    assert.deepEqual(
        [ds48[dstOff], ds48[dstOff + 1], ds48[dstOff + 2]],
        [160, 24, 24],
        '2x2 contrast downsampler preserves odd-coordinate stamp pixels lost by naive 2:1 decimation',
    );

    // Verify App.js wires flush() before readDay in setDayEventsProvider.
    const appSrc = fs.readFileSync(path.join(ROOT, 'claudeville/src/presentation/App.js'), 'utf8');
    const providerIdx = appSrc.indexOf('setDayEventsProvider');
    assert.ok(providerIdx > 0);
    const providerBlock = appSrc.slice(providerIdx, providerIdx + 360);
    assert.ok(
        providerBlock.indexOf('flush') > 0 && providerBlock.indexOf('flush') < providerBlock.indexOf('readDay'),
        'setDayEventsProvider flushes ChronicleLog before calling readDay',
    );
});
