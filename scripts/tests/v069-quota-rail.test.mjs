import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { makeTempDir } from './support/tmp.mjs';
import {
    DashboardRenderer,
    antigravityQuotaFacts,
    claudeQuotaFacts,
    codexQuotaFacts,
    glmQuotaFacts,
    quotaCardsSignature,
} from '../../claudeville/src/presentation/dashboard-mode/DashboardRenderer.js';
import { eventBus } from '../../claudeville/src/domain/events/DomainEvent.js';

const require = createRequire(import.meta.url);
// Isolate HOME at load time so usageQuota never touches the operator's real home dir.
const isolatedHome = makeTempDir('claudeville-v069-quota-');
const originalHome = process.env.HOME;
process.env.HOME = isolatedHome;
const usageQuota = require('../../claudeville/services/usageQuota.js');
if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome;
test.after(() => {
    usageQuota._test.resetQuotaCache();
    fs.rmSync(isolatedHome, { recursive: true, force: true });
});

const {
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
    readAntigravityQuota,
    resetQuotaCache,
    setQuotaChangeListener,
    setHooks,
    QUOTA_API_TTL,
    QUOTA_MAX_STALE_MS,
    ANTIGRAVITY_CACHE_POLL_MS,
    ANTIGRAVITY_CACHE_MAX_STALE_MS,
} = usageQuota._test;

const NOW = Date.UTC(2026, 10, 26, 20, 0, 0);
const FUTURE_WEEK = NOW + 5 * 24 * 60 * 60_000;
const FUTURE_5H = NOW + 3 * 60 * 60_000;
const PAST_RESET = NOW - 60_000;

class FakeHttpResponse extends EventEmitter {
    constructor(statusCode, headers = {}) {
        super();
        this.statusCode = statusCode;
        this.headers = headers;
        this.destroyed = false;
        this.resumed = false;
    }
    destroy() { this.destroyed = true; }
    resume() { this.resumed = true; }
}

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

function makeFakeRequester(handler) {
    const calls = [];
    const requester = (options, callback) => {
        calls.push(options);
        const req = new FakeHttpRequest(() => handler(options, callback, req));
        return req;
    };
    return { requester, calls };
}

// ─── 1. GLM / z.AI Backend Tests ────────────────────────────────────────────

test('GLM quota allowlist accepts official Z.AI/BigModel HTTPS origins and rejects all others', () => {
    assert.equal(resolveGlmQuotaUrl().href, 'https://api.z.ai/api/monitor/usage/quota/limit');
    assert.equal(resolveGlmQuotaUrl('https://api.z.ai/api/coding/paas/v4').href, 'https://api.z.ai/api/monitor/usage/quota/limit');
    assert.equal(resolveGlmQuotaUrl('https://open.bigmodel.cn').href, 'https://open.bigmodel.cn/api/monitor/usage/quota/limit');
    assert.equal(resolveGlmQuotaUrl('https://dev.bigmodel.cn/api/monitor/usage/quota/limit').href, 'https://dev.bigmodel.cn/api/monitor/usage/quota/limit');

    for (const bad of [
        'http://api.z.ai/api/monitor/usage/quota/limit',
        'https://evil.example.com/api/monitor/usage/quota/limit',
        'https://api.z.ai.evil.com/api/monitor/usage/quota/limit',
        'https://api.z.ai:8443/api/monitor/usage/quota/limit',
        'https://user:pass@api.z.ai/api/monitor/usage/quota/limit',
        'not-a-url',
        '',
    ]) {
        assert.equal(resolveGlmQuotaUrl(bad), null, `should reject ${bad}`);
    }
});

test('GLM quota parser handles CREDIT_LIMIT weekly + 5h, TOKENS_LIMIT fallback, clamping, and expired resets', () => {
    const creditPayload = {
        code: 200,
        success: true,
        data: {
            level: 'max',
            limits: [
                { type: 'TOKENS_LIMIT', unit: 6, number: 1, currentValue: 90, usage: 100, remaining: 10, nextResetTime: FUTURE_WEEK },
                { type: 'CREDIT_LIMIT', unit: 6, number: 1, currentValue: 4200, usage: 10000, remaining: 5800, nextResetTime: FUTURE_WEEK },
                { type: 'CREDIT_LIMIT', unit: 3, number: 5, currentValue: 250, usage: 2000, remaining: 1750, nextResetTime: FUTURE_5H },
            ],
        },
    };
    const parsed = parseGlmQuotaPayload(creditPayload, NOW);
    assert.equal(parsed.status, 'ok');
    assert.equal(parsed.snapshot.plan, 'max');
    assert.deepEqual(parsed.snapshot.weekly, {
        usedPercent: 42,
        used: 4200,
        limit: 10000,
        remaining: 5800,
        resetsAt: new Date(FUTURE_WEEK).toISOString(),
    });
    assert.deepEqual(parsed.snapshot.fiveHour, {
        usedPercent: 12.5,
        used: 250,
        limit: 2000,
        remaining: 1750,
        resetsAt: new Date(FUTURE_5H).toISOString(),
    });

    // TOKENS_LIMIT fallback + unit 4 number 7 weekly alias + over-100% clamp.
    const tokensOnly = parseGlmQuotaPayload({
        data: {
            level: 'pro',
            limits: [
                { type: 'TOKENS_LIMIT', unit: 4, number: 7, currentValue: 130, usage: 100, remaining: 0, nextResetTime: FUTURE_WEEK },
                { type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 17, nextResetTime: FUTURE_5H },
            ],
        },
    }, NOW);
    assert.equal(tokensOnly.status, 'ok');
    assert.equal(tokensOnly.snapshot.plan, 'pro');
    assert.equal(tokensOnly.snapshot.weekly.usedPercent, 100, 'clamped to 100');
    assert.equal(tokensOnly.snapshot.fiveHour.usedPercent, 17);

    // Expired nextResetTime drops the window to null (unknown, never 0%).
    const expired = parseGlmQuotaPayload({
        data: {
            level: 'max',
            limits: [
                { type: 'CREDIT_LIMIT', unit: 6, number: 1, currentValue: 8000, usage: 10000, nextResetTime: PAST_RESET },
                { type: 'CREDIT_LIMIT', unit: 3, number: 5, currentValue: 500, usage: 2000, nextResetTime: FUTURE_5H },
            ],
        },
    }, NOW);
    assert.equal(expired.status, 'ok');
    assert.equal(expired.snapshot.weekly, null, 'expired weekly window drops to null');
    assert.equal(expired.snapshot.fiveHour.usedPercent, 25);
});

test('GLM quota makes zero network calls when unconfigured and respects env + credentials.json lookup', () => {
    const dir = makeTempDir('claudeville-glm-creds-');
    try {
        resetQuotaCache({ nextAttemptAt: 0 });
        const { requester, calls } = makeFakeRequester(() => {});
        setHooks({
            env: {},
            homeDir: dir,
            glmRequest: requester,
        });
        assert.equal(readGlmQuota(NOW), null);
        assert.equal(calls.length, 0, 'zero network calls when no GLM key configured');

        // Fallback file (~/.config/glm-acp-agent/credentials.json) with apiKey field.
        const credDir = path.join(dir, '.config', 'glm-acp-agent');
        fs.mkdirSync(credDir, { recursive: true });
        fs.writeFileSync(path.join(credDir, 'credentials.json'), JSON.stringify({ apiKey: 'test-file-placeholder' }));
        resetQuotaCache({ nextAttemptAt: 0 });
        setHooks({ env: {}, homeDir: dir });
        assert.equal(readGlmApiKey(NOW), 'test-file-placeholder');

        // Env priority: GLM_MCP_API_KEY > ZAI_API_KEY > Z_AI_API_KEY > file.
        resetQuotaCache({ nextAttemptAt: 0 });
        setHooks({
            env: { Z_AI_API_KEY: 'test-z-ai', ZAI_API_KEY: 'test-zai', GLM_MCP_API_KEY: 'test-mcp' },
            homeDir: dir,
        });
        assert.equal(readGlmApiKey(NOW), 'test-mcp');

        // Rejects non-allowlisted endpoint override with zero requests.
        resetQuotaCache({ nextAttemptAt: 0 });
        const blocked = makeFakeRequester(() => {});
        setHooks({
            env: { ZAI_API_KEY: 'test-zai' },
            homeDir: dir,
            glmEndpoint: 'https://untrusted.example.com/api/monitor/usage/quota/limit',
            glmRequest: blocked.requester,
        });
        tryFetchGlmQuota(NOW);
        assert.equal(blocked.calls.length, 0, 'non-allowlisted endpoint never receives a request');
    } finally {
        resetQuotaCache();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('GLM quota enforces SV-7 401/403 immediate clear, 429 backoff + stale retention, and dynamic reset expiry', () => {
    resetQuotaCache({ nextAttemptAt: 0 });
    let changes = 0;
    setQuotaChangeListener(() => { changes++; });
    setHooks({ env: {}, glmApiKey: () => null });

    const payload = {
        data: {
            level: 'max',
            limits: [
                { type: 'CREDIT_LIMIT', unit: 6, number: 1, currentValue: 6400, usage: 10000, remaining: 3600, nextResetTime: NOW + 120_000 },
                { type: 'CREDIT_LIMIT', unit: 3, number: 5, currentValue: 400, usage: 2000, remaining: 1600, nextResetTime: FUTURE_5H },
            ],
        },
    };
    // Seed directly with nextAttemptAt = Infinity so readGlmQuota does not re-fetch.
    resetQuotaCache({ nextAttemptAt: Infinity });
    setHooks({ env: {} });
    setQuotaChangeListener(() => { changes++; });
    recordGlmQuotaSuccess(payload, NOW);
    assert.equal(changes, 1);

    const fresh = readGlmQuota(NOW + 1000);
    assert.equal(fresh.plan, 'max');
    assert.equal(fresh.weekly.usedPercent, 64);
    assert.equal(fresh.fiveHour.usedPercent, 20);
    assert.equal(fresh.error, null);

    // Once weekly nextResetTime passes dynamically, weekly becomes null (never 0%).
    const afterWeeklyReset = readGlmQuota(NOW + 120_001);
    assert.equal(afterWeeklyReset.weekly, null);
    assert.equal(afterWeeklyReset.fiveHour.usedPercent, 20);

    // 429 retains snapshot up to QUOTA_MAX_STALE_MS and records error.
    recordGlmQuotaFailure(429, { 'retry-after': '900' }, NOW + 60_000);
    assert.equal(changes, 2);
    const throttled = readGlmQuota(NOW + 60_000);
    assert.deepEqual(throttled.error, { status: 429, at: NOW + 60_000 });
    assert.equal(throttled.weekly.usedPercent, 64, 'stale snapshot kept within 30m');

    // Past 30 min staleness cutoff, snapshot clears while error remains visible.
    const aged = readGlmQuota(NOW + QUOTA_MAX_STALE_MS + 1);
    assert.equal(aged.weekly, null);
    assert.equal(aged.fiveHour, null);
    assert.deepEqual(aged.error, { status: 429, at: NOW + 60_000 });

    // 401 and 403 clear snapshot immediately.
    recordGlmQuotaSuccess(payload, NOW + 1000);
    recordGlmQuotaFailure(401, {}, NOW + 2000);
    const unauth = readGlmQuota(NOW + 2001);
    assert.equal(unauth.weekly, null);
    assert.equal(unauth.fiveHour, null);
    assert.deepEqual(unauth.error, { status: 401, at: NOW + 2000 });

    recordGlmQuotaSuccess(payload, NOW + 3000);
    recordGlmQuotaFailure(403, {}, NOW + 4000);
    const forbidden = readGlmQuota(NOW + 4001);
    assert.equal(forbidden.weekly, null);
    assert.deepEqual(forbidden.error, { status: 403, at: NOW + 4000 });

    // Verify 429 backoff prevents immediate re-request via live requester.
    resetQuotaCache({ nextAttemptAt: 0 });
    const { requester, calls } = makeFakeRequester((_opts, cb) => {
        const res = new FakeHttpResponse(429, { 'retry-after': '900' });
        cb(res);
    });
    setHooks({
        env: {},
        glmApiKey: () => 'test-key-never-logged',
        glmRequest: requester,
    });
    tryFetchGlmQuota(NOW);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].hostname, 'api.z.ai');
    assert.equal(calls[0].path, '/api/monitor/usage/quota/limit');
    // Second call within 900s Retry-After window must not fire.
    tryFetchGlmQuota(NOW + QUOTA_API_TTL + 1000);
    assert.equal(calls.length, 1, '429 Retry-After backoff suppresses retry');
});

// ─── 2. Antigravity Backend Tests ───────────────────────────────────────────

test('Antigravity T3 cache parses all 4 windows, drops expired windows to null, and handles stale caches', () => {
    const t3Json = {
        checkedAt: new Date(NOW - 5 * 60_000).toISOString(),
        usageLimits: {
            checkedAt: new Date(NOW - 5 * 60_000).toISOString(),
            windows: [
                { id: 'gemini-weekly', label: 'Gemini · Weekly', usedPercent: 23.4, resetsAt: new Date(FUTURE_WEEK).toISOString(), windowDurationMins: 10080 },
                { id: 'gemini-5h', label: 'Gemini · 5-hour', usedPercent: 30, resetsAt: new Date(FUTURE_5H).toISOString(), windowDurationMins: 300 },
                { id: '3p-weekly', label: 'Claude & GPT (shared) · Weekly', usedPercent: 14, windowDurationMins: 10080 },
                { id: '3p-5h', label: 'Claude & GPT (shared) · 5-hour', usedPercent: 0, windowDurationMins: 300 },
            ],
        },
    };
    const parsed = parseAntigravityT3Cache(t3Json, NOW);
    assert.equal(parsed.source, 't3-cache');
    assert.equal(parsed.error, null);
    assert.equal(parsed.observedAt, new Date(NOW - 5 * 60_000).toISOString());
    assert.deepEqual(parsed.geminiWeekly, {
        usedPercent: 23.4,
        resetsAt: new Date(FUTURE_WEEK).toISOString(),
        windowMinutes: 10080,
        label: 'Gemini · Weekly',
    });
    assert.equal(parsed.geminiFiveHour.usedPercent, 30);
    assert.equal(parsed.sharedWeekly.usedPercent, 14);
    assert.equal(parsed.sharedWeekly.resetsAt, null);
    assert.equal(parsed.sharedFiveHour.usedPercent, 0);

    // Expired gemini-5h drops to null (never 0%).
    const withExpired = structuredClone(t3Json);
    withExpired.usageLimits.windows[1].resetsAt = new Date(PAST_RESET).toISOString();
    const parsedExpired = parseAntigravityT3Cache(withExpired, NOW);
    assert.equal(parsedExpired.geminiFiveHour, null, 'expired window drops to null');
    assert.equal(parsedExpired.geminiWeekly.usedPercent, 23.4);

    // Stale cache (> 6h) where all timed windows expired nulls all windows (never fake 0%).
    const staleJson = {
        usageLimits: {
            checkedAt: new Date(NOW - ANTIGRAVITY_CACHE_MAX_STALE_MS - 60_000).toISOString(),
            windows: [
                { id: 'gemini-weekly', usedPercent: 80, resetsAt: new Date(PAST_RESET).toISOString(), windowDurationMins: 10080 },
                { id: '3p-weekly', usedPercent: 0, windowDurationMins: 10080 },
            ],
        },
    };
    const stale = parseAntigravityT3Cache(staleJson, NOW);
    assert.equal(stale.geminiWeekly, null);
    assert.equal(stale.sharedWeekly, null, 'stale cache with all resets expired treats every window as null');
});

test('Antigravity T3 cache stat-caches with 30s throttle, reloads on mtime change, and fires onChange', () => {
    const dir = makeTempDir('claudeville-ag-cache-');
    try {
        const cachePath = path.join(dir, 'antigravity.json');
        const writeCache = (pct, mtimeSec) => {
            fs.writeFileSync(cachePath, JSON.stringify({
                usageLimits: {
                    checkedAt: new Date(NOW).toISOString(),
                    windows: [
                        { id: 'gemini-weekly', usedPercent: pct, resetsAt: new Date(FUTURE_WEEK).toISOString(), windowDurationMins: 10080 },
                    ],
                },
            }));
            fs.utimesSync(cachePath, mtimeSec, mtimeSec);
        };

        writeCache(20, Math.floor(NOW / 1000));
        resetQuotaCache({ nextAttemptAt: 0 });
        let changes = 0;
        const { requester, calls } = makeFakeRequester(() => {});
        setQuotaChangeListener(() => { changes++; });
        setHooks({
            antigravityCachePath: cachePath,
            antigravityTokenPaths: [],
            antigravityRequest: requester,
        });

        const first = readAntigravityQuota(NOW);
        assert.equal(first.source, 't3-cache');
        assert.equal(first.geminiWeekly.usedPercent, 20);
        assert.equal(calls.length, 0, 'fresh T3 cache makes zero network requests');

        // Modify file within 30s throttle: still serves cached value.
        writeCache(55, Math.floor(NOW / 1000) + 10);
        const throttled = readAntigravityQuota(NOW + ANTIGRAVITY_CACHE_POLL_MS - 1);
        assert.equal(throttled.geminiWeekly.usedPercent, 20, 'poll throttled within 30s');
        assert.equal(changes, 0);

        // After 30s throttle passes, mtime change reloads file and triggers onChange.
        const reloaded = readAntigravityQuota(NOW + ANTIGRAVITY_CACHE_POLL_MS + 1);
        assert.equal(reloaded.geminiWeekly.usedPercent, 55, 'reloaded after mtime change');
        assert.equal(changes, 1, 'onChange fired on mtime refresh');
        assert.equal(calls.length, 0, 'still zero network requests');
    } finally {
        resetQuotaCache();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('Antigravity optional OAuth fallback skips expired tokens, enforces host allowlist, and parses valid responses', () => {
    const dir = makeTempDir('claudeville-ag-oauth-');
    try {
        assert.equal(resolveAntigravityOauthUrl().href, 'https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary');
        assert.equal(resolveAntigravityOauthUrl('https://cloudcode-pa.googleapis.com').href, 'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary');
        assert.equal(resolveAntigravityOauthUrl('http://daily-cloudcode-pa.googleapis.com'), null);
        assert.equal(resolveAntigravityOauthUrl('https://evil.example.com'), null);

        const missingCache = path.join(dir, 'absent-antigravity.json');
        const tokenPath = path.join(dir, 'antigravity-oauth-token');

        // Expired token (or within 60s of expiry): ZERO network requests, never attempts refresh.
        fs.writeFileSync(tokenPath, JSON.stringify({
            token: {
                access_token: 'expired-placeholder',
                refresh_token: 'never-used-refresh',
                expiry: new Date(NOW + 30_000).toISOString(),
            },
        }));
        resetQuotaCache({ nextAttemptAt: 0 });
        const skipped = makeFakeRequester(() => {});
        setHooks({
            antigravityCachePath: missingCache,
            antigravityTokenPaths: [tokenPath],
            antigravityRequest: skipped.requester,
        });
        assert.equal(readAntigravityOauthToken(NOW), null, 'token expiring within 60s is skipped');
        assert.equal(readAntigravityQuota(NOW), null);
        assert.equal(skipped.calls.length, 0, 'expired token makes zero network calls');

        // Strictly future token (> now + 60s): triggers allowlisted POST and normalizes buckets.
        fs.writeFileSync(tokenPath, JSON.stringify({
            token: {
                access_token: 'valid-placeholder',
                expiry: new Date(NOW + 10 * 60_000).toISOString(),
            },
        }));
        resetQuotaCache({ nextAttemptAt: 0 });
        const live = makeFakeRequester((_opts, cb) => {
            const res = new FakeHttpResponse(200);
            cb(res);
            res.emit('data', Buffer.from(JSON.stringify({
                buckets: [
                    { bucketId: 'gemini-weekly', remainingFraction: 0.65, resetTime: new Date(FUTURE_WEEK).toISOString(), windowDurationMins: 10080 },
                    { bucketId: '3p-weekly', remainingFraction: 0.85, resetTime: new Date(FUTURE_WEEK).toISOString(), windowDurationMins: 10080 },
                ],
            })));
            res.emit('end');
        });
        setHooks({
            antigravityCachePath: missingCache,
            antigravityTokenPaths: [tokenPath],
            antigravityRequest: live.requester,
        });
        // Trigger request; FakeHttpRequest responds synchronously on end().
        const origNow = Date.now;
        Date.now = () => NOW;
        let result;
        try {
            result = readAntigravityQuota(NOW);
        } finally {
            Date.now = origNow;
        }
        assert.equal(live.calls.length, 1);
        assert.equal(live.calls[0].method, 'POST');
        assert.equal(live.calls[0].hostname, 'daily-cloudcode-pa.googleapis.com');
        assert.equal(result.source, 'oauth-api');
        assert.equal(Math.round(result.geminiWeekly.usedPercent), 35);
        assert.equal(Math.round(result.sharedWeekly.usedPercent), 15);
        assert.equal(result.error, null);

        // SV-7 401 clears OAuth snapshot immediately.
        recordAntigravityOauthFailure(401, {}, NOW + 1000);
        const after401 = readAntigravityQuota(NOW + 1001);
        assert.equal(after401.geminiWeekly, null);
        assert.deepEqual(after401.error, { status: 401, at: NOW + 1000 });

        // Verify parseAntigravityOauthPayload drops expired windows.
        const parsedOauth = parseAntigravityOauthPayload({
            buckets: [
                { bucketId: 'gemini-weekly', remainingFraction: 0.2, resetTime: new Date(PAST_RESET).toISOString() },
            ],
        }, NOW);
        assert.equal(parsedOauth.geminiWeekly, null);
    } finally {
        resetQuotaCache();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

// ─── 3. DashboardRenderer 4-Provider Quota Rail Tests ───────────────────────

function createMiniDom() {
    class MiniFragment {
        constructor() { this.children = []; }
        append(...nodes) {
            for (const n of nodes) {
                if (n instanceof MiniFragment) this.children.push(...n.children);
                else if (n != null) this.children.push(n);
            }
        }
    }
    class MiniElement {
        constructor(tag = 'div') {
            this.tagName = tag.toUpperCase();
            this.id = '';
            this.className = '';
            this.dataset = {};
            this.style = {
                _props: new Map(),
                getPropertyValue(k) { return this._props.get(k) || ''; },
                setProperty(k, v) { this._props.set(k, v); },
                removeProperty(k) { this._props.delete(k); },
            };
            this.attributes = new Map();
            this.children = [];
            this.parentElement = null;
            this.hidden = false;
            this.title = '';
            this.textContent = '';
            this.isConnected = true;
            this.listeners = new Map();
            this.classList = {
                add: (...names) => {
                    const set = new Set(this.className.split(/\s+/).filter(Boolean));
                    for (const name of names) set.add(name);
                    this.className = [...set].join(' ');
                },
                remove: (...names) => {
                    const set = new Set(this.className.split(/\s+/).filter(Boolean));
                    for (const name of names) set.delete(name);
                    this.className = [...set].join(' ');
                },
                toggle: (name, force) => {
                    const set = new Set(this.className.split(/\s+/).filter(Boolean));
                    const on = force === undefined ? !set.has(name) : Boolean(force);
                    if (on) set.add(name); else set.delete(name);
                    this.className = [...set].join(' ');
                    return on;
                },
                contains: (name) => this.className.split(/\s+/).includes(name),
            };
        }
        setAttribute(name, value) { this.attributes.set(name, String(value)); }
        getAttribute(name) { return this.attributes.get(name) ?? null; }
        addEventListener(type, fn) { this.listeners.set(type, fn); }
        removeEventListener(type) { this.listeners.delete(type); }
        appendChild(child) {
            if (child instanceof MiniFragment) {
                for (const item of child.children) this.appendChild(item);
                return child;
            }
            if (child && typeof child === 'object') child.parentElement = this;
            this.children.push(child);
            return child;
        }
        append(...nodes) { for (const n of nodes) this.appendChild(n); }
        replaceChildren(...nodes) {
            for (const old of this.children) {
                if (old && typeof old === 'object') old.parentElement = null;
            }
            this.children = [];
            this.append(...nodes);
        }
        insertBefore(node, ref) {
            const idx = ref ? this.children.indexOf(ref) : -1;
            node.parentElement = this;
            if (idx === -1) this.children.push(node);
            else this.children.splice(idx, 0, node);
            return node;
        }
        after(node) {
            if (!this.parentElement) return;
            const siblings = this.parentElement.children;
            const idx = siblings.indexOf(this);
            node.parentElement = this.parentElement;
            if (idx === -1) siblings.push(node);
            else siblings.splice(idx + 1, 0, node);
        }
        contains(target) {
            if (target === this) return true;
            return this.children.some(child => typeof child?.contains === 'function' && child.contains(target));
        }
        querySelectorAll(selector) {
            const out = [];
            const matches = (el) => {
                if (!(el instanceof MiniElement)) return false;
                if (selector.startsWith('.')) return el.classList.contains(selector.slice(1));
                if (selector === '[data-resets-at]') return el.dataset.resetsAt !== undefined;
                if (selector === '[data-observed-at]') return el.dataset.observedAt !== undefined;
                if (selector === '[data-filter-key]') return el.dataset.filterKey !== undefined;
                return false;
            };
            const walk = (el) => {
                for (const child of el.children) {
                    if (matches(child)) out.push(child);
                    if (child instanceof MiniElement) walk(child);
                }
            };
            walk(this);
            return out;
        }
        querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
        allText() {
            const parts = [];
            const walk = (node) => {
                if (!node) return;
                if (node.children?.length) {
                    for (const child of node.children) walk(child);
                } else if (node.textContent) {
                    parts.push(node.textContent);
                }
            };
            walk(this);
            return parts.join(' ');
        }
    }

    const root = new MiniElement('div');
    root.id = 'dashboardMode';
    const attentionEl = new MiniElement('section');
    attentionEl.id = 'dashboardAttentionQueue';
    const gridEl = new MiniElement('div');
    gridEl.id = 'dashboardGrid';
    const emptyEl = new MiniElement('div');
    emptyEl.id = 'dashboardEmpty';
    root.append(attentionEl, gridEl, emptyEl);

    const byId = {
        dashboardMode: root,
        dashboardAttentionQueue: attentionEl,
        dashboardGrid: gridEl,
        dashboardEmpty: emptyEl,
    };
    const doc = Object.assign(new EventTarget(), {
        activeElement: null,
        hidden: false,
        getElementById: (id) => byId[id] || root.children.find(c => c.id === id) || null,
        createElement: (tag) => new MiniElement(tag),
        createElementNS: (_ns, tag) => new MiniElement(tag),
        createDocumentFragment: () => new MiniFragment(),
        createTextNode: (textContent) => ({ nodeType: 3, textContent, isConnected: true }),
    });
    return { root, attentionEl, gridEl, emptyEl, doc, MiniElement };
}

test('Claude weekly card visibility fix: falls back to quota.sevenDay when highestActiveLimit is absent and lights by % left', () => {
    const usage = {
        quotaAvailable: true,
        quota: {
            provider: 'claude',
            fiveHour: 0.19,
            sevenDay: 0.64,
            fiveHourResetsAt: FUTURE_5H,
            sevenDayResetsAt: FUTURE_WEEK,
        },
        quotaError: null,
    };
    const facts = claudeQuotaFacts(usage, NOW);
    assert.ok(facts, 'Claude card renders from sevenDay even without highestActiveLimit');
    assert.equal(facts.source, 'seven-day');
    assert.equal(facts.windowLabel, 'weekly');
    assert.equal(facts.usedText, '64%');
    assert.equal(facts.leftText, '36% left');
    assert.equal(facts.lit, 4, '36% left lights 4 of 12 segments');
    assert.equal(facts.resetsAt, FUTURE_WEEK);
    assert.equal(facts.fiveHourText, '5h 81% left');
    assert.equal(facts.muted, false);

    // Non-zero segment floor: 3% left still lights 1 segment, never 0.
    const sliver = claudeQuotaFacts({ quotaAvailable: true, quota: { sevenDay: 0.97, sevenDayResetsAt: FUTURE_WEEK } }, NOW);
    assert.equal(sliver.leftText, '3% left');
    assert.equal(sliver.lit, 1);

    // 401 renders muted unknown state (never fake 0%).
    const authErr = claudeQuotaFacts({ quotaAvailable: false, quota: { fiveHour: null, sevenDay: null }, quotaError: { status: 401, at: NOW } }, NOW);
    assert.equal(authErr.usedText, '—');
    assert.equal(authErr.leftText, '—');
    assert.equal(authErr.lit, 0);
    assert.equal(authErr.muted, true);
    assert.equal(authErr.errorStatus, 401);

    // Completely unavailable / unconfigured returns null.
    assert.equal(claudeQuotaFacts({ quotaAvailable: false, quota: { fiveHour: null, sevenDay: null }, quotaError: null }, NOW), null);
});

test('DashboardRenderer renders all 4 provider cards in .dashboard-quota-rail, hides when all null, and keeps filter bar uncrowded', (t) => {
    const origDoc = globalThis.document;
    const origWin = globalThis.window;
    const origNode = globalThis.Node;
    const dom = createMiniDom();
    globalThis.document = dom.doc;
    globalThis.window = new EventTarget();
    globalThis.Node = dom.MiniElement;

    const dash = new DashboardRenderer({ agents: new Map() });
    dash.active = true;
    t.after(() => {
        dash.destroy();
        if (origDoc === undefined) delete globalThis.document; else globalThis.document = origDoc;
        if (origWin === undefined) delete globalThis.window; else globalThis.window = origWin;
        if (origNode === undefined) delete globalThis.Node; else globalThis.Node = origNode;
    });

    // 1. All 4 providers null -> .dashboard-quota-rail hidden cleanly.
    dash._renderAttentionQueue([]);
    dash._renderQuotaRail({
        quotaAvailable: false,
        quota: { fiveHour: null, sevenDay: null },
        quotaError: null,
        codex: null,
        glm: null,
        antigravity: null,
    });
    assert.ok(dash.quotaRailEl, 'quota rail created');
    assert.equal(dash.quotaRailEl.className, 'dashboard-quota-rail');
    assert.equal(dash.quotaRailEl.hidden, true, 'hidden when all 4 providers are null');
    assert.equal(dom.root.children[0], dom.attentionEl);
    assert.equal(dom.root.children[1], dash.quotaRailEl, 'rail mounts right below .dashboard-attention');
    assert.equal(dom.root.children[2], dom.gridEl);

    // 2. All 4 providers populated via usage:updated event (anchored to live clock
    // so 5h reset timestamps stay in the future regardless of when tests run).
    const liveNow = Date.now();
    const liveWeek = liveNow + 5 * 24 * 60 * 60_000;
    const live5h = liveNow + 3 * 60 * 60_000;
    const fullUsage = {
        quotaAvailable: true,
        quota: {
            provider: 'claude',
            fiveHour: 0.15,
            sevenDay: 0.58,
            fiveHourResetsAt: live5h,
            sevenDayResetsAt: liveWeek,
        },
        quotaError: null,
        codex: {
            usedPercent: 72,
            windowMinutes: 10080,
            resetsAt: liveWeek,
            credits: { balance: 120, hasCredits: true, unlimited: false },
            limitReached: false,
            observedAt: liveNow - 120_000,
        },
        glm: {
            plan: 'max',
            weekly: { usedPercent: 41, used: 4100, limit: 10000, remaining: 5900, resetsAt: new Date(liveWeek).toISOString() },
            fiveHour: { usedPercent: 9, used: 180, limit: 2000, remaining: 1820, resetsAt: new Date(live5h).toISOString() },
            observedAt: new Date(liveNow).toISOString(),
            error: null,
        },
        antigravity: {
            source: 't3-cache',
            geminiWeekly: { usedPercent: 23.4, resetsAt: new Date(liveWeek).toISOString(), windowMinutes: 10080, label: 'Gemini · Weekly' },
            geminiFiveHour: { usedPercent: 30, resetsAt: new Date(live5h).toISOString(), windowMinutes: 300, label: 'Gemini · 5-hour' },
            sharedWeekly: { usedPercent: 12, resetsAt: null, windowMinutes: 10080, label: 'Claude & GPT (shared) · Weekly' },
            sharedFiveHour: { usedPercent: 4, resetsAt: null, windowMinutes: 300, label: 'Claude & GPT (shared) · 5-hour' },
            observedAt: new Date(liveNow - 180_000).toISOString(),
            error: null,
        },
    };
    eventBus.emit('usage:updated', fullUsage);

    assert.equal(dash.quotaRailEl.hidden, false);
    const cards = dash.quotaRailEl.querySelectorAll('.dashboard-quota');
    assert.equal(cards.length, 4, 'all 4 provider cards rendered in the rail');
    assert.deepEqual(cards.map(c => c.dataset.provider), ['claude', 'codex', 'glm', 'antigravity']);

    // Filter bar (.dashboard-attention) must hold zero quota cards so chips are never starved.
    assert.equal(dom.attentionEl.querySelectorAll('.dashboard-quota').length, 0);

    // Inspect each card's content, % left fill direction, eyebrow, and provider accents.
    const eyebrow = dash.quotaRailEl.querySelector('.dashboard-quota-rail__eyebrow');
    assert.equal(eyebrow?.textContent, 'WEEKLY LIMITS');
    const [claudeCard, codexCard, glmCard, agCard] = cards;
    assert.match(claudeCard.allText(), /CLAUDE.*42% left.*5h 85% left/);
    assert.match(codexCard.allText(), /CODEX.*28% left.*120 credits/);
    assert.match(glmCard.allText(), /GLM.*59% left.*5h 91% left/);
    assert.equal(glmCard.querySelector('.dashboard-quota__provider').style.color, '#b36b51');
    assert.match(glmCard.title, /plan max/, 'GLM plan rides in tooltip so subline stays concise at 1280px');
    assert.match(agCard.allText(), /ANTIGRAVITY.*77% left.*3P 88% left/);
    assert.equal(agCard.querySelector('.dashboard-quota__provider').style.color, '#6c96c2');
    assert.match(agCard.title, /Antigravity Weekly.*Gemini models 77% left.*Gemini 5h 70% left.*3P 5h 96% left/, 'Antigravity tooltip carries unified naming and 5h % left details');

    // Errors appear FIRST in subline (never ellipsized at the tail at 1280px).
    eventBus.emit('usage:updated', {
        ...fullUsage,
        quotaError: { status: 429, at: liveNow },
        antigravity: { ...fullUsage.antigravity, geminiWeekly: { usedPercent: 100, resetsAt: new Date(liveWeek).toISOString() } },
    });
    const stressedCards = dash.quotaRailEl.querySelectorAll('.dashboard-quota');
    const claudeFactsFirst = stressedCards[0].querySelector('.dashboard-quota__facts')?.children?.[0];
    assert.equal(claudeFactsFirst?.textContent, 'Throttled (429)', 'error status sits FIRST before reset/5h facts');
    assert.match(stressedCards[3].allText(), /ANTIGRAVITY.*LIMIT.*3P 88% left/, 'Antigravity LIMIT badge sits cleanly on head with unclipped 3P fact');
    assert.match(stressedCards[3].title, /Gemini models 0% left/, 'Antigravity LIMIT tooltip carries explicit 0% left reading');

    // Restore fullUsage for countdown ticker & signature checks.
    eventBus.emit('usage:updated', fullUsage);

    // 3. 1 Hz reset countdown ticker updates all 4 provider cards cleanly.
    const resetNodes = dash.quotaRailEl.querySelectorAll('[data-resets-at]');
    assert.equal(resetNodes.length, 4, 'all 4 cards carry a reset countdown');
    dash._tickResetCountdowns(liveNow);
    for (const node of resetNodes) assert.equal(node.textContent, 'Resets 5d');
    dash._tickResetCountdowns(liveNow + 24 * 60 * 60_000);
    for (const node of resetNodes) assert.equal(node.textContent, 'Resets 4d');

    // 4. quotaCardsSignature detects changes across all 4 providers.
    const sigBase = JSON.stringify(quotaCardsSignature(fullUsage));
    assert.notEqual(
        JSON.stringify(quotaCardsSignature({ ...fullUsage, glm: { ...fullUsage.glm, weekly: { ...fullUsage.glm.weekly, usedPercent: 50 } } })),
        sigBase,
    );
    assert.notEqual(
        JSON.stringify(quotaCardsSignature({ ...fullUsage, antigravity: null })),
        sigBase,
    );
    assert.notEqual(
        JSON.stringify(quotaCardsSignature({ ...fullUsage, quota: { ...fullUsage.quota, sevenDay: 0.7 } })),
        sigBase,
    );
});

test('GLM, Antigravity, and Codex fact normalizers handle 401/429 errors, expired windows, and non-zero floor without faking 0%', () => {
    const glmErr = glmQuotaFacts({ plan: null, weekly: null, fiveHour: null, observedAt: null, error: { status: 401, at: NOW } }, NOW);
    assert.equal(glmErr.usedText, '—');
    assert.equal(glmErr.leftText, '—');
    assert.equal(glmErr.lit, 0);
    assert.equal(glmErr.muted, true);
    assert.equal(glmErr.errorStatus, 401);

    const agErr = antigravityQuotaFacts({
        source: 'oauth-api',
        geminiWeekly: null,
        geminiFiveHour: null,
        sharedWeekly: null,
        sharedFiveHour: null,
        observedAt: null,
        error: { status: 429, at: NOW },
    }, NOW);
    assert.equal(agErr.usedText, '—');
    assert.equal(agErr.leftText, '—');
    assert.equal(agErr.lit, 0);
    assert.equal(agErr.muted, true);
    assert.equal(agErr.errorStatus, 429);

    // Configured provider with expired windows renders a clean muted Unavailable card (never hidden or 0%).
    const agExpired = antigravityQuotaFacts({
        source: 't3-cache',
        geminiWeekly: { usedPercent: 40, resetsAt: new Date(PAST_RESET).toISOString() },
        error: null,
    }, NOW);
    assert.ok(agExpired, 'configured expired Antigravity keeps muted card');
    assert.equal(agExpired.muted, true);
    assert.equal(agExpired.leftText, '—');

    // Non-zero segment floor + explicit Codex weekly vs 5h split.
    const agSliver = antigravityQuotaFacts({
        geminiWeekly: { usedPercent: 97, resetsAt: new Date(FUTURE_WEEK).toISOString() },
    }, NOW);
    assert.equal(agSliver.leftText, '3% left');
    assert.equal(agSliver.lit, 1);

    const codexSplit = codexQuotaFacts({
        weekly: { usedPercent: 35, windowMinutes: 10080, resetsAt: FUTURE_WEEK },
        fiveHour: { usedPercent: 12, windowMinutes: 300, resetsAt: FUTURE_5H },
        usedPercent: 12,
        windowMinutes: 300,
        resetsAt: FUTURE_5H,
    }, NOW);
    assert.equal(codexSplit.leftText, '65% left');
    assert.equal(codexSplit.fiveHourText, '5h 88% left');
    assert.equal(codexSplit.lit, 8);
});

test('Quota Rail CSS obeys desktop-first rules in dashboard.css and scopes mobile wrap in mobile.css', async () => {
    const [dashboardCss, mobileCss] = await Promise.all([
        readFile(new URL('../../claudeville/css/dashboard.css', import.meta.url), 'utf8'),
        readFile(new URL('../../claudeville/css/mobile.css', import.meta.url), 'utf8'),
    ]);
    assert.match(dashboardCss, /\.dashboard-quota-rail\s*\{/);
    assert.match(dashboardCss, /\.dashboard-quota--glm\s*\{[^}]*#b36b51/);
    assert.match(dashboardCss, /\.dashboard-quota--antigravity\s*\{[^}]*#6c96c2/);
    assert.doesNotMatch(dashboardCss, /@media[^\{]*max-width\s*:/i);
    assert.match(mobileCss, /:root\[data-cv-profile="mobile"\]\s+\.dashboard-quota-rail\s*\{/);
});
