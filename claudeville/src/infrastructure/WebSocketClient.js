import { eventBus } from '../domain/events/DomainEvent.js';
import { WS_RECONNECT_INTERVAL } from '../config/constants.js';
import { LinkState } from '../application/VillageState.js';

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

// Copy each changed ancestor once per message. Untouched branches remain shared
// with the baseline, and no operation can mutate an earlier emitted snapshot.
function applyJsonPatch(state, patch) {
    if (!Array.isArray(patch)) throw new Error('Patch must be an array');
    const copied = new WeakSet();
    const mutable = (value) => {
        if (!value || typeof value !== 'object') throw new Error('Missing patch target');
        if (copied.has(value)) return value;
        const clone = cloneContainer(value);
        copied.add(clone);
        return clone;
    };
    let root = state;
    const sessionIds = new Set();
    let shared = false;
    let order = false;
    for (const op of patch) {
        if (
            !op || typeof op.path !== 'string'
            || (op.path !== '' && op.path[0] !== '/')
            || !['add', 'replace', 'remove'].includes(op.op)
        ) throw new Error('Invalid patch op');
        if (op.path === '') {
            shared = true;
            root = op.op === 'remove' ? null : op.value;
            continue;
        }
        const tokens = op.path.split('/').slice(1).map(unescapeJsonPointerToken);
        if (tokens[0] === 'sessionsById' && tokens.length > 1) {
            sessionIds.add(tokens[1]);
        } else if (tokens[0] === 'sessionOrder' && tokens.length > 1) {
            order = true;
        } else {
            shared = true;
        }
        root = mutable(root);
        let parent = root;
        for (let index = 0; index < tokens.length - 1; index++) {
            const token = tokens[index];
            const key = Array.isArray(parent)
                ? resolveArrayIndex(parent, token, false)
                : token;
            if (!Object.prototype.hasOwnProperty.call(parent, key)) {
                throw new Error(`Missing patch target: ${op.path}`);
            }
            const child = mutable(parent[key]);
            Object.defineProperty(parent, key, {
                value: child, enumerable: true, writable: true, configurable: true,
            });
            parent = child;
        }
        const token = tokens[tokens.length - 1];
        if (Array.isArray(parent)) {
            if (op.op === 'add') parent.splice(resolveArrayIndex(parent, token, true), 0, op.value);
            else if (op.op === 'replace') parent[resolveArrayIndex(parent, token, false)] = op.value;
            else parent.splice(resolveArrayIndex(parent, token, false), 1);
        } else {
            if (op.op !== 'add' && !Object.prototype.hasOwnProperty.call(parent, token)) {
                throw new Error(`Missing patch target: ${op.path}`);
            }
            if (op.op === 'remove') delete parent[token];
            else Object.defineProperty(parent, token, {
                value: op.value, enumerable: true, writable: true, configurable: true,
            });
        }
    }
    return { state: root, changes: { sessionIds: [...sessionIds], shared, order } };
}

function sessionsFromKeyedState(state) {
    if (
        !Array.isArray(state?.sessionOrder)
        || !state.sessionsById || typeof state.sessionsById !== 'object'
        || Array.isArray(state.sessionsById)
    ) throw new Error('Invalid keyed snapshot');
    return state.sessionOrder.map((id) => {
        if (
            typeof id !== 'string' || !id
            || !Object.prototype.hasOwnProperty.call(state.sessionsById, id)
            || String(state.sessionsById[id]?.sessionId ?? '') !== id
        ) throw new Error('Missing session in keyed snapshot');
        return state.sessionsById[id];
    });
}

export class WebSocketClient {
    constructor(options = {}) {
        const { performanceMetrics = null } = options || {};
        this.ws = null;
        this.connected = false;
        this.reconnectTimer = null;
        this.reconnectAttempts = 0;
        this.performanceMetrics = performanceMetrics;
        this.state = Object.freeze({
            state: LinkState.SYNCING,
            attempts: 0,
            nextRetryAt: null,
            lastMessageAt: null,
            lastSnapshotAt: null,
            lastErrorCode: null,
        });
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        this.url = `${protocol}//${window.location.host}/ws`;
        // Delta v2 baseline is keyed by stable session identity, separate from
        // the activity-ordered sessions array emitted to application consumers.
        this._state = null;
        this._seq = null;
        this._resyncRequested = false;
        this._deltasDisabled = false;
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
                this._deltasDisabled = false;
                console.log('[WS] Connected');
                // Announce v2 support; incompatible servers are switched to full updates.
                this.send({ type: 'hello', deltas: true, deltaVersion: 2 });
                eventBus.emit('ws:connected');
                this._clearReconnect();
                this._publishState({
                    state: this.reconnectAttempts > 0 ? LinkState.RECONNECTING : LinkState.SYNCING,
                    nextRetryAt: null,
                });
            };

            socket.onmessage = (event) => {
                if (this.ws !== socket) return;
                const metrics = this.performanceMetrics;
                const messagePerf = metrics && metrics.enabled !== false
                    ? metrics.beginMessage?.() || null
                    : null;
                try {
                    const data = JSON.parse(event.data);
                    this._publishState({ lastMessageAt: Date.now() });
                    this._handleMessage(data, messagePerf);
                } catch (err) {
                    if (messagePerf) metrics.cancelMessage?.(messagePerf);
                    console.error('[WS] Failed to parse message:', err.message);
                    this._publishState({ lastErrorCode: 'message-invalid' });
                }
            };

            socket.onclose = () => {
                if (this.ws !== socket) return;
                this.ws = null;
                this.connected = false;
                this._clearProtocolState();
                console.log('[WS] Disconnected');
                eventBus.emit('ws:disconnected');
                this._scheduleReconnect('socket-closed');
            };

            socket.onerror = () => {
                if (this.ws !== socket) return;
                console.error('[WS] Error occurred');
                this.connected = false;
                this._publishState({
                    lastErrorCode: this.state.lastSnapshotAt === null
                        ? 'initial-sync-failed'
                        : 'socket-error',
                });
            };
        } catch (err) {
            console.error('[WS] Connection failed:', err.message);
            this._scheduleReconnect('initial-sync-failed');
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
        this._clearProtocolState();
    }

    send(data) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(data));
        }
    }

    _handleMessage(data, messagePerf = null) {
        switch (data.type) {
            case 'init':
                if (messagePerf) this.performanceMetrics.cancelMessage?.(messagePerf);
                // Reset reconnect attempts only after server confirms a healthy session,
                // so half-open TCPs that never deliver init keep backing off.
                this.reconnectAttempts = 0;
                this._rememberSnapshot(data);
                this._publishSnapshot();
                eventBus.emit('ws:init', data);
                if (data.usage) eventBus.emit('usage:updated', data.usage);
                break;
            case 'update':
                if (messagePerf) this.performanceMetrics.cancelMessage?.(messagePerf);
                this._rememberSnapshot(data);
                this.reconnectAttempts = 0;
                this._publishSnapshot();
                eventBus.emit('ws:update', data);
                if (data.usage) eventBus.emit('usage:updated', data.usage);
                break;
            case 'update-delta':
                this._handleDelta(data, messagePerf);
                break;
            case 'pong':
                if (messagePerf) this.performanceMetrics.cancelMessage?.(messagePerf);
                break;
            default:
                if (messagePerf) this.performanceMetrics.cancelMessage?.(messagePerf);
                eventBus.emit('ws:message', data);
        }
    }

    _rememberSnapshot(data) {
        const sessionsById = Object.create(null);
        const sessionOrder = [];
        let valid = true;
        for (const session of Array.isArray(data.sessions) ? data.sessions : []) {
            const id = String(session?.sessionId ?? '');
            if (!id || Object.prototype.hasOwnProperty.call(sessionsById, id)) {
                valid = false;
                break;
            }
            sessionsById[id] = session;
            sessionOrder.push(id);
        }
        this._state = {
            sessionsById,
            sessionOrder,
            gitEventFields: Array.isArray(data.gitEventFields) ? data.gitEventFields : [],
            gitEventStringTables: Array.isArray(data.gitEventStringTables)
                ? data.gitEventStringTables
                : [],
            gitEventsById: data.gitEventsById && typeof data.gitEventsById === 'object'
                ? data.gitEventsById
                : {},
            collisions: Array.isArray(data.collisions) ? data.collisions : [],
            teams: Array.isArray(data.teams) ? data.teams : [],
            usage: data.usage ?? null,
        };
        if (!valid) this._state = null;
        this._seq = Number.isFinite(data.seq) ? data.seq : null;
        this._resyncRequested = false;
    }

    _clearProtocolState() {
        this._state = null;
        this._seq = null;
        this._resyncRequested = false;
        this._deltasDisabled = false;
    }

    getDebugSnapshot() {
        const sessionOrder = this._state?.sessionOrder || [];
        const teams = this._state?.teams || [];
        let retainedBytes = 0;
        if (this._state) {
            try { retainedBytes = JSON.stringify(this._state).length * 2; } catch { /* diagnostic only */ }
        }
        return {
            connected: this.connected,
            retainedSessions: sessionOrder.length,
            retainedTeams: teams.length,
            retainedBytes,
            sequence: this._seq,
        };
    }

    _handleDelta(data, messagePerf = null) {
        const metrics = this.performanceMetrics;
        const deltaPerf = metrics && metrics.enabled !== false
            ? metrics.beginDelta?.(messagePerf) || null
            : null;
        if (data.deltaVersion !== 2) {
            if (deltaPerf) metrics.discardDelta?.(deltaPerf, 'unsupported-version');
            // A v1 server accepts the v2 hello as delta-capable. Resyncing would
            // force another scan without fixing the incompatible wire format.
            if (!this._deltasDisabled) {
                this._deltasDisabled = true;
                this.send({ type: 'hello', deltas: false });
            }
            return;
        }
        if (
            !this._state || this._seq === null
            || data.baseSeq !== this._seq || !Number.isFinite(data.seq)
        ) {
            if (deltaPerf) metrics.discardDelta?.(deltaPerf, 'resync');
            this._publishState({ lastErrorCode: 'delta-baseline-mismatch' });
            this._requestResync();
            return;
        }
        let next;
        let sessions;
        let changes;
        if (deltaPerf) metrics.markPatchStart?.(deltaPerf);
        try {
            const applied = applyJsonPatch(this._state, data.patch);
            next = applied.state;
            changes = applied.changes;
            sessions = sessionsFromKeyedState(next);
        } catch (err) {
            if (deltaPerf) metrics.discardDelta?.(deltaPerf, 'resync');
            console.warn('[WS] Failed to apply delta, requesting resync:', err.message);
            this._publishState({ lastErrorCode: 'patch-failed' });
            this._requestResync();
            return;
        }
        if (deltaPerf) metrics.markPatchApplied?.(deltaPerf, data.patch.length);
        this._state = next;
        this._seq = data.seq;
        this.reconnectAttempts = 0;
        this._publishSnapshot();
        const payload = {
            type: 'update',
            sessions,
            changes,
            seq: data.seq,
            gitEventFields: next.gitEventFields,
            gitEventStringTables: next.gitEventStringTables,
            gitEventsById: next.gitEventsById,
            collisions: next.collisions,
            teams: next.teams,
            usage: next.usage,
            timestamp: data.timestamp,
        };
        if (deltaPerf) metrics.markFanoutStart?.(deltaPerf);
        eventBus.emit('ws:update', payload);
        if (payload.usage) eventBus.emit('usage:updated', payload.usage);
        if (deltaPerf) {
            metrics.markFanoutEnd?.(deltaPerf);
            metrics.finishDelta?.(deltaPerf);
        }
    }

    _requestResync() {
        // One outstanding resync at a time; the flag clears when the next
        // full snapshot (init/update) arrives or the socket reopens.
        if (this._resyncRequested) return;
        this._resyncRequested = true;
        this.send({ type: 'resync' });
    }

    _scheduleReconnect(errorCode = 'socket-closed') {
        this._clearReconnect();
        this.reconnectAttempts++;
        const backoff = Math.min(
            WS_RECONNECT_INTERVAL * Math.pow(2, this.reconnectAttempts - 1),
            15000
        );
        // Jitter avoids lockstep reconnect storms when many tabs reopen at once.
        const delay = backoff + Math.random() * 500;
        const nextRetryAt = Date.now() + delay;
        this._publishState({
            state: LinkState.RECONNECTING,
            attempts: this.reconnectAttempts,
            nextRetryAt,
            lastErrorCode: errorCode,
        });
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

    _publishSnapshot() {
        this._publishState({
            state: LinkState.LIVE,
            attempts: 0,
            nextRetryAt: null,
            lastSnapshotAt: Date.now(),
            lastErrorCode: null,
        });
    }

    _publishState(updates = {}) {
        const next = {
            state: updates.state ?? this.state.state,
            attempts: updates.attempts ?? this.reconnectAttempts,
            nextRetryAt: updates.nextRetryAt !== undefined
                ? updates.nextRetryAt
                : this.state.nextRetryAt,
            lastMessageAt: updates.lastMessageAt !== undefined
                ? updates.lastMessageAt
                : this.state.lastMessageAt,
            lastSnapshotAt: updates.lastSnapshotAt !== undefined
                ? updates.lastSnapshotAt
                : this.state.lastSnapshotAt,
            lastErrorCode: updates.lastErrorCode !== undefined
                ? updates.lastErrorCode
                : this.state.lastErrorCode,
        };
        this.state = Object.freeze(next);
        eventBus.emit('ws:state', next);
    }
}
