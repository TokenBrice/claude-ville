import { TILE_WIDTH, TILE_HEIGHT } from '../../config/constants.js';
import { repoProfile } from '../shared/RepoColor.js';

const SHIP_SPRITE_ID = 'prop.harborBoat';
const MAX_DEPARTING_SHIPS = 5;
const HARBOR_LOG_TILE = { tileX: 34.8, tileY: 17.2 };
const DEPARTURE_MS = 48000;
const EXIT_HOLD_MS = 1800;
const EXIT_FADE_MS = 4200;
const FADE_DELAY_MS = 3200;
const FINALE_EFFECT_MS = 9000;
const SCREEN_SUMMARY_MS = 16000;
const RECENT_PUSH_REPLAY_MS = 2 * 60 * 1000;
const HARBOR_CRATE_TTL_MS = 30000;
const MAX_LABEL_CHARS = 30;
const HARBOR_FINALE_TILE = { tileX: 38.2, tileY: 6.6 };
const HARBOR_SUMMARY_TILE = { tileX: 35.2, tileY: 21.5 };
const REPO_DOCK_SHIP_Y_OFFSET = 236;
const REPO_DOCK_SHIP_SORT_OFFSET = 8;
const HARBOR_FRONT_QUEUE_TILES = Object.freeze([
    // Harbor apron, directly in front of the Harbor Master dock.
    { tileX: 32.2, tileY: 22.4, line: 0, column: 0 },
    { tileX: 33.3, tileY: 22.8, line: 0, column: 1 },
    { tileX: 34.4, tileY: 23.0, line: 0, column: 2 },
    { tileX: 35.5, tileY: 23.0, line: 0, column: 3 },
    { tileX: 36.6, tileY: 22.8, line: 0, column: 4 },
    { tileX: 37.7, tileY: 22.4, line: 0, column: 5 },
    { tileX: 38.7, tileY: 21.8, line: 0, column: 6 },
    // Outer harbor, following the open-water edge up toward the lighthouse.
    { tileX: 38.5, tileY: 20.4, line: 1, column: 0 },
    { tileX: 38.3, tileY: 19.0, line: 1, column: 1 },
    { tileX: 38.1, tileY: 17.6, line: 1, column: 2 },
    { tileX: 37.8, tileY: 16.2, line: 1, column: 3 },
    { tileX: 37.4, tileY: 14.8, line: 1, column: 4 },
    { tileX: 36.9, tileY: 13.5, line: 1, column: 5 },
    { tileX: 36.3, tileY: 12.2, line: 1, column: 6 },
    // Lighthouse approach water. These absorb bursty repos without crossing
    // the shoreline or the map edge.
    { tileX: 35.8, tileY: 10.8, line: 2, column: 0 },
    { tileX: 35.0, tileY: 9.7, line: 2, column: 1 },
    { tileX: 34.1, tileY: 8.7, line: 2, column: 2 },
    { tileX: 33.0, tileY: 7.8, line: 2, column: 3 },
    { tileX: 31.8, tileY: 7.0, line: 2, column: 4 },
    { tileX: 30.5, tileY: 6.4, line: 2, column: 5 },
]);

const BERTHS = [
    { tileX: 32.8, tileY: 21.2 },
    { tileX: 33.4, tileY: 21.7 },
    { tileX: 33.6, tileY: 20.5 },
    { tileX: 34.2, tileY: 21.9 },
    { tileX: 35.0, tileY: 21.8 },
    { tileX: 34.7, tileY: 20.3 },
    { tileX: 35.8, tileY: 21.6 },
    { tileX: 36.5, tileY: 21.0 },
    { tileX: 36.1, tileY: 20.2 },
    { tileX: 37.0, tileY: 21.5 },
    { tileX: 36.8, tileY: 20.5 },
    { tileX: 35.4, tileY: 20.0 },
];

const QUAY_GROUPS = [
    { name: 'West Quay', berthIndexes: [0, 1, 2] },
    { name: 'Market Quay', berthIndexes: [3, 4, 5] },
    { name: 'Beacon Quay', berthIndexes: [6, 7, 8] },
    { name: 'Outer Quay', berthIndexes: [9, 10, 11] },
];

const SEA_LANES = [
    [
        { tileX: 36.2, tileY: 21.1 },
        { tileX: 37.1, tileY: 19.2 },
        { tileX: 38.0, tileY: 15.7 },
        { tileX: 37.6, tileY: 12.8 },
        { tileX: 38.1, tileY: 9.4 },
        { tileX: 38.2, tileY: 6.6 },
    ],
    [
        { tileX: 34.8, tileY: 20.6 },
        { tileX: 36.9, tileY: 18.8 },
        { tileX: 38.1, tileY: 14.7 },
        { tileX: 37.7, tileY: 12.1 },
        { tileX: 38.3, tileY: 8.8 },
        { tileX: 38.5, tileY: 5.8 },
    ],
    [
        { tileX: 33.5, tileY: 20.5 },
        { tileX: 36.6, tileY: 18.3 },
        { tileX: 37.8, tileY: 14.2 },
        { tileX: 37.3, tileY: 11.8 },
        { tileX: 38.0, tileY: 8.4 },
        { tileX: 38.3, tileY: 4.9 },
    ],
    [
        { tileX: 38.2, tileY: 21.0 },
        { tileX: 38.0, tileY: 18.7 },
        { tileX: 38.0, tileY: 15.8 },
        { tileX: 37.5, tileY: 13.2 },
        { tileX: 38.1, tileY: 9.9 },
        { tileX: 38.4, tileY: 7.0 },
    ],
];

const PUSH_STATUS_STYLE = {
    success: {
        label: 'Push landed',
        shortLabel: 'landed',
        accent: '#6cdb94',
        panel: 'rgba(22, 54, 43, 0.92)',
        glow: 'rgba(108, 219, 148, 0.58)',
    },
    failed: {
        label: 'Push failed',
        shortLabel: 'failed',
        accent: '#f07668',
        panel: 'rgba(62, 31, 34, 0.93)',
        glow: 'rgba(240, 87, 76, 0.55)',
    },
    unknown: {
        label: 'Push sent',
        shortLabel: 'sent',
        accent: '#f6cf60',
        panel: 'rgba(58, 48, 27, 0.92)',
        glow: 'rgba(246, 207, 96, 0.52)',
    },
};

function isHarborCrateTool(agent) {
    const text = `${agent?.currentTool || ''} ${agent?.currentToolInput || ''} ${agent?.lastToolInput || ''}`.toLowerCase();
    return /\bgit\s+(status|diff|show)\b/.test(text);
}

function toWorld(tileX, tileY) {
    return {
        x: (tileX - tileY) * TILE_WIDTH / 2,
        y: (tileX + tileY) * TILE_HEIGHT / 2,
    };
}

function parseTime(value, fallback = 0) {
    if (Number.isFinite(Number(value))) return Number(value);
    if (value instanceof Date) return value.getTime();
    if (typeof value === 'string' && value.trim()) {
        const parsed = Date.parse(value);
        if (Number.isFinite(parsed)) return parsed;
    }
    return fallback;
}

function stableHash(input) {
    const text = String(input || '');
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
        hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
    }
    return Math.abs(hash);
}

function projectName(project) {
    const text = String(project || 'unknown').trim();
    const parts = text.split(/[\\/]/).filter(Boolean);
    return shortenLabel(parts.at(-1) || text || 'unknown', 26);
}

function displayRepoName(project) {
    const name = projectName(project);
    return name
        .replace(/[-_]+/g, ' ')
        .replace(/\b\w/g, char => char.toUpperCase());
}

function rotateIndexes(indexes, offset) {
    const list = Array.isArray(indexes) ? indexes : [];
    if (list.length <= 1) return [...list];
    const start = Math.abs(offset || 0) % list.length;
    return [...list.slice(start), ...list.slice(0, start)];
}

function shortenLabel(value, maxChars = MAX_LABEL_CHARS) {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    if (!text) return '';
    if (text.length <= maxChars) return text;
    return `${text.slice(0, Math.max(1, maxChars - 1))}…`;
}

function stripShellQuotes(value = '') {
    const text = String(value).trim();
    if (text.length >= 2) {
        const first = text[0];
        const last = text[text.length - 1];
        if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
            return text.slice(1, -1);
        }
    }
    return text;
}

function commitMessageFromCommand(command) {
    const text = String(command || '');
    const match = text.match(/(?:^|\s)(?:-m|--message)(?:=|\s+)(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/);
    if (!match) return '';
    return stripShellQuotes(match[1] || match[2] || match[3] || '');
}

function eventLabel(event, type, sha) {
    const explicit = event.label || event.message || event.subject || event.title || '';
    if (explicit) return shortenLabel(explicit);
    if (type === 'commit') {
        const commandLabel = commitMessageFromCommand(event.command);
        if (commandLabel) return shortenLabel(commandLabel);
    }
    if (sha) return shortenLabel(sha.slice(0, 10));
    return shortenLabel(event.commandHash || event.id || type);
}

function cloneState(previous = {}) {
    previous = previous || {};
    const seenEventIds = previous.seenEventIds instanceof Set
        ? new Set(previous.seenEventIds)
        : new Set(previous.seenEventIds || []);
    const sourceShips = previous.ships instanceof Map
        ? previous.ships.entries()
        : Object.entries(previous.ships || {});
    const ships = new Map();
    for (const [id, ship] of sourceShips) {
        ships.set(id, { ...ship });
    }
    const sourceBatches = previous.batches instanceof Map
        ? previous.batches.entries()
        : Object.entries(previous.batches || {});
    const batches = new Map();
    for (const [id, batch] of sourceBatches) {
        batches.set(id, {
            ...batch,
            shipIds: Array.isArray(batch.shipIds) ? [...batch.shipIds] : [],
        });
    }
    const sourcePushEvents = previous.pushEvents instanceof Map
        ? previous.pushEvents.entries()
        : Object.entries(previous.pushEvents || {});
    const pushEvents = new Map();
    for (const [id, pushEvent] of sourcePushEvents) {
        pushEvents.set(id, { ...pushEvent });
    }
    const sourceRepoQuays = previous.repoQuays instanceof Map
        ? previous.repoQuays.entries()
        : Object.entries(previous.repoQuays || {});
    const repoQuays = new Map();
    for (const [project, quayIndex] of sourceRepoQuays) {
        repoQuays.set(project, Number.isFinite(Number(quayIndex)) ? Number(quayIndex) : 0);
    }
    return {
        seenEventIds,
        ships,
        batches,
        pushEvents,
        repoQuays,
        nextSequence: Number.isFinite(previous.nextSequence) ? previous.nextSequence : ships.size,
        nextBatchSequence: Number.isFinite(previous.nextBatchSequence) ? previous.nextBatchSequence : batches.size,
    };
}

function assignedQuayIndex(state, project) {
    const key = String(project || 'unknown');
    const existing = state.repoQuays.get(key);
    if (Number.isFinite(existing)) return existing;

    const preferred = stableHash(key) % QUAY_GROUPS.length;
    const loads = QUAY_GROUPS.map((_, index) => {
        let load = 0;
        for (const ship of state.ships.values()) {
            if (ship.quayIndex === index && ship.status === 'docked') load += 1;
        }
        for (const [project, quayIndex] of state.repoQuays.entries()) {
            if (String(project || 'unknown') === key) continue;
            if (quayIndex === index) load += 0.35;
        }
        return load;
    });

    let chosen = preferred;
    for (let i = 1; i < QUAY_GROUPS.length; i++) {
        const candidate = (preferred + i) % QUAY_GROUPS.length;
        if (loads[candidate] < loads[chosen]) chosen = candidate;
    }
    state.repoQuays.set(key, chosen);
    return chosen;
}

function chooseBerthIndex(state, project) {
    const quayIndex = assignedQuayIndex(state, project);
    const key = String(project || 'unknown');
    const occupied = new Set();
    for (const ship of state.ships.values()) {
        if (Number.isFinite(Number(ship.berthIndex))) occupied.add(Number(ship.berthIndex));
    }
    const otherRepoQuays = new Set();
    for (const [assignedProject, assignedQuay] of state.repoQuays.entries()) {
        if (String(assignedProject || 'unknown') !== key) otherRepoQuays.add(assignedQuay);
    }

    const preferredGroup = QUAY_GROUPS[quayIndex] || QUAY_GROUPS[0];
    for (const berthIndex of rotateIndexes(preferredGroup.berthIndexes, state.nextSequence)) {
        if (!occupied.has(berthIndex)) return { berthIndex, quayIndex };
    }

    for (let offset = 1; offset < QUAY_GROUPS.length; offset++) {
        const nextQuayIndex = (quayIndex + offset) % QUAY_GROUPS.length;
        if (otherRepoQuays.has(nextQuayIndex)) continue;
        const group = QUAY_GROUPS[nextQuayIndex];
        for (const berthIndex of rotateIndexes(group.berthIndexes, state.nextSequence)) {
            if (!occupied.has(berthIndex)) return { berthIndex, quayIndex };
        }
    }

    for (let offset = 1; offset < QUAY_GROUPS.length; offset++) {
        const group = QUAY_GROUPS[(quayIndex + offset) % QUAY_GROUPS.length];
        for (const berthIndex of rotateIndexes(group.berthIndexes, state.nextSequence)) {
            if (!occupied.has(berthIndex)) return { berthIndex, quayIndex };
        }
    }

    return {
        berthIndex: state.nextSequence % BERTHS.length,
        quayIndex,
    };
}

function latestPushTimesByProject(events) {
    const latest = new Map();
    for (const event of events) {
        if (event?.type !== 'push' || !event.project || !Number.isFinite(event.timestamp) || event.timestamp <= 0) continue;
        const previous = latest.get(event.project) || 0;
        if (event.timestamp > previous) latest.set(event.project, event.timestamp);
    }
    return latest;
}

function pointAlongPath(points, progress) {
    if (!Array.isArray(points) || points.length === 0) return { x: 0, y: 0 };
    if (points.length === 1) return points[0];

    const lengths = [];
    let total = 0;
    for (let i = 1; i < points.length; i++) {
        const a = points[i - 1];
        const b = points[i];
        const length = Math.hypot(b.x - a.x, b.y - a.y);
        lengths.push(length);
        total += length;
    }
    if (total <= 0) return points[points.length - 1];

    let remaining = Math.max(0, Math.min(1, progress)) * total;
    for (let i = 1; i < points.length; i++) {
        const length = lengths[i - 1];
        if (remaining <= length || i === points.length - 1) {
            const a = points[i - 1];
            const b = points[i];
            const t = length <= 0 ? 1 : remaining / length;
            return {
                x: a.x + (b.x - a.x) * t,
                y: a.y + (b.y - a.y) * t,
            };
        }
        remaining -= length;
    }

    return points[points.length - 1];
}

function harborFrontQueuePosition(index, total) {
    const slotIndex = index % HARBOR_FRONT_QUEUE_TILES.length;
    const cycle = Math.floor(index / HARBOR_FRONT_QUEUE_TILES.length);
    const slot = HARBOR_FRONT_QUEUE_TILES[slotIndex];
    const lineCount = HARBOR_FRONT_QUEUE_TILES.filter(candidate => candidate.line === slot.line).length;
    const pos = toWorld(slot.tileX + cycle * 0.16, slot.tileY + cycle * 0.16);
    return {
        x: pos.x,
        y: pos.y,
        line: slot.line,
        column: slot.column,
        lineCount,
    };
}

function isHistoricalCommittedBeforePush(event, latestPushTimes, now) {
    const latestPush = latestPushTimes.get(event.project) || 0;
    if (!latestPush || !Number.isFinite(event.timestamp) || event.timestamp > latestPush) return false;
    return Math.max(0, now - latestPush) > RECENT_PUSH_REPLAY_MS;
}

export function snapshotHarborTrafficState(state) {
    const cloned = cloneState(state);
    return {
        nextSequence: cloned.nextSequence,
        seenEventIds: [...cloned.seenEventIds].sort(),
        ships: [...cloned.ships.values()]
            .map(ship => ({
                id: ship.id,
                project: ship.project,
                quayIndex: ship.quayIndex ?? null,
                repoName: ship.repoName || '',
                sha: ship.sha || '',
                label: ship.label || '',
                status: ship.status,
                pushStatus: ship.pushStatus || null,
                batchId: ship.batchId || null,
                berthIndex: ship.berthIndex,
                laneIndex: ship.laneIndex,
                eventTime: ship.eventTime,
                departEventId: ship.departEventId || null,
                departStartedAt: ship.departStartedAt || null,
            }))
            .sort((a, b) => (a.eventTime - b.eventTime) || a.id.localeCompare(b.id)),
        repoQuays: [...cloned.repoQuays.entries()]
            .map(([project, quayIndex]) => ({ project, quayIndex }))
            .sort((a, b) => a.project.localeCompare(b.project)),
        batches: [...cloned.batches.values()]
            .map(batch => ({
                id: batch.id,
                project: batch.project,
                quayIndex: batch.quayIndex ?? null,
                repoName: batch.repoName || '',
                label: batch.label || '',
                status: batch.status || 'unknown',
                targetRef: batch.targetRef || '',
                shipCount: batch.shipCount || 0,
                eventTime: batch.eventTime || 0,
                startedAt: batch.startedAt || 0,
                shipIds: [...(batch.shipIds || [])].sort(),
            }))
            .sort((a, b) => (a.eventTime - b.eventTime) || a.id.localeCompare(b.id)),
        pushEvents: [...cloned.pushEvents.values()]
            .map(push => ({
                id: push.id,
                project: push.project || '',
                status: push.status || 'unknown',
                eventTime: push.eventTime || 0,
                batchId: push.batchId || null,
            }))
            .sort((a, b) => (a.eventTime - b.eventTime) || a.id.localeCompare(b.id)),
    };
}

function eventKind(event) {
    const raw = String(event?.type || event?.kind || event?.action || event?.event || event?.name || '').toLowerCase();
    if (raw.includes('push')) return 'push';
    if (raw.includes('commit')) return 'commit';
    if (event?.pushed === true || Array.isArray(event?.commits)) return 'push';
    if (event?.sha || event?.commit || event?.hash) return 'commit';
    return null;
}

function normalizePushStatus(event) {
    if (!event || typeof event !== 'object') return 'unknown';
    if (typeof event.success === 'boolean') return event.success ? 'success' : 'failed';
    const exitCode = event.exitCode ?? event.exit_code ?? event.code ?? event.returnCode ?? event.return_code;
    if (Number.isFinite(Number(exitCode))) return Number(exitCode) === 0 ? 'success' : 'failed';

    const raw = event.status
        ?? event.outcome
        ?? event.conclusion
        ?? event.result
        ?? event.state
        ?? event.lifecycle
        ?? '';
    const text = String(raw).toLowerCase();
    if (!text) return 'unknown';
    if (['success', 'succeeded', 'ok', 'passed', 'pass', 'complete', 'completed', 'landed'].includes(text)) return 'success';
    if (['failed', 'failure', 'fail', 'error', 'errored', 'cancelled', 'canceled', 'timed_out', 'timeout'].includes(text)) return 'failed';
    return 'unknown';
}

export function normalizeGitEvent(event, agent = {}, index = 0) {
    if (!event || typeof event !== 'object') return null;

    const type = eventKind(event);
    if (!type) return null;

    const project = event.project
        || event.projectPath
        || event.repository
        || event.repo
        || event.workspace
        || agent.projectPath
        || agent.teamName
        || agent.project
        || 'unknown';
    const sha = event.sha || event.commit || event.hash || event.commitSha || event.revision || '';
    const timestamp = parseTime(
        event.timestamp || event.time || event.ts || event.date || event.createdAt || event.created_at,
        parseTime(agent.lastSessionActivity, 0)
    );
    const id = event.id
        || event.eventId
        || event.uuid
        || event.key
        || `${type}:${project}:${sha}:${timestamp}:${index}`;

    return {
        id: String(id),
        type,
        project: String(project),
        sha: sha ? String(sha) : '',
        timestamp,
        label: eventLabel(event, type, sha),
        command: event.command ? String(event.command) : '',
        targetRef: event.targetRef || event.ref || event.branch || '',
        success: typeof event.success === 'boolean' ? event.success : null,
        exitCode: Number.isFinite(Number(event.exitCode ?? event.exit_code))
            ? Number(event.exitCode ?? event.exit_code)
            : null,
        completedAt: parseTime(event.completedAt || event.completed_at, 0),
        status: type === 'push' ? normalizePushStatus(event) : null,
    };
}

export function collectGitEventsFromAgents(agents) {
    const events = [];
    for (const agent of agents || []) {
        const sources = [
            agent?.gitEvents,
            agent?.git?.events,
            agent?.vcsEvents,
        ].filter(Array.isArray);
        for (const source of sources) {
            source.forEach((event, index) => {
                const normalized = normalizeGitEvent(event, agent, index);
                if (normalized) events.push(normalized);
            });
        }
    }
    events.sort((a, b) => (a.timestamp - b.timestamp) || a.id.localeCompare(b.id));
    return events;
}

function pendingRepoSummariesFromDockSummaries(summaries) {
    return [...(summaries?.values?.() || [])]
        .filter(summary => (Number(summary.count) || 0) > 0)
        .map((summary) => ({
            project: summary.project,
            repoName: displayRepoName(summary.project),
            shortName: summary.profile?.shortName || projectName(summary.project),
            profile: summary.profile || repoProfile(summary.project),
            pendingCommits: Number(summary.count) || 0,
            failedPushes: Number(summary.failedCount) || 0,
            latestEventTime: Number(summary.latestEventTime) || 0,
        }))
        .sort((a, b) => (b.failedPushes - a.failedPushes)
            || (b.pendingCommits - a.pendingCommits)
            || (b.latestEventTime - a.latestEventTime)
            || a.repoName.localeCompare(b.repoName));
}

export function reduceHarborTrafficState(previous, events, options = {}) {
    const state = cloneState(previous);
    const now = Number.isFinite(options.now) ? options.now : Date.now();
    const motionScale = options.motionScale === 0 ? 0 : 1;

    const sorted = [...(events || [])]
        .filter(event => event?.id && event?.type && event?.project)
        .sort((a, b) => (a.timestamp - b.timestamp) || a.id.localeCompare(b.id));
    const latestPushTimes = latestPushTimesByProject(sorted);
    const relevantProjects = new Set(sorted.map(event => String(event.project || 'unknown')));
    for (const ship of state.ships.values()) {
        if (ship.project) relevantProjects.add(String(ship.project));
    }
    for (const [project] of state.repoQuays.entries()) {
        if (!relevantProjects.has(String(project || 'unknown'))) state.repoQuays.delete(project);
    }
    for (const project of relevantProjects) {
        assignedQuayIndex(state, project);
    }

    for (const event of sorted) {
        if (event.type !== 'push') {
            if (state.seenEventIds.has(event.id)) continue;
            state.seenEventIds.add(event.id);
        }

        if (event.type === 'commit') {
            if (isHistoricalCommittedBeforePush(event, latestPushTimes, now)) continue;
            const { berthIndex, quayIndex } = chooseBerthIndex(state, event.project);
            const laneIndex = stableHash(`${event.project}:${event.id}`) % SEA_LANES.length;
            const profile = repoProfile(event.project);
            state.nextSequence++;
            state.ships.set(event.id, {
                id: event.id,
                project: event.project,
                repoName: profile.shortName,
                quayIndex,
                sha: event.sha,
                label: event.label,
                status: 'docked',
                berthIndex,
                laneIndex,
                eventTime: event.timestamp || now,
                createdAt: now,
            });
            continue;
        }

        if (event.type === 'push') {
            const eventAge = Number.isFinite(event.timestamp) && event.timestamp > 0
                ? Math.max(0, now - event.timestamp)
                : 0;
            const skipOldReplay = eventAge > RECENT_PUSH_REPLAY_MS;
            const skipDepartureAnimation = motionScale === 0 || skipOldReplay;
            const pushTime = Number.isFinite(event.timestamp) && event.timestamp > 0 ? event.timestamp : 0;
            const batchId = `push-batch:${event.id}`;
            const previousPush = state.pushEvents.get(event.id);
            const incomingStatus = event.status || 'unknown';
            const previousStatus = previousPush?.status || null;
            const status = previousStatus && incomingStatus === 'unknown' ? previousStatus : incomingStatus;
            const existingBatch = state.batches.get(batchId);
            const statusChanged = previousStatus && previousStatus !== status;
            if (previousPush && !statusChanged) continue;

            let selectedShips = [];
            if (existingBatch?.shipIds?.length) {
                selectedShips = existingBatch.shipIds
                    .map(id => state.ships.get(id))
                    .filter(Boolean);
            } else {
                for (const ship of state.ships.values()) {
                    if (ship.project !== event.project || ship.status !== 'docked') continue;
                    if (pushTime > 0 && Number.isFinite(ship.eventTime) && ship.eventTime > pushTime) continue;
                    selectedShips.push(ship);
                }
            }

            if (!existingBatch && selectedShips.length === 0) {
                state.pushEvents.set(event.id, {
                    id: event.id,
                    project: event.project,
                    status,
                    eventTime: event.timestamp || now,
                    batchId: null,
                    seenAt: now,
                });
                continue;
            }

            const shipIds = existingBatch?.shipIds?.length
                ? [...existingBatch.shipIds]
                : selectedShips.map(ship => ship.id);
            const startedAt = existingBatch?.startedAt
                || (skipOldReplay ? now - SCREEN_SUMMARY_MS - FINALE_EFFECT_MS - 1 : now);
            const batch = {
                ...(existingBatch || {}),
                id: batchId,
                project: event.project,
                quayIndex: assignedQuayIndex(state, event.project),
                repoName: repoProfile(event.project).shortName,
                label: event.label || existingBatch?.label || '',
                targetRef: event.targetRef || existingBatch?.targetRef || '',
                status,
                shipIds,
                shipCount: shipIds.length,
                sequence: existingBatch?.sequence || ++state.nextBatchSequence,
                eventTime: event.timestamp || existingBatch?.eventTime || now,
                startedAt,
                statusUpdatedAt: statusChanged ? now : existingBatch?.statusUpdatedAt || now,
            };
            state.batches.set(batchId, batch);
            state.pushEvents.set(event.id, {
                id: event.id,
                project: event.project,
                status,
                eventTime: event.timestamp || now,
                batchId,
                seenAt: previousPush?.seenAt || now,
            });

            for (const ship of selectedShips) {
                ship.pushStatus = status;
                ship.batchId = batchId;
                ship.pushEventId = event.id;
                ship.pushSeenAt = now;
                if (status === 'failed') {
                    ship.status = 'docked';
                    ship.failedAt = skipOldReplay ? null : now;
                    ship.departEventId = null;
                    ship.departStartedAt = null;
                    ship.departEventTime = null;
                    continue;
                }
                ship.status = 'departing';
                ship.departEventId = event.id;
                ship.departStartedAt = skipDepartureAnimation
                    ? now - DEPARTURE_MS - FADE_DELAY_MS - EXIT_FADE_MS - EXIT_HOLD_MS - 1
                    : ship.departStartedAt || now;
                ship.departEventTime = event.timestamp || now;
            }
        }
    }

    for (const [id, ship] of state.ships) {
        if (ship.status !== 'departing') continue;
        const startedAt = ship.departStartedAt || now;
        const progress = motionScale === 0 ? 1 : Math.max(0, Math.min(1, (now - startedAt) / DEPARTURE_MS));
        if (progress >= 1 && now - startedAt > DEPARTURE_MS + FADE_DELAY_MS + EXIT_FADE_MS + EXIT_HOLD_MS) {
            state.ships.delete(id);
        }
    }

    for (const [id, batch] of state.batches) {
        const age = now - (batch.startedAt || now);
        if (age > SCREEN_SUMMARY_MS + FINALE_EFFECT_MS + DEPARTURE_MS) {
            state.batches.delete(id);
        }
    }

    return state;
}

function easedDeparture(progress) {
    const t = Math.max(0, Math.min(1, progress));
    return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}

export class HarborTraffic {
    constructor({ sprites } = {}) {
        this.sprites = sprites || null;
        this.state = cloneState();
        this._pendingRepoSummaries = [];
        this.harborCrates = new Map();
        this.motionScale = 1;
        this.frame = 0;
        if (typeof window !== 'undefined') window.__harbor = this;
    }

    setMotionScale(scale) {
        this.motionScale = scale === 0 ? 0 : 1;
    }

    update(agents, dt = 16, now = Date.now()) {
        this.frame += (dt / 16) * this.motionScale;
        const events = collectGitEventsFromAgents(agents);
        this.state = reduceHarborTrafficState(this.state, events, {
            now,
            motionScale: this.motionScale,
        });
        this._pendingRepoSummaries = pendingRepoSummariesFromDockSummaries(this._repoDockSummaries());
        this._observeHarborCrates(agents, events, now);
        this._observePeakDensity(now);
    }

    getPendingRepoSummaries() {
        return this._pendingRepoSummaries || [];
    }

    getRepoSummaries() {
        const summaries = new Map();
        for (const summary of this._pendingRepoSummaries || []) {
            const profile = summary.profile || repoProfile(summary.project);
            summaries.set(profile.key, {
                project: summary.project,
                repoName: summary.repoName || displayRepoName(summary.project),
                shortName: summary.shortName || profile.shortName,
                profile,
                pendingCommits: Number(summary.pendingCommits) || 0,
                dockedCommits: 0,
                failedPushes: 0,
                latestEventTime: Number(summary.latestEventTime) || 0,
            });
        }
        for (const summary of this._repoDockSummaries().values()) {
            const existing = summaries.get(summary.profile.key) || {
                project: summary.project,
                repoName: displayRepoName(summary.project),
                shortName: summary.profile.shortName,
                profile: summary.profile,
                pendingCommits: 0,
                dockedCommits: 0,
                failedPushes: 0,
                latestEventTime: 0,
            };
            existing.dockedCommits = summary.count;
            existing.failedPushes = summary.failedCount;
            existing.latestEventTime = Math.max(existing.latestEventTime, summary.latestEventTime || 0);
            summaries.set(summary.profile.key, existing);
        }
        return [...summaries.values()]
            .sort((a, b) => (b.failedPushes - a.failedPushes)
                || (b.dockedCommits - a.dockedCommits)
                || (b.pendingCommits - a.pendingCommits)
                || (b.latestEventTime - a.latestEventTime)
                || a.repoName.localeCompare(b.repoName));
    }

    getFailedPushState(now = Date.now()) {
        const repos = new Map();
        let latest = null;
        for (const batch of this.state.batches.values()) {
            if ((batch.status || 'unknown') !== 'failed') continue;
            const age = this._batchSummaryAge(batch, now);
            if (age > SCREEN_SUMMARY_MS + FINALE_EFFECT_MS) continue;
            const profile = repoProfile(batch.project);
            const current = repos.get(profile.key) || {
                project: batch.project,
                repoName: displayRepoName(batch.project),
                shortName: profile.shortName,
                profile,
                failedPushes: 0,
                latestEventTime: 0,
            };
            current.failedPushes += 1;
            current.latestEventTime = Math.max(current.latestEventTime, batch.eventTime || batch.startedAt || 0);
            repos.set(profile.key, current);
            if (!latest || current.latestEventTime > (latest.eventTime || 0)) {
                latest = {
                    id: batch.id,
                    project: batch.project,
                    repoName: current.repoName,
                    shortName: current.shortName,
                    targetRef: batch.targetRef || '',
                    label: batch.label || '',
                    eventTime: current.latestEventTime,
                };
            }
        }
        for (const ship of this.state.ships.values()) {
            if (ship.status !== 'docked' || ship.pushStatus !== 'failed') continue;
            const profile = repoProfile(ship.project);
            const eventTime = Math.max(ship.eventTime || 0, ship.failedAt || 0);
            const current = repos.get(profile.key) || {
                project: ship.project,
                repoName: displayRepoName(ship.project),
                shortName: profile.shortName,
                profile,
                failedPushes: 0,
                latestEventTime: 0,
            };
            current.failedPushes += 1;
            current.latestEventTime = Math.max(current.latestEventTime, eventTime);
            repos.set(profile.key, current);
            if (!latest || eventTime > (latest.eventTime || 0)) {
                latest = {
                    id: ship.pushEventId || ship.id,
                    project: ship.project,
                    repoName: current.repoName,
                    shortName: current.shortName,
                    targetRef: '',
                    label: ship.label || '',
                    eventTime,
                };
            }
        }
        for (const push of this.state.pushEvents.values()) {
            if ((push.status || 'unknown') !== 'failed' || push.batchId || !push.project) continue;
            const profile = repoProfile(push.project);
            const current = repos.get(profile.key) || {
                project: push.project,
                repoName: displayRepoName(push.project),
                shortName: profile.shortName,
                profile,
                failedPushes: 0,
                latestEventTime: 0,
            };
            current.failedPushes += 1;
            current.latestEventTime = Math.max(current.latestEventTime, push.eventTime || 0);
            repos.set(profile.key, current);
            if (!latest || (push.eventTime || 0) > (latest.eventTime || 0)) {
                latest = {
                    id: push.id,
                    project: push.project,
                    repoName: current.repoName,
                    shortName: current.shortName,
                    targetRef: '',
                    label: '',
                    eventTime: push.eventTime || 0,
                };
            }
        }
        const list = [...repos.values()]
            .sort((a, b) => (b.latestEventTime - a.latestEventTime) || a.repoName.localeCompare(b.repoName));
        return {
            hasFailedPush: list.length > 0,
            status: list.length > 0 ? 'failed' : 'ok',
            accent: PUSH_STATUS_STYLE.failed.accent,
            glow: PUSH_STATUS_STYLE.failed.glow,
            intensity: Math.min(1, list.reduce((sum, repo) => sum + repo.failedPushes, 0) / 4),
            latest,
            repos: list,
        };
    }

    _observePeakDensity(now) {
        if (!this._peakWindow) this._peakWindow = { peak: 0, since: now };
        if (this.state.ships.size > this._peakWindow.peak) {
            this._peakWindow.peak = this.state.ships.size;
        }
        if (now - this._peakWindow.since > 60000) {
            if (this._peakWindow.peak >= 8) {
                console.info(`[harbor] peak ships in last minute: ${this._peakWindow.peak}`);
            }
            this._peakWindow = { peak: this.state.ships.size, since: now };
        }
    }

    enumerateDrawables(now = Date.now()) {
        const repoSummaries = this._repoDockSummaries();
        const markers = this._repoQuayDrawables(repoSummaries);
        const markerByRepo = new Map();
        for (const marker of markers) {
            const key = repoProfile(marker.payload?.project).key;
            if (key) markerByRepo.set(key, marker.payload);
        }
        const dockedByRepo = new Map();
        const departing = [];

        for (const ship of this.state.ships.values()) {
            const drawable = this._shipDrawable(ship, now);
            if (!drawable) continue;
            if (drawable.payload.status === 'docked') {
                const key = repoProfile(drawable.payload.project).key;
                const list = dockedByRepo.get(key) || [];
                list.push(drawable);
                dockedByRepo.set(key, list);
            } else {
                departing.push(drawable);
            }
        }

        const visible = [];
        const crateDrawnForKeys = new Set();
        const dockedEntries = [...dockedByRepo.entries()];
        for (const [, list] of dockedEntries) {
            list.sort((a, b) => {
                const aFailed = a.payload.pushStatus === 'failed' ? 1 : 0;
                const bFailed = b.payload.pushStatus === 'failed' ? 1 : 0;
                return (bFailed - aFailed)
                    || ((b.payload.eventTime || 0) - (a.payload.eventTime || 0))
                    || a.payload.id.localeCompare(b.payload.id);
            });
        }
        // Lay docked ships into a global harbor-front queue so repo bursts do
        // not stack multiple boats on the same small set of berth pixels.
        const dockedQueue = [];
        for (const [key, list] of dockedEntries) {
            const summary = repoSummaries.get(key);
            const repoCount = summary?.count || list.length;
            list.forEach((drawable, index) => {
                drawable.payload.repoDockCount = repoCount;
                drawable.payload.repoDockIndex = index;
                drawable.payload.repoDockVisibleCount = list.length;
                drawable.payload.harborCrate = !crateDrawnForKeys.has(key)
                    ? this.harborCrates.get(key) || null
                    : null;
                if (drawable.payload.harborCrate) crateDrawnForKeys.add(key);
                dockedQueue.push(drawable);
            });
        }
        dockedQueue.forEach((drawable, index) => {
            const pos = harborFrontQueuePosition(index, dockedQueue.length);
            drawable.payload.x = pos.x;
            drawable.payload.y = pos.y;
            drawable.payload.harborQueueIndex = index;
            drawable.payload.harborQueueLine = pos.line;
            drawable.payload.harborQueueColumn = pos.column;
            drawable.payload.harborQueueLineCount = pos.lineCount;
            drawable.sortY = drawable.payload.y + REPO_DOCK_SHIP_SORT_OFFSET;
            visible.push(drawable);
        });

        departing.sort((a, b) => ((b.payload.eventTime || 0) - (a.payload.eventTime || 0)) || a.payload.id.localeCompare(b.payload.id));
        for (const drawable of departing.slice(0, MAX_DEPARTING_SHIPS)) {
            visible.push(drawable);
        }
        for (const drawable of this._harborCrateDrawables(markerByRepo, crateDrawnForKeys)) {
            visible.push(drawable);
        }

        return visible.sort((a, b) => a.sortY - b.sortY);
    }

    enumerateWakeDescriptors(now = Date.now()) {
        if (!this.state?.ships?.size) return [];
        const drawables = this.enumerateDrawables(now);
        const wakes = [];
        for (const item of drawables) {
            const drawable = item.payload;
            if (!drawable || drawable.type !== 'ship') continue;
            if (drawable.status === 'docked') {
                const pulse = this.motionScale > 0
                    ? 0.55 + 0.25 * Math.sin(this.frame * 0.08 + drawable.berthIndex)
                    : 0.58;
                wakes.push({
                    type: 'docked',
                    x: drawable.x,
                    y: drawable.y,
                    alpha: 0.08 + pulse * 0.045,
                    radiusX: 26,
                    radiusY: 12,
                    projectAccent: repoProfile(drawable.project).accent,
                });
                continue;
            }
            if (drawable.status === 'departing' && drawable.progress < 0.94) {
                wakes.push({
                    type: 'departing',
                    x: drawable.x,
                    y: drawable.y,
                    tailX: drawable.tailX,
                    tailY: drawable.tailY,
                    alpha: Math.max(0.05, 0.18 * (1 - drawable.progress)),
                    spread: 0.35 + drawable.progress * 0.75,
                    progress: drawable.progress,
                    projectAccent: repoProfile(drawable.project).accent,
                });
            }
        }
        return wakes;
    }

    _harborCrateDrawables(markerByRepo, skipKeys = new Set()) {
        const drawables = [];
        let fallbackIndex = 0;
        for (const [key, crate] of this.harborCrates) {
            if (skipKeys.has(key)) continue;
            const marker = markerByRepo.get(key);
            const quayIndex = assignedQuayIndex(this.state, crate.project);
            const fallbackBerthIndex = QUAY_GROUPS[quayIndex]?.berthIndexes?.[0] ?? fallbackIndex % BERTHS.length;
            const fallbackBerth = BERTHS[fallbackBerthIndex] || BERTHS[0];
            const pos = marker
                ? {
                    x: marker.x + (Number(marker.repoLogIndex || 0) % 2 === 0 ? -86 : 86),
                    y: marker.y + REPO_DOCK_SHIP_Y_OFFSET + 42,
                }
                : toWorld(fallbackBerth.tileX, fallbackBerth.tileY);
            drawables.push({
                kind: 'harbor-traffic',
                sortY: pos.y + REPO_DOCK_SHIP_SORT_OFFSET,
                payload: {
                    type: 'crate',
                    project: crate.project,
                    profile: crate.profile,
                    harborCrate: crate,
                    berthIndex: fallbackBerthIndex,
                    x: pos.x,
                    y: pos.y,
                },
            });
            fallbackIndex += 1;
        }
        return drawables;
    }

    _observeHarborCrates(agents, events, now) {
        for (const event of events || []) {
            if (event?.type !== 'push') continue;
            const key = repoProfile(event.project).key;
            this.harborCrates.delete(key);
        }

        for (const agent of agents || []) {
            if (!agent?.projectPath && !agent?.project) continue;
            if (!isHarborCrateTool(agent)) continue;
            if (agent.targetBuildingType !== 'harbor' && agent.lastKnownBuildingType !== 'harbor') continue;
            const project = agent.projectPath || agent.project || agent.teamName || 'unknown';
            const profile = repoProfile(project);
            this.harborCrates.set(profile.key, {
                project,
                profile,
                agentId: agent.id,
                label: /git\s+diff\b/i.test(`${agent.currentToolInput || ''} ${agent.lastToolInput || ''}`) ? 'DIFF' : 'STAT',
                createdAt: now,
                expiresAt: now + HARBOR_CRATE_TTL_MS,
            });
        }

        for (const [key, crate] of this.harborCrates) {
            if ((crate.expiresAt || 0) <= now) this.harborCrates.delete(key);
        }
    }

    _repoDockSummaries() {
        const summaries = new Map();
        for (const ship of this.state.ships.values()) {
            if (ship.status !== 'docked') continue;
            const profile = repoProfile(ship.project);
            const berth = BERTHS[ship.berthIndex % BERTHS.length];
            if (!berth) continue;
            const pos = toWorld(berth.tileX, berth.tileY);
            const summary = summaries.get(profile.key) || {
                project: ship.project,
                profile,
                quayIndex: Number.isFinite(Number(ship.quayIndex)) ? Number(ship.quayIndex) : assignedQuayIndex(this.state, ship.project),
                count: 0,
                failedCount: 0,
                x: 0,
                y: 0,
                latestEventTime: 0,
            };
            summary.count += 1;
            if (ship.pushStatus === 'failed') summary.failedCount += 1;
            summary.x += pos.x;
            summary.y += pos.y;
            summary.latestEventTime = Math.max(summary.latestEventTime, ship.eventTime || 0);
            summaries.set(profile.key, summary);
        }
        return summaries;
    }

    _repoQuayDrawables(summaries = this._repoDockSummaries()) {
        const ordered = [...summaries.values()]
            .sort((a, b) => (a.quayIndex - b.quayIndex)
                || (b.count - a.count)
                || (b.latestEventTime - a.latestEventTime)
                || a.profile.name.localeCompare(b.profile.name));
        const anchor = toWorld(HARBOR_LOG_TILE.tileX, HARBOR_LOG_TILE.tileY);
        const drawables = [];
        ordered.forEach((summary, index) => {
            const quayIndex = Number.isFinite(Number(summary.quayIndex)) ? Number(summary.quayIndex) : 0;
            drawables.push({
                kind: 'harbor-traffic',
                sortY: anchor.y - 190 + index,
                payload: {
                    type: 'repo-quay',
                    project: summary.project,
                    profile: summary.profile,
                    quayName: QUAY_GROUPS[quayIndex]?.name || 'Quay',
                    count: summary.count,
                    failedCount: summary.failedCount,
                    repoLogIndex: index,
                    x: anchor.x,
                    y: anchor.y - 192 + index * 16,
                },
            });
        });

        return drawables;
    }

    activeFinaleEffects(now = Date.now()) {
        const effects = [];
        for (const batch of this.state.batches.values()) {
            const startedAt = this._batchClockStart(batch, now);
            const age = now - startedAt;
            if (age < 0) continue;
            const status = batch.status || 'unknown';
            const finaleDelay = this._batchFinaleDelay(batch);
            const effectAge = age - finaleDelay;
            if (effectAge < 0 || effectAge > FINALE_EFFECT_MS) continue;
            const origin = this._batchOrigin(batch);
            effects.push({
                ...batch,
                status,
                x: origin.x,
                y: origin.y,
                effectAge,
                progress: Math.max(0, Math.min(1, effectAge / FINALE_EFFECT_MS)),
            });
        }
        return effects.sort((a, b) => (a.startedAt - b.startedAt) || a.id.localeCompare(b.id));
    }

    latestScreenSummary(now = Date.now()) {
        let latest = null;
        for (const batch of this.state.batches.values()) {
            const age = this._batchSummaryAge(batch, now);
            if (age < 0 || age > SCREEN_SUMMARY_MS) continue;
            if (!latest || (batch.startedAt || 0) > (latest.startedAt || 0)) latest = batch;
        }
        return latest;
    }

    _batchFinaleDelay(batch) {
        const status = batch?.status || 'unknown';
        if (status === 'failed' || this.motionScale === 0) return 0;
        return DEPARTURE_MS * 0.96;
    }

    _batchClockStart(batch, now = Date.now()) {
        if ((batch?.status || 'unknown') === 'failed') {
            return batch.statusUpdatedAt || batch.startedAt || now;
        }
        return batch?.startedAt || now;
    }

    _batchSummaryAge(batch, now = Date.now()) {
        return now - this._batchClockStart(batch, now) - this._batchFinaleDelay(batch);
    }

    _batchOrigin(batch) {
        const points = [];
        for (const shipId of batch.shipIds || []) {
            const ship = this.state.ships.get(shipId);
            if (!ship) continue;
            if ((batch.status || 'unknown') === 'failed') {
                const berth = BERTHS[ship.berthIndex % BERTHS.length];
                points.push(toWorld(berth.tileX, berth.tileY));
                continue;
            }
            const lane = SEA_LANES[ship.laneIndex % SEA_LANES.length];
            const endpoint = lane?.[lane.length - 1];
            if (endpoint) points.push(toWorld(endpoint.tileX, endpoint.tileY));
        }
        if (points.length === 0) return toWorld(HARBOR_FINALE_TILE.tileX, HARBOR_FINALE_TILE.tileY);
        const sum = points.reduce((acc, point) => ({
            x: acc.x + point.x,
            y: acc.y + point.y,
        }), { x: 0, y: 0 });
        return {
            x: sum.x / points.length,
            y: sum.y / points.length,
        };
    }

    draw(ctx, drawable, zoom = 1) {
        if (!drawable?.payload) return;
        if (drawable.payload.type === 'cluster') {
            this._drawClusterTag(ctx, drawable.payload, zoom);
            return;
        }
        if (drawable.payload.type === 'repo-quay') {
            this._drawRepoQuayMarker(ctx, drawable.payload, zoom);
            return;
        }
        if (drawable.payload.type === 'crate') {
            const profile = drawable.payload.profile || repoProfile(drawable.payload.project);
            this._drawHarborCrate(ctx, drawable.payload, zoom, 1, profile);
            return;
        }
        this._drawShip(ctx, drawable.payload, zoom);
    }

    drawFinaleEffects(ctx, now = Date.now()) {
        for (const effect of this.activeFinaleEffects(now)) {
            this._drawFinaleEffect(ctx, effect);
        }
    }

    drawScreenSummary(ctx, canvas, camera, now = Date.now()) {
        const summary = this.latestScreenSummary(now);
        if (!summary || !canvas) return;
        const style = PUSH_STATUS_STYLE[summary.status] || PUSH_STATUS_STYLE.unknown;
        const profile = repoProfile(summary.project);
        const age = this._batchSummaryAge(summary, now);
        const fade = this.motionScale === 0
            ? 1
            : Math.min(1, Math.max(0, (SCREEN_SUMMARY_MS - age) / 1600));
        if (fade <= 0) return;

        const project = projectName(summary.project);
        const count = Number(summary.shipCount || 0);
        const commitLabel = count === 1 ? '1 commit' : `${count} commits`;
        const title = summary.status === 'success'
            ? `${commitLabel} successfully pushed`
            : summary.status === 'failed'
                ? 'Push failed'
                : `${commitLabel} sent to sea`;
        const target = summary.targetRef ? ` -> ${summary.targetRef}` : '';
        const detail = `${project}${target}`;
        const width = Math.min(350, Math.max(236, Math.max(title.length, detail.length) * 6.4 + 34));
        const height = 58;
        const origin = this._batchOrigin(summary);
        const screen = camera?.worldToScreen
            ? camera.worldToScreen(origin.x, origin.y)
            : { x: canvas.width - width - 18, y: 72 };
        const minimapW = 150 + 28;
        const minimapH = 150 + 28;
        const maxX = canvas.width - width - 14;
        const maxY = canvas.height - height - 14;
        let x = Math.round(Math.max(14, Math.min(maxX, screen.x - width / 2)));
        let y = Math.round(Math.max(14, Math.min(maxY, screen.y - height - 26)));
        if (x + width > canvas.width - minimapW && y + height > canvas.height - minimapH) {
            y = Math.max(14, canvas.height - minimapH - height - 12);
        }

        ctx.save();
        ctx.globalAlpha = fade;
        ctx.fillStyle = style.panel;
        ctx.fillRect(x, y, width, height);
        ctx.strokeStyle = style.accent;
        ctx.lineWidth = 1;
        ctx.strokeRect(x + 0.5, y + 0.5, width - 1, height - 1);
        ctx.fillStyle = style.accent;
        ctx.fillRect(x, y, 4, height);
        ctx.fillStyle = profile.accent;
        ctx.fillRect(x + 5, y, 3, height);

        ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.fillText(shortenLabel(title, 46), x + 14, y + 10);
        ctx.fillStyle = 'rgba(244, 232, 190, 0.92)';
        ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
        ctx.fillText(shortenLabel(detail, 44), x + 14, y + 29);
        ctx.fillStyle = 'rgba(244, 232, 190, 0.58)';
        ctx.fillRect(x + 14, y + 46, Math.max(34, width - 28), 1);
        ctx.restore();
    }

    _shipDrawable(ship, now) {
        const berth = BERTHS[ship.berthIndex % BERTHS.length];
        const start = toWorld(berth.tileX, berth.tileY);
        let x = start.x;
        let y = start.y;
        let progress = 0;

        if (ship.status === 'departing') {
            const lane = SEA_LANES[ship.laneIndex % SEA_LANES.length];
            const route = [
                start,
                ...lane.map(point => toWorld(point.tileX, point.tileY)),
            ];
            const startedAt = ship.departStartedAt || now;
            progress = this.motionScale === 0 ? 1 : Math.max(0, Math.min(1, (now - startedAt) / DEPARTURE_MS));
            const eased = easedDeparture(progress);
            const pos = pointAlongPath(route, eased);
            const previous = pointAlongPath(route, Math.max(0, eased - 0.035));
            x = pos.x;
            y = pos.y;
            ship.tailX = previous.x;
            ship.tailY = previous.y;
            if (progress >= 1 && this.motionScale === 0) return null;
        }

        return {
            kind: 'harbor-traffic',
            sortY: y,
            payload: {
                ...ship,
                type: 'ship',
                x,
                y,
                tailX: ship.tailX,
                tailY: ship.tailY,
                progress,
                elapsed: Math.max(0, now - (ship.departStartedAt || now)),
            },
        };
    }

    _drawShip(ctx, ship, zoom) {
        const alpha = ship.status === 'departing'
            ? this._departureAlpha(ship)
            : 1;
        if (alpha <= 0.02) return;
        const profile = repoProfile(ship.project);

        // Ship wakes are exported through enumerateWakeDescriptors() so the
        // water layer can render them beneath harbor traffic and buildings.

        if (this.sprites) {
            this.sprites.drawSprite(ctx, SHIP_SPRITE_ID, ship.x, ship.y, { alpha });
        } else {
            this._drawFallbackBoat(ctx, ship.x, ship.y, alpha);
        }
        this._drawRepoFlag(ctx, ship, zoom, alpha, profile);

        if (ship.status === 'docked') {
            this._drawMooringTick(ctx, ship, zoom, profile);
        }
        if (ship.status === 'docked' && ship.pushStatus === 'failed') {
            this._drawFailedPushMark(ctx, ship, zoom);
        }
        if (ship.harborCrate) {
            this._drawHarborCrate(ctx, ship, zoom, alpha, profile);
        }
        this._drawCommitPennant(ctx, ship, zoom, alpha, profile);
    }

    _drawHarborCrate(ctx, ship, zoom, alpha = 1, profile = repoProfile(ship.project)) {
        const s = 1 / Math.max(1, zoom || 1);
        const bob = this.motionScale > 0 ? Math.sin(this.frame * 0.08 + ship.berthIndex) * 1.2 : 0;
        const x = Math.round(ship.x - 18 * s);
        const y = Math.round(ship.y - (19 + bob) * s);
        ctx.save();
        ctx.globalAlpha = 0.94 * alpha;
        if (this.sprites) {
            this.sprites.drawSprite(ctx, 'prop.harborCrates', x, y + 11 * s, { alpha: 0.96 * alpha });
        } else {
            ctx.fillStyle = '#8a5530';
            ctx.strokeStyle = '#2d1c12';
            ctx.lineWidth = Math.max(1, Math.round(1.5 * s));
            ctx.fillRect(x - 9 * s, y - 7 * s, 18 * s, 14 * s);
            ctx.strokeRect(x - 9 * s + 0.5, y - 7 * s + 0.5, 18 * s - 1, 14 * s - 1);
        }
        ctx.fillStyle = profile.accent;
        ctx.fillRect(Math.round(x - 7 * s), Math.round(y - 1 * s), Math.max(1, Math.round(14 * s)), Math.max(1, Math.round(2 * s)));
        ctx.restore();
    }

    _departureAlpha(ship) {
        const elapsed = Number.isFinite(ship.elapsed) ? ship.elapsed : ship.progress * DEPARTURE_MS;
        const fadeStart = DEPARTURE_MS + FADE_DELAY_MS;
        if (elapsed <= fadeStart) return 1;
        return Math.max(0, Math.min(1, 1 - (elapsed - fadeStart) / EXIT_FADE_MS));
    }

    _drawDockedShipWake(ctx, ship, zoom, profile = repoProfile(ship.project)) {
        const s = 1 / Math.max(1, zoom || 1);
        const pulse = this.motionScale > 0
            ? 0.55 + 0.25 * Math.sin(this.frame * 0.08 + ship.berthIndex)
            : 0.62;
        ctx.save();
        ctx.globalAlpha = pulse;
        ctx.strokeStyle = profile.accent;
        ctx.lineWidth = Math.max(1, Math.round(2 * s));
        ctx.beginPath();
        ctx.ellipse(Math.round(ship.x), Math.round(ship.y + 4 * s), 30 * s, 16 * s, -0.18, 0, Math.PI * 2);
        ctx.stroke();
        ctx.globalAlpha = 0.45;
        ctx.fillStyle = profile.glow;
        ctx.beginPath();
        ctx.ellipse(Math.round(ship.x), Math.round(ship.y + 5 * s), 26 * s, 13 * s, -0.18, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
    }

    _drawWake(ctx, ship, alpha = 1) {
        const phase = this.frame * 0.18 + ship.berthIndex;
        const dx = ship.x - (ship.tailX ?? ship.x - 1);
        const dy = ship.y - (ship.tailY ?? ship.y);
        const length = Math.hypot(dx, dy) || 1;
        const ux = dx / length;
        const uy = dy / length;
        const px = -uy;
        const py = ux;
        ctx.save();
        ctx.globalAlpha = Math.max(0.12, 0.34 * (1 - ship.progress)) * alpha;
        ctx.strokeStyle = 'rgba(198, 236, 241, 0.7)';
        ctx.lineWidth = 1;
        for (let i = 0; i < 3; i++) {
            const offset = i * 8 + Math.sin(phase + i) * 2;
            const spread = 4 + i * 2;
            const startBack = 14 + offset;
            const endBack = 30 + offset;
            ctx.beginPath();
            ctx.moveTo(ship.x - ux * startBack + px * spread, ship.y - uy * startBack + py * spread);
            ctx.quadraticCurveTo(
                ship.x - ux * ((startBack + endBack) / 2) + px * Math.sin(phase + i) * 3,
                ship.y - uy * ((startBack + endBack) / 2) + py * Math.sin(phase + i) * 3,
                ship.x - ux * endBack - px * spread,
                ship.y - uy * endBack - py * spread
            );
            ctx.stroke();
        }
        ctx.restore();
    }

    _drawMooringTick(ctx, ship, zoom, profile = repoProfile(ship.project)) {
        const s = 1 / Math.max(1, zoom || 1);
        const style = PUSH_STATUS_STYLE[ship.pushStatus] || PUSH_STATUS_STYLE.success;
        ctx.save();
        ctx.fillStyle = ship.pushStatus ? style.accent : profile.accent;
        ctx.fillRect(Math.round(ship.x + 17 * s), Math.round(ship.y - 23 * s), Math.max(1, Math.round(2 * s)), Math.max(1, Math.round(5 * s)));
        ctx.restore();
    }

    _drawFailedPushMark(ctx, ship, zoom) {
        const s = 1 / Math.max(1, zoom || 1);
        const pulse = this.motionScale > 0
            ? 0.55 + Math.sin(this.frame * 0.16 + ship.berthIndex) * 0.18
            : 0.62;
        ctx.save();
        ctx.globalAlpha = pulse;
        ctx.strokeStyle = PUSH_STATUS_STYLE.failed.accent;
        ctx.lineWidth = Math.max(1, Math.round(2 * s));
        const cx = Math.round(ship.x + 18 * s);
        const cy = Math.round(ship.y - 36 * s);
        ctx.beginPath();
        ctx.arc(cx, cy, 7 * s, 0, Math.PI * 2);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(cx - 3 * s, cy - 3 * s);
        ctx.lineTo(cx + 3 * s, cy + 3 * s);
        ctx.moveTo(cx + 3 * s, cy - 3 * s);
        ctx.lineTo(cx - 3 * s, cy + 3 * s);
        ctx.stroke();
        ctx.restore();
    }

    _drawRepoFlag(ctx, ship, zoom, alpha = 1, profile = repoProfile(ship.project)) {
        const s = 1 / Math.max(1, zoom || 1);
        const x = Math.round(ship.x + 13 * s);
        const y = Math.round(ship.y - 31 * s);
        ctx.save();
        ctx.globalAlpha = 0.92 * alpha;
        ctx.fillStyle = 'rgba(17, 26, 30, 0.82)';
        ctx.fillRect(x, y, Math.max(1, Math.round(2 * s)), Math.max(1, Math.round(14 * s)));
        ctx.fillStyle = profile.accent;
        ctx.beginPath();
        ctx.moveTo(x + 2 * s, y + 1 * s);
        ctx.lineTo(x + 13 * s, y + 5 * s);
        ctx.lineTo(x + 2 * s, y + 9 * s);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
    }

    _drawCommitPennant(ctx, ship, zoom, alpha = 1, profile = repoProfile(ship.project)) {
        const s = 1 / Math.max(1, zoom || 1);
        const label = shortenLabel(ship.label || ship.sha || ship.id, MAX_LABEL_CHARS);
        const style = PUSH_STATUS_STYLE[ship.pushStatus] || PUSH_STATUS_STYLE.success;
        const queueColumn = Number(ship.harborQueueColumn);
        const inHarborQueue = Number.isFinite(Number(ship.harborQueueIndex));
        const repoIndex = Math.max(0, Number(ship.repoDockIndex || 0));
        const repoCount = Math.max(1, Number(ship.repoDockVisibleCount || 1));
        const lane = inHarborQueue
            ? (queueColumn % 2 === 0 ? -0.34 : 0.34)
            : repoCount > 1 ? repoIndex - (repoCount - 1) / 2 : 0;
        const textSize = Math.max(7, Math.round(8 * s));
        const maxWidth = inHarborQueue ? 96 * s : 142 * s;
        const width = Math.max(42 * s, Math.min(maxWidth, label.length * textSize * 0.62 + 12 * s));
        const x = Math.round(ship.x - width / 2 + lane * 22 * s);
        const labelTier = inHarborQueue ? queueColumn % 2 : repoIndex;
        const y = Math.round(ship.y - (44 + labelTier * 11) * s);
        const height = 12 * s;
        ctx.save();
        ctx.globalAlpha = 0.94 * alpha;
        ctx.fillStyle = 'rgba(24, 42, 39, 0.9)';
        ctx.fillRect(x, y, Math.round(width), Math.round(height));
        ctx.strokeStyle = ship.pushStatus ? style.accent : profile.accent;
        ctx.strokeRect(x + 0.5, y + 0.5, Math.round(width) - 1, Math.round(height) - 1);
        ctx.fillStyle = profile.accent;
        ctx.fillRect(x, y, Math.max(2, Math.round(4 * s)), Math.round(height));
        ctx.fillStyle = ship.pushStatus ? style.accent : profile.accent;
        ctx.font = `${textSize}px ui-monospace, SFMono-Regular, Menlo, monospace`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(label, Math.round(ship.x + 2 * s), Math.round(y + height / 2 + 0.5));
        ctx.fillStyle = ship.pushStatus ? style.accent : profile.accent;
        ctx.fillRect(Math.round(ship.x - 22 * s), Math.round(ship.y - 31 * s), Math.max(1, Math.round(3 * s)), Math.max(1, Math.round(11 * s)));
        ctx.restore();
    }

    _drawFinaleEffect(ctx, effect) {
        const style = PUSH_STATUS_STYLE[effect.status] || PUSH_STATUS_STYLE.unknown;
        const progress = Math.max(0, Math.min(1, effect.progress || 0));
        const alpha = this.motionScale === 0 ? 0.78 : Math.max(0, 1 - progress);
        const wave = this.motionScale === 0 ? 0.55 : Math.sin(progress * Math.PI);
        const summary = toWorld(HARBOR_SUMMARY_TILE.tileX, HARBOR_SUMMARY_TILE.tileY);
        const count = Math.max(1, Number(effect.shipCount || 1));
        const intensity = Math.max(1, Math.min(4, Math.sqrt(count)));
        const burstCount = Math.min(28, 8 + count * 2);

        ctx.save();
        ctx.globalCompositeOperation = effect.status === 'failed' ? 'source-over' : 'screen';
        ctx.globalAlpha = Math.max(0.18, alpha);
        ctx.strokeStyle = style.accent;
        ctx.fillStyle = style.glow;
        ctx.lineWidth = 2;

        if (effect.status === 'failed') {
            const radius = 20 + wave * 12;
            ctx.beginPath();
            ctx.arc(effect.x, effect.y - 24, radius, 0, Math.PI * 2);
            ctx.stroke();
            ctx.beginPath();
            ctx.moveTo(effect.x - 11, effect.y - 35);
            ctx.lineTo(effect.x + 11, effect.y - 13);
            ctx.moveTo(effect.x + 11, effect.y - 35);
            ctx.lineTo(effect.x - 11, effect.y - 13);
            ctx.stroke();
        } else {
            for (let i = 0; i < Math.ceil(intensity) + 1; i++) {
                const ringProgress = Math.max(0, Math.min(1, progress * 1.18 - i * 0.14));
                const ring = 24 + ringProgress * (54 + intensity * 14);
                ctx.globalAlpha = Math.max(0.08, alpha * (1 - i * 0.16));
                ctx.beginPath();
                ctx.ellipse(effect.x, effect.y, ring, ring * 0.34, -0.22, 0, Math.PI * 2);
                ctx.stroke();
            }
            ctx.globalAlpha = Math.max(0.10, alpha * 0.55);
            ctx.beginPath();
            ctx.moveTo(summary.x - 8, summary.y - 72);
            ctx.lineTo(effect.x + 72, effect.y - 18);
            ctx.lineTo(effect.x - 18, effect.y + 12);
            ctx.closePath();
            ctx.fill();

            ctx.globalAlpha = Math.max(0.22, alpha * 0.88);
            for (let i = 0; i < burstCount; i++) {
                const seed = stableHash(`${effect.id}:${i}`);
                const angle = (seed % 628) / 100;
                const distance = 20 + ((seed >> 3) % 52) * (0.45 + progress * 0.7) * intensity / 2;
                const size = 1 + (seed % 3);
                const x = effect.x + Math.cos(angle) * distance;
                const y = effect.y + Math.sin(angle) * distance * 0.38;
                ctx.fillRect(Math.round(x), Math.round(y), size, size);
            }
        }

        ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = Math.max(0.48, alpha);
        ctx.fillStyle = style.accent;
        ctx.font = '9px ui-monospace, SFMono-Regular, Menlo, monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(style.shortLabel, Math.round(effect.x), Math.round(effect.y - 52));
        ctx.restore();
    }

    _drawClusterTag(ctx, payload, zoom) {
        const s = 1 / Math.max(1, zoom || 1);
        const label = `+${payload.count}`;
        const width = Math.max(18, label.length * 6 + 8) * s;
        const height = 13 * s;
        const x = payload.x - width / 2;
        const y = payload.y - 34 * s;

        ctx.save();
        ctx.fillStyle = 'rgba(27, 43, 48, 0.86)';
        ctx.fillRect(Math.round(x), Math.round(y), Math.round(width), Math.round(height));
        ctx.strokeStyle = 'rgba(242, 211, 107, 0.82)';
        ctx.strokeRect(Math.round(x) + 0.5, Math.round(y) + 0.5, Math.round(width) - 1, Math.round(height) - 1);
        ctx.fillStyle = '#f2d36b';
        ctx.font = `${Math.max(8, Math.round(10 * s))}px ui-monospace, SFMono-Regular, Menlo, monospace`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(label, Math.round(payload.x), Math.round(y + height / 2));
        ctx.restore();
    }

    _drawRepoQuayMarker(ctx, payload, zoom) {
        const s = 1 / Math.max(1, zoom || 1);
        const profile = payload.profile || repoProfile(payload.project);
        const count = Math.max(1, Number(payload.count || 1));
        const name = shortenLabel(displayRepoName(payload.project), count >= 100 ? 18 : 20);
        const label = `${name} (${count})`;
        const textSize = Math.max(7, Math.round(9 * s));
        const width = Math.max(92 * s, Math.min(172 * s, label.length * textSize * 0.58 + 18 * s));
        const height = 16 * s;
        const x = Math.round(payload.x - width / 2);
        const y = Math.round(payload.y - height / 2);
        const failed = Number(payload.failedCount || 0) > 0;

        ctx.save();
        ctx.globalAlpha = 0.94;
        ctx.fillStyle = 'rgba(20, 30, 34, 0.88)';
        ctx.fillRect(x, y, Math.round(width), Math.round(height));
        ctx.strokeStyle = failed ? PUSH_STATUS_STYLE.failed.accent : profile.accent;
        ctx.lineWidth = 1;
        ctx.strokeRect(x + 0.5, y + 0.5, Math.round(width) - 1, Math.round(height) - 1);
        ctx.fillStyle = profile.accent;
        ctx.fillRect(x, y, Math.max(3, Math.round(5 * s)), Math.round(height));

        ctx.globalAlpha = 1;
        ctx.fillStyle = failed ? PUSH_STATUS_STYLE.failed.accent : '#f5e8be';
        ctx.font = `${textSize}px ui-monospace, SFMono-Regular, Menlo, monospace`;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(label, Math.round(x + 10 * s), Math.round(y + height / 2 + 0.5));
        ctx.restore();
    }

    _drawFallbackBoat(ctx, x, y, alpha) {
        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.fillStyle = '#6a3f2a';
        ctx.beginPath();
        ctx.moveTo(x - 20, y + 5);
        ctx.lineTo(x + 17, y - 4);
        ctx.lineTo(x + 10, y + 10);
        ctx.lineTo(x - 13, y + 14);
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = '#d9c99a';
        ctx.fillRect(Math.round(x - 3), Math.round(y - 23), 3, 22);
        ctx.fillStyle = '#9fb9b5';
        ctx.beginPath();
        ctx.moveTo(x, y - 22);
        ctx.lineTo(x + 13, y - 9);
        ctx.lineTo(x + 1, y - 7);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
    }
}
