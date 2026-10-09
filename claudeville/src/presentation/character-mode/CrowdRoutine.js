// W4.3 / W4.4 / W4.8 (PL-P3, PL-P4, PL-P12) — the living crowd's schedule,
// pure. AgentSprite runs the phases; VisitTileAllocator enforces the caps
// (it holds every live reservation, so it is the one place that can count).
//
//   stroll   — an IDLE villager sits MIN_SIT_MS‥MAX_SIT_MS (seeded per agent
//              and cycle, so a bench row never stands up together), strolls
//              to a scenic point, dwells STROLL_DWELL_*, and sits again.
//              At most STROLL_CAP strollers at once (fewer at night).
//   errand   — a WORKING agent whose intent ended ERRAND_GAP_MS ago with no
//              new one walks a short errand drawn from its recent phases.
//              Any real intent ends it at once; at most ⅓ of agents at once.
//              An errand is never a working visit (role 'errand', V8).
//   winddown — a COMPLETED agent walks to the harbour quay or a bench,
//              rests briefly, then waits inside the gate. Removal is never
//              delayed: the departure sigil lands wherever the body stands.

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

/** 'quay' or 'bench': where a finished session rests before the gate. */
export function windDownStop(agentId) {
    return routineHash(`${agentId}:winddown-stop`) % 2 === 0 ? 'quay' : 'bench';
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
