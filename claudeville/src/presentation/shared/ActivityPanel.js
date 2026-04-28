import { eventBus } from '../../domain/events/DomainEvent.js';
import { TokenUsage } from '../../domain/value-objects/TokenUsage.js';
import { sessionDetailsService } from './SessionDetailsService.js';
import { SESSION_DETAIL_PANEL_REFRESH_INTERVAL } from '../../config/constants.js';
import { formatModelLabel, getModelVisualIdentity } from './ModelVisualIdentity.js';
import { el, replaceChildren } from './DomSafe.js';
import { formatCost, formatTokens, hashRows, normalizeStatus, truncateText } from './Formatters.js';
import { shortToolName, toolIcon } from '../../domain/services/ToolIdentity.js';
const PANEL_TOOL_LIMIT = 30;
const PANEL_MESSAGE_LIMIT = 12;

export class ActivityPanel {
    constructor() {
        this.panelEl = document.getElementById('activityPanel');
        this.closeBtn = document.getElementById('panelClose');
        this.currentAgent = null;
        this._pollTimer = null;
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
            if (this.currentAgent && agent.id === this.currentAgent.id) {
                this.currentAgent = agent;
                this._updateInfo(agent);
                this._updateCurrentTool(agent);
            }
        };
        this._onAgentRemoved = (agent) => {
            sessionDetailsService.deleteForAgent(agent);
            if (this.currentAgent && agent.id === this.currentAgent.id) {
                this.hide();
            }
        };

        this.closeBtn.addEventListener('click', this._onCloseClick);
        eventBus.on('agent:selected', this._onAgentSelected);
        eventBus.on('agent:updated', this._onAgentUpdated);
        eventBus.on('agent:removed', this._onAgentRemoved);
    }

    show(agent) {
        this.currentAgent = agent;
        this._renderSignatures = {
            toolHistory: '',
            messages: '',
            tokenUsage: '',
        };
        this.panelEl.style.display = '';
        this._updateInfo(agent);
        this._updateCurrentTool(agent);
        this._startPolling();
    }

    hide() {
        this.panelEl.style.display = 'none';
        this.currentAgent = null;
        this._renderSignatures = {
            toolHistory: '',
            messages: '',
            tokenUsage: '',
        };
        this._stopPolling();
        eventBus.emit('agent:deselected');
    }

    _updateInfo(agent) {
        const status = normalizeStatus(agent.status);
        this.dom.panelAgentName.textContent = agent.name;
        const statusEl = this.dom.panelAgentStatus;
        statusEl.textContent = status.toUpperCase();
        statusEl.style.color = {
            working: '#4ade80', idle: '#60a5fa', waiting: '#f97316',
        }[status] || '#8b8b9e';

        const identity = getModelVisualIdentity(agent.model, agent.effort, agent.provider);
        this.dom.panelModel.textContent = formatModelLabel(agent.model, agent.effort, agent.provider);
        this.dom.panelModel.style.color = identity.accent?.[0] || '';
        this.dom.panelModel.title = identity.label || agent.model || '';
        this.dom.panelProvider.textContent = agent.provider || 'claude';
        this.dom.panelRole.textContent = agent.role || 'general';
        this.dom.panelLevel.textContent = this._formatAgentLevel(identity);
        this.dom.panelLevel.style.color = identity.accent?.[1] || identity.accent?.[0] || '';
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
        const status = normalizeStatus(agent.status);

        if (agent.currentTool) {
            container.classList.remove('activity-panel__current-tool--idle');
            iconEl.textContent = toolIcon(agent.currentTool);
            nameEl.textContent = agent.currentTool;
            inputEl.textContent = agent.currentToolInput || '';
        } else {
            container.classList.add('activity-panel__current-tool--idle');
            iconEl.textContent = status === 'idle' ? '\u{1F4A4}' : '\u23F3';
            nameEl.textContent = status === 'idle' ? 'Idle' : 'Waiting...';
            inputEl.textContent = '';
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
        const signature = `${limited.length}|${hashRows(limited, [
            row => row?.ts || 0,
            row => row?.tool || '',
            row => (row?.detail || '').slice(0, 45),
        ])}`;
        if (signature === this._renderSignatures.toolHistory) return;
        this._renderSignatures.toolHistory = signature;

        const container = this.dom.panelToolHistory;
        if (!limited.length) {
            replaceChildren(container, [
                this._emptyState('No tool usage'),
            ]);
            return;
        }
        const reversed = [...limited].reverse();
        replaceChildren(container, reversed.map(t => {
            const icon = toolIcon(t.tool);
            const name = shortToolName(t.tool);
            const detail = t.detail ? truncateText(t.detail, 45) : '';
            return el('div', { className: 'activity-panel__tool-item' }, [
                el('span', { className: 'activity-panel__tool-item-icon', text: icon }),
                el('span', { className: 'activity-panel__tool-item-name', text: name }),
                el('span', { className: 'activity-panel__tool-item-detail', text: detail }),
            ]);
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
        if (String(agent?.provider || '').toLowerCase() === 'codex' || model.includes('gpt')) return 258400;
        return 200000;
    }

    _emptyState(text) {
        return el('div', { className: 'activity-panel__empty', text });
    }

    destroy() {
        this._stopPolling();
        this.closeBtn.removeEventListener('click', this._onCloseClick);
        eventBus.off('agent:selected', this._onAgentSelected);
        eventBus.off('agent:updated', this._onAgentUpdated);
        eventBus.off('agent:removed', this._onAgentRemoved);
    }
}
