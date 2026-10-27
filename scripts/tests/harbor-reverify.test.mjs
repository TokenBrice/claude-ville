import test from 'node:test';
import assert from 'node:assert/strict';

import {
    HarborTraffic,
    normalizeGitEvent,
    reduceHarborTrafficState,
} from '../../claudeville/src/presentation/character-mode/HarborTraffic.js';

// Re-verification (agents/research/harbor-review/09-codex-reverify.md):
// R4 scanned branch membership is authoritative per scan and can shrink;
// R5 explicit amend replacements win over ghost retirement by id.

const T = Date.parse('2026-10-15T10:00:00Z');
const S = 1000;
const REPO = '/w/reverify';
const SHA = 'a'.repeat(40);
const OLD = 'b'.repeat(40);
const NEW = 'c'.repeat(40);
const norm = (raw) => normalizeGitEvent({ project: REPO, repoRoot: REPO, ...raw }, {}, 0, { fallbackTimestamp: T });
const reduce = (raws, now, previous = null) => reduceHarborTrafficState(previous, raws.map(norm), { now });
const scan = (at, branches, id = `scan:${SHA}`) => ({
    id, type: 'commit', sha: SHA, branch: branches[0] || '', branches, detached: !branches.length,
    label: 'scanned shared subject', timestamp: T, completedAt: at, inferred: true, attribution: 'scanned',
});

test('R4: a newer scan shrinks the branch set, and the reset branch push leaves the ship docked', () => {
    let state = reduce([scan(T + S, ['main', 'feature'])], T + 2 * S);
    assert.deepEqual([...state.ships.get(`scan:${SHA}`).branches].sort(), ['feature', 'main']);
    state = reduce([scan(T + 10 * S, ['main'])], T + 11 * S, state);
    const ship = state.ships.get(`scan:${SHA}`);
    assert.deepEqual(ship.branches, ['main'], 'feature membership removed');
    assert.equal(ship.branch, 'main');
    state = reduce([
        scan(T + 10 * S, ['main']),
        { id: 'p-feature', type: 'push', branch: 'feature', timestamp: T + 20 * S, success: true, exitCode: 0 },
    ], T + 21 * S, state);
    assert.equal(state.ships.get(`scan:${SHA}`).status, 'docked', "a feature push leaves main's cargo");
});

test('R4: a new scan event id replaces the scanned set too', () => {
    let state = reduce([scan(T + S, ['main', 'feature'], 'scan-1')], T + 2 * S);
    state = reduce([scan(T + S, ['main', 'feature'], 'scan-1'), scan(T + 10 * S, ['feature'], 'scan-2')], T + 11 * S, state);
    const [ship] = state.ships.values();
    assert.deepEqual(ship.branches, ['feature']);
    assert.equal(ship.branch, 'feature');
});

test('R4: observed branch evidence newer than the scan survives it; older evidence does not', () => {
    const observed = (at) => ({ id: `obs-${at}`, type: 'commit', sha: SHA, branch: 'hotfix', label: 'scanned shared subject', timestamp: T, completedAt: at, success: true });
    let state = reduce([scan(T + S, ['main']), observed(T + 5 * S), scan(T + 10 * S, ['main'])], T + 11 * S);
    assert.deepEqual([...state.ships.values()][0].branches, ['main'], 'older observation superseded by the scan');
    state = reduce([scan(T + S, ['main']), observed(T + 20 * S)], T + 21 * S);
    assert.deepEqual([...[...state.ships.values()][0].branches].sort(), ['hotfix', 'main'], 'newer observation kept');
});

test('R5: an amend replacement wins over ghost retirement by id', () => {
    const observed = { id: 'obs-amend', type: 'commit', branch: 'main', sha: OLD, label: 'amended subject line', timestamp: T, success: true };
    const replacement = { id: `scan:${NEW}`, type: 'commit', branch: 'main', sha: NEW, label: 'amended subject line', timestamp: T + S, inferred: true, attribution: 'scanned' };
    const rewritten = {
        id: 'rw-amend', type: 'rewritten', branch: 'main', timestamp: T + 2 * S,
        oldIds: ['obs-amend'], oldShas: [OLD], replacements: [{ oldSha: OLD, newSha: NEW }],
    };
    let state = reduce([observed, replacement, rewritten], T + 3 * S);
    state = reduce([], T + 10 * S, state);
    const ships = [...state.ships.values()];
    assert.equal(ships.length, 1, 'one ship');
    assert.equal(ships[0].status, 'docked');
    assert.equal(ships[0].sha, NEW);
    assert.equal(ships[0].amendCount, 1);
});

// VB-10 (lane 03 harness harbor/h4): the classic "push rejected, then pull
// with rebase" inside the 28 s boomerang. Rewrites reach a hull that is still
// sailing home, and a pending vanish waits for it to re-dock.
const RB_REPO = '/w/rebase';
const RB_OLD = 'a'.repeat(40);
const RB_NEW = 'b'.repeat(40);
const rbAgent = (events) => ({ id: 'a', sessionId: 'a', projectPath: RB_REPO, repoRoot: RB_REPO, gitEvents: events });
const rbScan = (id, sha, seq, at = T - 60 * S, extra = {}) => ({
    id, type: 'commit', project: RB_REPO, repoRoot: RB_REPO, sha, branch: 'main', branches: ['main'],
    label: 'feat: add the thing', ts: at, completedAt: at, success: true, exitCode: 0,
    inferred: true, observed: false, attribution: 'scanned', source: 'git-upstream-status',
    scanSeq: seq, scannedAt: T + seq, branchesComplete: true, ...extra,
});
const rbRejected = { id: 'push-1', type: 'push', project: RB_REPO, repoRoot: RB_REPO, branch: 'main', ts: T, success: false, exitCode: 1, status: 'rejected', refs: [{ src: 'main', dst: 'main', status: 'rejected' }] };
const rbRewritten = (extra = {}) => ({
    id: 'rw-1', type: 'rewritten', project: RB_REPO, repoRoot: RB_REPO, branch: 'main', ts: T + 5 * S, completedAt: T + 5 * S,
    oldShas: [RB_OLD], scanSeq: 2, scannedAt: T + 5 * S, branchesComplete: true, ...extra,
});
const rbReplaced = () => rbRewritten({ replacements: [{ oldSha: RB_OLD, newSha: RB_NEW }] });
const rbHulls = (harbor) => [...harbor.state.ships.values()].filter(ship => !ship.isInbound)
    .map(ship => `${ship.status}:${(ship.shas || []).map(sha => sha.slice(0, 4)).join('/')}`).sort();

test('VB-10: a rebase during a rejected-push boomerang leaves one hull, carrying the new sha', () => {
    const harbor = new HarborTraffic({});
    harbor.reconcile([rbAgent([rbScan('c-old', RB_OLD, 1)])], T - 30 * S);
    harbor.reconcile([rbAgent([rbScan('c-old', RB_OLD, 1), rbRejected])], T + S);
    assert.deepEqual(rbHulls(harbor), ['rejecting:aaaa']);
    const wire = [rbRejected, rbReplaced(), rbScan('c-new', RB_NEW, 2, T + 5 * S)];
    harbor.reconcile([rbAgent(wire)], T + 6 * S);
    assert.deepEqual(rbHulls(harbor), ['rejecting:bbbb'], 'the returning hull takes the amend');
    for (const at of [20, 30, 40]) harbor.reconcile([rbAgent(wire)], T + at * S);
    assert.deepEqual(rbHulls(harbor), ['docked:bbbb'], 'one hull re-docks, no duplicate');
    harbor.reconcile([rbAgent(wire)], T + 10 * 60 * S);
    assert.deepEqual(rbHulls(harbor), ['docked:bbbb']);
    const reload = new HarborTraffic({});
    reload.reconcile([rbAgent(wire)], T + 10 * 60 * S);
    assert.deepEqual(rbHulls(reload), rbHulls(harbor), 'live agrees with a reload');
    harbor.dispose();
    reload.dispose();
});

test('VB-10: a docked rebase whose new commit sorts first keeps one hull for the new sha', () => {
    // The scan's new commit (its commit time) sorts before its rewritten
    // event (the scan time): the new hull docks first, then folds into the
    // old one, which takes over its report.
    const harbor = new HarborTraffic({});
    harbor.reconcile([rbAgent([rbScan('c-old', RB_OLD, 1)])], T - 30 * S);
    const wire = [rbReplaced(), rbScan('c-new', RB_NEW, 2, T + 4 * S)];
    harbor.reconcile([rbAgent(wire)], T + 6 * S);
    harbor.reconcile([rbAgent(wire)], T + 10 * S);
    assert.deepEqual(rbHulls(harbor), ['docked:bbbb']);
    assert.equal([...harbor.state.ships.values()][0].amendCount, 1);
    // The next scan of the new commit still reaches the folded hull.
    harbor.reconcile([rbAgent([rbReplaced(), rbScan('c-new', RB_NEW, 3, T + 4 * S, { branches: ['main', 'topic'] })])], T + 20 * S);
    assert.deepEqual(rbHulls(harbor), ['docked:bbbb']);
    assert.deepEqual([...[...harbor.state.ships.values()][0].branches].sort(), ['main', 'topic']);
    harbor.dispose();
});

test('VB-10: a reset during the boomerang retires the hull once it is home', () => {
    const harbor = new HarborTraffic({});
    harbor.reconcile([rbAgent([rbScan('c-old', RB_OLD, 1)])], T - 30 * S);
    harbor.reconcile([rbAgent([rbScan('c-old', RB_OLD, 1), rbRejected])], T + S);
    // A hard reset to the remote: the commit leaves, with no replacement.
    const wire = [rbRejected, rbRewritten()];
    harbor.reconcile([rbAgent(wire)], T + 6 * S);
    assert.deepEqual(rbHulls(harbor), ['rejecting:aaaa'], 'it finishes sailing home first');
    // The 28 s boomerang started at T + 1 s: home at T + 29 s.
    for (const at of [20, 28]) harbor.reconcile([rbAgent(wire)], T + at * S);
    assert.deepEqual(rbHulls(harbor), ['rejecting:aaaa']);
    harbor.reconcile([rbAgent(wire)], T + 30 * S);
    assert.deepEqual(rbHulls(harbor), ['scuttling:aaaa'], 'then fades where it moored');
    harbor.reconcile([rbAgent(wire)], T + 35 * S);
    assert.deepEqual(rbHulls(harbor), []);
    // A rewritten commit is retired: its stale report never re-docks it.
    harbor.reconcile([rbAgent([rbScan('c-old', RB_OLD, 1), ...wire])], T + 40 * S);
    assert.deepEqual(rbHulls(harbor), []);
    harbor.dispose();
});

test('VB-10: a hull whose report leaves the wire mid-boomerang fades once home, and returns with its report', () => {
    const harbor = new HarborTraffic({});
    harbor.reconcile([rbAgent([rbScan('c-old', RB_OLD, 1)])], T - 30 * S);
    harbor.reconcile([rbAgent([rbScan('c-old', RB_OLD, 1), rbRejected])], T + S);
    harbor.reconcile([rbAgent([rbRejected])], T + 6 * S);
    assert.deepEqual(rbHulls(harbor), ['rejecting:aaaa']);
    for (const at of [20, 28]) harbor.reconcile([rbAgent([rbRejected])], T + at * S);
    assert.deepEqual(rbHulls(harbor), ['rejecting:aaaa']);
    harbor.reconcile([rbAgent([rbRejected])], T + 30 * S);
    assert.deepEqual(rbHulls(harbor), ['scuttling:aaaa'], 'the held vanish applies at the berth');
    harbor.reconcile([rbAgent([rbRejected])], T + 35 * S);
    assert.deepEqual(rbHulls(harbor), []);
    // A vanished hull is forgotten, not tombstoned: its report docks it again
    // (after the rejected push's batch has expired, as a reload would show).
    harbor.reconcile([rbAgent([rbRejected])], T + 80 * S);
    harbor.reconcile([rbAgent([rbScan('c-old', RB_OLD, 1), rbRejected])], T + 85 * S);
    assert.deepEqual(rbHulls(harbor), ['docked:aaaa']);
    harbor.dispose();
});
