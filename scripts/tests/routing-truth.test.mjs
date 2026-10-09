import test from 'node:test';
import assert from 'node:assert/strict';

import { BUILDING_DEFS } from '../../claudeville/src/config/buildings.js';
import { AgentStatus } from '../../claudeville/src/domain/value-objects/AgentStatus.js';
import { homeDistrictFor } from '../../claudeville/src/presentation/character-mode/HomeDistrict.js';
import { resolveUpdateRouteBuilding } from '../../claudeville/src/presentation/character-mode/MovementRouting.js';
import { VisitIntentManager } from '../../claudeville/src/presentation/character-mode/VisitIntentManager.js';
import { AgentSprite } from '../../claudeville/src/presentation/character-mode/AgentSprite.js';
import { tileToWorld } from '../../claudeville/src/presentation/character-mode/Projection.js';
import { LandmarkActivity } from '../../claudeville/src/presentation/character-mode/LandmarkActivity.js';

const NOW = 1_800_000_000_000;
const worker = (extra = {}) => ({
    id: 'routing-worker', status: AgentStatus.WORKING,
    provider: 'claude', model: 'claude-sonnet-4-6', tokens: { input: 1000 },
    ...extra,
});

function tokenIntents(manager, now) {
    return manager.snapshot(now).intents.filter(intent => intent.source === 'token');
}

test('home district is session-stable and covers only capacity-bearing work landmarks', () => {
    const districts = new Set();
    for (let i = 0; i < 256; i++) {
        const sessionId = `session-${i}`;
        const district = homeDistrictFor({ id: `body-${i}`, sessionId });
        assert.equal(homeDistrictFor({ id: 'replacement-body', sessionId }), district);
        const building = BUILDING_DEFS.find(def => def.type === district);
        assert.ok(building.capacity.work > 0);
        assert.ok(building.visitTiles.some(slot => slot.role === 'work'));
        assert.notEqual(district, 'watchtower');
        districts.add(district);
    }
    assert.ok(districts.size > 1, 'no-signal workers spread over districts');
});

test('intent, live tool, target and last-known evidence all beat the home district', () => {
    const agent = worker();
    const options = { agent, status: agent.status };
    assert.equal(resolveUpdateRouteBuilding(options), homeDistrictFor(agent));
    assert.equal(resolveUpdateRouteBuilding({ ...options, activeIntentBuilding: 'harbor' }), 'harbor');
    assert.equal(resolveUpdateRouteBuilding({ ...options, targetBuilding: 'archive' }), 'archive');
    assert.equal(resolveUpdateRouteBuilding({ ...options, lastKnownBuilding: 'forge' }), 'forge');
    agent.currentTool = 'Edit';
    agent.currentToolInput = { file_path: 'src/main.js' };
    assert.equal(resolveUpdateRouteBuilding({ ...options, targetBuilding: 'command' }), 'forge');
    const sprite = new AgentSprite(agent);
    assert.equal(sprite._targetBuildingTypeForState(), 'forge');
    assert.equal(sprite._fallbackBuildingForState().type, 'forge');
    agent.currentTool = null;
    assert.equal(sprite._targetBuildingTypeForState(), homeDistrictFor(agent));
    assert.equal(sprite._fallbackBuildingForState().type, homeDistrictFor(agent));
    for (const [status, building] of [
        [AgentStatus.WAITING_ON_USER, 'command'],
        [AgentStatus.ERRORED, 'watchtower'],
        [AgentStatus.RATE_LIMITED, 'watchtower'],
    ]) {
        agent.status = status;
        assert.equal(resolveUpdateRouteBuilding({ agent, status }), building);
        assert.equal(sprite._fallbackBuildingForState().type, building);
    }
});

test('cash-out accumulates session deltas, has priority 55 and a 90-second cooldown', t => {
    const manager = new VisitIntentManager({ now: () => NOW });
    t.after(() => manager.dispose());
    const agent = worker();
    manager.reconcile([agent], NOW);
    for (let i = 1; i <= 7; i++) {
        agent.tokens.input = 1000 + i * 1000;
        manager.reconcile([agent], NOW + i * 1000);
        assert.equal(tokenIntents(manager, NOW + i * 1000).length, 0);
    }
    agent.tokens.input = 9000;
    manager.reconcile([agent], NOW + 8000);
    const cashOut = tokenIntents(manager, NOW + 8000)[0];
    assert.equal(cashOut.reason, 'cash-out');
    assert.equal(cashOut.priority, 55);
    agent.tokens.input = 17000;
    manager.reconcile([agent], NOW + 97000);
    assert.equal(tokenIntents(manager, NOW + 97000).length, 0);
    manager.reconcile([agent], NOW + 98000);
    assert.equal(tokenIntents(manager, NOW + 98000).length, 1);
    manager.reconcile([], NOW + 99000);
    assert.equal(manager.cashOutSnapshots.size, 0, 'departed sessions release cooldown state');
});

test('four percent of a known context window can trigger before eight thousand tokens', t => {
    const manager = new VisitIntentManager({ now: () => NOW });
    t.after(() => manager.dispose());
    const agent = worker({ tokens: { input: 1000, contextWindowMax: 100000 } });
    manager.reconcile([agent], NOW);
    agent.tokens.input = 4999;
    manager.reconcile([agent], NOW + 1000);
    assert.equal(tokenIntents(manager, NOW + 1000).length, 0);
    agent.tokens.input = 5000;
    manager.reconcile([agent], NOW + 2000);
    assert.equal(tokenIntents(manager, NOW + 2000)[0].payload.delta, 4000);
});

test('token receipts never interrupt or queue a commute behind live tools', t => {
    const manager = new VisitIntentManager({ now: () => NOW });
    t.after(() => manager.dispose());
    const agent = worker({ currentTool: 'Edit', currentToolInput: { file_path: 'src/main.js' } });
    manager.reconcile([agent], NOW);
    agent.tokens.input += 1024;
    manager.reconcile([agent], NOW + 1000);
    assert.equal(tokenIntents(manager, NOW + 1000).length, 0, 'token-delta is cue-only');
    agent.tokens.input += 8000;
    manager.reconcile([agent], NOW + 2000);
    assert.equal(tokenIntents(manager, NOW + 2000).length, 0, 'cash-out is cue-only mid-tool');
    assert.equal(manager.getIntentForAgent(agent.id, NOW + 2000).source, 'tool');
    agent.currentTool = null;
    manager.reconcile([agent], NOW + 33000);
    assert.equal(tokenIntents(manager, NOW + 33000).length, 0, 'tool expiry does not revive a token commute');
    agent.tokens.input += 8000;
    manager.reconcile([agent], NOW + 91000);
    assert.equal(tokenIntents(manager, NOW + 91000).length, 0, 'cooldown applies to cue-only receipts too');
    manager.reconcile([agent], NOW + 92000);
    assert.equal(tokenIntents(manager, NOW + 92000)[0].priority, 55);
    agent.currentTool = 'Edit';
    manager.reconcile([agent], NOW + 93000);
    assert.equal(tokenIntents(manager, NOW + 93000).length, 0, 'a new tool clears pending cash-out');
    assert.equal(manager.getIntentForAgent(agent.id, NOW + 93000).priority, 80);
});

test('context pressure still carries a real Mine intent even mid-tool', t => {
    const manager = new VisitIntentManager({ now: () => NOW });
    t.after(() => manager.dispose());
    const agent = worker({ currentTool: 'Edit', tokens: { input: 1000, contextWindow: 85000, contextWindowMax: 100000 } });
    manager.reconcile([agent], NOW);
    assert.ok(manager.snapshot(NOW).intents.some(intent => intent.reason === 'context-pressure' && intent.building === 'mine'));
});

test('large mid-tool token receipts reach existing Mine carts without a Mine visitor', t => {
    const activity = new LandmarkActivity();
    t.after(() => activity.dispose());
    const agent = worker({ currentTool: 'Edit', tokens: { input: 1000, cacheRead: 1000, availability: 'observed' } });
    activity.reconcile([agent], [], NOW);
    agent.tokens = { input: 9000, cacheRead: 5000, availability: 'observed' };
    activity.reconcile([agent], [], NOW + 1000);
    const cart = [...activity.items.values()].find(item => item.type === 'token');
    assert.ok(cart);
    assert.equal(cart.building, 'mine');
    assert.equal(cart.delta, 12000);
    assert.equal(cart.cargo.input, 8000);
    assert.equal(cart.cargo.cacheRead, 4000);
    const assay = activity.getMineAssay(NOW + 1000);
    assert.equal(assay.tokens.input, 8000);
    assert.equal(assay.tokens.cacheRead, 4000);
});

function plantedSprite(t) {
    t.mock.method(Date, 'now', () => NOW);
    const intent = { id: 'tool-edit', source: 'tool', building: 'forge', reason: 'edit-file', priority: 80, expiresAt: NOW + 30000, interruptible: true };
    let slot = { tileX: 25, tileY: 30, slotId: 'forge-0' };
    const sprite = new AgentSprite(worker({ currentTool: 'Edit' }), {
        getIntentForAgent: () => intent,
        allocateVisitTile: () => slot,
    });
    Object.assign(sprite, tileToWorld(slot));
    sprite.moving = false;
    sprite.behavior.arrive();
    return { sprite, intent, setSlot: next => { slot = next; } };
}

test('same-slot re-pick within 0.6 tile holds arrival and makes no path assignment', t => {
    const { sprite } = plantedSprite(t);
    Object.assign(sprite, tileToWorld(25.4, 30.2));
    const arrivedAt = sprite.behavior.arrivedAt;
    const routes = sprite.behavior.reroutes;
    const path = t.mock.method(sprite, '_assignTarget');
    sprite.behavior.finishVisit();
    sprite._pickTarget();
    assert.equal(path.mock.callCount(), 0);
    assert.equal(sprite.moving, false);
    assert.equal(sprite.behavior.arrivedAt, arrivedAt);
    assert.equal(sprite.behavior.reroutes, routes);
    assert.ok(sprite.waitTimer >= 240);
});

test('a different allocated slot or a distant body still receives a route', t => {
    const { sprite, setSlot } = plantedSprite(t);
    setSlot({ tileX: 25.2, tileY: 30, slotId: 'forge-1' });
    const path = t.mock.method(sprite, '_assignTarget');
    sprite._pickTarget();
    assert.equal(path.mock.callCount(), 1, 'allocator overwriting last slot must not falsely trigger a hold');
    sprite.moving = false;
    Object.assign(sprite, tileToWorld(23, 30));
    sprite._pickTarget();
    assert.equal(path.mock.callCount(), 2, 'same slot beyond 0.6 tile must route');
});

test('arrival hysteresis blocks equal/lower intent priority for five seconds, never alerts/chat', t => {
    const { sprite } = plantedSprite(t);
    sprite._intentStableUntil = NOW - 1;
    sprite.behavior.arrivedAt = NOW - 4999;
    const next = { id: 'next-tool', priority: 80 };
    assert.equal(sprite._shouldRetargetForIntent(next, 'archive', next.id), false);
    assert.equal(sprite._shouldRetargetForIntent({ ...next, priority: 55 }, 'mine', next.id), false);
    assert.equal(sprite._shouldRetargetForIntent({ ...next, priority: 90 }, 'watchtower', next.id), true);
    assert.equal(sprite._shouldRetargetForIntent({ ...next, priority: 100 }, 'command', next.id), true);
    sprite._pickTarget();
    sprite.behavior.arrivedAt = NOW - 5000;
    sprite._intentStableUntil = NOW - 1;
    assert.equal(sprite._shouldRetargetForIntent(next, 'archive', next.id), true);
});

test('working dwell is five-second base in virtual ticks and scales with observed pending-tool age', t => {
    const { sprite } = plantedSprite(t);
    sprite._noise = () => 0.5;
    const base = sprite._waitDurationForState();
    assert.ok(base >= 240 && base <= 360, `base dwell: ${base}`);
    sprite.agent.turnState = 'tool_pending';
    sprite.agent.pendingSince = NOW - 12000;
    const longer = sprite._waitDurationForState();
    assert.ok(longer > base && longer <= 480);
});
