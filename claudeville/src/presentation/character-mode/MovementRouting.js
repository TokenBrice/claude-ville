import { AgentStatus } from '../../domain/value-objects/AgentStatus.js';
import { classifyTool, placedBuilding as placedToolBuilding } from '../../domain/services/ToolIdentity.js';
import { homeDistrictFor } from './HomeDistrict.js';

// AG-3: Command's unknown-shell fallback names no building (see ToolIdentity).
export { placedToolBuilding };

/**
 * Resolve the building that may replace an agent's in-flight route.
 *
 * Completed and idle villagers own an ambient route until they arrive. Their
 * status does not identify a new destination, so recomputing one every frame
 * would continuously discard the current path. Directed states still react
 * immediately to status and destination changes.
 */
export function resolveUpdateRouteBuilding({
    activeIntentBuilding = null,
    agent = null,
    status = null,
    currentBuilding = null,
    targetBuilding = null,
    lastKnownBuilding = null,
} = {}) {
    if (activeIntentBuilding) return activeIntentBuilding;

    if (status === AgentStatus.WORKING) {
        const toolBuilding = agent?.currentTool
            ? placedToolBuilding(classifyTool(agent.currentTool, agent.currentToolInput ?? agent.lastToolInput))
            : null;
        return toolBuilding || targetBuilding || lastKnownBuilding || homeDistrictFor(agent);
    }
    if (status === AgentStatus.WAITING) {
        return targetBuilding || lastKnownBuilding || 'taskboard';
    }
    if (status === AgentStatus.ERRORED || status === AgentStatus.RATE_LIMITED) {
        return 'watchtower';
    }
    if (status === AgentStatus.WAITING_ON_USER) {
        return 'command';
    }

    return currentBuilding || null;
}
