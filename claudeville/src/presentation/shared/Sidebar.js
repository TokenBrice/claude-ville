import { eventBus } from '../../domain/events/DomainEvent.js';
import { i18n } from '../../config/i18n.js';
import { formatModelLabel, getModelVisualIdentity } from './ModelVisualIdentity.js';
import { getTeamColor, shortTeamName } from './TeamColor.js';
import { repoProfile } from './RepoColor.js';

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
            const signature = nextRepos
                .map(repo => `${repo.project || ''}|${Number(repo.pendingCommits ?? repo.count) || 0}|${Number(repo.failedPushes) || 0}|${Math.floor((Number(repo.latestEventTime) || 0) / 1000)}`)
                .join('\n');
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
        this.toggleEl.addEventListener('click', () => {
            this.isCollapsed = !this.isCollapsed;
            localStorage.setItem('claudeville.sidebarCollapsed', String(this.isCollapsed));
            this._applyCollapsedState();
        });
    }

    _bindListClick() {
        if (!this.listEl) return;
        this.listEl.addEventListener('click', (event) => {
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
        });
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

        let html = '';
        for (const [projectPath, groupAgents] of groups) {
            const projectName = this._shortProjectName(projectPath);
            const color = projectPath === '_unknown'
                ? '#8b8b9e'
                : repoProfile(projectPath).accent;
            html += `<div class="sidebar__project-group">
                <div class="sidebar__project-header" style="border-left-color: ${color}">
                    <span class="sidebar__project-dot" style="background: ${color}"></span>
                    <span class="sidebar__project-name">${this._escape(projectName)}</span>
                    <span class="sidebar__project-count">${groupAgents.length}</span>
                </div>`;
            for (const agent of groupAgents) {
                const identity = getModelVisualIdentity(agent.model, agent.effort, agent.provider);
                const providerColor = identity.minimapColor || PROVIDER_COLORS[agent.provider] || '#8b8b9e';
                const team = agent.teamName ? getTeamColor(agent.teamName) : null;
                const teamLabel = agent.teamName ? `Team ${shortTeamName(agent.teamName)}` : '';
                const teamDot = team ? `<span title="${this._escape(teamLabel)}" aria-label="${this._escape(teamLabel)}" style="display:inline-block;width:7px;height:7px;border-radius:50%;background:${team.accent};box-shadow:0 0 6px ${team.glow};margin-right:4px;vertical-align:middle"></span>` : '';
                html += `<div class="sidebar__agent ${agent.id === this.selectedId ? 'sidebar__agent--selected' : ''}"
                     data-agent-id="${agent.id}">
                    <span class="sidebar__agent-dot sidebar__agent-dot--${agent.status}"></span>
                    <div class="sidebar__agent-info">
                        <span class="sidebar__agent-name">${teamDot}${this._escape(agent.name)}</span>
                        <span class="sidebar__agent-model"><span style="color:${providerColor};font-weight:bold">${PROVIDER_ICONS[agent.provider] || '?'}</span> ${this._escape(this._shortModel(agent.model, agent.effort, agent.provider))}</span>
                    </div>
                </div>`;
            }
            html += '</div>';
        }

        this.listEl.innerHTML = html;
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
            this.harborListEl.innerHTML = '<div class="sidebar__agent sidebar__harbor-empty">No pending commits</div>';
            return;
        }

        const now = Date.now();
        this.harborListEl.innerHTML = repos.map(repo => {
            const profile = repo.profile || repoProfile(repo.project);
            const name = repo.repoName || repo.shortName || profile.shortName || profile.name || 'unknown';
            const count = Number(repo.pendingCommits ?? repo.count) || 0;
            const rel = formatRelative(Number(repo.latestEventTime) || 0, now);
            return `<div class="sidebar__agent sidebar__harbor-row" title="${this._escape(repo.project || '')}">
                <span class="sidebar__agent-dot sidebar__harbor-dot" style="background:${profile.accent};box-shadow:0 0 6px ${profile.glow}"></span>
                <div class="sidebar__agent-info">
                    <span class="sidebar__agent-name">${this._escape(name)}</span>
                    ${rel ? `<span class="sidebar__agent-model">${this._escape(rel)}</span>` : ''}
                </div>
                <span class="sidebar__project-count sidebar__harbor-count" style="color:${profile.accent}">${count}</span>
            </div>`;
        }).join('');
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

    _shortProjectName(path) {
        if (!path || path === '_unknown') return i18n.t('unknownProject');
        const parts = path.replace(/\/+$/, '').split('/').filter(Boolean);
        const last = parts[parts.length - 1] || path;
        // When this is the home directory itself (for example, /Users/username) → ~ display as
        if (parts.length <= 2 && parts[0] === 'Users') return '~';
        return last;
    }

    _escape(str) {
        if (!str) return '';
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
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
    }
}
