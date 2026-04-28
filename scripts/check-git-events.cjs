#!/usr/bin/env node

const assert = require('assert/strict');
const { mergeUnpushedGitEvents } = require('../claudeville/adapters/gitEvents');

const project = '/tmp/claude-ville-git-fixture';
const baseTime = Date.parse('2026-04-28T12:00:00Z');

function commit(id, overrides = {}) {
  return {
    id,
    type: 'commit',
    project,
    label: 'Implement git event merge fixture coverage',
    completedAt: baseTime,
    inferred: false,
    ...overrides,
  };
}

function ids(events) {
  return events.map((event) => event.id).sort();
}

{
  const merged = mergeUnpushedGitEvents(
    [commit('observed-sha', { sha: 'abc123', label: 'Observed label' })],
    [commit('inferred-sha', { sha: 'abc123', branch: 'main', inferred: true })]
  );
  assert.equal(merged.length, 1, 'SHA match should merge observed and inferred commits');
  assert.equal(merged[0].id, 'observed-sha');
  assert.equal(merged[0].branch, 'main');
  assert.equal(merged[0].inferred, false);
}

{
  const commandHash = 'command-hash-1';
  const merged = mergeUnpushedGitEvents(
    [commit('observed-command', { commandHash, completedAt: null })],
    [commit('inferred-command', { commandHash, completedAt: null, inferred: true })]
  );
  assert.equal(merged.length, 1, 'matching command hashes without times should merge');
  assert.equal(merged[0].id, 'observed-command');
}

{
  const merged = mergeUnpushedGitEvents(
    [commit('observed-text', { label: 'Implement git event merge fixture coverage', completedAt: baseTime })],
    [commit('inferred-text', { label: 'Implement git event merge fixture coverage and checks', completedAt: baseTime + 60_000, inferred: true })]
  );
  assert.equal(merged.length, 1, 'nearby commit text and time should merge');
  assert.equal(merged[0].id, 'observed-text');
}

{
  const merged = mergeUnpushedGitEvents(
    [],
    [commit('synthetic-only', { inferred: true })]
  );
  assert.deepEqual(ids(merged), ['synthetic-only'], 'synthetic-only commit should be retained');
}

{
  const merged = mergeUnpushedGitEvents(
    [commit('observed-only')],
    []
  );
  assert.deepEqual(ids(merged), ['observed-only'], 'observed-only commit should be retained');
}

{
  const merged = mergeUnpushedGitEvents(
    [commit('observed-near-miss', { label: 'Implement git event merge fixture coverage', completedAt: baseTime })],
    [commit('inferred-near-miss', { label: 'Refactor unrelated renderer code', completedAt: baseTime + 5 * 60_000, inferred: true })]
  );
  assert.deepEqual(
    ids(merged),
    ['inferred-near-miss', 'observed-near-miss'],
    'text/time near misses should remain distinct'
  );
}

console.log('git event merge fixtures passed');
