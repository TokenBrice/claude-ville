import test from 'node:test';
import assert from 'node:assert/strict';

import {
    initialVillageState,
    LinkState,
    linkDown,
    reduceVillageState,
    VillagePhase,
} from '../../claudeville/src/application/VillageState.js';
import { World } from '../../claudeville/src/domain/entities/World.js';
import { AgentStatus } from '../../claudeville/src/domain/value-objects/AgentStatus.js';
import { connectionChip } from '../../claudeville/src/presentation/shared/TopBar.js';

function villageAfter(actions) {
    return actions.reduce((state, action) => reduceVillageState(state, action), initialVillageState());
}

const HEALTHY = { type: 'providers', providers: [{ id: 'claude', health: 'healthy', sessions: 3 }] };

function agent(id, status, { departed = false } = {}) {
    return { id, status, isDeparted: departed, tokens: {}, cost: 0 };
}

function worldOf(agents) {
    const world = new World();
    for (const entry of agents) world.agents.set(entry.id, entry);
    return world;
}

test('the top-bar KPIs sum to the agent count, completed counted as idle (UI-1, Q4)', () => {
    const world = worldOf([
        agent('w1', AgentStatus.WORKING),
        agent('w2', AgentStatus.WORKING),
        agent('i1', AgentStatus.IDLE),
        agent('c1', AgentStatus.COMPLETED),
        agent('c2', AgentStatus.COMPLETED),
        agent('q1', AgentStatus.WAITING),
        agent('n1', AgentStatus.WAITING_ON_USER),
        agent('e1', AgentStatus.ERRORED),
        agent('l1', AgentStatus.RATE_LIMITED),
    ]);
    const stats = world.getStats();
    assert.deepEqual(
        { working: stats.working, idle: stats.idle, waiting: stats.waiting, attention: stats.attention, total: stats.total },
        { working: 2, idle: 3, waiting: 1, attention: 3, total: 9 },
    );
    assert.equal(stats.working + stats.idle + stats.waiting + stats.attention, stats.total);
});

test('a departed villager is in neither the idle count nor the total', () => {
    const world = worldOf([
        agent('w1', AgentStatus.WORKING),
        agent('c1', AgentStatus.COMPLETED),
        agent('gone', AgentStatus.COMPLETED, { departed: true }),
    ]);
    const stats = world.getStats();
    assert.equal(stats.idle, 1);
    assert.equal(stats.total, 2);
    assert.equal(stats.working + stats.idle + stats.waiting + stats.attention, stats.total);
});

test('getStats no longer carries the dead lifetime totals (UI-14)', () => {
    const stats = worldOf([agent('w1', AgentStatus.WORKING)]).getStats();
    assert.equal('totalCost' in stats, false);
    assert.equal('totalTokens' in stats, false);
});

test('a server outage reads RECONNECTING n, not DEGRADED (EN-1)', () => {
    const state = villageAfter([
        HEALTHY,
        { type: 'snapshot', source: 'websocket', agentCount: 3, at: 1_000 },
        // The REST fallback fails first, then the socket starts retrying.
        { type: 'source-failed', code: 'session-poll-failed' },
        { type: 'link', state: LinkState.RECONNECTING, attempts: 4, nextRetryAt: 9_000, lastErrorCode: 'socket-closed' },
    ]);
    assert.equal(state.phase, VillagePhase.DEGRADED);
    assert.equal(linkDown(state, 2_000), true);
    assert.deepEqual(connectionChip(state, 2_000), { label: 'RECONNECTING 4', state: LinkState.RECONNECTING, stale: false });
});

test('a silent link reads STALE with its age before DEGRADED (EN-1)', () => {
    const state = villageAfter([
        HEALTHY,
        { type: 'snapshot', source: 'polling', agentCount: 3, at: 1_000 },
        { type: 'source-failed', code: 'session-poll-failed' },
    ]);
    assert.equal(state.phase, VillagePhase.DEGRADED);
    const chip = connectionChip(state, 21_000);
    assert.equal(chip.label, 'STALE / last seen 20s ago');
    assert.equal(chip.state, LinkState.STALE);
    assert.equal(chip.stale, true);
});

test('a provider that cannot be read behind a live link still reads DEGRADED', () => {
    const state = villageAfter([
        { type: 'providers', providers: [{ id: 'codex', health: 'degraded' }] },
        { type: 'snapshot', source: 'websocket', agentCount: 2, at: 1_000 },
        { type: 'link', state: LinkState.LIVE },
    ]);
    assert.equal(state.phase, VillagePhase.DEGRADED);
    assert.equal(linkDown(state, 2_000), false);
    assert.equal(connectionChip(state, 2_000).label, 'DEGRADED');
});

test('the simulator never reads as a lost link', () => {
    const state = villageAfter([
        HEALTHY,
        { type: 'snapshot', source: 'simulator', agentCount: 3, at: 1_000 },
        { type: 'link', state: LinkState.RECONNECTING, attempts: 2 },
    ]);
    assert.equal(linkDown(state, 60_000), false);
});
