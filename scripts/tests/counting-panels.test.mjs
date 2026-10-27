import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { AgentStatus } from '../../claudeville/src/domain/value-objects/AgentStatus.js';
import { bucketForStatus } from '../../claudeville/src/domain/services/SignalLedger.js';
import {
    DEPARTED_WORD,
    STATUS_WORDS,
    bucketWord,
    statusPresentation,
    statusWord,
} from '../../claudeville/src/presentation/shared/AgentPresentation.js';
import { formatStatusElapsed } from '../../claudeville/src/presentation/shared/Formatters.js';
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

test('UI-13: a departed villager is aged from its departure', () => {
    const now = 2_000_000;
    const departed = { status: AgentStatus.COMPLETED, statusSince: now - 600_000, departedAt: now - 30_000, isDeparted: true };
    assert.equal(formatStatusElapsed(departed, now), `${DEPARTED_WORD} 30s ago`);
});
