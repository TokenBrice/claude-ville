import { i18n } from '../../config/i18n.js';
import { PROVIDER_HUES, STATUS_VISUALS } from '../../config/theme.js';
import { toolCategory, toolIcon, shortToolName } from '../../domain/services/ToolIdentity.js';
import { formatModelLabel, getModelVisualIdentity } from './ModelVisualIdentity.js';
import { repoProfile } from './RepoColor.js';
import { el } from './DomSafe.js';
import { hashRows, normalizeStatus, truncateText } from './Formatters.js';

export const UNKNOWN_PROJECT_KEY = '_unknown';

const UNKNOWN_PROJECT_PROFILE = Object.freeze({
    accent: '#8b8b9e',
    labelText: '#d7d7e8',
    glow: 'rgba(139, 139, 158, 0.3)',
    panel: 'rgba(28, 28, 36, 0.72)',
    panelBorder: 'rgba(139, 139, 158, 0.9)',
});
const UNKNOWN_PROJECT_SIDEBAR_PROFILE = Object.freeze({
    accent: '#8b8b9e',
    labelText: '#d7d7e8',
    glow: 'rgba(139, 139, 158, 0.3)',
    panel: 'rgba(28, 28, 36, 0.68)',
    panelBorder: 'rgba(139, 139, 158, 0.86)',
});

const PROVIDER_ICONS = Object.freeze({ claude: 'C', codex: 'X', gemini: 'G', git: '#', kimi: 'K', opencode: 'O' });
// Provider hues come from the theme.js House Palette (#1); only icons/labels
// are presentation-local.
const PROVIDER_COLORS = Object.freeze(Object.fromEntries(
    Object.entries(PROVIDER_HUES)
        .filter(([key]) => key !== 'default')
        .map(([key, hue]) => [key, hue.badge]),
));
const PROVIDER_LABELS = Object.freeze({
    claude: 'Claude', codex: 'Codex', gemini: 'Gemini', git: 'Git', kimi: 'Kimi', opencode: 'OpenCode',
});
const PROVIDER_BADGES = Object.freeze(Object.fromEntries(
    Object.keys(PROVIDER_LABELS).map(key => [key, {
        label: PROVIDER_LABELS[key],
        color: PROVIDER_HUES[key].badge,
        bg: PROVIDER_HUES[key].badgeBg,
    }]),
));

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
    const order = {
        errored: 0,
        waiting_on_user: 1,
        working: 2,
        waiting: 3,
        rate_limited: 4,
        idle: 5,
    };
    return agents.sort((a, b) => {
        const statusA = normalizeStatus(a.status);
        const statusB = normalizeStatus(b.status);
        return (order[statusA] ?? 6) - (order[statusB] ?? 6);
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
    const statusOverrideLabel = {
        rate_limited: 'Rate-limited',
        errored: 'Errored',
        waiting_on_user: 'Waiting for you',
    };
    const fallbackLabel = normalized.charAt(0).toUpperCase() + normalized.slice(1);
    return {
        status: normalized,
        label: statusOverrideLabel[normalized]
            || translator?.t?.(statusKey[normalized] || normalized)
            || fallbackLabel,
        color: STATUS_VISUALS[normalized]?.color || '#8b8b9e',
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
