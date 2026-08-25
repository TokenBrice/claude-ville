import { Agent } from '../domain/entities/Agent.js';
import { AgentStatus } from '../domain/value-objects/AgentStatus.js';
import { resolveAgentStatus } from '../domain/services/StatusResolver.js';
import { eventBus } from '../domain/events/DomainEvent.js';
import { AgentBiography } from '../domain/value-objects/AgentBiography.js';

const GENERATED_NAMES_STORAGE_KEY = 'claudeville.generatedAgentNames.v1';

// Sessions leave the server's live roster after two quiet minutes. Keep their
// villagers present long enough for short parallel fan-outs to remain visible.
export const DEPARTED_AGENT_GRACE_MS = 10 * 60 * 1000;
// Bound world presence independently of Chronicle history. A 20-agent fan-out
// fits comfortably while pathological churn evicts the oldest departures.
export const MAX_DEPARTED_AGENTS = 100;

const AGENT_SIGNATURE_FIELDS = Object.freeze([
    'id',
    'agentId',
    'agentName',
    'agentType',
    'parentSessionId',
    'workflowId',
    'workflowName',
    'model',
    'effort',
    'status',
    'role',
    'teamName',
    'tokens',
    'currentTool',
    'currentToolInput',
    'lastTool',
    'lastToolInput',
    'gitEvents',
    'permissionMode',
    'turnState',
    'pendingTool',
    'waitReason',
    'awaitingSince',
    'resident',
    'sendMessages',
    'lastSessionActivity',
    '_lastMessage',
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
const SIGNATURE_COLLECTION_FIELDS = new Set(['gitEvents', 'sendMessages']);

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

/**
 * Fixed-size signature for the fields retained by an Agent. Work is bounded by
 * sampled strings, recent array rows, recursion depth, and per-field work
 * budgets, so one large collection cannot starve later fields or force a
 * second full-payload serialization.
 */
export function digestAgentPayload(payload, diagnostics = null) {
    const state = {
        a: 2166136261,
        b: 2654435761,
        characters: 0,
        values: 0,
    };
    for (const field of AGENT_SIGNATURE_FIELDS) {
        mixDigestString(state, field);
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
        mixDigestValue(state, payload?.[field], 0, budget);
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
        this._generatedNames = this._loadGeneratedNames();
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

            for (const session of sessions) {
                this._upsertAgent(session, this._teamMembers);
            }

            console.log(`[AgentManager] ${this.world.agents.size} agents loaded`);
        } catch (err) {
            if (signal?.aborted || err?.name === 'AbortError') return;
            console.error('[AgentManager] Failed to load initial data:', err.message);
        }
    }

    handleWebSocketMessage(data) {
        if (!data.sessions) return;

        // Update when team data is included
        if (data.teams) {
            this._teamMembers = this._buildTeamMembers(data.teams);
        }

        const currentIds = new Set();

        for (const session of data.sessions) {
            currentIds.add(session.sessionId);
            this._upsertAgent(session, this._teamMembers);
        }

        // Missing sessions linger as departed villagers. COMPLETED is an
        // existing compatibility projection for presentation/counters; the
        // departedAt marker, not status, owns this presence lifecycle.
        const now = this._now();
        const toRemove = [];
        for (const [id, agent] of this.world.agents) {
            if (!currentIds.has(id)) {
                this._agentSignatures.delete(id);
                if (agent.isDeparted) {
                    if (now - agent.departedAt >= DEPARTED_AGENT_GRACE_MS) {
                        toRemove.push(id);
                    }
                } else {
                    this.world.updateAgent(id, {
                        status: AgentStatus.COMPLETED,
                        departedAt: now,
                        currentTool: null,
                        currentToolInput: null,
                        pendingTool: null,
                        waitReason: null,
                        awaitingSince: null,
                        resident: false,
                        visitIntentBubble: null,
                    });
                }
            }
        }
        for (const id of toRemove) {
            this.world.removeAgent(id);
        }
        this._evictDepartedOverflow();
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

    _upsertAgent(session, teamMembers) {
        const payload = this._sessionToAgentPayload(session, teamMembers);
        const { id } = payload;
        const signature = this._agentSignature(payload);

        if (this.world.agents.has(id)) {
            const agent = this.world.agents.get(id);
            if (!agent.isDeparted && this._agentSignatures.get(id) === signature) {
                agent.activityAgeMs = payload.activityAgeMs;
                agent.lastActive = Date.now();
                return;
            }
            this._agentSignatures.set(id, signature);
            const { id: _id, projectPath: _projectPath, provider: _provider, lastMessage: _lastMessage, ...agentData } = payload;
            this.world.updateAgent(id, { ...agentData, departedAt: null });
        } else {
            this._agentSignatures.set(id, signature);
            const agent = new Agent(payload);
            // Fallback (non-provider) names come from a shared pool; probe past
            // names already held by live agents so busy villages stay distinct.
            // Persist the result under the pre-probe identity as well as the
            // resulting identity, so roster order cannot rename the villager
            // after a restart.
            if (!agent._customName) {
                const initialIdentityKey = AgentBiography.identityKeyFor(agent);
                agent.name = this._generatedNames.get(initialIdentityKey)
                    || agent.generateName(this._usedAgentNames());
                const identityKey = AgentBiography.identityKeyFor(agent);
                this._rememberGeneratedName(initialIdentityKey, agent.name);
                this._rememberGeneratedName(identityKey, agent.name);
            }
            agent.refreshIdentityAppearance();
            this.world.addAgent(agent);
        }
    }

    _agentSignature(payload) {
        return digestAgentPayload(payload);
    }

    _usedAgentNames() {
        const used = new Set();
        for (const agent of this.world.agents.values()) {
            const name = String(agent?.name || '').trim();
            if (name) used.add(name);
        }
        return used;
    }

    _loadGeneratedNames() {
        if (typeof localStorage === 'undefined') return new Map();
        try {
            const entries = JSON.parse(localStorage.getItem(GENERATED_NAMES_STORAGE_KEY) || '[]');
            if (!Array.isArray(entries)) return new Map();
            return new Map(entries.filter(entry => (
                Array.isArray(entry)
                && typeof entry[0] === 'string'
                && typeof entry[1] === 'string'
            )));
        } catch {
            return new Map();
        }
    }

    _rememberGeneratedName(identityKey, name) {
        if (!identityKey || !name || this._generatedNames.get(identityKey) === name) return;
        this._generatedNames.set(identityKey, name);
        if (typeof localStorage === 'undefined') return;
        try {
            localStorage.setItem(GENERATED_NAMES_STORAGE_KEY, JSON.stringify([...this._generatedNames]));
        } catch {
            // Storage can be unavailable in private or restricted contexts.
        }
    }

    _sessionToAgentPayload(session, teamMembers) {
        const id = session.sessionId;
        const teamInfo = teamMembers ? teamMembers.get(session.agentId) : null;
        const agentName = teamInfo?.name || session.name || session.agentName || session.nickname || null;
        const status = this._resolveStatus(session);
        const lastSessionActivity = Number(session.lastActivity || 0) || null;
        const activityAgeMs = lastSessionActivity ? Math.max(0, Date.now() - lastSessionActivity) : null;
        const hasFreshTool = status === AgentStatus.WORKING && !!session.lastTool;

        // Team name is an explicit provider field. Do not infer it from project
        // paths; Codex/Gemini intentionally degrade to null.
        const teamName = teamInfo?.teamName
            || session.teamName
            || null;

        return {
            id,
            agentId: session.agentId || null,
            agentName,
            agentType: session.agentType || null,
            parentSessionId: session.parentSessionId || null,
            workflowId: session.workflowId || null,
            workflowName: session.workflowName || null,
            model: teamInfo?.model || session.model || 'unknown',
            effort: session.reasoningEffort || session.effort || null,
            status,
            role: teamInfo?.agentType || session.agentType || 'general',
            teamName,
            tokens: session.tokenUsage || session.tokens || session.usage || null,
            currentTool: hasFreshTool ? session.lastTool : null,
            currentToolInput: hasFreshTool ? session.lastToolInput || null : null,
            lastTool: session.lastTool || null,
            lastToolInput: session.lastToolInput || null,
            gitEvents: Array.isArray(session.gitEvents) ? session.gitEvents : [],
            permissionMode: session.permissionMode ?? null,
            turnState: session.turnState ?? 'unknown',
            pendingTool: session.pendingTool ?? null,
            waitReason: session.waitReason ?? null,
            awaitingSince: Number.isFinite(Number(session.awaitingSince)) ? Number(session.awaitingSince) : null,
            resident: session.resident === true,
            sendMessages: Array.isArray(session.sendMessages) ? session.sendMessages : [],
            lastSessionActivity,
            activityAgeMs,
            _lastMessage: session.lastMessage || null,
            lastMessage: session.lastMessage,
            name: agentName || null,
            _customName: !!agentName,
            projectPath: session.project || null,
            provider: session.provider || 'claude',
        };
    }

    _resolveStatus(session) {
        return resolveAgentStatus(session, {
            usage: this._usageGetter ? this._usageGetter() : null,
        });
    }

}
