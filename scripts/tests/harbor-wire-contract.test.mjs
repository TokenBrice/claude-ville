import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { normalizeGitEvent } from '../../claudeville/src/presentation/shared/GitEventIdentity.js';
import { HarborTraffic, snapshotHarborTrafficState } from '../../claudeville/src/presentation/character-mode/HarborTraffic.js';

// Harbor wire contract v1 (agents/plans/harbor-wire-contract.md), client side:
// every server field survives the shared normalizer and reaches the harbor.
// Track A's fixture (scripts/tests/fixtures/harbor-wire-v1.json) is consumed
// when present; these events follow the same spec until it lands.

const T = Date.parse('2026-10-15T10:00:00Z');
const ROOT = '/w/repo';
const WT = '/w/repo/.claude/worktrees/feat';
const WORKTREE = { name: 'feat', path: WT, isMain: false };
const FIXTURE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/harbor-wire-v1.json');

const COMMIT = {
    id: 'wire-commit',
    type: 'commit',
    project: `${WT}/src`,
    repoRoot: ROOT,
    checkout: WT,
    worktree: WORKTREE,
    cwd: `${WT}/src`,
    sha: 'a'.repeat(40),
    branch: 'feat',
    detached: false,
    success: true,
    exitCode: 0,
    label: 'wire commit subject',
    author: { name: 'Ada', email: 'ada@example.test' },
    coAuthors: ['Claude'],
    attribution: 'scanned',
    timestamp: T,
};

const PUSH = {
    id: 'wire-push',
    type: 'push',
    project: WT,
    repoRoot: ROOT,
    checkout: WT,
    worktree: WORKTREE,
    cwd: WT,
    branch: 'feat',
    refs: [{ src: 'feat', dst: 'feat', status: 'ok', sha: 'a'.repeat(40) }],
    status: 'success',
    success: true,
    exitCode: 0,
    reason: '',
    tagsOnly: false,
    tag: '',
    deleted: false,
    landedShas: ['a'.repeat(40)],
    synthetic: 'transition',
    timestamp: T + 1000,
};

const REWRITTEN = {
    id: 'wire-rewritten',
    type: 'rewritten',
    project: ROOT,
    repoRoot: ROOT,
    branch: 'main',
    oldShas: ['b'.repeat(40)],
    replacements: [{ oldSha: 'b'.repeat(40), newSha: 'c'.repeat(40) }],
    timestamp: T + 2000,
};

test('commit identity and attribution fields survive normalizeGitEvent', () => {
    const event = normalizeGitEvent(COMMIT, {}, 0);
    for (const key of ['repoRoot', 'checkout', 'cwd', 'sha', 'branch', 'detached', 'success', 'exitCode', 'attribution']) {
        assert.deepEqual(event[key], COMMIT[key], key);
    }
    assert.deepEqual(event.worktree, WORKTREE);
    assert.deepEqual(event.author, COMMIT.author);
    assert.deepEqual(event.coAuthors, COMMIT.coAuthors);
    assert.equal(event.project, COMMIT.project, 'project stays the legacy key');
});

test('push outcome and target fields survive normalizeGitEvent', () => {
    const event = normalizeGitEvent({ ...PUSH, tagsOnly: true, tag: 'v1.0.0', deleted: true, reason: 'rejected: fetch first' }, {}, 0);
    assert.equal(event.repoRoot, ROOT);
    assert.deepEqual(event.refs, PUSH.refs);
    assert.deepEqual(event.landedShas, PUSH.landedShas);
    assert.equal(event.tagsOnly, true);
    assert.equal(event.tag, 'v1.0.0');
    assert.equal(event.deleted, true);
    assert.equal(event.reason, 'rejected: fetch first');
    assert.equal(event.synthetic, 'transition');
});

test('rewritten events normalize as their own kind', () => {
    const event = normalizeGitEvent(REWRITTEN, {}, 0);
    assert.equal(event.type, 'rewritten');
    assert.deepEqual(event.oldShas, REWRITTEN.oldShas);
    assert.deepEqual(event.replacements, REWRITTEN.replacements);
});

test('events without the new fields fall back to the session project', () => {
    const event = normalizeGitEvent({ id: 'old', type: 'commit', sha: 'd'.repeat(40), label: 'old server' }, { projectPath: '/w/old' }, 0);
    assert.equal(event.project, '/w/old');
    assert.equal(event.repoRoot, '');
    assert.equal(event.landedShas, undefined);
});

test('a session repoRoot backs events from the same project', () => {
    const agent = { projectPath: WT, repoRoot: ROOT, worktree: WORKTREE };
    const event = normalizeGitEvent({ id: 'inherit', type: 'commit', project: WT, sha: 'e'.repeat(40) }, agent, 0);
    assert.equal(event.repoRoot, ROOT);
    const elsewhere = normalizeGitEvent({ id: 'elsewhere', type: 'commit', project: '/w/other', sha: 'f'.repeat(40) }, agent, 0);
    assert.equal(elsewhere.repoRoot, '', 'another project never inherits the session repo');
});

test('the harbor keys ships on repoRoot through the reconcile path', () => {
    const harbor = new HarborTraffic();
    const agent = { id: 'wire-agent', projectPath: WT, repoRoot: ROOT, worktree: WORKTREE, provider: 'claude', sessionId: 'wire', gitEvents: [COMMIT] };
    harbor.reconcile([agent], T + 500, { force: true });
    const [ship] = snapshotHarborTrafficState(harbor.state).ships;
    assert.equal(ship.project, ROOT);
    assert.equal(ship.checkout, WT);
    assert.deepEqual(ship.worktree, WORKTREE);
    agent.gitEvents = [COMMIT, PUSH];
    harbor.reconcile([agent], T + 1500, { force: true });
    assert.equal(snapshotHarborTrafficState(harbor.state).ships[0].status, 'departing', 'landedShas departs it');
    harbor.dispose();
});

test('Track A fixture events normalize without losing contract fields', { skip: !fs.existsSync(FIXTURE) && 'fixture not written yet' }, () => {
    const raw = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
    const events = Array.isArray(raw) ? raw : raw.events || [];
    assert.ok(events.length > 0);
    const contract = ['repoRoot', 'checkout', 'worktree', 'cwd', 'sha', 'branch', 'detached', 'success', 'exitCode', 'reason',
        'deleted', 'tag', 'tagsOnly', 'landedShas', 'refs', 'synthetic', 'author', 'coAuthors', 'attribution', 'oldShas', 'replacements',
        'oldIds', 'branches', 'unresolved', 'scanSeq', 'scannedAt', 'branchesComplete'];
    events.forEach((source, index) => {
        const event = normalizeGitEvent(source, {}, index);
        assert.ok(event, `event ${index} normalizes`);
        for (const key of contract) {
            if (source[key] === undefined || source[key] === null) continue;
            if (key === 'branch' && !source[key]) continue;
            assert.deepEqual(event[key], source[key], `${source.id || index}.${key}`);
        }
    });
});

const fixtureEvents = () => {
    const raw = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
    return Array.isArray(raw) ? raw : raw.events || [];
};
const fixtureHas = (key) => fs.existsSync(FIXTURE) && fixtureEvents().some(event => event[key] !== undefined);

test('Track A fixture: ghost ids, branch sets and unresolved events reach the harbor', {
    skip: !(fixtureHas('oldIds') && fixtureHas('branches')) && 'fixture not regenerated with oldIds/branches yet',
}, () => {
    const events = fixtureEvents().map((event, index) => normalizeGitEvent(event, {}, index));
    const rewritten = events.find(event => event.type === 'rewritten' && event.oldIds?.length);
    assert.ok(rewritten, 'a rewritten event lists oldIds');
    const scanned = events.find(event => event.type === 'commit' && event.branches?.length);
    assert.equal(scanned.branch || '', scanned.branches[0], 'branch is the first of branches');
    for (const event of events.filter(item => item.unresolved)) assert.equal(event.repoRoot, '', 'unresolved events carry no repo');
});
