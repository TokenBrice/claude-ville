import test from 'node:test';
import assert from 'node:assert/strict';

import {
    TaskboardBoardModel,
    taskboardBoardRows,
} from '../../claudeville/src/presentation/character-mode/TaskboardBoardModel.js';

function sprite(agent) {
    return { agent };
}

test('taskboard resolution prefers selected, then pinned, then the latest changed todos', () => {
    const selected = {
        id: 'selected',
        lastActive: 500,
        todos: [{ subject: 'Selected work', status: 'pending' }],
    };
    const pinned = {
        id: 'pinned',
        lastActive: 400,
        todos: [{ subject: 'Pinned work', status: 'in_progress' }],
    };
    const recent = {
        id: 'recent',
        lastActive: 200,
        todos: [{ subject: 'Recent work', status: 'pending' }],
    };
    const older = {
        id: 'older',
        lastActive: 100,
        todos: [{ subject: 'Older work', status: 'pending' }],
    };
    const empty = { id: 'empty', lastActive: 900, todos: [] };
    const sprites = new Map([
        ['selected', sprite(selected)],
        ['pinned', sprite(pinned)],
        ['recent', sprite(recent)],
        ['older', sprite(older)],
        ['empty', sprite(empty)],
    ]);
    const model = new TaskboardBoardModel();
    model.updateAgentSprites(sprites, 100);

    recent.todos = [{ subject: 'Most recently changed', status: 'in_progress' }];
    model.updateAgentSprites(sprites, 200);

    assert.equal(model.resolve({
        candidates: ['selected', 'pinned'],
        agentSprites: sprites,
    }), selected);
    assert.equal(model.resolve({
        candidates: ['empty', 'pinned'],
        agentSprites: sprites,
    }), pinned);
    assert.equal(model.resolve({
        candidates: ['empty'],
        agentSprites: sprites,
    }), recent);

    older.todos = [{ subject: 'Now newest', status: 'pending' }];
    model.updateAgentSprites(sprites, 300);
    model.updateAgentSprites(sprites, 400);
    assert.equal(model.resolve({ candidates: [], agentSprites: sprites }), older);
});

test('taskboard fallback breaks update ties by latest activity and returns null without todos', () => {
    const active = { id: 'active', lastActive: 200, todos: [{ subject: 'Active', status: 'pending' }] };
    const idle = { id: 'idle', lastActive: 100, todos: [{ subject: 'Idle', status: 'pending' }] };
    const model = new TaskboardBoardModel();
    const tied = [sprite(idle), sprite(active)];
    model.updateAgentSprites(tied, 100);

    assert.equal(model.resolve({ candidates: [], agentSprites: tied }), active);

    const empty = [sprite({ id: 'none', todos: [] })];
    model.updateAgentSprites(empty, 200);
    assert.equal(model.resolve({ candidates: [], agentSprites: empty }), null);
});

test('taskboard rows preserve provider order, overflow, and full subjects', () => {
    const todos = Array.from({ length: 9 }, (_, index) => ({
        subject: index === 2 ? 'A deliberately long provider-authored subject that drawing may measure later' : `row ${index}`,
        status: index === 0 ? 'completed' : index === 1 ? 'in_progress' : index === 3 ? 'unknown' : 'pending',
    }));
    const board = taskboardBoardRows(todos, { maxRows: 6 });

    assert.equal(board.rows.length, 6);
    assert.equal(board.overflow, 3);
    assert.equal(board.total, 9);
    assert.equal(board.done, 1);
    assert.deepEqual(board.rows.map(row => row.subject), todos.slice(0, 6).map(todo => todo.subject));
    assert.equal(board.rows[0].done, true);
    assert.equal(board.rows[1].done, false);
    assert.equal(board.rows[3].status, 'unknown');
    assert.equal(board.rows[3].done, false);
    assert.equal(board.rows[2].subject, todos[2].subject);
});

test('taskboard rows render nothing without provider todos and strike completed only', () => {
    assert.equal(taskboardBoardRows([]), null);
    assert.equal(taskboardBoardRows(null), null);
    const board = taskboardBoardRows([
        { subject: 'Exact completed', status: 'completed' },
        { subject: 'Similar but open', status: 'complete' },
        { subject: 'Unknown remains open', status: 'mystery' },
    ]);
    assert.deepEqual(board.rows.map(row => row.done), [true, false, false]);
    assert.equal(board.done, 1);
});
