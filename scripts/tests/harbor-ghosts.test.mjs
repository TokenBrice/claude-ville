import test from 'node:test';
import assert from 'node:assert/strict';

import {
    HarborTraffic,
    normalizeGitEvent,
    reduceHarborTrafficState,
} from '../../claudeville/src/presentation/character-mode/HarborTraffic.js';

// Track A server additions: `rewritten.oldIds` retires ghost ships by event id
// (the only way a sha-less ghost retires), `unresolved: true` events never
// make ships, and scanned commits carry their full `branches` set.

const T = Date.parse('2026-10-15T10:00:00Z');
const S = 1000;
const REPO = '/w/ghosts';
const norm = (raw) => normalizeGitEvent({ project: REPO, repoRoot: REPO, ...raw }, {}, 0, { fallbackTimestamp: T });
const reduce = (raws, now, previous = null) => reduceHarborTrafficState(previous, raws.map(norm), { now });

test('normalizeGitEvent carries oldIds, branches and unresolved', () => {
    const rewritten = norm({ id: 'rw', type: 'rewritten', oldIds: ['ghost-1'], oldShas: [], timestamp: T });
    assert.deepEqual(rewritten.oldIds, ['ghost-1']);
    const scanned = norm({ id: 'sc', type: 'commit', sha: 'a'.repeat(40), branch: 'main', branches: ['main', 'release'], timestamp: T });
    assert.deepEqual(scanned.branches, ['main', 'release']);
    assert.equal(norm({ id: 'u', type: 'commit', label: 'x', unresolved: true, timestamp: T }).unresolved, true);
});

test('rewritten.oldIds retires a sha-less ghost quietly, by any merged event id', () => {
    const ghost = { id: 'ghost-1', type: 'commit', branch: 'main', label: 'ghost commit subject', timestamp: T, success: true };
    const keeper = { id: 'keeper', type: 'commit', branch: 'main', sha: 'b'.repeat(40), label: 'real commit subject', timestamp: T + S, success: true };
    let state = reduce([ghost, keeper], T + 2 * S);
    assert.equal(state.ships.get('ghost-1').status, 'docked');
    const rewritten = { id: 'rw-ghost', type: 'rewritten', branch: 'main', oldIds: ['ghost-1'], oldShas: [], timestamp: T + 10 * S };
    state = reduce([ghost, keeper, rewritten], T + 11 * S, state);
    assert.equal(state.ships.get('ghost-1').status, 'scuttling', 'fades, never sails');
    state = reduce([], T + 20 * S, state);
    assert.equal(state.ships.has('ghost-1'), false);
    assert.equal(state.ships.get('keeper').status, 'docked');
    assert.equal(state.batches.size, 0);
});

test('an unresolved event never makes a ship or moves one', () => {
    const real = { id: 'real', type: 'commit', branch: 'main', sha: 'c'.repeat(40), label: 'resolved commit subject', timestamp: T, success: true };
    const state = reduce([
        real,
        { id: 'lost', type: 'commit', label: 'unresolved commit subject', timestamp: T + S, success: true, unresolved: true, repoRoot: '' },
        { id: 'lost-push', type: 'push', branch: 'main', timestamp: T + 2 * S, success: true, unresolved: true },
    ], T + 3 * S);
    assert.equal(state.ships.has('lost'), false);
    assert.equal(state.ships.get('real').status, 'docked');
});

test('a scanned commit wears its whole branch set', () => {
    const sha = 'd'.repeat(40);
    let state = reduce([{ id: 'sc', type: 'commit', sha, branch: 'main', branches: ['main', 'release'], label: 'scanned commit subject', timestamp: T, inferred: true }], T + S);
    assert.deepEqual([...state.ships.get('sc').branches].sort(), ['main', 'release']);
    state = reduce([
        { id: 'sc', type: 'commit', sha, branch: 'main', branches: ['main', 'release'], label: 'scanned commit subject', timestamp: T, inferred: true },
        { id: 'p-release', type: 'push', branch: 'release', timestamp: T + 2 * S, success: true, exitCode: 0 },
    ], T + 3 * S, state);
    assert.equal(state.ships.get('sc').status, 'departing', 'a push on any branch carries it');
});

test('a detached scanned commit is branch-less and detached', () => {
    const state = reduce([{ id: 'det', type: 'commit', sha: 'e'.repeat(40), branch: '', branches: [], detached: true, label: 'detached commit subject', timestamp: T, inferred: true }], T + S);
    assert.equal(state.ships.get('det').detachedHead, true);
    assert.deepEqual(state.ships.get('det').branches, []);
});

test('reconcile() forwards a new oldIds list and a grown branch set', () => {
    const harbor = new HarborTraffic();
    const sha = 'f'.repeat(40);
    const scan = { id: 'sc', type: 'commit', project: REPO, repoRoot: REPO, sha, branch: 'main', branches: ['main'], label: 'scanned commit subject', timestamp: T, inferred: true };
    const ghost = { id: 'ghost-2', type: 'commit', project: REPO, repoRoot: REPO, branch: 'main', label: 'ghost two subject', timestamp: T, success: true };
    const rw = { id: 'rw', type: 'rewritten', project: REPO, repoRoot: REPO, branch: 'main', oldIds: [], oldShas: [], timestamp: T + S };
    const agent = { id: 'a1', projectPath: REPO, repoRoot: REPO, provider: 'claude', sessionId: 's1', gitEvents: [scan, ghost, rw] };
    harbor.reconcile([agent], T + 2 * S);
    agent.gitEvents = [{ ...scan, branches: ['main', 'release'] }, ghost, rw];
    harbor.reconcile([agent], T + 3 * S);
    assert.deepEqual([...harbor.state.ships.get('sc').branches].sort(), ['main', 'release']);
    agent.gitEvents = [{ ...scan, branches: ['main', 'release'] }, ghost, { ...rw, id: 'rw-2', oldIds: ['ghost-2'] }];
    harbor.reconcile([agent], T + 4 * S);
    assert.equal(harbor.state.ships.get('ghost-2')?.status, 'scuttling');
    harbor.dispose();
});
