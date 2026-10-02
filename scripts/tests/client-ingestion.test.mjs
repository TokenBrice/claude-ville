import test from 'node:test';
import assert from 'node:assert/strict';

import { AgentManager, DEPARTED_AGENT_GRACE_MS } from '../../claudeville/src/application/AgentManager.js';
import { World } from '../../claudeville/src/domain/entities/World.js';
import { eventBus } from '../../claudeville/src/domain/events/DomainEvent.js';
import { VERIFIED_OUTCOME_EVENT } from '../../claudeville/src/domain/services/VerifiedOutcome.js';

const START = 1_800_000_000_000;
const changes = (sessionIds = [], shared = false, order = false) => ({ sessionIds, shared, order });
const resident = (sessionId, extra = {}) => ({
    sessionId, agentId: sessionId, name: sessionId, provider: 'claude',
    project: '/fixture/project', model: 'claude-sonnet-4-5', turnState: 'working',
    lastActivity: START, lastTool: 'Read', tokenUsage: { input: 12, output: 4 },
    ...extra,
});

function sequence() {
    const a = resident('alpha', { gitEvents: ['future'] });
    const b = resident('beta');
    const c = resident('gamma');
    const shared = {
        teams: [], collisions: [], gitEventFields: [], gitEventStringTables: [],
        gitEventsById: { future: {
            id: 'future', type: 'commit', success: true, ts: START + 2_000,
            project: '/fixture/project',
        } },
    };
    const bChanged = { ...b, tokenUsage: { input: 24, output: 8 }, taskProgress: { done: 1, total: 2, source: 'exact' } };
    const aFresh = { ...a, freshness: { source: 'transcript', observedAt: START + 3_000 } };
    const team = [{ name: 'crew', members: [{ agentId: 'alpha', name: 'Ada', model: 'claude-opus-4-5', agentType: 'main' }] }];
    const collision = [{ agents: ['alpha', 'gamma'], project: '/fixture/project', path: 'src/shared.js', kind: 'write-write' }];
    const afterDeparture = START + 5_000 + DEPARTED_AGENT_GRACE_MS + 1;
    return [
        { at: START, data: { ...shared, sessions: [a, b, c] } },
        { at: START + 1_000, data: { ...shared, sessions: [a, bChanged, c], changes: changes(['beta']) } },
        // The alpha event becomes live without alpha changing on the wire.
        { at: START + 2_000, data: { ...shared, sessions: [a, bChanged, c], changes: changes() } },
        { at: START + 3_000, data: { ...shared, sessions: [aFresh, bChanged, c], changes: changes(['alpha']) } },
        { at: START + 4_000, data: { ...shared, teams: team, collisions: collision, sessions: [c, aFresh, bChanged], changes: changes([], true, true) } },
        { at: START + 5_000, data: { ...shared, teams: team, collisions: collision, sessions: [c, aFresh], changes: changes(['beta'], false, true) } },
        { at: afterDeparture, data: { ...shared, teams: team, collisions: collision, sessions: [aFresh, c], changes: changes([], false, true) } },
        { at: afterDeparture + 1_000, data: { ...shared, sessions: [bChanged, aFresh, c], changes: changes(['beta'], true, true) } },
        // A full snapshot carries no changed-id optimization metadata.
        { at: afterDeparture + 2_000, data: { ...shared, sessions: [bChanged, aFresh, c] } },
    ];
}

function replay(rows, selective) {
    let now = START;
    Date.now = () => now;
    const world = new World();
    const manager = new AgentManager(world, null, { clock: () => now });
    const outcomes = [];
    const transitions = [];
    const snapshots = [];
    const off = eventBus.on(VERIFIED_OUTCOME_EVENT, outcome => outcomes.push({ ...outcome }));
    const offTransitions = eventBus.on('agent:updated', agent => transitions.push({
        id: agent.id, status: agent.status, currentTool: agent.currentTool, at: now,
    }));
    try {
        for (const row of rows) {
            now = row.at;
            const data = structuredClone(row.data);
            if (!selective) delete data.changes;
            manager.handleWebSocketMessage(data);
            snapshots.push({
                agents: JSON.parse(JSON.stringify([...world.agents.entries()])),
                stats: world.getStats(),
                speech: [...world.agents.values()].map(agent => ({ id: agent.id, speech: agent.speech(now) })),
                outcomes: structuredClone(outcomes),
                transitions: structuredClone(transitions),
            });
        }
        return snapshots;
    } finally {
        off();
        offTransitions();
        manager.stop();
    }
}

test('changed-id ingestion matches full World state, verified outcomes, freshness and lastActive ticks', () => {
    const previousNow = Date.now;
    const previousRandom = Math.random;
    Math.random = () => 0.5;
    try {
        const rows = sequence();
        const full = replay(rows, false);
        const selective = replay(rows, true);
        assert.deepEqual(selective, full);
        assert.deepEqual(selective[0].outcomes, []);
        assert.deepEqual(selective[2].outcomes, [{
            kind: 'commit', project: '/fixture/project', agentId: 'alpha', at: START + 2_000,
        }]);
        assert.deepEqual(selective.at(-1).outcomes, selective[2].outcomes);
        const find = (step, id) => selective[step].agents.find(([key]) => key === id)?.[1];
        assert.equal(find(1, 'alpha').lastActive, START + 1_000);
        assert.equal(find(2, 'gamma').lastActive, START + 2_000);
        assert.equal(find(2, 'gamma').activityAgeMs, 2_000);
        assert.equal(find(3, 'alpha').freshness.observedAt, START + 3_000);
        assert.equal(find(4, 'alpha').name, 'Ada');
        assert.equal(find(4, 'alpha').model, 'claude-opus-4-5');
        assert.equal(find(4, 'gamma').collisions[0].path, 'src/shared.js');
        assert.equal(find(5, 'beta').departedAt, START + 5_000);
        assert.equal(find(5, 'gamma').departedAt, null);
        assert.equal(find(6, 'beta'), undefined);
        assert.equal(find(7, 'beta').departedAt, null);
    } finally {
        Date.now = previousNow;
        Math.random = previousRandom;
    }
});

test('untouched sessions match full status, tool, dialogue and outcome transitions at clock boundaries', () => {
    const previousNow = Date.now;
    const previousRandom = Math.random;
    Math.random = () => 0.5;
    try {
        const question = resident('question', {
            status: 'active', turnState: 'unknown', lastActivity: START - 30_000,
            lastMessage: 'May I continue?',
            dialogue: { text: 'May I continue?', kind: 'assistant', observedAt: START - 90_001 },
        });
        const sessions = [
            resident('aging', { status: 'active', turnState: 'unknown', lastToolInput: 'src/aging.js' }),
            resident('untyped', { status: 'active', turnState: undefined }),
            resident('limited', { status: 'active', turnState: 'unknown', rateLimit: { enforced: true } }),
            resident('no-activity', { status: 'active', turnState: 'unknown', lastActivity: null }),
            resident('failed', {
                lastToolInput: 'src/failed.js',
                gitEvents: [{ id: 'failed', type: 'commit', success: false, ts: START }],
            }),
            resident('completed-failure', {
                turnState: 'awaiting_input',
                gitEvents: [{ id: 'completed-failure', type: 'push', status: 'failed', completedAt: START - 10_000, ts: START }],
            }),
            resident('future', { gitEvents: [{ id: 'future', type: 'push', success: true, ts: START + 5_000 }] }),
            resident('expired', { gitEvents: [{ id: 'expired', type: 'commit', success: true, ts: START - 10_000 }] }),
            resident('untimed', { gitEvents: [{ id: 'untimed', type: 'commit', success: true }] }),
            question,
        ];
        const offsets = [
            0, 1, 4_999, 5_000, 14_999, 15_000, 29_999, 30_000,
            49_999, 50_000, 50_001, 59_999, 60_000, 60_001, 89_999, 90_000, 119_999, 120_000,
        ];
        const withoutQuestion = sessions.map(session => session === question ? { ...question, dialogue: null } : session);
        const rows = offsets.map((offset, index) => ({
            at: START + offset,
            data: {
                sessions: index ? withoutQuestion : sessions,
                ...(index ? { changes: changes(index === 1 ? ['question'] : []) } : {}),
            },
        }));
        const full = replay(rows, false);
        const selective = replay(rows, true);
        assert.deepEqual(selective, full);
        const snapshotAt = offset => selective[offsets.indexOf(offset)];
        const agentAt = (offset, id) => snapshotAt(offset).agents.find(([key]) => key === id)[1];
        const speechAt = (offset, id) => snapshotAt(offset).speech.find(row => row.id === id).speech;
        assert.equal(agentAt(29_999, 'aging').status, 'working');
        assert.equal(agentAt(29_999, 'aging').currentToolInput, 'src/aging.js');
        assert.equal(agentAt(30_000, 'aging').status, 'waiting');
        assert.equal(agentAt(30_000, 'aging').currentTool, null);
        assert.equal(agentAt(30_000, 'aging').currentToolInput, null);
        assert.equal(agentAt(119_999, 'aging').status, 'waiting');
        assert.equal(agentAt(120_000, 'aging').status, 'idle');
        assert.equal(agentAt(29_999, 'untyped').status, 'working');
        assert.equal(agentAt(30_000, 'untyped').status, 'waiting');
        assert.equal(agentAt(120_000, 'untyped').status, 'idle');
        assert.equal(agentAt(29_999, 'limited').status, 'rate_limited');
        assert.equal(agentAt(30_000, 'limited').status, 'waiting');
        assert.equal(agentAt(120_000, 'limited').status, 'idle');
        assert.equal(agentAt(1, 'no-activity').activityAgeMs, null);
        assert.equal(agentAt(1, 'no-activity').status, 'idle');
        assert.equal(agentAt(60_000, 'failed').status, 'errored');
        assert.equal(agentAt(60_001, 'failed').status, 'working');
        assert.equal(agentAt(60_001, 'failed').currentTool, 'Read');
        assert.equal(agentAt(60_001, 'failed').currentToolInput, 'src/failed.js');
        assert.equal(agentAt(50_000, 'completed-failure').status, 'errored');
        assert.equal(agentAt(50_001, 'completed-failure').status, 'completed');
        assert.deepEqual(agentAt(1, 'question').dialogue, question.dialogue);
        assert.equal(agentAt(89_999, 'question').status, 'waiting_on_user');
        assert.equal(speechAt(89_999, 'question').held, true);
        assert.equal(agentAt(90_000, 'question').status, 'idle');
        assert.equal(agentAt(90_000, 'question').dialogue, null);
        assert.equal(speechAt(90_000, 'question'), null);
        const outcomesFor = (offset, id) => snapshotAt(offset).outcomes.filter(outcome => outcome.agentId === id);
        assert.deepEqual(outcomesFor(4_999, 'future'), []);
        assert.deepEqual(outcomesFor(5_000, 'future'), [{
            kind: 'push', project: '/fixture/project', agentId: 'future', at: START + 5_000,
        }]);
        assert.deepEqual(outcomesFor(120_000, 'future'), outcomesFor(5_000, 'future'));
        assert.deepEqual(outcomesFor(120_000, 'expired'), []);
        assert.deepEqual(outcomesFor(120_000, 'untimed').map(outcome => outcome.at), offsets.map(offset => START + offset));
        const agingUpdates = selective.at(-1).transitions.filter(row => row.id === 'aging');
        assert.deepEqual(agingUpdates
            .filter((row, index) => !index || row.status !== agingUpdates[index - 1].status)
            .map(row => [row.status, row.at]), [
            ['waiting', START + 30_000],
            ['idle', START + 120_000],
        ]);
        assert.equal(agentAt(14_999, 'future').lastActive, START + 14_999);
        assert.equal(agentAt(15_000, 'future').lastActive, START + 15_000);
    } finally {
        Date.now = previousNow;
        Math.random = previousRandom;
    }
});

test('shared git-wire changes refresh referenced events and outcomes for every session', () => {
    const previousNow = Date.now;
    const previousRandom = Math.random;
    Date.now = () => START;
    Math.random = () => 0.5;
    const world = new World();
    const manager = new AgentManager(world, null, { clock: () => START });
    const outcomes = [];
    const off = eventBus.on(VERIFIED_OUTCOME_EVENT, outcome => outcomes.push(outcome));
    try {
        const sessions = [resident('alpha', { gitEvents: ['commit'] }), resident('beta', { gitEvents: ['commit'] })];
        manager.handleWebSocketMessage({ sessions, gitEventsById: {}, teams: [] });
        manager.handleWebSocketMessage({
            sessions, changes: changes([], true),
            gitEventsById: { commit: { id: 'commit', type: 'push', success: true, ts: START } },
        });
        assert.deepEqual(outcomes.map(outcome => [outcome.kind, outcome.agentId]), [['push', 'alpha'], ['push', 'beta']]);
        assert.equal(world.agents.get('alpha').gitEvents[0].type, 'push');
        assert.equal(world.agents.get('beta').gitEvents[0].type, 'push');
    } finally {
        off();
        manager.stop();
        Date.now = previousNow;
        Math.random = previousRandom;
    }
});
