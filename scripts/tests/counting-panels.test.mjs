import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { AgentStatus } from '../../claudeville/src/domain/value-objects/AgentStatus.js';
import { bucketForStatus } from '../../claudeville/src/domain/services/SignalLedger.js';
import {
    DEPARTED_WORD,
    STATUS_WORDS,
    bucketWord,
    isAgedQuietRow,
    silentSignal,
    statusPresentation,
    statusWord,
} from '../../claudeville/src/presentation/shared/AgentPresentation.js';
import { formatStatusElapsed, formatTokens } from '../../claudeville/src/presentation/shared/Formatters.js';
import { TokenUsage } from '../../claudeville/src/domain/value-objects/TokenUsage.js';
import { childRowVisible, leadIdFor, rowTokenCells } from '../../claudeville/src/presentation/dashboard-mode/DashboardRenderer.js';
import { sessionDetailsService } from '../../claudeville/src/presentation/shared/SessionDetailsService.js';
import { operatorStatusLabel } from '../../claudeville/src/presentation/shared/SemanticTriage.js';
import { offFrameTallyText } from '../../claudeville/src/presentation/character-mode/AttentionPlates.js';

const SESSION_STATUSES = [
    AgentStatus.WORKING,
    AgentStatus.WAITING,
    AgentStatus.IDLE,
    AgentStatus.COMPLETED,
    AgentStatus.WAITING_ON_USER,
    AgentStatus.ERRORED,
    AgentStatus.RATE_LIMITED,
];

test('UI-1: each status has one word, and every surface helper reads it', () => {
    const now = 1_000_000;
    for (const status of SESSION_STATUSES) {
        const word = STATUS_WORDS[status];
        assert.ok(word, `${status} has a word`);
        assert.equal(statusWord(status), word);
        assert.equal(statusWord(status, 'upper'), word.toUpperCase());
        assert.equal(statusWord(status, 'lower'), word.toLowerCase());
        assert.equal(statusPresentation(status).label, word, 'panel and row label');
        assert.equal(operatorStatusLabel(status), word, 'Dashboard detail and child strip');
        assert.equal(bucketWord(bucketForStatus(status)), word, 'chips and section counts');
        assert.equal(formatStatusElapsed({ status, statusSince: now - 5_000 }, now).split(' for ')[0], word, 'sidebar age prefix');
    }
});

test('UI-1 (Q4): completed folds into idle, and rate-limited reads LIMIT everywhere', () => {
    assert.equal(statusWord(AgentStatus.COMPLETED), statusWord(AgentStatus.IDLE));
    assert.equal(bucketWord('quiet', 'upper'), 'IDLE');
    assert.equal(statusWord(AgentStatus.RATE_LIMITED, 'upper'), 'LIMIT');
    assert.equal(bucketWord('quota'), 'Limit');
    assert.equal(offFrameTallyText([AgentStatus.COMPLETED, AgentStatus.IDLE]), '2 idle');
    // Attention words keep the actionable states apart.
    const actionable = [AgentStatus.WAITING_ON_USER, AgentStatus.ERRORED, AgentStatus.RATE_LIMITED, AgentStatus.WAITING]
        .map(status => statusWord(status));
    assert.equal(new Set(actionable).size, actionable.length);
});

test('UI-1: no surface keeps a private QUOTA, done or Completed status word', async () => {
    const files = {
        'dashboard-mode/DashboardRenderer.js': /'(QUOTA|Quota|Completed)'/,
        'shared/Sidebar.js': /'(QUOTA|Quota|Completed|done)'/,
        'character-mode/AttentionPlates.js': /'(QUOTA|Quota|Completed|done)'/,
        'shared/Formatters.js': /'(QUOTA|Quota|Completed|done)'/,
    };
    for (const [file, pattern] of Object.entries(files)) {
        const source = await readFile(new URL(`../../claudeville/src/presentation/${file}`, import.meta.url), 'utf8');
        assert.ok(!pattern.test(source), `${file} keeps a private status word: ${source.match(pattern)?.[0]}`);
    }
});

test('UI-4: row TOKENS leads with new tokens and puts cache reads second', () => {
    // A live Claude row: 965K new tokens under 64M of cache reads.
    const usage = { input: 15_000, output: 150_000, cacheCreate: 800_000, cacheRead: 64_000_000 };
    const cells = rowTokenCells(usage);
    assert.equal(TokenUsage.newTokens(usage), 965_000, 'input + output + cache writes, the top bar measure');
    assert.equal(cells.newShort, formatTokens(965_000));
    assert.equal(cells.cacheShort, `+${formatTokens(64_000_000)}`);
    assert.match(cells.title, /new tokens \(input, output, cache writes\) · .* cache reads/);
    assert.equal(rowTokenCells({ input: 10, output: 5 }).cacheShort, '', 'no cache line without cache reads');
    assert.deepEqual(rowTokenCells(null), { newShort: '—', cacheShort: '', title: 'Usage unavailable' });
});

test('UI-5: a silent working agent climbs the hourglass rungs and never age-dims', () => {
    const now = 10_000_000;
    const at = (ms, extra = {}) => ({ status: AgentStatus.WORKING, lastSessionActivity: now - ms, activityAgeMs: ms, ...extra });
    assert.equal(silentSignal(at(119_000), now), null, 'under 2 min is not silent');
    assert.deepEqual([2, 5, 15].map(min => silentSignal(at(min * 60_000), now).tier), [1, 2, 3]);
    assert.equal(silentSignal(at(18 * 60_000), now).text, 'silent 18m');
    // A tool-pending agent resolves WORKING, so it reads the same way.
    assert.equal(silentSignal(at(6 * 60_000, { turnState: 'tool_pending' }), now).tier, 2);
    for (const status of [AgentStatus.IDLE, AgentStatus.COMPLETED, AgentStatus.WAITING_ON_USER, AgentStatus.ERRORED]) {
        assert.equal(silentSignal(at(30 * 60_000, { status }), now), null, `${status} is never "silent"`);
    }
    assert.equal(silentSignal(at(30 * 60_000, { departedAt: now, isDeparted: true }), now), null);
    // Only quiet rows dim with age.
    assert.equal(isAgedQuietRow(at(30 * 60_000)), false, 'working never age-dims');
    assert.equal(isAgedQuietRow(at(30 * 60_000, { status: AgentStatus.RATE_LIMITED })), false);
    assert.equal(isAgedQuietRow(at(30 * 60_000, { status: AgentStatus.COMPLETED })), true);
    assert.equal(isAgedQuietRow(at(14 * 60_000, { status: AgentStatus.IDLE })), false);
});

test('UI-8: the detail refetches as soon as the snapshot moves past its entry', async () => {
    const calls = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
        calls.push(String(url));
        const n = calls.length;
        return { ok: true, json: async () => ({ toolHistory: [{ n }] }) };
    };
    const agent = { id: 'ui8-agent', provider: 'claude', projectPath: '/ui8', lastSessionActivity: 1_000, status: 'working', tokens: { input: 1, output: 1 } };
    try {
        await sessionDetailsService.fetchSessionDetail(agent);
        await sessionDetailsService.fetchSessionDetail(agent);
        assert.equal(calls.length, 1, 'an unchanged snapshot inside the TTL is a cache hit');
        agent.lastSessionActivity = 2_000;
        const moved = await sessionDetailsService.fetchSessionDetail(agent);
        assert.equal(calls.length, 2, 'a moved snapshot fetches at once, not after the 5 s TTL');
        assert.deepEqual(moved.toolHistory, [{ n: 2 }], 'and the caller gets the fresh detail on this poll');
        agent.tokens = { input: 5, output: 1 };
        const batch = await sessionDetailsService.fetchSessionDetailsBatch([agent]);
        assert.equal(calls.length, 3, 'the Dashboard batch follows the same stamp');
        assert.ok(batch.has(agent.id));
    } finally {
        globalThis.fetch = realFetch;
        sessionDetailsService.deleteForAgent(agent);
    }
});

test('UI-16 (Q5): a subagent row folds under its lead unless selected, filtered, needing you or unfolded', () => {
    const liveIds = new Set(['lead', 'mid']);
    const child = { id: 'kid', parentSessionId: 'lead', status: AgentStatus.WORKING };
    assert.equal(leadIdFor(child), 'lead');
    assert.equal(childRowVisible(child, { liveIds }), false, 'folded by default');
    assert.equal(childRowVisible(child, { liveIds, selectedId: 'kid' }), true, 'selected');
    assert.equal(childRowVisible(child, { liveIds, filtered: true }), true, 'matched by a search or filter');
    assert.equal(childRowVisible({ ...child, status: AgentStatus.WAITING_ON_USER }, { liveIds }), true, 'needs you');
    assert.equal(childRowVisible(child, { liveIds, expandedLeads: new Set(['lead']) }), true, 'the lead toggle unfolds it');
    assert.equal(childRowVisible({ id: 'lead', status: AgentStatus.WORKING }, { liveIds }), true, 'a lead always has its row');
    assert.equal(childRowVisible({ ...child, parentSessionId: 'gone' }, { liveIds }), true, 'an orphan keeps its row');
    // A nested subagent folds under its root when the adapter names one.
    const nested = { id: 'grandkid', parentSessionId: 'mid', rootSessionId: 'lead', status: AgentStatus.WORKING };
    assert.equal(leadIdFor(nested), 'lead');
    assert.equal(childRowVisible(nested, { liveIds, expandedLeads: new Set(['lead']) }), true);
    assert.equal(leadIdFor({ id: 'lead', rootSessionId: 'lead' }), '', 'a root naming itself is a lead');
});

test('UI-13: a departed villager is aged from its departure', () => {
    const now = 2_000_000;
    const departed = { status: AgentStatus.COMPLETED, statusSince: now - 600_000, departedAt: now - 30_000, isDeparted: true };
    assert.equal(formatStatusElapsed(departed, now), `${DEPARTED_WORD} 30s ago`);
});
