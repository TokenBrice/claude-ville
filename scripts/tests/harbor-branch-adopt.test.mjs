import test from 'node:test';
import assert from 'node:assert/strict';

import {
    HarborTraffic,
    normalizeGitEvent,
    reduceHarborTrafficState,
    snapshotHarborTrafficState,
} from '../../claudeville/src/presentation/character-mode/HarborTraffic.js';

// Real data (pharos-watch): a shared commit seen first by a detached-worktree
// scan (no branch) and then by the named-branch scan must adopt the named
// branch, clear detached HEAD and join that branch's squad, whichever report
// arrives first.

const T = Date.parse('2026-10-15T10:00:00Z');
const S = 1000;
const ROOT = '/w/pharos';
const WT = '/w/pharos/.claude/worktrees/detached';
const SHA = 'c'.repeat(40);
const OTHER = 'd'.repeat(40);

const detached = (id, at) => ({ id, type: 'commit', project: WT, repoRoot: ROOT, checkout: WT, sha: SHA, label: 'shared commit subject', timestamp: at, inferred: true, detached: true });
const named = (id, at) => ({ id, type: 'commit', project: ROOT, repoRoot: ROOT, checkout: ROOT, branch: 'main', sha: SHA, label: 'shared commit subject', timestamp: at, inferred: true });
const anchor = { id: 'main-anchor', type: 'commit', project: ROOT, repoRoot: ROOT, branch: 'main', sha: OTHER, label: 'another main commit', timestamp: T, success: true };

function assertAdopted(ships) {
    const shared = ships.filter(ship => ship.sha === SHA);
    assert.equal(shared.length, 1, 'one ship');
    assert.equal(shared[0].branch, 'main', 'adopts the named branch');
    assert.ok(shared[0].branches.includes('main'));
    assert.equal(shared[0].detachedHead, false);
    const main = ships.find(ship => ship.sha === OTHER);
    assert.equal(shared[0].squadIndex, main.squadIndex, 'moors in the main squad');
}

for (const [order, first, second] of [['branch-less first', detached, named], ['named first', named, detached]]) {
    test(`reducer: ${order}, separate event ids`, () => {
        const norm = (raw) => normalizeGitEvent(raw, {}, 0, { fallbackTimestamp: T });
        let state = reduceHarborTrafficState(null, [anchor, first('e1', T + S)].map(norm), { now: T + 2 * S });
        state = reduceHarborTrafficState(state, [anchor, first('e1', T + S), second('e2', T + 2 * S)].map(norm), { now: T + 3 * S });
        assertAdopted(snapshotHarborTrafficState(state).ships);
    });

    test(`reconcile: ${order}, one scan id reported by two sessions`, () => {
        const id = `git-unpushed:${ROOT}:${SHA}`;
        const harbor = new HarborTraffic();
        const agentA = { id: 'a-first', projectPath: first === detached ? WT : ROOT, repoRoot: ROOT, provider: 'claude', sessionId: 's1', gitEvents: [anchor, first(id, T + S)] };
        harbor.reconcile([agentA], T + 2 * S, { force: true });
        const agentB = { id: 'a-second', projectPath: second === detached ? WT : ROOT, repoRoot: ROOT, provider: 'codex', sessionId: 's2', gitEvents: [second(id, T + 2 * S)] };
        harbor.reconcile([agentA, agentB], T + 3 * S, { force: true });
        assertAdopted(snapshotHarborTrafficState(harbor.state).ships);
        harbor.dispose();
    });
}

for (const branchLessFirst of [true, false]) {
    test(`reconcile: one raw scan event per session in one project, branch-less ${branchLessFirst ? 'earlier' : 'later'}`, () => {
        const id = `git-unpushed:${ROOT}:${SHA}`;
        const bare = { ...detached(id, branchLessFirst ? T + S : T + 2 * S), project: ROOT };
        const rich = named(id, branchLessFirst ? T + 2 * S : T + S);
        const harbor = new HarborTraffic();
        const agentA = { id: 'p-a', projectPath: ROOT, repoRoot: ROOT, provider: 'claude', sessionId: 's1', gitEvents: [anchor, bare] };
        const agentB = { id: 'p-b', projectPath: ROOT, repoRoot: ROOT, provider: 'codex', sessionId: 's2', gitEvents: [rich] };
        harbor.reconcile([agentA, agentB], T + 3 * S, { force: true });
        assertAdopted(snapshotHarborTrafficState(harbor.state).ships);
        harbor.dispose();
    });
}
