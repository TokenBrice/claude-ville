import { eventBus } from '../../domain/events/DomainEvent.js';

const MAX_RECENT_BUILDINGS = 5;
const FAMILY_PLAZA_TTL_MS = 30000;
const PLAN_MODE_PERSIST_MS = 1000;
const RETRY_WINDOW_MS = 20000;
const RETRY_BUFFER_LIMIT = 8;
const RETRY_INPUT_NORMALIZE_LIMIT = 64;

function normalizeToolInput(input) {
    if (input == null) return '';
    if (typeof input === 'string') {
        return input.replace(/\s+/g, ' ').trim().slice(0, RETRY_INPUT_NORMALIZE_LIMIT);
    }
    try {
        return JSON.stringify(input).slice(0, RETRY_INPUT_NORMALIZE_LIMIT);
    } catch {
        return String(input).slice(0, RETRY_INPUT_NORMALIZE_LIMIT);
    }
}

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
        this.familyPlazaPreference = null;
        this.planMode = false;
        this._lastPlanReasonAt = 0;
        this._lastToolKey = null;
        this._retryBuffer = [];
        this.lastRetryAt = 0;
        this.lastRetryCount = 0;
        this.lastRetryTool = null;
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

    setFamilyPlazaPreference(tileX, tileY) {
        const x = Number(tileX);
        const y = Number(tileY);
        if (!Number.isFinite(x) || !Number.isFinite(y)) return;
        this.familyPlazaPreference = { tileX: x, tileY: y, ts: this.now() };
    }

    getFamilyPlazaPreference() {
        if (!this.familyPlazaPreference) return null;
        if (this.now() - this.familyPlazaPreference.ts > FAMILY_PLAZA_TTL_MS) {
            this.familyPlazaPreference = null;
            return null;
        }
        return { ...this.familyPlazaPreference };
    }

    observeToolTransition({ agentId = null, tool = null, input = null, reason = null } = {}) {
        const toolKey = String(tool || '').trim();
        const time = this.now();

        if (reason === 'plan-mode-enter') {
            this.planMode = true;
            this._lastPlanReasonAt = time;
        } else if (reason === 'plan-mode-exit') {
            this.planMode = false;
            this._lastPlanReasonAt = time;
        } else if (this.planMode && toolKey && toolKey !== this._lastToolKey) {
            if (time - this._lastPlanReasonAt > PLAN_MODE_PERSIST_MS) {
                this.planMode = false;
            }
        }

        if (toolKey) {
            const normalized = normalizeToolInput(input);
            const key = `${toolKey}${normalized}`;
            const cutoff = time - RETRY_WINDOW_MS;
            this._retryBuffer = this._retryBuffer.filter((entry) => entry.ts >= cutoff);
            const priorMatches = this._retryBuffer.filter((entry) => entry.key === key);
            this._retryBuffer.push({ key, ts: time });
            if (this._retryBuffer.length > RETRY_BUFFER_LIMIT) {
                this._retryBuffer.splice(0, this._retryBuffer.length - RETRY_BUFFER_LIMIT);
            }
            if (priorMatches.length >= 1) {
                const retryCount = priorMatches.length + 1;
                this.lastRetryAt = time;
                this.lastRetryCount = retryCount;
                this.lastRetryTool = toolKey;
                if (agentId) {
                    eventBus.emit('tool:retried', {
                        agentId,
                        tool: toolKey,
                        retryCount,
                        ts: time,
                    });
                }
            }
        }

        this._lastToolKey = toolKey || this._lastToolKey;
    }

    isRetryGlyphActive(windowMs = 6000) {
        return this.lastRetryAt > 0 && (this.now() - this.lastRetryAt) <= windowMs;
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
            familyPlazaPreference: this.familyPlazaPreference ? { ...this.familyPlazaPreference } : null,
            planMode: this.planMode,
            lastRetryAt: this.lastRetryAt,
            lastRetryCount: this.lastRetryCount,
            lastRetryTool: this.lastRetryTool,
        };
    }
}

export default AgentBehaviorState;
