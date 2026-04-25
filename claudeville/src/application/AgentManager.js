import { Agent } from '../domain/entities/Agent.js';
import { AgentStatus } from '../domain/value-objects/AgentStatus.js';
import { eventBus } from '../domain/events/DomainEvent.js';

export class AgentManager {
    constructor(world, dataSource) {
        this.world = world;
        this.dataSource = dataSource;
        this._teamMembers = new Map();
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
        const id = session.sessionId;
        const teamInfo = teamMembers ? teamMembers.get(session.agentId) : null;

        // Team name: get it from teamInfo or extract it from the project path
        const teamName = teamInfo?.teamName
            || (session.project ? session.project.split('/').filter(Boolean).pop() : null);

        const agentData = {
            model: teamInfo?.model || session.model || 'unknown',
            effort: session.reasoningEffort || session.effort || null,
            status: this._resolveStatus(session),
            role: teamInfo?.agentType || session.agentType || 'general',
            teamName,
            tokens: this._normalizeTokens(session.tokenUsage || session.tokens || session.usage),
            currentTool: session.lastTool || null,
            currentToolInput: session.lastToolInput || null,
            _lastMessage: session.lastMessage || null,
        };

        if (this.world.agents.has(id)) {
            this.world.updateAgent(id, agentData);
        } else {
            const agent = new Agent({
                id,
                name: teamInfo?.name || null,
                model: agentData.model,
                effort: agentData.effort,
                status: agentData.status,
                role: agentData.role,
                tokens: agentData.tokens,
                teamName,
                projectPath: session.project || null,
                lastTool: session.lastTool,
                lastToolInput: session.lastToolInput,
                lastMessage: session.lastMessage,
                provider: session.provider || 'claude',
            });
            this.world.addAgent(agent);
        }
    }

    _resolveStatus(session) {
        if (session.status === 'active') {
            const age = Date.now() - (session.lastActivity || 0);
            if (age < 30000) return AgentStatus.WORKING;
            if (age < 120000) return AgentStatus.WAITING;
            return AgentStatus.IDLE;
        }
        return AgentStatus.IDLE;
    }

    _normalizeTokens(raw) {
        if (!raw) return { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
        return {
            input: this._number(raw.input ?? raw.totalInput ?? raw.input_tokens ?? raw.prompt_tokens),
            output: this._number(raw.output ?? raw.totalOutput ?? raw.output_tokens ?? raw.completion_tokens),
            cacheRead: this._number(raw.cacheRead ?? raw.cache_read_input_tokens ?? raw.cached_input_tokens),
            cacheCreate: this._number(raw.cacheCreate ?? raw.cache_creation_input_tokens),
        };
    }

    _number(value) {
        const n = Number(value);
        return Number.isFinite(n) ? n : 0;
    }
}
