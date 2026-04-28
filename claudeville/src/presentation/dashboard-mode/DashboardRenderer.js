import { eventBus } from '../../domain/events/DomainEvent.js';
import { AvatarCanvas } from './AvatarCanvas.js';
import { i18n } from '../../config/i18n.js';
import { sessionDetailsService } from '../shared/SessionDetailsService.js';
import { SESSION_DETAIL_REFRESH_INTERVAL } from '../../config/constants.js';
import { formatModelLabel, getModelVisualIdentity } from '../shared/ModelVisualIdentity.js';
import { repoProfile } from '../shared/RepoColor.js';
import { el, replaceChildren } from '../shared/DomSafe.js';
import { hashRows, normalizeStatus, shortenHomePath, shortProjectName, truncateText } from '../shared/Formatters.js';
import { shortToolName, toolCategory, toolIcon } from '../../domain/services/ToolIdentity.js';

const PROVIDER_BADGES = {
    claude: { label: 'Claude', color: '#a78bfa', bg: 'rgba(167,139,250,0.15)' },
    codex:  { label: 'Codex',  color: '#4ade80', bg: 'rgba(74,222,128,0.15)' },
    gemini: { label: 'Gemini', color: '#60a5fa', bg: 'rgba(96,165,250,0.15)' },
    git:    { label: 'Git',    color: '#f6cf60', bg: 'rgba(246,207,96,0.15)' },
};
const DASHBOARD_TOOL_HISTORY_LIMIT = 12;
const DETAIL_FETCH_LIMIT = 48;

export class DashboardRenderer {
    constructor(world) {
        this.world = world;
        this.gridEl = document.getElementById('dashboardGrid');
        this.emptyEl = document.getElementById('dashboardEmpty');
        this.cards = new Map();
        this.toolHistories = new Map();
        this.toolHistoryRenderSignatures = new Map();
        this._cardRenderSignatures = new Map();
        this._visibleAgentIds = new Set();
        this._selectedAgentId = null;
        this.active = false;
        this._isFetchingDetails = false;
        this._detailFetchGeneration = 0;
        this._sectionEls = new Map(); // projectPath → section element
        this._sectionRefs = new Map(); // projectPath → cached section refs
        this._observer = this._createVisibilityObserver();

        this._onAgentAdded = () => { if (this.active) this.render(); };
        this._onAgentUpdated = (agent) => {
            if (this.active) this._renderAgentUpdate(agent);
        };
        this._onAgentRemoved = (agent) => {
            this.toolHistories.delete(agent.id);
            this.toolHistoryRenderSignatures.delete(agent.id);
            this._cardRenderSignatures.delete(agent.id);
            this._visibleAgentIds.delete(agent.id);
            sessionDetailsService.deleteForAgent(agent);
            if (this.active) this.render();
        };
        this._onAgentSelected = (agent) => {
            this._selectedAgentId = agent?.id || null;
            if (this.active) void this._fetchAllDetails();
        };
        this._onAgentDeselected = () => {
            this._selectedAgentId = null;
        };
        this._onModeChanged = (mode) => {
            this.active = mode === 'dashboard';
            if (this.active) {
                this.render();
                this._startDetailFetching();
            } else {
                this._stopDetailFetching();
            }
        };
        eventBus.on('agent:added', this._onAgentAdded);
        eventBus.on('agent:updated', this._onAgentUpdated);
        eventBus.on('agent:removed', this._onAgentRemoved);
        eventBus.on('agent:selected', this._onAgentSelected);
        eventBus.on('agent:deselected', this._onAgentDeselected);
        eventBus.on('mode:changed', this._onModeChanged);
    }

    render() {
        const agents = Array.from(this.world.agents.values());

        if (agents.length === 0) {
            this._detailFetchGeneration++;
            this._clearAllCardsAndSections();
            this.gridEl.style.display = 'none';
            this.emptyEl.classList.add('dashboard__empty--visible');
            sessionDetailsService.sweep([]);
            return;
        }

        this.gridEl.style.display = '';
        this.emptyEl.classList.remove('dashboard__empty--visible');

        // Group by project
        const groups = this._groupByProject(agents);

        // Status order: working > waiting > idle
        const order = { working: 0, waiting: 1, idle: 2 };

        const existingIds = new Set();
        const existingSections = new Set();

        for (const [projectPath, groupAgents] of groups) {
            existingSections.add(projectPath);
            groupAgents.sort((a, b) => {
                const statusA = normalizeStatus(a.status);
                const statusB = normalizeStatus(b.status);
                return (order[statusA] ?? 3) - (order[statusB] ?? 3);
            });

            // Create/get section element
            let sectionEl = this._sectionEls.get(projectPath);
            if (!sectionEl) {
                sectionEl = this._createSection(projectPath);
                this._sectionEls.set(projectPath, sectionEl);
                this._sectionRefs.set(projectPath, {
                    name: sectionEl.querySelector('.dashboard__section-name'),
                    path: sectionEl.querySelector('.dashboard__section-path'),
                    count: sectionEl.querySelector('.dashboard__section-count'),
                    grid: sectionEl.querySelector('.dashboard__section-grid'),
                });
                this.gridEl.appendChild(sectionEl);
            }
            this._updateSectionHeader(sectionEl, projectPath, groupAgents);

            const sectionRefs = this._sectionRefs.get(projectPath) || {};
            const gridInner = sectionRefs.grid || sectionEl.querySelector('.dashboard__section-grid');

            for (const agent of groupAgents) {
                existingIds.add(agent.id);
                let cardEl = this.cards.get(agent.id);

                if (!cardEl) {
                    cardEl = this._createCard(agent);
                    this.cards.set(agent.id, cardEl);
                    this._observer?.observe(cardEl);
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
                this._observer?.unobserve?.(cardEl);
                cardEl._avatarCanvas?.destroy?.();
                cardEl.remove();
                this.cards.delete(id);
                this.toolHistories.delete(id);
                this.toolHistoryRenderSignatures.delete(id);
                this._cardRenderSignatures.delete(id);
                this._visibleAgentIds.delete(id);
            }
        }

        // Remove missing sections
        for (const [path, sectionEl] of this._sectionEls) {
            if (!existingSections.has(path)) {
                sectionEl.remove();
                this._sectionEls.delete(path);
                this._sectionRefs.delete(path);
            }
        }
        sessionDetailsService.sweep(agents);
    }

    _createVisibilityObserver() {
        if (typeof IntersectionObserver === 'undefined') return null;
        const root = document.getElementById('dashboardMode') || null;
        return new IntersectionObserver((entries) => {
            for (const entry of entries) {
                const id = entry.target?.dataset?.agentId;
                if (!id) continue;
                if (entry.isIntersecting) this._visibleAgentIds.add(id);
                else this._visibleAgentIds.delete(id);
            }
        }, { root, rootMargin: '160px 0px', threshold: 0.01 });
    }

    _renderAgentUpdate(agent) {
        const cardEl = this.cards.get(agent.id);
        const projectPath = agent.projectPath || '_unknown';
        const status = normalizeStatus(agent.status);
        if (!cardEl || cardEl._projectPath !== projectPath || cardEl._status !== status) {
            this.render();
            return;
        }
        this._updateCard(cardEl, agent);
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

    _projectProfile(projectPath) {
        if (!projectPath || projectPath === '_unknown') {
            return {
                accent: '#8b8b9e',
                glow: 'rgba(139, 139, 158, 0.3)',
                panel: 'rgba(28, 28, 36, 0.72)',
            };
        }
        return repoProfile(projectPath);
    }

    _createSection(projectPath) {
        const section = document.createElement('div');
        section.className = 'dashboard__section';
        section.dataset.project = projectPath;

        const profile = this._projectProfile(projectPath);
        section.innerHTML = `
            <div class="dashboard__section-header" style="border-left-color: ${profile.accent}; background: ${profile.panel}">
                <span class="dashboard__section-dot" style="background: ${profile.accent}; box-shadow: 0 0 8px ${profile.glow}"></span>
                <span class="dashboard__section-name" style="color: ${profile.accent}"></span>
                <span class="dashboard__section-path"></span>
                <span class="dashboard__section-count" style="color: ${profile.accent}"></span>
            </div>
            <div class="dashboard__section-grid"></div>
        `;
        return section;
    }

    _updateSectionHeader(sectionEl, projectPath, agents) {
        const refs = sectionEl._sectionRefs || {
            name: sectionEl.querySelector('.dashboard__section-name'),
            path: sectionEl.querySelector('.dashboard__section-path'),
            count: sectionEl.querySelector('.dashboard__section-count'),
        };
        sectionEl._sectionRefs = refs;
        const name = shortProjectName(projectPath, i18n.t('unknownProject'));
        refs.name.textContent = name;
        refs.count.textContent = i18n.t('nAgents')(agents.length);

        // Display shortened path
        const shortPath = projectPath === '_unknown' ? '' : shortenHomePath(projectPath);
        refs.path.textContent = shortPath;
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
        card._avatarCanvas = avatarCanvas;
        card._avatarSignature = '';

        // Click to select agent
        card.addEventListener('click', () => {
            const current = this.world.agents.get(card.dataset.agentId);
            if (current) eventBus.emit('agent:selected', current);
        });

        card._elements = {
            name: card.querySelector('.dash-card__name'),
            model: card.querySelector('.dash-card__model'),
            role: card.querySelector('.dash-card__role'),
            providerBadge: card.querySelector('.dash-card__provider-badge'),
            status: card.querySelector('.dash-card__status'),
            statusLabel: card.querySelector('.dash-card__status-label'),
            currentTool: card.querySelector('.dash-card__current-tool'),
            toolIcon: card.querySelector('.dash-card__tool-icon'),
            toolName: card.querySelector('.dash-card__tool-name'),
            toolDetail: card.querySelector('.dash-card__tool-detail'),
            message: card.querySelector('.dash-card__message'),
            toolList: card.querySelector('.dash-card__tool-list'),
        };

        return card;
    }

    _updateCard(cardEl, agent) {
        const refs = cardEl._elements;
        const status = normalizeStatus(agent.status);
        const identity = getModelVisualIdentity(agent.model, agent.effort, agent.provider);
        const signature = [
            agent.name || '',
            agent.model || '',
            agent.effort || '',
            agent.provider || '',
            agent.role || '',
            status,
            agent.currentTool || '',
            agent.currentToolInput || '',
            agent.lastMessage || '',
            i18n.lang || '',
        ].join('|');

        cardEl._projectPath = agent.projectPath || '_unknown';
        cardEl._status = status;
        if (this._cardRenderSignatures.get(agent.id) !== signature) {
            this._cardRenderSignatures.set(agent.id, signature);

            const nextClass = `dash-card dash-card--${status}`;
            if (cardEl.className !== nextClass) cardEl.className = nextClass;

            this._setText(refs.name, agent.name);
            this._setText(refs.model, this._shortModel(agent.model, agent.effort, agent.provider));
            this._setStyle(refs.model, 'color', identity.accent?.[0] || '');
            refs.model.title = identity.label || agent.model || '';
            this._setText(refs.role, agent.role || '');

            const badge = PROVIDER_BADGES[agent.provider] || PROVIDER_BADGES.claude;
            this._setText(refs.providerBadge, badge.label);
            this._setStyle(refs.providerBadge, 'color', badge.color);
            this._setStyle(refs.providerBadge, 'background', badge.bg);

            const nextStatusClass = `dash-card__status dash-card__status--${status}`;
            if (refs.status.className !== nextStatusClass) refs.status.className = nextStatusClass;
            const statusKey = { working: 'statusWorking', idle: 'statusIdle', waiting: 'statusWaiting' };
            this._setText(refs.statusLabel, i18n.t(statusKey[status] || status));

            if (agent.currentTool) {
                refs.currentTool.classList.remove('dash-card__current-tool--idle');
                this._setText(refs.toolIcon, toolIcon(agent.currentTool));
                this._setText(refs.toolName, agent.currentTool);
                this._setText(refs.toolDetail, agent.currentToolInput || '');
            } else {
                refs.currentTool.classList.add('dash-card__current-tool--idle');
                this._setText(refs.toolIcon, status === 'idle' ? '💤' : '⏳');
                this._setText(refs.toolName, status === 'idle' ? i18n.t('statusIdle') : i18n.t('statusWaiting') + '...');
                this._setText(refs.toolDetail, '');
            }

            if (agent.lastMessage) {
                this._setText(refs.message, `"${agent.lastMessage}"`);
                this._setStyle(refs.message, 'display', '');
            } else {
                this._setStyle(refs.message, 'display', 'none');
            }
        }
        const avatarSignature = `${agent.model || ''}|${agent.effort || ''}|${agent.provider || ''}`;
        if (cardEl._avatarCanvas && cardEl._avatarSignature !== avatarSignature) {
            cardEl._avatarSignature = avatarSignature;
            cardEl._avatarCanvas.agent = agent;
            cardEl._avatarCanvas.draw();
        }

        // Render tool history
        const history = this.toolHistories.get(agent.id);
        if (history) {
            this._renderToolHistory(cardEl, agent.id, history);
        }
    }

    _renderToolHistory(cardEl, agentId, tools) {
        const listEl = cardEl._elements.toolList;
        const limited = (tools || []).slice(-DASHBOARD_TOOL_HISTORY_LIMIT);

        const signature = `${limited.length}|${hashRows(limited, [
            row => row?.ts || 0,
            row => row?.tool || '',
            row => (row?.detail || '').slice(0, 60),
        ])}`;

        if (this.toolHistoryRenderSignatures.get(agentId) === signature) return;
        this.toolHistoryRenderSignatures.set(agentId, signature);

        if (!limited.length) {
            replaceChildren(listEl, [
                el('div', {
                    className: 'dash-card__loading',
                    text: i18n.t('noToolUsage'),
                    style: { color: '#666' },
                }),
            ]);
            return;
        }

        // Newest first
        const reversed = [...limited].reverse();
        replaceChildren(listEl, reversed.map(t => {
            const cat = toolCategory(t.tool);
            const detail = t.detail ? truncateText(t.detail, 60) : '';
            return el('div', { className: 'dash-card__tool-item' }, [
                el('span', { className: ['dash-card__tool-item-icon', `tool-cat--${cat}`], text: toolIcon(t.tool) }),
                el('span', { className: ['dash-card__tool-item-name', `tool-cat--${cat}`], text: shortToolName(t.tool) }),
                el('span', { className: 'dash-card__tool-item-detail', text: detail }),
            ]);
        }));
    }

    _startDetailFetching() {
        this._stopDetailFetching();
        this._detailFetchGeneration++;
        // Run once immediately, then every 3 seconds
        this._fetchAllDetails();
        this._globalFetchTimer = setInterval(() => this._fetchAllDetails(), SESSION_DETAIL_REFRESH_INTERVAL);
    }

    _stopDetailFetching() {
        if (this._globalFetchTimer) {
            clearInterval(this._globalFetchTimer);
            this._globalFetchTimer = null;
        }
        this._detailFetchGeneration++;
    }

    async _fetchAllDetails() {
        if (!this.active || this._isFetchingDetails) return;
        this._isFetchingDetails = true;
        const generation = this._detailFetchGeneration;

        const agents = Array.from(this.world.agents.values());
        try {
            const candidates = this._detailCandidates(agents);
            const detailsByAgentId = await sessionDetailsService.fetchSessionDetailsBatch(candidates);
            if (!this.active || generation !== this._detailFetchGeneration) return;
            for (const agent of candidates) {
                const data = detailsByAgentId.get(agent.id);
                if (!data || !data.toolHistory) continue;
                this.toolHistories.set(agent.id, data.toolHistory.slice(-DASHBOARD_TOOL_HISTORY_LIMIT));
                const cardEl = this.cards.get(agent.id);
                if (cardEl) this._renderToolHistory(cardEl, agent.id, data.toolHistory);
            }
        } finally {
            this._isFetchingDetails = false;
        }
    }

    _clearAllCardsAndSections() {
        for (const [id, cardEl] of this.cards) {
            this._observer?.unobserve?.(cardEl);
            cardEl._avatarCanvas?.destroy?.();
            cardEl.remove();
            this.cards.delete(id);
        }
        this.toolHistories.clear();
        this.toolHistoryRenderSignatures.clear();
        this._cardRenderSignatures.clear();
        this._visibleAgentIds.clear();

        for (const [, sectionEl] of this._sectionEls) sectionEl.remove();
        this._sectionEls.clear();
        this._sectionRefs.clear();
    }

    _detailCandidates(agents) {
        this._syncVisibleAgentIdsFromLayout();
        const selected = [];
        const active = [];
        const visible = [];
        for (const agent of agents) {
            if (agent.id === this._selectedAgentId) selected.push(agent);
            else if (['working', 'waiting'].includes(normalizeStatus(agent.status))) active.push(agent);
            else if (!this._observer || this._visibleAgentIds.has(agent.id)) visible.push(agent);
        }
        const seen = new Set();
        const out = [];
        for (const agent of [...selected, ...active, ...visible]) {
            if (seen.has(agent.id)) continue;
            seen.add(agent.id);
            out.push(agent);
            if (out.length >= DETAIL_FETCH_LIMIT) break;
        }
        return out;
    }

    _syncVisibleAgentIdsFromLayout() {
        if (!this._observer || !this.active || this.cards.size === 0) return;
        const root = document.getElementById('dashboardMode') || this.gridEl;
        const rootRect = root?.getBoundingClientRect?.();
        if (!rootRect || rootRect.width <= 0 || rootRect.height <= 0) return;

        const top = rootRect.top - 160;
        const bottom = rootRect.bottom + 160;
        for (const [id, cardEl] of this.cards) {
            if (!cardEl.isConnected) {
                this._visibleAgentIds.delete(id);
                continue;
            }
            const rect = cardEl.getBoundingClientRect();
            if (rect.bottom >= top && rect.top <= bottom && rect.right >= rootRect.left && rect.left <= rootRect.right) {
                this._visibleAgentIds.add(id);
            } else {
                this._visibleAgentIds.delete(id);
            }
        }
    }

    _shortModel(model, effort, provider) {
        if (!model) return '';
        return formatModelLabel(model, effort, provider);
    }

    _setText(el, value) {
        const next = value == null ? '' : String(value);
        if (el && el.textContent !== next) el.textContent = next;
    }

    _setStyle(el, prop, value) {
        if (el && el.style[prop] !== value) el.style[prop] = value;
    }

    destroy() {
        this._stopDetailFetching();
        for (const cardEl of this.cards.values()) {
            this._observer?.unobserve?.(cardEl);
            cardEl._avatarCanvas?.destroy?.();
        }
        this._observer?.disconnect?.();
        eventBus.off('agent:added', this._onAgentAdded);
        eventBus.off('agent:updated', this._onAgentUpdated);
        eventBus.off('agent:removed', this._onAgentRemoved);
        eventBus.off('agent:selected', this._onAgentSelected);
        eventBus.off('agent:deselected', this._onAgentDeselected);
        eventBus.off('mode:changed', this._onModeChanged);
    }
}
