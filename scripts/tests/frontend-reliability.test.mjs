import test from 'node:test';
import assert from 'node:assert/strict';

import { AgentManager, digestAgentPayload } from '../../claudeville/src/application/AgentManager.js';
import { AttentionService } from '../../claudeville/src/application/AttentionService.js';
import { summarizeDay } from '../../claudeville/src/application/ChronicleLog.js';
import { eventBus } from '../../claudeville/src/domain/events/DomainEvent.js';
import { AssetManager } from '../../claudeville/src/presentation/character-mode/AssetManager.js';
import { ActivityPanel } from '../../claudeville/src/presentation/shared/ActivityPanel.js';
import { buildBuildingInstrumentModel } from '../../claudeville/src/presentation/shared/BuildingInstrumentModel.js';
import { Modal } from '../../claudeville/src/presentation/shared/Modal.js';
import { ChroniclePanel } from '../../claudeville/src/presentation/shared/ChroniclePanel.js';

class FakeNotification {
    static permission = 'granted';
    static instances = [];

    static async requestPermission() {
        return this.permission;
    }

    constructor(title, options) {
        this.title = title;
        this.options = options;
        this.closeCalls = 0;
        FakeNotification.instances.push(this);
    }

    close() {
        this.closeCalls++;
        this.onclose?.();
    }

    nativeClose() {
        this.onclose?.();
    }
}

function hiddenDocument() {
    return {
        title: '',
        visibilityState: 'hidden',
        querySelector() { return null; },
    };
}

test('AttentionService owns and closes desktop notifications', async () => {
    FakeNotification.instances = [];
    FakeNotification.permission = 'granted';
    const waiting = {
        id: 'agent-1',
        name: 'Ada',
        status: 'waiting_on_user',
        projectPath: '/work/demo',
    };
    const world = { agents: new Map([[waiting.id, waiting]]) };
    const service = new AttentionService(world, {
        document: hiddenDocument(),
        NotificationClass: FakeNotification,
    });
    service.desktopAlerts = true;

    service.refresh();
    assert.equal(service._notifications.size, 1);
    const first = FakeNotification.instances.at(-1);

    waiting.status = 'working';
    service.refresh();
    assert.equal(first.closeCalls, 1, 'attention clear closes its notification');
    assert.equal(service._notifications.size, 0);

    waiting.status = 'waiting_on_user';
    service.refresh();
    const raisedAgain = FakeNotification.instances.at(-1);
    service._notify(waiting, 'is waiting for you');
    assert.equal(raisedAgain.closeCalls, 1, 'replacement closes the previous handle');
    const replacement = FakeNotification.instances.at(-1);
    replacement.nativeClose();
    assert.equal(service._notifications.size, 0, 'native close releases ownership');

    service._notify(waiting, 'is waiting for you');
    const clickable = FakeNotification.instances.at(-1);
    const current = { ...waiting, name: 'Ada Current' };
    world.agents.set(waiting.id, current);
    let selected = null;
    const onSelected = agent => { selected = agent; };
    eventBus.on('agent:selected', onSelected);
    clickable.onclick();
    eventBus.off('agent:selected', onSelected);
    assert.strictEqual(selected, current, 'click resolves the current agent by id');
    assert.equal(clickable.closeCalls, 1);

    service._notify(current, 'is waiting for you');
    const disabled = FakeNotification.instances.at(-1);
    assert.equal(await service.setDesktopAlerts(false), false);
    assert.equal(disabled.closeCalls, 1);
    assert.equal(service._notifications.size, 0);

    service.desktopAlerts = true;
    service._notify(current, 'is waiting for you');
    const destroyed = FakeNotification.instances.at(-1);
    service.destroy();
    assert.equal(destroyed.closeCalls, 1);
    assert.equal(service._notifications.size, 0);
});

test('desktop permission failure leaves no notification handles', async () => {
    FakeNotification.permission = 'denied';
    const service = new AttentionService({ agents: new Map() }, {
        document: hiddenDocument(),
        NotificationClass: FakeNotification,
    });
    assert.equal(await service.setDesktopAlerts(true), false);
    assert.equal(service._notifications.size, 0);
    service.destroy();
    FakeNotification.permission = 'granted';
});

test('AgentManager retains fixed-size signatures and observes nested changes once', () => {
    const updates = [];
    const world = {
        agents: new Map(),
        addAgent(agent) { this.agents.set(agent.id, agent); },
        updateAgent(id, data) {
            updates.push(data);
            this.agents.get(id).update(data);
        },
        removeAgent(id) { this.agents.delete(id); },
    };
    const manager = new AgentManager(world, null);
    const session = {
        sessionId: 'session-1',
        name: 'Ada',
        status: 'active',
        gitEvents: [{ id: 'git-1', type: 'commit', label: 'first' }],
        sendMessages: [{ recipient: 'Bess', summary: 'hello' }],
        lastMessage: 'x'.repeat(100_000),
    };

    manager._upsertAgent(structuredClone(session), new Map());
    manager._upsertAgent(structuredClone(session), new Map());
    assert.equal(updates.length, 0);
    assert.equal(manager._agentSignatures.get(session.sessionId).length, 16);

    const gitChanged = structuredClone(session);
    gitChanged.gitEvents[0].label = 'second';
    manager._upsertAgent(gitChanged, new Map());
    manager._upsertAgent(structuredClone(gitChanged), new Map());
    assert.equal(updates.length, 1);

    const messageChanged = structuredClone(gitChanged);
    messageChanged.sendMessages[0].summary = 'changed';
    manager._upsertAgent(messageChanged, new Map());
    assert.equal(updates.length, 2);

    const digest = digestAgentPayload({
        nested: { rows: Array.from({ length: 100 }, (_, index) => ({ index, text: 'y'.repeat(1000) })) },
    });
    assert.equal(digest.length, 16);

    const digestWork = {};
    digestAgentPayload({
        _lastMessage: 'z'.repeat(10_000_000),
        gitEvents: Array.from({ length: 10_000 }, (_, index) => ({
            id: index,
            label: `event-${index}`,
        })),
    }, digestWork);
    assert.ok(digestWork.characters <= 64 * 1024);
    assert.ok(digestWork.values <= 6_144);

    const collectionHeavy = {
        gitEvents: Array.from({ length: 64 }, (_, index) => ({
            id: `git-${index}`,
            type: 'commit',
            label: `event-${index}`,
            status: 'ok',
            branch: 'main',
            project: '/work/demo',
            provider: 'claude',
            timestamp: index,
        })),
        permissionMode: 'ask',
        turnState: 'working',
        _lastMessage: 'still working',
        projectPath: '/work/demo',
    };
    const collectionDigest = digestAgentPayload(collectionHeavy);
    for (const [field, value] of [
        ['permissionMode', 'allow'],
        ['turnState', 'waiting'],
        ['_lastMessage', 'changed'],
        ['projectPath', '/work/other'],
    ]) {
        assert.notEqual(
            digestAgentPayload({ ...collectionHeavy, [field]: value }),
            collectionDigest,
            `${field} changes must remain visible after a full Git event sample`,
        );
    }
    const changedTail = structuredClone(collectionHeavy);
    changedTail.gitEvents.at(-1).label = 'changed-tail';
    assert.notEqual(digestAgentPayload(changedTail), collectionDigest);
});

test('WebSocket protocol snapshots are released on terminal disconnect', async () => {
    const previousWindow = globalThis.window;
    globalThis.window = { location: { protocol: 'http:', host: 'localhost:4000' } };
    try {
        const { WebSocketClient } = await import(
            `../../claudeville/src/infrastructure/WebSocketClient.js?test=${Date.now()}`
        );
        const client = new WebSocketClient();
        client._rememberSnapshot({
            seq: 7,
            sessions: [{ sessionId: 'one', payload: 'x'.repeat(10_000) }],
            teams: [{ teamName: 'demo' }],
            usage: { total: 1 },
        });
        assert.equal(client.getDebugSnapshot().retainedSessions, 1);
        assert.ok(client.getDebugSnapshot().retainedBytes > 10_000);
        client.disconnect();
        assert.deepEqual(client.getDebugSnapshot(), {
            connected: false,
            retainedSessions: 0,
            retainedTeams: 0,
            retainedBytes: 0,
            sequence: null,
        });
    } finally {
        globalThis.window = previousWindow;
    }
});

test('modal request generations reject stale owners', () => {
    const modal = Object.assign(Object.create(Modal.prototype), {
        _destroyed: false,
        _requestVersion: 0,
    });
    const first = modal.beginRequest();
    assert.equal(modal.isRequestCurrent(first), true);
    const second = modal.beginRequest();
    assert.equal(modal.isRequestCurrent(first), false);
    assert.equal(modal.isRequestCurrent(second), true);
    modal.invalidateRequest(second);
    assert.equal(modal.isRequestCurrent(second), false);
});

test('ChroniclePanel ignores out-of-order and superseded reads', async () => {
    const previousNode = globalThis.Node;
    const previousDocument = globalThis.document;
    globalThis.Node = class {};
    globalThis.document = { createTextNode: value => value };
    const contentEl = {
        children: [],
        replaceChildren() { this.children = []; },
        append(child) { this.children.push(child); },
    };
    const modal = {
        version: 0,
        title: '',
        contentEl,
        beginRequest() { return ++this.version; },
        isRequestCurrent(request) { return request === this.version; },
        invalidateRequest(request = null) {
            if (request === null || request === this.version) this.version++;
        },
        open(title, _html, { request } = {}) {
            if (!this.isRequestCurrent(request)) return false;
            this.title = title;
            return true;
        },
    };
    const pending = [];
    const log = {
        readDayPage() {
            return new Promise(resolve => pending.push(resolve));
        },
    };
    const panel = new ChroniclePanel({ modal, chronicleLog: log });
    panel._render = events => [events[0]?.id || 'empty'];
    const page = id => ({
        events: [{ id }],
        summary: summarizeDay([]),
        totalCount: 1,
    });

    try {
        const first = panel.open();
        const second = panel.open();
        pending[1](page('newest'));
        await second;
        pending[0](page('stale'));
        await first;
        assert.deepEqual(contentEl.children, ['newest']);

        const chronicle = panel.open();
        const changelogRequest = modal.beginRequest();
        modal.open('Changelog', '', { request: changelogRequest });
        pending[2](page('late-chronicle'));
        await chronicle;
        assert.equal(modal.title, 'Changelog');
        assert.deepEqual(contentEl.children, ['newest']);

        const destroyed = panel.open();
        panel.destroy();
        pending[3](page('after-destroy'));
        await destroyed;
        assert.equal(modal.title, 'Changelog');
    } finally {
        globalThis.Node = previousNode;
        globalThis.document = previousDocument;
    }
});

test('ActivityPanel rejects unknown building payload keys', () => {
    const world = {
        buildings: new Map([['forge', { type: 'forge' }]]),
    };
    const panel = Object.assign(Object.create(ActivityPanel.prototype), {
        _dependencies: { world: () => world },
        _selectedBuilding: null,
        _buildingSignalByType: new Map(),
    });
    const unknown = Object.fromEntries(
        Array.from({ length: 2_000 }, (_, index) => [`unknown-${index}`, { count: index }]),
    );
    const payload = {
        buildings: {
            ...unknown,
            forge: { count: 2, tier: 'occupied' },
        },
    };

    panel._cacheBuildingPayload(payload, panel._buildingSignalByType);
    assert.deepEqual([...panel._buildingSignalByType.keys()], ['forge']);

    panel._cacheBuildingPayload({ building: 'not-configured', count: 5 }, panel._buildingSignalByType);
    assert.equal(panel._buildingSignalByType.size, 1);

    const oversizedContainer = {
        forge: { count: 4 },
        ...Object.fromEntries(
            Array.from({ length: 100_000 }, (_, index) => [`unknown-${index}`, { count: index }]),
        ),
    };
    assert.deepEqual(
        panel._buildingPayloadEntries({ buildings: oversizedContainer }),
        [['forge', oversizedContainer.forge]],
        'building payload discovery must stop before materializing an unbounded container',
    );

    panel._cacheBuildingPayload({
        buildings: {
            forge: {
                headline: 'x'.repeat(10_000),
                arbitrary: { retained: 'no' },
                signal: {
                    summary: 'y'.repeat(10_000),
                    arbitraryNested: Array.from({ length: 1_000 }, () => ({ payload: 'no' })),
                },
                routes: Array.from({ length: 1_000 }, (_, index) => `route-${index}`),
            },
        },
    }, panel._buildingSignalByType);
    const bounded = panel._buildingSignalByType.get('forge');
    assert.ok(bounded.headline.length <= 512);
    assert.ok(bounded.signal.summary.length <= 512);
    assert.equal(bounded.routes.length, 3);
    assert.equal('arbitrary' in bounded, false);
    assert.equal('arbitraryNested' in bounded.signal, false);

    const branchKeys = [
        'signal',
        'status',
        'state',
        'detail',
        'queue',
        'route',
        'recent',
        'work',
        'activity',
        'payload',
        'data',
    ];
    const makeBranch = depth => depth === 0
        ? { summary: 'z'.repeat(10_000) }
        : Object.fromEntries(branchKeys.map(key => [key, makeBranch(depth - 1)]));
    panel._cacheBuildingPayload({
        buildings: { forge: makeBranch(3) },
    }, panel._buildingSignalByType);
    assert.ok(
        JSON.stringify(panel._buildingSignalByType.get('forge')).length < 32_768,
        'allowed nested branches must share one projection budget',
    );

    panel._cacheBuildingPayload({
        buildings: { forge: { count: 3 } },
    }, panel._buildingSignalByType);
    assert.deepEqual(panel._buildingSignalByType.get('forge'), { count: 3 });

    // The instrument model is the only consumer of a cached payload, so an
    // unknown key must not become a count, a denominator or a queue row there
    // either — and a payload whose collections never arrived must still model.
    const cached = { count: 3, load: { capacity: 9 }, occupancy: 7, queue: ['ghost'] };
    assert.deepEqual(
        buildBuildingInstrumentModel({
            building: { capacity: { work: 2 } },
            occupants: null,
            assignedAgents: undefined,
            routeAgents: null,
            reservations: null,
            external: cached,
        }),
        {
            presence: { count: 0, capacity: 2 },
            signal: { count: 0, capacity: 2 },
            queue: [],
            purpose: 'Purpose unavailable',
        },
    );
});

test('ActivityPanel stops periodic work while hidden and resumes once visible', () => {
    const previousDocument = globalThis.document;
    const previousSetInterval = globalThis.setInterval;
    const previousClearInterval = globalThis.clearInterval;
    let hidden = true;
    let nextTimer = 1;
    const activeTimers = new Set();
    const timerCallbacks = new Map();
    const calls = {
        detail: 0,
        pinned: 0,
        signal: 0,
    };
    globalThis.document = { get hidden() { return hidden; } };
    globalThis.setInterval = (callback) => {
        const id = nextTimer++;
        activeTimers.add(id);
        timerCallbacks.set(id, callback);
        return id;
    };
    globalThis.clearInterval = (id) => {
        timerCallbacks.delete(id);
        return activeTimers.delete(id);
    };
    const panel = Object.assign(Object.create(ActivityPanel.prototype), {
        _mode: 'agent',
        _pollTimer: null,
        _buildingPollTimer: null,
        _fetchDetail() { calls.detail++; },
        _fetchPinnedDetails() { calls.pinned++; },
        _renderBuildingSignal() { calls.signal++; },
    });

    try {
        panel._startPolling();
        assert.equal(activeTimers.size, 0);
        hidden = false;
        panel._syncPollingForVisibility();
        assert.equal(activeTimers.size, 1);
        assert.equal(calls.detail, 1);
        assert.equal(calls.pinned, 1);

        hidden = true;
        panel._syncPollingForVisibility();
        assert.equal(activeTimers.size, 0);
        assert.equal(panel._pollTimer, null);

        panel._mode = 'building';
        hidden = false;
        panel._syncPollingForVisibility();
        assert.equal(activeTimers.size, 1);
        assert.deepEqual({ signal: calls.signal, pinned: calls.pinned }, { signal: 1, pinned: 2 });
        for (const callback of timerCallbacks.values()) callback();
        assert.deepEqual({ signal: calls.signal, pinned: calls.pinned }, { signal: 2, pinned: 3 });

        hidden = true;
        panel._syncPollingForVisibility();
        assert.equal(activeTimers.size, 0);
        assert.equal(panel._buildingPollTimer, null);
    } finally {
        globalThis.document = previousDocument;
        globalThis.setInterval = previousSetInterval;
        globalThis.clearInterval = previousClearInterval;
    }
});

test('AssetManager settles image callbacks after success, fallback, failure and abort', async () => {
    const previousImage = globalThis.Image;
    const images = [];
    globalThis.Image = class {
        constructor() { images.push(this); }
        set src(value) { this.path = value; }
    };
    try {
        const manager = new AssetManager();
        for (const method of ['_loadImage', '_loadOptionalImage']) {
            const success = manager[method]('success.png');
            const image = images.at(-1);
            await image.onload();
            assert.equal((await success).ok, true);
            assert.equal(image.onload, null);
            assert.equal(image.onerror, null);
        }
        const optionalFailure = manager._loadOptionalImage('missing.png');
        images.at(-1).onerror();
        assert.equal((await optionalFailure).ok, false);
        for (const fallbackSucceeds of [true, false]) {
            const requiredFailure = manager._loadImage('missing.png');
            images.at(-1).onerror();
            const placeholder = images.at(-1);
            placeholder[fallbackSucceeds ? 'onload' : 'onerror']();
            assert.equal((await requiredFailure).ok, false);
        }
        for (const method of ['_loadImage', '_loadOptionalImage']) {
            const controller = new AbortController();
            const pending = manager[method]('pending.png', { signal: controller.signal });
            controller.abort();
            if (method === '_loadImage') await assert.rejects(pending, { name: 'AbortError' });
            else assert.equal((await pending).reason, 'aborted');
        }
        for (const image of images) {
            assert.equal(image.onload, null, image.path);
            assert.equal(image.onerror, null, image.path);
        }
    } finally {
        globalThis.Image = previousImage;
    }
});

test('AssetManager retains exact sources and resumes warm Worlds with sprite routes held', async () => {
    const previousImage = globalThis.Image;
    const previousDocument = globalThis.document;
    const previousCanvas = globalThis.HTMLCanvasElement;
    const previousFetch = globalThis.fetch;
    const requests = [];
    const pendingImages = [];
    let holdRoutes = false;
    globalThis.Image = class {
        width = 8;
        height = 8;
        pixels = new Uint8ClampedArray(8 * 8 * 4).fill(255);
        set src(path) {
            if (!path) return;
            requests.push(path);
            if (holdRoutes) pendingImages.push(this);
            else queueMicrotask(() => this.onload?.());
        }
    };
    globalThis.HTMLCanvasElement = class {
        width = 0;
        height = 0;
        getContext() {
            return {
                drawImage: (source) => { this.pixels = source.pixels; },
                getImageData: () => ({ data: this.pixels }),
                fillRect() {},
            };
        }
    };
    globalThis.document = { createElement: () => new globalThis.HTMLCanvasElement() };
    globalThis.fetch = async (path) => {
        requests.push(path);
        return {
            ok: true,
            text: async () => JSON.stringify({
                width: 8, height: 8,
                frames: { 'prop.test': { rect: { x: 0, y: 0, w: 8, h: 8 } } },
            }),
        };
    };
    const manager = new AssetManager({ materialAssets: true });
    const baseId = 'agent.test.base';
    const newId = 'agent.test.new';
    const entries = [
        {
            id: baseId,
            materialSidecar: true,
            actionStrip: { path: 'characters/test/read.png', cell: 1, groups: { read: { rows: [0, 1] } } },
        },
        { id: newId },
        { id: 'building.test' },
        { id: 'prop.test', atlasFrame: { atlas: 'test', key: 'prop.test' } },
    ];
    manager.manifest = {
        style: { assetVersion: 'test' },
        atlases: [{
            id: 'test', metadata: 'assets/sprites/atlases/test.json',
            channels: {
                albedo: 'assets/sprites/atlases/test.png',
                material: 'assets/sprites/atlases/test.material.png',
            },
        }],
    };
    manager.palettes = {};
    manager.assetVersion = 'test';
    manager._entriesCache = entries;
    manager._entryById = new Map(entries.map(entry => [entry.id, entry]));
    try {
        assert.equal(await manager.load({ characterIds: [baseId] }), true);
        const base = manager.get(baseId);
        const building = manager.get('building.test');
        const prop = manager.get('prop.test');
        const material = manager.getCompanion(baseId, 'material');
        const strip = manager.getActionStrip(baseId);
        const atlas = manager.getAtlas('test');
        const atlasMaterial = manager.getAtlas('test', 'material');
        const atlasMetadata = manager.getAtlasMetadata('test');
        manager.resolveMaterialChannels('prop.test', null, { crop: true });
        manager._derivedArtQueue.tick();
        const crop = manager.resolveMaterialChannels('prop.test', null, { crop: true });
        assert.equal(crop.ready, true);
        const mask = manager.getMask('building.test').slice();
        const outline = manager.getOutline('building.test');
        const sourceBytes = manager.cacheStats().retainedSourceEstimateBytes;
        requests.length = 0;
        holdRoutes = true;
        manager.suspend();
        assert.equal(outline.width, 0);
        assert.equal(outline.height, 0);
        assert.equal(crop.material.width, 0);
        assert.equal(crop.albedo.width, 0);
        assert.equal(manager.cacheStats().masks, 0);
        assert.equal(manager.cacheStats().outlines, 0);
        assert.equal(manager.cacheStats().retainedSourceEstimateBytes, sourceBytes);
        manager.evictUnpinnedOptionalSidecars({ highWaterEstimateBytes: 0 });
        assert.equal(manager.cacheStats().retainedSourceEstimateBytes, sourceBytes);

        assert.equal(await manager.resume(), true);
        assert.deepEqual(requests, [], 'a warm return must not refetch immutable sprite sources');
        assert.equal(manager.get(baseId), base);
        assert.equal(manager.get('building.test'), building);
        assert.equal(manager.get('prop.test'), prop);
        assert.equal(manager.getCompanion(baseId, 'material'), material);
        assert.equal(manager.getActionStrip(baseId), strip);
        assert.equal(manager.getAtlas('test'), atlas);
        assert.equal(manager.getAtlas('test', 'material'), atlasMaterial);
        assert.equal(manager.getAtlasMetadata('test'), atlasMetadata);
        assert.deepEqual(manager.getMask('building.test'), mask);
        assert.notEqual(manager.getOutline('building.test'), outline);

        manager.suspend();
        const ready = await Promise.race([
            manager.resume({ characterIds: [newId] }),
            new Promise(resolve => setImmediate(() => resolve('network-blocked'))),
        ]);
        assert.equal(ready, true, 'new identities must not gate retained World art');
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(manager.get(baseId), base);
        assert.equal(manager.has(newId, { request: false }), false);
        assert.deepEqual(requests, ['assets/sprites/characters/agent.test.new/sheet.png?v=test']);
        const staleImage = pendingImages.shift();
        const staleCompletion = staleImage.onload;
        manager.suspend();
        assert.equal(await manager.resume(), true);
        await new Promise(resolve => setImmediate(resolve));
        await staleCompletion();
        assert.equal(manager.has(newId, { request: false }), false);
        assert.equal(manager.get(baseId), base);
        const replacement = pendingImages.shift();
        const loaded = manager.requestCharacterAssets(newId);
        await replacement.onload();
        assert.equal(await loaded, true);
        assert.equal(manager.get(newId), replacement);
        assert.equal(manager.get(baseId), base);
    } finally {
        manager.dispose();
        globalThis.Image = previousImage;
        globalThis.document = previousDocument;
        globalThis.HTMLCanvasElement = previousCanvas;
        globalThis.fetch = previousFetch;
    }
});

test('AssetManager ignores an aborted cold decode and commits only the resumed sources', async () => {
    const previousImage = globalThis.Image;
    const pendingImages = [];
    globalThis.Image = class {
        width = 8;
        height = 8;
        set src(path) { if (path) pendingImages.push(this); }
    };
    const manager = new AssetManager();
    manager.manifest = {};
    manager.palettes = {};
    manager._entriesCache = [{ id: 'prop.test' }];
    manager._entryById.set('prop.test', manager._entriesCache[0]);
    try {
        const interrupted = manager.resume();
        const stale = pendingImages.shift();
        const staleCompletion = stale.onload;
        manager.suspend();
        const resumed = manager.resume();
        assert.equal(await interrupted, false);
        await new Promise(resolve => setImmediate(resolve));
        const replacement = pendingImages.shift();
        assert.ok(replacement, 'the interrupted generation must allow a fresh decode');
        await staleCompletion();
        assert.equal(manager.get('prop.test'), undefined);
        await replacement.onload();
        assert.equal(await resumed, true);
        assert.equal(manager.get('prop.test'), replacement);
    } finally {
        manager.dispose();
        globalThis.Image = previousImage;
    }
});

test('unfinished material decoding cannot gate a retained World generation', async () => {
    const previousImage = globalThis.Image;
    const pendingImages = [];
    let holdRoutes = false;
    globalThis.Image = class {
        width = 8;
        height = 8;
        set src(path) {
            if (!path) return;
            if (holdRoutes) pendingImages.push(this);
            else queueMicrotask(() => this.onload?.());
        }
    };
    const id = 'agent.test.base';
    const manager = new AssetManager();
    manager.manifest = {};
    manager.palettes = {};
    manager._entriesCache = [{ id, materialSidecar: true }];
    manager._entryById.set(id, manager._entriesCache[0]);
    try {
        assert.equal(await manager.load({ characterIds: [id] }), true);
        const base = manager.get(id);
        holdRoutes = true;
        const interrupted = manager.loadMaterialAssets();
        await new Promise(resolve => setImmediate(resolve));
        const stale = pendingImages.shift();
        const staleCompletion = stale.onload;
        manager.suspend();
        assert.equal(await Promise.race([
            manager.resume(),
            new Promise(resolve => setImmediate(() => resolve('network-blocked'))),
        ]), true);
        assert.equal(manager.get(id), base);
        assert.equal(await interrupted, false);
        await new Promise(resolve => setImmediate(resolve));
        const replacement = pendingImages.shift();
        assert.ok(replacement, 'unfinished material work must restart independently');
        const fallback = manager.resolveMaterialChannels(id, 'walk/s/0');
        assert.equal(fallback.material, null);
        await staleCompletion();
        assert.equal(manager.getCompanion(id, 'material'), null);
        const loaded = manager.loadMaterialAssets();
        await replacement.onload();
        assert.equal(await loaded, true);
        assert.equal(manager.resolveMaterialChannels(id, 'walk/s/0').material, replacement);
        assert.equal(manager.get(id), base);
    } finally {
        manager.dispose();
        globalThis.Image = previousImage;
    }
});

test('World resume waits for decoded assets and ignores stale completion', async () => {
    const { IsometricRenderer } = await import(
        '../../claudeville/src/presentation/character-mode/IsometricRenderer.js'
    );
    const assetResolvers = [];
    const assets = {
        resumeCalls: 0,
        suspendCalls: 0,
        resume() {
            this.resumeCalls++;
            return new Promise(resolve => assetResolvers.push(resolve));
        },
        suspend() {
            this.suspendCalls++;
        },
    };
    const canvas = {
        width: 0,
        height: 0,
        _claudeVilleCssWidth: 1280,
        _claudeVilleCssHeight: 720,
        _claudeVilleDpr: 0.5,
        getContext() { return {}; },
    };
    let starts = 0;
    let compositorReleaseCalls = 0;
    const renderer = Object.assign(Object.create(IsometricRenderer.prototype), {
        assets,
        compositor: {
            releaseCache() {
                compositorReleaseCalls++;
            },
        },
        canvas,
        ctx: null,
        camera: { resizeCalls: 0, onViewportResize() { this.resizeCalls++; } },
        trailRenderer: { resumeCalls: 0, resume() { this.resumeCalls++; } },
        agentSprites: new Map(),
        fantasyForestTreeCache: new Map(),
        _atmosphereEffectSpriteCache: new Map(),
        _staticPropDrawables: [],
        _disposed: false,
        running: true,
        frameId: null,
        _worldModeActive: false,
        _worldResourcesSuspended: true,
        _worldResourceGeneration: 0,
        _worldResumePromise: null,
        _worldResumeFailures: 0,
        _worldSpritesDirty: false,
        _frameFailureStats: { paused: false },
        _stopLoop() { this.frameId = null; },
        _startLoop() { starts++; this.frameId = starts; },
        _resumeFrameFailures() {},
        invalidateViewportCaches() {},
        releaseVolatileCaches() {},
    });

    renderer.setWorldModeActive(true);
    await Promise.resolve();
    assert.equal(assets.resumeCalls, 1);
    assert.equal(starts, 0, 'frame loop started before decoded assets');
    const firstResume = renderer._worldResumePromise;
    assetResolvers.shift()(true);
    assert.equal(await firstResume, true);
    assert.equal(starts, 1);
    assert.equal(canvas.width, 640);
    assert.equal(canvas.height, 360);

    renderer.setWorldModeActive(false);
    assert.equal(renderer._worldResourcesSuspended, true);
    assert.equal(canvas.width, 0);
    assert.equal(canvas.height, 0);
    assert.equal(compositorReleaseCalls, 1);

    renderer.setWorldModeActive(true);
    await Promise.resolve();
    const staleResume = renderer._worldResumePromise;
    renderer.setWorldModeActive(false);
    assetResolvers.shift()(true);
    assert.equal(await staleResume, false);
    assert.equal(starts, 1, 'stale asset completion restarted the frame loop');
    assert.equal(renderer._worldResourcesSuspended, true);
    assert.equal(compositorReleaseCalls, 1);
    assert.ok(assets.suspendCalls >= 2);
});
