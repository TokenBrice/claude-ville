import { eventBus } from '../../domain/events/DomainEvent.js';

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
        this.panelEl.style.display = '';
        this._updateInfo(agent);
        this._updateCurrentTool(agent);
        this._startPolling();
    }

    hide() {
        this.panelEl.style.display = 'none';
        this.currentAgent = null;
        this._stopPolling();
        eventBus.emit('agent:deselected');
    }

    _updateInfo(agent) {
        document.getElementById('panelAgentName').textContent = agent.name;
        const statusEl = document.getElementById('panelAgentStatus');
        statusEl.textContent = agent.status.toUpperCase();
        statusEl.style.color = {
            working: '#4ade80', idle: '#60a5fa', waiting: '#f97316',
        }[agent.status] || '#8b8b9e';

        document.getElementById('panelModel').textContent =
            (agent.model || '').replace('claude-', '').replace(/-2025\d+/, '');
        document.getElementById('panelProvider').textContent = agent.provider || 'claude';
        document.getElementById('panelRole').textContent = agent.role || 'general';
        document.getElementById('panelTeam').textContent = agent.teamName || '-';
    }

    _updateCurrentTool(agent) {
        const container = document.getElementById('panelCurrentTool');
        const iconEl = container.querySelector('.activity-panel__tool-icon');
        const nameEl = container.querySelector('.activity-panel__tool-name');
        const inputEl = container.querySelector('.activity-panel__tool-input');

        if (agent.currentTool) {
            container.classList.remove('activity-panel__current-tool--idle');
            iconEl.textContent = this._icon(agent.currentTool);
            nameEl.textContent = agent.currentTool;
            inputEl.textContent = agent.currentToolInput || '';
        } else {
            container.classList.add('activity-panel__current-tool--idle');
            iconEl.textContent = agent.status === 'idle' ? '\u{1F4A4}' : '\u23F3';
            nameEl.textContent = agent.status === 'idle' ? 'Idle' : 'Waiting...';
            inputEl.textContent = '';
        }
    }

    // ─── Live polling ────────────────────────────────

    _startPolling() {
        this._stopPolling();
        this._fetchDetail();
        this._pollTimer = setInterval(() => this._fetchDetail(), 2000);
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
        try {
            const params = new URLSearchParams({
                sessionId: agent.id,
                project: agent.projectPath || '',
                provider: agent.provider || 'claude',
            });
            const resp = await fetch(`/api/session-detail?${params}`);
            if (!resp.ok) return;
            const data = await resp.json();
            if (this.currentAgent && this.currentAgent.id === agent.id) {
                this._renderToolHistory(data.toolHistory || []);
                this._renderMessages(data.messages || []);
                this._renderTokenUsage(data.tokenUsage);
            }
        } catch {
            // Ignore network errors.
        }
    }

    // ─── Rendering ─────────────────────────────────────

    _renderToolHistory(tools) {
        const el = document.getElementById('panelToolHistory');
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
        const el = document.getElementById('panelMessages');
        if (!messages.length) {
            el.innerHTML = '<div class="activity-panel__empty">No messages</div>';
            return;
        }
        const reversed = [...messages].reverse();
        el.innerHTML = reversed.map(m => {
            const cls = m.role === 'assistant' ? 'assistant' : 'user';
            return `<div class="activity-panel__msg activity-panel__msg--${cls}">
                <div class="activity-panel__msg-role">${m.role}</div>
                <div>${this._esc(m.text)}</div>
            </div>`;
        }).join('');
    }

    _renderTokenUsage(usage) {
        if (!usage) return;

        const MAX_CONTEXT = usage.contextWindowMax || this._contextLimitFor(this.currentAgent);
        const contextPct = Math.min(100, (usage.contextWindow / MAX_CONTEXT) * 100);

        // Context size (human-readable form)
        document.getElementById('panelContextSize').textContent =
            this._formatTokens(usage.contextWindow) + ` / ${this._formatTokens(MAX_CONTEXT)}`;

        // Context bar
        const bar = document.getElementById('panelContextBar');
        bar.style.width = contextPct + '%';
        bar.className = 'activity-panel__context-bar';
        if (contextPct > 80) bar.classList.add('activity-panel__context-bar--danger');
        else if (contextPct > 50) bar.classList.add('activity-panel__context-bar--warning');

        // Token cells
        document.getElementById('panelInputTokens').textContent =
            this._formatTokens(usage.totalInput);
        document.getElementById('panelOutputTokens').textContent =
            this._formatTokens(usage.totalOutput);
        document.getElementById('panelCacheRead').textContent =
            this._formatTokens(usage.cacheRead);
        document.getElementById('panelTurnCount').textContent =
            usage.turnCount.toLocaleString();

        const cost = this._estimateCost(usage, this.currentAgent);
        document.getElementById('panelEstCost').textContent = this._formatCost(cost);
    }

    _formatTokens(n) {
        if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
        if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
        return String(n);
    }

    _estimateCost(usage, agent) {
        const rates = this._pricingFor(agent);
        return (
            (usage.totalInput * rates.input / 1000000) +
            (usage.totalOutput * rates.output / 1000000) +
            (usage.cacheRead * rates.cacheRead / 1000000) +
            (usage.cacheCreate * rates.cacheCreate / 1000000)
        );
    }

    _pricingFor(agent) {
        const model = String(agent?.model || '').toLowerCase();
        const provider = String(agent?.provider || '').toLowerCase();
        const claudeRates = [
            { match: 'opus', input: 15, output: 75, cacheRead: 1.5, cacheCreate: 18.75 },
            { match: 'sonnet', input: 3, output: 15, cacheRead: 0.3, cacheCreate: 3.75 },
            { match: 'haiku', input: 0.8, output: 4, cacheRead: 0.08, cacheCreate: 1 },
        ];
        const openAiRates = [
            { match: 'gpt-5.5', input: 15, output: 120, cacheRead: 1.5, cacheCreate: 0 },
            { match: 'gpt-5.4', input: 10, output: 80, cacheRead: 1, cacheCreate: 0 },
            { match: 'gpt-5.3', input: 5, output: 40, cacheRead: 0.5, cacheCreate: 0 },
            { match: 'gpt-5', input: 1.25, output: 10, cacheRead: 0.125, cacheCreate: 0 },
        ];
        const table = provider === 'codex' || model.includes('gpt') ? openAiRates : claudeRates;
        return table.find(rate => model.includes(rate.match)) || (table === openAiRates
            ? { input: 1.25, output: 10, cacheRead: 0.125, cacheCreate: 0 }
            : { input: 3, output: 15, cacheRead: 0.3, cacheCreate: 3.75 });
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
