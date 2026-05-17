import { eventBus, BUILDING_EVENTS } from '../../domain/events/DomainEvent.js';
import { TokenUsage } from '../../domain/value-objects/TokenUsage.js';
import { sessionDetailsService } from './SessionDetailsService.js';
import { SESSION_DETAIL_PANEL_REFRESH_INTERVAL } from '../../config/constants.js';
import { el, replaceChildren } from './DomSafe.js';
import { formatCost, formatTokens, hashRows, truncateText } from './Formatters.js';
import { emitAgentDeselected, emitAgentSelected } from './AgentSelection.js';
import {
    currentToolPresentation,
    modelPresentation,
    statusPresentation,
    toolHistoryNodes,
    toolHistorySignature,
} from './AgentPresentation.js';

const PANEL_TOOL_LIMIT = 30;
const PANEL_MESSAGE_LIMIT = 12;
const BUILDING_OCCUPANT_REFRESH_INTERVAL = 5000;

export class ActivityPanel {
    constructor() {
        this.panelEl = document.getElementById('activityPanel');
        this.closeBtn = document.getElementById('panelClose');
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
            panelCurrentTool: document.getElementById('panelCurrentTool'),
            panelToolHistory: document.getElementById('panelToolHistory'),
            panelMessages: document.getElementById('panelMessages'),
            panelContextSize: document.getElementById('panelContextSize'),
            panelContextBar: document.getElementById('panelContextBar'),
            panelInputTokens: document.getElementById('panelInputTokens'),
            panelOutputTokens: document.getElementById('panelOutputTokens'),
            panelCacheRead: document.getElementById('panelCacheRead'),
            panelTurnCount: document.getElementById('panelTurnCount'),
            panelEstCost: document.getElementById('panelEstCost'),
        };
        this._toolEls = {
            icon: this.dom.panelCurrentTool.querySelector('.activity-panel__tool-icon'),
            name: this.dom.panelCurrentTool.querySelector('.activity-panel__tool-name'),
            input: this.dom.panelCurrentTool.querySelector('.activity-panel__tool-input'),
        };
        // Sections that belong to agent mode and must be hidden when a building is selected.
        this._agentSections = Array.from(this.panelEl?.querySelectorAll('.activity-panel__meta, .activity-panel__section') || []);
        // Building-mode content container is created on demand and inserted after the header.
        this._buildingContentEl = null;
        this._renderSignatures = {
            toolHistory: '',
            messages: '',
            tokenUsage: '',
        };

        this._bind();
    }

    _bind() {
        this._onCloseClick = () => this.hide();
        this._onAgentSelected = (agent) => {
            if (agent) this.show(agent);
        };
        this._onAgentUpdated = (agent) => {
            if (this._mode === 'agent' && this.currentAgent && agent.id === this.currentAgent.id) {
                this.currentAgent = agent;
                this._updateInfo(agent);
                this._updateCurrentTool(agent);
            }
        };
        this._onAgentRemoved = (agent) => {
            sessionDetailsService.deleteForAgent(agent);
            if (this._mode === 'agent' && this.currentAgent && agent.id === this.currentAgent.id) {
                this.hide();
            }
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

        this.closeBtn.addEventListener('click', this._onCloseClick);
        eventBus.on('agent:selected', this._onAgentSelected);
        eventBus.on('agent:updated', this._onAgentUpdated);
        eventBus.on('agent:removed', this._onAgentRemoved);
        eventBus.on(BUILDING_EVENTS.SELECTED, this._onBuildingSelected);
        eventBus.on(BUILDING_EVENTS.DESELECTED, this._onBuildingDeselected);
        eventBus.on('usage:updated', this._onUsageUpdated);
    }

    show(agent) {
        // Agent selection takes over the panel: tear down any building view first.
        if (this._mode === 'building') {
            this._teardownBuildingView();
        }
        this._mode = 'agent';
        this.currentAgent = agent;
        this._renderSignatures = {
            toolHistory: '',
            messages: '',
            tokenUsage: '',
        };
        this._showAgentSections();
        this.panelEl.style.display = '';
        this._updateInfo(agent);
        this._updateCurrentTool(agent);
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
        this._hideAgentSections();
        this._ensureBuildingContentEl();
        this.panelEl.style.display = '';
        this._renderBuildingView();
        this._startBuildingPolling();
    }

    hide() {
        const wasAgent = this._mode === 'agent';
        const wasBuilding = this._mode === 'building';
        this.panelEl.style.display = 'none';
        this.currentAgent = null;
        this._renderSignatures = {
            toolHistory: '',
            messages: '',
            tokenUsage: '',
        };
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
        statusEl.textContent = statusInfo.status.toUpperCase();
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

    _updateCurrentTool(agent) {
        const container = this.dom.panelCurrentTool;
        const iconEl = this._toolEls.icon;
        const nameEl = this._toolEls.name;
        const inputEl = this._toolEls.input;
        const tool = currentToolPresentation(agent);

        if (!tool.isIdle) {
            container.classList.remove('activity-panel__current-tool--idle');
            iconEl.textContent = tool.icon;
            nameEl.textContent = tool.name;
            inputEl.textContent = tool.detail;
        } else {
            container.classList.add('activity-panel__current-tool--idle');
            iconEl.textContent = tool.icon;
            nameEl.textContent = tool.name;
            inputEl.textContent = tool.detail;
        }
    }

    // ─── Live polling ────────────────────────────────

    _startPolling() {
        this._stopPolling();
        this._fetchDetail();
        this._pollTimer = setInterval(() => this._fetchDetail(), SESSION_DETAIL_PANEL_REFRESH_INTERVAL);
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
        const data = await sessionDetailsService.fetchSessionDetail(agent);
        if (!data || !this.currentAgent || this.currentAgent.id !== agent.id) return;
        this._renderToolHistory(data.toolHistory || []);
        this._renderMessages(data.messages || []);
        this._renderTokenUsage(data.tokenUsage || data.tokens || data.usage);
    }

    // ─── Rendering ─────────────────────────────────────

    _renderToolHistory(tools) {
        const limited = (tools || []).slice(-PANEL_TOOL_LIMIT);
        const signature = toolHistorySignature(limited, {
            limit: PANEL_TOOL_LIMIT,
            detailLength: 45,
        });
        if (signature === this._renderSignatures.toolHistory) return;
        this._renderSignatures.toolHistory = signature;

        const container = this.dom.panelToolHistory;
        replaceChildren(container, toolHistoryNodes(limited, {
            limit: PANEL_TOOL_LIMIT,
            detailLength: 45,
            emptyText: 'No tool usage',
            emptyClass: 'activity-panel__empty',
            itemClass: 'activity-panel__tool-item',
            iconClass: 'activity-panel__tool-item-icon',
            nameClass: 'activity-panel__tool-item-name',
            detailClass: 'activity-panel__tool-item-detail',
        }));
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

        const MAX_CONTEXT = normalizedUsage.contextWindowMax || this._contextLimitFor(this.currentAgent);
        const contextPct = MAX_CONTEXT ? Math.min(100, (normalizedUsage.contextWindow / MAX_CONTEXT) * 100) : 0;

        // Context size (human-readable form)
        this.dom.panelContextSize.textContent =
            formatTokens(normalizedUsage.contextWindow) + ` / ${formatTokens(MAX_CONTEXT)}`;

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
        this.dom.panelTurnCount.textContent =
            normalizedUsage.turnCount.toLocaleString();

        const cost = TokenUsage.estimateCost(
            normalizedUsage,
            this.currentAgent?.model,
            this.currentAgent?.provider,
        );
        this.dom.panelEstCost.textContent = formatCost(cost);
    }

    _contextLimitFor(agent) {
        const model = String(agent?.model || '').toLowerCase();
        const provider = String(agent?.provider || '').toLowerCase();
        if (provider === 'codex' || model.includes('gpt')) return 258400;
        if (provider === 'kimi' || model.includes('kimi')) return 262144;
        return 200000;
    }

    _emptyState(text) {
        return el('div', { className: 'activity-panel__empty', text });
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
        const description = building?.description || '';
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
            el('div', { className: 'activity-panel__tool-input', text: description || 'No description' }),
        ]);
        replaceChildren(this._buildingContentEl, [occupantsSection, stateSection, aboutSection]);
    }

    _renderBuildingOccupants() {
        if (!this._buildingContentEl) return;
        const building = this._selectedBuilding;
        if (!building) return;
        const list = this._buildingContentEl.querySelector('[data-role="occupants-list"]');
        if (!list) return;
        const world = this._getWorld();
        const occupants = [];
        if (world?.agents?.values) {
            for (const agent of world.agents.values()) {
                if (typeof building.isAgentVisiting === 'function' && building.isAgentVisiting(agent)) {
                    occupants.push(agent);
                }
            }
        }
        if (!occupants.length) {
            replaceChildren(list, [this._emptyState('No agents currently here')]);
            return;
        }
        const rows = occupants.map((agent) => {
            const statusInfo = statusPresentation(agent.status);
            const row = el('div', {
                className: ['activity-panel__msg', 'activity-panel__msg--assistant'],
                style: { cursor: 'pointer' },
                title: 'Switch to agent details',
            }, [
                el('div', { className: 'activity-panel__msg-role', text: statusInfo.status }),
                el('div', { text: agent.name || agent.id }),
            ]);
            row.addEventListener('click', () => emitAgentSelected(agent));
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
        if (!rows.length) {
            replaceChildren(body, [this._emptyState('-')]);
            return;
        }
        replaceChildren(body, rows);
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
            return [this._buildingRow('Failed push', active ? 'ACTIVE' : 'clear')];
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
        if (failed) parts.push(`${failed} failed`);
        return parts.length ? parts.join(', ') : '0 pending';
    }

    _buildingRow(label, value) {
        return el('div', { className: 'activity-panel__token-row' }, [
            el('span', { className: 'activity-panel__token-label', text: label }),
            el('span', { className: 'activity-panel__token-value', text: String(value) }),
        ]);
    }

    _getWorld() {
        const app = typeof window !== 'undefined' ? window.__claudeVilleApp : null;
        return app?.world || null;
    }

    _getHarborTraffic() {
        const app = typeof window !== 'undefined' ? window.__claudeVilleApp : null;
        return app?.renderer?.harborTraffic || null;
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
        eventBus.off('agent:selected', this._onAgentSelected);
        eventBus.off('agent:updated', this._onAgentUpdated);
        eventBus.off('agent:removed', this._onAgentRemoved);
        eventBus.off(BUILDING_EVENTS.SELECTED, this._onBuildingSelected);
        eventBus.off(BUILDING_EVENTS.DESELECTED, this._onBuildingDeselected);
        eventBus.off('usage:updated', this._onUsageUpdated);
    }
}
