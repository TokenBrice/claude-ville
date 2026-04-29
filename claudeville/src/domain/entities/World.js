import { eventBus } from '../events/DomainEvent.js';
import { AgentStatus, normalizeAgentStatus } from '../value-objects/AgentStatus.js';

export class World {
    constructor() {
        this.agents = new Map();
        this.buildings = new Map();
        this.startTime = Date.now();
    }

    addAgent(agent) {
        this.agents.set(agent.id, agent);
        eventBus.emit('agent:added', agent);
    }

    removeAgent(id) {
        const agent = this.agents.get(id);
        if (agent) {
            this.agents.delete(id);
            eventBus.emit('agent:removed', agent);
        }
    }

    updateAgent(id, data) {
        const agent = this.agents.get(id);
        if (agent) {
            agent.update(data);
            eventBus.emit('agent:updated', agent);
        }
    }

    addBuilding(building) {
        this.buildings.set(building.type, building);
    }

    getStats() {
        let totalTokens = 0;
        let totalCost = 0;
        let working = 0;
        let idle = 0;
        let waiting = 0;

        for (const agent of this.agents.values()) {
            totalTokens += (agent.tokens.input || 0) + (agent.tokens.output || 0);
            totalCost += agent.cost;
            const status = normalizeAgentStatus(agent.status);
            if (status === AgentStatus.WORKING) working++;
            else if (status === AgentStatus.IDLE) idle++;
            else if (status === AgentStatus.WAITING) waiting++;
        }

        return { totalTokens, totalCost, working, idle, waiting, total: this.agents.size };
    }

    get activeTime() {
        return Math.floor((Date.now() - this.startTime) / 1000);
    }
}
