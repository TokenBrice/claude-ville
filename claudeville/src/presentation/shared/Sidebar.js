import { eventBus } from '../../domain/events/DomainEvent.js';
import { i18n } from '../../config/i18n.js';

// 프로젝트별 색상 팔레트
const PROJECT_COLORS = [
    '#e8d44d', '#4ade80', '#60a5fa', '#f97316', '#a78bfa',
    '#f472b6', '#34d399', '#fb923c', '#818cf8', '#22d3ee',
];

export class Sidebar {
    constructor(world) {
        this.world = world;
        this.listEl = document.getElementById('agentList');
        this.countEl = document.getElementById('agentCount');
        this.selectedId = null;
        this._projectColorMap = new Map();

        this._onUpdate = () => this.render();
        eventBus.on('agent:added', this._onUpdate);
        eventBus.on('agent:updated', this._onUpdate);
        eventBus.on('agent:removed', this._onUpdate);

        this.render();
    }

    render() {
        const agents = Array.from(this.world.agents.values());
        this.countEl.textContent = agents.length;

        // 프로젝트별 그룹핑
        const groups = this._groupByProject(agents);
        this._assignProjectColors(groups);

        let html = '';
        for (const [projectPath, groupAgents] of groups) {
            const projectName = this._shortProjectName(projectPath);
            const color = this._projectColorMap.get(projectPath) || '#8b8b9e';
            html += `<div class="sidebar__project-group">
                <div class="sidebar__project-header" style="border-left-color: ${color}">
                    <span class="sidebar__project-dot" style="background: ${color}"></span>
                    <span class="sidebar__project-name">${this._escape(projectName)}</span>
                    <span class="sidebar__project-count">${groupAgents.length}</span>
                </div>`;
            for (const agent of groupAgents) {
                html += `<div class="sidebar__agent ${agent.id === this.selectedId ? 'sidebar__agent--selected' : ''}"
                     data-agent-id="${agent.id}">
                    <span class="sidebar__agent-dot sidebar__agent-dot--${agent.status}"></span>
                    <div class="sidebar__agent-info">
                        <span class="sidebar__agent-name">${this._escape(agent.name)}</span>
                        <span class="sidebar__agent-model">${this._shortModel(agent.model)}</span>
                    </div>
                </div>`;
            }
            html += '</div>';
        }

        this.listEl.innerHTML = html;

        // 클릭 이벤트 바인딩
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
        // 홈 디렉토리 자체인 경우 (예: /Users/username) → ~ 로 표시
        if (parts.length <= 2 && parts[0] === 'Users') return '~';
        return last;
    }

    _escape(str) {
        if (!str) return '';
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    _shortModel(model) {
        if (!model) return '';
        return model
            .replace('claude-', '')
            .replace('-20250929', '')
            .replace('-20251001', '');
    }

    destroy() {
        eventBus.off('agent:added', this._onUpdate);
        eventBus.off('agent:updated', this._onUpdate);
        eventBus.off('agent:removed', this._onUpdate);
    }
}
