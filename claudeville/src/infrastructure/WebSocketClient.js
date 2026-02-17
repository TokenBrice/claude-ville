import { eventBus } from '../domain/events/DomainEvent.js';
import { WS_RECONNECT_INTERVAL } from '../config/constants.js';

export class WebSocketClient {
    constructor() {
        this.ws = null;
        this.connected = false;
        this.reconnectTimer = null;
        this.url = `ws://${window.location.host}`;
    }

    get isConnected() {
        return this.connected;
    }

    connect() {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) return;

        try {
            this.ws = new WebSocket(this.url);

            this.ws.onopen = () => {
                this.connected = true;
                console.log('[WS] 연결됨');
                eventBus.emit('ws:connected');
                this._clearReconnect();
            };

            this.ws.onmessage = (event) => {
                try {
                    const data = JSON.parse(event.data);
                    this._handleMessage(data);
                } catch (err) {
                    console.error('[WS] 메시지 파싱 실패:', err.message);
                }
            };

            this.ws.onclose = () => {
                this.connected = false;
                console.log('[WS] 연결 해제');
                eventBus.emit('ws:disconnected');
                this._scheduleReconnect();
            };

            this.ws.onerror = (err) => {
                console.error('[WS] 에러 발생');
                this.connected = false;
            };
        } catch (err) {
            console.error('[WS] 연결 실패:', err.message);
            this._scheduleReconnect();
        }
    }

    disconnect() {
        this._clearReconnect();
        if (this.ws) {
            this.ws.onclose = null;
            this.ws.close();
            this.ws = null;
        }
        this.connected = false;
    }

    send(data) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(data));
        }
    }

    _handleMessage(data) {
        switch (data.type) {
            case 'init':
                eventBus.emit('ws:init', data);
                break;
            case 'update':
                eventBus.emit('ws:update', data);
                break;
            case 'pong':
                break;
            default:
                eventBus.emit('ws:message', data);
        }
    }

    _scheduleReconnect() {
        this._clearReconnect();
        this.reconnectTimer = setTimeout(() => {
            console.log('[WS] 재연결 시도...');
            this.connect();
        }, WS_RECONNECT_INTERVAL);
    }

    _clearReconnect() {
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
    }
}
