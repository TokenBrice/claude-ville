import test from 'node:test';
import assert from 'node:assert/strict';

import {
    BELFRY_DRAIN_MS,
    BELFRY_LEVELS,
    belfryDrainStep,
    belfryDraining,
    belfryGlass,
    belfryGlassKey,
    belfryGlasses,
    belfryLevel,
    belfryTooltip,
} from '../../claudeville/src/presentation/character-mode/BelfryQuota.js';

const HOUR = 3_600_000;

test('quota left maps to five hard sand steps, and spent is the empty glass', () => {
    assert.equal(BELFRY_LEVELS, 5);
    const cases = [[1, 5], [0.8, 5], [0.79, 4], [0.6, 4], [0.59, 3], [0.4, 3], [0.39, 2], [0.2, 2], [0.19, 1], [0.01, 1], [0, 0], [-0.2, 0], [null, 0]];
    for (const [left, level] of cases) assert.equal(belfryLevel(left), level, `${left} left`);
});

test('the Claude glass reads the fuller window and never words a LIMIT', () => {
    const glass = belfryGlass('claude', { quota: { fiveHour: 0.27, sevenDay: 0.62 } });
    assert.deepEqual(glass, { state: 'level', level: 2, used: 0.62 }, 'the 7-day window binds');
    assert.equal(belfryGlass('claude', { quota: { fiveHour: 0.1, sevenDay: null } }).level, 5);
    // Claude utilization is pressure, never evidence of enforcement.
    assert.deepEqual(belfryGlass('claude', { quota: { fiveHour: 1, sevenDay: 1 } }), { state: 'level', level: 0, used: 1 });
    for (const usage of [null, {}, { quota: { fiveHour: null, sevenDay: null } }, { quota: { fiveHour: 0.2 }, quotaError: { status: 401, at: 1 } }]) {
        assert.equal(belfryGlass('claude', usage).state, 'unknown', JSON.stringify(usage));
    }
    // A throttled check keeps its last reading.
    assert.equal(belfryGlass('claude', { quota: { fiveHour: 0.5 }, quotaError: { status: 429, at: 1 } }).state, 'level');
});

test('the Codex glass shows its window, its LIMIT, and no fake reading after a reset', () => {
    assert.deepEqual(belfryGlass('codex', { codex: { usedPercent: 16, limitReached: false } }), { state: 'level', level: 5, used: 0.16 });
    assert.equal(belfryGlass('codex', { codex: { usedPercent: 63, limitReached: false } }).level, 2);
    assert.deepEqual(belfryGlass('codex', { codex: { usedPercent: 100, limitReached: true } }), { state: 'limit', level: 0, used: 1 });
    assert.equal(belfryGlass('codex', { codex: { usedPercent: 40, limitReached: true } }).state, 'limit', 'a reported rate_limit_reached_type');
    for (const usage of [null, {}, { codex: null }, { codex: { usedPercent: null, resetsAt: null, limitReached: false } }]) {
        assert.equal(belfryGlass('codex', usage).state, 'unknown', JSON.stringify(usage));
    }
});

test('each glass draws one state key', () => {
    const glasses = belfryGlasses({ quota: { fiveHour: 0.27, sevenDay: 0.23 }, codex: { usedPercent: 100, limitReached: true } });
    assert.deepEqual([belfryGlassKey(glasses.claude), belfryGlassKey(glasses.codex)], ['l4', 'limit']);
    assert.equal(belfryGlassKey(belfryGlass('codex', {})), 'unknown');
    assert.equal(belfryGlassKey(null), 'unknown');
});

test('the hover names both windows, the reset countdowns, credits and the reading age', () => {
    const now = 2_000_000_000;
    const usage = {
        quota: { fiveHour: 0.62, sevenDay: 0.88, fiveHourResetsAt: now + 72 * 60_000, sevenDayResetsAt: now + 51 * HOUR },
        quotaError: null,
        codex: {
            usedPercent: 100, windowMinutes: 10080, resetsAt: now + 98 * HOUR,
            credits: { balance: 2510.33, hasCredits: true, unlimited: false },
            limitReached: true, observedAt: now - 3 * HOUR,
        },
    };
    const [title, claude, codex] = belfryTooltip(usage, now).split('\n');
    assert.equal(title, 'Hourglass Belfry · sand left = quota left');
    assert.equal(claude, 'Claude: 5-hour 62% used, resets in 1h12m · 7-day 88% used, resets in 2d3h');
    assert.equal(codex, 'Codex: at its weekly limit · 100% used, resets in 4d2h · 2.5K credits left · seen 3h ago');

    const calm = belfryTooltip({ quota: usage.quota, codex: { ...usage.codex, usedPercent: 16, limitReached: false } }, now).split('\n')[2];
    assert.match(calm, /^Codex: weekly 16% used, resets in 4d2h · /);
    assert.match(belfryTooltip({ ...usage, quotaError: { status: 429, at: now } }, now), /throttled/);
    assert.match(belfryTooltip({ quotaError: { status: 401, at: now } }, now), /sign-in token expired/);
    assert.match(belfryTooltip({ codex: { usedPercent: null, limitReached: false } }, now), /Codex: window reset, no new reading yet/);
    assert.deepEqual(belfryTooltip(null, now).split('\n').slice(1), ['Claude: no quota reading yet.', 'Codex: no quota reading yet.']);
});

// MB-5 — a glass drains while its account spends: its reading rose within
// the last 10 minutes. Only `/api/usage` readings feed it.
test('a glass drains for ten minutes after its reading rises, and a fall or no reading stops it', () => {
    assert.equal(BELFRY_DRAIN_MS, 10 * 60_000);
    const read = (claude, codex) => belfryGlasses({
        quota: { fiveHour: claude, sevenDay: 0 },
        codex: codex === null ? null : { usedPercent: codex, limitReached: false },
    });
    let drain = belfryDrainStep(null, read(0.3, 40), 0);
    assert.equal(belfryDraining(drain, 'claude', 0), false, 'a first reading is no rise');
    drain = belfryDrainStep(drain, read(0.32, 40), 1000);
    assert.equal(belfryDraining(drain, 'claude', 1000), true);
    assert.equal(belfryDraining(drain, 'codex', 1000), false, 'each account its own');
    drain = belfryDrainStep(drain, read(0.32, 40), 300_000);
    assert.equal(belfryDraining(drain, 'claude', 300_000), true, 'an equal reading keeps the rise');
    assert.equal(belfryDraining(drain, 'claude', 1000 + BELFRY_DRAIN_MS - 1), true);
    assert.equal(belfryDraining(drain, 'claude', 1000 + BELFRY_DRAIN_MS), false, 'ten minutes on, it stands still');
    drain = belfryDrainStep(drain, read(0.05, 41), 400_000);
    assert.equal(belfryDraining(drain, 'claude', 400_000), false, 'a window reset is no spend');
    assert.equal(belfryDraining(drain, 'codex', 400_000), true);
    drain = belfryDrainStep(drain, read(0.05, null), 410_000);
    assert.equal(belfryDraining(drain, 'codex', 410_000), false, 'no reading, no drain');
    drain = belfryDrainStep(drain, read(0.05, 45), 420_000);
    assert.equal(belfryDraining(drain, 'codex', 420_000), false, 'the first reading back is no rise');
});
