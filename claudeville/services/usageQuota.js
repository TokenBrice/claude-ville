/**
 * usageQuota.js - Claude 사용량 데이터 수집 & 캐싱 모듈
 *
 * 데이터 소스:
 *   A) ~/.claude/.credentials.json → subscriptionType, rateLimitTier
 *   B) ~/.claude/stats-cache.json → 일별 활동 (messageCount, sessionCount, toolCallCount)
 *   C) claude auth status (서버 시작 시 1회) → email
 *   D) api.anthropic.com/api/oauth/usage → 5h/7d quota (현재 불가, 주기적 재시도)
 */

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const https = require('https');

const CLAUDE_HOME = path.join(require('os').homedir(), '.claude');
const CREDENTIALS_PATH = path.join(CLAUDE_HOME, '.credentials.json');
const STATS_CACHE_PATH = path.join(CLAUDE_HOME, 'stats-cache.json');

// 캐시 TTL
const CREDENTIALS_TTL = 30_000;   // 30초
const STATS_TTL = 30_000;         // 30초
const QUOTA_API_TTL = 5 * 60_000; // 5분

// 캐시 저장소
const cache = {
  credentials: { data: null, ts: 0 },
  stats: { data: null, ts: 0 },
  email: null,
  quota: { data: null, ts: 0, available: false },
};

// ─── 자격 증명 (구독 정보만 추출) ────────────────────────────

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

// ─── 이메일 (서버 시작 시 1회) ───────────────────────────────

function fetchEmail() {
  return new Promise((resolve) => {
    execFile('claude', ['auth', 'status'], { timeout: 10_000 }, (err, stdout) => {
      if (err) { resolve(null); return; }
      // "Logged in as user@example.com" 패턴 추출
      const match = stdout.match(/(?:as|email[:\s]+)\s*([^\s]+@[^\s]+)/i);
      cache.email = match ? match[1] : null;
      resolve(cache.email);
    });
  });
}

// ─── stats-cache.json 파싱 ───────────────────────────────────

function readStats() {
  const now = Date.now();
  if (cache.stats.data && now - cache.stats.ts < STATS_TTL) {
    return cache.stats.data;
  }
  try {
    const raw = fs.readFileSync(STATS_CACHE_PATH, 'utf-8');
    const json = JSON.parse(raw);
    const activity = json.dailyActivity || [];

    const today = new Date().toISOString().slice(0, 10);
    const todayEntry = activity.find(d => d.date === today);

    // 이번 주 (월~일)
    const nowDate = new Date();
    const dayOfWeek = nowDate.getDay();
    const mondayOffset = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
    const monday = new Date(nowDate);
    monday.setDate(monday.getDate() - mondayOffset);
    const mondayStr = monday.toISOString().slice(0, 10);

    const weekEntries = activity.filter(d => d.date >= mondayStr && d.date <= today);
    const weekMessages = weekEntries.reduce((s, d) => s + (d.messageCount || 0), 0);
    const weekSessions = weekEntries.reduce((s, d) => s + (d.sessionCount || 0), 0);
    const weekTools = weekEntries.reduce((s, d) => s + (d.toolCallCount || 0), 0);

    const result = {
      today: {
        messages: todayEntry?.messageCount || 0,
        sessions: todayEntry?.sessionCount || 0,
        tools: todayEntry?.toolCallCount || 0,
      },
      thisWeek: {
        messages: weekMessages,
        sessions: weekSessions,
        tools: weekTools,
      },
      totalSessions: json.totalSessions || 0,
      totalMessages: json.totalMessages || 0,
    };

    cache.stats = { data: result, ts: now };
    return result;
  } catch {
    return {
      today: { messages: 0, sessions: 0, tools: 0 },
      thisWeek: { messages: 0, sessions: 0, tools: 0 },
      totalSessions: 0,
      totalMessages: 0,
    };
  }
}

// ─── Quota API (현재 불가, 나중에 활성화) ────────────────────

function tryFetchQuota() {
  const now = Date.now();
  if (now - cache.quota.ts < QUOTA_API_TTL) return;
  cache.quota.ts = now;

  const creds = readCredentials();
  if (!creds.subscriptionType) return;

  // credentials에서 accessToken 읽기
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
          console.log('[Usage] Quota API 활성화!');
        } catch { /* 파싱 실패 */ }
      }
      // 실패 시 조용히 무시 (다음 주기에 재시도)
    });
  });

  req.on('error', () => { /* 네트워크 에러 무시 */ });
  req.on('timeout', () => { req.destroy(); });
  req.end();
}

// ─── 공개 API ────────────────────────────────────────────────

function fetchUsage() {
  const credentials = readCredentials();
  const stats = readStats();

  // 비동기적으로 quota API 시도 (결과는 캐시에 저장)
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
  // 서버 시작 시 이메일 가져오기 (비동기)
  fetchEmail().then(email => {
    if (email) console.log(`[Usage] 계정: ${email}`);
    else console.log('[Usage] 이메일 조회 실패 (claude auth status)');
  });

  // 최초 quota API 시도
  tryFetchQuota();
}

module.exports = { fetchUsage, init };
