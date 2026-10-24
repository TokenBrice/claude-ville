// D8 — one small beat when a session's own explicit plan goes all-done.
import test from 'node:test';
import assert from 'node:assert/strict';

import { AgentManager } from '../../claudeville/src/application/AgentManager.js';
import { World } from '../../claudeville/src/domain/entities/World.js';
import { eventBus } from '../../claudeville/src/domain/events/DomainEvent.js';
import {
    AgentEventStream,
    explicitPlanProgress,
    planClosedBetween,
} from '../../claudeville/src/presentation/character-mode/AgentEventStream.js';
import { LandmarkActivity } from '../../claudeville/src/presentation/character-mode/LandmarkActivity.js';

const todo = (subject, status) => ({ subject, status });

test('only an explicit plan counts, and only an unfinished-to-done transition of three or more items', () => {
    assert.equal(explicitPlanProgress({ taskProgress: { done: 4, total: 4, source: 'inferred' } }), null);
    assert.deepEqual(
        { ...explicitPlanProgress({ taskProgress: { done: 2, total: 5, source: 'exact' } }), key: null },
        { done: 2, total: 5, source: 'exact', key: null },
    );
    const plan = explicitPlanProgress({ todos: [todo('a', 'completed'), todo('b', 'in_progress'), todo('c', 'pending')] });
    assert.equal(plan.done, 1);
    assert.equal(plan.total, 3);
    assert.equal(planClosedBetween({ done: 2, total: 3 }, { done: 3, total: 3 }), true);
    assert.equal(planClosedBetween({ done: 3, total: 3 }, { done: 3, total: 3 }), false, 'already done is not news');
    assert.equal(planClosedBetween({ done: 1, total: 2 }, { done: 2, total: 2 }), false, 'too small to be a plan');
    assert.equal(planClosedBetween({ done: 2, total: 3 }, { done: 3, total: 4 }), false);
});

function session(todos) {
    return {
        sessions: [{
            sessionId: 'planner', provider: 'claude', project: '/work/plans', status: 'active',
            turnState: 'working', lastActivity: Date.now(), lastTool: 'TodoWrite', todos,
        }],
    };
}

test('the stream emits plan:closed once, never on first sight, and the Task board seats one note', (t) => {
    const world = new World();
    const manager = new AgentManager(world, null);
    const stream = new AgentEventStream(world);
    const buildings = new Map([['taskboard', { position: { tileX: 10, tileY: 10 }, width: 4, height: 4, entrance: { tileX: 12, tileY: 13 } }]]);
    const activity = new LandmarkActivity({ world: { buildings } });
    const closed = [];
    const off = eventBus.on('plan:closed', event => closed.push(event));
    t.after(() => { off(); stream.dispose(); activity.dispose(); });

    // First sight of an already finished plan: a baseline, no beat.
    manager.handleWebSocketMessage(session([todo('a', 'completed'), todo('b', 'completed'), todo('c', 'completed')]));
    assert.equal(closed.length, 0);

    const subjects = ['read', 'edit', 'test'];
    manager.handleWebSocketMessage(session(subjects.map((s, i) => todo(s, i === 0 ? 'completed' : 'pending'))));
    manager.handleWebSocketMessage(session(subjects.map((s, i) => todo(s, i < 2 ? 'completed' : 'in_progress'))));
    assert.equal(closed.length, 0);
    manager.handleWebSocketMessage(session(subjects.map(s => todo(s, 'completed'))));
    assert.equal(closed.length, 1);
    assert.equal(closed[0].agentId, 'planner');
    assert.equal(closed[0].total, 3);

    const notes = [...activity.items.values()].filter(item => item.type === 'plan');
    assert.equal(notes.length, 1);
    assert.equal(notes[0].building, 'taskboard');
    assert.equal(notes[0].detail, 'closed');

    // Flipping back and closing the same plan again is not a second beat.
    manager.handleWebSocketMessage(session(subjects.map((s, i) => todo(s, i < 2 ? 'completed' : 'pending'))));
    manager.handleWebSocketMessage(session(subjects.map(s => todo(s, 'completed'))));
    assert.equal(closed.length, 1);
});
