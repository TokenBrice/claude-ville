import test from 'node:test';
import assert from 'node:assert/strict';

import {
    QUOTA_PILLAR_DRAIN_MS,
    QUOTA_PILLAR_LEVELS,
    quotaDrainStep,
    quotaDraining,
    quotaPillarKey,
    quotaPillarLevel,
    quotaPillarReading,
    quotaPillarReadings,
    quotaPillarTooltip,
} from '../../claudeville/src/presentation/character-mode/QuotaTerrace.js';
import {
    BELFRY_DRAIN_MS,
    BELFRY_LEVELS,
    belfryGlass,
    belfryLevel,
} from '../../claudeville/src/presentation/character-mode/BelfryQuota.js';

const HOUR = 3_600_000;

test('quota left maps to five hard runic steps, and spent is level 0', () => {
    assert.equal(QUOTA_PILLAR_LEVELS, 5);
    assert.equal(BELFRY_LEVELS, 5);
    const cases = [[1, 5], [0.8, 5], [0.79, 4], [0.6, 4], [0.59, 3], [0.4, 3], [0.39, 2], [0.2, 2], [0.19, 1], [0.01, 1], [0, 0], [-0.2, 0], [null, 0]];
    for (const [left, level] of cases) {
        assert.equal(quotaPillarLevel(left), level, `${left} left`);
        assert.equal(belfryLevel(left), level, `compat alias ${left} left`);
    }
});

test('Claude pillar reads weekly (sevenDay) quota left, keeps fiveHour metadata, and never words LIMIT', () => {
    const reading = quotaPillarReading('claude', { quota: { fiveHour: 0.18, sevenDay: 0.38 } });
    assert.equal(reading.state, 'level');
    assert.equal(reading.level, 4); // 62% left -> l4
    assert.equal(reading.used, 0.38);
    assert.equal(reading.leftPercent, 62);
    assert.equal(reading.fiveHourPercent, 18);

    // If sevenDay is null/unknown, Claude pillar wears the unknown shroud (never falls back to 5h).
    assert.equal(quotaPillarReading('claude', { quota: { fiveHour: 0.1, sevenDay: null } }).state, 'unknown');
    // Claude utilization is pressure, never LIMIT enforcement.
    const full = quotaPillarReading('claude', { quota: { fiveHour: 1, sevenDay: 1 } });
    assert.equal(full.state, 'level');
    assert.equal(full.level, 0);
    for (const usage of [null, {}, { quota: { fiveHour: null, sevenDay: null } }, { quota: { sevenDay: 0.2 }, quotaError: { status: 401, at: 1 } }]) {
        assert.equal(quotaPillarReading('claude', usage).state, 'unknown', JSON.stringify(usage));
    }
    // A throttled check (429) keeps its last weekly reading.
    assert.equal(quotaPillarReading('claude', { quota: { sevenDay: 0.5 }, quotaError: { status: 429, at: 1 } }).state, 'level');
    assert.equal(belfryGlass('claude', { quota: { sevenDay: 0.38 } }).level, 4);
});

test('Codex, GLM, and Antigravity pillars read weekly quota, LIMIT seals, and unknown shrouds', () => {
    // Codex
    const codex = quotaPillarReading('codex', { codex: { usedPercent: 44, limitReached: false } });
    assert.equal(codex.state, 'level');
    assert.equal(codex.level, 3); // 56% left -> l3
    assert.equal(quotaPillarReading('codex', { codex: { usedPercent: 100, limitReached: true } }).state, 'limit');
    assert.equal(quotaPillarReading('codex', { codex: { usedPercent: 40, limitReached: true } }).state, 'limit');
    for (const usage of [null, {}, { codex: null }, { codex: { usedPercent: null, resetsAt: null, limitReached: false } }]) {
        assert.equal(quotaPillarReading('codex', usage).state, 'unknown', JSON.stringify(usage));
    }

    // GLM
    const glm = quotaPillarReading('glm', { glm: { plan: 'Pro', weekly: { usedPercent: 12 }, fiveHour: { usedPercent: 4 } } });
    assert.equal(glm.state, 'level');
    assert.equal(glm.level, 5); // 88% left -> l5
    assert.equal(glm.fiveHourPercent, 4);
    assert.equal(glm.plan, 'Pro');
    assert.equal(quotaPillarReading('glm', { glm: { weekly: { usedPercent: 100 } } }).state, 'limit');
    assert.equal(quotaPillarReading('glm', { glm: { weekly: { usedPercent: 12 }, error: { status: 401 } } }).state, 'unknown');

    // Antigravity (Gemini Weekly + 3P shared metadata)
    const ag = quotaPillarReading('antigravity', {
        antigravity: {
            source: 't3-cache',
            geminiWeekly: { usedPercent: 26 },
            sharedWeekly: { usedPercent: 12 },
            geminiFiveHour: { usedPercent: 5 },
        },
    });
    assert.equal(ag.state, 'level');
    assert.equal(ag.level, 4); // 74% left -> l4
    assert.equal(ag.sharedWeeklyLeftPercent, 88);
    assert.equal(ag.geminiFiveHourPercent, 5);
    assert.equal(quotaPillarReading('antigravity', { antigravity: { geminiWeekly: { usedPercent: 100 } } }).state, 'limit');
    assert.equal(quotaPillarReading('antigravity', { antigravity: null }).state, 'unknown');
});

test('each pillar draws one state key', () => {
    const readings = quotaPillarReadings({
        quota: { sevenDay: 0.23 },
        codex: { usedPercent: 100, limitReached: true },
        glm: { weekly: { usedPercent: 12 } },
        antigravity: { geminiWeekly: { usedPercent: 26 } },
    });
    assert.deepEqual(
        ['claude', 'codex', 'glm', 'antigravity'].map((p) => quotaPillarKey(readings[p])),
        ['l4', 'limit', 'l5', 'l4'],
    );
    assert.equal(quotaPillarKey(quotaPillarReading('codex', {})), 'unknown');
    assert.equal(quotaPillarKey(null), 'unknown');
});

test('per-pillar hover plates return crisp 2-line copy for all four providers', () => {
    const now = Date.UTC(2026, 10, 26, 12, 0);
    const usage = {
        quota: { fiveHour: 0.18, sevenDay: 0.38, fiveHourResetsAt: now + 72 * 60_000, sevenDayResetsAt: now + (3 * 24 + 4) * HOUR },
        quotaError: null,
        codex: {
            usedPercent: 44, windowMinutes: 10080, resetsAt: now + (4 * 24 + 2) * HOUR,
            credits: { balance: 2510.33, hasCredits: true, unlimited: false },
            limitReached: false, observedAt: now - 3 * HOUR,
        },
        glm: {
            plan: 'Coding Pro',
            weekly: { usedPercent: 12, resetsAt: now + (5 * 24 + 1) * HOUR },
            fiveHour: { usedPercent: 4, resetsAt: now + 3 * HOUR },
        },
        antigravity: {
            source: 't3-cache',
            geminiWeekly: { usedPercent: 26, resetsAt: now + 2 * 24 * HOUR },
            sharedWeekly: { usedPercent: 12, resetsAt: now + 2 * 24 * HOUR },
        },
    };

    assert.deepEqual(quotaPillarTooltip('claude', usage, now).split('\n'), [
        'Claude Weekly · 62% left',
        'Resets in 3d 4h · 5h: 18% used',
    ]);
    assert.deepEqual(quotaPillarTooltip('codex', usage, now).split('\n'), [
        'Codex Weekly · 56% left',
        'Resets in 4d 2h · Credits 2.5K',
    ]);
    assert.deepEqual(quotaPillarTooltip('glm', usage, now).split('\n'), [
        'GLM Weekly · 88% left',
        'Resets in 5d 1h · 5h: 4% used',
    ]);
    assert.deepEqual(quotaPillarTooltip('antigravity', usage, now).split('\n'), [
        'Gemini Weekly · 74% left',
        '3P shared 88% left · Resets in 2d',
    ]);

    assert.deepEqual(quotaPillarTooltip('claude', { quotaError: { status: 401, at: now } }, now).split('\n'), [
        'Claude Weekly · Unavailable',
        'Sign-in expired (401)',
    ]);
    assert.deepEqual(quotaPillarTooltip('codex', { codex: { usedPercent: null, limitReached: false } }, now).split('\n'), [
        'Codex Weekly · Unavailable',
        'Window reset · no new reading yet',
    ]);
    assert.deepEqual(quotaPillarTooltip('glm', null, now).split('\n'), [
        'GLM Weekly · Unavailable',
        'No local quota observed yet',
    ]);
});

// MB-5 — a pillar runs its spend trickle while its provider's reading rose
// within the last 10 minutes. Only `/api/usage` readings feed it.
test('each pillar drains independently for ten minutes after its reading rises, and a fall or no reading stops it', () => {
    assert.equal(QUOTA_PILLAR_DRAIN_MS, 10 * 60_000);
    assert.equal(BELFRY_DRAIN_MS, QUOTA_PILLAR_DRAIN_MS);
    const read = (claude, codex, glm = 10, ag = 20) => quotaPillarReadings({
        quota: { sevenDay: claude },
        codex: codex === null ? null : { usedPercent: codex, limitReached: false },
        glm: glm === null ? null : { weekly: { usedPercent: glm } },
        antigravity: ag === null ? null : { geminiWeekly: { usedPercent: ag } },
    });
    let drain = quotaDrainStep(null, read(0.3, 40, 10, 20), 0);
    assert.equal(quotaDraining(drain, 'claude', 0), false, 'a first reading is no rise');
    drain = quotaDrainStep(drain, read(0.32, 40, 14, 20), 1000);
    assert.equal(quotaDraining(drain, 'claude', 1000), true);
    assert.equal(quotaDraining(drain, 'glm', 1000), true);
    assert.equal(quotaDraining(drain, 'codex', 1000), false, 'each provider its own');
    assert.equal(quotaDraining(drain, 'antigravity', 1000), false);
    drain = quotaDrainStep(drain, read(0.32, 40, 14, 20), 300_000);
    assert.equal(quotaDraining(drain, 'claude', 300_000), true, 'an equal reading keeps the rise');
    assert.equal(quotaDraining(drain, 'claude', 1000 + QUOTA_PILLAR_DRAIN_MS - 1), true);
    assert.equal(quotaDraining(drain, 'claude', 1000 + QUOTA_PILLAR_DRAIN_MS), false, 'ten minutes on, it stands still');
    drain = quotaDrainStep(drain, read(0.05, 41, 14, 25), 400_000);
    assert.equal(quotaDraining(drain, 'claude', 400_000), false, 'a window reset is no spend');
    assert.equal(quotaDraining(drain, 'codex', 400_000), true);
    assert.equal(quotaDraining(drain, 'antigravity', 400_000), true);
    drain = quotaDrainStep(drain, read(0.05, null, 14, 25), 410_000);
    assert.equal(quotaDraining(drain, 'codex', 410_000), false, 'no reading, no drain');
    drain = quotaDrainStep(drain, read(0.05, 45, 14, 25), 420_000);
    assert.equal(quotaDraining(drain, 'codex', 420_000), false, 'the first reading back is no rise');
});

test('SG-3: the Dashboard quota card carries the short balance change and the Claude limit facts', async () => {
    const { formatCreditChange, quotaLimitFacts } = await import('../../claudeville/src/presentation/shared/Formatters.js');
    assert.equal(formatCreditChange({ delta: -31.83273775, intervalMs: 60_000 }, { short: true }), 'fell 31.83 in 1m');
    assert.equal(formatCreditChange({ delta: 0, intervalMs: 60_000 }, { short: true }), '2 readings 1m apart agreed');
    assert.equal(formatCreditChange({ delta: 1e-14, intervalMs: 60_000 }), 'balance rose under 0.01 credits between readings 1m apart');
    assert.equal(formatCreditChange(null), '');
    assert.equal(formatCreditChange({ delta: 'x', intervalMs: 1 }), '');
    assert.deepEqual(quotaLimitFacts({ kind: 'weekly_all', scope: null, severity: 'warning', usedPercent: 68.4, resetsAt: 5 }),
        { label: 'weekly', used: 68.4, usedText: '68%', severity: 'warning', warn: true, resetsAt: 5 });
    assert.equal(quotaLimitFacts({ kind: 'session', severity: 'normal', usedPercent: 3 }).warn, false, 'calm by default');
    assert.equal(quotaLimitFacts({ kind: 'opus_daily', severity: 'normal', usedPercent: 3 }).label, 'opus daily');
    assert.equal(quotaLimitFacts(undefined), null);
});
