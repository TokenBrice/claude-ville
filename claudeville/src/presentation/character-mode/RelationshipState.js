import { eventBus } from '../../domain/events/DomainEvent.js';
import { tileToWorld, worldToTile } from './Projection.js';
import { AgentStatus } from '../../domain/value-objects/AgentStatus.js';
import { AMBIENT_SCENIC_POINTS } from '../../config/scenery.js';

const ARRIVAL_WINDOW_MS = 8000;
const DEPARTURE_WINDOW_MS = 12000;
const MAX_RECENT_DEPARTURES = 6;

// #38 — idle gossip clusters. When 2-3 IDLE villagers loiter near the same
// scenic point they form a standing chat knot. Detection is cheap (a screen
// distance check against the precomputed scenic-point world positions) and
// runs on the relationship cadence, not per frame.
const GOSSIP_RADIUS_PX = 30;
const GOSSIP_MIN_MEMBERS = 2;
const GOSSIP_MAX_MEMBERS = 3;
const _scenicPointWorld = AMBIENT_SCENIC_POINTS.map(point => ({
    id: point.id,
    ...tileToWorld({ tileX: point.tileX, tileY: point.tileY }),
}));

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
        this.gossipClusters = [];
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
        const sprites = agentSprites?.values ? Array.from(agentSprites.values()) : [];
        this._rememberSpriteTiles(sprites);
        if (this._membershipDirty) {
            this._rebuildMembership();
            this._membershipDirty = false;
        }
        this._rebuildChatPairs(sprites);
        this._rebuildGossipClusters(sprites);
        this._snapshot = {
            parentToChildren: this.parentToChildren,
            childToParent: this.childToParent,
            teamToMembers: this._cachedSnapshotTeamToMembersArrays,
            recentArrivals: this.recentArrivals.map(item => ({ ...item, sinceMs: now - item.at })),
            recentDepartures: this.recentDepartures.map(item => ({ ...item, sinceMs: now - item.at })),
            chatPairs: this.chatPairs.map(pair => ({ ...pair })),
            gossipClusters: this.gossipClusters.map(cluster => ({
                ...cluster,
                memberIds: [...cluster.memberIds],
            })),
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

    _rebuildChatPairs(sprites) {
        const seen = new Set();
        const out = [];
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

    // #38 — group loitering IDLE villagers near each scenic point into standing
    // gossip knots. A sprite is eligible when it is IDLE, not already in a
    // pairwise SendMessage chat, not pending arrival, and not in its own
    // post-gossip cooldown (tracked on the sprite). Each scenic point yields at
    // most one cluster of 2-3 members; clusters carry a screen-space centroid so
    // members can rotate to face it and the renderer can draw the knot triangle.
    _rebuildGossipClusters(sprites) {
        if (sprites.length < GOSSIP_MIN_MEMBERS) { this.gossipClusters = []; return; }

        const taken = new Set();
        const out = [];
        for (const point of _scenicPointWorld) {
            const near = [];
            for (const sprite of sprites) {
                const id = sprite.agent?.id;
                if (!id || taken.has(id)) continue;
                if (sprite.agent?.status !== AgentStatus.IDLE) continue;
                if (sprite.chatPartner || (sprite.chatting && !sprite.isGossiping?.())) continue;
                if (sprite.isArrivalPending?.()) continue;
                if (sprite.isGossipCoolingDown?.()) continue;
                if (Math.hypot(sprite.x - point.x, sprite.y - point.y) > GOSSIP_RADIUS_PX) continue;
                near.push(sprite);
                if (near.length >= GOSSIP_MAX_MEMBERS) break;
            }
            if (near.length < GOSSIP_MIN_MEMBERS) continue;
            const cx = near.reduce((sum, s) => sum + s.x, 0) / near.length;
            const cy = near.reduce((sum, s) => sum + s.y, 0) / near.length;
            for (const sprite of near) taken.add(sprite.agent.id);
            out.push({
                id: point.id,
                cx,
                cy,
                memberIds: near.map(s => s.agent.id),
            });
        }
        this.gossipClusters = out;
    }

    _rememberSpriteTiles(sprites) {
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
