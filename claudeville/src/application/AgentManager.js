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
        const agentName = teamInfo?.name || session.name || session.agentName || session.nickname || null;
        const status = this._resolveStatus(session);
        const lastSessionActivity = Number(session.lastActivity || 0) || null;
        const activityAgeMs = lastSessionActivity ? Math.max(0, Date.now() - lastSessionActivity) : null;
        const hasFreshTool = status === AgentStatus.WORKING && !!session.lastTool;

        // Team name: get it from teamInfo or extract it from the project path
        const teamName = teamInfo?.teamName
            || (session.project ? session.project.split('/').filter(Boolean).pop() : null);

        const agentData = {
            agentId: session.agentId || null,
            agentName,
            agentType: session.agentType || null,
            parentSessionId: session.parentSessionId || null,
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
            lastSessionActivity,
            activityAgeMs,
            _lastMessage: session.lastMessage || null,
            name: agentName || null,
            _customName: !!agentName,
        };

        if (this.world.agents.has(id)) {
            this.world.updateAgent(id, agentData);
        } else {
            const agent = new Agent({
                id,
                name: agentName,
                model: agentData.model,
                effort: agentData.effort,
                status: agentData.status,
                role: agentData.role,
                tokens: agentData.tokens,
                teamName,
                projectPath: session.project || null,
                currentTool: agentData.currentTool,
                currentToolInput: agentData.currentToolInput,
                lastTool: agentData.lastTool,
                lastToolInput: agentData.lastToolInput,
                lastMessage: session.lastMessage,
                provider: session.provider || 'claude',
                agentId: agentData.agentId,
                agentName: agentData.agentName,
                agentType: agentData.agentType,
                parentSessionId: agentData.parentSessionId,
                lastSessionActivity,
                activityAgeMs,
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

}
