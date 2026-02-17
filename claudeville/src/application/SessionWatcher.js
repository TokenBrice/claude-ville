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

        // WebSocket 이벤트 구독
        eventBus.on('ws:init', this._onWsInit);
        eventBus.on('ws:update', this._onWsUpdate);
        eventBus.on('ws:disconnected', this._onWsDisconnected);
        eventBus.on('ws:connected', this._onWsConnected);

        // WebSocket 연결
        this.wsClient.connect();

        // 폴백 폴링도 시작 (WebSocket 연결 전까지)
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
        console.log('[SessionWatcher] 폴링 시작 (폴백)');
        this._poll();
        this.pollTimer = setInterval(() => this._poll(), REFRESH_INTERVAL);
    }

    _stopPolling() {
        if (this.pollTimer) {
            clearInterval(this.pollTimer);
            this.pollTimer = null;
            console.log('[SessionWatcher] 폴링 중지 (WebSocket 활성)');
        }
    }

    async _poll() {
        try {
            const sessions = await this.dataSource.getSessions();
            this.agentManager.handleWebSocketMessage({ sessions });
        } catch (err) {
            console.error('[SessionWatcher] 폴링 실패:', err.message);
        }
    }
}
