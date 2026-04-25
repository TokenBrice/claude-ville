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
            console.log('[App] ClaudeVille boot started...');

            // 1. Initialize domain
            this.world = new World();
            for (const def of BUILDING_DEFS) {
                this.world.addBuilding(new Building(def));
            }

            // 2. Initialize infrastructure
            this.dataSource = new ClaudeDataSource();
            this.wsClient = new WebSocketClient();

            // 3. Initialize UI components
            this.toast = new Toast();
            this.modal = new Modal();
            this.topBar = new TopBar(this.world);
            this.sidebar = new Sidebar(this.world);

            // 4. Initialize application services
            this.agentManager = new AgentManager(this.world, this.dataSource);
            this.modeManager = new ModeManager();
            this.notificationService = new NotificationService(this.toast);

            // 5. Load initial data
            await this.agentManager.loadInitialData();

            // 5-1. Load initial usage data
            this.dataSource.getUsage().then(usage => {
                if (usage) eventBus.emit('usage:updated', usage);
            });

            // 6. Start session watching
            this.sessionWatcher = new SessionWatcher(
                this.agentManager, this.wsClient, this.dataSource
            );
            this.sessionWatcher.start();

            // 7. Handle canvas resizing (run before the renderer so the canvas size is set)
            this._bindResize();

            // 8. Dynamically load character renderer
            await this._loadRenderer();

            // 8-1. Load dashboard renderer
            await this._loadDashboard();

            // 9. right-side live activity panel
            this.activityPanel = new ActivityPanel();
            this._bindAgentFollow();

            // 10. Settings button
            this._bindSettings();

            // 11. Apply initial i18n
            this._applyI18n();

            console.log('[App] ClaudeVille boot complete!');
        } catch (err) {
            console.error('[App] boot failed:', err);
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
                // Recenter the camera after the canvas size is set
                if (this.renderer.camera) {
                    this.renderer.camera.centerOnMap();
                }
                this.renderer.onAgentSelect = (agent) => {
                    if (agent) eventBus.emit('agent:selected', agent);
                };
                console.log('[App] IsometricRenderer loaded');
            }
        } catch (err) {
            console.warn('[App] IsometricRenderer not available yet (waiting on canvas-artist work):', err.message);
        }
    }

    async _loadDashboard() {
        try {
            const module = await import('./dashboard-mode/DashboardRenderer.js');
            if (module.DashboardRenderer) {
                this.dashboardRenderer = new module.DashboardRenderer(this.world);
                console.log('[App] DashboardRenderer loaded');
            }
        } catch (err) {
            console.warn('[App] DashboardRenderer failed to load:', err.message);
        }
    }

    _bindAgentFollow() {
        // Follow the camera when an agent is selected
        eventBus.on('agent:selected', (agent) => {
            if (agent && this.renderer) {
                this.renderer.selectAgentById(agent.id);
            }
        });

        // Stop following when the panel closes
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

        // Use ResizeObserver to detect container size changes (including footer open/close)
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

            // Language button click event
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
            // Only change generated names, not names assigned by a team
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

// Boot
window.addEventListener('load', () => {
    const app = new App();
    app.boot();
});
