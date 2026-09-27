// Honest silence (plan S6, 3.7; SIG-9, SIG-15). One gate decides which agents
// a sound may follow — never a stale observation — and one small
// state machine decides whether the feed itself is live. The return digest's
// notes are derived here too, so the phrase and the toast read one summary.
// Pure and DOM-free: time is always passed in.

import { actionableAgents, bucketForStatus } from '../../../domain/services/SignalLedger.js';
import { resolveObservation } from '../../character-mode/ObservationCertainty.js';

// A feed that stays non-live this long is lost (SIG-9: reconnect flutter
// shorter than this is not news).
export const LINK_LOST_AFTER_MS = 10_000;

// The digest phrase (SIG-15): at most five notes, at most two per family —
// the ear hears "some", the toast holds the number.
export const DIGEST_MAX_NOTES = 5;
const DIGEST_FAMILY_MAX = 2;
// Past first, the open wait last (3.7): what shipped, what finished, what
// failed, then who is still waiting.
const DIGEST_ORDER = Object.freeze(['gold', 'stone', 'red', 'amber']);
// Over budget, the phrase gives up the least urgent news first; the open
// wait is never dropped.
const DIGEST_DROP_ORDER = Object.freeze(['stone', 'gold', 'red']);

export function isAudibleAgent(agent, now = Date.now()) {
    return Boolean(agent) && resolveObservation(agent, now).state !== 'stale';
}

function agentValues(source) {
    if (!source) return [];
    if (Array.isArray(source)) return source;
    if (source.agents) return agentValues(source.agents);
    if (typeof source.values === 'function') return [...source.values()];
    return [];
}

/**
 * The agents every sound mapping may follow: the World's (or a Map's,
 * or an array's) agents whose observation is not stale.
 */
export function audibleAgents(world, now = Date.now()) {
    return agentValues(world).filter(agent => isAudibleAgent(agent, now));
}

/**
 * The wait the signal route follows: audible actionable agents, the family
 * of the longest-waiting one, and how many actionable agents are stale (a
 * wait that only went stale was not answered).
 */
export function waitState(world, now = Date.now()) {
    const all = agentValues(world);
    const actionable = actionableAgents(all);
    const heard = actionable.filter(agent => isAudibleAgent(agent, now));
    return {
        waiting: heard.length,
        unheard: actionable.length - heard.length,
        family: heard.length ? bucketForStatus(heard[0]?.status) : null,
    };
}

function count(value) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}

// The digest counts, read the way AttentionService's formatter reads them:
// unresolved counts first, then the flat summary, then its routine block.
function digestCount(summary, field, fallback = null) {
    const unresolved = summary?.unresolved?.[field];
    if (unresolved != null) return count(unresolved);
    if (summary?.[field] != null) return count(summary[field]);
    if (summary?.routine?.[field] != null) return count(summary.routine[field]);
    return fallback ? count(summary?.[fallback]) : 0;
}

/**
 * The notes of the return phrase for an `attention:digest` payload (or its
 * summary): gold for commits, pushes and releases, stone for finished turns,
 * red for errors, amber for anyone still waiting (a person or a quota). An
 * empty summary is no phrase.
 */
export function digestNotes(payload) {
    const summary = payload?.summary ?? payload;
    const families = {
        gold: digestCount(summary, 'pushes') + digestCount(summary, 'commits') + digestCount(summary, 'releases'),
        stone: digestCount(summary, 'completed'),
        red: digestCount(summary, 'errorAgentCount', 'errors'),
        amber: digestCount(summary, 'waitingAgents', 'waits') + digestCount(summary, 'rateLimitAgentCount', 'rateLimits'),
    };
    const notes = {};
    let total = 0;
    for (const family of DIGEST_ORDER) {
        notes[family] = Math.min(DIGEST_FAMILY_MAX, families[family]);
        total += notes[family];
    }
    for (const family of DIGEST_DROP_ORDER) {
        while (total > DIGEST_MAX_NOTES && notes[family] > 0) {
            notes[family] -= 1;
            total -= 1;
        }
    }
    return DIGEST_ORDER.flatMap(family => Array(notes[family]).fill(family));
}

/**
 * Link health from the feed's own vocabulary (never reinterpreted): the
 * socket is live when `ws:state` says so; the polling fallback is live while
 * its last poll succeeded. `linkLost` is due once the feed has been non-live
 * for `lostAfterMs` without a break, and only after it was ever live (a cold
 * start is not a loss); `linkRestored` answers it when the feed returns.
 */
export class LinkHealth {
    constructor({ lostAfterMs = LINK_LOST_AFTER_MS } = {}) {
        this.lostAfterMs = lostAfterMs;
        this._socketLive = false;
        this._pollLive = false;
        this._everLive = false;
        this._nonLiveSince = null;
        this.lost = false;
    }

    get live() {
        return this._socketLive || this._pollLive;
    }

    /**
     * Folds one feed event in. Returns `'restored'` when it ends a loss,
     * else null; a loss is only ever declared by `check`.
     */
    observe(event, payload = {}, now = Date.now()) {
        if (event === 'ws:state') this._socketLive = payload?.state === 'live';
        else if (event === 'ws:disconnected') this._socketLive = false;
        else if (event === 'watcher:state') {
            if (payload?.ok === true) this._pollLive = true;
            else if (payload?.ok === false || payload?.state != null) this._pollLive = false;
        } else return null;

        if (this.live) {
            this._everLive = true;
            this._nonLiveSince = null;
            if (!this.lost) return null;
            this.lost = false;
            return 'restored';
        }
        if (this._everLive && this._nonLiveSince == null) this._nonLiveSince = now;
        return null;
    }

    /** When `check` would next declare the loss, or null. */
    dueAt() {
        if (this.lost || this._nonLiveSince == null) return null;
        return this._nonLiveSince + this.lostAfterMs;
    }

    /** Returns `'lost'` once, when the feed has been non-live long enough. */
    check(now = Date.now()) {
        const due = this.dueAt();
        if (due == null || now < due) return null;
        this.lost = true;
        return 'lost';
    }

    snapshot(now = Date.now()) {
        return {
            live: this.live,
            lost: this.lost,
            nonLiveMs: this._nonLiveSince == null ? 0 : Math.max(0, now - this._nonLiveSince),
        };
    }
}
