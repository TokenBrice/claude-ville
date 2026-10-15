// U-P4 — one ledger grammar for every surface that lists pending harbor
// cargo: the Sidebar HARBOR ledger, the Harbor building plaque, the Harbor
// building panel and the anchorage buoy labels. They all read the
// `harbor:updated` lane rows (HarborTraffic.getPendingRepoSummaries) through
// this module, so they share:
//   - raw names (the repo's display name, never title-cased), the branch as
//     its own token, both truncated from the middle (`claude/feat…1234`);
//   - a count that is always visible (names shrink, numbers never do);
//   - one order: lanes with a standing push failure first (newest failure
//     first), then the oldest pending commit first, then the largest count;
//   - branches grouped under their repo;
//   - an explicit `+N more` wherever a surface cuts the list.
// Pure: no DOM, no canvas.

import { normalizeRepoBranch } from './GitEventIdentity.js';
import { branchPennonKind, repoDisplayName, repoProfile } from './RepoColor.js';

export const LEDGER_ELLIPSIS = '…';

// Middle truncation: keep the head and the tail, which carry a name's
// identity (`claude/feature-very-long-name-1234` → `claude/feat…1234`).
export function middleTruncate(value, maxChars = 24, ellipsis = LEDGER_ELLIPSIS) {
    const text = String(value ?? '').replace(/\s+/g, ' ').trim();
    const max = Math.max(1, Math.floor(Number(maxChars) || 0));
    if (text.length <= max) return text;
    if (max <= ellipsis.length + 1) return text.slice(0, max);
    const keep = max - ellipsis.length;
    const head = Math.ceil(keep / 2);
    const tail = keep - head;
    return `${text.slice(0, head)}${ellipsis}${tail ? text.slice(text.length - tail) : ''}`;
}

// A short age without "ago": `now`, `45s`, `12m`, `3h`, `2d`, `5w`.
export function ledgerAge(ts, now = Date.now()) {
    const time = Number(ts);
    if (!Number.isFinite(time) || time <= 0) return '';
    const seconds = Math.max(0, Math.floor((now - time) / 1000));
    if (seconds < 10) return 'now';
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h`;
    const days = Math.floor(hours / 24);
    if (days < 14) return `${days}d`;
    return `${Math.floor(days / 7)}w`;
}

const FAILURE_WORD = Object.freeze({ failed: 'push failed', rejected: 'push rejected' });

// `push failed 2m · fatal: unable to access remote` (reason optional).
export function ledgerFailureText(failure, now = Date.now(), { reasonChars = 48 } = {}) {
    if (!failure) return '';
    const word = FAILURE_WORD[failure.status] || FAILURE_WORD.failed;
    const age = ledgerAge(failure.at, now);
    const reason = failure.reason ? middleTruncate(failure.reason, reasonChars) : '';
    return [age ? `${word} ${age}` : word, reason].filter(Boolean).join(' · ');
}

function count(row) {
    return Math.max(0, Number(row?.pendingCommits ?? row?.count) || 0);
}

function failureOf(row) {
    const failedPushes = Math.max(0, Number(row?.failedPushes) || 0);
    if (failedPushes <= 0) return null;
    return {
        status: row.failureStatus === 'rejected' ? 'rejected' : 'failed',
        at: Number(row.latestFailureAt) || Number(row.latestEventTime) || 0,
        reason: row.failureReason ? String(row.failureReason) : '',
        agentId: row.agentId || null,
        count: failedPushes,
    };
}

function oldest(a, b) {
    if (a > 0 && b > 0) return Math.min(a, b);
    return a > 0 ? a : b;
}

// Failed first (newest failure first), then oldest pending first (an unknown
// age last), then the bigger count, then the name.
function compareEntries(a, b) {
    if (Boolean(a.failure) !== Boolean(b.failure)) return a.failure ? -1 : 1;
    if (a.failure && b.failure && a.failure.at !== b.failure.at) return b.failure.at - a.failure.at;
    const ao = a.oldestCommitTime || 0;
    const bo = b.oldestCommitTime || 0;
    if ((ao > 0) !== (bo > 0)) return ao > 0 ? -1 : 1;
    if (ao !== bo) return ao - bo;
    return (b.count - a.count) || String(a.sortName).localeCompare(String(b.sortName));
}

/**
 * Groups lane rows by repo. `repos` are `harbor:updated` rows
 * (`{ project, branch, pendingCommits, failedPushes, latestFailureAt,
 * failureReason, failureStatus, oldestCommitTime, worktree, agentId }`).
 * Returns `{ groups, total, hiddenGroups, hiddenCommits }`; each group is
 * `{ key, project, name, profile, count, failure, oldestCommitTime, lanes,
 * hiddenLanes }` and each lane `{ project, branch, kind, worktreeName,
 * count, failure, oldestCommitTime, ageLabel, agentId }`. A lane with no
 * pending commit is kept only while it carries a failure.
 */
export function harborLedger(repos = [], {
    now = Date.now(),
    maxGroups = Infinity,
    maxLanes = Infinity,
    nameFor = repoDisplayName,
    profileFor = repoProfile,
} = {}) {
    const byRepo = new Map();
    for (const row of Array.isArray(repos) ? repos : []) {
        if (!row) continue;
        const pending = count(row);
        const failure = failureOf(row);
        if (pending <= 0 && !failure) continue;
        const project = String(row.project || 'unknown');
        const profile = profileFor(project);
        const key = profile?.key || project;
        let group = byRepo.get(key);
        if (!group) {
            const name = nameFor(project) || 'unknown';
            group = {
                key,
                project,
                name,
                sortName: name,
                profile,
                count: 0,
                failure: null,
                oldestCommitTime: 0,
                lanes: [],
                hiddenLanes: 0,
            };
            byRepo.set(key, group);
        }
        const branch = normalizeRepoBranch(row.branch);
        const worktree = row.worktree && typeof row.worktree === 'object' ? row.worktree : null;
        const oldestCommitTime = Number(row.oldestCommitTime) || 0;
        const lane = {
            project,
            branch,
            kind: branchPennonKind(branch, worktree),
            worktreeName: worktree && worktree.isMain === false ? String(worktree.name || '') : '',
            count: pending,
            failure,
            oldestCommitTime,
            ageLabel: ledgerAge(oldestCommitTime, now),
            agentId: row.agentId || null,
            sortName: branch,
        };
        // One lane per branch: rows of one branch (harbor + lagoon) fold.
        const twin = group.lanes.find(other => other.branch === lane.branch);
        if (twin) {
            twin.count += lane.count;
            twin.oldestCommitTime = oldest(twin.oldestCommitTime, lane.oldestCommitTime);
            twin.ageLabel = ledgerAge(twin.oldestCommitTime, now);
            if (lane.failure && (!twin.failure || lane.failure.at > twin.failure.at)) twin.failure = lane.failure;
            twin.worktreeName ||= lane.worktreeName;
            if (lane.kind === 'worktree') twin.kind = 'worktree';
        } else {
            group.lanes.push(lane);
        }
        group.count += pending;
        group.oldestCommitTime = oldest(group.oldestCommitTime, oldestCommitTime);
        if (failure && (!group.failure || failure.at > group.failure.at)) group.failure = failure;
    }
    const all = [...byRepo.values()];
    for (const group of all) {
        group.lanes.sort(compareEntries);
        if (group.lanes.length > maxLanes) {
            group.hiddenLanes = group.lanes.length - maxLanes;
            group.lanes = group.lanes.slice(0, maxLanes);
        }
    }
    all.sort(compareEntries);
    const total = all.reduce((sum, group) => sum + group.count, 0);
    const groups = all.slice(0, Math.max(0, maxGroups));
    const hidden = all.slice(groups.length);
    return {
        groups,
        total,
        hiddenGroups: hidden.length,
        hiddenCommits: hidden.reduce((sum, group) => sum + group.count, 0),
    };
}

// `+3 more` / `+3 more · 41 commits`.
export function ledgerMoreText(hidden, hiddenCommits = 0) {
    if (!(hidden > 0)) return '';
    return hiddenCommits > 0 ? `+${hidden} more · ${hiddenCommits}` : `+${hidden} more`;
}

/**
 * The plaque's rows: one per repo (`repo · branch` when the repo has one
 * lane, `repo · N branches` otherwise), count right after the name, failed
 * repos marked, then `+N more`. `maxRows` includes the `+N more` row.
 */
export function ledgerPlaqueRows(repos = [], { now = Date.now(), maxRows = 3, nameChars = 14, branchChars = 14, ...options } = {}) {
    const ledger = harborLedger(repos, { now, ...options });
    const room = ledger.groups.length > maxRows ? Math.max(1, maxRows - 1) : maxRows;
    const rows = ledger.groups.slice(0, room).map((group) => {
        const name = middleTruncate(group.name, nameChars);
        const lane = group.lanes.length === 1 && group.hiddenLanes === 0 ? group.lanes[0] : null;
        const detail = lane
            ? (lane.branch ? middleTruncate(lane.branch, branchChars) : 'detached')
            : `${group.lanes.length + group.hiddenLanes} branches`;
        return {
            key: group.key,
            project: group.project,
            name,
            detail,
            count: group.count,
            failed: Boolean(group.failure),
            kind: lane?.kind || 'default',
            profile: group.profile,
            label: `${name} · ${detail} ${group.count}`,
        };
    });
    const hidden = ledger.groups.length - rows.length + ledger.hiddenGroups;
    if (hidden > 0) {
        const hiddenCommits = ledger.groups.slice(rows.length).reduce((sum, group) => sum + group.count, 0) + ledger.hiddenCommits;
        rows.push({ more: true, label: ledgerMoreText(hidden, hiddenCommits) });
    }
    return rows;
}

// The buoy label: `name · 12`; the name shrinks from the middle, the count
// never does.
export function ledgerBuoyLabel(name, pending = 0, { nameChars = 18 } = {}) {
    const shown = middleTruncate(name || 'repo', nameChars);
    return pending > 0 ? `${shown} · ${pending}` : shown;
}

// One lane's subject line: `main`, `feat/x1 · wt agent-a1b2c3`, `detached`.
export function ledgerLaneLabel(lane, { branchChars = 22, worktreeChars = 14 } = {}) {
    if (!lane) return '';
    const branch = lane.branch ? middleTruncate(lane.branch, branchChars) : 'detached';
    return lane.worktreeName ? `${branch} · wt ${middleTruncate(lane.worktreeName, worktreeChars)}` : branch;
}

// Sidebar ledger rows and the building panel ask the World to focus a fleet
// and open its card: `{ project, branch }` (`branch: null` = the whole repo).
export const HARBOR_FOCUS_FLEET_EVENT = 'harbor:focus-fleet';

// U-P6 — a repo's shield monogram: the initials of its name's words
// (`claude-ville` → `CV`), or its first two letters when it is one word
// (`alpha` → `AL`). Letters and digits only, upper-cased, at most 3.
export function repoMonogram(name) {
    const words = String(name || '').split(/[^A-Za-z0-9]+/).filter(Boolean);
    if (!words.length) return '?';
    const letters = words.length === 1 ? words[0].slice(0, 2) : words.map(word => word[0]).join('').slice(0, 3);
    return letters.toUpperCase();
}

// Monograms for the repos on screen, collision-checked: the first repo (in
// key order, so the assignment is stable) keeps `CV`, the next `CV2`, `CV3`.
// `repos` is `[{ key, name }]`; returns Map(key → monogram).
export function assignMonograms(repos = []) {
    const out = new Map();
    const used = new Map();
    const sorted = [...repos].filter(repo => repo?.key).sort((a, b) => String(a.key).localeCompare(String(b.key)));
    for (const repo of sorted) {
        if (out.has(repo.key)) continue;
        const base = repoMonogram(repo.name);
        const seen = used.get(base) || 0;
        used.set(base, seen + 1);
        out.set(repo.key, seen === 0 ? base : `${base.slice(0, 2)}${seen + 1}`);
    }
    return out;
}
