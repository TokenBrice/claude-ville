import test from 'node:test';
import assert from 'node:assert/strict';

import {
    HarborTraffic,
    normalizeGitEvent,
    reduceHarborTrafficState,
} from '../../claudeville/src/presentation/character-mode/HarborTraffic.js';

// Re-verify #2, R4 (agents/research/harbor-review/10-codex-reverify-2.md),
// wire v1.1: scanned events carry `scanSeq` (strictly increasing per repo),
// `scannedAt` (the scan's wall time) and `branchesComplete`. Their
// `completedAt` is the commit time, so it cannot order scans.

const T = Date.parse('2026-10-15T10:00:00Z');
const S = 1000;
const REPO = '/w/scanseq';
const SHA = 'a'.repeat(40);
const COMMIT_TIME = T;
const ID = `git-unpushed-${REPO}:${SHA}`;

// Shaped like the server's scanned unpushed-commit event.
const scan = (seq, scannedAt, branches, extra = {}) => ({
    id: ID,
    type: 'commit',
    project: REPO,
    repoRoot: REPO,
    sha: SHA,
    branch: branches[0] || '',
    branches,
    detached: !branches.length,
    label: 'shared unpushed subject',
    timestamp: COMMIT_TIME,
    completedAt: COMMIT_TIME,
    inferred: true,
    observed: false,
    source: 'git-upstream-status',
    attribution: 'scanned',
    scanSeq: seq,
    scannedAt,
    branchesComplete: true,
    ...extra,
});
const featurePush = (at) => ({
    id: 'p-feature', type: 'push', project: REPO, repoRoot: REPO, branch: 'feature', timestamp: at, completedAt: at,
    success: true, exitCode: 0, refs: [{ src: 'feature', dst: 'feature', status: 'up-to-date' }],
});
const norm = (raw) => normalizeGitEvent(raw, {}, 0, { fallbackTimestamp: T });
const reduce = (raws, now, previous = null) => reduceHarborTrafficState(previous, raws.map(norm), { now });
const branchesOf = (state) => [...state.ships.get(ID).branches].sort();

test('normalizeGitEvent carries scanSeq, scannedAt and branchesComplete', () => {
    const event = norm(scan(7, T + 5 * S, ['main'], { branchesComplete: false }));
    assert.equal(event.scanSeq, 7);
    assert.equal(event.scannedAt, T + 5 * S);
    assert.equal(event.branchesComplete, false);
});

test("Codex's sequence: an older scan delivered late never restores a reset branch", () => {
    let state = reduce([scan(1, T + 10 * S, ['main', 'feature'])], T + 11 * S);
    assert.deepEqual(branchesOf(state), ['feature', 'main']);
    state = reduce([scan(2, T + 60 * S, ['main'])], T + 61 * S, state);
    assert.deepEqual(branchesOf(state), ['main'], 'the newer scan drops feature');
    state = reduce([scan(1, T + 10 * S, ['main', 'feature'])], T + 62 * S, state);
    assert.deepEqual(branchesOf(state), ['main'], 'the late older scan is ignored');
    state = reduce([scan(2, T + 60 * S, ['main']), featurePush(T + 70 * S)], T + 71 * S, state);
    assert.equal(state.ships.get(ID).status, 'docked', "an up-to-date feature push leaves main's cargo");
});

test('an equal scanSeq is not newer', () => {
    let state = reduce([scan(3, T + 10 * S, ['main'])], T + 11 * S);
    state = reduce([scan(3, T + 10 * S, ['main', 'feature'])], T + 12 * S, state);
    assert.deepEqual(branchesOf(state), ['main']);
});

test('an observation older than the latest scan does not count; a newer one does', () => {
    const observed = (id, at) => ({
        id, type: 'commit', project: REPO, repoRoot: REPO, sha: SHA, branch: 'feature', label: 'shared unpushed subject',
        timestamp: at, completedAt: at, success: true,
    });
    // Observed after the commit but before the scan that found feature gone.
    let state = reduce([scan(1, T + 10 * S, ['main', 'feature']), observed('obs-old', T + 30 * S), scan(2, T + 60 * S, ['main'])], T + 61 * S);
    assert.deepEqual(branchesOf(state), ['main']);
    state = reduce([observed('obs-new', T + 90 * S)], T + 91 * S, state);
    assert.deepEqual(branchesOf(state), ['feature', 'main']);
});

test('an incomplete branch listing adds branches and never removes one', () => {
    let state = reduce([scan(1, T + 10 * S, ['main', 'feature'])], T + 11 * S);
    state = reduce([scan(2, T + 60 * S, ['release'], { branchesComplete: false })], T + 61 * S, state);
    assert.deepEqual(branchesOf(state), ['feature', 'main', 'release']);
    state = reduce([scan(3, T + 90 * S, ['main'])], T + 91 * S, state);
    assert.deepEqual(branchesOf(state), ['main'], 'a later complete listing is authoritative again');
});

test('without scanSeq (older server) a newer scan still replaces the scanned set', () => {
    const old = (completedAt, branches) => {
        const event = scan(undefined, undefined, branches, { completedAt });
        delete event.scanSeq;
        delete event.scannedAt;
        delete event.branchesComplete;
        return event;
    };
    let state = reduce([old(T + 10 * S, ['main', 'feature'])], T + 11 * S);
    state = reduce([old(T + 60 * S, ['main'])], T + 61 * S, state);
    assert.deepEqual(branchesOf(state), ['main']);
});

test('reconcile() forwards a new scanSeq even when branches look unchanged to the old hash', () => {
    const harbor = new HarborTraffic();
    const agent = { id: 'a1', projectPath: REPO, repoRoot: REPO, provider: 'claude', sessionId: 's1', gitEvents: [scan(1, T + 10 * S, ['main', 'feature'])] };
    harbor.reconcile([agent], T + 11 * S);
    agent.gitEvents = [scan(2, T + 60 * S, ['main', 'feature'], { branchesComplete: false })];
    harbor.reconcile([agent], T + 61 * S);
    agent.gitEvents = [scan(3, T + 90 * S, ['main'])];
    harbor.reconcile([agent], T + 91 * S);
    assert.deepEqual([...harbor.state.ships.get(ID).branches], ['main']);
    agent.gitEvents = [scan(2, T + 60 * S, ['main', 'feature'], { branchesComplete: false })];
    harbor.reconcile([agent], T + 92 * S);
    assert.deepEqual([...harbor.state.ships.get(ID).branches], ['main'], 'late seq 2 ignored through reconcile');
    harbor.dispose();
});

test('an observed event re-emitted with scan membership is authoritative too (through reconcile)', () => {
    const harbor = new HarborTraffic();
    const at = T + 5 * S;
    const observed = {
        id: 'obs-quiet', type: 'commit', project: REPO, repoRoot: REPO, sha: SHA, branch: 'feature', label: 'quiet commit subject',
        timestamp: at, completedAt: at, success: true, attribution: 'observed',
    };
    const agent = { id: 'a1', projectPath: REPO, repoRoot: REPO, provider: 'claude', sessionId: 's1', gitEvents: [observed] };
    harbor.reconcile([agent], T + 6 * S);
    // Moved onto main, feature reset; the server enriches the same observed
    // event with the scan's membership. scanSeq is time-based (large).
    const scanSeq = T + 60 * S;
    agent.gitEvents = [{ ...observed, branch: 'main', branches: ['main'], scanSeq, scannedAt: T + 60 * S, branchesComplete: true }];
    harbor.reconcile([agent], T + 61 * S);
    assert.deepEqual([...harbor.state.ships.get('obs-quiet').branches], ['main']);
    agent.gitEvents = [...agent.gitEvents, featurePush(T + 70 * S)];
    harbor.reconcile([agent], T + 71 * S);
    assert.equal(harbor.state.ships.get('obs-quiet').status, 'docked', "a feature push leaves main's cargo");
    harbor.dispose();
});

// VB-11 (lane 03 harness harbor/h11): two sessions report one scanned commit;
// a departed session keeps its frozen copy for 90 s. The newer scan wins the
// cross-agent de-duplication whichever session the harbor meets first.
test('VB-11: a stale copy from another session never shadows a newer scan', () => {
    const mainPush = {
        id: 'p-main', type: 'push', project: REPO, repoRoot: REPO, branch: 'main', timestamp: T + 20 * S, completedAt: T + 20 * S,
        success: true, exitCode: 0, status: 'success', refs: [{ src: 'main', dst: 'main', status: 'ok' }],
    };
    const session = (id, events) => ({ id, sessionId: id, projectPath: REPO, repoRoot: REPO, provider: 'claude', gitEvents: events });
    const variants = {
        scanSeq: [scan(1, T + S, ['main', 'feature']), scan(2, T + 9 * S, ['feature'])],
        scannedAt: [scan(null, T + S, ['main', 'feature']), scan(null, T + 9 * S, ['feature'])],
    };
    for (const [key, [olderScan, newerScan]] of Object.entries(variants)) {
        for (const order of ['stale-first', 'fresh-first']) {
            const harbor = new HarborTraffic();
            const stale = session('A', [olderScan]);
            harbor.reconcile([stale, session('B', [olderScan])], T + 2 * S);
            // Main moved back to its remote: B's newer scan drops it, A's copy is frozen.
            const fresh = session('B', [newerScan]);
            harbor.reconcile(order === 'stale-first' ? [stale, fresh] : [fresh, stale], T + 10 * S);
            assert.deepEqual([...harbor.state.ships.get(ID).branches], ['feature'], `${key} ${order}: main is gone`);
            const pushed = session('B', [newerScan, mainPush]);
            harbor.reconcile(order === 'stale-first' ? [stale, pushed] : [pushed, stale], T + 21 * S);
            assert.equal(harbor.state.ships.get(ID).status, 'docked', `${key} ${order}: a main push leaves it`);
            harbor.dispose();
        }
    }
});

test('VB-11: a newer scan that finds the commit on no branch keeps it branch-less', () => {
    const session = (id, events) => ({ id, sessionId: id, projectPath: REPO, repoRoot: REPO, provider: 'claude', gitEvents: events });
    for (const order of ['stale-first', 'fresh-first']) {
        const harbor = new HarborTraffic();
        const stale = session('A', [scan(1, T + S, ['main'])]);
        const fresh = session('B', [scan(2, T + 9 * S, [])]);
        harbor.reconcile(order === 'stale-first' ? [stale, fresh] : [fresh, stale], T + 10 * S);
        const ship = harbor.state.ships.get(ID);
        assert.deepEqual([...ship.branches], [], `${order}: no stale branch adopted`);
        assert.equal(ship.detachedHead, true);
        harbor.dispose();
    }
});
