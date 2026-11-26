import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { IsometricRenderer } from '../../claudeville/src/presentation/character-mode/IsometricRenderer.js';
import { InspectionGlass, writeGlassSetting } from '../../claudeville/src/presentation/character-mode/InspectionGlass.js';
import { CouncilRibbon } from '../../claudeville/src/presentation/character-mode/CouncilRibbon.js';
import { drawQuillPip, scribeSpeaker, usesScribeLine } from '../../claudeville/src/presentation/character-mode/ThoughtColumn.js';
import { ambientCaptionLayout } from '../../claudeville/src/presentation/character-mode/WorldFrameRenderer.js';
import { withPostcardFrame } from '../../claudeville/src/presentation/character-mode/Postcard.js';
import { publishReservedBox, getReservedRect } from '../../claudeville/src/presentation/shared/ReservedRects.js';
import { resetPersistedSettings, readPersistedSettings } from '../../claudeville/src/presentation/shared/TopBar.js';
import { writeSignageMode } from '../../claudeville/src/presentation/shared/DisplaySettings.js';

const source = path => readFileSync(new URL('../../claudeville/' + path, import.meta.url), 'utf8');
const html = source('index.html');

function surface(t) {
    const oldWindow = globalThis.window, oldDoc = globalThis.document;
    const topbar = new EventTarget();
    topbar.getBoundingClientRect = () => ({ height: 48 });
    const root = { dataset: {} };
    globalThis.window = new EventTarget();
    globalThis.window.location = new URL('http://localhost/');
    globalThis.document = { documentElement: root, getElementById: id => id === 'topbar' ? topbar : null };
    t.after(() => {
        if (oldWindow) globalThis.window = oldWindow;
        else delete globalThis.window;
        if (oldDoc) globalThis.document = oldDoc;
        else delete globalThis.document;
    });
    const renderer = Object.assign(Object.create(IsometricRenderer.prototype), {
        camera: {}, _worldModeActive: true, motionScale: 0,
        inspectionGlass: new InspectionGlass(), councilRibbon: new CouncilRibbon(),
        agentSprites: new Map(), _stopLoop() {}, _suspendWorldModeResources() {},
    });
    t.after(() => {
        renderer._endTheatreTransition?.();
        clearTimeout(renderer._whisperTimer);
        renderer.councilRibbon.clear();
    });
    return renderer;
}

function press(renderer, code, extra = {}) {
    const event = { code, key: code, preventDefault() { this.defaultPrevented = true; }, ...extra };
    renderer._handleWorldKeyboardCommand(event);
    return Boolean(event.defaultPrevented);
}

test('momentary READ, persistent lock and physical Glass keys honour focus, repeats, modifiers and postcard capture', t => {
    const r = surface(t);
    assert.ok(press(r, 'KeyB'));
    assert.ok(r.getReadMode());
    r._releaseWorldKeys({ code: 'KeyB' });
    assert.equal(r.getReadMode(), false);
    assert.ok(press(r, 'KeyB', { shiftKey: true }));
    assert.equal(press(r, 'KeyB', { shiftKey: true, repeat: true }), false);
    r._releaseWorldKeys();
    assert.ok(r.getReadMode());
    assert.equal(withPostcardFrame(() => r.getReadMode()).result, false);
    press(r, 'KeyB', { shiftKey: true });
    assert.equal(r.getReadMode(), false);
    for (const code of ['KeyH', 'KeyB', 'KeyC', 'KeyG', 'KeyP']) {
        assert.equal(press(r, code, { altKey: true }), false);
        assert.equal(press(r, code, { target: { tagName: 'INPUT' }, shiftKey: true }), false);
    }
    assert.equal(press(r, 'KeyL'), false);
    r.inspectionGlass.onPointerMove(20, 32);
    assert.equal(press(r, 'KeyG'), false);
    r.inspectionGlass.setEnabled(true);
    assert.ok(press(r, 'KeyG'));
    assert.deepEqual(r.inspectionGlass.center, { x: 20, y: 32 });
    r._releaseWorldKeys({ code: 'KeyG' });
    assert.equal(r.inspectionGlass.active, false);
    press(r, 'KeyG');
    r._releaseWorldKeys();
    assert.equal(r.inspectionGlass.active, false);
    press(r, 'KeyB', { shiftKey: true });
    r.setWorldModeActive(false);
    assert.equal(r.getReadMode(), false);
    assert.equal(press(r, 'KeyH'), false);
});

test('Glass dwell opens the existing aperture, leaves selection intact and yields to a selected building', t => {
    const r = surface(t);
    let now = 0, inside = true;
    t.mock.method(Date, 'now', () => now);
    r.camera = { zoom: 2, screenToWorld: (x, y) => ({ x, y }) };
    const buildings = r.buildingRenderer = {
        _zoom: 2, _selectedBuildingType: null,
        hitTest: () => inside ? { type: 'command' } : null,
        _updateInspection() { this.model = this._selectedBuildingType ? { buildingType: this._selectedBuildingType } : null; },
        getApertureModel() { return this.model; },
    };
    r.inspectionGlass.setEnabled(true);
    r.inspectionGlass.onPointerMove(30, 40);
    press(r, 'KeyG');
    const frame = time => {
        now = time;
        buildings._updateInspection();
        r._updateGlassCutaway();
        return buildings.model;
    };
    assert.equal(frame(0), null);
    assert.equal(frame(299), null);
    assert.deepEqual(frame(300), { buildingType: 'command', source: 'glass' });
    assert.equal(buildings._selectedBuildingType, null);
    inside = false;
    assert.equal(frame(301)?.source, 'glass');
    assert.equal(frame(700)?.source, 'glass');
    assert.equal(frame(701), null);
    inside = true;
    frame(702);
    assert.equal(frame(1002)?.source, 'glass');
    buildings._selectedBuildingType = 'command';
    assert.deepEqual(frame(1003), { buildingType: 'command' });
    buildings._selectedBuildingType = null;
    r.camera.zoom = 1.9;
    assert.equal(frame(1500), null);
    assert.equal(frame(1800), null);
});

test('wall display boot, stepped Theatre entry, reduced-motion exit, and mode change cleanup', async t => {
    const r = surface(t);
    const { App } = await import('../../claudeville/src/presentation/App.js');
    const url = Object.getOwnPropertyDescriptor(globalThis, 'location');
    Object.defineProperty(globalThis, 'location', { configurable: true, value: { search: '?theatre=1' } });
    t.after(() => url ? Object.defineProperty(globalThis, 'location', url) : delete globalThis.location);
    press(r, 'KeyB', { shiftKey: true });
    r.motionScale = 1;
    await App.prototype._mountWorldTools.call({ renderer: r }, r);
    const root = document.documentElement.dataset;
    assert.equal(root.cvTheatre, 'leaving');
    assert.equal(r.getReadMode(), false);
    await new Promise(resolve => setTimeout(resolve, 155));
    assert.equal(root.cvTheatre, 'settled');
    press(r, 'KeyH');
    assert.equal(root.cvTheatre, 'returning');
    await new Promise(resolve => setTimeout(resolve, 155));
    assert.equal(root.cvTheatre, undefined);
    r.motionScale = 0;
    press(r, 'KeyH');
    assert.equal(root.cvTheatre, 'settled');
    r.setWorldModeActive(false);
    assert.equal(root.cvTheatre, undefined);
});

test('Escape clears only the first active surface, from sidebar capture through Theatre', async t => {
    const r = surface(t);
    const { App } = await import('../../claudeville/src/presentation/App.js');
    const parent = { id: 'lead' };
    const child = { id: 'child', parentSessionId: 'lead' };
    const grandchild = { id: 'grandchild', rootSessionId: 'lead' };
    for (const a of [parent, child, grandchild, { id: 'gone', parentSessionId: 'lead', isDeparted: true }]) r.agentSprites.set(a.id, { agent: a });
    press(r, 'KeyC');
    assert.equal(r.focusedSquadIds, null);
    press(r, 'KeyH');
    r.selectedAgent = child;
    press(r, 'KeyC');
    assert.deepEqual([...r.focusedSquadIds], ['lead', 'child', 'grandchild']);
    press(r, 'KeyC');
    assert.equal(r.focusedSquadIds, null);
    press(r, 'KeyC');
    press(r, 'KeyB', { shiftKey: true });
    let opened = false, strikes = 0;
    r.togglePostcardStudio = () => { opened = !opened; };
    r.postcardStudio = { isOpen: () => opened, close() { opened = false; } };
    r.strikePostcard = () => strikes++;
    press(r, 'KeyP');
    press(r, 'KeyP', { shiftKey: true });
    assert.equal(strikes, 1);
    assert.ok(opened);
    let filter = true;
    const app = { renderer: r, sidebar: { clearFilter() { const had = filter; filter = false; return had; } } };
    App.prototype._bindGlobalKeyboardNavigation.call(app);
    const esc = () => {
        const event = Object.assign(new Event('keydown', { cancelable: true }), { key: 'Escape', code: 'Escape' });
        app._onGlobalKeydown(event);
        if (!event.defaultPrevented) r._handleWorldKeyboardCommand(event);
    };
    esc();
    assert.ok(!filter && opened);
    esc();
    assert.ok(!opened && r.focusedSquadIds);
    esc();
    assert.ok(!r.focusedSquadIds && r.getReadMode());
    esc();
    assert.ok(!r.getReadMode() && r.selectedAgent);
    r.camera.stopFollow = () => {};
    esc();
    assert.ok(!r.selectedAgent && r.theatreMode);
    esc();
    assert.equal(r.theatreMode, false);
});

test('Signage and The Glass round-trip and reset with the other operator preferences', () => {
    const entries = new Map();
    const store = { getItem: k => entries.get(k), setItem: (k, v) => entries.set(k, v) };
    assert.equal(writeSignageMode('invalid', store), 'compact');
    writeSignageMode('motifs', store);
    writeGlassSetting('on', store);
    assert.equal(entries.get('claudeville.world.signage'), 'motifs');
    assert.equal(entries.get('claudeville.world.glass'), 'on');
    const settings = readPersistedSettings(store);
    assert.equal(settings.signage, 'motifs');
    assert.equal(settings.glass, 'on');
    const reset = resetPersistedSettings(store);
    assert.equal(reset.signage, 'compact');
    assert.equal(reset.glass, 'off');
});

test('overview speaks once with a three-dot pip, below higher captions and above the stacked scrubber and ribbon', t => {
    const draws = [];
    const ctx = { save() {}, restore() {}, translate() {}, scale() {}, measureText: s => ({ width: s.length * 7 }),
        fillRect: (...rect) => draws.push(rect) };
    const sprite = { x: 100, bubbleSlot: 0, bubbleBaseY: 80, _statusThread: [{ text: 'Reading the plans' }],
        thoughtRepoAccent: () => '#654123', drawThought: () => draws.push('column') };
    const renderer = { _overlayBubbleOrder: [sprite], getReadMode: () => false, camera: {} };
    assert.ok(usesScribeLine(1.5, false, false));
    renderer._scribeSpeaker = scribeSpeaker(renderer._overlayBubbleOrder);
    drawQuillPip(ctx, renderer._scribeSpeaker, 2);
    assert.equal(draws.length, 3);
    assert.ok(draws.every(r => r[2] === 2 && r[3] === 2));
    const view = { width: 230, height: 220 };
    const scrub = { left: 20, right: 210, top: 172, bottom: 220 };
    publishReservedBox('retold-scrubber', scrub);
    const ribbon = new CouncilRibbon();
    t.after(() => { ribbon.clear(); publishReservedBox('retold-scrubber', null); });
    ribbon.setSquad({ lead: { id: 'l' }, children: [{ id: 'c' }] });
    ribbon.layout(view, { reservedBottomRect: getReservedRect('retold-scrubber') });
    const box = getReservedRect('council-ribbon');
    assert.equal(box.bottom, scrub.top - 4);
    const caption = ambientCaptionLayout(ctx, renderer, view);
    assert.equal(caption.text, 'Reading the plans');
    assert.equal(caption.chip, '#654123');
    assert.equal(caption.style.eyebrow, 'SPOKEN');
    assert.ok(caption.rect.bottom <= box.top - 4);
    for (const kind of ['parade', 'return-banner', 'biography-banner']) {
        assert.equal(ambientCaptionLayout(ctx, renderer, view, { releaseParade: { kind, label: 'Chapter' } }).text, 'Chapter');
    }
    assert.equal(ambientCaptionLayout(ctx, renderer, view, { incidentChapter: { kind: 'failed-push', caption: 'Incident' } }).text, 'Incident');
    assert.equal(usesScribeLine(1.6, false, false), false);
    assert.equal(usesScribeLine(2, false, true), true);
    assert.equal(usesScribeLine(1, true, false), false);
});

test('the shell boots Strip without changing the requested renderer, and wires its own sound control', () => {
    const script = html.match(/<script>([^]*?)<\/script>/)[1];
    for (const pathname of ['/', '/strip', '/strip/']) {
        const dataset = {}, manifest = { href: 'manifest.webmanifest' };
        runInNewContext(script, { location: { pathname, search: '?renderer=webgpu' },
            document: { documentElement: { dataset }, querySelector: () => manifest } });
        assert.equal(dataset.cvProfile, pathname === '/' ? undefined : 'strip');
        assert.equal(manifest.href, pathname === '/' ? 'manifest.webmanifest' : 'strip.webmanifest');
    }
    assert.match(html, /id="stripRail" hidden/);
    assert.ok(html.indexOf('href="css/strip.css"') > html.indexOf('href="css/mobile.css"'));
    const bar = source('src/presentation/shared/TopBar.js');
    assert.match(bar, /if \(!this\.stripProfile\) this\._scheduleAudioRoute\(\)/);
    assert.match(bar, /on\('stripSound', \(\) => this\._toggleSound\(\)\)/);
});

test('Chronicle exports the guarded postcard and Dashboard frames the agent from LOCATE IN WORLD', () => {
    const app = source('src/presentation/App.js');
    assert.match(app, /onExportTapestry: data => this\._exportTapestry\(data\)/);
    assert.match(app, /strikePostcard\(\{ save: false, crop: '16:9' \}\)/);
    assert.match(app, /renderChronicleTapestry\(\{ \.\.\.data, diorama, cast \}\)/);
    assert.match(app, /link\.download = tapestryFileName\(data\.dateKey\)/);
    assert.match(app, /onLocateInWorld: locate/);
    assert.match(app, /eventBus\.on\(module\.DASHBOARD_LOCATE_IN_WORLD_EVENT/);
    assert.match(app, /renderer\.frameWorldAgent\(agent\.id\)/);
});
