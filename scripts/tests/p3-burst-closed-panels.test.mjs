import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import { eventBus } from '../../claudeville/src/domain/events/DomainEvent.js';
import { World } from '../../claudeville/src/domain/entities/World.js';
import { AgentManager } from '../../claudeville/src/application/AgentManager.js';
import { AttentionService } from '../../claudeville/src/application/AttentionService.js';
import { SpendLedger } from '../../claudeville/src/application/SpendLedger.js';
import { LinkState } from '../../claudeville/src/application/VillageState.js';
import { WebSocketClient } from '../../claudeville/src/infrastructure/WebSocketClient.js';

const require = createRequire(import.meta.url);
const { compactGitEventsForWire } = require('../../claudeville/adapters/gitEvents.js');

function installTrackedDom(t) {
    class FakeNode {}
    const prevNode = globalThis.Node;
    const prevWindow = globalThis.window;
    const prevDocument = globalThis.document;
    const prevLocation = globalThis.location;

    const counters = {
        emptySurface: { total: 0, replaceChildren: 0, text: 0, attr: 0, style: 0, hidden: 0, classToggle: 0, querySelector: 0 },
        dashboard: { total: 0, replaceChildren: 0, text: 0, attr: 0, style: 0, hidden: 0, classToggle: 0 },
        connectionPanel: { total: 0, replaceChildren: 0 },
        spendPanel: { total: 0, replaceChildren: 0, rollupsCalls: 0 },
    };

    let activeElement = null;
    const byId = new Map();

    function makeClassList(bucket) {
        const set = new Set();
        return {
            add(...cls) { for (const c of cls) set.add(c); if (bucket) { bucket.classToggle++; bucket.total++; } },
            remove(...cls) { for (const c of cls) set.delete(c); if (bucket) { bucket.classToggle++; bucket.total++; } },
            toggle(c, force) {
                const next = force === undefined ? !set.has(c) : Boolean(force);
                if (next) set.add(c); else set.delete(c);
                if (bucket) { bucket.classToggle++; bucket.total++; }
                return next;
            },
            contains(c) { return set.has(c); },
        };
    }

    function makeEl(tag, id = '', bucket = null) {
        let _text = '';
        let _hidden = false;
        const _attrs = new Map();
        const _children = [];
        const _styleMap = {};
        const style = new Proxy(_styleMap, {
            set(target, prop, value) {
                target[prop] = value;
                if (bucket) { bucket.style = (bucket.style || 0) + 1; bucket.total++; }
                return true;
            },
            get(target, prop) {
                if (prop === 'setProperty') return (k, v) => { target[k] = v; if (bucket) { bucket.style = (bucket.style || 0) + 1; bucket.total++; } };
                if (prop === 'getPropertyValue') return (k) => target[k] || '';
                if (prop === 'removeProperty') return (k) => { delete target[k]; };
                return target[prop];
            },
        });
        const node = Object.assign(new FakeNode(), {
            tagName: tag.toUpperCase(),
            id,
            className: '',
            nodeType: 1,
            isConnected: true,
            dataset: {},
            parentElement: null,
            children: _children,
            childNodes: _children,
            style,
            classList: makeClassList(bucket),
            tabIndex: -1,
            clientWidth: 1200,
            clientHeight: 800,
            scrollHeight: 40,
            offsetWidth: 100,
            offsetHeight: 40,
            get textContent() { return _text; },
            set textContent(v) {
                _text = String(v ?? '');
                if (bucket) { bucket.text = (bucket.text || 0) + 1; bucket.total++; }
            },
            get hidden() { return _hidden; },
            set hidden(v) {
                _hidden = Boolean(v);
                if (bucket) { bucket.hidden = (bucket.hidden || 0) + 1; bucket.total++; }
            },
            get firstChild() { return _children[0] || null; },
            get lastElementChild() { return _children[_children.length - 1] || null; },
            setAttribute(k, v) { _attrs.set(k, String(v)); if (bucket) { bucket.attr = (bucket.attr || 0) + 1; bucket.total++; } },
            getAttribute(k) { return _attrs.has(k) ? _attrs.get(k) : null; },
            removeAttribute(k) { _attrs.delete(k); if (bucket) { bucket.attr = (bucket.attr || 0) + 1; bucket.total++; } },
            hasAttribute(k) { return _attrs.has(k); },
            appendChild(c) { if (c) { c.parentElement = node; _children.push(c); } return c; },
            append(...items) { for (const c of items) if (c && typeof c === 'object') { c.parentElement = node; _children.push(c); } },
            prepend(...items) { for (const c of items.reverse()) if (c && typeof c === 'object') { c.parentElement = node; _children.unshift(c); } },
            after() {},
            insertAdjacentElement() {},
            replaceChildren(...items) {
                _children.length = 0;
                for (const c of items) if (c && typeof c === 'object') { c.parentElement = node; _children.push(c); }
                if (bucket) { bucket.replaceChildren = (bucket.replaceChildren || 0) + 1; bucket.total++; }
            },
            remove() {
                if (node.parentElement) {
                    const i = node.parentElement.children.indexOf(node);
                    if (i >= 0) node.parentElement.children.splice(i, 1);
                    node.parentElement = null;
                }
            },
            contains(other) {
                if (other === node) return true;
                return _children.some(c => c.contains?.(other));
            },
            matches() { return false; },
            focus() { activeElement = node; },
            scrollIntoView() {},
            addEventListener() {},
            removeEventListener() {},
            getBoundingClientRect() { return { left: 10, top: 10, right: 110, bottom: 50, width: 100, height: 40 }; },
            getClientRects() { return []; },
            getContext() {
                return {
                    imageSmoothingEnabled: false,
                    clearRect() {},
                    fillRect() {},
                    drawImage() {},
                    fillStyle: '',
                };
            },
            querySelector(sel) {
                if (bucket && bucket.querySelector !== undefined) bucket.querySelector++;
                if (sel.startsWith('.')) {
                    const cls = sel.slice(1);
                    for (const c of _children) {
                        if (c.className?.split(/\s+/).includes(cls) || c.classList?.contains?.(cls)) return c;
                        const found = c.querySelector?.(sel);
                        if (found) return found;
                    }
                }
                return null;
            },
            querySelectorAll() { return []; },
        });
        if (id) byId.set(id, node);
        return node;
    }

    const body = makeEl('body');
    const worldEmpty = makeEl('div', 'worldEmpty', counters.emptySurface);
    worldEmpty.append(
        Object.assign(makeEl('div', '', counters.emptySurface), { className: 'world-empty__title' }),
        Object.assign(makeEl('div', '', counters.emptySurface), { className: 'world-empty__copy' }),
        Object.assign(makeEl('dl', '', counters.emptySurface), { className: 'world-empty__legend' }),
    );
    const dashboardEmpty = makeEl('div', 'dashboardEmpty', counters.emptySurface);
    dashboardEmpty.append(
        Object.assign(makeEl('div', '', counters.emptySurface), { className: 'dashboard__empty-text' }),
        Object.assign(makeEl('div', '', counters.emptySurface), { className: 'dashboard__empty-sub' }),
    );
    const topbarRoot = makeEl('header', 'topbar');
    const topbarCenter = Object.assign(makeEl('div'), { className: 'topbar__center' });
    topbarRoot.append(topbarCenter);
    const rateWrap = makeEl('div', 'statRateWrap');
    const tokensLabel = Object.assign(makeEl('span'), { className: 'topbar__stat-label' });
    rateWrap.append(tokensLabel);
    makeEl('span', 'statTokens');
    makeEl('span', 'statRate');
    makeEl('span', 'badgeWorking');
    makeEl('span', 'badgeIdle');
    makeEl('span', 'badgeWaiting');
    makeEl('button', 'topbarConnection');
    const dashboardGrid = makeEl('div', 'dashboardGrid', counters.dashboard);
    const dashboardAttention = makeEl('div', 'dashboardAttentionQueue', counters.dashboard);
    const dashView = makeEl('div', 'dashboardMode');
    dashView.append(dashboardAttention, dashboardGrid, dashboardEmpty);
    body.append(topbarRoot, worldEmpty, dashView);

    globalThis.Node = FakeNode;
    globalThis.window = {
        location: { protocol: 'http:', host: 'localhost:4000', pathname: '/', search: '' },
        innerWidth: 1440,
        innerHeight: 900,
        addEventListener() {},
        removeEventListener() {},
        matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
        requestAnimationFrame: (cb) => { cb(); return 1; },
        cancelAnimationFrame() {},
        setTimeout,
        clearTimeout,
    };
    globalThis.location = globalThis.window.location;
    globalThis.document = {
        body,
        hidden: false,
        visibilityState: 'hidden',
        title: '',
        get activeElement() { return activeElement; },
        documentElement: { dataset: {} },
        getElementById: (id) => byId.get(id) || null,
        querySelector: (sel) => {
            if (sel === '#statRateWrap .topbar__stat-label') return tokensLabel;
            if (sel === '.topbar__center') return topbarCenter;
            return null;
        },
        querySelectorAll: () => [],
        createElement: (tag) => makeEl(tag),
        createElementNS: (_ns, tag) => makeEl(tag),
        createTextNode: (text) => Object.assign(new FakeNode(), { nodeType: 3, nodeValue: text }),
        createDocumentFragment: () => makeEl('fragment'),
        addEventListener() {},
        removeEventListener() {},
    };

    const cleanup = () => {
        if (prevNode === undefined) delete globalThis.Node; else globalThis.Node = prevNode;
        if (prevWindow === undefined) delete globalThis.window; else globalThis.window = prevWindow;
        if (prevDocument === undefined) delete globalThis.document; else globalThis.document = prevDocument;
        if (prevLocation === undefined) delete globalThis.location; else globalThis.location = prevLocation;
    };

    const resetCounters = () => {
        for (const group of Object.values(counters)) {
            for (const key of Object.keys(group)) group[key] = 0;
        }
    };

    return { counters, makeEl, resetCounters, cleanup, getActiveElement: () => activeElement };
}

test('replayed burst coalesces surface renders, skips hidden panel patches, refreshes on open, and preserves focus/announcements/notifications', async (t) => {
    const { counters, makeEl, resetCounters, cleanup, getActiveElement } = installTrackedDom(t);
    const { App } = await import('../../claudeville/src/presentation/App.js');
    const { TopBar } = await import('../../claudeville/src/presentation/shared/TopBar.js');
    const { DashboardRenderer } = await import('../../claudeville/src/presentation/dashboard-mode/DashboardRenderer.js');

    let now = Date.parse('2026-11-27T15:00:00.000Z');
    const world = new World();
    const spendLedger = new SpendLedger({ clock: () => now });
    const origRollups = spendLedger.rollups.bind(spendLedger);
    spendLedger.rollups = (...args) => {
        counters.spendPanel.rollupsCalls++;
        return origRollups(...args);
    };

    class FakeNotification {
        static permission = 'granted';
        static raised = [];
        constructor(title, options) {
            this.title = title;
            this.options = options;
            FakeNotification.raised.push(this);
        }
        close() {}
    }

    const attention = new AttentionService(world, {
        document: globalThis.document,
        NotificationClass: FakeNotification,
    });
    attention.desktopAlerts = true;

    const app = new App();
    app.world = world;
    app.agentManager = new AgentManager(world, null, { clock: () => now });
    let currentMode = 'character';
    app.modeManager = { getCurrentMode: () => currentMode, switchMode(m) { currentMode = m; } };

    let appSurfaceRenders = 0;
    const origRenderSurfaces = app._renderVillageSurfaces.bind(app);
    app._renderVillageSurfaces = (...args) => {
        appSurfaceRenders++;
        return origRenderSurfaces(...args);
    };

    const villageStateOrder = [];
    const offVillage = eventBus.on('village:state', (state) => {
        villageStateOrder.push(`${state.phase}:${state.link.state}:${state.agentCount}`);
    });

    app._bindVillageObservations();
    app._bindWorldEmptyState();

    const topBar = new TopBar(world, { spendLedger });
    // Open and close connection & spend panels once so their panel DOM exists while closed.
    topBar._showConnectionDetails({ focus: true });
    assert.equal(getActiveElement(), topBar._connectionPanelEl, 'opening connection panel focuses dialog');
    topBar._hideConnectionDetails({ restoreFocus: true });
    assert.equal(getActiveElement(), topBar.els.connection, 'closing connection panel restores trigger focus');

    const origConnReplace = topBar._connectionPanelEl.replaceChildren.bind(topBar._connectionPanelEl);
    topBar._connectionPanelEl.replaceChildren = (...args) => {
        counters.connectionPanel.replaceChildren++;
        counters.connectionPanel.total++;
        return origConnReplace(...args);
    };

    topBar._showSpendPanel();
    assert.equal(getActiveElement(), topBar._spendPanelEl, 'opening spend panel focuses dialog');
    topBar._hideSpendPanel({ restoreFocus: true });
    assert.equal(getActiveElement(), topBar.els.rateWrap, 'closing spend panel restores trigger focus');

    const origSpendReplace = topBar._spendPanelEl.replaceChildren.bind(topBar._spendPanelEl);
    topBar._spendPanelEl.replaceChildren = (...args) => {
        counters.spendPanel.replaceChildren++;
        counters.spendPanel.total++;
        return origSpendReplace(...args);
    };

    const dash = new DashboardRenderer(world);
    const fakeSection = makeEl('div', '', counters.dashboard);
    fakeSection._sectionRefs = { harbor: makeEl('button', '', counters.dashboard) };
    fakeSection._harborAgents = [{ id: 'a-0', projectPath: '/tmp/repo-0', gitBranch: 'main' }];
    dash._sectionEls.set('/tmp/repo-0', fakeSection);
    const fakeCard = makeEl('div', '', counters.dashboard);
    fakeCard.dataset.agentId = 'a-0';
    fakeCard._elements = {
        select: makeEl('button', '', counters.dashboard),
        detail: makeEl('div', '', counters.dashboard),
        usageFooter: makeEl('div', '', counters.dashboard),
    };
    dash.cards.set('a-0', fakeCard);
    dash.active = false;

    t.after(() => {
        offVillage();
        attention.destroy();
        dash.destroy();
        topBar.destroy();
        app.agentManager.stop();
        for (const unsub of app._eventUnsubscribers) unsub?.();
        cleanup();
    });

    // Prime populated live state.
    app._dispatchVillage({ type: 'providers', providers: [{ id: 'claude', name: 'Claude', health: 'healthy', sessions: 17 }] });
    app._dispatchVillage({ type: 'link', state: LinkState.LIVE, lastMessageAt: now, stale: false });
    app._dispatchVillage({ type: 'snapshot', source: 'websocket', agentCount: 17, at: now });
    assert.equal(topBar._connectionLiveEl.textContent, 'Connection LIVE');

    resetCounters();
    appSurfaceRenders = 0;
    villageStateOrder.length = 0;
    FakeNotification.raised.length = 0;

    // Replay a 20-snapshot burst while Dashboard and connection/spend panels are closed.
    for (let burst = 0; burst < 20; burst++) {
        now += 500;
        const sessions = Array.from({ length: 17 }, (_, i) => ({
            sessionId: `a-${burst === 0 ? i : (i === 16 ? 16 + burst : i)}`,
            provider: i % 2 === 0 ? 'claude' : 'codex',
            project: `/tmp/repo-${i % 3}`,
            model: i % 2 === 0 ? 'claude-opus-4-1' : 'gpt-5.1-codex',
            status: 'active',
            turnState: (burst >= 10 && i === 1) ? 'tool_pending' : 'working',
            waitReason: (burst >= 10 && i === 1) ? 'permission' : null,
            awaitingSince: (burst >= 10 && i === 1) ? now : null,
            signalSource: (burst >= 10 && i === 1) ? 'hook' : 'transcript',
            lastTool: burst % 2 === 0 ? 'Edit' : 'Bash',
            lastActivity: now,
            tokens: { input: 1000 * (burst + 1), output: 200 * (burst + 1) },
        }));
        eventBus.emit('ws:state', { state: LinkState.LIVE, lastMessageAt: now, stale: false });
        eventBus.emit('ws:state', { state: LinkState.LIVE, lastMessageAt: now, lastSnapshotAt: now, stale: false });
        app.agentManager.handleWebSocketMessage({ sessions });
        for (const agent of world.agents.values()) spendLedger.observe(agent, now);
        eventBus.emit('ws:update', { sessions });
        eventBus.emit('harbor:updated', [{ project: '/tmp/repo-0', branch: 'main', pendingCommits: burst + 1, failedPushes: 0 }]);
        eventBus.emit('agent:selected', world.agents.get('a-0'));
        eventBus.emit('agent:deselected');
    }
    await Promise.resolve();
    attention.refresh();

    // 1. Repeat surface renders coalesced to a single check for the entire synchronous burst.
    assert.equal(appSurfaceRenders, 1, 'surface renders must coalesce per burst');
    // 2. Zero hidden DOM patches while Dashboard and connection/spend panels are closed.
    assert.equal(counters.emptySurface.total, 0, 'hidden empty surfaces must not be patched');
    assert.equal(counters.emptySurface.querySelector, 0, 'hidden empty surfaces must not be queried');
    assert.equal(counters.dashboard.total, 0, 'closed Dashboard must not patch hidden DOM');
    assert.equal(counters.connectionPanel.total, 0, 'closed connection panel must not patch hidden DOM');
    assert.equal(counters.spendPanel.total, 0, 'closed spend panel must not patch hidden DOM');
    assert.equal(counters.spendPanel.rollupsCalls, 0, 'closed spend panel must skip rollups calculation');
    // 3. Event ordering and action-needed notifications preserved.
    assert.equal(villageStateOrder.length, 60, 'every village:state transition still fires synchronously in order');
    assert.ok(FakeNotification.raised.length >= 1, 'action-needed desktop notification still fires during burst');

    // 4. Connection aria-live announcement updates immediately on link transition even while panel is closed.
    eventBus.emit('ws:state', { state: LinkState.RECONNECTING, attempts: 1, lastErrorCode: 'socket-closed', stale: false });
    assert.equal(topBar._connectionLiveEl.textContent, 'Connection RECONNECTING 1');
    assert.equal(counters.connectionPanel.replaceChildren, 0, 'panel still closed during announcement');

    // 5. Opening connection panel refreshes immediately and focuses it.
    topBar._showConnectionDetails({ focus: true });
    assert.equal(counters.connectionPanel.replaceChildren, 1, 'opening connection panel refreshes immediately');
    assert.equal(getActiveElement(), topBar._connectionPanelEl);

    // 6. Opening spend panel computes fresh rollups, renders immediately, and focuses it.
    topBar._showSpendPanel();
    assert.equal(counters.spendPanel.rollupsCalls, 1, 'opening spend panel computes fresh rollups once');
    assert.equal(counters.spendPanel.replaceChildren, 1, 'opening spend panel renders immediately');
    assert.equal(getActiveElement(), topBar._spendPanelEl);

    // 7. Selecting an agent while Dashboard is closed syncs immediately when Dashboard opens.
    eventBus.emit('agent:selected', world.agents.get('a-0'));
    assert.equal(counters.dashboard.total, 0, 'selection while Dashboard is closed stays DOM-free');
    const renderSpy = t.mock.method(dash, 'render', () => {});
    const syncSpy = t.mock.method(dash, '_syncSelectionControls', () => {});
    eventBus.emit('mode:changed', 'dashboard');
    assert.equal(dash.active, true);
    assert.equal(renderSpy.mock.callCount(), 1, 'opening Dashboard renders immediately');
    assert.equal(syncSpy.mock.callCount(), 1, 'opening Dashboard syncs pending selection immediately');
});

test('AgentManager hoists git string-table dictionary decoding per payload and preserves exact events and clone isolation', () => {
    const sampleEvents = Array.from({ length: 12 }, (_, i) => ({
        id: `evt-${i}`,
        type: i % 3 === 0 ? 'push' : 'commit',
        project: '/tmp/repo-a',
        repoRoot: '/tmp/repo-a',
        provider: 'claude',
        sessionId: `s-${i % 4}`,
        branch: 'main',
        upstream: 'origin/main',
        sha: (i.toString(16).padStart(8, '0')).repeat(5),
        label: `commit ${i}`,
        success: true,
        exitCode: 0,
        ts: 1_760_000_000_000 + i * 1000,
    }));
    const rawSessions = Array.from({ length: 4 }, (_, s) => ({
        sessionId: `s-${s}`,
        provider: 'claude',
        project: '/tmp/repo-a',
        turnState: 'working',
        lastActivity: 1_760_000_020_000,
        gitEvents: sampleEvents,
    }));

    const compacted = compactGitEventsForWire(rawSessions);
    const world = new World();
    const manager = new AgentManager(world, null);
    try {
        const wire = manager._gitEventWireFrom(compacted);
        assert.ok(wire.dictionaries instanceof Map, 'dictionaries should be decoded once into a Map on wire');

        let mapBuilds = 0;
        const origBuild = manager._gitEventDictionariesFrom.bind(manager);
        manager._gitEventDictionariesFrom = (...args) => {
            mapBuilds++;
            return origBuild(...args);
        };

        const rehydratedA = manager._rehydrateGitEvents(compacted.sessions[0].gitEvents, wire);
        const rehydratedB = manager._rehydrateGitEvents(compacted.sessions[1].gitEvents, wire);
        assert.equal(mapBuilds, 0, 'rehydrating all references must reuse hoisted dictionaries');
        assert.equal(rehydratedA.length, sampleEvents.length);
        assert.deepEqual(rehydratedA.map(e => e.id), sampleEvents.map(e => e.id));
        assert.deepEqual(rehydratedA.map(e => e.branch), sampleEvents.map(e => e.branch));
        // Mutations on one session's rehydrated event must never leak to another session.
        rehydratedA[0].branch = 'mutated';
        assert.equal(rehydratedB[0].branch, 'main');

        // Direct caller passing a raw wire object without prebuilt dictionaries still works.
        const rawWire = {
            idsByReference: wire.idsByReference,
            fields: wire.fields,
            stringTables: wire.stringTables,
            eventsById: wire.eventsById,
        };
        const fromRaw = manager._rehydrateGitEvents(compacted.sessions[0].gitEvents, rawWire);
        assert.equal(mapBuilds, 1, 'lazy fallback caches dictionaries after first lookup on raw wire');
        assert.deepEqual(fromRaw.map(e => e.id), sampleEvents.map(e => e.id));
    } finally {
        manager.stop();
    }
});

test('WebSocketClient retains resync coalescing and recovery alongside burst optimizations', (t) => {
    const prevWindow = globalThis.window;
    globalThis.window = { location: { protocol: 'http:', host: 'localhost:4000' } };
    const client = new WebSocketClient();
    const resyncs = [];
    const updates = [];
    client.send = (msg) => resyncs.push(msg);
    const off = eventBus.on('ws:update', (msg) => updates.push(msg));
    t.after(() => {
        off();
        client.disconnect();
        if (prevWindow === undefined) delete globalThis.window;
        else globalThis.window = prevWindow;
    });

    client._handleMessage({ type: 'init', seq: 1, sessions: [{ sessionId: 's1', status: 'working' }], teams: [] });
    // Gap in sequence triggers exactly one coalesced resync request.
    client._handleMessage({ type: 'update-delta', deltaVersion: 2, baseSeq: 5, seq: 6, patch: [] });
    client._handleMessage({ type: 'update-delta', deltaVersion: 2, baseSeq: 6, seq: 7, patch: [] });
    assert.deepEqual(resyncs, [{ type: 'resync' }]);

    // Full update restores sequence and allows deltas to resume.
    client._handleMessage({ type: 'update', seq: 8, sessions: [{ sessionId: 's1', status: 'idle' }], teams: [] });
    client._handleMessage({
        type: 'update-delta',
        deltaVersion: 2,
        baseSeq: 8,
        seq: 9,
        patch: [{ op: 'replace', path: '/sessionsById/s1/status', value: 'working' }],
    });
    assert.equal(updates.at(-1).sessions[0].status, 'working');
    assert.equal(client._seq, 9);
});
