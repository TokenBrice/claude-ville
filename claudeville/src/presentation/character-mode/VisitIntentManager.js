import { classifyTool, compactToolLabel as compactLabel } from '../../domain/services/ToolIdentity.js';
import { normalizeGitEvent, parseEventTime } from '../shared/GitEventIdentity.js';

const DEFAULT_TTLS = Object.freeze({
    chat: { priority: 100, ttlMs: 30000, stickyMs: 30000 },
    alert: { priority: 90, ttlMs: 45000, stickyMs: 10000 },
    git: { priority: 85, ttlMs: 90000, stickyMs: 20000 },
    handoff: { priority: 82, ttlMs: 45000, stickyMs: 12000 },
    tool: { priority: 80, ttlMs: 30000, stickyMs: 8000 },
    token: { priority: 65, ttlMs: 25000, stickyMs: 8000 },
    team: { priority: 60, ttlMs: 45000, stickyMs: 12000 },
    subagent: { priority: 60, ttlMs: 45000, stickyMs: 12000 },
    quota: { priority: 50, ttlMs: 60000, stickyMs: 10000 },
    ambient: { priority: 10, ttlMs: 20000, stickyMs: 0 },
});

const TOKEN_DELTA_THRESHOLD = 128;
const CONTEXT_PRESSURE_THRESHOLD = 0.82;
const MAX_SEEN_GIT_EVENTS = 600;

function timeNow() {
    return Date.now();
}

function agentListFrom(input, world = null) {
    const source = input || world?.agents || [];
    if (source?.values) return Array.from(source.values());
    if (Array.isArray(source)) return source;
    if (source && typeof source[Symbol.iterator] === 'function') return Array.from(source);
    return [];
}

function tokenTotal(agent) {
    const tokens = agent?.tokens || {};
    const input = Number(tokens.input ?? tokens.totalInput ?? 0) || 0;
    const output = Number(tokens.output ?? tokens.totalOutput ?? 0) || 0;
    const cacheRead = Number(tokens.cacheRead ?? 0) || 0;
    const cacheCreate = Number(tokens.cacheCreate ?? tokens.cacheWrite ?? 0) || 0;
    return input + output + cacheRead + cacheCreate;
}

function contextRatio(agent) {
    const tokens = agent?.tokens || {};
    const current = Number(tokens.contextWindow ?? 0) || 0;
    const max = Number(tokens.contextWindowMax ?? 0) || 0;
    if (current <= 0 || max <= 0) return 0;
    return Math.max(0, Math.min(1, current / max));
}

function intentSort(a, b, now) {
    const aSticky = a.stickyUntil > now ? 1 : 0;
    const bSticky = b.stickyUntil > now ? 1 : 0;
    if (a.priority !== b.priority) return b.priority - a.priority;
    if (aSticky !== bSticky) return bSticky - aSticky;
    if (a.confidence !== b.confidence) return b.confidence - a.confidence;
    return b.createdAt - a.createdAt;
}

export class VisitIntentManager {
    constructor({ world = null, now = null } = {}) {
        this.world = world;
        this.now = typeof now === 'function' ? now : timeNow;
        this.intentsByAgent = new Map();
        this.tokenSnapshots = new Map();
        this.seenGitEventIds = new Set();
        this.lastForgeByAgent = new Map();
        this.lastToolBuildingByAgent = new Map();
    }

    update(agents = null, now = this.now()) {
        const currentNow = Number.isFinite(Number(now)) ? Number(now) : this.now();
        const activeAgents = agentListFrom(agents, this.world);
        const activeIds = new Set();

        for (const agent of activeAgents) {
            if (!agent?.id) continue;
            activeIds.add(agent.id);
            this._deriveAgentIntents(agent, currentNow);
        }
        this._deriveGlobalIntents(activeAgents, currentNow);

        for (const agentId of Array.from(this.intentsByAgent.keys())) {
            if (!activeIds.has(agentId)) this.intentsByAgent.delete(agentId);
        }
        for (const agentId of Array.from(this.tokenSnapshots.keys())) {
            if (!activeIds.has(agentId)) this.tokenSnapshots.delete(agentId);
        }
        for (const agentId of Array.from(this.lastForgeByAgent.keys())) {
            if (!activeIds.has(agentId)) this.lastForgeByAgent.delete(agentId);
        }
        for (const agentId of Array.from(this.lastToolBuildingByAgent.keys())) {
            if (!activeIds.has(agentId)) this.lastToolBuildingByAgent.delete(agentId);
        }

        this._trimSeenGitEvents();
        this._expireIntents(currentNow);
        return this.snapshot(currentNow);
    }

    getIntentForAgent(agentId, now = this.now()) {
        const intents = [...(this.intentsByAgent.get(agentId)?.values() || [])]
            .filter((intent) => intent.expiresAt > now);
        if (!intents.length) return null;
        return intents.sort((a, b) => intentSort(a, b, now))[0] || null;
    }

    snapshot(now = this.now()) {
        const intents = [];
        for (const map of this.intentsByAgent.values()) {
            for (const intent of map.values()) {
                if (intent.expiresAt <= now) continue;
                intents.push({ ...intent, msRemaining: Math.max(0, intent.expiresAt - now) });
            }
        }
        intents.sort((a, b) => (a.agentId || '').localeCompare(b.agentId || '') || intentSort(a, b, now));
        return {
            now,
            agents: this.intentsByAgent.size,
            intents,
            tokenSnapshots: [...this.tokenSnapshots.entries()].map(([agentId, total]) => ({ agentId, total })),
            seenGitEvents: this.seenGitEventIds.size,
            lastForgeAgents: this.lastForgeByAgent.size,
        };
    }

    debug(now = this.now()) {
        return this.snapshot(now);
    }

    debugSnapshot(now = this.now()) {
        return this.snapshot(now);
    }

    dispose() {
        this.intentsByAgent.clear();
        this.tokenSnapshots.clear();
        this.seenGitEventIds.clear();
        this.lastForgeByAgent.clear();
        this.lastToolBuildingByAgent.clear();
    }

    _deriveAgentIntents(agent, now) {
        this._deriveToolIntent(agent, now);
        this._deriveTokenIntents(agent, now);
        this._deriveGitIntents(agent, now);
        this._deriveRelationshipIntents(agent, now);
        this._deriveLongRunningIntents(agent, now);
    }

    _deriveToolIntent(agent, now) {
        const tool = agent.currentTool || null;
        if (!tool) return;
        if (String(agent.status || '').toLowerCase() !== 'working') return;
        const classified = classifyTool(tool, agent.currentToolInput ?? agent.lastToolInput);
        if (!classified?.building) return;
        this.lastToolBuildingByAgent.set(agent.id, {
            building: classified.building,
            reason: classified.reason,
            at: now,
        });
        if (classified.building === 'forge' && /edit|write|patch|modify|refactor|generate|asset/i.test(classified.reason || '')) {
            this.lastForgeByAgent.set(agent.id, { at: now, label: classified.label || compactLabel(tool, 'forge') });
        }
        if (classified.building === 'taskboard') {
            const forge = this.lastForgeByAgent.get(agent.id);
            if (forge && now - forge.at <= 60000) {
                this._upsertIntent(agent.id, {
                    source: 'handoff',
                    sourceKey: `forge-taskboard:${Math.floor(forge.at / 1000)}`,
                    building: 'taskboard',
                    reason: 'validate-after-edit',
                    confidence: 0.9,
                    label: forge.label || 'forge-check',
                    payload: { from: 'forge', to: 'taskboard', forgeAt: forge.at },
                }, now);
            }
        }

        this._upsertIntent(agent.id, {
            source: 'tool',
            sourceKey: [
                tool,
                JSON.stringify(agent.currentToolInput ?? ''),
                agent.lastSessionActivity || '',
            ].join('|'),
            building: classified.building,
            reason: classified.reason,
            confidence: classified.confidence,
            label: classified.label || compactLabel(tool, 'tool'),
            payload: {
                tool,
                input: agent.currentToolInput ?? null,
                sessionId: agent.sessionId || agent.agentId || agent.id,
            },
        }, now);
    }

    _deriveTokenIntents(agent, now) {
        const current = tokenTotal(agent);
        const previous = this.tokenSnapshots.get(agent.id);
        this.tokenSnapshots.set(agent.id, current);

        if (previous != null && current > previous) {
            const delta = current - previous;
            if (delta >= TOKEN_DELTA_THRESHOLD) {
                this._upsertIntent(agent.id, {
                    source: 'token',
                    sourceKey: `${Math.floor(current / TOKEN_DELTA_THRESHOLD)}:${delta}`,
                    building: 'mine',
                    reason: 'token-delta',
                    confidence: Math.min(0.95, 0.55 + delta / 3000),
                    label: `+${delta}`,
                    payload: { delta, total: current, ratio: contextRatio(agent) },
                }, now);
            }
        }

        const ratio = contextRatio(agent);
        if (ratio >= CONTEXT_PRESSURE_THRESHOLD) {
            this._upsertIntent(agent.id, {
                source: 'quota',
                sourceKey: `context:${Math.floor(ratio * 100)}`,
                building: 'mine',
                reason: 'context-pressure',
                confidence: Math.min(0.95, ratio),
                label: `${Math.round(ratio * 100)}%`,
                payload: { ratio, total: current },
            }, now);
        }
    }

    _deriveGitIntents(agent, now) {
        const sources = [agent.gitEvents, agent.git?.events, agent.vcsEvents].filter(Array.isArray);
        for (const source of sources) {
            source.forEach((event, index) => {
                const normalized = normalizeGitEvent(event, agent, index, {
                    fallbackTimestamp: parseEventTime(agent.lastSessionActivity, now),
                    maxLabelChars: 18,
                    ellipsis: '...',
                });
                if (!normalized) return;
                const sourceKey = `${normalized.sessionId}:${normalized.id}`;
                const ageMs = Math.max(0, now - normalized.timestamp);
                const isFresh = ageMs < DEFAULT_TTLS.git.ttlMs && !this.seenGitEventIds.has(sourceKey);
                if (!isFresh) return;
                this.seenGitEventIds.add(sourceKey);

                this._upsertIntent(agent.id, {
                    source: 'git',
                    sourceKey,
                    building: 'harbor',
                    reason: normalized.type === 'push' ? 'push' : 'commit',
                    confidence: normalized.type === 'push' ? 0.94 : 0.86,
                    label: normalized.label,
                    payload: normalized,
                    createdAt: normalized.timestamp || now,
                }, now);

                if (normalized.type === 'push' && normalized.status === 'failed') {
                    this._upsertIntent(agent.id, {
                        source: 'alert',
                        sourceKey: `failed-push:${sourceKey}`,
                        building: 'watchtower',
                        reason: 'failed-push-watch',
                        confidence: 0.94,
                        label: normalized.label || 'push failed',
                        payload: normalized,
                        createdAt: normalized.timestamp || now,
                    }, now);
                }
            });
        }
    }

    _deriveRelationshipIntents(agent, now) {
        if (agent.parentSessionId) {
            const parentIntent = this.getIntentForAgent(agent.parentSessionId, now);
            const parentLast = this.lastToolBuildingByAgent.get(agent.parentSessionId);
            const parentBuilding = parentIntent?.building || parentLast?.building || 'command';
            this._upsertIntent(agent.id, {
                source: 'subagent',
                sourceKey: `parent:${agent.parentSessionId}:${parentBuilding}`,
                building: parentBuilding,
                reason: parentBuilding === 'command' ? 'join-parent' : 'follow-parent-work',
                confidence: 0.72,
                label: 'subagent',
                payload: { parentId: agent.parentSessionId, parentBuilding },
            }, now);
        }
        if (agent.teamName) {
            this._upsertIntent(agent.id, {
                source: 'team',
                sourceKey: String(agent.teamName),
                building: 'command',
                reason: 'join-team',
                confidence: 0.68,
                label: compactLabel(agent.teamName, 'team'),
                payload: { teamName: agent.teamName },
            }, now);
        }
    }

    _deriveLongRunningIntents(agent, now) {
        const status = String(agent?.status || '').toLowerCase();
        const age = Number(agent?.activityAgeMs);
        if (status === 'waiting' && Number.isFinite(age) && age > 120000) {
            this._upsertIntent(agent.id, {
                source: 'alert',
                sourceKey: `long-wait:${Math.floor(age / 60000)}`,
                building: 'watchtower',
                reason: 'long-wait-watch',
                confidence: 0.56,
                label: `${Math.floor(age / 60000)}m wait`,
                payload: { ageMs: age },
                priority: 52,
            }, now);
        }
        if (status === 'working' && Number.isFinite(age) && age > 300000) {
            const last = this.lastToolBuildingByAgent.get(agent.id);
            this._upsertIntent(agent.id, {
                source: 'team',
                sourceKey: `long-work:${last?.building || 'work'}:${Math.floor(age / 300000)}`,
                building: last?.building || agent.lastKnownBuildingType || 'command',
                reason: 'long-work-shift',
                confidence: 0.52,
                label: `${Math.floor(age / 60000)}m work`,
                payload: { ageMs: age },
                priority: 48,
            }, now);
        }
    }

    _deriveGlobalIntents(agents, now) {
        const working = agents.filter((agent) => String(agent?.status || '').toLowerCase() === 'working');
        if (working.length >= 4) {
            const sentries = agents
                .filter((agent) => agent?.id && String(agent.status || '').toLowerCase() !== 'working')
                .slice(0, 2);
            for (const agent of sentries) {
                this._upsertIntent(agent.id, {
                    source: 'alert',
                    sourceKey: `active-count:${working.length}`,
                    building: 'watchtower',
                    reason: 'high-activity-watch',
                    confidence: 0.58,
                    label: `${working.length} active`,
                    payload: { activeWorkingCount: working.length },
                    priority: 54,
                }, now);
            }
        }

        const quotaPressure = agents.some((agent) => contextRatio(agent) >= CONTEXT_PRESSURE_THRESHOLD);
        if (quotaPressure) {
            const sentinel = agents.find((agent) => (
                agent?.id &&
                contextRatio(agent) < CONTEXT_PRESSURE_THRESHOLD &&
                ['idle', 'waiting'].includes(String(agent.status || '').toLowerCase())
            ));
            if (sentinel) {
                this._upsertIntent(sentinel.id, {
                    source: 'quota',
                    sourceKey: 'quota-sentinel',
                    building: 'mine',
                    reason: 'resource-check',
                    confidence: 0.5,
                    label: 'quota watch',
                    payload: { sentinel: true },
                    priority: 45,
                }, now);
            }
        }
    }

    _trimSeenGitEvents() {
        if (this.seenGitEventIds.size <= MAX_SEEN_GIT_EVENTS) return;
        this.seenGitEventIds = new Set([...this.seenGitEventIds].slice(-Math.floor(MAX_SEEN_GIT_EVENTS * 0.75)));
    }

    _upsertIntent(agentId, draft, now) {
        if (!agentId || !draft?.building || !draft?.source) return null;
        const meta = DEFAULT_TTLS[draft.source] || DEFAULT_TTLS.ambient;
        const createdAt = Number.isFinite(Number(draft.createdAt)) ? Number(draft.createdAt) : now;
        const sourceKey = String(draft.sourceKey || draft.reason || draft.building);
        const id = `${agentId}:${draft.source}:${sourceKey}`;
        const map = this._agentIntentMap(agentId);
        const previous = map.get(id);
        const intent = {
            id,
            agentId,
            building: draft.building,
            source: draft.source,
            reason: draft.reason || draft.source,
            priority: Number.isFinite(Number(draft.priority)) ? Number(draft.priority) : meta.priority,
            confidence: Math.max(0, Math.min(1, Number(draft.confidence ?? 0.5))),
            label: draft.label || '',
            createdAt: previous?.createdAt || createdAt,
            updatedAt: now,
            expiresAt: Math.max(previous?.expiresAt || 0, now + meta.ttlMs),
            stickyUntil: Math.max(previous?.stickyUntil || 0, now + meta.stickyMs),
            targetTile: draft.targetTile || previous?.targetTile || null,
            payload: draft.payload || {},
        };
        map.set(id, intent);
        return intent;
    }

    _agentIntentMap(agentId) {
        let map = this.intentsByAgent.get(agentId);
        if (!map) {
            map = new Map();
            this.intentsByAgent.set(agentId, map);
        }
        return map;
    }

    _expireIntents(now) {
        for (const [agentId, map] of this.intentsByAgent.entries()) {
            for (const [id, intent] of map.entries()) {
                if (intent.expiresAt <= now) map.delete(id);
            }
            if (!map.size) this.intentsByAgent.delete(agentId);
        }
    }
}

export { classifyTool };
