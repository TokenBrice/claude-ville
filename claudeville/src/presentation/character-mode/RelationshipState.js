import { eventBus } from '../../domain/events/DomainEvent.js';

const ARRIVAL_WINDOW_MS = 8000;
const DEPARTURE_WINDOW_MS = 12000;
const MAX_RECENT_DEPARTURES = 6;

function pairKey(aId, bId) {
    return [aId, bId].sort().join('|');
}

export class RelationshipState {
    constructor(world) {
        this.world = world;
        this.parentToChildren = new Map();
        this.childToParent = new Map();
        this.teamToMembers = new Map();
        this.recentArrivals = [];
        this.recentDepartures = [];
        this.chatPairs = [];
        this._lastSpriteTiles = new Map();
        this._dirty = true;
        this._snapshot = null;
        this.unsubscribers = [
            eventBus.on('agent:added', (agent) => {
                this.recentArrivals.push({ agentId: agent.id, at: performance.now() });
                this._dirty = true;
            }),
            eventBus.on('agent:updated', () => { this._dirty = true; }),
            eventBus.on('agent:removed', (agent) => {
                const lastTile = this._lastSpriteTiles.get(agent.id) || (
                    agent.position ? { tileX: agent.position.x, tileY: agent.position.y } : null
                );
                this.recentDepartures.push({
                    agentId: agent.id,
                    name: agent.name || agent.displayName || null,
                    provider: agent.provider || null,
                    parentSessionId: agent.parentSessionId || null,
                    teamName: agent.teamName || null,
                    lastTile,
                    at: performance.now(),
                });
                if (this.recentDepartures.length > MAX_RECENT_DEPARTURES) {
                    this.recentDepartures.splice(0, this.recentDepartures.length - MAX_RECENT_DEPARTURES);
                }
                this._lastSpriteTiles.delete(agent.id);
                this._dirty = true;
            }),
        ];
    }

    dispose() {
        for (const unsubscribe of this.unsubscribers) unsubscribe();
        this.unsubscribers = [];
        this._lastSpriteTiles.clear();
    }

    update({ agentSprites = null, now = performance.now() } = {}) {
        this._prune(now);
        this._rememberSpriteTiles(agentSprites);
        if (this._dirty) {
            this._rebuildMembership();
            this._dirty = false;
        }
        this._rebuildChatPairs(agentSprites);
        this._snapshot = {
            parentToChildren: this._cloneSetMap(this.parentToChildren),
            childToParent: new Map(this.childToParent),
            teamToMembers: new Map(Array.from(this.teamToMembers, ([team, members]) => [team, [...members]])),
            recentArrivals: this.recentArrivals.map(item => ({ ...item, sinceMs: now - item.at })),
            recentDepartures: this.recentDepartures.map(item => ({ ...item, sinceMs: now - item.at })),
            chatPairs: this.chatPairs.map(pair => ({ ...pair })),
        };
        return this._snapshot;
    }

    getSnapshot() {
        return this._snapshot || this.update();
    }

    _rebuildMembership() {
        this.parentToChildren = new Map();
        this.childToParent = new Map();
        this.teamToMembers = new Map();

        for (const agent of this.world?.agents?.values?.() || []) {
            if (agent.parentSessionId) {
                this.childToParent.set(agent.id, agent.parentSessionId);
                if (!this.parentToChildren.has(agent.parentSessionId)) {
                    this.parentToChildren.set(agent.parentSessionId, new Set());
                }
                this.parentToChildren.get(agent.parentSessionId).add(agent.id);
            }
            if (agent.teamName) {
                if (!this.teamToMembers.has(agent.teamName)) this.teamToMembers.set(agent.teamName, []);
                this.teamToMembers.get(agent.teamName).push(agent.id);
            }
        }
    }

    _rebuildChatPairs(agentSprites) {
        const seen = new Set();
        const out = [];
        const sprites = agentSprites?.values ? Array.from(agentSprites.values()) : [];
        for (const sprite of sprites) {
            const aId = sprite.agent?.id;
            const bId = sprite.chatPartner?.agent?.id;
            if (!aId || !bId || aId === bId) continue;
            const key = pairKey(aId, bId);
            if (seen.has(key)) continue;
            seen.add(key);
            out.push({ aId, bId });
        }
        this.chatPairs = out;
    }

    _rememberSpriteTiles(agentSprites) {
        const sprites = agentSprites?.values ? Array.from(agentSprites.values()) : [];
        for (const sprite of sprites) {
            const id = sprite.agent?.id;
            if (!id) continue;
            this._lastSpriteTiles.set(id, this._screenToTile(sprite.x, sprite.y));
        }
    }

    _screenToTile(x, y) {
        return {
            tileX: (x / 32 + y / 16) / 2,
            tileY: (y / 16 - x / 32) / 2,
        };
    }

    _prune(now) {
        this.recentArrivals = this.recentArrivals.filter(item => now - item.at <= ARRIVAL_WINDOW_MS);
        this.recentDepartures = this.recentDepartures.filter(item => now - item.at <= DEPARTURE_WINDOW_MS);
    }

    _cloneSetMap(map) {
        return new Map(Array.from(map, ([key, set]) => [key, new Set(set)]));
    }
}
