import { normalizeStatus } from './Formatters.js';
import { statusWord } from './AgentPresentation.js';
// UI-1 — the operator label is the one status word (AgentPresentation).
export function operatorStatusLabel(status) {
    return statusWord(status);
}
export function attentionRank(agent, usage = null) {
    const rank = { waiting_on_user: 0, errored: 1, rate_limited: 2, waiting: 3, working: 5 }[normalizeStatus(agent?.status)] ?? 7;
    return rank * 1e12 - Number(usage?.totalTokens || usage?.tokens || 0);
}
export function sortAttentionAgents(agents, usageById = new Map()) {
    return [...(agents || [])].sort((a, b) => attentionRank(a, usageById.get(a.id)) - attentionRank(b, usageById.get(b.id)) || String(a.id).localeCompare(String(b.id)));
}
