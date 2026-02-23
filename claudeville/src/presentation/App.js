import { World } from '../domain/entities/World.js';
import { Building } from '../domain/entities/Building.js';
import { BUILDING_DEFS } from '../config/buildings.js';
import { eventBus } from '../domain/events/DomainEvent.js';
import { i18n } from '../config/i18n.js';
import { Appearance } from '../domain/value-objects/Appearance.js';
import { Agent } from '../domain/entities/Agent.js';

import { ClaudeDataSource } from '../infrastructure/ClaudeDataSource.js';
import { WebSocketClient } from '../infrastructure/WebSocketClient.js';

import { AgentManager } from '../application/AgentManager.js';
import { ModeManager } from '../application/ModeManager.js';
import { SessionWatcher } from '../application/SessionWatcher.js';
import { NotificationService } from '../application/NotificationService.js';

import { TopBar } from './shared/TopBar.js';
import { Sidebar } from './shared/Sidebar.js';
import { Toast } from './shared/Toast.js';
import { Modal } from './shared/Modal.js';
import { ActivityPanel } from './shared/ActivityPanel.js';

class App {
    constructor() {
        this.world = null;
        this.dataSource = null;
        this.wsClient = null;
        this.agentManager = null;
        this.modeManager = null;
        this.sessionWatcher = null;
        this.notificationService = null;
        this.topBar = null;
        this.sidebar = null;
        this.toast = null;
        this.modal = null;
        this.renderer = null;
        this.dashboardRenderer = null;
        this.activityPanel = null;
    }

    async boot() {
        try {
            console.log('[App] ClaudeVille 부팅 시작...');

            // 1. 도메인 초기화
            this.world = new World();
            for (const def of BUILDING_DEFS) {
                this.world.addBuilding(new Building(def));
            }

            // 2. 인프라 초기화
            this.dataSource = new ClaudeDataSource();
            this.wsClient = new WebSocketClient();

            // 3. UI 컴포넌트 초기화
            this.toast = new Toast();
            this.modal = new Modal();
            this.topBar = new TopBar(this.world);
            this.sidebar = new Sidebar(this.world);

            // 4. 애플리케이션 서비스 초기화
            this.agentManager = new AgentManager(this.world, this.dataSource);
            this.modeManager = new ModeManager();
            this.notificationService = new NotificationService(this.toast);

            // 5. 초기 데이터 로드
            await this.agentManager.loadInitialData();

            // 6. 세션 감시 시작
            this.sessionWatcher = new SessionWatcher(
                this.agentManager, this.wsClient, this.dataSource
            );
            this.sessionWatcher.start();

            // 7. 캔버스 리사이즈 핸들링 (렌더러보다 먼저 실행해야 캔버스 크기가 설정됨)
            this._bindResize();

            // 8. 캐릭터 렌더러 동적 로드
            await this._loadRenderer();

            // 8-1. 대시보드 렌더러 로드
            await this._loadDashboard();

            // 9. 우측 실시간 활동 패널
            this.activityPanel = new ActivityPanel();
            this._bindAgentFollow();

            // 10. 설정 버튼
            this._bindSettings();

            // 11. 초기 i18n 적용
            this._applyI18n();

            console.log('[App] ClaudeVille 부팅 완료!');
        } catch (err) {
            console.error('[App] 부팅 실패:', err);
            this._showBootError(err);
        }
    }

    async _loadRenderer() {
        try {
            const module = await import('./character-mode/IsometricRenderer.js');
            const canvas = document.getElementById('worldCanvas');

            if (module.IsometricRenderer && canvas) {
                this.renderer = new module.IsometricRenderer(this.world);
                this.renderer.show(canvas);
                // 캔버스 크기가 확정된 후 카메라 중앙 재조정
                if (this.renderer.camera) {
                    this.renderer.camera.centerOnMap();
                }
                this.renderer.onAgentSelect = (agent) => {
                    if (agent) eventBus.emit('agent:selected', agent);
                };
                console.log('[App] IsometricRenderer 로드됨');
            }
        } catch (err) {
            console.warn('[App] IsometricRenderer 아직 없음 (canvas-artist 작업 대기중):', err.message);
        }
    }

    async _loadDashboard() {
        try {
            const module = await import('./dashboard-mode/DashboardRenderer.js');
            if (module.DashboardRenderer) {
                this.dashboardRenderer = new module.DashboardRenderer(this.world);
                console.log('[App] DashboardRenderer 로드됨');
            }
        } catch (err) {
            console.warn('[App] DashboardRenderer 로드 실패:', err.message);
        }
    }

    _bindAgentFollow() {
        // 에이전트 선택 시 카메라 팔로우
        eventBus.on('agent:selected', (agent) => {
            if (agent && this.renderer) {
                this.renderer.selectAgentById(agent.id);
            }
        });

        // 패널 닫기 시 팔로우 해제
        eventBus.on('agent:deselected', () => {
            if (this.renderer) {
                this.renderer.selectAgentById(null);
            }
        });
    }

    _bindResize() {
        const canvas = document.getElementById('worldCanvas');
        const container = canvas?.parentElement;
        if (!canvas || !container) return;

        const resize = () => {
            const w = container.clientWidth;
            const h = container.clientHeight;
            if (w === 0 || h === 0) return;
            if (canvas.width === w && canvas.height === h) return;
            canvas.width = w;
            canvas.height = h;
            if (this.renderer && this.renderer.camera) {
                this.renderer.camera.centerOnMap();
            }
        };

        // ResizeObserver로 컨테이너 크기 변화 감지 (푸터 열림/닫힘 포함)
        this._resizeObserver = new ResizeObserver(() => resize());
        this._resizeObserver.observe(container);

        window.addEventListener('resize', resize);
        resize();
    }

    _bindSettings() {
        const btn = document.getElementById('btnSettings');
        if (!btn) return;

        btn.addEventListener('click', () => {
            const currentLang = i18n.lang;
            this.modal.open(i18n.t('settingsTitle'), `
                <div class="settings-form">
                    <div class="settings-row">
                        <span class="settings-label">${i18n.t('language')}</span>
                        <div class="settings-lang-btns">
                            <button class="settings-lang-btn ${currentLang === 'ko' ? 'settings-lang-btn--active' : ''}" data-lang="ko">${i18n.t('langKo')}</button>
                            <button class="settings-lang-btn ${currentLang === 'en' ? 'settings-lang-btn--active' : ''}" data-lang="en">${i18n.t('langEn')}</button>
                        </div>
                    </div>
                </div>
            `);

            // 언어 버튼 클릭 이벤트
            document.querySelectorAll('.settings-lang-btn').forEach(langBtn => {
                langBtn.addEventListener('click', () => {
                    const newLang = langBtn.dataset.lang;
                    if (newLang === i18n.lang) return;
                    i18n.lang = newLang;
                    this._regenerateAgentNames();
                    this._applyI18n();
                    this.sidebar.render();
                    if (this.dashboardRenderer && this.dashboardRenderer.active) {
                        this.dashboardRenderer.render();
                    }
                    this.modal.close();
                    if (this.toast) {
                        this.toast.show(i18n.t('langChanged'), 'success');
                    }
                });
            });
        });
    }

    _applyI18n() {
        document.querySelectorAll('[data-i18n]').forEach(el => {
            const key = el.dataset.i18n;
            const val = i18n.t(key);
            if (typeof val === 'string') {
                el.textContent = val;
            }
        });
    }

    _regenerateAgentNames() {
        for (const agent of this.world.agents.values()) {
            // 팀에서 지정된 이름이 아닌 자동 생성 이름만 변경
            if (!agent._customName) {
                const hash = Appearance.hashCode(agent.id);
                agent.name = Agent.generateNameForLang(hash, i18n.lang);
            }
        }
    }

    _showBootError(err) {
        document.body.innerHTML = `
            <div style="display:flex;align-items:center;justify-content:center;height:100vh;
                        font-family:'Press Start 2P',monospace;color:#ef4444;font-size:10px;
                        flex-direction:column;gap:16px;background:#0a0a0f;">
                <div>BOOT FAILED</div>
                <div style="color:#8b8b9e;font-size:7px;">${err.message}</div>
                <div style="color:#8b8b9e;font-size:7px;">Check console for details</div>
            </div>
        `;
    }
}

// 부팅
window.addEventListener('load', () => {
    const app = new App();
    app.boot();
});
