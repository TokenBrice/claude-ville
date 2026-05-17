import { eventBus } from '../domain/events/DomainEvent.js';
import { WS_RECONNECT_INTERVAL } from '../config/constants.js';

export class WebSocketClient {
    constructor() {
        this.ws = null;
        this.connected = false;
        this.reconnectTimer = null;
        this.reconnectAttempts = 0;
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
                console.log('[WS] Connected');
                eventBus.emit('ws:connected');
                this._clearReconnect();
            };

            this.ws.onmessage = (event) => {
                try {
                    const data = JSON.parse(event.data);
                    this._handleMessage(data);
                } catch (err) {
                    console.error('[WS] Failed to parse message:', err.message);
                }
            };

            this.ws.onclose = () => {
                this.connected = false;
                console.log('[WS] Disconnected');
                eventBus.emit('ws:disconnected');
                this._scheduleReconnect();
            };

            this.ws.onerror = (err) => {
                console.error('[WS] Error occurred');
                this.connected = false;
            };
        } catch (err) {
            console.error('[WS] Connection failed:', err.message);
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
                // Reset reconnect attempts only after server confirms a healthy session,
                // so half-open TCPs that never deliver init keep backing off.
                this.reconnectAttempts = 0;
                eventBus.emit('ws:init', data);
                if (data.usage) eventBus.emit('usage:updated', data.usage);
                break;
            case 'update':
                eventBus.emit('ws:update', data);
                if (data.usage) eventBus.emit('usage:updated', data.usage);
                break;
            case 'pong':
                break;
            default:
                eventBus.emit('ws:message', data);
        }
    }

    _scheduleReconnect() {
        this._clearReconnect();
        this.reconnectAttempts++;
        const backoff = Math.min(
            WS_RECONNECT_INTERVAL * Math.pow(2, this.reconnectAttempts - 1),
            15000
        );
        // Jitter avoids lockstep reconnect storms when many tabs reopen at once.
        const delay = backoff + Math.random() * 500;
        this.reconnectTimer = setTimeout(() => {
            if (this.reconnectAttempts > 3) {
                console.log(`[WS] Reconnect attempt... (retrying in ${Math.round(delay / 1000)} seconds)`);
            }
            this.connect();
        }, delay);
    }

    _clearReconnect() {
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
    }
}
