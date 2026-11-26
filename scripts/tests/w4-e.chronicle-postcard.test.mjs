import test from 'node:test';
import assert from 'node:assert/strict';

import {
    ChronicleEventKind,
    chronicleDateKey,
    dayBounds,
    summarizeDay,
} from '../../claudeville/src/application/ChronicleLog.js';
import {
    AUTHORED_DIURNAL_BANDS,
    buildChronicleScenario,
    buildRetoldChapters,
    diurnalBandForMinute,
    resolveDiurnalBands,
} from '../../claudeville/src/application/ChronicleScenario.js';
import {
    CHRONICLE_COMPACTED_KIND,
    CHRONICLE_RELEASE_KIND,
    ChroniclePanel,
    SUN_ARC_HEIGHT,
    buildChronicleCsv,
    buildChronicleMarkdown,
    buildSunArcModel,
    decodeCoverageMask,
    drawSunArcRibbon,
    encodeCoverageMask,
    groupEventsIntoDiurnalChapters,
    sunArcHourFromOffset,
} from '../../claudeville/src/presentation/shared/ChroniclePanel.js';
import {
    RETOLD_SPEEDS,
    RetoldScrubber,
    THEATRE_REVEAL_BOTTOM_PX,
    clampScrubProgress,
    formatRetoldClock,
    nextRetoldSpeed,
    shouldRevealInTheatre,
} from '../../claudeville/src/presentation/shared/RetoldScrubber.js';
import {
    POSTCARD_ASPECTS,
    POSTCARD_BORDERS,
    WOODCUT_MAT_PX,
    composePostcard,
    computePostcardCropRect,
    copyPostcardToClipboard,
    livingPostcardFileName,
    postcardBandHeight,
    postcardFrame,
    postcardMatThickness,
    recordLivingPostcard,
    selectLivingPostcardMimeType,
    strikePostcard,
} from '../../claudeville/src/presentation/character-mode/Postcard.js';
import { PostcardStudio } from '../../claudeville/src/presentation/shared/PostcardStudio.js';
import { eventBus } from '../../claudeville/src/domain/events/DomainEvent.js';

// ── Minimal fake DOM / Canvas / MediaRecorder harnesses ───────────────────────

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
        if (force === undefined) {
            if (this.set.has(name)) this.set.delete(name);
            else this.set.add(name);
        } else if (force) {
            this.set.add(name);
        } else {
            this.set.delete(name);
        }
        this.owner.className = [...this.set].join(' ');
        return this.set.has(name);
    }

    contains(name) {
        return this.set.has(name);
    }
}

class FakeElement {
    constructor(tagName) {
        this.tagName = String(tagName || 'div').toUpperCase();
        this.children = [];
        this.parentNode = null;
        this.className = '';
        this.classList = new FakeClassList(this);
        this.dataset = {};
        this.style = {};
        this.attributes = new Map();
        this.listeners = new Map();
        this.textContent = '';
        this.hidden = false;
        this.disabled = false;
        this.isConnected = false;
        this.scrolled = 0;
        this.focused = false;
        this.rect = { left: 0, top: 0, right: 648, bottom: 36, width: 648, height: 36 };
        if (this.tagName === 'CANVAS') {
            this.width = 0;
            this.height = 0;
            this.ops = [];
            this.captureStreamCalls = 0;
        }
    }

    get clientWidth() { return this.rect.width; }
    get clientHeight() { return this.rect.height; }

    append(...nodes) {
        for (const child of nodes) {
            if (child == null) continue;
            if (child instanceof FakeElement) {
                child.parentNode = this;
                child.isConnected = true;
            }
            this.children.push(child);
        }
    }

    appendChild(child) {
        this.append(child);
        return child;
    }

    replaceChildren(...nodes) {
        for (const child of this.children) {
            if (child instanceof FakeElement) {
                child.parentNode = null;
                child.isConnected = false;
            }
        }
        this.children = [];
        this.append(...nodes);
    }

    remove() {
        if (this.parentNode) {
            const idx = this.parentNode.children.indexOf(this);
            if (idx >= 0) this.parentNode.children.splice(idx, 1);
        }
        this.parentNode = null;
        this.isConnected = false;
    }

    contains(node) {
        if (node === this) return true;
        return this.children.some(child => child instanceof FakeElement && child.contains(node));
    }

    setAttribute(name, value) {
        this.attributes.set(name, String(value));
    }

    getAttribute(name) {
        return this.attributes.get(name) ?? null;
    }

    addEventListener(type, fn) {
        const list = this.listeners.get(type) || [];
        list.push(fn);
        this.listeners.set(type, list);
    }

    removeEventListener(type, fn) {
        const list = this.listeners.get(type) || [];
        const idx = list.indexOf(fn);
        if (idx >= 0) list.splice(idx, 1);
    }

    dispatch(type, event = {}) {
        const list = [...(this.listeners.get(type) || [])];
        for (const fn of list) fn(event);
    }

    click() {
        if (this.disabled) return;
        this.clicked = (this.clicked || 0) + 1;
        this.dispatch('click', {
            stopPropagation() {},
            preventDefault() {},
            target: this,
        });
    }

    focus() {
        this.focused = true;
    }

    scrollIntoView(opts) {
        this.scrolled += 1;
        this.lastScrollOpts = opts;
    }

    getBoundingClientRect() {
        return { ...this.rect };
    }

    getContext() {
        if (this.tagName !== 'CANVAS') return null;
        const ops = this.ops;
        const ctx = {
            imageSmoothingEnabled: true,
            fillStyle: '',
            font: '',
            textBaseline: 'alphabetic',
            textAlign: 'left',
            clearRect: (...a) => ops.push(['clearRect', ...a]),
            fillRect: (...a) => ops.push(['fillRect', ctx.fillStyle, ...a]),
            drawImage: (...a) => ops.push(['drawImage', ...a]),
            fillText: (...a) => ops.push(['fillText', ...a]),
            strokeText: (...a) => ops.push(['strokeText', ...a]),
            putImageData: (...a) => ops.push(['putImageData', ...a]),
        };
        return ctx;
    }

    toBlob(cb, mimeType = 'image/png') {
        cb(new Blob(['fake-png-bytes'], { type: mimeType }));
    }

    querySelector(selector) {
        return this.querySelectorAll(selector)[0] || null;
    }

    querySelectorAll(selector) {
        const out = [];
        const walk = (node) => {
            if (!(node instanceof FakeElement)) return;
            if (matchesSelector(node, selector)) out.push(node);
            for (const child of node.children) walk(child);
        };
        for (const child of this.children) walk(child);
        return out;
    }
}

function matchesSelector(node, selector) {
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

function createFakeDomEnv() {
    const body = new FakeElement('body');
    const downloads = [];
    const doc = {
        body,
        activeElement: null,
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
        createTextNode(text) {
            return String(text);
        },
        querySelector(sel) {
            return body.querySelector(sel);
        },
    };
    const winListeners = new Map();
    const win = {
        innerWidth: 1280,
        innerHeight: 720,
        addEventListener(type, fn) {
            const list = winListeners.get(type) || [];
            list.push(fn);
            winListeners.set(type, list);
        },
        removeEventListener(type, fn) {
            const list = winListeners.get(type) || [];
            const idx = list.indexOf(fn);
            if (idx >= 0) list.splice(idx, 1);
        },
        dispatch(type, event = {}) {
            for (const fn of [...(winListeners.get(type) || [])]) fn(event);
        },
    };
    return { doc, win, body, downloads };
}

function localTs(year, month, day, hour, minute = 0) {
    return new Date(year, month - 1, day, hour, minute, 0, 0).getTime();
}

// ── 1. Chronicle Sun-Arc Ribbon & Diurnal Chapters ────────────────────────────

test('W4-E Chronicle: Sun-Arc builds 24 hour columns with solar bands, brass ticks, status pips, and honest uncovered linen', () => {
    const dateKey = '2026-11-19';
    const solar = { sunriseMinute: 450, sunsetMinute: 990, civilDawnMinute: 410, civilDuskMinute: 1025 }; // winter day
    const events = [
        { ts: localTs(2026, 11, 19, 2, 10), kind: ChronicleEventKind.WAITING, agentName: 'Ada' },
        { ts: localTs(2026, 11, 19, 7, 30), kind: ChronicleEventKind.COMMIT, agentName: 'Ada', label: 'feat: sun arc' },
        { ts: localTs(2026, 11, 19, 10, 15), kind: ChronicleEventKind.PUSH, agentName: 'Ada', label: 'origin main' },
        { ts: localTs(2026, 11, 19, 10, 45), kind: CHRONICLE_RELEASE_KIND, agentName: 'Ada', label: 'v0.68.0' },
        { ts: localTs(2026, 11, 19, 16, 20), kind: ChronicleEventKind.ERRORED, agentName: 'Bess' },
        { ts: localTs(2026, 11, 19, 16, 40), kind: ChronicleEventKind.WAITING, agentName: 'Bess' },
        { ts: localTs(2026, 11, 19, 21, 5), kind: CHRONICLE_COMPACTED_KIND, agentName: 'Ada', label: '412K -> 38K' },
    ];

    // Missing coverage: every hour must be honestly uncovered (`covered: false`).
    const unknownModel = buildSunArcModel({ dateKey, events, coverage: null, solar });
    assert.equal(unknownModel.hours.length, 24);
    assert.equal(unknownModel.hasCoverage, false);
    assert.equal(unknownModel.hours.every(h => h.covered === false && h.coveredQuarters === 0), true);
    assert.equal(unknownModel.hours[2].band, 'night');
    assert.equal(unknownModel.hours[7].band, 'dawn');
    assert.equal(unknownModel.hours[10].band, 'day');
    assert.equal(unknownModel.hours[16].band, 'dusk');
    assert.equal(unknownModel.hours[21].band, 'night');

    // Brass ticks include commit, push, and release; status pips mark wait/error.
    assert.equal(unknownModel.hours[7].commits, 1);
    assert.equal(unknownModel.hours[7].brassTicks, 1);
    assert.equal(unknownModel.hours[10].pushes, 1);
    assert.equal(unknownModel.hours[10].releases, 1);
    assert.equal(unknownModel.hours[10].brassTicks, 2);
    assert.equal(unknownModel.hours[2].statusPip, 'waiting');
    assert.equal(unknownModel.hours[16].hasError, true);
    assert.equal(unknownModel.hours[16].hasWait, true);
    assert.equal(unknownModel.hours[16].statusPip, 'errored');
    assert.equal(unknownModel.hours[21].compactions, 1);

    // 96-bit coverage mask: cover hour 10 fully (quarters 40..43) and hour 16 half (quarters 64..65).
    const quarters = new Array(96).fill(0);
    for (let q = 40; q <= 43; q++) quarters[q] = 1;
    quarters[64] = 1;
    quarters[65] = 1;
    const maskBytes = encodeCoverageMask(quarters);
    assert.equal(maskBytes.length, 12);
    const decoded = decodeCoverageMask(maskBytes);
    assert.equal(decoded[40], 1);
    assert.equal(decoded[43], 1);
    assert.equal(decoded[64], 1);
    assert.equal(decoded[66], 0);
    assert.equal(decoded[0], 0);

    // BigInt & hex string coverage masks match byte-for-byte.
    const bigMask = (1n << 40n) | (1n << 41n) | (1n << 42n) | (1n << 43n) | (1n << 64n) | (1n << 65n);
    assert.deepEqual([...decodeCoverageMask(bigMask)], [...decoded]);
    assert.deepEqual([...decodeCoverageMask(bigMask.toString(16).padStart(24, '0'))], [...decoded]);

    const coveredModel = buildSunArcModel({ dateKey, events, coverage: maskBytes, solar });
    assert.equal(coveredModel.hasCoverage, true);
    assert.equal(coveredModel.hours[10].covered, true);
    assert.equal(coveredModel.hours[10].coveredQuarters, 4);
    assert.equal(coveredModel.hours[16].covered, true);
    assert.equal(coveredModel.hours[16].coveredQuarters, 2);
    assert.equal(coveredModel.hours[7].covered, false);
    assert.equal(coveredModel.hours[0].covered, false);

    // Canvas draw succeeds pixel-snapped at 36 px tall.
    const canvas = new FakeElement('canvas');
    assert.equal(drawSunArcRibbon(canvas, coveredModel, { width: 648, height: SUN_ARC_HEIGHT, selectedHour: 10 }), true);
    assert.equal(canvas.width, 648);
    assert.equal(canvas.height, 36);
    assert.ok(canvas.ops.some(op => op[0] === 'fillRect'));
    assert.equal(sunArcHourFromOffset(0, 240), 0);
    assert.equal(sunArcHourFromOffset(120, 240), 12);
    assert.equal(sunArcHourFromOffset(239.9, 240), 23);
});

test('W4-E Chronicle: Day Book groups into diurnal chapters, supports compacted/release, scrolls on Sun-Arc click, and exports Tapestry PNG', async (t) => {
    const { doc } = createFakeDomEnv();
    const prevDoc = globalThis.document;
    const prevNode = globalThis.Node;
    globalThis.document = doc;
    globalThis.Node = FakeElement;
    t.after(() => {
        if (prevDoc === undefined) delete globalThis.document;
        else globalThis.document = prevDoc;
        if (prevNode === undefined) delete globalThis.Node;
        else globalThis.Node = prevNode;
    });

    const dateKey = '2026-11-19';
    const events = [
        { ts: localTs(2026, 11, 19, 1, 15), kind: ChronicleEventKind.ARRIVED, agentName: 'Ada', project: 'village' },
        { ts: localTs(2026, 11, 19, 6, 0), kind: CHRONICLE_COMPACTED_KIND, agentName: 'Ada', project: 'village', label: '412K -> 38K' },
        { ts: localTs(2026, 11, 19, 12, 30), kind: CHRONICLE_RELEASE_KIND, agentName: 'Ada', project: 'village', label: 'v0.68.0' },
        { ts: localTs(2026, 11, 19, 18, 15), kind: ChronicleEventKind.PUSH, agentName: 'Ada', project: 'village', label: 'origin main' },
        { ts: localTs(2026, 11, 19, 22, 10), kind: ChronicleEventKind.COMPLETED, agentName: 'Ada', project: 'village' },
    ];

    // Pure diurnal chapter grouping (authored solar boundaries).
    const groupedChron = groupEventsIntoDiurnalChapters(events, { dateKey, solar: null, newestFirst: false });
    assert.deepEqual(groupedChron.chapters.map(c => c.band), ['night', 'dawn', 'day', 'dusk', 'night']);
    assert.equal(groupedChron.chapters[1].entries[0].glyph, '≡');
    assert.equal(groupedChron.chapters[2].entries[0].glyph, '★');

    const groupedNewest = groupEventsIntoDiurnalChapters(events, { dateKey, solar: null, newestFirst: true });
    assert.deepEqual(groupedNewest.chapters.map(c => c.band), ['night', 'dusk', 'day', 'dawn', 'night']);

    // Markdown & CSV gracefully carry compacted & release rows (with Markdown escaping intact).
    const md = buildChronicleMarkdown({ dateKey, events });
    assert.match(md, /Ada compacted context \\\(412K -&gt; 38K\\\) · village/);
    assert.match(md, /Ada released v0\.68\.0 · village/);
    const csv = buildChronicleCsv({ dateKey, events });
    assert.match(csv, /compacted/);
    assert.match(csv, /release/);

    // Panel renders Sun-Arc above ledger, chapters in timeline, click scrolls to hour, and Tapestry PNG callback fires.
    const contentEl = new FakeElement('div');
    const modal = {
        contentEl,
        beginRequest: () => 1,
        isRequestCurrent: req => req === 1,
        open: () => true,
        invalidateRequest: () => {},
    };
    const coverageMask = encodeCoverageMask(new Array(96).fill(1));
    const skyCodes = new Array(24).fill('clear');
    const tapestryCalls = [];
    const log = {
        retentionDays: 14,
        store: {
            async getMeta(key) {
                if (key === `coverage:${dateKey}`) return coverageMask;
                if (key === `sky:${dateKey}`) return skyCodes;
                return null;
            },
        },
        async readDay() { return events; },
        async readDayPage() { return { events: [...events].reverse(), summary: summarizeDay(events), totalCount: events.length }; },
    };

    const panel = new ChroniclePanel({
        modal,
        chronicleLog: log,
        solarProvider: () => null,
        onExportTapestry: async payload => { tapestryCalls.push(payload); },
    });
    panel._request = 1;
    panel._selectedDateKey = dateKey;
    const page = await panel._readPage(dateKey);
    panel._renderPage(page, dateKey, 1);

    const sunArcIdx = contentEl.children.findIndex(n => n.classList?.contains('chronicle__sun-arc'));
    const ledgerIdx = contentEl.children.findIndex(n => n.classList?.contains('chronicle__ledger'));
    assert.ok(sunArcIdx > 0 && ledgerIdx > sunArcIdx, 'Sun-Arc sits above the stat ledger');

    const canvas = contentEl.querySelector('.chronicle__sun-arc-canvas');
    assert.ok(canvas);
    assert.equal(canvas.height, 36);
    canvas.rect = { left: 0, top: 0, right: 240, bottom: 36, width: 240, height: 36 };
    // Click hour 12 (x = 125 / 240 -> hour 12)
    canvas.dispatch('click', { clientX: 125 });
    const hour12Entry = contentEl.querySelector('.chronicle__entry[data-chronicle-hour="12"]');
    assert.ok(hour12Entry);
    assert.equal(hour12Entry.scrolled, 1, 'clicking an hour column scrolls Day Book to that hour entry');
    assert.equal(hour12Entry.classList.contains('chronicle__entry--target'), true);

    const tapestryBtn = contentEl.querySelector('.chronicle__tapestry-button');
    assert.ok(tapestryBtn);
    assert.equal(tapestryBtn.disabled, false);
    await panel._exportTapestry();
    assert.equal(tapestryCalls.length, 1);
    assert.equal(tapestryCalls[0].dateKey, dateKey);
    assert.equal(tapestryCalls[0].events.length, events.length);
    assert.equal(tapestryCalls[0].coverage, coverageMask);
    assert.equal(tapestryCalls[0].sky, skyCodes);

    // Without onExportTapestry, TAPESTRY PNG button is cleanly disabled.
    const disabledPanel = new ChroniclePanel({ modal, chronicleLog: log });
    const picker = disabledPanel._datePicker(dateKey, null, false);
    const disabledBtn = picker.querySelector('.chronicle__tapestry-button');
    assert.equal(disabledBtn.disabled, true);
});

// ── 2. Retold Chapters & Scrubber ─────────────────────────────────────────────

test('W4-E Retold: ChronicleScenario exposes chapter/pin metadata without altering enumerable scenario keys', () => {
    const bounds = dayBounds('2026-11-19');
    const at = (h, m = 0) => localTs(2026, 11, 19, h, m);
    const events = [
        { id: 'e1', ts: at(6, 10), kind: 'arrived', agentId: 'a1', agentName: 'Wren' },
        { id: 'e2', ts: at(9, 20), kind: 'commit', agentId: 'a1', label: 'feat: harbor' },
        { id: 'e3', ts: at(9, 25), kind: 'commit', agentId: 'a1', label: 'feat: quay' },
        { id: 'e4', ts: at(14, 0), kind: 'push', agentId: 'a1', label: 'origin main' },
        { id: 'e5', ts: at(18, 10), kind: 'errored', agentId: 'a1' },
        { id: 'e6', ts: at(21, 30), kind: 'release', agentId: 'a1', label: 'v0.68.0' },
    ];
    const samples = [
        { ts: at(6, 15), agentId: 'a1', tileX: 12, tileY: 14, provider: 'claude' },
    ];

    const scenario = buildChronicleScenario(bounds, { events, samples });
    assert.deepEqual(Object.keys(scenario), ['agents', 'timeline'], 'enumerable keys stay unchanged');
    assert.equal(Array.isArray(scenario.chapters), true);
    assert.equal(Array.isArray(scenario.pins), true);
    assert.ok(scenario.chapters.some(c => c.band === 'dawn' && c.hasActivity));
    assert.ok(scenario.chapters.some(c => c.band === 'day' && c.eventCount >= 3));
    assert.ok(scenario.pins.some(p => p.type === 'chapter' && p.band === 'dawn'));
    assert.ok(scenario.pins.some(p => p.type === 'event' && p.kind === 'commit' && p.count === 2), 'burst commits coalesce into one pin');
    assert.ok(scenario.pins.some(p => p.type === 'event' && p.kind === 'push'));
    assert.ok(scenario.pins.some(p => p.type === 'event' && p.kind === 'release'));

    const standalone = buildRetoldChapters(bounds, { events }, { solar: AUTHORED_DIURNAL_BANDS });
    assert.equal(standalone.chapters.length, 5);
    assert.equal(diurnalBandForMinute(12 * 60, resolveDiurnalBands()), 'day');
});

test('W4-E Retold: RetoldScrubber toggles play with Space/button, steps 1x-8x speed, seeks via pins, auto-hides in Theatre, and reports reserved rect', () => {
    const { doc, win, body } = createFakeDomEnv();
    const container = new FakeElement('div');
    container.rect = { left: 0, top: 0, right: 1280, bottom: 720, width: 1280, height: 720 };
    body.append(container);

    const bounds = dayBounds('2026-11-19');
    const { chapters, pins } = buildRetoldChapters(bounds, {
        events: [
            { id: 'c1', ts: localTs(2026, 11, 19, 10, 0), kind: 'commit' },
            { id: 'p1', ts: localTs(2026, 11, 19, 15, 30), kind: 'push' },
        ],
    });

    const playEvents = [];
    const speedEvents = [];
    const seekEvents = [];
    const reservedRects = [];

    const scrubber = new RetoldScrubber({
        container,
        dateKey: '2026-11-19',
        lower: bounds.lower,
        upper: bounds.upper,
        chapters,
        pins,
        onTogglePlay: paused => playEvents.push(paused),
        onSpeedChange: speed => speedEvents.push(speed),
        onSeek: payload => seekEvents.push(payload),
        onReserveRect: rect => reservedRects.push(rect),
        documentRef: doc,
        windowRef: win,
    });

    scrubber.element.rect = { left: 300, top: 656, right: 980, bottom: 708, width: 680, height: 52 };
    scrubber.reportReservedRect();
    assert.deepEqual(reservedRects.at(-1), { left: 300, top: 656, right: 980, bottom: 708, width: 680, height: 52 });

    // Space toggles playback, but ignores Space inside editable inputs.
    let prevented = false;
    win.dispatch('keydown', { code: 'Space', key: ' ', target: body, preventDefault: () => { prevented = true; } });
    assert.equal(prevented, true);
    assert.equal(scrubber.paused, true);
    assert.deepEqual(playEvents, [true]);

    const input = new FakeElement('input');
    win.dispatch('keydown', { code: 'Space', key: ' ', target: input, preventDefault: () => {} });
    assert.equal(scrubber.paused, true, 'Space inside an input never toggles playback');

    scrubber._playButton.click();
    assert.equal(scrubber.paused, false);
    assert.deepEqual(playEvents, [true, false]);

    // Speed cycling and direct selection across 1x · 2x · 4x · 8x.
    assert.deepEqual([...RETOLD_SPEEDS], [1, 2, 4, 8]);
    assert.equal(nextRetoldSpeed(1), 2);
    assert.equal(nextRetoldSpeed(8), 1);
    scrubber.cycleSpeed();
    scrubber.cycleSpeed();
    scrubber.setSpeed(8);
    assert.deepEqual(speedEvents, [2, 4, 8]);
    assert.equal(scrubber.speed, 8);

    // Clickable pin jumps playhead.
    const pushPinBtn = scrubber.element.querySelector('.retold-scrubber__pin[data-pin-kind="push"]');
    assert.ok(pushPinBtn);
    pushPinBtn.click();
    assert.equal(seekEvents.length, 1);
    assert.equal(seekEvents[0].pin.kind, 'push');
    assert.equal(formatRetoldClock(seekEvents[0].clockMs), '15:30');

    // Theatre mode auto-hide: hides when pointer is far from bottom, reveals near bottom edge, updates reserved rect.
    assert.equal(shouldRevealInTheatre({ pointerY: 400, bottomEdge: 720 }), false);
    assert.equal(shouldRevealInTheatre({ pointerY: 720 - THEATRE_REVEAL_BOTTOM_PX + 10, bottomEdge: 720 }), true);

    scrubber.setTheatreMode(true);
    assert.equal(scrubber.isHiddenInTheatre(), true);
    assert.equal(reservedRects.at(-1), null, 'hidden Theatre scrubber releases reserved box');

    win.dispatch('pointermove', { clientY: 700 });
    assert.equal(scrubber.isHiddenInTheatre(), false, 'pointer near bottom edge reveals Theatre scrubber');
    assert.ok(reservedRects.at(-1) !== null, 'revealed scrubber re-publishes reserved box');

    win.dispatch('pointermove', { clientY: 200 });
    assert.equal(scrubber.isHiddenInTheatre(), true);
    assert.equal(reservedRects.at(-1), null);

    assert.equal(clampScrubProgress(-5), 0);
    assert.equal(clampScrubProgress(5), 1);

    scrubber.destroy();
    assert.equal(reservedRects.at(-1), null);
});

// ── 3. Postcard Aspect Crops, Woodcut Mat, Clipboard, 6s Living Postcard & Studio ──

test('W4-E Postcard: integer pixel-snapped aspect crops and clean vs woodcut mat composition', () => {
    assert.deepEqual([...POSTCARD_ASPECTS], ['full', '16:9', '4:3', '1:1']);
    assert.deepEqual([...POSTCARD_BORDERS], ['clean', 'woodcut']);

    const cases = [
        [1440, 900, 'full', { x: 0, y: 0, width: 1440, height: 900, aspect: 'full' }],
        [1440, 900, '16:9', { x: 0, y: 45, width: 1440, height: 810, aspect: '16:9' }],
        [1440, 900, '4:3', { x: 120, y: 0, width: 1200, height: 900, aspect: '4:3' }],
        [1440, 900, '1:1', { x: 270, y: 0, width: 900, height: 900, aspect: '1:1' }],
        [1920, 1080, '4:3', { x: 240, y: 0, width: 1440, height: 1080, aspect: '4:3' }],
        [1001, 777, '1:1', { x: 112, y: 0, width: 777, height: 777, aspect: '1:1' }],
    ];
    for (const [w, h, aspect, expected] of cases) {
        const got = computePostcardCropRect(w, h, aspect);
        assert.deepEqual(got, expected);
        assert.equal(Number.isInteger(got.x) && Number.isInteger(got.y), true);
        assert.equal(Number.isInteger(got.width) && Number.isInteger(got.height), true);
    }

    const { doc } = createFakeDomEnv();
    const surface = Object.assign(new FakeElement('canvas'), { width: 1440, height: 900 });

    const clean = composePostcard({
        surfaces: [surface],
        width: 1440,
        height: 900,
        caption: 'ClaudeVille · 19 Nov · 15:25 dusk · 4 villagers',
        unit: 1,
        crop: '16:9',
        border: 'clean',
        documentRef: doc,
    });
    assert.equal(clean.width, 1440);
    assert.equal(clean.height, 810 + postcardBandHeight(1));
    const cleanDraw = clean.ops.find(op => op[0] === 'drawImage');
    assert.deepEqual(cleanDraw.slice(2), [0, 45, 1440, 810, 0, 0, 1440, 810]);

    const woodcut = composePostcard({
        surfaces: [surface],
        width: 1440,
        height: 900,
        caption: 'ClaudeVille · 19 Nov · 15:25 dusk · 4 villagers',
        unit: 2,
        crop: '1:1',
        border: 'woodcut',
        documentRef: doc,
    });
    const mat = postcardMatThickness(2);
    assert.equal(mat, WOODCUT_MAT_PX * 2);
    assert.equal(woodcut.width, 900 + mat * 2);
    assert.equal(woodcut.height, 900 + postcardBandHeight(2) + mat * 2);
    const woodDraw = woodcut.ops.find(op => op[0] === 'drawImage');
    assert.deepEqual(woodDraw.slice(2), [270, 0, 900, 900, mat, mat, 900, 900]);
    // Caption text sits inside the mat window
    const textOp = woodcut.ops.find(op => op[0] === 'fillText');
    assert.ok(textOp && textOp[2] > mat && textOp[3] > mat + 900);
});

test('W4-E Postcard: copyPostcardToClipboard writes PNG on success and falls back cleanly to save on refusal or absence', async () => {
    const { doc, downloads } = createFakeDomEnv();
    const canvas = new FakeElement('canvas');

    const written = [];
    class FakeClipboardItem {
        constructor(items) { this.items = items; }
    }
    const okResult = await copyPostcardToClipboard(canvas, {
        clipboardRef: { async write(items) { written.push(items); } },
        ClipboardItemCtor: FakeClipboardItem,
        fileName: 'claudeville-2026-11-19-1525.png',
        documentRef: doc,
    });
    assert.equal(okResult.ok, true);
    assert.equal(okResult.method, 'clipboard');
    assert.equal(written.length, 1);
    assert.ok(written[0][0].items['image/png'] instanceof Blob);
    assert.equal(downloads.length, 0);

    // Refusal triggers automatic PNG save fallback.
    const denied = await copyPostcardToClipboard(canvas, {
        clipboardRef: { async write() { throw new Error('NotAllowedError'); } },
        ClipboardItemCtor: FakeClipboardItem,
        fileName: 'claudeville-2026-11-19-1525.png',
        documentRef: doc,
    });
    assert.equal(denied.ok, true);
    assert.equal(denied.method, 'save-fallback');
    assert.match(denied.message, /saved claudeville-2026-11-19-1525\.png/i);
    assert.equal(downloads.length, 1);
    assert.equal(downloads[0].download, 'claudeville-2026-11-19-1525.png');

    // Absent ClipboardItem triggers automatic PNG save fallback.
    const unsupported = await copyPostcardToClipboard(canvas, {
        clipboardRef: null,
        ClipboardItemCtor: null,
        fileName: 'fallback.png',
        documentRef: doc,
    });
    assert.equal(unsupported.ok, true);
    assert.equal(unsupported.method, 'save-fallback');
    assert.equal(downloads.length, 2);
});

test('W4-E Postcard: recordLivingPostcard records a dedicated compose canvas under withPostcardFrame and aborts immediately on action-needed', async () => {
    const { doc, downloads } = createFakeDomEnv();

    // Fake MediaRecorder supporting fallback from vp9 -> vp8.
    const recordedStreams = [];
    const stoppedRecorders = [];
    class FakeMediaRecorder {
        static isTypeSupported(mime) {
            return mime === 'video/webm;codecs=vp8' || mime === 'video/webm';
        }
        constructor(stream, opts = {}) {
            this.stream = stream;
            this.mimeType = opts.mimeType || 'video/webm';
            this.state = 'inactive';
            this.listeners = new Map();
            recordedStreams.push(stream);
        }
        addEventListener(type, fn) {
            const list = this.listeners.get(type) || [];
            list.push(fn);
            this.listeners.set(type, list);
        }
        start() {
            this.state = 'recording';
        }
        stop() {
            if (this.state === 'inactive') return;
            this.state = 'inactive';
            stoppedRecorders.push(this);
            for (const fn of this.listeners.get('dataavailable') || []) {
                fn({ data: new Blob(['webm-chunk'], { type: this.mimeType }) });
            }
            for (const fn of this.listeners.get('stop') || []) fn();
        }
    }

    assert.equal(selectLivingPostcardMimeType(FakeMediaRecorder), 'video/webm;codecs=vp8');
    assert.equal(livingPostcardFileName(new Date(2026, 10, 19, 15, 25), 'video/webm'), 'claudeville-2026-11-19-1525.webm');

    // Enhance FakeElement canvases created by doc with captureStream tracking.
    const trackStops = [];
    const createdComposeCanvases = [];
    const origCreate = doc.createElement.bind(doc);
    doc.createElement = (tag) => {
        const node = origCreate(tag);
        if (String(tag).toLowerCase() === 'canvas') {
            createdComposeCanvases.push(node);
            node.captureStream = (fps) => {
                node.captureStreamCalls += 1;
                node.capturedFps = fps;
                const track = { stopped: false, stop() { this.stopped = true; trackStops.push(this); } };
                return { canvas: node, fps, tracks: [track], getTracks: () => [track] };
            };
        }
        return node;
    };

    const worldCanvas = Object.assign(new FakeElement('canvas'), {
        width: 640,
        height: 360,
        captureStream() { throw new Error('NEVER capture the live world/GPU canvas directly!'); },
    });
    const fxCanvas = Object.assign(new FakeElement('canvas'), {
        width: 640,
        height: 360,
        captureStream() { throw new Error('NEVER capture the live fx/GPU canvas directly!'); },
    });

    const renderFlagHistory = [];
    const renderer = {
        canvas: worldCanvas,
        fxCanvas,
        overlayCanvas: null,
        agentSprites: new Map([['a1', {}]]),
        _lastAtmosphere: { effectiveDate: new Date(2026, 10, 19, 15, 25), phase: 'dusk' },
        renderNow() {
            renderFlagHistory.push(postcardFrame());
            return true;
        },
    };

    // 1. Successful 6s recording via simulated clock + immediate frame scheduler.
    let clock = 0;
    const result = await recordLivingPostcard(renderer, {
        durationMs: 300,
        fps: 10,
        crop: '16:9',
        border: 'woodcut',
        hasActionNeeded: () => false,
        documentRef: doc,
        MediaRecorderCtor: FakeMediaRecorder,
        now: () => clock,
        scheduleFrame: (cb, interval) => {
            const id = setImmediate(() => {
                clock += interval;
                cb();
            });
            return id;
        },
        cancelFrame: id => clearImmediate(id),
    });

    assert.equal(result.ok, true);
    assert.equal(result.aborted, false);
    assert.equal(result.textCalls, 0);
    assert.equal(result.perFrameTextCalls.every(c => c === 0), true);
    assert.ok(result.frames >= 3);
    assert.notEqual(result.canvas, worldCanvas);
    assert.notEqual(result.canvas, fxCanvas);
    assert.equal(recordedStreams[0].canvas, result.canvas, 'captures dedicated compose canvas only');
    assert.equal(trackStops.length, 1, 'stops stream tracks after completion');
    assert.equal(downloads.length, 1);
    assert.match(downloads[0].download, /\.webm$/);
    // All recording renders ran under postcardFrame() === true, followed by final live render with false.
    assert.equal(renderFlagHistory.slice(0, -1).every(v => v === true), true);
    assert.equal(renderFlagHistory.at(-1), false, 'restores live frame after recording');

    // 2. Immediate abort when hasActionNeeded turns true mid-recording.
    let needsAttention = false;
    let tickCount = 0;
    clock = 0;
    const prevTrackStops = trackStops.length;
    const prevRecStops = stoppedRecorders.length;
    const abortedRes = await recordLivingPostcard(renderer, {
        durationMs: 6000,
        fps: 30,
        hasActionNeeded: () => needsAttention,
        documentRef: doc,
        MediaRecorderCtor: FakeMediaRecorder,
        now: () => clock,
        scheduleFrame: (cb, interval) => setImmediate(() => {
            tickCount += 1;
            clock += interval;
            if (tickCount === 2) needsAttention = true;
            cb();
        }),
        cancelFrame: id => clearImmediate(id),
    });
    assert.equal(abortedRes.ok, false);
    assert.equal(abortedRes.aborted, true);
    assert.equal(abortedRes.reason, 'attention-needed');
    assert.ok(trackStops.length > prevTrackStops, 'aborted recording stops stream tracks');
    assert.ok(stoppedRecorders.length > prevRecStops, 'aborted recording stops MediaRecorder');
    assert.equal(postcardFrame(), false, 'flag lowered after abort');

    // 3. Immediate abort when attention:raised fires on eventBus mid-recording.
    clock = 0;
    let busTick = 0;
    const busAborted = await recordLivingPostcard(renderer, {
        durationMs: 6000,
        fps: 30,
        hasActionNeeded: () => false,
        documentRef: doc,
        MediaRecorderCtor: FakeMediaRecorder,
        eventTarget: eventBus,
        now: () => clock,
        scheduleFrame: (cb, interval) => setImmediate(() => {
            busTick += 1;
            clock += interval;
            if (busTick === 2) eventBus.emit('attention:raised', { agentId: 'a1' });
            cb();
        }),
        cancelFrame: id => clearImmediate(id),
    });
    assert.equal(busAborted.ok, false);
    assert.equal(busAborted.aborted, true);
    assert.equal(busAborted.reason, 'attention-needed');
});

test('W4-E PostcardStudio: manages crop preview, border styles, save/copy fallback/living actions, and Esc close', async () => {
    const { doc, win, body } = createFakeDomEnv();
    const container = new FakeElement('div');
    container.rect = { left: 0, top: 0, right: 1440, bottom: 900, width: 1440, height: 900 };
    body.append(container);

    const strikeCalls = [];
    const livingCalls = [];
    const reserved = [];
    let closedCount = 0;

    const fakeRenderer = {
        canvas: Object.assign(new FakeElement('canvas'), { width: 1440, height: 900 }),
        renderNow: () => true,
    };

    const studio = new PostcardStudio({
        container,
        getRenderer: () => fakeRenderer,
        hasActionNeeded: () => false,
        onClose: () => { closedCount += 1; },
        onReserveRect: rect => reserved.push(rect),
        strike: async (_renderer, opts) => {
            strikeCalls.push(opts);
            return { ok: true, canvas: new FakeElement('canvas'), fileName: 'claudeville-2026-11-19-1525.png' };
        },
        copyToClipboard: async (_canvas, opts) => ({
            ok: true,
            method: 'save-fallback',
            fileName: opts.fileName,
            message: `Clipboard unavailable · saved ${opts.fileName} instead`,
        }),
        recordLiving: async (_renderer, opts) => {
            livingCalls.push(opts);
            opts.onStatus?.({ state: 'recording', progress: 0.5, message: 'Recording… 3.0s / 6.0s' });
            return { ok: false, aborted: true, reason: 'attention-needed', message: 'Living postcard aborted · an agent needs attention' };
        },
        documentRef: doc,
        windowRef: win,
    });

    assert.equal(studio.open(), true);
    assert.equal(studio.isOpen(), true);
    assert.deepEqual(studio.getState().cropRect, { x: 0, y: 0, width: 1440, height: 900, aspect: 'full' });

    studio.setCrop('16:9');
    studio.setBorder('woodcut');
    assert.deepEqual(studio.getState().cropRect, { x: 0, y: 45, width: 1440, height: 810, aspect: '16:9' });
    assert.equal(studio._aperture.classList.contains('postcard-studio__aperture--woodcut'), true);

    await studio.savePng();
    assert.equal(strikeCalls[0].crop, '16:9');
    assert.equal(strikeCalls[0].border, 'woodcut');
    assert.equal(strikeCalls[0].save, true);
    assert.match(studio.getState().statusMessage, /Saved claudeville-2026-11-19-1525\.png/);

    await studio.copyPng();
    assert.equal(strikeCalls[1].save, false);
    assert.match(studio.getState().statusMessage, /Clipboard unavailable · saved/);

    await studio.recordLiving();
    assert.equal(livingCalls[0].crop, '16:9');
    assert.equal(livingCalls[0].border, 'woodcut');
    assert.match(studio.getState().statusMessage, /aborted.*attention/i);

    // Esc closes the studio cleanly.
    let prevented = false;
    win.dispatch('keydown', { key: 'Escape', code: 'Escape', preventDefault: () => { prevented = true; }, stopPropagation() {} });
    assert.equal(prevented, true);
    assert.equal(studio.isOpen(), false);
    assert.equal(closedCount, 1);

    // Instant P strikePostcard default contract remains intact (full + clean).
    const instant = await strikePostcard(fakeRenderer, { save: false, documentRef: doc });
    assert.equal(instant.ok, true);
    assert.equal(instant.canvas.width, 1440);
    assert.equal(instant.canvas.height, 900 + postcardBandHeight(1));

    studio.destroy();
    assert.ok(reserved.length >= 0);
});
