import { Agent, normalizeTodoList } from '../domain/entities/Agent.js';
import { AgentStatus } from '../domain/value-objects/AgentStatus.js';
import { resolveAgentStatus } from '../domain/services/StatusResolver.js';
import { eventBus } from '../domain/events/DomainEvent.js';
import { AgentBiography } from '../domain/value-objects/AgentBiography.js';
import { dialogueIsHeldable } from '../config/dialogue.js';
import {
    createVerifiedOutcome,
    verifiedOutcomeFromGitEvent,
    verifiedOutcomeIsLive,
    verifiedOutcomeKey,
    VERIFIED_OUTCOME_EVENT,
} from '../domain/services/VerifiedOutcome.js';

const LEGACY_GENERATED_NAMES_STORAGE_KEY = 'claudeville.generatedAgentNames.v1';
const GENERATED_NAME_STORAGE_PREFIX = 'claudeville.generatedAgentName.v2:';
// EN-2 (r2) — the stored rows are bounded and evicted by use, not write
// order: each row is `{"n": name, "t": lastUsedMs}`, a read or a remember
// refreshes `t` at most once a day, and a prune past the cap drops the
// oldest-unused rows no live roster is reading. The retired round-1
// write-order index is only cleared away.
const GENERATED_NAME_ORDER_STORAGE_KEY = 'claudeville.generatedAgentName.order.v2';
// EN-2 — the generated-name cache is bounded: at the cap, the identity least
// recently touched (a read or a write refreshes recency) leaves the Map, and
// the stored set keeps the same cap.
const GENERATED_NAME_CACHE_LIMIT = 512;
// A read or a remember refreshes a row's `t` at most this often, so roster
// updates do not rewrite storage constantly.
const GENERATED_NAME_REFRESH_MS = 24 * 60 * 60 * 1000;

// A stored row is `{"n": name, "t": lastUsedMs}`; a plain string row
// predates the timestamp and reads as never used.
function parseStoredNameRow(raw) {
    if (typeof raw !== 'string' || !raw) return null;
    try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            if (typeof parsed.n !== 'string') return null;
            return { name: parsed.n, lastUsedMs: Number.isFinite(parsed.t) ? parsed.t : 0 };
        }
    } catch {
        // A plain name that is not valid JSON is a legacy row.
    }
    return { name: raw, lastUsedMs: 0 };
}

// Sessions leave the server's live roster after two quiet minutes. Keep their
// villagers present just long enough for a short parallel fan-out to still be
// readable once it finishes, then send them out through the village gate.
export const DEPARTED_AGENT_GRACE_MS = 90 * 1000;
// The grace above expires on wall-clock time, but WebSocket updates stop the
// moment the server has nothing left to report — which is exactly when the last
// villager departs. Sweep on our own cadence so departures never wait on
// unrelated traffic.
export const DEPARTED_SWEEP_INTERVAL_MS = 15 * 1000;
// Bound world presence independently of Chronicle history. A 20-agent fan-out
// fits comfortably while pathological churn evicts the oldest departures.
export const MAX_DEPARTED_AGENTS = 100;

const AGENT_SIGNATURE_FIELDS = Object.freeze([
    'id',
    'agentId',
    'agentName',
    'agentType',
    'agentPath',
    'subagentKind',
    'parentSessionId',
    'rootSessionId',
    'workflowId',
    'workflowName',
    'model',
    'effort',
    'status',
    'role',
    'teamName',
    'tokens',
    'estimatedCost',
    'taskProgress',
    'tasks',
    'todos',
    'cost',
    'currentTool',
    'currentToolInput',
    'lastTool',
    'lastToolInput',
    'lastPrompt',
    'gitBranch',
    'repoRoot',
    'worktree',
    'gitEvents',
    'permissionMode',
    'turnState',
    'backgroundPending',
    'pendingTool',
    'pendingSince',
    'waitReason',
    'awaitingSince',
    'turnStartedAt',
    'sessionEndedAt',
    'lastTurnDurationMs',
    'signalSource',
    'signalCertainty',
    'signalObservedAt',
    'signalStale',
    'freshness',
    'workingSet',
    'lastResults',
    'collisions',
    'resident',
    'sendMessages',
    'lastSessionActivity',
    '_lastMessage',
    'dialogue',
    'name',
    '_customName',
    'projectPath',
    'provider',
]);
const SIGNATURE_STRING_SAMPLE = 512;
const SIGNATURE_ARRAY_ITEMS = 64;
const SIGNATURE_OBJECT_FIELDS = 32;
const SIGNATURE_FIELD_VALUE_BUDGET = 128;
const SIGNATURE_COLLECTION_VALUE_BUDGET = 1024;
const SIGNATURE_FIELD_CHARACTER_BUDGET = 1024;
const SIGNATURE_COLLECTION_CHARACTER_BUDGET = 15 * 1024;
const SIGNATURE_CHARACTER_BUDGET = 64 * 1024;
const SIGNATURE_COLLECTION_FIELDS = new Set(['sendMessages', 'workingSet', 'collisions', 'tasks', 'todos']);
// VB-7 — git events and tool results change in place anywhere in the list (an
// outcome settles, a PR URL attaches, a rescan or a landed-sha patch restamps
// a row). Every row mixes a compact key of its identity and those fields
// instead of a sampled head and tail, bounded per row and per list.
const SIGNATURE_KEYED_FIELDS = new Set(['gitEvents', 'lastResults']);
const SIGNATURE_KEYED_ROW_LIMIT = 2048;
const SIGNATURE_KEY_PART_CHARACTERS = 160;
const VERIFIED_OUTCOME_KEY_LIMIT = 512;
const EXECUTION_TASK_LIMIT = 12;
// Mirrors the adapter contract's bounded last-result summary (adapters/toolResults.js).
const LAST_RESULT_LIMIT = 5;

// PV-2 — `{ count, kinds, since }` of the background work a closed turn
// still waits on (adapters/README.md), else null.
function normalizeBackgroundPending(value) {
    const count = Math.trunc(Number(value?.count));
    if (!Number.isFinite(count) || count <= 0) return null;
    const since = Number(value.since);
    return {
        count,
        kinds: Array.isArray(value.kinds)
            ? value.kinds.filter(kind => typeof kind === 'string' && kind).slice(0, 4).map(kind => kind.slice(0, 32))
            : [],
        since: value.since != null && Number.isFinite(since) ? since : null,
    };
}

function normalizeExecutionTaskSubject(value) {
    if (typeof value !== 'string') return '';
    const subject = value
        .replace(/[\u0000-\u001f\u007f]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/(^|[\s"'([{=])((?:\/|[A-Za-z]:[\\/])(?:[^\s"'`<>()[\]{};,]+))/g, '$1[path]');
    if (!subject) return '';
    return subject.length <= 120 ? subject : `${subject.slice(0, 119).trimEnd()}…`;
}

function normalizeExecutionTaskStatus(value) {
    return String(value || 'unknown')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 64) || 'unknown';
}

function normalizeExecutionTaskProgress(value) {
    if (!value || typeof value !== 'object') return null;
    const total = Number(value.total);
    const done = Number(value.done);
    if (!Number.isFinite(total) || !Number.isFinite(done)) return null;
    const normalizedTotal = Math.max(0, Math.trunc(total));
    const source = value.source === 'exact' || value.source === 'inferred'
        ? value.source
        : null;
    if (!source) return null;
    return {
        done: Math.min(normalizedTotal, Math.max(0, Math.trunc(done))),
        total: normalizedTotal,
        source,
    };
}


function gitEventWireReference(value) {
    let hash = 2166136261;
    const text = String(value || '');
    for (let index = 0; index < text.length; index++) {
        hash = Math.imul(hash ^ text.charCodeAt(index), 16777619);
    }
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    let encoded = '';
    let remaining = hash >>> 0;
    for (let index = 0; index < 6; index++) {
        encoded = alphabet[remaining % 64] + encoded;
        remaining = Math.floor(remaining / 64);
    }
    return encoded;
}

function mixDigestCode(state, code) {
    state.a = Math.imul(state.a ^ code, 16777619);
    state.b = Math.imul(state.b ^ code, 2246822519);
}

function mixDigestString(state, value, budget = null) {
    const text = String(value);
    mixDigestCode(state, text.length & 0xffff);
    mixDigestCode(state, text.length >>> 16);
    const globalRemaining = Math.max(0, SIGNATURE_CHARACTER_BUDGET - state.characters);
    const fieldRemaining = budget
        ? Math.max(0, budget.characterLimit - budget.characters)
        : globalRemaining;
    const remaining = Math.min(globalRemaining, fieldRemaining);
    const sampleSize = Math.min(SIGNATURE_STRING_SAMPLE, remaining);
    if (sampleSize <= 0) return;
    if (text.length <= sampleSize) {
        for (let index = 0; index < text.length; index++) mixDigestCode(state, text.charCodeAt(index));
        state.characters += text.length;
        if (budget) budget.characters += text.length;
        return;
    }

    const head = Math.floor(sampleSize * 0.4);
    const tail = Math.floor(sampleSize * 0.4);
    const middle = sampleSize - head - tail;
    for (let index = 0; index < head; index++) mixDigestCode(state, text.charCodeAt(index));
    for (let index = 1; index <= middle; index++) {
        const sourceIndex = Math.floor(index * (text.length - 1) / (middle + 1));
        mixDigestCode(state, text.charCodeAt(sourceIndex));
    }
    for (let index = text.length - tail; index < text.length; index++) {
        mixDigestCode(state, text.charCodeAt(index));
    }
    state.characters += sampleSize;
    if (budget) budget.characters += sampleSize;
}

function mixDigestValue(state, value, depth = 0, budget = null) {
    if (!budget || budget.values >= budget.valueLimit || depth > 4) return;
    budget.values++;
    state.values++;
    if (value === null || value === undefined) {
        mixDigestString(state, value === null ? 'null' : 'undefined', budget);
        return;
    }
    const type = typeof value;
    mixDigestString(state, type, budget);
    if (type === 'string') {
        mixDigestString(state, value, budget);
        return;
    }
    if (type === 'number' || type === 'boolean' || type === 'bigint') {
        mixDigestString(state, value, budget);
        return;
    }
    if (Array.isArray(value)) {
        mixDigestString(state, value.length, budget);
        const headCount = value.length > SIGNATURE_ARRAY_ITEMS ? 8 : value.length;
        const tailStart = value.length > SIGNATURE_ARRAY_ITEMS
            ? Math.max(headCount, value.length - (SIGNATURE_ARRAY_ITEMS - headCount))
            : value.length;
        for (let index = 0; index < headCount; index++) {
            mixDigestValue(state, value[index], depth + 1, budget);
        }
        for (let index = tailStart; index < value.length; index++) {
            mixDigestValue(state, value[index], depth + 1, budget);
        }
        return;
    }
    if (type !== 'object') return;

    let fieldCount = 0;
    for (const key in value) {
        if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
        if (fieldCount >= SIGNATURE_OBJECT_FIELDS || budget.values >= budget.valueLimit) {
            mixDigestString(state, '[more-fields]', budget);
            break;
        }
        fieldCount++;
        mixDigestString(state, key, budget);
        mixDigestValue(state, value[key], depth + 1, budget);
    }
}

function mixDigestKeyPart(state, value) {
    const text = value === undefined ? '\u0000' : String(value);
    const length = Math.min(text.length, SIGNATURE_KEY_PART_CHARACTERS);
    mixDigestCode(state, length);
    for (let index = 0; index < length; index++) mixDigestCode(state, text.charCodeAt(index));
}

// VB-16 — the server re-stamps `freshness.observedAt` and `ageMs` on every
// collect. Only the state and the observation minute count as a change, as
// the activity age counts by minute, so a re-stamp alone never re-upserts.
function freshnessDigestValue(freshness) {
    if (!freshness || typeof freshness !== 'object') return freshness ?? null;
    const observedAt = freshness.observedAt == null ? NaN : Number(freshness.observedAt);
    return [freshness.state ?? null, Number.isFinite(observedAt) ? Math.floor(observedAt / 60_000) : null];
}

// One `id:status:sha:url` key per row (outcome, label, scan and landed set
// included), so an edit at any index changes the digest.
function mixDigestKeyedRows(state, rows) {
    if (!Array.isArray(rows)) {
        mixDigestKeyPart(state, rows === null ? 'null' : typeof rows);
        return 0;
    }
    mixDigestKeyPart(state, rows.length);
    const count = Math.min(rows.length, SIGNATURE_KEYED_ROW_LIMIT);
    for (let index = 0; index < count; index++) {
        const row = rows[index];
        if (!row || typeof row !== 'object') {
            mixDigestKeyPart(state, row);
            continue;
        }
        const landed = Array.isArray(row.landedShas) ? row.landedShas : null;
        mixDigestKeyPart(state, row.id);
        mixDigestKeyPart(state, row.status);
        mixDigestKeyPart(state, row.success);
        mixDigestKeyPart(state, row.exitCode);
        mixDigestKeyPart(state, row.sha);
        mixDigestKeyPart(state, row.url);
        mixDigestKeyPart(state, row.label);
        mixDigestKeyPart(state, row.scanSeq);
        mixDigestKeyPart(state, landed ? `${landed.length}:${landed[landed.length - 1] ?? ''}` : undefined);
    }
    return count;
}

/**
 * Fixed-size signature for the fields retained by an Agent. Work is bounded by
 * sampled strings, recent array rows, recursion depth, and per-field work
 * budgets, so one large collection cannot starve later fields or force a
 * second full-payload serialization. Git events and tool results mix one
 * bounded key per row instead (VB-7), outside those budgets.
 */
export function digestAgentPayload(payload, diagnostics = null) {
    const state = {
        a: 2166136261,
        b: 2654435761,
        characters: 0,
        values: 0,
    };
    let keyedRows = 0;
    for (const field of AGENT_SIGNATURE_FIELDS) {
        mixDigestString(state, field);
        if (SIGNATURE_KEYED_FIELDS.has(field)) {
            keyedRows += mixDigestKeyedRows(state, payload?.[field]);
            continue;
        }
        const collection = SIGNATURE_COLLECTION_FIELDS.has(field);
        const budget = {
            values: 0,
            valueLimit: collection
                ? SIGNATURE_COLLECTION_VALUE_BUDGET
                : SIGNATURE_FIELD_VALUE_BUDGET,
            characters: 0,
            characterLimit: collection
                ? SIGNATURE_COLLECTION_CHARACTER_BUDGET
                : SIGNATURE_FIELD_CHARACTER_BUDGET,
        };
        mixDigestValue(state, field === 'freshness' ? freshnessDigestValue(payload?.freshness) : payload?.[field], 0, budget);
    }
    const activityAgeMinute = Number.isFinite(payload?.activityAgeMs)
        ? Math.floor(payload.activityAgeMs / 60_000)
        : null;
    mixDigestString(state, 'activityAgeMinute');
    mixDigestValue(state, activityAgeMinute, 0, {
        values: 0,
        valueLimit: SIGNATURE_FIELD_VALUE_BUDGET,
        characters: 0,
        characterLimit: SIGNATURE_FIELD_CHARACTER_BUDGET,
    });
    if (diagnostics && typeof diagnostics === 'object') {
        diagnostics.characters = state.characters;
        diagnostics.values = state.values;
        diagnostics.keyedRows = keyedRows;
    }
    return `${(state.a >>> 0).toString(16).padStart(8, '0')}${(state.b >>> 0).toString(16).padStart(8, '0')}`;
}

export class AgentManager {
    constructor(world, dataSource, { clock = Date.now } = {}) {
        this.world = world;
        this.dataSource = dataSource;
        this._clock = typeof clock === 'function' ? clock : Date.now;
        this._teamMembers = new Map();
        this._usageGetter = null;
        this._agentSignatures = new Map();
        this._generatedNames = new Map();
        this._generatedNamesMigrationDone = false;
        // EN-2 (r3) — the identity keys of the roster batch being ingested,
        // protected from stored-name prunes until the batch completes.
        this._rosterBatchIdentities = null;
        this._initStoredGeneratedNames();
        this._verifiedOutcomeKeys = new Set();
        this._departureSweepTimer = null;
        this._unsubscribeVerifiedMilestones = [
            eventBus.on('chronicle:milestone', (record) => this._noteVerifiedMilestone(record)),
            eventBus.on('chronicle:milestone-banner', (record) => this._noteVerifiedMilestone(record)),
        ];
    }

    setUsageGetter(fn) {
        this._usageGetter = typeof fn === 'function' ? fn : null;
    }

    _buildTeamMembers(teams) {
        const teamMembers = new Map();
        for (const team of teams) {
            if (team.members) {
                for (const member of team.members) {
                    teamMembers.set(member.agentId, {
                        name: member.name,
                        teamName: team.teamName || team.name,
                        agentType: member.agentType,
                        model: member.model,
                    });
                }
            }
        }
        return teamMembers;
    }

    async loadInitialData({ signal = null } = {}) {
        try {
            const [sessions, teams] = await Promise.all([
                this.dataSource.getSessions({ signal }),
                this.dataSource.getTeams({ signal }),
            ]);
            if (signal?.aborted) return;

            this._teamMembers = this._buildTeamMembers(teams);

            const gitEventWire = this._gitEventWireFrom(sessions);
            const collisionsByAgent = this._collisionsByAgent(sessions.collisions);
            this._rosterBatchIdentities = this._rosterIdentityKeys(sessions, this._teamMembers);
            try {
                for (const session of sessions) {
                    this._upsertAgent(
                        session,
                        this._teamMembers,
                        gitEventWire,
                        collisionsByAgent.get(String(session.sessionId)) || [],
                    );
                }
            } finally {
                this._rosterBatchIdentities = null;
            }

            console.log(`[AgentManager] ${this.world.agents.size} agents loaded`);
        } catch (err) {
            if (signal?.aborted || err?.name === 'AbortError') return;
            console.error('[AgentManager] Failed to load initial data:', err.message);
        }
    }

    handleWebSocketMessage(data) {
        if (!data.sessions) return;
        const changedIds = data.changes && !data.changes.shared
            ? new Set(data.changes.sessionIds)
            : null;

        // Update when team data is included
        if (data.teams && !changedIds) {
            this._teamMembers = this._buildTeamMembers(data.teams);
        }

        const currentIds = new Set();

        const gitEventWire = this._gitEventWireFrom(data, data.sessions);
        const collisionsByAgent = this._collisionsByAgent(data.collisions || data.sessions.collisions);
        let failures = 0;
        let firstError = null;
        this._rosterBatchIdentities = this._rosterIdentityKeys(data.sessions, this._teamMembers);
        for (const session of data.sessions) {
            // EN-8 — one malformed session skips only itself: the rest of the
            // update and its departure sweep still run.
            try {
                currentIds.add(session.sessionId);
                const agent = this.world.agents.get(session.sessionId);
                if (changedIds && !changedIds.has(String(session.sessionId)) && agent && !agent.isDeparted) {
                    const { status, activityAgeMs } = this._sessionTiming(session);
                    const activityAgeMinute = Number.isFinite(activityAgeMs)
                        ? Math.floor(activityAgeMs / 60_000)
                        : null;
                    const previousAgeMinute = Number.isFinite(agent.activityAgeMs)
                        ? Math.floor(agent.activityAgeMs / 60_000)
                        : null;
                    // Status includes activity/quota thresholds and git-failure
                    // expiry; a change also refreshes status-derived tools/dialogue.
                    // Preserve the full signature's age-bucket update cadence.
                    if (status === agent.status && activityAgeMinute === previousAgeMinute) {
                        this._refreshUnchangedAgent(agent, activityAgeMs);
                        this._noteVerifiedGitOutcomes(session, agent.gitEvents);
                        continue;
                    }
                }
                this._upsertAgent(
                    session,
                    this._teamMembers,
                    gitEventWire,
                    collisionsByAgent.get(String(session.sessionId)) || [],
                );
            } catch (err) {
                failures++;
                firstError ??= err;
            }
        }
        this._rosterBatchIdentities = null;
        if (failures) this._noteIngestFailures(failures, firstError);

        this._sweepDepartedAgents(currentIds);
    }

    // Counted for diagnostics; warned at most once a minute so a session that
    // stays malformed cannot flood the console at the update rate.
    _noteIngestFailures(count, error) {
        this.ingestErrors = (this.ingestErrors || 0) + count;
        const now = this._now();
        if (this._lastIngestWarnAt && now - this._lastIngestWarnAt < 60_000) return;
        this._lastIngestWarnAt = now;
        console.warn(`[AgentManager] ${count} session(s) failed to ingest; the rest of the update applied:`, error?.message || error);
    }

    /**
     * Advance the departed-villager lifecycle: mark newly missing sessions as
     * departed, then remove the ones whose grace has run out so the renderer
     * can walk them out through the village gate.
     *
     * @param {Set<string>|null} liveIds Sessions present in the update that
     *   triggered this sweep, or null for a timer sweep, where every villager
     *   already in the World keeps whatever presence it currently has.
     */
    _sweepDepartedAgents(liveIds = null) {
        // Missing sessions linger as departed villagers. COMPLETED is an
        // existing compatibility projection for UI counters; the
        // departedAt marker, not status, owns this presence lifecycle.
        const now = this._now();
        const toRemove = [];
        for (const [id, agent] of this.world.agents) {
            if (liveIds?.has(id)) continue;
            if (agent.isDeparted) {
                this._agentSignatures.delete(id);
                if (now - agent.departedAt >= DEPARTED_AGENT_GRACE_MS) {
                    toRemove.push(id);
                }
            } else if (liveIds) {
                // Only a roster update can tell us a live villager has gone
                // missing; a timer sweep never demotes one on its own.
                this._agentSignatures.delete(id);
                this.world.updateAgent(id, {
                    status: AgentStatus.COMPLETED,
                    departedAt: now,
                    currentTool: null,
                    currentToolInput: null,
                    pendingTool: null,
                    waitReason: null,
                    awaitingSince: null,
                    resident: false,
                    dialogue: null,
                });
            }
        }
        for (const id of toRemove) {
            this.world.removeAgent(id);
        }
        this._evictDepartedOverflow();
    }

    /**
     * Start the wall-clock sweep. Without it a departed villager only leaves
     * when some unrelated session change wakes a broadcast, so the last agents
     * of a run stand frozen in the village until the page is reloaded.
     */
    startDepartureSweep({ intervalMs = DEPARTED_SWEEP_INTERVAL_MS } = {}) {
        if (this._departureSweepTimer || typeof setInterval !== 'function') return;
        this._departureSweepTimer = setInterval(() => this._sweepDepartedAgents(), intervalMs);
        this._departureSweepTimer.unref?.();
    }

    stopDepartureSweep() {
        if (!this._departureSweepTimer) return;
        clearInterval(this._departureSweepTimer);
        this._departureSweepTimer = null;
    }

    stop() {
        this.stopDepartureSweep();
        for (const unsubscribe of this._unsubscribeVerifiedMilestones) unsubscribe?.();
        this._unsubscribeVerifiedMilestones = [];
    }

    _evictDepartedOverflow() {
        const departed = [...this.world.agents.values()]
            .filter(agent => agent.isDeparted)
            .sort((a, b) => a.departedAt - b.departedAt || String(a.id).localeCompare(String(b.id)));
        const overflow = departed.length - MAX_DEPARTED_AGENTS;
        for (let index = 0; index < overflow; index++) {
            const id = departed[index].id;
            this._agentSignatures.delete(id);
            this.world.removeAgent(id);
        }
    }

    _now() {
        const now = Number(this._clock());
        return Number.isFinite(now) ? now : Date.now();
    }

    _upsertAgent(session, teamMembers, gitEventWire = null, collisions = []) {
        const payload = this._sessionToAgentPayload(session, teamMembers, gitEventWire, collisions);
        this._noteVerifiedGitOutcomes(session, payload.gitEvents);
        const { id } = payload;
        // An explicit provider end removes presence now. Removal owns the
        // existing gate staging; a repeated closed transcript never re-adds a
        // body, while a resumed session (end cleared) takes the normal arrival.
        if (payload.sessionEndedAt) {
            this._agentSignatures.delete(id);
            if (this.world.agents.has(id)) {
                this.world.updateAgent(id, {
                    sessionEndedAt: payload.sessionEndedAt,
                    gitEvents: payload.gitEvents,
                    lastResults: payload.lastResults,
                });
                this.world.removeAgent(id);
            }
            return;
        }
        const signature = this._agentSignature(payload);

        if (this.world.agents.has(id)) {
            const agent = this.world.agents.get(id);
            if (!agent.isDeparted && this._agentSignatures.get(id) === signature) {
                this._refreshUnchangedAgent(agent, payload.activityAgeMs);
                return;
            }
            this._agentSignatures.set(id, signature);
            const { id: _id, projectPath: _projectPath, provider: _provider, lastMessage: _lastMessage, ...agentData } = payload;
            this.world.updateAgent(id, { ...agentData, departedAt: null });
        } else {
            this._agentSignatures.set(id, signature);
            const agent = new Agent(payload);
            agent.subagentKind = payload.subagentKind;
            agent.agentPath = payload.agentPath;
            agent.taskProgress = payload.taskProgress;
            agent.tasks = payload.tasks;
            // Fallback (non-provider) names come from a shared pool; probe past
            // names already held by live agents so busy villages stay distinct.
            // Persist the result under the pre-probe identity as well as the
            // resulting identity, so roster order cannot rename the villager
            // after a restart.
            if (!agent._customName) {
                const initialIdentityKey = AgentBiography.identityKeyFor(agent);
                agent.name = this._generatedNameFor(initialIdentityKey)
                    || agent.generateName(this._usedAgentNames());
                const identityKey = AgentBiography.identityKeyFor(agent);
                this._rememberGeneratedName(initialIdentityKey, agent.name);
                this._rememberGeneratedName(identityKey, agent.name);
            }
            agent.refreshIdentityAppearance();
            this.world.addAgent(agent);
        }
    }

    _refreshUnchangedAgent(agent, activityAgeMs) {
        agent.activityAgeMs = activityAgeMs;
        agent.lastActive = Date.now();
    }

    _agentSignature(payload) {
        return digestAgentPayload(payload);
    }

    _sessionTiming(session) {
        const status = this._resolveStatus(session);
        const lastSessionActivity = Number(session.lastActivity || 0) || null;
        const activityAgeMs = lastSessionActivity ? Math.max(0, Date.now() - lastSessionActivity) : null;
        return { status, lastSessionActivity, activityAgeMs };
    }

    _noteVerifiedGitOutcomes(session, gitEvents = session?.gitEvents) {
        const agentId = session?.sessionId || session?.agentId || null;
        for (const event of gitEvents || []) {
            const outcome = verifiedOutcomeFromGitEvent(event, {
                project: session?.project,
                agentId,
                at: this._now(),
            });
            this._emitVerifiedOutcome(outcome, event?.id || event?.commandHash || event?.sha || 'git');
        }
    }

    _noteVerifiedMilestone(record) {
        const kind = record?.kind === 'release' ? 'release' : 'milestone';
        const outcome = createVerifiedOutcome(
            kind,
            record?.project,
            record?.agentId ?? null,
            record?.startedAt ?? record?.plantedAt ?? record?.ts
        );
        this._emitVerifiedOutcome(outcome, record?.id || record?.dedupKey || record?.tier || 'milestone');
    }

    _emitVerifiedOutcome(outcome, sourceId) {
        if (!outcome || !verifiedOutcomeIsLive(outcome, this._now())) return;
        const key = verifiedOutcomeKey(outcome, sourceId);
        if (!key || this._verifiedOutcomeKeys.has(key)) return;
        this._verifiedOutcomeKeys.add(key);
        while (this._verifiedOutcomeKeys.size > VERIFIED_OUTCOME_KEY_LIMIT) {
            this._verifiedOutcomeKeys.delete(this._verifiedOutcomeKeys.values().next().value);
        }
        eventBus.emit(VERIFIED_OUTCOME_EVENT, outcome);
    }

    _usedAgentNames() {
        const used = new Set();
        for (const agent of this.world.agents.values()) {
            const name = String(agent?.name || '').trim();
            if (name) used.add(name);
        }
        return used;
    }

    _migrateGeneratedNames() {
        if (this._generatedNamesMigrationDone) return;
        this._generatedNamesMigrationDone = true;
        try {
            if (typeof localStorage === 'undefined') return;
            const legacy = localStorage.getItem(LEGACY_GENERATED_NAMES_STORAGE_KEY);
            if (legacy === null) return;
            const parsed = JSON.parse(legacy);
            const entries = new Map(Array.isArray(parsed) ? parsed.filter(entry => (
                Array.isArray(entry)
                && typeof entry[0] === 'string'
                && typeof entry[1] === 'string'
            )) : []);
            for (const [identityKey, name] of entries) {
                const key = `${GENERATED_NAME_STORAGE_PREFIX}${identityKey}`;
                if (localStorage.getItem(key) === null && !this._storeGeneratedName(identityKey, name)) return;
            }
            // Keep the legacy record if any write failed, so quota-limited
            // profiles never lose names that have not yet been migrated.
            localStorage.removeItem(LEGACY_GENERATED_NAMES_STORAGE_KEY);
        } catch {
            // Storage can be unavailable in private or restricted contexts.
        }
    }

    _generatedNameFor(identityKey) {
        if (!identityKey) return null;
        if (this._generatedNames.has(identityKey)) {
            // EN-2 (VT-fix-3) — a cache hit refreshes the LRU recency; EN-2
            // (r2) — a read also refreshes the stored row's `t`, throttled.
            const cached = this._generatedNames.get(identityKey);
            this._touchGeneratedName(identityKey, cached);
            this._refreshStoredGeneratedName(identityKey, cached);
            return cached;
        }
        this._migrateGeneratedNames();
        let name = null;
        let lastUsedMs = 0;
        try {
            if (typeof localStorage !== 'undefined') {
                const stored = parseStoredNameRow(localStorage.getItem(`${GENERATED_NAME_STORAGE_PREFIX}${identityKey}`));
                if (stored) {
                    name = stored.name;
                    lastUsedMs = stored.lastUsedMs;
                } else {
                    // Only degraded/partially migrated storage retains v1.
                    const record = localStorage.getItem(LEGACY_GENERATED_NAMES_STORAGE_KEY);
                    if (record !== null) {
                        const legacy = JSON.parse(record);
                        if (Array.isArray(legacy)) {
                            for (const entry of legacy) {
                                if (Array.isArray(entry) && entry[0] === identityKey && typeof entry[1] === 'string') {
                                    name = entry[1];
                                }
                            }
                        }
                    }
                }
            }
        } catch {
            // In-memory naming remains available even when reads fail.
        }
        // EN-2 (VT-fix-3) — a stored row joins the cache through the same
        // capped path as a write, so loading persisted identities cannot
        // outgrow the cache.
        this._touchGeneratedName(identityKey, name);
        // EN-2 (r2) — a read is a use: refresh the row's `t` at most once a
        // day, so a recently used resident survives prunes by recency.
        if (name !== null && this._now() - lastUsedMs >= GENERATED_NAME_REFRESH_MS) {
            this._storeGeneratedName(identityKey, name);
        }
        return name;
    }

    _rememberGeneratedName(identityKey, name) {
        if (!identityKey || !name) return;
        const known = this._generatedNames.get(identityKey);
        // EN-2 (VT-fix-3) — re-inserting refreshes recency even when the name
        // is unchanged, so a same-value remember no longer skips the cap.
        this._touchGeneratedName(identityKey, name);
        if (known === name) {
            // EN-2 (r2) — an unchanged remember is still a use of the row.
            this._refreshStoredGeneratedName(identityKey, name);
            return;
        }
        this._storeGeneratedName(identityKey, name);
    }

    // EN-2 — the one insert path for the cache: re-inserting refreshes
    // recency, and every read and write passes through the cap. Eviction
    // leaves the stored row alone: the stored set is bounded and evicted by
    // its own last-used order below, so a row a live roster still reads
    // survives its cache eviction and the name stays stable.
    _touchGeneratedName(identityKey, name) {
        this._generatedNames.delete(identityKey);
        this._generatedNames.set(identityKey, name);
        while (this._generatedNames.size > GENERATED_NAME_CACHE_LIMIT) {
            const [evictedKey] = this._generatedNames.keys();
            this._generatedNames.delete(evictedKey);
        }
    }

    // EN-2 (r2) — startup bounds the stored set from the real keys, not a
    // cached index: the retired order-index key goes away, and rows a
    // previous session (or another tab) left past the cap are pruned.
    _initStoredGeneratedNames() {
        try {
            if (typeof localStorage === 'undefined') return;
            localStorage.removeItem(GENERATED_NAME_ORDER_STORAGE_KEY);
            this._pruneStoredGeneratedNames(new Set());
        } catch {
            // Storage can be unavailable in private or restricted contexts.
        }
    }

    // Writes the row, then keeps the stored set bounded; false when any write
    // failed, so the v1 migration keeps the legacy record recoverable.
    _storeGeneratedName(identityKey, name) {
        try {
            if (typeof localStorage === 'undefined') return false;
            const key = `${GENERATED_NAME_STORAGE_PREFIX}${identityKey}`;
            const existed = localStorage.getItem(key) !== null;
            localStorage.setItem(key, JSON.stringify({ n: name, t: this._now() }));
            if (!existed) this._pruneStoredGeneratedNames(this._liveGeneratedNameIdentities(identityKey));
            return true;
        } catch {
            // Names still persist for the lifetime of this manager in memory.
            return false;
        }
    }

    // EN-2 (r2) — refreshes a row's `t` when it is at least a day stale (or
    // missing while the name stayed cached), through the capped store path.
    _refreshStoredGeneratedName(identityKey, name) {
        try {
            if (typeof localStorage === 'undefined' || name == null) return;
            const stored = parseStoredNameRow(localStorage.getItem(`${GENERATED_NAME_STORAGE_PREFIX}${identityKey}`));
            if (stored && this._now() - stored.lastUsedMs < GENERATED_NAME_REFRESH_MS) return;
            this._storeGeneratedName(identityKey, stored ? stored.name : name);
        } catch {
            // In-memory naming remains available even when reads fail.
        }
    }

    // The identities a live roster can still read: every resident's identity
    // key, the complete roster batch being ingested (EN-2 r3 — a newcomer
    // processed first cannot evict a returning resident later in the same
    // snapshot), and the row just written (a newcomer is named before it
    // joins the world). Prunes spare them while colder rows exist.
    _liveGeneratedNameIdentities(identityKey) {
        const live = new Set(identityKey ? [identityKey] : []);
        for (const identityKey of this._rosterBatchIdentities || []) live.add(identityKey);
        for (const agent of this.world.agents.values()) {
            const identity = AgentBiography.identityKeyFor(agent);
            if (identity) live.add(identity);
        }
        return live;
    }

    // The identity keys a roster batch will read names under, computed the
    // way `_upsertAgent` computes them (before any generated name is asked
    // for), so the whole batch can be protected before the first write.
    _rosterIdentityKeys(sessions, teamMembers) {
        const keys = new Set();
        for (const session of Array.isArray(sessions) ? sessions : []) {
            // EN-8 — a malformed entry skips only itself, like ingestion does.
            if (!session || typeof session !== 'object') continue;
            const teamInfo = teamMembers ? teamMembers.get(session.agentId) : null;
            const identityKey = AgentBiography.identityKeyFor({
                id: session.sessionId,
                provider: session.provider || 'claude',
                agentName: teamInfo?.name || session.name || session.agentName || session.nickname || null,
                projectPath: session.project || null,
                agentType: session.agentType || null,
                parentSessionId: session.parentSessionId || null,
            });
            if (identityKey) keys.add(identityKey);
        }
        return keys;
    }

    // Evicts the least recently used rows while the real prefixed keys exceed
    // the cap. Scanning storage, not a cached index, is what keeps other tabs
    // and failed writes honest. A live roster identity is never evicted while
    // a colder row can go instead; only when every row is live does the cap
    // win, still taking the oldest-used rows first.
    _pruneStoredGeneratedNames(protectedIdentities) {
        try {
            if (typeof localStorage === 'undefined') return;
            const rows = [];
            for (let index = 0; index < localStorage.length; index++) {
                const key = localStorage.key(index);
                if (typeof key === 'string' && key.startsWith(GENERATED_NAME_STORAGE_PREFIX)) {
                    rows.push({ key, index });
                }
            }
            const excess = rows.length - GENERATED_NAME_CACHE_LIMIT;
            if (excess <= 0) return;
            const byOldestUse = (a, b) => a.lastUsedMs - b.lastUsedMs || a.index - b.index;
            const evictable = [];
            const guarded = [];
            for (const row of rows) {
                const stored = parseStoredNameRow(localStorage.getItem(row.key));
                const entry = { ...row, lastUsedMs: stored ? stored.lastUsedMs : 0 };
                if (protectedIdentities.has(row.key.slice(GENERATED_NAME_STORAGE_PREFIX.length))) guarded.push(entry);
                else evictable.push(entry);
            }
            evictable.sort(byOldestUse);
            guarded.sort(byOldestUse);
            for (const row of [...evictable, ...guarded].slice(0, excess)) localStorage.removeItem(row.key);
        } catch {
            // Storage can be unavailable in private or restricted contexts.
        }
    }

    _sessionToAgentPayload(session, teamMembers, gitEventWire = null, collisions = []) {
        const id = session.sessionId;
        const teamInfo = teamMembers ? teamMembers.get(session.agentId) : null;
        const agentName = teamInfo?.name || session.name || session.agentName || session.nickname || null;
        const { status, lastSessionActivity, activityAgeMs } = this._sessionTiming(session);
        // A closed turn waiting on its crew (PV-2) runs no tool of its own.
        const hasFreshTool = status === AgentStatus.WORKING && !!session.lastTool
            && session.turnState !== 'awaiting_input';

        // Team name is an explicit provider field. Do not infer it from project
        // paths; Codex/Gemini intentionally degrade to null.
        const teamName = teamInfo?.teamName
            || session.teamName
            || null;

        return {
            id,
            agentId: session.agentId || null,
            subagentKind: typeof session.subagentKind === 'string' && session.subagentKind.trim()
                ? session.subagentKind.trim().slice(0, 128)
                : null,
            agentName,
            agentType: session.agentType || null,
            agentPath: typeof session.agentPath === 'string' && session.agentPath ? session.agentPath.slice(0, 512) : null,
            parentSessionId: session.parentSessionId || null,
            // PV-15 — the main session a nested crew belongs to.
            rootSessionId: session.rootSessionId || null,
            workflowId: session.workflowId || null,
            workflowName: session.workflowName || null,
            model: teamInfo?.model || session.model || 'unknown',
            effort: session.reasoningEffort || session.effort || null,
            status,
            role: teamInfo?.agentType || session.agentType || 'general',
            teamName,
            tokens: session.tokenUsage || session.tokens || session.usage || null,
            estimatedCost: session.estimatedCost !== null
                && session.estimatedCost !== undefined
                && Number.isFinite(Number(session.estimatedCost))
                ? Number(session.estimatedCost)
                : null,
            cost: session.cost && typeof session.cost === 'object' ? { ...session.cost } : null,
            taskProgress: normalizeExecutionTaskProgress(session.taskProgress),
            tasks: Array.isArray(session.tasks)
                ? session.tasks.slice(0, EXECUTION_TASK_LIMIT).flatMap((task) => {
                    const subject = normalizeExecutionTaskSubject(task?.subject);
                    return subject
                        ? [{ subject, status: normalizeExecutionTaskStatus(task?.status) }]
                        : [];
                })
                : [],
            todos: normalizeTodoList(session.todos),
            currentTool: hasFreshTool ? session.lastTool : null,
            currentToolInput: hasFreshTool ? session.lastToolInput || null : null,
            lastTool: session.lastTool || null,
            lastToolInput: session.lastToolInput || null,
            lastPrompt: typeof session.lastPrompt === 'string' && session.lastPrompt.trim()
                ? session.lastPrompt.trim().slice(0, 200)
                : null,
            gitBranch: typeof session.gitBranch === 'string' && session.gitBranch.trim()
                ? session.gitBranch.trim().slice(0, 256)
                : null,
            // Harbor wire contract v1: the session's repo (main worktree) and
            // checkout, so harbor and colour group a worktree with its repo.
            repoRoot: typeof session.repoRoot === 'string' && session.repoRoot ? session.repoRoot : null,
            worktree: session.worktree && typeof session.worktree === 'object'
                ? { name: String(session.worktree.name || ''), path: String(session.worktree.path || ''), isMain: session.worktree.isMain === true }
                : null,
            gitEvents: this._rehydrateGitEvents(session.gitEvents, gitEventWire),
            permissionMode: session.permissionMode ?? null,
            turnState: session.turnState ?? 'unknown',
            backgroundPending: normalizeBackgroundPending(session.backgroundPending),
            pendingTool: session.pendingTool ?? null,
            pendingSince: session.pendingSince !== null
                && session.pendingSince !== undefined
                && Number.isFinite(Number(session.pendingSince))
                ? Number(session.pendingSince)
                : null,
            waitReason: session.waitReason ?? null,
            awaitingSince: session.awaitingSince !== null
                && session.awaitingSince !== undefined
                && Number.isFinite(Number(session.awaitingSince))
                ? Number(session.awaitingSince)
                : null,
            turnStartedAt: session.turnStartedAt !== null
                && session.turnStartedAt !== undefined
                && Number.isFinite(Number(session.turnStartedAt))
                ? Number(session.turnStartedAt)
                : null,
            sessionEndedAt: session.sessionEndedAt != null
                && Number.isFinite(Number(session.sessionEndedAt))
                && Number(session.sessionEndedAt) > 0
                ? Number(session.sessionEndedAt)
                : null,
            lastTurnDurationMs: session.lastTurnDurationMs !== null
                && session.lastTurnDurationMs !== undefined
                && Number.isFinite(Number(session.lastTurnDurationMs))
                ? Math.max(0, Number(session.lastTurnDurationMs))
                : null,
            signalSource: session.signalSource === 'hook' || session.signalSource === 'transcript'
                ? session.signalSource
                : null,
            signalCertainty: session.signalCertainty || 'unavailable',
            signalObservedAt: session.signalObservedAt ?? null,
            signalStale: session.signalStale === true,
            freshness: session.freshness || null,
            workingSet: Array.isArray(session.workingSet) ? session.workingSet.slice(0, 16) : [],
            lastResults: Array.isArray(session.lastResults)
                ? session.lastResults.slice(0, LAST_RESULT_LIMIT)
                : [],
            collisions: Array.isArray(collisions) ? collisions : [],
            resident: session.resident === true,
            sendMessages: Array.isArray(session.sendMessages) ? session.sendMessages : [],
            lastSessionActivity,
            activityAgeMs,
            _lastMessage: session.lastMessage || null,
            lastMessage: session.lastMessage,
            dialogue: this._retainedDialogue(session, status, id),
            observedSources: session.observedSources ?? null,
            name: agentName || null,
            _customName: !!agentName,
            projectPath: session.project || null,
            provider: session.provider || 'claude',
        };
    }

    _collisionsByAgent(collisions) {
        const byAgent = new Map();
        for (const collision of Array.isArray(collisions) ? collisions : []) {
            if (!collision || !Array.isArray(collision.agents)) continue;
            for (const id of collision.agents) {
                const key = String(id || '');
                if (!key) continue;
                if (!byAgent.has(key)) byAgent.set(key, []);
                byAgent.get(key).push(collision);
            }
        }
        return byAgent;
    }

    _gitEventWireFrom(primary, fallback = null) {
        const eventsById = primary?.gitEventsById || fallback?.gitEventsById || null;
        const idsByReference = Object.create(null);
        const usedReferences = new Set();
        for (const id of Object.keys(eventsById || {}).sort()) {
            const baseReference = gitEventWireReference(id);
            let reference = baseReference;
            let suffix = 2;
            while (usedReferences.has(reference)) reference = `${baseReference}~${suffix++}`;
            usedReferences.add(reference);
            idsByReference[reference] = id;
        }
        return {
            idsByReference,
            fields: primary?.gitEventFields || fallback?.gitEventFields || null,
            stringTables: primary?.gitEventStringTables || fallback?.gitEventStringTables || null,
            eventsById,
        };
    }

    _rehydrateGitEvents(gitEvents, wire) {
        if (!Array.isArray(gitEvents)) return [];
        if (!gitEvents.some(reference => typeof reference === 'string' || Number.isInteger(reference))) {
            return gitEvents;
        }

        const resolved = [];
        for (const reference of gitEvents) {
            if (reference && typeof reference === 'object' && !Array.isArray(reference)) {
                resolved.push(this._cloneGitEventValue(reference));
                continue;
            }
            const event = this._gitEventFromReference(reference, wire);
            if (event) resolved.push(event);
        }
        return resolved;
    }

    _gitEventFromReference(reference, wire) {
        const directKey = typeof reference === 'string' ? reference : null;
        const key = directKey && Object.prototype.hasOwnProperty.call(wire?.eventsById || {}, directKey)
            ? directKey
            : wire?.idsByReference?.[directKey];
        if (
            typeof key !== 'string'
            || !wire?.eventsById
            || !Object.prototype.hasOwnProperty.call(wire.eventsById, key)
        ) return null;

        const row = wire.eventsById[key];
        if (!Array.isArray(row)) {
            return row && typeof row === 'object' ? this._cloneGitEventValue(row) : null;
        }
        if (!Array.isArray(row[0]) || !Array.isArray(wire.fields)) return null;

        const dictionaries = new Map();
        for (const entry of wire.stringTables || []) {
            if (Array.isArray(entry) && Number.isInteger(entry[0]) && Array.isArray(entry[1])) {
                dictionaries.set(entry[0], entry[1]);
            }
        }
        const event = {};
        let valueIndex = 1;
        for (let fieldIndex = 0; fieldIndex < wire.fields.length; fieldIndex++) {
            const mask = Number(row[0][Math.floor(fieldIndex / 30)]) || 0;
            const present = Math.floor(mask / (2 ** (fieldIndex % 30))) % 2 === 1;
            if (!present) continue;
            if (valueIndex >= row.length) return null;
            let value = row[valueIndex++];
            const dictionary = dictionaries.get(fieldIndex);
            if (dictionary) {
                if (!Number.isInteger(value) || value < 0 || value >= dictionary.length) return null;
                value = dictionary[value];
            }
            event[wire.fields[fieldIndex]] = this._cloneGitEventValue(value);
        }
        return event;
    }

    _cloneGitEventValue(value) {
        if (Array.isArray(value)) return value.map(item => this._cloneGitEventValue(item));
        if (!value || typeof value !== 'object') return value;
        const clone = {};
        for (const [key, child] of Object.entries(value)) {
            clone[key] = this._cloneGitEventValue(child);
        }
        return clone;
    }

    /**
     * Dialogue for this poll, holding a blocked agent's question in place.
     *
     * The server drops every line older than its own max age, which is right
     * for narration: a working agent's stale line describes work it has already
     * moved on from. A question is different. It stays true until it is
     * answered, and an agent blocked on the operator emits no newer text by
     * definition, so the wire simply goes quiet with the question still
     * outstanding. Keep the assistant prose it was last seen asking; every
     * other kind, and every other status, still falls silent on schedule.
     *
     * `Agent.speech()` marks the retained line as held so the tooltip discloses
     * it instead of passing an old question off as something just said.
     */
    _retainedDialogue(session, status, id) {
        const incoming = session.dialogue ?? null;
        if (incoming) return incoming;
        const previous = this.world?.agents?.get(id)?.dialogue ?? null;
        if (!previous) return null;
        return dialogueIsHeldable(status, previous.kind) ? previous : null;
    }

    _resolveStatus(session) {
        return resolveAgentStatus(session, {
            usage: this._usageGetter ? this._usageGetter() : null,
        });
    }

}
