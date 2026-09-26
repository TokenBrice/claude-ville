// The workshop model (plan 5.1, 5.4, 5.7; FOL-1, FOL-4, FOL-7, SIG-4,
// SIG-11, SIG-13). Pure and Web-Audio-free: it reads the audio-owned World
// model — non-stale `working` agents and `classifyTool(currentTool, input)` —
// so it behaves the same in World and Dashboard (where `tool:invoked` never
// fires), and turns them into per-building densities the WorkshopLayer
// schedules on each building's gesture grid.
//
// Work is density, never one sound per call (D8): tool starts over the last
// minute raise a building's accent *rate* through a saturating law whose slope
// never reaches one, and continuing work is carried by ghosts on the grid
// under a liveness floor. Stale agents, a lost link and `working === 0`
// contribute nothing (S6, C-FOL-5).
//
// Optional `memory` (createWorkshopMemory) carries what one observation cannot:
// tool-start history, token beats for the Mine, and slot stability. Time is
// always passed in (the wall clock, like the ritual grid).

import { classifyTool as classifyToolIdentity } from '../../../domain/services/ToolIdentity.js';
import { TokenUsage } from '../../../domain/value-objects/TokenUsage.js';
import { RITUAL_GESTURE_PERIOD_MS, RITUAL_POSE_BY_BUILDING } from '../../character-mode/RitualConductor.js';
import { isAudibleAgent } from './AudibleWorld.js';

// Tool starts count toward a building's density for this long.
export const DENSITY_WINDOW_MS = 60_000;
// Accent rate (per minute) = CAP · (1 − e^(−starts/KNEE)): monotonic in
// density, saturating, and with slope CAP/KNEE < 1 it is always below the
// start rate — the layer can never be one accent per call.
export const ACCENT_CAP_PER_MIN = 18;
export const ACCENT_KNEE_PER_MIN = 24;
// A token delta this large between observations is one Mine beat (the Mine's
// worker is token burn; LandmarkActivity's ritual threshold).
export const TOKEN_BEAT_MIN = 256;
// An agent works the Mine while its last token beat is this recent.
export const MINE_ACTIVE_MS = 12_000;
// Accents take every third grid tick (the drawn downbeat stride); each agent
// owns one third, so co-present agents de-clump in Dashboard.
const GRID_STRIDE = 3;
// Quota weather (SIG-13, 5.7): the rumble rises from this ratio to full at 1.
export const QUOTA_RUMBLE_FROM = 0.7;
export const QUOTA_BAND_HZ = Object.freeze([80, 160]);

// Ghost probability per own-third tick (FOL-1 step 4); the Mine has no ghosts
// (its accents are token beats). Slot pitches per building (FOL-2 v3: Forge
// A6/E7/C♯7/F♯7, Archive five page centres).
const GHOST_P = { forge: 0.55, archive: 0.70, mine: 0, taskboard: 0.60, observatory: 0.60, portal: 0.40, command: 0.40, harbor: 0.60 };
const PITCHES = { forge: 4, archive: 5, mine: 4, taskboard: 4, observatory: 4, portal: 4, command: 4, harbor: 4 };
// Task-board runs that verify (tests, checks) strike chalk, not the tack.
const VERIFY_REASONS = new Set(['verify', 'inspect-validation']);

export const BUILDING_IDS = Object.freeze(['forge', 'archive', 'mine', 'taskboard', 'observatory', 'portal', 'command', 'harbor']);

// Per building: the gesture grid (ms per gesture, from the ritual poses), the
// liveness floor L_b = max(2.4 s, 6·P_b) (S7), ghost probability and slot
// count. The Lighthouse has no workshop.
export const BUILDINGS = Object.freeze(Object.fromEntries(BUILDING_IDS.map((id) => {
    const gridMs = RITUAL_GESTURE_PERIOD_MS[RITUAL_POSE_BY_BUILDING[id]];
    return [id, Object.freeze({
        id,
        gridMs,
        livenessMs: Math.max(2400, 6 * gridMs),
        ghostP: GHOST_P[id],
        pitches: PITCHES[id],
    })];
})));

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
    const spec = BUILDINGS[id];
    return {
        id,
        working: 0,
        startsPerMin: 0,
        accentRate: 0,
        ghostGridMs: spec.gridMs,
        ghostP: spec.ghostP,
        livenessMs: spec.livenessMs,
        focused,
        slots: [],
    };
}

/**
 * The work stratum's state for one observation of the village.
 * `agents`: an array, iterable, Map or `{ agents }`. `linkOk === false` or no
 * audible working agent → every building empty, `total` 0.
 * Returns { buildings: { [id]: { id, working, startsPerMin, accentRate,
 * ghostGridMs, ghostP, livenessMs, focused, slots: [{ agentId, slot,
 * pitchIndex, weight, focused, verify }] } }, total, linkOk }.
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

function gridTicks(gridMs, fromMs, toMs, visit) {
    if (!(gridMs > 0) || !(toMs > fromMs)) return;
    for (let k = Math.ceil(fromMs / gridMs); k * gridMs < toMs; k++) visit(k, k * gridMs);
}

const phaseOf = k => ((k % GRID_STRIDE) + GRID_STRIDE) % GRID_STRIDE;

/**
 * Accents for one building over [fromMs, toMs) of wall time, on the grid
 * k·gridMs. Each agent strikes its own third (k ≡ slot mod 3) with the
 * building's accent rate split by its share of the tool starts, so an agent
 * whose starts stopped falls silent while the others keep their pitches.
 * Returns [{ at, agentId, pitchIndex, slot, verify, kind: 'accent' }].
 */
export function accentPlan(building, rng, { fromMs, toMs } = {}) {
    const out = [];
    const slots = building?.slots || [];
    const total = slots.reduce((sum, slot) => sum + (slot.weight > 0 ? slot.weight : 0), 0);
    if (!(building?.accentRate > 0) || !(total > 0)) return out;
    const gridMs = building.ghostGridMs;
    const strideSec = GRID_STRIDE * gridMs / 1000;
    gridTicks(gridMs, fromMs, toMs, (k, at) => {
        const phase = phaseOf(k);
        for (const slot of slots) {
            if (slot.slot !== phase || !(slot.weight > 0)) continue;
            const perMin = building.accentRate * slot.weight / total;
            if (rng() < Math.min(1, perMin / 60 * strideSec)) {
                out.push({ at, agentId: slot.agentId, pitchIndex: slot.pitchIndex, slot: slot.slot, verify: slot.verify, kind: 'accent' });
            }
        }
    });
    return out;
}

/**
 * Ghosts for one building over [fromMs, toMs): the building's single ghost
 * pitch on the present agents' thirds of the grid, with probability ghostP,
 * skipping the stride after an accent in the same third (and half the time
 * the stride before it). The liveness floor: the first ghost after a gap of
 * ½·livenessMs is `priority`, and a tick that would otherwise leave the
 * building silent past livenessMs always strikes (priority). `lastStrikeMs`
 * is the building's last kept strike; `accents` its planned accents.
 * Returns [{ at, agentId: null, kind: 'ghost', priority }].
 */
export function ghostPlan(building, rng, { fromMs, toMs, lastStrikeMs = -Infinity, accents = [] } = {}) {
    const out = [];
    if (!(building?.working > 0) || !(building.ghostP > 0)) return out;
    const gridMs = building.ghostGridMs;
    const stride = GRID_STRIDE * gridMs;
    const phases = new Set(building.slots.map(slot => slot.slot));
    const sorted = [...accents].sort((a, b) => a.at - b.at);
    let last = lastStrikeMs;
    let next = 0;
    gridTicks(gridMs, fromMs, toMs, (k, at) => {
        while (next < sorted.length && sorted[next].at <= at) last = Math.max(last, sorted[next++].at);
        const phase = phaseOf(k);
        if (!phases.has(phase)) return;
        // Strike now if waiting for the next present third would break the floor.
        let gap = 1;
        while (gap < GRID_STRIDE && !phases.has(phaseOf(k + gap))) gap++;
        const due = at - last + gap * gridMs > building.livenessMs;
        if (!due) {
            const own = a => phaseOf(Math.round(a.at / gridMs)) === phase;
            if (sorted.some(a => own(a) && at - a.at >= 0 && at - a.at <= stride)) return;
            if (sorted.some(a => own(a) && a.at - at === stride) && rng() < 0.5) return;
            if (rng() >= building.ghostP) return;
        }
        const priority = due || at - last >= building.livenessMs / 2;
        out.push({ at, agentId: null, kind: 'ghost', priority });
        last = at;
    });
    return out;
}

/**
 * Quota weather in the Mine (SIG-13, 5.7): a rumble in 80–160 Hz whose linear
 * level rises monotonically from 0 at a five-hour ratio of 0.7 to 1 at 1.0.
 * Stale or unknown usage is silent. Never a cue.
 */
export function quotaRumble(ratio, stale = false) {
    const value = Number(ratio);
    if (stale || ratio == null || !Number.isFinite(value)) return { level: 0, intensity: 0, band: QUOTA_BAND_HZ };
    const intensity = Math.min(1, Math.max(0, (value - QUOTA_RUMBLE_FROM) / (1 - QUOTA_RUMBLE_FROM)));
    return { level: intensity * intensity, intensity, band: QUOTA_BAND_HZ };
}
