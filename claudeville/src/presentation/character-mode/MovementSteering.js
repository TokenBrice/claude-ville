const DISTANCE_EPSILON = 1e-6;

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
    const values = [x, y, nextX, nextY, targetX, targetY].map(Number);
    if (values.some(value => !Number.isFinite(value))) {
        return { x: nextX, y: nextY, constrained: false };
    }

    const [
        currentX,
        currentY,
        candidateX,
        candidateY,
        waypointX,
        waypointY,
    ] = values;
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
