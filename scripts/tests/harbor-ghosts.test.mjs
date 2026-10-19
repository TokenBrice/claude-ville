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

// A page load replays only what the wire carries now. A docked commit whose
// reports left it with no departure the client saw (the scan stopped listing
// it, or its only session left before the push) must not outlive a reload.
test('reconcile() fades a docked commit whose reports left the wire, and docks it again if they return', () => {
    const harbor = new HarborTraffic();
    const scan = { id: 'git-unpushed-gone', type: 'commit', project: REPO, repoRoot: REPO, sha: '9'.repeat(40), branch: 'feat/pr', label: 'merged by pull request', timestamp: T, inferred: true };
    const kept = { id: 'kept', type: 'commit', project: REPO, repoRoot: REPO, sha: '8'.repeat(40), branch: 'main', label: 'still unpushed', timestamp: T, success: true };
    const agent = { id: 'a1', projectPath: REPO, repoRoot: REPO, provider: 'claude', sessionId: 's1', gitEvents: [scan, kept] };
    harbor.reconcile([agent], T + S);
    assert.equal(harbor.state.ships.get('git-unpushed-gone').status, 'docked');

    agent.gitEvents = [kept];
    harbor.reconcile([agent], T + 2 * S);
    assert.equal(harbor.state.ships.get('git-unpushed-gone').status, 'scuttling', 'fades, never sails');
    harbor.reconcile([agent], T + 10 * S, { force: true });
    assert.equal(harbor.state.ships.has('git-unpushed-gone'), false);
    assert.equal(harbor.state.ships.get('kept').status, 'docked');

    agent.gitEvents = [scan, kept];
    harbor.reconcile([agent], T + 11 * S);
    assert.equal(harbor.state.ships.get('git-unpushed-gone')?.status, 'docked', 'a returning report docks again');

    // Every session of the repo left: nothing it reported stays docked.
    harbor.reconcile([], T + 12 * S);
    harbor.reconcile([], T + 20 * S, { force: true });
    assert.equal(harbor.state.ships.size, 0);
    harbor.dispose();
});

test('a fading commit whose report returns with a push carrying its sha sails', () => {
    const harbor = new HarborTraffic();
    const sha = '7'.repeat(40);
    const commit = { id: 'flicker', type: 'commit', project: REPO, repoRoot: REPO, sha, branch: 'feat/pr', label: 'briefly unlisted', timestamp: T, success: true };
    const agent = { id: 'a1', projectPath: REPO, repoRoot: REPO, provider: 'claude', sessionId: 's1', gitEvents: [commit] };
    harbor.reconcile([agent], T + S);
    agent.gitEvents = [];
    harbor.reconcile([agent], T + 2 * S);
    assert.equal(harbor.state.ships.get('flicker').status, 'scuttling');

    // Back within the fade, together with the push that landed it.
    const push = { id: 'push-flicker', type: 'push', project: REPO, repoRoot: REPO, branch: 'feat/pr', landedShas: [sha], timestamp: T + 2 * S, success: true, exitCode: 0 };
    agent.gitEvents = [commit, push];
    harbor.reconcile([agent], T + 2 * S + 500);
    assert.equal(harbor.state.ships.get('flicker').status, 'departing');
    harbor.dispose();
});
