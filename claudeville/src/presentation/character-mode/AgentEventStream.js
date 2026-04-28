import { eventBus } from '../../domain/events/DomainEvent.js';
import { classifyTool } from './VisitIntentManager.js';

function nowMs() {
    if (typeof performance !== 'undefined' && performance.now) return performance.now();
    return Date.now();
}

function toolKey(agent) {
    return [
        agent?.currentTool || '',
        agent?.currentToolInput || '',
        agent?.lastSessionActivity || '',
    ].join('\u001f');
}

function snapshotAgent(agent) {
    return {
        id: agent.id,
        tool: agent.currentTool || null,
        input: agent.currentToolInput || null,
        toolKey: toolKey(agent),
        parentId: agent.parentSessionId || null,
        teamName: agent.teamName || null,
        lastTile: agent.position
            ? { tileX: agent.position.x, tileY: agent.position.y }
            : null,
    };
}

function pairKey(aId, bId) {
    return [aId, bId].sort().join('|');
}

export class AgentEventStream {
    constructor(world, { shouldEmitToolEvent = null, shouldEmitEvent = null } = {}) {
        this.world = world;
        this.snapshots = new Map();
        this.chatPairs = new Set();
        this.emittedToolKeys = new Set();
        this.shouldEmitToolEvent = typeof shouldEmitToolEvent === 'function' ? shouldEmitToolEvent : null;
        this.shouldEmitEvent = typeof shouldEmitEvent === 'function' ? shouldEmitEvent : null;
        this.unsubscribers = [];

        for (const agent of this.world?.agents?.values?.() || []) {
            this.snapshots.set(agent.id, snapshotAgent(agent));
        }

        this.unsubscribers.push(
            eventBus.on('agent:added', (agent) => this._onAdded(agent)),
            eventBus.on('agent:updated', (agent) => this._onUpdated(agent)),
            eventBus.on('agent:removed', (agent) => this._onRemoved(agent)),
        );
    }

    dispose() {
        for (const unsubscribe of this.unsubscribers) unsubscribe();
        this.unsubscribers = [];
        this.snapshots.clear();
        this.chatPairs.clear();
        this.emittedToolKeys.clear();
        this.shouldEmitToolEvent = null;
        this.shouldEmitEvent = null;
    }

    setToolEventGate(shouldEmitToolEvent = null) {
        this.shouldEmitToolEvent = typeof shouldEmitToolEvent === 'function' ? shouldEmitToolEvent : null;
    }

    _canEmit(eventName, payload, agent) {
        return typeof this.shouldEmitEvent !== 'function' || this.shouldEmitEvent(eventName, payload, agent) !== false;
    }

    emitInitialToolEvents({ force = false, shouldEmit = null } = {}) {
        let emitted = 0;
        const gate = typeof shouldEmit === 'function' ? shouldEmit : this.shouldEmitToolEvent;
        for (const agent of this.world?.agents?.values?.() || []) {
            const snap = snapshotAgent(agent);
            this.snapshots.set(agent.id, snap);
            if (!snap.tool) continue;

            const emittedKey = this._emittedToolKey(agent.id, snap.toolKey);
            if (!force && this.emittedToolKeys.has(emittedKey)) continue;

            const event = this._toolEvent(agent, snap, { replay: true });
            if (typeof gate === 'function' && !gate(event, agent)) continue;

            if (!this._canEmit('tool:invoked', event, agent)) continue;
            eventBus.emit('tool:invoked', event);
            this.emittedToolKeys.add(emittedKey);
            emitted += 1;
        }
        return emitted;
    }

    _onAdded(agent) {
        const snap = snapshotAgent(agent);
        this.snapshots.set(agent.id, snap);
        if (snap.parentId && this.world?.agents?.has?.(snap.parentId)) {
            const event = {
                parentId: snap.parentId,
                childId: agent.id,
                ts: Date.now(),
            };
            if (this._canEmit('subagent:dispatched', event, agent)) eventBus.emit('subagent:dispatched', event);
        }
        if (snap.teamName) {
            const event = {
                agentId: agent.id,
                teamName: snap.teamName,
                ts: Date.now(),
            };
            if (this._canEmit('team:joined', event, agent)) eventBus.emit('team:joined', event);
        }
        this._emitToolIfChanged(agent, null, snap);
    }

    _onUpdated(agent) {
        const previous = this.snapshots.get(agent.id) || null;
        const next = snapshotAgent(agent);
        this.snapshots.set(agent.id, next);
        this._emitToolIfChanged(agent, previous, next);
        if (!previous?.teamName && next.teamName) {
            const event = {
                agentId: agent.id,
                teamName: next.teamName,
                ts: Date.now(),
            };
            if (this._canEmit('team:joined', event, agent)) eventBus.emit('team:joined', event);
        }
    }

    _onRemoved(agent) {
        const previous = this.snapshots.get(agent.id) || snapshotAgent(agent);
        this.snapshots.delete(agent.id);
        if (previous.parentId && this.world?.agents?.has?.(previous.parentId)) {
            const event = {
                parentId: previous.parentId,
                childId: agent.id,
                lastTile: previous.lastTile,
                ts: Date.now(),
            };
            if (this._canEmit('subagent:completed', event, agent)) eventBus.emit('subagent:completed', event);
        }
        this._clearChatPairsFor(agent.id);
    }

    _emitToolIfChanged(agent, previous, next) {
        if (!next.tool) return;
        if (String(agent.status || '').toLowerCase() !== 'working') return;
        if (previous && previous.toolKey === next.toolKey) return;
        const event = this._toolEvent(agent, next);
        if (!this._canEmit('tool:invoked', event, agent)) return;
        if (typeof this.shouldEmitToolEvent === 'function' && !this.shouldEmitToolEvent(event, agent)) return;
        eventBus.emit('tool:invoked', event);
        this.emittedToolKeys.add(this._emittedToolKey(agent.id, next.toolKey));
    }

    _toolEvent(agent, snap, extra = {}) {
        const classified = classifyTool(snap.tool, snap.input);
        return {
            agentId: agent.id,
            tool: snap.tool,
            input: snap.input,
            ts: Date.now(),
            building: classified?.building || agent.targetBuildingType || agent.lastKnownBuildingType || null,
            reason: classified?.reason || null,
            confidence: classified?.confidence ?? null,
            label: classified?.label || null,
            ...extra,
        };
    }

    _emittedToolKey(agentId, key) {
        return `${agentId || ''}\u001f${key || ''}`;
    }

    reconcileChatPairs(agentSprites) {
        const nextPairs = new Set();
        const sprites = agentSprites?.values ? Array.from(agentSprites.values()) : [];
        for (const sprite of sprites) {
            const aId = sprite.agent?.id;
            const bId = sprite.chatPartner?.agent?.id;
            if (!aId || !bId || aId === bId) continue;
            nextPairs.add(pairKey(aId, bId));
        }

        for (const key of nextPairs) {
            if (this.chatPairs.has(key)) continue;
            const [aId, bId] = key.split('|');
            const event = { aId, bId, ts: Date.now() };
            if (this._canEmit('chat:started', event, null)) eventBus.emit('chat:started', event);
        }

        for (const key of this.chatPairs) {
            if (nextPairs.has(key)) continue;
            const [aId, bId] = key.split('|');
            const event = { aId, bId, ts: Date.now() };
            if (this._canEmit('chat:ended', event, null)) eventBus.emit('chat:ended', event);
        }

        this.chatPairs = nextPairs;
    }

    _clearChatPairsFor(agentId) {
        for (const key of Array.from(this.chatPairs)) {
            if (!key.split('|').includes(agentId)) continue;
            this.chatPairs.delete(key);
            const [aId, bId] = key.split('|');
            const event = { aId, bId, ts: Date.now() };
            if (this._canEmit('chat:ended', event, null)) eventBus.emit('chat:ended', event);
        }
    }
}

export { nowMs };
