import { TILE_HALF_HEIGHT, TILE_HALF_WIDTH } from './Projection.js';

const DISTANCE_EPSILON = 1e-6;
// BR-3 — a landmark deck tile whose hint names no laneOffsetPx keeps
// today's lane (IsometricRenderer's LANE_STEERING.bridgeOffsetPx).
const BRIDGE_LANE_OFFSET_FALLBACK_PX = 10;
// Below this many px of travel along the lane, IsometricRenderer's
// _laneSideForSprite has no direction to key a side on.
const LANE_SIDE_EPSILON_PX = 0.05;

/**
 * Bridge tiles already carry an authored grid orientation. Prefer it over
 * neighbor inference, which is ambiguous on widened road/bridge masks.
 */
export function laneAxisForBridgeOrientation(orientation) {
    const normalized = String(orientation || '').toUpperCase();
    if (normalized === 'NS') return { dx: 0, dy: 1 };
    if (normalized === 'EW') return { dx: 1, dy: 0 };
    return null;
}

/**
 * BR-3 / BR-5 — the crossing tiles of a bridge-tile map (key -> tile info),
 * as key -> { info, landing }: every walkable deck tile (landmark spans and
 * planks; harbour docks are quays, not crossings), plus the landing tiles,
 * the tiles one step past each end of a landmark deck along its axis. A
 * landing carries the info of the deck end it leads onto.
 */
export function bridgeCrossingTiles(bridgeTiles) {
    const crossings = new Map();
    if (!bridgeTiles?.size) return crossings;
    for (const [key, info] of bridgeTiles) {
        if (!info || info.kind === 'dock' || info.walkable === false) continue;
        crossings.set(key, { info, landing: false });
    }
    for (const [key, info] of bridgeTiles) {
        if (info?.kind !== 'landmark' || info.walkable === false) continue;
        const axis = laneAxisForBridgeOrientation(info.orientation);
        if (!axis) continue;
        const comma = key.indexOf(',');
        const tileX = Number(key.slice(0, comma));
        const tileY = Number(key.slice(comma + 1));
        for (const step of [-1, 1]) {
            const end = `${tileX + axis.dx * step},${tileY + axis.dy * step}`;
            if (!bridgeTiles.has(end)) crossings.set(end, { info, landing: true });
        }
    }
    return crossings;
}

/**
 * BR-3 — the world-px shift that puts a route waypoint on a landmark deck or
 * landing tile onto its walker's lane: `info.laneOffsetPx` (10 without one)
 * across the deck axis, on the side IsometricRenderer._laneSideForSprite
 * steers to. The lane tangent runs from a tile toward tile + axis; travel
 * along it is side +1, and the shift is side × offset along the lane's
 * perpendicular (-tangentY, tangentX). `travelX/Y` is the route's course
 * through the waypoint in world px. Null when the course has no component
 * along the deck, or the tile has no lane axis.
 */
export function bridgeLaneShift(info, travelX, travelY) {
    const axis = laneAxisForBridgeOrientation(info?.orientation);
    if (!axis) return null;
    const tangentX = (axis.dx - axis.dy) * TILE_HALF_WIDTH;
    const tangentY = (axis.dx + axis.dy) * TILE_HALF_HEIGHT;
    const length = Math.sqrt(tangentX * tangentX + tangentY * tangentY);
    const along = (Number(travelX) * tangentX + Number(travelY) * tangentY) / length;
    if (!(Math.abs(along) > LANE_SIDE_EPSILON_PX)) return null;
    const offset = Number.isFinite(info.laneOffsetPx) ? info.laneOffsetPx : BRIDGE_LANE_OFFSET_FALLBACK_PX;
    const scale = (along >= 0 ? offset : -offset) / length;
    return { x: -tangentY * scale, y: tangentX * scale };
}

/**
 * Keep a renderer-level steering correction from undoing path progress.
 *
 * AgentSprite advances toward its current waypoint before the renderer applies
 * lane and separation steering. If a correction would move the sprite farther
 * from that waypoint, project it back onto the current waypoint-distance
 * circle. This preserves the correction's lateral component without allowing a
 * slow agent to be pushed backward indefinitely.
 */
export function constrainSteeringToTarget({
    x,
    y,
    nextX,
    nextY,
    targetX,
    targetY,
}) {
    return constrainSteeringInto({ x: 0, y: 0, constrained: false }, x, y, nextX, nextY, targetX, targetY);
}

function setSteer(out, x, y, constrained) {
    out.x = x;
    out.y = y;
    out.constrained = constrained;
    return out;
}

/**
 * `constrainSteeringToTarget` written into `out` (`{ x, y, constrained }`)
 * and returned, so the renderer's per-pair steering allocates nothing (FP-8).
 */
export function constrainSteeringInto(out, x, y, nextX, nextY, targetX, targetY) {
    const currentX = Number(x);
    const currentY = Number(y);
    const candidateX = Number(nextX);
    const candidateY = Number(nextY);
    const waypointX = Number(targetX);
    const waypointY = Number(targetY);
    if (
        !Number.isFinite(currentX)
        || !Number.isFinite(currentY)
        || !Number.isFinite(candidateX)
        || !Number.isFinite(candidateY)
        || !Number.isFinite(waypointX)
        || !Number.isFinite(waypointY)
    ) {
        return setSteer(out, nextX, nextY, false);
    }
    const currentDx = waypointX - currentX;
    const currentDy = waypointY - currentY;
    const candidateDx = waypointX - candidateX;
    const candidateDy = waypointY - candidateY;
    const currentDistance = Math.sqrt(currentDx * currentDx + currentDy * currentDy);
    const candidateDistance = Math.sqrt(candidateDx * candidateDx + candidateDy * candidateDy);

    if (candidateDistance <= currentDistance + DISTANCE_EPSILON) {
        return setSteer(out, candidateX, candidateY, false);
    }
    if (currentDistance <= DISTANCE_EPSILON || candidateDistance <= DISTANCE_EPSILON) {
        return setSteer(out, currentX, currentY, true);
    }

    const scale = currentDistance / candidateDistance;
    return setSteer(
        out,
        waypointX + (candidateX - waypointX) * scale,
        waypointY + (candidateY - waypointY) * scale,
        true,
    );
}
