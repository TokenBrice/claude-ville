const DISTANCE_EPSILON = 1e-6;

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
        return { x: nextX, y: nextY, constrained: false };
    }
    const currentDistance = Math.hypot(waypointX - currentX, waypointY - currentY);
    const candidateDistance = Math.hypot(waypointX - candidateX, waypointY - candidateY);

    if (candidateDistance <= currentDistance + DISTANCE_EPSILON) {
        return { x: candidateX, y: candidateY, constrained: false };
    }
    if (currentDistance <= DISTANCE_EPSILON || candidateDistance <= DISTANCE_EPSILON) {
        return { x: currentX, y: currentY, constrained: true };
    }

    const scale = currentDistance / candidateDistance;
    return {
        x: waypointX + (candidateX - waypointX) * scale,
        y: waypointY + (candidateY - waypointY) * scale,
        constrained: true,
    };
}
