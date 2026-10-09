import { AgentStatus } from '../../domain/value-objects/AgentStatus.js';
import { eventBus } from '../../domain/events/DomainEvent.js';
import {
    VERIFIED_OUTCOME_EVENT,
    VERIFIED_OUTCOME_KINDS,
} from './ChronicleEvents.js';

export const VERIFIED_CELEBRATION_MS = 5000;
export const AgentAction = Object.freeze({
    READ: 'read',
    WORK: 'work',
    THINK: 'think',
    TALK: 'talk',
    CELEBRATE: 'celebrate',
    SETTLED: 'settled',
});

// W8.7 — the travel gait vocabulary. A villager runs only on an urgent trip at
// the top speed rung: a WORKING body's real leg (never a filler errand) or a
// chat approach. A profile without an authored `run` strip always walks, so
// its body stays byte-identical to the walk cycle.
export const TravelGait = Object.freeze({
    WALK: 'walk',
    RUN: 'run',
});

export function resolveTravelGait({
    status = null,
    chatApproach = false,
    errand = false,
    topRung = false,
    departed = false,
    hasRunStrip = false,
} = {}) {
    if (!hasRunStrip || !topRung || departed) return TravelGait.WALK;
    if (chatApproach) return TravelGait.RUN;
    return status === AgentStatus.WORKING && !errand ? TravelGait.RUN : TravelGait.WALK;
}

const verifiedOutcomeKinds = new Set(VERIFIED_OUTCOME_KINDS);
const recentVerifiedOutcomes = new Map();
const RECENT_VERIFIED_OUTCOME_LIMIT = 256;

eventBus.on(VERIFIED_OUTCOME_EVENT, (outcome) => {
    if (!outcome?.agentId || !verifiedOutcomeKinds.has(outcome.kind)) return;
    recentVerifiedOutcomes.set(String(outcome.agentId), outcome);
    while (recentVerifiedOutcomes.size > RECENT_VERIFIED_OUTCOME_LIMIT) {
        recentVerifiedOutcomes.delete(recentVerifiedOutcomes.keys().next().value);
    }
});

function isDeparted(agent) {
    return agent?.isDeparted === true
        || (agent?.departedAt !== null
            && agent?.departedAt !== undefined
            && Number.isFinite(Number(agent.departedAt)));
}

// W7.10b — plan mode is the session's permission mode, read from the adapter
// record. Provider asymmetry: only Claude transcripts carry `'plan'`; Codex
// maps its approval policy to `bypassPermissions` or null, and OMP, Kimi and
// OpenCode report `bypassPermissions`, so their villagers never take the
// stance from this signal (an `EnterPlanMode` tool call still raises the
// per-sprite `behavior.planMode` glyph).
export function isPlanMode(agent) {
    return agent?.permissionMode === 'plan' && !isDeparted(agent);
}

function liveVerifiedOutcome(agent, outcome, now) {
    if (!outcome || isDeparted(agent) || !verifiedOutcomeKinds.has(outcome.kind)) return false;
    const agentIds = new Set([agent?.id, agent?.agentId].filter(Boolean).map(String));
    if (!outcome.agentId || !agentIds.has(String(outcome.agentId))) return false;
    const at = Number(outcome.at);
    return Number.isFinite(at) && at <= now && now - at < VERIFIED_CELEBRATION_MS;
}

export function resolveAgentAction(agent, {
    chatting = false,
    verifiedOutcome = undefined,
    now = Date.now(),
} = {}) {
    if (chatting || /sendmessage|send_message|message/i.test(String(agent?.currentTool || ''))) return AgentAction.TALK;
    const agentKey = String(agent?.id || agent?.agentId || '');
    if (isDeparted(agent)) {
        recentVerifiedOutcomes.delete(agentKey);
        return AgentAction.SETTLED;
    }
    const outcome = verifiedOutcome === undefined
        ? recentVerifiedOutcomes.get(agentKey)
        : verifiedOutcome;
    if (liveVerifiedOutcome(agent, outcome, Number(now))) return AgentAction.CELEBRATE;
    if (outcome && Number(now) - Number(outcome.at) >= VERIFIED_CELEBRATION_MS) {
        recentVerifiedOutcomes.delete(agentKey);
    }
    if (agent?.status === AgentStatus.COMPLETED) return null;
    const tool = String(agent?.currentTool || '').toLowerCase();
    if (/read|search|grep|glob|find|rg|sed/.test(tool)) return AgentAction.READ;
    if (/plan|think|reason|ask/.test(tool) || isPlanMode(agent) || agent?.status === AgentStatus.WAITING) return AgentAction.THINK;
    if (agent?.status === AgentStatus.WORKING || tool) return AgentAction.WORK;
    return null;
}
