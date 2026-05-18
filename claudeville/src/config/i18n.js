/**
 * Localization module
 * Default language: English
 */

const STRINGS = {
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
    },
};

class I18n {
    constructor() {
        this._lang = 'en';
    }

    get lang() {
        return this._lang;
    }

    t(key) {
        return STRINGS.en[key] ?? key;
    }
}

export const i18n = new I18n();
