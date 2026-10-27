import test from 'node:test';
import assert from 'node:assert/strict';

import {
    initialVillageState,
    LinkState,
    linkDown,
    reduceVillageState,
    VillagePhase,
} from '../../claudeville/src/application/VillageState.js';
import { World } from '../../claudeville/src/domain/entities/World.js';
import { AgentStatus } from '../../claudeville/src/domain/value-objects/AgentStatus.js';
import { shortcutBlocked } from '../../claudeville/src/presentation/shared/ShortcutGuard.js';
import {
    claudeQuotaView,
    codexAccountLimit,
    connectionChip,
    quotaCaption,
} from '../../claudeville/src/presentation/shared/TopBar.js';

function villageAfter(actions) {
    return actions.reduce((state, action) => reduceVillageState(state, action), initialVillageState());
}

const HEALTHY = { type: 'providers', providers: [{ id: 'claude', health: 'healthy', sessions: 3 }] };

function agent(id, status, { departed = false } = {}) {
    return { id, status, isDeparted: departed, tokens: {}, cost: 0 };
}

function worldOf(agents) {
    const world = new World();
    for (const entry of agents) world.agents.set(entry.id, entry);
    return world;
}

test('the top-bar KPIs sum to the agent count, completed counted as idle (UI-1, Q4)', () => {
    const world = worldOf([
        agent('w1', AgentStatus.WORKING),
        agent('w2', AgentStatus.WORKING),
        agent('i1', AgentStatus.IDLE),
        agent('c1', AgentStatus.COMPLETED),
        agent('c2', AgentStatus.COMPLETED),
        agent('q1', AgentStatus.WAITING),
        agent('n1', AgentStatus.WAITING_ON_USER),
        agent('e1', AgentStatus.ERRORED),
        agent('l1', AgentStatus.RATE_LIMITED),
    ]);
    const stats = world.getStats();
    assert.deepEqual(
        { working: stats.working, idle: stats.idle, waiting: stats.waiting, attention: stats.attention, total: stats.total },
        { working: 2, idle: 3, waiting: 1, attention: 3, total: 9 },
    );
    assert.equal(stats.working + stats.idle + stats.waiting + stats.attention, stats.total);
});

test('a departed villager is in neither the idle count nor the total', () => {
    const world = worldOf([
        agent('w1', AgentStatus.WORKING),
        agent('c1', AgentStatus.COMPLETED),
        agent('gone', AgentStatus.COMPLETED, { departed: true }),
    ]);
    const stats = world.getStats();
    assert.equal(stats.idle, 1);
    assert.equal(stats.total, 2);
    assert.equal(stats.working + stats.idle + stats.waiting + stats.attention, stats.total);
});

test('getStats no longer carries the dead lifetime totals (UI-14)', () => {
    const stats = worldOf([agent('w1', AgentStatus.WORKING)]).getStats();
    assert.equal('totalCost' in stats, false);
    assert.equal('totalTokens' in stats, false);
});

test('a server outage reads RECONNECTING n, not DEGRADED (EN-1)', () => {
    const state = villageAfter([
        HEALTHY,
        { type: 'snapshot', source: 'websocket', agentCount: 3, at: 1_000 },
        // The REST fallback fails first, then the socket starts retrying.
        { type: 'source-failed', code: 'session-poll-failed' },
        { type: 'link', state: LinkState.RECONNECTING, attempts: 4, nextRetryAt: 9_000, lastErrorCode: 'socket-closed' },
    ]);
    assert.equal(state.phase, VillagePhase.DEGRADED);
    assert.equal(linkDown(state, 2_000), true);
    assert.deepEqual(connectionChip(state, 2_000), { label: 'RECONNECTING 4', state: LinkState.RECONNECTING, stale: false });
});

test('a silent link reads STALE with its age before DEGRADED (EN-1)', () => {
    const state = villageAfter([
        HEALTHY,
        { type: 'snapshot', source: 'polling', agentCount: 3, at: 1_000 },
        { type: 'source-failed', code: 'session-poll-failed' },
    ]);
    assert.equal(state.phase, VillagePhase.DEGRADED);
    const chip = connectionChip(state, 21_000);
    assert.equal(chip.label, 'STALE / last seen 20s ago');
    assert.equal(chip.state, LinkState.STALE);
    assert.equal(chip.stale, true);
});

test('a provider that cannot be read behind a live link still reads DEGRADED', () => {
    const state = villageAfter([
        { type: 'providers', providers: [{ id: 'codex', health: 'degraded' }] },
        { type: 'snapshot', source: 'websocket', agentCount: 2, at: 1_000 },
        { type: 'link', state: LinkState.LIVE },
    ]);
    assert.equal(state.phase, VillagePhase.DEGRADED);
    assert.equal(linkDown(state, 2_000), false);
    assert.equal(connectionChip(state, 2_000).label, 'DEGRADED');
});

test('one shortcut guard: no key acts while typing, under the modal or a popover, or on a repeat (UI-11)', () => {
    const doc = ({ modalOpen = false, popoverOpen = false } = {}) => ({
        getElementById: id => (id === 'modalOverlay' ? { getAttribute: () => (modalOpen ? 'false' : 'true') } : null),
        querySelector: () => (popoverOpen ? {} : null),
    });
    const key = (tagName = 'BODY', extra = {}) => ({ key: 'a', target: { tagName }, repeat: false, ...extra });
    assert.equal(shortcutBlocked(key(), { doc: doc() }), false);
    for (const tag of ['INPUT', 'TEXTAREA', 'SELECT']) assert.equal(shortcutBlocked(key(tag), { doc: doc() }), true, tag);
    assert.equal(shortcutBlocked(key('DIV', { target: { tagName: 'DIV', isContentEditable: true } }), { doc: doc() }), true);
    assert.equal(shortcutBlocked(key(), { doc: doc({ modalOpen: true }) }), true, 'under the modal');
    assert.equal(shortcutBlocked(key(), { doc: doc({ popoverOpen: true }) }), true, 'under an auto popover');
    assert.equal(shortcutBlocked(key('BODY', { repeat: true }), { doc: doc() }), true, 'a held key');
});

test('the quota unit shows the fuller Claude window, its countdown and the pressure cue (SV-7)', () => {
    const now = 1_000_000_000;
    const HOUR = 3_600_000;
    const usage = {
        quota: { fiveHour: 0.62, sevenDay: 0.88, fiveHourResetsAt: now + 72 * 60_000, sevenDayResetsAt: now + 51 * HOUR },
        quotaError: null,
    };
    const view = claudeQuotaView(usage, now);
    assert.equal(view.value, '88%');
    assert.equal(view.pressure, true, '7-day at 88 % is pressure');
    assert.equal(quotaCaption(view, now), '7D · 2D3H');
    assert.equal(view.tip, 'Claude quota · 5-hour 62%, resets in 1h12m · 7-day 88%, resets in 2d3h');

    const calm = claudeQuotaView({ quota: { fiveHour: 0.4, sevenDay: 0.2, fiveHourResetsAt: now + 30 * 60_000 } }, now);
    assert.deepEqual([calm.value, calm.pressure, quotaCaption(calm, now)], ['40%', false, '5H · 30M']);
    assert.equal(quotaCaption(claudeQuotaView({ quota: { fiveHour: 0.4 } }, now), now), '5H QUOTA', 'no reset known');

    const expired = claudeQuotaView({ quota: { fiveHour: null, sevenDay: null }, quotaError: { status: 401, at: now } }, now);
    assert.deepEqual([expired.value, quotaCaption(expired, now)], ['—', 'TOKEN EXPIRED']);
    assert.match(claudeQuotaView({ ...usage, quotaError: { status: 429, at: now } }, now).tip, /throttled/);

    // Absent fields hide the unit: an old server, or no Claude quota at all.
    assert.equal(claudeQuotaView(null, now), null);
    assert.equal(claudeQuotaView({ quota: { fiveHour: null, sevenDay: null } }, now), null);
});

test('the account LIMIT comes from the Codex window alone, never a session (Q3)', () => {
    const now = 2_000_000_000;
    const limited = codexAccountLimit({
        codex: {
            usedPercent: 100, windowMinutes: 10080, resetsAt: now + 98 * 3_600_000,
            credits: { balance: 2510.33, hasCredits: true, unlimited: false },
            limitReached: true, observedAt: now - 3 * 3_600_000,
        },
    }, now);
    assert.match(limited.tip, /^Codex account at its weekly limit · 100% used · resets in 4d2h · .*credits left · seen 3h ago$/);
    assert.equal(codexAccountLimit({ codex: { usedPercent: 63, limitReached: false } }, now), null);
    assert.equal(codexAccountLimit({ codex: null }, now), null, 'no rollout carried rate limits');
    assert.equal(codexAccountLimit({}, now), null, 'an old server');
});

test('the simulator never reads as a lost link', () => {
    const state = villageAfter([
        HEALTHY,
        { type: 'snapshot', source: 'simulator', agentCount: 3, at: 1_000 },
        { type: 'link', state: LinkState.RECONNECTING, attempts: 2 },
    ]);
    assert.equal(linkDown(state, 60_000), false);
});
