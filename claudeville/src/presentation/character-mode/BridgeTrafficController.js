import { TILE_WIDTH, TILE_HEIGHT } from '../../config/constants.js';
import { tileToWorld } from './Projection.js';
import { laneAxisForBridgeOrientation } from './MovementSteering.js';

export const PLATOON_MAX_HOLD_MS = 4500;
export const PLATOON_MAX_WAVE = 5;
export const PLATOON_ENTRY_ZONE_TILES = 1.45;
export const PLATOON_EXIT_CLEAR_TILES = 0.35;
export const PLATOON_STALL_TIMEOUT_MS = 3500;
export const TWO_WAY_COURTESY_MAX_MS = 1200;

const TILE_HALF_WIDTH = TILE_WIDTH * 0.5;
const TILE_HALF_HEIGHT = TILE_HEIGHT * 0.5;
const INV_HALF_W = 1 / TILE_HALF_WIDTH;
const INV_HALF_H = 1 / TILE_HALF_HEIGHT;
const BRIDGE_LANE_OFFSET_FALLBACK_PX = 10;
const BASE_HALF_CROSS_WIDTH = 0.55;
const LANDING_HALF_CROSS_WIDTH = 0.75;
const QUICK_REJECT_CROSS_PAD = 0.7;
const MAX_ROUTE_WAYPOINTS_SCAN = 8;
const DIR_EPSILON_TILES = 0.05;
const VEL_EPSILON_PX = 0.05;
const STRADDLE_THRESHOLD_PX = -2;
const STALL_PROGRESS_EPSILON = 1e-4;
const PLATOON_STALL_RELEASE_MS = 5000;
const PLATOON_STALL_RELEASE_WINDOW_MS = 2000;
const PLATOON_HARD_HOLD_CAP_MS = PLATOON_MAX_HOLD_MS * 3;
const EMPTY_DECK_APPROACH_GRACE_MS = 4500;
const INITIAL_AGENT_CAP = 64;

const FLAG_ENTERING = 1;
const FLAG_EXITING = 2;
const FLAG_IDLE_PLANTED = 4;

const CARDINAL_STEPS = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
];

function packTileKey(tx, ty) {
    return ((tx + 1024) << 12) | (ty + 1024);
}

function clampUnit(value) {
    if (value <= 0) return 0;
    if (value >= 1) return 1;
    return value;
}

/**
 * Allocation-free Liang-Barsky intersection test between segment (a0, c0)->(a1, c1)
 * and axis-aligned box [minA, maxA] x [minC, maxC] in span (along, cross) tile space.
 */
function segmentIntersectsBox(a0, c0, a1, c1, minA, maxA, minC, maxC) {
    let tMin = 0;
    let tMax = 1;
    const da = a1 - a0;
    const dc = c1 - c0;

    if (Math.abs(da) < 1e-9) {
        if (a0 < minA || a0 > maxA) return false;
    } else {
        const invDa = 1 / da;
        let t1 = (minA - a0) * invDa;
        let t2 = (maxA - a0) * invDa;
        if (t1 > t2) {
            const tmp = t1;
            t1 = t2;
            t2 = tmp;
        }
        if (t1 > tMin) tMin = t1;
        if (t2 < tMax) tMax = t2;
        if (tMin > tMax) return false;
    }

    if (Math.abs(dc) < 1e-9) {
        if (c0 < minC || c0 > maxC) return false;
    } else {
        const invDc = 1 / dc;
        let t1 = (minC - c0) * invDc;
        let t2 = (maxC - c0) * invDc;
        if (t1 > t2) {
            const tmp = t1;
            t1 = t2;
            t2 = tmp;
        }
        if (t1 > tMin) tMin = t1;
        if (t2 < tMax) tMax = t2;
        if (tMin > tMax) return false;
    }

    return tMax >= tMin;
}

function createSpanDescriptor(id, orientation, kind, info, tiles) {
    const axis = laneAxisForBridgeOrientation(orientation);
    const axisDx = axis ? axis.dx : 0;
    const axisDy = axis ? axis.dy : 1;
    const isEW = axisDx === 1;

    let minAlong = Infinity;
    let maxAlong = -Infinity;
    let minCross = Infinity;
    let maxCross = -Infinity;
    let crossSum = 0;

    for (let i = 0; i < tiles.length; i++) {
        const tile = tiles[i];
        const along = isEW ? tile.x : tile.y;
        const cross = isEW ? tile.y : tile.x;
        if (along < minAlong) minAlong = along;
        if (along > maxAlong) maxAlong = along;
        if (cross < minCross) minCross = cross;
        if (cross > maxCross) maxCross = cross;
        crossSum += cross;
    }

    const centerCross = tiles.length > 0 ? crossSum / tiles.length : 0;
    const centerAlong = (minAlong + maxAlong) * 0.5;
    const halfCrossWidth = BASE_HALF_CROSS_WIDTH + (maxCross - minCross) * 0.5;

    const rawTangentX = (axisDx - axisDy) * TILE_HALF_WIDTH;
    const rawTangentY = (axisDx + axisDy) * TILE_HALF_HEIGHT;
    const tangentLen = Math.hypot(rawTangentX, rawTangentY) || 1;
    const tangentX = rawTangentX / tangentLen;
    const tangentY = rawTangentY / tangentLen;
    const perpX = -tangentY;
    const perpY = tangentX;

    const origin = isEW
        ? tileToWorld(centerAlong, centerCross)
        : tileToWorld(centerCross, centerAlong);

    const circulationMode = info.circulationMode
        || (kind === 'plank' || id === 'west-river-plank' ? 'platoon' : 'two-way');
    const laneOffsetPx = Number.isFinite(info.laneOffsetPx)
        ? info.laneOffsetPx
        : BRIDGE_LANE_OFFSET_FALLBACK_PX;
    const landingLaneOffsetPx = Number.isFinite(info.landingLaneOffsetPx)
        ? info.landingLaneOffsetPx
        : 0;

    return {
        id,
        orientation: isEW ? 'EW' : 'NS',
        kind,
        circulationMode,
        axisDx,
        axisDy,
        tangentX,
        tangentY,
        perpX,
        perpY,
        minAlong,
        maxAlong,
        centerCross,
        halfCrossWidth,
        laneOffsetPx,
        landingLaneOffsetPx,
        originX: origin.x,
        originY: origin.y,
        // Mutable zero-allocation per-frame state:
        activeDir: 0,
        lastActiveDir: 1,
        activeCount: 0,
        deckCountPos: 0,
        deckCountNeg: 0,
        waitingPos: 0,
        waitingNeg: 0,
        heldMs: 0,
        admittedInWave: 0,
        draining: false,
        stallMs: 0,
        lastProgressSum: -1,
        exitingNeg: false,
        exitingPos: false,
        straddleNeg: false,
        straddlePos: false,
        flips: 0,
        holds: 0,
        // Internal zero-allocation tracking fields:
        _progressSum: 0,
        _hadDeckTraffic: false,
        _tJunctionSpan: null,
        _tJunctionBlocked: false,
        _enteredDeckPos: 0,
        _enteredDeckNeg: 0,
        _stallReleaseMs: 0,
        _approachProgressSum: 0,
        _lastApproachProgressSum: -1,
    };
}

/**
 * Hybrid bridge circulation controller (Design C).
 *
 * Manages:
 * - Two-way simultaneous lane flow on wide landmark spans (e.g. `central-river-bridge`)
 *   with brief stair-mouth straddle courtesy capped at `TWO_WAY_COURTESY_MAX_MS`.
 * - Single-direction alternating platoon locks on narrow spans and planks
 *   (`west-river-plank`, `command-pond-plank`, `north-farm-bridge`) with time/wave
 *   anti-starvation draining, strict fairness alternation, and stall failsafe.
 * - Brief T-junction merge courtesy for `command-pond-plank` eastbound approachers
 *   when northbound traffic exits `central-river-bridge` onto `(18, 22)`.
 *
 * The hot-path `update(agents, activeCount, dtMs)` performs zero heap allocations.
 */
export class BridgeTrafficController {
    constructor({ bridgeTiles = null } = {}) {
        this.spans = [];
        this._spansById = new Map();
        this._tileToSpan = new Map();
        this._frames = 0;

        this._agentCap = INITIAL_AGENT_CAP;
        this._agentSpanIdx = new Int16Array(INITIAL_AGENT_CAP);
        this._agentFlags = new Uint8Array(INITIAL_AGENT_CAP);

        // Preallocated scalar scratch for zero-allocation route inspection.
        this._routeEntersDeck = false;
        this._routeCrossingDir = 0;
        this._routeFirstDa = 0;
        this._routeFirstDc = 0;

        this.setBridgeTiles(bridgeTiles);
    }

    /**
     * Rebuild span descriptors from a `Map<"tx,ty", bridgeTileInfo>`.
     * Groups walkable non-dock tiles by `bridgeId`, or by 4-connected `(kind, orientation)`
     * components with fallback id `${kind}:${orientation}:${minX},${minY}`.
     */
    setBridgeTiles(bridgeTiles) {
        this.spans = [];
        this._spansById.clear();
        this._tileToSpan.clear();

        if (!bridgeTiles || typeof bridgeTiles.entries !== 'function') {
            return this.spans;
        }

        const byId = new Map();
        const unnamedTiles = new Map();

        for (const [key, info] of bridgeTiles.entries()) {
            if (!info || info.kind === 'dock' || info.walkable === false) continue;
            const comma = key.indexOf(',');
            if (comma < 0) continue;
            const x = Number(key.slice(0, comma));
            const y = Number(key.slice(comma + 1));
            if (!Number.isFinite(x) || !Number.isFinite(y)) continue;

            const kind = info.kind || 'landmark';
            const axis = laneAxisForBridgeOrientation(info.orientation);
            const orientation = axis ? (axis.dx === 1 ? 'EW' : 'NS') : null;

            if (info.bridgeId) {
                let group = byId.get(info.bridgeId);
                if (!group) {
                    group = { id: info.bridgeId, kind, orientation, info, tiles: [] };
                    byId.set(info.bridgeId, group);
                }
                group.tiles.push({ x, y });
            } else {
                unnamedTiles.set(key, { x, y, kind, orientation, info });
            }
        }

        // Build spans for named bridges.
        for (const group of byId.values()) {
            const orientation = group.orientation || this._inferGroupOrientation(group.tiles);
            const span = createSpanDescriptor(group.id, orientation, group.kind, group.info, group.tiles);
            this._registerSpan(span, group.tiles);
        }

        // Flood-fill 4-connected components for unnamed walkable bridge tiles.
        if (unnamedTiles.size > 0) {
            const visited = new Set();
            for (const [startKey, startEntry] of unnamedTiles.entries()) {
                if (visited.has(startKey)) continue;
                visited.add(startKey);
                const queue = [startEntry];
                const tiles = [];
                let minX = startEntry.x;
                let minY = startEntry.y;

                for (let q = 0; q < queue.length; q++) {
                    const cur = queue[q];
                    tiles.push({ x: cur.x, y: cur.y });
                    if (cur.x < minX) minX = cur.x;
                    if (cur.y < minY) minY = cur.y;

                    for (let d = 0; d < CARDINAL_STEPS.length; d++) {
                        const nx = cur.x + CARDINAL_STEPS[d][0];
                        const ny = cur.y + CARDINAL_STEPS[d][1];
                        const nextKey = `${nx},${ny}`;
                        if (visited.has(nextKey)) continue;
                        const nextEntry = unnamedTiles.get(nextKey);
                        if (!nextEntry) continue;
                        if (nextEntry.kind !== startEntry.kind || nextEntry.orientation !== startEntry.orientation) {
                            continue;
                        }
                        visited.add(nextKey);
                        queue.push(nextEntry);
                    }
                }

                const orientation = startEntry.orientation || this._inferGroupOrientation(tiles);
                const fallbackId = `${startEntry.kind}:${orientation}:${minX},${minY}`;
                const span = createSpanDescriptor(fallbackId, orientation, startEntry.kind, startEntry.info, tiles);
                this._registerSpan(span, tiles);
            }
        }

        // Pre-link T-junction courtesy span so `update()` performs zero map lookups.
        const centralSpan = this._spansById.get('central-river-bridge') || null;
        if (centralSpan) {
            const pondSpan = this._spansById.get('command-pond-plank') || null;
            if (pondSpan) {
                pondSpan._tJunctionSpan = centralSpan;
            }
        }

        return this.spans;
    }

    _inferGroupOrientation(tiles) {
        let minX = Infinity;
        let maxX = -Infinity;
        let minY = Infinity;
        let maxY = -Infinity;
        for (let i = 0; i < tiles.length; i++) {
            const t = tiles[i];
            if (t.x < minX) minX = t.x;
            if (t.x > maxX) maxX = t.x;
            if (t.y < minY) minY = t.y;
            if (t.y > maxY) maxY = t.y;
        }
        return (maxX - minX) > (maxY - minY) ? 'EW' : 'NS';
    }

    _registerSpan(span, tiles) {
        this.spans.push(span);
        this._spansById.set(span.id, span);
        for (let i = 0; i < tiles.length; i++) {
            this._tileToSpan.set(packTileKey(tiles[i].x, tiles[i].y), span);
        }
    }

    _ensureAgentCapacity(count) {
        if (count <= this._agentCap) return;
        let nextCap = this._agentCap;
        while (nextCap < count) nextCap *= 2;
        this._agentCap = nextCap;
        this._agentSpanIdx = new Int16Array(nextCap);
        this._agentFlags = new Uint8Array(nextCap);
    }

    /**
     * Inspect an agent's immediate target, waypoints, or velocity against a span's
     * deck box in (along, cross) tile coordinates. Writes results into scalar fields
     * on `this` with zero heap allocations.
     */
    _analyzeRouteForSpan(desc, along, cross, span) {
        this._routeEntersDeck = false;
        this._routeCrossingDir = 0;
        this._routeFirstDa = 0;
        this._routeFirstDc = 0;

        const isEW = span.axisDx === 1;
        const deckMinA = span.minAlong - 0.5;
        const deckMaxA = span.maxAlong + 0.5;
        const deckMinC = span.centerCross - span.halfCrossWidth;
        const deckMaxC = span.centerCross + span.halfCrossWidth;

        let prevA = along;
        let prevC = cross;
        let haveFirstSeg = false;
        let deckDa = 0;
        let hasRoutePoint = false;

        // 1. Check immediate targetX/Y first.
        if (Number.isFinite(desc.targetX) && Number.isFinite(desc.targetY)) {
            const txh = desc.targetX * INV_HALF_W;
            const tyh = desc.targetY * INV_HALF_H;
            const ttx = (txh + tyh) * 0.5;
            const tty = (tyh - txh) * 0.5;
            const wA = isEW ? ttx : tty;
            const wC = isEW ? tty : ttx;
            const da = wA - prevA;
            const dc = wC - prevC;
            if (Math.abs(da) > 1e-4 || Math.abs(dc) > 1e-4) {
                hasRoutePoint = true;
                this._routeFirstDa = da;
                this._routeFirstDc = dc;
                haveFirstSeg = true;
                if (segmentIntersectsBox(prevA, prevC, wA, wC, deckMinA, deckMaxA, deckMinC, deckMaxC)) {
                    if (Math.abs(da) > DIR_EPSILON_TILES) {
                        this._routeEntersDeck = true;
                    }
                    deckDa += da;
                }
                prevA = wA;
                prevC = wC;
            }
        }

        // 2. Scan upcoming waypoints so turning approachers resolve their true crossing axis.
        const waypoints = desc.sprite?.waypoints;
        if (Array.isArray(waypoints) && waypoints.length > 0) {
            const limit = waypoints.length < MAX_ROUTE_WAYPOINTS_SCAN
                ? waypoints.length
                : MAX_ROUTE_WAYPOINTS_SCAN;
            for (let k = 0; k < limit; k++) {
                const wp = waypoints[k];
                if (!wp || !Number.isFinite(wp.x) || !Number.isFinite(wp.y)) continue;
                const wxh = wp.x * INV_HALF_W;
                const wyh = wp.y * INV_HALF_H;
                const wtx = (wxh + wyh) * 0.5;
                const wty = (wyh - wxh) * 0.5;
                const wA = isEW ? wtx : wty;
                const wC = isEW ? wty : wtx;
                const da = wA - prevA;
                const dc = wC - prevC;
                if (Math.abs(da) <= 1e-4 && Math.abs(dc) <= 1e-4) continue;

                hasRoutePoint = true;
                if (!haveFirstSeg) {
                    this._routeFirstDa = da;
                    this._routeFirstDc = dc;
                    haveFirstSeg = true;
                }
                if (segmentIntersectsBox(prevA, prevC, wA, wC, deckMinA, deckMaxA, deckMinC, deckMaxC)) {
                    if (Math.abs(da) > DIR_EPSILON_TILES) {
                        this._routeEntersDeck = true;
                    }
                    deckDa += da;
                }
                prevA = wA;
                prevC = wC;
                if (this._routeEntersDeck && Math.abs(deckDa) >= 0.5) break;
            }
        }

        // 3. Velocity fallback when no target/waypoints are supplied.
        if (!hasRoutePoint) {
            const vx = Number.isFinite(desc.vx) ? desc.vx : 0;
            const vy = Number.isFinite(desc.vy) ? desc.vy : 0;
            const vLen = Math.hypot(vx, vy);
            if (vLen > VEL_EPSILON_PX) {
                const vxh = (vx / vLen) * 64 * INV_HALF_W;
                const vyh = (vy / vLen) * 64 * INV_HALF_H;
                const dtx = (vxh + vyh) * 0.5;
                const dty = (vyh - vxh) * 0.5;
                const da = isEW ? dtx : dty;
                const dc = isEW ? dty : dtx;
                this._routeFirstDa = da;
                this._routeFirstDc = dc;
                if (segmentIntersectsBox(along, cross, along + da * 2, cross + dc * 2, deckMinA, deckMaxA, deckMinC, deckMaxC)) {
                    if (Math.abs(da) > DIR_EPSILON_TILES) {
                        this._routeEntersDeck = true;
                    }
                    deckDa += da;
                }
            }
        }

        if (deckDa > DIR_EPSILON_TILES) {
            this._routeCrossingDir = 1;
        } else if (deckDa < -DIR_EPSILON_TILES) {
            this._routeCrossingDir = -1;
        } else if (this._routeFirstDa > DIR_EPSILON_TILES) {
            this._routeCrossingDir = 1;
        } else if (this._routeFirstDa < -DIR_EPSILON_TILES) {
            this._routeCrossingDir = -1;
        } else {
            const velAlong = (Number.isFinite(desc.vx) ? desc.vx : 0) * span.tangentX
                + (Number.isFinite(desc.vy) ? desc.vy : 0) * span.tangentY;
            if (velAlong > VEL_EPSILON_PX) this._routeCrossingDir = 1;
            else if (velAlong < -VEL_EPSILON_PX) this._routeCrossingDir = -1;
        }
    }

    /**
     * Hot-path per-frame traffic update (strictly zero heap allocations).
     */
    update(agents, activeCount, dtMs = 16.67) {
        this._frames++;
        const dt = Number.isFinite(dtMs) && dtMs >= 0 ? dtMs : 16.67;
        const count = agents
            ? (Number.isInteger(activeCount)
                ? (activeCount < agents.length ? (activeCount > 0 ? activeCount : 0) : agents.length)
                : agents.length)
            : 0;
        const spans = this.spans;
        const spanCount = spans.length;

        if (count > 0) {
            this._ensureAgentCapacity(count);
        }

        const agentSpanIdx = this._agentSpanIdx;
        const agentFlags = this._agentFlags;

        // Reset per-frame span accumulators.
        for (let s = 0; s < spanCount; s++) {
            const span = spans[s];
            span.activeCount = 0;
            span.deckCountPos = 0;
            span.deckCountNeg = 0;
            span.waitingPos = 0;
            span.waitingNeg = 0;
            span.exitingNeg = false;
            span.exitingPos = false;
            span.straddleNeg = false;
            span.straddlePos = false;
            span._progressSum = 0;
            span._tJunctionBlocked = false;
            span._enteredDeckPos = 0;
            span._enteredDeckNeg = 0;
            span._approachProgressSum = 0;
        }

        // Pass 1: Reset bridge fields on every descriptor and classify against spans.
        for (let i = 0; i < count; i++) {
            const desc = agents[i];
            agentSpanIdx[i] = -1;
            agentFlags[i] = 0;
            if (!desc) continue;

            desc.bridgeSpanId = null;
            desc.bridgeMode = null;
            desc.bridgeDir = 0;
            desc.bridgeZone = null;
            desc.bridgeProgress = 0;
            desc.bridgeAlongCoord = 0;
            desc.bridgeTangentX = 0;
            desc.bridgeTangentY = 0;
            desc.bridgePerpX = 0;
            desc.bridgePerpY = 0;
            desc.bridgeLaneOffset = 0;
            desc.bridgeSpanLaneOffset = 0;
            desc.bridgeCrossOffset = 0;
            desc.bridgeHold = false;

            const holdOwner = desc.sprite || desc;
            if (spanCount === 0 || !Number.isFinite(desc.x) || !Number.isFinite(desc.y)) {
                if (holdOwner._bridgePrevDeckSpanId) holdOwner._bridgePrevDeckSpanId = null;
                continue;
            }

            // Live held walkers pause their stride so ORCA marks `planted = true`
            // while `sprite.moving === true`; only truly idle/non-moving planted
            // bodies are excluded from directional lock occupancy and waiting.
            const isIdlePlanted = desc.planted === true && desc.sprite?.moving !== true;

            const xh = desc.x * INV_HALF_W;
            const yh = desc.y * INV_HALF_H;
            const tx = (xh + yh) * 0.5;
            const ty = (yh - xh) * 0.5;

            let bestSpanIdx = -1;
            let bestScore = -Infinity;
            let bestZone = null;
            let bestDir = 0;
            let bestAlong = 0;
            let bestEntering = false;
            let bestExiting = false;

            for (let s = 0; s < spanCount; s++) {
                const span = spans[s];
                const isEW = span.axisDx === 1;
                const along = isEW ? tx : ty;
                const cross = isEW ? ty : tx;
                const absCross = Math.abs(cross - span.centerCross);

                if (absCross > span.halfCrossWidth + QUICK_REJECT_CROSS_PAD) continue;
                if (along < span.minAlong - 1 - PLATOON_ENTRY_ZONE_TILES) continue;
                if (along > span.maxAlong + 1 + PLATOON_ENTRY_ZONE_TILES) continue;

                const deckMinA = span.minAlong - 0.5;
                const deckMaxA = span.maxAlong + 0.5;
                const inDeck = along >= deckMinA
                    && along <= deckMaxA
                    && absCross <= span.halfCrossWidth;

                const onNegLanding = along >= span.minAlong - 1.5 && along < deckMinA && absCross <= LANDING_HALF_CROSS_WIDTH;
                const onPosLanding = along > deckMaxA && along <= span.maxAlong + 1.5 && absCross <= LANDING_HALF_CROSS_WIDTH;
                const inLanding = !inDeck && (onNegLanding || onPosLanding);

                const inNegApproachBand = along < deckMinA && along >= deckMinA - PLATOON_ENTRY_ZONE_TILES;
                const inPosApproachBand = along > deckMaxA && along <= deckMaxA + PLATOON_ENTRY_ZONE_TILES;

                if (!inDeck && !inLanding && !inNegApproachBand && !inPosApproachBand) continue;

                this._analyzeRouteForSpan(desc, along, cross, span);
                const dir = isIdlePlanted ? 0 : this._routeCrossingDir;
                const routeEntersDeck = !isIdlePlanted && this._routeEntersDeck;
                const fDa = this._routeFirstDa;
                const fDc = this._routeFirstDc;
                const fLen = Math.hypot(fDa, fDc);
                const alignScore = fLen > 1e-6 ? Math.abs(fDa) / fLen : 0;

                let zone = null;
                let zoneRank = 0;
                let entering = false;
                let exiting = false;

                if (inDeck) {
                    zone = 'deck';
                    zoneRank = 3;
                } else {
                    const isEnteringNeg = routeEntersDeck && dir === 1 && inNegApproachBand;
                    const isEnteringPos = routeEntersDeck && dir === -1 && inPosApproachBand;
                    entering = isEnteringNeg || isEnteringPos;

                    const isExitingNeg = !isIdlePlanted
                        && onNegLanding
                        && !routeEntersDeck
                        && dir === -1
                        && Math.abs(fDa) >= Math.abs(fDc) * 0.75;
                    const isExitingPos = !isIdlePlanted
                        && onPosLanding
                        && !routeEntersDeck
                        && dir === 1
                        && Math.abs(fDa) >= Math.abs(fDc) * 0.75;
                    exiting = isExitingNeg || isExitingPos;

                    if (inLanding && (entering || exiting)) {
                        zone = 'landing';
                        zoneRank = 2;
                    } else if (entering) {
                        zone = 'approach';
                        zoneRank = 1;
                    } else {
                        continue;
                    }
                }

                const score = zoneRank * 100
                    + alignScore * 10
                    + (routeEntersDeck ? 2 : 0)
                    - absCross;

                if (score > bestScore) {
                    bestScore = score;
                    bestSpanIdx = s;
                    bestZone = zone;
                    bestDir = dir;
                    bestAlong = along;
                    bestEntering = entering;
                    bestExiting = exiting;
                }
            }

            if (bestSpanIdx < 0) {
                if (holdOwner._bridgePrevDeckSpanId) holdOwner._bridgePrevDeckSpanId = null;
                continue;
            }

            const span = spans[bestSpanIdx];
            const deckMinA = span.minAlong - 0.5;
            const deckMaxA = span.maxAlong + 0.5;
            const spanLen = span.maxAlong - span.minAlong + 1;
            const invSpanLen = spanLen > 0 ? 1 / spanLen : 1;

            let rawAlongCoord = 0;
            let rawProgress = 0;
            if (bestDir === 1) {
                rawAlongCoord = bestAlong - deckMinA;
                rawProgress = rawAlongCoord * invSpanLen;
            } else if (bestDir === -1) {
                rawAlongCoord = deckMaxA - bestAlong;
                rawProgress = rawAlongCoord * invSpanLen;
            }
            const progress = clampUnit(rawProgress);

            const crossOffset = (desc.x - span.originX) * span.perpX
                + (desc.y - span.originY) * span.perpY;
            const laneOffset = bestZone === 'deck'
                ? span.laneOffsetPx
                : (bestZone === 'landing' ? span.landingLaneOffsetPx : 0);

            desc.bridgeSpanId = span.id;
            desc.bridgeMode = span.circulationMode;
            desc.bridgeDir = bestDir;
            desc.bridgeZone = bestZone;
            desc.bridgeProgress = progress;
            desc.bridgeAlongCoord = rawAlongCoord;
            desc.bridgeTangentX = span.tangentX;
            desc.bridgeTangentY = span.tangentY;
            desc.bridgePerpX = span.perpX;
            desc.bridgePerpY = span.perpY;
            desc.bridgeLaneOffset = laneOffset;
            desc.bridgeSpanLaneOffset = span.laneOffsetPx;
            desc.bridgeCrossOffset = crossOffset;

            agentSpanIdx[i] = bestSpanIdx;
            agentFlags[i] = (bestEntering ? FLAG_ENTERING : 0)
                | (bestExiting ? FLAG_EXITING : 0)
                | (isIdlePlanted ? FLAG_IDLE_PLANTED : 0);

            // Track cumulative deck-entry transitions for platoon wave capping.
            if (!isIdlePlanted && bestZone === 'deck' && bestDir !== 0) {
                if (holdOwner._bridgePrevDeckSpanId !== span.id) {
                    holdOwner._bridgePrevDeckSpanId = span.id;
                    if (bestDir === 1) span._enteredDeckPos++;
                    else span._enteredDeckNeg++;
                }
            } else if (holdOwner._bridgePrevDeckSpanId) {
                holdOwner._bridgePrevDeckSpanId = null;
            }

            // Accumulate active span occupancy, wait counts, exits, and stair-mouth straddles.
            // Idle/planted bodies on a deck never hold the directional lock.
            const stillClearingNegExit = bestExiting
                && bestDir === -1
                && bestAlong > deckMinA - PLATOON_EXIT_CLEAR_TILES;
            const stillClearingPosExit = bestExiting
                && bestDir === 1
                && bestAlong < deckMaxA + PLATOON_EXIT_CLEAR_TILES;

            if (!isIdlePlanted && (bestZone === 'deck' || stillClearingNegExit || stillClearingPosExit)) {
                if (bestDir === 1) {
                    span.deckCountPos++;
                    span._progressSum += rawProgress;
                } else if (bestDir === -1) {
                    span.deckCountNeg++;
                    span._progressSum += rawProgress;
                }
            } else if (bestEntering && !isIdlePlanted) {
                if (bestDir === 1) span.waitingPos++;
                else if (bestDir === -1) span.waitingNeg++;
                if (span.activeDir === bestDir) {
                    span._approachProgressSum += rawAlongCoord;
                }
                // Reverse T-junction guard: if a westbound pond-plank waiter is
                // standing on central-river-bridge's north mouth, trigger pond
                // draining so eastbound waves clear quickly and vacate (18, 22).
                const tj = span._tJunctionSpan;
                if (
                    tj
                    && bestDir === -1
                    && Math.abs(tx - tj.centerCross) <= 0.75
                    && ty >= tj.minAlong - 1.5
                    && ty <= tj.minAlong - 0.1
                ) {
                    span._tJunctionBlocked = true;
                }
            }

            // Track active exits at both bridge mouths (wider window for T-junction
            // clearance; tight PLATOON_EXIT_CLEAR_TILES for stair-mouth straddles).
            if (
                !isIdlePlanted
                && bestDir === -1
                && bestAlong >= span.minAlong - 1.0
                && bestAlong <= span.minAlong + 0.5
            ) {
                span.exitingNeg = true;
                if (
                    bestAlong >= deckMinA - PLATOON_EXIT_CLEAR_TILES
                    && crossOffset * bestDir < STRADDLE_THRESHOLD_PX
                ) {
                    span.straddleNeg = true;
                }
            } else if (
                !isIdlePlanted
                && bestDir === 1
                && bestAlong >= span.maxAlong - 0.5
                && bestAlong <= span.maxAlong + 1.0
            ) {
                span.exitingPos = true;
                if (
                    bestAlong <= deckMaxA + PLATOON_EXIT_CLEAR_TILES
                    && crossOffset * bestDir < STRADDLE_THRESHOLD_PX
                ) {
                    span.straddlePos = true;
                }
            }
        }

        // Pass 2a: Update span lock states.
        for (let s = 0; s < spanCount; s++) {
            const span = spans[s];
            const totalOnDeck = span.deckCountPos + span.deckCountNeg;
            span.activeCount = totalOnDeck;

            if (span.circulationMode !== 'platoon') continue;

            if (span._stallReleaseMs > 0) {
                span._stallReleaseMs = Math.max(0, span._stallReleaseMs - dt);
            }

            if (totalOnDeck === 0) {
                const hadDeckTraffic = span._hadDeckTraffic;
                span._hadDeckTraffic = false;
                span.draining = false;
                span.admittedInWave = 0;
                span.stallMs = 0;
                span.lastProgressSum = -1;
                span._stallReleaseMs = 0;

                if (span.waitingPos > 0 && span.waitingNeg > 0) {
                    const approachAdvancing = span._lastApproachProgressSum >= 0
                        && Math.abs(span._approachProgressSum - span._lastApproachProgressSum) > STALL_PROGRESS_EPSILON;
                    span._lastApproachProgressSum = span._approachProgressSum;
                    const flipThreshold = approachAdvancing
                        ? EMPTY_DECK_APPROACH_GRACE_MS
                        : PLATOON_STALL_TIMEOUT_MS;
                    const shouldFlip = span.activeDir === 0
                        || hadDeckTraffic
                        || span.heldMs >= flipThreshold;
                    if (shouldFlip) {
                        span.activeDir = span._tJunctionBlocked ? -1 : -span.lastActiveDir;
                        span.lastActiveDir = span.activeDir;
                        span.flips++;
                        span.heldMs = 0;
                        span._lastApproachProgressSum = -1;
                    } else {
                        span.heldMs += dt;
                    }
                } else if (span.waitingPos > 0) {
                    if (span.activeDir !== 1) span.flips++;
                    span.activeDir = 1;
                    span.lastActiveDir = 1;
                    span.heldMs = 0;
                    span._lastApproachProgressSum = -1;
                } else if (span.waitingNeg > 0) {
                    if (span.activeDir !== -1) span.flips++;
                    span.activeDir = -1;
                    span.lastActiveDir = -1;
                    span.heldMs = 0;
                    span._lastApproachProgressSum = -1;
                } else {
                    span.activeDir = 0;
                    span.heldMs = 0;
                    span._lastApproachProgressSum = -1;
                }
            } else {
                span._hadDeckTraffic = true;
                span._lastApproachProgressSum = -1;
                let dirChanged = false;
                if (span.activeDir === 0) {
                    span.activeDir = span.deckCountPos >= span.deckCountNeg ? 1 : -1;
                    span.lastActiveDir = span.activeDir;
                    dirChanged = true;
                } else if (span.activeDir === 1 && span.deckCountPos === 0 && span.deckCountNeg > 0) {
                    span.activeDir = -1;
                    span.lastActiveDir = -1;
                    span.flips++;
                    dirChanged = true;
                } else if (span.activeDir === -1 && span.deckCountNeg === 0 && span.deckCountPos > 0) {
                    span.activeDir = 1;
                    span.lastActiveDir = 1;
                    span.flips++;
                    dirChanged = true;
                }

                const activeOnDeck = span.activeDir === 1 ? span.deckCountPos : span.deckCountNeg;
                const newlyEntered = span.activeDir === 1 ? span._enteredDeckPos : span._enteredDeckNeg;
                if (dirChanged) {
                    span.admittedInWave = activeOnDeck;
                } else {
                    span.admittedInWave += newlyEntered;
                    if (activeOnDeck > span.admittedInWave) {
                        span.admittedInWave = activeOnDeck;
                    }
                }

                const oppWaiting = span.activeDir === 1 ? span.waitingNeg : span.waitingPos;
                if (oppWaiting > 0) {
                    span.heldMs += dt;
                    if (
                        span.heldMs >= PLATOON_MAX_HOLD_MS
                        || span.admittedInWave >= PLATOON_MAX_WAVE
                        || (span._tJunctionBlocked && span.activeDir === 1)
                    ) {
                        span.draining = true;
                    }
                } else {
                    span.heldMs = 0;
                    span.draining = false;
                }

                // Stall failsafe: stop admitting new followers after PLATOON_STALL_TIMEOUT_MS
                // with zero progress, and open a bounded hold-release window after
                // PLATOON_STALL_RELEASE_MS so a blocked deck can always clear.
                const progressSum = span._progressSum;
                if (span.lastProgressSum >= 0 && Math.abs(progressSum - span.lastProgressSum) < STALL_PROGRESS_EPSILON) {
                    span.stallMs += dt;
                    if (span.stallMs >= PLATOON_STALL_TIMEOUT_MS) {
                        span.draining = true;
                    }
                    if (span.stallMs >= PLATOON_STALL_RELEASE_MS) {
                        span._stallReleaseMs = PLATOON_STALL_RELEASE_WINDOW_MS;
                        span.stallMs = 0;
                    }
                } else {
                    span.stallMs = 0;
                    span.lastProgressSum = progressSum;
                }
            }
        }

        // Pass 2b: Assign `desc.bridgeHold` and maintain per-sprite hold & courtesy timers.
        for (let i = 0; i < count; i++) {
            const desc = agents[i];
            if (!desc) continue;

            const holdOwner = desc.sprite || desc;
            const spanIdx = agentSpanIdx[i];

            if (spanIdx < 0) {
                if (holdOwner._bridgeHoldMs) holdOwner._bridgeHoldMs = 0;
                if (holdOwner._bridgeCourtesyMs) holdOwner._bridgeCourtesyMs = 0;
                if (holdOwner._bridgeCourtesyClearMs) holdOwner._bridgeCourtesyClearMs = 0;
                if (holdOwner._bridgeCourtesyExpired) holdOwner._bridgeCourtesyExpired = false;
                continue;
            }

            const span = spans[spanIdx];
            const flags = agentFlags[i];
            const entering = (flags & FLAG_ENTERING) !== 0;
            const isIdlePlanted = (flags & FLAG_IDLE_PLANTED) !== 0;
            const prevHoldMs = Number.isFinite(holdOwner._bridgeHoldMs) ? holdOwner._bridgeHoldMs : 0;
            const prevCourtesyMs = Number.isFinite(holdOwner._bridgeCourtesyMs) ? holdOwner._bridgeCourtesyMs : 0;

            let hold = false;
            let courtesyActive = false;

            if (!isIdlePlanted && entering && desc.bridgeZone !== 'deck') {
                if (span.circulationMode === 'platoon') {
                    const releaseActive = span._stallReleaseMs > 0 || prevHoldMs >= PLATOON_HARD_HOLD_CAP_MS;
                    if (!releaseActive && (desc.bridgeDir !== span.activeDir || span.draining)) {
                        hold = true;
                    } else if (
                        !releaseActive
                        && span._tJunctionSpan
                        && span._tJunctionSpan.exitingNeg
                        && desc.bridgeDir === 1
                    ) {
                        courtesyActive = true;
                        if (!holdOwner._bridgeCourtesyExpired && prevCourtesyMs < TWO_WAY_COURTESY_MAX_MS) {
                            hold = true;
                        } else {
                            holdOwner._bridgeCourtesyExpired = true;
                        }
                    }
                } else if (span.circulationMode === 'two-way') {
                    const mouthStraddled = desc.bridgeDir === 1
                        ? span.straddleNeg
                        : (desc.bridgeDir === -1 ? span.straddlePos : false);
                    if (mouthStraddled) {
                        courtesyActive = true;
                        if (!holdOwner._bridgeCourtesyExpired && prevCourtesyMs < TWO_WAY_COURTESY_MAX_MS) {
                            hold = true;
                        } else {
                            holdOwner._bridgeCourtesyExpired = true;
                        }
                    }
                }
            }

            if (courtesyActive) {
                if (holdOwner._bridgeCourtesyClearMs) holdOwner._bridgeCourtesyClearMs = 0;
                if (hold) {
                    holdOwner._bridgeCourtesyMs = prevCourtesyMs + dt;
                } else if (holdOwner._bridgeCourtesyMs) {
                    holdOwner._bridgeCourtesyMs = 0;
                }
            } else {
                if (holdOwner._bridgeCourtesyMs) holdOwner._bridgeCourtesyMs = 0;
                if (holdOwner._bridgeCourtesyExpired) {
                    // Require continuous absence for TWO_WAY_COURTESY_MAX_MS before
                    // re-arming courtesy so a 1-frame stream gap cannot starve waiters.
                    const clearMs = (Number.isFinite(holdOwner._bridgeCourtesyClearMs) ? holdOwner._bridgeCourtesyClearMs : 0) + dt;
                    if (clearMs >= TWO_WAY_COURTESY_MAX_MS) {
                        holdOwner._bridgeCourtesyExpired = false;
                        holdOwner._bridgeCourtesyClearMs = 0;
                    } else {
                        holdOwner._bridgeCourtesyClearMs = clearMs;
                    }
                } else if (holdOwner._bridgeCourtesyClearMs) {
                    holdOwner._bridgeCourtesyClearMs = 0;
                }
            }

            if (hold) {
                desc.bridgeHold = true;
                span.holds++;
                holdOwner._bridgeHoldMs = prevHoldMs + dt;
            } else {
                desc.bridgeHold = false;
                if (holdOwner._bridgeHoldMs) holdOwner._bridgeHoldMs = 0;
            }
        }
    }

    getSpan(bridgeId) {
        if (!bridgeId) return null;
        return this._spansById.get(bridgeId) || null;
    }

    getSpanForTile(tx, ty) {
        if (!Number.isFinite(tx) || !Number.isFinite(ty)) return null;
        return this._tileToSpan.get(packTileKey(Math.round(tx), Math.round(ty))) || null;
    }

    getDiagnostics() {
        let totalFlips = 0;
        let totalHolds = 0;
        const spans = new Array(this.spans.length);
        for (let i = 0; i < this.spans.length; i++) {
            const s = this.spans[i];
            totalFlips += s.flips;
            totalHolds += s.holds;
            spans[i] = {
                id: s.id,
                orientation: s.orientation,
                kind: s.kind,
                circulationMode: s.circulationMode,
                minAlong: s.minAlong,
                maxAlong: s.maxAlong,
                centerCross: s.centerCross,
                laneOffsetPx: s.laneOffsetPx,
                landingLaneOffsetPx: s.landingLaneOffsetPx,
                activeDir: s.activeDir,
                lastActiveDir: s.lastActiveDir,
                activeCount: s.activeCount,
                deckCountPos: s.deckCountPos,
                deckCountNeg: s.deckCountNeg,
                waitingPos: s.waitingPos,
                waitingNeg: s.waitingNeg,
                heldMs: s.heldMs,
                admittedInWave: s.admittedInWave,
                draining: s.draining,
                stallMs: s.stallMs,
                exitingNeg: s.exitingNeg,
                exitingPos: s.exitingPos,
                straddleNeg: s.straddleNeg,
                straddlePos: s.straddlePos,
                flips: s.flips,
                holds: s.holds,
            };
        }
        return {
            frames: this._frames,
            spanCount: this.spans.length,
            totalFlips,
            totalHolds,
            spans,
        };
    }
}
