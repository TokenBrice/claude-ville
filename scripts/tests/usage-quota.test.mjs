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
// The module resolves ~/.claude at load time, and GLM/Antigravity quota read
// env vars at call time. Isolate HOME plus provider quota env vars so tests
// never inherit the developer's credentials or hit live hosts.
const ISOLATED_ENV_KEYS = [
  'GLM_MCP_API_KEY',
  'ZAI_API_KEY',
  'Z_AI_API_KEY',
  'GLM_QUOTA_URL',
  'ACP_GLM_BASE_URL',
  'CLAUDEVILLE_T3_DIR',
  'HOBOTNICA_HOME',
  'XDG_CONFIG_HOME',
];
const home = makeTempDir('claudeville-usage-quota-');
const originalHome = process.env.HOME;
const savedEnv = Object.fromEntries(ISOLATED_ENV_KEYS.map(key => [key, process.env[key]]));
process.env.HOME = home;
for (const key of ISOLATED_ENV_KEYS) delete process.env[key];
const usageQuota = require('../../claudeville/services/usageQuota.js');
if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome;
test.after(() => {
  usageQuota._test.resetQuotaCache();
  for (const key of ISOLATED_ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  fs.rmSync(home, { recursive: true, force: true });
});
const {
  codexQuotaFromObservation,
  consumeQuotaResponse,
  parseAntigravityOauthPayload,
  parseAntigravityT3Cache,
  parseGlmQuotaPayload,
  quotaRetryDelayMs,
  readAntigravityQuota,
  readGlmQuota,
  recordQuotaFailure,
  recordQuotaSuccess,
  resetQuotaCache: rawResetQuotaCache,
  resetsAtMs,
  setHooks,
  setQuotaChangeListener,
  tryFetchAntigravityOauth,
  tryFetchGlmQuota,
  QUOTA_API_TTL,
  QUOTA_MAX_STALE_MS,
  QUOTA_RESPONSE_MAX_BYTES,
} = usageQuota._test;

function unexpectedNetworkTransport(label) {
  return (options) => {
    assert.fail(`unexpected live ${label} request to ${options?.hostname || 'unknown host'}${options?.path || ''}`);
  };
}

function resetQuotaCache(opts) {
  rawResetQuotaCache(opts);
  setHooks({
    env: {},
    homeDir: home,
    glmRequest: unexpectedNetworkTransport('GLM'),
    antigravityRequest: unexpectedNetworkTransport('Antigravity'),
  });
}

function childEnvFor(root) {
  const env = { ...process.env, HOME: root, USERPROFILE: root };
  for (const key of ISOLATED_ENV_KEYS) delete env[key];
  return env;
}

const NOW = Date.UTC(2026, 9, 27, 12, 0, 0);
const WINDOWS = {
  five_hour: { utilization: 17, resets_at: '2026-10-27T15:00:00.000000+00:00' },
  seven_day: { utilization: 88, resets_at: '2026-10-29T09:30:00+00:00' },
};
const LIMITS_RESPONSE = fs.readFileSync(new URL('./fixtures/claude-usage-limits.json', import.meta.url));

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

test('Claude quota exposes the active weekly limit and fills five hours from the inactive session limit', () => {
  resetQuotaCache();
  const response = new FakeResponse(200);
  consumeQuotaResponse(response, data => recordQuotaSuccess(data, NOW));
  response.emit('data', LIMITS_RESPONSE);
  response.emit('end');

  const usage = usageAt(NOW);
  assert.equal(usage.quotaAvailable, true);
  assert.deepEqual(usage.quota, {
    provider: 'claude',
    fiveHour: 0.82,
    fiveHourSource: 'limits',
    sevenDay: 0.68,
    fiveHourResetsAt: Date.UTC(2026, 9, 27, 15),
    sevenDayResetsAt: Date.UTC(2026, 9, 29, 9, 30),
    highestActiveLimit: {
      kind: 'weekly_all', scope: null, severity: 'warning',
      usedPercent: 68, resetsAt: Date.UTC(2026, 9, 29, 9, 30),
    },
  });
  assert.equal(resolveAgentStatus({ provider: 'claude', model: 'claude-opus-5-5', turnState: 'working' }, { usage }), AgentStatus.WORKING);
});

test('Claude quota prefers explicit windows and uses only a single unscoped session limit as fallback', () => {
  const [session] = JSON.parse(LIMITS_RESPONSE).limits;
  resetQuotaCache();
  recordQuotaSuccess({ ...WINDOWS, five_hour: { utilization: 0 }, limits: [session] }, NOW);
  assert.equal(usageAt(NOW).quota.fiveHour, 0);
  assert.equal(usageAt(NOW).quota.fiveHourResetsAt, null);
  assert.equal(Object.hasOwn(usageAt(NOW).quota, 'fiveHourSource'), false);

  recordQuotaSuccess({ five_hour: { utilization: null }, limits: [session] }, NOW);
  assert.equal(usageAt(NOW).quota.fiveHour, 0.82);

  recordQuotaSuccess({ limits: [{ ...session, percent: 101, is_active: true }] }, NOW);
  assert.equal(usageAt(NOW).quota.fiveHour, 1);
  assert.equal(usageAt(NOW).quota.highestActiveLimit.usedPercent, 101);

  for (const limits of [
    [session, { ...session, percent: 50 }],
    [session, { ...session, percent: null }],
    [{ ...session, scope: { model: 'claude-opus-5-5' } }],
    [{ ...session, kind: 'weekly_all' }],
  ]) {
    recordQuotaSuccess({ seven_day: WINDOWS.seven_day, limits }, NOW);
    assert.equal(usageAt(NOW).quota.fiveHour, null);
    assert.equal(usageAt(NOW).quota.fiveHourResetsAt, null);
    assert.equal(Object.hasOwn(usageAt(NOW).quota, 'fiveHourSource'), false);
  }
});

test('Claude quota leaves null or missing legacy utilization unknown without a fallback', () => {
  resetQuotaCache();
  for (const five_hour of [{ utilization: null }, {}]) {
    recordQuotaSuccess({ five_hour, seven_day: WINDOWS.seven_day }, NOW);
    assert.equal(usageAt(NOW).quota.fiveHour, null);
    assert.equal(Object.hasOwn(usageAt(NOW).quota, 'fiveHourSource'), false);
  }
});

test('Claude quota treats missing limit scopes as account-wide', () => {
  const { limits: [session, weekly] } = JSON.parse(LIMITS_RESPONSE);
  delete session.scope;
  delete weekly.scope;
  resetQuotaCache();
  recordQuotaSuccess({ limits: [session, weekly] }, NOW);
  const { quota } = usageAt(NOW);
  assert.equal(quota.fiveHour, 0.82);
  assert.equal(quota.fiveHourSource, 'limits');
  assert.equal(quota.highestActiveLimit?.scope, null);
});

test('Claude quota skips malformed limits and ages out a limits-only snapshot', () => {
  const [, weekly] = JSON.parse(LIMITS_RESPONSE).limits;
  const scoped = { ...weekly, kind: 'weekly_scoped', scope: { model: 'claude-opus-5-5' }, percent: 98 };
  resetQuotaCache();
  recordQuotaSuccess({ ...WINDOWS, limits: { ...scoped } }, NOW);
  assert.equal(Object.hasOwn(usageAt(NOW).quota, 'highestActiveLimit'), false);

  recordQuotaSuccess({ limits: [
    null, [], {}, { ...scoped, percent: '99' }, { ...scoped, percent: -1 }, { ...scoped, percent: null },
    { ...scoped, percent: 99, is_active: 'true' }, { ...scoped, percent: 99, kind: null },
    { ...scoped, percent: 99, severity: {} }, { ...scoped, percent: 99, scope: { model: {} } },
    { ...scoped, resets_at: 'later', scope: { ...scoped.scope, extra: 'ignored' } },
  ] }, NOW);
  const fresh = usageAt(NOW);
  assert.equal(fresh.quotaAvailable, true);
  assert.equal(fresh.quota.fiveHour, null);
  assert.equal(fresh.quota.sevenDay, null);
  assert.deepEqual(fresh.quota.highestActiveLimit, {
    kind: 'weekly_scoped', scope: { model: 'claude-opus-5-5' }, severity: 'warning', usedPercent: 98, resetsAt: null,
  });
  assert.equal(usageAt(NOW + QUOTA_MAX_STALE_MS + 1).quotaAvailable, false);
  assert.equal(Object.hasOwn(usageAt(NOW + QUOTA_MAX_STALE_MS + 1).quota, 'highestActiveLimit'), false);
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

function codexQuotaProjection({ mtimeAgoMs = 0, newerStubAgoMs = null, firstReadings, olderReadings, followups = [] } = {}) {
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
    const rows = content.trimEnd().split('\n').map(line => JSON.parse(line));
    const reading = (secondsAgo, balance, { unlimited = false, limitId = 'codex' } = {}) => {
      const row = structuredClone(rows[4]);
      row.timestamp = new Date(now - mtimeAgoMs - secondsAgo * 1000).toISOString();
      row.payload.rate_limits.limit_id = limitId;
      row.payload.rate_limits.credits = balance === null && !unlimited ? null : { balance, unlimited };
      return row;
    };
    const jsonl = entries => `${entries.map(row => JSON.stringify(row)).join('\n')}\n`;
    if (firstReadings) content = jsonl([...rows.slice(0, 3), ...firstReadings.map(args => reading(...args))]);
    const target = path.join(rolloutDir, 'rollout-2026-10-27T12-00-00-rate-limits.jsonl');
    fs.writeFileSync(target, content);
    const mtime = (now - mtimeAgoMs) / 1000;
    fs.utimesSync(target, mtime, mtime);
    if (olderReadings) {
      const older = path.join(rolloutDir, 'rollout-2026-10-27T11-00-00-older.jsonl');
      fs.writeFileSync(older, jsonl([...rows.slice(0, 3), ...olderReadings.map(args => reading(...args))]));
      fs.utimesSync(older, mtime - 60, mtime - 60);
    }
    if (newerStubAgoMs !== null) {
      // A session opened and left before its first turn: session_meta only.
      const stub = path.join(rolloutDir, 'rollout-2026-10-27T13-00-00-stub.jsonl');
      const stubAt = new Date(now - newerStubAgoMs).toISOString();
      fs.writeFileSync(stub, `${JSON.stringify({
        timestamp: stubAt,
        type: 'session_meta',
        payload: { id: 'stub', timestamp: stubAt, creator_account_id: 'acct-fixture-0001', cwd: project, originator: 'codex-tui', source: 'cli' },
      })}\n`);
      const stubMtime = (now - newerStubAgoMs) / 1000;
      fs.utimesSync(stub, stubMtime, stubMtime);
    }
    const script = `
      const fs = require('node:fs');
      const { CodexAdapter } = require('./claudeville/adapters/codex');
      const usageQuota = require('./claudeville/services/usageQuota');
      const adapter = new CodexAdapter();
      const sessions = adapter.getActiveSessions(2 * 60 * 1000, { force: true });
      usageQuota._test.resetQuotaCache();
      usageQuota._test.setCodexRateLimitsSource(() => adapter.getRateLimitObservation());
      const codex = usageQuota.fetchUsage().codex;
      const observation = adapter.getRateLimitObservation();
      const next = ${JSON.stringify(followups.map(({ account = rows[0].payload.creator_account_id, readings }) => {
        const meta = structuredClone(rows[0]);
        meta.payload.creator_account_id = account;
        meta.payload.id = account;
        return {
          file: path.join(rolloutDir, `rollout-2026-10-27T14-00-00-${account}.jsonl`),
          content: jsonl([meta, ...rows.slice(1, 3), ...readings.map(args => reading(...args))]),
        };
      }))}.map(({ file, content }) => {
        fs.writeFileSync(file, content);
        adapter.invalidateCaches();
        adapter.getActiveSessions(2 * 60 * 1000, { force: true });
        return usageQuota.fetchUsage().codex;
      });
      process.stdout.write(JSON.stringify({
        sessions,
        observation,
        codex,
        next,
      }));
    `;
    const output = execFileSync(process.execPath, ['-e', script], {
      cwd: REPO_ROOT,
      env: childEnvFor(root),
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
  const { creditChange, ...quota } = codex;
  const delta = -31.83273775;
  assert.deepEqual(observation, {
    observedAt,
    primary: { usedPercent: 100, windowMinutes: 10080, resetsAt: FAR_RESET_MS },
    secondary: null,
    credits: { balance: 2510.32726225, hasCredits: true, unlimited: false },
    reached: false,
    creditChange: { delta, intervalMs: 60_000 },
  });
  assert.deepEqual(quota, {
    usedPercent: 100,
    windowMinutes: 10080,
    resetsAt: FAR_RESET_MS,
    weekly: { usedPercent: 100, windowMinutes: 10080, resetsAt: FAR_RESET_MS },
    fiveHour: null,
    credits: { balance: 2510.32726225, hasCredits: true, unlimited: false },
    limitReached: true,
    observedAt,
  });
  assert.equal(creditChange.delta, delta);
  assert.equal(creditChange.intervalMs, 60_000);
  assert.ok(creditChange.ageMs >= 180_000);
  // Account data stays off the session wire: no account id, no quota fields.
  const session = sessions.find(row => row.sessionId === 'codex-2026-10-27T12-00-00-rate-limits');
  assert.ok(session, 'the fixture rollout is a live session');
  for (const field of ['accountId', 'rateLimits', 'rateLimit', 'credits', 'quota', 'creditChange']) {
    assert.equal(Object.hasOwn(session, field), false, field);
  }
});

test('SV-6: a server that boots with no live Codex session still reads the last observation', () => {
  const { sessions, codex, observedAt } = codexQuotaProjection({ mtimeAgoMs: 6 * 60 * 60_000 });
  assert.equal(sessions.length, 0, 'the six-hour-old rollout is not live');
  assert.equal(codex.limitReached, true);
  assert.equal(codex.observedAt, observedAt, 'its age is stated, not hidden');
  assert.equal(codex.creditChange, undefined, 'old comparisons expire independently of quota');
});

test('SG-3: cold seeding pairs readings across two inactive rollouts', () => {
  const { sessions, codex } = codexQuotaProjection({
    mtimeAgoMs: 5 * 60_000,
    firstReadings: [[180, '80']],
    olderReadings: [[240, '100']],
  });
  assert.equal(sessions.length, 0);
  assert.equal(codex.creditChange.delta, -20);
  assert.equal(codex.creditChange.intervalMs, 60_000);
});

test('SG-3: the change retains fractional credits lost when the individual balances become numbers', () => {
  const { codex } = codexQuotaProjection({
    firstReadings: [[240, '10000.00000000000001'], [180, '10000.00000000000002']],
  });
  assert.equal(codex.creditChange.delta, 0.00000000000001);
});

test('SG-3: a conflicting balance at the latest timestamp suppresses a previously valid change', () => {
  const { codex, next } = codexQuotaProjection({
    firstReadings: [[240, '100.00'], [180, '80.00']],
    followups: [{ readings: [[180, '79.00']] }],
  });
  assert.equal(codex.creditChange.delta, -20);
  assert.equal(next[0].creditChange, undefined);
});

test('SG-3: reversed and incremental scans keep account and limit identities private', () => {
  const other = 'other-fixture-account';
  const { codex, next } = codexQuotaProjection({
    firstReadings: [[180, '80'], [180, '80'], [210, null], [240, '100']],
    followups: [
      { account: other, readings: [[120, '200']] },
      { readings: [[110, '150']] },
      { account: other, readings: [[100, '195', { limitId: 'other' }]] },
      { readings: [[90, '135'], [110, '149']] },
      { readings: [[80, '130', { unlimited: true }]] },
      { readings: [[70, '125']] },
      { readings: [[60, '125']] },
      { readings: [[50, null]] },
    ],
  });
  const change = quota => quota.creditChange && [quota.creditChange.delta, quota.creditChange.intervalMs];
  assert.deepEqual(change(codex), [-20, 60_000]);
  assert.deepEqual(next.map(change), [undefined, [70, 70_000], undefined, undefined, undefined, undefined, [0, 10_000], undefined]);
  assert.ok(next[4].credits.unlimited);
  assert.equal(next[7].credits.balance, null);
  assert.doesNotMatch(JSON.stringify([codex, ...next]), /acct-fixture|other-fixture-account|limitId/);
});

test('SG-3: the wire age advances by minutes and a stale predecessor suppresses the comparison', () => {
  const observation = { observedAt: NOW, creditChange: { delta: 12, intervalMs: 2 * 60_000 } };
  const read = ageMs => codexQuotaFromObservation(observation, NOW + ageMs).creditChange;
  assert.deepEqual(read(1), { delta: 12, intervalMs: 120_000, ageMs: 0 });
  assert.deepEqual(read(59_999), read(1));
  assert.equal(read(60_000).ageMs, 60_000);
  assert.equal(read(QUOTA_MAX_STALE_MS - 119_999), undefined);
});

test('SV-6: the boot seed walks past a newer rollout that never reported a token_count', () => {
  const { sessions, codex, observedAt } = codexQuotaProjection({ mtimeAgoMs: 6 * 60 * 60_000, newerStubAgoMs: 3 * 60 * 60_000 });
  assert.equal(sessions.length, 0, 'neither rollout is live');
  assert.ok(codex, 'the stub does not hide the older reading');
  assert.equal(codex.usedPercent, 100);
  assert.equal(codex.observedAt, observedAt);
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
    weekly: null,
    fiveHour: null,
    credits,
    limitReached: false,
    observedAt: NOW_MS - 1000,
  }, 'a window past its reset is unknown, never 0 %');

  const partlyReset = codexQuotaFromObservation(observe({ primary: fiveHour(100, NOW_MS - 1), secondary: week(61) }), NOW_MS);
  assert.equal(partlyReset.usedPercent, 61);
  assert.equal(partlyReset.windowMinutes, 10080);
  assert.equal(partlyReset.limitReached, false);
  assert.equal(partlyReset.fiveHour, null);
  assert.equal(partlyReset.weekly?.usedPercent, 61);

  const bare = codexQuotaFromObservation(observe({ credits: null, reached: true }), NOW_MS);
  assert.deepEqual(bare.credits, { balance: null, hasCredits: null, unlimited: null });
  assert.equal(bare.usedPercent, null);
  assert.equal(bare.weekly, null);
  assert.equal(bare.fiveHour, null);
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

// PV-14 on the detail path: a rollout with no token_count yet borrows its
// model's observed window there too, and a detail read never records one
// (its head names the opening model, which a switch may have replaced).
test('PV-14: a Codex session detail borrows its model\'s observed context window', () => {
  const root = makeTempDir('claudeville-codex-window-');
  try {
    const now = Date.now();
    const project = path.join(root, 'work', 'codex-window');
    const rolloutDir = path.join(root, '.codex', 'sessions', '2026', '10', '27');
    fs.mkdirSync(project, { recursive: true });
    fs.mkdirSync(rolloutDir, { recursive: true });
    const at = (agoMs) => new Date(now - agoMs).toISOString();
    const meta = (id, model) => ({ timestamp: at(60_000), type: 'session_meta', payload: { id, timestamp: at(60_000), cwd: project, model } });
    const turn = (agoMs, model) => ({ timestamp: at(agoMs), type: 'turn_context', payload: { cwd: project, model, effort: 'high' } });
    const event = (agoMs, payload) => ({ timestamp: at(agoMs), type: 'event_msg', payload });
    const tokens = (agoMs, window) => event(agoMs, {
      type: 'token_count',
      info: {
        total_token_usage: { input_tokens: 1200, cached_input_tokens: 800, output_tokens: 90, total_tokens: 1290 },
        last_token_usage: { input_tokens: 1200, cached_input_tokens: 800, output_tokens: 90, total_tokens: 1290 },
        model_context_window: window,
      },
    });
    const write = (name, records) => fs.writeFileSync(path.join(rolloutDir, `rollout-${name}.jsonl`), `${records.map(r => JSON.stringify(r)).join('\n')}\n`);
    write('2026-10-27T12-00-00-reported', [meta('reported', 'gpt-6-astra'), turn(60_000, 'gpt-6-astra'), event(59_000, { type: 'task_started' }), tokens(50_000, 258_400)]);
    write('2026-10-27T12-01-00-fresh', [meta('fresh', 'gpt-6-astra'), turn(40_000, 'gpt-6-astra'), event(39_000, { type: 'task_started' })]);
    write('2026-10-27T12-02-00-switched', [
      meta('switched', 'gpt-6-astra'), turn(60_000, 'gpt-6-astra'), event(59_000, { type: 'task_started' }),
      event(55_000, { type: 'task_complete', last_agent_message: 'Done.' }),
      turn(30_000, 'gpt-6.1-sol'), event(29_000, { type: 'task_started' }), tokens(20_000, 475_000),
    ]);
    const script = `
      const { CodexAdapter } = require('./claudeville/adapters/codex');
      const adapter = new CodexAdapter();
      adapter.getActiveSessions(10 * 60 * 1000, { force: true });
      const windowOf = (name) => adapter.getSessionDetail('codex-2026-10-27T' + name).tokenUsage?.contextWindowMax ?? null;
      process.stdout.write(JSON.stringify([windowOf('12-01-00-fresh'), windowOf('12-02-00-switched'), windowOf('12-01-00-fresh')]));
    `;
    const windows = JSON.parse(execFileSync(process.execPath, ['-e', script], {
      cwd: REPO_ROOT,
      env: childEnvFor(root),
      encoding: 'utf8',
    }));
    assert.deepEqual(windows, [258_400, 475_000, 258_400]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ─── v0.69 Council Fix Lane 1 Quota Regressions ─────────────────

class FakeHttpRequest extends EventEmitter {
  constructor(onEnd) {
    super();
    this._onEnd = onEnd;
    this.body = '';
    this.destroyed = false;
  }
  destroy() { this.destroyed = true; }
  end(chunk) {
    if (chunk) this.body += String(chunk);
    this._onEnd?.(this);
  }
}

test('Codex quota exposes weekly and fiveHour windows separately while preserving binding usedPercent', () => {
  const NOW_MS = Date.UTC(2026, 9, 27, 12, 0, 0);
  const fiveHourReset = NOW_MS + 2 * 3_600_000;
  const weeklyReset = NOW_MS + 5 * 86_400_000;
  const observation = {
    observedAt: NOW_MS - 1000,
    primary: { usedPercent: 95, windowMinutes: 300, resetsAt: fiveHourReset },
    secondary: { usedPercent: 10, windowMinutes: 10080, resetsAt: weeklyReset },
    credits: { balance: 42, hasCredits: true, unlimited: false },
    reached: false,
  };

  const codex = codexQuotaFromObservation(observation, NOW_MS);
  assert.equal(codex.usedPercent, 95, 'binding window stays highest non-reset window');
  assert.equal(codex.windowMinutes, 300);
  assert.equal(codex.resetsAt, fiveHourReset);
  assert.deepEqual(codex.fiveHour, { usedPercent: 95, windowMinutes: 300, resetsAt: fiveHourReset });
  assert.deepEqual(codex.weekly, { usedPercent: 10, windowMinutes: 10080, resetsAt: weeklyReset });
});

test('Malformed GLM and Antigravity credentials never throw and record sanitized invalid-credential errors', () => {
  const dir = makeTempDir('claudeville-bad-creds-');
  try {
    const missingCache = path.join(dir, 'absent-antigravity.json');
    const tokenPath = path.join(dir, 'antigravity-oauth-token');
    const badGlmSecret = 'glm-secret-value\nX-Injected: evil';
    const badAgySecret = 'agy-secret-value\r\nX-Injected: evil';

    // GLM embedded newline credential: zero network requests, no throw, sanitized error.
    let glmCalls = 0;
    resetQuotaCache({ nextAttemptAt: 0 });
    setHooks({
      env: { ZAI_API_KEY: badGlmSecret },
      homeDir: dir,
      glmRequest: () => { glmCalls++; return new FakeHttpRequest(); },
    });
    assert.doesNotThrow(() => tryFetchGlmQuota(NOW));
    assert.equal(glmCalls, 0, 'malformed GLM credential must not hit transport');
    const glmResult = readGlmQuota(NOW);
    assert.deepEqual(glmResult?.error, { status: 'invalid-credential', at: NOW });
    assert.doesNotMatch(JSON.stringify(glmResult), /glm-secret-value|X-Injected/);

    // GLM synchronous transport throw: caught safely, records invalid-credential.
    resetQuotaCache({ nextAttemptAt: 0 });
    setHooks({
      env: { ZAI_API_KEY: 'valid-looking-key' },
      homeDir: dir,
      glmRequest: () => { throw new TypeError('ERR_INVALID_CHAR: Invalid character in header'); },
    });
    assert.doesNotThrow(() => tryFetchGlmQuota(NOW));
    assert.deepEqual(readGlmQuota(NOW)?.error, { status: 'invalid-credential', at: NOW });

    // Antigravity embedded newline credential: zero network requests, no throw, sanitized error.
    fs.writeFileSync(tokenPath, JSON.stringify({
      token: {
        access_token: badAgySecret,
        expiry: new Date(NOW + 10 * 60_000).toISOString(),
      },
    }));
    let agyCalls = 0;
    resetQuotaCache({ nextAttemptAt: 0 });
    setHooks({
      antigravityCachePath: missingCache,
      antigravityTokenPaths: [tokenPath],
      antigravityRequest: () => { agyCalls++; return new FakeHttpRequest(); },
    });
    assert.doesNotThrow(() => tryFetchAntigravityOauth(NOW));
    assert.equal(agyCalls, 0, 'malformed Antigravity credential must not hit transport');
    const agyResult = readAntigravityQuota(NOW);
    assert.deepEqual(agyResult?.error, { status: 'invalid-credential', at: NOW });
    assert.doesNotMatch(JSON.stringify(agyResult), /agy-secret-value|X-Injected/);

    // Antigravity synchronous transport throw: caught safely, records invalid-credential.
    fs.writeFileSync(tokenPath, JSON.stringify({
      token: {
        access_token: 'valid-token-value',
        expiry: new Date(NOW + 10 * 60_000).toISOString(),
      },
    }));
    resetQuotaCache({ nextAttemptAt: 0 });
    setHooks({
      antigravityCachePath: missingCache,
      antigravityTokenPaths: [tokenPath],
      antigravityRequest: () => { throw new TypeError('ERR_INVALID_CHAR: Invalid character in header'); },
    });
    assert.doesNotThrow(() => tryFetchAntigravityOauth(NOW));
    assert.deepEqual(readAntigravityQuota(NOW)?.error, { status: 'invalid-credential', at: NOW });

    // Startup init() also survives a malformed GLM credential without throwing.
    resetQuotaCache({ nextAttemptAt: 0 });
    assert.doesNotThrow(() => usageQuota.init({
      env: { GLM_MCP_API_KEY: badGlmSecret },
      homeDir: dir,
      glmRequest: unexpectedNetworkTransport('GLM'),
      antigravityCachePath: missingCache,
      antigravityTokenPaths: [],
      antigravityRequest: unexpectedNetworkTransport('Antigravity'),
      pollAntigravity: false,
    }));
  } finally {
    resetQuotaCache();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Antigravity OAuth credential rotation immediately clears prior account quota and discards stale in-flight responses', () => {
  const dir = makeTempDir('claudeville-ag-rotate-');
  const origNow = Date.now;
  try {
    const missingCache = path.join(dir, 'absent-antigravity.json');
    const tokenPath = path.join(dir, 'antigravity-oauth-token');
    const futureWeek = new Date(NOW + 5 * 86_400_000).toISOString();
    const writeToken = (accessToken) => {
      fs.writeFileSync(tokenPath, JSON.stringify({
        token: {
          access_token: accessToken,
          expiry: new Date(NOW + 30 * 60_000).toISOString(),
        },
      }));
    };

    // 1. Account A fetches and caches 71% usage.
    writeToken('account-a-token');
    resetQuotaCache({ nextAttemptAt: 0 });
    const pendingCallbacks = [];
    const seenAuth = [];
    let currentClock = NOW;
    Date.now = () => currentClock;
    setHooks({
      env: {},
      homeDir: dir,
      antigravityCachePath: missingCache,
      antigravityTokenPaths: [tokenPath],
      antigravityRequest: (options, cb) => {
        seenAuth.push(options.headers.Authorization);
        return new FakeHttpRequest(() => {
          pendingCallbacks.push(cb);
        });
      },
    });

    assert.equal(readAntigravityQuota(NOW), null, 'in-flight initial fetch has no cached reading yet');
    assert.equal(seenAuth.length, 1);
    assert.equal(seenAuth[0], 'Bearer account-a-token');

    // Account A responds with 71%.
    const resA = new FakeResponse(200);
    pendingCallbacks.shift()(resA);
    resA.emit('data', Buffer.from(JSON.stringify({
      buckets: [{ bucketId: 'gemini-weekly', usedPercent: 71, resetTime: futureWeek, windowDurationMins: 10080 }],
    })));
    resA.emit('end');

    const readingA = readAntigravityQuota(NOW + 1000);
    assert.equal(readingA?.geminiWeekly?.usedPercent, 71);
    assert.equal(seenAuth.length, 1, 'same token stays cached within TTL');

    // 2. Rotate fixture token to Account B well inside Account A's 5-minute TTL backoff.
    writeToken('account-b-token');
    currentClock = NOW + 5000;
    const immediatelyAfterRotation = readAntigravityQuota(currentClock);
    assert.equal(immediatelyAfterRotation, null, 'old account 71% reading must vanish immediately on rotation');
    assert.equal(seenAuth.length, 2, 'rotation clears retry backoff and starts fetch for new account');
    assert.equal(seenAuth[1], 'Bearer account-b-token');

    // 3. While Account B's request is still in flight, rotate to Account C; then deliver Account B's stale response!
    const cbB = pendingCallbacks.shift();
    writeToken('account-c-token');
    const staleResB = new FakeResponse(200);
    cbB(staleResB);
    staleResB.emit('data', Buffer.from(JSON.stringify({
      buckets: [{ bucketId: 'gemini-weekly', usedPercent: 88, resetTime: futureWeek, windowDurationMins: 10080 }],
    })));
    staleResB.emit('end');

    currentClock = NOW + 6000;
    assert.equal(readAntigravityQuota(currentClock), null, 'in-flight response from rotated-away account must be discarded');
    assert.equal(seenAuth.length, 3);
    assert.equal(seenAuth[2], 'Bearer account-c-token');

    // Account C responds with 14%, then token file is deleted -> reading vanishes immediately.
    const resC = new FakeResponse(200);
    pendingCallbacks.shift()(resC);
    resC.emit('data', Buffer.from(JSON.stringify({
      buckets: [{ bucketId: 'gemini-weekly', usedPercent: 14, resetTime: futureWeek, windowDurationMins: 10080 }],
    })));
    resC.emit('end');
    assert.equal(readAntigravityQuota(NOW + 7000)?.geminiWeekly?.usedPercent, 14);

    fs.rmSync(tokenPath, { force: true });
    assert.equal(readAntigravityQuota(NOW + 8000), null, 'removing token immediately clears cached OAuth quota');
  } finally {
    Date.now = origNow;
    resetQuotaCache();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Nullable and blank Antigravity percentages fall back to remainingFraction or stay null (never fake 0%)', () => {
  const futureWeek = new Date(NOW + 5 * 86_400_000).toISOString();
  const t3Parsed = parseAntigravityT3Cache({
    usageLimits: {
      checkedAt: new Date(NOW).toISOString(),
      windows: [
        { id: 'gemini-weekly', usedPercent: null, remainingFraction: 0.2, resetsAt: futureWeek, windowDurationMins: 10080 },
        { id: 'gemini-5h', usedPercent: '   ', remainingFraction: 0.25, resetsAt: futureWeek, windowDurationMins: 300 },
        { id: '3p-weekly', usedPercent: null, remainingFraction: null, resetsAt: futureWeek, windowDurationMins: 10080 },
        { id: '3p-5h', usedPercent: '', usedFraction: '', remainingFraction: '', resetsAt: futureWeek, windowDurationMins: 300 },
      ],
    },
  }, NOW);
  assert.equal(t3Parsed.geminiWeekly?.usedPercent, 80, '{ usedPercent: null, remainingFraction: 0.2 } -> 80%');
  assert.equal(t3Parsed.geminiFiveHour?.usedPercent, 75, 'blank usedPercent falls back to remainingFraction');
  assert.equal(t3Parsed.sharedWeekly, null, '{ usedPercent: null, remainingFraction: null } -> null');
  assert.equal(t3Parsed.sharedFiveHour, null, 'blank strings -> null');

  const oauthParsed = parseAntigravityOauthPayload({
    buckets: [
      { bucketId: 'gemini-weekly', usedPercent: null, remainingFraction: 0.2, resetTime: futureWeek },
      { bucketId: '3p-weekly', usedPercent: null, remainingFraction: null, resetTime: futureWeek },
    ],
  }, NOW);
  assert.equal(oauthParsed.geminiWeekly?.usedPercent, 80);
  assert.equal(oauthParsed.sharedWeekly, null);
});

test('Expired GLM CREDIT_LIMIT does not shadow a valid TOKENS_LIMIT for the same window', () => {
  const futureWeek = NOW + 5 * 86_400_000;
  const future5h = NOW + 3 * 3_600_000;
  const pastReset = NOW - 60_000;
  const parsed = parseGlmQuotaPayload({
    code: 200,
    success: true,
    data: {
      level: 'pro',
      limits: [
        { type: 'CREDIT_LIMIT', unit: 6, number: 1, currentValue: 9000, usage: 10000, nextResetTime: pastReset },
        { type: 'TOKENS_LIMIT', unit: 6, number: 1, currentValue: 35, usage: 100, remaining: 65, nextResetTime: futureWeek },
        { type: 'CREDIT_LIMIT', unit: 3, number: 5, currentValue: 1000, usage: 2000, nextResetTime: pastReset },
        { type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 22, nextResetTime: future5h },
      ],
    },
  }, NOW);
  assert.equal(parsed.status, 'ok');
  assert.equal(parsed.snapshot.weekly?.usedPercent, 35, 'falls back to usable TOKENS_LIMIT when CREDIT_LIMIT is expired');
  assert.equal(parsed.snapshot.fiveHour?.usedPercent, 22);
});
