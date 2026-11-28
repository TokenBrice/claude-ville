import { eventBus } from '../../domain/events/DomainEvent.js';
import { bucketAgents, bucketCounts, bucketForStatus, compareByWaitAge } from '../../domain/services/SignalLedger.js';
import { toolCategory } from '../../domain/services/ToolIdentity.js';
import { normalizeBuildingType } from '../../config/buildings.js';
import { BUILDING_ACCENTS, BUILDING_ACCENTS_RGB } from '../../config/theme.js';
import { MendLedger } from '../character-mode/OutcomeMends.js';
import { AvatarCanvas } from './AvatarCanvas.js';
import {
    ghostTicksForTape,
    HOURS_STRIP_HEIGHT,
    HOURS_STRIP_WIDTH,
    ObservedCallTapeStore,
    paintHoursStripCanvas,
    paintSessionStrip,
    paintTape,
    ProjectHoursLedger,
    STRIP_HEIGHT,
    STRIP_WIDTH,
    TAPE_BUCKET_MS,
    TAPE_HEIGHT,
    TAPE_SHORT_WIDTH,
    TAPE_WIDTH,
    tapeSpanForAge,
} from './ObservedCallTape.js';
import { i18n } from '../../config/i18n.js';
import { sessionDetailsService } from '../shared/SessionDetailsService.js';
import { SESSION_DETAIL_REFRESH_INTERVAL } from '../../config/constants.js';
import { replaceChildren } from '../shared/DomSafe.js';
import { normalizeCostSource, TokenUsage } from '../../domain/value-objects/TokenUsage.js';
import {
    antigravityQuotaFacts,
    claudeQuotaFacts,
    codexQuotaFacts,
    collisionsForAgent,
    formatCost,
    formatCreditChange,
    costSourceTitle,
    formatElapsed,
    formatQuotaErrorStatus,
    formatRelative,
    formatResetCountdown,
    formatTokens,
    formatToolDetail,
    formatWaitAge,
    glmQuotaFacts,
    normalizeStatus,
    shortenHomePath,
    shortProjectName,
    subscribeElapsedText,
    truncateText,
    workingSetForAgent,
} from '../shared/Formatters.js';
import { AgentSelectionMirror, emitAgentDeselected, emitAgentSelected } from '../shared/AgentSelection.js';
import { HARBOR_FOCUS_FLEET_EVENT, harborLedger, ledgerFailureText, middleTruncate } from '../shared/HarborLedger.js';
import { normalizeRepoBranch } from '../shared/GitEventIdentity.js';
import { getTeamColor, shortTeamName } from '../shared/TeamColor.js';
import { attentionAgentIds, isKeyboardEditTarget, nextCardId, recoveryCardId } from './DashboardKeyboardNavigation.js';
import {
    pixelIcon,
    inspectableText,
    replaceDetailRows,
    detailFreshnessLabel,
    signalProvenance,
    mcpJobLabel,
    buildingClassForAgent,
    buildingPresentation,
    currentToolPresentation,
    DEPARTED_WORD,
    isAgedQuietRow,
    silentSignal,
    projectKeyForAgent,
    worktreeLabel,
    modelPresentation,
    projectProfile,
    providerPresentation,
    bucketWord,
    statusPresentation,
    statusWord,
    waitReasonLabel,
    toolHistoryNodes,
    toolHistorySignature,
} from '../shared/AgentPresentation.js';

const DASHBOARD_TOOL_HISTORY_LIMIT = 12;
const PROMPT_DETAIL_MAX_LENGTH = 200;
const DASHBOARD_FILTER_EVENT = 'dashboard:filter-changed';
const DASHBOARD_FILTER_REQUEST_EVENT = 'dashboard:filter-requested';
export const DASHBOARD_LOCATE_IN_WORLD_EVENT = 'dashboard:locate-in-world';
// W4.4 (F4/R11, §4.9) — optional grid-level columns allocate only when at
// least 30 % of visible rows carry data; below that, per-row inline chips ride
// at the right end of NOW so FOR/TOKENS/COST stay aligned across every project.
export const OPTIONAL_COLUMN_THRESHOLD = 0.30;

export function shouldAllocateOptionalColumn(matchCount, totalCount, threshold = OPTIONAL_COLUMN_THRESHOLD) {
    const total = Number(totalCount) || 0;
    const matches = Number(matchCount) || 0;
    if (total <= 0 || matches <= 0) return false;
    return (matches / total) + 1e-12 >= threshold;
}

// W4.4 (§4.9) — nine static cached 44x40 district backdrops for portraits in situ.
export const DISTRICT_BACKDROP_KEYS = Object.freeze([
    'command',
    'taskboard',
    'archive',
    'mine',
    'forge',
    'harbor',
    'watchtower',
    'tavern',
    'portal',
]);
export const DISTRICT_BACKDROP_SIZE = Object.freeze({ width: 44, height: 40 });
const DISTRICT_BACKDROP_SET = new Set(DISTRICT_BACKDROP_KEYS);
const _districtBackdropCache = new Map();

export function districtKeyForAgent(agent) {
    if (!agent) return null;
    const fromTools = normalizeBuildingType(buildingClassForAgent(agent));
    if (fromTools && DISTRICT_BACKDROP_SET.has(fromTools)) return fromTools;
    for (const candidate of [agent.targetBuildingType, agent.lastKnownBuildingType, agent.buildingType, agent.building]) {
        const normalized = normalizeBuildingType(candidate);
        if (normalized && DISTRICT_BACKDROP_SET.has(normalized)) return normalized;
    }
    const status = normalizeStatus(agent.status);
    if (status === 'idle' || status === 'completed') return 'tavern';
    return null;
}

function paintDistrictBackdrop(ctx, key) {
    const w = DISTRICT_BACKDROP_SIZE.width;
    const h = DISTRICT_BACKDROP_SIZE.height;
    const rgb = BUILDING_ACCENTS_RGB[key] || '139, 139, 158';
    const accent = BUILDING_ACCENTS[key] || '#8b8b9e';
    const tint = (alpha) => `rgba(${rgb}, ${alpha})`;

    // Warm dark-keep base + stepped horizon band so the villager face pops cleanly.
    ctx.fillStyle = '#0e0a08';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = tint(0.14);
    ctx.fillRect(0, 0, w, 16);
    ctx.fillStyle = tint(0.08);
    ctx.fillRect(0, 16, w, 14);
    ctx.fillStyle = '#140f0c';
    ctx.fillRect(0, 30, w, 10);

    // Subtle masonry / timber architectural crop specific to each of the 9 districts.
    ctx.fillStyle = tint(0.24);
    switch (key) {
        case 'command':
            // Battlements + domed hall lintel
            for (let x = 2; x < w - 2; x += 6) ctx.fillRect(x, 3, 4, 4);
            ctx.fillRect(4, 7, w - 8, 2);
            ctx.fillStyle = tint(0.18);
            ctx.fillRect(10, 9, 4, 21);
            ctx.fillRect(w - 14, 9, 4, 21);
            break;
        case 'taskboard':
            // Timber eave + slate board frame + twin eave lantern pips
            ctx.fillRect(3, 5, w - 6, 3);
            ctx.fillRect(6, 8, 2, 22);
            ctx.fillRect(w - 8, 8, 2, 22);
            ctx.fillStyle = accent;
            ctx.fillRect(5, 9, 2, 2);
            ctx.fillRect(w - 7, 9, 2, 2);
            break;
        case 'archive':
            // Three tall Gothic lancet arches
            for (const lx of [6, 19, 32]) {
                ctx.fillRect(lx + 1, 5, 4, 2);
                ctx.fillRect(lx, 7, 6, 18);
                ctx.fillStyle = '#0e0a08';
                ctx.fillRect(lx + 1, 8, 4, 15);
                ctx.fillStyle = tint(0.24);
            }
            break;
        case 'mine':
            // Heavy timber tunnel props + stone lintel + faint ore glints
            ctx.fillRect(4, 6, w - 8, 4);
            ctx.fillRect(5, 10, 4, 22);
            ctx.fillRect(w - 9, 10, 4, 22);
            ctx.fillStyle = accent;
            ctx.fillRect(11, 14, 2, 2);
            ctx.fillRect(w - 14, 19, 2, 2);
            break;
        case 'forge':
            // Brick arch + low ember hearth glow
            ctx.fillRect(6, 6, w - 12, 3);
            ctx.fillRect(4, 9, 4, 21);
            ctx.fillRect(w - 8, 9, 4, 21);
            ctx.fillStyle = tint(0.32);
            ctx.fillRect(10, 26, w - 20, 6);
            ctx.fillStyle = accent;
            ctx.fillRect(14, 29, w - 28, 2);
            break;
        case 'harbor':
            // Quay timber pilings + stepped sea ripples
            ctx.fillRect(0, 24, w, 3);
            ctx.fillRect(6, 14, 3, 18);
            ctx.fillRect(w - 9, 14, 3, 18);
            ctx.fillStyle = tint(0.28);
            ctx.fillRect(4, 31, 12, 1);
            ctx.fillRect(24, 34, 14, 1);
            break;
        case 'watchtower':
            // Lighthouse masonry courses + narrow coastal slits + beacon band
            ctx.fillRect(12, 4, w - 24, 3);
            ctx.fillStyle = accent;
            ctx.fillRect(15, 7, w - 30, 3);
            ctx.fillStyle = tint(0.22);
            ctx.fillRect(11, 10, w - 22, 20);
            ctx.fillStyle = '#0e0a08';
            ctx.fillRect(20, 14, 4, 8);
            break;
        case 'tavern':
            // Half-timber crossbeams + warm leaded window pane
            ctx.fillRect(2, 6, w - 4, 3);
            ctx.fillRect(4, 9, 3, 21);
            ctx.fillRect(w - 7, 9, 3, 21);
            ctx.fillStyle = tint(0.28);
            ctx.fillRect(12, 12, 8, 10);
            ctx.fillRect(w - 20, 12, 8, 10);
            break;
        case 'portal':
            // Carved stone arch + perimeter rune pips
            ctx.fillRect(8, 5, w - 16, 3);
            ctx.fillRect(6, 8, 3, 22);
            ctx.fillRect(w - 9, 8, 3, 22);
            ctx.fillStyle = accent;
            for (const [rx, ry] of [[10, 10], [w - 12, 10], [8, 18], [w - 10, 18]]) {
                ctx.fillRect(rx, ry, 2, 2);
            }
            break;
        default:
            break;
    }

    // Crisp 1 px inner dark seam
    ctx.fillStyle = 'rgba(0, 0, 0, 0.35)';
    ctx.fillRect(0, 0, w, 1);
    ctx.fillRect(0, h - 1, w, 1);
}

/**
 * Return the static cached 44x40 district backdrop for `building` (zero
 * per-frame allocation; at most 9 entries cached for the lifetime of the tab).
 */
export function getDistrictBackdrop(building) {
    const key = normalizeBuildingType(building);
    if (!key || !DISTRICT_BACKDROP_SET.has(key)) return null;
    if (_districtBackdropCache.has(key)) return _districtBackdropCache.get(key);
    let canvas = null;
    let dataUrl = '';
    if (typeof document !== 'undefined' && typeof document.createElement === 'function') {
        canvas = document.createElement('canvas');
        canvas.width = DISTRICT_BACKDROP_SIZE.width;
        canvas.height = DISTRICT_BACKDROP_SIZE.height;
        const ctx = canvas.getContext?.('2d');
        if (ctx) {
            ctx.imageSmoothingEnabled = false;
            paintDistrictBackdrop(ctx, key);
            if (typeof canvas.toDataURL === 'function') {
                try { dataUrl = canvas.toDataURL('image/png') || ''; } catch { dataUrl = ''; }
            }
        }
    }
    const entry = Object.freeze({
        building: key,
        width: DISTRICT_BACKDROP_SIZE.width,
        height: DISTRICT_BACKDROP_SIZE.height,
        accent: BUILDING_ACCENTS[key],
        canvas,
        dataUrl,
    });
    _districtBackdropCache.set(key, entry);
    return entry;
}

// W4.4 (§4.9) — Mend brackets: pair a failed shell run with the passing run
// that mended it using OutcomeMends.MendLedger.
function toolEntryTimestamp(entry, index) {
    const raw = entry?.ts ?? entry?.completedAt;
    const numeric = Number(raw);
    if (Number.isFinite(numeric) && numeric > 0) return numeric;
    const parsed = typeof raw === 'string' ? Date.parse(raw) : NaN;
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
    return (index + 1) * 1_000;
}

function toolEntryExitCode(entry) {
    const raw = entry?.toolExitCode ?? entry?.exitCode;
    if (raw === null || raw === undefined || raw === '') return null;
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
}

function toolEntryCommandDetail(entry) {
    const raw = typeof entry?.detail === 'string'
        ? entry.detail
        : (typeof entry?.input === 'string' ? entry.input : '');
    return raw.trim().replace(/^(?:command|cmd)=/, '');
}

/**
 * Run `MendLedger` across chronological tool history entries and return
 * display-order (newest-first) mend bracket pairs.
 */
export function findMendPairs(tools, { agentId = 'agent', provider = '' } = {}) {
    if (!Array.isArray(tools) || tools.length < 2) return [];
    const ledger = new MendLedger();
    const pairs = [];
    const count = tools.length;
    for (let chronoIndex = 0; chronoIndex < count; chronoIndex++) {
        const entry = tools[chronoIndex];
        const exitCode = toolEntryExitCode(entry);
        if (exitCode === null) continue;
        const mend = ledger.observe({
            agentId: String(agentId || 'agent'),
            id: chronoIndex,
            tool: entry?.tool,
            detail: toolEntryCommandDetail(entry),
            exitCode,
            exitCodeSource: entry?.exitCodeSource || 'exit',
            provider: provider || '',
            location: entry?.location ?? '',
            completedAt: toolEntryTimestamp(entry, chronoIndex),
        });
        if (!mend || !Number.isInteger(mend.failedId) || !Number.isInteger(mend.resultId)) continue;
        const passDisplayIndex = (count - 1) - mend.resultId;
        const failDisplayIndex = (count - 1) - mend.failedId;
        if (passDisplayIndex < 0 || failDisplayIndex >= count || passDisplayIndex >= failDisplayIndex) continue;
        pairs.push({
            passDisplayIndex,
            failDisplayIndex,
            signature: mend.signature,
            failedExit: mend.failedExit,
            failedAt: mend.failedAt,
            at: mend.at,
        });
    }
    return pairs;
}

/**
 * Annotate newest-first tool history DOM rows with 1 px margin mend brackets
 * for every `MendLedger` pair whose endpoints lie inside `nodes`.
 */
export function annotateMendBrackets(listEl, nodes, chronologicalTools, {
    agentId = 'agent',
    provider = '',
    classPrefix = 'dash-card__tool',
    offset = 0,
} = {}) {
    const pairs = findMendPairs(chronologicalTools, { agentId, provider });
    const hasClass = `${classPrefix}-list--has-mend`;
    const passClass = `${classPrefix}-item--mend-pass`;
    const spanClass = `${classPrefix}-item--mend-span`;
    const failClass = `${classPrefix}-item--mend-fail`;
    for (const node of nodes || []) {
        node?.classList?.remove?.(passClass, spanClass, failClass);
        if (node?.dataset) {
            delete node.dataset.mendRole;
            delete node.dataset.mendPair;
        }
    }
    let activePairs = 0;
    const end = offset + (nodes?.length || 0);
    pairs.forEach((pair, pairIndex) => {
        if (pair.passDisplayIndex < offset || pair.failDisplayIndex >= end) return;
        const localPass = pair.passDisplayIndex - offset;
        const localFail = pair.failDisplayIndex - offset;
        activePairs++;
        for (let i = localPass; i <= localFail; i++) {
            const row = nodes[i];
            if (!row) continue;
            const role = i === localPass ? 'pass' : (i === localFail ? 'fail' : 'span');
            row.classList?.add?.(role === 'pass' ? passClass : (role === 'fail' ? failClass : spanClass));
            if (row.dataset) {
                row.dataset.mendRole = role;
                row.dataset.mendPair = String(pairIndex);
            }
            if (role === 'pass' && !row.title) {
                row.title = `Mended earlier failure of ${pair.signature} (exit ${pair.failedExit})`;
            }
        }
    });
    listEl?.classList?.toggle?.(hasClass, activePairs > 0);
    return pairs;
}
// UI-1 — chips, the bell lane and section counts read the one status-word
// map (AgentPresentation.STATUS_WORDS): rate-limited is LIMIT here too.
const ROW_STATUS_FILTERS = Object.freeze([
    { key: 'needsYou', shape: 'needs-you' },
    { key: 'errors', shape: 'errored' },
    { key: 'quota', shape: 'quota' },
    { key: 'working', shape: 'working' },
    { key: 'watchlist', shape: 'watchlist' },
    { key: 'quiet', shape: 'idle' },
].map(filter => Object.freeze({ ...filter, label: bucketWord(filter.key) })));
// 7.9 — buckets that leave their project list for the bell lane.
const BELL_BUCKETS = new Set(['needsYou', 'errors', 'quota']);
const BELL_STATUS_WORD = Object.freeze(Object.fromEntries(
    ['waiting_on_user', 'errored', 'rate_limited'].map(status => [status, statusWord(status, 'upper')]),
));
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
        || ((agent?.signalSource === 'hook' || agent?.signalSource === 'push') ? agent?.lastToolInput : '');
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
    if (status === 'idle' || status === 'completed') return statusWord(status);
    return TURN_STATE_LABELS[agent?.turnState]
        || statusWord(status);
}

export function cleanMessage(text, max = 140) {
    const clean = String(text || '')
        .replace(/(?:^|[\r\n]+)\s*#{1,6}\s+/g, ' ')
        .replace(/!?\[([^\]]+)\]\((?:[^()\s]+|\([^()\s]*\))*\)/g, '$1')
        .replace(/`+/g, '')
        .replace(/\*\*/g, '')
        .replace(/(^|[\s([{"'])\*([^*\s](?:[^*]*[^*\s])?)\*(?=$|[\s.,;:!?)\]}"'])/g, '$1$2')
        .replace(/~~([^~]+)~~/g, '$1')
        .replace(/[\u0000-\u001f\u007f]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean;
}

function blockerText(agent, reason = waitReasonLabel(agent)) {
    const status = normalizeStatus(agent?.status);
    if (reason) return reason;
    if (status === 'waiting_on_user') return 'Waiting for input';
    if (status === 'errored') return cleanMessage(agent?.lastMessage, 90) || 'Session error';
    if (status === 'rate_limited') return cleanMessage(agent?.lastMessage, 90) || 'Usage limit reached';
    return '';
}

/**
 * 7.7 — the NOW column: the blocker for an exception, else the live tool
 * call, else the status word with the last observed message (labelled
 * `last:` so it never reads as current work).
 */
function rowNow(agent) {
    const status = normalizeStatus(agent?.status);
    // UI-13 — a departed villager says so through its 90 s grace.
    if (agent?.isDeparted) {
        const last = cleanMessage(agent?.lastMessage);
        return { kind: 'status', lead: DEPARTED_WORD, detail: last ? `· last: ${last}` : '', title: last ? `Last observed message: ${last}` : '' };
    }
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

function rowHasWork(agent) {
    return Boolean(workingSetForAgent(agent).length || collisionsForAgent(agent).length);
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
    errors: Object.freeze({ className: 'errored', label: bucketWord('errors', 'lower') }),
    needsYou: Object.freeze({ className: 'needs-you', label: bucketWord('needsYou', 'lower') }),
    quota: Object.freeze({ className: 'quota', label: bucketWord('quota', 'lower') }),
    working: Object.freeze({ className: 'working', label: bucketWord('working', 'lower') }),
    watchlist: Object.freeze({ className: 'watchlist', label: bucketWord('watchlist', 'lower') }),
    idle: Object.freeze({ className: 'idle', label: bucketWord('quiet', 'lower') }),
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

/**
 * UI-16 (Q5) — the lead a subagent folds under: its root session when the
 * adapter names one (`rootSessionId`, feature-detected), else its parent.
 * '' for a lead itself.
 */
export function leadIdFor(agent) {
    const lead = String(agent?.rootSessionId || agent?.parentSessionId || '');
    return lead && lead !== String(agent?.id || '') ? lead : '';
}

/**
 * A subagent's home is its lead's kid strip. Its full row shows only while
 * it is selected, matched by an active search or filter, or needs you (the
 * bell lane), or while its lead's toggle unfolds the crew; a child whose
 * lead is gone keeps its row.
 */
export function childRowVisible(agent, { selectedId = null, filtered = false, expandedLeads = new Set(), liveIds = new Set() } = {}) {
    const lead = leadIdFor(agent);
    if (!lead || !liveIds.has(lead)) return true;
    if (String(agent.id) === String(selectedId) || filtered) return true;
    if (BELL_BUCKETS.has(bucketForStatus(agent.status))) return true;
    return expandedLeads.has(lead);
}

/** Stable display order with zero-count buckets omitted. */
export function nonZeroSectionHealthBuckets(counts) {
    return SECTION_HEALTH_ORDER.filter(bucket => Number(counts?.[bucket]) > 0);
}

/**
 * UI-4 — the row's TOKENS cell: new tokens first (input, output and cache
 * writes, the top bar's measure), cache reads second, so scanning rows for
 * "who is burning" ranks by work, not by context size times turns.
 */
export function rowTokenCells(rawUsage) {
    const usage = TokenUsage.normalize(rawUsage);
    if (usage.availability === 'unavailable') return { newShort: '—', cacheShort: '', title: 'Usage unavailable' };
    const fresh = formatTokens(TokenUsage.newTokens(usage));
    const cache = usage.cacheRead > 0 ? formatTokens(usage.cacheRead) : '';
    return {
        newShort: fresh,
        cacheShort: cache ? `+${cache}` : '',
        title: `${fresh} new tokens (input, output, cache writes)${cache ? ` · ${cache} cache reads` : ''}${usage.availability === 'partial' ? ' · partial' : ''}`,
    };
}

// A quota-rail account card holds two lines: the reading on top, its facts
// (joined by ` · ` in CSS) below.
function quotaRows(part, head, facts) {
    const rows = document.createDocumentFragment();
    const top = part('dashboard-quota__head');
    top.append(...head);
    rows.append(top);
    if (facts.length) {
        const bottom = part('dashboard-quota__facts');
        bottom.append(...facts);
        rows.append(bottom);
    }
    return rows;
}

export { claudeQuotaFacts, codexQuotaFacts, glmQuotaFacts, antigravityQuotaFacts };

/** What the Quota Rail's 4 provider cards read from `/api/usage`: a change to any repaints the rail. */
export function quotaCardsSignature(usage) {
    const q = usage?.quota;
    return {
        claude: q || usage?.quotaError || usage?.quotaAvailable !== undefined ? {
            available: usage?.quotaAvailable ?? null,
            highestActiveLimit: q?.highestActiveLimit ?? null,
            sevenDay: q?.sevenDay ?? null,
            sevenDayResetsAt: q?.sevenDayResetsAt ?? null,
            fiveHour: q?.fiveHour ?? null,
            fiveHourResetsAt: q?.fiveHourResetsAt ?? null,
            error: usage?.quotaError ?? null,
        } : null,
        codex: usage?.codex ?? null,
        glm: usage?.glm ?? null,
        antigravity: usage?.antigravity ?? null,
    };
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
    // A lead's whole crew, nested children included (PV-15 `rootSessionId`).
    const children = (Array.isArray(agents) ? agents : []).filter((candidate) => (
        candidate
        && String(candidate.rootSessionId || candidate.parentSessionId || '') === rootId
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
    constructor(world, { toast = null, onLocateInWorld = null, onFocusExternal = null, frameAttention = null } = {}) {
        this.world = world;
        this.toast = toast;
        this._onLocateInWorld = typeof onLocateInWorld === 'function' ? onLocateInWorld : null;
        this._onFocusExternal = typeof onFocusExternal === 'function' ? onFocusExternal : null;
        this._frameAttention = typeof frameAttention === 'function' ? frameAttention : null;
        this.gridEl = document.getElementById('dashboardGrid');
        this.attentionEl = document.getElementById('dashboardAttentionQueue');
        this.emptyEl = document.getElementById('dashboardEmpty');
        this._appendEmptyHints();
        this.cards = new Map();
        this.toolHistories = new Map();
        this.detailUsage = new Map();
        this.toolHistoryRenderSignatures = new Map();
        this._cardRenderSignatures = new Map();
        this._executionChildIdsByParent = new Map();
        this._selectedAgentId = null;
        this._renderedSelectedAgentId = null;
        this._selectionDirty = false;
        this._focusedAgentId = null;
        this._attentionCursor = 0;
        this._dirtyHoursProjects = new Set();
        this._quotaRailPaused = false;
        this._statusFilters = new Set();
        this._providerFilters = new Set();
        this._searchQuery = '';
        this._searchMatches = null;
        this._searchContexts = new Map();
        this._stableAgentOrder = new Map();
        this._stableProjectOrder = new Map();
        this._expandedLeads = new Set();
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
        this._gridHasWork = false;
        this._gridHasKids = false;
        // 7.12 + W4.4 — observation starts when the Dashboard module loads;
        // every earlier bucket stays blank (or shows cached ghost ticks) left
        // of the 1 px brass openedAt rule. Fed in every mode, O(1) per update.
        this._tapes = new ObservedCallTapeStore();
        this._hours = new ProjectHoursLedger();
        for (const agent of world?.agents?.values?.() || []) {
            this._tapes.observe(agent);
            this._hours.observeAgent(this._projectKeyFor(agent), agent);
        }
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
                if (!this.active) {
                    this._selectionDirty = true;
                    return;
                }
                // UI-16 — selecting a folded subagent unfolds its row.
                if ([nextId, previousId].some(id => leadIdFor(this.world.agents.get(id)))) this._queueFlush({ render: true });
                this._syncSelectionControls(nextId, previousId);
                void this._fetchAllDetails();
            },
        });

        this._onAgentAdded = (agent) => {
            this._tapes?.observe(agent);
            this._hours?.observeAgent(this._projectKeyFor(agent), agent);
            if (this.active) this._queueFlush({ render: true });
        };
        this._onAgentUpdated = (agent) => {
            this._tapes?.observe(agent);
            const project = this._projectKeyFor(agent);
            if (this._hours?.observeAgent(project, agent) && this.active) {
                this._dirtyHoursProjects.add(project);
            }
            if (this.active) {
                if (!this._flushRender) {
                    this._renderAgentUpdate(agent);
                    const parentId = String(agent?.parentSessionId || '');
                    const parent = parentId ? this.world.agents.get(parentId) : null;
                    const parentCard = parentId ? this.cards.get(parentId) : null;
                    if (parent && parentCard) this._updateChildProgress(parentCard, parent);
                }
                this._queueFlush();
            }
        };
        this._onAgentRemoved = (agent) => {
            this._executionChildIdsByParent.delete(String(agent.id));
            this._tapes?.forget(agent.id);
            this._hours?.forget(agent.id);
            sessionDetailsService.deleteForAgent(agent);
            if (this.active) this._queueFlush({ render: true });
        };
        this._onOutcomeVerified = (outcome) => {
            if (!outcome || (outcome.kind !== 'commit' && outcome.kind !== 'push')) return;
            const agent = outcome.agentId ? this.world?.agents?.get?.(outcome.agentId) : null;
            const project = outcome.project || (agent ? this._projectKeyFor(agent) : null);
            if (!project) return;
            const changed = this._hours?.recordOutcome(
                project,
                outcome.kind,
                Number(outcome.at || outcome.ts) || Date.now(),
                outcome.id || outcome.eventId || null,
            );
            if (changed && this.active) {
                const sectionEl = this._sectionEls.get(project);
                if (sectionEl) this._paintSectionHours(sectionEl, project);
            }
        };
        this._onModeChanged = (mode) => {
            this.active = mode === 'dashboard';
            if (this.active) {
                if (this._quotaRailPaused) {
                    this._quotaRailPaused = false;
                    this._quotaRailSignature = '';
                }
                this.render();
                this._resumeCardElapsedSubscriptions();
                if (this._selectionDirty || this._selectedAgentId !== this._renderedSelectedAgentId) {
                    this._selectionDirty = false;
                    this._syncSelectionControls(this._selectedAgentId, this._renderedSelectedAgentId);
                }
                this._startDetailFetching();
                this._startTapeClock();
            } else {
                this._dirtyHoursProjects.clear();
                this._pauseCardElapsedSubscriptions();
                this._clearQuotaRailSubscriptions();
                this._quotaRailPaused = true;
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
            const query = String(payload.query || '').trim().toLowerCase();
            // The sidebar republishes its index as agents change, even with no filter.
            if (!query && !this._searchQuery) return;
            this._searchQuery = query;
            const matches = Array.isArray(payload.matches) ? payload.matches : [];
            this._searchMatches = this._searchQuery
                ? new Set(matches.map(match => String(match.agentId)))
                : null;
            this._searchContexts = new Map(matches
                .filter(match => match?.context)
                .map(match => [String(match.agentId), String(match.context)]));
            if (this.active) this._queueFlush({ render: true });
        };
        eventBus.on('agent:added', this._onAgentAdded);
        eventBus.on('agent:updated', this._onAgentUpdated);
        eventBus.on('agent:removed', this._onAgentRemoved);
        eventBus.on('outcome:verified', this._onOutcomeVerified);
        eventBus.on('mode:changed', this._onModeChanged);
        eventBus.on(DASHBOARD_FILTER_EVENT, this._onSharedFilterChanged);
        // U-P8 — each project lane states its harbor cargo (`3 unpushed ·
        // main` / `push failed 2m`) from the shared ledger rows.
        this._harborRepos = [];
        this._onHarborUpdated = (repos = []) => {
            this._harborRepos = Array.isArray(repos) ? repos : [];
            if (!this.active) return;
            for (const [projectPath, sectionEl] of this._sectionEls) {
                this._updateSectionHarbor(sectionEl, projectPath, sectionEl._harborAgents || []);
            }
        };
        eventBus.on('harbor:updated', this._onHarborUpdated);
        // Dedicated 4-provider account quota rail (Claude, Codex, GLM, Antigravity).
        this.quotaRailEl = null;
        this._quotaRailSignature = '';
        this._quotaRailUnsubscribes = [];
        this._latestUsage = null;
        this._onUsageUpdated = (usage) => {
            this._latestUsage = usage || null;
            if (this.active) this._renderQuotaRail();
        };
        eventBus.on('usage:updated', this._onUsageUpdated);
        document.addEventListener('visibilitychange', this._onVisibilityChange);
        // The view's own box (window resize, sidebar collapse), never the
        // grid's, so toggling the roomy tier cannot re-trigger it.
        this._viewObserver = typeof ResizeObserver === 'function' && this.gridEl?.parentElement
            ? new ResizeObserver(() => {
                if (!this.active) return;
                this._syncAttentionLayout();
                this._syncUltrawide();
            })
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
        this._renderQuotaRail();

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
            const project = this._projectKeyFor(agent);
            if (!laneByProject.has(project)) laneByProject.set(project, []);
            laneByProject.get(project).push(agent);
        }

        // Group every non-bell-lane visible agent (leads + folded subagents) by
        // project first so section headers count the full cohort; filter by
        // `_showsFullRow` only when building the card rows.
        const groups = [...this._groupAgentsByProject(visibleAgents.filter(agent => !laneIds.has(agent.id)))]
            .filter(([, groupAgents]) => groupAgents.some(agent => this._showsFullRow(agent)));
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

        const allRowAgents = [];
        for (const [index, [projectPath, groupAgents]] of groups.entries()) {
            existingSections.add(projectPath);
            this._sortAgentsExceptionFirst(groupAgents);
            const sectionEl = orderedSections[index];
            this._updateSectionHeader(sectionEl, projectPath, groupAgents, laneByProject.get(projectPath) || []);

            const gridInner = sectionEl._sectionRefs?.grid || sectionEl.querySelector('.dashboard__section-grid');

            const rowAgents = groupAgents.filter(agent => this._showsFullRow(agent));
            const orderedCards = [];
            for (const agent of rowAgents) {
                allRowAgents.push(agent);
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
        this._syncGridColumns(allRowAgents);
        this._syncUltrawide();
        this._finishLaneFlip(flip);
        this._syncAnswerFirst();
        sessionDetailsService.sweep(agents);
        this._syncCardTabStops();
    }

    // Group folded subagents with their live lead's project so Dashboard header
    // counts match Sidebar even when a child works in another directory.
    _projectKeyFor(agent) {
        const leadId = leadIdFor(agent);
        const lead = leadId ? this.world?.agents?.get?.(leadId) : null;
        return projectKeyForAgent(lead && !lead.isDeparted ? lead : agent);
    }

    _groupAgentsByProject(agents) {
        const groups = new Map();
        for (const agent of agents || []) {
            const key = this._projectKeyFor(agent);
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(agent);
        }
        return groups;
    }

    // Shared optional tracks at #dashboardGrid level (F4/R11, §4.9) so
    // FOR/TOKENS/COST align across all project sections. WORKING SET and
    // CHILDREN allocate only when >= 30 % of visible rows carry them; below
    // that threshold those rows show compact inline chips in NOW instead.
    _syncGridColumns(rowAgents, now = Date.now()) {
        if (!this.gridEl) return;
        const list = Array.isArray(rowAgents) ? rowAgents : [];
        const workRows = list.filter(rowHasWork).length;
        const kidRows = list.filter(agent => this._hasChildProgress(agent)).length;
        const hasWork = shouldAllocateOptionalColumn(workRows, list.length);
        const hasKids = shouldAllocateOptionalColumn(kidRows, list.length);
        const hasTape = Boolean(this._tapes?.hasObservedActivity(list.map(agent => agent.id), now));
        const span = this._tapes ? this._tapes.span(now) : tapeSpanForAge(0);
        this._gridHasWork = hasWork;
        this._gridHasKids = hasKids;
        this.gridEl.classList.toggle('dashboard__grid--has-work', hasWork);
        this.gridEl.classList.toggle('dashboard__grid--has-kids', hasKids);
        this.gridEl.classList.toggle('dashboard__grid--has-tape', hasTape);
        this.gridEl.classList.toggle('dashboard__grid--tape-5m', span.tier === '5m');
        this._syncTapeHeaders(span, now);
        for (const card of this.cards.values()) this._syncRowInlineChips(card);
    }

    _syncTapeHeaders(span, now = Date.now()) {
        const header = span?.header || 'LAST 10 MIN';
        const title = this._tapes?.title(now) || '';
        for (const sectionEl of this._sectionEls.values()) {
            const col = sectionEl._sectionRefs?.tapeCol;
            if (col) {
                this._setText(col, header);
                if (title) col.title = title;
            }
        }
    }

    _syncRowInlineChips(cardEl) {
        const refs = cardEl?._elements;
        if (!refs) return;
        const workChip = refs.nowWorkChip;
        if (workChip) {
            const text = cardEl._inlineWorkText || '';
            const show = Boolean(text) && !this._gridHasWork;
            workChip.hidden = !show;
            this._setText(workChip, text);
            workChip.title = cardEl._inlineWorkTitle || '';
            workChip.classList?.toggle?.('dash-card__now-chip--collision', Boolean(cardEl._inlineWorkCollision));
        }
        const kidsChip = refs.nowKidsChip;
        if (kidsChip) {
            const text = cardEl._inlineKidsText || '';
            const show = Boolean(text) && !this._gridHasKids;
            kidsChip.hidden = !show;
            this._setText(kidsChip, text);
            kidsChip.title = cardEl._inlineKidsTitle || '';
        }
    }

    _cachedToolHistory(agentId) {
        const local = this.toolHistories.get(agentId);
        if (Array.isArray(local)) return local;
        const agent = this.world?.agents?.get?.(agentId);
        const cached = agent ? sessionDetailsService.detailCacheState(agent)?.value?.toolHistory : null;
        return Array.isArray(cached) ? cached : null;
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

    // 7.12 + W4.4 — repaint tapes and project hours strips on 15 s bucket
    // boundaries while the Dashboard is visible; no rAF loop, and each tape
    // repaints only if its key changed.
    _startTapeClock() {
        this._stopTapeClock();
        const tick = () => {
            const now = Date.now();
            this._tapeTimer = setTimeout(tick, TAPE_BUCKET_MS - (now % TAPE_BUCKET_MS) + 20);
            this._hours?.cover(now);
            const span = this._tapes ? this._tapes.span(now) : tapeSpanForAge(0);
            const rowIds = [];
            for (const card of this.cards.values()) {
                this._paintCardTape(card, now);
                if (card.parentElement !== this._bellEl && card.dataset?.agentId) {
                    rowIds.push(card.dataset.agentId);
                }
            }
            if (this.gridEl && this._tapes) {
                this.gridEl.classList.toggle('dashboard__grid--has-tape', this._tapes.hasObservedActivity(rowIds, now));
                this.gridEl.classList.toggle('dashboard__grid--tape-5m', span.tier === '5m');
                this._syncTapeHeaders(span, now);
            }
            for (const [projectPath, sectionEl] of this._sectionEls) {
                this._paintSectionHours(sectionEl, projectPath, now);
            }
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
        const span = this._tapes.span(now);
        const cached = this._cachedToolHistory(id);
        const cachedSig = cached ? `${cached.length}:${cached.at(-1)?.ts || 0}` : '';
        const signature = `${this._tapes.signature(id, now)}|${cachedSig}`;
        if (canvas.width !== span.width) canvas.width = span.width;
        if (canvas._tapeSignature !== signature) {
            canvas._tapeSignature = signature;
            const cells = this._tapes.cells(id, now, { buckets: span.buckets });
            const ghostTicks = cached ? ghostTicksForTape(cached, now, { buckets: span.buckets }) : null;
            paintTape(canvas, cells, { ghostTicks });
        }
        if (this.gridEl
            && !this.gridEl.classList.contains('dashboard__grid--has-tape')
            && cardEl.parentElement !== this._bellEl
            && this._tapes.hasObservedActivity([id], now)) {
            this.gridEl.classList.add('dashboard__grid--has-tape');
            this.gridEl.classList.toggle('dashboard__grid--tape-5m', span.tier === '5m');
            this._syncTapeHeaders(span, now);
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
        }
        const history = this.toolHistories.get(id) || null;
        const hasObserved = this._tapes.hasObservedActivity([id], now);
        const signature = [
            this._tapes.signature(id, now),
            hasObserved ? '1' : '0',
            history ? toolHistorySignature(history, { limit: history.length, detailLength: 0 }) : 'pending',
        ].join('|');
        if (refs.stripCanvas._stripSignature === signature) return;
        refs.stripCanvas._stripSignature = signature;
        const { drawn, coveredFrom } = paintSessionStrip(refs.stripCanvas, this._tapes.cells(id, now), history || [], now);
        refs.strip.hidden = coveredFrom === null && !hasObserved;
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
            const project = projectKeyForAgent(agent);
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

    _showsFullRow(agent) {
        return childRowVisible(agent, {
            selectedId: this._selectedAgentId,
            filtered: Boolean(this._searchMatches || this._statusFilters.size || this._providerFilters.size),
            expandedLeads: this._expandedLeads,
            liveIds: this.world.agents,
        });
    }

    _crewSize(leadId) {
        let size = 0;
        for (const agent of this.world.agents.values()) if (leadIdFor(agent) === leadId) size++;
        return size;
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

    _needsFullRenderForAgent(agent) {
        const cardEl = this.cards.get(agent.id);
        const projectPath = this._projectKeyFor(agent);
        const status = normalizeStatus(agent.status);
        return !cardEl || cardEl._projectPath !== projectPath || cardEl._status !== status
            || cardEl._exceptionRank !== rowExceptionRank(agent) || cardEl._hasWork !== rowHasWork(agent);
    }

    _renderAgentUpdate(agent) {
        if (this._needsFullRenderForAgent(agent)) {
            this._queueFlush({ render: true });
            return;
        }
        const cardEl = this.cards.get(agent.id);
        this._updateCard(cardEl, agent);
    }

    // UI-3 — one render per message. A WebSocket message upserts every
    // changed agent synchronously, so the work queued here runs once, after
    // the last of them: a full render when a card must move, else only the
    // changed cards, dirty hours strips, and fleet-wide controls.
    _queueFlush({ render = false } = {}) {
        if (render) {
            this._flushRender = true;
            this._dirtyHoursProjects.clear();
        }
        if (this._flushQueued) return;
        this._flushQueued = true;
        queueMicrotask(() => {
            const full = this._flushRender;
            const dirtyHours = full ? null : [...this._dirtyHoursProjects];
            this._flushQueued = false;
            this._flushRender = false;
            this._dirtyHoursProjects.clear();
            if (!this.active || this._destroyed) return;
            if (full) {
                this.render();
                return;
            }
            if (dirtyHours?.length) {
                for (const project of dirtyHours) {
                    const sectionEl = this._sectionEls.get(project);
                    if (sectionEl) this._paintSectionHours(sectionEl, project);
                }
            }
            this._renderAttentionQueue(Array.from(this.world.agents.values()));
            this._syncAnswerFirst();
        });
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
        // UI-3 — two passes: every last rect is read before any card is
        // written, so the reads share one layout instead of forcing one per
        // card after the previous card's transform write.
        const lastRects = new Map([...firstRects.keys()].map(card => [card, card.getBoundingClientRect()]));
        const moved = [];
        for (const [card, first] of firstRects) {
            const last = lastRects.get(card);
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

        const initialTapeHeader = this._tapes?.span()?.header || 'LAST 5 MIN';
        section.innerHTML = `
            <div class="dashboard__section-header">
                <span class="dashboard__pennant" aria-hidden="true"></span>
                <span class="dashboard__section-name"></span>
                <span class="dashboard__section-path"></span>
                <canvas class="dashboard__hours-strip" width="${HOURS_STRIP_WIDTH}" height="${HOURS_STRIP_HEIGHT}" aria-hidden="true"></canvas>
                <span class="dashboard__section-health" aria-label="Project health"></span>
                <span class="dashboard__section-lift" hidden></span>
                <button type="button" class="dashboard__section-harbor" hidden></button>
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
                <span class="dashboard__col--tape" title="${this._tapes?.title() || ''}">${initialTapeHeader}</span>
                <span class="dashboard__col--num">FOR</span>
                <span class="dashboard__col--num" title="New tokens (input, output, cache writes), as the top bar counts them; cache reads below">TOKENS</span>
                <span class="dashboard__col--num" title="≈ cost includes estimated usage (token counts x published rates); — no usage reported">COST</span>
                <span class="dashboard__col--work">WORKING SET</span>
                <span class="dashboard__col--kids">CHILDREN</span>
            </div>
            <div class="dashboard__section-grid"></div>
        `;
        const health = section.querySelector('.dashboard__section-health');
        section._sectionRefs = {
            name: section.querySelector('.dashboard__section-name'),
            path: section.querySelector('.dashboard__section-path'),
            hoursCanvas: section.querySelector('.dashboard__hours-strip'),
            tapeCol: section.querySelector('.dashboard__col--tape'),
            count: section.querySelector('.dashboard__section-count'),
            lift: section.querySelector('.dashboard__section-lift'),
            harbor: section.querySelector('.dashboard__section-harbor'),
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
        section._sectionRefs.harbor.addEventListener('click', (event) => {
            event.stopPropagation();
            const target = section._harborTarget;
            if (target) eventBus.emit(HARBOR_FOCUS_FLEET_EVENT, target);
        });
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

        this._updateSectionHealth(sectionEl, refs, [...agents, ...laneAgents]);
        sectionEl._harborAgents = [...agents, ...laneAgents];
        this._updateSectionHarbor(sectionEl, projectPath, sectionEl._harborAgents);
        this._paintSectionHours(sectionEl, projectPath);
    }

    _paintSectionHours(sectionEl, projectPath, now = Date.now()) {
        const canvas = sectionEl?._sectionRefs?.hoursCanvas;
        if (!canvas || !this._hours) return;
        const signature = this._hours.signature(projectPath, now);
        if (canvas._hoursSignature === signature) return;
        canvas._hoursSignature = signature;
        const hours = this._hours.hoursFor(projectPath, now);
        paintHoursStripCanvas(canvas, hours);
        const covered = hours.filter(cell => cell.covered);
        const calls = covered.reduce((sum, cell) => sum + cell.act + cell.look, 0);
        const commits = covered.reduce((sum, cell) => sum + cell.commits, 0);
        const pushes = covered.reduce((sum, cell) => sum + cell.pushes, 0);
        const summary = [
            `Today (24h · ${covered.length}h covered)`,
            `${calls} observed ${calls === 1 ? 'call' : 'calls'}`,
            commits ? `${commits} verified ${commits === 1 ? 'commit' : 'commits'}` : '',
            pushes ? `${pushes} verified ${pushes === 1 ? 'push' : 'pushes'}` : '',
        ].filter(Boolean).join(' · ');
        canvas.title = `${summary} · uncovered hours blank`;
    }

    // The lane's harbor chip: its repo's ledger, narrowed to the branches
    // its agents are on when any of them has cargo. A failure wins the chip.
    _updateSectionHarbor(sectionEl, projectPath, agents = []) {
        const chip = sectionEl._sectionRefs?.harbor;
        if (!chip) return;
        const repoRoot = agents.find(agent => agent?.repoRoot)?.repoRoot || projectPath;
        const now = Date.now();
        const group = harborLedger(this._harborRepos.filter(row => row?.project === repoRoot), { now }).groups[0] || null;
        const branches = new Set(agents.map(agent => normalizeRepoBranch(agent?.gitBranch)).filter(Boolean));
        const ownLanes = group?.lanes.filter(lane => branches.has(lane.branch)) || [];
        const lanes = ownLanes.length ? ownLanes : (group?.lanes || []);
        const count = lanes.reduce((sum, lane) => sum + lane.count, 0);
        // A standing failure anywhere in the repo wins the chip.
        const failure = group?.failure || null;
        if (!group || (!count && !failure)) {
            chip.hidden = true;
            sectionEl._harborTarget = null;
            return;
        }
        const single = lanes.length === 1 ? lanes[0] : null;
        const where = single ? middleTruncate(single.branch || 'detached', 18) : `${lanes.length} branches`;
        const text = failure ? ledgerFailureText({ ...failure, reason: '' }, now) : `${count} unpushed · ${where}`;
        this._setText(chip, text);
        chip.hidden = false;
        chip.classList.toggle('dashboard__section-harbor--failed', Boolean(failure));
        chip.title = `${group.name} · ${where}: ${count} unpushed${failure?.reason ? ` - ${failure.reason}` : ''} - show the fleet`;
        sectionEl._harborTarget = { project: repoRoot, branch: single ? single.branch : null };
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
                        <span class="dash-card__branch"></span>
                        <span class="dash-card__role"></span>
                        <span class="dash-card__workflow-badge" style="display: none"></span>
                    </span>
                </span>
                <span class="dash-card__now">
                    <span class="dash-card__now-icon" aria-hidden="true"></span>
                    <span class="dash-card__phase"></span>
                    <span class="dash-card__silent" hidden></span>
                    <span class="dash-card__phase-detail"></span>
                    <span class="dash-card__now-chips">
                        <span class="dash-card__now-chip dash-card__now-chip--work" hidden></span>
                        <span class="dash-card__now-chip dash-card__now-chip--kids" hidden></span>
                    </span>
                </span>
                <span class="dash-card__tape"></span>
                <span class="dash-card__for"></span>
                <span class="dash-card__usage-tokens"><span class="dash-card__usage-new"></span><span class="dash-card__usage-cache"></span></span>
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
                    <button type="button" class="dash-card__open-external" style="display: none" title="Open in Hobotnica ↗" aria-label="Open in Hobotnica">Open in Hobotnica ↗</button>
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

        // 7.12 + W4.4 — observed-call tape, painted on whole pixels (80 px
        // under 5 min, 160 px from 5 min onward).
        const tapeSpan = this._tapes?.span() || tapeSpanForAge(0);
        const tapeCanvas = document.createElement('canvas');
        tapeCanvas.width = tapeSpan.width || TAPE_SHORT_WIDTH;
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
        const openExternalBtn = card.querySelector('.dash-card__open-external');
        openExternalBtn.addEventListener('click', (event) => {
            event.stopPropagation();
            const current = this.world.agents.get(card.dataset.agentId);
            if (current?.hobotnica?.threadId) this._onFocusExternal?.(current);
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
            niche: card.querySelector('.dash-card__niche'),
            name: card.querySelector('.dash-card__name'),
            model: card.querySelector('.dash-card__model'),
            branch: card.querySelector('.dash-card__branch'),
            workflowBadge: card.querySelector('.dash-card__workflow-badge'),
            parentChip: card.querySelector('.dash-card__parent-chip'),
            teamBadge: card.querySelector('.dash-card__team-badge'),
            role: card.querySelector('.dash-card__role'),
            activityAge: card.querySelector('.dash-card__activity-age'),
            providerBadge: card.querySelector('.dash-card__provider-badge'),
            detailStatus: card.querySelector('.dash-card__detail-status'),
            signalSource: card.querySelector('.dash-card__signal-source'),
            openExternal: openExternalBtn,
            staleBadge: card.querySelector('.dash-card__stale-badge'),
            detail: card.querySelector('.dash-card__detail'),
            heroSlot: card.querySelector('.dash-card__hero-slot'),
            now: card.querySelector('.dash-card__now'),
            nowIcon: card.querySelector('.dash-card__now-icon'),
            phase: card.querySelector('.dash-card__phase'),
            phaseDetail: card.querySelector('.dash-card__phase-detail'),
            nowWorkChip: card.querySelector('.dash-card__now-chip--work'),
            nowKidsChip: card.querySelector('.dash-card__now-chip--kids'),
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
            usageNew: card.querySelector('.dash-card__usage-new'),
            silent: card.querySelector('.dash-card__silent'),
            usageCache: card.querySelector('.dash-card__usage-cache'),
            usageCost: card.querySelector('.dash-card__usage-cost'),
            buildingEmblem: card.querySelector('.dash-card__building-emblem'),
            strip: card.querySelector('.dash-card__strip'),
            stripCount: card.querySelector('.dash-card__strip-count'),
            stripAxis: card.querySelector('.dash-card__strip-axis'),
            stripCanvas: null,
            call: null,
        };
        this._bindCardElapsedSubscriptions(card);
        this._paintCardTape(card);

        return card;
    }

    _bindCardElapsedSubscriptions(card) {
        if (!card || !this.active) return;
        if (!card._elapsedUnsubscribe && card._elements?.forCell) {
            card._elapsedUnsubscribe = subscribeElapsedText(card._elements.forCell, (now) => {
                const current = this.world.agents.get(card.dataset.agentId);
                const ms = statusSinceMs(current, now);
                return ms == null ? '—' : formatElapsed(ms);
            });
        }
        // UI-5 — `silent 18m` rides in NOW on the shared 1 Hz tick, so a hung
        // tool is raised even when no message arrives to re-render the row.
        const silentEl = card._elements?.silent;
        if (!card._silentUnsubscribe && silentEl) {
            card._silentUnsubscribe = subscribeElapsedText(silentEl, (now) => {
                const signal = silentSignal(this.world.agents.get(card.dataset.agentId), now);
                silentEl.hidden = !signal;
                if (signal) silentEl.dataset.tier = String(signal.tier);
                else delete silentEl.dataset.tier;
                return signal?.text || '';
            });
        }
        this._bindCallElapsedSubscription(card);
    }

    _bindCallElapsedSubscription(cardEl) {
        const refs = cardEl?._elements?.call;
        if (!refs?.elapsed || !this.active || cardEl._callElapsedUnsubscribe) return;
        // 9.10 — the age tier comes from the same elapsed time the clock
        // prints, so the plate can never disagree with its numeral.
        cardEl._callElapsedUnsubscribe = subscribeElapsedText(refs.elapsed, (now) => {
            const ms = statusSinceMs(this.world.agents.get(cardEl.dataset.agentId), now);
            const age = ms == null || ms < AGE_RIM_MS ? '0' : (ms < AGE_FILL_MS ? '1' : '2');
            if (cardEl.dataset.age !== age) cardEl.dataset.age = age;
            return ms == null ? '—' : formatClock(ms);
        });
    }

    _unbindCardElapsedSubscriptions(cardEl) {
        if (!cardEl) return;
        cardEl._elapsedUnsubscribe?.();
        cardEl._elapsedUnsubscribe = null;
        cardEl._callElapsedUnsubscribe?.();
        cardEl._callElapsedUnsubscribe = null;
        cardEl._silentUnsubscribe?.();
        cardEl._silentUnsubscribe = null;
    }

    _pauseCardElapsedSubscriptions() {
        for (const cardEl of this.cards.values()) this._unbindCardElapsedSubscriptions(cardEl);
    }

    _resumeCardElapsedSubscriptions() {
        for (const cardEl of this.cards.values()) this._bindCardElapsedSubscriptions(cardEl);
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
        // W4.4 (§4.9) — right-aligned Bell Lane footer action `LOCATE IN WORLD ▸`
        // placed as a sibling after `.dash-card__select` (still inside the
        // `cv-frame--attn` border on `.dash-card`) so there is never a nested
        // interactive `<button>` inside `<button>`.
        const footer = document.createElement('div');
        footer.className = 'dash-card__call-footer';
        const callOpenExternalBtn = document.createElement('button');
        callOpenExternalBtn.type = 'button';
        callOpenExternalBtn.className = 'dash-card__call-external';
        callOpenExternalBtn.textContent = 'Open in Hobotnica ↗';
        callOpenExternalBtn.title = 'Open in Hobotnica ↗';
        callOpenExternalBtn.setAttribute('aria-label', 'Open in Hobotnica');
        callOpenExternalBtn.style.display = 'none';
        callOpenExternalBtn.addEventListener('click', (event) => {
            event.stopPropagation();
            const current = this.world?.agents?.get?.(cardEl.dataset.agentId);
            if (current?.hobotnica?.threadId) this._onFocusExternal?.(current);
        });
        footer.appendChild(callOpenExternalBtn);
        const locateBtn = document.createElement('button');
        locateBtn.type = 'button';
        locateBtn.className = 'dash-card__call-locate';
        locateBtn.appendChild(document.createTextNode('LOCATE IN WORLD'));
        // Press Start 2P lacks U+25B8 (`▸`); keep the glyph span hidden visually
        // and render a crisp 4x7 pixel-art SVG chevron alongside the label.
        const locateGlyph = document.createElement('span');
        locateGlyph.className = 'dash-card__call-locate-glyph';
        locateGlyph.setAttribute('aria-hidden', 'true');
        locateGlyph.textContent = ' ▸';
        locateBtn.appendChild(locateGlyph);
        const locateArrow = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        locateArrow.setAttribute('class', 'dash-card__call-locate-arrow');
        locateArrow.setAttribute('viewBox', '0 0 4 7');
        locateArrow.setAttribute('width', '4');
        locateArrow.setAttribute('height', '7');
        locateArrow.setAttribute('aria-hidden', 'true');
        locateArrow.setAttribute('focusable', 'false');
        locateArrow.setAttribute('shape-rendering', 'crispEdges');
        const locatePath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        locatePath.setAttribute('fill', 'currentColor');
        locatePath.setAttribute('d', 'M0 0h1v7H0zM1 1h1v5H1zM2 2h1v3H2zM3 3h1v1H3z');
        locateArrow.appendChild(locatePath);
        locateBtn.appendChild(locateArrow);
        locateBtn.title = 'Switch to World and frame this agent (A)';
        locateBtn.addEventListener('click', (event) => {
            event.stopPropagation();
            const current = this.world?.agents?.get?.(cardEl.dataset.agentId);
            if (current) this._locateInWorld(current);
        });
        footer.appendChild(locateBtn);
        cardEl._elements.select.after(footer);
        const refs = {
            root: call,
            footer,
            openExternal: callOpenExternalBtn,
            locate: locateBtn,
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
        this._bindCallElapsedSubscription(cardEl);
        return refs;
    }

    _updateCallBlock(cardEl, agent) {
        const refs = this._ensureCallBlock(cardEl);
        this._mountHero(cardEl, agent, refs.hero);
        const model = modelPresentation(agent);
        const provider = providerPresentation(agent.provider, model.identity);
        const project = shortProjectName(projectKeyForAgent(agent), i18n.t('unknownProject'));
        this._setText(refs.name, agent.name || agent.id);
        const providerEl = document.createElement('span');
        providerEl.className = 'dash-card__call-provider';
        providerEl.textContent = provider.badge.label;
        providerEl.style.color = provider.badge.color;
        refs.meta.replaceChildren(
            providerEl,
            document.createTextNode([model.label === provider.badge.label ? '' : model.label, mcpJobLabel(agent) || agent.role || '', project]
                .filter(Boolean).map(text => ` · ${text}`).join('')),
        );
        refs.meta.title = `${provider.badge.label} · ${model.title || agent.model || ''} · ${agent.projectPath || ''}`;

        const status = normalizeStatus(agent.status);
        this._setText(refs.blocker, `${BELL_STATUS_WORD[status] || statusWord(status)} — ${blockerText(agent)}`);
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
        if (refs.openExternal) {
            refs.openExternal.style.display = agent?.hobotnica?.threadId ? '' : 'none';
        }
        if (refs.locate) {
            refs.locate.setAttribute('aria-label', `Locate ${agent.name || agent.id} in World`);
        }
    }

    _locateInWorld(agent) {
        if (!agent || this._destroyed) return;
        eventBus.emit(DASHBOARD_LOCATE_IN_WORLD_EVENT, { agentId: agent.id, agent });
        if (this._onLocateInWorld) {
            this._onLocateInWorld(agent);
            return;
        }
        document.getElementById('btnModeCharacter')?.click?.();
        if (this._frameAttention) {
            this._frameAttention(agent);
        } else if (typeof KeyboardEvent === 'function' && typeof document?.dispatchEvent === 'function') {
            document.dispatchEvent(new KeyboardEvent('keydown', {
                key: 'a',
                code: 'KeyA',
                bubbles: true,
                cancelable: true,
            }));
        }
        emitAgentSelected(agent);
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
        if (signature === this._controlsSignature) {
            this._syncAttentionLayout();
            return;
        }
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
        const statusGroup = document.createElement('div');
        statusGroup.className = 'dashboard-attention__group dashboard-attention__group--status';
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
            statusGroup.appendChild(button);
        }
        list.appendChild(statusGroup);

        let providerLabel = null;
        let providerGroup = null;
        const hasFilters = Boolean(this._statusFilters.size || this._providerFilters.size);
        if (providers.length || hasFilters || this._searchQuery) {
            if (providers.length) {
                providerLabel = document.createElement('span');
                providerLabel.className = 'dashboard-attention__provider-label';
                providerLabel.textContent = 'Provider';
                providerLabel.setAttribute('role', 'separator');
                list.appendChild(providerLabel);
            }
            providerGroup = document.createElement('div');
            providerGroup.className = 'dashboard-attention__group dashboard-attention__group--providers';
            for (const provider of providers) {
                const info = providerPresentation(provider);
                const button = this._filterButton({
                    key: `provider:${provider}`,
                    label: '',
                    pressed: this._providerFilters.has(provider),
                    onClick: () => {
                        if (this._providerFilters.has(provider)) this._providerFilters.delete(provider);
                        else this._providerFilters.add(provider);
                        this._controlsSignature = '';
                        this.render();
                    },
                });
                button.classList.add('dashboard-attention__item--provider');
                // W4.4 (§4.9) — 2x6 px guild-material color bar before each provider's count.
                const pip = document.createElement('i');
                pip.className = 'dashboard-attention__provider-pip';
                pip.setAttribute('aria-hidden', 'true');
                pip.style.backgroundColor = info.badge.color;
                const countEl = document.createElement('b');
                countEl.textContent = String(providerCounts[provider]);
                button.append(pip, document.createTextNode(`${info.badge.label} `), countEl);
                providerGroup.appendChild(button);
            }
            if (hasFilters) {
                providerGroup.appendChild(this._filterButton({
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
                providerGroup.appendChild(search);
            }
            list.appendChild(providerGroup);
        }
        // 7.11 — one legend replaces the per-row ESTIMATE / UNAVAILABLE pills.
        // Sheds first on overflow (note also lives on the COST header tooltip).
        const legend = document.createElement('span');
        legend.className = 'dashboard-attention__legend';
        legend.append(
            Object.assign(document.createElement('span'), { textContent: '≈ includes estimates' }),
            Object.assign(document.createElement('span'), { textContent: '— unavailable' }),
        );
        legend.title = '≈ cost includes estimated usage (token counts x published rates); — no usage reported';
        replaceChildren(this.attentionEl, [heading, list, legend]);
        this._attentionRefs = { heading, list, statusGroup, providerLabel, providerGroup, legend };
        this._syncAttentionLayout();
        if (focusedKey) {
            [...this.attentionEl.querySelectorAll('[data-filter-key]')]
                .find(button => button.dataset.filterKey === focusedKey)
                ?.focus({ preventScroll: true });
        }
    }

    // Shed the legend first when the tally bar runs tight, then stack the
    // provider chips cleanly below the status row instead of clipping them,
    // and publish the bar's height so sticky section headers stay aligned.
    // Account limit cards live in `.dashboard-quota-rail`, so filter chips
    // get the full width of `.dashboard-attention`.
    _syncAttentionLayout() {
        const bar = this.attentionEl;
        const refs = this._attentionRefs;
        if (!bar || bar.hidden || !refs) return;
        const barWidth = Number(bar.clientWidth) || 0;
        if (barWidth <= 0) return;

        const { heading, list, statusGroup, providerLabel, providerGroup, legend, quotaCards = [] } = refs;
        const childWidth = (el) => {
            if (!el) return 0;
            return Math.ceil(el.getBoundingClientRect?.().width || el.offsetWidth || 0);
        };
        const groupWidth = (group) => {
            if (!group) return 0;
            const items = [...(group.children || [])];
            if (!items.length) return 0;
            let total = 0;
            for (const item of items) {
                total += childWidth(item);
                if (item.classList?.contains('dashboard-attention__search')) total += 12;
            }
            return total + Math.max(0, items.length - 1) * 2;
        };

        if (legend._naturalWidth == null) {
            legend.hidden = false;
            legend._naturalWidth = childWidth(legend);
        }
        const barInner = barWidth - 32; // 16px horizontal padding each side
        const fixedItems = [heading, ...quotaCards];
        const fixedWidth = fixedItems.reduce((sum, el) => sum + childWidth(el), 0);
        const statusWidth = groupWidth(statusGroup);
        const providerWidth = groupWidth(providerGroup);
        const dividerWidth = providerLabel ? 17 : 0; // 1px rule + 8px margin each side
        const listSingleRow = statusWidth + (providerGroup ? dividerWidth + providerWidth : 0);

        const gapsWithLegend = (fixedItems.length + 1) * 16;
        const fitsWithLegend = (fixedWidth + listSingleRow + legend._naturalWidth + gapsWithLegend) <= barInner;
        legend.hidden = !fitsWithLegend;

        const gapsNow = (fixedItems.length + (fitsWithLegend ? 1 : 0)) * 16;
        const listAvailable = barInner - fixedWidth - (fitsWithLegend ? legend._naturalWidth : 0) - gapsNow;
        const wrapped = Boolean(providerGroup) && listSingleRow > listAvailable;
        if (providerLabel) providerLabel.hidden = wrapped;
        list.classList.toggle('dashboard-attention__list--wrapped', wrapped);

        const barHeight = Math.round(bar.getBoundingClientRect?.().height || bar.offsetHeight || 40);
        this._setCustomProperty(this.gridEl?.parentElement, '--dash-attention-height', `${barHeight}px`);
    }

    _ensureQuotaRail() {
        if (this.quotaRailEl) return this.quotaRailEl;
        const existing = typeof document !== 'undefined'
            ? document.getElementById?.('dashboardQuotaRail')
            : null;
        if (existing) {
            this.quotaRailEl = existing;
            return existing;
        }
        if (typeof document === 'undefined' || typeof document.createElement !== 'function') return null;
        const rail = document.createElement('section');
        rail.id = 'dashboardQuotaRail';
        rail.className = 'dashboard-quota-rail';
        rail.setAttribute('aria-label', 'Account weekly limits');
        rail.hidden = true;
        const parent = this.attentionEl?.parentElement || this.gridEl?.parentElement || null;
        if (this.attentionEl && typeof this.attentionEl.after === 'function' && parent) {
            this.attentionEl.after(rail);
        } else if (parent && typeof parent.insertBefore === 'function') {
            const ref = this.gridEl && this.gridEl.parentElement === parent ? this.gridEl : null;
            parent.insertBefore(rail, ref);
        } else if (parent && typeof parent.appendChild === 'function') {
            parent.appendChild(rail);
        }
        this.quotaRailEl = rail;
        return rail;
    }

    _clearQuotaRailSubscriptions() {
        if (!Array.isArray(this._quotaRailUnsubscribes)) return;
        for (const unsub of this._quotaRailUnsubscribes) {
            try { unsub(); } catch { /* ignore */ }
        }
        this._quotaRailUnsubscribes.length = 0;
    }

    _subscribeQuotaElapsed(node, formatter) {
        const unsub = subscribeElapsedText(node, formatter);
        if (Array.isArray(this._quotaRailUnsubscribes)) {
            this._quotaRailUnsubscribes.push(unsub);
        }
        return unsub;
    }

    _quotaResetFact(part, resetsAtMs) {
        const reset = part('dashboard-quota__fact');
        reset.dataset.resetsAt = String(resetsAtMs);
        this._subscribeQuotaElapsed(reset, now => formatResetCountdown(resetsAtMs, now));
        return reset;
    }

    _quotaAgeFact(part, observedAtMs) {
        const age = part('dashboard-quota__age');
        age.dataset.observedAt = String(observedAtMs);
        this._subscribeQuotaElapsed(age, now => `${formatWaitAge(Math.max(0, now - observedAtMs))} ago`);
        return age;
    }

    _tickResetCountdowns(now = Date.now()) {
        if (!this.quotaRailEl || typeof this.quotaRailEl.querySelectorAll !== 'function') return;
        for (const node of this.quotaRailEl.querySelectorAll('[data-resets-at]')) {
            const resetsAt = Number(node.dataset?.resetsAt);
            if (!Number.isFinite(resetsAt) || resetsAt <= 0) continue;
            const next = formatResetCountdown(resetsAt, now);
            if (node.textContent !== next) node.textContent = next;
        }
        for (const node of this.quotaRailEl.querySelectorAll('[data-observed-at]')) {
            const observedAt = Number(node.dataset?.observedAt);
            if (!Number.isFinite(observedAt) || observedAt <= 0) continue;
            const next = `${formatWaitAge(Math.max(0, now - observedAt))} ago`;
            if (node.textContent !== next) node.textContent = next;
        }
    }

    _renderQuotaRail(usage = this._latestUsage) {
        const rail = this._ensureQuotaRail();
        if (!rail) return;
        const signature = JSON.stringify(quotaCardsSignature(usage));
        if (signature === this._quotaRailSignature && rail._renderedOnce) return;
        this._quotaRailSignature = signature;
        rail._renderedOnce = true;

        this._clearQuotaRailSubscriptions();
        const cards = [
            this._claudeLimitCard(usage),
            this._codexQuotaCard(usage),
            this._glmQuotaCard(usage),
            this._antigravityQuotaCard(usage),
        ].filter(Boolean);

        if (cards.length === 0) {
            replaceChildren(rail, []);
            rail.hidden = true;
            return;
        }
        const eyebrow = document.createElement('div');
        eyebrow.className = 'dashboard-quota-rail__eyebrow';
        eyebrow.textContent = 'WEEKLY LIMITS';
        replaceChildren(rail, [eyebrow, ...cards]);
        rail.hidden = false;
    }

    // Build a compact Quota Rail card head that never clips at 1280px:
    //   - Provider label (`CLAUDE` / `CODEX` / `GLM` / `ANTIGRAVITY`)
    //   - Optional non-weekly window tag (e.g. `5H` fallback only; rail eyebrow carries `WEEKLY LIMITS`)
    //   - Priority status badge (`LIMIT`, `WARNING`, or HTTP error code) placed prominently
    //   - Crisp 12-segment `% left` gauge + explicit `<N>% left` reading
    _quotaCardHead(part, { label, color, windowLabel, lit, leftText, limitWord = '', errorStatus = null, muted = false }) {
        const provider = part('dashboard-quota__provider', label);
        provider.style.color = color;
        const head = [provider];
        if (windowLabel && windowLabel !== 'weekly') {
            head.push(part('dashboard-quota__window', windowLabel.toUpperCase()));
        }
        if (limitWord) {
            head.push(part('dashboard-quota__word', limitWord));
        } else if (muted && errorStatus) {
            head.push(part('dashboard-quota__err-badge', String(errorStatus)));
        }
        const gauge = part('dashboard-quota__gauge');
        for (let index = 0; index < GAUGE_SEGMENTS; index++) gauge.appendChild(part(index < lit ? 'on' : ''));
        head.push(gauge);
        // When LIMIT already sits on the head row, keep `0% left` as the leading
        // subline fact so `ANTIGRAVITY LIMIT [gauge]` never overflows at 1280px.
        if (!limitWord || label.length <= 6) {
            head.push(part('dashboard-quota__used', leftText));
        }
        return head;
    }

    // The Codex account card in the Quota Rail: `CODEX [gauge] 56% left` over
    // `Resets 4d 2h · 5h 82% left` (credits, credit delta, and age ride in the tooltip).
    _codexQuotaCard(usage = this._latestUsage) {
        const facts = codexQuotaFacts(usage?.codex);
        if (!facts) return null;
        const part = (className, text = '') => Object.assign(document.createElement('span'), { className, textContent: text });
        const card = part(`dashboard-quota dashboard-quota--codex${facts.limit ? ' dashboard-quota--limit' : ''}${facts.muted ? ' dashboard-quota--muted' : ''}`);
        card.dataset.provider = 'codex';
        const tipParts = ['Codex Weekly'];
        if (facts.leftPercent !== null) tipParts.push(`${facts.leftText} (${facts.usedText} used)`);
        if (facts.fiveHourText) {
            const reset = facts.fiveHourResetsAt ? ` (${formatResetCountdown(facts.fiveHourResetsAt)})` : '';
            tipParts.push(`${facts.fiveHourText}${reset}`);
        }
        if (facts.credits) tipParts.push(facts.credits);
        if (facts.creditChange) tipParts.push(facts.creditChange);
        if (facts.observedAt) tipParts.push(`observed ${formatWaitAge(Math.max(0, Date.now() - facts.observedAt))} ago`);
        tipParts.push('Codex villagers keep their own status.');
        card.title = tipParts.join(' · ');

        const label = providerPresentation('codex').badge.label.toUpperCase();
        const head = this._quotaCardHead(part, {
            label,
            color: providerPresentation('codex').badge.color,
            windowLabel: facts.windowLabel,
            lit: facts.lit,
            leftText: facts.leftText,
            limitWord: facts.limit ? bucketWord('quota', 'upper') : '',
            muted: facts.muted,
        });
        const facts2 = [];
        if (facts.muted) {
            facts2.push(part('dashboard-quota__fact', 'Unavailable'));
            if (facts.fiveHourText) facts2.push(part('dashboard-quota__fact', facts.fiveHourText));
        } else {
            if (facts.resetsAt) facts2.push(this._quotaResetFact(part, facts.resetsAt));
            if (facts.fiveHourText) facts2.push(part('dashboard-quota__fact', facts.fiveHourText));
            else if (facts.credits) facts2.push(part('dashboard-quota__fact', facts.credits));
        }
        card.append(quotaRows(part, head, facts2));
        return card;
    }

    // The Claude account card in the Quota Rail: `CLAUDE [gauge] 62% left` over
    // `Resets 3d 4h · 5h 82% left` (errors always lead FIRST so they never clip).
    _claudeLimitCard(usage = this._latestUsage) {
        const facts = claudeQuotaFacts(usage);
        if (!facts) return null;
        const part = (className, text = '') => Object.assign(document.createElement('span'), { className, textContent: text });
        const card = part(`dashboard-quota dashboard-quota--claude${facts.warn ? ' dashboard-quota--limit' : ''}${facts.muted ? ' dashboard-quota--muted' : ''}`);
        card.dataset.provider = 'claude';
        const tipParts = ['Claude Weekly'];
        if (facts.leftPercent !== null) tipParts.push(`${facts.windowLabel} ${facts.leftText} (${facts.usedText} used)`);
        if (facts.fiveHourText) {
            const fiveHourReset = facts.fiveHourResetsAt ? ` (${formatResetCountdown(facts.fiveHourResetsAt)})` : '';
            tipParts.push(`${facts.fiveHourText}${fiveHourReset}`);
        }
        if (facts.errorStatus === 401) tipParts.push('stored token expired (401); run `claude` to refresh');
        else if (facts.errorStatus === 403) tipParts.push('auth rejected (403)');
        else if (facts.errorStatus === 429) tipParts.push('check throttled (429); backing off');
        tipParts.push('Claude villagers keep their own status.');
        card.title = tipParts.join(' · ');

        const label = providerPresentation('claude').badge.label.toUpperCase();
        const head = this._quotaCardHead(part, {
            label,
            color: providerPresentation('claude').badge.color,
            windowLabel: facts.windowLabel,
            lit: facts.lit,
            leftText: facts.leftText,
            limitWord: facts.badgeWord,
            errorStatus: facts.errorStatus,
            muted: facts.muted,
        });
        const facts2 = [];
        const errorText = formatQuotaErrorStatus(facts.errorStatus);
        if (errorText) facts2.push(part('dashboard-quota__fact dashboard-quota__fact--error', errorText));
        if (facts.muted && !errorText) facts2.push(part('dashboard-quota__fact', 'Unavailable'));
        if (facts.resetsAt) facts2.push(this._quotaResetFact(part, facts.resetsAt));
        if (!errorText && facts.fiveHourText) facts2.push(part('dashboard-quota__fact', facts.fiveHourText));
        card.append(quotaRows(part, head, facts2));
        return card;
    }

    // The GLM / z.AI account card in the Quota Rail: `GLM [gauge] 59% left` over
    // `Resets 3d 4h · 5h 91% left` (plan & credit allowance live in the tooltip).
    _glmQuotaCard(usage = this._latestUsage) {
        const facts = glmQuotaFacts(usage?.glm);
        if (!facts) return null;
        const part = (className, text = '') => Object.assign(document.createElement('span'), { className, textContent: text });
        const card = part(`dashboard-quota dashboard-quota--glm${facts.limit ? ' dashboard-quota--limit' : ''}${facts.muted ? ' dashboard-quota--muted' : ''}`);
        card.dataset.provider = 'glm';
        const tipParts = ['GLM Weekly (z.AI)'];
        if (facts.plan) tipParts.push(`plan ${facts.plan}`);
        if (facts.leftPercent !== null) tipParts.push(`${facts.windowLabel} ${facts.leftText} (${facts.usedText} used)`);
        if (facts.usedCredits !== null && facts.limitCredits !== null) {
            tipParts.push(`${facts.usedCredits.toLocaleString('en-US', { maximumFractionDigits: 1 })} / ${facts.limitCredits.toLocaleString('en-US', { maximumFractionDigits: 1 })}`);
        }
        if (facts.fiveHourText) {
            const fiveHourReset = facts.fiveHourResetsAt ? ` (${formatResetCountdown(facts.fiveHourResetsAt)})` : '';
            tipParts.push(`${facts.fiveHourText}${fiveHourReset}`);
        }
        if (facts.observedAt) tipParts.push(`observed ${formatWaitAge(Math.max(0, Date.now() - facts.observedAt))} ago`);
        const errorText = formatQuotaErrorStatus(facts.errorStatus);
        if (errorText) tipParts.push(errorText);
        card.title = tipParts.join(' · ');

        const head = this._quotaCardHead(part, {
            label: 'GLM',
            color: providerPresentation('zai').badge.color,
            windowLabel: facts.windowLabel,
            lit: facts.lit,
            leftText: facts.leftText,
            limitWord: facts.limit ? bucketWord('quota', 'upper') : '',
            errorStatus: facts.errorStatus,
            muted: facts.muted,
        });
        const facts2 = [];
        if (errorText) facts2.push(part('dashboard-quota__fact dashboard-quota__fact--error', errorText));
        if (facts.muted && !errorText) facts2.push(part('dashboard-quota__fact', 'Unavailable'));
        if (facts.resetsAt) facts2.push(this._quotaResetFact(part, facts.resetsAt));
        if (!errorText && facts.fiveHourText) facts2.push(part('dashboard-quota__fact', facts.fiveHourText));
        card.append(quotaRows(part, head, facts2));
        return card;
    }

    // The Antigravity Weekly account card in the Quota Rail:
    // `ANTIGRAVITY [gauge] 77% left` over `Resets 2d 5h · 3P 88% left`.
    // Gemini models scope, both 5h windows, source, and observed age live in the tooltip.
    _antigravityQuotaCard(usage = this._latestUsage) {
        const facts = antigravityQuotaFacts(usage?.antigravity);
        if (!facts) return null;
        const part = (className, text = '') => Object.assign(document.createElement('span'), { className, textContent: text });
        const card = part(`dashboard-quota dashboard-quota--antigravity${facts.limit ? ' dashboard-quota--limit' : ''}${facts.muted ? ' dashboard-quota--muted' : ''}`);
        card.dataset.provider = 'antigravity';
        const tipParts = ['Antigravity Weekly'];
        tipParts.push(`Gemini models ${facts.leftText}`);
        if (facts.sharedWeeklyText) {
            const sharedReset = facts.sharedWeeklyResetsAt ? ` (${formatResetCountdown(facts.sharedWeeklyResetsAt)})` : '';
            tipParts.push(`3P shared ${facts.sharedWeeklyLeft}% left${sharedReset}`);
        }
        if (facts.geminiFiveHourText) {
            const reset = facts.geminiFiveHourResetsAt ? ` (${formatResetCountdown(facts.geminiFiveHourResetsAt)})` : '';
            tipParts.push(`${facts.geminiFiveHourText}${reset}`);
        }
        if (facts.sharedFiveHourText) {
            const reset = facts.sharedFiveHourResetsAt ? ` (${formatResetCountdown(facts.sharedFiveHourResetsAt)})` : '';
            tipParts.push(`${facts.sharedFiveHourText}${reset}`);
        }
        if (facts.source) tipParts.push(`source ${facts.source}`);
        if (facts.observedAt) tipParts.push(`observed ${formatWaitAge(Math.max(0, Date.now() - facts.observedAt))} ago`);
        const errorText = formatQuotaErrorStatus(facts.errorStatus);
        if (errorText) tipParts.push(errorText);
        card.title = tipParts.join(' · ');

        const label = providerPresentation('antigravity').badge.label.toUpperCase();
        const head = this._quotaCardHead(part, {
            label,
            color: providerPresentation('antigravity').badge.color,
            windowLabel: facts.windowLabel,
            lit: facts.lit,
            leftText: facts.leftText,
            limitWord: facts.limit ? bucketWord('quota', 'upper') : '',
            errorStatus: facts.errorStatus,
            muted: facts.muted,
        });
        const facts2 = [];
        if (errorText) facts2.push(part('dashboard-quota__fact dashboard-quota__fact--error', errorText));
        if (facts.muted && !errorText) facts2.push(part('dashboard-quota__fact', 'Unavailable'));
        if (facts.resetsAt) facts2.push(this._quotaResetFact(part, facts.resetsAt));
        if (!errorText && facts.sharedWeeklyText) facts2.push(part('dashboard-quota__fact', facts.sharedWeeklyText));
        else if (!facts.muted && !facts.resetsAt && !errorText) facts2.push(part('dashboard-quota__fact', 'Gemini models'));
        card.append(quotaRows(part, head, facts2));
        return card;
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
        const statusInfo = statusPresentation(status);
        const building = buildingClassForAgent(agent);
        const inLane = Boolean(this._bellEl) && cardEl.parentElement === this._bellEl;
        const signature = [
            building || '',
            districtKeyForAgent(agent) || '',
            inLane,
            agent.name || '',
            agent.model || '',
            agent.effort || '',
            agent.provider || '',
            mcpJobLabel(agent) || agent.role || '',
            agent.workflowName || '',
            agent.parentSessionId || '',
            agent.departedAt || '',
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
            agent.hobotnica?.threadId || '',
            JSON.stringify(agent.tokens || null),
            i18n.lang || '',
        ].join('|');

        cardEl._projectPath = this._projectKeyFor(agent);
        cardEl._status = status;
        cardEl._exceptionRank = rowExceptionRank(agent);
        cardEl._hasWork = rowHasWork(agent);
        // U-P8 — checkout labels and search matches can change on their own.
        const branch = normalizeRepoBranch(agent.gitBranch);
        const worktree = worktreeLabel(agent);
        this._setText(refs.branch, [branch ? `on ${middleTruncate(branch, 22)}` : '', worktree ? middleTruncate(worktree, 20) : ''].filter(Boolean).join(' · '));
        const branchTitle = [branch ? `branch ${branch}` : '', agent.worktree?.path ? `worktree ${agent.worktree.path}` : ''].filter(Boolean).join(' - ');
        if (refs.branch.title !== branchTitle) refs.branch.title = branchTitle;
        const searchContext = this._searchContexts.get(String(agent.id)) || '';
        this._setText(refs.searchContext, searchContext);
        this._setStyle(refs.searchContext, 'display', searchContext ? '' : 'none');

        if (this._cardRenderSignatures.get(agent.id) !== signature) {
            this._cardRenderSignatures.set(agent.id, signature);

            const selected = this.selection.isSelected(agent.id);
            // 9.5 / one ask, one frame: a lane card wears the call card's attn
            // slice in its status hue instead of the row's status spine.
            const frame = inLane ? ` cv-frame ${CALL_FRAME_BY_STATUS[status] || 'cv-frame--attn'}` : '';
            const departed = agent.isDeparted ? ' dash-card--departed' : '';
            const nextClass = `dash-card dash-card--${status}${departed}${inLane ? ' dash-card--call' : ''}${frame}${selected ? ' dash-card--selected' : ''}`;
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
                this._setText(refs.role, mcpJobLabel(agent) || agent.role || '');
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
            if (refs.openExternal) {
                this._setStyle(refs.openExternal, 'display', agent?.hobotnica?.threadId ? '' : 'none');
            }

            const reason = waitReasonLabel(agent);
            this._setText(refs.detailStatus, inLane ? '' : `${statusWord(status)}${reason ? ` — ${reason}` : ''}`);
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

            // #30 + W4.4 — district identity lives in the selected detail emblem
            // and as one of 9 static cached 44x40 backdrops behind the portrait niche.
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
            const districtKey = districtKeyForAgent(agent);
            if (refs.niche && cardEl._nicheDistrict !== districtKey) {
                cardEl._nicheDistrict = districtKey;
                if (districtKey) refs.niche.dataset.district = districtKey;
                else delete refs.niche.dataset.district;
                const backdrop = districtKey ? getDistrictBackdrop(districtKey) : null;
                this._setStyle(refs.niche, 'backgroundImage', backdrop?.dataUrl ? `url("${backdrop.dataUrl}")` : '');
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
        const detailUsage = this.selection.isSelected(agent.id) ? this.detailUsage.get(agent.id) : null;
        this._renderUsageFooter(cardEl, this._usageFooterFor(agent, detailUsage));

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
        // W4.4 (F4/R11) — compact inline chip in NOW whenever the wide WORKING SET
        // column is below the 30 % grid allocation threshold.
        const uniqueFiles = new Set(workingSet.map(item => item?.path).filter(Boolean)).size;
        const inlineWork = uniqueFiles > 0
            ? `${uniqueFiles} ${uniqueFiles === 1 ? 'file' : 'files'}`
            : (collisions.length > 0 ? `${collisions.length} overlap` : '');
        cardEl._inlineWorkText = inlineWork;
        cardEl._inlineWorkCollision = collisions.length > 0;
        cardEl._inlineWorkTitle = summaryText;
        this._syncRowInlineChips(cardEl);
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
            cardEl._inlineKidsText = '';
            cardEl._inlineKidsTitle = '';
            this._syncRowInlineChips(cardEl);
            this._setText(target, agent.parentSessionId ? 'Child agent' : '—');
            target.title = agent.parentSessionId ? `Parent ${agent.parentSessionId}` : 'No child agents';
            this._setText(sourceEl, '');
            sourceEl?.removeAttribute('title');
            sourceEl?.classList.remove('dash-card__children-source--exact', 'dash-card__children-source--inferred');
            return;
        }
        const kidCount = Math.max(children.length, Number(progress.total) || 0);
        cardEl._inlineKidsText = kidCount > 0 ? `▸ ${kidCount}` : '';
        cardEl._inlineKidsTitle = `${progress.done}/${progress.total} done`;
        this._syncRowInlineChips(cardEl);
        this._setText(target, `${progress.done}/${progress.total} done`);
        target.title = children.length
            ? children.map(child => `${child.name || child.id}: ${child.isDeparted ? 'Unknown' : statusWord(child.status)}`).join('; ')
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

    // 7.12 — children read under their parent, even across projects. A
    // child's full row folds into this strip unless it is unfolded (UI-16).
    _renderKidStrip(cardEl, agent, children) {
        const strip = cardEl._elements?.kids;
        if (!strip) return;
        const signature = JSON.stringify(children.map(child => [
            child.id, child.name, mcpJobLabel(child) || child.role, child.agentType, normalizeStatus(child.status), child.isDeparted === true,
            child.currentTool || '', child.currentToolInput || '', child.projectPath || '',
        ]).concat([[agent.projectPath || '', this._crewSize(String(agent.id)), this._expandedLeads.has(String(agent.id))]]));
        if (strip._kidSignature === signature) return;
        strip._kidSignature = signature;
        const leadId = String(agent.id);
        const expanded = this._expandedLeads.has(leadId);
        // When the crew's full rows are unfolded below the lead, omit the
        // compact kid rows so subagents are never shown twice.
        const compactChildren = expanded ? [] : children;
        const chips = cardEl._kidChips || (cardEl._kidChips = new Map());
        const liveIds = new Set(compactChildren.map(child => String(child.id)));
        for (const [id, chip] of chips) {
            if (!liveIds.has(id)) {
                chip.destroy?.();
                chips.delete(id);
            }
        }
        const crew = this._crewSize(leadId);
        strip.hidden = children.length === 0 && crew === 0;
        const rows = compactChildren.map(child => {
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
                mcpJobLabel(child) || child.role || child.agentType || '',
                `${now.lead}${now.detail ? ` ${now.detail}` : ''}`,
                otherProject ? `in ${shortProjectName(child.projectPath || '_unknown', i18n.t('unknownProject'))}` : '',
            ].filter(Boolean).join(' · ');
            const detail = Object.assign(document.createElement('span'), { className: 'dash-card__kid-detail', textContent: facts });
            const state = Object.assign(document.createElement('span'), {
                className: 'dash-card__kid-status',
                textContent: child.isDeparted ? 'unknown' : statusWord(child.status, 'lower'),
            });
            row.append(hook, face, name, detail, state);
            row.title = `Select ${child.name || id}`;
            row.addEventListener('click', (event) => {
                event.stopPropagation();
                const current = this.world.agents.get(id);
                if (!current) return;
                emitAgentSelected(current);
                // After the queued render that unfolds a folded row (UI-16).
                queueMicrotask(() => this.cards.get(id)?.scrollIntoView({ block: 'nearest', inline: 'nearest' }));
            });
            return row;
        });
        // UI-16 — the per-lead toggle: the crew's full rows fold into this
        // strip unless the operator unfolds them.
        if (crew > 0) {
            const toggle = Object.assign(document.createElement('button'), {
                type: 'button',
                className: 'dash-card__kid-toggle',
                textContent: expanded ? 'hide subagent rows' : `show ${crew} subagent row${crew === 1 ? '' : 's'}`,
            });
            toggle.setAttribute('aria-pressed', String(expanded));
            toggle.addEventListener('click', (event) => {
                event.stopPropagation();
                if (this._expandedLeads.has(leadId)) this._expandedLeads.delete(leadId);
                else this._expandedLeads.add(leadId);
                this._queueFlush({ render: true });
            });
            rows.push(toggle);
        }
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
        this._renderedSelectedAgentId = nextId ?? null;
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
                this._renderUsageFooter(card, this._usageFooterFor(agent, selected ? this.detailUsage.get(id) : null));
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
        // UI-5 — only a quiet row dims with age; a silent working one is raised.
        const isAged = isAgedQuietRow(agent);
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

    _usageFooterFor(agent, detailUsage) {
        const usage = TokenUsage.normalize(detailUsage || agent?.tokens || null);
        const cells = rowTokenCells(usage);
        const supplied = agent?.cost;
        const source = normalizeCostSource(supplied?.source);
        const cost = source === 'estimate' ? TokenUsage.estimateCost(usage, agent.model, agent.provider) : supplied;
        const approximate = source !== 'provider';
        return {
            tokens: cells.title,
            cost: cost.usd == null ? 'Cost unavailable' : `${approximate ? '~' : ''}${formatCost(cost.usd)}`,
            tokensShort: cells.newShort,
            cacheShort: cells.cacheShort,
            partial: usage.availability === 'partial',
            costShort: cost.usd == null ? '—' : `${approximate ? '≈' : ''}${formatCost(cost.usd)}`,
            costTitle: costSourceTitle(cost, agent.provider || 'provider'),
            source: cost.usd == null ? 'unavailable' : source,
            unknownModel: cost.unknownModel,
        };
    }

    _renderUsageFooter(cardEl, footer) {
        const refs = cardEl._elements;
        if (!refs?.usageTokens || !footer) return;
        this._setText(refs.usageNew, footer.tokensShort ?? footer.tokens);
        this._setText(refs.usageCache, footer.cacheShort || '');
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
        const hasDetail = this.toolHistories.has(agent.id) || this.detailUsage.has(agent.id);
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
        const agent = this.world?.agents?.get?.(agentId);
        annotateMendBrackets(listEl, [...listEl.children], limited, {
            agentId,
            provider: agent?.provider || '',
            classPrefix: 'dash-card__tool',
        });
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
                const usage = data.tokenUsage || data.tokens || data.usage || null;
                this.detailUsage.set(agent.id, usage);
                if (cardEl) this._renderUsageFooter(cardEl, this._usageFooterFor(agent, usage));
                // The strip places every fetched call; the list shows the newest.
                const toolHistory = Array.isArray(data.toolHistory) ? data.toolHistory : [];
                this.toolHistories.set(agent.id, toolHistory);
                if (cardEl) {
                    this._renderToolHistory(cardEl, agent.id, toolHistory);
                    this._updateStaleBadge(cardEl, agent);
                    this._paintCardTape(cardEl);
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
        this.detailUsage.clear();
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
            cardEl._silentUnsubscribe?.();
            cardEl._silentUnsubscribe = null;
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
        this.detailUsage.delete(agentId);
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
            '▸ Run a CLI agent (claude, codex, antigravity, gemini, opencode, kimi) in any terminal',
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
        this._clearQuotaRailSubscriptions();
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
        eventBus.off('outcome:verified', this._onOutcomeVerified);
        eventBus.off('mode:changed', this._onModeChanged);
        eventBus.off(DASHBOARD_FILTER_EVENT, this._onSharedFilterChanged);
        eventBus.off('harbor:updated', this._onHarborUpdated);
        eventBus.off('usage:updated', this._onUsageUpdated);
    }
}
