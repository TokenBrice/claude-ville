// Status resolution: turn state in, AgentStatus out.
//
// Pins the priority order and, more importantly, the two regressions this
// layer exists to prevent — a long-running tool decaying to WAITING, and a
// finished turn never producing COMPLETED.

import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveAgentStatus, isAttentionStatus, quotaPressure } from '../../claudeville/src/domain/services/StatusResolver.js';
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

test('observed rate limiting raises attention for a busy agent', () => {
    const usage = { quota: { fiveHour: 0.99 } };
    const status = resolveAgentStatus(
        { ...fresh, turnState: 'tool_pending', pendingTool: 'Bash', rateLimit: { enforced: true } },
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

// WL-1 — a failure the agent already retried successfully is mended, not
// errored: a later successful event of the same kind supersedes it in the
// 60 s window, in either event order.
test('a failed git event superseded by a later success of the same kind is not ERRORED', () => {
    const failure = { type: 'push', success: false, completedAt: NOW - 20_000 };
    const success = { type: 'push', success: true, completedAt: NOW - 10_000 };
    for (const gitEvents of [[failure, success], [success, failure]]) {
        assert.equal(at({ ...fresh, turnState: 'working', gitEvents }), AgentStatus.WORKING);
        // Without the mend, the failure still escalates a closed turn.
    }
    const awaiting = at({ ...fresh, turnState: 'awaiting_input', gitEvents: [failure, success] });
    assert.equal(awaiting, AgentStatus.COMPLETED);
});

test('a failed git event with no later same-kind success stays ERRORED', () => {
    const failure = { type: 'push', success: false, completedAt: NOW - 20_000 };
    assert.equal(at({ ...fresh, turnState: 'working', gitEvents: [failure] }), AgentStatus.ERRORED);
    // A later success of another kind mends nothing.
    assert.equal(
        at({ ...fresh, turnState: 'working', gitEvents: [failure, { type: 'commit', success: true, completedAt: NOW - 10_000 }] }),
        AgentStatus.ERRORED,
    );
    // A success that predates the failure mends nothing either.
    assert.equal(
        at({ ...fresh, turnState: 'working', gitEvents: [{ type: 'push', success: true, completedAt: NOW - 30_000 }, failure] }),
        AgentStatus.ERRORED,
    );
    // The old escalation of a closed turn still holds for an unmended failure.
    assert.equal(
        at({ ...fresh, turnState: 'awaiting_input', gitEvents: [failure] }),
        AgentStatus.ERRORED,
    );
});

// WL-1, session ownership — repository enrichment appends other sessions'
// pushes (synthetic upstream transitions) to this session's event list; a
// newer success on another branch from another session is not this agent's
// retry and must not mend its failed push.
test('another session\'s later success does not mend this session\'s failed git event', () => {
    const failure = { type: 'push', sessionId: 'lane-a', success: false, completedAt: NOW - 20_000 };
    // The synthetic shape `transitionPushEvent` gives repository enrichment.
    const foreignSuccess = {
        type: 'push', sessionId: 'git-repo-x1', success: true, status: 'success',
        completedAt: NOW - 10_000, synthetic: 'transition', source: 'git-upstream-transition',
    };
    assert.equal(
        at({ ...fresh, turnState: 'working', gitEvents: [failure, foreignSuccess] }),
        AgentStatus.ERRORED,
    );
    // A plain success from another live session mends nothing either.
    assert.equal(
        at({ ...fresh, turnState: 'working', gitEvents: [failure, { ...foreignSuccess, sessionId: 'lane-b', synthetic: undefined }] }),
        AgentStatus.ERRORED,
    );
    // The session's own retry still mends.
    assert.equal(
        at({ ...fresh, turnState: 'working', gitEvents: [failure, { ...foreignSuccess, sessionId: 'lane-a' }] }),
        AgentStatus.WORKING,
    );
    // A success without a sessionId (legacy) keeps the same-kind rule.
    const legacy = { type: 'push', success: true, completedAt: NOW - 10_000 };
    assert.equal(at({ ...fresh, turnState: 'working', gitEvents: [failure, legacy] }), AgentStatus.WORKING);
    assert.equal(at({ ...fresh, turnState: 'working', gitEvents: [{ ...failure, sessionId: undefined }, legacy] }), AgentStatus.WORKING);
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

test('a question without turn state stays needs-you past the 2-minute WAITING window', () => {
    const question = { status: 'active', turnState: 'unknown', lastMessage: 'May I continue?' };
    assert.equal(at({ ...question, lastActivity: NOW - 60_000 }), AgentStatus.WAITING_ON_USER);
    assert.equal(at({ ...question, lastActivity: NOW - 121_000 }), AgentStatus.WAITING_ON_USER, 'silence is no answer');
    assert.equal(at({ ...question, lastActivity: NOW - 1_000 }), AgentStatus.WORKING, 'new activity is evidence');
    assert.equal(at({ ...question, lastMessage: 'Done.', lastActivity: NOW - 121_000 }), AgentStatus.IDLE);
});

test('PV-4b: a turn that ended on an API error is ERRORED until the next turn', () => {
    const apiError = { kind: 'server_error', status: 522, at: NOW - 5_000 };
    assert.equal(at({ ...fresh, turnState: 'awaiting_input', apiError }), AgentStatus.ERRORED);
    assert.equal(at({ ...fresh, turnState: 'working', apiError }), AgentStatus.WORKING, 'a retry is work');
    assert.equal(at({ ...fresh, turnState: 'awaiting_input', apiError: null }), AgentStatus.COMPLETED);
});

test('PV-6: a Codex question asked without blocking needs you while the agent works on', () => {
    const openQuestion = { since: NOW - 30_000, count: 1 };
    assert.equal(at({ ...fresh, provider: 'codex', turnState: 'working', openQuestion, waitReason: 'question' }), AgentStatus.WAITING_ON_USER);
    assert.equal(at({ ...fresh, provider: 'codex', turnState: 'awaiting_input', openQuestion }), AgentStatus.COMPLETED, 'the turn ended: your move');
    assert.equal(at({ ...fresh, provider: 'codex', turnState: 'working', openQuestion: null }), AgentStatus.WORKING);
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

test('Claude pressure never asserts enforcement or hides a question', () => {
    const usage = { quota: { provider: 'claude', fiveHour: .99 } };
    for (const provider of ['claude', 'codex', 'gemini', 'grok', 'kimi', 'omp', 'opencode']) {
        assert.equal(resolveAgentStatus({ ...fresh, provider, turnState: 'working' }, { usage, now: NOW }), AgentStatus.WORKING);
        assert.equal(resolveAgentStatus({ ...fresh, provider, turnState: 'tool_pending', waitReason: 'question', rateLimit: { enforced: true } }, { usage, now: NOW }), AgentStatus.WAITING_ON_USER);
    }
});

test('quota pressure and account enforcement are provider/account scoped', () => {
    const usage = { quota: { provider: 'claude', accountId: 'a', fiveHour: .99, enforced: true } };
    const session = { ...fresh, provider: 'claude', accountId: 'a', turnState: 'working' };
    assert.equal(quotaPressure(session, usage), .99);
    assert.equal(resolveAgentStatus(session, { usage, now: NOW }), AgentStatus.RATE_LIMITED);
    for (const other of [{ ...session, provider: 'codex' }, { ...session, accountId: 'b' }]) {
        assert.equal(quotaPressure(other, usage), null);
        assert.equal(resolveAgentStatus(other, { usage, now: NOW }), AgentStatus.WORKING);
    }
});
