// Harbor semantic state: the reducer from normalized git events to ships,
// push batches, replay floors, tombstones and anchorage claims, plus its
// pruning and snapshot. Pure: no canvas, no sprites, no colour registry
// (display names are injected through `options.repoDisplayName`), so it runs
// in node without the art graph. HarborLayout.js places what this module
// decides; HarborTraffic.js adapts agents into events and draws the result.
import {
    cleanCommitSubject,
    commitMessageFromCommand,
    normalizeRepoBranch,
    projectNameFromPath,
    shortGitLabel,
} from '../shared/GitEventIdentity.js';
import {
    BERTHS,
    COAST_ANCHORAGE_SLOTS,
    COMMIT_LAGOON_ROUTE_BANDS,
    HARBOR_ANCHORAGE_VERSION,
    HARBOR_SLOT_FILL_ORDER,
    HARBOR_SQUAD_ANCHORAGES,
    LOCAL_WATER_ROUTE_BANDS,
    QUAY_GROUPS,
    SEA_LANES,
    buildDockLayoutFresh,
    buildDockSquadLayout,
    compactRouteMetadata,
    composeWaterRouteTiles,
    harborCruiseSpeed,
    planPackThresholds,
    harborHullLengthTiles,
    harborSailDurationMs,
    isCommitLagoonZone,
    repoAnchorageKey,
    routeGraphMetadata,
    routeLengthTiles,
    routeSeaTile,
    stableHash,
    toWorld,
    waterRouteMetadataForBand,
} from './HarborLayout.js';

// The display name a ship or batch records when the caller injects none:
// the repo's basename, with the branch after a slash.
export function defaultRepoDisplayName(project, branch = '') {
    const repo = shortGitLabel(projectNameFromPath(project), 16, '…');
    const normalizedBranch = normalizeRepoBranch(branch);
    return normalizedBranch ? `${repo}/${shortGitLabel(normalizedBranch, 10, '…')}` : repo;
}

export const DEPARTURE_MS = 48000;
export const DEPARTURE_STAGGER_MS = 720;
export const EXIT_HOLD_MS = 1800;
export const EXIT_FADE_MS = 4200;
export const FADE_DELAY_MS = 3200;
export const FINALE_EFFECT_MS = 9000;
export const SCREEN_SUMMARY_MS = 16000;
export const RECENT_PUSH_REPLAY_MS = 2 * 60 * 1000;
export const HARBOR_REPLAY_GRACE_MS = 60 * 1000;
export const HARBOR_REPLAY_RETENTION_MS = RECENT_PUSH_REPLAY_MS + HARBOR_REPLAY_GRACE_MS;
export const MAX_HARBOR_SHIPS = 2048;
export const MAX_HARBOR_SEEN_EVENT_IDS = 2048;
export const MAX_HARBOR_PUSH_EVENTS = 1024;
export const MAX_HARBOR_BATCHES = 512;
export const MAX_HARBOR_REPO_QUAYS = 512;
export const MAX_HARBOR_EVENT_TOMBSTONES = 4096;
export const MAX_HARBOR_COMMIT_REPLAY_FLOORS = 1024;
export const MAX_HARBOR_OVERFLOW_DOCK_COUNTS = 512;
export const MAX_HARBOR_EVENT_IDS_PER_SHIP = 64;
export const MAX_HARBOR_LANDED_PUSH_REPOS = 512;
export const HARBOR_OVERFLOW_OTHER_KEY = '\x00other-repositories';
export const COMMIT_EQUIVALENCE_WINDOW_MS = 10 * 60 * 1000;
export const FORCE_DEPARTURE_MS = 12000;
export const BOOMERANG_OUT_MS = 16000;
export const BOOMERANG_IN_MS = 12000;

// 5.11 — cancelled pushes return to berth half-speed with no collision flare.
export const CANCEL_RETURN_MS = 12000;
export const INBOUND_DURATION_MS = 36000;
export const SCUTTLE_MS = 1500;

// W7.9 (SW-P9) — the pull-request cutter: `gh pr create` moors one at the
// outer roadstead for as long as an open PR plausibly waits (PR_SHIP_MOOR_MS
// from its creation), `gh pr merge` sails it in to a quay berth over
// PR_MERGE_SAIL_MS, where it lies PR_QUAY_HOLD_MS before retiring. Its one
// mark is a parchment pennant above the repo flag (no new hull art).
export const PR_SHIP_MOOR_MS = 2 * 60 * 60 * 1000;
export const PR_QUAY_HOLD_MS = 10 * 60 * 1000;
export const PR_MERGE_SAIL_MS = 20000;
export const PR_ROADSTEAD_ROWS = 3;
export const RELEASE_CONVOY_MIN_SHIPS = 2;

// The repo identity of a normalized event (wire contract v1): the server's
// `repoRoot` when it resolved one, else the session project. The reducer
// works on events whose `project` is that key; `checkout` keeps the path the
// command ran in.
export function harborRepoKey(event = {}) {
    return String(event.repoRoot || event.project || 'unknown');
}

export function harborRepoEvent(event) {
    if (!event.repoRoot || event.repoRoot === event.project) return event;
    return { ...event, project: event.repoRoot, checkout: event.checkout || event.project };
}

const REF_STATUS_OUTCOME = Object.freeze({ ok: 'success', 'up-to-date': 'success', rejected: 'rejected', failed: 'failed' });

// Per-ref partial acceptance: a push whose refs report different outcomes
// (main rejected, feature accepted) acts as one push per outcome, so the
// accepted branch sails and the rejected one boomerangs. Landed shas belong
// to the accepted part.
export function splitPartialPush(event) {
    if (event.type !== 'push' || !Array.isArray(event.refs) || event.refs.length < 2) return [event];
    const groups = new Map();
    for (const ref of event.refs) {
        const outcome = REF_STATUS_OUTCOME[String(ref?.status || '').toLowerCase()] || '';
        const list = groups.get(outcome) || [];
        list.push(ref);
        groups.set(outcome, list);
    }
    if (groups.size < 2 || groups.has('')) return [event];
    return [...groups.entries()].map(([outcome, refs]) => {
        const success = outcome === 'success';
        const part = {
            ...event,
            id: `${event.id}#${outcome}`,
            branch: normalizeRepoBranch(refs.find(ref => ref?.tag !== true && ref?.deleted !== true)?.src || ''),
            refs,
            status: outcome,
            success,
            exitCode: success ? 0 : (event.exitCode || 1),
        };
        if (!success) delete part.landedShas;
        return part;
    });
}

// Every branch an event names: a scanned commit's `branches` set (first
// entry = `branch`), else its single branch.
export function eventBranches(event = {}) {
    const names = new Set(Array.isArray(event.branches) ? event.branches.map(normalizeRepoBranch).filter(Boolean) : []);
    const branch = eventBranch(event);
    if (branch) names.add(branch);
    return [...names];
}

export function eventBranch(event = {}) {
    return normalizeRepoBranch(event.branch || event.targetRef || '');
}

export function trafficIdentity(project, branch = '') {
    return `${String(project || 'unknown')}\x1f${normalizeRepoBranch(branch)}`;
}

export const HARBOR_CLEAN_LABEL_CACHE_LIMIT = 512;
const _cleanCommitLabelCache = new Map();

export function boundedCacheValue(cache, key, create, limit) {
    if (cache.has(key)) return cache.get(key);
    const value = create();
    cache.set(key, value);
    if (cache.size > limit) cache.delete(cache.keys().next().value);
    return value;
}

export function cachedCleanCommitSubject(value) {
    const key = String(value || '');
    return boundedCacheValue(
        _cleanCommitLabelCache,
        key,
        () => cleanCommitSubject(key),
        HARBOR_CLEAN_LABEL_CACHE_LIMIT,
    );
}

export function boundedEventConfidence(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return null;
    return Math.max(0, Math.min(1, numeric));
}

export function gitEventSourceLabel(event = {}) {
    const explicit = event.source || event.eventSource || event.sourceType || event.origin || '';
    if (explicit) return String(explicit);
    if (event.command) return 'command-parser';
    return event.inferred === true ? 'inferred' : 'observed';
}

export function gitEventStatusLabel(event = {}) {
    if (event.status) return String(event.status);
    if (event.success === true) return 'success';
    if (event.success === false) return 'failed';
    return 'unknown';
}

export function gitEventRefLabel(event = {}, branch = '') {
    return String(event.ref || event.refspec || event.targetRef || branch || event.upstream || '');
}

export function gitEventDebugMetadata(event = {}, branch = '') {
    const inferred = event.inferred === true;
    return {
        gitKind: event.type ? String(event.type) : '',
        eventStatus: gitEventStatusLabel(event),
        remote: event.remote ? String(event.remote) : '',
        ref: gitEventRefLabel(event, branch),
        refspec: event.refspec ? String(event.refspec) : '',
        source: gitEventSourceLabel(event),
        sourceId: event.sourceId ? String(event.sourceId) : '',
        confidence: boundedEventConfidence(event.confidence),
        inferred,
        observed: event.observed === true || (!inferred && event.observed !== false),
        sessionId: event.sessionId ? String(event.sessionId) : '',
        agentId: event.agentId ? String(event.agentId) : '',
        agentName: event.agentName ? String(event.agentName) : '',
        completedAt: Number(event.completedAt || event.completed_at || 0) || 0,
    };
}

export function inboundGitLabel(event = {}, branch = '') {
    const type = event.type === 'fetch' ? 'fetch' : 'pull';
    const parts = [type, event.remote || '', event.targetRef || event.ref || event.refspec || branch || ''].filter(Boolean);
    return shortGitLabel(parts.join(' '), 22, '…') || type;
}

export function rotateIndexes(indexes, offset) {
    const list = Array.isArray(indexes) ? indexes : [];
    if (list.length <= 1) return [...list];
    const start = Math.abs(offset || 0) % list.length;
    return [...list.slice(start), ...list.slice(0, start)];
}

export function cloneState(previous = {}) {
    previous = previous || {};
    const seenEventIds = previous.seenEventIds instanceof Set
        ? new Set(previous.seenEventIds)
        : new Set(previous.seenEventIds || []);
    const sourceShips = previous.ships instanceof Map
        ? previous.ships.entries()
        : Object.entries(previous.ships || {});
    const ships = new Map();
    for (const [id, ship] of sourceShips) {
        ships.set(id, {
            ...ship,
            eventIds: Array.isArray(ship.eventIds) ? [...ship.eventIds] : [ship.id].filter(Boolean),
            branches: Array.isArray(ship.branches) ? [...ship.branches] : [normalizeRepoBranch(ship.branch)].filter(Boolean),
            shas: Array.isArray(ship.shas) ? [...ship.shas] : [normalizeSha(ship.sha)].filter(Boolean),
            route: compactRouteMetadata(ship.route),
            convoy: ship.convoy ? { ...ship.convoy } : null,
        });
    }
    const sourceBatches = previous.batches instanceof Map
        ? previous.batches.entries()
        : Object.entries(previous.batches || {});
    const batches = new Map();
    for (const [id, batch] of sourceBatches) {
        const next = {
            ...batch,
            shipIds: Array.isArray(batch.shipIds) ? [...batch.shipIds] : [],
            route: compactRouteMetadata(batch.route),
            convoy: batch.convoy ? { ...batch.convoy } : null,
        };
        if (Array.isArray(batch.sealedOriginPoints)) {
            next.sealedOriginPoints = batch.sealedOriginPoints.map(p => ({ x: p.x, y: p.y }));
        }
        batches.set(id, next);
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
    const sourceSeenEventTimes = previous.seenEventTimes instanceof Map
        ? previous.seenEventTimes.entries()
        : Object.entries(previous.seenEventTimes || {});
    const seenEventTimes = new Map();
    for (const [id, timestamp] of sourceSeenEventTimes) {
        const value = Number(timestamp);
        if (id && Number.isFinite(value)) seenEventTimes.set(id, value);
    }
    const sourceSeenEventSignatures = previous.seenEventSignatures instanceof Map
        ? previous.seenEventSignatures.entries()
        : Object.entries(previous.seenEventSignatures || {});
    const seenEventSignatures = new Map();
    for (const [id, signature] of sourceSeenEventSignatures) {
        if (id && seenEventIds.has(id)) seenEventSignatures.set(id, String(signature));
    }
    const containmentRepos = new Set(previous.containmentRepos instanceof Set
        ? previous.containmentRepos
        : (previous.containmentRepos || []));
    const sourceLastLandedPushAt = previous.lastLandedPushAt instanceof Map
        ? previous.lastLandedPushAt.entries()
        : Object.entries(previous.lastLandedPushAt || {});
    const lastLandedPushAt = new Map();
    for (const [project, timestamp] of sourceLastLandedPushAt) {
        const value = Number(timestamp);
        if (project && Number.isFinite(value) && value > 0) lastLandedPushAt.set(project, value);
    }
    const sourceEventTombstones = previous.eventTombstones instanceof Map
        ? previous.eventTombstones.entries()
        : Object.entries(previous.eventTombstones || {});
    const eventTombstones = new Map();
    for (const [id, tombstone] of sourceEventTombstones) {
        if (!id) continue;
        eventTombstones.set(id, typeof tombstone === 'object' && tombstone
            ? { ...tombstone }
            : { removedAt: Number(tombstone) || 0 });
    }
    const sourceCommitReplayFloors = previous.commitReplayFloors instanceof Map
        ? previous.commitReplayFloors.entries()
        : Object.entries(previous.commitReplayFloors || {});
    const commitReplayFloors = new Map();
    for (const [identity, floor] of sourceCommitReplayFloors) {
        const eventTime = Number(typeof floor === 'object' ? floor?.eventTime : floor);
        if (!identity || !Number.isFinite(eventTime) || eventTime <= 0) continue;
        commitReplayFloors.set(identity, typeof floor === 'object' && floor
            ? { ...floor, eventTime }
            : { eventTime, recordedAt: 0 });
    }
    const sourceOverflowDockCounts = previous.overflowDockCounts instanceof Map
        ? previous.overflowDockCounts.entries()
        : Object.entries(previous.overflowDockCounts || {});
    const overflowDockCounts = new Map();
    for (const [identity, overflow] of sourceOverflowDockCounts) {
        const count = Math.max(0, Number(overflow?.count || 0));
        if (!identity || count <= 0) continue;
        overflowDockCounts.set(identity, { ...overflow, count });
    }
    const sourceRepoAnchorages = previous.repoAnchorages instanceof Map
        ? previous.repoAnchorages.entries()
        : Object.entries(previous.repoAnchorages || {});
    const repoAnchorages = new Map();
    for (const [project, slot] of sourceRepoAnchorages) {
        const index = Number(slot);
        if (!project || !Number.isInteger(index) || index < 0 || index >= COAST_ANCHORAGE_SLOTS.length) continue;
        repoAnchorages.set(project, index);
    }
    const state = {
        seenEventIds,
        seenEventTimes,
        seenEventSignatures,
        lastLandedPushAt,
        containmentRepos,
        eventTombstones,
        commitReplayFloors,
        overflowDockCounts,
        ships,
        batches,
        pushEvents,
        repoQuays,
        repoAnchorages,
        nextSequence: Number.isFinite(previous.nextSequence) ? previous.nextSequence : ships.size,
        nextBatchSequence: Number.isFinite(previous.nextBatchSequence) ? previous.nextBatchSequence : batches.size,
        anchorageVersion: HARBOR_ANCHORAGE_VERSION,
        packThresholds: new Map(previous.packThresholds instanceof Map ? previous.packThresholds : []),
    };
    if ((Number(previous.anchorageVersion) || 1) < HARBOR_ANCHORAGE_VERSION) migrateRepoAnchorages(state);
    return state;
}

// D2 — a state laid out under an older claim order (before the pier berths)
// re-claims once: its most active repos (most docked ships, then the latest
// commit) move into free slots that the current order would hand out
// before the slot they hold, best first. Docked ships then sail to the new
// moorings by the renderer's water relocation.
export function migrateRepoAnchorages(state) {
    if (!state.repoAnchorages.size) return;
    const activity = new Map();
    for (const ship of state.ships.values()) {
        if (ship.status !== 'docked') continue;
        const key = repoAnchorageKey(ship.project);
        const entry = activity.get(key) || { docked: 0, latest: 0 };
        entry.docked += 1;
        entry.latest = Math.max(entry.latest, Number(ship.eventTime) || 0);
        activity.set(key, entry);
    }
    const rank = (slot) => HARBOR_SLOT_FILL_ORDER.indexOf(slot);
    const repos = [...state.repoAnchorages.keys()].sort((a, b) => {
        const x = activity.get(a) || { docked: 0, latest: 0 };
        const y = activity.get(b) || { docked: 0, latest: 0 };
        return (y.docked - x.docked) || (y.latest - x.latest) || a.localeCompare(b);
    });
    for (const key of repos) {
        const held = state.repoAnchorages.get(key);
        const used = new Set(state.repoAnchorages.values());
        const better = HARBOR_SLOT_FILL_ORDER.find(slot => !used.has(slot) && rank(slot) < rank(held));
        if (better != null) state.repoAnchorages.set(key, better);
    }
}

// Home Waters allocation lives in the semantic state so the dock layout, the
// push reducer (departure start tiles) and the buoy drawables all agree on
// which coastal slot a repo owns. First come keeps its slot until it has no
// docked ships and no live agent; slots are claimed in COAST_ANCHORAGE_SLOTS
// order so the fleet spreads along the coast. Returns the slot index or null
// when the pool is exhausted (the repo then docks in the Commit Lagoon).
export function ensureRepoAnchorage(state, project) {
    const key = repoAnchorageKey(project);
    const existing = state.repoAnchorages.get(key);
    if (Number.isInteger(existing)) return existing;
    const used = new Set(state.repoAnchorages.values());
    // D2 — the Harbor's pier berths first, the lagoon and coast after.
    for (const slot of HARBOR_SLOT_FILL_ORDER) {
        if (used.has(slot)) continue;
        state.repoAnchorages.set(key, slot);
        return slot;
    }
    return null;
}

export function syncRepoAnchorages(state, activeProjects = null) {
    const keep = new Set();
    for (const ship of state.ships.values()) {
        if (ship.status === 'docked') keep.add(repoAnchorageKey(ship.project));
    }
    for (const project of activeProjects || []) keep.add(repoAnchorageKey(project));
    for (const key of [...state.repoAnchorages.keys()]) {
        if (!keep.has(key)) state.repoAnchorages.delete(key);
    }
    for (const key of keep) ensureRepoAnchorage(state, key);
}

export function markHarborEventSeen(state, event, now) {
    if (!event?.id) return;
    state.seenEventIds.add(event.id);
    const eventTime = Number(event.timestamp);
    state.seenEventTimes.set(event.id, Number.isFinite(eventTime) && eventTime > 0 ? eventTime : now);
}

export function harborEventStatus(event = {}) {
    return gitEventStatusLabel(event).toLowerCase();
}

export function tombstoneHarborEvent(state, event, now, overrides = {}) {
    const id = typeof event === 'string' ? event : event?.id;
    if (!id) return;
    const source = typeof event === 'object' && event ? event : {};
    const eventTime = Number(overrides.eventTime ?? source.timestamp ?? source.eventTime ?? 0) || 0;
    const tombstone = {
        type: String(overrides.type || source.type || ''),
        status: String(overrides.status || source.status || ''),
        eventTime,
        removedAt: now,
    };
    state.eventTombstones.delete(id);
    state.eventTombstones.set(id, tombstone);
    while (state.eventTombstones.size > MAX_HARBOR_EVENT_TOMBSTONES) {
        state.eventTombstones.delete(state.eventTombstones.keys().next().value);
    }
}

export function harborEventIsTombstoned(state, event) {
    const tombstone = state.eventTombstones.get(event?.id);
    if (!tombstone) return false;
    if (event.type !== 'push') return true;
    if (tombstone.type && tombstone.type !== 'push') return false;
    return String(tombstone.status || 'unknown').toLowerCase() === harborEventStatus(event);
}

export function recordCommitReplayFloor(state, project, branch, eventTime, now) {
    const timestamp = Number(eventTime);
    if (!Number.isFinite(timestamp) || timestamp <= 0) return;
    const identity = trafficIdentity(project, branch);
    const previous = state.commitReplayFloors.get(identity);
    const next = {
        eventTime: Math.max(timestamp, Number(previous?.eventTime || 0)),
        recordedAt: now,
    };
    state.commitReplayFloors.delete(identity);
    state.commitReplayFloors.set(identity, next);
    while (state.commitReplayFloors.size > MAX_HARBOR_COMMIT_REPLAY_FLOORS) {
        state.commitReplayFloors.delete(state.commitReplayFloors.keys().next().value);
    }
}

// S-H2 — a floor applies to its own (repo, branch) lane only. A branch-less
// floor (a retired branch-less ship) never reaches a named branch, so no
// push or retirement can silently drop another branch's late commits.
// P1-1 — once a repo's pushes carry verified `landedShas`, a sha-bearing
// commit is judged by sha publication only: a lane floor would also bury a
// commit the server explicitly left out of the landed set.
export function commitIsAtOrBelowReplayFloor(state, event, containment = false) {
    const eventTime = Number(event?.timestamp);
    if (!Number.isFinite(eventTime) || eventTime <= 0) return false;
    if (containment && normalizeSha(event.sha)) return false;
    const floor = Number(state.commitReplayFloors.get(trafficIdentity(event.project, eventBranch(event)))?.eventTime || 0);
    return floor > 0 && eventTime <= floor;
}

export function mergeHarborOverflowRecord(target, source, now) {
    target.count = Math.max(0, Number(target.count || 0)) + Math.max(0, Number(source.count || 0));
    target.failedCount = Math.max(0, Number(target.failedCount || 0)) + Math.max(0, Number(source.failedCount || 0));
    const earliest = [target.earliestEventTime, source.earliestEventTime]
        .map(Number)
        .filter(value => Number.isFinite(value) && value > 0);
    target.earliestEventTime = earliest.length ? Math.min(...earliest) : 0;
    target.latestEventTime = Math.max(Number(target.latestEventTime || 0), Number(source.latestEventTime || 0));
    target.updatedAt = now;
    return target;
}

export function foldHarborOverflowRecord(state, record, now) {
    const other = state.overflowDockCounts.get(HARBOR_OVERFLOW_OTHER_KEY) || {
        project: 'Additional repositories',
        branch: '',
        waitingZone: 'harbor',
        quayIndex: 0,
        count: 0,
        failedCount: 0,
        earliestEventTime: 0,
        latestEventTime: 0,
        aggregate: true,
    };
    state.overflowDockCounts.delete(HARBOR_OVERFLOW_OTHER_KEY);
    state.overflowDockCounts.set(HARBOR_OVERFLOW_OTHER_KEY, mergeHarborOverflowRecord(other, record, now));
}

export function pruneHarborOverflowDockCounts(state, now) {
    while (state.overflowDockCounts.size > MAX_HARBOR_OVERFLOW_DOCK_COUNTS) {
        const entry = [...state.overflowDockCounts.entries()]
            .find(([identity]) => identity !== HARBOR_OVERFLOW_OTHER_KEY);
        if (!entry) break;
        state.overflowDockCounts.delete(entry[0]);
        foldHarborOverflowRecord(state, entry[1], now);
    }
}

export function recordHarborDockOverflow(state, ship, now) {
    const project = String(ship?.project || 'unknown');
    const branch = normalizeRepoBranch(ship?.branch || ship?.targetRef || '');
    const waitingZone = ship?.waitingZone || 'harbor';
    const identity = `${trafficIdentity(project, branch)}\x1f${waitingZone}`;
    const eventTime = Number(ship?.eventTime || 0);
    const record = state.overflowDockCounts.get(identity) || {
        project,
        branch,
        waitingZone,
        quayIndex: Number.isFinite(Number(ship?.quayIndex)) ? Number(ship.quayIndex) : 0,
        count: 0,
        failedCount: 0,
        earliestEventTime: eventTime,
        latestEventTime: eventTime,
        aggregate: false,
    };
    mergeHarborOverflowRecord(record, {
        count: 1,
        failedCount: ship?.pushStatus === 'failed' ? 1 : 0,
        earliestEventTime: eventTime,
        latestEventTime: eventTime,
    }, now);
    state.overflowDockCounts.delete(identity);
    if (state.overflowDockCounts.size >= MAX_HARBOR_OVERFLOW_DOCK_COUNTS) {
        foldHarborOverflowRecord(state, record, now);
    } else {
        state.overflowDockCounts.set(identity, record);
    }
    pruneHarborOverflowDockCounts(state, now);
}

export function clearHarborDockOverflowForPush(state, event, pushTime, target = pushTarget(event)) {
    for (const [identity, record] of state.overflowDockCounts) {
        if (record.aggregate || !pushMatchesShip(event, record, target)) continue;
        const latest = Number(record.latestEventTime || 0);
        if (!pushTime || !latest || latest <= pushTime) state.overflowDockCounts.delete(identity);
    }
}

export function harborOverflowDockCount(state) {
    let total = 0;
    for (const record of state?.overflowDockCounts?.values?.() || []) {
        total += Math.max(0, Number(record?.count || 0));
    }
    return total;
}

export function latestShipEventTime(state, ship) {
    let latest = Number(ship?.eventTime || 0);
    for (const id of ship?.eventIds || []) {
        latest = Math.max(latest, Number(state.seenEventTimes.get(id) || 0));
    }
    return latest;
}

export function retireHarborShip(state, id, ship, now, { recordFloor = true } = {}) {
    if (!ship) return;
    const ids = new Set([ship.id, ...(ship.eventIds || [])].filter(Boolean));
    const eventTime = latestShipEventTime(state, ship);
    const type = ship.gitKind || (ship.isInbound ? ship.arrivingKind : 'commit') || '';
    for (const eventId of ids) {
        tombstoneHarborEvent(state, eventId, now, {
            type,
            eventTime: Number(state.seenEventTimes.get(eventId) || eventTime || 0),
        });
    }
    if (recordFloor && type === 'commit') {
        recordCommitReplayFloor(state, ship.project, ship.branch || ship.targetRef || '', eventTime, now);
    }
    state.ships.delete(id);
}

// A ship whose reports left the wire goes without a tombstone or a floor,
// and its events count as unseen, so a report that returns docks it again.
export function forgetHarborShip(state, id, ship) {
    for (const eventId of new Set([ship.id, ...(ship.eventIds || [])])) {
        state.seenEventIds.delete(eventId);
        state.seenEventTimes.delete(eventId);
        state.seenEventSignatures.delete(eventId);
    }
    state.ships.delete(id);
}

export function harborLiveEventIds(state) {
    const ids = new Set();
    for (const ship of state.ships.values()) {
        if (ship.id) ids.add(ship.id);
        for (const id of ship.eventIds || []) if (id) ids.add(id);
        if (ship.pushEventId) ids.add(ship.pushEventId);
        if (ship.departEventId) ids.add(ship.departEventId);
    }
    for (const batch of state.batches.values()) {
        const id = String(batch.id || '').replace(/^push-batch:/, '');
        if (id) ids.add(id);
    }
    return ids;
}

export function pruneHarborReplayState(state, now) {
    const liveIds = harborLiveEventIds(state);
    const cutoff = now - HARBOR_REPLAY_RETENTION_MS;

    for (const [id, push] of state.pushEvents) {
        const timestamp = Number(push.eventTime || push.seenAt || 0);
        if (!liveIds.has(id) && (!Number.isFinite(timestamp) || timestamp < cutoff)) {
            tombstoneHarborEvent(state, id, now, { type: 'push', status: push.status, eventTime: timestamp });
            state.pushEvents.delete(id);
        }
    }
    if (state.pushEvents.size > MAX_HARBOR_PUSH_EVENTS) {
        const removable = [...state.pushEvents.entries()].sort((a, b) => (
            Number(liveIds.has(a[0])) - Number(liveIds.has(b[0]))
            || Number(a[1]?.eventTime || a[1]?.seenAt || 0) - Number(b[1]?.eventTime || b[1]?.seenAt || 0)
            || a[0].localeCompare(b[0])
        ));
        let excess = state.pushEvents.size - MAX_HARBOR_PUSH_EVENTS;
        for (const [id, push] of removable) {
            if (excess <= 0) break;
            excess--;
            tombstoneHarborEvent(state, id, now, {
                type: 'push',
                status: push.status,
                eventTime: Number(push.eventTime || push.seenAt || 0),
            });
            state.pushEvents.delete(id);
        }
    }

    for (const id of state.seenEventIds) {
        const timestamp = Number(state.seenEventTimes.get(id) || 0);
        if (!liveIds.has(id) && (!Number.isFinite(timestamp) || timestamp < cutoff)) {
            tombstoneHarborEvent(state, id, now, { eventTime: timestamp });
            state.seenEventIds.delete(id);
            state.seenEventTimes.delete(id);
            state.seenEventSignatures.delete(id);
        }
    }
    if (state.seenEventIds.size > MAX_HARBOR_SEEN_EVENT_IDS) {
        const removable = [...state.seenEventIds].sort((a, b) => (
            Number(liveIds.has(a)) - Number(liveIds.has(b))
            || Number(state.seenEventTimes.get(a) || 0) - Number(state.seenEventTimes.get(b) || 0)
            || a.localeCompare(b)
        ));
        let excess = state.seenEventIds.size - MAX_HARBOR_SEEN_EVENT_IDS;
        for (const id of removable) {
            if (excess <= 0) break;
            excess--;
            tombstoneHarborEvent(state, id, now, { eventTime: Number(state.seenEventTimes.get(id) || 0) });
            state.seenEventIds.delete(id);
            state.seenEventTimes.delete(id);
            state.seenEventSignatures.delete(id);
        }
    }
    for (const id of state.seenEventTimes.keys()) {
        if (!state.seenEventIds.has(id)) state.seenEventTimes.delete(id);
    }
    for (const id of state.seenEventSignatures.keys()) {
        if (!state.seenEventIds.has(id)) state.seenEventSignatures.delete(id);
    }
    while (state.lastLandedPushAt.size > MAX_HARBOR_LANDED_PUSH_REPOS) {
        state.lastLandedPushAt.delete(state.lastLandedPushAt.keys().next().value);
    }
    while (state.containmentRepos.size > MAX_HARBOR_LANDED_PUSH_REPOS) {
        state.containmentRepos.delete(state.containmentRepos.values().next().value);
    }
    while (state.eventTombstones.size > MAX_HARBOR_EVENT_TOMBSTONES) {
        state.eventTombstones.delete(state.eventTombstones.keys().next().value);
    }
    while (state.commitReplayFloors.size > MAX_HARBOR_COMMIT_REPLAY_FLOORS) {
        state.commitReplayFloors.delete(state.commitReplayFloors.keys().next().value);
    }
    pruneHarborOverflowDockCounts(state, now);
}

export function harborShipRetentionRank(ship) {
    if (ship?.status === 'departing' || ship?.status === 'rejecting' || ship?.status === 'cancelling') return 3;
    if (ship?.status === 'docked') return 2;
    if (ship?.status === 'arriving') return 1;
    return 0;
}

export function pruneHarborShips(state, now) {
    for (const ship of state.ships.values()) {
        if (!Array.isArray(ship.eventIds) || ship.eventIds.length <= MAX_HARBOR_EVENT_IDS_PER_SHIP) continue;
        const excess = ship.eventIds.splice(0, ship.eventIds.length - MAX_HARBOR_EVENT_IDS_PER_SHIP);
        for (const id of excess) {
            tombstoneHarborEvent(state, id, now, { type: ship.gitKind || 'commit', eventTime: state.seenEventTimes.get(id) });
        }
    }
    if (state.ships.size <= MAX_HARBOR_SHIPS) return;
    const removable = [...state.ships.entries()].sort((a, b) => (
        harborShipRetentionRank(a[1]) - harborShipRetentionRank(b[1])
        || Number(a[1]?.eventTime || a[1]?.createdAt || 0) - Number(b[1]?.eventTime || b[1]?.createdAt || 0)
        || a[0].localeCompare(b[0])
    ));
    let excess = state.ships.size - MAX_HARBOR_SHIPS;
    for (const [id, ship] of removable) {
        if (excess <= 0) break;
        excess--;
        if (ship.status === 'docked' && ship.gitKind === 'commit') {
            recordHarborDockOverflow(state, ship, now);
        }
        retireHarborShip(state, id, ship, now);
    }
}

export function pruneHarborBatches(state) {
    for (const batch of state.batches.values()) {
        batch.shipIds = (batch.shipIds || []).filter(id => state.ships.has(id)).slice(0, MAX_HARBOR_SHIPS);
        batch.shipCount = batch.shipIds.length;
    }
    if (state.batches.size <= MAX_HARBOR_BATCHES) return;
    const removable = [...state.batches.entries()].sort((a, b) => (
        Number((a[1]?.shipIds || []).some(id => state.ships.has(id)))
        - Number((b[1]?.shipIds || []).some(id => state.ships.has(id)))
        || Number(a[1]?.startedAt || a[1]?.eventTime || 0) - Number(b[1]?.startedAt || b[1]?.eventTime || 0)
        || a[0].localeCompare(b[0])
    ));
    let excess = state.batches.size - MAX_HARBOR_BATCHES;
    for (const [id] of removable) {
        if (excess <= 0) break;
        excess--;
        state.batches.delete(id);
    }
}

export function pruneHarborRepoQuays(state) {
    if (state.repoQuays.size <= MAX_HARBOR_REPO_QUAYS) return;
    const liveProjects = new Set([...state.ships.values()].map(ship => String(ship.project || 'unknown')));
    const removable = [...state.repoQuays.keys()].sort((a, b) => (
        Number(liveProjects.has(String(a))) - Number(liveProjects.has(String(b)))
        || String(a).localeCompare(String(b))
    ));
    let excess = state.repoQuays.size - MAX_HARBOR_REPO_QUAYS;
    for (const project of removable) {
        if (excess <= 0) break;
        excess--;
        state.repoQuays.delete(project);
    }
}

export function assignedQuayIndex(state, project) {
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
    while (state.repoQuays.size > MAX_HARBOR_REPO_QUAYS) {
        const oldest = state.repoQuays.keys().next().value;
        if (oldest === key && state.repoQuays.size > 1) {
            const nextOldest = [...state.repoQuays.keys()][1];
            state.repoQuays.delete(nextOldest);
        } else {
            state.repoQuays.delete(oldest);
        }
    }
    return chosen;
}

export function chooseBerthIndex(state, project, occupiedBerths = null) {
    const quayIndex = assignedQuayIndex(state, project);
    const key = String(project || 'unknown');
    const occupied = occupiedBerths || new Set();
    if (!occupiedBerths) {
        for (const ship of state.ships.values()) {
            if (Number.isFinite(Number(ship.berthIndex))) occupied.add(Number(ship.berthIndex));
        }
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

export function pushMarksCommitsLanded(event = {}) {
    if (event.status === 'success' || event.success === true) return true;
    const exitCode = event.exitCode ?? event.exit_code;
    return exitCode != null && Number.isFinite(Number(exitCode)) && Number(exitCode) === 0;
}

// A tag-only or branch-delete push publishes no commit cargo (S-M5, S-L4).
export function pushCarriesCargo(event = {}) {
    return event.tagsOnly !== true && event.deleted !== true;
}

export function normalizeSha(value) {
    return String(value || '').trim().toLowerCase();
}

// A short sha (7+) and its full form are one commit.
export function shasMatch(left, right) {
    if (!left || !right) return false;
    if (left === right) return true;
    return Math.min(left.length, right.length) >= 7 && (left.startsWith(right) || right.startsWith(left));
}

export function shipShas(ship = {}) {
    if (Array.isArray(ship.shas) && ship.shas.length) return ship.shas;
    const sha = normalizeSha(ship.sha);
    return sha ? [sha] : [];
}

// X-14 — every branch a commit was seen on; a push on any of them carries it.
export function shipBranches(ship = {}) {
    if (Array.isArray(ship.branches) && ship.branches.length) return ship.branches;
    const branch = normalizeRepoBranch(ship.branch || ship.targetRef || '');
    return branch ? [branch] : [];
}

// What a push publishes, per the wire contract: the shas the server verified
// landed (the primary signal), else the source branches of its refspecs
// (`feature:main` publishes feature; a rejected ref of a partly accepted push
// publishes nothing), else its frozen branch. A literal `HEAD` normalizes to
// no branch and never wildcards.
export function pushTarget(event = {}) {
    const success = harborEventStatus(event) === 'success';
    const branches = new Set();
    const refs = Array.isArray(event.refs) ? event.refs : [];
    for (const ref of refs) {
        const refStatus = String(ref?.status || '').toLowerCase();
        if (success && (refStatus === 'rejected' || refStatus === 'failed')) continue;
        const source = String(ref?.src || '');
        // P1-3 — a tag or deleted ref publishes no branch cargo.
        if (ref?.tag === true || ref?.deleted === true) continue;
        if (source.startsWith('refs/tags/') || String(ref?.dst || '').startsWith('refs/tags/')) continue;
        const branch = normalizeRepoBranch(source);
        if (branch) branches.add(branch);
    }
    if (!refs.length) {
        const branch = eventBranch(event);
        if (branch) branches.add(branch);
    }
    const landed = (Array.isArray(event.landedShas) ? event.landedShas : []).map(normalizeSha).filter(Boolean);
    return { cargo: pushCarriesCargo(event), branches, landed };
}

// The latest landed push per (repo, branch) lane and per landed sha, so a
// reload does not re-dock work an old push already carried.
export function landedPushHistory(events) {
    const times = new Map();
    const landed = new Map();
    for (const event of events) {
        if (event?.type !== 'push' || !event.project || !Number.isFinite(event.timestamp) || event.timestamp <= 0) continue;
        if (!pushMarksCommitsLanded(event) || !pushCarriesCargo(event)) continue;
        const target = pushTarget(event);
        const lanes = target.branches.size || target.landed.length ? [...target.branches] : [''];
        for (const branch of lanes) {
            const key = trafficIdentity(event.project, branch);
            if (event.timestamp > (times.get(key) || 0)) times.set(key, event.timestamp);
        }
        if (!target.landed.length) continue;
        const shas = landed.get(event.project) || new Map();
        for (const sha of target.landed) {
            if (event.timestamp > (shas.get(sha) || 0)) shas.set(sha, event.timestamp);
        }
        landed.set(event.project, shas);
    }
    return { times, landed };
}

export function compareDepartingShips(a, b) {
    return ((a?.eventTime || 0) - (b?.eventTime || 0))
        || String(a?.id || '').localeCompare(String(b?.id || ''));
}

export function releaseConvoyMetadata(event, branch, selectedShips = [], status = 'unknown', forceFlag = null, displayName = defaultRepoDisplayName) {
    if (status !== 'success' || forceFlag === true) return null;
    if (!Array.isArray(selectedShips) || selectedShips.length < RELEASE_CONVOY_MIN_SHIPS) return null;
    return {
        id: `release-convoy:${event.id}`,
        mode: 'release-convoy',
        project: event.project,
        branch: branch || '',
        repoName: displayName(event.project, branch),
        label: 'Release convoy',
        count: selectedShips.length,
        leaderShipId: selectedShips[0]?.id || '',
        pushEventId: event.id,
        routeId: '',
    };
}

export function isHistoricalCommittedBeforePush(event, history, now, containment = false) {
    const eventTime = Number(event.timestamp);
    if (!Number.isFinite(eventTime)) return false;
    const old = (pushTime) => pushTime > 0 && now - pushTime > RECENT_PUSH_REPLAY_MS;
    const sha = normalizeSha(event.sha);
    const landed = sha ? history.landed.get(event.project) : null;
    if (landed?.size) {
        let landedAt = landed.get(sha) || 0;
        if (!landedAt) {
            for (const [landedSha, at] of landed) if (shasMatch(landedSha, sha)) landedAt = Math.max(landedAt, at);
        }
        if (old(landedAt)) return true;
    }
    if (containment && sha) return false;
    const pushTime = history.times.get(trafficIdentity(event.project, eventBranch(event))) || 0;
    return eventTime <= pushTime && old(pushTime);
}

// How a push reaches a ship: 'sha' when the server verified the ship's commit
// landed, 'branch' when the ship sits on a pushed branch, null otherwise.
// A push with no target departs only branch-less work from its own checkout
// (S-H2, S-M4): it never acts as a wildcard.
export function pushMatchesShip(event, ship, target = pushTarget(event)) {
    if (!ship || ship.project !== event.project || !target.cargo) return null;
    const shas = shipShas(ship);
    if (target.landed.length && shas.length) {
        // P1-1 — the landed set is authoritative for sha-bearing cargo.
        return shas.some(sha => target.landed.some(landed => shasMatch(sha, landed))) ? 'sha' : null;
    }
    const branches = shipBranches(ship);
    if (target.branches.size) return branches.some(branch => target.branches.has(branch)) ? 'branch' : null;
    if (target.landed.length || branches.length) return null;
    const checkout = event.checkout || '';
    return !checkout || !ship.checkout || ship.checkout === checkout ? 'branch' : null;
}

// X-12 — operation order beats observation order: a commit made after the
// push stays docked. First-seen order decides only when a time is missing.
// #3 — a successful publication also reaches a ship still sailing home from
// a rejected or cancelled push: the publication supersedes the return.
export function shipEligibleForPush(ship, event, previousPush, now, target = pushTarget(event), status = 'unknown') {
    if (!ship) return false;
    const returning = ship.status === 'rejecting' || ship.status === 'cancelling';
    if (ship.status !== 'docked' && !(returning && status === 'success')) return false;
    const match = pushMatchesShip(event, ship, target);
    if (!match) return false;
    if (match === 'sha') return true;
    const pushTime = Number.isFinite(event.timestamp) && event.timestamp > 0 ? event.timestamp : 0;
    if (!pushTime) return true;
    const shipTime = Number(ship.eventTime);
    if (Number.isFinite(shipTime) && shipTime > 0) return shipTime <= pushTime;
    return Number.isFinite(ship.createdAt) && ship.createdAt < (previousPush?.seenAt || now);
}

export function commitCompareText(value = '') {
    return cachedCleanCommitSubject(value)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
}

export function commitIdentityParts(event = {}) {
    const project = String(event.project || 'unknown');
    const branch = normalizeRepoBranch(event.branch || event.targetRef || '');
    const sha = normalizeSha(event.sha);
    const label = cachedCleanCommitSubject(event.label || commitMessageFromCommand(event.command) || '');
    return {
        project,
        branch,
        sha,
        label,
        compareLabel: commitCompareText(label),
        timestamp: Number(event.timestamp ?? event.eventTime ?? 0) || 0,
    };
}

export function commitTimesClose(a, b) {
    if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0 || b <= 0) return true;
    return Math.abs(a - b) <= COMMIT_EQUIVALENCE_WINDOW_MS;
}

export function commitLabelsEquivalent(left, right, leftTime, rightTime) {
    if (!left || !right || !commitTimesClose(leftTime, rightTime)) return false;
    if (left === right) {
        if (left.length >= 10) return true;
        if (!Number.isFinite(leftTime) || !Number.isFinite(rightTime) || leftTime <= 0 || rightTime <= 0) return false;
        return Math.abs(leftTime - rightTime) <= 30000;
    }
    if (Math.min(left.length, right.length) < 18) return false;
    return left.startsWith(right) || right.startsWith(left);
}

// Commit identity. Two shas decide on their own. Subject and time may only
// pair one sha-less observation with one sha-bearing report of the same
// commit (the enrichment case); two sha-less observations are always two
// commits (X-15), however alike their subjects.
export function sameCommitIdentity(ship, event) {
    const left = commitIdentityParts(ship);
    const right = commitIdentityParts(event);
    if (left.project !== right.project) return false;
    const shas = shipShas(ship);
    if (shas.length && right.sha) return shas.some(sha => shasMatch(sha, right.sha));
    if (!shas.length && !right.sha) return false;
    if (shas.length ? Number(ship.shalessEvents || 0) > 0 : false) return false;
    const branches = shipBranches(ship);
    if (branches.length && right.branch && !branches.includes(right.branch)) return false;
    return commitLabelsEquivalent(left.compareLabel, right.compareLabel, left.timestamp, right.timestamp);
}

export function commitIdentityIndexLabelKey(parts) {
    const label = parts.compareLabel || '';
    if (!label) return '';
    return `${parts.project}\x1f${label.length >= 18 ? label.slice(0, 18) : label}`;
}

export function addCommitIdentityIndexEntry(map, key, ship) {
    if (!key) return;
    const entries = map.get(key) || new Set();
    entries.add(ship);
    map.set(key, entries);
}

const FULL_SHA_LENGTH = 40;

// Shas index exactly; an abbreviated sha on either side is found through its
// 7-character prefix.
function commitShaIndexKey(project, sha, length = sha.length) {
    return `${project}\x1f${sha.slice(0, length)}`;
}

export function indexCommitShip(index, ship) {
    if (!ship) return;
    if (!index.order.has(ship)) index.order.set(ship, index.nextOrder++);
    const parts = commitIdentityParts(ship);
    const shas = shipShas(ship);
    for (const sha of shas) {
        addCommitIdentityIndexEntry(index.bySha, commitShaIndexKey(parts.project, sha), ship);
        addCommitIdentityIndexEntry(index.byShaPrefix, commitShaIndexKey(parts.project, sha, 7), ship);
        if (sha.length < FULL_SHA_LENGTH) addCommitIdentityIndexEntry(index.byShortSha, commitShaIndexKey(parts.project, sha, 7), ship);
    }
    addCommitIdentityIndexEntry(shas.length ? index.byLabelWithSha : index.byLabelWithoutSha, commitIdentityIndexLabelKey(parts), ship);
}

export function unindexCommitShip(index, ship) {
    for (const map of [index.bySha, index.byShaPrefix, index.byShortSha, index.byLabelWithSha, index.byLabelWithoutSha]) {
        for (const entries of map.values()) entries.delete(ship);
    }
}

export function buildCommitIdentityIndex(state) {
    const index = {
        bySha: new Map(),
        byShaPrefix: new Map(),
        byShortSha: new Map(),
        byLabelWithSha: new Map(),
        byLabelWithoutSha: new Map(),
        order: new Map(),
        nextOrder: 0,
    };
    for (const ship of state.ships.values()) indexCommitShip(index, ship);
    return index;
}

export function findIndexedCommitShip(index, event) {
    const parts = commitIdentityParts(event);
    const candidates = new Set();
    if (parts.sha) {
        const prefix = commitShaIndexKey(parts.project, parts.sha, 7);
        const sources = [index.bySha.get(commitShaIndexKey(parts.project, parts.sha)), index.byShortSha.get(prefix)];
        if (parts.sha.length < FULL_SHA_LENGTH) sources.push(index.byShaPrefix.get(prefix));
        for (const source of sources) for (const ship of source || []) candidates.add(ship);
    }
    const labelKey = commitIdentityIndexLabelKey(parts);
    if (labelKey) {
        const labelIndex = parts.sha ? index.byLabelWithoutSha : index.byLabelWithSha;
        for (const ship of labelIndex.get(labelKey) || []) candidates.add(ship);
    }
    return [...candidates]
        .filter(ship => ship.status !== 'scuttling')
        .sort((a, b) => Number(index.order.get(a) || 0) - Number(index.order.get(b) || 0))
        .find(ship => sameCommitIdentity(ship, event)) || null;
}

// Fold another report of one commit into its ship: a duplicate observation
// or a richer version (sha, branch, label). It is never an amend (S-H3);
// amends come only from `rewritten` replacements. Idempotent, so an
// enrichment update can re-apply it.
// D5 — who made a commit: the git author and Co-Authored-By names when the
// server read them, and whether the session ran the commit (`observed`) or
// only found it in a repo scan (`scanned`, shown as "seen by <agent>").
export function commitAttribution(event = {}) {
    const scanned = event.attribution === 'scanned' || (!event.attribution && String(event.source || '').includes('upstream-status'));
    const out = { attribution: scanned ? 'scanned' : 'observed' };
    if (event.author?.name) out.author = { name: String(event.author.name), ...(event.author.email ? { email: String(event.author.email) } : {}) };
    if (Array.isArray(event.coAuthors) && event.coAuthors.length) out.coAuthors = event.coAuthors.map(String).slice(0, 8);
    return out;
}

// R4 — a ship's branch set from its evidence. A scan (`attribution:
// 'scanned'`) is authoritative for membership as of its time: each newer
// scan replaces the scanned set, so a reset branch drops out. An observed
// report adds its branch only while it is newer than the latest scan.
function branchEvidenceTime(event = {}) {
    return Number(event.completedAt || event.timestamp || 0) || 0;
}

export function applyBranchEvidence(ship, event) {
    const names = eventBranches(event);
    const at = branchEvidenceTime(event);
    const previous = ship.branchEvidence || { scan: null, observed: shipBranches(ship).map(branch => ({ branch, at: 0 })) };
    let scan = previous.scan;
    let observed = previous.observed || [];
    // Scan membership is authoritative whatever the attribution: a server
    // that re-emits an observed event with `scanSeq` reports scan evidence.
    // Attribution only decides the author / "seen by" display.
    const scanEvidence = hasScanSeq(event) || commitAttribution(event).attribution === 'scanned';
    if (scanEvidence) {
        if (scanIsNewer(scan, event, at)) {
            // An incomplete branch listing may add membership, never remove it.
            const branches = event.branchesComplete === false && scan
                ? [...new Set([...scan.branches, ...names])]
                : names;
            const seq = Number(event.scanSeq);
            const scannedAt = Number(event.scannedAt);
            scan = {
                branches,
                at,
                seq: Number.isFinite(seq) ? seq : null,
                scannedAt: Number.isFinite(scannedAt) && scannedAt > 0 ? scannedAt : null,
            };
        }
    } else if (names.length) {
        const latest = new Map(observed.map(entry => [entry.branch, entry.at]));
        for (const branch of names) latest.set(branch, Math.max(latest.get(branch) || 0, at));
        observed = [...latest].map(([branch, time]) => ({ branch, at: time }));
    }
    setBranchEvidence(ship, { scan, observed });
}

// Wire v1.1: `scanSeq` orders scans (strictly increasing per repo; an equal
// or older snapshot is stale). A scanned event's `completedAt` is the commit
// time, so it orders scans only for an older server that sends no `scanSeq`.
// `scanSeq` is time-based on newer servers (`max(prev + 1, now)`), so it is
// only ever compared, never assumed small.
function hasScanSeq(event) {
    return event.scanSeq !== null && event.scanSeq !== undefined && event.scanSeq !== '' && Number.isFinite(Number(event.scanSeq));
}

function scanIsNewer(scan, event, at) {
    if (!scan) return true;
    const knownSeq = Number.isFinite(scan.seq) && scan.seq !== null;
    if (hasScanSeq(event)) return !knownSeq || Number(event.scanSeq) > scan.seq;
    return !knownSeq && at >= scan.at;
}

function setBranchEvidence(ship, evidence) {
    ship.branchEvidence = evidence;
    const branches = evidence.scan ? [...evidence.scan.branches] : [];
    // An observed branch counts only while newer than the latest scan's wall time.
    const scanTime = evidence.scan ? (evidence.scan.scannedAt ?? evidence.scan.at) : 0;
    for (const entry of evidence.observed) {
        if ((!evidence.scan || entry.at > scanTime) && !branches.includes(entry.branch)) branches.push(entry.branch);
    }
    ship.branches = branches;
    if (!branches.includes(ship.branch)) ship.branch = branches[0] || '';
    // 3.6 — detached HEAD: no branch once every report is folded in.
    ship.detachedHead = !ship.branch;
}

// A rewrite moved the commit off `branch` (it stays on the others).
function dropShipBranch(ship, branch) {
    const evidence = ship.branchEvidence || { scan: null, observed: shipBranches(ship).map(name => ({ branch: name, at: 0 })) };
    setBranchEvidence(ship, {
        scan: evidence.scan ? { ...evidence.scan, branches: evidence.scan.branches.filter(name => name !== branch) } : null,
        observed: evidence.observed.filter(entry => entry.branch !== branch),
    });
}

export function mergeCommitIntoShip(ship, event) {
    const nextLabel = cachedCleanCommitSubject(event.label || commitMessageFromCommand(event.command) || '');
    const currentLabel = cachedCleanCommitSubject(ship.label || '');
    ship.eventIds = Array.isArray(ship.eventIds) ? ship.eventIds : [ship.id].filter(Boolean);
    const isNewEvent = !!(event.id && !ship.eventIds.includes(event.id));
    if (isNewEvent) ship.eventIds.push(event.id);
    const sha = normalizeSha(event.sha);
    ship.shas = [...shipShas(ship)];
    if (sha) {
        // P1-4 — a full sha replaces the abbreviation it extends, so the old
        // short form can never bridge two different full shas later.
        const short = ship.shas.findIndex(known => known.length < sha.length && sha.startsWith(known));
        if (short >= 0) {
            if (normalizeSha(ship.sha) === ship.shas[short]) ship.sha = event.sha;
            ship.shas[short] = sha;
        } else if (!ship.shas.some(known => shasMatch(known, sha))) {
            ship.shas.push(sha);
        }
    }
    if (!ship.sha && event.sha) ship.sha = event.sha;
    if (isNewEvent && !sha) ship.shalessEvents = Number(ship.shalessEvents || 0) + 1;
    applyBranchEvidence(ship, event);
    if (!ship.targetRef && event.targetRef) ship.targetRef = event.targetRef;
    if (event.worktree && JSON.stringify(event.worktree) !== JSON.stringify(ship.worktree)) ship.worktree = { ...event.worktree };
    if (nextLabel && (!currentLabel || currentLabel.startsWith('$(cat') || nextLabel.length < currentLabel.length)) {
        ship.label = nextLabel;
    }
    if (Number.isFinite(event.timestamp) && event.timestamp > 0) {
        ship.eventTime = Math.min(Number(ship.eventTime || event.timestamp), event.timestamp);
    }
    // D5 — an observed report (the session ran the commit) outranks a
    // scanned one (the session only saw it); a richer author is kept.
    const attribution = commitAttribution(event);
    if (attribution.attribution === 'observed' || !ship.attribution) ship.attribution = attribution.attribution;
    if (attribution.author && !ship.author) ship.author = attribution.author;
    if (attribution.coAuthors?.length && !ship.coAuthors?.length) ship.coAuthors = attribution.coAuthors;
    // Track upstream hint when an adapter forwards it on commits
    if (typeof event.hasUpstream === 'boolean' && ship.hasUpstreamHint == null) {
        ship.hasUpstreamHint = event.hasUpstream;
    }
}

// X-8 / X-4 — a commit the provider says failed (hook rejection, "nothing to
// commit") created nothing.
export function commitEventFailed(event = {}) {
    if (event.success === false) return true;
    const exitCode = event.exitCode ?? event.exit_code;
    return exitCode != null && Number.isFinite(Number(exitCode)) && Number(exitCode) !== 0;
}

// The fields whose change makes a re-reported event worth re-applying.
export function harborEventSignature(event = {}) {
    return [
        event.sha || '',
        event.branch || event.targetRef || '',
        event.success ?? '',
        event.exitCode ?? '',
        event.status || '',
        event.label || '',
        Array.isArray(event.branches) ? event.branches.join(',') : '',
        // R4 — a newer scan of the same commit is new membership evidence.
        event.completedAt || '',
        event.scanSeq ?? '',
        event.scannedAt ?? '',
        event.branchesComplete ?? '',
        // P2-11 — attribution and worktree enrichment count as changes too.
        event.author?.name || '',
        event.author?.email || '',
        Array.isArray(event.coAuthors) ? event.coAuthors.join(',') : '',
        event.attribution || '',
        event.worktree ? `${event.worktree.name || ''}:${event.worktree.path || ''}:${event.worktree.isMain === true}` : '',
    ].join('\x1f');
}

export function snapshotHarborTrafficState(state) {
    const cloned = cloneState(state);
    const dockLayout = buildDockSquadLayout(cloned);
    return {
        nextSequence: cloned.nextSequence,
        seenEventIds: [...cloned.seenEventIds].sort(),
        ships: [...cloned.ships.values()]
            .map((ship) => {
                const meta = dockLayout.byShipId.get(ship.id) || {};
                return {
                    id: ship.id,
                    project: ship.project,
                    checkout: ship.checkout || ship.project,
                    worktree: ship.worktree ? { ...ship.worktree } : null,
                    branch: ship.branch || '',
                    branches: [...shipBranches(ship)],
                    shas: [...shipShas(ship)],
                    amendCount: Number(ship.amendCount || 0),
                    detachedHead: ship.detachedHead === true,
                    quayIndex: ship.quayIndex ?? null,
                    repoName: ship.repoName || '',
                    sha: ship.sha || '',
                    label: ship.prShip ? pullRequestShipLabel(ship) : ship.label || '',
                    status: ship.status,
                    gitKind: ship.gitKind || '',
                    eventStatus: ship.eventStatus || '',
                    remote: ship.remote || '',
                    ref: ship.ref || '',
                    refspec: ship.refspec || '',
                    targetRef: ship.targetRef || '',
                    source: ship.source || '',
                    sourceId: ship.sourceId || '',
                    confidence: ship.confidence ?? null,
                    inferred: ship.inferred === true,
                    observed: ship.observed === true,
                    sessionId: ship.sessionId || '',
                    agentId: ship.agentId || '',
                    completedAt: ship.completedAt || 0,
                    arrivingKind: ship.arrivingKind || null,
                    inboundCargoCount: ship.inboundCargoCount ?? null,
                    pushStatus: ship.pushStatus || null,
                    pushSource: ship.pushSource || '',
                    pushConfidence: ship.pushConfidence ?? null,
                    pushInferred: ship.pushInferred === true,
                    pushObserved: ship.pushObserved === true,
                    pushRemote: ship.pushRemote || '',
                    pushRef: ship.pushRef || '',
                    pushForce: ship.pushForce || null,
                    batchId: ship.batchId || null,
                    berthIndex: ship.berthIndex,
                    laneIndex: ship.laneIndex,
                    repoDockIndex: meta.repoDockIndex ?? ship.repoDockIndex ?? null,
                    repoDockCount: meta.repoDockCount ?? ship.repoDockCount ?? null,
                    repoTotalDockCount: meta.repoTotalDockCount ?? ship.repoTotalDockCount ?? null,
                    repoDockVisibleCount: meta.repoDockVisibleCount ?? ship.repoDockVisibleCount ?? null,
                    repoSegmentIndex: meta.repoSegmentIndex ?? ship.repoSegmentIndex ?? null,
                    repoSegmentCount: meta.repoSegmentCount ?? ship.repoSegmentCount ?? null,
                    squadIndex: meta.squadIndex ?? ship.squadIndex ?? null,
                    squadCount: meta.squadCount ?? ship.squadCount ?? null,
                    squadShipIndex: meta.squadShipIndex ?? ship.squadShipIndex ?? null,
                    squadShipCount: meta.squadShipCount ?? ship.squadShipCount ?? null,
                    squadDensity: meta.squadDensity ?? ship.squadDensity ?? null,
                    compactCommitLabel: meta.compactCommitLabel ?? ship.compactCommitLabel ?? null,
                    showCommitLabel: meta.showCommitLabel ?? ship.showCommitLabel ?? null,
                    formationColumn: meta.column ?? ship.formationColumn ?? null,
                    formationRow: meta.row ?? ship.formationRow ?? null,
                    waitingZone: meta.waitingZone ?? ship.waitingZone ?? null,
                    departWaterZone: ship.departWaterZone || null,
                    anchorageName: meta.anchorageName ?? ship.anchorageName ?? null,
                    anchorageIndex: meta.anchorageIndex ?? ship.anchorageIndex ?? null,
                    zoneSquadIndex: meta.zoneSquadIndex ?? ship.zoneSquadIndex ?? null,
                    departSquadIndex: ship.departSquadIndex ?? null,
                    departSquadCount: ship.departSquadCount ?? null,
                    departRouteIndex: ship.departRouteIndex ?? null,
                    route: compactRouteMetadata(ship.route),
                    convoy: ship.convoy ? { ...ship.convoy } : null,
                    departFromTile: ship.departFromTile || null,
                    eventTime: ship.eventTime,
                    departEventId: ship.departEventId || null,
                    departStartedAt: ship.departStartedAt || null,
                };
            })
            .sort((a, b) => (a.eventTime - b.eventTime) || a.id.localeCompare(b.id)),
        repoQuays: [...cloned.repoQuays.entries()]
            .map(([project, quayIndex]) => ({ project, quayIndex }))
            .sort((a, b) => a.project.localeCompare(b.project)),
        repoAnchorages: [...cloned.repoAnchorages.entries()]
            .map(([project, slot]) => ({ project, slot, anchorage: COAST_ANCHORAGE_SLOTS[slot]?.name || '' }))
            .sort((a, b) => a.project.localeCompare(b.project)),
        anchorageVersion: cloned.anchorageVersion,
        batches: [...cloned.batches.values()]
            .map(batch => ({
                id: batch.id,
                project: batch.project,
                branch: batch.branch || '',
                quayIndex: batch.quayIndex ?? null,
                repoName: batch.repoName || '',
                label: batch.label || '',
                status: batch.status || 'unknown',
                eventStatus: batch.eventStatus || '',
                remote: batch.remote || '',
                ref: batch.ref || '',
                refspec: batch.refspec || '',
                source: batch.source || '',
                sourceId: batch.sourceId || '',
                confidence: batch.confidence ?? null,
                inferred: batch.inferred === true,
                observed: batch.observed === true,
                targetRef: batch.targetRef || '',
                force: batch.force || null,
                route: compactRouteMetadata(batch.route),
                convoy: batch.convoy ? { ...batch.convoy } : null,
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
                branch: push.branch || '',
                status: push.status || 'unknown',
                eventStatus: push.eventStatus || '',
                remote: push.remote || '',
                ref: push.ref || '',
                refspec: push.refspec || '',
                source: push.source || '',
                sourceId: push.sourceId || '',
                confidence: push.confidence ?? null,
                inferred: push.inferred === true,
                observed: push.observed === true,
                force: push.force || null,
                deleted: push.deleted === true,
                tagsOnly: push.tagsOnly === true,
                tag: push.tag || '',
                reason: push.reason || '',
                landedCount: push.landedCount || 0,
                eventTime: push.eventTime || 0,
                batchId: push.batchId || null,
                settledAt: push.settledAt || null,
            }))
            .sort((a, b) => (a.eventTime - b.eventTime) || a.id.localeCompare(b.id)),
    };
}

// Push lifecycle: P-D7 — a departure lasts its route length at its convoy's
// cruise speed (HarborLayout.harborSailDurationMs); a force-push always
// takes FORCE_DEPARTURE_MS.
export function dynamicDepartureMs(ship = {}, force = null, lengthTiles = null, speed = null) {
    if (force === true) return FORCE_DEPARTURE_MS;
    if (!Number.isFinite(Number(lengthTiles))) return DEPARTURE_MS;
    return harborSailDurationMs(Number(lengthTiles), Number(speed) || harborCruiseSpeed(ship));
}

// 3.2 — parse incoming commit count from pull flags/remote args. Best-effort.
export function parseIncomingCommits(event = {}) {
    const flags = Array.isArray(event.flags) ? event.flags : [];
    const stderr = String(event.stderr || '');
    // Look for tokens like "+12" or "Fast-forwarded ... 12 files changed".
    const stderrMatch = stderr.match(/(\d+)\s+(?:files?\s+changed|commits?|insertions?|new\s+commits?)/i);
    if (stderrMatch) {
        const n = parseInt(stderrMatch[1], 10);
        if (Number.isFinite(n) && n > 0) return Math.min(10, n);
    }
    for (const flag of flags) {
        const m = String(flag).match(/^--depth=(\d+)$/);
        if (m) {
            const n = parseInt(m[1], 10);
            if (Number.isFinite(n) && n > 0) return Math.min(10, n);
        }
    }
    return 0;
}

// W7.9 — the moored PR cutter a `gh pr merge` sends in: the one whose scraped
// pull URL matches, else the project's newest moored PR with no URL to
// contradict it. Null when no cutter is waiting (a PR opened elsewhere).
export function findMooredPullRequest(state, event) {
    const url = String(event?.url || '');
    let best = null;
    for (const ship of state.ships.values()) {
        if (!ship.prShip || ship.arrivingKind !== 'pr' || ship.project !== event.project) continue;
        if (url && ship.prUrl) {
            if (ship.prUrl === url) return ship;
            continue;
        }
        if (!best || (ship.prCreatedAt || 0) > (best.prCreatedAt || 0)) best = ship;
    }
    return best;
}

// Moored PR cutters fill the outer-roadstead anchorages in turn, a row
// further out each lap, so two open PRs never moor on one tile.
export function pullRequestRoadsteadTile(state) {
    const anchorages = HARBOR_SQUAD_ANCHORAGES.filter(anchorage => anchorage.zone === 'outer-roadstead');
    let slot = 0;
    for (const ship of state.ships.values()) {
        if (ship.prShip && ship.arrivingKind === 'pr') slot++;
    }
    const anchorage = anchorages[slot % anchorages.length] || HARBOR_SQUAD_ANCHORAGES[0];
    const row = Math.floor(slot / Math.max(1, anchorages.length)) % PR_ROADSTEAD_ROWS;
    return { tileX: anchorage.tileX + anchorage.rowDx * row, tileY: anchorage.tileY + anchorage.rowDy * row };
}

export function pullRequestShipLabel(event = {}) {
    const match = String(event.prUrl || event.url || '').match(/\/pull\/(\d+)(?:[/?#]|$)/);
    if (match) return `PR #${match[1]}`;
    const detail = String(event.branch || event.prTitle || event.title || '').trim();
    return detail ? `PR ${detail}` : 'PR';
}

export function pullRequestShip(state, event, now, displayName = defaultRepoDisplayName) {
    state.nextSequence++;
    return {
        id: `pr:${event.id}`,
        project: event.project,
        branch: event.branch || '',
        targetRef: '',
        ...gitEventDebugMetadata(event, ''),
        repoName: displayName(event.project, event.branch || ''),
        quayIndex: assignedQuayIndex(state, event.project),
        sha: '',
        label: pullRequestShipLabel(event),
        inboundCargoCount: 0,
        berthIndex: state.nextSequence % BERTHS.length,
        laneIndex: stableHash(`${event.project}:${event.id}:pr`) % SEA_LANES.length,
        eventTime: event.timestamp || now,
        createdAt: now,
        eventIds: [event.id],
        isInbound: true,
        prShip: true,
        prUrl: String(event.url || ''),
        prTitle: String(event.title || ''),
        prCreatedAt: event.timestamp || now,
        detachedHead: false,
        amendCount: 0,
    };
}

export function reduceHarborTrafficState(previous, events, options = {}) {
    const state = cloneState(previous);
    const now = Number.isFinite(options.now) ? options.now : Date.now();
    const motionScale = options.motionScale === 0 ? 0 : 1;
    const displayName = typeof options.repoDisplayName === 'function' ? options.repoDisplayName : defaultRepoDisplayName;

    // 2.1 — the harbor keys every repo fact on `repoRoot || project`: a linked
    // worktree or subdirectory session joins its repo, and its checkout
    // stays on the event as presentation detail.
    const sortedEvents = [...(events || [])]
        // The server could not resolve where an `unresolved` event ran: it
        // never makes or moves a ship.
        .filter(event => event?.id && event?.type && event?.project && event.unresolved !== true)
        .map(harborRepoEvent)
        .flatMap(splitPartialPush)
        .sort((a, b) => (a.timestamp - b.timestamp) || a.id.localeCompare(b.id));
    // Pushes may sit before a long commit tail while still applying to a live
    // docked ship, so transition correctness requires the complete ordered tail.
    const sorted = sortedEvents;
    const pushHistory = landedPushHistory(sorted);
    const relevantProjects = new Set(sorted.map(event => String(event.project || 'unknown')));
    for (const ship of state.ships.values()) {
        if (ship.project) relevantProjects.add(String(ship.project));
    }
    for (const [project] of state.repoQuays.entries()) {
        if (!relevantProjects.has(String(project || 'unknown'))) state.repoQuays.delete(project);
    }
    if (relevantProjects.size <= MAX_HARBOR_REPO_QUAYS) {
        for (const project of relevantProjects) assignedQuayIndex(state, project);
    }
    const commitIdentityIndex = buildCommitIdentityIndex(state);
    let shipsByEventId = null;
    const shipForEventId = (id) => {
        if (!shipsByEventId) {
            shipsByEventId = new Map();
            for (const ship of state.ships.values()) {
                for (const eventId of ship.eventIds || [ship.id]) shipsByEventId.set(eventId, ship);
            }
        }
        return shipsByEventId.get(id) || null;
    };
    let scuttleLayout = null;
    const scuttle = (ship) => {
        if (ship.status !== 'docked') return;
        scuttleLayout ||= buildDockLayoutFresh(state);
        const meta = scuttleLayout.byShipId.get(ship.id);
        if (meta) ship.departFromTile = { tileX: meta.tileX, tileY: meta.tileY };
        ship.status = 'scuttling';
        ship.scuttleStartedAt = now;
    };
    // Live-only repos claim coastal slots only after this tail's commits have,
    // so a fresh replay parks fleets first and idle agents fill what's left.
    const activeProjects = Array.isArray(options.activeProjects) ? options.activeProjects : [];
    const occupiedBerths = new Set();
    for (const ship of state.ships.values()) {
        if (Number.isFinite(Number(ship.berthIndex))) occupiedBerths.add(Number(ship.berthIndex));
    }

    // `complete`: `events` is every git event on the wire, what a page load
    // would replay. A docked commit none of whose reports is still there
    // (its session left, or the server stopped listing it with no departure
    // the client saw) fades out as it would be absent after a reload; if a
    // report returns before or after the fade, the commit docks again. A
    // fading ship revives before this tail's pushes and rewrites apply, so a
    // push arriving with its returning report still sails it.
    const liveEventIds = options.complete === true ? new Set(sorted.map(event => event.id)) : null;
    const reportedLive = ship => (ship.eventIds || [ship.id]).some(id => liveEventIds.has(id));
    if (liveEventIds) {
        for (const ship of state.ships.values()) {
            if (!ship.vanished || ship.status !== 'scuttling' || !reportedLive(ship)) continue;
            ship.status = 'docked';
            ship.scuttleStartedAt = null;
            ship.vanished = false;
        }
    }

    for (const event of sorted) {
        if (event.type !== 'push') {
            if (harborEventIsTombstoned(state, event)) continue;
            if (state.seenEventIds.has(event.id)) {
                // X-4 — a later, richer report of an event already seen
                // updates its ship (sha, branch, a failed completion) instead
                // of being dropped as a duplicate.
                const signature = harborEventSignature(event);
                if (event.type !== 'commit' || state.seenEventSignatures.get(event.id) === signature) continue;
                state.seenEventSignatures.set(event.id, signature);
                const ship = shipForEventId(event.id);
                if (ship) {
                    if (ship.status !== 'docked') continue;
                    if (commitEventFailed(event)) {
                        if (ship.eventIds.length <= 1) scuttle(ship);
                        else ship.eventIds = ship.eventIds.filter(id => id !== event.id);
                        continue;
                    }
                    mergeCommitIntoShip(ship, event);
                    indexCommitShip(commitIdentityIndex, ship);
                    continue;
                }
                // No ship yet (an earlier report failed or was unconfirmed):
                // treat the update as a first sighting below.
            } else {
                markHarborEventSeen(state, event, now);
                state.seenEventSignatures.set(event.id, harborEventSignature(event));
            }
        }

        if (event.type === 'commit') {
            if (commitEventFailed(event)) continue;
            const containment = pushHistory.landed.has(event.project) || state.containmentRepos.has(event.project);
            if (commitIsAtOrBelowReplayFloor(state, event, containment)) continue;
            if (isHistoricalCommittedBeforePush(event, pushHistory, now, containment)) continue;
            const existingShip = findIndexedCommitShip(commitIdentityIndex, event);
            if (existingShip) {
                mergeCommitIntoShip(existingShip, event);
                indexCommitShip(commitIdentityIndex, existingShip);
                shipsByEventId?.set(event.id, existingShip);
                continue;
            }
            const branch = eventBranch(event);
            const sha = normalizeSha(event.sha);
            const { berthIndex, quayIndex } = chooseBerthIndex(state, event.project, occupiedBerths);
            const laneIndex = stableHash(`${event.project}:${branch}:${event.id}`) % SEA_LANES.length;
            state.nextSequence++;
            const ship = {
                id: event.id,
                project: event.project,
                checkout: event.checkout || event.project,
                worktree: event.worktree || null,
                branch,
                branches: eventBranches(event),
                targetRef: event.targetRef || '',
                ...gitEventDebugMetadata(event, branch),
                repoName: displayName(event.project, branch),
                quayIndex,
                sha: event.sha,
                shas: sha ? [sha] : [],
                shalessEvents: sha ? 0 : 1,
                label: cachedCleanCommitSubject(event.label || commitMessageFromCommand(event.command)) || event.label,
                status: 'docked',
                route: routeGraphMetadata('berth.assignment'),
                berthIndex,
                laneIndex,
                eventTime: event.timestamp || now,
                createdAt: now,
                eventIds: [event.id],
                // 3.6 — edge case flags inferred at commit time
                detachedHead: branch === '',
                hasUpstreamHint: typeof event.hasUpstream === 'boolean' ? event.hasUpstream : null,
                amendCount: 0,
                ...commitAttribution(event),
            };
            applyBranchEvidence(ship, event);
            state.ships.set(event.id, ship);
            ensureRepoAnchorage(state, event.project);
            occupiedBerths.add(berthIndex);
            indexCommitShip(commitIdentityIndex, ship);
            shipsByEventId?.set(event.id, ship);
            continue;
        }

        // 2.9 / S-M7 — commits that left a branch without reaching a remote
        // (rebase, amend, reset). A replacement folds the new sha into the old
        // ship as its one amend; a commit with no replacement is scuttled
        // quietly, never sailed.
        if (event.type === 'rewritten') {
            const branch = eventBranch(event);
            const replacements = new Map();
            for (const entry of Array.isArray(event.replacements) ? event.replacements : []) {
                const oldSha = normalizeSha(entry?.oldSha);
                const newSha = normalizeSha(entry?.newSha);
                if (oldSha && newSha) replacements.set(oldSha, newSha);
            }
            const oldShas = new Set([...(Array.isArray(event.oldShas) ? event.oldShas : []).map(normalizeSha), ...replacements.keys()].filter(Boolean));
            // R5 — explicit replacements and sha retirements first; a ship
            // they handled is no ghost.
            const handled = new Set();
            for (const ship of oldShas.size ? [...state.ships.values()] : []) {
                if (ship.project !== event.project || ship.status !== 'docked') continue;
                const shas = shipShas(ship);
                const oldSha = [...oldShas].find(candidate => shas.some(sha => shasMatch(sha, candidate)));
                if (!oldSha) continue;
                handled.add(ship);
                const branches = shipBranches(ship);
                if (branch && branches.length > 1 && branches.includes(branch)) {
                    // Still reachable from another branch: it only leaves this one.
                    dropShipBranch(ship, branch);
                    continue;
                }
                const newSha = [...replacements.entries()].find(([candidate]) => shasMatch(candidate, oldSha))?.[1];
                if (!newSha) {
                    scuttle(ship);
                    continue;
                }
                for (const twin of [...state.ships.values()]) {
                    if (twin === ship || twin.project !== ship.project || twin.status !== 'docked') continue;
                    if (!shipShas(twin).some(sha => shasMatch(sha, newSha))) continue;
                    handled.add(twin);
                    unindexCommitShip(commitIdentityIndex, twin);
                    retireHarborShip(state, twin.id, twin, now, { recordFloor: false });
                }
                ship.shas = [...shas.filter(sha => !shasMatch(sha, oldSha)), newSha];
                ship.sha = newSha;
                ship.amendCount = Math.max(0, Number(ship.amendCount || 0)) + 1;
                ship.amendFlashAt = now;
                indexCommitShip(commitIdentityIndex, ship);
            }
            // Ghost commits (an observed sha the repo lacks, or a sha-less
            // observation no scan matches) retire by event id, quietly.
            const oldIds = new Set(Array.isArray(event.oldIds) ? event.oldIds.map(String) : []);
            if (oldIds.size) {
                for (const ship of [...state.ships.values()]) {
                    if (handled.has(ship) || ship.project !== event.project || ship.status !== 'docked') continue;
                    if ((ship.eventIds || [ship.id]).some(id => oldIds.has(id))) scuttle(ship);
                }
            }
            continue;
        }

        // 3.2 — pull/fetch as inbound ships sailing toward harbor.
        if (event.type === 'pull' || event.type === 'fetch') {
            const inboundStatus = String(event.status || gitEventStatusLabel(event) || '').toLowerCase();
            if (inboundStatus === 'failed' || inboundStatus === 'rejected'
                || inboundStatus === 'cancelled' || inboundStatus === 'canceled') {
                markHarborEventSeen(state, event, now);
                continue;
            }
            if (motionScale === 0) continue;
            const eventAge = Number.isFinite(event.timestamp) && event.timestamp > 0
                ? Math.max(0, now - event.timestamp)
                : 0;
            if (eventAge > RECENT_PUSH_REPLAY_MS) continue;
            const inboundId = `inbound:${event.id}`;
            if (state.ships.has(inboundId)) continue;
            const branch = eventBranch(event);
            const laneIndex = stableHash(`${event.project}:${branch}:${event.id}:inbound`) % SEA_LANES.length;
            const cargoCount = parseIncomingCommits(event);
            // Choose an outer-roadstead anchor for fetch (waits) or a berth for pull.
            const isFetch = event.type === 'fetch';
            const outerRoadsteads = HARBOR_SQUAD_ANCHORAGES.filter(a => a.zone === 'outer-roadstead');
            const roadstead = outerRoadsteads[stableHash(`${event.project}:${event.id}:roadstead`) % outerRoadsteads.length]
                || HARBOR_SQUAD_ANCHORAGES[0];
            const { berthIndex, quayIndex } = isFetch
                ? { berthIndex: -1, quayIndex: assignedQuayIndex(state, event.project) }
                : chooseBerthIndex(state, event.project, occupiedBerths);
            state.nextSequence++;
            const ship = {
                id: inboundId,
                project: event.project,
                branch,
                targetRef: event.targetRef || '',
                ...gitEventDebugMetadata(event, branch),
                repoName: displayName(event.project, branch),
                quayIndex,
                sha: '',
                label: inboundGitLabel(event, branch),
                status: 'arriving',
                arrivingKind: isFetch ? 'fetch' : 'pull',
                route: routeGraphMetadata(isFetch ? 'inbound.fetch-roadstead' : 'inbound.pull'),
                inboundCargoCount: cargoCount,
                inboundRoadsteadTile: isFetch ? { tileX: roadstead.tileX, tileY: roadstead.tileY } : null,
                berthIndex: berthIndex >= 0 ? berthIndex : (state.nextSequence % BERTHS.length),
                laneIndex,
                arrivingStartedAt: now,
                arrivingDuration: INBOUND_DURATION_MS,
                eventTime: event.timestamp || now,
                createdAt: now,
                eventIds: [event.id],
                isInbound: true,
                detachedHead: false,
                amendCount: 0,
            };
            state.ships.set(inboundId, ship);
            occupiedBerths.add(ship.berthIndex);
            indexCommitShip(commitIdentityIndex, ship);
            continue;
        }

        // W7.9 (SW-P9) — pull requests as the PR cutter class. A failed
        // command sails nothing; a PR older than the replay window appears
        // already moored (or already at the quay) instead of re-sailing.
        if (event.type === 'pr') {
            const prStatus = String(event.status || gitEventStatusLabel(event) || '').toLowerCase();
            if (prStatus === 'failed' || prStatus === 'rejected'
                || prStatus === 'cancelled' || prStatus === 'canceled') continue;
            const eventAge = Number.isFinite(event.timestamp) && event.timestamp > 0
                ? Math.max(0, now - event.timestamp)
                : 0;
            const sail = motionScale !== 0 && eventAge <= RECENT_PUSH_REPLAY_MS;
            if (event.action === 'create') {
                if (eventAge > PR_SHIP_MOOR_MS || state.ships.has(`pr:${event.id}`)) continue;
                const ship = pullRequestShip(state, event, now, displayName);
                Object.assign(ship, {
                    status: sail ? 'arriving' : 'anchored',
                    arrivingKind: 'pr',
                    route: routeGraphMetadata('inbound.fetch-roadstead'),
                    inboundRoadsteadTile: pullRequestRoadsteadTile(state),
                    arrivingStartedAt: sail ? now : now - INBOUND_DURATION_MS,
                    prMooredAt: sail ? 0 : (event.timestamp || now),
                });
                state.ships.set(ship.id, ship);
                continue;
            }
            if (event.action !== 'merge') continue;
            const moored = findMooredPullRequest(state, event);
            if (eventAge > PR_QUAY_HOLD_MS) {
                if (moored) retireHarborShip(state, moored.id, moored, now, { recordFloor: false });
                continue;
            }
            if (!moored && state.ships.has(`pr:${event.id}`)) continue;
            const ship = moored || pullRequestShip(state, event, now, displayName);
            if (moored) ship.eventIds.push(event.id);
            ship.prUrl = String(event.url || ship.prUrl || '');
            ship.branch = event.branch || ship.branch || '';
            ship.prTitle = String(event.title || ship.prTitle || '');
            ship.label = pullRequestShipLabel(ship);
            const { berthIndex, quayIndex } = chooseBerthIndex(state, event.project, occupiedBerths);
            Object.assign(ship, {
                status: sail ? 'arriving' : 'anchored',
                arrivingKind: 'pr-merge',
                route: routeGraphMetadata('inbound.pull'),
                prFromTile: moored ? ship.inboundRoadsteadTile : null,
                inboundRoadsteadTile: null,
                berthIndex,
                quayIndex,
                arrivingStartedAt: sail ? now : now - INBOUND_DURATION_MS,
                arrivingDuration: moored ? PR_MERGE_SAIL_MS : INBOUND_DURATION_MS,
                prMergedAt: event.timestamp || now,
                prQuayedAt: sail ? 0 : (event.timestamp || now),
                eventTime: event.timestamp || now,
            });
            state.ships.set(ship.id, ship);
            occupiedBerths.add(berthIndex);
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
            if (!previousPush && harborEventIsTombstoned(state, event)) continue;
            const incomingStatus = harborEventStatus(event);
            const previousStatus = previousPush?.status || null;
            const status = previousStatus && incomingStatus === 'unknown' ? previousStatus : incomingStatus;
            const existingBatch = state.batches.get(batchId);
            const statusChanged = previousStatus && previousStatus !== status;
            // S-H4 / P-D3 — a push whose lifecycle has played is settled: it
            // never re-fires on a later reduce unless its status changes.
            // #6 — a later report's reason reaches even a settled push.
            if (previousPush && event.reason) previousPush.reason = String(event.reason);
            if (previousPush?.settledAt && !statusChanged) continue;
            const branch = eventBranch(event);
            const target = pushTarget(event);
            if (target.landed.length) state.containmentRepos.add(event.project);
            if (status === 'success' && target.cargo) {
                // A floor per pushed lane only: a push with no known branch
                // writes none (S-H2).
                for (const pushedBranch of target.branches) recordCommitReplayFloor(state, event.project, pushedBranch, pushTime, now);
                clearHarborDockOverflowForPush(state, event, pushTime, target);
                const landedAt = pushTime || now;
                if (landedAt > (state.lastLandedPushAt.get(event.project) || 0)) {
                    state.lastLandedPushAt.delete(event.project);
                    state.lastLandedPushAt.set(event.project, landedAt);
                }
            }
            const pushMetadata = gitEventDebugMetadata(event, branch);
            // 3.1 — capture force flag (true / 'lease' / 'includes')
            const forceFlag = event.force === true || event.force === 'lease' || event.force === 'includes'
                ? event.force
                : null;
            const pushRecord = (overrides) => ({
                id: event.id,
                project: event.project,
                checkout: event.checkout || event.project,
                branch,
                status,
                ...pushMetadata,
                force: forceFlag,
                deleted: event.deleted === true,
                tagsOnly: event.tagsOnly === true,
                tag: event.tag ? String(event.tag) : '',
                reason: event.reason ? String(event.reason) : '',
                landedCount: target.landed.length,
                eventTime: event.timestamp || now,
                batchId: null,
                seenAt: previousPush?.seenAt || now,
                settledAt: null,
                ...overrides,
            });

            let selectedShips = [];
            const existingShipIds = new Set(existingBatch?.shipIds || []);
            const selectedIds = new Set();
            const addShip = (ship) => {
                if (!ship || selectedIds.has(ship.id)) return;
                selectedIds.add(ship.id);
                selectedShips.push(ship);
            };
            if (existingBatch?.shipIds?.length) {
                existingBatch.shipIds
                    .map(id => state.ships.get(id))
                    .filter(Boolean)
                    .forEach(addShip);
            }
            for (const ship of state.ships.values()) {
                if (!shipEligibleForPush(ship, event, previousPush, now, target, status)) continue;
                addShip(ship);
            }
            selectedShips.sort(compareDepartingShips);

            if (status !== 'success' && status !== 'failed' && status !== 'rejected' && status !== 'cancelled') {
                if (existingBatch?.status === 'unknown') state.batches.delete(batchId);
                state.pushEvents.set(event.id, pushRecord());
                continue;
            }

            if (!existingBatch && selectedShips.length === 0) {
                // A non-success push with nothing to sail settles at once.
                state.pushEvents.set(event.id, pushRecord({ settledAt: status === 'success' ? null : now }));
                continue;
            }

            const newShipCount = selectedShips.filter(ship => !existingShipIds.has(ship.id)).length;
            if (previousPush && !statusChanged && existingBatch && newShipCount === 0) continue;

            const dockLayout = buildDockLayoutFresh(state);
            const shipIds = selectedShips.map(ship => ship.id);
            const startedAt = existingBatch?.startedAt
                || (skipOldReplay
                    ? now - SCREEN_SUMMARY_MS - FINALE_EFFECT_MS - 1
                    : (statusChanged ? now : previousPush?.seenAt || now));
            const convoy = status === 'success'
                ? (existingBatch?.convoy || releaseConvoyMetadata(event, branch, selectedShips, status, forceFlag, displayName))
                : null;
            const batch = {
                ...(existingBatch || {}),
                id: batchId,
                project: event.project,
                branch,
                quayIndex: assignedQuayIndex(state, event.project),
                repoName: displayName(event.project, branch),
                label: event.label || existingBatch?.label || '',
                targetRef: event.targetRef || existingBatch?.targetRef || '',
                status,
                ...pushMetadata,
                // 3.1 — keep force flag on the batch so renderers can branch on it
                force: forceFlag,
                convoy,
                shipIds,
                shipCount: shipIds.length,
                sequence: existingBatch?.sequence || ++state.nextBatchSequence,
                eventTime: event.timestamp || existingBatch?.eventTime || now,
                startedAt,
                statusUpdatedAt: statusChanged ? now : existingBatch?.statusUpdatedAt || now,
            };
            state.batches.set(batchId, batch);
            state.pushEvents.set(event.id, pushRecord({ batchId }));

            const departSquadCount = Math.max(1, selectedShips.length);
            // Titan packs sail as one hull: members of a docked pack that leave
            // together stay hidden behind the first selected member of that pack.
            const departPacks = new Map();
            for (const ship of selectedShips) {
                const key = dockLayout.byShipId.get(ship.id)?.visualLeadId || ship.id;
                const pack = departPacks.get(key) || { leadId: ship.id, size: 0, visibleIndex: departPacks.size };
                pack.size += 1;
                departPacks.set(key, pack);
            }
            const departing = [];
            selectedShips.forEach((ship, departSquadIndex) => {
                // A ship a later publication already sent to sea never turns
                // back for this failed push (#3).
                if (status !== 'success' && ship.status === 'departing' && ship.pushEventId && ship.pushEventId !== event.id) return;
                const turning = status === 'success' && (ship.status === 'rejecting' || ship.status === 'cancelling');
                if (turning) {
                    ship.turnedFromReturn = true;
                    ship.boomerangStartedAt = null;
                    ship.cancelReturnStartedAt = null;
                }
                const dockMeta = dockLayout.byShipId.get(ship.id);
                const departPack = departPacks.get(dockMeta?.visualLeadId || ship.id) || { leadId: ship.id, size: 1, visibleIndex: departSquadIndex };
                // P-D3 — only a docked ship takes a new start tile and route;
                // one already under way keeps the course it is sailing.
                const placeFromDock = ship.status === 'docked' || !ship.departFromTile;
                if (placeFromDock) {
                    ship.visualPackLeadId = departPack.leadId;
                    ship.visualPackSize = departPack.leadId === ship.id ? departPack.size : 1;
                }
                const berth = BERTHS[ship.berthIndex % BERTHS.length] || BERTHS[0];
                const departWaterZone = dockMeta?.waitingZone || ship.waitingZone || 'harbor';
                const routeBands = isCommitLagoonZone(departWaterZone)
                    ? COMMIT_LAGOON_ROUTE_BANDS
                    : LOCAL_WATER_ROUTE_BANDS;
                const routeIndex = stableHash(`${event.project}:${branch}:${event.id}:${departWaterZone}:water-route`) % routeBands.length;
                const routeBand = routeBands[routeIndex] || routeBands[0];
                const route = placeFromDock ? waterRouteMetadataForBand(routeBand, { ...ship, departWaterZone }) : ship.route;
                if (convoy && !convoy.routeId && route?.id) convoy.routeId = route.id;
                if (!batch.route && route) batch.route = route;
                ship.pushStatus = status;
                ship.pushSource = pushMetadata.source || '';
                ship.pushConfidence = pushMetadata.confidence;
                ship.pushInferred = pushMetadata.inferred === true;
                ship.pushObserved = pushMetadata.observed === true;
                ship.pushRemote = pushMetadata.remote || '';
                ship.pushRef = pushMetadata.ref || '';
                ship.batchId = batchId;
                ship.pushEventId = event.id;
                ship.pushSeenAt = now;
                if (placeFromDock) {
                    ship.waitingZone = departWaterZone;
                    ship.departWaterZone = departWaterZone;
                    ship.departSquadIndex = departSquadIndex;
                    ship.departSquadCount = departSquadCount;
                    ship.departRouteIndex = routeIndex;
                    ship.route = route;
                    ship.departRouteOffset = departSquadIndex - (departSquadCount - 1) / 2;
                    ship.departStaggerMs = DEPARTURE_STAGGER_MS;
                    ship.departFromTile = dockMeta
                        ? { tileX: dockMeta.tileX, tileY: dockMeta.tileY }
                        : { tileX: berth.tileX, tileY: berth.tileY };
                }
                if (dockMeta && placeFromDock) {
                    ship.repoDockIndex = dockMeta.repoDockIndex;
                    ship.repoDockCount = dockMeta.repoDockCount;
                    ship.repoTotalDockCount = dockMeta.repoTotalDockCount;
                    ship.repoDockVisibleCount = dockMeta.repoDockVisibleCount;
                    ship.repoSegmentIndex = dockMeta.repoSegmentIndex;
                    ship.repoSegmentCount = dockMeta.repoSegmentCount;
                    ship.squadIndex = dockMeta.squadIndex;
                    ship.squadCount = dockMeta.squadCount;
                    ship.squadShipIndex = dockMeta.squadShipIndex;
                    ship.squadShipCount = dockMeta.squadShipCount;
                    ship.squadDensity = dockMeta.squadDensity;
                    ship.compactCommitLabel = dockMeta.compactCommitLabel;
                    ship.showCommitLabel = dockMeta.showCommitLabel;
                    ship.formationColumn = dockMeta.column;
                    ship.formationRow = dockMeta.row;
                    ship.waitingZone = dockMeta.waitingZone;
                    ship.departWaterZone = dockMeta.waitingZone;
                    ship.anchorageName = dockMeta.anchorageName;
                    ship.anchorageIndex = dockMeta.anchorageIndex;
                }
                // 3.1 — propagate force flag to each ship so draw/lifecycle helpers can react.
                ship.pushForce = forceFlag;
                ship.convoy = convoy ? {
                    ...convoy,
                    routeId: convoy.routeId || route?.id || '',
                    index: departSquadIndex,
                    leaderShipId: convoy.leaderShipId || selectedShips[0]?.id || ship.id,
                } : null;
                if (status === 'failed') {
                    ship.status = 'docked';
                    ship.failedAt = skipOldReplay ? null : now;
                    ship.departEventId = null;
                    ship.departStartedAt = null;
                    ship.departEventTime = null;
                    return;
                }
                // Rejected push boomerangs: out then back, redocks with caution flag.
                if (status === 'rejected') {
                    if (statusChanged || !ship.boomerangStartedAt) {
                        ship.boomerangStartedAt = skipDepartureAnimation
                            ? now - BOOMERANG_OUT_MS - BOOMERANG_IN_MS - 1
                            : now + departPack.visibleIndex * DEPARTURE_STAGGER_MS;
                    }
                    ship.status = skipDepartureAnimation ? 'docked' : 'rejecting';
                    ship.departEventId = event.id;
                    ship.departEventTime = event.timestamp || now;
                    return;
                }
                // 5.11 — cancelled push: half-speed return to berth, no collision flare.
                if (status === 'cancelled') {
                    if (statusChanged || !ship.cancelReturnStartedAt) {
                        ship.cancelReturnStartedAt = skipDepartureAnimation
                            ? now - CANCEL_RETURN_MS - 1
                            : now + departPack.visibleIndex * DEPARTURE_STAGGER_MS;
                    }
                    ship.status = skipDepartureAnimation ? 'docked' : 'cancelling';
                    ship.departEventId = event.id;
                    ship.departEventTime = event.timestamp || now;
                    return;
                }
                ship.status = 'departing';
                ship.departEventId = event.id;
                if (status === 'success' && previousStatus !== 'success') {
                    ship.departStartedAt = null;
                }
                ship.departEventTime = event.timestamp || now;
                departing.push({ ship, departPack });
            });
            // P-D6/P-D7 — the convoy sails at its slowest hull's cruise speed,
            // each departure lasting its own route's length, and casts off in
            // line astern: the hull nearest open water first, then each next
            // one about 1.5 hull lengths of sailing later, so no ship sails
            // through a mooring still occupied (a force-push keeps its short
            // fixed run). Pack members share their lead's plan so a titan
            // retires together.
            const packPlans = new Map();
            for (const { ship, departPack } of departing) {
                if (packPlans.has(departPack)) continue;
                const lead = state.ships.get(departPack.leadId) || ship;
                const sailing = { ...lead, visualPackSize: departPack.size };
                const startTile = lead.departFromTile || BERTHS[lead.berthIndex % BERTHS.length] || BERTHS[0];
                packPlans.set(departPack, {
                    length: routeLengthTiles(composeWaterRouteTiles(startTile, lead, null)),
                    speed: harborCruiseSpeed(sailing),
                    hull: harborHullLengthTiles(sailing),
                });
            }
            const plans = [...packPlans.values()];
            const convoySpeed = Math.min(1, ...plans.map(plan => plan.speed));
            const spacingMs = forceFlag ? DEPARTURE_STAGGER_MS : (1.5 * Math.max(0, ...plans.map(plan => plan.hull)) / convoySpeed) * 1000;
            plans
                .sort((a, b) => a.length - b.length)
                .forEach((plan, rank) => {
                    plan.durationMs = dynamicDepartureMs({}, forceFlag, plan.length, convoySpeed);
                    plan.offset = rank * spacingMs;
                });
            for (const { ship, departPack } of departing) {
                const plan = packPlans.get(departPack);
                ship.departMsOverride = plan.durationMs;
                ship.departStartedAt = skipDepartureAnimation
                    ? now - ship.departMsOverride - FADE_DELAY_MS - EXIT_FADE_MS - EXIT_HOLD_MS - 1
                    : ship.departStartedAt || Math.round(startedAt + plan.offset);
                // Cast-off phase: hold at berth briefly before the proper departure.
                if (!skipDepartureAnimation && (statusChanged || !ship.castOffStartedAt)) {
                    ship.castOffStartedAt = ship.departStartedAt;
                }
            }
        }
    }

    if (liveEventIds) {
        for (const ship of state.ships.values()) {
            if (ship.vanished || ship.status !== 'docked' || ship.isInbound || reportedLive(ship)) continue;
            scuttle(ship);
            ship.vanished = true;
        }
    }

    for (const [id, ship] of state.ships) {
        // Boomerang lifecycle: out then back, then redock with caution flag.
        if (ship.status === 'rejecting') {
            const startedAt = ship.boomerangStartedAt || now;
            const totalMs = BOOMERANG_OUT_MS + BOOMERANG_IN_MS;
            if (motionScale === 0 || now - startedAt >= totalMs) {
                ship.status = 'docked';
                ship.pushStatus = 'rejected';
                ship.rejectedAt = now;
                ship.boomerangStartedAt = null;
                ship.departStartedAt = null;
                ship.visualPackLeadId = null;
                ship.visualPackSize = null;
                ship.departEventId = null;
            }
            continue;
        }
        // 5.11 — cancelled lifecycle: half-speed return then redock, no caution flag.
        if (ship.status === 'cancelling') {
            const startedAt = ship.cancelReturnStartedAt || now;
            if (motionScale === 0 || now - startedAt >= CANCEL_RETURN_MS) {
                ship.status = 'docked';
                ship.pushStatus = 'cancelled';
                ship.cancelledAt = now;
                ship.cancelReturnStartedAt = null;
                ship.departStartedAt = null;
                ship.visualPackLeadId = null;
                ship.visualPackSize = null;
                ship.departEventId = null;
            }
            continue;
        }
        // 3.2 — inbound lifecycle: arrive then dock (pull) or anchor (fetch,
        // a moored PR, a merged PR at its quay berth).
        if (ship.status === 'arriving') {
            const startedAt = ship.arrivingStartedAt || now;
            const duration = Math.max(1, Number(ship.arrivingDuration) || INBOUND_DURATION_MS);
            if (motionScale === 0 || now - startedAt >= duration) {
                if (ship.arrivingKind === 'fetch' || ship.arrivingKind === 'pr') {
                    ship.status = 'anchored';
                    if (ship.arrivingKind === 'pr') ship.prMooredAt = ship.prMooredAt || now;
                } else if (ship.arrivingKind === 'pr-merge') {
                    ship.status = 'anchored';
                    ship.prQuayedAt = ship.prQuayedAt || now;
                } else {
                    ship.status = 'docked';
                    ship.eventTime = ship.eventTime || now;
                }
            }
            continue;
        }
        // 3.2 — anchored fetch ships expire after a while; W7.9 moored and
        // quayed PR cutters on their own holds.
        if (ship.status === 'anchored') {
            const startedAt = ship.arrivingStartedAt || now;
            const expired = ship.arrivingKind === 'pr'
                ? now - (ship.prMooredAt || startedAt) > PR_SHIP_MOOR_MS
                : ship.arrivingKind === 'pr-merge'
                    ? now - (ship.prQuayedAt || startedAt) > PR_QUAY_HOLD_MS
                    : now - startedAt > INBOUND_DURATION_MS * 2;
            if (expired) retireHarborShip(state, id, ship, now, { recordFloor: false });
            continue;
        }
        // 2.9 — a rewritten commit fades where it lay, then retires without
        // a floor (its replacement may still be docking).
        if (ship.status === 'scuttling') {
            if (motionScale === 0 || now - (ship.scuttleStartedAt || now) >= SCUTTLE_MS) {
                if (ship.vanished) forgetHarborShip(state, id, ship);
                else retireHarborShip(state, id, ship, now, { recordFloor: false });
            }
            continue;
        }
        if (ship.status !== 'departing') continue;
        const departMs = Math.max(1, Number(ship.departMsOverride) || DEPARTURE_MS);
        const startedAt = ship.departStartedAt || now;
        const progress = motionScale === 0 ? 1 : Math.max(0, Math.min(1, (now - startedAt) / departMs));
        if (progress >= 1 && now - startedAt > departMs + FADE_DELAY_MS + EXIT_FADE_MS + EXIT_HOLD_MS) {
            const batch = ship.batchId ? state.batches.get(ship.batchId) : null;
            if (batch) {
                const startTile = Number.isFinite(Number(ship?.departFromTile?.tileX))
                    && Number.isFinite(Number(ship?.departFromTile?.tileY))
                    ? { tileX: Number(ship.departFromTile.tileX), tileY: Number(ship.departFromTile.tileY) }
                    : (() => {
                        const berth = BERTHS[ship.berthIndex % BERTHS.length] || BERTHS[0];
                        return { tileX: berth.tileX, tileY: berth.tileY };
                    })();
                const route = composeWaterRouteTiles(startTile, ship, null);
                const endpointTile = (batch.status || 'unknown') === 'failed'
                    ? startTile
                    : routeSeaTile(route) || startTile;
                if (endpointTile) {
                    const world = toWorld(endpointTile.tileX, endpointTile.tileY);
                    if (!batch.sealedOriginPoints) batch.sealedOriginPoints = [];
                    batch.sealedOriginPoints.push({ x: world.x, y: world.y });
                }
            }
            retireHarborShip(state, id, ship, now);
        }
    }

    for (const [id, batch] of state.batches) {
        const age = now - (batch.startedAt || now);
        if (age > SCREEN_SUMMARY_MS + FINALE_EFFECT_MS + DEPARTURE_MS) {
            state.batches.delete(id);
            const push = state.pushEvents.get(String(id).replace(/^push-batch:/, ''));
            if (push && push.status !== 'success') push.settledAt = now;
        }
    }

    pruneHarborShips(state, now);
    pruneHarborBatches(state);
    pruneHarborRepoQuays(state);
    syncRepoAnchorages(state, activeProjects);
    pruneHarborReplayState(state, now);
    state.packThresholds = planPackThresholds(state, state.packThresholds);

    return state;
}

export function harborStateHasTimedLifecycle(state) {
    if (state?.batches?.size) return true;
    for (const ship of state?.ships?.values?.() || []) {
        if (ship.status === 'docked') continue;
        // Moored and quayed PR cutters only expire, on the maintenance tick.
        if (ship.status === 'anchored' && ship.prShip) continue;
        return true;
    }
    return false;
}

export function cleanCommitLabelCacheSize() {
    return _cleanCommitLabelCache.size;
}
