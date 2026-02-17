/**
 * 다국어 지원 모듈
 * 기본 언어: 한국어
 */

const STRINGS = {
    ko: {
        // topbar
        tokens: '토큰',
        cost: '비용',
        time: '시간',
        working: '작업중',
        idle: '대기',
        waiting: '응답대기',
        world: '월드',
        dashboard: '대시보드',
        settings: '설정',

        // sidebar
        agents: '에이전트',
        unknownProject: '알 수 없는 프로젝트',

        // dashboard
        noActiveAgents: '활성 에이전트 없음',
        noActiveAgentsSub: 'Claude Code 세션을 시작하면 여기에 표시됩니다',
        toolHistory: '도구 사용 기록',
        noToolUsage: '도구 사용 기록 없음',
        nAgents: (n) => `${n}명`,

        // agent detail
        model: '모델',
        role: '역할',
        team: '팀',

        // status
        statusWorking: '작업중',
        statusIdle: '대기',
        statusWaiting: '응답대기',

        // notifications
        agentJoined: (name) => `${name} 마을에 합류`,
        agentLeft: (name) => `${name} 마을을 떠남`,
        serverConnected: '서버 연결됨',
        serverDisconnected: '서버 연결 끊김, 재연결 중...',
        modeSwitchWorld: '월드 모드로 전환',
        modeSwitchDashboard: '대시보드 모드로 전환',
        langChanged: '한국어로 변경되었습니다',

        // settings modal
        settingsTitle: '설정',
        language: '언어',
        langKo: '한국어',
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
        langKo: '한국어',
        langEn: 'English',
    },
};

class I18n {
    constructor() {
        this._lang = localStorage.getItem('claudeville-lang') || 'ko';
    }

    get lang() {
        return this._lang;
    }

    set lang(val) {
        this._lang = val;
        localStorage.setItem('claudeville-lang', val);
    }

    t(key) {
        const dict = STRINGS[this._lang] || STRINGS.ko;
        return dict[key] ?? STRINGS.ko[key] ?? key;
    }
}

export const i18n = new I18n();
