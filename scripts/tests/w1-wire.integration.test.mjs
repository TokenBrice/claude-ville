import test from 'node:test';
import assert from 'node:assert/strict';

import { AttentionService } from '../../claudeville/src/application/AttentionService.js';
import { World } from '../../claudeville/src/domain/entities/World.js';
import {
    ACTIONABLE_BUCKETS,
    bucketCounts,
    bucketForStatus,
} from '../../claudeville/src/domain/services/SignalLedger.js';
import { isAttentionStatus } from '../../claudeville/src/domain/services/StatusResolver.js';
import { AgentStatus } from '../../claudeville/src/domain/value-objects/AgentStatus.js';
import { sectionHealthCounts } from '../../claudeville/src/presentation/dashboard-mode/DashboardRenderer.js';
import { operatorStatusLabel, sortAttentionAgents } from '../../claudeville/src/presentation/shared/SemanticTriage.js';
import { attentionSegmentDescriptors } from '../../claudeville/src/presentation/shared/TopBar.js';

const FIXTURE = Object.freeze([
    fixtureAgent('working', AgentStatus.WORKING, 700, 1),
    fixtureAgent('idle', AgentStatus.IDLE, 600, 2),
    fixtureAgent('waiting', AgentStatus.WAITING, 50, 3),
    fixtureAgent('completed', AgentStatus.COMPLETED, 500, 4),
    fixtureAgent('quota', AgentStatus.RATE_LIMITED, 100, 5),
    fixtureAgent('error', AgentStatus.ERRORED, 200, 6),
    fixtureAgent('needs-you', AgentStatus.WAITING_ON_USER, 300, 7),
]);

function fixtureAgent(id, status, awaitingSince, inputTokens) {
    return Object.freeze({
        id,
        name: id,
        status,
        awaitingSince,
        lastSessionActivity: awaitingSince,
        tokens: Object.freeze({
            input: inputTokens,
            output: 0,
            cacheRead: 0,
            cacheCreate: 0,
        }),
        cost: inputTokens,
    });
}

function fixtureWorld() {
    const world = new World();
    world.agents = new Map(FIXTURE.map(agent => [agent.id, agent]));
    return world;
}

function keyedSegments(stats) {
    return Object.fromEntries(
        attentionSegmentDescriptors(stats).map(segment => [segment.key, segment.count]),
    );
}

test('Wave 1 consumers agree on one seven-status partition', () => {
    const world = fixtureWorld();
    const ledger = bucketCounts(FIXTURE);
    const stats = world.getStats();
    const dashboard = sectionHealthCounts(FIXTURE);
    const topBar = keyedSegments(stats);

    assert.deepEqual(
        {
            needsYou: stats.needsYou,
            errors: stats.errors,
            quota: stats.quota,
            watchlist: stats.watchlist,
        },
        {
            needsYou: ledger.needsYou,
            errors: ledger.errors,
            quota: ledger.quota,
            watchlist: ledger.watchlist,
        },
        'World must expose the ledger partition without reclassifying statuses',
    );

    assert.equal(stats.attention, stats.needsYou + stats.errors + stats.quota);
    assert.equal(stats.attention, 3, 'errored must be included with blocked and quota statuses');
    assert.equal(stats.errors, 1, 'the errored agent must remain visible in the actionable total');

    assert.deepEqual(dashboard, {
        errors: ledger.errors,
        needsYou: ledger.needsYou,
        quota: ledger.quota,
        working: ledger.working,
        watchlist: ledger.watchlist,
        idle: ledger.quiet,
    });
    assert.equal(dashboard.errors, 1, 'blocked and rate-limited work must not count as errors');

    assert.deepEqual(topBar, {
        needsYou: ledger.needsYou,
        errors: ledger.errors,
        quota: ledger.quota,
        watchlist: ledger.watchlist,
    });
    assert.deepEqual(Object.keys(topBar), ['needsYou', 'errors', 'quota', 'watchlist']);
});

test('attention membership and traversal agree across the ledger and resolver', () => {
    const world = fixtureWorld();
    const expected = FIXTURE
        .filter(agent => isAttentionStatus(agent.status))
        .sort((a, b) => a.awaitingSince - b.awaitingSince)
        .map(agent => agent.id);
    const listed = AttentionService.prototype.list.call({ world }).map(agent => agent.id);

    assert.deepEqual(listed, expected);
    assert.deepEqual(listed, ['quota', 'error', 'needs-you'], 'traversal must be longest-waiting first');
    assert.equal(listed.includes('waiting'), false, 'generic waiting must not enter attention traversal');

    const semanticOrder = sortAttentionAgents(
        FIXTURE.filter(agent => isAttentionStatus(agent.status)),
    ).map(agent => agent.id);
    assert.deepEqual(
        new Set(semanticOrder),
        new Set(expected),
        'semantic urgency sorting must preserve the same actionable membership',
    );
    assert.deepEqual(
        semanticOrder,
        ['needs-you', 'error', 'quota'],
        'semantic display precedence is distinct from age-based attention traversal',
    );
});

test('generic waiting remains watchlist-only on every classification surface', () => {
    const waitingAgent = FIXTURE.find(agent => agent.status === AgentStatus.WAITING);
    const waitingLedger = bucketCounts([waitingAgent]);
    const waitingWorld = new World();
    waitingWorld.agents = new Map([[waitingAgent.id, waitingAgent]]);
    const waitingDashboard = sectionHealthCounts([waitingAgent]);
    const waitingTopBar = keyedSegments(waitingLedger);

    assert.equal(ACTIONABLE_BUCKETS.includes(bucketForStatus(waitingAgent.status)), false);
    assert.equal(isAttentionStatus(waitingAgent.status), false);
    assert.equal(waitingWorld.getStats().attention, 0);
    assert.equal(AttentionService.prototype.list.call({ world: waitingWorld }).length, 0);
    assert.deepEqual(waitingDashboard, {
        errors: 0,
        needsYou: 0,
        quota: 0,
        working: 0,
        watchlist: 1,
        idle: 0,
    });
    assert.deepEqual(waitingTopBar, {
        needsYou: 0,
        errors: 0,
        quota: 0,
        watchlist: 1,
    });
});

test('operator labels distinguish every actionable status and generic waiting', () => {
    const statuses = [
        AgentStatus.ERRORED,
        AgentStatus.RATE_LIMITED,
        AgentStatus.WAITING_ON_USER,
        AgentStatus.WAITING,
    ];
    const labels = statuses.map(operatorStatusLabel);

    assert.equal(new Set(labels).size, statuses.length, 'no actionable state may share an operator label');
    assert.deepEqual(labels, ['Errored', 'Waiting — quota', 'Needs you', 'Waiting']);
});

test('World preserves every pre-Wave 1 stats key and its original meaning', () => {
    const stats = fixtureWorld().getStats();
    const legacy = {
        working: 1,
        idle: 1,
        waiting: 1,
        errored: 1,
        attention: 3,
        total: 7,
        totalTokens: 28,
        totalCost: 28,
    };

    for (const [key, value] of Object.entries(legacy)) {
        assert.equal(Object.hasOwn(stats, key), true, `missing legacy stats key: ${key}`);
        assert.equal(stats[key], value, `changed legacy meaning for: ${key}`);
    }
});
