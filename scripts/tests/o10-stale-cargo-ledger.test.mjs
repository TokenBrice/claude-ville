import test from 'node:test';
import assert from 'node:assert/strict';

import { pendingRepoSummariesFromDockSummaries } from '../../claudeville/src/presentation/character-mode/HarborTraffic.js';
import { harborLedger } from '../../claudeville/src/presentation/shared/HarborLedger.js';

const DAY_MS = 24 * 60 * 60_000;
const NOW = Date.UTC(2026, 8, 5, 12, 0, 0);

function profile(key, accent = '#ffd56a') {
    return { key, shortName: key, name: key, accent, labelText: accent, panel: '#111', panelBorder: accent };
}

test('pending repo summaries retain the oldest commit across dock zones', () => {
    const alpha = profile('alpha/main');
    const unknown = profile('unknown/main');
    const summaries = new Map([
        ['alpha-harbor', {
            project: '/repos/alpha', branch: 'main', profile: alpha, count: 2,
            failedCount: 0, latestEventTime: NOW - 5 * 60 * 60_000,
            earliestEventTime: NOW - 2 * DAY_MS, waitingZone: 'harbor',
        }],
        ['alpha-storage', {
            project: '/repos/alpha', branch: 'main', profile: alpha, count: 1,
            failedCount: 0, latestEventTime: NOW - 4 * 60 * 60_000,
            earliestEventTime: NOW - 6 * DAY_MS, waitingZone: 'commit-lagoon',
        }],
        ['unknown-overflow', {
            project: '/repos/unknown', branch: 'main', profile: unknown, count: 3,
            failedCount: 0, latestEventTime: NOW - 60_000,
            earliestEventTime: 0, waitingZone: 'harbor',
        }],
    ]);

    const rows = pendingRepoSummariesFromDockSummaries(summaries);
    const alphaRow = rows.find(row => row.project === '/repos/alpha');
    const unknownRow = rows.find(row => row.project === '/repos/unknown');
    assert.equal(alphaRow.pendingCommits, 3);
    assert.equal(alphaRow.oldestCommitTime, NOW - 6 * DAY_MS);
    assert.equal(unknownRow.oldestCommitTime, 0);
});

// U-P4 — one ledger order: a standing failure first, then the oldest
// pending commit, unknown ages last.
const ledgerOptions = { now: NOW, nameFor: project => project.split('/').at(-1), profileFor: project => profile(project) };

test('harbor ledger puts failures first, then oldest pending, and drops empty lanes', () => {
    const { groups } = harborLedger([
        { project: '/repos/alpha', branch: 'main', pendingCommits: 4, failedPushes: 0, oldestCommitTime: NOW - 2 * DAY_MS },
        { project: '/repos/beta', branch: 'feature/leaks', pendingCommits: 2, failedPushes: 0, oldestCommitTime: NOW - 6 * DAY_MS },
        { project: '/repos/capped', branch: 'release', pendingCommits: 120, failedPushes: 1, latestFailureAt: NOW - 60_000, oldestCommitTime: 0 },
        { project: '/repos/empty', branch: 'main', pendingCommits: 0, failedPushes: 0, oldestCommitTime: NOW - 8 * DAY_MS },
    ], ledgerOptions);

    assert.deepEqual(groups.map(group => group.name), ['capped', 'beta', 'alpha']);
    assert.equal(groups[1].lanes[0].ageLabel, '6d');
    assert.equal(groups[0].failure.status, 'failed');
});

test('unknown-age lanes sort after known ages, then by count', () => {
    const { groups } = harborLedger([
        { project: '/r/zeta', branch: 'main', pendingCommits: 8, oldestCommitTime: 0 },
        { project: '/r/alpha', branch: 'main', pendingCommits: 1, oldestCommitTime: 0 },
        { project: '/r/known', branch: 'main', pendingCommits: 1, oldestCommitTime: NOW - 60_000 },
    ], ledgerOptions);

    assert.deepEqual(groups.map(group => group.name), ['known', 'zeta', 'alpha']);
});
