import { eventBus } from '../../domain/events/DomainEvent.js';

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
    constructor(world) {
        this.world = world;
        this.snapshots = new Map();
        this.chatPairs = new Set();
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
    }

    _onAdded(agent) {
        const snap = snapshotAgent(agent);
        this.snapshots.set(agent.id, snap);
        if (snap.parentId && this.world?.agents?.has?.(snap.parentId)) {
            eventBus.emit('subagent:dispatched', {
                parentId: snap.parentId,
                childId: agent.id,
                ts: Date.now(),
            });
        }
        if (snap.teamName) {
            eventBus.emit('team:joined', {
                agentId: agent.id,
                teamName: snap.teamName,
                ts: Date.now(),
            });
        }
        this._emitToolIfChanged(agent, null, snap);
    }

    _onUpdated(agent) {
        const previous = this.snapshots.get(agent.id) || null;
        const next = snapshotAgent(agent);
        this.snapshots.set(agent.id, next);
        this._emitToolIfChanged(agent, previous, next);
        if (!previous?.teamName && next.teamName) {
            eventBus.emit('team:joined', {
                agentId: agent.id,
                teamName: next.teamName,
                ts: Date.now(),
            });
        }
    }

    _onRemoved(agent) {
        const previous = this.snapshots.get(agent.id) || snapshotAgent(agent);
        this.snapshots.delete(agent.id);
        if (previous.parentId && this.world?.agents?.has?.(previous.parentId)) {
            eventBus.emit('subagent:completed', {
                parentId: previous.parentId,
                childId: agent.id,
                lastTile: previous.lastTile,
                ts: Date.now(),
            });
        }
        this._clearChatPairsFor(agent.id);
    }

    _emitToolIfChanged(agent, previous, next) {
        if (!next.tool) return;
        if (previous && previous.toolKey === next.toolKey) return;
        eventBus.emit('tool:invoked', {
            agentId: agent.id,
            tool: next.tool,
            input: next.input,
            ts: Date.now(),
            building: agent.targetBuildingType || agent.lastKnownBuildingType || null,
        });
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
            eventBus.emit('chat:started', { aId, bId, ts: Date.now() });
        }

        for (const key of this.chatPairs) {
            if (nextPairs.has(key)) continue;
            const [aId, bId] = key.split('|');
            eventBus.emit('chat:ended', { aId, bId, ts: Date.now() });
        }

        this.chatPairs = nextPairs;
    }

    _clearChatPairsFor(agentId) {
        for (const key of Array.from(this.chatPairs)) {
            if (!key.split('|').includes(agentId)) continue;
            this.chatPairs.delete(key);
            const [aId, bId] = key.split('|');
            eventBus.emit('chat:ended', { aId, bId, ts: Date.now() });
        }
    }
}

export { nowMs };
