// Actionable signal routing, shared by both directors. An agent entering an
// actionable bucket reaches the audio layer through two events — the
// renderer's `distress:watchtower` and AttentionService's `attention:raised` —
// in whichever order their subscribers happen to run. The voice is chosen from
// the agent's bucket, never from the event that arrived first, and one entry
// spends one cue: the first event is heard and the second is deduped.

import { bucketForStatus } from '../../../domain/services/SignalLedger.js';

export const ACTIONABLE_CUE_DEDUPE_MS = 2500;

const CUE_KIND_BY_BUCKET = Object.freeze({
    needsYou: 'summons',
    errors: 'distress',
    quota: 'limit',
});

// Bounds the per-agent memory in a long-running village; expired entries are
// pruned only when it grows past this, so the steady state costs nothing.
const MAX_REMEMBERED_AGENTS = 128;

/**
 * The cue kind of an actionable status. A summons is the fallback because an
 * `attention:raised` from an older producer may omit its status, and it is
 * still a request for the operator.
 */
export function actionableCueKind(status) {
    return CUE_KIND_BY_BUCKET[bucketForStatus(status)] || 'summons';
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
     * Picks `summons | distress | limit` from the status and hands it to
     * `play(kind)`. Returns false without calling `play` when the agent was
     * already heard inside the dedupe window; the window starts only when
     * `play` reports that the cue was accepted.
     */
    route({ agentId = null, status = null } = {}, play) {
        const id = agentId === '' ? null : agentId;
        if (id != null && this._isRecent(id)) return false;
        const played = Boolean(play(actionableCueKind(status)));
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
