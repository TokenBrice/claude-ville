import { eventBus } from '../domain/events/DomainEvent.js';
import { REFRESH_INTERVAL } from '../config/constants.js';

const POLL_TIMEOUT_MS = Math.max(5000, REFRESH_INTERVAL * 2);

export class SessionWatcher {
    constructor(agentManager, wsClient, dataSource) {
        this.agentManager = agentManager;
        this.wsClient = wsClient;
        this.dataSource = dataSource;
        this.pollTimer = null;
        this.running = false;
        this._pollController = null;
        this._pollPromise = null;
        this._pollGeneration = 0;

        this._onWsInit = (data) => this.agentManager.handleWebSocketMessage(data);
        this._onWsUpdate = (data) => this.agentManager.handleWebSocketMessage(data);
        this._onWsDisconnected = () => this._startPolling();
        this._onWsConnected = () => this._stopPolling();
    }

    start() {
        if (this.running) return;
        this.running = true;

        // Subscribe to WebSocket events
        eventBus.on('ws:init', this._onWsInit);
        eventBus.on('ws:update', this._onWsUpdate);
        eventBus.on('ws:disconnected', this._onWsDisconnected);
        eventBus.on('ws:connected', this._onWsConnected);

        // Connect WebSocket
        this.wsClient.connect();

        // Start fallback polling too (until the WebSocket connects)
        if (!this.wsClient.isConnected) {
            this._startPolling();
        }
    }

    stop() {
        this.running = false;
        this._stopPolling();

        eventBus.off('ws:init', this._onWsInit);
        eventBus.off('ws:update', this._onWsUpdate);
        eventBus.off('ws:disconnected', this._onWsDisconnected);
        eventBus.off('ws:connected', this._onWsConnected);

        this.wsClient.disconnect();
    }

    _startPolling() {
        if (this.pollTimer || !this.running) return;
        this._pollGeneration++;
        console.log('[SessionWatcher] Started fallback polling');
        void this._poll();
        this.pollTimer = setInterval(() => void this._poll(), REFRESH_INTERVAL);
    }

    _stopPolling() {
        this._pollGeneration++;
        if (this.pollTimer) {
            clearInterval(this.pollTimer);
            this.pollTimer = null;
            console.log('[SessionWatcher] Stopped polling (WebSocket active)');
        }
        this._pollController?.abort?.();
        this._pollController = null;
    }

    _poll() {
        if (!this.running || this._pollPromise) return this._pollPromise;
        const generation = this._pollGeneration;
        const controller = new AbortController();
        this._pollController = controller;
        const timeout = setTimeout(() => controller.abort(), POLL_TIMEOUT_MS);
        const pollPromise = this._runPoll(generation, controller.signal)
            .finally(() => {
                clearTimeout(timeout);
                if (this._pollController === controller) this._pollController = null;
                if (this._pollPromise === pollPromise) this._pollPromise = null;
            });
        this._pollPromise = pollPromise;
        return pollPromise;
    }

    async _runPoll(generation, signal) {
        try {
            const [sessionsResult, usageResult] = await Promise.allSettled([
                this.dataSource.getSessions({ signal }),
                this.dataSource.getUsage({ signal }),
            ]);
            if (!this.running || signal.aborted || generation !== this._pollGeneration) return;
            if (sessionsResult.status === 'fulfilled') {
                const sessions = sessionsResult.value;
                if (sessions) {
                    this.agentManager.handleWebSocketMessage({ sessions });
                }
            } else {
                console.error('[SessionWatcher] Polling sessions failed:', sessionsResult.reason?.message || sessionsResult.reason);
            }

            if (usageResult.status === 'fulfilled') {
                const usage = usageResult.value;
                if (usage) eventBus.emit('usage:updated', usage);
            } else {
                console.error('[SessionWatcher] Polling usage failed:', usageResult.reason?.message || usageResult.reason);
            }
        } catch (err) {
            if (signal.aborted || generation !== this._pollGeneration || !this.running) return;
            console.error('[SessionWatcher] Polling failed:', err.message);
        }
    }
}
