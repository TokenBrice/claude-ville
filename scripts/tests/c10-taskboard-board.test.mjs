import test from 'node:test';
import assert from 'node:assert/strict';

import {
    resolveTaskboardAgent,
    taskboardBoardRows,
} from '../../claudeville/src/presentation/character-mode/TaskboardBoardModel.js';

function sprite(agent) {
    return { agent };
}

test('taskboard resolution follows candidate order and skips agents without truthful rows', () => {
    const selected = { id: 'selected', todos: [{ subject: 'Selected work', status: 'pending' }] };
    const firstPin = { id: 'first-pin', todos: [{ subject: 'Pinned work', status: 'in_progress' }] };
    const secondPin = { id: 'second-pin', todos: [{ subject: 'Fallback work', status: 'pending' }] };
    const sprites = new Map([
        ['selected', sprite(selected)],
        ['empty', sprite({ id: 'empty', todos: [] })],
        ['departed', sprite({ id: 'departed', isDeparted: true, todos: [{ subject: 'Old', status: 'pending' }] })],
        ['first-pin', sprite(firstPin)],
        ['second-pin', sprite(secondPin)],
    ]);

    assert.equal(resolveTaskboardAgent({
        candidates: ['selected', 'first-pin', 'second-pin'],
        agentSprites: sprites,
    }), selected);
    assert.equal(resolveTaskboardAgent({
        candidates: ['missing', 'departed', 'empty', 'first-pin', 'second-pin'],
        agentSprites: sprites,
    }), firstPin);
    assert.equal(resolveTaskboardAgent({
        candidates: ['missing', 'first-pin'],
        agentSprites: [...sprites.values()],
    }), firstPin);
    assert.equal(resolveTaskboardAgent({
        candidates: ['missing', 'departed', 'empty'],
        agentSprites: sprites,
    }), null);
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
