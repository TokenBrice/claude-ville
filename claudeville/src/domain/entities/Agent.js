import { AgentStatus } from '../value-objects/AgentStatus.js';
import { Position } from '../value-objects/Position.js';
import { Appearance } from '../value-objects/Appearance.js';
import { i18n } from '../../config/i18n.js';

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
        this.tokens = tokens || { input: 0, output: 0 };
        this.messages = messages || [];
        this.teamName = teamName;
        this.projectPath = projectPath;
        this.provider = provider || 'claude';
        this.currentTool = currentTool || null;
        this.currentToolInput = currentToolInput || null;
        this.lastTool = lastTool || currentTool || null;
        this.lastToolInput = lastToolInput || currentToolInput || null;
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
        const model = String(this.model || '').toLowerCase();
        const provider = String(this.provider || '').toLowerCase();
        const rates = this._pricingFor(model, provider);
        const tokens = this.tokens || {};
        return (
            (tokens.input || 0) * rates.input +
            (tokens.output || 0) * rates.output +
            (tokens.cacheRead || 0) * rates.cacheRead +
            (tokens.cacheCreate || 0) * rates.cacheCreate
        ) / 1000000;
    }

    _pricingFor(model, provider) {
        const claudeRates = [
            { match: 'opus', input: 15, output: 75, cacheRead: 1.5, cacheCreate: 18.75 },
            { match: 'sonnet', input: 3, output: 15, cacheRead: 0.3, cacheCreate: 3.75 },
            { match: 'haiku', input: 0.8, output: 4, cacheRead: 0.08, cacheCreate: 1 },
        ];
        const openAiRates = [
            { match: 'gpt-5.5', input: 15, output: 120, cacheRead: 1.5, cacheCreate: 0 },
            { match: 'gpt-5.4', input: 10, output: 80, cacheRead: 1, cacheCreate: 0 },
            { match: 'gpt-5.3', input: 5, output: 40, cacheRead: 0.5, cacheCreate: 0 },
            { match: 'gpt-5', input: 1.25, output: 10, cacheRead: 0.125, cacheCreate: 0 },
        ];

        const table = provider === 'codex' || model.includes('gpt') ? openAiRates : claudeRates;
        const found = table.find(rate => model.includes(rate.match));
        return found || (table === openAiRates
            ? { input: 1.25, output: 10, cacheRead: 0.125, cacheCreate: 0 }
            : { input: 3, output: 15, cacheRead: 0.3, cacheCreate: 3.75 });
    }

    get lastMessage() {
        return this._lastMessage || this.messages[this.messages.length - 1] || null;
    }

    /**
     * Return the target building type for the current tool
     */
    get targetBuildingType() {
        if (!this.currentTool) return null;
        const toolMap = {
            'Read': 'archive', 'Grep': 'archive', 'Glob': 'archive',
            'WebSearch': 'observatory', 'WebFetch': 'observatory',
            'Edit': 'forge', 'Write': 'forge', 'NotebookEdit': 'alchemy',
            'Bash': 'mine',
            'shell': 'mine',
            'exec_command': 'mine',
            'functions.exec_command': 'mine',
            'functions.write_stdin': 'mine',
            'apply_patch': 'forge',
            'functions.apply_patch': 'forge',
            'multi_tool_use.parallel': 'command',
            'web.run': 'observatory',
            'image_gen.imagegen': 'alchemy',
            'mcp__playwright__browser_navigate': 'portal',
            'mcp__playwright__browser_take_screenshot': 'portal',
            'mcp__playwright__browser_click': 'portal',
            'mcp__playwright__browser_type': 'portal',
            'mcp__playwright__browser_snapshot': 'portal',
            'Task': 'command', 'TaskCreate': 'taskboard', 'TaskUpdate': 'taskboard', 'TaskList': 'taskboard',
            'SendMessage': 'chathall', 'TeamCreate': 'command',
            'command_execution': 'mine',
        };
        const mapped = toolMap[this.currentTool];
        if (mapped) return mapped;

        const tool = String(this.currentTool).toLowerCase();
        if (tool.includes('exec_command') || tool.includes('bash') || tool.includes('shell')) return 'mine';
        if (tool.includes('apply_patch') || tool.includes('edit') || tool.includes('write') || tool.includes('update_file') || tool.includes('create_file')) return 'forge';
        if (tool.includes('read') || tool.includes('grep') || tool.includes('find') || tool.includes('search')) return 'archive';
        if (tool.includes('web') || tool.includes('fetch') || tool.includes('browser')) return 'observatory';
        if (tool.includes('spawn_agent') || tool.includes('task') || tool.includes('parallel')) return 'command';
        if (tool.includes('wait_agent') || tool.includes('todo')) return 'taskboard';
        if (tool.includes('image')) return 'alchemy';
        return null;
    }

    /**
     * Text to display in the speech bubble
     */
    get bubbleText() {
        if (this.currentTool) {
            const toolLabel = {
                'Read': 'Reading', 'Edit': 'Editing', 'Write': 'Writing',
                'Bash': 'Running', 'Grep': 'Searching', 'Glob': 'Finding',
                'Task': 'Delegating', 'TaskCreate': 'Planning',
                'WebSearch': 'Researching', 'WebFetch': 'Fetching',
                'SendMessage': 'Messaging',
            }[this.currentTool] || this.currentTool;
            const detail = this.currentToolInput ? ` ${this.currentToolInput}` : '';
            return `${toolLabel}${detail}`.substring(0, 40);
        }
        if (this._lastMessage) return this._lastMessage.substring(0, 40);
        return null;
    }

    generateName() {
        const hash = Appearance.hashCode(this.id);
        return Agent.generateNameForLang(hash, i18n.lang);
    }

    static generateNameForLang(hash, lang) {
        const h = Math.abs(hash);
        return AGENT_NAMES_EN[h % AGENT_NAMES_EN.length];
    }

    update(data) {
        Object.assign(this, data);
        this.lastActive = Date.now();
    }
}
