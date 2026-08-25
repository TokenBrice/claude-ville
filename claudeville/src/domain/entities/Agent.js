import { AgentStatus, normalizeAgentStatus } from '../value-objects/AgentStatus.js';
import { Position } from '../value-objects/Position.js';
import { Appearance } from '../value-objects/Appearance.js';
import { AgentBiography } from '../value-objects/AgentBiography.js';
import { i18n } from '../../config/i18n.js';
import { TokenUsage } from '../value-objects/TokenUsage.js';
import { normalizeMood } from '../value-objects/AgentMood.js';
import { buildingForTool, compactToolInput, toolActionLabel } from '../services/ToolIdentity.js';
import { pickLoreLine } from '../../config/loreDialogue.js';

const AGENT_NAMES_EN = [
    'Ada', 'Alden', 'Ansel', 'Bess', 'Bram', 'Cedric', 'Cora', 'Cyril',
    'Della', 'Dorian', 'Dove', 'Edith', 'Edric', 'Elowen', 'Ember', 'Faye',
    'Fenn', 'Finn', 'Freya', 'Godric', 'Greta', 'Hazel', 'Hollis', 'Hugh',
    'Isolde', 'Ivo', 'Ivy', 'Juno', 'Kael', 'Kira', 'Lena', 'Lorne',
    'Maren', 'Maud', 'Merric', 'Nell', 'Nolan', 'Onyx', 'Opal', 'Orin',
    'Percy', 'Prue', 'Quill', 'Quince', 'Rosa', 'Rune', 'Sable', 'Sage',
    'Signe', 'Silas', 'Tamsin', 'Tess', 'Thane', 'Ulric', 'Ursa', 'Vera',
    'Verity', 'Wren', 'Wystan', 'Yara', 'Yorick', 'Zara', 'Alba', 'Corin',
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
        permissionMode,
        sendMessages,
        provider,
        agentId,
        agentName,
        agentType,
        parentSessionId,
        workflowId,
        workflowName,
        lastSessionActivity,
        activityAgeMs,
        turnState,
        pendingTool,
        waitReason,
        awaitingSince,
        resident,
        departedAt,
    }) {
        this.id = id;
        this._customName = !!name; // Whether the name was assigned by a team
        this.name = name || this.generateName();
        this.agentId = agentId || null;
        this.agentName = agentName || name || null;
        this.agentType = agentType || null;
        this.parentSessionId = parentSessionId || null;
        this.workflowId = workflowId || null;
        this.workflowName = workflowName || null;
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
        this.permissionMode = permissionMode ?? null;
        // Transcript-derived turn state (see adapters/turnState.js). `waitReason`
        // says why a WAITING_ON_USER agent is blocked; `resident` marks a session
        // the server is holding past its active window.
        this.turnState = turnState || 'unknown';
        this.pendingTool = pendingTool || null;
        this.waitReason = waitReason || null;
        this.awaitingSince = Number.isFinite(Number(awaitingSince)) ? Number(awaitingSince) : null;
        this.resident = resident === true;
        // A departed agent is no longer present in the live server roster, but
        // remains in the world briefly so burst workloads stay perceptible.
        // This marker is intentionally separate from AgentStatus: departure is
        // presence lifecycle, not another execution state.
        this.departedAt = departedAt !== null
            && departedAt !== undefined
            && Number.isFinite(Number(departedAt))
            ? Number(departedAt)
            : null;
        this.sendMessages = Array.isArray(sendMessages) ? sendMessages : [];
        this.lastSessionActivity = lastSessionActivity || null;
        this.activityAgeMs = Number.isFinite(Number(activityAgeMs)) ? Number(activityAgeMs) : null;
        this._lastMessage = lastMessage || null;
        // Telemetry-derived emotion; kept current by application/MoodService.js.
        this.mood = normalizeMood(null);
        // Transient presentation hint populated by VisitIntentManager. Keeping
        // the derived copy here avoids replacing or disguising raw tool data.
        this.visitIntentBubble = null;
        this.refreshIdentityAppearance();
        this.position = new Position(20 + Math.random() * 10, 20 + Math.random() * 10);
        this.targetPosition = null;
        this.walkFrame = 0;
        this.lastActive = Date.now();
    }

    get isWorking() {
        return !this.isDeparted && this.status === AgentStatus.WORKING;
    }

    get isIdle() {
        return !this.isDeparted && this.status === AgentStatus.IDLE;
    }

    get isWaiting() {
        return !this.isDeparted && this.status === AgentStatus.WAITING;
    }

    get isDeparted() {
        return Number.isFinite(this.departedAt);
    }

    get isSubagent() {
        return !!this.parentSessionId || (this.agentType && this.agentType !== 'main');
    }

    get isToolFresh() {
        return !this.isDeparted && this.status === AgentStatus.WORKING && !!this.currentTool;
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
            // Keep the name already assigned (possibly a collision-probed one)
            // rather than reverting to the base pool pick on every WS update.
            updates.name = this.name || this.generateName();
        }
        Object.assign(this, updates);
        this.refreshIdentityAppearance();
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
        if (this.isDeparted) return null;
        const CAP = 24;
        const intentBubble = this.visitIntentBubble;
        if (
            intentBubble?.text
            && (!Number.isFinite(Number(intentBubble.expiresAt)) || Number(intentBubble.expiresAt) > Date.now())
        ) {
            return Agent._truncate(intentBubble.text, CAP);
        }
        // Occasionally speak village lore instead of the tool label; the
        // pick is seeded per agent + time bucket, so it stays stable
        // across frames and returns null outside lore buckets.
        const lore = pickLoreLine({
            seedKey: this.id,
            buildingType: this.lastKnownBuildingType,
            mood: this.mood?.type,
        });
        if (lore) return Agent._truncate(lore, CAP);
        if (this.currentTool) {
            const toolLabel = toolActionLabel(this.currentTool);
            const detail = compactToolInput(this.currentToolInput, 18);
            const full = detail ? `${toolLabel} ${detail}` : toolLabel;
            return Agent._truncate(full, CAP);
        }
        if (this._lastMessage) return Agent._truncate(this._lastMessage, CAP);
        return null;
    }

    setVisitIntentBubble(bubble) {
        this.visitIntentBubble = bubble?.text ? { ...bubble } : null;
        return this.visitIntentBubble;
    }

    static _truncate(s, cap) {
        const str = String(s);
        if (str.length <= cap) return str;
        return str.slice(0, cap - 1) + '…';
    }

    generateName(usedNames = null) {
        const hash = Appearance.hashCode(this.id);
        return Agent.generateNameForLang(hash, i18n.lang, usedNames);
    }

    refreshIdentityAppearance() {
        const identityKey = AgentBiography.identityKeyFor(this);
        this.appearance = Appearance.fromIdentityKey(identityKey || this.id);
        return this.appearance;
    }

    // Deterministic: the hash picks a starting index; when `usedNames` already
    // holds that name, probe subsequent indices (mod pool size) until a free
    // one is found, so live agents keep distinct fallback names.
    static generateNameForLang(hash, lang, usedNames = null) {
        const pool = AGENT_NAMES_EN;
        const start = Math.abs(hash) % pool.length;
        if (!usedNames || usedNames.size === 0) return pool[start];
        for (let i = 0; i < pool.length; i++) {
            const candidate = pool[(start + i) % pool.length];
            if (!usedNames.has(candidate)) return candidate;
        }
        return pool[start];
    }

}
