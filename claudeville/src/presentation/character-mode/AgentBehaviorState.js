const MAX_RECENT_BUILDINGS = 5;

export class AgentBehaviorState {
    constructor({ now = Date.now } = {}) {
        this.now = typeof now === 'function' ? now : Date.now;
        this.state = 'roaming';
        this.intentId = null;
        this.building = null;
        this.reason = 'spawn';
        this.targetTile = null;
        this.arrivedAt = null;
        this.cooldownUntil = 0;
        this.lastRerouteAt = 0;
        this.recentBuildings = [];
        this.visitStartedAt = null;
        this.completedVisits = 0;
        this.totalDwellMs = 0;
        this.reroutes = 0;
    }

    setRoute({ state = 'traveling', intent = null, building = null, reason = null, targetTile = null } = {}) {
        const time = this.now();
        const intentId = intent?.id || null;
        this.finishVisit();
        if (this.intentId !== intentId || this.building !== building) {
            this.lastRerouteAt = time;
            this.reroutes++;
        }
        this.state = state;
        this.intentId = intentId;
        this.building = building || null;
        this.reason = reason || intent?.reason || (intent ? intent.source : 'ambient');
        this.targetTile = targetTile ? { ...targetTile } : null;
        this.arrivedAt = null;
        this.visitStartedAt = null;
        this.recordBuilding(building);
    }

    arrive({ state = 'performing', cooldownMs = 0 } = {}) {
        const time = this.now();
        this.state = state;
        this.arrivedAt = time;
        this.visitStartedAt = time;
        this.cooldownUntil = cooldownMs > 0 ? time + cooldownMs : 0;
    }

    transition(state, reason = null) {
        this.state = state;
        if (reason) this.reason = reason;
        const time = this.now();
        if (state === 'cooldown' && this.cooldownUntil <= time) {
            this.cooldownUntil = time + 1500;
        }
    }

    finishVisit() {
        if (this.visitStartedAt) {
            this.totalDwellMs += Math.max(0, this.now() - this.visitStartedAt);
            this.completedVisits++;
            this.visitStartedAt = null;
        }
    }

    recordBuilding(type) {
        if (!type) return;
        this.recentBuildings.push(type);
        if (this.recentBuildings.length > MAX_RECENT_BUILDINGS) this.recentBuildings.shift();
    }

    recentCount(type) {
        return this.recentBuildings.filter((entry) => entry === type).length;
    }

    snapshot() {
        return {
            state: this.state,
            intentId: this.intentId,
            building: this.building,
            reason: this.reason,
            targetTile: this.targetTile ? { ...this.targetTile } : null,
            arrivedAt: this.arrivedAt,
            cooldownUntil: this.cooldownUntil,
            lastRerouteAt: this.lastRerouteAt,
            recentBuildings: [...this.recentBuildings],
            completedVisits: this.completedVisits,
            totalDwellMs: this.totalDwellMs,
            reroutes: this.reroutes,
        };
    }
}

export default AgentBehaviorState;
