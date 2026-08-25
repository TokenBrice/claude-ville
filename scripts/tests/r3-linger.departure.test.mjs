import test from 'node:test';
import assert from 'node:assert/strict';

import {
    AgentManager,
    DEPARTED_AGENT_GRACE_MS,
    MAX_DEPARTED_AGENTS,
} from '../../claudeville/src/application/AgentManager.js';
import { isAttentionStatus } from '../../claudeville/src/domain/services/StatusResolver.js';
import { World } from '../../claudeville/src/domain/entities/World.js';
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
