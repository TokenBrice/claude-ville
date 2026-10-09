import { normalizeBuildingType, VISIT_OVERFLOW_TILES } from '../../config/buildings.js';
import { TILE_HEIGHT, TILE_WIDTH } from '../../config/constants.js';
import { AMBIENT_GROUND_PROPS, DISTRICT_PROPS, SCENIC_POINT_PROPS } from '../../config/scenery.js';
import { APPROACH_FILES, COMMAND_QUEUE, inVillageMasonry, REST_SEATS } from '../../config/townPlan.js';
import { AgentStatus } from '../../domain/value-objects/AgentStatus.js';
import { compareByWaitAge, waitAnchor } from '../../domain/services/SignalLedger.js';
import { summarizeCrowdClusterEntries } from './CrowdClusters.js';
import { projectKeyFor, updateHomeDistrictContext } from './HomeDistrict.js';
import { errandCap, ROUTINE_ROLES, STROLL_CAP } from './CrowdRoutine.js';
import { restSeatStepBias } from './DayRoutine.js';

const DEFAULT_RESERVATION_TTL_MS = 20000;
const TILE_OCCUPANCY_RADIUS = 0.78;
const BUILDING_OCCUPANCY_RADIUS = 1.15;
const WALKABILITY_PENALTY = 240;
const RESERVED_PENALTY = 180;
const TILE_CROWD_PENALTY = 70;
const BUILDING_CROWD_PENALTY = 18;
// PL-P14 — past capacity a slot costs `over² × k`, so the allocator tells
// the 6th body at a five-slot building (over 1) from the 11th (over 6).
const OVER_CAPACITY_PENALTY_K = 130;
export function overCapacityPenalty(over) {
    const n = Math.max(0, Number(over) || 0);
    return n * n * OVER_CAPACITY_PENALTY_K;
}
const DISTANCE_WEIGHT = 0.15;
const SAME_AGENT_SLOT_BONUS = 90;
const RELATED_CLUSTER_BONUS = 45;
const RELATED_CLUSTER_RADIUS = 3.0;
const TARGET_SLOT_INDEX_BONUS = 80;
const LOCAL_CLUSTER_RADIUS = 2.4;
const LOCAL_CLUSTER_PENALTY = 12;
const CROWD_CLUSTER_CELL_SIZE = 4;
const CROWD_CLUSTER_TOP_LIMIT = 12;

// Plans 7.1 / 7.2 — occupancy places outside any building. Their reservations
// carry their own building types, so they never raise a building's load,
// capacity or congestion (V8: rest and queue occupants are not visitors).
export const REST_SEAT_BUILDING_TYPE = 'rest-seat';
export const COMMAND_QUEUE_BUILDING_TYPE = 'command-queue';
// A seat or queue place is held for as long as its occupant renews it (the
// sprite renews every 5 s while it waits); a vanished agent frees it in 60 s.
const PLACE_RESERVATION_TTL_MS = 60000;
// Where an idle villager stands when every seat is taken: beside the nearest
// seat, on the first free walkable tile of this ring (tile offsets).
const SEAT_STAND_RING = Object.freeze([
    [1, 1], [-1, 1], [1, -1], [-1, -1], [2, 0], [0, 2], [-2, 0], [0, -2], [2, 1], [1, 2], [-2, 1], [1, -2],
]);
// Seat ranking: a seat the walk search cannot reach ranks after every
// reachable one.
const SEAT_UNREACHED_STEPS = 10000;
const WALK_STEPS = Object.freeze([[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]);
const FACING_TILE_STEP = Object.freeze({ 'south-east': [1, 0], 'south-west': [0, 1] });

// A standing body never covers a fixture: a brazier, lantern, well, cart,
// stall, sign or crate, or a bench it does not sit on. A body standing in
// front of a fixture is drawn over it, so its box (`FIXTURE_BODY.halfPx`
// either side of the foot, `heightPx` up) keeps off the fixture's standing
// part: the foot stays out of the box `half + halfPx` across, `backPx` behind
// and `heightPx - rise` in front of the fixture's foot. `half` is the
// half-width of the fixture sprite's standing part (alpha > 128, world px) and
// `rise` the height of that part's lowest row above the foot: a brazier's
// bowl, a stall's awning, a cart's bed, a lantern's post and lamp or a sign's
// post and arm (above their ground plinth), a bench's timber seat. A body
// behind a fixture is drawn under it. Walkers may pass; standing places
// (visit slots, the seat stand ring, fan places, landings, queue slots) are
// checked. Step, rim and pier seats draw only under a sitter, so they are no
// fixture.
const FIXTURE_BODY = Object.freeze({ halfPx: 16, heightPx: 60, backPx: 8 });
const FIXTURE_PARTS = Object.freeze({
    'prop.runeBrazier': [14, 0], 'prop.lantern': [5, 16], 'prop.bridgeLanternPost': [6, 0],
    'prop.well': [22, 0], 'prop.oreCart': [19, 0], 'prop.flowerCart': [24, 0],
    'prop.marketStall': [32, 0], 'prop.marketStall.ochre': [32, 0], 'prop.marketStall.canvas': [32, 0],
    'prop.signpost': [13, 0], 'prop.noticePillar': [21, 0],
    'prop.runestone': [11, 0], 'prop.scrollCrates': [19, 0], 'prop.netRack': [14, 0],
    // W8.3c garden furniture (scenery.js DISTRICT_PROPS).
    'veg.hedgerow': [25, 0], 'prop.trellisArch': [22, 0], 'prop.torchSconce': [8, 0],
    'prop.cairn': [8, 0], 'prop.wellTrough': [21, 0], 'prop.laundryLine': [25, 0],
    // W8.3b avenue + farm (half-widths of the alpha > 128 standing part).
    'prop.marketStall.bread': [19, 0], 'prop.milestone': [7, 0],
    'prop.farm.dovecote': [16, 0], 'prop.farm.scarecrow': [16, 0], 'prop.farm.hayWagon': [25, 0],
    // W8.3a harbour quay, smithy and mine yards.
    'prop.saltCrates': [20, 0], 'prop.crabPots': [18, 0], 'prop.anchorChain': [17, 0], 'prop.bollardPair': [15, 0],
    'prop.fishRack': [22, 0], 'prop.firewoodStack': [22, 0], 'prop.bellowsBench': [19, 0], 'prop.barrelStack': [15, 0],
    'prop.grindstone': [15, 0], 'prop.toolRack': [20, 0], 'prop.wheelbarrow': [17, 0], 'prop.slagHeap': [18, 0],
    'prop.oreSacks': [18, 0],
    bench: [14, 0],
});
const fixtureFoot = (tileX, tileY, [half, rise], seatId = null) => Object.freeze({
    x: (tileX - tileY) * TILE_WIDTH / 2,
    y: (tileX + tileY) * TILE_HEIGHT / 2,
    xPx: half + FIXTURE_BODY.halfPx,
    frontPx: FIXTURE_BODY.heightPx - rise,
    seatId,
});
const FIXTURE_FEET = Object.freeze([
    ...DISTRICT_PROPS.map(prop => [prop, prop.id]),
    ...SCENIC_POINT_PROPS.map(prop => [prop, prop.id]),
    ...AMBIENT_GROUND_PROPS.map(prop => [prop, `prop.${prop.type}`]),
].filter(([, id]) => FIXTURE_PARTS[id])
    .map(([prop, id]) => fixtureFoot(prop.tileX, prop.tileY, FIXTURE_PARTS[id]))
    .concat(REST_SEATS.filter(seat => seat.occluder === 'bench')
        .map(seat => fixtureFoot(seat.tileX, seat.tileY, FIXTURE_PARTS.bench, seat.id))));

// True when a body standing at world (x, y) covers a fixture, or stands on
// the village's stone (the curtain, gatehouse or sea tower: townPlan
// `inVillageMasonry`, a body's half-width of reach). `seatId` is the bench
// its body sits on, which it may cover.
export function standsOnFixture(x, y, seatId = null) {
    if (inVillageMasonry((x / (TILE_WIDTH / 2) + y / (TILE_HEIGHT / 2)) / 2, (y / (TILE_HEIGHT / 2) - x / (TILE_WIDTH / 2)) / 2, 0.3)) return true;
    for (const foot of FIXTURE_FEET) {
        if (seatId && foot.seatId === seatId) continue;
        const dy = y - foot.y;
        if (Math.abs(x - foot.x) < foot.xPx && dy > -FIXTURE_BODY.backPx && dy < foot.frontPx) return true;
    }
    return false;
}

const BUILDING_CAPACITY_OVERRIDES = Object.freeze({
    command: 5,
    taskboard: 4,
    forge: 4,
    mine: 4,
    archive: 4,
    observatory: 3,
    portal: 4,
    harbor: 4,
    watchtower: 2,
});

export class VisitTileAllocator {
    constructor({
        reservationTtlMs = DEFAULT_RESERVATION_TTL_MS,
    } = {}) {
        this.reservationTtlMs = Math.max(1000, Number(reservationTtlMs) || DEFAULT_RESERVATION_TTL_MS);
        this.buildings = new Map();
        this.agentSprites = [];
        this.pathfinder = null;
        this.reservations = new Map();
        this.agentReservationIds = new Map();
        this.agentMeta = new Map();
        this._relatedCache = new Map();
        this._sequence = 0;
        this.metrics = {
            allocations: 0,
            rejected: 0,
            releases: 0,
            renewals: 0,
            expired: 0,
            staleReleases: 0,
            unwalkableSkipped: 0,
            scenicAllocations: 0,
            overflowAllocations: 0,
            clusteredAllocations: 0,
            queuedAllocations: 0,
            overCapacityAllocations: 0,
            clusterPressureAllocations: 0,
            routineRefusals: 0,
        };
        this._occupancyEntries = [];
        this._occupancyBuckets = new Map();
        this._crowdClusters = [];
        this._disposed = false;
    }

    updateContext({
        buildings = this.buildings,
        agentSprites = this.agentSprites,
        pathfinder = this.pathfinder,
    } = {}) {
        if (this._disposed) return this;
        this.buildings = this._normalizeBuildings(buildings);
        this.agentSprites = this._normalizeAgentSprites(agentSprites);
        this.pathfinder = pathfinder || null;
        this._rebuildAgentMeta();
        this._rebuildOccupancyIndex();
        updateHomeDistrictContext(this.agentSprites);
        this.cleanup(Date.now());
        this._releaseStaleAgentReservations();
        return this;
    }

    _rebuildAgentMeta() {
        this.agentMeta.clear();
        this._relatedCache.clear();
        for (const sprite of this.agentSprites) {
            const agent = sprite?.agent;
            const id = this._agentId(agent, sprite, null);
            if (!id) continue;
            this.agentMeta.set(id, {
                teamName: agent?.teamName || null,
                parentSessionId: agent?.parentSessionId || null,
                isSubagent: !!agent?.isSubagent,
                projectKey: projectKeyFor(agent),
            });
        }
    }

    _relatedAgentIds(agentId) {
        if (!agentId) return null;
        if (this._relatedCache.has(agentId)) return this._relatedCache.get(agentId);
        const self = this.agentMeta.get(agentId);
        if (!self) {
            this._relatedCache.set(agentId, null);
            return null;
        }
        const related = new Set();
        if (self.parentSessionId) related.add(self.parentSessionId);
        for (const [otherId, meta] of this.agentMeta.entries()) {
            if (otherId === agentId) continue;
            if (meta.parentSessionId && meta.parentSessionId === agentId) related.add(otherId);
            if (self.parentSessionId && meta.parentSessionId && self.parentSessionId === meta.parentSessionId) related.add(otherId);
            if (self.teamName && meta.teamName && self.teamName === meta.teamName) related.add(otherId);
        }
        const result = related.size > 0 ? related : null;
        this._relatedCache.set(agentId, result);
        return result;
    }

    _rebuildOccupancyIndex() {
        this._occupancyEntries = [];
        this._occupancyBuckets = new Map();
        for (const sprite of this.agentSprites) {
            const agentId = this._agentId(sprite?.agent, sprite, null);
            if (!agentId) continue;
            const tile = this._spriteTile(sprite) || this._agentTile(sprite?.agent);
            if (!tile) continue;
            const entry = {
                agentId,
                tileX: tile.tileX,
                tileY: tile.tileY,
                status: sprite?.agent?.status || null,
                teamName: sprite?.agent?.teamName || null,
                parentSessionId: sprite?.agent?.parentSessionId || null,
                moving: !!sprite?.moving,
            };
            this._occupancyEntries.push(entry);
            const key = this._occupancyBucketKey(tile.tileX, tile.tileY);
            const bucket = this._occupancyBuckets.get(key) || [];
            bucket.push(entry);
            this._occupancyBuckets.set(key, bucket);
        }
        this._crowdClusters = this._summarizeCrowdClustersFromEntries();
    }

    _occupancyBucketKey(tileX, tileY) {
        return `${Math.floor(Number(tileX) || 0)},${Math.floor(Number(tileY) || 0)}`;
    }

    _nearbyOccupancyEntries(tileX, tileY, radius) {
        const x = Number(tileX);
        const y = Number(tileY);
        const r = Math.max(0, Number(radius) || 0);
        if (!Number.isFinite(x) || !Number.isFinite(y) || !this._occupancyBuckets?.size) return [];
        const out = [];
        for (let bx = Math.floor(x - r); bx <= Math.floor(x + r); bx++) {
            for (let by = Math.floor(y - r); by <= Math.floor(y + r); by++) {
                const bucket = this._occupancyBuckets.get(`${bx},${by}`);
                if (bucket?.length) out.push(...bucket);
            }
        }
        return out;
    }

    _clusterPressureAt(tileX, tileY, ignoredAgentId) {
        if ((this._occupancyEntries?.length || 0) < 18) return 0;
        let count = 0;
        for (const entry of this._nearbyOccupancyEntries(tileX, tileY, LOCAL_CLUSTER_RADIUS)) {
            if (ignoredAgentId && entry.agentId === ignoredAgentId) continue;
            if (this._distance(entry, { tileX, tileY }) <= LOCAL_CLUSTER_RADIUS) count++;
        }
        return count;
    }

    _summarizeCrowdClustersFromEntries() {
        return summarizeCrowdClusterEntries(this._occupancyEntries, {
            cellSize: CROWD_CLUSTER_CELL_SIZE,
            topLimit: CROWD_CLUSTER_TOP_LIMIT,
            includeStatusCounts: true,
        }).clusters;
    }

    _crowdSnapshot() {
        const clusters = this._crowdClusters || [];
        return {
            agentCount: this._occupancyEntries?.length || 0,
            clusterCellSize: CROWD_CLUSTER_CELL_SIZE,
            clusters,
            denseClusterCount: clusters.length,
            maxClusterSize: clusters.reduce((max, cluster) => Math.max(max, cluster.count || 0), 0),
            congestedAgents: clusters.reduce((sum, cluster) => sum + (cluster.count || 0), 0),
        };
    }

    _nearestRelatedReservationDistance(agentId, buildingType, slot) {
        const related = this._relatedAgentIds(agentId);
        if (!related) return Infinity;
        let best = Infinity;
        for (const reservation of this.reservations.values()) {
            if (reservation.buildingType !== buildingType) continue;
            if (reservation.agentId === agentId) continue;
            if (!related.has(reservation.agentId)) continue;
            const dist = this._distance(reservation, slot);
            if (dist < best) best = dist;
        }
        return best;
    }

    // W4.3 / W4.4 — `role` names a living-crowd routine leg ('stroll',
    // 'errand', 'winddown'); the reservation carries it so the caps count
    // live holders. `routineCap` lowers the stroll cap (DayRoutine night).
    // `dayHour` tilts the rest-seat pick toward the brazier steps at night.
    allocate({
        agent,
        sprite = null,
        building = null,
        intent = null,
        candidates = null,
        role = null,
        routineCap = null,
        dayHour = null,
    } = {}) {
        if (this._disposed) return null;
        const now = Date.now();
        this.cleanup(now);

        const agentId = this._agentId(agent, sprite, intent);
        if (!agentId) {
            this.metrics.rejected++;
            return null;
        }

        // 7.1 / 7.2 — rest seats and the Command queue are places, not
        // buildings: their slot is chosen by distance or by wait rank.
        if (building?.restSeats) return this._allocateRestSeat({ agentId, agent, sprite, now, dayHour });
        if (building?.commandQueue) return this._allocateQueuePlace({ agentId, now });

        const routine = ROUTINE_ROLES.includes(role) ? role : null;
        if (routine && this.routineHolders(routine, now, agentId) >= this.routineCap(routine, routineCap)) {
            this.metrics.routineRefusals++;
            return null;
        }

        const resolvedBuilding = this._resolveBuilding(building, intent);
        const buildingType = this._buildingType(resolvedBuilding, intent);
        const slots = this._candidateTiles({
            building: resolvedBuilding,
            buildingType,
            candidates,
        });
        if (slots.length === 0) {
            this.metrics.rejected++;
            return null;
        }

        const existingReservation = this._reservationForAgent(agentId);
        const sourceTile = this._spriteTile(sprite) || this._agentTile(agent);
        const buildingCapacity = this._buildingCapacity(resolvedBuilding, buildingType, slots.length, intent);
        const buildingOccupancy = this._buildingOccupancy(resolvedBuilding, buildingType, agentId);
        const hasWalkableSlot = slots.some((slot) => this._isStandable(slot.tileX, slot.tileY));

        let best = null;
        for (const slot of slots) {
            const scored = this._scoreSlot({
                slot,
                agentId,
                buildingType,
                sourceTile,
                buildingCapacity,
                buildingOccupancy,
                existingReservation,
                intent,
                now,
            });
            if (hasWalkableSlot && !scored.walkable) {
                this.metrics.unwalkableSkipped++;
                continue;
            }
            if (!best || scored.score < best.score || (scored.score === best.score && scored.slotId < best.slotId)) {
                best = scored;
            }
        }

        if (!best) {
            this.metrics.rejected++;
            return null;
        }

        // W4.2 — door discipline: past capacity a working visitor waits in
        // its landmark's approach file, then its outer ring, by arrival.
        best = this._lineSlot({
            agentId,
            building: resolvedBuilding,
            buildingType,
            intent,
            candidates,
            best,
            buildingCapacity,
            existingReservation,
            now,
        }) || best;

        const previousReservationId = this.agentReservationIds.get(agentId);
        if (previousReservationId) this.reservations.delete(previousReservationId);

        const reservationId = this._nextReservationId(agentId);
        const expiresAt = now + this._reservationTtl(intent);
        const reservation = {
            id: reservationId,
            agentId,
            buildingType: best.buildingType,
            tileX: best.tileX,
            tileY: best.tileY,
            slotId: best.slotId,
            slotIndex: Number.isInteger(best.slotIndex) ? best.slotIndex : null,
            intentId: intent?.id || null,
            createdAt: now,
            expiresAt,
            score: best.score,
            walkable: best.walkable,
            scenic: best.scenic,
            overflow: best.overflow,
            queueGroup: best.queueGroup,
            queueIndex: best.queueIndex,
            queueDepth: best.queueDepth,
            queueOverflow: best.queueOverflow,
            buildingCapacity: best.buildingCapacity,
            tileCapacity: best.tileCapacity,
            buildingOccupancy: best.buildingOccupancy,
            tileOccupancy: best.tileOccupancy,
            projectedBuildingUse: best.projectedBuildingUse,
            projectedTileUse: best.projectedTileUse,
            overBuildingCapacity: best.overBuildingCapacity,
            overTileCapacity: best.overTileCapacity,
            clusterPressure: best.clusterPressure,
            relatedCluster: best.clustered,
            relatedDistance: Number.isFinite(best.relatedDistance) ? best.relatedDistance : null,
            facingPoint: best.facingPoint
                ? { x: best.facingPoint.x, y: best.facingPoint.y }
                : null,
            routine,
            line: !!best.line,
            queuedAt: best.line ? best.queuedAt : null,
            queueSeq: best.line ? best.queueSeq : null,
        };
        this.reservations.set(reservationId, reservation);
        this.agentReservationIds.set(agentId, reservationId);
        this.metrics.allocations++;
        if (reservation.scenic) this.metrics.scenicAllocations++;
        if (reservation.overflow) this.metrics.overflowAllocations++;
        if (best.clustered) this.metrics.clusteredAllocations++;
        if (reservation.queueIndex > 0) this.metrics.queuedAllocations++;
        if (reservation.queueOverflow) this.metrics.overCapacityAllocations++;
        if (reservation.clusterPressure > 0) this.metrics.clusterPressureAllocations++;

        return {
            tileX: reservation.tileX,
            tileY: reservation.tileY,
            slotId: reservation.slotId,
            slotIndex: reservation.slotIndex,
            reservationId,
            buildingType: reservation.buildingType,
            expiresAt,
            score: reservation.score,
            walkable: reservation.walkable,
            scenic: reservation.scenic,
            overflow: reservation.overflow,
            queueGroup: reservation.queueGroup,
            queueIndex: reservation.queueIndex,
            queueDepth: reservation.queueDepth,
            queueOverflow: reservation.queueOverflow,
            buildingCapacity: reservation.buildingCapacity,
            tileCapacity: reservation.tileCapacity,
            buildingOccupancy: reservation.buildingOccupancy,
            tileOccupancy: reservation.tileOccupancy,
            projectedBuildingUse: reservation.projectedBuildingUse,
            projectedTileUse: reservation.projectedTileUse,
            overBuildingCapacity: reservation.overBuildingCapacity,
            overTileCapacity: reservation.overTileCapacity,
            clusterPressure: reservation.clusterPressure,
            relatedCluster: reservation.relatedCluster,
            relatedDistance: reservation.relatedDistance,
            facingPoint: reservation.facingPoint,
            line: reservation.line,
        };
    }

    // W4.2 — door discipline (PL-P8 / P14). A working visitor that finds its
    // landmark full, or others already waiting there, joins the approach
    // file (`APPROACH_FILES`) in arrival order: rank 0 faces the entrance and
    // each later place faces the one ahead. Ranks past the file take the
    // outer ring (`VISIT_OVERFLOW_TILES`) nearest first, and ranks past the
    // ring the scored slot. A waiting body asks again at every dwell end, so
    // it steps up when a place ahead frees, and the first `capacity - inside`
    // ranks go in. Null: the scored slot stands.
    _lineSlot({ agentId, building, buildingType, intent, candidates, best, buildingCapacity, existingReservation, now }) {
        const file = APPROACH_FILES[buildingType];
        if (!file || (Array.isArray(candidates) && candidates.length)) return null;
        if (!intent || String(intent.source || '').toLowerCase() === 'ambient') return null;
        const own = existingReservation?.buildingType === buildingType && existingReservation.expiresAt > now
            ? existingReservation
            : null;
        if (own && !own.line) return null;
        let inside = 0;
        const waiting = [];
        for (const reservation of this.reservations.values()) {
            if (reservation.agentId === agentId || reservation.expiresAt <= now) continue;
            if (reservation.buildingType !== buildingType) continue;
            if (reservation.line) waiting.push(reservation);
            else inside++;
        }
        const queuedAt = own ? own.queuedAt : now;
        const queueSeq = own ? own.queueSeq : (this._lineSequence || 0) + 1;
        const rank = waiting.filter((other) => other.queuedAt < queuedAt
            || (other.queuedAt === queuedAt && other.queueSeq < queueSeq)).length;
        if (rank < buildingCapacity - inside) return null;
        if (!own) this._lineSequence = queueSeq;

        const ring = VISIT_OVERFLOW_TILES[buildingType] || [];
        const door = building?.entrance || file[0];
        const placeId = (index) => (index < file.length
            ? `${buildingType}:line:${index}`
            : `${buildingType}:ring:${index - file.length}`);
        // A body ahead that has not yet asked again still holds its old
        // place; never share it, take the next free one back.
        const held = new Set(waiting.map((other) => other.slotId));
        let index = rank;
        while (index < file.length + ring.length && held.has(placeId(index))) index++;
        let place = best;
        let slotId = best.slotId;
        let facingPoint = best.facingPoint || { x: door.tileX, y: door.tileY };
        if (index < file.length) {
            place = file[index];
            slotId = placeId(index);
            const ahead = index > 0 ? file[index - 1] : door;
            facingPoint = { x: ahead.tileX, y: ahead.tileY };
        } else if (index < file.length + ring.length) {
            place = ring[index - file.length];
            slotId = placeId(index);
            facingPoint = { x: door.tileX, y: door.tileY };
        }
        return {
            ...best,
            tileX: place.tileX,
            tileY: place.tileY,
            slotId,
            slotIndex: null,
            walkable: this._isStandable(place.tileX, place.tileY),
            scenic: false,
            overflow: true,
            line: true,
            queuedAt,
            queueSeq,
            queueGroup: `${buildingType}:line`,
            queueIndex: rank,
            queueDepth: waiting.length + 1,
            queueOverflow: true,
            facingPoint,
        };
    }

    // W4.3 / W4.4 — live reservations on a routine leg, other than `exceptAgentId`'s.
    routineHolders(role, now = Date.now(), exceptAgentId = null) {
        let count = 0;
        for (const reservation of this.reservations.values()) {
            if (reservation.routine !== role || reservation.expiresAt <= now) continue;
            if (exceptAgentId && reservation.agentId === exceptAgentId) continue;
            count++;
        }
        return count;
    }

    // Strollers: STROLL_CAP, lowered by the daypart; errands: a third of the
    // live agents; a wind-down is never refused.
    routineCap(role, requested = null) {
        if (role === 'stroll') {
            const cap = requested == null ? NaN : Number(requested);
            return Number.isFinite(cap) ? Math.max(0, Math.min(STROLL_CAP, cap)) : STROLL_CAP;
        }
        if (role === 'errand') return errandCap(this.agentSprites?.length || 0);
        return Infinity;
    }

    // 7.1 — the free seat the villager reaches soonest on foot (a seat across
    // the water is far however close it looks); its own seat while it still
    // holds one. With every seat taken it stands beside the nearest seat.
    _allocateRestSeat({ agentId, agent, sprite, now, dayHour = null }) {
        const own = this._reservationForAgent(agentId);
        const taken = new Set();
        const standing = new Set();
        for (const reservation of this.reservations.values()) {
            if (reservation.agentId === agentId || reservation.expiresAt <= now) continue;
            if (reservation.buildingType !== REST_SEAT_BUILDING_TYPE) continue;
            taken.add(reservation.slotId);
            standing.add(`${reservation.tileX},${reservation.tileY}`);
        }
        if (own?.buildingType === REST_SEAT_BUILDING_TYPE && own.seat && own.expiresAt > now && !taken.has(own.slotId)) {
            return this._placeAllocation(this._storePlace(agentId, own, now));
        }
        const source = this._spriteTile(sprite) || this._agentTile(agent);
        const steps = source ? this._walkSteps(source, REST_SEATS) : null;
        const bySource = REST_SEATS
            .map((seat) => {
                const direct = source ? this._distance(source, seat) : 0;
                const walked = steps ? steps.get(`${seat.tileX},${seat.tileY}`) ?? SEAT_UNREACHED_STEPS + direct : direct;
                return { seat, distance: walked + restSeatStepBias(dayHour, seat) };
            })
            .sort((a, b) => (a.distance - b.distance) || a.seat.id.localeCompare(b.seat.id));
        for (const { seat } of bySource) {
            const slotId = `seat:${seat.id}`;
            if (taken.has(slotId) || !this._isWalkable(seat.tileX, seat.tileY)) continue;
            return this._placeAllocation(this._storePlace(agentId, {
                buildingType: REST_SEAT_BUILDING_TYPE,
                tileX: seat.tileX,
                tileY: seat.tileY,
                slotId,
                seat,
                role: 'rest',
                facingPoint: seatFacingPoint(seat),
            }, now));
        }
        // Overflow: stand at the nearest seat's cluster, never on a seat.
        const seatTiles = new Set(REST_SEATS.map((seat) => `${seat.tileX},${seat.tileY}`));
        for (const { seat } of bySource) {
            for (const [ox, oy] of SEAT_STAND_RING) {
                const tileX = seat.tileX + ox;
                const tileY = seat.tileY + oy;
                const key = `${tileX},${tileY}`;
                if (seatTiles.has(key) || standing.has(key) || !this._isStandable(tileX, tileY)) continue;
                return this._placeAllocation(this._storePlace(agentId, {
                    buildingType: REST_SEAT_BUILDING_TYPE,
                    tileX,
                    tileY,
                    slotId: `seat-stand:${key}`,
                    seat: null,
                    role: 'rest',
                    overflow: true,
                    facingPoint: { x: seat.tileX, y: seat.tileY },
                }, now));
            }
        }
        this.metrics.rejected++;
        return null;
    }

    // Walking steps (8-neighbour, no corner cutting) from `source` to each
    // target tile, by breadth-first search over the walk grid. Null without a
    // pathfinder grid; unreached targets are missing from the map.
    _walkSteps(source, targets) {
        if (!this.pathfinder || typeof this.pathfinder.isWalkable !== 'function') return null;
        const wanted = new Set(targets.map((tile) => `${Math.round(tile.tileX)},${Math.round(tile.tileY)}`));
        const found = new Map();
        let start = { tileX: Math.round(source.tileX), tileY: Math.round(source.tileY) };
        if (!this._isWalkable(start.tileX, start.tileY)) {
            start = this.pathfinder.nearestWalkable?.(start.tileX, start.tileY, 3) || null;
            if (!start) return null;
        }
        const seen = new Set([`${start.tileX},${start.tileY}`]);
        let frontier = [[start.tileX, start.tileY]];
        for (let depth = 0; frontier.length && found.size < wanted.size; depth++) {
            const next = [];
            for (const [x, y] of frontier) {
                const key = `${x},${y}`;
                if (wanted.has(key)) found.set(key, depth);
                for (const [dx, dy] of WALK_STEPS) {
                    const nx = x + dx;
                    const ny = y + dy;
                    const nextKey = `${nx},${ny}`;
                    if (seen.has(nextKey) || !this._isWalkable(nx, ny)) continue;
                    if (dx && dy && (!this._isWalkable(x + dx, y) || !this._isWalkable(x, y + dy))) continue;
                    seen.add(nextKey);
                    next.push([nx, ny]);
                }
            }
            frontier = next;
        }
        return found;
    }

    // 7.2 — the petitioner's place in the Command queue: slot = its wait rank.
    _allocateQueuePlace({ agentId, now }) {
        const rank = this.queueRank(agentId);
        if (rank < 0) {
            this.metrics.rejected++;
            return null;
        }
        const slots = COMMAND_QUEUE.slots;
        const inLine = rank < slots.length;
        const tile = inLine ? slots[rank] : COMMAND_QUEUE.overflow[(rank - slots.length) % COMMAND_QUEUE.overflow.length];
        const ahead = inLine && rank > 0 ? slots[rank - 1] : COMMAND_QUEUE.door;
        return this._placeAllocation(this._storePlace(agentId, {
            buildingType: COMMAND_QUEUE_BUILDING_TYPE,
            tileX: tile.tileX,
            tileY: tile.tileY,
            slotId: inLine ? `queue:${rank}` : `queue-plaza:${rank}`,
            role: 'queue',
            queueIndex: rank,
            queueDepth: this._queueRanking.order.length,
            queueOverflow: !inLine,
            overflow: !inLine,
            facingPoint: { x: ahead.tileX, y: ahead.tileY },
        }, now));
    }

    // 7.2 — wait rank among the waiting-on-user bodies: oldest
    // `SignalLedger.waitAnchor()` first (the sidebar's NEEDS YOU order), unknown
    // ages last. Re-ranked only when the waiting set changes, so a petitioner
    // never swaps places with a neighbour while both still wait. -1 when the
    // agent is not waiting on the operator.
    queueRank(agentId) {
        const ranking = this._refreshQueueRanking();
        const rank = ranking.rankById.get(String(agentId));
        return Number.isInteger(rank) ? rank : -1;
    }

    _refreshQueueRanking() {
        const waiting = [];
        for (const sprite of this.agentSprites) {
            const agent = sprite?.agent;
            if (!agent || agent.status !== AgentStatus.WAITING_ON_USER || agent.isDeparted) continue;
            waiting.push(agent);
        }
        const key = waiting.map((agent) => String(agent.id)).sort().join('|');
        if (this._queueRanking?.key === key) return this._queueRanking;
        const known = waiting.filter((agent) => waitAnchor(agent) > 0).sort(compareByWaitAge);
        const unknown = waiting.filter((agent) => !(waitAnchor(agent) > 0))
            .sort((a, b) => String(a.id).localeCompare(String(b.id)));
        const order = [...known, ...unknown].map((agent) => String(agent.id));
        this._queueRanking = { key, order, rankById: new Map(order.map((id, rank) => [id, rank])) };
        return this._queueRanking;
    }

    _storePlace(agentId, place, now) {
        const previousReservationId = this.agentReservationIds.get(agentId);
        if (previousReservationId) this.reservations.delete(previousReservationId);
        const reservation = {
            ...place,
            id: this._nextReservationId(agentId),
            agentId,
            createdAt: place.createdAt ?? now,
            expiresAt: now + PLACE_RESERVATION_TTL_MS,
            walkable: this._isWalkable(place.tileX, place.tileY),
            scenic: false,
            overflow: !!place.overflow,
        };
        this.reservations.set(reservation.id, reservation);
        this.agentReservationIds.set(agentId, reservation.id);
        this.metrics.allocations++;
        return reservation;
    }

    _placeAllocation(reservation) {
        return {
            tileX: reservation.tileX,
            tileY: reservation.tileY,
            slotId: reservation.slotId,
            slotIndex: null,
            reservationId: reservation.id,
            buildingType: reservation.buildingType,
            expiresAt: reservation.expiresAt,
            walkable: reservation.walkable,
            scenic: false,
            overflow: reservation.overflow,
            queueGroup: reservation.buildingType,
            queueIndex: Number.isInteger(reservation.queueIndex) ? reservation.queueIndex : null,
            queueDepth: Number.isInteger(reservation.queueDepth) ? reservation.queueDepth : null,
            queueOverflow: !!reservation.queueOverflow,
            role: reservation.role,
            seat: reservation.seat || null,
            facingPoint: reservation.facingPoint ? { ...reservation.facingPoint } : null,
        };
    }

    release(agentId) {
        const id = String(agentId || '');
        if (!id) return false;
        const reservationId = this.agentReservationIds.get(id);
        if (!reservationId) return false;
        this.agentReservationIds.delete(id);
        const released = this.reservations.delete(reservationId);
        if (released) this.metrics.releases++;
        return released;
    }

    releaseReservation(reservationId) {
        const id = String(reservationId || '');
        if (!id) return false;
        const reservation = this.reservations.get(id);
        if (!reservation) return false;
        this.reservations.delete(id);
        if (this.agentReservationIds.get(reservation.agentId) === id) {
            this.agentReservationIds.delete(reservation.agentId);
        }
        this.metrics.releases++;
        return true;
    }

    renew(agentId, ttlMs = null) {
        const id = String(agentId || '');
        if (!id) return false;
        const reservation = this._reservationForAgent(id);
        if (!reservation) return false;
        const ttl = Number.isFinite(Number(ttlMs)) && Number(ttlMs) > 0
            ? Math.max(1000, Number(ttlMs))
            : this.reservationTtlMs;
        reservation.expiresAt = Math.max(reservation.expiresAt, Date.now() + ttl);
        this.metrics.renewals++;
        return true;
    }

    cleanup(now = Date.now()) {
        const time = Number(now) || Date.now();
        for (const [id, reservation] of this.reservations.entries()) {
            if (reservation.expiresAt > time) continue;
            this.reservations.delete(id);
            if (this.agentReservationIds.get(reservation.agentId) === id) {
                this.agentReservationIds.delete(reservation.agentId);
            }
            this.metrics.expired++;
        }
        return this;
    }

    getBuildingLoads() {
        const counts = new Map();
        for (const reservation of this.reservations.values()) {
            let entry = counts.get(reservation.buildingType);
            if (!entry) {
                entry = { reserved: 0, queued: 0, overflowReserved: 0 };
                counts.set(reservation.buildingType, entry);
            }
            entry.reserved++;
            if (reservation.queueOverflow) {
                entry.queued++;
                entry.overflowReserved++;
            }
        }

        const buildings = {};
        for (const building of this.buildings.values()) {
            const type = this._buildingType(building, null);
            if (!type) continue;
            const candidates = this._candidateTiles({ building, buildingType: type, candidates: null });
            const capacity = this._buildingCapacity(building, type, candidates.length);
            const count = counts.get(type) || { reserved: 0, queued: 0, overflowReserved: 0 };
            buildings[type] = {
                capacity,
                visitTiles: candidates.length,
                occupied: this._buildingOccupancy(building, type, null),
                reserved: count.reserved,
                queued: count.queued,
                overflowReserved: count.overflowReserved,
            };
        }
        return buildings;
    }

    snapshot(now = Date.now()) {
        const time = Number(now) || Date.now();
        const reservations = [...this.reservations.values()]
            .sort((a, b) => a.createdAt - b.createdAt)
            .map((reservation) => ({
                id: reservation.id,
                agentId: reservation.agentId,
                buildingType: reservation.buildingType,
                tileX: reservation.tileX,
                tileY: reservation.tileY,
                slotId: reservation.slotId,
                intentId: reservation.intentId,
                ttlMs: Math.max(0, reservation.expiresAt - time),
                score: reservation.score,
                walkable: reservation.walkable,
                scenic: reservation.scenic,
                overflow: reservation.overflow,
                queueGroup: reservation.queueGroup,
                queueIndex: reservation.queueIndex,
                queueDepth: reservation.queueDepth,
                queueOverflow: reservation.queueOverflow,
                buildingCapacity: reservation.buildingCapacity,
                tileCapacity: reservation.tileCapacity,
                buildingOccupancy: reservation.buildingOccupancy,
                tileOccupancy: reservation.tileOccupancy,
                projectedBuildingUse: reservation.projectedBuildingUse,
                projectedTileUse: reservation.projectedTileUse,
                overBuildingCapacity: reservation.overBuildingCapacity,
                overTileCapacity: reservation.overTileCapacity,
                clusterPressure: reservation.clusterPressure,
                relatedCluster: reservation.relatedCluster,
                relatedDistance: reservation.relatedDistance,
                facingPoint: reservation.facingPoint,
            }));

        const buildings = this.getBuildingLoads();

        return {
            reservationTtlMs: this.reservationTtlMs,
            reservationCount: reservations.length,
            reservations,
            buildings,
            crowd: this._crowdSnapshot(),
            metrics: { ...this.metrics },
            metricsScope: 'since allocator start',
        };
    }

    get occupancyBuckets() {
        return this._occupancyBuckets;
    }

    // One immutable-by-convention map per two-second window. Rounded pressure
    // and a content version keep unchanged crowds reusable across windows.
    getCongestionSnapshot(now = Date.now()) {
        const bucket = Math.floor(now / 2000);
        if (this._congestionSnapshot?.bucket === bucket) return this._congestionSnapshot;
        const congestionTiles = new Map();
        for (const [key, entries] of this._occupancyBuckets) {
            congestionTiles.set(key, Math.min(8, Math.round(entries.length / 2) * 2));
        }
        const congestionVersion = [...congestionTiles].sort(([a], [b]) => a.localeCompare(b))
            .map(([key, count]) => `${key}:${count}`).join(';');
        this._congestionSnapshot = { bucket, congestionTiles, congestionVersion };
        return this._congestionSnapshot;
    }

    _projectSlotBonus(agentId, buildingType, slot) {
        const project = this.agentMeta.get(agentId)?.projectKey;
        if (!project) return 0;
        let bonus = 0;
        for (const reservation of this.reservations.values()) {
            if (reservation.agentId === agentId || reservation.buildingType !== buildingType) continue;
            const other = this.agentMeta.get(reservation.agentId)?.projectKey;
            if (!other) continue;
            const proximity = Math.max(0, 1 - this._distance(reservation, slot) / 3);
            bonus += (other === project ? 1 : -1) * proximity;
        }
        // Less than one point: capacity, safety and tool-selected slots win.
        return Math.max(-0.8, Math.min(0.8, bonus));
    }

    debug(now = Date.now()) {
        return this.snapshot(now);
    }

    getDiagnostics() {
        return {
            buildings: this.buildings.size,
            retainedAgentSprites: this.agentSprites.length,
            reservations: this.reservations.size,
            reservationAgents: this.agentReservationIds.size,
            agentMeta: this.agentMeta.size,
            relatedCache: this._relatedCache.size,
            occupancyEntries: this._occupancyEntries.length,
            occupancyBuckets: this._occupancyBuckets.size,
            disposed: this._disposed,
        };
    }

    dispose() {
        if (this._disposed) return;
        this._disposed = true;
        this.buildings.clear();
        this.agentSprites = [];
        this.pathfinder = null;
        this.reservations.clear();
        this.agentReservationIds.clear();
        this.agentMeta.clear();
        this._relatedCache.clear();
        this._occupancyEntries = [];
        this._occupancyBuckets.clear();
        this._crowdClusters = [];
        this._congestionSnapshot = null;
    }

    _scoreSlot({
        slot,
        agentId,
        buildingType,
        sourceTile,
        buildingCapacity,
        buildingOccupancy,
        existingReservation,
        intent,
        now,
    }) {
        const tileX = slot.tileX;
        const tileY = slot.tileY;
        const slotId = slot.slotId;
        const walkable = this._isStandable(tileX, tileY);
        const reservations = this._reservationsForSlot(slotId, buildingType, now);
        const reservedByOther = reservations.some((reservation) => reservation.agentId !== agentId);
        const sameAgentSlot = existingReservation
            && existingReservation.buildingType === buildingType
            && existingReservation.slotId === slotId;
        const tileOccupancy = this._tileOccupancy(tileX, tileY, agentId);
        const clusterPressure = this._clusterPressureAt(tileX, tileY, agentId);
        const distance = sourceTile ? this._distance(sourceTile, slot) : 0;
        const capacityLimit = Math.max(1, Number(slot.capacity) || buildingCapacity);
        const projectedTileUse = tileOccupancy + reservations.filter((reservation) => reservation.agentId !== agentId).length;
        const projectedBuildingUse = buildingOccupancy + this._reservationCountForBuilding(buildingType, agentId);
        const overTileCapacity = Math.max(0, projectedTileUse - capacityLimit + 1);
        const overBuildingCapacity = Math.max(0, projectedBuildingUse - buildingCapacity + 1);
        const intentBonus = this._intentSlotBonus(intent, slot);
        const queueOverflow = !!slot.overflow || overTileCapacity > 0 || overBuildingCapacity > 0;
        const queueGroup = this._slotQueueGroup(slot, buildingType);
        const queueDepth = queueOverflow
            ? this._queueDepth(queueGroup, agentId, now, { overflowOnly: true })
            : 0;
        const queueIndex = queueOverflow
            ? (sameAgentSlot && Number.isInteger(existingReservation?.queueIndex)
                ? existingReservation.queueIndex
                : queueDepth)
            : 0;

        const relatedDistance = this._nearestRelatedReservationDistance(agentId, buildingType, slot);
        const clustered = relatedDistance <= RELATED_CLUSTER_RADIUS;

        let score = 0;
        if (!walkable) score += WALKABILITY_PENALTY;
        if (reservedByOther) score += RESERVED_PENALTY;
        score += tileOccupancy * TILE_CROWD_PENALTY;
        score += clusterPressure * LOCAL_CLUSTER_PENALTY;
        score += Math.max(0, buildingOccupancy - 1) * BUILDING_CROWD_PENALTY;
        score += overCapacityPenalty(overTileCapacity) + overCapacityPenalty(overBuildingCapacity);
        score += distance * DISTANCE_WEIGHT;
        if (sameAgentSlot) score -= SAME_AGENT_SLOT_BONUS;
        if (clustered) score -= RELATED_CLUSTER_BONUS;
        const targetSlotIndex = Number(intent?.targetSlotIndex ?? intent?.payload?.targetSlotIndex);
        if (Number.isInteger(targetSlotIndex) && targetSlotIndex === slot.slotIndex) {
            score -= TARGET_SLOT_INDEX_BONUS;
        }
        score -= intentBonus;
        score -= this._projectSlotBonus(agentId, buildingType, slot);
        if (slot.overflow) score += 35;
        if (slot.scenic) score += intent?.source === 'ambient' ? -14 : 10;

        return {
            ...slot,
            buildingType,
            score,
            walkable,
            clustered,
            relatedDistance,
            queueGroup,
            queueDepth,
            queueIndex,
            queueOverflow,
            buildingCapacity,
            tileCapacity: capacityLimit,
            buildingOccupancy,
            tileOccupancy,
            projectedBuildingUse,
            projectedTileUse,
            overBuildingCapacity,
            overTileCapacity,
            clusterPressure,
        };
    }

    _candidateTiles({ building, buildingType, candidates }) {
        const source = Array.isArray(candidates) && candidates.length
            ? candidates
            : this._buildingVisitTiles(building);
        const seen = new Set();
        const out = [];
        for (let index = 0; index < source.length; index++) {
            const tile = this._normalizeTile(source[index]);
            if (!tile) continue;
            const key = `${Math.round(tile.tileX * 1000) / 1000},${Math.round(tile.tileY * 1000) / 1000}`;
            if (seen.has(key)) continue;
            seen.add(key);
            out.push({
                ...tile,
                slotId: tile.slotId || `${buildingType || 'scenic'}:${key}`,
                slotIndex: out.length,
            });
        }
        return out;
    }

    _buildingVisitTiles(building) {
        if (!building) return [];
        let base = [];
        if (Array.isArray(building.visitTiles) && building.visitTiles.length) {
            base = building.visitTiles;
        } else if (building.entrance) {
            base = [building.entrance];
        } else if (typeof building.primaryVisitTile === 'function') {
            const tile = building.primaryVisitTile();
            base = tile ? [tile] : [];
        } else {
            const x = Number.isFinite(building.x) ? building.x : building.position?.tileX;
            const y = Number.isFinite(building.y) ? building.y : building.position?.tileY;
            if (Number.isFinite(x) && Number.isFinite(y)) {
                base = [{
                    tileX: x + Math.floor((building.width || 1) / 2),
                    tileY: y + (building.height || 1),
                }];
            }
        }
        // A file place on the building's own slot (the Harbor quay) is the
        // line's alone; the outer ring is ranked by `_lineSlot`, never scored.
        const file = APPROACH_FILES[this._normalizeBuildingType(building.type)];
        if (!file) return base;
        return base.filter((tile) => !file.some((place) => place.tileX === tile.tileX && place.tileY === tile.tileY));
    }

    _normalizeTile(tile) {
        if (!tile) return null;
        const tileX = Number(tile.tileX ?? tile.x);
        const tileY = Number(tile.tileY ?? tile.y);
        if (!Number.isFinite(tileX) || !Number.isFinite(tileY)) return null;
        const facingPoint = tile.facingPoint
            && Number.isFinite(Number(tile.facingPoint.x))
            && Number.isFinite(Number(tile.facingPoint.y))
            ? { x: Number(tile.facingPoint.x), y: Number(tile.facingPoint.y) }
            : null;
        return {
            tileX,
            tileY,
            slotId: tile.slotId ? String(tile.slotId) : null,
            capacity: Number.isFinite(Number(tile.capacity)) ? Math.max(1, Number(tile.capacity)) : null,
            queueGroup: tile.queueGroup ? String(tile.queueGroup) : null,
            role: tile.role ? String(tile.role) : null,
            scenic: !!tile.scenic,
            overflow: !!tile.overflow,
            reason: tile.reason || null,
            intentId: tile.intentId || null,
            facingPoint,
        };
    }

    _resolveBuilding(building, intent) {
        if (building) return building;
        const type = this._normalizeBuildingType(intent?.building || intent?.buildingType || intent?.targetBuildingType);
        return type ? this.buildings.get(type) || null : null;
    }

    _buildingType(building, intent) {
        return this._normalizeBuildingType(
            building?.type || intent?.building || intent?.buildingType || intent?.targetBuildingType,
        );
    }

    _normalizeBuildingType(type) {
        return normalizeBuildingType(type);
    }

    _buildingCapacity(building, buildingType, slotCount, intent = null) {
        const explicitCapacity = building?.visitCapacity ?? this._capacityForIntent(building?.capacity, intent);
        const explicit = Number(explicitCapacity);
        if (Number.isFinite(explicit) && explicit > 0) return Math.max(1, Math.floor(explicit));
        if (BUILDING_CAPACITY_OVERRIDES[buildingType]) return BUILDING_CAPACITY_OVERRIDES[buildingType];
        return Math.max(1, Math.min(Math.max(1, slotCount), 4));
    }

    _capacityForIntent(capacity, intent = null) {
        if (!capacity || typeof capacity !== 'object' || Array.isArray(capacity)) return capacity;
        const source = String(intent?.source || '').toLowerCase();
        if (source === 'ambient' && capacity.ambient != null) return capacity.ambient;
        if ((source === 'alert' || String(intent?.building || '') === 'watchtower') && capacity.alert != null) return capacity.alert;
        if (capacity.overflow != null && capacity.work != null) {
            return Math.max(Number(capacity.work) || 0, Number(capacity.overflow) || 0) || capacity.work;
        }
        if (capacity.work != null) return capacity.work;
        return capacity.ambient ?? capacity.overflow ?? null;
    }

    _buildingOccupancy(building, buildingType, ignoredAgentId) {
        let count = 0;
        const visitTiles = this._candidateTiles({ building, buildingType, candidates: null });
        // A body waiting in the approach file is not inside (W4.2).
        const waiting = new Set();
        for (const reservation of this.reservations.values()) {
            if (reservation.line && reservation.buildingType === buildingType) waiting.add(reservation.agentId);
        }
        for (const tile of this._occupancyEntries || []) {
            if (ignoredAgentId && tile.agentId === ignoredAgentId) continue;
            if (waiting.has(tile.agentId)) continue;
            if (building && typeof building.containsVisitPoint === 'function' && building.containsVisitPoint(tile.tileX, tile.tileY)) {
                count++;
                continue;
            }
            if (building && typeof building.containsPoint === 'function' && building.containsPoint(tile.tileX, tile.tileY)) {
                count++;
                continue;
            }
            if (visitTiles.some((visitTile) => this._distance(tile, visitTile) <= BUILDING_OCCUPANCY_RADIUS)) count++;
        }
        return count;
    }

    _tileOccupancy(tileX, tileY, ignoredAgentId) {
        let count = 0;
        for (const tile of this._nearbyOccupancyEntries(tileX, tileY, TILE_OCCUPANCY_RADIUS)) {
            if (ignoredAgentId && tile.agentId === ignoredAgentId) continue;
            if (this._distance(tile, { tileX, tileY }) <= TILE_OCCUPANCY_RADIUS) count++;
        }
        return count;
    }

    _spriteTile(sprite) {
        if (!sprite) return null;
        if (sprite.tile && Number.isFinite(Number(sprite.tile.tileX)) && Number.isFinite(Number(sprite.tile.tileY))) {
            return { tileX: Number(sprite.tile.tileX), tileY: Number(sprite.tile.tileY) };
        }
        if (Number.isFinite(Number(sprite.tileX)) && Number.isFinite(Number(sprite.tileY))) {
            return { tileX: Number(sprite.tileX), tileY: Number(sprite.tileY) };
        }
        if (
            typeof sprite._screenToTile === 'function' &&
            Number.isFinite(Number(sprite.x)) &&
            Number.isFinite(Number(sprite.y))
        ) {
            const tile = sprite._screenToTile(Number(sprite.x), Number(sprite.y));
            if (tile && Number.isFinite(Number(tile.tileX)) && Number.isFinite(Number(tile.tileY))) {
                return { tileX: Number(tile.tileX), tileY: Number(tile.tileY) };
            }
        }
        if (sprite.agent?.position) return this._agentTile(sprite.agent);
        return null;
    }

    _agentTile(agent) {
        const position = agent?.position;
        if (!position) return null;
        const tileX = Number(position.tileX ?? position.x);
        const tileY = Number(position.tileY ?? position.y);
        if (!Number.isFinite(tileX) || !Number.isFinite(tileY)) return null;
        return { tileX, tileY };
    }

    _isWalkable(tileX, tileY) {
        if (!this.pathfinder || typeof this.pathfinder.isWalkable !== 'function') return true;
        return !!this.pathfinder.isWalkable(Math.round(tileX), Math.round(tileY));
    }

    // A tile a body may stand on: walkable, and off every fixture.
    _isStandable(tileX, tileY) {
        if (!this._isWalkable(tileX, tileY)) return false;
        return !standsOnFixture((tileX - tileY) * TILE_WIDTH / 2, (tileX + tileY) * TILE_HEIGHT / 2);
    }

    _reservationForAgent(agentId) {
        const reservationId = this.agentReservationIds.get(agentId);
        return reservationId ? this.reservations.get(reservationId) || null : null;
    }

    _reservationsForSlot(slotId, buildingType, now) {
        const out = [];
        for (const reservation of this.reservations.values()) {
            if (reservation.expiresAt <= now) continue;
            if (reservation.buildingType === buildingType && reservation.slotId === slotId) out.push(reservation);
        }
        return out;
    }

    _reservationCountForBuilding(buildingType, ignoredAgentId) {
        let count = 0;
        for (const reservation of this.reservations.values()) {
            if (reservation.buildingType !== buildingType || reservation.line) continue;
            if (ignoredAgentId && reservation.agentId === ignoredAgentId) continue;
            count++;
        }
        return count;
    }

    _slotQueueGroup(slot, buildingType) {
        if (slot?.queueGroup) return String(slot.queueGroup);
        if (slot?.overflow) return `${buildingType || 'scenic'}:overflow`;
        if (slot?.scenic) return `${buildingType || 'scenic'}:scenic`;
        return `${buildingType || 'scenic'}:primary`;
    }

    _queueDepth(queueGroup, ignoredAgentId, now, { overflowOnly = false } = {}) {
        if (!queueGroup) return 0;
        let count = 0;
        for (const reservation of this.reservations.values()) {
            if (reservation.expiresAt <= now) continue;
            if (ignoredAgentId && reservation.agentId === ignoredAgentId) continue;
            if (overflowOnly && !reservation.queueOverflow) continue;
            if (reservation.queueGroup === queueGroup) count++;
        }
        return count;
    }

    _reservationTtl(intent) {
        const intentTtl = Number(intent?.reservationTtlMs ?? intent?.ttlMs);
        if (Number.isFinite(intentTtl) && intentTtl > 0) return Math.max(1000, intentTtl);
        const expiresAt = Number(intent?.expiresAt);
        if (Number.isFinite(expiresAt)) {
            const remaining = expiresAt - Date.now();
            if (remaining > 0) return Math.max(1000, Math.min(remaining, this.reservationTtlMs));
        }
        return this.reservationTtlMs;
    }

    _intentSlotBonus(intent, slot) {
        if (!intent) return 0;
        if (slot.intentId && intent.id && slot.intentId === intent.id) return 45;
        if (slot.reason && intent.reason && slot.reason === intent.reason) return 25;
        const preferred = intent.preferredSlotId || intent.slotId;
        if (preferred && preferred === slot.slotId) return 55;
        return 0;
    }

    _normalizeBuildings(buildings) {
        if (buildings instanceof Map) {
            const out = new Map();
            for (const [key, building] of buildings.entries()) {
                const type = this._normalizeBuildingType(building?.type || key);
                if (type && building) out.set(type, building);
            }
            return out;
        }
        if (Array.isArray(buildings)) {
            const out = new Map();
            for (const building of buildings) {
                const type = this._normalizeBuildingType(building?.type);
                if (type) out.set(type, building);
            }
            return out;
        }
        if (buildings && typeof buildings === 'object') {
            const out = new Map();
            for (const [key, building] of Object.entries(buildings)) {
                const type = this._normalizeBuildingType(building?.type || key);
                if (type && building) out.set(type, building);
            }
            return out;
        }
        return new Map();
    }

    _normalizeAgentSprites(agentSprites) {
        if (agentSprites instanceof Map) return [...agentSprites.values()].filter(Boolean);
        if (Array.isArray(agentSprites)) return agentSprites.filter(Boolean);
        if (agentSprites && typeof agentSprites === 'object') return Object.values(agentSprites).filter(Boolean);
        return [];
    }

    _releaseStaleAgentReservations() {
        const active = new Set();
        for (const sprite of this.agentSprites) {
            const id = this._agentId(sprite?.agent, sprite, null);
            if (id) active.add(id);
        }
        for (const agentId of this.agentReservationIds.keys()) {
            if (!active.has(agentId) && this.release(agentId)) this.metrics.staleReleases++;
        }
    }

    _agentId(agent, sprite, intent) {
        const id = agent?.id || agent?.agentId || sprite?.agent?.id || sprite?.id || intent?.agentId;
        return id ? String(id) : null;
    }

    _nextReservationId(agentId) {
        this._sequence = (this._sequence + 1) % Number.MAX_SAFE_INTEGER;
        return `visit:${agentId}:${Date.now().toString(36)}:${this._sequence.toString(36)}`;
    }

    _distance(a, b) {
        return Math.hypot((a.tileX || 0) - (b.tileX || 0), (a.tileY || 0) - (b.tileY || 0));
    }
}

// The tile a seated villager looks toward: one tile along its facing.
function seatFacingPoint(seat) {
    const [dx, dy] = FACING_TILE_STEP[seat.facing] || [1, 0];
    return { x: seat.tileX + dx, y: seat.tileY + dy };
}

export default VisitTileAllocator;
