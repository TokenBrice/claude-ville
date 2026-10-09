import { eventBus } from '../../domain/events/DomainEvent.js';
import { worldToTile } from './Projection.js';

const ARRIVAL_WINDOW_MS = 8000;
const DEPARTURE_WINDOW_MS = 12000;
const MAX_RECENT_DEPARTURES = 6;
// 4.5 — a dense project's remaining shared files are named by building count,
// never by one thread per pair. Three buildings plus an exact remainder.
const OVERLAP_BUILDING_LIMIT = 3;

function pairKey(aId, bId) {
    return [aId, bId].sort().join('|');
}

function basenameOf(pathText) {
    const segments = String(pathText || '').split(/[\\/]+/).filter(Boolean);
    return segments.at(-1) || String(pathText || '');
}

// Which single peer edge a selected agent shows. Explicit operator intent wins
// (a hovered peer), then a drawable peer, then the loud kind, then established
// concurrency, then the most recent observation, then the path for stability.
function compareOverlapCandidates(a, b) {
    return (a.hoverRank - b.hoverRank)
        || (a.availableRank - b.availableRank)
        || (a.kindRank - b.kindRank)
        || (a.overlapRank - b.overlapRank)
        || ((b.at ?? 0) - (a.at ?? 0))
        || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

// W7.6 — the loud shared-file knots, drawn without selection: two writers on
// one file (recent or concurrent), or a read and a write observed within one
// minute of each other. Ranked loudest first (write-write, then concurrency,
// then the newest observation, then the path), capped at `limit`, one knot
// per (file, pair). A plain recent read-write overlap stays behind selection.
export const AMBIENT_KNOT_LIMIT = 3;
const NO_KNOTS = Object.freeze([]);

export function ambientFileKnots(sprites, { limit = AMBIENT_KNOT_LIMIT } = {}) {
    let drawable = null;
    let knots = null;
    const seen = new Set();
    for (const sprite of sprites || []) {
        const collisions = sprite?.agent?.collisions;
        if (!Array.isArray(collisions) || !collisions.length) continue;
        if (!drawable) {
            drawable = new Set();
            for (const other of sprites) {
                const id = other?.agent?.id ? String(other.agent.id) : '';
                if (id && !other.isArrivalPending?.()) drawable.add(id);
            }
        }
        for (const collision of collisions) {
            const path = typeof collision?.path === 'string' ? collision.path.trim() : '';
            if (!path || !Array.isArray(collision.agents)) continue;
            const write = collision.kind === 'write-write';
            const concurrent = collision.overlapKind === 'concurrent';
            if (!write && !concurrent) continue;
            const observations = (Array.isArray(collision.observations) ? collision.observations : [])
                .filter(entry => drawable.has(String(entry?.agentId ?? '')))
                .sort((a, b) => (Number(b?.at) || 0) - (Number(a?.at) || 0));
            const writer = observations.find(entry => entry?.op === 'write') || null;
            let partner = null;
            if (writer) {
                partner = observations.find(entry => entry !== writer
                    && String(entry.agentId) !== String(writer.agentId)
                    && entry?.op === (write ? 'write' : 'read')) || null;
            }
            let aId = writer ? String(writer.agentId) : '';
            let bId = partner ? String(partner.agentId) : '';
            if (!aId || !bId) {
                // No per-edge observations (older payload): the first two
                // drawable participants.
                const present = collision.agents.map(id => String(id ?? '')).filter(id => drawable.has(id));
                if (present.length < 2) continue;
                [aId, bId] = present;
            }
            const key = `${path}|${pairKey(aId, bId)}`;
            if (seen.has(key)) continue;
            seen.add(key);
            const all = Array.isArray(collision.observations) ? collision.observations : [];
            (knots || (knots = [])).push({
                key,
                path,
                basename: basenameOf(path),
                aId,
                bId,
                kind: write ? 'write-write' : 'read-write',
                overlapKind: concurrent ? 'concurrent' : 'recent',
                writers: all.length ? all.filter(entry => entry?.op === 'write').length : null,
                readers: all.length ? all.filter(entry => entry?.op === 'read').length : null,
                participants: collision.agents.length,
                at: Math.max(0, ...observations.map(entry => Number(entry?.at) || 0)),
            });
        }
    }
    if (!knots) return NO_KNOTS;
    knots.sort((a, b) => ((a.kind === 'write-write' ? 0 : 1) - (b.kind === 'write-write' ? 0 : 1))
        || ((a.overlapKind === 'concurrent' ? 0 : 1) - (b.overlapKind === 'concurrent' ? 0 : 1))
        || (b.at - a.at)
        || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    return knots.length > limit ? knots.slice(0, limit) : knots;
}

function knotsOnlyOverlap(knots) {
    return knots.length
        ? { selectedId: null, edge: null, files: 0, peers: 0, aggregates: NO_KNOTS, otherFiles: 0, knots }
        : null;
}

function isDepartedAgent(agent) {
    return agent?.isDeparted === true
        || (agent?.departedAt !== null
            && agent?.departedAt !== undefined
            && Number.isFinite(Number(agent.departedAt)));
}

/**
 * W7.5 — one muster row per live parent: `out` is the exact count of its
 * children still live, `returned` the exact count of its children seen to
 * leave (departed in place, or removed) while the parent lives. Counts are
 * since this page began observing: a child that left before then is unknown
 * and never counted. A row with nothing out and nothing back is no squad.
 * Ordered by most still out, then most returned, then name and id, so the
 * busiest wave leads and ties never churn.
 */
export function squadRollups({ parentToChildren = null, returnedByParent = null, agents = null } = {}) {
    const byId = agents instanceof Map
        ? agents
        : new Map([...(agents || [])].filter(agent => agent?.id).map(agent => [agent.id, agent]));
    const parentIds = new Set([
        ...(parentToChildren?.keys?.() || []),
        ...(returnedByParent?.keys?.() || []),
    ]);
    const rows = [];
    for (const parentId of parentIds) {
        const parent = byId.get(parentId);
        if (!parent || isDepartedAgent(parent)) continue;
        const returned = new Set(returnedByParent?.get(parentId) || []);
        let out = 0;
        for (const childId of parentToChildren?.get(parentId) || []) {
            const child = byId.get(childId);
            if (!child) continue;
            if (isDepartedAgent(child)) {
                returned.add(childId);
            } else {
                // A resumed child is out again, never both.
                returned.delete(childId);
                out += 1;
            }
        }
        if (out === 0 && returned.size === 0) continue;
        rows.push({
            parentId,
            name: String(parent.displayName || parent.name || parentId),
            project: String(parent.projectPath || parent.project || ''),
            out,
            returned: returned.size,
        });
    }
    return rows.sort((a, b) => (b.out - a.out)
        || (b.returned - a.returned)
        || a.name.localeCompare(b.name)
        || String(a.parentId).localeCompare(String(b.parentId)));
}

/**
 * W7.5 — the Command plaque's muster lines from `squadRollups`. Every squad
 * fits up to `maxRows`; past that, `maxRows - 1` squads and one exact
 * `+N squads` line naming every squad not drawn (TaskboardBoardModel's
 * truthful-overflow convention: never "about", never a bare ellipsis).
 */
export function squadMusterLines(rollups, { maxRows = 3 } = {}) {
    const squads = Array.isArray(rollups) ? rollups : [];
    const limit = Math.max(1, Math.trunc(Number(maxRows)) || 1);
    if (squads.length <= limit) return squads.map(squad => ({ kind: 'squad', ...squad }));
    const shown = squads.slice(0, limit - 1).map(squad => ({ kind: 'squad', ...squad }));
    const hidden = squads.length - shown.length;
    shown.push({ kind: 'more', count: hidden, text: `+${hidden} squad${hidden === 1 ? '' : 's'}` });
    return shown;
}

export class RelationshipState {
    constructor(world) {
        this.world = world;
        this.parentToChildren = new Map();
        this.childToParent = new Map();
        this.teamToMembers = new Map();
        this.advisorPairs = [];
        this.recentArrivals = [];
        this.recentDepartures = [];
        this.chatPairs = [];
        // 4.5 — the shared-file overlap snapshot. Separately named: it is
        // observation evidence about files, not a family/team/advisor bond, and
        // it never stacks onto those rings.
        this.fileOverlap = null;
        // W7.5 — child ids seen to leave, per parent, held while the parent
        // lives (recentDepartures is a 12 s cue window, too short to muster).
        this._returnedByParent = new Map();
        this._lastSpriteTiles = new Map();
        this._currentSpriteIds = new Set();
        this._membershipDirty = true;
        this._lastMembership = new Map();
        this._cachedSnapshotTeamToMembersArrays = new Map();
        this._snapshot = null;
        this._disposed = false;
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
                if (agent.parentSessionId) {
                    let returned = this._returnedByParent.get(agent.parentSessionId);
                    if (!returned) {
                        returned = new Set();
                        this._returnedByParent.set(agent.parentSessionId, returned);
                    }
                    returned.add(agent.id);
                }
                this._returnedByParent.delete(agent.id);
                if (this.recentDepartures.length > MAX_RECENT_DEPARTURES) {
                    this.recentDepartures.splice(0, this.recentDepartures.length - MAX_RECENT_DEPARTURES);
                }
                this._lastSpriteTiles.delete(agent.id);
                this._membershipDirty = true;
            }),
        ];
    }

    dispose() {
        if (this._disposed) return;
        this._disposed = true;
        for (const unsubscribe of this.unsubscribers) unsubscribe();
        this.unsubscribers = [];
        this.parentToChildren.clear();
        this.childToParent.clear();
        this.teamToMembers.clear();
        this.advisorPairs = [];
        this.recentArrivals = [];
        this.recentDepartures = [];
        this._returnedByParent.clear();
        this.chatPairs = [];
        this._lastSpriteTiles.clear();
        this._currentSpriteIds.clear();
        this._lastMembership.clear();
        this._cachedSnapshotTeamToMembersArrays.clear();
        this._snapshot = null;
        this.world = null;
    }

    update({ agentSprites = null, now = performance.now() } = {}) {
        if (this._disposed) return null;
        this.reconcile({ agentSprites, now });
        return this._snapshot;
    }

    reconcile({ agentSprites = null, now = performance.now() } = {}) {
        if (this._disposed) return this;
        this._prune(now);
        const sprites = agentSprites?.values ? Array.from(agentSprites.values()) : [];
        this._rememberSpriteTiles(sprites);
        if (this._membershipDirty) {
            this._rebuildMembership();
            this._membershipDirty = false;
            // A tally whose parent the world no longer holds has no muster.
            const worldAgents = this.world?.agents;
            if (typeof worldAgents?.has === 'function') {
                for (const parentId of this._returnedByParent.keys()) {
                    if (!worldAgents.has(parentId)) this._returnedByParent.delete(parentId);
                }
            }
        }
        this._rebuildChatPairs(sprites);
        this._rebuildFileOverlap(sprites);
        this._snapshot = {
            parentToChildren: this.parentToChildren,
            childToParent: this.childToParent,
            teamToMembers: this._cachedSnapshotTeamToMembersArrays,
            recentArrivals: this.recentArrivals.map(item => ({ ...item, sinceMs: now - item.at })),
            recentDepartures: this.recentDepartures.map(item => ({ ...item, sinceMs: now - item.at })),
            chatPairs: this.chatPairs.map(pair => ({ ...pair })),
            advisorPairs: this.advisorPairs.map(pair => ({ ...pair })),
            fileOverlap: this.fileOverlap,
            squads: this.getSquadRollups(),
        };
        return this;
    }

    getSnapshot() {
        if (this._disposed) return null;
        return this._snapshot || this.update();
    }

    getSquadRollups() {
        return squadRollups({
            parentToChildren: this.parentToChildren,
            returnedByParent: this._returnedByParent,
            agents: this.world?.agents || null,
        });
    }

    getDiagnostics() {
        return {
            parents: this.parentToChildren.size,
            squads: this.getSquadRollups().length,
            children: this.childToParent.size,
            teams: this.teamToMembers.size,
            recentArrivals: this.recentArrivals.length,
            recentDepartures: this.recentDepartures.length,
            chatPairs: this.chatPairs.length,
            advisorPairs: this.advisorPairs.length,
            overlapFiles: this.fileOverlap?.files || 0,
            overlapPeers: this.fileOverlap?.peers || 0,
            rememberedSpriteTiles: this._lastSpriteTiles.size,
            rememberedMemberships: this._lastMembership.size,
            disposed: this._disposed,
        };
    }

    _rebuildMembership() {
        this.parentToChildren.clear();
        this.childToParent.clear();
        this.teamToMembers.clear();
        this.advisorPairs = [];
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
            if (agent.isAdvisor) {
                this.advisorPairs.push({ advisorId: agent.id, parentId: parentSessionId });
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

    /**
     * 4.5 — the shared-file overlap snapshot for the selected agent.
     *
     * Server-detected `agent.collisions` are exact canonical-path overlaps with
     * per-edge observation times. This picks *one* peer edge (a hovered peer
     * first, so the operator cycles edges by explicit selection/hover) and
     * reduces every remaining shared file to exact per-building counts, so a
     * hundred agents can never produce pairwise threads.
     */
    _rebuildFileOverlap(sprites) {
        // W7.6 — the loudest knots stand with or without a selection; the
        // single-selection thread below covers the rest.
        const knots = ambientFileKnots(sprites);
        let selected = null;
        let hoveredId = '';
        for (const sprite of sprites) {
            const id = sprite.agent?.id ? String(sprite.agent.id) : '';
            if (!id) continue;
            if (sprite.selected) selected = sprite;
            else if (sprite.hovered) hoveredId = id;
        }
        const collisions = Array.isArray(selected?.agent?.collisions) ? selected.agent.collisions : [];
        if (!selected || !collisions.length) {
            this.fileOverlap = knotsOnlyOverlap(knots);
            return;
        }

        const selectedId = String(selected.agent.id);
        const drawable = new Set();
        for (const sprite of sprites) {
            const id = sprite.agent?.id ? String(sprite.agent.id) : '';
            if (id && !sprite.isArrivalPending?.()) drawable.add(id);
        }

        const paths = new Set();
        const peers = new Set();
        const candidates = [];
        for (const collision of collisions) {
            const path = typeof collision?.path === 'string' ? collision.path.trim() : '';
            if (!path || !Array.isArray(collision.agents)) continue;
            const observations = Array.isArray(collision.observations) ? collision.observations : [];
            const writers = observations.length
                ? observations.filter(entry => entry?.op === 'write').length
                : null;
            const readers = observations.length
                ? observations.filter(entry => entry?.op === 'read').length
                : null;
            paths.add(path);
            for (const rawId of collision.agents) {
                const peerId = String(rawId ?? '');
                if (!peerId || peerId === selectedId) continue;
                peers.add(peerId);
                const observation = observations.find(entry => String(entry?.agentId ?? '') === peerId) || null;
                const at = Number.isFinite(observation?.at) ? observation.at : null;
                const available = drawable.has(peerId);
                candidates.push({
                    peerId,
                    path,
                    kind: collision.kind === 'write-write' ? 'write-write' : 'read-write',
                    overlapKind: collision.overlapKind === 'concurrent' ? 'concurrent' : 'recent',
                    writers,
                    readers,
                    participants: collision.agents.length,
                    peerOp: observation?.op === 'write' || observation?.op === 'read' ? observation.op : null,
                    at,
                    available,
                    hoverRank: peerId === hoveredId ? 0 : 1,
                    availableRank: available ? 0 : 1,
                    kindRank: collision.kind === 'write-write' ? 0 : 1,
                    overlapRank: collision.overlapKind === 'concurrent' ? 0 : 1,
                });
            }
        }
        if (!candidates.length) {
            this.fileOverlap = knotsOnlyOverlap(knots);
            return;
        }

        candidates.sort(compareOverlapCandidates);
        const edge = candidates[0];
        const agents = this.world?.agents;

        // Remaining files: one exact count per building where a peer is working.
        const filesByBuilding = new Map();
        const placed = new Set();
        for (const candidate of candidates) {
            if (candidate.path === edge.path) continue;
            const peer = agents?.get?.(candidate.peerId) || null;
            const building = peer?.targetBuildingType || peer?.lastKnownBuildingType || null;
            if (!building) continue;
            let bucket = filesByBuilding.get(building);
            if (!bucket) { bucket = new Set(); filesByBuilding.set(building, bucket); }
            bucket.add(candidate.path);
            placed.add(candidate.path);
        }
        const aggregates = [...filesByBuilding.entries()]
            .map(([building, bucket]) => ({ building, files: bucket.size }))
            .sort((a, b) => (b.files - a.files) || (a.building < b.building ? -1 : a.building > b.building ? 1 : 0));
        const shown = aggregates.slice(0, OVERLAP_BUILDING_LIMIT);
        const remainder = aggregates.slice(OVERLAP_BUILDING_LIMIT)
            .reduce((total, entry) => total + entry.files, 0);
        const unplaced = [...paths].filter(path => path !== edge.path && !placed.has(path)).length;

        this.fileOverlap = {
            selectedId,
            edge: {
                peerId: edge.peerId,
                peerName: agents?.get?.(edge.peerId)?.name || edge.peerId,
                path: edge.path,
                basename: basenameOf(edge.path),
                kind: edge.kind,
                overlapKind: edge.overlapKind,
                writers: edge.writers,
                readers: edge.readers,
                participants: edge.participants,
                peerOp: edge.peerOp,
                observedAt: edge.at,
                available: edge.available,
            },
            files: paths.size,
            peers: peers.size,
            aggregates: shown,
            otherFiles: remainder + unplaced,
            // The selected thread already draws its own edge.
            knots: knots.filter(knot => knot.path !== edge.path
                || knot.key !== `${edge.path}|${pairKey(selectedId, edge.peerId)}`),
        };
    }

    _rememberSpriteTiles(sprites) {
        this._currentSpriteIds.clear();
        for (const sprite of sprites) {
            const id = sprite.agent?.id;
            if (!id) continue;
            this._currentSpriteIds.add(id);
            this._lastSpriteTiles.set(id, this._screenToTile(sprite.x, sprite.y));
        }
        // Gate-transit bodies remain current sprites after agent:removed.
        // Departure cues own their tile already; only finished bodies leave here.
        for (const id of this._lastSpriteTiles.keys()) {
            if (!this._currentSpriteIds.has(id)) this._lastSpriteTiles.delete(id);
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
