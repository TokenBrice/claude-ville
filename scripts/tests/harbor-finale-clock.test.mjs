import test from 'node:test';
import assert from 'node:assert/strict';

import { HarborTraffic } from '../../claudeville/src/presentation/character-mode/HarborTraffic.js';

// VB-12 (lane 03 harnesses harbor/h8, h9): departures last their route at the
// convoy's cruise speed (20-75 s) and cast off in line astern, so the horizon
// finale and the batch expiry run from the batch's actual last arrival, not a
// fixed 48 s departure clock.

const T = Date.parse('2026-10-27T10:00:00Z');
const S = 1000;
const agent = (repo, events) => ({ id: `a-${repo}`, sessionId: `a-${repo}`, projectPath: repo, repoRoot: repo, gitEvents: events });

function departure(repo, branches, perBranch, extraRepos = 0) {
    const harbor = new HarborTraffic({});
    const others = [];
    // Other repos claim the pier berths first, pushing this repo further out.
    for (let r = 0; r < extraRepos; r++) {
        const other = `/w/other-${r}`;
        others.push(agent(other, [{ id: `o-${r}`, type: 'commit', project: other, repoRoot: other, sha: (9e6 + r).toString(16).padStart(40, 'e'), branch: 'main', label: 'chore: other repo work item', ts: T - 900 * S, success: true, exitCode: 0 }]));
    }
    const commits = [];
    for (let b = 0; b < branches; b++) {
        for (let c = 0; c < perBranch; c++) {
            commits.push({ id: `c-${b}-${c}`, type: 'commit', project: repo, repoRoot: repo, sha: (b * 1000 + c + 1).toString(16).padStart(40, '0'), branch: `topic-${b}`, label: `feat: topic ${b} change ${c} words`, ts: T - 600 * S + b * 10 * S + c * S, success: true, exitCode: 0 });
        }
    }
    const push = { id: 'push', type: 'push', project: repo, repoRoot: repo, ts: T, success: true, exitCode: 0, status: 'success', remote: 'origin', refs: Array.from({ length: branches }, (_, b) => ({ src: `topic-${b}`, dst: `topic-${b}`, status: 'ok' })), landedShas: commits.map(commit => commit.sha).slice(-200) };
    const agents = (events) => [...others, agent(repo, events)];
    harbor.reconcile(agents(commits), T - S);
    harbor.reconcile(agents([...commits, push]), T + S);
    return { harbor, agents: agents([...commits, push]) };
}

const CASES = [
    ['1 commit at a pier berth', '/w/solo', 1, 1, 0],
    ['1 commit at a far anchorage', '/w/far', 1, 1, 8],
    ['4 branches x 3', '/w/four', 4, 3, 0],
    ['12 branches x 4', '/w/twelve', 12, 4, 0],
];

test('VB-12: the finale fires as the batch\'s last hull reaches the horizon', () => {
    for (const [label, repo, branches, perBranch, extraRepos] of CASES) {
        const { harbor } = departure(repo, branches, perBranch, extraRepos);
        const batch = harbor.state.batches.get('push-batch:push');
        const ships = [...harbor.state.ships.values()].filter(ship => ship.status === 'departing');
        assert.ok(ships.length > 0, label);
        const finaleAt = batch.startedAt + harbor._batchFinaleDelay(batch);
        const last = ships.reduce((a, b) => (b.departStartedAt + b.departMsOverride > a.departStartedAt + a.departMsOverride ? b : a));
        const lastArrival = last.departStartedAt + last.departMsOverride;
        // As before, 4 % of the last hull's own sail ahead of its arrival.
        const lead = lastArrival - finaleAt;
        assert.ok(lead >= 0 && lead <= 0.04 * last.departMsOverride + 1, `${label}: finale ${lead} ms before the last arrival`);
        assert.equal(harbor.activeFinaleEffects(finaleAt - 1).length, 0, `${label}: no whirlpool before`);
        assert.equal(harbor.activeFinaleEffects(finaleAt + 1).length, 1, `${label}: the whirlpool at the finale`);
        harbor.dispose();
    }
});

test('VB-12: no hull of a departing convoy outlives its batch', () => {
    for (const [branches, perBranch] of [[4, 3], [12, 4], [24, 6], [24, 20]]) {
        const { harbor, agents } = departure('/w/convoy', branches, perBranch);
        let outlived = 0;
        let batchGoneAt = null;
        for (let t = 2; t <= 260; t += 2) {
            harbor.reconcile(agents, T + t * S);
            if (!harbor.state.batches.has('push-batch:push')) {
                batchGoneAt ??= t;
                outlived = Math.max(outlived, [...harbor.state.ships.values()].filter(ship => ship.status === 'departing').length);
            }
        }
        assert.equal(outlived, 0, `${branches} x ${perBranch}: hulls still sailing after the batch was deleted`);
        assert.ok(batchGoneAt !== null, `${branches} x ${perBranch}: the batch expires`);
        harbor.dispose();
    }
});
