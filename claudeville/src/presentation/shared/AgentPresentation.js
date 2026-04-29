import { i18n } from '../../config/i18n.js';
import { toolCategory, toolIcon, shortToolName } from '../../domain/services/ToolIdentity.js';
import { formatModelLabel, getModelVisualIdentity } from './ModelVisualIdentity.js';
import { repoProfile } from './RepoColor.js';
import { el } from './DomSafe.js';
import { hashRows, normalizeStatus, truncateText } from './Formatters.js';

export const UNKNOWN_PROJECT_KEY = '_unknown';

const UNKNOWN_PROJECT_PROFILE = Object.freeze({
    accent: '#8b8b9e',
    glow: 'rgba(139, 139, 158, 0.3)',
    panel: 'rgba(28, 28, 36, 0.72)',
});
const UNKNOWN_PROJECT_SIDEBAR_PROFILE = Object.freeze({
    accent: '#8b8b9e',
    glow: 'rgba(139, 139, 158, 0.3)',
    panel: 'rgba(28, 28, 36, 0.68)',
});

const PROVIDER_ICONS = Object.freeze({ claude: 'C', codex: 'X', gemini: 'G', git: '#' });
const PROVIDER_COLORS = Object.freeze({ claude: '#a78bfa', codex: '#4ade80', gemini: '#60a5fa', git: '#f6cf60' });
const PROVIDER_BADGES = Object.freeze({
    claude: { label: 'Claude', color: '#a78bfa', bg: 'rgba(167,139,250,0.15)' },
    codex:  { label: 'Codex',  color: '#4ade80', bg: 'rgba(74,222,128,0.15)' },
    gemini: { label: 'Gemini', color: '#60a5fa', bg: 'rgba(96,165,250,0.15)' },
    git:    { label: 'Git',    color: '#f6cf60', bg: 'rgba(246,207,96,0.15)' },
});

export function projectKeyForAgent(agent) {
    return agent?.projectPath || UNKNOWN_PROJECT_KEY;
}

export function groupAgentsByProject(agents) {
    const groups = new Map();
    for (const agent of agents || []) {
        const key = projectKeyForAgent(agent);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(agent);
    }
    return groups;
}

export function projectProfile(projectPath, { surface = 'dashboard' } = {}) {
    if (!projectPath || projectPath === UNKNOWN_PROJECT_KEY) {
        return surface === 'sidebar' ? UNKNOWN_PROJECT_SIDEBAR_PROFILE : UNKNOWN_PROJECT_PROFILE;
    }
    return repoProfile(projectPath);
}

export function sortAgentsByStatus(agents) {
    const order = { working: 0, waiting: 1, idle: 2 };
    return agents.sort((a, b) => {
        const statusA = normalizeStatus(a.status);
        const statusB = normalizeStatus(b.status);
        return (order[statusA] ?? 3) - (order[statusB] ?? 3);
    });
}

export function providerPresentation(provider, identity = null) {
    const key = String(provider || 'claude').toLowerCase();
    const badge = PROVIDER_BADGES[key] || PROVIDER_BADGES.claude;
    return {
        key,
        icon: PROVIDER_ICONS[key] || '?',
        color: identity?.minimapColor || PROVIDER_COLORS[key] || '#8b8b9e',
        badge,
    };
}

export function statusPresentation(status, translator = i18n) {
    const normalized = normalizeStatus(status);
    const statusKey = { working: 'statusWorking', idle: 'statusIdle', waiting: 'statusWaiting' };
    const fallbackLabel = normalized.charAt(0).toUpperCase() + normalized.slice(1);
    return {
        status: normalized,
        label: translator?.t?.(statusKey[normalized] || normalized) || fallbackLabel,
        color: {
            working: '#4ade80',
            idle: '#60a5fa',
            waiting: '#f97316',
        }[normalized] || '#8b8b9e',
    };
}

export function modelPresentation(agent) {
    const identity = getModelVisualIdentity(agent?.model, agent?.effort, agent?.provider);
    return {
        identity,
        label: agent?.model ? formatModelLabel(agent.model, agent.effort, agent.provider) : '',
        color: identity.accent?.[0] || '',
        title: identity.label || agent?.model || '',
    };
}

export function currentToolPresentation(agent, translator = i18n) {
    const statusInfo = statusPresentation(agent?.status, translator);
    if (agent?.currentTool) {
        return {
            isIdle: false,
            icon: toolIcon(agent.currentTool),
            name: agent.currentTool,
            detail: agent.currentToolInput || '',
        };
    }
    return {
        isIdle: true,
        icon: statusInfo.status === 'idle' ? '\u{1F4A4}' : '\u23F3',
        name: statusInfo.status === 'idle'
            ? statusInfo.label
            : `${translator?.t?.('statusWaiting') || 'Waiting'}...`,
        detail: '',
    };
}

export function toolHistorySignature(tools, { limit, detailLength }) {
    const limited = (tools || []).slice(-limit);
    return `${limited.length}|${hashRows(limited, [
        row => row?.ts || 0,
        row => row?.tool || '',
        row => (row?.detail || '').slice(0, detailLength),
    ])}`;
}

export function toolHistoryNodes(tools, options = {}) {
    const {
        limit,
        detailLength = 60,
        emptyText = 'No tool usage',
        emptyClass = '',
        emptyStyle = null,
        itemClass,
        iconClass,
        nameClass,
        detailClass,
        includeCategoryClasses = false,
    } = options;
    const limited = (tools || []).slice(-(limit || tools?.length || 0));
    if (!limited.length) {
        return [
            el('div', {
                className: emptyClass,
                text: emptyText,
                style: emptyStyle || undefined,
            }),
        ];
    }
    return [...limited].reverse().map((entry) => {
        const cat = includeCategoryClasses ? toolCategory(entry.tool) : '';
        const categoryClass = cat ? `tool-cat--${cat}` : '';
        return el('div', { className: itemClass }, [
            el('span', {
                className: [iconClass, categoryClass],
                text: toolIcon(entry.tool),
            }),
            el('span', {
                className: [nameClass, categoryClass],
                text: shortToolName(entry.tool),
            }),
            el('span', {
                className: detailClass,
                text: entry.detail ? truncateText(entry.detail, detailLength) : '',
            }),
        ]);
    });
}
