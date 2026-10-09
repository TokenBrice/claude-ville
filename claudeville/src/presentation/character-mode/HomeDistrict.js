import { BUILDING_DEFS } from '../../config/buildings.js';
import { classifyTool } from '../../domain/services/ToolIdentity.js';

export const WORK_DISTRICTS = Object.freeze(BUILDING_DEFS
    .filter(building => building.type !== 'watchtower'
        && building.capacity?.work > 0
        && building.visitTiles?.some(slot => slot.role === 'work'))
    .map(building => building.type));

export const HOME_DISTRICT_HOLD_MS = 120000;
const homeBySession = new Map();
let projectMix = new Map();
let districtLoads = new Map();
let contextBucket = -1;

export function projectKeyFor(agent) {
    return String(agent?.projectPath || '');
}

function sessionKeyFor(agent) {
    return String(agent?.sessionId || agent?.id || agent?.agentId || '');
}

function hashOf(value) {
    let hash = 2166136261;
    for (let i = 0; i < value.length; i++) hash = Math.imul(hash ^ value.charCodeAt(i), 16777619);
    return hash >>> 0;
}

// The allocator supplies live observations, not guessed itinerary stops. A
// two-second context snapshot is shared by every unchanged routing call site.
export function updateHomeDistrictContext(sprites, now = Date.now()) {
    const bucket = Math.floor(now / 2000);
    if (contextBucket === bucket) return;
    contextBucket = bucket;
    projectMix = new Map();
    districtLoads = new Map();
    const activeIds = new Set();
    for (const sprite of sprites) {
        const agent = sprite?.agent;
        if (!agent) continue;
        activeIds.add(sessionKeyFor(agent));
        const project = projectKeyFor(agent);
        const tool = agent.currentTool || agent.lastTool;
        const building = tool ? classifyTool(tool, agent.currentToolInput || agent.lastToolInput)?.building : null;
        if (project && WORK_DISTRICTS.includes(building)) {
            let mix = projectMix.get(project);
            if (!mix) projectMix.set(project, mix = new Map());
            mix.set(building, (mix.get(building) || 0) + 1);
        }
        const district = sprite.behavior?.building;
        if (!sprite.visitRole && WORK_DISTRICTS.includes(district)) {
            districtLoads.set(district, (districtLoads.get(district) || 0) + 1);
        }
    }
    for (const id of homeBySession.keys()) if (!activeIds.has(id)) homeBySession.delete(id);
}

/**
 * No-signal anchor only; callers resolve real tools and targets first.
 * Weighted rendezvous hashing keeps a session's home fixed for two minutes.
 * Optional districtWeights lets DayRoutine bias the next choice, never tools.
 */
export function homeDistrictFor(agent, {
    now = Date.now(),
    toolMix = projectMix.get(projectKeyFor(agent)),
    loads = districtLoads,
    districtWeights = null,
} = {}) {
    const id = sessionKeyFor(agent);
    const cached = homeBySession.get(id);
    if (cached && now - cached.selectedAt < HOME_DISTRICT_HOLD_MS) return cached.building;
    let selected = WORK_DISTRICTS[0];
    let best = Infinity;
    const readWeight = (source, type) => Number(source?.get?.(type) ?? source?.[type]) || 0;
    for (const type of WORK_DISTRICTS) {
        const capacity = BUILDING_DEFS.find(building => building.type === type).capacity.work;
        const load = Math.max(0, readWeight(loads, type)) / capacity;
        const observed = Math.max(0, readWeight(toolMix, type));
        const dayWeight = districtWeights ? Math.max(0.05, readWeight(districtWeights, type) || 1) : 1;
        const weight = (1 + Math.min(4, observed)) * dayWeight / ((1 + load) ** 2);
        const random = (hashOf(`${id}:${projectKeyFor(agent)}:${type}`) + 1) / 4294967297;
        const score = -Math.log(random) / weight;
        if (score < best) {
            best = score;
            selected = type;
        }
    }
    homeBySession.set(id, { building: selected, selectedAt: now });
    return selected;
}
