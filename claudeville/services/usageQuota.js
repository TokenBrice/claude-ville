/**
 * usageQuota.js - Claude usage data collection and caching module
 *
 * Data source:
 *   A) ~/.claude/.credentials.json → subscriptionType, rateLimitTier
 *   B) ~/.claude/stats-cache.json → daily activity (messageCount, sessionCount, toolCallCount)
 *   C) claude auth status (once at server startup) → email
 *   D) api.anthropic.com/api/oauth/usage → 5h/7d quota utilization (refreshed every QUOTA_API_TTL)
 */

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const https = require('https');

const CLAUDE_HOME = path.join(require('os').homedir(), '.claude');
const CREDENTIALS_PATH = path.join(CLAUDE_HOME, '.credentials.json');
const STATS_CACHE_PATH = path.join(CLAUDE_HOME, 'stats-cache.json');
const HISTORY_PATH = path.join(CLAUDE_HOME, 'history.jsonl');

// Cache TTL
const CREDENTIALS_TTL = 30_000;   // 30 seconds
const STATS_TTL = 30_000;         // 30 seconds
const QUOTA_API_TTL = 5 * 60_000; // 5 minutes
const QUOTA_MAX_STALE_MS = 30 * 60_000; // stop trusting a frozen snapshot after 30 minutes of failures
const HISTORY_TAIL_CHUNK_BYTES = 64 * 1024;
const HISTORY_MAX_TAIL_BYTES = 4 * 1024 * 1024;

// Cache store
const cache = {
  credentials: { data: null, ts: 0 },
  stats: { data: null, ts: 0 },
  email: null,
  quota: { data: null, ts: 0, available: false, lastSuccessTs: 0 },
};

function readTailLines(filePath, maxBytes = HISTORY_MAX_TAIL_BYTES) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const stat = fs.fstatSync(fd);
    if (stat.size === 0) return { lines: [], truncated: false };
    const chunks = [];
    let position = stat.size;
    let bytesCollected = 0;
    while (position > 0 && bytesCollected < maxBytes) {
      const bytesToRead = Math.min(HISTORY_TAIL_CHUNK_BYTES, position, maxBytes - bytesCollected);
      position -= bytesToRead;
      const buffer = Buffer.allocUnsafe(bytesToRead);
      const bytesRead = fs.readSync(fd, buffer, 0, bytesToRead, position);
      if (bytesRead <= 0) break;
      chunks.unshift(buffer.toString('utf-8', 0, bytesRead));
      bytesCollected += bytesRead;
    }
    const text = chunks.join('').trim();
    return {
      lines: text ? text.split('\n') : [],
      truncated: position > 0,
    };
  } finally {
    fs.closeSync(fd);
  }
}

function aggregateHistoryLines(lines, todayStart, weekStart) {
  let todayMsgs = 0, weekMsgs = 0;
  let sawBeforeWeek = false;
  const todaySessions = new Set();
  const weekSessions = new Set();

  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const entry = JSON.parse(lines[i]);
      const ts = entry.timestamp;
      if (!ts) continue;

      // Stop when entries are older than this week.
      if (ts < weekStart) {
        sawBeforeWeek = true;
        break;
      }

      weekMsgs++;
      if (entry.sessionId) weekSessions.add(entry.sessionId);

      if (ts >= todayStart) {
        todayMsgs++;
        if (entry.sessionId) todaySessions.add(entry.sessionId);
      }
    } catch { /* ignore lines that fail to parse */ }
  }

  return {
    sawBeforeWeek,
    result: {
      today: { messages: todayMsgs, sessions: todaySessions.size },
      thisWeek: { messages: weekMsgs, sessions: weekSessions.size },
    },
  };
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

// ─── Email (once at server startup) ───────────────────────────────

function fetchEmail() {
  return new Promise((resolve) => {
    execFile('claude', ['auth', 'status'], { timeout: 10_000 }, (err, stdout) => {
      if (err) { resolve(null); return; }
      // Current CLI emits JSON ({"loggedIn":true,...,"email":"..."}); older builds
      // printed a plaintext "Logged in as user@example.com" line, so fall back to
      // the legacy regex when the output is not JSON.
      let email = null;
      try {
        const parsed = JSON.parse(stdout);
        if (parsed && typeof parsed.email === 'string' && parsed.email.trim()) {
          email = parsed.email.trim();
        }
      } catch {
        const match = stdout.match(/(?:as|email[:\s]+)\s*([^\s]+@[^\s]+)/i);
        email = match ? match[1] : null;
      }
      cache.email = email;
      resolve(cache.email);
    });
  });
}

// ─── Real-time history.jsonl parsing plus stats-cache.json merge ────────

function readStats() {
  const now = Date.now();
  if (cache.stats.data && now - cache.stats.ts < STATS_TTL) {
    return cache.stats.data;
  }

  // Calculate today/this-week activity directly from history.jsonl (real time)
  const live = readHistoryLive();

  // Read accumulated totals from stats-cache.json
  let totalSessions = 0, totalMessages = 0;
  try {
    const raw = fs.readFileSync(STATS_CACHE_PATH, 'utf-8');
    const json = JSON.parse(raw);
    totalSessions = json.totalSessions || 0;
    totalMessages = json.totalMessages || 0;
  } catch { /* ignore */ }

  const result = {
    today: live.today,
    thisWeek: live.thisWeek,
    totalSessions,
    totalMessages,
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

    // Read a bounded tail from the end (newest data is at the end).
    const tail = readTailLines(HISTORY_PATH);
    let aggregate = aggregateHistoryLines(tail.lines, todayStart, weekStart);

    if (tail.truncated && !aggregate.sawBeforeWeek) {
      const raw = fs.readFileSync(HISTORY_PATH, 'utf-8').trim();
      const fullLines = raw ? raw.split('\n') : [];
      aggregate = aggregateHistoryLines(fullLines, todayStart, weekStart);
    }

    return aggregate.result;
  } catch {
    return empty;
  }
}

// ─── Quota API ──────────────────────────────────────────────────

/**
 * Convert one quota window from the OAuth usage response into a 0-1 ratio.
 * The API reports `utilization` as a 0-100 percentage; all frontend and
 * widget consumers expect a 0-1 ratio.
 */
function quotaRatio(window) {
  const utilization = Number(window?.utilization);
  if (!Number.isFinite(utilization)) return null;
  return Math.min(1, Math.max(0, utilization / 100));
}

function tryFetchQuota() {
  const now = Date.now();
  if (now - cache.quota.ts < QUOTA_API_TTL) return;
  cache.quota.ts = now;

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
    let body = '';
    res.on('data', chunk => { body += chunk; });
    res.on('end', () => {
      if (res.statusCode === 200) {
        try {
          // Response shape: { five_hour: { utilization, resets_at },
          //                   seven_day: { utilization, resets_at }, ... }
          const data = JSON.parse(body);
          const fiveHour = quotaRatio(data.five_hour);
          const sevenDay = quotaRatio(data.seven_day);
          if (fiveHour === null && sevenDay === null) return;
          cache.quota.data = { fiveHour, sevenDay };
          cache.quota.lastSuccessTs = Date.now();
          if (!cache.quota.available) console.log('[Usage] Quota API available');
          cache.quota.available = true;
        } catch { /* parse failed; retry on the next cycle */ }
      }
      // On non-200 (expired token, upstream outage) keep the last good
      // snapshot, if any, and retry after QUOTA_API_TTL.
    });
  });

  req.on('error', () => { /* ignore network errors */ });
  req.on('timeout', () => { req.destroy(); });
  req.end();
}

// ─── Public API ────────────────────────────────────────────────

function fetchUsage() {
  const credentials = readCredentials();
  const stats = readStats();

  // Try the quota API asynchronously (store results in the cache)
  tryFetchQuota();

  // A snapshot that has not refreshed in QUOTA_MAX_STALE_MS is treated as
  // unavailable so consumers fall back cleanly instead of trusting frozen numbers.
  const quotaFresh = cache.quota.available
    && (Date.now() - cache.quota.lastSuccessTs) <= QUOTA_MAX_STALE_MS;

  return {
    provider: 'claude',
    account: {
      subscriptionType: credentials.subscriptionType,
      rateLimitTier: credentials.rateLimitTier,
      email: cache.email,
    },
    quota: quotaFresh
      ? cache.quota.data
      : { fiveHour: null, sevenDay: null },
    activity: {
      today: stats.today,
      thisWeek: stats.thisWeek,
    },
    totals: {
      sessions: stats.totalSessions,
      messages: stats.totalMessages,
    },
    quotaAvailable: quotaFresh,
  };
}

function init() {
  // Fetch email at server startup (async)
  fetchEmail().then(email => {
    if (email) console.log(`[Usage] Account: ${email}`);
    else console.log('[Usage] Failed to fetch email (claude auth status)');
  });

  // Initial quota API attempt
  tryFetchQuota();
}

module.exports = { fetchUsage, init };
