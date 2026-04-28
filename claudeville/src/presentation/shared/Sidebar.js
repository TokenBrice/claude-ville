import { eventBus } from '../../domain/events/DomainEvent.js';
import { i18n } from '../../config/i18n.js';
import { formatModelLabel, getModelVisualIdentity } from './ModelVisualIdentity.js';
import { getTeamColor, shortTeamName } from './TeamColor.js';
import { repoBranchProfile, repoProfile } from './RepoColor.js';
import { el, replaceChildren } from './DomSafe.js';
import { hashRows, shortProjectName, statusClass } from './Formatters.js';

const PROVIDER_ICONS = { claude: 'C', codex: 'X', gemini: 'G', git: '#' };
const PROVIDER_COLORS = { claude: '#a78bfa', codex: '#4ade80', gemini: '#60a5fa', git: '#f6cf60' };
const RELATIVE_TIME_THRESHOLDS = [
    [60_000, 'just now'],
    [60 * 60_000, (ms) => `${Math.floor(ms / 60_000)}m ago`],
    [24 * 60 * 60_000, (ms) => `${Math.floor(ms / (60 * 60_000))}h ago`],
    [7 * 24 * 60 * 60_000, (ms) => `${Math.floor(ms / (24 * 60 * 60_000))}d ago`],
];

function formatRelative(ts, now = Date.now()) {
    if (!Number.isFinite(ts) || ts <= 0) return '';
    const ms = Math.max(0, now - ts);
    for (const [bound, fmt] of RELATIVE_TIME_THRESHOLDS) {
        if (ms < bound) return typeof fmt === 'function' ? fmt(ms) : fmt;
    }
    return `${Math.floor(ms / (7 * 24 * 60 * 60_000))}w ago`;
}

export class Sidebar {
    constructor(world) {
        this.world = world;
        this.sidebarEl = document.getElementById('sidebar');
        this.listEl = document.getElementById('agentList');
        this.countEl = document.getElementById('agentCount');
        this.harborListEl = document.getElementById('harborList');
        this.harborCountEl = document.getElementById('harborCount');
        this.toggleEl = document.getElementById('sidebarToggle');
        this.selectedId = null;
        this.harborRepos = [];
        this._harborSignature = '';
        this._renderSignature = '';
        this.isCollapsed = localStorage.getItem('claudeville.sidebarCollapsed') === 'true';

        this._onUpdate = () => this.render();
        this._onHarborUpdate = (repos = []) => {
            const nextRepos = Array.isArray(repos) ? repos : [];
            const signature = hashRows(nextRepos, [
                repo => repo.project || '',
                repo => repo.branch || '',
                repo => Number(repo.pendingCommits ?? repo.count) || 0,
                repo => Number(repo.failedPushes) || 0,
                repo => Math.floor((Number(repo.latestEventTime) || 0) / 1000),
                repo => repo.profile?.accent || '',
            ]);
            if (signature === this._harborSignature) return;
            this._harborSignature = signature;
            this.harborRepos = nextRepos;
            this.renderHarbor();
        };
        this._onAgentSelected = (agent) => {
            const previous = this.selectedId;
            this.selectedId = agent?.id || null;
            this._syncSelection(previous, this.selectedId);
        };
        this._onAgentDeselected = () => {
            const previous = this.selectedId;
            this.selectedId = null;
            this._syncSelection(previous, null);
        };
        eventBus.on('agent:added', this._onUpdate);
        eventBus.on('agent:updated', this._onUpdate);
        eventBus.on('agent:removed', this._onUpdate);
        eventBus.on('harbor:updated', this._onHarborUpdate);
        eventBus.on('agent:selected', this._onAgentSelected);
        eventBus.on('agent:deselected', this._onAgentDeselected);

        this._bindToggle();
        this._bindListClick();
        this._applyCollapsedState();
        this.render();
        this.renderHarbor();
    }

    _bindToggle() {
        if (!this.toggleEl) return;
        this._onToggleClick = () => {
            this.isCollapsed = !this.isCollapsed;
            localStorage.setItem('claudeville.sidebarCollapsed', String(this.isCollapsed));
            this._applyCollapsedState();
        };
        this.toggleEl.addEventListener('click', this._onToggleClick);
    }

    _bindListClick() {
        if (!this.listEl) return;
        this._onListClick = (event) => {
            const row = event.target.closest('.sidebar__agent[data-agent-id]');
            if (!row || !this.listEl.contains(row)) return;
            const id = row.dataset.agentId;
            const agent = this.world.agents.get(id);
            if (!agent) return;
            if (this.selectedId === id) {
                eventBus.emit('agent:deselected');
                return;
            }
            eventBus.emit('agent:selected', agent);
        };
        this.listEl.addEventListener('click', this._onListClick);
    }

    _applyCollapsedState() {
        if (!this.sidebarEl) return;
        this.sidebarEl.classList.toggle('sidebar--collapsed', this.isCollapsed);

        if (this.toggleEl) {
            const label = this.isCollapsed ? 'Expand agent sidebar' : 'Collapse agent sidebar';
            this.toggleEl.textContent = this.isCollapsed ? '>' : '<';
            this.toggleEl.setAttribute('aria-label', label);
            this.toggleEl.setAttribute('aria-expanded', String(!this.isCollapsed));
            this.toggleEl.title = this.isCollapsed ? 'Expand sidebar' : 'Collapse sidebar';
        }
    }

    render() {
        const agents = Array.from(this.world.agents.values());
        this.countEl.textContent = agents.length;
        const signature = agents
            .map(agent => [
                agent.id,
                agent.name,
                agent.status,
                agent.model,
                agent.effort,
                agent.provider,
                agent.projectPath,
                agent.teamName,
            ].join('|'))
            .join('\n');
        if (signature === this._renderSignature) {
            this._syncSelection(null, this.selectedId);
            return;
        }
        this._renderSignature = signature;

        // Group by project
        const groups = this._groupByProject(agents);

        const nodes = [];
        for (const [projectPath, groupAgents] of groups) {
            const projectName = shortProjectName(projectPath, i18n.t('unknownProject'));
            const profile = projectPath === '_unknown'
                ? { accent: '#8b8b9e', glow: 'rgba(139, 139, 158, 0.3)', panel: 'rgba(28, 28, 36, 0.68)' }
                : repoProfile(projectPath);
            const groupEl = el('div', { className: 'sidebar__project-group' });
            groupEl.append(el('div', {
                className: 'sidebar__project-header',
                style: {
                    borderLeftColor: profile.accent,
                    background: profile.panel,
                },
            }, [
                el('span', {
                    className: 'sidebar__project-dot',
                    style: {
                        background: profile.accent,
                        boxShadow: `0 0 6px ${profile.glow}`,
                    },
                }),
                el('span', {
                    className: 'sidebar__project-name',
                    text: projectName,
                    style: { color: profile.accent },
                }),
                el('span', {
                    className: 'sidebar__project-count',
                    text: groupAgents.length,
                    style: { color: profile.accent },
                }),
            ]));
            for (const agent of groupAgents) {
                const identity = getModelVisualIdentity(agent.model, agent.effort, agent.provider);
                const providerColor = identity.minimapColor || PROVIDER_COLORS[agent.provider] || '#8b8b9e';
                const team = agent.teamName ? getTeamColor(agent.teamName) : null;
                const teamLabel = agent.teamName ? `Team ${shortTeamName(agent.teamName)}` : '';
                const agentClasses = ['sidebar__agent'];
                if (agent.id === this.selectedId) agentClasses.push('sidebar__agent--selected');
                const nameChildren = [];
                if (team) {
                    nameChildren.push(el('span', {
                        title: teamLabel,
                        ariaLabel: teamLabel,
                        style: {
                            display: 'inline-block',
                            width: '7px',
                            height: '7px',
                            borderRadius: '50%',
                            background: team.accent,
                            boxShadow: `0 0 6px ${team.glow}`,
                            marginRight: '4px',
                            verticalAlign: 'middle',
                        },
                    }));
                }
                nameChildren.push(agent.name || '');

                const providerIcon = el('span', {
                    text: PROVIDER_ICONS[agent.provider] || '?',
                    style: { color: providerColor, fontWeight: 'bold' },
                });
                const modelEl = el('span', { className: 'sidebar__agent-model' }, [
                    providerIcon,
                    ` ${this._shortModel(agent.model, agent.effort, agent.provider)}`,
                ]);

                groupEl.append(el('div', {
                    className: agentClasses,
                    dataset: { agentId: agent.id },
                }, [
                    el('span', {
                        className: ['sidebar__agent-dot', `sidebar__agent-dot--${statusClass(agent.status)}`],
                    }),
                    el('div', { className: 'sidebar__agent-info' }, [
                        el('span', { className: 'sidebar__agent-name' }, nameChildren),
                        modelEl,
                    ]),
                ]));
            }
            nodes.push(groupEl);
        }

        replaceChildren(this.listEl, nodes);
        this._syncSelection(null, this.selectedId);
    }

    _syncSelection(previousId, nextId) {
        const ids = new Set([previousId, nextId].filter(Boolean));
        if (ids.size === 0 && nextId === null) {
            this.listEl?.querySelectorAll('.sidebar__agent--selected')
                .forEach(row => row.classList.remove('sidebar__agent--selected'));
            return;
        }
        for (const id of ids) {
            const selector = `.sidebar__agent[data-agent-id="${CSS.escape(id)}"]`;
            const row = this.listEl?.querySelector(selector);
            row?.classList.toggle('sidebar__agent--selected', id === nextId);
        }
    }

    renderHarbor() {
        if (!this.harborListEl || !this.harborCountEl) return;

        const repos = [...this.harborRepos]
            .filter(repo => (Number(repo.pendingCommits ?? repo.count) || 0) > 0)
            .sort((a, b) => (b.failedPushes || 0) - (a.failedPushes || 0)
                || (b.pendingCommits || b.count || 0) - (a.pendingCommits || a.count || 0)
                || (b.latestEventTime || 0) - (a.latestEventTime || 0));
        const total = repos.reduce((sum, repo) => sum + (Number(repo.pendingCommits ?? repo.count) || 0), 0);
        this.harborCountEl.textContent = total;

        if (repos.length === 0) {
            replaceChildren(this.harborListEl, [
                el('div', { className: ['sidebar__agent', 'sidebar__harbor-empty'], text: 'No pending commits' }),
            ]);
            return;
        }

        const now = Date.now();
        const nodes = repos.map(repo => {
            const profile = repo.profile || repoBranchProfile(repo.project, repo.branch);
            const name = repo.repoName || repo.shortName || profile.shortName || profile.name || 'unknown';
            const count = Number(repo.pendingCommits ?? repo.count) || 0;
            const rel = formatRelative(Number(repo.latestEventTime) || 0, now);
            const infoChildren = [
                el('span', {
                    className: 'sidebar__agent-name',
                    text: name,
                    style: { color: profile.accent },
                }),
            ];
            if (rel) {
                infoChildren.push(el('span', { className: 'sidebar__agent-model', text: rel }));
            }
            return el('div', {
                className: ['sidebar__agent', 'sidebar__harbor-row'],
                title: repo.branch ? `${repo.project || ''} (${repo.branch})` : repo.project || '',
                style: {
                    borderLeftColor: profile.accent,
                    background: profile.panel,
                },
            }, [
                el('span', {
                    className: ['sidebar__agent-dot', 'sidebar__harbor-dot'],
                    style: {
                        background: profile.accent,
                        boxShadow: `0 0 6px ${profile.glow}`,
                    },
                }),
                el('div', { className: 'sidebar__agent-info' }, infoChildren),
                el('span', {
                    className: ['sidebar__project-count', 'sidebar__harbor-count'],
                    text: count,
                    style: { color: profile.accent },
                }),
            ]);
        });
        replaceChildren(this.harborListEl, nodes);
    }

    _groupByProject(agents) {
        const groups = new Map();
        for (const agent of agents) {
            const key = agent.projectPath || '_unknown';
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(agent);
        }
        return groups;
    }

    _shortModel(model, effort, provider) {
        if (!model) return '';
        return formatModelLabel(model, effort, provider);
    }

    destroy() {
        eventBus.off('agent:added', this._onUpdate);
        eventBus.off('agent:updated', this._onUpdate);
        eventBus.off('agent:removed', this._onUpdate);
        eventBus.off('harbor:updated', this._onHarborUpdate);
        eventBus.off('agent:selected', this._onAgentSelected);
        eventBus.off('agent:deselected', this._onAgentDeselected);
        if (this._onToggleClick) this.toggleEl?.removeEventListener('click', this._onToggleClick);
        if (this._onListClick) this.listEl?.removeEventListener('click', this._onListClick);
    }
}
