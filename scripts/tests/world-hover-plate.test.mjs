import test from 'node:test';
import assert from 'node:assert/strict';

import {
    HOVER_PLATE_DELAY_MS,
    hoverPlateLines,
    placeHoverPlate,
    villagerHoverLine,
} from '../../claudeville/src/presentation/shared/WorldHoverPlate.js';
import { Agent } from '../../claudeville/src/domain/entities/Agent.js';
import { AgentStatus } from '../../claudeville/src/domain/value-objects/AgentStatus.js';

// XP-4: the World's hover plate replaces the OS title bubble.

function agent(fields = {}) {
    return new Agent({ id: 'v1', name: 'Kael', model: 'claude-opus-5-5', provider: 'claude', status: AgentStatus.WORKING, ...fields });
}

test('the plate waits 250 ms like a settled pointer', () => {
    assert.equal(HOVER_PLATE_DELAY_MS, 250);
});

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
