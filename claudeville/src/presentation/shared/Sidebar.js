import { eventBus } from '../../domain/events/DomainEvent.js';
import { i18n } from '../../config/i18n.js';
import { formatModelLabel, getModelVisualIdentity } from './ModelVisualIdentity.js';
import { getTeamColor, shortTeamName } from './TeamColor.js';
import { repoProfile } from './RepoColor.js';

const PROVIDER_ICONS = { claude: 'C', codex: 'X', gemini: 'G', git: '#' };
const PROVIDER_COLORS = { claude: '#a78bfa', codex: '#4ade80', gemini: '#60a5fa', git: '#f6cf60' };

export class Sidebar {
    constructor(world) {
        this.world = world;
        this.sidebarEl = document.getElementById('sidebar');
        this.listEl = document.getElementById('agentList');
        this.countEl = document.getElementById('agentCount');
        this.toggleEl = document.getElementById('sidebarToggle');
        this.selectedId = null;
        this.isCollapsed = localStorage.getItem('claudeville.sidebarCollapsed') === 'true';

        this._onUpdate = () => this.render();
        eventBus.on('agent:added', this._onUpdate);
        eventBus.on('agent:updated', this._onUpdate);
        eventBus.on('agent:removed', this._onUpdate);

        this._bindToggle();
        this._applyCollapsedState();
        this.render();
    }

    _bindToggle() {
        if (!this.toggleEl) return;
        this.toggleEl.addEventListener('click', () => {
            this.isCollapsed = !this.isCollapsed;
            localStorage.setItem('claudeville.sidebarCollapsed', String(this.isCollapsed));
            this._applyCollapsedState();
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

        // Bind click events
        this.listEl.querySelectorAll('.sidebar__agent').forEach(el => {
            el.addEventListener('click', () => {
                const id = el.dataset.agentId;
                this.selectedId = this.selectedId === id ? null : id;
                const agent = this.world.agents.get(id);
                if (agent) {
                    eventBus.emit('agent:selected', agent);
                }
                this.render();
            });
        });
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
    }
}
