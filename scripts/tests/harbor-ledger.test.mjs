import test from 'node:test';
import assert from 'node:assert/strict';

import {
    assignMonograms,
    harborLedger,
    ledgerAge,
    ledgerBuoyLabel,
    ledgerFailureText,
    ledgerLaneLabel,
    ledgerPlaqueRows,
    middleTruncate,
    repoMonogram,
} from '../../claudeville/src/presentation/shared/HarborLedger.js';
import { buildFleetCardModel } from '../../claudeville/src/presentation/shared/HarborFleetCard.js';

// Phase 4 (U-P3, U-P4, U-P5, U-P6): the one ledger grammar every harbor
// surface reads, and the fleet card's data assembly.

const NOW = Date.UTC(2026, 9, 15, 12, 0, 0);
const MIN = 60_000;
const options = {
    now: NOW,
    nameFor: project => project.split('/').at(-1),
    profileFor: project => ({ key: `k:${project}`, accent: '#123456' }),
};

test('middle truncation keeps both ends of an identifier', () => {
    assert.equal(middleTruncate('claude/feature-very-long-name-1234', 16), 'claude/f…me-1234');
    assert.equal(middleTruncate('main', 16), 'main');
    assert.equal(middleTruncate('abcdefgh', 5), 'ab…gh');
    assert.equal(middleTruncate('claude/feature-very-long-name-1234', 16).length, 16);
});

test('ages and failure lines are short and say which failure', () => {
    assert.equal(ledgerAge(NOW - 5 * 1000, NOW), 'now');
    assert.equal(ledgerAge(NOW - 2 * MIN, NOW), '2m');
    assert.equal(ledgerAge(NOW - 3 * 60 * MIN, NOW), '3h');
    assert.equal(ledgerAge(0, NOW), '');
    assert.equal(
        ledgerFailureText({ status: 'rejected', at: NOW - 2 * MIN, reason: '! [rejected] main -> main (fetch first)' }, NOW),
        'push rejected 2m · ! [rejected] main -> main (fetch first)',
    );
    assert.equal(ledgerFailureText({ status: 'failed', at: NOW - 2 * MIN }, NOW), 'push failed 2m');
});

test('lanes group under their repo, raw names, failures first then oldest', () => {
    const ledger = harborLedger([
        { project: '/w/claude-ville', branch: 'main', pendingCommits: 3, oldestCommitTime: NOW - 21 * MIN },
        { project: '/w/claude-ville', branch: 'feat/harbor-cards', pendingCommits: 2, oldestCommitTime: NOW - 40 * MIN, worktree: { name: 'agent-a1b2c3', isMain: false } },
        { project: '/w/pharos-watch', branch: 'main', pendingCommits: 2, oldestCommitTime: NOW - 5 * MIN, failedPushes: 1, latestFailureAt: NOW - 2 * MIN, failureStatus: 'rejected', failureReason: 'fetch first' },
        { project: '/w/epsilon-ui', branch: 'main', pendingCommits: 1, oldestCommitTime: NOW - 90 * MIN },
        { project: '/w/empty', branch: 'main', pendingCommits: 0 },
    ], options);

    assert.deepEqual(ledger.groups.map(group => group.name), ['pharos-watch', 'epsilon-ui', 'claude-ville']);
    assert.equal(ledger.total, 8);
    const cv = ledger.groups[2];
    assert.equal(cv.count, 5);
    assert.deepEqual(cv.lanes.map(lane => lane.branch), ['feat/harbor-cards', 'main'], 'oldest lane first');
    assert.equal(cv.lanes[0].kind, 'worktree');
    assert.equal(cv.lanes[1].kind, 'default');
    assert.equal(ledgerLaneLabel(cv.lanes[0]), 'feat/harbor-cards · wt agent-a1b2c3');
    assert.equal(ledger.groups[0].failure.status, 'rejected');
    assert.equal(ledger.groups[0].failure.reason, 'fetch first');
});

test('a failure with nothing docked still makes a row; cut lists say +N', () => {
    const rows = Array.from({ length: 6 }, (_, index) => ({
        project: `/w/repo-${index}`, branch: 'main', pendingCommits: index + 1, oldestCommitTime: NOW - (index + 1) * MIN,
    }));
    rows.push({ project: '/w/broken', branch: 'main', pendingCommits: 0, failedPushes: 1, latestFailureAt: NOW - MIN });
    const ledger = harborLedger(rows, { ...options, maxGroups: 3 });
    assert.equal(ledger.groups[0].name, 'broken');
    assert.equal(ledger.groups.length, 3);
    assert.equal(ledger.hiddenGroups, 4);
    assert.equal(ledger.hiddenCommits, 1 + 2 + 3 + 4);
});

test('plaque rows keep the count whole and end with +N more', () => {
    const rows = ledgerPlaqueRows([
        { project: '/w/claude-ville-with-a-long-name', branch: 'claude/feature-very-long-name-1234', pendingCommits: 12, oldestCommitTime: NOW - 9 * MIN },
        { project: '/w/beta', branch: 'main', pendingCommits: 2, oldestCommitTime: NOW - 8 * MIN },
        { project: '/w/beta', branch: 'feat/x1', pendingCommits: 1, oldestCommitTime: NOW - 7 * MIN },
        { project: '/w/gamma', branch: 'main', pendingCommits: 1, oldestCommitTime: NOW - 6 * MIN },
        { project: '/w/delta', branch: 'main', pendingCommits: 4, oldestCommitTime: NOW - 5 * MIN },
    ], { ...options, maxRows: 3 });
    assert.equal(rows.length, 3);
    assert.equal(rows[0].count, 12);
    assert.match(rows[0].name, /…/, 'long repo name truncated in the middle');
    assert.match(rows[0].detail, /^claude\/.*….*1234$/);
    assert.equal(rows[1].detail, '2 branches');
    assert.equal(rows[2].more, true);
    assert.equal(rows[2].label, '+2 more · 5');
});

test('buoy labels keep the count visible however long the name', () => {
    assert.equal(ledgerBuoyLabel('claude-ville', 7), 'claude-ville · 7');
    assert.equal(ledgerBuoyLabel('an-extremely-long-repository-name', 120), 'an-extrem…ory-name · 120');
    assert.equal(ledgerBuoyLabel('quiet', 0), 'quiet');
});

test('monograms are initials, collision-checked in stable key order', () => {
    assert.equal(repoMonogram('claude-ville'), 'CV');
    assert.equal(repoMonogram('alpha'), 'AL');
    assert.equal(repoMonogram('tavern_ledger.js'), 'TLJ');
    const map = assignMonograms([
        { key: 'b', name: 'claude-vault' },
        { key: 'a', name: 'claude-ville' },
        { key: 'c', name: 'pharos-watch' },
        { key: 'd', name: 'claude-viewer' },
    ]);
    assert.equal(map.get('a'), 'CV');
    assert.equal(map.get('b'), 'CV2');
    assert.equal(map.get('d'), 'CV3');
    assert.equal(map.get('c'), 'PW');
});

// ─── fleet card ─────────────────────────────────────────────────────────────

const CV = '/w/claude-ville';
function ship(id, extra = {}) {
    return { id, project: CV, branch: 'main', status: 'docked', sha: `${id}aaaaaaaaaaaa`, label: `subject ${id}`, eventTime: NOW - 10 * MIN, agentId: 'wren', ...extra };
}
const agentName = id => ({ wren: 'Wren', ash: 'Ash' })[id] || '';
const cardOptions = { now: NOW, agentName, nameFor: project => project.split('/').at(-1), profileFor: () => ({ accent: '#6f82c6' }) };

test('fleet card lists a lane newest first with SHA, age and attribution', () => {
    const model = buildFleetCardModel({
        ships: [
            ship('c0ffee1', { eventTime: NOW - 30 * MIN }),
            ship('c0ffee2', { eventTime: NOW - 3 * MIN }),
            ship('c0ffee3', { eventTime: NOW - 9 * MIN, attribution: 'scanned', author: { name: 'Ada' }, coAuthors: ['Claude Opus 5.5'] }),
            ship('feedfa1', { branch: 'feat/x1', agentId: 'ash' }),
            ship('gone001', { status: 'departing' }),
        ],
        pushEvents: [],
    }, { project: CV, branch: 'main' }, cardOptions);

    assert.equal(model.title, 'claude-ville · main');
    assert.equal(model.kind, 'default');
    assert.deepEqual(model.commits.map(commit => commit.sha), ['c0ffee2', 'c0ffee3', 'c0ffee1']);
    assert.equal(model.commits[0].age, '3m');
    assert.equal(model.commits[0].agentLabel, 'by Wren');
    assert.equal(model.commits[0].agentId, 'wren');
    assert.equal(model.commits[1].agentLabel, 'seen by Wren', 'scanned commits are "seen by"');
    assert.equal(model.commits[1].author, 'Ada +1');
    assert.equal(model.commits[1].authors, 'Ada, Claude Opus 5.5');
    assert.deepEqual(model.lanes.map(lane => lane.branch), ['main', 'feat/x1']);
    assert.equal(model.push.status, 'unpushed');
    assert.equal(model.push.text, '3 unpushed · oldest 30m');
});

test('fleet card states a standing failure with its reason and agent', () => {
    const model = buildFleetCardModel({
        ships: [ship('c0ffee1', { pushStatus: 'rejected' })],
        pushEvents: [
            { id: 'p1', project: CV, branch: 'main', status: 'success', eventTime: NOW - 60 * MIN },
            { id: 'p2', project: CV, branch: 'main', status: 'rejected', eventTime: NOW - 2 * MIN, reason: '! [rejected] main -> main (fetch first)', agentId: 'wren' },
        ],
    }, { project: CV, branch: 'main' }, cardOptions);
    assert.equal(model.push.status, 'rejected');
    assert.equal(model.push.text, 'push rejected 2m');
    assert.equal(model.push.reason, '! [rejected] main -> main (fetch first)');
    assert.equal(model.push.agentLabel, 'Wren');
    assert.equal(model.commits[0].status, 'rejected');
});

test('fleet card for a whole repo spans lanes; overflow and cut commits say +N', () => {
    const ships = Array.from({ length: 14 }, (_, index) => ship(`a${String(index).padStart(6, '0')}`, {
        eventTime: NOW - index * MIN,
        branch: index % 2 ? 'feat/x1' : 'main',
        worktree: index % 2 ? { name: 'agent-a1b2c3', path: `${CV}/.claude/worktrees/agent-a1b2c3`, isMain: false } : null,
    }));
    const model = buildFleetCardModel({
        ships,
        overflow: [{ project: CV, branch: 'main', count: 5 }],
    }, { project: CV, branch: null }, { ...cardOptions, limit: 12 });
    assert.equal(model.branch, null);
    assert.equal(model.kindLabel, '2 branches');
    assert.equal(model.commits.length, 12);
    assert.equal(model.hiddenCommits, 2 + 5);
    assert.equal(model.total, 19);
    assert.equal(model.lanes.find(lane => lane.branch === 'feat/x1').kind, 'worktree');

    const worktreeLane = buildFleetCardModel({ ships }, { project: CV, branch: 'feat/x1' }, cardOptions);
    assert.equal(worktreeLane.kind, 'worktree');
    assert.equal(worktreeLane.worktree.name, 'agent-a1b2c3');
});

// ─── chronicle: a failed push is not "pushed" ──────────────────────────────

test('chronicle push outcome: failed, rejected and cancelled pushes keep their outcome', async () => {
    const { pushOutcome } = await import('../../claudeville/src/application/ChronicleLog.js');
    assert.equal(pushOutcome({ type: 'push', status: 'rejected' }), 'rejected');
    assert.equal(pushOutcome({ type: 'push', status: 'canceled' }), 'cancelled');
    assert.equal(pushOutcome({ type: 'push', success: false }), 'failed');
    assert.equal(pushOutcome({ type: 'push', exitCode: 1 }), 'failed');
    assert.equal(pushOutcome({ type: 'push', status: 'success', success: true, exitCode: 0 }), null);
    assert.equal(pushOutcome({ type: 'push' }), null);
});

test('sidebar and dashboard group a worktree agent under its repo', async () => {
    const { projectKeyForAgent, worktreeLabel } = await import('../../claudeville/src/presentation/shared/AgentPresentation.js');
    const wt = { projectPath: '/w/cv/.claude/worktrees/agent-a1b2c3', repoRoot: '/w/cv', worktree: { name: 'agent-a1b2c3', isMain: false } };
    assert.equal(projectKeyForAgent(wt), '/w/cv');
    assert.equal(worktreeLabel(wt), 'wt agent-a1b2c3');
    assert.equal(projectKeyForAgent({ projectPath: '/w/old' }), '/w/old', 'older servers fall back to the checkout');
    assert.equal(worktreeLabel({ projectPath: '/w/cv', repoRoot: '/w/cv', worktree: { name: 'cv', isMain: true } }), '');
    assert.equal(projectKeyForAgent({}), '_unknown');
});
