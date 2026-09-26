// The urgency ladder (plan 3.3, SIG-2, D6): an unanswered wait is reminded,
// then insisted on, then escalated — slowly, capped, village-aggregated — and
// stops climbing the moment the operator acknowledges it. Pure: the caller
// (the controller's 1 Hz signal route) owns the clock, the acknowledgements,
// the reminder history and the presence reading, and plays what this returns.
//
// Schedule (Standard, D6), measured on the oldest unacknowledged agent's
// wait: L1 is the entry cue itself (played by the directors on
// `attention:raised`, never by the ladder); L2 at 2 min, L3 at 6, L4 at 15 and
// 30, then one L2 every 30 min until acknowledged. `needsYou` climbs to L4,
// `errors` holds at L3, `quota` stops after its one L2. Gentle plays every
// step as L2; Off plays none. A step that falls due while a cap, the
// operator's attention or an acknowledgement holds it is deferred (caps,
// focus) or consumed (acknowledgement) — never queued behind another.

import { bucketForStatus, isActionableBucket, waitAnchor } from '../../../domain/services/SignalLedger.js';

const MINUTE_MS = 60_000;

export const LADDER_STEPS = Object.freeze([
    Object.freeze({ atMs: 2 * MINUTE_MS, level: 2 }),
    Object.freeze({ atMs: 6 * MINUTE_MS, level: 3 }),
    Object.freeze({ atMs: 15 * MINUTE_MS, level: 4 }),
    Object.freeze({ atMs: 30 * MINUTE_MS, level: 4 }),
]);
// After the second L4: one L2 every 30 min (S7).
export const LADDER_REPEAT_MS = 30 * MINUTE_MS;
export const LADDER_REPEAT_LEVEL = 2;

// The highest level each family reaches, and whether it repeats after its
// steps. The most urgent family present chooses the voice.
export const FAMILY_RULES = Object.freeze({
    needsYou: Object.freeze({ maxLevel: 4, steps: LADDER_STEPS.length, repeats: true }),
    errors: Object.freeze({ maxLevel: 3, steps: LADDER_STEPS.length, repeats: true }),
    quota: Object.freeze({ maxLevel: 2, steps: 1, repeats: false }),
});
const FAMILY_ORDER = Object.freeze(['needsYou', 'errors', 'quota']);

// S7 budgets, village-wide. The governor applies the same caps to the
// `reminder` kind as a backstop.
export const REMINDER_CAPS = Object.freeze({ minGapMs: 120_000, perHour: 12, windowMs: 60 * MINUTE_MS });

// An acknowledgement (selection, `A` traversal) quiets that agent this long;
// steps that fall due inside it are consumed, not caught up afterwards.
export const ACK_QUIET_MS = 10 * MINUTE_MS;

// The operator is demonstrably looking: the window is visible and focused
// and the last pointer or key input was this recent. Reminders wait until
// the input has been idle this long (SIG-2); an entry cue plays the L2 voice
// instead of L1 inside the shorter window (S7).
export const FOCUS_IDLE_MS = 15_000;
export const LOOKING_L1_IDLE_MS = 10_000;

export const REMINDER_SETTINGS = Object.freeze(['standard', 'gentle', 'off']);

export function isOperatorLooking(presence, now, idleMs = FOCUS_IDLE_MS) {
    if (!presence || presence.visible === false || presence.focused === false) return false;
    const last = Number(presence.lastInputAt);
    return Number.isFinite(last) && last > 0 && now - last < idleMs;
}

function stepAt(index, family) {
    const rule = FAMILY_RULES[family];
    if (index < rule.steps) return LADDER_STEPS[index].atMs;
    if (!rule.repeats) return null;
    const last = LADDER_STEPS[LADDER_STEPS.length - 1].atMs;
    return last + (index - LADDER_STEPS.length + 1) * LADDER_REPEAT_MS;
}

function stepLevel(index, family, setting) {
    if (setting === 'gentle') return 2;
    const base = index < LADDER_STEPS.length ? LADDER_STEPS[index].level : LADDER_REPEAT_LEVEL;
    return Math.min(base, FAMILY_RULES[family].maxLevel);
}

// The index of the latest step due at `waitMs` (−1 before the first).
function latestStepIndex(waitMs, family) {
    const rule = FAMILY_RULES[family];
    let index = -1;
    for (let i = 0; i < rule.steps; i++) if (LADDER_STEPS[i].atMs <= waitMs) index = i;
    if (!rule.repeats || index < rule.steps - 1) return index;
    const last = LADDER_STEPS[LADDER_STEPS.length - 1].atMs;
    return index + Math.max(0, Math.floor((waitMs - last) / LADDER_REPEAT_MS));
}

function ackFor(acks, agentId) {
    const value = acks instanceof Map ? acks.get(agentId) : acks?.[agentId];
    const at = Number(value);
    return Number.isFinite(at) ? at : null;
}

// An acknowledgement belongs to this wait only if it came after the wait began.
function ackOfWait(acks, agent, anchor) {
    const at = ackFor(acks, agent.id);
    return at !== null && at >= anchor ? at : null;
}

// Earliest time the S7 caps allow the next reminder. Dropped entries (a step
// spent inside an urgent guard) cover their step but never count.
function capRelease(history, now) {
    const heard = history.filter(entry => !entry.dropped && Number.isFinite(entry.at));
    let release = -Infinity;
    const last = heard.reduce((max, entry) => Math.max(max, entry.at), -Infinity);
    if (Number.isFinite(last)) release = last + REMINDER_CAPS.minGapMs;
    const inHour = heard
        .filter(entry => now - entry.at < REMINDER_CAPS.windowMs)
        .map(entry => entry.at)
        .sort((a, b) => a - b);
    if (inHour.length >= REMINDER_CAPS.perHour) {
        release = Math.max(release, inHour[inHour.length - REMINDER_CAPS.perHour] + REMINDER_CAPS.windowMs);
    }
    return release;
}

const NOTHING = Object.freeze({ level: 0, due: null, agentId: null, family: null, count: 0, oldestMs: 0 });

/**
 * The village ladder at `now` (ms).
 *
 * @param {number} now
 * @param {Array} agents audible (non-stale) agents; non-actionable ones are ignored
 * @param {Map|Object} acks agentId → ms of the latest acknowledgement
 * @param {{ reminders?: 'standard'|'gentle'|'off', presence?: { visible, focused, lastInputAt } }} settings
 * @param {Array<{ at: number, level?: number, dropped?: boolean }>} history reminders already spent this wait
 * @returns {{ level: number, due: number|null, agentId: *, family: string|null, count: number, oldestMs: number, stepAt?: number }}
 *   `level` > 0 names the pending reminder; play it when `due <= now`.
 */
export function next(now, agents, acks = new Map(), settings = {}, history = []) {
    const setting = REMINDER_SETTINGS.includes(settings?.reminders) ? settings.reminders : 'standard';
    const actionable = [];
    for (const agent of Array.isArray(agents) ? agents : []) {
        const family = bucketForStatus(agent?.status);
        const anchor = waitAnchor(agent);
        if (!isActionableBucket(family) || !(anchor > 0) || anchor > now) continue;
        actionable.push({ agent, family, anchor });
    }
    if (!actionable.length || setting === 'off') return { ...NOTHING, count: actionable.length };

    const unacked = actionable.filter(({ agent, anchor }) => {
        const ack = ackOfWait(acks, agent, anchor);
        return ack === null || now >= ack + ACK_QUIET_MS;
    });
    if (!unacked.length) return { ...NOTHING, count: actionable.length };

    unacked.sort((a, b) => a.anchor - b.anchor || String(a.agent.id).localeCompare(String(b.agent.id)));
    const oldest = unacked[0];
    const family = FAMILY_ORDER.find(name => unacked.some(entry => entry.family === name));
    const base = {
        agentId: oldest.agent.id ?? null,
        family,
        count: actionable.length,
        oldestMs: now - oldest.anchor,
    };

    const spent = Array.isArray(history) ? history : [];
    const lastSpent = spent.reduce((max, entry) => Math.max(max, Number(entry?.at) || -Infinity), -Infinity);
    const ack = ackOfWait(acks, oldest.agent, oldest.anchor);
    // A step is spent when a reminder (for any agent: the ladder is the
    // village's) sounded after it fell due, or an acknowledgement covered it.
    const spentStep = (index) => {
        const at = oldest.anchor + stepAt(index, family);
        return lastSpent >= at || (ack !== null && at < ack + ACK_QUIET_MS);
    };

    let index = latestStepIndex(base.oldestMs, family);
    if (index < 0 || spentStep(index)) {
        // Nothing due now: name the next step.
        index += 1;
        while (stepAt(index, family) !== null && spentStep(index)) index += 1;
        if (stepAt(index, family) === null) return { ...NOTHING, ...base };
    }
    const stepTime = oldest.anchor + stepAt(index, family);
    const presence = settings?.presence;
    const focusRelease = isOperatorLooking(presence, now)
        ? Number(presence.lastInputAt) + FOCUS_IDLE_MS
        : -Infinity;
    const due = Math.max(stepTime, capRelease(spent, now), focusRelease);
    return { ...base, level: stepLevel(index, family, setting), due, stepAt: stepTime };
}
