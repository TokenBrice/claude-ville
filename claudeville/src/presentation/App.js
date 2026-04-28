import { World } from '../domain/entities/World.js';
import { Building } from '../domain/entities/Building.js';
import { BUILDING_DEFS } from '../config/buildings.js';
import { eventBus } from '../domain/events/DomainEvent.js';
import { i18n } from '../config/i18n.js';
import { Appearance } from '../domain/value-objects/Appearance.js';
import { Agent } from '../domain/entities/Agent.js';

import { ClaudeDataSource } from '../infrastructure/ClaudeDataSource.js';
import { WebSocketClient } from '../infrastructure/WebSocketClient.js';
import { ChronicleStore } from '../infrastructure/ChronicleStore.js';

import { AgentManager } from '../application/AgentManager.js';
import { ModeManager } from '../application/ModeManager.js';
import { SessionWatcher } from '../application/SessionWatcher.js';
import { NotificationService } from '../application/NotificationService.js';
import { Settings } from '../application/Settings.js';
import { AuroraGate } from '../application/AuroraGate.js';

import { TopBar } from './shared/TopBar.js';
import { Sidebar } from './shared/Sidebar.js';
import { Toast } from './shared/Toast.js';
import { Modal } from './shared/Modal.js';
import { ActivityPanel } from './shared/ActivityPanel.js';
import { el, replaceChildren } from './shared/DomSafe.js';

import { AssetManager } from './character-mode/AssetManager.js';
import { effectiveCanvasDpr } from './character-mode/CanvasBudget.js';

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
        this.chronicleStore = null;
        this.auroraGate = null;
        this.latestUsage = null;
        this._chroniclePruneInterval = null;
        this._resizeWorldCanvas = null;
        this._onWorldContextLost = null;
        this._onWorldContextRestored = null;
        this._onVisibilityChange = null;
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
            this.chronicleStore = new ChronicleStore();
            this.auroraGate = new AuroraGate({ store: this.chronicleStore });
            this.chronicleStore.open()
                .then(() => {
                    window.__chronicle = this.chronicleStore;
                    return this.chronicleStore.prune();
                })
                .catch((err) => console.warn('[App] ChronicleStore unavailable:', err.message));
            this._chroniclePruneInterval = window.setInterval(() => {
                this.chronicleStore?.prune?.().catch((err) => {
                    console.warn('[App] ChronicleStore prune failed:', err.message);
                });
            }, 5 * 60 * 1000);

            // 3. Initialize UI components
            this.toast = new Toast();
            this.modal = new Modal();
            this.topBar = new TopBar(this.world);
            this.sidebar = new Sidebar(this.world);

            // 4. Initialize application services
            this.agentManager = new AgentManager(this.world, this.dataSource);
            this.modeManager = new ModeManager();
            this.notificationService = new NotificationService(this.toast);
            this._bindChronicleSignals();

            // 5. Load initial data
            await this.agentManager.loadInitialData();

            // 5-1. Load initial usage data
            this.dataSource.getUsage().then(usage => {
                if (usage) {
                    this.latestUsage = usage;
                    eventBus.emit('usage:updated', usage);
                }
            });

            // 6. Start session watching
            this.sessionWatcher = new SessionWatcher(
                this.agentManager, this.wsClient, this.dataSource
            );
            this.sessionWatcher.start();

            // 7. Handle canvas resizing (run before the renderer so the canvas size is set)
            this._bindResize();

            // 8. Preload sprite assets, then dynamically load character renderer
            this.assets = new AssetManager();
            await this.assets.load();
            console.log('[App] sprite assets loaded');
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

            if (!module.IsometricRenderer) {
                throw new Error('IsometricRenderer module missing export');
            }

            if (!canvas) {
                if (!this._loadRendererRetryScheduled) {
                    this._loadRendererRetryScheduled = true;
                    requestAnimationFrame(() => {
                        this._loadRendererRetryScheduled = false;
                        void this._loadRenderer();
                    });
                }
                console.warn('[App] worldCanvas not found yet (retrying render mount)');
                return;
            }

            if (this.renderer) {
                // Avoid duplicated subscriptions/render loops if boot/refresh is retried.
                this.renderer.hide();
            }

            this.renderer = new module.IsometricRenderer(this.world, {
                assets: this.assets,
                chronicleStore: this.chronicleStore,
                modal: this.modal,
            });
            this.renderer.show(canvas);
            if (this.latestUsage) this.renderer.setQuotaState?.(this.latestUsage);
            this._installPerfDebugHelper();

            requestAnimationFrame(() => {
                if (this.renderer && this.renderer.camera) {
                    this.renderer.camera.centerOnMap();
                }
            });

            this.renderer.onAgentSelect = (agent) => {
                if (agent) eventBus.emit('agent:selected', agent);
            };

            console.log('[App] IsometricRenderer loaded');
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

    _bindChronicleSignals() {
        eventBus.on('chronicle:milestone', (monument) => {
            this.auroraGate?.recordMilestone(monument);
            this.auroraGate?.evaluate(Date.now(), {
                release: monument?.kind === 'release',
                majorVerified: monument?.kind === 'verified' && monument?.weight === 'major',
            }).then((result) => {
                if (result === 'fire') {
                    eventBus.emit('chronicle:aurora', { ts: Date.now(), reason: monument?.kind || 'milestone' });
                }
            }).catch(() => {});
        });

        eventBus.on('usage:updated', (usage) => {
            this.latestUsage = usage;
            this.renderer?.setQuotaState?.(usage);
            this.auroraGate?.handleUsageUpdate(usage).then((result) => {
                if (result === 'fire') {
                    eventBus.emit('chronicle:aurora', { ts: Date.now(), reason: 'quota-rollover' });
                }
            }).catch(() => {});
        });

        eventBus.on('chronicle:aurora', () => {
            this.renderer?.skyRenderer?.triggerAurora?.();
        });
    }

    _bindResize() {
        const canvas = document.getElementById('worldCanvas');
        const container = canvas?.parentElement;
        if (!canvas || !container) return;
        if (this._resizeHandle) {
            cancelAnimationFrame(this._resizeHandle);
            this._resizeHandle = null;
        }

        const resize = ({ force = false } = {}) => {
            const w = container.clientWidth;
            const h = container.clientHeight;

            if (w === 0 || h === 0) {
                if (!this._resizeHandle && this.modeManager?.getCurrentMode() !== 'dashboard') {
                    this._resizeHandle = requestAnimationFrame(() => {
                        this._resizeHandle = null;
                        resize();
                    });
                }
                return;
            }

            this._resizeHandle = null;

            const cssWidth = Math.round(w);
            const cssHeight = Math.round(h);
            const dpr = effectiveCanvasDpr(cssWidth, cssHeight, window.devicePixelRatio || 1);
            const newW = Math.round(cssWidth * dpr);
            const newH = Math.round(cssHeight * dpr);
            if (
                !force &&
                canvas.width === newW &&
                canvas.height === newH &&
                canvas._claudeVilleDpr === dpr
            ) return;
            canvas.width = newW;
            canvas.height = newH;
            canvas._claudeVilleDpr = dpr;
            canvas._claudeVilleCssWidth = cssWidth;
            canvas._claudeVilleCssHeight = cssHeight;
            canvas.style.width = `${cssWidth}px`;
            canvas.style.height = `${cssHeight}px`;
            const ctx = canvas.getContext('2d');
            ctx.imageSmoothingEnabled = false;
            ctx.mozImageSmoothingEnabled = false;
            ctx.webkitImageSmoothingEnabled = false;
            if (this.renderer?.invalidateViewportCaches) {
                this.renderer.invalidateViewportCaches();
            }
            if (this.renderer && this.renderer.camera) {
                this.renderer.camera.onViewportResize();
            }
        };

        // Use ResizeObserver to detect container size changes (including footer open/close)
        this._resizeObserver = new ResizeObserver(() => resize());
        this._resizeObserver.observe(container);

        window.addEventListener('resize', () => resize());
        this._resizeWorldCanvas = resize;
        this._bindGraphicsRecovery(canvas, resize);
        resize();
    }

    _bindGraphicsRecovery(canvas, resize) {
        if (this._onWorldContextLost) {
            canvas.removeEventListener('contextlost', this._onWorldContextLost);
            canvas.removeEventListener('contextrestored', this._onWorldContextRestored);
        }
        this._onWorldContextLost = (event) => {
            event.preventDefault?.();
            this.renderer?.handleContextLost?.();
        };
        this._onWorldContextRestored = () => {
            resize({ force: true });
            this.renderer?.handleContextRestored?.();
        };
        canvas.addEventListener('contextlost', this._onWorldContextLost, false);
        canvas.addEventListener('contextrestored', this._onWorldContextRestored, false);

        if (this._onVisibilityChange) {
            document.removeEventListener('visibilitychange', this._onVisibilityChange);
        }
        this._onVisibilityChange = () => {
            if (document.visibilityState === 'hidden') {
                this.renderer?.pauseForVisibility?.();
                return;
            }
            resize({ force: true });
            const worldVisible = this.modeManager?.getCurrentMode?.() !== 'dashboard';
            this.renderer?.resumeFromVisibility?.({ active: worldVisible });
        };
        document.addEventListener('visibilitychange', this._onVisibilityChange);
    }

    _installPerfDebugHelper() {
        if (typeof window === 'undefined') return;
        const existing = window.__claudeVillePerf || {};
        window.__claudeVillePerf = {
            ...existing,
            canvasBudget: () => this.renderer?.getCanvasBudget?.() || null,
        };
    }

    _bindSettings() {
        const btn = document.getElementById('btnSettings');
        if (!btn) return;

        btn.addEventListener('click', () => {
            const currentLang = i18n.lang;
            const privacyRedaction = Settings.privacyRedaction;
            this.modal.open(i18n.t('settingsTitle'), `
                <div class="settings-form">
                    <div class="settings-row">
                        <span class="settings-label">${i18n.t('language')}</span>
                        <div class="settings-lang-btns">
                            <button class="settings-lang-btn ${currentLang === 'ko' ? 'settings-lang-btn--active' : ''}" data-lang="ko">${i18n.t('langKo')}</button>
                            <button class="settings-lang-btn ${currentLang === 'en' ? 'settings-lang-btn--active' : ''}" data-lang="en">${i18n.t('langEn')}</button>
                        </div>
                    </div>
                    <label class="settings-row settings-row--toggle">
                        <span class="settings-label">Privacy redaction</span>
                        <input id="settingPrivacyRedaction" class="settings-toggle" type="checkbox" ${privacyRedaction ? 'checked' : ''}>
                    </label>
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

            const privacyInput = document.getElementById('settingPrivacyRedaction');
            privacyInput?.addEventListener('change', () => {
                Settings.privacyRedaction = privacyInput.checked;
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
        replaceChildren(document.body, [
            el('div', {
                style: {
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    height: '100vh',
                    fontFamily: "'Press Start 2P',monospace",
                    color: '#ef4444',
                    fontSize: '10px',
                    flexDirection: 'column',
                    gap: '16px',
                    background: '#0a0a0f',
                },
            }, [
                el('div', { text: 'BOOT FAILED' }),
                el('div', {
                    text: err?.message || 'Unknown boot error',
                    style: { color: '#8b8b9e', fontSize: '7px' },
                }),
                el('div', {
                    text: 'Check console for details',
                    style: { color: '#8b8b9e', fontSize: '7px' },
                }),
            ]),
        ]);
    }
}

// Boot
window.addEventListener('load', () => {
    const app = new App();
    app.boot();
});
