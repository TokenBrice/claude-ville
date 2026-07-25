// Status resolution: turn state in, AgentStatus out.
//
// Pins the priority order and, more importantly, the two regressions this
// layer exists to prevent — a long-running tool decaying to WAITING, and a
// finished turn never producing COMPLETED.

import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveAgentStatus, isAttentionStatus } from '../../claudeville/src/domain/services/StatusResolver.js';
import { AgentStatus } from '../../claudeville/src/domain/value-objects/AgentStatus.js';

const NOW = 1_700_000_000_000;
const fresh = { status: 'active', lastActivity: NOW - 1000 };
const stale = { status: 'active', lastActivity: NOW - 10 * 60_000 };

const at = (session) => resolveAgentStatus(session, { now: NOW });

test('a closed turn resolves to COMPLETED even after the file goes quiet', () => {
    assert.equal(at({ ...stale, turnState: 'awaiting_input' }), AgentStatus.COMPLETED);
});

test('a running tool stays WORKING however long it takes', () => {
    // The old model timed file mtime, so a four-minute build looked like an
    // idle agent. Nothing writes to the transcript while a tool runs.
    assert.equal(at({ ...stale, turnState: 'tool_pending', pendingTool: 'Bash' }), AgentStatus.WORKING);
});

test('a blocked tool resolves to WAITING_ON_USER', () => {
    assert.equal(
        at({ ...stale, turnState: 'tool_pending', pendingTool: 'Edit', waitReason: 'approval' }),
        AgentStatus.WAITING_ON_USER,
    );
});

test('rate limiting outranks everything for a busy agent', () => {
    const usage = { quota: { fiveHour: 0.99 } };
    const status = resolveAgentStatus(
        { ...fresh, turnState: 'tool_pending', pendingTool: 'Bash' },
        { usage, now: NOW },
    );
    assert.equal(status, AgentStatus.RATE_LIMITED);
});

test('a quiet finished agent is not reported as rate limited', () => {
    // Quota pressure describes work in flight; an agent that already handed
    // back control is not the thing being throttled.
    const usage = { quota: { fiveHour: 0.99 } };
    const status = resolveAgentStatus({ ...stale, turnState: 'awaiting_input' }, { usage, now: NOW });
    assert.equal(status, AgentStatus.COMPLETED);
});

test('a recent failed git event resolves to ERRORED over the turn state', () => {
    const status = at({
        ...fresh,
        turnState: 'awaiting_input',
        gitEvents: [{ success: false, completedAt: NOW - 5_000 }],
    });
    assert.equal(status, AgentStatus.ERRORED);
});

test('an old failed git event is not held against the agent', () => {
    const status = at({
        ...fresh,
        turnState: 'working',
        gitEvents: [{ success: false, completedAt: NOW - 10 * 60_000 }],
    });
    assert.equal(status, AgentStatus.WORKING);
});

test('providers without turn state fall back to activity timing', () => {
    assert.equal(at({ ...fresh, turnState: 'unknown' }), AgentStatus.WORKING);
    assert.equal(at({ status: 'active', lastActivity: NOW - 60_000, turnState: 'unknown' }), AgentStatus.WAITING);
    assert.equal(at({ ...stale, turnState: 'unknown' }), AgentStatus.IDLE);
});

test('the ask-tool fallback still works without a turn state', () => {
    const status = at({ ...fresh, turnState: 'unknown', lastTool: 'AskUserQuestion' });
    assert.equal(status, AgentStatus.WAITING_ON_USER);
});

test('attention covers the three states that need a person', () => {
    assert.equal(isAttentionStatus(AgentStatus.WAITING_ON_USER), true);
    assert.equal(isAttentionStatus(AgentStatus.ERRORED), true);
    assert.equal(isAttentionStatus(AgentStatus.RATE_LIMITED), true);
    assert.equal(isAttentionStatus(AgentStatus.COMPLETED), false);
    assert.equal(isAttentionStatus(AgentStatus.WORKING), false);
});
