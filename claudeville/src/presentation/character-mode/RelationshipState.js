import { eventBus } from '../../domain/events/DomainEvent.js';
import { worldToTile } from './Projection.js';

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
        this._membershipDirty = true;
        this._lastMembership = new Map();
        this._cachedSnapshotTeamToMembersArrays = new Map();
        this._snapshot = null;
        this.unsubscribers = [
            eventBus.on('agent:added', (agent) => {
                this.recentArrivals.push({ agentId: agent.id, at: performance.now() });
                this._membershipDirty = true;
            }),
            eventBus.on('agent:updated', (agent) => {
                if (!agent || !agent.id) { this._membershipDirty = true; return; }
                const prev = this._lastMembership.get(agent.id);
                const nextParent = agent.parentSessionId || null;
                const nextTeam = agent.teamName || null;
                if (!prev || prev.parentSessionId !== nextParent || prev.teamName !== nextTeam) {
                    this._membershipDirty = true;
                }
            }),
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
                this._membershipDirty = true;
            }),
        ];
    }

    dispose() {
        for (const unsubscribe of this.unsubscribers) unsubscribe();
        this.unsubscribers = [];
        this._lastSpriteTiles.clear();
        this._lastMembership.clear();
        this._cachedSnapshotTeamToMembersArrays.clear();
    }

    update({ agentSprites = null, now = performance.now() } = {}) {
        this._prune(now);
        this._rememberSpriteTiles(agentSprites);
        if (this._membershipDirty) {
            this._rebuildMembership();
            this._membershipDirty = false;
        }
        this._rebuildChatPairs(agentSprites);
        this._snapshot = {
            parentToChildren: this.parentToChildren,
            childToParent: this.childToParent,
            teamToMembers: this._cachedSnapshotTeamToMembersArrays,
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
        this.parentToChildren.clear();
        this.childToParent.clear();
        this.teamToMembers.clear();
        this._lastMembership.clear();
        this._cachedSnapshotTeamToMembersArrays.clear();

        for (const agent of this.world?.agents?.values?.() || []) {
            const parentSessionId = agent.parentSessionId || null;
            const teamName = agent.teamName || null;
            this._lastMembership.set(agent.id, { parentSessionId, teamName });
            if (parentSessionId) {
                this.childToParent.set(agent.id, parentSessionId);
                let bucket = this.parentToChildren.get(parentSessionId);
                if (!bucket) {
                    bucket = new Set();
                    this.parentToChildren.set(parentSessionId, bucket);
                }
                bucket.add(agent.id);
            }
            if (teamName) {
                let members = this.teamToMembers.get(teamName);
                if (!members) {
                    members = new Set();
                    this.teamToMembers.set(teamName, members);
                }
                members.add(agent.id);
            }
        }

        for (const [team, members] of this.teamToMembers) {
            this._cachedSnapshotTeamToMembersArrays.set(team, [...members]);
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
        return worldToTile(x, y);
    }

    _prune(now) {
        this.recentArrivals = this.recentArrivals.filter(item => now - item.at <= ARRIVAL_WINDOW_MS);
        this.recentDepartures = this.recentDepartures.filter(item => now - item.at <= DEPARTURE_WINDOW_MS);
    }
}
