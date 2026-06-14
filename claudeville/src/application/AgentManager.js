import { Agent } from '../domain/entities/Agent.js';
import { AgentStatus, statusFromSessionActivity } from '../domain/value-objects/AgentStatus.js';
import { eventBus } from '../domain/events/DomainEvent.js';

// Heuristic gate: lastMessage text-match for ERRORED is loud (false positives
// from agents echoing user prose). Keep off by default; flip when paired with
// a stricter classifier.
const ENABLE_ERROR_HEURISTIC = false;
const WAITING_ON_USER_TOOLS = new Set([
    'AskUserQuestion',
    'request_user_input',
    'functions.request_user_input',
]);
const ERROR_MESSAGE_PATTERN = /^FAIL[: ]|error:|exception\b|timeout/i;
const GIT_FAIL_WINDOW_MS = 60_000;
const RATE_LIMIT_THRESHOLD = 0.95;

export class AgentManager {
    constructor(world, dataSource) {
        this.world = world;
        this.dataSource = dataSource;
        this._teamMembers = new Map();
        this._usageGetter = null;
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

    async loadInitialData() {
        try {
            const [sessions, teams] = await Promise.all([
                this.dataSource.getSessions(),
                this.dataSource.getTeams(),
            ]);

            this._teamMembers = this._buildTeamMembers(teams);

            for (const session of sessions) {
                this._upsertAgent(session, this._teamMembers);
            }

            console.log(`[AgentManager] ${this.world.agents.size} agents loaded`);
        } catch (err) {
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

        // Handle agents missing from the server list
        const toRemove = [];
        for (const [id, agent] of this.world.agents) {
            if (!currentIds.has(id)) {
                if (agent.status === AgentStatus.IDLE) {
                    // Remove if already IDLE
                    toRemove.push(id);
                } else {
                    // Set to IDLE first if still active
                    this.world.updateAgent(id, { status: AgentStatus.IDLE, currentTool: null, currentToolInput: null });
                }
            }
        }
        for (const id of toRemove) {
            this.world.removeAgent(id);
        }
    }

    _upsertAgent(session, teamMembers) {
        const payload = this._sessionToAgentPayload(session, teamMembers);
        const { id } = payload;

        if (this.world.agents.has(id)) {
            const { id: _id, projectPath: _projectPath, provider: _provider, lastMessage: _lastMessage, ...agentData } = payload;
            this.world.updateAgent(id, agentData);
        } else {
            this.world.addAgent(new Agent(payload));
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
        const base = statusFromSessionActivity(session);

        // Priority: RATE_LIMITED > ERRORED > WAITING_ON_USER > base.
        if (base === AgentStatus.WORKING && this._isRateLimited()) {
            return AgentStatus.RATE_LIMITED;
        }
        if (this._isErrored(session)) {
            return AgentStatus.ERRORED;
        }
        if (this._isWaitingOnUser(session, base)) {
            return AgentStatus.WAITING_ON_USER;
        }
        return base;
    }

    _isRateLimited() {
        if (!this._usageGetter) return false;
        const usage = this._usageGetter();
        const fiveHour = Number(usage?.quota?.fiveHour);
        return Number.isFinite(fiveHour) && fiveHour > RATE_LIMIT_THRESHOLD;
    }

    _isErrored(session) {
        const events = Array.isArray(session.gitEvents) ? session.gitEvents : [];
        if (events.length) {
            const cutoff = Date.now() - GIT_FAIL_WINDOW_MS;
            for (const event of events) {
                const ts = Number(event?.completedAt || event?.ts || 0);
                if (!ts || ts < cutoff) continue;
                if (event?.status === 'failed' || event?.success === false) {
                    return true;
                }
            }
        }
        if (ENABLE_ERROR_HEURISTIC) {
            const msg = String(session.lastMessage || '').trim();
            if (msg && ERROR_MESSAGE_PATTERN.test(msg)) return true;
        }
        return false;
    }

    _isWaitingOnUser(session, baseStatus) {
        const tool = session.lastTool || null;
        if (tool && WAITING_ON_USER_TOOLS.has(tool)) return true;
        if (baseStatus === AgentStatus.WAITING) {
            const msg = String(session.lastMessage || '').trim();
            if (msg && msg.endsWith('?')) return true;
        }
        return false;
    }

}
