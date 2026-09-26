// Outcomes the operator can hear (plan 3.4; C4, SIG-6, SIG-14): what the
// World model's own transitions say finished — a long turn ending, a
// sub-agent returning to its parent, a fan of sub-agents dispatched — plus
// the one routing policy both audio directors share: which facts are gated
// per agent, which a release absorbs, and which aggregate over a short
// window into one fact with an exact count.
//
// Everything here reads the World model (`agent:added/updated/removed`
// payloads), so it works in Dashboard, where the renderer's event stream
// (`subagent:*`, `tool:result`) never runs. It knows nothing of audio; the
// directors turn its facts into cues. Time and timers are injected.

import { AgentStatus } from '../domain/value-objects/AgentStatus.js';

// Short turns are chatter (SIG-6): only a turn this long is an outcome.
export const TURN_OUTCOME_MIN_MS = 20_000;
// Minor facts that land together are one fact with a count ("4 turns finished").
export const OUTCOME_AGGREGATE_MS = 1_500;
// A failing command loop is one fact per agent per this span, not a clank per exit.
export const TOOL_FAILED_AGENT_GAP_MS = 30_000;
// A release absorbs its own push (S6, C-SCN-7) arriving this close after it.
export const RELEASE_ABSORBS_PUSH_MS = 10_000;
// A child first seen longer idle than this was dispatched before we looked.
export const DISPATCH_FRESH_MS = 30_000;

// Held for the window and emitted once with a count; everything else is
// emitted at once (a release is its own ceremony; a failed push is news now).
const AGGREGATED_KINDS = new Set(['turnDone', 'subagentReturn', 'toolFailed', 'commit', 'push', 'dispatch']);
const TURN_END_STATUSES = new Set([
    AgentStatus.IDLE,
    AgentStatus.WAITING,
    AgentStatus.WAITING_ON_USER,
    AgentStatus.COMPLETED,
]);
const VERIFIED_KINDS = new Set(['commit', 'push', 'release']);
const MEMORY_LIMIT = 256;

function finite(value) {
    const number = Number(value);
    return value != null && Number.isFinite(number) ? number : null;
}

function idOf(value) {
    return value == null || value === '' ? null : String(value);
}

function remember(map, key, value) {
    map.delete(key);
    map.set(key, value);
    while (map.size > MEMORY_LIMIT) map.delete(map.keys().next().value);
}

function turnSnapshot(agent) {
    return {
        status: String(agent?.status || '').toLowerCase(),
        turnStartedAt: finite(agent?.turnStartedAt),
        lastTurnDurationMs: finite(agent?.lastTurnDurationMs),
        parentId: idOf(agent?.parentSessionId),
    };
}

function turnKey(snapshot) {
    return `${snapshot.turnStartedAt ?? ''}:${snapshot.lastTurnDurationMs ?? ''}`;
}

/**
 * A long turn ended: the agent was working and now rests, and the provider
 * reports a finished turn of at least `TURN_OUTCOME_MIN_MS` that was not
 * already reported. A sub-agent's end is its return, not a turn.
 */
export function turnEndOutcome(previous, agent, { reportedKey = null } = {}) {
    if (previous?.status !== AgentStatus.WORKING) return null;
    const next = turnSnapshot(agent);
    if (next.parentId || !TURN_END_STATUSES.has(next.status)) return null;
    if (next.lastTurnDurationMs == null || next.lastTurnDurationMs < TURN_OUTCOME_MIN_MS) return null;
    if (reportedKey != null && reportedKey === turnKey(next)) return null;
    return { kind: 'turnDone', agentId: idOf(agent?.id), durationMs: next.lastTurnDurationMs };
}

/** `outcome:verified` → its outcome fact; gold is never inferred elsewhere. */
export function verifiedOutcomeFact(outcome) {
    const kind = outcome?.kind;
    if (!VERIFIED_KINDS.has(kind)) return null;
    return {
        kind,
        agentId: idOf(outcome.agentId),
        repo: outcome.project && outcome.project !== 'unknown' ? String(outcome.project) : null,
        version: outcome.version ?? outcome.tag ?? null,
    };
}

/** `tool:result`: a non-zero exit is a failure; exit 0 (or none) is silent. */
export function toolFailedFact(event) {
    const exitCode = finite(event?.exitCode);
    if (exitCode == null || exitCode === 0) return null;
    return {
        kind: 'toolFailed',
        agentId: idOf(event.agentId),
        tool: event.tool ?? null,
        building: event.building ?? null,
    };
}

function repoKey(repo) {
    return String(repo?.project ?? repo?.repoName ?? repo?.shortName ?? '') + '\u0000' + String(repo?.branch ?? '');
}

/**
 * `harbor:updated` repo summaries → failed pushes: a repo whose
 * `failedPushes` grew since the last summary. The first summary is a
 * baseline (a failure already docked when we looked is not news).
 */
export function failedPushFacts(previous, repos) {
    const next = new Map();
    const facts = [];
    for (const repo of Array.isArray(repos) ? repos : []) {
        const key = repoKey(repo);
        const failed = Math.max(0, finite(repo?.failedPushes) ?? 0);
        next.set(key, failed);
        if (previous && failed > (previous.get(key) ?? 0)) {
            facts.push({
                kind: 'pushFailed',
                agentId: idOf(repo?.agentId),
                repo: repo?.shortName || repo?.repoName || repo?.project || null,
                building: 'harbor',
            });
        }
    }
    return { facts, state: next };
}

function childIsFresh(agent, now) {
    const age = finite(agent?.activityAgeMs);
    if (age != null) return age <= DISPATCH_FRESH_MS;
    const last = finite(agent?.lastSessionActivity);
    if (last != null && last > 1e11) return now - last <= DISPATCH_FRESH_MS;
    return true;
}

/**
 * Derives turn ends, dispatches and returns from World-model transitions.
 * `isAudible(agent)` keeps stale observations silent; `hasAgent(id)` asks
 * the World whether a parent is present. A child is dispatched or returns
 * once, whichever source (World model or the renderer's `subagent:*`)
 * reports it first.
 */
export class OutcomeTracker {
    constructor({ hasAgent = () => false, isAudible = () => true, now = () => Date.now() } = {}) {
        this._hasAgent = hasAgent;
        this._isAudible = isAudible;
        this._now = now;
        this._agents = new Map();
        this._reportedTurn = new Map();
        this._dispatched = new Set();
        this._returned = new Set();
    }

    /** Record agents already present without reporting anything about them. */
    prime(agents) {
        for (const agent of agents || []) {
            const id = this._record(agent);
            if (id != null && agent?.parentSessionId) this._mark(this._dispatched, id);
        }
    }

    added(agent) {
        const id = this._record(agent);
        if (id == null) return [];
        const parentId = idOf(agent?.parentSessionId);
        if (!parentId || !this._isAudible(agent) || !childIsFresh(agent, this._now())) return [];
        return this.dispatched({ parentId, childId: id });
    }

    // A turn the provider already reported when we first saw the agent is
    // history, not an outcome: only a later, different turn is.
    _record(agent) {
        const id = idOf(agent?.id);
        if (id == null) return null;
        const snapshot = turnSnapshot(agent);
        remember(this._agents, id, snapshot);
        if (snapshot.lastTurnDurationMs != null) remember(this._reportedTurn, id, turnKey(snapshot));
        return id;
    }

    updated(agent) {
        const id = idOf(agent?.id);
        if (id == null) return [];
        const previous = this._agents.get(id) ?? null;
        if (!previous) {
            this._record(agent);
            return [];
        }
        const next = turnSnapshot(agent);
        remember(this._agents, id, next);
        if (!this._isAudible(agent)) return [];
        const outcome = turnEndOutcome(previous, agent, { reportedKey: this._reportedTurn.get(id) ?? null });
        if (!outcome) return [];
        remember(this._reportedTurn, id, turnKey(next));
        return [outcome];
    }

    removed(agent) {
        const id = idOf(agent?.id);
        if (id == null) return [];
        const previous = this._agents.get(id);
        this._agents.delete(id);
        this._reportedTurn.delete(id);
        const parentId = idOf(agent?.parentSessionId) ?? previous?.parentId ?? null;
        if (!parentId || !this._isAudible(agent)) return [];
        return this.completed({ parentId, childId: id });
    }

    /** `subagent:dispatched` or a fresh child in the World model. */
    dispatched({ parentId = null, childId = null } = {}) {
        const parent = idOf(parentId);
        const child = idOf(childId);
        if (!parent || !child || this._dispatched.has(child) || !this._hasAgent(parent)) return [];
        this._mark(this._dispatched, child);
        return [{ kind: 'dispatch', agentId: parent, childId: child }];
    }

    /** `subagent:completed` or a child leaving the World model. */
    completed({ parentId = null, childId = null } = {}) {
        const parent = idOf(parentId);
        const child = idOf(childId);
        if (!parent || !child || this._returned.has(child) || !this._hasAgent(parent)) return [];
        this._mark(this._returned, child);
        return [{ kind: 'subagentReturn', agentId: parent, childId: child }];
    }

    clear() {
        this._agents.clear();
        this._reportedTurn.clear();
        this._dispatched.clear();
        this._returned.clear();
    }

    _mark(set, id) {
        set.delete(id);
        set.add(id);
        while (set.size > MEMORY_LIMIT) set.delete(set.values().next().value);
    }
}

function aggregateKey(fact) {
    if (fact.kind === 'dispatch') return `dispatch:${fact.agentId ?? ''}`;
    if (fact.kind === 'push') return `push:${fact.repo ?? ''}`;
    return fact.kind;
}

function single(values) {
    const unique = [...new Set(values.filter(value => value != null))];
    return unique.length === 1 ? unique[0] : null;
}

/** One emitted outcome for a batch of same-key facts, with its exact count. */
export function summarizeOutcomes(facts) {
    const first = facts[0];
    const agentIds = [...new Set(facts.map(fact => fact.agentId).filter(id => id != null))];
    return {
        kind: first.kind,
        count: facts.length,
        agentId: single(facts.map(fact => fact.agentId)),
        agentIds,
        repo: single(facts.map(fact => fact.repo)),
        version: single(facts.map(fact => fact.version)),
        building: single(facts.map(fact => fact.building)),
        childIds: facts.map(fact => fact.childId).filter(id => id != null),
    };
}

/**
 * The shared outcome policy between a fact and a cue: per-agent gates, the
 * release absorbing its push, and the aggregation window. `emit(outcome)`
 * receives one summarized outcome (`summarizeOutcomes`). A timer only wakes
 * the flush; the cue is placed on the audio clock by whoever plays it.
 */
export class OutcomeRouter {
    constructor({
        emit,
        now = () => Date.now(),
        setTimer = (fn, ms) => setTimeout(fn, ms),
        clearTimer = (handle) => clearTimeout(handle),
        windowMs = OUTCOME_AGGREGATE_MS,
    } = {}) {
        this._emit = typeof emit === 'function' ? emit : () => {};
        this._now = now;
        this._setTimer = setTimer;
        this._clearTimer = clearTimer;
        this.windowMs = windowMs;
        this._batches = new Map();
        this._toolFailedAt = new Map();
        this._releasedAt = new Map();
    }

    submit(fact) {
        if (!fact?.kind) return false;
        const now = this._now();
        if (fact.kind === 'toolFailed' && !this._admitToolFailure(fact, now)) return false;
        if (fact.kind === 'release') this._absorbPushes(fact, now);
        if (fact.kind === 'push' && this._releasedRecently(fact, now)) return false;

        if (!AGGREGATED_KINDS.has(fact.kind)) {
            this._emit(summarizeOutcomes([fact]));
            return true;
        }
        const key = aggregateKey(fact);
        const batch = this._batches.get(key);
        if (batch) {
            batch.facts.push(fact);
            return true;
        }
        const entry = { facts: [fact], timer: null };
        entry.timer = this._setTimer(() => this._flush(key), this.windowMs);
        this._batches.set(key, entry);
        return true;
    }

    /** Pending batch sizes by key (diagnostics). */
    pending() {
        const out = {};
        for (const [key, batch] of this._batches) out[key] = batch.facts.length;
        return out;
    }

    destroy() {
        for (const batch of this._batches.values()) this._clearTimer(batch.timer);
        this._batches.clear();
        this._toolFailedAt.clear();
        this._releasedAt.clear();
    }

    _flush(key) {
        const batch = this._batches.get(key);
        if (!batch) return;
        this._batches.delete(key);
        this._emit(summarizeOutcomes(batch.facts));
    }

    _admitToolFailure(fact, now) {
        const agent = fact.agentId ?? '';
        const last = this._toolFailedAt.get(agent);
        if (last != null && now - last < TOOL_FAILED_AGENT_GAP_MS) return false;
        remember(this._toolFailedAt, agent, now);
        return true;
    }

    // A release is the ceremony its push was part of: a push of the same
    // project still in its window is dropped, and so is one arriving just after.
    _absorbPushes(fact, now) {
        const repo = fact.repo ?? '';
        remember(this._releasedAt, repo, now);
        for (const [key, batch] of this._batches) {
            if (!key.startsWith('push:')) continue;
            if (repo && key !== `push:${repo}`) continue;
            this._clearTimer(batch.timer);
            this._batches.delete(key);
        }
    }

    _releasedRecently(fact, now) {
        const at = this._releasedAt.get(fact.repo ?? '') ?? this._releasedAt.get('');
        return at != null && now - at < RELEASE_ABSORBS_PUSH_MS;
    }
}
