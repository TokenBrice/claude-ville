/**
 * Localization module
 * Default language: English
 */

const STRINGS = {
    ko: {
        // topbar
        tokens: 'TOKENS',
        cost: 'COST',
        time: 'TIME',
        working: 'WORKING',
        idle: 'IDLE',
        waiting: 'WAITING',
        world: 'WORLD',
        dashboard: 'DASHBOARD',
        settings: 'SETTINGS',

        // sidebar
        agents: 'AGENTS',
        unknownProject: 'Unknown Project',

        // dashboard
        noActiveAgents: 'NO ACTIVE AGENTS',
        noActiveAgentsSub: 'Start an AI coding session to see agents here',
        toolHistory: 'TOOL HISTORY',
        noToolUsage: 'No tool usage yet',
        nAgents: (n) => `${n} agents`,

        // agent detail
        model: 'MODEL',
        role: 'ROLE',
        team: 'TEAM',

        // status
        statusWorking: 'WORKING',
        statusIdle: 'IDLE',
        statusWaiting: 'WAITING',

        // notifications
        agentJoined: (name) => `${name} joined the village`,
        agentLeft: (name) => `${name} left the village`,
        serverConnected: 'Server connected',
        serverDisconnected: 'Server disconnected, retrying...',
        modeSwitchWorld: 'Switched to World mode',
        modeSwitchDashboard: 'Switched to Dashboard mode',
        langChanged: 'Language changed to English',

        // settings modal
        settingsTitle: 'SETTINGS',
        language: 'Language',
        langKo: 'Korean',
        langEn: 'English',
    },
    en: {
        tokens: 'TOKENS',
        cost: 'COST',
        time: 'TIME',
        working: 'WORKING',
        idle: 'IDLE',
        waiting: 'WAITING',
        world: 'WORLD',
        dashboard: 'DASHBOARD',
        settings: 'SETTINGS',

        agents: 'AGENTS',
        unknownProject: 'Unknown Project',

        noActiveAgents: 'NO ACTIVE AGENTS',
        noActiveAgentsSub: 'Start a Claude Code session to see agents here',
        toolHistory: 'TOOL HISTORY',
        noToolUsage: 'No tool usage yet',
        nAgents: (n) => `${n} agents`,

        model: 'MODEL',
        role: 'ROLE',
        team: 'TEAM',

        statusWorking: 'WORKING',
        statusIdle: 'IDLE',
        statusWaiting: 'WAITING',

        agentJoined: (name) => `${name} joined the village`,
        agentLeft: (name) => `${name} left the village`,
        serverConnected: 'Server connected',
        serverDisconnected: 'Server disconnected, retrying...',
        modeSwitchWorld: 'Switched to World mode',
        modeSwitchDashboard: 'Switched to Dashboard mode',
        langChanged: 'Language changed to English',

        settingsTitle: 'SETTINGS',
        language: 'Language',
        langKo: 'Korean',
        langEn: 'English',
    },
};

class I18n {
    constructor() {
        this._lang = localStorage.getItem('claudeville-lang') || 'en';
    }

    get lang() {
        return this._lang;
    }

    set lang(val) {
        this._lang = val;
        localStorage.setItem('claudeville-lang', val);
    }

    t(key) {
        const dict = STRINGS[this._lang] || STRINGS.en;
        return dict[key] ?? STRINGS.en[key] ?? key;
    }
}

export const i18n = new I18n();
