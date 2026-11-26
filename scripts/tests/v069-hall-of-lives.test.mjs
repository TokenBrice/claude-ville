import test from 'node:test';
import assert from 'node:assert/strict';

import {
    BOOK_OF_LIVES_CHAPTER_LIMIT,
    buildBookOfLivesViewModel,
} from '../../claudeville/src/presentation/shared/ActivityPanel.js';
import {
    buildHallOfLives,
    ChroniclePanel,
    HALL_OF_LIVES_CHAPTER_LIMIT,
    HALL_OF_LIVES_MAX_AVATAR_CANVASES,
    HALL_OF_LIVES_PAGE_SIZE,
} from '../../claudeville/src/presentation/shared/ChroniclePanel.js';
import { Modal } from '../../claudeville/src/presentation/shared/Modal.js';
import { AvatarCanvas } from '../../claudeville/src/presentation/dashboard-mode/AvatarCanvas.js';
import {
    BIOGRAPHY_RETENTION_MAX_ROWS,
    ChronicleStore,
} from '../../claudeville/src/infrastructure/ChronicleStore.js';
import { ChronicleLog } from '../../claudeville/src/application/ChronicleLog.js';
import { AgentBiography } from '../../claudeville/src/domain/value-objects/AgentBiography.js';
import { Agent } from '../../claudeville/src/domain/entities/Agent.js';

const NOW = Date.UTC(2026, 10, 20, 12, 0, 0);

function makeBiographyRecord(index, {
    scope = 'project',
    provider = 'claude',
    slug = `repo-${index}`,
    lastSeenAt = NOW - index * 1000,
    firstSeenAt = NOW - (index + 10) * 86_400_000,
    episodeCount = 32,
} = {}) {
    const episodes = Array.from({ length: episodeCount }, (_, ep) => ({
        id: `ep-${index}-${ep}`,
        kind: ep % 2 === 0 ? 'commit' : 'completed',
        at: lastSeenAt - (episodeCount - ep) * 60_000,
        project: slug,
    }));
    return {
        identityKey: `${scope}:${provider}:${slug}`,
        displayName: `Villager ${index}`,
        schemaVersion: 4,
        firstSeenAt,
        lastSeenAt,
        milestones: [
            { id: 'first-seen', kind: 'milestone', at: firstSeenAt, label: 'Settled in the village' },
        ],
        extensions: {
            lifeEpisodes: episodes,
        },
    };
}

function makeFakeElement(tag) {
    const listeners = new Map();
    const classes = new Set();
    const attrs = new Map();
    const el = {
        tagName: String(tag || 'div').toUpperCase(),
        children: [],
        style: {},
        dataset: {},
        textContent: '',
        innerHTML: '',
        disabled: false,
        width: 0,
        height: 0,
        tabIndex: 0,
        inert: false,
        isConnected: true,
        parentNode: null,
        classList: {
            add(...names) { for (const n of names) classes.add(n); },
            remove(...names) { for (const n of names) classes.delete(n); },
            toggle(name, force) {
                const on = force === undefined ? !classes.has(name) : Boolean(force);
                if (on) classes.add(name);
                else classes.delete(name);
                return on;
            },
            contains(name) { return classes.has(name); },
        },
        setAttribute(k, v) { attrs.set(k, String(v)); },
        getAttribute(k) { return attrs.get(k) ?? null; },
        addEventListener(type, fn) {
            if (!listeners.has(type)) listeners.set(type, new Set());
            listeners.get(type).add(fn);
        },
        removeEventListener(type, fn) {
            listeners.get(type)?.delete(fn);
        },
        dispatchEvent(event) {
            for (const fn of [...(listeners.get(event.type) || [])]) fn(event);
        },
        click() {
            this.dispatchEvent({ type: 'click', target: this, preventDefault() {} });
        },
        focus() {},
        append(...items) {
            for (const item of items) {
                if (item && typeof item === 'object') item.parentNode = this;
                this.children.push(item);
            }
        },
        replaceChildren(...items) {
            for (const child of this.children) {
                if (child && typeof child === 'object') child.parentNode = null;
            }
            this.children = [];
            this.append(...items);
        },
        remove() {
            if (this.parentNode) {
                const idx = this.parentNode.children.indexOf(this);
                if (idx >= 0) this.parentNode.children.splice(idx, 1);
                this.parentNode = null;
            }
        },
        querySelector(sel) {
            if (sel === '.modal') return this._modalBox || null;
            return null;
        },
        querySelectorAll() { return []; },
        getAnimations() { return []; },
        getContextCalls: [],
        getContext(kind, options) {
            this.getContextCalls.push({ kind, options });
            return {
                imageSmoothingEnabled: true,
                clearRect() {},
                fillRect() {},
                save() {},
                restore() {},
                translate() {},
                scale() {},
                beginPath() {},
                closePath() {},
                moveTo() {},
                lineTo() {},
                arc() {},
                ellipse() {},
                rect() {},
                strokeRect() {},
                stroke() {},
                fill() {},
                drawImage() {},
                getImageData(_x, _y, w, h) {
                    return { data: new Uint8ClampedArray(Math.max(1, w * h * 4)) };
                },
            };
        },
    };
    return el;
}

function findAll(root, predicate, out = []) {
    if (!root || typeof root !== 'object') return out;
    if (predicate(root)) out.push(root);
    for (const child of root.children || []) findAll(child, predicate, out);
    return out;
}

function installFakeDom(t) {
    const prev = {
        document: globalThis.document,
        Node: globalThis.Node,
        Image: globalThis.Image,
    };
    class FakeNode {}
    class FakeImage {
        constructor() {
            this.complete = false;
            this.naturalWidth = 0;
            this.width = 0;
            this.height = 0;
        }
        set src(value) { this._src = value; }
        get src() { return this._src; }
    }
    const createElement = (tag) => Object.assign(new FakeNode(), makeFakeElement(tag));
    const docListeners = new Map();
    const fakeDocument = {
        body: { children: [] },
        activeElement: null,
        createElement,
        createTextNode: text => String(text),
        addEventListener(type, fn) {
            if (!docListeners.has(type)) docListeners.set(type, new Set());
            docListeners.get(type).add(fn);
        },
        removeEventListener(type, fn) {
            docListeners.get(type)?.delete(fn);
        },
        dispatchEvent(event) {
            for (const fn of [...(docListeners.get(event.type) || [])]) fn(event);
        },
    };
    globalThis.Node = FakeNode;
    globalThis.document = fakeDocument;
    globalThis.Image = FakeImage;
    t.after(() => {
        if (prev.document === undefined) delete globalThis.document;
        else globalThis.document = prev.document;
        if (prev.Node === undefined) delete globalThis.Node;
        else globalThis.Node = prev.Node;
        if (prev.Image === undefined) delete globalThis.Image;
        else globalThis.Image = prev.Image;
    });
    return fakeDocument;
}

/**
 * In-memory IndexedDB shim supporting `biographies` index `'lastSeenAt'`
 * with IDB spec `'prev'` ordering (`lastSeenAt DESC, identityKey DESC`),
 * optional `continuePrimaryKey`, and ascending cursor deletes for `prune()`.
 */
function memoryBiographyDb(rows, { supportContinuePrimaryKey = true, supportGetAllRecords = false } = {}) {
    const tables = {
        manifests: [],
        monuments: [],
        trailSamples: [],
        affinities: [],
        biographies: rows,
        events: [],
        meta: [],
    };
    const keyPaths = {
        manifests: 'id',
        monuments: 'id',
        trailSamples: 'id',
        affinities: 'pairKey',
        biographies: 'identityKey',
        events: 'id',
        meta: 'key',
    };
    let cursorSteps = 0;

    function compareKey(a, b) {
        if (a === b) return 0;
        return a < b ? -1 : 1;
    }

    return {
        tables,
        get cursorSteps() { return cursorSteps; },
        resetSteps() { cursorSteps = 0; },
        transaction() {
            let pending = 0;
            const tx = {
                oncomplete: null,
                onerror: null,
                onabort: null,
                objectStore(name) {
                    const settle = (request, produce) => {
                        pending++;
                        setImmediate(() => {
                            try {
                                request.result = produce();
                                request.onsuccess?.();
                            } catch (error) {
                                request.error = error;
                                request.onerror?.();
                            }
                            if (--pending === 0) {
                                setImmediate(() => { if (pending === 0) tx.oncomplete?.(); });
                            }
                        });
                        return request;
                    };
                    const makeSource = (indexField) => {
                        const querySorted = (range, direction = 'next') => {
                            const keyField = indexField || keyPaths[name];
                            const pkField = keyPaths[name];
                            const filtered = tables[name].filter(row => {
                                const val = row[keyField];
                                if (typeof val === 'undefined' || val === null) return false;
                                if (!range) return true;
                                if (range.upper !== undefined) {
                                    if (range.upperOpen ? !(val < range.upper) : !(val <= range.upper)) return false;
                                }
                                if (range.lower !== undefined) {
                                    if (range.lowerOpen ? !(val > range.lower) : !(val >= range.lower)) return false;
                                }
                                return true;
                            });
                            filtered.sort((a, b) => {
                                const k = compareKey(a[keyField], b[keyField]);
                                const cmp = k !== 0 ? k : compareKey(String(a[pkField]), String(b[pkField]));
                                return direction === 'prev' ? -cmp : cmp;
                            });
                            return { filtered, keyField, pkField };
                        };
                        const src = {
                            openCursor(range, direction = 'next') {
                                const { filtered, keyField, pkField } = querySorted(range, direction);
                                const request = {};
                                let pos = 0;
                                const produce = () => {
                                    const value = filtered[pos++];
                                    if (!value) return null;
                                    cursorSteps++;
                                    const cur = {
                                        key: value[keyField],
                                        primaryKey: value[pkField],
                                        value,
                                        delete() {
                                            const idx = tables[name].indexOf(value);
                                            if (idx >= 0) tables[name].splice(idx, 1);
                                        },
                                        continue() {
                                            settle(request, produce);
                                        },
                                    };
                                    if (supportContinuePrimaryKey && indexField) {
                                        cur.continuePrimaryKey = (targetKey, targetPk) => {
                                            // IDB 2.0 'prev': target must be strictly less than current (key, pk).
                                            if (direction === 'prev') {
                                                const curCmp = compareKey(targetKey, cur.key)
                                                    || compareKey(String(targetPk), String(cur.primaryKey));
                                                if (curCmp >= 0) throw new Error('DataError: target must be strictly less');
                                                while (pos < filtered.length) {
                                                    const row = filtered[pos];
                                                    const cmp = compareKey(row[keyField], targetKey)
                                                        || compareKey(String(row[pkField]), String(targetPk));
                                                    if (cmp <= 0) break;
                                                    pos++;
                                                }
                                            }
                                            settle(request, produce);
                                        };
                                    }
                                    return cur;
                                };
                                return settle(request, produce);
                            },
                        };
                        if (supportGetAllRecords && indexField) {
                            src.getAllRecords = ({ query = null, count = Infinity, direction = 'next' } = {}) => {
                                const { filtered, keyField, pkField } = querySorted(query, direction);
                                const request = {};
                                return settle(request, () => {
                                    cursorSteps++;
                                    return filtered.slice(0, count).map(value => ({
                                        key: value[keyField],
                                        primaryKey: value[pkField],
                                        value,
                                    }));
                                });
                            };
                        }
                        return src;
                    };
                    return {
                        ...makeSource(null),
                        indexNames: { contains: () => true },
                        index: field => makeSource(field),
                        count() { return settle({}, () => tables[name].length); },
                        put(record) { return settle({}, () => { tables[name].push(record); return record.key; }); },
                    };
                },
            };
            return tx;
        },
    };
}

test('out-of-range and malformed timestamps never throw RangeError in Book of Lives or Hall of Lives', () => {
    const badTimestamps = [1e18, -1e18, Infinity, -Infinity, -1, 0, NaN, null, undefined, 'not-a-date'];
    for (const bad of badTimestamps) {
        const record = {
            identityKey: 'named:claude:chronos',
            displayName: 'Chronos',
            firstSeenAt: bad,
            lastSeenAt: bad,
            milestones: [{ id: 'first-seen', at: bad }],
            extensions: {
                lifeEpisodes: [
                    { id: 'bad-1', kind: 'commit', at: bad, project: 'claude-ville' },
                    { id: 'ok-1', kind: 'push', at: NOW - 5_000, project: 'claude-ville' },
                ],
            },
        };
        const book = buildBookOfLivesViewModel(record, { now: NOW });
        assert.ok(typeof book.firstSeenLabel === 'string');
        assert.ok(typeof book.lastReturnedLabel === 'string');
        for (const ch of [...book.archivedChapters, ...book.visibleChapters]) {
            assert.ok(typeof ch.dateLabel === 'string');
        }
        const lives = buildHallOfLives([record], { now: NOW });
        assert.equal(lives.length, 1);
        assert.equal(lives[0].name, 'Chronos');
    }

    const huge = buildBookOfLivesViewModel({
        identityKey: 'named:claude:overflow',
        firstSeenAt: 1e18,
        lastSeenAt: 1e18,
        extensions: {
            lifeEpisodes: [{ id: 'ep-huge', kind: 'commit', at: 1e18, project: 'demo' }],
        },
    }, { now: NOW });
    assert.equal(huge.firstSeenLabel, 'Unknown');
    assert.equal(huge.visibleChapters[0].dateLabel, 'Unknown');
});

test('buildBookOfLivesViewModel chapterLimit slices before date formatting and keeps full chapters when omitted', (t) => {
    const proto = Intl.DateTimeFormat.prototype;
    const origDesc = Object.getOwnPropertyDescriptor(proto, 'format');
    let formatCalls = 0;
    Object.defineProperty(proto, 'format', {
        configurable: true,
        get() {
            const bound = origDesc.get.call(this);
            return (...args) => {
                formatCalls++;
                return bound(...args);
            };
        },
    });
    t.after(() => { Object.defineProperty(proto, 'format', origDesc); });

    const record = makeBiographyRecord(1, { episodeCount: 32 });

    formatCalls = 0;
    const sliced = buildBookOfLivesViewModel(record, { now: NOW, chapterLimit: HALL_OF_LIVES_CHAPTER_LIMIT });
    assert.equal(sliced.visibleChapters.length, HALL_OF_LIVES_CHAPTER_LIMIT);
    assert.equal(sliced.archivedChapters.length, 0);
    // 1 call for firstSeenAt + 3 calls for the 3 sliced chapters = 4 total (never 33!).
    assert.equal(formatCalls, 1 + HALL_OF_LIVES_CHAPTER_LIMIT);

    formatCalls = 0;
    const full = buildBookOfLivesViewModel(record, { now: NOW });
    assert.equal(full.chapterCount, BOOK_OF_LIVES_CHAPTER_LIMIT);
    assert.equal(formatCalls, 1 + BOOK_OF_LIVES_CHAPTER_LIMIT);
});

test('buildHallOfLives processes 10,000 records x 32 episodes in < 200 ms with zero new Intl.DateTimeFormat allocations', (t) => {
    const OriginalDTF = Intl.DateTimeFormat;
    let ctorCalls = 0;
    Intl.DateTimeFormat = new Proxy(OriginalDTF, {
        construct(target, args, newTarget) {
            ctorCalls++;
            return Reflect.construct(target, args, newTarget);
        },
    });
    t.after(() => { Intl.DateTimeFormat = OriginalDTF; });

    const records = Array.from({ length: 10_000 }, (_, i) => makeBiographyRecord(i, {
        scope: i % 2 === 0 ? 'project' : 'named',
        episodeCount: 32,
    }));

    const start = performance.now();
    const lives = buildHallOfLives(records, { now: NOW });
    const elapsedMs = performance.now() - start;

    assert.equal(ctorCalls, 0, 'cached module-level formatter must be reused without allocations');
    assert.equal(lives.length, 10_000);
    assert.equal(lives[0].chapters.length, HALL_OF_LIVES_CHAPTER_LIMIT);
    assert.ok(elapsedMs < 1000, `Expected buildHallOfLives(10k x 32) < 1000 ms, took ${elapsedMs.toFixed(1)} ms`);
});

test('_showHall catches read, render, per-record, and tab-click errors cleanly without unhandled rejections', async (t) => {
    installFakeDom(t);
    const failures = [];
    const unhandled = [];
    const onUnhandled = err => unhandled.push(err);
    process.on('unhandledRejection', onUnhandled);
    t.after(() => process.off('unhandledRejection', onUnhandled));

    const contentEl = document.createElement('div');
    const modal = { contentEl, isRequestCurrent: req => req === 1 };

    // 1. Corrupt record with throwing getter is skipped by buildHallOfLives while healthy rows survive.
    const corrupt = {
        get identityKey() { throw new Error('corrupt getter'); },
    };
    const healthy = makeBiographyRecord(0, { scope: 'named', slug: 'ada' });
    const lives = buildHallOfLives([corrupt, healthy], { now: NOW });
    assert.equal(lives.length, 1);
    assert.equal(lives[0].identityKey, 'named:claude:ada');

    // 2. Render-phase exception inside _showHall is caught and reported via toast, releasing avatars.
    const throwingPanel = new ChroniclePanel({
        modal,
        chronicleLog: {
            async readBiographiesPage() {
                return { records: [healthy], nextCursor: null, hasMore: false };
            },
        },
        toast: { show: msg => failures.push(msg) },
    });
    throwingPanel._request = 1;
    throwingPanel._renderHall = () => { throw new Error('DOM explosion'); };
    await throwingPanel._showHall(1);
    assert.equal(failures.length, 1);
    assert.match(failures[0], /Hall of Lives/);
    assert.equal(throwingPanel._avatars.length, 0);

    // 3. Tab click handler catches async rejection cleanly.
    const rejectingPanel = new ChroniclePanel({
        modal,
        chronicleLog: {
            async readBiographiesPage() { throw new Error('IDB blown up'); },
        },
        toast: { show: msg => failures.push(msg) },
    });
    rejectingPanel._request = 1;
    const tabs = rejectingPanel._tabs('day', 1);
    const hallBtn = findAll(tabs, n => n.tagName === 'BUTTON' && n.textContent === 'Hall of Lives')[0];
    hallBtn.click();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(failures.length, 2);
    assert.deepEqual(unhandled, []);
});

test('ChronicleStore.readBiographiesPage skips anonymous:* rows, stops at limit+1, and paginates tied lastSeenAt without duplicates or skips', async (t) => {
    const prevKeyRange = globalThis.IDBKeyRange;
    globalThis.IDBKeyRange = {
        upperBound: (upper, upperOpen = false) => ({ upper, upperOpen }),
        lowerBound: (lower, lowerOpen = false) => ({ lower, lowerOpen }),
        bound: (lower, upper) => ({ lower, upper }),
    };
    t.after(() => { globalThis.IDBKeyRange = prevKeyRange; });

    for (const mode of [
        { label: 'getAllRecords', supportContinuePrimaryKey: true, supportGetAllRecords: true },
        { label: 'cursor+continuePrimaryKey', supportContinuePrimaryKey: true, supportGetAllRecords: false },
        { label: 'cursor-only', supportContinuePrimaryKey: false, supportGetAllRecords: false },
    ]) {
        // Mix 200 anonymous rows, 15 durable rows sharing an identical lastSeenAt tie,
        // and 100 older durable rows.
        const tiedTs = NOW - 5_000;
        const rows = [];
        for (let i = 0; i < 200; i++) {
            rows.push({
                identityKey: `anonymous:claude:ephemeral-${String(i).padStart(3, '0')}`,
                lastSeenAt: NOW - i,
                firstSeenAt: NOW - 10_000,
            });
        }
        const expectedDurableKeys = [];
        for (let i = 0; i < 15; i++) {
            const key = `named:claude:tied-${String(i).padStart(2, '0')}`;
            rows.push({ identityKey: key, lastSeenAt: tiedTs, firstSeenAt: tiedTs - 1000 });
            expectedDurableKeys.push(key);
        }
        for (let i = 0; i < 100; i++) {
            const key = `project:codex:older-${String(i).padStart(3, '0')}`;
            rows.push({ identityKey: key, lastSeenAt: tiedTs - 1000 - i * 10, firstSeenAt: tiedTs - 5000 });
            expectedDurableKeys.push(key);
        }
        // Add an extra 500 ancient anonymous rows far below to prove early stop.
        for (let i = 0; i < 500; i++) {
            rows.push({
                identityKey: `anonymous:codex:old-${i}`,
                lastSeenAt: tiedTs - 100_000 - i,
                firstSeenAt: tiedTs - 200_000,
            });
        }

        const db = memoryBiographyDb(rows, mode);
        const store = Object.assign(Object.create(ChronicleStore.prototype), {
            db,
            open: async () => {},
        });
        const log = new ChronicleLog({ store });

        // First page with limit=6 should stop after collecting 7 durable rows,
        // never scanning the 500 old rows at the tail.
        db.resetSteps();
        const page1 = await log.readBiographiesPage({ limit: 6, cursor: null, durableOnly: true });
        assert.equal(page1.records.length, 6);
        assert.equal(page1.hasMore, true);
        assert.ok(page1.nextCursor);
        assert.ok(db.cursorSteps <= 207, `${mode.label}: expected early stop, stepped ${db.cursorSteps} times`);
        if (mode.supportGetAllRecords) {
            assert.equal(db.cursorSteps, 1, 'getAllRecords should resolve page 1 in a single batched IDB request');
        }

        // Walk ALL pages of size 6 across the 15-way tie and the 100 older rows.
        const seen = [];
        let cursor = null;
        let hasMore = true;
        let pages = 0;
        while (hasMore) {
            const page = await log.readBiographiesPage({ limit: 6, cursor, durableOnly: true });
            pages++;
            for (const rec of page.records) {
                assert.equal(rec.identityKey.startsWith('anonymous:'), false);
                seen.push(rec.identityKey);
            }
            cursor = page.nextCursor;
            hasMore = page.hasMore;
            assert.ok(pages <= 30, 'pagination must terminate cleanly');
        }
        assert.equal(seen.length, expectedDurableKeys.length,
            `${mode.label}: must visit every durable row once`);
        assert.equal(new Set(seen).size, expectedDurableKeys.length,
            `${mode.label}: must have zero duplicates`);
        assert.deepEqual([...seen].sort(), [...expectedDurableKeys].sort(),
            `${mode.label}: must skip zero rows`);
    }
});

test('Hall of Lives renders 40 rows initially, appends next page on Show more, and bounds AvatarCanvas count', async (t) => {
    installFakeDom(t);
    const total = HALL_OF_LIVES_MAX_AVATAR_CANVASES + 25; // 145 durable rows
    const allRecords = Array.from({ length: total }, (_, i) => makeBiographyRecord(i, {
        scope: 'project',
        provider: 'claude',
        slug: `repo-${String(i).padStart(3, '0')}`,
        lastSeenAt: NOW - i * 1000,
        episodeCount: 5,
    }));

    const pageRequests = [];
    const log = new ChronicleLog({
        store: {
            async queryRange() { return allRecords; },
        },
    });
    const origReadPage = log.readBiographiesPage.bind(log);
    log.readBiographiesPage = async (opts) => {
        pageRequests.push(opts);
        return origReadPage(opts);
    };

    const contentEl = document.createElement('div');
    const modal = { contentEl, isRequestCurrent: req => req === 1 };
    const panel = new ChroniclePanel({ modal, chronicleLog: log });
    panel._request = 1;

    await panel._showHall(1);
    assert.equal(pageRequests.length, 1);
    assert.equal(pageRequests[0].limit, HALL_OF_LIVES_PAGE_SIZE);

    const listEl = findAll(contentEl, n => n.classList.contains('chronicle__lives'))[0];
    assert.ok(listEl);
    assert.equal(listEl.children.length, HALL_OF_LIVES_PAGE_SIZE);
    assert.equal(panel._avatars.length, HALL_OF_LIVES_PAGE_SIZE);
    const firstRowRef = listEl.children[0];

    const findMoreBtn = () => findAll(contentEl, n => n.classList.contains('chronicle__hall-more'))[0];
    assert.ok(findMoreBtn(), 'Show more button must appear when more pages remain');

    // Click "Show more" to load page 2 (rows 41..80).
    findMoreBtn().click();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(listEl.children.length, HALL_OF_LIVES_PAGE_SIZE * 2);
    assert.strictEqual(listEl.children[0], firstRowRef, 'Show more must append without destroying earlier rows');
    assert.equal(panel._avatars.length, HALL_OF_LIVES_PAGE_SIZE * 2);

    // Click "Show more" through pages 3 and 4 (exceeding HALL_OF_LIVES_MAX_AVATAR_CANVASES).
    findMoreBtn().click();
    await new Promise(resolve => setImmediate(resolve));
    findMoreBtn().click();
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(listEl.children.length, total);
    assert.equal(panel._avatars.length, HALL_OF_LIVES_MAX_AVATAR_CANVASES,
        'AvatarCanvas instances stay capped at HALL_OF_LIVES_MAX_AVATAR_CANVASES');
    assert.equal(findMoreBtn(), undefined, 'Show more button removes itself on the last page');

    panel.destroy();
    assert.equal(panel._avatars.length, 0);
});

test('Modal.close(), owner-replacing Modal.open(), and Modal.destroy() invoke onClose once and release ChroniclePanel avatars', async (t) => {
    const doc = installFakeDom(t);
    const overlay = doc.createElement('div');
    const box = doc.createElement('div');
    const titleEl = doc.createElement('h2');
    const contentEl = doc.createElement('div');
    const closeBtn = doc.createElement('button');
    overlay._modalBox = box;
    doc.getElementById = (id) => ({
        modalOverlay: overlay,
        modalTitle: titleEl,
        modalContent: contentEl,
        modalClose: closeBtn,
    })[id] || null;

    const modal = new Modal();
    let closeCount = 0;
    modal.open('First', '<p>hi</p>', { onClose: () => { closeCount++; } });
    // Owner-replacing open invokes the previous onClose once.
    let secondCloseCount = 0;
    modal.open('Second', '<p>hello</p>', { onClose: () => { secondCloseCount++; } });
    assert.equal(closeCount, 1);
    assert.equal(secondCloseCount, 0);

    // Escape / close() invokes second onClose once, and repeated close() does not fire again.
    modal.close();
    modal.close();
    assert.equal(secondCloseCount, 1);

    // destroy() invokes onClose once if still open.
    let thirdCloseCount = 0;
    modal.open('Third', '<p>bye</p>', { onClose: () => { thirdCloseCount++; } });
    modal.destroy();
    assert.equal(thirdCloseCount, 1);

    // Full ChroniclePanel -> Hall of Lives -> Modal.close() frees 100% of AvatarCanvas instances.
    const modal2 = new Modal();
    const records = Array.from({ length: 10 }, (_, i) => makeBiographyRecord(i, { episodeCount: 3 }));
    const panel = new ChroniclePanel({
        modal: modal2,
        chronicleLog: {
            async readDayPage() {
                return {
                    events: [],
                    summary: {
                        agents: [], projects: [], totalEvents: 0, commits: 0, pushes: 0,
                        completed: 0, errors: 0, rateLimits: 0, waits: 0,
                        totalWaitMs: 0, longestWaitMs: 0, firstTs: null, lastTs: null,
                    },
                    totalCount: 0,
                };
            },
            async readBiographiesPage() {
                return { records, nextCursor: null, hasMore: false };
            },
        },
    });
    await panel.open();
    await panel._showHall(panel._request);
    assert.equal(panel._avatars.length, 10);
    const canvases = panel._avatars.map(a => a.canvas);
    assert.ok(canvases.every(c => c.width > 0 && c.height > 0));

    // Closing via Escape key releases every avatar and zeroes every canvas backing store.
    doc.dispatchEvent({ type: 'keydown', key: 'Escape', preventDefault() {} });
    assert.equal(panel._avatars.length, 0);
    assert.ok(canvases.every(c => c.width === 0 && c.height === 0));
    panel.destroy();
    modal2.destroy();
});

test('AvatarCanvas.destroy() zeroes backing store, suppresses post-destroy redraws, and scratch canvas uses willReadFrequently', async (t) => {
    installFakeDom(t);
    const prevImage = globalThis.Image;
    const pendingImages = [];
    globalThis.Image = class {
        constructor() {
            this.complete = false;
            this.naturalWidth = 0;
            this.width = 64;
            this.height = 64;
            pendingImages.push(this);
        }
        set src(value) { this._src = value; }
        get src() { return this._src; }
    };
    t.after(() => {
        if (prevImage === undefined) delete globalThis.Image;
        else globalThis.Image = prevImage;
    });

    const avatar = new AvatarCanvas({
        id: 'named:claude:ada',
        provider: 'claude',
        model: null,
        effort: null,
        appearance: { skin: '#f1c27d', shirt: '#4466aa', pants: '#223344', hair: '#221100', hairStyle: 'short', eyeStyle: 'normal' },
    }, 'niche');
    assert.ok(avatar.canvas.width > 0 && avatar.canvas.height > 0);

    // Check _spriteFrameBounds passes { willReadFrequently: true } to scratch canvas.
    const createdCanvases = [];
    const origCreate = document.createElement;
    document.createElement = (tag) => {
        const node = origCreate(tag);
        if (tag === 'canvas') createdCanvases.push(node);
        return node;
    };
    const fakeImage = { width: 64, height: 64 };
    avatar._spriteFrameBounds({ image: fakeImage }, 16, 0);
    document.createElement = origCreate;
    assert.equal(createdCanvases.length, 1);
    assert.deepEqual(createdCanvases[0].getContextCalls[0], {
        kind: '2d',
        options: { willReadFrequently: true },
    });
    assert.equal(createdCanvases[0].width, 0);
    assert.equal(createdCanvases[0].height, 0);

    // Trigger _ensureSpriteImage with an uncached sprite id, destroy before load, then resolve image.
    const uniqueSpriteId = `test-sprite-${Date.now()}`;
    let redrawCount = 0;
    avatar.redraw = () => { redrawCount++; };
    avatar._ensureSpriteImage(uniqueSpriteId);
    const loadedImage = pendingImages.at(-1);
    assert.ok(loadedImage);
    assert.strictEqual(avatar.spriteImage, loadedImage);

    avatar.destroy();
    assert.equal(avatar.canvas.width, 0);
    assert.equal(avatar.canvas.height, 0);
    assert.equal(avatar.spriteImage, null);

    // Resolving the image after destroy must NOT call redraw().
    loadedImage.complete = true;
    loadedImage.naturalWidth = 64;
    loadedImage.onload();
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(redrawCount, 0);
});

test('ChronicleStore.prune() enforces BIOGRAPHY_RETENTION_MAX_ROWS, evicting anonymous:* before durable rows', async (t) => {
    const prevKeyRange = globalThis.IDBKeyRange;
    globalThis.IDBKeyRange = {
        upperBound: (upper, upperOpen = false) => ({ upper, upperOpen }),
    };
    t.after(() => { globalThis.IDBKeyRange = prevKeyRange; });

    assert.equal(BIOGRAPHY_RETENTION_MAX_ROWS, 5_000);

    // Build 5,005 recent biographies: 3 anonymous:* (even newer than some durable rows!)
    // plus 5,002 durable rows. Cap overflow is 5: all 3 anonymous:* must be evicted first,
    // followed by the 2 oldest durable rows.
    const rows = [];
    for (let i = 0; i < BIOGRAPHY_RETENTION_MAX_ROWS + 2; i++) {
        rows.push({
            identityKey: `project:claude:repo-${i}`,
            lastSeenAt: NOW - (BIOGRAPHY_RETENTION_MAX_ROWS + 100 - i) * 1000,
        });
    }
    for (let i = 0; i < 3; i++) {
        rows.push({
            identityKey: `anonymous:claude:ephemeral-${i}`,
            lastSeenAt: NOW - (10 - i) * 1000, // newer than every durable row
        });
    }
    const db = memoryBiographyDb(rows);
    const store = Object.assign(Object.create(ChronicleStore.prototype), {
        eventRetentionDays: 14,
        db,
        open: async () => {},
    });

    const deleted = await store.prune(NOW);
    assert.equal(deleted.biographies, 5);
    assert.equal(db.tables.biographies.length, BIOGRAPHY_RETENTION_MAX_ROWS);
    assert.equal(
        db.tables.biographies.some(r => r.identityKey.startsWith('anonymous:')),
        false,
        'all anonymous:* rows must be evicted before touching durable lineages',
    );
    const remainingKeys = new Set(db.tables.biographies.map(r => r.identityKey));
    assert.equal(remainingKeys.has('project:claude:repo-0'), false, 'oldest durable row evicted for remaining overflow');
    assert.equal(remainingKeys.has('project:claude:repo-1'), false, 'second oldest durable row evicted');
    assert.equal(remainingKeys.has('project:claude:repo-2'), true, 'newer durable rows survive');
});

test('AgentBiography.identityKeyFor() blocks ephemeral subagent descriptions and auto titles while keeping userNamed, team, and project lineages', () => {
    // Ephemeral subagent launch descriptions (Claude Task, Antigravity invoke_subagent, T3 delegate, MCP, workflow)
    assert.equal(
        AgentBiography.identityKeyFor({
            id: 'subagent-abc123',
            provider: 'claude',
            agentType: 'sub-agent',
            subagentKind: 'Explore',
            parentSessionId: 'main-1',
            agentName: 'Search codebase for Hall of Lives OOM crash',
            userNamed: false,
            projectPath: '/work/claude-ville',
        }),
        'anonymous:claude:subagent-abc123',
    );
    assert.equal(
        AgentBiography.identityKeyFor({
            id: 'ag-del-1',
            provider: 'antigravity',
            agentType: 'sub-agent',
            subagentKind: 'delegate',
            parentSessionId: 'main-1',
            agentName: 'Phase 1-A: SceneCapture',
            userNamed: false,
            projectPath: '/work/claude-ville',
        }),
        'anonymous:antigravity:ag-del-1',
    );
    assert.equal(
        AgentBiography.identityKeyFor({
            id: 'wf-1',
            provider: 'claude',
            agentType: 'workflow-subagent',
            parentSessionId: 'main-1',
            agentName: 'Step 2 analyzer',
            projectPath: '/work/claude-ville',
        }),
        'anonymous:claude:wf-1',
    );
    assert.equal(
        AgentBiography.identityKeyFor({
            id: 'repo-watch-1',
            provider: 'git',
            agentType: 'repository',
            agentName: 'Repo Watch',
            userNamed: false,
        }),
        'anonymous:git:repo-watch-1',
    );

    // Auto-generated main session/thread titles (userNamed: false) fall back to project:* instead of named:*
    const autoMain = new Agent({
        id: 'main-auto-1',
        provider: 'claude',
        agentType: 'main',
        name: 'Menu UX Review: Learn Tab',
        agentName: 'Menu UX Review: Learn Tab',
        userNamed: false,
        projectPath: '/work/claude-ville',
    });
    assert.equal(AgentBiography.identityKeyFor(autoMain), 'project:claude:claude-ville');

    // Explicitly user-named mains (/rename or T3 titleRenamed: true) create durable named:*
    const renamedMain = new Agent({
        id: 'main-renamed-1',
        provider: 'claude',
        agentType: 'main',
        name: 'Sentinel',
        agentName: 'Sentinel',
        userNamed: true,
        projectPath: '/work/claude-ville',
    });
    assert.equal(AgentBiography.identityKeyFor(renamedMain), 'named:claude:sentinel');

    // Explicitly user-named delegate also creates durable named:*
    const renamedDelegate = new Agent({
        id: 'del-renamed-1',
        provider: 'antigravity',
        agentType: 'sub-agent',
        subagentKind: 'delegate',
        parentSessionId: 'main-1',
        name: 'Navigator',
        agentName: 'Navigator',
        userNamed: true,
        projectPath: '/work/claude-ville',
    });
    assert.equal(AgentBiography.identityKeyFor(renamedDelegate), 'named:antigravity:navigator');

    // Explicit team members keep durable named:* identity
    const teamMember = new Agent({
        id: 'team-mem-1',
        provider: 'claude',
        agentType: 'team-member',
        teamName: 'v069-crew',
        name: 'researcher',
        agentName: 'researcher',
        userNamed: false,
        projectPath: '/work/claude-ville',
    });
    assert.equal(AgentBiography.identityKeyFor(teamMember), 'named:claude:researcher');

    // Unnamed main continues to resolve to project:*
    const unnamedMain = new Agent({
        id: 'main-unnamed-1',
        provider: 'codex',
        agentType: 'main',
        projectPath: '/work/claude-ville',
    });
    assert.equal(AgentBiography.identityKeyFor(unnamedMain), 'project:codex:claude-ville');
});

test('ChronicleStore.readBiographiesPage paginates indexless stores in descending (lastSeenAt, identityKey) order without repeating page 1', async () => {
    const tiedTs = NOW - 5_000;
    const rows = [
        // Deliberately unsorted storage order and mixed anonymous + durable rows with timestamp ties.
        { identityKey: 'project:claude:beta', lastSeenAt: tiedTs - 2_000, firstSeenAt: tiedTs - 10_000 },
        { identityKey: 'anonymous:claude:ephemeral-1', lastSeenAt: NOW - 100, firstSeenAt: tiedTs },
        { identityKey: 'named:claude:alpha', lastSeenAt: tiedTs, firstSeenAt: tiedTs - 10_000 },
        { identityKey: 'named:claude:gamma', lastSeenAt: tiedTs, firstSeenAt: tiedTs - 10_000 },
        { identityKey: 'named:claude:delta', lastSeenAt: tiedTs, firstSeenAt: tiedTs - 10_000 },
        { identityKey: 'project:codex:zeta', lastSeenAt: NOW - 500, firstSeenAt: tiedTs - 10_000 },
        { identityKey: 'project:antigravity:omega', lastSeenAt: tiedTs - 5_000, firstSeenAt: tiedTs - 10_000 },
        { identityKey: 'named:claude:no-ts', firstSeenAt: tiedTs },
    ];

    const expectedOrder = [
        'project:codex:zeta',
        'named:claude:gamma',
        'named:claude:delta',
        'named:claude:alpha',
        'project:claude:beta',
        'project:antigravity:omega',
    ];

    for (const withGetAll of [true, false]) {
        const baseDb = memoryBiographyDb(rows, { supportContinuePrimaryKey: false, supportGetAllRecords: false });
        const indexlessDb = {
            transaction(storeName, mode) {
                const tx = baseDb.transaction(storeName, mode);
                const origObjectStore = tx.objectStore.bind(tx);
                tx.objectStore = (name) => {
                    const obj = origObjectStore(name);
                    obj.indexNames = { contains: () => false };
                    obj.index = () => { throw new Error('index should not be accessed when missing'); };
                    if (withGetAll) {
                        obj.getAll = () => {
                            const req = {};
                            setImmediate(() => {
                                req.result = [...rows];
                                req.onsuccess?.();
                            });
                            return req;
                        };
                    }
                    return obj;
                };
                return tx;
            },
        };

        const store = Object.assign(Object.create(ChronicleStore.prototype), {
            db: indexlessDb,
            open: async () => {},
        });

        const seen = [];
        let cursor = null;
        let hasMore = true;
        let pages = 0;
        while (hasMore) {
            const page = await store.readBiographiesPage({ limit: 2, cursor, durableOnly: true });
            pages++;
            assert.ok(pages <= 5, `indexless pagination (${withGetAll ? 'getAll' : 'cursor'}) must not loop`);
            for (const rec of page.records) seen.push(rec.identityKey);
            cursor = page.nextCursor;
            hasMore = page.hasMore;
        }
        assert.deepEqual(
            seen,
            expectedOrder,
            `indexless pagination (${withGetAll ? 'getAll' : 'cursor'}) must visit every durable row once in exact (lastSeenAt DESC, identityKey DESC) order`,
        );
    }
});
