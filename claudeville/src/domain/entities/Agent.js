import { AgentStatus } from '../value-objects/AgentStatus.js';
import { Position } from '../value-objects/Position.js';
import { Appearance } from '../value-objects/Appearance.js';
import { i18n } from '../../config/i18n.js';
import { TokenUsage } from '../value-objects/TokenUsage.js';

const AGENT_NAMES_EN = [
    'Atlas', 'Nova', 'Cipher', 'Pixel', 'Spark',
    'Bolt', 'Echo', 'Flux', 'Helix', 'Onyx',
    'Prism', 'Qubit', 'Rune', 'Sage', 'Vex',
];

const DIRECT_TOOL_BUILDINGS = {
    Read: 'archive',
    Grep: 'archive',
    Glob: 'archive',
    LS: 'archive',

    WebSearch: 'observatory',
    WebFetch: 'observatory',
    'web.run': 'observatory',

    Edit: 'forge',
    MultiEdit: 'forge',
    Write: 'forge',
    apply_patch: 'forge',
    'functions.apply_patch': 'forge',

    NotebookEdit: 'alchemy',
    'image_gen.imagegen': 'alchemy',

    'mcp__playwright__browser_navigate': 'portal',
    'mcp__playwright__browser_take_screenshot': 'portal',
    'mcp__playwright__browser_click': 'portal',
    'mcp__playwright__browser_type': 'portal',
    'mcp__playwright__browser_snapshot': 'portal',
    'mcp__playwright__browser_resize': 'portal',

    Task: 'command',
    TeamCreate: 'command',
    SendMessage: 'chathall',
    multi_tool_use: 'command',
    'multi_tool_use.parallel': 'command',
    'functions.spawn_agent': 'command',
    'functions.send_input': 'command',
    'functions.close_agent': 'command',
    'functions.resume_agent': 'command',

    TaskCreate: 'taskboard',
    TaskUpdate: 'taskboard',
    TaskList: 'taskboard',
    TodoWrite: 'taskboard',
    'functions.update_plan': 'taskboard',
    'functions.wait_agent': 'taskboard',
    'functions.request_user_input': 'taskboard',
};

const SHELL_TOOL_NAMES = new Set([
    'Bash',
    'shell',
    'exec_command',
    'functions.exec_command',
    'functions.write_stdin',
    'command_execution',
]);

const TOOL_PATTERNS = [
    { building: 'watchtower', pattern: /\b(git\s+(commit|push|tag)|gh\s+(pr\s+create|release|workflow|run|repo)|wrangler\s+deploy|vercel\s+deploy|npm\s+run\s+deploy)\b/ },
    { building: 'taskboard', pattern: /\b(npm\s+(test|run\s+(test|check|lint|build|sprites:validate|sprites:visual-diff))|node\s+--check|xargs\s+-0\s+-n1\s+node\s+--check|pytest|vitest|playwright\s+test)\b/ },
    { building: 'archive', pattern: /\b(rg|grep|find|fd|ls|cat|sed|head|tail|nl|wc|git\s+(status|diff|show|log|branch|rev-list|fetch)|jq)\b/ },
    { building: 'portal', pattern: /\b(npm\s+run\s+dev|node\s+claudeville\/server\.js|playwright|browser|chrome|chromium|firefox|screenshot|localhost|127\.0\.0\.1)\b/ },
    { building: 'observatory', pattern: /\b(curl|wget|web|fetch|search_query|open\s+https?:\/\/)\b/ },
    { building: 'forge', pattern: /\b(apply_patch|patch|edit|write|create|update|delete|mv|cp|perl\s+-pi)\b/ },
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
        this.status = status || AgentStatus.IDLE;
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

        const mapped = DIRECT_TOOL_BUILDINGS[toolName];
        if (mapped) return mapped;

        if (SHELL_TOOL_NAMES.has(toolName)) {
            return Agent._buildingForShellInput(this.currentToolInput || this.lastToolInput) || 'mine';
        }

        const tool = String(toolName).toLowerCase();
        if (tool.includes('playwright') || tool.includes('browser') || tool.includes('chrome')) return 'portal';
        if (tool.includes('web') || tool.includes('fetch')) return 'observatory';
        if (tool.includes('image') || tool.includes('prompt') || tool.includes('notebook')) return 'alchemy';
        if (tool.includes('github') || tool.includes('pull_request') || tool.includes(' pr_')) return 'watchtower';
        if (tool.includes('apply_patch') || tool.includes('edit') || tool.includes('write') || tool.includes('update_file') || tool.includes('create_file') || tool.includes('delete_file')) return 'forge';
        if (tool.includes('spawn_agent') || tool.includes('send_input') || tool.includes('team') || tool.includes('parallel')) return 'command';
        if (tool.includes('wait_agent') || tool.includes('task') || tool.includes('todo') || tool.includes('plan')) return 'taskboard';
        if (tool.includes('read') || tool.includes('grep') || tool.includes('glob') || tool.includes('find') || tool.includes('search')) return 'archive';
        return null;
    }

    static _buildingForShellInput(input) {
        const text = Agent._normalizeToolInput(input);
        if (!text) return null;
        const matched = TOOL_PATTERNS.find(({ pattern }) => pattern.test(text));
        return matched ? matched.building : null;
    }

    static _normalizeToolInput(input) {
        if (input == null) return '';
        if (typeof input === 'string') return input.toLowerCase();
        if (typeof input === 'object') {
            const fields = ['cmd', 'command', 'script', 'args', 'url', 'path'];
            const parts = [];
            for (const field of fields) {
                if (input[field] != null) {
                    parts.push(String(input[field]));
                }
            }
            if (parts.length) return parts.join(' ').toLowerCase();
        }
        return String(input).toLowerCase();
    }

    /**
     * Text to display in the speech bubble (capped at ~24 chars).
     */
    get bubbleText() {
        const CAP = 24;
        if (this.currentTool) {
            const toolLabel = {
                'Read': 'Reading', 'Edit': 'Editing', 'Write': 'Writing',
                'Bash': 'Running', 'Grep': 'Searching', 'Glob': 'Finding',
                'Task': 'Delegating', 'TaskCreate': 'Planning',
                'WebSearch': 'Researching', 'WebFetch': 'Fetching',
                'SendMessage': 'Messaging',
            }[this.currentTool] || this.currentTool;
            const detail = Agent._compactInput(this.currentToolInput);
            const full = detail ? `${toolLabel} ${detail}` : toolLabel;
            return Agent._truncate(full, CAP);
        }
        if (this._lastMessage) return Agent._truncate(this._lastMessage, CAP);
        return null;
    }

    static _compactInput(input) {
        if (input == null) return '';
        const raw = String(input).trim();
        if (!raw) return '';
        const lastSlash = Math.max(raw.lastIndexOf('/'), raw.lastIndexOf('\\'));
        const base = (lastSlash >= 0 ? raw.slice(lastSlash + 1) : raw).split(/\s+/)[0] || '';
        // Drop hash-like inputs (long single token, hex/uuid/base32-ish)
        if (base.length > 8 && /^[a-z0-9-]+$/i.test(base) && !/[aeiou]/i.test(base)) return '';
        return base;
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
