// The workshop model (plan 5.1, 5.4; FOL-1, FOL-4, FOL-7, SIG-4, SIG-11).
// Pure and Web-Audio-free: it reads the audio-owned World model — non-stale
// `working` agents and `classifyTool(currentTool, input)` — so it behaves
// the same in World and Dashboard (where `tool:invoked` never fires), and
// turns them into per-building densities the Town band's percussion
// follows (BgmDirector.percussionDensities).
//
// Work is density, never one sound per call (D8): tool starts over the last
// minute raise a building's accent *rate* through a saturating law whose slope
// never reaches one. Stale agents, a lost link and `working === 0`
// contribute nothing (S6, C-FOL-5).
//
// Optional `memory` (createWorkshopMemory) carries what one observation cannot:
// tool-start history, token beats for the Mine, and slot stability. Time is
// always passed in (the wall clock).

import { classifyTool as classifyToolIdentity } from '../../../domain/services/ToolIdentity.js';
import { TokenUsage } from '../../../domain/value-objects/TokenUsage.js';
import { isAudibleAgent } from './AudibleWorld.js';

// Tool starts count toward a building's density for this long.
export const DENSITY_WINDOW_MS = 60_000;
// Accent rate (per minute) = CAP · (1 − e^(−starts/KNEE)): monotonic in
// density, saturating, and with slope CAP/KNEE < 1 it is always below the
// start rate — never one accent per call.
export const ACCENT_CAP_PER_MIN = 18;
export const ACCENT_KNEE_PER_MIN = 24;
// A token delta this large between observations is one Mine beat (the Mine's
// worker is token burn; LandmarkActivity's ritual threshold).
export const TOKEN_BEAT_MIN = 256;
// An agent works the Mine while its last token beat is this recent.
export const MINE_ACTIVE_MS = 12_000;
// Each agent owns one third of a building's slots (its pitch index mod 3),
// so co-present agents keep distinct slots.
const GRID_STRIDE = 3;

// Slot pitches per building (FOL-2 v3: Forge A6/E7/C♯7/F♯7, Archive five
// page centres).
const PITCHES = { forge: 4, archive: 5, mine: 4, taskboard: 4, observatory: 4, portal: 4, command: 4, harbor: 4 };
// Task-board runs that verify (tests, checks) strike chalk, not the tack.
const VERIFY_REASONS = new Set(['verify', 'inspect-validation']);

export const BUILDING_IDS = Object.freeze(['forge', 'archive', 'mine', 'taskboard', 'observatory', 'portal', 'command', 'harbor']);

// Per building: its slot count. The Lighthouse has no workshop.
export const BUILDINGS = Object.freeze(Object.fromEntries(BUILDING_IDS.map(id => [
    id,
    Object.freeze({ id, pitches: PITCHES[id] }),
])));

export function createWorkshopMemory() {
    return {
        // agentId → { key, working, tokens }
        agents: new Map(),
        // agentId → [{ at, building }] tool starts inside the density window
        starts: new Map(),
        // agentId → [at] Mine token beats inside the density window
        beats: new Map(),
        // building → Map(agentId → pitchIndex)
        slots: new Map(),
    };
}

function agentList(source) {
    if (!source) return [];
    if (Array.isArray(source)) return source;
    if (source instanceof Map) return [...source.values()];
    if (source.agents) return agentList(source.agents);
    if (typeof source[Symbol.iterator] === 'function') return [...source];
    return [];
}

function toolKey(agent) {
    const input = agent.currentToolInput;
    const text = input == null ? '' : typeof input === 'string' ? input : JSON.stringify(input);
    return `${agent.currentTool || ''}\u001f${text}`;
}

function isWorking(agent) {
    return agent.status === 'working' && agent.isDeparted !== true;
}

function isFresh(agent, now, staleMs) {
    if (!isAudibleAgent(agent, now)) return false;
    if (staleMs == null) return true;
    const observedAt = agent.signalObservedAt ?? agent.freshness?.observedAt;
    return !(Number.isFinite(observedAt) && now - observedAt > staleMs);
}

function classify(agent, classifyTool) {
    if (!agent.currentTool) return null;
    const result = classifyTool(agent.currentTool, agent.currentToolInput);
    if (!result) return null;
    if (typeof result === 'string') return { building: result, reason: null };
    return result.building ? result : null;
}

function prune(list, since) {
    let drop = 0;
    while (drop < list.length && (list[drop].at ?? list[drop]) < since) drop++;
    if (drop) list.splice(0, drop);
    return list;
}

// FNV-1a over UTF-16 code units: a stable preferred slot per agent.
function fnv1a(text) {
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
        h ^= text.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
}

// Pitch indices for the agents present at one building: an agent keeps its
// index while it stays; a newcomer takes its hashed index or the next free
// one, so co-present agents never share a pitch while there are enough.
function assignSlots(ids, previous, pitches) {
    const next = new Map();
    const used = new Set();
    const free = () => {
        for (let i = 0; i < pitches; i++) if (!used.has(i)) return i;
        return -1;
    };
    const place = (id, preferred) => {
        let index = preferred;
        if (used.has(index)) {
            for (let step = 1; step < pitches; step++) {
                const probe = (preferred + step) % pitches;
                if (!used.has(probe)) { index = probe; break; }
            }
        }
        used.add(index);
        next.set(id, index);
    };
    const kept = ids.filter(id => previous?.has(id));
    const added = ids.filter(id => !previous?.has(id));
    for (const id of kept) {
        const index = previous.get(id);
        if (used.has(index) && free() >= 0) place(id, free());
        else { used.add(index); next.set(id, index); }
    }
    for (const id of added) place(id, fnv1a(String(id)) % pitches);
    return next;
}

// Accents per minute for a building's tool-start density (starts per minute).
export function accentRateFor(startsPerMin) {
    const starts = Number(startsPerMin);
    if (!(starts > 0)) return 0;
    return ACCENT_CAP_PER_MIN * (1 - Math.exp(-starts / ACCENT_KNEE_PER_MIN));
}

function emptyBuilding(id, focused = false) {
    return {
        id,
        working: 0,
        startsPerMin: 0,
        accentRate: 0,
        focused,
        slots: [],
    };
}

/**
 * The work stratum's state for one observation of the village.
 * `agents`: an array, iterable, Map or `{ agents }`. `linkOk === false` or no
 * audible working agent → every building empty, `total` 0.
 * Returns { buildings: { [id]: { id, working, startsPerMin, accentRate,
 * focused, slots: [{ agentId, slot, pitchIndex, weight, focused, verify }] } },
 * total, linkOk }.
 */
export function buildWorkshopState({
    agents,
    now = Date.now(),
    linkOk = true,
    selectedAgentId = null,
    classifyTool = classifyToolIdentity,
    staleMs = null,
    memory = null,
} = {}) {
    const buildings = Object.fromEntries(BUILDING_IDS.map(id => [id, emptyBuilding(id)]));
    if (linkOk === false) return { buildings, total: 0, linkOk: false };

    const since = now - DENSITY_WINDOW_MS;
    // building → Map(agentId → { weight, verify })
    const present = new Map(BUILDING_IDS.map(id => [id, new Map()]));
    const seen = new Set();

    for (const agent of agentList(agents)) {
        if (!agent || agent.id == null) continue;
        const id = agent.id;
        if (!isFresh(agent, now, staleMs)) continue;
        seen.add(id);
        const working = isWorking(agent);
        const classified = working ? classify(agent, classifyTool) : null;
        const building = classified && BUILDINGS[classified.building] ? classified.building : null;
        const key = toolKey(agent);
        const tokens = TokenUsage.totalTokens(agent.tokens);

        let starts = [];
        let beats = [];
        if (memory) {
            const previous = memory.agents.get(id);
            starts = prune(memory.starts.get(id) || [], since);
            beats = prune(memory.beats.get(id) || [], since);
            // A tool start: a working agent's tool (or its input) changed
            // since the last observation, or it just started working.
            if (building && (!previous || !previous.working || previous.key !== key)) {
                starts.push({ at: now, building });
            }
            if (working && previous && tokens - previous.tokens >= TOKEN_BEAT_MIN) beats.push(now);
            memory.agents.set(id, { key, working, tokens });
            if (starts.length) memory.starts.set(id, starts); else memory.starts.delete(id);
            if (beats.length) memory.beats.set(id, beats); else memory.beats.delete(id);
        }
        if (!working) continue;

        if (building) {
            const own = starts.filter(start => start.building === building).length;
            present.get(building).set(id, {
                weight: own * (60_000 / DENSITY_WINDOW_MS),
                verify: building === 'taskboard' && VERIFY_REASONS.has(classified.reason),
            });
        }
        const lastBeat = beats.at(-1);
        if (building !== 'mine' && lastBeat != null && now - lastBeat <= MINE_ACTIVE_MS) {
            present.get('mine').set(id, { weight: beats.length * (60_000 / DENSITY_WINDOW_MS), verify: false });
        }
    }

    if (memory) {
        for (const id of memory.agents.keys()) {
            if (seen.has(id)) continue;
            memory.agents.delete(id);
            memory.starts.delete(id);
            memory.beats.delete(id);
        }
    }

    const sounding = new Set();
    for (const id of BUILDING_IDS) {
        const members = present.get(id);
        const ids = [...members.keys()].map(String).sort();
        const lookup = new Map([...members.keys()].map(agentId => [String(agentId), agentId]));
        const slots = assignSlots(ids, memory?.slots.get(id), BUILDINGS[id].pitches);
        if (memory) {
            if (slots.size) memory.slots.set(id, slots); else memory.slots.delete(id);
        }
        if (!ids.length) continue;
        const state = buildings[id];
        state.working = ids.length;
        state.slots = ids.map((key) => {
            const agentId = lookup.get(key);
            const member = members.get(agentId);
            const pitchIndex = slots.get(key);
            sounding.add(key);
            return {
                agentId,
                slot: pitchIndex % GRID_STRIDE,
                pitchIndex,
                weight: member.weight,
                focused: selectedAgentId != null && String(selectedAgentId) === key,
                verify: member.verify,
            };
        });
        state.startsPerMin = state.slots.reduce((sum, slot) => sum + slot.weight, 0);
        state.accentRate = accentRateFor(state.startsPerMin);
        state.focused = state.slots.some(slot => slot.focused);
    }

    return { buildings, total: sounding.size, linkOk: true };
}
