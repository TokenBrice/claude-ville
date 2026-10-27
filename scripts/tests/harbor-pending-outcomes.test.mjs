import test from 'node:test';
import assert from 'node:assert/strict';

import { HarborTraffic } from '../../claudeville/src/presentation/character-mode/HarborTraffic.js';

// VB-3 (lane 03 harnesses harbor/h2, h10, h13): a git command with no result
// yet (a permission prompt, a long hook) never counts as landed, and its
// settled result, reported later under the same id, re-applies.

const T = Date.parse('2026-10-27T10:00:00Z');
const S = 1000;
const REPO = '/w/pending';
const agent = (events) => ({ id: 'a', sessionId: 'a', projectPath: REPO, repoRoot: REPO, gitEvents: events });
const shipsOf = (harbor, predicate = () => true) => [...harbor.state.ships.values()].filter(predicate);

const pullBase = { id: 'git-pull-x', type: 'pull', project: REPO, repoRoot: REPO, remote: 'origin', branch: 'main', ts: T, command: 'git pull origin main' };
const prBase = { id: 'git-pr-y', type: 'pr', action: 'create', project: REPO, repoRoot: REPO, ts: T, command: 'gh pr create', inferred: true, observed: false };
const commitBase = { id: 'git-commit-p', type: 'commit', project: REPO, repoRoot: REPO, ts: T, command: "git commit -m 'feat: not yet approved'", label: 'feat: not yet approved', branch: 'main', attribution: 'observed' };

test('VB-3: a pending pull sails nothing, and a failed result leaves nothing docked', () => {
    const harbor = new HarborTraffic({});
    harbor.reconcile([agent([pullBase])], T + S);
    assert.equal(harbor.state.ships.has('inbound:git-pull-x'), false, 'no result yet: no inbound hull');
    const failed = { ...pullBase, success: false, exitCode: 1, status: 'failed', completedAt: T + 3 * S };
    harbor.reconcile([agent([failed])], T + 5 * S);
    harbor.reconcile([agent([failed])], T + 30 * 60 * S);
    assert.equal(harbor.state.ships.has('inbound:git-pull-x'), false);
    harbor.dispose();
});

test('VB-3: a pending pull sails in once its success is reported, even after a slow approval', () => {
    for (const settleAfter of [5 * S, 3 * 60 * S]) {
        const harbor = new HarborTraffic({});
        harbor.reconcile([agent([pullBase])], T + S);
        const settled = { ...pullBase, success: true, exitCode: 0, completedAt: T + settleAfter };
        harbor.reconcile([agent([settled])], T + settleAfter + S);
        assert.equal(harbor.state.ships.get('inbound:git-pull-x')?.status, 'arriving', `settled after ${settleAfter / S} s`);
        harbor.dispose();
    }
});

test('VB-3: a pending or failed `gh pr create` moors no cutter', () => {
    const harbor = new HarborTraffic({});
    harbor.reconcile([agent([prBase])], T + S);
    assert.equal(harbor.state.ships.has('pr:git-pr-y'), false, 'no result yet: no cutter');
    const failed = { ...prBase, success: false, exitCode: 1, completedAt: T + 3 * S };
    harbor.reconcile([agent([failed])], T + 5 * S);
    harbor.reconcile([agent([failed])], T + 60 * S);
    assert.equal(harbor.state.ships.has('pr:git-pr-y'), false);
    harbor.dispose();
});

const pr = (id, extra) => ({ id, type: 'pr', project: REPO, repoRoot: REPO, inferred: true, observed: false, command: 'gh pr create', ...extra });

test('VB-3: a cutter learns its PR URL once known, and the merge sails the right PR', () => {
    const harbor = new HarborTraffic({});
    // PR #12 on topic-a and PR #15 on topic-b, each through a permission prompt.
    const a0 = pr('pr-a', { action: 'create', ts: T, branch: 'topic-a' });
    const a1 = { ...a0, success: true, exitCode: 0, completedAt: T + 20 * S, url: 'https://github.com/o/r/pull/12' };
    harbor.reconcile([agent([a0])], T + S);
    harbor.reconcile([agent([a1])], T + 21 * S);
    const b0 = pr('pr-b', { action: 'create', ts: T + 60 * S, branch: 'topic-b' });
    const b1 = { ...b0, success: true, exitCode: 0, completedAt: T + 75 * S, url: 'https://github.com/o/r/pull/15' };
    harbor.reconcile([agent([a1, b0])], T + 62 * S);
    harbor.reconcile([agent([a1, b1])], T + 76 * S);
    assert.equal(harbor.state.ships.get('pr:pr-a').prUrl, 'https://github.com/o/r/pull/12');
    assert.equal(harbor.state.ships.get('pr:pr-a').label, 'PR #12');
    assert.equal(harbor.state.ships.get('pr:pr-b').prUrl, 'https://github.com/o/r/pull/15');

    // A pending merge sails nothing; its success sails PR #12's cutter.
    const m0 = pr('pr-merge-12', { action: 'merge', command: 'gh pr merge', ts: T + 300 * S, branch: 'topic-a', url: 'https://github.com/o/r/pull/12' });
    harbor.reconcile([agent([a1, b1, m0])], T + 301 * S);
    assert.equal(harbor.state.ships.get('pr:pr-a').arrivingKind, 'pr');
    assert.equal(harbor.state.ships.get('pr:pr-b').arrivingKind, 'pr');
    const m1 = { ...m0, success: true, exitCode: 0, completedAt: T + 302 * S };
    harbor.reconcile([agent([a1, b1, m1])], T + 303 * S);
    assert.equal(harbor.state.ships.get('pr:pr-a').arrivingKind, 'pr-merge', 'PR #12 sails to the quay');
    assert.equal(harbor.state.ships.get('pr:pr-b').arrivingKind, 'pr', 'PR #15 stays moored');

    // A re-report of the applied merge (a richer copy) sails no second cutter.
    harbor.reconcile([agent([a1, b1, { ...m1, title: 'feat: topic a' }])], T + 305 * S);
    assert.equal(harbor.state.ships.get('pr:pr-b').arrivingKind, 'pr');
    assert.equal(shipsOf(harbor, ship => ship.prShip).length, 2);
    harbor.dispose();
});

test('VB-3: a moored cutter whose URL arrives on a later report attaches it', () => {
    const harbor = new HarborTraffic({});
    const created = pr('pr-late-url', { action: 'create', ts: T, branch: 'topic-c', success: true, exitCode: 0, completedAt: T + S });
    harbor.reconcile([agent([created])], T + 2 * S);
    assert.equal(harbor.state.ships.get('pr:pr-late-url').prUrl, '');
    harbor.reconcile([agent([{ ...created, url: 'https://github.com/o/r/pull/21' }])], T + 3 * S);
    assert.equal(harbor.state.ships.get('pr:pr-late-url').prUrl, 'https://github.com/o/r/pull/21');
    assert.equal(harbor.state.ships.get('pr:pr-late-url').label, 'PR #21');
    harbor.dispose();
});

test('VB-3: a pending `git commit` docks no hull until its success is reported', () => {
    const harbor = new HarborTraffic({});
    harbor.reconcile([agent([commitBase])], T + S);
    assert.equal(harbor.state.ships.has('git-commit-p'), false, 'the commit has not run');
    const settled = { ...commitBase, success: true, exitCode: 0, completedAt: T + 4 * S, sha: 'c'.repeat(40) };
    harbor.reconcile([agent([settled])], T + 5 * S);
    assert.equal(harbor.state.ships.get('git-commit-p')?.status, 'docked');

    const refused = new HarborTraffic({});
    refused.reconcile([agent([commitBase])], T + S);
    refused.reconcile([agent([{ ...commitBase, success: false, exitCode: 1, completedAt: T + 4 * S }])], T + 5 * S);
    assert.equal(refused.state.ships.size, 0, 'a refused commit never docks');
    harbor.dispose();
    refused.dispose();
});

test('VB-3: a scanned commit is verified by the repository itself', () => {
    const harbor = new HarborTraffic({});
    const scanned = {
        id: 'git-unpushed-z', type: 'commit', project: REPO, repoRoot: REPO, sha: 'd'.repeat(40), branch: 'main', branches: ['main'],
        label: 'feat: found by the scan', ts: T, completedAt: T, inferred: true, observed: false,
        attribution: 'scanned', source: 'git-upstream-status', scanSeq: 1, scannedAt: T,
    };
    harbor.reconcile([agent([scanned])], T + S);
    assert.equal(harbor.state.ships.get('git-unpushed-z')?.status, 'docked');
    harbor.dispose();
});
