import test from 'node:test';
import assert from 'node:assert/strict';

import { AgentManager, digestAgentPayload } from '../../claudeville/src/application/AgentManager.js';
import { World } from '../../claudeville/src/domain/entities/World.js';
import { eventBus } from '../../claudeville/src/domain/events/DomainEvent.js';

// The AgentManager skips an update whose digest is unchanged, so the digest
// must see every change the World acts on (lane 03 harnesses `harbor/h6` and
// `freshness-churn`).

const REPO = '/home/dev/Documents/git/some-project-name';
const T = Date.parse('2026-10-27T10:00:00Z');
// Shaped like the server's scanned unpushed-commit event (about 30 fields).
const scanned = (i) => ({
    id: `git-unpushed-${(1e9 + i * 7919).toString(36)}`,
    type: 'commit',
    command: `git commit ${String(i).padStart(10, '0')} (feat(world): a realistic commit subject number ${i})`,
    project: REPO, repoRoot: REPO, provider: 'git',
    sessionId: 'git-repo-1a2b3c4d', sourceId: 'git-upstream-status', source: 'git-upstream-status',
    confidence: 0.72, ts: T + i, commandHash: `h${i}`, dryRun: false, success: true, exitCode: 0, completedAt: T + i,
    sha: (i.toString(16).padStart(8, '0')).repeat(5), label: `feat(world): a realistic commit subject number ${i}`,
    inferred: true, observed: false, branch: 'main', targetRef: 'main', upstream: 'origin/main', comparisonRef: 'origin/main',
    hasUpstream: true, attribution: 'scanned', scanSeq: 1761559200000, scannedAt: T, branchesComplete: true,
    branches: ['main'], author: { name: 'Dev Person', email: 'dev@example.com' },
});
const payload = (events, extra = {}) => ({
    status: 'idle', projectPath: REPO, repoRoot: REPO, provider: 'claude', lastSessionActivity: T, activityAgeMs: 30_000,
    gitEvents: events,
    ...extra,
});
// The in-place edits the wire makes to an event it already listed.
const EDITS = {
    rescan: (event) => ({ ...event, scanSeq: event.scanSeq + 1 }),
    outcome: (event) => ({ ...event, success: false, exitCode: 1, status: 'failed' }),
    sha: (event) => ({ ...event, sha: 'f'.repeat(40) }),
    prUrl: (event) => ({ ...event, url: 'https://github.com/o/r/pull/12' }),
    landed: (event) => ({ ...event, landedShas: [event.sha] }),
};

test('VB-7: a git event edited at any index changes the digest', () => {
    for (const n of [16, 24, 40, 64, 100, 600]) {
        const events = Array.from({ length: n }, (_, i) => scanned(i));
        const base = digestAgentPayload(payload(events));
        for (const [name, edit] of Object.entries(EDITS)) {
            for (let k = 0; k < n; k++) {
                const changed = events.slice();
                changed[k] = edit(events[k]);
                assert.notEqual(digestAgentPayload(payload(changed)), base, `${name} at index ${k} of ${n} is invisible`);
            }
        }
    }
});

test('VB-7: a same-length swap at the tail (a commit out, a push in) changes the digest', () => {
    for (const n of [40, 64, 100]) {
        const events = Array.from({ length: n }, (_, i) => scanned(i));
        const base = digestAgentPayload(payload(events));
        const swapped = events.slice(0, -1).concat([{
            id: 'git-push-transition-x', type: 'push', project: REPO, repoRoot: REPO, ts: T + 999,
            status: 'success', success: true, landedShas: [events.at(-1).sha],
        }]);
        assert.notEqual(digestAgentPayload(payload(swapped)), base, `tail swap at ${n} events is invisible`);
    }
});

test('VB-7: an equal git event list keeps its digest, and a tool result edit is seen', () => {
    const events = Array.from({ length: 100 }, (_, i) => scanned(i));
    assert.equal(digestAgentPayload(payload(events)), digestAgentPayload(payload(structuredClone(events))));
    const results = Array.from({ length: 5 }, (_, i) => ({
        id: `claude:s:${i}`, tool: 'Bash', detail: `npm test ${i}`, exitCode: 0, exitCodeSource: 'flag',
        durationMs: 100, completedAt: T + i, source: 'transcript',
    }));
    const base = digestAgentPayload(payload(events, { lastResults: results }));
    for (let k = 0; k < results.length; k++) {
        const changed = results.slice();
        changed[k] = { ...results[k], exitCode: 1 };
        assert.notEqual(digestAgentPayload(payload(events, { lastResults: changed })), base, `result ${k}`);
    }
});

test('VB-7: a git event that settles deep in a busy list reaches the World on the next delta', () => {
    const previousNow = Date.now;
    let now = T + 60_000;
    Date.now = () => now;
    const world = new World();
    const manager = new AgentManager(world, null, { clock: () => now });
    const updates = [];
    const off = eventBus.on('agent:updated', (agent) => updates.push(agent.id));
    try {
        const events = Array.from({ length: 40 }, (_, i) => scanned(i));
        const session = (gitEvents) => ({
            sessionId: 'busy', provider: 'claude', project: REPO, turnState: 'working', lastActivity: T + 55_000, gitEvents,
        });
        manager.handleWebSocketMessage({ sessions: [session(events)] });
        const settled = events.slice();
        settled[30] = EDITS.outcome(events[30]);
        now += 1_000;
        manager.handleWebSocketMessage({ sessions: [session(settled)], changes: { sessionIds: ['busy'], shared: false } });
        assert.deepEqual(updates, ['busy']);
        assert.equal(world.agents.get('busy').gitEvents[30].success, false);
    } finally {
        off();
        manager.stop();
        Date.now = previousNow;
    }
});

test('VB-7: digest work stays bounded for an oversized git event list', () => {
    const work = {};
    const huge = Array.from({ length: 50_000 }, (_, i) => ({ id: `e-${i}`, label: 'x'.repeat(4_000), sha: 'a'.repeat(40) }));
    const started = performance.now();
    digestAgentPayload(payload(huge), work);
    assert.ok(work.keyedRows <= 2_048, `keyed rows ${work.keyedRows}`);
    assert.ok(performance.now() - started < 500, 'oversized list digest is bounded');
});

// VB-16 (SV-5 client backstop): the server re-stamps `freshness.observedAt`
// and `ageMs` on every collect. Only its state and observation minute count.
function freshnessReplay(deltas, initial = { state: 'fresh', observedAt: T, ageMs: 0 }) {
    const previousNow = Date.now;
    let now = T;
    Date.now = () => now;
    const world = new World();
    const manager = new AgentManager(world, null, { clock: () => now });
    const counts = [];
    let updates = 0;
    const off = eventBus.on('agent:updated', () => { updates++; });
    const N = 20;
    const sessions = (freshness) => Array.from({ length: N }, (_, i) => ({
        sessionId: `s-${i}`, provider: i % 2 ? 'codex' : 'claude', model: i % 2 ? 'gpt-5.1-codex' : 'claude-opus-4-1', project: '/tmp/p',
        status: 'active', turnState: i < 3 ? 'tool_pending' : 'working', waitReason: i < 2 ? 'permission' : null, pendingTool: i < 3 ? 'Bash' : null,
        currentTool: i >= 3 ? 'Edit' : null, currentToolInput: i >= 3 ? 'src/a.js' : null, lastTool: 'Edit', lastActivity: T - 5_000,
        dialogue: { kind: 'message', text: `line ${i}`, source: 'assistant' }, tokens: { input: 100 * i, output: 10 * i },
        freshness,
    }));
    const ids = Array.from({ length: N }, (_, i) => `s-${i}`);
    try {
        manager.handleWebSocketMessage({ sessions: sessions(initial) });
        for (const delta of deltas) {
            now = T + delta.at;
            updates = 0;
            manager.handleWebSocketMessage({ sessions: sessions(delta.freshness), changes: { sessionIds: ids, shared: false } });
            counts.push(updates);
        }
        return { counts, world };
    } finally {
        off();
        manager.stop();
        Date.now = previousNow;
    }
}

test('VB-16: a freshness re-stamp alone never re-upserts a villager', () => {
    const deltas = Array.from({ length: 20 }, (_, k) => ({ at: (k + 1) * 500, freshness: { state: 'fresh', observedAt: T, ageMs: (k + 1) * 500 } }));
    assert.deepEqual(freshnessReplay(deltas).counts, Array(20).fill(0));
    // The server's other re-stamp, observedAt itself, inside one minute.
    const restamped = Array.from({ length: 20 }, (_, k) => ({ at: (k + 1) * 2_000, freshness: { state: 'fresh', observedAt: T + (k + 1) * 2_000, ageMs: 0 } }));
    assert.deepEqual(freshnessReplay(restamped).counts, Array(20).fill(0));
});

test('VB-16: a freshness state change still updates every villager', () => {
    const { counts, world } = freshnessReplay([{ at: 1_000, freshness: { state: 'stale', observedAt: T, ageMs: 1_000 } }]);
    assert.deepEqual(counts, [20]);
    assert.equal(world.agents.get('s-0').freshness.state, 'stale');
});

test('VB-16: a new observation minute still updates every villager', () => {
    // T is minute-aligned and every session's activity age stays in minute 0.
    const { counts, world } = freshnessReplay(
        [{ at: 2_000, freshness: { state: 'fresh', observedAt: T + 2_000, ageMs: 0 } }],
        { state: 'fresh', observedAt: T - 1_000, ageMs: 0 },
    );
    assert.deepEqual(counts, [20]);
    assert.equal(world.agents.get('s-0').freshness.observedAt, T + 2_000);
});
