// W4.3 / W4.4 / W4.8 (PL-P3, PL-P4, PL-P12) — the living crowd's schedule,
// pure. AgentSprite runs the phases; VisitTileAllocator enforces the caps
// (it holds every live reservation, so it is the one place that can count).
//
//   stroll   — an IDLE villager sits MIN_SIT_MS‥MAX_SIT_MS (seeded per agent
//              and cycle, so a tavern table never stands up together), strolls
//              to a scenic point, dwells STROLL_DWELL_*, and sits again.
//              At most STROLL_CAP strollers at once (fewer at night).
//   errand   — a WORKING agent whose intent ended ERRAND_GAP_MS ago with no
//              new one walks a short errand drawn from its recent phases.
//              Any real intent ends it at once; at most ⅓ of agents at once.
//              An errand is never a working visit (role 'errand', V8).
//   pint     — an agent waiting on its subagents takes a rest seat, the
//              Tavern's first, and the wait's end calls it back: a wait
//              tool pending SUBAGENT_WAIT_PINT_MS (Codex's short slices
//              count as one wait), a closed turn still waiting on its own
//              background crew (PV-2, `backgroundPending`) as long, or a
//              COMPLETED lead whose subagents still run, at once.
//   winddown — a COMPLETED agent walks to the harbour quay or the Tavern
//              for a last pint, then waits inside the gate. Removal is never
//              delayed: the departure sigil lands wherever the body stands.

import { BUILDING_DEFS } from '../../config/buildings.js';
import { REST_SEATS, REST_STANDS, VILLAGE_GATE } from '../../config/townPlan.js';
import { stillWorkState } from './MarkGovernor.js';
import { AgentStatus } from '../../domain/value-objects/AgentStatus.js';
import { isBlockingMcpDelegationTool, isWaitingOnCrew, TurnState } from '../../domain/services/StatusResolver.js';

export const STROLL_CAP = 6;
export const MIN_SIT_MS = 45_000;
export const MAX_SIT_MS = 120_000;
export const STROLL_DWELL_MIN_MS = 20_000;
export const STROLL_DWELL_MAX_MS = 40_000;
// A stroll or errand leg that never arrives (blocked, re-aimed) gives up.
export const STROLL_LEG_TIMEOUT_MS = 90_000;
export const ERRAND_LEG_TIMEOUT_MS = 45_000;
// A stroll the cap refused retries after this seeded span, still seated.
export const STROLL_RETRY_MIN_MS = 15_000;
export const STROLL_RETRY_MAX_MS = 30_000;

export const ERRAND_GAP_MS = 3_000;
export const ERRAND_DWELL_MIN_MS = 6_000;
export const ERRAND_DWELL_MAX_MS = 12_000;
export const ERRAND_COOLDOWN_MIN_MS = 8_000;
export const ERRAND_COOLDOWN_MAX_MS = 16_000;
// How many recent building visits seed the errand table.
export const ERRAND_RECENT_WINDOW = 6;

export const WIND_DOWN_DWELL_MIN_MS = 12_000;
export const WIND_DOWN_DWELL_MAX_MS = 25_000;

export const SUBAGENT_WAIT_PINT_MS = 60_000;
// Codex waits in slices (wait_agent with a short timeout): the next slice
// inside this gap continues the same wait.
export const SUBAGENT_WAIT_SLICE_GAP_MS = 15_000;
// Tools that block on subagents. A bare `wait` is omp's job wait; Codex's
// polls a code cell.
const SUBAGENT_WAIT_TOOLS = new Set(['wait_agent', 'functions.wait_agent', 'Agent', 'Task', 'swarm_wait']);

// Occupancy roles of the routine. None is ever a working visit.
export const ROUTINE_ROLES = Object.freeze(['stroll', 'errand', 'winddown']);

export function routineHash(text) {
    const value = String(text ?? '');
    let hash = 2166136261;
    for (let i = 0; i < value.length; i++) hash = Math.imul(hash ^ value.charCodeAt(i), 16777619);
    return hash >>> 0;
}

/** A whole-ms span in [min, max], fixed by `key`. */
export function seededSpan(key, min, max) {
    const lo = Math.min(min, max);
    const range = Math.max(0, Math.round(Math.abs(max - min)));
    return lo + (routineHash(key) % (range + 1));
}

/** The seated span before a stroll: never under MIN_SIT_MS; night stretches it. */
export function sitDurationMs(agentId, cycle = 0, sitScale = 1) {
    const base = seededSpan(`${agentId}:sit:${cycle}`, MIN_SIT_MS, MAX_SIT_MS);
    const scale = Number.isFinite(sitScale) && sitScale > 0 ? sitScale : 1;
    return Math.max(MIN_SIT_MS, Math.round(base * scale));
}

export function strollDwellMs(agentId, cycle = 0) {
    return seededSpan(`${agentId}:stroll:${cycle}`, STROLL_DWELL_MIN_MS, STROLL_DWELL_MAX_MS);
}

export function strollRetryMs(agentId, cycle = 0) {
    return seededSpan(`${agentId}:stroll-retry:${cycle}`, STROLL_RETRY_MIN_MS, STROLL_RETRY_MAX_MS);
}

export function errandDwellMs(agentId, cycle = 0) {
    return seededSpan(`${agentId}:errand:${cycle}`, ERRAND_DWELL_MIN_MS, ERRAND_DWELL_MAX_MS);
}

export function errandCooldownMs(agentId, cycle = 0) {
    return seededSpan(`${agentId}:errand-cool:${cycle}`, ERRAND_COOLDOWN_MIN_MS, ERRAND_COOLDOWN_MAX_MS);
}

export function windDownDwellMs(agentId) {
    return seededSpan(`${agentId}:winddown`, WIND_DOWN_DWELL_MIN_MS, WIND_DOWN_DWELL_MAX_MS);
}

export function isSubagentWaitTool(agent, tool) {
    if (tool === 'wait') return agent?.provider === 'omp';
    return SUBAGENT_WAIT_TOOLS.has(tool);
}

/**
 * The next subagent-wait record `{ since, seenAt, pint }` for `agent` at
 * `now`, or null when it is not waiting on subagents. `pint` marks a wait
 * long enough for a seat.
 */
export function advanceSubagentWait(prev, agent, now, { hasLiveSubagents = false } = {}) {
    if (!agent || agent.isDeparted) return null;
    if (agent.status === AgentStatus.COMPLETED) {
        return hasLiveSubagents ? { since: prev?.since ?? now, seenAt: now, pint: true } : null;
    }
    if (agent.status !== AgentStatus.WORKING) return null;
    const pending = agent.turnState === TurnState.TOOL_PENDING;
    if (isWaitingOnCrew(agent) || (pending && isSubagentWaitTool(agent, agent.pendingTool))) {
        const observedSince = Number(pending ? agent.pendingSince : agent.awaitingSince);
        const since = Math.min(prev?.since ?? now, observedSince > 0 ? observedSince : now);
        return { since, seenAt: now, pint: now - since >= SUBAGENT_WAIT_PINT_MS };
    }
    // Between two slices of one wait the record (and its seat) holds: a
    // wait tool's next slice, or a crew notice the lead reads and closes.
    if (prev && agent.turnState === TurnState.WORKING
        && (isSubagentWaitTool(agent, agent.lastTool) || isBlockingMcpDelegationTool(agent.lastTool)
            || Number(agent.backgroundPending?.count) > 0)
        && now - prev.seenAt < SUBAGENT_WAIT_SLICE_GAP_MS) return prev;
    return null;
}

/** 'quay' or 'tavern': where a finished session rests before the gate. */
export function windDownStop(agentId) {
    return routineHash(`${agentId}:winddown-stop`) % 2 === 0 ? 'quay' : 'tavern';
}

/** Concurrent errands allowed among `agentCount` live agents: at most a third. */
export function errandCap(agentCount) {
    return Math.floor(Math.max(0, Number(agentCount) || 0) / 3);
}

/**
 * The errand a between-intents worker runs, or null. `recentBuildings` is
 * oldest-first; `weightFor(type)` is the daypart weight (DayRoutine). Kinds:
 * deliver → Task board after an edit burst, scroll → Archive after a long
 * read, quay → the harbour quay after a push, home → its home district.
 * The building it stands at now is never an errand.
 */
export function errandChoice({
    agentId,
    cycle = 0,
    recentBuildings = [],
    currentBuilding = null,
    homeDistrict = null,
    weightFor = () => 1,
} = {}) {
    const recent = Array.isArray(recentBuildings) ? recentBuildings.slice(-ERRAND_RECENT_WINDOW) : [];
    const count = (type) => recent.reduce((sum, value) => sum + (value === type ? 1 : 0), 0);
    const table = [
        { kind: 'deliver', building: 'taskboard', weight: 1 + 2 * count('forge') },
        { kind: 'scroll', building: 'archive', weight: 0.5 + 2 * count('archive') },
        { kind: 'quay', building: 'harbor', weight: 0.5 + 2 * count('harbor') },
        { kind: 'home', building: homeDistrict, weight: 1.5 },
    ].filter((entry) => entry.building && entry.building !== currentBuilding)
        .map((entry) => ({ ...entry, weight: entry.weight * Math.max(0, Number(weightFor(entry.building)) || 0) }))
        .filter((entry) => entry.weight > 0);
    if (table.length === 0) return null;
    const total = table.reduce((sum, entry) => sum + entry.weight, 0);
    let pick = (routineHash(`${agentId}:errand-pick:${cycle}`) % 10_000) / 10_000 * total;
    for (const entry of table) {
        pick -= entry.weight;
        if (pick < 0) return { kind: entry.kind, building: entry.building };
    }
    const last = table[table.length - 1];
    return { kind: last.kind, building: last.building };
}

// Keep this anchor fixed for the whole think, including the return half of each pace.
export function stillWorkRoutine(agent, nowMs, building, { station, previousPose, reducedMotion = false } = {}) {
    const state = stillWorkState(agent, nowMs);
    if (!state) {
        return previousPose && agent?.status === AgentStatus.WORKING && agent.pendingTool
            ? { stillWorkPose: null, gait: 'run', visitRole: 'work' } : null;
    }
    if (!building || building.type === 'tavern') return null;
    const tiles = (building.visitTiles || []).filter(tile =>
        !REST_SEATS.some(seat => seat.tileX === tile.tileX && seat.tileY === tile.tileY));
    const work = tiles.filter(tile => tile.role === 'work' || !tile.role);
    const home = work.find(tile => tile.tileX === station?.tileX && tile.tileY === station?.tileY)
        || work[routineHash(agent.id) % work.length];
    if (!home) return null;

    const pacing = state.kind === 'composing' && !state.showTurnSand;
    let target = home;
    if (pacing && !reducedMotion && Math.floor((state.elapsedMs - 30_000) / 8_000) % 2) {
        // The entire segment stays on this building's visit tiles. If the work
        // tile is isolated, take a half-step within it rather than crossing a gap.
        const adjacent = tile => tile !== home && Math.abs(tile.tileX - home.tileX) <= 1
            && Math.abs(tile.tileY - home.tileY) <= 1;
        target = work.find(adjacent) || tiles.find(adjacent) || { ...home, tileX: home.tileX + 0.25 };
    }
    return {
        building: building.type, visitRole: 'work', target, facingPoint: home.facingPoint ?? building.entrance,
        stillWorkPose: pacing ? 'pace-work' : 'sit-work', gait: pacing && !reducedMotion ? 'walk' : 'stand',
    };
}

const archiveCloister = BUILDING_DEFS.find(building => building.type === 'archive')
    .visitTiles.find(tile => tile.queueGroup === 'archive-alcove');
const SHELTERS = [
    { building: 'tavern', target: REST_STANDS.tavern.tiles[0] },
    { building: 'gate', target: { tileX: VILLAGE_GATE.tileX, tileY: VILLAGE_GATE.tileY } },
    { building: 'archive', target: archiveCloister },
];

export function squallShelter(agent, weather, position = agent?.position) {
    if (agent?.status !== AgentStatus.IDLE || agent.isDeparted || !position) return null;
    if (weather?.type !== 'storm' && !(weather?.type === 'rain' && weather.intensity >= 0.72)) return null;
    const distance = ({ target }) => Math.hypot(target.tileX - position.tileX, target.tileY - position.tileY);
    const shelter = SHELTERS.reduce((near, next) => distance(next) < distance(near) ? next : near);
    return { ...shelter, visitRole: 'rest', gait: 'run' };
}
