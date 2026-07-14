import { eventBus } from '../domain/events/DomainEvent.js';
import { WS_RECONNECT_INTERVAL } from '../config/constants.js';

function unescapeJsonPointerToken(token) {
    return token.replace(/~1/g, '/').replace(/~0/g, '~');
}

function cloneContainer(value) {
    return Array.isArray(value) ? value.slice() : { ...value };
}

function resolveArrayIndex(array, token, allowAppend) {
    if (token === '-' && allowAppend) return array.length;
    if (!/^\d+$/.test(token)) throw new Error(`Invalid array index: ${token}`);
    const index = Number(token);
    if (index > (allowAppend ? array.length : array.length - 1)) {
        throw new Error(`Array index out of bounds: ${token}`);
    }
    return index;
}

// Applies one JSON-Patch op (add/replace/remove) with path copying: every
// container along the op path is shallow-cloned, so consumers holding
// references into previously emitted payloads never see in-place mutation.
function applyJsonPatchOp(root, op) {
    if (!op || typeof op.path !== 'string' || op.path[0] !== '/') {
        throw new Error('Invalid patch op');
    }
    const tokens = op.path.split('/').slice(1).map(unescapeJsonPointerToken);
    const newRoot = cloneContainer(root);
    let parent = newRoot;
    for (let i = 0; i < tokens.length - 1; i++) {
        const key = Array.isArray(parent)
            ? resolveArrayIndex(parent, tokens[i], false)
            : tokens[i];
        const child = parent[key];
        if (child === null || typeof child !== 'object') {
            throw new Error(`Missing patch target: ${op.path}`);
        }
        const cloned = cloneContainer(child);
        parent[key] = cloned;
        parent = cloned;
    }
    const last = tokens[tokens.length - 1];
    if (Array.isArray(parent)) {
        if (op.op === 'add') parent.splice(resolveArrayIndex(parent, last, true), 0, op.value);
        else if (op.op === 'replace') parent[resolveArrayIndex(parent, last, false)] = op.value;
        else if (op.op === 'remove') parent.splice(resolveArrayIndex(parent, last, false), 1);
        else throw new Error(`Unsupported patch op: ${op.op}`);
    } else if (op.op === 'add' || op.op === 'replace') {
        parent[last] = op.value;
    } else if (op.op === 'remove') {
        delete parent[last];
    } else {
        throw new Error(`Unsupported patch op: ${op.op}`);
    }
    return newRoot;
}

function applyJsonPatch(state, patch) {
    if (!Array.isArray(patch)) throw new Error('Patch must be an array');
    let root = state;
    for (const op of patch) {
        root = applyJsonPatchOp(root, op);
    }
    return root;
}

export class WebSocketClient {
    constructor() {
        this.ws = null;
        this.connected = false;
        this.reconnectTimer = null;
        this.reconnectAttempts = 0;
        this.url = `ws://${window.location.host}`;
        // Delta protocol state: last full {sessions, teams, usage} snapshot
        // and its server sequence number. Old servers never send deltas, so
        // these simply stay unused against a full-payload-only server.
        this._state = null;
        this._seq = null;
        this._resyncRequested = false;
    }

    get isConnected() {
        return this.connected;
    }

    connect() {
        if (this.ws && (
            this.ws.readyState === WebSocket.CONNECTING
            || this.ws.readyState === WebSocket.OPEN
        )) return;

        try {
            const socket = new WebSocket(this.url);
            this.ws = socket;

            socket.onopen = () => {
                if (this.ws !== socket) return;
                this.connected = true;
                this._resyncRequested = false;
                console.log('[WS] Connected');
                // Announce delta support; old servers ignore unknown types.
                this.send({ type: 'hello', deltas: true });
                eventBus.emit('ws:connected');
                this._clearReconnect();
            };

            socket.onmessage = (event) => {
                if (this.ws !== socket) return;
                try {
                    const data = JSON.parse(event.data);
                    this._handleMessage(data);
                } catch (err) {
                    console.error('[WS] Failed to parse message:', err.message);
                }
            };

            socket.onclose = () => {
                if (this.ws !== socket) return;
                this.ws = null;
                this.connected = false;
                console.log('[WS] Disconnected');
                eventBus.emit('ws:disconnected');
                this._scheduleReconnect();
            };

            socket.onerror = () => {
                if (this.ws !== socket) return;
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
        const socket = this.ws;
        if (socket) {
            socket.onopen = null;
            socket.onmessage = null;
            socket.onerror = null;
            socket.onclose = null;
            this.ws = null;
            if (
                socket.readyState === WebSocket.CONNECTING
                || socket.readyState === WebSocket.OPEN
            ) {
                socket.close();
            }
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
                this._rememberSnapshot(data);
                eventBus.emit('ws:init', data);
                if (data.usage) eventBus.emit('usage:updated', data.usage);
                break;
            case 'update':
                this._rememberSnapshot(data);
                eventBus.emit('ws:update', data);
                if (data.usage) eventBus.emit('usage:updated', data.usage);
                break;
            case 'update-delta':
                this._handleDelta(data);
                break;
            case 'pong':
                break;
            default:
                eventBus.emit('ws:message', data);
        }
    }

    _rememberSnapshot(data) {
        this._state = {
            sessions: Array.isArray(data.sessions) ? data.sessions : [],
            teams: Array.isArray(data.teams) ? data.teams : [],
            usage: data.usage ?? null,
        };
        this._seq = Number.isFinite(data.seq) ? data.seq : null;
        this._resyncRequested = false;
    }

    _handleDelta(data) {
        if (!this._state || this._seq === null || data.baseSeq !== this._seq) {
            this._requestResync();
            return;
        }
        let next;
        try {
            next = applyJsonPatch(this._state, data.patch);
        } catch (err) {
            console.warn('[WS] Failed to apply delta, requesting resync:', err.message);
            this._requestResync();
            return;
        }
        this._state = next;
        this._seq = data.seq;
        const payload = {
            type: 'update',
            sessions: next.sessions,
            teams: next.teams,
            usage: next.usage,
            timestamp: data.timestamp,
        };
        eventBus.emit('ws:update', payload);
        if (payload.usage) eventBus.emit('usage:updated', payload.usage);
    }

    _requestResync() {
        // One outstanding resync at a time; the flag clears when the next
        // full snapshot (init/update) arrives or the socket reopens.
        if (this._resyncRequested) return;
        this._resyncRequested = true;
        this.send({ type: 'resync' });
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
