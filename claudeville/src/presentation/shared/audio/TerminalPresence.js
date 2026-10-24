// Answering in the terminal counts as presence (SND-4). ClaudeVille often
// sits on a second monitor that is never focused, so "the window is focused
// and touched" (UrgencyLadder.isOperatorLooking) misses an operator who is
// plainly at work: approving prompts and typing turns in the session's own
// terminal. The session data already shows it, as two observed transitions:
//
//   - a prompt answered: the agent leaves the needs-you bucket for work;
//   - a new user turn: `turnStartedAt` (the adapters' last real user message,
//     never a tool result) moves to a recent, later time.
//
// Either marks that session's operator present for TERMINAL_PRESENCE_MS, and
// that session's next entry call rings in the softer L2 voice (the ladder's
// "looking" voice, S7). Only that session: answering one terminal says
// nothing about another. It never silences a call. Sub-agents are driven by
// their parent, not a person, and a stale observation is no evidence.
// Pure and DOM-free: time and audibility come in.

import { bucketForStatus } from '../../../domain/services/SignalLedger.js';

export const TERMINAL_PRESENCE_MS = 90_000;
const MEMORY_LIMIT = 256;

function finite(value) {
    const number = Number(value);
    return value != null && Number.isFinite(number) ? number : null;
}

function remember(map, key, value) {
    map.delete(key);
    map.set(key, value);
    while (map.size > MEMORY_LIMIT) map.delete(map.keys().next().value);
}

export class TerminalPresence {
    constructor() {
        this._seen = new Map();
        this._actedAt = new Map();
    }

    /**
     * Record one agent observation; returns the time of the operator's act
     * it shows (ms), or null. The first sight of an agent is a baseline.
     */
    observe(agent, now = Date.now(), { audible = true } = {}) {
        const id = agent?.id == null || agent.id === '' ? null : String(agent.id);
        if (id == null) return null;
        const previous = this._seen.get(id) ?? null;
        const next = { bucket: bucketForStatus(agent.status), turnStartedAt: finite(agent.turnStartedAt) };
        remember(this._seen, id, next);
        if (!previous || !audible || agent.parentSessionId) return null;
        let at = null;
        if (previous.bucket === 'needsYou' && next.bucket === 'working') at = now;
        const started = next.turnStartedAt;
        if (started != null
            && (previous.turnStartedAt == null || started > previous.turnStartedAt)
            && now - started < TERMINAL_PRESENCE_MS) {
            at = Math.max(at ?? -Infinity, Math.min(now, started));
        }
        if (at != null) remember(this._actedAt, id, at);
        return at;
    }

    forget(agentId) {
        const id = agentId == null ? null : String(agentId);
        this._seen.delete(id);
        this._actedAt.delete(id);
    }

    /** Whether this session's operator acted in its terminal just now. */
    actedRecently(agentId, now = Date.now()) {
        const at = this._actedAt.get(agentId == null ? null : String(agentId));
        return at != null && now - at < TERMINAL_PRESENCE_MS;
    }

    /** Sessions whose operator is present now (diagnostics). */
    present(now = Date.now()) {
        return [...this._actedAt.keys()].filter(id => this.actedRecently(id, now));
    }

    clear() {
        this._seen.clear();
        this._actedAt.clear();
    }
}
