import { eventBus } from '../../domain/events/DomainEvent.js';
import { AvatarCanvas } from './AvatarCanvas.js';
import { i18n } from '../../config/i18n.js';
import { sessionDetailsService } from '../shared/SessionDetailsService.js';
import { SESSION_DETAIL_REFRESH_INTERVAL } from '../../config/constants.js';
import { replaceChildren } from '../shared/DomSafe.js';
import { TokenUsage } from '../../domain/value-objects/TokenUsage.js';
import { formatCost, formatRelative, formatTokens, normalizeStatus, shortenHomePath, shortProjectName, truncateText } from '../shared/Formatters.js';
import { AgentSelectionMirror, emitAgentSelected } from '../shared/AgentSelection.js';
import { getTeamColor, shortTeamName } from '../shared/TeamColor.js';
import {
    buildingClassForAgent,
    buildingPresentation,
    currentToolPresentation,
    groupAgentsByProject,
    modelPresentation,
    projectProfile,
    providerPresentation,
    sortAgentsByStatus,
    statusPresentation,
    toolHistoryNodes,
    toolHistorySignature,
} from '../shared/AgentPresentation.js';

const DASHBOARD_TOOL_HISTORY_LIMIT = 12;
const DETAIL_FETCH_LIMIT = 48;

export class DashboardRenderer {
    constructor(world, { toast = null } = {}) {
        this.world = world;
        this.toast = toast;
        this.gridEl = document.getElementById('dashboardGrid');
        this.emptyEl = document.getElementById('dashboardEmpty');
        this._appendEmptyHints();
        this.cards = new Map();
        this.toolHistories = new Map();
        this.usageFooters = new Map();
        this.toolHistoryRenderSignatures = new Map();
        this._cardRenderSignatures = new Map();
        this._visibleAgentIds = new Set();
        this._visibilityLayoutDirty = true;
        this._selectedAgentId = null;
        this.active = false;
        this._destroyed = false;
        this._isFetchingDetails = false;
        this._detailFetchGeneration = 0;
        this._sectionEls = new Map(); // projectPath → section element
        this._pendingAvatarDraws = new Set();
        this._avatarDrawFrame = null;
        this._observer = this._createVisibilityObserver();
        this.selection = new AgentSelectionMirror({
            notifyOnRepeat: true,
            onChange: (nextId) => {
                this._selectedAgentId = nextId;
                if (this.active) void this._fetchAllDetails();
            },
        });

        this._onAgentAdded = () => { if (this.active) this.render(); };
        this._onAgentUpdated = (agent) => {
            if (this.active) this._renderAgentUpdate(agent);
        };
        this._onAgentRemoved = (agent) => {
            this._removeCard(agent.id);
            sessionDetailsService.deleteForAgent(agent);
            if (this.active) this.render();
        };
        this._onModeChanged = (mode) => {
            this.active = mode === 'dashboard';
            if (this.active) {
                this._visibilityLayoutDirty = true;
                this.render();
                this._startDetailFetching();
            } else {
                this._stopDetailFetching();
            }
        };
        // Pause detail polling while the tab is hidden; refresh once on return.
        this._onVisibilityChange = () => {
            if (!document.hidden && this.active) this._fetchAllDetails();
        };
        eventBus.on('agent:added', this._onAgentAdded);
        eventBus.on('agent:updated', this._onAgentUpdated);
        eventBus.on('agent:removed', this._onAgentRemoved);
        eventBus.on('mode:changed', this._onModeChanged);
        document.addEventListener('visibilitychange', this._onVisibilityChange);
    }

    render() {
        this._visibilityLayoutDirty = true;
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

        const groups = groupAgentsByProject(agents);

        const existingIds = new Set();
        const existingSections = new Set();

        for (const [projectPath, groupAgents] of groups) {
            existingSections.add(projectPath);
            sortAgentsByStatus(groupAgents);

            // Create/get section element
            let sectionEl = this._sectionEls.get(projectPath);
            if (!sectionEl) {
                sectionEl = this._createSection(projectPath);
                this._sectionEls.set(projectPath, sectionEl);
                this.gridEl.appendChild(sectionEl);
            }
            this._updateSectionHeader(sectionEl, projectPath, groupAgents);

            const gridInner = sectionEl._sectionRefs?.grid || sectionEl.querySelector('.dashboard__section-grid');

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
                this._removeCard(id, { removeEmptySection: false });
            }
        }

        // Remove missing sections
        for (const [path, sectionEl] of this._sectionEls) {
            if (!existingSections.has(path)) {
                if (sectionEl._erroredFlashTimer) clearTimeout(sectionEl._erroredFlashTimer);
                sectionEl.remove();
                this._sectionEls.delete(path);
            }
        }
        sessionDetailsService.sweep(agents);
        if (this.active) this._syncVisibleAgentIdsFromLayout();
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

    _createSection(projectPath) {
        const section = document.createElement('div');
        section.className = 'dashboard__section';
        section.dataset.project = projectPath;

        const profile = projectProfile(projectPath);
        section.innerHTML = `
            <div class="dashboard__section-header" style="border-left-color: ${profile.panelBorder || profile.accent}; background: ${profile.panel}">
                <span class="dashboard__section-dot" style="background: ${profile.accent}; box-shadow: 0 0 8px ${profile.glow}"></span>
                <span class="dashboard__label-icon">#</span>
                <span class="dashboard__section-name" style="color: ${profile.labelText || profile.accent}"></span>
                <span class="dashboard__section-path"></span>
                <span class="dashboard__section-health">
                    <span class="dashboard__health-stat dashboard__health-stat--errored" style="display: none"></span>
                    <span class="dashboard__health-stat dashboard__health-stat--working" style="display: none"></span>
                    <span class="dashboard__health-stat dashboard__health-stat--idle" style="display: none"></span>
                </span>
                <span class="dashboard__section-count" style="color: ${profile.labelText || profile.accent}"></span>
            </div>
            <div class="dashboard__section-healthbar" aria-hidden="true">
                <span class="dashboard__healthbar-seg dashboard__healthbar-seg--errored"></span>
                <span class="dashboard__healthbar-seg dashboard__healthbar-seg--working"></span>
                <span class="dashboard__healthbar-seg dashboard__healthbar-seg--idle"></span>
            </div>
            <div class="dashboard__section-grid"></div>
        `;
        section._sectionRefs = {
            name: section.querySelector('.dashboard__section-name'),
            path: section.querySelector('.dashboard__section-path'),
            count: section.querySelector('.dashboard__section-count'),
            grid: section.querySelector('.dashboard__section-grid'),
            healthErrored: section.querySelector('.dashboard__health-stat--errored'),
            healthWorking: section.querySelector('.dashboard__health-stat--working'),
            healthIdle: section.querySelector('.dashboard__health-stat--idle'),
            healthBarErrored: section.querySelector('.dashboard__healthbar-seg--errored'),
            healthBarWorking: section.querySelector('.dashboard__healthbar-seg--working'),
            healthBarIdle: section.querySelector('.dashboard__healthbar-seg--idle'),
        };
        section._erroredCount = 0;
        return section;
    }

    _updateSectionHeader(sectionEl, projectPath, agents) {
        const refs = sectionEl._sectionRefs;
        const name = shortProjectName(projectPath, i18n.t('unknownProject'));
        refs.name.textContent = name;
        refs.count.textContent = i18n.t('nAgents')(agents.length);

        // Display shortened path
        const shortPath = projectPath === '_unknown' ? '' : shortenHomePath(projectPath);
        refs.path.textContent = shortPath;

        this._updateSectionHealth(sectionEl, refs, agents);
    }

    // Health rollup: errored/working/idle counts for the section's agents.
    _updateSectionHealth(sectionEl, refs, agents) {
        const counts = { errored: 0, working: 0, idle: 0 };
        for (const agent of agents) {
            const status = normalizeStatus(agent.status);
            if (status === 'errored') counts.errored++;
            else if (status === 'rate_limited' || status === 'waiting_on_user') counts.errored++;
            else if (status === 'working') counts.working++;
            else counts.idle++;
        }
        const stats = [
            [refs.healthErrored, counts.errored, 'errored'],
            [refs.healthWorking, counts.working, 'working'],
            [refs.healthIdle, counts.idle, 'idle'],
        ];
        for (const [el, count, label] of stats) {
            if (!el) continue;
            if (count > 0) {
                this._setText(el, count);
                el.title = `${count} ${label}`;
                this._setStyle(el, 'display', '');
            } else {
                this._setStyle(el, 'display', 'none');
            }
        }

        // #44 — composite health pulse-bar: 2px segments sized by status counts,
        // one-shot red edge-flash when a section gains an errored card.
        const total = counts.errored + counts.working + counts.idle;
        const pct = (n) => (total > 0 ? `${(n / total) * 100}%` : '0%');
        this._setStyle(refs.healthBarErrored, 'flexBasis', pct(counts.errored));
        this._setStyle(refs.healthBarWorking, 'flexBasis', pct(counts.working));
        this._setStyle(refs.healthBarIdle, 'flexBasis', pct(counts.idle));

        if (counts.errored > (sectionEl._erroredCount || 0)) {
            this._flashSectionErrored(sectionEl);
        }
        sectionEl._erroredCount = counts.errored;
    }

    _flashSectionErrored(sectionEl) {
        sectionEl.classList.remove('dashboard__section--errored-flash');
        void sectionEl.offsetWidth;
        sectionEl.classList.add('dashboard__section--errored-flash');
        clearTimeout(sectionEl._erroredFlashTimer);
        sectionEl._erroredFlashTimer = setTimeout(() => {
            sectionEl.classList.remove('dashboard__section--errored-flash');
            sectionEl._erroredFlashTimer = null;
        }, 600);
    }

    _createCard(agent) {
        const card = document.createElement('div');
        card.className = `dash-card dash-card--${agent.status}`;
        card.dataset.agentId = agent.id;
        card.setAttribute('role', 'button');
        card.setAttribute('tabindex', '0');
        card.setAttribute('aria-label', `Select agent ${agent.name || agent.id}`);

        card.innerHTML = `
            <div class="dash-card__header">
                <span class="dash-card__building-emblem" aria-hidden="true" style="display: none"></span>
                <div class="dash-card__avatar"></div>
                <div class="dash-card__info">
                    <div class="dash-card__name"></div>
                    <div class="dash-card__meta">
                        <span class="dash-card__provider-badge"></span>
                        <span class="dash-card__model"></span>
                        <span class="dash-card__workflow-badge"></span>
                        <span class="dash-card__parent-chip" style="display: none"></span>
                        <span class="dash-card__team-badge" style="display: none"></span>
                        <span class="dash-card__role"></span>
                        <span class="dash-card__activity-age" style="display: none"></span>
                    </div>
                </div>
                <button type="button" class="dash-card__copy-id" title="Copy session ID" aria-label="Copy session ID">⧉</button>
                <span class="dash-card__stale-badge" style="display: none" title="Showing cached data; latest refresh did not complete">STALE</span>
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
                    <div class="dash-card__skeleton" aria-hidden="true">
                        <span class="dash-card__skeleton-line"></span>
                        <span class="dash-card__skeleton-line"></span>
                        <span class="dash-card__skeleton-line"></span>
                    </div>
                </div>
            </div>
            <div class="dash-card__usage" style="display: none">
                <span class="dash-card__usage-tokens"></span>
                <span class="dash-card__usage-cost"></span>
            </div>
        `;
        card.dataset.loading = 'true';

        // Avatar canvas
        const avatarContainer = card.querySelector('.dash-card__avatar');
        const avatarCanvas = new AvatarCanvas(agent);
        avatarContainer.appendChild(avatarCanvas.canvas);
        card._avatarCanvas = avatarCanvas;
        card._avatarSignature = '';

        // Copy session ID without triggering card selection
        const copyBtn = card.querySelector('.dash-card__copy-id');
        copyBtn.addEventListener('click', (event) => {
            event.stopPropagation();
            this._copyAgentId(card.dataset.agentId);
        });
        copyBtn.addEventListener('keydown', (event) => event.stopPropagation());

        const parentChip = card.querySelector('.dash-card__parent-chip');
        const selectParent = (event) => {
            event.stopPropagation();
            const parentId = parentChip.dataset.parentId;
            if (!parentId || parentChip.classList.contains('dash-card__parent-chip--muted')) return;
            const parent = this.world.agents.get(parentId);
            if (!parent) return;
            emitAgentSelected(parent);
            const parentCard = this.cards.get(parent.id);
            if (parentCard) {
                parentCard.scrollIntoView({ block: 'nearest', inline: 'nearest' });
                this._flashParentCard(parentCard);
            }
        };
        parentChip.addEventListener('click', selectParent);
        parentChip.addEventListener('keydown', (event) => {
            event.stopPropagation();
            if (event.key !== 'Enter' && event.key !== ' ') return;
            event.preventDefault();
            selectParent(event);
        });

        // Click or Enter/Space to select agent
        card.addEventListener('click', () => {
            const current = this.world.agents.get(card.dataset.agentId);
            emitAgentSelected(current);
        });
        card.addEventListener('keydown', (event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            event.preventDefault();
            const current = this.world.agents.get(card.dataset.agentId);
            emitAgentSelected(current);
        });

        card._elements = {
            name: card.querySelector('.dash-card__name'),
            model: card.querySelector('.dash-card__model'),
            workflowBadge: card.querySelector('.dash-card__workflow-badge'),
            parentChip: card.querySelector('.dash-card__parent-chip'),
            teamBadge: card.querySelector('.dash-card__team-badge'),
            role: card.querySelector('.dash-card__role'),
            activityAge: card.querySelector('.dash-card__activity-age'),
            providerBadge: card.querySelector('.dash-card__provider-badge'),
            status: card.querySelector('.dash-card__status'),
            statusLabel: card.querySelector('.dash-card__status-label'),
            staleBadge: card.querySelector('.dash-card__stale-badge'),
            currentTool: card.querySelector('.dash-card__current-tool'),
            toolIcon: card.querySelector('.dash-card__tool-icon'),
            toolName: card.querySelector('.dash-card__tool-name'),
            toolDetail: card.querySelector('.dash-card__tool-detail'),
            message: card.querySelector('.dash-card__message'),
            toolList: card.querySelector('.dash-card__tool-list'),
            usage: card.querySelector('.dash-card__usage'),
            usageTokens: card.querySelector('.dash-card__usage-tokens'),
            usageCost: card.querySelector('.dash-card__usage-cost'),
            buildingEmblem: card.querySelector('.dash-card__building-emblem'),
        };

        return card;
    }

    _updateCard(cardEl, agent) {
        const refs = cardEl._elements;
        const status = normalizeStatus(agent.status);
        const model = modelPresentation(agent);
        const provider = providerPresentation(agent.provider, model.identity);
        const statusInfo = statusPresentation(status, i18n);
        const building = buildingClassForAgent(agent);
        const signature = [
            building || '',
            agent.name || '',
            agent.model || '',
            agent.effort || '',
            agent.provider || '',
            agent.role || '',
            agent.workflowName || '',
            agent.parentSessionId || '',
            agent.teamName || '',
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
            cardEl.setAttribute('aria-label', `Select agent ${agent.name || agent.id}, ${statusInfo.label}`);

            this._setText(refs.name, agent.name);
            this._setText(refs.model, model.label);
            this._setStyle(refs.model, 'color', model.color);
            refs.model.title = model.title;

            // Workflow swarm members read as one unit via a shared workflow chip;
            // it stands in for the generic 'workflow-subagent' role text.
            if (agent.workflowName) {
                this._setText(refs.workflowBadge, `⚙ ${agent.workflowName}`);
                refs.workflowBadge.title = `Workflow: ${agent.workflowName}`;
                this._setStyle(refs.workflowBadge, 'display', '');
                this._setText(refs.role, '');
            } else {
                this._setStyle(refs.workflowBadge, 'display', 'none');
                this._setText(refs.role, agent.role || '');
            }

            if (agent.teamName) {
                const team = getTeamColor(agent.teamName);
                this._setText(refs.teamBadge, `⚑ ${shortTeamName(agent.teamName)}`);
                refs.teamBadge.title = `Team: ${agent.teamName}`;
                this._setStyle(refs.teamBadge, 'color', team.accent);
                this._setStyle(refs.teamBadge, 'borderColor', team.glow);
                this._setStyle(refs.teamBadge, 'background', team.panel);
                this._setStyle(refs.teamBadge, 'display', '');
            } else {
                this._setStyle(refs.teamBadge, 'display', 'none');
            }

            const badge = provider.badge;
            this._setText(refs.providerBadge, badge.label);
            this._setStyle(refs.providerBadge, 'color', badge.color);
            this._setStyle(refs.providerBadge, 'background', badge.bg);

            const nextStatusClass = `dash-card__status dash-card__status--${status}`;
            if (refs.status.className !== nextStatusClass) refs.status.className = nextStatusClass;
            this._setText(refs.statusLabel, statusInfo.label);

            const tool = currentToolPresentation(agent, i18n);
            refs.currentTool.classList.toggle('dash-card__current-tool--idle', tool.isIdle);
            this._setText(refs.toolIcon, tool.icon);
            this._setText(refs.toolName, tool.name);
            this._setText(refs.toolDetail, tool.detail);

            if (agent.lastMessage) {
                this._setText(refs.message, `"${agent.lastMessage}"`);
                this._setStyle(refs.message, 'display', '');
            } else {
                this._setStyle(refs.message, 'display', 'none');
            }

            // #30 — district identity: faint radial wash + emblem glyph echoing
            // the World building this agent works in (no motion).
            const buildingInfo = buildingPresentation(building);
            if (buildingInfo) {
                cardEl.dataset.building = buildingInfo.building;
                cardEl.style.setProperty('--cv-building', buildingInfo.accent);
                cardEl.style.setProperty('--cv-building-rgb', buildingInfo.accentRgb);
                if (refs.buildingEmblem) {
                    this._setText(refs.buildingEmblem, buildingInfo.emblem);
                    refs.buildingEmblem.title = `${buildingInfo.building.charAt(0).toUpperCase()}${buildingInfo.building.slice(1)} district`;
                    this._setStyle(refs.buildingEmblem, 'display', '');
                }
            } else {
                delete cardEl.dataset.building;
                cardEl.style.removeProperty('--cv-building');
                cardEl.style.removeProperty('--cv-building-rgb');
                if (refs.buildingEmblem) this._setStyle(refs.buildingEmblem, 'display', 'none');
            }
        }

        this._updateParentChip(cardEl, agent);
        this._updateActivityAge(cardEl, agent);

        const avatarSignature = `${agent.model || ''}|${agent.effort || ''}|${agent.provider || ''}`;
        if (cardEl._avatarCanvas && cardEl._avatarSignature !== avatarSignature) {
            cardEl._avatarSignature = avatarSignature;
            cardEl._avatarCanvas.agent = agent;
            this._scheduleAvatarDraw(cardEl);
        }

        // Render tool history
        const history = this.toolHistories.get(agent.id);
        if (history) {
            this._renderToolHistory(cardEl, agent.id, history);
        }

        // Render cost/token footer from the latest fetched detail
        this._renderUsageFooter(cardEl, this.usageFooters.get(agent.id));

        this._updateStaleBadge(cardEl, agent);
    }

    _updateParentChip(cardEl, agent) {
        const chip = cardEl._elements?.parentChip;
        if (!chip) return;
        const parentId = agent.parentSessionId || '';
        if (!parentId) {
            this._setStyle(chip, 'display', 'none');
            delete chip.dataset.parentId;
            chip.removeAttribute('role');
            chip.removeAttribute('tabindex');
            chip.classList.remove('dash-card__parent-chip--clickable', 'dash-card__parent-chip--muted');
            return;
        }

        const parent = this.world.agents.get(parentId);
        const label = parent?.name || 'ended';
        this._setText(chip, `parent: ${label}`);
        chip.dataset.parentId = parentId;
        chip.title = parent ? `Select parent ${parent.name || parent.id}` : 'Parent session ended';
        chip.classList.toggle('dash-card__parent-chip--clickable', !!parent);
        chip.classList.toggle('dash-card__parent-chip--muted', !parent);
        if (parent) {
            chip.setAttribute('role', 'button');
            chip.setAttribute('tabindex', '0');
        } else {
            chip.removeAttribute('role');
            chip.removeAttribute('tabindex');
        }
        this._setStyle(chip, 'display', '');
    }

    _updateActivityAge(cardEl, agent) {
        const chip = cardEl._elements?.activityAge;
        const ageMs = Number(agent.activityAgeMs);
        const isAged = Number.isFinite(ageMs) && ageMs > 15 * 60_000;
        cardEl.classList.toggle('dash-card--aged', isAged);
        if (!chip) return;

        const relative = formatRelative(Number(agent.lastSessionActivity) || 0);
        if (!relative) {
            this._setStyle(chip, 'display', 'none');
            return;
        }
        this._setText(chip, `last active ${relative}`);
        this._setStyle(chip, 'display', '');
    }

    _flashParentCard(cardEl) {
        cardEl.classList.remove('dash-card--parent-flash');
        void cardEl.offsetWidth;
        cardEl.classList.add('dash-card--parent-flash');
        clearTimeout(cardEl._parentFlashTimer);
        cardEl._parentFlashTimer = setTimeout(() => {
            cardEl.classList.remove('dash-card--parent-flash');
            cardEl._parentFlashTimer = null;
        }, 900);
    }

    // Coalesce avatar redraws into one requestAnimationFrame per render cycle
    // so detail polling never redraws avatar canvases synchronously.
    _scheduleAvatarDraw(cardEl) {
        this._pendingAvatarDraws.add(cardEl);
        if (this._avatarDrawFrame !== null) return;
        this._avatarDrawFrame = requestAnimationFrame(() => {
            this._avatarDrawFrame = null;
            const pending = this._pendingAvatarDraws;
            this._pendingAvatarDraws = new Set();
            for (const el of pending) {
                if (el.isConnected) el._avatarCanvas?.draw();
            }
        });
    }

    _usageFooterFor(agent, data) {
        const raw = data.tokenUsage || data.tokens || data.usage;
        if (!raw) return null;
        const usage = TokenUsage.normalize(raw);
        const totalTokens = TokenUsage.totalTokens(usage);
        if (totalTokens <= 0) return null;
        const cost = TokenUsage.estimateCost(usage, agent.model, agent.provider);
        return {
            tokens: `${formatTokens(totalTokens)} tokens`,
            cost: formatCost(cost),
        };
    }

    _renderUsageFooter(cardEl, footer) {
        const refs = cardEl._elements;
        if (!refs?.usage) return;
        if (!footer) {
            this._setStyle(refs.usage, 'display', 'none');
            return;
        }
        this._setText(refs.usageTokens, footer.tokens);
        this._setText(refs.usageCost, footer.cost);
        this._setStyle(refs.usage, 'display', '');
    }

    _renderDetailError(cardEl, agentId) {
        delete cardEl.dataset.loading;
        if (this.toolHistoryRenderSignatures.get(agentId) === '__error__') return;
        this.toolHistoryRenderSignatures.set(agentId, '__error__');
        const errorEl = document.createElement('div');
        errorEl.className = 'dash-card__tool-error';
        errorEl.textContent = '⚠ Session details unavailable';
        replaceChildren(cardEl._elements.toolList, [errorEl]);
    }

    _updateStaleBadge(cardEl, agent) {
        const badge = cardEl._elements?.staleBadge;
        if (!badge) return;
        const hasDetail = this.toolHistories.has(agent.id) || this.usageFooters.has(agent.id);
        const cacheState = hasDetail ? sessionDetailsService.detailCacheState(agent) : null;
        const isStale = hasDetail && !cacheState?.isFresh;
        this._setStyle(badge, 'display', isStale ? '' : 'none');
    }

    _renderToolHistory(cardEl, agentId, tools) {
        delete cardEl.dataset.loading;
        const listEl = cardEl._elements.toolList;
        const limited = (tools || []).slice(-DASHBOARD_TOOL_HISTORY_LIMIT);

        const signature = toolHistorySignature(limited, {
            limit: DASHBOARD_TOOL_HISTORY_LIMIT,
            detailLength: 60,
        });
        const exitSignature = limited
            .map(row => (Number.isFinite(Number(row?.toolExitCode)) ? row.toolExitCode : ''))
            .join(',');
        const historySignature = `${signature}|${exitSignature}`;

        if (this.toolHistoryRenderSignatures.get(agentId) === historySignature) return;
        this.toolHistoryRenderSignatures.set(agentId, historySignature);

        const nodes = toolHistoryNodes(limited, {
            limit: DASHBOARD_TOOL_HISTORY_LIMIT,
            detailLength: 60,
            emptyText: i18n.t('noToolUsage'),
            emptyClass: 'dash-card__loading',
            itemClass: 'dash-card__tool-item',
            iconClass: 'dash-card__tool-item-icon',
            nameClass: 'dash-card__tool-item-name',
            detailClass: 'dash-card__tool-item-detail',
            includeCategoryClasses: true,
        });
        if (limited.length) {
            const newestFirst = [...limited].reverse();
            nodes.forEach((node, index) => {
                const chip = this._toolExitChip(newestFirst[index]);
                if (chip) node.appendChild(chip);
            });
        }
        replaceChildren(listEl, nodes);
    }

    _toolExitChip(entry) {
        const exitCode = Number(entry?.toolExitCode);
        if (!Number.isFinite(exitCode) || exitCode === 0) return null;
        const chip = document.createElement('span');
        chip.className = 'dash-card__tool-item-exit';
        chip.textContent = `exit ${exitCode}`;
        chip.title = entry?.toolStderr
            ? truncateText(entry.toolStderr, 200)
            : `Exit code ${exitCode}`;
        return chip;
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
        if (!this.active || this._isFetchingDetails || document.hidden) return;
        this._isFetchingDetails = true;
        const generation = this._detailFetchGeneration;

        const agents = Array.from(this.world.agents.values());
        try {
            const candidates = this._detailCandidates(agents);
            const detailsByAgentId = await sessionDetailsService.fetchSessionDetailsBatch(candidates);
            if (!this.active || generation !== this._detailFetchGeneration) return;
            for (const agent of candidates) {
                const data = detailsByAgentId.get(agent.id);
                const cardEl = this.cards.get(agent.id);
                if (!data) {
                    // Fetch failed (or detail unavailable) with nothing cached:
                    // show an explicit error instead of an eternal spinner.
                    if (cardEl && !this.toolHistories.has(agent.id)) this._renderDetailError(cardEl, agent.id);
                    if (cardEl) this._updateStaleBadge(cardEl, agent);
                    continue;
                }
                const footer = this._usageFooterFor(agent, data);
                if (footer) this.usageFooters.set(agent.id, footer);
                if (cardEl && footer) this._renderUsageFooter(cardEl, footer);
                const toolHistory = data.toolHistory || [];
                this.toolHistories.set(agent.id, toolHistory.slice(-DASHBOARD_TOOL_HISTORY_LIMIT));
                if (cardEl) {
                    this._renderToolHistory(cardEl, agent.id, toolHistory);
                    this._updateStaleBadge(cardEl, agent);
                }
            }
        } finally {
            this._isFetchingDetails = false;
        }
    }

    _clearAllCardsAndSections() {
        for (const id of [...this.cards.keys()]) this._removeCard(id, { removeEmptySection: false });
        this.toolHistories.clear();
        this.usageFooters.clear();
        this.toolHistoryRenderSignatures.clear();
        this._cardRenderSignatures.clear();
        this._visibleAgentIds.clear();

        for (const [, sectionEl] of this._sectionEls) {
            if (sectionEl._erroredFlashTimer) clearTimeout(sectionEl._erroredFlashTimer);
            sectionEl.remove();
        }
        this._sectionEls.clear();
    }

    _removeCard(agentId, { removeEmptySection = true } = {}) {
        const cardEl = this.cards.get(agentId);
        const projectPath = cardEl?._projectPath;
        if (cardEl) {
            this._observer?.unobserve?.(cardEl);
            this._pendingAvatarDraws.delete(cardEl);
            if (cardEl._parentFlashTimer) clearTimeout(cardEl._parentFlashTimer);
            cardEl._avatarCanvas?.destroy?.();
            cardEl._avatarCanvas = null;
            cardEl.remove();
            this.cards.delete(agentId);
        }
        this.toolHistories.delete(agentId);
        this.usageFooters.delete(agentId);
        this.toolHistoryRenderSignatures.delete(agentId);
        this._cardRenderSignatures.delete(agentId);
        this._visibleAgentIds.delete(agentId);

        if (!removeEmptySection || !projectPath) return;
        const sectionEl = this._sectionEls.get(projectPath);
        const grid = sectionEl?._sectionRefs?.grid;
        if (sectionEl && (!grid || !grid.querySelector('.dash-card'))) {
            if (sectionEl._erroredFlashTimer) clearTimeout(sectionEl._erroredFlashTimer);
            sectionEl.remove();
            this._sectionEls.delete(projectPath);
        }
    }

    _detailCandidates(agents) {
        if (this._visibilityLayoutDirty) this._syncVisibleAgentIdsFromLayout();
        const selected = [];
        const active = [];
        const visible = [];
        for (const agent of agents) {
            if (agent.id === this._selectedAgentId) selected.push(agent);
            else if (['working', 'waiting', 'errored', 'rate_limited', 'waiting_on_user'].includes(normalizeStatus(agent.status))) active.push(agent);
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
        if (!this._observer || !this.active) return false;
        if (this.cards.size === 0) {
            this._visibilityLayoutDirty = false;
            return true;
        }
        const root = document.getElementById('dashboardMode') || this.gridEl;
        const rootRect = root?.getBoundingClientRect?.();
        if (!rootRect || rootRect.width <= 0 || rootRect.height <= 0) return false;

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
        this._visibilityLayoutDirty = false;
        return true;
    }

    async _copyAgentId(agentId) {
        if (!agentId || this._destroyed) return;
        try {
            await navigator.clipboard.writeText(agentId);
            if (this._destroyed) return;
            this.toast?.show('Session ID copied to clipboard', 'success');
        } catch {
            if (this._destroyed) return;
            this.toast?.show('Could not copy session ID', 'warning');
        }
    }

    // Actionable hints appended below the static empty-state copy in index.html.
    _appendEmptyHints() {
        if (!this.emptyEl || this.emptyEl.querySelector('.dashboard__empty-hints')) return;
        const hints = document.createElement('div');
        hints.className = 'dashboard__empty-hints';
        const lines = [
            '▸ Run a CLI agent (claude, codex, gemini, opencode, kimi) in any terminal',
            '▸ Or press WORLD in the top bar to watch the village view',
        ];
        for (const text of lines) {
            const el = document.createElement('span');
            el.className = 'dashboard__empty-hint';
            el.textContent = text;
            hints.appendChild(el);
        }
        this.emptyEl.appendChild(hints);
    }

    _setText(el, value) {
        const next = value == null ? '' : String(value);
        if (el && el.textContent !== next) el.textContent = next;
    }

    _setStyle(el, prop, value) {
        if (el && el.style[prop] !== value) el.style[prop] = value;
    }

    destroy() {
        if (this._destroyed) return;
        this._destroyed = true;
        this.active = false;
        this._stopDetailFetching();
        if (this._avatarDrawFrame !== null) {
            cancelAnimationFrame(this._avatarDrawFrame);
            this._avatarDrawFrame = null;
        }
        this._pendingAvatarDraws.clear();
        this._clearAllCardsAndSections();
        this._observer?.disconnect?.();
        this.selection?.destroy?.();
        document.removeEventListener('visibilitychange', this._onVisibilityChange);
        eventBus.off('agent:added', this._onAgentAdded);
        eventBus.off('agent:updated', this._onAgentUpdated);
        eventBus.off('agent:removed', this._onAgentRemoved);
        eventBus.off('mode:changed', this._onModeChanged);
    }
}
