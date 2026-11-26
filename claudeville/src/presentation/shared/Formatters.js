import { AgentStatus, normalizeAgentStatus } from '../../domain/value-objects/AgentStatus.js';
import { TokenUsage } from '../../domain/value-objects/TokenUsage.js';
// A cycle (AgentPresentation imports this module); both use the other's
// bindings only inside functions, never while evaluating.
import { DEPARTED_WORD, statusWord } from './AgentPresentation.js';

const HOME_ROOTS = Object.freeze(['users', 'home']);
const ABSOLUTE_PATH_TOKEN_RE = /(^|[\s"'`=(\[{])((?:\/|[A-Za-z]:[\\/])[^"'`\s;&|<>()[\]{}]*)/g;
const COMMAND_PREFIX_RE = /^(?:(?:env|sudo|command|exec|time)\s+)*(?:apply_patch|awk|bash|bun|cargo|cat|cd|chmod|chown|cmd|composer|cp|curl|deno|diff|docker|fd|find|gh|git|grep|head|java|javac|jest|kubectl|ls|make|mkdir|mv|node|npm|npx|patch|perl|php|pip|pnpm|powershell|pytest|python|python3|pwd|pwsh|rg|rm|ruby|rustc|sed|scp|sh|ssh|tail|touch|vitest|wget|yarn|zsh)(?=\s|$)/i;
const RELATIVE_TIME_THRESHOLDS = [
    [60_000, 'just now'],
    [60 * 60_000, (ms) => `${Math.floor(ms / 60_000)}m ago`],
    [24 * 60 * 60_000, (ms) => `${Math.floor(ms / (60 * 60_000))}h ago`],
    [7 * 24 * 60 * 60_000, (ms) => `${Math.floor(ms / (24 * 60 * 60_000))}d ago`],
];
const ELAPSED_PATCH_INTERVAL_MS = 1000;
const elapsedTargets = new Set();
let elapsedTimer = null;
// The instant the shared 1 Hz patch last read the clock: every elapsed age
// on screen (sidebar, cards, the World's T1 plates) formats from this one
// value, so no surface ever runs a second ahead of another.
let elapsedTickAt = 0;

/** The shared 1 Hz tick's clock (Date.now() while no tick is running). */
export function elapsedTickNow() {
    return elapsedTimer !== null && elapsedTickAt > 0 ? elapsedTickAt : Date.now();
}

export function hashRows(rows, fields) {
    let hash = 2166136261;
    for (const row of rows || []) {
        for (const field of fields) {
            const value = typeof field === 'function' ? field(row) : row?.[field];
            const str = String(value ?? '');
            for (let i = 0; i < str.length; i++) {
                hash ^= str.charCodeAt(i);
                hash = Math.imul(hash, 16777619);
            }
            hash ^= 31;
            hash = Math.imul(hash, 16777619);
        }
        hash ^= 124;
        hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
}

export function normalizeStatus(status, fallback = 'idle') {
    return normalizeAgentStatus(status, fallback);
}

export function statusClass(status, fallback = 'idle') {
    const normalized = normalizeStatus(status, fallback);
    return [
        AgentStatus.WORKING,
        AgentStatus.IDLE,
        AgentStatus.WAITING,
        AgentStatus.RATE_LIMITED,
        AgentStatus.ERRORED,
        AgentStatus.WAITING_ON_USER,
        // 0.4 — completed is a first-class status with its own rail/dot/token;
        // without it a finished agent fell through to the idle class.
        AgentStatus.COMPLETED,
    ].includes(normalized) ? normalized : fallback;
}

export function formatNumber(num) {
    const value = Number(num) || 0;
    if (value >= 1000000) return `${(value / 1000000).toFixed(1)}M`;
    if (value >= 1000) return `${(value / 1000).toFixed(1)}K`;
    return String(value);
}

export function formatTokens(value) {
    return formatNumber(value);
}

export function formatRelative(ts, now = Date.now()) {
    if (!Number.isFinite(ts) || ts <= 0) return '';
    const ms = Math.max(0, now - ts);
    for (const [bound, fmt] of RELATIVE_TIME_THRESHOLDS) {
        if (ms < bound) return typeof fmt === 'function' ? fmt(ms) : fmt;
    }
    return `${Math.floor(ms / (7 * 24 * 60 * 60_000))}w ago`;
}

export function formatElapsed(ms) {
    const elapsed = Math.max(0, Math.floor(Number(ms) || 0));
    const seconds = Math.floor(elapsed / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    if (minutes < 60) return remainingSeconds ? `${minutes}m${remainingSeconds}s` : `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    const remainingMinutes = minutes % 60;
    if (hours < 24) return remainingMinutes ? `${hours}h${remainingMinutes}m` : `${hours}h`;
    const days = Math.floor(hours / 24);
    const remainingHours = hours % 24;
    return remainingHours ? `${days}d${remainingHours}h` : `${days}d`;
}

// The top bar's oldest-wait readout (W5.5b): minute grain, so the always-on
// HUD changes at most once a minute — `<1m`, `12m`, `2h5m`, `1d3h`.
export function formatWaitAge(ms) {
    const minutes = Math.floor(Math.max(0, Number(ms) || 0) / 60_000);
    if (minutes < 1) return '<1m';
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    const remainingMinutes = minutes % 60;
    if (hours < 24) return remainingMinutes ? `${hours}h${remainingMinutes}m` : `${hours}h`;
    const days = Math.floor(hours / 24);
    const remainingHours = hours % 24;
    return remainingHours ? `${days}d${remainingHours}h` : `${days}d`;
}

// SG-3 — the net change between the two newest Codex balance readings of one
// account. Zero means the two readings agreed, which is not evidence that
// nothing was spent between them.
// `short` is the Dashboard card's form, beside a balance already worded.
export function formatCreditChange(change, { short = false } = {}) {
    const delta = Number(change?.delta);
    const interval = Number(change?.intervalMs);
    if (!change || !Number.isFinite(delta) || !Number.isFinite(interval) || interval < 0) return '';
    const apart = formatWaitAge(interval);
    if (delta === 0) return short ? `2 readings ${apart} apart agreed` : `two balance readings ${apart} apart agreed`;
    const amount = Math.abs(delta);
    const text = amount < 0.01 ? 'under 0.01' : amount.toLocaleString('en-US', { maximumFractionDigits: 2 });
    const verb = delta < 0 ? 'fell' : 'rose';
    return short ? `${verb} ${text} in ${apart}` : `balance ${verb} ${text} credits between readings ${apart} apart`;
}

const QUOTA_LIMIT_KINDS = Object.freeze({
    session: '5-hour session',
    weekly_all: 'weekly',
    weekly_scoped: 'weekly',
});

// The registry's highest active Claude limit as words: kind, scope, the
// reported percentage and severity. `warn` is any severity other than normal.
export function quotaLimitFacts(limit) {
    const used = Number(limit?.usedPercent);
    if (!limit || typeof limit.kind !== 'string' || !Number.isFinite(used)) return null;
    const kind = QUOTA_LIMIT_KINDS[limit.kind] || limit.kind.replace(/[_-]+/g, ' ');
    const model = typeof limit.scope?.model === 'string' ? limit.scope.model : '';
    const severity = typeof limit.severity === 'string' ? limit.severity : '';
    const resetsAt = Number(limit.resetsAt);
    return {
        label: model ? `${kind} (${model})` : kind,
        used,
        usedText: `${Math.round(used)}%`,
        severity,
        warn: Boolean(severity) && severity !== 'normal',
        resetsAt: Number.isFinite(resetsAt) && resetsAt > 0 ? resetsAt : null,
    };
}

const QUOTA_GAUGE_SEGMENTS = 12;

export function parseResetTimestamp(value) {
    if (value === null || value === undefined || value === '') return null;
    if (typeof value === 'number') {
        if (!Number.isFinite(value) || value <= 0) return null;
        return Math.round(value >= 1e9 && value < 1e12 ? value * 1000 : value);
    }
    if (typeof value === 'string') {
        const trimmed = value.trim();
        if (!trimmed) return null;
        const asNumber = Number(trimmed);
        if (Number.isFinite(asNumber)) {
            return asNumber > 0 ? Math.round(asNumber >= 1e9 && asNumber < 1e12 ? asNumber * 1000 : asNumber) : null;
        }
        const parsed = Date.parse(trimmed.replace(/(\.\d{3})\d+/, '$1'));
        return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : null;
    }
    return null;
}

export function formatResetCountdown(resetsAt, now = Date.now()) {
    const ms = parseResetTimestamp(resetsAt);
    if (ms === null) return '';
    const totalMinutes = Math.floor(Math.max(0, ms - now) / 60_000);
    if (totalMinutes < 1) return 'Resets <1m';
    if (totalMinutes < 60) return `Resets ${totalMinutes}m`;
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    if (hours < 24) return minutes ? `Resets ${hours}h ${minutes}m` : `Resets ${hours}h`;
    const days = Math.floor(hours / 24);
    const remHours = hours % 24;
    return remHours ? `Resets ${days}d ${remHours}h` : `Resets ${days}d`;
}

export function formatQuotaErrorStatus(status) {
    const code = Number(status);
    if (code === 401) return 'Auth expired (401)';
    if (code === 403) return 'Auth rejected (403)';
    if (code === 429) return 'Throttled (429)';
    return '';
}

function finiteNumberOrNull(value) {
    if (value === null || value === undefined || value === '') return null;
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
}

function clampQuotaPercent(value) {
    const numeric = finiteNumberOrNull(value);
    if (numeric === null) return null;
    return Math.min(100, Math.max(0, numeric));
}

function leftPercentFromUsed(usedPercent) {
    if (usedPercent === null || usedPercent === undefined || !Number.isFinite(usedPercent)) return null;
    const clamped = Math.min(100, Math.max(0, usedPercent));
    if (clamped >= 100) return 0;
    if (clamped <= 0) return 100;
    return Math.max(1, Math.min(99, Math.round(100 - clamped)));
}

/**
 * Segments lit for a remaining `% left` gauge (12 segments):
 * 0 when spent or unknown, full at 100%, and at least 1 segment whenever
 * 0 < leftPercent < 100 so `3% left` never renders as zero empty ticks.
 */
export function quotaGaugeLitLeft(leftPercent, segments = QUOTA_GAUGE_SEGMENTS) {
    if (leftPercent === null || leftPercent === undefined || !Number.isFinite(leftPercent)) return 0;
    const left = Math.min(100, Math.max(0, leftPercent));
    if (left <= 0) return 0;
    if (left >= 100) return segments;
    return Math.min(segments, Math.max(1, Math.round((left / 100) * segments)));
}

function liveWindowFacts(window, now) {
    if (!window || typeof window !== 'object') return null;
    const usedPercent = clampQuotaPercent(window.usedPercent);
    if (usedPercent === null) return null;
    const resetsAt = parseResetTimestamp(window.resetsAt);
    if (resetsAt !== null && resetsAt <= now) return null;
    return {
        usedPercent,
        leftRaw: Math.max(0, 100 - usedPercent),
        leftPercent: leftPercentFromUsed(usedPercent),
        resetsAt,
        used: finiteNumberOrNull(window.used),
        limit: finiteNumberOrNull(window.limit),
        remaining: finiteNumberOrNull(window.remaining),
        label: typeof window.label === 'string' ? window.label : '',
    };
}

/**
 * Normalize `/api/usage` Claude account limits for the Dashboard Quota Rail.
 * Lights segments by `% left` (unified with Runic Tide-Terrace and QuotaLedgerCard).
 */
export function claudeQuotaFacts(usage, now = Date.now()) {
    if (!usage || typeof usage !== 'object') return null;
    const quota = usage.quota && typeof usage.quota === 'object' ? usage.quota : null;
    const available = usage.quotaAvailable !== false;
    const errorStatus = Number(usage.quotaError?.status) || null;

    const fiveHourResetsAt = parseResetTimestamp(quota?.fiveHourResetsAt);
    const fiveHourRatio = available && !(fiveHourResetsAt !== null && fiveHourResetsAt <= now)
        ? finiteNumberOrNull(quota?.fiveHour)
        : null;
    const fiveHourPct = fiveHourRatio !== null ? Math.min(100, Math.max(0, fiveHourRatio * 100)) : null;
    const fiveHourLeft = fiveHourPct !== null ? leftPercentFromUsed(fiveHourPct) : null;

    const sevenDayResetsAt = parseResetTimestamp(quota?.sevenDayResetsAt);
    const sevenDayRatio = available && !(sevenDayResetsAt !== null && sevenDayResetsAt <= now)
        ? finiteNumberOrNull(quota?.sevenDay)
        : null;
    const sevenDayPct = sevenDayRatio !== null ? Math.min(100, Math.max(0, sevenDayRatio * 100)) : null;

    const activeRaw = available ? quotaLimitFacts(quota?.highestActiveLimit) : null;
    const active = activeRaw && !(activeRaw.resetsAt !== null && activeRaw.resetsAt <= now) ? activeRaw : null;

    if (active) {
        const isSession = quota?.highestActiveLimit?.kind === 'session';
        const leftRaw = Math.max(0, 100 - active.used);
        const leftPct = leftPercentFromUsed(active.used);
        const limit = active.used >= 100;
        return {
            source: 'active-limit',
            windowLabel: active.label,
            used: active.used,
            usedText: active.usedText,
            left: leftRaw,
            leftPercent: leftPct,
            leftText: `${leftPct}% left`,
            lit: limit ? 0 : quotaGaugeLitLeft(leftRaw),
            limit,
            resetsAt: active.resetsAt && active.resetsAt > now ? active.resetsAt : null,
            warn: active.warn || limit,
            badgeWord: active.warn ? active.severity.toUpperCase() : (limit ? 'LIMIT' : ''),
            fiveHourText: !isSession && fiveHourLeft !== null ? `5h ${fiveHourLeft}% left` : '',
            fiveHourResetsAt: !isSession && fiveHourLeft !== null && fiveHourResetsAt > now ? fiveHourResetsAt : null,
            errorStatus,
            muted: false,
        };
    }

    if (sevenDayPct !== null) {
        const leftRaw = Math.max(0, 100 - sevenDayPct);
        const leftPct = leftPercentFromUsed(sevenDayPct);
        const limit = sevenDayPct >= 100;
        return {
            source: 'seven-day',
            windowLabel: 'weekly',
            used: sevenDayPct,
            usedText: `${Math.round(sevenDayPct)}%`,
            left: leftRaw,
            leftPercent: leftPct,
            leftText: `${leftPct}% left`,
            lit: limit ? 0 : quotaGaugeLitLeft(leftRaw),
            limit,
            resetsAt: sevenDayResetsAt && sevenDayResetsAt > now ? sevenDayResetsAt : null,
            warn: limit,
            badgeWord: limit ? 'LIMIT' : '',
            fiveHourText: fiveHourLeft !== null ? `5h ${fiveHourLeft}% left` : '',
            fiveHourResetsAt: fiveHourLeft !== null && fiveHourResetsAt > now ? fiveHourResetsAt : null,
            errorStatus,
            muted: false,
        };
    }

    if (fiveHourPct !== null) {
        const leftRaw = Math.max(0, 100 - fiveHourPct);
        const leftPct = leftPercentFromUsed(fiveHourPct);
        const limit = fiveHourPct >= 100;
        return {
            source: 'five-hour',
            windowLabel: '5h',
            used: fiveHourPct,
            usedText: `${Math.round(fiveHourPct)}%`,
            left: leftRaw,
            leftPercent: leftPct,
            leftText: `${leftPct}% left`,
            lit: limit ? 0 : quotaGaugeLitLeft(leftRaw),
            limit,
            resetsAt: fiveHourResetsAt && fiveHourResetsAt > now ? fiveHourResetsAt : null,
            warn: limit,
            badgeWord: limit ? 'LIMIT' : '',
            fiveHourText: '',
            fiveHourResetsAt: null,
            errorStatus,
            muted: false,
        };
    }

    const hasExpiredWindow = available && Boolean(
        (sevenDayResetsAt !== null && sevenDayResetsAt <= now)
        || (fiveHourResetsAt !== null && fiveHourResetsAt <= now),
    );
    if (errorStatus === 401 || errorStatus === 403 || errorStatus === 429 || hasExpiredWindow) {
        return {
            source: errorStatus ? 'error' : 'expired',
            windowLabel: 'weekly',
            used: null,
            usedText: '—',
            left: null,
            leftPercent: null,
            leftText: '—',
            lit: 0,
            limit: false,
            resetsAt: null,
            warn: false,
            badgeWord: '',
            fiveHourText: '',
            fiveHourResetsAt: null,
            errorStatus,
            muted: true,
        };
    }

    return null;
}

/**
 * Normalize `/api/usage.codex` for the Dashboard Quota Rail.
 * Reads explicit `codex.weekly` first (Fix Lane 1), falling back to legacy
 * top-level `codex` only when `windowMinutes == null || windowMinutes >= 1440`,
 * and surfaces `codex.fiveHour` as a secondary `% left` fact.
 */
export function codexQuotaFacts(codex, now = Date.now()) {
    if (!codex || typeof codex !== 'object') return null;
    const legacyMinutes = finiteNumberOrNull(codex.windowMinutes);
    const weeklyRaw = codex.weekly ?? (legacyMinutes === null || legacyMinutes >= 1440 ? codex : null);
    const fiveHourRaw = codex.fiveHour ?? (legacyMinutes !== null && legacyMinutes > 0 && legacyMinutes < 1440 ? codex : null);

    const weekly = liveWindowFacts(weeklyRaw, now);
    const fiveHour = liveWindowFacts(fiveHourRaw, now);
    const limit = codex.limitReached === true || weeklyRaw?.limitReached === true || (weekly !== null && weekly.usedPercent >= 100);

    const used = weekly ? weekly.usedPercent : null;
    const leftRaw = limit ? 0 : (weekly ? weekly.leftRaw : null);
    const leftPct = limit ? 0 : (weekly ? weekly.leftPercent : null);
    const rawResetsAt = parseResetTimestamp(weeklyRaw?.resetsAt ?? (weekly ? null : codex.resetsAt));
    const resetsAt = weekly?.resetsAt && weekly.resetsAt > now
        ? weekly.resetsAt
        : (limit && rawResetsAt && rawResetsAt > now ? rawResetsAt : null);

    const credits = codex.credits || {};
    const balance = finiteNumberOrNull(credits.balance);
    const observedAt = parseResetTimestamp(codex.observedAt);
    const minutes = finiteNumberOrNull(weeklyRaw?.windowMinutes ?? codex.windowMinutes) || 0;

    return {
        windowLabel: minutes === 0 || minutes >= 1440 ? 'weekly' : (minutes >= 60 ? `${Math.round(minutes / 60)}h` : 'window'),
        used,
        usedText: used === null ? '—' : `${Math.round(used)}%`,
        left: leftRaw,
        leftPercent: leftPct,
        leftText: leftPct === null ? '—' : `${leftPct}% left`,
        lit: limit ? 0 : quotaGaugeLitLeft(leftRaw),
        limit,
        resetsAt,
        fiveHourText: fiveHour ? `5h ${fiveHour.leftPercent}% left` : '',
        fiveHourResetsAt: fiveHour?.resetsAt && fiveHour.resetsAt > now ? fiveHour.resetsAt : null,
        credits: credits.unlimited === true ? 'unlimited credits'
            : balance !== null ? `${balance.toLocaleString('en-US', { maximumFractionDigits: 2 })} credits` : '',
        observedAt,
        creditChange: formatCreditChange(codex.creditChange, { short: true }),
        muted: !limit && leftRaw === null,
    };
}

/**
 * Normalize `/api/usage.glm` for the Dashboard Quota Rail.
 */
export function glmQuotaFacts(glm, now = Date.now()) {
    if (!glm || typeof glm !== 'object') return null;
    const weekly = liveWindowFacts(glm.weekly, now);
    const fiveHour = liveWindowFacts(glm.fiveHour, now);
    const errorStatus = Number(glm.error?.status) || null;
    const plan = typeof glm.plan === 'string' && glm.plan.trim() ? glm.plan.trim() : '';
    const observedAt = parseResetTimestamp(glm.observedAt);
    const hasConfiguredShape = Boolean(glm.weekly || glm.fiveHour || errorStatus || observedAt || plan);

    if (!weekly && !fiveHour && !hasConfiguredShape) return null;

    const primary = weekly || fiveHour;
    const used = primary ? primary.usedPercent : null;
    const leftRaw = primary ? primary.leftRaw : null;
    const leftPct = primary ? primary.leftPercent : null;
    const limit = used !== null && used >= 100;
    const authCleared = errorStatus === 401 || errorStatus === 403;
    return {
        windowLabel: weekly ? 'weekly' : (fiveHour ? '5h' : 'weekly'),
        used: authCleared ? null : used,
        usedText: authCleared || used === null ? '—' : `${Math.round(used)}%`,
        left: authCleared ? null : leftRaw,
        leftPercent: authCleared ? null : leftPct,
        leftText: authCleared || leftPct === null ? '—' : `${leftPct}% left`,
        lit: authCleared || limit ? 0 : quotaGaugeLitLeft(leftRaw),
        limit: !authCleared && limit,
        resetsAt: !authCleared && primary?.resetsAt && primary.resetsAt > now ? primary.resetsAt : null,
        fiveHourText: !authCleared && weekly && fiveHour ? `5h ${fiveHour.leftPercent}% left` : '',
        fiveHourResetsAt: !authCleared && fiveHour?.resetsAt && fiveHour.resetsAt > now ? fiveHour.resetsAt : null,
        usedCredits: primary?.used ?? null,
        limitCredits: primary?.limit ?? null,
        remainingCredits: primary?.remaining ?? null,
        plan,
        observedAt,
        errorStatus,
        muted: authCleared || leftRaw === null,
    };
}

/**
 * Normalize `/api/usage.antigravity` for the Dashboard Quota Rail.
 * Primary gauge tracks Antigravity Weekly (Gemini models); 3P shared Weekly
 * rides in the subline, and both 5h windows surface on hover.
 */
export function antigravityQuotaFacts(antigravity, now = Date.now()) {
    if (!antigravity || typeof antigravity !== 'object') return null;
    const geminiWeekly = liveWindowFacts(antigravity.geminiWeekly, now);
    const geminiFiveHour = liveWindowFacts(antigravity.geminiFiveHour, now);
    const sharedWeekly = liveWindowFacts(antigravity.sharedWeekly, now);
    const sharedFiveHour = liveWindowFacts(antigravity.sharedFiveHour, now);
    const errorStatus = Number(antigravity.error?.status) || null;
    const observedAt = parseResetTimestamp(antigravity.observedAt);
    const source = typeof antigravity.source === 'string' ? antigravity.source : '';
    const hasConfiguredShape = Boolean(
        antigravity.geminiWeekly || antigravity.geminiFiveHour
        || antigravity.sharedWeekly || antigravity.sharedFiveHour
        || errorStatus || observedAt || source,
    );

    if (!geminiWeekly && !geminiFiveHour && !sharedWeekly && !sharedFiveHour && !hasConfiguredShape) {
        return null;
    }

    const authCleared = errorStatus === 401 || errorStatus === 403;
    const used = !authCleared && geminiWeekly ? geminiWeekly.usedPercent : null;
    const leftRaw = !authCleared && geminiWeekly ? geminiWeekly.leftRaw : null;
    const leftPct = !authCleared && geminiWeekly ? geminiWeekly.leftPercent : null;
    const sharedUsed = !authCleared && sharedWeekly ? sharedWeekly.usedPercent : null;
    const sharedLeftPct = !authCleared && sharedWeekly ? sharedWeekly.leftPercent : null;
    const limit = !authCleared && ((used !== null && used >= 100) || (sharedUsed !== null && sharedUsed >= 100));
    return {
        windowLabel: 'weekly',
        used,
        usedText: used === null ? '—' : `${Math.round(used)}%`,
        left: leftRaw,
        leftPercent: leftPct,
        leftText: leftPct === null ? '—' : `${leftPct}% left`,
        lit: limit ? 0 : quotaGaugeLitLeft(leftRaw),
        limit,
        resetsAt: !authCleared && geminiWeekly?.resetsAt && geminiWeekly.resetsAt > now ? geminiWeekly.resetsAt : null,
        sharedWeeklyUsed: sharedUsed,
        sharedWeeklyLeft: sharedLeftPct,
        sharedWeeklyText: sharedLeftPct !== null ? `3P ${sharedLeftPct}% left` : '',
        sharedWeeklyResetsAt: !authCleared && sharedWeekly?.resetsAt && sharedWeekly.resetsAt > now ? sharedWeekly.resetsAt : null,
        geminiFiveHourText: !authCleared && geminiFiveHour ? `Gemini 5h ${geminiFiveHour.leftPercent}% left` : '',
        geminiFiveHourResetsAt: !authCleared && geminiFiveHour?.resetsAt && geminiFiveHour.resetsAt > now ? geminiFiveHour.resetsAt : null,
        sharedFiveHourText: !authCleared && sharedFiveHour ? `3P 5h ${sharedFiveHour.leftPercent}% left` : '',
        sharedFiveHourResetsAt: !authCleared && sharedFiveHour?.resetsAt && sharedFiveHour.resetsAt > now ? sharedFiveHour.resetsAt : null,
        source,
        observedAt,
        errorStatus,
        muted: authCleared || leftRaw === null,
    };
}

export function workingSetForAgent(agent) {
    return Array.isArray(agent?.workingSet) ? agent.workingSet.slice(0, 16) : [];
}

export function collisionsForAgent(agent) {
    return Array.isArray(agent?.collisions) ? agent.collisions : [];
}

// The age prefix reads the one status-word map (UI-1); a departed villager
// is aged from its departure (UI-13).
export function formatStatusElapsed(agent, now = Date.now()) {
    const departedAt = Number(agent?.departedAt);
    if (agent?.isDeparted && departedAt > 0) {
        return `${DEPARTED_WORD} ${formatElapsed(Math.max(0, now - departedAt))} ago`;
    }
    const since = Number(agent?.statusSince);
    if (!Number.isFinite(since) || since <= 0) return '';
    return `${statusWord(agent?.status)} for ${formatElapsed(Math.max(0, now - since))}`;
}

function patchElapsedTargets() {
    const now = Date.now();
    elapsedTickAt = now;
    for (const target of [...elapsedTargets]) {
        if (!target.node?.isConnected) {
            elapsedTargets.delete(target);
            continue;
        }
        const text = String(target.text(now) ?? '');
        if (target.node.nodeType === 3) {
            if (target.node.nodeValue !== text) target.node.nodeValue = text;
        } else if (target.node.textContent !== text) {
            target.node.textContent = text;
        }
    }
    if (elapsedTargets.size === 0 && elapsedTimer !== null) {
        clearInterval(elapsedTimer);
        elapsedTimer = null;
    }
}

/** Register an existing text node/element for the single shared 1 Hz patch. */
export function subscribeElapsedText(node, text) {
    if (!node || typeof text !== 'function') return () => {};
    const target = { node, text };
    elapsedTargets.add(target);
    const initial = String(text(elapsedTickNow()) ?? '');
    if (node.nodeType === 3) node.nodeValue = initial;
    else node.textContent = initial;
    if (elapsedTimer === null) {
        elapsedTickAt = Date.now();
        elapsedTimer = setInterval(patchElapsedTargets, ELAPSED_PATCH_INTERVAL_MS);
    }
    return () => {
        elapsedTargets.delete(target);
        if (elapsedTargets.size === 0 && elapsedTimer !== null) {
            clearInterval(elapsedTimer);
            elapsedTimer = null;
        }
    };
}

export function formatCost(cost) {
    const value = Number(cost);
    if (!Number.isFinite(value) || value <= 0) return '$0.00';
    if (value < 0.001) return '<$0.001';
    if (value >= 1) return `$${value.toFixed(2)}`;
    return `$${value.toFixed(3)}`;
}

export function costSourceTitle(cost, provider) {
    if (cost.source === 'provider') return provider ? `Reported by ${provider}` : 'Provider-reported cost';
    const rates = `${cost.rateMatch || 'default'} rates, revision ${cost.rateRevision || TokenUsage.rateRevision}`;
    if (cost.source === 'mixed') return `Provider total + estimated usage (${rates})`;
    return `Estimated using ${rates}`;
}

export function shortenHomePath(path) {
    const text = String(path || '');
    if (!text || text === '_unknown') return '';
    const separator = text.includes('\\') ? '\\' : '/';
    const parts = text.replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean);
    const homeRootIndex = HOME_ROOTS.includes(String(parts[0] || '').toLowerCase())
        ? 0
        : (/^[A-Za-z]:$/.test(parts[0] || '')
            && HOME_ROOTS.includes(String(parts[1] || '').toLowerCase()) ? 1 : -1);
    if (homeRootIndex >= 0 && parts.length > homeRootIndex) {
        const suffix = parts.slice(homeRootIndex + 2).join(separator);
        return suffix ? `~${separator}${suffix}` : '~';
    }
    return text;
}

export function shortProjectName(path, unknownLabel = 'Unknown Project') {
    if (!path || path === '_unknown') return unknownLabel;
    const shortened = shortenHomePath(path);
    if (shortened === '~') return '~';
    const parts = String(path).replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean);
    return parts.at(-1) || String(path);
}

export function formatCdCommand(path) {
    const text = String(path || '').trim();
    if (!text || text === '_unknown') return '';
    return `cd '${text.replace(/'/g, `'"'"'`)}'`;
}

export function truncateText(value, max) {
    const text = String(value || '');
    const limit = Math.max(0, Math.floor(Number(max) || 0));
    if (text.length <= limit) return text;
    if (limit === 0) return '';
    if (limit === 1) return '…';
    return `${text.slice(0, limit - 1)}…`;
}

// Secrets never reach the DOM. The causal waterfall and the blocked banner
// share one redaction so a command echoed into tool history cannot leak a
// token that the banner would have stripped.
export function redactSecrets(text) {
    return String(text)
        .replace(/\b((?:[A-Za-z0-9_-]*?(?:key|token)))\s*=\s*(?:"[^"]*"|'[^']*'|[^\s&;,]+)/gi, '$1=[REDACTED]')
        .replace(/[A-Za-z0-9_-]{32,}/g, '[REDACTED]');
}

function normalizedPath(value) {
    return String(value || '').replace(/\\/g, '/').replace(/\/+$/, '');
}

function isWindowsPath(value) {
    return /^[A-Za-z]:[\\/]/.test(String(value || '')) || String(value || '').includes('\\');
}

function shortenAbsolutePathTokens(value) {
    return String(value || '').replace(ABSOLUTE_PATH_TOKEN_RE, (match, prefix, token) => (
        `${prefix}${shortenHomePath(token)}`
    ));
}

function unwrapPath(value) {
    const text = String(value || '').trim();
    if (text.length >= 2 && ['"', "'", '`'].includes(text[0]) && text.at(-1) === text[0]) {
        return text.slice(1, -1);
    }
    return text;
}

function isPathShapedDetail(value) {
    const text = unwrapPath(value);
    if (!text || /^[A-Za-z][A-Za-z\d+.-]*:\/\//.test(text)) return false;
    if (isAbsolutePath(text) || /^~[\\/]/.test(text) || /^\.{1,2}[\\/]/.test(text)) return true;
    if (!/\s/.test(text) && /[\\/]/.test(text) && /(?:^|[\\/])[^\\/]+(?:\.[A-Za-z\d_-]+)?$/.test(text)) return true;
    return /^[^\\/\s]+\.[A-Za-z\d_-]+$/.test(text);
}

function isAbsolutePath(value) {
    return /^(?:\/|[A-Za-z]:[\\/])/.test(String(value || ''));
}

function stripProjectPrefix(pathText, projectPath) {
    const text = String(pathText || '');
    const rawProject = String(projectPath || '');
    const project = shortenHomePath(rawProject);
    const normalizedText = normalizedPath(text);
    const normalizedProject = normalizedPath(project);
    if (!normalizedText || !normalizedProject || normalizedProject === '_unknown') return text;

    const caseInsensitive = isWindowsPath(text) || isWindowsPath(rawProject) || isWindowsPath(project);
    const comparableText = caseInsensitive ? normalizedText.toLowerCase() : normalizedText;
    const comparableProject = caseInsensitive ? normalizedProject.toLowerCase() : normalizedProject;
    if (comparableText === comparableProject) return '.';
    if (!comparableText.startsWith(`${comparableProject}/`)) return text;

    const suffix = normalizedText.slice(normalizedProject.length).replace(/^\/+/, '');
    const separator = text.includes('\\') || project.includes('\\') ? '\\' : '/';
    return suffix.replace(/\//g, separator);
}

function truncatePathFromHead(value, max) {
    const text = String(value || '');
    const limit = Math.max(0, Math.floor(Number(max) || 0));
    if (text.length <= limit) return text;
    if (limit === 0) return '';
    if (limit === 1) return '…';

    const separator = text.includes('\\') ? '\\' : '/';
    const segments = text.split(/[\\/]+/).filter(Boolean);
    const filename = segments.at(-1) || text;
    const marker = `…${separator}`;
    const available = limit - marker.length;
    if (available <= 0) return `…${filename.slice(-(limit - 1))}`;
    if (filename.length >= available) return `${marker}${filename.slice(-available)}`;

    const parent = segments.at(-2) || '';
    const parentBudget = available - separator.length - filename.length;
    if (parentBudget <= 0 || !parent) return `${marker}${filename}`;
    return `${marker}${parent.slice(-parentBudget)}${separator}${filename}`;
}

/**
 * Format a tool detail without sacrificing the useful end of a file path.
 * The raw value remains available to the caller for hover text.
 */
export function formatToolDetail(detail, { max = 48, projectPath = '' } = {}) {
    const raw = String(detail || '');
    if (!raw) return '';

    if (COMMAND_PREFIX_RE.test(raw.trim())) {
        return truncateText(shortenAbsolutePathTokens(raw), max);
    }

    const shortened = shortenAbsolutePathTokens(raw);
    const pathCandidate = unwrapPath(shortened);
    if (isPathShapedDetail(pathCandidate)) {
        const displayPath = shortenHomePath(pathCandidate);
        const relativePath = stripProjectPrefix(displayPath, projectPath);
        return truncatePathFromHead(relativePath, max);
    }

    return truncateText(shortened, max);
}
