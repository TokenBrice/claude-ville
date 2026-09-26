// Cue routing shared by both directors. An agent entering an actionable
// bucket reaches the audio layer through two events — the renderer's
// `distress:watchtower` and AttentionService's `attention:raised` — in
// whichever order their subscribers happen to run. The voice is chosen from
// the agent's bucket (its family), never from the event that arrived first,
// and one entry spends one cue: the first event is heard and the second is
// deduped. The ladder's reminders and the Signals `answered` strike keep the
// family of the wait they belong to (plan 3.3). The hour chime's schedule
// (plan 3.6, D7) lives here too, so both presets ring the same hours.

import { bucketForStatus } from '../../../domain/services/SignalLedger.js';

export const ACTIONABLE_CUE_DEDUPE_MS = 2500;

const CUE_KIND_BY_FAMILY = Object.freeze({
    needsYou: 'summons',
    errors: 'distress',
    quota: 'limit',
});

// Bounds the per-agent memory in a long-running village; expired entries are
// pruned only when it grows past this, so the steady state costs nothing.
const MAX_REMEMBERED_AGENTS = 128;

// D7: the phrase from 07:00 to 20:00, one soft chime at 21:00, none at night.
const HOUR_CHIME_FIRST = 7;
const HOUR_CHIME_LAST = 20;
const HOUR_CHIME_SOFT = 21;

/**
 * The actionable family (SignalLedger bucket) of a status. A request for the
 * operator is the fallback because an `attention:raised` from an older
 * producer may omit its status, and it is still a request.
 */
export function actionableFamily(status) {
    const bucket = bucketForStatus(status);
    return CUE_KIND_BY_FAMILY[bucket] ? bucket : 'needsYou';
}

/** The entry voice of a family: `summons | distress | limit`. */
export function familyCueKind(family) {
    return CUE_KIND_BY_FAMILY[family] || 'summons';
}

/**
 * A ladder reminder or the `answered` strike as a cue payload: the family is
 * the wait's own (an unknown family is a request for the operator) and
 * `voice` names the entry voice it must sound like.
 */
export function familyCuePayload(signal = {}) {
    const family = CUE_KIND_BY_FAMILY[signal?.family] ? signal.family : 'needsYou';
    return { ...signal, family, voice: familyCueKind(family) };
}

/**
 * The hour chime a local clock reading asks for, or null: on the hour, the
 * phrase by day, a soft chime at 21:00, nothing at night.
 */
export function hourChimeFor(clock = {}) {
    const hours = Number(clock?.hours);
    if (Number(clock?.minutes) !== 0 || !Number.isInteger(hours)) return null;
    if (hours >= HOUR_CHIME_FIRST && hours <= HOUR_CHIME_LAST) return { hour: hours, soft: false };
    if (hours === HOUR_CHIME_SOFT) return { hour: hours, soft: true };
    return null;
}

/** The status an `attention:raised` payload describes, else the world's. */
export function attentionStatus(payload, world = null) {
    const agentId = payload?.agentId ?? payload?.agent?.id ?? null;
    return payload?.status
        || payload?.agent?.status
        || world?.agents?.get?.(agentId)?.status
        || null;
}

export class ActionableCueRouter {
    constructor({ dedupeMs = ACTIONABLE_CUE_DEDUPE_MS } = {}) {
        this.dedupeMs = dedupeMs;
        this._recent = new Map();
    }

    /**
     * Picks `summons | distress | limit` from the status and hands it, with
     * its family, to `play(kind, family)`. Returns false without calling
     * `play` when the agent was already heard inside the dedupe window; the
     * window starts only when `play` reports that the cue was accepted.
     */
    route({ agentId = null, status = null } = {}, play) {
        const id = agentId === '' ? null : agentId;
        if (id != null && this._isRecent(id)) return false;
        const family = actionableFamily(status);
        const played = Boolean(play(familyCueKind(family), family));
        if (played && id != null) this._remember(id);
        return played;
    }

    /** A recovered agent may be heard again at once if it fails again. */
    forget(agentId) {
        this._recent.delete(agentId);
    }

    clear() {
        this._recent.clear();
    }

    _isRecent(agentId) {
        const at = this._recent.get(agentId);
        if (at == null) return false;
        if (Date.now() - at < this.dedupeMs) return true;
        this._recent.delete(agentId);
        return false;
    }

    _remember(agentId) {
        const now = Date.now();
        this._recent.set(agentId, now);
        if (this._recent.size <= MAX_REMEMBERED_AGENTS) return;
        for (const [id, at] of this._recent) {
            if (now - at >= this.dedupeMs) this._recent.delete(id);
        }
    }
}
