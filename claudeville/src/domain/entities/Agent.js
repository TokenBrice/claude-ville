import { AgentStatus } from '../value-objects/AgentStatus.js';
import { Position } from '../value-objects/Position.js';
import { Appearance } from '../value-objects/Appearance.js';
import { i18n } from '../../config/i18n.js';

const AGENT_NAMES_EN = [
    'Atlas', 'Nova', 'Cipher', 'Pixel', 'Spark',
    'Bolt', 'Echo', 'Flux', 'Helix', 'Onyx',
    'Prism', 'Qubit', 'Rune', 'Sage', 'Vex',
];

const SURNAMES_KO = [
    '김', '이', '박', '최', '정', '강', '조', '윤', '장', '임',
    '한', '오', '서', '신', '권', '황', '안', '송', '류', '홍',
];

const TITLES_KO = [
    '대표', '실장', '부장', '과장', '차장', '팀장', '이사',
    '수석', '책임', '선임', '주임', '대리', '매니저', '센터장', '국장',
];

export class Agent {
    constructor({ id, name, model, status, role, tokens, messages, teamName, projectPath, lastTool, lastToolInput, lastMessage }) {
        this.id = id;
        this._customName = !!name; // 팀에서 지정된 이름인지 여부
        this.name = name || this.generateName();
        this.model = model || 'unknown';
        this.status = status || AgentStatus.IDLE;
        this.role = role || 'general';
        this.tokens = tokens || { input: 0, output: 0 };
        this.messages = messages || [];
        this.teamName = teamName;
        this.projectPath = projectPath;
        this.currentTool = lastTool || null;
        this.currentToolInput = lastToolInput || null;
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

    get cost() {
        const rates = {
            'claude-opus-4-6': { input: 15, output: 75 },
            'claude-sonnet-4-5': { input: 3, output: 15 },
            'claude-haiku-4-5': { input: 0.8, output: 4 },
        };
        const rate = rates[this.model] || rates['claude-sonnet-4-5'];
        return (this.tokens.input * rate.input + this.tokens.output * rate.output) / 1000000;
    }

    get lastMessage() {
        return this._lastMessage || this.messages[this.messages.length - 1] || null;
    }

    /**
     * 현재 도구에 따른 목표 건물 타입 반환
     */
    get targetBuildingType() {
        if (!this.currentTool) return null;
        const toolMap = {
            'Read': 'chathall', 'Grep': 'chathall', 'Glob': 'chathall', 'WebSearch': 'chathall', 'WebFetch': 'chathall',
            'Edit': 'forge', 'Write': 'forge', 'NotebookEdit': 'forge',
            'Bash': 'mine', 'mcp__playwright__browser_navigate': 'mine', 'mcp__playwright__browser_take_screenshot': 'mine',
            'Task': 'command', 'TaskCreate': 'taskboard', 'TaskUpdate': 'taskboard', 'TaskList': 'taskboard',
            'SendMessage': 'command', 'TeamCreate': 'command',
        };
        return toolMap[this.currentTool] || null;
    }

    /**
     * 말풍선에 표시할 텍스트
     */
    get bubbleText() {
        if (this.currentTool) {
            const toolLabel = {
                'Read': 'Reading', 'Edit': 'Editing', 'Write': 'Writing',
                'Bash': 'Running', 'Grep': 'Searching', 'Glob': 'Finding',
                'Task': 'Delegating', 'TaskCreate': 'Planning',
                'WebSearch': 'Researching', 'SendMessage': 'Messaging',
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
        if (lang === 'ko') {
            const surname = SURNAMES_KO[h % SURNAMES_KO.length];
            const title = TITLES_KO[(h >> 4) % TITLES_KO.length];
            return `${surname}${title}`;
        }
        return AGENT_NAMES_EN[h % AGENT_NAMES_EN.length];
    }

    update(data) {
        Object.assign(this, data);
        this.lastActive = Date.now();
    }
}
