import { eventBus } from '../domain/events/DomainEvent.js';
import { REFRESH_INTERVAL } from '../config/constants.js';

export class SessionWatcher {
    constructor(agentManager, wsClient, dataSource) {
        this.agentManager = agentManager;
        this.wsClient = wsClient;
        this.dataSource = dataSource;
        this.pollTimer = null;
        this.running = false;

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
        console.log('[SessionWatcher] Started fallback polling');
        this._poll();
        this.pollTimer = setInterval(() => this._poll(), REFRESH_INTERVAL);
    }

    _stopPolling() {
        if (this.pollTimer) {
            clearInterval(this.pollTimer);
            this.pollTimer = null;
            console.log('[SessionWatcher] Stopped polling (WebSocket active)');
        }
    }

    async _poll() {
        try {
            const [sessions, usage] = await Promise.all([
                this.dataSource.getSessions(),
                this.dataSource.getUsage(),
            ]);
            this.agentManager.handleWebSocketMessage({ sessions });
            if (usage) eventBus.emit('usage:updated', usage);
        } catch (err) {
            console.error('[SessionWatcher] Polling failed:', err.message);
        }
    }
}
