// Runic Tide-Terrace — pure 4-provider weekly quota model for `/api/usage`
// (replaces the 2-account Hourglass Belfry on the NW lagoon headland).
//
// Each provider in QUOTA_TERRACE_PROVIDERS owns one modular carved stone gauge
// pillar (`prop.quotaPillar`) stamped from `prop.quotaPillarStrip`:
//   - claude:      weekly quota left (100 - usage.quota.sevenDay * 100), with
//                  fiveHour + fiveHourResetsAt + highestActiveLimit + error metadata
//   - codex:       weekly/binding quota left (100 - usage.codex.usedPercent),
//                  `limitReached` -> lavender wax-seal ribbon, credits/age metadata
//   - glm:         weekly quota left (100 - usage.glm.weekly.usedPercent),
//                  fiveHour + plan + error metadata
//   - antigravity: Gemini Weekly quota left (100 - usage.antigravity.geminiWeekly.usedPercent),
//                  sharedWeekly + geminiFiveHour + sharedFiveHour + source metadata
//
// Motion budget (MB-5):
//   - `static`: whole-cell swaps on quota changes (l0..l5, limit, unknown)
//   - `slow`:   2 fps (500 ms) 3-phase active-spend shimmer/trickle for 10 min
//               (`QUOTA_PILLAR_DRAIN_MS`) after that provider's `used` rose
//   - `medium`: 150 ms/step C4 cream reset refill (`peak` -> stepped climb)
//   - Reduced motion (`motionScale <= 0`): instant swaps, static cells only.

import { QUOTA_TERRACE_PROVIDERS } from '../../config/scenery.js';
import {
    formatCreditChange,
    formatNumber,
    formatWaitAge,
    parseResetTimestamp,
    quotaLimitFacts,
} from '../shared/Formatters.js';

export { QUOTA_TERRACE_PROVIDERS };

export const QUOTA_PILLAR_LEVELS = 5;
export const QUOTA_PILLAR_STATES = Object.freeze([
    'l0', 'l1', 'l2', 'l3', 'l4', 'l5', 'limit', 'unknown', 'peak',
]);
export const QUOTA_PILLAR_STREAM_PHASES = 3;
export const QUOTA_PILLAR_DRAIN_MS = 10 * 60_000;
export const QUOTA_PILLAR_STRIP_FRAME = Object.freeze([16, 48]);
export const QUOTA_PILLAR_STRIP_ORIGIN = Object.freeze([8, 12]);

export const QUOTA_PROVIDER_META = Object.freeze({
    claude: Object.freeze({
        id: 'claude',
        label: 'Claude',
        weeklyTitle: 'Claude Weekly',
        accent: '#d49b4b',
    }),
    codex: Object.freeze({
        id: 'codex',
        label: 'Codex',
        weeklyTitle: 'Codex Weekly',
        accent: '#5ba49c',
    }),
    glm: Object.freeze({
        id: 'glm',
        label: 'GLM',
        weeklyTitle: 'GLM Weekly',
        accent: '#b36b51',
    }),
    antigravity: Object.freeze({
        id: 'antigravity',
        label: 'Antigravity',
        weeklyTitle: 'Gemini Weekly',
        accent: '#6c96c2',
    }),
});

export function quotaProviderLabel(provider) {
    return QUOTA_PROVIDER_META[provider]?.label || String(provider || 'Provider');
}

export function quotaProviderWeeklyTitle(provider) {
    return QUOTA_PROVIDER_META[provider]?.weeklyTitle || `${quotaProviderLabel(provider)} Weekly`;
}

function clamp01(value) {
    if (value === null || value === undefined || value === '') return null;
    const numeric = Number(value);
    return Number.isFinite(numeric) ? Math.min(1, Math.max(0, numeric)) : null;
}

function clampPercent(value) {
    if (value === null || value === undefined || value === '') return null;
    const numeric = Number(value);
    return Number.isFinite(numeric) ? Math.min(100, Math.max(0, numeric)) : null;
}

function finiteOrNull(value) {
    if (value === null || value === undefined || value === '') return null;
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
}

/** Format a positive countdown duration as crisp readable text: `3d 4h`, `2d`, `4h 12m`, `18m`, `<1m`. */
export function formatQuotaCountdown(resetsAt, now = Date.now()) {
    const ms = parseResetTimestamp(resetsAt);
    if (ms === null) return '';
    const remaining = Math.max(0, ms - now);
    const totalMinutes = Math.floor(remaining / 60_000);
    if (totalMinutes < 1) return '<1m';
    if (totalMinutes < 60) return `${totalMinutes}m`;
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    if (hours < 24) return minutes ? `${hours}h ${minutes}m` : `${hours}h`;
    const days = Math.floor(hours / 24);
    const remHours = hours % 24;
    return remHours ? `${days}d ${remHours}h` : `${days}d`;
}

function errorReasonText(status, { provider = '' } = {}) {
    const code = Number(status);
    if (code === 401) return provider === 'claude' ? 'Sign-in expired (401)' : 'Auth expired (401)';
    if (code === 403) return 'Auth rejected (403)';
    if (code === 429) return 'Quota check throttled (429)';
    return '';
}

function isExpired(resetsAt, now) {
    return resetsAt !== null && resetsAt <= now;
}

/** Quota left (0–1) -> discrete rune course level: 5 at >= 80% left, 4 at >= 60%, 3 at >= 40%, 2 at >= 20%, 1 above 0%, 0 when spent. */
export function quotaPillarLevel(remaining) {
    const left = clamp01(remaining);
    if (left === null || left <= 0) return 0;
    return Math.min(QUOTA_PILLAR_LEVELS, Math.floor(left * QUOTA_PILLAR_LEVELS) + 1);
}

/** Strip cell index for one provider's static state (`l0`..`l5`, `limit`, `unknown`, `peak`). */
export function quotaPillarStateCell(provider, state, providers = QUOTA_TERRACE_PROVIDERS) {
    const index = providers.indexOf(provider);
    if (index < 0) return 0;
    const stateIndex = QUOTA_PILLAR_STATES.indexOf(state);
    return index * QUOTA_PILLAR_STATES.length + (stateIndex >= 0 ? stateIndex : QUOTA_PILLAR_STATES.indexOf('unknown'));
}

/** MB-5 — strip cell index for one provider's running spend shimmer/trickle (`l1`..`l5`, phase `0..2`). */
export function quotaPillarStreamCell(provider, level, phase, providers = QUOTA_TERRACE_PROVIDERS) {
    const index = providers.indexOf(provider);
    if (index < 0) return 0;
    return providers.length * QUOTA_PILLAR_STATES.length
        + (index * QUOTA_PILLAR_LEVELS + (level - 1)) * QUOTA_PILLAR_STREAM_PHASES + phase;
}

/** Total strip cells for a provider roster (`N * (9 states + 15 stream phases)`). */
export function quotaPillarStripCellCount(providers = QUOTA_TERRACE_PROVIDERS) {
    return providers.length * (QUOTA_PILLAR_STATES.length + QUOTA_PILLAR_LEVELS * QUOTA_PILLAR_STREAM_PHASES);
}

/** Normalized state + metadata for one provider pillar from `/api/usage`. */
export function quotaPillarReading(provider, usage, now = Date.now()) {
    if (provider === 'claude') {
        const errorStatus = Number(usage?.quotaError?.status) || null;
        const available = usage?.quotaAvailable !== false;
        const quota = usage?.quota && typeof usage.quota === 'object' ? usage.quota : null;
        const fiveHourResetsAt = parseResetTimestamp(quota?.fiveHourResetsAt);
        const fiveHour = available && !isExpired(fiveHourResetsAt, now) ? clamp01(quota?.fiveHour) : null;
        const sevenDayResetsAt = parseResetTimestamp(quota?.sevenDayResetsAt);
        const sevenDay = available && !isExpired(sevenDayResetsAt, now) ? clamp01(quota?.sevenDay) : null;
        const activeLimit = available ? quotaLimitFacts(quota?.highestActiveLimit) : null;
        const highestActiveLimit = activeLimit && !isExpired(activeLimit.resetsAt, now) ? activeLimit : null;

        if (errorStatus === 401 || errorStatus === 403 || !available || sevenDay === null) {
            return {
                provider: 'claude',
                state: 'unknown',
                level: null,
                used: null,
                usedPercent: null,
                leftPercent: null,
                resetsAt: null,
                fiveHourPercent: fiveHour !== null ? Math.round(fiveHour * 100) : null,
                fiveHourResetsAt: fiveHour !== null ? fiveHourResetsAt : null,
                highestActiveLimit,
                errorStatus,
                observedAt: null,
            };
        }
        const usedPercent = Math.round(sevenDay * 100);
        const leftPercent = Math.max(0, 100 - usedPercent);
        return {
            provider: 'claude',
            state: 'level',
            level: quotaPillarLevel(1 - sevenDay),
            used: sevenDay,
            usedPercent,
            leftPercent,
            resetsAt: sevenDayResetsAt,
            fiveHourPercent: fiveHour !== null ? Math.round(fiveHour * 100) : null,
            fiveHourResetsAt: fiveHour !== null ? fiveHourResetsAt : null,
            highestActiveLimit,
            errorStatus,
            observedAt: null,
        };
    }

    if (provider === 'codex') {
        const codex = usage?.codex && typeof usage.codex === 'object' ? usage.codex : null;
        const resetsAt = parseResetTimestamp(codex?.resetsAt);
        const observedAt = parseResetTimestamp(codex?.observedAt);
        const windowMinutes = finiteOrNull(codex?.windowMinutes);
        const credits = codex?.credits && typeof codex.credits === 'object'
            ? {
                unlimited: codex.credits.unlimited === true,
                hasCredits: codex.credits.hasCredits === true,
                balance: finiteOrNull(codex.credits.balance),
            }
            : null;
        const creditChange = codex?.creditChange || null;

        if (codex?.limitReached === true) {
            return {
                provider: 'codex',
                state: 'limit',
                level: 0,
                used: 1,
                usedPercent: 100,
                leftPercent: 0,
                resetsAt: !isExpired(resetsAt, now) ? resetsAt : null,
                windowMinutes,
                credits,
                creditChange,
                observedAt,
                limitReached: true,
                windowReset: false,
                errorStatus: null,
            };
        }
        const expired = isExpired(resetsAt, now);
        const rawUsedPct = !expired ? clampPercent(codex?.usedPercent) : null;
        if (rawUsedPct === null) {
            return {
                provider: 'codex',
                state: 'unknown',
                level: null,
                used: null,
                usedPercent: null,
                leftPercent: null,
                resetsAt: null,
                windowMinutes,
                credits,
                creditChange,
                observedAt,
                limitReached: false,
                windowReset: Boolean(codex),
                errorStatus: null,
            };
        }
        const used = rawUsedPct / 100;
        const usedPercent = Math.round(rawUsedPct);
        const leftPercent = Math.max(0, 100 - usedPercent);
        return {
            provider: 'codex',
            state: 'level',
            level: quotaPillarLevel(1 - used),
            used,
            usedPercent,
            leftPercent,
            resetsAt,
            windowMinutes,
            credits,
            creditChange,
            observedAt,
            limitReached: false,
            windowReset: false,
            errorStatus: null,
        };
    }

    if (provider === 'glm') {
        const glm = usage?.glm && typeof usage.glm === 'object' ? usage.glm : null;
        const errorStatus = Number(glm?.error?.status) || null;
        const observedAt = parseResetTimestamp(glm?.observedAt);
        const plan = typeof glm?.plan === 'string' && glm.plan.trim() ? glm.plan.trim() : '';

        const weeklyResetsAt = parseResetTimestamp(glm?.weekly?.resetsAt);
        const weeklyPct = !isExpired(weeklyResetsAt, now) ? clampPercent(glm?.weekly?.usedPercent) : null;
        const fiveHourResetsAt = parseResetTimestamp(glm?.fiveHour?.resetsAt);
        const fiveHourPct = !isExpired(fiveHourResetsAt, now) ? clampPercent(glm?.fiveHour?.usedPercent) : null;

        if (errorStatus === 401 || errorStatus === 403 || weeklyPct === null) {
            return {
                provider: 'glm',
                state: 'unknown',
                level: null,
                used: null,
                usedPercent: null,
                leftPercent: null,
                resetsAt: null,
                fiveHourPercent: fiveHourPct !== null ? Math.round(fiveHourPct) : null,
                fiveHourResetsAt: fiveHourPct !== null ? fiveHourResetsAt : null,
                plan,
                usedCredits: finiteOrNull(glm?.weekly?.used),
                limitCredits: finiteOrNull(glm?.weekly?.limit),
                remainingCredits: finiteOrNull(glm?.weekly?.remaining),
                observedAt,
                errorStatus,
            };
        }
        const used = weeklyPct / 100;
        const usedPercent = Math.round(weeklyPct);
        const leftPercent = Math.max(0, 100 - usedPercent);
        const limited = weeklyPct >= 100;
        return {
            provider: 'glm',
            state: limited ? 'limit' : 'level',
            level: limited ? 0 : quotaPillarLevel(1 - used),
            used,
            usedPercent,
            leftPercent,
            resetsAt: weeklyResetsAt,
            fiveHourPercent: fiveHourPct !== null ? Math.round(fiveHourPct) : null,
            fiveHourResetsAt: fiveHourPct !== null ? fiveHourResetsAt : null,
            plan,
            usedCredits: finiteOrNull(glm?.weekly?.used),
            limitCredits: finiteOrNull(glm?.weekly?.limit),
            remainingCredits: finiteOrNull(glm?.weekly?.remaining),
            observedAt,
            errorStatus,
        };
    }

    if (provider === 'antigravity') {
        const ag = usage?.antigravity && typeof usage.antigravity === 'object' ? usage.antigravity : null;
        const errorStatus = Number(ag?.error?.status) || null;
        const observedAt = parseResetTimestamp(ag?.observedAt);
        const source = typeof ag?.source === 'string' ? ag.source : '';

        const gemWeeklyResetsAt = parseResetTimestamp(ag?.geminiWeekly?.resetsAt);
        const gemWeeklyPct = !isExpired(gemWeeklyResetsAt, now) ? clampPercent(ag?.geminiWeekly?.usedPercent) : null;
        const sharedWeeklyResetsAt = parseResetTimestamp(ag?.sharedWeekly?.resetsAt);
        const sharedWeeklyPct = !isExpired(sharedWeeklyResetsAt, now) ? clampPercent(ag?.sharedWeekly?.usedPercent) : null;
        const gem5hResetsAt = parseResetTimestamp(ag?.geminiFiveHour?.resetsAt);
        const gem5hPct = !isExpired(gem5hResetsAt, now) ? clampPercent(ag?.geminiFiveHour?.usedPercent) : null;
        const shared5hResetsAt = parseResetTimestamp(ag?.sharedFiveHour?.resetsAt);
        const shared5hPct = !isExpired(shared5hResetsAt, now) ? clampPercent(ag?.sharedFiveHour?.usedPercent) : null;

        if (errorStatus === 401 || errorStatus === 403 || gemWeeklyPct === null) {
            return {
                provider: 'antigravity',
                state: 'unknown',
                level: null,
                used: null,
                usedPercent: null,
                leftPercent: null,
                resetsAt: null,
                sharedWeeklyUsedPercent: sharedWeeklyPct !== null ? Math.round(sharedWeeklyPct) : null,
                sharedWeeklyLeftPercent: sharedWeeklyPct !== null ? Math.max(0, 100 - Math.round(sharedWeeklyPct)) : null,
                sharedWeeklyResetsAt: sharedWeeklyPct !== null ? sharedWeeklyResetsAt : null,
                geminiFiveHourPercent: gem5hPct !== null ? Math.round(gem5hPct) : null,
                geminiFiveHourResetsAt: gem5hPct !== null ? gem5hResetsAt : null,
                sharedFiveHourPercent: shared5hPct !== null ? Math.round(shared5hPct) : null,
                sharedFiveHourResetsAt: shared5hPct !== null ? shared5hResetsAt : null,
                source,
                observedAt,
                errorStatus,
            };
        }
        const used = gemWeeklyPct / 100;
        const usedPercent = Math.round(gemWeeklyPct);
        const leftPercent = Math.max(0, 100 - usedPercent);
        const limited = gemWeeklyPct >= 100;
        return {
            provider: 'antigravity',
            state: limited ? 'limit' : 'level',
            level: limited ? 0 : quotaPillarLevel(1 - used),
            used,
            usedPercent,
            leftPercent,
            resetsAt: gemWeeklyResetsAt,
            sharedWeeklyUsedPercent: sharedWeeklyPct !== null ? Math.round(sharedWeeklyPct) : null,
            sharedWeeklyLeftPercent: sharedWeeklyPct !== null ? Math.max(0, 100 - Math.round(sharedWeeklyPct)) : null,
            sharedWeeklyResetsAt: sharedWeeklyPct !== null ? sharedWeeklyResetsAt : null,
            geminiFiveHourPercent: gem5hPct !== null ? Math.round(gem5hPct) : null,
            geminiFiveHourResetsAt: gem5hPct !== null ? gem5hResetsAt : null,
            sharedFiveHourPercent: shared5hPct !== null ? Math.round(shared5hPct) : null,
            sharedFiveHourResetsAt: shared5hPct !== null ? shared5hResetsAt : null,
            source,
            observedAt,
            errorStatus,
        };
    }

    // Extensible fallback for any future Nth provider registered in QUOTA_TERRACE_PROVIDERS.
    const raw = usage?.[provider];
    const weekly = raw?.weekly || raw;
    const resetsAt = parseResetTimestamp(weekly?.resetsAt);
    const pct = !isExpired(resetsAt, now) ? clampPercent(weekly?.usedPercent) : null;
    if (pct === null) {
        return {
            provider,
            state: 'unknown',
            level: null,
            used: null,
            usedPercent: null,
            leftPercent: null,
            resetsAt: null,
            observedAt: parseResetTimestamp(raw?.observedAt),
            errorStatus: Number(raw?.error?.status) || null,
        };
    }
    const used = pct / 100;
    const usedPercent = Math.round(pct);
    const limited = raw?.limitReached === true || pct >= 100;
    return {
        provider,
        state: limited ? 'limit' : 'level',
        level: limited ? 0 : quotaPillarLevel(1 - used),
        used,
        usedPercent,
        leftPercent: Math.max(0, 100 - usedPercent),
        resetsAt,
        observedAt: parseResetTimestamp(raw?.observedAt),
        errorStatus: Number(raw?.error?.status) || null,
    };
}

/** Readings for every configured provider pillar. */
export function quotaPillarReadings(usage, now = Date.now(), providers = QUOTA_TERRACE_PROVIDERS) {
    const out = {};
    for (const provider of providers) out[provider] = quotaPillarReading(provider, usage, now);
    return out;
}

/**
 * MB-5 — active-spend drain tracker across every configured provider:
 * per provider `{ used, roseAt }`. A rising `used` sets `roseAt = now`;
 * an equal reading keeps it; a falling reading (window reset) or unknown clears it.
 */
export function quotaDrainStep(previous, readings, now, providers = QUOTA_TERRACE_PROVIDERS) {
    const next = {};
    for (const provider of providers) {
        const prior = previous?.[provider];
        const reading = readings?.[provider];
        const used = reading?.state === 'level' && Number.isFinite(reading.used) ? reading.used : null;
        const before = Number.isFinite(prior?.used) ? prior.used : null;
        let roseAt = Number.isFinite(prior?.roseAt) ? prior.roseAt : null;
        if (used === null || (before !== null && used < before)) roseAt = null;
        else if (before !== null && used > before) roseAt = now;
        next[provider] = { used, roseAt };
    }
    return next;
}

/** Whether a provider's pillar runs its 2 fps spend trickle at `now`. */
export function quotaDraining(drain, provider, now) {
    const roseAt = drain?.[provider]?.roseAt;
    return Number.isFinite(roseAt) && now >= roseAt && now - roseAt < QUOTA_PILLAR_DRAIN_MS;
}

/** Drawn strip state key for one reading: `l0`–`l5`, `limit`, or `unknown`. */
export function quotaPillarKey(reading) {
    if (reading?.state === 'limit') return 'limit';
    if (reading?.state !== 'level' || !Number.isFinite(reading.level)) return 'unknown';
    return `l${reading.level}`;
}

/**
 * Crisp 2-line WorldHoverPlate text for a single pillar (`line1\nline2`).
 * Never exceeds two lines so `hoverPlateLines()` never folds or truncates awkwardly.
 */
export function quotaPillarTooltip(provider, usage, now = Date.now()) {
    const r = quotaPillarReading(provider, usage, now);
    const title = quotaProviderWeeklyTitle(provider);

    if (r.state === 'unknown') {
        const reason = errorReasonText(r.errorStatus, { provider });
        if (reason) return `${title} · Unavailable\n${reason}`;
        if (provider === 'codex' && r.windowReset) {
            return `${title} · Unavailable\nWindow reset · no new reading yet`;
        }
        if (provider === 'claude' && r.fiveHourPercent !== null) {
            return `${title} · Unavailable\n5h: ${r.fiveHourPercent}% used · no weekly reading yet`;
        }
        return `${title} · Unavailable\nNo local quota observed yet`;
    }

    const line1 = r.state === 'limit'
        ? `${title} · Limit reached`
        : `${title} · ${r.leftPercent}% left`;

    const parts = [];
    const reset = formatQuotaCountdown(r.resetsAt, now);

    if (provider === 'claude') {
        if (reset) parts.push(`Resets in ${reset}`);
        if (r.fiveHourPercent !== null) parts.push(`5h: ${r.fiveHourPercent}% used`);
        if (r.errorStatus === 429) parts.push('Throttled (429)');
        else if (!parts.length) parts.push(`${r.usedPercent}% used`);
    } else if (provider === 'codex') {
        if (reset) parts.push(`Resets in ${reset}`);
        if (r.credits?.unlimited) parts.push('Unlimited credits');
        else if (Number.isFinite(r.credits?.balance)) parts.push(`Credits ${formatNumber(Math.round(r.credits.balance))}`);
        else {
            const change = formatCreditChange(r.creditChange, { short: true });
            if (change) parts.push(change);
            else if (r.observedAt) parts.push(`Seen ${formatWaitAge(now - r.observedAt)} ago`);
            else if (!parts.length) parts.push(`${r.usedPercent}% used`);
        }
    } else if (provider === 'glm') {
        if (reset) parts.push(`Resets in ${reset}`);
        if (r.fiveHourPercent !== null) parts.push(`5h: ${r.fiveHourPercent}% used`);
        else if (r.plan) parts.push(r.plan);
        else if (!parts.length) parts.push(`${r.usedPercent}% used`);
        if (r.errorStatus === 429) parts.push('Throttled');
    } else if (provider === 'antigravity') {
        if (r.sharedWeeklyLeftPercent !== null) parts.push(`3P shared ${r.sharedWeeklyLeftPercent}% left`);
        if (reset) parts.push(`Resets in ${reset}`);
        else if (r.geminiFiveHourPercent !== null) parts.push(`5h: ${r.geminiFiveHourPercent}% used`);
        else if (!parts.length) parts.push(`${r.usedPercent}% used`);
    } else {
        if (reset) parts.push(`Resets in ${reset}`);
        if (!parts.length) parts.push(`${r.usedPercent}% used`);
    }

    return `${line1}\n${parts.join(' · ')}`;
}
