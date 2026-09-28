import { eventBus } from '../../domain/events/DomainEvent.js';
import { bucketAgents, bucketCounts, bucketForStatus, compareByWaitAge } from '../../domain/services/SignalLedger.js';
import { toolCategory } from '../../domain/services/ToolIdentity.js';
import { AvatarCanvas } from './AvatarCanvas.js';
import {
    ObservedCallTapeStore,
    paintSessionStrip,
    paintTape,
    STRIP_HEIGHT,
    STRIP_WIDTH,
    TAPE_BUCKET_MS,
    TAPE_HEIGHT,
    TAPE_WIDTH,
} from './ObservedCallTape.js';
import { i18n } from '../../config/i18n.js';
import { sessionDetailsService } from '../shared/SessionDetailsService.js';
import { SESSION_DETAIL_REFRESH_INTERVAL } from '../../config/constants.js';
import { replaceChildren } from '../shared/DomSafe.js';
import { TokenUsage } from '../../domain/value-objects/TokenUsage.js';
import {
    collisionsForAgent,
    formatCost,
    formatElapsed,
    formatRelative,
    formatTokens,
    formatToolDetail,
    normalizeStatus,
    shortenHomePath,
    shortProjectName,
    subscribeElapsedText,
    truncateText,
    workingSetForAgent,
} from '../shared/Formatters.js';
import { AgentSelectionMirror, emitAgentDeselected, emitAgentSelected } from '../shared/AgentSelection.js';
import { operatorStatusLabel } from '../shared/SemanticTriage.js';
import { getTeamColor, shortTeamName } from '../shared/TeamColor.js';
import { attentionAgentIds, isKeyboardEditTarget, nextCardId, recoveryCardId } from './DashboardKeyboardNavigation.js';
import {
    pixelIcon,
    inspectableText,
    replaceDetailRows,
    detailFreshnessLabel,
    signalProvenance,
    buildingClassForAgent,
    buildingPresentation,
    currentToolPresentation,
    groupAgentsByProject,
    modelPresentation,
    projectProfile,
    providerPresentation,
    statusPresentation,
    waitReasonLabel,
    toolHistoryNodes,
    toolHistorySignature,
} from '../shared/AgentPresentation.js';

const DASHBOARD_TOOL_HISTORY_LIMIT = 12;
const PROMPT_DETAIL_MAX_LENGTH = 200;
const DASHBOARD_FILTER_EVENT = 'dashboard:filter-changed';
const DASHBOARD_FILTER_REQUEST_EVENT = 'dashboard:filter-requested';
const ROW_STATUS_FILTERS = Object.freeze([
    { key: 'needsYou', label: 'Needs you', shape: 'needs-you' },
    { key: 'errors', label: 'Errors', shape: 'errored' },
    { key: 'quota', label: 'Quota', shape: 'quota' },
    { key: 'working', label: 'Working', shape: 'working' },
    { key: 'watchlist', label: 'Waiting', shape: 'watchlist' },
    { key: 'quiet', label: 'Idle', shape: 'idle' },
]);
// 7.9 — buckets that leave their project list for the bell lane.
const BELL_BUCKETS = new Set(['needsYou', 'errors', 'quota']);
const BELL_STATUS_WORD = Object.freeze({
    waiting_on_user: 'NEEDS YOU',
    errored: 'ERROR',
    rate_limited: 'QUOTA',
});
// 9.5 — the frame kit's attn slice per lane status (frame-kit.css).
const CALL_FRAME_BY_STATUS = Object.freeze({
    waiting_on_user: 'cv-frame--attn',
    errored: 'cv-frame--attn-error',
    rate_limited: 'cv-frame--attn-limit',
});
const GAUGE_SEGMENTS = 12;
// 9.7a — one motion voice for every Dashboard FLIP: translate only, never
// scaled, so text and portraits stay pixel-true at both ends.
const FLIP_MS = 240;
const FLIP_TRANSITION = `transform ${FLIP_MS}ms cubic-bezier(0.2, 0, 0, 1)`;
// 9.10 — bell-lane age tiers on the clock's plate.
const AGE_RIM_MS = 60_000;
const AGE_FILL_MS = 5 * 60_000;
// 0.9 — the ultrawide multicol track (keep in step with dashboard.css).
const ULTRAWIDE_COLUMN = Object.freeze({ width: 1100, gap: 16 });
const ROW_STATUS_RANK = Object.freeze({
    waiting_on_user: 0,
    errored: 1,
    rate_limited: 2,
    working: 3,
    waiting: 4,
    idle: 5,
    completed: 6,
});
const TURN_STATE_LABELS = Object.freeze({
    tool_pending: 'Tool pending',
    awaiting_input: 'Awaiting input',
    working: 'Responding',
});

function safePromptDetail(agent, limit = PROMPT_DETAIL_MAX_LENGTH) {
    const source = agent?.promptDetail
        || (agent?.signalSource === 'hook' ? agent?.lastToolInput : '');
    const clean = String(source || '')
        .replace(/\b((?:[A-Za-z0-9_-]*?(?:key|token)))\s*=\s*(?:"[^"]*"|'[^']*'|[^\s&;,]+)/gi, '$1=[REDACTED]')
        .replace(/[A-Za-z0-9_-]{32,}/g, '[REDACTED]')
        .replace(/[\u0000-\u001f\u007f]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    if (clean.length <= limit) return clean;
    return `${clean.slice(0, limit - 1).trimEnd()}…`;
}

function rowWaitAnchor(agent) {
    return Number(agent?.awaitingSince
        || agent?.pendingSince
        || agent?.turnStartedAt
        || agent?.lastSessionActivity
        || 0) || 0;
}

function rowPhase(agent) {
    if (agent?.currentTool) return agent.currentTool;
    const status = normalizeStatus(agent?.status);
    if (status === 'idle' || status === 'completed') return statusPresentation(status, i18n).label;
    return TURN_STATE_LABELS[agent?.turnState]
        || operatorStatusLabel(status)
        || 'Unknown';
}

function cleanMessage(text, max = 140) {
    const clean = String(text || '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
    return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean;
}

function blockerText(agent, reason = waitReasonLabel(agent)) {
    const status = normalizeStatus(agent?.status);
    if (reason) return reason;
    if (status === 'waiting_on_user') return 'Waiting for input';
    if (status === 'errored') return cleanMessage(agent?.lastMessage, 90) || 'Session error';
    if (status === 'rate_limited') return cleanMessage(agent?.lastMessage, 90) || 'Quota limit';
    return '';
}

/**
 * 7.7 — the NOW column: the blocker for an exception, else the live tool
 * call, else the status word with the last observed message (labelled
 * `last:` so it never reads as current work).
 */
function rowNow(agent) {
    const status = normalizeStatus(agent?.status);
    if (BELL_STATUS_WORD[status]) {
        return { kind: 'blocker', lead: BELL_STATUS_WORD[status], detail: blockerText(agent) };
    }
    if (agent?.currentTool) {
        return {
            kind: 'tool',
            lead: agent.currentTool,
            // Drop the leading `key=` of the first argument: `npm run dev`,
            // not `command=npm run dev`. The raw input stays in the tooltip.
            detail: formatToolDetail(agent.currentToolInput || '', { max: 96, projectPath: agent.projectPath || '' })
                .replace(/^(?:command|cmd|file_path|path|url|pattern|query|description|prompt)=/, ''),
            title: agent.currentToolInput || '',
        };
    }
    const last = cleanMessage(agent?.lastMessage);
    return {
        kind: 'status',
        lead: rowPhase(agent),
        detail: last ? `· last: ${last}` : (status === 'waiting' ? '· no tool running' : ''),
        title: last ? `Last observed message: ${last}` : '',
    };
}

function formatClock(ms) {
    const total = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = String(total % 60).padStart(2, '0');
    return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}` : `${minutes}:${seconds}`;
}

function statusSinceMs(agent, now = Date.now()) {
    const since = Number(agent?.statusSince);
    return Number.isFinite(since) && since > 0 ? Math.max(0, now - since) : null;
}

function rowExceptionRank(agent) {
    const statusRank = ROW_STATUS_RANK[normalizeStatus(agent?.status)] ?? 7;
    if (statusRank <= 2) return statusRank;
    if (collisionsForAgent(agent).length) return 3;
    return statusRank + 1;
}

/** Dashboard health display precedence: error, blocked, quota, working, waiting, idle. */
export const SECTION_HEALTH_ORDER = Object.freeze([
    'errors',
    'needsYou',
    'quota',
    'working',
    'watchlist',
    'idle',
]);

const SECTION_HEALTH_PRESENTATION = Object.freeze({
    errors: Object.freeze({ className: 'errored', label: 'error' }),
    needsYou: Object.freeze({ className: 'needs-you', label: 'blocked' }),
    quota: Object.freeze({ className: 'quota', label: 'quota' }),
    working: Object.freeze({ className: 'working', label: 'working' }),
    watchlist: Object.freeze({ className: 'watchlist', label: 'waiting' }),
    idle: Object.freeze({ className: 'idle', label: 'idle' }),
});

/**
 * Project-header counts derived from the shared SignalLedger vocabulary.
 * `quiet` combines idle, completed, and unknown statuses for the compact
 * header readout and is presented as `idle`.
 */
export function sectionHealthCounts(agents) {
    const counts = bucketCounts(agents);
    return {
        errors: counts.errors,
        needsYou: counts.needsYou,
        quota: counts.quota,
        working: counts.working,
        watchlist: counts.watchlist,
        idle: counts.quiet,
    };
}

/** Stable display order with zero-count buckets omitted. */
export function nonZeroSectionHealthBuckets(counts) {
    return SECTION_HEALTH_ORDER.filter(bucket => Number(counts?.[bucket]) > 0);
}

/** The edge flash belongs only to a genuine errored status. */
export function shouldFlashForStatus(status) {
    return bucketForStatus(status) === 'errors';
}
const EXECUTION_TASK_DONE_STATUSES = new Set(['complete', 'completed', 'done', 'success', 'succeeded']);
const EXECUTION_CHILD_STATUSES = new Set([
    'active',
    'completed',
    'complete',
    'done',
    'errored',
    'idle',
    'rate_limited',
    'waiting',
    'waiting_on_user',
    'working',
]);
const EXECUTION_TASK_LIMIT = 12;

function executionStatus(value) {
    return String(value || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'unknown';
}

function executionChildId(child, index) {
    return String(child?.id ?? child?.sessionId ?? child?.agentId ?? `child-${index}`);
}

function executionTask(task, index) {
    if (!task || typeof task !== 'object') return null;
    const subject = String(task.subject || '')
        .replace(/[\u0000-\u001f\u007f]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/(^|[\s"'([{=])((?:\/|[A-Za-z]:[\\/])(?:[^\s"'`<>()[\]{};,]+))/g, '$1[path]');
    if (!subject) return null;
    return {
        kind: 'task',
        type: 'task',
        id: `task:${String(task.id || index)}`,
        subject: subject.length > 120 ? `${subject.slice(0, 119).trimEnd()}…` : subject,
        status: executionStatus(task.status),
        owner: String(task.owner || task.assignee || '').trim(),
    };
}

function executionChildIsDone(child) {
    return !child?.isDeparted && EXECUTION_TASK_DONE_STATUSES.has(executionStatus(child?.status));
}

function executionChildIsUnknown(child) {
    return child?.isDeparted === true
        || !EXECUTION_CHILD_STATUSES.has(executionStatus(child?.status));
}

/**
 * Progress is exact only when a Claude task-store projection supplied it.
 * Otherwise count observed children, retaining prior IDs as unknown when a
 * child disappears. A departed child is not a completed child.
 */
export function deriveChildProgress(agent, children = [], { previousChildIds = [] } = {}) {
    const provider = String(agent?.provider || 'claude').toLowerCase();
    const supplied = agent?.taskProgress;
    const suppliedDone = Number(supplied?.done);
    const suppliedTotal = Number(supplied?.total);
    const hasExact = provider === 'claude'
        && supplied?.source === 'exact'
        && Number.isFinite(suppliedDone)
        && Number.isFinite(suppliedTotal)
        && suppliedDone >= 0
        && suppliedTotal >= suppliedDone
        && (suppliedTotal > 0 || !Array.isArray(children) || children.length === 0);
    if (hasExact) {
        return {
            done: Math.trunc(suppliedDone),
            total: Math.trunc(suppliedTotal),
            source: 'exact',
        };
    }

    const current = Array.isArray(children) ? children : [];
    const currentIds = new Set(current.map(executionChildId));
    const previousIds = new Set(
        (Array.isArray(previousChildIds) ? previousChildIds : [])
            .map(id => String(id || '').trim())
            .filter(Boolean),
    );
    const disappeared = [...previousIds].filter(id => !currentIds.has(id)).length;
    const hintedTotal = provider === 'claude' && supplied?.source === 'inferred'
        ? Math.max(0, Math.trunc(Number(supplied.total) || 0))
        : 0;
    const total = Math.max(current.length, currentIds.size + disappeared, hintedTotal);
    const done = Math.min(total, current.filter(executionChildIsDone).length);
    return {
        done,
        total,
        source: 'inferred',
        unknown: disappeared + current.filter(executionChildIsUnknown).length,
    };
}

function executionNodeAgent(child) {
    const id = String(child?.id ?? child?.sessionId ?? child?.agentId ?? '');
    return {
        kind: 'subagent',
        type: 'subagent',
        id,
        label: String(child?.name || child?.agentName || child?.agentId || id || 'Subagent'),
        agentType: String(child?.agentType || 'sub-agent'),
        subagentKind: child?.subagentKind || null,
        status: child?.isDeparted ? 'unknown' : executionStatus(child?.status),
        departed: child?.isDeparted === true,
        children: [],
    };
}

function executionOwnerMatches(node, owner) {
    if (!owner) return false;
    if (node.kind === 'subagent') {
        return [node.id, node.label, node.agentType, node.subagentKind]
            .filter(Boolean)
            .some(value => String(value) === owner);
    }
    return node.children.some(child => executionOwnerMatches(child, owner));
}

/**
 * Build the UI-safe hierarchy from the session fields already on Agent.
 * Claude gets subagent/workflow/task nodes; other providers intentionally
 * receive a counts-only shape.
 */
export function buildExecutionTree(agent, agents = [], options = {}) {
    const provider = String(agent?.provider || 'claude').toLowerCase();
    const rootId = String(agent?.id ?? agent?.sessionId ?? '');
    const children = (Array.isArray(agents) ? agents : []).filter((candidate) => (
        candidate
        && String(candidate.parentSessionId || '') === rootId
        && (candidate.isSubagent === true
            || Boolean(candidate.parentSessionId)
            || (candidate.agentType && candidate.agentType !== 'main'))
    ));
    const progress = deriveChildProgress(agent, children, options);
    if (provider !== 'claude') {
        return {
            kind: 'counts',
            type: 'counts',
            id: rootId,
            provider,
            progress,
            children: [],
            hasChildren: children.length > 0,
        };
    }

    const workflows = new Map();
    const nodes = [];
    for (const child of children) {
        const workflowKey = child.workflowId
            || (child.agentType === 'workflow-subagent'
                ? child.workflowName || child.subagentKind || 'workflow'
                : null);
        if (!workflowKey) {
            nodes.push(executionNodeAgent(child));
            continue;
        }
        const key = String(workflowKey);
        let workflow = workflows.get(key);
        if (!workflow) {
            workflow = {
                kind: 'workflow',
                type: 'workflow',
                id: `workflow:${key}`,
                label: String(child.workflowName || child.subagentKind || child.workflowId || 'Workflow'),
                children: [],
            };
            workflows.set(key, workflow);
            nodes.push(workflow);
        }
        workflow.children.push(executionNodeAgent(child));
    }

    const taskNodes = (Array.isArray(agent?.tasks) ? agent.tasks : [])
        .slice(0, EXECUTION_TASK_LIMIT)
        .map(executionTask)
        .filter(Boolean);
    for (const task of taskNodes) {
        const owner = task.owner;
        const ownerNode = nodes.find(node => executionOwnerMatches(node, owner));
        if (ownerNode) {
            const target = ownerNode.kind === 'workflow'
                ? ownerNode.children.find(child => executionOwnerMatches(child, owner)) || ownerNode
                : ownerNode;
            target.children.push(task);
        } else {
            nodes.push(task);
        }
        delete task.owner;
    }

    return {
        kind: 'session',
        type: 'session',
        id: rootId,
        provider,
        label: String(agent?.name || agent?.agentName || rootId || 'Session'),
        progress,
        children: nodes,
        hasChildren: nodes.length > 0,
    };
}


function healthCounterText(bucket, count) {
    const label = SECTION_HEALTH_PRESENTATION[bucket].label;
    return `${count} ${bucket === 'errors' && count !== 1 ? `${label}s` : label}`;
}

function healthDescription(bucket, count) {
    const agentNoun = count === 1 ? 'agent' : 'agents';
    const descriptions = {
        errors: `${count} errored ${agentNoun}`,
        needsYou: `${count} blocked ${agentNoun} waiting for your input`,
        quota: `${count} rate-limited ${agentNoun}`,
        working: `${count} working ${agentNoun}`,
        watchlist: `${count} waiting ${agentNoun} on the watchlist`,
        idle: `${count} idle or completed ${agentNoun}`,
    };
    return descriptions[bucket];
}

function hasOpenSurface(documentRef = globalThis.document) {
    const modal = documentRef?.getElementById?.('modalOverlay');
    if (modal?.getAttribute?.('aria-hidden') === 'false') return true;

    for (const id of ['soundPanel', 'spendBreakdownPanel']) {
        const panel = documentRef?.getElementById?.(id);
        if (panel && !panel.hidden && panel.style?.display !== 'none') return true;
    }

    const popovers = documentRef?.querySelectorAll?.('[popover]') || [];
    return [...popovers].some(popover => {
        if (typeof popover.matches === 'function') {
            try {
                return popover.matches(':popover-open') === true;
            } catch {
                // Older engines do not know :popover-open; use the fallback
                // state below for test doubles and older native implementations.
            }
        }
        return popover.hasAttribute?.('open') === true || popover.open === true;
    });
}

export class DashboardRenderer {
    constructor(world, { toast = null } = {}) {
        this.world = world;
        this.toast = toast;
        this.gridEl = document.getElementById('dashboardGrid');
        this.attentionEl = document.getElementById('dashboardAttentionQueue');
        this.emptyEl = document.getElementById('dashboardEmpty');
        this._appendEmptyHints();
        this.cards = new Map();
        this.toolHistories = new Map();
        this.usageFooters = new Map();
        this.toolHistoryRenderSignatures = new Map();
        this._cardRenderSignatures = new Map();
        this._executionChildIdsByParent = new Map();
        this._selectedAgentId = null;
        this._focusedAgentId = null;
        this._attentionCursor = 0;
        this._statusFilters = new Set();
        this._providerFilters = new Set();
        this._searchQuery = '';
        this._searchMatches = null;
        this._searchContexts = new Map();
        this._stableAgentOrder = new Map();
        this._stableProjectOrder = new Map();
        this._nextStableAgentOrder = 0;
        this._nextStableProjectOrder = 0;
        this._controlsSignature = '';
        this._filteredEmptyEl = null;
        this.active = false;
        this._destroyed = false;
        this._isFetchingDetails = false;
        this._detailFetchGeneration = 0;
        this._sectionEls = new Map(); // projectPath → section element
        this._pendingAvatarDraws = new Set();
        this._avatarDrawFrame = null;
        this._flipTimers = new Set();
        // 7.12 — observation starts when the Dashboard module loads; every
        // earlier bucket paints as a dotted baseline. Fed in every mode, O(1)
        // per update.
        this._tapes = new ObservedCallTapeStore();
        for (const agent of world?.agents?.values?.() || []) this._tapes.observe(agent);
        this._tapeTimer = null;
        this._bellEl = null;
        this._motionQuery = typeof window !== 'undefined'
            ? window.matchMedia?.('(prefers-reduced-motion: reduce)')
            : null;
        // 0.9 / 9.9 — the ultrawide column layout and its roomy row tier.
        this._ultrawideQuery = typeof window !== 'undefined'
            ? window.matchMedia?.('(min-width: 2400px)')
            : null;
        this._roomy = false;
        this.selection = new AgentSelectionMirror({
            notifyOnRepeat: true,
            onChange: (nextId, previousId) => {
                this._selectedAgentId = nextId;
                this._syncSelectionControls(nextId, previousId);
                if (this.active) void this._fetchAllDetails();
            },
        });

        this._onAgentAdded = (agent) => {
            this._tapes?.observe(agent);
            if (this.active) this.render();
        };
        this._onAgentUpdated = (agent) => {
            this._tapes?.observe(agent);
            if (this.active) {
                this._renderAgentUpdate(agent);
                const parentId = String(agent?.parentSessionId || '');
                const parent = parentId ? this.world.agents.get(parentId) : null;
                const parentCard = parentId ? this.cards.get(parentId) : null;
                if (parent && parentCard) this._updateChildProgress(parentCard, parent);
                this._renderAttentionQueue(Array.from(this.world.agents.values()));
                this._syncAnswerFirst();
            }
        };
        this._onAgentRemoved = (agent) => {
            this._executionChildIdsByParent.delete(String(agent.id));
            this._tapes?.forget(agent.id);
            sessionDetailsService.deleteForAgent(agent);
            if (this.active) this.render();
        };
        this._onModeChanged = (mode) => {
            this.active = mode === 'dashboard';
            if (this.active) {
                this.render();
                this._startDetailFetching();
                this._startTapeClock();
            } else {
                this._stopDetailFetching();
                this._stopTapeClock();
            }
        };
        // Pause detail polling while the tab is hidden; refresh once on return.
        this._onVisibilityChange = () => {
            if (document.hidden || !this.active) return;
            this._fetchAllDetails();
        };
        this._onDashboardKeyDown = (event) => this._handleDashboardKeyboardCommand(event);
        this._onDashboardFocusIn = (event) => {
            const select = event.target?.closest?.('.dash-card__select');
            const card = select?.closest?.('.dash-card');
            if (!card?.dataset?.agentId) return;
            this._focusedAgentId = card.dataset.agentId;
            this._syncCardTabStops();
        };
        this._onSharedFilterChanged = (payload = {}) => {
            this._searchQuery = String(payload.query || '').trim().toLowerCase();
            const matches = Array.isArray(payload.matches) ? payload.matches : [];
            this._searchMatches = this._searchQuery
                ? new Set(matches.map(match => String(match.agentId)))
                : null;
            this._searchContexts = new Map(matches
                .filter(match => match?.context)
                .map(match => [String(match.agentId), String(match.context)]));
            if (this.active) this.render();
        };
        eventBus.on('agent:added', this._onAgentAdded);
        eventBus.on('agent:updated', this._onAgentUpdated);
        eventBus.on('agent:removed', this._onAgentRemoved);
        eventBus.on('mode:changed', this._onModeChanged);
        eventBus.on(DASHBOARD_FILTER_EVENT, this._onSharedFilterChanged);
        document.addEventListener('visibilitychange', this._onVisibilityChange);
        // The view's own box (window resize, sidebar collapse), never the
        // grid's, so toggling the roomy tier cannot re-trigger it.
        this._viewObserver = typeof ResizeObserver === 'function' && this.gridEl?.parentElement
            ? new ResizeObserver(() => this._syncUltrawide())
            : null;
        this._viewObserver?.observe(this.gridEl.parentElement);
        window.addEventListener('keydown', this._onDashboardKeyDown);
        this.gridEl?.addEventListener('focusin', this._onDashboardFocusIn);
        eventBus.emit(DASHBOARD_FILTER_REQUEST_EVENT);
    }

    render() {
        const agents = Array.from(this.world.agents.values());
        this._rememberStableOrder(agents);
        this._renderAttentionQueue(agents);

        if (agents.length === 0) {
            this._detailFetchGeneration++;
            this._clearAllCardsAndSections();
            this.gridEl.style.display = 'none';
            this.emptyEl.classList.add('dashboard__empty--visible');
            sessionDetailsService.sweep([]);
            return;
        }

        this.gridEl.style.display = '';
        this.emptyEl.classList.remove('dashboard__empty--visible');
        const visibleAgents = this._filteredAgents(agents);
        this._setFilteredEmpty(visibleAgents.length === 0);

        // 7.9 — needs-you, error and quota agents leave their project list
        // for the bell lane; each project header keeps an honest `+N` count.
        const laneAgents = this._sortAgentsExceptionFirst(
            visibleAgents.filter(agent => BELL_BUCKETS.has(bucketForStatus(agent.status))),
        );
        const laneIds = new Set(laneAgents.map(agent => agent.id));
        const laneByProject = new Map();
        for (const agent of laneAgents) {
            const project = agent.projectPath || '_unknown';
            if (!laneByProject.has(project)) laneByProject.set(project, []);
            laneByProject.get(project).push(agent);
        }

        const groups = [...groupAgentsByProject(visibleAgents.filter(agent => !laneIds.has(agent.id)))];
        this._sortProjectGroups(groups);
        // 9.7a — measured before any card or section moves.
        const flip = this._beginLaneFlip(laneIds);

        const existingIds = new Set();
        const existingSections = new Set();

        const bellEl = this._ensureBellLane();
        const laneCards = [];
        for (const agent of laneAgents) {
            existingIds.add(agent.id);
            const cardEl = this._cardFor(agent);
            if (cardEl.parentElement !== bellEl) bellEl.appendChild(cardEl);
            laneCards.push(cardEl);
            this._updateCard(cardEl, agent);
        }
        this._placeCardsInOrder(bellEl, laneCards, { animate: !flip });
        bellEl.hidden = laneCards.length === 0;

        // Sections move only when their order changed: re-appending a node
        // detaches it, which cancels every FLIP running inside it.
        const orderedSections = groups.map(([projectPath]) => {
            let sectionEl = this._sectionEls.get(projectPath);
            if (!sectionEl) {
                sectionEl = this._createSection(projectPath);
                this._sectionEls.set(projectPath, sectionEl);
            }
            return sectionEl;
        });
        const placedSections = [...this.gridEl.children].filter(el => el.classList.contains('dashboard__section'));
        if (orderedSections.some((sectionEl, index) => placedSections[index] !== sectionEl)) {
            for (const sectionEl of orderedSections) this.gridEl.appendChild(sectionEl);
        }

        for (const [index, [projectPath, groupAgents]] of groups.entries()) {
            existingSections.add(projectPath);
            this._sortAgentsExceptionFirst(groupAgents);
            const sectionEl = orderedSections[index];
            this._updateSectionHeader(sectionEl, projectPath, groupAgents, laneByProject.get(projectPath) || []);

            const gridInner = sectionEl._sectionRefs?.grid || sectionEl.querySelector('.dashboard__section-grid');

            const orderedCards = [];
            for (const agent of groupAgents) {
                existingIds.add(agent.id);
                const cardEl = this._cardFor(agent);

                // Move the card if it is not in this section
                if (cardEl.parentElement !== gridInner) {
                    gridInner.appendChild(cardEl);
                }
                orderedCards.push(cardEl);

                this._updateCard(cardEl, agent);
            }

            // 4.3 — keep DOM order in sync with the status sort, FLIP-animated.
            this._placeCardsInOrder(gridInner, orderedCards, { animate: !flip });
        }

        // Remove missing agent cards
        for (const [id, cardEl] of this.cards) {
            if (!existingIds.has(id)) {
                this._removeCard(id, { removeEmptySection: false });
            }
        }

        // Remove missing sections
        for (const [path, sectionEl] of this._sectionEls) {
            if (!existingSections.has(path)) {
                if (sectionEl._erroredFlashTimer) clearTimeout(sectionEl._erroredFlashTimer);
                sectionEl.remove();
                this._sectionEls.delete(path);
            }
        }
        this._syncUltrawide();
        this._finishLaneFlip(flip);
        this._syncAnswerFirst();
        sessionDetailsService.sweep(agents);
        this._syncCardTabStops();
    }

    _cardFor(agent) {
        let cardEl = this.cards.get(agent.id);
        if (!cardEl) {
            cardEl = this._createCard(agent);
            this.cards.set(agent.id, cardEl);
        }
        return cardEl;
    }

    _ensureBellLane() {
        if (!this._bellEl) {
            this._bellEl = document.createElement('div');
            this._bellEl.className = 'dashboard__bell';
            this._bellEl.setAttribute('role', 'group');
            this._bellEl.setAttribute('aria-label', 'Needs you: agents waiting on you, errored or rate-limited');
        }
        if (this.gridEl && this.gridEl.firstChild !== this._bellEl) this.gridEl.prepend(this._bellEl);
        return this._bellEl;
    }

    // 7.12 — repaint tapes on 15 s bucket boundaries while the Dashboard is
    // visible; no rAF loop, and each tape repaints only if its key changed.
    _startTapeClock() {
        this._stopTapeClock();
        const tick = () => {
            this._tapeTimer = setTimeout(tick, TAPE_BUCKET_MS - (Date.now() % TAPE_BUCKET_MS) + 20);
            for (const card of this.cards.values()) this._paintCardTape(card);
        };
        this._tapeTimer = setTimeout(tick, TAPE_BUCKET_MS - (Date.now() % TAPE_BUCKET_MS) + 20);
    }

    _stopTapeClock() {
        if (this._tapeTimer) {
            clearTimeout(this._tapeTimer);
            this._tapeTimer = null;
        }
    }

    _paintCardTape(cardEl, now = Date.now()) {
        const canvas = cardEl?._elements?.tapeCanvas;
        const id = cardEl?.dataset?.agentId;
        if (!canvas || !id || !this._tapes) return;
        const signature = this._tapes.signature(id, now);
        if (canvas._tapeSignature !== signature) {
            canvas._tapeSignature = signature;
            paintTape(canvas, this._tapes.cells(id, now));
        }
        if (this.selection?.isSelected(id)) this._paintStrip(cardEl, id, now);
    }

    // 9.11 — the selected row's session strip: built the first time the row
    // is selected (never for every row), repainted on the tape clock, on a
    // tape change and when a transcript fetch lands.
    _paintStrip(cardEl, id, now = Date.now()) {
        const refs = cardEl?._elements;
        if (!refs?.strip || !this._tapes) return;
        if (!refs.stripCanvas) {
            const canvas = document.createElement('canvas');
            canvas.width = STRIP_WIDTH;
            canvas.height = STRIP_HEIGHT;
            canvas.className = 'dash-card__strip-canvas';
            canvas.setAttribute('aria-hidden', 'true');
            refs.strip.insertBefore(canvas, refs.stripAxis);
            refs.stripCanvas = canvas;
            refs.strip.hidden = false;
        }
        const history = this.toolHistories.get(id) || null;
        const signature = [
            this._tapes.signature(id, now),
            history ? toolHistorySignature(history, { limit: history.length, detailLength: 0 }) : 'pending',
        ].join('|');
        if (refs.stripCanvas._stripSignature === signature) return;
        refs.stripCanvas._stripSignature = signature;
        const { drawn, coveredFrom } = paintSessionStrip(refs.stripCanvas, this._tapes.cells(id, now), history || [], now);
        // The fetch returns a contiguous tail of the transcript: the count is
        // exact only when that tail reaches back past the 10-minute window.
        let count = 'loading';
        if (history && coveredFrom === null) count = 'no calls fetched';
        else if (history) count = coveredFrom === 0 ? `${drawn} in 10 min` : `last ${drawn} fetched`;
        this._setText(refs.stripCount, count);
        refs.strip.title = 'Ticks: tool calls from the fetched transcript at their own times; the rail marks the span it covers. Blocks: calls this tab observed, 15 s per column.';
    }

    // 9.7a — when bell-lane membership changes, the card that crosses between
    // its row and the lane, the cards around it and the sections below travel
    // to their new places on one curve. Rects are read only on a membership
    // change; reduced motion or an inactive Dashboard cuts.
    _beginLaneFlip(nextLaneIds) {
        const bell = this._bellEl;
        if (!bell || !this.active || this._destroyed || this._motionQuery?.matches) return null;
        const current = [...bell.children].map(card => card.dataset.agentId);
        const next = new Set([...nextLaneIds].map(String));
        if (current.length === next.size && current.every(id => next.has(id))) return null;
        const first = new Map();
        for (const section of this._sectionEls.values()) {
            if (section.isConnected) first.set(section, { rect: section.getBoundingClientRect(), inLane: false });
        }
        for (const card of this.cards.values()) {
            if (card.isConnected) first.set(card, { rect: card.getBoundingClientRect(), inLane: card.parentElement === bell });
        }
        return first;
    }

    _finishLaneFlip(first) {
        if (!first) return;
        const bell = this._bellEl;
        // Measure layout positions: an interrupted flight restarts from where
        // it was drawn (its first rect), not from its old offset.
        const stopped = [];
        for (const el of first.keys()) {
            if (!el.style.transform) continue;
            this._stopFlip(el);
            stopped.push(el);
        }
        const deltas = new Map();
        for (const [el, before] of first) {
            if (!el.isConnected) continue;
            const after = el.getBoundingClientRect();
            deltas.set(el, [Math.round(before.rect.left - after.left), Math.round(before.rect.top - after.top)]);
        }
        const moved = [];
        for (const [el, [dx, dy]] of deltas) {
            // A row rides inside its section: subtract the section's own offset
            // so the two translations compose to the row's true path.
            const section = el.classList.contains('dash-card') ? el.closest('.dashboard__section') : null;
            const [sx, sy] = (section && deltas.get(section)) || [0, 0];
            const x = dx - sx;
            const y = dy - sy;
            if (!x && !y) continue;
            el.style.transition = 'none';
            el.style.transform = `translate(${x}px, ${y}px)`;
            moved.push([el, first.get(el).inLane !== (el.parentElement === bell)]);
        }
        for (const el of stopped) {
            if (!el.style.transform) el.style.transition = '';
        }
        if (!moved.length) return;
        void this.gridEl.offsetWidth; // one reflow so the inverted offsets apply
        for (const [el, crossed] of moved) this._playFlip(el, crossed);
    }

    _stopFlip(el) {
        if (el._flipTimer) {
            clearTimeout(el._flipTimer);
            this._flipTimers.delete(el._flipTimer);
            el._flipTimer = null;
        }
        el.style.transition = 'none';
        el.style.transform = '';
        el.classList.remove('dash-card--flying');
    }

    _playFlip(el, crossed = false) {
        if (el._flipTimer) {
            clearTimeout(el._flipTimer);
            this._flipTimers.delete(el._flipTimer);
        }
        el.classList.toggle('dash-card--flying', crossed);
        el.style.transition = FLIP_TRANSITION;
        el.style.transform = '';
        const timer = setTimeout(() => {
            this._flipTimers.delete(timer);
            el._flipTimer = null;
            el.style.transition = '';
            el.classList.remove('dash-card--flying');
        }, FLIP_MS + 40);
        el._flipTimer = timer;
        this._flipTimers.add(timer);
    }

    // M18 — `ANSWER FIRST` under the clock of the lane card that `A` focuses
    // first (the longest-waiting, the order AttentionService uses), shown only
    // while the lane holds more than one card.
    _syncAnswerFirst() {
        const cards = this._bellEl ? [...this._bellEl.children] : [];
        let firstId = null;
        if (cards.length > 1) {
            const agents = cards.map(card => this.world.agents.get(card.dataset.agentId)).filter(Boolean);
            firstId = agents.sort(compareByWaitAge)[0]?.id ?? null;
        }
        for (const card of cards) {
            const caption = card._elements?.call?.first;
            if (caption) caption.hidden = firstId === null || String(card.dataset.agentId) !== String(firstId);
        }
    }

    // 0.9 / 9.9 — ultrawide layout state that CSS alone cannot derive.
    // - The bell lane lays its cards two to a project column, so their edges
    //   meet the columns below (multicol's own count:
    //   floor((W + gap) / (width + gap))). A lane that wraps balances its
    //   rows instead (9 cards on 8 slots: 5 + 4, never 8 + an orphan).
    // - With room to spare, rows grow to a 64 px face. Enter while the compact
    //   content fills < 60 % of the view; a row grows at most 67 / 47 px
    //   (1.43x) and nothing else grows, so the roomy content stays under 86 %
    //   and only a later change can push it past 88 %, which leaves.
    _syncUltrawide() {
        const view = this.gridEl?.parentElement;
        if (!view || !this.active) return;
        const ultrawide = Boolean(this._ultrawideQuery?.matches) && this.gridEl.style.display !== 'none';
        const columns = ultrawide
            ? Math.floor((this.gridEl.clientWidth + ULTRAWIDE_COLUMN.gap) / (ULTRAWIDE_COLUMN.width + ULTRAWIDE_COLUMN.gap))
            : 0;
        const laneSlots = columns * 2;
        const laneCards = this._bellEl?.children.length || 0;
        const laneColumns = columns >= 2
            ? String(laneCards > laneSlots ? Math.ceil(laneCards / Math.ceil(laneCards / laneSlots)) : laneSlots)
            : '';
        this._setCustomProperty(this.gridEl, '--dash-lane-cols', laneColumns);
        this.gridEl.classList.toggle('dashboard__grid--lanes', Boolean(laneColumns));
        let roomy = false;
        if (ultrawide && this.cards.size) {
            const content = this.gridEl.getBoundingClientRect().bottom - view.getBoundingClientRect().top + view.scrollTop;
            roomy = content < view.clientHeight * (this._roomy ? 0.88 : 0.6);
        }
        if (roomy === this._roomy) return;
        this._roomy = roomy;
        this.gridEl.classList.toggle('dashboard__grid--roomy', roomy);
        for (const card of this.cards.values()) card._avatarCanvas?.resize(roomy ? 'nicheRoomy' : 'niche');
    }

    _rememberStableOrder(agents) {
        const liveIds = new Set();
        const liveProjects = new Set();
        for (const agent of agents) {
            liveIds.add(String(agent.id));
            const project = agent.projectPath || '_unknown';
            liveProjects.add(project);
            if (!this._stableAgentOrder.has(String(agent.id))) {
                this._stableAgentOrder.set(String(agent.id), this._nextStableAgentOrder++);
            }
            if (!this._stableProjectOrder.has(project)) {
                this._stableProjectOrder.set(project, this._nextStableProjectOrder++);
            }
        }
        for (const id of this._stableAgentOrder.keys()) {
            if (!liveIds.has(id)) this._stableAgentOrder.delete(id);
        }
        for (const project of this._stableProjectOrder.keys()) {
            if (!liveProjects.has(project)) this._stableProjectOrder.delete(project);
        }
    }

    _filteredAgents(agents) {
        return agents.filter(agent => {
            if (this._searchMatches && !this._searchMatches.has(String(agent.id))) return false;
            if (this._statusFilters.size) {
                const bucket = bucketForStatus(agent.status);
                if (!this._statusFilters.has(bucket)) return false;
            }
            if (this._providerFilters.size
                && !this._providerFilters.has(String(agent.provider || 'claude').toLowerCase())) return false;
            return true;
        });
    }

    _sortAgentsExceptionFirst(agents) {
        agents.sort((a, b) => {
            const rankDelta = rowExceptionRank(a) - rowExceptionRank(b);
            if (rankDelta) return rankDelta;
            const waitDelta = rowWaitAnchor(a) - rowWaitAnchor(b);
            if (waitDelta) return waitDelta;
            return (this._stableAgentOrder.get(String(a.id)) ?? 0)
                - (this._stableAgentOrder.get(String(b.id)) ?? 0);
        });
        return agents;
    }

    _sortProjectGroups(groups) {
        const projectRank = ([, agents]) => Math.min(
            ...agents.map(rowExceptionRank),
        );
        const projectWait = ([, agents]) => Math.min(
            ...agents.map(rowWaitAnchor).filter(Boolean),
            Number.MAX_SAFE_INTEGER,
        );
        groups.sort((a, b) => projectRank(a) - projectRank(b)
            || projectWait(a) - projectWait(b)
            || (this._stableProjectOrder.get(a[0]) ?? 0) - (this._stableProjectOrder.get(b[0]) ?? 0));
    }

    _setFilteredEmpty(visible) {
        if (!this.gridEl) return;
        if (!this._filteredEmptyEl) {
            this._filteredEmptyEl = document.createElement('div');
            this._filteredEmptyEl.className = 'dashboard__filtered-empty';
            this._filteredEmptyEl.textContent = 'No agents match the active filters';
            this.gridEl.appendChild(this._filteredEmptyEl);
        }
        this._filteredEmptyEl.hidden = !visible;
    }

    _renderAgentUpdate(agent) {
        const cardEl = this.cards.get(agent.id);
        const projectPath = agent.projectPath || '_unknown';
        const status = normalizeStatus(agent.status);
        if (!cardEl || cardEl._projectPath !== projectPath || cardEl._status !== status) {
            this.render();
            return;
        }
        this._updateCard(cardEl, agent);
    }

    // 4.3 — FLIP: keep each section's cards in status-sort order. When the
    // order actually changed (a status transition re-sorted the section),
    // cards that existed before the move glide to their new slots; newly
    // created cards have no "first" rect and simply appear. Reduced motion
    // (or an inactive dashboard) skips the animation — the reorder is an
    // instant cut. Rects are read only when an order change is detected.
    _placeCardsInOrder(gridEl, orderedCards, { animate = true } = {}) {
        if (!gridEl || orderedCards.length < 2) return;
        const cardSet = new Set(orderedCards);
        let index = 0;
        let orderChanged = false;
        for (const child of gridEl.children) {
            if (!cardSet.has(child)) continue;
            if (child !== orderedCards[index]) { orderChanged = true; break; }
            index++;
        }
        if (!orderChanged && index === orderedCards.length) return;

        const canAnimate = animate && this.active && !this._destroyed && !(this._motionQuery?.matches);
        const firstRects = new Map();
        if (canAnimate) {
            for (const card of orderedCards) {
                if (card.parentElement === gridEl) firstRects.set(card, card.getBoundingClientRect());
            }
        }

        for (const card of orderedCards) gridEl.appendChild(card);
        if (!canAnimate || firstRects.size === 0) return;

        for (const card of firstRects.keys()) {
            if (card.style.transform) this._stopFlip(card);
        }
        const moved = [];
        for (const [card, first] of firstRects) {
            const last = card.getBoundingClientRect();
            const dx = Math.round(first.left - last.left);
            const dy = Math.round(first.top - last.top);
            if (!dx && !dy) {
                card.style.transition = '';
                continue;
            }
            card.style.transition = 'none';
            card.style.transform = `translate(${dx}px, ${dy}px)`;
            moved.push(card);
        }
        if (moved.length === 0) return;

        void gridEl.offsetWidth; // single reflow so the inverted offsets apply
        for (const card of moved) this._playFlip(card);
    }

    _createSection(projectPath) {
        const section = document.createElement('div');
        section.className = 'dashboard__section';
        section.dataset.project = projectPath;

        section.innerHTML = `
            <div class="dashboard__section-header">
                <span class="dashboard__pennant" aria-hidden="true"></span>
                <span class="dashboard__section-name"></span>
                <span class="dashboard__section-path"></span>
                <span class="dashboard__section-health" aria-label="Project health"></span>
                <span class="dashboard__section-lift" hidden></span>
                <span class="dashboard__section-count"></span>
            </div>
            <div class="dashboard__section-healthbar" aria-hidden="true">
                ${SECTION_HEALTH_ORDER.map(bucket => {
                    const className = SECTION_HEALTH_PRESENTATION[bucket].className;
                    return `<span class="dashboard__healthbar-seg dashboard__healthbar-seg--${className}" style="display: none"></span>`;
                }).join('')}
            </div>
            <div class="dashboard__cols" aria-hidden="true">
                <span></span>
                <span>AGENT</span>
                <span>NOW</span>
                <span title="Tool calls this tab observed, one column per 15 s: a block per call (bright = write/run/task), a band while it needed you, errored or hit quota, dots before the tab was watching">LAST 10 MIN</span>
                <span class="dashboard__col--num">FOR</span>
                <span class="dashboard__col--num">TOKENS</span>
                <span class="dashboard__col--num">COST</span>
                <span class="dashboard__col--work">WORKING SET</span>
                <span class="dashboard__col--kids">CHILDREN</span>
            </div>
            <div class="dashboard__section-grid"></div>
        `;
        const health = section.querySelector('.dashboard__section-health');
        section._sectionRefs = {
            name: section.querySelector('.dashboard__section-name'),
            path: section.querySelector('.dashboard__section-path'),
            count: section.querySelector('.dashboard__section-count'),
            lift: section.querySelector('.dashboard__section-lift'),
            grid: section.querySelector('.dashboard__section-grid'),
            health,
            healthStats: Object.fromEntries(SECTION_HEALTH_ORDER.map(bucket => {
                const className = SECTION_HEALTH_PRESENTATION[bucket].className;
                const stat = document.createElement('span');
                stat.className = `dashboard__health-stat dashboard__health-stat--${className}`;
                stat.style.display = 'none';
                stat.setAttribute('aria-hidden', 'true');
                health.appendChild(stat);
                return [bucket, stat];
            })),
            healthBars: Object.fromEntries(SECTION_HEALTH_ORDER.map(bucket => {
                const className = SECTION_HEALTH_PRESENTATION[bucket].className;
                return [bucket, section.querySelector(`.dashboard__healthbar-seg--${className}`)];
            })),
        };
        section._trueErrorCount = 0;
        return section;
    }

    _updateSectionHeader(sectionEl, projectPath, agents, laneAgents = []) {
        const refs = sectionEl._sectionRefs;
        const name = shortProjectName(projectPath, i18n.t('unknownProject'));
        refs.name.textContent = name;
        refs.count.textContent = String(agents.length);
        refs.count.title = i18n.t('nAgents')(agents.length);

        // 7.10 — identity is a status-free pennant, not a coloured panel.
        // Re-read each update: the shared repo registry may move a repo to
        // another pennant slot once sibling repos are live.
        const profile = projectProfile(projectPath);
        this._setCustomProperty(sectionEl, '--pennant', profile.accent || 'var(--ink-3)');
        this._setCustomProperty(sectionEl, '--pennant-ink', profile.labelText || profile.accent || 'var(--ink-1)');

        // Display shortened path
        const shortPath = projectPath === '_unknown' ? '' : shortenHomePath(projectPath);
        refs.path.textContent = shortPath;

        const lifted = laneAgents.length;
        refs.lift.hidden = lifted === 0;
        this._setText(refs.lift, lifted ? `+${lifted} in Need Action ↑` : '');
        refs.lift.title = lifted ? laneAgents.map(agent => agent.name || agent.id).join(', ') : '';

        // 7.7 — optional columns exist only while some row has data for them.
        const hasWork = agents.some(agent => workingSetForAgent(agent).length || collisionsForAgent(agent).length);
        const hasKids = agents.some(agent => this._hasChildProgress(agent));
        sectionEl.classList.toggle('dashboard__section--has-work', hasWork);
        sectionEl.classList.toggle('dashboard__section--has-kids', hasKids);

        this._updateSectionHealth(sectionEl, refs, [...agents, ...laneAgents]);
    }

    _hasChildProgress(agent) {
        const id = String(agent?.id ?? '');
        for (const candidate of this.world?.agents?.values?.() || []) {
            if (String(candidate.parentSessionId || '') === id) return true;
        }
        const supplied = Number(agent?.taskProgress?.total);
        return (Number.isFinite(supplied) && supplied > 0)
            || (String(agent?.provider || 'claude').toLowerCase() === 'claude'
                && Array.isArray(agent?.tasks) && agent.tasks.length > 0);
    }

    // Health rollup: six SignalLedger buckets for the section's agents.
    _updateSectionHealth(sectionEl, refs, agents) {
        const counts = sectionHealthCounts(agents);
        const orderedBuckets = nonZeroSectionHealthBuckets(counts);
        const visibleBuckets = new Set(orderedBuckets);
        const descriptions = orderedBuckets.map(bucket => healthDescription(bucket, counts[bucket]));
        refs.health.title = descriptions.join('; ');
        refs.health.setAttribute('aria-label', `Project health: ${descriptions.join('; ')}`);
        // Lane buckets are stated by the `+N in Need Action` lift instead.
        const statBuckets = orderedBuckets.filter(bucket => !BELL_BUCKETS.has(bucket));
        for (const bucket of SECTION_HEALTH_ORDER) {
            const el = refs.healthStats[bucket];
            const count = counts[bucket];
            if (!el) continue;
            if (statBuckets.includes(bucket)) {
                this._setText(el, healthCounterText(bucket, count));
                const description = healthDescription(bucket, count);
                el.title = description;
                el.dataset.separator = String(bucket !== statBuckets.at(-1));
                el.setAttribute('aria-label', description);
                el.setAttribute('aria-hidden', 'false');
                this._setStyle(el, 'display', '');
            } else {
                this._setText(el, '');
                el.title = '';
                el.removeAttribute('data-separator');
                el.removeAttribute('aria-label');
                el.setAttribute('aria-hidden', 'true');
                this._setStyle(el, 'display', 'none');
            }
        }

        // #44 — composite health pulse-bar: 2px segments sized by the same
        // six counts, with a one-shot red edge-flash only for a new true error.
        for (const bucket of SECTION_HEALTH_ORDER) {
            const segment = refs.healthBars[bucket];
            if (!segment) continue;
            this._setStyle(segment, 'flexGrow', String(counts[bucket]));
            this._setStyle(segment, 'display', visibleBuckets.has(bucket) ? '' : 'none');
        }

        if (counts.errors > (sectionEl._trueErrorCount || 0)
            && agents.some(agent => shouldFlashForStatus(agent.status))) {
            this._flashSectionErrored(sectionEl);
        }
        sectionEl._trueErrorCount = counts.errors;
    }

    _flashSectionErrored(sectionEl) {
        sectionEl.classList.remove('dashboard__section--errored-flash');
        void sectionEl.offsetWidth;
        sectionEl.classList.add('dashboard__section--errored-flash');
        clearTimeout(sectionEl._erroredFlashTimer);
        sectionEl._erroredFlashTimer = setTimeout(() => {
            sectionEl.classList.remove('dashboard__section--errored-flash');
            sectionEl._erroredFlashTimer = null;
        }, 600);
    }

    _createCard(agent) {
        const card = document.createElement('div');
        card.className = `dash-card dash-card--${agent.status}`;
        card.dataset.agentId = agent.id;

        // 7.7/7.8/7.11 — one flat instrument row: status spine (card ::before),
        // a static portrait niche, then only the columns the section shows.
        card.innerHTML = `
            <button type="button" class="dash-card__select dash-card__row">
                <span class="dash-card__niche"></span>
                <span class="dash-card__identity">
                    <span class="dash-card__name"></span>
                    <span class="dash-card__meta-line">
                        <span class="dash-card__provider-badge"></span>
                        <span class="dash-card__model"></span>
                        <span class="dash-card__role"></span>
                        <span class="dash-card__workflow-badge" style="display: none"></span>
                    </span>
                </span>
                <span class="dash-card__now">
                    <span class="dash-card__now-icon" aria-hidden="true"></span>
                    <span class="dash-card__phase"></span>
                    <span class="dash-card__phase-detail"></span>
                </span>
                <span class="dash-card__tape"></span>
                <span class="dash-card__for"></span>
                <span class="dash-card__usage-tokens"></span>
                <span class="dash-card__usage-cost"></span>
                <span class="dash-card__work-cell"><span class="dash-card__work-summary"></span></span>
                <span class="dash-card__children-cell">
                    <span class="dash-card__children"></span>
                    <span class="dash-card__children-source"></span>
                </span>
                <span class="dash-card__search-context" style="display: none"></span>
            </button>
            <div class="dash-card__kids" hidden></div>
            <div class="dash-card__detail" aria-hidden="true">
                <div class="dash-card__header">
                    <span class="dash-card__hero-slot"></span>
                    <span class="dash-card__info">
                        <span class="dash-card__detail-status"></span>
                        <span class="dash-card__meta">
                            <span class="dash-card__building-emblem" aria-hidden="true" style="display: none"></span>
                            <span class="dash-card__signal-source"></span>
                            <span class="dash-card__team-badge" style="display: none"></span>
                            <span class="dash-card__activity-age" style="display: none"></span>
                            <button type="button" class="dash-card__parent-chip" style="display: none"></button>
                        </span>
                    </span>
                    <span class="dash-card__strip" hidden>
                        <span class="dash-card__strip-key">
                            <span class="dash-card__strip-label dash-card__strip-label--transcript">TRANSCRIPT</span>
                            <span class="dash-card__strip-count"></span>
                            <span class="dash-card__strip-label dash-card__strip-label--observed">OBSERVED</span>
                            <span>this tab</span>
                        </span>
                        <span class="dash-card__strip-axis" aria-hidden="true"><span>10 min ago</span><span>now</span></span>
                    </span>
                    <button type="button" class="dash-card__copy-id" title="Copy session ID" aria-label="Copy session ID">ID</button>
                    <span class="dash-card__stale-badge" style="display: none" title="Showing cached data; latest refresh did not complete">STALE</span>
                </div>
                <div class="dash-card__activity">
                    <div class="dash-card__current-tool">
                        <span class="dash-card__tool-icon"></span>
                        <div class="dash-card__tool-info">
                            <div class="dash-card__tool-name"></div>
                            <div class="dash-card__tool-detail"></div>
                        </div>
                    </div>
                    <div class="dash-card__message"></div>
                    <div class="dash-card__working-set"></div>
                </div>
                <div class="dash-card__tools">
                    <div class="dash-card__tools-title">${i18n.t('toolHistory')}</div>
                    <div class="dash-card__tool-list">
                        <div class="dash-card__skeleton" aria-hidden="true">
                            <span class="dash-card__skeleton-line"></span>
                            <span class="dash-card__skeleton-line"></span>
                            <span class="dash-card__skeleton-line"></span>
                        </div>
                    </div>
                </div>
            </div>
        `;
        card.dataset.loading = 'true';

        // 7.8 — static portrait niche (integer scale, idle frame, never animated).
        const avatarCanvas = new AvatarCanvas(agent, this._roomy ? 'nicheRoomy' : 'niche');
        avatarCanvas.canvas.setAttribute('aria-hidden', 'true');
        card.querySelector('.dash-card__niche').appendChild(avatarCanvas.canvas);
        card._avatarCanvas = avatarCanvas;
        card._heroCanvas = null;
        card._avatarSignature = '';

        // 7.12 — observed-call tape, painted on whole pixels.
        const tapeCanvas = document.createElement('canvas');
        tapeCanvas.width = TAPE_WIDTH;
        tapeCanvas.height = TAPE_HEIGHT;
        tapeCanvas.className = 'dash-card__tape-canvas';
        tapeCanvas.setAttribute('aria-hidden', 'true');
        const tapeEl = card.querySelector('.dash-card__tape');
        tapeEl.appendChild(tapeCanvas);
        tapeEl.title = this._tapes?.title() || '';

        // Copy session ID without triggering card selection
        const copyBtn = card.querySelector('.dash-card__copy-id');
        copyBtn.addEventListener('click', (event) => {
            event.stopPropagation();
            this._copyAgentId(card.dataset.agentId);
        });

        const parentChip = card.querySelector('.dash-card__parent-chip');
        const selectParent = (event) => {
            event.stopPropagation();
            const parentId = parentChip.dataset.parentId;
            if (!parentId || parentChip.classList.contains('dash-card__parent-chip--muted')) return;
            const parent = this.world.agents.get(parentId);
            if (!parent) return;
            emitAgentSelected(parent);
            const parentCard = this.cards.get(parent.id);
            if (parentCard) {
                parentCard.scrollIntoView({ block: 'nearest', inline: 'nearest' });
                this._flashParentCard(parentCard);
            }
        };
        parentChip.addEventListener('click', selectParent);
        const selectBtn = card.querySelector('.dash-card__select');
        selectBtn.tabIndex = -1;
        selectBtn.addEventListener('click', () => {
            const current = this.world.agents.get(card.dataset.agentId);
            emitAgentSelected(current);
        });
        selectBtn.setAttribute('aria-pressed', String(this.selection.isSelected(agent.id)));

        card._elements = {
            select: selectBtn,
            name: card.querySelector('.dash-card__name'),
            model: card.querySelector('.dash-card__model'),
            workflowBadge: card.querySelector('.dash-card__workflow-badge'),
            parentChip: card.querySelector('.dash-card__parent-chip'),
            teamBadge: card.querySelector('.dash-card__team-badge'),
            role: card.querySelector('.dash-card__role'),
            activityAge: card.querySelector('.dash-card__activity-age'),
            providerBadge: card.querySelector('.dash-card__provider-badge'),
            detailStatus: card.querySelector('.dash-card__detail-status'),
            signalSource: card.querySelector('.dash-card__signal-source'),
            staleBadge: card.querySelector('.dash-card__stale-badge'),
            detail: card.querySelector('.dash-card__detail'),
            heroSlot: card.querySelector('.dash-card__hero-slot'),
            now: card.querySelector('.dash-card__now'),
            nowIcon: card.querySelector('.dash-card__now-icon'),
            phase: card.querySelector('.dash-card__phase'),
            phaseDetail: card.querySelector('.dash-card__phase-detail'),
            tapeCanvas,
            forCell: card.querySelector('.dash-card__for'),
            workSummary: card.querySelector('.dash-card__work-summary'),
            childrenSource: card.querySelector('.dash-card__children-source'),
            children: card.querySelector('.dash-card__children'),
            kids: card.querySelector('.dash-card__kids'),
            searchContext: card.querySelector('.dash-card__search-context'),
            currentTool: card.querySelector('.dash-card__current-tool'),
            toolIcon: card.querySelector('.dash-card__tool-icon'),
            toolName: card.querySelector('.dash-card__tool-name'),
            toolDetail: card.querySelector('.dash-card__tool-detail'),
            message: card.querySelector('.dash-card__message'),
            workingSet: card.querySelector('.dash-card__working-set'),
            tools: card.querySelector('.dash-card__tools'),
            toolList: card.querySelector('.dash-card__tool-list'),
            usageTokens: card.querySelector('.dash-card__usage-tokens'),
            usageCost: card.querySelector('.dash-card__usage-cost'),
            buildingEmblem: card.querySelector('.dash-card__building-emblem'),
            strip: card.querySelector('.dash-card__strip'),
            stripCount: card.querySelector('.dash-card__strip-count'),
            stripAxis: card.querySelector('.dash-card__strip-axis'),
            stripCanvas: null,
            call: null,
        };
        card._elapsedUnsubscribe = subscribeElapsedText(card._elements.forCell, (now) => {
            const current = this.world.agents.get(card.dataset.agentId);
            const ms = statusSinceMs(current, now);
            return ms == null ? '—' : formatElapsed(ms);
        });
        this._paintCardTape(card);

        return card;
    }

    // 7.8 — the 96 px hero portrait is created on demand: for the selected
    // row's detail and for bell-lane call cards, never for every row.
    _heroCanvasFor(cardEl, agent) {
        if (!cardEl._heroCanvas) {
            cardEl._heroCanvas = new AvatarCanvas(agent, 'hero');
            cardEl._heroCanvas.canvas.setAttribute('aria-hidden', 'true');
        }
        return cardEl._heroCanvas;
    }

    _mountHero(cardEl, agent, slot) {
        const hero = this._heroCanvasFor(cardEl, agent);
        if (slot && hero.canvas.parentElement !== slot) slot.appendChild(hero.canvas);
    }

    // 7.9 — bell-lane call card body, built the first time a card enters the lane.
    _ensureCallBlock(cardEl) {
        if (cardEl._elements.call) return cardEl._elements.call;
        const call = document.createElement('span');
        call.className = 'dash-card__call';
        call.innerHTML = `
            <span class="dash-card__call-hero"></span>
            <span class="dash-card__call-body">
                <span class="dash-card__call-head">
                    <span class="dash-card__call-name"></span>
                    <span class="dash-card__call-meta"></span>
                </span>
                <span class="dash-card__call-blocker"><span class="dash-card__call-glyph" aria-hidden="true"></span><span class="dash-card__call-blocker-text"></span></span>
                <span class="dash-card__call-quote"></span>
                <span class="dash-card__call-gauge" hidden>
                    <span class="dash-card__gauge-segs" aria-hidden="true">${'<i></i>'.repeat(GAUGE_SEGMENTS)}</span>
                    <span class="dash-card__gauge-label"></span>
                </span>
                <span class="dash-card__call-usage"></span>
                <span class="dash-card__call-prov"></span>
            </span>
            <span class="dash-card__call-side">
                <span class="dash-card__call-elapsed"></span>
                <span class="dash-card__call-first" hidden>ANSWER FIRST</span>
            </span>
        `;
        cardEl._elements.select.appendChild(call);
        const refs = {
            root: call,
            hero: call.querySelector('.dash-card__call-hero'),
            name: call.querySelector('.dash-card__call-name'),
            meta: call.querySelector('.dash-card__call-meta'),
            blocker: call.querySelector('.dash-card__call-blocker-text'),
            quote: call.querySelector('.dash-card__call-quote'),
            gauge: call.querySelector('.dash-card__call-gauge'),
            gaugeSegs: [...call.querySelectorAll('.dash-card__gauge-segs i')],
            gaugeLabel: call.querySelector('.dash-card__gauge-label'),
            usage: call.querySelector('.dash-card__call-usage'),
            elapsed: call.querySelector('.dash-card__call-elapsed'),
            prov: call.querySelector('.dash-card__call-prov'),
            first: call.querySelector('.dash-card__call-first'),
        };
        cardEl._elements.call = refs;
        // 9.10 — the age tier comes from the same elapsed time the clock
        // prints, so the plate can never disagree with its numeral.
        cardEl._callElapsedUnsubscribe = subscribeElapsedText(refs.elapsed, (now) => {
            const ms = statusSinceMs(this.world.agents.get(cardEl.dataset.agentId), now);
            const age = ms == null || ms < AGE_RIM_MS ? '0' : (ms < AGE_FILL_MS ? '1' : '2');
            if (cardEl.dataset.age !== age) cardEl.dataset.age = age;
            return ms == null ? '—' : formatClock(ms);
        });
        return refs;
    }

    _updateCallBlock(cardEl, agent) {
        const refs = this._ensureCallBlock(cardEl);
        this._mountHero(cardEl, agent, refs.hero);
        const model = modelPresentation(agent);
        const provider = providerPresentation(agent.provider, model.identity);
        const project = shortProjectName(agent.projectPath || '_unknown', i18n.t('unknownProject'));
        this._setText(refs.name, agent.name || agent.id);
        const providerEl = document.createElement('span');
        providerEl.className = 'dash-card__call-provider';
        providerEl.textContent = provider.badge.label;
        providerEl.style.color = provider.badge.color;
        refs.meta.replaceChildren(
            providerEl,
            document.createTextNode([model.label === provider.badge.label ? '' : model.label, agent.role || '', project]
                .filter(Boolean).map(text => ` · ${text}`).join('')),
        );
        refs.meta.title = `${provider.badge.label} · ${model.title || agent.model || ''} · ${agent.projectPath || ''}`;

        const status = normalizeStatus(agent.status);
        this._setText(refs.blocker, `${BELL_STATUS_WORD[status] || operatorStatusLabel(status)} — ${blockerText(agent)}`);
        const quote = safePromptDetail(agent);
        this._setText(refs.quote, quote ? `“${quote}”` : '');
        refs.quote.hidden = !quote;
        refs.quote.title = quote;

        const usage = TokenUsage.normalize(agent.tokens || null);
        const max = Number(usage.contextWindowMax) || 0;
        const used = Math.max(0, Number(usage.contextWindow) || 0);
        const showGauge = status === 'rate_limited' && max > 0;
        refs.gauge.hidden = !showGauge;
        if (showGauge) {
            const lit = Math.min(GAUGE_SEGMENTS, Math.round((used / max) * GAUGE_SEGMENTS));
            refs.gaugeSegs.forEach((seg, index) => {
                seg.className = index < lit ? (index >= lit - 2 ? 'on hot' : 'on') : '';
            });
            this._setText(refs.gaugeLabel, `context ${formatTokens(used)} / ${formatTokens(max)}`);
        }
        const footer = this._usageFooterFor(agent, null);
        const usageText = status === 'rate_limited' && footer.tokensShort !== '—'
            ? `${footer.tokensShort} tokens · ${footer.costShort} this session`
            : '';
        this._setText(refs.usage, usageText);
        refs.usage.hidden = !usageText;

        this._setText(refs.prov, signalProvenance(agent).toUpperCase());
        refs.prov.title = signalProvenance(agent);
    }

    _renderAttentionQueue(agents) {
        if (!this.attentionEl) return;
        const buckets = bucketAgents(agents);
        const counts = bucketCounts(buckets);
        const providers = [...new Set(agents.map(agent => String(agent.provider || 'claude').toLowerCase()))]
            .sort((a, b) => a.localeCompare(b));
        const providerCounts = Object.fromEntries(providers.map(provider => [
            provider,
            agents.filter(agent => String(agent.provider || 'claude').toLowerCase() === provider).length,
        ]));
        const signature = JSON.stringify({
            counts: ROW_STATUS_FILTERS.map(({ key }) => counts[key] || 0),
            providerCounts,
            status: [...this._statusFilters].sort(),
            provider: [...this._providerFilters].sort(),
            search: this._searchQuery,
            matches: this._searchMatches?.size ?? agents.length,
        });
        this.attentionEl.hidden = false;
        if (signature === this._controlsSignature) return;
        this._controlsSignature = signature;

        const focusedKey = this.attentionEl.contains(document.activeElement)
            ? document.activeElement?.dataset?.filterKey
            : null;
        // 0.6/7.9 — one quiet instrument line: `ALL QUIET` when nothing needs
        // action, zero counts recede to --ink-4, exceptions keep a tinted rim.
        const heading = document.createElement('div');
        heading.className = `dashboard-attention__heading${counts.actionable ? '' : ' dashboard-attention__heading--quiet'}`;
        heading.textContent = counts.actionable ? `${counts.actionable} NEED ACTION` : 'ALL QUIET';
        const list = document.createElement('div');
        list.className = 'dashboard-attention__list';
        for (const { key, label, shape } of ROW_STATUS_FILTERS) {
            const count = counts[key] || 0;
            const button = this._filterButton({
                key: `status:${key}`,
                label: '',
                pressed: this._statusFilters.has(key),
                onClick: () => {
                    if (this._statusFilters.has(key)) this._statusFilters.delete(key);
                    else this._statusFilters.add(key);
                    this._controlsSignature = '';
                    this.render();
                },
            });
            button.classList.add(`dashboard-attention__item--${shape}`);
            button.classList.toggle('dashboard-attention__item--zero', count === 0);
            button.title = `${count} ${label.toLowerCase()} · click to filter`;
            const pip = document.createElement('i');
            pip.className = `dashboard-attention__pip dashboard-attention__pip--${shape}`;
            pip.setAttribute('aria-hidden', 'true');
            const number = document.createElement('b');
            number.textContent = String(count);
            button.append(pip, number, document.createTextNode(` ${label}`));
            list.appendChild(button);
        }
        const providerLabel = document.createElement('span');
        providerLabel.className = 'dashboard-attention__provider-label';
        providerLabel.textContent = 'Provider';
        providerLabel.setAttribute('role', 'separator');
        if (providers.length) list.appendChild(providerLabel);
        for (const provider of providers) {
            list.appendChild(this._filterButton({
                key: `provider:${provider}`,
                label: `${providerPresentation(provider).badge.label} ${providerCounts[provider]}`,
                pressed: this._providerFilters.has(provider),
                onClick: () => {
                    if (this._providerFilters.has(provider)) this._providerFilters.delete(provider);
                    else this._providerFilters.add(provider);
                    this._controlsSignature = '';
                    this.render();
                },
            }));
        }
        if (this._statusFilters.size || this._providerFilters.size) {
            list.appendChild(this._filterButton({
                key: 'clear',
                label: 'Clear filters',
                pressed: false,
                onClick: () => {
                    this._statusFilters.clear();
                    this._providerFilters.clear();
                    this._controlsSignature = '';
                    this.render();
                },
            }));
        }
        if (this._searchQuery) {
            const search = document.createElement('span');
            search.className = 'dashboard-attention__search';
            search.textContent = `Search "${truncateText(this._searchQuery, 32)}" · ${this._searchMatches?.size || 0} matches`;
            list.appendChild(search);
        }
        // 7.11 — one legend replaces the per-row ESTIMATE / UNAVAILABLE pills.
        const legend = document.createElement('span');
        legend.className = 'dashboard-attention__legend';
        legend.textContent = '≈ estimate · — unavailable';
        legend.title = '≈ cost estimated from token counts and published rates; — no usage reported';
        replaceChildren(this.attentionEl, [heading, list, legend]);
        if (focusedKey) {
            [...this.attentionEl.querySelectorAll('[data-filter-key]')]
                .find(button => button.dataset.filterKey === focusedKey)
                ?.focus({ preventScroll: true });
        }
    }

    _filterButton({ key, label, pressed, onClick }) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'dashboard-attention__item';
        button.dataset.filterKey = key;
        button.setAttribute('aria-pressed', String(pressed));
        button.textContent = label;
        button.addEventListener('click', onClick);
        return button;
    }

    _updateCard(cardEl, agent) {
        const refs = cardEl._elements;
        const status = normalizeStatus(agent.status);
        const model = modelPresentation(agent);
        const provider = providerPresentation(agent.provider, model.identity);
        const statusInfo = statusPresentation(status, i18n);
        const building = buildingClassForAgent(agent);
        const inLane = Boolean(this._bellEl) && cardEl.parentElement === this._bellEl;
        const signature = [
            building || '',
            inLane,
            agent.name || '',
            agent.model || '',
            agent.effort || '',
            agent.provider || '',
            agent.role || '',
            agent.workflowName || '',
            agent.parentSessionId || '',
            agent.teamName || '',
            status,
            agent.waitReason || '',
            agent.signalSource || '',
            agent.signalCertainty || '',
            agent.signalStale || false,
            agent.turnState || '',
            safePromptDetail(agent),
            agent.pendingTool || '',
            agent.currentTool || '',
            agent.currentToolInput || '',
            agent.lastMessage || '',
            agent.projectPath || '',
            JSON.stringify(agent.tokens || null),
            i18n.lang || '',
        ].join('|');

        cardEl._projectPath = agent.projectPath || '_unknown';
        cardEl._status = status;
        if (this._cardRenderSignatures.get(agent.id) !== signature) {
            this._cardRenderSignatures.set(agent.id, signature);

            const selected = this.selection.isSelected(agent.id);
            // 9.5 / one ask, one frame: a lane card wears the call card's attn
            // slice in its status hue instead of the row's status spine.
            const frame = inLane ? ` cv-frame ${CALL_FRAME_BY_STATUS[status] || 'cv-frame--attn'}` : '';
            const nextClass = `dash-card dash-card--${status}${inLane ? ' dash-card--call' : ''}${frame}${selected ? ' dash-card--selected' : ''}`;
            if (cardEl.className !== nextClass) cardEl.className = nextClass;
            const now = rowNow(agent);
            refs.select.setAttribute('aria-label', `Select agent ${agent.name || agent.id}, ${statusInfo.label}: ${now.lead} ${now.detail}`.trim());
            refs.select.setAttribute('aria-pressed', String(selected));
            refs.select.setAttribute('aria-expanded', String(selected));
            refs.select.title = signalProvenance(agent);
            refs.detail?.setAttribute('aria-hidden', String(!selected));

            this._setText(refs.name, agent.name);
            // Codex-style labels repeat the provider; say it once.
            this._setText(refs.model, model.label === provider.badge.label ? '' : model.label);
            refs.model.title = model.title;

            // Workflow swarm members read as one unit via a shared workflow chip;
            // it stands in for the generic 'workflow-subagent' role text.
            if (agent.workflowName) {
                this._setText(refs.workflowBadge, `⚙ ${agent.workflowName}`);
                refs.workflowBadge.title = `Workflow: ${agent.workflowName}`;
                this._setStyle(refs.workflowBadge, 'display', '');
                this._setText(refs.role, '');
            } else {
                this._setStyle(refs.workflowBadge, 'display', 'none');
                this._setText(refs.role, agent.role || '');
            }

            if (agent.teamName) {
                const team = getTeamColor(agent.teamName);
                this._setText(refs.teamBadge, `⚑ ${shortTeamName(agent.teamName)}`);
                refs.teamBadge.title = `Team: ${agent.teamName}`;
                this._setStyle(refs.teamBadge, 'color', team.accent);
                this._setStyle(refs.teamBadge, 'display', '');
            } else {
                this._setStyle(refs.teamBadge, 'display', 'none');
            }

            // Provider identity is text in its trim hue, not a filled pill.
            const badge = provider.badge;
            this._setText(refs.providerBadge, badge.label);
            this._setStyle(refs.providerBadge, 'color', badge.color);
            // A lane card already states status and provenance in its call
            // block; its selected detail does not repeat them.
            this._setText(refs.signalSource, inLane ? '' : signalProvenance(agent).toUpperCase());
            this._setStyle(refs.signalSource, 'display', inLane ? 'none' : '');
            refs.signalSource.title = 'Signal source and certainty';

            const reason = waitReasonLabel(agent);
            this._setText(refs.detailStatus, inLane ? '' : `${operatorStatusLabel(status)}${reason ? ` — ${reason}` : ''}`);
            this._setStyle(refs.detailStatus, 'display', inLane ? 'none' : '');
            refs.detailStatus.dataset.status = status;

            const tool = currentToolPresentation(agent, i18n);
            refs.currentTool.classList.toggle('dash-card__current-tool--idle', tool.isIdle);
            refs.toolIcon.replaceChildren(pixelIcon(toolCategory(agent.currentTool)));
            this._setText(refs.toolName, tool.name);
            replaceDetailRows(refs.toolDetail, tool.detail ? [inspectableText(tool.detail, { summary: formatToolDetail(tool.detail, { max: 80 }), key: 'current-tool' })] : []);

            // 7.7 — NOW merges the old PHASE / BLOCKER / message cells.
            refs.now.className = `dash-card__now dash-card__now--${now.kind}`;
            refs.nowIcon.replaceChildren(...(now.kind === 'tool' ? [pixelIcon(toolCategory(agent.currentTool))] : []));
            this._setText(refs.phase, now.lead);
            this._setText(refs.phaseDetail, now.detail);
            refs.now.title = now.title || `${now.lead} ${now.detail}`.trim();

            const promptDetail = safePromptDetail(agent);
            const searchContext = this._searchContexts.get(String(agent.id)) || '';
            this._setText(refs.searchContext, searchContext);
            this._setStyle(refs.searchContext, 'display', searchContext ? '' : 'none');

            if (agent.lastMessage) {
                replaceDetailRows(refs.message, [inspectableText(agent.lastMessage, { summary: truncateText(agent.lastMessage, 100), key: 'latest-message', truncated: agent.lastMessageTruncated === true })]);
                this._setStyle(refs.message, 'display', '');
            } else if (promptDetail && inLane) {
                // The call card quotes the request; only a truncated quote
                // earns a disclosure, and it does not restate the blocker.
                const fullPrompt = safePromptDetail(agent, Infinity);
                const truncated = fullPrompt !== promptDetail;
                replaceDetailRows(refs.message, truncated ? [inspectableText(fullPrompt, { summary: 'Full request', key: 'blocked-request' })] : []);
                this._setStyle(refs.message, 'display', truncated ? '' : 'none');
            } else if (promptDetail) {
                replaceDetailRows(refs.message, [inspectableText(safePromptDetail(agent, Infinity), { summary: `${blockerText(agent) || 'Request'} · available request`, key: 'blocked-request' })]);
                this._setStyle(refs.message, 'display', '');
            } else {
                this._setStyle(refs.message, 'display', 'none');
            }

            // #30 — district identity lives only in the selected detail now
            // (7.10): an emblem glyph, no row wash.
            const buildingInfo = buildingPresentation(building);
            if (buildingInfo) {
                cardEl.dataset.building = buildingInfo.building;
                cardEl.style.setProperty('--cv-building', buildingInfo.accent);
                if (refs.buildingEmblem) {
                    refs.buildingEmblem.replaceChildren(pixelIcon(buildingInfo.building));
                    refs.buildingEmblem.title = `${buildingInfo.building.charAt(0).toUpperCase()}${buildingInfo.building.slice(1)} district`;
                    this._setStyle(refs.buildingEmblem, 'display', '');
                }
            } else {
                delete cardEl.dataset.building;
                cardEl.style.removeProperty('--cv-building');
                if (refs.buildingEmblem) this._setStyle(refs.buildingEmblem, 'display', 'none');
            }

            if (inLane) this._updateCallBlock(cardEl, agent);
        }

        this._syncHero(cardEl, agent);
        this._updateParentChip(cardEl, agent);
        this._updateActivityAge(cardEl, agent);
        this._renderWorkingSet(cardEl, agent);
        this._updateChildProgress(cardEl, agent);
        this._paintCardTape(cardEl);

        const appearance = agent.appearance || {};
        const avatarSignature = [
            agent.model || '',
            agent.effort || '',
            agent.provider || '',
            agent.teamName || '',
            appearance.skin || '',
            appearance.shirt || '',
            appearance.hair || '',
            appearance.hairStyle || '',
            appearance.pants || '',
            appearance.accessory || '',
            appearance.eyeStyle || '',
        ].join('|');
        if (cardEl._avatarCanvas && cardEl._avatarSignature !== avatarSignature) {
            cardEl._avatarSignature = avatarSignature;
            cardEl._avatarCanvas.agent = agent;
            if (cardEl._heroCanvas) cardEl._heroCanvas.agent = agent;
            this._scheduleAvatarDraw(cardEl);
        }

        // Render tool history
        const history = this.toolHistories.get(agent.id);
        if (history) {
            this._renderToolHistory(cardEl, agent.id, history);
        }

        // The compact row always uses the live session payload. Detail fetches
        // are reserved for the one selected row and may refine token totals.
        this._renderUsageFooter(cardEl, this.selection.isSelected(agent.id)
            ? (this.usageFooters.get(agent.id) || this._usageFooterFor(agent, null))
            : this._usageFooterFor(agent, null));

        this._updateStaleBadge(cardEl, agent);
    }

    // The hero portrait lives in the call card while the agent is in the bell
    // lane, otherwise in the selected row's detail header.
    _syncHero(cardEl, agent) {
        if (cardEl.classList.contains('dash-card--call')) return;
        if (!this.selection?.isSelected(agent.id)) return;
        this._mountHero(cardEl, agent, cardEl._elements?.heroSlot);
    }

    _renderWorkingSet(cardEl, agent) {
        const container = cardEl._elements?.workingSet;
        if (!container) return;
        const workingSet = workingSetForAgent(agent);
        const collisions = collisionsForAgent(agent);
        container.hidden = !workingSet.length && !collisions.length;
        const summary = cardEl._elements?.workSummary;
        const writes = workingSet.filter(item => item.op === 'write').length;
        const reads = workingSet.filter(item => item.op === 'read').length;
        const leadPath = collisions[0]?.path || workingSet[0]?.path || '';
        const counts = [writes ? `${writes} write` : '', reads ? `${reads} read` : ''].filter(Boolean);
        const prefix = collisions.length ? `${collisions.length} overlap` : counts.join(' · ');
        const summaryText = leadPath
            ? `${prefix}${prefix ? ' · ' : ''}${formatToolDetail(leadPath, { max: 38, projectPath: agent.projectPath || '' })}`
            : '—';
        this._setText(summary, summaryText);
        if (summary) summary.title = leadPath;
        summary?.parentElement?.classList.toggle('dash-card__work-cell--collision', collisions.length > 0);
        const signature = JSON.stringify([workingSet, collisions]);
        if (container._workingSetSignature === signature) return;
        container._workingSetSignature = signature;

        const title = document.createElement('div');
        title.className = 'dash-card__tools-title';
        title.textContent = 'WORKING SET';
        const rows = document.createElement('div');
        rows.className = 'dash-card__tool-list';
        if (!workingSet.length) {
            const empty = document.createElement('div');
            empty.className = 'dash-card__tool-detail';
            empty.textContent = 'no file activity recorded';
            rows.appendChild(empty);
        } else {
            for (const item of workingSet) {
                const row = document.createElement('div');
                row.className = 'dash-card__tool-detail';
                row.textContent = `${String(item.op).toUpperCase()} · ${item.path}`;
                row.title = item.path;
                rows.appendChild(row);
            }
        }
        for (const collision of collisions) {
            const others = collision.agents
                .filter(id => String(id) !== String(agent.id))
                .map(id => this.world.agents.get(String(id))?.name || String(id));
            const row = document.createElement('div');
            row.className = 'dash-card__tool-detail';
            row.textContent = `OVERLAP: ${collision.path} with ${others.join(', ')}`;
            row.style.color = collision.kind === 'write-write'
                ? 'var(--cv-status-errored, #e06c5b)'
                : 'var(--cv-text-muted, #8b8b9e)';
            rows.appendChild(row);
        }
        replaceChildren(container, [title, rows]);
    }

    _updateChildProgress(cardEl, agent) {
        const target = cardEl._elements?.children;
        if (!target) return;
        const sourceEl = cardEl._elements?.childrenSource;
        const parentId = String(agent.id);
        const children = [...this.world.agents.values()]
            .filter(candidate => String(candidate.parentSessionId || '') === parentId);
        const previousChildIds = this._executionChildIdsByParent.get(parentId) || [];
        const progress = deriveChildProgress(agent, children, { previousChildIds });
        this._executionChildIdsByParent.set(
            parentId,
            children.map((child, index) => executionChildId(child, index)),
        );
        const hasTaskProgress = progress.total > 0
            || children.length > 0
            || (String(agent.provider || 'claude').toLowerCase() === 'claude'
                && Array.isArray(agent.tasks)
                && agent.tasks.length > 0);
        this._renderKidStrip(cardEl, agent, children);
        if (!hasTaskProgress) {
            this._setText(target, agent.parentSessionId ? 'Child agent' : '—');
            target.title = agent.parentSessionId ? `Parent ${agent.parentSessionId}` : 'No child agents';
            this._setText(sourceEl, '');
            sourceEl?.removeAttribute('title');
            sourceEl?.classList.remove('dash-card__children-source--exact', 'dash-card__children-source--inferred');
            return;
        }
        this._setText(target, `${progress.done}/${progress.total} done`);
        target.title = children.length
            ? children.map(child => `${child.name || child.id}: ${child.isDeparted ? 'Unknown' : operatorStatusLabel(child.status)}`).join('; ')
            : 'Task-store progress';
        this._setText(sourceEl, String(progress.source || 'inferred').toUpperCase());
        sourceEl?.classList.remove('dash-card__children-source--exact', 'dash-card__children-source--inferred');
        sourceEl?.classList.add(`dash-card__children-source--${progress.source || 'inferred'}`);
        if (sourceEl) {
            sourceEl.title = progress.source === 'exact'
                ? 'Exact progress from the Claude task store'
                : 'Inferred from observed child sessions; disappearance is unknown';
        }
    }

    // 7.12 — children read under their parent, even across projects. Each
    // child keeps its own row in its own project; this strip is a pointer.
    _renderKidStrip(cardEl, agent, children) {
        const strip = cardEl._elements?.kids;
        if (!strip) return;
        const signature = JSON.stringify(children.map(child => [
            child.id, child.name, child.role, child.agentType, normalizeStatus(child.status), child.isDeparted === true,
            child.currentTool || '', child.currentToolInput || '', child.projectPath || '',
        ]).concat([[agent.projectPath || '']]));
        if (strip._kidSignature === signature) return;
        strip._kidSignature = signature;
        const chips = cardEl._kidChips || (cardEl._kidChips = new Map());
        const liveIds = new Set(children.map(child => String(child.id)));
        for (const [id, chip] of chips) {
            if (!liveIds.has(id)) {
                chip.destroy?.();
                chips.delete(id);
            }
        }
        strip.hidden = children.length === 0;
        const rows = children.map(child => {
            const id = String(child.id);
            let chip = chips.get(id);
            if (!chip) {
                chip = new AvatarCanvas(child, 'chip');
                chip.canvas.setAttribute('aria-hidden', 'true');
                chips.set(id, chip);
            } else {
                chip.agent = child;
                chip.draw();
            }
            const status = child.isDeparted ? 'unknown' : normalizeStatus(child.status);
            const now = rowNow(child);
            const row = document.createElement('button');
            row.type = 'button';
            row.className = `dash-card__kid dash-card__kid--${status}`;
            row.dataset.childId = id;
            const hook = Object.assign(document.createElement('span'), { className: 'dash-card__kid-hook', textContent: '↳' });
            const face = Object.assign(document.createElement('span'), { className: 'dash-card__kid-face' });
            face.appendChild(chip.canvas);
            const name = Object.assign(document.createElement('span'), { className: 'dash-card__kid-name', textContent: child.name || id });
            const otherProject = (child.projectPath || '') !== (agent.projectPath || '');
            const facts = [
                child.role || child.agentType || '',
                `${now.lead}${now.detail ? ` ${now.detail}` : ''}`,
                otherProject ? `in ${shortProjectName(child.projectPath || '_unknown', i18n.t('unknownProject'))}` : '',
            ].filter(Boolean).join(' · ');
            const detail = Object.assign(document.createElement('span'), { className: 'dash-card__kid-detail', textContent: facts });
            const state = Object.assign(document.createElement('span'), {
                className: 'dash-card__kid-status',
                textContent: child.isDeparted ? 'unknown' : operatorStatusLabel(child.status).toLowerCase(),
            });
            row.append(hook, face, name, detail, state);
            row.title = `Select ${child.name || id}`;
            row.addEventListener('click', (event) => {
                event.stopPropagation();
                const current = this.world.agents.get(id);
                if (!current) return;
                emitAgentSelected(current);
                this.cards.get(id)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
            });
            return row;
        });
        replaceChildren(strip, rows);
    }

    _updateParentChip(cardEl, agent) {
        const chip = cardEl._elements?.parentChip;
        if (!chip) return;
        const parentId = agent.parentSessionId || '';
        if (!parentId) {
            this._setStyle(chip, 'display', 'none');
            delete chip.dataset.parentId;
            chip.disabled = true;
            chip.classList.remove('dash-card__parent-chip--clickable', 'dash-card__parent-chip--muted');
            return;
        }

        const parent = this.world.agents.get(parentId);
        const label = parent?.name || 'ended';
        this._setText(chip, `parent: ${label}`);
        chip.dataset.parentId = parentId;
        chip.title = parent ? `Select parent ${parent.name || parent.id}` : 'Parent session ended';
        chip.classList.toggle('dash-card__parent-chip--clickable', !!parent);
        chip.classList.toggle('dash-card__parent-chip--muted', !parent);
        chip.disabled = !parent;
        this._setStyle(chip, 'display', '');
    }

    _syncSelectionControls(nextId, previousId) {
        for (const id of new Set([nextId, previousId].filter(Boolean))) {
            const selected = id === nextId;
            this.cards.get(id)?._elements?.select
                ?.setAttribute('aria-pressed', String(selected));
            this.cards.get(id)?._elements?.select
                ?.setAttribute('aria-expanded', String(selected));
            this.cards.get(id)?.classList.toggle('dash-card--selected', selected);
            this.cards.get(id)?._elements?.detail
                ?.setAttribute('aria-hidden', String(!selected));
            const agent = this.world.agents.get(id);
            const card = this.cards.get(id);
            if (agent && card) {
                if (selected) {
                    this._syncHero(card, agent);
                    this._paintStrip(card, id);
                }
                this._renderUsageFooter(card, selected
                    ? (this.usageFooters.get(id) || this._usageFooterFor(agent, null))
                    : this._usageFooterFor(agent, null));
            }
        }
        const focusIsInDashboard = this.gridEl?.contains?.(document.activeElement);
        if (!focusIsInDashboard && nextId && this.cards.has(nextId)) {
            this._focusedAgentId = nextId;
        }
        this._syncCardTabStops();
    }

    _cardIdsInVisualOrder() {
        if (!this.gridEl) return [];
        return [...this.gridEl.querySelectorAll('.dash-card[data-agent-id]')]
            .map(card => card.dataset.agentId)
            .filter(id => id && this.cards.has(id));
    }

    _syncCardTabStops(preferredId = null) {
        const ids = this._cardIdsInVisualOrder();
        let targetId = preferredId || this._focusedAgentId;
        if (!ids.includes(targetId)) {
            targetId = ids.includes(this._selectedAgentId) ? this._selectedAgentId : (ids[0] || null);
        }
        this._focusedAgentId = targetId;
        for (const [id, card] of this.cards) {
            const select = card._elements?.select;
            if (select) select.tabIndex = id === targetId ? 0 : -1;
        }
        return targetId;
    }

    _focusCard(agentId, { select = false } = {}) {
        const card = this.cards.get(agentId);
        const control = card?._elements?.select;
        if (!card || !control) return false;
        this._syncCardTabStops(agentId);
        control.focus({ preventScroll: true });
        card.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        if (select) emitAgentSelected(this.world.agents.get(agentId));
        return true;
    }

    _handleDashboardKeyboardCommand(event) {
        if (!event || !this.active || this._destroyed) return;
        if (event.ctrlKey || event.metaKey || event.altKey) return;
        if (isKeyboardEditTarget(document.activeElement)) return;
        if (document.getElementById('modalOverlay')?.getAttribute('aria-hidden') === 'false') return;

        if (event.code === 'KeyA') {
            // TopBar owns the app-wide A command. It runs on document before
            // this window handler; when it handled A, selection is already
            // mirrored here and Dashboard only has to bring that card to focus.
            if (event.defaultPrevented && this._selectedAgentId) {
                this._focusCard(this._selectedAgentId);
                return;
            }
            // Standalone Dashboard instances (including embeds/tests) retain
            // the same longest-waiting, rotating attention behavior.
            const ids = attentionAgentIds(this.world?.agents?.values?.());
            if (!ids.length) return;
            const id = ids[this._attentionCursor % ids.length];
            this._attentionCursor = (this._attentionCursor + 1) % ids.length;
            if (this._focusCard(id, { select: true })) event.preventDefault();
            return;
        }

        if (event.code === 'Escape') {
            // Dashboard owns Escape only while a dashboard card has focus. A
            // topbar popover, modal, or native popover gets the first chance to
            // close itself; it must not also clear the selected agent.
            if (!this.gridEl?.contains?.(document.activeElement) || hasOpenSurface()) return;
            emitAgentDeselected();
            event.preventDefault();
            return;
        }

        const direction = event.code === 'ArrowLeft' || event.code === 'ArrowUp'
            ? -1
            : (event.code === 'ArrowRight' || event.code === 'ArrowDown' ? 1 : 0);
        if (!direction) return;
        const ids = this._cardIdsInVisualOrder();
        const activeCardId = document.activeElement?.closest?.('.dash-card')?.dataset?.agentId;
        const targetId = nextCardId(ids, activeCardId || this._focusedAgentId, direction);
        if (targetId && this._focusCard(targetId)) event.preventDefault();
    }

    _updateActivityAge(cardEl, agent) {
        const chip = cardEl._elements?.activityAge;
        const ageMs = Number(agent.activityAgeMs);
        const isAged = Number.isFinite(ageMs) && ageMs > 15 * 60_000;
        cardEl.classList.toggle('dash-card--aged', isAged);
        if (!chip) return;

        const relative = formatRelative(Number(agent.lastSessionActivity) || 0);
        if (!relative) {
            this._setStyle(chip, 'display', 'none');
            return;
        }
        this._setText(chip, `last active ${relative}`);
        this._setStyle(chip, 'display', '');
    }

    _flashParentCard(cardEl) {
        cardEl.classList.remove('dash-card--parent-flash');
        void cardEl.offsetWidth;
        cardEl.classList.add('dash-card--parent-flash');
        clearTimeout(cardEl._parentFlashTimer);
        cardEl._parentFlashTimer = setTimeout(() => {
            cardEl.classList.remove('dash-card--parent-flash');
            cardEl._parentFlashTimer = null;
        }, 900);
    }

    // Coalesce avatar redraws into one requestAnimationFrame per render cycle
    // so detail polling never redraws avatar canvases synchronously.
    _scheduleAvatarDraw(cardEl) {
        this._pendingAvatarDraws.add(cardEl);
        if (this._avatarDrawFrame !== null) return;
        this._avatarDrawFrame = requestAnimationFrame(() => {
            this._avatarDrawFrame = null;
            const pending = this._pendingAvatarDraws;
            this._pendingAvatarDraws = new Set();
            for (const el of pending) {
                if (!el.isConnected) continue;
                el._avatarCanvas?.draw();
                el._heroCanvas?.draw();
            }
        });
    }

    _usageFooterFor(agent, data) {
        const raw = data?.tokenUsage || data?.tokens || data?.usage || agent?.tokens || null;
        const usage = TokenUsage.normalize(raw);
        const totalTokens = TokenUsage.totalTokens(usage);
        const reported = agent?.cost?.source === 'provider' ? agent.cost : null;
        const cost = reported || TokenUsage.estimateCost(usage, agent.model, agent.provider);
        const source = reported ? 'provider' : 'estimate';
        const revision = cost.rateRevision || TokenUsage.rateRevision;
        const unavailableUsage = usage.availability === 'unavailable';
        return {
            tokens: unavailableUsage ? 'Usage unavailable'
                : `${formatTokens(totalTokens)} tokens${usage.availability === 'partial' ? ' · partial' : ''}`,
            cost: cost.usd == null ? 'Cost unavailable' : `${source === 'estimate' ? '~' : ''}${formatCost(cost.usd)}`,
            // 7.11 — row cells: `≈` marks an estimate, `—` means unavailable.
            tokensShort: unavailableUsage ? '—' : formatTokens(totalTokens),
            partial: usage.availability === 'partial',
            costShort: cost.usd == null ? '—' : `${source === 'estimate' ? '≈' : ''}${formatCost(cost.usd)}`,
            costTitle: source === 'provider'
                ? `Reported by ${agent.provider || 'provider'}`
                : `Estimated using ${cost.rateMatch || 'default'} rates, revision ${revision}`,
            source: cost.usd == null ? 'unavailable' : source,
            unknownModel: cost.unknownModel,
        };
    }

    _renderUsageFooter(cardEl, footer) {
        const refs = cardEl._elements;
        if (!refs?.usageTokens || !footer) return;
        this._setText(refs.usageTokens, footer.tokensShort ?? footer.tokens);
        refs.usageTokens.classList.toggle('dash-card__usage-tokens--partial', footer.partial === true);
        refs.usageTokens.title = footer.tokens;
        this._setText(refs.usageCost, footer.costShort ?? footer.cost);
        refs.usageCost.classList.toggle('dash-card__usage-cost--default-rate', footer.unknownModel === true);
        refs.usageCost.title = footer.unknownModel
            ? `${footer.costTitle} (unknown model: default rate)`
            : footer.source === 'unavailable' ? 'Cost unavailable' : footer.costTitle;
    }

    _renderDetailError(cardEl, agentId) {
        delete cardEl.dataset.loading;
        if (this.toolHistoryRenderSignatures.get(agentId) === '__error__') return;
        this.toolHistoryRenderSignatures.set(agentId, '__error__');
        // 4.1 — the error notice needs its container back if an earlier empty
        // history collapsed it.
        this._setStyle(cardEl._elements.tools, 'display', '');
        const errorEl = document.createElement('div');
        errorEl.className = 'dash-card__tool-error';
        errorEl.textContent = 'Session details unavailable';
        replaceChildren(cardEl._elements.toolList, [errorEl]);
    }

    _updateStaleBadge(cardEl, agent) {
        const badge = cardEl._elements?.staleBadge;
        if (!badge) return;
        const hasDetail = this.toolHistories.has(agent.id) || this.usageFooters.has(agent.id);
        const cacheState = hasDetail ? sessionDetailsService.detailCacheState(agent) : null;
        const label = detailFreshnessLabel(agent, cacheState);
        this._setText(badge, label);
        this._setStyle(badge, 'display', label ? '' : 'none');
    }

    _renderToolHistory(cardEl, agentId, tools) {
        delete cardEl.dataset.loading;
        const refs = cardEl._elements;
        const listEl = refs.toolList;
        const limited = (tools || []).slice(-DASHBOARD_TOOL_HISTORY_LIMIT);

        const signature = toolHistorySignature(limited, {
            limit: DASHBOARD_TOOL_HISTORY_LIMIT,
            detailLength: 60,
        });
        const exitSignature = limited
            .map(row => (Number.isFinite(Number(row?.toolExitCode)) ? row.toolExitCode : ''))
            .join(',');
        const historySignature = `${signature}|${exitSignature}`;

        if (this.toolHistoryRenderSignatures.get(agentId) === historySignature) return;
        this.toolHistoryRenderSignatures.set(agentId, historySignature);

        // 4.1 — no tool history: collapse the whole tools block (skeleton and
        // "No tool usage" copy included) so cards stay compact. The block
        // returns as soon as real history or an error notice arrives.
        if (limited.length === 0) {
            this._setStyle(refs.tools, 'display', 'none');
            replaceChildren(listEl, []);
            return;
        }
        this._setStyle(refs.tools, 'display', '');

        const nodes = toolHistoryNodes(limited, {
            limit: DASHBOARD_TOOL_HISTORY_LIMIT,
            detailLength: 60,
            emptyText: i18n.t('noToolUsage'),
            emptyClass: 'dash-card__loading',
            itemClass: 'dash-card__tool-item',
            iconClass: 'dash-card__tool-item-icon',
            nameClass: 'dash-card__tool-item-name',
            detailClass: 'dash-card__tool-item-detail',
            timeClass: 'dash-card__tool-item-time',
            includeCategoryClasses: true,
            formatDetail: detail => formatToolDetail(detail, {
                max: 60,
                projectPath: this.world.agents.get(agentId)?.projectPath || '',
            }),
        });
        const newestFirst = [...limited].reverse();
        nodes.forEach((node, index) => {
            const chip = this._toolExitChip(newestFirst[index]);
            if (chip) node.querySelector('summary')?.appendChild(chip);
        });
        replaceDetailRows(listEl, nodes);
    }

    _toolExitChip(entry) {
        const exitCode = Number(entry?.toolExitCode);
        if (!Number.isFinite(exitCode) || exitCode === 0) return null;
        const chip = document.createElement('span');
        chip.className = 'dash-card__tool-item-exit';
        chip.textContent = `exit ${exitCode}`;
        chip.title = entry?.toolStderr
            ? truncateText(entry.toolStderr, 200)
            : `Exit code ${exitCode}`;
        return chip;
    }

    _startDetailFetching() {
        this._stopDetailFetching();
        this._detailFetchGeneration++;
        // Run once immediately, then every 3 seconds
        this._fetchAllDetails();
        this._globalFetchTimer = setInterval(() => this._fetchAllDetails(), SESSION_DETAIL_REFRESH_INTERVAL);
    }

    _stopDetailFetching() {
        if (this._globalFetchTimer) {
            clearInterval(this._globalFetchTimer);
            this._globalFetchTimer = null;
        }
        this._detailFetchGeneration++;
    }

    async _fetchAllDetails() {
        if (!this.active || this._isFetchingDetails || document.hidden) return;
        this._isFetchingDetails = true;
        const generation = this._detailFetchGeneration;

        const agents = Array.from(this.world.agents.values());
        try {
            const candidates = this._detailCandidates(agents);
            if (!candidates.length) return;
            const detailsByAgentId = await sessionDetailsService.fetchSessionDetailsBatch(candidates);
            if (!this.active || generation !== this._detailFetchGeneration) return;
            for (const agent of candidates) {
                const data = detailsByAgentId.get(agent.id);
                const cardEl = this.cards.get(agent.id);
                if (!data) {
                    // Fetch failed (or detail unavailable) with nothing cached:
                    // show an explicit error instead of an eternal spinner.
                    if (cardEl && !this.toolHistories.has(agent.id)) this._renderDetailError(cardEl, agent.id);
                    if (cardEl) this._updateStaleBadge(cardEl, agent);
                    continue;
                }
                const footer = this._usageFooterFor(agent, data);
                if (footer) this.usageFooters.set(agent.id, footer);
                else this.usageFooters.delete(agent.id);
                if (cardEl) this._renderUsageFooter(cardEl, footer);
                // The strip places every fetched call; the list shows the newest.
                const toolHistory = Array.isArray(data.toolHistory) ? data.toolHistory : [];
                this.toolHistories.set(agent.id, toolHistory);
                if (cardEl) {
                    this._renderToolHistory(cardEl, agent.id, toolHistory);
                    this._updateStaleBadge(cardEl, agent);
                    this._paintStrip(cardEl, agent.id);
                }
            }
        } finally {
            this._isFetchingDetails = false;
        }
    }

    _clearAllCardsAndSections() {
        for (const id of [...this.cards.keys()]) this._removeCard(id, { removeEmptySection: false });
        this.toolHistories.clear();
        this.usageFooters.clear();
        this.toolHistoryRenderSignatures.clear();
        this._cardRenderSignatures.clear();

        for (const [, sectionEl] of this._sectionEls) {
            if (sectionEl._erroredFlashTimer) clearTimeout(sectionEl._erroredFlashTimer);
            sectionEl.remove();
        }
        this._sectionEls.clear();
    }

    _removeCard(agentId, { removeEmptySection = true } = {}) {
        const cardEl = this.cards.get(agentId);
        const projectPath = cardEl?._projectPath;
        const focusWasInCard = Boolean(cardEl?.contains?.(document.activeElement));
        const idsBeforeRemoval = (focusWasInCard || this._focusedAgentId === agentId)
            ? this._cardIdsInVisualOrder()
            : null;
        if (cardEl) {
            this._pendingAvatarDraws.delete(cardEl);
            if (cardEl._parentFlashTimer) clearTimeout(cardEl._parentFlashTimer);
            cardEl._elapsedUnsubscribe?.();
            cardEl._elapsedUnsubscribe = null;
            cardEl._callElapsedUnsubscribe?.();
            cardEl._callElapsedUnsubscribe = null;
            cardEl._avatarCanvas?.destroy?.();
            cardEl._avatarCanvas = null;
            cardEl._heroCanvas?.destroy?.();
            cardEl._heroCanvas = null;
            for (const chip of cardEl._kidChips?.values() || []) chip.destroy?.();
            cardEl._kidChips?.clear();
            cardEl.remove();
            this.cards.delete(agentId);
        }
        if (idsBeforeRemoval) {
            this._focusedAgentId = recoveryCardId(idsBeforeRemoval, agentId);
            this._syncCardTabStops();
            if (focusWasInCard && this._focusedAgentId) this._focusCard(this._focusedAgentId);
        }
        this.toolHistories.delete(agentId);
        this.usageFooters.delete(agentId);
        this.toolHistoryRenderSignatures.delete(agentId);
        this._cardRenderSignatures.delete(agentId);

        if (!removeEmptySection || !projectPath) return;
        const sectionEl = this._sectionEls.get(projectPath);
        const grid = sectionEl?._sectionRefs?.grid;
        if (sectionEl && (!grid || !grid.querySelector('.dash-card'))) {
            if (sectionEl._erroredFlashTimer) clearTimeout(sectionEl._erroredFlashTimer);
            sectionEl.remove();
            this._sectionEls.delete(projectPath);
        }
    }

    _detailCandidates(agents) {
        if (!this._selectedAgentId) return [];
        const selected = agents.find(agent => String(agent.id) === String(this._selectedAgentId));
        return selected ? [selected] : [];
    }


    async _copyAgentId(agentId) {
        if (!agentId || this._destroyed) return;
        try {
            await navigator.clipboard.writeText(agentId);
            if (this._destroyed) return;
            this.toast?.show('Session ID copied to clipboard', 'success');
        } catch {
            if (this._destroyed) return;
            this.toast?.show('Could not copy session ID', 'warning');
        }
    }

    // Actionable hints appended below the static empty-state copy in index.html.
    _appendEmptyHints() {
        if (!this.emptyEl || this.emptyEl.querySelector('.dashboard__empty-hints')) return;
        const hints = document.createElement('div');
        hints.className = 'dashboard__empty-hints';
        const lines = [
            '▸ Run a CLI agent (claude, codex, gemini, opencode, kimi) in any terminal',
            '▸ Or press WORLD in the top bar to watch the village view',
        ];
        for (const text of lines) {
            const el = document.createElement('span');
            el.className = 'dashboard__empty-hint';
            el.textContent = text;
            hints.appendChild(el);
        }
        this.emptyEl.appendChild(hints);
    }

    _setText(el, value) {
        const next = value == null ? '' : String(value);
        if (el && el.textContent !== next) el.textContent = next;
    }

    _setStyle(el, prop, value) {
        if (el && el.style[prop] !== value) el.style[prop] = value;
    }

    _setCustomProperty(el, prop, value) {
        if (el && el.style.getPropertyValue(prop) !== value) el.style.setProperty(prop, value);
    }

    destroy() {
        if (this._destroyed) return;
        this._destroyed = true;
        this.active = false;
        this._stopDetailFetching();
        this._stopTapeClock();
        for (const timer of this._flipTimers) clearTimeout(timer);
        this._flipTimers.clear();
        if (this._avatarDrawFrame !== null) {
            cancelAnimationFrame(this._avatarDrawFrame);
            this._avatarDrawFrame = null;
        }
        this._pendingAvatarDraws.clear();
        this._clearAllCardsAndSections();
        this.selection?.destroy?.();
        window.removeEventListener('keydown', this._onDashboardKeyDown);
        this._viewObserver?.disconnect();
        this.gridEl?.removeEventListener('focusin', this._onDashboardFocusIn);
        document.removeEventListener('visibilitychange', this._onVisibilityChange);
        eventBus.off('agent:added', this._onAgentAdded);
        eventBus.off('agent:updated', this._onAgentUpdated);
        eventBus.off('agent:removed', this._onAgentRemoved);
        eventBus.off('mode:changed', this._onModeChanged);
        eventBus.off(DASHBOARD_FILTER_EVENT, this._onSharedFilterChanged);
    }
}
