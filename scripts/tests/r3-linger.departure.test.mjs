import test from 'node:test';
import assert from 'node:assert/strict';

import {
    AgentManager,
    DEPARTED_AGENT_GRACE_MS,
    MAX_DEPARTED_AGENTS,
} from '../../claudeville/src/application/AgentManager.js';
import { isAttentionStatus } from '../../claudeville/src/domain/services/StatusResolver.js';
import { World } from '../../claudeville/src/domain/entities/World.js';
import { eventBus } from '../../claudeville/src/domain/events/DomainEvent.js';
import { AgentStatus } from '../../claudeville/src/domain/value-objects/AgentStatus.js';

function liveSession(id) {
    return {
        sessionId: id,
        provider: 'codex',
        status: 'active',
        turnState: 'working',
        lastTool: 'Read',
    };
}

test('missing burst agents linger as non-live, non-attention villagers', () => {
    let now = 1_000;
    const world = new World();
    const manager = new AgentManager(world, null, { clock: () => now });
    const sessions = Array.from({ length: 20 }, (_, index) => liveSession(`burst-${index}`));

    manager.handleWebSocketMessage({ sessions });
    manager.handleWebSocketMessage({ sessions: [] });

    assert.equal(world.agents.size, 20);
    for (const agent of world.agents.values()) {
        assert.equal(agent.isDeparted, true);
        assert.equal(agent.departedAt, now);
        assert.equal(agent.status, AgentStatus.COMPLETED);
        assert.equal(agent.currentTool, null);
        assert.equal(agent.awaitingSince, null);
        assert.equal(isAttentionStatus(agent.status), false);
    }
    assert.deepEqual(
        (({ working, idle, waiting, errored, attention }) => ({ working, idle, waiting, errored, attention }))(world.getStats()),
        { working: 0, idle: 0, waiting: 0, errored: 0, attention: 0 },
    );

    now += DEPARTED_AGENT_GRACE_MS - 1;
    manager.handleWebSocketMessage({ sessions: [] });
    assert.equal(world.agents.size, 20);

    now += 1;
    manager.handleWebSocketMessage({ sessions: [] });
    assert.equal(world.agents.size, 0);
});

test('a returning session reclaims the same villager object without duplication', () => {
    let now = 5_000;
    const world = new World();
    const manager = new AgentManager(world, null, { clock: () => now });
    const session = liveSession('returning');

    manager.handleWebSocketMessage({ sessions: [session] });
    const villager = world.agents.get(session.sessionId);
    const position = villager.position;
    const appearance = villager.appearance;
    manager.handleWebSocketMessage({ sessions: [] });

    now += DEPARTED_AGENT_GRACE_MS / 2;
    manager.handleWebSocketMessage({ sessions: [session] });

    assert.equal(world.agents.size, 1);
    assert.strictEqual(world.agents.get(session.sessionId), villager);
    assert.strictEqual(villager.position, position);
    assert.deepEqual(villager.appearance, appearance);
    assert.equal(villager.isDeparted, false);
    assert.equal(villager.departedAt, null);
    assert.equal(villager.status, AgentStatus.WORKING);
});

test('departed retention evicts the oldest villagers first at a fixed cap', () => {
    let now = 10_000;
    const world = new World();
    const manager = new AgentManager(world, null, { clock: () => now });

    for (let index = 0; index <= MAX_DEPARTED_AGENTS; index++) {
        const session = liveSession(`churn-${String(index).padStart(3, '0')}`);
        manager.handleWebSocketMessage({ sessions: [session] });
        manager.handleWebSocketMessage({ sessions: [] });
        now += 1;
    }

    assert.equal(world.agents.size, MAX_DEPARTED_AGENTS);
    assert.equal(world.agents.has('churn-000'), false);
    assert.equal(world.agents.has(`churn-${String(MAX_DEPARTED_AGENTS).padStart(3, '0')}`), true);
});

test('the grace expires on its own clock, without another WebSocket update', async () => {
    // The server stops broadcasting once nothing changes, which is exactly the
    // moment the last villager departs. Without a wall-clock sweep the ghost
    // stands in the village until the page reloads.
    let now = 20_000;
    const world = new World();
    const manager = new AgentManager(world, null, { clock: () => now });

    manager.handleWebSocketMessage({ sessions: [liveSession('last-one')] });
    manager.handleWebSocketMessage({ sessions: [] });
    assert.equal(world.agents.get('last-one').isDeparted, true);

    const removed = [];
    const unsubscribe = eventBus.on('agent:removed', agent => removed.push(agent.id));
    try {
        manager.startDepartureSweep({ intervalMs: 5 });
        now += DEPARTED_AGENT_GRACE_MS;
        await new Promise(resolve => setTimeout(resolve, 40));
    } finally {
        manager.stop();
        unsubscribe();
    }

    assert.equal(world.agents.size, 0);
    // agent:removed is what walks the villager out through the village gate.
    assert.deepEqual(removed, ['last-one']);
});

test('the sweep never departs a villager the roster has not dropped', async () => {
    let now = 30_000;
    const world = new World();
    const manager = new AgentManager(world, null, { clock: () => now });

    manager.handleWebSocketMessage({ sessions: [liveSession('busy')] });
    try {
        manager.startDepartureSweep({ intervalMs: 5 });
        now += DEPARTED_AGENT_GRACE_MS * 2;
        await new Promise(resolve => setTimeout(resolve, 40));
    } finally {
        manager.stop();
    }

    assert.equal(world.agents.size, 1);
    assert.equal(world.agents.get('busy').isDeparted, false);
});

test('EN-8: a poisoned session skips only itself; later sessions and the departure sweep still run', () => {
    let now = 50_000;
    const world = new World();
    const manager = new AgentManager(world, null, { clock: () => now });
    manager.handleWebSocketMessage({ sessions: [liveSession('first'), liveSession('leaving'), liveSession('last')] });
    assert.equal(world.agents.size, 3);

    const warnings = [];
    const warn = console.warn;
    console.warn = (...args) => warnings.push(args.join(' '));
    try {
        const poisoned = { ...liveSession('poisoned'), sessionId: null };
        now += 1_000;
        manager.handleWebSocketMessage({
            sessions: [liveSession('first'), poisoned, null, { ...liveSession('last'), lastTool: 'Edit' }, liveSession('new')],
        });
        assert.equal(world.agents.has('new'), true, 'a session after the poisoned one still arrives');
        assert.equal(world.agents.get('leaving').isDeparted, true, 'the departure sweep still runs');
        assert.equal(world.agents.get('first').isDeparted, false);
        assert.equal(world.agents.get('last').isDeparted, false);
        assert.equal(manager.ingestErrors, 2);
        assert.equal(warnings.length, 1);

        // A session that stays malformed warns at most once a minute.
        now += 1_000;
        manager.handleWebSocketMessage({ sessions: [liveSession('first'), null, liveSession('last'), liveSession('new')] });
        assert.equal(manager.ingestErrors, 3);
        assert.equal(warnings.length, 1);
        now += 60_000;
        manager.handleWebSocketMessage({ sessions: [liveSession('first'), null, liveSession('last'), liveSession('new')] });
        assert.equal(warnings.length, 2);
    } finally {
        console.warn = warn;
    }
});
