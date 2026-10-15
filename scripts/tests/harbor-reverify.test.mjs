import test from 'node:test';
import assert from 'node:assert/strict';

import {
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
