// Chronicle day-book helpers: commit-subject extraction and the day rollup.
// Both are pure, so neither needs IndexedDB.

import test from 'node:test';
import assert from 'node:assert/strict';

import { commitSubject, summarizeDay, ChronicleEventKind } from '../../claudeville/src/application/ChronicleLog.js';

test('a plain subject line passes through', () => {
    assert.equal(commitSubject({ label: 'feat: harbor lights' }), 'feat: harbor lights');
});

test('a -m flag yields the subject, not the shell text', () => {
    assert.equal(commitSubject({ command: `git commit -m 'docs: tidy the map'` }), 'docs: tidy the map');
});

test('a heredoc yields its first body line', () => {
    const label = `git commit -q -m "$(cat <<'EOF'\nfix: chain flag logos load\nEOF`;
    assert.equal(commitSubject({ label }), 'fix: chain flag logos load');
});

test('an unreadable command yields null rather than shell noise', () => {
    assert.equal(commitSubject({ label: 'git push origin main' }), null);
    assert.equal(commitSubject({}), null);
});

test('the day rollup counts each kind and the longest wait', () => {
    const events = [
        { ts: 10, kind: ChronicleEventKind.ARRIVED, agentName: 'Wren', project: 'claude-ville' },
        { ts: 20, kind: ChronicleEventKind.COMMIT, agentName: 'Wren', project: 'claude-ville' },
        { ts: 30, kind: ChronicleEventKind.PUSH, agentName: 'Wren', project: 'claude-ville' },
        { ts: 40, kind: ChronicleEventKind.WAITING, agentName: 'Silas', project: 'pharosville' },
        { ts: 50, kind: ChronicleEventKind.RESOLVED, agentName: 'Silas', waitedMs: 90_000 },
        { ts: 60, kind: ChronicleEventKind.RESOLVED, agentName: 'Silas', waitedMs: 30_000 },
        { ts: 70, kind: ChronicleEventKind.ERRORED, agentName: 'Silas', project: 'pharosville' },
        { ts: 80, kind: ChronicleEventKind.COMPLETED, agentName: 'Wren' },
    ];
    const summary = summarizeDay(events);
    assert.equal(summary.commits, 1);
    assert.equal(summary.pushes, 1);
    assert.equal(summary.waits, 1);
    assert.equal(summary.errors, 1);
    assert.equal(summary.completed, 1);
    assert.equal(summary.rateLimits, 0);
    assert.equal(summary.totalWaitMs, 120_000);
    assert.equal(summary.longestWaitMs, 90_000);
    assert.deepEqual(summary.agents.sort(), ['Silas', 'Wren']);
    assert.deepEqual(summary.projects.sort(), ['claude-ville', 'pharosville']);
    assert.equal(summary.firstTs, 10);
    assert.equal(summary.lastTs, 80);
});

test('an empty day rolls up to zeroes, not NaN', () => {
    const summary = summarizeDay([]);
    assert.equal(summary.commits, 0);
    assert.equal(summary.longestWaitMs, 0);
    assert.equal(summary.firstTs, null);
    assert.deepEqual(summary.agents, []);
});
