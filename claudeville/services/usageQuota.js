/**
 * usageQuota.js - Claude usage data collection and caching module
 *
 * Data source:
 *   A) ~/.claude/.credentials.json → subscriptionType, rateLimitTier
 *   B) ~/.claude/history.jsonl → today/this-week activity (bounded reverse scan)
 *   C) api.anthropic.com/api/oauth/usage → 5h/7d quota utilization (refreshed every QUOTA_API_TTL)
 *
 * SV-10: it never spawns a CLI (a boot-time `claude auth status` fetched an
 * email no client read) and serves no frozen `stats-cache.json` totals.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const CLAUDE_HOME = path.join(require('os').homedir(), '.claude');
const CREDENTIALS_PATH = path.join(CLAUDE_HOME, '.credentials.json');
const HISTORY_PATH = path.join(CLAUDE_HOME, 'history.jsonl');

// Cache TTL
const CREDENTIALS_TTL = 30_000;   // 30 seconds
const STATS_TTL = 30_000;         // 30 seconds
const QUOTA_API_TTL = 5 * 60_000; // 5 minutes
const QUOTA_MAX_STALE_MS = 30 * 60_000; // stop trusting a frozen snapshot after 30 minutes of failures
const QUOTA_RESPONSE_MAX_BYTES = 256 * 1024;
const HISTORY_TAIL_CHUNK_BYTES = 64 * 1024;
const HISTORY_MAX_LINE_BYTES = 4 * 1024 * 1024;

// Cache store
const cache = {
  credentials: { data: null, ts: 0 },
  stats: { data: null, ts: 0 },
  quota: { data: null, nextAttemptAt: 0, available: false, lastSuccessTs: 0, error: null },
};
// Set by init(): told when the quota snapshot or its failure state changes, so
// the server can push the new usage without waiting for a session scan.
const quotaHooks = { onChange: null };

function aggregateHistoryFile(filePath, todayStart, weekStart) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const stat = fs.fstatSync(fd);
    let todayMessages = 0;
    let weekMessages = 0;
    const todaySessions = new Set();
    const weekSessions = new Set();
    let position = stat.size;
    let carry = Buffer.alloc(0);
    let skippingOversizedLine = false;
    let reachedBoundary = false;

    const consumeLine = (line) => {
      if (line.length === 0 || line.length > HISTORY_MAX_LINE_BYTES) return true;
      try {
        const entry = JSON.parse(line.toString('utf8'));
        const rawTimestamp = entry.timestamp;
        const timestamp = Number.isFinite(Number(rawTimestamp))
          ? Number(rawTimestamp)
          : Date.parse(rawTimestamp);
        if (!Number.isFinite(timestamp)) return true;
        if (timestamp < weekStart) {
          reachedBoundary = true;
          return false;
        }
        weekMessages++;
        if (entry.sessionId) weekSessions.add(entry.sessionId);
        if (timestamp >= todayStart) {
          todayMessages++;
          if (entry.sessionId) todaySessions.add(entry.sessionId);
        }
      } catch { /* ignore malformed lines */ }
      return true;
    };

    while (position > 0 && !reachedBoundary) {
      const bytesToRead = Math.min(HISTORY_TAIL_CHUNK_BYTES, position);
      position -= bytesToRead;
      const buffer = Buffer.allocUnsafe(bytesToRead);
      const bytesRead = fs.readSync(fd, buffer, 0, bytesToRead, position);
      if (bytesRead <= 0) break;

      let combined = buffer.subarray(0, bytesRead);
      if (skippingOversizedLine) {
        const boundary = combined.lastIndexOf(0x0a);
        if (boundary === -1) continue;
        combined = combined.subarray(0, boundary);
        skippingOversizedLine = false;
      } else if (carry.length > 0) {
        combined = Buffer.concat([combined, carry], combined.length + carry.length);
      }

      let lineEnd = combined.length;
      for (let index = combined.length - 1; index >= 0; index--) {
        if (combined[index] !== 0x0a) continue;
        if (!consumeLine(combined.subarray(index + 1, lineEnd))) break;
        lineEnd = index;
      }
      if (reachedBoundary) break;

      const fragment = combined.subarray(0, lineEnd);
      if (fragment.length > HISTORY_MAX_LINE_BYTES) {
        carry = Buffer.alloc(0);
        skippingOversizedLine = true;
      } else {
        carry = Buffer.from(fragment);
      }
    }

    if (!reachedBoundary && position === 0 && !skippingOversizedLine && carry.length > 0) {
      consumeLine(carry);
    }

    return {
      today: { messages: todayMessages, sessions: todaySessions.size },
      thisWeek: { messages: weekMessages, sessions: weekSessions.size },
    };
  } finally {
    fs.closeSync(fd);
  }
}

// ─── Credentials (extract subscription information only) ────────────────────────────

function readClaudeOauthCredentials() {
  const now = Date.now();
  if (cache.credentials.data && now - cache.credentials.ts < CREDENTIALS_TTL) {
    return cache.credentials.data;
  }
  try {
    const raw = fs.readFileSync(CREDENTIALS_PATH, 'utf-8');
    const json = JSON.parse(raw);
    const oauth = json.claudeAiOauth || {};
    const result = {
      subscriptionType: oauth.subscriptionType || null,
      rateLimitTier: oauth.rateLimitTier || null,
      accessToken: oauth.accessToken || null,
    };
    cache.credentials = { data: result, ts: now };
    return result;
  } catch {
    return { subscriptionType: null, rateLimitTier: null, accessToken: null };
  }
}

function readCredentials() {
  const oauth = readClaudeOauthCredentials();
  return {
    subscriptionType: oauth.subscriptionType,
    rateLimitTier: oauth.rateLimitTier,
  };
}

// ─── Real-time history.jsonl parsing ────────

function readStats() {
  const now = Date.now();
  if (cache.stats.data && now - cache.stats.ts < STATS_TTL) {
    return cache.stats.data;
  }

  // Calculate today/this-week activity directly from history.jsonl (real time)
  const live = readHistoryLive();
  const result = {
    today: live.today,
    thisWeek: live.thisWeek,
  };

  cache.stats = { data: result, ts: now };
  return result;
}

/**
 * Calculate today/this-week message and session counts directly from history.jsonl
 * Read the file from the end and stop outside the date range (performance optimization)
 */
function readHistoryLive() {
  const empty = {
    today: { messages: 0, sessions: 0 },
    thisWeek: { messages: 0, sessions: 0 },
  };

  try {
    if (!fs.existsSync(HISTORY_PATH)) return empty;

    const nowDate = new Date();
    const today = new Date(nowDate);
    today.setHours(0, 0, 0, 0);
    const todayStart = today.getTime();

    // This Monday at 00:00
    const dayOfWeek = nowDate.getDay();
    const mondayOffset = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
    const monday = new Date(nowDate);
    monday.setDate(monday.getDate() - mondayOffset);
    monday.setHours(0, 0, 0, 0);
    const weekStart = monday.getTime();

    return aggregateHistoryFile(HISTORY_PATH, todayStart, weekStart);
  } catch {
    return empty;
  }
}

// ─── Quota API ──────────────────────────────────────────────────

/**
 * Convert one quota window from the OAuth usage response into a 0-1 ratio.
 * The API reports `utilization` as a 0-100 percentage; all frontend
 * consumers expect a 0-1 ratio.
 */
function quotaRatio(window) {
  const utilization = Number(window?.utilization);
  if (!Number.isFinite(utilization)) return null;
  return Math.min(1, Math.max(0, utilization / 100));
}

// A window's `resets_at` as epoch ms. The API writes an ISO 8601 string; a bare
// number is read as epoch seconds, or as ms when it is already that large.
function resetsAtMs(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  if (value === '') return null;
  const number = Number(value);
  const ms = Number.isFinite(number)
    ? (number > 1e12 ? number : number * 1000)
    : Date.parse(value);
  return Number.isFinite(ms) && ms > 0 ? Math.round(ms) : null;
}

// SV-7 — the two failures that matter get a name instead of a silent drain:
// 401 (the stored token expired or was revoked; running `claude` refreshes it)
// and 429 (this check is throttled). Other failures keep retrying, and the
// last snapshot still ages out after QUOTA_MAX_STALE_MS.
const QUOTA_ERROR_STATUSES = new Set([401, 429]);
const EMPTY_QUOTA = Object.freeze({
  fiveHour: null,
  sevenDay: null,
  fiveHourResetsAt: null,
  sevenDayResetsAt: null,
});

function notifyQuotaChange() {
  try {
    quotaHooks.onChange?.();
  } catch { /* a listener failure never breaks the quota cache */ }
}

// A throttled check waits two refresh periods, or the server's Retry-After
// (seconds or an HTTP date) when that is longer, but never past the age at
// which the snapshot stops being trusted anyway.
function quotaRetryDelayMs(retryAfter, now = Date.now()) {
  const seconds = Number(retryAfter);
  const requested = Number.isFinite(seconds) && retryAfter !== ''
    ? seconds * 1000
    : Date.parse(String(retryAfter ?? '')) - now;
  const delay = Number.isFinite(requested) ? requested : 0;
  return Math.min(QUOTA_MAX_STALE_MS, Math.max(2 * QUOTA_API_TTL, delay));
}

function recordQuotaSuccess(data, now = Date.now()) {
  // Response shape: { five_hour: { utilization, resets_at },
  //                   seven_day: { utilization, resets_at }, ... }
  const fiveHour = quotaRatio(data?.five_hour);
  const sevenDay = quotaRatio(data?.seven_day);
  if (fiveHour === null && sevenDay === null) return;
  cache.quota.data = {
    provider: 'claude',
    fiveHour,
    sevenDay,
    fiveHourResetsAt: resetsAtMs(data.five_hour?.resets_at),
    sevenDayResetsAt: resetsAtMs(data.seven_day?.resets_at),
  };
  cache.quota.lastSuccessTs = now;
  cache.quota.error = null;
  if (!cache.quota.available) console.log('[Usage] Quota API available');
  cache.quota.available = true;
  notifyQuotaChange();
}

function recordQuotaFailure(statusCode, headers = {}, now = Date.now()) {
  if (!QUOTA_ERROR_STATUSES.has(statusCode)) return;
  const previous = cache.quota.error;
  const hadSnapshot = cache.quota.data !== null;
  // `at` is when this failure began; a repeat of the same status keeps it.
  cache.quota.error = previous?.status === statusCode ? previous : { status: statusCode, at: now };
  if (statusCode === 401) {
    // An expired token never refreshes on its own: drop the numbers now
    // instead of serving them frozen for QUOTA_MAX_STALE_MS.
    if (previous?.status !== 401) {
      console.log('[Usage] Quota API rejected the stored token (401); running `claude` refreshes it');
    }
    cache.quota.available = false;
    cache.quota.data = null;
  } else {
    // 429: the last snapshot stays until it ages out; the next check backs off.
    cache.quota.nextAttemptAt = now + quotaRetryDelayMs(headers?.['retry-after'], now);
  }
  if (cache.quota.error !== previous || (hadSnapshot && cache.quota.data === null)) notifyQuotaChange();
}

function consumeQuotaResponse(res, onJson, { maxBytes = QUOTA_RESPONSE_MAX_BYTES, onFailure = null } = {}) {
  if (res.statusCode !== 200) {
    // Error pages are not useful quota data; drain without retaining them.
    res.resume();
    onFailure?.(res.statusCode, res.headers || {});
    return;
  }

  let body = '';
  let bodyBytes = 0;
  let overflowed = false;
  res.on('data', chunk => {
    if (overflowed) return;
    bodyBytes += Buffer.byteLength(chunk);
    if (bodyBytes > maxBytes) {
      overflowed = true;
      body = '';
      res.destroy();
      return;
    }
    body += chunk;
  });
  res.on('end', () => {
    if (overflowed) return;
    try {
      onJson(JSON.parse(body));
    } catch { /* parse failed; retry on the next cycle */ }
  });
}

function tryFetchQuota(now = Date.now()) {
  if (now < cache.quota.nextAttemptAt) return;
  cache.quota.nextAttemptAt = now + QUOTA_API_TTL;

  const creds = readClaudeOauthCredentials();
  if (!creds.subscriptionType) return;

  const accessToken = creds.accessToken;
  if (!accessToken) return;

  const options = {
    hostname: 'api.anthropic.com',
    path: '/api/oauth/usage',
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    timeout: 5000,
  };

  const req = https.request(options, (res) => {
    consumeQuotaResponse(res, data => recordQuotaSuccess(data, Date.now()), {
      onFailure: (statusCode, headers) => recordQuotaFailure(statusCode, headers, Date.now()),
    });
  });

  req.on('error', () => { /* ignore network errors */ });
  req.on('timeout', () => { req.destroy(); });
  req.end();
}

// ─── Public API ────────────────────────────────────────────────

function fetchUsage() {
  const now = Date.now();
  const credentials = readCredentials();
  const stats = readStats();

  // Try the quota API asynchronously (store results in the cache)
  tryFetchQuota(now);

  // A snapshot that has not refreshed in QUOTA_MAX_STALE_MS is treated as
  // unavailable so consumers fall back cleanly instead of trusting frozen numbers.
  const quotaFresh = cache.quota.available
    && cache.quota.data !== null
    && (now - cache.quota.lastSuccessTs) <= QUOTA_MAX_STALE_MS;

  return {
    provider: 'claude',
    account: {
      subscriptionType: credentials.subscriptionType,
      rateLimitTier: credentials.rateLimitTier,
    },
    quota: quotaFresh ? cache.quota.data : EMPTY_QUOTA,
    // `{ status: 401 | 429, at }` while the last quota check failed that way
    // (`at` is when the failure began); null otherwise.
    quotaError: cache.quota.error,
    activity: {
      today: stats.today,
      thisWeek: stats.thisWeek,
    },
    quotaAvailable: quotaFresh,
  };
}

function init({ onChange = null } = {}) {
  quotaHooks.onChange = typeof onChange === 'function' ? onChange : null;
  // Initial quota API attempt
  tryFetchQuota();
}

module.exports = {
  fetchUsage,
  init,
  _test: {
    consumeQuotaResponse,
    quotaRetryDelayMs,
    recordQuotaFailure,
    recordQuotaSuccess,
    resetsAtMs,
    resetQuotaCache({ nextAttemptAt = Infinity } = {}) {
      cache.quota = { data: null, nextAttemptAt, available: false, lastSuccessTs: 0, error: null };
      quotaHooks.onChange = null;
    },
    setQuotaChangeListener(listener) {
      quotaHooks.onChange = listener;
    },
    QUOTA_API_TTL,
    QUOTA_MAX_STALE_MS,
    QUOTA_RESPONSE_MAX_BYTES,
  },
};
