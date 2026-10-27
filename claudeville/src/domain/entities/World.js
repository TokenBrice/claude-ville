import { eventBus } from '../events/DomainEvent.js';
import { bucketAgents, bucketCounts } from '../services/SignalLedger.js';

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

    applyVisitLoads(loadsByType, now = Date.now()) {
        if (!loadsByType || typeof loadsByType !== 'object') return;
        const entries = loadsByType instanceof Map
            ? loadsByType.entries()
            : Object.entries(loadsByType);
        for (const [type, entry] of entries) {
            const building = this.buildings.get(type);
            if (!building || typeof building.updateVisitLoad !== 'function') continue;
            const load = Number.isFinite(Number(entry?.load))
                ? Number(entry.load)
                : Math.max(Number(entry?.reserved) || 0, Number(entry?.occupied) || 0);
            const changed = building.updateVisitLoad({
                load,
                capacity: entry?.capacity ?? null,
                now,
            });
            if (changed) {
                eventBus.emit('building:congestion', {
                    buildingType: building.type,
                    building,
                    congestion: { ...building.congestion },
                });
            }
        }
    }

    // The top bar's KPIs (UI-1, Q4): `completed` folds into `idle` with every
    // other quiet status, so working + idle + waiting + attention is the
    // agent count. A departed villager (projected as completed while it walks
    // out) is no longer an agent: it is in neither the counts nor the total.
    getStats() {
        const buckets = bucketAgents(this.agents);
        const counts = bucketCounts(buckets);
        const departed = buckets.quiet.filter(agent => agent?.isDeparted).length;
        return {
            working: counts.working,
            idle: counts.quiet - departed,
            waiting: counts.watchlist,
            errored: counts.errors,
            attention: counts.actionable,
            total: this.agents.size - departed,
            needsYou: counts.needsYou,
            errors: counts.errors,
            quota: counts.quota,
            watchlist: counts.watchlist,
        };
    }

    get activeTime() {
        return Math.floor((Date.now() - this.startTime) / 1000);
    }
}
