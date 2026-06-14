import { eventBus, BUILDING_EVENTS } from '../../domain/events/DomainEvent.js';
import { TokenUsage } from '../../domain/value-objects/TokenUsage.js';
import { AgentBiography } from '../../domain/value-objects/AgentBiography.js';
import { sessionDetailsService } from './SessionDetailsService.js';
import { SESSION_DETAIL_PANEL_REFRESH_INTERVAL } from '../../config/constants.js';
import { el, replaceChildren } from './DomSafe.js';
import { formatCost, formatRelative, formatTokens, hashRows, truncateText } from './Formatters.js';
import { emitAgentDeselected, emitAgentSelected } from './AgentSelection.js';
import {
    currentToolPresentation,
    modelPresentation,
    statusPresentation,
    toolHistoryNodes,
    toolHistorySignature,
} from './AgentPresentation.js';
import { normalizeGitEvent } from './GitEventIdentity.js';
import { contextWindowLimitForModel } from './ModelVisualIdentity.js';

const PANEL_TOOL_LIMIT = 30;
const PANEL_MESSAGE_LIMIT = 12;
const PANEL_INTER_AGENT_MESSAGE_LIMIT = 5;
const PANEL_GIT_EVENT_LIMIT = 6;
const BUILDING_OCCUPANT_REFRESH_INTERVAL = 5000;
const JOURNEY_BREADCRUMB_LIMIT = 5;
const PIN_COMPARE_LIMIT = 2;
const PINNED_AGENTS_STORAGE_KEY = 'claudeville.pinnedAgents';

const BEHAVIOR_STATE_LABELS = Object.freeze({
    blocked: 'Blocked',
    cooldown: 'Cooling down',
    performing: 'On site',
    roaming: 'Roaming',
    traveling: 'Traveling',
    wandering: 'Wandering',
});

const BEHAVIOR_PHASE_LABELS = Object.freeze({
    coordinating: 'Coordinating',
    editing: 'Editing',
    git: 'Git work',
    'quota/resource': 'Quota check',
    reading: 'Reading',
    researching: 'Researching',
    testing: 'Testing',
    waiting: 'Waiting',
});

const AGENT_GOAL_LABELS = Object.freeze({
    'assist-parent': 'Assist parent',
    'complete-task': 'Complete task',
    'monitor-quota': 'Monitor quota',
    'recover-error': 'Recover error',
});

const PUSH_STATUS_LABELS = Object.freeze({
    cancelled: 'Push cancelled',
    canceled: 'Push cancelled',
    failed: 'Push failed',
    rejected: 'Push rejected',
});

const REASON_LABELS = Object.freeze({
    'quota/resource': 'Quota check',
    'quota-resource': 'Quota check',
});

export class ActivityPanel {
    constructor({ world = null, renderer = null, harborTraffic = null, biographyService = null } = {}) {
        const getterFor = (value) => (typeof value === 'function' ? value : () => value);
        this.panelEl = document.getElementById('activityPanel');
        this.closeBtn = document.getElementById('panelClose');
        this._dependencies = {
            world: getterFor(world),
            renderer: getterFor(renderer),
            harborTraffic: getterFor(harborTraffic),
            biographyService: getterFor(biographyService),
        };
        this.currentAgent = null;
        this._mode = null;
        this._selectedBuilding = null;
        this._latestUsage = null;
        this._pollTimer = null;
        this._buildingPollTimer = null;
        this.dom = {
            panelAgentName: document.getElementById('panelAgentName'),
            panelAgentStatus: document.getElementById('panelAgentStatus'),
            panelModel: document.getElementById('panelModel'),
            panelProvider: document.getElementById('panelProvider'),
            panelRole: document.getElementById('panelRole'),
            panelLevel: document.getElementById('panelLevel'),
            panelTeam: document.getElementById('panelTeam'),
            panelMood: document.getElementById('panelMood'),
            panelLastActive: document.getElementById('panelLastActive'),
            panelModeRow: document.getElementById('panelModeRow'),
            panelMode: document.getElementById('panelMode'),
            panelCurrentTool: document.getElementById('panelCurrentTool'),
            panelToolHistory: document.getElementById('panelToolHistory'),
            panelMessages: document.getElementById('panelMessages'),
            panelContextSize: document.getElementById('panelContextSize'),
            panelContextBar: document.getElementById('panelContextBar'),
            panelInputTokens: document.getElementById('panelInputTokens'),
            panelOutputTokens: document.getElementById('panelOutputTokens'),
            panelCacheRead: document.getElementById('panelCacheRead'),
            panelCacheCreate: document.getElementById('panelCacheCreate'),
            panelCacheHit: document.getElementById('panelCacheHit'),
            panelTurnCount: document.getElementById('panelTurnCount'),
            panelEstCost: document.getElementById('panelEstCost'),
        };
        this._toolEls = {
            icon: this.dom.panelCurrentTool.querySelector('.activity-panel__tool-icon'),
            name: this.dom.panelCurrentTool.querySelector('.activity-panel__tool-name'),
            input: this.dom.panelCurrentTool.querySelector('.activity-panel__tool-input'),
        };
        this._journeySectionEl = null;
        this._journeyBodyEl = null;
        this._journeyWhyEl = null;
        this._journeyDetailsEl = null;
        this._journeyDetailsBodyEl = null;
        this._harborLogSectionEl = null;
        this._harborLogBodyEl = null;
        this._chronicleSectionEl = null;
        this._chronicleBodyEl = null;
        this._chronicleFetchSeq = 0;
        this._messageEdgesSectionEl = null;
        this._messageEdgesBodyEl = null;
        this._pinStripEl = null;
        this._pinToggleBtn = null;
        this._pinFetchSeq = 0;
        this._pinned = new Set(this._loadPinnedAgentIds());
        this._pinnedDetails = new Map();
        this._agentSections = [];
        this._ensurePinCompare();
        this._ensureJourneySection();
        this._ensureHarborLogSection();
        this._ensureChronicleSection();
        this._ensureMessageEdgesSection();
        // Sections that belong to agent mode and must be hidden when a building is selected.
        for (const node of this.panelEl?.querySelectorAll('.activity-panel__meta, .activity-panel__section') || []) {
            this._registerAgentSection(node);
        }
        // Building-mode content container is created on demand and inserted after the header.
        this._buildingContentEl = null;
        this._renderSignatures = this._emptyRenderSignatures();

        this._bind();
        this._renderPinCompare();
    }

    _bind() {
        this._onCloseClick = () => this.hide();
        this._onPinToggleClick = () => {
            if (this._mode === 'agent' && this.currentAgent) {
                this._togglePinnedAgent(this.currentAgent);
            }
        };
        this._onAgentSelected = (agent) => {
            if (agent) this.show(agent);
        };
        this._onAgentUpdated = (agent) => {
            if (agent?.id && this._pinned.has(agent.id)) {
                this._renderPinCompare();
                this._fetchPinnedDetails();
            }
            if (this._mode === 'agent' && this.currentAgent && agent.id === this.currentAgent.id) {
                this.currentAgent = agent;
                this._updateInfo(agent);
                this._updateCurrentTool(agent);
                this._updateJourney(agent);
                this._updateHarborLog(agent);
                this._updateMessageEdges(agent);
                this._fetchAndRenderChronicle(agent);
                this._updatePinToggle(agent);
            }
        };
        this._onAgentRemoved = (agent) => {
            sessionDetailsService.deleteForAgent(agent);
            if (this._mode === 'agent' && this.currentAgent && agent.id === this.currentAgent.id) {
                this.hide();
            }
            this._renderPinCompare();
        };
        this._onBuildingSelected = (building) => {
            if (building) this.showBuilding(building);
        };
        this._onBuildingDeselected = () => {
            if (this._mode === 'building') this.hide();
        };
        this._onUsageUpdated = (usage) => {
            this._latestUsage = usage || null;
            if (this._mode === 'building') this._renderBuildingState();
        };
        this._onMoodChanged = ({ agent } = {}) => {
            if (agent?.id && this._pinned.has(agent.id)) this._renderPinCompare();
            if (this._mode === 'agent' && this.currentAgent && agent?.id === this.currentAgent.id) {
                this.currentAgent = agent;
                this._updateInfo(agent);
            }
        };
        this._onBiographyUpdated = ({ identityKey, biography } = {}) => {
            if (this._mode !== 'agent' || !this.currentAgent) return;
            if (identityKey !== this._biographyIdentityKey(this.currentAgent)) return;
            this._renderChronicleBody(biography);
        };

        this.closeBtn.addEventListener('click', this._onCloseClick);
        this._pinToggleBtn?.addEventListener('click', this._onPinToggleClick);
        eventBus.on('agent:selected', this._onAgentSelected);
        eventBus.on('agent:updated', this._onAgentUpdated);
        eventBus.on('agent:removed', this._onAgentRemoved);
        eventBus.on(BUILDING_EVENTS.SELECTED, this._onBuildingSelected);
        eventBus.on(BUILDING_EVENTS.DESELECTED, this._onBuildingDeselected);
        eventBus.on('usage:updated', this._onUsageUpdated);
        eventBus.on('mood:changed', this._onMoodChanged);
        eventBus.on('biography:updated', this._onBiographyUpdated);
    }

    _emptyRenderSignatures() {
        return {
            journey: '',
            toolHistory: '',
            messages: '',
            tokenUsage: '',
            harborLog: '',
            chronicle: '',
            messageEdges: '',
            pins: '',
            buildingOccupants: '',
            buildingState: '',
        };
    }

    _registerAgentSection(node) {
        if (!node || this._agentSections.includes(node)) return;
        this._agentSections.push(node);
    }

    _loadPinnedAgentIds() {
        if (typeof localStorage === 'undefined') return [];
        try {
            const parsed = JSON.parse(localStorage.getItem(PINNED_AGENTS_STORAGE_KEY) || '[]');
            if (!Array.isArray(parsed)) return [];
            return parsed
                .map(id => String(id || '').trim())
                .filter(Boolean)
                .slice(0, PIN_COMPARE_LIMIT);
        } catch {
            return [];
        }
    }

    _persistPinnedAgentIds() {
        if (typeof localStorage === 'undefined') return;
        try {
            localStorage.setItem(PINNED_AGENTS_STORAGE_KEY, JSON.stringify([...this._pinned].slice(0, PIN_COMPARE_LIMIT)));
        } catch { /* ignore */ }
    }

    _ensurePinCompare() {
        if (this._pinStripEl && this._pinToggleBtn) return;
        const header = this.panelEl?.querySelector('.activity-panel__header');
        if (!this._pinStripEl) {
            const strip = el('div', {
                className: 'activity-panel__pin-strip',
                style: { display: 'none' },
            });
            if (header) this.panelEl.insertBefore(strip, header);
            else this.panelEl?.appendChild(strip);
            this._pinStripEl = strip;
        }
        if (!this._pinToggleBtn && this.closeBtn?.parentNode) {
            const button = el('button', {
                className: 'activity-panel__pin-toggle',
                text: 'Pin',
                title: 'Pin agent for comparison',
                style: { display: 'none' },
            });
            button.type = 'button';
            button.setAttribute('aria-pressed', 'false');
            this.closeBtn.parentNode.insertBefore(button, this.closeBtn);
            this._pinToggleBtn = button;
        }
    }

    _togglePinnedAgent(agent) {
        if (!agent?.id) return;
        if (this._pinned.has(agent.id)) {
            this._pinned.delete(agent.id);
        } else {
            while (this._pinned.size >= PIN_COMPARE_LIMIT) {
                const [oldest] = this._pinned;
                this._pinned.delete(oldest);
                this._pinnedDetails.delete(oldest);
            }
            this._pinned.add(agent.id);
        }
        this._persistPinnedAgentIds();
        this._renderPinCompare();
        this._updatePinToggle(agent);
        this._fetchPinnedDetails();
    }

    _updatePinToggle(agent) {
        if (!this._pinToggleBtn) return;
        if (this._mode !== 'agent' || !agent?.id) {
            this._pinToggleBtn.style.display = 'none';
            this._pinToggleBtn.setAttribute('aria-pressed', 'false');
            return;
        }
        const pinned = this._pinned.has(agent.id);
        this._pinToggleBtn.style.display = '';
        this._pinToggleBtn.textContent = pinned ? 'Pinned' : 'Pin';
        this._pinToggleBtn.classList.toggle('activity-panel__pin-toggle--active', pinned);
        this._pinToggleBtn.setAttribute('aria-pressed', pinned ? 'true' : 'false');
        this._pinToggleBtn.title = pinned
            ? 'Remove agent from comparison'
            : 'Pin agent for comparison';
    }

    async _fetchPinnedDetails() {
        const pinnedAgents = [...this._pinned]
            .map(id => this._getWorld()?.agents?.get?.(id))
            .filter(Boolean);
        if (!pinnedAgents.length) {
            this._renderPinCompare();
            return;
        }
        const seq = ++this._pinFetchSeq;
        try {
            const details = await sessionDetailsService.fetchSessionDetailsBatch(pinnedAgents);
            if (seq !== this._pinFetchSeq) return;
            for (const [agentId, detail] of details) {
                if (this._pinned.has(agentId) && detail) this._pinnedDetails.set(agentId, detail);
            }
            this._renderPinCompare();
        } catch {
            this._renderPinCompare();
        }
    }

    _renderPinCompare() {
        if (!this._pinStripEl) return;
        const ids = [...this._pinned].slice(0, PIN_COMPARE_LIMIT);
        if (!ids.length) {
            this._pinStripEl.style.display = 'none';
            replaceChildren(this._pinStripEl, []);
            this._renderSignatures.pins = '';
            return;
        }

        const world = this._getWorld();
        const rows = ids.map(id => {
            const agent = world?.agents?.get?.(id) || null;
            const detail = this._pinnedDetails.get(id) || null;
            const tool = currentToolPresentation(agent);
            const status = agent ? statusPresentation(agent.status) : null;
            const tokenUsage = this._tokenUsageForPin(agent, detail);
            const maxContext = tokenUsage.contextWindowMax || contextWindowLimitForModel(agent?.model, agent?.provider);
            const contextPct = maxContext ? Math.min(100, (tokenUsage.contextWindow / maxContext) * 100) : 0;
            const cost = agent
                ? TokenUsage.estimateCost(tokenUsage, agent.model, agent.provider)
                : 0;
            return {
                id,
                agent,
                status,
                tool,
                contextPct,
                cost,
            };
        });

        const signature = hashRows(rows, [
            row => row.id,
            row => row.agent?.name || '',
            row => row.agent?.status || '',
            row => row.tool?.icon || '',
            row => row.tool?.name || '',
            row => Math.round(row.contextPct),
            row => row.cost.toFixed(6),
        ]);
        this._pinStripEl.style.display = '';
        if (signature === this._renderSignatures.pins) return;
        this._renderSignatures.pins = signature;
        replaceChildren(this._pinStripEl, rows.map(row => this._pinCell(row)));
    }

    _tokenUsageForPin(agent, detail) {
        return TokenUsage.normalize(
            detail?.tokenUsage
            || detail?.tokens
            || detail?.usage
            || agent?.tokens
            || null
        );
    }

    _pinCell(row) {
        if (!row.agent) {
            return el('div', {
                className: ['activity-panel__pin-cell', 'activity-panel__pin-cell--missing'],
                title: 'Pinned agent is not loaded',
            }, [
                el('span', { className: 'activity-panel__pin-dot' }),
                el('span', { className: 'activity-panel__pin-name', text: '-' }),
                el('span', { className: 'activity-panel__pin-tool', text: '-' }),
            ]);
        }
        const name = truncateText(row.agent.displayName || row.agent.name || row.id, 8);
        const pct = Math.max(0, Math.min(100, row.contextPct));
        const statusColor = row.status?.color || '#8b8b9e';
        return el('div', {
            className: 'activity-panel__pin-cell',
            title: row.agent.name || row.id,
        }, [
            el('span', {
                className: 'activity-panel__pin-dot',
                style: { background: statusColor, boxShadow: `0 0 5px ${statusColor}` },
            }),
            el('span', { className: 'activity-panel__pin-name', text: name }),
            el('span', { className: 'activity-panel__pin-tool', text: row.tool?.icon || '-' }),
            el('span', { className: 'activity-panel__pin-cost', text: formatCost(row.cost) }),
            el('span', { className: 'activity-panel__pin-context' }, [
                el('span', {
                    className: 'activity-panel__pin-context-fill',
                    style: { width: `${pct}%` },
                }),
            ]),
        ]);
    }

    show(agent) {
        // Agent selection takes over the panel: tear down any building view first.
        if (this._mode === 'building') {
            this._teardownBuildingView();
        }
        this._mode = 'agent';
        this.currentAgent = agent;
        this._renderSignatures = this._emptyRenderSignatures();
        this._showAgentSections();
        this.panelEl.style.display = '';
        document.body.classList.add('cv-panel-open');
        this._updateInfo(agent);
        this._updateCurrentTool(agent);
        this._updateJourney(agent);
        this._updateHarborLog(agent);
        this._updateMessageEdges(agent);
        this._fetchAndRenderChronicle(agent);
        this._updatePinToggle(agent);
        this._renderPinCompare();
        this._fetchPinnedDetails();
        this._startPolling();
    }

    showBuilding(building) {
        // Building selection overrides agent selection. Close any agent state first.
        if (this._mode === 'agent') {
            this._stopPolling();
            this.currentAgent = null;
            // Notify renderer/sidebar/dashboard so highlight clears.
            emitAgentDeselected();
        }
        this._mode = 'building';
        this._selectedBuilding = building;
        this._renderSignatures.buildingOccupants = '';
        this._renderSignatures.buildingState = '';
        this._hideAgentSections();
        this._updatePinToggle(null);
        this._renderPinCompare();
        this._ensureBuildingContentEl();
        this.panelEl.style.display = '';
        document.body.classList.add('cv-panel-open');
        this._renderBuildingView();
        this._startBuildingPolling();
    }

    hide() {
        const wasAgent = this._mode === 'agent';
        const wasBuilding = this._mode === 'building';
        this.panelEl.style.display = 'none';
        document.body.classList.remove('cv-panel-open');
        this.currentAgent = null;
        this._renderSignatures = this._emptyRenderSignatures();
        this._updatePinToggle(null);
        this._stopPolling();
        this._stopBuildingPolling();
        if (wasBuilding) this._teardownBuildingView();
        this._mode = null;
        if (wasAgent) emitAgentDeselected();
    }

    _updateInfo(agent) {
        const statusInfo = statusPresentation(agent.status);
        this.dom.panelAgentName.textContent = agent.name;
        const statusEl = this.dom.panelAgentStatus;
        statusEl.textContent = statusInfo.label.toUpperCase();
        statusEl.style.color = statusInfo.color;

        const model = modelPresentation(agent);
        this.dom.panelModel.textContent = model.label;
        this.dom.panelModel.style.color = model.color;
        this.dom.panelModel.title = model.title;
        this.dom.panelProvider.textContent = agent.provider || 'claude';
        this.dom.panelRole.textContent = agent.role || 'general';
        this.dom.panelLevel.textContent = this._formatAgentLevel(model.identity);
        this.dom.panelLevel.style.color = model.identity.accent?.[1] || model.identity.accent?.[0] || '';
        this.dom.panelTeam.textContent = agent.teamName || '-';
        this.dom.panelMood.textContent = this._formatMood(agent.mood);
        this.dom.panelLastActive.textContent = this._formatLastActive(agent);
        const modeLabel = this._formatPermissionMode(agent.permissionMode);
        if (modeLabel) {
            this.dom.panelModeRow.style.display = '';
            this.dom.panelMode.textContent = modeLabel;
            this.dom.panelMode.className = [
                'activity-panel__value',
                'activity-panel__mode-chip',
                `activity-panel__mode-chip--${modeLabel.toLowerCase()}`,
            ].join(' ');
        } else {
            this.dom.panelModeRow.style.display = 'none';
            this.dom.panelMode.textContent = '';
            this.dom.panelMode.className = 'activity-panel__value';
        }
    }

    _formatAgentLevel(identity) {
        const tier = identity?.effortTier;
        if (!tier || tier === 'none') return '-';
        return {
            low: 'Low',
            medium: 'Medium',
            high: 'High',
            xhigh: 'Extra High',
            max: 'Max',
        }[tier] || tier;
    }

    _formatMood(mood) {
        const type = String(mood?.type || '').trim();
        if (!type || type === 'neutral') return '-';
        return this._titleize(type);
    }

    _formatLastActive(agent) {
        const age = Number(agent?.activityAgeMs);
        const ts = Number.isFinite(age)
            ? Date.now() - Math.max(0, age)
            : Number(agent?.lastSessionActivity || 0);
        return formatRelative(ts) || '-';
    }

    _formatPermissionMode(mode) {
        const text = String(mode || '').trim();
        if (!text) return '';
        return text.toLowerCase().includes('plan') ? 'PLAN' : 'ACT';
    }

    _updateCurrentTool(agent) {
        const container = this.dom.panelCurrentTool;
        const iconEl = this._toolEls.icon;
        const nameEl = this._toolEls.name;
        const inputEl = this._toolEls.input;
        const tool = currentToolPresentation(agent);

        container.classList.toggle('activity-panel__current-tool--idle', tool.isIdle);
        iconEl.textContent = tool.icon;
        nameEl.textContent = tool.name;
        inputEl.textContent = tool.detail;
    }

    // ─── Live polling ────────────────────────────────

    _startPolling() {
        this._stopPolling();
        this._fetchDetail();
        this._fetchPinnedDetails();
        this._pollTimer = setInterval(() => {
            this._fetchDetail();
            this._fetchPinnedDetails();
        }, SESSION_DETAIL_PANEL_REFRESH_INTERVAL);
    }

    _stopPolling() {
        if (this._pollTimer) {
            clearInterval(this._pollTimer);
            this._pollTimer = null;
        }
    }

    _startBuildingPolling() {
        this._stopBuildingPolling();
        this._buildingPollTimer = setInterval(() => {
            if (this._mode !== 'building') return;
            this._renderBuildingOccupants();
            this._renderBuildingState();
            this._fetchPinnedDetails();
        }, BUILDING_OCCUPANT_REFRESH_INTERVAL);
    }

    _stopBuildingPolling() {
        if (this._buildingPollTimer) {
            clearInterval(this._buildingPollTimer);
            this._buildingPollTimer = null;
        }
    }

    async _fetchDetail() {
        if (!this.currentAgent) return;
        const agent = this.currentAgent;
        this._updateJourney(agent);
        this._updateHarborLog(agent);
        this._updateMessageEdges(agent);
        const data = await sessionDetailsService.fetchSessionDetail(agent);
        if (!data || !this.currentAgent || this.currentAgent.id !== agent.id) return;
        this._renderToolHistory(data.toolHistory || []);
        this._renderMessages(data.messages || []);
        this._renderTokenUsage(data.tokenUsage || data.tokens || data.usage);
    }

    // ─── Rendering ─────────────────────────────────────

    _renderToolHistory(tools) {
        const limited = (tools || []).slice(-PANEL_TOOL_LIMIT);
        const baseSignature = toolHistorySignature(limited, {
            limit: PANEL_TOOL_LIMIT,
            detailLength: 45,
        });
        // Exit codes can arrive after the tool row itself (Codex completion
        // events), so fold them into the signature to force a re-render.
        const exitSignature = limited
            .map(row => (Number.isFinite(Number(row?.toolExitCode)) ? row.toolExitCode : ''))
            .join(',');
        const signature = `${baseSignature}|${exitSignature}`;
        if (signature === this._renderSignatures.toolHistory) return;
        this._renderSignatures.toolHistory = signature;

        const container = this.dom.panelToolHistory;
        const nodes = toolHistoryNodes(limited, {
            limit: PANEL_TOOL_LIMIT,
            detailLength: 45,
            emptyText: 'No tool usage',
            emptyClass: 'activity-panel__empty',
            itemClass: 'activity-panel__tool-item',
            iconClass: 'activity-panel__tool-item-icon',
            nameClass: 'activity-panel__tool-item-name',
            detailClass: 'activity-panel__tool-item-detail',
        });
        if (limited.length) {
            // Nodes mirror `limited` in reverse order (newest first).
            const reversed = [...limited].reverse();
            nodes.forEach((node, index) => {
                const chip = this._toolExitChip(reversed[index]);
                if (chip) node.appendChild(chip);
            });
        }
        replaceChildren(container, nodes);
    }

    _toolExitChip(entry) {
        const exitCode = Number(entry?.toolExitCode);
        if (!Number.isFinite(exitCode) || exitCode === 0) return null;
        return el('span', {
            className: 'activity-panel__tool-item-exit',
            text: `⚠ exit ${exitCode}`,
            title: entry?.toolStderr
                ? truncateText(entry.toolStderr, 200)
                : `Exit code ${exitCode}`,
            style: {
                color: 'var(--cv-status-errored, #e06c5b)',
                fontSize: 'var(--fs-label)',
                whiteSpace: 'nowrap',
                flexShrink: '0',
                marginLeft: 'auto',
            },
        });
    }

    _renderMessages(messages) {
        const limited = (messages || []).slice(-PANEL_MESSAGE_LIMIT);
        const signature = `${limited.length}|${hashRows(limited, [
            row => row?.ts || 0,
            row => row?.role || '',
            row => (row?.text || '').slice(0, 60),
        ])}`;
        if (signature === this._renderSignatures.messages) return;
        this._renderSignatures.messages = signature;

        const container = this.dom.panelMessages;
        if (!limited.length) {
            replaceChildren(container, [
                this._emptyState('No messages'),
            ]);
            return;
        }
        const reversed = [...limited].reverse();
        replaceChildren(container, reversed.map(m => {
            const cls = m.role === 'assistant' ? 'assistant' : 'user';
            return el('div', {
                className: ['activity-panel__msg', `activity-panel__msg--${cls}`],
            }, [
                el('div', { className: 'activity-panel__msg-role', text: m.role || '' }),
                el('div', { text: truncateText(m.text || '', 60) }),
            ]);
        }));
    }

    _renderTokenUsage(usage) {
        if (!usage) return;

        const normalizedUsage = TokenUsage.normalize(usage);
        const usageSignature = `${normalizedUsage.totalInput}|${normalizedUsage.totalOutput}|${normalizedUsage.cacheRead}|${normalizedUsage.cacheCreate}|${normalizedUsage.contextWindow}|${normalizedUsage.contextWindowMax}|${normalizedUsage.turnCount}`;
        if (usageSignature === this._renderSignatures.tokenUsage) return;
        this._renderSignatures.tokenUsage = usageSignature;

        const maxContext = normalizedUsage.contextWindowMax || contextWindowLimitForModel(
            this.currentAgent?.model,
            this.currentAgent?.provider,
        );
        const contextPct = maxContext ? Math.min(100, (normalizedUsage.contextWindow / maxContext) * 100) : 0;

        // Context size (human-readable form)
        this.dom.panelContextSize.textContent =
            formatTokens(normalizedUsage.contextWindow) + ` / ${formatTokens(maxContext)}`;

        // Context bar
        const bar = this.dom.panelContextBar;
        bar.style.width = contextPct + '%';
        bar.className = 'activity-panel__context-bar';
        if (contextPct > 80) bar.classList.add('activity-panel__context-bar--danger');
        else if (contextPct > 50) bar.classList.add('activity-panel__context-bar--warning');

        // Token cells
        this.dom.panelInputTokens.textContent =
            formatTokens(normalizedUsage.totalInput);
        this.dom.panelOutputTokens.textContent =
            formatTokens(normalizedUsage.totalOutput);
        this.dom.panelCacheRead.textContent =
            formatTokens(normalizedUsage.cacheRead);
        this.dom.panelCacheCreate.textContent =
            formatTokens(normalizedUsage.cacheCreate);
        const cacheHitDenominator = normalizedUsage.totalInput + normalizedUsage.cacheRead;
        this.dom.panelCacheHit.textContent = cacheHitDenominator > 0
            ? `${Math.round((normalizedUsage.cacheRead / cacheHitDenominator) * 100)}%`
            : '-';
        this.dom.panelTurnCount.textContent =
            normalizedUsage.turnCount.toLocaleString();

        const cost = TokenUsage.estimateCost(
            normalizedUsage,
            this.currentAgent?.model,
            this.currentAgent?.provider,
        );
        this.dom.panelEstCost.textContent = formatCost(cost);
    }

    _emptyState(text) {
        return el('div', { className: 'activity-panel__empty', text });
    }

    // ─── Agent enrichment sections ──────────────────────

    _ensureHarborLogSection() {
        if (this._harborLogSectionEl && this._harborLogBodyEl) return;
        const body = el('div', { className: 'activity-panel__token-usage' });
        const details = el('details', { className: 'activity-panel__journey-details' }, [
            el('summary', { className: 'activity-panel__journey-summary', text: 'Recent shipments' }),
            body,
        ]);
        const section = el('div', {
            className: 'activity-panel__section',
            style: { display: 'none' },
        }, [
            el('div', { className: 'activity-panel__section-title', text: 'Harbor Log' }),
            details,
        ]);
        this._insertAgentSectionAfterMeta(section);
        this._harborLogSectionEl = section;
        this._harborLogBodyEl = body;
        this._registerAgentSection(section);
    }

    _updateHarborLog(agent) {
        if (!this._harborLogSectionEl || !this._harborLogBodyEl) return;
        if (this._mode !== 'agent' || !agent) {
            this._harborLogSectionEl.style.display = 'none';
            return;
        }
        const events = (Array.isArray(agent.gitEvents) ? agent.gitEvents : [])
            .map((event, index) => normalizeGitEvent(event, agent, index, {
                maxLabelChars: 42,
                ellipsis: '...',
                subjectBeforeMessage: true,
            }))
            .filter(Boolean)
            .sort((a, b) => (b.timestamp - a.timestamp) || b.id.localeCompare(a.id))
            .slice(0, PANEL_GIT_EVENT_LIMIT);
        if (!events.length) {
            this._harborLogSectionEl.style.display = 'none';
            this._renderSignatures.harborLog = '';
            return;
        }
        const signature = hashRows(events, [
            event => event.id,
            event => event.type,
            event => event.status,
            event => event.label,
            event => event.sha,
            event => event.force,
            event => event.inferred,
        ]);
        this._harborLogSectionEl.style.display = '';
        if (signature === this._renderSignatures.harborLog) return;
        this._renderSignatures.harborLog = signature;
        replaceChildren(this._harborLogBodyEl, events.map(event => this._harborLogRow(event)));
    }

    _harborLogRow(event) {
        const status = this._gitEventStatus(event);
        const shortSha = event.sha ? event.sha.slice(0, 7) : event.type;
        const label = [this._titleize(event.type), shortSha].filter(Boolean).join(' ');
        const row = el('div', {
            className: 'activity-panel__token-row activity-panel__harbor-row',
            title: event.project || '',
            style: event.inferred ? { opacity: '0.68' } : undefined,
        }, [
            el('span', { className: 'activity-panel__token-label' }, [
                el('span', {
                    className: 'activity-panel__harbor-dot',
                    style: { background: status.color },
                }),
                el('span', { text: label }),
            ]),
            el('span', { className: 'activity-panel__token-value activity-panel__harbor-subject' }, [
                el('span', { text: event.label || shortSha || event.id }),
            ]),
        ]);
        if (event.force) {
            row.querySelector('.activity-panel__harbor-subject')?.appendChild(
                el('span', { className: 'activity-panel__harbor-chip', text: 'force' }),
            );
        }
        return row;
    }

    _gitEventStatus(event) {
        const status = String(event?.status || '').toLowerCase();
        if (status === 'failed' || status === 'rejected') {
            return { label: 'failed', color: 'var(--cv-status-errored)' };
        }
        if (status === 'cancelled' || status === 'canceled' || status === 'unknown') {
            return { label: 'pending', color: 'var(--cv-status-waiting)' };
        }
        return { label: 'ok', color: 'var(--cv-green-soft)' };
    }

    _ensureChronicleSection() {
        if (this._chronicleSectionEl && this._chronicleBodyEl) return;
        const body = el('div', { className: 'activity-panel__chronicle-body' });
        const details = el('details', { className: 'activity-panel__journey-details' }, [
            el('summary', { className: 'activity-panel__journey-summary', text: 'Lifetime dossier' }),
            body,
        ]);
        const section = el('div', {
            className: 'activity-panel__section',
            style: { display: 'none' },
        }, [
            el('div', { className: 'activity-panel__section-title', text: 'Chronicle' }),
            details,
        ]);
        this._insertAgentSectionAfterMeta(section);
        this._chronicleSectionEl = section;
        this._chronicleBodyEl = body;
        this._registerAgentSection(section);
    }

    async _fetchAndRenderChronicle(agent) {
        if (!this._chronicleSectionEl || !agent) return;
        const service = this._getBiographyService();
        const identityKey = this._biographyIdentityKey(agent);
        if (!service || !identityKey) {
            this._chronicleSectionEl.style.display = 'none';
            return;
        }
        const seq = ++this._chronicleFetchSeq;
        try {
            const biography = await service.getBiography(identityKey);
            if (
                seq !== this._chronicleFetchSeq
                || this._mode !== 'agent'
                || !this.currentAgent
                || this.currentAgent.id !== agent.id
            ) return;
            this._renderChronicleBody(biography);
        } catch {
            if (seq === this._chronicleFetchSeq) this._chronicleSectionEl.style.display = 'none';
        }
    }

    _renderChronicleBody(biography) {
        if (!this._chronicleSectionEl || !this._chronicleBodyEl) return;
        if (!this._hasBiographyContent(biography)) {
            this._chronicleSectionEl.style.display = 'none';
            this._renderSignatures.chronicle = '';
            return;
        }
        const latest = this._latestBiographyMilestone(biography);
        const signature = [
            biography.identityKey,
            biography.nickname || '',
            biography.sessionsCompleted,
            biography.lifetimeTokens,
            biography.commitsPushed,
            biography.errorsRecovered,
            latest?.id || '',
            latest?.at || 0,
        ].join('|');
        this._chronicleSectionEl.style.display = '';
        if (signature === this._renderSignatures.chronicle) return;
        this._renderSignatures.chronicle = signature;

        const nodes = [];
        if (biography.nickname) {
            nodes.push(el('div', { className: 'activity-panel__chronicle-nickname', text: biography.nickname }));
        }
        nodes.push(el('div', { className: 'activity-panel__token-grid' }, [
            this._tokenCell('Sessions', biography.sessionsCompleted.toLocaleString()),
            this._tokenCell('Tokens', formatTokens(biography.lifetimeTokens)),
            this._tokenCell('Pushes', biography.commitsPushed.toLocaleString()),
            this._tokenCell('Recovered', biography.errorsRecovered.toLocaleString()),
        ]));
        if (latest) {
            nodes.push(this._buildingRow('Milestone', latest.label || latest.id));
        }
        replaceChildren(this._chronicleBodyEl, nodes);
    }

    _hasBiographyContent(biography) {
        if (!biography) return false;
        const statTotal = (
            Number(biography.sessionsCompleted) ||
            Number(biography.lifetimeTokens) ||
            Number(biography.commitsPushed) ||
            Number(biography.errorsRecovered)
        );
        return !!(statTotal || biography.nickname || (Array.isArray(biography.milestones) && biography.milestones.length > 1));
    }

    _latestBiographyMilestone(biography) {
        const milestones = Array.isArray(biography?.milestones) ? biography.milestones : [];
        return milestones
            .filter(milestone => milestone?.id && milestone.id !== 'first-seen')
            .sort((a, b) => (Number(b.at) || 0) - (Number(a.at) || 0))[0] || null;
    }

    _ensureMessageEdgesSection() {
        if (this._messageEdgesSectionEl && this._messageEdgesBodyEl) return;
        const body = el('div', { className: 'activity-panel__messages' });
        const details = el('details', { className: 'activity-panel__journey-details' }, [
            el('summary', { className: 'activity-panel__journey-summary', text: 'Outgoing edges' }),
            body,
        ]);
        const section = el('div', {
            className: 'activity-panel__section',
            style: { display: 'none' },
        }, [
            el('div', { className: 'activity-panel__section-title', text: 'Team Messages' }),
            details,
        ]);
        this._insertAgentSectionAfterMeta(section);
        this._messageEdgesSectionEl = section;
        this._messageEdgesBodyEl = body;
        this._registerAgentSection(section);
    }

    _updateMessageEdges(agent) {
        if (!this._messageEdgesSectionEl || !this._messageEdgesBodyEl) return;
        if (this._mode !== 'agent' || !agent) {
            this._messageEdgesSectionEl.style.display = 'none';
            return;
        }
        const messages = (Array.isArray(agent.sendMessages) ? agent.sendMessages : [])
            .slice(-PANEL_INTER_AGENT_MESSAGE_LIMIT);
        if (!messages.length) {
            this._messageEdgesSectionEl.style.display = 'none';
            this._renderSignatures.messageEdges = '';
            return;
        }
        const signature = hashRows(messages, [
            row => row?.ts || 0,
            row => row?.recipient || row?.to || row?.recipientName || row?.recipient_name || row?.target || row?.targetAgentId || '',
            row => row?.summary || row?.text || row?.message || '',
        ]);
        this._messageEdgesSectionEl.style.display = '';
        if (signature === this._renderSignatures.messageEdges) return;
        this._renderSignatures.messageEdges = signature;
        replaceChildren(this._messageEdgesBodyEl, [...messages].reverse().map(message => this._messageEdgeRow(message)));
    }

    _messageEdgeRow(message) {
        const target = this._messageTargetName(message);
        const text = message?.summary || message?.text || message?.message || message?.messageType || 'message';
        return el('div', { className: ['activity-panel__msg', 'activity-panel__msg--assistant'] }, [
            el('div', { className: 'activity-panel__msg-role', text: target }),
            el('div', { text: truncateText(text, 70) }),
        ]);
    }

    _messageTargetName(message) {
        const raw = String(
            message?.recipient
            || message?.to
            || message?.recipientName
            || message?.recipient_name
            || message?.target
            || message?.targetAgentId
            || message?.target_agent_id
            || ''
        ).trim();
        if (!raw) return 'Unknown';
        const normalized = raw.toLowerCase();
        const world = this._getWorld();
        for (const agent of world?.agents?.values?.() || []) {
            const candidates = [
                agent.id,
                agent.agentId,
                agent.agentName,
                agent.name,
                agent.displayName,
            ].map(value => String(value || '').trim().toLowerCase()).filter(Boolean);
            if (candidates.includes(normalized)) return agent.name || raw;
        }
        return raw;
    }

    _insertAgentSectionAfterMeta(section) {
        const meta = this.panelEl?.querySelector('.activity-panel__meta');
        if (meta?.nextSibling) {
            this.panelEl.insertBefore(section, meta.nextSibling);
        } else if (meta) {
            this.panelEl.appendChild(section);
        } else {
            this.panelEl?.appendChild(section);
        }
    }

    _tokenCell(label, value) {
        return el('div', { className: 'activity-panel__token-cell' }, [
            el('span', { className: 'activity-panel__token-cell-label', text: label }),
            el('span', { className: 'activity-panel__token-cell-value', text: String(value) }),
        ]);
    }

    // ─── Selected-agent journey ────────────────────────

    _ensureJourneySection() {
        if (this._journeySectionEl && this._journeyBodyEl) return;
        // Always-visible headline sentence.
        const whyEl = el('div', { className: 'activity-panel__journey-why' });
        // Secondary rows live in a closed-by-default native disclosure.
        const detailsBody = el('div', { className: ['activity-panel__token-usage', 'activity-panel__journey'] });
        const details = el('details', { className: 'activity-panel__journey-details' }, [
            el('summary', { className: 'activity-panel__journey-summary', text: 'More detail' }),
            detailsBody,
        ]);
        const body = el('div', { className: 'activity-panel__journey-body' }, [whyEl, details]);
        const section = el('div', {
            className: 'activity-panel__section',
            style: { display: 'none' },
        }, [
            el('div', { className: 'activity-panel__section-title', text: 'Journey' }),
            body,
        ]);
        const meta = this.panelEl?.querySelector('.activity-panel__meta');
        if (meta?.nextSibling) {
            this.panelEl.insertBefore(section, meta.nextSibling);
        } else if (meta) {
            this.panelEl.appendChild(section);
        }
        this._journeySectionEl = section;
        this._journeyBodyEl = body;
        this._journeyWhyEl = whyEl;
        this._journeyDetailsEl = details;
        this._journeyDetailsBodyEl = detailsBody;
        this._registerAgentSection(section);
    }

    _updateJourney(agent) {
        if (!this._journeySectionEl || !this._journeyBodyEl) return;
        if (this._mode !== 'agent' || !agent) {
            this._journeySectionEl.style.display = 'none';
            return;
        }

        const snapshot = this._getAgentBehaviorSnapshot(agent);
        const { why, rows } = this._agentJourneyRows(agent, snapshot);
        const signature = `${why}|${hashRows(rows, [
            row => row.label,
            row => row.value,
        ])}`;
        if (!why && !rows.length) {
            this._journeySectionEl.style.display = 'none';
            this._renderSignatures.journey = '';
            return;
        }
        this._journeySectionEl.style.display = '';
        if (signature === this._renderSignatures.journey) return;
        this._renderSignatures.journey = signature;

        // Headline sentence stays outside the disclosure, always visible.
        this._journeyWhyEl.textContent = why || '';
        this._journeyWhyEl.style.display = why ? '' : 'none';

        // Secondary rows live inside the closed-by-default disclosure.
        if (rows.length) {
            this._journeyDetailsEl.style.display = '';
            replaceChildren(this._journeyDetailsBodyEl, rows.map(row => this._journeyRow(row.label, row.value)));
        } else {
            this._journeyDetailsEl.style.display = 'none';
            replaceChildren(this._journeyDetailsBodyEl, []);
        }
    }

    _agentJourneyRows(agent, snapshot) {
        if (!snapshot) return { why: '', rows: [] };
        const behavior = snapshot.behavior || {};
        const currentIntent = behavior.currentIntent || {};
        const buildingType = behavior.building
            || snapshot.building
            || currentIntent.building
            || agent.lastKnownBuildingType
            || null;
        const buildingLabel = this._buildingLabel(buildingType);
        const state = snapshot.behaviorState || behavior.state || null;
        const phase = behavior.currentPhase || currentIntent.phase || null;
        const reason = this._formatReasonLabel(
            currentIntent.label
                || behavior.reason
                || snapshot.behaviorReason
                || currentIntent.reason
                || currentIntent.source
                || '',
        );
        const targetTile = behavior.targetTile || snapshot.targetTile || currentIntent.targetTile || null;
        const reservation = this._getVisitReservation(agent, snapshot);
        const breadcrumb = this._formatBreadcrumb(behavior.recentBuildings || snapshot.recentBuildings);
        const goal = this._formatGoalLabel(
            behavior.currentGoal
                || currentIntent.goal
                || snapshot.goal
                || snapshot.routeIntent?.goal,
        );
        const itinerary = this._formatItinerary(
            behavior.currentItinerary
                || currentIntent.itinerary
                || snapshot.itinerary
                || snapshot.routeIntent?.itinerary,
        );
        const why = this._journeyExplanation({
            state,
            moving: snapshot.moving,
            buildingLabel,
            phase,
            reason,
        });

        // The Why sentence is the always-visible headline; everything else is
        // secondary detail. Drop rows the sentence already conveys.
        const rows = [];
        if (goal) rows.push({ label: 'Goal', value: goal });
        // Only surface the standalone Building row when Why does not already name it.
        const whyNamesBuilding = !!(buildingLabel && why && why.includes(buildingLabel));
        if (buildingLabel && !whyNamesBuilding) rows.push({ label: 'Building', value: buildingLabel });

        // Reservation owns the target tile; suppress it in Route to avoid printing
        // the same tile twice.
        const reservationText = this._formatReservation(reservation, snapshot);
        const route = this._formatRoute({
            state,
            moving: snapshot.moving,
            targetTile: reservationText ? null : targetTile,
            waypointCount: snapshot.waypointCount,
        });
        if (route) rows.push({ label: 'Route', value: route });
        if (itinerary) rows.push({ label: 'Itinerary', value: itinerary });
        if (reason) rows.push({ label: 'Reason', value: reason });
        if (reservationText) rows.push({ label: 'Reservation', value: reservationText });
        if (breadcrumb) rows.push({ label: 'Breadcrumb', value: breadcrumb });
        return { why, rows };
    }

    _journeyExplanation({ state, moving, buildingLabel, phase, reason }) {
        const action = this._formatBehaviorAction(state, moving);
        const phaseLabel = this._formatPhaseLabel(phase);
        const destination = buildingLabel ? ` ${buildingLabel}` : '';
        const purpose = phaseLabel && phaseLabel !== 'Waiting' ? phaseLabel : reason;
        if (action && destination && purpose) return `${action}${destination} for ${purpose.toLowerCase()}`;
        if (action && destination) return `${action}${destination}`;
        if (action && purpose) return `${action} for ${purpose.toLowerCase()}`;
        return '';
    }

    _formatBehaviorAction(state, moving) {
        const normalized = String(state || '').toLowerCase();
        if (moving || normalized === 'traveling') return 'Moving to';
        if (normalized === 'performing') return 'Working at';
        if (normalized === 'blocked') return 'Blocked near';
        if (normalized === 'cooldown') return 'Leaving';
        if (normalized === 'wandering' || normalized === 'roaming') return 'Roaming near';
        return '';
    }

    _formatRoute({ state, moving, targetTile, waypointCount }) {
        const parts = [];
        const stateLabel = BEHAVIOR_STATE_LABELS[String(state || '').toLowerCase()] || '';
        if (stateLabel) parts.push(stateLabel);
        else if (moving) parts.push('Moving');
        const tile = this._formatTile(targetTile);
        if (tile) parts.push(`target ${tile}`);
        const stops = Number(waypointCount);
        if (Number.isFinite(stops) && stops > 0) parts.push(`${stops} waypoint${stops === 1 ? '' : 's'}`);
        return parts.join(', ');
    }

    _formatReservation(reservation, snapshot) {
        if (!reservation && !snapshot?.reservationId) return '';
        const parts = [];
        const slot = reservation?.slotId || snapshot?.visitSlotId || '';
        if (slot) parts.push(`slot ${this._titleize(String(slot).replace(/[:/]+/g, ' ')).toLowerCase()}`);
        const tile = this._formatTile(reservation || snapshot?.targetTile);
        if (tile) parts.push(tile);
        const queueIndex = Number(reservation?.queueIndex);
        const queueDepth = Number(reservation?.queueDepth);
        if (Number.isFinite(queueIndex) && queueIndex > 0) {
            const position = queueIndex + 1;
            const total = Number.isFinite(queueDepth) && queueDepth >= 0
                ? Math.max(position, queueDepth + 1)
                : null;
            parts.push(Number.isFinite(queueDepth) && queueDepth > 0
                ? `queue ${position}/${total}`
                : `queue ${position}`);
        }
        if (reservation?.overflow || reservation?.queueOverflow) parts.push('overflow');
        if (!parts.length && snapshot?.reservationId) parts.push(String(snapshot.reservationId));
        return parts.join(', ');
    }

    _formatBreadcrumb(buildings) {
        const list = Array.isArray(buildings) ? buildings : [];
        const labels = list
            .slice(-JOURNEY_BREADCRUMB_LIMIT)
            .map(type => this._buildingLabel(type))
            .filter(Boolean);
        // Collapse consecutive duplicates (PORTAL > PORTAL > MINE > MINE → PORTAL > MINE).
        const deduped = labels.filter((label, index) => label !== labels[index - 1]);
        return deduped.join(' > ');
    }

    _formatGoalLabel(goal) {
        const key = String(goal || '')
            .trim()
            .replace(/([a-z])([A-Z])/g, '$1-$2')
            .replace(/[_\s]+/g, '-')
            .toLowerCase();
        return AGENT_GOAL_LABELS[key] || '';
    }

    _formatItinerary(itinerary) {
        const route = Array.isArray(itinerary?.route)
            ? itinerary.route
            : (Array.isArray(itinerary?.stops) ? itinerary.stops : []);
        if (route.length < 2) return '';
        const currentIndex = Number(itinerary?.currentIndex);
        return route
            .map((stop, index) => {
                const label = this._buildingLabel(
                    typeof stop === 'string'
                        ? stop
                        : (stop?.building || stop?.buildingType || stop?.type || stop?.id),
                );
                if (!label) return '';
                return Number.isFinite(currentIndex) && Math.round(currentIndex) === index
                    ? `${label} (now)`
                    : label;
            })
            .filter(Boolean)
            .join(' > ');
    }

    _formatTile(value) {
        const x = Number(value?.tileX);
        const y = Number(value?.tileY);
        if (!Number.isFinite(x) || !Number.isFinite(y)) return '';
        return `tile ${Math.round(x)},${Math.round(y)}`;
    }

    _formatPhaseLabel(phase) {
        const key = String(phase || '').trim().toLowerCase();
        return BEHAVIOR_PHASE_LABELS[key] || this._titleize(key);
    }

    _formatReasonLabel(value) {
        const raw = String(value || '').trim();
        if (!raw) return '';
        const reasonKey = raw.toLowerCase().replace(/[_\s]+/g, '-');
        if (REASON_LABELS[reasonKey]) return REASON_LABELS[reasonKey];
        // Suppress raw/unmapped numeric codes (+135490, bare numbers, +/- digits).
        if (/^[+-]?\d+$/.test(raw)) return '';
        const normalized = raw.toLowerCase().replace(/[\/_-]+/g, ' ');
        const pushMatch = normalized.match(/\bpush\s+(failed|rejected|cancelled|canceled)\b/)
            || normalized.match(/\b(failed|rejected|cancelled|canceled)\s+push\b/);
        if (pushMatch) return PUSH_STATUS_LABELS[pushMatch[1]] || raw;
        return this._titleize(normalized);
    }

    _titleize(value) {
        return String(value || '')
            .replace(/[\/_-]+/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .replace(/\b\w/g, char => char.toUpperCase());
    }

    _buildingLabel(type) {
        const key = String(type || '').trim();
        if (!key) return '';
        const building = this._getBuildingByType(key);
        return building?.shortLabel || building?.label || this._titleize(key.replace(/^ambient:/, ''));
    }

    _getBuildingByType(type) {
        const world = this._getWorld();
        if (!world?.buildings) return null;
        if (typeof world.buildings.get === 'function') return world.buildings.get(type) || null;
        if (Array.isArray(world.buildings)) return world.buildings.find(building => building?.type === type) || null;
        return null;
    }

    _getAgentBehaviorSnapshot(agent) {
        const sprite = this._getAgentSprite(agent);
        if (!sprite || typeof sprite.getBehaviorDebugSnapshot !== 'function') return null;
        try {
            return sprite.getBehaviorDebugSnapshot() || null;
        } catch {
            return null;
        }
    }

    _getAgentSprite(agent) {
        if (!agent?.id) return null;
        return this._getRenderer()?.agentSprites?.get?.(agent.id) || null;
    }

    _getVisitReservation(agent, snapshot) {
        const allocator = this._getRenderer()?.visitTileAllocator;
        if (!allocator || typeof allocator.snapshot !== 'function') return null;
        let reservations = [];
        try {
            reservations = allocator.snapshot?.()?.reservations || [];
        } catch {
            reservations = [];
        }
        if (!Array.isArray(reservations) || !reservations.length) return null;
        const reservationId = snapshot?.reservationId;
        return reservations.find(reservation => (
            (reservationId && reservation.id === reservationId)
            || (agent?.id && reservation.agentId === agent.id)
        )) || null;
    }

    // ─── Building mode ─────────────────────────────────

    _hideAgentSections() {
        for (const node of this._agentSections) {
            if (node) node.style.display = 'none';
        }
    }

    _showAgentSections() {
        for (const node of this._agentSections) {
            if (node) node.style.display = '';
        }
    }

    _ensureBuildingContentEl() {
        if (this._buildingContentEl && this._buildingContentEl.isConnected) return;
        const container = el('div', { className: 'activity-panel__building' });
        // Insert immediately after the header so building content occupies the
        // same vertical region the agent meta+sections would.
        const header = this.panelEl.querySelector('.activity-panel__header');
        if (header && header.nextSibling) {
            this.panelEl.insertBefore(container, header.nextSibling);
        } else {
            this.panelEl.appendChild(container);
        }
        this._buildingContentEl = container;
    }

    _teardownBuildingView() {
        if (this._buildingContentEl && this._buildingContentEl.parentNode) {
            this._buildingContentEl.parentNode.removeChild(this._buildingContentEl);
        }
        this._buildingContentEl = null;
        this._selectedBuilding = null;
        this._showAgentSections();
    }

    _renderBuildingView() {
        const building = this._selectedBuilding;
        if (!building) return;
        // Header title doubles as the building label (reuse the agent name slot).
        const labelText = building.label || building.shortLabel || building.type || 'BUILDING';
        const iconText = building.icon || '';
        this.dom.panelAgentName.textContent = iconText ? `${iconText}  ${labelText}` : labelText;
        const statusEl = this.dom.panelAgentStatus;
        statusEl.textContent = (building.district || 'BUILDING').toUpperCase();
        statusEl.style.color = '';

        this._renderBuildingBody();
        this._renderBuildingOccupants();
        this._renderBuildingState();
    }

    _renderBuildingBody() {
        if (!this._buildingContentEl) return;
        const building = this._selectedBuilding;
        const occupants = this._buildingOccupants(building);
        const description = building?.description || 'No description';
        const district = this._titleize(building?.district || 'village');
        const capacity = this._buildingCapacity(building);
        this._renderSignatures.buildingOccupants = '';
        this._renderSignatures.buildingState = '';
        const occupantsSection = el('div', {
            className: 'activity-panel__section',
            dataset: { role: 'occupants' },
        }, [
            el('div', { className: 'activity-panel__section-title', text: 'Occupants' }),
            el('div', { className: 'activity-panel__messages', dataset: { role: 'occupants-list' } }, [
                this._emptyState('-'),
            ]),
        ]);
        const stateSection = el('div', {
            className: 'activity-panel__section',
            dataset: { role: 'state' },
        }, [
            el('div', { className: 'activity-panel__section-title', text: 'Status' }),
            el('div', { className: 'activity-panel__token-usage', dataset: { role: 'state-body' } }, [
                this._emptyState('-'),
            ]),
        ]);
        const aboutSection = el('div', {
            className: 'activity-panel__section activity-panel__section--grow',
        }, [
            el('div', { className: 'activity-panel__section-title', text: 'Purpose' }),
            el('div', { className: 'activity-panel__token-usage' }, [
                this._buildingRow('Purpose', description),
                this._buildingRow('District', district),
                this._buildingRow('Capacity', capacity ? `${occupants.length}/${capacity}` : `${occupants.length}`),
            ]),
        ]);
        replaceChildren(this._buildingContentEl, [occupantsSection, stateSection, aboutSection]);
    }

    _renderBuildingOccupants() {
        if (!this._buildingContentEl) return;
        const building = this._selectedBuilding;
        if (!building) return;
        const list = this._buildingContentEl.querySelector('[data-role="occupants-list"]');
        if (!list) return;
        const occupants = this._buildingOccupants(building);
        const rowsData = occupants.map(agent => {
            const tool = currentToolPresentation(agent);
            return {
                id: agent.id,
                name: agent.name || agent.id,
                status: agent.status,
                toolName: tool.name,
                toolDetail: tool.detail,
            };
        });
        const signature = `${building.type || ''}|${hashRows(rowsData, [
            row => row.id,
            row => row.name,
            row => row.status,
            row => row.toolName,
            row => row.toolDetail,
        ])}`;
        if (signature === this._renderSignatures.buildingOccupants) return;
        this._renderSignatures.buildingOccupants = signature;
        if (!occupants.length) {
            replaceChildren(list, [this._emptyState('No agents currently here')]);
            return;
        }
        const rows = occupants.map((agent) => {
            const statusInfo = statusPresentation(agent.status);
            const tool = currentToolPresentation(agent);
            const row = el('div', {
                className: ['activity-panel__msg', 'activity-panel__msg--assistant', 'activity-panel__occupant'],
                title: 'Switch to agent details',
            }, [
                el('div', { className: 'activity-panel__msg-role', text: statusInfo.label }),
                el('div', { className: 'activity-panel__occupant-main' }, [
                    el('span', { className: 'activity-panel__occupant-name', text: agent.name || agent.id }),
                    el('span', { className: 'activity-panel__occupant-tool', text: tool.name }),
                ]),
            ]);
            row.tabIndex = 0;
            row.setAttribute('role', 'button');
            row.setAttribute('aria-label', `Switch to ${agent.name || agent.id}`);
            row.addEventListener('click', () => emitAgentSelected(agent));
            row.addEventListener('keydown', (event) => {
                if (event.key !== 'Enter' && event.key !== ' ') return;
                event.preventDefault();
                emitAgentSelected(agent);
            });
            return row;
        });
        replaceChildren(list, rows);
    }

    _renderBuildingState() {
        if (!this._buildingContentEl) return;
        const building = this._selectedBuilding;
        if (!building) return;
        const body = this._buildingContentEl.querySelector('[data-role="state-body"]');
        if (!body) return;
        const rows = this._buildingStateRows(building);
        const signature = `${building.type || ''}|${hashRows(rows, [
            row => row.textContent || '',
        ])}`;
        if (signature === this._renderSignatures.buildingState) return;
        this._renderSignatures.buildingState = signature;
        if (!rows.length) {
            replaceChildren(body, [this._emptyState('-')]);
            return;
        }
        replaceChildren(body, rows);
    }

    _buildingOccupants(building) {
        const occupants = [];
        const world = this._getWorld();
        if (!building || !world?.agents?.values || typeof building.isAgentVisiting !== 'function') return occupants;
        for (const agent of world.agents.values()) {
            if (building.isAgentVisiting(agent)) occupants.push(agent);
        }
        return occupants;
    }

    _buildingCapacity(building) {
        const capacity = building?.capacity;
        if (capacity && typeof capacity === 'object') {
            const total = Object.values(capacity).reduce((sum, value) => {
                const number = Number(value);
                return Number.isFinite(number) && number > 0 ? sum + number : sum;
            }, 0);
            if (total > 0) return total;
        }
        if (Array.isArray(building?.visitTiles)) return building.visitTiles.length;
        return 0;
    }

    _buildingStateRows(building) {
        const type = building.type;
        if (type === 'mine') {
            const fiveHour = Number(this._latestUsage?.quota?.fiveHour);
            if (!Number.isFinite(fiveHour)) return [this._buildingRow('5h quota', 'unknown')];
            const pct = Math.max(0, Math.min(100, fiveHour * 100));
            return [this._buildingRow('5h quota', `${pct.toFixed(1)}%`)];
        }
        if (type === 'watchtower') {
            const harbor = this._getHarborTraffic();
            const failed = harbor?.getFailedPushState?.();
            const active = !!(failed && failed.hasFailedPush);
            return [this._buildingRow('Push issue', active ? 'Push failed' : 'clear')];
        }
        if (type === 'harbor') {
            const repos = this._getHarborRepoSummaries();
            if (!repos.length) return [this._buildingRow('Pending repos', 'none')];
            return repos.slice(0, 8).map((repo) => this._buildingRow(
                repo.shortName || repo.repoName || repo.project || 'repo',
                this._formatRepoLedger(repo),
            ));
        }
        return [];
    }

    _formatRepoLedger(repo) {
        const pending = Number(repo.pendingCommits) || 0;
        const docked = Number(repo.dockedCommits) || 0;
        const failed = Number(repo.failedPushes) || 0;
        const parts = [];
        if (pending) parts.push(`${pending} pending`);
        if (docked) parts.push(`${docked} docked`);
        if (failed) parts.push(this._formatPushIssueCount(failed, 'failed'));
        return parts.length ? parts.join(', ') : '0 pending';
    }

    _formatPushIssueCount(count, status) {
        const normalized = String(status || '').toLowerCase();
        if (normalized === 'failed') return `${count} ${count === 1 ? 'push failed' : 'pushes failed'}`;
        if (normalized === 'rejected') return `${count} ${count === 1 ? 'push rejected' : 'pushes rejected'}`;
        if (normalized === 'cancelled' || normalized === 'canceled') {
            return `${count} ${count === 1 ? 'push cancelled' : 'pushes cancelled'}`;
        }
        return `${count} ${this._titleize(status).toLowerCase()}`;
    }

    _buildingRow(label, value) {
        return el('div', { className: 'activity-panel__token-row' }, [
            el('span', { className: 'activity-panel__token-label', text: label }),
            el('span', { className: 'activity-panel__token-value', text: String(value) }),
        ]);
    }

    _journeyRow(label, value) {
        return el('div', { className: 'activity-panel__journey-row' }, [
            el('div', { className: 'activity-panel__journey-label', text: label }),
            el('div', { className: 'activity-panel__journey-value', text: String(value) }),
        ]);
    }

    _getWorld() {
        return this._dependencies.world?.() || null;
    }

    _getRenderer() {
        return this._dependencies.renderer?.() || null;
    }

    _getHarborTraffic() {
        return this._dependencies.harborTraffic?.() || this._getRenderer()?.harborTraffic || null;
    }

    _getBiographyService() {
        return this._dependencies.biographyService?.() || null;
    }

    _biographyIdentityKey(agent) {
        return this._getBiographyService()?.identityKeyFor?.(agent) || AgentBiography.identityKeyFor(agent);
    }

    _getHarborRepoSummaries() {
        const harbor = this._getHarborTraffic();
        if (!harbor) return [];
        if (typeof harbor.getRepoSummaries === 'function') {
            return harbor.getRepoSummaries() || [];
        }
        if (typeof harbor.getPendingRepoSummaries === 'function') {
            return harbor.getPendingRepoSummaries() || [];
        }
        return [];
    }

    destroy() {
        this._stopPolling();
        this._stopBuildingPolling();
        this._teardownBuildingView();
        this.closeBtn.removeEventListener('click', this._onCloseClick);
        this._pinToggleBtn?.removeEventListener('click', this._onPinToggleClick);
        eventBus.off('agent:selected', this._onAgentSelected);
        eventBus.off('agent:updated', this._onAgentUpdated);
        eventBus.off('agent:removed', this._onAgentRemoved);
        eventBus.off(BUILDING_EVENTS.SELECTED, this._onBuildingSelected);
        eventBus.off(BUILDING_EVENTS.DESELECTED, this._onBuildingDeselected);
        eventBus.off('usage:updated', this._onUsageUpdated);
        eventBus.off('mood:changed', this._onMoodChanged);
        eventBus.off('biography:updated', this._onBiographyUpdated);
    }
}
