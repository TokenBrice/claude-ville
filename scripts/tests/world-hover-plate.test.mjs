import test from 'node:test';
import assert from 'node:assert/strict';

import {
    WorldHoverPlate,
    hoverPlateLines,
    placeHoverPlate,
    villagerHoverLine,
} from '../../claudeville/src/presentation/shared/WorldHoverPlate.js';
import { Agent } from '../../claudeville/src/domain/entities/Agent.js';
import { AgentStatus } from '../../claudeville/src/domain/value-objects/AgentStatus.js';
import { IsometricRenderer } from '../../claudeville/src/presentation/character-mode/IsometricRenderer.js';
import { worldToTile } from '../../claudeville/src/presentation/character-mode/Projection.js';

// XP-4: the World's hover plate replaces the OS title bubble.

function agent(fields = {}) {
    return new Agent({ id: 'v1', name: 'Kael', model: 'claude-opus-5-5', provider: 'claude', status: AgentStatus.WORKING, ...fields });
}

test('a villager reads name · building · tool · age, never speech', () => {
    const now = Date.now();
    const villager = agent({ currentTool: 'Edit', lastMessage: 'I will refactor the router now' });
    Object.defineProperty(villager, 'statusSince', { value: now - 3 * 60_000, configurable: true });
    const line = villagerHoverLine(villager, { buildingType: 'forge', now });
    assert.equal(line, 'Kael · Forge · Edit · 3m');
    assert.ok(!line.includes('refactor'));
    assert.ok(!line.includes('\n'));
});

test('a villager line drops the fields it does not know', () => {
    const villager = agent({ status: AgentStatus.IDLE });
    Object.defineProperty(villager, 'statusSince', { value: null, configurable: true });
    assert.equal(villager.currentTool, null);
    assert.equal(villagerHoverLine(villager, { buildingType: 'nowhere' }), 'Kael · Idle');
    assert.equal(villagerHoverLine(null), '');
});

test('lore folds to two lines at most, the head kept', () => {
    assert.deepEqual(hoverPlateLines(''), []);
    assert.deepEqual(hoverPlateLines('FORGE: 2 visiting, 0 en route'), ['FORGE: 2 visiting, 0 en route']);
    assert.deepEqual(hoverPlateLines('repo - main - 3 commits\n+2 more branches'), ['repo - main - 3 commits', '+2 more branches']);
    assert.deepEqual(
        hoverPlateLines('Hourglass Belfry · sand left = quota left\nClaude 40% · 2h\nCodex 70% · 1h'),
        ['Hourglass Belfry · sand left = quota left', 'Claude 40% · 2h · Codex 70% · 1h'],
    );
});

const host = { hostWidth: 1000, hostHeight: 600 };

test('the plate sits off the pointer and flips at the edges', () => {
    assert.deepEqual(placeHoverPlate({ ...host, point: { x: 100, y: 100 }, width: 200, height: 40 }), { x: 116, y: 116 });
    // Near the right edge it flips left, near the bottom it flips above.
    assert.deepEqual(placeHoverPlate({ ...host, point: { x: 900, y: 100 }, width: 200, height: 40 }), { x: 684, y: 116 });
    assert.deepEqual(placeHoverPlate({ ...host, point: { x: 900, y: 580 }, width: 200, height: 40 }), { x: 684, y: 524 });
});

test('the plate never covers the villager it inspects', () => {
    const target = { left: 480, top: 300, right: 520, bottom: 380 };
    const right = placeHoverPlate({ ...host, point: { x: 500, y: 340 }, target, width: 200, height: 40 });
    assert.deepEqual(right, { x: 528, y: 320 });
    const nearEdge = { left: 880, top: 300, right: 920, bottom: 380 };
    const left = placeHoverPlate({ ...host, point: { x: 900, y: 340 }, target: nearEdge, width: 200, height: 40 });
    assert.ok(left.x + 200 <= nearEdge.left, 'flips to the left of the body');
});

test('the plate steps around reserved chrome', () => {
    const reserved = [{ left: 100, top: 100, right: 400, bottom: 200 }];
    const spot = placeHoverPlate({ ...host, point: { x: 100, y: 100 }, width: 200, height: 40, reserved });
    const rect = { left: spot.x, top: spot.y, right: spot.x + 200, bottom: spot.y + 40 };
    assert.ok(!(rect.left < 400 && rect.right > 100 && rect.top < 200 && rect.bottom > 100));
});

// ─── Through the renderer: real reveal timing, mouse and touch content ───

function fakeElement() {
    return {
        className: '',
        hidden: false,
        style: {},
        lines: [],
        setAttribute() {},
        replaceChildren(...children) { this.lines = children.map((child) => child.textContent); },
        get offsetWidth() { return 160; },
        get offsetHeight() { return 28; },
        remove() {},
    };
}

function worldHarness(t) {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const previous = { document: globalThis.document, raf: globalThis.requestAnimationFrame };
    globalThis.document = { createElement: () => fakeElement() };
    // Runs the frame callback at once; null keeps the throttle slot free.
    globalThis.requestAnimationFrame = (callback) => { callback(); return null; };
    t.after(() => {
        globalThis.document = previous.document;
        globalThis.requestAnimationFrame = previous.raf;
    });
    const host = { clientWidth: 800, clientHeight: 600, append(el) { this.plate = el; } };
    const forge = { type: 'forge', shortLabel: 'FORGE' };
    const villager = {
        x: 400, y: 300, moving: false, hits: true,
        _bodyBox: { left: -15, right: 15, top: -54, bottom: 3 },
        _lastBuildingType: 'forge',
        behavior: { building: 'forge', arrivedAt: null },
        _activitySnapshot: { text: 'I will refactor the router now', source: 'claude.transcript', kind: 'assistant', fidelity: 'excerpt' },
        agent: { id: 'v1', name: 'Kael', status: AgentStatus.WORKING, currentTool: 'Edit', statusSince: Date.now() - 3000 },
        hitTest(x, y) { return this.hits && Math.abs(x - this.x) < 15 && y > this.y - 54 && y < this.y + 3; },
        // The Forge's visit tile is where this body was placed.
        _buildingForType: (type) => (type === 'forge' ? { type, visitTiles: [worldToTile(400, 300)] } : null),
        setHovered() {},
    };
    const ship = { id: 's1', project: '/r/demo', branch: 'main' };
    const pillarSprite = { id: 'prop.quotaPillar', provider: 'claude' };
    const state = { forgeEverywhere: false };
    let fleetCards = 0;
    const renderer = Object.assign(Object.create(IsometricRenderer.prototype), {
        canvas: { parentElement: host, getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }) },
        camera: { screenToWorld: (x, y) => ({ x, y }), worldToScreen: (x, y) => ({ x, y }) },
        agentSprites: new Map([['v1', villager]]),
        buildingRenderer: {
            hitTest: (x, y) => (state.forgeEverywhere || (x >= 100 && x <= 300 && y >= 100 && y <= 260) ? forge : null),
            setHovered() {},
            worldBounds: (building) => (building === forge ? { left: 100, top: 60, right: 300, bottom: 260 } : null),
        },
        harborTraffic: {
            hitTestShip: (x, y) => (x > 600 && y > 450 ? ship : null),
            setHoveredShip() {},
            shipTooltip: () => 'demo · main - fix the gate',
        },
        _agentHoverRafId: null,
        isleLandmarks: {
            hitTestQuotaPillar: (x, y) => (x >= 500 && x <= 540 && y >= 20 && y <= 180 ? pillarSprite : null),
            quotaPillarWorldBounds: (p) => (p === pillarSprite ? { left: 490, top: 10, right: 550, bottom: 190 } : null),
            quotaPillarTooltip: () => 'Claude Weekly · 62% left\nResets in 3d 4h · 5h: 18% used',
        },
        _isGateTransit: () => false,
        _openFleetCard() { fleetCards++; },
        _onMouseLeaveMain() {},
    });
    // The mousemove handler's steps (constructor closure), at a CSS point.
    const move = (x, y) => {
        renderer._hoverLore = renderer._worldHoverInfo(x, y);
        renderer._hoverPoint = { x, y };
        renderer._scheduleAgentHoverTest(x, y);
    };
    const plate = () => (host.plate && !host.plate.hidden ? host.plate : null);
    return { renderer, host, villager, move, plate, forge, state, fleetCards: () => fleetCards };
}

test('renderer: the plate reveals 250 ms after the pointer settles, with the villager line and its source', (t) => {
    const { move, plate, villager } = worldHarness(t);
    move(400, 280);
    assert.equal(plate(), null);
    t.mock.timers.tick(249);
    assert.equal(plate(), null, 'not before 250 ms');
    t.mock.timers.tick(1);
    assert.ok(plate());
    const [line, source] = plate().lines;
    assert.match(line, /^Kael · Edit · \d+s$/, 'no building before a recorded arrival');
    assert.match(source, /claude\.transcript/);
    assert.match(source, /excerpt/);
    assert.ok(!plate().lines.join(' ').includes('refactor'), 'never the speech');
    // The plate sits beside the body, not on it.
    const left = Number.parseInt(plate().style.left, 10);
    const top = Number.parseInt(plate().style.top, 10);
    const box = { left: 385, right: 415, top: 246, bottom: 303 };
    assert.ok(left >= box.right || left + 160 <= box.left || top >= box.bottom || top + 28 <= box.top);
    void villager;
});

test('renderer: the building shows only after an arrival there, standing still', (t) => {
    const { renderer, villager } = worldHarness(t);
    const text = () => renderer._hoverPlateContent(villager).text.split('\n')[0];
    assert.ok(!text().includes('Forge'), 'routing toward the Forge is not being there');
    villager.behavior.arrivedAt = Date.now();
    assert.match(text(), /^Kael · Forge · Edit/);
    villager.moving = true;
    assert.ok(!text().includes('Forge'), 'a walker is not at the Forge');
    villager.moving = false;
    villager.behavior.building = 'archive';
    assert.ok(!text().includes('Forge'), 'an arrival elsewhere does not count');
    // A finished chat approach records an arrival wherever the partner stood,
    // while the Forge stays the last building: off its visit tile, no Forge.
    villager.behavior.building = 'forge';
    villager.x = 520;
    villager.y = 360;
    assert.ok(!text().includes('Forge'), 'chatting away from the Forge is not being there');
});

test('renderer: a quota pillar passes its drawn bounds, and the plate keeps clear of them', (t) => {
    const { move, plate } = worldHarness(t);
    move(500, 120);
    t.mock.timers.tick(250);
    assert.deepEqual(plate().lines, ['Claude Weekly · 62% left', 'Resets in 3d 4h · 5h: 18% used']);
    const left = Number.parseInt(plate().style.left, 10);
    const top = Number.parseInt(plate().style.top, 10);
    const rect = { left, top, right: left + 160, bottom: top + 28 };
    assert.ok(rect.left >= 550 || rect.right <= 490 || rect.top >= 190 || rect.bottom <= 10, JSON.stringify(rect));
});

test('renderer: the dwell belongs to what is hovered, so a replacement at reveal waits its own 250 ms', (t) => {
    const { move, plate, villager, state } = worldHarness(t);
    move(400, 280);
    t.mock.timers.tick(240);
    villager.hits = false;
    state.forgeEverywhere = true;
    t.mock.timers.tick(10);
    assert.equal(plate(), null, 'the Forge took the pointer 10 ms ago');
    t.mock.timers.tick(249);
    assert.equal(plate(), null);
    t.mock.timers.tick(1);
    assert.deepEqual(plate().lines, ['FORGE: 0 active']);
});

test('the plate keeps one dwell per identity while its text changes', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const previous = globalThis.document;
    globalThis.document = { createElement: () => fakeElement() };
    t.after(() => { globalThis.document = previous; });
    const host = { clientWidth: 800, clientHeight: 600, append(el) { this.plate = el; } };
    const hover = new WorldHoverPlate({ host });
    hover.update('Kael · Edit · 3s', { x: 10, y: 10 }, null, 'agent:v1');
    t.mock.timers.tick(200);
    hover.update('Kael · Edit · 4s', { x: 10, y: 10 }, null, 'agent:v1');
    t.mock.timers.tick(50);
    assert.ok(hover.visible, 'a ticking age does not restart the dwell');
    assert.deepEqual(host.plate.lines, ['Kael · Edit · 4s']);
});

test('renderer: a villager that walks off during the delay or after the reveal takes its plate along', (t) => {
    const { renderer, move, plate, villager } = worldHarness(t);
    move(400, 280);
    villager.hits = false;
    t.mock.timers.tick(250);
    assert.equal(plate(), null, 'the reveal re-reads the pointer');

    villager.hits = true;
    move(400, 281);
    t.mock.timers.tick(250);
    assert.ok(plate());
    villager.hits = false;
    renderer._refreshHoverPlate(1e9);
    t.mock.timers.tick(120);
    assert.equal(plate(), null, 'the scene moved beneath a still pointer');
});

test('renderer: scenery lore keeps clear of the building it names', (t) => {
    const { move, plate } = worldHarness(t);
    move(200, 200);
    t.mock.timers.tick(250);
    assert.deepEqual(plate().lines, ['FORGE: 0 active']);
    const left = Number.parseInt(plate().style.left, 10);
    const top = Number.parseInt(plate().style.top, 10);
    const rect = { left, top, right: left + 160, bottom: top + 28 };
    assert.ok(rect.left >= 300 || rect.right <= 100 || rect.top >= 260 || rect.bottom <= 60, JSON.stringify(rect));
});

test('renderer: a held finger shows the same plate at once, ships included', (t) => {
    const { renderer, plate, fleetCards } = worldHarness(t);
    assert.equal(renderer._showTouchInfo(700, 500), true);
    assert.deepEqual(plate().lines, ['demo · main - fix the gate']);
    assert.equal(fleetCards(), 0, 'a hold reads the ship; a tap opens the fleet card');
    renderer._dismissTouchInfo();
    assert.equal(renderer._showTouchInfo(400, 280), true);
    assert.match(plate().lines[0], /^Kael/);
    t.mock.timers.tick(4000);
    assert.equal(plate(), null);
    assert.equal(renderer._showTouchInfo(20, 20), false, 'bare ground shows nothing');
});
