import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { resolveAgentStatus } from '../../claudeville/src/domain/services/StatusResolver.js';
import { AgentStatus } from '../../claudeville/src/domain/value-objects/AgentStatus.js';
import { makeTempDir } from './support/tmp.mjs';

const require = createRequire(import.meta.url);
// The module resolves ~/.claude at load time. A temp HOME keeps fetchUsage()
// away from the operator's real credentials, so no test can reach the network.
const home = makeTempDir('claudeville-usage-quota-');
const originalHome = process.env.HOME;
process.env.HOME = home;
const usageQuota = require('../../claudeville/services/usageQuota.js');
if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome;
test.after(() => fs.rmSync(home, { recursive: true, force: true }));
const {
  codexQuotaFromObservation,
  consumeQuotaResponse,
  quotaRetryDelayMs,
  recordQuotaFailure,
  recordQuotaSuccess,
  resetQuotaCache,
  resetsAtMs,
  setQuotaChangeListener,
  QUOTA_API_TTL,
  QUOTA_MAX_STALE_MS,
  QUOTA_RESPONSE_MAX_BYTES,
} = usageQuota._test;

const NOW = Date.UTC(2026, 9, 27, 12, 0, 0);
const WINDOWS = {
  five_hour: { utilization: 17, resets_at: '2026-10-27T15:00:00.000000+00:00' },
  seven_day: { utilization: 88, resets_at: '2026-10-29T09:30:00+00:00' },
};

function usageAt(now) {
  const originalNow = Date.now;
  Date.now = () => now;
  try {
    return usageQuota.fetchUsage();
  } finally {
    Date.now = originalNow;
  }
}

class FakeResponse extends EventEmitter {
  constructor(statusCode) {
    super();
    this.statusCode = statusCode;
    this.destroyed = false;
    this.resumed = false;
  }

  destroy() {
    this.destroyed = true;
  }

  resume() {
    this.resumed = true;
  }
}

test('quota response accepts a bounded chunked JSON body', () => {
  const response = new FakeResponse(200);
  let parsed = null;
  consumeQuotaResponse(response, value => { parsed = value; });

  response.emit('data', Buffer.from('{"five_hour":{"util'));
  response.emit('data', Buffer.from('ization":42},"seven_day":{"utilization":7}}'));
  response.emit('end');

  assert.deepEqual(parsed, {
    five_hour: { utilization: 42 },
    seven_day: { utilization: 7 },
  });
  assert.equal(response.destroyed, false);
});

test('quota response destroys an oversized body without parsing it', () => {
  const response = new FakeResponse(200);
  let parsed = false;
  consumeQuotaResponse(response, () => { parsed = true; });

  response.emit('data', Buffer.alloc(QUOTA_RESPONSE_MAX_BYTES));
  response.emit('data', Buffer.from('x'));
  response.emit('end');

  assert.equal(response.destroyed, true);
  assert.equal(parsed, false);
});

test('quota response drains non-200 bodies without retaining them', () => {
  const response = new FakeResponse(503);
  let parsed = false;
  consumeQuotaResponse(response, () => { parsed = true; });

  assert.equal(response.resumed, true);
  assert.equal(response.listenerCount('data'), 0);
  assert.equal(parsed, false);
});

test('quota response reports a failed status to its caller', () => {
  for (const statusCode of [401, 429, 503]) {
    const response = new FakeResponse(statusCode);
    response.headers = { 'retry-after': '120' };
    let failure = null;
    consumeQuotaResponse(response, () => assert.fail('a failure is never parsed'), {
      onFailure: (status, headers) => { failure = { status, headers }; },
    });
    assert.equal(response.resumed, true);
    assert.deepEqual(failure, { status: statusCode, headers: { 'retry-after': '120' } });
  }
});

test('SV-7: a good response forwards both windows with their reset times', () => {
  resetQuotaCache();
  recordQuotaSuccess(WINDOWS, NOW);
  const usage = usageAt(NOW + 1000);
  assert.deepEqual(usage.quota, {
    provider: 'claude',
    fiveHour: 0.17,
    sevenDay: 0.88,
    fiveHourResetsAt: Date.UTC(2026, 9, 27, 15, 0, 0),
    sevenDayResetsAt: Date.UTC(2026, 9, 29, 9, 30, 0),
  });
  assert.equal(usage.quotaAvailable, true);
  assert.equal(usage.quotaError, null);
  assert.equal(Object.hasOwn(usage, 'totals'), false);
  assert.equal(Object.hasOwn(usage.account, 'email'), false);
});

test('SV-7: a reset time the API omits or garbles is unknown, never zero', () => {
  assert.equal(resetsAtMs('2026-10-27T15:00:00Z'), Date.UTC(2026, 9, 27, 15, 0, 0));
  assert.equal(resetsAtMs(1793600373), 1793600373000, 'bare numbers are epoch seconds');
  assert.equal(resetsAtMs(1793600373000), 1793600373000, 'already-ms values stay ms');
  for (const value of [null, undefined, '', 'soon', true, {}, 0, -5]) assert.equal(resetsAtMs(value), null, String(value));
  resetQuotaCache();
  recordQuotaSuccess({ five_hour: { utilization: 40 }, seven_day: { utilization: 5, resets_at: 'later' } }, NOW);
  const { quota } = usageAt(NOW);
  assert.equal(quota.fiveHour, 0.4);
  assert.equal(quota.fiveHourResetsAt, null);
  assert.equal(quota.sevenDayResetsAt, null);
});

test('SV-7: a 401 drops the numbers at once and names the expired token', () => {
  resetQuotaCache();
  recordQuotaSuccess(WINDOWS, NOW);
  recordQuotaFailure(401, {}, NOW + 5 * 60_000);
  const expired = usageAt(NOW + 5 * 60_000 + 1);
  assert.equal(expired.quotaAvailable, false, 'not frozen for 30 minutes');
  assert.deepEqual(expired.quota, { fiveHour: null, sevenDay: null, fiveHourResetsAt: null, sevenDayResetsAt: null });
  assert.deepEqual(expired.quotaError, { status: 401, at: NOW + 5 * 60_000 });
  recordQuotaFailure(401, {}, NOW + 10 * 60_000);
  assert.deepEqual(usageAt(NOW + 10 * 60_000).quotaError, { status: 401, at: NOW + 5 * 60_000 }, 'at marks when the failure began');
  recordQuotaSuccess(WINDOWS, NOW + 15 * 60_000);
  const refreshed = usageAt(NOW + 15 * 60_000);
  assert.equal(refreshed.quotaError, null);
  assert.equal(refreshed.quotaAvailable, true);
  assert.equal(refreshed.quota.sevenDay, 0.88);
});

test('SV-7: a 429 keeps the last snapshot, names the throttle and backs off', () => {
  resetQuotaCache({ nextAttemptAt: 0 });
  recordQuotaSuccess(WINDOWS, NOW);
  recordQuotaFailure(429, { 'retry-after': '1200' }, NOW + 60_000);
  const throttled = usageAt(NOW + 60_000);
  assert.deepEqual(throttled.quotaError, { status: 429, at: NOW + 60_000 });
  assert.equal(throttled.quotaAvailable, true, 'the snapshot is still younger than the staleness cutoff');
  assert.equal(throttled.quota.fiveHour, 0.17);
  assert.equal(quotaRetryDelayMs('1200', NOW), 20 * 60_000, 'Retry-After seconds');
  assert.equal(quotaRetryDelayMs(undefined, NOW), 2 * QUOTA_API_TTL, 'at least two refresh periods');
  assert.equal(quotaRetryDelayMs('5', NOW), 2 * QUOTA_API_TTL);
  assert.equal(quotaRetryDelayMs(new Date(NOW + 15 * 60_000).toUTCString(), NOW), 15 * 60_000, 'Retry-After HTTP date');
  assert.equal(quotaRetryDelayMs('86400', NOW), QUOTA_MAX_STALE_MS, 'capped at the staleness cutoff');
  assert.equal(quotaRetryDelayMs('garbage', NOW), 2 * QUOTA_API_TTL);
  // A 401 after a throttle replaces it: the token itself failed.
  recordQuotaFailure(401, {}, NOW + 25 * 60_000);
  assert.equal(usageAt(NOW + 25 * 60_000).quotaError.status, 401);
});

test('SV-7: other failures stay silent and the snapshot still ages out after 30 minutes', () => {
  resetQuotaCache();
  recordQuotaSuccess(WINDOWS, NOW);
  for (const statusCode of [403, 500, 503]) recordQuotaFailure(statusCode, {}, NOW + 60_000);
  assert.equal(usageAt(NOW + 60_000).quotaError, null);
  assert.equal(usageAt(NOW + QUOTA_MAX_STALE_MS).quotaAvailable, true);
  const aged = usageAt(NOW + QUOTA_MAX_STALE_MS + 1);
  assert.equal(aged.quotaAvailable, false);
  assert.equal(aged.quota.sevenDay, null);
  recordQuotaSuccess({ unexpected: true }, NOW + QUOTA_MAX_STALE_MS + 2);
  assert.equal(usageAt(NOW + QUOTA_MAX_STALE_MS + 2).quotaAvailable, false, 'a body without either window is not quota data');
});

test('SV-7: the change listener hears a new snapshot or failure state, not a repeat', () => {
  resetQuotaCache();
  let changes = 0;
  setQuotaChangeListener(() => { changes++; });
  recordQuotaSuccess(WINDOWS, NOW);
  assert.equal(changes, 1);
  recordQuotaFailure(429, {}, NOW + 1);
  assert.equal(changes, 2);
  recordQuotaFailure(429, {}, NOW + 2);
  recordQuotaFailure(503, {}, NOW + 3);
  assert.equal(changes, 2, 'a repeated throttle or an unnamed failure changes nothing');
  recordQuotaFailure(401, {}, NOW + 4);
  assert.equal(changes, 3);
  recordQuotaFailure(401, {}, NOW + 5);
  assert.equal(changes, 3);
  setQuotaChangeListener(() => { throw new Error('listener failure'); });
  assert.doesNotThrow(() => recordQuotaSuccess(WINDOWS, NOW + 6));
  assert.equal(usageAt(NOW + 6).quotaError, null);
  resetQuotaCache();
});

// ─── SV-6 / PV-7: Codex rate limits and credits ─────────────────

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const RATE_LIMIT_FIXTURE = path.join(REPO_ROOT, 'scripts', 'adapters', 'fixtures', 'codex', 'rate-limits.jsonl');
const FAR_RESET_MS = 4102444800 * 1000;

function codexQuotaProjection({ mtimeAgoMs = 0 } = {}) {
  const root = makeTempDir('claudeville-codex-quota-');
  try {
    const now = Date.now();
    const project = path.join(root, 'work', 'codex-quota');
    const rolloutDir = path.join(root, '.codex', 'sessions', '2026', '10', '27');
    fs.mkdirSync(project, { recursive: true });
    fs.mkdirSync(rolloutDir, { recursive: true });
    let content = fs.readFileSync(RATE_LIMIT_FIXTURE, 'utf8');
    for (const [placeholder, value] of [
      ['__PROJECT__', project],
      ['__FIVE_MINUTES_AGO__', new Date(now - mtimeAgoMs - 5 * 60_000).toISOString()],
      ['__FOUR_MINUTES_AGO__', new Date(now - mtimeAgoMs - 4 * 60_000).toISOString()],
      ['__THREE_MINUTES_AGO__', new Date(now - mtimeAgoMs - 3 * 60_000).toISOString()],
    ]) content = content.replaceAll(placeholder, value);
    const target = path.join(rolloutDir, 'rollout-2026-10-27T12-00-00-rate-limits.jsonl');
    fs.writeFileSync(target, content);
    const mtime = (now - mtimeAgoMs) / 1000;
    fs.utimesSync(target, mtime, mtime);
    const script = `
      const { CodexAdapter } = require('./claudeville/adapters/codex');
      const usageQuota = require('./claudeville/services/usageQuota');
      const adapter = new CodexAdapter();
      const sessions = adapter.getActiveSessions(2 * 60 * 1000, { force: true });
      usageQuota._test.resetQuotaCache();
      usageQuota._test.setCodexRateLimitsSource(() => adapter.getRateLimitObservation());
      process.stdout.write(JSON.stringify({
        sessions,
        observation: adapter.getRateLimitObservation(),
        codex: usageQuota.fetchUsage().codex,
      }));
    `;
    const output = execFileSync(process.execPath, ['-e', script], {
      cwd: REPO_ROOT,
      env: { ...process.env, HOME: root, USERPROFILE: root },
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
    });
    return { ...JSON.parse(output), observedAt: Date.parse(new Date(now - mtimeAgoMs - 3 * 60_000).toISOString()) };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('SV-6: a live rollout feeds /api/usage.codex from its newest token_count', () => {
  const { sessions, observation, codex, observedAt } = codexQuotaProjection();
  assert.deepEqual(observation, {
    observedAt,
    primary: { usedPercent: 100, windowMinutes: 10080, resetsAt: FAR_RESET_MS },
    secondary: null,
    credits: { balance: 2510.32726225, hasCredits: true, unlimited: false },
    reached: false,
  });
  assert.deepEqual(codex, {
    usedPercent: 100,
    windowMinutes: 10080,
    resetsAt: FAR_RESET_MS,
    credits: { balance: 2510.32726225, hasCredits: true, unlimited: false },
    limitReached: true,
    observedAt,
  });
  // Account data stays off the session wire: no account id, no quota fields.
  const session = sessions.find(row => row.sessionId === 'codex-2026-10-27T12-00-00-rate-limits');
  assert.ok(session, 'the fixture rollout is a live session');
  for (const field of ['accountId', 'rateLimits', 'rateLimit', 'credits', 'quota']) {
    assert.equal(Object.hasOwn(session, field), false, field);
  }
});

test('SV-6: a server that boots with no live Codex session still reads the last observation', () => {
  const { sessions, codex, observedAt } = codexQuotaProjection({ mtimeAgoMs: 6 * 60 * 60_000 });
  assert.equal(sessions.length, 0, 'the six-hour-old rollout is not live');
  assert.equal(codex.limitReached, true);
  assert.equal(codex.observedAt, observedAt, 'its age is stated, not hidden');
});

test('PV-7 / Q3: LIMIT at 100 % or a reached type, the binding window, and resets read as unknown', () => {
  const NOW_MS = Date.UTC(2026, 9, 27, 12);
  const week = (usedPercent, resetsAt = NOW_MS + 86_400_000) => ({ usedPercent, windowMinutes: 10080, resetsAt });
  const fiveHour = (usedPercent, resetsAt = NOW_MS + 3_600_000) => ({ usedPercent, windowMinutes: 300, resetsAt });
  const credits = { balance: 12.5, hasCredits: true, unlimited: false };
  const observe = (extra) => ({ observedAt: NOW_MS - 1000, primary: null, secondary: null, credits, reached: false, ...extra });

  assert.equal(codexQuotaFromObservation(null, NOW_MS), null, 'absence stays unknown');
  assert.equal(codexQuotaFromObservation(observe({ primary: week(99.9) }), NOW_MS).limitReached, false);
  assert.equal(codexQuotaFromObservation(observe({ primary: week(100) }), NOW_MS).limitReached, true, 'Q3: LIMIT at 100 % even on credits');
  assert.equal(codexQuotaFromObservation(observe({ primary: week(42), reached: true }), NOW_MS).limitReached, true);

  const binding = codexQuotaFromObservation(observe({ primary: fiveHour(40), secondary: week(100) }), NOW_MS);
  assert.equal(binding.windowMinutes, 10080, 'the tighter window is the one reported');
  assert.equal(binding.usedPercent, 100);
  assert.equal(binding.limitReached, true);

  const reset = codexQuotaFromObservation(observe({ primary: week(100, NOW_MS - 1) }), NOW_MS);
  assert.deepEqual(reset, {
    usedPercent: null,
    windowMinutes: 10080,
    resetsAt: null,
    credits,
    limitReached: false,
    observedAt: NOW_MS - 1000,
  }, 'a window past its reset is unknown, never 0 %');

  const partlyReset = codexQuotaFromObservation(observe({ primary: fiveHour(100, NOW_MS - 1), secondary: week(61) }), NOW_MS);
  assert.equal(partlyReset.usedPercent, 61);
  assert.equal(partlyReset.windowMinutes, 10080);
  assert.equal(partlyReset.limitReached, false);

  const bare = codexQuotaFromObservation(observe({ credits: null, reached: true }), NOW_MS);
  assert.deepEqual(bare.credits, { balance: null, hasCredits: null, unlimited: null });
  assert.equal(bare.usedPercent, null);
  assert.equal(bare.limitReached, true, 'a reached type alone is a LIMIT');
});

test('Q3: an account LIMIT never changes a Codex session\'s own status', () => {
  const usage = {
    provider: 'claude',
    quota: { provider: 'claude', fiveHour: 0.2, sevenDay: 0.5 },
    codex: { usedPercent: 100, windowMinutes: 10080, resetsAt: FAR_RESET_MS, credits: {}, limitReached: true, observedAt: 1 },
  };
  const now = Date.now();
  const working = { provider: 'codex', sessionId: 'codex-a', turnState: 'working', lastActivity: now };
  assert.equal(resolveAgentStatus(working, { usage, now }), AgentStatus.WORKING);
  const idle = { provider: 'codex', sessionId: 'codex-b', turnState: 'awaiting_input', lastActivity: now };
  assert.equal(resolveAgentStatus(idle, { usage, now }), AgentStatus.COMPLETED);
});
