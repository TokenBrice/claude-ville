import { AgentStatus, normalizeAgentStatus } from '../value-objects/AgentStatus.js';
import { Position } from '../value-objects/Position.js';
import { Appearance } from '../value-objects/Appearance.js';
import { i18n } from '../../config/i18n.js';
import { TokenUsage } from '../value-objects/TokenUsage.js';
import { buildingForTool, compactToolInput, toolActionLabel } from '../services/ToolIdentity.js';

const AGENT_NAMES_EN = [
    'Atlas', 'Nova', 'Cipher', 'Pixel', 'Spark',
    'Bolt', 'Echo', 'Flux', 'Helix', 'Onyx',
    'Prism', 'Qubit', 'Rune', 'Sage', 'Vex',
];

export class Agent {
    constructor({
        id,
        name,
        model,
        effort,
        status,
        role,
        tokens,
        messages,
        teamName,
        projectPath,
        currentTool,
        currentToolInput,
        lastTool,
        lastToolInput,
        lastMessage,
        gitEvents,
        provider,
        agentId,
        agentName,
        agentType,
        parentSessionId,
        lastSessionActivity,
        activityAgeMs,
    }) {
        this.id = id;
        this._customName = !!name; // Whether the name was assigned by a team
        this.name = name || this.generateName();
        this.agentId = agentId || null;
        this.agentName = agentName || name || null;
        this.agentType = agentType || null;
        this.parentSessionId = parentSessionId || null;
        this.model = model || 'unknown';
        this.effort = effort || null;
        this.status = normalizeAgentStatus(status);
        this.role = role || 'general';
        this.tokens = TokenUsage.normalize(tokens);
        this.messages = messages || [];
        this.teamName = teamName;
        this.projectPath = projectPath;
        this.provider = provider || 'claude';
        this.currentTool = currentTool || null;
        this.currentToolInput = currentToolInput || null;
        this.lastTool = lastTool || currentTool || null;
        this.lastToolInput = lastToolInput || currentToolInput || null;
        this.gitEvents = Array.isArray(gitEvents) ? gitEvents : [];
        this.lastSessionActivity = lastSessionActivity || null;
        this.activityAgeMs = Number.isFinite(Number(activityAgeMs)) ? Number(activityAgeMs) : null;
        this._lastMessage = lastMessage || null;
        this.appearance = Appearance.fromHash(id);
        this.position = new Position(20 + Math.random() * 10, 20 + Math.random() * 10);
        this.targetPosition = null;
        this.walkFrame = 0;
        this.lastActive = Date.now();
    }

    get isWorking() {
        return this.status === AgentStatus.WORKING;
    }

    get isIdle() {
        return this.status === AgentStatus.IDLE;
    }

    get isWaiting() {
        return this.status === AgentStatus.WAITING;
    }

    get isSubagent() {
        return !!this.parentSessionId || (this.agentType && this.agentType !== 'main');
    }

    get isToolFresh() {
        return this.status === AgentStatus.WORKING && !!this.currentTool;
    }

    get cost() {
        return TokenUsage.estimateCost(this.tokens, this.model, this.provider);
    }

    get lastMessage() {
        return this._lastMessage || this.messages[this.messages.length - 1] || null;
    }

    get displayName() {
        const raw = String(this.name || '').trim();
        if (!raw) {
            return Agent.generateNameForLang(Appearance.hashCode(this.id), i18n.lang);
        }
        const CAP = 14;
        if (raw.length <= CAP) return raw;
        const words = raw.split(/\s+/);
        let out = '';
        for (const w of words) {
            const next = out ? `${out} ${w}` : w;
            if (next.length > CAP - 1) break;
            out = next;
        }
        if (!out) out = raw.slice(0, CAP - 1);
        return out + '…';
    }

    update(data) {
        const updates = { ...(data || {}) };
        if (Object.prototype.hasOwnProperty.call(updates, 'tokens')) {
            updates.tokens = TokenUsage.normalize(updates.tokens);
        }
        if (Object.prototype.hasOwnProperty.call(updates, 'status')) {
            updates.status = normalizeAgentStatus(updates.status, this.status || AgentStatus.IDLE);
        }
        if (Object.prototype.hasOwnProperty.call(updates, 'name') && !updates.name) {
            updates.name = this.generateName();
        }
        Object.assign(this, updates);
        this.lastActive = Date.now();
    }

    /**
     * Return the target building type for the current tool
     */
    get targetBuildingType() {
        const toolName = this.currentTool;
        if (!toolName) return null;
        return buildingForTool(toolName, this.currentToolInput || this.lastToolInput);
    }

    get lastKnownBuildingType() {
        return this.targetBuildingType
            || buildingForTool(this.lastTool, this.lastToolInput || this.currentToolInput)
            || null;
    }

    /**
     * Text to display in the speech bubble (capped at ~24 chars).
     */
    get bubbleText() {
        const CAP = 24;
        if (this.currentTool) {
            const toolLabel = toolActionLabel(this.currentTool);
            const detail = compactToolInput(this.currentToolInput, 18);
            const full = detail ? `${toolLabel} ${detail}` : toolLabel;
            return Agent._truncate(full, CAP);
        }
        if (this._lastMessage) return Agent._truncate(this._lastMessage, CAP);
        return null;
    }

    static _truncate(s, cap) {
        const str = String(s);
        if (str.length <= cap) return str;
        return str.slice(0, cap - 1) + '…';
    }

    generateName() {
        const hash = Appearance.hashCode(this.id);
        return Agent.generateNameForLang(hash, i18n.lang);
    }

    static generateNameForLang(hash, lang) {
        const h = Math.abs(hash);
        return AGENT_NAMES_EN[h % AGENT_NAMES_EN.length];
    }

}
