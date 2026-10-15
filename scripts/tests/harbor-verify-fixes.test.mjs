import test from 'node:test';
import assert from 'node:assert/strict';

import {
    normalizeGitEvent,
    reduceHarborTrafficState,
    snapshotHarborTrafficState,
} from '../../claudeville/src/presentation/character-mode/HarborTraffic.js';
import * as RepoColor from '../../claudeville/src/presentation/shared/RepoColor.js';
import { eventBus } from '../../claudeville/src/domain/events/DomainEvent.js';

// Client fixes from the independent Phase 1/2 verification
// (agents/research/harbor-review/07-codex-verify-ab.md): P1-1, P1-3 (client
// side), P1-4, P2-11, P2-12 and per-ref partial acceptance.

const T = Date.parse('2026-10-15T10:00:00Z');
const S = 1000;
const MIN = 60 * S;
const REPO = '/w/verify';
const full = (head, fill) => (head + fill.repeat(40)).slice(0, 40);
const A = full('aaaa', '1');
const B = full('bbbb', '2');

const norm = (raw, index = 0) => normalizeGitEvent({ project: REPO, repoRoot: REPO, ...raw }, {}, index, { fallbackTimestamp: T });
const reduce = (raws, now, previous = null) => reduceHarborTrafficState(previous, raws.map(norm), { now });
const ships = (state) => snapshotHarborTrafficState(state).ships;
const statusOf = (state, label) => ships(state).find(ship => ship.label === label)?.status;
const commit = (id, at, branch, sha, label, extra = {}) => ({ id, type: 'commit', branch, sha, label, timestamp: at, success: true, ...extra });
const push = (id, at, branch, extra = {}) => ({ id, type: 'push', branch, timestamp: at, success: true, exitCode: 0, ...extra });

test('P1-1: a commit left out of landedShas is reported late and still docks', () => {
    const commitA = commit('cA', T, 'main', A, 'landed commit A');
    const commitB = commit('cB', T + S, 'main', B, 'unpublished commit B');
    const pushP = push('pP', T + 10 * S, 'main', { landedShas: [A] });
    let state = reduce([commitA, pushP], T + 11 * S);
    state = reduce([commitA, pushP, commitB], T + 12 * S, state);
    assert.equal(statusOf(state, 'unpublished commit B'), 'docked', 'no lane floor over an excluded sha');
});

test('P1-1: replaying A+B+P after the replay window keeps unpublished B', () => {
    const state = reduce([
        commit('cA', T, 'main', A, 'landed commit A'),
        commit('cB', T + S, 'main', B, 'unpublished commit B'),
        push('pP', T + 10 * S, 'main', { landedShas: [A] }),
    ], T + 10 * MIN);
    assert.equal(statusOf(state, 'landed commit A'), undefined, 'A is history');
    assert.equal(statusOf(state, 'unpublished commit B'), 'docked');
});

test('P1-1: exactly 200 landed shas are not read as truncation', () => {
    const landed = [A, ...Array.from({ length: 199 }, (_, index) => full(index.toString(16).padStart(4, 'e'), '9'))];
    const state = reduce([
        commit('cA', T, 'main', A, 'landed commit A'),
        commit('cB', T + S, 'main', B, 'unpublished commit B'),
        push('pP', T + 10 * S, 'main', { landedShas: landed }),
    ], T + 11 * S);
    assert.equal(statusOf(state, 'landed commit A'), 'departing');
    assert.equal(statusOf(state, 'unpublished commit B'), 'docked');
});

test('P1-3: a mixed branch + tag push selects no ships for its tag refs', () => {
    const state = reduce([
        commit('cMain', T, 'main', A, 'main branch work'),
        commit('cFeat', T + S, 'feature', B, 'feature branch work'),
        push('pMixed', T + 10 * S, 'main', { refs: [{ src: 'main', dst: 'main', status: 'ok' }, { src: 'feature', dst: 'feature', tag: true, status: 'ok' }] }),
    ], T + 11 * S);
    assert.equal(statusOf(state, 'main branch work'), 'departing');
    assert.equal(statusOf(state, 'feature branch work'), 'docked');
});

test('per-ref partial acceptance: rejected main boomerangs, accepted feature sails', () => {
    const state = reduce([
        commit('cMain', T, 'main', A, 'main branch work'),
        commit('cFeat', T + S, 'feature', B, 'feature branch work'),
        push('pPartial', T + 10 * S, 'main', {
            success: false,
            exitCode: 1,
            stderr: '! [rejected] main -> main (fetch first)',
            refs: [{ src: 'main', dst: 'main', status: 'rejected' }, { src: 'feature', dst: 'feature', status: 'ok' }],
        }),
    ], T + 11 * S);
    assert.equal(statusOf(state, 'main branch work'), 'rejecting');
    assert.equal(statusOf(state, 'feature branch work'), 'departing');
});

test('P1-4: a short sha upgrades to its full sha and never bridges two full shas', () => {
    const full1 = full('abcdef0', '1');
    const full2 = full('abcdef0', '2');
    const state = reduce([
        commit('cShort', T, 'main', 'abcdef0', 'abbreviated report'),
        commit('cFull1', T + S, 'main', full1, 'abbreviated report'),
        commit('cFull2', T + 2 * S, 'main', full2, 'second commit same prefix'),
    ], T + 3 * S);
    const list = ships(state);
    assert.equal(list.length, 2);
    const first = list.find(ship => ship.eventTime === T);
    assert.equal(first.sha, full1, 'stored sha upgraded to full');
    assert.deepEqual(first.shas, [full1]);
    assert.ok(list.some(ship => ship.sha === full2));
});

test('P2-11: author, co-author and worktree enrichment reaches the existing ship', () => {
    const base = commit('cAuthor', T, 'main', A, 'authored commit subject');
    let state = reduce([base], T + S);
    const worktree = { name: 'wt', path: `${REPO}/.claude/worktrees/wt`, isMain: false };
    state = reduce([{ ...base, author: { name: 'Ada' }, coAuthors: ['Claude'], attribution: 'scanned', worktree }], T + 2 * S, state);
    const ship = state.ships.get('cAuthor');
    assert.deepEqual(ship.author, { name: 'Ada' });
    assert.deepEqual(ship.coAuthors, ['Claude']);
    assert.equal(ship.attribution, 'observed', 'an observed report outranks a scanned one (D5)');
    assert.deepEqual(ship.worktree, worktree);
});

test('P2-12: a checkout alias does not outlive an independent repo at that path', () => {
    eventBus.emit('agent:added', { id: 'p212-a', projectPath: '/w/wt', repoRoot: '/w/main' });
    assert.equal(RepoColor.repoKeyFor('/w/wt'), '/w/main');
    eventBus.emit('agent:removed', { id: 'p212-a' });
    eventBus.emit('agent:added', { id: 'p212-b', projectPath: '/w/wt', repoRoot: '/w/wt' });
    try {
        assert.equal(RepoColor.repoKeyFor('/w/wt'), '/w/wt');
        assert.equal(RepoColor.repoProfile('/w/wt').name, 'wt');
    } finally {
        eventBus.emit('agent:removed', { id: 'p212-b' });
    }
});
