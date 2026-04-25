import { eventBus } from '../../domain/events/DomainEvent.js';
import { AvatarCanvas } from './AvatarCanvas.js';
import { i18n } from '../../config/i18n.js';

const TOOL_ICONS = {
    Read: '📖', Edit: '✏️', Write: '📝', Grep: '🔍', Glob: '📁',
    Bash: '⚡', Task: '📋', TaskCreate: '📋', TaskUpdate: '📋', TaskList: '📋',
    WebSearch: '🌐', WebFetch: '🌐', SendMessage: '💬', TeamCreate: '👥',
    NotebookEdit: '📓',
};

const TOOL_CATEGORIES = {
    Read: 'read', Grep: 'search', Glob: 'search', WebSearch: 'search', WebFetch: 'search',
    Edit: 'write', Write: 'write', NotebookEdit: 'write',
    Bash: 'exec',
    Task: 'task', TaskCreate: 'task', TaskUpdate: 'task', TaskList: 'task',
    SendMessage: 'task', TeamCreate: 'task',
};

const PROVIDER_BADGES = {
    claude: { label: 'Claude', color: '#a78bfa', bg: 'rgba(167,139,250,0.15)' },
    codex:  { label: 'Codex',  color: '#4ade80', bg: 'rgba(74,222,128,0.15)' },
    gemini: { label: 'Gemini', color: '#60a5fa', bg: 'rgba(96,165,250,0.15)' },
};

const PROJECT_COLORS = [
    '#e8d44d', '#4ade80', '#60a5fa', '#f97316', '#a78bfa',
    '#f472b6', '#34d399', '#fb923c', '#818cf8', '#22d3ee',
];

export class DashboardRenderer {
    constructor(world) {
        this.world = world;
        this.gridEl = document.getElementById('dashboardGrid');
        this.emptyEl = document.getElementById('dashboardEmpty');
        this.cards = new Map();
        this.toolHistories = new Map();
        this.active = false;
        this._fetchTimers = new Map();
        this._projectColorMap = new Map();
        this._sectionEls = new Map(); // projectPath → section element

        this._onAgentChanged = () => { if (this.active) this.render(); };
        eventBus.on('agent:added', this._onAgentChanged);
        eventBus.on('agent:updated', this._onAgentChanged);
        eventBus.on('agent:removed', this._onAgentChanged);
        eventBus.on('mode:changed', (mode) => {
            this.active = mode === 'dashboard';
            if (this.active) {
                this.render();
                this._startDetailFetching();
            } else {
                this._stopDetailFetching();
            }
        });
    }

    render() {
        const agents = Array.from(this.world.agents.values());

        if (agents.length === 0) {
            this.gridEl.style.display = 'none';
            this.emptyEl.classList.add('dashboard__empty--visible');
            return;
        }

        this.gridEl.style.display = '';
        this.emptyEl.classList.remove('dashboard__empty--visible');

        // Group by project
        const groups = this._groupByProject(agents);
        this._assignProjectColors(groups);

        // Status order: working > waiting > idle
        const order = { working: 0, waiting: 1, idle: 2 };

        const existingIds = new Set();
        const existingSections = new Set();

        for (const [projectPath, groupAgents] of groups) {
            existingSections.add(projectPath);
            groupAgents.sort((a, b) => (order[a.status] ?? 3) - (order[b.status] ?? 3));

            // Create/get section element
            let sectionEl = this._sectionEls.get(projectPath);
            if (!sectionEl) {
                sectionEl = this._createSection(projectPath);
                this._sectionEls.set(projectPath, sectionEl);
                this.gridEl.appendChild(sectionEl);
            }
            this._updateSectionHeader(sectionEl, projectPath, groupAgents);

            const gridInner = sectionEl.querySelector('.dashboard__section-grid');

            for (const agent of groupAgents) {
                existingIds.add(agent.id);
                let cardEl = this.cards.get(agent.id);

                if (!cardEl) {
                    cardEl = this._createCard(agent);
                    this.cards.set(agent.id, cardEl);
                }

                // Move the card if it is not in this section
                if (cardEl.parentElement !== gridInner) {
                    gridInner.appendChild(cardEl);
                }

                this._updateCard(cardEl, agent);
            }
        }

        // Remove missing agent cards
        for (const [id, cardEl] of this.cards) {
            if (!existingIds.has(id)) {
                cardEl.remove();
                this.cards.delete(id);
                this.toolHistories.delete(id);
            }
        }

        // Remove missing sections
        for (const [path, sectionEl] of this._sectionEls) {
            if (!existingSections.has(path)) {
                sectionEl.remove();
                this._sectionEls.delete(path);
            }
        }
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

    _assignProjectColors(groups) {
        let idx = 0;
        for (const key of groups.keys()) {
            if (!this._projectColorMap.has(key)) {
                this._projectColorMap.set(key, PROJECT_COLORS[idx % PROJECT_COLORS.length]);
            }
            idx++;
        }
    }

    _shortProjectName(path) {
        if (!path || path === '_unknown') return i18n.t('unknownProject');
        const parts = path.replace(/\/+$/, '').split('/').filter(Boolean);
        const last = parts[parts.length - 1] || path;
        // When this is the home directory itself (for example, /Users/username) → ~ display as
        if (parts.length <= 2 && parts[0] === 'Users') return '~';
        return last;
    }

    _createSection(projectPath) {
        const section = document.createElement('div');
        section.className = 'dashboard__section';
        section.dataset.project = projectPath;

        const color = this._projectColorMap.get(projectPath) || '#8b8b9e';
        section.innerHTML = `
            <div class="dashboard__section-header" style="border-left-color: ${color}">
                <span class="dashboard__section-dot" style="background: ${color}"></span>
                <span class="dashboard__section-name"></span>
                <span class="dashboard__section-path"></span>
                <span class="dashboard__section-count"></span>
            </div>
            <div class="dashboard__section-grid"></div>
        `;
        return section;
    }

    _updateSectionHeader(sectionEl, projectPath, agents) {
        const name = this._shortProjectName(projectPath);
        sectionEl.querySelector('.dashboard__section-name').textContent = name;
        sectionEl.querySelector('.dashboard__section-count').textContent = i18n.t('nAgents')(agents.length);

        // Display shortened path
        const shortPath = projectPath === '_unknown' ? '' : this._truncatePath(projectPath);
        sectionEl.querySelector('.dashboard__section-path').textContent = shortPath;
    }

    _truncatePath(path) {
        if (!path) return '';
        // Shorten to start with ~/
        const home = '/Users/';
        if (path.startsWith(home)) {
            const afterHome = path.substring(home.length);
            const slashIdx = afterHome.indexOf('/');
            if (slashIdx >= 0) {
                return '~' + afterHome.substring(slashIdx);
            }
        }
        return path;
    }

    _createCard(agent) {
        const card = document.createElement('div');
        card.className = `dash-card dash-card--${agent.status}`;
        card.dataset.agentId = agent.id;

        card.innerHTML = `
            <div class="dash-card__header">
                <div class="dash-card__avatar"></div>
                <div class="dash-card__info">
                    <div class="dash-card__name"></div>
                    <div class="dash-card__meta">
                        <span class="dash-card__provider-badge"></span>
                        <span class="dash-card__model"></span>
                        <span class="dash-card__role"></span>
                    </div>
                </div>
                <div class="dash-card__status">
                    <span class="dash-card__status-dot"></span>
                    <span class="dash-card__status-label"></span>
                </div>
            </div>
            <div class="dash-card__activity">
                <div class="dash-card__current-tool">
                    <span class="dash-card__tool-icon"></span>
                    <div class="dash-card__tool-info">
                        <div class="dash-card__tool-name"></div>
                        <div class="dash-card__tool-detail"></div>
                    </div>
                </div>
                <div class="dash-card__message"></div>
            </div>
            <div class="dash-card__tools">
                <div class="dash-card__tools-title">${i18n.t('toolHistory')}</div>
                <div class="dash-card__tool-list">
                    <div class="dash-card__loading">
                        <span class="dash-card__loading-spinner"></span>Loading...
                    </div>
                </div>
            </div>
        `;

        // Avatar canvas
        const avatarContainer = card.querySelector('.dash-card__avatar');
        const avatarCanvas = new AvatarCanvas(agent);
        avatarContainer.appendChild(avatarCanvas.canvas);

        // Click to select agent
        card.addEventListener('click', () => {
            eventBus.emit('agent:selected', agent);
        });

        return card;
    }

    _updateCard(cardEl, agent) {
        // Status class
        cardEl.className = `dash-card dash-card--${agent.status}`;

        // Header
        cardEl.querySelector('.dash-card__name').textContent = agent.name;
        cardEl.querySelector('.dash-card__model').textContent = this._shortModel(agent.model);
        cardEl.querySelector('.dash-card__role').textContent = agent.role || '';

        // Provider badge
        const badgeEl = cardEl.querySelector('.dash-card__provider-badge');
        const badge = PROVIDER_BADGES[agent.provider] || PROVIDER_BADGES.claude;
        badgeEl.textContent = badge.label;
        badgeEl.style.color = badge.color;
        badgeEl.style.background = badge.bg;

        const statusEl = cardEl.querySelector('.dash-card__status');
        statusEl.className = `dash-card__status dash-card__status--${agent.status}`;
        const statusKey = { working: 'statusWorking', idle: 'statusIdle', waiting: 'statusWaiting' };
        cardEl.querySelector('.dash-card__status-label').textContent = i18n.t(statusKey[agent.status] || agent.status);

        // Current tool
        const toolBox = cardEl.querySelector('.dash-card__current-tool');
        const toolIcon = cardEl.querySelector('.dash-card__tool-icon');
        const toolName = cardEl.querySelector('.dash-card__tool-name');
        const toolDetail = cardEl.querySelector('.dash-card__tool-detail');

        if (agent.currentTool) {
            toolBox.classList.remove('dash-card__current-tool--idle');
            toolIcon.textContent = this._getToolIcon(agent.currentTool);
            toolName.textContent = agent.currentTool;
            toolDetail.textContent = agent.currentToolInput || '';
        } else {
            toolBox.classList.add('dash-card__current-tool--idle');
            toolIcon.textContent = agent.status === 'idle' ? '💤' : '⏳';
            toolName.textContent = agent.status === 'idle' ? i18n.t('statusIdle') : i18n.t('statusWaiting') + '...';
            toolDetail.textContent = '';
        }

        // Messages
        const msgEl = cardEl.querySelector('.dash-card__message');
        if (agent.lastMessage) {
            msgEl.textContent = `"${agent.lastMessage}"`;
            msgEl.style.display = '';
        } else {
            msgEl.style.display = 'none';
        }

        // Render tool history
        const history = this.toolHistories.get(agent.id);
        if (history) {
            this._renderToolHistory(cardEl, history);
        }
    }

    _renderToolHistory(cardEl, tools) {
        const listEl = cardEl.querySelector('.dash-card__tool-list');
        if (!tools || tools.length === 0) {
            listEl.innerHTML = `<div class="dash-card__loading" style="color:#666">${i18n.t('noToolUsage')}</div>`;
            return;
        }

        // Newest first
        const reversed = [...tools].reverse();
        listEl.innerHTML = reversed.map(t => {
            const cat = this._getToolCategory(t.tool);
            const icon = this._getToolIcon(t.tool);
            const shortName = t.tool.replace('mcp__playwright__', 'pw:').replace('mcp__', '');
            const detail = t.detail ? this._truncate(t.detail, 60) : '';
            return `<div class="dash-card__tool-item">
                <span class="dash-card__tool-item-icon tool-cat--${cat}">${icon}</span>
                <span class="dash-card__tool-item-name tool-cat--${cat}">${this._escapeHtml(shortName)}</span>
                <span class="dash-card__tool-item-detail">${this._escapeHtml(detail)}</span>
            </div>`;
        }).join('');
    }

    _startDetailFetching() {
        this._stopDetailFetching();
        // Run once immediately, then every 3 seconds
        this._fetchAllDetails();
        this._globalFetchTimer = setInterval(() => this._fetchAllDetails(), 3000);
    }

    _stopDetailFetching() {
        if (this._globalFetchTimer) {
            clearInterval(this._globalFetchTimer);
            this._globalFetchTimer = null;
        }
    }

    async _fetchAllDetails() {
        const agents = Array.from(this.world.agents.values());
        const promises = agents.map(agent => this._fetchDetail(agent));
        await Promise.allSettled(promises);
    }

    async _fetchDetail(agent) {
        try {
            const params = new URLSearchParams({
                sessionId: agent.id,
                project: agent.projectPath || '',
                provider: agent.provider || 'claude',
            });
            const resp = await fetch(`/api/session-detail?${params}`);
            if (!resp.ok) return;
            const data = await resp.json();
            if (data.toolHistory) {
                this.toolHistories.set(agent.id, data.toolHistory);
                const cardEl = this.cards.get(agent.id);
                if (cardEl) this._renderToolHistory(cardEl, data.toolHistory);
            }
        } catch {
            // Ignore network errors.
        }
    }

    _getToolIcon(tool) {
        if (!tool) return '❓';
        // MCP tools
        if (tool.startsWith('mcp__playwright__')) return '🎭';
        if (tool.startsWith('mcp__')) return '🔌';
        return TOOL_ICONS[tool] || '🔧';
    }

    _getToolCategory(tool) {
        if (!tool) return 'other';
        if (tool.startsWith('mcp__')) return 'exec';
        return TOOL_CATEGORIES[tool] || 'other';
    }

    _shortModel(model) {
        if (!model) return '';
        return model.replace('claude-', '').replace(/-\d{8}$/, '');
    }

    _truncate(str, max) {
        return str.length > max ? str.substring(0, max - 1) + '...' : str;
    }

    _escapeHtml(str) {
        if (!str) return '';
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    destroy() {
        this._stopDetailFetching();
        eventBus.off('agent:added', this._onAgentChanged);
        eventBus.off('agent:updated', this._onAgentChanged);
        eventBus.off('agent:removed', this._onAgentChanged);
    }
}
