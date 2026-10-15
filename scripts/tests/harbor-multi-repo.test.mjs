import test from 'node:test';
import assert from 'node:assert/strict';

import {
    HarborTraffic,
    normalizeGitEvent,
    reduceHarborTrafficState,
    snapshotHarborTrafficState,
} from '../../claudeville/src/presentation/character-mode/HarborTraffic.js';
import { COAST_ANCHORAGE_SLOTS } from '../../claudeville/src/presentation/character-mode/HarborLayout.js';
import * as RepoColor from '../../claudeville/src/presentation/shared/RepoColor.js';
import { eventBus } from '../../claudeville/src/domain/events/DomainEvent.js';

// Client rows of the harbor acceptance matrix (agents/plans: refinement plan
// §4). Events follow the v1 wire contract: `repoRoot` is the canonical repo,
// `checkout`/`worktree` are presentation detail; the client keys on
// `repoRoot || project`.

const T = Date.parse('2026-10-15T10:00:00Z');
const S = 1000;
const MIN = 60 * S;
const ALPHA = '/w/alpha';
const ALPHA_WT = '/w/alpha/.claude/worktrees/a';
const ALPHA_SIB = '/w/alpha-feat-y';

const agent = { id: 'agent-mr', name: 'Multi', provider: 'claude', sessionId: 's-mr' };
let seq = 0;
const sha = () => (++seq).toString(16).padStart(8, '0') + 'a'.repeat(32);

function where(project, repoRoot = project) {
    const isMain = project === repoRoot;
    return {
        project,
        repoRoot,
        checkout: project,
        worktree: { name: project.split('/').at(-1), path: project, isMain },
    };
}

function commit(at, branch, label, extra = {}) {
    return {
        id: extra.id || `c-${++seq}`,
        type: 'commit',
        branch,
        sha: extra.sha === undefined ? sha() : extra.sha,
        label,
        timestamp: at,
        completedAt: at,
        success: true,
        ...where(ALPHA),
        ...extra,
    };
}

function push(at, branch, extra = {}) {
    return {
        id: extra.id || `p-${++seq}`,
        type: 'push',
        branch,
        timestamp: at,
        completedAt: at,
        success: true,
        exitCode: 0,
        ...where(ALPHA),
        ...extra,
    };
}

const norm = (raw, index = 0) => normalizeGitEvent(raw, agent, index, { fallbackTimestamp: T });

function reduce(raws, now, previous = null) {
    return reduceHarborTrafficState(previous, raws.map(norm), { now });
}

const ships = (state) => snapshotHarborTrafficState(state).ships;
const byLabel = (state, label) => ships(state).find(ship => ship.label === label);
const statusOf = (state, label) => byLabel(state, label)?.status;

test('row 1: a worktree commit moors in its repo anchorage as its own sub-squad', () => {
    const state = reduce([
        commit(T, 'main', 'alpha main work'),
        commit(T + S, 'feat-a', 'feature a work', where(ALPHA_WT, ALPHA)),
    ], T + 2 * S);
    const snapshot = snapshotHarborTrafficState(state);
    const feature = byLabel(state, 'feature a work');
    const main = byLabel(state, 'alpha main work');
    assert.equal(feature.project, ALPHA, 'ship is keyed by repoRoot');
    assert.equal(feature.checkout, ALPHA_WT, 'checkout stays as detail');
    assert.equal(feature.worktree?.isMain, false, 'worktree pennant data');
    assert.deepEqual(snapshot.repoAnchorages.map(entry => entry.project), [ALPHA], 'one anchorage for the repo');
    assert.equal(feature.anchorageName, main.anchorageName, 'same anchorage');
    assert.notEqual(feature.squadIndex, main.squadIndex, 'feat-a forms its own sub-squad');
    assert.equal(RepoColor.repoProfile(feature.project).key, RepoColor.repoProfile(ALPHA).key, 'repo colour');
});

test('row 2: a merged worktree commit departs when its sha lands from the main checkout', () => {
    const featSha = sha();
    const mainSha = sha();
    const events = [
        commit(T, 'feat-a', 'feature a work', { sha: featSha, ...where(ALPHA_WT, ALPHA) }),
        commit(T + S, 'main', 'alpha main work', { sha: mainSha }),
        push(T + 10 * S, 'main', { landedShas: [featSha, mainSha] }),
    ];
    const state = reduce(events, T + 11 * S);
    assert.equal(statusOf(state, 'feature a work'), 'departing');
    assert.equal(statusOf(state, 'alpha main work'), 'departing');
});

test('row 3: pushing the worktree branch departs only that branch', () => {
    const state = reduce([
        commit(T, 'main', 'alpha main work'),
        commit(T + S, 'feat-a', 'feature a work', where(ALPHA_WT, ALPHA)),
        push(T + 10 * S, 'feat-a', where(ALPHA_WT, ALPHA)),
    ], T + 11 * S);
    assert.equal(statusOf(state, 'feature a work'), 'departing');
    assert.equal(statusOf(state, 'alpha main work'), 'docked');
});

test('row 5: `git push -u origin HEAD` departs only the resolved branch; a literal HEAD never wildcards', () => {
    const base = [
        commit(T, 'main', 'alpha main work'),
        commit(T + S, 'feat-b', 'feature b work'),
    ];
    const resolved = reduce([...base, push(T + 10 * S, 'feat-b')], T + 11 * S);
    assert.equal(statusOf(resolved, 'feature b work'), 'departing');
    assert.equal(statusOf(resolved, 'alpha main work'), 'docked');

    const literal = reduce([...base, push(T + 10 * S, 'HEAD')], T + 11 * S);
    assert.equal(statusOf(literal, 'feature b work'), 'docked', 'HEAD is not a wildcard');
    assert.equal(statusOf(literal, 'alpha main work'), 'docked', 'HEAD is not a wildcard');
});

test('row 6: a branch-less push departs only branch-less ships of its checkout and writes no repo-wide floor', () => {
    const events = [
        commit(T, 'develop', 'develop work one'),
        commit(T + S, 'hotfix', 'hotfix work one'),
        commit(T + 2 * S, '', 'detached tinkering here'),
        push(T + 10 * S, null),
    ];
    let state = reduce(events, T + 11 * S);
    assert.equal(statusOf(state, 'develop work one'), 'docked');
    assert.equal(statusOf(state, 'hotfix work one'), 'docked');
    assert.equal(statusOf(state, 'detached tinkering here'), 'departing');
    // A hotfix commit made before the push but reported after it still docks.
    events.push(commit(T + 5 * S, 'hotfix', 'hotfix late reported'));
    state = reduce(events, T + 20 * S, state);
    assert.equal(statusOf(state, 'hotfix late reported'), 'docked');
});

test('row 7: a tags-only push sails no cargo', () => {
    const state = reduce([
        commit(T, 'main', 'alpha main work'),
        push(T + 10 * S, 'main', { tagsOnly: true, tag: 'v1.2.0' }),
    ], T + 11 * S);
    assert.equal(statusOf(state, 'alpha main work'), 'docked');
    assert.equal(snapshotHarborTrafficState(state).pushEvents.length, 1, 'the tag push is still recorded');
});

test('row 8: a branch-delete push sails no cargo', () => {
    const state = reduce([
        commit(T, 'feat-y', 'feature y work'),
        push(T + 10 * S, 'feat-y', { deleted: true }),
    ], T + 11 * S);
    assert.equal(statusOf(state, 'feature y work'), 'docked');
});

test('row 10: a rejected push boomerangs once, then stays docked when later commits arrive', () => {
    const events = [
        commit(T, 'main', 'alpha main work'),
        push(T + S, 'main', { success: false, exitCode: 1, stderr: '! [rejected] main -> main (non-fast-forward)' }),
    ];
    let state = reduce(events, T + 2 * S);
    assert.equal(statusOf(state, 'alpha main work'), 'rejecting');
    state = reduce([], T + 40 * S, state);
    assert.equal(statusOf(state, 'alpha main work'), 'docked');
    for (const at of [80, 90, 100]) {
        events.push(commit(T + at * S, 'main', `later commit ${at}`));
        state = reduce(events, T + at * S, state);
        assert.equal(statusOf(state, 'alpha main work'), 'docked', `no second boomerang at t+${at}s`);
        assert.equal(byLabel(state, `later commit ${at}`).pushStatus, null, 'later commits are not swept into the old push');
    }
});

test('row 11: a rebase of three commits leaves three ships', () => {
    const old = [sha(), sha(), sha()];
    const fresh = [sha(), sha(), sha()];
    const subjects = ['rebase subject one', 'rebase subject two', 'rebase subject three'];
    const events = subjects.map((label, index) => commit(T + index * S, 'main', label, { sha: old[index] }));
    let state = reduce(events, T + 5 * S);
    events.push(...subjects.map((label, index) => commit(T + (60 + index) * S, 'main', label, { sha: fresh[index] })));
    events.push({
        id: 'rw-1',
        type: 'rewritten',
        branch: 'main',
        oldShas: old,
        replacements: old.map((oldSha, index) => ({ oldSha, newSha: fresh[index] })),
        timestamp: T + 70 * S,
        ...where(ALPHA),
    });
    state = reduce(events, T + 71 * S, state);
    state = reduce([], T + 80 * S, state);
    const docked = ships(state).filter(ship => ship.status === 'docked');
    assert.equal(docked.length, 3);
    assert.deepEqual(docked.map(ship => ship.sha).sort(), [...fresh].sort());
    assert.ok(docked.every(ship => ship.amendCount === 1), 'each replacement is one amend');
});

test('row 12: same-basename repos read distinctly, with raw names', () => {
    eventBus.emit('agent:added', { id: 'row12-a', projectPath: '/work/beta' });
    eventBus.emit('agent:added', { id: 'row12-b', projectPath: '/other/beta' });
    eventBus.emit('agent:added', { id: 'row12-c', projectPath: '/work/claude-ville' });
    try {
        const work = RepoColor.repoDisplayName?.('/work/beta');
        const other = RepoColor.repoDisplayName?.('/other/beta');
        assert.notEqual(work, other);
        assert.equal(other, 'other/beta');
        assert.equal(work, 'work/beta');
        assert.equal(RepoColor.repoDisplayName?.('/work/claude-ville'), 'claude-ville', 'no title-casing');
    } finally {
        for (const id of ['row12-a', 'row12-b', 'row12-c']) eventBus.emit('agent:removed', { id });
    }
});

test('row 13: six live repos all on main wear six distinct repo colours', () => {
    const repos = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta'].map(name => `/r13/${name}`);
    repos.forEach((project, index) => eventBus.emit('agent:added', { id: `row13-${index}`, projectPath: project }));
    try {
        const state = reduce(repos.map((project, index) => commit(T + index * S, 'main', `row13 work ${index}`, where(project))), T + 10 * S);
        const pennants = ships(state).map(ship => RepoColor.repoProfile(ship.project).pennantIndex);
        assert.equal(new Set(pennants).size, 6);
    } finally {
        repos.forEach((_, index) => eventBus.emit('agent:removed', { id: `row13-${index}` }));
    }
});

// A canvas stand-in that records every fillStyle a draw call sets.
function recordingCtx() {
    const fills = [];
    const ctx = new Proxy({}, {
        get(target, key) {
            if (key === 'fills') return fills;
            if (key in target) return target[key];
            if (key === 'measureText') return text => ({ width: String(text).length * 6 });
            return () => {};
        },
        set(target, key, value) {
            if (key === 'fillStyle') fills.push(String(value));
            target[key] = value;
            return true;
        },
    });
    return ctx;
}

const rgbOf = hex => {
    const n = Number.parseInt(hex.slice(1), 16);
    return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
};

test('row 13 (Phase 4): rendered hull colour is the repo colour, branch is a pennant shape', () => {
    const repos = ['alpha', 'beta', 'gamma'].map(name => `/r13b/${name}`);
    repos.forEach((project, index) => eventBus.emit('agent:added', { id: `row13b-${index}`, projectPath: project }));
    try {
        // Every lane of a repo wears the repo's pennant: no branch hue.
        for (const project of repos) {
            const base = RepoColor.repoProfile(project);
            for (const branch of ['main', 'feat/x1', 'fix/y2']) {
                assert.equal(RepoColor.repoBranchProfile(project, branch).accent, base.accent, `${project}@${branch}`);
            }
        }
        // The branch is the pennon's shape.
        assert.equal(RepoColor.branchPennonKind('main'), 'default');
        assert.equal(RepoColor.branchPennonKind('feat/x1'), 'feature');
        assert.equal(RepoColor.branchPennonKind('feat-a', { name: 'a', isMain: false }), 'worktree');
        assert.equal(RepoColor.branchPennonKind(''), 'detached');

        // The drawn masthead pennon of each lane is cloth in the repo colour.
        const traffic = new HarborTraffic();
        const agents = repos.map((project, index) => ({
            id: `row13b-${index}`,
            projectPath: project,
            repoRoot: project,
            gitEvents: ['main', 'feat/x1'].map((branch, b) => commit(T + (index * 2 + b) * S, branch, `row13b ${index} ${branch}`, where(project))),
        }));
        traffic.reconcile(agents, T + 20 * S, { force: true });
        const drawn = traffic.enumerateDrawables(T + 20 * S).filter(item => item.payload?.type === 'ship');
        assert.ok(drawn.length >= repos.length * 2, 'one hull per lane at least');
        for (const { payload } of drawn) {
            const ctx = recordingCtx();
            traffic._drawRepoFlag(ctx, payload, 1);
            const accent = RepoColor.repoProfile(payload.project).accent;
            assert.ok(ctx.fills.includes(rgbOf(accent)), `${payload.project}@${payload.branch} flies its repo colour`);
            assert.equal(payload.pennonKind, payload.branch === 'main' ? 'default' : 'feature');
        }
        traffic.dispose();
    } finally {
        repos.forEach((_, index) => eventBus.emit('agent:removed', { id: `row13b-${index}` }));
    }
});

test('row 17: twelve repos plus five agent worktrees use one anchorage per repoRoot', () => {
    const repos = Array.from({ length: 12 }, (_, index) => `/r17/repo-${index}`);
    // Worktrees commit first, so a checkout-keyed harbor would hand them slots.
    const events = [];
    for (let index = 0; index < 5; index++) {
        const root = repos[7 + index];
        events.push(commit(T + index * S, `agent-${index}`, `row17 worktree ${index}`, where(`${root}/.claude/worktrees/agent-${index}`, root)));
    }
    events.push(...repos.map((project, index) => commit(T + (20 + index) * S, 'main', `row17 main ${index}`, where(project))));
    const state = reduce(events, T + 40 * S);
    const anchorages = snapshotHarborTrafficState(state).repoAnchorages;
    // One anchorage per repo root, never one per worktree, and never more
    // than the bounded pool (D2 added the four pier berths to it).
    assert.equal(anchorages.length, repos.length);
    assert.ok(anchorages.length <= COAST_ANCHORAGE_SLOTS.length);
    assert.ok(anchorages.every(entry => repos.includes(entry.project)), 'only repo roots hold anchorages');
    assert.equal(ships(state).filter(ship => ship.status === 'docked').length, 17);
});

test('row 20: sixty commits behind a failed push pack into a failed stack with a count', () => {
    const now = T + 120 * S;
    const raw = [];
    for (let index = 0; index < 60; index++) raw.push(commit(T + index * S, 'main', `bulk commit number ${index}`));
    raw.push(push(T + 100 * S, 'main', { success: false, exitCode: 1, stderr: 'fatal: unable to access' }));
    const harbor = new HarborTraffic();
    harbor.reconcile([{ ...agent, projectPath: ALPHA, gitEvents: raw }], now, { force: true });
    const hulls = harbor.enumerateDrawables(now).filter(drawable => drawable.payload?.type === 'ship');
    assert.ok(hulls.length <= 4, `failed fleet draws as a few stacks, not ${hulls.length} hulls`);
    assert.equal(hulls.reduce((sum, drawable) => sum + (drawable.payload.visualPackSize || 1), 0), 60);
    assert.ok(hulls.every(drawable => drawable.payload.pushStatus === 'failed'));
    harbor.dispose();
});

test('row 21: `git push origin feature:main` departs the source branch', () => {
    const state = reduce([
        commit(T, 'main', 'alpha main work'),
        commit(T + S, 'feature', 'feature branch work'),
        push(T + 10 * S, 'feature', { refs: [{ src: 'feature', dst: 'main', status: 'ok' }] }),
    ], T + 11 * S);
    assert.equal(statusOf(state, 'feature branch work'), 'departing');
    assert.equal(statusOf(state, 'alpha main work'), 'docked');
});

test('row 21b: a multi-ref push departs every source branch', () => {
    const state = reduce([
        commit(T, 'main', 'alpha main work'),
        commit(T + S, 'feature', 'feature branch work'),
        commit(T + 2 * S, 'other', 'other branch work'),
        push(T + 10 * S, 'main', { refs: [{ src: 'main', dst: 'main', status: 'ok' }, { src: 'feature', dst: 'feature', status: 'ok' }] }),
    ], T + 11 * S);
    assert.equal(statusOf(state, 'alpha main work'), 'departing');
    assert.equal(statusOf(state, 'feature branch work'), 'departing');
    assert.equal(statusOf(state, 'other branch work'), 'docked');
});

test('row 22: a rewritten event retires a discarded commit without a push', () => {
    const lost = sha();
    let state = reduce([commit(T, 'main', 'discarded by reset', { sha: lost })], T + S);
    state = reduce([
        commit(T, 'main', 'discarded by reset', { sha: lost }),
        { id: 'rw-reset', type: 'rewritten', branch: 'main', oldShas: [lost], timestamp: T + 30 * S, ...where(ALPHA) },
    ], T + 31 * S, state);
    state = reduce([], T + 40 * S, state);
    assert.equal(byLabel(state, 'discarded by reset'), undefined);
    assert.equal(snapshotHarborTrafficState(state).batches.length, 0, 'no departure batch');
});

test('row 23: a rejected push laundered by `|| true` still boomerangs', () => {
    const state = reduce([
        commit(T, 'main', 'alpha main work'),
        push(T + S, 'main', { success: false, status: 'rejected', reason: '! [rejected] main -> main (fetch first)' }),
    ], T + 2 * S);
    assert.equal(statusOf(state, 'alpha main work'), 'rejecting');
});

test('row 24: `git push && git commit -m later` keeps the later commit docked', () => {
    const events = [
        commit(T, 'main', 'before the push'),
        push(T + 10 * S, 'main'),
        commit(T + 10 * S + 1, 'main', 'after the push'),
    ];
    const state = reduce(events, T + 11 * S);
    assert.equal(statusOf(state, 'before the push'), 'departing');
    assert.equal(statusOf(state, 'after the push'), 'docked');
});

test('row 25: a failed commit ("nothing to commit") makes no ship', () => {
    const state = reduce([commit(T, 'main', 'nothing to commit here', { success: false, exitCode: 1, sha: '' })], T + S);
    assert.equal(ships(state).length, 0);
});

test('row 26: one sha unpushed on main and feature departs with a feature push', () => {
    const shared = sha();
    const state = reduce([
        commit(T, 'main', 'shared commit subject', { sha: shared }),
        commit(T + S, 'feature', 'shared commit subject', { sha: shared, id: 'shared-on-feature' }),
        push(T + 10 * S, 'feature'),
    ], T + 11 * S);
    const shared1 = ships(state).filter(ship => ship.sha === shared);
    assert.equal(shared1.length, 1, 'one ship');
    assert.deepEqual([...shared1[0].branches].sort(), ['feature', 'main']);
    assert.equal(shared1[0].amendCount, 0, 'a duplicate observation is not an amend');
    assert.equal(shared1[0].status, 'departing');
});

test('row 27: two sha-less commits with one subject are two ships', () => {
    const state = reduce([
        commit(T, 'main', 'Update README docs', { sha: '' }),
        commit(T + 10 * S, 'main', 'Update README docs', { sha: '' }),
    ], T + 11 * S);
    assert.equal(ships(state).filter(ship => ship.label === 'Update README docs').length, 2);
    assert.ok(ships(state).every(ship => ship.amendCount === 0));
});

test('row 28: a commit whose message looks like a flag is a real ship', () => {
    const state = reduce([commit(T, 'main', '--dry-run')], T + S);
    assert.equal(ships(state).length, 1);
});

test('X-4: a later, richer report of the same event id updates its ship', () => {
    const bare = { id: 'c-enrich', type: 'commit', label: 'enriched commit subject', timestamp: T, ...where(ALPHA) };
    let state = reduce([bare], T + S);
    const rich = { ...bare, sha: sha(), branch: 'feature' };
    state = reduce([rich], T + 2 * S, state);
    const ship = byLabel(state, 'enriched commit subject');
    assert.equal(ship.sha, rich.sha);
    assert.equal(ship.branch, 'feature');
    assert.equal(ship.detachedHead, false, 'detached HEAD clears once a branch is known');
    assert.equal(ship.amendCount, 0);
    // A completion that says the commit failed retires it.
    state = reduce([{ ...rich, success: false, exitCode: 1 }], T + 3 * S, state);
    state = reduce([], T + 10 * S, state);
    assert.equal(byLabel(state, 'enriched commit subject'), undefined);
});

test('X-12: a delayed older push does not depart a newer commit', () => {
    let state = reduce([commit(T + 5 * S, 'main', 'newer than the push')], T + 6 * S);
    state = reduce([
        commit(T + 5 * S, 'main', 'newer than the push'),
        push(T + S, 'main'),
    ], T + 7 * S, state);
    assert.equal(statusOf(state, 'newer than the push'), 'docked');
});

test('S-H3: observed branch-less commit enriched by the scan is one ship, branch set, no amend', () => {
    const observed = { id: 'obs-1', type: 'commit', label: 'alpha third fix', command: 'git commit -m "alpha third fix"', timestamp: T, ...where(ALPHA) };
    let state = reduce([observed], T + S);
    const inferred = commit(T + 500, 'main', 'alpha third fix', { id: 'git-unpushed-third', inferred: true });
    state = reduce([observed, inferred], T + 2 * S, state);
    const list = ships(state);
    assert.equal(list.length, 1);
    assert.equal(list[0].branch, 'main');
    assert.equal(list[0].detachedHead, false);
    assert.equal(list[0].amendCount, 0);
});

test('S-M6: a repo that pushed long ago is not untethered', () => {
    const now0 = T + 10 * S;
    const raw = [commit(T, 'main', 'pushed early'), push(T + 5 * S, 'main')];
    const harbor = new HarborTraffic();
    const agents = [{ ...agent, projectPath: ALPHA, repoRoot: ALPHA, gitEvents: raw }];
    harbor.reconcile(agents, now0, { force: true });
    for (let index = 0; index < 4; index++) raw.push(commit(T + (10 + index) * MIN, 'main', `much later work ${index}`));
    agents[0].gitEvents = [...raw];
    harbor.reconcile(agents, T + 60 * MIN, { force: true });
    assert.equal(harbor._computeUntetheredProjects(T + 70 * MIN).has(ALPHA), false);
    harbor.dispose();
});
