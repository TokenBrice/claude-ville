import { World } from '../domain/entities/World.js';
import { Building } from '../domain/entities/Building.js';
import { BUILDING_DEFS } from '../config/buildings.js';
import { eventBus } from '../domain/events/DomainEvent.js';
import { i18n } from '../config/i18n.js';
import { STATUS_VISUALS, STATUS_CSS_VARS } from '../config/theme.js';

import { ClaudeDataSource } from '../infrastructure/ClaudeDataSource.js';
import { WebSocketClient } from '../infrastructure/WebSocketClient.js';
import { ChronicleStore } from '../infrastructure/ChronicleStore.js';

import { AgentManager } from '../application/AgentManager.js';
import { ModeManager } from '../application/ModeManager.js';
import { SessionWatcher } from '../application/SessionWatcher.js';
import { NotificationService } from '../application/NotificationService.js';
import { AuroraGate } from '../application/AuroraGate.js';
import { AgentBiographyService } from '../application/AgentBiographyService.js';
import { MoodService } from '../application/MoodService.js';
import { RelationshipAffinityService } from '../application/RelationshipAffinityService.js';

import { TopBar } from './shared/TopBar.js';
import { Sidebar } from './shared/Sidebar.js';
import { Toast } from './shared/Toast.js';
import { Modal } from './shared/Modal.js';
import { ActivityPanel } from './shared/ActivityPanel.js';
import { el, replaceChildren } from './shared/DomSafe.js';
import { emitAgentSelected, resetAgentSelection } from './shared/AgentSelection.js';
import { sessionDetailsService } from './shared/SessionDetailsService.js';

import { AssetManager } from './character-mode/AssetManager.js';
import { effectiveCanvasDpr } from './character-mode/CanvasBudget.js';

const LIFECYCLE_DRAIN_TIMEOUT_MS = 2000;

export class App {
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
        this.assets = null;
        this.chronicleStore = null;
        this.auroraGate = null;
        this.biographyService = null;
        this.moodService = null;
        this.affinityService = null;
        this.agentSimulator = null;
        this.simMode = false;
        this.latestUsage = null;
        this._chroniclePruneInterval = null;
        this._chroniclePruneState = { promise: null };
        this._chronicleTasks = new Set();
        this._resizeWorldCanvas = null;
        this._resizeObserver = null;
        this._resizeHandle = null;
        this._loadRendererRetryHandle = null;
        this._loadRendererRetryScheduled = false;
        this._centerCameraHandle = null;
        this._onWindowResize = null;
        this._perfDebugCanvasBudget = null;
        this._cameraSetHelper = null;
        this._onWorldContextLost = null;
        this._onWorldContextRestored = null;
        this._onVisibilityChange = null;
        this._worldCanvas = null;
        this._eventUnsubscribers = [];
        this._onPageHide = null;
        this._bootPromise = null;
        this._bootController = null;
        this._destroyPromise = null;
        this._cleanupPromise = null;
        this._bootState = 'idle';
        this._destroyed = false;
    }

    boot() {
        if (this._bootPromise) return this._bootPromise;
        if (this._bootState !== 'idle') return Promise.resolve(null);
        this._destroyed = false;
        this._bootState = 'booting';
        this._bootController = new AbortController();
        this._bindPageExit();
        this._bootPromise = this._bootOnce();
        return this._bootPromise;
    }

    async _bootOnce() {
        try {
            console.log('[App] ClaudeVille boot started...');

            // 0. Stamp --cv-status-* from STATUS_VISUALS so CSS and canvas can
            // never fork (plan 1.1); reset.css holds identical fallbacks.
            this._stampStatusCssVars();

            // 1. Initialize domain
            this.world = new World();
            for (const def of BUILDING_DEFS) {
                this.world.addBuilding(new Building(def));
            }

            // 2. Initialize infrastructure
            this.dataSource = new ClaudeDataSource();
            this.wsClient = new WebSocketClient();
            this.chronicleStore = new ChronicleStore();
            const initialStore = this.chronicleStore;
            this._trackChronicleTask(this._runChroniclePrune().then(() => {
                if (!initialStore._closed) window.__chronicle = initialStore;
            }).catch((err) => {
                console.warn('[App] ChronicleStore unavailable:', err.message);
            }));
            // 2.1 / 2.4 — persistent biography and pair-affinity accumulation
            // (ChronicleStore-backed); both listen on agent:* domain events.
            this.biographyService = new AgentBiographyService({ store: this.chronicleStore }).start();
            this.affinityService = new RelationshipAffinityService({ store: this.chronicleStore }).start();
            this.auroraGate = new AuroraGate({ store: this.chronicleStore });
            this._chroniclePruneInterval = window.setInterval(() => {
                this._runChroniclePrune().catch((err) => {
                    console.warn('[App] ChronicleStore prune failed:', err.message);
                });
            }, 5 * 60 * 1000);

            // 3. Initialize UI components
            this.toast = new Toast();
            this.modal = new Modal();
            this.topBar = new TopBar(this.world, { modal: this.modal });
            this.sidebar = new Sidebar(this.world);

            // 4. Initialize application services
            this.agentManager = new AgentManager(this.world, this.dataSource);
            this.agentManager.setUsageGetter(() => this.latestUsage);
            this.modeManager = new ModeManager();
            this.notificationService = new NotificationService(this.toast);
            // 2.2 — telemetry → mood mapping; keeps Agent.mood current and
            // aggregates the village weather influence read by World mode.
            this.moodService = new MoodService().start();
            this._bindChronicleSignals();

            // 4-1. Behavior simulator (?sim=1, dev only — overrides session ingestion)
            const simMode = new URLSearchParams(location.search).get('sim') === '1';
            this.simMode = simMode;
            if (simMode) {
                const mod = await import('./character-mode/__simfixture__/AgentSimulator.js');
                if (this._destroyed) return null;
                this.agentSimulator = new mod.default({ world: this.world, agentManager: this.agentManager, eventBus });
                this.agentSimulator.start();
            }

            // 5. Load initial data
            if (!simMode) await this.agentManager.loadInitialData({ signal: this._bootController?.signal });
            if (this._destroyed) return null;

            // 5-1. Load initial usage data
            this.dataSource.getUsage({ signal: this._bootController?.signal }).then(usage => {
                if (this._destroyed) return;
                if (usage) {
                    this.latestUsage = usage;
                    eventBus.emit('usage:updated', usage);
                }
            });

            // 6. Start session watching (skipped in sim mode)
            if (!simMode) {
                this.sessionWatcher = new SessionWatcher(
                    this.agentManager, this.wsClient, this.dataSource
                );
                this.sessionWatcher.start();
            }

            // 7. Handle canvas resizing (run before the renderer so the canvas size is set)
            this._bindResize();

            // 8. Preload sprite assets, then dynamically load character renderer
            this.assets = new AssetManager();
            await this.assets.load({ signal: this._bootController?.signal });
            if (this._destroyed) return null;
            console.log('[App] sprite assets loaded');
            await this._loadRenderer();
            if (this._destroyed) return null;

            // 8-1. Load dashboard renderer
            await this._loadDashboard();
            if (this._destroyed) return null;

            // 9. right-side live activity panel
            this.activityPanel = new ActivityPanel({
                world: () => this.world,
                renderer: () => this.renderer,
                harborTraffic: () => this.renderer?.harborTraffic || null,
                biographyService: () => this.biographyService,
                affinityService: () => this.affinityService,
            });
            this._bindAgentFollow();
            this._bindDeepLink();
            if (this.renderer?.selectedAgent) {
                emitAgentSelected(this.renderer.selectedAgent);
            }
            this._applyDeepLink();

            // 10. Apply initial i18n
            this._applyI18n();

            if (this._destroyed) return null;
            this._bootState = 'ready';
            console.log('[App] ClaudeVille boot complete!');
            return this;
        } catch (err) {
            if (this._destroyed) {
                await this._cleanupOwned();
                return null;
            }
            console.error('[App] boot failed:', err);
            this._destroyed = true;
            await this._cleanupOwned();
            this._bootState = 'failed';
            this._showBootError(err);
            return null;
        }
    }

    _stampStatusCssVars() {
        const rootStyle = document.documentElement?.style;
        if (!rootStyle) return;
        for (const [status, varName] of Object.entries(STATUS_CSS_VARS)) {
            const color = STATUS_VISUALS[status]?.color;
            if (color) rootStyle.setProperty(varName, color);
        }
    }

    _bindPageExit() {
        if (this._onPageHide) return;
        this._onPageHide = (event) => {
            if (!event.persisted) void this.destroy();
        };
        window.addEventListener('pagehide', this._onPageHide);
    }

    _runChroniclePrune() {
        if (!this.chronicleStore) return Promise.resolve(null);
        const state = this._chroniclePruneState;
        if (state.promise) return state.promise;
        const store = this.chronicleStore;
        const prunePromise = store.open()
            .then(() => store.prune())
            .finally(() => {
                if (state.promise === prunePromise) state.promise = null;
            });
        state.promise = prunePromise;
        return prunePromise;
    }

    async _loadRenderer() {
        let candidate = null;
        try {
            if (this._destroyed) return;
            const module = await import('./character-mode/IsometricRenderer.js');
            if (this._destroyed) return;
            const canvas = document.getElementById('worldCanvas');

            if (!module.IsometricRenderer) {
                throw new Error('IsometricRenderer module missing export');
            }

            if (!canvas) {
                if (!this._loadRendererRetryScheduled) {
                    this._loadRendererRetryScheduled = true;
                    this._loadRendererRetryHandle = requestAnimationFrame(() => {
                        this._loadRendererRetryHandle = null;
                        this._loadRendererRetryScheduled = false;
                        if (this._destroyed) return;
                        void this._loadRenderer();
                    });
                }
                console.warn('[App] worldCanvas not found yet (retrying render mount)');
                return;
            }

            candidate = new module.IsometricRenderer(this.world, {
                assets: this.assets,
                chronicleStore: this.chronicleStore,
                modal: this.modal,
                moodService: this.moodService,
                biographyService: this.biographyService,
                affinityService: this.affinityService,
            });
            if (candidate.show(canvas) === false) {
                throw new Error('IsometricRenderer failed to mount');
            }
            if (this.latestUsage) candidate.setQuotaState?.(this.latestUsage);

            candidate.onAgentSelect = (agent) => {
                emitAgentSelected(agent);
            };

            const scenarioMetadata = this.agentSimulator?.getScenario?.()?.metadata || null;
            const scenarioApplied = candidate.applyScenarioMetadata?.(scenarioMetadata) || false;
            if (this._destroyed) {
                candidate.hide?.();
                return;
            }
            const previous = this.renderer;
            this.renderer = candidate;
            previous?.hide?.();
            this._installPerfDebugHelper();
            if (!scenarioApplied || !scenarioMetadata?.camera) {
                this._centerCameraHandle = requestAnimationFrame(() => {
                    this._centerCameraHandle = null;
                    if (this.renderer === candidate && candidate.camera) {
                        if (typeof candidate.frameContent === 'function') {
                            candidate.frameContent();
                        } else {
                            candidate.camera.centerOnMap();
                        }
                    }
                });
            }

            console.log('[App] IsometricRenderer loaded');
        } catch (err) {
            candidate?.hide?.();
            if (this.renderer === candidate) this.renderer = null;
            console.warn('[App] IsometricRenderer not available yet (waiting on canvas-artist work):', err.message);
        }
    }

    async _loadDashboard() {
        let candidate = null;
        try {
            if (this._destroyed) return;
            const module = await import('./dashboard-mode/DashboardRenderer.js');
            if (this._destroyed) return;
            if (module.DashboardRenderer) {
                candidate = new module.DashboardRenderer(this.world, { toast: this.toast });
                if (this._destroyed) {
                    candidate.destroy?.();
                    return;
                }
                this.dashboardRenderer?.destroy?.();
                this.dashboardRenderer = candidate;
                console.log('[App] DashboardRenderer loaded');
            }
        } catch (err) {
            candidate?.destroy?.();
            if (this.dashboardRenderer === candidate) this.dashboardRenderer = null;
            console.warn('[App] DashboardRenderer failed to load:', err.message);
        }
    }

    _bindAgentFollow() {
        // Follow the camera when an agent is selected
        this._eventUnsubscribers.push(eventBus.on('agent:selected', (agent) => {
            if (agent && this.renderer) {
                this.renderer.selectAgentById(agent.id);
            }
        }));

        // Stop following when the panel closes
        this._eventUnsubscribers.push(eventBus.on('agent:deselected', () => {
            if (this.renderer) {
                this.renderer.selectAgentById(null);
            }
        }));
    }

    _bindDeepLink() {
        // Mirror the current agent selection into the URL fragment so links
        // like /#agent=<id> can be shared.
        this._eventUnsubscribers.push(eventBus.on('agent:selected', (agent) => {
            if (!agent?.id) return;
            history.replaceState(null, '', `#agent=${encodeURIComponent(agent.id)}`);
        }));
        this._eventUnsubscribers.push(eventBus.on('agent:deselected', () => {
            if (location.hash.startsWith('#agent=')) {
                history.replaceState(null, '', location.pathname + location.search);
            }
        }));
    }

    _applyDeepLink() {
        const match = /^#agent=(.+)$/.exec(location.hash);
        if (!match) return;
        let agentId;
        try {
            agentId = decodeURIComponent(match[1]);
        } catch {
            return;
        }
        const agent = this.world?.agents?.get?.(agentId);
        if (agent) emitAgentSelected(agent);
    }

    _bindChronicleSignals() {
        this._eventUnsubscribers.push(eventBus.on('chronicle:milestone', (monument) => {
            this.auroraGate?.recordMilestone(monument);
            this._trackChronicleTask(this.auroraGate?.evaluate(Date.now(), {
                release: monument?.kind === 'release',
                majorVerified: monument?.kind === 'verified' && monument?.weight === 'major',
            }).then((result) => {
                if (result === 'fire') {
                    eventBus.emit('chronicle:aurora', { ts: Date.now(), reason: monument?.kind || 'milestone' });
                }
            }).catch(() => {}));
        }));

        this._eventUnsubscribers.push(eventBus.on('usage:updated', (usage) => {
            this.latestUsage = usage;
            this.renderer?.setQuotaState?.(usage);
            const fiveHour = Number(usage?.quota?.fiveHour);
            if (Number.isFinite(fiveHour) && fiveHour > 0.85) {
                eventBus.emit('quota:throttled', { fiveHour, ts: Date.now() });
            }
            this._trackChronicleTask(this.auroraGate?.handleUsageUpdate(usage).then((result) => {
                if (result === 'fire') {
                    eventBus.emit('chronicle:aurora', { ts: Date.now(), reason: 'quota-rollover' });
                }
            }).catch(() => {}));
        }));

        this._eventUnsubscribers.push(eventBus.on('chronicle:aurora', () => {
            this.renderer?.skyRenderer?.triggerAurora?.();
        }));
    }

    _trackChronicleTask(task) {
        if (!task || typeof task.finally !== 'function') return task;
        const tasks = this._chronicleTasks;
        tasks.add(task);
        task.then(
            () => tasks.delete(task),
            () => tasks.delete(task),
        );
        return task;
    }

    _bindResize() {
        const canvas = document.getElementById('worldCanvas');
        const container = canvas?.parentElement;
        if (!canvas || !container) return;
        this._worldCanvas = canvas;
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
                        if (this._destroyed) return;
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
                const cam = this.renderer.camera;
                cam.onViewportResize();
                // Re-frame to the live village on relayout, unless the user has
                // taken manual control of the camera or is following an agent.
                if (!cam._userAdjusted && !cam.followTarget && typeof this.renderer.frameContent === 'function') {
                    this.renderer.frameContent();
                }
            }
        };

        // Use ResizeObserver to detect container size changes (including footer open/close)
        this._resizeObserver = new ResizeObserver(() => resize());
        this._resizeObserver.observe(container);

        this._onWindowResize = () => resize();
        window.addEventListener('resize', this._onWindowResize);
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
        this._perfDebugCanvasBudget = () => this.renderer?.getCanvasBudget?.() || null;
        this._cameraSetHelper = (pose = {}) => this.renderer?.setCameraPose?.(pose) || false;
        window.__claudeVillePerf = {
            ...existing,
            canvasBudget: this._perfDebugCanvasBudget,
        };
        window.cameraSet = this._cameraSetHelper;
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

    destroy() {
        if (this._destroyPromise) return this._destroyPromise;
        this._destroyed = true;
        this._destroyPromise = (async () => {
            await this._cleanupOwned();
            if (this._bootState !== 'failed') this._bootState = 'destroyed';
        })();
        return this._destroyPromise;
    }

    _cleanupOwned() {
        if (this._cleanupPromise) return this._cleanupPromise;
        this._cleanupPromise = this._cleanupOwnedOnce();
        return this._cleanupPromise;
    }

    async _cleanupOwnedOnce() {
        const renderer = this.renderer;
        const store = this.chronicleStore;
        const worldCanvas = this._worldCanvas || document.getElementById('worldCanvas');

        this._bootController?.abort?.();

        if (this._chroniclePruneInterval) {
            window.clearInterval(this._chroniclePruneInterval);
            this._chroniclePruneInterval = null;
        }
        if (this._resizeHandle) {
            cancelAnimationFrame(this._resizeHandle);
            this._resizeHandle = null;
        }
        if (this._loadRendererRetryHandle) {
            cancelAnimationFrame(this._loadRendererRetryHandle);
            this._loadRendererRetryHandle = null;
        }
        this._loadRendererRetryScheduled = false;
        if (this._centerCameraHandle) {
            cancelAnimationFrame(this._centerCameraHandle);
            this._centerCameraHandle = null;
        }

        for (const unsubscribe of this._eventUnsubscribers.splice(0)) {
            unsubscribe?.();
        }
        resetAgentSelection();

        if (this._onWindowResize) {
            window.removeEventListener('resize', this._onWindowResize);
            this._onWindowResize = null;
        }
        this._resizeObserver?.disconnect?.();
        this._resizeObserver = null;

        if (this._worldCanvas && this._onWorldContextLost) {
            this._worldCanvas.removeEventListener('contextlost', this._onWorldContextLost);
            this._worldCanvas.removeEventListener('contextrestored', this._onWorldContextRestored);
        }
        this._onWorldContextLost = null;
        this._onWorldContextRestored = null;
        this._worldCanvas = null;

        if (this._onVisibilityChange) {
            document.removeEventListener('visibilitychange', this._onVisibilityChange);
            this._onVisibilityChange = null;
        }

        if (this._onPageHide) {
            window.removeEventListener('pagehide', this._onPageHide);
            this._onPageHide = null;
        }

        this._callLifecycle('SessionWatcher.stop', () => this.sessionWatcher?.stop?.());
        this._callLifecycle('AgentSimulator.stop', () => this.agentSimulator?.stop?.());
        this._callLifecycle('NotificationService.destroy', () => this.notificationService?.destroy?.());
        this._callLifecycle('ActivityPanel.destroy', () => this.activityPanel?.destroy?.());
        this._callLifecycle('DashboardRenderer.destroy', () => this.dashboardRenderer?.destroy?.());
        this._callLifecycle('SessionDetailsService.clear', () => sessionDetailsService.clear());
        this._callLifecycle('ModeManager.destroy', () => this.modeManager?.destroy?.());
        this._callLifecycle('Sidebar.destroy', () => this.sidebar?.destroy?.());
        const topBarStop = this._callLifecycle('TopBar.destroy', () => this.topBar?.destroy?.());
        this._callLifecycle('Modal.destroy', () => this.modal?.destroy?.());
        this._callLifecycle('Toast.destroy', () => this.toast?.destroy?.());
        this._callLifecycle('MoodService.stop', () => this.moodService?.stop?.());

        const biographyStop = this._callLifecycle(
            'AgentBiographyService.stop',
            () => this.biographyService?.stop?.(),
        );
        const affinityStop = this._callLifecycle(
            'RelationshipAffinityService.stop',
            () => this.affinityService?.stop?.(),
        );
        const prune = this._chroniclePruneState.promise;
        const chronicleTasks = [...this._chronicleTasks];

        this._callLifecycle('IsometricRenderer.pauseForVisibility', () => renderer?.pauseForVisibility?.());
        const chronicleDrain = this._callLifecycle(
            'IsometricRenderer.drainChronicleUpdates',
            () => renderer?.drainChronicleUpdates?.(),
        );
        const trail = renderer?.trailRenderer || null;
        const trailDrain = this._callLifecycle('TrailRenderer.dispose', () => {
            if (typeof trail?.dispose === 'function') return trail.dispose();
            if (typeof trail?.drain === 'function') return trail.drain();
            return trail?.flush?.();
        });
        await this._settleLifecycleTasks([chronicleDrain, trailDrain]);
        this._callLifecycle('IsometricRenderer.hide', () => renderer?.hide?.());
        if (worldCanvas) {
            worldCanvas.width = 0;
            worldCanvas.height = 0;
        }
        const assetsDispose = this._callLifecycle('AssetManager.dispose', () => this.assets?.dispose?.());

        const storeTasks = [
            biographyStop,
            affinityStop,
            prune,
            ...chronicleTasks,
        ].filter(task => task && typeof task.then === 'function');
        await this._settleLifecycleTasks(storeTasks);
        await this._settleLifecycleTasks([topBarStop, assetsDispose]);
        this._callLifecycle('ChronicleStore.close', () => store?.close?.());

        if (typeof window !== 'undefined') {
            if (window.__chronicle === store) delete window.__chronicle;
            if (window.__claudeVilleApp === this) delete window.__claudeVilleApp;
            if (window.cameraSet === this._cameraSetHelper) delete window.cameraSet;
            if (window.__claudeVillePerf?.canvasBudget === this._perfDebugCanvasBudget) {
                delete window.__claudeVillePerf.canvasBudget;
            }
        }

        this.renderer = null;
        this.dashboardRenderer = null;
        this.activityPanel = null;
        this.assets = null;
        this.sessionWatcher = null;
        this.agentSimulator = null;
        this.notificationService = null;
        this.modeManager = null;
        this.sidebar = null;
        this.topBar = null;
        this.modal = null;
        this.toast = null;
        this.chronicleStore = null;
        this.auroraGate = null;
        this.biographyService = null;
        this.moodService = null;
        this.affinityService = null;
        this.agentManager = null;
        this.wsClient = null;
        this.dataSource = null;
        this.world = null;
        this.latestUsage = null;
        this._chroniclePruneState.promise = null;
        this._chronicleTasks.clear();
        this._perfDebugCanvasBudget = null;
        this._cameraSetHelper = null;
        this._resizeWorldCanvas = null;
        this._bootController = null;
    }

    _callLifecycle(label, callback) {
        try {
            return callback();
        } catch (err) {
            console.warn(`[App] ${label} failed:`, err?.message || err);
            return null;
        }
    }

    async _settleLifecycleTasks(tasks, timeoutMs = LIFECYCLE_DRAIN_TIMEOUT_MS) {
        const pending = tasks.filter(task => task && typeof task.then === 'function');
        if (!pending.length) return;
        let timeoutHandle = null;
        await Promise.race([
            Promise.allSettled(pending),
            new Promise(resolve => {
                timeoutHandle = window.setTimeout(resolve, timeoutMs);
            }),
        ]);
        if (timeoutHandle !== null) window.clearTimeout(timeoutHandle);
    }
}

// Boot
window.addEventListener('load', () => {
    const app = new App();
    window.__claudeVilleApp = app;
    app.boot();
});
