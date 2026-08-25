export const WORKING_PHASES = Object.freeze([
    'reading',
    'editing',
    'testing',
    'researching',
    'coordinating',
    'git',
    'quota/resource',
    'waiting',
]);

export const AGENT_GOALS = Object.freeze([
    'complete-task',
    'assist-parent',
    'monitor-quota',
    'recover-error',
]);

export const WORK_ITINERARY_ROUTE = Object.freeze(['archive', 'forge', 'taskboard', 'harbor']);
export const WORK_ITINERARY_PHASE_INDEX = Object.freeze({
    reading: 0,
    editing: 1,
    testing: 2,
    git: 3,
});

export const INTENT_BUBBLE_WINDOW_MS = 20_000;

const INTENT_REASON_BUBBLES = Object.freeze({
    'validate-after-edit': ['Validating after edit', 'Checking the changes', 'Testing the new work'],
    'context-pressure': ['Context nearly full', 'Watching context room', 'Making context room'],
    'quota-throttle': ['Working within quota', 'Quota pace is limited', 'Conserving resources'],
    'resource-check': ['Checking resources', 'Watching token reserves', 'Reviewing quota room'],
    'cash-out': ['Counting token spend', 'Checking recent spend', 'Tallying token use'],
    'token-delta': ['Tracking token spend', 'Watching token use', 'Checking resource use'],
    push: ['Shipping the changes', 'Sending work upstream', 'Publishing the work'],
    pull: ['Bringing changes in', 'Syncing upstream work', 'Updating local work'],
    fetch: ['Checking upstream', 'Fetching remote changes', 'Refreshing git state'],
    commit: ['Recording the changes', 'Saving a checkpoint', 'Committing the work'],
    'failed-push-watch': ['Push needs attention', 'Checking the failed push', 'Recovering the push'],
    'join-parent': ['Joining parent agent', 'Helping the parent', 'Syncing with parent'],
    'follow-parent-work': ['Following parent work', 'Supporting the parent', 'Helping with the task'],
    'join-team': ['Joining the team', 'Syncing with the team', 'Coordinating the work'],
    'team-gather': ['Gathering with the team', 'Meeting at command', 'Aligning on the work'],
    'long-wait-watch': ['Waiting for guidance', 'Still awaiting input', 'Watching for a reply'],
    'long-work-shift': ['Staying on the task', 'Continuing the work', 'Working through the task'],
    'high-activity-watch': ['Watching village work', 'Monitoring busy work', 'Keeping watch'],
    'read-local': ['Reading the code', 'Tracing the code', 'Reviewing the source'],
    'search-local': ['Searching the code', 'Tracing references', 'Looking for the cause'],
    'find-local': ['Finding the right files', 'Mapping the codebase', 'Locating the source'],
    'web-search': ['Researching options', 'Looking for evidence', 'Checking the wider world'],
    'web-fetch': ['Reading remote sources', 'Checking a reference', 'Gathering evidence'],
    'edit-file': ['Making the change', 'Shaping the code', 'Editing the solution'],
    'write-file': ['Writing the solution', 'Building the change', 'Drafting the new work'],
    'patch-file': ['Applying the change', 'Patching the solution', 'Updating the code'],
});

const INTENT_PHASE_BUBBLES = Object.freeze({
    reading: ['Reviewing the code', 'Tracing current state', 'Gathering context'],
    editing: ['Making the change', 'Shaping the solution', 'Updating the code'],
    testing: ['Running the checks', 'Validating the change', 'Looking for regressions'],
    researching: ['Researching the path', 'Gathering evidence', 'Comparing approaches'],
    coordinating: ['Coordinating the work', 'Aligning the next step', 'Helping the team'],
    git: ['Preparing the handoff', 'Syncing the changes', 'Managing the revision'],
    'quota/resource': ['Watching resources', 'Managing token room', 'Checking quota headroom'],
    waiting: ['Waiting for guidance', 'Awaiting the next step', 'Watching for a reply'],
});

function bubbleHash(value) {
    let hash = 0x811c9dc5;
    for (const char of String(value || '')) {
        hash ^= char.charCodeAt(0);
        hash = Math.imul(hash, 0x01000193);
    }
    return hash >>> 0;
}

export function intentBubbleCandidates(intent) {
    if (!intent) return [];
    const reason = String(intent.reason || '').trim().toLowerCase();
    const phase = normalizeWorkingPhase(intent.phase || intent.workingPhase);
    return INTENT_REASON_BUBBLES[reason] || INTENT_PHASE_BUBBLES[phase] || [];
}

/**
 * Pick terse intent copy that is stable across frames but changes during a
 * long-held intent. Advancing by one candidate per window guarantees that
 * adjacent windows never repeat when a vocabulary has multiple lines.
 */
export function intentBubbleText(intent, { agentId = null, now = Date.now() } = {}) {
    const candidates = intentBubbleCandidates(intent);
    if (!candidates.length) return null;
    const timestamp = Number.isFinite(Number(now)) ? Number(now) : Date.now();
    const window = Math.floor(timestamp / INTENT_BUBBLE_WINDOW_MS);
    const seed = bubbleHash(`${agentId || intent.agentId || ''}|${intent.id || intent.reason || intent.phase || ''}`);
    return candidates[(seed + window) % candidates.length];
}

const WORKING_PHASE_SET = new Set(WORKING_PHASES);
const AGENT_GOAL_SET = new Set(AGENT_GOALS);

export function normalizeWorkingPhase(phase) {
    const value = String(phase || '').trim().toLowerCase();
    return WORKING_PHASE_SET.has(value) ? value : null;
}

export const normalizePhase = normalizeWorkingPhase;

export function normalizeGoal(goal) {
    const value = String(goal || '')
        .trim()
        .replace(/([a-z])([A-Z])/g, '$1-$2')
        .replace(/[_\s]+/g, '-')
        .toLowerCase();
    const aliases = {
        complete: 'complete-task',
        completetask: 'complete-task',
        task: 'complete-task',
        assist: 'assist-parent',
        assistparent: 'assist-parent',
        parent: 'assist-parent',
        monitor: 'monitor-quota',
        monitorquota: 'monitor-quota',
        quota: 'monitor-quota',
        recover: 'recover-error',
        recovererror: 'recover-error',
        error: 'recover-error',
    };
    const normalized = aliases[value] || value;
    return AGENT_GOAL_SET.has(normalized) ? normalized : null;
}

export function inferGoal({ source = null, reason = null, phase = null, building = null, parentId = null } = {}) {
    const sourceKey = String(source || '').toLowerCase();
    const reasonText = String(reason || '').toLowerCase();
    const buildingType = String(building || '').toLowerCase();
    if (sourceKey === 'subagent' || reasonText.includes('parent') || parentId) return 'assist-parent';
    if (
        sourceKey === 'quota'
        || sourceKey === 'token'
        || phase === 'quota/resource'
        || buildingType === 'mine'
        || /\b(quota|context|resource|token|throttle|rate.?limit)\b/.test(reasonText)
    ) {
        return 'monitor-quota';
    }
    if (/\b(fail(?:ed)?|error|errored|reject(?:ed)?|cancel(?:led|ed)?|recover|retry|blocked)\b/.test(reasonText)) {
        return 'recover-error';
    }
    if (sourceKey || phase || buildingType) return 'complete-task';
    return null;
}

export function normalizeRouteStop(stop) {
    const value = typeof stop === 'string'
        ? stop
        : (stop?.building || stop?.buildingType || stop?.type || stop?.id || '');
    return String(value || '').trim().toLowerCase() || null;
}

export function normalizeItineraryRoute(raw) {
    const route = Array.isArray(raw)
        ? raw
        : (Array.isArray(raw?.route)
            ? raw.route
            : (Array.isArray(raw?.stops) ? raw.stops : raw?.buildings));
    if (!Array.isArray(route)) return [];
    const result = [];
    for (const stop of route) {
        const normalized = normalizeRouteStop(stop);
        if (normalized && result[result.length - 1] !== normalized) result.push(normalized);
    }
    return result;
}

export function clampRouteIndex(index, route) {
    const numeric = Number(index);
    if (!Number.isFinite(numeric) || !route.length) return -1;
    return Math.max(0, Math.min(route.length - 1, Math.round(numeric)));
}

export function cloneItinerary(itinerary) {
    if (!itinerary) return null;
    return {
        ...itinerary,
        route: Array.isArray(itinerary.route) ? [...itinerary.route] : [],
    };
}
