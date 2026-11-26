import test from 'node:test';
import assert from 'node:assert/strict';

import {
    buildChronicleMarkdown,
    ChroniclePanel,
    csvEscapeCell,
} from '../../claudeville/src/presentation/shared/ChroniclePanel.js';
import { ChronicleEventKind, summarizeDay } from '../../claudeville/src/application/ChronicleLog.js';
import { Toast } from '../../claudeville/src/presentation/shared/Toast.js';
import { BgmDirector } from '../../claudeville/src/presentation/shared/audio/BgmDirector.js';
import { TopBar } from '../../claudeville/src/presentation/shared/TopBar.js';
import { installChromeTooltip } from '../../claudeville/src/presentation/shared/ChromeTooltip.js';
import { DashboardRenderer } from '../../claudeville/src/presentation/dashboard-mode/DashboardRenderer.js';
import { eventBus } from '../../claudeville/src/domain/events/DomainEvent.js';
import { AtmosphereState } from '../../claudeville/src/presentation/character-mode/AtmosphereState.js';

class FakeClassList {
    constructor(owner) {
        this.owner = owner;
    }

    add(value) {
        const names = new Set(this.owner.className.split(/\s+/).filter(Boolean));
        names.add(value);
        this.owner.className = [...names].join(' ');
    }
}

class FakeElement {
    constructor() {
        this.children = [];
        this.parentNode = null;
        this.className = '';
        this.classList = new FakeClassList(this);
        this.dataset = {};
        this.attributes = new Map();
        this.textContent = '';
    }

    appendChild(child) {
        child.parentNode = this;
        this.children.push(child);
    }

    removeChild(child) {
        const index = this.children.indexOf(child);
        if (index !== -1) this.children.splice(index, 1);
        child.parentNode = null;
    }

    setAttribute(name, value) {
        this.attributes.set(name, value);
    }
}

function toastHarness() {
    const container = new FakeElement();
    const listeners = new Map();
    const eventTarget = {
        on(name, listener) {
            listeners.set(name, listener);
            return () => listeners.delete(name);
        },
        emit(name, payload) {
            listeners.get(name)?.(payload);
        },
    };
    const documentRef = {
        getElementById(id) { return id === 'toastContainer' ? container : null; },
        createElement() { return new FakeElement(); },
    };
    const toast = new Toast({ eventTarget, documentRef });
    return { container, eventTarget, toast };
}

function chronicleEvent(overrides = {}) {
    return {
        ts: Date.UTC(2026, 7, 25, 9, 5),
        kind: ChronicleEventKind.COMMIT,
        agentName: 'Ada',
        provider: 'codex',
        project: 'village',
        label: 'Ship the chronicle',
        ...overrides,
    };
}

test('Chronicle CSV treats leading whitespace/control formula prefixes as dangerous and quotes tabs', () => {
    for (const value of ['\t=SUM(A1)', ' \t+cmd', '\u0000@mention', '\r\n-2+3']) {
        const escaped = csvEscapeCell(value);
        assert.equal(escaped.startsWith('"\'') || escaped.startsWith("'"), true, value);
        assert.equal(escaped.includes('\t'), value.includes('\t'));
        assert.equal(escaped.includes('\r'), value.includes('\r'));
    }
    assert.equal(csvEscapeCell('ordinary\tlabel').startsWith('"'), true);
});

test('Chronicle Markdown neutralizes links, images, raw HTML, and cell-breaking controls', () => {
    const markdown = buildChronicleMarkdown({
        dateKey: '2026-08-24',
        events: [chronicleEvent({
            label: '![x](https://tracker.example/pixel.png) <img src="https://tracker.example/a"> [open](https://tracker.example)',
        })],
        summary: summarizeDay([]),
    });

    assert.doesNotMatch(markdown, /!\[/);
    assert.doesNotMatch(markdown, /\]\(/);
    assert.doesNotMatch(markdown, /<\/?(?:img|a|script)\b/i);
    assert.doesNotMatch(markdown, /<br\s*\/?\s*>/i);
    assert.match(markdown, /&lt;img/);
    assert.match(markdown, /\\!\\\[/);
});

test('BGM event cues preserve agent identity, provider, spatial, and urgency payloads', () => {
    const director = new BgmDirector({ engine: {} });
    const cues = [];
    director.cueKit = {
        play(kind, payload) {
            cues.push({ kind, payload });
            return true;
        },
    };
    director.running = true;
    director._subscribe();

    try {
        eventBus.emit('village:scene', {
            kind: 'arrival',
            agentId: 'agent-ada',
            agent: { id: 'agent-ada', name: 'Ada', provider: 'claude' },
            position: { tileX: 4, tileY: 2 },
        });
        eventBus.emit('distress:watchtower', {
            kind: 'errored',
            agentId: 'agent-ada',
            label: 'Ada',
            provider: 'claude',
            position: { tileX: 4, tileY: 2 },
        });
        eventBus.emit('attention:raised', {
            agentId: 'agent-bram',
            agent: { id: 'agent-bram', name: 'Bram', provider: 'claude' },
            waitingCount: 3,
            oldestWaitMs: 90_000,
        });
    } finally {
        director.stop();
    }

    assert.equal(cues.length, 3);
    assert.equal(cues[0].kind, 'arrival');
    assert.equal(cues[0].payload.agentId, 'agent-ada');
    assert.equal(cues[0].payload.label, 'Ada');
    assert.equal(cues[0].payload.provider, 'claude');
    assert.deepEqual(cues[0].payload.position, { tileX: 4, tileY: 2 });
    assert.equal(cues[1].kind, 'distress');
    assert.equal(cues[1].payload.position.tileX, 4);
    assert.equal(cues[2].kind, 'summons');
    assert.equal(cues[2].payload.agentId, 'agent-bram');
    assert.equal(cues[2].payload.waitingCount, 3);
    assert.equal(cues[2].payload.oldestWaitMs, 90_000);
});

test('BGM dedupes near-simultaneous distress and summons for one agent', () => {
    const director = new BgmDirector({ engine: {} });
    const cues = [];
    director.cueKit = {
        play(kind, payload) {
            cues.push({ kind, payload });
            return true;
        },
    };
    director.running = true;
    director._subscribe();

    try {
        eventBus.emit('distress:watchtower', {
            kind: 'errored',
            agentId: 'agent-ada',
        });
        eventBus.emit('attention:raised', {
            agentId: 'agent-ada',
            waitingCount: 1,
            oldestWaitMs: 2_000,
        });
    } finally {
        director.stop();
    }

    assert.equal(cues.length, 1);
    assert.equal(cues[0].kind, 'distress');
});

test('one attention event keeps the specific direct notice and cue caption in one toast', () => {
    const view = toastHarness();
    try {
        view.eventTarget.emit('attention:raised', {
            agentId: 'agent-ada',
            agent: { id: 'agent-ada', name: 'Ada' },
            reason: 'question',
            label: 'needs you',
        });
        view.eventTarget.emit('audio:cue-played', {
            kind: 'summons',
            agentId: 'agent-ada',
            label: 'Ada',
        });
        view.toast.show('Ada asked you a question', 'warning');

        assert.equal(view.container.children.length, 1);
        assert.equal(view.container.children[0].textContent, 'Ada asked you a question');
    } finally {
        view.toast.destroy();
    }
});

test('Chronicle date selection stays committed on a failed read and export failures surface', async () => {
    const modal = {
        contentEl: { querySelector: () => null },
        isRequestCurrent: request => request === 1,
    };
    const failures = [];
    const panel = new ChroniclePanel({
        modal,
        chronicleLog: { readDayPage: async () => { throw new Error('indexeddb unavailable'); } },
        toast: { show: (message, type) => failures.push({ message, type }) },
    });
    panel._request = 1;
    panel._selectedDateKey = '2026-08-25';

    await panel._showDate('2026-08-24', 1);
    assert.equal(panel._selectedDateKey, '2026-08-25');
    assert.deepEqual(failures, [{ message: 'Could not load that Chronicle day.', type: 'warning' }]);

    panel._readExportData = async () => { throw new Error('read failed'); };
    await panel._export('csv');
    assert.deepEqual(failures.at(-1), {
        message: 'Could not export the Chronicle as CSV.',
        type: 'warning',
    });
});

test('the SOUND popover opens on the checked preset, closes the Spend Map, and restores its chevron', () => {
    const previousWindow = globalThis.window;
    globalThis.window = { innerWidth: 1280 };
    let focused = '';
    const attributes = new Map();
    const radio = (name) => ({ focus: () => { focused = name; } });
    const chevron = {
        getBoundingClientRect: () => ({ right: 900, bottom: 40 }),
        setAttribute: (name, value) => attributes.set(name, value),
        focus: () => { focused = 'chevron'; },
    };
    const panel = { hidden: true, style: {}, focus: () => { focused = 'panel'; } };
    let spendClosed = 0;
    try {
        const topbar = {
            _destroyed: false,
            els: { soundMenu: chevron },
            _soundEls: { panel, radios: { off: radio('off'), townBand: radio('townBand') } },
            _soundView: { preset: 'townBand' },
            _renderSoundPanel() {},
            _hideSpendPanel: () => { spendClosed++; },
            _soundPanelOpen: TopBar.prototype._soundPanelOpen,
        };
        TopBar.prototype._showSoundPanel.call(topbar);
        assert.equal(panel.hidden, false);
        assert.equal(spendClosed, 1, 'never shares the screen with the Spend Map');
        assert.equal(attributes.get('aria-expanded'), 'true');
        assert.equal(focused, 'townBand', 'focus lands on the checked radio');
        // Right-anchored under the chevron.
        assert.equal(panel.style.left, `${900 - 308}px`);

        TopBar.prototype._hideSoundPanel.call(topbar);
        assert.equal(panel.hidden, true);
        assert.equal(attributes.get('aria-expanded'), 'false');
        assert.equal(focused, 'chevron');

        // Closed and closed again writes nothing and moves no focus.
        focused = '';
        attributes.clear();
        TopBar.prototype._hideSoundPanel.call(topbar);
        assert.equal(attributes.size, 0);
        assert.equal(focused, '');
    } finally {
        if (previousWindow === undefined) delete globalThis.window;
        else globalThis.window = previousWindow;
    }
});

test('the header timer starts before World mounts and honors the mounted atmosphere', async (t) => {
    const now = new Date(2026, 10, 19, 12);
    t.mock.timers.enable({ apis: ['Date', 'setInterval'], now });
    const documentRef = { hidden: false };
    globalThis.document = documentRef;
    t.after(() => { delete globalThis.document; });
    globalThis.window = Object.assign(new EventTarget(), { location: { origin: 'http://localhost' } });
    t.after(() => { delete globalThis.window; });
    const { App } = await import('../../claudeville/src/presentation/App.js');
    const atmosphere = new AtmosphereState();
    const fields = new Map(['time', 'phase', 'override'].map(name => [`.topbar__clock-${name}`, {}]));
    fields.set('path', { setAttribute() {} });
    const topBar = Object.assign(Object.create(TopBar.prototype), {
        world: { get activeTime() { return Math.floor((Date.now() - now.getTime()) / 1000); } },
        els: { time: {}, clock: { dataset: {}, querySelector: selector => fields.get(selector) } },
        _villageState: {},
    });
    let mode = 'dashboard';
    let snapshots = 0;
    const app = Object.assign(Object.create(App.prototype), {
        modeManager: { getCurrentMode: () => mode },
    });
    topBar.readDashboardAtmosphere = () => {
        const snapshot = app._readDashboardAtmosphere();
        if (snapshot) snapshots++;
        return snapshot;
    };
    const clock = fields.get('.topbar__clock-time');
    topBar._startTimer();
    t.mock.timers.tick(1_000);
    assert.equal(clock.textContent, '12:00');
    assert.equal(snapshots, 1);

    mode = 'character';
    t.mock.timers.tick(60_000);
    assert.equal(clock.textContent, '12:00');
    assert.equal(snapshots, 1);

    mode = 'dashboard';
    app.renderer = { atmosphereState: atmosphere };
    t.mock.timers.tick(4_000);
    assert.equal(clock.textContent, '12:01');
    assert.equal(snapshots, 2);
    assert.equal(topBar.els.time.textContent, '00:01:05');

    documentRef.hidden = true;
    t.mock.timers.tick(60_000);
    assert.equal(clock.textContent, '12:01');
    assert.equal(snapshots, 2);
    documentRef.hidden = false;
    t.mock.timers.tick(1_000);
    assert.equal(clock.textContent, '12:02');

    atmosphere.setHour(14.5);
    t.mock.timers.tick(60_000);
    assert.equal(clock.textContent, '14:30');
    t.mock.timers.tick(60_000);
    assert.equal(clock.textContent, '14:30');
    assert.equal(fields.get('.topbar__clock-override').textContent, 'FIXED');
});

test('forecast changes refresh the World clock from its last atmosphere without another frame', () => {
    const fields = new Map(['time', 'phase', 'override'].map(name => [`.topbar__clock-${name}`, {}]));
    const creditAttrs = new Map();
    const credit = {
        getAttribute: (k) => creditAttrs.get(k) ?? null,
        setAttribute: (k, v) => creditAttrs.set(k, String(v)),
        removeAttribute: (k) => creditAttrs.delete(k),
    };
    fields.set('.topbar__clock-source', credit);
    fields.set('path', { setAttribute() {} });
    const clockAttrs = new Map();
    const clock = {
        dataset: {},
        querySelector: selector => fields.get(selector),
        getAttribute: (k) => clockAttrs.get(k) ?? null,
        setAttribute: (k, v) => clockAttrs.set(k, String(v)),
        removeAttribute: (k) => clockAttrs.delete(k),
    };
    const last = { clock: { label: '12:00' }, weather: { type: 'clear' } };
    const topBar = Object.assign(Object.create(TopBar.prototype), {
        els: { clock },
        _villageState: {},
        readDashboardAtmosphere: () => null,
        refreshAtmosphere: snapshot => {
            assert.equal(snapshot, last);
            return { ...last, weather: { type: 'rain', frozen: true }, weatherSource: { kind: 'forecast', ageMinutes: 1 } };
        },
    });
    topBar._renderWitnessClock(last);
    topBar._refreshWitnessClock();
    assert.match(clock.dataset.tip, /Real sky.*fetched 1m ago.*snow/);
    assert.equal(creditAttrs.has('href'), true);

    topBar._renderWitnessClock({
        ...last,
        weather: { type: 'clear', frozen: false },
        weatherSource: { kind: 'idyllic', ageMinutes: null },
    });
    assert.equal(clock.dataset.tip, 'Idyllic village weather · clear');
    assert.equal(creditAttrs.has('href'), false);
    assert.equal(clockAttrs.get('tabindex'), '0');
});

test('the clock credit can open its parent tooltip from keyboard focus', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    globalThis.MutationObserver = class {
        observe() {}
        disconnect() {}
    };
    globalThis.getComputedStyle = () => ({ anchorName: 'none' });
    t.after(() => {
        delete globalThis.MutationObserver;
        delete globalThis.getComputedStyle;
    });
    let opens = 0;
    const style = { setProperty() {}, removeProperty() {} };
    const handlers = {};
    const tip = { showPopover() { opens++; }, matches: () => false, replaceChildren() {} };
    const uninstall = installChromeTooltip({
        getElementById: () => tip,
        createTextNode: () => ({}),
        addEventListener: (type, handler) => { handlers[type] = handler; },
        removeEventListener() {},
    });
    const parent = { isConnected: true, dataset: { tip: 'Weather' }, style, matches: () => false, closest: () => parent };
    const focus = (credit) => handlers.focusin({
        target: { closest: () => parent, matches: selector => selector === ':focus-visible' || credit },
    });
    try {
        focus(false);
        t.mock.timers.tick(400);
        assert.equal(opens, 0);
        focus(true);
        t.mock.timers.tick(400);
        assert.equal(opens, 1);
    } finally {
        uninstall();
    }
});

test('Dashboard Escape only deselects from a focused card with no open surface', () => {
    const card = { tagName: 'BUTTON' };
    const modal = { getAttribute: () => 'true' };
    const panels = new Map();
    const previousDocument = globalThis.document;
    globalThis.document = {
        activeElement: card,
        getElementById: id => id === 'modalOverlay' ? modal : panels.get(id) || null,
        querySelectorAll: () => [],
    };
    const renderer = Object.create(DashboardRenderer.prototype);
    renderer.active = true;
    renderer._destroyed = false;
    renderer.gridEl = { contains: element => element === card };
    const deselected = [];
    const unsubscribe = eventBus.on('agent:deselected', () => deselected.push(true));

    try {
        const event = { code: 'Escape', preventDefault() { this.prevented = true; } };
        renderer._handleDashboardKeyboardCommand(event);
        assert.equal(deselected.length, 1);
        assert.equal(event.prevented, true);

        panels.set('spendBreakdownPanel', { hidden: false, style: { display: 'block' } });
        const blocked = { code: 'Escape', preventDefault() { this.prevented = true; } };
        renderer._handleDashboardKeyboardCommand(blocked);
        assert.equal(deselected.length, 1);

        globalThis.document.activeElement = { tagName: 'BUTTON' };
        renderer._handleDashboardKeyboardCommand({
            code: 'Escape',
            preventDefault() { this.prevented = true; },
        });
        assert.equal(deselected.length, 1);
    } finally {
        unsubscribe();
        if (previousDocument === undefined) delete globalThis.document;
        else globalThis.document = previousDocument;
    }
});
