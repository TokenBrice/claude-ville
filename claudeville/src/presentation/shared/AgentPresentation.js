import { i18n } from '../../config/i18n.js';
import { BUILDING_ACCENTS, BUILDING_ACCENTS_RGB, PROVIDER_HUES, STATUS_VISUALS } from '../../config/theme.js';
import { buildingForTool, toolCategory, toolIcon, shortToolName } from '../../domain/services/ToolIdentity.js';
import { formatModelLabel, getModelVisualIdentity } from './ModelVisualIdentity.js';
import { repoProfile } from './RepoColor.js';
import { el } from './DomSafe.js';
import { hashRows, formatRelative, normalizeStatus, truncateText } from './Formatters.js';

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

const PROVIDER_ICONS = Object.freeze({ claude: 'C', codex: 'X', gemini: 'G', git: '#', grok: 'R', kimi: 'K', opencode: 'O', deepseek: 'D' });
// Provider hues come from the theme.js House Palette (#1); only icons/labels
// are presentation-local.
const PROVIDER_COLORS = Object.freeze(Object.fromEntries(
    Object.entries(PROVIDER_HUES)
        .filter(([key]) => key !== 'default')
        .map(([key, hue]) => [key, hue.badge]),
));
const PROVIDER_LABELS = Object.freeze({
    claude: 'Claude', codex: 'Codex', gemini: 'Gemini', git: 'Git', grok: 'Grok', kimi: 'Kimi', opencode: 'OpenCode', deepseek: 'DeepSeek',
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
        completed: 6,
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
        // 1.5 — one provider hue across badge / trim / glyph: the shared
        // `color` (sidebar + dashboard glyph) follows the provider badge hue;
        // per-model minimap colors only survive for unlisted providers.
        color: PROVIDER_COLORS[key] || identity?.minimapColor || '#8b8b9e',
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
        completed: 'Completed',
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
    // Tool-less fallback: terminal statuses read as themselves (idle → "Idle",
    // completed → "Completed"); only genuinely in-flight tool-less statuses
    // read as waiting. Fixes completed agents showing "Waiting...".
    const readsAsSelf = statusInfo.status === 'idle' || statusInfo.status === 'completed';
    return {
        isIdle: true,
        icon: statusInfo.status === 'idle' ? '\u{1F4A4}' : (statusInfo.status === 'completed' ? '✓' : '\u23F3'),
        name: readsAsSelf
            ? statusInfo.label
            : `${translator?.t?.('statusWaiting') || 'Waiting'}...`,
        detail: '',
    };
}

// #30 — Dashboard cards carry their World building identity.
// Each building's emblem glyph + accent so a card visually echoes the village
// district its agent works in (Archive = cool blue, Forge = ember, ...).
const BUILDING_EMBLEMS = Object.freeze({
    command: '⚑',     // pennant — orchestration
    taskboard: '\u{1F4CB}', // clipboard — planning
    archive: '\u{1F4D6}',  // open book — reading
    mine: '⛏',        // pick — extraction
    forge: '\u{1F528}',    // hammer — editing
    harbor: '⚓',      // anchor — git flow
    watchtower: '\u{1F3F0}', // tower — watch
    observatory: '\u{1F52D}', // telescope — research
    portal: '\u{1F310}',   // globe — preview
});

// Derive an agent's World building from its live tool (via RitualConductor's
// tool->building map in ToolIdentity), falling back to the most recent tool
// in history. Returns null when no district can be inferred.
export function buildingClassForAgent(agent) {
    if (!agent) return null;
    if (agent.currentTool) {
        const fromCurrent = buildingForTool(agent.currentTool, agent.currentToolInput);
        if (fromCurrent && BUILDING_EMBLEMS[fromCurrent]) return fromCurrent;
    }
    const history = agent.toolHistory;
    if (Array.isArray(history)) {
        for (let i = history.length - 1; i >= 0; i--) {
            const entry = history[i];
            const building = buildingForTool(entry?.tool, entry?.detail ?? entry?.input);
            if (building && BUILDING_EMBLEMS[building]) return building;
        }
    }
    return null;
}

export function buildingPresentation(building) {
    if (!building || !BUILDING_EMBLEMS[building]) return null;
    return {
        building,
        emblem: BUILDING_EMBLEMS[building],
        accent: BUILDING_ACCENTS[building] || '#8b8b9e',
        accentRgb: BUILDING_ACCENTS_RGB[building] || '139, 139, 158',
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
        // 4.4 — opt-in relative-timestamp span per row (dashboard only);
        // callers that omit timeClass render exactly as before.
        timeClass = '',
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
        const children = [
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
        ];
        if (timeClass) {
            children.push(el('span', {
                className: timeClass,
                text: formatRelative(Number(entry.ts) || 0),
            }));
        }
        return el('div', { className: itemClass }, children);
    });
}
