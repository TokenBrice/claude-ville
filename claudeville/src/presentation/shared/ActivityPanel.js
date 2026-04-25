import { eventBus } from '../../domain/events/DomainEvent.js';
import { TokenUsage } from '../../domain/value-objects/TokenUsage.js';
import { sessionDetailsService } from './SessionDetailsService.js';
import { SESSION_DETAIL_PANEL_REFRESH_INTERVAL } from '../../config/constants.js';
import { formatModelLabel, getModelVisualIdentity } from './ModelVisualIdentity.js';

const TOOL_ICONS = {
    Read: '\u{1F4D6}', Edit: '\u270F\uFE0F', Write: '\u{1F4DD}',
    Grep: '\u{1F50D}', Glob: '\u{1F4C1}', Bash: '\u26A1',
    Task: '\u{1F4CB}', TaskCreate: '\u{1F4CB}', TaskUpdate: '\u{1F4CB}', TaskList: '\u{1F4CB}',
    WebSearch: '\u{1F310}', WebFetch: '\u{1F310}',
    SendMessage: '\u{1F4AC}', TeamCreate: '\u{1F465}',
    EnterPlanMode: '\u{1F4D0}', ExitPlanMode: '\u{1F4D0}',
    AskUserQuestion: '\u2753',
};

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
        this.closeBtn.addEventListener('click', () => this.hide());

        eventBus.on('agent:selected', (agent) => {
            if (agent) this.show(agent);
        });

        eventBus.on('agent:updated', (agent) => {
            if (this.currentAgent && agent.id === this.currentAgent.id) {
                this.currentAgent = agent;
                this._updateInfo(agent);
                this._updateCurrentTool(agent);
            }
        });

        eventBus.on('agent:removed', (agent) => {
            if (this.currentAgent && agent.id === this.currentAgent.id) {
                this.hide();
            }
        });
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
        const status = this._normalizeStatus(agent.status);
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
        this.dom.panelTeam.textContent = agent.teamName || '-';
    }

    _updateCurrentTool(agent) {
        const container = this.dom.panelCurrentTool;
        const iconEl = this._toolEls.icon;
        const nameEl = this._toolEls.name;
        const inputEl = this._toolEls.input;
        const status = this._normalizeStatus(agent.status);

        if (agent.currentTool) {
            container.classList.remove('activity-panel__current-tool--idle');
            iconEl.textContent = this._icon(agent.currentTool);
            nameEl.textContent = agent.currentTool;
            inputEl.textContent = agent.currentToolInput || '';
        } else {
            container.classList.add('activity-panel__current-tool--idle');
            iconEl.textContent = status === 'idle' ? '\u{1F4A4}' : '\u23F3';
            nameEl.textContent = status === 'idle' ? 'Idle' : 'Waiting...';
            inputEl.textContent = '';
        }
    }

    _normalizeStatus(status) {
        const normalized = String(status || 'idle').toLowerCase();
        return normalized === 'active' ? 'working' : normalized;
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
        const signature = JSON.stringify((tools || []).map((tool) => ({
            tool: tool.tool || '',
            detail: (tool.detail || '').slice(0, 45),
            ts: tool.ts || 0,
        })));
        if (signature === this._renderSignatures.toolHistory) return;
        this._renderSignatures.toolHistory = signature;

        const el = this.dom.panelToolHistory;
        if (!tools.length) {
            el.innerHTML = '<div class="activity-panel__empty">No tool usage</div>';
            return;
        }
        const reversed = [...tools].reverse();
        el.innerHTML = reversed.map(t => {
            const icon = this._icon(t.tool);
            const name = this._shortTool(t.tool);
            const detail = t.detail ? this._esc(this._trunc(t.detail, 45)) : '';
            return `<div class="activity-panel__tool-item">
                <span class="activity-panel__tool-item-icon">${icon}</span>
                <span class="activity-panel__tool-item-name">${this._esc(name)}</span>
                <span class="activity-panel__tool-item-detail">${detail}</span>
            </div>`;
        }).join('');
    }

    _renderMessages(messages) {
        const signature = JSON.stringify((messages || []).map((message) => ({
            role: message.role || '',
            text: (message.text || '').slice(0, 60),
            ts: message.ts || 0,
        })));
        if (signature === this._renderSignatures.messages) return;
        this._renderSignatures.messages = signature;

        const el = this.dom.panelMessages;
        if (!messages.length) {
            el.innerHTML = '<div class="activity-panel__empty">No messages</div>';
            return;
        }
        const reversed = [...messages].reverse();
        el.innerHTML = reversed.map(m => {
            const cls = m.role === 'assistant' ? 'assistant' : 'user';
            return `<div class="activity-panel__msg activity-panel__msg--${cls}">
                <div class="activity-panel__msg-role">${m.role}</div>
                <div>${this._esc(this._trunc(m.text || '', 60))}</div>
            </div>`;
        }).join('');
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
            this._formatTokens(normalizedUsage.contextWindow) + ` / ${this._formatTokens(MAX_CONTEXT)}`;

        // Context bar
        const bar = this.dom.panelContextBar;
        bar.style.width = contextPct + '%';
        bar.className = 'activity-panel__context-bar';
        if (contextPct > 80) bar.classList.add('activity-panel__context-bar--danger');
        else if (contextPct > 50) bar.classList.add('activity-panel__context-bar--warning');

        // Token cells
        this.dom.panelInputTokens.textContent =
            this._formatTokens(normalizedUsage.totalInput);
        this.dom.panelOutputTokens.textContent =
            this._formatTokens(normalizedUsage.totalOutput);
        this.dom.panelCacheRead.textContent =
            this._formatTokens(normalizedUsage.cacheRead);
        this.dom.panelTurnCount.textContent =
            normalizedUsage.turnCount.toLocaleString();

        const cost = TokenUsage.estimateCost(
            normalizedUsage,
            this.currentAgent?.model,
            this.currentAgent?.provider,
        );
        this.dom.panelEstCost.textContent = this._formatCost(cost);
    }

    _formatTokens(n) {
        if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
        if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
        return String(n);
    }

    _contextLimitFor(agent) {
        const model = String(agent?.model || '').toLowerCase();
        if (String(agent?.provider || '').toLowerCase() === 'codex' || model.includes('gpt')) return 258400;
        return 200000;
    }

    _formatCost(cost) {
        if (!Number.isFinite(cost) || cost <= 0) return '$0.0000';
        if (cost < 0.0001) return '<$0.0001';
        if (cost >= 10) return `$${cost.toFixed(2)}`;
        return `$${cost.toFixed(4)}`;
    }

    // ─── Utilities ───────────────────────────────────────

    _icon(tool) {
        if (!tool) return '\u2753';
        if (tool.startsWith('mcp__playwright__')) return '\u{1F3AD}';
        if (tool.startsWith('mcp__')) return '\u{1F50C}';
        return TOOL_ICONS[tool] || '\u{1F527}';
    }

    _shortTool(name) {
        if (!name) return '';
        return name.replace('mcp__playwright__', 'pw:').replace('mcp__', '');
    }

    _trunc(s, max) {
        return s.length > max ? s.substring(0, max - 1) + '...' : s;
    }

    _esc(s) {
        if (!s) return '';
        const d = document.createElement('div');
        d.textContent = s;
        return d.innerHTML;
    }

    destroy() {
        this._stopPolling();
    }
}
