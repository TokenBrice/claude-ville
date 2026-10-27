import test from 'node:test';
import assert from 'node:assert/strict';

import {
    LONG_TURN_MS,
    MOMENT_AGGREGATE_MS,
    OUTCOME_AGGREGATE_MS,
    OutcomeRouter,
    OutcomeTracker,
    failedPushFacts,
    toolFailedFact,
    toolResultOutcome,
    verifiedOutcomeFact,
} from '../../claudeville/src/application/OutcomeSignals.js';
import { pendingRepoSummariesFromDockSummaries } from '../../claudeville/src/presentation/character-mode/HarborTraffic.js';

// A deterministic clock and timer queue: `advance(ms)` fires due timers.
function fakeTime(start = 1_000_000) {
    let now = start;
    let nextId = 1;
    const timers = new Map();
    return {
        now: () => now,
        setTimer: (fn, ms) => {
            const id = nextId++;
            timers.set(id, { fn, at: now + ms });
            return id;
        },
        clearTimer: id => timers.delete(id),
        advance(ms) {
            const until = now + ms;
            for (;;) {
                const due = [...timers.entries()]
                    .filter(([, timer]) => timer.at <= until)
                    .sort((a, b) => a[1].at - b[1].at)[0];
                if (!due) break;
                timers.delete(due[0]);
                now = due[1].at;
                due[1].fn();
            }
            now = until;
        },
    };
}

function router(time, emitted) {
    return new OutcomeRouter({
        emit: outcome => emitted.push(outcome),
        now: time.now,
        setTimer: time.setTimer,
        clearTimer: time.clearTimer,
    });
}

function trackerWith(agentIds) {
    const present = new Set(agentIds);
    return new OutcomeTracker({ hasAgent: id => present.has(id), now: () => 1_000_000 });
}

const working = (id, extra = {}) => ({ id, status: 'working', turnStartedAt: 100, ...extra });

test('a long turn ending is one turn-done fact; a short one is chatter', () => {
    const tracker = trackerWith([]);
    tracker.added(working('long'));
    tracker.added(working('short'));
    assert.deepEqual(
        tracker.updated({ id: 'long', status: 'idle', turnStartedAt: 100, lastTurnDurationMs: 25_000 }),
        [{ kind: 'turnDone', agentId: 'long', durationMs: 25_000, long: false }],
    );
    assert.deepEqual(
        tracker.updated({ id: 'short', status: 'idle', turnStartedAt: 100, lastTurnDurationMs: 19_999 }),
        [],
    );
});

test('a turn of two minutes or more is a long turn, from any provider that reports its duration (SND-1)', () => {
    const tracker = trackerWith([]);
    tracker.added(working('claude', { provider: 'claude' }));
    tracker.added(working('codex', { provider: 'codex' }));
    tracker.added(working('almost'));
    const [claude] = tracker.updated({ id: 'claude', provider: 'claude', status: 'idle', turnStartedAt: 100, lastTurnDurationMs: LONG_TURN_MS });
    const [codex] = tracker.updated({ id: 'codex', provider: 'codex', status: 'waiting', turnStartedAt: 100, lastTurnDurationMs: 600_000 });
    const [almost] = tracker.updated({ id: 'almost', status: 'idle', turnStartedAt: 100, lastTurnDurationMs: LONG_TURN_MS - 1 });
    assert.equal(LONG_TURN_MS, 120_000);
    assert.equal(claude.long, true);
    assert.equal(codex.long, true);
    assert.equal(almost.long, false);
});

test('a batch of finished turns is long when one of them was (SND-1)', () => {
    const time = fakeTime();
    const emitted = [];
    const outcomes = router(time, emitted);
    outcomes.submit({ kind: 'turnDone', agentId: 'a', long: false });
    outcomes.submit({ kind: 'turnDone', agentId: 'b', long: true });
    time.advance(OUTCOME_AGGREGATE_MS);
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0].count, 2);
    assert.equal(emitted[0].long, true);
    outcomes.submit({ kind: 'turnDone', agentId: 'c', long: false });
    time.advance(OUTCOME_AGGREGATE_MS);
    assert.equal(emitted[1].long, false);
});

test('a turn is reported once, and a status flutter never re-reports an old turn', () => {
    const tracker = trackerWith([]);
    // First seen at rest with a finished turn: history, not an outcome.
    tracker.added({ id: 'a', status: 'idle', turnStartedAt: 1, lastTurnDurationMs: 40_000 });
    tracker.updated(working('a', { turnStartedAt: 1, lastTurnDurationMs: 40_000 }));
    assert.deepEqual(tracker.updated({ id: 'a', status: 'waiting', turnStartedAt: 1, lastTurnDurationMs: 40_000 }), []);
    // A new turn ends: reported.
    tracker.updated(working('a', { turnStartedAt: 2, lastTurnDurationMs: 40_000 }));
    assert.equal(tracker.updated({ id: 'a', status: 'idle', turnStartedAt: 2, lastTurnDurationMs: 30_000 }).length, 1);
    // Working again without a new turn record, then resting: not a new fact.
    tracker.updated(working('a', { turnStartedAt: 2, lastTurnDurationMs: 30_000 }));
    assert.deepEqual(tracker.updated({ id: 'a', status: 'idle', turnStartedAt: 2, lastTurnDurationMs: 30_000 }), []);
});

test('stale observations and sub-agents never report a turn end', () => {
    const tracker = new OutcomeTracker({ isAudible: agent => agent.signalStale !== true });
    tracker.added(working('stale'));
    tracker.added(working('child', { parentSessionId: 'p' }));
    assert.deepEqual(tracker.updated({ id: 'stale', status: 'idle', lastTurnDurationMs: 60_000, signalStale: true }), []);
    assert.deepEqual(tracker.updated({ id: 'child', status: 'completed', parentSessionId: 'p', lastTurnDurationMs: 60_000 }), []);
});

test('a Dashboard world yields dispatch and return from World-model transitions, each child once', () => {
    const tracker = trackerWith(['parent']);
    tracker.prime([{ id: 'parent', status: 'working' }]);
    assert.deepEqual(tracker.added({ id: 'c1', status: 'working', parentSessionId: 'parent' }),
        [{ kind: 'dispatch', agentId: 'parent', childId: 'c1' }]);
    // The renderer's own event for the same child adds nothing.
    assert.deepEqual(tracker.dispatched({ parentId: 'parent', childId: 'c1' }), []);
    assert.deepEqual(tracker.removed({ id: 'c1', status: 'completed', parentSessionId: 'parent' }),
        [{ kind: 'subagentReturn', agentId: 'parent', childId: 'c1' }]);
    assert.deepEqual(tracker.completed({ parentId: 'parent', childId: 'c1' }), []);
});

test('children already present, long idle, or orphaned are not dispatched or returned', () => {
    const tracker = trackerWith(['parent']);
    tracker.prime([{ id: 'old', parentSessionId: 'parent' }]);
    assert.deepEqual(tracker.dispatched({ parentId: 'parent', childId: 'old' }), []);
    assert.deepEqual(tracker.added({ id: 'late', parentSessionId: 'parent', activityAgeMs: 120_000 }), []);
    assert.deepEqual(tracker.removed({ id: 'orphan', parentSessionId: 'gone' }), []);
});

test('verified outcomes and tool results map to facts; exit 0 is silent', () => {
    assert.deepEqual(verifiedOutcomeFact({ kind: 'push', project: 'claude-ville', agentId: 'a', at: 1 }),
        { kind: 'push', agentId: 'a', repo: 'claude-ville', version: null });
    assert.equal(verifiedOutcomeFact({ kind: 'milestone', project: 'x' }), null);
    assert.equal(toolFailedFact({ agentId: 'a', exitCode: 0 }), null);
    assert.equal(toolFailedFact({ agentId: 'a', exitCode: null }), null);
    assert.equal(toolFailedFact({ agentId: 'a', exitCode: 2, tool: 'Bash' }).kind, 'toolFailed');
});

test('a flag-only failure (an Edit miss, a refusal) is not a failed command', () => {
    assert.equal(toolFailedFact({ agentId: 'a', tool: 'Edit', exitCode: 1, exitCodeSource: 'flag' }), null);
    assert.equal(toolFailedFact({ agentId: 'a', tool: 'Bash', exitCode: 2, exitCodeSource: 'exit' })?.kind, 'toolFailed');
    assert.equal(toolFailedFact({ agentId: 'a', tool: 'Bash', exitCode: 2 })?.kind, 'toolFailed', 'providers without a source keep today\'s reading');
});

test('RG-11: where a flag is the provider\'s only outcome, a flagged failure rings', () => {
    const flagged = provider => toolFailedFact({ agentId: 'a', provider, tool: 'bash', exitCode: 1, exitCodeSource: 'flag' });
    assert.equal(flagged('omp')?.kind, 'toolFailed', 'OMP records no exit codes');
    assert.equal(flagged('kimi')?.kind, 'toolFailed', 'a Kimi flag is a result without an exit code');
    assert.equal(flagged('claude'), null, 'Claude flags are refusals and Edit misses');
    assert.equal(flagged(null), null);
});

// RG-2 — the chits and the sound read one outcome: a search that exited 1 and
// printed nothing found no match, which is no "Command failed".
test('a silent search miss is not a failed command; the outcome reading is shared', () => {
    const miss = { agentId: 'a', tool: 'Bash', exitCode: 1, exitCodeSource: 'exit', noOutput: true, detail: 'rg -n needle src' };
    assert.equal(toolResultOutcome(miss), 'nomatch');
    assert.equal(toolFailedFact(miss), null);
    assert.equal(toolResultOutcome({ ...miss, detail: 'FOO=1 grep -rn needle .' }), 'nomatch');
    assert.equal(toolResultOutcome({ ...miss, detail: ['git', 'grep', 'needle'].join(' ') }), 'nomatch');
    assert.equal(toolFailedFact({ ...miss, noOutput: false })?.kind, 'toolFailed', 'it printed: a real failure');
    assert.equal(toolFailedFact({ ...miss, detail: 'npm test' })?.kind, 'toolFailed');
    assert.equal(toolFailedFact({ ...miss, detail: 'find . -name x' })?.kind, 'toolFailed', 'find exits 1 on an error');
    assert.equal(toolResultOutcome({ ...miss, exitCodeSource: 'flag' }), 'refused');
    assert.equal(toolResultOutcome({ ...miss, exitCode: 0 }), 'pass');
    assert.equal(toolResultOutcome({ ...miss, exitCode: null }), null);
});

test('a failed push is a growth in a repo\'s failed pushes after the first summary', () => {
    const repo = failed => ({ project: '/p', branch: 'main', shortName: 'p', failedPushes: failed });
    const first = failedPushFacts(null, [repo(1)]);
    assert.deepEqual(first.facts, []);
    const second = failedPushFacts(first.state, [repo(2)]);
    assert.deepEqual(second.facts.map(fact => [fact.kind, fact.repo]), [['pushFailed', 'p']]);
    assert.deepEqual(failedPushFacts(second.state, [repo(2)]).facts, []);
});

test('a failed push with nothing docked is news for its agent, even in the first summary', () => {
    const now = 5_000_000;
    const push = { project: '/sim/repos/cv', branch: 'main', status: 'rejected', batchId: null, agentId: 'pusher', eventTime: now - 1_000 };
    const rows = pendingRepoSummariesFromDockSummaries(new Map(), [push]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].failedPushes, 1);
    assert.equal(rows[0].pendingCommits, 0);
    const { facts } = failedPushFacts(null, rows, { now });
    assert.deepEqual(facts.map(fact => [fact.kind, fact.agentId]), [['pushFailed', 'pusher']]);
    // An old failure seen first on load stays a baseline.
    assert.deepEqual(failedPushFacts(null, rows, { now: now + 60_000 }).facts, []);
    // A push that is already batched is not a failure row.
    assert.deepEqual(pendingRepoSummariesFromDockSummaries(new Map(), [{ ...push, batchId: 'b1' }]), []);
});

test('a fan of dispatches closes its batch MOMENT_AGGREGATE_MS after its last child, capped at the window', () => {
    const time = fakeTime();
    const emitted = [];
    const outcomes = router(time, emitted);
    outcomes.submit({ kind: 'dispatch', agentId: 'parent' });
    time.advance(400);
    outcomes.submit({ kind: 'dispatch', agentId: 'parent' });
    time.advance(MOMENT_AGGREGATE_MS - 1);
    assert.equal(emitted.length, 0);
    time.advance(1);
    assert.deepEqual(emitted.map(({ kind, count }) => [kind, count]), [['dispatch', 2]]);
    for (let i = 0; i < 6; i++) {
        outcomes.submit({ kind: 'dispatch', agentId: 'parent' });
        time.advance(400);
    }
    time.advance(OUTCOME_AGGREGATE_MS);
    assert.deepEqual(emitted.slice(1).map(({ count }) => count), [4, 2], 'never later than the window after the first');
});

test('Minor facts landing together are one outcome with the exact count', () => {
    const time = fakeTime();
    const emitted = [];
    const outcomes = router(time, emitted);
    for (const agentId of ['a', 'b', 'c', 'd']) outcomes.submit({ kind: 'turnDone', agentId });
    time.advance(OUTCOME_AGGREGATE_MS - 1);
    assert.equal(emitted.length, 0);
    time.advance(1);
    assert.deepEqual(emitted.map(({ kind, count, agentId }) => ({ kind, count, agentId })),
        [{ kind: 'turnDone', count: 4, agentId: null }]);
});

test('a verified push is one outcome naming its agent and repo', () => {
    const time = fakeTime();
    const emitted = [];
    router(time, emitted).submit(verifiedOutcomeFact({ kind: 'push', project: 'claude-ville', agentId: 'a' }));
    time.advance(OUTCOME_AGGREGATE_MS);
    assert.deepEqual(emitted.map(({ kind, count, agentId, repo }) => ({ kind, count, agentId, repo })),
        [{ kind: 'push', count: 1, agentId: 'a', repo: 'claude-ville' }]);
});

test('ten failing commands from one agent in a minute are at most two outcomes', () => {
    const time = fakeTime();
    const emitted = [];
    const outcomes = router(time, emitted);
    for (let i = 0; i < 10; i++) {
        outcomes.submit(toolFailedFact({ agentId: 'a', exitCode: 1, tool: `t${i}` }));
        time.advance(6_000);
    }
    assert.ok(emitted.length <= 2, `${emitted.length} toolFailed outcomes`);
    assert.ok(emitted.every(outcome => outcome.kind === 'toolFailed'));
});

test('a release absorbs its own push, before or just after it', () => {
    const time = fakeTime();
    const emitted = [];
    const outcomes = router(time, emitted);
    outcomes.submit({ kind: 'push', agentId: 'a', repo: 'cv' });
    outcomes.submit({ kind: 'release', agentId: 'a', repo: 'cv' });
    outcomes.submit({ kind: 'push', agentId: 'a', repo: 'cv' });
    outcomes.submit({ kind: 'push', agentId: 'b', repo: 'other' });
    time.advance(OUTCOME_AGGREGATE_MS);
    assert.deepEqual(emitted.map(({ kind, repo }) => [kind, repo]), [['release', 'cv'], ['push', 'other']]);
});

test('destroy drops pending batches and their timers', () => {
    const time = fakeTime();
    const emitted = [];
    const outcomes = router(time, emitted);
    outcomes.submit({ kind: 'commit', agentId: 'a' });
    outcomes.destroy();
    time.advance(OUTCOME_AGGREGATE_MS * 2);
    assert.deepEqual(emitted, []);
});
