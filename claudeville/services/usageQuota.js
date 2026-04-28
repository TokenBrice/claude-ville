/**
 * usageQuota.js - Claude usage data collection and caching module
 *
 * Data source:
 *   A) ~/.claude/.credentials.json → subscriptionType, rateLimitTier
 *   B) ~/.claude/stats-cache.json → daily activity (messageCount, sessionCount, toolCallCount)
 *   C) claude auth status (once at server startup) → email
 *   D) api.anthropic.com/api/oauth/usage → 5h/7d quota (currently unavailable; retry periodically)
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
const HISTORY_TAIL_CHUNK_BYTES = 64 * 1024;
const HISTORY_MAX_TAIL_BYTES = 4 * 1024 * 1024;

// Cache store
const cache = {
  credentials: { data: null, ts: 0 },
  stats: { data: null, ts: 0 },
  email: null,
  quota: { data: null, ts: 0, available: false },
};

function readTailLines(filePath, maxBytes = HISTORY_MAX_TAIL_BYTES) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const stat = fs.fstatSync(fd);
    if (stat.size === 0) return [];
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
    return chunks.join('').trim().split('\n');
  } finally {
    fs.closeSync(fd);
  }
}

// ─── Credentials (extract subscription information only) ────────────────────────────

function readCredentials() {
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
    };
    cache.credentials = { data: result, ts: now };
    return result;
  } catch {
    return { subscriptionType: null, rateLimitTier: null };
  }
}

// ─── Email (once at server startup) ───────────────────────────────

function fetchEmail() {
  return new Promise((resolve) => {
    execFile('claude', ['auth', 'status'], { timeout: 10_000 }, (err, stdout) => {
      if (err) { resolve(null); return; }
      // "Logged in as user@example.com" pattern extraction
      const match = stdout.match(/(?:as|email[:\s]+)\s*([^\s]+@[^\s]+)/i);
      cache.email = match ? match[1] : null;
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
    const todayStr = nowDate.toISOString().slice(0, 10);
    const todayStart = new Date(todayStr + 'T00:00:00').getTime();

    // This Monday at 00:00
    const dayOfWeek = nowDate.getDay();
    const mondayOffset = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
    const monday = new Date(nowDate);
    monday.setDate(monday.getDate() - mondayOffset);
    monday.setHours(0, 0, 0, 0);
    const weekStart = monday.getTime();

    // Read a bounded tail from the end (newest data is at the end).
    const lines = readTailLines(HISTORY_PATH);

    let todayMsgs = 0, weekMsgs = 0;
    const todaySessions = new Set();
    const weekSessions = new Set();

    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const entry = JSON.parse(lines[i]);
        const ts = entry.timestamp;
        if (!ts) continue;

        // Stop when entries are older than this week
        if (ts < weekStart) break;

        weekMsgs++;
        if (entry.sessionId) weekSessions.add(entry.sessionId);

        if (ts >= todayStart) {
          todayMsgs++;
          if (entry.sessionId) todaySessions.add(entry.sessionId);
        }
      } catch { /* ignore lines that fail to parse */ }
    }

    return {
      today: { messages: todayMsgs, sessions: todaySessions.size },
      thisWeek: { messages: weekMsgs, sessions: weekSessions.size },
    };
  } catch {
    return empty;
  }
}

// ─── Quota API (currently unavailable; enable later) ────────────────────

function tryFetchQuota() {
  const now = Date.now();
  if (now - cache.quota.ts < QUOTA_API_TTL) return;
  cache.quota.ts = now;

  const creds = readCredentials();
  if (!creds.subscriptionType) return;

  // Read accessToken from credentials
  let accessToken;
  try {
    const raw = fs.readFileSync(CREDENTIALS_PATH, 'utf-8');
    const json = JSON.parse(raw);
    accessToken = json.claudeAiOauth?.accessToken;
  } catch { return; }

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
          const data = JSON.parse(body);
          cache.quota.data = {
            fiveHour: data.fiveHourPercent ?? data.five_hour_percent ?? null,
            sevenDay: data.sevenDayPercent ?? data.seven_day_percent ?? null,
          };
          cache.quota.available = true;
          console.log('[Usage] Quota API enabled!');
        } catch { /* parse failed */ }
      }
      // Ignore failures silently and retry on the next cycle.
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

  return {
    account: {
      subscriptionType: credentials.subscriptionType,
      rateLimitTier: credentials.rateLimitTier,
      email: cache.email,
    },
    quota: cache.quota.available
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
    quotaAvailable: cache.quota.available,
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
