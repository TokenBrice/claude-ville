/**
 * usageQuota.js - account usage and quota (Claude, Codex, GLM/z.AI, Antigravity)
 *
 * Data source:
 *   A) ~/.claude/.credentials.json → subscriptionType, rateLimitTier
 *   B) ~/.claude/history.jsonl → today/this-week activity (bounded reverse scan)
 *   C) api.anthropic.com/api/oauth/usage → Claude account quota windows and limits (refreshed every QUOTA_API_TTL)
 *   D) the Codex adapter's newest `token_count.rate_limits` → `codex` (no I/O here)
 *   E) api.z.ai/api/monitor/usage/quota/limit → GLM/z.AI account quota (optional, only when key configured)
 *   F) ~/.t3/caches/antigravity.json (zero-network primary) + optional standalone OAuth fallback → `antigravity`
 *
 * SV-10: it never spawns a CLI (a boot-time `claude auth status` fetched an
 * email no client read) and serves no frozen `stats-cache.json` totals.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const crypto = require('crypto');

const DEFAULT_HOME = os.homedir();
const CLAUDE_HOME = path.join(DEFAULT_HOME, '.claude');
const CREDENTIALS_PATH = path.join(CLAUDE_HOME, '.credentials.json');
const HISTORY_PATH = path.join(CLAUDE_HOME, 'history.jsonl');

// Cache TTL
const CREDENTIALS_TTL = 30_000;   // 30 seconds
const STATS_TTL = 30_000;         // 30 seconds
const QUOTA_API_TTL = 5 * 60_000; // 5 minutes
const QUOTA_MAX_STALE_MS = 30 * 60_000; // stop trusting a frozen snapshot after 30 minutes of failures
const QUOTA_RESPONSE_MAX_BYTES = 256 * 1024;
const QUOTA_REQUEST_TIMEOUT_MS = 5000;
const HISTORY_TAIL_CHUNK_BYTES = 64 * 1024;
const HISTORY_MAX_LINE_BYTES = 4 * 1024 * 1024;

// GLM / z.AI quota constants
const DEFAULT_GLM_QUOTA_URL = 'https://api.z.ai/api/monitor/usage/quota/limit';
const GLM_ALLOWED_HOSTS = Object.freeze(new Set([
  'api.z.ai',
  'open.bigmodel.cn',
  'dev.bigmodel.cn',
]));
const GLM_MAX_LIMIT_ROWS = 64;
const GLM_ERROR_STATUSES = new Set([401, 403, 429, 'invalid-credential']);

// Antigravity quota constants
const ANTIGRAVITY_CACHE_POLL_MS = 30_000;
const ANTIGRAVITY_CACHE_MAX_STALE_MS = 6 * 60 * 60_000; // 6 hours
const ANTIGRAVITY_CACHE_MAX_BYTES = 2 * 1024 * 1024;
const ANTIGRAVITY_OAUTH_MIN_REMAINING_MS = 60_000;
const DEFAULT_ANTIGRAVITY_OAUTH_URL = 'https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary';
const ANTIGRAVITY_ALLOWED_HOSTS = Object.freeze(new Set([
  'daily-cloudcode-pa.googleapis.com',
  'cloudcode-pa.googleapis.com',
]));
const ANTIGRAVITY_ERROR_STATUSES = new Set([401, 403, 429, 'invalid-credential']);

// Cache store
const cache = {
  credentials: { data: null, ts: 0 },
  stats: { data: null, ts: 0 },
  quota: { data: null, nextAttemptAt: 0, available: false, lastSuccessTs: 0, error: null },
  glmCreds: { key: null, fingerprint: null, ts: 0 },
  glm: { data: null, nextAttemptAt: 0, available: false, lastSuccessTs: 0, error: null, fingerprint: null },
  antigravityFile: {
    lastPollAt: 0,
    mtimeMs: -1,
    size: -1,
    exists: false,
    data: null,
    signature: '',
  },
  antigravityOauth: { data: null, nextAttemptAt: 0, available: false, lastSuccessTs: 0, error: null, fingerprint: null },
};
// Set by init(). `onChange` hears when a quota snapshot or its failure state
// changes, so the server can push the new usage without waiting for a session
// scan. `codexRateLimits` returns the Codex adapter's newest rate-limit
// observation (SV-6). Optional injection overrides stay null in production.
const quotaHooks = {
  onChange: null,
  codexRateLimits: null,
  glmApiKey: null,
  glmEndpoint: null,
  glmRequest: null,
  glmCredentialsPath: null,
  antigravityCachePath: null,
  antigravityTokenPaths: null,
  antigravityEndpoint: null,
  antigravityRequest: null,
  env: null,
  homeDir: null,
};
let antigravityPollTimer = null;

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
  if (window?.utilization == null) return null;
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

function isQuotaLabel(value) {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9_.:/-]{0,127}$/i.test(value);
}

function activeQuotaLimit(limit) {
  if (limit?.is_active !== true) return null;
  const { kind, percent, severity, scope = null } = limit;
  if (!Number.isFinite(percent) || percent < 0) return null;
  if (!isQuotaLabel(kind) || !isQuotaLabel(severity)) return null;
  if (scope !== null && !isQuotaLabel(scope?.model)) return null;
  return {
    kind,
    usedPercent: percent,
    severity,
    scope: scope === null ? null : { model: scope.model },
    resetsAt: resetsAtMs(limit.resets_at),
  };
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
  const limits = Array.isArray(data?.limits) ? data.limits : [];
  const highestActiveLimit = limits.map(activeQuotaLimit).filter(Boolean).reduce((best, limit) => (
    !best || limit.usedPercent > best.usedPercent ? limit : best
  ), null);
  const sessionLimits = limits.filter(limit => limit?.kind === 'session' && limit.scope == null);
  const sessionLimit = sessionLimits.length === 1 ? sessionLimits[0] : null;
  const legacyFiveHour = quotaRatio(data?.five_hour);
  const useSessionLimit = legacyFiveHour === null && Number.isFinite(sessionLimit?.percent) && sessionLimit.percent >= 0;
  const fiveHour = useSessionLimit ? Math.min(1, sessionLimit.percent / 100) : legacyFiveHour;
  const sevenDay = quotaRatio(data?.seven_day);
  if (fiveHour === null && sevenDay === null && highestActiveLimit === null) return;
  cache.quota.data = {
    provider: 'claude',
    fiveHour,
    sevenDay,
    fiveHourResetsAt: resetsAtMs(useSessionLimit ? sessionLimit.resets_at : data.five_hour?.resets_at),
    sevenDayResetsAt: resetsAtMs(data.seven_day?.resets_at),
    ...(useSessionLimit && { fiveHourSource: 'limits' }),
    ...(highestActiveLimit && { highestActiveLimit }),
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
  if (!accessToken || !isValidHeaderCredential(accessToken)) return;

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

  try {
    const req = https.request(options, (res) => {
      consumeQuotaResponse(res, data => recordQuotaSuccess(data, Date.now()), {
        onFailure: (statusCode, headers) => recordQuotaFailure(statusCode, headers, Date.now()),
      });
    });

    req.on('error', () => { /* ignore network errors */ });
    req.on('timeout', () => { req.destroy(); });
    req.end();
  } catch {
    /* never crash startup on malformed credential or transport setup failure */
  }
}

// ─── Codex quota (SV-6 / PV-7) ─────────────────────────────────

/**
 * `/api/usage.codex` from the newest observation (see `noteCodexRateLimits`
 * in `adapters/codex.js`), or null when no rollout carried `rate_limits`.
 *
 * The reported window is the binding one: the highest `used_percent` among
 * the windows that have not reset since they were observed. A window past its
 * `resetsAt` no longer describes the account, so its use is unknown (null),
 * never 0 %. Per user decision Q3, `limitReached` is true at 100 % (Codex keeps
 * working on paid credits there) or whenever `rate_limit_reached_type` is set.
 * It is for account surfaces only and never changes a session's status.
 */
function codexQuotaFromObservation(observation, now = Date.now()) {
  if (!observation || !Number.isFinite(observation.observedAt)) return null;
  const windows = [observation.primary, observation.secondary].filter(Boolean);
  const current = windows.filter(window => !(window.resetsAt !== null && window.resetsAt <= now));
  const highest = list => list.reduce((best, window) => (!best || window.usedPercent > best.usedPercent ? window : best), null);
  const binding = highest(current);
  const shape = binding || highest(windows);
  const allReset = windows.length > 0 && current.length === 0;
  const toCodexWindow = (window) => (window ? {
    usedPercent: window.usedPercent,
    windowMinutes: window.windowMinutes,
    resetsAt: window.resetsAt,
  } : null);
  const isCurrent = (window) => Boolean(window) && current.includes(window);
  const weeklyCandidates = current.filter(window => Number.isFinite(window.windowMinutes) && window.windowMinutes >= 1440);
  const fiveHourCandidates = current.filter(window => Number.isFinite(window.windowMinutes) && window.windowMinutes > 0 && window.windowMinutes < 1440);
  const weeklySource = highest(weeklyCandidates)
    || (isCurrent(observation.secondary) && !Number.isFinite(observation.secondary.windowMinutes) ? observation.secondary : null);
  const fiveHourSource = highest(fiveHourCandidates)
    || (isCurrent(observation.primary) && !Number.isFinite(observation.primary.windowMinutes) ? observation.primary : null);
  const credits = observation.credits || {};
  const change = observation.creditChange;
  const ageMs = now - observation.observedAt;
  const comparable = Number.isFinite(change?.delta) && Number.isFinite(change.intervalMs)
    && change.intervalMs > 0 && ageMs >= 0 && ageMs + change.intervalMs <= QUOTA_MAX_STALE_MS;
  return {
    usedPercent: binding ? binding.usedPercent : null,
    windowMinutes: shape ? shape.windowMinutes : null,
    resetsAt: binding ? binding.resetsAt : null,
    weekly: toCodexWindow(weeklySource),
    fiveHour: toCodexWindow(fiveHourSource),
    credits: {
      balance: Number.isFinite(credits.balance) ? credits.balance : null,
      hasCredits: typeof credits.hasCredits === 'boolean' ? credits.hasCredits : null,
      unlimited: typeof credits.unlimited === 'boolean' ? credits.unlimited : null,
    },
    limitReached: !allReset && ((binding?.usedPercent ?? 0) >= 100 || observation.reached === true),
    observedAt: observation.observedAt,
    // Minute-grain age keeps transcript-only updates from rewriting usage on every scan.
    ...(comparable ? { creditChange: { delta: change.delta, intervalMs: change.intervalMs, ageMs: Math.floor(ageMs / 60_000) * 60_000 } } : {}),
  };
}

function readCodexQuota(now) {
  try {
    return codexQuotaFromObservation(quotaHooks.codexRateLimits?.() || null, now);
  } catch {
    return null;
  }
}

// ─── Shared helpers for GLM & Antigravity quota ────────────────

function activeEnv() {
  return quotaHooks.env || process.env;
}

function activeHomeDir() {
  return quotaHooks.homeDir || DEFAULT_HOME;
}

function t3RootDir() {
  const env = activeEnv();
  const explicit = typeof env.CLAUDEVILLE_T3_DIR === 'string' ? env.CLAUDEVILLE_T3_DIR.trim() : '';
  if (explicit) {
    return path.basename(explicit) === 'userdata' ? path.dirname(explicit) : explicit;
  }
  return path.join(activeHomeDir(), '.t3');
}

function secretFingerprint(secret) {
  if (typeof secret !== 'string' || !secret) return null;
  return crypto.createHash('sha256').update(secret).digest('hex');
}

function isValidHeaderCredential(value) {
  return typeof value === 'string'
    && value.length > 0
    && !/[\r\n\0]/.test(value)
    && /^[\x21-\x7e]+(?:[ \x21-\x7e]*[\x21-\x7e])?$/.test(value);
}

function finiteNumericInput(value) {
  if (value === null || value === undefined || typeof value === 'boolean') return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function clampPercent(value) {
  const numeric = finiteNumericInput(value);
  if (numeric === null) return null;
  return Math.min(100, Math.max(0, numeric));
}

function nonNegativeFinite(value) {
  const numeric = finiteNumericInput(value);
  return numeric !== null && numeric >= 0 ? numeric : null;
}

function parseIsoOrEpochMs(value) {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    // Clamp sub-millisecond fractional digits (e.g. Go RFC3339Nano) for strict parsers.
    const normalized = trimmed.replace(/(\.\d{3})\d+/, '$1');
    return resetsAtMs(normalized);
  }
  return resetsAtMs(value);
}

function dropExpiredIsoWindow(window, now) {
  if (!window) return null;
  if (window.resetsAt !== null && window.resetsAt !== undefined) {
    const ms = parseIsoOrEpochMs(window.resetsAt);
    if (ms !== null && ms <= now) return null;
  }
  return window;
}

// ─── GLM / z.AI Quota API ──────────────────────────────────────

function glmCredentialsFilePath() {
  if (typeof quotaHooks.glmCredentialsPath === 'string' && quotaHooks.glmCredentialsPath) {
    return quotaHooks.glmCredentialsPath;
  }
  const env = activeEnv();
  const xdg = !quotaHooks.homeDir && typeof env.XDG_CONFIG_HOME === 'string' && env.XDG_CONFIG_HOME.trim()
    ? env.XDG_CONFIG_HOME.trim()
    : path.join(activeHomeDir(), '.config');
  return path.join(xdg, 'glm-acp-agent', 'credentials.json');
}

function readGlmApiKey(now = Date.now()) {
  if (typeof quotaHooks.glmApiKey === 'function') {
    const injected = quotaHooks.glmApiKey();
    return typeof injected === 'string' && injected.trim() ? injected.trim() : null;
  }
  if (typeof quotaHooks.glmApiKey === 'string') {
    return quotaHooks.glmApiKey.trim() || null;
  }
  if (cache.glmCreds.ts > 0 && (now - cache.glmCreds.ts) < CREDENTIALS_TTL) {
    return cache.glmCreds.key;
  }
  const env = activeEnv();
  let key = null;
  for (const name of ['GLM_MCP_API_KEY', 'ZAI_API_KEY', 'Z_AI_API_KEY']) {
    const candidate = env[name];
    if (typeof candidate === 'string' && candidate.trim()) {
      key = candidate.trim();
      break;
    }
  }
  if (!key) {
    try {
      const credPath = glmCredentialsFilePath();
      if (fs.existsSync(credPath)) {
        const parsed = JSON.parse(fs.readFileSync(credPath, 'utf8'));
        for (const field of ['z_ai_api_key', 'apiKey', 'api_key', 'key']) {
          const candidate = parsed?.[field];
          if (typeof candidate === 'string' && candidate.trim()) {
            key = candidate.trim();
            break;
          }
        }
      }
    } catch { /* ignore unreadable/malformed credentials file */ }
  }
  cache.glmCreds = { key, fingerprint: secretFingerprint(key), ts: now };
  return key;
}

/**
 * Resolve and validate the GLM quota endpoint against the strict HTTPS host
 * allowlist (`api.z.ai`, `open.bigmodel.cn`, `dev.bigmodel.cn`). Rejects any
 * non-HTTPS, custom-port, credential-bearing, or non-allowlisted URL.
 */
function resolveGlmQuotaUrl(rawUrl) {
  const candidate = rawUrl === undefined
    ? (quotaHooks.glmEndpoint || activeEnv().GLM_QUOTA_URL || activeEnv().ACP_GLM_BASE_URL || DEFAULT_GLM_QUOTA_URL)
    : rawUrl;
  if (typeof candidate !== 'string' || !candidate.trim()) return null;
  let parsed;
  try {
    parsed = new URL(candidate.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:'
    || parsed.username
    || parsed.password
    || parsed.port
    || !GLM_ALLOWED_HOSTS.has(parsed.hostname)) {
    return null;
  }
  return new URL('/api/monitor/usage/quota/limit', parsed.origin);
}

function normalizeGlmWindow(row, now = Date.now()) {
  if (!row || typeof row !== 'object') return null;
  const resetMs = parseIsoOrEpochMs(row.nextResetTime);
  if (resetMs !== null && resetMs <= now) return null;
  const used = nonNegativeFinite(row.currentValue);
  const limit = nonNegativeFinite(row.usage);
  const remaining = nonNegativeFinite(row.remaining)
    ?? (used !== null && limit !== null ? Math.max(0, limit - used) : null);
  const explicitPct = nonNegativeFinite(row.percentage);
  const computedPct = used !== null && limit !== null && limit > 0
    ? (used / limit) * 100
    : null;
  const rawPct = explicitPct !== null ? explicitPct : computedPct;
  const usedPercent = rawPct !== null ? clampPercent(rawPct) : null;
  if (usedPercent === null) return null;
  return {
    usedPercent,
    used,
    limit,
    remaining,
    resetsAt: resetMs !== null ? new Date(resetMs).toISOString() : null,
  };
}

function selectGlmWindow(limits, matcher, now) {
  let matched = false;
  let creditWindow = null;
  let tokenWindow = null;
  for (const row of limits) {
    if (!row || typeof row !== 'object') continue;
    const unit = Number(row.unit);
    const number = Number(row.number);
    if (!Number.isFinite(unit) || !Number.isFinite(number)) continue;
    if (!matcher(unit, number)) continue;
    if (row.type !== 'CREDIT_LIMIT' && row.type !== 'TOKENS_LIMIT') continue;
    matched = true;
    const normalized = normalizeGlmWindow(row, now);
    if (!normalized) continue;
    if (row.type === 'CREDIT_LIMIT' && !creditWindow) creditWindow = normalized;
    else if (row.type === 'TOKENS_LIMIT' && !tokenWindow) tokenWindow = normalized;
  }
  return { matched, window: creditWindow || tokenWindow };
}

function parseGlmQuotaPayload(payload, now = Date.now()) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return { status: 'invalid' };
  const code = payload.code;
  if (code === 401 || code === '401') return { status: 'error', statusCode: 401 };
  if (code === 403 || code === '403') return { status: 'error', statusCode: 403 };
  if (payload.success === false || (code !== undefined && ![0, 200, '0', '200'].includes(code))) {
    return { status: 'invalid' };
  }
  const data = payload.data && typeof payload.data === 'object' && !Array.isArray(payload.data)
    ? payload.data
    : null;
  const limits = Array.isArray(data?.limits) ? data.limits : null;
  if (!limits || limits.length === 0 || limits.length > GLM_MAX_LIMIT_ROWS) {
    return { status: 'invalid' };
  }

  const weekly = selectGlmWindow(
    limits,
    (unit, number) => (unit === 6 && number === 1) || (unit === 4 && number === 7),
    now,
  );
  const fiveHour = selectGlmWindow(
    limits,
    (unit, number) => unit === 3 && number === 5,
    now,
  );
  if (!weekly.matched && !fiveHour.matched) return { status: 'invalid' };

  const plan = typeof data.level === 'string' && data.level.trim() ? data.level.trim() : null;
  return {
    status: 'ok',
    snapshot: {
      plan,
      weekly: weekly.window,
      fiveHour: fiveHour.window,
      observedAt: new Date(now).toISOString(),
    },
  };
}

function recordGlmQuotaSuccess(payload, now = Date.now()) {
  const parsed = parseGlmQuotaPayload(payload, now);
  if (parsed.status === 'error') {
    recordGlmQuotaFailure(parsed.statusCode, {}, now);
    return;
  }
  if (parsed.status !== 'ok') return;
  cache.glm.data = parsed.snapshot;
  cache.glm.lastSuccessTs = now;
  cache.glm.error = null;
  if (!cache.glm.available) console.log('[Usage] GLM quota API available');
  cache.glm.available = true;
  notifyQuotaChange();
}

function recordGlmQuotaFailure(statusCode, headers = {}, now = Date.now()) {
  if (!GLM_ERROR_STATUSES.has(statusCode)) return;
  const previous = cache.glm.error;
  const hadSnapshot = cache.glm.data !== null;
  cache.glm.error = previous?.status === statusCode ? previous : { status: statusCode, at: now };
  if (statusCode === 401 || statusCode === 403 || statusCode === 'invalid-credential') {
    if (previous?.status !== statusCode) {
      console.log(statusCode === 'invalid-credential'
        ? '[Usage] GLM quota skipped: malformed credential'
        : `[Usage] GLM quota API rejected credentials (${statusCode})`);
    }
    cache.glm.available = false;
    cache.glm.data = null;
  } else if (statusCode === 429) {
    cache.glm.nextAttemptAt = Math.max(cache.glm.nextAttemptAt, now + quotaRetryDelayMs(headers?.['retry-after'], now));
  }
  if (cache.glm.error !== previous || (hadSnapshot && cache.glm.data === null)) notifyQuotaChange();
}

function tryFetchGlmQuota(now = Date.now()) {
  if (cache.glm.nextAttemptAt === Infinity) return;
  const apiKey = readGlmApiKey(now);
  const fingerprint = secretFingerprint(apiKey);
  if (fingerprint !== cache.glm.fingerprint) {
    // Credential rotation or removal invalidates prior cached state.
    const hadState = cache.glm.available || cache.glm.data !== null || cache.glm.error !== null;
    cache.glm.fingerprint = fingerprint;
    cache.glm.data = null;
    cache.glm.available = false;
    cache.glm.lastSuccessTs = 0;
    cache.glm.error = null;
    cache.glm.nextAttemptAt = 0;
    if (hadState) notifyQuotaChange();
  }
  if (!apiKey) return;
  if (now < cache.glm.nextAttemptAt) return;

  if (!isValidHeaderCredential(apiKey)) {
    cache.glm.nextAttemptAt = now + QUOTA_API_TTL;
    recordGlmQuotaFailure('invalid-credential', {}, now);
    return;
  }

  const url = resolveGlmQuotaUrl();
  if (!url) return;

  const requestFingerprint = fingerprint;
  cache.glm.nextAttemptAt = now + QUOTA_API_TTL;

  const options = {
    hostname: url.hostname,
    path: url.pathname,
    method: 'GET',
    headers: {
      // Z.AI's official usage monitor script and glm-acp-agent send the raw API key
      // in Authorization (no Bearer prefix) across api.z.ai and bigmodel.cn.
      Authorization: apiKey,
      Accept: 'application/json',
    },
    timeout: QUOTA_REQUEST_TIMEOUT_MS,
  };

  const requester = quotaHooks.glmRequest || https.request;
  try {
    const req = requester(options, (res) => {
      consumeQuotaResponse(res, data => {
        if (cache.glm.fingerprint !== requestFingerprint) return;
        recordGlmQuotaSuccess(data, Date.now());
      }, {
        onFailure: (statusCode, headers) => {
          if (cache.glm.fingerprint !== requestFingerprint) return;
          recordGlmQuotaFailure(statusCode, headers, Date.now());
        },
      });
    });

    req.on('error', () => { /* ignore network errors; never log key */ });
    req.on('timeout', () => { req.destroy(); });
    req.end();
  } catch {
    recordGlmQuotaFailure('invalid-credential', {}, now);
  }
}

function readGlmQuota(now = Date.now()) {
  tryFetchGlmQuota(now);

  const fresh = cache.glm.available
    && cache.glm.data !== null
    && (now - cache.glm.lastSuccessTs) <= QUOTA_MAX_STALE_MS;

  if (!fresh && !cache.glm.error) return null;

  if (!fresh) {
    return {
      plan: null,
      weekly: null,
      fiveHour: null,
      observedAt: null,
      error: cache.glm.error,
    };
  }

  return {
    plan: cache.glm.data.plan,
    weekly: dropExpiredIsoWindow(cache.glm.data.weekly, now),
    fiveHour: dropExpiredIsoWindow(cache.glm.data.fiveHour, now),
    observedAt: cache.glm.data.observedAt,
    error: cache.glm.error,
  };
}

// ─── Antigravity Quota (T3 Cache Primary + Optional OAuth Fallback) ──

const ANTIGRAVITY_WINDOW_SPECS = Object.freeze({
  'gemini-weekly': { field: 'geminiWeekly', windowMinutes: 10080, label: 'Gemini · Weekly' },
  'gemini-5h': { field: 'geminiFiveHour', windowMinutes: 300, label: 'Gemini · 5-hour' },
  '3p-weekly': { field: 'sharedWeekly', windowMinutes: 10080, label: 'Claude & GPT (shared) · Weekly' },
  '3p-5h': { field: 'sharedFiveHour', windowMinutes: 300, label: 'Claude & GPT (shared) · 5-hour' },
});

function resolveAntigravityCachePath() {
  if (typeof quotaHooks.antigravityCachePath === 'string' && quotaHooks.antigravityCachePath) {
    return quotaHooks.antigravityCachePath;
  }
  return path.join(t3RootDir(), 'caches', 'antigravity.json');
}

function normalizeAntigravityWindow(raw, defaults, now = null) {
  if (!raw || typeof raw !== 'object') return null;
  let usedPercent = clampPercent(raw.usedPercent);
  if (usedPercent === null) {
    const usedFraction = nonNegativeFinite(raw.usedFraction);
    if (usedFraction !== null) usedPercent = clampPercent(usedFraction * 100);
  }
  if (usedPercent === null) {
    const remainingFraction = nonNegativeFinite(raw.remainingFraction);
    if (remainingFraction !== null) usedPercent = clampPercent((1 - remainingFraction) * 100);
  }
  if (usedPercent === null) return null;

  const rawReset = raw.resetsAt ?? raw.resetTime ?? raw.resetAt ?? null;
  const resetMs = parseIsoOrEpochMs(rawReset);
  if (now !== null && resetMs !== null && resetMs <= now) return null;

  const duration = nonNegativeFinite(raw.windowDurationMins ?? raw.windowMinutes);
  const windowMinutes = duration !== null && duration > 0 ? Math.round(duration) : defaults.windowMinutes;
  const label = typeof raw.label === 'string' && raw.label.trim()
    ? raw.label.trim().slice(0, 128)
    : defaults.label;

  return {
    usedPercent,
    resetsAt: resetMs !== null ? new Date(resetMs).toISOString() : null,
    windowMinutes,
    label,
  };
}

function parseAntigravityT3CacheRaw(json) {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return null;
  const limits = json.usageLimits;
  if (!limits || typeof limits !== 'object' || !Array.isArray(limits.windows)) return null;

  const observedMs = parseIsoOrEpochMs(limits.checkedAt) ?? parseIsoOrEpochMs(json.checkedAt);
  const observedAt = observedMs !== null ? new Date(observedMs).toISOString() : null;

  const result = {
    geminiWeekly: null,
    geminiFiveHour: null,
    sharedWeekly: null,
    sharedFiveHour: null,
    observedAt,
  };
  let matchedAny = false;
  for (const win of limits.windows) {
    if (!win || typeof win !== 'object') continue;
    const spec = ANTIGRAVITY_WINDOW_SPECS[win.id];
    if (!spec) continue;
    matchedAny = true;
    const normalized = normalizeAntigravityWindow(win, spec, null);
    if (normalized) result[spec.field] = normalized;
  }
  if (!matchedAny) return null;
  return result;
}

function projectAntigravityT3Cache(raw, now = Date.now()) {
  if (!raw) return null;
  const observedMs = parseIsoOrEpochMs(raw.observedAt);
  const isStaleAge = observedMs !== null && (now - observedMs) > ANTIGRAVITY_CACHE_MAX_STALE_MS;

  const geminiWeekly = dropExpiredIsoWindow(raw.geminiWeekly, now);
  const geminiFiveHour = dropExpiredIsoWindow(raw.geminiFiveHour, now);
  const sharedWeekly = dropExpiredIsoWindow(raw.sharedWeekly, now);
  const sharedFiveHour = dropExpiredIsoWindow(raw.sharedFiveHour, now);

  const liveWindows = [geminiWeekly, geminiFiveHour, sharedWeekly, sharedFiveHour].filter(Boolean);
  const hasFutureReset = liveWindows.some(w => w.resetsAt !== null && parseIsoOrEpochMs(w.resetsAt) > now);
  const allExpiredWhileStale = isStaleAge && !hasFutureReset;

  return {
    stale: isStaleAge,
    snapshot: {
      source: 't3-cache',
      geminiWeekly: allExpiredWhileStale ? null : geminiWeekly,
      geminiFiveHour: allExpiredWhileStale ? null : geminiFiveHour,
      sharedWeekly: allExpiredWhileStale ? null : sharedWeekly,
      sharedFiveHour: allExpiredWhileStale ? null : sharedFiveHour,
      observedAt: raw.observedAt,
      error: null,
    },
  };
}

function parseAntigravityT3Cache(json, now = Date.now()) {
  const raw = parseAntigravityT3CacheRaw(json);
  const projected = projectAntigravityT3Cache(raw, now);
  return projected ? projected.snapshot : null;
}

function pollAntigravityCacheFile(now = Date.now(), { force = false, notifyOnInitial = false } = {}) {
  const entry = cache.antigravityFile;
  if (!force && entry.lastPollAt > 0 && (now - entry.lastPollAt) < ANTIGRAVITY_CACHE_POLL_MS) {
    return entry.data;
  }
  const hadPriorPoll = entry.lastPollAt > 0;
  entry.lastPollAt = now;

  const cachePath = resolveAntigravityCachePath();
  let stat;
  try {
    stat = fs.statSync(cachePath);
  } catch {
    if (entry.exists || entry.data !== null) {
      entry.exists = false;
      entry.mtimeMs = -1;
      entry.size = -1;
      entry.data = null;
      entry.signature = '';
      if (hadPriorPoll) notifyQuotaChange();
    }
    return null;
  }

  if (!stat.isFile() || stat.size <= 0 || stat.size > ANTIGRAVITY_CACHE_MAX_BYTES) {
    return entry.data;
  }
  if (entry.exists && entry.mtimeMs === stat.mtimeMs && entry.size === stat.size) {
    return entry.data;
  }

  let parsed = null;
  try {
    const json = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    parsed = parseAntigravityT3CacheRaw(json);
  } catch {
    // Keep prior snapshot on transient mid-write read error, retry next poll.
    return entry.data;
  }

  const nextSignature = parsed ? JSON.stringify(parsed) : '';
  const changed = nextSignature !== entry.signature;
  entry.exists = true;
  entry.mtimeMs = stat.mtimeMs;
  entry.size = stat.size;
  entry.data = parsed;
  entry.signature = nextSignature;
  if (changed && (hadPriorPoll || (notifyOnInitial && parsed !== null))) {
    notifyQuotaChange();
  }
  return entry.data;
}

function defaultAntigravityTokenPaths() {
  const candidates = [
    path.join(activeHomeDir(), '.gemini', 'antigravity-cli', 'antigravity-oauth-token'),
  ];
  const providersDir = path.join(t3RootDir(), 'userdata', 'providers', 'antigravity');
  try {
    for (const dirent of fs.readdirSync(providersDir, { withFileTypes: true })) {
      if (!dirent.isDirectory()) continue;
      candidates.push(path.join(providersDir, dirent.name, 'antigravity-acp', 'antigravity-oauth-token'));
    }
  } catch { /* directory absent */ }
  return candidates;
}

function readAntigravityOauthToken(now = Date.now()) {
  const paths = typeof quotaHooks.antigravityTokenPaths === 'function'
    ? quotaHooks.antigravityTokenPaths()
    : (Array.isArray(quotaHooks.antigravityTokenPaths) ? quotaHooks.antigravityTokenPaths : defaultAntigravityTokenPaths());

  let best = null;
  for (const tokenPath of paths || []) {
    if (typeof tokenPath !== 'string' || !tokenPath) continue;
    try {
      if (!fs.existsSync(tokenPath)) continue;
      const parsed = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));
      const tok = parsed?.token && typeof parsed.token === 'object' ? parsed.token : parsed;
      const accessToken = typeof tok?.access_token === 'string' && tok.access_token.trim()
        ? tok.access_token.trim()
        : null;
      const expiryMs = parseIsoOrEpochMs(tok?.expiry);
      if (!accessToken || expiryMs === null || expiryMs <= now + ANTIGRAVITY_OAUTH_MIN_REMAINING_MS) {
        continue;
      }
      if (!best || expiryMs > best.expiryMs) {
        best = { accessToken, expiryMs };
      }
    } catch { /* ignore unreadable/malformed token file */ }
  }
  return best;
}

function resolveAntigravityOauthUrl(rawUrl) {
  const candidate = rawUrl === undefined
    ? (quotaHooks.antigravityEndpoint || DEFAULT_ANTIGRAVITY_OAUTH_URL)
    : rawUrl;
  if (typeof candidate !== 'string' || !candidate.trim()) return null;
  let parsed;
  try {
    parsed = new URL(candidate.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:'
    || parsed.username
    || parsed.password
    || parsed.port
    || !ANTIGRAVITY_ALLOWED_HOSTS.has(parsed.hostname)) {
    return null;
  }
  return new URL('/v1internal:retrieveUserQuotaSummary', parsed.origin);
}

function classifyAntigravityBucket(entry) {
  const id = String(entry?.id || entry?.bucketId || entry?.modelId || entry?.model || entry?.label || '').toLowerCase();
  if (ANTIGRAVITY_WINDOW_SPECS[id]) return ANTIGRAVITY_WINDOW_SPECS[id];

  const is3p = /\b3p\b|claude|gpt|shared|third[_ -]?party/.test(id);
  const isGemini = !is3p && /gemini/.test(id);
  if (!is3p && !isGemini) return null;

  const duration = nonNegativeFinite(entry?.windowDurationMins ?? entry?.windowMinutes);
  const kind = String(entry?.kind || entry?.windowType || '').toLowerCase();
  const isWeekly = (duration !== null && duration >= 10080)
    || /weekly|week|7d|168h/.test(`${id} ${kind}`);
  const isFiveHour = (duration !== null && duration > 0 && duration <= 360)
    || /5h|5-hour|session|300m/.test(`${id} ${kind}`);

  if (isGemini && isWeekly) return ANTIGRAVITY_WINDOW_SPECS['gemini-weekly'];
  if (isGemini && isFiveHour) return ANTIGRAVITY_WINDOW_SPECS['gemini-5h'];
  if (is3p && isWeekly) return ANTIGRAVITY_WINDOW_SPECS['3p-weekly'];
  if (is3p && isFiveHour) return ANTIGRAVITY_WINDOW_SPECS['3p-5h'];
  return null;
}

function parseAntigravityOauthPayload(payload, now = Date.now()) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const result = {
    geminiWeekly: null,
    geminiFiveHour: null,
    sharedWeekly: null,
    sharedFiveHour: null,
    observedAt: new Date(now).toISOString(),
  };
  let matchedAny = false;

  const rows = [
    ...(Array.isArray(payload.windows) ? payload.windows : []),
    ...(Array.isArray(payload.buckets) ? payload.buckets : []),
    ...(Array.isArray(payload.quotaBuckets) ? payload.quotaBuckets : []),
    ...(Array.isArray(payload.userQuotaBuckets) ? payload.userQuotaBuckets : []),
  ];
  for (const row of rows) {
    const spec = classifyAntigravityBucket(row);
    if (!spec) continue;
    matchedAny = true;
    const normalized = normalizeAntigravityWindow(row, spec, now);
    if (normalized) {
      const existing = result[spec.field];
      if (!existing || normalized.usedPercent > existing.usedPercent) {
        result[spec.field] = normalized;
      }
    }
  }

  for (const [id, spec] of Object.entries(ANTIGRAVITY_WINDOW_SPECS)) {
    const direct = payload[spec.field] ?? payload[id];
    if (direct && typeof direct === 'object') {
      matchedAny = true;
      const normalized = normalizeAntigravityWindow(direct, spec, now);
      if (normalized) result[spec.field] = normalized;
    }
  }

  if (!matchedAny) return null;
  return result;
}

function recordAntigravityOauthSuccess(payload, now = Date.now()) {
  const parsed = parseAntigravityOauthPayload(payload, now);
  if (!parsed) return;
  cache.antigravityOauth.data = parsed;
  cache.antigravityOauth.lastSuccessTs = now;
  cache.antigravityOauth.error = null;
  if (!cache.antigravityOauth.available) console.log('[Usage] Antigravity OAuth quota fallback available');
  cache.antigravityOauth.available = true;
  notifyQuotaChange();
}

function recordAntigravityOauthFailure(statusCode, headers = {}, now = Date.now()) {
  if (!ANTIGRAVITY_ERROR_STATUSES.has(statusCode)) return;
  const previous = cache.antigravityOauth.error;
  const hadSnapshot = cache.antigravityOauth.data !== null;
  cache.antigravityOauth.error = previous?.status === statusCode ? previous : { status: statusCode, at: now };
  if (statusCode === 401 || statusCode === 403 || statusCode === 'invalid-credential') {
    if (previous?.status !== statusCode) {
      console.log(statusCode === 'invalid-credential'
        ? '[Usage] Antigravity OAuth quota skipped: malformed credential'
        : `[Usage] Antigravity OAuth quota rejected credentials (${statusCode})`);
    }
    cache.antigravityOauth.available = false;
    cache.antigravityOauth.data = null;
  } else if (statusCode === 429) {
    cache.antigravityOauth.nextAttemptAt = Math.max(
      cache.antigravityOauth.nextAttemptAt,
      now + quotaRetryDelayMs(headers?.['retry-after'], now),
    );
  }
  if (cache.antigravityOauth.error !== previous || (hadSnapshot && cache.antigravityOauth.data === null)) {
    notifyQuotaChange();
  }
}

function antigravityFingerprintMatches(requestFingerprint, requestNow) {
  if (cache.antigravityOauth.fingerprint !== requestFingerprint) return false;
  const checkNow = Math.abs(Date.now() - requestNow) < 60_000 ? Date.now() : requestNow;
  const current = readAntigravityOauthToken(checkNow);
  const currentFp = current ? secretFingerprint(current.accessToken) : null;
  return currentFp === requestFingerprint;
}

function tryFetchAntigravityOauth(now = Date.now()) {
  if (cache.antigravityOauth.nextAttemptAt === Infinity) return;
  const token = readAntigravityOauthToken(now);
  const fingerprint = token ? secretFingerprint(token.accessToken) : null;
  if (fingerprint !== cache.antigravityOauth.fingerprint) {
    // Credential rotation, expiry, or removal immediately clears cached OAuth state and backoff.
    const hadState = cache.antigravityOauth.available
      || cache.antigravityOauth.data !== null
      || cache.antigravityOauth.error !== null;
    cache.antigravityOauth.fingerprint = fingerprint;
    cache.antigravityOauth.data = null;
    cache.antigravityOauth.available = false;
    cache.antigravityOauth.lastSuccessTs = 0;
    cache.antigravityOauth.error = null;
    cache.antigravityOauth.nextAttemptAt = 0;
    if (hadState) notifyQuotaChange();
  }
  if (!token) return;
  if (now < cache.antigravityOauth.nextAttemptAt) return;

  if (!isValidHeaderCredential(token.accessToken)) {
    cache.antigravityOauth.nextAttemptAt = now + QUOTA_API_TTL;
    recordAntigravityOauthFailure('invalid-credential', {}, now);
    return;
  }

  const url = resolveAntigravityOauthUrl();
  if (!url) return;

  const requestFingerprint = fingerprint;
  cache.antigravityOauth.nextAttemptAt = now + QUOTA_API_TTL;
  const body = '{}';
  const options = {
    hostname: url.hostname,
    path: url.pathname,
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token.accessToken}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'Content-Length': Buffer.byteLength(body),
    },
    timeout: QUOTA_REQUEST_TIMEOUT_MS,
  };

  const requester = quotaHooks.antigravityRequest || https.request;
  try {
    const req = requester(options, (res) => {
      consumeQuotaResponse(res, data => {
        if (!antigravityFingerprintMatches(requestFingerprint, now)) return;
        recordAntigravityOauthSuccess(data, Date.now());
      }, {
        onFailure: (statusCode, headers) => {
          if (!antigravityFingerprintMatches(requestFingerprint, now)) return;
          recordAntigravityOauthFailure(statusCode, headers, Date.now());
        },
      });
    });

    req.on('error', () => { /* ignore network errors; never log token */ });
    req.on('timeout', () => { req.destroy(); });
    req.end(body);
  } catch {
    recordAntigravityOauthFailure('invalid-credential', {}, now);
  }
}

function readAntigravityQuota(now = Date.now()) {
  const rawFile = pollAntigravityCacheFile(now);
  const projected = projectAntigravityT3Cache(rawFile, now);

  // Primary: zero-network fresh T3 cache wins with zero network requests.
  if (projected && !projected.stale) {
    return projected.snapshot;
  }

  // Fallback: only when T3 cache is absent or stale, try standalone OAuth
  // with a strictly unexpired token (never attempts OAuth refresh).
  tryFetchAntigravityOauth(now);

  const oauthFresh = cache.antigravityOauth.available
    && cache.antigravityOauth.data !== null
    && (now - cache.antigravityOauth.lastSuccessTs) <= QUOTA_MAX_STALE_MS;

  if (oauthFresh) {
    return {
      source: 'oauth-api',
      geminiWeekly: dropExpiredIsoWindow(cache.antigravityOauth.data.geminiWeekly, now),
      geminiFiveHour: dropExpiredIsoWindow(cache.antigravityOauth.data.geminiFiveHour, now),
      sharedWeekly: dropExpiredIsoWindow(cache.antigravityOauth.data.sharedWeekly, now),
      sharedFiveHour: dropExpiredIsoWindow(cache.antigravityOauth.data.sharedFiveHour, now),
      observedAt: cache.antigravityOauth.data.observedAt,
      error: cache.antigravityOauth.error,
    };
  }

  if (cache.antigravityOauth.error) {
    return {
      source: 'oauth-api',
      geminiWeekly: null,
      geminiFiveHour: null,
      sharedWeekly: null,
      sharedFiveHour: null,
      observedAt: null,
      error: cache.antigravityOauth.error,
    };
  }

  // Stale T3 cache with no active OAuth fallback still reports observedAt with
  // any expired windows nulled out (never fake 0%).
  if (projected) return projected.snapshot;
  return null;
}

function startAntigravityCachePoller() {
  stopAntigravityCachePoller();
  antigravityPollTimer = setInterval(() => {
    pollAntigravityCacheFile(Date.now(), { force: true, notifyOnInitial: true });
  }, ANTIGRAVITY_CACHE_POLL_MS);
  if (typeof antigravityPollTimer.unref === 'function') antigravityPollTimer.unref();
}

function stopAntigravityCachePoller() {
  if (antigravityPollTimer) {
    clearInterval(antigravityPollTimer);
    antigravityPollTimer = null;
  }
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
    codex: readCodexQuota(now),
    glm: readGlmQuota(now),
    antigravity: readAntigravityQuota(now),
  };
}

function init({
  onChange = null,
  codexRateLimits = null,
  glmApiKey = null,
  glmEndpoint = null,
  glmRequest = null,
  glmCredentialsPath = null,
  antigravityCachePath = null,
  antigravityTokenPaths = null,
  antigravityEndpoint = null,
  antigravityRequest = null,
  env = null,
  homeDir = null,
  pollAntigravity = true,
} = {}) {
  quotaHooks.onChange = typeof onChange === 'function' ? onChange : null;
  quotaHooks.codexRateLimits = typeof codexRateLimits === 'function' ? codexRateLimits : null;
  quotaHooks.glmApiKey = glmApiKey;
  quotaHooks.glmEndpoint = glmEndpoint;
  quotaHooks.glmRequest = typeof glmRequest === 'function' ? glmRequest : null;
  quotaHooks.glmCredentialsPath = glmCredentialsPath;
  quotaHooks.antigravityCachePath = antigravityCachePath;
  quotaHooks.antigravityTokenPaths = antigravityTokenPaths;
  quotaHooks.antigravityEndpoint = antigravityEndpoint;
  quotaHooks.antigravityRequest = typeof antigravityRequest === 'function' ? antigravityRequest : null;
  quotaHooks.env = env;
  quotaHooks.homeDir = homeDir;
  // Initial quota attempts
  tryFetchQuota();
  tryFetchGlmQuota();
  pollAntigravityCacheFile(Date.now(), { force: true });
  if (pollAntigravity) startAntigravityCachePoller();
}

function shutdown() {
  stopAntigravityCachePoller();
}

module.exports = {
  fetchUsage,
  init,
  shutdown,
  _test: {
    codexQuotaFromObservation,
    consumeQuotaResponse,
    quotaRetryDelayMs,
    recordQuotaFailure,
    recordQuotaSuccess,
    resetsAtMs,
    resolveGlmQuotaUrl,
    parseGlmQuotaPayload,
    recordGlmQuotaSuccess,
    recordGlmQuotaFailure,
    tryFetchGlmQuota,
    readGlmQuota,
    readGlmApiKey,
    parseAntigravityT3Cache,
    parseAntigravityOauthPayload,
    pollAntigravityCacheFile,
    readAntigravityOauthToken,
    resolveAntigravityOauthUrl,
    recordAntigravityOauthSuccess,
    recordAntigravityOauthFailure,
    tryFetchAntigravityOauth,
    readAntigravityQuota,
    resetQuotaCache({ nextAttemptAt = Infinity } = {}) {
      stopAntigravityCachePoller();
      cache.quota = { data: null, nextAttemptAt, available: false, lastSuccessTs: 0, error: null };
      cache.glmCreds = { key: null, fingerprint: null, ts: 0 };
      cache.glm = { data: null, nextAttemptAt, available: false, lastSuccessTs: 0, error: null, fingerprint: null };
      cache.antigravityFile = { lastPollAt: 0, mtimeMs: -1, size: -1, exists: false, data: null, signature: '' };
      cache.antigravityOauth = { data: null, nextAttemptAt, available: false, lastSuccessTs: 0, error: null, fingerprint: null };
      quotaHooks.onChange = null;
      quotaHooks.codexRateLimits = null;
      quotaHooks.glmApiKey = null;
      quotaHooks.glmEndpoint = null;
      quotaHooks.glmRequest = null;
      quotaHooks.glmCredentialsPath = null;
      quotaHooks.antigravityCachePath = null;
      quotaHooks.antigravityTokenPaths = null;
      quotaHooks.antigravityEndpoint = null;
      quotaHooks.antigravityRequest = null;
      quotaHooks.env = null;
      quotaHooks.homeDir = null;
    },
    setCodexRateLimitsSource(source) {
      quotaHooks.codexRateLimits = source;
    },
    setQuotaChangeListener(listener) {
      quotaHooks.onChange = listener;
    },
    setHooks(overrides = {}) {
      Object.assign(quotaHooks, overrides);
    },
    QUOTA_API_TTL,
    QUOTA_MAX_STALE_MS,
    QUOTA_RESPONSE_MAX_BYTES,
    ANTIGRAVITY_CACHE_POLL_MS,
    ANTIGRAVITY_CACHE_MAX_STALE_MS,
    GLM_ALLOWED_HOSTS,
    ANTIGRAVITY_ALLOWED_HOSTS,
  },
};
