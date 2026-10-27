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
