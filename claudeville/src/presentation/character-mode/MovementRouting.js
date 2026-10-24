import { AgentStatus } from '../../domain/value-objects/AgentStatus.js';
import { classifyTool } from '../../domain/services/ToolIdentity.js';
import { homeDistrictFor } from './HomeDistrict.js';

/**
 * The building a classified tool call actually names. Command's `run-shell`
 * is the classifier's no-evidence fallback for a shell command it does not
 * recognize, not orchestration, so it names no building: the caller falls
 * back to what it already knows and then the session's home district. The
 * classification itself (verb, bubble label) is unchanged.
 */
export function placedToolBuilding(classified) {
    if (!classified?.building) return null;
    if (classified.building === 'command' && classified.reason === 'run-shell') return null;
    return classified.building;
}

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
