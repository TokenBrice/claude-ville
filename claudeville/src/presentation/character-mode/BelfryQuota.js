// The Hourglass Belfry's reading of `/api/usage` (pure; the north shore's
// account instrument, IsleLandmarks.js). One glass per account: Claude in the
// lit west arch, Codex in the shaded east arch.
//
// - The sand left in a glass's upper bulb is the quota left in that account's
//   binding window, in five hard steps (`BELFRY_LEVELS`): Claude's fuller of
//   its 5-hour and 7-day windows (the old top-bar rule), Codex's window as the
//   server picks it.
// - A glass with no reading wears its shroud, never a fake 0 % or 100 %:
//   Claude before its first check, after a 401 or once the snapshot is 30
//   minutes old; Codex with no rate limits observed, or after its window reset
//   (the server then reports unknown until a rollout records a new reading).
// - Codex at its limit (`limitReached`) is the spent glass with the lavender
//   cord: an account state, calm (Q3), never the rate-limited alarm that
//   villagers wear. Claude reports no enforcement, so a full Claude window is
//   the spent glass and is never worded LIMIT.
// - MB-5 — a glass drains while its account spends: its reading's `used`
//   rose within the last BELFRY_DRAIN_MS (`belfryDrainStep`, fed each
//   reading; `belfryDraining`). A falling reading (a window reset) or no
//   reading drains nothing.

import { formatNumber, formatWaitAge } from '../shared/Formatters.js';

export const BELFRY_LEVELS = 5;
export const BELFRY_ACCOUNTS = Object.freeze(['claude', 'codex']);
export const BELFRY_DRAIN_MS = 10 * 60_000;

function ratio(value) {
    if (value === null || value === undefined || value === '') return null;
    const number = Number(value);
    return Number.isFinite(number) ? Math.min(1, Math.max(0, number)) : null;
}

/** Quota left (0–1) → sand level: 5 at ≥ 80 % left, then 4, 3, 2 by 20 % steps, 1 above 0, 0 when spent. */
export function belfryLevel(remaining) {
    const left = ratio(remaining);
    if (left === null || left <= 0) return 0;
    return Math.min(BELFRY_LEVELS, Math.floor(left * BELFRY_LEVELS) + 1);
}

/** `{ state: 'level' | 'limit' | 'unknown', level, used }` for one account; `level` is null while unknown. */
export function belfryGlass(account, usage) {
    if (account === 'codex') {
        const codex = usage?.codex;
        if (codex?.limitReached === true) return { state: 'limit', level: 0, used: 1 };
        const used = ratio(codex?.usedPercent === null || codex?.usedPercent === undefined ? null : Number(codex.usedPercent) / 100);
        if (used === null) return { state: 'unknown', level: null, used: null };
        return { state: 'level', level: belfryLevel(1 - used), used };
    }
    if (Number(usage?.quotaError?.status) === 401) return { state: 'unknown', level: null, used: null };
    const fiveHour = ratio(usage?.quota?.fiveHour);
    const sevenDay = ratio(usage?.quota?.sevenDay);
    if (fiveHour === null && sevenDay === null) return { state: 'unknown', level: null, used: null };
    const used = Math.max(fiveHour ?? 0, sevenDay ?? 0);
    return { state: 'level', level: belfryLevel(1 - used), used };
}

export function belfryGlasses(usage) {
    return { claude: belfryGlass('claude', usage), codex: belfryGlass('codex', usage) };
}

/**
 * MB-5 — the drain record after one more reading: per account `{ used,
 * roseAt }`, its last known `used` and when a reading last rose above the
 * one before it (`now`, ms). A fall or no reading clears the rise; an equal
 * reading keeps it.
 */
export function belfryDrainStep(previous, glasses, now) {
    const next = {};
    for (const account of BELFRY_ACCOUNTS) {
        const prior = previous?.[account];
        const glass = glasses?.[account];
        const used = glass?.state === 'level' && Number.isFinite(glass.used) ? glass.used : null;
        const before = Number.isFinite(prior?.used) ? prior.used : null;
        let roseAt = Number.isFinite(prior?.roseAt) ? prior.roseAt : null;
        if (used === null || (before !== null && used < before)) roseAt = null;
        else if (before !== null && used > before) roseAt = now;
        next[account] = { used, roseAt };
    }
    return next;
}

/** Whether an account's glass drains at `now`: its reading rose within BELFRY_DRAIN_MS. */
export function belfryDraining(drain, account, now) {
    const roseAt = drain?.[account]?.roseAt;
    return Number.isFinite(roseAt) && now >= roseAt && now - roseAt < BELFRY_DRAIN_MS;
}

/** A glass's drawn state as one key: `l0`–`l5`, `limit` or `unknown`. */
export function belfryGlassKey(glass) {
    if (glass?.state === 'limit') return 'limit';
    if (glass?.state !== 'level' || !Number.isFinite(glass.level)) return 'unknown';
    return `l${glass.level}`;
}

function percent(value) {
    return `${Math.round(value * 100)}%`;
}

function resetsIn(at, now) {
    const resetsAt = Number(at);
    return Number.isFinite(resetsAt) && resetsAt > 0 ? `, resets in ${formatWaitAge(resetsAt - now)}` : '';
}

function claudeLine(usage, now) {
    const status = Number(usage?.quotaError?.status);
    if (status === 401) return 'Claude: quota unknown, the sign-in token expired. Run claude to sign in again.';
    const quota = usage?.quota;
    const windows = [];
    const fiveHour = ratio(quota?.fiveHour);
    const sevenDay = ratio(quota?.sevenDay);
    if (fiveHour !== null) windows.push(`5-hour ${percent(fiveHour)} used${resetsIn(quota.fiveHourResetsAt, now)}`);
    if (sevenDay !== null) windows.push(`7-day ${percent(sevenDay)} used${resetsIn(quota.sevenDayResetsAt, now)}`);
    if (!windows.length) return 'Claude: no quota reading yet.';
    const throttled = status === 429 ? ' · the quota check is throttled, so this is the last reading' : '';
    return `Claude: ${windows.join(' · ')}${throttled}`;
}

function codexLine(usage, now) {
    const codex = usage?.codex;
    if (!codex) return 'Codex: no quota reading yet.';
    const minutes = Number(codex.windowMinutes);
    const span = minutes === 10080 ? 'weekly' : Number.isFinite(minutes) && minutes > 0 ? `${Math.round(minutes / 60)}-hour` : '';
    const parts = [];
    const limited = codex.limitReached === true;
    if (limited) parts.push(`at its ${span ? `${span} ` : ''}limit`);
    const used = Number(codex.usedPercent);
    if (codex.usedPercent !== null && codex.usedPercent !== undefined && Number.isFinite(used)) {
        parts.push(`${limited || !span ? '' : `${span} `}${Math.round(used)}% used${resetsIn(codex.resetsAt, now)}`);
    } else if (!limited) {
        parts.push('window reset, no new reading yet');
    }
    if (codex.credits?.unlimited === true) parts.push('unlimited credits');
    else if (Number.isFinite(codex.credits?.balance)) parts.push(`${formatNumber(Math.round(codex.credits.balance))} credits left`);
    if (Number.isFinite(codex.observedAt) && codex.observedAt > 0) parts.push(`seen ${formatWaitAge(now - codex.observedAt)} ago`);
    return `Codex: ${parts.join(' · ')}`;
}

/** The belfry's hover text at `now`: one line per account, exact numbers. */
export function belfryTooltip(usage, now = Date.now()) {
    return [
        'Hourglass Belfry · sand left = quota left',
        claudeLine(usage, now),
        codexLine(usage, now),
    ].join('\n');
}
